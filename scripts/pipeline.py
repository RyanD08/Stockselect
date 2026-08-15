#!/usr/bin/env python3
"""
Full-market dataset pipeline: SEC EDGAR (fundamentals, SIC-based sin-stock
flags) + Finnhub (market data, analyst consensus) -> a JSON file matching
the exact schema of data/values_portfolio_dataset_v5_100.json.

Usage:
  python3 scripts/pipeline.py --tickers AAPL,MSFT,XOM,JNJ --output data/test_batch.json
  python3 scripts/pipeline.py --tickers-file scripts/full_universe_tickers.txt --output data/full_dataset.json

Raw SEC/Finnhub responses are cached under scripts/cache/ as they're fetched,
so an interrupted run resumes without re-fetching (pass --refresh to force
re-fetching for specific tickers already run).
"""
import argparse
import datetime
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lib.clients import make_sec_client, make_finnhub_client, finnhub_get
from lib.build_record import build_company_record, MissingDataError
from lib.composite_score import apply_composite_scores
from lib.quality_filter import filter_unreasonable_companies
from lib import sec_financials as secfin

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(SCRIPT_DIR)


def load_env():
    env_path = os.path.join(REPO_ROOT, ".env")
    env = {}
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    # environment variables take precedence over .env
    for k in ("FINNHUB_API_KEY", "SEC_USER_AGENT"):
        if os.environ.get(k):
            env[k] = os.environ[k]
    return env


def load_ticker_cik_map(sec_client, refresh=False):
    body, status, _ = sec_client.get_json(
        "https://www.sec.gov/files/company_tickers.json",
        cache_key="company_tickers",
        refresh=refresh,
    )
    if status != 200:
        raise RuntimeError(f"Failed to fetch SEC company_tickers.json: HTTP {status}")
    out = {}
    for _, entry in body.items():
        out[entry["ticker"].upper()] = {"cik": entry["cik_str"], "title": entry["title"]}
    return out


def fetch_one(ticker, cik, sec_client, fh_client, refresh=False):
    cik10 = str(cik).zfill(10)

    sub_body, sub_status, _ = sec_client.get_json(
        f"https://data.sec.gov/submissions/CIK{cik10}.json",
        cache_key=f"submission_{cik10}",
        refresh=refresh,
    )
    if sub_status != 200:
        raise RuntimeError(f"SEC submissions HTTP {sub_status} for {ticker} (CIK {cik10})")

    facts_body, facts_status, _ = sec_client.get_json(
        f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik10}.json",
        cache_key=f"companyfacts_{cik10}",
        refresh=refresh,
    )
    if facts_status != 200:
        raise RuntimeError(f"SEC companyfacts HTTP {facts_status} for {ticker} (CIK {cik10})")

    # Cheap pre-check before spending 4 Finnhub calls: if SEC XBRL has no
    # usable annual revenue/net income (foreign private issuer filing 20-F
    # instead of 10-K, shell company, newly-registered successor CIK with no
    # filing history yet, etc.), this ticker will be skipped regardless, so
    # skip the Finnhub calls too.
    fundamentals = secfin.extract_fundamentals(facts_body)
    if fundamentals["revenue"] is None or fundamentals["net_income"] is None:
        raise MissingDataError(f"{ticker}: no annual revenue/net income in SEC XBRL data")

    profile_body, _, _ = finnhub_get(fh_client, "stock/profile2", {"symbol": ticker}, f"{ticker}_profile2", refresh=refresh)
    metric_body, _, _ = finnhub_get(fh_client, "stock/metric", {"symbol": ticker, "metric": "all"}, f"{ticker}_metric", refresh=refresh)
    quote_body, _, _ = finnhub_get(fh_client, "quote", {"symbol": ticker}, f"{ticker}_quote", refresh=refresh)
    reco_body, _, _ = finnhub_get(fh_client, "stock/recommendation", {"symbol": ticker}, f"{ticker}_recommendation", refresh=refresh)

    return sub_body, facts_body, profile_body, metric_body, quote_body, reco_body


def run(tickers, output_path, refresh=False, sleep_between=0.0, log_every=10):
    env = load_env()
    if not env.get("FINNHUB_API_KEY"):
        print("ERROR: FINNHUB_API_KEY not set (check .env)", file=sys.stderr)
        sys.exit(1)
    if not env.get("SEC_USER_AGENT"):
        print("ERROR: SEC_USER_AGENT not set (check .env)", file=sys.stderr)
        sys.exit(1)

    sec_client = make_sec_client(env["SEC_USER_AGENT"])
    fh_client = make_finnhub_client(env["FINNHUB_API_KEY"])

    print(f"Loading SEC ticker/CIK map ({len(tickers)} tickers requested)...")
    ticker_map = load_ticker_cik_map(sec_client)

    companies = []
    skipped = []
    debug_by_ticker = {}

    for i, ticker in enumerate(tickers):
        ticker = ticker.upper().strip()
        if not ticker:
            continue
        entry = ticker_map.get(ticker)
        if not entry:
            skipped.append((ticker, "not found in SEC company_tickers.json"))
            continue
        try:
            sub, facts, profile, metric, quote, reco = fetch_one(ticker, entry["cik"], sec_client, fh_client, refresh=refresh)
            record, debug_info = build_company_record(ticker, sub, facts, profile, metric, quote, reco)
            companies.append(record)
            debug_by_ticker[ticker] = debug_info
        except MissingDataError as e:
            skipped.append((ticker, str(e)))
        except Exception as e:  # noqa: BLE001 - keep the batch going; log and move on
            skipped.append((ticker, f"{type(e).__name__}: {e}"))

        if (i + 1) % log_every == 0 or (i + 1) == len(tickers):
            print(f"  [{i + 1}/{len(tickers)}] processed, {len(companies)} ok, {len(skipped)} skipped")
        if sleep_between:
            time.sleep(sleep_between)

    companies, quality_excluded = filter_unreasonable_companies(companies, debug_by_ticker)
    print(f"Quality filter: excluded {len(quality_excluded)} companies unreasonable to recommend (SPACs, nano-cap, implausible data)")

    print(f"Applying composite financial scores across {len(companies)} companies...")
    apply_composite_scores(companies)

    companies.sort(key=lambda c: c["ticker"])

    output = {
        "meta": {
            "purpose": "Full-market dataset built from SEC EDGAR (fundamentals, SIC-derived sin-stock flags) and Finnhub (market data, analyst consensus). See important_caveats for fields that could not be sourced live on the available Finnhub API tier.",
            "snapshot_date": datetime.date.today().isoformat(),
            "company_count": len(companies),
            "pipeline_source": "scripts/pipeline.py",
            "data_confidence_legend": {
                "High": "Objective, easily verifiable public fact (HQ location, sector, sin-stock SIC-derived flags)",
                "Medium": "Live-sourced from SEC EDGAR XBRL or Finnhub market data APIs",
                "Low": "No standardized live per-company data source available at this scale (this API tier); illustrative/heuristic estimate, not a verified fact",
            },
            "important_caveats": [
                "esg_ratings (environmental/social_labor/governance) are neutral (3) Low-confidence placeholders: Finnhub's ESG endpoint requires a premium plan and no paid ESG vendor is in use, consistent with the project's 'no invented verified-looking data' rule.",
                "founder_led and family_owned default to false for every company: no live ownership data source is available at this scale on the current Finnhub tier (the ownership endpoint requires a premium plan). Not a verified fact for any individual company.",
                "financial_metrics.analyst_price_target_upside_pct and performance_tier.five_year_annualized_return_pct_est are null for every company: both require Finnhub endpoints (price-target, historical candles) gated behind a premium plan. js/scoring.js was updated to treat a null value here as neutral (0.5), matching how it already treats other missing fundamentals (see peAlignment/pegAlignment/roeAlignment/fcfMarginAlignment).",
                "revenue_geography.profile is a sector-level heuristic default (Low confidence), not a verified per-company fact -- SEC XBRL geographic-segment tagging is inconsistent across filers at this scale.",
                "sector is derived from the company's SEC SIC industry classification code via an approximate SIC-to-GICS-style mapping table (scripts/lib/mapping.py); it will occasionally differ from a company's true GICS sector since SIC is a coarser, older classification. Known systematic gap: internet/media companies filed under a generic 'software/data processing' SIC (7370-7379) map to Information Technology even where GICS classifies them as Communication Services (e.g. Alphabet); payment-network and similar financial-services companies filed under the generic 'business services NEC' SIC (7389) map by industry bucket rather than as Financials (e.g. Visa). These SIC codes are shared by hundreds of otherwise-unrelated companies, so no single-company override was applied.",
                "sin_stock_flags are derived from SIC codes (tobacco/alcohol/gambling/weapons-defense) plus narrow name-keyword matching (gambling/adult_entertainment) as documented in scripts/lib/mapping.py -- not a paid ESG vendor screen, and may miss companies whose primary SIC code doesn't reflect a secondary sin-stock business line.",
                "performance_tier.growth_potential/stability/risk_profile_fit are heuristically derived from beta and revenue growth, not analyst judgment.",
                f"A quality filter (scripts/lib/quality_filter.py) excluded {len(quality_excluded)} otherwise-valid SEC filers before this dataset was built: blank-check/SPAC companies (SIC 6770, no real operating business), companies under a $50M market-cap floor, and companies with an implausible beta (|beta|>5, almost always a thin-trading data artifact rather than a real risk signal). See the accompanying _debug.json's quality_excluded list for exactly which tickers and why.",
                "Not investment advice. For prototype/demo purposes only.",
            ],
            "schema_version": "2.4",
        },
        "companies": companies,
    }

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "w") as f:
        json.dump(output, f, indent=2)

    print(f"\nWrote {len(companies)} companies to {output_path}")
    if skipped:
        print(f"Skipped {len(skipped)} tickers:")
        for t, reason in skipped[:50]:
            print(f"  {t}: {reason}")
        if len(skipped) > 50:
            print(f"  ... and {len(skipped) - 50} more")

    debug_path = output_path.replace(".json", "_debug.json")
    with open(debug_path, "w") as f:
        json.dump({"skipped": skipped, "quality_excluded": quality_excluded, "sic_by_ticker": debug_by_ticker}, f, indent=2)
    print(f"Debug info (SIC codes, skip reasons, quality-filter exclusions) written to {debug_path}")

    return output


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tickers", help="Comma-separated ticker list")
    parser.add_argument("--tickers-file", help="Path to a file with one ticker per line")
    parser.add_argument("--output", required=True)
    parser.add_argument("--refresh", action="store_true", help="Force re-fetch even if cached")
    parser.add_argument("--sleep", type=float, default=0.0, help="Extra sleep (s) between companies")
    args = parser.parse_args()

    if args.tickers:
        tickers = args.tickers.split(",")
    elif args.tickers_file:
        with open(args.tickers_file) as f:
            tickers = [line.strip() for line in f if line.strip()]
    else:
        parser.error("Must pass --tickers or --tickers-file")
        return

    run(tickers, args.output, refresh=args.refresh, sleep_between=args.sleep)


if __name__ == "__main__":
    main()
