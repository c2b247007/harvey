"""Sequences of any length, stages and sources on every person, and bookings
that stop follow-ups."""

import asyncio
import sqlite3
from types import SimpleNamespace

import pytest

from tests.test_dashboard_signals import client  # noqa: F401  (fixture)
from sellbird import deals
from sellbird.agents.writer import Writer, follow_up_delay, sequence_shape
from sellbird.booking import said_they_booked
from sellbird.config import WriterConfig
from sellbird.email_style import BREAKUP_MAX_WORDS, FOLLOW_UP_MAX_WORDS, max_words
from sellbird.state import MEETING_BOOKED, StateManager


def run(coro):
    return asyncio.run(coro)


def _sql(db, query, params=()):
    with sqlite3.connect(db) as conn:
        rows = conn.execute(query, params).fetchall()
    conn.close()
    return rows


@pytest.fixture
def state(tmp_path):
    sm = StateManager(str(tmp_path / "sellbird.db"))
    run(sm.init_db())
    for pid, company in (("p1", "co1"), ("p2", "co1"), ("p3", "co2")):
        _sql(sm.db_path, "INSERT INTO prospects (id, company_id, first_name, email, company, status) "
             "VALUES (?, ?, 'Avery', ?, 'Acme', 'contacted')", (pid, company, f"{pid}@example.com"))
    return sm


# ── Sequence length ──

def test_a_sequence_has_no_fixed_length():
    assert WriterConfig().sequence_length == 3
    assert WriterConfig(sequence_length=9).sequence_length == 9      # no upper limit
    with pytest.raises(Exception):
        WriterConfig(sequence_length=0)
    for length in (1, 2, 3, 7):
        shape = sequence_shape(length)
        assert [f"Email {n}:" in shape for n in range(1, length + 2)] == [True] * length + [False]
    # Only the last of three or more is the short closing email.
    assert "Close the loop" not in sequence_shape(2)
    assert sequence_shape(7).count("Close the loop") == 1
    assert "Email 7: 4 days after that. Close the loop" in sequence_shape(7)
    assert [follow_up_delay(n) for n in (1, 2, 3, 6)] == [0, 3, 4, 4]


def test_the_writer_keeps_as_many_steps_as_were_asked_for():
    writer = Writer.__new__(Writer)
    writer.config = SimpleNamespace(writer=WriterConfig(sequence_length=6))
    assert writer._sequence_length() == 6
    drafts = [{"subject": f"s{n}", "body": f"b{n}"} for n in range(1, 9)]
    steps = writer._parse_sequence(drafts, 6)
    assert [s.step for s in steps] == [1, 2, 3, 4, 5, 6]            # more than five is fine
    assert [s.delay_days for s in steps] == [0, 3, 4, 4, 4, 4]
    assert len(writer._parse_sequence(drafts, 2)) == 2               # and no longer than asked
    assert len(writer._parse_sequence(drafts[:1], 1)) == 1


def test_word_caps_follow_the_position_not_a_fixed_step_three():
    assert max_words(3) == BREAKUP_MAX_WORDS                         # the old reading still holds
    assert max_words(3, last=False) == FOLLOW_UP_MAX_WORDS           # a middle email of a longer sequence
    assert max_words(6, last=True) == BREAKUP_MAX_WORDS
    assert max_words(2, last=True) == FOLLOW_UP_MAX_WORDS            # two emails: no short closer


# ── Stages and source ──

def test_everyone_has_a_stage_and_a_source(state):
    rows = _sql(state.db_path, "SELECT stage, lead_source FROM prospects")
    assert set(rows) == {("new", "cold_email")}
    assert deals.clean_stage("Meeting booked") == "meeting_booked" and deals.clean_stage("nope") == ""
    assert deals.clean_source("") == "cold_email" and deals.clean_source("Fax") == "other"
    assert run(state.set_lead_source("p3", "import")) == "import"
    assert run(state.count_by_stage_and_source())["sources"] == {"cold_email": 2, "import": 1}


def test_sellbird_moves_people_forward_and_never_back(state):
    run(state.update_prospect_status("p1", "replied"))
    assert _sql(state.db_path, "SELECT stage FROM prospects WHERE id = 'p1'") == [("talking",)]
    assert run(state.set_stage("p1", "new")) is None                 # not backwards
    assert run(state.set_stage("p1", "won")) is None                 # Sellbird never claims a win
    assert run(state.set_stage("p1", "proposal")) is None
    change = run(state.set_stage("p1", "proposal", by="you", reason="sent the quote", manual=True))
    assert (change["from"], change["to"], change["by"]) == ("talking", "proposal", "you")
    run(state.set_stage("p1", "won", by="agent", manual=True))
    run(state.update_prospect_status("p1", "not_interested"))        # a late "no" does not undo a win
    assert _sql(state.db_path, "SELECT stage FROM prospects WHERE id = 'p1'") == [("won",)]
    history = run(state.get_stage_events("p1"))
    assert [(e["from_stage"], e["to_stage"], e["changed_by"]) for e in history] == [
        ("proposal", "won", "agent"), ("talking", "proposal", "you"), ("new", "talking", "sellbird")]


def test_an_opt_out_is_lost_and_undoing_it_is_talking(state):
    run(state.update_prospect_status("p2", "opted_out"))
    assert _sql(state.db_path, "SELECT stage FROM prospects WHERE id = 'p2'") == [("lost",)]
    assert run(state.undo_opt_out("p2")) is True
    assert _sql(state.db_path, "SELECT stage, status FROM prospects WHERE id = 'p2'") == [("talking", "replied")]


# ── Bookings stop follow-ups ──

def _queue(state, oid, pid, status="approved", kind="sequence", step=2):
    _sql(state.db_path, "INSERT INTO outbox (id, campaign_id, prospect_id, step, kind, to_email, status) "
         "VALUES (?, 'c1', ?, ?, ?, 'a@example.com', ?)", (oid, pid, step, kind, status))


def test_a_booking_stops_follow_ups_for_them_and_their_colleagues(state):
    _queue(state, "o1", "p1"); _queue(state, "o2", "p1", status="pending_review", step=3)
    _queue(state, "o3", "p2"); _queue(state, "o4", "p3")
    meeting = run(state.record_booking("p1", starts_at="2026-03-10T15:00:00", note="intro call"))
    assert meeting["cancelled"] == 3 and meeting["stage_change"]["to"] == "meeting_booked"
    rows = dict(_sql(state.db_path, "SELECT id, status FROM outbox"))
    assert rows == {"o1": "cancelled", "o2": "cancelled", "o3": "cancelled", "o4": "approved"}
    assert _sql(state.db_path, "SELECT error FROM outbox WHERE id = 'o1'") == [(MEETING_BOOKED,)]
    assert _sql(state.db_path, "SELECT status, stage FROM prospects WHERE id = 'p1'") == [("meeting", "meeting_booked")]
    # A later reply does not un-book them, so the sender still leaves them alone.
    run(state.update_prospect_status("p1", "replied"))
    assert _sql(state.db_path, "SELECT status FROM prospects WHERE id = 'p1'") == [("meeting",)]
    assert [m["starts_at"] for m in run(state.get_meetings())] == ["2026-03-10T15:00:00"]


def test_no_meeting_is_recorded_for_someone_who_opted_out(state):
    run(state.update_prospect_status("p1", "opted_out"))
    assert run(state.record_booking("p1")) is None
    assert run(state.record_booking("nobody")) is None
    assert _sql(state.db_path, "SELECT COUNT(*) FROM meetings") == [(0,)]


def test_only_a_reply_that_says_it_is_booked_counts():
    for text in ("I booked a time for Thursday.", "Just booked, thanks", "We've scheduled a call for the 3rd",
                 "I have already picked a slot", "See you on Tuesday"):
        assert said_they_booked(text), text
    for text in ("Can we schedule a call?", "I haven't booked yet", "Please book me in", "not interested",
                 "I couldn't book a slot, the page was down", ""):
        assert not said_they_booked(text), text


# ── The dashboard and the agent ──

def _seed(client):
    run(StateManager(str(client.db_path)).init_db())
    _sql(client.db_path, "INSERT INTO prospects (id, first_name, email, company, status) "
         "VALUES ('p1', 'Avery', 'avery@example.com', 'Acme', 'contacted')")
    _sql(client.db_path, "INSERT INTO outbox (id, campaign_id, prospect_id, step, to_email, status) "
         "VALUES ('o1', 'c1', 'p1', 2, 'avery@example.com', 'approved')")


def test_the_pipeline_route_names_stages_sources_and_what_stops_a_sequence(client):
    _seed(client)
    data = client.get("/api/pipeline").json()
    assert data["stage_order"] == list(deals.STAGES)
    assert data["stages"]["new"] == 1 and data["sources"] == {"cold_email": 1}
    assert data["sequence_length"] >= 1
    assert data["stops_on"] == ["a reply", "a booked meeting", "an opt-out"]
    assert client.get("/api/prospects").json()[0]["stage"] == "new"


def test_moving_a_stage_and_recording_a_meeting_from_the_dashboard(client):
    _seed(client)
    assert client.post("/api/prospects/p1/stage", json={"stage": "galaxy"}).status_code == 400
    assert client.post("/api/prospects/nobody/stage", json={"stage": "won"}).status_code == 404
    moved = client.post("/api/prospects/p1/stage", json={"stage": "Proposal", "reason": "sent the quote"}).json()
    assert moved["changed"] and moved["change"]["by"] == "you"
    assert client.post("/api/prospects/p1/meeting", json={"starts_at": "next week"}).status_code == 400
    met = client.post("/api/prospects/p1/meeting", json={"starts_at": "2026-03-10T15:00"}).json()
    assert met["meeting"]["cancelled"] == 1
    assert _sql(client.db_path, "SELECT status FROM outbox WHERE id = 'o1'") == [("cancelled",)]
    history = client.get("/api/prospects/p1/stage").json()
    assert history["stage"] == "meeting_booked"
    assert [e["to_stage"] for e in history["history"]] == ["meeting_booked", "proposal"]
    cal = client.get("/api/calendar?start=2026-03-10&days=1").json()
    assert cal["meetings"][0]["day"] == "2026-03-10" and cal["meetings"][0]["first_name"] == "Avery"


def test_the_agent_may_move_stages_and_record_bookings_but_not_more():
    from sellbird.agent_policy import agent_may
    assert agent_may("GET", "/api/pipeline") and agent_may("GET", "/api/calendar")
    assert agent_may("POST", "/api/prospects/p1/stage") and agent_may("POST", "/api/prospects/p1/meeting")
    assert not agent_may("POST", "/api/outbox/o1/approve")
    assert not agent_may("POST", "/api/prospects/p1/opt-out/undo")
