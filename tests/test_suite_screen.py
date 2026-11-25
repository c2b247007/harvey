"""Everything Sellbird does: every part of the suite with its state."""

from tests.test_dashboard_signals import client  # noqa: F401  (fixture)
from tests.test_suite_screens import agent  # noqa: F401  (fixture)


def test_every_part_has_a_state_and_hosted_parts_have_no_button(client):  # noqa: F811
    d = client.get("/api/suite").json()
    assert "error" not in d, d
    parts = [p for g in d["groups"] for p in g["parts"]]
    assert {g["name"] for g in d["groups"]} == {"Sending", "Outbound", "Inbound", "Meetings and pipeline"}
    assert all(p["state"] in ("on", "set", "off", "hosted") and p["label"] for p in parts)
    hosted = [p for p in parts if p["state"] == "hosted"]
    assert {p["name"] for p in hosted} == {"Phone line", "Hosted forms"} and all(not p["screen"] for p in hosted)
    assert d["total"] == len(parts) - len(hosted) and 0 <= d["on"] <= d["total"]
    # Stages and deals always work; social is off until a playbook is.
    by = {p["name"]: p for p in parts}
    assert by["Stages and deals"]["state"] == "on" and by["Social posts"]["state"] == "off"
    assert by["Brand mentions"]["state"] == "off"


def test_switching_a_feature_on_changes_its_state(client):  # noqa: F811
    client.post("/api/social/playbooks/finished_work", json={"active": True})
    client.post("/api/mentions/watches", json={"term": "Example Roofing"})
    parts = {p["name"]: p for g in client.get("/api/suite").json()["groups"] for p in g["parts"]}
    assert parts["Social posts"]["state"] == "on" and parts["Brand mentions"]["state"] == "on"


def test_the_agent_can_read_it(client, agent):  # noqa: F811
    assert agent.get("/api/suite").status_code == 200
