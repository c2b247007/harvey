"""/api/numbers, /api/stat/{metric}, the calendar's hours and the setup
steps' fix links: every figure from a record. Every name here is made up."""

import asyncio
import sqlite3
from datetime import datetime, timedelta, timezone

from sellbird.state import StateManager
from tests.test_dashboard_signals import client  # noqa: F401  (fixture)


def _ts(days_ago=0, hours=0):
    t = datetime.now(timezone.utc) - timedelta(days=days_ago, hours=hours)
    return t.strftime("%Y-%m-%d %H:%M:%S")


def _sql(db, query, params=()):
    conn = sqlite3.connect(db)
    with conn:
        conn.execute(query, params)
    conn.close()


def _seed(db):
    # Three found this week, one found 10 days ago (the period before a 7-day range).
    for i in range(3):
        _sql(db, "INSERT INTO prospects (id, first_name, company, created_at) VALUES (?, ?, 'Example Co', ?)",
             (f"p{i}", f"Pat{i}", _ts(1)))
    _sql(db, "INSERT INTO prospects (id, first_name, created_at) VALUES ('old', 'Sam', ?)", (_ts(10),))
    _sql(db, "INSERT INTO campaigns (id, name, prospect_ids_json) VALUES ('c1', 'Example run', '[\"p0\", \"p1\"]')")
    for i in range(2):
        _sql(db, "INSERT INTO outbox (id, campaign_id, prospect_id, status, sent_at, created_at) "
                 "VALUES (?, 'c1', ?, 'sent', ?, ?)", (f"o{i}", f"p{i}", _ts(1), _ts(2)))
    _sql(db, "INSERT INTO conversations (id, prospect_id, campaign_id, created_at) VALUES ('v1', 'p0', 'c1', ?)",
         (_ts(0),))
    _sql(db, "UPDATE prospects SET stage = 'meeting_booked' WHERE id = 'p0'")


def test_numbers_series_previous_and_funnel(client):  # noqa: F811
    asyncio.run(StateManager(str(client.db_path)).init_db())
    _seed(client.db_path)
    r = client.get("/api/numbers?days=7").json()
    assert len(r["days"]) == 7 and r["has_previous"]
    assert r["series"]["found"]["total"] == 3 and r["series"]["found"]["previous"] == 1
    assert r["series"]["sent"]["total"] == 2 and r["series"]["replies"]["total"] == 1
    assert [s["n"] for s in r["funnel"]] == [3, 2, 1, 1]          # each step a part of the one before
    camp = r["by_campaign"][0]
    assert (camp["name"], camp["people"], camp["sent"], camp["replies"]) == ("Example run", 2, 2, 1)


def test_numbers_by_campaign_and_all(client):  # noqa: F811
    asyncio.run(StateManager(str(client.db_path)).init_db())
    _seed(client.db_path)
    r = client.get("/api/numbers?days=7&campaign=c1").json()
    assert r["series"]["found"]["total"] == 2                     # only that campaign's people
    assert r["funnel"][0]["n"] == 2
    every = client.get("/api/numbers?days=0").json()
    assert every["range"] == 0 and not every["has_previous"]
    assert every["series"]["found"]["total"] == 4 and len(every["days"]) >= 10


def test_stat_pages_list_the_records(client):  # noqa: F811
    asyncio.run(StateManager(str(client.db_path)).init_db())
    _seed(client.db_path)
    found = client.get("/api/stat/found?days=7").json()
    assert found["total"] == 3 and found["previous"] == 1 and len(found["items"]) == 3
    sent = client.get("/api/stat/sent?days=30").json()
    assert {i["prospect_id"] for i in sent["items"]} == {"p0", "p1"}
    assert client.get("/api/stat/replies?days=7").json()["items"][0]["first_name"] == "Pat0"
    assert client.get("/api/stat/nope").status_code == 404


def test_calendar_hours(client):  # noqa: F811
    asyncio.run(StateManager(str(client.db_path)).init_db())
    db = client.db_path
    _sql(db, "INSERT INTO outbox (id, status, send_at) VALUES ('w1', 'pending_review', ?)", (_ts(-1),))
    _sql(db, "INSERT INTO outbox (id, status, send_at) VALUES ('w2', 'approved', ?)", (_ts(-1),))
    start = (datetime.now(timezone.utc)).date().isoformat()
    days = client.get(f"/api/calendar?start={start}&days=7").json()["days"]
    kinds = sorted(h["kind"] for d in days for h in d["hours"])
    assert kinds == ["scheduled", "waiting"]


def test_every_setup_step_says_where_it_is_fixed(client):  # noqa: F811
    asyncio.run(StateManager(str(client.db_path)).init_db())
    checks = client.get("/api/setup-status").json()["checks"]
    assert all(c.get("fix") for c in checks)
    sig = next(c for c in checks if c["id"] == "signals")
    assert sig["label"] == "Choose who to look for" and not sig["required"]
    assert "you confirm" in sig["help"].lower()


def test_the_fixes_the_warnings_point_to_save_where_sellbird_reads_them(tmp_path):
    """The postal address, the booking link and your form's sender address
    are edited in the dashboard now, not only in the config file."""
    import yaml
    from sellbird.offer import save_company
    cfg = tmp_path / "sellbird.yaml"
    cfg.write_text(yaml.safe_dump({"compliance": {"precleared": {"enabled": False}}, "product": {"name": "Example"}}),
                   encoding="utf-8")
    save_company(cfg, "compliance", {"postal_address": "100 Example Street, Springfield", "opt_out_line": "Reply stop."})
    save_company(cfg, "offer", {"booking_url": "https://cal.example.com/pat/15min"})
    save_company(cfg, "inbound", {"form_senders": ["forms@example.com", "example.org"]})
    data = yaml.safe_load(cfg.read_text(encoding="utf-8"))
    assert data["compliance"]["postal_address"] == "100 Example Street, Springfield"
    assert data["compliance"]["precleared"] == {"enabled": False}             # the rest of the section is kept
    assert data["product"]["offer"]["booking_url"] == "https://cal.example.com/pat/15min"
    assert data["inbound"]["form_senders"] == ["forms@example.com", "example.org"]
    import pytest
    with pytest.raises(ValueError):
        save_company(cfg, "compliance", {"precleared": {"enabled": True}})  # only the two lines


def _run_js(names, call):
    """Run some of app.js's functions under node, with its real helpers."""
    import json as _json  # noqa: F401
    import re
    import shutil
    import subprocess
    from pathlib import Path
    import pytest
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed")
    source = (Path(__file__).resolve().parent.parent / "sellbird" / "web" / "app.js").read_text(encoding="utf-8")
    parts = ["const CHECK_SVG = '<svg></svg>';", "function goFix() {}"]
    for name in names:
        match = re.search(r"^function " + name + r"\(.*?^}\n", source, re.S | re.M)
        assert match, name
        parts.append(match.group(0))
    return subprocess.run([node, "-e", "\n".join(parts) + "\nprocess.stdout.write(" + call + ");"],
                          capture_output=True, text=True, encoding="utf-8", check=True, timeout=30).stdout


def test_the_setup_rail_has_one_primary_button_and_every_step_a_way_to_it():
    import json
    checks = [
        {"id": "venv", "label": "Install", "done": True, "required": True, "help": "", "fix": "help"},
        {"id": "verifier", "label": "Email verification key", "done": False, "required": True,
         "help": "Add a key.", "fix": "settings", "field": "reoon-key", "fix_label": "Add a key"},
        {"id": "config", "label": "Your company", "done": False, "required": True, "help": "", "fix": "company",
         "fix_label": "Open Your company"},
        {"id": "signals", "label": "Choose who to look for", "done": False, "required": False, "shown": True,
         "help": "Your agent suggests signals from what you sell. You confirm which ones count.", "proposed": 0, "fix": "signals"},
    ]
    html = _run_js(["escHtml", "jsq", "icon", "plural", "fixBtn", "setupSteps", "stepActions", "setupRailHtml"],
                   "setupRailHtml(" + json.dumps({"checks": checks}) + ")")
    assert html.count("btn-primary") == 1                      # the next step only
    import re
    assert re.search(r"goFix\([^)]*settings[^)]*reoon-key", html)  # straight to the field
    assert "Open Your company" in html                         # a later step still says where it is done
    assert "Ask your agent to suggest signals" in html and "You confirm which ones count" in html
    assert _run_js(["escHtml", "jsq", "icon", "plural", "fixBtn", "setupSteps", "stepActions", "setupRailHtml"],
                   "setupRailHtml(" + json.dumps({"checks": [dict(c, done=True) for c in checks]}) + ")") == ""


def test_a_change_on_a_tiny_base_is_said_in_words_not_a_huge_percent():
    small = _run_js(["num", "pctReads", "changeHtml"], "changeHtml(57, 3, 30)")
    assert "Up from 3 the 30 days before" in small and "%" not in small
    big = _run_js(["num", "pctReads", "changeHtml"], "changeHtml(60, 50, 30)")
    assert "+20% vs the 30 days before" in big
    assert "Down from 6" in _run_js(["num", "pctReads", "changeHtml"], "changeHtml(2, 6, 7)")    # a small base going down
