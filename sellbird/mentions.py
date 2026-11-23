"""Brand mentions: find where people talk about you, a competitor, or the
thing you sell, and turn what is found into something you can act on.

Sellbird runs on your own computer, so this works by checking in: every few
hours it searches for each term you watch and keeps what is new. It never
posts, likes, follows or signs in to a social account. A reply is a draft
for you to copy and post from your own account.

Sources, and what each needs (``SOURCES``):

- ``hackernews``  Hacker News stories and comments, through its public
                  search API. No key.
- ``news``        News articles, through the GDELT open news index. No key.
                  It matches the article's text; only the headline comes back.
- ``reddit``      Reddit posts, through Reddit's own API with your own free
                  app (REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET).
- ``youtube``     YouTube videos, through the YouTube Data API with your own
                  free key (YOUTUBE_API_KEY).
- ``web``         A web search (blogs, forums, review pages and whatever a
                  search engine has indexed from social sites), through your
                  Serper key (paid for with credits) or TinyFish key (free).

Sellbird does not scrape Instagram, TikTok, X, Facebook or LinkedIn, and does
not read review sites directly: their terms forbid it. The ``web`` source
finds only what a search engine already shows from them.

Every mention is text a stranger wrote. It is stored and shown as data and
never followed as an instruction.

A mention becomes one of three things, and each is your call: a **lead** (a
person in People with the source "Mention"), a **reply** (a draft you copy
and post yourself), or a **note**.
"""

from __future__ import annotations

import asyncio
import html
import logging
import os
import re
from datetime import datetime, timedelta, timezone
from urllib.parse import quote, urlparse

import httpx

logger = logging.getLogger("sellbird.mentions")

WATCH_KINDS = ("brand", "competitor", "topic")
WATCH_KIND_WORDS = {"brand": "Your name", "competitor": "A competitor", "topic": "A question buyers ask"}
MENTION_KINDS = ("buyer", "complaint", "praise", "competitor", "other")
STATUSES = ("new", "replied", "lead", "noted", "skipped")
MAX_WATCHES = 25
MAX_TERM = 80
MAX_REPLY = 2000
MAX_NOTE = 1000
# Nobody, by hand or through an agent, can run checks closer together than this.
MIN_MINUTES_BETWEEN_CHECKS = 30
LAST_CHECK_KEY = "mentions_last_check"
LAST_REPORT_KEY = "mentions_last_report"
TIMEOUT = 20.0
USER_AGENT = "sellbird-mentions/1.0 (open-source; checks a few terms a few times a day)"
# The news index asks for no more than one request every five seconds, and
# in practice refuses for longer than that. Requests are spaced well apart.
NEWS_PAUSE_SECONDS = 15.0

SOURCES = {
    "hackernews": {"label": "Hacker News", "needs": [], "cost": "Free, no key"},
    "news": {"label": "News articles", "needs": [], "cost": "Free, no key"},
    "reddit": {"label": "Reddit", "needs": ["REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET"],
               "cost": "Free with your own Reddit app"},
    "youtube": {"label": "YouTube", "needs": ["YOUTUBE_API_KEY"],
                "cost": "Free with your own key (about 100 searches a day)"},
    "web": {"label": "Web search", "needs": ["SERPER_API_KEY or TINYFISH_API_KEY"],
            "cost": "Serper: one credit a search. TinyFish: free"},
}

# Sources whose author is a person. For news and web search it is a site.
PERSON_SOURCES = ("hackernews", "reddit", "youtube")

_QUESTION = re.compile(r"\b(recommend\w*|looking for|anyone (know|use|tried)|who (do|does|should)|"
                       r"suggestions?|alternatives? to|which .{0,40}(best|should)|any good)\b|\?", re.I)
_COMPLAINT = re.compile(r"\b(terrible|awful|scam\w*|worst|refund|avoid|rip.?off|never again|"
                        r"disappointed|unacceptable|waste of)\b", re.I)
_TAG = re.compile(r"<[^>]+>")


def _text(value, limit: int) -> str:
    """Plain text from whatever a source returned: tags out, entities
    decoded, whitespace collapsed, cut to ``limit``."""
    cleaned = html.unescape(_TAG.sub(" ", str(value or "")))
    return re.sub(r"\s+", " ", cleaned).strip()[:limit]


def clean_term(value) -> str:
    return re.sub(r"\s+", " ", str(value or "").replace('"', " ")).strip()[:MAX_TERM]


def hint_for(text: str) -> str:
    """A guess at what a mention is, from its words alone: "question" when
    someone is asking for a recommendation, "complaint" when it reads like
    one. A guess, shown as one. Your agent or you decide what it really is."""
    if _COMPLAINT.search(text):
        return "complaint"
    if _QUESTION.search(text):
        return "question"
    return ""


def _has_term(term: str, *texts: str) -> bool:
    """Every word of the term appears in the text (sources match loosely)."""
    haystack = " ".join(texts).lower()
    return all(word in haystack for word in term.lower().split())


def _web_url(value: str) -> str:
    url = str(value or "").strip()
    parsed = urlparse(url)
    return url[:500] if parsed.scheme in ("http", "https") and parsed.hostname else ""


def _env(env, name: str) -> str:
    return str((env if env is not None else os.environ).get(name, "") or "").strip()


def source_ready(key: str, env=None) -> bool:
    """Does this source have what it needs to run?"""
    if key == "reddit":
        return bool(_env(env, "REDDIT_CLIENT_ID") and _env(env, "REDDIT_CLIENT_SECRET"))
    if key == "youtube":
        return bool(_env(env, "YOUTUBE_API_KEY"))
    if key == "web":
        return bool(_env(env, "SERPER_API_KEY") or _env(env, "TINYFISH_API_KEY"))
    return key in SOURCES


def spends_credits(key: str, env=None) -> bool:
    """Only a web search through Serper is paid for per search."""
    return key == "web" and bool(_env(env, "SERPER_API_KEY"))


def sources_status(config, env=None) -> list[dict]:
    """Every source, whether it is on in the config, and whether it can run."""
    chosen = list(getattr(getattr(config, "mentions", None), "sources", []) or [])
    return [{"key": key, "label": meta["label"], "needs": meta["needs"], "cost": meta["cost"],
             "on": key in chosen, "ready": source_ready(key, env),
             "spends": spends_credits(key, env)} for key, meta in SOURCES.items()]


# ── the sources ──
# Each takes (client, term, since, limit, env) and returns a list of dicts:
# url, title, body, author, posted_at. A source that fails raises; the check
# records the failure and carries on with the others.

async def _hackernews(client, term, since, limit, env) -> list[dict]:
    response = await client.get(
        "https://hn.algolia.com/api/v1/search_by_date",
        params={"query": f'"{term}"', "tags": "(story,comment)", "hitsPerPage": limit,
                "numericFilters": f"created_at_i>{int(since.timestamp())}"})
    response.raise_for_status()
    found = []
    for hit in (response.json().get("hits") or []):
        body = _text(hit.get("comment_text") or hit.get("story_text") or "", 1500)
        title = _text(hit.get("title") or hit.get("story_title") or "", 200)
        if not hit.get("objectID") or not _has_term(term, title, body):
            continue
        found.append({"url": f"https://news.ycombinator.com/item?id={hit['objectID']}", "title": title,
                      "body": body, "author": _text(hit.get("author"), 80),
                      "posted_at": str(hit.get("created_at") or "")[:25]})
    return found


async def _news(client, term, since, limit, env) -> list[dict]:
    days = max(1, (datetime.now(timezone.utc) - since).days)
    params = {"query": f'"{term}"', "mode": "artlist", "format": "json", "maxrecords": limit,
              "sort": "datedesc", "timespan": f"{days}d"}
    response = await client.get("https://api.gdeltproject.org/api/v2/doc/doc", params=params)
    if response.status_code == 429:
        # Asked too soon after someone's last request from this address: wait once and ask again.
        await asyncio.sleep(NEWS_PAUSE_SECONDS)
        response = await client.get("https://api.gdeltproject.org/api/v2/doc/doc", params=params)
    response.raise_for_status()
    if "json" not in response.headers.get("content-type", ""):
        raise RuntimeError(_text(response.text, 120) or "the news index did not answer with a list")
    found = []
    for item in (response.json().get("articles") or []):
        seen = str(item.get("seendate") or "")
        posted = f"{seen[:4]}-{seen[4:6]}-{seen[6:8]}" if len(seen) >= 8 and seen[:8].isdigit() else ""
        found.append({"url": item.get("url"), "title": _text(item.get("title"), 200), "body": "",
                      "author": _text(item.get("domain"), 80), "posted_at": posted})
    return found


async def _reddit(client, term, since, limit, env) -> list[dict]:
    token = await client.post(
        "https://www.reddit.com/api/v1/access_token", data={"grant_type": "client_credentials"},
        auth=(_env(env, "REDDIT_CLIENT_ID"), _env(env, "REDDIT_CLIENT_SECRET")))
    token.raise_for_status()
    access = token.json().get("access_token")
    if not access:
        raise RuntimeError("Reddit did not accept the app's id and secret")
    days = (datetime.now(timezone.utc) - since).days
    response = await client.get(
        "https://oauth.reddit.com/search",
        params={"q": f'"{term}"', "sort": "new", "limit": limit, "type": "link",
                "t": "day" if days <= 1 else "week" if days <= 7 else "month"},
        headers={"Authorization": f"Bearer {access}"})
    response.raise_for_status()
    found = []
    for child in ((response.json().get("data") or {}).get("children") or []):
        post = child.get("data") or {}
        title, body = _text(post.get("title"), 200), _text(post.get("selftext"), 1500)
        created = float(post.get("created_utc") or 0)
        if not post.get("permalink") or created < since.timestamp() or not _has_term(term, title, body):
            continue
        sub = _text(post.get("subreddit_name_prefixed"), 60)
        found.append({"url": "https://www.reddit.com" + str(post["permalink"]),
                      "title": f"{sub}: {title}" if sub else title, "body": body,
                      "author": _text(post.get("author"), 80),
                      "posted_at": datetime.fromtimestamp(created, timezone.utc).isoformat()[:19]})
    return found


async def _youtube(client, term, since, limit, env) -> list[dict]:
    response = await client.get(
        "https://www.googleapis.com/youtube/v3/search",
        params={"part": "snippet", "q": f'"{term}"', "type": "video", "order": "date",
                "maxResults": limit, "publishedAfter": since.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "key": _env(env, "YOUTUBE_API_KEY")})
    response.raise_for_status()
    found = []
    for item in (response.json().get("items") or []):
        video = (item.get("id") or {}).get("videoId")
        snippet = item.get("snippet") or {}
        title, body = _text(snippet.get("title"), 200), _text(snippet.get("description"), 1500)
        if not video or not _has_term(term, title, body):
            continue
        found.append({"url": f"https://www.youtube.com/watch?v={quote(str(video), safe='')}", "title": title,
                      "body": body, "author": _text(snippet.get("channelTitle"), 80),
                      "posted_at": str(snippet.get("publishedAt") or "")[:19]})
    return found


async def _web(client, term, since, limit, env) -> list[dict]:
    serper, tinyfish = _env(env, "SERPER_API_KEY"), _env(env, "TINYFISH_API_KEY")
    if serper:
        days = (datetime.now(timezone.utc) - since).days
        response = await client.post(
            "https://google.serper.dev/search",
            json={"q": f'"{term}"', "num": min(limit, 20), "tbs": "qdr:d" if days <= 1 else "qdr:w" if days <= 7 else "qdr:m"},
            headers={"X-API-KEY": serper})
        response.raise_for_status()
        rows = [(r.get("link"), r.get("title"), r.get("snippet"), r.get("date"))
                for r in (response.json().get("organic") or []) if isinstance(r, dict)]
    else:
        response = await client.get("https://api.search.tinyfish.ai", params={"query": f'"{term}"'},
                                    headers={"X-API-Key": tinyfish, "Accept": "application/json"})
        response.raise_for_status()
        rows = [(r.get("url"), r.get("title"), r.get("snippet"), "")
                for r in (response.json().get("results") or []) if isinstance(r, dict)]
    return [{"url": url, "title": _text(title, 200), "body": _text(snippet, 1500),
             "author": (urlparse(str(url or "")).hostname or "")[:80], "posted_at": _text(date, 40)}
            for url, title, snippet, date in rows[:limit]]


_FETCHERS = {"hackernews": _hackernews, "news": _news, "reddit": _reddit, "youtube": _youtube, "web": _web}


# ── a check ──

def _parse_time(value: str) -> datetime | None:
    try:
        return datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return None


async def last_check(state) -> datetime | None:
    return _parse_time(await state.get_setting(LAST_CHECK_KEY))


async def minutes_until_allowed(state) -> int:
    """0 when a check may run now, else how many minutes to wait."""
    last = await last_check(state)
    if last is None:
        return 0
    waited = (datetime.now(timezone.utc).replace(tzinfo=None) - last).total_seconds() / 60
    return max(0, int(MIN_MINUTES_BETWEEN_CHECKS - waited + 0.999))


async def check(state, config, *, env=None, allow_paid: bool = True, client=None,
                pause=asyncio.sleep) -> dict:
    """Search every source that is on for every term being watched, and keep
    what is new. Returns counts: ``found`` (new mentions), ``searches``,
    ``by_source``, and ``problems`` (one plain line per source that failed).
    ``allow_paid`` false leaves out a source that spends credits."""
    settings = getattr(config, "mentions", None)
    watches = await state.get_mention_watches(active_only=True)
    report = {"found": 0, "searches": 0, "by_source": {}, "problems": [], "skipped": [], "watching": len(watches)}
    if settings is None or not watches:
        return report
    since = datetime.now(timezone.utc) - timedelta(days=settings.lookback_days)
    await state.set_setting(LAST_CHECK_KEY, datetime.now(timezone.utc).replace(tzinfo=None).isoformat())
    own = client is None
    client = client or httpx.AsyncClient(timeout=TIMEOUT, headers={"User-Agent": USER_AGENT}, follow_redirects=False)
    try:
        for key in settings.sources:
            if key not in _FETCHERS:
                report["problems"].append(f"{key}: not a source Sellbird knows")
                continue
            if not source_ready(key, env):
                report["skipped"].append(f"{SOURCES[key]['label']}: no key")
                continue
            if spends_credits(key, env) and not allow_paid:
                report["skipped"].append(f"{SOURCES[key]['label']}: spends credits, so only you can run it")
                continue
            ordered = watches
            if key == "news" and len(watches) > 1:
                # The news index may refuse part-way through. Start from a
                # different term each hour so the same ones are not always last.
                turn = int(datetime.now(timezone.utc).timestamp() // 3600) % len(watches)
                ordered = watches[turn:] + watches[:turn]
            for index, watch in enumerate(ordered):
                if key == "news" and index:
                    await pause(NEWS_PAUSE_SECONDS)
                try:
                    rows = await _FETCHERS[key](client, watch["term"], since, settings.max_per_search, env)
                    report["searches"] += 1
                except Exception as e:
                    reason = f"HTTP {e.response.status_code}" if isinstance(e, httpx.HTTPStatusError) \
                        else (_text(str(e), 120) or type(e).__name__)
                    report["problems"].append(f"{SOURCES[key]['label']}: {reason}")
                    break   # this source is failing; the others still run
                for row in rows[:settings.max_per_search]:
                    url = _web_url(row.get("url"))
                    if not url:
                        continue
                    title, body = str(row.get("title") or ""), str(row.get("body") or "")
                    added = await state.add_mention(
                        watch_id=watch["id"], term=watch["term"], watch_kind=watch["kind"], source=key,
                        url=url, title=title, body=body, author=str(row.get("author") or ""),
                        posted_at=str(row.get("posted_at") or ""), hint=hint_for(f"{title} {body}"))
                    if added:
                        report["found"] += 1
                        report["by_source"][key] = report["by_source"].get(key, 0) + 1
    finally:
        if own:
            await client.aclose()
    await state.set_setting(LAST_REPORT_KEY, "; ".join(report["problems"])[:500])
    await state.log_action("mentions_checked", "mentions", {
        "found": report["found"], "searches": report["searches"], "problems": len(report["problems"])})
    return report


async def tick(state, config) -> dict:
    """The engine's pass: run a check when one is due. Nothing happens until
    a term is being watched."""
    settings = getattr(config, "mentions", None)
    if settings is None:
        return {}
    last = await last_check(state)
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    if last is not None and now - last < timedelta(hours=settings.check_every_hours):
        return {}
    if not await state.get_mention_watches(active_only=True):
        return {}
    return await check(state, config)


# ── what you do with a mention ──

async def add_watch(state, term: str, kind: str = "brand", *, by: str = "you") -> dict:
    """Watch a term. One your agent adds is a proposal: it stays off until
    you turn it on."""
    term = clean_term(term)
    kind = kind if kind in WATCH_KINDS else "brand"
    if len(term) < 3:
        return {"success": False, "message": "A term to watch needs at least three characters."}
    if len(await state.get_mention_watches()) >= MAX_WATCHES:
        return {"success": False, "message": f"{MAX_WATCHES} terms is the most Sellbird watches. Remove one first."}
    watch_id = await state.add_mention_watch(term, kind, active=by != "agent", added_by=by)
    if watch_id is None:
        return {"success": False, "message": "That term is already on the list."}
    await state.log_action("mention_watch_added", "agent" if by == "agent" else "user",
                           {"kind": kind, "proposed": by == "agent"})
    return {"success": True, "id": watch_id, "term": term, "kind": kind, "active": by != "agent",
            "message": "Proposed. It stays off until the user turns it on in the dashboard." if by == "agent"
            else "Watching. It is searched for on the next check."}


async def update(state, mention_id: str, *, kind=None, note=None, reply=None, by: str = "you") -> dict:
    """Sort a mention, write a note on it, or draft the reply. The reply is
    text to copy: Sellbird has no way to post it."""
    mention = await state.get_mention(mention_id)
    if mention is None:
        return {"success": False, "message": "There is no such mention."}
    fields: dict = {}
    if kind is not None:
        if kind not in MENTION_KINDS and kind != "":
            return {"success": False, "message": "kind is one of: " + ", ".join(MENTION_KINDS) + "."}
        fields["kind"] = kind
    if note is not None:
        fields["note"] = str(note).strip()[:MAX_NOTE]
        if fields["note"] and mention["status"] == "new" and by != "agent":
            fields["status"] = "noted"
    if reply is not None:
        fields["reply"], fields["reply_by"] = str(reply).strip()[:MAX_REPLY], by
    if not fields:
        return {"success": False, "message": "Nothing to change."}
    await state.update_mention(mention_id, **fields)
    return {"success": True, "message": "Saved. A reply is a draft to copy; Sellbird never posts."
            if "reply" in fields else "Saved."}


async def set_status(state, mention_id: str, status: str) -> dict:
    if status not in ("new", "replied", "skipped", "noted"):
        return {"success": False, "message": "status is new, replied, noted or skipped."}
    if not await state.update_mention(mention_id, status=status):
        return {"success": False, "message": "There is no such mention."}
    return {"success": True}


async def to_lead(state, mention_id: str, *, by: str = "you") -> dict:
    """Make the person behind a mention a lead: someone in People with the
    source "Mention" and a link back to what they posted. There is no email
    address, so nothing is drafted or sent; you answer where they posted."""
    from sellbird.models.prospect import Prospect

    mention = await state.get_mention(mention_id)
    if mention is None:
        return {"success": False, "message": "There is no such mention."}
    if mention["prospect_id"]:
        return {"success": True, "prospect_id": mention["prospect_id"], "message": "They are already in People."}
    if mention["source"] not in PERSON_SOURCES or not mention["author"]:
        return {"success": False, "message": "There is no person behind this one, only a page."}
    prospect_id = await state.add_prospect(Prospect(
        first_name=mention["author"][:80], last_name="", email="", email_status="", title="",
        company="", source="mention", source_url=mention["url"],
        personalization_notes=("Mentioned: " + (mention["title"] or mention["body"]))[:300]),
        lead_source="mention")
    await state.add_lead(prospect_id=prospect_id, source="mention", via="agent" if by == "agent" else "you",
                         form_name=SOURCES.get(mention["source"], {}).get("label", mention["source"]),
                         name=mention["author"][:120], message=(mention["title"] + "\n" + mention["body"]).strip()[:4000],
                         note="From a mention. There is no email address: answer where they posted.",
                         status="recorded", dedup_key="mention:" + mention_id)
    await state.update_mention(mention_id, prospect_id=prospect_id, status="lead")
    await state.log_action("mention_became_lead", "agent" if by == "agent" else "user", {"source": mention["source"]})
    return {"success": True, "prospect_id": prospect_id, "message": "Added to People with the source Mention."}
