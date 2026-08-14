/**
 * Values-fit scoring engine.
 *
 * For each of the 26 non-risk survey questions, a company gets an
 * "alignment" value from 0 (conflicts with this value) to 1 (fully aligns).
 * Alignment is derived from whatever field in the dataset is the closest
 * available proxy for that question — see ALIGNMENT_FNS below. Where the
 * dataset has no usable signal for a question at all, alignment defaults to
 * a neutral 0.5 so that question neither helps nor hurts a company's score.
 *
 * The client's 1-5 importance rating for each question is then used as a
 * weight: a company's overall score is the importance-weighted average of
 * its alignments, scaled to 0-100. No company is ever excluded outright.
 */

const HIGH_PRIORITY_THRESHOLD = 4; // client ratings of 4-5 count as "highest priority"
const CONFLICT_THRESHOLD = 0.5; // alignment below this counts as a conflict with a priority
const MAX_PORTFOLIO_SIZE = 15;
const MAX_PER_SECTOR = 3;

function esgAlign(score) {
  // ESG sub-scores in the dataset are 1-5, 5 = strongest positive alignment.
  if (typeof score !== 'number') return 0.5;
  return (score - 1) / 4;
}

function noteMatches(note, regex) {
  return !!note && regex.test(note);
}

function animalTestingAlign(exposureText) {
  if (!exposureText) return 0.5;
  const level = exposureText.split(' - ')[0].trim().toLowerCase();
  const table = {
    none: 1.0,
    low: 0.75,
    medium: 0.5,
    'medium-high': 0.35,
    high: 0.15,
  };
  return table[level] !== undefined ? table[level] : 0.5;
}

// One alignment function per question id (1-26). Each takes a company and
// returns a 0-1 alignment value.
const ALIGNMENT_FNS = {
  // Environmental
  1: (c) => esgAlign(c.esg_ratings.environmental.score),
  2: (c) => {
    const base = esgAlign(c.esg_ratings.environmental.score);
    const isCleanTech = noteMatches(c.esg_ratings.environmental.note, /renewable|solar|wind|clean energy|clean tech|EV|hydrogen/i);
    return isCleanTech ? Math.min(1, base + 0.2) : base;
  },
  3: (c) => esgAlign(c.esg_ratings.environmental.score),
  4: (c) => {
    const base = esgAlign(c.esg_ratings.environmental.score);
    const isSustainableResource = noteMatches(c.esg_ratings.environmental.note, /sustainab|resource|recycl|water|agricultur/i);
    return isSustainableResource ? Math.min(1, base + 0.2) : base;
  },

  // Social / Labor
  5: (c) => {
    const base = esgAlign(c.esg_ratings.social_labor.score);
    const strongWages = noteMatches(c.esg_ratings.social_labor.note, /above-market|strong reported labor|well-regarded/i);
    return strongWages ? Math.max(base, 0.85) : base;
  },
  6: (c) => {
    const base = esgAlign(c.esg_ratings.social_labor.score);
    const hasDispute = noteMatches(c.esg_ratings.social_labor.note, /dispute|union|strike|exploitation|controvers/i);
    return hasDispute ? Math.min(base, 0.3) : base;
  },
  7: (c) => esgAlign(c.esg_ratings.social_labor.score),
  8: (c) => {
    const base = esgAlign(c.esg_ratings.social_labor.score);
    const hasSafetyIssue = noteMatches(c.esg_ratings.social_labor.note, /safety/i);
    return hasSafetyIssue ? Math.min(base, 0.3) : base;
  },

  // Governance
  9: (c) => esgAlign(c.esg_ratings.governance.score),
  10: (c) => esgAlign(c.esg_ratings.governance.score),
  11: (c) => {
    const base = esgAlign(c.esg_ratings.governance.score);
    const hasScandal = noteMatches(c.esg_ratings.governance.note, /litigation|scandal|fraud|corruption|settlement|controvers|investigation/i);
    return hasScandal ? Math.min(base, 0.3) : base;
  },
  12: (c) => {
    const base = esgAlign(c.esg_ratings.governance.score);
    const concentratedVoting = noteMatches(c.esg_ratings.governance.note, /dual-class|voting power|majority control|majority voting|significant influence/i);
    return concentratedVoting ? Math.min(base, 0.25) : base;
  },

  // Ethical / "Sin Stock" Screens (near-zero, not absolute zero: no hard exclusions)
  13: (c) => (c.sin_stock_flags.tobacco ? 0.05 : 1.0),
  14: (c) => (c.sin_stock_flags.alcohol ? 0.05 : 1.0),
  15: (c) => (c.sin_stock_flags.gambling ? 0.05 : 1.0),
  16: (c) => (c.sin_stock_flags.weapons_defense ? 0.05 : 1.0),
  17: (c) => (c.sin_stock_flags.adult_entertainment ? 0.05 : 1.0),
  18: (c) => animalTestingAlign(c.animal_testing_exposure),

  // Religious/Values-Based (unverified per-company, so default to neutral)
  19: (c) => {
    const note = c.religious_compliance && c.religious_compliance.note;
    return noteMatches(note, /disqualify|fail/i) ? 0.15 : 0.5;
  },
  20: (c) => {
    const note = c.religious_compliance && c.religious_compliance.note;
    return noteMatches(note, /interest-based/i) ? 0.1 : 0.5;
  },

  // Political/Social Stances
  21: () => 0.5, // no per-company political-donation data in this dataset
  22: () => 0.5, // no per-company "regions of concern" operating data in this dataset
  23: (c) => (c.data_privacy_reputation ? esgAlign(c.data_privacy_reputation.score) : 0.5),

  // Community/Identity
  24: (c) => (c.hq_country && c.hq_country.startsWith('United States') ? 1.0 : 0.35),
  25: (c) => (c.founder_led || c.family_owned ? 1.0 : 0.25),
  26: () => 0.5, // no data on the client's personal/professional industry ties
};

function scoreCompany(company, answers) {
  let numerator = 0;
  let denominator = 0;
  const alignments = {};

  for (let qId = 1; qId <= 26; qId += 1) {
    const importance = answers[qId] || 3;
    const alignment = ALIGNMENT_FNS[qId](company);
    alignments[qId] = alignment;
    numerator += importance * alignment;
    denominator += importance;
  }

  const score = denominator > 0 ? Math.round((numerator / denominator) * 100) : 50;
  return { score, alignments };
}

function deriveRiskProfile(answers) {
  const avg = ((answers[27] || 3) + (answers[28] || 3)) / 2;
  if (avg >= 3.67) return 'Conservative';
  if (avg <= 2.33) return 'Growth';
  return 'Balanced';
}

function classifyTier(alignments, answers) {
  const conflicts = [];
  for (let qId = 1; qId <= 26; qId += 1) {
    const importance = answers[qId] || 3;
    if (importance >= HIGH_PRIORITY_THRESHOLD && alignments[qId] < CONFLICT_THRESHOLD) {
      conflicts.push(qId);
    }
  }
  return { tier: conflicts.length > 0 ? 'Partial' : 'Strong', conflicts };
}

function buildPartialMatchNote(conflicts) {
  const labels = conflicts.map((qId) => getQuestion(qId).short.replace(/^Avoiding /, 'avoiding ').replace(/^./, (c) => c));
  if (labels.length === 1) {
    return `Does not fully meet your preference for ${lowerFirst(labels[0])}.`;
  }
  const last = labels[labels.length - 1];
  const rest = labels.slice(0, -1);
  return `Does not fully meet your preferences for ${rest.map(lowerFirst).join(', ')} and ${lowerFirst(last)}.`;
}

function lowerFirst(str) {
  return str.charAt(0).toLowerCase() + str.slice(1);
}

function buildRationale(alignments, answers) {
  const highPriorityIds = Object.keys(alignments)
    .map(Number)
    .filter((qId) => (answers[qId] || 3) >= HIGH_PRIORITY_THRESHOLD);
  const candidateIds = highPriorityIds.length > 0 ? highPriorityIds : Object.keys(alignments).map(Number);

  const ranked = candidateIds
    .filter((qId) => alignments[qId] >= 0.6)
    .sort((a, b) => alignments[b] - alignments[a])
    .slice(0, 2);

  if (ranked.length === 0) {
    return 'Reasonable overall values alignment across your stated priorities.';
  }
  const labels = ranked.map((qId) => getQuestion(qId).short);
  return `Strong fit on ${labels.join(' and ')}.`;
}

function buildPortfolio(dataset, answers) {
  const riskProfile = deriveRiskProfile(answers);

  const scored = dataset.companies.map((company) => {
    const { score, alignments } = scoreCompany(company, answers);
    const { tier, conflicts } = classifyTier(alignments, answers);
    return {
      company,
      score,
      alignments,
      tier,
      conflicts,
      rationale: buildRationale(alignments, answers),
      note: tier === 'Partial' ? buildPartialMatchNote(conflicts) : null,
      matchesRiskProfile: company.performance_tier.risk_profile_fit === riskProfile,
    };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.matchesRiskProfile !== b.matchesRiskProfile) return a.matchesRiskProfile ? -1 : 1;
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
