"""The recommended services: one link each, one disclosure, and the same
links in every place a person or an agent reads them."""

import re

import pytest

from sellbird import recommended as rec
from sellbird.integrations import trulyinbox as ti
from sellbird.paths import PROJECT_ROOT
from tests.test_dashboard_signals import client  # noqa: F401  (fixture)
from tests.test_suite_screens import agent  # noqa: F401  (fixture)

DOCS = ("README.md", "CLAUDE.md", ".env.example")


def _text(name):
    return (PROJECT_ROOT / name).read_text(encoding="utf-8")


def test_each_job_has_one_service_and_every_service_a_web_link():
    assert set(rec.JOBS) == {"warmup", "verify", "verify_catchall", "businesses", "people"}
    for name, entry in rec.JOBS.items():
        assert entry["service"] in rec.SERVICES, name
        assert entry["why"] and entry["label"], name
    for key, service in rec.SERVICES.items():
        assert service.url.startswith("https://"), key
    # Finding businesses and people is free first.
    assert rec.job("businesses")["free"] and rec.job("people")["free"]


def test_only_a_real_affiliate_link_is_called_one():
    assert rec.affiliates() == ["TrulyInbox"]
    assert rec.tag("trulyinbox") == "(affiliate link)" and rec.tag("hunter") == ""
    assert rec.tag_for_url(rec.link("trulyinbox")) == "(affiliate link)"
    assert rec.tag_for_url(rec.link("dataforseo")) == ""
    assert rec.DISCLOSURE == ("TrulyInbox links in this project are affiliate links: the maintainer may "
                              "earn a commission, at no extra cost to you.")


def test_the_disclosure_names_every_affiliate(monkeypatch):
    services = dict(rec.SERVICES)
    services["hunter"] = rec.Service("Hunter", "https://hunter.io/?ref=example", affiliate=True)
    services["dataforseo"] = rec.Service("DataForSEO", "https://dataforseo.com/?ref=example", affiliate=True)
    monkeypatch.setattr(rec, "SERVICES", services)
    assert rec.disclosure().startswith("TrulyInbox, Hunter and DataForSEO links in this project are affiliate links")
    monkeypatch.setattr(rec, "SERVICES", {"reoon": rec.SERVICES["reoon"]})
    assert rec.disclosure() == ""


def test_trulyinbox_and_discovery_take_their_links_from_here():
    from sellbird.collectors.discover import provider_menu
    assert ti.AFFILIATE_URL == rec.link("trulyinbox") and ti.AFFILIATE_TAG == rec.AFFILIATE_TAG
    menu = {m["key"]: m for m in provider_menu({})}
    dfs = [m for k, m in menu.items() if k.startswith("dataforseo")]
    assert dfs and all(m["signup_url"] == rec.link("dataforseo") for m in dfs)
    assert all(m["signup_tag"] == rec.tag("dataforseo") for m in dfs)


def test_no_source_file_but_this_one_spells_out_a_link():
    src = [p for p in (PROJECT_ROOT / "sellbird").rglob("*") if p.suffix in (".py", ".js", ".html")]
    for service in rec.SERVICES.values():
        holders = [p.name for p in src if service.url in p.read_text(encoding="utf-8")]
        assert holders == ["recommended.py"], (service.name, holders)


@pytest.mark.parametrize("name", DOCS)
def test_the_docs_carry_the_current_links_and_the_disclosure(name):
    text = _text(name)
    # CLAUDE.md is the agent's guidance: it tells the agent to say so itself, in chat.
    if rec.DISCLOSURE and name != "CLAUDE.md":
        assert rec.DISCLOSURE in text, name
    for key, service in rec.SERVICES.items():
        domain = re.sub(r"^https://(www\.|app\.)?", "", service.url).split("/")[0]
        # Wherever a doc points at the service's own site to sign up, it is this link.
        if service.affiliate:
            assert text.count(domain + "/") - text.count("dev." + domain) - text.count("api." + domain) \
                - text.count("lynx-api." + domain) == text.count(service.url), (name, key)
    if name != "CLAUDE.md":     # CLAUDE.md sends the agent to `sellbird recommended` instead
        for key in ("reoon", "zerobounce", "hunter", "dataforseo"):
            assert rec.link(key) in text, (name, key)


def test_claude_md_tells_the_agent_how_to_recommend():
    text = _text("CLAUDE.md")
    assert "sellbird recommended" in text and "(affiliate link)" in text
    assert "one service per job" in text


def test_today_suggests_how_to_find_people_and_never_blocks(client):  # noqa: F811
    setup = client.get("/api/setup-status").json()
    step = next(c for c in setup["checks"] if c["id"] == "find_sources")
    assert step["required"] is False and step["shown"] is True and step["done"] is False
    assert [j["name"] for j in step["recommend"]] == ["DataForSEO", "Hunter"]
    assert step["disclosure"] == rec.DISCLOSURE
    verifier = next(c for c in setup["checks"] if c["id"] == "verifier")
    assert [j["name"] for j in verifier["recommend"]] == ["Reoon"]
    assert client.post("/api/finding-choice").json()["success"]
    again = next(c for c in client.get("/api/setup-status").json()["checks"] if c["id"] == "find_sources")
    assert again["done"] is True


def test_the_agent_can_read_the_recommendations_but_not_choose_for_you(client, agent):  # noqa: F811
    listed = agent.get("/api/recommended").json()
    assert listed["jobs"]["people"]["url"] == rec.link("hunter") and listed["disclosure"] == rec.DISCLOSURE
    assert agent.post("/api/finding-choice").status_code == 403


def test_the_command_prints_each_job_once(capsys):
    from types import SimpleNamespace
    from sellbird.cli import cmd_recommended
    cmd_recommended(SimpleNamespace())
    out = capsys.readouterr().out
    for name in rec.JOBS:
        assert rec.JOBS[name]["label"] in out
    assert out.count("(affiliate link)") == len(rec.affiliates()) and rec.DISCLOSURE in out
