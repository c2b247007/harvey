"""/api/agent/report: the answer line, the agent chip and the "What [agent]
did" log. Every line must come from a record, and "agent" or "you" from who
wrote it. Every name here is made up."""

import asyncio
import json
import sqlite3
from datetime import datetime, timedelta, timezone

import sellbird.dashboard as dash
from sellbird.state import StateManager
from tests.test_dashboard_signals import client  # noqa: F401  (fixture)


def _ts(minutes_ago=0, seconds=0):
    t = datetime.now(timezone.utc) - timedelta(minutes=minutes_ago, seconds=seconds)
    return t.strftime("%Y-%m-%d %H:%M:%S")


def _sql(db, query, params=()):
    conn = sqlite3.connect(db)
    with conn:
        conn.execute(query, params)
    conn.close()


def _action(db, kind, agent, when, details=None):
    _sql(db, "INSERT INTO actions (action_type, agent, details_json, created_at) VALUES (?, ?, ?, ?)",
         (kind, agent, json.dumps(details or {}), when))


def test_who_did_it_comes_from_the_record(client, monkeypatch):  # noqa: F811
    asyncio.run(StateManager(str(client.db_path)).init_db())
    db = client.db_path
    _action(db, "write_campaign", "writer", _ts(30), {"campaign_name": "Example run", "prospect_count": 2})
    _action(db, "social_post_approved", "user", _ts(20))
    _action(db, "lead_added", "agent", _ts(10), {"via": "agent"})
    _action(db, "heartbeat", "main", _ts(5))
    # The agent's call for that lead, logged by its key too, and one only its key saw.
    _sql(db, "INSERT INTO agent_requests (method, path, status, created_at) VALUES ('POST', '/api/leads', 200, ?)",
         (_ts(10, 2),))
    _sql(db, "INSERT INTO agent_requests (method, path, status, created_at) VALUES ('POST', '/api/mentions/check', 200, ?)",
         (_ts(2),))
    _sql(db, "INSERT INTO agent_requests (method, path, status, created_at) VALUES ('POST', '/api/sending/resume', 403, ?)",
         (_ts(1),))
    _sql(db, "INSERT INTO agent_requests (method, path, status, created_at) VALUES ('GET', '/api/today', 200, ?)",
         (_ts(0),))
    monkeypatch.setattr(dash, "_check_sellbird_pid", lambda: None)

    r = client.get("/api/agent/report").json()
    kinds = [(e["who"], e["action_type"]) for e in r["log"]]
    assert ("you", "social_post_approved") in kinds
    assert ("agent", "write_campaign") in kinds and ("agent", "lead_added") in kinds
    assert all(k != "heartbeat" for _, k in kinds)                    # the loop's tick is not news
    calls = [e for e in r["log"] if e["action_type"] == "agent_call"]
    assert len(calls) == 1                                            # the lead call merged; refused and reads left out
    assert "mention" in calls[0]["details"]["what"].lower()
    assert [e for e in r["log"] if e["action_type"] == "write_campaign"][0]["via"] == "sellbird"
    assert r["chip"] == "connected"                                   # its key was used this week
    assert r["log"] == sorted(r["log"], key=lambda e: e["at"], reverse=True)


def test_the_day_counts_and_the_chip(client, monkeypatch):  # noqa: F811
    asyncio.run(StateManager(str(client.db_path)).init_db())
    db = client.db_path
    for i in range(3):
        _sql(db, "INSERT INTO prospects (id, created_at) VALUES (?, ?)", (f"p{i}", _ts(60)))
    _sql(db, "INSERT INTO prospects (id, created_at) VALUES ('old', ?)", (_ts(60 * 30),))
    _sql(db, "INSERT INTO outbox (id, status, created_at) VALUES ('o1', 'pending_review', ?)", (_ts(5),))
    _sql(db, "INSERT INTO outbox (id, status, created_at, sent_at) VALUES ('o2', 'sent', ?, ?)", (_ts(90), _ts(30)))
    monkeypatch.setattr(dash, "_check_sellbird_pid", lambda: None)

    r = client.get("/api/agent/report").json()
    assert r["day"] == {"found": 3, "written": 2, "sent": 1, "pending": 1}
    assert r["chip"] == "not_connected"                               # no key used, nothing running
    monkeypatch.setattr(dash, "_check_sellbird_pid", lambda: 4242)
    assert client.get("/api/agent/report").json()["chip"] == "working"
    client.post("/api/agent/access", json={"access": "off"})
    assert client.get("/api/agent/report").json()["chip"] == "off"


def test_the_name_follows_the_brain(client, monkeypatch, tmp_path):  # noqa: F811
    import yaml
    from sellbird.paths import PROJECT_ROOT
    asyncio.run(StateManager(str(client.db_path)).init_db())
    base = yaml.safe_load((PROJECT_ROOT / "sellbird.yaml").read_text(encoding="utf-8"))
    cfg = tmp_path / "sellbird.yaml"
    monkeypatch.setattr(dash, "_resolve_config_file", lambda: cfg)
    for provider, name in (("claude", "Claude"), ("codex", "Codex")):
        cfg.write_text(yaml.safe_dump({**base, "brain": {"provider": provider}}), encoding="utf-8")
        assert client.get("/api/agent/report").json()["name"] == name
    cfg.write_text("not: [valid", encoding="utf-8")
    assert client.get("/api/agent/report").json()["name"] == "Your agent"
