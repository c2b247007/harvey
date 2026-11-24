"""A chat card under a host: the card asks Sellbird for a one-use sign-in link
(dashboard_open) and the host to open it (ui/open-link). A host may open it,
refuse it (Codex opens only links it trusts) or not answer. Only a real
"opened" counts; otherwise the card says so and offers a prompt or the link.
Runs the real card page in Chromium; skipped where Playwright has no browser."""

import json

import pytest

from sellbird import mcp_cards

LINK = "http://127.0.0.1:5555/#code=" + "C" * 43 + "&page=outbox"
CARD = {"kind": "needs_you", "title": "Waiting for you", "count": 1, "only_you": True,
        "answer": "1 thing is waiting for your decision.",
        "items": [{"title": "Reply to Pat Example", "detail": "Re: quote", "tag": "Draft reply", "tone": "acc",
                   "page": "outbox", "action": "Review", "primary": True}],
        "page": "outbox", "open_label": "Open what is waiting"}

# The host: answers ui/initialize and tools/call, and answers ui/open-link the
# way the test asks: "open" (a result), "refuse" (an error) or "silent".
HOST = """<!doctype html><html><body><iframe id="f" style="width:600px;height:500px;border:0"></iframe><script>
window.seen = [];
const f = document.getElementById('f'); f.srcdoc = %s;
const card = %s, link = %s, mode = %s;
const reply = (id, body) => f.contentWindow.postMessage(Object.assign({jsonrpc: '2.0', id}, body), '*');
window.addEventListener('message', e => {
  const m = e.data; if (!m || m.jsonrpc !== '2.0') return;
  window.seen.push({method: m.method, params: m.params});
  if (m.method === 'ui/initialize') reply(m.id, {result: {hostContext: {theme: 'light'}}});
  if (m.method === 'ui/notifications/initialized')
    f.contentWindow.postMessage({jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: {structuredContent: card}}, '*');
  if (m.method === 'tools/call') reply(m.id, {result: {structuredContent: {ok: true, url: link}, content: [{type: 'text', text: link}]}});
  if (m.method === 'ui/open-link' && mode === 'open') reply(m.id, {result: {}});
  if (m.method === 'ui/open-link' && mode === 'refuse') reply(m.id, {error: {code: -32000, message: 'Not allowed'}});
});
</script></body></html>"""


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


def _click_review(browser, mode):
    page = browser.new_page()
    html = mcp_cards.card_html()
    page.set_content(HOST % (json.dumps(html).replace("</", "<\\/"), json.dumps(CARD), json.dumps(LINK), json.dumps(mode)))
    frame = page.frame_locator("#f")
    frame.locator("button.pri").first.click()
    return page, frame


def test_a_host_that_opens_the_link_gets_the_one_use_link_and_nothing_else_shows(browser):
    page, frame = _click_review(browser, "open")
    page.wait_for_timeout(400)
    calls = [m for m in page.evaluate("window.seen") if m["method"] in ("tools/call", "ui/open-link")]
    assert calls[0]["params"] == {"name": "dashboard_open", "arguments": {"page": "outbox"}}
    assert calls[1]["params"] == {"url": LINK}                         # the one-use code, never the token
    assert frame.locator(".fb").count() == 0
    page.close()


@pytest.mark.parametrize("mode, wait", [("refuse", 400), ("silent", 5600)])
def test_a_refused_or_unanswered_link_says_so_and_offers_a_way(browser, mode, wait):
    page, frame = _click_review(browser, mode)
    page.wait_for_timeout(wait)
    box = frame.locator(".fb")
    assert box.count() == 1
    assert "didn’t open the link" in box.inner_text()
    values = [frame.locator(".fbin").nth(i).input_value() for i in range(frame.locator(".fbin").count())]
    assert values[0].startswith("Open Sellbird’s Outbound") and values[1] == LINK
    assert "dashboard-token" not in json.dumps(values) and "token=" not in json.dumps(values)
    assert frame.locator("button:has-text('Review')").is_enabled()     # it can be tried again
    page.close()
