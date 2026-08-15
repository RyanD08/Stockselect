"""
Extracts fundamentals from an SEC EDGAR XBRL companyfacts payload.
Only annual (10-K, ~1yr duration) facts are used so revenue growth and
margins compare like-for-like periods.
"""
import datetime

REVENUE_TAGS = [
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "Revenues",
    "SalesRevenueNet",
    "SalesRevenueGoodsNet",
]
NET_INCOME_TAGS = ["NetIncomeLoss", "ProfitLoss"]
ASSETS_TAGS = ["Assets"]
LIABILITIES_TAGS = ["Liabilities"]
EQUITY_TAGS = [
    "StockholdersEquity",
    "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
]
OP_CASH_FLOW_TAGS = ["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"]
CAPEX_TAGS = ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"]
EPS_DILUTED_TAGS = ["EarningsPerShareDiluted"]


def _duration_days(rec):
    if "start" not in rec or "end" not in rec:
        return None
    try:
        start = datetime.date.fromisoformat(rec["start"])
        end = datetime.date.fromisoformat(rec["end"])
        return (end - start).days
    except ValueError:
        return None


def _annual_series(facts_gaap, tags, instant=False):
    """Return annual (10-K) records across all matching tags, sorted by end date descending."""
    records = []
    for tag in tags:
        if tag not in facts_gaap:
            continue
        for unit_key, recs in facts_gaap[tag]["units"].items():
            if unit_key not in ("USD", "USD/shares", "shares"):
                continue
            for r in recs:
                if r.get("form") != "10-K":
                    continue
                if instant:
                    if "start" in r:
                        continue  # instant facts have no start
                else:
                    days = _duration_days(r)
                    if days is None or not (330 <= days <= 400):
                        continue
                records.append(r)
    records.sort(key=lambda r: (r["end"], r.get("filed", "")), reverse=True)
    return records


def _latest(facts_gaap, tags, instant=False):
    series = _annual_series(facts_gaap, tags, instant=instant)
    return series[0] if series else None


def _prior_year(facts_gaap, tags, latest_rec, instant=False):
    """Find the annual record for the period ending ~1 year before latest_rec's end."""
    if latest_rec is None:
        return None
    series = _annual_series(facts_gaap, tags, instant=instant)
    latest_end = datetime.date.fromisoformat(latest_rec["end"])
    target = latest_end.replace(year=latest_end.year - 1)
    best = None
    best_diff = None
    for r in series:
        if r["end"] == latest_rec["end"]:
            continue
        end = datetime.date.fromisoformat(r["end"])
        diff = abs((end - target).days)
        if diff <= 45 and (best_diff is None or diff < best_diff):
            best = r
            best_diff = diff
    return best


def extract_fundamentals(company_facts):
    """
    Returns a dict of the most recent annual (10-K) fundamentals plus
    year-over-year revenue growth, or None fields where not available.
    """
    facts = company_facts.get("facts", {})
    gaap = facts.get("us-gaap", {})

    out = {
        "revenue": None,
        "revenue_prior_year": None,
        "net_income": None,
        "assets": None,
        "liabilities": None,
        "equity": None,
        "operating_cash_flow": None,
        "capex": None,
        "eps_diluted": None,
        "fiscal_year_end": None,
        "filed_date": None,
    }

    rev = _latest(gaap, REVENUE_TAGS)
    if rev:
        out["revenue"] = rev["val"]
        out["fiscal_year_end"] = rev["end"]
        out["filed_date"] = rev.get("filed")
        prior = _prior_year(gaap, REVENUE_TAGS, rev)
        if prior:
            out["revenue_prior_year"] = prior["val"]

    ni = _latest(gaap, NET_INCOME_TAGS)
    if ni:
        out["net_income"] = ni["val"]

    assets = _latest(gaap, ASSETS_TAGS, instant=True)
    if assets:
        out["assets"] = assets["val"]

    liab = _latest(gaap, LIABILITIES_TAGS, instant=True)
    if liab:
        out["liabilities"] = liab["val"]

    eq = _latest(gaap, EQUITY_TAGS, instant=True)
    if eq:
        out["equity"] = eq["val"]

    ocf = _latest(gaap, OP_CASH_FLOW_TAGS)
    if ocf:
        out["operating_cash_flow"] = ocf["val"]

    capex = _latest(gaap, CAPEX_TAGS)
    if capex:
        out["capex"] = capex["val"]

    eps = _latest(gaap, EPS_DILUTED_TAGS)
    if eps:
        out["eps_diluted"] = eps["val"]

    return out


def revenue_growth_pct(fundamentals):
    rev, prior = fundamentals["revenue"], fundamentals["revenue_prior_year"]
    if rev is None or prior is None or prior == 0:
        return None
    return round((rev - prior) / abs(prior) * 100, 2)


def profit_margin_pct(fundamentals):
    rev, ni = fundamentals["revenue"], fundamentals["net_income"]
    if rev is None or ni is None or rev == 0:
        return None
    return round(ni / rev * 100, 2)


def roe_pct(fundamentals):
    ni, eq = fundamentals["net_income"], fundamentals["equity"]
    if ni is None or eq is None or eq <= 0:
        return None
    return round(ni / eq * 100, 2)


def fcf_margin_pct(fundamentals):
    rev, ocf, capex = fundamentals["revenue"], fundamentals["operating_cash_flow"], fundamentals["capex"]
    if rev is None or ocf is None or rev == 0:
        return None
    capex = capex or 0
    return round((ocf - capex) / rev * 100, 2)
