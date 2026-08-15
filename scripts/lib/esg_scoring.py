"""
Combines the free-source lookups (EPA ECHO, OSHA, NLRB) into esg_ratings
updates, following the project's additive-only rule: only overwrite a field
that is still the untouched Finnhub-placeholder (score 3, confidence Low,
build_record.NO_LIVE_ESG_NOTE); if a field already carries real data and a
new source disagrees, that's logged as a disagreement rather than applied.
governance is out of scope for this pass and is never touched.
"""
from . import build_record

EPA_NOTE_TEMPLATE = (
    "EPA ECHO enforcement history, past 5 years: {detail}. Based on {n} EPA-regulated "
    "facilit{y} matched to this company's SEC-registered legal name (echodata.epa.gov); "
    "facilities registered under a differently-named subsidiary are not captured."
)

OSHA_NLRB_NOTE_TEMPLATE = "{sources}. Based on records matched to this company's SEC-registered legal name; records filed under a differently-named subsidiary are not captured."


def _is_placeholder(block):
    return (
        block.get("score") == 3
        and block.get("confidence") == "Low"
        and block.get("note") == build_record.NO_LIVE_ESG_NOTE
    )


def _epa_detail(has_snc, recent_formal_action, has_qtrs_nc, recent_penalty, was_inspected):
    if has_snc and recent_formal_action:
        return "significant noncompliance with a recent formal enforcement action"
    if has_snc:
        return "significant noncompliance on record"
    if recent_formal_action:
        return "a recent formal enforcement action"
    if has_qtrs_nc:
        return "some quarters of noncompliance on record"
    if recent_penalty:
        return "a recent penalty on record"
    if was_inspected:
        return "no violations or enforcement actions found"
    return "no usable compliance signal"


def apply_environmental(company, epa_result):
    """epa_result: dict with keys score, matched_count, has_snc,
    recent_formal_action, has_qtrs_nc, recent_penalty, was_inspected,
    search_error (or None). Returns a change-report entry dict or None."""
    ticker = company["ticker"]
    block = company["esg_ratings"]["environmental"]
    score = epa_result.get("score")

    if score is None:
        return None  # nothing found; leave placeholder/existing data untouched, no confidence change

    detail = _epa_detail(
        epa_result.get("has_snc"), epa_result.get("recent_formal_action"),
        epa_result.get("has_qtrs_nc"), epa_result.get("recent_penalty"), epa_result.get("was_inspected"),
    )
    n = epa_result["matched_count"]
    note = EPA_NOTE_TEMPLATE.format(detail=detail, n=n, y="y" if n == 1 else "ies")

    if _is_placeholder(block):
        old = dict(block)
        block["score"] = score
        block["confidence"] = "High"
        block["note"] = note
        return {"ticker": ticker, "field": "esg_ratings.environmental", "type": "upgrade",
                "source": "EPA ECHO", "old_score": old["score"], "new_score": score, "note": note}

    if block.get("score") != score:
        return {"ticker": ticker, "field": "esg_ratings.environmental", "type": "disagreement",
                "source": "EPA ECHO", "existing_score": block.get("score"),
                "existing_confidence": block.get("confidence"), "source_score": score, "source_note": note}
    return None


def apply_social_labor(company, osha_result, nlrb_result):
    """osha_result/nlrb_result: dict with keys score, matched_count,
    total_violations/ca_count, search_error (or None), or None if the
    source found nothing at all for this company. Returns a change-report
    entry dict or None."""
    ticker = company["ticker"]
    block = company["esg_ratings"]["social_labor"]

    osha_score = osha_result.get("score") if osha_result else None
    nlrb_score = nlrb_result.get("score") if nlrb_result else None

    if osha_score is None and nlrb_score is None:
        return None

    scores = [s for s in (osha_score, nlrb_score) if s is not None]
    combined_score = round(sum(scores) / len(scores))

    source_notes = []
    if osha_score is not None:
        source_notes.append(
            f"OSHA establishment search: {osha_result['total_violations']} violation(s) across "
            f"{osha_result['matched_count']} matched inspection(s) in the past 5 years"
        )
    if nlrb_score is not None:
        source_notes.append(
            f"NLRB case search: {nlrb_result['ca_count']} unfair-labor-practice charge(s) filed "
            f"against this employer in the past 5 years"
        )
    confidence = "High" if (osha_score is not None and nlrb_score is not None) else "Medium"
    note = OSHA_NLRB_NOTE_TEMPLATE.format(sources="; ".join(source_notes))

    if _is_placeholder(block):
        old = dict(block)
        block["score"] = combined_score
        block["confidence"] = confidence
        block["note"] = note
        return {"ticker": ticker, "field": "esg_ratings.social_labor", "type": "upgrade",
                "source": "+".join(s for s, sc in (("OSHA", osha_score), ("NLRB", nlrb_score)) if sc is not None),
                "old_score": old["score"], "new_score": combined_score, "note": note}

    if block.get("score") != combined_score:
        return {"ticker": ticker, "field": "esg_ratings.social_labor", "type": "disagreement",
                "source": "OSHA/NLRB", "existing_score": block.get("score"),
                "existing_confidence": block.get("confidence"), "source_score": combined_score, "source_note": note}
    return None
