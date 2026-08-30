const { describe, test, assert } = require('./lib/runner');
const { loadCompanies } = require('./lib/harness');

describe('Dataset integrity', () => {
  const companies = loadCompanies();

  test('merges to the expected S&P 500 company count', () => {
    // Not a magic number -- see js/data.js's own loadDataset() comment:
    // a ticker present in only one of the two files is dropped, so this
    // is "however many the two datasets currently agree on," which should
    // stay close to 502 (the full index) barring a real data problem.
    assert(companies.length >= 490, `Expected close to 502 companies, got ${companies.length}`);
    assert(companies.length <= 505, `Expected close to 502 companies, got ${companies.length}`);
  });

  test('every company has the fields scoring.js unconditionally reads', () => {
    const missing = [];
    for (const c of companies) {
      if (!c.ticker) missing.push('ticker');
      if (!c.sector) missing.push(`${c.ticker}: sector`);
      if (!c.market_profile) missing.push(`${c.ticker}: market_profile`);
      if (!c.financial_metrics) missing.push(`${c.ticker}: financial_metrics`);
      // overall_financial_score_label itself is legitimately null for a
      // handful of companies with no verifiable financial data (e.g. very
      // recent index additions) -- that's honest missing-data, not
      // corruption, so it's NOT asserted non-null here. js/app.js's
      // financialScoreLabel() is what's responsible for turning that null
      // into a real display string; see the "financial score label never
      // renders the literal word null" test below for that guard instead.
    }
    assert.equal(missing.length, 0, `Companies missing required fields: ${missing.slice(0, 10).join(', ')}`);
  });

  test('no duplicate tickers after merge', () => {
    const seen = new Set();
    const dupes = [];
    for (const c of companies) {
      if (seen.has(c.ticker)) dupes.push(c.ticker);
      seen.add(c.ticker);
    }
    assert.equal(dupes.length, 0, `Duplicate tickers: ${dupes.join(', ')}`);
  });
});
