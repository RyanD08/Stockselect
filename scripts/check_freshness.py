#!/usr/bin/env python3
"""
Reports which companies' financial_metrics.last_refreshed is missing or
older than a cutoff, so they can be explicitly re-pulled rather than
silently trusting whatever's in the pipeline's cache (Patch v15 SS2a).

Usage:
  python3 scripts/check_freshness.py data/values_portfolio_dataset_full_market.json
  python3 scripts/check_freshness.py data/values_portfolio_dataset_full_market.json --max-age-days 7

Prints a comma-separated ticker list to stdout (last) suitable for:
  python3 scripts/pipeline.py --tickers $(python3 scripts/check_freshness.py ... --tickers-only) --refresh --output ...
"""
import argparse
import datetime
import json
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("dataset_path")
    parser.add_argument("--max-age-days", type=float, default=None, help="Flag companies refreshed longer ago than this many days")
    parser.add_argument("--tickers-only", action="store_true", help="Print only a comma-separated ticker list (for feeding back into pipeline.py --tickers)")
    args = parser.parse_args()

    with open(args.dataset_path) as f:
        data = json.load(f)

    missing = []
    stale = []
    now = datetime.datetime.now(datetime.timezone.utc)

    for c in data["companies"]:
        last_refreshed = c["financial_metrics"].get("last_refreshed")
        if not last_refreshed:
            missing.append(c["ticker"])
            continue
        if args.max_age_days is not None:
            refreshed_at = datetime.datetime.fromisoformat(last_refreshed)
            age_days = (now - refreshed_at).total_seconds() / 86400
            if age_days > args.max_age_days:
                stale.append((c["ticker"], round(age_days, 1)))

    if args.tickers_only:
        all_tickers = missing + [t for t, _ in stale]
        print(",".join(all_tickers))
        return

    print(f"Total companies: {len(data['companies'])}")
    print(f"Missing last_refreshed (predates this field / cache entry from before it existed): {len(missing)}")
    if missing:
        print(f"  e.g. {missing[:10]}")
    if args.max_age_days is not None:
        print(f"Older than {args.max_age_days} days: {len(stale)}")
        if stale:
            print(f"  e.g. {stale[:10]}")
    print()
    print("To re-pull affected tickers:")
    print(f"  python3 scripts/pipeline.py --tickers $(python3 {sys.argv[0]} {args.dataset_path} --tickers-only) --refresh --output {args.dataset_path}")


if __name__ == "__main__":
    main()
