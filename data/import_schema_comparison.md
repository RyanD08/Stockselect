# Schema comparison: incoming data-mining dataset vs. live site (2026-08-21)

Source: `RyanD08/stock-select-data-mine` @ `24e1a1a6a020136ca5bb1d21bf03628a54de96ee`,
copied into this repo as `data/incoming_sp500_dataset.json` /
`data/incoming_company_schema.json` / `data/incoming_candidate_additional_criteria.json`
(not live yet -- see `data/backups/*pre_import*` for the pre-import snapshot).

## Top-level shape mismatch

- Incoming: a bare JSON **array** of 503 company objects.
- Live: `{ meta, companies: [...] }` object, 497 companies.
- Every scored field on the incoming side is an object
  `{ value, source, source_url, confidence, notes, last_updated }`.
- The live site's ESG fields are nested by category
  (`esg_ratings.environmental.{score,confidence,note}`, etc.) -- a
  different shape entirely, not just different field names.

## Question count / structure

Live site today: **25 questions** (24 rated + 1 time-horizon select), 6
categories (Environmental, Social/Labor, Governance, Ethical/Sin Stock,
Community/Identity, Risk Philosophy).

Incoming dataset's own canonical schema (`schema/company_schema.json`):
**27 official questions** + an unofficial `women_led` addition = 28, across
**8** categories -- it adds two the live site doesn't have at all
(**Religious Values**, **Political/Social**) and restructures two others.

Per explicit user decision (2026-08-21, "Full structural adoption"), the
live site is being restructured to match the incoming schema's 28-question
model exactly, using the incoming repo's own Q-numbering as the site's new
canonical numbering. This requires more than the two changes the task
brief named explicitly (remove animal testing, add women-led) --
reconciling to exactly 28 also means:

- **Dropped as separate rated questions**: "preferring primarily domestic
  revenue" (old Q20 -- merged into the incoming schema's single
  `domestic_hq` concept), "preference for large/blue-chip companies" (old
  Q23), "preference for dividend-paying income stocks" (old Q24), and
  **"avoiding companies with high financial leverage/debt levels" (old
  Q10, in the live site's Governance category)** -- found only after the
  rewrite was already done, while checking for orphaned `financial_leverage`
  references in the new scoring.js (there were none: the fresh rewrite
  simply never included a leverage question, since the incoming schema's
  Governance section (board independence, CEO pay ratio, fraud, voting
  structure) has no leverage concept at all). None of these four have a
  counterpart in the incoming schema's Risk Philosophy section, which only
  defines 2 items (stability-over-growth, values-over-returns), not the
  live site's current 4, or in its Governance section.
- The underlying scoring code for the three dropped questions
  (`blueChipDirectAlignment`, `dividendDirectAlignment`,
  `isBlueChipEligible`'s hard blue-chip filter, and the domestic-revenue
  `revenue_geography` question function) is removed from `js/scoring.js`
  rather than left as dead code, per this project's own conventions. All
  of it is recoverable from git history (this repo's own prior commits)
  if these are wanted back as bonus questions beyond the 28.
- `revenue_geography` data itself (real per-company domestic-revenue %,
  from this session's earlier SEC EDGAR remediation pass) is **not**
  deleted from `esg_dataset_sp500.json` -- just no longer tied to its own
  survey question, consistent with "don't silently drop fields, just
  don't wire them to a live question without being asked."

Final 28-question / 8-category list (new canonical IDs) is in
`js/questions.js`'s header comment.

## New fields with no live-site counterpart, and how each is handled

| Incoming field | New question | Handling |
|---|---|---|
| `board_transparency_independence` | Q9 | New exclusionary/preference fn reading `.value.pct_independent_directors` or the "No verifiable data found" fallback |
| `ceo_pay_ratio` | Q10 | New fn, threshold-banded on the numeric ratio |
| `shareholder_rights_voting_structure` | Q12 | Replaces the live site's own dual-class detection (this session's earlier `additional_data_sources.share_class_structure`) with the incoming dataset's `single_class`/`dual_class`/`multi_class` enum -- both were SEC-cover-page-sourced; the incoming one is used going forward since it's the actively-maintained pipeline |
| `religious_investment_compliance` | Q18 | Always `"No verifiable data found"` per the incoming dataset's own note ("no comprehensive free public halal/kosher screening database exists at scale") -- wired as a real question that will simply always score neutral (0) for every company, exactly like other null-data fields elsewhere in this scoring engine (analyst upside, 5yr return) |
| `interest_based_financial_products` | Q19 | New boolean exclusionary fn |
| `political_donation_transparency` | Q20 | New preference fn (enum, defensively handling the "No verifiable data found" string the actual data uses instead of the schema doc's stated `None` enum value -- see "Data-quality issues" below) |
| `countries_of_concern_operations` | Q21 | New exclusionary fn, array non-empty = concern |
| `data_privacy_practices` | Q22 | New preference fn on `.value.item_1_05_incident_count` |
| `women_led` | Q26 | New preference fn, boolean |

`fraud_corruption_scandal_history` (Q11) and `environmental_pollution_violations`/
`labor_disputes_exploitation_history`/`worker_safety_record` (Q3/Q6/Q8) all
carry object-shaped values with inconsistent internal keys across companies
(see below) -- each has a defensive fn that treats an unrecognized shape as
neutral rather than guessing.

## Data-quality issues found in the incoming dataset (documented, not silently worked around)

1. **`gics_sector` is blank for all 503 companies** (`gics_sub_industry` is
   fully populated). Root cause identified in
   `scripts/fetch_sp500_list.py:97` (a Wikipedia column-name lookup that
   isn't matching). **Not fixed in the incoming repo** (out of scope, a
   different repo). **Handling: the live site's existing, already-correct
   `sector` field (SIC-code-derived) is kept and NOT overwritten** by the
   incoming dataset's blank value. This also preserves the Q25 (industry
   personal-tie) matching and the portfolio builder's sector-diversification
   cap, both of which depend on a real sector value.
2. **`fraud_corruption_scandal_history`'s actual value shape doesn't match
   its own schema doc.** `schema/company_schema.json` documents `{
   case_count, description }`; the real data (e.g. AAPL) instead has `{
   full_text_search_hits: 1503 }` -- a raw, unfiltered EDGAR full-text
   search hit count the incoming repo's own README calls "not confirmed
   litigation releases." Handled defensively (checks for known keys,
   never assumes a shape) and dampened via the field's own `confidence:
   "Low"` rather than trusted as a strong signal.
3. **`political_donation_transparency`'s actual value is sometimes the
   string `"No verifiable data found"`**, not one of the schema doc's
   stated enum values (`Disclosed | Partial | None`). Handled by treating
   any unrecognized string as the neutral/no-data case.
4. **Company-set delta vs. the live site's 497** (503 incoming, both counts
   include a few real dual-share-class pairs):
   - **Genuinely new companies** (real data, no live financial-dataset
     entry yet): APA (APA Corporation), BF-B (Brown-Forman), HONA
     (Honeywell Aerospace -- a 2026 spinoff from Honeywell International,
     which itself is still present as HON), RDDT (Reddit), VMRK (Vivmark
     Residential). **Added to the merged ESG dataset**; their financial
     fields will be genuinely blank on the live site until a financial-data
     refresh covers them (not fabricated -- see merge log).
   - **Duplicate share-class tickers of an already-represented company**:
     FOX (Fox Corp Class B, already represented via FOXA), GOOG (Alphabet
     Class C, already represented via GOOGL), NWS (News Corp Class B,
     already represented via NWSA). **Excluded** from the merged company
     list (one row per company, matching the live site's existing
     convention) -- logged, not silently dropped.
   - **Present live, absent from the incoming dataset**: AVB (AvalonBay
     Communities), EQR (Equity Residential). Given no confirmation these
     actually exited the S&P 500 (vs. an incoming-side omission), **both
     are kept** on the live site with their prior ESG data untouched, not
     dropped, per the task's explicit "do not silently drop companies" rule.

## Financial-data preservation (Step 4 rule)

The incoming dataset has **zero** financial/market fields of any kind -- no
P/E, PEG, market cap, beta, dividend yield, analyst consensus/upside, or
returns (confirmed: its own README states Finnhub/Alpha Vantage/Stooq were
all unavailable from its environment). This means the "keep existing value
unless the new dataset has a real one" rule has nothing to actually
resolve for `financial_metrics`/`market_profile`/`dividend_policy`/
`financial_leverage` -- `data/financial_dataset_sp500.json` is carried
forward **completely unchanged**.

`performance_tier.growth_potential`/`stability` (flagged in the task brief
as needing a confirm-before-deciding call): the incoming dataset computes
its own version of these from revenue growth + D/E + dividend consistency,
explicitly *without* beta (blocked in its environment). The live site's
existing version already incorporates real Finnhub beta data. Decision:
**keep the live site's existing, beta-informed growth_potential/stability**
rather than replace with the incoming (beta-less) version -- the incoming
one is not clearly better-sourced, it's missing an input the live site
already has.

## Post-import follow-up: Risk Philosophy restored (2026-08-21, same day)

After the import landed live, the client asked to revert Risk Philosophy
specifically to its pre-import state, using the financial data already on
every company (this data was never touched by the ESG import in the first
place). Reinstated: "preference for large, established blue-chip companies"
(Q29) and "preference for dividend-paying income stocks" (Q30), with their
original scoring mechanics (`blueChipDirectAlignment`,
`dividendDirectAlignment`, `isBlueChipEligible`'s hard pre-filter at rating
5) restored verbatim in `js/scoring.js`, and `deriveRiskProfile` reverted
to averaging all 4 risk questions (was briefly 2). Appended as new ids 29
(blue-chip) and 30 (dividend-income) rather than reclaiming their original
23/24 slots, so nothing else in the 1-28 range needed renumbering; the
horizon selector shifted from id 29 to 31. Net effect: the site now has 30
rated questions (not the imported schema's own 28) -- a deliberate,
client-requested deviation from the incoming schema, not an oversight.
Everything else from the import (the 28-question ESG restructure, the two
new categories, animal testing removed, women-led added, the merged ESG
dataset) is unchanged.

## Merge conflict log

See `data/merge_conflict_log.json`, written by `scripts/merge_incoming_esg_dataset.py`
-- one entry per company/field where both the live ESG dataset and the
incoming dataset had a real (non-null, non-placeholder) value, listing both
values and which one won and why.
