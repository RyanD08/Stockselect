/**
 * Account layer: Firebase Authentication + Firestore save/load of survey
 * results, plus the account-related UI (header widget, login/sign-up
 * screen, saved-results list).
 *
 * Kept separate from app.js on purpose: app.js owns the survey flow
 * (intro/survey/review/results) and knows nothing about accounts beyond
 * calling the functions here; this file owns everything account-related
 * and knows nothing about scoring/questions. The two meet only at
 * `state.view` ('account'/'saved' are added here, dispatched from app.js's
 * renderInPlace()) and the "Save these results" control on the results
 * screen (in app.js, calling saveSurveyResult() below).
 *
 * Login is strictly optional — see firebase-config.js's `firebaseReady`.
 * Every function here checks it first and fails softly (never touches the
 * survey/results experience for a signed-out visitor).
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

// UI-only state for the saved-results list.
const savedViewState = {
  loading: true,
  error: null,
  surveys: [],
  expandedId: null,
};

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
  firebaseAuth.onAuthStateChanged((user) => {
    authState.user = user;
    authState.ready = true;
    renderAccountWidget();
    if (state.view === 'account' && user) {
      // Just signed in from the login screen -- head back to the intro
      // screen rather than leaving them sitting on a login form.
      state.view = 'intro';
      render();
    } else if (state.view === 'results' || state.view === 'saved') {
      // Refresh the Save-results control / saved list for the new auth state.
      render();
    }
  });
} else {
  // No Firebase available -- resolve immediately as "signed out" so the
  // account widget and results screen don't wait forever for a callback
  // that will never fire.
  authState.ready = true;
}

// --- Firestore: save/load survey results --------------------------------

// Stores a compact snapshot (not full company records) -- everything
// needed to redisplay the holdings list on the Saved Results screen,
// without duplicating the whole ~500-company dataset per save.
async function saveSurveyResult({ answers, homeCountry, tiesSector, timeHorizon, riskProfile, holdings }) {
  if (!firebaseReady) throw new Error('Account features are unavailable right now.');
  if (!authState.user) throw new Error('You need to be logged in to save results.');

  const holdingsSummary = holdings.map((h) => ({
    ticker: h.company.ticker,
    name: h.company.name,
    sector: h.company.sector,
    tier: h.tier,
    score: h.score,
    allocationPct: h.allocationPct,
    rationale: h.rationale,
  }));

  await firebaseDb
    .collection('users')
    .doc(authState.user.uid)
    .collection('surveys')
    .add({
      answers,
      homeCountry,
      tiesSector,
      timeHorizon,
      riskProfile,
      holdings: holdingsSummary,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
}

async function loadSavedSurveys() {
  if (!firebaseReady || !authState.user) return [];
  const snapshot = await firebaseDb
    .collection('users')
    .doc(authState.user.uid)
    .collection('surveys')
    .orderBy('createdAt', 'desc')
    .get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
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
      <button type="button" id="account-saved-link" class="account-widget-link">My Saved Results</button>
      <button type="button" id="account-logout-btn" class="account-widget-link">Log Out</button>
    `;
    document.getElementById('account-saved-link').addEventListener('click', openSavedView);
    document.getElementById('account-logout-btn').addEventListener('click', async () => {
      await logOut();
      if (state.view === 'saved' || state.view === 'account') {
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
            ? 'Save your survey answers and portfolio results so you can revisit them later.'
            : 'Log in to save or view your TrueNorth results.'
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
      // onAuthStateChanged (above) handles navigating back to the intro
      // screen once the user resolves.
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
    state.view = 'intro';
    render();
  });
}

// --- Saved-results view ---------------------------------------------------

async function openSavedView() {
  state.view = 'saved';
  savedViewState.loading = true;
  savedViewState.error = null;
  savedViewState.expandedId = null;
  render();
  try {
    savedViewState.surveys = await loadSavedSurveys();
  } catch (err) {
    savedViewState.error = 'Could not load your saved results. Please try again.';
  }
  savedViewState.loading = false;
  renderInPlace();
}

function renderSaved() {
  appEl.innerHTML = `
    <section class="card saved-card">
      <p class="eyebrow">Account</p>
      <h1>My Saved Results</h1>
      <p class="lede">Past TrueNorth surveys you've saved while logged in.</p>
      ${savedViewState.loading ? '<p class="muted">Loading…</p>' : renderSavedList()}
      <div class="nav-row">
        <button type="button" id="saved-back-btn" class="btn btn-secondary">Back</button>
      </div>
    </section>
  `;

  document.getElementById('saved-back-btn').addEventListener('click', () => {
    state.view = 'intro';
    render();
  });

  document.querySelectorAll('.saved-entry-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      savedViewState.expandedId = savedViewState.expandedId === id ? null : id;
      renderInPlace();
    });
  });
}

function renderSavedList() {
  if (savedViewState.error) return `<p class="error-text">${escapeHtml(savedViewState.error)}</p>`;
  if (savedViewState.surveys.length === 0) {
    return '<p class="muted">You haven\'t saved any results yet. Complete the survey and click "Save these results" on your results page to see them here.</p>';
  }
  return `<ul class="saved-list">${savedViewState.surveys.map(renderSavedEntry).join('')}</ul>`;
}

function renderSavedEntry(survey) {
  const isExpanded = savedViewState.expandedId === survey.id;
  const dateLabel =
    survey.createdAt && typeof survey.createdAt.toDate === 'function'
      ? survey.createdAt.toDate().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
      : 'Just now';
  const riskKey = (survey.riskProfile || '').toLowerCase();

  return `
    <li class="saved-entry ${isExpanded ? 'expanded' : ''}">
      <button type="button" class="saved-entry-toggle" data-id="${survey.id}">
        <span class="review-chevron">${chevronIcon()}</span>
        <span class="saved-entry-date">${escapeHtml(dateLabel)}</span>
        ${survey.riskProfile ? `<span class="saved-risk-badge risk-${riskKey}">${escapeHtml(survey.riskProfile)}</span>` : ''}
        <span class="saved-entry-count">${survey.holdings.length} holdings</span>
      </button>
      ${isExpanded ? renderSavedHoldings(survey.holdings) : ''}
    </li>
  `;
}

function renderSavedHoldings(holdings) {
  return `
    <ul class="saved-holdings-list">
      ${holdings
        .map((h) => {
          const tierInfo = TIER_DISPLAY[h.tier] || TIER_DISPLAY.Partial;
          return `
          <li>
            <span class="saved-holding-ticker">${escapeHtml(h.ticker)}</span>
            <span class="saved-holding-name">${escapeHtml(h.name)}</span>
            <span class="tier-badge tier-${tierInfo.cssKey}">${tierInfo.badgeText}</span>
          </li>
        `;
        })
        .join('')}
    </ul>
  `;
}
