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
