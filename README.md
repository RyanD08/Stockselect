# TrueNorth

Values-guided investing tool, live at [truenorthportfolios.com](https://truenorthportfolios.com).

A visitor answers a 29-question survey about their values (environmental, labor,
governance, social issues) and risk preferences, and TrueNorth scores and builds
a diversified portfolio of S&P 500 companies that fits — with a plain-language
explanation of every pick, a comparison tool, and an optional account to save
results.

## Stack

Deliberately dependency-free on the client: plain HTML/CSS/JS, no framework,
no bundler, no build step. `index.html`/`404.html` load everything via
`<script>` tags, cache-busted with a shared `?v=` query string.

- **Frontend**: static HTML/CSS/JS, deployed via GitHub Pages directly from
  this repo's default branch.
- **Accounts & storage**: Firebase Auth (email/password, with email
  verification) + Firestore (saved surveys/portfolios), governed by
  `firestore.rules`. Fully optional — the survey, scoring, and results work
  for a signed-out visitor exactly the same way.
- **Analytics**: Firebase Analytics, custom events for the key funnel steps
  (survey start/completion, account creation, portfolio save, CSV export,
  etc.) — see `js/firebase-config.js`.
- **Data**: two independently-updatable JSON files merged by ticker at load
  time — `data/financial_dataset_sp500.json` (fundamentals) and
  `data/esg_dataset_sp500.json` (values/governance data). See `js/data.js`
  for exactly how, and the **Data pipeline** section below for where these
  come from.

## Running locally

No install step for the site itself:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

Firebase features (auth/save/analytics) require `truenorthportfolios.com`
and `localhost` to be in that Firebase project's authorized domains, and
won't work if the environment's outbound network is restricted.

## Tests

A small zero-dependency regression suite lives in `tests/` — loads the real
`js/questions.js`/`js/scoring.js` into a Node `vm` context and the real
production datasets, and checks portfolio-building invariants (size caps,
sector caps, determinism, no duplicate tickers) plus a couple of structural
regression guards for bugs this suite has caught before.

```bash
npm test
# or: node tests/run.js
```

Runs automatically on every push via `.github/workflows/test.yml`.

## Data pipeline

`scripts/` holds the offline pipeline that builds the two datasets above
from SEC EDGAR, Finnhub, EPA ECHO, OSHA, NLRB, and Wikipedia sources (see
`scripts/pipeline.py`, `scripts/enrich_esg.py`, and friends). Its raw
intermediate output isn't tracked in this repo — it's large (tens of MB),
not needed to run or deploy the site, and not meant to be public. See
`.gitignore` for the excluded paths; regenerate locally by running the
pipeline scripts (needs `.env` — see `.env.example`) rather than expecting
those files to already exist after a fresh clone.

`scripts/split_financial_esg_datasets.py` is the one that produces the two
files the live site actually reads.

## Repository structure

```
index.html, 404.html   Entry points
js/                     App logic (data loading, scoring, auth, UI)
css/                    Styles
data/                   The two live datasets (see above)
assets/                 Images/icons
tests/                  Regression suite (see Tests)
scripts/                Offline data pipeline (see Data pipeline)
cloudflare-worker/      Optional Worker for rich share-link previews
firestore.rules         Firestore security rules
```

## License

Proprietary — see `LICENSE`. All rights reserved.
