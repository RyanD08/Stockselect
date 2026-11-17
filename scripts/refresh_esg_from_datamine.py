#!/usr/bin/env python3
"""
Refreshes the live values/ESG dataset (data/esg_dataset_sp500.json) from a
newer copy of the data-mining repo's dataset (RyanD08/stock-select-data-mine,
data/sp500_full_dataset.json).

This is the follow-up-update path, not a first import (that was
merge_incoming_esg_dataset.py). It only touches the 25 scored values fields,
and only for companies that exist in both files:
  - each field is copied as {value, confidence} only -- the same trimming the
    live file got on 2026-08-29 (source/source_url/notes/last_updated are
    never read by the site, so they aren't shipped);
  - each company's sector is set to the incoming file's official GICS sector
    (gics_sector), in BOTH live files so they stay identical -- the live
    sectors originally came from an older pipeline and about a quarter were
    wrong (e.g. REITs filed under Financials). Two live companies the
    incoming file lacks get their sector from MANUAL_SECTORS below;
  - each company's hq_country is set to the incoming file's hq_country
    (where the company is actually run from -- see the data-mine's
    data/reference/hq_country_overrides.json), in BOTH live files;
  - name, additional_data_sources, and anything else on the live record
    are left alone;
  - dual-class duplicate tickers (FOX, GOOG, NWS) are skipped, and live
    tickers missing from the incoming file (AVB, EQR) keep their data, both
    exactly as the first import decided;
  - data/financial_dataset_sp500.json is only touched for `sector` and `hq_country`.

Every change is classified and printed: "filled" (no data -> real data),
"changed" (real -> different real), "lost" (real -> no data), and
"no-data wording" (one no-data placeholder replaced by another). "changed"
and "lost" are refused unless --allow-overwrites is passed, so an upstream
regression can't silently erase data that's live today.

Usage:
  python3 scripts/refresh_esg_from_datamine.py \\
      --incoming ../stock-select-data-mine/data/sp500_full_dataset.json \\
      --source-commit <data-mine commit hash> \\
      [--allow-overwrites] [--dry-run]
"""
import argparse
import collections
import datetime
import json
import sys

LIVE_PATH = "data/esg_dataset_sp500.json"
FINANCIAL_PATH = "data/financial_dataset_sp500.json"
GICS_SECTORS = {
    "Communication Services", "Consumer Discretionary", "Consumer Staples", "Energy", "Financials",
    "Health Care", "Industrials", "Information Technology", "Materials", "Real Estate", "Utilities",
}
# Live companies the incoming file doesn't cover. Both are residential REITs.
MANUAL_SECTORS = {"AVB": "Real Estate", "EQR": "Real Estate"}
EXCLUDED_DUPLICATE_TICKERS = {"FOX", "GOOG", "NWS"}
ESG_FIELD_KEYS = [
    "carbon_fossil_fuel_involvement", "renewable_clean_tech_involvement",
    "environmental_pollution_violations", "sustainable_agriculture_resource_use",
    "fair_wages_labor_practices", "labor_disputes_exploitation_history",
    "workplace_diversity_equity_inclusion", "worker_safety_record",
    "board_transparency_independence", "ceo_pay_ratio",
    "fraud_corruption_scandal_history", "shareholder_rights_voting_structure",
    "tobacco_involvement", "alcohol_involvement", "gambling_casino_involvement",
    "weapons_defense_involvement", "adult_entertainment_involvement",
    "religious_investment_compliance", "interest_based_financial_products",
    "political_donation_transparency", "countries_of_concern_operations",
    "data_privacy_practices", "founder_led", "family_owned", "women_led",
]


def has_real_data(field):
    return (
        isinstance(field, dict)
        and field.get("confidence") != "None"
        and field.get("value") not in (None, "No verifiable data found")
    )


def trimmed(field):
    return {"value": field.get("value"), "confidence": field.get("confidence")}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--incoming", required=True)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--allow-overwrites", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    with open(LIVE_PATH) as f:
        live = json.load(f)
    with open(args.incoming) as f:
        incoming = json.load(f)
    if isinstance(incoming, dict):
        incoming = incoming["companies"]
    incoming_by_ticker = {c["ticker"]: c for c in incoming if c["ticker"] not in EXCLUDED_DUPLICATE_TICKERS}

    counts = collections.defaultdict(collections.Counter)
    overwrites = []
    for company in live["companies"]:
        source = incoming_by_ticker.get(company["ticker"])
        if not source:
            continue
        for key in ESG_FIELD_KEYS:
            if not isinstance(source.get(key), dict):
                continue
            new = trimmed(source[key])
            old = company.get(key)
            if new == old:
                continue
            was_real, is_real = has_real_data(old), has_real_data(new)
            if was_real and is_real:
                kind = "changed"
            elif was_real:
                kind = "lost"
            elif is_real:
                kind = "filled"
            else:
                kind = "no-data wording"
            counts[key][kind] += 1
            if kind in ("changed", "lost"):
                overwrites.append((company["ticker"], key, old, new))
            company[key] = new

    with open(FINANCIAL_PATH) as f:
        financial = json.load(f)
    sector_changes = []
    hq_changes = []
    for dataset in (live, financial):
        for company in dataset["companies"]:
            source = incoming_by_ticker.get(company["ticker"])
            sector = (source or {}).get("gics_sector") or MANUAL_SECTORS.get(company["ticker"])
            if sector in GICS_SECTORS and sector != company.get("sector"):
                if dataset is live:
                    sector_changes.append((company["ticker"], company.get("sector"), sector))
                company["sector"] = sector
            country = (source or {}).get("hq_country")
            if isinstance(country, str) and country and country != company.get("hq_country"):
                if dataset is live:
                    hq_changes.append((company["ticker"], company.get("hq_country"), country))
                company["hq_country"] = country

    print(f"Headquarters country corrections: {len(hq_changes)}")
    for ticker, old, new in hq_changes:
        print(f"  {ticker:6s} {old} -> {new}")
    live_tickers = {c["ticker"] for c in live["companies"]}
    print(f"Sector corrections: {len(sector_changes)}")
    for ticker, old, new in sector_changes[:15]:
        print(f"  {ticker:6s} {old} -> {new}")
    print("Changes by field:")
    for key in ESG_FIELD_KEYS:
        if counts[key]:
            print(f"  {key:40s} {dict(counts[key])}")
    print("Incoming tickers not in the live file (not added):", sorted(set(incoming_by_ticker) - live_tickers) or "none")
    print("Live tickers not in the incoming file (kept as-is):", sorted(live_tickers - set(incoming_by_ticker)) or "none")

    if overwrites:
        print(f"\n{len(overwrites)} existing real value(s) would be changed or removed:")
        for ticker, key, old, new in overwrites[:40]:
            print(f"  {ticker} {key}: {json.dumps(old)} -> {json.dumps(new)}")
        if not args.allow_overwrites:
            print("\nRefusing to write. Review the list above, then rerun with --allow-overwrites if it's intended.")
            sys.exit(1)

    if args.dry_run:
        print("\nDry run: nothing written.")
        return

    live["meta"]["import_source"] = (
        f"RyanD08/stock-select-data-mine @ {args.source_commit} "
        f"(values fields refreshed {datetime.date.today().isoformat()} by scripts/refresh_esg_from_datamine.py)"
    )
    with open(LIVE_PATH, "w") as f:
        json.dump(live, f, separators=(",", ":"))
    with open(FINANCIAL_PATH, "w") as f:
        json.dump(financial, f, separators=(",", ":"))
    print(f"\nWrote {LIVE_PATH} and {FINANCIAL_PATH}")


if __name__ == "__main__":
    main()
