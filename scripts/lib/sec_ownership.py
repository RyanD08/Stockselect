"""
founder_led / family_owned, sourced from the DEF 14A "Security Ownership of
Certain Beneficial Owners and Management" table(s) cross-referenced against
the founder name(s) already captured in this dataset's
wikipedia_profile.infobox_fields (founder/founders/key_people), per the
task's instruction to verify Wikipedia leads against a primary source
before finalizing.

Development note: an earlier version of this module worked on the same
flattened-to-text representation used elsewhere in this project's SEC
parsers (sec_proxy.py, sec_governance.py). That approach failed concretely
on real filings -- flattening a multi-column HTML table to a single text
stream destroys row/cell boundaries, so a "grab the next number-shaped
token after this name" regex would bleed into the NEXT person's row
(observed on Alphabet: Larry Page's row matched Sergey Brin's percentage
instead) or grab an unrelated footnote-marker number. Fixed by parsing the
raw DEF 14A HTML's actual <table>/<tr>/<td> structure with BeautifulSoup
instead, so each matched row's cells are the real cells SEC's own HTML
rendering assigned to that person/entity -- no row-boundary guessing.

Method:
  1. Take founder surname(s) from the Wikipedia infobox 'founder'/'founders'
     field already in the dataset (never re-derived here -- if that field
     is empty/absent, this module has nothing to cross-reference and
     reports "not found" rather than guessing from the DEF 14A alone).
  2. Parse every <table> in the DEF 14A whose text mentions "beneficial"/
     "% of class"/"voting power"/"shares outstanding" (i.e. plausibly an
     ownership table -- filters out compensation/other tables). Within
     those tables, find any <tr> whose text contains a founder's surname,
     and read the LAST percentage-shaped number in that row's own cells
     (dual-class filers list class-% then total-voting-power-% in that
     column order; single-class filers just have one -- taking the last
     cell handles both without needing to detect the layout).
  3. Per surname, keep the MAX single-row percentage found (not summed)
     -- confirmed necessary on Walmart, where the same underlying Walton
     family stake appears in more than one row (an LLC row and a trust
     row whose shares the filing's own footnote says overlap/are already
     included in the LLC row); summing would double-count it. Combined
     family stake is then the SUM across DISTINCT surnames (correct for
     e.g. Alphabet's Page + Brin, two genuinely separate holders).
  4. family_owned = true when that combined percentage is >=
     FAMILY_OWNED_THRESHOLD_PCT (documented constant below, cited in the
     output). founder_led is a separate check: does the Wikipedia
     infobox's key_people/CEO field name share a surname with a listed
     founder, AND does that same surname appear as a matched row in this
     DEF 14A (i.e. still actively an insider, not just a historical/
     possibly-stale Wikipedia claim) -- the "verify against a primary
     source" step the task asks for.
This is a heuristic surname match, not a verified family-tree lookup --
coverage and precision are both necessarily imperfect (a common surname
shared with a large unrelated shareholder, or a founder listed only under
a trust/LLC name with no surname in it at all, will not be caught). Every
record states the exact threshold and rows matched so a reader can verify
the judgment call themselves.
"""
import re

from bs4 import BeautifulSoup

FAMILY_OWNED_THRESHOLD_PCT = 10.0

_OWNERSHIP_TABLE_HINT_RE = re.compile(
    r"beneficial|% of class|voting power|shares outstanding|% of shares", re.I,
)
_PCT_RE = re.compile(r"^\s*(\d{1,3}(?:\.\d{1,2})?)\s*%?\s*$")
_LT1_RE = re.compile(r"^\s*\*\s*$")


def _stopwords_for_surname_match():
    return {"total", "all", "directors", "class"}


def _names_from_person_list_field(field_value):
    """field_value is a raw cleaned Wikipedia infobox string naming one or
    more people, e.g. 'Larry Page , Sergey Brin' or 'Jeff Bezos'. Returns a
    list of surnames (last whitespace-separated token of each comma/and-
    separated name), skipping obvious non-person entries (companies,
    parenthetical asides, etc.)."""
    if not field_value:
        return []
    parts = re.split(r",| and |&", field_value)
    surnames = []
    for p in parts:
        p = re.sub(r"\(.*?\)", "", p)  # strip "(42.4%)", "(See section)", etc.
        p = p.strip().strip(".")
        if not p or len(p) > 40:
            continue
        if re.search(r"\b(Inc|Corp|LLC|Ltd|Company|Co\.|Group|See|section)\b", p, re.I):
            continue
        tokens = [t for t in p.split() if t and t[0].isupper()]
        if tokens:
            surnames.append(tokens[-1])
    seen = set()
    out = []
    for s in surnames:
        if s.lower() not in seen and s.lower() not in _stopwords_for_surname_match():
            seen.add(s.lower())
            out.append(s)
    return out


_OWNER_PCT_RE = re.compile(r"\(\s*([\d.]+)\s*%\s*\)")


def _surnames_from_owner_field(owner_field, summary_extract):
    """Wikipedia's infobox 'owner' field (e.g. 'Larry Ellison (42.4%)') is
    used by some company articles INSTEAD of 'founder'/'founders' even when
    that person is in fact a well-documented founder -- confirmed on
    Oracle's actual article (owner='Larry Ellison (42.4%)', no founder(s)
    field present at all, despite Ellison's Oracle-founder status being
    undisputed). Returns surnames from this field, but only when the same
    surname also appears near the word 'found' in the article's own summary
    extract (already in this dataset) -- i.e. corroborated as a founder by
    a second piece of the same Wikipedia article, not just assumed from an
    ownership-stake field that could equally name a later, non-founding
    controlling investor."""
    if not owner_field:
        return []
    candidates = _names_from_person_list_field(owner_field)
    if not candidates or not summary_extract:
        return []
    corroborated = []
    for surname in candidates:
        window_matches = [
            m for m in re.finditer(r"(?<![A-Za-z])" + re.escape(surname) + r"(?![A-Za-z])", summary_extract)
        ]
        for m in window_matches:
            nearby = summary_extract[max(0, m.start() - 150):m.start() + 150]
            if re.search(r"\bfound(ed|er|ing)\b", nearby, re.I):
                corroborated.append(surname)
                break
    return corroborated


def _row_last_percentage(cells_text):
    """cells_text is a list of <td>/<th> text strings for one row. Returns
    a float percentage (0-100) from the LAST cell that looks like a
    percentage, or 0.5 if the last numeric-ish cell is '*' (SEC filings'
    standard '<1%' marker), or None if no percentage-shaped cell exists."""
    last_pct = None
    last_was_lt1 = False
    for cell in cells_text:
        cell = cell.strip()
        m = _PCT_RE.match(cell)
        if m:
            try:
                val = float(m.group(1))
            except ValueError:
                continue
            if val <= 100:
                last_pct = val
                last_was_lt1 = False
            continue
        if _LT1_RE.match(cell):
            last_pct = 0.5
            last_was_lt1 = True
    return last_pct, last_was_lt1


def _find_ownership_rows(html, surnames):
    """Returns {surname: (pct, row_text)} using the max single-row
    percentage found per surname across all plausible ownership tables in
    this DEF 14A's raw HTML. Also returns the set of surnames found ANYWHERE
    in a plausible ownership table (even without a parseable percentage),
    for founder_led verification purposes."""
    soup = BeautifulSoup(html, "html.parser")
    best = {}
    seen_anywhere = set()

    for table in soup.find_all("table"):
        table_text = table.get_text(" ", strip=True)
        if not _OWNERSHIP_TABLE_HINT_RE.search(table_text):
            continue
        for tr in table.find_all("tr"):
            row_text = tr.get_text(" ", strip=True)
            if not row_text:
                continue
            row_surnames = [
                s for s in surnames
                if re.search(r"(?<![A-Za-z])" + re.escape(s) + r"(?![A-Za-z])", row_text)
            ]
            if not row_surnames:
                continue
            cells = [c.get_text(" ", strip=True) for c in tr.find_all(["td", "th"])]
            pct, _lt1 = _row_last_percentage(cells)
            for s in row_surnames:
                seen_anywhere.add(s)
                if pct is None:
                    continue
                if s not in best or pct > best[s][0]:
                    best[s] = (pct, row_text[:200])

    return best, seen_anywhere


def build_founder_family_record(def14a_html, wikipedia_profile, filing_url, filing_date):
    """Returns (result_dict, error). wikipedia_profile is this dataset's
    existing additional_data_sources.wikipedia_profile dict (or {} if
    none) -- both infobox_fields and summary_extract are used. def14a_html
    is the RAW (unflattened) DEF 14A HTML, needed for real <table>/<tr>/
    <td> parsing."""
    wikipedia_fields = (wikipedia_profile or {}).get("infobox_fields", {}) or {}
    summary_extract = (wikipedia_profile or {}).get("summary_extract", "") or ""
    founders_field = wikipedia_fields.get("founder") or wikipedia_fields.get("founders")
    owner_field = wikipedia_fields.get("owner")
    key_people = wikipedia_fields.get("key_people", "")

    surnames = _names_from_person_list_field(founders_field)
    surname_source = "founders field" if surnames else None

    owner_surnames = _surnames_from_owner_field(owner_field, summary_extract)
    for s in owner_surnames:
        if s.lower() not in {x.lower() for x in surnames}:
            surnames.append(s)
    if owner_surnames and not surname_source:
        surname_source = "owner field (corroborated as founder in Wikipedia summary text)"
    elif owner_surnames:
        surname_source += " + owner field (corroborated as founder in Wikipedia summary text)"

    if not founders_field and not owner_field:
        return {
            "founder_led": False,
            "family_owned": False,
            "confidence": "Medium",
            "source": "Wikipedia infobox (already in this dataset's wikipedia_profile)",
            "note": (
                "Neither a 'founder'/'founders' nor an 'owner' field is present in this company's "
                "Wikipedia infobox, so there is no founder name to cross-reference against the DEF "
                "14A beneficial-ownership table. Reported false rather than left unpopulated, "
                "consistent with 'no evidence of founder-led/family-owned status found' -- not a "
                "verified negative for companies whose Wikipedia article simply omits this field "
                "(long-since-public conglomerates, spin-offs, etc. commonly do)."
            ),
        }, None

    if not surnames:
        return {
            "founder_led": False,
            "family_owned": False,
            "confidence": "Low",
            "source": f"Wikipedia infobox founders field ('{founders_field}') / owner field ('{owner_field}')",
            "note": (
                "Wikipedia's founders/owner field was present but no parseable, founder-corroborated "
                "person name could be extracted from it (may name a company/entity rather than an "
                "individual, or an owner-field name that the article's own summary text doesn't "
                "describe as a founder)."
            ),
        }, None

    try:
        row_matches, seen_anywhere = _find_ownership_rows(def14a_html, surnames)
    except Exception as e:  # noqa: BLE001 - HTML parsing edge cases shouldn't kill the batch
        return {
            "founder_led": False,
            "family_owned": False,
            "confidence": "Low",
            "source": f"Wikipedia founders field ('{founders_field}'); DEF 14A fetched {filing_date} ({filing_url})",
            "note": f"HTML table parsing failed on this filing ({type(e).__name__}: {e}); left false rather than assumed.",
        }, None

    if not row_matches and not seen_anywhere:
        return {
            "founder_led": False,
            "family_owned": False,
            "founder_surnames_checked": surnames,
            "confidence": "Low",
            "source": f"Wikipedia {surname_source} ('{founders_field or owner_field}'); DEF 14A fetched {filing_date} ({filing_url})",
            "note": (
                "None of the Wikipedia-listed founder surname(s) were found in any table in this "
                "DEF 14A that looks like an ownership table (contains 'beneficial'/'% of class'/"
                "'voting power' text). May mean the founder is no longer a listed insider/5% owner, "
                "or holds shares only under a trust/LLC name with no surname in it, or this filing's "
                "ownership table uses non-standard wording this parser doesn't recognize."
            ),
        }, None

    ceo_is_founder = False
    if key_people and surnames:
        for surname in surnames:
            # The parenthetical title after a name in Wikipedia's key_people
            # field often combines roles ("(president and CEO)", "(chairman
            # and CEO)", "(co-founder, chairman & CEO)") rather than stating
            # "CEO" immediately after the opening paren -- match anywhere
            # inside the same parenthetical, not just right after "(".
            if re.search(r"(?<![A-Za-z])" + re.escape(surname) + r"(?![A-Za-z])[^,()]{0,20}\([^)]{0,60}(?:CEO|Chief Executive)[^)]{0,60}\)", key_people, re.I) or \
               re.search(r"(?<![A-Za-z])" + re.escape(surname) + r"(?![A-Za-z])[^,()]{0,60}\([^)]{0,60}Executive Chairman[^)]{0,60}\)", key_people, re.I):
                ceo_is_founder = True
                break

    founder_led_verified = ceo_is_founder and any(s in seen_anywhere for s in surnames)

    total_pct = round(sum(pct for pct, _ctx in row_matches.values()), 2)
    family_owned = total_pct >= FAMILY_OWNED_THRESHOLD_PCT

    return {
        "founder_led": founder_led_verified,
        "family_owned": family_owned,
        "founder_surnames_checked": surnames,
        "founder_rows_matched_in_def14a": [
            {"surname": s, "pct_matched": pct, "row_excerpt": ctx}
            for s, (pct, ctx) in row_matches.items()
        ],
        "combined_founder_family_voting_or_ownership_pct": total_pct,
        "family_owned_threshold_pct": FAMILY_OWNED_THRESHOLD_PCT,
        "confidence": "Medium" if row_matches else "Low",
        "source": (
            f"Wikipedia {surname_source} ('{founders_field or owner_field}') / key_people "
            f"('{key_people}') cross-referenced against SEC EDGAR DEF 14A filed {filing_date}, "
            f"beneficial-ownership table(s) ({filing_url})"
        ),
        "note": (
            "founder_led = true only when a Wikipedia-listed founder's surname both (a) appears in "
            "the Wikipedia key_people field tagged CEO/Executive Chairman, and (b) is independently "
            "found as a row in one of this DEF 14A's ownership tables (i.e. still an active insider "
            "as of the current proxy, not just a historical/Wikipedia-stale claim). "
            f"family_owned = true when the combined percentage below is >= {FAMILY_OWNED_THRESHOLD_PCT}%: "
            "per matched surname, the MAX single-row percentage is kept (not summed across rows for the "
            "SAME surname, since the same family stake often appears in more than one row -- an LLC row "
            "and a trust row whose shares the filing's own footnotes say overlap -- confirmed on Walmart's "
            "actual filing), then summed across DISTINCT surnames (correct when two founders are genuinely "
            "separate holders, e.g. Alphabet's Page + Brin). This is a surname-based heuristic match "
            "against real HTML table rows (not flattened text), not a verified family-tree/trust lookup -- "
            "a founder listed only under a trust/LLC name with no surname in it, or a common surname "
            "shared with an unrelated large shareholder, will not be handled correctly; "
            "founder_rows_matched_in_def14a lists exactly what was matched so this can be spot-checked."
        ),
    }, None
