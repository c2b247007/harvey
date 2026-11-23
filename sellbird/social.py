"""Social playbooks, and post drafts that wait for you.

A playbook is a markdown file that tells your own agent how to write one
kind of post: what it is for, which platforms it suits, how often, and what
a good one looks like. Sellbird ships a few (``skills/social_*.md``); add
your own by dropping a file with the same shape into your skills folder.

What Sellbird does: remembers which playbooks you switched on, keeps every
drafted post, and holds each one until you approve it.

What Sellbird does not do: post. It stores no social login and talks to no
social network. An approved post goes out one of two ways, both yours: you
copy it and post it, or the agent you drive Sellbird with posts it through
an account you connected to that agent. Either way the post is marked as
posted afterwards.

The approval is a record, not a lock on someone else's tool: Sellbird cannot
stop an agent with its own social connection from posting. It gives the
agent no way to approve a post, refuses to mark an unapproved one as posted,
and tells it (``skills/posting_to_social.md``) to post only the exact text
you approved.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

PLATFORMS = ("linkedin", "instagram", "facebook", "x")
PLATFORM_LABELS = {"linkedin": "LinkedIn", "instagram": "Instagram", "facebook": "Facebook", "x": "X"}
# The most characters a post may have. X and Instagram enforce theirs; the
# others are far below what the platform allows, because nobody reads more.
LIMITS = {"x": 280, "linkedin": 3000, "instagram": 2200, "facebook": 2000}
PREFIX = "social_"
# Drafts waiting for you at once. Past this, drafting is refused until you
# approve or skip some: a queue nobody reads helps nobody.
MAX_WAITING = 20
MAX_MEDIA_NOTE = 300
_KEY_RE = re.compile(r"^[a-z0-9][a-z0-9_]{0,48}$")


def _now() -> str:
    return datetime.now(timezone.utc).replace(tzinfo=None).isoformat()


def _folders() -> list[Path]:
    """Your skills folder first, then the copies Sellbird ships."""
    from sellbird.home import bundled_defaults
    from sellbird.workspace_home import current_home

    folders = [Path(current_home().skills_dir)]
    shipped = bundled_defaults()
    if shipped is not None and (shipped / "skills") not in folders:
        folders.append(shipped / "skills")
    return folders


def parse(text: str, key: str) -> dict:
    """One playbook file: the lines between the opening ``---`` pair give its
    name, platforms, cadence and summary; the rest is the guidance."""
    meta: dict[str, str] = {}
    body = text
    if text.startswith("---"):
        head, _, rest = text[3:].partition("\n---")
        body = rest.lstrip("\n")
        for line in head.splitlines():
            name, colon, value = line.partition(":")
            if colon and name.strip():
                meta[name.strip().lower()] = value.strip().strip("\"'")
    platforms = [p for p in re.split(r"[,\s\[\]]+", meta.get("platforms", "").lower()) if p in PLATFORMS]
    return {
        "key": key,
        "name": meta.get("name") or key.replace("_", " ").capitalize(),
        "platforms": platforms or list(PLATFORMS),
        "cadence": meta.get("cadence", ""),
        "summary": meta.get("summary", ""),
        "text": body.strip(),
    }


def playbooks(folders: list[Path] | None = None) -> list[dict]:
    """Every playbook on disk, yours winning over a shipped one of the same
    name, in name order. A file that cannot be read is left out."""
    from sellbird.textio import read_user_text

    found: dict[str, dict] = {}
    for folder in folders if folders is not None else _folders():
        try:
            files = sorted(Path(folder).glob(PREFIX + "*.md"))
        except OSError:
            continue
        for path in files:
            key = path.stem[len(PREFIX):].lower()
            if not _KEY_RE.match(key) or key in found:
                continue
            try:
                found[key] = parse(read_user_text(path), key)
            except (OSError, UnicodeError):
                continue
    return sorted(found.values(), key=lambda p: p["name"].lower())


def playbook(key: str, folders: list[Path] | None = None) -> dict | None:
    return next((p for p in playbooks(folders) if p["key"] == str(key or "").lower()), None)


async def overview(state, folders: list[Path] | None = None) -> dict:
    """What the Social screen and the agent's list show: each playbook
    (without its full text) and whether it is on, then the posts."""
    on = await state.active_social_playbooks()
    books = [{**{k: v for k, v in p.items() if k != "text"}, "active": p["key"] in on}
             for p in playbooks(folders)]
    posts = await state.get_social_posts(limit=100)
    names = {p["key"]: p["name"] for p in books}
    for post in posts:
        post["playbook_name"] = names.get(post["playbook"], post["playbook"] or "No playbook")
        post["platform_label"] = PLATFORM_LABELS.get(post["platform"], post["platform"])
    return {
        "playbooks": books,
        "waiting": [p for p in posts if p["status"] == "pending_review"][::-1],
        "approved": [p for p in posts if p["status"] == "approved"][::-1],
        "recent": [p for p in posts if p["status"] in ("posted", "skipped")][:30],
        "platforms": PLATFORM_LABELS, "limits": LIMITS, "max_waiting": MAX_WAITING,
    }


async def set_active(state, key: str, active: bool, folders: list[Path] | None = None) -> dict:
    book = playbook(key, folders)
    if book is None:
        return {"success": False, "message": "There is no such playbook."}
    await state.set_social_playbook(book["key"], active)
    await state.log_action("social_playbook_switched", "user", {"playbook": book["key"], "on": bool(active)})
    return {"success": True, "key": book["key"], "active": bool(active)}


def _check(platform: str, body: str) -> str:
    """Why this text cannot be a post on this platform, or ''."""
    if platform not in PLATFORMS:
        return "platform is one of: " + ", ".join(PLATFORMS) + "."
    if not body:
        return "The post is empty."
    if len(body) > LIMITS[platform]:
        return (f"That is {len(body)} characters. A post on {PLATFORM_LABELS[platform]} "
                f"may have {LIMITS[platform]}.")
    return ""


async def draft(state, *, playbook_key: str, platform: str, body: str, media_note: str = "",
                by: str = "you", folders: list[Path] | None = None) -> dict:
    """Draft one post from a playbook that is switched on. It waits for
    approval. Nothing is posted."""
    platform = str(platform or "").strip().lower()
    body = str(body or "").strip()
    book = playbook(playbook_key, folders)
    if book is None:
        return {"success": False, "message": "There is no such playbook."}
    if book["key"] not in await state.active_social_playbooks():
        return {"success": False, "message": f"The playbook \"{book['name']}\" is off. Only the user can turn it on, "
                                             "in the dashboard (Set up, Social)."}
    problem = _check(platform, body)
    if not problem and platform not in book["platforms"]:
        problem = (f"The playbook \"{book['name']}\" is for "
                   + ", ".join(PLATFORM_LABELS[p] for p in book["platforms"]) + ".")
    if not problem and await state.count_social_posts("pending_review") >= MAX_WAITING:
        problem = f"{MAX_WAITING} posts are already waiting. Approve or skip some first."
    if problem:
        return {"success": False, "message": problem}
    post_id = await state.add_social_post(playbook=book["key"], platform=platform, body=body,
                                          media_note=str(media_note or "").strip()[:MAX_MEDIA_NOTE], drafted_by=by)
    await state.log_action("social_post_drafted", "agent" if by == "agent" else "user",
                           {"playbook": book["key"], "platform": platform})
    return {"success": True, "id": post_id, "status": "pending_review",
            "message": "Drafted. It waits for the user's approval in the dashboard (Set up, Social)."}


async def approve(state, post_id: str, *, body: str | None = None) -> dict:
    """Approve a waiting post, optionally with your edit. The approved text
    is the text: what gets posted must match it."""
    post = await state.get_social_post(post_id)
    if post is None:
        return {"success": False, "message": "There is no such post."}
    fields = {"approved_at": _now()}
    if body is not None:
        body = str(body).strip()
        problem = _check(post["platform"], body)
        if problem:
            return {"success": False, "message": problem}
        fields["body"] = body
    if not await state.move_social_post(post_id, "approved", only_from=("pending_review",), **fields):
        return {"success": False, "message": "That post is not waiting for approval."}
    await state.log_action("social_post_approved", "user", {"platform": post["platform"]})
    return {"success": True, "status": "approved",
            "message": "Approved. Post it yourself, or ask your agent to post it from the account you connected to it."}


async def edit(state, post_id: str, body: str) -> dict:
    """Change a waiting post's words. It still waits."""
    post = await state.get_social_post(post_id)
    if post is None:
        return {"success": False, "message": "There is no such post."}
    body = str(body or "").strip()
    problem = _check(post["platform"], body)
    if problem:
        return {"success": False, "message": problem}
    if not await state.move_social_post(post_id, "pending_review", only_from=("pending_review",), body=body):
        return {"success": False, "message": "Only a post still waiting can be edited."}
    return {"success": True, "status": "pending_review"}


async def skip(state, post_id: str) -> dict:
    if not await state.move_social_post(post_id, "skipped", only_from=("pending_review", "approved")):
        return {"success": False, "message": "That post can no longer be skipped."}
    return {"success": True, "status": "skipped"}


async def mark_posted(state, post_id: str, *, url: str = "", by: str = "you") -> dict:
    """Record that an approved post went out. Refused for one that was never
    approved."""
    url = str(url or "").strip()
    if url:
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            return {"success": False, "message": "The link to the post must be a web address."}
    post = await state.get_social_post(post_id)
    if post is None:
        return {"success": False, "message": "There is no such post."}
    if post["status"] != "approved":
        return {"success": False, "message": "Only a post the user approved can be marked as posted. "
                                             "This one is " + post["status"].replace("_", " ") + "."}
    await state.move_social_post(post_id, "posted", only_from=("approved",), posted_url=url[:500], posted_at=_now())
    await state.log_action("social_post_posted", "agent" if by == "agent" else "user", {"platform": post["platform"]})
    return {"success": True, "status": "posted"}
