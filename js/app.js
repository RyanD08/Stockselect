/**
 * UI controller: survey flow + results rendering.
 * All state lives in memory only — nothing is persisted between visits.
 */

const state = {
  view: 'intro', // 'intro' | 'survey' | 'review' | 'results' | 'account' | 'portfolios' | 'watchlist' | 'tickerTester' | 'tickerCompare' | 'sharedResult'
  categoryIndex: 0,
  furthestCategoryIndex: 0, // highest category index reached in the normal forward flow — governs which chips are jumpable
  editOrigin: null, // null | 'review' — set while editing a category reached via the Review screen or the results "Edit My Answers" control
  touchedQuestionIds: new Set(), // questions the client has explicitly tapped an answer for — drives the "answered" highlight
  reviewExpanded: new Set(), // category keys currently expanded on the Review screen
  expandedFinancialDetails: new Set(), // tickers with the "why this holding" details panel (rationale + financials) open on Results
  simulationBreakdownExpanded: false, // whether the $15k historical-simulation company breakdown table is open on Results
  saveResultState: { status: 'idle', errorMessage: null }, // 'idle' | 'saving' | 'saved' | 'error' — the Results screen's "Save My Portfolio" control (see auth.js for the actual save)
  shareResultState: { status: 'idle', url: null, errorMessage: null }, // 'idle' | 'sharing' | 'shared' | 'error' — the Results screen's "Share My Results" control (see createSharedResult in auth.js)
  hasPersonalizedAnswers: false, // true once this session has real answers to score against: finished the survey (set below) or loaded a saved portfolio (see auth.js loadPortfolioIntoResults) — read by ticker-tester.js
  answers: {},
  homeCountry: 'United States',
  tiesSector: '',
  timeHorizon: 'long',
  dataset: null,
  datasetError: null,
};

QUESTIONS.forEach((q) => {
  if (q.type === 'horizon') return; // single-select, stored separately in state.timeHorizon
  state.answers[q.id] = 3; // neutral default
});

const appEl = document.getElementById('app');

// Re-renders the current view without moving the scroll position — for
// in-place UI toggles (accordion expand/collapse, financial-details
// dropdown) where jumping the viewport back to top would be jarring.
function renderInPlace() {
  if (state.view === 'intro') renderIntro();
  else if (state.view === 'survey') renderSurvey();
  else if (state.view === 'review') renderReview();
  else if (state.view === 'results') renderResults();
  else if (state.view === 'account') renderAccount(); // js/auth.js
  else if (state.view === 'portfolios') renderMyPortfolios(); // js/auth.js
  else if (state.view === 'watchlist') renderMyWatchlist(); // js/auth.js
  else if (state.view === 'tickerTester') renderTickerTester(); // js/ticker-tester.js
  else if (state.view === 'tickerCompare') renderTickerCompare(); // js/ticker-tester.js
  else if (state.view === 'sharedResult') renderSharedResult(); // js/auth.js

  // Unconditional, regardless of which view just rendered: the ☆/★
  // watchlist toggle button (js/auth.js) can appear on several different
  // screens (Ticker Tester, Compare, Results, My Watchlist itself), so
  // wiring it once here -- rather than requiring every render function
  // above to remember to call it -- means it's never accidentally missed.
  // A no-op on any view that doesn't happen to render one.
  wireWatchlistToggleButtons(); // js/auth.js
}

// For actual navigation (view/step changes) — re-renders and scrolls to
// top so each new screen or survey step is read from the beginning.
function render() {
  renderInPlace();
  const prefersReducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.scrollTo({ top: 0, behavior: prefersReducedMotion ? 'auto' : 'smooth' });
}

function renderIntro() {
  const hasProgress = state.touchedQuestionIds.size > 0;

  appEl.innerHTML = `
    <section class="card intro-card intro-hero">
      <p class="eyebrow">Values-Guided Investing</p>
      <h1>Find Your True North</h1>
      <p class="lede">
        Answer a short questionnaire about what matters to you as an investor —
        environmental impact, labor practices, governance, ethical screens,
        community ties, and risk philosophy — and we'll build an illustrative,
        equally-weighted portfolio from our sample company dataset that
        reflects your priorities.
      </p>

      <div class="category-preview-row">
        ${CATEGORIES.map(
          (cat) => `
          <div class="category-preview-item">
            <span class="category-icon">${cat.icon}</span>
            <span class="category-preview-label">${escapeHtml(cat.label)}</span>
          </div>
        `
        ).join('')}
      </div>

      <div class="mini-stepper">
        ${CATEGORIES.map(() => '<span class="mini-stepper-dot"></span>').join('')}
        <span class="mini-stepper-text">${CATEGORIES.length} short steps &middot; ~5 min</span>
      </div>

      <div class="intro-cta-row">
        <button id="start-btn" class="btn btn-primary btn-large" ${state.dataset ? '' : 'disabled'}>
          ${!state.dataset ? spinnerHtml('Loading data…') : hasProgress ? 'Continue Your Questionnaire' : 'Start the Questionnaire'}
        </button>
        ${hasProgress ? '<button id="restart-fresh-btn" class="btn-link-inline">Start over instead</button>' : ''}
      </div>
      <p class="intro-privacy-note">Nothing you enter is saved or sent anywhere.</p>
      ${state.datasetError ? `<p class="error-text">Could not load company data: ${escapeHtml(state.datasetError)}</p>` : ''}
    </section>
  `;
  const startBtn = document.getElementById('start-btn');
  if (startBtn) {
    startBtn.addEventListener('click', () => {
      state.view = 'survey';
      if (hasProgress) {
        // Resume where they left off rather than restarting from category 0.
        state.categoryIndex = state.furthestCategoryIndex;
        state.editOrigin = null;
      } else {
        state.categoryIndex = 0;
        state.furthestCategoryIndex = 0;
        state.editOrigin = null;
      }
      render();
    });
  }

  const restartFreshBtn = document.getElementById('restart-fresh-btn');
  if (restartFreshBtn) {
    restartFreshBtn.addEventListener('click', () => {
      resetSurveyState();
      state.view = 'survey';
      render();
    });
  }
}

function renderSurvey() {
  const category = CATEGORIES[state.categoryIndex];
  const questions = questionsForCategory(category.key);
  const isLast = state.categoryIndex === CATEGORIES.length - 1;
  const isEditing = state.editOrigin === 'review';

  appEl.innerHTML = `
    <section class="card survey-card">
      <div class="category-chips">
        ${CATEGORIES.map((cat, i) => renderCategoryChip(cat, i)).join('')}
      </div>
      <div class="survey-sticky-header">
        <p class="step-label">Step ${state.categoryIndex + 1} of ${CATEGORIES.length}</p>
        <h2><span class="category-icon">${category.icon}</span>${escapeHtml(category.label)}</h2>
      </div>
      <p class="scale-hint">For each item, rate how important it is to you: 1 = not important, 5 = very important.</p>
      <div class="questions-list">
        ${questions.map(renderQuestionRow).join('')}
      </div>
      <div class="nav-row">
        ${
          isEditing
            ? '<button id="back-to-review-btn" class="btn btn-primary">Back to Review</button>'
            : `
              <button id="back-btn" class="btn btn-secondary" ${state.categoryIndex === 0 ? 'disabled' : ''}>Back</button>
              <button id="next-btn" class="btn btn-primary">${isLast ? 'Review My Answers' : 'Next'}</button>
            `
        }
      </div>
    </section>
  `;

  questions.forEach((q) => {
    document.querySelectorAll(`.scale-btn[data-question="${q.id}"]`).forEach((btn) => {
      btn.addEventListener('click', () => {
        state.answers[q.id] = Number(btn.dataset.value);
        state.touchedQuestionIds.add(q.id);
        document.querySelectorAll(`.scale-btn[data-question="${q.id}"]`).forEach((b) => {
          const isSelected = b === btn;
          b.classList.toggle('selected', isSelected);
          b.innerHTML = isSelected ? checkmarkIcon() : b.dataset.value;
        });
        document.getElementById(`question-row-${q.id}`).classList.add('touched');
      });
    });
  });

  const homeCountryInput = document.getElementById('home-country-input');
  if (homeCountryInput) {
    homeCountryInput.addEventListener('input', () => {
      state.homeCountry = homeCountryInput.value.trim() || 'United States';
    });
  }

  const tiesSectorSelect = document.getElementById('ties-sector-select');
  if (tiesSectorSelect) {
    tiesSectorSelect.addEventListener('change', () => {
      state.tiesSector = tiesSectorSelect.value;
    });
  }

  document.querySelectorAll('.horizon-option input').forEach((input) => {
    input.addEventListener('change', () => {
      state.timeHorizon = input.value;
      const questionId = Number(input.name.replace('horizon-', ''));
      state.touchedQuestionIds.add(questionId);
      document.getElementById(`question-row-${questionId}`).classList.add('touched');
      document.querySelectorAll('.horizon-option').forEach((label) => {
        label.classList.toggle('selected', label.querySelector('input').value === state.timeHorizon);
      });
    });
  });

  document.querySelectorAll('.category-chip').forEach((btn) => {
    if (btn.disabled) return;
    btn.addEventListener('click', () => {
      state.categoryIndex = Number(btn.dataset.index);
      render();
    });
  });

  if (isEditing) {
    document.getElementById('back-to-review-btn').addEventListener('click', () => {
      state.editOrigin = null;
      state.view = 'review';
      render();
    });
  } else {
    document.getElementById('back-btn').addEventListener('click', () => {
      if (state.categoryIndex > 0) {
        state.categoryIndex -= 1;
        render();
      }
    });

    document.getElementById('next-btn').addEventListener('click', () => {
      if (isLast) {
        state.furthestCategoryIndex = CATEGORIES.length - 1;
        state.view = 'review';
      } else {
        state.categoryIndex += 1;
        state.furthestCategoryIndex = Math.max(state.furthestCategoryIndex, state.categoryIndex);
      }
      render();
    });
  }
}

// A previously-seen category is jumpable at any time (in normal flow or
// while editing from Review); a category not yet reached in the forward
// flow is shown but disabled, since its answers haven't been presented yet.
// Doubles as the survey's felt progress indicator (a connected stepper),
// not just a text label, so it's one component instead of two.
function renderCategoryChip(category, index) {
  const isJumpable = index <= state.furthestCategoryIndex;
  const classes = ['category-chip'];
  if (index === state.categoryIndex) classes.push('active');
  if (isJumpable) classes.push('visited');
  return `
    <button type="button" class="${classes.join(' ')}" data-index="${index}" ${isJumpable ? '' : 'disabled'} title="${escapeHtml(category.label)}">
      <span class="category-chip-icon">${category.icon}</span>
      <span class="category-chip-label">${index + 1}. ${escapeHtml(category.label)}</span>
    </button>
  `;
}

function renderQuestionRow(q) {
  if (q.type === 'horizon') return renderHorizonQuestionRow(q);

  const current = state.answers[q.id];
  const isTouched = state.touchedQuestionIds.has(q.id);
  return `
    <div id="question-row-${q.id}" class="question-row ${isTouched ? 'touched' : ''}">
      <p class="question-text">${escapeHtml(q.text)}</p>
      <div class="scale">
        ${[1, 2, 3, 4, 5]
          .map(
            (v) => `
          <button type="button" class="scale-btn ${v === current ? 'selected' : ''}" data-question="${q.id}" data-value="${v}">
            ${v === current ? checkmarkIcon() : v}
          </button>
        `
          )
          .join('')}
      </div>
      <div class="scale-labels"><span>Not important</span><span>Very important</span></div>
      ${q.needsHomeCountry ? renderHomeCountryInput() : ''}
      ${q.needsTiesSector ? renderTiesSectorSelect() : ''}
    </div>
  `;
}

function renderHorizonQuestionRow(q) {
  const isTouched = state.touchedQuestionIds.has(q.id);
  return `
    <div id="question-row-${q.id}" class="question-row ${isTouched ? 'touched' : ''}">
      <p class="question-text">${escapeHtml(q.text)}</p>
      <div class="horizon-options">
        ${q.options
          .map(
            (opt) => `
          <label class="horizon-option ${state.timeHorizon === opt.value ? 'selected' : ''}">
            <input type="radio" name="horizon-${q.id}" value="${escapeHtml(opt.value)}" ${state.timeHorizon === opt.value ? 'checked' : ''} />
            <span>${escapeHtml(opt.label)}</span>
          </label>
        `
          )
          .join('')}
      </div>
    </div>
  `;
}

function checkmarkIcon() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>';
}

// Simplified compass mark echoing the logo (ring + crosshair ticks +
// needle) — used sparingly as a brand signature beyond the header logo.
function compassMotifIcon() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 2.3v2.4M12 19.3v2.4M2.3 12h2.4M19.3 12h2.4"/><path d="M12 7.5l1.9 5.3-1.9 4-1.9-4Z" fill="currentColor" stroke="none"/></svg>';
}

function renderHomeCountryInput() {
  return `
    <div class="sub-input">
      <label for="home-country-input">Your home country (for the domestic-company match)</label>
      <input id="home-country-input" type="text" value="${escapeHtml(state.homeCountry)}" />
    </div>
  `;
}

function renderTiesSectorSelect() {
  return `
    <div class="sub-input">
      <label for="ties-sector-select">Sector you have personal/professional ties to (optional)</label>
      <select id="ties-sector-select">
        <option value="">None / prefer not to say</option>
        ${SECTOR_OPTIONS.map(
          (s) => `<option value="${escapeHtml(s)}" ${state.tiesSector === s ? 'selected' : ''}>${escapeHtml(s)}</option>`
        ).join('')}
      </select>
    </div>
  `;
}

function renderReview() {
  appEl.innerHTML = `
    <section class="card review-card">
      <h1>Review Your Answers</h1>
      <p class="lede">Check everything below and use Edit to revise anything before we build your portfolio.</p>
      ${CATEGORIES.map((category, i) => renderReviewCategory(category, i)).join('')}
      <div class="nav-row">
        <button id="review-submit-btn" class="btn btn-primary">See My Portfolio</button>
      </div>
    </section>
  `;

  document.querySelectorAll('.review-category-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.categoryKey;
      if (state.reviewExpanded.has(key)) state.reviewExpanded.delete(key);
      else state.reviewExpanded.add(key);
      renderInPlace();
    });
  });

  document.querySelectorAll('.review-edit-btn').forEach((btn) => {
    btn.addEventListener('click', (evt) => {
      evt.stopPropagation();
      state.categoryIndex = Number(btn.dataset.categoryIndex);
      state.editOrigin = 'review';
      state.view = 'survey';
      render();
    });
  });

  document.getElementById('review-submit-btn').addEventListener('click', () => {
    state.hasPersonalizedAnswers = true; // real answers now exist -- see ticker-tester.js
    logAnalyticsEvent('survey_completed'); // js/firebase-config.js
    state.view = 'results';
    render();
  });
}

function renderReviewCategory(category, categoryIndex) {
  const questions = questionsForCategory(category.key);
  const ratedQuestions = questions.filter((q) => q.type !== 'horizon');
  const isCommunity = category.key === 'community';
  const isExpanded = state.reviewExpanded.has(category.key);
  const avg = ratedQuestions.reduce((sum, q) => sum + state.answers[q.id], 0) / ratedQuestions.length;

  return `
    <div class="review-category ${isExpanded ? 'expanded' : ''}">
      <div class="review-category-header">
        <button type="button" class="review-category-toggle" data-category-key="${category.key}">
          <span class="review-chevron">${chevronIcon()}</span>
          <span class="category-icon">${category.icon}</span>
          <span class="review-category-title">${escapeHtml(category.label)}</span>
          <span class="review-avg-meter">
            <span class="review-avg-track"><span class="review-avg-fill" style="width:${(avg / 5) * 100}%"></span></span>
            <span class="review-avg-label">avg ${avg.toFixed(1)}/5</span>
          </span>
        </button>
        <button type="button" class="review-edit-btn" data-category-index="${categoryIndex}">Edit</button>
      </div>
      ${
        isExpanded
          ? `
        <ul class="review-answer-list">
          ${questions
            .map((q) => {
              const answerLabel =
                q.type === 'horizon' ? q.options.find((opt) => opt.value === state.timeHorizon).label : `${state.answers[q.id]}/5`;
              return `<li><span class="review-q-text">${escapeHtml(q.text)}</span><span class="review-q-answer">${escapeHtml(answerLabel)}</span></li>`;
            })
            .join('')}
          ${
            isCommunity
              ? `
            <li><span class="review-q-text">Home country</span><span class="review-q-answer">${escapeHtml(state.homeCountry)}</span></li>
            <li><span class="review-q-text">Industry ties</span><span class="review-q-answer">${state.tiesSector ? escapeHtml(state.tiesSector) : 'None'}</span></li>
          `
              : ''
          }
        </ul>
      `
          : ''
      }
    </div>
  `;
}

function chevronIcon() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
}

// Shared loading indicator -- a small CSS-animated ring (see .spinner in
// css/styles.css) used everywhere a "Loading…"-style label previously stood
// alone, so every async wait in the app reads the same way. `label` is
// optional trailing text; omit it for spinner-only spots (e.g. inside an
// already-labeled disabled button).
function spinnerHtml(label) {
  return `<span class="spinner" role="status" aria-label="Loading"></span>${label ? `<span>${escapeHtml(label)}</span>` : ''}`;
}

// Login is optional (see firebase-config.js/auth.js) — this renders
// nothing at all if Firebase never loaded. One button always: its own
// label carries every state ("Save My Portfolio" / "Saving…" / "Saved!"), and
// a signed-out click redirects to login rather than swapping in a
// different control (see the click handler in renderResults() below).
function renderSaveResultsControl() {
  if (typeof firebaseReady === 'undefined' || !firebaseReady || !authState.ready) return '';

  const { status, errorMessage } = state.saveResultState;

  if (status === 'limit-reached') {
    return `
      <div class="results-toolbar-full save-results-limit">
        <p class="error-text">${escapeHtml(errorMessage)}</p>
        <button type="button" id="go-to-my-portfolios-btn" class="save-results-link">Go to My Portfolios</button>
      </div>
    `;
  }

  const label = status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved!' : 'Save My Portfolio';
  return `
    <span class="results-toolbar-item">
      <button type="button" id="save-results-btn" class="btn btn-primary" ${status === 'saving' ? 'disabled' : ''}>
        ${escapeHtml(label)}
      </button>
      ${status === 'error' ? `<span class="error-text save-results-error">${escapeHtml(errorMessage)}</span>` : ''}
    </span>
  `;
}

// Purely cosmetic: after a successful save, the button's label reverts
// from "Saved!" back to "Save My Portfolio" on its own after a couple of
// seconds, rather than staying changed forever or requiring a click to
// dismiss. Guards against a stale timer firing after the client has since
// saved again, hit an error, or navigated away from the results screen.
function scheduleSaveResultRevert() {
  setTimeout(() => {
    if (state.saveResultState.status !== 'saved') return;
    state.saveResultState = { status: 'idle', errorMessage: null };
    if (state.view === 'results') renderInPlace();
  }, 2500);
}

// Unlike renderSaveResultsControl above, no login check at all -- sharing
// works the same whether or not this visitor is signed in, matching how
// the Results screen itself is already reachable without an account (see
// createSharedResult/firestore.rules for why this is intentionally public).
// Only gated on Firestore actually being available.
function renderShareResultsControl() {
  if (typeof firebaseReady === 'undefined' || !firebaseReady) return '';

  const { status, url, errorMessage } = state.shareResultState;

  if (status === 'shared') {
    return `
      <div class="results-toolbar-full share-results-done">
        <input type="text" class="share-results-link-input" value="${escapeHtml(url)}" readonly />
        <button type="button" id="copy-share-link-btn" class="btn-link-action">Copy Link</button>
      </div>
    `;
  }

  return `
    <span class="results-toolbar-item">
      <button type="button" id="share-results-btn" class="btn btn-primary" ${status === 'sharing' ? 'disabled' : ''}>
        ${status === 'sharing' ? 'Creating link…' : 'Share My Results'}
      </button>
      ${status === 'error' ? `<span class="error-text share-results-error">${escapeHtml(errorMessage)}</span>` : ''}
    </span>
  `;
}

function renderResults() {
  const { riskProfile, holdings } = buildPortfolio(state.dataset, state.answers, {
    homeCountry: state.homeCountry,
    tiesSector: state.tiesSector,
    timeHorizon: state.timeHorizon,
  });
  const topPriorities = QUESTIONS.filter((q) => q.id <= 25 && state.answers[q.id] === 5);

  appEl.innerHTML = `
    <section class="card results-card">
      <p class="eyebrow">Your Recommended Portfolio</p>
      <h1>Your TrueNorth Portfolio</h1>

      <div class="results-toolbar">
        <button type="button" class="btn btn-secondary edit-answers-btn" data-edit-answers>Edit My Answers</button>
        <button type="button" id="ticker-tester-cta-btn" class="btn btn-secondary">Test a Company in Ticker Tester</button>
        ${renderSaveResultsControl()}
        ${renderShareResultsControl()}
      </div>

      <div class="summary-grid">
        <div class="summary-box">
          <h3>Your Top Priorities</h3>
          ${
            topPriorities.length > 0
              ? `<ul class="priority-list">${topPriorities.map((q) => `<li>${escapeHtml(q.short)}</li>`).join('')}</ul>`
              : '<p class="muted">You rated no single criterion as a 5 out of 5 — your priorities are more evenly balanced.</p>'
          }
        </div>
        <div class="summary-box">
          <h3><span class="compass-motif">${compassMotifIcon()}</span>Your Risk Profile</h3>
          <p class="risk-badge risk-${riskProfile.toLowerCase()}"><span class="risk-icon">${riskProfileIcon(riskProfile)}</span>${riskProfile}</p>
          <p class="muted">${riskProfileBlurb(riskProfile)}</p>
        </div>
      </div>

      <h2>Recommended Holdings</h2>
      <p class="muted">
        ${holdings.length} companies, equally weighted at ${holdings.length > 0 ? (100 / holdings.length).toFixed(2) : '0'}% each.
        No more than 5 holdings are drawn from any single sector. Strong Matches are always listed ahead of Partial
        Matches. Domestic-company match is based on headquarters in <strong>${escapeHtml(state.homeCountry)}</strong>.
      </p>

      ${renderSectorChart(holdings)}

      ${renderHistoricalSimulationSection(holdings)}

      <p class="financial-score-framing-note">
        The Financial Score column compares each company's financial profile to others in this tool's
        S&P 500 universe. A
        below-average score does not mean the company is a bad investment — it means it ranks lower on these
        specific metrics relative to a strong peer group.
      </p>

      <div class="table-wrap">
        <table class="results-table holdings-table">
          <thead>
            <tr>
              <th>Ticker</th>
              <th>Company</th>
              <th>Sector</th>
              <th>Match Tier</th>
              <th>Financial Score</th>
              <th>Rationale</th>
            </tr>
          </thead>
          <tbody>
            ${holdings.map(renderHoldingRow).join('')}
          </tbody>
        </table>
      </div>

      <div class="section-divider">${compassMotifIcon()}</div>

      <h2>Portfolio Rationale</h2>
      <div class="rationale">
        ${buildPortfolioRationale(state.answers, riskProfile, holdings)
          .map((p) => `<p>${escapeHtml(p)}</p>`)
          .join('')}
      </div>

      <div class="nav-row">
        <button class="btn btn-secondary edit-answers-btn" data-edit-answers>Edit My Answers</button>
        <button id="restart-btn" class="btn btn-secondary">Start Over</button>
      </div>
    </section>
  `;

  document.querySelectorAll('.financial-toggle-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const ticker = btn.dataset.ticker;
      if (state.expandedFinancialDetails.has(ticker)) state.expandedFinancialDetails.delete(ticker);
      else state.expandedFinancialDetails.add(ticker);
      renderInPlace();
    });
  });

  const saveResultsBtn = document.getElementById('save-results-btn');
  if (saveResultsBtn) {
    saveResultsBtn.addEventListener('click', async () => {
      if (!authState.user) {
        // Not logged in -- stash the answers as they are right now, send
        // them to log in, and let auth.js's onAuthStateChanged finish this
        // save automatically the moment they succeed. No second click.
        logAnalyticsEvent('login_wall_hit', { feature: 'save_portfolio' }); // js/firebase-config.js
        pendingSaveAnswers = { ...state.answers };
        authViewState.mode = 'login';
        authViewState.error = null;
        authViewState.info = null;
        state.view = 'account';
        render();
        return;
      }
      state.saveResultState = { status: 'saving', errorMessage: null };
      renderInPlace();
      try {
        await saveNewPortfolio(state.answers);
        state.saveResultState = { status: 'saved', errorMessage: null };
        scheduleSaveResultRevert();
      } catch (err) {
        // Logged, not just swallowed. The on-screen message also includes
        // the raw Firestore error code (see describeFirestoreError in
        // auth.js) so a real cause like "permission-denied" is diagnosable
        // without opening devtools. The 5-portfolio-limit case is a real,
        // expected outcome rather than a failure, so it gets its own
        // status/message instead of the generic one.
        console.error('saveNewPortfolio failed:', err);
        state.saveResultState =
          err && err.code === 'portfolio-limit-reached'
            ? { status: 'limit-reached', errorMessage: err.message }
            : { status: 'error', errorMessage: describeFirestoreError(err, 'Could not save your portfolio') };
      }
      renderInPlace();
    });
  }

  const shareResultsBtn = document.getElementById('share-results-btn');
  if (shareResultsBtn) {
    shareResultsBtn.addEventListener('click', async () => {
      state.shareResultState = { status: 'sharing', url: null, errorMessage: null };
      renderInPlace();
      try {
        const shareId = await createSharedResult({
          riskProfile,
          topPriorities: topPriorities.map((q) => q.short),
          holdings,
        }); // js/auth.js
        // Routes through the Cloudflare Worker (see cloudflare-worker/) for
        // a per-portfolio link preview once it's deployed and configured --
        // js/firebase-config.js -- otherwise falls back to the plain site
        // link, which still works fine, just with the site's generic preview.
        const url = SHARE_PREVIEW_BASE_URL
          ? `${SHARE_PREVIEW_BASE_URL}/s/${shareId}`
          : `${location.origin}${location.pathname}?shared=${shareId}`;
        state.shareResultState = { status: 'shared', url, errorMessage: null };
        logAnalyticsEvent('share_created', { holdings_count: holdings.length }); // js/firebase-config.js
      } catch (err) {
        console.error('createSharedResult failed:', err);
        state.shareResultState = { status: 'error', url: null, errorMessage: describeFirestoreError(err, 'Could not create a share link') };
      }
      renderInPlace();
    });
  }

  const copyShareLinkBtn = document.getElementById('copy-share-link-btn');
  if (copyShareLinkBtn) {
    copyShareLinkBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(state.shareResultState.url);
        copyShareLinkBtn.textContent = 'Copied!';
        setTimeout(() => {
          copyShareLinkBtn.textContent = 'Copy Link';
        }, 2000);
      } catch (err) {
        // Clipboard API can fail (permissions, non-secure context) -- the
        // link is already visible and selectable in the input field
        // either way, so this is a soft failure, not worth its own message.
      }
    });
  }

  const goToMyPortfoliosBtn = document.getElementById('go-to-my-portfolios-btn');
  if (goToMyPortfoliosBtn) {
    goToMyPortfoliosBtn.addEventListener('click', openMyPortfoliosView);
  }

  const simulationToggleBtn = document.getElementById('simulation-toggle-btn');
  if (simulationToggleBtn) {
    simulationToggleBtn.addEventListener('click', () => {
      state.simulationBreakdownExpanded = !state.simulationBreakdownExpanded;
      renderInPlace();
    });
  }

  // Two buttons (one near the top of the results screen, one in the
  // bottom nav row) trigger the exact same behavior -- the top one exists
  // purely so it's reachable without scrolling on a long results page.
  document.querySelectorAll('[data-edit-answers]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.editOrigin = null;
      state.view = 'review';
      render();
    });
  });

  // Ticker Tester already picks up state.answers/state.hasPersonalizedAnswers
  // on its own (see ticker-tester.js) -- reaching Results at all means
  // hasPersonalizedAnswers is already true, so nothing extra to carry over.
  document.getElementById('ticker-tester-cta-btn').addEventListener('click', () => {
    state.view = 'tickerTester';
    render();
  });

  document.getElementById('restart-btn').addEventListener('click', () => {
    resetSurveyState();
    state.view = 'intro';
    render();
  });
}

// Shared full reset, used by both the results "Start Over" button and the
// intro "Start over instead" link (shown when there's in-progress state to
// discard). Clears everything init() seeds, including touched/expanded UI
// state that a plain answer reset previously missed.
function resetSurveyState() {
  QUESTIONS.forEach((q) => {
    if (q.type === 'horizon') return;
    state.answers[q.id] = 3;
  });
  state.homeCountry = 'United States';
  state.tiesSector = '';
  state.timeHorizon = 'long';
  state.expandedFinancialDetails.clear();
  state.simulationBreakdownExpanded = false;
  state.saveResultState = { status: 'idle', errorMessage: null };
  state.shareResultState = { status: 'idle', url: null, errorMessage: null };
  state.hasPersonalizedAnswers = false;
  state.touchedQuestionIds.clear();
  state.reviewExpanded.clear();
  state.categoryIndex = 0;
  state.furthestCategoryIndex = 0;
  state.editOrigin = null;
}

const TIER_DISPLAY = {
  Strong: { cssKey: 'strong', badgeText: 'Strong Match' },
  Partial: { cssKey: 'partial', badgeText: 'Partial Match' },
  'Below Values Threshold': { cssKey: 'below-threshold', badgeText: 'Below Values Threshold' },
};

function renderHoldingRow(entry) {
  const display = TIER_DISPLAY[entry.tier] || TIER_DISPLAY.Partial;
  const tierClass = `tier-${display.cssKey}`;
  const rowClass = `row-${display.cssKey}`;
  const ticker = entry.company.ticker;
  const isDetailsOpen = state.expandedFinancialDetails.has(ticker);
  return `
    <tr class="${rowClass}">
      <td data-label="Ticker">${escapeHtml(ticker)}${renderWatchlistToggleButton(ticker)}</td>
      <td data-label="Company">${escapeHtml(entry.company.name)}</td>
      <td data-label="Sector">${escapeHtml(entry.company.sector)}</td>
      <td data-label="Match Tier"><span class="tier-badge ${tierClass}">${display.badgeText}</span></td>
      <td data-label="Financial Score">${renderFinancialScoreBadge(entry.company)}</td>
      <td data-label="Rationale">
        ${
          entry.cautionFlags && entry.cautionFlags.length > 0
            ? `<div class="caution-note">⚠ Financial caution: ${entry.cautionFlags.map(escapeHtml).join('; ')}</div>`
            : ''
        }
        <button type="button" class="financial-toggle-btn" data-ticker="${escapeHtml(ticker)}" aria-expanded="${isDetailsOpen}">
          <span class="financial-toggle-chevron ${isDetailsOpen ? 'open' : ''}">${chevronIcon()}</span>
          Why this holding
        </button>
        ${isDetailsOpen ? renderHoldingDetails(entry) : ''}
      </td>
    </tr>
  `;
}

function renderHoldingDetails(entry) {
  return `
    <div class="holding-details">
      <p class="holding-rationale-text">${escapeHtml(entry.rationale)}</p>
      ${entry.note ? `<p class="partial-note">${escapeHtml(entry.note)}</p>` : ''}
      ${renderFinancialDetails(entry.company)}
    </div>
  `;
}

const FINANCIAL_SCORE_LABEL_CLASS = { 'Above Average': 'above', Average: 'average', 'Below Average': 'below' };

function renderFinancialScoreBadge(company) {
  const label = company.financial_metrics.overall_financial_score_label;
  const colorClass = FINANCIAL_SCORE_LABEL_CLASS[label] || 'average';
  return `<span class="financial-score-badge financial-score-${colorClass}">${escapeHtml(label)}</span>`;
}

function renderFinancialDetails(company) {
  const fm = company.financial_metrics;
  const peText =
    fm.pe_ratio === null || fm.pe_ratio === undefined
      ? 'P/E ratio: not meaningful (company is not currently profitable)'
      : `P/E ratio: ${fm.pe_ratio} (lower = cheaper relative to earnings)`;
  const growthText = `Revenue growth: ${fm.revenue_growth_yoy_pct}% year-over-year`;
  const consensusText = `Analyst consensus: ${fm.analyst_consensus}`;
  const yieldTier = company.dividend_policy && company.dividend_policy.yield_tier;
  const dividendText = yieldTier ? `Dividend yield: ${yieldTier}` : 'Dividend yield: none (does not currently pay a dividend)';

  return `
    <ul class="financial-details-list">
      <li>${escapeHtml(peText)}</li>
      <li>${escapeHtml(growthText)}</li>
      <li>${escapeHtml(consensusText)}</li>
      <li>${escapeHtml(dividendText)}</li>
    </ul>
  `;
}

function renderSectorChart(holdings) {
  if (holdings.length === 0) return '';
  const counts = {};
  holdings.forEach((h) => {
    counts[h.company.sector] = (counts[h.company.sector] || 0) + 1;
  });
  const maxCount = Math.max(...Object.values(counts));
  const sectors = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);

  return `
    <div class="sector-chart">
      <h3>Sector Diversification</h3>
      <div class="sector-chart-rows">
        ${sectors
          .map(
            (sector) => `
          <div class="sector-chart-row">
            <span class="sector-chart-label">${escapeHtml(sector)}</span>
            <span class="sector-chart-track"><span class="sector-chart-fill" style="width:${(counts[sector] / maxCount) * 100}%"></span></span>
            <span class="sector-chart-count">${counts[sector]}</span>
          </div>
        `
          )
          .join('')}
      </div>
    </div>
  `;
}

function formatUsd(amount) {
  return amount.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatSignedPct(pct) {
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

// Downstream display-only feature: computeHistoricalSimulation() (js/simulation.js)
// consumes the already-finalized `holdings` list and never feeds back into
// buildPortfolio()/scoring.js. Its disclaimer text now lives in the single
// consolidated disclaimer in the page footer (see index.html +
// initSiteDisclaimerToggle()) rather than pinned here.
function renderHistoricalSimulationSection(holdings) {
  if (holdings.length === 0) return '';

  const sim = computeHistoricalSimulation(holdings);
  const isGain = sim.totalDollarChange >= 0;
  const isExpanded = state.simulationBreakdownExpanded;
  const allIncluded = sim.includedCount === sim.totalCount;

  return `
    <div class="simulation-section">
      <h2>$15,000 Historical Simulation</h2>
      <p class="simulation-hero ${isGain ? 'positive' : 'negative'}">
        Your $15,000 would be worth ${formatUsd(sim.totalValueToday)} today
        (${formatSignedPct(sim.totalPctChange * 100)})
      </p>
      ${
        !allIncluded
          ? `<p class="simulation-coverage-note">Based on ${sim.includedCount} of ${sim.totalCount} companies with complete 12-month pricing data.</p>`
          : ''
      }

      <button type="button" id="simulation-toggle-btn" class="simulation-toggle-btn" aria-expanded="${isExpanded}">
        <span class="financial-toggle-chevron ${isExpanded ? 'open' : ''}">${chevronIcon()}</span>
        See company-by-company breakdown
      </button>

      ${isExpanded ? renderSimulationBreakdownTable(sim) : ''}
    </div>
  `;
}

function renderSimulationBreakdownTable(sim) {
  return `
    <div class="table-wrap simulation-table-wrap">
      <table class="results-table simulation-table">
        <thead>
          <tr>
            <th>Company</th>
            <th>Ticker</th>
            <th>Amount Invested</th>
            <th>Value Today</th>
            <th>% Change</th>
          </tr>
        </thead>
        <tbody>
          ${sim.rows.map(renderSimulationBreakdownRow).join('')}
        </tbody>
        <tfoot>
          <tr class="simulation-total-row">
            <td colspan="2" data-label="Total">Total</td>
            <td data-label="Amount Invested">${formatUsd(sim.perCompanyInvestment * sim.includedCount)}</td>
            <td data-label="Value Today">${formatUsd(sim.totalValueToday)}</td>
            <td data-label="% Change">${formatSignedPct(sim.totalPctChange * 100)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  `;
}

function renderSimulationBreakdownRow(row) {
  if (!row.included) {
    return `
      <tr class="simulation-row-excluded">
        <td data-label="Company">${escapeHtml(row.name)}</td>
        <td data-label="Ticker">${escapeHtml(row.ticker)}</td>
        <td data-label="Status" colspan="3"><span class="simulation-excluded-note">${escapeHtml(row.note)}</span></td>
      </tr>
    `;
  }

  const changeClass = row.pctChange >= 0 ? 'positive' : 'negative';
  return `
    <tr>
      <td data-label="Company">${escapeHtml(row.name)}</td>
      <td data-label="Ticker">${escapeHtml(row.ticker)}</td>
      <td data-label="Amount Invested">${formatUsd(row.amountInvested)}</td>
      <td data-label="Value Today">${formatUsd(row.valueToday)}</td>
      <td data-label="% Change" class="simulation-pct-${changeClass}">${formatSignedPct(row.pctChange)}</td>
    </tr>
  `;
}

const RISK_ICONS = {
  Conservative:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 5-3 8-7 9-4-1-7-4-7-9V6l7-3Z"/></svg>',
  Balanced:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v17"/><path d="M5 8h14"/><path d="M5 8l-3 6h6l-3-6Z"/><path d="M19 8l-3 6h6l-3-6Z"/><path d="M8 20h8"/></svg>',
  Growth:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17l5-6 4 3 7-9"/><path d="M13 5h7v7"/></svg>',
};

function riskProfileIcon(riskProfile) {
  return RISK_ICONS[riskProfile] || '';
}

function riskProfileBlurb(riskProfile) {
  if (riskProfile === 'Conservative') {
    return 'You favor long-term stability, blue-chip/dividend-paying companies, and are less willing to trade returns for values alignment. Your stability, blue-chip, and dividend-income answers each directly rewarded lower-beta, larger-cap, higher-yield holdings in your results — not just as a tie-breaker.';
  }
  if (riskProfile === 'Growth') {
    return 'You favor growth potential and smaller/emerging companies, and are more willing to accept lower stability in pursuit of values alignment. Your stability, blue-chip, and dividend-income answers each directly rewarded higher-return, higher-beta, growth-oriented holdings in your results — not just as a tie-breaker.';
  }
  return 'You are comfortable balancing stability and growth potential. Your financial-quality criterion rewarded the best risk-adjusted profile (return relative to beta) accordingly.';
}

function buildPortfolioRationale(answers, riskProfile, holdings) {
  const topPriorities = QUESTIONS.filter((q) => q.id <= 25 && answers[q.id] === 5).map((q) => q.short);
  const strongCount = holdings.filter((h) => h.tier === 'Strong').length;
  const belowThresholdCount = holdings.filter((h) => h.tier === 'Below Values Threshold').length;
  const partialCount = holdings.length - strongCount - belowThresholdCount;

  const priorityPhrase =
    topPriorities.length > 0
      ? `your strongest stated priorities — ${topPriorities.join(', ')} — `
      : 'the balanced set of priorities you expressed across the questionnaire ';

  const p1 =
    `Based on your responses, we've built a ${holdings.length}-holding portfolio weighted around ${priorityPhrase}` +
    `alongside a ${riskProfile.toLowerCase()} risk profile: your stability, blue-chip, and dividend-income answers ` +
    `each directly influenced every company's score, on top of how much weight you gave financial performance ` +
    `overall. Each company in our sample dataset was scored on how well it aligns with your specific answers, ` +
    `distinguishing criteria you asked us to screen out (like sin-stock exposure or high leverage) from criteria ` +
    `you asked us to seek out (like renewable-energy focus or a founder-led business). A company must clear a minimum ` +
    `overall values-alignment bar to be considered a genuine match at all — good financials alone can't carry a ` +
    `company that doesn't meaningfully align with what you told us you care about.`;

  const p2 =
    `Strong Matches are always listed ahead of Partial Matches: ${strongCount} of the ${holdings.length} holdings ` +
    `are Strong Matches, meaning none of the criteria you rated as a top priority (a 4 or 5 out of 5) produced a ` +
    `meaningful conflict. ${
      partialCount > 0
        ? `${partialCount} are Partial Matches — generally well-aligned with your values overall, but ` +
          `each carries a specific trade-off against one of your top priorities, which we've called out individually ` +
          `in the table above so you can decide whether that trade-off is acceptable to you.`
        : `No holdings required a trade-off against your top priorities.`
    } Your stability, blue-chip, and dividend-income preferences directly influenced every company's score ` +
    `alongside your values answers, rather than only breaking ties between otherwise-equal companies. Positions ` +
    `are equally weighted, and we capped exposure to any single sector at five holdings to keep the portfolio ` +
    `reasonably diversified.${
      belowThresholdCount > 0
        ? ` Not enough companies met the minimum values-match bar within your other preferences to fill all ` +
          `${MAX_PORTFOLIO_SIZE} slots, so the remaining ${belowThresholdCount} are shown as Below Values ` +
          `Threshold — included to complete the portfolio, but flagged individually so you know they didn't clear ` +
          `that bar.`
        : ''
    }`;

  const p3 =
    `As always, values-based investing involves judgment calls, and the data underlying some of these criteria — ` +
    `particularly labor practices, governance details, financial leverage, and the market/performance estimates ` +
    `behind your risk-profile criteria — is illustrative rather than pulled from a live, licensed data feed. We'd encourage ` +
    `you to treat this as a starting point for a conversation, not a finished recommendation.`;

  return [p1, p2, p3];
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// The header logo is static markup (outside the #app render cycle), so its
// listener is wired once here rather than re-attached on every render().
// Navigating home never resets answers/progress — Patch v5's state object
// is reused as-is, so the survey resumes from where the client left off if
// they click back into it (see renderIntro's hasProgress handling).
function initLogoHomeLink() {
  const logoLink = document.getElementById('logo-home-link');
  if (!logoLink) return;
  logoLink.addEventListener('click', (event) => {
    event.preventDefault();
    state.view = 'intro';
    state.editOrigin = null;
    render();
  });
}

// The consolidated site disclaimer in the footer is static markup (outside
// the #app render cycle, present on every view) — its collapsed/expanded
// state is plain DOM state, not part of `state`, since it has nothing to do
// with survey progress and shouldn't reset when the app re-renders.
function initSiteDisclaimerToggle() {
  const toggleBtn = document.getElementById('disclaimer-toggle-btn');
  const fullText = document.getElementById('disclaimer-full-text');
  if (!toggleBtn || !fullText) return;
  toggleBtn.addEventListener('click', () => {
    const isExpanded = toggleBtn.getAttribute('aria-expanded') === 'true';
    toggleBtn.setAttribute('aria-expanded', String(!isExpanded));
    toggleBtn.textContent = isExpanded ? 'Read more' : 'Show less';
    fullText.hidden = isExpanded;
  });
}

// --- Hamburger site nav (static markup outside #app, present on every view) --
//
// 2026-08-25: replaced the old header nav (a single "Ticker Tester" text
// link, plus "My Portfolios"/"My Watchlist" living inside the account
// widget -- see renderAccountWidget, auth.js) with one hamburger menu
// listing all four features. Per explicit requirement, every item is
// always visible regardless of login state -- only Ticker Tester itself
// needs no login; My Portfolios, My Watchlist, and Compare Two Companies
// each redirect a logged-out click to the login screen (see each item's
// handler below) using the same "stash intent, send to login, finish
// automatically once signed in" pattern already established for Save My
// Portfolio, Compare's own in-Ticker-Tester CTA, and My Watchlist's ☆
// button (see pendingSaveAnswers/pendingCompareRedirect/pendingWatchlistAdd
// in auth.js) -- pendingPortfoliosRedirect/pendingWatchlistViewRedirect
// (also auth.js) are the same pattern applied to these two new entry
// points specifically, kept as their own separate flags rather than
// folded into the existing ones since each names a distinct pending
// action, consistent with how every prior pending-flag here is scoped to
// one specific action rather than a shared generic one.
//
// The dropdown's open/closed state is plain DOM state (hidden attribute +
// aria-expanded), not part of `state` -- it has nothing to do with survey
// progress or which view is showing, and doesn't need to survive
// renderInPlace()'s innerHTML replacement of #app (this region lives
// outside #app entirely, same as the account widget and logo link).

function toggleHamburgerDropdown() {
  const dropdown = document.getElementById('hamburger-dropdown');
  const btn = document.getElementById('hamburger-btn');
  if (!dropdown || !btn) return;
  const willOpen = dropdown.hidden;
  dropdown.hidden = !willOpen;
  btn.setAttribute('aria-expanded', String(willOpen));
}

function closeHamburgerDropdown() {
  const dropdown = document.getElementById('hamburger-dropdown');
  const btn = document.getElementById('hamburger-btn');
  if (!dropdown || dropdown.hidden) return;
  dropdown.hidden = true;
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

// Redirects a logged-out click on a gated menu item to the login screen,
// stashing `pendingFlagSetter` (called with true) so onAuthStateChanged
// (auth.js) can finish the navigation automatically once they sign in.
function redirectGatedNavItemToLogin(setPending, feature) {
  logAnalyticsEvent('login_wall_hit', { feature }); // js/firebase-config.js
  setPending();
  authViewState.mode = 'login';
  authViewState.error = null;
  authViewState.info = null;
  state.view = 'account';
  render();
}

// Shared navigation actions -- both the hamburger dropdown (mobile, below
// the .site-nav-bar breakpoint) and the desktop nav bar (see
// initDesktopNavBar below) call these same four functions rather than
// each keeping its own copy of the login-gating logic, so a click reaches
// the same destination with the same behavior either way.
function navigateToTickerTester() {
  closeHamburgerDropdown();
  openTickerTester(); // js/ticker-tester.js -- no login gate, open to everyone
}

function navigateToCompare() {
  closeHamburgerDropdown();
  if (typeof firebaseReady !== 'undefined' && firebaseReady && authState.user) {
    enterTickerCompare(); // js/ticker-tester.js
    return;
  }
  redirectGatedNavItemToLogin(() => {
    pendingCompareRedirect = true; // js/auth.js -- same flag Compare's own in-Ticker-Tester CTA already uses
  }, 'compare');
}

function navigateToPortfolios() {
  closeHamburgerDropdown();
  if (typeof firebaseReady !== 'undefined' && firebaseReady && authState.user) {
    openMyPortfoliosView(); // js/auth.js
    return;
  }
  redirectGatedNavItemToLogin(() => {
    pendingPortfoliosRedirect = true; // js/auth.js
  }, 'my_portfolios');
}

function navigateToWatchlist() {
  closeHamburgerDropdown();
  if (typeof firebaseReady !== 'undefined' && firebaseReady && authState.user) {
    openMyWatchlistView(); // js/auth.js
    return;
  }
  redirectGatedNavItemToLogin(() => {
    pendingWatchlistViewRedirect = true; // js/auth.js
  }, 'my_watchlist');
}

// Rebuilt (not just re-wired) on init and every auth-state change -- see
// its two call sites -- since the one auth-dependent piece of its content
// (the signed-in client's email, shown as a non-interactive line at the
// top) needs to stay in sync; the menu items themselves don't change
// based on login state, only what happens when they're clicked.
function renderSiteNavMenu() {
  const dropdown = document.getElementById('hamburger-dropdown');
  if (!dropdown) return;

  dropdown.innerHTML = `
    ${authState.user ? `<div class="hamburger-user-email">${escapeHtml(authState.user.email)}</div>` : ''}
    <button type="button" id="nav-menu-tickertester" class="hamburger-item" role="menuitem">Ticker Tester</button>
    <button type="button" id="nav-menu-compare" class="hamburger-item" role="menuitem">Compare Two Companies</button>
    <button type="button" id="nav-menu-portfolios" class="hamburger-item" role="menuitem">My Portfolios</button>
    <button type="button" id="nav-menu-watchlist" class="hamburger-item" role="menuitem">My Watchlist</button>
  `;

  document.getElementById('nav-menu-tickertester').addEventListener('click', navigateToTickerTester);
  document.getElementById('nav-menu-compare').addEventListener('click', navigateToCompare);
  document.getElementById('nav-menu-portfolios').addEventListener('click', navigateToPortfolios);
  document.getElementById('nav-menu-watchlist').addEventListener('click', navigateToWatchlist);
}

function initSiteNavMenu() {
  const btn = document.getElementById('hamburger-btn');
  if (!btn) return;
  btn.addEventListener('click', (evt) => {
    evt.stopPropagation();
    toggleHamburgerDropdown();
  });
  // Outside-click closes the dropdown -- important on mobile, where
  // there's no natural "click elsewhere" affordance otherwise.
  document.addEventListener('click', (evt) => {
    const dropdown = document.getElementById('hamburger-dropdown');
    if (!dropdown || dropdown.hidden) return;
    if (dropdown.contains(evt.target) || btn.contains(evt.target)) return;
    closeHamburgerDropdown();
  });
  renderSiteNavMenu();
}

// The desktop nav bar (#site-nav-bar, index.html) -- static markup, wired
// once, unlike the hamburger dropdown above. It has no auth-dependent
// content to rebuild (the signed-in email lives in the dropdown only, not
// here), and CSS hides this whole element below the same breakpoint that
// hides .site-nav-menu, so exactly one of the two is ever reachable.
function initDesktopNavBar() {
  const bar = document.getElementById('site-nav-bar');
  if (!bar) return;
  document.getElementById('nav-bar-tickertester').addEventListener('click', navigateToTickerTester);
  document.getElementById('nav-bar-compare').addEventListener('click', navigateToCompare);
  document.getElementById('nav-bar-portfolios').addEventListener('click', navigateToPortfolios);
  document.getElementById('nav-bar-watchlist').addEventListener('click', navigateToWatchlist);
}

async function init() {
  initLogoHomeLink();
  initSiteDisclaimerToggle();
  initSiteNavMenu();
  initDesktopNavBar();

  // A ?shared=<id> link (see createSharedResult/renderShareResultsControl)
  // lands here before the usual intro screen -- doesn't need state.dataset
  // at all, since everything to render is already baked into the snapshot
  // doc itself, so it's checked first rather than waiting on the load below.
  const sharedId = new URLSearchParams(location.search).get('shared');
  if (sharedId) {
    openSharedResultView(sharedId); // js/auth.js -- handles its own render()
  } else {
    render();
  }

  try {
    state.dataset = await loadDataset();
  } catch (err) {
    state.datasetError = err.message;
  }
  if (state.view === 'intro') render();
}

init();
