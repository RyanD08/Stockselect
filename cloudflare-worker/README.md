# Share-link previews (Cloudflare Worker)

Makes a shared portfolio link (e.g. pasted into iMessage or Slack) show
**"Check Out My Portfolio in TrueNorth"** with a description built from that
specific portfolio, instead of the site's generic homepage preview.

This is a manual, one-time setup — Claude Code can't create a Cloudflare
account or deploy a Worker for you, the same way it can't deploy Firestore
rules. `share-preview.js` in this folder is the script to paste in.

## Why this needs its own piece

GitHub Pages serves one static `index.html` with no server, so its
`<meta property="og:*">` tags are identical for every URL. A link-preview
unfurler (iMessage, Slack, Twitter, Facebook) reads that raw HTML directly —
it never runs the site's JavaScript — so it always sees the same generic
title no matter which portfolio was shared. This Worker sits in front of a
new `/s/{shareId}` URL, builds the right preview tags per link at request
time, then instantly redirects a real visitor into the actual site.

## Setup (~10 minutes, free Cloudflare plan)

1. **Create a Cloudflare account** at [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up) if you don't already have one — no credit card required for this.
2. In the dashboard, go to **Workers & Pages** → **Create** → **Create Worker**.
3. Give it a name, e.g. `truenorth-share` — this becomes part of its free URL: `truenorth-share.<your-subdomain>.workers.dev`.
4. Click **Deploy** to create it with the default template, then **Edit code**.
5. Delete everything in the editor and paste in the full contents of `share-preview.js` from this folder.
6. Click **Deploy** again to publish.
7. Copy the Worker's URL shown at the top of the dashboard (something like `https://truenorth-share.your-name.workers.dev`).

## Turn it on in the site

Open `js/firebase-config.js` and set the constant near the top:

```js
const SHARE_PREVIEW_BASE_URL = 'https://truenorth-share.your-name.workers.dev'; // your real Worker URL from step 7
```

It starts as `null`, which makes "Share My Results" fall back to the plain
site link (works fine, just shows the generic preview) — nothing breaks if
you skip this setup entirely or do it later.

Then commit, push, and deploy that one-line change the normal way (or just
ask Claude Code to do it, mentioning the Worker URL from step 7).

## Testing a preview without waiting for a real message

Most link-unfurlers cache aggressively per URL, so testing with the exact
same share link twice can show a stale result. Two easy checkers that show
exactly what a bot would see:

- Slack: paste the link into any Slack message box (without sending) — the
  preview card appears in the composer itself.
- Generic: [opengraph.xyz](https://www.opengraph.xyz) — paste the `/s/...`
  link and it shows the resolved title/description/image directly.

## If something looks wrong

- **Preview shows the generic fallback description** ("Build a
  values-guided, personalized portfolio with TrueNorth.") instead of a
  specific one — the Worker couldn't read that `shareId` from Firestore.
  Confirm the link was generated *after* this Worker was turned on (step
  above), and that the Firestore rules from `firestore.rules` (the
  `shared/{shareId}` block) are actually published in the Firebase console.
- **Clicking the link doesn't land in the real app** — check the Worker's
  logs in the Cloudflare dashboard (Workers & Pages → your Worker →
  Logs) for the actual error.
