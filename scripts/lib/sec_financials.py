"""
Extracts fundamentals from an SEC EDGAR XBRL companyfacts payload.

Only annual facts are used (10-K for US domestic filers, 20-F/40-F for
foreign private issuers) so revenue growth and margins compare like-for-like
periods. Foreign filers often report under the ifrs-full taxonomy instead of
us-gaap, and in their local reporting currency rather than USD -- both are
supported here. This is safe because every derived metric used downstream
(revenue growth %, profit margin %, ROE %, FCF margin %) is a same-company
ratio, so currency cancels out; no FX conversion is needed or performed.
Absolute dollar figures are never exposed in the output schema.
"""
import datetime

ANNUAL_FORMS = {"10-K", "10-K/A", "20-F", "20-F/A", "40-F", "40-F/A"}

# (taxonomy, tag) pairs, checked in order; first taxonomy+tag with usable
# annual records wins. us-gaap variants cover different filer conventions
# (standard operating companies, banks/broker-dealers, regulated utilities,
# software companies using the "including assessed tax" revenue variant);
# ifrs-full covers foreign private issuers reporting under IFRS.
REVENUE_TAGS = [
    ("us-gaap", "RevenueFromContractWithCustomerExcludingAssessedTax"),
    ("us-gaap", "RevenueFromContractWithCustomerIncludingAssessedTax"),
    ("us-gaap", "Revenues"),
    ("us-gaap", "RevenuesNetOfInterestExpense"),  # banks / broker-dealers (e.g. Goldman Sachs)
    ("us-gaap", "RegulatedAndUnregulatedOperatingRevenue"),  # regulated utilities
    ("us-gaap", "SalesRevenueNet"),
    ("us-gaap", "SalesRevenueGoodsNet"),
    ("ifrs-full", "Revenue"),
    ("ifrs-full", "RevenueFromContractsWithCustomers"),
    ("ifrs-full", "RevenueFromSaleOfGoods"),  # some IFRS filers only tag this sub-component (e.g. Novartis)
]
NET_INCOME_TAGS = [
    ("us-gaap", "NetIncomeLoss"),
    ("us-gaap", "ProfitLoss"),
    ("ifrs-full", "ProfitLoss"),
    ("ifrs-full", "ProfitLossAttributableToOwnersOfParent"),
]
ASSETS_TAGS = [("us-gaap", "Assets"), ("ifrs-full", "Assets")]
LIABILITIES_TAGS = [("us-gaap", "Liabilities"), ("ifrs-full", "Liabilities")]
EQUITY_TAGS = [
    ("us-gaap", "StockholdersEquity"),
    ("us-gaap", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"),
    ("ifrs-full", "Equity"),
    ("ifrs-full", "EquityAttributableToOwnersOfParent"),
]
OP_CASH_FLOW_TAGS = [
    ("us-gaap", "NetCashProvidedByUsedInOperatingActivities"),
    ("us-gaap", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"),
    ("ifrs-full", "CashFlowsFromUsedInOperatingActivities"),
]
CAPEX_TAGS = [
    ("us-gaap", "PaymentsToAcquirePropertyPlantAndEquipment"),
    ("us-gaap", "PaymentsToAcquireProductiveAssets"),
    ("ifrs-full", "PurchaseOfPropertyPlantAndEquipment"),
    ("ifrs-full", "PaymentsForPropertyPlantAndEquipment"),
]
EPS_DILUTED_TAGS = [("us-gaap", "EarningsPerShareDiluted")]

NON_MONETARY_UNIT_SUFFIXES = ("shares", "pure")


def _duration_days(rec):
    if "start" not in rec or "end" not in rec:
        return None
    try:
        start = datetime.date.fromisoformat(rec["start"])
        end = datetime.date.fromisoformat(rec["end"])
        return (end - start).days
    except ValueError:
        return None


def _usable_unit_keys(units_dict):
    """Prefer USD if present; otherwise fall back to whichever single
    monetary currency unit the filer reports in (foreign private issuers
    often report only in their local currency)."""
    if "USD" in units_dict:
        return ["USD"]
    monetary_keys = [k for k in units_dict if not any(k.lower().endswith(s) for s in NON_MONETARY_UNIT_SUFFIXES)]
    return monetary_keys


def _annual_series(facts, tag_pairs, instant=False):
    """Return annual records across all matching (taxonomy, tag) pairs,
    sorted by end date descending."""
    records = []
    for taxonomy, tag in tag_pairs:
        taxonomy_facts = facts.get(taxonomy, {})
        if tag not in taxonomy_facts:
            continue
        units = taxonomy_facts[tag]["units"]
        for unit_key in _usable_unit_keys(units):
            for r in units[unit_key]:
                if r.get("form") not in ANNUAL_FORMS:
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


def _latest(facts, tag_pairs, instant=False):
    series = _annual_series(facts, tag_pairs, instant=instant)
    return series[0] if series else None


def _prior_year(facts, tag_pairs, latest_rec, instant=False):
    """Find the annual record for the period ending ~1 year before latest_rec's end."""
    if latest_rec is None:
        return None
    series = _annual_series(facts, tag_pairs, instant=instant)
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
    Returns a dict of the most recent annual fundamentals plus
    year-over-year revenue growth, or None fields where not available.
    """
    facts = company_facts.get("facts", {})

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

    rev = _latest(facts, REVENUE_TAGS)
    if rev:
        out["revenue"] = rev["val"]
        out["fiscal_year_end"] = rev["end"]
        out["filed_date"] = rev.get("filed")
        prior = _prior_year(facts, REVENUE_TAGS, rev)
        if prior:
            out["revenue_prior_year"] = prior["val"]

    ni = _latest(facts, NET_INCOME_TAGS)
    if ni:
        out["net_income"] = ni["val"]

    assets = _latest(facts, ASSETS_TAGS, instant=True)
    if assets:
        out["assets"] = assets["val"]

    liab = _latest(facts, LIABILITIES_TAGS, instant=True)
    if liab:
        out["liabilities"] = liab["val"]

    eq = _latest(facts, EQUITY_TAGS, instant=True)
    if eq:
        out["equity"] = eq["val"]

    ocf = _latest(facts, OP_CASH_FLOW_TAGS)
    if ocf:
        out["operating_cash_flow"] = ocf["val"]

    capex = _latest(facts, CAPEX_TAGS)
    if capex:
        out["capex"] = capex["val"]

    eps = _latest(facts, EPS_DILUTED_TAGS)
    if eps:
        out["eps_diluted"] = eps["val"]

    return out


# Different fundamentals for the same company can, in rare cases, resolve
# from different taxonomy/currency sources (e.g. a dual-reporting foreign
# filer with revenue in one currency and net income in another). Ratios
# computed across mismatched currencies produce a wrong but plausible-looking
# number rather than a crash, so implausible results are treated as not
# computable (None) instead of trusted.
def _plausible(pct, bound):
    return pct if pct is not None and abs(pct) <= bound else None


def revenue_growth_pct(fundamentals):
    rev, prior = fundamentals["revenue"], fundamentals["revenue_prior_year"]
    if rev is None or prior is None or prior == 0:
        return None
    return _plausible(round((rev - prior) / abs(prior) * 100, 2), 500)


def profit_margin_pct(fundamentals):
    rev, ni = fundamentals["revenue"], fundamentals["net_income"]
    if rev is None or ni is None or rev == 0:
        return None
    return _plausible(round(ni / rev * 100, 2), 300)


def roe_pct(fundamentals):
    ni, eq = fundamentals["net_income"], fundamentals["equity"]
    if ni is None or eq is None or eq <= 0:
        return None
    return _plausible(round(ni / eq * 100, 2), 500)


def fcf_margin_pct(fundamentals):
    rev, ocf, capex = fundamentals["revenue"], fundamentals["operating_cash_flow"], fundamentals["capex"]
    if rev is None or ocf is None or rev == 0:
        return None
    capex = capex or 0
    return _plausible(round((ocf - capex) / rev * 100, 2), 300)
