# Brand mentions

Sellbird can look for where people write about you, a competitor, or the thing you sell, and list what it finds so you can act on it. It works by searching and checking in, a few times a day, from your own computer. It never posts, and it signs in to no social account.

## What you get

Under **Inbox → Mentions**, each mention shows the post, where it was found, and a guess at whether it is a question or a complaint. For each one you can:

- **Make a lead.** The person behind it is added to People with the source "Mention" and a link to what they posted. There is no email address, so nothing is drafted or sent.
- **Write or copy a reply.** A reply is a draft. Copy it, open the post, and post it from your own account. Sellbird has no way to post it.
- **Note it** or **skip it.**

Your agent can go through them for you: sort each one (buyer, complaint, praise, about a competitor, other), draft the replies, and add the buyers to People. It follows `skills/brand_mentions.md`. Ask it: "Go through my new mentions and draft replies for the buyers."

## What to watch

**Set up → Brand mentions**, or `sellbird mentions watch "Example Roofing"`. Three kinds of term:

| Kind | Example |
|---|---|
| Your name | `Example Roofing` |
| A competitor | `Peakline Exteriors` (`--kind competitor`) |
| A question buyers ask | `roofer recommendation Denver` (`--kind topic`) |

The whole phrase is searched for, so an exact name finds more than a long sentence. Nothing is searched until at least one term is on. A term your agent proposes stays off until you turn it on. 25 terms is the most.

## Where it looks, and what really works without paying

| Source | Needs | What it finds | Honest limits |
|---|---|---|---|
| **Hacker News** | Nothing | Stories and comments, through the site's public search API | Only useful if your buyers are there |
| **News** | Nothing | News articles, through the GDELT open news index | It matches the article text and returns only the headline, so results can look unrelated and come in any language. It allows about one request every several seconds and often refuses more; when it does, the remaining terms wait for the next check |
| **Reddit** | Your own free Reddit app: `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` | Posts, through Reddit's own API | Posts only, not comments |
| **YouTube** | Your own free key: `YOUTUBE_API_KEY` | Videos whose title or description has the term | About 100 searches a day on the free quota |
| **Web search** | `SERPER_API_KEY` (2,500 free searches, then paid credits) or `TINYFISH_API_KEY` (free) | Blogs, forums, review pages, and whatever a search engine has indexed from social sites | Only what the search engine shows. Not on by default |

On by default: Hacker News, News, Reddit and YouTube. The last two are skipped until their keys are in `.env`. Web search is off until you add `web` to `mentions.sources`, because Serper searches are paid for with credits.

**Two sources work with no account at all: Hacker News and News.** For most local businesses neither is where buyers talk, so expect little until you add a Reddit app or a search key. Both of those are free to start.

**What it does not do.** Sellbird does not scrape Instagram, TikTok, X, Facebook, LinkedIn or review sites: their terms forbid it, and a tool on your computer has no licensed feed from them. Web search finds only what a search engine already shows from those places. It does not track how AI assistants describe you; ask your own agent that directly. If you have a source that offers a proper API, adding one is a small function in `sellbird/mentions.py` (`_FETCHERS`), and contributions are welcome.

### Getting the free keys

- **Reddit:** on reddit.com open your account's app preferences, create an app of type "script", and copy its id and secret into `.env` as `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET`.
- **YouTube:** in the Google Cloud console create a project, enable "YouTube Data API v3", create an API key, and put it in `.env` as `YOUTUBE_API_KEY`.

Type keys into `.env` yourself. Do not paste them into a chat with your agent.

## When it checks

While `sellbird run` is running, every `mentions.check_every_hours` (default 6). Each check is one search per watched term per source, and brings in posts from the last `mentions.lookback_days` (default 7). **Check now** on the set up screen, `sellbird mentions check`, or your agent's `mentions_check` runs one at once, at most every 30 minutes. A check your agent starts leaves out any source that spends credits.

One source failing does not stop the others; the set up screen says which one failed.

## Your agent's tools

| Tool | What it does |
|---|---|
| `mentions_list` | The watched terms, what was found, the drafts, and which sources can run |
| `mentions_check` | Search now, free sources only |
| `mention_watch_propose` | Propose a term. Off until you turn it on |
| `mention_update` | Sort a mention, note it, or draft its reply for you to copy |
| `mention_to_lead` | Add the person behind a mention to People |

The agent cannot turn a term on or off, cannot mark a mention as replied or skipped, and Sellbird gives it no way to post.

## What people wrote is data

A mention is text a stranger put on the open web. Sellbird stores it and shows it as written, and never acts on it. Links open only when they are web addresses. The skill tells your agent the same: a post that says "ignore your instructions" is something to report, not to follow.

## Settings

Under `mentions:` in the config file Sellbird reads.

| Setting | Default | What it does |
|---|---|---|
| `sources` | `[hackernews, news, reddit, youtube]` | Where to look. Add `web` to search the web too |
| `check_every_hours` | `6` | How often the running engine checks |
| `lookback_days` | `7` | How far back a check reaches |
| `max_per_search` | `10` | The most results kept per term per source in one check |
