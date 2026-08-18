"""
Governance fields sourced directly from a company's own SEC filings:
share-class/voting structure (from the 10-K cover page's "Securities
registered" table) and material legal-proceedings/enforcement disclosure
(from the 10-K's Item 3 Legal Proceedings section, following through to the
financial-statement "Legal Matters"/"Commitments and Contingencies" note
when Item 3 just incorporates it by reference, which is the normal case for
large filers).

This task's brief named three enforcement sources as primary: Violation
Tracker (violationtracker.goodjobsfirst.org), the Stanford Securities Class
Action Clearinghouse (securities.stanford.edu), and SEC Litigation
Releases search (efts.sec.gov / sec.gov/litigation). All three were tested
live and found unreachable from this environment this pass:
  - violationtracker.goodjobsfirst.org: HTTP 403, Cloudflare Turnstile
    bot-challenge page on both the root site and a guessed API path.
  - securities.stanford.edu: HTTP 403, same Cloudflare bot-challenge.
  - SEC's own site-search widget (secsearch.sec.gov / search.usa.gov,
    which sec.gov/litigation's search form posts to) is blocked by this
    environment's proxy egress policy (403 at the CONNECT step -- the same
    policy-denial signature documented for gunfreefunds.org/cii.org/
    bcorporation.net in data/mining_session_notes.md, not a transient
    failure). efts.sec.gov itself (EDGAR full-text search over *filings*)
    is reachable, but litigation releases are a separate CMS-driven part of
    sec.gov, not an EDGAR filing, so efts.sec.gov cannot search them.
Given that, this module falls back to the company's own mandatory Item 3 /
Item 103 (Reg S-K) legal-proceedings disclosure and the referenced
financial-statement note, pulled live from SEC EDGAR for every company.
This is a genuinely different (and narrower -- self-reported, materiality-
filtered) source than the three named above, so every record is labeled
with exactly what was checked and confidence is capped at Medium even
when a positive match is found.
"""
import re

from .sec_text import (
    html_to_text, filing_summary_url, parse_filing_summary_reports, r_file_url,
)

_COVER_BLOCK_RE = re.compile(
    r"Title of each class(.*?)Indicate by check mark", re.I | re.S,
)
_CLASS_STOCK_RE = re.compile(
    r"\b(Class\s+[A-Z](?:-[0-9])?|Common|Ordinary|Capital)\b[^.;]{0,40}?"
    r"\b(Common Stock|Capital Stock|Ordinary Shares|Shares)\b",
    re.I,
)

# Real section headers in EDGAR 10-Ks are conventionally rendered in ALL
# CAPS in the document body ("ITEM 3. LEGAL PROCEEDINGS"), while both the
# table of contents and later cross-references to this section from other
# parts of the document (MD&A, financial-statement notes) use title case
# ("Item 3. Legal Proceedings"). A case-SENSITIVE uppercase match is a much
# more reliable anchor for the real section than "last case-insensitive
# match" -- confirmed against a real false-positive: Walmart's 10-K has a
# later mixed-case MD&A cross-reference to this section that sorts after
# the real (uppercase) section header, which a last-match-wins,
# case-insensitive search picks up instead of the real content.
_ITEM3_UPPER_RE = re.compile(r"ITEM\s*3\.?\s*LEGAL\s+PROCEEDINGS")
_ITEM3_RE = re.compile(r"ITEM\s*3\.?\s*LEGAL\s+PROCEEDINGS", re.I)
_ITEM4_RE = re.compile(r"ITEM\s*4\.?\s*(MINE\s+SAFETY|SUBMISSION)", re.I)
_SEE_NOTE_RE = re.compile(
    r"(see|refer to|incorporated (herein )?by reference).{0,120}?"
    r"(note|legal matters|commitments and contingencies)", re.I,
)
_NOT_MATERIAL_RE = re.compile(
    r"(not (currently )?(a party to|subject to) any material|"
    r"no material (pending )?legal proceedings|"
    r"not material to (our|the company))", re.I,
)

_FRAUD_KEYWORDS = [
    "consent decree", "consent order", "cease-and-desist", "cease and desist",
    "civil penalty", "civil penalties", "criminal investigation", "indictment",
    "guilty plea", "pled guilty", "department of justice", " doj ",
    "antitrust", "foreign corrupt practices act", "fcpa", "bribery",
    "securities fraud", "shareholder derivative", "class action",
    "whistleblower", "qui tam", "restatement of", "agreed to pay",
    "settlement of $", "settled for $", "fined $", "civil monetary penalty",
    "sec order", "securities and exchange commission.{0,40}(order|charged|investigation|settlement)",
]
_FRAUD_KEYWORD_RE = re.compile("|".join(_FRAUD_KEYWORDS), re.I)


def extract_share_class_structure(doc_text):
    """Returns (result_dict, error). Uses the 10-K cover page's 'Securities
    registered pursuant to Section 12(b)' table, which every registrant
    must state in a standard, boilerplate-adjacent format -- reliable for
    a High-confidence read on class structure specifically (not on voting
    RATIOS between classes, which the cover page does not state)."""
    m = _COVER_BLOCK_RE.search(doc_text)
    if not m:
        return None, "could not locate the 'Title of each class' cover-page table in this filing"
    block = m.group(1)[:4000]
    classes = []
    seen = set()
    for cm in _CLASS_STOCK_RE.finditer(block):
        label = cm.group(0).strip()
        label = re.sub(r"\s+", " ", label)
        # Dedupe by the leading class token (e.g. "Class A", "Class B", plain "Common Stock")
        key = (cm.group(1) or "").strip().upper()
        if key in seen:
            continue
        seen.add(key)
        classes.append(label)

    is_dual_class = len(classes) >= 2
    return {
        "share_classes_found": classes,
        "dual_class_structure": is_dual_class,
        "confidence": "High",
        "note": (
            f"{'Multiple' if is_dual_class else 'A single'} class"
            f"{'es' if is_dual_class else ''} of common/capital stock "
            f"{'were' if is_dual_class else 'was'} found registered on this 10-K's cover page "
            "('Securities registered pursuant to Section 12(b) of the Act' table). This confirms "
            "the share-CLASS structure directly from the registrant's own SEC cover-page "
            "disclosure; it does not by itself state the voting-power ratio between classes "
            "(e.g. 1 vote vs. 10 votes per share), which would require reading the articles of "
            "incorporation/charter referenced elsewhere in the filing."
        ),
    }, None


def _find_legal_matters_note(client, cik, accession, cache_key_prefix, refresh=False):
    """Fetches FilingSummary.xml and, if a Legal Matters/Commitments and
    Contingencies R-file exists, fetches and returns its text. Returns
    (text_or_None, source_url_or_None, error)."""
    url = filing_summary_url(cik, accession)
    xml_text, status, _from_cache, _fetched_at = client.get_text(
        url, cache_key=f"{cache_key_prefix}_fs", refresh=refresh,
    )
    if status != 200:
        return None, None, f"HTTP {status} fetching FilingSummary.xml"

    reports = parse_filing_summary_reports(xml_text)
    candidates = [
        (sn, hf) for sn, hf in reports
        if re.search(r"legal matters|litigation|commitments and contingencies", sn, re.I)
        and "(Tables)" not in sn and "(Policies)" not in sn
    ]
    if not candidates:
        return None, None, "no Legal Matters/Commitments and Contingencies R-file found in FilingSummary.xml"

    # Prefer a note titled just "Legal Matters"/"Litigation" over the
    # combined "Commitments and Contingencies" one when both exist, since
    # it's more likely to be narrowly about legal proceedings.
    candidates.sort(key=lambda sc: 0 if re.search(r"legal matters|litigation", sc[0], re.I) else 1)
    short_name, html_file = candidates[0]
    r_url = r_file_url(cik, accession, html_file)
    html, status2, _fc, _fa = client.get_text(r_url, cache_key=f"{cache_key_prefix}_{html_file}", refresh=refresh)
    if status2 != 200:
        return None, None, f"HTTP {status2} fetching {r_url}"
    text = html_to_text(html)
    return text[:6000], r_url, None


def extract_legal_proceedings(client, cik, accession, doc_text, filing_url, filing_date, cache_key_prefix, refresh=False):
    """Returns (result_dict, error). See module docstring for the sourcing
    caveat -- this is the company's OWN Item 3 disclosure (+ the referenced
    financial-statement note when Item 3 just points to it), not the three
    third-party enforcement databases named in the task brief (all three
    confirmed unreachable from this environment this pass)."""
    upper_matches = list(_ITEM3_UPPER_RE.finditer(doc_text))
    matches = upper_matches or list(_ITEM3_RE.finditer(doc_text))
    if not matches:
        return None, "could not locate an 'Item 3. Legal Proceedings' section in this 10-K's text"

    # Prefer the LAST all-caps occurrence (the real section header format);
    # only fall back to a case-insensitive last-match when no all-caps
    # occurrence exists at all (some filers don't use the all-caps
    # convention), matching the "last qualifying occurrence" technique
    # already validated for the CEO-pay-ratio extractor in sec_proxy.py --
    # but scoped to uppercase matches first to avoid picking up a later
    # mixed-case cross-reference from MD&A/financial-statement notes (see
    # comment above _ITEM3_UPPER_RE).
    start = matches[-1].end()
    end_m = _ITEM4_RE.search(doc_text, start)
    end = end_m.start() if end_m else start + 3000
    section_text = doc_text[start:end].strip()

    extra_note_url = None
    if len(section_text) < 400 and _SEE_NOTE_RE.search(section_text):
        note_text, note_url, note_err = _find_legal_matters_note(
            client, cik, accession, cache_key_prefix, refresh=refresh,
        )
        if note_text:
            section_text = section_text + " || Referenced note text: " + note_text
            extra_note_url = note_url

    kw_matches = sorted(set(m.group(0).strip().lower() for m in _FRAUD_KEYWORD_RE.finditer(section_text)))

    sources = [f"SEC EDGAR 10-K filed {filing_date}, Item 3 Legal Proceedings ({filing_url})"]
    if extra_note_url:
        sources.append(f"referenced financial-statement note ({extra_note_url})")

    if kw_matches:
        return {
            "adverse_record_found": True,
            "signal_terms_matched": kw_matches[:15],
            "excerpt": section_text[:1500],
            "confidence": "Medium",
            "sources_checked": [
                "Violation Tracker (violationtracker.goodjobsfirst.org) -- unreachable this pass, HTTP 403 Cloudflare bot-challenge",
                "Stanford Securities Class Action Clearinghouse (securities.stanford.edu) -- unreachable this pass, HTTP 403 Cloudflare bot-challenge",
                "SEC Litigation Releases search -- unreachable this pass, sec.gov's search widget backend is proxy-blocked (403 at CONNECT)",
                "SEC EDGAR 10-K Item 3 Legal Proceedings + referenced financial-statement note -- reachable, used as the actual source below",
            ],
            "source": " ; ".join(sources),
            "note": (
                "One or more legal/regulatory-enforcement signal terms were found in this company's "
                "own mandatory Item 3 Legal Proceedings disclosure (Reg S-K Item 103) and/or the "
                "financial-statement note it references. This confirms the company itself disclosed "
                "a related legal or regulatory matter as of this filing date -- it does NOT by itself "
                "confirm a fraud finding, an adverse verdict, or that the matter is still open; read "
                "the excerpt/source filing directly before treating this as more than a lead. The "
                "three third-party enforcement databases named in the task brief could not be reached "
                "from this environment this pass (see sources_checked)."
            ),
        }, None

    if _NOT_MATERIAL_RE.search(section_text) or len(section_text) < 400:
        return {
            "adverse_record_found": False,
            "status": "No adverse record found in available sources",
            "confidence": "Medium",
            "sources_checked": [
                "Violation Tracker (violationtracker.goodjobsfirst.org) -- unreachable this pass, HTTP 403 Cloudflare bot-challenge",
                "Stanford Securities Class Action Clearinghouse (securities.stanford.edu) -- unreachable this pass, HTTP 403 Cloudflare bot-challenge",
                "SEC Litigation Releases search -- unreachable this pass, sec.gov's search widget backend is proxy-blocked (403 at CONNECT)",
                "SEC EDGAR 10-K Item 3 Legal Proceedings + referenced financial-statement note -- reachable, checked, no signal terms found",
            ],
            "source": " ; ".join(sources),
            "note": (
                "Absence of a finding here is not the same as a verified clean record -- it means no "
                "enforcement/fraud/settlement signal term was found in this company's own Item 3 "
                "disclosure (and referenced note) as of this filing date, and the three third-party "
                "enforcement databases named in the task brief were unreachable this pass. A genuinely "
                "clean record and an under-disclosed one would look identical from this source alone."
            ),
        }, None

    # Ambiguous: section text exists, isn't the standard "no material
    # proceedings" boilerplate, but also matched none of the fraud/
    # enforcement keyword list -- most likely ordinary commercial
    # litigation (patent suits, contract disputes) rather than a scandal.
    return {
        "adverse_record_found": False,
        "status": "No adverse record found in available sources",
        "confidence": "Low",
        "sources_checked": [
            "Violation Tracker (violationtracker.goodjobsfirst.org) -- unreachable this pass, HTTP 403 Cloudflare bot-challenge",
            "Stanford Securities Class Action Clearinghouse (securities.stanford.edu) -- unreachable this pass, HTTP 403 Cloudflare bot-challenge",
            "SEC Litigation Releases search -- unreachable this pass, sec.gov's search widget backend is proxy-blocked (403 at CONNECT)",
            "SEC EDGAR 10-K Item 3 Legal Proceedings + referenced financial-statement note -- reachable, checked, no enforcement/fraud signal terms found",
        ],
        "source": " ; ".join(sources),
        "excerpt": section_text[:1500],
        "note": (
            "This company's Item 3 disclosure contains non-boilerplate text (ordinary-course "
            "commercial litigation is common and not itself a scandal signal) but no "
            "enforcement/fraud/settlement keyword was matched. Confidence is Low rather than Medium "
            "because the text did not clearly state 'no material proceedings' either -- read the "
            "excerpt directly if this company matters to your decision."
        ),
    }, None
