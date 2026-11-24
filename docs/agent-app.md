# Sellbird inside your agent app

Claude desktop, ChatGPT desktop and Codex each have a browser pane beside the chat. Your agent can open the whole Sellbird dashboard there, signed in, and show small cards in the chat as you talk.

Both need the dashboard running (`sellbird dashboard`) and Sellbird connected to your agent (`sellbird connect`, see [configuration](configuration.md#your-coding-agent-mcp)).

## The dashboard in the browser pane

Ask your agent "Open Sellbird" or "Show me what is waiting for approval". It calls `dashboard_open` and opens the link in its browser pane.

- **The link carries a sign-in code, not your dashboard token.** It works once, within two minutes, and it sits after the `#`, so the browser never sends it to a server or a log. The page swaps it for a session of its own and takes it out of the address bar.
- **A used or expired link does nothing.** The page stays locked and says to ask your agent for a new link.
- **A pane session lasts twelve hours.** Set up, Your agent lists every signed-in pane, with **Sign panes out**. Cutting your agent off signs every pane out at once and stops new links. A restarted dashboard signs every pane out too.
- **Pages:** `today`, `outbound` (what waits for approval), `replies`, `campaigns`, `signals`, `social`, `inbound` (leads), `texts`, `mentions`, `people`, `calendar`, `numbers`, `setup`, `suite`, or `person/<id>`.

**What this changes.** A pane signed in this way is your session: whoever drives that pane can click what you can click there, including Approve. Your agent can drive its own browser pane. The agent's own key still can't approve, send or resume anything. A pane can't widen the agent's reach either: letting the agent back in, resuming sending, turning on autopilot, connecting or removing an agent, and making links for more panes answer only your own dashboard sign-in. A pane can still cut the agent off, pause sending, go back to approval and sign panes out. Use the pane while you are watching it, and sign panes out when you are done.

## Cards in the chat

Three tools answer with a card in hosts that support MCP Apps, and with the same facts as plain text everywhere else:

| Tool | Card |
|---|---|
| `show_today` | What needs you, what happened, the next thing |
| `show_needs_you` | Drafted emails and replies, conversations handed to you, new leads, posts and texts. Each has **Review** |
| `show_campaign_report` | One campaign: sent, replied, meetings, and what waits for approval |

A card shows and links. It never approves, sends, buys or resumes. A click on **Review** or **Open** goes to the item in the dashboard, where you decide:

1. **A Sellbird tab is already open** (the pane, or your own browser): the card asks your agent's `dashboard_navigate` tool to turn that tab to the page. No link, no code, nothing posted in the chat.
2. **No tab is open:** the card asks the host to open a fresh one-use sign-in link (`dashboard_open`). Codex drops such links, so there the card says to ask the agent instead.
3. **The host doesn't pass a card's tool calls on** (Claude Code today): the card posts the page name straight to the dashboard on this machine, with a short-lived pass that can only turn an open tab. The pass is made for each card, lasts 30 minutes, is never your dashboard token or the agent's key, and can't read, approve, send or sign anything in. This is the one network call a card makes, and only to `127.0.0.1` or `localhost` (declared in the card's `connectDomains`).
4. If none of that reaches a tab, the card shows one quiet line saying what to ask your agent.

The cards follow the [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) specification (2026-01-26): each card tool names a `ui://sellbird/...` resource in `_meta.ui.resourceUri`, and the resource is one HTML page (`sellbird/web/card.html`, type `text/html;profile=mcp-app`) with the Geist font inlined. A card fills the width the host gives it.

## Which hosts are checked

| Host | Dashboard in the pane | Cards in chat |
|---|---|---|
| Claude desktop | Checked: signed in, opened on the right page, link refused on reuse | Not checked yet |
| Claude Code | Not applicable (no pane) | Cards render at full width. Clicks use the direct route in step 3; not yet confirmed in the app |
| Codex | Checked | Checked: cards render and a click turns the open Sellbird tab |
| ChatGPT desktop | Not checked | Not checked |

The cards are also tested in a stand-in host that speaks the same protocol (`tests/test_card_host.py`): they render, follow light and dark, fit 320 pixels, and each click path above is covered.
