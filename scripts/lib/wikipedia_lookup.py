"""
en.wikipedia.org lookups for general company facts (founding, founders, key
people, ownership type, HQ, subsidiaries) not available from SEC/Finnhub.

Per the task's own instruction, Wikipedia is a *lead*, not a primary source:
every value extracted here is raw text pulled straight from the article's
infobox wikitext (with the exact article title/URL as the citation) and is
tagged Low or Medium confidence, never High -- it still needs verification
against a primary source (SEC filing, company website) before being treated
as a verified fact. Nothing here auto-derives a boolean like founder_led;
that judgment call is left to a human reviewer with the raw text in hand.
"""
import re

SEARCH_URL = "https://en.wikipedia.org/w/api.php"
PARSE_URL = "https://en.wikipedia.org/w/api.php"

_INFOBOX_START_RE = re.compile(r"\{\{\s*Infobox\s+company", re.I)
_FIELD_RE = re.compile(
    r"\n\|\s*([a-zA-Z_0-9]+)\s*=\s*(.*?)(?=\n\|\s*[a-zA-Z_0-9]+\s*=|\n\}\}|\Z)", re.S,
)

_WIKILINK_RE = re.compile(r"\[\[(?:[^|\]]*\|)?([^\]]+)\]\]")
_TEMPLATE_RE = re.compile(r"\{\{[^{}]*\}\}")
_REF_RE = re.compile(r"<ref[^>]*>.*?</ref>|<ref[^>]*/>", re.S)
_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")

_FIELDS_OF_INTEREST = (
    "type", "founded", "founder", "founders", "key_people", "hq_location",
    "hq_location_city", "hq_location_country", "num_employees", "num_employees_year",
    "parent", "subsidiaries", "owner", "traded_as",
)


def _clean_wikitext_value(raw):
    text = raw
    # Resolve a couple of common formatting templates to plain text before
    # stripping all other templates outright (order matters).
    text = re.sub(r"\{\{Start date and age\|(\d+)\|(\d+)\|(\d+).*?\}\}", r"\1-\2-\3", text)
    text = re.sub(r"\{\{Start date\|(\d+)\|?(\d+)?\|?(\d+)?.*?\}\}", lambda m: "-".join(g for g in m.groups() if g), text)
    text = re.sub(r"\{\{Unbulleted list\s*\|", "", text, flags=re.I)
    text = re.sub(r"\{\{Plainlist\s*\|", "", text, flags=re.I)
    text = re.sub(r"\{\{flatlist\|", "", text, flags=re.I)
    text = _REF_RE.sub("", text)
    # Repeatedly resolve wikilinks/templates since infoboxes nest them.
    for _ in range(5):
        new_text = _WIKILINK_RE.sub(r"\1", text)
        new_text = _TEMPLATE_RE.sub("", new_text)
        if new_text == text:
            break
        text = new_text
    text = _TAG_RE.sub("", text)
    text = text.replace("'''", "").replace("''", "")
    text = text.replace("|", ", ")
    # Leftover stray braces from a template whose opening tag was stripped
    # above but whose closing "}}" belonged to it (e.g. "{{Unbulleted list|
    # A | B}}" -> "A , B}}" after the opening-tag strip above).
    text = text.replace("{{", "").replace("}}", "")
    text = _WS_RE.sub(" ", text).strip(" ,")
    return text


def search_title(client, company_name, cache_key_prefix, refresh=False):
    """Returns (best_title_or_None, error)."""
    body, status, _from_cache, _fetched_at = client.get_json(
        SEARCH_URL, cache_key=f"{cache_key_prefix}_search",
        params={"action": "query", "list": "search", "srsearch": company_name, "format": "json", "srlimit": 5},
        refresh=refresh,
    )
    if status != 200:
        return None, f"HTTP {status}"
    hits = (body.get("query", {}) or {}).get("search", []) or []
    if not hits:
        return None, None
    return hits[0]["title"], None


def fetch_summary(client, title, cache_key_prefix, refresh=False):
    """Returns (extract_text_or_None, page_url_or_None, error)."""
    safe_title = title.replace(" ", "_")
    url = f"https://en.wikipedia.org/api/rest_v1/page/summary/{safe_title}"
    body, status, _from_cache, _fetched_at = client.get_json(
        url, cache_key=f"{cache_key_prefix}_summary", refresh=refresh,
    )
    if status != 200:
        return None, None, f"HTTP {status}"
    extract = body.get("extract")
    page_url = (body.get("content_urls", {}) or {}).get("desktop", {}).get("page")
    return extract, page_url, None


def fetch_infobox_fields(client, title, cache_key_prefix, refresh=False):
    """Returns (fields_dict, error). fields_dict has only the keys in
    _FIELDS_OF_INTEREST that were present, cleaned to plain text."""
    body, status, _from_cache, _fetched_at = client.get_json(
        PARSE_URL, cache_key=f"{cache_key_prefix}_infobox",
        params={"action": "parse", "page": title, "prop": "wikitext", "section": 0, "format": "json"},
        refresh=refresh,
    )
    if status != 200:
        return {}, f"HTTP {status}"
    parse = body.get("parse")
    if not parse or "wikitext" not in parse:
        return {}, body.get("error", {}).get("info", "no wikitext returned (page may not exist)")
    wikitext = parse["wikitext"].get("*", "")
    m = _INFOBOX_START_RE.search(wikitext)
    if not m:
        return {}, "no {{Infobox company}} block found on this article"
    infobox_text = wikitext[m.start():]
    fields = {}
    for fm in _FIELD_RE.finditer(infobox_text):
        key, raw_val = fm.group(1).strip().lower(), fm.group(2)
        if key in _FIELDS_OF_INTEREST:
            cleaned = _clean_wikitext_value(raw_val)
            if cleaned:
                fields[key] = cleaned
    return fields, None


def build_wikipedia_profile(client, company_name, cache_key_prefix, refresh=False):
    title, err = search_title(client, company_name, cache_key_prefix, refresh=refresh)
    if err:
        return None, err
    if not title:
        return None, None

    extract, page_url, err1 = fetch_summary(client, title, cache_key_prefix, refresh=refresh)
    fields, err2 = fetch_infobox_fields(client, title, cache_key_prefix, refresh=refresh)

    if not extract and not fields:
        return None, err1 or err2 or "no usable content"

    return {
        "wikipedia_title": title,
        "url": page_url or f"https://en.wikipedia.org/wiki/{title.replace(' ', '_')}",
        "summary_extract": (extract or "")[:1200],
        "infobox_fields": fields,
        "confidence": "Low",
        "note": (
            "Raw Wikipedia infobox/summary data, cited to the exact article title and URL above "
            "(fetched via en.wikipedia.org). Per this project's sourcing rules, Wikipedia is treated "
            "as a lead requiring verification against a primary source (SEC filing, company site), "
            "not a final source -- especially for founder/family-ownership and controversy claims. "
            "No boolean (e.g. founder_led) is auto-derived from this text; a human reviewer should "
            "read infobox_fields.founders/key_people/type against the current SEC-registered "
            "leadership before treating anything here as verified."
        ),
    }, None
