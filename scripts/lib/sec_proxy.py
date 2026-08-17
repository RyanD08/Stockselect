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
# The disclosure sentence's verb/preposition between "ratio" and the number
# varies a lot across filers ("the ratio ... is 533 to 1", "... was 155 to
# 1", "... was approximately 375 to 1", "CEO's pay was approximately 200
# times"), and the description of what's being compared in between can run
# long ("ratio of the annual total compensation of our CEO to the annual
# total compensation of our median employee was X to 1"). Rather than try to
# enumerate every verb, match the number pattern on its own and rely on
# _RATIO_CONTEXT_RE + a tight nearby window (see fetch_ceo_pay_ratio) to
# confirm it's actually the pay-ratio sentence and not an unrelated ratio
# elsewhere in a 100+ page filing.
_RATIO_NUM_RE = re.compile(
    r"(\d[\d,]*(?:\.\d+)?)[\s-]*(?:to[\s-]*1\b|:\s*1\b)"
    r"|approximately\s+(\d[\d,]*(?:\.\d+)?)\s+times"
    # Some filers (e.g. Amazon) state it median-employee-first: "a ratio of
    # those amounts of 1-to-51" -- same fact, reversed order; group 3 is the
    # ratio value here, not group 1/2.
    r"|\b1[\s-]+to[\s-]+(\d[\d,]*(?:\.\d+)?)\b",
    re.I,
)
# Every real disclosure sentence observed across filers during development
# (Apple, Agilent, Abbott, Philip Morris, Tesla, Axon, Super Micro, Welltower)
# uses this exact SEC-boilerplate-derived phrase right before stating the
# number, whereas incidental "X to 1"/"X:1" matches elsewhere in a proxy
# (e.g. a Pay-versus-Performance table's numeric cells, an unrelated
# shareholder-vote tally) do not have it immediately before them. Requiring
# it substantially cuts false positives without needing to hand-enumerate
# every filer's exact verb choice.
_ANNUAL_TOTAL_COMP_RE = re.compile(r"annual total compensation", re.I)
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

    # Scan forward from each "pay ratio" mention (in document order),
    # keeping every candidate that also has "annual total compensation"
    # nearby (see _ANNUAL_TOTAL_COMP_RE) and the number pattern within a
    # generous window after it (observed up to ~1500 chars of methodology
    # narrative in a real filing, Abbott Laboratories). The filing's table
    # of contents mentions "Pay Ratio" with no number nearby (skipped
    # automatically); a Pay-versus-Performance table can also use the
    # "annual total compensation" phrase in a column header with an
    # incidental "X to 1"/"X:1"-shaped numeric cell nearby, so the LAST
    # qualifying candidate in document order is kept rather than the first --
    # the standalone, fully-narrated "20XX Pay Ratio Disclosure" section is
    # consistently the final and most authoritative statement of the figure
    # (confirmed against Tesla's filing, which has both a table and the real
    # narrative section, in that order).
    ratio = None
    for ctx_m in _RATIO_CONTEXT_RE.finditer(text):
        window = text[ctx_m.end():ctx_m.end() + 3000]
        num_m = _RATIO_NUM_RE.search(window)
        if not num_m:
            continue
        preceding = window[:num_m.start()]
        if not _ANNUAL_TOTAL_COMP_RE.search(preceding):
            continue
        raw = num_m.group(1) or num_m.group(2) or num_m.group(3)
        try:
            ratio = float(raw.replace(",", ""))
        except ValueError:
            continue

    if ratio is None:
        return None, "no CEO pay ratio disclosure found in this filing's text (may be an image/table, non-standard phrasing, or a smaller reporting company exempt from the rule)"

    # A handful of founder-CEOs (Tesla's Musk, Axon's Smith, Super Micro's
    # Liang) take $0 or near-$0 cash/reported compensation, giving a real
    # ratio below 1:1 -- keep the fractional value rather than rounding it
    # away to a misleading "0 to 1".
    ratio_display = int(ratio) if ratio == int(ratio) else round(ratio, 2)

    median_comp = None
    mm = _MEDIAN_COMP_RE.search(text)
    if mm:
        try:
            median_comp = int(mm.group(1).replace(",", ""))
        except ValueError:
            pass

    return {
        "ceo_to_median_employee_pay_ratio": f"{ratio_display} to 1",
        "ceo_to_median_employee_pay_ratio_numeric": ratio_display,
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
