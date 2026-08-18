# Dataset remediation pass — governance, founder/family ownership, domestic revenue

Snapshot date: 2026-08-18. Base dataset: `data/sp500_full_dataset.json` (497
companies, as shipped by the prior mining pass — see
`data/mining_session_notes.md`).

This pass replaces four field groups that were 100% placeholder/never
populated, per the task brief:

1. `esg_ratings.governance` — was a 100%-identical placeholder note
   ("no live per-company ESG data source is available...") for all 497
   companies.
2. `founder_led` / `family_owned` — defaulted to `false` for all 497
   companies; never actually populated.
3. `revenue_geography.profile` — a sector-level heuristic default, not
   verified per-company.
4. `financial_metrics.analyst_price_target_upside_pct` /
   `performance_tier.five_year_annualized_return_pct_est` — **not** done
   this pass; see "What's still open" below.

Every number in this file was computed from the actual output of
`scripts/enrich_governance_revenue.py`'s real live run against SEC EDGAR
(`data/governance_revenue_enrichment.json`, 497/497 companies processed, 0
outstanding errors after one retry — see "Errors" below), not assumed.

## Sources named in the task brief, tested live, and their real reachability

| Source | Reachable? | Evidence |
|---|---|---|
| `violationtracker.goodjobsfirst.org` | **No** | HTTP 403, Cloudflare Turnstile bot-challenge page, on both the root site and a guessed `/api/v1/search` path |
| `securities.stanford.edu` | **No** | HTTP 403, same Cloudflare bot-challenge pattern |
| SEC Litigation Releases / Administrative Proceedings search | **No** | `sec.gov/litigation` itself loads (redirects to `/enforcement-litigation/litigation-releases`), but its search form posts to `secsearch.sec.gov` / `search.usa.gov` (a search.gov-powered widget), both blocked by this environment's proxy egress policy — `curl: (56) CONNECT tunnel failed, response 403` — the same policy-denial signature already documented for gunfreefunds.org/cii.org/bcorporation.net in `data/mining_session_notes.md`, not a transient failure. `efts.sec.gov` (EDGAR full-text search over *filings*) IS reachable, but litigation releases are a separate CMS-driven part of sec.gov, not an EDGAR filing, so it cannot search them. |
| `cii.org` (dual-class company list) | **No** | `curl: (56) CONNECT tunnel failed, response 403` — same proxy policy denial |
| `data.sec.gov` (DEF 14A, 10-K, XBRL Frames/companyconcept, FilingSummary.xml/R-files) | **Yes** | Used as the actual data source for all four fields below |
| `stooq.com` | **No** | Returns HTTP 200 but the response body is a JavaScript browser-verification challenge page, not CSV data — confirmed by inspecting the raw response (`(async()=>{const c="..."` obfuscated JS, no CSV content) |
| Finnhub / Alpha Vantage (5-year return, analyst price target) | **Blocked on API key** | Both require a free-tier signup key; none was configured in this environment. Per the user's explicit instruction this session, this pass proceeded WITHOUT signing up for either service using the user's email (a third-party account-creation action requiring the user's own consent) — deferred to a follow-up pass once a key is provided. |

Given the above, fields 1–3 fall back to the most authoritative source that
*was* actually reachable — SEC EDGAR itself — documented per-record with
exactly what was checked, never silently substituted.

## 1. Governance: dual-class share structure + fraud/enforcement signal

**Source used:** each company's most recent 10-K, two angles:
- **Share class structure** — the cover page's "Securities registered
  pursuant to Section 12(b) of the Act" table (a standardized, mandatory
  disclosure every registrant states). Counting 2+ distinct classes of
  common/capital/ordinary stock as dual-class is a High-confidence read
  directly off this table.
- **Fraud/enforcement signal** — Item 3 "Legal Proceedings" (Reg S-K Item
  103), following through to the referenced financial-statement note
  ("Legal Matters"/"Commitments and Contingencies") when Item 3 just
  incorporates it by reference, which is the normal case for large filers
  (confirmed on Alphabet's actual 10-K). Scanned for enforcement/fraud
  signal terms (consent decree, civil penalty, DOJ, antitrust, FCPA,
  class action, restatement, etc.) — presence of a term means the company
  itself disclosed a related matter, not a confirmed fraud finding.

**Coverage (497/497 attempted):**

| | Count |
|---|---|
| Dual-class structure confirmed | 12 |
| Single-class confirmed | 472 |
| Share-class structure not extractable | 13 |
| Adverse/enforcement signal found | 116 |
| "No adverse record found in available sources" | 364 |
| Legal-proceedings section not extractable | 17 |

**Known false-positive/false-negative fixed during development:** an early
version took the LAST case-insensitive match of "Item 3. Legal
Proceedings" as the real section, on the theory that the table of contents
is always first. This broke on Walmart's actual 10-K, which has a THIRD,
later, mixed-case cross-reference to the section from its own body text
("...described...under the caption 'Item 3. Legal Proceedings'"), sorting
after the real (ALL-CAPS) section header — the last-match search picked up
the cross-reference instead of the real content. Fixed by anchoring on the
last ALL-CAPS occurrence specifically (the real section header's actual
rendering convention in EDGAR 10-Ks), falling back to case-insensitive only
when no all-caps occurrence exists at all.

**Schema note:** `js/scoring.js` questions 8 and 9 both read
`esg_ratings.governance.note` with different trigger-word regexes (Q8:
`litigation|scandal|fraud|corruption|settlement|controvers|investigation`;
Q9: `dual-class|voting power|majority control|majority voting|significant
influence`). `scripts/merge_governance_revenue.py` builds one combined note
per company and self-checks it against both regexes before writing —
verified to fire on exactly the intended question for all 497 companies
(the merge script raises `AssertionError` and aborts if any note would
mis-fire, so this is enforced, not just claimed).

## 2. founder_led / family_owned

**Source used:** the Wikipedia founder/owner data already captured in this
dataset's `additional_data_sources.wikipedia_profile.infobox_fields`
(`founder`/`founders`, or `owner` as a fallback when corroborated by the
word "found..." near the same surname in the article's own summary text —
recovers real founder-controlled companies whose Wikipedia infobox uses
`owner` instead of `founder`, e.g. Oracle's `owner: "Larry Ellison
(42.4%)"` with no `founder` field at all), cross-referenced against the
DEF 14A "Security Ownership of Certain Beneficial Owners and Management"
table (or filer-specific equivalent headings — see below) parsed from its
REAL `<table>`/`<tr>`/`<td>` HTML structure with BeautifulSoup.

**Why real HTML table parsing, not flattened text:** an early version
worked on the same flattened-to-text representation used elsewhere in this
project's SEC parsers. It broke concretely on Alphabet's actual filing:
flattening a multi-column table into one text stream destroys row
boundaries, so "grab the next percent-shaped number after this name"
regex bled from Larry Page's row into Sergey Brin's percentage. Fixed by
parsing the actual HTML table cells, so each matched row's numbers are the
real cells SEC's own rendering assigned to that person/entity.

**Section-heading variance handled:** Item 12's standard caption is
"Security Ownership of Certain Beneficial Owners and Management," but real
filers customize it a lot — confirmed directly: Alphabet uses "**Common**
Stock Ownership of Certain Beneficial Owners and Management"; Walmart uses
two separate headings instead ("Stock Ownership Holdings of Officers,
Directors, and Director Nominees" for insiders, "Holdings of Major
Shareholders" for >5% owners, neither containing the word "Beneficial" at
all).

**Double-counting fix:** per matched founder surname, the MAX single-row
percentage is kept (not summed across rows) — necessary because the same
family stake can appear in more than one row (confirmed on Walmart: a
"Walton Enterprises, LLC" row and a "Walton Family Holdings Trust" row
whose shares the filing's own footnote states are already included in the
LLC row's total; summing both would have overstated the Walton family's
real ~44% stake as ~50%). Combined family stake is then the SUM across
DISTINCT surnames, which is correct when founders are genuinely separate
holders (Alphabet: Larry Page 27.4% + Sergey Brin 25.3% = 52.7%).

**Threshold:** `family_owned = true` when combined founder-surname
voting/ownership percentage is >= 10.0% (`FAMILY_OWNED_THRESHOLD_PCT` in
`scripts/lib/sec_ownership.py`). `founder_led = true` only when a
Wikipedia-listed founder's surname both (a) appears in Wikipedia's
`key_people` field tagged CEO/Executive Chairman, AND (b) is independently
found as a real row in the DEF 14A ownership table (i.e. still an active
insider as of the current proxy, not a historical/stale Wikipedia claim).

**Coverage (497/497 attempted):** 187 companies had a usable Wikipedia
founder/owner lead to check at all (the rest have no `founder`/`owner`
field in their Wikipedia infobox — a real gap in the underlying Wikipedia
data from the prior mining pass, not a bug here; per this task's own
instruction, "not found" is reported honestly rather than guessed).
Of those, 56 had at least one founder-surname row matched in the DEF 14A.
**Result: `founder_led = true` for 15 companies, `family_owned = true` for
33 companies** — real, spot-checkable variation, not a re-defaulted
`false`. Spot-checked against public knowledge: Alphabet (Page+Brin 52.7%,
`founder_led=false` since Sundar Pichai is not a founder — correct),
Walmart (Walton family 44.11%, `family_owned=true` — correct), NVIDIA
(Jensen Huang `founder_led=true`, ownership 3.58% below the family_owned
threshold — correct), Oracle (Ellison 40.6%, `family_owned=true` — correct).

## 3. Domestic revenue mix

**Source used:** SEC's XBRL Frames API and per-company companyconcept API
were tried first (both confirmed reachable) but confirmed EMPIRICALLY to
only expose non-dimensional (whole-entity) values — geographic segment
revenue is filed with an XBRL dimension (`srt:StatementGeographicalAxis`)
attached, which neither API exposes (verified against Apple's own
`RevenueFromContractWithCustomerExcludingAssessedTax` series: always the
consolidated total, never a US-only figure). Fell back to each 10-K's
rendered XBRL viewer report ("R-file") for the geographic-segment note,
discovered via `FilingSummary.xml` — this DOES expose the real dimensional
breakdown as a small HTML table.

**Coverage: 201/497 (40.4%).** Deliberately partial, not a bug:
- Some filers only break out revenue by broader region ("Americas,"
  "North America") with no distinct United States line — explicitly NOT
  treated as domestic-only here (confirmed on Parker Hannifin and AIG,
  both "North America"-only).
- Some filers' only geographic R-file covers property/long-lived assets
  or pre-tax income by geography, not revenue at all (confirmed on Eli
  Lilly having BOTH a revenue-by-geography R-file and a separate
  assets-by-geography one — the parser now prefers revenue-titled R-files
  specifically, fixed after this exact mismatch was caught in testing;
  and on CrowdStrike and W.W. Grainger, which genuinely have no
  revenue-by-geography XBRL table at all, only assets/pre-tax-income ones).
- Companies below >50% US revenue are recorded as `"Globally Diversified"`
  (e.g. Alphabet 48.2%, Apple 36.5% — both real, sourced figures, not the
  old sector heuristic).

**No silent fallback:** where no verifiable figure was found, `profile` is
set to `null` (not re-defaulted to the old sector-heuristic value) with
`confidence: "None"`. `js/scoring.js`'s Q20 (`c.revenue_geography.profile
=== 'Primarily Domestic' ? 1 : 0`) already treats any non-matching value —
including `null` — as neutral, confirmed by reading the scoring code
directly, so this required no scoring-logic change and does not silently
reintroduce the heuristic into the client-facing score.

## Errors

1 transient `ReadTimeout` on CSX during the full 497-company run;
succeeded on an immediate individual retry with no code change. Final
state: 497/497 processed, 0 outstanding errors.

## What's still open

- **5-year return / analyst price-target upside** — genuinely blocked on a
  free-tier API key (Finnhub or Alpha Vantage). Stooq.com returns a
  JavaScript bot-verification challenge instead of CSV data from this
  environment (confirmed, see table above), and Yahoo Finance's chart API
  is blocked by this environment's proxy policy. Per the user's explicit
  instruction this session, no account was created with the user's email
  to obtain a key without their direct involvement — deferred pending the
  user providing a key.
- Companies flagged during this pass as unusually hard to source (recent
  IPOs, foreign private issuers, non-standard filing structures) are
  visible directly in `data/governance_revenue_enrichment.json` as
  per-field `"status": "No verifiable data found"` entries with a specific
  reason — no separate follow-up list was compiled since every such case
  is already individually traceable there.
- Violation Tracker, the Stanford Securities Class Action Clearinghouse,
  SEC's litigation-release search, and CII.org's dual-class list should
  be re-tried in a future session/environment, since their blockers here
  (Cloudflare bot-challenges, proxy egress policy) are environment
  properties, not permanent characteristics of the sources themselves.
