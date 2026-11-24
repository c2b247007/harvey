"""A chat card under a host. A click turns the Sellbird tab the person already
has open (dashboard_navigate): no link, no code, nothing posted in the chat.
With no tab open, the card asks the host to open a one-use sign-in link
(never on Codex, which drops them) and believes it only once a tab answers;
otherwise it shows one quiet line. Runs the real card page in Chromium;
skipped where Playwright has no browser."""

import json

import pytest

from sellbird import mcp_cards

LINK = "http://127.0.0.1:5555/#code=" + "C" * 43 + "&page=outbox"
CARD = {"kind": "needs_you", "title": "Waiting for you", "count": 1, "only_you": True,
        "answer": "1 thing is waiting for your decision.",
        "items": [{"title": "Reply to Pat Example", "detail": "Re: quote", "tag": "Draft reply", "tone": "acc",
                   "page": "outbox", "action": "Review", "primary": True}],
        "page": "outbox", "open_label": "Open what is waiting"}

# The host. `tabs` says how many dashboard_navigate calls find no tab before
# one answers (99: never); `mode` how it answers ui/open-link.
HOST = """<!doctype html><html><body><iframe id="f" style="width:600px;height:500px;border:0"></iframe><script>
window.seen = []; let navs = 0;
const f = document.getElementById('f'); f.srcdoc = %s;
const card = %s, link = %s, init = %s, tabs = %s, mode = %s;
const reply = (id, body) => f.contentWindow.postMessage(Object.assign({jsonrpc: '2.0', id}, body), '*');
window.addEventListener('message', e => {
  const m = e.data; if (!m || m.jsonrpc !== '2.0') return;
  window.seen.push({method: m.method, params: m.params});
  if (m.method === 'ui/initialize') reply(m.id, {result: Object.assign({hostContext: {theme: 'light'}}, init)});
  if (m.method === 'ui/notifications/initialized')
    f.contentWindow.postMessage({jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: {structuredContent: card}}, '*');
  if (m.method === 'tools/call' && m.params.name === 'dashboard_navigate')
    reply(m.id, {result: {structuredContent: {ok: true, delivered: navs++ >= tabs, page: 'outbox'}}});
  if (m.method === 'tools/call' && m.params.name === 'dashboard_open')
    reply(m.id, {result: {structuredContent: {ok: true, url: link}}});
  if (m.method === 'ui/open-link' && mode === 'open') reply(m.id, {result: {}});
  if (m.method === 'ui/open-link' && mode === 'refuse') reply(m.id, {error: {code: -32000, message: 'Not allowed'}});
});
</script></body></html>"""
CODEX = {"hostInfo": {"name": "chatgpt", "client_type": "codex_desktop"}, "hostCapabilities": {"openLinks": {}, "message": {}}}
OTHER = {"hostInfo": {"name": "Example host"}, "hostCapabilities": {"openLinks": {}, "message": {}}}


@pytest.fixture(scope="module")
def browser():
    sync = pytest.importorskip("playwright.sync_api")
    with sync.sync_playwright() as p:
        try:
            b = p.chromium.launch()
        except Exception:
            pytest.skip("Playwright has no Chromium here")
        yield b
        b.close()


def _click(browser, init, tabs, mode="open"):
    page = browser.new_page()
    page.set_content(HOST % (json.dumps(mcp_cards.card_html()).replace("</", "<\\/"), json.dumps(CARD), json.dumps(LINK),
                             json.dumps(init), json.dumps(tabs), json.dumps(mode)))
    frame = page.frame_locator("#f")
    frame.locator("button.pri").first.click()
    return page, frame


def _calls(page):
    return [m["params"]["name"] if m["method"] == "tools/call" else m["method"]
            for m in page.evaluate("window.seen") if m["method"] in ("tools/call", "ui/open-link", "ui/message")]


@pytest.mark.parametrize("init", [CODEX, OTHER, {}])
def test_a_click_turns_the_open_tab_with_no_link_code_or_chat_message(browser, init):
    page, frame = _click(browser, init, tabs=0)
    page.wait_for_timeout(400)
    assert _calls(page) == ["dashboard_navigate"]
    sent = [m for m in page.evaluate("window.seen") if m["method"] == "tools/call"][0]["params"]
    assert sent == {"name": "dashboard_navigate", "arguments": {"page": "outbox"}}
    assert frame.locator(".fb").inner_text().strip() == "Opened in your Sellbird tab."
    page.close()


def test_with_no_tab_a_host_that_opens_links_gets_the_one_use_link_and_the_tab_is_checked(browser):
    page, frame = _click(browser, OTHER, tabs=1, mode="open")
    page.wait_for_timeout(2200)
    assert _calls(page) == ["dashboard_navigate", "dashboard_open", "ui/open-link", "dashboard_navigate"]
    assert [m for m in page.evaluate("window.seen") if m["method"] == "ui/open-link"][0]["params"] == {"url": LINK}
    assert "Opened Sellbird in a new tab." in frame.locator(".fb").inner_text()
    page.close()


@pytest.mark.parametrize("init, mode", [(CODEX, "open"), (OTHER, "refuse")])
def test_with_no_tab_and_no_link_one_quiet_line_and_never_the_chat(browser, init, mode):
    page, frame = _click(browser, init, tabs=99, mode=mode)
    page.wait_for_timeout(700)
    calls = _calls(page)
    assert "ui/message" not in calls
    assert ("ui/open-link" in calls) is (init is OTHER)                 # Codex is never handed a link
    assert "Open Sellbird in your side panel first, then click again." in frame.locator(".fb").inner_text()
    assert frame.locator(".fb button").inner_text() == "Copy prompt"
    assert frame.locator("button:has-text('Review')").is_enabled()
    page.close()
