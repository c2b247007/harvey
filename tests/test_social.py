"""Social playbooks and post drafts: which playbooks are on, a draft that
waits, and the rule that nothing unapproved is ever recorded as posted."""

from pathlib import Path

import pytest

from sellbird import agent_policy, social
from tests.test_dashboard_signals import client  # noqa: F401  (fixture)
from tests.test_outbox_native import state  # noqa: F401  (fixture)
from tests.test_suite_screens import agent  # noqa: F401  (fixture)

SHIPPED = Path(__file__).resolve().parent.parent / "skills"
BOOK = """---
name: Shop news
platforms: [linkedin, x]
cadence: Weekly
summary: What changed in the shop
---
# Shop news

Say what changed.
"""


@pytest.fixture
def books(tmp_path):
    (tmp_path / "social_shop_news.md").write_text(BOOK)
    (tmp_path / "social_Bad Name.md").write_text(BOOK)      # not a key: left out
    (tmp_path / "email_frameworks.md").write_text("not a playbook")
    return [tmp_path]


def test_a_playbook_file_gives_its_name_platforms_and_guidance(books):
    found = social.playbooks(books)
    assert [b["key"] for b in found] == ["shop_news"]
    book = found[0]
    assert (book["name"], book["platforms"], book["cadence"]) == ("Shop news", ["linkedin", "x"], "Weekly")
    assert book["text"].startswith("# Shop news") and "---" not in book["text"]


def test_the_shipped_playbooks_all_read_and_your_own_file_wins(tmp_path):
    shipped = {b["key"]: b for b in social.playbooks([SHIPPED])}
    assert {"finished_work", "customer_questions", "what_we_learned", "local_and_seasonal", "proof"} <= set(shipped)
    assert all(b["summary"] and b["cadence"] and b["platforms"] and len(b["text"]) > 300 for b in shipped.values())
    assert set(social.PLATFORMS) == {p for b in shipped.values() for p in b["platforms"]}
    assert "posting_to_social" not in shipped       # the how-to is not a playbook
    (tmp_path / "social_proof.md").write_text(BOOK.replace("Shop news", "My own proof"))
    assert social.playbook("proof", [tmp_path, SHIPPED])["name"] == "My own proof"


def test_no_shipped_playbook_or_skill_uses_a_long_dash():
    for path in list(SHIPPED.glob("social_*.md")) + [SHIPPED / "posting_to_social.md", SHIPPED / "brand_mentions.md"]:
        assert chr(8212) not in path.read_text(), path.name


@pytest.mark.asyncio
async def test_a_draft_needs_a_playbook_that_is_on_and_fits_the_platform(state, books):
    off = await social.draft(state, playbook_key="shop_news", platform="x", body="New hours.", folders=books)
    assert not off["success"] and "is off" in off["message"]
    assert not (await social.set_active(state, "nope", True, books))["success"]
    assert (await social.set_active(state, "shop_news", True, books))["success"]

    assert not (await social.draft(state, playbook_key="shop_news", platform="instagram", body="Hi", folders=books))["success"]
    assert not (await social.draft(state, playbook_key="shop_news", platform="tiktok", body="Hi", folders=books))["success"]
    long = await social.draft(state, playbook_key="shop_news", platform="x", body="a" * 281, folders=books)
    assert not long["success"] and "280" in long["message"]
    ok = await social.draft(state, playbook_key="shop_news", platform="x", body="New hours from Monday.", by="agent",
                            media_note="The photo of the new sign", folders=books)
    assert ok["success"] and ok["status"] == "pending_review"
    seen = await social.overview(state, books)
    assert [p["id"] for p in seen["waiting"]] == [ok["id"]] and seen["waiting"][0]["playbook_name"] == "Shop news"
    assert seen["playbooks"][0]["active"] is True and "text" not in seen["playbooks"][0]


@pytest.mark.asyncio
async def test_only_an_approved_post_can_be_marked_posted(state, books):
    await social.set_active(state, "shop_news", True, books)
    post = (await social.draft(state, playbook_key="shop_news", platform="linkedin", body="First draft.", folders=books))["id"]
    early = await social.mark_posted(state, post, url="https://social.example/p/1", by="agent")
    assert not early["success"] and "approved" in early["message"]
    assert (await social.edit(state, post, "Second draft."))["success"]
    assert (await social.approve(state, post, body="The words I approved."))["success"]
    assert not (await social.approve(state, post))["success"]            # once
    assert not (await social.edit(state, post, "Changed after approval."))["success"]
    assert (await state.get_social_post(post))["body"] == "The words I approved."
    assert not (await social.mark_posted(state, post, url="javascript:alert(1)"))["success"]
    done = await social.mark_posted(state, post, url="https://social.example/p/1", by="agent")
    assert done["success"]
    row = await state.get_social_post(post)
    assert (row["status"], row["posted_url"]) == ("posted", "https://social.example/p/1") and row["posted_at"]
    assert not (await social.skip(state, post))["success"]              # a posted one stays posted


@pytest.mark.asyncio
async def test_drafts_stop_when_too_many_are_waiting(state, books, monkeypatch):
    monkeypatch.setattr(social, "MAX_WAITING", 2)
    await social.set_active(state, "shop_news", True, books)
    for n in range(2):
        assert (await social.draft(state, playbook_key="shop_news", platform="x", body=f"Post {n}", folders=books))["success"]
    full = await social.draft(state, playbook_key="shop_news", platform="x", body="One more", folders=books)
    assert not full["success"] and "already waiting" in full["message"]


def test_the_agent_drafts_and_reads_but_every_switch_and_approval_is_yours(client, agent):  # noqa: F811
    listed = agent.get("/api/social").json()
    keys = [b["key"] for b in listed["playbooks"]]
    assert "finished_work" in keys and not any(b["active"] for b in listed["playbooks"])
    assert agent.post("/api/social/playbooks/finished_work", json={"active": True}).status_code == 403
    refused = agent.post("/api/social/posts", json={"playbook": "finished_work", "platform": "linkedin", "body": "Hi"})
    assert refused.status_code == 409 and "is off" in refused.json()["message"]

    assert client.post("/api/social/playbooks/finished_work", json={"active": True}).json()["success"]
    full = agent.get("/api/social/playbooks/finished_work").json()
    assert full["active"] is True and "Never invent a job" in full["text"]
    drafted = agent.post("/api/social/posts", json={"playbook": "finished_work", "platform": "linkedin",
                                                    "body": "Alder Street, before and after."})
    assert drafted.status_code == 200
    post = drafted.json()["id"]
    for action in ("approve", "edit", "skip"):
        assert agent.post(f"/api/social/posts/{post}/{action}", json={"body": "x"}).status_code == 403
    assert agent.post(f"/api/social/posts/{post}/posted", json={}).status_code == 409    # not approved yet
    today = client.get("/api/today").json()
    assert today["stats"]["social_waiting"] == 1 and any(i["key"] == "social" for i in today["items"])
    assert client.post(f"/api/social/posts/{post}/approve", json={}).json()["success"]
    assert agent.post(f"/api/social/posts/{post}/posted", json={"url": "https://social.example/p/9"}).status_code == 200
    assert client.post(f"/api/social/posts/{post}/nonsense", json={}).status_code == 404
    assert not agent_policy.agent_may("POST", f"/api/social/posts/{post}/approve")


@pytest.mark.asyncio
async def test_the_mcp_tools_reach_the_social_routes():
    from sellbird import mcp_server
    calls = []

    class Client:
        async def get(self, path):
            calls.append(("GET", path, None))
            return {"ok": True}

        async def post(self, path, body=None):
            calls.append(("POST", path, body))
            return {"ok": True}

    server = mcp_server.build_server(lambda: Client())
    names = {t.name for t in await server.list_tools()}
    assert {"social_playbooks", "social_playbook_get", "social_post_draft", "social_post_mark_posted"} <= names
    assert not any("approve" in n for n in names)
    await server.call_tool("social_post_draft", {"playbook": "proof", "platform": "x", "body": "Hi"})
    await server.call_tool("social_post_mark_posted", {"post_id": "p/1", "url": "https://social.example/1"})
    assert calls[0][:2] == ("POST", "/api/social/posts") and calls[0][2]["platform"] == "x"
    assert calls[1][:2] == ("POST", "/api/social/posts/p%2F1/posted")
