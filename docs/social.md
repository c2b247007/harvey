# Social playbooks

Sellbird keeps the playbooks your own agent writes social posts from, and holds every drafted post until you approve it. That is all it does on social: **it posts nothing, and it stores no social login.**

## How it works

1. **You switch on the playbooks you want.** Set up → Social, or `sellbird social on finished_work`. All of them start off.
2. **Your agent drafts a post** from a playbook that is on, for one platform. Ask it: "Draft a LinkedIn post about the job we finished this week."
3. **The draft waits for you.** Approve it, edit it, or skip it, on the same screen. Today shows when one is waiting.
4. **An approved post goes out one of two ways, both yours.** Copy it and post it yourself. Or, if you connected that social account to your agent, ask the agent to post it; it posts the exact text you approved and marks it as posted with the link.

Sellbird runs on your own computer and reaches out to no social network. Posting through your agent uses whatever connection you gave that agent, in the agent's own settings. Sellbird never sees those credentials.

## What the approval is, honestly

Sellbird gives your agent no way to approve a post, and refuses to mark a post as posted unless you approved it. It cannot stop a tool outside Sellbird: an agent that has its own connection to a social account could post without asking. The skill your agent reads (`skills/posting_to_social.md`) tells it never to post anything unapproved and to post the approved text exactly. If you want a hard guarantee, do not connect social accounts to your agent, and post by hand.

## The playbooks Sellbird ships

| Playbook | Platforms | For |
|---|---|---|
| **Finished work** (`finished_work`) | LinkedIn, Facebook, Instagram | A before and after of a job you just completed |
| **Customer questions** (`customer_questions`) | LinkedIn, Facebook, Instagram, X | One question customers really ask, answered properly |
| **What we learned** (`what_we_learned`) | LinkedIn, X | One honest lesson from running the business |
| **Local and seasonal** (`local_and_seasonal`) | Facebook, Instagram, LinkedIn | A timely note tied to something happening where your customers are |
| **In their words** (`proof`) | LinkedIn, Facebook, Instagram | A customer's own words, quoted exactly and with their say-so |

Each says what the agent needs from you before drafting, the shape of a post, the length for each platform, and what not to do. Every one of them forbids inventing a job, a customer, a quote or a number.

## Your own playbooks

A playbook is a markdown file in your `skills` folder named `social_<name>.md`, starting with four header lines:

```markdown
---
name: Shop news
platforms: linkedin, facebook
cadence: Weekly
summary: What changed in the shop this week
---
# Shop news

What to write, how long, and what to leave out.
```

`platforms` is any of `linkedin`, `instagram`, `facebook`, `x`. A file of yours with the same name as a shipped one replaces it. It shows up on the Social screen at once, switched off.

## Limits

- X: 280 characters. Instagram: 2,200. LinkedIn: 3,000. Facebook: 2,000. A longer draft is refused.
- 20 drafts can wait at once. Past that, drafting is refused until you approve or skip some.
- Sellbird stores the text and a note about which photos go with it. It stores no images.

## Your agent's tools

| Tool | What it does |
|---|---|
| `social_playbooks` | The playbooks, which are on, and every post waiting, approved or recent |
| `social_playbook_get` | One playbook in full |
| `social_post_draft` | Draft one post. It waits for you |
| `social_post_mark_posted` | Record that a post you approved went out. Refused for any other post |

The agent cannot switch a playbook on, approve, edit or skip.

## Commands

```bash
sellbird social                    # playbooks, and posts waiting or approved
sellbird social on finished_work   # switch a playbook on (off to switch it off)
sellbird social approve POST_ID    # approve a waiting post (skip to skip it)
```
