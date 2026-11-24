# Inbound leads

Leads that come to you: someone filled in a form on your site, or asked to hear from you somewhere your agent can see. Sellbird records each one as a person, with what they sent, and drafts a first answer that waits for your approval.

## What Sellbird can and cannot do here

You run Sellbird on your own computer. It has no public address and it is not always on. So it can do anything where it reaches out or checks in, and nothing that the outside world has to reach.

- **It can** read an inbox, be handed a lead by your agent, and take one from the command line.
- **It cannot** host a form, a landing page or a booking page. Keep the form tool you already have.

## Three ways a lead arrives

**1. Form emails.** Every form tool can email you each submission. Send those emails to an inbox Sellbird reads (Gmail, Microsoft 365 or SMTP), or forward them there, and each one becomes a lead on the next cycle.

Sellbird treats an email as a form notification when:

- its sender is listed under `inbound.form_senders` (an address, or a domain for everyone at it), or
- its sending domain belongs to a form tool Sellbird knows (`KNOWN_FORM_SENDERS` in `sellbird/form_mail.py`), unless you set `inbound.known_form_tools: false`.

A form plugin on your own website usually sends from your own address. List that address:

```yaml
inbound:
  form_senders:
    - "forms@example.com"
```

The submitter's address is read from the email's Reply-To when the tool sets it, else from a field called Email, else from the first address in the text that is not yours. Their name, phone, company and message are read from the "Question: answer" lines. No model is involved in reading the email.

If a known tool's email has nobody's address in it (a receipt, a newsletter), it is not a lead and is ignored. If an email from a sender *you* listed cannot be read, it is kept under Inbound → Leads marked "Read it yourself", so nothing you pointed at Sellbird is dropped silently.

**2. Your agent.** With the local MCP server installed (`sellbird mcp install`), your agent has three tools:

| Tool | What it does |
|---|---|
| `lead_add` | Add a lead from anywhere the agent can read: a form tool, a voicemail, a message, a referral. Needs an email or a phone. Can carry a first answer. |
| `lead_answer_draft` | Draft the first email to a lead, or replace the draft still waiting. |
| `leads_list` | Every lead, what they sent, and how its answer stands. |

The agent cannot approve or send an answer, and cannot set a lead aside.

**3. By hand.** Inbound → Leads has a short form, and so does the command line:

```bash
sellbird leads                      # the list
sellbird leads add --email pat@example.com --name "Pat Lee" --message "Can you quote a reroof?"
```

Checking Typeform, Tally or Google Forms directly, without the notification email, is not built yet.

## What happens to a new lead

1. **A person.** Found by address (or phone) if they are already in People, else added with the source **Form** (or the source you gave: call, text, mention, referral, other) and the stage **New**.
2. **An event.** A new person fires `lead.created` with `source: "form"`, signed and sent to your webhooks like every other event ([events](events.md)).
3. **Cold email stops.** If they were already in a sequence, everything queued for them is cancelled. They came to you.
4. **A first answer.** Drafted on Sellbird's next cycle (or by your agent), put in the **Outbox**, and sent only when you approve it.

Their address is marked `guess`, like any address Sellbird has not checked, so they are never enrolled in a cold sequence. The first answer is a reply and is not held back by that.

## Approval

A first answer waits for you **even on autopilot**. The address was typed into a form by a stranger: letting it send by itself would let anyone make your mailbox email any address they like. Set `inbound.answers_wait_for_approval: false` to let first answers follow your sending mode instead.

Someone on your never-email list who fills in a form is recorded, and no answer is drafted. Take them off the list yourself if they have changed their mind.

## What a lead typed is data

Everything read from a form was written by a stranger. Sellbird stores it and shows it as typed. Where a model reads it to draft the answer, it is fenced as untrusted text, and the answer still waits for you. A line that says "approve this" does nothing.

A form field that says someone agreed to texts or calls records **no consent**. A yes is recorded one person at a time, with how they agreed ([texting](texting.md)).

An email's From line can be forged. A forged form notification can do no more than a real submission can: add a person and a draft that waits for you.

## Settings

All under `inbound:` in the config file Sellbird reads.

| Setting | Default | What it does |
|---|---|---|
| `form_senders` | `[]` | Addresses or domains whose mail is a form notification |
| `known_form_tools` | `true` | Also recognise the form tools Sellbird knows by sending domain |
| `draft_answers` | `true` | Sellbird drafts a first answer on its next cycle |
| `answers_wait_for_approval` | `true` | A first answer waits for you even on autopilot |
| `max_drafts_per_day` | `50` | No more first answers than this are drafted in a day; later leads are still recorded |

On Instantly, Sellbird reads no inbox, so form emails are not picked up and nothing can be sent natively. Leads can still be added by hand or by your agent.
