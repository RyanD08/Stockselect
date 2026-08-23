/**
 * Ticker Tester: look up one company and see how it scores against the
 * client's own values priorities, with a full per-criterion breakdown.
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
 */

const tickerTesterState = {
  query: '',
  selectedTicker: null,
};

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
  if (company) wireTickerResultActions();
}

function wireTickerTesterBackButton() {
  document.getElementById('ticker-tester-back-btn').addEventListener('click', () => {
    state.view = 'intro';
    render();
  });
}

function renderTickerSearch() {
  const results = filterCompanies(tickerTesterState.query);
  const showDropdown = tickerTesterState.query.trim().length > 0 && !tickerTesterState.selectedTicker;

  return `
    <div class="ticker-search">
      <label for="ticker-search-input">Search by company name or ticker</label>
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
  const display = TIER_DISPLAY[entry.tier] || TIER_DISPLAY.Partial;

  return `
    <div class="ticker-result">
      ${changeCompanyRow}
      <div class="ticker-result-summary">
        <h2>${escapeHtml(company.name)} (${escapeHtml(company.ticker)})</h2>
        <p><span class="tier-badge tier-${display.cssKey}">${display.badgeText}</span></p>
        <p class="ticker-result-rationale">${escapeHtml(entry.rationale)}</p>
        ${entry.note ? `<p class="ticker-result-note muted">${escapeHtml(entry.note)}</p>` : ''}
        ${
          entry.cautionFlags && entry.cautionFlags.length > 0
            ? `<p class="caution-note">⚠ Financial caution: ${entry.cautionFlags.map(escapeHtml).join('; ')}</p>`
            : ''
        }
      </div>

      ${renderCriterionBreakdown(company, entry, ctx)}
    </div>
  `;
}

function alignmentBucket(value) {
  if (value > 0.05) return { key: 'positive', text: 'Aligns' };
  if (value < -0.05) return { key: 'negative', text: 'Conflicts' };
  return { key: 'neutral', text: 'Neutral' };
}

function renderCriterionBreakdown(company, entry, ctx) {
  const rows = SCORED_QUESTION_IDS.map((qid) => breakdownRow(qid, company, ctx, entry.alignments[qid]));

  RISK_DIRECT_QUESTION_IDS.forEach((qid) => {
    rows.push(breakdownRow(qid, company, ctx, entry.alignments[qid]));
  });

  // Q27 (values-over-returns) plays a dual role in scoring and isn't
  // stored in `alignments` by scoreCompany (see header comment) -- derived
  // here the exact same way scoreCompany itself derives it, from the same
  // financialQualityAlignment() call, not a new formula.
  const financialAlignment = financialQualityAlignment(company, deriveRiskProfile(state.answers), ctx.timeHorizon);
  rows.push(breakdownRow(27, company, ctx, 1 - 2 * financialAlignment, true));

  rows.sort((a, b) => a.id - b.id);

  return `
    <div class="ticker-breakdown">
      <h3>Full Criterion Breakdown</h3>
      <p class="muted">How ${escapeHtml(company.ticker)} scores on each of your rated priorities.</p>
      <ul class="ticker-breakdown-list">
        ${rows.map(renderBreakdownRowHtml).join('')}
      </ul>
    </div>
  `;
}

function breakdownRow(qid, company, ctx, alignmentValue, alwaysHasData) {
  const question = getQuestion(qid);
  const hasData = alwaysHasData || questionHasData(qid, company, ctx);
  const rating = state.answers[qid];
  const bucket = hasData ? alignmentBucket(alignmentValue) : { key: 'neutral', text: 'No data' };
  return { id: qid, label: question.short, rating, hasData, bucket };
}

function renderBreakdownRowHtml(row) {
  return `
    <li class="ticker-breakdown-row">
      <span class="ticker-breakdown-label">${escapeHtml(row.label)}</span>
      <span class="ticker-breakdown-rating">Your rating: ${row.rating}/5</span>
      <span class="ticker-breakdown-badge ticker-breakdown-${row.bucket.key}">${escapeHtml(row.bucket.text)}</span>
      ${!row.hasData ? '<span class="ticker-breakdown-nodata">No verifiable data for this company</span>' : ''}
    </li>
  `;
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
