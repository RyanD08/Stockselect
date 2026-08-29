/**
 * TrueNorth share-link preview worker.
 *
 * WHY THIS EXISTS: GitHub Pages serves one static index.html with no
 * server, so the site's <meta property="og:*"> tags are the same for
 * every URL -- a link-preview unfurler (iMessage, Slack, Twitter,
 * Facebook) always sees the generic homepage title/description, even for
 * a specific shared-portfolio link, because those unfurlers fetch raw
 * HTML and never run the site's own JavaScript.
 *
 * This Cloudflare Worker sits in front of a NEW url pattern --
 * /s/{shareId} -- that the "Share My Results" button generates instead of
 * the plain site link. For that one path, it:
 *   1. Reads the shared/{shareId} doc straight from Firestore's public
 *      REST API (no credentials needed beyond the same public Web API key
 *      already embedded in js/firebase-config.js -- the shared/{shareId}
 *      Firestore rule already allows anyone to `get` it, this is just a
 *      server calling the same public endpoint the browser SDK would).
 *   2. Returns a tiny real HTML page with og:title "Check Out My New
 *      Portfolio Built by True North" and an og:description summarizing
 *      the risk profile, holding count, and a few tickers -- built at
 *      request time, so it's per-link, not one static tag.
 *   3. Immediately redirects a real visitor (both a <meta refresh> and a
 *      JS location.replace, so it works whether or not the client runs
 *      JS) into the real interactive app at
 *      https://truenorthportfolios.com/?shared={shareId} -- a person
 *      clicking the link never actually sees this page, only unfurler bots
 *      (which don't follow the redirect) do.
 *
 * Any other path is passed straight through to the real site unchanged,
 * so this Worker can also front the whole domain later (e.g. if
 * truenorthportfolios.com itself gets pointed at Cloudflare) without
 * breaking normal traffic -- it only ever does something different for
 * /s/*.
 *
 * DEPLOY: see cloudflare-worker/README.md in this same folder.
 */

const SITE_URL = 'https://truenorthportfolios.com/';
const FIREBASE_PROJECT_ID = 'truenorth-a93e7';
const FIREBASE_API_KEY = 'AIzaSyDwwUO4RwXYDP-x6r5L5pea3vEbX7qrWZI'; // public client key, already shipped in js/firebase-config.js -- not a secret
const OG_IMAGE_URL = SITE_URL + 'assets/og-image.png';
const PREVIEW_TITLE = 'Check Out My New Portfolio Built by True North';

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Firestore's REST API returns each field typed (stringValue/arrayValue/
// mapValue/...) rather than plain JSON -- this pulls out just the shape
// createSharedResult (js/auth.js) actually writes.
async function fetchSharedResult(shareId) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/shared/${encodeURIComponent(shareId)}?key=${FIREBASE_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const doc = await res.json();
  const fields = doc.fields || {};
  const riskProfile = fields.riskProfile ? fields.riskProfile.stringValue : null;
  const holdingValues = fields.holdings && fields.holdings.arrayValue && fields.holdings.arrayValue.values ? fields.holdings.arrayValue.values : [];
  const holdings = holdingValues.map((v) => {
    const f = (v.mapValue && v.mapValue.fields) || {};
    return {
      ticker: f.ticker ? f.ticker.stringValue : '',
      tier: f.tier ? f.tier.stringValue : '',
    };
  });
  return { riskProfile, holdings };
}

function buildDescription(data) {
  if (!data || !data.holdings) return 'Build a values-guided, personalized portfolio with TrueNorth.';
  const count = data.holdings.length;
  const strongCount = data.holdings.filter((h) => h.tier === 'Strong').length;
  const tickers = data.holdings
    .slice(0, 3)
    .map((h) => h.ticker)
    .filter(Boolean)
    .join(', ');
  const parts = [];
  if (data.riskProfile) parts.push(`${data.riskProfile} risk profile`);
  if (count > 0) parts.push(`${count} holding${count === 1 ? '' : 's'}${strongCount > 0 ? ` (${strongCount} Strong Match)` : ''}`);
  if (tickers) parts.push(`including ${tickers}`);
  return parts.length > 0 ? parts.join(' — ') + '.' : 'Build a values-guided, personalized portfolio with TrueNorth.';
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/s\/([A-Za-z0-9_-]+)\/?$/);

    if (!match) {
      return fetch(SITE_URL + url.search);
    }

    const shareId = match[1];
    const data = await fetchSharedResult(shareId).catch((err) => {
      console.error('fetchSharedResult failed:', err);
      return null;
    });
    const description = buildDescription(data);
    const destination = `${SITE_URL}?shared=${encodeURIComponent(shareId)}`;

    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(PREVIEW_TITLE)}</title>
<meta property="og:type" content="website" />
<meta property="og:site_name" content="TrueNorth" />
<meta property="og:title" content="${escapeHtml(PREVIEW_TITLE)}" />
<meta property="og:description" content="${escapeHtml(description)}" />
<meta property="og:url" content="${escapeHtml(url.toString())}" />
<meta property="og:image" content="${escapeHtml(OG_IMAGE_URL)}" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${escapeHtml(PREVIEW_TITLE)}" />
<meta name="twitter:description" content="${escapeHtml(description)}" />
<meta name="twitter:image" content="${escapeHtml(OG_IMAGE_URL)}" />
<meta http-equiv="refresh" content="0; url=${escapeHtml(destination)}" />
<link rel="canonical" href="${escapeHtml(destination)}" />
</head>
<body>
<p>Redirecting to <a href="${escapeHtml(destination)}">your TrueNorth portfolio</a>…</p>
<script>location.replace(${JSON.stringify(destination)});</script>
</body>
</html>`;

    return new Response(html, {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  },
};
