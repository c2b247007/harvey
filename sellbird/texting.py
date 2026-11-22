"""Text messages: drafted, approved by a person, checked, then sent.

The path a text takes:

    draft (you or your agent)  ->  pending_review
    you approve it             ->  approved
    the gate says yes          ->  sent through your own Twilio account
    the gate says no           ->  held, with the reason; or it waits for
                                   quiet hours to end

The gate is ``sellbird.consent.check`` and it runs at the moment of sending,
not when the text was written, so a STOP that arrives in between still wins.
An agent can draft and can read; only a person approves. There is no path
around the check and no setting that disables it.

Inbound texts are read from Twilio each cycle. STOP (and its cousins) opts
the number out at once and cancels anything queued for it.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from sellbird import consent
from sellbird.integrations.twilio import TwilioClient, TwilioError, connection_problem

logger = logging.getLogger("sellbird.texting")

MAX_LENGTH = 640                 # four SMS segments; a text is not an email
STOP_LINE = "Reply STOP to opt out."
LAST_POLL_KEY = "texting_last_poll"


def texting_on(config) -> bool:
    return bool(getattr(getattr(config, "texting", None), "enabled", False))


def status(config, env=None) -> dict:
    """What the Texting screen shows: on or off, connected or what's missing."""
    import os
    env = os.environ if env is None else env
    problem = connection_problem(env)
    start, end = consent.quiet_window(config)
    return {
        "enabled": texting_on(config), "connected": not problem, "problem": problem,
        "from": env.get("TWILIO_FROM_NUMBER", "").strip() or
                ("a messaging service" if env.get("TWILIO_MESSAGING_SERVICE_SID", "").strip() else ""),
        "quiet_hours": {"start": f"{start:%H:%M}", "end": f"{end:%H:%M}"},
        "inbound_counts_as_consent": bool(getattr(getattr(config, "texting", None),
                                                  "reply_to_inbound", True)),
    }


def clean_body(body: str) -> str:
    return " ".join(str(body or "").split())


async def draft(state, config, *, prospect_id: str = "", phone: str = "", body: str, by: str = "you") -> dict:
    """Queue one text for approval. Refused outright when there is no stored
    yes, so nobody approves something that could never be sent."""
    text = clean_body(body)
    if not text:
        return {"success": False, "message": "The text is empty."}
    if len(text) > MAX_LENGTH:
        return {"success": False, "message": f"The text is {len(text)} characters; keep it under {MAX_LENGTH}."}
    person = await state.get_prospect(prospect_id) if prospect_id else None
    if prospect_id and person is None:
        return {"success": False, "message": "No such person."}
    country = getattr(getattr(config, "texting", None), "default_country_code", "1")
    number = consent.normalise_phone(phone or (person.phone if person else ""), country)
    if not number:
        return {"success": False, "message": "There is no valid phone number for them."}
    # Quiet hours are judged when it sends, not when it is written.
    decision = await consent.check(state, config, channel="sms", phone=number, prospect_id=prospect_id)
    if not decision.allowed and decision.code != consent.QUIET_HOURS:
        return {"success": False, "code": decision.code,
                "message": "Not drafted: " + decision.reason + "."}
    text_id = await state.add_text(prospect_id=prospect_id, phone=number, direction="out",
                                   body=text, status="pending_review", drafted_by=by)
    await state.log_action("text_drafted", "user" if by == "you" else "agent",
                           {"prospect_id": prospect_id, "text_id": text_id, "by": by})
    return {"success": True, "id": text_id, "status": "pending_review",
            "message": "Drafted. It waits for approval in Inbox, Texts."}


async def send_approved(state, config, *, client: TwilioClient | None = None,
                        now: datetime | None = None, limit: int = 25) -> dict:
    """Send every approved text the gate allows right now.

    Held back (and left approved) during quiet hours; marked ``blocked`` with
    the reason when the answer is a plain no."""
    report = {"sent": 0, "blocked": 0, "waiting": 0, "failed": 0}
    if not texting_on(config):
        return report
    due = await state.get_texts(status="approved", limit=limit)
    if not due:
        return report
    client = client or TwilioClient.from_env()
    if client is None:
        report["waiting"] = len(due)
        return report
    for item in due:
        decision = await consent.check(state, config, channel="sms", phone=item["phone"],
                                       prospect_id=item["prospect_id"] or "", now=now)
        if not decision.allowed:
            if decision.retry:
                report["waiting"] += 1
                await state.update_text(item["id"], error=decision.reason)
            else:
                report["blocked"] += 1
                await state.update_text(item["id"], status="blocked", error=decision.reason)
                await state.log_action("text_blocked", "main", {"text_id": item["id"], "code": decision.code})
            continue
        # Claim it first: a crash after Twilio accepted must not send it twice.
        if not await state.claim_text(item["id"]):
            continue
        body = item["body"]
        if not await state.has_texted(item["phone"]) and "stop" not in body.lower():
            body = f"{body} {STOP_LINE}"
        try:
            result = await client.send(item["phone"], body)
        except TwilioError as e:
            report["failed"] += 1
            await state.update_text(item["id"], status="failed", error=str(e)[:300])
            continue
        report["sent"] += 1
        await state.update_text(item["id"], status="sent", body=body, provider_sid=result["sid"], error="",
                                sent_at=datetime.now(timezone.utc).replace(tzinfo=None).isoformat())
        await state.log_action("text_sent", "sender", {"text_id": item["id"], "prospect_id": item["prospect_id"]})
    return report


async def read_inbound(state, config, *, client: TwilioClient | None = None) -> dict:
    """Read texts that arrived since the last look. STOP opts the number out
    and cancels what was queued for it. A first message from a new number can
    count as their yes to a reply (``texting.reply_to_inbound``)."""
    report = {"received": 0, "opted_out": 0}
    if not texting_on(config):
        return report
    client = client or TwilioClient.from_env()
    if client is None:
        return report
    last = await state.get_setting(LAST_POLL_KEY)
    try:
        since = datetime.fromisoformat(last) - timedelta(days=1) if last else None
    except ValueError:
        since = None
    try:
        messages = await client.inbound_since(since)
    except TwilioError as e:
        logger.warning(f"Texting: could not read inbound texts: {e}")
        return report
    country = getattr(getattr(config, "texting", None), "default_country_code", "1")
    for m in messages:
        number = consent.normalise_phone(m["from"], country)
        if not number or not m["sid"] or await state.text_exists(m["sid"]):
            continue
        person_id = await state.prospect_id_for_phone(number)
        await state.add_text(prospect_id=person_id, phone=number, direction="in", body=m["body"][:1600],
                             status="received", provider_sid=m["sid"], created_at=m["at"])
        report["received"] += 1
        if consent.is_stop(m["body"]):
            await state.block_phone(number, reason="opted_out", source="reply STOP")
            for channel in consent.CHANNELS:
                await state.add_consent(phone=number, channel=channel, status="revoked", prospect_id=person_id,
                                        source="inbound_text", evidence=m["body"][:200], recorded_by="sellbird")
            cancelled = await state.cancel_texts_for(number, "they replied STOP")
            await state.log_action("text_opt_out", "handler", {"prospect_id": person_id, "cancelled": cancelled})
            report["opted_out"] += 1
        elif getattr(getattr(config, "texting", None), "reply_to_inbound", True) \
                and await state.current_consent(number, "sms") is None:
            await state.add_consent(phone=number, channel="sms", status="granted", prospect_id=person_id,
                                    source="inbound_text", evidence="They texted first: " + m["body"][:160],
                                    recorded_by="sellbird")
    await state.set_setting(LAST_POLL_KEY, datetime.now(timezone.utc).replace(tzinfo=None).isoformat())
    return report


async def tick(state, config) -> dict:
    """One cycle's worth: read what arrived, then send what is approved and allowed."""
    if not texting_on(config):
        return {}
    inbound = await read_inbound(state, config)
    outbound = await send_approved(state, config)
    return {**inbound, **outbound}
