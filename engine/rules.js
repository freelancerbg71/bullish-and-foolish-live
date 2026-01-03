/**
 * Open Fundamentals Engine
 * Copyright (C) 2024-2025 Bullish & Foolish Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 *
 * @fileoverview Scoring rules for the fundamentals engine.
 * Each rule evaluates a specific aspect of company financial health.
 */

import {
  toNumber,
  percentToNumber,
  bandScore,
  missing,
  fmtPct,
  fmtMoney,
  resolveSectorBucket,
  isFintech
} from "./utils.js";

import { SECTOR_BUCKETS } from "./constants.js";


// ============================================================================
// METRIC HELPERS
// These functions extract normalized values from the stock object for use
// in rule evaluations. They handle missing data gracefully (return null).
// ============================================================================

/**
 * Extracts Free Cash Flow margin as a percentage.
 * @param {Object} stock - The normalized stock object
 * @returns {number|null} FCF margin (e.g., 15 for 15%), or null if unavailable
 */
function fcfMargin(stock) {
  return percentToNumber(stock?.profitMargins?.fcfMargin);
}
function dilutionYoY(stock) {
  return percentToNumber(stock?.shareStats?.sharesChangeYoY);
}
function runwayYears(stock) {
  const val = stock?.financialPosition?.runwayYears;
  if (val === Infinity) return Infinity;
  // If undefined but cash/burn implies infinite, return Infinity or high val
  return percentToNumber(val);
}
function debtToEquity(stock) {
  // Use gross Debt/Equity (not net) for the core leverage score to avoid confusing displays
  // and to prevent "missing interest expense" from masquerading as ultra-low leverage.
  return percentToNumber(stock?.financialPosition?.debtToEquity);
}
function netDebtToFcf(stock) {
  const fp = stock?.financialPosition;
  if (fp?.debtIsZero === true) return 0;
  const totalDebt = Number(fp?.totalDebt);
  const finDebt = Number(fp?.financialDebt);
  if (Number.isFinite(totalDebt) && totalDebt === 0) return 0;
  if (Number.isFinite(finDebt) && finDebt === 0) return 0;
  return percentToNumber(fp?.netDebtToFcfYears ?? fp?.netDebtToFcf);
}
function capexToRevenue(stock) {
  return percentToNumber(stock?.cash?.capexToRevenue);
}
function roePct(stock) {
  return percentToNumber(stock?.returns?.roe);
}
function netIncomeTrend(stock) {
  return percentToNumber(stock?.profitGrowthTTM);
}
function grossMargin(stock) {
  return percentToNumber(stock?.profitMargins?.grossMargin);
}
function grossMarginTrend(stock) {
  const latest = percentToNumber(stock?.profitMargins?.grossMargin);
  const prev = percentToNumber(stock?.momentum?.grossMarginPrev);
  if (latest === null || prev === null) return null;
  return latest - prev;
}
function operatingMargin(stock) {
  return percentToNumber(stock?.profitMargins?.operatingMargin);
}
function operatingLeverage(stock) {
  return percentToNumber(stock?.profitMargins?.operatingLeverage);
}
function dividendPayout(stock) {
  return percentToNumber(stock?.dividends?.payoutToFcf);
}
function roic(stock) {
  return percentToNumber(stock?.returns?.roic);
}
function roaPct(stock) {
  const ni = percentToNumber(stock?.profitMargins?.netIncome);
  const assets = percentToNumber(stock?.financialPosition?.totalAssets);
  if (ni === null || assets === null || assets === 0) return null;
  return (ni / assets) * 100;
}



function assetTurnover(stock) {
  const revenue = percentToNumber(stock?.revenueTtm ?? stock?.revenueLatest);
  const assets = percentToNumber(stock?.financialPosition?.totalAssets);
  if (revenue === null || assets === null || assets === 0) return null;
  return revenue / assets;
}

function revenueGrowth(stock) {
  return percentToNumber(
    stock?.snapshot?.revenueYoYPct ??
    stock?.growth?.revenueGrowthYoY ??
    stock?.growth?.revenueGrowthTTM
  );
}

// === NEW HELPER FUNCTIONS FOR GROWTH COMPANIES & FINTECHS ===

function assetGrowthYoY(stock) {
  // Get current and year-ago total assets
  const balance = Array.isArray(stock?.balance) ? stock.balance : [];
  const sorted = [...balance].sort((a, b) => new Date(b.date) - new Date(a.date));
  if (sorted.length < 2) return null;

  const latest = percentToNumber(sorted[0]?.totalAssets);
  // Try to find year-ago (4 quarters back for quarterly, 1 year back for annual)
  const yearAgo = sorted.length >= 5 ? percentToNumber(sorted[4]?.totalAssets) : percentToNumber(sorted[1]?.totalAssets);

  if (latest === null || yearAgo === null || yearAgo === 0) return null;
  return ((latest - yearAgo) / Math.abs(yearAgo)) * 100;
}

function revenuePerAssetTrend(stock) {
  // Calculate Revenue/Assets ratio for last 2 quarters and compare
  const income = Array.isArray(stock?.income) ? stock.income : [];
  const balance = Array.isArray(stock?.balance) ? stock.balance : [];

  if (income.length < 2 || balance.length < 2) return null;

  const sortedIncome = [...income].sort((a, b) => new Date(b.date) - new Date(a.date));
  const sortedBalance = [...balance].sort((a, b) => new Date(b.date) - new Date(a.date));

  const latestRev = percentToNumber(sortedIncome[0]?.revenue);
  const latestAssets = percentToNumber(sortedBalance[0]?.totalAssets);
  const prevRev = percentToNumber(sortedIncome[1]?.revenue);
  const prevAssets = percentToNumber(sortedBalance[1]?.totalAssets);

  if (!Number.isFinite(latestRev) || !Number.isFinite(latestAssets) || latestAssets === 0) return null;
  if (!Number.isFinite(prevRev) || !Number.isFinite(prevAssets) || prevAssets === 0) return null;

  const latestRatio = latestRev / latestAssets;
  const prevRatio = prevRev / prevAssets;

  if (prevRatio === 0) return null;
  return ((latestRatio - prevRatio) / Math.abs(prevRatio)) * 100;
}

function debtMaturityMix(stock) {
  // Long-term debt / (Long-term debt + Current portion of debt)
  const ltDebt = percentToNumber(stock?.financialPosition?.longTermDebt);
  const stDebt = percentToNumber(stock?.financialPosition?.shortTermDebt);

  if (ltDebt === null && stDebt === null) return null;
  const total = (ltDebt || 0) + (stDebt || 0);
  if (total === 0) return null;

  return ((ltDebt || 0) / total) * 100;
}

function operatingLeverageInflection(stock) {
  // OpEx/Revenue ratio - check if declining over last 2 quarters
  const income = Array.isArray(stock?.income) ? stock.income : [];
  if (income.length < 3) return null;

  const sorted = [...income].sort((a, b) => new Date(b.date) - new Date(a.date));

  const calc = (period) => {
    const rev = percentToNumber(period?.revenue);
    const opEx = percentToNumber(period?.operatingExpenses);
    if (!Number.isFinite(rev) || !Number.isFinite(opEx) || rev === 0) return null;
    return (opEx / rev) * 100;
  };

  const q0 = calc(sorted[0]);
  const q1 = calc(sorted[1]);
  const q2 = calc(sorted[2]);

  if (q0 === null || q1 === null || q2 === null) return null;

  // Check if declining for 2 consecutive quarters
  const improving = q0 < q1 && q1 < q2;
  const ratioChange = q2 - q0; // Positive = worsening, Negative = improving

  return { improving, ratioChange, latest: q0 };
}

function cashBurnDecelerationRate(stock) {
  // FCF margin improvement QoQ
  const cashflow = Array.isArray(stock?.cashflow) ? stock.cashflow : [];
  const income = Array.isArray(stock?.income) ? stock.income : [];

  if (cashflow.length < 2 || income.length < 2) return null;

  const sortedCF = [...cashflow].sort((a, b) => new Date(b.date) - new Date(a.date));
  const sortedInc = [...income].sort((a, b) => new Date(b.date) - new Date(a.date));

  const calcFcfMargin = (idx) => {
    const fcf = percentToNumber(sortedCF[idx]?.freeCashFlow);
    const rev = percentToNumber(sortedInc[idx]?.revenue);
    if (!Number.isFinite(fcf) || !Number.isFinite(rev) || rev === 0) return null;
    return (fcf / rev) * 100;
  };

  const latest = calcFcfMargin(0);
  const prev = calcFcfMargin(1);

  if (latest === null || prev === null) return null;

  // If both negative, improvement means less negative (e.g., -30% to -20% = +33% improvement)
  if (latest < 0 && prev < 0) {
    return ((prev - latest) / Math.abs(prev)) * 100;
  }

  // Standard improvement calc
  return latest - prev;
}

function workingCapitalEfficiency(stock) {
  // (Current Assets - Current Liabilities) / Capex
  const balance = Array.isArray(stock?.balance) ? stock.balance : [];
  const cashflow = Array.isArray(stock?.cashflow) ? stock.cashflow : [];

  if (!balance.length || !cashflow.length) return null;

  const latest = balance.sort((a, b) => new Date(b.date) - new Date(a.date))[0];
  const latestCF = cashflow.sort((a, b) => new Date(b.date) - new Date(a.date))[0];

  const currentAssets = percentToNumber(latest?.currentAssets);
  const currentLiab = percentToNumber(latest?.currentLiabilities);
  const capex = Math.abs(percentToNumber(latestCF?.capitalExpenditure) || 0);

  if (!Number.isFinite(currentAssets) || !Number.isFinite(currentLiab) || capex === 0) return null;

  const workingCap = currentAssets - currentLiab;
  return workingCap / capex;
}

function revenueQualityScore(stock) {
  // DSO trend vs Revenue growth - if DSO flat/declining while revenue grows = quality
  const balance = Array.isArray(stock?.balance) ? stock.balance : [];
  const income = Array.isArray(stock?.income) ? stock.income : [];

  if (balance.length < 2 || income.length < 2) return null;

  const sortedBal = [...balance].sort((a, b) => new Date(b.date) - new Date(a.date));
  const sortedInc = [...income].sort((a, b) => new Date(b.date) - new Date(a.date));

  const dso = percentToNumber(stock?.financialPosition?.dsoDays);
  const dsoPrev = (() => {
    const ar = percentToNumber(sortedBal[1]?.accountsReceivable);
    const rev = percentToNumber(sortedInc[1]?.revenue);
    if (!Number.isFinite(ar) || !Number.isFinite(rev) || rev === 0) return null;
    return (ar / rev) * 365;
  })();

  const revGrowth = revenueGrowth(stock);

  if (dso === null || dsoPrev === null || revGrowth === null) return null;

  const dsoChange = dso - dsoPrev;

  // High quality: DSO declining or flat while revenue grows
  if (revGrowth > 10 && dsoChange <= 0) return { quality: 'high', dsoChange, revGrowth };
  if (revGrowth > 10 && dsoChange > 0 && dsoChange < 5) return { quality: 'medium', dsoChange, revGrowth };
  if (dsoChange > 5) return { quality: 'low', dsoChange, revGrowth };

  return { quality: 'neutral', dsoChange, revGrowth };
}

function depositGrowthYoY(stock) {
  // For banks/fintechs: Customer Deposits growth
  const balance = Array.isArray(stock?.balance) ? stock.balance : [];
  if (balance.length < 2) return null;

  const sorted = [...balance].sort((a, b) => new Date(b.date) - new Date(a.date));

  // Look for deposits (can be labeled different ways in EDGAR)
  const getDeposits = (period) => {
    return percentToNumber(
      period?.deposits ??
      period?.customerDeposits ??
      period?.totalDeposits ??
      period?.depositLiabilities
    );
  };

  const latest = getDeposits(sorted[0]);
  const yearAgo = sorted.length >= 5 ? getDeposits(sorted[4]) : getDeposits(sorted[1]);

  if (latest === null || yearAgo === null || yearAgo === 0) return null;

  return ((latest - yearAgo) / Math.abs(yearAgo)) * 100;
}

function netInterestMargin(stock) {
  // (Interest Income - Interest Expense) / Average Earning Assets
  const income = Array.isArray(stock?.income) ? stock.income : [];
  const balance = Array.isArray(stock?.balance) ? stock.balance : [];

  if (!income.length || balance.length < 2) return null;

  const latest = income.sort((a, b) => new Date(b.date) - new Date(a.date))[0];
  const sortedBal = [...balance].sort((a, b) => new Date(b.date) - new Date(a.date));

  const intIncome = percentToNumber(latest?.interestIncome ?? latest?.interestAndDividendIncome);
  const intExpense = Math.abs(percentToNumber(latest?.interestExpense) || 0);

  // Average earning assets (approximation: average of last 2 periods' total assets)
  const assets0 = percentToNumber(sortedBal[0]?.totalAssets);
  const assets1 = percentToNumber(sortedBal[1]?.totalAssets);

  if (!Number.isFinite(intIncome) || !Number.isFinite(assets0) || !Number.isFinite(assets1)) return null;

  const avgAssets = (assets0 + assets1) / 2;
  if (avgAssets === 0) return null;

  const netInt = intIncome - intExpense;
  return (netInt / avgAssets) * 100;
}

function techSpendingRatio(stock) {
  // R&D + Technology expenses as % of Operating Expenses
  const income = Array.isArray(stock?.income) ? stock.income : [];
  if (!income.length) return null;

  const latest = income.sort((a, b) => new Date(b.date) - new Date(a.date))[0];

  const rdExpense = Math.abs(percentToNumber(latest?.researchAndDevelopmentExpenses) || 0);
  const techExpense = Math.abs(percentToNumber(latest?.technologyExpenses ?? latest?.softwareExpenses) || 0);
  const opExpenses = Math.abs(percentToNumber(latest?.operatingExpenses) || 0);

  if (opExpenses === 0) return null;

  const totalTech = rdExpense + techExpense;
  return (totalTech / opExpenses) * 100;
}

/**
 * Scoring rules for the Open Fundamentals Engine.
 * 
 * Each rule is an object with:
 * - `name` {string}: Human-readable rule name (used in UI and logs)
 * - `weight` {number}: Impact on final score (1-10 scale)
 *   - 10 = Critical (FCF, Dilution, Revenue Growth)
 *   - 8 = Significant (Valuation, Margins)
 *   - 5-6 = Moderate (Leverage, Working Capital)
 *   - 2-3 = Minor/Bonus (Efficiency ratios)
 * - `evaluate` {function}: Takes a `stock` object, returns score result
 * 
 * @typedef {Object} RuleResult
 * @property {number} score - The rule's contribution to the total score
 * @property {string} message - Human-readable explanation for the UI
 * @property {boolean} [notApplicable] - If true, rule doesn't apply to this stock
 * @property {boolean} [missing] - If true, required data was unavailable
 * 
 * @example
 * // Rule evaluation returns a result object:
 * { score: 8, message: "+25.3% (YoY)" }
 * { score: 0, message: "No revenue growth data", missing: true }
 * { score: 0, message: "N/A for Financials sector", notApplicable: true }
 * 
 * @see METHODOLOGY.md for weight rationale and sector-specific adjustments
 * @see CONTRIBUTING.md for how to report scoring anomalies
 */
export const rules = [
  // Revenue growth (sector-specific bands)
  {
    name: "Revenue growth YoY",
    weight: 10,
    evaluate(stock) {
      const g = revenueGrowth(stock);
      const bucket = resolveSectorBucket(stock?.sector || stock?.sectorBucket);
      if (g === null) return missing("No revenue growth data");

      // Skip for new entities (post-merger/IPO) with <8 quarters - YoY comparisons are distorted
      const quarterCount = stock?.dataQuality?.quarterCount ?? stock?.quarterCount ?? 16;
      if (quarterCount < 8 && Math.abs(g) > 50) {
        // Extreme YoY swing with limited history = likely merger/spinoff distortion
        return { score: 0, message: `${fmtPct(g)} (New entity; YoY distorted)`, notApplicable: true };
      }

      // Also catch merger distortion when CAGR strongly disagrees with YoY
      // (e.g., CAGR is +40% but YoY is -27% due to merger accounting)
      const cagr = percentToNumber(stock?.growth?.revenueCagr3y);
      if (g < -20 && cagr != null && cagr > 20) {
        // YoY is negative but long-term growth is strong = merger/restatement distortion
        return { score: 0, message: `${fmtPct(g)} (CAGR ${fmtPct(cagr)}; one-time distortion)`, notApplicable: true };
      }

      if (bucket === "Tech/Internet") {
        const score = bandScore(g, [
          { min: 30, score: 10 },
          { min: 20, score: 8 },
          { min: 10, score: 4 },
          { min: 0, score: 0 },
          { min: -10, score: -4 },
          { min: -1000, score: -8 }
        ]);
        return { score, message: `${fmtPct(g)} (YoY)` };
      }
      if (bucket === "Biotech/Pharma") {
        const score = bandScore(g, [
          { min: 50, score: 4 },
          { min: 0, score: 2 },
          { min: -1000, score: -4 }
        ]);
        return { score, message: `${fmtPct(g)} (YoY)` };
      }
      // General
      const score = bandScore(g, [
        { min: 10, score: 4 },
        { min: 0, score: 0 },
        { min: -1000, score: -4 }
      ]);
      return { score, message: `${fmtPct(g)} (Industrial YoY)` };
    }
  },
  // Price / Sales (Valuation)
  {
    name: "Price / Sales",
    weight: 8,
    evaluate(stock) {
      const ps = stock?.valuationRatios?.psRatio;
      const bucket = resolveSectorBucket(stock?.sector || stock?.sectorBucket);

      // Fix: 0.0x P/S usually means missing data (Market Cap 0 or Price 0).
      if (ps !== null && ps < 0.01) return missing("Data invalid", true);

      if (ps === null || ps === undefined) return missing("No P/S data");

      const g = revenueGrowth(stock) || 0;
      // Hyper Growth Exception
      if (bucket === "Tech/Internet" && g > 40) {
        const score = bandScore(-ps, [
          { min: -10, score: 8 },
          { min: -18, score: 6 },
          { min: -25, score: 4 },
          { min: -40, score: 0 },
          { min: -1000, score: -4 }
        ]);
        return { score, message: `${ps.toFixed(1)}x (High Growth)` };
      }

      // Tech/biotech often trade at higher multiples
      if (bucket === "Tech/Internet" || bucket === "Biotech/Pharma") {
        const score = bandScore(-ps, [
          { min: -3, score: 8 },  // < 3x
          { min: -6, score: 5 },  // < 6x
          { min: -12, score: 2 },
          { min: -18, score: -2 },
          { min: -1000, score: -6 }
        ]);
        return { score, message: `${ps.toFixed(1)}x` };
      }
      // General
      const score = bandScore(-ps, [
        { min: -1.5, score: 8 },
        { min: -3, score: 6 },
        { min: -5, score: 2 },
        { min: -1000, score: -4 }
      ]);
      return { score, message: `${ps.toFixed(1)}x` };
    }
  },
  // Price / Earnings (Valuation)
  {
    name: "Price / Earnings",
    weight: 8,
    evaluate(stock) {
      const pe = stock?.valuationRatios?.peRatio;
      const g = revenueGrowth(stock) || 0;
      const bucket = resolveSectorBucket(stock?.sector || stock?.sectorBucket);

      // SaaS/High Growth Exemption: Unprofitable is okay if growing > 30%
      if (pe === null || pe === undefined) {
        if (bucket === "Tech/Internet" && g > 30) {
          return { score: 0, message: "Unprofitable (High Growth)" };
        }
        // Check if actually profitable (EPS > 0) but just missing Price
        const eps = Number(stock?.ttm?.epsBasic);
        if (Number.isFinite(eps) && eps > 0) return missing("Price data unavailable");

        return missing("Unprofitable", true);
      }
      let msg = `${pe.toFixed(1)}x`;
      if (Math.abs(pe) > 1000) msg = pe > 0 ? "> 1000x" : "< -1000x";

      // Fintech-specific P/E bands (hybrid: more lenient than banks, more strict than pure tech)
      if (isFintech(stock)) {
        const score = bandScore(-pe, [
          { min: -25, score: 8 },   // < 25x (healthy for growth fintech)
          { min: -40, score: 5 },   // < 40x (acceptable for high growth)
          { min: -60, score: 0 },   // < 60x (stretched but not penalized)
          { min: -100, score: -4 }, // > 60x (expensive)
          { min: -1000, score: -6 }
        ]);
        return { score, message: `${msg} (Fintech)` };
      }

      const score = bandScore(
        -pe,
        bucket === "Financials"
          ? [
            { min: -12, score: 8 },
            { min: -20, score: 5 },
            { min: -35, score: 0 },
            { min: -60, score: -4 },
            { min: -1000, score: -6 }
          ]
          : [
            { min: -12, score: 8 },
            { min: -20, score: 5 },
            { min: -30, score: 0 },
            { min: -50, score: -4 },
            { min: -1000, score: -8 }
          ]
      );
      return { score, message: msg };
    }
  },
  // Price / Book (Financials/REITs)
  {
    name: "Price / Book",
    weight: 6,
    evaluate(stock) {
      const bucket = resolveSectorBucket(stock?.sector || stock?.sectorBucket);
      if (bucket !== "Financials" && bucket !== "Real Estate") return missing("Not applicable", true);
      const pb = stock?.valuationRatios?.pbRatio;
      if (pb === null) return missing("No P/B data");

      // Soften P/B for fintechs - they trade at higher multiples due to growth potential
      if (isFintech(stock)) {
        const score = bandScore(-pb, [
          { min: -2, score: 4 },   // Cheap for fintech
          { min: -4, score: 0 },   // Reasonable for fintech
          { min: -6, score: -2 },  // Expensive for fintech
          { min: -1000, score: -4 }
        ]);
        return { score, message: `${pb.toFixed(1)}x (Fintech)` };
      }

      const score = bandScore(-pb, [
        { min: -1, score: 8 },
        { min: -1.5, score: 5 },
        { min: -3, score: 0 },
        { min: -1000, score: -4 }
      ]);
      return { score, message: `${pb.toFixed(1)}x` };
    }
  },
  // Gross margin
  {
    name: "Gross margin",
    weight: 8,
    evaluate(stock) {
      const gm = grossMargin(stock);
      const bucket = resolveSectorBucket(stock?.sector || stock?.sectorBucket);
      if (bucket !== "Tech/Internet") return missing("Not applicable", true);
      if (gm === null) return missing("No gross margin data");
      const score = bandScore(gm, [
        { min: 75, score: 8 },
        { min: 60, score: 6 },
        { min: 50, score: 2 },
        { min: 40, score: -2 },
        { min: -1000, score: -6 }
      ]);
      return { score, message: fmtPct(gm) };
    }
  },
  // Gross margin (industrial)
  {
    name: "Gross margin (industrial)",
    weight: 5,
    evaluate(stock) {
      const gm = grossMargin(stock);
      const bucket = resolveSectorBucket(stock?.sector || stock?.sectorBucket);
      if (bucket !== "Industrial/Cyclical") return missing("Not applicable", true);
      if (gm === null) return missing("No gross margin data");
      const score = bandScore(gm, [
        { min: 35, score: 5 },
        { min: 25, score: 2 },
        { min: 15, score: 0 },
        { min: 0, score: -4 },
        { min: -1000, score: -6 }
      ]);
      return { score, message: fmtPct(gm) };
    }
  },
  // Gross margin trend
  {
    name: "Gross margin trend",
    weight: 6,
    evaluate(stock) {
      const trend = grossMarginTrend(stock);
      const bucket = resolveSectorBucket(stock?.sector || stock?.sectorBucket);
      if (bucket !== "Retail") return missing("Not applicable", true);
      if (trend === null) return missing("No gross margin trend data");
      const score = trend > 0 ? 6 : trend === 0 ? 0 : -6;
      return { score, message: fmtPct(trend) };
    }
  },
  // Gross margin (health)
  {
    name: "Gross margin (health)",
    weight: 6,
    evaluate(stock) {
      const gm = grossMargin(stock);
      const bucket = resolveSectorBucket(stock?.sector || stock?.sectorBucket);
      if (bucket !== "Healthcare" && bucket !== "Staples" && bucket !== "Biotech/Pharma") return missing("Not applicable", true);

      const isBio = bucket === "Biotech/Pharma" || (stock?.sicDescription && /pharm|bio|drug|device/i.test(stock?.sicDescription));
      const revenue = stock?.expenses?.revenue;

      if (isBio) {
        if (Number.isFinite(revenue) && revenue < 50_000_000) return missing("Not applicable (early stage)", true);
        // Relaxed for commercial bio
        const score = bandScore(gm, [
          { min: 80, score: 6 },
          { min: 60, score: 3 },
          { min: 40, score: 0 },
          { min: -1000, score: -2 }
        ]);
        return { score, message: fmtPct(gm) };
      }

      if (gm === null) return missing("No gross margin data");
      const score = bandScore(gm, [
        { min: 55, score: 6 },
        { min: 45, score: 3 },
        { min: 35, score: 0 },
        { min: 0, score: -4 },
        { min: -1000, score: -8 }
      ]);
      return { score, message: fmtPct(gm) };
    }
  },
  // Operating leverage (Operating Income / Gross Profit)
  {
    name: "Operating leverage",
    weight: 5,
    evaluate(stock) {
      const bucket = resolveSectorBucket(stock?.sector || stock?.sectorBucket);
      if (bucket === "Financials" || bucket === "Real Estate") return missing("Not applicable", true);
      const v = operatingLeverage(stock);
      if (v === null) return missing("No operating leverage data");
      const score = bandScore(v, [
        { min: 0.6, score: 5 },
        { min: 0.5, score: 3 },
        { min: 0.4, score: 2 },
        { min: -1000, score: 0 }
      ]);
      return { score, message: `${(v * 100).toFixed(1)}%` };
    }
  },
  // FCF margin
  {
    name: "FCF margin",
    weight: 10,
    evaluate(stock) {
      const fcf = fcfMargin(stock);
      const bucket = resolveSectorBucket(stock?.sector || stock?.sectorBucket);
      if (fcf === null) return missing("No FCF margin data");

      if (bucket === "Biotech/Pharma") {
        const mcap = stock?.marketCap || 0;
        const isMiddleOrLarge = mcap > 2e9;

        // Healthy Burn Logic:
        const burnTrend = percentToNumber(stock?.momentum?.burnTrend);
        const g = revenueGrowth(stock);
        const isHealthyBurn = (burnTrend && burnTrend > 15) || (g && g > 50);

        const score = bandScore(fcf, [
          { min: 10, score: 2 },
          { min: 0, score: 0 },
          { min: -20, score: -2 },
          { min: -50, score: isHealthyBurn ? -2 : (isMiddleOrLarge ? -2 : -4) },
          { min: -100, score: isHealthyBurn ? -2 : (isMiddleOrLarge ? -4 : -6) },
          { min: -1000000, score: isHealthyBurn ? -2 : (isMiddleOrLarge ? -6 : -8) }
        ]);
        return { score, message: isHealthyBurn ? `${fmtPct(fcf)} (Inv. Mode)` : fmtPct(fcf) };
      }
      if (bucket === "Real Estate" || bucket === "Financials") return missing("Not applicable (Use FFO/Book)", true);

      if (bucket === "Industrial/Cyclical" || bucket === "Consumer & Services") {
        const score = bandScore(fcf, [
          { min: 12, score: 6 },
          { min: 8, score: 3 },
          { min: 4, score: 0 },
          { min: 0, score: -2 },
          { min: -1000000, score: -6 }
        ]);
        return { score, message: fmtPct(fcf) };
      }

      if (bucket === "Tech/Internet") {
        const score = bandScore(fcf, [
          { min: 20, score: 6 },
          { min: 10, score: 3 },
          { min: 0, score: 0 },
          { min: -20, score: -4 },
          { min: -50, score: -8 },
          { min: -1000000, score: -12 }
        ]);
        return { score, message: fmtPct(fcf) };
      }
      return { score: 0, message: fmtPct(fcf) };
    }
  },
  // Cash Runway
  {
    name: "Cash Runway (years)",
    weight: 10,
    evaluate(stock) {
      const bucket = resolveSectorBucket(stock?.sector || stock?.sectorBucket);
      if (bucket !== "Biotech/Pharma") return missing("Not applicable", true);
      const runway = runwayYears(stock);
      if (runway === null) return missing("No runway data");
      if (runway === Infinity || runway > 50) return { score: 4, message: "Self-funded" };

      const score = bandScore(runway, [
        { min: 3, score: 3 },
        { min: 1.5, score: 2 },
        { min: 0.75, score: 0 },
        { min: 0.5, score: -3 },
        { min: -1000, score: -6 }
      ]);
      return { score, message: `${runway.toFixed(2)}y` };
    }
  },
  // Shares dilution YoY
  {
    name: "Shares dilution YoY",
    weight: 10,
    evaluate(stock) {
      const d = dilutionYoY(stock);
      const bucket = resolveSectorBucket(stock?.sector || stock?.sectorBucket);
      if (d === null) return missing("No share count data");

      const g = revenueGrowth(stock) || 0;
      const isHighGrowth = g > 40;

      if (bucket === "Biotech/Pharma") {
        const mcap = stock?.marketCap || 0;
        const score = bandScore(d, [
          { min: -20, score: 2 },
          { min: 0, score: 0 },
          { min: 20, score: -5 }, // Softer
          { min: 50, score: -10 },
          { min: -1000, score: -15 }
        ]);
        // Cap penalty for large biotechs
        if (mcap > 1e9 && score < -10) return { score: -10, message: `${fmtPct(d)} (YoY)` };
        return { score, message: `${fmtPct(d)} (YoY)` };
      }

      // Invert d so "Dilution" (positive d) is bad (negative score)
      // and "Buyback" (negative d) is good.
      const val = -d;

      if (isHighGrowth) {
        // High growth companies often dilute. Be lenient.
        // Buyback or < 5% Dilution (val > -5)
        const score = bandScore(val, [
          { min: -5, score: 5 },
          { min: -10, score: 3 }, // < 10%
          { min: -20, score: 0 }, // < 20%
          { min: -1000, score: -6 } // > 20%
        ]);
        return { score, message: `${fmtPct(d)} (YoY)` };
      }

      // Standard companies
      const score = bandScore(val, [
        { min: 1, score: 8 },    // Buyback > 1%
        { min: -1, score: 5 },   // Flat / < 1% dilution
        { min: -3, score: 2 },   // < 3% dilution
        { min: -5, score: 0 },   // < 5% dilution
        { min: -15, score: -6 }, // < 15% dilution
        { min: -1000, score: -12 } // > 15% dilution
      ]);
      return { score, message: `${fmtPct(d)} (YoY)` };
    }
  },
  // Capital Return (bonus-oriented; computed as % of FCF)
  {
    name: "Capital Return",
    weight: 3,
    evaluate(stock) {
      const buybacks = toNumber(stock?.cash?.shareBuybacksTTM);
      const dividends = toNumber(stock?.cash?.dividendsPaidTTM);
      const totalReturn = toNumber(stock?.cash?.shareholderReturnTTM);
      const pct = percentToNumber(stock?.cash?.totalReturnPctFcf);
      const fcf = toNumber(stock?.cash?.freeCashFlowTTM);

      // Bonus-only: if we can't compute cleanly, don't penalize.
      if (!Number.isFinite(totalReturn) || !Number.isFinite(pct) || !Number.isFinite(fcf) || fcf <= 0) {
        return missing("Not applicable", true);
      }

      const score = bandScore(pct, [
        { min: 0.75, score: 4 },
        { min: 0.4, score: 3 },
        { min: 0.2, score: 2 },
        { min: 0.05, score: 1 },
        { min: -1000, score: 0 }
      ]);
      const buybacksText = Number.isFinite(buybacks) ? fmtMoney(buybacks) : "n/a";
      const dividendsText = Number.isFinite(dividends) ? fmtMoney(dividends) : "n/a";
      const totalText = fmtMoney(totalReturn);
      return {
        score,
        message: `${totalText} (${Math.round(pct * 100)}% of FCF)\nBuybacks ${buybacksText}\nDividends ${dividendsText}`
      };
    }
  },
  // Working Capital (cash conversion efficiency)
  {
    name: "Working Capital",
    weight: 2,
    evaluate(stock) {
      const bucket = resolveSectorBucket(stock?.sector || stock?.sectorBucket);
      if (bucket === "Financials") return missing("Not applicable (Sector standard)", true);

      const dso = percentToNumber(stock?.financialPosition?.dsoDays);
      const ccc = percentToNumber(stock?.financialPosition?.cashConversionCycleDays);
      if (!Number.isFinite(ccc)) return missing("Not applicable", true);

      // Lower CCC is better; negative can happen when suppliers fund inventory (not always sustainable).
      const score = bandScore(-ccc, [
        { min: -30, score: 2 },   // CCC <= 30d
        { min: -60, score: 1 },   // <= 60d
        { min: -120, score: 0 },  // <= 120d (neutral)
        { min: -200, score: -1 }, // <= 200d
        { min: -100000, score: -2 }
      ]);

      const cccText = `${Math.round(ccc)}d CCC`;
      const dsoText = Number.isFinite(dso) ? ` • ${Math.round(dso)}d DSO` : "";
      return { score, message: `${cccText}${dsoText}` };
    }
  },
  // Growth Phase Investment (Bonus for mid/large-caps scaling rapidly)
  {
    name: "Growth Phase Investment",
    weight: 15,
    evaluate(stock) {
      const marketCap = toNumber(stock?.marketCap);
      const assetSize = toNumber(stock?.financialPosition?.totalAssets);
      // Revenue growth can be in multiple places depending on data availability
      const revGrowth = percentToNumber(
        stock?.snapshot?.revenueYoYPct ??
        stock?.growth?.revenueGrowthTTM ??
        stock?.momentum?.revenueTrend
      );
      const capexToRev = toNumber(stock?.cash?.capexToRevenue);
      const fcfMargin = percentToNumber(
        stock?.profitMargins?.fcfMargin ??
        stock?.snapshot?.fcfMarginTTM
      );

      // Only applies to mid/large caps with real scale
      const isMidOrLarge = (
        (assetSize >= 500e6 && assetSize < 50e9) ||
        (marketCap >= 1e9 && marketCap < 50e9)
      );

      if (!isMidOrLarge) return missing("Not applicable (company size)", true);

      // Must be investing heavily in expansion
      const isInvestmentPhase = (
        Number.isFinite(revGrowth) && revGrowth > 30 &&
        Number.isFinite(capexToRev) && capexToRev > 40 &&
        Number.isFinite(fcfMargin) && fcfMargin < -10
      );

      if (!isInvestmentPhase) return missing("Not applicable (no growth phase detected)", true);

      // Graduated scoring based on revenue growth quality
      const score = bandScore(revGrowth, [
        { min: 80, score: 8 },   // Exceptional hypergrowth
        { min: 60, score: 6 },   // Very strong growth
        { min: 40, score: 4 },   // Strong growth
        { min: 30, score: 2 },   // Good growth
        { min: -1000, score: 0 }
      ]);

      return {
        score,
        message: `${fmtPct(capexToRev)} capex intensity`
      };
    }
  },
  // Fintech Growth Momentum (Bonus for high-growth digital banking/fintech)
  {
    name: "Fintech Growth Momentum",
    weight: 8,
    evaluate(stock) {
      if (!isFintech(stock)) return missing("Not applicable (fintech only)", true);

      const revGrowth = percentToNumber(
        stock?.snapshot?.revenueYoYPct ??
        stock?.growth?.revenueGrowthTTM ??
        stock?.momentum?.revenueTrend
      );

      if (!Number.isFinite(revGrowth) || revGrowth < 15) {
        return missing("Not applicable (growth threshold not met)", true);
      }

      // Reward fintechs for scaling digital banking operations
      const score = bandScore(revGrowth, [
        { min: 50, score: 8 },   // Exceptional growth
        { min: 35, score: 6 },   // Very strong growth
        { min: 25, score: 4 },   // Strong growth
        { min: 15, score: 2 },   // Solid growth
        { min: -1000, score: 0 }
      ]);

      return {
        score,
        message: `${fmtPct(revGrowth)} revenue growth (digital banking scale-up)`
      };
    }
  },
  // Effective Tax Rate (Informational Only - No Scoring)
  {
    name: "Effective Tax Rate",
    weight: 0, // Changed from 1 to 0 - purely informational
    evaluate(stock) {
      const raw = percentToNumber(stock?.taxes?.effectiveTaxRateTTM);
      if (!Number.isFinite(raw)) return missing("Not applicable", true);
      const pct = Math.abs(raw) <= 1 ? raw * 100 : raw;

      // Check if the company is loss-making (negative pretax income)
      const pretaxIncome = percentToNumber(
        stock?.profitMargins?.incomeBeforeIncomeTaxes ??
        stock?.ttm?.incomeBeforeIncomeTaxes
      );
      const isLossMaking = Number.isFinite(pretaxIncome) && pretaxIncome <= 0;

      // Informational-only - no penalties, just contextual messages
      let message = fmtPct(pct);

      if (isLossMaking) {
        message += " (loss-making)";
      } else if (pct < 5) {
        message += " (likely tax credits/loss carryforwards)";
      } else if (pct > 45) {
        message += " (elevated - check for one-time items)";
      } else if (pct >= 15 && pct <= 35) {
        message += " (normal range)";
      }

      return { score: 0, message };
    }
  },
  // Debt / Equity
  {
    name: "Debt / Equity",
    weight: 8,
    evaluate(stock) {
      const d = debtToEquity(stock);
      const netDE = percentToNumber(stock?.financialPosition?.netDebtToEquity);
      const bucket = resolveSectorBucket(stock?.sector || stock?.sectorBucket);
      const totalDebtRaw = stock?.financialPosition?.totalDebt;
      const finDebtRaw = stock?.financialPosition?.financialDebt;
      const totalDebt = Number.isFinite(Number(totalDebtRaw)) ? Number(totalDebtRaw) : null;
      const finDebt = Number.isFinite(Number(finDebtRaw)) ? Number(finDebtRaw) : null;
      // Use raw Debt/Equity to detect insolvency (Equity < 0).
      const rawDE = stock?.financialPosition?.debtToEquity;

      // Negative Equity Check: If Raw Debt/Equity is negative, Equity is negative.
      if (rawDE !== null && rawDE < 0) {
        return { score: -10, message: "Negative equity (balance sheet deficit; monitor solvency)" };
      }

      // Explicit Zero Debt Bonus
      if (totalDebt === 0 || finDebt === 0 || (finDebt != null && stock?.financialPosition?.totalAssets && finDebt < stock.financialPosition.totalAssets * 0.01)) {
        const bonus = bucket === "Biotech/Pharma" ? 5 : 10;
        const msg = (totalDebt > 0 && finDebt === 0) ? "No financial debt (leases only)" : "No financial debt (debt-free)";
        return { score: bonus, message: msg };
      }

      if (bucket === "Financials") return missing("Not applicable (Sector standard)", true);

      if (d === null) return missing("No leverage data");

      // If Net Debt/Equity is negative, and we've passed the "Insolvency" check above (Equity < 0 check),
      // then this implies Net Cash position (Cash > Debt).
      if (Number.isFinite(netDE) && netDE < 0) {
        return { score: 8, message: `${netDE.toFixed(2)}x (Net Cash)` };
      }

      const score = bandScore(-d, [
        { min: -1.5, score: 8 },
        { min: -3, score: 6 },
        { min: -4, score: 2 },
        { min: -1000, score: -6 }
      ]);
      return { score, message: `${d.toFixed(2)}x` };
    }
  },
  // Net Debt / FCF
  {
    name: "Net Debt / FCF",
    weight: 6,
    evaluate(stock) {
      const bucket = resolveSectorBucket(stock?.sector || stock?.sectorBucket);
      if (bucket !== "Energy/Materials" && bucket !== "Real Estate") return missing("Not applicable", true);
      const years = netDebtToFcf(stock);
      if (years === null) return missing("No data");
      if (!Number.isFinite(years)) return missing("No data");
      const score = bandScore(-years, [{ min: -1, score: 4 }, { min: -3, score: 0 }, { min: -1000, score: -6 }]);
      return { score, message: `${years.toFixed(1)}y` };
    }
  },
  // Capex intensity
  {
    name: "Capex intensity",
    weight: 4,
    evaluate(stock) {
      const bucket = resolveSectorBucket(stock?.sector || stock?.sectorBucket);
      if (bucket !== "Energy/Materials") return missing("Not applicable", true);
      const v = capexToRevenue(stock);
      if (v === null) return missing("No data");
      const score = bandScore(-v, [{ min: -5, score: 2 }, { min: -10, score: 0 }, { min: -1000, score: -4 }]);
      return { score, message: fmtPct(v) };
    }
  },
  // ROE
  {
    name: "ROE",
    weight: 10,
    evaluate(stock) {
      const bucket = resolveSectorBucket(stock?.sector || stock?.sectorBucket);

      // Fintech special handling: Apply to fintechs even if not technically in "Financials" sector
      if (isFintech(stock)) {
        const v = roePct(stock);
        if (v === null) return missing("No ROE data");
        const g = revenueGrowth(stock) || 0;

        // High-growth fintechs: More lenient
        if (g > 20) {
          const score = bandScore(v, [
            { min: 12, score: 8 },  // Lower bar for growth phase
            { min: 5, score: 4 },   // Acceptable for scaling
            { min: 0, score: 0 },   // Neutral if positive
            { min: -1000, score: -6 } // Penalty if negative
          ]);
          return { score, message: `${fmtPct(v)} (Growth Phase)` };
        }

        // Standard fintech bands
        const score = bandScore(v, [
          { min: 15, score: 10 },
          { min: 8, score: 5 },
          { min: 0, score: -4 },
          { min: -1000, score: -10 }
        ]);
        return { score, message: fmtPct(v) };
      }

      if (bucket !== "Financials") return missing("Not applicable (financials only)", true);
      const v = roePct(stock);
      if (v === null) return missing("No ROE data");
      const score = bandScore(v, [{ min: 15, score: 10 }, { min: 8, score: 5 }, { min: 0, score: -4 }, { min: -1000, score: -10 }]);
      return { score, message: fmtPct(v) };
    }
  },
  // ROE quality
  {
    name: "ROE quality",
    weight: 8,
    evaluate(stock) {
      const roe = roePct(stock);
      const bucket = resolveSectorBucket(stock?.sector || stock?.sectorBucket);
      if (bucket === "Financials") return missing("Not applicable (use ROE for financials)", true);
      if (bucket === "Biotech/Pharma") return missing("Not applicable (pre-profit)", true);
      if (roe === null) return missing("No ROE data");
      const score = bandScore(roe, [
        { min: 80, score: -4 },
        { min: 40, score: 6 },
        { min: 15, score: 4 },
        { min: 10, score: 2 },
        { min: 0, score: 0 },
        { min: -1000, score: -8 }
      ]);
      return { score, message: fmtPct(roe) };
    }
  },
  // Insider Ownership
  {
    name: "Insider Ownership",
    weight: 5,
    evaluate(stock) {
      // DISABLED: Data not currently extracted from EDGAR (requires DEF 14A parsing).
      return missing("Not applicable", true);
      /*
      const v = percentToNumber(stock?.shareStats?.insiderOwnership);
      if (v === null) return missing("No insider data");
      // Positive Rule: Award points for high insider ownership. No penalty for low.
      const score = bandScore(v, [
        { min: 30, score: 8 },  // Founder led?
        { min: 10, score: 5 },  // High alignment
        { min: 5, score: 2 },
        { min: -1000, score: 0 }
      ]);
      return { score, message: score > 0 ? `${fmtPct(v)} (High Alignment)` : fmtPct(v) };
      */
    }
  },
  // Return on Assets
  {
    name: "Return on Assets",
    weight: 6,
    evaluate(stock) {
      const v = roaPct(stock);
      if (v === null) return missing("No ROA data");
      const bucket = resolveSectorBucket(stock?.sector || stock?.sectorBucket);
      const isAssetHeavy = bucket === "Financials" || bucket === "Real Estate" || bucket === "Industrial/Cyclical";
      // Asset heavy sectors often have lower ROA. Tech has high ROA.
      const score = bandScore(v, [
        { min: 15, score: 8 },
        { min: 10, score: 6 },
        { min: 5, score: 3 },
        { min: 0, score: 0 },
        { min: -1000, score: -4 }
      ]);
      return { score, message: fmtPct(v) };
    }
  },
  // Asset efficiency
  {
    name: "Asset Efficiency",
    weight: 6,
    evaluate(stock) {
      const bucket = resolveSectorBucket(stock?.sector || stock?.sectorBucket);
      if (bucket === "Financials") return missing("Not applicable", true);
      if (bucket === "Biotech/Pharma") return missing("Not applicable (pre-revenue)", true);
      const v = assetTurnover(stock);
      if (v === null) return missing("No asset turnover data");
      const bands = (() => {
        if (bucket === "Energy/Materials" || bucket === "Industrial/Cyclical" || bucket === "Real Estate") {
          return [
            { min: 0.6, score: 6 },
            { min: 0.35, score: 3 },
            { min: 0.2, score: 1 },
            { min: 0.1, score: -2 },
            { min: -1000, score: -4 }
          ];
        }
        return [
          { min: 1.0, score: 8 },
          { min: 0.7, score: 5 },
          { min: 0.4, score: 2 },
          { min: 0.2, score: 0 },
          { min: -1000, score: -4 }
        ];
      })();
      const score = bandScore(v, bands);
      return { score, message: `${v.toFixed(2)}x` };
    }
  },
  // ROIC
  {
    name: "ROIC",
    weight: 8,
    evaluate(stock) {
      const bucket = resolveSectorBucket(stock?.sector || stock?.sectorBucket);
      if (bucket === "Financials") return missing("Not applicable", true);

      // Skip when equity is negative - ROIC becomes meaningless (can give false +600% etc)
      const equity = stock?.financialPosition?.totalEquity;
      if (Number.isFinite(equity) && equity < 0) {
        return missing("Not applicable (negative equity)", true);
      }

      const v = roic(stock);
      if (v === null) return missing("No ROIC data");

      // Also skip if ROIC is absurdly high (>200%) - likely data distortion
      if (v > 200) return missing("Not applicable (distorted calculation)", true);

      const score = bandScore(v, [
        { min: 25, score: 8 },  // Elite
        { min: 15, score: 4 },  // Good
        { min: 6, score: 1 },
        { min: 0, score: -4 },
        { min: -1000, score: -8 }
      ]);
      return { score, message: fmtPct(v) };
    }
  },
  // Net income trend (Financials)
  // Net income trend (Financials OR Improved Profitability)
  {
    name: "Net income trend",
    weight: 6,
    evaluate(stock) {
      const bucket = resolveSectorBucket(stock?.sector || stock?.sectorBucket);
      const v = netIncomeTrend(stock);
      if (v === null) return missing("Not applicable (insufficient history)", true);

      // Case 1: Financials (Standard metric)
      if (bucket === "Financials") {
        const score = bandScore(v, [
          { min: 10, score: 4 },
          { min: 0, score: 0 },
          { min: -1000, score: -4 }
        ]);
        return { score, message: fmtPct(v) };
      }

      // Case 2: Turnaround / Breakout (Tech/Industrial)
      // If unprofitable but improving aggressively (>15% reduction in loss), reward it.
      // This offsets the "No P/E" penalty.
      const isUnprofitable = stock?.profitMargins?.netIncome < 0;
      if (isUnprofitable && (bucket === "Tech/Internet" || bucket === "Industrial/Cyclical")) {
        const score = bandScore(v, [
          { min: 50, score: 6 }, // Massive improvement
          { min: 20, score: 4 }, // Solid narrowing
          { min: 10, score: 2 },
          { min: 0, score: 0 },
          { min: -1000, score: -2 }
        ]);
        return { score, message: score > 0 ? `${fmtPct(v)} (Loss narrowing)` : fmtPct(v) };
      }

      return missing("Not applicable", true);
    }
  },
  // Interest coverage (critical)
  {
    name: "Interest coverage",
    weight: 8,
    evaluate(stock) {
      const bucket = resolveSectorBucket(stock?.sector || stock?.sectorBucket);
      if (bucket === "Financials") return missing("Not applicable (Financials)", true);
      const ic = stock?.financialPosition?.interestCoverage;
      const de = stock?.financialPosition?.debtToEquity;
      const icStatus = stock?.financialPosition?.interestCoverageStatus;
      if (ic === null || ic === undefined) {
        if (de !== null && de !== undefined && de < 0.2) {
          return { score: 10, message: "Debt-Free", missing: true, notApplicable: true };
        }
        if (icStatus === "missing-interest") return missing("Interest expense missing; coverage unknown");
        return missing("Data unavailable");
      }
      if (ic === Infinity || ic > 1e6) return { score: 10, message: "Debt-Free", missing: true, notApplicable: true };

      // Soften penalty for foreign issuers with positive FCF (IFRS amortization can distort operating income)
      const isForeign = stock?.issuerType === "foreign";
      const fcfMargin = percentToNumber(stock?.profitMargins?.fcfMargin);
      const fcfPositive = Number.isFinite(fcfMargin) && fcfMargin > 5;

      if (isForeign && fcfPositive && ic < 3) {
        // Foreign issuer with strong FCF but weak GAAP coverage - likely accounting distortion
        const softenedScore = ic < 1 ? -2 : 0;
        return { score: softenedScore, message: `${ic.toFixed(1)}x (FCF positive; IFRS distortion likely)` };
      }

      const score = bandScore(ic, [
        { min: 12, score: 8 },
        { min: 6, score: 4 },
        { min: 3, score: 1 },
        { min: 1, score: -4 },
        { min: -1000, score: -8 }
      ]);
      return { score, message: `${ic.toFixed(1)}x` };
    }
  },
  // Revenue CAGR (3Y) for mature sectors
  {
    name: "Revenue CAGR (3Y)",
    weight: 6,
    evaluate(stock) {
      const bucket = resolveSectorBucket(stock?.sector || stock?.sectorBucket);
      if (bucket === "Tech/Internet") return missing("Not applicable", true);
      const g = percentToNumber(stock?.growth?.revenueCagr3y);
      if (g === null) return missing("Not applicable (insufficient history)", true);
      const score = bandScore(g, [
        { min: 12, score: 6 },
        { min: 7, score: 3 },
        { min: 3, score: 1 },
        { min: 0, score: -2 },
        { min: -1000, score: -6 }
      ]);
      return { score, message: fmtPct(g) };
    }
  },
  // EPS CAGR (3Y) for mature sectors
  {
    name: "EPS CAGR (3Y)",
    weight: 6,
    evaluate(stock) {
      const bucket = resolveSectorBucket(stock?.sector || stock?.sectorBucket);
      if (bucket === "Tech/Internet") return missing("Not applicable", true);
      const g = percentToNumber(stock?.growth?.epsCagr3y);
      if (g === null) return missing("Not applicable (insufficient history)", true);
      const score = bandScore(g, [
        { min: 15, score: 6 },
        { min: 8, score: 3 },
        { min: 3, score: 1 },
        { min: 0, score: -2 },
        { min: -1000, score: -6 }
      ]);
      return { score, message: fmtPct(g) };
    }
  },
  // Dividend coverage vs FCF
  {
    name: "Dividend coverage",
    weight: 5,
    evaluate(stock) {
      const payout = dividendPayout(stock);
      // Dividend payout is not currently extracted in this pipeline; treat as not applicable to avoid score distortion.
      if (payout === null) return missing("Not applicable (dividend data not tracked)", true);
      // NOTE: payoutToFcf is stored as a PERCENTAGE (e.g., 89 for 89%), not a ratio.
      // Thresholds are adjusted accordingly: 20=20%, 80=80%, 100=100%, 130=130%
      if (payout < 20) return { score: 2, message: fmtPct(payout) };   // Very low payout - retaining cash
      if (payout <= 80) return { score: 5, message: fmtPct(payout) };  // Healthy payout ratio
      if (payout <= 100) return { score: 2, message: fmtPct(payout) }; // High but sustainable
      if (payout <= 130) return { score: -4, message: fmtPct(payout) }; // Warning: paying more than FCF
      return { score: -6, message: fmtPct(payout) };                   // Danger: unsustainable dividend
    }
  },
  // R&D intensity (sector-adjusted; favors innovation investment)
  {
    name: "R&D intensity",
    weight: 5,
    evaluate(stock) {
      const bucket = resolveSectorBucket(stock?.sector || stock?.sectorBucket);
      if (bucket === "Financials" || bucket === "Real Estate") return missing("Not applicable", true);

      const rdPct = percentToNumber(stock?.expenses?.rdToRevenueTTM ?? stock?.expenses?.rdToRevenue);
      if (rdPct === null) return missing("No R&D data");

      // If R&D exceeds revenue, this is a burn signal, not an innovation signal
      if (rdPct > 100) {
        return { score: 0, message: `${fmtPct(rdPct)} (R&D exceeds revenue; burn mode)`, notApplicable: true };
      }

      if (bucket === "Tech/Internet") {
        const score = bandScore(rdPct, [
          { min: 20, score: 5 },
          { min: 15, score: 3 },
          { min: 10, score: 2 },
          { min: -1000, score: 0 }
        ]);
        return { score, message: fmtPct(rdPct) };
      }

      if (bucket === "Biotech/Pharma") {
        const score = bandScore(rdPct, [
          { min: 30, score: 5 },
          { min: 20, score: 3 },
          { min: 15, score: 2 },
          { min: -1000, score: 0 }
        ]);
        return { score, message: fmtPct(rdPct) };
      }

      if (bucket === "Industrial/Cyclical") {
        const score = bandScore(rdPct, [
          { min: 7, score: 5 },
          { min: 5, score: 3 },
          { min: 3, score: 2 },
          { min: -1000, score: 0 }
        ]);
        return { score, message: fmtPct(rdPct) };
      }

      return missing("Not applicable", true);
    }
  },
  // === NEW CARDS FOR GROWTH COMPANIES ===

  // Asset Growth Velocity (Infrastructure buildout indicator)
  {
    name: "Asset Growth Velocity",
    weight: 4,
    evaluate(stock) {
      const g = assetGrowthYoY(stock);
      const revGrowth = revenueGrowth(stock) || 0;

      if (g === null) {
        // Fallback for rapid expanders where history logic might be strict or missing
        if (revGrowth > 50) return { score: 2, message: "Rapid expansion presumed (high rev growth)" };
        return missing("Insufficient history", true);
      }
      const isGrowthPhase = revGrowth > 30;

      if (!isGrowthPhase) return missing("Not applicable (mature company)", true);

      const score = bandScore(g, [
        { min: 50, score: 4 },  // Aggressive infrastructure buildout
        { min: 30, score: 2 },  // Scaling infrastructure
        { min: 15, score: 1 },  // Moderate expansion
        { min: -1000, score: 0 }
      ]);

      const label = g >= 50 ? " (Aggressive buildout)" : g >= 30 ? " (Scaling infra)" : "";
      return { score, message: `${fmtPct(g)} YoY${label}` };
    }
  },

  // Revenue per Asset Efficiency (Monetization trend)
  {
    name: "Revenue per Asset Efficiency",
    weight: 3,
    evaluate(stock) {
      const trend = revenuePerAssetTrend(stock);
      if (trend === null) return missing("Insufficient data", true);

      const revGrowth = revenueGrowth(stock) || 0;
      if (revGrowth < 20) return missing("Not applicable (low growth)", true);

      const score = bandScore(trend, [
        { min: 15, score: 3 },   // Infrastructure monetization accelerating
        { min: 5, score: 2 },    // Improving efficiency
        { min: 0, score: 1 },    // Stable
        { min: -15, score: 0 },  // Declining slightly (acceptable during buildout)
        { min: -1000, score: -2 } // Poor monetization
      ]);

      const label = trend >= 15 ? " (Strong monetization)" : trend >= 5 ? " (Improving)" : "";
      return { score, message: `${fmtPct(trend)} QoQ${label}` };
    }
  },

  // Debt Maturity Runway
  {
    name: "Debt Maturity Runway",
    weight: 3,
    evaluate(stock) {
      const ltRatio = debtMaturityMix(stock);
      if (ltRatio === null) return missing("No debt structure data", true);

      const hasDebt = (stock?.financialPosition?.totalDebt || 0) > 0;
      if (!hasDebt) return missing("Debt-free", true);

      // Soften bands for high-growth companies that are building capital structure
      const revGrowth = revenueGrowth(stock) || 0;
      const isGrowth = revGrowth > 20;

      const score = bandScore(ltRatio, isGrowth ? [
        { min: 60, score: 3 },
        { min: 40, score: 2 },
        { min: 20, score: 0 },
        { min: -1000, score: -1 }
      ] : [
        { min: 80, score: 3 },  // Runway secured (mostly long-term)
        { min: 60, score: 2 },  // Balanced maturity
        { min: 40, score: 0 },  // Mixed
        { min: -1000, score: -2 } // Refinancing risk (mostly short-term)
      ]);

      const threshHigh = isGrowth ? 60 : 80;
      const threshLow = isGrowth ? 20 : 40;
      const label = ltRatio >= threshHigh ? " (Long-term focused)" : ltRatio < threshLow ? " (Near-term refinancing risk)" : "";
      return { score, message: `${ltRatio.toFixed(0)}% long-term${label}` };
    }
  },

  // Operating Leverage Inflection
  {
    name: "Operating Leverage Inflection",
    weight: 4,
    evaluate(stock) {
      const inflection = operatingLeverageInflection(stock);
      if (inflection === null) return missing("Insufficient quarterly history", true);

      const revGrowth = revenueGrowth(stock) || 0;
      if (revGrowth < 15) return missing("Not applicable (low growth)", true);

      if (inflection.improving) {
        const score = bandScore(-inflection.ratioChange, [
          { min: 10, score: 4 },  // Approaching breakeven
          { min: 5, score: 3 },   // Clear improvement
          { min: 2, score: 2 },   // Modest improvement
          { min: -1000, score: 1 }
        ]);
        return { score, message: `OpEx/Rev declining (${fmtPct(inflection.latest)})` };
      }

      // Bonus for aggressive scaling even if not inflecting yet
      if (revGrowth > 50) return { score: 1, message: `OpEx/Rev: ${fmtPct(inflection.latest)} (Aggressive scaling)` };

      return { score: 0, message: `OpEx/Rev: ${fmtPct(inflection.latest)} (Not yet inflecting)` };
    }
  },

  // Cash Burn Deceleration Rate
  {
    name: "Cash Burn Deceleration",
    weight: 4,
    evaluate(stock) {
      const decel = cashBurnDecelerationRate(stock);
      if (decel === null) return missing("Insufficient quarterly data", true);

      const currentFcfMargin = percentToNumber(stock?.profitMargins?.fcfMargin);
      if (currentFcfMargin === null || currentFcfMargin >= 0) return missing("Not applicable (FCF positive)", true);

      const score = bandScore(decel, [
        { min: 30, score: 4 },  // Burn narrowing rapidly
        { min: 15, score: 3 },  // Strong improvement
        { min: 5, score: 2 },   // Improving
        { min: 0, score: 0 },   // Stable burn
        { min: -1000, score: -2 } // Burn worsening
      ]);

      const label = decel >= 30 ? " (Rapid improvement)" : decel >= 15 ? " (Path to profitability)" : decel < 0 ? " (Worsening)" : "";
      return { score, message: `${fmtPct(decel)} QoQ improvement${label}` };
    }
  },

  // Working Capital Efficiency
  {
    name: "Working Capital Efficiency",
    weight: 2,
    evaluate(stock) {
      const ratio = workingCapitalEfficiency(stock);
      if (ratio === null) return missing("Insufficient data", true);

      const revGrowth = revenueGrowth(stock) || 0;
      if (revGrowth < 20) return missing("Not applicable (mature)", true);

      const score = bandScore(ratio, [
        { min: 0.5, score: 2 },   // Balanced growth
        { min: 0.2, score: 1 },   // Acceptable
        { min: 0, score: 0 },     // Tight
        { min: -1000, score: -1 } // Tight liquidity during expansion
      ]);

      const label = ratio >= 0.5 ? " (Well-funded)" : ratio < 0.2 ? " (Tight)" : "";
      return { score, message: `${ratio.toFixed(2)}x${label}` };
    }
  },

  // Revenue Quality Score
  {
    name: "Revenue Quality",
    weight: 3,
    evaluate(stock) {
      if (isFintech(stock) || resolveSectorBucket(stock?.sector || stock?.sectorBucket) === "Financials") {
        return missing("Not applicable (Financials)", true);
      }

      const quality = revenueQualityScore(stock);
      if (quality === null) return missing("Insufficient DSO data", true);

      let score = 0;
      let message = "";

      if (quality.quality === 'high') {
        score = 3;
        message = `High-quality (DSO ${quality.dsoChange >= 0 ? '+' : ''}${quality.dsoChange.toFixed(0)}d, Rev +${quality.revGrowth.toFixed(0)}%)`;
      } else if (quality.quality === 'medium') {
        score = 1;
        message = `Acceptable quality (DSO +${quality.dsoChange.toFixed(0)}d, Rev +${quality.revGrowth.toFixed(0)}%)`;
      } else if (quality.quality === 'low') {
        score = -2;
        message = `Quality concerns (DSO +${quality.dsoChange.toFixed(0)}d, Rev +${quality.revGrowth.toFixed(0)}%)`;
      } else {
        return missing("Not applicable", true);
      }

      return { score, message };
    }
  },

  // === NEW CARDS FOR FINTECH ===

  // Deposit Growth (Fintech/Bank specific)
  {
    name: "Deposit Growth",
    weight: 8,  // Increased from 6 - deposit growth is a key fintech signal
    evaluate(stock) {
      if (!isFintech(stock)) {
        const bucket = resolveSectorBucket(stock?.sector || stock?.sectorBucket);
        if (bucket !== "Financials") return missing("Not applicable (banking only)", true);
      }

      const g = depositGrowthYoY(stock);
      if (g === null) return missing("No deposit data", true);

      const score = bandScore(g, [
        { min: 40, score: 8 },  // Rapid deposit franchise expansion (matched to weight)
        { min: 25, score: 5 },  // Strong growth
        { min: 15, score: 3 },  // Solid growth
        { min: 5, score: 1 },   // Modest growth
        { min: -1000, score: 0 }
      ]);

      const label = g >= 40 ? " (Franchise expansion)" : g >= 25 ? " (Strong growth)" : "";
      return { score, message: `${fmtPct(g)} YoY${label}` };
    }
  },

  // Net Interest Margin (Fintech/Bank core profitability)
  {
    name: "Net Interest Margin",
    weight: 5,
    evaluate(stock) {
      if (!isFintech(stock)) {
        const bucket = resolveSectorBucket(stock?.sector || stock?.sectorBucket);
        if (bucket !== "Financials") return missing("Not applicable (banking only)", true);
      }

      const nim = netInterestMargin(stock);
      if (nim === null) return missing("Insufficient interest income data", true);

      const score = bandScore(nim, [
        { min: 4, score: 5 },   // Strong lending margins
        { min: 2.5, score: 3 }, // Healthy spread
        { min: 1.5, score: 1 }, // Acceptable
        { min: 0, score: 0 },   // Thin margins
        { min: -1000, score: -2 } // Negative spread (concerning)
      ]);

      const label = nim >= 4 ? " (Strong spread)" : nim < 1.5 ? " (Thin margins)" : "";
      return { score, message: `${fmtPct(nim)}${label}` };
    }
  },

  // Tech Spending Ratio (Fintech differentiation)
  {
    name: "Tech Investment",
    weight: 2,
    evaluate(stock) {
      if (!isFintech(stock)) return missing("Not applicable (fintech only)", true);

      const ratio = techSpendingRatio(stock);
      if (ratio === null) return missing("Tech spending not disclosed", true);

      const score = bandScore(ratio, [
        { min: 25, score: 2 },  // Tech-first model
        { min: 15, score: 1 },  // Investing in tech
        { min: 5, score: 0 },   // Moderate tech spend
        { min: -1000, score: -1 } // Not true fintech
      ]);

      const label = ratio >= 25 ? " (Tech-first)" : ratio >= 15 ? " (Tech-enabled)" : "";
      return { score, message: `${fmtPct(ratio)} of OpEx${label}` };
    }
  }
];
