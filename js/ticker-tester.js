/**
 * Ticker Tester: look up one company and see how it scores against the
 * client's own values priorities -- a 1-10 score per category plus a
 * radar chart, not a question-by-question list (see 2026-08-23c below).
 *
 * Deliberately its own file/screen, not merged into the survey/results
 * flow (app.js) -- reachable from the header nav to any visitor, logged in
 * or not, independent of where they are in the main survey. Structured to
 * be extended later (e.g. comparing multiple tickers) without touching
 * app.js's own render dispatch beyond the one line that routes to it.
 *
 * Scoring: calls buildScoredEntry(), meetsValuesFloor(), isBlueChipEligible(),
 * financialQualityAlignment(), and questionHasData() directly from
 * scoring.js -- the exact same functions buildPortfolio() calls for all
 * ~500 companies, just applied to the one selected company. There is no
 * second scoring implementation here; a company scored "Strong Match" here
 * will always also be a Strong Match in a real portfolio built from the
 * same answers (mirrors buildPortfolio's own floor-check/tier-override/
 * blue-chip-filter logic exactly, see buildCompanyScoreEntry below).
 *
 * Personalization source (see hasPersonalizationSource()): reuses
 * app.js's `state.answers` as-is, gated on `state.hasPersonalizedAnswers`
 * -- a flag app.js sets true once the client reaches Results by finishing
 * the survey, and auth.js sets true when a saved portfolio is loaded (see
 * both files). Because both actions write into the same `state.answers`,
 * whichever happened most recently is naturally what's used -- no separate
 * "which source" bookkeeping needed here.
 *
 * 2026-08-23d: a signed-in client with saved portfolios but no in-session
 * answers (hadn't touched the survey or explicitly opened My Portfolios
 * this session) landed on the "log in / complete the survey" prompt despite
 * already being logged in -- confusing, since the actual missing piece was
 * just "which saved portfolio." Fixed with maybeAutoLoadRecentPortfolio():
 * on entering Ticker Tester, if personalization is still unavailable and
 * the client is signed in, it silently fetches their saved portfolios
 * (listSavedPortfolios(), from auth.js -- already sorted newest-first) and
 * loads the most recent one in place, the same way loadPortfolioIntoResults
 * does, minus the navigation to Results. A client with zero saved
 * portfolios still correctly falls through to the same prompt as before.
 *

 * 2026-08-23c: replaced the full 27/29-criterion breakdown with a per-
 * category (7 categories) 1-10 score plus a Chart.js radar chart. Each
 * category's score is a weighted average of that category's own
 * per-question alignment values (the exact same `entry.alignments[qid]`
 * scoring.js already computed for the tier/rationale above -- see
 * computeCategoryScore) weighted by the client's own 1-5 importance rating
 * per question, then rescaled from alignment's [-1,+1] range onto 1-10.
 * This is a new AGGREGATION of already-computed scoring data, not a new
 * scoring method -- no company's underlying alignment on any question is
 * computed any differently than it already was for the main tier/score.
 * Chart.js is loaded via CDN (see index.html) and degrades to just the
 * numeric list (no crash, no blank space) if it fails to load, matching
 * this site's existing pattern for every other optional external SDK.
 *
 * 2026-08-25: added Compare Two Companies -- a login-gated second mode of
 * this same screen (state.view = 'tickerCompare', see enterTickerCompare
 * below) that puts two companies side by side with one overlaid radar
 * chart and a plain-language verdict on which better fits the client's
 * values. Reuses every existing building block (buildCompanyScoreEntry,
 * computeCategoryScores, tickerTierDisplay, renderRawCompanyData,
 * hasPersonalizationSource) with zero duplicate scoring logic -- see the
 * comment above renderCompareVerdict for the one genuinely new piece (a
 * head-to-head financial tiebreaker), since sortScoredEntries only ever
 * ranks one company against the field, never compares two specific
 * companies to each other, so there was nothing existing to call into for
 * that specific step. Gating: the "Compare Two Companies" button is
 * always visible to a logged-out visitor, but clicking it shows an inline
 * login-required prompt in place of entering compare mode (never a silent
 * redirect) -- logging in from that prompt uses the same pendingSaveAnswers-
 * style pattern as "Save My Portfolio" (see pendingCompareRedirect in
 * auth.js) to land the client straight in compare mode with no second
 * click required.
 */

const tickerTesterState = {
  query: '',
  selectedTicker: null,
  // 'idle' | 'loading' | 'done' | 'none-found' | 'error' -- see
  // maybeAutoLoadRecentPortfolio() below. Reset to 'idle' each time the
  // client navigates to Ticker Tester fresh (initTickerTesterNav), so a
  // portfolio saved since their last visit gets picked up.
  autoLoadState: 'idle',
  // Whether the inline "Compare Two Companies requires an account" prompt
  // is showing in place of the Compare CTA button -- see
  // renderTickerCompareCta/wireTickerCompareCta below.
  showCompareLoginPrompt: false,
};

// State for Compare Two Companies (state.view = 'tickerCompare') -- reset
// fresh every time enterTickerCompare() runs, same convention as
// tickerTesterState's own reset in initTickerTesterNav below.
const tickerCompareState = {
  queryA: '',
  queryB: '',
  tickerA: null,
  tickerB: null,
  // True right after the client tries to pick the same company already in
  // the other slot -- shows a message instead of allowing the duplicate;
  // see wireCompareSearchSlot.
  duplicateAttempted: false,
};

// Chart.js requires destroying a previous chart bound to a <canvas> before
// creating a new one there, or it throws "Canvas is already in use" --
// tracked here so selecting a different company (which re-renders the same
// canvas id) replaces the chart cleanly instead of erroring.
let tickerRadarChartInstance = null;

// Same reasoning as tickerRadarChartInstance above, for Compare's own
// separate two-dataset chart/canvas (see renderCompareRadarChartIfPresent).
let tickerCompareRadarChartInstance = null;

function initTickerTesterNav() {
  const btn = document.getElementById('ticker-tester-nav-btn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    tickerTesterState.query = '';
    tickerTesterState.selectedTicker = null;
    tickerTesterState.autoLoadState = 'idle';
    tickerTesterState.showCompareLoginPrompt = false;
    state.view = 'tickerTester';
    render();
  });
}

// Shared entry point into Compare Two Companies -- called both when an
// already-logged-in client clicks the Compare CTA directly, and by
// auth.js's onAuthStateChanged once a client who saw the login-required
// prompt finishes logging in (see pendingCompareRedirect there). Always
// starts from a blank slate (no carried-over selections from a previous
// compare session), same convention as initTickerTesterNav above.
function enterTickerCompare() {
  tickerCompareState.queryA = '';
  tickerCompareState.queryB = '';
  tickerCompareState.tickerA = null;
  tickerCompareState.tickerB = null;
  tickerCompareState.duplicateAttempted = false;
  tickerTesterState.showCompareLoginPrompt = false;
  state.view = 'tickerCompare';
  render();
}

function hasPersonalizationSource() {
  return !!state.hasPersonalizedAnswers;
}

// Fires (at most once per Ticker Tester visit -- see autoLoadState) when
// personalization isn't available yet but the client is signed in: fetches
// their saved portfolios and loads the most recent one in place. A no-op
// if personalization is already available, the client isn't signed in, or
// an attempt has already started/finished this visit.
function maybeAutoLoadRecentPortfolio() {
  if (hasPersonalizationSource()) return;
  if (typeof firebaseReady === 'undefined' || !firebaseReady || !authState.user) return;
  if (tickerTesterState.autoLoadState !== 'idle') return;

  tickerTesterState.autoLoadState = 'loading';
  listSavedPortfolios()
    .then((portfolios) => {
      if (portfolios.length === 0) {
        tickerTesterState.autoLoadState = 'none-found';
        renderInPlace();
        return;
      }
      const mostRecent = portfolios[0]; // listSavedPortfolios already orders newest-first
      state.answers = { ...mostRecent.answers };
      state.touchedQuestionIds = new Set(QUESTIONS.filter((q) => q.type !== 'horizon').map((q) => q.id));
      state.hasPersonalizedAnswers = true;
      tickerTesterState.autoLoadState = 'done';
      renderInPlace();
    })
    .catch((err) => {
      console.error('Ticker Tester: auto-loading the most recent saved portfolio failed:', err);
      tickerTesterState.autoLoadState = 'error';
      renderInPlace();
    });
}

function tickerTesterCtx() {
  return {
    homeCountry: state.homeCountry,
    tiesSector: state.tiesSector,
    timeHorizon: state.timeHorizon,
  };
}

// Mirrors buildPortfolio()'s own per-company logic exactly (see
// scoring.js): the hard blue-chip filter, the values-floor tier override,
// and buildScoredEntry() itself. Kept as one small function here purely so
// Ticker Tester's two call sites (top summary + breakdown) don't each
// re-derive ctx/riskProfile separately -- not a second scoring pass.
function buildCompanyScoreEntry(company) {
  const ctx = tickerTesterCtx();
  const riskProfile = deriveRiskProfile(state.answers);
  if (!isBlueChipEligible(company, state.answers)) {
    return { blueChipExcluded: true, riskProfile };
  }
  const entry = buildScoredEntry(company, state.answers, ctx, riskProfile);
  if (!meetsValuesFloor(company, state.answers, ctx)) {
    entry.tier = 'Below Values Threshold';
    entry.note = BELOW_VALUES_THRESHOLD_NOTE;
  }
  return { entry, riskProfile, ctx };
}

function filterCompanies(query) {
  if (!state.dataset) return [];
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const matches = state.dataset.companies.filter(
    (c) => c.ticker.toLowerCase().includes(q) || c.name.toLowerCase().includes(q)
  );
  matches.sort((a, b) => {
    const aExact = a.ticker.toLowerCase() === q ? 0 : a.ticker.toLowerCase().startsWith(q) ? 1 : 2;
    const bExact = b.ticker.toLowerCase() === q ? 0 : b.ticker.toLowerCase().startsWith(q) ? 1 : 2;
    if (aExact !== bExact) return aExact - bExact;
    return a.ticker.localeCompare(b.ticker);
  });
  return matches.slice(0, 25);
}

function renderTickerTester() {
  if (!state.dataset) {
    appEl.innerHTML = `
      <section class="card ticker-tester-card">
        <p class="eyebrow">Ticker Tester</p>
        <h1>Ticker Tester</h1>
        <p class="muted">Loading company data…</p>
        <div class="nav-row">
          <button type="button" id="ticker-tester-back-btn" class="btn btn-secondary">Back</button>
        </div>
      </section>
    `;
    wireTickerTesterBackButton();
    return;
  }

  maybeAutoLoadRecentPortfolio();

  const company = tickerTesterState.selectedTicker
    ? state.dataset.companies.find((c) => c.ticker === tickerTesterState.selectedTicker)
    : null;

  appEl.innerHTML = `
    <section class="card ticker-tester-card">
      <p class="eyebrow">Ticker Tester</p>
      <h1>Ticker Tester</h1>
      <p class="lede">Look up a single company from our sample dataset and see how it stacks up against your own values priorities.</p>

      ${renderTickerCompareCta()}

      ${renderTickerSearch()}

      ${company ? renderTickerResult(company) : ''}

      <div class="nav-row">
        <button type="button" id="ticker-tester-back-btn" class="btn btn-secondary">Back</button>
      </div>
    </section>
  `;

  wireTickerTesterBackButton();
  wireTickerCompareCta();
  wireTickerSearch();
  if (company) {
    wireTickerResultActions();
    renderTickerRadarChartIfPresent(company);
  } else {
    destroyTickerRadarChart();
  }
}

// Always-visible entry point into Compare Two Companies, above the
// single-company search box. Logged-in visitors go straight into compare
// mode; logged-out visitors see this swap for an inline login-required
// message instead (never a silent navigation away) -- see
// wireTickerCompareCta for the click handling and pendingCompareRedirect
// in auth.js for what happens once they actually log in from here.
function renderTickerCompareCta() {
  if (tickerTesterState.showCompareLoginPrompt) {
    return `
      <div class="ticker-personalize-prompt ticker-compare-login-prompt">
        <p>Comparing two companies requires an account. Log in (or create one for free) to unlock Compare Two Companies.</p>
        <p class="ticker-personalize-actions">
          <button type="button" id="ticker-compare-login-btn" class="btn btn-primary">Log In</button>
          <button type="button" id="ticker-compare-login-dismiss-btn" class="btn-link-inline">Never mind</button>
        </p>
      </div>
    `;
  }
  return `
    <p class="ticker-compare-cta-row">
      <button type="button" id="ticker-compare-cta-btn" class="btn btn-primary btn-large">Compare Two Companies</button>
    </p>
  `;
}

function wireTickerCompareCta() {
  const ctaBtn = document.getElementById('ticker-compare-cta-btn');
  if (ctaBtn) {
    ctaBtn.addEventListener('click', () => {
      if (typeof firebaseReady !== 'undefined' && firebaseReady && authState.user) {
        enterTickerCompare();
        return;
      }
      tickerTesterState.showCompareLoginPrompt = true;
      renderInPlace();
    });
  }

  const loginBtn = document.getElementById('ticker-compare-login-btn');
  if (loginBtn) {
    loginBtn.addEventListener('click', () => {
      // Consumed by auth.js's onAuthStateChanged once login succeeds --
      // same "stash intent, finish automatically post-login" pattern as
      // pendingSaveAnswers for "Save My Portfolio".
      pendingCompareRedirect = true;
      authViewState.mode = 'login';
      authViewState.error = null;
      authViewState.info = null;
      state.view = 'account';
      render();
    });
  }

  const dismissBtn = document.getElementById('ticker-compare-login-dismiss-btn');
  if (dismissBtn) {
    dismissBtn.addEventListener('click', () => {
      tickerTesterState.showCompareLoginPrompt = false;
      renderInPlace();
    });
  }
}

function wireTickerTesterBackButton() {
  document.getElementById('ticker-tester-back-btn').addEventListener('click', () => {
    state.view = 'intro';
    render();
  });
}

function renderTickerSearch() {
  const results = filterCompanies(tickerTesterState.query);
  // No longer gated on "!selectedTicker" -- typing here works the same
  // way whether or not a company is currently shown below, so switching
  // companies never requires the "Choose a different company" link first;
  // that link still exists purely to clear back to a blank search.
  const showDropdown = tickerTesterState.query.trim().length > 0;

  return `
    <div class="ticker-search">
      <label for="ticker-search-input">${tickerTesterState.selectedTicker ? 'Search for a different company' : 'Search by company name or ticker'}</label>
      <input
        type="text"
        id="ticker-search-input"
        autocomplete="off"
        placeholder="e.g. Apple or AAPL"
        value="${escapeHtml(tickerTesterState.query)}"
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
                <button type="button" class="ticker-search-result" data-ticker="${escapeHtml(c.ticker)}">
                  <span class="ticker-search-result-ticker">${escapeHtml(c.ticker)}</span>
                  <span class="ticker-search-result-name">${escapeHtml(c.name)}</span>
                  <span class="ticker-search-result-sector">${escapeHtml(c.sector)}</span>
                </button>
              </li>
            `
                  )
                  .join('')
              : '<li class="ticker-search-empty">No matching companies found.</li>'
          }
        </ul>
      `
          : ''
      }
    </div>
  `;
}

function wireTickerSearch() {
  const input = document.getElementById('ticker-search-input');
  if (!input) return;
  input.addEventListener('input', () => {
    tickerTesterState.query = input.value;
    renderInPlace();
    // Re-render moves focus/cursor to the end by default -- restore it so
    // typing feels continuous rather than jumping.
    const refocused = document.getElementById('ticker-search-input');
    if (refocused) {
      refocused.focus();
      refocused.setSelectionRange(refocused.value.length, refocused.value.length);
    }
  });

  document.querySelectorAll('.ticker-search-result').forEach((btn) => {
    btn.addEventListener('click', () => {
      tickerTesterState.selectedTicker = btn.dataset.ticker;
      tickerTesterState.query = '';
      renderInPlace();
    });
  });
}

function wireTickerResultActions() {
  const changeBtn = document.getElementById('ticker-tester-change-btn');
  if (changeBtn) {
    changeBtn.addEventListener('click', () => {
      tickerTesterState.selectedTicker = null;
      tickerTesterState.query = '';
      renderInPlace();
    });
  }
  const takeSurveyBtn = document.getElementById('ticker-tester-take-survey-btn');
  if (takeSurveyBtn) {
    takeSurveyBtn.addEventListener('click', () => {
      state.view = 'survey';
      render();
    });
  }
  const loginBtn = document.getElementById('ticker-tester-login-btn');
  if (loginBtn) {
    loginBtn.addEventListener('click', () => {
      authViewState.mode = 'login';
      authViewState.error = null;
      authViewState.info = null;
      state.view = 'account';
      render();
    });
  }
}

function renderTickerResult(company) {
  const changeCompanyRow = `
    <p class="ticker-result-change-row">
      <button type="button" id="ticker-tester-change-btn" class="btn-link-inline">&larr; Choose a different company</button>
    </p>
  `;

  if (!hasPersonalizationSource()) {
    if (tickerTesterState.autoLoadState === 'loading') {
      return `
        <div class="ticker-result">
          ${changeCompanyRow}
          <p class="muted">Loading your most recent saved portfolio…</p>
          ${renderRawCompanyData(company)}
        </div>
      `;
    }
    // Signed in but nothing to auto-load (no saved portfolios, or the
    // fetch itself failed) -- same prompt as a signed-out visitor, since
    // "Log In" is a no-op for them but "Take the Survey" still applies.
    return `
      <div class="ticker-result">
        ${changeCompanyRow}
        <div class="ticker-personalize-prompt">
          <p>
            Complete the survey or log in and load a saved portfolio to see how ${escapeHtml(company.name)} matches
            your personal values.
          </p>
          <p class="ticker-personalize-actions">
            <button type="button" id="ticker-tester-take-survey-btn" class="btn btn-secondary">Take the Survey</button>
            <button type="button" id="ticker-tester-login-btn" class="btn btn-secondary">Log In</button>
          </p>
        </div>
        ${renderRawCompanyData(company)}
      </div>
    `;
  }

  const scored = buildCompanyScoreEntry(company);

  if (scored.blueChipExcluded) {
    return `
      <div class="ticker-result">
        ${changeCompanyRow}
        <div class="ticker-personalize-prompt">
          <p>
            You rated "large, established blue-chip companies" a 5/5 -- your hardest requirement. ${escapeHtml(company.name)}
            (${escapeHtml(company.market_profile.market_cap_tier)} cap) doesn't meet that bar, so it would never
            appear in your recommended portfolio regardless of how well it otherwise matches your values.
          </p>
        </div>
        ${renderRawCompanyData(company)}
      </div>
    `;
  }

  const { entry, ctx } = scored;
  const display = tickerTierDisplay(entry.tier);
  const categoryScores = computeCategoryScores(company, entry, ctx);
  // Low Match's note is the generic BELOW_VALUES_THRESHOLD_NOTE boilerplate
  // (see buildCompanyScoreEntry) written for the main portfolio's "filling
  // out 15 slots" context, which doesn't apply here -- suppressed for that
  // tier specifically. Partial Match's note (which conflicting criteria
  // caused it) is a different, still-useful message and stays.
  const showNote = entry.note && entry.tier !== 'Below Values Threshold';

  return `
    <div class="ticker-result">
      ${changeCompanyRow}
      <div class="ticker-result-summary">
        <h2>${escapeHtml(company.name)} (${escapeHtml(company.ticker)})</h2>
        <p><span class="tier-badge tier-${display.cssKey}">${display.badgeText}</span></p>
        <p class="ticker-result-rationale">${escapeHtml(entry.rationale)}</p>
        ${showNote ? `<p class="ticker-result-note muted">${escapeHtml(entry.note)}</p>` : ''}
        ${
          entry.cautionFlags && entry.cautionFlags.length > 0
            ? `<p class="caution-note">⚠ Financial caution: ${entry.cautionFlags.map(escapeHtml).join('; ')}</p>`
            : ''
        }
      </div>

      ${renderCategorySection(company, categoryScores)}
    </div>
  `;
}

// Ticker Tester's own badge labeling only -- the shared TIER_DISPLAY object
// (app.js) still drives the main portfolio results table unchanged, since
// this relabeling is explicitly scoped to Ticker Tester. No change to
// entry.tier itself or anything that decides which tier a company gets --
// purely a display-layer rename ("Below Values Threshold" -> "Low Match",
// gray -> red) of the exact same value already computed above.
function tickerTierDisplay(tier) {
  if (tier === 'Below Values Threshold') return { cssKey: 'low-match', badgeText: 'Low Match' };
  return TIER_DISPLAY[tier] || TIER_DISPLAY.Partial;
}

// One 1-10 score per category, using the *exact same weighting rules and
// formula shape* scoreCompany() (scoring.js) uses for the real portfolio
// score -- this is deliberately not a separate Ticker-Tester-only scoring
// method (three different ones were tried here over 2026-08-24 alone: a
// 5.5-midpoint average, a 10-is-the-ceiling average, and a multiplicative
// violation-penalty model -- all reverted/replaced by explicit request in
// favor of just reusing the main engine's own math):
//   - Questions 1-25 (SCORED_QUESTION_IDS): importance = the client's 1-5
//     rating SQUARED, exactly like unitImportance() -- and, like
//     scoreCompany(), a question this company has no verifiable data on
//     (questionHasData) contributes zero importance rather than being
//     treated as a false "neutral," so it can't be counted at all, in
//     either direction.
//   - Questions 26/28/29 (RISK_DIRECT_QUESTION_IDS): importance =
//     rating - 1 (so a rating of 1 is a true no-op, never a data-gate),
//     same as scoreCompany's own RISK_DIRECT_QUESTION_IDS loop.
//   - Question 27 (values-over-returns): only its second role in
//     scoreCompany (the direct "reward weaker financial quality"
//     alignment, importance = rating - 1) applies here -- its first role
//     (financialImportance/financialAlignment, weighting overall
//     financial quality as its own criterion) isn't tied to any of the 7
//     categories a client sees, so it's excluded from every category
//     subtotal the same way it always has been in this file.
//   - raw = denominator > 0 ? 50 + 50*(numerator/denominator) : 50,
//     clamped to [0,100] -- identical to scoreCompany's own formula --
//     then divided by 10 for this file's existing 1-10 display scale.
// Deliberately excluded: scoreCompany's overrepPenalty. That's a whole-
// company anti-clustering adjustment computed from negative alignments
// across ALL 25 values questions at once, not attributable to any single
// category, so there's no correct way to allocate a slice of it into a
// per-category subtotal -- omitting it (as every version of this function
// always has) is the only sound choice, not an oversight.
function computeCategoryScores(company, entry, ctx) {
  const financialAlignment = financialQualityAlignment(company, deriveRiskProfile(state.answers), ctx.timeHorizon);

  return CATEGORIES.map((category) => {
    const questions = questionsForCategory(category.key).filter((q) => q.type !== 'horizon');
    let numerator = 0;
    let denominator = 0;

    questions.forEach((q) => {
      if (q.id === 27) {
        const importance = Math.max(0, (state.answers[27] || 3) - 1);
        const alignment = 1 - 2 * financialAlignment;
        numerator += importance * alignment;
        denominator += importance;
        return;
      }
      if (RISK_DIRECT_QUESTION_IDS.includes(q.id)) {
        const importance = Math.max(0, (state.answers[q.id] || 3) - 1);
        numerator += importance * entry.alignments[q.id];
        denominator += importance;
        return;
      }
      if (!questionHasData(q.id, company, ctx)) return;
      const importance = Math.pow(state.answers[q.id] || 3, 2);
      numerator += importance * entry.alignments[q.id];
      denominator += importance;
    });

    const raw = denominator > 0 ? 50 + 50 * (numerator / denominator) : 50;
    const score = Math.round(Math.min(10, Math.max(1, raw / 10)));
    return { key: category.key, label: category.label, score };
  });
}

// 1-3 red, 4-6 yellow, 7-10 green -- purely a display bucket for the score
// list below; doesn't touch computeCategoryScores' own math at all.
function categoryScoreBucket(score) {
  if (score <= 3) return 'low';
  if (score <= 6) return 'mid';
  return 'high';
}

// Shared by the single-company category list (renderCategorySection below)
// and each side of Compare Two Companies' side-by-side columns
// (renderCompareColumn) -- one markup source for the category-row list so
// the two views can't silently drift apart.
function renderCategoryListItems(categoryScores) {
  return categoryScores
    .map((c) => {
      const bucket = categoryScoreBucket(c.score);
      return `
        <li class="ticker-category-row">
          <span class="ticker-category-label">${escapeHtml(c.label)}</span>
          <span class="ticker-category-track"><span class="ticker-category-fill ticker-category-fill-${bucket}" style="width:${(c.score / 10) * 100}%"></span></span>
          <span class="ticker-category-score ticker-category-score-${bucket}">${c.score}/10</span>
        </li>
      `;
    })
    .join('');
}

function renderCategorySection(company, categoryScores) {
  return `
    <div class="ticker-categories">
      <h3>Category Match Scores</h3>
      <p class="muted">How ${escapeHtml(company.ticker)} scores (1-10) in each category, weighted by how important you rated each question within it.</p>
      <div class="ticker-category-layout">
        <div class="ticker-radar-wrap">
          <canvas id="ticker-radar-chart" role="img" aria-label="Radar chart of category match scores"></canvas>
          <p id="ticker-radar-unavailable" class="muted ticker-radar-unavailable" hidden>Chart unavailable — see the scores below.</p>
        </div>
        <ul class="ticker-category-list">
          ${renderCategoryListItems(categoryScores)}
        </ul>
      </div>
    </div>
  `;
}

function destroyTickerRadarChart() {
  if (tickerRadarChartInstance) {
    tickerRadarChartInstance.destroy();
    tickerRadarChartInstance = null;
  }
}

// Runs after renderTickerTester() has already written the canvas into the
// DOM (Chart.js needs a real <canvas> element to bind to). No-ops
// (destroying any prior chart) whenever personalization isn't available or
// the company is blue-chip-excluded, since renderTickerResult doesn't emit
// a canvas in either of those cases. Degrades to the numeric list alone,
// with no crash and no blank gap, if Chart.js itself never loaded (e.g.
// CDN blocked) -- same graceful-degradation convention as every other
// optional external SDK on this site (see firebase-config.js).
function renderTickerRadarChartIfPresent(company) {
  const canvas = document.getElementById('ticker-radar-chart');
  if (!canvas) {
    destroyTickerRadarChart();
    return;
  }

  if (typeof Chart === 'undefined') {
    canvas.hidden = true;
    const unavailable = document.getElementById('ticker-radar-unavailable');
    if (unavailable) unavailable.hidden = false;
    return;
  }

  const scored = buildCompanyScoreEntry(company);
  if (!scored.entry) return; // blue-chip-excluded or otherwise no entry -- no chart to draw
  const categoryScores = computeCategoryScores(company, scored.entry, scored.ctx);

  destroyTickerRadarChart();
  tickerRadarChartInstance = new Chart(canvas, {
    type: 'radar',
    data: {
      labels: categoryScores.map((c) => c.label),
      datasets: [
        {
          label: `${company.ticker} match`,
          data: categoryScores.map((c) => c.score),
          backgroundColor: 'rgba(201, 150, 47, 0.25)', // --gold, translucent fill
          borderColor: '#0f1f3d', // --navy
          borderWidth: 2,
          pointBackgroundColor: '#c9962f', // --gold
          pointBorderColor: '#0f1f3d',
        },
      ],
    },
    options: {
      responsive: true,
      scales: {
        r: {
          min: 1,
          max: 10,
          ticks: { stepSize: 1, showLabelBackdrop: false, color: '#6b675c' },
          pointLabels: { color: '#1c2530', font: { size: 12 } },
          grid: { color: '#e1ddd3' },
          angleLines: { color: '#e1ddd3' },
        },
      },
      plugins: { legend: { display: false } },
    },
  });
}

function renderRawCompanyData(company) {
  const fm = company.financial_metrics;
  const sinFlags = [
    ['tobacco_involvement', 'Tobacco'],
    ['alcohol_involvement', 'Alcohol'],
    ['gambling_casino_involvement', 'Gambling/casino'],
    ['weapons_defense_involvement', 'Weapons/defense'],
    ['adult_entertainment_involvement', 'Adult entertainment'],
    ['interest_based_financial_products', 'Interest-based financial products'],
  ]
    .filter(([key]) => company[key] && company[key].value === true)
    .map(([, label]) => label);

  return `
    <div class="ticker-raw-data">
      <h3>${escapeHtml(company.name)} (${escapeHtml(company.ticker)})</h3>
      <ul class="ticker-raw-data-list">
        <li><span>Sector</span><span>${escapeHtml(company.sector)}</span></li>
        <li><span>Headquarters</span><span>${escapeHtml(company.hq_country || 'Unknown')}</span></li>
        <li><span>Market cap tier</span><span>${escapeHtml(company.market_profile.market_cap_tier)}</span></li>
        <li><span>P/E ratio</span><span>${fm.pe_ratio === null || fm.pe_ratio === undefined ? 'Not meaningful' : fm.pe_ratio}</span></li>
        <li><span>Revenue growth (YoY)</span><span>${fm.revenue_growth_yoy_pct}%</span></li>
        <li><span>Profit margin</span><span>${fm.profit_margin_pct}%</span></li>
        <li><span>Analyst consensus</span><span>${escapeHtml(fm.analyst_consensus)}</span></li>
        <li><span>Dividend yield tier</span><span>${escapeHtml((company.dividend_policy && company.dividend_policy.yield_tier) || 'None')}</span></li>
        <li><span>Sin-stock flags</span><span>${sinFlags.length > 0 ? escapeHtml(sinFlags.join(', ')) : 'None on record'}</span></li>
      </ul>
    </div>
  `;
}

// --- Compare Two Companies (state.view = 'tickerCompare') ----------------
//
// Reuses buildCompanyScoreEntry/computeCategoryScores/tickerTierDisplay/
// renderRawCompanyData/hasPersonalizationSource exactly as the single-
// company view above does -- every number shown here is the same number
// that view would show for either company individually, just placed side
// by side. See the top-of-file header comment (2026-08-25) for how this
// mode is reached (always login-gated) and renderCompareVerdict below for
// the one piece of genuinely new logic this mode needed.

function renderTickerCompare() {
  if (!state.dataset) {
    appEl.innerHTML = `
      <section class="card ticker-compare-card">
        <p class="eyebrow">Ticker Tester</p>
        <h1>Compare Two Companies</h1>
        <p class="muted">Loading company data…</p>
        <div class="nav-row">
          <button type="button" id="ticker-compare-back-btn" class="btn btn-secondary">Back to Ticker Tester</button>
        </div>
      </section>
    `;
    wireTickerCompareBackButton();
    return;
  }

  maybeAutoLoadRecentPortfolio();

  const companyA = tickerCompareState.tickerA
    ? state.dataset.companies.find((c) => c.ticker === tickerCompareState.tickerA)
    : null;
  const companyB = tickerCompareState.tickerB
    ? state.dataset.companies.find((c) => c.ticker === tickerCompareState.tickerB)
    : null;

  appEl.innerHTML = `
    <section class="card ticker-compare-card">
      <p class="eyebrow">Ticker Tester</p>
      <h1>Compare Two Companies</h1>
      <p class="lede">Select two companies from our sample dataset to compare side by side against your values priorities.</p>

      <div class="ticker-compare-pickers">
        ${renderCompareSearchSlot('A', companyA)}
        ${renderCompareSearchSlot('B', companyB)}
      </div>

      ${tickerCompareState.duplicateAttempted ? '<p class="error-text">Choose two different companies to compare.</p>' : ''}

      ${companyA && companyB ? renderCompareResults(companyA, companyB) : ''}

      <div class="nav-row">
        <button type="button" id="ticker-compare-back-btn" class="btn btn-secondary">Back to Ticker Tester</button>
      </div>
    </section>
  `;

  wireTickerCompareBackButton();
  wireCompareSearchSlot('A');
  wireCompareSearchSlot('B');
  if (companyA && companyB) {
    wireCompareResultActions();
    renderCompareRadarChartIfPresent(companyA, companyB);
  } else {
    destroyTickerCompareRadarChart();
  }
}

function wireTickerCompareBackButton() {
  document.getElementById('ticker-compare-back-btn').addEventListener('click', () => {
    state.view = 'tickerTester';
    render();
  });
}

// One searchable dropdown "slot" (A or B) -- same filterCompanies() dataset
// restriction and dropdown behavior as the single-company search above,
// parameterized so both slots share one implementation. A company already
// picked in the OTHER slot is left selectable in the dropdown (simpler
// than disabling it, and the click handler below catches the duplicate
// attempt and shows a message either way -- see wireCompareSearchSlot).
function renderCompareSearchSlot(slot, selectedCompany) {
  const query = slot === 'A' ? tickerCompareState.queryA : tickerCompareState.queryB;
  const results = filterCompanies(query);
  const showDropdown = query.trim().length > 0;

  if (selectedCompany) {
    return `
      <div class="ticker-compare-slot">
        <span class="ticker-compare-slot-label">Company ${slot}</span>
        <div class="ticker-compare-selected">
          <span class="ticker-compare-selected-name">${escapeHtml(selectedCompany.name)} (${escapeHtml(selectedCompany.ticker)})</span>
          <button type="button" class="btn-link-inline ticker-compare-change-btn" data-slot="${slot}">Change</button>
        </div>
      </div>
    `;
  }

  return `
    <div class="ticker-compare-slot">
      <label for="ticker-compare-search-${slot}">Company ${slot}</label>
      <input
        type="text"
        id="ticker-compare-search-${slot}"
        class="ticker-compare-search-input"
        data-slot="${slot}"
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
                <button type="button" class="ticker-compare-search-result" data-slot="${slot}" data-ticker="${escapeHtml(c.ticker)}">
                  <span class="ticker-search-result-ticker">${escapeHtml(c.ticker)}</span>
                  <span class="ticker-search-result-name">${escapeHtml(c.name)}</span>
                  <span class="ticker-search-result-sector">${escapeHtml(c.sector)}</span>
                </button>
              </li>
            `
                  )
                  .join('')
              : '<li class="ticker-search-empty">No matching companies found.</li>'
          }
        </ul>
      `
          : ''
      }
    </div>
  `;
}

function wireCompareSearchSlot(slot) {
  const input = document.getElementById(`ticker-compare-search-${slot}`);
  if (input) {
    input.addEventListener('input', () => {
      if (slot === 'A') tickerCompareState.queryA = input.value;
      else tickerCompareState.queryB = input.value;
      tickerCompareState.duplicateAttempted = false;
      renderInPlace();
      const refocused = document.getElementById(`ticker-compare-search-${slot}`);
      if (refocused) {
        refocused.focus();
        refocused.setSelectionRange(refocused.value.length, refocused.value.length);
      }
    });
  }

  document.querySelectorAll(`.ticker-compare-search-result[data-slot="${slot}"]`).forEach((btn) => {
    btn.addEventListener('click', () => {
      const ticker = btn.dataset.ticker;
      const otherTicker = slot === 'A' ? tickerCompareState.tickerB : tickerCompareState.tickerA;
      if (ticker === otherTicker) {
        tickerCompareState.duplicateAttempted = true;
        renderInPlace();
        return;
      }
      if (slot === 'A') {
        tickerCompareState.tickerA = ticker;
        tickerCompareState.queryA = '';
      } else {
        tickerCompareState.tickerB = ticker;
        tickerCompareState.queryB = '';
      }
      tickerCompareState.duplicateAttempted = false;
      renderInPlace();
    });
  });

  const changeBtn = document.querySelector(`.ticker-compare-change-btn[data-slot="${slot}"]`);
  if (changeBtn) {
    changeBtn.addEventListener('click', () => {
      if (slot === 'A') {
        tickerCompareState.tickerA = null;
        tickerCompareState.queryA = '';
      } else {
        tickerCompareState.tickerB = null;
        tickerCompareState.queryB = '';
      }
      tickerCompareState.duplicateAttempted = false;
      renderInPlace();
    });
  }
}

function renderCompareResults(companyA, companyB) {
  if (!hasPersonalizationSource()) {
    if (tickerTesterState.autoLoadState === 'loading') {
      return `
        <div class="ticker-compare-results">
          <p class="muted">Loading your most recent saved portfolio…</p>
          <div class="ticker-compare-columns">
            <div class="ticker-compare-column">${renderRawCompanyData(companyA)}</div>
            <div class="ticker-compare-column">${renderRawCompanyData(companyB)}</div>
          </div>
        </div>
      `;
    }
    // Same fallback principle as the single-company view: no verdict, no
    // chart, no category scores without real personalization data -- just
    // both companies' raw sourced data, plus a prompt to unlock scoring.
    // "Log In" isn't offered here (unlike the single-company prompt) since
    // reaching Compare at all already requires being logged in.
    return `
      <div class="ticker-compare-results">
        <div class="ticker-personalize-prompt">
          <p>Complete the survey or load a saved portfolio to see how these two companies match your personal values.</p>
          <p class="ticker-personalize-actions">
            <button type="button" id="ticker-compare-take-survey-btn" class="btn btn-secondary">Take the Survey</button>
          </p>
        </div>
        <div class="ticker-compare-columns">
          <div class="ticker-compare-column">${renderRawCompanyData(companyA)}</div>
          <div class="ticker-compare-column">${renderRawCompanyData(companyB)}</div>
        </div>
      </div>
    `;
  }

  const scoredA = buildCompanyScoreEntry(companyA);
  const scoredB = buildCompanyScoreEntry(companyB);
  const bothScored = !scoredA.blueChipExcluded && !scoredB.blueChipExcluded;

  return `
    <div class="ticker-compare-results">
      <div class="ticker-compare-columns">
        ${renderCompareColumn(companyA, scoredA)}
        ${renderCompareColumn(companyB, scoredB)}
      </div>

      ${
        bothScored
          ? `
        <div class="ticker-categories ticker-compare-chart-section">
          <h3>Category Match Scores</h3>
          <div class="ticker-radar-wrap ticker-compare-radar-wrap">
            <canvas id="ticker-compare-radar-chart" role="img" aria-label="Radar chart comparing both companies' category match scores"></canvas>
            <p id="ticker-compare-radar-unavailable" class="muted ticker-radar-unavailable" hidden>Chart unavailable — see the scores above.</p>
          </div>
        </div>
      `
          : ''
      }

      ${renderCompareVerdict(companyA, companyB, scoredA, scoredB)}
    </div>
  `;
}

function wireCompareResultActions() {
  const takeSurveyBtn = document.getElementById('ticker-compare-take-survey-btn');
  if (takeSurveyBtn) {
    takeSurveyBtn.addEventListener('click', () => {
      state.view = 'survey';
      render();
    });
  }
}

// One company's half of the side-by-side comparison -- same three states
// as the single-company view's own result (blue-chip-excluded / scored),
// same tier badge, rationale, note, caution flags, and category list, just
// without the search/change-company row (that's handled once by the
// shared pickers above, not per column).
function renderCompareColumn(company, scored) {
  if (scored.blueChipExcluded) {
    return `
      <div class="ticker-compare-column">
        <h2>${escapeHtml(company.name)} (${escapeHtml(company.ticker)})</h2>
        <div class="ticker-personalize-prompt">
          <p>
            You rated "large, established blue-chip companies" a 5/5 -- your hardest requirement. ${escapeHtml(company.name)}
            (${escapeHtml(company.market_profile.market_cap_tier)} cap) doesn't meet that bar, so it would never
            appear in your recommended portfolio regardless of how well it otherwise matches your values.
          </p>
        </div>
        ${renderRawCompanyData(company)}
      </div>
    `;
  }

  const { entry, ctx } = scored;
  const display = tickerTierDisplay(entry.tier);
  const categoryScores = computeCategoryScores(company, entry, ctx);
  const showNote = entry.note && entry.tier !== 'Below Values Threshold';

  return `
    <div class="ticker-compare-column">
      <h2>${escapeHtml(company.name)} (${escapeHtml(company.ticker)})</h2>
      <p><span class="tier-badge tier-${display.cssKey}">${display.badgeText}</span></p>
      <p class="ticker-result-rationale">${escapeHtml(entry.rationale)}</p>
      ${showNote ? `<p class="ticker-result-note muted">${escapeHtml(entry.note)}</p>` : ''}
      ${
        entry.cautionFlags && entry.cautionFlags.length > 0
          ? `<p class="caution-note">⚠ Financial caution: ${entry.cautionFlags.map(escapeHtml).join('; ')}</p>`
          : ''
      }
      <ul class="ticker-category-list ticker-compare-category-list">
        ${renderCategoryListItems(categoryScores)}
      </ul>
    </div>
  `;
}

function destroyTickerCompareRadarChart() {
  if (tickerCompareRadarChartInstance) {
    tickerCompareRadarChartInstance.destroy();
    tickerCompareRadarChartInstance = null;
  }
}

// Same pattern as renderTickerRadarChartIfPresent (single-company view):
// runs after the DOM already has the canvas, degrades to "chart
// unavailable" if Chart.js never loaded, no-ops (destroying any prior
// chart) if either company is blue-chip-excluded since renderCompareResults
// doesn't emit a canvas in that case. The only real difference is two
// overlaid datasets (gold for Company A, navy for Company B -- this site's
// only two brand colors, same pairing the single chart already uses) with
// a visible legend, since here the two shapes need to be told apart.
function renderCompareRadarChartIfPresent(companyA, companyB) {
  const canvas = document.getElementById('ticker-compare-radar-chart');
  if (!canvas) {
    destroyTickerCompareRadarChart();
    return;
  }

  if (typeof Chart === 'undefined') {
    canvas.hidden = true;
    const unavailable = document.getElementById('ticker-compare-radar-unavailable');
    if (unavailable) unavailable.hidden = false;
    return;
  }

  const scoredA = buildCompanyScoreEntry(companyA);
  const scoredB = buildCompanyScoreEntry(companyB);
  if (!scoredA.entry || !scoredB.entry) return;

  const categoryScoresA = computeCategoryScores(companyA, scoredA.entry, scoredA.ctx);
  const categoryScoresB = computeCategoryScores(companyB, scoredB.entry, scoredB.ctx);

  destroyTickerCompareRadarChart();
  tickerCompareRadarChartInstance = new Chart(canvas, {
    type: 'radar',
    data: {
      labels: categoryScoresA.map((c) => c.label),
      datasets: [
        {
          label: `${companyA.ticker} match`,
          data: categoryScoresA.map((c) => c.score),
          backgroundColor: 'rgba(201, 150, 47, 0.25)', // --gold, translucent fill
          borderColor: '#c9962f', // --gold
          borderWidth: 2,
          pointBackgroundColor: '#c9962f',
          pointBorderColor: '#0f1f3d',
        },
        {
          label: `${companyB.ticker} match`,
          data: categoryScoresB.map((c) => c.score),
          backgroundColor: 'rgba(15, 31, 61, 0.18)', // --navy, translucent fill
          borderColor: '#0f1f3d', // --navy
          borderWidth: 2,
          pointBackgroundColor: '#0f1f3d',
          pointBorderColor: '#c9962f',
        },
      ],
    },
    options: {
      responsive: true,
      scales: {
        r: {
          min: 1,
          max: 10,
          ticks: { stepSize: 1, showLabelBackdrop: false, color: '#6b675c' },
          pointLabels: { color: '#1c2530', font: { size: 12 } },
          grid: { color: '#e1ddd3' },
          angleLines: { color: '#e1ddd3' },
        },
      },
      // Unlike the single-company chart (legend hidden -- only one shape,
      // nothing to distinguish), this one needs a legend since there are
      // two overlaid shapes to tell apart.
      plugins: { legend: { display: true, position: 'bottom', labels: { color: '#1c2530' } } },
    },
  });
}

// How many points apart two companies' valuesFitScore (0-100) needs to be
// before treating it as a real difference rather than noise -- both scores
// are already rounded integers built from many small weighted terms, so a
// gap of a couple points can come from rounding/discretization alone
// rather than a genuine values difference. Documented judgment call, not
// a value pulled from existing code (no prior feature ever had to decide
// "how different is different enough" between two specific companies).
const VALUES_TIE_THRESHOLD = 3;

// How many of the client's own 1-5 importance ratings a category's
// questions average to -- used only to decide which categories are worth
// naming in the verdict's plain-language reason (topDifferentiatingCategories
// below), not part of any score itself.
function categoryImportance(category) {
  const questions = questionsForCategory(category.key).filter((q) => q.type !== 'horizon');
  if (questions.length === 0) return 3;
  const sum = questions.reduce((total, q) => total + (state.answers[q.id] || 3), 0);
  return sum / questions.length;
}

// Picks up to maxCount categories where the winner leads the loser,
// ranked by (score gap) * (how heavily the client weighted that category)
// -- so the verdict names categories that are both a real gap AND
// something the client said mattered, rather than just the single
// numerically largest gap regardless of whether it was a category the
// client was indifferent to.
function topDifferentiatingCategories(winnerScores, loserScores, maxCount) {
  const diffs = winnerScores.map((c, i) => ({
    label: c.label,
    diff: c.score - loserScores[i].score,
    importance: categoryImportance(CATEGORIES.find((cat) => cat.key === c.key)),
  }));
  return diffs
    .filter((d) => d.diff > 0)
    .sort((a, b) => b.diff * b.importance - a.diff * a.importance)
    .slice(0, maxCount)
    .map((d) => d.label);
}

// Low/Medium/High -> a sortable rank, for compareRiskTiebreak below.
const PERFORMANCE_TIER_RANK = { Low: 0, Medium: 1, High: 2 };

// The verdict's tiebreaker, used only when the two companies' values-fit
// scores are within VALUES_TIE_THRESHOLD of each other. Growth risk
// profiles favor the company with the higher growth_potential tier,
// Conservative favors the higher stability tier, Balanced applies no
// adjustment at all -- the same three-way Conservative/Balanced/Growth
// split deriveRiskProfile() already produces and financialQualityAlignment
// (scoring.js) already branches on elsewhere in this codebase, just
// applied here as a direct head-to-head comparison between two specific
// companies' own dataset performance_tier fields (growth_potential/
// stability, Low/Medium/High) rather than folded into one company's
// absolute blended score. This exact head-to-head comparison is new code
// -- sortScoredEntries (scoring.js) only ever ranks one company against
// the whole field, it never had a reason to compare two named companies
// against each other, so there was no existing function to call into for
// this specific step. Returns the winning company, or null if the risk
// profile is Balanced (no adjustment, per spec) or both companies land on
// the same tier (a genuine tie even after the tiebreaker).
function compareRiskTiebreak(companyA, companyB, riskProfile) {
  if (riskProfile === 'Balanced') return null;
  const field = riskProfile === 'Conservative' ? 'stability' : 'growth_potential';
  const rankA = PERFORMANCE_TIER_RANK[companyA.performance_tier[field]];
  const rankB = PERFORMANCE_TIER_RANK[companyB.performance_tier[field]];
  if (rankA === undefined || rankB === undefined || rankA === rankB) return null;
  return rankA > rankB ? companyA : companyB;
}

// The verdict shown below the side-by-side comparison. Primary factor is
// valuesFitScore() (scoring.js) -- the same values-only formula
// meetsValuesFloor() already uses to decide Low Match, deliberately not
// entry.score (which has financial quality and risk preferences already
// blended in -- using that here would let financial data quietly
// override a values difference before the tiebreaker step ever ran,
// exactly what this verdict must not do). Financial data only enters via
// compareRiskTiebreak, and only once the values-fit scores are within
// VALUES_TIE_THRESHOLD of each other.
function renderCompareVerdict(companyA, companyB, scoredA, scoredB) {
  if (scoredA.blueChipExcluded && scoredB.blueChipExcluded) {
    return `
      <div class="ticker-compare-verdict">
        <p>
          Neither company meets your hard requirement for large, established blue-chip companies (rated 5/5) --
          neither would ever appear in your recommended portfolio, so there's no meaningful values-fit comparison
          to make here.
        </p>
      </div>
    `;
  }
  if (scoredA.blueChipExcluded || scoredB.blueChipExcluded) {
    const excluded = scoredA.blueChipExcluded ? companyA : companyB;
    const winner = scoredA.blueChipExcluded ? companyB : companyA;
    return `
      <div class="ticker-compare-verdict">
        <p>
          <strong>${escapeHtml(winner.name)} (${escapeHtml(winner.ticker)})</strong> is the better fit by default --
          ${escapeHtml(excluded.name)} doesn't meet your hard requirement for large, established blue-chip
          companies (rated 5/5), so it would never appear in your recommended portfolio regardless of how well it
          otherwise matches your values.
        </p>
      </div>
    `;
  }

  const ctx = scoredA.ctx;
  const scoreA = valuesFitScore(companyA, state.answers, ctx);
  const scoreB = valuesFitScore(companyB, state.answers, ctx);
  const diff = scoreA - scoreB;

  if (Math.abs(diff) > VALUES_TIE_THRESHOLD) {
    const winner = diff > 0 ? companyA : companyB;
    const winnerScored = diff > 0 ? scoredA : scoredB;
    const loserScored = diff > 0 ? scoredB : scoredA;
    const winnerCategoryScores = computeCategoryScores(winner, winnerScored.entry, winnerScored.ctx);
    const loserCategoryScores = computeCategoryScores(diff > 0 ? companyB : companyA, loserScored.entry, loserScored.ctx);
    const topCategories = topDifferentiatingCategories(winnerCategoryScores, loserCategoryScores, 2);
    const reason =
      topCategories.length > 0
        ? `it scores notably higher on ${topCategories.join(' and ')}, ${topCategories.length > 1 ? 'the categories' : 'a category'} you weighted most heavily`
        : 'it scores higher across your priorities overall';
    return `
      <div class="ticker-compare-verdict">
        <p><strong>${escapeHtml(winner.name)} (${escapeHtml(winner.ticker)})</strong> is the better fit for your values -- ${reason}.</p>
      </div>
    `;
  }

  const riskProfile = deriveRiskProfile(state.answers);
  const tiebreakWinner = compareRiskTiebreak(companyA, companyB, riskProfile);
  if (tiebreakWinner) {
    const factorLabel = riskProfile === 'Conservative' ? 'stability' : 'growth potential';
    return `
      <div class="ticker-compare-verdict">
        <p>
          Both companies fit your values almost equally; <strong>${escapeHtml(tiebreakWinner.name)} (${escapeHtml(tiebreakWinner.ticker)})</strong>
          edges ahead due to stronger ${factorLabel}, which matches your ${escapeHtml(riskProfile)} risk profile.
        </p>
      </div>
    `;
  }

  return `
    <div class="ticker-compare-verdict">
      <p>Both companies fit your values and financial profile about equally based on what you've told us -- this one's a genuine toss-up.</p>
    </div>
  `;
}
