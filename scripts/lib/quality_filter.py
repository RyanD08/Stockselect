"""
Excludes companies unreasonable for an automated portfolio-suggestion tool
to recommend, even though they're real SEC filers with usable financial data.

This is a judgment screen, not a data-availability screen (MissingDataError
in build_record.py already handles "we don't have real data" -- this handles
"we have real data, but recommending this specific company would be
irresponsible"). Applied after building all records so composite-score
percentile labels are computed on the final, filtered population.
"""

BLANK_CHECK_SIC = 6770  # SPACs / shell companies with no real operating business
MIN_MARKET_CAP_USD_MILLIONS = 300  # excludes nano/micro-cap and penny-stock territory
MAX_PLAUSIBLE_BETA = 5  # beyond this, it's almost always a thin-trading data artifact, not a real risk signal


def exclusion_reason(company, sic):
    """Returns a human-readable reason string if this company should be
    excluded, or None if it passes."""
    if sic == BLANK_CHECK_SIC:
        return "SIC 6770 (Blank Check / SPAC) -- no real operating business"

    market_cap_billions = company["market_profile"]["market_cap_usd_billions_est"]
    if market_cap_billions is None:
        return "no market cap data available (can't size or verify this is a real, tradeable company)"
    if market_cap_billions * 1000 < MIN_MARKET_CAP_USD_MILLIONS:
        return f"market cap ${market_cap_billions * 1000:.1f}M below ${MIN_MARKET_CAP_USD_MILLIONS}M floor (nano-cap/penny-stock territory)"

    beta = company["market_profile"]["beta_est"]
    if beta is not None and abs(beta) > MAX_PLAUSIBLE_BETA:
        return f"beta {beta} implausible (|beta|>{MAX_PLAUSIBLE_BETA}, almost always a thin-trading data artifact)"

    return None


def filter_unreasonable_companies(companies, debug_by_ticker):
    kept = []
    excluded = []
    for c in companies:
        sic = debug_by_ticker.get(c["ticker"], {}).get("sic")
        reason = exclusion_reason(c, sic)
        if reason:
            excluded.append((c["ticker"], reason))
        else:
            kept.append(c)
    return kept, excluded
