"""
Small shared HTML/text helpers reused across the SEC-filing extraction
modules (governance, ownership, geographic revenue). Kept separate from
sec_proxy.py's own copy of the same helper to avoid touching that module's
already-tested CEO pay ratio code in this pass.
"""
import re

_TAG_RE = re.compile(r"<[^>]+>")
_ENTITY_RE = re.compile(r"&#8217;|&rsquo;|&#8220;|&#8221;|&ldquo;|&rdquo;")
_NBSP_RE = re.compile(r"&nbsp;|&#160;")
_DASH_RE = re.compile(r"&#8212;|&mdash;")
_WS_RE = re.compile(r"\s+")


def html_to_text(html):
    text = _ENTITY_RE.sub("'", html)
    text = _NBSP_RE.sub(" ", text)
    text = _DASH_RE.sub(" - ", text)
    text = _TAG_RE.sub(" ", text)
    text = _WS_RE.sub(" ", text)
    return text


def latest_filing(sec_submission, forms):
    """Returns (accession_no, primary_document, filing_date, form) for the
    most recent filing whose form is in `forms` (checked in order given),
    or (None, None, None, None). `forms` lets a caller prefer e.g. 10-K but
    fall back to 10-K405/20-F for older/foreign filers."""
    recent = sec_submission.get("filings", {}).get("recent", {})
    forms_list = recent.get("form", [])
    for want in forms:
        for i, form in enumerate(forms_list):
            if form == want:
                return recent["accessionNumber"][i], recent["primaryDocument"][i], recent["filingDate"][i], form
    return None, None, None, None


def filing_document_url(cik, accession, primary_doc):
    accession_nodash = accession.replace("-", "")
    cik_int = int(cik)
    return f"https://www.sec.gov/Archives/edgar/data/{cik_int}/{accession_nodash}/{primary_doc}"


def filing_summary_url(cik, accession):
    accession_nodash = accession.replace("-", "")
    cik_int = int(cik)
    return f"https://www.sec.gov/Archives/edgar/data/{cik_int}/{accession_nodash}/FilingSummary.xml"


_REPORT_RE = re.compile(r"<Report[^>]*>.*?</Report>", re.S)
_SHORTNAME_RE = re.compile(r"<ShortName>(.*?)</ShortName>", re.S)
_HTMLFILE_RE = re.compile(r"<HtmlFileName>(.*?)</HtmlFileName>")


def parse_filing_summary_reports(xml_text):
    """Returns a list of (short_name, html_file_name) tuples in document
    order, from a FilingSummary.xml body."""
    out = []
    for r in _REPORT_RE.finditer(xml_text):
        sn = _SHORTNAME_RE.search(r.group(0))
        hf = _HTMLFILE_RE.search(r.group(0))
        if sn and hf:
            out.append((sn.group(1).strip(), hf.group(1).strip()))
    return out


def r_file_url(cik, accession, html_file_name):
    accession_nodash = accession.replace("-", "")
    cik_int = int(cik)
    return f"https://www.sec.gov/Archives/edgar/data/{cik_int}/{accession_nodash}/{html_file_name}"
