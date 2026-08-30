/**
 * Loads the site's own plain <script>-tag JS files into a Node vm context,
 * exactly as the browser would load them via index.html -- no build step,
 * no transpiling, no mocking. This is the same pattern used ad hoc
 * throughout the 2026-08-29/30 scoring investigation (see the chat history
 * for that session); formalized here so it survives between sessions
 * instead of living only in throwaway scratchpad scripts.
 *
 * Deliberately loads from the REAL repo files (js/*.js, data/*.json), not
 * a copy or a snapshot -- a test run against stale copies would give false
 * confidence exactly when it matters most (right after a real change).
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');

// Files that make up the "logic" surface this test suite exercises --
// questions.js/scoring.js define the scoring engine; app.js contributes
// fillPortfolioHoldings' one real caller (renderResults) and is included
// so a future test can assert against that shared function too, not just
// scoring.js's own internal use of it.
const CORE_SCRIPTS = ['js/questions.js', 'js/scoring.js'];

function loadContext(extraScripts = []) {
  const ctx = { console };
  vm.createContext(ctx);
  for (const rel of [...CORE_SCRIPTS, ...extraScripts]) {
    const code = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    vm.runInContext(code, ctx, { filename: rel });
  }
  return ctx;
}

// Merges the two live datasets exactly the way js/data.js's loadDataset()
// does at runtime (same ticker-intersection logic) -- kept in sync with
// that function by hand since vm-loading data.js itself would require
// mocking fetch().
function loadCompanies() {
  const financial = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'data/financial_dataset_sp500.json'), 'utf8'));
  const esg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'data/esg_dataset_sp500.json'), 'utf8'));
  const esgByTicker = new Map(esg.companies.map((c) => [c.ticker, c]));
  return financial.companies
    .filter((c) => esgByTicker.has(c.ticker))
    .map((c) => ({ ...c, ...esgByTicker.get(c.ticker) }));
}

function defaultAnswers(overrides = {}) {
  const answers = {};
  for (let i = 1; i <= 29; i++) answers[i] = 3;
  Object.assign(answers, overrides);
  return answers;
}

const DEFAULT_CLIENT_CONTEXT = { homeCountry: 'United States', tiesSector: null, timeHorizon: 'long' };

module.exports = { loadContext, loadCompanies, defaultAnswers, DEFAULT_CLIENT_CONTEXT, REPO_ROOT };
