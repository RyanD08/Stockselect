/**
 * Simulator: paper trading with $100,000 in virtual cash.
 *
 * PRACTICE MODE (current). Real market prices and server-side trades need
 * the trading Cloudflare Worker (workers/trading/, not built yet). Until
 * SIM_TRADING_WORKER_URL is set, this runs entirely in the browser:
 *   - Prices are SIMULATED, labeled as such on the page. Each company gets
 *     a fixed starting price, then a deterministic daily random walk (the
 *     same walk for every visitor, tied to the real trading calendar), so a
 *     price only changes while the real US market is open.
 *   - The practice portfolio is stored in this browser's localStorage,
 *     keyed by Firebase uid -- never written to Firestore, so it can't
 *     collide with the Worker-only simPortfolios/{uid} data the real
 *     version will use.
 *   - The trading rules are the real ones from the spec: $100,000 start,
 *     long only, fractional shares to 4 decimals, market orders, no
 *     commission, and trades only 9:30 AM-4:00 PM Eastern on NYSE trading
 *     days.
 * The Values Alignment score is real in both modes: valuesFitScore()
 * (scoring.js) against the user's own survey answers.
 *
 * Every top-level name here is prefixed `sim` because all of this site's
 * scripts share one global scope (plain <script> tags, no modules).
 */

const SIM_START_CASH = 100000;
// Set to the trading Worker's URL once it's deployed (see workers/trading/)
// to switch from practice mode to real quotes and server-side trades.
const SIM_TRADING_WORKER_URL = null;
const SIM_PRACTICE_EPOCH = '2026-08-27'; // trading day 0 of the simulated price walk
const SIM_MARKET_OPEN_MIN = 9 * 60 + 30;
const SIM_MARKET_CLOSE_MIN = 16 * 60;
const SIM_REFRESH_MS = 60 * 1000; // spec: refresh prices at most once a minute
// Portfolio-level label thresholds. The floor is the scoring engine's own
// MINIMUM_VALUES_MATCH (scoring.js); "strong" is a display-only cutoff --
// real valuesFitScore() results cluster roughly 45-63.
const SIM_STRONG_FIT_SCORE = 56;
// Full-day NYSE closures. Early (1 PM) closes aren't modeled.
const SIM_NYSE_HOLIDAYS = new Set([
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03',
  '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05',
  '2027-09-06', '2027-11-25', '2027-12-24',
]);
const SIM_COLOR_YOU = '#2b4c85';
const SIM_COLOR_SPY = '#a8791f';

// A signed-out visitor who clicks "Simulator" -- same pattern as
// pendingMyBadgesRedirect (js/badges.js), handled in auth.js.
let pendingSimulatorRedirect = false;

const simState = {
  uid: null,
  portfolio: null,
  storageError: null,
  selected: null,
  side: 'buy',
  mode: 'dollars',
  amount: '',
  review: null,
  error: '',
  confirmReset: false,
  searchQuery: '',
  autoLoadState: 'idle',
  timer: null,
};

// ---------- deterministic practice prices ----------

function simHash(str) {
  let h = 2166136261;
  for (const ch of str) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function simRandom(seed) {
  let a = seed | 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function simGauss(rand) {
  let u = 0;
  let v = 0;
  while (!u) u = rand();
  while (!v) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const simMarketReturns = [0];
function simMarketReturn(day) {
  if (simMarketReturns[day] === undefined) simMarketReturns[day] = 0.0004 + 0.0092 * simGauss(simRandom(90001 + day * 7919));
  return simMarketReturns[day];
}

// Stand-in for the S&P 500 (SPY): index level on each trading day's close.
const simSpyLevels = [100];
function simSpyLevel(day) {
  for (let i = simSpyLevels.length; i <= day; i++) simSpyLevels[i] = simSpyLevels[i - 1] * (1 + simMarketReturn(i));
  return simSpyLevels[day];
}

function simBasePrice(company) {
  const tierMultiplier = { Mega: 2.2, Large: 1.3, Mid: 0.8, Small: 0.6 }[company.market_profile && company.market_profile.market_cap_tier] || 1;
  return Math.round((25 + (simHash(company.ticker) % 260)) * tierMultiplier * 100) / 100;
}

const simCloseCache = new Map();
function simClosePrice(company, day) {
  let closes = simCloseCache.get(company.ticker);
  if (!closes) {
    closes = [simBasePrice(company)];
    simCloseCache.set(company.ticker, closes);
  }
  const rawBeta = company.market_profile && company.market_profile.beta_est;
  const beta = Math.min(2.3, Math.max(0.3, typeof rawBeta === 'number' ? rawBeta : 1));
  for (let i = closes.length; i <= day; i++) {
    const idio = 0.012 * simGauss(simRandom((simHash(company.ticker) ^ Math.imul(i, 2654435761)) >>> 0));
    const r = Math.max(-0.15, Math.min(0.15, beta * simMarketReturn(i) + idio));
    closes[i] = closes[i - 1] * (1 + r);
  }
  return closes[day];
}

// ---------- trading calendar & market hours ----------

function simEasternParts(date) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return { ymd: `${p.year}-${p.month}-${p.day}`, minutes: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}

function simIsTradingDate(ymd) {
  const weekday = new Date(`${ymd}T12:00:00Z`).getUTCDay();
  return weekday !== 0 && weekday !== 6 && !SIM_NYSE_HOLIDAYS.has(ymd);
}

const simCalendar = [SIM_PRACTICE_EPOCH];
function simDateOfDay(day) {
  while (simCalendar.length <= day) {
    const next = new Date(`${simCalendar[simCalendar.length - 1]}T12:00:00Z`);
    do {
      next.setUTCDate(next.getUTCDate() + 1);
    } while (!simIsTradingDate(next.toISOString().slice(0, 10)));
    simCalendar.push(next.toISOString().slice(0, 10));
  }
  return simCalendar[day];
}

// Index of the most recent trading day on or before `ymd`.
function simDayIndexFor(ymd) {
  if (ymd < SIM_PRACTICE_EPOCH) return 0;
  let day = 0;
  while (simDateOfDay(day + 1) <= ymd) day++;
  return day;
}

// Everything time-dependent on the page reads from this one snapshot.
function simClock(now) {
  const et = simEasternParts(now || new Date());
  const tradingToday = simIsTradingDate(et.ymd);
  const day = simDayIndexFor(et.ymd);
  const open = tradingToday && et.minutes >= SIM_MARKET_OPEN_MIN && et.minutes < SIM_MARKET_CLOSE_MIN;
  let fraction = 1; // fraction of today's session elapsed (1 = at/after close)
  if (tradingToday && et.minutes < SIM_MARKET_OPEN_MIN) fraction = 0;
  else if (open) fraction = (et.minutes - SIM_MARKET_OPEN_MIN) / (SIM_MARKET_CLOSE_MIN - SIM_MARKET_OPEN_MIN);
  return { day, open, tradingToday, fraction, minutes: et.minutes, ymd: et.ymd };
}

// Live practice price: glides from yesterday's close to today's close over
// the session, with a small per-minute wobble that fades out by the close.
function simLivePrice(company, clock) {
  const today = simClosePrice(company, clock.day);
  if (clock.fraction >= 1 || clock.day === 0) return simRound2(today);
  const prev = simClosePrice(company, clock.day - 1);
  if (clock.fraction <= 0) return simRound2(prev);
  const wobble = 0.0015 * (1 - clock.fraction) * simGauss(simRandom((simHash(company.ticker) ^ (clock.day * 100000 + clock.minutes)) >>> 0));
  return simRound2(prev * Math.pow(today / prev, clock.fraction) * (1 + wobble));
}

function simLiveSpyLevel(clock) {
  if (clock.fraction >= 1 || clock.day === 0) return simSpyLevel(clock.day);
  const prev = simSpyLevel(clock.day - 1);
  if (clock.fraction <= 0) return prev;
  return prev * Math.pow(simSpyLevel(clock.day) / prev, clock.fraction);
}

// ---------- trade engine (pure) ----------

function simFloor4(n) {
  return Math.floor(n * 10000 + 1e-7) / 10000;
}
function simRound4(n) {
  return Math.round(n * 10000) / 10000;
}
function simRound2(n) {
  return Math.round(n * 100) / 100;
}

// spyBase is the S&P level at the moment the portfolio was created, so the
// "same $100,000 in the S&P 500" comparison starts exactly when you do,
// not at that day's close.
function simNewPortfolio(day, spyBase) {
  return { version: 1, createdDay: day, createdAt: new Date().toISOString(), spyBase: spyBase || simSpyLevel(day), cash: SIM_START_CASH, holdings: {}, txns: [] };
}

function simSpyBase(portfolio) {
  return portfolio.spyBase || simSpyLevel(portfolio.createdDay);
}

// Validates an order against the rules and sizes it. Returns
// { ok: true, shares, total } or { ok: false, error }.
function simSizeOrder({ side, mode, amount, price, cash, ownedShares, ticker }) {
  const value = Number(amount);
  if (!(value > 0) || !(price > 0)) return { ok: false, error: 'Enter an amount greater than zero.' };
  const shares = mode === 'dollars' ? simFloor4(value / price) : simFloor4(value);
  if (!(shares >= 0.0001)) return { ok: false, error: 'That amount is too small. The minimum is 0.0001 shares.' };
  const total = simRound2(shares * price);
  if (side === 'buy' && total > cash + 0.001) {
    return { ok: false, error: `That order costs ${simMoney(total)}, but you have ${simMoney(cash)} in cash.` };
  }
  if (side === 'sell' && shares > ownedShares + 0.00001) {
    return {
      ok: false,
      error:
        ownedShares > 0
          ? `You only own ${ownedShares.toFixed(4)} shares of ${ticker}. Short selling isn't allowed.`
          : `You don't own any ${ticker}. Short selling isn't allowed.`,
    };
  }
  return { ok: true, shares, total };
}

function simApplyTrade(portfolio, tx) {
  const total = simRound2(tx.shares * tx.price);
  const holding = portfolio.holdings[tx.ticker] || { shares: 0, avgCost: 0 };
  if (tx.side === 'buy') {
    const newShares = simRound4(holding.shares + tx.shares);
    holding.avgCost = (holding.shares * holding.avgCost + tx.shares * tx.price) / newShares;
    holding.shares = newShares;
    portfolio.cash = simRound2(portfolio.cash - total);
    portfolio.holdings[tx.ticker] = holding;
  } else {
    holding.shares = simRound4(holding.shares - tx.shares);
    portfolio.cash = simRound2(portfolio.cash + total);
    if (holding.shares < 0.0001) delete portfolio.holdings[tx.ticker];
    else portfolio.holdings[tx.ticker] = holding;
  }
  portfolio.txns.push({ ...tx, total });
}

// ---------- storage ----------

function simStorageKey(uid) {
  return `truenorth-sim-practice-v1:${uid}`;
}

function simLoadPortfolio(uid) {
  try {
    const raw = localStorage.getItem(simStorageKey(uid));
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (!p || typeof p.cash !== 'number' || !p.holdings || !Array.isArray(p.txns)) return null;
    return p;
  } catch (err) {
    return null;
  }
}

function simSavePortfolio() {
  try {
    localStorage.setItem(simStorageKey(simState.uid), JSON.stringify(simState.portfolio));
    simState.storageError = null;
  } catch (err) {
    simState.storageError = "Your browser isn't letting this page save, so your practice trades will be lost when you leave. Private browsing mode often causes this.";
  }
}

function simForgetUser(uid) {
  try {
    localStorage.removeItem(simStorageKey(uid));
  } catch (err) {
    /* nothing stored, or storage blocked */
  }
}

// ---------- formatting ----------

const simUsd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
function simMoney(n) {
  return simUsd.format(Math.abs(n) < 0.005 ? 0 : n);
}
function simSignedMoney(n) {
  return (n > 0.004 ? '+' : n < -0.004 ? '−' : '') + simUsd.format(Math.abs(n));
}
function simSignedPct(n) {
  return (n > 0.00004 ? '+' : n < -0.00004 ? '−' : '') + Math.abs(n * 100).toFixed(2) + '%';
}
function simTrend(n) {
  return n > 0.004 ? 'sim-up' : n < -0.004 ? 'sim-down' : 'sim-flat';
}
function simArrow(n) {
  return n > 0.004 ? '▲ ' : n < -0.004 ? '▼ ' : '';
}
function simShortDate(day) {
  return new Date(`${simDateOfDay(day)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
function simLongDate(day) {
  return new Date(`${simDateOfDay(day)}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}
function simClockTime(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
function simBand(score) {
  if (score >= SIM_STRONG_FIT_SCORE) return { cls: 'strong', label: 'Strong fit' };
  if (score >= MINIMUM_VALUES_MATCH) return { cls: 'meets', label: 'Meets your floor' };
  return { cls: 'below', label: 'Below your floor' };
}

// ---------- data access ----------

let simCompanyIndex = null;
function simCompany(ticker) {
  if (!state.dataset) return null;
  if (!simCompanyIndex || simCompanyIndex.source !== state.dataset) {
    simCompanyIndex = { source: state.dataset, map: new Map(state.dataset.companies.map((c) => [c.ticker, c])) };
  }
  return simCompanyIndex.map.get(ticker) || null;
}

function simValuesScore(company) {
  const ctx = { homeCountry: state.homeCountry, tiesSector: state.tiesSector, timeHorizon: state.timeHorizon };
  return valuesFitScore(company, state.answers, ctx); // js/scoring.js
}

function simHoldingRows(clock) {
  return Object.entries(simState.portfolio.holdings)
    .map(([ticker, h]) => {
      const company = simCompany(ticker);
      if (!company) return null;
      const price = simLivePrice(company, clock);
      const value = h.shares * price;
      const cost = h.shares * h.avgCost;
      return { ticker, h, company, price, value, gain: value - cost, gainPct: cost > 0 ? (value - cost) / cost : 0 };
    })
    .filter(Boolean)
    .sort((a, b) => b.value - a.value);
}

function simTotals(clock) {
  const rows = simHoldingRows(clock);
  const invested = rows.reduce((sum, r) => sum + r.value, 0);
  const total = simState.portfolio.cash + invested;
  const gain = total - SIM_START_CASH;
  const spyValue = (SIM_START_CASH * simLiveSpyLevel(clock)) / simSpyBase(simState.portfolio);
  return { rows, invested, total, gain, gainPct: gain / SIM_START_CASH, spyValue, spyPct: spyValue / SIM_START_CASH - 1 };
}

// Replays the trade log to get each trading day's closing value since the
// portfolio was created (the real version's after-close snapshot job will
// store these instead). Today's point uses live prices.
function simHistory(clock) {
  const p = simState.portfolio;
  const running = { cash: SIM_START_CASH, holdings: {} };
  const points = [];
  for (let d = p.createdDay; d <= clock.day; d++) {
    for (const tx of p.txns) {
      if (tx.day !== d) continue;
      const shares = simRound4((running.holdings[tx.ticker] || 0) + (tx.side === 'buy' ? tx.shares : -tx.shares));
      if (shares < 0.0001) delete running.holdings[tx.ticker];
      else running.holdings[tx.ticker] = shares;
      running.cash = simRound2(running.cash + (tx.side === 'buy' ? -tx.total : tx.total));
    }
    const isToday = d === clock.day;
    let value = running.cash;
    for (const [ticker, shares] of Object.entries(running.holdings)) {
      const company = simCompany(ticker);
      if (company) value += shares * (isToday ? simLivePrice(company, clock) : simClosePrice(company, d));
    }
    const spy = (SIM_START_CASH * (isToday ? simLiveSpyLevel(clock) : simSpyLevel(d))) / simSpyBase(p);
    points.push({ day: d, you: value, spy });
  }
  return points;
}

// ---------- navigation ----------

function openSimulator() {
  if (typeof firebaseReady === 'undefined' || !firebaseReady || !authState.user) return;
  simState.uid = authState.user.uid;
  const clock = simClock();
  simState.portfolio = simLoadPortfolio(simState.uid);
  if (!simState.portfolio) {
    simState.portfolio = simNewPortfolio(clock.day, simLiveSpyLevel(clock));
    simSavePortfolio();
  }
  Object.assign(simState, { selected: null, side: 'buy', mode: 'dollars', amount: '', review: null, error: '', confirmReset: false, searchQuery: '' });
  if (simState.autoLoadState !== 'loading') simState.autoLoadState = 'idle';
  state.view = 'simulator';
  render();
  simEnsureSurveyAnswers();
  simStartRefreshTimer();
  if (!state.dataset && !state.datasetError) loadDatasetIntoState().then(() => state.view === 'simulator' && renderInPlace()); // js/app.js
}

// Same auto-load as Ticker Tester: a signed-in user who hasn't finished the
// survey this visit gets their most recent saved portfolio's answers.
function simEnsureSurveyAnswers() {
  if (state.hasPersonalizedAnswers || simState.autoLoadState !== 'idle') return;
  simState.autoLoadState = 'loading';
  listSavedPortfolios() // js/auth.js
    .then((portfolios) => {
      if (portfolios.length > 0) {
        state.answers = { ...portfolios[0].answers };
        state.touchedQuestionIds = new Set(QUESTIONS.filter((q) => q.type !== 'horizon').map((q) => q.id));
        state.hasPersonalizedAnswers = true;
      }
      simState.autoLoadState = portfolios.length > 0 ? 'done' : 'none-found';
    })
    .catch((err) => {
      console.error('Simulator: auto-loading the most recent saved portfolio failed:', err);
      simState.autoLoadState = 'error';
    })
    .finally(() => {
      if (state.view === 'simulator') simRenderValues();
    });
}

function simStartRefreshTimer() {
  if (simState.timer) clearInterval(simState.timer);
  simState.timer = setInterval(() => {
    if (state.view !== 'simulator') {
      clearInterval(simState.timer);
      simState.timer = null;
      return;
    }
    if (document.hidden) return;
    simRefreshLive();
  }, SIM_REFRESH_MS);
}

// Called from auth.js whenever the signed-in user goes away.
function simResetForSignOut() {
  if (simState.timer) clearInterval(simState.timer);
  Object.assign(simState, { uid: null, portfolio: null, timer: null, autoLoadState: 'idle', selected: null, review: null });
}

// ---------- rendering ----------

function renderSimulator() {
  if (!simState.portfolio) {
    appEl.innerHTML = '<section class="card"><p class="muted">Log in to use the Simulator.</p></section>';
    return;
  }
  if (!state.dataset) {
    appEl.innerHTML = `<section class="card"><p class="eyebrow">Simulator</p><h1>Paper Trading</h1>${
      state.datasetError
        ? `<p class="error-text">${escapeHtml(state.datasetError)}</p>`
        : `<p class="muted">${spinnerHtml('Loading companies…')}</p>`
    }</section>`;
    return;
  }

  appEl.innerHTML = `
    <div class="sim-page">
      <section class="card sim-intro">
        <div class="sim-intro-text">
          <p class="eyebrow">Simulator</p>
          <h1>Paper Trading</h1>
          <p class="lede">Practice investing with $100,000 in virtual cash. No real money is involved.</p>
        </div>
        <div id="sim-market"></div>
        <p class="sim-practice-note">
          <strong>Practice mode:</strong> prices are simulated for now, not live market quotes. Your practice
          portfolio is saved in this browser only.
        </p>
        ${simState.storageError ? `<p class="error-text">${escapeHtml(simState.storageError)}</p>` : ''}
      </section>

      <section class="card sim-stats" id="sim-stats" aria-label="Portfolio summary"></section>

      <section class="card">
        <div class="sim-card-head">
          <h2>Performance</h2>
          <div class="sim-legend">
            <span class="sim-legend-item"><span class="sim-swatch sim-swatch-you"></span>Your portfolio</span>
            <span class="sim-legend-item"><span class="sim-swatch sim-swatch-spy"></span>$100,000 in the S&amp;P 500</span>
          </div>
        </div>
        <div class="sim-chart-wrap" id="sim-chart-wrap">
          <div id="sim-chart"></div>
          <div class="sim-tooltip" id="sim-tooltip" hidden></div>
        </div>
        <p class="sim-chart-note muted" id="sim-chart-note" hidden></p>
        <details class="sim-table-view">
          <summary>View as table</summary>
          <div class="sim-table-scroll" id="sim-history-table"></div>
        </details>
      </section>

      <div class="sim-two-up">
        <section class="card" aria-labelledby="sim-trade-title">
          <div class="sim-card-head"><h2 id="sim-trade-title">Trade</h2><span class="muted sim-small">Market orders only</span></div>
          <div class="ticker-search">
            <label for="sim-search-input">Search S&amp;P 500 companies</label>
            <input id="sim-search-input" type="search" autocomplete="off" placeholder="e.g. Apple or AAPL" value="${escapeHtml(simState.searchQuery)}" />
            <ul class="ticker-search-results" id="sim-search-results" hidden></ul>
          </div>
          <div id="sim-trade"></div>
        </section>
        <section class="card" aria-labelledby="sim-values-title">
          <div class="sim-card-head"><h2 id="sim-values-title">Values Alignment</h2></div>
          <div id="sim-values"></div>
        </section>
      </div>

      <section class="card" aria-labelledby="sim-holdings-title">
        <div class="sim-card-head"><h2 id="sim-holdings-title">Holdings</h2><span class="muted sim-small">Tap a row to trade it</span></div>
        <div id="sim-holdings"></div>
      </section>

      <section class="card" aria-labelledby="sim-trades-title">
        <div class="sim-card-head"><h2 id="sim-trades-title">Recent Trades</h2></div>
        <ul class="sim-trades" id="sim-trades"></ul>
      </section>

      <section class="card sim-reset-card" id="sim-reset"></section>

      <p class="sim-footnote muted">Prices refresh at most once a minute while this page is open. Educational tool, not investment advice.</p>
    </div>
  `;

  simWireSearch();
  simRenderAllSections();
}

function simRenderAllSections() {
  const clock = simClock();
  simRenderMarket(clock);
  simRenderStats(clock);
  simRenderChart(clock);
  simRenderTrade(clock);
  simRenderValues(clock);
  simRenderHoldings(clock);
  simRenderTrades();
  simRenderReset();
}

// Minute tick: refresh every price-driven section, but leave the order
// form alone so a half-typed amount or open review isn't wiped out.
function simRefreshLive() {
  if (!document.getElementById('sim-stats')) return;
  const clock = simClock();
  simRenderMarket(clock);
  simRenderStats(clock);
  simRenderChart(clock);
  simRenderValues(clock);
  simRenderHoldings(clock);
  simUpdateQuote(clock);
}

function simRenderMarket(clock) {
  const el = document.getElementById('sim-market');
  if (!el) return;
  el.innerHTML = clock.open
    ? `<span class="sim-market-pill sim-market-open"><span class="sim-dot"></span>Market open <span class="sim-market-clock">· ${simClockTime(clock.minutes)} ET, closes 4:00 PM</span></span>`
    : `<span class="sim-market-pill sim-market-closed"><span class="sim-dot"></span>Market closed <span class="sim-market-clock">· opens 9:30 AM ET on trading days</span></span>`;
}

function simRenderStats(clock) {
  const el = document.getElementById('sim-stats');
  if (!el) return;
  const t = simTotals(clock);
  const vsSpy = t.gainPct - t.spyPct;
  el.innerHTML = `
    <div class="sim-stat"><div class="sim-stat-label">Total value</div><div class="sim-stat-value">${simMoney(t.total)}</div>
      <div class="sim-stat-sub muted">Started with ${simMoney(SIM_START_CASH)}</div></div>
    <div class="sim-stat"><div class="sim-stat-label">Cash</div><div class="sim-stat-value">${simMoney(simState.portfolio.cash)}</div>
      <div class="sim-stat-sub muted">${((simState.portfolio.cash / t.total) * 100).toFixed(1)}% of portfolio</div></div>
    <div class="sim-stat"><div class="sim-stat-label">Total gain/loss</div><div class="sim-stat-value ${simTrend(t.gain)}">${simSignedMoney(t.gain)}</div>
      <div class="sim-stat-sub ${simTrend(t.gain)}">${simArrow(t.gain)}${simSignedPct(t.gainPct)} since ${simShortDate(simState.portfolio.createdDay)}</div></div>
    <div class="sim-stat"><div class="sim-stat-label">vs. S&amp;P 500</div><div class="sim-stat-value ${simTrend(vsSpy)}">${simSignedPct(vsSpy)}</div>
      <div class="sim-stat-sub muted">S&amp;P ${simSignedPct(t.spyPct)} over the same days</div></div>`;
}

function simNiceStep(range) {
  const raw = range / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
}
function simK(v) {
  return '$' + (Math.abs(v % 1000) > 0.5 ? (v / 1000).toFixed(1) : (v / 1000).toFixed(0)) + 'k';
}

function simRenderChart(clock) {
  const host = document.getElementById('sim-chart');
  if (!host) return;
  const note = document.getElementById('sim-chart-note');
  const pts = simHistory(clock);
  const W = Math.max(280, Math.round(host.clientWidth || 600));
  const H = W < 520 ? 230 : 280;
  const wide = W >= 560;
  const m = { l: 52, r: wide ? 112 : 12, t: 14, b: 30 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;

  const all = pts.flatMap((p) => [p.you, p.spy]).concat(SIM_START_CASH);
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  const pad = Math.max((hi - lo) * 0.12, 600);
  lo -= pad;
  hi += pad;
  const step = simNiceStep(hi - lo);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  const y = (v) => m.t + ih - ((v - lo) / (hi - lo)) * ih;
  const n = pts.length;
  const x = (i) => m.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);

  let grid = '';
  for (let v = lo; v <= hi + 1e-6; v += step) {
    grid += `<line x1="${m.l}" x2="${m.l + iw}" y1="${y(v)}" y2="${y(v)}" stroke="#ece7dc" stroke-width="1"/>`;
    grid += `<text x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="#6b675c">${simK(v)}</text>`;
  }
  const xIdx = n <= 1 ? [0] : [...new Set([0, Math.round((n - 1) / 2), n - 1])];
  const xLabels = xIdx
    .map((i, k) => {
      const anchor = n <= 1 ? 'middle' : k === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
      return `<text x="${x(i)}" y="${H - 8}" text-anchor="${anchor}" font-size="11" fill="#6b675c">${simShortDate(pts[i].day)}</text>`;
    })
    .join('');
  const path = (key) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ');
  const last = pts[n - 1];
  const lines =
    n > 1
      ? `<path d="${path('you')} L${x(n - 1)},${m.t + ih} L${x(0)},${m.t + ih} Z" fill="${SIM_COLOR_YOU}" fill-opacity="0.07"/>
         <path d="${path('spy')}" fill="none" stroke="${SIM_COLOR_SPY}" stroke-width="2" stroke-dasharray="6 4" stroke-linejoin="round"/>
         <path d="${path('you')}" fill="none" stroke="${SIM_COLOR_YOU}" stroke-width="2.25" stroke-linejoin="round"/>`
      : '';
  let endLabels = '';
  if (wide) {
    let yYou = y(last.you) + 4;
    let ySpy = y(last.spy) + 4;
    if (Math.abs(yYou - ySpy) < 30) {
      const mid = (yYou + ySpy) / 2;
      const youAbove = last.you >= last.spy;
      yYou = mid + (youAbove ? -15 : 15);
      ySpy = mid + (youAbove ? 15 : -15);
    }
    const lx = x(n - 1) + 12;
    endLabels = `
      <text x="${lx}" y="${yYou - 6}" font-size="11" fill="${SIM_COLOR_YOU}" font-weight="700">You</text>
      <text x="${lx}" y="${yYou + 8}" font-size="12" fill="#1c2530">${simK(simRound2(last.you))}</text>
      <text x="${lx}" y="${ySpy - 6}" font-size="11" fill="#8a6008" font-weight="700">S&amp;P 500</text>
      <text x="${lx}" y="${ySpy + 8}" font-size="12" fill="#1c2530">${simK(simRound2(last.spy))}</text>`;
  }

  host.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Portfolio value ${simMoney(last.you)} versus ${simMoney(last.spy)} for the same $100,000 in the S&amp;P 500 since ${simShortDate(simState.portfolio.createdDay)}">
      ${grid}
      <line x1="${m.l}" x2="${m.l + iw}" y1="${y(SIM_START_CASH)}" y2="${y(SIM_START_CASH)}" stroke="#b9b2a2" stroke-width="1" stroke-dasharray="2 3"/>
      <text x="${m.l + 6}" y="${y(SIM_START_CASH) - 5}" font-size="10.5" fill="#8f887a">Start $100k</text>
      ${lines}
      <circle cx="${x(n - 1)}" cy="${y(last.spy)}" r="4.5" fill="${SIM_COLOR_SPY}" stroke="#fff" stroke-width="2"/>
      <circle cx="${x(n - 1)}" cy="${y(last.you)}" r="5" fill="${SIM_COLOR_YOU}" stroke="#fff" stroke-width="2"/>
      ${xLabels}${endLabels}
      <line id="sim-crosshair" x1="0" x2="0" y1="${m.t}" y2="${m.t + ih}" stroke="#1c2530" stroke-opacity="0.35" stroke-width="1" visibility="hidden"/>
      <rect id="sim-hover-zone" x="${m.l}" y="${m.t}" width="${iw}" height="${ih}" fill="transparent"/>
    </svg>`;

  note.hidden = n > 1;
  if (n <= 1) note.textContent = `Your chart starts ${simShortDate(simState.portfolio.createdDay)}. A new point is added after each market close.`;

  const svg = host.querySelector('svg');
  const cross = host.querySelector('#sim-crosshair');
  const tip = document.getElementById('sim-tooltip');
  const move = (evt) => {
    const rect = svg.getBoundingClientRect();
    const scale = W / rect.width;
    const px = (evt.clientX - rect.left) * scale;
    const i = n <= 1 ? 0 : Math.max(0, Math.min(n - 1, Math.round(((px - m.l) / iw) * (n - 1))));
    const p = pts[i];
    cross.setAttribute('x1', x(i));
    cross.setAttribute('x2', x(i));
    cross.setAttribute('visibility', 'visible');
    tip.innerHTML = `<div class="sim-tooltip-date">${simLongDate(p.day)}${p.day === clock.day ? ' (now)' : ''}</div>
      <div class="sim-tooltip-row"><span>Your portfolio</span><span>${simMoney(p.you)}</span></div>
      <div class="sim-tooltip-row"><span>S&amp;P 500</span><span>${simMoney(p.spy)}</span></div>
      <div class="sim-tooltip-row sim-tooltip-diff"><span>Difference</span><span>${simSignedMoney(p.you - p.spy)}</span></div>`;
    tip.hidden = false;
    const wrapRect = document.getElementById('sim-chart-wrap').getBoundingClientRect();
    let left = x(i) / scale + 14;
    if (left + tip.offsetWidth > wrapRect.width) left = x(i) / scale - tip.offsetWidth - 14;
    tip.style.left = `${Math.max(0, left)}px`;
    tip.style.top = `${Math.max(0, evt.clientY - wrapRect.top - 40)}px`;
  };
  const zone = host.querySelector('#sim-hover-zone');
  zone.addEventListener('pointermove', move);
  zone.addEventListener('pointerdown', move);
  zone.addEventListener('pointerleave', () => {
    cross.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  });

  document.getElementById('sim-history-table').innerHTML = `<table class="sim-table">
    <thead><tr><th>Date</th><th>Your portfolio</th><th>S&amp;P 500</th></tr></thead>
    <tbody>${pts
      .slice()
      .reverse()
      .map((p) => `<tr><td>${simLongDate(p.day)}${p.day === clock.day ? ' (now)' : ''}</td><td>${simMoney(p.you)}</td><td>${simMoney(p.spy)}</td></tr>`)
      .join('')}</tbody></table>`;
}

function simEstimateHtml(price) {
  const amt = parseFloat(simState.amount);
  if (!(amt > 0)) return '<span class="muted">Enter an amount to see an estimate.</span>';
  if (simState.mode === 'dollars') return `≈ <strong>${simFloor4(amt / price).toFixed(4)}</strong> shares for ${simMoney(amt)}`;
  return `≈ <strong>${simMoney(simRound2(simFloor4(amt) * price))}</strong> for ${simFloor4(amt).toFixed(4)} shares`;
}

// Change vs. the prior session's close. On a weekend/holiday the "current"
// price is the last session's close, so this shows that session's move.
function simQuoteParts(company, clock) {
  const price = simLivePrice(company, clock);
  const change = clock.day > 0 ? price / simClosePrice(company, clock.day - 1) - 1 : 0;
  return { price, change, label: clock.tradingToday ? 'today' : 'last session' };
}

function simRenderTrade(clock) {
  const panel = document.getElementById('sim-trade');
  if (!panel) return;
  const company = simState.selected ? simCompany(simState.selected) : null;
  if (!company) {
    panel.innerHTML = `<p class="muted sim-small">Search for any S&amp;P 500 company to see a quote and place a trade.</p>
      <div class="sim-quick-picks"><span class="muted sim-small">Try:</span>${['AAPL', 'MSFT', 'FSLR', 'COST', 'JNJ']
        .filter((t) => simCompany(t))
        .map((t) => `<button type="button" class="sim-chip" data-sim-pick="${t}">${t}</button>`)
        .join('')}</div>`;
    panel.querySelectorAll('[data-sim-pick]').forEach((b) => b.addEventListener('click', () => simSelectCompany(b.dataset.simPick)));
    return;
  }

  const { price, change, label: changeLabel } = simQuoteParts(company, clock);
  const owned = (simState.portfolio.holdings[company.ticker] || {}).shares || 0;
  const scoreChip = state.hasPersonalizedAnswers
    ? (() => {
        const score = simValuesScore(company);
        const band = simBand(score);
        return `<span class="sim-score sim-score-${band.cls}">Values match ${score} · ${band.label}</span>`;
      })()
    : '';
  const available =
    simState.side === 'buy'
      ? `Cash available: <strong>${simMoney(simState.portfolio.cash)}</strong>`
      : owned > 0
        ? `You own <strong>${owned.toFixed(4)}</strong> shares <button type="button" class="sim-link" id="sim-sell-all">Sell all</button>`
        : `You don't own any ${escapeHtml(company.ticker)}.`;
  const amt = parseFloat(simState.amount);

  panel.innerHTML = `
    <div class="sim-quote">
      <div class="sim-quote-top">
        <div>
          <div class="sim-quote-name">${escapeHtml(company.name)} (${escapeHtml(company.ticker)})</div>
          <div class="muted sim-small">${escapeHtml(company.sector)}</div>
          ${scoreChip}
        </div>
        <div class="sim-quote-price">
          <div class="sim-quote-price-value" id="sim-quote-price">${simMoney(price)}</div>
          <div class="sim-small ${simTrend(change)}" id="sim-quote-change">${simArrow(change)}${simSignedPct(change)} ${changeLabel}</div>
          <div class="sim-small muted" id="sim-quote-asof">Practice quote · ${clock.open ? `${simClockTime(clock.minutes)} ET` : 'last close'}</div>
        </div>
      </div>
      <div class="sim-order-row">
        <span class="sim-seg sim-seg-side" role="group" aria-label="Order side">
          <button type="button" data-sim-side="buy" aria-pressed="${simState.side === 'buy'}">Buy</button>
          <button type="button" data-sim-side="sell" aria-pressed="${simState.side === 'sell'}">Sell</button>
        </span>
        <span class="sim-seg" role="group" aria-label="Amount type">
          <button type="button" data-sim-mode="dollars" aria-pressed="${simState.mode === 'dollars'}">Dollars</button>
          <button type="button" data-sim-mode="shares" aria-pressed="${simState.mode === 'shares'}">Shares</button>
        </span>
      </div>
      <div class="sim-amount ${simState.mode === 'shares' ? 'sim-amount-shares' : ''}">
        ${simState.mode === 'dollars' ? '<span class="sim-amount-prefix">$</span>' : ''}
        <input id="sim-amount-input" inputmode="decimal" autocomplete="off"
          aria-label="${simState.mode === 'dollars' ? 'Dollar amount' : 'Number of shares'}"
          placeholder="${simState.mode === 'dollars' ? '1,000.00' : '2.5000'}" value="${escapeHtml(simState.amount)}" />
      </div>
      <div class="sim-estimate" id="sim-estimate">${simEstimateHtml(price)}</div>
      <div class="sim-estimate">${available}</div>
      ${simState.error ? `<p class="sim-error" role="alert">${escapeHtml(simState.error)}</p>` : ''}
      ${
        simState.review
          ? simReviewHtml(company)
          : `<div><button type="button" class="btn btn-primary" id="sim-review-btn" ${amt > 0 ? '' : 'disabled'}>Review order</button></div>`
      }
    </div>`;

  panel.querySelectorAll('[data-sim-side]').forEach((b) =>
    b.addEventListener('click', () => {
      Object.assign(simState, { side: b.dataset.simSide, review: null, error: '' });
      simRenderTrade(simClock());
    })
  );
  panel.querySelectorAll('[data-sim-mode]').forEach((b) =>
    b.addEventListener('click', () => {
      Object.assign(simState, { mode: b.dataset.simMode, amount: '', review: null, error: '' });
      simRenderTrade(simClock());
    })
  );
  const input = document.getElementById('sim-amount-input');
  input.addEventListener('input', () => {
    simState.amount = input.value.replace(/[^0-9.]/g, '');
    const hadExtras = simState.review || simState.error;
    simState.review = null;
    simState.error = '';
    if (hadExtras) {
      const pos = input.selectionStart;
      simRenderTrade(simClock());
      const again = document.getElementById('sim-amount-input');
      again.focus();
      try {
        again.setSelectionRange(pos, pos);
      } catch (err) {
        /* not a text input type that supports selection */
      }
      return;
    }
    document.getElementById('sim-estimate').innerHTML = simEstimateHtml(simLivePrice(company, simClock()));
    const reviewBtn = document.getElementById('sim-review-btn');
    if (reviewBtn) reviewBtn.disabled = !(parseFloat(simState.amount) > 0);
  });
  input.addEventListener('keydown', (evt) => {
    if (evt.key === 'Enter' && !simState.review) document.getElementById('sim-review-btn')?.click();
  });
  document.getElementById('sim-sell-all')?.addEventListener('click', () => {
    Object.assign(simState, { mode: 'shares', amount: String(owned), review: null, error: '' });
    simRenderTrade(simClock());
  });
  document.getElementById('sim-review-btn')?.addEventListener('click', () => {
    const now = simClock();
    if (!now.open) {
      simState.error = 'The market is closed. Trades can be placed 9:30 AM–4:00 PM Eastern on trading days.';
      simRenderTrade(now);
      return;
    }
    const livePrice = simLivePrice(company, now);
    const sized = simSizeOrder({ side: simState.side, mode: simState.mode, amount: simState.amount, price: livePrice, cash: simState.portfolio.cash, ownedShares: owned, ticker: company.ticker });
    if (!sized.ok) {
      simState.error = sized.error;
      simRenderTrade(now);
      return;
    }
    simState.review = { price: livePrice, shares: sized.shares, total: sized.total };
    simState.error = '';
    simRenderTrade(now);
  });
  document.getElementById('sim-confirm-btn')?.addEventListener('click', () => simConfirmTrade(company));
  document.getElementById('sim-cancel-review')?.addEventListener('click', () => {
    simState.review = null;
    simRenderTrade(simClock());
  });
}

function simReviewHtml(company) {
  const verb = simState.side === 'buy' ? 'Buy' : 'Sell';
  const r = simState.review;
  return `<div class="sim-review">
      <p><strong>${verb} ${r.shares.toFixed(4)} shares of ${escapeHtml(company.ticker)}</strong> at about ${simMoney(r.price)}</p>
      <p>Estimated ${simState.side === 'buy' ? 'cost' : 'proceeds'}: <strong>${simMoney(r.total)}</strong></p>
      <p class="muted sim-small">Market order. The final price is set when the trade goes through, so it may differ slightly from this quote. No commission.</p>
      <div class="sim-btn-row">
        <button type="button" class="btn ${simState.side === 'buy' ? 'sim-btn-buy' : 'btn-danger'}" id="sim-confirm-btn">Confirm ${verb.toLowerCase()}</button>
        <button type="button" class="btn btn-secondary" id="sim-cancel-review">Cancel</button>
      </div>
    </div>`;
}

function simConfirmTrade(company) {
  const clock = simClock();
  const fail = (message) => {
    Object.assign(simState, { error: message, review: null });
    simRenderTrade(clock);
  };
  if (!clock.open) return fail('The market is closed. Trades can be placed 9:30 AM–4:00 PM Eastern on trading days.');
  const fillPrice = simLivePrice(company, clock);
  const owned = (simState.portfolio.holdings[company.ticker] || {}).shares || 0;
  const sized = simSizeOrder({ side: simState.side, mode: simState.mode, amount: simState.amount, price: fillPrice, cash: simState.portfolio.cash, ownedShares: owned, ticker: company.ticker });
  if (!sized.ok) return fail(sized.error);

  const side = simState.side;
  simApplyTrade(simState.portfolio, { day: clock.day, at: new Date().toISOString(), ticker: company.ticker, side, shares: sized.shares, price: fillPrice });
  simSavePortfolio();
  logAnalyticsEvent('sim_trade', { side, mode: 'practice' }); // js/firebase-config.js
  Object.assign(simState, { amount: '', review: null, error: '' });
  simRenderAllSections();
  simToast(`${side === 'buy' ? 'Bought' : 'Sold'} ${sized.shares.toFixed(4)} shares of ${company.ticker} at ${simMoney(fillPrice)}`);
}

// Minute-tick update of just the quote numbers (see simRefreshLive).
function simUpdateQuote(clock) {
  const company = simState.selected ? simCompany(simState.selected) : null;
  if (!company || !document.getElementById('sim-quote-price')) return;
  const { price, change, label } = simQuoteParts(company, clock);
  document.getElementById('sim-quote-price').textContent = simMoney(price);
  const changeEl = document.getElementById('sim-quote-change');
  changeEl.className = `sim-small ${simTrend(change)}`;
  changeEl.textContent = `${simArrow(change)}${simSignedPct(change)} ${label}`;
  document.getElementById('sim-quote-asof').textContent = `Practice quote · ${clock.open ? `${simClockTime(clock.minutes)} ET` : 'last close'}`;
  if (!simState.review) document.getElementById('sim-estimate').innerHTML = simEstimateHtml(price);
}

function simRenderValues(clockArg) {
  const panel = document.getElementById('sim-values');
  if (!panel) return;
  const clock = clockArg || simClock();
  if (!state.hasPersonalizedAnswers) {
    if (simState.autoLoadState === 'loading' || simState.autoLoadState === 'idle') {
      panel.innerHTML = `<p class="muted">${spinnerHtml('Loading your most recent saved survey…')}</p>`;
      return;
    }
    panel.innerHTML = `<div class="sim-prompt">
        <p>Take the survey to see how well this portfolio matches your values.</p>
        <button type="button" class="btn btn-primary" id="sim-take-survey">Take the Survey</button>
      </div>`;
    document.getElementById('sim-take-survey').addEventListener('click', () => {
      state.view = 'survey';
      render();
    });
    return;
  }
  const rows = simHoldingRows(clock).map((r) => ({ ...r, score: simValuesScore(r.company) }));
  const invested = rows.reduce((sum, r) => sum + r.value, 0);
  if (!rows.length || invested <= 0) {
    panel.innerHTML = '<p class="muted">Buy a stock to see how well your holdings match your values.</p>';
    return;
  }
  const score = rows.reduce((sum, r) => sum + r.value * r.score, 0) / invested;
  const band = simBand(score);
  const LO = 40;
  const HI = 70;
  const pos = (v) => ((Math.min(HI, Math.max(LO, v)) - LO) / (HI - LO)) * 100;
  rows.sort((a, b) => b.score - a.score || b.value - a.value);
  panel.innerHTML = `
    <div class="sim-va-score"><span class="sim-va-big">${score.toFixed(0)}</span><span class="muted">/ 100</span></div>
    <span class="sim-score sim-score-${band.cls}">${band.label}</span>
    <div class="sim-meter" aria-hidden="true">
      <div class="sim-meter-track"><div class="sim-meter-fill" style="width:${pos(score)}%"></div><div class="sim-meter-floor" style="left:${pos(MINIMUM_VALUES_MATCH)}%"></div></div>
      <div class="sim-meter-labels"><span style="left:0">${LO}</span><span style="left:${pos(MINIMUM_VALUES_MATCH)}%;transform:translateX(-50%)">Your floor ${MINIMUM_VALUES_MATCH}</span><span style="right:0">${HI}</span></div>
    </div>
    <p class="muted sim-small">Dollar-weighted across ${rows.length} holding${rows.length === 1 ? '' : 's'}. Cash doesn't count. Based on your most recent survey answers.</p>
    <ul class="sim-va-list">${rows
      .map((r) => {
        const b = simBand(r.score);
        return `<li><span><strong>${escapeHtml(r.ticker)}</strong> <span class="muted">${((r.value / invested) * 100).toFixed(0)}% of holdings</span></span><span class="sim-score sim-score-${b.cls}">${r.score}</span></li>`;
      })
      .join('')}</ul>`;
}

function simRenderHoldings(clock) {
  const host = document.getElementById('sim-holdings');
  if (!host) return;
  const rows = simHoldingRows(clock);
  if (!rows.length) {
    host.innerHTML = '<p class="muted">No holdings yet. Search for a company above to make your first trade.</p>';
    return;
  }
  const showScores = state.hasPersonalizedAnswers;
  host.innerHTML = `<div class="sim-table-scroll"><table class="sim-table">
    <thead><tr><th>Company</th><th>Shares</th><th>Avg cost</th><th>Price</th><th>Value</th><th>Gain/loss</th>${showScores ? '<th>Values</th>' : ''}</tr></thead>
    <tbody>${rows
      .map((r) => {
        const score = showScores ? simValuesScore(r.company) : null;
        return `<tr class="sim-row" data-sim-row="${escapeHtml(r.ticker)}" tabindex="0">
          <td><span class="sim-row-ticker">${escapeHtml(r.ticker)}</span><span class="sim-row-name">${escapeHtml(r.company.name)}</span></td>
          <td>${r.h.shares.toFixed(4)}</td><td>${simMoney(r.h.avgCost)}</td><td>${simMoney(r.price)}</td><td><strong>${simMoney(r.value)}</strong></td>
          <td class="${simTrend(r.gain)}">${simArrow(r.gain)}${simSignedMoney(r.gain)}<br><span class="sim-small">${simSignedPct(r.gainPct)}</span></td>
          ${showScores ? `<td><span class="sim-score sim-score-${simBand(score).cls}">${score}</span></td>` : ''}
        </tr>`;
      })
      .join('')}
      <tr class="sim-cash-row"><td>Cash</td><td></td><td></td><td></td><td>${simMoney(simState.portfolio.cash)}</td><td></td>${showScores ? '<td></td>' : ''}</tr>
    </tbody></table></div>`;
  host.querySelectorAll('[data-sim-row]').forEach((tr) => {
    const go = () => {
      simSelectCompany(tr.dataset.simRow);
      document.getElementById('sim-trade-title').scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    tr.addEventListener('click', go);
    tr.addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter' || evt.key === ' ') {
        evt.preventDefault();
        go();
      }
    });
  });
}

function simRenderTrades() {
  const host = document.getElementById('sim-trades');
  if (!host) return;
  const recent = simState.portfolio.txns.slice().reverse().slice(0, 10);
  host.innerHTML = recent.length
    ? recent
        .map(
          (tx) => `<li><span class="muted">${simShortDate(tx.day)}</span><span class="sim-side sim-side-${tx.side}">${tx.side}</span>
            <strong>${escapeHtml(tx.ticker)}</strong><span class="muted sim-trade-detail">${tx.shares.toFixed(4)} @ ${simMoney(tx.price)}</span>
            <span class="sim-trade-total">${simMoney(tx.total)}</span></li>`
        )
        .join('')
    : '<li class="sim-trades-empty muted">No trades yet.</li>';
}

function simRenderReset() {
  const host = document.getElementById('sim-reset');
  if (!host) return;
  if (simState.confirmReset) {
    const count = Object.keys(simState.portfolio.holdings).length;
    host.innerHTML = `<div class="sim-confirm">
        <p><strong>Reset your portfolio?</strong> This deletes ${count ? `all ${count} holding${count === 1 ? '' : 's'}` : 'your holdings'} and your trade history and puts you back at ${simMoney(SIM_START_CASH)} in cash. This can't be undone.</p>
        <div class="sim-btn-row">
          <button type="button" class="btn btn-danger" id="sim-reset-yes">Yes, reset to $100,000</button>
          <button type="button" class="btn btn-secondary" id="sim-reset-no">Keep my portfolio</button>
        </div>
      </div>`;
    document.getElementById('sim-reset-yes').addEventListener('click', () => {
      const now = simClock();
      simState.portfolio = simNewPortfolio(now.day, simLiveSpyLevel(now));
      simSavePortfolio();
      logAnalyticsEvent('sim_reset', { mode: 'practice' }); // js/firebase-config.js
      Object.assign(simState, { confirmReset: false, selected: null, review: null, amount: '', error: '' });
      simRenderAllSections();
      simToast('Portfolio reset to $100,000');
    });
    document.getElementById('sim-reset-no').addEventListener('click', () => {
      simState.confirmReset = false;
      simRenderReset();
    });
    return;
  }
  host.innerHTML = `<p class="muted">Want a clean slate? Resetting clears every holding and trade and restores $100,000 in cash.</p>
    <button type="button" class="btn sim-btn-reset" id="sim-reset-btn">Reset portfolio</button>`;
  document.getElementById('sim-reset-btn').addEventListener('click', () => {
    simState.confirmReset = true;
    simRenderReset();
  });
}

// ---------- search ----------

function simSelectCompany(ticker) {
  const owned = (simState.portfolio.holdings[ticker] || {}).shares || 0;
  Object.assign(simState, { selected: ticker, review: null, error: '', amount: '', searchQuery: '', side: owned > 0 && simState.side === 'sell' ? 'sell' : 'buy' });
  const input = document.getElementById('sim-search-input');
  if (input) input.value = '';
  const list = document.getElementById('sim-search-results');
  if (list) list.hidden = true;
  simRenderTrade(simClock());
}

function simRenderSearchResults() {
  const list = document.getElementById('sim-search-results');
  const query = simState.searchQuery.trim().toLowerCase();
  if (!query || !state.dataset) {
    list.hidden = true;
    return;
  }
  const rank = (c) => {
    const t = c.ticker.toLowerCase();
    return t === query ? 0 : t.startsWith(query) ? 1 : c.name.toLowerCase().startsWith(query) ? 2 : 3;
  };
  const matches = state.dataset.companies
    .filter((c) => c.ticker.toLowerCase().includes(query) || c.name.toLowerCase().includes(query))
    .sort((a, b) => rank(a) - rank(b) || a.ticker.localeCompare(b.ticker))
    .slice(0, 8);
  list.innerHTML = matches.length
    ? matches
        .map(
          (c) => `<li><button type="button" class="ticker-search-result" data-sim-ticker="${escapeHtml(c.ticker)}">
            <span class="ticker-search-result-ticker">${escapeHtml(c.ticker)}</span>
            <span class="ticker-search-result-name">${escapeHtml(c.name)}</span>
            <span class="ticker-search-result-sector">${escapeHtml(c.sector)}</span></button></li>`
        )
        .join('')
    : `<li class="ticker-search-empty">No S&amp;P 500 company matches “${escapeHtml(simState.searchQuery)}”.</li>`;
  list.hidden = false;
  list.querySelectorAll('[data-sim-ticker]').forEach((b) => b.addEventListener('click', () => simSelectCompany(b.dataset.simTicker)));
}

function simWireSearch() {
  const input = document.getElementById('sim-search-input');
  input.addEventListener('input', () => {
    simState.searchQuery = input.value;
    simRenderSearchResults();
  });
  input.addEventListener('keydown', (evt) => {
    if (evt.key === 'Enter') {
      const first = document.querySelector('#sim-search-results [data-sim-ticker]');
      if (first) {
        evt.preventDefault();
        simSelectCompany(first.dataset.simTicker);
      }
    }
    if (evt.key === 'Escape') document.getElementById('sim-search-results').hidden = true;
  });
}

// ---------- misc ----------

let simToastTimer = null;
function simToast(message) {
  let el = document.getElementById('sim-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'sim-toast';
    el.className = 'sim-toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  el.textContent = message;
  requestAnimationFrame(() => el.classList.add('visible'));
  clearTimeout(simToastTimer);
  simToastTimer = setTimeout(() => el.classList.remove('visible'), 3200);
}

if (typeof document !== 'undefined') {
  // Search dropdown closes on any outside click, and the chart redraws to
  // fit the new width after a resize -- both no-ops off this screen.
  document.addEventListener('click', (evt) => {
    if (state.view !== 'simulator' || evt.target.closest('.ticker-search')) return;
    const list = document.getElementById('sim-search-results');
    if (list) list.hidden = true;
  });
  let simResizeTimer = null;
  window.addEventListener('resize', () => {
    if (state.view !== 'simulator') return;
    clearTimeout(simResizeTimer);
    simResizeTimer = setTimeout(() => simRenderChart(simClock()), 150);
  });
}
