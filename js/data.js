/**
 * Data access layer. This is the only file that knows where company data
 * comes from. Today it fetches the static sample JSON file; swapping in a
 * live market/ESG data feed later means changing loadDataset() here only —
 * the survey and scoring logic never touch the data source directly.
 */

const DATA_SOURCE_URL = 'data/values_portfolio_dataset_v5_100.json';

async function loadDataset() {
  const response = await fetch(DATA_SOURCE_URL);
  if (!response.ok) {
    throw new Error(`Failed to load dataset (HTTP ${response.status})`);
  }
  const json = await response.json();
  if (!json || !Array.isArray(json.companies)) {
    throw new Error('Dataset is malformed: expected a "companies" array.');
  }
  return json;
}
