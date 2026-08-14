/**
 * Values-fit scoring engine (v2).
 *
 * Every scored question (ids 1-20; ids 21-24 are Risk Philosophy and are
 * combined into a derived Risk Profile instead — see deriveRiskProfile) is
 * either:
 *
 *   - EXCLUSIONARY: the client is rating how much they want to *avoid* a
 *     trait. A company's alignment value a_i sits in [-1, 0] — 0 if the
 *     company lacks the trait (neutral, no penalty), down to -1 if it has
 *     the trait strongly. It never rewards a company for scoring well.
 *
 *   - PREFERENCE: the client is rating how much they want to *seek out* a
 *     trait. a_i sits in [0, +1] — 0 if the company lacks the trait
 *     (neutral, no bonus), up to +1 if it has the trait strongly. It never
 *     penalizes a company for lacking the trait.
 *
 * contribution_i = clientImportance_i (1-5) * a_i
 * score = 50 + 50 * (Σcontribution_i / ΣclientImportance_i), clipped to [0,100]
 *
 * 50 is the neutral starting point; the score moves up or down only as far
 * as the client's own stated priorities and the company's real attributes
 * justify.
 */

const SCORED_QUESTION_IDS = Array.from({ length: 20 }, (_, i) => i + 1); // 1-20
const HIGH_PRIORITY_THRESHOLD = 4; // client ratings of 4-5 count as "highest priority"
const CONFLICT_ALIGNMENT_THRESHOLD = -0.5; // a_i at or below this counts as a strong conflict
const MAX_PORTFOLIO_SIZE = 15;
const MAX_PER_SECTOR = 3;

function noteMatches(note, regex) {
  return !!note && regex.test(note);
}

// Maps a 1-5 ESG-style score onto the exclusionary axis: 1 -> -1, 3 -> 0, 5+ -> 0 (never rewards).
function exclusionaryGraded(score) {
  if (typeof score !== 'number') return 0;
  return Math.min(0, (score - 3) / 2);
}

// Maps a 1-5 ESG-style score onto the preference axis: 1 -> 0, 3 -> 0, 5 -> +1 (never penalizes).
function preferenceGraded(score) {
  if (typeof score !== 'number') return 0;
  return Math.max(0, (score - 3) / 2);
}

function animalTestingAlignment(exposureText) {
  if (!exposureText) return 0;
  const level = exposureText.split(' - ')[0].trim().toLowerCase();
  const table = { none: 0, low: -0.25, medium: -0.5, 'medium-high': -0.75, high: -1 };
  return table[level] !== undefined ? table[level] : 0;
}

function leverageAlignment(level) {
  const table = { Low: 0, Medium: -0.5, High: -1 };
  return table[level] !== undefined ? table[level] : 0;
}

// One alignment function per scored question id (1-20). `ctx` carries
// client-supplied context that isn't a 1-5 rating: home country and the
// sector the client has personal/professional ties to.
const ALIGNMENT_FNS = {
  // Environmental
  1: (c) => exclusionaryGraded(c.esg_ratings.environmental.score),
  2: (c) => {
    const isCleanTech = noteMatches(c.esg_ratings.environmental.note, /renewable|solar|wind|clean energy|clean tech|EV|hydrogen/i);
    return isCleanTech ? 1 : preferenceGraded(c.esg_ratings.environmental.score);
  },
  3: (c) => exclusionaryGraded(c.esg_ratings.environmental.score),
  4: (c) => {
    const isSustainableResource = noteMatches(c.esg_ratings.environmental.note, /sustainab|resource|recycl|water|agricultur/i);
    return isSustainableResource ? 1 : preferenceGraded(c.esg_ratings.environmental.score);
  },

  // Social / Labor
  5: (c) => {
    const strongWages = noteMatches(c.esg_ratings.social_labor.note, /above-market|strong reported labor|well-regarded/i);
    return strongWages ? 1 : preferenceGraded(c.esg_ratings.social_labor.score);
  },
  6: (c) => {
    const hasDispute = noteMatches(c.esg_ratings.social_labor.note, /dispute|union|strike|exploitation|controvers/i);
    return hasDispute ? -1 : exclusionaryGraded(c.esg_ratings.social_labor.score);
  },
  7: (c) => {
    const hasSafetyIssue = noteMatches(c.esg_ratings.social_labor.note, /safety/i);
    return hasSafetyIssue ? 0 : preferenceGraded(c.esg_ratings.social_labor.score);
  },

  // Governance
  8: (c) => {
    const hasScandal = noteMatches(c.esg_ratings.governance.note, /litigation|scandal|fraud|corruption|settlement|controvers|investigation/i);
    return hasScandal ? -1 : exclusionaryGraded(c.esg_ratings.governance.score);
  },
  9: (c) => {
    const concentratedVoting = noteMatches(c.esg_ratings.governance.note, /dual-class|voting power|majority control|majority voting|significant influence/i);
    return concentratedVoting ? -1 : exclusionaryGraded(c.esg_ratings.governance.score);
  },
  10: (c) => leverageAlignment(c.financial_leverage.level),

  // Ethical / "Sin Stock" Screens
  11: (c) => (c.sin_stock_flags.tobacco ? -1 : 0),
  12: (c) => (c.sin_stock_flags.alcohol ? -1 : 0),
  13: (c) => (c.sin_stock_flags.gambling ? -1 : 0),
  14: (c) => (c.sin_stock_flags.weapons_defense ? -1 : 0),
  15: (c) => (c.sin_stock_flags.adult_entertainment ? -1 : 0),
  16: (c) => animalTestingAlignment(c.animal_testing_exposure),

  // Community/Identity
  17: (c, ctx) => (c.hq_country && c.hq_country.startsWith(ctx.homeCountry) ? 1 : 0),
  18: (c) => (c.founder_led || c.family_owned ? 1 : 0),
  19: (c, ctx) => (ctx.tiesSector && c.sector === ctx.tiesSector ? 1 : 0),
  20: (c) => (c.revenue_geography.profile === 'Primarily Domestic' ? 1 : 0),
};

function scoreCompany(company, answers, ctx) {
  let numerator = 0;
  let denominator = 0;
  const alignments = {};

  SCORED_QUESTION_IDS.forEach((qId) => {
    const importance = answers[qId] || 3;
    const alignment = ALIGNMENT_FNS[qId](company, ctx);
    alignments[qId] = alignment;
    numerator += importance * alignment;
    denominator += importance;
  });

  const raw = denominator > 0 ? 50 + 50 * (numerator / denominator) : 50;
  const score = Math.round(Math.min(100, Math.max(0, raw)));
  return { score, alignments };
}

// Q21-24 all share the same underlying axis once inverted: a raw answer of
// 5 ("very important to me") on any of these four questions expresses a
// stability/blue-chip/dividend/values-over-growth preference. Inverting
// (6 - answer) puts all four on a common "growth-orientation" axis where
// higher = more growth-oriented, so they can be averaged and bucketed with
// a single set of thresholds.
function deriveRiskProfile(answers) {
  const growthAxisValues = [21, 22, 23, 24].map((qId) => 6 - (answers[qId] || 3));
  const avg = growthAxisValues.reduce((sum, v) => sum + v, 0) / growthAxisValues.length;
  if (avg <= 2.3) return 'Conservative';
  if (avg <= 3.7) return 'Balanced';
  return 'Growth';
}

function classifyTier(alignments, answers) {
  const conflicts = [];
  SCORED_QUESTION_IDS.forEach((qId) => {
    const importance = answers[qId] || 3;
    if (importance >= HIGH_PRIORITY_THRESHOLD && alignments[qId] <= CONFLICT_ALIGNMENT_THRESHOLD) {
      conflicts.push(qId);
    }
  });
  return { tier: conflicts.length > 0 ? 'Partial' : 'Strong', conflicts };
}

function buildPartialMatchNote(conflicts) {
  const labels = conflicts.map((qId) => lowerFirst(getQuestion(qId).short));
  if (labels.length === 1) return `Does not fully meet your preference for ${labels[0]}.`;
  const last = labels[labels.length - 1];
  const rest = labels.slice(0, -1);
  return `Does not fully meet your preferences for ${rest.join(', ')} and ${last}.`;
}

function lowerFirst(str) {
  return str.charAt(0).toLowerCase() + str.slice(1);
}

function buildRationale(alignments, answers) {
  const highPriorityIds = SCORED_QUESTION_IDS.filter((qId) => (answers[qId] || 3) >= HIGH_PRIORITY_THRESHOLD);
  const candidateIds = highPriorityIds.length > 0 ? highPriorityIds : SCORED_QUESTION_IDS;

  const ranked = candidateIds
    .filter((qId) => alignments[qId] > 0)
    .sort((a, b) => alignments[b] - alignments[a])
    .slice(0, 2);

  if (ranked.length === 0) {
    return 'Reasonable overall values alignment across your stated priorities.';
  }
  const labels = ranked.map((qId) => getQuestion(qId).short);
  return `Strong fit on ${labels.join(' and ')}.`;
}

const MARKET_CAP_RANK = { Mega: 3, Large: 2, Mid: 1, Small: 0 };

function controversyCount(company) {
  const regex = /dispute|controvers|scandal|fraud|corruption|litigation|settlement|safety|dual-class|voting power|majority control|majority voting/i;
  return ['environmental', 'social_labor', 'governance']
    .map((key) => company.esg_ratings[key].note)
    .filter((note) => noteMatches(note, regex)).length;
}

function riskProfileMatchRank(company, riskProfile) {
  if (riskProfile === 'Balanced') return 0; // no preference at this stage for balanced clients
  return company.performance_tier.risk_profile_fit === riskProfile ? 0 : 1;
}

function quantitativeTieBreakKey(company, riskProfile) {
  const beta = company.market_profile.beta_est;
  const capRank = MARKET_CAP_RANK[company.market_profile.market_cap_tier] || 0;
  const fiveYearReturn = company.performance_tier.five_year_annualized_return_pct_est;

  if (riskProfile === 'Conservative') {
    // prefer lower beta, then larger cap, then higher return
    return [beta, -capRank, -fiveYearReturn];
  }
  if (riskProfile === 'Growth') {
    // prefer higher return, then higher beta, then smaller cap
    return [-fiveYearReturn, -beta, capRank];
  }
  // Balanced: prefer the better risk-adjusted profile (return / beta)
  const riskAdjusted = beta > 0 ? fiveYearReturn / beta : fiveYearReturn;
  return [-riskAdjusted];
}

function compareArrays(a, b) {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function buildPortfolio(dataset, answers, clientContext) {
  const ctx = {
    homeCountry: (clientContext && clientContext.homeCountry) || 'United States',
    tiesSector: (clientContext && clientContext.tiesSector) || null,
  };
  const riskProfile = deriveRiskProfile(answers);
  const tierRank = { Strong: 0, Partial: 1 };

  const scored = dataset.companies.map((company) => {
    const { score, alignments } = scoreCompany(company, answers, ctx);
    const { tier, conflicts } = classifyTier(alignments, answers);
    return {
      company,
      score,
      alignments,
      tier,
      conflicts,
      rationale: buildRationale(alignments, answers),
      note: tier === 'Partial' ? buildPartialMatchNote(conflicts) : null,
      riskMatchRank: riskProfileMatchRank(company, riskProfile),
      quantKey: quantitativeTieBreakKey(company, riskProfile),
      controversyCount: controversyCount(company),
    };
  });

  scored.sort((a, b) => {
    if (tierRank[a.tier] !== tierRank[b.tier]) return tierRank[a.tier] - tierRank[b.tier];
    if (b.score !== a.score) return b.score - a.score;
    if (a.riskMatchRank !== b.riskMatchRank) return a.riskMatchRank - b.riskMatchRank;
    const quantCompare = compareArrays(a.quantKey, b.quantKey);
    if (quantCompare !== 0) return quantCompare;
    if (a.controversyCount !== b.controversyCount) return a.controversyCount - b.controversyCount;
    return a.company.ticker.localeCompare(b.company.ticker);
  });

  const sectorCounts = {};
  const selected = [];
  for (const entry of scored) {
    if (selected.length >= MAX_PORTFOLIO_SIZE) break;
    const sector = entry.company.sector;
    const countInSector = sectorCounts[sector] || 0;
    if (countInSector >= MAX_PER_SECTOR) continue;
    sectorCounts[sector] = countInSector + 1;
    selected.push(entry);
  }

  const allocationPct = selected.length > 0 ? 100 / selected.length : 0;
  selected.forEach((entry) => {
    entry.allocationPct = allocationPct;
  });

  return { riskProfile, holdings: selected };
}
