"""The consent check for calls and texts, and texts through your own Twilio.

No test here talks to Twilio: FakeTwilio records what would have been sent."""

import asyncio
import sqlite3
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from tests.test_dashboard_signals import client  # noqa: F401  (fixture)
from sellbird import consent, texting
from sellbird.config import TextingConfig
from sellbird.integrations import twilio
from sellbird.state import StateManager

PHONE = "+13035550119"
NOON = datetime(2026, 3, 10, 18, 0, tzinfo=timezone.utc)      # midday in Denver
NIGHT = datetime(2026, 3, 10, 5, 0, tzinfo=timezone.utc)      # 23:00 the evening before in Denver


def run(coro):
    return asyncio.run(coro)


def _config(**texting_fields):
    return SimpleNamespace(
        texting=TextingConfig(enabled=True, **texting_fields),
        usage=SimpleNamespace(quiet_hours=SimpleNamespace(timezone="America/Denver")))


class FakeTwilio:
    def __init__(self, inbound=(), fail=False):
        self.sent, self.inbound, self.fail = [], list(inbound), fail

    async def send(self, to, body):
        if self.fail:
            raise twilio.TwilioError("Twilio answered 400: not a mobile number")
        self.sent.append((to, body))
        return {"sid": f"SM{len(self.sent)}", "status": "queued"}

    async def inbound_since(self, since=None, limit=50):
        return list(self.inbound)


@pytest.fixture
def state(tmp_path):
    sm = StateManager(str(tmp_path / "sellbird.db"))
    run(sm.init_db())
    with sqlite3.connect(sm.db_path) as conn:
        conn.execute("INSERT INTO prospects (id, first_name, email, phone, status, timezone) "
                     "VALUES ('p1', 'Avery', 'avery@example.com', '(303) 555-0119', 'contacted', 'America/Denver')")
    return sm


def _yes(state, channel="sms", phone=PHONE):
    run(state.add_consent(phone=phone, channel=channel, status="granted", prospect_id="p1",
                          source="form", evidence="Ticked the box on the quote form"))


def _check(state, channel="sms", now=NOON, **kw):
    return run(consent.check(state, _config(), channel=channel, phone=kw.pop("phone", PHONE),
                             prospect_id=kw.pop("prospect_id", "p1"), now=now))


# ── The gate ──

def test_phone_numbers_and_stop_words():
    assert consent.normalise_phone("(303) 555-0119") == PHONE == consent.normalise_phone("1-303-555-0119")
    assert consent.normalise_phone("+44 20 7946 0958") == "+442079460958"
    assert consent.normalise_phone("020 7946 0958", "44") == "+442079460958"
    assert consent.normalise_phone("555-0119") == "" and consent.normalise_phone("call me") == ""
    for text in ("STOP", "Stop.", "stop please", "UNSUBSCRIBE", "opt out", "Quit"):
        assert consent.is_stop(text), text
    for text in ("don't stop", "Sure, Saturday works", "", "can you stop by at 3"):
        assert not consent.is_stop(text), text


def test_no_stored_yes_means_no_first_text(state):
    decision = _check(state)
    assert not decision.allowed and decision.code == consent.NO_CONSENT and not decision.retry
    assert "never sends a first text" in decision.reason
    _yes(state)
    assert _check(state).allowed


def test_a_yes_to_texts_is_not_a_yes_to_calls(state):
    _yes(state, "sms")
    assert _check(state, "sms").allowed
    assert _check(state, "call").code == consent.NO_CONSENT
    _yes(state, "call")
    assert _check(state, "call").allowed
    assert _check(state, "fax").code == "bad_channel"


def test_the_newest_record_wins_and_taking_it_back_blocks(state):
    _yes(state)
    run(state.add_consent(phone=PHONE, channel="sms", status="revoked", evidence="asked us to stop"))
    decision = _check(state)
    assert decision.code == consent.NO_CONSENT and "took back" in decision.reason
    assert [c["status"] for c in run(state.get_consents())] == ["revoked", "granted"]   # nothing is edited


def test_quiet_hours_use_their_clock_and_only_delay(state):
    _yes(state)
    late = _check(state, now=NIGHT)
    assert not late.allowed and late.code == consent.QUIET_HOURS and late.retry
    assert _check(state, now=NOON).allowed
    # Unknown zone: the operator's clock is used.
    with sqlite3.connect(state.db_path) as conn:
        conn.execute("UPDATE prospects SET timezone = ''")
    assert _check(state, now=NIGHT).code == consent.QUIET_HOURS


def test_do_not_contact_and_email_opt_out_beat_a_yes(state):
    _yes(state); _yes(state, "call")
    run(state.block_phone(PHONE, reason="manual", source="you"))
    assert _check(state).code == consent.DO_NOT_CONTACT and _check(state, "call").code == consent.DO_NOT_CONTACT
    assert run(state.unblock_phone(PHONE)) is True
    assert _check(state).allowed
    run(state.update_prospect_status("p1", "opted_out"))
    assert _check(state).code == consent.OPTED_OUT
    assert _check(state, phone="not a number").code == consent.NO_NUMBER


# ── Texts ──

def test_a_text_cannot_even_be_drafted_without_a_yes(state):
    refused = run(texting.draft(state, _config(), prospect_id="p1", body="Hi Avery, 9:30 Saturday works."))
    assert not refused["success"] and refused["code"] == consent.NO_CONSENT
    _yes(state)
    drafted = run(texting.draft(state, _config(), prospect_id="p1", body="Hi Avery,\n 9:30 Saturday works.", by="agent"))
    assert drafted["success"] and drafted["status"] == "pending_review"
    queued = run(state.get_texts())[0]
    assert (queued["phone"], queued["body"], queued["drafted_by"]) == (PHONE, "Hi Avery, 9:30 Saturday works.", "agent")
    assert not run(texting.draft(state, _config(), prospect_id="p1", body="x" * 700))["success"]
    assert not run(texting.draft(state, _config(), prospect_id="p1", body="  "))["success"]


def test_nothing_sends_until_a_person_approves(state):
    _yes(state)
    text_id = run(texting.draft(state, _config(), prospect_id="p1", body="9:30 Saturday works."))["id"]
    fake = FakeTwilio()
    assert run(texting.send_approved(state, _config(), client=fake, now=NOON))["sent"] == 0
    assert fake.sent == []
    assert run(state.set_text_status(text_id, "approved", only_from=("pending_review",)))
    report = run(texting.send_approved(state, _config(), client=fake, now=NOON))
    assert report["sent"] == 1
    assert fake.sent == [(PHONE, "9:30 Saturday works. Reply STOP to opt out.")]   # the first text says how to stop
    assert run(state.get_text(text_id))["status"] == "sent"
    assert run(texting.send_approved(state, _config(), client=fake, now=NOON))["sent"] == 0   # never twice
    second = run(texting.draft(state, _config(), prospect_id="p1", body="See you then."))["id"]
    run(state.set_text_status(second, "approved", only_from=("pending_review",)))
    run(texting.send_approved(state, _config(), client=fake, now=NOON))
    assert fake.sent[-1] == (PHONE, "See you then.")


def test_an_approved_text_waits_out_quiet_hours_and_is_held_after_a_stop(state):
    _yes(state)
    text_id = run(texting.draft(state, _config(), prospect_id="p1", body="9:30 Saturday works."))["id"]
    run(state.set_text_status(text_id, "approved", only_from=("pending_review",)))
    fake = FakeTwilio()
    assert run(texting.send_approved(state, _config(), client=fake, now=NIGHT)) == {
        "sent": 0, "blocked": 0, "waiting": 1, "failed": 0}
    assert run(state.get_text(text_id))["status"] == "approved"           # still queued for the morning
    run(state.block_phone(PHONE, reason="opted_out", source="reply STOP"))   # STOP arrives overnight
    assert run(texting.send_approved(state, _config(), client=fake, now=NOON))["blocked"] == 1
    held = run(state.get_text(text_id))
    assert held["status"] == "blocked" and "STOP" in held["error"] and fake.sent == []


def test_texting_off_or_not_connected_sends_nothing(state, monkeypatch):
    _yes(state)
    text_id = run(texting.draft(state, _config(), prospect_id="p1", body="Hello"))["id"]
    run(state.set_text_status(text_id, "approved", only_from=("pending_review",)))
    off = SimpleNamespace(texting=TextingConfig(enabled=False), usage=_config().usage)
    fake = FakeTwilio()
    assert run(texting.send_approved(state, off, client=fake, now=NOON))["sent"] == 0 and fake.sent == []
    for key in ("TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER", "TWILIO_MESSAGING_SERVICE_SID"):
        monkeypatch.delenv(key, raising=False)
    assert run(texting.send_approved(state, _config(), now=NOON))["waiting"] == 1
    assert twilio.TwilioClient.from_env({}) is None
    assert "TWILIO_ACCOUNT_SID" in twilio.connection_problem({})
    assert twilio.connection_problem({"TWILIO_ACCOUNT_SID": "ACx", "TWILIO_AUTH_TOKEN": "t"}).startswith("set TWILIO_FROM_NUMBER")
    assert twilio.connection_problem({"TWILIO_ACCOUNT_SID": "ACx", "TWILIO_AUTH_TOKEN": "t",
                                      "TWILIO_FROM_NUMBER": "+13035550100"}) == ""


def test_a_twilio_failure_is_recorded_not_retried_blindly(state):
    _yes(state)
    text_id = run(texting.draft(state, _config(), prospect_id="p1", body="Hello"))["id"]
    run(state.set_text_status(text_id, "approved", only_from=("pending_review",)))
    assert run(texting.send_approved(state, _config(), client=FakeTwilio(fail=True), now=NOON))["failed"] == 1
    failed = run(state.get_text(text_id))
    assert failed["status"] == "failed" and "not a mobile number" in failed["error"]


def test_stop_opts_the_number_out_and_cancels_what_was_queued(state):
    _yes(state); _yes(state, "call")
    text_id = run(texting.draft(state, _config(), prospect_id="p1", body="Hello"))["id"]
    inbound = [{"sid": "SMin1", "from": "+1 303 555 0119", "body": "Stop", "at": "2026-03-10T17:00:00"}]
    fake = FakeTwilio(inbound=inbound)
    assert run(texting.read_inbound(state, _config(), client=fake)) == {"received": 1, "opted_out": 1}
    assert run(state.get_text(text_id))["status"] == "cancelled"
    assert run(state.phone_blocked(PHONE)) == "opted_out"
    assert _check(state).code == consent.DO_NOT_CONTACT and _check(state, "call").code == consent.DO_NOT_CONTACT
    assert run(state.unblock_phone(PHONE)) is False                      # only they can undo a STOP
    assert run(texting.read_inbound(state, _config(), client=fake))["received"] == 0   # read once


def test_someone_who_texts_first_may_be_answered_unless_that_is_turned_off(state):
    stranger = "+17205550142"
    inbound = [{"sid": "SMin2", "from": stranger, "body": "Do you do Saturdays?", "at": "2026-03-10T17:00:00"}]
    run(texting.read_inbound(state, _config(reply_to_inbound=False), client=FakeTwilio(inbound=inbound)))
    assert run(consent.check(state, _config(), channel="sms", phone=stranger, now=NOON)).code == consent.NO_CONSENT
    inbound[0]["sid"] = "SMin3"
    run(texting.read_inbound(state, _config(), client=FakeTwilio(inbound=inbound)))
    assert run(consent.check(state, _config(), channel="sms", phone=stranger, now=NOON)).allowed
    record = run(state.current_consent(stranger, "sms"))
    assert record["source"] == "inbound_text" and "Do you do Saturdays?" in record["evidence"]
    assert run(consent.check(state, _config(), channel="call", phone=stranger, now=NOON)).code == consent.NO_CONSENT


def test_the_twilio_client_sends_a_form_post_with_basic_auth():
    calls = []

    class Http:
        async def request(self, method, url, auth=None, **kwargs):
            calls.append((method, url, auth, kwargs))
            return SimpleNamespace(status_code=201, json=lambda: {"sid": "SM123", "status": "queued"})

    tw = twilio.TwilioClient("ACtest", "token", from_number="+13035550100", http=Http())
    assert run(tw.send(PHONE, "Hello")) == {"sid": "SM123", "status": "queued"}
    method, url, auth, kwargs = calls[0]
    assert (method, auth) == ("POST", ("ACtest", "token"))
    assert url == "https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages.json"
    assert kwargs["data"] == {"To": PHONE, "Body": "Hello", "From": "+13035550100"}


# ── The dashboard and the agent ──

def _seed(client):
    run(StateManager(str(client.db_path)).init_db())
    with sqlite3.connect(client.db_path) as conn:
        conn.execute("INSERT INTO prospects (id, first_name, email, phone, status) "
                     "VALUES ('p1', 'Avery', 'avery@example.com', '303-555-0119', 'contacted')")


def test_recording_a_yes_needs_evidence_and_the_check_reports_why(client):
    _seed(client)
    assert client.post("/api/consent/check", json={"channel": "sms", "prospect_id": "p1"}).json()["code"] == "no_consent"
    assert client.post("/api/texts", json={"prospect_id": "p1", "body": "Hello"}).status_code == 409
    assert client.post("/api/consent", json={"prospect_id": "p1", "channel": "sms"}).status_code == 400
    ok = client.post("/api/consent", json={"prospect_id": "p1", "channel": "sms",
                                           "evidence": "Ticked the box on the quote form"}).json()
    assert ok == {"success": True, "phone": PHONE, "channel": "sms", "status": "granted"}
    drafted = client.post("/api/texts", json={"prospect_id": "p1", "body": "Hello"}).json()
    data = client.get("/api/texting").json()
    assert [t["id"] for t in data["pending"]] == [drafted["id"]]
    assert data["consents"][0]["first_name"] == "Avery" and data["enabled"] is False
    # Texting is off in a fresh config: approving queues it and sends nothing.
    approved = client.post(f"/api/texts/{drafted['id']}/approve").json()
    assert approved["status"] == "approved" and approved["report"]["sent"] == 0
    assert client.post(f"/api/texts/{drafted['id']}/approve").status_code == 409
    blocked = client.post("/api/phone-blocks", json={"phone": "303 555 0119"}).json()
    assert blocked["cancelled"] == 1
    assert client.post("/api/consent/check", json={"channel": "sms", "prospect_id": "p1"}).json()["code"] == "do_not_contact"
    assert client.post("/api/phone-blocks/remove", json={"phone": PHONE}).status_code == 200


def test_the_agent_may_draft_and_ask_but_never_approve_or_record_a_yes():
    from sellbird.agent_policy import agent_may
    assert agent_may("GET", "/api/texting") and agent_may("POST", "/api/texts")
    assert agent_may("POST", "/api/consent/check") and agent_may("POST", "/api/phone-blocks")
    assert not agent_may("POST", "/api/texts/t1/approve")
    assert not agent_may("POST", "/api/consent")
    assert not agent_may("POST", "/api/phone-blocks/remove")
