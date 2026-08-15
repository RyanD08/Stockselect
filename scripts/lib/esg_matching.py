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

# SEC EDGAR appends a trailing state/country-of-incorporation disambiguator
# to registrant names -- "BANK OF AMERICA CORP /DE/", "COSTCO WHOLESALE CORP
# /NEW", "CHARTER COMMUNICATIONS, INC. /MO/" -- to tell apart re-incorporated
# or successor entities sharing a base name. It's a pure SEC-filing artifact:
# no other data source would ever include it, so left in place it makes the
# matcher require a suffix real records will never have, guaranteeing zero
# matches (confirmed on 126+ companies in the dataset, including some very
# large ones -- BAC, WFC, COST, AMAT, CHTR, AMT, ANF). Must run on the raw
# string, before general punctuation stripping turns "/DE/" into "DE" and
# loses the slash markers that identify it as this specific pattern.
_SEC_STATE_SUFFIX_RE = re.compile(r"\s*/[A-Za-z]{2,3}/?$")

_PUNCT_RE = re.compile(r"[.,'\"()\[\]/&]")
_WS_RE = re.compile(r"\s+")

# Government data sources spell out corporate suffixes inconsistently
# relative to SEC's abbreviated registrant names (e.g. SEC's "CHEVRON CORP"
# vs EPA ECHO's own facility "CHEVRON CORPORATION" -- note CORP is not
# followed by a word boundary in CORPORATION, so a naive prefix check on the
# abbreviated form misses the real, correctly-named HQ facility entirely).
# Canonicalize both sides of every comparison to fixed short tokens.
_SUFFIX_CANONICAL = {
    "CORPORATION": "CORP", "CORP": "CORP",
    "INCORPORATED": "INC", "INC": "INC",
    "COMPANY": "CO", "CO": "CO",
    "LIMITED": "LTD", "LTD": "LTD",
    "HOLDINGS": "HOLDING", "HOLDING": "HOLDING",
    "GROUP": "GRP", "GRP": "GRP",
    "INTERNATIONAL": "INTL", "INTL": "INTL",
}


def normalize_name(name):
    if not name:
        return ""
    name = _LEADING_CODE_RE.sub("", name)
    name = _SEC_STATE_SUFFIX_RE.sub("", name)
    name = _PUNCT_RE.sub(" ", name)
    name = _WS_RE.sub(" ", name).strip().upper()
    words = [_SUFFIX_CANONICAL.get(w, w) for w in name.split(" ")]
    return " ".join(words)


def _prefix_match(norm_record, norm_target):
    return bool(norm_target) and (norm_record == norm_target or norm_record.startswith(norm_target + " "))


def is_company_match(record_name, company_legal_name):
    """True if record_name is confidently the same organization as
    company_legal_name: exact match, or company_legal_name is a whole-word
    prefix of record_name (covers site/subsidiary suffixes like
    "APPLE INC (AP)" or "AMAZON COM SERVICES LLC FC BFI4").

    Also tries the suffix-stripped core of company_legal_name (e.g.
    "AXALTA COATING SYSTEMS LTD" -> "AXALTA COATING SYSTEMS"), since
    government sources frequently register a facility/subsidiary without any
    corporate suffix, or under a different one entirely (a real ResMed Inc.
    facility shows up in EPA ECHO as "RESMED CORPORATION"). This relaxation
    only applies when the stripped core still has >= 2 words -- collapsing
    to a single word (e.g. "CHEVRON CORP" -> "CHEVRON") re-opens the exact
    contamination problem this matcher exists to avoid (thousands of
    "CHEVRON #1234" branded gas stations that aren't Chevron Corp's own
    facilities), so single-word cores stay strict."""
    norm_record = normalize_name(record_name)
    norm_company = normalize_name(company_legal_name)
    if not norm_record or not norm_company:
        return False
    if _prefix_match(norm_record, norm_company):
        return True
    core = core_search_name(company_legal_name)
    if len(core.split()) >= 2 and _prefix_match(norm_record, core):
        return True
    return False


_TRAILING_SUFFIXES = {
    # canonical forms as produced by normalize_name(), plus a few that
    # aren't in _SUFFIX_CANONICAL because they have no common long variant
    "INC", "CORP", "CO", "LTD", "HOLDING", "GRP", "INTL", "LLC", "PLC",
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
    if not normalize_name(company_legal_name):
        return False
    for raw_segment in _SEGMENT_SPLIT_RE.split(text or ""):
        if is_company_match(raw_segment, company_legal_name):
            return True
    return False
