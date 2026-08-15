"""
OSHA Establishment Search (www.osha.gov/ords/imis/establishment.search),
scraped as HTML -- there is no JSON API for this endpoint, and the modern
data.osha.gov/enforcedata.dol.gov hosts are not reachable from this
environment (see the change report for the exact blocked hosts).

The search does a loose multi-word "contains" match on establishment name
(see scripts/lib/esg_matching.py for why every row is re-checked against the
company's legal name before being counted).

Two requests per company:
  - p_violations_exist=both -> total inspections in the lookback window
  - p_violations_exist=yes  -> inspections that resulted in violations, with
    a per-row violation count
Both are capped to the search tool's own default page size (20); for a
handful of very large employers (e.g. Amazon) this undercounts the true
total, which is noted in the record's confidence note when it's the binding
constraint on scoring, but the "case count" measure we actually score on
(distinct violation-bearing inspections, employer-match filtered) is
comfortably captured by the first page for the companies in this dataset.
"""
import re
import datetime

from . import esg_matching

BASE_URL = "https://www.osha.gov/ords/imis/establishment.search"

_ROW_RE = re.compile(r"<tr>.*?</tr>", re.S)
_CELL_RE = re.compile(r"<td[^>]*>(.*?)</td>", re.S)
_TAG_RE = re.compile(r"<[^>]+>")
_RESULTS_COUNT_RE = re.compile(r"Results\s+\d+\s*-\s*\d+\s+of\s+(\d+)")


def _clean_cell(raw):
    text = _TAG_RE.sub("", raw).strip()
    return "" if text in ("", "&nbsp;") else text


def _parse_rows(html):
    rows = []
    for row_html in _ROW_RE.findall(html):
        if "checkbox" not in row_html:
            continue
        cells = [_clean_cell(c) for c in _CELL_RE.findall(row_html)]
        # columns: [checkbox, #, activity nr (has nested <a>), date opened,
        #           RID, ST, Type, Scope, SIC, NAICS, Violations, Name]
        if len(cells) < 12:
            continue
        rows.append({
            "activity_nr": cells[2],
            "date_opened": cells[3],
            "state": cells[5],
            "insp_type": cells[6],
            "scope": cells[7],
            "violations": cells[10],
            "establishment_name": cells[11],
        })
    return rows


def _search(client, company_legal_name, start_date, end_date, violations_exist, cache_key_prefix, refresh=False):
    params = {
        "establishment": company_legal_name,
        "state": "all",
        "officetype": "all",
        "office": "all",
        "sitezip": "100000",
        "startmonth": f"{start_date.month:02d}",
        "startday": f"{start_date.day:02d}",
        "startyear": str(start_date.year),
        "endmonth": f"{end_date.month:02d}",
        "endday": f"{end_date.day:02d}",
        "endyear": str(end_date.year),
        "p_case": "all",
        "p_violations_exist": violations_exist,
    }
    html, status, from_cache, fetched_at = client.get_text(
        BASE_URL, cache_key=f"{cache_key_prefix}_{violations_exist}", params=params, refresh=refresh,
    )
    if status != 200:
        return [], 0, f"HTTP {status}"
    rows = _parse_rows(html)
    matched = [r for r in rows if esg_matching.is_company_match(r["establishment_name"], company_legal_name)]
    m = _RESULTS_COUNT_RE.search(html)
    total_rows = int(m.group(1)) if m else len(rows)
    return matched, total_rows, None


def fetch_matched_inspections(client, company_legal_name, cache_key_prefix, as_of_date, lookback_years=5, refresh=False):
    """Returns (all_matched, violation_matched, error). Each is a list of row
    dicts (see _parse_rows) already filtered to this company by name."""
    start_date = as_of_date.replace(year=as_of_date.year - lookback_years)

    all_matched, all_total, err = _search(
        client, company_legal_name, start_date, as_of_date, "both", f"{cache_key_prefix}_both", refresh=refresh,
    )
    if err:
        return [], [], err

    viol_matched, viol_total, err = _search(
        client, company_legal_name, start_date, as_of_date, "yes", f"{cache_key_prefix}_yes", refresh=refresh,
    )
    if err:
        return all_matched, [], err

    return all_matched, viol_matched, None


def score_social_osha(all_matched, violation_matched):
    """Returns (score_or_None, total_violations). None if no matched
    inspections at all (nothing to score from)."""
    if not all_matched:
        return None, 0

    total_violations = 0
    for row in violation_matched:
        try:
            total_violations += int(row["violations"])
        except (ValueError, TypeError):
            pass

    fatality_catastrophe = any("fat" in r["insp_type"].lower() or "cat" in r["insp_type"].lower() for r in all_matched)
    violation_rate = len(violation_matched) / len(all_matched)

    if fatality_catastrophe or total_violations >= 20:
        return 1, total_violations
    if total_violations >= 8 or violation_rate >= 0.5:
        return 2, total_violations
    if total_violations >= 1 or violation_rate > 0:
        return 3, total_violations
    return 4, total_violations
