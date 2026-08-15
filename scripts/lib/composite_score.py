"""
Computes a fixed, dataset-wide overall_financial_score (0-100) per company
and a percentile-based label (Above Average/Average/Below Average), mirroring
the same 9-component equal-weight normalization the site's own scoring.js
uses for live per-client scoring (see financialQualityAlignment), but
computed once here for the client-facing summary display.
"""

NEUTRAL = 0.5


def _clamp01(v):
    return max(0.0, min(1.0, v))


def _pe_align(pe):
    if pe is None:
        return NEUTRAL
    return _clamp01((60 - pe) / (60 - 8))


def _peg_align(peg):
    if peg is None:
        return NEUTRAL
    return _clamp01((6 - peg) / (6 - 0.5))


def _growth_align(g):
    if g is None:
        return NEUTRAL
    return _clamp01((g - -5) / (40 - -5))


def _margin_align(m):
    if m is None:
        return NEUTRAL
    return _clamp01((m - -5) / (40 - -5))


def _roe_align(roe):
    if roe is None:
        return NEUTRAL
    capped = min(roe, 60)
    return _clamp01(capped / 60)


def _fcf_align(fcf):
    if fcf is None:
        return NEUTRAL
    return _clamp01((fcf - -5) / (35 - -5))


_CONSENSUS_SCORE = {"Strong Buy": 1.0, "Buy": 0.75, "Hold": 0.5, "Sell": 0.25, "Strong Sell": 0.0}


def _consensus_align(c):
    return _CONSENSUS_SCORE.get(c, NEUTRAL)


def _upside_align(u):
    if u is None:
        return NEUTRAL
    return _clamp01((u - -5) / (15 - -5))


def _return_align(r, beta):
    if r is None:
        return NEUTRAL
    risk_adjusted = r / beta if beta and beta > 0 else r
    return _clamp01((risk_adjusted - -10) / (40 * 1.25 - -10))


def raw_score_0_1(fm, beta):
    components = [
        _pe_align(fm["pe_ratio"]),
        _peg_align(fm["peg_ratio"]),
        _growth_align(fm["revenue_growth_yoy_pct"]),
        _margin_align(fm["profit_margin_pct"]),
        _roe_align(fm["roe_pct"]),
        _fcf_align(fm["free_cash_flow_margin_pct"]),
        _consensus_align(fm["analyst_consensus"]),
        _upside_align(fm["analyst_price_target_upside_pct"]),
        _return_align(fm["one_year_return_pct"], beta),
    ]
    return sum(components) / len(components)


def apply_composite_scores(companies):
    """Mutates each company's financial_metrics in place with
    overall_financial_score and a percentile-based overall_financial_score_label."""
    scored = []
    for c in companies:
        beta = c["market_profile"]["beta_est"]
        raw = raw_score_0_1(c["financial_metrics"], beta)
        score = round(raw * 100, 1)
        c["financial_metrics"]["overall_financial_score"] = score
        scored.append((score, c))

    scored.sort(key=lambda t: t[0])
    n = len(scored)
    for i, (score, c) in enumerate(scored):
        percentile = (i + 1) / n if n else 0.5
        if percentile <= 1 / 3:
            label = "Below Average"
        elif percentile <= 2 / 3:
            label = "Average"
        else:
            label = "Above Average"
        c["financial_metrics"]["overall_financial_score_label"] = label
