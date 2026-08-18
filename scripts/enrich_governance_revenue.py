#!/usr/bin/env python3
"""
Dataset remediation pass: replaces four placeholder/never-populated field
groups in data/sp500_full_dataset.json with real per-company data pulled
live from SEC EDGAR (10-K + DEF 14A filings), cross-referenced against the
Wikipedia founder data already captured in the dataset:

  1. Governance -- dual-class/single-class share structure (10-K cover
     page) and fraud/enforcement-record signal (10-K Item 3 Legal
     Proceedings + referenced financial-statement note). See
     scripts/lib/sec_governance.py's docstring for exactly which of the
     task's three named enforcement sources were reachable this pass
     (short answer: none of the three third-party ones were -- Violation
     Tracker and Stanford Securities Class Action Clearinghouse both
     return a Cloudflare bot-challenge 403, and SEC's own litigation-
     release search backend is proxy-blocked -- so this falls back to the
     company's own mandatory Item 3 disclosure, documented per-record).
  2. founder_led / family_owned -- DEF 14A beneficial-ownership table
     cross-referenced against Wikipedia founder names already in this
     dataset. See scripts/lib/sec_ownership.py.
  3. Domestic revenue mix -- 10-K geographic-segment note (via
     FilingSummary.xml R-files), not a sector heuristic. See
     scripts/lib/sec_geo_revenue.py.

Does NOT touch: environmental/social_labor fields, animal_testing_exposure,
five_year_annualized_return_pct_est, analyst_price_target_upside_pct (all
out of scope for this pass -- see the task brief).

Usage:
  python3 scripts/enrich_governance_revenue.py --input data/sp500_full_dataset.json \\
      --tickers AAPL,GOOGL --output data/test_gov_rev.json
  python3 scripts/enrich_governance_revenue.py --input data/sp500_full_dataset.json \\
      --all --output data/governance_revenue_enrichment.json --checkpoint-every 25
"""
import argparse
import datetime
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lib.clients import make_sec_client, make_sec_proxy_client
from lib.sec_text import latest_filing, filing_document_url, html_to_text
from lib import sec_governance, sec_geo_revenue, sec_ownership

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONTACT = "ryan.delp08@gmail.com"
SEC_USER_AGENT = f"Stockselect ESG Research ({CONTACT})"


def load_ticker_cik_map(sec_client, refresh=False):
    body, status, _fc, _fa = sec_client.get_json(
        "https://www.sec.gov/files/company_tickers.json",
        cache_key="company_tickers", refresh=refresh,
    )
    if status != 200:
        raise RuntimeError(f"Failed to fetch SEC company_tickers.json: HTTP {status}")
    out = {}
    for _, entry in body.items():
        out[entry["ticker"].upper()] = entry["cik_str"]
    return out


def enrich_one(ticker, cik, wikipedia_profile, sec_client, sec_proxy_client, as_of, refresh=False):
    result = {"ticker": ticker, "as_of": as_of.isoformat()}
    not_found = lambda reason: {"status": "No verifiable data found", "reason": reason}  # noqa: E731

    if cik is None:
        reason = "No CIK found in SEC company_tickers.json for this ticker"
        result["share_class_structure"] = not_found(reason)
        result["legal_proceedings_signal"] = not_found(reason)
        result["founder_family_ownership"] = not_found(reason)
        result["domestic_revenue_mix"] = not_found(reason)
        return result

    cik10 = str(cik).zfill(10)
    sub_body, sub_status, _fc, _fa = sec_client.get_json(
        f"https://data.sec.gov/submissions/CIK{cik10}.json",
        cache_key=f"submission_{cik10}", refresh=refresh,
    )
    if sub_status != 200:
        reason = f"SEC submissions HTTP {sub_status} for CIK {cik10}"
        result["share_class_structure"] = not_found(reason)
        result["legal_proceedings_signal"] = not_found(reason)
        result["founder_family_ownership"] = not_found(reason)
        result["domestic_revenue_mix"] = not_found(reason)
        return result

    # --- 10-K-derived fields (share class, legal proceedings, geo revenue) ---
    accession, primary_doc, filing_date, form = latest_filing(sub_body, ["10-K", "10-K405"])
    if not accession:
        reason = "No 10-K (or 10-K405) found in SEC filing history -- may be a foreign private issuer filing 20-F instead"
        result["share_class_structure"] = not_found(reason)
        result["legal_proceedings_signal"] = not_found(reason)
        result["domestic_revenue_mix"] = not_found(reason)
    else:
        doc_url = filing_document_url(cik, accession, primary_doc)
        html, status, _fc2, _fa2 = sec_client.get_text(doc_url, cache_key=f"10k_{cik10}", refresh=refresh, timeout=60)
        if status != 200:
            reason = f"HTTP {status} fetching 10-K document {doc_url}"
            result["share_class_structure"] = not_found(reason)
            result["legal_proceedings_signal"] = not_found(reason)
            result["domestic_revenue_mix"] = not_found(reason)
        else:
            doc_text = html_to_text(html)

            share_class, sc_err = sec_governance.extract_share_class_structure(doc_text)
            result["share_class_structure"] = share_class or not_found(sc_err)

            legal, legal_err = sec_governance.extract_legal_proceedings(
                sec_client, cik, accession, doc_text, doc_url, filing_date, f"legal_{cik10}", refresh=refresh,
            )
            result["legal_proceedings_signal"] = legal or not_found(legal_err)

            geo, geo_err = sec_geo_revenue.fetch_domestic_revenue_mix(
                sec_client, cik, accession, doc_text, doc_url, filing_date, f"geo_{cik10}", refresh=refresh,
            )
            result["domestic_revenue_mix"] = geo or not_found(geo_err)

    # --- DEF 14A-derived field (founder/family ownership) ---
    accession_p, primary_doc_p, filing_date_p, _form_p = latest_filing(sub_body, ["DEF 14A"])
    if not accession_p:
        result["founder_family_ownership"] = not_found("No DEF 14A found in SEC filing history")
    else:
        proxy_url = filing_document_url(cik, accession_p, primary_doc_p)
        html_p, status_p, _fc3, _fa3 = sec_proxy_client.get_text(
            proxy_url, cache_key=f"proxy_full_{cik10}", refresh=refresh, timeout=60,
        )
        if status_p != 200:
            result["founder_family_ownership"] = not_found(f"HTTP {status_p} fetching DEF 14A {proxy_url}")
        else:
            fam, fam_err = sec_ownership.build_founder_family_record(
                html_p, wikipedia_profile, proxy_url, filing_date_p,
            )
            result["founder_family_ownership"] = fam or not_found(fam_err)

    return result


def run(companies, output_path, checkpoint_every=25, refresh=False):
    sec_client = make_sec_client(SEC_USER_AGENT)
    sec_proxy_client = make_sec_proxy_client(SEC_USER_AGENT)

    print("Loading SEC ticker/CIK map...")
    ticker_cik = load_ticker_cik_map(sec_client)

    as_of = datetime.date.today()
    results = {}
    errors = []

    for i, (ticker, wiki_infobox) in enumerate(companies):
        cik = ticker_cik.get(ticker.upper())
        try:
            results[ticker] = enrich_one(ticker, cik, wiki_infobox, sec_client, sec_proxy_client, as_of, refresh=refresh)
        except Exception as e:  # noqa: BLE001 - keep the batch going
            errors.append((ticker, f"{type(e).__name__}: {e}"))
            print(f"  ERROR on {ticker}: {type(e).__name__}: {e}", file=sys.stderr)

        if (i + 1) % checkpoint_every == 0 or (i + 1) == len(companies):
            print(f"  [{i + 1}/{len(companies)}] processed, {len(errors)} errors")
            with open(output_path, "w") as f:
                json.dump(
                    {
                        "meta": {
                            "snapshot_date": as_of.isoformat(),
                            "companies_processed": len(results),
                            "total_requested": len(companies),
                            "errors": errors,
                        },
                        "additional_data": results,
                    },
                    f, indent=2,
                )

    print(f"\nWrote {len(results)} enriched records to {output_path}")
    if errors:
        print(f"{len(errors)} errors:")
        for t, e in errors[:30]:
            print(f"  {t}: {e}")
    return results, errors


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, help="Existing sp500 dataset JSON (schema: {meta, companies:[...]})")
    parser.add_argument("--tickers", help="Comma-separated ticker subset (for testing)")
    parser.add_argument("--all", action="store_true", help="Process every company in --input")
    parser.add_argument("--output", required=True)
    parser.add_argument("--checkpoint-every", type=int, default=25)
    parser.add_argument("--refresh", action="store_true")
    args = parser.parse_args()

    with open(args.input) as f:
        base = json.load(f)

    wiki_by_ticker = {}
    for c in base["companies"]:
        wp = c.get("additional_data_sources", {}).get("wikipedia_profile", {}) or {}
        wiki_by_ticker[c["ticker"]] = wp if wp.get("infobox_fields") is not None else {}

    if args.tickers:
        wanted = [t.strip().upper() for t in args.tickers.split(",") if t.strip()]
        companies = [(t, wiki_by_ticker.get(t, {})) for t in wanted]
    elif args.all:
        companies = sorted(wiki_by_ticker.items())
    else:
        parser.error("Must pass --tickers or --all")
        return

    run(companies, args.output, checkpoint_every=args.checkpoint_every, refresh=args.refresh)


if __name__ == "__main__":
    main()
