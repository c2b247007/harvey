"""What the coding agent may call on the dashboard API.

The dashboard accepts two tokens (dashboard_auth): yours, used by the
dashboard, and the agent's, used by the MCP server (sellbird/mcp_server.py).
With the agent's token a request may reach only the routes listed here:
reading, estimating a cost, pausing sending, suggesting, previewing and
proposing a first-email offer for you to confirm, moving a person's stage
and recording a booked meeting (which can only stop email, never send it). Everything else, every
approval, setting, key, purchase, resume or deletion, is yours alone and
answers 403 to the agent.

You can also cut the agent off altogether (dashboard, Set up, Your agent):
while that switch is off every agent request answers 403, and every agent
request, allowed or refused, is written to a log you can read there.

The list is an allowlist on purpose: a route added to the dashboard later is
yours until someone decides the agent may call it. An extension adds its own
agent routes with ``registry.add_agent_route`` (sellbird.extensions).
"""

from __future__ import annotations

import json
import re

# (method, path pattern). Patterns are full matches; {id} segments are [^/]+.
AGENT_ROUTES: tuple[tuple[str, str], ...] = (
    ("GET", r"/api/today"),
    ("GET", r"/api/stats"),
    ("GET", r"/api/trend"),
    ("GET", r"/api/activity"),
    ("GET", r"/api/usage"),
    ("GET", r"/api/live-status"),
    ("GET", r"/api/setup-status"),
    ("GET", r"/api/sending-mode"),
    ("GET", r"/api/sellbird/status"),
    ("GET", r"/api/runs"),
    ("GET", r"/api/campaigns"),
    ("GET", r"/api/companies"),
    ("GET", r"/api/companies/[^/]+/contacts"),
    ("GET", r"/api/companies/[^/]+/profile"),
    ("GET", r"/api/prospects"),
    ("GET", r"/api/conversations"),
    ("GET", r"/api/outbox"),
    ("GET", r"/api/signals"),
    ("GET", r"/api/discover/providers"),
    ("GET", r"/api/inboxes"),
    ("POST", r"/api/discover/estimate"),   # computes a price, runs nothing
    ("POST", r"/api/sending/pause"),       # never resume: that's yours
    ("GET", r"/api/company"),
    ("GET", r"/api/offers/accepted"),
    ("POST", r"/api/offer/suggest"),       # ideas only, saves nothing you'd send
    ("POST", r"/api/offer/preview"),       # writes a sample, saves and sends nothing
    ("POST", r"/api/offer/propose"),       # you confirm it on Your company
    ("POST", r"/api/inboxes/[^/]+/pause"), # one inbox; resuming is yours too
    ("GET", r"/api/calendar"),
    ("GET", r"/api/numbers"),
    ("GET", r"/api/stat/[^/]+"),
    ("GET", r"/api/pipeline"),
    ("GET", r"/api/events"),
    ("GET", r"/api/texting"),
    ("POST", r"/api/texts"),            # a draft; only you approve it
    ("POST", r"/api/consent/check"),    # asks the gate, sends nothing
    ("POST", r"/api/phone-blocks"),     # can only stop contact
    ("GET", r"/api/prospects/[^/]+/stage"),
    ("POST", r"/api/prospects/[^/]+/stage"),    # where a person stands; sends nothing
    ("POST", r"/api/prospects/[^/]+/meeting"),  # a booking only ever stops follow-ups
    ("GET", r"/api/prospects/[^/]+"),            # one person's record
    ("POST", r"/api/prospects/[^/]+/deal"),      # value, next step, notes; sends nothing
    ("GET", r"/api/email-records"),
    ("GET", r"/api/suppressions"),
    ("GET", r"/api/limits"),
    ("GET", r"/api/recommended"),
    ("GET", r"/api/suite"),
    ("GET", r"/api/campaigns/[^/]+/report"),
    ("POST", r"/api/pane/code"),                # a one-use sign-in link for its browser pane; never the token
    ("GET", r"/api/leads"),
    ("POST", r"/api/leads"),                    # a person and a record; sends nothing
    ("POST", r"/api/leads/[^/]+/answer"),       # a draft; only you approve it
    ("GET", r"/api/mentions"),
    ("POST", r"/api/mentions/watches"),         # a proposal; off until you turn it on
    ("POST", r"/api/mentions/check"),           # searches only; never a source that spends credits
    ("POST", r"/api/mentions/(?!watches$|check$)[^/]+"),   # sort it, note it, draft a reply to copy
    ("POST", r"/api/mentions/(?!watches/)[^/]+/lead"),     # a person in People; sends nothing
    ("GET", r"/api/social"),
    ("GET", r"/api/social/playbooks/[^/]+"),
    ("POST", r"/api/social/posts"),                # a draft; only you approve it
    ("POST", r"/api/social/posts/[^/]+/posted"),   # records an approved post as posted; refused otherwise
)

# What each route is, in the words the Your agent screen and its log use.
# A path with no entry is shown as it is.
ROUTE_WORDS: tuple[tuple[str, str], ...] = (
    (r"/api/today", "Read Today"),
    (r"/api/stats", "Read the totals"),
    (r"/api/trend", "Read the trend"),
    (r"/api/activity", "Read the activity log"),
    (r"/api/usage", "Read model usage"),
    (r"/api/live-status", "Read what is running"),
    (r"/api/setup-status", "Read the setup checklist"),
    (r"/api/sending-mode", "Read the sending mode"),
    (r"/api/sellbird/status", "Read the engine's state"),
    (r"/api/runs", "Read past runs"),
    (r"/api/campaigns", "Read campaigns"),
    (r"/api/companies", "Read companies"),
    (r"/api/companies/[^/]+/contacts", "Read a company's people"),
    (r"/api/companies/[^/]+/profile", "Read a company's profile"),
    (r"/api/prospects", "Read people"),
    (r"/api/prospects/[^/]+", "Read one person"),
    (r"/api/conversations", "Read replies"),
    (r"/api/outbox", "Read the Outbox"),
    (r"/api/signals", "Read signals"),
    (r"/api/discover/providers", "Read the sources for finding businesses"),
    (r"/api/inboxes", "Read inboxes"),
    (r"/api/discover/estimate", "Price a search (runs nothing)"),
    (r"/api/sending/pause", "Pause all sending"),
    (r"/api/company", "Read your company"),
    (r"/api/offers/accepted", "Read who said yes to your offer"),
    (r"/api/offer/suggest", "Suggest offers"),
    (r"/api/offer/preview", "Write a sample email for an offer"),
    (r"/api/offer/propose", "Propose an offer for you to confirm"),
    (r"/api/inboxes/[^/]+/pause", "Pause one inbox"),
    (r"/api/calendar", "Read the calendar"),
    (r"/api/numbers", "Read the numbers"),
    (r"/api/stat/[^/]+", "Read one number over time"),
    (r"/api/pipeline", "Read the pipeline"),
    (r"/api/events", "Read events"),
    (r"/api/texting", "Read texts and consent"),
    (r"/api/texts", "Draft a text for you to approve"),
    (r"/api/consent/check", "Ask whether someone may be called or texted"),
    (r"/api/phone-blocks", "Add a number to do-not-contact"),
    (r"/api/prospects/[^/]+/stage", "Move a person's stage"),
    (r"/api/prospects/[^/]+/meeting", "Record a booked meeting"),
    (r"/api/prospects/[^/]+/deal", "Change a deal's value, next step or notes"),
    (r"/api/email-records", "Read the email records check"),
    (r"/api/suppressions", "Read who is never emailed"),
    (r"/api/limits", "Read limits and rules"),
    (r"/api/recommended", "Read the recommended services"),
    (r"/api/suite", "Read everything Sellbird does, and what is on"),
    (r"/api/campaigns/[^/]+/report", "Read one campaign's numbers"),
    (r"/api/pane/code", "Make a one-use link to open the dashboard in its browser pane"),
    (r"/api/leads", "Read leads, or add one"),
    (r"/api/leads/[^/]+/answer", "Draft a first answer to a lead for you to approve"),
    (r"/api/mentions", "Read brand mentions"),
    (r"/api/mentions/watches", "Propose a term to watch (off until you turn it on)"),
    (r"/api/mentions/check", "Search for new mentions (free sources only)"),
    (r"/api/mentions/(?!watches$|check$)[^/]+", "Sort a mention, note it, or draft a reply for you to copy"),
    (r"/api/mentions/(?!watches/)[^/]+/lead", "Make the person behind a mention a lead"),
    (r"/api/social", "Read social playbooks and posts"),
    (r"/api/social/playbooks/[^/]+", "Read one social playbook"),
    (r"/api/social/posts", "Draft a social post for you to approve"),
    (r"/api/social/posts/[^/]+/posted", "Record that a post you approved went out"),
)
_WORDS = [(re.compile(pattern), words) for pattern, words in ROUTE_WORDS]


def describe_route(pattern: str) -> str:
    """The words for one entry of AGENT_ROUTES, by its pattern."""
    return dict(ROUTE_WORDS).get(pattern, pattern)


def describe(path: str) -> str:
    for pattern, words in _WORDS:
        if pattern.fullmatch(path):
            return words
    return path


USER_ONLY = {
    "error": "user_only",
    "message": "Only the user can do this, in the Sellbird dashboard.",
}


def _compile(routes) -> list[tuple[str, re.Pattern]]:
    return [(method.upper(), re.compile(pattern)) for method, pattern in routes]


_BUILT_IN = _compile(AGENT_ROUTES)


def agent_may(method: str, path: str, extra=()) -> bool:
    method = "GET" if method.upper() == "HEAD" else method.upper()
    return any(m == method and p.fullmatch(path) for m, p in (*_BUILT_IN, *extra))


AGENT_OFF = {
    "error": "agent_off",
    "message": "The user has switched agent access off in the Sellbird dashboard "
               "(Set up, Your agent). Only they can switch it back on.",
}


class AgentPolicy:
    """ASGI middleware, inside DashboardGuard: a request made with the agent's
    token reaches only the allowed routes, and none at all while the user has
    switched agent access off. ``is_off`` answers that; ``record`` is told
    the method, path and status of every agent request. Both are optional and
    neither may break a request: a failure in either is swallowed."""

    def __init__(self, app, is_off=None, record=None):
        self.app = app
        self.is_off = is_off
        self.record = record

    async def _note(self, scope, status: int) -> None:
        if self.record is None:
            return
        try:
            await self.record(scope["method"], scope["path"], status)
        except Exception:
            pass

    async def _refuse(self, scope, send, payload: dict) -> None:
        body = json.dumps(payload).encode()
        await send({"type": "http.response.start", "status": 403,
                    "headers": [(b"content-type", b"application/json"),
                                (b"content-length", str(len(body)).encode())]})
        await send({"type": "http.response.body", "body": body})
        await self._note(scope, 403)

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or (scope.get("state") or {}).get("principal") != "agent":
            return await self.app(scope, receive, send)
        off = False
        if self.is_off is not None:
            try:
                off = bool(await self.is_off())
            except Exception:
                off = True   # can't tell: closed is the safe answer for an off switch
        if off:
            return await self._refuse(scope, send, AGENT_OFF)
        from sellbird import extensions
        extra = _compile(extensions.registry().agent_routes)
        if not agent_may(scope["method"], scope["path"], extra):
            return await self._refuse(scope, send, USER_ONLY)
        seen = {"status": 0}

        async def watch(message):
            if message["type"] == "http.response.start":
                seen["status"] = message["status"]
            await send(message)

        try:
            await self.app(scope, receive, watch)
        finally:
            await self._note(scope, seen["status"] or 500)
