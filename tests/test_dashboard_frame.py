"""The dashboard's frame: six places in a dock, every older tab still
reachable, a layout that reads its own container, and the Calendar route."""

import asyncio
import re
import shutil
import sqlite3
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from tests.test_dashboard_signals import client  # noqa: F401  (fixture)
from sellbird.state import StateManager

WEB = Path(__file__).resolve().parent.parent / "sellbird" / "web"
PLACES = ["today", "outbound", "inbound", "people", "calendar", "numbers", "setup"]
# The fifteen tabs of the sidebar this frame replaced: none may go missing.
OLD_TABS = ["today", "company", "outbox", "inboxes", "conversations", "signals", "discover",
            "companies", "prospects", "campaigns", "activity", "usage", "controls", "settings", "help"]


def _screens() -> dict:
    src = (WEB / "app.js").read_text(encoding="utf-8")
    block = src.split("const SCREENS = {", 1)[1].split("};", 1)[0]
    return {m.group(1): m.group(2) for m in re.finditer(r"^\s*(\w+):\s*\{place: '(\w+)'", block, re.M)}


def test_the_dock_has_seven_places_and_no_sidebar():
    html = (WEB / "index.html").read_text(encoding="utf-8")
    assert re.findall(r'class="navitem[^"]*" data-place="(\w+)"', html) == PLACES
    assert "<aside" not in html and 'class="sidebar"' not in html


def test_every_old_tab_is_still_a_screen_inside_one_of_the_seven_places():
    html = (WEB / "index.html").read_text(encoding="utf-8")
    screens = _screens()
    for tab in OLD_TABS:
        assert f'<div id="{tab}" class="section' in html, tab
        assert screens.get(tab) in PLACES, tab
    assert set(screens.values()) == set(PLACES)
    for screen in screens:   # nothing in the table points at a section that isn't there
        assert f'<div id="{screen}" class="section' in html, screen


def test_the_logo_is_the_signature_file_not_typed_text(client):
    html = client.get("/").text
    assert "<span>sellbird</span>" not in html
    assert 'class="logo"' in html
    svg = client.get("/static/sellbird-signature.svg")
    assert svg.status_code == 200 and svg.headers["content-type"].startswith("image/svg+xml")
    assert "sellbird-signature.svg" in client.get("/static/app.css").text


def test_the_layout_sizes_to_its_own_frame():
    css = (WEB / "app.css").read_text(encoding="utf-8")
    assert "container: app / inline-size" in css
    assert css.count("@container app (max-width") >= 8
    # Window-width rules are left only for the dialog, which lives outside the frame.
    window_rules = re.findall(r"@media \(max-width: \d+px\) \{ (\S+)", css)
    assert set(window_rules) <= {".modal-stats", ".provider-picks"}
    assert "#1D4ED8" not in css and "#244B62" in css   # Pale Harbor, not the old blue


def test_a_screen_fragment_survives_and_a_token_fragment_does_not():
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed")
    script = r'''
const fs = require('fs'), vm = require('vm');
const run = hash => {
  const replaced = [];
  const store = {};
  global.window = {location: {hash, pathname: '/', search: '', origin: 'http://127.0.0.1:5555'}};
  global.history = {replaceState: (a, b, url) => replaced.push(url)};
  global.sessionStorage = {getItem: k => store[k] || null, setItem: (k, v) => { store[k] = v; }, removeItem: k => delete store[k]};
  vm.runInThisContext(fs.readFileSync(process.argv[1], 'utf8').replace(/^const /gm, 'var '));
  return {replaced, saved: Object.keys(store).length};
};
console.log(JSON.stringify([run('#outbox'), run('#token=' + 'T'.repeat(43))]));
'''
    out = subprocess.run([node, "-e", script, str(WEB / "auth.js")], capture_output=True, text=True,
                         check=True, timeout=30).stdout
    import json
    screen, token = json.loads(out)
    assert screen == {"replaced": [], "saved": 0}
    assert token == {"replaced": ["/"], "saved": 1}


def _sql(db, query, params=()):
    with sqlite3.connect(db) as conn:
        conn.execute(query, params)
    conn.close()


def test_calendar_counts_each_day_by_what_is_due(client):
    asyncio.run(StateManager(str(client.db_path)).init_db())
    today = datetime.now(timezone.utc).date()
    at = lambda n, hour=10: (today + timedelta(days=n)).isoformat() + f"T{hour:02d}:00:00"  # noqa: E731
    rows = [("o1", "pending_review", at(1), None), ("o2", "pending_review", at(1, 8), None),
            ("o3", "approved", at(1), None), ("o4", "sending", at(0), None),
            ("o5", "sent", at(-1), at(0, 9)), ("o6", "rejected", at(1), None),
            ("o7", "approved", at(30), None)]
    for i, (oid, status, send_at, sent_at) in enumerate(rows):
        _sql(client.db_path, "INSERT INTO outbox (id, prospect_id, step, to_email, status, send_at, sent_at) "
             "VALUES (?, 'p1', ?, 'a@example.com', ?, ?, ?)", (oid, i + 1, status, send_at, sent_at))
    _sql(client.db_path, "INSERT INTO prospects (id, first_name, last_name, company, status) "
         "VALUES ('p1', 'Avery', 'Example', 'Acme', 'meeting')")
    _sql(client.db_path, "INSERT INTO conversations (id, prospect_id, created_at) VALUES ('c1', 'p1', ?)", (at(0),))

    data = client.get(f"/api/calendar?start={today.isoformat()}&days=7").json()
    assert [d["date"] for d in data["days"]] == [(today + timedelta(days=n)).isoformat() for n in range(7)]
    first, second = data["days"][0], data["days"][1]
    assert (first["scheduled"], first["sent"], first["replies"], first["waiting"]) == (1, 1, 1, 0)
    assert (second["waiting"], second["scheduled"]) == (2, 1)      # rejected mail is not on the calendar
    assert second["first_waiting"].startswith(at(1, 8)[:13])        # the earliest one due
    assert sum(d["scheduled"] for d in data["days"]) == 2           # day 30 is outside the week
    assert [m["first_name"] for m in data["meetings"]] == ["Avery"]
    assert data["paused"] == ""


def test_calendar_days_follow_the_viewers_time_zone(client):
    asyncio.run(StateManager(str(client.db_path)).init_db())
    _sql(client.db_path, "INSERT INTO outbox (id, to_email, status, send_at) "
         "VALUES ('o1', 'a@example.com', 'approved', '2026-03-10T23:30:00')")
    utc = client.get("/api/calendar?start=2026-03-10&days=2").json()["days"]
    east = client.get("/api/calendar?start=2026-03-10&days=2&tz=120").json()["days"]
    assert [d["scheduled"] for d in utc] == [1, 0]
    assert [d["scheduled"] for d in east] == [0, 1]


def test_calendar_bounds_and_bad_dates(client):
    asyncio.run(StateManager(str(client.db_path)).init_db())
    assert len(client.get("/api/calendar?days=500").json()["days"]) == 42
    assert len(client.get("/api/calendar?days=0").json()["days"]) == 1
    assert client.get("/api/calendar?start=tomorrow").status_code == 400
    assert client.get("/api/calendar?days=x").status_code == 422


def test_the_dock_names_each_place_even_when_its_words_are_hidden():
    html = (WEB / "index.html").read_text(encoding="utf-8")
    buttons = re.findall(r'<button type="button"[^>]*class="navitem[^>]*>', html)
    assert len(buttons) == len(PLACES) and all("aria-label=" in b for b in buttons)
    css = (WEB / "app.css").read_text(encoding="utf-8")
    assert "@container app (max-width: 460px)" in css and ".navitem .lbl { position: absolute" in css


def test_the_old_inbox_address_still_opens_replies():
    js = (WEB / "app.js").read_text(encoding="utf-8")
    assert "inbox: 'conversations'" in js and "outbound: 'outbox'" in js and "inbound: 'leads'" in js
