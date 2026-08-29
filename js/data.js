/**
 * Data access layer. This is the only file that knows where company data
 * comes from. It loads two independently-updatable files and merges them
 * by ticker into the single company shape the rest of the app expects:
 *
 *   - FINANCIAL_SOURCE_URL: market/fundamentals data (P/E, PEG, margins,
 *     ROE, beta, market cap, dividend yield, analyst rating, 6mo/1yr
 *     returns, leverage, performance tier). Sourced from SEC EDGAR XBRL +
 *     Finnhub.
 *   - ESG_SOURCE_URL: values/governance data (esg_ratings, founder_led,
 *     family_owned, sin_stock_flags, animal_testing_exposure,
 *     revenue_geography, additional_data_sources). Sourced from EPA/OSHA/
 *     NLRB, SEC EDGAR filings, and Wikipedia.
 *
 * To ship a new ESG dataset without touching or losing the financial data
 * currently live on the site: replace data/esg_dataset_sp500.json with a
 * new file using the SAME ticker values and the SAME field names (see
 * scripts/split_financial_esg_datasets.py for the exact field list), leave
 * data/financial_dataset_sp500.json alone, and redeploy. The reverse also
 * works (swap the financial file, keep the ESG file). Swapping in a live
 * feed for either one later means changing its URL/fetch here only — the
 * survey and scoring logic never touch the data source directly.
 */

// Cache-busts the two dataset fetches the same way index.html/404.html
// cache-bust every local <script>/<link> tag (see the comment above those
// tags) -- bump this whenever either JSON file's *content* changes, in
// lockstep with the next ?v= bump, so a browser/GitHub Pages cache can't
// keep serving a stale dataset after a content-only change like this one
// (unlike the script tags, fetch() URLs aren't touched by the HTML's own
// ?v= query string, so this needed its own).
const DATASET_CACHE_BUST = '20260829d';
const FINANCIAL_SOURCE_URL = `data/financial_dataset_sp500.json?v=${DATASET_CACHE_BUST}`;
const ESG_SOURCE_URL = `data/esg_dataset_sp500.json?v=${DATASET_CACHE_BUST}`;

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load ${url} (HTTP ${response.status})`);
  }
  const json = await response.json();
  if (!json || !Array.isArray(json.companies)) {
    throw new Error(`Dataset at ${url} is malformed: expected a "companies" array.`);
  }
  return json;
}

async function loadDataset() {
  const [financial, esg] = await Promise.all([
    fetchJson(FINANCIAL_SOURCE_URL),
    fetchJson(ESG_SOURCE_URL),
  ]);

  const esgByTicker = new Map(esg.companies.map((c) => [c.ticker, c]));
  const financialTickers = new Set(financial.companies.map((c) => c.ticker));

  const companies = [];
  const skipped = [];
  for (const finCompany of financial.companies) {
    const esgCompany = esgByTicker.get(finCompany.ticker);
    if (!esgCompany) {
      skipped.push(finCompany.ticker);
      continue;
    }
    companies.push({ ...finCompany, ...esgCompany });
  }
  for (const ticker of esgByTicker.keys()) {
    if (!financialTickers.has(ticker)) skipped.push(ticker);
  }

  if (skipped.length > 0) {
    // Not fatal -- a ticker present in only one of the two files is
    // dropped from the merged set rather than scored with half-missing
    // data, but this is surfaced loudly rather than silently.
    console.warn(
      `loadDataset: ${skipped.length} ticker(s) present in only one of the financial/ESG datasets and excluded from the merged set:`,
      skipped,
    );
  }
  if (companies.length === 0) {
    throw new Error('Financial and ESG datasets share no common tickers -- nothing to score.');
  }

  return {
    meta: { financial: financial.meta, esg: esg.meta },
    companies,
  };
}
