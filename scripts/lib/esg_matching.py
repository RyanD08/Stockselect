"""
Shared company-name matching for the free ESG data sources (EPA ECHO, OSHA,
NLRB). All three sites do a loose "contains these words somewhere" search,
which pulls in a lot of unrelated organizations that merely share a common
word with the target company (e.g. searching "Apple Inc" against EPA ECHO or
OSHA returns real Apple Inc. facilities mixed in with "Apple Valley Waste
Services", "Snappy Apple Farms", "Apple Markets Inc", etc.).

To avoid attributing another organization's violations to the wrong company,
every match here requires the *normalized* record name to start with the
company's normalized legal name (as a whole-word prefix) or equal it exactly.
This trades recall for precision -- consistent with this project's rule that
an absent/uncertain data point should be left as a placeholder rather than
guessed at. Many companies will have zero qualifying matches even where a
naive substring search would have returned hundreds of rows; that's expected.
"""
import re

# Records often prefix a facility/establishment code before the real name,
# e.g. OSHA's "317722864 - Amazon.Com Dedc Llc" or EPA ECHO's raw facility
# listings. Strip a leading "<code> - " segment before matching.
_LEADING_CODE_RE = re.compile(r"^[A-Za-z0-9]{4,}\s*-\s*")

_PUNCT_RE = re.compile(r"[.,'\"()\[\]/&]")
_WS_RE = re.compile(r"\s+")


def normalize_name(name):
    if not name:
        return ""
    name = _LEADING_CODE_RE.sub("", name)
    name = _PUNCT_RE.sub(" ", name)
    name = _WS_RE.sub(" ", name).strip().upper()
    return name


def is_company_match(record_name, company_legal_name):
    """True if record_name is confidently the same organization as
    company_legal_name: exact match, or company_legal_name is a whole-word
    prefix of record_name (covers site/subsidiary suffixes like
    "APPLE INC (AP)" or "AMAZON COM SERVICES LLC FC BFI4")."""
    norm_record = normalize_name(record_name)
    norm_company = normalize_name(company_legal_name)
    if not norm_record or not norm_company:
        return False
    if norm_record == norm_company:
        return True
    if norm_record.startswith(norm_company + " "):
        return True
    return False


_TRAILING_SUFFIXES = {
    "INCORPORATED", "CORPORATION", "COMPANY", "HOLDINGS", "HOLDING", "GROUP",
    "LIMITED", "INC", "CORP", "CO", "LLC", "LTD", "PLC",
}


def core_search_name(company_legal_name):
    """Strip trailing generic corporate-suffix words (Inc/Corp/Co/LLC/...)
    for use as a *search query string* against sites whose search does an
    AND-of-every-word match. NLRB's search, for example, returns zero
    results for "Amazon.com, Inc." or "Amazon Com Inc" (a real subsidiary
    case titled "Amazon.com Services, LLC" has no literal "Inc" token to
    match), but returns real results for "Amazon.com Services" or "Amazon".
    This only widens what's *searched for*; the strict company-name check
    (is_company_match/any_segment_matches) against the untouched company
    name is still what decides whether a result actually counts."""
    words = normalize_name(company_legal_name).split()
    while len(words) > 1 and words[-1] in _TRAILING_SUFFIXES:
        words.pop()
    return " ".join(words) if words else normalize_name(company_legal_name)


_SEGMENT_SPLIT_RE = re.compile(r"\(|\)|\band\b|&", re.IGNORECASE)


def any_segment_matches(text, company_legal_name):
    """For multi-party record titles (e.g. NLRB case titles like 'Amazon.Com
    Services LLC and Teamsters Local 123', or '...Teamsters Local 1 (Amazon.com
    Services LLC)'), check each party segment independently against the
    company name. Splits on the raw text first (parens/'and'/'&' as
    boundaries) so a parenthetical employer name isn't merged into the
    surrounding clause once punctuation is normalized away."""
    norm_company = normalize_name(company_legal_name)
    if not norm_company:
        return False
    for raw_segment in _SEGMENT_SPLIT_RE.split(text or ""):
        seg = normalize_name(raw_segment)
        if seg == norm_company or seg.startswith(norm_company + " "):
            return True
    return False
