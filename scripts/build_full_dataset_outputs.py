#!/usr/bin/env python3
"""
Merges the base S&P 500 dataset with the additional-sources enrichment pass
into the two deliverables the task asked for:
  - data/sp500_full_dataset.json: the existing 25-question schema, each
    company additively carrying a new "additional_data_sources" block
    (fossilfreefunds, Wikipedia, CEO pay ratio, 8-K activity, plus explicit
    "No verifiable data found" entries for every approved source that could
    not be reached this pass -- see data/mining_session_notes.md).
  - data/candidate_additional_criteria.json: every newly-discovered
    measurable data point, each with a proposed client-facing survey
    question (same plain-language / 1-5-importance style as the existing
    24), the raw data backing it, its source, and real coverage stats
    computed from this run -- kept separate from the official schema
    pending review, per the task's instructions.

Usage:
  python3 scripts/build_full_dataset_outputs.py \\
      --base data/values_portfolio_dataset_sp500.json \\
      --additional data/additional_sources_raw.json \\
      --full-output data/sp500_full_dataset.json \\
      --candidates-output data/candidate_additional_criteria.json
"""
import argparse
import datetime
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def _import_blocked_notes():
    # Reuse the single source of truth for blocked-source reasons defined
    # alongside the fetch logic, rather than duplicating the text here.
    from enrich_additional_sources import BLOCKED_SOURCE_NOTES
    return BLOCKED_SOURCE_NOTES


def build_full_dataset(base, additional_by_ticker, blocked_notes):
    companies = []
    for c in base["companies"]:
        ticker = c["ticker"]
        extra = dict(additional_by_ticker.get(ticker, {}))
        extra.pop("ticker", None)
        extra.pop("as_of", None)
        for key, note in blocked_notes.items():
            extra[key] = note
        new_c = dict(c)
        new_c["additional_data_sources"] = extra
        companies.append(new_c)

    meta = dict(base["meta"])
    meta["purpose"] = (
        base["meta"].get("purpose", "")
        + " Extended in a follow-up aggressive multi-source mining pass: every company's "
        "additional_data_sources block adds fossilfreefunds.org fossil-fuel-involvement + "
        "diversity/equity scores, an en.wikipedia.org founder/HQ/ownership lead, a SEC DEF 14A "
        "CEO pay ratio (Item 402(u)), and a SEC 8-K material-event item summary -- plus explicit "
        "'No verifiable data found' entries (with reasons) for every approved source that could "
        "not be reached from this environment this pass. See data/mining_session_notes.md for "
        "the full investigation log."
    )
    meta["additional_sources_snapshot_date"] = datetime.date.today().isoformat()
    meta["schema_version"] = "2.5-additional-sources"
    return {"meta": meta, "companies": companies}


def _coverage(companies, predicate):
    have = sum(1 for c in companies if predicate(c))
    return have, len(companies)


def build_candidate_criteria(full_dataset):
    companies = full_dataset["companies"]
    total = len(companies)
    candidates = []

    def sample(predicate, n=3):
        out = []
        for c in companies:
            if predicate(c):
                out.append({"ticker": c["ticker"], "name": c["name"]})
                if len(out) >= n:
                    break
        return out

    # 1. Fossil fuel involvement (fossilfreefunds is_dirty)
    has_ff = lambda c: isinstance(c["additional_data_sources"].get("fossil_fuel_screen"), dict) and "involved" in c["additional_data_sources"]["fossil_fuel_screen"]
    involved = lambda c: has_ff(c) and c["additional_data_sources"]["fossil_fuel_screen"]["involved"]
    n_have, _ = _coverage(companies, has_ff)
    n_involved, _ = _coverage(companies, involved)
    ex = [{"ticker": c["ticker"], "name": c["name"], "involved": c["additional_data_sources"]["fossil_fuel_screen"]["involved"], "matched_categories": c["additional_data_sources"]["fossil_fuel_screen"]["matched_categories"]} for c in companies if has_ff(c)][:5]
    candidates.append({
        "criterion_id": "fossil_fuel_involvement_screen",
        "proposed_question": "Excluding companies flagged by an independent fossil-fuel-divestment screen (coal, oil & gas, fossil-fired utilities, or top fossil-reserve holders), beyond the general environmental score",
        "category_guess": "environmental",
        "type_guess": "exclusionary",
        "source": "fossilfreefunds.org (As You Sow), api.fossilfreefunds.org",
        "raw_data_sample": ex,
        "coverage": {"companies_with_data": n_have, "companies_flagged_involved": n_involved, "total_companies": total},
        "note": "This overlaps existing Q1 ('avoiding fossil fuel involvement') but is a direct, named-source screen rather than a proxy off the general EPA-derived environmental score -- could replace or supplement how Q1 is currently scored.",
    })

    # 2-5. fossilfreefunds diversity/equity scores
    score_defs = [
        ("gef_score", "gender_equality_score", "Prioritizing companies with strong, third-party-scored gender equality practices", "governance"),
        ("dei_score", "diversity_disclosures_score", "Prioritizing companies with strong, third-party-scored diversity/DEI disclosure practices", "governance"),
        ("rji_score", "racial_justice_score", "Prioritizing companies with strong, third-party-scored racial justice practices", "social_labor"),
        ("hrc_score", "lgbtq_equity_score", "Prioritizing companies with strong LGBTQ+ workplace equity scores (Human Rights Campaign-style index)", "social_labor"),
    ]
    for field, crit_id, question, cat in score_defs:
        has_field = lambda c, f=field: isinstance(c["additional_data_sources"].get("fossil_fuel_screen"), dict) and f in c["additional_data_sources"]["fossil_fuel_screen"].get("diversity_equity_scores", {})
        n_have, _ = _coverage(companies, has_field)
        ex = [{"ticker": c["ticker"], "name": c["name"], "value": c["additional_data_sources"]["fossil_fuel_screen"]["diversity_equity_scores"][field]["value"]} for c in companies if has_field(c)][:5]
        candidates.append({
            "criterion_id": crit_id,
            "proposed_question": question,
            "category_guess": cat,
            "type_guess": "preference",
            "source": "fossilfreefunds.org (As You Sow), api.fossilfreefunds.org (0-100 scale, higher = better)",
            "raw_data_sample": ex,
            "coverage": {"companies_with_data": n_have, "total_companies": total},
            "note": "Bundled in the same fossilfreefunds.org API response as the fossil-fuel screen; not fossil-fuel-related itself.",
        })

    # 6. CEO pay ratio
    has_ratio = lambda c: c["additional_data_sources"].get("ceo_pay_ratio", {}).get("ceo_to_median_employee_pay_ratio_numeric") is not None
    n_have, _ = _coverage(companies, has_ratio)
    ex = [{"ticker": c["ticker"], "name": c["name"], "ratio": c["additional_data_sources"]["ceo_pay_ratio"]["ceo_to_median_employee_pay_ratio"], "filing_date": c["additional_data_sources"]["ceo_pay_ratio"]["filing_date"]} for c in companies if has_ratio(c)][:5]
    candidates.append({
        "criterion_id": "ceo_pay_ratio",
        "proposed_question": "Avoiding companies with a very high CEO-to-median-employee pay ratio",
        "category_guess": "governance",
        "type_guess": "exclusionary",
        "source": "SEC EDGAR DEF 14A proxy statement, Item 402(u) mandatory disclosure",
        "raw_data_sample": ex,
        "coverage": {"companies_with_data": n_have, "total_companies": total},
        "note": "Exact figure, not a tier -- extracted by regex from each company's latest proxy statement. Methodology varies company-to-company within SEC-permitted bounds (see field note).",
    })

    # 7. 8-K bankruptcy/restatement/impairment flag
    has_8k = lambda c: isinstance(c["additional_data_sources"].get("recent_8k_activity"), dict) and "bankruptcy_restatement_impairment_flag" in c["additional_data_sources"]["recent_8k_activity"]
    flagged = lambda c: has_8k(c) and c["additional_data_sources"]["recent_8k_activity"]["bankruptcy_restatement_impairment_flag"]
    n_have, _ = _coverage(companies, has_8k)
    n_flagged, _ = _coverage(companies, flagged)
    ex = [{"ticker": c["ticker"], "name": c["name"], "item_counts": list(c["additional_data_sources"]["recent_8k_activity"]["item_counts"].keys())} for c in companies if flagged(c)][:5]
    candidates.append({
        "criterion_id": "recent_bankruptcy_restatement_impairment",
        "proposed_question": "Avoiding companies that recently disclosed a bankruptcy, financial restatement, or major asset impairment (SEC 8-K filing, trailing 2 years)",
        "category_guess": "governance",
        "type_guess": "exclusionary",
        "source": "SEC EDGAR submissions API, standardized 8-K item numbers (1.03/2.06/4.02)",
        "raw_data_sample": ex,
        "coverage": {"companies_with_data": n_have, "companies_flagged": n_flagged, "total_companies": total},
        "note": "Objective filing-metadata flag, not a text/sentiment read of filing content.",
    })

    # 8. Wikipedia-sourced founder/leadership lead (explicitly low-confidence, needs verification)
    def _founder_field(c):
        fields = c["additional_data_sources"].get("wikipedia_profile", {})
        fields = fields.get("infobox_fields", {}) if isinstance(fields, dict) else {}
        return fields.get("founders") or fields.get("founder")
    has_wiki_founders = lambda c: _founder_field(c) is not None
    n_have, _ = _coverage(companies, has_wiki_founders)
    ex = [{"ticker": c["ticker"], "name": c["name"], "founders": _founder_field(c)} for c in companies if has_wiki_founders(c)][:5]
    candidates.append({
        "criterion_id": "wikipedia_founder_lead",
        "proposed_question": "(Supporting data for existing Q18 'founder-led/family-owned' -- not a new question) Wikipedia infobox founders/key_people text, to be verified against a primary source before use",
        "category_guess": "community",
        "type_guess": "preference",
        "source": "en.wikipedia.org infobox wikitext",
        "raw_data_sample": ex,
        "coverage": {"companies_with_data": n_have, "total_companies": total},
        "note": "Explicitly Low confidence per the task's own instruction that Wikipedia is a lead, not a final source -- especially for anything ownership-related. A reviewer still needs to cross-check infobox_fields.founders/key_people against current SEC-registered leadership before founder_led/family_owned booleans are set from it.",
    })

    # Blocked-source candidates: still listed, 0 coverage, per the task's
    # "don't filter something out just because data collection failed" rule.
    blocked_notes = _import_blocked_notes()
    blocked_candidates = [
        {
            "criterion_id": "weapons_industry_involvement_gunfreefunds",
            "proposed_question": "Avoiding companies flagged by an independent firearms/weapons-industry involvement screen (beyond the existing SIC-code-derived weapons_defense flag)",
            "category_guess": "ethical",
            "type_guess": "exclusionary",
            "source": "gunfreefunds.org (As You Sow), api.gunfreefunds.org",
            "raw_data_sample": [],
            "coverage": {"companies_with_data": 0, "total_companies": total},
            "note": blocked_notes["gunfreefunds"]["reason"],
        },
        {
            "criterion_id": "bcorp_certification",
            "proposed_question": "Prioritizing certified B Corporations",
            "category_guess": "governance",
            "type_guess": "preference",
            "source": "bcorporation.net",
            "raw_data_sample": [],
            "coverage": {"companies_with_data": 0, "total_companies": total},
            "note": blocked_notes["bcorp_certification"]["reason"],
        },
        {
            "criterion_id": "sbti_validated_climate_targets",
            "proposed_question": "Prioritizing companies with a Science Based Targets initiative (SBTi) validated emissions-reduction target",
            "category_guess": "environmental",
            "type_guess": "preference",
            "source": "sciencebasedtargets.org",
            "raw_data_sample": [],
            "coverage": {"companies_with_data": 0, "total_companies": total},
            "note": blocked_notes["sbti_validated_targets"]["reason"],
        },
        {
            "criterion_id": "just_capital_rank",
            "proposed_question": "Prioritizing companies that rank highly in JUST Capital's annual stakeholder-treatment survey",
            "category_guess": "social_labor",
            "type_guess": "preference",
            "source": "justcapital.com",
            "raw_data_sample": [],
            "coverage": {"companies_with_data": 0, "total_companies": total},
            "note": blocked_notes["justcapital_rank"]["reason"],
        },
        {
            "criterion_id": "board_diversity_matrix_pct",
            "proposed_question": "Prioritizing companies with greater board gender/racial diversity",
            "category_guess": "governance",
            "type_guess": "preference",
            "source": "SEC EDGAR DEF 14A proxy statement, Board Diversity Matrix disclosure",
            "raw_data_sample": [],
            "coverage": {"companies_with_data": 0, "total_companies": total},
            "note": "Attempted and deliberately dropped this pass -- see data/mining_session_notes.md 'Board diversity matrix' section for why a blind regex extraction was judged unsafe at this scale.",
        },
        {
            "criterion_id": "sector_osha_injury_rate_benchmark",
            "proposed_question": "(Supporting/contextual data, not a standalone question) Comparing a company's own OSHA-derived safety record against its industry's BLS-published injury/illness rate baseline",
            "category_guess": "social_labor",
            "type_guess": "preference",
            "source": "www.bls.gov",
            "raw_data_sample": [],
            "coverage": {"companies_with_data": 0, "total_companies": total},
            "note": "www.bls.gov is reachable but the specific injury/illness-by-industry release table renders via JavaScript with no data present in the raw HTTP response; see data/mining_session_notes.md.",
        },
    ]
    candidates.extend(blocked_candidates)

    return {
        "meta": {
            "purpose": (
                "Every additional, measurable, per-company data point discovered while mining the "
                "task's approved source list beyond the existing 24-question survey schema (see "
                "js/questions.js). Kept separate from the official schema pending human review, per "
                "the task's instructions -- not renumbered or auto-inserted into the live survey."
            ),
            "snapshot_date": datetime.date.today().isoformat(),
            "total_companies_in_dataset": total,
            "note_on_existing_schema": (
                "The live site currently implements 24 rated questions + 1 time-horizon selector "
                "across 6 categories (environmental, social_labor, governance, ethical, community, "
                "risk) -- see js/questions.js. The task brief described a 28-question survey "
                "including 'religious/values' and 'political/social' categories not present in the "
                "current implementation; no data was collected for those two categories this pass "
                "since there's no existing field for them to enrich and none of the approved "
                "sources publish anything mappable to religious-compliance screening specifically."
            ),
        },
        "candidate_criteria": candidates,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True)
    parser.add_argument("--additional", required=True)
    parser.add_argument("--full-output", required=True)
    parser.add_argument("--candidates-output", required=True)
    args = parser.parse_args()

    with open(args.base) as f:
        base = json.load(f)
    with open(args.additional) as f:
        additional = json.load(f)

    additional_by_ticker = additional["additional_data"]
    blocked_notes = _import_blocked_notes()

    full_dataset = build_full_dataset(base, additional_by_ticker, blocked_notes)
    with open(args.full_output, "w") as f:
        json.dump(full_dataset, f, indent=2)
    print(f"Wrote {len(full_dataset['companies'])} companies to {args.full_output}")

    candidates = build_candidate_criteria(full_dataset)
    with open(args.candidates_output, "w") as f:
        json.dump(candidates, f, indent=2)
    print(f"Wrote {len(candidates['candidate_criteria'])} candidate criteria to {args.candidates_output}")


if __name__ == "__main__":
    main()
