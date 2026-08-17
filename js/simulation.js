/**
 * Historical "what if" simulation: purely a downstream display calculation
 * over an already-finalized `holdings` list from buildPortfolio(). Never
 * feeds back into scoring, ranking, or selection — see js/scoring.js for
 * that logic, which this file does not import or call.
 */

const SIMULATION_TOTAL_INVESTMENT = 15000;

// company_value_today = per_company_investment * (1 + trailing_12mo_pct_change)
// A company with no usable trailing-12mo return (financial_metrics.one_year_return_pct
// is null/undefined — the dataset's existing convention for "not meaningful", which
// covers recent IPOs, mergers, spin-offs, and ticker changes) is excluded from the
// dollar total rather than estimated, per the no-fabrication requirement.
function computeHistoricalSimulation(holdings) {
  const totalCount = holdings.length;
  const perCompanyInvestment = totalCount > 0 ? SIMULATION_TOTAL_INVESTMENT / totalCount : 0;

  const rows = holdings.map((entry) => {
    const company = entry.company;
    const pctChange = company.financial_metrics.one_year_return_pct;
    const hasValidReturn = typeof pctChange === 'number' && Number.isFinite(pctChange);

    if (!hasValidReturn) {
      return {
        ticker: company.ticker,
        name: company.name,
        included: false,
        note:
          `Not included — ${company.name} (${company.ticker}) is missing a reliable trailing ` +
          `12-month price return in our data (for example, due to a recent IPO, merger, spin-off, ` +
          `or ticker change), which makes a 1-year comparison unreliable.`,
      };
    }

    const valueToday = perCompanyInvestment * (1 + pctChange / 100);
    return {
      ticker: company.ticker,
      name: company.name,
      included: true,
      amountInvested: perCompanyInvestment,
      valueToday,
      pctChange,
    };
  });

  const includedRows = rows.filter((r) => r.included);
  const includedCount = includedRows.length;
  // The dollar denominator for the total is what was actually allocated to
  // companies with valid data — not the full $15,000 — so an excluded
  // company's untracked share doesn't read as a phantom loss.
  const totalInvestedIncluded = perCompanyInvestment * includedCount;
  const totalValueToday = includedRows.reduce((sum, r) => sum + r.valueToday, 0);
  const totalDollarChange = totalValueToday - totalInvestedIncluded;
  const totalPctChange = totalInvestedIncluded > 0 ? totalDollarChange / totalInvestedIncluded : 0;

  return {
    totalCount,
    includedCount,
    perCompanyInvestment,
    totalValueToday,
    totalDollarChange,
    totalPctChange,
    rows,
  };
}
