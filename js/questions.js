/**
 * Survey question definitions.
 * Kept separate from scoring.js and app.js so the questionnaire itself
 * can be edited independently of how answers are scored or rendered.
 */

const QUESTIONS = [
  // Environmental
  { id: 1, category: 'environmental', text: 'Avoiding companies with high carbon emissions or fossil fuel involvement', short: 'Avoiding carbon/fossil fuel exposure' },
  { id: 2, category: 'environmental', text: 'Prioritizing renewable energy or clean tech companies', short: 'Prioritizing renewable/clean tech' },
  { id: 3, category: 'environmental', text: 'Avoiding companies with poor environmental/pollution records', short: 'Avoiding poor environmental records' },
  { id: 4, category: 'environmental', text: 'Supporting sustainable agriculture or resource use', short: 'Supporting sustainable resource use' },

  // Social / Labor
  { id: 5, category: 'social_labor', text: 'Fair wages and labor practices across the supply chain', short: 'Fair wages & labor practices' },
  { id: 6, category: 'social_labor', text: 'Avoiding companies with histories of labor disputes or exploitation', short: 'Avoiding labor disputes/exploitation' },
  { id: 7, category: 'social_labor', text: 'Workplace diversity, equity, and inclusion practices', short: 'Workplace DEI practices' },
  { id: 8, category: 'social_labor', text: 'Companies with strong worker safety records', short: 'Strong worker safety records' },

  // Governance
  { id: 9, category: 'governance', text: 'Transparent and independent corporate boards', short: 'Transparent, independent boards' },
  { id: 10, category: 'governance', text: 'Reasonable executive compensation relative to average employee pay', short: 'Reasonable executive compensation' },
  { id: 11, category: 'governance', text: 'Avoiding companies with histories of fraud, corruption, or major scandals', short: 'Avoiding fraud/corruption/scandals' },
  { id: 12, category: 'governance', text: 'Shareholder rights and voting power', short: 'Shareholder rights & voting power' },

  // Ethical / "Sin Stock" Screens
  { id: 13, category: 'ethical', text: 'Avoiding tobacco companies', short: 'Avoiding tobacco' },
  { id: 14, category: 'ethical', text: 'Avoiding alcohol producers', short: 'Avoiding alcohol producers' },
  { id: 15, category: 'ethical', text: 'Avoiding gambling/casino companies', short: 'Avoiding gambling/casinos' },
  { id: 16, category: 'ethical', text: 'Avoiding weapons/defense manufacturers', short: 'Avoiding weapons/defense' },
  { id: 17, category: 'ethical', text: 'Avoiding adult entertainment industries', short: 'Avoiding adult entertainment' },
  { id: 18, category: 'ethical', text: 'Avoiding companies involved in animal testing', short: 'Avoiding animal testing' },

  // Religious/Values-Based
  { id: 19, category: 'religious', text: 'Compliance with religious investment principles (e.g., halal, kosher, faith-based screens)', short: 'Religious investment compliance' },
  { id: 20, category: 'religious', text: 'Avoiding interest-based financial products', short: 'Avoiding interest-based products' },

  // Political/Social Stances
  { id: 21, category: 'political', text: 'Company political donation transparency', short: 'Political donation transparency' },
  { id: 22, category: 'political', text: 'Avoiding companies operating in specific countries or regions of concern', short: 'Avoiding regions of concern' },
  { id: 23, category: 'political', text: 'Companies with strong data privacy practices', short: 'Strong data privacy practices' },

  // Community/Identity
  { id: 24, category: 'community', text: 'Supporting locally-headquartered or domestic companies', short: 'Locally-headquartered/domestic' },
  { id: 25, category: 'community', text: 'Supporting founder-led or family-owned businesses', short: 'Founder-led/family-owned' },
  { id: 26, category: 'community', text: 'Supporting companies in industries I have personal/professional ties to', short: 'Personal/professional industry ties' },

  // Risk Philosophy (combined into a derived Risk Profile, not scored per-company)
  { id: 27, category: 'risk', text: 'Long-term stability over short-term growth potential', short: 'Stability over growth' },
  { id: 28, category: 'risk', text: 'Willingness to accept lower returns for values alignment', short: 'Accept lower returns for values' },
];

const CATEGORIES = [
  { key: 'environmental', label: 'Environmental' },
  { key: 'social_labor', label: 'Social / Labor' },
  { key: 'governance', label: 'Governance' },
  { key: 'ethical', label: 'Ethical / "Sin Stock" Screens' },
  { key: 'religious', label: 'Religious/Values-Based' },
  { key: 'political', label: 'Political/Social Stances' },
  { key: 'community', label: 'Community/Identity' },
  { key: 'risk', label: 'Risk Philosophy' },
];

function questionsForCategory(categoryKey) {
  return QUESTIONS.filter((q) => q.category === categoryKey);
}

function getQuestion(id) {
  return QUESTIONS.find((q) => q.id === id);
}
