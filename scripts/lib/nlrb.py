"""
NLRB case search (www.nlrb.gov/search/case), scraped as server-rendered HTML.
The site's "Download CSV" button is backed by an async job queue
(/nlrb-downloads/start-download/...) that requires a session cookie and
polling; the search results page itself already contains the same case data
server-rendered, so we parse that directly instead of driving the CSV flow.

The search form is a Drupal POST form (GET requests to the same URL with
?search_term=... are silently ignored and just return the 10 most-recent
cases, unfiltered -- confirmed by testing). A valid submission needs a
form_build_id pulled from a live page load plus the session cookie Drupal
issues with it; both are fetched once per pipeline run and reused across all
company searches (confirmed to work for repeated searches against the same
session).

search_term does a loose full-text search across case records (party names,
representatives, etc.), so every result is re-checked with
esg_matching.any_segment_matches() against the company's legal name -- NLRB
case titles are commonly "Employer and Union" pairs, so we check each
party segment rather than the whole title.

Case number format is "<region>-<type>-<sequence>", e.g. "08-CA-392826".
We score on CA cases (unfair labor practice charges filed against an
employer) in the lookback window -- the most direct labor-relations signal
available without deeper per-case merit/outcome data.
"""
import re
import datetime

from . import esg_matching

BASE_URL = "https://www.nlrb.gov/search/case"
_FORM_BUILD_ID_RE = re.compile(r'name="form_build_id"\s+value="([^"]+)"')


def prime_session(client):
    """One-time (per client/run) live GET to establish session cookies and a
    form_build_id for the POST-based search. Deliberately bypasses the disk
    cache: a cached form_build_id would be paired with a session the current
    run's requests.Session() cookie jar never actually saw, breaking every
    subsequent POST silently (falls back to unfiltered 10-most-recent)."""
    client.rate_limiter.wait()
    resp = client.session.get(BASE_URL, headers=client.base_headers, timeout=30)
    m = _FORM_BUILD_ID_RE.search(resp.text)
    if not m:
        raise RuntimeError("Could not find NLRB search form_build_id -- page structure may have changed")
    return m.group(1)

_CASE_BLOCK_RE = re.compile(
    r'<a href="/case/([^"]+)">([^<]+)</a>.*?'
    r'Case Number:\s*</strong><a href="/case/[^"]+">([^<]+)</a><br>\s*'
    r'<strong>Date Filed:\s*</strong>([^<]+)<br>\s*'
    r'<strong>Status:\s*</strong>([^<]+)<br>',
    re.S,
)


def _parse_cases(html):
    cases = []
    for case_path, title, case_number, date_filed, status in _CASE_BLOCK_RE.findall(html):
        cases.append({
            "case_number": case_number.strip(),
            "title": title.strip(),
            "date_filed": date_filed.strip(),
            "status": status.strip(),
        })
    return cases


def _parse_date(s):
    if not s:
        return None
    try:
        return datetime.datetime.strptime(s.strip(), "%B %d, %Y").date()
    except ValueError:
        return None


def fetch_matched_cases(client, form_build_id, company_legal_name, cache_key_prefix, as_of_date, lookback_years=5, refresh=False):
    """Returns (matched_cases, error). matched_cases are case dicts within
    the lookback window whose title matches the company via
    any_segment_matches(). Requires a form_build_id from prime_session()
    against the same client (same session cookies)."""
    html, status, from_cache, fetched_at = client.post_text(
        BASE_URL, cache_key=cache_key_prefix,
        data={
            "search_term": esg_matching.core_search_name(company_legal_name),
            "form_build_id": form_build_id,
            "form_id": "nlrb_search_case_search_form",
            "op": "Search",
        },
        refresh=refresh,
    )
    if status != 200:
        return [], f"HTTP {status}"

    cutoff = as_of_date - datetime.timedelta(days=365 * lookback_years)
    cases = _parse_cases(html)
    matched = []
    for c in cases:
        if not esg_matching.any_segment_matches(c["title"], company_legal_name):
            continue
        filed = _parse_date(c["date_filed"])
        if filed and filed < cutoff:
            continue
        matched.append(c)
    return matched, None


def score_social_nlrb(matched_cases):
    """Returns (score_or_None, ca_case_count). None if no matched cases."""
    if not matched_cases:
        return None, 0

    ca_cases = [c for c in matched_cases if "-CA-" in c["case_number"].upper()]
    ca_count = len(ca_cases)

    if ca_count >= 10:
        return 1, ca_count
    if ca_count >= 4:
        return 2, ca_count
    if ca_count >= 1:
        return 3, ca_count
    return 4, ca_count
