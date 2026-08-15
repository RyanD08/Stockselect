"""Assembles one company record matching the exact schema of
data/values_portfolio_dataset_v5_100.json from raw SEC + Finnhub payloads.
"""
from . import mapping
from . import sec_financials as secfin
from .finnhub_metrics import analyst_consensus_from_trend, safe_round

NO_LIVE_ESG_NOTE = (
    "No live per-company ESG data source is available on this Finnhub API tier "
    "(the /stock/esg endpoint requires a premium plan) and no paid ESG vendor is in "
    "use. Neutral placeholder pending a licensed ESG data feed -- not a verified rating."
)

NO_OWNERSHIP_NOTE = (
    "Founder/family-ownership status is not derivable from SEC EDGAR or the available "
    "Finnhub API tier (ownership endpoint requires a premium plan) at this scale. "
    "Defaults to false rather than an unverified guess; replace with a real ownership "
    "data source before production use."
)

REVENUE_GEO_NOTE = (
    "No standardized per-company geographic revenue segment data was pulled for this "
    "field (SEC XBRL geographic-segment tagging is inconsistent across filers). "
    "Sector-level heuristic default, not a verified per-company fact; replace with "
    "exact 10-K segment revenue breakdown before production use."
)

FIVE_YEAR_RETURN_NOTE = (
    "Historical price data (needed for a real 5-year annualized return) requires a "
    "premium Finnhub plan and was not available on this API key. Left null rather than "
    "estimated; the site's scoring treats a null return as neutral for this metric."
)

PRICE_TARGET_NOTE = (
    "Analyst price-target data requires a premium Finnhub plan and was not available on "
    "this API key. Left null rather than estimated; the site's scoring treats a null "
    "upside as neutral for this metric."
)

PARTIAL_REVENUE_PROXY_NOTE = (
    "This company has no full-revenue XBRL tag available (common for some bank holding "
    "companies); revenue_growth_yoy_pct, profit_margin_pct, and free_cash_flow_margin_pct "
    "are computed against interest income alone as the closest available proxy, which "
    "understates true revenue and will overstate margin ratios. Confidence lowered to Low "
    "for this reason."
)

PERFORMANCE_TIER_NOTE = (
    "growth_potential/stability/risk_profile_fit are heuristically derived from beta and "
    "revenue growth (not a qualitative analyst judgment); five_year_annualized_return_pct_est "
    "is null -- see note. Replace with live data/analyst judgment before production use."
)


def _revenue_geography_profile(sector):
    domestic_sectors = {"Financials", "Real Estate", "Utilities"}
    return "Primarily Domestic" if sector in domestic_sectors else "Globally Diversified"


def _growth_potential(revenue_growth):
    if revenue_growth is None:
        return "Medium"
    if revenue_growth >= 15:
        return "High"
    if revenue_growth >= 3:
        return "Medium"
    return "Low"


def _stability(beta):
    if beta is None:
        return "Medium"
    if beta < 0.9:
        return "High"
    if beta <= 1.3:
        return "Medium"
    return "Low"


def _risk_profile_fit(beta, dividend_status):
    if beta is not None and beta < 0.8 and dividend_status == "Payer":
        return "Conservative"
    if beta is not None and beta > 1.3:
        return "Growth"
    return "Balanced"


class MissingDataError(Exception):
    """Raised when a company lacks enough real data to build a valid record."""


def build_company_record(ticker, sec_submission, sec_facts, fh_profile, fh_metric, fh_quote, fh_recommendation, metric_fetched_at=None):
    name = sec_submission.get("name") or fh_profile.get("name") or ticker
    sic_raw = sec_submission.get("sic")
    sic = int(sic_raw) if sic_raw not in (None, "") else None
    sic_description = sec_submission.get("sicDescription")
    sector = mapping.sic_to_sector(sic)
    hq_country = mapping.hq_country_from_address(sec_submission.get("addresses"))

    fundamentals = secfin.extract_fundamentals(sec_facts)
    if fundamentals["revenue"] is None or fundamentals["net_income"] is None:
        raise MissingDataError(f"{ticker}: no annual revenue/net income in SEC XBRL data")

    revenue_growth = secfin.revenue_growth_pct(fundamentals)
    profit_margin = secfin.profit_margin_pct(fundamentals)
    roe = secfin.roe_pct(fundamentals)
    # Operating cash flow isn't a meaningful FCF-margin signal for financial-sector
    # companies (deposit/loan flows dominate it, not core business cash generation) --
    # not meaningful, so null it, same convention as the current dataset.
    fcf_margin = None if sector == "Financials" else secfin.fcf_margin_pct(fundamentals)
    leverage = mapping.leverage_level(fundamentals["liabilities"], fundamentals["equity"])

    m = fh_metric.get("metric", {}) if isinstance(fh_metric, dict) else {}
    beta = safe_round(m.get("beta"), 3)
    market_cap_millions = fh_profile.get("marketCapitalization") if isinstance(fh_profile, dict) else None
    cap_tier = mapping.market_cap_tier(market_cap_millions)
    six_month_return = safe_round(m.get("26WeekPriceReturnDaily"))
    one_year_return = safe_round(m.get("52WeekPriceReturnDaily"))
    dividend_yield = m.get("dividendYieldIndicatedAnnual")
    dividend_status = "Payer" if dividend_yield and dividend_yield > 0 else "Non-payer"
    yield_tier = mapping.dividend_yield_tier(dividend_yield)

    pe_ratio = safe_round(m.get("peBasicExclExtraTTM") or m.get("peExclExtraTTM"))
    # PEG isn't meaningful without positive growth, regardless of what Finnhub reports.
    if revenue_growth is not None and revenue_growth > 0:
        peg_ratio = safe_round(m.get("pegRatio"))
        if peg_ratio is None and pe_ratio is not None:
            peg_ratio = safe_round(pe_ratio / revenue_growth)
    else:
        peg_ratio = None

    analyst_consensus = analyst_consensus_from_trend(fh_recommendation) or "Hold"

    revenue_geography_profile = _revenue_geography_profile(sector)
    growth_potential = _growth_potential(revenue_growth)
    stability = _stability(beta)
    risk_profile_fit = _risk_profile_fit(beta, dividend_status)

    record = {
        "ticker": ticker,
        "name": name,
        "sector": sector,
        "hq_country": hq_country,
        "founder_led": False,
        "family_owned": False,
        "sin_stock_flags": mapping.sin_stock_flags(sic, name),
        "animal_testing_exposure": mapping.animal_testing_exposure_text(sic, sector),
        "esg_ratings": {
            "environmental": {"score": 3, "confidence": "Low", "note": NO_LIVE_ESG_NOTE},
            "social_labor": {"score": 3, "confidence": "Low", "note": NO_LIVE_ESG_NOTE},
            "governance": {"score": 3, "confidence": "Low", "note": NO_LIVE_ESG_NOTE},
        },
        "performance_tier": {
            "growth_potential": growth_potential,
            "stability": stability,
            "risk_profile_fit": risk_profile_fit,
            "five_year_annualized_return_pct_est": None,
            "confidence": "Low",
            "note": PERFORMANCE_TIER_NOTE + " " + FIVE_YEAR_RETURN_NOTE,
        },
        "market_profile": {
            "market_cap_usd_billions_est": safe_round(market_cap_millions / 1000, 3) if market_cap_millions else None,
            "market_cap_tier": cap_tier,
            "beta_est": beta,
            "confidence": "Medium",
            "note": "market_cap and beta from Finnhub live market data (profile2 / metric endpoints).",
        },
        "financial_leverage": {
            "level": leverage,
            "confidence": "Medium" if leverage else "Low",
            "note": "Derived from SEC XBRL total liabilities / total stockholders' equity (most recent 10-K); simple global thresholds, not sector-relative.",
        },
        "dividend_policy": {
            "status": dividend_status,
            "yield_tier": yield_tier,
            "confidence": "Medium",
            "note": "status/yield_tier derived from Finnhub live dividendYieldIndicatedAnnual.",
        },
        "revenue_geography": {
            "profile": revenue_geography_profile,
            "confidence": "Low",
            "note": REVENUE_GEO_NOTE,
        },
        "financial_metrics": {
            "pe_ratio": pe_ratio,
            "peg_ratio": peg_ratio,
            "revenue_growth_yoy_pct": revenue_growth if revenue_growth is not None else 0.0,
            "profit_margin_pct": profit_margin if profit_margin is not None else 0.0,
            "roe_pct": roe,
            "free_cash_flow_margin_pct": fcf_margin,
            "analyst_consensus": analyst_consensus,
            "analyst_price_target_upside_pct": None,
            "six_month_return_pct": six_month_return if six_month_return is not None else 0.0,
            "one_year_return_pct": one_year_return if one_year_return is not None else 0.0,
            "last_refreshed": metric_fetched_at,  # UTC ISO timestamp of the Finnhub metric pull this return data came from; null for cache entries written before this field existed
            "confidence": "Low" if fundamentals["revenue_is_partial_proxy"] else "Medium",
            "note": (
                "P/E, PEG, revenue growth, margins, ROE, FCF margin from SEC EDGAR XBRL "
                "(most recent annual filing) and Finnhub live TTM metrics. analyst_consensus from "
                "Finnhub analyst recommendation trend. " + PRICE_TARGET_NOTE
                + (" " + PARTIAL_REVENUE_PROXY_NOTE if fundamentals["revenue_is_partial_proxy"] else "")
            ),
            "overall_financial_score": None,  # filled in by a post-process pass (percentile-based label needs the full batch)
            "overall_financial_score_label": None,
        },
    }
    debug_info = {"sic": sic, "sic_description": sic_description}
    return record, debug_info
