/**
 * Firebase bootstrap. This is the only file that knows the project's
 * Firebase config — every other script talks to `firebaseAuth`/`firebaseDb`
 * (or checks `firebaseReady`), never `firebase` directly, so swapping
 * projects or SDK versions later only ever touches this one file.
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
 */

// The site's own live URL — used as the "continue" destination Firebase
// sends a user back to after they finish a hosted flow (currently: the
// password reset email's confirmation page). This domain MUST be present
// under Authentication > Settings > Authorized domains in the Firebase
// console, or sendPasswordResetEmail will throw auth/unauthorized-continue-uri.
// Firebase only adds `localhost` and the project's own *.firebaseapp.com
// there by default -- a custom domain like ryand08.github.io is not added
// automatically just because email/password sign-in already works from it
// (that list is specifically consulted for continue/redirect URLs, not for
// the sign-in calls themselves), so this needs to be checked in the console.
const siteUrl = 'https://ryand08.github.io/Stockselect/';

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

try {
  if (typeof firebase === 'undefined') {
    throw new Error('Firebase SDK did not load (script blocked or offline).');
  }
  firebase.initializeApp(firebaseConfig);
  firebaseAuth = firebase.auth();
  firebaseDb = firebase.firestore();
  firebaseReady = true;
} catch (err) {
  console.warn('Firebase unavailable — account features (save/load results) are disabled; the survey itself is unaffected.', err);
}
