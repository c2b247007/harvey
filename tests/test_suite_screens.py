"""Email records, opt-outs and bounces, limits, your agent, one person, and import.

No test here touches DNS or a mail verifier: lookups are replaced with canned answers."""

import asyncio
import sqlite3
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

import sellbird.dashboard as dash
from sellbird import agent_policy, deliverability as d, importer
from sellbird.state import StateManager
from tests.test_dashboard_signals import client  # noqa: F401  (fixture)


def run(coro):
    return asyncio.run(coro)


def _sql(db, query, params=()):
    with sqlite3.connect(db) as conn:
        conn.execute(query, params)
    conn.close()


def _person(client, pid="p1", email="avery@example.com", **cols):  # noqa: F811
    client.get("/api/stats")     # creates the tables
    StateManager(str(client.db_path))
    run(StateManager(str(client.db_path)).init_db())
    _sql(client.db_path, "INSERT INTO prospects (id, first_name, last_name, email, phone, status, company) "
                         "VALUES (?, 'Avery', 'Stone', ?, ?, 'contacted', 'Example Roofing')",
         (pid, email, cols.get("phone", "+13035550119")))
    return pid


@pytest.fixture
def agent(client, tmp_path):  # noqa: F811
    """The same dashboard, called with the agent's token (a throwaway one)."""
    dash.agent_token_store.configure(tmp_path / "agent-token")
    token = dash.agent_token_store.get()
    run(StateManager(str(client.db_path)).init_db())
    with TestClient(dash.app, base_url="http://127.0.0.1:5555",
                    headers={"Authorization": f"Bearer {token}"}) as c:
        yield c
    dash.agent_token_store.configure(dash.AGENT_TOKEN_FILE)


# ── Email records ──

def _dns(monkeypatch, txt, mx=True):
    monkeypatch.setattr(d, "_txt", lambda name: txt.get(name, []))
    monkeypatch.setattr(d, "_resolve", lambda name, rtype: (
        [SimpleNamespace(preference=10, exchange="mx.example.com.")] if mx and rtype == "MX" else []))


def test_a_missing_record_comes_with_the_record_to_add(monkeypatch):
    _dns(monkeypatch, {})
    checks = {c["name"]: c for c in dash._email_record_checks("example.com", "")}
    assert checks["MX"]["status"] == d.OK and checks["MX"]["fix"] == ""
    assert checks["SPF"]["status"] == d.FAIL and "v=spf1 include:_spf.google.com ~all" in checks["SPF"]["fix"]
    assert checks["DMARC"]["status"] == d.FAIL
    assert "_dmarc.example.com" in checks["DMARC"]["fix"] and "v=DMARC1; p=none" in checks["DMARC"]["fix"]
    assert checks["DKIM"]["status"] == d.WARN and "DKIM signing" in checks["DKIM"]["fix"]


def test_good_records_need_nothing_and_a_failed_lookup_is_not_a_verdict(monkeypatch):
    _dns(monkeypatch, {"example.com": ["v=spf1 include:_spf.google.com ~all"],
                       "_dmarc.example.com": ["v=DMARC1; p=quarantine"],
                       "google._domainkey.example.com": ["v=DKIM1; k=rsa; p=MIGf"]})
    assert all(c["status"] == d.OK and not c["fix"] for c in dash._email_record_checks("example.com", ""))

    def down(name):
        raise d.LookupFailed("Timeout")
    monkeypatch.setattr(d, "_txt", down)
    spf = next(c for c in dash._email_record_checks("example.com", "") if c["name"] == "SPF")
    assert spf["unknown"] is True and spf["fix"] == ""


def test_two_spf_records_and_an_open_one_each_get_their_own_fix(monkeypatch):
    _dns(monkeypatch, {"example.com": ["v=spf1 a ~all", "v=spf1 mx ~all"]})
    assert "single v=spf1 line" in d.how_to_fix(d.check_spf("example.com"), "example.com")
    _dns(monkeypatch, {"example.com": ["v=spf1 +all"]})
    assert "~all" in d.how_to_fix(d.check_spf("example.com"), "example.com")


def test_the_screen_checks_each_sending_domain_once(client, monkeypatch):  # noqa: F811
    _dns(monkeypatch, {})
    monkeypatch.setattr(dash, "_sending_domains", lambda config, addresses: ["example.com", "example.org"])
    data = client.get("/api/email-records").json()
    assert [x["domain"] for x in data["domains"]] == ["example.com", "example.org"]
    assert data["domains"][0]["state"] == "fail" and len(data["domains"][0]["checks"]) == 4
    assert client.get("/api/email-records", params={"domain": "not a domain"}).status_code == 400


def test_sending_domains_are_the_main_address_then_each_inbox_once():
    config = SimpleNamespace(channels=SimpleNamespace(email=SimpleNamespace(provider="gmail")),
                             persona=SimpleNamespace(email="sam@example.com"))
    assert dash._sending_domains(config, ["a@example.org", "b@Example.org", "c@example.com", "bad"]) == \
        ["example.com", "example.org"]


# ── Opt-outs and bounces ──

def test_the_never_email_list_adds_counts_exports_and_removes(client):  # noqa: F811
    assert client.get("/api/suppressions").json()["total"] == 0
    added = client.post("/api/suppressions", json={"value": "Pat@Example.com"}).json()
    assert added == {"success": True, "added": True, "kind": "address", "value": "pat@example.com"}
    assert client.post("/api/suppressions", json={"value": "pat@example.com"}).json()["added"] is False
    assert client.post("/api/suppressions", json={"value": "example.org"}).json()["kind"] == "domain"
    assert client.post("/api/suppressions", json={"value": "not an address"}).status_code == 400
    state = StateManager(str(client.db_path))
    run(state.add_suppression("address", "gone@example.net", "bounced", source="handler"))
    data = client.get("/api/suppressions").json()
    assert data["counts"] == {"manual": 2, "bounced": 1} and data["total"] == 3
    assert run(state.is_suppressed("anyone@mail.example.org")) == "manual"

    csv_text = client.get("/api/export/suppressions.csv").text
    assert csv_text.splitlines()[0] == "kind,value,reason,source,added_at"
    assert "address,gone@example.net,bounced,handler" in csv_text

    row = next(r for r in data["rows"] if r["value"] == "pat@example.com")
    assert client.post(f"/api/suppressions/{row['id']}/remove").json() == {"success": True}
    assert client.post(f"/api/suppressions/{row['id']}/remove").status_code == 404
    assert run(state.is_suppressed("pat@example.com")) is None


def test_a_csv_cell_cannot_start_a_formula():
    assert dash._csv_safe("=cmd()") == "'=cmd()" and dash._csv_safe("pat@example.com") == "pat@example.com"


# ── Limits and rules ──

def test_limits_show_the_stop_button_state_and_every_limit(client):  # noqa: F811
    data = client.get("/api/limits").json()
    assert data["paused"] == "" and data["mode"] in ("approval", "autopilot")
    for key in ("max_daily_sends", "per_inbox_daily_cap", "max_bounce_rate", "quiet_hours",
                "sequence_length", "follow_ups", "send_to_risky", "texting"):
        assert key in data, key
    client.post("/api/sending/pause")
    assert client.get("/api/limits").json()["paused"]
    client.post("/api/sending/resume")
    assert client.get("/api/limits").json()["paused"] == ""


# ── Your agent ──

def test_every_agent_call_is_logged_including_the_refused_ones(client, agent):  # noqa: F811
    assert agent.get("/api/stats").status_code == 200
    assert agent.post("/api/sending/resume").status_code == 403
    assert agent.get("/api/settings").json()["error"] == "user_only"
    client.get("/api/stats")                                  # yours: not logged
    data = client.get("/api/agent").json()
    assert data["access"] == "on" and data["last_seen"]
    seen = [(r["method"], r["path"], r["status"]) for r in data["requests"]]
    assert seen == [("GET", "/api/settings", 403), ("POST", "/api/sending/resume", 403), ("GET", "/api/stats", 200)]
    assert data["requests"][2]["what"] == "Read the totals"
    assert "Pause all sending" in data["may_do"] and "Move a person's stage" in data["may_do"]


def test_cutting_the_agent_off_refuses_everything_at_once_and_only_you_can_undo_it(client, agent):  # noqa: F811
    assert client.post("/api/agent/access", json={"access": "off"}).json()["access"] == "off"
    refused = agent.get("/api/stats")
    assert refused.status_code == 403 and refused.json()["error"] == "agent_off"
    assert agent.post("/api/sending/pause").status_code == 403         # even a pause
    assert agent.post("/api/agent/access", json={"access": "on"}).status_code == 403
    assert client.get("/api/agent").json()["access"] == "off"
    assert client.get("/api/stats").status_code == 200                 # your own access is untouched
    assert client.post("/api/agent/access", json={"access": "maybe"}).status_code == 400
    client.post("/api/agent/access", json={"access": "on"})
    assert agent.get("/api/stats").status_code == 200


def test_the_agent_can_never_reach_its_own_switch_its_log_or_the_never_email_list():
    may = agent_policy.agent_may
    assert not may("GET", "/api/agent") and not may("POST", "/api/agent/access")
    assert may("GET", "/api/suppressions") and not may("POST", "/api/suppressions")
    assert not may("POST", "/api/suppressions/s1/remove")
    assert not may("GET", "/api/export/suppressions.csv")
    assert may("GET", "/api/email-records") and may("GET", "/api/limits")
    assert may("GET", "/api/prospects/p1") and may("POST", "/api/prospects/p1/deal")


def test_every_route_the_agent_may_call_has_plain_words():
    for method, pattern in agent_policy.AGENT_ROUTES:
        assert any(p == pattern for p, _ in agent_policy.ROUTE_WORDS), pattern


def test_a_broken_log_or_switch_never_breaks_or_opens_a_request():
    sent = []

    async def app(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": []})

    async def boom(*a):
        raise RuntimeError("database is locked")

    async def send(message):
        sent.append(message)

    scope = {"type": "http", "method": "GET", "path": "/api/stats", "state": {"principal": "agent"}}
    run(agent_policy.AgentPolicy(app, record=boom)(scope, None, send))
    assert sent[0]["status"] == 200                    # the log failing costs nothing
    sent.clear()
    run(agent_policy.AgentPolicy(app, is_off=boom)(scope, None, send))
    assert sent[0]["status"] == 403                    # can't read the switch: closed


# ── One person ──

def test_one_persons_page_has_the_deal_and_everything_that_happened(client):  # noqa: F811
    pid = _person(client)
    state = StateManager(str(client.db_path))
    _sql(client.db_path, "INSERT INTO outbox (id, prospect_id, step, subject, body, status, sent_at) "
                         "VALUES ('o1', ?, 1, 'Your roof', 'Hello Avery', 'sent', '2026-03-01T10:00:00')", (pid,))
    _sql(client.db_path, "INSERT INTO conversations (id, prospect_id, thread_json) VALUES ('c1', ?, ?)",
         (pid, '[{"sender": "prospect", "content": "Tell me more", "timestamp": "2026-03-02T09:00:00"}]'))
    run(state.add_consent(phone="+13035550119", channel="sms", status="granted", prospect_id=pid,
                          source="form", evidence="Ticked the box"))
    run(state.set_stage(pid, "proposal", by="you", reason="sent the quote", manual=True))
    run(state.add_suppression("address", "avery@example.com", "opted_out", source="handler"))

    assert client.post(f"/api/prospects/{pid}/deal", json={"value": "4500", "next_step": " Call Friday "}).json()["deal"] == \
        {"value": 4500, "next_step": "Call Friday", "notes": ""}
    assert client.post(f"/api/prospects/{pid}/deal", json={"notes": "Wants metal"}).json()["deal"]["value"] == 4500

    data = client.get(f"/api/prospects/{pid}").json()
    assert data["person"]["deal_value"] == 4500 and data["person"]["deal_notes"] == "Wants metal"
    assert [e["subject"] for e in data["emails"]] == ["Your roof"]
    assert data["conversations"][0]["thread"][0]["content"] == "Tell me more"
    assert data["consents"][0]["status"] == "granted" and data["consents"][0]["evidence"] == "Ticked the box"
    assert data["stage_events"][-1]["to_stage"] == "proposal"
    assert data["suppressed"] == "opted_out" and data["phone_blocked"] == ""


def test_a_deal_refuses_nonsense_and_nobody(client):  # noqa: F811
    pid = _person(client)
    assert client.post(f"/api/prospects/{pid}/deal", json={"value": "lots"}).status_code == 400
    assert client.post(f"/api/prospects/{pid}/deal", json={"value": -5}).status_code == 400
    assert client.post(f"/api/prospects/{pid}/deal", json={}).status_code == 400
    assert client.post("/api/prospects/nobody/deal", json={"value": 1}).status_code == 404
    assert client.get("/api/prospects/nobody").status_code == 404


def test_the_agent_can_read_a_person_and_change_the_deal(client, agent):  # noqa: F811
    pid = _person(client)
    assert agent.post(f"/api/prospects/{pid}/deal", json={"next_step": "Send the quote"}).json()["success"] is True
    assert agent.get(f"/api/prospects/{pid}").json()["person"]["next_step"] == "Send the quote"


# ── Import ──

CSV = """Email,First Name,Last Name,Job Title,Company,Mobile,agreed_to_texts
Pat@Example.com,Pat,Lee,Owner,Example Plumbing,303-555-0100,yes
pat@example.com,Pat,Lee,Owner,Example Plumbing,,
not-an-address,Sam,,,,,
gone@example.net,Gone,Away,,,,
dead@example.org,Dee,Dead,,,,
,No,Email,,,,
"""


def test_reading_a_list_keeps_each_address_once_and_says_what_it_left_out():
    people, problems = importer.read_rows("﻿" + CSV)
    assert [p["email"] for p in people] == ["pat@example.com", "gone@example.net", "dead@example.org"]
    assert people[0] == {"email": "pat@example.com", "first_name": "Pat", "last_name": "Lee", "title": "Owner",
                         "company": "Example Plumbing", "phone": "303-555-0100", "linkedin_url": ""}
    assert problems == ["Row 4: not an email address."]
    assert importer.read_rows("name,phone\nPat,1\n")[1][0].startswith("No email column")
    assert importer.read_rows("email,name\nkit@example.com,Kit Van Dyke\n")[0][0]["last_name"] == "Van Dyke"


def test_an_import_checks_addresses_skips_the_never_email_list_and_emails_nobody(tmp_path):
    state = StateManager(str(tmp_path / "sellbird.db"))
    run(state.init_db())
    run(state.add_suppression("address", "gone@example.net", "bounced", source="handler"))
    people, _ = importer.read_rows(CSV)

    async def check(email):
        return "invalid" if email.startswith("dead") else "verified"

    dry = run(importer.import_people(state, people, check=check, dry_run=True))
    assert dry["added"] == 2 and run(state.get_prospect_by_email("pat@example.com")) is None

    counts = run(importer.import_people(state, people, check=check))
    assert counts == {"added": 1, "already_here": 0, "never_email": 1, "invalid": 1,
                      "verified": 1, "risky": 0, "guess": 0}
    pat = run(state.get_prospect_by_email("pat@example.com"))
    assert (pat.email_status, pat.source, pat.company) == ("verified", "import", "Example Plumbing")
    with sqlite3.connect(state.db_path) as conn:
        assert conn.execute("SELECT lead_source, stage FROM prospects").fetchall() == [("import", "new")]
        assert conn.execute("SELECT COUNT(*) FROM outbox").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM consents").fetchone()[0] == 0     # a column is never a yes

    again = run(importer.import_people(state, people, check=check))
    assert again["added"] == 0 and again["already_here"] == 1


def test_an_unchecked_import_is_all_guesses_which_are_never_sent_to(tmp_path):
    state = StateManager(str(tmp_path / "sellbird.db"))
    run(state.init_db())
    counts = run(importer.import_people(state, [{"email": "kit@example.com", "first_name": "Kit", "last_name": "",
                                                  "title": "", "company": "", "phone": "", "linkedin_url": ""}]))
    assert counts["guess"] == 1
    assert run(state.get_prospect_by_email("kit@example.com")).email_status == "guess"
