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

describe('Sectors match official GICS sectors', () => {
  const companies = loadCompanies();
  const GICS = new Set(['Communication Services', 'Consumer Discretionary', 'Consumer Staples', 'Energy', 'Financials',
    'Health Care', 'Industrials', 'Information Technology', 'Materials', 'Real Estate', 'Utilities']);
  test('every company has one of the 11 GICS sectors', () => {
    const bad = companies.filter((c) => !GICS.has(c.sector)).map((c) => `${c.ticker}:${c.sector}`);
    assert.equal(bad.length, 0, bad.join(', '));
  });
  test('spot checks against known GICS sectors', () => {
    const want = { KLAC: 'Information Technology', AMT: 'Real Estate', EQR: 'Real Estate', ABNB: 'Consumer Discretionary', ACN: 'Information Technology', BALL: 'Materials' };
    for (const [t, s] of Object.entries(want)) assert.equal(companies.find((c) => c.ticker === t).sector, s, t);
  });
});

describe('Industry screens and headquarters (2026-11-17)', () => {
  const companies = loadCompanies();
  const by = (t) => companies.find((c) => c.ticker === t);
  const flag = (t, key) => by(t)[key] && by(t)[key].value;
  test('casino operators are flagged for gambling', () => {
    for (const t of ['LVS', 'MGM', 'WYNN']) assert.equal(flag(t, 'gambling_casino_involvement'), true, t);
  });
  test('major defense contractors are flagged for weapons', () => {
    for (const t of ['LMT', 'NOC', 'GD', 'RTX', 'LHX', 'HII', 'BA']) assert.equal(flag(t, 'weapons_defense_involvement'), true, t);
  });
  test('investment banks and brokers count as interest-based finance; insurers and payment networks do not', () => {
    for (const t of ['GS', 'MS', 'SCHW', 'JPM']) assert.equal(flag(t, 'interest_based_financial_products'), true, t);
    for (const t of ['MET', 'V', 'MA']) assert.equal(flag(t, 'interest_based_financial_products'), false, t);
  });
  test('alcohol counts producers only', () => {
    for (const t of ['TAP', 'STZ', 'BF-B']) assert.equal(flag(t, 'alcohol_involvement'), true, t);
    for (const t of ['PEP', 'KDP']) assert.equal(flag(t, 'alcohol_involvement'), false, t);
  });
  test('headquarters country is where the company is run from', () => {
    const want = { MDT: 'United States', JNJ: 'United States', ACN: 'Ireland', CB: 'Switzerland', STX: 'Singapore', AAPL: 'United States' };
    for (const [t, country] of Object.entries(want)) assert.equal(by(t).hq_country, country, t);
  });
});
