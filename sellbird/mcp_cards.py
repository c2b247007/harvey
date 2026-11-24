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


def _who(item: dict) -> str:
    ctx = item.get("context") or {}
    return ctx.get("contact") or item.get("to_email") or "Someone"


# ── Shaping what the dashboard says into a card ──

def today_card(today: dict, suite: dict | None) -> dict:
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
    return {
        "kind": "today", "title": "Today",
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
        why = c.get("intent", "").replace("_", " ")
        rows.append({"title": "A conversation needs you",
                     "detail": "Sellbird handed it to you" + (f" ({why})" if why else "") + ". Reply yourself, then close it or hand it back.",
                     "tag": "Needs you", "tone": "bad", "page": "conversations", "action": "Review"})
    for lead in [x for x in (leads.get("leads") or []) if x.get("status") in ("new", "unreadable")][:4]:
        rows.append({"title": "New lead: " + (lead.get("name") or lead.get("email") or lead.get("phone") or "someone"),
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
    return {
        "kind": "needs_you", "title": "Waiting for you",
        "subtitle": (f"{len(rows)} things are waiting for your decision." if rows else "Nothing is waiting for you."),
        "stats": [[pending, "emails"], [len(handed), "conversations"],
                  [len([x for x in (leads.get("leads") or []) if x.get("status") in ("new", "unreadable")]), "leads"],
                  [len(social.get("waiting") or []) + len(texting.get("pending") or []), "posts and texts"]],
        "items": rows, "page": "outbox", "open_label": "Open what is waiting",
        "empty": "Nothing to approve. Anything Sellbird or your agent drafts shows up here.",
        "note": "Review opens it in the dashboard. Only you can approve it there.",
    }


def campaign_card(report: dict) -> dict:
    return {
        "kind": "campaign", "title": report.get("name") or "Campaign",
        "subtitle": (f"{_n(report.get('people'))} people, {_n(report.get('reached'))} reached. "
                     f"Reply rate {_n(report.get('reply_rate'))}%."),
        "stats": [[_n(report.get("sent")), "sent"], [_n(report.get("replied")), "replied"],
                  [_n(report.get("meetings")), "meetings"], [_n(report.get("waiting")), "waiting for you"]],
        "items": ([{"title": (f"{_n(report.get('waiting'))} email waits for your approval" if _n(report.get("waiting")) == 1
                              else f"{_n(report.get('waiting'))} emails wait for your approval"), "tag": "Needs you",
                    "tone": "wait", "page": "outbox", "action": "Review", "primary": True}]
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
        card = today_card(today, suite)
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
        card = campaign_card(report)
        return _result(as_text(card), card)
