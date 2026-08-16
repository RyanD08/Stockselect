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

# A leading "The" carries no distinguishing information but plenty of
# records include it (OSHA's own registration for Boeing is "The Boeing
# Co", not "Boeing Co", the SEC's registrant name) -- strip it from both
# sides so neither one's presence/absence blocks a match.
_LEADING_ARTICLE_RE = re.compile(r"^THE\s+")

_PUNCT_RE = re.compile(r"[.,'\"()\[\]/&]")
_WS_RE = re.compile(r"\s+")

# A '&' with no surrounding whitespace is almost always a silent part of a
# brand name rather than a stand-in for "and" -- "AT&T" is registered with
# OSHA as "ATT" (concatenated, no space at all), not "AT T". A spaced '&'
# ("Church & Dwight") is a real conjunction between two separate name
# components and is left to the general punctuation stripping below, which
# turns it into a space like any other separator.
_TIGHT_AMPERSAND_RE = re.compile(r"(?<=\S)&(?=\S)")


def _base_clean(name):
    """Punctuation/whitespace/leading-code/SEC-suffix/leading-article
    stripped and uppercased, but corporate-suffix words left exactly as
    written. This is the shared foundation for both normalize_name()
    (matching -- wants suffix words canonicalized) and core_search_name()
    (query generation -- must NOT invent abbreviations a government site's
    search index won't recognize, e.g. turning "International" into "Intl"
    would make an IBM query return zero results)."""
    if not name:
        return ""
    name = _LEADING_CODE_RE.sub("", name)
    name = _SEC_STATE_SUFFIX_RE.sub("", name)
    name = _TIGHT_AMPERSAND_RE.sub("", name)
    name = _PUNCT_RE.sub(" ", name)
    name = _WS_RE.sub(" ", name).strip().upper()
    return _LEADING_ARTICLE_RE.sub("", name)


# Government data sources spell out corporate suffixes inconsistently
# relative to SEC's abbreviated registrant names (e.g. SEC's "CHEVRON CORP"
# vs EPA ECHO's own facility "CHEVRON CORPORATION" -- note CORP is not
# followed by a word boundary in CORPORATION, so a naive prefix check on the
# abbreviated form misses the real, correctly-named HQ facility entirely).
# Canonicalize both sides of every *comparison* to fixed short tokens --
# never used for query text, see _base_clean above.
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
    base = _base_clean(name)
    if not base:
        return ""
    words = [_SUFFIX_CANONICAL.get(w, w) for w in base.split(" ")]
    return " ".join(words)


def _prefix_match(norm_record, norm_target):
    return bool(norm_target) and (norm_record == norm_target or norm_record.startswith(norm_target + " "))


def _ampersand_variants(name):
    """'&' is genuinely ambiguous across sources: sometimes a silent
    concatenation ("AT&T" -> OSHA's own "ATT", no space at all) and
    sometimes a stand-in for "and" that becomes a space or the literal word
    "AND". _PUNCT_RE's default (space) handles the "and" case; this adds
    the concatenated variant as a second candidate wherever '&' appears, so
    a match only needs to work under one interpretation, not a guess about
    which one this specific company uses."""
    if "&" not in (name or ""):
        return [name]
    return [name, name.replace("&", "")]


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
    facilities), so single-word cores stay strict.

    Where company_legal_name contains '&', both the "and" reading (default
    space) and the silent/concatenated reading (dropped entirely, e.g.
    "AT&T" -> "ATT") are tried -- see _ampersand_variants."""
    norm_record = normalize_name(record_name)
    if not norm_record:
        return False
    for variant in _ampersand_variants(company_legal_name):
        norm_company = normalize_name(variant)
        if not norm_company:
            continue
        if _prefix_match(norm_record, norm_company):
            return True
        core = core_search_name(variant)
        if len(core.split()) >= 2 and _prefix_match(norm_record, core):
            return True
    return False


_TRAILING_SUFFIXES = {
    "INC", "INCORPORATED", "CORP", "CORPORATION", "CO", "COMPANY",
    "LTD", "LIMITED", "LLC", "PLC", "GROUP", "GRP",
    "HOLDING", "HOLDINGS", "INTERNATIONAL", "INTL",
}


def core_search_name(company_legal_name):
    """Strip trailing generic corporate-suffix words (Inc/Corp/Co/LLC/...)
    for use as a *search query string* against sites whose search does an
    AND-of-every-word match. Two real examples this fixes:
      - NLRB returns zero results for "Amazon.com, Inc." (a real subsidiary
        case titled "Amazon.com Services, LLC" has no literal "Inc" token
        to match) but real results for "Amazon.com Services" or "Amazon".
      - OSHA returns zero results for "Union Pacific Corp" or
        "International Business Machines Corp" -- their own registrations
        are "Union Pacific Railroad Co" and (per Boeing's OSHA listing
        style) likely don't carry "Corp" as a literal word at all -- but
        real results for "Union Pacific" and "International Business
        Machines".
    Built from _base_clean (NOT normalize_name) so the suffix words that
    survive are spelled exactly as the company wrote them, never
    canonicalized into an abbreviation the target site won't recognize as
    a real word (turning "International" into "Intl" would itself zero out
    the IBM query above). This only widens what's *searched for*; the
    strict company-name check (is_company_match/any_segment_matches)
    against the untouched company name still decides whether a result
    actually counts."""
    words = _base_clean(company_legal_name).split()
    while len(words) > 1 and words[-1] in _TRAILING_SUFFIXES:
        words.pop()
    return " ".join(words) if words else _base_clean(company_legal_name)


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
