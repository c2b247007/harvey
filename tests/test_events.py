"""Signed events for every reply, new lead, booking and stage change."""

import asyncio
import json
import sqlite3

import pytest

from tests.test_dashboard_signals import client  # noqa: F401  (fixture)
from sellbird import events
from sellbird.config import WebhookConfig
from sellbird.models.prospect import Prospect
from sellbird.state import StateManager

SECRET = "s3cret-for-tests-only"
URL = "https://hooks.example.com/sellbird"


def run(coro):
    return asyncio.run(coro)


class FakeResponse:
    def __init__(self, status):
        self.status_code = status


class FakeClient:
    """Stands in for httpx: records each POST and answers from a script."""

    def __init__(self, answers=(200,)):
        self.answers = list(answers)
        self.calls = []

    async def post(self, url, content=None, headers=None):
        self.calls.append({"url": url, "body": content, "headers": headers})
        answer = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
        if isinstance(answer, Exception):
            raise answer
        return FakeResponse(answer)


@pytest.fixture
def state(tmp_path, monkeypatch):
    monkeypatch.setenv("SELLBIRD_WEBHOOK_SECRET", SECRET)
    sm = StateManager(str(tmp_path / "sellbird.db"))
    run(sm.init_db())
    return sm


def _config(*endpoints):
    from types import SimpleNamespace
    return SimpleNamespace(webhooks=list(endpoints) or [WebhookConfig(url=URL)])


def _add(state, pid="p1", email="avery@example.com"):
    return run(state.add_prospect(Prospect(id=pid, first_name="Avery", last_name="Example",
                                           email=email, company="Acme", source="company_website")))


# ── Signing ──

def test_a_signature_verifies_and_a_changed_body_secret_or_old_time_does_not():
    body = b'{"id":"evt_1"}'
    header = events.sign(SECRET, body, timestamp=1_800_000_000)
    assert header.startswith("t=1800000000,v1=") and len(header.split("v1=")[1]) == 64
    assert events.verify_signature(SECRET, body, header, now=1_800_000_100)
    assert not events.verify_signature(SECRET, body + b" ", header, now=1_800_000_100)
    assert not events.verify_signature("other", body, header, now=1_800_000_100)
    assert not events.verify_signature(SECRET, body, header, now=1_800_000_000 + 301)   # replayed later
    assert not events.verify_signature(SECRET, body, "garbage", now=1_800_000_100)


def test_an_endpoint_must_be_https_and_have_a_secret(monkeypatch):
    monkeypatch.setenv("SELLBIRD_WEBHOOK_SECRET", SECRET)
    assert events.endpoint_problem(WebhookConfig(url=URL)) == ""
    assert events.endpoint_problem(WebhookConfig(url="http://localhost:8080/hook")) == ""
    assert "https" in events.endpoint_problem(WebhookConfig(url="http://hooks.example.com/x"))
    assert "username" in events.endpoint_problem(WebhookConfig(url="https://user:pw@hooks.example.com/x"))
    assert "unknown events" in events.endpoint_problem(WebhookConfig(url=URL, events=["deal.exploded"]))
    monkeypatch.delenv("SELLBIRD_WEBHOOK_SECRET")
    assert "not set" in events.endpoint_problem(WebhookConfig(url=URL))
    shown = events.describe_endpoints(_config())[0]
    assert SECRET not in json.dumps(shown) and shown["host"] == "hooks.example.com"


# ── The four events ──

def test_each_of_the_four_things_writes_its_event(state):
    _add(state)
    assert _add(state) == "p1"                                   # a duplicate is not a new lead
    run(state.update_prospect_status("p1", "replied"))           # stage: new -> talking
    run(state.record_booking("p1", starts_at="2026-03-10T15:00:00"))
    run(state.record_event("reply.received", {"person": run(state.person_for_event("p1")), "intent": "interested"}))
    found = run(state.get_events())
    assert sorted(e["type"] for e in found) == [
        "lead.created", "meeting.booked", "reply.received", "stage.changed", "stage.changed"]
    by_type = {e["type"]: e for e in found}
    assert by_type["lead.created"]["data"]["person"]["email"] == "avery@example.com"
    assert by_type["lead.created"]["data"]["person"]["source"] == "cold_email"
    assert by_type["meeting.booked"]["data"]["meeting"]["starts_at"] == "2026-03-10T15:00:00"
    changes = [(e["data"]["from"], e["data"]["to"]) for e in found if e["type"] == "stage.changed"]
    assert sorted(changes) == [("new", "talking"), ("talking", "meeting_booked")]
    assert all(e["id"].startswith("evt_") for e in found)


def test_the_handler_records_a_reply_event():
    src = __import__("pathlib").Path(events.__file__).parent.joinpath("agents", "handler.py").read_text(encoding="utf-8")
    assert 'record_event("reply.received"' in src


# ── Delivery ──

def test_events_are_delivered_signed_once_and_only_after_the_endpoint_was_added(state):
    _add(state, "p0", "early@example.com")                       # before anyone listened
    config, http = _config(), FakeClient()
    assert run(events.deliver_pending(config, state, client=http))["delivered"] == 0
    _add(state)
    report = run(events.deliver_pending(config, state, client=http))
    assert report == {"delivered": 1, "failed": 0, "skipped": 0}
    call = http.calls[0]
    assert call["url"] == URL and call["headers"]["Sellbird-Event"] == "lead.created"
    assert events.verify_signature(SECRET, call["body"], call["headers"][events.SIGNATURE_HEADER])
    sent = json.loads(call["body"])
    assert sent["type"] == "lead.created" and sent["api_version"] == events.API_VERSION
    assert sent["data"]["person"]["email"] == "avery@example.com"
    assert sent["id"] == call["headers"]["Sellbird-Delivery"]
    assert run(events.deliver_pending(config, state, client=http))["delivered"] == 0   # never twice
    assert len(http.calls) == 1


def test_a_failing_endpoint_is_retried_later_and_given_up_on_in_the_end(state):
    config = _config()
    run(events.deliver_pending(config, state, client=FakeClient()))     # the endpoint is now known
    _add(state)
    http = FakeClient([500, ConnectionError("down"), 200])
    assert run(events.deliver_pending(config, state, client=http)) == {"delivered": 0, "failed": 1, "skipped": 0}
    assert run(events.deliver_pending(config, state, client=http))["failed"] == 0      # not due yet
    with sqlite3.connect(state.db_path) as conn:
        assert conn.execute("SELECT status, attempts, response_status FROM event_deliveries").fetchall() == [("retrying", 1, 500)]
        conn.execute("UPDATE event_deliveries SET next_attempt_at = '2000-01-01T00:00:00'")
    assert run(events.deliver_pending(config, state, client=http))["failed"] == 1      # no answer at all
    with sqlite3.connect(state.db_path) as conn:
        conn.execute("UPDATE event_deliveries SET next_attempt_at = '2000-01-01T00:00:00'")
    assert run(events.deliver_pending(config, state, client=http))["delivered"] == 1
    assert events.next_attempt_after(events.MAX_ATTEMPTS) is None
    assert events.next_attempt_after(1) is not None


def test_an_endpoint_only_hears_the_events_it_asked_for_and_none_without_a_secret(state, monkeypatch):
    monkeypatch.setenv("OTHER_SECRET", "another-secret")
    picky = WebhookConfig(url="https://crm.example.com/in", secret_env="OTHER_SECRET", events=["meeting.booked"])
    unsigned = WebhookConfig(url="https://nosecret.example.com/in", secret_env="MISSING_SECRET")
    config, http = _config(picky, unsigned), FakeClient()
    run(events.deliver_pending(config, state, client=http))
    _add(state)
    run(state.record_booking("p1"))
    report = run(events.deliver_pending(config, state, client=http))
    assert report["delivered"] == 1 and report["skipped"] == 1
    assert [c["headers"]["Sellbird-Event"] for c in http.calls] == ["meeting.booked"]
    assert all("nosecret" not in c["url"] for c in http.calls)


def test_nothing_is_sent_when_no_endpoint_is_set(state):
    from types import SimpleNamespace
    _add(state)
    http = FakeClient()
    assert run(events.deliver_pending(SimpleNamespace(webhooks=[]), state, client=http)) == {
        "delivered": 0, "failed": 0, "skipped": 0}
    assert http.calls == [] and len(run(state.get_events())) == 1   # still recorded


# ── The dashboard and the agent ──

def test_the_events_route_lists_types_endpoints_and_events_without_secrets(client):
    run(StateManager(str(client.db_path)).init_db())
    with sqlite3.connect(client.db_path) as conn:
        conn.execute("INSERT INTO prospects (id, first_name, email, status) VALUES ('p1', 'Avery', 'avery@example.com', 'contacted')")
    assert client.post("/api/prospects/p1/stage", json={"stage": "proposal"}).status_code == 200
    data = client.get("/api/events").json()
    assert data["types"] == list(events.EVENT_TYPES) and data["signature_header"] == "Sellbird-Signature"
    assert [e["type"] for e in data["events"]] == ["stage.changed"]
    assert data["events"][0]["data"]["to"] == "proposal" and data["events"][0]["data"]["by"] == "you"
    assert client.post("/api/events/test").status_code == 409        # no endpoint configured


def test_the_agent_may_read_events_but_not_send_tests():
    from sellbird.agent_policy import agent_may
    assert agent_may("GET", "/api/events")
    assert not agent_may("POST", "/api/events/test")
