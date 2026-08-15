"""Extraction helpers for Finnhub quote/profile2/metric/recommendation payloads."""


def analyst_consensus_from_trend(trend_list):
    """trend_list is the raw array from /stock/recommendation, most recent period first."""
    if not trend_list:
        return None
    latest = trend_list[0]
    strong_buy = latest.get("strongBuy", 0)
    buy = latest.get("buy", 0)
    hold = latest.get("hold", 0)
    sell = latest.get("sell", 0)
    strong_sell = latest.get("strongSell", 0)
    total = strong_buy + buy + hold + sell + strong_sell
    if total == 0:
        return None
    score = (strong_buy * 2 + buy * 1 + hold * 0 + sell * -1 + strong_sell * -2) / total
    if score >= 1.5:
        return "Strong Buy"
    if score >= 0.5:
        return "Buy"
    if score >= -0.5:
        return "Hold"
    if score >= -1.5:
        return "Sell"
    return "Strong Sell"


def safe_round(val, digits=2):
    if val is None:
        return None
    try:
        return round(float(val), digits)
    except (TypeError, ValueError):
        return None
