# Events and webhooks

Sellbird can tell another tool the moment something happens to a person. Four
events exist:

| Event | When |
|---|---|
| `lead.created` | A new person is added |
| `reply.received` | Someone writes back |
| `meeting.booked` | A meeting is booked with someone |
| `stage.changed` | Someone moves to another stage |

Every event is recorded in the local database in the same write as the change
it describes, whether or not anything is listening. The dashboard shows them
under **Set up → Events and webhooks**, with how each delivery went.

## Send them somewhere

Add an endpoint to `sellbird.yaml` (or `sellbird.local.yaml`):

```yaml
webhooks:
  - url: https://hooks.example.com/sellbird
    secret_env: SELLBIRD_WEBHOOK_SECRET
    events: [reply.received, meeting.booked]   # leave out for all four
```

and put a long random value in `.env`:

```
SELLBIRD_WEBHOOK_SECRET=change-me-to-something-long-and-random
```

Rules: the address must be `https://` (plain `http://` is allowed only for
`localhost`), it may not carry a username or password, and an endpoint whose
secret is not set is never sent to. An endpoint added today only hears events
from then on.

Zapier, n8n and Make all offer a "catch a webhook" trigger: paste the address
they give you as `url`.

## What arrives

A `POST` with a JSON body:

```json
{
  "id": "evt_5c1f...",
  "type": "stage.changed",
  "created_at": "2026-03-10T15:02:11",
  "api_version": "2026-11-22",
  "data": {
    "person": {"id": "...", "email": "sam@example.com", "name": "Sam Example",
               "company": "Example Co", "stage": "proposal", "source": "cold_email"},
    "from": "talking", "to": "proposal", "by": "you", "reason": "sent the quote"
  }
}
```

`data.person` is on every event. `reply.received` adds `intent`, `text`,
`conversation_id` and `needs_you`; `meeting.booked` adds `meeting` (with
`starts_at`, which may be null) and `emails_cancelled`; `lead.created` adds
`found_via`.

Headers: `Sellbird-Event` (the type), `Sellbird-Delivery` (the event id, the
same on every retry, so use it to ignore duplicates) and `Sellbird-Signature`.

## Check the signature

```
Sellbird-Signature: t=1767225600,v1=5257a869e7ec...
```

`v1` is the HMAC-SHA256, in hex, of the timestamp, a dot, and the raw request
body, keyed with your secret. Recompute it, compare in constant time, and
refuse a timestamp more than five minutes old.

```python
from sellbird.events import verify_signature
ok = verify_signature(secret, raw_body_bytes, request.headers["Sellbird-Signature"])
```

## Delivery

Answer with any 2xx status within 10 seconds. Anything else is retried after
1 minute, 5 minutes, 30 minutes, 2 hours, 6 hours, 12 hours and 24 hours, then
the delivery is marked as given up. Redirects are not followed. Events are
sent every heartbeat cycle, and right away for a change you make in the
dashboard. **Send a test event** on the Events screen posts a `test.ping` to
every endpoint and shows how each answered.
