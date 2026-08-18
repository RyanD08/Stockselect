"""
Domestic (U.S.) revenue mix, sourced from the geographic-segment footnote
of a company's most recent 10-K.

Two approaches were tested live against real filings before writing this
module:
  - SEC's XBRL Frames API (data.sec.gov/api/xbrl/frames/...) and the
    per-company companyconcept API were both confirmed reachable, but both
    only return the *non-dimensional* (whole-entity) value of a concept --
    geographic segment revenue is filed with an XBRL dimension
    (srt:StatementGeographicalAxis / country member) attached, which
    neither of those two APIs exposes. Confirmed empirically: Apple's
    companyconcept RevenueFromContractWithCustomerExcludingAssessedTax
    series returns only consolidated totals, never a US-only figure.
  - The company's own rendered XBRL viewer report ("R-file") for the
    geographic-segment note, discovered via FilingSummary.xml, DOES expose
    the dimensional breakdown as a small, already-HTML-rendered table
    (confirmed against Apple's actual FY2025 10-K: R69.htm cleanly states
    "U.S. ... Net sales ... 151,790" against a total of "416,161"). This is
    the approach this module uses -- a real per-company figure from the
    primary source (10-K note), not a sector heuristic.
Coverage is inherently partial: not every filer breaks out a distinct
"United States" line (some report by broader region only, e.g. "Americas"
lumped with Canada/Latin America, which is NOT usable as a domestic-only
figure and is deliberately NOT treated as one here), and not every filer's
segment note is even geographic (some report only by product/business
segment). Both cases fall through to an explicit "not found" rather than
guessing.
"""
import re

from .sec_text import html_to_text, filing_summary_url, parse_filing_summary_reports, r_file_url

_GEO_REPORT_RE = re.compile(r"geograph", re.I)
_SEGMENT_NET_SALES_RE = re.compile(r"segment.*(net sales|revenue)|(net sales|revenue).*countr", re.I)

# A row label counts as "the whole company" only if it's one of these
# (case-insensitive), appearing on its own line/segment before any numbers.
# Checked in order -- the more specific "total X" labels first, bare
# "revenue"/"revenues" last as a fallback (many filers' R-files just label
# the top total row "Revenue", not "Total Revenue" -- confirmed missing on
# a real filing, Eli Lilly's, whose total row is plain "Revenue $65,179").
_TOTAL_LABELS = (
    "total net sales", "net sales", "total revenue", "total revenues",
    "consolidated net sales", "revenues", "revenue",
)
_US_LABELS = ("united states", "u.s.", "us", "domestic")
# Explicitly NOT usable as a domestic-only figure -- a broader region.
_NON_DOMESTIC_ONLY_LABELS = ("americas", "north america")

_ROW_RE = re.compile(
    r"\b([A-Za-z][A-Za-z .&\-]{2,40}?)\s*(?:\|)?\s*\$?\s*([\d,]{4,})\b"
)


def _find_geo_reports(reports):
    out = []
    for short_name, html_file in reports:
        if "(Tables)" in short_name or "(Policies)" in short_name:
            continue
        if _GEO_REPORT_RE.search(short_name):
            out.append((short_name, html_file))

    def _priority(sc):
        name_lower = sc[0].lower()
        has_details = "details" in name_lower
        # A filer's FilingSummary.xml often has more than one geographic
        # R-file -- e.g. a revenue-by-geography table AND a separate
        # long-lived-assets/property-by-geography table (confirmed on a
        # real filing, Eli Lilly's: R49 is revenue, R70 is property/
        # equipment). Only the revenue one is usable here, so it must sort
        # first; a details-table with no revenue/sales word in its title is
        # deprioritized rather than excluded outright (still tried as a
        # fallback in case its content turns out to include revenue anyway).
        is_revenue_titled = bool(re.search(r"revenue|net sales|sales", name_lower))
        return (0 if has_details and is_revenue_titled else 1 if has_details else 2)

    out.sort(key=_priority)
    return out


def _extract_domestic_pct_from_table_text(text):
    """Very small line-item parser: looks for a 'United States'/'U.S.' label
    followed reasonably closely by a dollar figure, and a total (net
    sales/revenue) figure elsewhere in the same table text. Returns
    (us_value, total_value, matched_us_label) or (None, None, None)."""
    # Normalize " - " placeholders and stray pipes from html_to_text's tag
    # replacement so number-adjacency regexes aren't thrown off.
    t = re.sub(r"\s*-\s*", " ", text)

    us_value = None
    us_label_matched = None
    for label in _US_LABELS:
        # word-boundary match on the label, not inside a larger word/phrase
        for lm in re.finditer(r"(?<![A-Za-z])" + re.escape(label) + r"(?![A-Za-z])", t, re.I):
            window = t[lm.end():lm.end() + 200]
            num_m = re.search(r"\$?\s*([\d][\d,]{3,})\b", window)
            if num_m:
                try:
                    us_value = int(num_m.group(1).replace(",", ""))
                    us_label_matched = label
                    break
                except ValueError:
                    continue
        if us_value is not None:
            break

    total_value = None
    for label in _TOTAL_LABELS:
        m = re.search(re.escape(label) + r"[^\d]{0,60}?\$?\s*([\d][\d,]{3,})\b", t, re.I)
        if m:
            try:
                total_value = int(m.group(1).replace(",", ""))
                break
            except ValueError:
                continue

    return us_value, total_value, us_label_matched


def fetch_domestic_revenue_mix(client, cik, accession, primary_doc_10k_text, filing_url, filing_date, cache_key_prefix, refresh=False):
    """Returns (result_dict, error)."""
    fs_url = filing_summary_url(cik, accession)
    xml_text, status, _fc, _fa = client.get_text(fs_url, cache_key=f"{cache_key_prefix}_fs", refresh=refresh)
    if status != 200:
        return None, f"HTTP {status} fetching FilingSummary.xml"

    reports = parse_filing_summary_reports(xml_text)
    geo_reports = _find_geo_reports(reports)
    if not geo_reports:
        return None, "no geographic-segment R-file found in this 10-K's FilingSummary.xml (company may only report by product/business segment, not geography)"

    for short_name, html_file in geo_reports[:4]:
        r_url = r_file_url(cik, accession, html_file)
        html, status2, _fc2, _fa2 = client.get_text(r_url, cache_key=f"{cache_key_prefix}_{html_file}", refresh=refresh)
        if status2 != 200:
            continue
        text = html_to_text(html)
        if any(nl in text.lower()[:400] for nl in _NON_DOMESTIC_ONLY_LABELS) and not any(
            re.search(r"(?<![A-Za-z])" + re.escape(l) + r"(?![A-Za-z])", text, re.I) for l in ("united states", "u.s.")
        ):
            # This report only breaks out a broader region (e.g. "Americas"), no US-only line -- not usable.
            continue
        us_value, total_value, us_label = _extract_domestic_pct_from_table_text(text)
        if us_value and total_value and total_value > 0 and 0 < us_value <= total_value:
            pct = round(us_value / total_value * 100, 1)
            return {
                "domestic_revenue_pct": pct,
                "us_value_reported": us_value,
                "total_value_reported": total_value,
                "matched_label": us_label,
                "confidence": "High",
                "source": f"SEC EDGAR 10-K filed {filing_date}, geographic-segment note ({r_url})",
                "note": (
                    f"Extracted directly from the '{short_name}' table in this filing's structured "
                    "XBRL viewer report (R-file). SEC's XBRL Frames/companyconcept APIs were tried "
                    "first but only expose non-dimensional (whole-company) values -- geographic "
                    "segment data requires reading the dimensional table itself, which is what this "
                    "figure is sourced from."
                ),
            }, None

    return None, (
        "found a geographic-segment R-file in this 10-K but could not extract a usable "
        "United States/domestic revenue line from it (may report by broader region only, "
        "e.g. 'Americas', or use a table layout this parser doesn't recognize)"
    )
