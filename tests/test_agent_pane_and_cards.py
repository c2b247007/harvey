"""The dashboard in the agent's browser pane (one-use sign-in codes), and
cards in the agent's chat (MCP Apps). Every name here is made up."""

import json
import logging

import pytest
from fastapi.testclient import TestClient

import sellbird.dashboard as dash
from sellbird import dashboard_auth as auth, mcp_cards
from tests.test_dashboard_signals import client  # noqa: F401  (fixture)
from tests.test_suite_screens import agent  # noqa: F401  (fixture)

ORIGIN = "http://127.0.0.1:5555"


@pytest.fixture(autouse=True)
def fresh_panes(monkeypatch):
    panes = auth.PaneSessions()
    monkeypatch.setattr(dash, "pane_sessions", panes)
    # The guard holds its own reference: point it at the same store.
    for mw in dash.app.user_middleware:
        if mw.cls is auth.DashboardGuard:
            monkeypatch.setitem(mw.kwargs, "panes", panes)
    dash.app.middleware_stack = None
    yield panes
    dash.app.middleware_stack = None


def _browser():
    return TestClient(dash.app, base_url=ORIGIN)


def _redeem(http, code, **headers):
    return http.post(auth.PANE_PATH, json={"code": code}, headers=headers)


# ── the codes themselves ──

def test_a_code_works_once_and_expires():
    now = [1000.0]
    panes = auth.PaneSessions(clock=lambda: now[0])
    code = panes.mint()
    token = panes.redeem(code)
    assert token and token != code
    assert panes.redeem(code) is None                         # once
    assert panes.check([f"Bearer {token}"]) and not panes.check([f"Bearer {code}"])
    late = panes.mint()
    now[0] += auth.CODE_SECONDS + 1
    assert panes.redeem(late) is None                         # two minutes
    now[0] += auth.PANE_SESSION_SECONDS
    assert not panes.check([f"Bearer {token}"])               # twelve hours


def test_codes_and_sessions_are_capped_and_sign_out_ends_both():
    panes = auth.PaneSessions()
    codes = [panes.mint() for _ in range(auth.MAX_OPEN_CODES)]
    assert panes.mint() is None
    tokens = [panes.redeem(c) for c in codes]
    assert len(panes.sessions()) == auth.MAX_PANE_SESSIONS     # the oldest give way
    assert panes.check([f"Bearer {tokens[-1]}"]) and not panes.check([f"Bearer {tokens[0]}"])
    spare = panes.mint()
    assert panes.sign_out_all() == auth.MAX_PANE_SESSIONS
    assert panes.redeem(spare) is None and not panes.check([f"Bearer {tokens[-1]}"])


def test_guessing_stops_working_after_too_many_failures():
    panes = auth.PaneSessions()
    good = panes.mint()
    for _ in range(auth.MAX_FAILED_REDEEMS):
        assert panes.redeem("x" * 43) is None
    assert panes.redeem(good) is None


# ── through the dashboard ──

def test_the_agent_gets_a_code_and_the_pane_gets_a_session_not_the_token(client, agent):  # noqa: F811
    made = agent.post("/api/pane/code").json()
    assert made["success"] and auth.TOKEN_RE.fullmatch(made["code"])
    with _browser() as http:
        got = _redeem(http, made["code"])
        assert got.status_code == 200
        pane = got.json()["token"]
        assert pane != dash.token_store.get() and pane != dash.agent_token_store.get()
        # The pane is the person's session: it can do what they can, the agent can't.
        assert http.get("/api/settings", headers={"Authorization": f"Bearer {pane}"}).status_code == 200
        assert agent.get("/api/settings").status_code == 403
        # Used once.
        assert _redeem(http, made["code"]).status_code == 401
        assert client.get("/api/agent").json()["panes"]


def test_a_redeem_from_another_host_or_site_is_refused(client, agent):  # noqa: F811
    code = agent.post("/api/pane/code").json()["code"]
    with TestClient(dash.app, base_url="http://evil.example") as http:
        assert _redeem(http, code).status_code == 400
    with _browser() as http:
        assert _redeem(http, code, origin="http://evil.example").status_code == 403
        assert _redeem(http, code, **{"sec-fetch-site": "cross-site"}).status_code == 403
        assert http.post(auth.PANE_PATH, content=b"code=" + code.encode(),
                         headers={"content-type": "application/x-www-form-urlencoded"}).status_code == 415
        # Refused attempts didn't use it up.
        assert _redeem(http, code).status_code == 200


def test_no_other_route_opens_without_a_token(client):  # noqa: F811
    with _browser() as http:
        assert http.post("/api/pane/code").status_code == 401
        assert http.get("/api/settings").status_code == 401


def test_cutting_the_agent_off_signs_every_pane_out(client, agent):  # noqa: F811
    code = agent.post("/api/pane/code").json()["code"]
    with _browser() as http:
        pane = _redeem(http, code).json()["token"]
        assert client.post("/api/agent/access", json={"access": "off"}).json()["panes_signed_out"] == 1
        assert http.get("/api/today", headers={"Authorization": f"Bearer {pane}"}).status_code == 401
    assert agent.post("/api/pane/code").status_code == 403
    client.post("/api/agent/access", json={"access": "on"})


def test_the_code_and_the_session_never_reach_the_logs(client, agent, caplog):  # noqa: F811
    caplog.set_level(logging.DEBUG)
    code = agent.post("/api/pane/code").json()["code"]
    with _browser() as http:
        pane = _redeem(http, code).json()["token"]
        http.get("/api/today", headers={"Authorization": f"Bearer {pane}"})
        _redeem(http, code)
    logged = caplog.text + json.dumps(client.get("/api/agent").json()) + json.dumps(client.get("/api/activity").json())
    assert code not in logged and pane not in logged


# ── the agent's tools ──

def test_page_names_map_to_screens():
    assert mcp_cards.page_for("outbound/approvals") == "outbox"
    assert mcp_cards.page_for("Inbound") == "leads"
    assert mcp_cards.page_for("person/p4") == "person/p4"
    assert mcp_cards.page_for("person/../../etc") is None and mcp_cards.page_for("javascript:x") is None
    link = mcp_cards.sign_in_link("http://127.0.0.1:5598/", "abc_DEF-123", "outbox")
    assert link == "http://127.0.0.1:5598/#code=abc_DEF-123&page=outbox"
    assert mcp_cards.sign_in_link("http://127.0.0.1:5598/", "c", "today").endswith("#code=c")


@pytest.mark.asyncio
async def test_the_card_tools_carry_a_ui_resource_and_plain_text():
    from sellbird import mcp_server
    server = mcp_server.build_server(lambda: None)
    tools = {t.name: t for t in await server.list_tools()}
    for name, key in (("show_today", "today"), ("show_needs_you", "needs_you"), ("show_campaign_report", "campaign")):
        assert tools[name].meta == {"ui": {"resourceUri": mcp_cards.CARD_URIS[key]}}
    assert "built-in browser or side panel" in tools["dashboard_open"].description
    resources = {str(r.uri): r for r in await server.list_resources()}
    for uri in mcp_cards.CARD_URIS.values():
        assert resources[uri].mime_type == "text/html;profile=mcp-app"
        html = (await server.read_resource(uri))[0].content
        assert "ui/initialize" in html and "ui/notifications/tool-result" in html and "ui/open-link" in html
        assert ".innerHTML" not in html     # every value is set as text
        # The one tool a card calls opens the dashboard; it never calls one that acts.
        import re
        assert re.findall(r"name: '([a-z_]+)'", html) == ["dashboard_open"]


def test_the_cards_shape_real_answers_and_never_offer_to_approve():
    today = {"stats": {"outbox_pending": 3, "leads_needing_you": 1, "prospects": 13, "open_conversations": 2},
             "items": [{"title": "3 emails waiting for approval", "detail": "x", "tone": "warn", "tab": "outbox"},
                       {"title": "2 new mentions", "detail": "y", "tone": "good", "tab": "mentions"}]}
    card = mcp_cards.today_card(today, {"on": 7, "total": 13})
    assert card["subtitle"].startswith("1 thing needs you.") and "7 of 13" in card["subtitle"]
    assert [i["page"] for i in card["items"]] == ["outbox", "mentions"]
    needs = mcp_cards.needs_you_card(
        {"pending": [{"kind": "reply", "subject": "Re: quote", "context": {"contact": "Avery Stone"}}]},
        [{"status": "needs_human", "intent": "escalate"}],
        {"leads": [{"status": "new", "name": "Pat Lee", "message": "word " * 60}]},
        {"waiting": []}, {"pending": []})
    assert [i["page"] for i in needs["items"]] == ["outbox", "conversations", "leads"]
    assert needs["items"][2]["detail"].endswith("...") and len(needs["items"][2]["detail"]) <= 143
    assert all(i["action"] in ("Review", "Open") for i in needs["items"])
    report = mcp_cards.campaign_card({"name": "Dentists", "people": 6, "reached": 6, "sent": 36, "replied": 3,
                                      "meetings": 1, "waiting": 1, "scheduled": 4, "reply_rate": 50})
    assert report["items"][0]["title"] == "1 email waits for your approval"
    text = mcp_cards.as_text(needs)
    assert "Reply to Avery Stone" in text and "dashboard_open" in text


def test_the_campaign_report_counts_one_campaign(client):  # noqa: F811
    assert client.get("/api/campaigns/latest/report").status_code == 404
    assert client.get("/api/campaigns/nope/report").status_code == 404


# ── the page: a code is taken from the link, swapped once, and never kept ──

NODE = r"""
const store = {}; const calls = []; let replaced = null;
globalThis.window = {location: {origin: 'http://127.0.0.1:5555', pathname: '/', search: '', hash: process.argv[2]}};
globalThis.location = window.location;
globalThis.history = {replaceState: (s, t, url) => { replaced = url; }};
globalThis.sessionStorage = {getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); },
                             removeItem: k => { delete store[k]; }};
const PANE = 'P'.repeat(43);
globalThis.fetch = (url, opts) => {
  calls.push({url, body: opts && opts.body, auth: opts && opts.headers && opts.headers.get ? opts.headers.get('authorization') : null});
  if (url === '/api/pane/redeem') return Promise.resolve({ok: process.argv[3] === 'good', json: () => Promise.resolve({token: PANE})});
  return Promise.resolve({ok: true, json: () => Promise.resolve({})});
};
eval(require('fs').readFileSync(process.argv[1], 'utf8') + ';globalThis.T = {authFetch, authToken};');
(async () => {
  await T.authFetch('/api/today');
  process.stdout.write(JSON.stringify({replaced, stored: T.authToken(), calls, failed: signInFailed}));
})();
"""


@pytest.mark.parametrize("outcome", ["good", "used"])
def test_the_page_swaps_the_code_before_its_first_request(outcome):
    import shutil
    import subprocess
    from pathlib import Path
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed")
    code = "C" * 43
    auth_js = Path(dash.__file__).resolve().parent / "web" / "auth.js"
    out = json.loads(subprocess.run([node, "-e", NODE, str(auth_js), f"#code={code}&page=outbox", outcome],
                                    capture_output=True, text=True, check=True).stdout)
    assert out["replaced"] == "/#outbox"                       # the code leaves the address bar at once
    assert out["calls"][0]["url"] == "/api/pane/redeem" and json.loads(out["calls"][0]["body"]) == {"code": code}
    if outcome == "good":
        assert out["stored"] == "P" * 43 and out["calls"][1]["auth"] == "Bearer " + "P" * 43
    else:
        assert out["stored"] == "" and out["failed"] is True and out["calls"][1]["auth"] is None
    assert code not in json.dumps(out["calls"][1:]) and out["stored"] != code


# ── Connect buttons (Set up, Your agent) ──

def test_connect_buttons_are_yours_alone_not_a_pane_or_the_agent(client, agent, monkeypatch):  # noqa: F811
    from sellbird import connect
    calls = []
    monkeypatch.setattr(connect, "agent_states", lambda: [{"agent": "claude-desktop"}])
    monkeypatch.setattr(connect, "apply_one",
                        lambda a, act: calls.append((a, act)) or {"success": True, "next": "x"})
    body = {"agent": "claude-desktop", "action": "connect"}

    # A pane your agent opened counts as you elsewhere, but not here.
    code = agent.post("/api/pane/code").json()["code"]
    with _browser() as http:
        pane = _redeem(http, code).json()["token"]
        h = {"Authorization": f"Bearer {pane}"}
        assert http.get("/api/agents/connect", headers=h).status_code == 403
        assert http.post("/api/agents/connect", json=body, headers=h).status_code == 403
    # The agent's own key: refused before the route runs.
    assert agent.get("/api/agents/connect").status_code == 403
    assert agent.post("/api/agents/connect", json=body).status_code == 403
    # No sign-in, another host, another site.
    with _browser() as http:
        assert http.post("/api/agents/connect", json=body).status_code == 401
    assert client.post("/api/agents/connect", json=body,
                       headers={"origin": "http://evil.example"}).status_code == 403
    with TestClient(dash.app, base_url="http://evil.example") as other:
        assert other.post("/api/agents/connect", json=body,
                          headers=dict(client.headers)).status_code == 400
    assert calls == []

    # Your own dashboard sign-in.
    assert client.get("/api/agents/connect").json()["agents"] == [{"agent": "claude-desktop"}]
    assert client.post("/api/agents/connect", json=body).json()["success"]
    assert calls == [("claude-desktop", "connect")]


# ── A pane can take the agent's reach away, never give it more ──

def _pane_headers(agent):  # noqa: F811
    code = agent.post("/api/pane/code").json()["code"]
    with _browser() as http:
        return {"Authorization": f"Bearer {_redeem(http, code).json()['token']}"}


def test_a_pane_cannot_let_the_agent_back_in_but_can_cut_it_off(client, agent):  # noqa: F811
    h = _pane_headers(agent)
    with _browser() as http:
        assert http.post("/api/agent/access", json={"access": "off"}, headers=h).status_code == 200
    # Cutting it off signed the pane out; a fresh pane still can't undo it.
    client.post("/api/agent/access", json={"access": "on"})
    h = _pane_headers(agent)
    client.post("/api/agent/access", json={"access": "off"})   # pane signed out again
    client.post("/api/agent/access", json={"access": "on"})
    h = _pane_headers(agent)
    with _browser() as http:
        assert http.post("/api/agent/access", json={"access": "on"}, headers=h).status_code == 403
    assert agent.post("/api/agent/access", json={"access": "on"}).status_code == 403
    assert client.post("/api/agent/access", json={"access": "on"}).json()["access"] == "on"


def test_a_pane_cannot_resume_sending_but_can_pause(client, agent):  # noqa: F811
    h = _pane_headers(agent)
    with _browser() as http:
        assert http.post("/api/sending/pause", headers=h).status_code == 200
        assert http.post("/api/sending/resume", headers=h).status_code == 403
    assert agent.post("/api/sending/resume").status_code == 403
    assert client.post("/api/sending/resume").json()["success"]


def test_a_pane_cannot_turn_on_autopilot_but_can_go_back_to_approval(client, agent, tmp_path, monkeypatch):  # noqa: F811
    import shutil
    from sellbird.config import load_config
    from sellbird.paths import PROJECT_ROOT
    cfg = tmp_path / "sellbird.yaml"
    shutil.copy(PROJECT_ROOT / "sellbird.yaml", cfg)
    assert load_config(str(cfg)).channels.email.require_approval
    monkeypatch.setattr(dash, "_resolve_config_file", lambda: cfg)
    h = _pane_headers(agent)
    on = {"mode": "autopilot", "confirm": "autopilot"}
    with _browser() as http:
        assert http.post("/api/sending-mode", json=on, headers=h).status_code == 403
        assert load_config(str(cfg)).channels.email.require_approval
        assert http.post("/api/sending-mode", json={"mode": "approval"}, headers=h).status_code == 200
    assert agent.post("/api/sending-mode", json=on).status_code == 403
    assert client.post("/api/sending-mode", json=on).status_code == 200


def test_a_pane_cannot_make_links_for_more_panes(client, agent):  # noqa: F811
    h = _pane_headers(agent)
    with _browser() as http:
        assert http.post("/api/pane/code", headers=h).status_code == 403
        # Reading and moving around still work.
        assert http.get("/api/agent", headers=h).status_code == 200
        assert http.get("/api/sending-mode", headers=h).status_code == 200
        # And it can sign panes out, itself included.
        assert http.post("/api/pane/sign-out", headers=h).status_code == 200
        assert http.get("/api/agent", headers=h).status_code == 401
    assert agent.post("/api/pane/code").status_code == 200
    assert client.post("/api/pane/code").status_code == 200
