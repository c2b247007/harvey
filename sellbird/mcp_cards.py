"""Sellbird inside the agent app: the dashboard in its browser pane, and
cards in the chat.

``dashboard_open`` gives the agent a link that opens the full dashboard in
the app's built-in browser pane, already signed in. The link carries a
one-use sign-in code (sellbird.dashboard_auth.PaneSessions), never the
dashboard token, and works once, for two minutes.

The card tools (``show_today``, ``show_needs_you``, ``show_campaign_report``)
answer with plain text, which every host shows, and with the same facts as
structured data for a card. A host that supports MCP Apps (the
``io.modelcontextprotocol/ui`` extension) renders the card from the
``ui://sellbird/...`` resource named in the tool's ``_meta.ui.resourceUri``.
A card shows and links. It never approves, sends, buys or resumes: its
buttons open the item in the dashboard, where the person decides.
"""

from __future__ import annotations

import base64
import re
from pathlib import Path
from urllib.parse import quote

from mcp.types import CallToolResult, TextContent

APP_MIME = "text/html;profile=mcp-app"
CARD_URIS = {
    "today": "ui://sellbird/today",
    "needs_you": "ui://sellbird/needs-you",
    "campaign": "ui://sellbird/campaign-report",
}
WEB = Path(__file__).resolve().parent / "web"

# The names a person or agent may use for a page, and the screen each opens.
PAGES = {
    "": "today", "today": "today",
    "outbound": "outbox", "approvals": "outbox", "outbound/approvals": "outbox", "outbox": "outbox",
    "waiting": "outbox", "replies": "conversations", "conversations": "conversations",
    "campaigns": "campaigns", "find": "discover", "discover": "discover", "signals": "signals",
    "social": "social", "inbound": "leads", "leads": "leads", "texts": "texts", "mentions": "mentions",
    "people": "prospects", "prospects": "prospects", "companies": "companies", "calendar": "calendar",
    "numbers": "numbers", "setup": "setup", "set up": "setup", "suite": "suite", "settings": "settings",
    "inboxes": "inboxes", "agent": "agent", "limits": "limits",
}
_PERSON = re.compile(r"^person/([A-Za-z0-9_-]{1,64})$")

OPEN_ADVICE = ("Open this in your built-in browser or side panel, not just in the chat: it opens the "
               "Sellbird dashboard there, already signed in. It works once, within two minutes. Never paste "
               "it anywhere else. Approving, sending and resuming stay the user's clicks in that dashboard.")


def page_for(name: str) -> str | None:
    """The screen a page name opens, or None when it isn't one."""
    key = str(name or "").strip().lower().strip("/")
    if key in PAGES:
        return PAGES[key]
    match = _PERSON.match(str(name or "").strip())
    return f"person/{match.group(1)}" if match else None


def sign_in_link(base: str, code: str, page: str) -> str:
    """http://127.0.0.1:<port>/#code=<code>&page=<page>. Both ride in the
    fragment, which a browser never sends to a server or puts in a log."""
    link = base.rstrip("/") + "/#code=" + quote(code, safe="")
    return link + ("&page=" + quote(page, safe="/") if page and page != "today" else "")


def card_html() -> str:
    """The card page, with the Geist font inlined so it needs no network."""
    html = (WEB / "card.html").read_text(encoding="utf-8")
    try:
        font = base64.b64encode((WEB / "fonts" / "geist.woff2").read_bytes()).decode("ascii")
        face = ("@font-face { font-family: 'Geist'; font-style: normal; font-weight: 400 700; "
                f"src: url(data:font/woff2;base64,{font}) format('woff2'); }}")
    except OSError:
        face = ""
    return html.replace("/*FONT*/", face, 1)


def _result(text: str, data: dict) -> CallToolResult:
    return CallToolResult(content=[TextContent(type="text", text=text)], structured_content=data)


def _n(value) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _short(text, limit: int = 140) -> str:
    """At most ``limit`` characters, cut at a word, with "..." when cut."""
    text = " ".join(str(text or "").split())
    if len(text) <= limit:
        return text
    return text[:limit].rsplit(" ", 1)[0].rstrip(",.;:") + "..."


# Why Sellbird handed a conversation over, in words (the handler's intent codes).
HANDED_WHY = {
    "escalate": "it needs a person to answer", "question": "they asked something it shouldn't answer alone",
    "objection": "they pushed back", "interested": "they are interested", "accepted_offer": "they said yes to your offer",
    "not_interested": "they aren't interested", "wrong_person": "they say they aren't the right person",
    "ooo": "they are away", "unsubscribe": "they asked not to be emailed", "new_lead": "a new lead wrote in",
}


def _lead_name(lead: dict) -> str:
    """Who a lead is: their name, address or number, else where it came from."""
    who = lead.get("name") or " ".join(x for x in (lead.get("first_name"), lead.get("last_name")) if x)
    who = who or lead.get("email") or lead.get("phone")
    if who:
        return "New lead: " + who
    return "New lead from " + (lead.get("form_name") or "your site form")


def _who(item: dict) -> str:
    ctx = item.get("context") or {}
    return ctx.get("contact") or item.get("to_email") or "Someone"


# ── Shaping what the dashboard says into a card ──
# Each card keeps ``stats`` (value, label) for plain text, and adds ``tiles``
# for the card: a label, a number, a daily series for the sparkline when
# there is one, and the same figure for the period before.

def _series(numbers: dict | None, key: str) -> dict:
    """{"series", "value", "before", "days"} from /api/numbers, or {}."""
    s = ((numbers or {}).get("series") or {}).get(key) if isinstance(numbers, dict) else None
    if not isinstance(s, dict) or not isinstance(s.get("values"), list):
        return {}
    return {"series": [_n(v) for v in s["values"]], "value": _n(s.get("total")),
            "before": s.get("previous") if (numbers or {}).get("has_previous") else None,
            "days": _n((numbers or {}).get("range"))}


def _tile(label: str, number, extra: dict | None = None, **more) -> dict:
    """A tile. ``extra`` (a series from _series) may carry its own value;
    ``value=`` in ``more`` wins over both."""
    tile = {"label": label, "value": _n(number)}
    tile.update({k: v for k, v in {**(extra or {}), **more}.items() if v not in (None, "")})
    tile["value"] = _n(tile["value"])
    return tile


def _plural(n: int, one: str, many: str) -> str:
    return f"{n} {one if n == 1 else many}"


def _today_answer(report: dict | None, waiting: int, needs: int) -> tuple[str, str]:
    """The sentence the app's Today opens with, and the agent's name."""
    name = (report or {}).get("name") or "" if isinstance(report, dict) else ""
    day = (report or {}).get("day") or {} if isinstance(report, dict) else {}
    did = []
    if _n(day.get("found")):
        did.append("found " + _plural(_n(day["found"]), "person", "people"))
    if _n(day.get("written")):
        did.append("wrote " + _plural(_n(day["written"]), "email", "emails"))
    if _n(day.get("sent")):
        did.append("sent " + _plural(_n(day["sent"]), "email", "emails") + " you approved")
    who = name or "Your agent"
    if did:
        first = who + " " + (", ".join(did[:-1]) + " and " + did[-1] if len(did) > 1 else did[0]) + " in the last day."
    else:
        first = "Nothing new since yesterday."
    then = (" " + _plural(waiting, "email is", "emails are") + " waiting for your OK." if waiting
            else " " + _plural(needs, "thing needs", "things need") + " you." if needs else " Nothing needs you.")
    return first + then, name


def today_card(today: dict, suite: dict | None, numbers: dict | None = None, report: dict | None = None) -> dict:
    st = today.get("stats") or {}
    items = today.get("items") or []
    needs = [i for i in items if i.get("tone") != "good"]
    rows = [{"title": i.get("title", ""), "detail": i.get("detail", ""),
             "tag": "Needs you" if i.get("tone") != "good" else "",
             "tone": "bad" if i.get("tone") == "bad" else "wait",
             "page": page_for(i.get("tab", "")) or "today", "action": "Open",
             "primary": i is (needs[0] if needs else None)} for i in items[:6]]
    suite_line = ""
    if suite and not suite.get("error") and suite.get("total"):
        suite_line = f"{suite['on']} of {suite['total']} parts of the suite are on."
    waiting = _n(st.get("outbox_pending"))
    answer, agent = _today_answer(report, waiting, len(needs))
    tiles = [
        _tile("People found", 0, _series(numbers, "found"), value=st.get("prospects")),
        _tile("Emails sent", 0, _series(numbers, "sent")),
        _tile("Conversations", 0, _series(numbers, "replies"), value=st.get("open_conversations")),
        _tile("Waiting on you", waiting + _n(st.get("needs_human")), tone="wait" if waiting + _n(st.get("needs_human")) else ""),
    ]
    found = _series(numbers, "found")
    if found:   # the series is the last days; the number above it is everyone
        tiles[0]["note"] = f"+{found['value']} in {found['days']} days"
        tiles[0].pop("before", None)
    for item in rows:
        item["attention"] = item["tag"] == "Needs you"
    return {
        "kind": "today", "title": "Today", "answer": answer, "agent": agent, "tiles": tiles,
        "count": len(needs),
        "subtitle": ((f"{len(needs)} thing needs you." if len(needs) == 1 else f"{len(needs)} things need you.")
                     if needs else "Nothing needs you right now.") + (" " + suite_line if suite_line else ""),
        "stats": [[_n(st.get("outbox_pending")), "to approve"], [_n(st.get("open_conversations")), "conversations"],
                  [_n(st.get("leads_needing_you")), "new leads"], [_n(st.get("prospects")), "people"]],
        "items": rows, "page": "today", "open_label": "Open Today",
        "empty": "Nothing needs you. Sellbird keeps going on its own.",
        "next": rows[0]["title"] if rows else "",
    }


def needs_you_card(outbox: dict, conversations, leads: dict, social: dict, texting: dict) -> dict:
    rows: list[dict] = []
    for item in (outbox.get("pending") or [])[:6]:
        reply = item.get("kind") == "reply"
        ctx = item.get("context") or {}
        rows.append({"title": ("Reply to " if reply else "First email to ") + _who(item),
                     "detail": item.get("subject") or "",
                     "tag": "Draft reply" if reply else (ctx.get("campaign") or "Draft"), "tone": "acc",
                     "page": "outbox", "action": "Review", "primary": True})
    handed = [c for c in (conversations if isinstance(conversations, list) else []) if c.get("status") == "needs_human"]
    for c in handed[:4]:
        why = HANDED_WHY.get(str(c.get("intent") or ""), "")
        who = " ".join(x for x in (c.get("first_name"), c.get("last_name")) if x) or c.get("company") or ""
        rows.append({"title": "A conversation needs you" if not who else f"{who} needs a reply from you",
                     "detail": "Sellbird handed it to you" + (f": {why}" if why else "") + ". Reply yourself, then close it or hand it back.",
                     "tag": "Needs you", "tone": "bad", "page": "conversations", "action": "Review"})
    for lead in [x for x in (leads.get("leads") or []) if x.get("status") in ("new", "unreadable")][:4]:
        rows.append({"title": _lead_name(lead),
                     "detail": _short(lead.get("message")), "tag": "Lead", "tone": "wait",
                     "page": "leads", "action": "Review"})
    for post in (social.get("waiting") or [])[:3]:
        rows.append({"title": "Social post for " + str(post.get("platform_label") or post.get("platform") or ""),
                     "detail": _short(post.get("body")), "tag": "Draft post", "tone": "acc",
                     "page": "social", "action": "Review"})
    for text in (texting.get("pending") or [])[:3]:
        who = " ".join(x for x in (text.get("first_name"), text.get("last_name")) if x) or text.get("phone") or ""
        rows.append({"title": "Text to " + who, "detail": _short(text.get("body")), "tag": "Draft text",
                     "tone": "acc", "page": "texts", "action": "Review"})
    pending = len(outbox.get("pending") or [])
    for r in rows:   # every row here is yours to decide: "Only you" sits once, on the header
        r["attention"] = r["tone"] == "bad"
    leads_new = len([x for x in (leads.get("leads") or []) if x.get("status") in ("new", "unreadable")])
    posts = len(social.get("waiting") or []) + len(texting.get("pending") or [])
    return {
        "kind": "needs_you", "title": "Waiting for you", "count": len(rows), "only_you": bool(rows),
        "answer": (_plural(len(rows), "thing is", "things are") + " waiting for your decision. Each opens in the dashboard, "
                   "where only you can approve it." if rows else "Nothing is waiting for you."),
        "tiles": [_tile("Emails", pending, tone="wait" if pending else ""), _tile("Conversations", len(handed), tone="bad" if handed else ""),
                  _tile("Leads", leads_new), _tile("Posts and texts", posts)],
        "subtitle": (f"{len(rows)} things are waiting for your decision." if rows else "Nothing is waiting for you."),
        "stats": [[pending, "emails"], [len(handed), "conversations"],
                  [len([x for x in (leads.get("leads") or []) if x.get("status") in ("new", "unreadable")]), "leads"],
                  [len(social.get("waiting") or []) + len(texting.get("pending") or []), "posts and texts"]],
        "items": rows, "page": "outbox", "open_label": "Open what is waiting",
        "empty": "Nothing to approve. Anything Sellbird or your agent drafts shows up here.",
        "note": "Review opens it in the dashboard. Only you can approve it there.",
    }


def campaign_card(report: dict, numbers: dict | None = None) -> dict:
    sent, replied, waiting = _n(report.get("sent")), _n(report.get("replied")), _n(report.get("waiting"))
    answer = ((_plural(replied, "reply", "replies") + " from " + _plural(sent, "email", "emails") +
               f", a {_n(report.get('reply_rate'))}% reply rate." if sent else "Nothing has gone out yet.") +
              (" " + _plural(waiting, "email waits", "emails wait") + " for your OK." if waiting else ""))
    s_sent, s_replies = _series(numbers, "sent"), _series(numbers, "replies")
    return {
        "kind": "campaign", "title": report.get("name") or "Campaign", "answer": answer,
        "tiles": [_tile("Sent", sent, {k: v for k, v in s_sent.items() if k in ("series", "days")}),
                  _tile("Replied", replied, {k: v for k, v in s_replies.items() if k in ("series", "days")}),
                  _tile("Meetings", report.get("meetings"), tone="good" if _n(report.get("meetings")) else ""),
                  _tile("Waiting for you", waiting, tone="wait" if waiting else "")],
        "subtitle": (f"{_n(report.get('people'))} people, {_n(report.get('reached'))} reached. "
                     f"Reply rate {_n(report.get('reply_rate'))}%."),
        "stats": [[_n(report.get("sent")), "sent"], [_n(report.get("replied")), "replied"],
                  [_n(report.get("meetings")), "meetings"], [_n(report.get("waiting")), "waiting for you"]],
        "items": ([{"title": (f"{_n(report.get('waiting'))} email waits for your approval" if _n(report.get("waiting")) == 1
                              else f"{_n(report.get('waiting'))} emails wait for your approval"), "tag": "Needs you",
                    "tone": "wait", "page": "outbox", "action": "Review", "primary": True, "decision": True}]
                  if _n(report.get("waiting")) else []),
        "page": "campaigns", "open_label": "Open campaigns",
        "note": f"{_n(report.get('scheduled'))} approved and scheduled. Nothing else sends without you.",
    }


def as_text(card: dict) -> str:
    """The card as plain text, for a host that shows no cards."""
    lines = [card["title"] + ". " + card.get("subtitle", "")]
    lines += [f"- {label}: {value}" for value, label in card.get("stats", [])]
    lines += [f"* {i['title']}" + (f" ({i['detail']})" if i.get("detail") else "") for i in card.get("items", [])]
    lines.append(card.get("note") or "Nothing sends until the user approves it in the dashboard.")
    lines.append("To open any of it: call dashboard_open with the page, and open the link in your browser pane.")
    return "\n".join(lines)


def register(server, guarded, read) -> None:
    """Add the pane tool, the card tools and the card resources to ``server``."""

    for key, uri in CARD_URIS.items():
        def make(uri=uri, key=key):
            @server.resource(uri, name=f"sellbird-{key}-card", mime_type=APP_MIME,
                             description=f"The Sellbird {key.replace('_', ' ')} card",
                             meta={"ui": {"prefersBorder": False}})
            def card_resource() -> str:
                return card_html()
        make()

    @server.tool()
    async def dashboard_open(page: str = "") -> CallToolResult:
        """Open the full Sellbird dashboard in your built-in browser or side panel, signed in.
        Open this in your built-in browser or side panel. `page` is optional: today,
        outbound (what waits for approval), replies, campaigns, signals, social, inbound
        (leads), texts, mentions, people, calendar, numbers, setup, suite, or person/<id>.
        The link works once, within two minutes. Never paste it anywhere else, and never
        ask the user for their dashboard token."""
        screen = page_for(page)
        if screen is None:
            return _result(f"'{page}' isn't a page. Use one of: " + ", ".join(sorted(set(PAGES) - {''})) + ", or person/<id>.",
                           {"ok": False})

        async def call(c):
            base, _ = await c._connection()
            made = await c.post("/api/pane/code")
            if not made.get("code"):
                return made
            return {"ok": True, "url": sign_in_link(base, made["code"], screen), "page": screen,
                    "expires_in": made.get("expires_in", 120)}
        got = await guarded(call)
        if not got.get("url"):
            message = got.get("message") or "Sellbird could not make a sign-in link."
            if "isn't running" in message:
                message += " Then call dashboard_open again."
            return _result(message, {"ok": False, "message": message})
        return _result(f"{OPEN_ADVICE}\n\n{got['url']}", {**got, "advice": OPEN_ADVICE})

    @server.tool(meta={"ui": {"resourceUri": CARD_URIS["today"]}})
    async def show_today() -> CallToolResult:
        """Show the user's Today as a card: what needs them, what happened, the next thing.
        Hosts without cards get the same as text."""
        today = await read("/api/today")
        if today.get("ok") is False or today.get("error"):
            return _result(today.get("message") or today.get("error") or "Sellbird isn't reachable.", {"ok": False})
        suite = await read("/api/suite")
        # For the sparklines and the answer line: optional, the card works without them.
        numbers = await read("/api/numbers?days=14")
        report = await read("/api/agent/report?limit=1")
        card = today_card(today, suite, numbers if not numbers.get("error") else None,
                          report if report.get("day") else None)
        return _result(as_text(card), card)

    @server.tool(meta={"ui": {"resourceUri": CARD_URIS["needs_you"]}})
    async def show_needs_you() -> CallToolResult:
        """Show what waits for the user's decision as a card: drafted emails and replies,
        conversations handed to them, new leads, posts and texts. Each has Review, which
        opens it in the dashboard; only the user can approve there."""
        outbox = await read("/api/outbox")
        if outbox.get("ok") is False:
            return _result(outbox.get("message") or "Sellbird isn't reachable.", {"ok": False})
        conversations = await read("/api/conversations")
        conversations = conversations.get("result", conversations) if isinstance(conversations, dict) else conversations
        card = needs_you_card(outbox, conversations, await read("/api/leads"),
                              await read("/api/social"), await read("/api/texting"))
        return _result(as_text(card), card)

    @server.tool(meta={"ui": {"resourceUri": CARD_URIS["campaign"]}})
    async def show_campaign_report(campaign_id: str = "latest") -> CallToolResult:
        """Show one campaign's report as a card: emails sent, replies, meetings, and what
        waits for approval. `campaign_id` from campaigns_list, or "latest"."""
        report = await read(f"/api/campaigns/{quote(campaign_id or 'latest', safe='')}/report")
        if report.get("ok") is False or not report.get("id"):
            return _result(report.get("message") or "There is no such campaign.", {"ok": False})
        numbers = await read(f"/api/numbers?days=30&campaign={quote(str(report['id']), safe='')}")
        card = campaign_card(report, numbers if not numbers.get("error") else None)
        return _result(as_text(card), card)
