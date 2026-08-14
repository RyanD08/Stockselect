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

const CATEGORIES = [
  { key: 'environmental', label: 'Environmental' },
  { key: 'social_labor', label: 'Social / Labor' },
  { key: 'governance', label: 'Governance' },
  { key: 'ethical', label: 'Ethical / "Sin Stock" Screens' },
  { key: 'community', label: 'Community/Identity' },
  { key: 'risk', label: 'Risk Philosophy' },
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
  'Utilities',
];

function questionsForCategory(categoryKey) {
  return QUESTIONS.filter((q) => q.category === categoryKey);
}

function getQuestion(id) {
  return QUESTIONS.find((q) => q.id === id);
}
