#!/usr/bin/env python3
"""
Validates a generated dataset file against the exact schema of
data/values_portfolio_dataset_v5_100.json: same top-level meta/companies
structure, and every company has the same set of fields with plausible types.

Usage: python3 scripts/validate_dataset.py data/test_batch.json
"""
import json
import sys

REQUIRED_COMPANY_FIELDS = {
    "ticker": str,
    "name": str,
    "sector": str,
    "hq_country": str,
    "founder_led": bool,
    "family_owned": bool,
    "sin_stock_flags": dict,
    "animal_testing_exposure": str,
    "esg_ratings": dict,
    "performance_tier": dict,
    "market_profile": dict,
    "financial_leverage": dict,
    "dividend_policy": dict,
    "revenue_geography": dict,
    "financial_metrics": dict,
}

SIN_FLAGS = ["tobacco", "alcohol", "gambling", "weapons_defense", "adult_entertainment"]
ESG_CATEGORIES = ["environmental", "social_labor", "governance"]

VALID_SECTORS = {
    "Information Technology", "Communication Services", "Consumer Discretionary",
    "Consumer Staples", "Health Care", "Financials", "Energy", "Utilities",
    "Industrials", "Materials", "Real Estate",
}
VALID_MARKET_CAP_TIERS = {"Mega", "Large", "Mid", "Small", None}
VALID_LEVERAGE = {"Low", "Medium", "High", None}
VALID_DIVIDEND_STATUS = {"Payer", "Non-payer"}
VALID_YIELD_TIERS = {"Very Low", "Low", "Medium", "High", None}
VALID_REVENUE_GEO = {"Globally Diversified", "Primarily Domestic", None}
VALID_ANALYST_CONSENSUS = {"Strong Buy", "Buy", "Hold", "Sell", "Strong Sell"}
VALID_SCORE_LABELS = {"Above Average", "Average", "Below Average", None}
VALID_RISK_PROFILE = {"Growth", "Balanced", "Conservative"}


def validate_company(c, idx):
    errors = []
    prefix = f"company[{idx}] ({c.get('ticker', '?')})"

    for field, expected_type in REQUIRED_COMPANY_FIELDS.items():
        if field not in c:
            errors.append(f"{prefix}: missing field '{field}'")
            continue
        if not isinstance(c[field], expected_type):
            errors.append(f"{prefix}: field '{field}' expected {expected_type.__name__}, got {type(c[field]).__name__}")

    if "sin_stock_flags" in c:
        for flag in SIN_FLAGS:
            if flag not in c["sin_stock_flags"]:
                errors.append(f"{prefix}: sin_stock_flags missing '{flag}'")
            elif not isinstance(c["sin_stock_flags"][flag], bool):
                errors.append(f"{prefix}: sin_stock_flags.{flag} not bool")

    if "esg_ratings" in c:
        for cat in ESG_CATEGORIES:
            if cat not in c["esg_ratings"]:
                errors.append(f"{prefix}: esg_ratings missing '{cat}'")
                continue
            block = c["esg_ratings"][cat]
            for key in ("score", "confidence", "note"):
                if key not in block:
                    errors.append(f"{prefix}: esg_ratings.{cat} missing '{key}'")
            if "score" in block and not isinstance(block["score"], (int, float)):
                errors.append(f"{prefix}: esg_ratings.{cat}.score not numeric")

    if "sector" in c and c["sector"] not in VALID_SECTORS:
        errors.append(f"{prefix}: unrecognized sector '{c['sector']}'")

    pt = c.get("performance_tier", {})
    for key in ("growth_potential", "stability", "risk_profile_fit", "five_year_annualized_return_pct_est", "confidence", "note"):
        if key not in pt:
            errors.append(f"{prefix}: performance_tier missing '{key}'")
    if pt.get("risk_profile_fit") not in VALID_RISK_PROFILE:
        errors.append(f"{prefix}: performance_tier.risk_profile_fit invalid '{pt.get('risk_profile_fit')}'")

    mp = c.get("market_profile", {})
    for key in ("market_cap_usd_billions_est", "market_cap_tier", "beta_est", "confidence", "note"):
        if key not in mp:
            errors.append(f"{prefix}: market_profile missing '{key}'")
    if mp.get("market_cap_tier") not in VALID_MARKET_CAP_TIERS:
        errors.append(f"{prefix}: market_profile.market_cap_tier invalid '{mp.get('market_cap_tier')}'")

    fl = c.get("financial_leverage", {})
    for key in ("level", "confidence", "note"):
        if key not in fl:
            errors.append(f"{prefix}: financial_leverage missing '{key}'")
    if fl.get("level") not in VALID_LEVERAGE:
        errors.append(f"{prefix}: financial_leverage.level invalid '{fl.get('level')}'")

    dp = c.get("dividend_policy", {})
    for key in ("status", "yield_tier", "confidence", "note"):
        if key not in dp:
            errors.append(f"{prefix}: dividend_policy missing '{key}'")
    if dp.get("status") not in VALID_DIVIDEND_STATUS:
        errors.append(f"{prefix}: dividend_policy.status invalid '{dp.get('status')}'")
    if dp.get("yield_tier") not in VALID_YIELD_TIERS:
        errors.append(f"{prefix}: dividend_policy.yield_tier invalid '{dp.get('yield_tier')}'")

    rg = c.get("revenue_geography", {})
    for key in ("profile", "confidence", "note"):
        if key not in rg:
            errors.append(f"{prefix}: revenue_geography missing '{key}'")
    if rg.get("profile") not in VALID_REVENUE_GEO:
        errors.append(f"{prefix}: revenue_geography.profile invalid '{rg.get('profile')}'")

    fm = c.get("financial_metrics", {})
    required_fm_fields = [
        "pe_ratio", "peg_ratio", "revenue_growth_yoy_pct", "profit_margin_pct", "roe_pct",
        "free_cash_flow_margin_pct", "analyst_consensus", "analyst_price_target_upside_pct",
        "six_month_return_pct", "one_year_return_pct", "confidence", "note",
        "overall_financial_score", "overall_financial_score_label",
    ]
    for key in required_fm_fields:
        if key not in fm:
            errors.append(f"{prefix}: financial_metrics missing '{key}'")
    # Fields scoring.js does NOT null-check must always be numeric.
    for key in ("revenue_growth_yoy_pct", "profit_margin_pct"):
        if fm.get(key) is None:
            errors.append(f"{prefix}: financial_metrics.{key} is null but scoring.js requires a number (not null-safe)")
    if fm.get("analyst_consensus") not in VALID_ANALYST_CONSENSUS:
        errors.append(f"{prefix}: financial_metrics.analyst_consensus invalid '{fm.get('analyst_consensus')}'")
    if fm.get("overall_financial_score_label") not in VALID_SCORE_LABELS:
        errors.append(f"{prefix}: financial_metrics.overall_financial_score_label invalid '{fm.get('overall_financial_score_label')}'")
    if fm.get("overall_financial_score") is None:
        errors.append(f"{prefix}: financial_metrics.overall_financial_score is null")

    return errors


def validate_file(path):
    with open(path) as f:
        data = json.load(f)

    errors = []
    if "meta" not in data:
        errors.append("top-level: missing 'meta'")
    if "companies" not in data or not isinstance(data["companies"], list):
        errors.append("top-level: missing/invalid 'companies' array")
        return errors

    tickers_seen = set()
    for idx, c in enumerate(data["companies"]):
        errors.extend(validate_company(c, idx))
        t = c.get("ticker")
        if t in tickers_seen:
            errors.append(f"duplicate ticker '{t}'")
        tickers_seen.add(t)

    return errors


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python3 scripts/validate_dataset.py <path-to-dataset.json>")
        sys.exit(1)

    path = sys.argv[1]
    errors = validate_file(path)
    if errors:
        print(f"FAILED: {len(errors)} validation errors")
        for e in errors[:100]:
            print(f"  - {e}")
        if len(errors) > 100:
            print(f"  ... and {len(errors) - 100} more")
        sys.exit(1)
    else:
        with open(path) as f:
            data = json.load(f)
        print(f"OK: {len(data['companies'])} companies, valid JSON, schema checks passed")
