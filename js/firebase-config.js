/**
 * Firebase bootstrap. This is the only file that knows the project's
 * Firebase config — every other script talks to
 * `firebaseAuth`/`firebaseDb`/`firebaseAnalytics` (or checks
 * `firebaseReady`), never `firebase` directly, so swapping projects or SDK
 * versions later only ever touches this one file.
 *
 * Uses the Firebase compat SDK (not the modular v9+ API) so it can be
 * loaded with plain <script> tags and used from the rest of the site's
 * existing non-module scripts (data.js, app.js, etc.) exactly like they
 * already use each other's globals — no bundler, no <script type="module">
 * restructuring required.
 *
 * Login/saving is an optional enhancement, not a requirement to use the
 * tool (see auth.js / app.js) -- so if the Firebase SDK fails to load or
 * initialize (offline, ad blocker, network policy), the survey/results/
 * simulation experience must keep working exactly as it does for a signed-
 * out visitor. `firebaseReady` is what the rest of the app checks before
 * touching auth/Firestore.
 *
 * 2026-08-23: added Analytics (basic automatic pageview/session tracking
 * only -- no custom events). Deliberately initialized in its own try/catch,
 * separate from Auth/Firestore and not gated behind `firebaseReady`: an ad
 * blocker or privacy extension commonly blocks Analytics/gtag specifically
 * without touching Auth/Firestore, and the reverse (Auth/Firestore failing
 * for some other reason) shouldn't skip trying Analytics too. Both still
 * share the one `app` from the single initializeApp() call below -- never a
 * second app instance.
 */

// The site's own live URL — used as the "continue" destination Firebase
// sends a user back to after they finish a hosted flow (currently: the
// password reset email's confirmation page). This domain MUST be present
// under Authentication > Settings > Authorized domains in the Firebase
// console, or sendPasswordResetEmail will throw auth/unauthorized-continue-uri.
// Firebase only adds `localhost` and the project's own *.firebaseapp.com
// there by default -- a custom domain like truenorthportfolios.com is not
// added automatically just because email/password sign-in already works
// from it (that list is specifically consulted for continue/redirect URLs,
// not for the sign-in calls themselves), so this needs to be checked in the
// console.
const siteUrl = 'https://truenorthportfolios.com/';

// A shared-portfolio link normally points straight at this site with
// ?shared=<id> -- fine to open, but its link-preview in iMessage/Slack/etc.
// shows this site's one generic, static <meta> title (see index.html),
// never anything about the specific portfolio, since those unfurlers read
// raw HTML and don't run this site's JavaScript. Setting this to a
// deployed cloudflare-worker/share-preview.js Worker's URL (see that
// folder's README) makes the share button build links through it instead,
// so the preview reads "Check Out My Portfolio in TrueNorth" with a
// description built from that specific portfolio. Left null, "Share My
// Results" still works exactly as before -- just with the generic preview.
const SHARE_PREVIEW_BASE_URL = null; // e.g. 'https://truenorth-share.your-name.workers.dev'

const firebaseConfig = {
  apiKey: 'AIzaSyDwwUO4RwXYDP-x6r5L5pea3vEbX7qrWZI',
  authDomain: 'truenorth-a93e7.firebaseapp.com',
  projectId: 'truenorth-a93e7',
  storageBucket: 'truenorth-a93e7.firebasestorage.app',
  messagingSenderId: '408813459640',
  appId: '1:408813459640:web:8dcc1960040259ae86bc4d',
  measurementId: 'G-DNEQFP39BS',
};

let firebaseReady = false;
let firebaseAuth = null;
let firebaseDb = null;
let firebaseAnalytics = null;

let firebaseApp = null;
try {
  if (typeof firebase === 'undefined') {
    throw new Error('Firebase SDK did not load (script blocked or offline).');
  }
  firebaseApp = firebase.initializeApp(firebaseConfig);
} catch (err) {
  console.warn('Firebase unavailable — account features (save/load results) and analytics are disabled; the survey itself is unaffected.', err);
}

if (firebaseApp) {
  try {
    firebaseAuth = firebase.auth();
    firebaseDb = firebase.firestore();
    firebaseReady = true;
  } catch (err) {
    console.warn('Firebase Auth/Firestore unavailable — account features (save/load results) are disabled; the survey itself is unaffected.', err);
  }

  try {
    firebaseAnalytics = firebase.analytics();
  } catch (err) {
    console.warn('Firebase Analytics unavailable (often blocked by ad/privacy blockers) — pageview tracking is disabled; nothing else on the site is affected.', err);
  }
}

// Shared custom-event logger, called from auth.js/ticker-tester.js/app.js
// (all loaded after this file, so this global is already defined by the
// time they run -- same cross-file pattern the rest of the site already
// relies on). A no-op whenever firebaseAnalytics never initialized (ad/
// privacy blocker, offline) -- every call site above stays unconditional,
// this is the one place that knows whether logging is actually possible.
function logAnalyticsEvent(name, params) {
  if (!firebaseAnalytics) return;
  try {
    firebaseAnalytics.logEvent(name, params);
  } catch (err) {
    console.warn(`Analytics event "${name}" failed to log:`, err);
  }
}
