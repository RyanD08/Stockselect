#!/usr/bin/env python3
"""
Splits the single merged live dataset (data/values_portfolio_dataset_sp500.json)
into two independently-updatable files:

  - data/financial_dataset_sp500.json: market/fundamentals data (P/E, PEG,
    margins, ROE, beta, market cap, dividend yield, analyst rating, 6mo/1yr
    returns, leverage, performance tier) -- sourced from SEC EDGAR XBRL +
    Finnhub, unrelated to the ESG/governance research pipeline.
  - data/esg_dataset_sp500.json: values/governance data (esg_ratings,
    founder_led, family_owned, sin_stock_flags, animal_testing_exposure,
    revenue_geography, additional_data_sources) -- sourced from EPA/OSHA/
    NLRB, SEC EDGAR filings, and Wikipedia.

Both files carry ticker/name/sector/hq_country as their join key so
js/data.js can fetch both and merge them client-side by ticker. This means
a new ESG dataset can be dropped in (same schema, same tickers) WITHOUT
touching or losing the financial file, and vice versa.

Usage:
  python3 scripts/split_financial_esg_datasets.py \\
      --input data/values_portfolio_dataset_sp500.json \\
      --financial-output data/financial_dataset_sp500.json \\
      --esg-output data/esg_dataset_sp500.json
"""
import argparse
import json

IDENTITY_FIELDS = ["ticker", "name", "sector", "hq_country"]

FINANCIAL_FIELDS = [
    "market_profile", "financial_leverage", "dividend_policy",
    "performance_tier", "financial_metrics",
]

ESG_FIELDS = [
    "founder_led", "family_owned", "sin_stock_flags", "animal_testing_exposure",
    "esg_ratings", "revenue_geography", "additional_data_sources",
]


def split(dataset):
    financial_companies = []
    esg_companies = []
    for c in dataset["companies"]:
        base = {f: c[f] for f in IDENTITY_FIELDS if f in c}

        fin = dict(base)
        for f in FINANCIAL_FIELDS:
            if f in c:
                fin[f] = c[f]
        financial_companies.append(fin)

        esg = dict(base)
        for f in ESG_FIELDS:
            if f in c:
                esg[f] = c[f]
        esg_companies.append(esg)

    financial_meta = dict(dataset.get("meta", {}))
    financial_meta["schema"] = "financial_dataset_sp500 -- market/fundamentals fields only (see scripts/split_financial_esg_datasets.py). Joined to data/esg_dataset_sp500.json by ticker at load time in js/data.js."

    esg_meta = dict(dataset.get("meta", {}))
    esg_meta["schema"] = "esg_dataset_sp500 -- values/governance fields only (see scripts/split_financial_esg_datasets.py). Joined to data/financial_dataset_sp500.json by ticker at load time in js/data.js. This file can be replaced independently to update ESG data without touching financial data."

    return (
        {"meta": financial_meta, "companies": financial_companies},
        {"meta": esg_meta, "companies": esg_companies},
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--financial-output", required=True)
    parser.add_argument("--esg-output", required=True)
    args = parser.parse_args()

    with open(args.input) as f:
        dataset = json.load(f)

    financial, esg = split(dataset)

    with open(args.financial_output, "w") as f:
        json.dump(financial, f, indent=2)
    with open(args.esg_output, "w") as f:
        json.dump(esg, f, indent=2)

    print(f"Wrote {len(financial['companies'])} companies to {args.financial_output}")
    print(f"Wrote {len(esg['companies'])} companies to {args.esg_output}")


if __name__ == "__main__":
    main()
