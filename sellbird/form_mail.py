"""Form notification emails: recognise one, and read the lead out of it.

Sellbird runs on your own computer, so it cannot host a form. Form tools
already email you each submission, though, and Sellbird already reads an
inbox. Point those notifications at an inbox Sellbird reads (or forward them
there) and each one becomes a lead.

Two questions, both answered without a model:

- ``is_form_notification``: is this email from a form tool? Yes when its
  sender is one you listed under ``inbound.form_senders``, or its sending
  domain is one of ``KNOWN_FORM_SENDERS`` and that is left on.
- ``parse``: who filled it in, and what did they say? The submitter's
  address comes from Reply-To when the tool sets it, else from an "Email"
  field, else from the first address in the text that is not yours.

Everything read here was typed by a stranger into a form. It is stored and
shown as data. Nothing in it is ever followed as an instruction, and a field
that says someone agreed to texts or calls records no consent.

An email's From line can be forged. A forged notification can do no more
than a real submission can: add a person and a draft that waits for you.
"""

from __future__ import annotations

import html
import re
from email.utils import getaddresses

# Sending domains of form tools, matched on the domain or any subdomain. A
# full address is matched exactly. This is a starting list: a form plugin on
# your own site sends from your own address, so list that address yourself.
KNOWN_FORM_SENDERS = (
    "typeform.com", "tally.so", "jotform.com", "formspree.io", "netlify.com",
    "webflow.com", "squarespace.info", "cognitoforms.com", "paperform.co",
    "fillout.com", "formstack.com", "wufoo.com",
    "forms-receipts-noreply@google.com",
)

MAX_FIELDS = 30
MAX_LABEL = 60
MAX_VALUE = 2000
MAX_MESSAGE = 4000

_EMAIL_RE = re.compile(r"[a-z0-9][a-z0-9._%+\-]*@[a-z0-9](?:[a-z0-9.\-]*[a-z0-9])?\.[a-z]{2,63}", re.I)
_NO_PERSON = re.compile(r"^(no-?reply|do-?not-?reply|notifications?|mailer(-daemon)?|postmaster|forms?)"
                        r"([._+\-].*)?@", re.I)
_LABELS = {
    "email": re.compile(r"\b(e-?mail|email address)\b", re.I),
    "first_name": re.compile(r"^(first|given)\s*name$", re.I),
    "last_name": re.compile(r"^(last|family)\s*name$|^surname$", re.I),
    "name": re.compile(r"^(your |full |contact )?name$", re.I),
    "phone": re.compile(r"\b(phone|mobile|cell|telephone|tel)\b", re.I),
    "company": re.compile(r"\b(company|business|organi[sz]ation|practice|firm)\b", re.I),
    "message": re.compile(r"\b(message|comments?|details|question|enquiry|inquiry|notes?|description|"
                          r"how can we help|what can we help|tell us)\b", re.I),
    "form": re.compile(r"^form( name)?$", re.I),
}
_SUBJECT_FORM = re.compile(
    r"(?:new\s+)?(?:form\s+)?(?:submission|entry|response|lead|enquiry|inquiry|message)s?"
    r"\s*(?:from|for|on|to|in|via|:|-)\s*(.+)$", re.I)
_TAG = re.compile(r"<[^>]+>")
_BREAK = re.compile(r"<\s*(br|/p|/div|/tr|/li|/h[1-6]|/table)\b[^>]*>", re.I)
_CELL = re.compile(r"<\s*/t[dh]\s*>", re.I)


def _clean(value, limit: int) -> str:
    return re.sub(r"[ \t\r\f\v]+", " ", str(value or "")).strip()[:limit]


def _domain(address: str) -> str:
    return address.rsplit("@", 1)[-1].lower() if "@" in address else ""


def _matches(sender: str, entry: str) -> bool:
    sender, entry = sender.strip().lower(), str(entry or "").strip().lower().lstrip("@")
    if not sender or not entry:
        return False
    if "@" in entry:
        return sender == entry
    domain = _domain(sender)
    return domain == entry or domain.endswith("." + entry)


def listed_sender(sender: str, config) -> bool:
    """Is this sender one the person listed under ``inbound.form_senders``?"""
    inbound = getattr(config, "inbound", None)
    return any(_matches(sender, e) for e in getattr(inbound, "form_senders", []) or [])


def known_tool(sender: str, config) -> bool:
    inbound = getattr(config, "inbound", None)
    if not getattr(inbound, "known_form_tools", True):
        return False
    return any(_matches(sender, e) for e in KNOWN_FORM_SENDERS)


def is_form_notification(sender: str, config) -> bool:
    return listed_sender(sender, config) or known_tool(sender, config)


def plain_text(body: str) -> str:
    """The body as text. An HTML notification keeps its line and cell breaks,
    so a table of questions and answers still reads as "Question: answer"."""
    text = str(body or "")
    if re.search(r"<\s*(html|body|table|div|p|br|td)\b", text, re.I):
        text = _CELL.sub(": ", text)
        text = _BREAK.sub("\n", text)
        text = html.unescape(_TAG.sub("", text))
    lines = [re.sub(r"[ \t\xa0]+", " ", line).strip() for line in text.splitlines()]
    return "\n".join(lines).strip()


def read_fields(text: str) -> dict:
    """The question and answer pairs in a notification: "Label: value" on one
    line, or a label ending in a colon with the answer on the next lines."""
    fields: dict[str, str] = {}
    label = ""
    for line in text.splitlines():
        line = line.strip().strip("*").strip()
        if not line:
            label = ""
            continue
        head, colon, rest = line.partition(":")
        head = head.strip(" *-")
        is_label = bool(colon) and 0 < len(head) <= MAX_LABEL and not head.lower().startswith(("http", "mailto"))
        if is_label and rest.strip(" :"):
            if len(fields) < MAX_FIELDS and head not in fields:
                fields[head] = _clean(rest.strip(" :"), MAX_VALUE)
            label = ""
        elif is_label:
            label = head
        elif label and len(fields) < MAX_FIELDS:
            fields[label] = _clean((fields.get(label, "") + " " + line), MAX_VALUE)
    return fields


def _field(fields: dict, kind: str) -> str:
    pattern = _LABELS[kind]
    for label, value in fields.items():
        if pattern.search(label) and value:
            return value
    return ""


def _address(value: str) -> str:
    match = _EMAIL_RE.search(str(value or ""))
    return match.group(0).lower().rstrip(".") if match else ""


def parse(*, sender: str, subject: str, body: str, headers: dict | None = None,
          own_addresses=()) -> dict:
    """What one notification says: ``email``, ``name``, ``phone``, ``company``,
    ``message``, ``form_name`` and every ``fields`` pair. ``email`` is '' when
    no submitter's address could be found."""
    own = {str(a or "").strip().lower() for a in own_addresses if a}
    own.add(sender.strip().lower())
    text = plain_text(body)
    fields = read_fields(text)

    def usable(address: str) -> bool:
        return bool(address) and address not in own and not _NO_PERSON.match(address) \
            and not any(_matches(address, e) for e in KNOWN_FORM_SENDERS)

    reply_name = ""
    email = ""
    reply_to = (headers or {}).get("reply-to", "")
    for display, address in getaddresses([str(reply_to)]) if reply_to else []:
        if usable(address.lower()):
            email, reply_name = address.lower(), _clean(display, 120)
            break
    if not email:
        candidate = _address(_field(fields, "email"))
        email = candidate if usable(candidate) else ""
    if not email:
        email = next((m.group(0).lower().rstrip(".") for m in _EMAIL_RE.finditer(text)
                      if usable(m.group(0).lower().rstrip("."))), "")

    first, last = _field(fields, "first_name"), _field(fields, "last_name")
    name = " ".join(x for x in (first, last) if x) or _field(fields, "name") or reply_name
    if "@" in name:
        name = ""
    message = _field(fields, "message")
    if not message and not fields:
        message = text
    subject = _clean(subject, 200)
    form_name = _field(fields, "form")
    if not form_name:
        match = _SUBJECT_FORM.search(subject)
        form_name = match.group(1).strip(" \"'.") if match else subject
    return {
        "email": email, "name": _clean(name, 120), "phone": _clean(_field(fields, "phone"), 40),
        "company": _clean(_field(fields, "company"), 200), "message": _clean(message, MAX_MESSAGE),
        "form_name": _clean(form_name, 120), "fields": fields,
    }
