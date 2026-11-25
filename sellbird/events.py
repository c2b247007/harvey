"""Events other tools can listen to.

Four things happen to a person that another tool may want to know about:

- ``lead.created``     a new person was added
- ``reply.received``   someone wrote back
- ``meeting.booked``   a meeting was booked with someone
- ``stage.changed``    someone moved to another stage

Every one is written to the ``events`` table the moment it happens, in the
same write as the change itself, so an event can't be lost between the change
and the announcement. Delivery is a separate step (``deliver_pending``): each
endpoint in ``webhooks:`` gets a signed POST, retried with growing waits until
it answers 2xx or the attempts run out.

Signing. Each request carries::

    Sellbird-Signature: t=1767225600,v1=<hex>

where ``v1`` is HMAC-SHA256 of ``"<t>.<raw body>"`` with the endpoint's
secret. Check it with ``verify_signature`` (or the same few lines in any
language), and refuse a ``t`` more than a few minutes old. The secret is read
from the environment variable the endpoint names; an endpoint with no secret
set is never sent to, because an unsigned event is one nobody can trust.

This is plumbing only: it sends what happened to an address you chose.
Nothing here decides anything, and no event carries a credential.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import ipaddress
import json
import logging
import os
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

logger = logging.getLogger("sellbird.events")

EVENT_TYPES = ("lead.created", "reply.received", "meeting.booked", "stage.changed")
TEST_EVENT = "test.ping"
API_VERSION = "2026-11-22"
SIGNATURE_HEADER = "Sellbird-Signature"
SIGNATURE_TOLERANCE_SECONDS = 300

# Minutes to wait before each retry. After the last one the delivery is
# marked failed and left alone; the event stays readable in the dashboard.
RETRY_MINUTES = (1, 5, 30, 120, 360, 720, 1440)
MAX_ATTEMPTS = len(RETRY_MINUTES) + 1
TIMEOUT_SECONDS = 10.0
# An endpoint added today is not sent last month's events.
BACKLOG_HOURS = 72
BATCH = 50


def sign(secret: str, body: bytes, timestamp: int | None = None) -> str:
    """The ``Sellbird-Signature`` header value for ``body``."""
    ts = int(time.time() if timestamp is None else timestamp)
    mac = hmac.new(secret.encode("utf-8"), f"{ts}.".encode("ascii") + body, hashlib.sha256)
    return f"t={ts},v1={mac.hexdigest()}"


def verify_signature(secret: str, body: bytes, header: str, *,
                     tolerance: int = SIGNATURE_TOLERANCE_SECONDS, now: float | None = None) -> bool:
    """True when ``header`` is a signature of ``body`` made with ``secret``
    no more than ``tolerance`` seconds ago. For whoever receives the events."""
    parts = dict(p.split("=", 1) for p in str(header or "").split(",") if "=" in p)
    try:
        ts = int(parts.get("t", ""))
    except ValueError:
        return False
    if abs((time.time() if now is None else now) - ts) > tolerance:
        return False
    expected = sign(secret, body, ts).split("v1=", 1)[1]
    return hmac.compare_digest(expected, parts.get("v1", ""))


def endpoint_key(url: str) -> str:
    """A short stable name for an endpoint, safe to store and show."""
    return hashlib.sha256(url.strip().encode("utf-8")).hexdigest()[:16]


def _is_local(host: str) -> bool:
    if host in ("localhost",) or host.endswith(".localhost"):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def endpoint_problem(endpoint) -> str:
    """Why this endpoint can't be sent to, or '' when it can."""
    url = str(getattr(endpoint, "url", "") or "").strip()
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return "its url is not a web address"
    if parsed.scheme == "http" and not _is_local(parsed.hostname):
        return "its url must start with https:// (plain http is allowed only for localhost)"
    if parsed.username or parsed.password:
        return "its url carries a username or password; use the signing secret instead"
    name = str(getattr(endpoint, "secret_env", "") or "").strip()
    if not name:
        return "it names no secret_env to sign with"
    if not os.environ.get(name, "").strip():
        return f"the environment variable {name} is not set, so events can't be signed"
    unknown = [e for e in (getattr(endpoint, "events", None) or []) if e not in EVENT_TYPES]
    if unknown:
        return "it asks for unknown events: " + ", ".join(unknown)
    return ""


def wants(endpoint, event_type: str) -> bool:
    chosen = getattr(endpoint, "events", None) or []
    return event_type == TEST_EVENT or not chosen or event_type in chosen


def endpoints_of(config) -> list:
    return list(getattr(config, "webhooks", None) or [])


def describe_endpoints(config) -> list[dict]:
    """The endpoints as the dashboard shows them: never the secret."""
    out = []
    for ep in endpoints_of(config):
        url = str(ep.url).strip()
        parsed = urlparse(url)
        out.append({
            "key": endpoint_key(url), "host": parsed.hostname or url, "url": url,
            "events": list(ep.events or EVENT_TYPES), "secret_env": ep.secret_env,
            "problem": endpoint_problem(ep),
        })
    return out


def envelope(event: dict) -> dict:
    """What an endpoint receives for one stored event."""
    data = event.get("data")
    if data is None:
        try:
            data = json.loads(event.get("payload_json") or "{}")
        except (TypeError, ValueError):
            data = {}
    return {"id": event["id"], "type": event["type"], "created_at": event.get("created_at") or "",
            "api_version": API_VERSION, "data": data}


def next_attempt_after(attempts: int, now: datetime | None = None) -> str | None:
    """When to try again after ``attempts`` failures, or None when that was the last."""
    if attempts >= MAX_ATTEMPTS:
        return None
    now = now or datetime.now(timezone.utc).replace(tzinfo=None)
    return (now + timedelta(minutes=RETRY_MINUTES[attempts - 1])).isoformat()


async def _post(client, url: str, secret: str, payload: dict) -> tuple[int, str]:
    """POST one event. Returns (status, error): status 0 means it never arrived."""
    body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "User-Agent": "Sellbird-Webhooks/1",
        "Sellbird-Event": payload["type"],
        "Sellbird-Delivery": payload["id"],
        SIGNATURE_HEADER: sign(secret, body),
    }
    try:
        response = await client.post(url, content=body, headers=headers)
    except Exception as e:   # a refused connection, a timeout, a bad certificate
        return 0, type(e).__name__
    if 200 <= response.status_code < 300:
        return response.status_code, ""
    return response.status_code, f"answered {response.status_code}"


async def deliver_pending(config, state, *, client=None, limit: int = BATCH) -> dict:
    """Send every event that is due to every endpoint that wants it.

    Safe to call as often as you like: a delivered event is never sent to
    the same endpoint twice, and a failing endpoint is retried on its own
    schedule without holding up the others."""
    report = {"delivered": 0, "failed": 0, "skipped": 0}
    endpoints = endpoints_of(config)
    if not endpoints:
        return report
    own_client = client is None
    if own_client:
        import httpx
        client = httpx.AsyncClient(timeout=TIMEOUT_SECONDS, follow_redirects=False)
    try:
        for ep in endpoints:
            problem = endpoint_problem(ep)
            if problem:
                report["skipped"] += 1
                logger.warning(f"Events: not sending to {urlparse(str(ep.url)).hostname or 'an endpoint'}: {problem}.")
                continue
            url = str(ep.url).strip()
            key = endpoint_key(url)
            since = await state.webhook_first_seen(key)
            for event in await state.events_due_for(key, since=since, limit=limit):
                if not wants(ep, event["type"]):
                    await state.record_delivery(event["id"], key, status="skipped", attempts=0)
                    continue
                status, error = await _post(client, url, os.environ[ep.secret_env].strip(), envelope(event))
                attempts = int(event.get("attempts") or 0) + 1
                if not error:
                    await state.record_delivery(event["id"], key, status="delivered",
                                                attempts=attempts, response_status=status)
                    report["delivered"] += 1
                    continue
                again = next_attempt_after(attempts)
                await state.record_delivery(event["id"], key, status="retrying" if again else "failed",
                                            attempts=attempts, response_status=status, error=error,
                                            next_attempt_at=again)
                report["failed"] += 1
    finally:
        if own_client:
            await client.aclose()
    return report


def deliver_soon(config, state) -> None:
    """Start a delivery pass in the background and return at once. Used after
    a change made in the dashboard, so a listener hears about it now and not
    at the next heartbeat. A failure here is only logged: the heartbeat's own
    pass picks up whatever this one missed."""
    if not endpoints_of(config):
        return

    async def run():
        try:
            await deliver_pending(config, state)
        except Exception as e:
            logger.warning(f"Events: background delivery failed: {type(e).__name__}")

    try:
        task = asyncio.get_running_loop().create_task(run())
    except RuntimeError:
        return
    _background.add(task)
    task.add_done_callback(_background.discard)


_background: set = set()
