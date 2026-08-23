/**
 * Account layer: Firebase Authentication + Firestore save of survey
 * answers, plus the account-related UI (header widget, login/sign-up
 * screen).
 *
 * Kept separate from app.js on purpose: app.js owns the survey flow
 * (intro/survey/review/results) and knows nothing about accounts beyond
 * calling the functions here; this file owns everything account-related
 * and knows nothing about scoring/questions. The two meet only at
 * `state.view` ('account' is added here, dispatched from app.js's
 * renderInPlace()) and the "Save My Survey" control on the results screen
 * (in app.js, calling saveSurveyAnswers() below).
 *
 * Login is strictly optional — see firebase-config.js's `firebaseReady`.
 * Every function here checks it first and fails softly (never touches the
 * survey/results experience for a signed-out visitor).
 *
 * There is no saved-results browsing screen — each user's Firestore
 * document at users/{uid}/savedSurvey/current holds only their single most
 * recent save (answers + timestamp), overwritten on every save. An earlier
 * version of this feature stored a growable users/{uid}/surveys collection
 * (full portfolio snapshots, browsable in a list); that collection is no
 * longer written to or read by this file, but nothing in it is deleted --
 * see firestore.rules for why its access rule is still kept around.
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

// Set when a signed-out visitor clicks "Save My Survey" on the results
// screen: their answers at that moment, held here until they finish
// logging in (or signing up), at which point onAuthStateChanged below
// saves them automatically with no second click required. Cleared as soon
// as it's consumed, or if they back out of the login screen instead.
let pendingSaveAnswers = null;

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
  await firebaseAuth.sendPasswordResetEmail(email);
}

if (firebaseReady) {
  firebaseAuth.onAuthStateChanged(async (user) => {
    authState.user = user;
    authState.ready = true;
    renderAccountWidget();

    if (user && pendingSaveAnswers) {
      // A signed-out visitor clicked "Save My Survey," was redirected here
      // to log in, and has now done so -- finish the save they started
      // without making them click it again, then take them back to their
      // results with the same "Saved!" confirmation the normal flow shows.
      const answersToSave = pendingSaveAnswers;
      pendingSaveAnswers = null;
      try {
        await saveSurveyAnswers(answersToSave);
        state.saveResultState = { status: 'saved', errorMessage: null };
        scheduleSaveResultRevert();
      } catch (err) {
        state.saveResultState = { status: 'error', errorMessage: 'Could not save your survey. Please try again.' };
      }
      state.view = 'results';
      render();
      return;
    }

    if (state.view === 'account' && user) {
      // Just signed in from the login screen (not via the pending-save
      // path above) -- head back to the intro screen rather than leaving
      // them sitting on a login form.
      state.view = 'intro';
      render();
    } else if (state.view === 'results') {
      // Refresh the Save-My-Survey control for the new auth state.
      render();
    }
  });
} else {
  // No Firebase available -- resolve immediately as "signed out" so the
  // account widget and results screen don't wait forever for a callback
  // that will never fire.
  authState.ready = true;
}

// --- Firestore: save survey answers --------------------------------------

// One slot per user: users/{uid}/savedSurvey/current, overwritten on every
// save. Only the raw answers and a timestamp -- never the computed
// portfolio (scores, matched companies, allocations), which is cheap to
// recompute from the answers and shouldn't be treated as saved fact.
async function saveSurveyAnswers(answers) {
  if (!firebaseReady) throw new Error('Account features are unavailable right now.');
  if (!authState.user) throw new Error('You need to be logged in to save your survey.');

  await firebaseDb
    .collection('users')
    .doc(authState.user.uid)
    .collection('savedSurvey')
    .doc('current')
    .set({
      answers,
      savedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
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
      <button type="button" id="account-logout-btn" class="account-widget-link">Log Out</button>
    `;
    document.getElementById('account-logout-btn').addEventListener('click', async () => {
      await logOut();
      if (state.view === 'account') {
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
            ? 'Save your survey answers so you can pick up where you left off.'
            : 'Log in to save your TrueNorth survey.'
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
      // finishing an interrupted "Save My Survey," or back to the intro
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
    pendingSaveAnswers = null; // abandon any interrupted "Save My Survey" too
    state.view = 'intro';
    render();
  });
}
