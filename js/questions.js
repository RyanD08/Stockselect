/**
 * Survey question definitions (v2 — 24 questions).
 * Kept separate from scoring.js and app.js so the questionnaire itself
 * can be edited independently of how answers are scored or rendered.
 *
 * Every question maps to a real field in the v2 dataset (see scoring.js).
 * `type` distinguishes how a client's importance rating should be applied:
 *   - 'exclusionary': a 5 means "strongly penalize companies with this trait"
 *   - 'preference':   a 5 means "strongly reward companies with this trait"
 *   - 'risk':         not scored per-company; combined into a derived Risk
 *                      Profile instead (see scoring.js deriveRiskProfile).
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
  { id: 7, category: 'social_labor', type: 'preference', text: 'Companies with strong worker safety records', short: 'Strong worker safety records' },

  // Governance
  { id: 8, category: 'governance', type: 'exclusionary', text: 'Avoiding companies with histories of fraud, corruption, or major scandals', short: 'Avoiding fraud/corruption/scandals' },
  { id: 9, category: 'governance', type: 'exclusionary', text: 'Avoiding companies with concentrated or dual-class voting structures that limit shareholder rights and board independence', short: 'Avoiding concentrated/dual-class voting control' },
  { id: 10, category: 'governance', type: 'exclusionary', text: 'Avoiding companies with high financial leverage/debt levels', short: 'Avoiding high financial leverage' },

  // Ethical / "Sin Stock" Screens
  { id: 11, category: 'ethical', type: 'exclusionary', text: 'Avoiding tobacco companies', short: 'Avoiding tobacco' },
  { id: 12, category: 'ethical', type: 'exclusionary', text: 'Avoiding alcohol producers', short: 'Avoiding alcohol producers' },
  { id: 13, category: 'ethical', type: 'exclusionary', text: 'Avoiding gambling/casino companies', short: 'Avoiding gambling/casinos' },
  { id: 14, category: 'ethical', type: 'exclusionary', text: 'Avoiding weapons/defense manufacturers', short: 'Avoiding weapons/defense' },
  { id: 15, category: 'ethical', type: 'exclusionary', text: 'Avoiding adult entertainment industries', short: 'Avoiding adult entertainment' },
  { id: 16, category: 'ethical', type: 'exclusionary', text: 'Avoiding companies involved in animal testing', short: 'Avoiding animal testing' },

  // Community/Identity
  { id: 17, category: 'community', type: 'preference', text: 'Supporting locally-headquartered or domestic companies', short: 'Locally-headquartered/domestic', needsHomeCountry: true },
  { id: 18, category: 'community', type: 'preference', text: 'Supporting founder-led or family-owned businesses', short: 'Founder-led/family-owned' },
  { id: 19, category: 'community', type: 'preference', text: 'Supporting companies in industries I have personal/professional ties to', short: 'Personal/professional industry ties', needsTiesSector: true },
  { id: 20, category: 'community', type: 'preference', text: 'Preferring companies with primarily domestic revenue over globally diversified revenue', short: 'Preferring primarily domestic revenue' },

  // Risk Philosophy (combined into a derived Risk Profile, not scored per-company)
  { id: 21, category: 'risk', type: 'risk', text: 'Long-term stability over short-term growth potential', short: 'Stability over growth' },
  { id: 22, category: 'risk', type: 'risk', text: 'Willingness to accept lower returns for values alignment', short: 'Accept lower returns for values' },
  { id: 23, category: 'risk', type: 'risk', text: 'Preference for large, established "blue-chip" companies over smaller, emerging companies', short: 'Blue-chip over emerging companies' },
  { id: 24, category: 'risk', type: 'risk', text: 'Preference for dividend-paying income stocks over growth-focused reinvestment', short: 'Dividend income over growth reinvestment' },
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
  community:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11l8-7 8 7"/><path d="M6 10v9h12v-9"/><path d="M10 19v-5h4v5"/></svg>',
  risk: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17l5-6 4 3 7-9"/><path d="M13 5h7v7"/></svg>',
};

const CATEGORIES = [
  { key: 'environmental', label: 'Environmental', icon: CATEGORY_ICONS.environmental },
  { key: 'social_labor', label: 'Social / Labor', icon: CATEGORY_ICONS.social_labor },
  { key: 'governance', label: 'Governance', icon: CATEGORY_ICONS.governance },
  { key: 'ethical', label: 'Ethical / "Sin Stock" Screens', icon: CATEGORY_ICONS.ethical },
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
