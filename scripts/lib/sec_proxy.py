"""
SEC DEF 14A (proxy statement) mining -- currently just the mandatory
Item 402(u) CEO pay ratio disclosure, the one figure in a proxy statement
reliably phrased in a small number of standard patterns across filers
(every company subject to the rule must state it in almost boilerplate
language: "the ratio of these amounts is X to 1" / "was approximately X
times").

Board composition/diversity-matrix extraction was attempted during
development (see PROGRESS notes) but dropped for this pass: unlike the pay
ratio, the "Board Diversity Matrix" disclosure is not filed by every
company, isn't in a single standard location, and is very often rendered as
an image/table that survives HTML-to-text stripping poorly -- reliably
parsing it needs more per-company judgment than a regex can safely apply at
this scale without risking a wrong number being reported as verified.
"""
import re

_RATIO_CONTEXT_RE = re.compile(r"pay ratio", re.I)
# "ratio of these amounts is 533 to 1" / "ratio ... is 1:533" / "was approximately 533 times"
_RATIO_NUM_RE = re.compile(
    r"ratio[^.]{0,120}?(?:is|of)\s+(?:approximately\s+)?(\d[\d,]*)\s*(?:to\s*1|:\s*1)"
    r"|(?:CEO|Chief Executive Officer)[^.]{0,150}?(?:compensation was\s+)?approximately\s+(\d[\d,]*)\s+times",
    re.I,
)
_MEDIAN_COMP_RE = re.compile(
    r"median\s+(?:compensated\s+)?employee[^.]{0,150}?\$\s*([\d,]+)", re.I,
)
_TAG_RE = re.compile(r"<[^>]+>")
_ENTITY_RE = re.compile(r"&#8217;|&rsquo;")
_NBSP_RE = re.compile(r"&nbsp;|&#160;")
_WS_RE = re.compile(r"\s+")


def _html_to_text(html):
    text = _ENTITY_RE.sub("'", html)
    text = _NBSP_RE.sub(" ", text)
    text = _TAG_RE.sub(" ", text)
    text = _WS_RE.sub(" ", text)
    return text


def latest_def14a_filing(sec_submission):
    """Returns (accession_no, primary_document, filing_date) for the most
    recent DEF 14A in the submissions payload, or (None, None, None)."""
    recent = sec_submission.get("filings", {}).get("recent", {})
    forms = recent.get("form", [])
    for i, form in enumerate(forms):
        if form == "DEF 14A":
            return recent["accessionNumber"][i], recent["primaryDocument"][i], recent["filingDate"][i]
    return None, None, None


def fetch_ceo_pay_ratio(client, cik, sec_submission, cache_key_prefix, refresh=False):
    """Returns (result_dict_or_None, error). result_dict has ratio_to_one
    (int), median_employee_total_comp_usd (int or None), filing_url,
    filing_date."""
    accession, primary_doc, filing_date = latest_def14a_filing(sec_submission)
    if not accession:
        return None, "no DEF 14A found in SEC filing history"

    accession_nodash = accession.replace("-", "")
    cik_int = int(cik)
    url = f"https://www.sec.gov/Archives/edgar/data/{cik_int}/{accession_nodash}/{primary_doc}"

    html, status, _from_cache, _fetched_at = client.get_text(
        url, cache_key=f"{cache_key_prefix}_def14a", refresh=refresh,
    )
    if status != 200:
        return None, f"HTTP {status} fetching {url}"

    text = _html_to_text(html)

    ratio = None
    for m in _RATIO_NUM_RE.finditer(text):
        # Only accept a ratio number that appears reasonably near the words
        # "pay ratio" somewhere in the surrounding ~2000 chars, to avoid
        # picking up an unrelated "X to 1" ratio elsewhere in a 100+ page filing.
        window_start = max(0, m.start() - 2000)
        window = text[window_start:m.start()]
        if _RATIO_CONTEXT_RE.search(window) or _RATIO_CONTEXT_RE.search(text[m.start():m.end() + 200]):
            raw = m.group(1) or m.group(2)
            try:
                ratio = int(raw.replace(",", ""))
                break
            except ValueError:
                continue

    if ratio is None:
        return None, "no CEO pay ratio disclosure found in this filing's text (may be an image/table, non-standard phrasing, or a smaller reporting company exempt from the rule)"

    median_comp = None
    mm = _MEDIAN_COMP_RE.search(text)
    if mm:
        try:
            median_comp = int(mm.group(1).replace(",", ""))
        except ValueError:
            pass

    return {
        "ceo_to_median_employee_pay_ratio": f"{ratio} to 1",
        "ceo_to_median_employee_pay_ratio_numeric": ratio,
        "median_employee_total_comp_usd": median_comp,
        "filing_url": url,
        "filing_date": filing_date,
        "confidence": "High",
        "source": f"SEC EDGAR DEF 14A proxy statement filed {filing_date}, {url} (Item 402(u) CEO pay ratio disclosure)",
        "note": (
            "Extracted by regex from the filing's Item 402(u) pay-ratio narrative text. "
            "Companies may use different, SEC-permitted methodologies/estimates/exclusions "
            "when computing the median employee, so this figure is not directly comparable "
            "year-over-year or company-to-company without reading each filing's stated methodology."
        ),
    }, None
