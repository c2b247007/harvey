# Sellbird inside your agent app

Claude desktop, ChatGPT desktop and Codex each have a browser pane beside the chat. Your agent can open the whole Sellbird dashboard there, signed in, and show small cards in the chat as you talk.

Both need the dashboard running (`sellbird dashboard`) and Sellbird connected to your agent (`sellbird connect`, see [configuration](configuration.md#your-coding-agent-mcp)).

## The dashboard in the browser pane

Ask your agent "Open Sellbird" or "Show me what is waiting for approval". It calls `dashboard_open` and opens the link in its browser pane.

- **The link carries a sign-in code, not your dashboard token.** It works once, within two minutes, and it sits after the `#`, so the browser never sends it to a server or a log. The page swaps it for a session of its own and takes it out of the address bar.
- **A used or expired link does nothing.** The page stays locked and says to ask your agent for a new link.
- **A pane session lasts twelve hours.** Set up, Your agent lists every signed-in pane, with **Sign panes out**. Cutting your agent off signs every pane out at once and stops new links. A restarted dashboard signs every pane out too.
- **Pages:** `today`, `outbound` (what waits for approval), `replies`, `campaigns`, `signals`, `social`, `inbound` (leads), `texts`, `mentions`, `people`, `calendar`, `numbers`, `setup`, `suite`, or `person/<id>`.

**What this changes.** A pane signed in this way is your session: whoever drives that pane can click what you can click there, including Approve. Your agent can drive its own browser pane. The agent's own key still can't approve, send or resume anything. Use the pane while you are watching it, and sign panes out when you are done.

## Cards in the chat

Three tools answer with a card in hosts that support MCP Apps, and with the same facts as plain text everywhere else:

| Tool | Card |
|---|---|
| `show_today` | What needs you, what happened, the next thing |
| `show_needs_you` | Drafted emails and replies, conversations handed to you, new leads, posts and texts. Each has **Review** |
| `show_campaign_report` | One campaign: sent, replied, meetings, and what waits for approval |

A card shows and links. Its buttons open the item in the dashboard, through a fresh one-use link, where you decide. It never approves, sends, buys or resumes.

The cards follow the [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) specification (2026-01-26): each card tool names a `ui://sellbird/...` resource in `_meta.ui.resourceUri`, and the resource is one HTML page (`sellbird/web/card.html`, type `text/html;profile=mcp-app`) with the Geist font inlined and no network use.

## Which hosts are checked

| Host | Dashboard in the pane | Cards in chat |
|---|---|---|
| Claude desktop | Checked: signed in, opened on the right page, link refused on reuse | Not checked yet |
| ChatGPT desktop | Not checked | Not checked |
| Codex | Not checked | Not checked (the MCP Apps docs don't list Codex) |

The cards were checked in a stand-in host that speaks the same protocol: they render, follow light and dark, fit 320 pixels, and Review asks for a link and opens it.
