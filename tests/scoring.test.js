const fs = require('fs');
const path = require('path');
const { describe, test, assert } = require('./lib/runner');
const { loadContext, loadCompanies, defaultAnswers, DEFAULT_CLIENT_CONTEXT, REPO_ROOT } = require('./lib/harness');

const companies = loadCompanies();

function freshCtx() {
  const ctx = loadContext();
  ctx.dataset = { companies };
  return ctx;
}

describe('buildPortfolio() sanity, across a spread of client profiles', () => {
  const profiles = {
    'fully neutral (every default 3)': defaultAnswers(),
    'all minimums (every rating 1)': defaultAnswers(Object.fromEntries(Array.from({ length: 29 }, (_, i) => [i + 1, 1]))),
    'all maximums (every rating 5)': defaultAnswers(Object.fromEntries(Array.from({ length: 29 }, (_, i) => [i + 1, 5]))),
    'blue-chip hard filter (Q28=5)': defaultAnswers({ 28: 5 }),
    'clean-energy prioritized (Q2=5)': defaultAnswers({ 1: 5, 2: 5 }),
  };

  for (const [label, answers] of Object.entries(profiles)) {
    test(`"${label}" produces a valid portfolio`, () => {
      const ctx = freshCtx();
      const result = ctx.buildPortfolio({ companies }, answers, DEFAULT_CLIENT_CONTEXT);
      assert(Array.isArray(result.holdings), 'holdings should be an array');
      assert(result.holdings.length <= 15, `portfolio exceeds MAX_PORTFOLIO_SIZE: ${result.holdings.length}`);

      const tickers = result.holdings.map((h) => h.company.ticker);
      assert.equal(new Set(tickers).size, tickers.length, 'duplicate ticker in one portfolio');

      const sectorCounts = {};
      for (const h of result.holdings) sectorCounts[h.company.sector] = (sectorCounts[h.company.sector] || 0) + 1;
      for (const [sector, count] of Object.entries(sectorCounts)) {
        assert(count <= 5, `sector cap violated: ${sector} has ${count} holdings`);
      }

      for (const h of result.holdings) {
        assert(h.score >= 0 && h.score <= 100, `score out of [0,100] range: ${h.company.ticker} = ${h.score}`);
      }
    });
  }

  test('scoring is deterministic -- same profile twice gives identical output', () => {
    const answers = defaultAnswers({ 1: 5, 2: 5, 27: 4 });
    const a = freshCtx().buildPortfolio({ companies }, answers, DEFAULT_CLIENT_CONTEXT);
    const b = freshCtx().buildPortfolio({ companies }, answers, DEFAULT_CLIENT_CONTEXT);
    const aTickers = a.holdings.map((h) => `${h.company.ticker}:${h.score}`).join(',');
    const bTickers = b.holdings.map((h) => `${h.company.ticker}:${h.score}`).join(',');
    assert.equal(aTickers, bTickers, 'identical inputs produced different portfolios');
  });
});

describe('Clean-energy reserved slot (2026-08-29 feature)', () => {
  test('rating Q2 at 5 reserves a slot for the curated pick', () => {
    const ctx = freshCtx();
    const answers = defaultAnswers({ 1: 5, 2: 5 });
    const result = ctx.buildPortfolio({ companies }, answers, DEFAULT_CLIENT_CONTEXT);
    const tickers = result.holdings.map((h) => h.company.ticker);
    assert(tickers.includes('FSLR'), `expected FSLR reserved in holdings, got: ${tickers.join(', ')}`);
  });

  test('rating Q2 at its default (3) does not force the reservation', () => {
    const ctx = freshCtx();
    const result = ctx.buildPortfolio({ companies }, defaultAnswers(), DEFAULT_CLIENT_CONTEXT);
    assert.equal(ctx.themedReservedSlotCount(defaultAnswers()), 0, 'default rating should reserve 0 slots');
  });
});

describe('Financial score label never renders the literal word "null" (regression guard)', () => {
  // Real bug, found by this test suite: overall_financial_score_label is
  // legitimately null for a handful of companies with no verifiable
  // financial data (confirmed in tests/data-integrity.test.js). Nothing
  // guarded against that null reaching escapeHtml()/csvField(), both of
  // which stringify with String(value) -- so any of those companies
  // appearing in a real portfolio would have shown the literal text "null"
  // in the results badge and the CSV export. Fixed with the shared
  // financialScoreLabel() helper (js/app.js); this guards against a future
  // change reintroducing a raw, unguarded read of the nullable field.
  test('app.js never reads overall_financial_score_label outside financialScoreLabel()', () => {
    const appJs = fs.readFileSync(path.join(REPO_ROOT, 'js/app.js'), 'utf8');
    // Matches actual property access (a leading dot), not comment prose
    // that happens to mention the field name.
    const rawReads = appJs.split('\n').filter((line) => line.includes('.overall_financial_score_label'));
    // Exactly one line should exist: the one inside financialScoreLabel()
    // itself, applying the `|| 'Unrated'` fallback.
    assert.equal(rawReads.length, 1, `Expected exactly 1 raw reference (inside financialScoreLabel()), found ${rawReads.length}:\n${rawReads.join('\n')}`);
    assert(rawReads[0].includes("|| 'Unrated'"), `The one raw read must apply the null fallback, got: ${rawReads[0]}`);
  });
});

describe('renderResults() actually uses the shared fill logic (regression guard)', () => {
  // This specific test exists because of a real incident: buildPortfolio()
  // was fixed to reserve clean-energy slots, but js/app.js's renderResults()
  // had its OWN hand-rolled copy of the fill loop that never got the fix --
  // silently inert on the live site until caught by a browser check. Fixed
  // by extracting fillPortfolioHoldings() as the one shared implementation
  // (see scoring.js). This test guards against that exact class of bug
  // recurring: renderResults must call the shared function by name, not
  // reimplement it.
  test('app.js renderResults() calls fillPortfolioHoldings, not a private copy', () => {
    const appJs = fs.readFileSync(path.join(REPO_ROOT, 'js/app.js'), 'utf8');
    const renderResultsMatch = appJs.match(/function renderResults\(\)\s*\{([\s\S]*?)\n\}\n/);
    assert(renderResultsMatch, 'could not locate renderResults() in js/app.js -- update this test if it moved/was renamed');
    const body = renderResultsMatch[1];
    assert(
      body.includes('fillPortfolioHoldings('),
      'renderResults() no longer calls fillPortfolioHoldings() -- if the fill logic was reimplemented inline again, it will silently diverge from buildPortfolio() the same way it did before'
    );
  });
});
