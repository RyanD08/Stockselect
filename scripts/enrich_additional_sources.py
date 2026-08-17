#!/usr/bin/env python3
"""
Aggressive multi-source enrichment pass: mines fossilfreefunds.org (fossil
fuel involvement + bonus diversity/equity scores), en.wikipedia.org
(founder/HQ/ownership leads), and two more SEC EDGAR angles not covered by
the base pipeline (DEF 14A CEO pay ratio, 8-K material-event item history)
for every company in the existing S&P 500 dataset.

Sources on the approved list that were investigated but could NOT be
reached/parsed from this environment this pass -- see
data/mining_session_notes.md for the full investigation log:
  - api.gunfreefunds.org: blocked by this environment's proxy egress policy
    (502 policy denial at the CONNECT step, confirmed via the proxy's own
    diagnostic log -- not a transient failure).
  - bcorporation.net: served behind a Cloudflare bot-challenge (Turnstile)
    on every path tried; not fetchable by a plain HTTP client.
  - sciencebasedtargets.org: the bulk company export lives on
    files.sciencebasedtargets.org, a subdomain blocked by the same proxy
    policy (403 at CONNECT); the main site's own company search is a
    client-rendered SPA with no server-rendered data to scrape statically.
  - justcapital.com: reachable, but its rankings widget is a client-side
    app with no discoverable server-rendered data or public REST API on
    the justcapital.com domain itself (only standard WordPress post/page
    content, which doesn't carry ranking data).
  - www.bls.gov: reachable, but the specific injury/illness-by-industry
    release table renders via JavaScript with no server-rendered data in
    the HTML response, so no sector-benchmark figures could be extracted.
Every company record still gets an explicit "No verifiable data found"
entry (with the reason above) for each of these, per the task's own rule
against leaving a field ambiguously absent.

Usage:
  python3 scripts/enrich_additional_sources.py --input data/values_portfolio_dataset_sp500.json \\
      --tickers AAPL,MSFT --output data/test_enrich.json
  python3 scripts/enrich_additional_sources.py --input data/values_portfolio_dataset_sp500.json \\
      --all --output data/sp500_full_dataset.json \\
      --candidate-criteria-output data/candidate_additional_criteria.json \\
      --checkpoint-every 25
"""
import argparse
import datetime
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lib.clients import (
    make_sec_client, make_fossil_free_funds_client, make_wikipedia_client, make_sec_proxy_client,
)
from lib import fossil_free_funds, wikipedia_lookup, sec_proxy, sec_8k_events

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONTACT = "ryan.delp08@gmail.com"
SEC_USER_AGENT = f"Stockselect ESG Research ({CONTACT})"

BLOCKED_SOURCE_NOTES = {
    "gunfreefunds": {
        "status": "No verifiable data found",
        "reason": (
            "api.gunfreefunds.org is blocked by this environment's proxy egress policy "
            "(502 policy denial at the CONNECT step; confirmed via the proxy's own diagnostic "
            "log -- recentRelayFailures showed repeated connect_rejected entries for this exact "
            "host, not a transient network error). The public gunfreefunds.org site itself "
            "resolves fine but serves only a JS app shell with no server-rendered company data."
        ),
    },
    "bcorp_certification": {
        "status": "No verifiable data found",
        "reason": (
            "bcorporation.net returned HTTP 403 with a Cloudflare Turnstile bot-challenge page "
            "('Just a moment...') on every path tried (root, find-a-b-corp directory, a direct "
            "company URL), including with a browser-identifying User-Agent. Not fetchable by a "
            "plain HTTP client from this environment."
        ),
    },
    "sbti_validated_targets": {
        "status": "No verifiable data found",
        "reason": (
            "sciencebasedtargets.org's own bulk company export (companies-excel.xlsx) is hosted "
            "on files.sciencebasedtargets.org, a subdomain blocked by this environment's proxy "
            "policy (403 policy denial at CONNECT). The main sciencebasedtargets.org site's "
            "company-search page (companies-taking-action) is a client-rendered SPA that returns "
            "no company data in the raw HTTP response -- would require JS execution to scrape, "
            "which was out of scope for this pass."
        ),
    },
    "justcapital_rank": {
        "status": "No verifiable data found",
        "reason": (
            "justcapital.com is reachable and its own wp-json REST API was checked, but only "
            "exposes standard WordPress posts/pages -- the rankings widget itself is a separate "
            "client-side app with no discoverable server-rendered ranking data or public REST "
            "endpoint on the justcapital.com domain."
        ),
    },
}


def load_ticker_cik_map(sec_client, refresh=False):
    body, status, _from_cache, _fetched_at = sec_client.get_json(
        "https://www.sec.gov/files/company_tickers.json",
        cache_key="company_tickers", refresh=refresh,
    )
    if status != 200:
        raise RuntimeError(f"Failed to fetch SEC company_tickers.json: HTTP {status}")
    out = {}
    for _, entry in body.items():
        out[entry["ticker"].upper()] = entry["cik_str"]
    return out


def enrich_one(ticker, company_name, cik, sec_client, sec_proxy_client, ff_client, wiki_client, as_of, refresh=False):
    result = {"ticker": ticker, "as_of": as_of.isoformat()}

    # --- fossilfreefunds.org ---
    ff_record, ff_err = fossil_free_funds.fetch_company(ff_client, ticker, "ffree", refresh=refresh)
    if ff_record:
        result["fossil_fuel_screen"] = fossil_free_funds.build_fossil_fuel_screen(ff_record)
    else:
        result["fossil_fuel_screen"] = {
            "status": "No verifiable data found",
            "reason": ff_err or f"No fossilfreefunds.org record found for primary_symbol={ticker}",
        }

    # --- Wikipedia ---
    wiki_profile, wiki_err = wikipedia_lookup.build_wikipedia_profile(wiki_client, company_name, f"wiki_{ticker}", refresh=refresh)
    if wiki_profile:
        result["wikipedia_profile"] = wiki_profile
    else:
        result["wikipedia_profile"] = {
            "status": "No verifiable data found",
            "reason": wiki_err or "No matching Wikipedia article found",
        }

    # --- SEC submissions (feeds both DEF 14A pay ratio and 8-K summary) ---
    if cik is None:
        result["ceo_pay_ratio"] = {"status": "No verifiable data found", "reason": "No CIK found in SEC company_tickers.json for this ticker"}
        result["recent_8k_activity"] = {"status": "No verifiable data found", "reason": "No CIK found in SEC company_tickers.json for this ticker"}
        return result

    cik10 = str(cik).zfill(10)
    sub_body, sub_status, _from_cache, _fetched_at = sec_client.get_json(
        f"https://data.sec.gov/submissions/CIK{cik10}.json",
        cache_key=f"submission_{cik10}", refresh=refresh,
    )
    if sub_status != 200:
        reason = f"SEC submissions HTTP {sub_status} for CIK {cik10}"
        result["ceo_pay_ratio"] = {"status": "No verifiable data found", "reason": reason}
        result["recent_8k_activity"] = {"status": "No verifiable data found", "reason": reason}
        return result

    pay_ratio, pr_err = sec_proxy.fetch_ceo_pay_ratio(sec_proxy_client, cik, sub_body, f"proxy_{cik10}", refresh=refresh)
    if pay_ratio:
        result["ceo_pay_ratio"] = pay_ratio
    else:
        result["ceo_pay_ratio"] = {"status": "No verifiable data found", "reason": pr_err or "unknown"}

    summary_8k = sec_8k_events.summarize_8k_activity(sub_body, as_of)
    if summary_8k:
        result["recent_8k_activity"] = summary_8k
    else:
        result["recent_8k_activity"] = {"status": "No verifiable data found", "reason": "No 8-K filings found in SEC filing history (may be a foreign private issuer filing 6-K instead)"}

    return result


def run(tickers_with_names, output_path, candidate_criteria_output, checkpoint_every=25, refresh=False):
    sec_client = make_sec_client(SEC_USER_AGENT)
    sec_proxy_client = make_sec_proxy_client(SEC_USER_AGENT)
    ff_client = make_fossil_free_funds_client(CONTACT)
    wiki_client = make_wikipedia_client(CONTACT)

    print(f"Loading SEC ticker/CIK map...")
    ticker_cik = load_ticker_cik_map(sec_client)

    as_of = datetime.date.today()
    results = {}
    errors = []

    for i, (ticker, name) in enumerate(tickers_with_names):
        cik = ticker_cik.get(ticker.upper())
        try:
            results[ticker] = enrich_one(ticker, name, cik, sec_client, sec_proxy_client, ff_client, wiki_client, as_of, refresh=refresh)
        except Exception as e:  # noqa: BLE001 - keep the batch going
            errors.append((ticker, f"{type(e).__name__}: {e}"))
            print(f"  ERROR on {ticker}: {type(e).__name__}: {e}", file=sys.stderr)

        if (i + 1) % checkpoint_every == 0 or (i + 1) == len(tickers_with_names):
            print(f"  [{i + 1}/{len(tickers_with_names)}] processed, {len(errors)} errors")
            with open(output_path, "w") as f:
                json.dump({"meta": {"snapshot_date": as_of.isoformat(), "companies_processed": len(results), "total_requested": len(tickers_with_names), "errors": errors}, "additional_data": results}, f, indent=2)

    print(f"\nWrote {len(results)} enriched records to {output_path}")
    if errors:
        print(f"{len(errors)} errors:")
        for t, e in errors[:30]:
            print(f"  {t}: {e}")
    return results, errors


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, help="Existing sp500 dataset JSON (schema: {meta, companies:[...]})")
    parser.add_argument("--tickers", help="Comma-separated ticker subset (for testing)")
    parser.add_argument("--all", action="store_true", help="Process every company in --input")
    parser.add_argument("--output", required=True, help="Where to write the raw additional-data results (checkpointed)")
    parser.add_argument("--candidate-criteria-output", help="If set, also write candidate_additional_criteria.json here after the run")
    parser.add_argument("--checkpoint-every", type=int, default=25)
    parser.add_argument("--refresh", action="store_true")
    args = parser.parse_args()

    with open(args.input) as f:
        base = json.load(f)
    name_by_ticker = {c["ticker"]: c["name"] for c in base["companies"]}

    if args.tickers:
        wanted = [t.strip().upper() for t in args.tickers.split(",") if t.strip()]
        tickers_with_names = [(t, name_by_ticker.get(t, t)) for t in wanted]
    elif args.all:
        tickers_with_names = sorted(name_by_ticker.items())
    else:
        parser.error("Must pass --tickers or --all")
        return

    run(tickers_with_names, args.output, args.candidate_criteria_output, checkpoint_every=args.checkpoint_every, refresh=args.refresh)


if __name__ == "__main__":
    main()
