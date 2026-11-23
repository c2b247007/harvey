"""Bring your own list in: ``sellbird import people.csv``.

A CSV with a header row. Only ``email`` is required; ``first_name``,
``last_name`` (or one ``name`` column), ``title``, ``company``, ``phone`` and
``linkedin_url`` are used when present, under the usual spellings. Each
address is checked the same way a found one is, so an imported person is
labelled verified, risky, invalid or guess, and a guess is never sent to.

What an import never does: email anyone (people land in People with the
source "import" and wait for a campaign), import someone who opted out or
bounced (the never-email list wins), or record consent to calls or texts. A
column saying someone agreed to texts is ignored: a yes is recorded one
person at a time, with how they agreed (sellbird.consent).
"""

from __future__ import annotations

import csv
import io
import re

from sellbird.models.prospect import Prospect

MAX_ROWS = 20_000
_EMAIL_RE = re.compile(r"^[^@\s,;<>]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$", re.I)

# Header spellings, lower-cased with spaces, dashes and underscores removed.
_COLUMNS = {
    "email": ("email", "emailaddress", "workemail", "mail"),
    "first_name": ("firstname", "first", "givenname"),
    "last_name": ("lastname", "last", "surname", "familyname"),
    "name": ("name", "fullname", "contact", "contactname"),
    "title": ("title", "jobtitle", "role", "position"),
    "company": ("company", "companyname", "organization", "organisation", "account", "business"),
    "phone": ("phone", "phonenumber", "mobile", "cell", "telephone"),
    "linkedin_url": ("linkedin", "linkedinurl", "linkedinprofile"),
}


def _key(header: str) -> str:
    return re.sub(r"[\s_\-]+", "", str(header or "").strip().lower())


def _clean(value, limit: int = 200) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()[:limit]


def read_rows(text: str) -> tuple[list[dict], list[str]]:
    """(people, problems). Each person is a dict of the fields above; a
    problem is one plain sentence about a row that was left out. A repeated
    address is kept once."""
    reader = csv.DictReader(io.StringIO(text.lstrip("﻿")))
    if not reader.fieldnames:
        return [], ["The file is empty."]
    column = {}
    for header in reader.fieldnames:
        for field, spellings in _COLUMNS.items():
            if _key(header) in spellings and field not in column:
                column[field] = header
    if "email" not in column:
        return [], ["No email column. The first row must name the columns, and one must be 'email'."]
    people, problems, seen = [], [], set()
    for number, row in enumerate(reader, start=2):
        if len(people) >= MAX_ROWS:
            problems.append(f"Stopped at {MAX_ROWS} people. Split the file and import the rest.")
            break
        get = lambda field: _clean(row.get(column[field])) if field in column else ""  # noqa: E731
        email = get("email").lower()
        if not email:
            continue
        if not _EMAIL_RE.match(email):
            problems.append(f"Row {number}: not an email address.")
            continue
        if email in seen:
            continue
        seen.add(email)
        first, last = get("first_name"), get("last_name")
        if not first and not last and get("name"):
            first, _, last = get("name").partition(" ")
        people.append({"email": email, "first_name": first, "last_name": last.strip(),
                       "title": get("title"), "company": get("company"),
                       "phone": get("phone")[:40], "linkedin_url": get("linkedin_url")})
    return people, problems


async def import_people(state, people: list[dict], *, check=None, dry_run: bool = False) -> dict:
    """Add these people. ``check`` is an async function that grades one
    address (verified, risky, invalid or guess); without it every address is
    a guess, which is never sent to. Returns the counts."""
    counts = {"added": 0, "already_here": 0, "never_email": 0, "invalid": 0,
              "verified": 0, "risky": 0, "guess": 0}
    blocked = await state.suppressed_among([p["email"] for p in people])
    for person in people:
        email = person["email"]
        if email in blocked:
            counts["never_email"] += 1
            continue
        if await state.get_prospect_by_email(email) is not None:
            counts["already_here"] += 1
            continue
        status = "guess"
        if check is not None and not dry_run:
            status = await check(email) or "guess"
        if status == "invalid":
            counts["invalid"] += 1
            continue
        if dry_run:
            counts["added"] += 1
            continue
        prospect = Prospect(
            first_name=person["first_name"], last_name=person["last_name"], email=email,
            email_status=status, email_verified=status == "verified", phone=person["phone"],
            linkedin_url=person["linkedin_url"], title=person["title"], company=person["company"],
            source="import")
        prospect_id = await state.add_prospect(prospect)
        await state.set_lead_source(prospect_id, "import")
        counts["added"] += 1
        counts[status if status in ("verified", "risky") else "guess"] += 1
    if not dry_run and counts["added"]:
        await state.log_action("people_imported", "cli", {k: v for k, v in counts.items() if v})
    return counts
