"""Where each person stands, and where they came from.

One small vocabulary for the whole product: a person is in exactly one
*stage*, and every person has a *source*. The local dashboard's People place,
the hosted pipeline and outbound webhook events all read these two fields,
so they are defined once, here.

Stages move in two ways. Sellbird moves a person forward when something
happens (a reply, a booking, an opt-out); those moves never go backwards and
never undo a decision a person made. You, or your agent on your behalf, can
set any stage at any time: "proposal" and "won" only ever come from you,
because Sellbird cannot see a proposal go out or a deal close.
"""

from __future__ import annotations

STAGES = ("new", "talking", "meeting_booked", "proposal", "won", "lost")
STAGE_LABELS = {
    "new": "New", "talking": "Talking", "meeting_booked": "Meeting booked",
    "proposal": "Proposal", "won": "Won", "lost": "Lost",
}
# How far along a stage is, for moves Sellbird makes itself.
_RANK = {"new": 0, "talking": 1, "meeting_booked": 2, "proposal": 3, "won": 4}

# Where a person came from. The engine finds people by cold outreach and by
# import; the other sources are written by whatever sits on top of it.
SOURCES = ("cold_email", "import", "form", "call", "text", "mention", "referral", "other")
SOURCE_LABELS = {
    "cold_email": "Cold email", "import": "Import", "form": "Form", "call": "Call",
    "text": "Text", "mention": "Mention", "referral": "Referral", "other": "Other",
}
DEFAULT_SOURCE = "cold_email"

# The stage a prospect status implies. Statuses not listed leave the stage alone.
STAGE_FOR_STATUS = {
    "replied": "talking", "interested": "talking", "accepted_offer": "talking",
    "meeting": "meeting_booked",
    "not_interested": "lost", "opted_out": "lost", "lost": "lost", "bounced": "lost",
}


def clean_stage(value) -> str:
    """A stage name as stored, or '' when it isn't one. Accepts the label
    ("Meeting booked") and loose spellings ("meeting-booked")."""
    key = str(value or "").strip().lower().replace("-", "_").replace(" ", "_")
    return key if key in STAGES else ""


def clean_source(value) -> str:
    """A known source, or 'other' for anything else that was given."""
    key = str(value or "").strip().lower().replace("-", "_").replace(" ", "_")
    if not key:
        return DEFAULT_SOURCE
    return key if key in SOURCES else "other"


def automatic_move_allowed(current: str, target: str) -> bool:
    """May Sellbird, on its own, move someone from ``current`` to ``target``?

    Forward only. Nobody leaves "won" or "lost" without a person saying so,
    and Sellbird never claims a proposal or a win."""
    current = clean_stage(current) or "new"
    target = clean_stage(target)
    if not target or target == current or current in ("won", "lost"):
        return False
    if target in ("proposal", "won"):
        return False
    if target == "lost":
        return True
    return _RANK[target] > _RANK[current]
