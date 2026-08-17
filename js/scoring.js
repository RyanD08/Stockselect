/**
 * Values-fit scoring engine.
 *
 * Every scored question (ids 1-20 are the core values screens; ids 21, 23,
 * 24 are risk/portfolio-construction preferences added directly to the same
 * sum — see "Risk preferences" below; id 22 plays two distinct roles, also
 * described below) is either:
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
 *   - TRADE-OFF (new): the client is rating a preference between two
 *     opposites (e.g. stability vs. growth). a_i sits in [-1, +1] — +1 if
 *     the company sits at the preferred end, -1 at the other end, 0 at a
 *     genuine middle ground. See "Risk preferences" below for why these use
 *     a different importance mapping than every other question here.
 *
 * For the three judgment-based ESG categories (environmental / social_labor
 * / governance), a_i is additionally scaled by CONFIDENCE_WEIGHT so a
 * well-documented, verifiably-earned score counts more than an unverified
 * "generally well-regarded" placeholder of the same numeric value. Objective
 * facts (sin-stock flags, leverage, dividends, etc.) are never dampened.
 *
 * Financial quality — valuation (P/E, PEG), growth, profitability (margin,
 * ROE, FCF margin), analyst sentiment, and a time-horizon-selected return
 * (Q25) weighted by beta/market-cap/dividends per the client's derived Risk
 * Profile — is folded in as one more preference-type criterion in the exact
 * same weighted sum (see financialQualityAlignment), not a separate post-hoc
 * blend. Its importance weight comes from the client's Q22 answer
 * ("willingness to accept lower returns for values alignment"), inverted,
 * so it behaves exactly like any other question: a client who rates it a
 * 5-equivalent priority gets the same proportional influence as a 5/5 on
 * any values question, no more.
 *
 * Risk preferences (Q21 stability, Q23 blue-chip, Q24 dividend-income, plus
 * Q22's second role below) used to be averaged into one derived "Risk
 * Profile" bucket (Conservative/Balanced/Growth) that only ever reshaped
 * *how* financial quality was judged, and only ever broke ties between
 * companies that scored identically — a client's strongest individual risk
 * preference could get diluted by averaging with their other three answers,
 * and even a strong preference never moved the visible score. Now each of
 * these has its own direct term in the same weighted sum everything else
 * uses, so it always contributes proportionally to the visible score, on
 * its own, independent of the other three.
 *
 * These four terms use a different importance mapping than every other
 * question in this file: importance = rating - 1 (so 1->0, 5->4), instead
 * of the raw 1-5 rating. A rating of 1 ("not important to me") must produce
 * literally zero effect on the score in either direction — a client who
 * doesn't care about dividends shouldn't see even a small, easy-to-miss
 * penalty applied to a strong dividend payer just for how the weighted
 * average happens to divide out. Ratings 2-5 scale up normally from there.
 * (Q1-20 don't need this: they're one-directional, so a low rating already
 * can't push a company the "wrong" way — only trade-off-style, both-
 * directions questions have that risk.)
 *
 * Q22 plays two roles: it still sets financialImportance (how much the
 * financial-quality criterion counts overall) exactly as before, AND it
 * separately contributes its own trade-off term rewarding companies with
 * weaker financial-quality scores — a real "prioritize values over
 * financial strength" nudge, not just a smaller shrug at financials. Its
 * importance also uses the rating-1 mapping, so at Q22=1 this second term
 * is fully inert and never penalizes a strong company for being strong.
 *
 * The derived Risk Profile (Conservative/Balanced/Growth) still exists and
 * is still shown to the client (see deriveRiskProfile) — it just no longer
 * drives any of the above. It's a descriptive summary label now, not a
 * scoring mechanism, though it's still used to shape financialQualityAlignment
 * (see that function) since "what counts as a good return for a Growth
 * client" is a genuinely different question than "for a Conservative client.")
 *
 * contribution_i = clientImportance_i * a_i
 * score = 50 + 50 * (Σcontribution_i / ΣclientImportance_i), clipped to [0,100]
 *
 * 50 is the neutral starting point; the score moves up or down only as far
 * as the client's own stated priorities and the company's real attributes
 * justify. Strong Match always ranks above Partial Match; score only orders
 * within a tier.
 */

const SCORED_QUESTION_IDS = Array.from({ length: 20 }, (_, i) => i + 1); // 1-20
// Risk/portfolio-construction trade-off questions folded directly into the
// score (see header comment) but deliberately NOT part of SCORED_QUESTION_IDS:
// valuesFitScore() and classifyTier()'s conflict/tier-capping logic both
// iterate SCORED_QUESTION_IDS only, so these -- like financial quality --
// contribute to the blended ranking score without being able to either (a)
// count toward the minimum values-match floor or (b) cap a company's tier
// at Partial Match. That's intentional: these are financial/portfolio-
// construction preferences, not ethical/values screens, so they shouldn't
// change what counts as a genuine values match any more than a company's
// P/E ratio should.
const RISK_DIRECT_QUESTION_IDS = [21, 23, 24];
const HIGH_PRIORITY_THRESHOLD = 4; // client ratings of 4-5 count as "highest priority"
const CONFLICT_ALIGNMENT_THRESHOLD = -0.5; // a_i at or below this counts as a strong conflict
const MAX_PORTFOLIO_SIZE = 15;
const MAX_PER_SECTOR = 3;

// v3: judgment-based ESG scores are dampened by how well-documented they
// are, so a Low-confidence "safe 4" no longer counts the same as a
// High-confidence, verifiably-earned 4 or 5. Objective facts (sin-stock
// flags, founder-led, financial leverage, dividend status, etc.) are never
// dampened — the dataset already rates those "High confidence" by nature.
const CONFIDENCE_WEIGHT = { High: 1.0, Medium: 0.7, Low: 0.4 };

function confidenceWeight(level) {
  return CONFIDENCE_WEIGHT[level] !== undefined ? CONFIDENCE_WEIGHT[level] : 1.0;
}

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
  // Environmental (confidence-weighted — see CONFIDENCE_WEIGHT above)
  1: (c) => {
    const env = c.esg_ratings.environmental;
    return exclusionaryGraded(env.score) * confidenceWeight(env.confidence);
  },
  2: (c) => {
    const env = c.esg_ratings.environmental;
    const isCleanTech = noteMatches(env.note, /renewable|solar|wind|clean energy|clean tech|EV|hydrogen/i);
    const raw = isCleanTech ? 1 : preferenceGraded(env.score);
    return raw * confidenceWeight(env.confidence);
  },
  3: (c) => {
    const env = c.esg_ratings.environmental;
    return exclusionaryGraded(env.score) * confidenceWeight(env.confidence);
  },
  4: (c) => {
    const env = c.esg_ratings.environmental;
    const isSustainableResource = noteMatches(env.note, /sustainab|resource|recycl|water|agricultur/i);
    const raw = isSustainableResource ? 1 : preferenceGraded(env.score);
    return raw * confidenceWeight(env.confidence);
  },

  // Social / Labor (confidence-weighted)
  5: (c) => {
    const social = c.esg_ratings.social_labor;
    const strongWages = noteMatches(social.note, /above-market|strong reported labor|well-regarded/i);
    const raw = strongWages ? 1 : preferenceGraded(social.score);
    return raw * confidenceWeight(social.confidence);
  },
  6: (c) => {
    const social = c.esg_ratings.social_labor;
    const hasDispute = noteMatches(social.note, /dispute|union|strike|exploitation|controvers/i);
    const raw = hasDispute ? -1 : exclusionaryGraded(social.score);
    return raw * confidenceWeight(social.confidence);
  },
  7: (c) => {
    const social = c.esg_ratings.social_labor;
    const hasSafetyIssue = noteMatches(social.note, /safety/i);
    const raw = hasSafetyIssue ? 0 : preferenceGraded(social.score);
    return raw * confidenceWeight(social.confidence);
  },

  // Governance (confidence-weighted)
  8: (c) => {
    const gov = c.esg_ratings.governance;
    const hasScandal = noteMatches(gov.note, /litigation|scandal|fraud|corruption|settlement|controvers|investigation/i);
    const raw = hasScandal ? -1 : exclusionaryGraded(gov.score);
    return raw * confidenceWeight(gov.confidence);
  },
  9: (c) => {
    const gov = c.esg_ratings.governance;
    const concentratedVoting = noteMatches(gov.note, /dual-class|voting power|majority control|majority voting|significant influence/i);
    const raw = concentratedVoting ? -1 : exclusionaryGraded(gov.score);
    return raw * confidenceWeight(gov.confidence);
  },
  // Objective/financial-statement fact — full weight, not confidence-dampened
  10: (c) => leverageAlignment(c.financial_leverage.level),

  // Ethical / "Sin Stock" Screens — objective flags, full weight
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

// Trade-off-style direct terms for the risk/portfolio-construction questions
// (see header comment "Risk preferences"). Each returns [-1, +1]: +1 at the
// preferred end, -1 at the opposite end, 0 at a genuine middle ground.
const NEUTRAL_BETA = 1.0; // ~market-average volatility
const BETA_SWING = 1.0; // beta this far from neutral in either direction reaches ±1
function stabilityDirectAlignment(company) {
  const beta = company.market_profile.beta_est;
  if (beta === null || beta === undefined) return 0;
  return Math.max(-1, Math.min(1, (NEUTRAL_BETA - beta) / BETA_SWING));
}

// DIVIDEND_YIELD_RANK (defined below, reused here) treats "Low" as the
// neutral center: a non-payer is actively penalized, a high-yield payer is
// actively rewarded, exactly matching the "preference for dividend-paying
// income stocks over growth-focused reinvestment" framing of Q24.
function dividendDirectAlignment(company) {
  const rank = dividendYieldRank(company.dividend_policy);
  return Math.max(-1, Math.min(1, (rank - 2) / 2));
}

// MARKET_CAP_RANK (defined below, reused here): Mega/Large rewarded,
// Mid/Small penalized, centered between Large and Mid. This is the *soft*
// blue-chip preference (Q23 ratings 1-4); a rating of 5 is instead a hard
// filter — see isBlueChipEligible.
function blueChipDirectAlignment(company) {
  const rank = MARKET_CAP_RANK[company.market_profile.market_cap_tier];
  if (rank === undefined) return 0;
  return Math.max(-1, Math.min(1, (rank - 1.5) / 1.5));
}

const RISK_ALIGNMENT_FNS = {
  21: stabilityDirectAlignment,
  23: blueChipDirectAlignment,
  24: dividendDirectAlignment,
};

function scoreCompany(company, answers, ctx, riskProfile) {
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

  // Financial quality as one more weighted criterion (see header comment).
  const financialImportance = 6 - (answers[22] || 3);
  const financialAlignment = financialQualityAlignment(company, riskProfile, ctx.timeHorizon);
  numerator += financialImportance * financialAlignment;
  denominator += financialImportance;

  // Risk/portfolio-construction trade-off terms (Q21, Q23, Q24) — rating-1
  // importance mapping so a rating of 1 is a true no-op (see header comment).
  RISK_DIRECT_QUESTION_IDS.forEach((qId) => {
    const importance = Math.max(0, (answers[qId] || 3) - 1);
    const alignment = RISK_ALIGNMENT_FNS[qId](company);
    alignments[qId] = alignment;
    numerator += importance * alignment;
    denominator += importance;
  });

  // Q22's second role: reward weaker financial-quality companies (a real
  // "prioritize values over financial strength" nudge), same rating-1
  // mapping so it never penalizes a strong company when Q22=1.
  const valuesOverReturnsImportance = Math.max(0, (answers[22] || 3) - 1);
  const valuesOverReturnsAlignment = 1 - 2 * financialAlignment;
  numerator += valuesOverReturnsImportance * valuesOverReturnsAlignment;
  denominator += valuesOverReturnsImportance;

  const raw = denominator > 0 ? 50 + 50 * (numerator / denominator) : 50;
  const score = Math.round(Math.min(100, Math.max(0, raw)));
  return {
    score,
    alignments,
    financialImportance,
    financialAlignment,
    valuesOverReturnsImportance,
    valuesOverReturnsAlignment,
  };
}

// Patch v17: values-only score -- the original confidence-weighted formula
// (Patch v1, base prompt Section 2.2) over SCORED_QUESTION_IDS alone, before
// Patch v6 folded financial quality into the same weighted sum. Deliberately
// excludes financial quality AND the risk/portfolio-construction trade-off
// terms (Q21-24) so a company can't buy its way past a genuine values
// mismatch with good financials or a risk-profile match -- this is what the
// minimum values match floor (MINIMUM_VALUES_MATCH below) is evaluated
// against, not the blended score scoreCompany() returns for ranking.
function valuesFitScore(company, answers, ctx) {
  let numerator = 0;
  let denominator = 0;
  SCORED_QUESTION_IDS.forEach((qId) => {
    const importance = answers[qId] || 3;
    const alignment = ALIGNMENT_FNS[qId](company, ctx);
    numerator += importance * alignment;
    denominator += importance;
  });
  const raw = denominator > 0 ? 50 + 50 * (numerator / denominator) : 50;
  return Math.round(Math.min(100, Math.max(0, raw)));
}

// Recalibrated twice from the originally-proposed 45:
//   45 -> 48: every company's esg_ratings are currently a uniform neutral
//   placeholder (score 3, confidence Low -- no live per-company ESG source
//   on this API tier), so roughly half of the 20 scored questions
//   contribute zero differentiation for every company. A single
//   maximally-weighted, genuine conflict (e.g. a client who rates "avoid
//   weapons manufacturers" 5/5, scored against an actual weapons company)
//   only pulled the blended score down to ~46-47 -- 45 would have been
//   dead code, never excluding anything in practice.
//   48 -> 54: 48 only screened out net-negative matches (a disqualification
//   floor), not a requirement for genuine positive alignment -- a company
//   with only incidental/neutral values alignment (e.g. just "headquartered
//   domestically") but strong financials could still rank as a Strong
//   Match. The same placeholder-uniformity issue caps how high any
//   company's score can realistically go (the observed ceiling across
//   realistic client profiles is ~54), so a threshold meant to require
//   genuine positive alignment has to sit close to that ceiling or it
//   isn't actually requiring anything. Calibrated directly against the
//   dataset to keep roughly 100 Mega/Large-cap ($10B+) companies eligible
//   for a typical client profile (101 at 54) -- smaller-cap eligibility
//   count was explicitly not a calibration target. This ceiling, and this
//   threshold, will both shift once real per-company ESG data replaces the
//   uniform placeholder.
const MINIMUM_VALUES_MATCH = 54;

function meetsValuesFloor(company, answers, ctx) {
  return valuesFitScore(company, answers, ctx) >= MINIMUM_VALUES_MATCH;
}

// Purely descriptive now (see header comment "Risk preferences") — still
// shown to the client as a summary label ("Your Risk Profile") and still
// used to shape financialQualityAlignment's formula (a good return means
// something different to a Growth client than a Conservative one), but no
// longer drives tie-breaking or bucket-switches anything else.
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

function buildRationale(alignments, answers, financialImportance, financialAlignment, valuesOverReturnsImportance, valuesOverReturnsAlignment) {
  const candidates = SCORED_QUESTION_IDS.map((qId) => ({
    label: getQuestion(qId).short,
    importance: answers[qId] || 3,
    alignment: alignments[qId],
  }));
  candidates.push({ label: 'Strong financial fundamentals', importance: financialImportance, alignment: financialAlignment });
  RISK_DIRECT_QUESTION_IDS.forEach((qId) => {
    candidates.push({
      label: getQuestion(qId).short,
      importance: Math.max(0, (answers[qId] || 3) - 1),
      alignment: alignments[qId],
    });
  });
  candidates.push({ label: getQuestion(22).short, importance: valuesOverReturnsImportance, alignment: valuesOverReturnsAlignment });

  const highPriority = candidates.filter((c) => c.importance >= HIGH_PRIORITY_THRESHOLD);
  const pool = highPriority.length > 0 ? highPriority : candidates;

  const ranked = pool
    .filter((c) => c.alignment > 0)
    .sort((a, b) => b.alignment - a.alignment)
    .slice(0, 2);

  if (ranked.length === 0) {
    return 'Reasonable overall values alignment across your stated priorities.';
  }
  return `Strong fit on ${ranked.map((c) => c.label).join(' and ')}.`;
}

const MARKET_CAP_RANK = { Mega: 3, Large: 2, Mid: 1, Small: 0 };

// Q23 (blue-chip preference) is now a hybrid: a rating of 5 ("only" large,
// established companies) is still a hard, non-negotiable pre-filter --
// smaller companies are excluded outright, never backfilled/relaxed, since
// "only suggest blue-chip" should mean literally that. Ratings 1-4 no
// longer filter anything: they're a soft, graded preference instead (see
// blueChipDirectAlignment above), so a client who leans blue-chip without
// requiring it can still see a well-matched smaller company.
function isBlueChipEligible(company, answers) {
  const q23 = answers[23] || 3;
  if (q23 < 5) return true;
  return company.market_profile.market_cap_tier === 'Mega';
}

function controversyCount(company) {
  const regex = /dispute|controvers|scandal|fraud|corruption|litigation|settlement|safety|dual-class|voting power|majority control|majority voting/i;
  return ['environmental', 'social_labor', 'governance']
    .map((key) => company.esg_ratings[key].note)
    .filter((note) => noteMatches(note, regex)).length;
}

function compareArrays(a, b) {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

const DIVIDEND_YIELD_RANK = { High: 4, Medium: 3, Low: 2, 'Very Low': 1, None: 0 };

function dividendYieldRank(dividendPolicy) {
  const tier = dividendPolicy && dividendPolicy.yield_tier;
  if (!tier || tier === 'None') return 0;
  return DIVIDEND_YIELD_RANK[tier] !== undefined ? DIVIDEND_YIELD_RANK[tier] : 0;
}

// Fixed-scale (not pool-relative) 0-1 normalizers, so financial quality
// composes as an ordinary per-company alignment function exactly like the
// ESG-based ones above, instead of needing a second normalization pass over
// a candidate set. Bounds are set from the dataset's actual observed range
// with a little headroom, and clamped to [0,1] so outliers just cap out
// rather than skewing the scale.
function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}
function betaAlignment(beta) {
  // higher beta = more reward (risk tolerance) — used for Growth clients
  return clamp01((beta - 0.3) / (2.2 - 0.3));
}
function stabilityAlignment(beta) {
  // lower beta = more reward — used for Conservative clients
  return 1 - betaAlignment(beta);
}
function marketCapAlignment(tier) {
  return (MARKET_CAP_RANK[tier] || 0) / 3;
}
function dividendYieldAlignment(dividendPolicy) {
  return dividendYieldRank(dividendPolicy) / 4;
}

// A missing fundamental (null in the dataset — unprofitable, not
// meaningful for the sector, or too-low growth to compute) is treated as
// neutral rather than penalized, consistent with how every other
// preference-type criterion in this file treats "no data."
const NEUTRAL_ALIGNMENT = 0.5;

function peAlignment(pe) {
  if (pe === null || pe === undefined) return NEUTRAL_ALIGNMENT;
  return clamp01((60 - pe) / (60 - 8)); // lower P/E = cheaper relative to earnings = better
}
function pegAlignment(peg) {
  if (peg === null || peg === undefined) return NEUTRAL_ALIGNMENT;
  return clamp01((6 - peg) / (6 - 0.5));
}
function revenueGrowthAlignment(growthPct) {
  return clamp01((growthPct - -5) / (40 - -5));
}
function profitMarginAlignment(marginPct) {
  return clamp01((marginPct - -5) / (40 - -5));
}
function roeAlignment(roePct) {
  if (roePct === null || roePct === undefined) return NEUTRAL_ALIGNMENT;
  // Buyback-driven ROE spikes (e.g. low/negative shareholder equity) are an
  // accounting artifact, not extraordinary quality — cap before normalizing
  // so they don't mechanically dominate the composite.
  const capped = Math.min(roePct, 60);
  return clamp01(capped / 60);
}
function fcfMarginAlignment(fcfMarginPct) {
  if (fcfMarginPct === null || fcfMarginPct === undefined) return NEUTRAL_ALIGNMENT; // not meaningful for financial-sector companies
  return clamp01((fcfMarginPct - -5) / (35 - -5));
}
const ANALYST_CONSENSUS_SCORE = { 'Strong Buy': 1.0, Buy: 0.75, Hold: 0.5, Sell: 0.25, 'Strong Sell': 0.0 };
function analystConsensusAlignment(consensus) {
  return ANALYST_CONSENSUS_SCORE[consensus] !== undefined ? ANALYST_CONSENSUS_SCORE[consensus] : NEUTRAL_ALIGNMENT;
}
function analystUpsideAlignment(upsidePct) {
  if (upsidePct === null || upsidePct === undefined) return NEUTRAL_ALIGNMENT;
  return clamp01((upsidePct - -5) / (15 - -5));
}

// Bounds per time horizon, since 6-month/1-year/5-year returns naturally
// span different ranges (a great 6-month return and a great 5-year
// annualized return are not the same number).
const HORIZON_RETURN_BOUNDS = {
  short: [-10, 25],
  medium: [-12, 45],
  long: [-10, 40],
};

function horizonReturnValue(company, timeHorizon) {
  if (timeHorizon === 'short') return company.financial_metrics.six_month_return_pct;
  if (timeHorizon === 'medium') return company.financial_metrics.one_year_return_pct;
  return company.performance_tier.five_year_annualized_return_pct_est;
}

// The client's selected time horizon (Q25) picks which return field is
// used; the client's derived Risk Profile still decides how that return is
// weighted against beta/cap/dividends. This is one of the 9 metrics
// averaged into financialQualityAlignment below, not a separate score.
function timeHorizonReturnAlignment(company, riskProfile, timeHorizon) {
  const beta = company.market_profile.beta_est;
  const ret = horizonReturnValue(company, timeHorizon);
  if (ret === null || ret === undefined) return NEUTRAL_ALIGNMENT;
  const bounds = HORIZON_RETURN_BOUNDS[timeHorizon] || HORIZON_RETURN_BOUNDS.long;
  const [min, max] = bounds;
  const retAlign = clamp01((ret - min) / (max - min));

  if (riskProfile === 'Growth') {
    // reward high return AND high beta (risk tolerance, not risk-adjusted)
    return (retAlign + betaAlignment(beta)) / 2;
  }
  if (riskProfile === 'Conservative') {
    // reward large cap + high dividend yield + stability, lightly reward return
    return (
      0.3 * marketCapAlignment(company.market_profile.market_cap_tier) +
      0.3 * dividendYieldAlignment(company.dividend_policy) +
      0.3 * stabilityAlignment(beta) +
      0.1 * retAlign
    );
  }
  // Balanced: reward risk-adjusted return. Dividing by a sub-1 beta can push
  // the result above the raw return range, so the top bound gets 25%
  // headroom rather than clamping every low-beta company's ratio to 1.
  const riskAdjusted = beta > 0 ? ret / beta : ret;
  return clamp01((riskAdjusted - min) / (max * 1.25 - min));
}

// Patch v16 §2: for a Growth risk profile on a Long-term horizon, equal
// weighting treats a client optimizing for long-term growth the same as one
// optimizing for income or stability — a cheap, low-growth "value" stock
// could outscore a genuine growth company on metrics that don't actually
// matter to this client. Order matches the `components` array in
// financialQualityAlignment below exactly. Everyone else keeps equal
// weighting.
const GROWTH_PROFILE_WEIGHTS = {
  inv_pe: 0.5, // de-emphasized — growth investors reasonably accept higher P/E
  inv_peg: 1.5, // emphasized — PEG already adjusts valuation for growth rate
  growth: 2.0, // emphasized — revenue growth is the core signal for this client
  margin: 1.0,
  roe: 1.0,
  fcf: 1.0,
  consensus: 1.0,
  upside: 1.5, // emphasized — forward-looking signal matters more for growth
  ret: 2.0, // emphasized — long-horizon return (already selected via time horizon)
};
const GROWTH_PROFILE_WEIGHT_ORDER = ['inv_pe', 'inv_peg', 'growth', 'margin', 'roe', 'fcf', 'consensus', 'upside', 'ret'];

// Financial quality, folded into scoreCompany as one more preference-type
// criterion (reward-only, 0-1, never penalizes) — 9 normalized sub-metrics:
// 8 fundamentals/analyst signals plus the risk-profile-aware,
// time-horizon-selected return above. Equal weight for everyone except a
// Growth risk profile on a Long-term horizon, which uses GROWTH_PROFILE_WEIGHTS
// instead (Patch v16 §2).
function financialQualityAlignment(company, riskProfile, timeHorizon) {
  const fm = company.financial_metrics;
  const components = [
    peAlignment(fm.pe_ratio),
    pegAlignment(fm.peg_ratio),
    revenueGrowthAlignment(fm.revenue_growth_yoy_pct),
    profitMarginAlignment(fm.profit_margin_pct),
    roeAlignment(fm.roe_pct),
    fcfMarginAlignment(fm.free_cash_flow_margin_pct),
    analystConsensusAlignment(fm.analyst_consensus),
    analystUpsideAlignment(fm.analyst_price_target_upside_pct),
    timeHorizonReturnAlignment(company, riskProfile, timeHorizon),
  ];

  if (riskProfile === 'Growth' && timeHorizon === 'long') {
    const weights = GROWTH_PROFILE_WEIGHT_ORDER.map((key) => GROWTH_PROFILE_WEIGHTS[key]);
    const weightedSum = components.reduce((sum, v, i) => sum + v * weights[i], 0);
    const weightTotal = weights.reduce((sum, w) => sum + w, 0);
    return weightedSum / weightTotal;
  }

  return components.reduce((sum, v) => sum + v, 0) / components.length;
}

// Financial Caution Flags: a soft signal for real financial red flags,
// independent of values fit. Unlike everything else in this file, this is
// evaluated on raw dataset fields rather than folded into the weighted
// alignment sum — it never removes a company from results, but it (a) caps
// its tier at Partial Match regardless of values alignment, (b) knocks a
// flat penalty off its ranking score, and (c) surfaces a visible badge
// naming the specific concern(s) so a client can tell a low ranking is
// about financial health, values misalignment, or both.
const CAUTION_PENALTY = 15;

function detectCautionFlags(company) {
  const fm = company.financial_metrics;
  const flags = [];

  if (fm.analyst_consensus === 'Sell' || fm.analyst_consensus === 'Strong Sell') {
    flags.push('Currently rated Sell by analyst consensus');
  }

  const weakConsensus = fm.analyst_consensus === 'Hold' || fm.analyst_consensus === 'Sell' || fm.analyst_consensus === 'Strong Sell';
  if (fm.profit_margin_pct < 0 && weakConsensus) {
    flags.push('Currently unprofitable with limited analyst confidence in a turnaround');
  }

  const fiveYear = company.performance_tier.five_year_annualized_return_pct_est;
  if (fiveYear < 0 && fm.one_year_return_pct < 0 && fm.six_month_return_pct < 0) {
    flags.push('Negative returns over the past 6 months, 1 year, and 5 years');
  }

  // Patch v15 §2b: a severe single-year decline is a real red flag on its
  // own, even when it doesn't trip the "negative across all three horizons"
  // rule above (e.g. still up over 5 years, or 6-month return not yet
  // negative) and even when 8 other decent-to-strong metrics would
  // otherwise average it up to "Above Average" in the composite score.
  if (fm.one_year_return_pct <= -25) {
    flags.push('Down 25% or more over the past year');
  }

  return flags;
}

const BELOW_VALUES_THRESHOLD_NOTE =
  "This company's overall values alignment does not meet the tool's minimum bar for a genuine match. " +
  'Shown only to fill out your 15-company portfolio because not enough companies met that bar within your other preferences.';

function buildScoredEntry(company, answers, ctx, riskProfile) {
  const {
    score,
    alignments,
    financialImportance,
    financialAlignment,
    valuesOverReturnsImportance,
    valuesOverReturnsAlignment,
  } = scoreCompany(company, answers, ctx, riskProfile);
  const { tier: valuesFitTier, conflicts } = classifyTier(alignments, answers);
  const cautionFlags = detectCautionFlags(company);
  // Tier cap: a caution flag overrides an otherwise-Strong values match —
  // never silently disqualified, just never allowed to read as "Strong."
  const tier = cautionFlags.length > 0 ? 'Partial' : valuesFitTier;
  // Flat penalty applied to the already-blended score used for ranking —
  // a company can still climb back into range on an exceptional values
  // match, but a mediocre one combined with a caution flag typically
  // falls out of the top 15 (see CAUTION_PENALTY comment above).
  const penalizedScore = cautionFlags.length > 0 ? Math.max(0, score - CAUTION_PENALTY) : score;
  return {
    company,
    score: penalizedScore,
    alignments,
    tier,
    conflicts,
    cautionFlags,
    rationale: buildRationale(alignments, answers, financialImportance, financialAlignment, valuesOverReturnsImportance, valuesOverReturnsAlignment),
    note: conflicts.length > 0 ? buildPartialMatchNote(conflicts) : null,
    controversyCount: controversyCount(company),
  };
}

// Strong before Partial before Below Values Threshold as a hard rule; score
// orders within a tier; then controversy count / ticker as successive
// tie-breakers. (Beta/market-cap/dividend/return preferences used to break
// ties here too, before Q21/23/24 became direct scored criteria — now that
// they already move the visible score, a leftover tie is a genuine toss-up
// rather than a sign those signals still need a say.)
const TIER_RANK = { Strong: 0, Partial: 1, 'Below Values Threshold': 2 };

function sortScoredEntries(entries) {
  entries.sort((a, b) => {
    if (TIER_RANK[a.tier] !== TIER_RANK[b.tier]) return TIER_RANK[a.tier] - TIER_RANK[b.tier];
    if (b.score !== a.score) return b.score - a.score;
    if (a.controversyCount !== b.controversyCount) return a.controversyCount - b.controversyCount;
    return a.company.ticker.localeCompare(b.company.ticker);
  });
  return entries;
}

// Fills `selected` (respecting MAX_PORTFOLIO_SIZE and the shared, running
// sectorCounts so diversification holds across both the primary and
// backfill passes) from a sorted list of candidates.
function fillFromCandidates(candidates, selected, sectorCounts) {
  for (const entry of candidates) {
    if (selected.length >= MAX_PORTFOLIO_SIZE) break;
    const sector = entry.company.sector;
    const countInSector = sectorCounts[sector] || 0;
    if (countInSector >= MAX_PER_SECTOR) continue;
    sectorCounts[sector] = countInSector + 1;
    selected.push(entry);
  }
}

function buildPortfolio(dataset, answers, clientContext) {
  const ctx = {
    homeCountry: (clientContext && clientContext.homeCountry) || 'United States',
    tiesSector: (clientContext && clientContext.tiesSector) || null,
    timeHorizon: (clientContext && clientContext.timeHorizon) || 'long',
  };
  const riskProfile = deriveRiskProfile(answers);

  // Q23 at 5/5 is still a hard, non-negotiable pre-filter — see
  // isBlueChipEligible. At 1-4 it no longer filters anything (soft
  // preference instead, folded into the score itself).
  const blueChipEligible = dataset.companies.filter((company) => isBlueChipEligible(company, answers));

  // Patch v17 + follow-up: the minimum values-match floor IS backfillable —
  // if requiring a genuine values match (not just "not disqualified") means
  // fewer than 15 companies clear it, the next-best companies by score are
  // still shown rather than returning a short list, but relabeled "Below
  // Values Threshold" rather than Strong/Partial so it's honest about why
  // they're there. They only ever fill remaining slots after every
  // genuinely-matching company has already been placed.
  const meetsFloor = (c) => meetsValuesFloor(c, answers, ctx);
  const primaryCandidates = sortScoredEntries(
    blueChipEligible.filter(meetsFloor).map((c) => buildScoredEntry(c, answers, ctx, riskProfile))
  );
  const backfillCandidates = sortScoredEntries(
    blueChipEligible
      .filter((c) => !meetsFloor(c))
      .map((c) => {
        const entry = buildScoredEntry(c, answers, ctx, riskProfile);
        entry.tier = 'Below Values Threshold';
        entry.note = BELOW_VALUES_THRESHOLD_NOTE;
        return entry;
      })
  );

  const sectorCounts = {};
  const selected = [];
  fillFromCandidates(primaryCandidates, selected, sectorCounts);
  fillFromCandidates(backfillCandidates, selected, sectorCounts);

  const allocationPct = selected.length > 0 ? 100 / selected.length : 0;
  selected.forEach((entry) => {
    entry.allocationPct = allocationPct;
  });

  return { riskProfile, holdings: selected };
}
