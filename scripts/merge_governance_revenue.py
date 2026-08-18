#!/usr/bin/env python3
"""
Merges scripts/enrich_governance_revenue.py's real, per-company SEC EDGAR
output (data/governance_revenue_enrichment.json) into
data/sp500_full_dataset.json, replacing four field groups the task asked
to fix:

  1. esg_ratings.governance -- was a 100%-identical placeholder note for
     all 497 companies ("no live per-company ESG data source is
     available..."). Rebuilt here from the real
     share_class_structure + legal_proceedings_signal records, written as
     a single note (js/scoring.js's questions 8 and 9 both read this ONE
     note field with different trigger-word regexes -- see below for
     exactly which words each needs/must-avoid).
  2. founder_led / family_owned -- were `false` for all 497 companies
     (never actually populated). Set directly from
     founder_family_ownership's real (surname-verified) booleans.
  3. revenue_geography.profile -- was a sector-level heuristic default for
     every company. Set from domestic_revenue_mix's real percentage where
     found (>50% domestic -> "Primarily Domestic", matching the schema's
     existing binary enum); left `null` (not the old heuristic value, and
     not silently re-defaulted to "Globally Diversified" either) with
     confidence "None" where no verifiable figure was found, per the
     task's explicit instruction not to fall back to the heuristic
     silently. js/scoring.js's Q20 already treats any non-'Primarily
     Domestic' value (including null) as neutral (0), so this needed no
     scoring-code change -- confirmed by reading js/scoring.js line 272.
  4. additional_data_sources -- the raw enrichment record (share class,
     legal signal, founder/family match detail, geo revenue detail) is
     added per company for full traceability from the derived top-level
     fields above back to their exact source filing/table.

Deliberately NOT touched: environmental/social_labor ratings,
animal_testing_exposure, financial_metrics.analyst_price_target_upside_pct,
performance_tier.five_year_annualized_return_pct_est (all out of scope for
this pass).

-- On note-text word choice for esg_ratings.governance --
js/scoring.js's Q8 flags a "scandal" via
  /litigation|scandal|fraud|corruption|settlement|controvers|investigation/i
and Q9 flags "concentrated/dual-class voting control" via
  /dual-class|voting power|majority control|majority voting|significant influence/i
against the SAME note string. This means a "clean" note must avoid ALL of
those words even in a negated sentence ("no litigation found" would still
match /litigation/i and wrongly flag Q8) -- every note-building helper
below was written and then re-checked against both regexes before use.

Usage:
  python3 scripts/merge_governance_revenue.py \\
      --dataset data/sp500_full_dataset.json \\
      --enrichment data/governance_revenue_enrichment.json \\
      --output data/sp500_full_dataset.json
"""
import argparse
import json
import re

# The exact trigger regexes from js/scoring.js questions 8 and 9 -- reused
# here (not re-derived) so this script can self-check every note it writes
# actually produces the intended fire/no-fire behavior before saving.
_Q8_SCANDAL_RE = re.compile(r"litigation|scandal|fraud|corruption|settlement|controvers|investigation", re.I)
_Q9_DUALCLASS_RE = re.compile(r"dual-class|voting power|majority control|majority voting|significant influence", re.I)


def _governance_note_and_score(share_class, legal):
    """Returns (note, score, confidence). share_class/legal are the raw
    share_class_structure/legal_proceedings_signal records from the
    enrichment file (each is either a real result or a {status: 'No
    verifiable data found', reason: ...} miss)."""
    parts = []
    confidences = []

    dual_class = share_class.get("dual_class_structure")
    if dual_class is True:
        classes = ", ".join(share_class.get("share_classes_found", []))
        parts.append(
            f"This company has a dual-class share structure ({classes} registered on its "
            "10-K cover page); concentrated/multi-class voting control is a governance concern "
            "this dataset flags negatively regardless of the numeric score below."
        )
        confidences.append(share_class.get("confidence", "Medium"))
    elif dual_class is False:
        parts.append(
            "This company's 10-K cover page shows a single class of common stock registered "
            "(source: SEC EDGAR 10-K cover page, 'Securities registered' table)."
        )
        confidences.append(share_class.get("confidence", "Medium"))
    else:
        parts.append(
            "Share-class structure could not be determined from this company's 10-K cover page "
            f"this pass ({share_class.get('reason', 'no reason recorded')})."
        )
        confidences.append("Low")

    adverse = legal.get("adverse_record_found")
    if adverse is True:
        terms = ", ".join(legal.get("signal_terms_matched", [])[:5])
        parts.append(
            "SEC filings (this company's own Item 3 Legal Proceedings disclosure and/or the "
            f"financial-statement note it references) disclose related matters -- signal terms "
            f"matched: {terms}. This does not by itself confirm a fraud finding or adverse verdict; "
            "see additional_data_sources.legal_proceedings_signal for the excerpt and exact source."
        )
        confidences.append(legal.get("confidence", "Medium"))
    elif adverse is False:
        parts.append(
            "No signal of a regulatory enforcement action, legal proceeding, or securities-related "
            "violation was found in this company's own SEC Item 3 disclosure (and referenced "
            "financial-statement note) as of its most recent 10-K. Violation Tracker, the Stanford "
            "Securities Class Action Clearinghouse, and SEC's own enforcement-action search tool "
            "were not reachable from this environment this pass -- see "
            "additional_data_sources.legal_proceedings_signal for the full sourcing caveat."
        )
        confidences.append(legal.get("confidence", "Medium"))
    else:
        parts.append(
            "No legal/enforcement signal could be extracted from this company's 10-K this pass "
            f"({legal.get('reason', 'no reason recorded')})."
        )
        confidences.append("Low")

    note = " ".join(parts)

    # Self-check: verify the trigger words fire exactly when intended, on
    # the ACTUAL assembled note (not just the fragment above), before this
    # note is ever written to the dataset.
    q8_fires = bool(_Q8_SCANDAL_RE.search(note))
    q9_fires = bool(_Q9_DUALCLASS_RE.search(note))
    if q8_fires != (adverse is True):
        raise AssertionError(f"Q8 scandal-regex mismatch: adverse={adverse}, note={note!r}")
    if q9_fires != (dual_class is True):
        raise AssertionError(f"Q9 dual-class-regex mismatch: dual_class={dual_class}, note={note!r}")

    if dual_class is True and adverse is True:
        score = 1
    elif dual_class is True or adverse is True:
        score = 2
    elif dual_class is False and adverse is False:
        score = 3
    else:
        score = 3  # unknown on one or both axes -- stay neutral, not penalized for a data gap

    conf_rank = {"High": 3, "Medium": 2, "Low": 1, "None": 0}
    weakest_confidence = min(confidences, key=lambda c: conf_rank.get(c, 0)) if confidences else "Low"

    return note, score, weakest_confidence


def _revenue_geography(geo):
    if "domestic_revenue_pct" in geo:
        pct = geo["domestic_revenue_pct"]
        profile = "Primarily Domestic" if pct > 50 else "Globally Diversified"
        return {
            "profile": profile,
            "domestic_revenue_pct": pct,
            "confidence": geo.get("confidence", "High"),
            "note": (
                f"{pct}% of reported net sales/revenue attributed to the United States "
                f"(source: {geo.get('source', 'SEC EDGAR 10-K geographic-segment note')}). "
                f"{profile} reflects the schema's existing binary threshold (>50% domestic)."
            ),
        }
    return {
        "profile": None,
        "confidence": "None",
        "note": (
            "No verifiable geographic revenue breakdown found "
            f"({geo.get('reason', 'no reason recorded')}). Per this pass's instructions, the prior "
            "sector-level heuristic value is deliberately NOT retained here -- js/scoring.js's Q20 "
            "already treats any non-'Primarily Domestic' value (including null) as neutral, so this "
            "does not silently reintroduce the heuristic into scoring."
        ),
    }


def merge(dataset, enrichment):
    by_ticker = enrichment["additional_data"]
    stats = {
        "governance_updated": 0, "founder_family_updated": 0,
        "revenue_geo_verified": 0, "revenue_geo_not_found": 0,
        "missing_enrichment": [],
    }

    for c in dataset["companies"]:
        ticker = c["ticker"]
        rec = by_ticker.get(ticker)
        if not rec:
            stats["missing_enrichment"].append(ticker)
            continue

        share_class = rec.get("share_class_structure", {})
        legal = rec.get("legal_proceedings_signal", {})
        fam = rec.get("founder_family_ownership", {})
        geo = rec.get("domestic_revenue_mix", {})

        note, score, confidence = _governance_note_and_score(share_class, legal)
        c["esg_ratings"]["governance"] = {"score": score, "confidence": confidence, "note": note}
        stats["governance_updated"] += 1

        c["founder_led"] = bool(fam.get("founder_led", False))
        c["family_owned"] = bool(fam.get("family_owned", False))
        stats["founder_family_updated"] += 1

        rg = _revenue_geography(geo)
        c["revenue_geography"] = rg
        if rg["profile"] is not None:
            stats["revenue_geo_verified"] += 1
        else:
            stats["revenue_geo_not_found"] += 1

        ads = c.setdefault("additional_data_sources", {})
        ads["share_class_structure"] = share_class
        ads["legal_proceedings_signal"] = legal
        ads["founder_family_ownership"] = fam
        ads["domestic_revenue_mix"] = geo

    return stats


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--enrichment", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    with open(args.dataset) as f:
        dataset = json.load(f)
    with open(args.enrichment) as f:
        enrichment = json.load(f)

    stats = merge(dataset, enrichment)

    dataset["meta"]["purpose"] = dataset["meta"].get("purpose", "") + (
        " A dataset-remediation pass replaced the 100%-placeholder governance fraud/dual-class "
        "field, the never-populated founder_led/family_owned fields, and the sector-heuristic "
        "revenue_geography field with real per-company data pulled live from SEC EDGAR 10-K and "
        "DEF 14A filings -- see data/governance_revenue_remediation_notes.md for the full "
        "investigation log, including which of the task's named third-party sources (Violation "
        "Tracker, Stanford Securities Class Action Clearinghouse, CII.org, Stooq.com) were "
        "unreachable from this environment and why."
    )
    dataset["meta"]["important_caveats"] = [
        c for c in dataset["meta"].get("important_caveats", [])
        if not c.startswith("founder_led and family_owned default")
        and not c.startswith("revenue_geography.profile is a sector-level heuristic")
    ]
    dataset["meta"]["important_caveats"].append(
        "esg_ratings.governance, founder_led/family_owned, and revenue_geography.profile were "
        "remediated with real SEC EDGAR data in a follow-up pass -- see "
        "data/governance_revenue_remediation_notes.md. Coverage is real but partial by design "
        "(e.g. revenue_geography.profile is null, not a fabricated guess, for companies whose 10-K "
        "does not break out United States revenue specifically)."
    )

    with open(args.output, "w") as f:
        json.dump(dataset, f, indent=2)

    print(f"Merged {len(dataset['companies'])} companies.")
    print(json.dumps(stats, indent=2))


if __name__ == "__main__":
    main()
