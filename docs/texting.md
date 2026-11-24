# Texting and the consent check

Sellbird can send texts through **your own Twilio account**, and it has one
check, in code, that every text and every call has to pass first. Texting is
off until you turn it on. The check has no off switch.

## The consent check

`sellbird/consent.py` answers one question: may we contact this number, on
this channel (`sms` or `call`), right now? The answer is no unless all of
these hold:

1. **It is a real phone number.**
2. **They have not opted out.** Someone who opted out of email is not texted
   or called, and neither is a number on the do-not-contact list (a number
   that replied STOP, or one you added).
3. **There is a stored yes for that channel.** Who agreed, when and how. A yes
   to texts is not a yes to calls. With no stored yes there is no first text,
   ever.
4. **It is not quiet hours for them.** 21:00 to 08:00 by default, on their
   clock when Sellbird knows their time zone and on yours when it does not.
   Quiet hours only delay: the text goes when they end.

The check runs at the moment of sending, so a STOP that arrives after you
approved a text still wins. A text that fails is held with the reason.

A yes is evidence, so consent is a record that is never edited. Taking a yes
back adds a new row, and the newest row for a number and channel is the
answer. Record one in the dashboard under **Set up → Texting and consent**,
with a sentence saying how they agreed ("Ticked the box on the quote form on
March 3"). Your agent cannot record a yes.

Sellbird has no calling feature. The check covers calls so that anything
built on top of the engine uses the same gate: ask it with
`POST /api/consent/check` or the `consent_check` MCP tool.

## Connect Twilio

Sellbird registers no numbers of its own. Use the Twilio account that already
has your number and its carrier registration (A2P 10DLC in the US). In `.env`:

```
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_FROM_NUMBER=+13035550100
# or, in place of the number:
# TWILIO_MESSAGING_SERVICE_SID=MG...
```

Then in `sellbird.yaml` (or `sellbird.local.yaml`):

```yaml
texting:
  enabled: true
  quiet_hours: {start: "21:00", end: "08:00"}
  reply_to_inbound: true        # someone who texts you first may be answered
  default_country_code: "1"     # for numbers written without one
```

## How a text goes out

1. You or your agent **draft** it (`text_draft`, or `POST /api/texts`). A
   draft is refused when there is no stored yes for that number.
2. It waits under **Inbound → Texts** until **you approve it**. An agent can
   draft and read; it cannot approve.
3. Each cycle, approved texts that pass the check are sent. The first text to
   a number ends with "Reply STOP to opt out." unless it already says so.

Inbound texts are read from Twilio each cycle (polled, so nothing has to be
reachable from the internet). **STOP**, UNSUBSCRIBE, CANCEL, END, QUIT or "opt
out" puts the number on the do-not-contact list, records the no for texts and
calls, and cancels anything queued. Only the person can undo that. When
`reply_to_inbound` is on, a first message from a new number is kept as the
record that lets you answer them by text; it is never a yes to calls.

## What Sellbird does not do

It does not buy or register numbers, does not place calls, does not send a
text nobody approved, and does not text a list. Whether your use of texting
is lawful where you and your customers are is yours to check: the gate
enforces consent, quiet hours and opt-outs, not every rule of every country.
