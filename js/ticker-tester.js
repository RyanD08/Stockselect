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
 */

const tickerTesterState = {
  query: '',
  selectedTicker: null,
};

// Chart.js requires destroying a previous chart bound to a <canvas> before
// creating a new one there, or it throws "Canvas is already in use" --
// tracked here so selecting a different company (which re-renders the same
// canvas id) replaces the chart cleanly instead of erroring.
let tickerRadarChartInstance = null;

function initTickerTesterNav() {
  const btn = document.getElementById('ticker-tester-nav-btn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    tickerTesterState.query = '';
    tickerTesterState.selectedTicker = null;
    state.view = 'tickerTester';
    render();
  });
}

function hasPersonalizationSource() {
  return !!state.hasPersonalizedAnswers;
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

  const company = tickerTesterState.selectedTicker
    ? state.dataset.companies.find((c) => c.ticker === tickerTesterState.selectedTicker)
    : null;

  appEl.innerHTML = `
    <section class="card ticker-tester-card">
      <p class="eyebrow">Ticker Tester</p>
      <h1>Ticker Tester</h1>
      <p class="lede">Look up a single company from our sample dataset and see how it stacks up against your own values priorities.</p>

      ${renderTickerSearch()}

      ${company ? renderTickerResult(company) : ''}

      <div class="nav-row">
        <button type="button" id="ticker-tester-back-btn" class="btn btn-secondary">Back</button>
      </div>
    </section>
  `;

  wireTickerTesterBackButton();
  wireTickerSearch();
  if (company) {
    wireTickerResultActions();
    renderTickerRadarChartIfPresent(company);
  } else {
    destroyTickerRadarChart();
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

// One 1-10 score per category, weighted-average of that category's own
// per-question alignment values (already computed by scoreCompany/
// buildScoredEntry above -- see entry.alignments) by the client's raw 1-5
// importance rating on each question. A question with no verifiable data
// for this company (questionHasData -- values questions 1-25 only, same
// as scoreCompany's own unitImportance gating) is excluded from the
// average entirely rather than counted as a false "neutral," so it can't
// silently drag a category toward the middle. Risk questions (26/28/29)
// have no such data-gate in the main engine either, so none is applied
// here. Alignment values span roughly [-1, +1]; rescaled onto [1, 10]
// with 5.5 (not 1) as the neutral midpoint, matching the main engine's own
// "50 is neutral" convention on its 0-100 scale.
function computeCategoryScores(company, entry, ctx) {
  const financialAlignment = financialQualityAlignment(company, deriveRiskProfile(state.answers), ctx.timeHorizon);

  return CATEGORIES.map((category) => {
    const questions = questionsForCategory(category.key).filter((q) => q.type !== 'horizon');
    let weightedSum = 0;
    let weightTotal = 0;

    questions.forEach((q) => {
      if (q.id <= 25 && !questionHasData(q.id, company, ctx)) return;
      const importance = state.answers[q.id] || 3;
      const alignment = q.id === 27 ? 1 - 2 * financialAlignment : entry.alignments[q.id];
      weightedSum += importance * alignment;
      weightTotal += importance;
    });

    const avgAlignment = weightTotal > 0 ? weightedSum / weightTotal : 0;
    const score = Math.round(Math.min(10, Math.max(1, 5.5 + 4.5 * avgAlignment)));
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
          ${categoryScores
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
            .join('')}
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
