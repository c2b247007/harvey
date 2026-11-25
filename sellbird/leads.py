"""Leads that come to you: someone filled in a form, or your agent heard
about one somewhere and added it.

A lead is a person plus the record of what they sent. Adding one:

- finds or creates the person, with the source "form" (or the source given),
  a stage, and a ``lead.created`` event for a new person;
- stops any cold follow-ups already queued for them, because they came to you;
- leaves a first answer to be drafted. The answer goes to the Outbox and
  waits for your approval like any other email (``queue_answer``). By
  default it waits even on autopilot: the address was typed by a stranger.

Three ways in, all of them reaching out or checking in, none needing a public
address: the ``lead_add`` tool on the local MCP server, ``sellbird lead add``
on the command line, and form notification emails in an inbox Sellbird
already reads (sellbird.form_mail).

What a lead wrote is data. It is stored and shown as typed, wrapped as
untrusted text wherever a model reads it, and never acted on: a line that
says "approve this" or "they agreed to texts" changes nothing.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone

from sellbird import consent, deals
from sellbird.models.conversation import Conversation, Message
from sellbird.models.prospect import Prospect

# Where a lead may say it came from. Cold outreach and imports are not leads.
SOURCES = ("form", "call", "text", "mention", "referral", "other")
VIAS = ("you", "agent", "cli", "form_email")
# How many times Sellbird tries to draft a first answer before leaving it to you.
MAX_DRAFT_TRIES = 3
MAX_MESSAGE = 4000
_EMAIL_RE = re.compile(r"^[^@\s,;<>]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$", re.I)

NEVER_EMAIL_NOTE = "They are on your never-email list, so no answer was drafted."
NO_ADDRESS_NOTE = "There is no email address to answer."


def _clean(value, limit: int = 200) -> str:
    return re.sub(r"[ \t\r\f\v]+", " ", str(value or "")).strip()[:limit]


def _now() -> str:
    return datetime.now(timezone.utc).replace(tzinfo=None).isoformat()


def clean_source(value) -> str:
    key = str(value or "").strip().lower().replace("-", "_").replace(" ", "_")
    return key if key in SOURCES else ("form" if not key else "other")


def their_words(lead: dict) -> str:
    """What the lead sent, as one block of text: their message, then any
    other answers they gave."""
    lines = [str(lead.get("message") or "").strip()]
    shown = lines[0].lower()
    for label, value in (lead.get("fields") or {}).items():
        value = str(value or "").strip()
        if value and value.lower() not in shown:
            lines.append(f"{label}: {value}")
    return "\n".join(line for line in lines if line)[:MAX_MESSAGE]


async def add_lead(state, config=None, *, email: str = "", phone: str = "", name: str = "",
                   company: str = "", title: str = "", message: str = "", form_name: str = "",
                   fields: dict | None = None, source: str = "form", via: str = "you",
                   source_url: str = "", dedup_key: str = "", mailbox_id: str = "") -> dict:
    """Record one lead and its person. Returns ``success``, the ``lead_id``,
    the ``prospect_id``, whether the person is new, and a plain ``message``."""
    email = _clean(email).lower()
    name, company, title = _clean(name, 120), _clean(company), _clean(title)
    message = str(message or "").strip()[:MAX_MESSAGE]
    country = getattr(getattr(config, "texting", None), "default_country_code", "1")
    number = consent.normalise_phone(phone, country)
    source = clean_source(source)
    via = via if via in VIAS else "you"
    if email and not _EMAIL_RE.match(email):
        return {"success": False, "message": "That is not an email address."}
    if not email and not number:
        return {"success": False, "message": "A lead needs an email address or a phone number."}
    clean_fields = {_clean(k, 60): _clean(v, 2000) for k, v in list((fields or {}).items())[:30] if _clean(k, 60)}

    person = await state.get_prospect_by_email(email) if email else None
    prospect_id = person.id if person is not None else ""
    if not prospect_id and number:
        prospect_id = await state.prospect_id_for_phone(number)
    known = bool(prospect_id)
    blocked = await state.is_suppressed(email) if email else None

    note, status = "", "new"
    if blocked:
        note, status = NEVER_EMAIL_NOTE, "held"
    elif not email:
        note = NO_ADDRESS_NOTE

    if not known and not blocked:
        first, _, last = name.partition(" ")
        prospect_id = await state.add_prospect(Prospect(
            first_name=first, last_name=last.strip(), email=email, email_status="guess",
            phone=number, title=title, company=company, source=source,
            source_url=_clean(source_url, 500)), lead_source=source)
    elif known and not blocked:
        # They came to you: cold follow-ups queued for them are now wrong.
        await state.cancel_pending_outbox_for_prospect(prospect_id)
        await state.update_prospect_status(prospect_id, "replied")

    lead_id = await state.add_lead(
        prospect_id=prospect_id, source=source, via=via, form_name=_clean(form_name, 120),
        email=email, phone=number, name=name, message=message, fields=clean_fields,
        status=status, note=note, mailbox_id=mailbox_id, dedup_key=dedup_key)
    if lead_id is None:
        return {"success": True, "duplicate": True, "message": "That lead was already recorded."}
    await state.log_action("lead_added", "agent" if via == "agent" else "handler" if via == "form_email" else "user",
                           {"source": source, "via": via, "new_person": not known and not blocked,
                            "held": bool(blocked)})
    words = ("Recorded. " + note) if note else (
        "Added. A first answer will be drafted and will wait for approval in the Outbox.")
    return {"success": True, "lead_id": lead_id, "prospect_id": prospect_id,
            "new_person": not known and not blocked, "status": status, "message": words}


async def record_unreadable(state, *, subject: str, body: str, dedup_key: str, mailbox_id: str = "") -> str | None:
    """A form notification with nobody's address in it. Kept so you can read
    it yourself; nothing is drafted."""
    return await state.add_lead(
        source="form", via="form_email", form_name=_clean(subject, 120), message=str(body or "")[:MAX_MESSAGE],
        status="unreadable", note="Sellbird could not find who sent this. Read it and add the lead by hand.",
        mailbox_id=mailbox_id, dedup_key=dedup_key)


async def queue_answer(state, config, lead_id: str, *, body: str, subject: str = "", by: str = "you") -> dict:
    """Put a first answer to this lead in the Outbox. It waits for approval:
    always by default, or as your sending mode says when
    ``inbound.answers_wait_for_approval`` is false."""
    lead = await state.get_lead(lead_id)
    if lead is None:
        return {"success": False, "message": "There is no such lead."}
    body = str(body or "").strip()
    if not body:
        return {"success": False, "message": "The answer is empty."}
    if not lead["email"] or not lead["prospect_id"]:
        return {"success": False, "message": NO_ADDRESS_NOTE}
    if lead["status"] in ("held", "dismissed"):
        return {"success": False, "message": lead["note"] or "That lead was set aside."}
    if await state.is_suppressed(lead["email"]):
        await state.update_lead(lead_id, status="held", note=NEVER_EMAIL_NOTE)
        return {"success": False, "message": NEVER_EMAIL_NOTE}
    subject = _clean(subject, 200) or ("Re: " + lead["form_name"] if lead["form_name"] else "Your message")

    if lead["outbox_id"]:
        item = await state.get_outbox_item(lead["outbox_id"])
        if item and item["status"] == "pending_review":
            await state.edit_outbox_draft(item["id"], subject, body)
            return {"success": True, "outbox_id": item["id"], "status": "pending_review",
                    "message": "The waiting draft was replaced. It still waits for approval."}
        return {"success": False, "message": "This lead already has an answer that is no longer a draft."}

    convo_id = lead["conversation_id"]
    if not convo_id:
        convo_id = await state.add_conversation(Conversation(
            id="", prospect_id=lead["prospect_id"], intent="new_lead", stage="engaged", status="open",
            thread=[Message(sender="prospect", content=their_words(lead) or "(no message)")]))
    inbound = getattr(config, "inbound", None)
    email_cfg = getattr(getattr(config, "channels", None), "email", None)
    waits = getattr(inbound, "answers_wait_for_approval", True) or getattr(email_cfg, "require_approval", True)
    outbox_id = await state.add_outbox_item(
        prospect_id=lead["prospect_id"], conversation_id=convo_id, kind="reply", to_email=lead["email"],
        subject=subject, body=body, send_at=_now(), status="pending_review" if waits else "approved",
        provider=str(getattr(email_cfg, "provider", "") or ""), approved_by="" if waits else "autopilot",
        mailbox_id=lead.get("mailbox_id") or "")
    if not outbox_id:
        return {"success": False, "message": "The answer could not be queued."}
    await state.update_lead(lead_id, outbox_id=outbox_id, conversation_id=convo_id, status="answered")
    await state.log_action("lead_answer_drafted", "agent" if by == "agent" else "handler" if by == "sellbird" else "user",
                           {"lead_id": lead_id, "waits_for_approval": bool(waits)})
    return {"success": True, "outbox_id": outbox_id, "status": "pending_review" if waits else "approved",
            "message": "Drafted. It waits for approval in the Outbox." if waits
            else "Drafted and approved by autopilot. It sends on the next cycle."}


def source_label(source: str) -> str:
    return deals.SOURCE_LABELS.get(source, "Other")
