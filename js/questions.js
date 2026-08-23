/**
 * Survey question definitions (v3.2 — 29 rated questions + 1 horizon
 * selector, 7 categories). Restructured 2026-08-21 to match the canonical
 * 27-question schema (+ women-led) defined by the data-mining repo,
 * RyanD08/stock-select-data-mine's schema/company_schema.json — see
 * data/import_schema_comparison.md for that pass's full before/after.
 *
 * Kept separate from scoring.js and app.js so the questionnaire itself
 * can be edited independently of how answers are scored or rendered.
 *
 * Every question maps to a real field in the esg_dataset_sp500.json or
 * financial_dataset_sp500.json schema (see scoring.js). `type`
 * distinguishes how a client's importance rating should be applied:
 *   - 'exclusionary': a 5 means "strongly penalize companies with this trait"
 *   - 'preference':   a 5 means "strongly reward companies with this trait"
 *   - 'risk':         not scored per-company; combined into a derived Risk
 *                      Profile instead (see scoring.js deriveRiskProfile).
 *   - 'horizon':       single-select, not rated 1-5; picks which return
 *                      field feeds the financial-quality criterion.
 *
 * Changes from v2 (24 questions, 6 categories):
 *   - Removed: "Avoiding companies involved in animal testing" (no
 *     verified per-company data source exists at S&P 500 scale).
 *   - Removed as a separate question (folded into domestic-HQ, Q22):
 *     "preferring primarily domestic revenue".
 *   - Added: Political/Social as a new category, plus women-led as a new
 *     Community/Identity question.
 *   - Risk Philosophy was temporarily reduced to 2 questions (stability,
 *     values-over-returns) when the data import first landed, since the
 *     imported schema's Risk Philosophy section only defines those two.
 *     Restored 2026-08-21 (post-import) at the client's explicit request:
 *     blue-chip preference and dividend-income preference are back, using
 *     the financial data already on every company (market_cap_tier,
 *     dividend yield_tier) which the ESG import never touched.
 *
 * 2026-08-23: removed the Religious Values category entirely. Its
 * "religious investment compliance" (halal/kosher/faith-based screening)
 * question had 0% real data coverage across the whole S&P 500 dataset --
 * no comprehensive public source exists for it at this scale, so it could
 * never contribute anything but a hardcoded-neutral score. Same reasoning,
 * same treatment, as the animal-testing removal above: removed outright
 * rather than left as a dead question. That category's other question,
 * "avoiding interest-based financial products" (which does have real
 * data), moved into Ethical / "Sin Stock" Screens rather than being
 * removed with it. Net: 30 questions -> 29 rated + the horizon selector,
 * renumbered gap-free start to finish. See
 * data/import_schema_comparison.md for the full before/after mapping.
 */

const QUESTIONS = [
  // Environmental
  { id: 1, category: 'environmental', type: 'exclusionary', text: 'Avoiding companies with high carbon emissions or fossil fuel involvement', short: 'Avoiding carbon/fossil fuel exposure' },
  { id: 2, category: 'environmental', type: 'preference', text: 'Prioritizing renewable energy or clean tech companies', short: 'Prioritizing renewable/clean tech' },
  { id: 3, category: 'environmental', type: 'exclusionary', text: 'Avoiding companies with poor environmental/pollution records', short: 'Avoiding poor environmental records' },
  { id: 4, category: 'environmental', type: 'preference', text: 'Supporting sustainable agriculture or resource use', short: 'Supporting sustainable resource use' },

  // Social / Labor
  { id: 5, category: 'social_labor', type: 'preference', text: 'Fair wages and labor practices across the supply chain', short: 'Fair wages & labor practices' },
  { id: 6, category: 'social_labor', type: 'exclusionary', text: 'Avoiding companies with histories of labor disputes or exploitation', short: 'Avoiding labor disputes/exploitation' },
  { id: 7, category: 'social_labor', type: 'preference', text: 'Workplace diversity, equity, and inclusion practices', short: 'Workplace diversity, equity & inclusion' },
  { id: 8, category: 'social_labor', type: 'preference', text: 'Companies with strong worker safety records', short: 'Strong worker safety records' },

  // Governance
  { id: 9, category: 'governance', type: 'preference', text: 'Transparent and independent corporate boards', short: 'Transparent, independent boards' },
  { id: 10, category: 'governance', type: 'exclusionary', text: 'Reasonable executive compensation relative to average employee pay', short: 'Avoiding excessive CEO pay ratios' },
  { id: 11, category: 'governance', type: 'exclusionary', text: 'Avoiding companies with histories of fraud, corruption, or major scandals', short: 'Avoiding fraud/corruption/scandals' },
  { id: 12, category: 'governance', type: 'exclusionary', text: 'Avoiding companies with concentrated or dual/multi-class voting structures that limit shareholder rights', short: 'Avoiding concentrated/dual-class voting control' },

  // Ethical / "Sin Stock" Screens (id 18, "avoiding interest-based
  // financial products", relocated here 2026-08-23 from the now-removed
  // Religious Values category -- same wording, same underlying field,
  // unchanged.)
  { id: 13, category: 'ethical', type: 'exclusionary', text: 'Avoiding tobacco companies', short: 'Avoiding tobacco' },
  { id: 14, category: 'ethical', type: 'exclusionary', text: 'Avoiding alcohol producers', short: 'Avoiding alcohol producers' },
  { id: 15, category: 'ethical', type: 'exclusionary', text: 'Avoiding gambling/casino companies', short: 'Avoiding gambling/casinos' },
  { id: 16, category: 'ethical', type: 'exclusionary', text: 'Avoiding weapons/defense manufacturers', short: 'Avoiding weapons/defense' },
  { id: 17, category: 'ethical', type: 'exclusionary', text: 'Avoiding adult entertainment industries', short: 'Avoiding adult entertainment' },
  { id: 18, category: 'ethical', type: 'exclusionary', text: 'Avoiding interest-based financial products', short: 'Avoiding interest-based financial products' },

  // Political/Social
  { id: 19, category: 'political', type: 'preference', text: 'Company political donation transparency', short: 'Political donation transparency' },
  { id: 20, category: 'political', type: 'exclusionary', text: 'Avoiding companies operating in specific countries or regions of concern', short: 'Avoiding operations in countries of concern' },
  { id: 21, category: 'political', type: 'preference', text: 'Companies with strong data privacy practices', short: 'Strong data privacy practices' },

  // Community/Identity
  { id: 22, category: 'community', type: 'preference', text: 'Supporting locally-headquartered or domestic companies', short: 'Locally-headquartered/domestic', needsHomeCountry: true },
  { id: 23, category: 'community', type: 'preference', text: 'Supporting founder-led or family-owned businesses', short: 'Founder-led/family-owned' },
  { id: 24, category: 'community', type: 'preference', text: 'Supporting companies in industries I have personal/professional ties to', short: 'Personal/professional industry ties', needsTiesSector: true },
  { id: 25, category: 'community', type: 'preference', text: 'Supporting women-led companies', short: 'Women-led companies' },

  // Risk Philosophy (combined into a derived Risk Profile, not scored per-company)
  { id: 26, category: 'risk', type: 'risk', text: 'Long-term stability over short-term growth potential', short: 'Stability over growth' },
  { id: 27, category: 'risk', type: 'risk', text: 'Willingness to accept lower returns for values alignment', short: 'Accept lower returns for values' },
  { id: 28, category: 'risk', type: 'risk', text: 'Preference for large, established "blue-chip" companies over smaller, emerging companies', short: 'Blue-chip over emerging companies' },
  { id: 29, category: 'risk', type: 'risk', text: 'Preference for dividend-paying income stocks over growth-focused reinvestment', short: 'Dividend income over growth reinvestment' },

  // Single-select, not a 1-5 rating — picks which return field feeds the
  // financial-quality criterion (see scoring.js financialQualityAlignment).
  {
    id: 30,
    category: 'risk',
    type: 'horizon',
    text: 'My typical investment time horizon is:',
    short: 'Investment time horizon',
    options: [
      { value: 'short', label: 'Short-term (next several months)' },
      { value: 'medium', label: 'Medium-term (about a year)' },
      { value: 'long', label: 'Long-term (5+ years)' },
    ],
    default: 'long',
  },
];

// Minimal single-color line icons (24x24, stroke=currentColor) — one per
// category, reused across the landing preview row, questionnaire headers,
// and category chips for visual continuity.
const CATEGORY_ICONS = {
  environmental:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20c8-1 13-6 15-15C10 6 5 11 4 20Z"/><path d="M4 20c3-3 6-6 9-9"/></svg>',
  social_labor:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3"/><circle cx="16.5" cy="9.5" r="2.3"/><path d="M3 20c0-4 3-6 6-6s6 2 6 6"/><path d="M14.5 20c0-3 1.4-4.8 3.8-5.3"/></svg>',
  governance:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v17"/><path d="M5 8h14"/><path d="M5 8l-3 6h6l-3-6Z"/><path d="M19 8l-3 6h6l-3-6Z"/><path d="M8 20h8"/></svg>',
  ethical:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 5-3 8-7 9-4-1-7-4-7-9V6l7-3Z"/><path d="M9 12l2 2 4-4"/></svg>',
  political:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4v16"/><path d="M4 4l14 4-14 4"/><path d="M4 20h10"/></svg>',
  community:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11l8-7 8 7"/><path d="M6 10v9h12v-9"/><path d="M10 19v-5h4v5"/></svg>',
  risk: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17l5-6 4 3 7-9"/><path d="M13 5h7v7"/></svg>',
};

const CATEGORIES = [
  { key: 'environmental', label: 'Environmental', icon: CATEGORY_ICONS.environmental },
  { key: 'social_labor', label: 'Social / Labor', icon: CATEGORY_ICONS.social_labor },
  { key: 'governance', label: 'Governance', icon: CATEGORY_ICONS.governance },
  { key: 'ethical', label: 'Ethical / "Sin Stock" Screens', icon: CATEGORY_ICONS.ethical },
  { key: 'political', label: 'Political/Social', icon: CATEGORY_ICONS.political },
  { key: 'community', label: 'Community/Identity', icon: CATEGORY_ICONS.community },
  { key: 'risk', label: 'Risk Philosophy', icon: CATEGORY_ICONS.risk },
];

const SECTOR_OPTIONS = [
  'Communication Services',
  'Consumer Discretionary',
  'Consumer Staples',
  'Energy',
  'Financials',
  'Health Care',
  'Industrials',
  'Information Technology',
  'Materials',
  'Real Estate',
  'Utilities',
];

function questionsForCategory(categoryKey) {
  return QUESTIONS.filter((q) => q.category === categoryKey);
}

function getQuestion(id) {
  return QUESTIONS.find((q) => q.id === id);
}
