"""
EPA ECHO (Enforcement and Compliance History Online, echodata.epa.gov)
per-company environmental enforcement lookup. Free, no API key.

Flow (EPA ECHO's own documented REST pattern):
  1. get_facilities?p_fn=<name>&output=JSON -> a QueryID for the search
  2. get_qid?qid=<QueryID>&output=JSON -> the actual facility list with
     per-facility compliance/enforcement fields

get_facilities does a loose multi-word "contains" search on facility name,
which returns plenty of unrelated organizations that happen to share a word
with the target company (see scripts/lib/esg_matching.py). Every returned
facility is filtered through is_company_match() against the company's SEC
legal name before anything is counted, trading recall for precision.
"""
import datetime
import json

from . import esg_matching

BASE_URL = "https://echodata.epa.gov/echo/echo_rest_services"


def _get_json(client, path, params, cache_key, refresh=False):
    url = f"{BASE_URL}.{path}"
    body, status, from_cache, fetched_at = client.get_json(url, cache_key, params=params, refresh=refresh)
    return body, status


def _parse_date(s):
    if not s:
        return None
    try:
        return datetime.datetime.strptime(s, "%m/%d/%Y").date()
    except ValueError:
        return None


def fetch_matched_facilities(client, company_legal_name, cache_key_prefix, refresh=False):
    """Returns (matched_facilities, total_rows_searched, error) for a company.
    matched_facilities is a list of raw facility dicts from ECHO that passed
    the strict name match. error is a string if the search itself failed."""
    search_body, status = _get_json(
        client, "get_facilities",
        {"p_fn": company_legal_name, "output": "JSON"},
        cache_key=f"{cache_key_prefix}_search",
        refresh=refresh,
    )
    if status != 200:
        return [], 0, f"HTTP {status}"

    results = search_body.get("Results", {}) if isinstance(search_body, dict) else {}
    if "Error" in results:
        return [], 0, results["Error"].get("ErrorMessage", "unknown ECHO error")

    query_id = results.get("QueryID")
    total_rows = int(results.get("QueryRows", 0) or 0)
    if not query_id or total_rows == 0:
        return [], total_rows, None

    qid_body, qid_status = _get_json(
        client, "get_qid",
        {"qid": query_id, "output": "JSON"},
        cache_key=f"{cache_key_prefix}_qid",
        refresh=refresh,
    )
    if qid_status != 200:
        return [], total_rows, f"HTTP {qid_status} on get_qid"

    qid_results = qid_body.get("Results", {}) if isinstance(qid_body, dict) else {}
    if "Error" in qid_results:
        return [], total_rows, qid_results["Error"].get("ErrorMessage", "unknown ECHO error")

    facilities = qid_results.get("Facilities", []) or []
    matched = [f for f in facilities if esg_matching.is_company_match(f.get("FacName"), company_legal_name)]
    return matched, total_rows, None


def score_environmental(matched_facilities, as_of_date, lookback_years=5):
    """Derive a 1-5 environmental score (5 = cleanest) from EPA ECHO
    per-facility compliance fields for facilities matched to this company.
    Returns None if the matched facilities carry no usable compliance signal
    (e.g. registered but never inspected) -- caller should leave the
    placeholder untouched in that case rather than invent a score."""
    if not matched_facilities:
        return None

    cutoff = as_of_date - datetime.timedelta(days=365 * lookback_years)

    has_snc = False
    has_qtrs_nc = False
    recent_formal_action = False
    recent_penalty = False
    was_inspected = False

    for f in matched_facilities:
        if (f.get("FacSNCFlg") or "").upper() == "Y":
            has_snc = True
        qtrs = f.get("FacQtrsWithNC")
        if qtrs not in (None, "") and str(qtrs).isdigit() and int(qtrs) > 0:
            has_qtrs_nc = True
        formal_action_date = _parse_date(f.get("FacDateLastFormalAction"))
        if formal_action_date and formal_action_date >= cutoff:
            recent_formal_action = True
        penalty_date = _parse_date(f.get("FacDateLastPenalty"))
        if penalty_date and penalty_date >= cutoff:
            recent_penalty = True
        if f.get("FacDateLastInspection") or (f.get("FacInspectionCount") not in (None, "", "0")):
            was_inspected = True

    if has_snc and recent_formal_action:
        return 1
    if has_snc or recent_formal_action:
        return 2
    if has_qtrs_nc or recent_penalty:
        return 3
    if was_inspected:
        return 4
    return None
