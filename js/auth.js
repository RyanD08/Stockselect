/**
 * Account layer: Firebase Authentication + Firestore save of a completed
 * survey's answers as a named "portfolio," plus the account-related UI
 * (header widget, login/sign-up screen, My Portfolios list).
 *
 * Kept separate from app.js on purpose: app.js owns the survey flow
 * (intro/survey/review/results) and knows nothing about accounts beyond
 * calling the functions here; this file owns everything account-related
 * and knows nothing about scoring/questions, except for the one place it
 * has to reach into the survey flow directly: loading a saved portfolio
 * sets app.js's `state.answers`/`touchedQuestionIds` and jumps straight to
 * the results view (see the "Load" handler in renderMyPortfolios below) --
 * there was no clean way to do that without either function knowing a
 * little about the other's state, and this direction (auth.js reaching
 * into `state`) already matches every other place these two files meet
 * (`state.view`, the results screen's Save control).
 *
 * Login is strictly optional — see firebase-config.js's `firebaseReady`.
 * Every function here checks it first and fails softly (never touches the
 * survey/results experience for a signed-out visitor).
 *
 * Naming note: the 27-question client survey itself is still "the survey"
 * everywhere (app.js, questions.js) -- only a *saved, completed* survey's
 * answers are called a "portfolio" here, since that's what a client is
 * actually naming/managing in this file's UI.
 *
 * 2026-08-23: reworked from a single "most recent survey" slot
 * (users/{uid}/savedSurvey/current) into up to MAX_SAVED_PORTFOLIOS named,
 * independently manageable saves, each rename-able and delete-able from a
 * My Portfolios list, and each loadable back into the survey/results flow.
 * Still answers + a timestamp only -- never the computed portfolio itself
 * -- plus an editable display name. The single-slot `savedSurvey`
 * collection this superseded, and the even earlier full-portfolio-snapshot
 * `surveys` collection before that, are both left alone in Firestore (and
 * firestore.rules) rather than migrated or deleted -- neither is read or
 * written by this file anymore.
 *
 * 2026-08-23b: renamed the saved-survey concept itself to "portfolio"
 * end-to-end, including the Firestore collection (`savedSurveys` ->
 * `savedPortfolios`). Unlike the rework above, this one DOES migrate:
 * migrateLegacySurveysIfNeeded() below copies each signed-in user's
 * existing `savedSurveys` docs into `savedPortfolios` (same doc ids, so
 * it's safe to re-run) the first time they open My Portfolios, verifies
 * every id landed before recording it done, and leaves the old
 * `savedSurveys` collection (and its firestore.rules entry) in place,
 * unread by the app from here on, exactly like the two legacy collections
 * before it.
 */

const authState = {
  user: null, // Firebase user object, or null when signed out
  ready: false, // true once the first onAuthStateChanged callback has fired (or Firebase is unavailable)
};

// UI-only state for the login/sign-up screen — separate from authState
// (which is real auth data) and from app.js's `state` (survey progress),
// since this is neither.
const authViewState = {
  mode: 'login', // 'login' | 'signup'
  loading: false,
  error: null,
  info: null,
};

// UI-only state for the My Portfolios list.
const myPortfoliosViewState = {
  loading: true,
  error: null,
  portfolios: [],
  renamingId: null, // id of the entry currently showing its rename input, or null
  confirmingDeleteId: null, // id of the entry currently showing its "are you sure?" prompt, or null
};

// Watchlist membership + the shared ☆/★ toggle button's own state -- kept
// separate from watchlistViewState below (the dedicated My Watchlist
// screen's own display state) since `tickers` needs to be known everywhere
// a toggle button can appear (Ticker Tester, Compare Two Companies, the
// main Results table), not just on the My Watchlist screen itself.
const watchlistState = {
  tickers: new Set(), // every ticker currently on this user's watchlist -- loaded eagerly, see loadWatchlistTickers
  loaded: false,
  pendingTicker: null, // ticker currently mid add/remove -- disables just that one button
  error: null, // most recent add/remove failure message, or null
  errorTicker: null, // which ticker's button should show `error` next to it
};

// UI-only state for the My Watchlist screen.
const watchlistViewState = {
  loading: true,
  error: null,
  entries: [], // [{ ticker, addedAt }], newest-first
  expandedTickers: new Set(), // tickers whose compact scoring detail is currently expanded
  addQuery: '', // the "add a company" search box's current text -- see renderWatchlistAddPicker
};

// Set when a signed-out visitor clicks "Save My Portfolio" on the results
// screen: their answers at that moment, held here until they finish
// logging in (or signing up), at which point onAuthStateChanged below
// saves them automatically with no second click required. Cleared as soon
// as it's consumed, or if they back out of the login screen instead.
let pendingSaveAnswers = null;

// Same pattern as pendingSaveAnswers above, for a signed-out visitor who
// clicked "Log In" from Ticker Tester's Compare-Two-Companies login
// prompt (see ticker-tester.js) -- no answers to stash here, just intent:
// once they finish logging in, onAuthStateChanged below sends them
// straight into Compare Two Companies (enterTickerCompare) instead of the
// usual "back to intro" landing, so they never have to click Compare a
// second time. Cleared as soon as it's consumed, or if they back out of
// the login screen instead.
let pendingCompareRedirect = false;

// Same pattern again, for a signed-out visitor who clicked ☆ Add to
// Watchlist somewhere (Ticker Tester, Compare Two Companies, or a Results
// table row -- see renderWatchlistToggleButton). Unlike the two above,
// this one can be triggered from several different screens, so the screen
// to return to once login finishes is stashed alongside it rather than
// being a fixed destination.
let pendingWatchlistAdd = null; // ticker, or null
let pendingWatchlistReturnView = null; // state.view to restore once the add completes

// Same pattern once more, for the hamburger nav menu's own My Portfolios
// and My Watchlist items (see renderSiteNavMenu, app.js) -- a logged-out
// click redirects to login and, once signed in, navigates straight to the
// screen they were trying to reach. Kept as their own flags (mirroring
// pendingCompareRedirect's own name/shape) rather than reusing
// pendingWatchlistAdd, which is scoped to adding one specific ticker, not
// "just open the My Watchlist screen."
let pendingPortfoliosRedirect = false;
let pendingWatchlistViewRedirect = false;

// Firebase Auth's error codes (e.g. "auth/wrong-password") are never shown
// to the client directly -- always translated to plain language here.
const AUTH_ERROR_MESSAGES = {
  'auth/email-already-in-use': 'An account already exists with this email. Try logging in instead.',
  'auth/invalid-email': "That doesn't look like a valid email address.",
  'auth/weak-password': 'Choose a password with at least 6 characters.',
  'auth/wrong-password': 'Incorrect password. Try again, or use "Forgot password?" below.',
  'auth/user-not-found': 'No account found with that email.',
  'auth/invalid-credential': 'Incorrect email or password.',
  'auth/missing-password': 'Enter a password.',
  'auth/too-many-requests': 'Too many attempts. Please wait a moment and try again.',
  'auth/network-request-failed': 'Network error — check your connection and try again.',
  'auth/user-disabled': 'This account has been disabled.',
};

function friendlyAuthError(err) {
  return AUTH_ERROR_MESSAGES[err && err.code] || 'Something went wrong. Please try again.';
}

// Firestore save/load/rename/delete errors are still logged in full to the
// console (see the catches below), but unlike auth errors above they also
// show their raw code on-screen -- something like "permission-denied" or
// "unavailable" is actually diagnosable by a client without opening
// devtools, and surfacing it turns a "still doesn't work" report into an
// actionable one instead of a black box.
function describeFirestoreError(err, action) {
  const code = err && err.code;
  return code ? `${action} (${code}). Please try again.` : `${action}. Please try again.`;
}

// --- Firebase Auth actions --------------------------------------------

async function signUp(email, password) {
  if (!firebaseReady) throw new Error('Account features are unavailable right now.');
  const credential = await firebaseAuth.createUserWithEmailAndPassword(email, password);
  return credential.user;
}

async function logIn(email, password) {
  if (!firebaseReady) throw new Error('Account features are unavailable right now.');
  const credential = await firebaseAuth.signInWithEmailAndPassword(email, password);
  return credential.user;
}

async function logOut() {
  if (!firebaseReady) return;
  await firebaseAuth.signOut();
}

async function resetPassword(email) {
  if (!firebaseReady) throw new Error('Account features are unavailable right now.');
  // actionCodeSettings.url makes Firebase's hosted "your password has been
  // reset" confirmation page show a "Continue" link back to the site,
  // instead of leaving the user stranded there. See firebase-config.js for
  // the siteUrl constant and the Authorized domains requirement.
  await firebaseAuth.sendPasswordResetEmail(email, { url: siteUrl });
}

if (firebaseReady) {
  firebaseAuth.onAuthStateChanged(async (user) => {
    authState.user = user;
    authState.ready = true;
    renderAccountWidget();
    renderSiteNavMenu(); // js/app.js -- refreshes the hamburger dropdown's email line

    if (user) {
      // Fire-and-forget: populates watchlistState.tickers so every ☆/★
      // toggle button (Ticker Tester, Compare, Results table) shows the
      // right state as soon as possible, not just once My Watchlist is
      // opened. One small read of this user's (<= 20-doc) watchlist per
      // sign-in/page-load -- an accepted, deliberate cost for correctness
      // everywhere rather than plumbing a "have I checked yet" flag through
      // every render call site that can show a toggle button.
      loadWatchlistTickers();
    } else {
      watchlistState.tickers = new Set();
      watchlistState.loaded = false;
    }

    if (user && pendingSaveAnswers) {
      // A signed-out visitor clicked "Save My Portfolio," was redirected
      // here to log in, and has now done so -- finish the save they
      // started without making them click it again, then take them back to
      // their results with the same "Saved!" confirmation the normal flow
      // shows.
      const answersToSave = pendingSaveAnswers;
      pendingSaveAnswers = null;
      try {
        await saveNewPortfolio(answersToSave);
        state.saveResultState = { status: 'saved', errorMessage: null };
        scheduleSaveResultRevert();
      } catch (err) {
        console.error('saveNewPortfolio failed (post-login auto-save):', err);
        state.saveResultState =
          err && err.code === 'portfolio-limit-reached'
            ? { status: 'limit-reached', errorMessage: err.message }
            : { status: 'error', errorMessage: describeFirestoreError(err, 'Could not save your portfolio') };
      }
      state.view = 'results';
      render();
      return;
    }

    if (user && pendingCompareRedirect) {
      // A signed-out visitor clicked "Log In" from the Compare-Two-
      // Companies prompt and has now done so -- take them straight into
      // compare mode instead of the usual intro landing below, no second
      // click on the Compare button required.
      pendingCompareRedirect = false;
      enterTickerCompare(); // js/ticker-tester.js
      return;
    }

    if (user && pendingWatchlistAdd) {
      // A signed-out visitor clicked ☆ Add to Watchlist somewhere, was
      // redirected here to log in, and has now done so -- finish that add
      // automatically (no second click), then return them to whichever
      // screen they were actually on (Ticker Tester, Compare, or Results),
      // not a fixed destination like the two pending flows above.
      const ticker = pendingWatchlistAdd;
      const returnView = pendingWatchlistReturnView || 'intro';
      pendingWatchlistAdd = null;
      pendingWatchlistReturnView = null;
      try {
        await addToWatchlist(ticker);
        watchlistState.tickers.add(ticker);
      } catch (err) {
        console.error('addToWatchlist failed (post-login auto-add):', err);
        watchlistState.error =
          err && err.code === 'watchlist-limit-reached' ? err.message : describeFirestoreError(err, 'Could not add to your watchlist');
        watchlistState.errorTicker = ticker;
      }
      state.view = returnView;
      render();
      return;
    }

    if (user && pendingPortfoliosRedirect) {
      // The hamburger nav's "My Portfolios" was clicked while signed out --
      // now signed in, so go straight there instead of the usual intro
      // landing below.
      pendingPortfoliosRedirect = false;
      openMyPortfoliosView();
      return;
    }

    if (user && pendingWatchlistViewRedirect) {
      // Same, for the hamburger nav's "My Watchlist".
      pendingWatchlistViewRedirect = false;
      openMyWatchlistView();
      return;
    }

    if (state.view === 'account' && user) {
      // Just signed in from the login screen (not via the pending-save
      // path above) -- head back to the intro screen rather than leaving
      // them sitting on a login form.
      state.view = 'intro';
      render();
    } else if (state.view === 'results') {
      // Refresh the Save-My-Portfolio control for the new auth state.
      render();
    }
  });
} else {
  // No Firebase available -- resolve immediately as "signed out" so the
  // account widget and results screen don't wait forever for a callback
  // that will never fire.
  authState.ready = true;
}

// --- Firestore: save/rename/delete/list portfolios (saved survey answers) --

const MAX_SAVED_PORTFOLIOS = 5;

function savedPortfoliosCollection() {
  return firebaseDb.collection('users').doc(authState.user.uid).collection('savedPortfolios');
}

function legacySavedSurveysCollection() {
  return firebaseDb.collection('users').doc(authState.user.uid).collection('savedSurveys');
}

function migrationStateDoc() {
  return firebaseDb.collection('users').doc(authState.user.uid).collection('meta').doc('migration');
}

function formatAutoPortfolioName(date) {
  return `Portfolio — ${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

// One-time-per-user copy of the old `savedSurveys` collection into the
// current `savedPortfolios` one, run lazily from listSavedPortfolios()
// below (so it happens the first time a signed-in user opens My
// Portfolios, and nowhere else). Preserves each
// document's original id, so copying the same source doc twice is a no-op
// overwrite rather than a duplicate -- safe to retry on a partial failure.
// Only marks itself done in migrationStateDoc() once every copied id is
// verified present in savedPortfolios; if verification fails, the marker
// is left unset so the next call retries rather than silently losing data.
// The `savedSurveys` originals are never deleted here (same as every
// other legacy collection in this file/firestore.rules).
async function migrateLegacySurveysIfNeeded() {
  if (!firebaseReady || !authState.user) return;

  const marker = migrationStateDoc();
  const markerSnap = await marker.get();
  if (markerSnap.exists && markerSnap.data().savedSurveysMigrated) return;

  const legacySnap = await legacySavedSurveysCollection().get();
  if (legacySnap.empty) {
    await marker.set({ savedSurveysMigrated: true, migratedCount: 0 }, { merge: true });
    return;
  }

  const portfoliosColl = savedPortfoliosCollection();
  await Promise.all(legacySnap.docs.map((doc) => portfoliosColl.doc(doc.id).set(doc.data(), { merge: true })));

  const verifySnap = await portfoliosColl.get();
  const verifiedIds = new Set(verifySnap.docs.map((doc) => doc.id));
  const allPresent = legacySnap.docs.every((doc) => verifiedIds.has(doc.id));
  if (!allPresent) {
    console.error('Legacy savedSurveys -> savedPortfolios migration incomplete; will retry next time.');
    return;
  }

  await marker.set({ savedSurveysMigrated: true, migratedCount: legacySnap.size }, { merge: true });
}

// Enforces the 5-saved-portfolio cap client-side (an extra read before the
// write) -- Firestore security rules can restrict WHO can write, not easily
// COUNT a user's existing documents, so there's no server-side quota here.
// That's an acceptable gap for a personal-quota feature bounded to a
// user's own account (see firestore.rules): the worst a client bypassing
// this check could do is store extra data under their own uid, not access
// anyone else's.
async function saveNewPortfolio(answers) {
  if (!firebaseReady) throw new Error('Account features are unavailable right now.');
  if (!authState.user) throw new Error('You need to be logged in to save your portfolio.');

  const coll = savedPortfoliosCollection();
  const existing = await coll.get();
  if (existing.size >= MAX_SAVED_PORTFOLIOS) {
    const limitErr = new Error(
      `You've reached your limit of ${MAX_SAVED_PORTFOLIOS} saved portfolios. Delete one from My Portfolios to save a new one.`
    );
    limitErr.code = 'portfolio-limit-reached';
    throw limitErr;
  }

  await coll.add({
    name: formatAutoPortfolioName(new Date()),
    answers,
    savedAt: firebase.firestore.FieldValue.serverTimestamp(),
  });
}

async function listSavedPortfolios() {
  if (!firebaseReady || !authState.user) return [];
  await migrateLegacySurveysIfNeeded();
  const snapshot = await savedPortfoliosCollection().orderBy('savedAt', 'desc').get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

// Renaming only ever touches `name` -- the underlying answers and the
// original savedAt (still used for sort order after a rename) are
// untouched, per the "does not affect the underlying answers or original
// save timestamp" requirement.
async function renameSavedPortfolio(portfolioId, newName) {
  if (!firebaseReady || !authState.user) throw new Error('You need to be logged in.');
  await savedPortfoliosCollection().doc(portfolioId).update({ name: newName });
}

async function deleteSavedPortfolio(portfolioId) {
  if (!firebaseReady || !authState.user) throw new Error('You need to be logged in.');
  await savedPortfoliosCollection().doc(portfolioId).delete();
}

// --- Firestore: watchlist (individual tracked tickers) -----------------
//
// A lighter-weight sibling of savedPortfolios above: just tracked tickers,
// no survey answers. The ticker itself is the document id (rather than an
// auto-generated one) -- Firestore doc ids allow any string except one
// containing "/" or equal to "." or "..", which every real ticker in this
// dataset satisfies (including ones with a literal period, e.g. "BRK.B").
// Using the ticker as the id makes "is this already watchlisted" and
// "add if not present" both a single doc reference, no query needed, and
// makes a duplicate add naturally idempotent instead of needing its own
// existence check race-condition-free.

const MAX_WATCHLIST_SIZE = 20;

function watchlistCollection() {
  return firebaseDb.collection('users').doc(authState.user.uid).collection('watchlist');
}

// Same client-side cap enforcement and reasoning as saveNewPortfolio's own
// MAX_SAVED_PORTFOLIOS check above -- see that function's comment.
async function addToWatchlist(ticker) {
  if (!firebaseReady) throw new Error('Account features are unavailable right now.');
  if (!authState.user) throw new Error('You need to be logged in to add to your watchlist.');

  const coll = watchlistCollection();
  const docRef = coll.doc(ticker);
  const existing = await docRef.get();
  if (existing.exists) return; // already watchlisted -- idempotent no-op, not an error

  const snapshot = await coll.get();
  if (snapshot.size >= MAX_WATCHLIST_SIZE) {
    const limitErr = new Error(
      `You've reached your limit of ${MAX_WATCHLIST_SIZE} watchlisted companies. Remove one from My Watchlist to add another.`
    );
    limitErr.code = 'watchlist-limit-reached';
    throw limitErr;
  }

  await docRef.set({ ticker, addedAt: firebase.firestore.FieldValue.serverTimestamp() });
}

async function removeFromWatchlist(ticker) {
  if (!firebaseReady || !authState.user) throw new Error('You need to be logged in.');
  await watchlistCollection().doc(ticker).delete();
}

async function listWatchlist() {
  if (!firebaseReady || !authState.user) return [];
  const snapshot = await watchlistCollection().orderBy('addedAt', 'desc').get();
  return snapshot.docs.map((doc) => ({ ticker: doc.id, ...doc.data() }));
}

// Populates watchlistState.tickers (just the membership set, for toggle-
// button display everywhere) -- called on every sign-in, see
// onAuthStateChanged above. The dedicated My Watchlist screen
// (openMyWatchlistView below) does its own separate fetch for the ordered,
// full-detail list it actually displays.
async function loadWatchlistTickers() {
  if (!firebaseReady || !authState.user) return;
  try {
    const entries = await listWatchlist();
    watchlistState.tickers = new Set(entries.map((e) => e.ticker));
    watchlistState.loaded = true;
  } catch (err) {
    console.error('loadWatchlistTickers failed:', err);
  }
  renderInPlace();
}

// The shared ☆/★ toggle button -- rendered next to a company's name
// everywhere one can appear (Ticker Tester, each Compare Two Companies
// column, raw-data fallback views, each Results table row, and each My
// Watchlist entry's own row). One implementation, wired generically by
// wireWatchlistToggleButtons (called unconditionally at the end of
// app.js's renderInPlace, so no render call site has to remember to wire
// it itself).
function renderWatchlistToggleButton(ticker, options = {}) {
  const isWatching = watchlistState.tickers.has(ticker);
  const isPending = watchlistState.pendingTicker === ticker;
  const showError = watchlistState.error && watchlistState.errorTicker === ticker;
  // removeOnly: used on the My Watchlist screen itself, where every entry
  // is already watched and the only reachable action is removal -- shows
  // an explicit "Remove" instead of the ambiguous "★ Watching" label, but
  // still just this same shared button/handler (no separate remove path).
  const removeOnly = options.removeOnly === true;
  const label = isPending ? (removeOnly ? 'Removing…' : 'Updating…') : removeOnly ? 'Remove' : isWatching ? '★ Watching' : '☆ Add to Watchlist';
  const activeClass = removeOnly ? 'danger watchlist-remove-btn' : isWatching ? 'watchlist-toggle-btn-active' : '';
  return `
    <span class="watchlist-toggle-wrap">
      <button
        type="button"
        class="btn-link-action watchlist-toggle-btn ${activeClass}"
        data-ticker="${escapeHtml(ticker)}"
        ${isPending ? 'disabled' : ''}
      >
        ${label}
      </button>
      ${showError ? `<span class="error-text watchlist-toggle-error">${escapeHtml(watchlistState.error)}</span>` : ''}
    </span>
  `;
}

function wireWatchlistToggleButtons() {
  document.querySelectorAll('.watchlist-toggle-btn').forEach((btn) => {
    btn.addEventListener('click', () => handleWatchlistToggleClick(btn.dataset.ticker));
  });
}

async function handleWatchlistToggleClick(ticker) {
  if (!firebaseReady || !authState.user) {
    // Not logged in -- same "stash intent, send to login, finish
    // automatically once signed in" pattern as Save My Portfolio and
    // Compare Two Companies (see pendingSaveAnswers/pendingCompareRedirect
    // above), just remembering which screen to come back to since this
    // button can be clicked from several different ones.
    pendingWatchlistAdd = ticker;
    pendingWatchlistReturnView = state.view;
    authViewState.mode = 'login';
    authViewState.error = null;
    authViewState.info = null;
    state.view = 'account';
    render();
    return;
  }

  watchlistState.error = null;
  watchlistState.errorTicker = null;
  watchlistState.pendingTicker = ticker;
  renderInPlace();

  try {
    if (watchlistState.tickers.has(ticker)) {
      await removeFromWatchlist(ticker);
      watchlistState.tickers.delete(ticker);
      watchlistViewState.entries = watchlistViewState.entries.filter((e) => e.ticker !== ticker);
    } else {
      await addToWatchlist(ticker);
      watchlistState.tickers.add(ticker);
      if (state.view === 'watchlist') {
        // Keep the My Watchlist screen's own ordered list in sync without
        // a full refetch -- addedAt.toDate() is only ever read for display
        // (renderWatchlistEntry's dateLabel-equivalent, if added later), so
        // a plain Date stand-in is fine until the next real fetch.
        watchlistViewState.entries.unshift({ ticker, addedAt: { toDate: () => new Date() } });
      }
    }
  } catch (err) {
    console.error('Watchlist toggle failed:', err);
    watchlistState.error =
      err && err.code === 'watchlist-limit-reached' ? err.message : describeFirestoreError(err, 'Could not update your watchlist');
    watchlistState.errorTicker = ticker;
  }
  watchlistState.pendingTicker = null;
  renderInPlace();
}

// --- My Watchlist view ---------------------------------------------------

async function openMyWatchlistView() {
  state.view = 'watchlist';
  watchlistViewState.loading = true;
  watchlistViewState.error = null;
  watchlistViewState.expandedTickers = new Set();
  render();
  try {
    watchlistViewState.entries = await listWatchlist();
    watchlistState.tickers = new Set(watchlistViewState.entries.map((e) => e.ticker));
  } catch (err) {
    console.error('listWatchlist failed:', err);
    watchlistViewState.error = describeFirestoreError(err, 'Could not load your watchlist');
  }
  watchlistViewState.loading = false;
  renderInPlace();
}

function renderMyWatchlist() {
  const count = watchlistViewState.entries.length;
  appEl.innerHTML = `
    <section class="card watchlist-card">
      <p class="eyebrow">Account</p>
      <h1>My Watchlist</h1>
      <p class="lede">
        ${watchlistViewState.loading ? "Companies you're tracking." : `${count} of ${MAX_WATCHLIST_SIZE} watchlisted companies.`}
      </p>
      ${!watchlistViewState.loading && state.dataset ? renderWatchlistAddPicker() : ''}
      ${watchlistViewState.loading ? '<p class="muted">Loading…</p>' : renderWatchlistEntries()}
      <div class="nav-row">
        <button type="button" id="watchlist-back-btn" class="btn btn-secondary">Back</button>
      </div>
    </section>
  `;

  document.getElementById('watchlist-back-btn').addEventListener('click', () => {
    state.view = 'intro';
    render();
  });

  wireWatchlistAddPicker();
  wireWatchlistEntryToggles();
}

// A second, direct entry point into watchlisting a company -- lets a
// client add straight from this screen instead of needing to look the
// company up in Ticker Tester first. Same filterCompanies()
// (ticker-tester.js) dataset restriction as every other search box on the
// site (no free-text submission of a company outside the dataset), and
// the click handler below calls the exact same handleWatchlistToggleClick
// every ☆/★ button already uses -- no separate add path, no separate
// watchlist data structure. Already-watchlisted companies are filtered out
// of the results entirely (rather than shown disabled) since this picker
// only ever adds -- surfacing a company already on the list here would
// invite a click that the shared toggle handler would read as "remove."
function renderWatchlistAddPicker() {
  const query = watchlistViewState.addQuery;
  const results = filterCompanies(query).filter((c) => !watchlistState.tickers.has(c.ticker)); // js/ticker-tester.js
  const showDropdown = query.trim().length > 0;

  return `
    <div class="ticker-search watchlist-add-picker">
      <label for="watchlist-add-input">Add a company to your watchlist</label>
      <input
        type="text"
        id="watchlist-add-input"
        autocomplete="off"
        placeholder="e.g. Apple or AAPL"
        value="${escapeHtml(query)}"
      />
      ${
        showDropdown
          ? `
        <ul class="ticker-search-results">
          ${
            results.length > 0
              ? results
                  .map(
                    (c) => `
              <li>
                <button type="button" class="ticker-search-result watchlist-add-result" data-ticker="${escapeHtml(c.ticker)}">
                  <span class="ticker-search-result-ticker">${escapeHtml(c.ticker)}</span>
                  <span class="ticker-search-result-name">${escapeHtml(c.name)}</span>
                  <span class="ticker-search-result-sector">${escapeHtml(c.sector)}</span>
                </button>
              </li>
            `
                  )
                  .join('')
              : '<li class="ticker-search-empty">No matching companies found (or already on your watchlist).</li>'
          }
        </ul>
      `
          : ''
      }
    </div>
  `;
}

function wireWatchlistAddPicker() {
  const input = document.getElementById('watchlist-add-input');
  if (input) {
    input.addEventListener('input', () => {
      watchlistViewState.addQuery = input.value;
      renderInPlace();
      // Re-render moves focus/cursor to the end by default -- restore it
      // so typing feels continuous, same as every other search box here.
      const refocused = document.getElementById('watchlist-add-input');
      if (refocused) {
        refocused.focus();
        refocused.setSelectionRange(refocused.value.length, refocused.value.length);
      }
    });
  }

  document.querySelectorAll('.watchlist-add-result').forEach((btn) => {
    btn.addEventListener('click', () => {
      watchlistViewState.addQuery = '';
      handleWatchlistToggleClick(btn.dataset.ticker);
    });
  });
}

function renderWatchlistEntries() {
  if (watchlistViewState.error) return `<p class="error-text">${escapeHtml(watchlistViewState.error)}</p>`;
  if (watchlistViewState.entries.length === 0) {
    return '<p class="muted">You haven\'t watchlisted any companies yet. Look up a company in Ticker Tester (or anywhere else you see a ☆ Add to Watchlist button) to track it here.</p>';
  }
  if (!state.dataset) return '<p class="muted">Loading company data…</p>';
  return `<ul class="watchlist-list">${watchlistViewState.entries.map(renderWatchlistEntry).join('')}</ul>`;
}

// Each entry is a compact one-line summary (ticker, name, sector, tier
// badge if personalized data is available) that expands, on click, into a
// compact version of the same scoring Ticker Tester itself would show --
// reusing renderCategoryListItems/renderRawCompanyData/tickerTierDisplay/
// buildCompanyScoreEntry from ticker-tester.js exactly, not a re-derived
// summary. Deliberately no radar chart here (that's what "compact" means
// per the brief) -- just the rationale, note/caution flags, and the
// category score list.
function renderWatchlistEntry(entry) {
  const company = state.dataset.companies.find((c) => c.ticker === entry.ticker);
  if (!company) {
    // Watchlisted ticker no longer present in the current dataset --
    // handled explicitly rather than crashing on a null lookup.
    return `
      <li class="watchlist-entry" data-ticker="${escapeHtml(entry.ticker)}">
        <div class="watchlist-entry-row">
          <span class="watchlist-entry-ticker">${escapeHtml(entry.ticker)}</span>
          <span class="muted">No longer in the current dataset.</span>
        </div>
        ${renderWatchlistToggleButton(entry.ticker, { removeOnly: true })}
      </li>
    `;
  }

  const isExpanded = watchlistViewState.expandedTickers.has(entry.ticker);
  const scored = hasPersonalizationSource() ? buildCompanyScoreEntry(company) : null; // js/ticker-tester.js
  const display = scored && scored.entry ? tickerTierDisplay(scored.entry.tier) : null; // js/ticker-tester.js

  return `
    <li class="watchlist-entry" data-ticker="${escapeHtml(entry.ticker)}">
      <button type="button" class="watchlist-entry-row watchlist-entry-toggle" data-ticker="${escapeHtml(entry.ticker)}">
        <span class="financial-toggle-chevron ${isExpanded ? 'open' : ''}">${chevronIcon()}</span>
        <span class="watchlist-entry-ticker">${escapeHtml(company.ticker)}</span>
        <span class="watchlist-entry-name">${escapeHtml(company.name)}</span>
        <span class="watchlist-entry-sector">${escapeHtml(company.sector)}</span>
        ${display ? `<span class="tier-badge tier-${display.cssKey}">${display.badgeText}</span>` : ''}
      </button>
      ${renderWatchlistToggleButton(entry.ticker, { removeOnly: true })}
      ${isExpanded ? renderWatchlistEntryDetail(company, scored) : ''}
    </li>
  `;
}

function renderWatchlistEntryDetail(company, scored) {
  if (!hasPersonalizationSource()) {
    // js/ticker-tester.js
    return `
      <div class="watchlist-entry-detail">
        <p class="muted">Complete the survey or load a saved portfolio to see how ${escapeHtml(company.name)} matches your values.</p>
        ${renderRawCompanyData(company)}
      </div>
    `;
  }
  if (scored.blueChipExcluded) {
    return `
      <div class="watchlist-entry-detail">
        <p class="muted">
          You rated "large, established blue-chip companies" a 5/5 -- ${escapeHtml(company.name)} doesn't meet that
          bar, so it would never appear in your recommended portfolio regardless of how well it otherwise matches
          your values.
        </p>
        ${renderRawCompanyData(company)}
      </div>
    `;
  }

  const { entry, ctx } = scored;
  const categoryScores = computeCategoryScores(company, entry, ctx); // js/ticker-tester.js
  const showNote = entry.note && entry.tier !== 'Below Values Threshold';
  return `
    <div class="watchlist-entry-detail">
      <p class="ticker-result-rationale">${escapeHtml(entry.rationale)}</p>
      ${showNote ? `<p class="ticker-result-note muted">${escapeHtml(entry.note)}</p>` : ''}
      ${
        entry.cautionFlags && entry.cautionFlags.length > 0
          ? `<p class="caution-note">⚠ Financial caution: ${entry.cautionFlags.map(escapeHtml).join('; ')}</p>`
          : ''
      }
      <ul class="ticker-category-list">
        ${renderCategoryListItems(categoryScores)}
      </ul>
    </div>
  `;
}

function wireWatchlistEntryToggles() {
  document.querySelectorAll('.watchlist-entry-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const ticker = btn.dataset.ticker;
      if (watchlistViewState.expandedTickers.has(ticker)) watchlistViewState.expandedTickers.delete(ticker);
      else watchlistViewState.expandedTickers.add(ticker);
      renderInPlace();
    });
  });
}

// --- Header account widget (static markup outside #app, present on every view) --

// 2026-08-25: reduced to just Log In/Log Out -- My Portfolios and My
// Watchlist moved into the hamburger nav menu (see renderSiteNavMenu,
// app.js), which now owns all feature navigation; this widget's only job
// is the one control that must stay visible outside the menu at all
// times. The signed-in client's email moved into the hamburger dropdown
// itself (its own top line) rather than living here redundantly.
function renderAccountWidget() {
  const el = document.getElementById('account-widget');
  if (!el) return;
  if (!firebaseReady || !authState.ready) {
    el.innerHTML = '';
    return;
  }

  if (authState.user) {
    el.innerHTML = '<button type="button" id="account-logout-btn" class="account-widget-link">Log Out</button>';
    document.getElementById('account-logout-btn').addEventListener('click', async () => {
      await logOut();
      if (state.view === 'account' || state.view === 'portfolios' || state.view === 'watchlist') {
        state.view = 'intro';
        render();
      }
    });
  } else {
    el.innerHTML = '<button type="button" id="account-login-link" class="account-widget-link">Log In</button>';
    document.getElementById('account-login-link').addEventListener('click', () => {
      authViewState.mode = 'login';
      authViewState.error = null;
      authViewState.info = null;
      state.view = 'account';
      render();
    });
  }
}

// --- Account view: login / sign-up form ---------------------------------

function renderAccount() {
  const isSignup = authViewState.mode === 'signup';

  appEl.innerHTML = `
    <section class="card auth-card">
      <p class="eyebrow">Account</p>
      <h1>${isSignup ? 'Create Your Account' : 'Log In'}</h1>
      <p class="lede">
        ${
          isSignup
            ? 'Save your portfolio so you can pick up where you left off.'
            : 'Log in to save your TrueNorth portfolio.'
        }
      </p>

      <form id="auth-form" class="auth-form" novalidate>
        <label for="auth-email">Email</label>
        <input id="auth-email" type="email" autocomplete="email" required />

        <label for="auth-password">Password</label>
        <input
          id="auth-password"
          type="password"
          autocomplete="${isSignup ? 'new-password' : 'current-password'}"
          minlength="6"
          required
        />

        ${authViewState.error ? `<p class="error-text">${escapeHtml(authViewState.error)}</p>` : ''}
        ${authViewState.info ? `<p class="auth-info-text">${escapeHtml(authViewState.info)}</p>` : ''}

        <button type="submit" class="btn btn-primary auth-submit-btn" ${authViewState.loading ? 'disabled' : ''}>
          ${authViewState.loading ? 'Please wait…' : isSignup ? 'Create Account' : 'Log In'}
        </button>
      </form>

      ${!isSignup ? '<button type="button" id="forgot-password-btn" class="btn-link-inline auth-link">Forgot password?</button>' : ''}

      <p class="auth-switch">
        ${isSignup ? 'Already have an account?' : "Don't have an account?"}
        <button type="button" id="auth-mode-toggle" class="auth-switch-btn">${isSignup ? 'Log In' : 'Create Account'}</button>
      </p>

      <button type="button" id="auth-back-btn" class="btn-link-inline auth-link">&larr; Back without logging in</button>
    </section>
  `;

  document.getElementById('auth-form').addEventListener('submit', async (evt) => {
    evt.preventDefault();
    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value;
    authViewState.error = null;
    authViewState.info = null;
    authViewState.loading = true;
    renderInPlace();
    try {
      if (isSignup) await signUp(email, password);
      else await logIn(email, password);
      authViewState.loading = false;
      // onAuthStateChanged (above) handles navigating away -- either
      // finishing an interrupted "Save My Portfolio," or back to the intro
      // screen -- once the user resolves.
    } catch (err) {
      authViewState.loading = false;
      authViewState.error = friendlyAuthError(err);
      renderInPlace();
    }
  });

  const forgotBtn = document.getElementById('forgot-password-btn');
  if (forgotBtn) {
    forgotBtn.addEventListener('click', async () => {
      const email = document.getElementById('auth-email').value.trim();
      if (!email) {
        authViewState.error = 'Enter your email above, then click "Forgot password?" again.';
        renderInPlace();
        return;
      }
      authViewState.error = null;
      authViewState.info = null;
      authViewState.loading = true;
      renderInPlace();
      try {
        await resetPassword(email);
        authViewState.info = `Password reset email sent to ${email}.`;
      } catch (err) {
        authViewState.error = friendlyAuthError(err);
      }
      authViewState.loading = false;
      renderInPlace();
    });
  }

  document.getElementById('auth-mode-toggle').addEventListener('click', () => {
    authViewState.mode = isSignup ? 'login' : 'signup';
    authViewState.error = null;
    authViewState.info = null;
    renderInPlace();
  });

  document.getElementById('auth-back-btn').addEventListener('click', () => {
    authViewState.error = null;
    authViewState.info = null;
    pendingSaveAnswers = null; // abandon any interrupted "Save My Portfolio" too
    pendingCompareRedirect = false; // ...and any interrupted Compare-Two-Companies redirect
    pendingWatchlistAdd = null; // ...and any interrupted watchlist add
    pendingWatchlistReturnView = null;
    pendingPortfoliosRedirect = false; // ...and any interrupted hamburger-nav redirect
    pendingWatchlistViewRedirect = false;
    state.view = 'intro';
    render();
  });
}

// --- My Portfolios view ----------------------------------------------------

async function openMyPortfoliosView() {
  state.view = 'portfolios';
  myPortfoliosViewState.loading = true;
  myPortfoliosViewState.error = null;
  myPortfoliosViewState.renamingId = null;
  myPortfoliosViewState.confirmingDeleteId = null;
  // A stale "limit reached" message shouldn't still be sitting on the
  // results screen after the client comes here to make room for a new save.
  state.saveResultState = { status: 'idle', errorMessage: null };
  render();
  try {
    myPortfoliosViewState.portfolios = await listSavedPortfolios();
  } catch (err) {
    console.error('listSavedPortfolios failed:', err);
    myPortfoliosViewState.error = describeFirestoreError(err, 'Could not load your saved portfolios');
  }
  myPortfoliosViewState.loading = false;
  renderInPlace();
}

function renderMyPortfolios() {
  const count = myPortfoliosViewState.portfolios.length;
  appEl.innerHTML = `
    <section class="card portfolios-card">
      <p class="eyebrow">Account</p>
      <h1>My Portfolios</h1>
      <p class="lede">
        ${myPortfoliosViewState.loading ? 'Your saved portfolios.' : `${count} of ${MAX_SAVED_PORTFOLIOS} saved portfolios.`}
      </p>
      ${myPortfoliosViewState.loading ? '<p class="muted">Loading…</p>' : renderPortfoliosList()}
      <div class="nav-row">
        <button type="button" id="portfolios-back-btn" class="btn btn-secondary">Back</button>
      </div>
    </section>
  `;

  document.getElementById('portfolios-back-btn').addEventListener('click', () => {
    state.view = 'intro';
    render();
  });

  wirePortfolioEntryButtons();
}

function renderPortfoliosList() {
  if (myPortfoliosViewState.error) return `<p class="error-text">${escapeHtml(myPortfoliosViewState.error)}</p>`;
  if (myPortfoliosViewState.portfolios.length === 0) {
    return '<p class="muted">You haven\'t saved any portfolios yet. Complete the questionnaire and click "Save My Portfolio" on your results page to see it here.</p>';
  }
  return `<ul class="portfolios-list">${myPortfoliosViewState.portfolios.map(renderPortfolioEntry).join('')}</ul>`;
}

function renderPortfolioEntry(portfolio) {
  const isRenaming = myPortfoliosViewState.renamingId === portfolio.id;
  const isConfirmingDelete = myPortfoliosViewState.confirmingDeleteId === portfolio.id;
  const dateLabel =
    portfolio.savedAt && typeof portfolio.savedAt.toDate === 'function'
      ? portfolio.savedAt.toDate().toLocaleDateString('en-US', { dateStyle: 'medium' })
      : 'Just now';

  if (isRenaming) {
    return `
      <li class="portfolio-entry portfolio-entry-renaming" data-id="${portfolio.id}">
        <form class="portfolio-rename-form" data-id="${portfolio.id}">
          <input type="text" class="portfolio-rename-input" value="${escapeHtml(portfolio.name)}" maxlength="80" autofocus />
          <button type="submit" class="btn-link-action portfolio-rename-save">Save</button>
          <button type="button" class="btn-link-action portfolio-rename-cancel">Cancel</button>
        </form>
      </li>
    `;
  }

  if (isConfirmingDelete) {
    // An in-page confirmation instead of window.confirm(): a native
    // browser confirm() dialog is unreliable in some mobile contexts (can
    // be suppressed entirely, silently returning false) -- which looks
    // indistinguishable from "the Delete button does nothing." This is
    // always visible and its Yes/Cancel buttons are real DOM elements.
    return `
      <li class="portfolio-entry portfolio-entry-confirming" data-id="${portfolio.id}">
        <p class="portfolio-delete-confirm-text">Are you sure you want to delete "${escapeHtml(portfolio.name)}"? This can't be undone.</p>
        <div class="portfolio-delete-confirm-actions">
          <button type="button" class="btn-link-action danger portfolio-delete-confirm" data-id="${portfolio.id}">Yes, Delete</button>
          <button type="button" class="btn-link-action portfolio-delete-cancel">Cancel</button>
        </div>
      </li>
    `;
  }

  return `
    <li class="portfolio-entry" data-id="${portfolio.id}">
      <div class="portfolio-entry-info">
        <span class="portfolio-entry-name">${escapeHtml(portfolio.name)}</span>
        <span class="portfolio-entry-date">Saved ${escapeHtml(dateLabel)}</span>
      </div>
      <div class="portfolio-entry-actions">
        <button type="button" class="btn-link-action portfolio-load-btn" data-id="${portfolio.id}" ${state.dataset ? '' : 'disabled title="Data still loading — try again in a moment"'}>Load</button>
        <button type="button" class="btn-link-action portfolio-rename-btn" data-id="${portfolio.id}">Rename</button>
        <button type="button" class="btn-link-action portfolio-delete-btn danger" data-id="${portfolio.id}">Delete</button>
      </div>
    </li>
  `;
}

function wirePortfolioEntryButtons() {
  document.querySelectorAll('.portfolio-load-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const portfolio = myPortfoliosViewState.portfolios.find((p) => p.id === btn.dataset.id);
      if (portfolio) loadPortfolioIntoResults(portfolio);
    });
  });

  document.querySelectorAll('.portfolio-rename-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      myPortfoliosViewState.renamingId = btn.dataset.id;
      myPortfoliosViewState.confirmingDeleteId = null;
      renderInPlace();
    });
  });

  document.querySelectorAll('.portfolio-rename-cancel').forEach((btn) => {
    btn.addEventListener('click', () => {
      myPortfoliosViewState.renamingId = null;
      renderInPlace();
    });
  });

  document.querySelectorAll('.portfolio-rename-form').forEach((form) => {
    form.addEventListener('submit', async (evt) => {
      evt.preventDefault();
      const portfolioId = form.dataset.id;
      const input = form.querySelector('.portfolio-rename-input');
      const newName = input.value.trim();
      if (!newName) return;
      try {
        await renameSavedPortfolio(portfolioId, newName);
        const entry = myPortfoliosViewState.portfolios.find((p) => p.id === portfolioId);
        if (entry) entry.name = newName;
        myPortfoliosViewState.renamingId = null;
      } catch (err) {
        console.error('renameSavedPortfolio failed:', err);
        myPortfoliosViewState.error = describeFirestoreError(err, 'Could not rename that portfolio');
      }
      renderInPlace();
    });
  });

  document.querySelectorAll('.portfolio-delete-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      myPortfoliosViewState.confirmingDeleteId = btn.dataset.id;
      myPortfoliosViewState.renamingId = null;
      renderInPlace();
    });
  });

  document.querySelectorAll('.portfolio-delete-cancel').forEach((btn) => {
    btn.addEventListener('click', () => {
      myPortfoliosViewState.confirmingDeleteId = null;
      renderInPlace();
    });
  });

  document.querySelectorAll('.portfolio-delete-confirm').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const portfolio = myPortfoliosViewState.portfolios.find((p) => p.id === btn.dataset.id);
      if (!portfolio) return;
      try {
        await deleteSavedPortfolio(portfolio.id);
        myPortfoliosViewState.portfolios = myPortfoliosViewState.portfolios.filter((p) => p.id !== portfolio.id);
        myPortfoliosViewState.confirmingDeleteId = null;
      } catch (err) {
        console.error('deleteSavedPortfolio failed:', err);
        myPortfoliosViewState.error = describeFirestoreError(err, 'Could not delete that portfolio');
        myPortfoliosViewState.confirmingDeleteId = null;
      }
      renderInPlace();
    });
  });
}

// Loading is a read, not a save: it fills in this session's answers and
// jumps straight to results, but never itself writes anything to
// Firestore. Marking every rated question "touched" is what gives loaded
// answers the same blue checkmark styling as ones the client picked
// themselves (rather than the untouched-default gray) if they later visit
// Edit My Answers / the survey view for this session. Home
// country/industry-ties/time-horizon aren't part of what's saved (see the
// header comment -- only answers + a name/timestamp are), so those stay
// at their current session values rather than being reset by a load.
function loadPortfolioIntoResults(portfolio) {
  if (!state.dataset) return;
  state.answers = { ...portfolio.answers };
  state.touchedQuestionIds = new Set(
    QUESTIONS.filter((q) => q.type !== 'horizon').map((q) => q.id)
  );
  state.saveResultState = { status: 'idle', errorMessage: null };
  state.hasPersonalizedAnswers = true; // real answers now exist -- see ticker-tester.js
  state.view = 'results';
  render();
}
