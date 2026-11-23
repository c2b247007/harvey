# Posting to social

How to use Sellbird's social playbooks. You draft, the user approves, and only then does anything get posted. Sellbird itself posts nothing and holds no social login.

## The loop

1. `social_playbooks` lists the playbooks and which ones the user switched on. Work only from those. If none is on, say so and stop: only the user can switch one on (Set up, Social).
2. `social_playbook_get` gives you one playbook in full. Follow it: what it needs from the user before drafting, the shape, the length for each platform, and what not to do.
3. `social_post_draft` saves one post for one platform. It waits for the user. Draft one post at a time and say what you drafted. Do not queue a week of posts unasked.
4. The user approves, edits or skips it in the dashboard. You cannot approve.
5. An approved post appears under `approved` in `social_playbooks`. The user either posts it themselves, or asks you to.
6. If the user asks you to post it and has connected that social account to you, post the approved text exactly as approved, then call `social_post_mark_posted` with the link.

## Rules

- **Never post anything that is not approved.** Not a "small fix", not a reply, not a repost. If the approved text needs a change, draft a new post.
- **Post the exact text.** Same words, same line breaks. The approval is for those words.
- **Only the user's own accounts.** Never create an account. Never ask for a social password. If the account is not connected to you, tell the user to post it themselves or connect it in your own settings, not in Sellbird.
- **No engagement on their behalf.** Do not like, follow, comment or message as the user unless they ask for that one action.
- **Real things only.** Every playbook says what it needs from the user. If you do not have it, ask. Never invent a job, a customer, a quote, a number or an event.
- **One voice.** Write the way the user writes. Read their approved posts and their emails first. No hashtag walls, no emoji they would not use, no "excited to announce".
- **Platform limits.** X: 280 characters. Instagram: 2,200. Sellbird refuses a draft that is too long.

## Making a playbook

A playbook is a markdown file named `social_<name>.md` in the user's `skills` folder, starting with four lines between `---` marks: `name`, `platforms`, `cadence` and `summary`. Copy one of the shipped ones. The user switches it on in the dashboard.
