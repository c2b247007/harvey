"""The services Sellbird recommends, and the one link for each.

Every link to a recommended service comes from here: the dashboard, the CLI,
and the checks that say what to do next. The README, CLAUDE.md and
.env.example repeat the same links, and a test keeps them in step.

One service per job, chosen for being the best fit for that job, never for
paying a commission. A service whose link is an affiliate link says so
(``affiliate=True``), and ``DISCLOSURE`` names every one of them.

To swap in an affiliate link once its program has accepted you: change that
service's one line below (the url, and ``affiliate=True``). Nothing else
needs to change; the disclosure follows.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Service:
    name: str
    url: str
    affiliate: bool = False


# One line per service. Lines marked TODO wait for Ethan's own affiliate
# link: until then they are the service's plain sign-up page.
SERVICES = {
    "trulyinbox": Service("TrulyInbox", "https://trulyinbox.com/?via=sellbird", affiliate=True),
    "hunter": Service("Hunter", "https://hunter.io/users/sign_up"),  # TODO(affiliate): Hunter link, then affiliate=True
    "dataforseo": Service("DataForSEO", "https://app.dataforseo.com/register"),  # TODO(affiliate): DataForSEO link, then affiliate=True
    "zerobounce": Service("ZeroBounce", "https://www.zerobounce.net/members/signup"),  # TODO(affiliate): ZeroBounce link, then affiliate=True
    "reoon": Service("Reoon", "https://www.reoon.com/email-verifier/"),
}

# The free way each job is done with no account, where there is one.
FREE = {
    "businesses": "OpenStreetMap, built in: no account, no cost. Thin for trades that work from a van "
                  "(roofers, plumbers), because it maps premises.",
    "people": "Built in: Sellbird reads each company's own site for the owner and the address pattern. "
              "No account, no cost.",
}

# What each job is, the one service recommended for it, and why that one.
JOBS = {
    "warmup": {
        "label": "Warm up your mailbox",
        "service": "trulyinbox",
        "why": "It warms a new mailbox before cold email and keeps it out of spam after, and Sellbird "
               "reads its inbox rate to tell you when you are ready.",
    },
    "verify": {
        "label": "Check addresses before sending",
        "service": "reoon",
        "why": "The best free tier for cold-email checks: 600 a month. For Microsoft 365 and Google "
               "Workspace domains that accept any address, add ZeroBounce too.",
    },
    "verify_catchall": {
        "label": "Check addresses at Microsoft 365 and Google Workspace domains",
        "service": "zerobounce",
        "why": "The one that tells real addresses from fake ones at domains that accept everything. "
               "100 free a month.",
    },
    "businesses": {
        "label": "Find more businesses",
        "service": "dataforseo",
        "why": "The most complete list of local businesses for the price: about $0.37 per 1,000, with "
               "phone, rating and whether they have a website. $1 of free credit to try it.",
    },
    "people": {
        "label": "Find the right person at each one",
        "service": "hunter",
        "why": "Its domain search learns a company's address pattern in one lookup, so Sellbird checks "
               "one address instead of guessing. 25 searches a month free.",
    },
}

AFFILIATE_TAG = "(affiliate link)"


def link(service: str) -> str:
    return SERVICES[service].url


def tag(service: str) -> str:
    """"(affiliate link)" for a service whose link is one, else ''."""
    return AFFILIATE_TAG if SERVICES[service].affiliate else ""


def tag_for_url(url: str) -> str:
    """"(affiliate link)" when ``url`` is one of the affiliate links here."""
    return AFFILIATE_TAG if any(s.affiliate and s.url == url for s in SERVICES.values()) else ""


def affiliates() -> list[str]:
    return [s.name for s in SERVICES.values() if s.affiliate]


def _names(names: list[str]) -> str:
    return names[0] if len(names) == 1 else ", ".join(names[:-1]) + " and " + names[-1]


def disclosure() -> str:
    """The one disclosure line, naming every service whose link is an
    affiliate link. '' when none is."""
    names = affiliates()
    if not names:
        return ""
    return (f"{_names(names)} links in this project are affiliate links: the maintainer may earn a "
            "commission, at no extra cost to you.")


DISCLOSURE = disclosure()


def job(name: str) -> dict:
    """One job, with its service's name, link and whether it is an affiliate link."""
    entry = JOBS[name]
    service = SERVICES[entry["service"]]
    return {"job": name, **entry, "name": service.name, "url": service.url,
            "affiliate": service.affiliate, "free": FREE.get(name, "")}


def all_jobs() -> dict:
    """Every job and the disclosure, for the dashboard."""
    return {"jobs": {name: job(name) for name in JOBS}, "disclosure": DISCLOSURE}
