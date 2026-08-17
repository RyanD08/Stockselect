"""
SEC 8-K material-event summary, built entirely from data already fetched by
the base pipeline (the submissions JSON at data.sec.gov/submissions/CIK...
lists every recent filing's form type, date, and Item numbers) -- no extra
HTTP calls needed.

Item numbers are the SEC's own standardized 8-K item taxonomy (Regulation
S-K Item 601/8-K instructions), not a free-text classification we're
inferring, so this is an objective, High-confidence count straight from
filing metadata. It is NOT a substitute for actually reading the filings:
"Item 8.01 Other Events" in particular is a catch-all that can cover
anything from a routine press release to a major lawsuit settlement, so a
company having filed several Item 8.01 8-Ks is a signal to go read the
filings, not proof of anything on its own.
"""
import datetime

# The handful of 8-K items with an unambiguous, standardized meaning
# relevant to a values screen (bankruptcy, restatement/accounting failure,
# delisting, asset impairment). Everything else just gets counted by item
# number without a special label.
_NOTABLE_ITEM_LABELS = {
    "1.01": "Entry into a Material Definitive Agreement",
    "1.03": "Bankruptcy or Receivership",
    "2.04": "Triggering Events That Accelerate/Increase a Direct Financial Obligation",
    "2.06": "Material Impairments",
    "3.01": "Notice of Delisting or Failure to Satisfy a Listing Rule",
    "4.01": "Changes in Registrant's Certifying Accountant",
    "4.02": "Non-Reliance on Previously Issued Financial Statements (Restatement)",
    "5.02": "Departure/Election of Directors or Officers",
    "8.01": "Other Events",
}

_LITIGATION_SIGNAL_ITEMS = {"1.03", "2.06", "4.02"}


def summarize_8k_activity(sec_submission, as_of_date, lookback_years=2):
    """Returns a dict summarizing 8-K filings in the lookback window, or
    None if this company has no 8-K filings at all (e.g. a foreign private
    issuer that files 6-K instead)."""
    recent = sec_submission.get("filings", {}).get("recent", {})
    forms = recent.get("form", [])
    dates = recent.get("filingDate", [])
    items_raw = recent.get("items", [""] * len(forms))

    cutoff = as_of_date - datetime.timedelta(days=365 * lookback_years)

    item_counts = {}
    filing_count = 0
    for i, form in enumerate(forms):
        if form != "8-K":
            continue
        try:
            filed = datetime.date.fromisoformat(dates[i])
        except (ValueError, TypeError):
            continue
        if filed < cutoff:
            continue
        filing_count += 1
        for item in (items_raw[i] or "").split(","):
            item = item.strip()
            if item:
                item_counts[item] = item_counts.get(item, 0) + 1

    if filing_count == 0:
        return None

    labeled_counts = {
        item: {"label": _NOTABLE_ITEM_LABELS.get(item, "(see SEC Form 8-K item taxonomy)"), "count": count}
        for item, count in sorted(item_counts.items())
    }
    litigation_relevant_present = any(item in _LITIGATION_SIGNAL_ITEMS for item in item_counts)

    return {
        "lookback_years": lookback_years,
        "total_8k_filings": filing_count,
        "item_counts": labeled_counts,
        "bankruptcy_restatement_impairment_flag": litigation_relevant_present,
        "confidence": "High",
        "source": "SEC EDGAR submissions API (data.sec.gov/submissions/CIK...json), form=8-K entries' standardized Item numbers",
        "note": (
            "item_counts is an objective tally of standardized SEC 8-K item numbers filed in the "
            "trailing lookback window, not a text/sentiment analysis of filing content. "
            "bankruptcy_restatement_impairment_flag is true only for the three items with an "
            "unambiguous negative meaning (1.03 bankruptcy, 2.06 material impairment, 4.02 "
            "restatement); a high Item 8.01 ('Other Events') count is NOT flagged since that item "
            "is a routine catch-all and reading the underlying filings would be required to say "
            "whether any of them relate to litigation."
        ),
    }
