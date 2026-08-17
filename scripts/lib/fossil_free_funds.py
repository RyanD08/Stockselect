"""
fossilfreefunds.org (As You Sow) per-company fossil-fuel-involvement lookup.

The public site is a React SPA with no server-rendered data, but its own
main JS bundle (fossilfreefunds.org/dist/main-*.js) declares a JSON REST API
at api.fossilfreefunds.org/api/v1/companies, and the same bundle's own
column-header label strings give the authoritative human-readable meaning of
every field pulled here (verified by grep against the bundle itself, not
guessed) -- see the comment on each field below.

Confirmed reachable from this environment. api.gunfreefunds.org (the
sibling "weapons involvement" tool on the same platform) is blocked by this
environment's proxy egress policy (502 at the CONNECT step, a policy denial
per the proxy's own diagnostic log, not a transient failure) and could not
be queried for this pass -- see enrich_additional_sources.py's caveats.

Several other boolean flags exist in the raw API response (is_arms, is_nw,
is_pp, is_po_producer, is_borders, is_afsc_divest, etc.) but no label string
for them appears anywhere in fossilfreefunds.org's own bundle -- they belong
to sibling As You Sow tools (gunfreefunds, deforestation-free, prison-free
funds...) that share the same backend "companies" table. Per this project's
"don't invent labels for unverified data" rule, those fields are deliberately
NOT surfaced here: only fields whose meaning is confirmed by this site's own
UI strings are extracted.
"""
BASE_URL = "https://api.fossilfreefunds.org/api/v1/companies"

# fieldName -> human label, each confirmed present verbatim in
# fossilfreefunds.org's own main-*.js bundle (column header / legend strings).
_SCORE_LABELS = {
    "gef_score": "Gender equality score",
    "dei_score": "Diversity disclosures score",
    "rji_score": "Racial justice score",
    "hrc_score": "LGBTQ+ equity score",
    "fossil_bank_score": "Fossil finance (bank lending) score",
    "fossil_insure_score": "Fossil insurance score",
}

# is_* flag -> (human label, icon tooltip text) confirmed from the same bundle.
_FLAG_LABELS = {
    "is_c2": "Carbon Underground 200 (top 200 publicly-traded coal/oil/gas reserve holders)",
    "is_co": "Coal industry",
    "is_og": "Oil/gas industry",
    "is_f15": "Macroclimate 50",
    "is_ut": "Fossil-fired utility",
}


def fetch_company(client, ticker, cache_key_prefix, refresh=False):
    """Looks up a US-listed company by exact primary_symbol match. Returns
    (record_or_None, error). record_or_None is the single most-recently
    updated raw match (the API can return more than one row per ticker
    across versioned snapshots); None if no row has this exact ticker."""
    filter_json = f'{{"where":{{"primary_symbol":"{ticker}"}}}}'
    body, status, _from_cache, _fetched_at = client.get_json(
        BASE_URL, cache_key=f"{cache_key_prefix}_{ticker}",
        params={"filter": filter_json}, refresh=refresh,
    )
    if status != 200:
        return None, f"HTTP {status}"
    if not isinstance(body, list) or not body:
        return None, None
    # Multiple rows can come back for one ticker as As You Sow refreshes
    # their dataset (differing "version"/updated_at); keep the newest.
    body.sort(key=lambda r: r.get("updated_at") or "", reverse=True)
    return body[0], None


def build_fossil_fuel_screen(record):
    """Turns one raw fossilfreefunds company record into the dataset's
    fossil_fuel_screen field. record is what fetch_company returned (not
    None)."""
    matched_lists = [_FLAG_LABELS[k] for k, v in _FLAG_LABELS.items() if record.get(k) is True]
    scores = {}
    for field, label in _SCORE_LABELS.items():
        val = record.get(field)
        if val not in (None, "", "-1.0", -1.0):
            try:
                scores[field] = {"label": label, "value": round(float(val), 2)}
            except (TypeError, ValueError):
                pass
    return {
        # NOT is_dirty: that raw API field was checked against every label
        # string on fossilfreefunds.org's own JS bundle and its About/
        # methodology pages and appears in neither -- its meaning could not
        # be confirmed, and empirically it was True for every single one of
        # the 497 S&P 500 companies checked in this pass (i.e. it does not
        # discriminate at all despite its name implying it would). Per this
        # project's "don't invent labels for unverified data" rule, it is
        # NOT used here. involved is instead derived only from
        # matched_categories, each of which does have a confirmed label
        # (see _FLAG_LABELS) and does discriminate (e.g. ExxonMobil matches
        # 2 categories; most companies match 0).
        "involved": bool(matched_lists),
        "matched_categories": matched_lists,
        "diversity_equity_scores": scores,
        "raw_is_dirty_field_unverified": record.get("is_dirty"),
        "confidence": "High" if matched_lists else "Medium",
        "source": (
            f"fossilfreefunds.org (As You Sow), api.fossilfreefunds.org/api/v1/companies, "
            f"matched primary_symbol={record.get('primary_symbol')!r}, "
            f"company_id={record.get('company_id')}, dataset version {record.get('version')}, "
            f"last updated {record.get('updated_at')}"
        ),
        "note": (
            "involved=true means this company appears on at least one of fossilfreefunds.org's "
            "specific, named fossil-fuel lists (see matched_categories) -- Carbon Underground 200, "
            "coal industry, oil/gas industry, Macroclimate 50, or fossil-fired utility, each "
            "confirmed against this site's own UI label strings. An empty matched_categories list "
            "means no confirmed match was found (confidence Medium rather than High, since a "
            "company could still have a real but less-common fossil-fuel exposure this API's "
            "labeled categories don't cover). raw_is_dirty_field_unverified is the API's own "
            "'is_dirty' field, included for transparency but NOT used for `involved` above: its "
            "meaning has no label anywhere on fossilfreefunds.org's own site, and it was observed "
            "True for all 497 companies checked in this run -- almost certainly not a per-company "
            "fossil-fuel screen result despite the field name implying one. diversity_equity_scores "
            "are separate As You Sow-published scores (0-100 scale, higher = better) bundled in "
            "the same API response; not fossil-fuel-related but collected here since they're "
            "attributable to this same verified source and could inform new criteria."
        ),
    }
