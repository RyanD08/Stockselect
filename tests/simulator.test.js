const { describe, test, assert } = require('./lib/runner');
const { loadContext, loadCompanies } = require('./lib/harness');

const companies = loadCompanies();
const ctx = loadContext(['js/simulator.js']);
const byTicker = (t) => companies.find((c) => c.ticker === t);

// Builds a Date for a given Eastern (EDT, UTC-4) wall-clock time in Sep 2026.
const edt = (day, hour, minute) => new Date(Date.UTC(2026, 8, day, hour + 4, minute));

describe('Simulator: order sizing and trading rules', () => {
  test('a dollar buy floors to 4 decimal shares and never spends more than asked', () => {
    const r = ctx.simSizeOrder({ side: 'buy', mode: 'dollars', amount: '1000', price: 311.64, cash: 100000, ownedShares: 0, ticker: 'FSLR' });
    assert(r.ok, r.error);
    assert.equal(r.shares, 3.2088);
    assert(r.total <= 1000, `spent ${r.total}`);
  });

  test('a buy costing more than available cash is rejected', () => {
    const r = ctx.simSizeOrder({ side: 'buy', mode: 'shares', amount: '10', price: 500, cash: 4000, ownedShares: 0, ticker: 'X' });
    assert(!r.ok && /cash/.test(r.error), JSON.stringify(r));
  });

  test('selling more than you own is rejected (no shorting)', () => {
    const r = ctx.simSizeOrder({ side: 'sell', mode: 'shares', amount: '5', price: 100, cash: 0, ownedShares: 2, ticker: 'X' });
    assert(!r.ok && /Short selling/.test(r.error), JSON.stringify(r));
  });

  test('zero, negative, and sub-0.0001-share orders are rejected', () => {
    for (const amount of ['0', '-5', 'abc']) {
      assert(!ctx.simSizeOrder({ side: 'buy', mode: 'dollars', amount, price: 100, cash: 100000, ownedShares: 0, ticker: 'X' }).ok, amount);
    }
    assert(!ctx.simSizeOrder({ side: 'buy', mode: 'dollars', amount: '0.001', price: 500, cash: 100000, ownedShares: 0, ticker: 'X' }).ok);
  });

  test('buy then partial sell keeps cash, shares and average cost consistent', () => {
    const p = ctx.simNewPortfolio(0);
    ctx.simApplyTrade(p, { day: 0, ticker: 'AAA', side: 'buy', shares: 10, price: 100 });
    ctx.simApplyTrade(p, { day: 0, ticker: 'AAA', side: 'buy', shares: 10, price: 200 });
    assert.equal(p.holdings.AAA.shares, 20);
    assert.equal(p.holdings.AAA.avgCost, 150);
    assert.equal(p.cash, 97000);
    ctx.simApplyTrade(p, { day: 1, ticker: 'AAA', side: 'sell', shares: 5, price: 180 });
    assert.equal(p.holdings.AAA.shares, 15);
    assert.equal(p.holdings.AAA.avgCost, 150, 'selling must not change average cost');
    assert.equal(p.cash, 97900);
    ctx.simApplyTrade(p, { day: 1, ticker: 'AAA', side: 'sell', shares: 15, price: 180 });
    assert(!p.holdings.AAA, 'a fully sold position should disappear');
    assert.equal(p.txns.length, 4);
  });
});

describe('Simulator: market hours and trading calendar', () => {
  test('open during regular hours on a weekday', () => {
    assert(ctx.simClock(edt(24, 14, 41)).open);
    assert(ctx.simClock(edt(24, 9, 30)).open);
  });

  test('closed before 9:30, at/after 4:00, and on weekends', () => {
    assert(!ctx.simClock(edt(24, 9, 29)).open);
    assert(!ctx.simClock(edt(24, 16, 0)).open);
    assert(!ctx.simClock(edt(26, 12, 0)).open, 'Saturday');
  });

  test('closed on NYSE holidays (Labor Day 2026)', () => {
    assert(!ctx.simClock(edt(7, 12, 0)).open);
  });

  test('Labor Day is skipped: Sep 8 is the trading day right after Sep 4', () => {
    assert.equal(ctx.simDayIndexFor('2026-09-08'), ctx.simDayIndexFor('2026-09-04') + 1);
    assert.equal(ctx.simDayIndexFor('2026-09-07'), ctx.simDayIndexFor('2026-09-04'));
  });
});

describe('Simulator: practice prices', () => {
  test('prices are deterministic across independent loads', () => {
    const other = loadContext(['js/simulator.js']);
    const aapl = byTicker('AAPL');
    assert.equal(ctx.simClosePrice(aapl, 30), other.simClosePrice(aapl, 30));
  });

  test('before the open the live price is the prior close; after the close it is today\'s close', () => {
    const msft = byTicker('MSFT');
    const pre = ctx.simClock(edt(24, 8, 0));
    const post = ctx.simClock(edt(24, 17, 0));
    assert.equal(ctx.simLivePrice(msft, pre), ctx.simRound2(ctx.simClosePrice(msft, pre.day - 1)));
    assert.equal(ctx.simLivePrice(msft, post), ctx.simRound2(ctx.simClosePrice(msft, post.day)));
  });

  test('every company in the dataset gets a positive practice price', () => {
    for (const c of companies) {
      const p = ctx.simClosePrice(c, 60);
      assert(p > 0 && Number.isFinite(p), `${c.ticker}: ${p}`);
    }
  });
});
