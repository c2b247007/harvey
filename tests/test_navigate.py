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
