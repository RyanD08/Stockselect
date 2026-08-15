#!/usr/bin/env python3
"""
Additively enriches esg_ratings.{environmental,social_labor} using free
government data sources -- EPA ECHO (environmental), OSHA + NLRB
(social_labor) -- in place of the Finnhub-paid-tier placeholder currently on
every company. governance is untouched (out of scope for this pass). Only
overwrites fields that are still the untouched placeholder; if a
non-placeholder field disagrees with a new source, the disagreement is
logged in the change report instead of being applied.

The As You Sow sin-stock cross-check (fossilfreefunds.org/gunfreefunds.org)
is NOT implemented: their real data lives behind api.fossilfreefunds.org /
api.gunfreefunds.org, both blocked by this environment's egress policy
(confirmed via the proxy's own diagnostic log -- a policy denial, not a
transient failure). This is called out in every change report this script
produces.

Usage:
  python3 scripts/enrich_esg.py --input data/values_portfolio_dataset_full_market.json \\
      --tickers AAPL,MSFT,XOM --output data/esg_test_batch.json --report data/esg_test_batch_report.json
  python3 scripts/enrich_esg.py --input data/values_portfolio_dataset_full_market.json \\
      --all --output data/values_portfolio_dataset_full_market_esg_enriched.json \\
      --report data/esg_enrichment_report.json
"""
import argparse
import datetime
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lib.clients import make_epa_echo_client, make_osha_client, make_nlrb_client
from lib import epa_echo, osha, nlrb, esg_scoring

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_CONTACT = "ryan.delp08@gmail.com"

AS_YOU_SOW_BLOCKED_NOTE = (
    "As You Sow sin-stock cross-check (fossilfreefunds.org/gunfreefunds.org) was not run: "
    "their company data is served from api.fossilfreefunds.org / api.gunfreefunds.org, both "
    "blocked by this environment's egress policy (403 at the proxy gateway; confirmed via the "
    "proxy's own diagnostic log, not a transient failure). The public-facing site domains "
    "resolve fine but only serve a JS app shell with no server-rendered data. sin_stock_flags "
    "are unchanged from the existing SIC-derived classification."
)


def load_contact():
    env_path = os.path.join(REPO_ROOT, ".env")
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line.startswith("SEC_USER_AGENT="):
                    return line.split("=", 1)[1].strip()
    return os.environ.get("SEC_USER_AGENT", DEFAULT_CONTACT)


def build_epa_result(epa_client, company_name, cache_key, as_of, refresh=False):
    matched, total_searched, err = epa_echo.fetch_matched_facilities(epa_client, company_name, cache_key, refresh=refresh)
    if err:
        return {"score": None, "error": err, "total_searched": total_searched}
    score = epa_echo.score_environmental(matched, as_of)
    if score is None:
        return {"score": None, "error": None, "total_searched": total_searched, "matched_count": len(matched)}

    cutoff = as_of - datetime.timedelta(days=365 * 5)

    def _pd(s):
        if not s:
            return None
        try:
            return datetime.datetime.strptime(s, "%m/%d/%Y").date()
        except ValueError:
            return None

    has_snc = any((f.get("FacSNCFlg") or "").upper() == "Y" for f in matched)
    has_qtrs_nc = any(str(f.get("FacQtrsWithNC") or "").isdigit() and int(f.get("FacQtrsWithNC")) > 0 for f in matched)
    recent_formal_action = any((d := _pd(f.get("FacDateLastFormalAction"))) and d >= cutoff for f in matched)
    recent_penalty = any((d := _pd(f.get("FacDateLastPenalty"))) and d >= cutoff for f in matched)
    was_inspected = any(f.get("FacDateLastInspection") or f.get("FacInspectionCount") not in (None, "", "0") for f in matched)

    return {
        "score": score, "error": None, "total_searched": total_searched, "matched_count": len(matched),
        "has_snc": has_snc, "has_qtrs_nc": has_qtrs_nc,
        "recent_formal_action": recent_formal_action, "recent_penalty": recent_penalty, "was_inspected": was_inspected,
    }


def build_osha_result(osha_client, company_name, cache_key, as_of, refresh=False):
    all_matched, viol_matched, err = osha.fetch_matched_inspections(osha_client, company_name, cache_key, as_of, refresh=refresh)
    if err:
        return None, err
    if not all_matched:
        return None, None
    score, total_violations = osha.score_social_osha(all_matched, viol_matched)
    return {"score": score, "matched_count": len(all_matched), "total_violations": total_violations}, None


def build_nlrb_result(nlrb_client, form_build_id, company_name, cache_key, as_of, refresh=False):
    matched, err = nlrb.fetch_matched_cases(nlrb_client, form_build_id, company_name, cache_key, as_of, refresh=refresh)
    if err:
        return None, err
    if not matched:
        return None, None
    score, ca_count = nlrb.score_social_nlrb(matched)
    if score is None:
        return None, None
    return {"score": score, "matched_count": len(matched), "ca_count": ca_count}, None


def run(input_path, output_path, tickers=None, refresh=False, report_path=None, log_every=5):
    with open(input_path) as f:
        dataset = json.load(f)

    companies = dataset["companies"]
    if tickers:
        wanted = {t.upper().strip() for t in tickers}
        target_companies = [c for c in companies if c["ticker"].upper() in wanted]
    else:
        target_companies = companies

    contact = load_contact()
    epa_client = make_epa_echo_client(contact)
    osha_client = make_osha_client(contact)
    nlrb_client = make_nlrb_client(contact)
    form_build_id = nlrb.prime_session(nlrb_client)

    as_of = datetime.date.today()

    changes = []
    disagreements = []
    no_data_tickers = []
    source_errors = []

    for i, company in enumerate(target_companies):
        ticker = company["ticker"]
        name = company["name"]
        cache_prefix = ticker.replace("/", "_")
        try:
            epa_result = build_epa_result(epa_client, name, f"{cache_prefix}_epa", as_of, refresh=refresh)
            if epa_result.get("error"):
                source_errors.append({"ticker": ticker, "source": "EPA ECHO", "error": epa_result["error"]})

            osha_result, osha_err = build_osha_result(osha_client, name, f"{cache_prefix}_osha", as_of, refresh=refresh)
            if osha_err:
                source_errors.append({"ticker": ticker, "source": "OSHA", "error": osha_err})

            nlrb_result, nlrb_err = build_nlrb_result(nlrb_client, form_build_id, name, f"{cache_prefix}_nlrb", as_of, refresh=refresh)
            if nlrb_err:
                source_errors.append({"ticker": ticker, "source": "NLRB", "error": nlrb_err})

            env_change = esg_scoring.apply_environmental(company, epa_result)
            social_change = esg_scoring.apply_social_labor(company, osha_result, nlrb_result)

            for change in (env_change, social_change):
                if change is None:
                    continue
                if change["type"] == "upgrade":
                    changes.append(change)
                elif change["type"] == "disagreement":
                    disagreements.append(change)

            if env_change is None and social_change is None:
                no_data_tickers.append(ticker)

        except Exception as e:  # noqa: BLE001 - keep the batch going
            source_errors.append({"ticker": ticker, "source": "pipeline", "error": f"{type(e).__name__}: {e}"})

        if (i + 1) % log_every == 0 or (i + 1) == len(target_companies):
            print(f"  [{i + 1}/{len(target_companies)}] processed, {len(changes)} upgrades so far")

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "w") as f:
        json.dump(dataset, f, indent=2)
    print(f"\nWrote {len(companies)} companies ({len(target_companies)} considered for enrichment) to {output_path}")

    report = {
        "run_date": as_of.isoformat(),
        "companies_considered": len(target_companies),
        "upgrades": changes,
        "disagreements": disagreements,
        "no_data_found_tickers": no_data_tickers,
        "source_errors": source_errors,
        "as_you_sow_sin_stock_cross_check": AS_YOU_SOW_BLOCKED_NOTE,
        "governance": "Out of scope for this pass; esg_ratings.governance is unchanged for every company.",
    }
    if report_path:
        with open(report_path, "w") as f:
            json.dump(report, f, indent=2)
        print(f"Change report written to {report_path}")

    print(f"\n{len(changes)} field upgrades, {len(disagreements)} disagreements, "
          f"{len(no_data_tickers)}/{len(target_companies)} companies with no data from any source")

    return dataset, report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--tickers", help="Comma-separated ticker list (omit with --all)")
    parser.add_argument("--all", action="store_true", help="Enrich every company in the input file")
    parser.add_argument("--report", help="Path to write the JSON change report")
    parser.add_argument("--refresh", action="store_true", help="Force re-fetch even if cached")
    args = parser.parse_args()

    if not args.tickers and not args.all:
        parser.error("Must pass --tickers or --all")

    tickers = args.tickers.split(",") if args.tickers else None
    run(args.input, args.output, tickers=tickers, refresh=args.refresh, report_path=args.report)


if __name__ == "__main__":
    main()
