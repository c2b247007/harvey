"""The "go to" channel: a card click in the agent's chat (dashboard_navigate)
turns the dashboard tab that is already open, with no link, code or token."""

import asyncio

import httpx

import sellbird.dashboard as dash
from tests.test_dashboard_signals import client  # noqa: F401  (fixture)
from tests.test_suite_screens import agent  # noqa: F401  (fixture)

TAB = "tab0123456789ab"


def _http(test_client):
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=dash.app), base_url="http://127.0.0.1:5555",
                             headers={"Authorization": test_client.headers["Authorization"]})


def test_with_no_tab_open_nothing_is_delivered(client, agent, monkeypatch):  # noqa: F811
    monkeypatch.setattr(dash, "_nav", dash._NavBus())
    r = agent.post("/api/navigate", json={"page": "outbound"}).json()
    assert r == {"ok": True, "delivered": False, "open_tabs": 0, "page": "outbox"}


def test_the_open_tab_switches_and_the_click_hears_it(client, agent, monkeypatch):  # noqa: F811
    monkeypatch.setattr(dash, "_nav", dash._NavBus())

    async def run():
        async with _http(client) as tab, _http(agent) as card:
            first = (await tab.get(f"/api/navigate/next?after=-1&tab={TAB}")).json()
            assert "page" not in first                       # a tab that just opened goes nowhere

            async def listen():
                got = (await tab.get(f"/api/navigate/next?after={first['seq']}&tab={TAB}")).json()
                await tab.post("/api/navigate/ack", json={"seq": got["seq"], "tab": TAB})
                return got

            async def click():
                await asyncio.sleep(0.05)
                return (await card.post("/api/navigate", json={"page": "person/p1"})).json()

            return await asyncio.gather(listen(), click())

    got, answer = asyncio.run(run())
    assert got == {"seq": 1, "page": "person/p1"}            # only a page name travels
    assert answer["delivered"] is True and answer["open_tabs"] == 1


def test_only_a_signed_in_tab_listens_and_only_pages_go(client, agent, monkeypatch):  # noqa: F811
    monkeypatch.setattr(dash, "_nav", dash._NavBus())
    assert agent.get(f"/api/navigate/next?after=-1&tab={TAB}").status_code == 403      # the agent's key can't listen
    assert agent.post("/api/navigate/ack", json={"seq": 1, "tab": TAB}).status_code == 403
    assert client.get("/api/navigate/next?after=-1&tab=x").status_code == 400          # a tab says who it is
    assert agent.post("/api/navigate", json={"page": "settings/../../etc"}).status_code == 400
    with _nobody() as anon:
        assert anon.get(f"/api/navigate/next?after=-1&tab={TAB}").status_code == 401   # no sign-in, no listening


def _nobody():
    from fastapi.testclient import TestClient
    return TestClient(dash.app, base_url="http://127.0.0.1:5555")


# ── A card's own click (POST /api/navigate/card, with a pass) ──

CARD = "/api/navigate/card"


def _pass(agent):  # noqa: F811
    made = agent.post("/api/navigate/pass").json()
    assert made["path"] == CARD and made["expires_in"] == 1800
    return made["pass"]


def test_a_card_pass_switches_the_open_tab_from_the_cards_own_origin(client, agent, monkeypatch):  # noqa: F811
    monkeypatch.setattr(dash, "_nav", dash._NavBus())
    monkeypatch.setattr(dash, "_card_passes", dash._CardPasses())
    ticket = _pass(agent)

    async def run():
        async with _http(client) as tab, httpx.AsyncClient(transport=httpx.ASGITransport(app=dash.app),
                                                           base_url="http://127.0.0.1:5555") as card:
            first = (await tab.get(f"/api/navigate/next?after=-1&tab={TAB}")).json()

            async def listen():
                got = (await tab.get(f"/api/navigate/next?after={first['seq']}&tab={TAB}")).json()
                await tab.post("/api/navigate/ack", json={"seq": got["seq"], "tab": TAB})
                return got

            async def click():
                await asyncio.sleep(0.05)
                return await card.post(CARD, json={"pass": ticket, "page": "outbound"}, headers={"Origin": "null"})

            return await asyncio.gather(listen(), click())

    got, answer = asyncio.run(run())
    assert got == {"seq": 1, "page": "outbox"}
    assert answer.status_code == 200 and answer.json()["delivered"] is True
    assert answer.headers["access-control-allow-origin"] == "null"


def test_a_pass_can_only_navigate(client, agent, monkeypatch):  # noqa: F811
    monkeypatch.setattr(dash, "_card_passes", dash._CardPasses())
    ticket = _pass(agent)
    with _nobody() as anon:
        bearer = {"Authorization": f"Bearer {ticket}"}
        for method, path in [("GET", "/api/today"), ("GET", "/api/outbox"), ("POST", "/api/outbox/approve-all"),
                             ("POST", "/api/sending/resume"), ("POST", "/api/navigate"), ("GET", "/api/navigate/next")]:
            assert anon.request(method, path, headers=bearer, json={} if method == "POST" else None).status_code == 401
        # The pass in a body sent anywhere else does nothing either.
        assert anon.post("/api/pane/redeem", json={"code": ticket}).status_code in (400, 401, 403)
        # And it is no sign-in: the card route answers a page switch and nothing else.
        r = anon.post(CARD, json={"pass": ticket, "page": "outbox"}, headers={"Origin": "null"})
        assert set(r.json()) == {"ok", "delivered", "open_tabs", "page"}


def test_a_bad_page_an_unknown_or_expired_pass_is_refused(client, agent, monkeypatch):  # noqa: F811
    passes = dash._CardPasses()
    monkeypatch.setattr(dash, "_card_passes", passes)
    ticket = _pass(agent)
    with _nobody() as anon:
        post = lambda body: anon.post(CARD, json=body, headers={"Origin": "null"})  # noqa: E731
        assert post({"pass": ticket, "page": "settings/../../etc"}).status_code == 400
        assert post({"pass": "x" * 32, "page": "outbox"}).status_code == 403
        assert post({"page": "outbox"}).status_code == 403
        passes.passes = {d: 0.0 for d in passes.passes}            # every pass now expired
        assert post({"pass": ticket, "page": "outbox"}).status_code == 403


def test_passes_stop_when_the_agent_is_switched_off(client, agent, monkeypatch):  # noqa: F811
    monkeypatch.setattr(dash, "_card_passes", dash._CardPasses())
    ticket = _pass(agent)

    async def off():
        return True
    monkeypatch.setattr(dash, "_agent_is_off", off)
    with _nobody() as anon:
        assert anon.post(CARD, json={"pass": ticket, "page": "outbox"}, headers={"Origin": "null"}).status_code == 403


def test_card_clicks_are_rate_limited(client, agent, monkeypatch):  # noqa: F811
    monkeypatch.setattr(dash, "_card_passes", dash._CardPasses())
    ticket = _pass(agent)
    with _nobody() as anon:
        codes = [anon.post(CARD, json={"pass": ticket, "page": "outbox"}, headers={"Origin": "null"}).status_code
                 for _ in range(21)]
    assert codes[:20] == [200] * 20 and codes[20] == 429


def test_cors_is_open_on_the_card_route_only_and_only_to_a_cards_origins(client, agent):  # noqa: F811
    with _nobody() as anon:
        pre = anon.options(CARD, headers={"Origin": "https://cards.example.com",
                                          "Access-Control-Request-Method": "POST",
                                          "Access-Control-Request-Private-Network": "true"})
        assert pre.status_code == 204
        assert pre.headers["access-control-allow-origin"] == "https://cards.example.com"
        assert pre.headers["access-control-allow-private-network"] == "true"
        assert "access-control-allow-credentials" not in pre.headers
        # A plain http page, or no origin header at all, is no card.
        assert anon.options(CARD, headers={"Origin": "http://evil.example"}).status_code == 403
        assert anon.post(CARD, json={"pass": "x" * 32, "page": "outbox"}).status_code == 403
        # Not JSON: refused before the pass is looked at.
        assert anon.post(CARD, content=b"pass=x", headers={"Origin": "null", "Content-Type": "text/plain"}).status_code == 415
        # Every other route still refuses a cross-origin request, and sends no CORS header.
        for path in ("/api/navigate", "/api/navigate/pass", "/api/today"):
            r = anon.post(path, json={}, headers={"Origin": "null"})
            assert r.status_code == 403 and "access-control-allow-origin" not in r.headers
        r = anon.options("/api/today", headers={"Origin": "https://cards.example.com"})
        assert "access-control-allow-origin" not in r.headers
    # A wrong host never reaches it.
    from fastapi.testclient import TestClient
    with TestClient(dash.app, base_url="http://evil.example") as other:
        assert other.post(CARD, json={}, headers={"Origin": "null"}).status_code == 400
