"""Texts through your own Twilio account.

Sellbird registers no numbers of its own: you connect the Twilio account that
already carries your number and its carrier registration (A2P 10DLC in the
US), and messages go out as you. Three values in ``.env``:

    TWILIO_ACCOUNT_SID=AC...
    TWILIO_AUTH_TOKEN=...
    TWILIO_FROM_NUMBER=+13035550100        # or TWILIO_MESSAGING_SERVICE_SID=MG...

Only two calls are made: send one message, and list messages that arrived.
Inbound texts are *polled*, not pushed, so nothing has to be reachable from
the internet: a locally running Sellbird reads them the same way it reads a
mailbox. Whether a text may be sent at all is not decided here; see
``sellbird.consent`` and ``sellbird.texting``.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

API = "https://api.twilio.com/2010-04-01"
TIMEOUT_SECONDS = 15.0


class TwilioError(Exception):
    """Twilio refused, or could not be reached. The message is safe to show."""


class TwilioClient:
    def __init__(self, account_sid: str, auth_token: str, *, from_number: str = "",
                 messaging_service_sid: str = "", http=None):
        self.account_sid = account_sid
        self._auth = (account_sid, auth_token)
        self.from_number = from_number
        self.messaging_service_sid = messaging_service_sid
        self._http = http

    @classmethod
    def from_env(cls, env=os.environ, http=None) -> "TwilioClient | None":
        """A client from the environment, or None when Twilio isn't connected."""
        if connection_problem(env):
            return None
        return cls(env["TWILIO_ACCOUNT_SID"].strip(), env["TWILIO_AUTH_TOKEN"].strip(),
                   from_number=env.get("TWILIO_FROM_NUMBER", "").strip(),
                   messaging_service_sid=env.get("TWILIO_MESSAGING_SERVICE_SID", "").strip(), http=http)

    async def _request(self, method: str, path: str, **kwargs) -> dict:
        import httpx
        url = f"{API}/Accounts/{self.account_sid}/{path}"
        try:
            if self._http is not None:
                response = await self._http.request(method, url, auth=self._auth, **kwargs)
            else:
                async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS) as client:
                    response = await client.request(method, url, auth=self._auth, **kwargs)
        except Exception as e:
            raise TwilioError(f"Twilio could not be reached ({type(e).__name__})")
        try:
            data = response.json()
        except ValueError:
            data = {}
        if response.status_code >= 400:
            detail = str(data.get("message") or "").strip() if isinstance(data, dict) else ""
            raise TwilioError(f"Twilio answered {response.status_code}" + (f": {detail}" if detail else ""))
        return data if isinstance(data, dict) else {}

    async def send(self, to: str, body: str) -> dict:
        """Send one text. Returns {"sid", "status"}."""
        form = {"To": to, "Body": body}
        if self.messaging_service_sid:
            form["MessagingServiceSid"] = self.messaging_service_sid
        else:
            form["From"] = self.from_number
        data = await self._request("POST", "Messages.json", data=form)
        return {"sid": str(data.get("sid") or ""), "status": str(data.get("status") or "queued")}

    async def inbound_since(self, since: datetime | None = None, limit: int = 50) -> list[dict]:
        """Texts people sent to your number, oldest first: {"sid", "from", "body", "at"}."""
        params = {"PageSize": str(limit)}
        if self.from_number:
            params["To"] = self.from_number
        if since is not None:
            params["DateSent>"] = since.strftime("%Y-%m-%d")
        data = await self._request("GET", "Messages.json", params=params)
        out = []
        for m in data.get("messages") or []:
            if not str(m.get("direction") or "").startswith("inbound"):
                continue
            try:
                at = parsedate_to_datetime(m.get("date_sent") or m.get("date_created") or "")
                at = at.astimezone(timezone.utc).replace(tzinfo=None)
            except (TypeError, ValueError):
                at = datetime.now(timezone.utc).replace(tzinfo=None)
            out.append({"sid": str(m.get("sid") or ""), "from": str(m.get("from") or ""),
                        "body": str(m.get("body") or ""), "at": at.isoformat()})
        return sorted(out, key=lambda m: m["at"])


def connection_problem(env=os.environ) -> str:
    """Why Twilio can't be used yet, or '' when it is connected."""
    missing = [k for k in ("TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN") if not env.get(k, "").strip()]
    if missing:
        return "not set in .env: " + ", ".join(missing)
    if not env.get("TWILIO_ACCOUNT_SID", "").strip().startswith("AC"):
        return "TWILIO_ACCOUNT_SID should start with AC"
    if not (env.get("TWILIO_FROM_NUMBER", "").strip() or env.get("TWILIO_MESSAGING_SERVICE_SID", "").strip()):
        return "set TWILIO_FROM_NUMBER (your number) or TWILIO_MESSAGING_SERVICE_SID in .env"
    return ""
