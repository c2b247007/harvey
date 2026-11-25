"""The consent check for calls and texts.

One gate, in code, that every call and every text has to pass. It answers a
single question, "may we contact this number, on this channel, right now?",
and it answers no unless all of these hold:

1. The number is a real phone number.
2. The person has not opted out of email, and the number is not on the
   do-not-contact list (someone replied STOP, or you added it).
3. There is a stored yes for that channel: who agreed, when, and how. A yes
   to texts is not a yes to calls. No stored yes means no first text, ever.
4. It is not quiet hours where the person is (21:00 to 08:00 by default).

Nothing in Sellbird can skip it: ``sellbird.texting`` sends only what
``check`` allowed, at the moment of sending, and there is no flag that turns
the gate off. A text that fails the check is held with the reason, not sent.

A yes is evidence, so it is kept as a record and never edited: a later no is
a new row, and the newest row for a number and channel is the answer.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, time, timezone

import pytz

CHANNELS = ("sms", "call")
# How a yes was given. Free text is accepted; these are the common ones.
SOURCES = ("form", "booking_page", "verbal", "written", "inbound_text", "import", "other")

# What a person texts to stop, in any case, alone or as the first word.
STOP_WORDS = ("stop", "stopall", "unsubscribe", "cancel", "end", "quit", "optout", "revoke")
DEFAULT_QUIET_START = time(21, 0)
DEFAULT_QUIET_END = time(8, 0)

# Reasons, as codes a caller can act on and a sentence a person can read.
NO_NUMBER = "no_number"
OPTED_OUT = "opted_out"
DO_NOT_CONTACT = "do_not_contact"
NO_CONSENT = "no_consent"
QUIET_HOURS = "quiet_hours"


@dataclass(frozen=True)
class Decision:
    allowed: bool
    code: str = ""
    reason: str = ""
    retry: bool = False     # True when waiting fixes it (quiet hours)

    def as_dict(self) -> dict:
        return {"allowed": self.allowed, "code": self.code, "reason": self.reason, "retry": self.retry}


ALLOWED = Decision(True)


def normalise_phone(value, default_country: str = "1") -> str:
    """A number in E.164 form ("+13035550119"), or '' when it isn't one.

    A number without a country code is read as ``default_country``'s."""
    raw = str(value or "").strip()
    if not raw:
        return ""
    plus = raw.startswith("+")
    digits = re.sub(r"\D", "", raw)
    if raw.startswith("00") and not plus:
        digits, plus = digits[2:], True
    if not plus:
        cc = re.sub(r"\D", "", str(default_country or "1"))
        if cc == "1" and len(digits) == 11 and digits.startswith("1"):
            digits = digits[1:]
        if cc == "1" and len(digits) != 10:
            return ""
        digits = cc + digits.lstrip("0") if cc != "1" else cc + digits
    if not 8 <= len(digits) <= 15 or digits.startswith("0"):
        return ""
    return "+" + digits


def is_stop(text: str) -> bool:
    """Is this inbound text an opt-out? "STOP", "Stop.", "stop please"."""
    words = re.findall(r"[a-z]+", str(text or "").lower())
    return bool(words) and (words[0] in STOP_WORDS or " ".join(words[:2]) == "opt out")


def _clock(value, fallback: time) -> time:
    try:
        return time.fromisoformat(str(value))
    except (TypeError, ValueError):
        return fallback


def quiet_window(config) -> tuple[time, time]:
    quiet = getattr(getattr(config, "texting", None), "quiet_hours", None)
    return (_clock(getattr(quiet, "start", None), DEFAULT_QUIET_START),
            _clock(getattr(quiet, "end", None), DEFAULT_QUIET_END))


def in_quiet_hours(config, now: datetime, zone: str) -> bool:
    """Is ``now`` (UTC, aware or naive) inside quiet hours on the clock of ``zone``?"""
    start, end = quiet_window(config)
    if start == end:
        return False
    try:
        tz = pytz.timezone(zone or "UTC")
    except pytz.UnknownTimeZoneError:
        tz = pytz.UTC
    aware = now if now.tzinfo else now.replace(tzinfo=timezone.utc)
    local = aware.astimezone(tz).time()
    if start < end:
        return start <= local < end
    return local >= start or local < end      # the usual case: over midnight


async def check(state, config, *, channel: str, phone: str, prospect_id: str = "",
                now: datetime | None = None) -> Decision:
    """May we contact ``phone`` on ``channel`` right now? See the module docstring.

    ``state`` is a StateManager. The answer is never cached: a STOP that
    arrived a second ago counts."""
    from sellbird.config import operator_timezone
    if channel not in CHANNELS:
        return Decision(False, "bad_channel", f"{channel!r} is not a channel Sellbird knows")
    country = getattr(getattr(config, "texting", None), "default_country_code", "1")
    number = normalise_phone(phone, country)
    if not number:
        return Decision(False, NO_NUMBER, "there is no valid phone number for them")

    zone = ""
    if prospect_id:
        person = await state.get_prospect(prospect_id)
        if person is not None:
            if person.status == "opted_out":
                return Decision(False, OPTED_OUT, "they opted out, so nothing more goes to them on any channel")
            zone = person.timezone or ""
    blocked = await state.phone_blocked(number)
    if blocked:
        why = "they replied STOP" if blocked == "opted_out" else "the number is on your do-not-contact list"
        return Decision(False, DO_NOT_CONTACT, why)

    consent = await state.current_consent(number, channel)
    if consent is None or consent["status"] != "granted":
        what = "text" if channel == "sms" else "call"
        if consent is None:
            return Decision(False, NO_CONSENT, f"there is no stored yes to {what}s from this number, "
                                               f"and Sellbird never sends a first {what} without one")
        return Decision(False, NO_CONSENT, f"they took back their yes to {what}s")

    moment = now or datetime.now(timezone.utc)
    if in_quiet_hours(config, moment, zone or operator_timezone(config)):
        start, end = quiet_window(config)
        return Decision(False, QUIET_HOURS,
                        f"it is quiet hours for them ({start:%H:%M} to {end:%H:%M}); it waits until then",
                        retry=True)
    return ALLOWED
