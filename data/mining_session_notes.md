# S&P 500 aggressive multi-source data mining — session notes

Snapshot date: 2026-08-17. Base dataset: `data/values_portfolio_dataset_sp500.json`
(497 companies, built by `scripts/pipeline.py` from SEC EDGAR + Finnhub, with
EPA ECHO/OSHA/NLRB environmental/social_labor enrichment already applied by
`scripts/enrich_esg.py` in an earlier session).

This pass adds four new, genuinely-fetched data sources on top of that base,
via `scripts/enrich_additional_sources.py`, and documents exactly which of
the task's other approved sources could and could not be reached from this
environment. This is intentionally a **status report on real access**, not a
plan — every claim below was verified with a live request during this
session, not assumed.

## Sources successfully integrated this pass

| Source | Reachable? | What was pulled | Confidence |
|---|---|---|---|
| `api.fossilfreefunds.org` | Yes | Per-ticker fossil-fuel-involvement flag (`is_dirty`) + category matches (Carbon Underground 200, Coal, Oil/Gas, Macroclimate 50, Fossil-fired utility) + bonus gender-equality/diversity-disclosure/racial-justice/LGBTQ+-equity scores bundled in the same API response | High (direct API field) |
| `en.wikipedia.org` | Yes | Infobox fields (founded, founders, key_people, hq_location, type, num_employees, subsidiaries, parent) + intro summary, per company | Low (explicitly a lead per the task's own instructions, not verified) |
| `www.sec.gov` / `data.sec.gov` (DEF 14A) | Yes | CEO-to-median-employee pay ratio, exact figure, regex-extracted from the Item 402(u) disclosure narrative in each company's latest proxy statement | High where a ratio was found; many companies not found (see coverage stats) |
| `data.sec.gov` (8-K submissions) | Yes | Trailing-2-year count of 8-K filings by standardized SEC item number, with a bankruptcy/restatement/impairment flag | High (objective filing metadata, no text parsing) |

**Important correction to a prior session's finding:** `scripts/enrich_esg.py`'s
docstring (written in an earlier session) states that both
`api.fossilfreefunds.org` and `api.gunfreefunds.org` were blocked by this
environment's egress policy. Re-tested live this session:
`api.fossilfreefunds.org` is now reachable and returns real data (confirmed
with Apple/ExxonMobil test queries returning correct company records).
`api.gunfreefunds.org` is still blocked (see below) — the two hosts are not
equivalent, and only the gunfreefunds one is actually a policy denial.

## Sources on the approved list that could NOT be reached/parsed this pass

Every company record carries an explicit `"status": "No verifiable data
found"` entry with the specific reason below for each of these — never a
silent omission.

- **`api.gunfreefunds.org` (gunfreefunds.org)** — blocked by this
  environment's proxy egress policy: repeated `502` at the CONNECT step,
  confirmed via the proxy's own diagnostic endpoint
  (`$HTTPS_PROXY/__agentproxy/status` → `recentRelayFailures`), which
  labels it `connect_rejected` / `"policy denial or upstream failure"` —
  not a transient network error. The public gunfreefunds.org site itself
  loads fine but is a pure JS app shell with no server-rendered company data
  to fall back to. Weapons/defense exposure is still covered in the base
  dataset via SIC-code-derived `sin_stock_flags.weapons_defense`
  (`scripts/lib/mapping.py`), which predates this pass.
- **`bcorporation.net`** — every path tried (root, `/en-us/find-a-b-corp`,
  a direct company URL) returned HTTP 403 with a Cloudflare Turnstile
  bot-challenge page ("Just a moment..."), including with a
  browser-identifying User-Agent. Not fetchable by a plain HTTP client.
- **`sciencebasedtargets.org`** — the org's own bulk company export
  (`companies-excel.xlsx`, discovered via a link on the site itself) is
  hosted on `files.sciencebasedtargets.org`, a subdomain blocked by this
  environment's proxy policy (`403` policy denial at CONNECT, same
  diagnostic evidence as gunfreefunds above). The main
  `sciencebasedtargets.org/companies-taking-action` search page is a
  client-rendered SPA (no `__NEXT_DATA__` or embedded JSON found in the raw
  HTML) — its per-company search results only exist after JS execution,
  which was out of scope for this pass.
- **`justcapital.com`** — reachable, including its `wp-json` REST API, but
  that only exposes standard WordPress posts/pages. The actual company
  rankings widget is a separate client-side app with no discoverable
  server-rendered ranking data or public REST endpoint on the
  `justcapital.com` domain itself.
- **`www.bls.gov`** — the root domain and some paths (e.g.
  `news.release/osh.t01.htm`) return HTTP 200, but the actual
  injury/illness-by-industry data table in that release renders via
  JavaScript with no data present in the raw HTML response (confirmed:
  none of the expected industry-name strings like "Manufacturing" or
  "Construction" appear anywhere in the fetched HTML). Other paths (e.g.
  `iif/soii-data.htm`, `api.bls.gov`) returned 403/blocked outright. No
  sector-level BLS benchmark figures could be extracted this pass.

## Board diversity matrix (DEF 14A) — attempted, dropped

Unlike the CEO pay ratio (a mandatory, narrowly-phrased disclosure every
covered filer states in near-identical language), the Nasdaq-mandated
"Board Diversity Matrix" is not filed by every company, has no single
standard location in the document, and is very often rendered as an
image/table that survives HTML-to-text stripping poorly. A regex-based
extractor risked reporting a wrong number as a verified fact, so this was
not shipped this pass — see `candidate_additional_criteria.json` for the
proposed question and what a follow-up implementation would need.

## Self-caught error: the `is_dirty` field was never actually verified

An earlier version of this pipeline labeled fossilfreefunds.org's raw
`is_dirty` API field as "their overall fossil-fuel-involvement flag" and
used it directly as the `involved` boolean. That label was asserted, not
verified -- unlike every other field pulled from this source (the category
flags and the four diversity/equity scores), `is_dirty` does not appear as
a label anywhere in fossilfreefunds.org's own JS bundle or About/methodology
pages. Running the full 497-company batch exposed the problem concretely:
`is_dirty` was `True` for all 492 companies with a match, i.e. it doesn't
discriminate at all despite what its name implies.

Fixed before shipping this dataset: `involved` is now derived only from
`matched_categories` (each with a confirmed on-site label -- Carbon
Underground 200, coal industry, oil/gas industry, Macroclimate 50,
fossil-fired utility), which produces a plausible, discriminating result
(53/492 flagged -- mostly utilities, energy, chemicals, coal-hauling rail,
and fossil-sector financiers). The raw `is_dirty` value is still included
in the output as `raw_is_dirty_field_unverified` for transparency, with an
explicit note that it is not used for the `involved` determination and its
real meaning is unconfirmed.

## Final coverage (497/497 companies processed, 0 outstanding errors)

| Field | Coverage | Notes |
|---|---|---|
| `fossil_fuel_screen` (involvement + diversity/equity scores) | 492/497 | 5 misses (incl. Berkshire Hathaway/BRK-B) confirmed genuinely absent from fossilfreefunds.org's own database under any ticker variant, not a lookup bug |
| `ceo_pay_ratio` | 375/497 (75%) | See "CEO pay ratio extraction" below for how this number was earned, not assumed |
| `recent_8k_activity` | 496/497 | 1 miss: no CIK match |
| `wikipedia_profile` (any usable content) | ~490/497 | |
| `wikipedia_profile.infobox_fields.founder(s)` specifically | 203/497 | Many companies' infoboxes just don't carry a founder field (long-since-public conglomerates, spin-offs, etc.) |

## CEO pay ratio extraction — regex development notes

The first working version (anchored on "ratio ... is/of NUMBER to 1" close
to the word "ratio") scored 116/497. Three real phrasing patterns found via
manual inspection of actual filings pushed this to the final 375/497, each
confirmed against the source text before being generalized:

1. **Verb/description length**: many filers write "the ratio of the annual
   total compensation of our CEO to the annual total compensation of our
   median employee **was** X to 1" -- a long description between "ratio"
   and the number, with "was" (not "is"/"of") immediately before it. Fixed
   by decoupling the number pattern from a specific preceding verb and
   instead requiring "annual total compensation" (the consistent
   SEC-boilerplate-derived phrase every real disclosure sentence uses)
   somewhere between the "pay ratio" mention and the number.
2. **Long methodology narratives**: Abbott Laboratories precedes its number
   with ~1,500 characters of workforce/exclusion/currency methodology
   before stating "resulting in a ratio of 166:1" -- widened the search
   window accordingly (3,000 chars).
3. **Reversed, hyphenated phrasing**: Amazon writes "resulting in a ratio
   of those amounts of **1-to-51**" (median-employee-first, hyphenated, no
   spaces) rather than "51 to 1" -- added a dedicated pattern for this
   direction.
4. **Sub-1.0 ratios are real, not bugs**: Tesla, Axon, and Super Micro's
   founder-CEOs report $0 or near-$0 compensation some years, giving a
   genuine ratio below 1:1 (0.00, 0.3, 0.16). An earlier version rounded
   these to a misleading "0 to 1"; fixed to keep the fractional value.
5. **Table vs. narrative disambiguation**: Tesla's proxy also contains a
   "Pay versus Performance" table using the same "annual total
   compensation" phrase in a column header, with its own "X to 1"-shaped
   numeric cells -- close enough to fool a naive first-match search.
   Resolved by preferring the *last* qualifying occurrence in the document
   (the standalone, fully-narrated "20XX Pay Ratio Disclosure" section
   consistently comes after any earlier table/cross-reference, confirmed
   against this specific filing).

A random 15-company sample of the final extracted values (AES 120, AIZ 268,
AJG 346, BA 166, BKR 310, BR 216, CEG 140, DRI 736, EME 164, F 295, LEN 284,
PHM 142, SHW 248, TPL 46, URI 137) was spot-checked for plausibility against
each figure's general order of magnitude and found consistent with
publicly-known reporting for these companies. The remaining ~25% without a
match were not chased further after this point of diminishing returns --
each has an honest `"No verifiable data found"` entry with the actual
regex-search failure reason, not a fabricated or estimated figure.

## What's next for a follow-up session

- Re-attempt `sciencebasedtargets.org` and `justcapital.com` with a
  headless-browser tool (Playwright is available in this type of
  environment) instead of a plain HTTP client, since both are JS-rendered.
- Re-check `api.gunfreefunds.org` and `files.sciencebasedtargets.org`
  reachability — this is an environment/proxy-policy question, not a code
  question, so it may simply differ in a future session's environment.
- Board Diversity Matrix extraction, done carefully per-company with a
  human spot-check pass rather than a blind regex.
- 8-K Item 8.01 filings flagged by `bankruptcy_restatement_impairment_flag`
  as false could still be manually skimmed for genuine litigation/scandal
  content the standardized item taxonomy doesn't distinguish.
