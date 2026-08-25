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

// --- Header account widget (static markup outside #app, present on every view) --

function renderAccountWidget() {
  const el = document.getElementById('account-widget');
  if (!el) return;
  if (!firebaseReady || !authState.ready) {
    el.innerHTML = '';
    return;
  }

  if (authState.user) {
    el.innerHTML = `
      <span class="account-widget-email">${escapeHtml(authState.user.email)}</span>
      <button type="button" id="account-my-portfolios-link" class="account-widget-link">My Portfolios</button>
      <button type="button" id="account-logout-btn" class="account-widget-link">Log Out</button>
    `;
    document.getElementById('account-my-portfolios-link').addEventListener('click', openMyPortfoliosView);
    document.getElementById('account-logout-btn').addEventListener('click', async () => {
      await logOut();
      if (state.view === 'account' || state.view === 'portfolios') {
        state.view = 'intro';
        render();
      }
    });
  } else {
    el.innerHTML = '<button type="button" id="account-login-link" class="account-widget-link">Log In / Sign Up</button>';
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
