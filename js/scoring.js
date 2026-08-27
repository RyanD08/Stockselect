/**
 * Values-fit scoring engine.
 *
 * Restructured 2026-08-21 to match the 28-question schema imported from
 * RyanD08/stock-select-data-mine — see data/import_schema_comparison.md
 * for the full before/after (question renumbering, two new categories,
 * MERGED_QUESTION_GROUPS removed since the new per-company data no longer
 * makes Q1/Q3 or Q11/Q12 literal duplicates of each other). Financial-
 * quality scoring (financialQualityAlignment and everything it depends on,
 * from here down to the end of this file) is UNCHANGED throughout — this
 * pass only ever touched ESG/values-side scoring, per the task's explicit
 * "do not overwrite financial data" rule.
 *
 * Later the same day, blue-chip preference and dividend-income preference
 * were restored at the client's explicit request, using the financial data
 * (market_cap_tier, dividend yield_tier) that was never touched by the ESG
 * import in the first place — see "Risk preferences" below.
 *
 * Still the same day: a client-requested simulation ("how many of the 502
 * companies can actually appear in a recommendation?") found only 34.7%
 * ever could, across thousands of simulated client profiles -- and that
 * sweeping MINIMUM_VALUES_MATCH from 54 down to a near-trivial 42 barely
 * moved that number, proving the floor was never the real constraint. The
 * actual cause: unitImportance's old LINEAR rating weighting let ~25
 * neutral/no-data fields dilute a client's genuine top priorities into an
 * indistinguishable ~50-58 band for nearly every company. Fixed by
 * squaring importance and excluding genuinely-missing data from the
 * weighting denominator entirely (see unitImportance/questionHasData
 * below) -- simulated to raise reachability to 43.2% on its own, no floor
 * or cap changes at all. MINIMUM_VALUES_MATCH (54->52) and MAX_PER_SECTOR
 * (3->5) were then also loosened modestly on top of that fix, landing
 * around 48% in simulation. Full methodology and numbers in
 * data/import_schema_comparison.md "Scoring formula recalibration".
 *
 * 2026-08-22: a follow-up simulation ("who keeps showing up") found that
 * fixing reachability had an unaddressed side effect -- a small group of
 * companies structurally immune to every exclusionary screen (never
 * scoring negatively on any values question they have data for, simply by
 * not being in a screened industry) appeared in recommended portfolios
 * 7.4x more often on average than every other company. Ford Motor Company
 * appeared in 75% of 3,000 simulated portfolios regardless of what the
 * simulated client said mattered. First fixed with a flat ranking discount
 * for zero-negative companies (parity, +5pp reachability) -- then revised
 * the same day to a continuous version, OVERREP_MAX_PENALTY / (1 +
 * negativeCount) (see that constant and scoreCompany below), after
 * noticing the flat version was a cliff: a company with exactly one real
 * negative got zero discount and could still dominate almost as much as a
 * fully clean one. The continuous version decays smoothly instead, and
 * simulated better on every metric (0 companies left over 50% of
 * portfolios vs. 4, 66.3% universe reachability vs. 60.4%). Eligibility is
 * untouched either way, so the Aug-21 reachability fix is unaffected.
 *
 * 2026-08-23: removed the "religious investment compliance"
 * (halal/kosher/faith-based screening) question entirely -- it had 0%
 * real data coverage across the whole live dataset (no comprehensive
 * public source exists at S&P 500 scale, confirmed during the data-
 * quality audit) and could never contribute anything but a hardcoded-
 * neutral score, the same reasoning the animal-testing question was
 * removed for during the 2026-08-21 restructure. religiousComplianceAlignment()
 * and its questionHasData()/ALIGNMENT_FNS entries are gone, not just
 * hidden. The Religious Values category's other question, "avoiding
 * interest-based financial products" (which does have real data), moved
 * into Ethical / "Sin Stock" Screens rather than being removed with it --
 * same field, same wording, same alignment function, just re-slotted.
 * Every question from that point on renumbered down to close the gap; see
 * data/import_schema_comparison.md for the full old-id -> new-id mapping.
 * Net question count: 30 -> 29 rated + the horizon selector.
 *
 * Every scored question (ids 1-25 are the values screens; ids 26, 28, 29
 * are risk/portfolio-construction preferences added directly to the same
 * sum, id 27 plays a dual role — see "Risk preferences" below) is either:
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
 *   - TRADE-OFF: the client is rating a preference between two opposites
 *     (stability vs. growth). a_i sits in [-1, +1] — +1 if the company
 *     sits at the preferred end, -1 at the other end, 0 at a genuine
 *     middle ground. See "Risk preferences" below for why these use a
 *     different importance mapping than every other question here.
 *
 * Every judgment-based ESG question (environmental / social_labor /
 * governance / political — everything except the objective sin-stock
 * booleans and the community/identity questions, which read plain identity
 * fields rather than a confidence-rated research field) has its a_i
 * additionally scaled by CONFIDENCE_WEIGHT, read directly from that
 * question's own underlying field, so a well-documented, High-confidence
 * finding counts more than a Low-confidence or unverified one of the same
 * nominal value. "No verifiable data found" (confidence "None") always
 * scores a neutral 0 before any confidence weighting is even applied — the
 * two mechanisms aren't redundant: the first ensures missing data never
 * penalizes or rewards a company, the second ensures a *found but shaky*
 * data point doesn't move the score as much as a solid one.
 *
 * Financial quality — valuation (P/E, PEG), growth, profitability (margin,
 * ROE, FCF margin), analyst sentiment, and a time-horizon-selected return
 * weighted by beta/market-cap/dividends per the client's derived Risk
 * Profile — is folded in as one more preference-type criterion in the exact
 * same weighted sum (see financialQualityAlignment), not a separate post-hoc
 * blend. Its importance weight comes from the client's "willingness to
 * accept lower returns for values alignment" answer, inverted, so it
 * behaves exactly like any other question: a client who rates it a
 * 5-equivalent priority gets the same proportional influence as a 5/5 on
 * any values question, no more.
 *
 * Risk preferences (stability, blue-chip, dividend-income, plus the
 * values-over-returns question's second role below) each have their own
 * direct term in the same weighted sum everything else uses, so they
 * always contribute proportionally to the visible score, on their own.
 *
 * These terms use a different importance mapping than every other question
 * in this file: importance = rating - 1 (so 1->0, 5->4), instead of the
 * raw 1-5 rating. A rating of 1 ("not important to me") must produce
 * literally zero effect on the score in either direction — a client who
 * doesn't care about dividends shouldn't see even a small, easy-to-miss
 * penalty applied to a strong dividend payer just for how the weighted
 * average happens to divide out. Ratings 2-5 scale up normally from there.
 * (Q1-25 don't need this: they're one-directional, so a low rating already
 * can't push a company the "wrong" way — only trade-off-style, both-
 * directions questions have that risk.)
 *
 * The values-over-returns question plays two roles: it still sets
 * financialImportance (how much the financial-quality criterion counts
 * overall) exactly as before, AND it separately contributes its own
 * trade-off term rewarding companies with weaker financial-quality scores
 * — a real "prioritize values over financial strength" nudge, not just a
 * smaller shrug at financials. Its importance also uses the rating-1
 * mapping, so at a rating of 1 this second term is fully inert and never
 * penalizes a strong company for being strong.
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

const SCORED_QUESTION_IDS = Array.from({ length: 25 }, (_, i) => i + 1); // 1-25
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
const RISK_DIRECT_QUESTION_IDS = [26, 28, 29];

// One "scoring unit" per scored question id. (v2 had MERGED_QUESTION_GROUPS
// here, folding Q1/Q3 and Q8/Q9 into one term each because both members of
// a pair always computed the exact same alignment value off a shared
// placeholder datapoint. That's no longer true: the imported dataset gives
// each question its own genuinely distinct field -- e.g. Q1 carbon/fossil-
// fuel involvement (a 10-K keyword-scan enum) and Q3 pollution violations
// (real EPA ECHO penalty data) can now disagree for the same company -- so
// merging them would silently discard a real distinction instead of
// avoiding a double-count. Every function below that used to iterate
// SCORING_UNITS for this reason now iterates SCORED_QUESTION_IDS directly.)
const SCORING_UNITS = SCORED_QUESTION_IDS.map((id) => ({ ids: [id] }));

function unitLabel(unit) {
  return unit.label || getQuestion(unit.ids[0]).short;
}

// Recalibrated 2026-08-21 (see data/import_schema_comparison.md "Scoring
// formula recalibration"): squares each rating instead of using it
// linearly, so a client's actual top priorities (4s/5s) dominate the
// weighted sum instead of being diluted by ~25 other fields left at the
// neutral default of 3. Simulated against 502 real companies: this alone
// (no floor/cap changes) raised the fraction of the S&P 500 that can ever
// appear in a recommended portfolio from 34.7% to 43.2%, and roughly
// doubled the spread of values-fit scores across companies (stddev 1.71 ->
// 3.60 on a fixed neutral profile) -- confirming the flat linear average
// was compressing nearly every company into an indistinguishable ~50-58
// band, not the values-match floor (see MINIMUM_VALUES_MATCH below).
function unitImportance(unit, answers) {
  const sum = unit.ids.reduce((total, id) => total + Math.pow(answers[id] || 3, 2), 0);
  return sum / unit.ids.length;
}

// The RAW (unsquared) 1-5 rating -- used wherever code asks "did the
// client actually rate this a high priority?" (classifyTier's conflict
// detection, buildRationale's high-priority filter), as opposed to
// unitImportance's squared value, which is only meant for the weighted-sum
// math above. Squared importance's minimum possible value (9, at the
// default rating of 3) already exceeds HIGH_PRIORITY_THRESHOLD (4), so
// using it for these "is this really a 4-5 rating" checks would trigger
// unconditionally -- every question would read as "high priority," and in
// buildRationale specifically it would drown out genuinely high-priority
// financial/risk terms (which stayed on the original 0-5 scale) in the
// pool comparison.
function unitRawRating(unit, answers) {
  const sum = unit.ids.reduce((total, id) => total + (answers[id] || 3), 0);
  return sum / unit.ids.length;
}

// Companion to unitImportance: a question with genuinely no verifiable
// data for this company must not just score neutral (0) -- its importance
// weight also has to be excluded from the denominator entirely, or a
// client's high priority on an unanswerable question silently dilutes
// their real, answerable priorities (the same root problem unitImportance
// above addresses, from the other side). Mirrors each ALIGNMENT_FNS
// entry's own no-data check exactly, one case per scored question
// (ids 1-25); ids 26+ (risk/financial terms) never call this.
function questionHasData(qid, company, ctx) {
  switch (qid) {
    case 1: {
      const screen = fossilFuelScreen(company);
      if (screen && typeof screen.involved === 'boolean') return true;
      return !hasNoData(fieldOf(company, 'carbon_fossil_fuel_involvement'));
    }
    case 2: return !hasNoData(fieldOf(company, 'renewable_clean_tech_involvement'));
    case 3: { const f = fieldOf(company, 'environmental_pollution_violations'); return !hasNoData(f) && typeof f.value === 'object'; }
    case 4: return !hasNoData(fieldOf(company, 'sustainable_agriculture_resource_use'));
    case 5: return !hasNoData(fieldOf(company, 'fair_wages_labor_practices'));
    case 6: { const f = fieldOf(company, 'labor_disputes_exploitation_history'); return !hasNoData(f) && typeof f.value === 'object' && typeof f.value.case_count === 'number'; }
    case 7: return !hasNoData(fieldOf(company, 'workplace_diversity_equity_inclusion'));
    case 8: { const f = fieldOf(company, 'worker_safety_record'); return !hasNoData(f) && typeof f.value === 'object' && typeof f.value.matched_establishment_rows === 'number'; }
    case 9: { const f = fieldOf(company, 'board_transparency_independence'); return !hasNoData(f) && typeof f.value === 'object' && typeof f.value.pct_independent_directors === 'number'; }
    case 10: { const f = fieldOf(company, 'ceo_pay_ratio'); return !hasNoData(f) && typeof f.value === 'number'; }
    case 11: { const f = fieldOf(company, 'fraud_corruption_scandal_history'); return !hasNoData(f) && typeof f.value === 'object' && typeof f.value.case_count === 'number'; }
    case 12: return !hasNoData(fieldOf(company, 'shareholder_rights_voting_structure'));
    case 13: return !hasNoData(fieldOf(company, 'tobacco_involvement'));
    case 14: return !hasNoData(fieldOf(company, 'alcohol_involvement'));
    case 15: return !hasNoData(fieldOf(company, 'gambling_casino_involvement'));
    case 16: return !hasNoData(fieldOf(company, 'weapons_defense_involvement'));
    case 17: return !hasNoData(fieldOf(company, 'adult_entertainment_involvement'));
    case 18: return !hasNoData(fieldOf(company, 'interest_based_financial_products'));
    case 19: return !hasNoData(fieldOf(company, 'political_donation_transparency'));
    case 20: { const f = fieldOf(company, 'countries_of_concern_operations'); return !hasNoData(f) && Array.isArray(f.value); }
    case 21: { const f = fieldOf(company, 'data_privacy_practices'); return !hasNoData(f) && typeof f.value === 'object' && typeof f.value.item_1_05_incident_count === 'number'; }
    case 22: return true; // domestic HQ -- hq_country is always populated, real identity data
    case 23: { const fl = fieldOf(company, 'founder_led'); const fo = fieldOf(company, 'family_owned'); return !hasNoData(fl) || !hasNoData(fo); }
    case 24: return !!ctx.tiesSector; // inert for this question entirely when the client leaves it unset
    case 25: return !hasNoData(fieldOf(company, 'women_led'));
    default: return true;
  }
}

function unitHasData(unit, company, ctx) {
  return unit.ids.every((id) => questionHasData(id, company, ctx));
}

function unitAlignment(unit, company, ctx) {
  const sum = unit.ids.reduce((total, id) => total + ALIGNMENT_FNS[id](company, ctx), 0);
  return sum / unit.ids.length;
}

const HIGH_PRIORITY_THRESHOLD = 4; // client ratings of 4-5 count as "highest priority"
const CONFLICT_ALIGNMENT_THRESHOLD = -0.5; // a_i at or below this counts as a strong conflict
const MAX_PORTFOLIO_SIZE = 15;
// Raised 3 -> 5 on 2026-08-21 alongside the scoring formula recalibration
// (see unitImportance/MINIMUM_VALUES_MATCH comments and
// data/import_schema_comparison.md) -- simulated: at cap=3 even removing
// this limit entirely only reached ~48% universe reachability, so the cap
// alone was never the main constraint, but a modest loosening still helps
// on top of the formula fix (which did the real work) without abandoning
// sector diversification as a goal.
const MAX_PER_SECTOR = 5;

// Added 2026-08-22: a "who keeps showing up" simulation (3,000 random
// client profiles) found that companies with ZERO negative alignment
// across every values question they have real data for -- i.e. companies
// structurally immune to every exclusionary screen, simply by not being in
// a screened industry -- appeared in recommended portfolios 7.4x more
// often on average than every other company (45 of 502 companies, ~9% of
// the dataset, averaged a 14% appearance rate vs. 1.9% for everyone else).
// Ford Motor Company was the extreme case: it appeared in 75% of all
// simulated portfolios simply because no exclusionary question could ever
// score it negatively, regardless of what a given client said mattered.
// Fixed the same day with a flat penalty for zero-negative companies
// (5 -> 1.0x parity, +5pp reachability), which shipped and confirmed live.
//
// Revised later the same day: the flat version was a cliff -- a company
// with exactly ONE real negative (e.g. AMGN, NDAQ's elevated CEO pay
// ratio) got zero discount, so it could still dominate almost as much as
// a fully clean company used to. Replaced with a continuous discount (see
// overrepPenalty in scoreCompany below): OVERREP_MAX_PENALTY / (1 +
// negativeCount), so each additional real negative smoothly shrinks the
// discount instead of it vanishing entirely after the first one. Swept
// OVERREP_MAX_PENALTY across 8/12/16 (3,000-trial confirmation at 12):
// 12 was the best of the three -- zero companies left appearing in over
// half of all portfolios (the flat version still had 4) and the best
// universe reachability of anything tried (66.3%, vs 60.4% under the flat
// version, 50.8% before either fix). Bucketing appearance rate by real-
// negative-count at MAX_PENALTY=12 confirmed no group runs away with it
// (0 negatives: 2.6%, 1: 2.3%, 2: 3.8%, 3: 3.3%, 4+: 1.5%). Still does not
// touch valuesFitScore/meetsValuesFloor -- eligibility (and the Aug-21
// reachability fix) is untouched either way, only the ranking score is.
const OVERREP_MAX_PENALTY = 12;

// Judgment-based ESG scores are dampened by how well-documented they are,
// so a Low-confidence "safe" finding no longer counts the same as a
// High-confidence, verifiably-earned one. Objective facts (sin-stock
// flags, founder-led/family-owned booleans read directly, domestic-HQ,
// industry ties) are never dampened this way.
const CONFIDENCE_WEIGHT = { High: 1.0, Medium: 0.7, Low: 0.4, None: 0 };

function confidenceWeight(level) {
  return CONFIDENCE_WEIGHT[level] !== undefined ? CONFIDENCE_WEIGHT[level] : 1.0;
}

// --- Imported-dataset field helpers -----------------------------------
// Every ESG field in esg_dataset_sp500.json (see
// data/import_schema_comparison.md) is either absent, or an object of
// shape { value, source, source_url, confidence, notes, last_updated }.
// "No verifiable data found" (confidence "None") is the field's own
// explicit way of saying no source could answer it -- always neutral (0),
// never guessed at, matching every other "no data" case already in this
// scoring engine (analyst upside, 5-year return, etc.).

function fieldOf(company, key) {
  const f = company[key];
  return f && typeof f === 'object' ? f : null;
}

// fossilfreefunds.org (As You Sow)'s own named-list fossil-fuel screen,
// bundled per-company under additional_data_sources -- see
// carbonFossilFuelAlignment/renewableCleanTechAlignment below for why this
// is preferred over the plain 10-K keyword scan.
function fossilFuelScreen(company) {
  const sources = company.additional_data_sources;
  return sources && sources.fossil_fuel_screen ? sources.fossil_fuel_screen : null;
}

function hasNoData(f) {
  return !f || f.confidence === 'None' || f.value === 'No verifiable data found' || f.value === undefined || f.value === null;
}

const LEVEL_EXCLUSIONARY = { High: -1, Medium: -0.5, Low: 0 };
const LEVEL_PREFERENCE = { High: 1, Medium: 0.5, Low: 0 };

// Generic enum (High/Medium/Low/None) field -> alignment, with confidence
// weighting applied from the same field's own confidence rating.
function enumFieldAlignment(company, key, table) {
  const f = fieldOf(company, key);
  if (hasNoData(f)) return 0;
  const raw = table[f.value] !== undefined ? table[f.value] : 0;
  return raw * confidenceWeight(f.confidence);
}

function booleanFieldAlignment(company, key, direction) {
  const f = fieldOf(company, key);
  if (hasNoData(f)) return 0;
  if (f.value !== true) return 0;
  return direction * confidenceWeight(f.confidence);
}

function parseUsdString(s) {
  if (typeof s !== 'string') return null;
  const digits = s.replace(/[^0-9.]/g, '');
  const n = parseFloat(digits);
  return Number.isFinite(n) ? n : null;
}

// Q1/Q2: business-description keyword-scan involvement level -- with a real
// problem uncovered by a client's own results: the two scans run
// independently over the same 10-K "Item 1 Business" text, so a huge share
// of energy/utility companies get flagged "High" on BOTH carbon involvement
// AND clean-tech involvement at once (confirmed in this dataset for
// Chevron, First Solar, NextEra Energy, Constellation Energy, and Vistra
// alike), which canceled a client's avoid-fossil and prefer-clean-tech
// answers against each other for exactly the companies where they should
// matter most -- while the same keyword scan sometimes finds nothing at all
// (ExxonMobil's 10-K couldn't be fetched, so it scored a fully unpenalized
// neutral despite being a fossil-fuel major).
//
// Q1 now prefers fossilfreefunds.org's own named-list fossil-fuel screen
// (bundled per-company under additional_data_sources.fossil_fuel_screen,
// see fossilFuelScreen above) when present: it's far more precise (53 real
// matches across the S&P 500 vs. the keyword scan's 228 "High" flags,
// confirmed against this dataset directly) and covers 497 of 502 companies,
// including ExxonMobil, where the keyword scan has nothing. The keyword
// scan is only a fallback for the handful of companies missing it.
//
// Q2 still has to lean on the keyword scan -- the named-list screen is
// fossil-only, it never confirms a company IS clean energy -- but now
// withholds credit whenever that same company is confirmed fossil-involved
// by the more reliable screen, so a real fossil-fuel company's boilerplate
// climate-risk language can no longer buy back the penalty it just earned.
function carbonFossilFuelAlignment(company) {
  const screen = fossilFuelScreen(company);
  if (screen && typeof screen.involved === 'boolean') {
    if (!screen.involved) return 0;
    return LEVEL_EXCLUSIONARY.High * confidenceWeight(screen.confidence);
  }
  return enumFieldAlignment(company, 'carbon_fossil_fuel_involvement', LEVEL_EXCLUSIONARY);
}
function renewableCleanTechAlignment(company) {
  const screen = fossilFuelScreen(company);
  if (screen && screen.involved === true) return 0;
  return enumFieldAlignment(company, 'renewable_clean_tech_involvement', LEVEL_PREFERENCE);
}

// Q3: real EPA ECHO enforcement data (total penalties), not a keyword scan.
function pollutionViolationsAlignment(company) {
  const f = fieldOf(company, 'environmental_pollution_violations');
  if (hasNoData(f) || typeof f.value !== 'object') return 0;
  const penalties = parseUsdString(f.value.total_penalties_usd);
  if (penalties === null || penalties <= 0) return 0;
  let raw = -1;
  if (penalties < 1e6) raw = -0.3;
  else if (penalties < 1e7) raw = -0.6;
  return raw * confidenceWeight(f.confidence);
}

function sustainableAgAlignment(company) {
  return enumFieldAlignment(company, 'sustainable_agriculture_resource_use', LEVEL_PREFERENCE);
}
function fairWagesAlignment(company) {
  return enumFieldAlignment(company, 'fair_wages_labor_practices', LEVEL_PREFERENCE);
}

// Q6: NLRB case search is blocked in the source pipeline's environment for
// nearly every company (see data/import_schema_comparison.md), so this is
// almost always neutral in practice -- real when present.
function laborDisputesAlignment(company) {
  const f = fieldOf(company, 'labor_disputes_exploitation_history');
  if (hasNoData(f) || typeof f.value !== 'object') return 0;
  const count = f.value.case_count;
  if (typeof count !== 'number' || count <= 0) return 0;
  const raw = count <= 2 ? -0.3 : count <= 5 ? -0.6 : -1;
  return raw * confidenceWeight(f.confidence);
}

function diversityAlignment(company) {
  return enumFieldAlignment(company, 'workplace_diversity_equity_inclusion', LEVEL_PREFERENCE);
}

// Q8: OSHA-matched establishment row count, not a confirmed-violation
// count (the source dataset's own caveat) -- deliberately conservative.
function workerSafetyAlignment(company) {
  const f = fieldOf(company, 'worker_safety_record');
  if (hasNoData(f) || typeof f.value !== 'object') return 0;
  const rows = f.value.matched_establishment_rows;
  if (typeof rows !== 'number') return 0;
  const raw = rows === 0 ? 0.5 : rows <= 2 ? 0.25 : 0;
  return raw * confidenceWeight(f.confidence);
}

function boardIndependenceAlignment(company) {
  const f = fieldOf(company, 'board_transparency_independence');
  if (hasNoData(f) || typeof f.value !== 'object') return 0;
  const pct = f.value.pct_independent_directors;
  if (typeof pct !== 'number') return 0;
  const raw = pct >= 80 ? 1 : pct >= 50 ? 0.5 : 0;
  return raw * confidenceWeight(f.confidence);
}

function ceoPayRatioAlignment(company) {
  const f = fieldOf(company, 'ceo_pay_ratio');
  if (hasNoData(f) || typeof f.value !== 'number') return 0;
  const ratio = f.value;
  let raw = 0;
  if (ratio > 600) raw = -1;
  else if (ratio > 300) raw = -0.6;
  else if (ratio > 100) raw = -0.3;
  return raw * confidenceWeight(f.confidence);
}

// Q11: value shape is inconsistent across companies in the source dataset
// (documented case_count/description per its own schema doc, but real
// records like Apple's instead carry a raw, unfiltered
// full_text_search_hits count its own README calls "not confirmed
// litigation releases") -- only the documented case_count shape is scored;
// an unrecognized shape contributes nothing rather than guessing.
function fraudScandalAlignment(company) {
  const f = fieldOf(company, 'fraud_corruption_scandal_history');
  if (hasNoData(f) || typeof f.value !== 'object') return 0;
  const caseCount = f.value.case_count;
  if (typeof caseCount !== 'number') return 0;
  const raw = caseCount <= 0 ? 0 : caseCount <= 2 ? -0.4 : -0.8;
  return raw * confidenceWeight(f.confidence);
}

function votingStructureAlignment(company) {
  const f = fieldOf(company, 'shareholder_rights_voting_structure');
  if (hasNoData(f)) return 0;
  const raw = f.value === 'multi_class' ? -1 : f.value === 'dual_class' ? -0.7 : 0;
  return raw * confidenceWeight(f.confidence);
}

function interestBasedFinanceAlignment(company) {
  return booleanFieldAlignment(company, 'interest_based_financial_products', -1);
}

function politicalDonationAlignment(company) {
  const f = fieldOf(company, 'political_donation_transparency');
  if (hasNoData(f)) return 0;
  const raw = f.value === 'Disclosed' ? 1 : f.value === 'Partial' ? 0.5 : 0;
  return raw * confidenceWeight(f.confidence);
}

function countriesOfConcernAlignment(company) {
  const f = fieldOf(company, 'countries_of_concern_operations');
  if (hasNoData(f) || !Array.isArray(f.value)) return 0;
  const raw = f.value.length > 0 ? -1 : 0;
  return raw * confidenceWeight(f.confidence);
}

function dataPrivacyAlignment(company) {
  const f = fieldOf(company, 'data_privacy_practices');
  if (hasNoData(f) || typeof f.value !== 'object') return 0;
  const count = f.value.item_1_05_incident_count;
  if (typeof count !== 'number') return 0;
  const raw = count === 0 ? 1 : 0.3;
  return raw * confidenceWeight(f.confidence);
}

// Q22 (domestic HQ): deliberately reads the site's own hq_country string
// (real, address-derived data already on every company) and compares it
// against the client's OWN chosen home-country text input, rather than the
// imported dataset's domestic_hq boolean (which is fixed relative to the
// United States only) -- the live site lets a client set a home country
// other than the US, which the imported field can't support. See
// data/import_schema_comparison.md.
function domesticHqAlignment(company, ctx) {
  return company.hq_country && company.hq_country.startsWith(ctx.homeCountry) ? 1 : 0;
}

// Q23 (founder-led/family-owned): per the 2026-08-21 import, sourced from
// the imported dataset's founder_led/family_owned fields (a more
// extensively-validated, name-anchored pipeline -- see
// data/import_schema_comparison.md for why this supersedes this repo's
// own prior remediation pass on the same two fields).
function founderFamilyAlignment(company) {
  const fl = fieldOf(company, 'founder_led');
  const fo = fieldOf(company, 'family_owned');
  const flTrue = fl && fl.value === true;
  const foTrue = fo && fo.value === true;
  if (!flTrue && !foTrue) return 0;
  const relevant = flTrue ? fl : fo;
  return 1 * confidenceWeight(relevant.confidence);
}

function industryTieAlignment(company, ctx) {
  return ctx.tiesSector && company.sector === ctx.tiesSector ? 1 : 0;
}

function womenLedAlignment(company) {
  return booleanFieldAlignment(company, 'women_led', 1);
}

const ALIGNMENT_FNS = {
  1: carbonFossilFuelAlignment,
  2: renewableCleanTechAlignment,
  3: pollutionViolationsAlignment,
  4: sustainableAgAlignment,
  5: fairWagesAlignment,
  6: laborDisputesAlignment,
  7: diversityAlignment,
  8: workerSafetyAlignment,
  9: boardIndependenceAlignment,
  10: ceoPayRatioAlignment,
  11: fraudScandalAlignment,
  12: votingStructureAlignment,
  13: (c) => booleanFieldAlignment(c, 'tobacco_involvement', -1),
  14: (c) => booleanFieldAlignment(c, 'alcohol_involvement', -1),
  15: (c) => booleanFieldAlignment(c, 'gambling_casino_involvement', -1),
  16: (c) => booleanFieldAlignment(c, 'weapons_defense_involvement', -1),
  17: (c) => booleanFieldAlignment(c, 'adult_entertainment_involvement', -1),
  18: interestBasedFinanceAlignment,
  19: politicalDonationAlignment,
  20: countriesOfConcernAlignment,
  21: dataPrivacyAlignment,
  22: domesticHqAlignment,
  23: founderFamilyAlignment,
  24: industryTieAlignment,
  25: womenLedAlignment,
};

// Q26 (stability-over-growth). Unchanged from v2's Q21.
const NEUTRAL_BETA = 1.0; // ~market-average volatility
const BETA_SWING = 1.0; // beta this far from neutral in either direction reaches ±1
function stabilityDirectAlignment(company) {
  const beta = company.market_profile.beta_est;
  if (beta === null || beta === undefined) return 0;
  return Math.max(-1, Math.min(1, (NEUTRAL_BETA - beta) / BETA_SWING));
}

// Q29 (dividend-income preference). DIVIDEND_YIELD_RANK (defined below,
// reused here) treats "Low" as the neutral center: a non-payer is actively
// penalized, a high-yield payer is actively rewarded, exactly matching the
// "preference for dividend-paying income stocks over growth-focused
// reinvestment" framing. Restored 2026-08-21, unchanged from v2's Q24.
function dividendDirectAlignment(company) {
  const rank = dividendYieldRank(company.dividend_policy);
  return Math.max(-1, Math.min(1, (rank - 2) / 2));
}

// Q28 (blue-chip preference). MARKET_CAP_RANK (defined below, reused
// here): Mega/Large rewarded, Mid/Small penalized, centered between Large
// and Mid. This is the *soft* blue-chip preference (ratings 1-4); a rating
// of 5 is instead a hard filter -- see isBlueChipEligible. Restored
// 2026-08-21, unchanged from v2's Q23.
function blueChipDirectAlignment(company) {
  const rank = MARKET_CAP_RANK[company.market_profile.market_cap_tier];
  if (rank === undefined) return 0;
  return Math.max(-1, Math.min(1, (rank - 1.5) / 1.5));
}

// Blue-chip question at 5/5 is a hard pre-filter (see buildPortfolio); 1-4
// don't filter anything. Restored 2026-08-21, unchanged from v2's
// Q23/isBlueChipEligible.
function isBlueChipEligible(company, answers) {
  const blueChipRating = answers[28] || 3;
  if (blueChipRating < 5) return true;
  return company.market_profile.market_cap_tier === 'Mega';
}

const RISK_ALIGNMENT_FNS = {
  26: stabilityDirectAlignment,
  28: blueChipDirectAlignment,
  29: dividendDirectAlignment,
};

function scoreCompany(company, answers, ctx, riskProfile) {
  let numerator = 0;
  let denominator = 0;
  const alignments = {};

  SCORING_UNITS.forEach((unit) => {
    const hasData = unitHasData(unit, company, ctx);
    const importance = hasData ? unitImportance(unit, answers) : 0;
    const alignment = unitAlignment(unit, company, ctx);
    unit.ids.forEach((id) => { alignments[id] = alignment; });
    numerator += importance * alignment;
    denominator += importance;
  });

  // Financial quality as one more weighted criterion (see header comment).
  // Importance driven by the values-over-returns question (id 27).
  const financialImportance = 6 - (answers[27] || 3);
  const financialAlignment = financialQualityAlignment(company, riskProfile, ctx.timeHorizon);
  numerator += financialImportance * financialAlignment;
  denominator += financialImportance;

  // Risk/portfolio-construction trade-off terms (stability, blue-chip,
  // dividend-income) — rating-1 importance mapping so a rating of 1 is a
  // true no-op (see header comment).
  RISK_DIRECT_QUESTION_IDS.forEach((qId) => {
    const importance = Math.max(0, (answers[qId] || 3) - 1);
    const alignment = RISK_ALIGNMENT_FNS[qId](company);
    alignments[qId] = alignment;
    numerator += importance * alignment;
    denominator += importance;
  });

  // The values-over-returns question's second role: reward weaker
  // financial-quality companies (a real "prioritize values over financial
  // strength" nudge), same rating-1 mapping so it never penalizes a strong
  // company when that rating is 1.
  const valuesOverReturnsImportance = Math.max(0, (answers[27] || 3) - 1);
  const valuesOverReturnsAlignment = 1 - 2 * financialAlignment;
  numerator += valuesOverReturnsImportance * valuesOverReturnsAlignment;
  denominator += valuesOverReturnsImportance;

  // Over-representation dampener (see OVERREP_MAX_PENALTY above): count how
  // many values questions a company has real data on AND scores negatively.
  // A company with real data on a question is only immune to that specific
  // exclusionary screen if it's not the target of it -- companies with
  // fewer real negatives are, on average, more likely to be structurally
  // immune across the board, so the discount decays smoothly as the real-
  // negative count rises instead of vanishing entirely after the first one.
  // Eligibility (valuesFitScore/meetsValuesFloor) deliberately does not use
  // this -- only the blended ranking score does.
  let negativeCount = 0;
  SCORED_QUESTION_IDS.forEach((qid) => {
    if (questionHasData(qid, company, ctx) && alignments[qid] < 0) negativeCount += 1;
  });
  const overrepPenalty = OVERREP_MAX_PENALTY / (1 + negativeCount);

  const raw = (denominator > 0 ? 50 + 50 * (numerator / denominator) : 50) - overrepPenalty;
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

// Values-only score -- the confidence-weighted formula over
// SCORED_QUESTION_IDS alone, before financial quality is folded into the
// same weighted sum. Deliberately excludes financial quality AND the
// risk/portfolio-construction trade-off terms so a company can't buy its
// way past a genuine values mismatch with good financials or a risk-
// profile match -- this is what the minimum values match floor
// (MINIMUM_VALUES_MATCH below) is evaluated against, not the blended score
// scoreCompany() returns for ranking.
function valuesFitScore(company, answers, ctx) {
  let numerator = 0;
  let denominator = 0;
  SCORING_UNITS.forEach((unit) => {
    const hasData = unitHasData(unit, company, ctx);
    const importance = hasData ? unitImportance(unit, answers) : 0;
    const alignment = unitAlignment(unit, company, ctx);
    numerator += importance * alignment;
    denominator += importance;
  });
  const raw = denominator > 0 ? 50 + 50 * (numerator / denominator) : 50;
  return Math.round(Math.min(100, Math.max(0, raw)));
}

// Recalibrated 54 -> 52 on 2026-08-21, alongside the unitImportance
// formula change above (see that comment and
// data/import_schema_comparison.md "Scoring formula recalibration" for the
// full simulation). The prior value (54) was tuned against the old
// placeholder-ESG dataset where every company scored near-identically;
// once real per-company data landed, simulation showed the floor was NOT
// the actual bottleneck on how much of the S&P 500 could ever appear in a
// recommendation (dropping it all the way to 42 barely moved the needle,
// 34.7% -> ~40%) -- the flat linear weighted-average formula was doing the
// real damping, addressed above. This modest floor reduction, combined
// with the formula fix and MAX_PER_SECTOR's widening, raises universe
// reachability to ~48% in simulation while keeping the floor's original
// purpose intact: requiring genuine positive alignment, not just "not
// disqualified" -- a company still cannot clear it on financial strength
// alone (financial quality is excluded from valuesFitScore by design, see
// that function).
const MINIMUM_VALUES_MATCH = 52;

function meetsValuesFloor(company, answers, ctx) {
  return valuesFitScore(company, answers, ctx) >= MINIMUM_VALUES_MATCH;
}

// Purely descriptive (see header comment "Risk preferences") — shown to
// the client as a summary label ("Your Risk Profile") and used to shape
// financialQualityAlignment's formula. Averages the 4 inverted risk-
// question answers (stability, values-over-returns, blue-chip, dividend-
// income; ids 26-29) into a single growth-orientation axis.
function deriveRiskProfile(answers) {
  const growthAxisValues = [26, 27, 28, 29].map((qId) => 6 - (answers[qId] || 3));
  const avg = growthAxisValues.reduce((sum, v) => sum + v, 0) / growthAxisValues.length;
  if (avg <= 2.3) return 'Conservative';
  if (avg <= 3.7) return 'Balanced';
  return 'Growth';
}

function classifyTier(alignments, answers) {
  const conflicts = [];
  SCORING_UNITS.forEach((unit) => {
    const rawRating = unitRawRating(unit, answers);
    if (rawRating >= HIGH_PRIORITY_THRESHOLD && alignments[unit.ids[0]] <= CONFLICT_ALIGNMENT_THRESHOLD) {
      conflicts.push(unit);
    }
  });
  return { tier: conflicts.length > 0 ? 'Partial' : 'Strong', conflicts };
}

function buildPartialMatchNote(conflicts) {
  const labels = conflicts.map((unit) => lowerFirst(unitLabel(unit)));
  if (labels.length === 1) return `Does not fully meet your preference for ${labels[0]}.`;
  const last = labels[labels.length - 1];
  const rest = labels.slice(0, -1);
  return `Does not fully meet your preferences for ${rest.join(', ')} and ${last}.`;
}

function lowerFirst(str) {
  return str.charAt(0).toLowerCase() + str.slice(1);
}

// Q27 ("willingness to accept lower returns for values alignment") is
// deliberately excluded from the candidate pool below -- it still
// contributes to the actual numeric score (see its dual role in
// scoreCompany), but naming it as a reason in the rationale sentence reads
// as circular ("this company scores well because you're willing to accept
// a lower score for it") rather than a real, legible reason the way every
// other candidate here is.
function buildRationale(alignments, answers, financialImportance, financialAlignment) {
  const candidates = SCORING_UNITS.map((unit) => ({
    label: unitLabel(unit),
    importance: unitRawRating(unit, answers),
    alignment: alignments[unit.ids[0]],
  }));
  candidates.push({ label: 'Strong financial fundamentals', importance: financialImportance, alignment: financialAlignment });
  RISK_DIRECT_QUESTION_IDS.forEach((qId) => {
    candidates.push({
      label: getQuestion(qId).short,
      importance: Math.max(0, (answers[qId] || 3) - 1),
      alignment: alignments[qId],
    });
  });

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

function noteMatches(note, regex) {
  return !!note && regex.test(note);
}

// Scans the same fields Q1/Q3, Q6, Q11-12, Q20 already score, for a
// company-facing "controversy" tie-breaker independent of the client's own
// answers (see sortScoredEntries). Not a re-scoring pass -- just counts how
// many of these distinct concern signals are actually present.
function controversyCount(company) {
  let count = 0;
  if (carbonFossilFuelAlignment(company) < 0) count += 1;
  if (pollutionViolationsAlignment(company) < 0) count += 1;
  if (laborDisputesAlignment(company) < 0) count += 1;
  if (fraudScandalAlignment(company) < 0) count += 1;
  if (votingStructureAlignment(company) < 0) count += 1;
  if (countriesOfConcernAlignment(company) < 0) count += 1;
  return count;
}

const MARKET_CAP_RANK = { Mega: 3, Large: 2, Mid: 1, Small: 0 };

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

// The client's selected time horizon picks which return field is used; the
// client's derived Risk Profile still decides how that return is weighted
// against beta/cap/dividends. This is one of the 9 metrics averaged into
// financialQualityAlignment below, not a separate score.
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
  const { score, alignments, financialImportance, financialAlignment } = scoreCompany(company, answers, ctx, riskProfile);
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
    rationale: buildRationale(alignments, answers, financialImportance, financialAlignment),
    note: conflicts.length > 0 ? buildPartialMatchNote(conflicts) : null,
    controversyCount: controversyCount(company),
  };
}

// Strong before Partial before Below Values Threshold as a hard rule; score
// orders within a tier; then controversy count / ticker as successive
// tie-breakers.
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

// The full ranked candidate list a portfolio draws from: values-floor
// primary candidates first (tier/score sorted), then below-threshold
// backfill candidates in the same order buildPortfolio() below fills from.
// Exposed separately from buildPortfolio() so the Results screen's manual
// remove/repopulate controls (js/app.js) can find the next-best qualified
// replacement using this exact same ranking, rather than a second,
// possibly-diverging notion of "next best."
function buildScoredCandidatePool(dataset, answers, clientContext) {
  const ctx = {
    homeCountry: (clientContext && clientContext.homeCountry) || 'United States',
    tiesSector: (clientContext && clientContext.tiesSector) || null,
    timeHorizon: (clientContext && clientContext.timeHorizon) || 'long',
  };
  const riskProfile = deriveRiskProfile(answers);

  // Blue-chip preference (id 28) at 5/5 is a hard, non-negotiable
  // pre-filter -- smaller companies are excluded outright, never
  // backfilled/relaxed, since "only suggest blue-chip" should mean
  // literally that. Ratings 1-4 don't filter anything: they're a soft,
  // graded preference instead (see blueChipDirectAlignment above).
  const blueChipEligible = dataset.companies.filter((company) => isBlueChipEligible(company, answers));

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

  return { riskProfile, pool: [...primaryCandidates, ...backfillCandidates] };
}

function buildPortfolio(dataset, answers, clientContext) {
  const { riskProfile, pool } = buildScoredCandidatePool(dataset, answers, clientContext);

  const sectorCounts = {};
  const selected = [];
  fillFromCandidates(pool, selected, sectorCounts);

  const allocationPct = selected.length > 0 ? 100 / selected.length : 0;
  selected.forEach((entry) => {
    entry.allocationPct = allocationPct;
  });

  return { riskProfile, holdings: selected };
}
