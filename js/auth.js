/**
 * Account layer: Firebase Authentication + Firestore save of survey
 * answers, plus the account-related UI (header widget, login/sign-up
 * screen, My Surveys list).
 *
 * Kept separate from app.js on purpose: app.js owns the survey flow
 * (intro/survey/review/results) and knows nothing about accounts beyond
 * calling the functions here; this file owns everything account-related
 * and knows nothing about scoring/questions, except for the one place it
 * has to reach into the survey flow directly: loading a saved survey sets
 * app.js's `state.answers`/`touchedQuestionIds` and jumps straight to the
 * results view (see the "Load" handler in renderMySurveys below) -- there
 * was no clean way to do that without either function knowing a little
 * about the other's state, and this direction (auth.js reaching into
 * `state`) already matches every other place these two files meet
 * (`state.view`, the results screen's Save control).
 *
 * Login is strictly optional — see firebase-config.js's `firebaseReady`.
 * Every function here checks it first and fails softly (never touches the
 * survey/results experience for a signed-out visitor).
 *
 * 2026-08-23: reworked from a single "most recent survey" slot
 * (users/{uid}/savedSurvey/current) into up to MAX_SAVED_SURVEYS named,
 * independently manageable saves (users/{uid}/savedSurveys/{surveyId}),
 * each rename-able and delete-able from a new My Surveys list, and each
 * loadable back into the survey/results flow. Still answers + a timestamp
 * only -- never the computed portfolio -- now plus an editable display
 * name. The single-slot `savedSurvey` collection this superseded, and the
 * even earlier full-portfolio-snapshot `surveys` collection before that,
 * are both left alone in Firestore (and firestore.rules) rather than
 * migrated or deleted -- neither is read or written by this file anymore.
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

// UI-only state for the My Surveys list.
const mySurveysViewState = {
  loading: true,
  error: null,
  surveys: [],
  renamingId: null, // id of the entry currently showing its rename input, or null
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
        await saveNewSurvey(answersToSave);
        state.saveResultState = { status: 'saved', errorMessage: null };
        scheduleSaveResultRevert();
      } catch (err) {
        console.error('saveNewSurvey failed (post-login auto-save):', err);
        state.saveResultState =
          err && err.code === 'survey-limit-reached'
            ? { status: 'limit-reached', errorMessage: err.message }
            : { status: 'error', errorMessage: describeFirestoreError(err, 'Could not save your survey') };
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

// --- Firestore: save/rename/delete/list survey answers -------------------

const MAX_SAVED_SURVEYS = 5;

function savedSurveysCollection() {
  return firebaseDb.collection('users').doc(authState.user.uid).collection('savedSurveys');
}

function formatAutoSurveyName(date) {
  return `Survey — ${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

// Enforces the 5-saved-survey cap client-side (an extra read before the
// write) -- Firestore security rules can restrict WHO can write, not easily
// COUNT a user's existing documents, so there's no server-side quota here.
// That's an acceptable gap for a personal-quota feature bounded to a
// user's own account (see firestore.rules): the worst a client bypassing
// this check could do is store extra data under their own uid, not access
// anyone else's.
async function saveNewSurvey(answers) {
  if (!firebaseReady) throw new Error('Account features are unavailable right now.');
  if (!authState.user) throw new Error('You need to be logged in to save your survey.');

  const coll = savedSurveysCollection();
  const existing = await coll.get();
  if (existing.size >= MAX_SAVED_SURVEYS) {
    const limitErr = new Error(
      `You've reached your limit of ${MAX_SAVED_SURVEYS} saved surveys. Delete one from My Surveys to save a new one.`
    );
    limitErr.code = 'survey-limit-reached';
    throw limitErr;
  }

  await coll.add({
    name: formatAutoSurveyName(new Date()),
    answers,
    savedAt: firebase.firestore.FieldValue.serverTimestamp(),
  });
}

async function listSavedSurveys() {
  if (!firebaseReady || !authState.user) return [];
  const snapshot = await savedSurveysCollection().orderBy('savedAt', 'desc').get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

// Renaming only ever touches `name` -- the underlying answers and the
// original savedAt (still used for sort order after a rename) are
// untouched, per the "does not affect the underlying answers or original
// save timestamp" requirement.
async function renameSavedSurvey(surveyId, newName) {
  if (!firebaseReady || !authState.user) throw new Error('You need to be logged in.');
  await savedSurveysCollection().doc(surveyId).update({ name: newName });
}

async function deleteSavedSurvey(surveyId) {
  if (!firebaseReady || !authState.user) throw new Error('You need to be logged in.');
  await savedSurveysCollection().doc(surveyId).delete();
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
      <button type="button" id="account-my-surveys-link" class="account-widget-link">My Surveys</button>
      <button type="button" id="account-logout-btn" class="account-widget-link">Log Out</button>
    `;
    document.getElementById('account-my-surveys-link').addEventListener('click', openMySurveysView);
    document.getElementById('account-logout-btn').addEventListener('click', async () => {
      await logOut();
      if (state.view === 'account' || state.view === 'surveys') {
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

// --- My Surveys view -------------------------------------------------------

async function openMySurveysView() {
  state.view = 'surveys';
  mySurveysViewState.loading = true;
  mySurveysViewState.error = null;
  mySurveysViewState.renamingId = null;
  // A stale "limit reached" message shouldn't still be sitting on the
  // results screen after the client comes here to make room for a new save.
  state.saveResultState = { status: 'idle', errorMessage: null };
  render();
  try {
    mySurveysViewState.surveys = await listSavedSurveys();
  } catch (err) {
    console.error('listSavedSurveys failed:', err);
    mySurveysViewState.error = describeFirestoreError(err, 'Could not load your saved surveys');
  }
  mySurveysViewState.loading = false;
  renderInPlace();
}

function renderMySurveys() {
  const count = mySurveysViewState.surveys.length;
  appEl.innerHTML = `
    <section class="card surveys-card">
      <p class="eyebrow">Account</p>
      <h1>My Surveys</h1>
      <p class="lede">
        ${mySurveysViewState.loading ? 'Your saved surveys.' : `${count} of ${MAX_SAVED_SURVEYS} saved surveys.`}
      </p>
      ${mySurveysViewState.loading ? '<p class="muted">Loading…</p>' : renderSurveysList()}
      <div class="nav-row">
        <button type="button" id="surveys-back-btn" class="btn btn-secondary">Back</button>
      </div>
    </section>
  `;

  document.getElementById('surveys-back-btn').addEventListener('click', () => {
    state.view = 'intro';
    render();
  });

  wireSurveyEntryButtons();
}

function renderSurveysList() {
  if (mySurveysViewState.error) return `<p class="error-text">${escapeHtml(mySurveysViewState.error)}</p>`;
  if (mySurveysViewState.surveys.length === 0) {
    return '<p class="muted">You haven\'t saved any surveys yet. Complete the questionnaire and click "Save My Survey" on your results page to see it here.</p>';
  }
  return `<ul class="surveys-list">${mySurveysViewState.surveys.map(renderSurveyEntry).join('')}</ul>`;
}

function renderSurveyEntry(survey) {
  const isRenaming = mySurveysViewState.renamingId === survey.id;
  const dateLabel =
    survey.savedAt && typeof survey.savedAt.toDate === 'function'
      ? survey.savedAt.toDate().toLocaleDateString('en-US', { dateStyle: 'medium' })
      : 'Just now';

  if (isRenaming) {
    return `
      <li class="survey-entry survey-entry-renaming" data-id="${survey.id}">
        <form class="survey-rename-form" data-id="${survey.id}">
          <input type="text" class="survey-rename-input" value="${escapeHtml(survey.name)}" maxlength="80" autofocus />
          <button type="submit" class="btn-link-action survey-rename-save">Save</button>
          <button type="button" class="btn-link-action survey-rename-cancel">Cancel</button>
        </form>
      </li>
    `;
  }

  return `
    <li class="survey-entry" data-id="${survey.id}">
      <div class="survey-entry-info">
        <span class="survey-entry-name">${escapeHtml(survey.name)}</span>
        <span class="survey-entry-date">Saved ${escapeHtml(dateLabel)}</span>
      </div>
      <div class="survey-entry-actions">
        <button type="button" class="btn-link-action survey-load-btn" data-id="${survey.id}" ${state.dataset ? '' : 'disabled title="Data still loading — try again in a moment"'}>Load</button>
        <button type="button" class="btn-link-action survey-rename-btn" data-id="${survey.id}">Rename</button>
        <button type="button" class="btn-link-action survey-delete-btn danger" data-id="${survey.id}">Delete</button>
      </div>
    </li>
  `;
}

function wireSurveyEntryButtons() {
  document.querySelectorAll('.survey-load-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const survey = mySurveysViewState.surveys.find((s) => s.id === btn.dataset.id);
      if (survey) loadSurveyIntoResults(survey);
    });
  });

  document.querySelectorAll('.survey-rename-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      mySurveysViewState.renamingId = btn.dataset.id;
      renderInPlace();
    });
  });

  document.querySelectorAll('.survey-rename-cancel').forEach((btn) => {
    btn.addEventListener('click', () => {
      mySurveysViewState.renamingId = null;
      renderInPlace();
    });
  });

  document.querySelectorAll('.survey-rename-form').forEach((form) => {
    form.addEventListener('submit', async (evt) => {
      evt.preventDefault();
      const surveyId = form.dataset.id;
      const input = form.querySelector('.survey-rename-input');
      const newName = input.value.trim();
      if (!newName) return;
      try {
        await renameSavedSurvey(surveyId, newName);
        const entry = mySurveysViewState.surveys.find((s) => s.id === surveyId);
        if (entry) entry.name = newName;
        mySurveysViewState.renamingId = null;
      } catch (err) {
        console.error('renameSavedSurvey failed:', err);
        mySurveysViewState.error = describeFirestoreError(err, 'Could not rename that survey');
      }
      renderInPlace();
    });
  });

  document.querySelectorAll('.survey-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const survey = mySurveysViewState.surveys.find((s) => s.id === btn.dataset.id);
      if (!survey) return;
      const confirmed = window.confirm(`Delete "${survey.name}"? This can't be undone.`);
      if (!confirmed) return;
      try {
        await deleteSavedSurvey(survey.id);
        mySurveysViewState.surveys = mySurveysViewState.surveys.filter((s) => s.id !== survey.id);
      } catch (err) {
        console.error('deleteSavedSurvey failed:', err);
        mySurveysViewState.error = describeFirestoreError(err, 'Could not delete that survey');
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
function loadSurveyIntoResults(survey) {
  if (!state.dataset) return;
  state.answers = { ...survey.answers };
  state.touchedQuestionIds = new Set(
    QUESTIONS.filter((q) => q.type !== 'horizon').map((q) => q.id)
  );
  state.saveResultState = { status: 'idle', errorMessage: null };
  state.view = 'results';
  render();
}
