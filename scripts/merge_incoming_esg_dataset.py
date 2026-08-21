#!/usr/bin/env python3
"""
Merges the incoming data-mining-repo dataset (data/incoming_sp500_dataset.json)
into the live ESG dataset (data/esg_dataset_sp500.json), per
data/import_schema_comparison.md's documented decisions. Does NOT touch
data/financial_dataset_sp500.json at all (the incoming dataset has zero
financial/market fields -- confirmed in the comparison doc).

Rules applied (see the comparison doc for the full reasoning):
  - ESG/values fields: fully replaced with the incoming dataset's values,
    copied through with their original field names and {value, source,
    source_url, confidence, notes, last_updated} shape unchanged, so
    js/scoring.js's new ALIGNMENT_FNS (which read these exact field names)
    work directly against this file.
  - `sector` / `hq_country`: KEPT from the existing live dataset (the
    incoming dataset's gics_sector is blank for all 503 companies -- a
    confirmed upstream bug, not fixed here since it's a different repo).
    For the 5 genuinely new tickers with no existing record, a small,
    explicit manual mapping is used instead (see NEW_TICKER_IDENTITY
    below) -- not a general inference system, just these 5 real values,
    checked by hand against the incoming dataset's gics_sub_industry/
    headquarters_location fields.
  - `performance_tier`-adjacent fields (growth_potential/stability) are
    NOT part of this file at all -- they live in financial_dataset_sp500.json
    and are untouched, per the documented decision to keep the existing,
    beta-informed version over the incoming (beta-less) one.
  - Dual-class duplicate tickers of an already-represented company (FOX,
    GOOG, NWS) are excluded from the merged output.
  - Tickers present live but absent from the incoming dataset (AVB, EQR)
    keep their existing ESG data untouched, not dropped.
  - `additional_data_sources` from the prior remediation pass: fields now
    directly superseded by a live scored question are dropped
    (share_class_structure, legal_proceedings_signal,
    founder_family_ownership, ceo_pay_ratio, and the old placeholder
    "No verifiable data found" stub entries); fields with no incoming
    counterpart are kept for reference (fossil_fuel_screen, wikipedia_profile,
    recent_8k_activity, domestic_revenue_mix).

Writes data/merge_conflict_log.json: every case where the live dataset and
the incoming dataset both had real (non-null, non-placeholder) data for the
same company/field, what each said, and which one was kept and why.

Usage:
  python3 scripts/merge_incoming_esg_dataset.py \\
      --live data/esg_dataset_sp500.json \\
      --incoming data/incoming_sp500_dataset.json \\
      --output data/esg_dataset_sp500.json \\
      --log data/merge_conflict_log.json
"""
import argparse
import json

# Dual-class shares of a company already represented by its primary-class
# ticker in the live dataset (FOXA, GOOGL, NWSA) -- see
# data/import_schema_comparison.md.
EXCLUDED_DUPLICATE_TICKERS = {"FOX", "GOOG", "NWS"}

# Genuinely new tickers with no existing live record (real S&P 500
# additions per the incoming dataset -- see comparison doc). Manually
# checked against incoming gics_sub_industry/headquarters_location; all 5
# are US-headquartered.
NEW_TICKER_IDENTITY = {
    "APA": {"sector": "Energy", "hq_country": "United States"},
    "BF-B": {"sector": "Consumer Staples", "hq_country": "United States"},
    "HONA": {"sector": "Industrials", "hq_country": "United States"},
    "RDDT": {"sector": "Communication Services", "hq_country": "United States"},
    "VMRK": {"sector": "Real Estate", "hq_country": "United States"},
}

# Incoming dataset field -> copied through unchanged onto the merged ESG
# record (see js/scoring.js's ALIGNMENT_FNS, which read these exact names).
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

# additional_data_sources sub-keys now directly superseded by a live scored
# question sourced from the incoming dataset -- dropped rather than kept
# alongside a newer, conflicting version of the same fact.
SUPERSEDED_ADDITIONAL_SOURCE_KEYS = {
    "share_class_structure", "legal_proceedings_signal",
    "founder_family_ownership", "ceo_pay_ratio",
    "gunfreefunds", "bcorp_certification", "sbti_validated_targets", "justcapital_rank",
}


def is_real_value(field):
    """True if `field` (an {value,...} object, or a plain bool/dict for the
    live dataset's older shape) represents real, non-placeholder data."""
    if field is None:
        return False
    if isinstance(field, dict):
        if field.get("confidence") == "None":
            return False
        if field.get("value") == "No verifiable data found":
            return False
        if field.get("status") == "No verifiable data found":
            return False
        return True
    return True


def merge(live, incoming):
    live_by_ticker = {c["ticker"]: c for c in live["companies"]}
    incoming_by_ticker = {c["ticker"]: c for c in incoming if c["ticker"] not in EXCLUDED_DUPLICATE_TICKERS}

    merged_companies = []
    log = []

    for ticker, inc in sorted(incoming_by_ticker.items()):
        existing = live_by_ticker.get(ticker)

        if existing:
            sector = existing.get("sector")
            hq_country = existing.get("hq_country")
        else:
            identity = NEW_TICKER_IDENTITY.get(ticker)
            if not identity:
                log.append({
                    "ticker": ticker, "field": "sector/hq_country",
                    "issue": "genuinely new ticker with no manual identity mapping -- skipped, not silently guessed",
                })
                continue
            sector = identity["sector"]
            hq_country = identity["hq_country"]
            log.append({
                "ticker": ticker, "field": "sector/hq_country", "resolution": "new_company_added",
                "note": f"New S&P 500 constituent not in the prior live dataset (company_name={inc.get('company_name')!r}). "
                        f"sector/hq_country manually set from incoming gics_sub_industry={inc.get('gics_sub_industry')!r} / "
                        f"headquarters_location={inc.get('headquarters_location')!r} (incoming's own gics_sector field is "
                        "blank for all companies -- see data/import_schema_comparison.md). Has no financial_dataset_sp500.json "
                        "entry yet -- financial fields will be blank on the live site until a financial-data refresh covers it.",
            })

        new_company = {"ticker": ticker, "name": inc.get("company_name", ticker), "sector": sector, "hq_country": hq_country}

        for key in ESG_FIELD_KEYS:
            if key in inc:
                new_company[key] = inc[key]

        # Conflict logging: founder_led/family_owned specifically, since
        # this repo's own prior session already populated these with real
        # (non-placeholder) SEC-sourced data -- an actual "both sides had
        # real data" case per the task's own definition, not just a
        # never-populated field being filled in for the first time.
        if existing:
            for key in ("founder_led", "family_owned"):
                old_field = existing.get(key)
                new_field = inc.get(key)
                if isinstance(old_field, bool):
                    old_real = old_field is True  # v1 schema: plain booleans, always-False placeholder pre-remediation
                else:
                    old_real = is_real_value(old_field)
                if old_real and is_real_value(new_field):
                    log.append({
                        "ticker": ticker, "field": key, "resolution": "replaced_with_incoming",
                        "old_value": old_field, "new_value": new_field.get("value") if isinstance(new_field, dict) else new_field,
                        "note": "Both this repo's prior SEC-EDGAR-sourced remediation pass and the incoming dataset's "
                                "independently-validated pipeline had real data here; incoming kept per Step 4's "
                                "'fully replace non-financial fields' rule and the task brief's own framing of this "
                                "field as something the import is meant to fix.",
                    })

        # additional_data_sources: keep non-superseded reference data only.
        old_ads = (existing or {}).get("additional_data_sources", {}) or {}
        kept_ads = {k: v for k, v in old_ads.items() if k not in SUPERSEDED_ADDITIONAL_SOURCE_KEYS}
        if kept_ads:
            new_company["additional_data_sources"] = kept_ads

        merged_companies.append(new_company)

    # Tickers live but absent from the incoming dataset: kept, untouched.
    incoming_tickers = set(incoming_by_ticker.keys())
    for ticker, existing in sorted(live_by_ticker.items()):
        if ticker in incoming_tickers:
            continue
        merged_companies.append(existing)
        log.append({
            "ticker": ticker, "field": "(entire ESG record)", "resolution": "kept_existing_untouched",
            "note": f"Ticker not present in the incoming dataset (company_name={existing.get('name')!r}). "
                    "No confirmation it actually exited the S&P 500 vs. an incoming-side omission, so kept with its "
                    "prior ESG data rather than dropped -- see data/import_schema_comparison.md.",
        })

    for ticker in sorted(EXCLUDED_DUPLICATE_TICKERS):
        inc = next((c for c in incoming if c["ticker"] == ticker), None)
        if inc:
            log.append({
                "ticker": ticker, "field": "(entire record)", "resolution": "excluded_duplicate_share_class",
                "note": f"{inc.get('company_name')!r} -- a second share-class ticker of a company already represented "
                        "in the merged set under its primary ticker; excluded to keep one row per company.",
            })

    meta = dict(live.get("meta", {}))
    meta["import_source"] = "RyanD08/stock-select-data-mine @ 24e1a1a6a020136ca5bb1d21bf03628a54de96ee (2026-08-21)"
    meta["schema"] = "esg_dataset_sp500 -- values/governance fields only, imported from the data-mining repo's 28-question schema. See data/import_schema_comparison.md."

    return {"meta": meta, "companies": merged_companies}, log


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--live", required=True)
    parser.add_argument("--incoming", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--log", required=True)
    args = parser.parse_args()

    with open(args.live) as f:
        live = json.load(f)
    with open(args.incoming) as f:
        incoming = json.load(f)

    merged, log = merge(live, incoming)

    with open(args.output, "w") as f:
        json.dump(merged, f, indent=2)
    with open(args.log, "w") as f:
        json.dump({"entries": log, "count": len(log)}, f, indent=2)

    print(f"Merged {len(merged['companies'])} companies -> {args.output}")
    print(f"Wrote {len(log)} log entries -> {args.log}")


if __name__ == "__main__":
    main()
