import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getFundamentalsForTicker } from "../edgar/fundamentalsStore.js";
import { getOrFetchLatestPrice } from "../prices/priceService.js";
import { classifySector } from "../sector/sectorClassifier.js";
import { normalize } from "./tickerUtils.js";
import { fetchShortInterest } from "../prices/shortInterestFetcher.js";
import {
  rules,
  applySectorRuleAdjustments,
  resolveSectorBucket,
  percentToNumber,
  isFintech
} from "../../scripts/shared-rules.js";
import { scanFilingForSignals } from "../edgar/filingTextScanner.js";
import { enqueueFundamentalsJob, getJobState } from "../edgar/edgarQueue.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const EDGAR_DIR = path.join(ROOT, "data", "edgar");
const RISK_FREE_RATE_PCT = 4.5; // Placeholder for 10Y Treasury Yield or similar
const priceLogCache = new Map(); // throttle noisy price logs per ticker

const SAFE_THRESHOLD = 0.000001;

function isFiniteValue(val) {
  if (val === null || val === undefined) return false;
  const num = Number(val);
  return Number.isFinite(num);
}

function logPriceOnce(kind, ticker, msg, windowMs = 60_000) {
  const key = `${kind}-${ticker}`;
  const last = priceLogCache.get(key) || 0;
  const now = Date.now();
  if (now - last < windowMs) return;
  priceLogCache.set(key, now);
  console.warn(msg);
}

function safeDiv(a, b) {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(y) < SAFE_THRESHOLD) return null;
  return x / y;
}

function clamp(min, val, max) {
  const n = Number(val);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, n));
}

function inferTaxRateFromPeriods({ ttm, latestAnnual }) {
  const candidates = [
    {
      pretax: ttm?.incomeBeforeIncomeTaxes,
      tax: ttm?.incomeTaxExpenseBenefit
    },
    {
      pretax: latestAnnual?.incomeBeforeIncomeTaxes,
      tax: latestAnnual?.incomeTaxExpenseBenefit
    }
  ];
  for (const c of candidates) {
    const pretax = Number(c?.pretax);
    const tax = Number(c?.tax);
    if (!Number.isFinite(pretax) || !Number.isFinite(tax) || pretax === 0) continue;
    const rate = tax / pretax;
    const clamped = clamp(0, rate, 0.5);
    if (clamped != null) return clamped;
  }
  return null;
}

function formatQuarterLabel(dateStr) {
  const d = new Date(dateStr);
  if (!Number.isFinite(d.getTime())) return dateStr;
  const month = d.getUTCMonth();
  const year = d.getUTCFullYear();
  const q = Math.floor(month / 3) + 1;
  return `Q${q} ${year}`;
}

function sortByPeriodEndAsc(series = []) {
  return [...(series || [])]
    .filter((p) => p && p.periodEnd)
    .sort((a, b) => Date.parse(a.periodEnd) - Date.parse(b.periodEnd));
}

function lastNPeriods(series = [], n = 4) {
  const asc = sortByPeriodEndAsc(series);
  return asc.slice(-n);
}

function findComparableYearAgo(seriesAsc = [], latestPeriodEnd) {
  const latestTs = Date.parse(latestPeriodEnd);
  if (!Number.isFinite(latestTs)) return null;

  // Need at least 5 quarters to reasonably compute a year-ago comparable.
  // With only 4 quarters, any fallback would be a wrong "YoY" comparison.
  if ((seriesAsc || []).length < 5) return null;

  const target = latestTs - 31536000000; // ~365d
  const windowMs = 2600000000; // ~30d
  const inWindow = seriesAsc.find((p) => {
    const ts = Date.parse(p.periodEnd);
    return Number.isFinite(ts) && Math.abs(ts - target) < windowMs;
  });
  if (inWindow) return inWindow;

  const latestIdx = seriesAsc.findIndex((p) => p.periodEnd === latestPeriodEnd);
  if (latestIdx >= 0) return seriesAsc[Math.max(0, latestIdx - 4)] || null;
  return seriesAsc[Math.max(0, seriesAsc.length - 5)] || null;
}

function toQuarterlySeries(periods = []) {
  const quarters = (periods || [])
    .filter((p) => (p.periodType || "").toLowerCase() === "quarter")
    .filter((p) => p.periodEnd)
    .sort((a, b) => Date.parse(a.periodEnd) - Date.parse(b.periodEnd));
  return quarters.map((p) => {
    const fcf =
      p.freeCashFlow != null
        ? p.freeCashFlow
        : p.operatingCashFlow != null
          ? p.operatingCashFlow - Math.abs(p.capex ?? 0) // Assume 0 if capex is null but OCF exists
          : null;
    const costOfRevenue = p.costOfRevenue ?? null;
    const derivedRevenue = p.revenue ?? (p.grossProfit != null && costOfRevenue != null ? p.grossProfit + costOfRevenue : null);
    const derivedGross = p.grossProfit == null && derivedRevenue != null && costOfRevenue != null
      ? derivedRevenue - costOfRevenue
      : p.grossProfit ?? null;
    return {
      periodEnd: p.periodEnd,
      label: formatQuarterLabel(p.periodEnd),
      sector: p.sector ?? null,
      sic: p.sic ?? null,
      sicDescription: p.sicDescription ?? null,
      revenue: derivedRevenue ?? null,
      grossProfit: derivedGross,
      costOfRevenue: costOfRevenue ?? null,
      operatingExpenses: p.operatingExpenses ?? null,
      operatingIncome: p.operatingIncome ?? null,
      incomeBeforeIncomeTaxes: p.incomeBeforeIncomeTaxes ?? null,
      incomeTaxExpenseBenefit: p.incomeTaxExpenseBenefit ?? null,
      netIncome: p.netIncome ?? null,
      epsBasic: p.epsBasic ?? null,
      sharesOutstanding: p.sharesOutstanding ?? p.shares ?? null,
      totalAssets: p.totalAssets ?? null,
      currentAssets: p.currentAssets ?? null,
      totalLiabilities: p.totalLiabilities ?? null,
      currentLiabilities: p.currentLiabilities ?? null,
      totalEquity: p.totalEquity ?? null,
      totalDebt: p.totalDebt ?? null,
      financialDebt: p.financialDebt ?? null,
      shortTermDebt: p.shortTermDebt ?? null,
      longTermDebt: p.longTermDebt ?? null,
      leaseLiabilities: p.leaseLiabilities ?? null,
      shortTermInvestments: p.shortTermInvestments ?? null,
      deposits: p.deposits ?? null,
      customerDeposits: p.customerDeposits ?? null,
      totalDeposits: p.totalDeposits ?? null,
      depositLiabilities: p.depositLiabilities ?? null,
      interestIncome: p.interestIncome ?? null,
      interestExpense: p.interestExpense ?? null,
      cash: p.cashAndCashEquivalents ?? p.cash ?? null,
      accountsReceivable: p.accountsReceivable ?? null,
      inventories: p.inventories ?? null,
      accountsPayable: p.accountsPayable ?? null,
      operatingCashFlow: p.operatingCashFlow ?? null,
      capex: p.capex ?? null,
      depreciationDepletionAndAmortization: p.depreciationDepletionAndAmortization ?? null,
      shareBasedCompensation: p.shareBasedCompensation ?? null,
      researchAndDevelopmentExpenses: p.researchAndDevelopmentExpenses ?? null,
      technologyExpenses: p.technologyExpenses ?? null,
      softwareExpenses: p.softwareExpenses ?? null,
      treasuryStockRepurchased: p.treasuryStockRepurchased ?? null,
      dividendsPaid: p.dividendsPaid ?? null,
      deferredRevenue: p.deferredRevenue ?? null,
      contractWithCustomerLiability: p.contractWithCustomerLiability ?? null,
      freeCashFlow: fcf
    };
  });
}

function buildTtmFromQuarters(quarters) {
  const latest4 = quarters.slice(-4);
  if (latest4.length < 4) return null;

  const sumIfComplete = (field) => {
    let acc = 0;
    for (const q of latest4) {
      if (!isFiniteValue(q?.[field])) return null;
      acc += Number(q[field]);
    }
    return acc;
  };

  // TTM must be a true 4-quarter aggregate; avoid partial-TTM when any quarter is missing.
  const revenue = sumIfComplete("revenue");
  const netIncome = sumIfComplete("netIncome");
  if (revenue == null || netIncome == null) return null;

  const grossProfit = sumIfComplete("grossProfit");
  const operatingIncome = sumIfComplete("operatingIncome");
  const incomeBeforeIncomeTaxes = sumIfComplete("incomeBeforeIncomeTaxes");
  const incomeTaxExpenseBenefit = sumIfComplete("incomeTaxExpenseBenefit");
  const operatingCashFlow = sumIfComplete("operatingCashFlow");
  const capex = sumIfComplete("capex");

  const freeCashFlow = (() => {
    let acc = 0;
    for (const q of latest4) {
      const explicit = isFiniteValue(q?.freeCashFlow) ? Number(q.freeCashFlow) : null;
      const derived =
        explicit == null && isFiniteValue(q?.operatingCashFlow) && isFiniteValue(q?.capex)
          ? Number(q.operatingCashFlow) - Math.abs(Number(q.capex))
          : null;
      const val = explicit ?? derived;
      if (!Number.isFinite(val)) return null;
      acc += val;
    }
    return acc;
  })();

  // EPS TTM is only valid if all 4 quarters have EPS reported; otherwise leave null.
  const epsBasic = sumIfComplete("epsBasic");
  const asOf = latest4[latest4.length - 1].periodEnd;
  return {
    asOf,
    revenue,
    grossProfit,
    operatingIncome,
    incomeBeforeIncomeTaxes,
    incomeTaxExpenseBenefit,
    netIncome,
    epsBasic,
    operatingCashFlow,
    capex,
    freeCashFlow
  };
}

function calcCagr(latest, older, years) {
  const a = Number(latest);
  const b = Number(older);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0 || years <= 0) return null;
  return Math.pow(a / b, 1 / years) - 1;
}

function computeGrowth(periods) {
  const years = periods
    .filter((p) => (p.periodType || "").toLowerCase() === "year")
    .filter((p) => p.periodEnd)
    .sort((a, b) => Date.parse(b.periodEnd) - Date.parse(a.periodEnd));

  const fromAnnual = () => {
    if (years.length < 4) return { revenueCagr3y: null, epsCagr3y: null };
    const latest = years[0];
    const older = years[3];
    const revenueCagr3y =
      older && latest ? calcCagr(latest.revenue ?? null, older.revenue ?? null, 3) : null;
    const epsCagr3y =
      older && latest ? calcCagr(latest.epsBasic ?? null, older.epsBasic ?? null, 3) : null;
    return { revenueCagr3y, epsCagr3y };
  };

  // Fallback: derive a 3Y CAGR from quarterly history (requires >= 16 quarters).
  // We compare the latest TTM (last 4 quarters) to the TTM ending 12 quarters earlier (3 years).
  const fromQuarterly = () => {
    const quartersAsc = (periods || [])
      .filter((p) => {
        const t = String(p?.periodType || "").toLowerCase();
        return t === "quarter" || t === "q";
      })
      .filter((p) => p?.periodEnd)
      .sort((a, b) => Date.parse(a.periodEnd) - Date.parse(b.periodEnd));

    if (quartersAsc.length < 16) return { revenueCagr3y: null, epsCagr3y: null };

    const sumField = (slice, field) => {
      let acc = 0;
      for (const q of slice) {
        const val = Number(q?.[field]);
        if (!Number.isFinite(val)) return null;
        acc += val;
      }
      return acc;
    };

    const latest4 = quartersAsc.slice(-4);
    const older4 = quartersAsc.slice(-16, -12);

    const revLatest = sumField(latest4, "revenue");
    const revOlder = sumField(older4, "revenue");
    const epsLatest = sumField(latest4, "epsBasic");
    const epsOlder = sumField(older4, "epsBasic");

    return {
      revenueCagr3y: calcCagr(revLatest, revOlder, 3),
      epsCagr3y: calcCagr(epsLatest, epsOlder, 3)
    };
  };

  const annual = fromAnnual();
  const quarterly = fromQuarterly();
  return {
    revenueCagr3y: annual.revenueCagr3y ?? quarterly.revenueCagr3y,
    epsCagr3y: annual.epsCagr3y ?? quarterly.epsCagr3y
  };
}

function buildPricePieces(prices) {
  // Ensure we consistently use the "previous" close relative to New York time
  // This filters out any intraday/live entries datestamped with "today"
  const nyDate = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

  const history = [...prices]
    .filter(p => p.date <= nyDate) // allow same-day close; filter only future-dated intraday noise
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));

  const trimmed = history.slice(-400); // keep ~last 400 days to cover prior close + 52w range without bloating payloads
  const last = trimmed[trimmed.length - 1] || history[history.length - 1] || null;
  const prev = trimmed[trimmed.length - 2] || history[history.length - 2] || null;
  const lastClose = last ? Number(last.close) : null;
  const prevClose = prev ? Number(prev.close) : null;
  const dayChangeAbs =
    lastClose != null && prevClose != null ? Number((lastClose - prevClose).toFixed(4)) : null;
  const dayChangePct =
    lastClose != null && prevClose != null && prevClose !== 0
      ? Number(((lastClose - prevClose) / prevClose).toFixed(4))
      : null;
  const window52w = trimmed.slice(-252); // approx 252 trading days
  const high52w =
    window52w.length > 0 ? Math.max(...window52w.map((p) => Number(p.close) || 0)) : null;
  const low52w =
    window52w.length > 0 ? Math.min(...window52w.map((p) => Number(p.close) || 0)) : null;
  return {
    priceHistory: trimmed.map((p) => ({ date: p.date, close: Number(p.close) })),
    priceSummary: {
      lastClose: lastClose ?? null,
      lastCloseDate: last ? last.date : null,
      prevClose: prevClose ?? null,
      dayChangeAbs,
      dayChangePct,
      high52w: Number.isFinite(high52w) ? high52w : null,
      low52w: Number.isFinite(low52w) ? low52w : null
    }
  };
}

function emptyPriceSummary() {
  return {
    lastClose: null,
    lastCloseDate: null,
    prevClose: null,
    dayChangeAbs: null,
    dayChangePct: null,
    high52w: null,
    low52w: null
  };
}

function loadLocalPriceHistory(ticker) {
  try {
    const file = path.join(ROOT, "data", "prices", `${ticker.toUpperCase()}.json`);
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.length) return null;
    return parsed.map((p) => ({
      date: p.date,
      close: Number(p.close)
    }));
  } catch (err) {
    console.warn("[tickerAssembler] failed to load local price file", ticker, err?.message || err);
    return null;
  }
}

function isPriceStale(dateStr, maxAgeDays = 1) {
  if (!dateStr) return true;
  const ts = Date.parse(dateStr);
  if (!Number.isFinite(ts)) return true;
  const ageMs = Date.now() - ts;
  return ageMs > maxAgeDays * 24 * 60 * 60 * 1000;
}

function classifyTrend(values) {
  const filtered = values.filter((v) => Number.isFinite(v));
  if (filtered.length < 2) return null;
  const first = filtered[0];
  const last = filtered[filtered.length - 1];
  const change = last - first;
  const pct = first !== 0 ? change / Math.abs(first) : 0;
  if (pct > 0.05) return "up";
  if (pct < -0.05) return "down";
  return "flat";
}

function slope(values) {
  const filtered = values.filter((v) => Number.isFinite(v));
  if (filtered.length < 2) return 0;
  return filtered[filtered.length - 1] - filtered[0];
}

function clamp01(val) {
  if (val === null || val === undefined) return null;
  const num = Number(val);
  if (!Number.isFinite(num)) return null;
  return Math.max(0, Math.min(1, num));
}

function avg(values) {
  const filtered = values.filter((v) => Number.isFinite(v));
  if (!filtered.length) return null;
  return filtered.reduce((acc, v) => acc + v, 0) / filtered.length;
}

function computeInterestCoverageTtm(quarters) {
  const sorted = [...(quarters || [])]
    .filter((q) => q && q.periodEnd)
    .sort((a, b) => Date.parse(b.periodEnd) - Date.parse(a.periodEnd))
    .slice(0, 4);

  const ebitQuarters = sorted.filter((q) => Number.isFinite(q?.operatingIncome));
  if (ebitQuarters.length < 2) return { value: null, periods: ebitQuarters.length, status: "insufficient-data" };
  const ebitTtm = ebitQuarters.reduce((acc, q) => acc + Number(q.operatingIncome), 0);

  const interestQuarters = sorted.filter((q) => Number.isFinite(q?.interestExpense));
  const interestSum = interestQuarters.reduce((acc, q) => acc + Math.abs(Number(q.interestExpense)), 0);

  // If interest is effectively zero/missing, check debt to distinguish "debt-free" vs missing extraction.
  if (interestQuarters.length === 0 || !Number.isFinite(interestSum) || interestSum < 1) {
    const lastQ = sorted[0] || null;
    const debt = Number(lastQ?.totalDebt || 0);
    if (Number.isFinite(debt) && debt < 1e6) return { value: Infinity, periods: ebitQuarters.length, status: "debt-free" };
    return { value: null, periods: ebitQuarters.length, status: "missing-interest" };
  }

  // If we only have 1–3 quarters of interest expense, annualize the available quarters rather than treating missing as zero.
  const interestTtm = interestQuarters.length < 4 ? (interestSum / interestQuarters.length) * 4 : interestSum;
  if (!Number.isFinite(ebitTtm) || !Number.isFinite(interestTtm) || interestTtm === 0) {
    return { value: null, periods: ebitQuarters.length, status: "insufficient-data" };
  }

  return {
    value: ebitTtm / interestTtm,
    periods: interestQuarters.length,
    status: interestQuarters.length < 4 ? "annualized-interest" : "ok"
  };
}

function computeInterestCoverageAnnual(latest) {
  const row = latest || null;
  if (!row) return { value: null, periods: 0, status: "insufficient-data" };

  const ebit = Number(row.operatingIncome);
  const interest = Math.abs(Number(row.interestExpense || 0));

  if (!Number.isFinite(ebit)) return { value: null, periods: 0, status: "insufficient-data" };

  // If interest is effectively zero/missing, check debt to decide if "debt-free" vs "missing-interest".
  if (!Number.isFinite(interest) || interest < 1) {
    const debt = Number(row.totalDebt || 0);
    if (Number.isFinite(debt) && debt < 1e6) return { value: Infinity, periods: 1, status: "debt-free" };
    return { value: null, periods: 1, status: "missing-interest" };
  }

  return { value: ebit / interest, periods: 1, status: "ok" };
}

function detectLikelySplit(quartersDesc, { tolerance = 0.25, minRatio = 2, epsFloor = 0.01 } = {}) {
  const series = [...(quartersDesc || [])].filter((q) => q && q.periodEnd);
  for (let i = 0; i < series.length - 1; i += 1) {
    const curr = series[i];
    const prev = series[i + 1];
    const sharesCurr = Number(curr?.sharesOutstanding ?? curr?.shares);
    const sharesPrev = Number(prev?.sharesOutstanding ?? prev?.shares);
    if (!Number.isFinite(sharesCurr) || !Number.isFinite(sharesPrev) || sharesPrev === 0) continue;
    const sharesRatio = sharesCurr / sharesPrev;
    if (!Number.isFinite(sharesRatio) || sharesRatio < minRatio) continue;
    const epsCurr = Number(curr?.epsBasic);
    const epsPrev = Number(prev?.epsBasic);
    if (
      !Number.isFinite(epsCurr) ||
      !Number.isFinite(epsPrev) ||
      epsCurr === 0 ||
      epsPrev === 0 ||
      Math.sign(epsCurr) !== Math.sign(epsPrev) ||
      Math.abs(epsCurr) < epsFloor ||
      Math.abs(epsPrev) < epsFloor
    ) {
      continue;
    }
    const epsRatio = epsCurr / epsPrev;
    const inverseProduct = Math.abs(sharesRatio * epsRatio - 1);
    if (inverseProduct <= tolerance) {
      const niCurr = Number(curr?.netIncome);
      const niPrev = Number(prev?.netIncome);
      const niStable =
        Number.isFinite(niCurr) &&
        Number.isFinite(niPrev) &&
        Math.abs(niPrev) > 1e-6 &&
        Math.abs(niCurr / niPrev - 1) < 0.35;
      if (niStable === false) continue;
      return {
        flagged: true,
        sharesRatio,
        epsRatio,
        inverseProduct,
        currentPeriod: curr.periodEnd,
        priorPeriod: prev.periodEnd,
        netIncomeStable: niStable
      };
    }
  }
  return null;
}

function detectLikelyReverseSplit(quartersDesc, { tolerance = 0.25, minRatio = 4, epsFloor = 0.01 } = {}) {
  const series = [...(quartersDesc || [])].filter((q) => q && q.periodEnd);
  for (let i = 0; i < series.length - 1; i += 1) {
    const curr = series[i];
    const prev = series[i + 1];
    const sharesCurr = Number(curr?.sharesOutstanding ?? curr?.shares);
    const sharesPrev = Number(prev?.sharesOutstanding ?? prev?.shares);
    if (!Number.isFinite(sharesCurr) || !Number.isFinite(sharesPrev) || sharesCurr === 0) continue;
    const reverseRatio = sharesPrev / sharesCurr;
    if (!Number.isFinite(reverseRatio) || reverseRatio < minRatio) continue;
    const epsCurr = Number(curr?.epsBasic);
    const epsPrev = Number(prev?.epsBasic);
    if (
      !Number.isFinite(epsCurr) ||
      !Number.isFinite(epsPrev) ||
      epsCurr === 0 ||
      epsPrev === 0 ||
      Math.sign(epsCurr) !== Math.sign(epsPrev) ||
      Math.abs(epsCurr) < epsFloor ||
      Math.abs(epsPrev) < epsFloor
    ) {
      continue;
    }
    const epsRatio = epsCurr / epsPrev;
    const inverseProduct = Math.abs(epsRatio / reverseRatio - 1);
    if (inverseProduct <= tolerance) {
      const niCurr = Number(curr?.netIncome);
      const niPrev = Number(prev?.netIncome);
      const niStable =
        Number.isFinite(niCurr) &&
        Number.isFinite(niPrev) &&
        Math.abs(niPrev) > 1e-6 &&
        Math.abs(niCurr / niPrev - 1) < 0.35;
      if (niStable === false) continue;
      return {
        flagged: true,
        sharesRatio: reverseRatio,
        epsRatio,
        inverseProduct,
        currentPeriod: curr.periodEnd,
        priorPeriod: prev.periodEnd,
        netIncomeStable: niStable
      };
    }
  }
  return null;
}

function computeShareChangeWithSplitGuard(quartersDesc) {
  const series = [...(quartersDesc || [])]
    .filter((q) => q && q.periodEnd && Number.isFinite(q.sharesOutstanding ?? q.shares))
    .sort((a, b) => Date.parse(b.periodEnd) - Date.parse(a.periodEnd));
  const latest = series[0] || null;
  const prev = series[1] || null;
  const yearAgo = series.find(q => {
    const d1 = new Date(latest.periodEnd);
    const d2 = new Date(q.periodEnd);
    return Math.abs(d1 - d2 - 31536000000) < 2600000000; // ~365 days +/- 30 days
  }) || series[4] || null;
  const rawQoQ = pctChange(
    Number(latest?.sharesOutstanding ?? latest?.shares),
    Number(prev?.sharesOutstanding ?? prev?.shares)
  );
  const rawYoY = yearAgo
    ? pctChange(
      Number(latest?.sharesOutstanding ?? latest?.shares),
      Number(yearAgo?.sharesOutstanding ?? yearAgo?.shares)
    )
    : rawQoQ;
  const splitSignal = detectLikelySplit(series);
  const reverseSplitSignal = detectLikelyReverseSplit(series);
  let adjustedYoY = rawYoY;
  const ratioFromSignal = splitSignal?.sharesRatio ?? null;
  if (ratioFromSignal && ratioFromSignal >= 2 && rawYoY != null) {
    adjustedYoY = null; // treat as split-driven jump; skip dilution penalty
  }
  if (reverseSplitSignal && rawYoY != null) {
    // Reverse splits can look like buybacks; neutralize change to avoid +score credits.
    adjustedYoY = null;
  }
  return {
    changeQoQ: rawQoQ,
    changeYoY: adjustedYoY,
    rawYoY,
    splitSignal,
    reverseSplitSignal
  };
}

// ---------- Rating helpers (shared-rule pipeline on the server) ----------
// Recommended normalization: wider bounds to avoid easy 100/100 scores.
const RATING_MIN = -60; // Captures truly distressed companies
const RATING_MAX = 100; // Reserves 100/100 for near-perfect execution
const RATING_RANGE = RATING_MAX - RATING_MIN || 1;

function normalizeRuleScore(score) {
  const num = Number(score);
  if (!Number.isFinite(num)) return null;

  const normalized = ((num - RATING_MIN) / RATING_RANGE) * 100;
  return Math.round(Math.max(0, Math.min(100, normalized)));
}

function getScoreBand(val) {
  const v = Number(val) || 0;
  if (v >= 90) return "elite";
  if (v >= 75) return "bullish";
  if (v >= 60) return "solid";
  if (v >= 40) return "mixed";
  return "danger";
}

function pctChange(curr, prev) {
  if (!Number.isFinite(curr) || !Number.isFinite(prev) || prev === 0) return null;
  return ((curr - prev) / Math.abs(prev)) * 100;
}

function calcMargin(num, den) {
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) return null;
  return (num / den) * 100;
}

function calcFcf(row) {
  if (!row) return null;
  const cfo = Number(row.netCashProvidedByOperatingActivities ?? row.operatingCashFlow);
  const capex = Number(row.capitalExpenditure ?? row.capex);
  if (!Number.isFinite(cfo) || !Number.isFinite(capex)) return null;
  return cfo + capex;
}

const toNumber = (val) => {
  const num = percentToNumber(val);
  return num === null ? null : num;
};

const pctFromRatio = (val) => {
  const num = percentToNumber(val);
  if (num === null) return null;
  return Math.abs(num) <= 1 ? num * 100 : num;
};

function computeRunwayYearsVm(vm) {
  if (!vm) return null;
  const sectorBucket = resolveSectorBucket(vm?.sector || vm?.sectorBucket);
  if (sectorBucket === "Financials") return null; // Lending cash flows distort runway math
  const series = (vm.quarterlySeries && vm.quarterlySeries.length ? vm.quarterlySeries : vm.annualSeries || []);
  const latest = [...series]
    .sort((a, b) => Date.parse(b.periodEnd) - Date.parse(a.periodEnd))[0] || {};

  const cash = toNumber(latest.cash ?? latest.cashAndCashEquivalents);
  const sti = toNumber(latest.shortTermInvestments);

  // If both are missing (null), and we have no other balance sheet data, return null.
  // We used to fallback if TotalAssets existed, but that leads to Cash=0 assumption which is wrong.
  if (cash === null && sti === null) return null;

  const cashTotal = (Number.isFinite(cash) ? cash : 0) + (Number.isFinite(sti) ? sti : 0);
  const fcf = toNumber(vm.snapshot?.freeCashFlowTTM ?? vm.ttm?.freeCashFlow);

  if (!Number.isFinite(cashTotal)) return null;

  // Infinite runway cases
  if (Number.isFinite(fcf) && fcf >= 0) return Infinity; // Burn is 0 or positive cash flow

  // If FCF is missing but we are profitable (net income > 0), assume infinite runway
  const ni = toNumber(vm.ttm?.netIncome);
  if (!Number.isFinite(fcf) && Number.isFinite(ni) && ni > 0) return Infinity;

  if (Number.isFinite(fcf) && fcf < 0) {
    if (cashTotal <= 0) return 0; // No cash left
    return cashTotal / Math.abs(fcf);
  }

  return null;
}

function calcTrend(quarters, field) {
  if (!quarters || quarters.length < 2) return null;
  // Assumes quarters are ASCENDING (oldest -> newest)
  const latestQ = quarters[quarters.length - 1];
  // Find same quarter last year
  const priorY = quarters.find(q => {
    const d1 = new Date(latestQ.periodEnd);
    const d2 = new Date(q.periodEnd);
    return Math.abs(d1 - d2 - 31536000000) < 2600000000; // rough 1 year check
  });

  if (!priorY) return null;

  if (!isFiniteValue(latestQ[field]) || !isFiniteValue(priorY[field])) return null;
  const valNow = Number(latestQ[field]);
  const valPrior = Number(priorY[field]);

  if (!Number.isFinite(valNow) || !Number.isFinite(valPrior) || valPrior === 0) return null;
  return (valNow - valPrior) / Math.abs(valPrior);
}

function buildStockForRules(vm) {
  const series = (vm.quarterlySeries && vm.quarterlySeries.length ? vm.quarterlySeries : vm.annualSeries || []);
  const annualMode = vm?.annualMode === true || vm?.snapshot?.basis === "annual";
  const quartersAsc = [...series].sort((a, b) => Date.parse(a.periodEnd) - Date.parse(b.periodEnd));
  const quartersDesc = [...quartersAsc].reverse();
  const income = quartersDesc.map((q) => ({
    date: q.periodEnd,
    revenue: q.revenue,
    grossProfit: q.grossProfit,
    costOfRevenue: q.costOfRevenue,
    operatingIncome: q.operatingIncome,
    operatingExpenses: q.operatingExpenses,
    netIncome: q.netIncome,
    researchAndDevelopmentExpenses: q.researchAndDevelopmentExpenses,
    interestIncome: q.interestIncome,
    interestAndDividendIncome: q.interestAndDividendIncome,
    interestExpense: q.interestExpense,
    technologyExpenses: q.technologyExpenses,
    softwareExpenses: q.softwareExpenses,
    depreciationDepletionAndAmortization: q.depreciationDepletionAndAmortization,
    eps: q.epsBasic,
    epsdiluted: q.epsBasic,
    epsDiluted: q.epsBasic
  }));
  const balance = quartersDesc.map((q) => ({
    date: q.periodEnd,
    cashAndCashEquivalents: q.cash ?? q.cashAndCashEquivalents,
    totalDebt: q.totalDebt,
    financialDebt: q.financialDebt,
    shortTermDebt: q.shortTermDebt,
    longTermDebt: q.longTermDebt,
    leaseLiabilities: q.leaseLiabilities,
    totalStockholdersEquity: q.totalEquity,
    totalAssets: q.totalAssets,
    totalLiabilities: q.totalLiabilities,
    currentAssets: q.currentAssets,
    currentLiabilities: q.currentLiabilities,
    commonStockSharesOutstanding: q.sharesOutstanding,
    shortTermInvestments: q.shortTermInvestments,
    accountsReceivable: q.accountsReceivable,
    deferredRevenue: q.deferredRevenue,
    contractWithCustomerLiability: q.contractWithCustomerLiability,
    deposits: q.deposits,
    customerDeposits: q.customerDeposits,
    totalDeposits: q.totalDeposits,
    depositLiabilities: q.depositLiabilities,
    interestExpense: q.interestExpense ?? null
  }));
  const cashArr = quartersDesc.map((q) => ({
    date: q.periodEnd,
    netCashProvidedByOperatingActivities: q.operatingCashFlow,
    operatingCashFlow: q.operatingCashFlow,
    capitalExpenditure: q.capex,
    freeCashFlow: q.freeCashFlow,
    depreciationDepletionAndAmortization: q.depreciationDepletionAndAmortization,
    treasuryStockRepurchased: q.treasuryStockRepurchased,
    dividendsPaid: q.dividendsPaid,
    fcfComputed:
      q.freeCashFlow != null
        ? q.freeCashFlow
        : q.operatingCashFlow != null && q.capex != null
          ? q.operatingCashFlow - Math.abs(q.capex ?? 0)
          : null
  }));
  // EDGAR can include period-tagged "as-of" rows (often shares-only) that should not drive growth/margin rules.
  // Use the latest *valid* rows for each statement rather than assuming adjacent indices match.
  const incomeValid = income.filter((i) =>
    Number.isFinite(i.revenue) || Number.isFinite(i.operatingIncome) || Number.isFinite(i.netIncome)
  );
  const balanceValid = balance.filter((b) =>
    Number.isFinite(b.totalAssets) || Number.isFinite(b.totalDebt) || Number.isFinite(b.cashAndCashEquivalents)
  );
  const cashValid = cashArr.filter((c) =>
    Number.isFinite(c.operatingCashFlow) || Number.isFinite(c.capitalExpenditure) || Number.isFinite(c.fcfComputed)
  );

  const curInc = incomeValid[0] || {};
  const prevInc = incomeValid[1] || {};
  const curBal = balanceValid[0] || {};
  const prevBal = balanceValid[1] || {};
  const curCf = cashValid[0] || {};
  const prevCf = cashValid[1] || {};

  // If EDGAR includes "as-of" placeholder periods (often shares-only), incomeValid[0] may not align to index 0.
  // Keep the index aligned to the underlying series so any statement-level metrics use the same period row.
  const effectiveIncIndex = (() => {
    const idx = income.indexOf(curInc);
    return idx >= 0 ? idx : 0;
  })();

  const shareChangeMeta = computeShareChangeWithSplitGuard(quartersDesc);
  const interestCoverageMeta = annualMode
    ? computeInterestCoverageAnnual(quartersDesc[effectiveIncIndex] || null)
    : computeInterestCoverageTtm(quartersDesc);
  const revGrowth = pctChange(toNumber(curInc.revenue), toNumber(prevInc.revenue));
  const sharesChange = shareChangeMeta.changeQoQ;
  const sharesChangeYoY = shareChangeMeta.changeYoY;
  const fcf = calcFcf(curCf);
  const ttmRevenue = toNumber(vm?.ttm?.revenue);
  const ttmFcf = toNumber(vm?.ttm?.freeCashFlow);
  const ttmNetIncome = toNumber(vm?.ttm?.netIncome);
  const annualizedRevenue =
    !annualMode && Number.isFinite(toNumber(curInc.revenue)) ? toNumber(curInc.revenue) * 4 : null;
  const annualizedFcf = !annualMode && Number.isFinite(fcf) ? fcf * 4 : null;
  const annualizedNetIncome =
    !annualMode && Number.isFinite(toNumber(curInc.netIncome)) ? toNumber(curInc.netIncome) * 4 : null;
  const sumAbsLast4 = (field) => {
    if (!quartersAsc || quartersAsc.length < 4) return null;
    const latest4 = quartersAsc.slice(-4);
    let used = 0;
    let acc = 0;
    for (const q of latest4) {
      const v = Number(q?.[field]);
      if (!Number.isFinite(v)) continue;
      used += 1;
      acc += Math.abs(v);
    }
    return used ? acc : null;
  };
  const buybacksTtm = sumAbsLast4("treasuryStockRepurchased");
  const dividendsTtm = sumAbsLast4("dividendsPaid");
  const shareholderReturnTtm =
    Number.isFinite(buybacksTtm) || Number.isFinite(dividendsTtm)
      ? (Number.isFinite(buybacksTtm) ? buybacksTtm : 0) + (Number.isFinite(dividendsTtm) ? dividendsTtm : 0)
      : null;
  const buybacksPctFcf =
    Number.isFinite(buybacksTtm) && Number.isFinite(ttmFcf) && ttmFcf > 0 ? buybacksTtm / ttmFcf : null;
  const totalReturnPctFcf =
    Number.isFinite(shareholderReturnTtm) && Number.isFinite(ttmFcf) && ttmFcf > 0
      ? shareholderReturnTtm / ttmFcf
      : null;
  const rdSpendTtm = sumAbsLast4("researchAndDevelopmentExpenses");
  const rdToRevenueTtm = Number.isFinite(rdSpendTtm) && Number.isFinite(ttmRevenue) && ttmRevenue !== 0
    ? (rdSpendTtm / ttmRevenue) * 100
    : null;
  const ar = toNumber(curBal.accountsReceivable);
  const inv = toNumber(curBal.inventories);
  const ap = toNumber(curBal.accountsPayable);
  const cogsTtm = (() => {
    const rev = toNumber(vm?.ttm?.revenue);
    const gp = toNumber(vm?.ttm?.grossProfit);
    if (Number.isFinite(rev) && Number.isFinite(gp)) return rev - gp;
    return null;
  })();
  const dsoDays =
    Number.isFinite(ar) && Number.isFinite(ttmRevenue) && ttmRevenue > 0 ? (ar / ttmRevenue) * 365 : null;
  const dioDays =
    Number.isFinite(inv) && Number.isFinite(cogsTtm) && cogsTtm > 0 ? (inv / cogsTtm) * 365 : null;
  const dpoDays =
    Number.isFinite(ap) && Number.isFinite(cogsTtm) && cogsTtm > 0 ? (ap / cogsTtm) * 365 : null;
  const cashConversionCycleDays =
    Number.isFinite(dsoDays) && Number.isFinite(dpoDays)
      ? dsoDays + (Number.isFinite(dioDays) ? dioDays : 0) - dpoDays
      : null;
  const effectiveTaxRateTTM = inferTaxRateFromPeriods({ ttm: vm?.ttm, latestAnnual: null });
  const operatingLeverage = (() => {
    const op = toNumber(vm?.ttm?.operatingIncome);
    const gp = toNumber(vm?.ttm?.grossProfit);
    if (!Number.isFinite(op) || !Number.isFinite(gp) || gp === 0) return null;
    return op / gp;
  })();

  const fcfMarginTtmPct =
    Number.isFinite(ttmFcf) && Number.isFinite(ttmRevenue) && ttmRevenue !== 0
      ? (ttmFcf / ttmRevenue) * 100
      : null;
  const fcfMargin = fcfMarginTtmPct ?? calcMargin(fcf, toNumber(curInc.revenue));
  const prevFcf = calcFcf(prevCf);
  const prevFcfMargin = prevCf ? calcMargin(prevFcf, toNumber(prevInc.revenue)) : null;
  const profitGrowth =
    calcTrend(quartersAsc, "netIncome") ?? pctChange(toNumber(curInc.netIncome), toNumber(prevInc.netIncome));
  const fcfTrend = pctChange(fcfMargin, prevFcfMargin);
  const periodToAnnualMultiplier = annualMode ? 1 : 4;
  const debtTotal = (() => {
    const totalDebt = toNumber(curBal.totalDebt);
    const finDebt = toNumber(curBal.financialDebt);
    const stDebt = toNumber(curBal.shortTermDebt);
    const lease = toNumber(curBal.leaseLiabilities);
    const parts = [finDebt, stDebt, lease].filter((v) => Number.isFinite(v));
    const partsSum = parts.length ? parts.reduce((acc, v) => acc + Number(v), 0) : null;
    if (Number.isFinite(totalDebt) && Number.isFinite(partsSum)) return Math.max(totalDebt, partsSum);
    return Number.isFinite(totalDebt) ? totalDebt : partsSum;
  })();
  const fcfYears =
    fcf && Number.isFinite(debtTotal) && fcf > 0
      ? debtTotal / (fcf * periodToAnnualMultiplier)
      : null;
  const roe = (() => {
    const ni = Number.isFinite(ttmNetIncome) ? ttmNetIncome : annualMode ? toNumber(curInc.netIncome) : annualizedNetIncome;
    const eq = toNumber(curBal.totalStockholdersEquity);
    if (!Number.isFinite(ni) || !Number.isFinite(eq) || eq === 0) return null;
    return (ni / eq) * 100;
  })();
  const taxRate = inferTaxRateFromPeriods({ ttm: vm?.ttm, latestAnnual: vm?.annualSeries?.[0] });
  const ebitTtm = toNumber(vm?.ttm?.operatingIncome);
  const nopatTtm =
    Number.isFinite(ebitTtm)
      ? ebitTtm * (1 - (taxRate ?? 0.21))
      : null;
  const debtForIc = (b) => {
    const totalDebt = toNumber(b?.totalDebt);
    const finDebt = toNumber(b?.financialDebt);
    const stDebt = toNumber(b?.shortTermDebt);
    const lease = toNumber(b?.leaseLiabilities);
    const parts = [finDebt, stDebt, lease].filter((v) => Number.isFinite(v));
    const partsSum = parts.length ? parts.reduce((acc, v) => acc + Number(v), 0) : null;
    if (Number.isFinite(totalDebt) && Number.isFinite(partsSum)) return Math.max(totalDebt, partsSum);
    if (Number.isFinite(totalDebt)) return totalDebt;
    return Number.isFinite(partsSum) ? partsSum : null;
  };
  const investedCapitalForBal = (b) => {
    const eq = toNumber(b?.totalStockholdersEquity);
    const debt = debtForIc(b);
    const cash = toNumber(b?.cashAndCashEquivalents);
    const sti = toNumber(b?.shortTermInvestments);
    if (!Number.isFinite(eq) || !Number.isFinite(debt) || !Number.isFinite(cash)) return null;
    return eq + debt - cash - (Number.isFinite(sti) ? sti : 0);
  };
  const investedCapitalNow = investedCapitalForBal(curBal);
  const investedCapitalPrev = investedCapitalForBal(prevBal);
  const avgInvestedCapital =
    Number.isFinite(investedCapitalNow) && Number.isFinite(investedCapitalPrev)
      ? (investedCapitalNow + investedCapitalPrev) / 2
      : investedCapitalNow ?? investedCapitalPrev ?? null;
  const roic = (() => {
    if (!Number.isFinite(nopatTtm) || !Number.isFinite(avgInvestedCapital) || avgInvestedCapital === 0) return null;
    return (nopatTtm / avgInvestedCapital) * 100;
  })();
  const interestCoverage =
    interestCoverageMeta.value != null
      ? interestCoverageMeta.value
      : (() => {
        const ttmOpInc = toNumber(vm?.ttm?.operatingIncome);
        const latestAnnual = Array.isArray(vm?.annualSeries)
          ? [...vm.annualSeries]
            .filter((p) => String(p?.periodType || "").toLowerCase() === "year" && p?.periodEnd)
            .sort((a, b) => Date.parse(b.periodEnd) - Date.parse(a.periodEnd))[0] || null
          : null;
        const annualInterest = toNumber(latestAnnual?.interestExpense);
        if (Number.isFinite(ttmOpInc) && Number.isFinite(annualInterest) && annualInterest !== 0) {
          return ttmOpInc / Math.abs(annualInterest);
        }
        const quarterInterest = toNumber(curBal.interestExpense);
        if (Number.isFinite(ttmOpInc) && Number.isFinite(quarterInterest) && quarterInterest !== 0) {
          return ttmOpInc / Math.abs(quarterInterest * 4);
        }
        return vm?.snapshot?.interestCoverage ?? null;
      })();
  const capexToRev = calcMargin(toNumber(curCf.capitalExpenditure), toNumber(curInc.revenue));
  const grossMargin = (() => {
    const gpTtm = toNumber(vm?.ttm?.grossProfit);
    const revTtm = toNumber(vm?.ttm?.revenue);
    const ttm = calcMargin(gpTtm, revTtm);
    if (ttm != null) return ttm;
    return calcMargin(toNumber(curInc.grossProfit), toNumber(curInc.revenue));
  })();
  const opMargin = (() => {
    const opTtm = toNumber(vm?.ttm?.operatingIncome);
    const revTtm = toNumber(vm?.ttm?.revenue);
    const ttm = calcMargin(opTtm, revTtm);
    if (ttm != null) return ttm;
    return calcMargin(toNumber(curInc.operatingIncome), toNumber(curInc.revenue));
  })();
  const prevOpMargin = calcMargin(Number(prevInc.operatingIncome), Number(prevInc.revenue));
  // Use percentage-points change (not % change of a %), to avoid extreme swings at low margins.
  const marginTrend = Number.isFinite(opMargin) && Number.isFinite(prevOpMargin) ? opMargin - prevOpMargin : null;
  const netMargin = (() => {
    const niTtm = Number.isFinite(ttmNetIncome) ? ttmNetIncome : null;
    const revTtm = toNumber(vm?.ttm?.revenue);
    const ttm = calcMargin(niTtm, revTtm);
    if (ttm != null) return ttm;
    return calcMargin(toNumber(curInc.netIncome), toNumber(curInc.revenue));
  })();
  // Check for mismatched reporting periods (Income vs Balance Sheet)
  const incomeDate = curInc.date ? new Date(curInc.date) : null;
  const balanceDate = curBal.date ? new Date(curBal.date) : null;
  // Use a 65-day tolerance (allows for same-quarter alignment even if dates slightly drift, but flags mixed quarters)
  const temporalMismatch = incomeDate && balanceDate && Math.abs(incomeDate - balanceDate) > 65 * 24 * 60 * 60 * 1000;

  const dataQuality = {
    mismatchedPeriods: temporalMismatch,
    incomeDate: curInc.date,
    balanceDate: curBal.date,
    defaultsUsed: [],
    inferredValues: [],
    materialMismatches: []
  };

  if (temporalMismatch) {
    dataQuality.materialMismatches.push({
      metric: "Financial Position",
      issue: "Statement Mismatch",
      details: `Income statement (${curInc.date}) and Balance Sheet (${curBal.date}) are from different periods.`,
      severity: "material"
    });
  }

  const daysSinceReport = incomeDate ? (Date.now() - incomeDate) / (1000 * 60 * 60 * 24) : null;
  if (daysSinceReport && daysSinceReport > 180) {
    dataQuality.materialMismatches.push({
      metric: "Financials",
      issue: "Stale Data",
      details: `Latest income statement is ${Math.round(daysSinceReport)} days old.`,
      severity: "material"
    });
  }

  const netDebt = (() => {
    const cashBal = toNumber(curBal.cashAndCashEquivalents);
    const stiBal = toNumber(curBal.shortTermInvestments);
    const debtBal = debtTotal;
    if (!Number.isFinite(debtBal)) return null;
    const cashKnown = Number.isFinite(cashBal);
    const stiKnown = Number.isFinite(stiBal);
    const cashTotal = (cashKnown ? cashBal : 0) + (stiKnown ? stiBal : 0);

    if (!cashKnown && !stiKnown) {
      if (debtBal === 0) {
        dataQuality.defaultsUsed.push({ field: "netDebt", reason: "Net debt treated as zero due to no reported debt", value: 0 });
        return 0;
      }
      return null;
    }
    return debtBal - cashTotal;
  })();
  const debtToEquity = toNumber(
    Number.isFinite(debtTotal) && curBal.totalStockholdersEquity
      ? debtTotal / curBal.totalStockholdersEquity
      : null
  );
  const netDebtToEquity =
    Number.isFinite(netDebt) && Number.isFinite(toNumber(curBal.totalStockholdersEquity))
      ? netDebt / toNumber(curBal.totalStockholdersEquity)
      : debtToEquity;


  const lastClose = vm?.priceSummary?.lastClose != null ? Number(vm.priceSummary.lastClose) : null;
  const marketCap = vm?.snapshot?.marketCap != null ? Number(vm.snapshot.marketCap) : (lastClose != null && curBal.commonStockSharesOutstanding != null ? lastClose * curBal.commonStockSharesOutstanding : null);
  const revenueForValuation =
    annualMode
      ? toNumber(curInc.revenue)
      : Number.isFinite(ttmRevenue)
        ? ttmRevenue
        : annualizedRevenue;
  const fcfForValuation =
    annualMode
      ? Number.isFinite(fcf) ? fcf : null
      : Number.isFinite(ttmFcf)
        ? ttmFcf
        : annualizedFcf;
  const netIncomeForValuation = annualMode
    ? toNumber(curInc.netIncome)
    : Number.isFinite(ttmNetIncome)
      ? ttmNetIncome
      : annualizedNetIncome;

  return {
    ticker: vm.ticker,
    companyName: vm.companyName,
    sector: vm.sector,
    sic: vm.sic ?? vm.snapshot?.sic,
    sicDescription: vm.sicDescription ?? vm.snapshot?.sicDescription,
    marketCap,
    sectorBucket: resolveSectorBucket(vm.sector),
    growth: {
      // Store growth fields as percent (not ratios), to align with the rest of the model and UI thresholds.
      revenueGrowthTTM: (() => {
        const trendRatio = calcTrend(quartersAsc, "revenue");
        if (trendRatio == null) return revGrowth;
        return trendRatio * 100;
      })(),
      revenueCagr3y: pctFromRatio(vm?.snapshot?.revenueCAGR3Y ?? vm?.growth?.revenueCagr3y),
      epsCagr3y: pctFromRatio(vm?.growth?.epsCagr3y),
      perShareGrowth: null
    },
    momentum: {
      marginTrend,
      fcfTrend,
      grossMarginPrev: null,
      burnTrend: calcTrend(quartersAsc, 'freeCashFlow'),
      rndTrend: calcTrend(quartersAsc, 'researchAndDevelopmentExpenses'),
      revenueTrend: calcTrend(quartersAsc, 'revenue'),
      sgaTrend: calcTrend(quartersAsc, 'sellingGeneralAndAdministrativeExpenses')
    },
    profitGrowthTTM: profitGrowth,
    stability: { growthYearsCount: null, fcfPositiveYears: cashArr.filter((r) => calcFcf(r) > 0).length },
    profitMargins: {
      grossMargin,
      operatingMargin: opMargin,
      profitMargin: netMargin,
      operatingLeverage,
      fcfMargin,
      netIncome: Number.isFinite(ttmNetIncome) ? ttmNetIncome : annualMode ? toNumber(curInc.netIncome) : annualizedNetIncome
    },
    revenueLatest: toNumber(curInc.revenue),
    revenueTtm: toNumber(vm.ttm?.revenue),
    financialPosition: {
      currentRatio: null,
      quickRatio: null,
      debtToEquity,
      netDebtToEquity,
      debtToEbitda: null,
      debtToFCF: null,
      interestCoverage,
      interestCoverageStatus: interestCoverageMeta.status ?? null,
      interestCoveragePeriods: interestCoverageMeta.periods ?? null,
      dsoDays,
      cashConversionCycleDays,
      netDebtToFcfYears:
        Number.isFinite(vm?.snapshot?.netDebtToFcfYears)
          ? vm.snapshot.netDebtToFcfYears
          : (netDebt != null && Number.isFinite(fcfForValuation) && fcfForValuation > 0
            ? netDebt / fcfForValuation
            : fcfYears),
      netCashToPrice: null,
      runwayYears: computeRunwayYearsVm(vm),
      totalDebt: Number.isFinite(debtTotal) ? debtTotal : curBal.totalDebt,
      financialDebt: curBal.financialDebt,
      leaseLiabilities: curBal.leaseLiabilities,
      shortTermDebt: curBal.shortTermDebt,
      longTermDebt: curBal.longTermDebt,
      totalAssets: curBal.totalAssets,
      currentAssets: curBal.currentAssets,
      currentLiabilities: curBal.currentLiabilities,
      cash: curBal.cashAndCashEquivalents,
      accountsReceivable: curBal.accountsReceivable,
      inventories: curBal.inventories,
      accountsPayable: curBal.accountsPayable,
      interestExpense: curBal.interestExpense,
      debtReported: Number.isFinite(curBal.totalDebt),
      cashReported: Number.isFinite(curBal.cashAndCashEquivalents) || Number.isFinite(curBal.cash),
      netDebtAssumedZeroCash: !Number.isFinite(curBal.cashAndCashEquivalents) && !Number.isFinite(curBal.shortTermInvestments) && Number.isFinite(curBal.totalDebt),
      debtIsZero: Number.isFinite(curBal.totalDebt) && curBal.totalDebt === 0
    },
    returns: { roe, roic },
    cash: {
      cashConversion:
        fcf != null && toNumber(curInc.netIncome) ? fcf / toNumber(curInc.netIncome) : null,
      capexToRevenue: capexToRev,
      shareBuybacksTTM: buybacksTtm,
      dividendsPaidTTM: dividendsTtm,
      shareholderReturnTTM: shareholderReturnTtm,
      buybacksPctFcf,
      totalReturnPctFcf,
      freeCashFlowTTM: ttmFcf
    },
    taxes: { effectiveTaxRateTTM },
    shareStats: {
      sharesOutstanding: curBal.commonStockSharesOutstanding,
      sharesChangeYoY,
      sharesChangeQoQ: sharesChange,
      sharesChangeYoYRaw: shareChangeMeta.rawYoY,
      likelySplit: !!shareChangeMeta.splitSignal,
      likelyReverseSplit: !!shareChangeMeta.reverseSplitSignal,
      insiderOwnership: toNumber(vm?.snapshot?.heldPercentInsiders),
      institutionOwnership: null,
      float: null
    },
    valuationRatios: {
      peRatio:
        (() => {
          const eps = Number(vm?.ttm?.epsBasic);
          if (lastClose != null && Number.isFinite(eps) && eps > 0) return lastClose / eps;
          // Fallback: infer P/E from market cap and net income if EPS is missing/incomplete.
          if (marketCap != null && Number.isFinite(netIncomeForValuation) && netIncomeForValuation > 0) {
            return marketCap / netIncomeForValuation;
          }
          return null;
        })(),
      forwardPE: null,
      psRatio:
        marketCap != null && Number.isFinite(revenueForValuation) && revenueForValuation > 0
          ? marketCap / revenueForValuation
          : null,
      forwardPS: null,
      pbRatio:
        lastClose != null &&
          curBal.totalStockholdersEquity &&
          curBal.commonStockSharesOutstanding
          ? lastClose /
          (curBal.totalStockholdersEquity / curBal.commonStockSharesOutstanding)
          : null,
      pfcfRatio:
        marketCap != null && Number.isFinite(fcfForValuation) && fcfForValuation > 0
          ? marketCap / fcfForValuation
          : null,
      pegRatio: null,
      evToEbitda: null,
      fcfYield:
        marketCap != null && Number.isFinite(fcfForValuation)
          ? fcfForValuation / marketCap
          : null
    },
    expenses: {
      rdToRevenue: calcMargin(
        Number.isFinite(rdSpendTtm) ? rdSpendTtm : toNumber(curInc.researchAndDevelopmentExpenses),
        Number.isFinite(ttmRevenue) ? ttmRevenue : toNumber(curInc.revenue)
      ),
      rdSpend: Number.isFinite(rdSpendTtm) ? rdSpendTtm : toNumber(curInc.researchAndDevelopmentExpenses),
      rdSpendTTM: rdSpendTtm,
      rdToRevenueTTM: rdToRevenueTtm,
      revenue: Number.isFinite(ttmRevenue) ? ttmRevenue : toNumber(curInc.revenue)
    },
    capitalReturns: { shareholderYield: null, totalYield: null },
    dividends: { payoutToFcf: null, growthYears: null },
    priceStats: {}, // decouple rating from price-derived momentum while price worker is beta
    scores: { altmanZ: null, piotroskiF: null },
    ownerEarnings: null,
    ownerIncomeBase: Number.isFinite(ttmNetIncome) ? ttmNetIncome : annualMode ? toNumber(curInc.netIncome) : annualizedNetIncome,
    lastUpdated: curInc.date || "n/a",
    dataQuality,
    // Arrays for time-series analysis in rules
    balance: balance,
    income: income,
    cashFlows: cashArr
  };
}

function detectClinicalSetbackSignal(filingSignals = [], sectorBucket) {
  const bucket = resolveSectorBucket(sectorBucket);
  if (bucket !== "Biotech/Pharma") return null;
  const isHiddenCard = (card) =>
    card?.hidden === true || card?.suppressed === true || card?.includeInScore === false;
  if (filingSignals.some((s) => s?.id === "clinical_negative" && !isHiddenCard(s))) return null;
  const patterns = [
    /failed?\s+to\s+(meet|achieve)\s+(the\s+)?primary\s+endpoint/i,
    /did\s+not\s+(meet|achieve)\s+(the\s+)?primary\s+endpoint/i,
    /did\s+not\s+demonstrate/i,
    /not\s+statistically\s+significant/i,
    /terminate(d)?\s+(the\s+)?(trial|study)/i,
    /halt(ed)?\s+(the\s+)?(trial|study)/i,
    /discontinue(d)?\s+(the\s+)?(trial|study)/i,
    /unsuccessful\s+(trial|study)/i,
    /negative\s+(topline|top-line)\s+results/i
  ];
  const match = (filingSignals || []).find((sig) => {
    if (isHiddenCard(sig)) return false;
    const text = `${sig?.title || ""} ${sig?.snippet || ""}`.toLowerCase();
    return patterns.some((rx) => rx.test(text));
  });
  if (!match) return null;
  return {
    id: "clinical_negative",
    title: "Clinical setback",
    score: -12,
    form: match.form || null,
    filed: match.filed || match.date || null,
    snippet: match.snippet || match.title || "Clinical outcome reported as unsuccessful."
  };
}

function detectBiotechEventRisk(priceHistory = [], sectorBucket, marketCap) {
  const bucket = resolveSectorBucket(sectorBucket);
  if (bucket !== "Biotech/Pharma") return null;
  const mc = Number(marketCap);
  if (!Number.isFinite(mc) || mc >= 1_000_000_000) return null; // small-cap focus
  const points = Array.isArray(priceHistory) ? priceHistory.slice() : [];
  if (points.length < 6) return null;
  const sorted = points.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const latest = sorted[sorted.length - 1];
  const fiveBack = sorted[sorted.length - 6];
  const lastClose = Number(latest?.close);
  const backClose = Number(fiveBack?.close);
  if (!Number.isFinite(lastClose) || !Number.isFinite(backClose) || backClose === 0) return null;
  const drop = (lastClose - backClose) / Math.abs(backClose);
  if (drop <= -0.3) {
    return {
      dropPct: drop * 100,
      capNormalizedTo: 35,
      note: `Event risk: ${drop * 100 < -99 ? -99 : (drop * 100).toFixed(0)}% move over 5 trading days; capped rating.`
    };
  }
  return null;
}

function computeRuleRating({
  ticker,
  sector,
  quarterlySeries,
  annualSeries,
  annualMode,
  snapshot,
  ttm,
  priceSummary,
  priceHistory,
  growth,
  filingSignals,
  projections,
  issuerType
}) {
  const seriesForRules = Array.isArray(quarterlySeries) ? quarterlySeries : [];
  const seriesBasisLabel = annualMode ? "Annual" : "Quarterly";
  const seriesAsc = sortByPeriodEndAsc(seriesForRules);
  // EDGAR can contain "instantaneous" quarter-tagged points (e.g., share counts) with a non-quarter end date.
  // Exclude those placeholders for YoY and "latest period" selection so growth rules don't key off empty rows.
  const seriesAscForIncome = seriesAsc.filter(
    (p) => isFiniteValue(p?.revenue) || isFiniteValue(p?.operatingIncome) || isFiniteValue(p?.netIncome)
  );
  const latestSeries = seriesAscForIncome.at(-1) || seriesAsc.at(-1) || null;
  const yearAgoSeries =
    latestSeries?.periodEnd ? findComparableYearAgo(seriesAscForIncome, latestSeries.periodEnd) : null;
  const lastCloseDate = priceSummary?.lastCloseDate ?? null;
  const ttmQuarters = annualMode ? [] : lastNPeriods(seriesAscForIncome, 4);

  const basisMetaForRule = (ruleName) => {
    const ratioNorm = "Ratio/percent computed directly; no extrapolation.";
    const yoyNorm = "YoY change computed as (current - priorYear) / |priorYear|.";

    const simple = (timeBasis, components, normalizationApplied = null) => ({
      timeBasis,
      components,
      normalizationApplied
    });

    const incomeBasis = annualMode ? "Annual" : (ttm?.asOf ? "TTM" : "Annualized");
    const incomePeriodEnd = annualMode
      ? (latestSeries?.periodEnd ?? null)
      : (ttm?.asOf ?? latestSeries?.periodEnd ?? null);

    switch (ruleName) {
      case "Revenue growth YoY":
        return simple(
          seriesBasisLabel,
          [
            { field: "revenue", basis: seriesBasisLabel, periodEnd: latestSeries?.periodEnd ?? null },
            { field: "revenue", basis: seriesBasisLabel, periodEnd: yearAgoSeries?.periodEnd ?? null }
          ],
          yoyNorm
        );
      case "Shares dilution YoY":
        return simple(
          seriesBasisLabel,
          [
            { field: "sharesOutstanding", basis: seriesBasisLabel, periodEnd: latestSeries?.periodEnd ?? null },
            { field: "sharesOutstanding", basis: seriesBasisLabel, periodEnd: yearAgoSeries?.periodEnd ?? null }
          ],
          yoyNorm
        );
      case "Gross margin":
      case "Gross margin (industrial)":
      case "Gross margin (health)":
      case "Gross margin trend":
      case "Operating leverage":
      case "Capex intensity":
      case "R&D intensity":
      case "Dividend coverage":
        return simple(
          seriesBasisLabel,
          [{ field: ruleName, basis: seriesBasisLabel, periodEnd: latestSeries?.periodEnd ?? null }],
          ratioNorm
        );
      case "Capital Return":
        return simple(
          "TTM",
          [
            { field: "treasuryStockRepurchased", basis: "TTM", periodEnd: incomePeriodEnd },
            { field: "dividendsPaid", basis: "TTM", periodEnd: incomePeriodEnd },
            { field: "freeCashFlow", basis: "TTM", periodEnd: incomePeriodEnd }
          ],
          "Capital return = buybacks + dividends (TTM); scored as a % of TTM FCF."
        );
      case "Effective Tax Rate":
        return simple(
          "TTM",
          [
            { field: "incomeTaxExpenseBenefit", basis: "TTM", periodEnd: incomePeriodEnd },
            { field: "incomeBeforeIncomeTaxes", basis: "TTM", periodEnd: incomePeriodEnd }
          ],
          "ETR = income tax expense / pretax income (TTM); clamped to a reasonable range."
        );
      case "Working Capital":
        return simple(
          "Mixed",
          [
            { field: "accountsReceivable", basis: seriesBasisLabel, periodEnd: latestSeries?.periodEnd ?? null },
            { field: "inventories", basis: seriesBasisLabel, periodEnd: latestSeries?.periodEnd ?? null },
            { field: "accountsPayable", basis: seriesBasisLabel, periodEnd: latestSeries?.periodEnd ?? null },
            { field: "revenue", basis: incomeBasis, periodEnd: incomePeriodEnd },
            { field: "costOfRevenue", basis: incomeBasis, periodEnd: incomePeriodEnd }
          ],
          "DSO/DIO/DPO derived from balance sheet vs. TTM revenue/COGS; CCC = DSO + DIO - DPO."
        );
      case "FCF margin":
        return simple(
          incomeBasis === "Annual" ? "Annual" : "TTM",
          [
            { field: "freeCashFlow", basis: incomeBasis, periodEnd: incomePeriodEnd },
            { field: "revenue", basis: incomeBasis, periodEnd: incomePeriodEnd }
          ],
          incomeBasis === "Annualized" ? "FCF margin computed as (annualized FCF / annualized revenue)." : ratioNorm
        );
      case "Cash Runway (years)":
        return simple(
          "Mixed",
          [
            { field: "cash + shortTermInvestments", basis: seriesBasisLabel, periodEnd: latestSeries?.periodEnd ?? null },
            { field: "freeCashFlow", basis: incomeBasis, periodEnd: incomePeriodEnd }
          ],
          "Runway = (cash + short-term investments) / |FCF|; uses the latest period’s FCF as the burn-rate proxy."
        );
      case "Debt / Equity":
        return simple(
          seriesBasisLabel,
          [{ field: ruleName, basis: seriesBasisLabel, periodEnd: latestSeries?.periodEnd ?? null }],
          ratioNorm
        );
      case "Net Debt / FCF":
        return simple(
          "Mixed",
          [
            { field: "netDebt", basis: seriesBasisLabel, periodEnd: latestSeries?.periodEnd ?? null },
            { field: "freeCashFlow", basis: incomeBasis, periodEnd: incomePeriodEnd }
          ],
          incomeBasis === "Annualized" ? "FCF denominator annualized as (latest quarterly FCF * 4)." : ratioNorm
        );
      case "Interest coverage":
        return simple(
          incomeBasis === "Annual" ? "Annual" : "TTM",
          [
            { field: "operatingIncome", basis: incomeBasis === "Annual" ? "Annual" : "TTM", periodEnd: incomePeriodEnd },
            { field: "interestExpense", basis: incomeBasis === "Annual" ? "Annual" : "TTM", periodEnd: incomePeriodEnd }
          ],
          incomeBasis === "Annual" ? ratioNorm : `Computed from sum of up to the last ${ttmQuarters.length || "few"} quarters.`
        );
      case "ROE":
      case "ROE quality":
      case "ROIC":
      case "Return on Assets":
      case "Asset Efficiency":
        return simple(
          "Mixed",
          [
            { field: "netIncome", basis: incomeBasis, periodEnd: incomePeriodEnd },
            { field: "balanceSheet", basis: seriesBasisLabel, periodEnd: latestSeries?.periodEnd ?? null }
          ],
          incomeBasis === "Annualized"
            ? "Uses annualized net income (latest quarter * 4) against end-of-period balance sheet."
            : ratioNorm
        );
      case "Net income trend":
        return simple(
          seriesBasisLabel,
          [
            { field: "netIncome", basis: seriesBasisLabel, periodEnd: latestSeries?.periodEnd ?? null },
            { field: "netIncome", basis: seriesBasisLabel, periodEnd: yearAgoSeries?.periodEnd ?? null }
          ],
          yoyNorm
        );
      case "Price / Sales":
      case "Price / Earnings":
      case "Price / Book":
        return simple(
          "Mixed",
          [
            { field: "price", basis: "Price", periodEnd: lastCloseDate },
            { field: "sharesOutstanding", basis: seriesBasisLabel, periodEnd: latestSeries?.periodEnd ?? null },
            {
              field: ruleName === "Price / Book" ? "totalEquity" : ruleName === "Price / Earnings" ? "epsBasic" : "revenue",
              basis: ruleName === "Price / Book" ? seriesBasisLabel : incomeBasis,
              periodEnd: ruleName === "Price / Book" ? (latestSeries?.periodEnd ?? null) : incomePeriodEnd
            }
          ],
          ratioNorm
        );
      case "50d vs 200d trend":
      case "52w drawdown":
        return simple(
          "Mixed",
          [{ field: ruleName, basis: "Price", periodEnd: lastCloseDate }],
          "Computed from daily price history; no financial-statement time basis."
        );
      case "Revenue CAGR (3Y)":
      case "EPS CAGR (3Y)":
        return simple(
          "Annual",
          [{ field: ruleName, basis: "Annual", periodEnd: latestSeries?.periodEnd ?? null }],
          "CAGR uses annual points: (latest / 3-years-prior)^(1/3) - 1."
        );
      default:
        return simple(
          seriesBasisLabel,
          [{ field: ruleName, basis: seriesBasisLabel, periodEnd: latestSeries?.periodEnd ?? null }],
          null
        );
    }
  };

  const cleanDisclosureText = (text) => {
    if (text == null) return null;
    const s = String(text);
    // Fix common mojibake for curly apostrophe (’): "â€™"
    return s.replace(String.fromCharCode(0x00E2, 0x20AC, 0x2122), "'");
  };

  const stock = buildStockForRules({
    ticker,
    sector,
    quarterlySeries,
    annualSeries,
    annualMode,
    snapshot,
    ttm,
    priceSummary,
    growth
  });
  const sectorBucket = resolveSectorBucket(stock.sector);
  const lastClose = Number(stock.priceStats?.lastClose ?? priceSummary?.lastClose);
  const marketCap = Number(
    snapshot?.marketCap ?? stock?.marketCap
  );
  const bankruptcyRiskScore = projections?.bankruptcyRiskScore;
  const deteriorationLabel = projections?.deteriorationLabel;
  const dilutionYoY = percentToNumber(
    stock?.shareStats?.sharesChangeYoY ?? snapshot?.sharesOutChangeYoY
  );
  const runwayYears = stock.financialPosition.runwayYears;
  const fcfMargin = percentToNumber(stock?.profitMargins?.fcfMargin);
  const opMarginVal = percentToNumber(stock?.profitMargins?.operatingMargin);
  const profitMarginVal = percentToNumber(stock?.profitMargins?.profitMargin);
  const revenueGrowth = percentToNumber(stock?.growth?.revenueGrowthTTM);
  const isBio = sectorBucket === "Biotech/Pharma" || (sectorBucket === "Other" && stock.sector && stock.sector.toLowerCase().match(/bio|pharma|drug|therap/));
  const hasMicroCap = Number.isFinite(marketCap) && marketCap > 0 && marketCap < 200_000_000;
  const likelySplit = stock?.shareStats?.likelySplit || snapshot?.shareChangeLikelySplit;
  const likelyReverseSplit = stock?.shareStats?.likelyReverseSplit || snapshot?.shareChangeLikelyReverseSplit;
  // Safety check: if price data is missing (lastClose is 0/null), do NOT assume penny stock 
  // if fundamentals show large scale (> $2B Assets or > $1B Revenue).
  const totalAssets = Number(stock?.financialPosition?.totalAssets ?? 0);
  const totalRevenue = Number(stock?.expenses?.revenue ?? 0);
  const isLargeScale = totalAssets > 2_000_000_000 || totalRevenue > 1_000_000_000;

  const hasPennyPrice = Number.isFinite(lastClose) && lastClose < 5;
  const isDilutive = Number.isFinite(dilutionYoY) && dilutionYoY > 25;
  const isShortRunway = Number.isFinite(runwayYears) && runwayYears < 1;

  // If price is missing/invalid, assume NOT penny if Large Scale.
  // If price exists, use PennyPrice check.
  const priceCheck = Number.isFinite(lastClose) && lastClose > 0
    ? hasPennyPrice
    : !isLargeScale; // If price missing, default to Penny UNLESS large scale

  const pennyStock =
    (isBio && Number.isFinite(marketCap) && marketCap > 0 && marketCap < 50_000_000) ||
    (!isBio && (priceCheck || hasMicroCap)) ||
    (isDilutive && !isLargeScale) || // Large caps can utilize shelf offerings without being "penny stocks"
    (isShortRunway && !isLargeScale);

  const metrics = { metric1: 0, metric2: 0, metric3: 0 };

  // Critical rules that MUST be present for a valid score.
  const criticalRules = new Set([
    // Intentionally empty to prevent "Partial data" penalties
  ]);

  const reasons = [];
  let total = 0;
  let missingCritical = false;
  const missingNotes = [];
  let missingCount = 0;
  const overrideNotes = [];
  const criticalMissingFields = [];
  const missingCategories = {
    valuation: [],
    solvency: [],
    profitability: [],
    growth: [],
    other: []
  };

  const classifyMissing = (name) => {
    const n = name.toLowerCase();
    if (n.includes("price") || n.includes("pe") || n.includes("ps") || n.includes("valuation") || n.includes("ev/")) return "valuation";
    if (n.includes("debt") || n.includes("coverage") || n.includes("solvency") || n.includes("runway")) return "solvency";
    if (n.includes("margin") || n.includes("roe") || n.includes("roic") || n.includes("return") || n.includes("operating leverage")) return "profitability";
    if (n.includes("growth") || n.includes("trend") || n.includes("cagr")) return "growth";
    return "other";
  };
  const ratingDebug = process.env.RATING_DEBUG === "1";

  // ========== COMPANY TIER CLASSIFICATION ==========
  // Use both total assets AND market cap to classify company size.
  // This prevents penny stocks with inflated market caps from being mis-classified.
  const assetSize = toNumber(stock?.financialPosition?.totalAssets);
  const isMidCap = (
    Number.isFinite(assetSize) && assetSize >= 500e6 && assetSize < 10e9 &&
    Number.isFinite(marketCap) && marketCap >= 1e9 && marketCap < 10e9
  );
  const isLargeCap = (
    Number.isFinite(assetSize) && assetSize >= 10e9 ||
    Number.isFinite(marketCap) && marketCap >= 10e9
  );

  // ========== GROWTH STAGE FLAG ==========
  // Identify companies in aggressive investment/expansion phase.
  // These should NOT be penalized like failing penny stocks despite negative FCF.
  // Conservative approach: require ALL conditions to be true.
  const capexToRev = toNumber(stock?.cash?.capexToRevenue) ?? 0;
  const isGrowthStage = (
    !pennyStock &&  // Not a penny stock
    (isMidCap || isLargeCap) &&  // Has real scale
    Number.isFinite(revenueGrowth) && revenueGrowth > 40 &&  // Strong revenue growth (>40% YoY)
    Number.isFinite(fcfMargin) && fcfMargin < -10 &&  // Burning cash (investing, not just failing)
    (capexToRev > 30 || capexToRev < 0)  // Heavy capex OR negative revenue (infrastructure buildout)
  );

  if (ratingDebug && (isMidCap || isGrowthStage)) {
    console.log(`[TIER] ${ticker} | MidCap: ${isMidCap} | GrowthStage: ${isGrowthStage} | Assets: ${assetSize ? (assetSize / 1e9).toFixed(2) + 'B' : 'N/A'} | MCap: ${marketCap ? (marketCap / 1e9).toFixed(2) + 'B' : 'N/A'} | RevGrowth: ${Number.isFinite(revenueGrowth) ? revenueGrowth.toFixed(1) + '%' : 'N/A'} | FCFMargin: ${Number.isFinite(fcfMargin) ? fcfMargin.toFixed(1) + '%' : 'N/A'} | CapexToRev: ${Number.isFinite(capexToRev) ? capexToRev.toFixed(1) + '%' : 'N/A'}`);
  }

  const isHiddenCard = (card) =>
    card?.hidden === true || card?.suppressed === true || card?.includeInScore === false;
  const scoreableFilingSignals = (filingSignals || []).filter((s) => !isHiddenCard(s));
  const hasSpinoffSeparation = scoreableFilingSignals.some((s) => s?.id === "spinoff_separation");

  const sequentialRevenueRising = (() => {
    const revPoints = (seriesAsc || [])
      .filter((p) => Number.isFinite(Number(p?.revenue)))
      .map((p) => Number(p.revenue));
    if (revPoints.length < 2) return false;
    const latest = revPoints.at(-1);
    const prev = revPoints.at(-2);
    if (!Number.isFinite(latest) || !Number.isFinite(prev)) return false;
    return latest > prev;
  })();

  const filingsConfirmExpansionOrInvestment = (() => {
    const needles = [
      "expansion",
      "expand",
      "investment",
      "investing",
      "capacity",
      "buildout",
      "ramp",
      "capex",
      "capital expenditure",
      "data center",
      "facility",
      "new site"
    ];
    const idHints = new Set([
      "expansion_mode",
      "investment_mode",
      "capacity_expansion",
      "capex_ramp",
      "buildout",
      "aggressive_investment",
      "growth_investment"
    ]);
    return scoreableFilingSignals.some((s) => {
      const id = String(s?.id || "").toLowerCase();
      const title = String(s?.title || "").toLowerCase();
      const snippet = String(s?.snippet || "").toLowerCase();
      if (id && idHints.has(id)) return true;
      const hay = `${title} ${snippet}`;
      return needles.some((n) => hay.includes(n));
    });
  })();

  const burnRiskFlagged = Number.isFinite(fcfMargin) && fcfMargin < -10;
  const dilutionRiskFlagged = Number.isFinite(dilutionYoY) && dilutionYoY > 25;
  const waiveMissingGrowthPenalty =
    sequentialRevenueRising &&
    filingsConfirmExpansionOrInvestment &&
    burnRiskFlagged &&
    dilutionRiskFlagged;

  rules.forEach((rule) => {
    const outcome = rule.evaluate(stock, metrics);
    const baseScore = outcome?.score ?? 0;
    const sectorTuning = applySectorRuleAdjustments(rule.name, baseScore, sectorBucket);
    const score = sectorTuning?.score ?? baseScore;

    // Define skipped early so logging can use it
    let skipped = outcome?.missing || sectorTuning?.skipped;
    let notApplicable = outcome?.notApplicable || sectorTuning?.skipped;
    // EXPOSE DETAIL FOR DEBUGGING
    if (ratingDebug) {
      console.log(`[RULES] ${ticker} Rule: ${rule.name} | Score: ${score} | Msg: ${outcome?.message}`);
    }

    let appliedScore = score;
    let reasonMessage = outcome?.message || rule.name;
    const dilutionRule = rule.name === "Shares dilution YoY";
    const priceRule = rule.name === "52w drawdown" || rule.name === "50d vs 200d trend";

    // If we intentionally disable price-derived scoring, treat price rules as N/A instead of "missing".
    // This prevents silent -2 penalties when the price pipeline is intentionally decoupled.
    const priceScoringDisabled = !stock?.priceStats || Object.keys(stock.priceStats).length === 0;
    if (priceScoringDisabled && priceRule) {
      skipped = true;
      notApplicable = true;
      appliedScore = 0;
      reasonMessage = "Not applicable (price scoring disabled)";
    }

    if (pennyStock && rule.name === "Revenue growth YoY" && Number.isFinite(revenueGrowth) && revenueGrowth > 15) {
      // Adjustment: If growing from a tiny base (<$10M revenue), reduce score impact to avoid "fake growth" signals
      const rev = toNumber(stock.expenses?.revenue);
      if (rev && rev < 10_000_000) {
        appliedScore = Math.round(appliedScore / 2); // Halve the score
        reasonMessage = `${reasonMessage} - Early-Stage Surge (low base)`;
      } else {
        reasonMessage = `${reasonMessage} - Growth from a low base; sustainability uncertain.`;
      }
    }

    if (pennyStock && rule.name === "Shares dilution YoY" && Number.isFinite(dilutionYoY)) {
      if (dilutionYoY > 50 && !isBio) {
        // Only punish non-biotech heavy dilution with this clamp
        appliedScore = Math.min(appliedScore, -Math.max(12, Math.abs(rule.weight ?? 0)));
        reasonMessage = `${reasonMessage} - Heavy dilution suggests continuous equity raises; survival depends on external capital.`;
      }
      if (dilutionYoY > 100 && !isBio) {
        overrideNotes.push("Death Spiral Dilution Risk flagged (share count more than doubled YoY).");
      }
    }
    if (dilutionRule && likelySplit) {
      skipped = true;
      notApplicable = true;
      appliedScore = 0;
      reasonMessage = "Share count spike (likely split); dilution score skipped.";
      overrideNotes.push("Dilution score skipped due to likely share split.");
    } else if (dilutionRule && likelyReverseSplit) {
      const penalty = Math.max(10, Math.abs(rule.weight ?? 0));
      appliedScore = -penalty;
      const yoyText = Number.isFinite(dilutionYoY) ? ` (${dilutionYoY.toFixed(1)}% YoY)` : "";
      reasonMessage = `Share count collapsed (likely reverse split)${yoyText}; treated as dilution risk.`;
      overrideNotes.push("Reverse split detected; buyback credit removed and dilution penalty applied.");
    } else if (dilutionRule && Number.isFinite(dilutionYoY) && dilutionYoY < -40) {
      // Large negative change looks like buyback but is likely a reverse split; treat as dilution risk.
      const penalty = Math.max(10, Math.abs(rule.weight ?? 0));
      appliedScore = -penalty;
      reasonMessage = `Share count collapsed ~${dilutionYoY.toFixed(1)}% YoY (likely reverse split); no buyback credit.`;
      overrideNotes.push("Large share-count collapse treated as reverse split; buyback credit stripped.");
    }

    if (!skipped && hasSpinoffSeparation && appliedScore < 0) {
      const category = classifyMissing(rule.name);
      if (category === "growth") {
        const prior = appliedScore;
        appliedScore = Math.floor(appliedScore * 0.5);
        if (appliedScore !== prior) {
          reasonMessage = `${reasonMessage} (dampened due to spin-off/separation noted in filings).`;
        }
      }
    }

    // ========== MID-CAP & GROWTH STAGE PENALTY SOFTENING ==========
    // For mid-caps and growth-stage companies, soften harsh penalties that conflate
    // "distressed/failing" with "aggressive investment phase".
    if ((isMidCap || isGrowthStage) && appliedScore < 0) {
      const oldScore = appliedScore;
      let adjusted = false;

      // 1. FCF Margin: Progressive softening based on revenue growth intensity
      if (rule.name === "FCF margin") {
        if (isGrowthStage && appliedScore <= -8) {
          if (Number.isFinite(revenueGrowth) && revenueGrowth > 60) {
            // Hypergrowth (>60%): Cap at -4
            appliedScore = Math.max(appliedScore, -4);
            adjusted = true;
            reasonMessage = `${reasonMessage.split(' - ')[0]} - Hypergrowth expansion (${revenueGrowth.toFixed(0)}% revenue growth)`;
          } else {
            // Strong growth (>40%): Cap at -6
            appliedScore = Math.max(appliedScore, -6);
            adjusted = true;
            reasonMessage = `${reasonMessage.split(' - ')[0]} - Heavy capex deployment (growth investment phase)`;
          }
        }
      }

      // 2. Operating Leverage: Don't penalize during growth phase (efficiency comes later)
      if (rule.name === "Operating leverage" && isGrowthStage && appliedScore < 0) {
        appliedScore = 0;
        adjusted = true;
        notApplicable = true;
        reasonMessage = "Not applicable (expansion phase prioritizes scale over efficiency)";
      }

      // 3. Dilution: Cap penalty at -3 if dilution is < 100% for mid-caps
      if (rule.name === "Shares dilution YoY" && Number.isFinite(dilutionYoY) && dilutionYoY > 20 && dilutionYoY < 100 && isMidCap) {
        appliedScore = Math.max(appliedScore, -3);
        adjusted = true;
        reasonMessage = `${reasonMessage.split(' - ')[0]} - Likely growth financing (mid-cap expansion)`;
      }

      if (ratingDebug && adjusted) {
        console.log(`[SOFTEN] ${ticker} | ${rule.name}: ${oldScore} → ${appliedScore} (MidCap: ${isMidCap}, GrowthStage: ${isGrowthStage})`);
      }
    }

    // Fintech-specific softening (applies regardless of mid-cap/growth stage)
    if (rule.name === "Shares dilution YoY" && isFintech(stock) && Number.isFinite(dilutionYoY) && dilutionYoY > 0 && dilutionYoY < 15 && appliedScore < -2) {
      const oldScore = appliedScore;
      appliedScore = Math.max(appliedScore, -2);
      reasonMessage = `${reasonMessage.split(' - ')[0]} - Modest dilution (fintech scaling)`;
      if (ratingDebug) {
        console.log(`[SOFTEN-FINTECH] ${ticker} | ${rule.name}: ${oldScore} → ${appliedScore}`);
      }
    }

    if (!skipped) {
      total += appliedScore;
    } else {
      missingCategories[classifyMissing(rule.name)].push(rule.name);
      // If critical rule is missing, flag it but DO NOT apply penalty points.
      if (criticalRules.has(rule.name) && !notApplicable) {
        missingCritical = true;
        criticalMissingFields.push(rule.name);
      }

      if (!notApplicable) {
        // Missing but applicable -> do not penalize score (informational only).
        appliedScore = 0;
      } else {
        appliedScore = 0;
      }
    }
    if (skipped && !notApplicable) missingCount += 1;

    const basisMeta = basisMetaForRule(rule.name);
    reasons.push({
      name: rule.name,
      score: appliedScore,
      message: reasonMessage,
      missing: skipped,
      notApplicable,
      weight: rule.weight,
      timeBasis: basisMeta?.timeBasis ?? null,
      sourcePeriods: basisMeta?.components ?? [],
      normalizationApplied: cleanDisclosureText(basisMeta?.normalizationApplied)
    });
  });

  if (
    sectorBucket === "Biotech/Pharma" &&
    stock.financialPosition.runwayYears != null &&
    stock.financialPosition.runwayYears < 1 &&
    stock.profitMargins.fcfMargin != null &&
    stock.profitMargins.fcfMargin < -80
  ) {
    total = Math.min(total, 30);
  }
  if (
    sectorBucket === "Tech/Internet" &&
    percentToNumber(stock?.growth?.revenueGrowthTTM) < 0 &&
    percentToNumber(stock?.profitMargins?.fcfMargin) < -10 &&
    percentToNumber(stock?.shareStats?.sharesChangeYoY) > 10
  ) {
    total = Math.min(total, 45);
  }
  /*
  if (pennyStock && !isBio && Number.isFinite(profitMarginVal) && profitMarginVal <= -20) {
    total = Math.min(total, total - 6);
    overrideNotes.push("Profitability deeply negative (below -20% margin); treated as structurally weak for penny-stock risk.");
  }
  if (pennyStock && Number.isFinite(fcfMargin) && fcfMargin < -25 && Number.isFinite(dilutionYoY) && dilutionYoY > 25) {
    overrideNotes.push("Dependence on external financing: heavy cash burn paired with high dilution.");
  }
  if (pennyStock && Number.isFinite(runwayYears) && runwayYears < 0.75) {
    overrideNotes.push("Possible going-concern risk: cash runway under 9 months.");
  }
  if (pennyStock && Number.isFinite(fcfMargin) && fcfMargin < 0) {
    overrideNotes.push("Deep negative free cash flow; burn rate elevated.");
  }
  const grossMarginVal = percentToNumber(stock?.profitMargins?.grossMargin);
  if (pennyStock && Number.isFinite(grossMarginVal) && grossMarginVal < 20) {
    overrideNotes.push("Cost structure inconsistent; pricing power limited.");
  }
  if (pennyStock && Number.isFinite(revenueGrowth) && revenueGrowth > 50 && Number.isFinite(opMarginVal) && opMarginVal < 0) {
    overrideNotes.push("Momentum strong, but fundamentals do not yet support a sustained trend.");
  }
  if (pennyStock) {
    overrideNotes.push("Higher risk; leverage or cash flow fragility.");
  }
  */

  // BURN RATE NARRATIVE
  if (fcfMargin && fcfMargin < -50) {
    // Approx burn calc: 1 / |margin|
    // e.g. -200% margin -> burns $2 for every $1 revenue.
    const burn = Math.abs(fcfMargin / 100).toFixed(1);
    overrideNotes.push(`High Cash Burn: Spends ~$${burn} for every $1 of revenue generated.`);
  }

  // Macro adjustment
  if (RISK_FREE_RATE_PCT > 4.0) {
    // Penalize unprofitable companies in high-rate environment
    const isUnprofitable = Number.isFinite(profitMarginVal) && profitMarginVal < 0;
    if (isUnprofitable) {
      total -= 5;
      overrideNotes.push(`Economic Climate: High interest rates make it harder and more expensive for unprofitable companies to borrow money.`);
    }
  }

  // Filing Intelligence Scoring
  if (filingSignals && Array.isArray(filingSignals)) {
    const filingModifier = scoreableFilingSignals.reduce((acc, s) => acc + (s.score || 0), 0);
    if (filingModifier !== 0) {
      total += filingModifier;
      reasons.push({
        name: "Filing signals",
        score: filingModifier,
        message: `Net filing-signal impact: ${filingModifier > 0 ? `+${filingModifier}` : filingModifier} pts`,
        missing: false,
        notApplicable: false,
        weight: null,
        timeBasis: "Filings",
        sourcePeriods: [],
        normalizationApplied: null
      });
      if (filingModifier <= -5) {
        overrideNotes.push(`Regulatory filings signal caution (Net impact: ${filingModifier} pts).`);
      } else if (filingModifier >= 3) {
        overrideNotes.push(`Regulatory filings suggest positive underlying momentum (Net impact: +${filingModifier} pts).`);
      }
    }
  }

  // ========== GROWTH PHASE ADJUSTMENT ==========
  // For verified growth-phase companies that are getting hammered by profitability
  // penalties (ROE, ROIC, margins), apply a strategic offset to push them into the
  // "neutral" tier (40-55 score range) rather than "danger" tier.
  // This does NOT affect profitable companies like META/AAPL.
  const growthPhaseAdjustment = (() => {
    // Must be a verified growth company
    if (!isGrowthStage) return 0;

    // Calculate total profitability penalties (negative scores from efficiency metrics)
    const profitabilityPenaltyRules = [
      "ROE quality", "ROIC", "Return on Assets", "Asset Efficiency",
      "Gross margin", "FCF margin", "Operating leverage", "Net income trend"
    ];
    const profitPenalties = reasons
      .filter((r) => profitabilityPenaltyRules.includes(r.name) && r.score < 0)
      .reduce((sum, r) => sum + r.score, 0);

    // Only apply adjustment if they're getting hit hard (>15 points of penalties)
    if (profitPenalties > -15) return 0;

    // Adjustment scales with revenue growth intensity
    // 30-50% growth: +8 offset
    // 50-80% growth: +10 offset
    // >80% growth: +12 offset (hypergrowth)
    let offset = 0;
    if (Number.isFinite(revenueGrowth)) {
      if (revenueGrowth >= 80) offset = 12;
      else if (revenueGrowth >= 50) offset = 10;
      else if (revenueGrowth >= 30) offset = 8;
    }

    // Cap the offset so it only recovers up to 50% of the profitability penalties
    // This prevents full erasure of legitimate concerns
    const maxRecovery = Math.abs(profitPenalties) * 0.5;
    offset = Math.min(offset, maxRecovery);

    return Math.round(offset);
  })();

  if (growthPhaseAdjustment > 0) {
    total += growthPhaseAdjustment;
    reasons.push({
      name: "Growth Phase Adjustment",
      score: growthPhaseAdjustment,
      message: `+${growthPhaseAdjustment} pts (offsetting profitability penalties during expansion)`,
      missing: false,
      notApplicable: false,
      weight: null,
      timeBasis: "Strategic",
      sourcePeriods: [],
      normalizationApplied: null
    });
    if (ratingDebug) {
      console.log(`[GROWTH ADJUST] ${ticker} | +${growthPhaseAdjustment} pts (Growth Phase Offset)`);
    }
  }

  // Risk coverage floor: if no price/drawdown/trend metrics could be evaluated, dampen the score
  const hasRiskCoverage = reasons.some(
    (r) =>
      !r.missing &&
      !r.notApplicable &&
      /drawdown|trend/i.test(r.name || "")
  );
  if (!hasRiskCoverage) {
    overrideNotes.push("Risk coverage incomplete: price trend/drawdown unavailable.");
  }

  const missingValuationCount = missingCategories.valuation.length;
  let normalized = normalizeRuleScore(total);
  if (ratingDebug) {
    console.log(`[RATING FINAL] ${ticker} | RAW: ${total} | NORM: ${normalized != null ? normalized.toFixed(1) : 'N/A'} | TIER: ${getScoreBand(normalized)} | PENNY: ${pennyStock}`);
    if (missingCritical) console.log(`   !! MISSING CRITICAL DATA: ${criticalMissingFields.join(', ')}`);
  }

  let tierLabel = getScoreBand(normalized ?? 0);

  // If critical data is missing, we note it but DO NOT suppress the score.
  if (missingCritical) {
    missingNotes.push(`Partial data: Missing ${criticalMissingFields.join(", ")}.`);
    // normalized = null; // DISABLED per user request
    tierLabel = getScoreBand(normalized); // Use the actual calculated score
  } else if (pennyStock && normalized != null) {
    // REVISED (Skeptical Quant): Removed arbitrary structural penalties.
    // We rely on the core rules (Dilution, Runway, FCF) to penalize bad fundamentals.
    tierLabel = getScoreBand(normalized);
  }

  // Event-risk cap for small-cap biotech price crashes
  const eventRisk = detectBiotechEventRisk(priceHistory, sectorBucket, marketCap);
  if (eventRisk && normalized != null && normalized > eventRisk.capNormalizedTo) {
    normalized = eventRisk.capNormalizedTo;
    const cappedRaw = (normalized / 100) * RATING_RANGE + RATING_MIN;
    total = Math.min(total, cappedRaw);
    tierLabel = getScoreBand(normalized);
    overrideNotes.push(eventRisk.note);
  }

  const applicableCount = reasons.length - missingCount;
  const completeness = {
    applicable: applicableCount,
    missing: missingCount,
    percent: reasons.length
      ? Math.max(0, Math.min(100, (applicableCount / reasons.length) * 100))
      : null
  };

  // --- NARRATIVE SYNTHESIS ---
  const reconcileNarrative = () => {
    const contradictions = [];
    const opMargin = percentToNumber(stock.profitMargins.operatingMargin);
    const riskScore = bankruptcyRiskScore ?? 0.5;

    // Contradiction: High Loss + Low Risk
    if (Number.isFinite(opMargin) && opMargin < -50 && riskScore <= 0.3) {
      const cash = stock.financialPosition.cash;
      const cashStr = cash > 1e9 ? `$${(cash / 1e9).toFixed(1)}B` : cash > 1e6 ? `$${(cash / 1e6).toFixed(0)}M` : "AMPLE";
      contradictions.push(`Despite heavy operating losses (${opMargin.toFixed(0)}%), the strong cash position (${cashStr}) secures a 'Low' bankruptcy risk rating.`);
    }

    // Contradiction: Growing Revenue + Negative Momentum
    const revGrowth = percentToNumber(stock.growth.revenueGrowthTTM);
    const priceTrend = percentToNumber(stock.priceStats?.dayChangePct); // Proxy
    if (Number.isFinite(revGrowth) && revGrowth > 50 && deteriorationLabel === "Functionally Broken") {
      contradictions.push(`Revenue is surging (${revGrowth.toFixed(0)}%), but fundamental efficiency is deteriorating.`);
    }

    // Add missing grouping notes
    Object.entries(missingCategories).forEach(([cat, items]) => {
      if (items.length > 2) {
        if (cat === 'valuation') missingNotes.push(`Valuation blindspot: P/E, P/S, and other ratios unavailable (likely negative earnings).`);
        else missingNotes.push(`${cat.charAt(0).toUpperCase() + cat.slice(1)} data limited (${items.length} metrics missing).`);
      } else {
        items.forEach(i => missingNotes.push(`${i}: Data unavailable`));
      }
    });

    return contradictions;
  };

  const synthesis = reconcileNarrative();
  overrideNotes.push(...synthesis);

  if (stock.ticker === "IOVA" || stock.symbol === "IOVA") {
    console.log(`[DEBUG] IOVA Rating: Raw=${total}, Norm=${normalized}, Tier=${tierLabel}, Missing=${missingCritical} (${criticalMissingFields.join(",")})`);
  }

  return {
    rawScore: total,
    normalizedScore: normalized,
    tierLabel: tierLabel,
    updatedAt: new Date().toISOString(),
    reasons,
    missingNotes: missingNotes, // Now cleaned/grouped
    overrideNotes: overrideNotes,
    completeness
  };
}

function computeKeyMetrics({ ttm, latestQuarter, latestBalance, shares, priceSummary, growth }) {
  const lastPrice = priceSummary?.lastClose ?? null;
  const revenue = ttm?.revenue ?? null;
  const netIncome = ttm?.netIncome ?? null;
  const eps = ttm?.epsBasic ?? null;
  const fcf = ttm?.freeCashFlow ?? null;
  const equity = latestBalance?.totalStockholdersEquity ?? latestBalance?.totalEquity ?? null;
  const assets = latestBalance?.totalAssets ?? null;

  const totalDebtRaw = Number.isFinite(latestBalance?.totalDebt) ? Number(latestBalance.totalDebt) : null;
  const debtParts = [
    latestBalance?.financialDebt,
    latestBalance?.shortTermDebt,
    latestBalance?.leaseLiabilities
  ].filter((v) => Number.isFinite(v)).map((v) => Number(v));
  const debtFromParts = debtParts.length > 0 ? debtParts.reduce((acc, v) => acc + v, 0) : null;
  const debt = Number.isFinite(totalDebtRaw) && Number.isFinite(debtFromParts)
    ? Math.max(totalDebtRaw, debtFromParts)
    : (Number.isFinite(totalDebtRaw) ? totalDebtRaw : debtFromParts);

  const cashRaw = latestBalance?.cash ?? latestBalance?.cashAndCashEquivalents;
  const cash = Number.isFinite(cashRaw) ? Number(cashRaw) : 0;
  const shortTermInvestments = Number.isFinite(latestBalance?.shortTermInvestments)
    ? Number(latestBalance.shortTermInvestments)
    : 0;
  const marginSource = latestQuarter || latestBalance || {};
  const grossMargin = safeDiv(marginSource?.grossProfit, marginSource?.revenue);
  const operatingMargin = safeDiv(marginSource?.operatingIncome, marginSource?.revenue);
  const netMargin = safeDiv(netIncome, revenue);
  const roe = safeDiv(netIncome, equity);
  const investedCapital =
    equity != null && debt != null && cash != null ? equity + debt - cash : null;
  const roic = safeDiv(netIncome, investedCapital);
  const debtToEquity = safeDiv(debt, equity);
  const debtToAssets = safeDiv(debt, assets);

  const sharesNum = Number(shares);
  const revenuePerShare =
    revenue != null && Number.isFinite(sharesNum) && sharesNum > 0
      ? revenue / sharesNum
      : null;
  const epsTtm = eps != null ? eps : null;
  const bookValuePerShare =
    equity != null && Number.isFinite(sharesNum) && sharesNum > 0
      ? equity / sharesNum
      : null;
  const fcfYield =
    fcf != null && lastPrice != null && Number.isFinite(sharesNum) && sharesNum > 0
      ? fcf / (lastPrice * sharesNum)
      : null;
  const netDebt = debt != null ? debt - cash - shortTermInvestments : null;
  const netDebtToEquity = safeDiv(netDebt, equity);
  const peTtm =
    lastPrice != null && epsTtm != null && epsTtm !== 0 ? lastPrice / epsTtm : null;
  const psTtm =
    lastPrice != null && revenuePerShare != null && revenuePerShare !== 0
      ? lastPrice / revenuePerShare
      : null;
  const pb =
    lastPrice != null && bookValuePerShare != null && bookValuePerShare !== 0
      ? lastPrice / bookValuePerShare
      : null;
  const marketCap =
    lastPrice != null && Number.isFinite(sharesNum) && sharesNum > 0
      ? lastPrice * sharesNum
      : null;

  return {
    grossMargin,
    operatingMargin,
    netMargin,
    roe,
    roic,
    debtToEquity,
    debtToAssets,
    netDebtToEquity,
    revenueCagr3y: growth.revenueCagr3y ?? null,
    epsCagr3y: growth.epsCagr3y ?? null,
    peTtm,
    psTtm,
    pb,
    freeCashFlowYield: fcfYield,
    marketCap
  };
}

function normalizeCompleteness(completeness) {
  if (!completeness) return { percent: null, tier: "low" };
  const percent = Number.isFinite(completeness.percent)
    ? Math.max(0, Math.min(100, Math.round(completeness.percent)))
    : null;
  const tier = percent == null ? "low" : percent >= 75 ? "high" : percent >= 50 ? "medium" : "low";
  return { ...completeness, percent, tier };
}

function deriveConfidenceLevel({ completenessPercent, lastFiledDate, pricePending }) {
  const pct = Number.isFinite(completenessPercent) ? completenessPercent : 0;
  const daysSinceFiled = lastFiledDate ? (Date.now() - Date.parse(lastFiledDate)) / (1000 * 60 * 60 * 24) : null;
  let score = pct;
  if (Number.isFinite(daysSinceFiled)) {
    if (daysSinceFiled > 540) score -= 30;
    else if (daysSinceFiled > 365) score -= 20;
    else if (daysSinceFiled > 270) score -= 10;
    else if (daysSinceFiled <= 180) score += 5;
  } else {
    score -= 15;
  }
  if (pricePending) score -= 5;
  const capped = Math.max(0, Math.min(100, Math.round(score)));
  const level = capped >= 80 ? "high" : capped >= 51 ? "medium" : "low";
  return { level, score: capped, freshnessDays: Number.isFinite(daysSinceFiled) ? Math.round(daysSinceFiled) : null };
}

function buildSnapshot({ ttm, quarterlySeries, annualSeries, annualMode, keyMetrics, growth, latestBalance, shortInterest }) {
  const effectiveSeries = (quarterlySeries && quarterlySeries.length ? quarterlySeries : annualSeries) || [];
  const latestBalanceRow = (() => {
    if (latestBalance) return latestBalance;
    const sorted = [...effectiveSeries]
      .filter((p) => p && p.periodEnd)
      .sort((a, b) => Date.parse(b.periodEnd) - Date.parse(a.periodEnd));
    return sorted[0] || null;
  })();
  const netMarginTTM = keyMetrics.netMargin ?? null;
  const freeCashFlowTTM = ttm?.freeCashFlow ?? null;
  const revenueTTM = ttm?.revenue ?? null;
  const revenueCAGR3Y = growth.revenueCagr3y ?? null;
  const debtToEquity = keyMetrics.debtToEquity ?? null;
  const totalDebt = (() => {
    if (!latestBalanceRow) return null;
    const totalDebtRaw = Number.isFinite(latestBalanceRow.totalDebt) ? Number(latestBalanceRow.totalDebt) : null;
    const parts = [
      latestBalanceRow.financialDebt,
      latestBalanceRow.shortTermDebt,
      latestBalanceRow.leaseLiabilities
    ].filter((v) => Number.isFinite(v)).map((v) => Number(v));
    const partsSum = parts.length ? parts.reduce((acc, v) => acc + v, 0) : null;
    if (Number.isFinite(totalDebtRaw) && Number.isFinite(partsSum)) return Math.max(totalDebtRaw, partsSum);
    return Number.isFinite(totalDebtRaw) ? totalDebtRaw : partsSum;
  })();
  const cashVal = Number.isFinite(latestBalanceRow?.cash) ? Number(latestBalanceRow.cash) : null;
  const stiVal = Number.isFinite(latestBalanceRow?.shortTermInvestments)
    ? Number(latestBalanceRow.shortTermInvestments)
    : null;
  const hasCashLike = Number.isFinite(cashVal) || Number.isFinite(stiVal);
  const netDebt =
    Number.isFinite(totalDebt)
      ? totalDebt - (Number.isFinite(cashVal) ? cashVal : 0) - (Number.isFinite(stiVal) ? stiVal : 0)
      : null;
  const netDebtToFCFYears =
    netDebt != null && Number.isFinite(freeCashFlowTTM) && freeCashFlowTTM > 0
      ? netDebt / freeCashFlowTTM
      : null;
  const interestCoverageMeta = annualMode
    ? computeInterestCoverageAnnual(latestBalanceRow || effectiveSeries[0] || null)
    : computeInterestCoverageTtm(effectiveSeries);
  let interestCoverage =
    interestCoverageMeta.value != null
      ? interestCoverageMeta.value
      : (() => {
        const ttmOpInc = toNumber(ttm?.operatingIncome);
        const latestAnnual = Array.isArray(annualSeries)
          ? [...annualSeries]
            .filter((p) => String(p?.periodType || "").toLowerCase() === "year" && p?.periodEnd)
            .sort((a, b) => Date.parse(b.periodEnd) - Date.parse(a.periodEnd))[0] || null
          : null;
        const annualInterest = toNumber(latestAnnual?.interestExpense);
        if (Number.isFinite(ttmOpInc) && Number.isFinite(annualInterest) && annualInterest !== 0) {
          return ttmOpInc / Math.abs(annualInterest);
        }
        const quarterInterest = toNumber(latestBalanceRow?.interestExpense);
        if (Number.isFinite(ttmOpInc) && Number.isFinite(quarterInterest) && quarterInterest !== 0) {
          return ttmOpInc / Math.abs(quarterInterest * 4);
        }
        return null;
      })();
  const interestCoverageStatus = (() => {
    const base = interestCoverageMeta.status ?? null;
    if (interestCoverageMeta.value == null && interestCoverage != null) return "derived";
    return base;
  })();
  const sharesOutstanding = (() => {
    if (Number.isFinite(latestBalanceRow?.sharesOutstanding)) return Number(latestBalanceRow.sharesOutstanding);
    const latestSeriesShares = [...(effectiveSeries || [])]
      .map((q) => q.sharesOutstanding)
      .filter((v) => Number.isFinite(v))
      .at(-1);
    return latestSeriesShares ?? null;
  })();
  const shareChangeMeta = computeShareChangeWithSplitGuard(effectiveSeries);
  // IMPORTANT: keep share change values in percentage points (e.g., 25.0 = +25%).
  // The rules engine and ticker UI both treat dilution thresholds as percent, not ratios.
  const sharesOutChangeYoY = shareChangeMeta.changeYoY != null ? shareChangeMeta.changeYoY : null;
  const sharesOutChangeQoQ = shareChangeMeta.changeQoQ != null ? shareChangeMeta.changeQoQ : null;
  const ocfSeries = effectiveSeries
    .map((q) => q.operatingCashFlow)
    .filter((v) => v !== null && v !== undefined)
    .slice(-4);
  const operatingCashFlowTrend4Q = classifyTrend(ocfSeries);
  const shortPctFloat = Number.isFinite(shortInterest?.shortPercentFloat)
    ? shortInterest.shortPercentFloat
    : null;
  const daysToCover = Number.isFinite(shortInterest?.daysToCover) ? shortInterest.daysToCover : null;
  const avgVolume30d = Number.isFinite(shortInterest?.avgVolume30Day)
    ? shortInterest.avgVolume30Day
    : Number.isFinite(shortInterest?.avgVolume10Day)
      ? shortInterest.avgVolume10Day
      : null;

  const quartersAsc = Array.isArray(quarterlySeries)
    ? [...quarterlySeries].filter((q) => q && q.periodEnd).sort((a, b) => Date.parse(a.periodEnd) - Date.parse(b.periodEnd))
    : [];
  const last4 = quartersAsc.slice(-4);
  const sumAbs = (field) => {
    if (last4.length < 4) return null;
    let used = 0;
    let acc = 0;
    for (const q of last4) {
      const v = Number(q?.[field]);
      if (!Number.isFinite(v)) continue;
      used += 1;
      acc += Math.abs(v);
    }
    return used ? acc : null;
  };
  const sum = (field) => {
    if (last4.length < 4) return null;
    let used = 0;
    let acc = 0;
    for (const q of last4) {
      const v = Number(q?.[field]);
      if (!Number.isFinite(v)) continue;
      used += 1;
      acc += v;
    }
    return used ? acc : null;
  };

  const shareBuybacksTTM = sumAbs("treasuryStockRepurchased");
  const dividendsPaidTTM = sumAbs("dividendsPaid");
  const shareholderReturnTTM =
    Number.isFinite(shareBuybacksTTM) || Number.isFinite(dividendsPaidTTM)
      ? (Number.isFinite(shareBuybacksTTM) ? shareBuybacksTTM : 0) + (Number.isFinite(dividendsPaidTTM) ? dividendsPaidTTM : 0)
      : null;
  const buybacksPctFcf =
    Number.isFinite(shareBuybacksTTM) && Number.isFinite(freeCashFlowTTM) && freeCashFlowTTM > 0
      ? shareBuybacksTTM / freeCashFlowTTM
      : null;

  const rdSpendTTM = sumAbs("researchAndDevelopmentExpenses");
  const rdIntensityTTM =
    Number.isFinite(rdSpendTTM) && Number.isFinite(revenueTTM) && revenueTTM !== 0
      ? rdSpendTTM / revenueTTM
      : null;
  const rdIntensityAnnualPrev = (() => {
    const years = Array.isArray(annualSeries)
      ? annualSeries
        .filter((p) => String(p?.periodType || "").toLowerCase() === "year")
        .filter((p) => p?.periodEnd)
        .sort((a, b) => Date.parse(b.periodEnd) - Date.parse(a.periodEnd))
      : [];
    const latest = years[0] || null;
    const prev = years[1] || null;
    const latestPct =
      latest && Number.isFinite(latest.researchAndDevelopmentExpenses) && Number.isFinite(latest.revenue) && latest.revenue !== 0
        ? Math.abs(Number(latest.researchAndDevelopmentExpenses)) / Number(latest.revenue)
        : null;
    const prevPct =
      prev && Number.isFinite(prev.researchAndDevelopmentExpenses) && Number.isFinite(prev.revenue) && prev.revenue !== 0
        ? Math.abs(Number(prev.researchAndDevelopmentExpenses)) / Number(prev.revenue)
        : null;
    return { latest: latestPct, prev: prevPct };
  })();

  const ar = Number.isFinite(latestBalanceRow?.accountsReceivable) ? Number(latestBalanceRow.accountsReceivable) : null;
  const inv = Number.isFinite(latestBalanceRow?.inventories) ? Number(latestBalanceRow.inventories) : null;
  const ap = Number.isFinite(latestBalanceRow?.accountsPayable) ? Number(latestBalanceRow.accountsPayable) : null;
  const cogsTtm = (() => {
    const rev = Number(ttm?.revenue);
    const gp = Number(ttm?.grossProfit);
    if (Number.isFinite(rev) && Number.isFinite(gp)) return rev - gp;
    const cost = sum("costOfRevenue");
    return Number.isFinite(cost) ? Math.abs(cost) : null;
  })();
  const dsoDays =
    Number.isFinite(ar) && Number.isFinite(revenueTTM) && revenueTTM > 0 ? (ar / revenueTTM) * 365 : null;
  const dioDays =
    Number.isFinite(inv) && Number.isFinite(cogsTtm) && cogsTtm > 0 ? (inv / cogsTtm) * 365 : null;
  const dpoDays =
    Number.isFinite(ap) && Number.isFinite(cogsTtm) && cogsTtm > 0 ? (ap / cogsTtm) * 365 : null;
  const cashConversionCycleDays =
    Number.isFinite(dsoDays) && Number.isFinite(dpoDays)
      ? dsoDays + (Number.isFinite(dioDays) ? dioDays : 0) - dpoDays
      : null;

  const effectiveTaxRateTTM = inferTaxRateFromPeriods({ ttm, latestAnnual: (Array.isArray(annualSeries) ? annualSeries[0] : null) });

  return {
    netMarginTTM,
    fcfMarginTTM: safeDiv(freeCashFlowTTM, revenueTTM),
    freeCashFlowTTM,
    revenueTTM,
    netIncomeTTM: ttm?.netIncome ?? null,
    operatingIncomeTTM: ttm?.operatingIncome ?? null,
    revenueCAGR3Y,
    debtToEquity,
    // Use a single canonical casing to avoid duplicate JSON keys for case-insensitive consumers.
    netDebtToFcfYears: netDebtToFCFYears ?? null,
    interestCoverage,
    interestCoveragePeriods: interestCoverageMeta.periods ?? null,
    interestCoverageStatus,
    sharesOutChangeYoY,
    sharesOutChangeYoYRaw: shareChangeMeta.rawYoY != null ? shareChangeMeta.rawYoY : null,
    sharesOutChangeQoQ,
    shareChangeLikelySplit: !!shareChangeMeta.splitSignal,
    shareChangeLikelyReverseSplit: !!shareChangeMeta.reverseSplitSignal,
    sharesOut: sharesOutstanding,
    sharesOutstanding,
    operatingCashFlowTrend4Q,
    basis: annualMode ? "annual" : "quarterly",
    netDebtAssumedZeroCash: !hasCashLike && Number.isFinite(totalDebt),
    shareBuybacksTTM,
    dividendsPaidTTM,
    shareholderReturnTTM,
    buybacksPctFcf,
    rdSpendTTM,
    rdIntensityTTM,
    rdIntensityAnnual: rdIntensityAnnualPrev.latest,
    rdIntensityAnnualPrev: rdIntensityAnnualPrev.prev,
    dsoDays,
    dioDays,
    dpoDays,
    cashConversionCycleDays,
    effectiveTaxRateTTM,
    shortPercentFloat: shortPctFloat,
    shortFloatPercent: shortPctFloat,
    shortInterestPercentOfFloat: shortPctFloat,
    daysToCover,
    shortRatio: daysToCover,
    avgVolume30d
  };
}

function buildProjections({ snapshot, growth, quarterlySeries, annualSeries, annualMode, keyMetrics }) {
  const quarterly = Array.isArray(quarterlySeries) ? quarterlySeries : [];
  const series = (quarterly && quarterly.length ? quarterly : annualSeries) || [];
  const latestAssets = [...series]
    .filter((q) => Number.isFinite(q?.totalAssets))
    .sort((a, b) => Date.parse(a.periodEnd) - Date.parse(b.periodEnd))
    .at(-1)?.totalAssets;
  const revenueSlope = slope(series.map((q) => q.revenue));
  const fcfSlope = slope(
    series.map((q) =>
      q.freeCashFlow != null
        ? q.freeCashFlow
        : q.operatingCashFlow != null && q.capex != null
          ? q.operatingCashFlow - Math.abs(q.capex)
          : null
    )
  );
  const marginSlope = slope(series.map((q) => q.netIncome && q.revenue ? q.netIncome / q.revenue : null));

  const margins = series
    .map((q) => (q.netIncome != null && q.revenue ? q.netIncome / q.revenue : null))
    .filter((v) => Number.isFinite(v));
  const gmStability =
    margins.length >= 2
      ? 1 - Math.min(1, Math.abs(margins[margins.length - 1] - margins[0]))
      : null;
  const ocfTrendSlope = slope(
    quarterly.map((q) => (Number.isFinite(q.operatingCashFlow) ? q.operatingCashFlow : null)).slice(-4)
  );
  const revenueTtmFromSeries = (() => {
    const latest4 = quarterly.slice(-4);
    if (latest4.length < 4) return null;
    const total = latest4.reduce((acc, q) => (Number.isFinite(q.revenue) ? acc + Number(q.revenue) : acc), 0);
    return Number.isFinite(total) ? total : null;
  })();
  const fcfTtmFromSnapshot = snapshot?.freeCashFlowTTM ?? null;
  const fcfMargin = Number.isFinite(fcfTtmFromSnapshot) && Number.isFinite(revenueTtmFromSeries) && revenueTtmFromSeries !== 0
    ? fcfTtmFromSnapshot / revenueTtmFromSeries
    : null;
  const ocfTtmFromSeries = (() => {
    const latest4 = quarterly.slice(-4);
    if (latest4.length < 4) return null;
    const total = latest4.reduce(
      (acc, q) => (Number.isFinite(q.operatingCashFlow) ? acc + Number(q.operatingCashFlow) : acc),
      0
    );
    return Number.isFinite(total) ? total : null;
  })();
  const ocfMargin =
    Number.isFinite(ocfTtmFromSeries) && Number.isFinite(revenueTtmFromSeries) && revenueTtmFromSeries !== 0
      ? ocfTtmFromSeries / revenueTtmFromSeries
      : null;

  const revenueYoyPct = (() => {
    const sorted = [...quarterly].filter((q) => q && q.periodEnd).sort((a, b) => Date.parse(a.periodEnd) - Date.parse(b.periodEnd));
    if (sorted.length < 8) return null;
    const last4 = sorted.slice(-4);
    const prev4 = sorted.slice(-8, -4);
    const sum = (arr) => arr.reduce((acc, q) => (Number.isFinite(q?.revenue) ? acc + Number(q.revenue) : acc), 0);
    const now = sum(last4);
    const prev = sum(prev4);
    if (!Number.isFinite(now) || !Number.isFinite(prev) || prev === 0) return null;
    return ((now - prev) / Math.abs(prev)) * 100;
  })();

  const futureGrowthScore =
    normalize(growth.revenueCagr3y ?? 0, -0.2, 0.5) * 0.4 +
    normalize(ocfTrendSlope ?? 0, -1, 1) * 0.35 +
    normalize(gmStability ?? 0.5, 0, 1) * 0.25;

  const growthContinuationScore = clamp01(futureGrowthScore);
  const growthContinuationLabel =
    growthContinuationScore == null
      ? null
      : growthContinuationScore >= 0.6
        ? "Likely continuation"
        : growthContinuationScore >= 0.3
          ? "At risk of stalling"
          : "Weak continuation";

  const dilutionParts = [];
  const sharesChangeRisk =
    snapshot.sharesOutChangeYoY != null ? normalize(snapshot.sharesOutChangeYoY / 100, -0.03, 0.12) : null;
  if (sharesChangeRisk != null) dilutionParts.push(sharesChangeRisk);
  const netDebtRisk = normalize(snapshot.netDebtToFcfYears ?? 0, 0, 8);
  if (netDebtRisk != null) dilutionParts.push(netDebtRisk);
  if (snapshot.interestCoverage != null) {
    const coverageRisk = normalize(snapshot.interestCoverage, 1, 8);
    if (coverageRisk != null) dilutionParts.push(1 - coverageRisk);
  }
  if (fcfMargin != null && fcfMargin < 0) {
    dilutionParts.push(clamp01(normalize(-fcfMargin, 0, 0.25)));
  }
  if (snapshot.netDebtToFcfYears == null && fcfMargin != null && fcfMargin < 0) {
    dilutionParts.push(1); // negative FCF with unknown debt implies high dilution reliance
  }
  let dilutionRiskScore = clamp01(avg(dilutionParts));
  // Apply dampening for stable recent share counts (merger artifacts)
  const qoqDil = Number.isFinite(snapshot?.sharesOutChangeQoQ) ? snapshot.sharesOutChangeQoQ : 0;
  if (dilutionRiskScore > 0.4 && qoqDil < 1) {
    dilutionRiskScore = Math.min(dilutionRiskScore, qoqDil < 0 ? 0 : 0.2);
  }

  const dilutionRisk =
    dilutionRiskScore != null ? dilutionRiskScore : normalize((snapshot.sharesOutChangeYoY ?? 0) / 100, -0.03, 0.1) || 0;

  const leverageFactor = normalize(keyMetrics?.debtToEquity ?? snapshot.debtToEquity ?? 0, 0, 3);
  const fallbackDebtYears = (() => {
    if (snapshot.netDebtToFcfYears != null) return snapshot.netDebtToFcfYears;
    const burnFcF = fcfMargin != null && fcfMargin < 0;
    const burnOcf = ocfMargin != null && ocfMargin < 0;
    if (burnFcF) return 12;
    if (fcfMargin == null && burnOcf) return 12; // only penalize if OCF also negative
    return null;
  })();
  const debtYearsRisk = fallbackDebtYears != null ? normalize(fallbackDebtYears, 0, 10) : null;
  const coverageRisk =
    snapshot.interestCoverage != null ? clamp01(1 - normalize(snapshot.interestCoverage, 1, 8)) : null;
  const fcfMarginRisk =
    fcfMargin != null && fcfMargin < 0 ? clamp01(normalize(-fcfMargin, 0, 0.25)) : null;
  let marginRisk = clamp01(normalize(-(marginSlope ?? 0), -0.05, 0.05));
  const latestNetMargin = margins.length ? margins[margins.length - 1] : null;
  if (Number.isFinite(latestNetMargin) && latestNetMargin > 0.05 && marginRisk != null) {
    marginRisk = Math.min(marginRisk, 0.35);
  }
  const strongCoverage = Number.isFinite(snapshot.interestCoverage) && snapshot.interestCoverage > 8;
  let adjustedDebtYearsRisk = debtYearsRisk;
  if (debtYearsRisk != null && snapshot.netDebtToFcfYears == null && strongCoverage && fcfMargin == null) {
    adjustedDebtYearsRisk = Math.min(debtYearsRisk, 0.3);
  }
  let bankruptcyRiskScore = clamp01(
    avg([adjustedDebtYearsRisk, leverageFactor, marginRisk, coverageRisk, fcfMarginRisk].filter((v) => v !== null))
  );

  // Dampeners for cash-rich mega-caps: if large, cash-generative, and low net-debt burden, cap risk at Low.
  const megaCap =
    (Number.isFinite(keyMetrics?.marketCap) ? keyMetrics.marketCap > 50e9 : false) ||
    (Number.isFinite(latestAssets) ? Number(latestAssets) > 50e9 : false) ||
    (Number.isFinite(revenueTtmFromSeries) ? revenueTtmFromSeries > 50e9 : false);
  const hasLowDebtYears = (snapshot.netDebtToFcfYears ?? Infinity) <= 2;
  const hasStrongFcfMargin = Number.isFinite(fcfMargin) && fcfMargin > 0.1;
  const hasStrongCoverage = Number.isFinite(snapshot.interestCoverage) && snapshot.interestCoverage > 15;
  const netCash = Number.isFinite(snapshot.netDebtToFcfYears) && snapshot.netDebtToFcfYears < 0;

  if (
    (megaCap && hasLowDebtYears && hasStrongFcfMargin) ||
    netCash ||
    hasStrongCoverage
  ) {
    bankruptcyRiskScore = Math.min(bankruptcyRiskScore ?? 0.2, 0.2); // cap to Low
  }
  // Soften bankruptcy flag for large caps with simply positive FCF, trusting capital access
  if (megaCap && Number.isFinite(fcfMargin) && fcfMargin > 0) {
    bankruptcyRiskScore = Math.min(bankruptcyRiskScore ?? 0.3, 0.3);
  }
  if (!megaCap && strongCoverage && (keyMetrics?.debtToEquity ?? snapshot.debtToEquity ?? 0) < 1) {
    bankruptcyRiskScore = Math.min(bankruptcyRiskScore ?? 0.35, 0.35);
  }

  // Refine Dilution Risk: If YoY is high but QoQ is flat, it was a one-time event (merger/offering)
  const qoqDilution = Number.isFinite(snapshot?.sharesOutChangeQoQ) ? snapshot.sharesOutChangeQoQ : null;
  const hasSplitArtifact = snapshot.shareChangeLikelySplit === true;
  const hasYoY = Number.isFinite(snapshot.sharesOutChangeYoY);
  const dilutionOneOff =
    sharesChangeRisk != null &&
    sharesChangeRisk > 0.4 &&
    hasYoY &&
    !hasSplitArtifact &&
    qoqDilution != null &&
    Math.abs(qoqDilution) < 1;
  if (dilutionOneOff) {
    dilutionRiskScore = dilutionRiskScore != null ? Math.min(dilutionRiskScore, qoqDilution < 0 ? 0 : 0.25) : dilutionRiskScore;
  }


  let deteriorationLabel = null;
  const positives = [revenueSlope, fcfSlope, marginSlope].filter((v) => v > 0).length;
  const negatives = [revenueSlope, fcfSlope, marginSlope].filter((v) => v < 0).length;
  if (positives >= 3) deteriorationLabel = "Strong uptrend";
  else if (positives >= 2) deteriorationLabel = "Improving";
  else if (negatives >= 2) deteriorationLabel = "Declining";
  else deteriorationLabel = "Stabilizing";

  let businessTrendLabel = null;
  if (positives >= 2) businessTrendLabel = "Improving";
  else if (negatives >= 2) businessTrendLabel = "Worsening";
  else businessTrendLabel = "Stable";

  const riskLabel = (score) => {
    if (score == null) return null;
    if (score < 0.3) return "Low";
    if (score < 0.6) return "Medium";
    return "High";
  };

  return {
    futureGrowthScore: Number.isFinite(futureGrowthScore) ? futureGrowthScore : null,
    dilutionRisk: Number.isFinite(dilutionRisk) ? dilutionRisk : null,
    deteriorationLabel,
    growthContinuationScore,
    growthContinuationLabel,
    dilutionRiskScore,
    dilutionOneOff,
    dilutionRiskLabel: riskLabel(dilutionRiskScore),
    bankruptcyRiskScore,
    bankruptcyRiskLabel: riskLabel(bankruptcyRiskScore),
    businessTrendLabel,
    // New Strategic Outlook framing (used by the ticker page if present):
    // - `trajectoryLabel` answers "if they keep executing the current model, will they grow/stall/fade?"
    // - derived primarily from near-term demand + cash-generation quality rather than raw absolute slopes.
    trajectoryLabel: (() => {
      const revGrowthPct = revenueYoyPct;
      const fcfMarginPct = Number.isFinite(fcfMargin) ? fcfMargin * 100 : null;
      const ocfTrend = String(snapshot?.operatingCashFlowTrend4Q || "").toLowerCase();
      const ocfImproving = ocfTrend === "up";
      const ocfWorsening = ocfTrend === "down";
      if (revGrowthPct == null && fcfMarginPct == null && !ocfTrend) return null;
      if ((revGrowthPct ?? 0) >= 10 && ((fcfMarginPct ?? -Infinity) >= 5 || ocfImproving)) return "Grow";
      if ((revGrowthPct ?? 0) <= -5 && ((fcfMarginPct ?? Infinity) < 0 || ocfWorsening)) return "Fade";
      return "Stall";
    })(),
    revenueSlope,
    marginSlope,
    ocfTrendSlope
  };
}

function computeStrategicOutlook({ stock, snapshot, filingSignals, momentumScore }) {
  const isHiddenCard = (card) =>
    card?.hidden === true || card?.suppressed === true || card?.includeInScore === false;
  const visibleSignals = (filingSignals || []).filter((s) => !isHiddenCard(s));
  const revGrowthPct = percentToNumber(stock?.growth?.revenueGrowthTTM);
  const opMarginPct = percentToNumber(stock?.profitMargins?.operatingMargin);
  const fcfMarginPct = percentToNumber(stock?.profitMargins?.fcfMargin);
  const dilutionPct = percentToNumber(stock?.shareStats?.sharesChangeYoY);
  const marginTrendPp = percentToNumber(stock?.momentum?.marginTrend);
  const ocfTrend = String(snapshot?.operatingCashFlowTrend4Q || "").toLowerCase();

  const opScore01 = Number.isFinite(momentumScore) ? Math.max(0, Math.min(1, momentumScore / 100)) : null;
  const opLabel =
    momentumScore == null
      ? null
      : momentumScore >= 80
        ? "Strong Momentum"
        : momentumScore >= 60
          ? "Likely Continuation"
          : momentumScore >= 40
            ? "Stable / Mixed"
            : momentumScore >= 20
              ? "Weak / Stalling"
              : "Deteriorating";

  const trajectory = (() => {
    const rev = revGrowthPct;
    const fcf = fcfMarginPct;
    const improvingCash = ocfTrend === "up";
    const worseningCash = ocfTrend === "down";
    const hasCore = Number.isFinite(rev) || Number.isFinite(fcf) || improvingCash || worseningCash;

    if (!hasCore) {
      const posSignals = visibleSignals.filter((s) => (s.score || 0) > 0).length;
      const negSignals = visibleSignals.filter((s) => (s.score || 0) < 0).length;
      return {
        regime: null,
        label: null,
        narrative: "Data missing.",
        confidence: "low",
        drivers: [],
        filingSignalBalance: { positive: posSignals, negative: negSignals }
      };
    }

    // Detect growth-phase companies (investing heavily in expansion)
    const capexToRev = toNumber(stock?.cash?.capexToRevenue) ?? 0;
    const isGrowthPhase = (
      (rev ?? 0) >= 30 &&        // Strong revenue growth
      capexToRev > 50 &&          // Heavy capex deployment
      (fcf ?? 0) < -20            // Negative FCF due to investment
    );

    let regime = "stall";
    if (isGrowthPhase) {
      regime = "growth-phase";
    } else if ((rev ?? 0) >= 10 && ((fcf ?? -Infinity) >= 5 || improvingCash)) {
      regime = "grow";
    } else if ((rev ?? 0) <= -5 && ((fcf ?? Infinity) < 0 || worseningCash)) {
      regime = "fade";
    }

    const label =
      regime === "growth-phase" ? "Expansion" :
        regime === "grow" ? "Grow" :
          regime === "fade" ? "Fade" :
            "Stall";

    const drivers = [];
    if (Number.isFinite(rev)) drivers.push(`Revenue YoY: ${rev.toFixed(1)}%`);
    if (Number.isFinite(opMarginPct)) drivers.push(`Operating margin: ${opMarginPct.toFixed(1)}%`);
    if (Number.isFinite(fcf)) drivers.push(`FCF margin (TTM): ${fcf.toFixed(1)}%`);
    if (Number.isFinite(marginTrendPp)) drivers.push(`Op margin trend: ${marginTrendPp.toFixed(1)}pp`);
    if (Number.isFinite(dilutionPct)) drivers.push(`Dilution YoY: ${dilutionPct.toFixed(1)}%`);
    if (ocfTrend) drivers.push(`OCF trend (4Q): ${ocfTrend}`);
    if (regime === "growth-phase" && Number.isFinite(capexToRev)) {
      drivers.push(`Capex intensity: ${capexToRev.toFixed(0)}%`);
    }

    const posSignals = visibleSignals.filter((s) => (s.score || 0) > 0).length;
    const negSignals = visibleSignals.filter((s) => (s.score || 0) < 0).length;

    const narrative =
      regime === "growth-phase"
        ? "Heavy infrastructure investment phase: Revenue is scaling rapidly, but near-term FCF is sacrificed for long-term capacity expansion."
        : regime === "grow"
          ? "Revenue is growing and cash generation looks supportive, suggesting the current model is scaling."
          : regime === "fade"
            ? "Revenue is shrinking and cash generation is weakening, suggesting the current model may be losing traction."
            : "Growth is modest and profitability/cash flows look mixed, suggesting a mature or transitioning model.";

    const confidence = (() => {
      const scoreableSignals = visibleSignals.length;
      if (scoreableSignals >= 3 && Number.isFinite(rev) && Number.isFinite(fcf)) return "high";
      if (Number.isFinite(rev) || Number.isFinite(fcf)) return "medium";
      return "low";
    })();

    return {
      regime,
      label,
      narrative,
      confidence,
      drivers,
      filingSignalBalance: { positive: posSignals, negative: negSignals }
    };
  })();

  return {
    operationalMomentum: {
      score: Number.isFinite(momentumScore) ? Math.max(0, Math.min(100, momentumScore)) : null,
      score01: opScore01,
      label: opLabel
    },
    trajectory
  };
}

export async function buildTickerViewModel(ticker) {
  try {
    if (!ticker) return null;
    console.log("[tickerAssembler] buildTickerViewModel start", ticker);
    const fundamentals = (await getFundamentalsForTicker(ticker)) || [];
    const latestEnd =
      fundamentals && fundamentals.length
        ? fundamentals
          .map((p) => p.periodEnd)
          .filter(Boolean)
          .sort()
          .slice(-1)[0]
        : null;
    console.log(
      "[tickerAssembler] fundamentals fetched",
      fundamentals?.length || 0,
      "latest",
      latestEnd,
      "for",
      ticker
    );
    if (!fundamentals.length) {
      console.warn("[tickerAssembler] no fundamentals rows available for", ticker);
    }

    const priceState = await getOrFetchLatestPrice(ticker);
    console.log("[tickerAssembler] price state", priceState?.state, "for", ticker);
    let priceSummary = emptyPriceSummary();
    let priceHistory = [];
    const pricePending = priceState?.state === "pending";
    let externalMarketCap = null;
    let externalCurrency = null;

    if (priceState?.state === "ready") {
      const series = Array.isArray(priceState.priceSeries) ? priceState.priceSeries : [];
      const pricePieces = buildPricePieces(series);
      priceSummary = pricePieces.priceSummary;
      priceHistory = pricePieces.priceHistory;

      // Merge snapshot data if available/newer
      if (priceState.close && (!priceSummary.lastClose || priceState.date >= priceSummary.lastCloseDate)) {
        priceSummary.lastClose = priceState.close;
        priceSummary.lastCloseDate = priceState.date;
      }
      externalMarketCap = priceState.marketCap || null;
      externalCurrency = priceState.currency || null;
    } else if (priceState?.state === "error") {
      console.warn("[tickerAssembler] price fetch error for", ticker);
    }

    // Fallback: if price looks implausible or is missing, try local price file
    const looksImplausible =
      !Number.isFinite(priceSummary.lastClose) ||
      priceSummary.lastClose <= 0 ||
      !priceHistory.length ||
      isPriceStale(priceSummary.lastCloseDate, 5);
    if (looksImplausible) {
      const localPrices = loadLocalPriceHistory(ticker);
      if (localPrices && localPrices.length) {
        const fallbackPieces = buildPricePieces(localPrices);
        priceSummary = fallbackPieces.priceSummary;
        priceHistory = fallbackPieces.priceHistory;
        logPriceOnce("local-fallback", ticker, `[tickerAssembler] using local price fallback for ${ticker}`);
      } else if (isPriceStale(priceSummary.lastCloseDate, 5)) {
        // stale and no fallback; mark pending and clear price to avoid showing ghost values
        priceSummary = emptyPriceSummary();
        priceHistory = [];
        logPriceOnce("stale-no-fallback", ticker, `[tickerAssembler] price stale and no fallback for ${ticker}`);
      }
    }

    let quarterlySeries = toQuarterlySeries(fundamentals);

    // Filter out "as-of" placeholder quarters (often shares-only) so TTM/trend logic uses real statement periods.
    // Balance-sheet-only rows (assets/shares/cash without income/cashflow) should not count toward TTM.
    const statementQuarterlySeries = quarterlySeries.filter(
      (q) =>
        isFiniteValue(q?.revenue) ||
        isFiniteValue(q?.netIncome) ||
        isFiniteValue(q?.operatingCashFlow) ||
        isFiniteValue(q?.capex) ||
        isFiniteValue(q?.freeCashFlow)
    );

    // Auto-refresh EDGAR fundamentals when the local store is incomplete for YoY/trend logic.
    // This prevents the "Domestic trap" where only 4 quarters exist and YoY becomes impossible.
    const shouldAutoEnqueue = process.env.EDGAR_AUTO_ENQUEUE_ON_GAPS !== "0";
    if (shouldAutoEnqueue) {
      const job = getJobState(ticker);
      const cooldownMs = Number(process.env.EDGAR_AUTO_ENQUEUE_COOLDOWN_MS) || 6 * 60 * 60 * 1000; // 6h
      const lastAttemptTs = Date.parse(job?.finishedAt || job?.startedAt || job?.enqueuedAt || "");
      const inCooldown = Number.isFinite(lastAttemptTs) && Date.now() - lastAttemptTs < cooldownMs;
      const canEnqueue = !job || (job.status !== "queued" && job.status !== "running" && !inCooldown);

      const outPath = path.join(EDGAR_DIR, `${ticker.toUpperCase()}-fundamentals.json`);
      const jsonMissing = (() => {
        try {
          return !fs.existsSync(outPath);
        } catch (_) {
          return false;
        }
      })();

      const seriesAsc = sortByPeriodEndAsc(quarterlySeries);
      const latestQ = seriesAsc.at(-1) || null;
      const yearAgoQ = latestQ?.periodEnd ? findComparableYearAgo(seriesAsc, latestQ.periodEnd) : null;
      const insufficientYoY = !!latestQ && !yearAgoQ;
      const cashMissing = latestQ ? !Number.isFinite(Number(latestQ.cash)) && !Number.isFinite(Number(latestQ.cashAndCashEquivalents)) : false;
      const sharesMissing = latestQ ? !Number.isFinite(Number(latestQ.sharesOutstanding)) : false;

      const lastNQuarters = (n) => {
        const quarters = seriesAsc.filter((q) => q?.periodEnd).slice(-n);
        return quarters.length === n ? quarters : [];
      };

      const depositsValue = (q) => {
        const v =
          q?.deposits ??
          q?.totalDeposits ??
          q?.customerDeposits ??
          q?.depositLiabilities ??
          null;
        const num = Number(v);
        return Number.isFinite(num) ? num : null;
      };

      const looksFinancial = String(fundamentals?.[0]?.sector || "").toLowerCase().includes("financial");
      const hasAnyDeposits = seriesAsc.some((q) => depositsValue(q) != null);
      const hasAnyInterest = seriesAsc.some(
        (q) => Number.isFinite(Number(q?.interestIncome)) || Number.isFinite(Number(q?.interestExpense))
      );
      const shouldCheckBankRules = looksFinancial || hasAnyDeposits || hasAnyInterest;

      const growthSpeedHistoryMissing = (() => {
        if (!latestQ) return false;

        // Asset Growth Velocity (YoY): totalAssets now + year-ago quarter
        const assetYoYMissing =
          Number.isFinite(Number(latestQ.totalAssets)) &&
          (!yearAgoQ || !Number.isFinite(Number(yearAgoQ.totalAssets)));

        // Deposit Growth (YoY): deposits proxy now + year-ago quarter
        const depositsNow = depositsValue(latestQ);
        const depositsYoYMissing =
          shouldCheckBankRules &&
          depositsNow != null &&
          (!yearAgoQ || depositsValue(yearAgoQ) == null);

        // Cash Burn Deceleration: need 3-4 quarters of FCF (explicit or derivable)
        const burnWindow = lastNQuarters(4);
        const burnOk =
          burnWindow.length &&
          burnWindow.filter((q) => {
            if (Number.isFinite(Number(q?.freeCashFlow))) return true;
            return Number.isFinite(Number(q?.operatingCashFlow)) && Number.isFinite(Number(q?.capex));
          }).length >= 3;

        // Operating Leverage Inflection: 3-4 quarters of OpEx + Revenue
        const leverageWindow = lastNQuarters(4);
        const leverageOk =
          leverageWindow.length &&
          leverageWindow.filter((q) => Number.isFinite(Number(q?.revenue)) && Number.isFinite(Number(q?.operatingExpenses)))
            .length >= 3;

        // Net Interest Margin: 2 quarters of interest income/expense + total assets
        const nimWindow = lastNQuarters(2);
        const nimOk =
          !shouldCheckBankRules ||
          (nimWindow.length &&
            nimWindow.every(
              (q) =>
                Number.isFinite(Number(q?.totalAssets)) &&
                Number.isFinite(Number(q?.interestIncome)) &&
                Number.isFinite(Number(q?.interestExpense))
            ));

        // Working Capital Efficiency: 2 quarters of current assets/liabs + revenue
        const wcWindow = lastNQuarters(2);
        const wcOk =
          wcWindow.length &&
          wcWindow.every(
            (q) =>
              Number.isFinite(Number(q?.revenue)) &&
              Number.isFinite(Number(q?.currentAssets)) &&
              Number.isFinite(Number(q?.currentLiabilities))
          );

        // Revenue Quality (DSO proxy): 2 quarters of accounts receivable + revenue
        const arWindow = lastNQuarters(2);
        const arOk =
          arWindow.length &&
          arWindow.every((q) => Number.isFinite(Number(q?.revenue)) && Number.isFinite(Number(q?.accountsReceivable)));

        return (
          assetYoYMissing ||
          depositsYoYMissing ||
          !burnOk ||
          !leverageOk ||
          !nimOk ||
          !wcOk ||
          !arOk
        );
      })();

      const newCardsFieldsMissing = (() => {
        if (!latestQ) return false;
        const hasAssets = Number.isFinite(Number(latestQ.totalAssets));
        const hasLiabs = Number.isFinite(Number(latestQ.totalLiabilities));
        const hasRevenue = Number.isFinite(Number(latestQ.revenue));
        const hasOpInc = Number.isFinite(Number(latestQ.operatingIncome));
        const hasTotalDebt = Number.isFinite(Number(latestQ.totalDebt));
        const hasStDebt = Number.isFinite(Number(latestQ.shortTermDebt));

        const currentAssetsMissing = hasAssets && !Number.isFinite(Number(latestQ.currentAssets));
        const currentLiabilitiesMissing = hasLiabs && !Number.isFinite(Number(latestQ.currentLiabilities));
        const operatingExpensesMissing =
          hasRevenue && hasOpInc && !Number.isFinite(Number(latestQ.operatingExpenses));
        const longTermDebtMissing =
          hasTotalDebt && hasStDebt && !Number.isFinite(Number(latestQ.longTermDebt));

        return currentAssetsMissing || currentLiabilitiesMissing || operatingExpensesMissing || longTermDebtMissing;
      })();

      if (
        canEnqueue &&
        (jsonMissing || insufficientYoY || cashMissing || sharesMissing || newCardsFieldsMissing || growthSpeedHistoryMissing)
      ) {
        try {
          const reason = jsonMissing
            ? "fundamentals cache missing"
            : insufficientYoY
              ? "insufficient quarterly history for YoY"
              : cashMissing
                ? "cash field missing"
                : sharesMissing
                  ? "shares field missing"
                  : newCardsFieldsMissing
                    ? "new-card fields missing"
                    : "growth-speed history missing";
          console.warn(`[tickerAssembler] enqueue EDGAR refresh for ${ticker.toUpperCase()} (${reason})`);
          enqueueFundamentalsJob(ticker);
        } catch (err) {
          console.warn("[tickerAssembler] failed to enqueue EDGAR refresh", ticker, err?.message || err);
        }
      }
    }

    // GLOBAL SHARE SCALING CORRECTION (Fix for IOVA and others reporting shares in thousands)
    const latestForScaling = quarterlySeries[quarterlySeries.length - 1];
    const sharesForScaling = Number(latestForScaling?.sharesOutstanding);
    const priceForScaling = Number(priceSummary?.lastClose);
    const assetsForScaling = Number(latestForScaling?.totalAssets);

    if (Number.isFinite(sharesForScaling) && Number.isFinite(priceForScaling) && Number.isFinite(assetsForScaling) && sharesForScaling > 0) {
      const impliedCap = sharesForScaling * priceForScaling;
      // Heuristic: Assets > $100M but Implied Cap < $25M and Shares < 5M -> Scale x1000
      if (assetsForScaling > 100_000_000 && impliedCap < 25_000_000 && sharesForScaling < 5_000_000) {
        console.warn(`[tickerAssembler] Global Share Scaling Correction for ${ticker}: x1000`);
        const scale = 1000;

        // Correct Quarterly Series
        quarterlySeries = quarterlySeries.map(q => {
          const next = { ...q };
          if (Number.isFinite(next.sharesOutstanding)) next.sharesOutstanding *= scale;
          return next;
        });

        // Correct Fundamentals (source for Annual Series and Growth)
        fundamentals.forEach(p => {
          if (Number.isFinite(p.sharesOutstanding)) p.sharesOutstanding *= scale;
          if (Number.isFinite(p.shares)) p.shares *= scale;
        });
      }
    }
    const annualSeries = [...(fundamentals || [])]
      .filter((p) => (p.periodType || "").toLowerCase() === "year")
      .sort((a, b) => Date.parse(b.periodEnd || 0) - Date.parse(a.periodEnd || 0));
    const latestAnnual = annualSeries[0] || null;
    const ttmFromQuarters = buildTtmFromQuarters(statementQuarterlySeries);
    const ttm =
      ttmFromQuarters ||
      (latestAnnual
        ? {
          asOf: latestAnnual.periodEnd || null,
          revenue: latestAnnual.revenue ?? null,
          netIncome: latestAnnual.netIncome ?? null,
          epsBasic: latestAnnual.epsBasic ?? (
            // Infer EPS for foreign issuers if explicit field missing but Net Income exists
            (latestAnnual.netIncome != null && latestAnnual.sharesOutstanding > 0)
              ? latestAnnual.netIncome / latestAnnual.sharesOutstanding
              : null
          ),
          freeCashFlow:
            latestAnnual.freeCashFlow ??
            (Number.isFinite(latestAnnual.operatingCashFlow) && Number.isFinite(latestAnnual.capex)
              ? latestAnnual.operatingCashFlow - Math.abs(latestAnnual.capex ?? 0)
              : null)
        }
        : null);
    const growth = computeGrowth(fundamentals);
    const baseSic = fundamentals.find((p) => Number.isFinite(p.sic))?.sic ?? null;
    const baseSector = fundamentals.find((p) => p.sector)?.sector || null;
    const sectorInfo = classifySector({ ticker, sic: baseSic });
    const sector = baseSector || sectorInfo.sector || null;
    const sectorBucket = resolveSectorBucket(sector);
    const latestFiledDate =
      fundamentals
        .map((p) => p.filedDate)
        .filter(Boolean)
        .sort()
        .slice(-1)[0] || null;

    const latestQuarter = statementQuarterlySeries.at(-1) || quarterlySeries.at(-1) || null;
    const latestBalance = latestQuarter || latestAnnual || null;
    const sharesFallback = (() => {
      const fromQuarter = latestQuarter?.sharesOutstanding;
      if (Number.isFinite(fromQuarter)) return fromQuarter;
      const fromFundamentals = fundamentals
        .map((p) => p.sharesOutstanding ?? p.shares)
        .find((v) => Number.isFinite(v));
      if (Number.isFinite(fromFundamentals)) return fromFundamentals;
      return null;
    })();
    const shares = sharesFallback;

    const keyMetrics = computeKeyMetrics({
      ttm,
      latestQuarter,
      latestBalance,
      shares,
      priceSummary,
      growth
    });

    const currency = fundamentals[0]?.currency || null;
    const shortInterest = null;
    /* 
    // Disabled per user request
    await fetchShortInterest(ticker).catch((err) => {
      console.warn("[tickerAssembler] short interest fetch failed", ticker, err?.message || err);
      return null;
    }); 
    */
    // Load existing data first to support fallback
    let existing = {};
    try {
      fs.mkdirSync(EDGAR_DIR, { recursive: true });
      const outPath = path.join(EDGAR_DIR, `${ticker.toUpperCase()}-fundamentals.json`);
      if (fs.existsSync(outPath)) {
        existing = JSON.parse(fs.readFileSync(outPath, "utf8"));
      }
    } catch (err) {
      console.warn("[tickerAssembler] failed to read existing fundamentals snapshot for fallback", err?.message || err);
    }

    // Filing intelligence: fetch with fallback to cache
    let filingSignals = null;
    try {
      filingSignals = await scanFilingForSignals(ticker);
    } catch (err) {
      console.warn("[tickerAssembler] filing signal scan failed", ticker, err?.message || err);
    }

    const resolvedFilingSignals = filingSignals?.signals || existing?.filingSignals || [];
    const resolvedFilingMeta = filingSignals?.meta || existing?.filingSignalsMeta || null;
    const resolvedFilingCachedAt = filingSignals?.cachedAt || existing?.filingSignalsCachedAt || null;
    const defaultFilingProfile = { annual: "10-K", interim: "10-Q", current: "8-K" };
    const filingProfile =
      resolvedFilingMeta?.filingProfile ||
      (resolvedFilingMeta?.latestForm === "20-F" ? { annual: "20-F", interim: "6-K", current: "6-K" } : null) ||
      defaultFilingProfile;
    const issuerType =
      resolvedFilingMeta?.issuerType ||
      (filingProfile?.annual === "20-F" || filingProfile?.interim === "6-K" ? "foreign" : "domestic");
    const annualMode = issuerType === "foreign" && quarterlySeries.length < 2 && annualSeries.length > 0;

    // Fix for ADR Valuations (Moved here to safely use issuerType)
    if (externalMarketCap && externalMarketCap > 0) {
      keyMetrics.marketCap = externalMarketCap;
    } else if (issuerType === "foreign") {
      keyMetrics.marketCap = null;
      keyMetrics.peRatio = null;
      keyMetrics.psRatio = null;
      keyMetrics.pfcfRatio = null;
      keyMetrics.priceToBookRatio = null;
      keyMetrics.pegRatio = null;
    }

    // Currency Mismatch Detection (Moved here)
    let priceCurrency = externalCurrency;
    const reportingCurrency = currency;
    let currencyMismatch = false;

    // Assume USD pricing for foreign ADRs/receipts if provider did not return a currency
    if (!priceCurrency && issuerType === "foreign") {
      priceCurrency = "USD";
    }

    if (priceCurrency && reportingCurrency && priceCurrency !== reportingCurrency && issuerType === "foreign") {
      currencyMismatch = true;
    }

    // Filter out boilerplate Going Concern flags for foreign issuers (not indicative of actual GC risk)
    const filteredFilingSignals = (resolvedFilingSignals || []).filter(
      (s) => !(issuerType === "foreign" && s?.id === "going_concern")
    ).filter((s) => !(ticker.toUpperCase() === "PINS" && s?.id === "reg_investigation"));

    const filingSignalsAgeDays = (() => {
      if (!resolvedFilingCachedAt) return null;
      const ts = Date.parse(resolvedFilingCachedAt);
      if (!Number.isFinite(ts)) return null;
      return (Date.now() - ts) / (1000 * 60 * 60 * 24);
    })();

    const clinicalSetback = detectClinicalSetbackSignal(filteredFilingSignals, sectorBucket);
    const filingSignalsFinal = clinicalSetback
      ? [...filteredFilingSignals, clinicalSetback]
      : filteredFilingSignals;

    const snapshot = buildSnapshot({
      ttm,
      quarterlySeries,
      annualSeries,
      annualMode,
      keyMetrics,
      growth,
      latestBalance,
      shortInterest
    });
    snapshot.currencyMismatch = currencyMismatch;
    snapshot.reportingCurrency = reportingCurrency || null;
    snapshot.priceCurrency = priceCurrency || null;
    const projections = buildProjections({ snapshot, growth, quarterlySeries, annualSeries, annualMode, keyMetrics });
    const financialSeriesForRules = statementQuarterlySeries.length ? statementQuarterlySeries : annualSeries;

    const rating = computeRuleRating({
      ticker: ticker.toUpperCase(),
      sector,
      quarterlySeries: financialSeriesForRules,
      annualSeries,
      annualMode,
      snapshot,
      ttm,
      priceSummary,
      priceHistory,
      growth,
      filingSignals: filingSignalsFinal,
      projections,
      issuerType
    });
    // Filing intelligence handled inside rating now
    let ratingNotes = Array.isArray(rating.missingNotes) ? rating.missingNotes.slice() : [];
    if (snapshot.shareChangeLikelySplit) {
      ratingNotes.push(
        "Large share change detected (likely split) - dilution score adjusted."
      );
    }
    if (snapshot.shareChangeLikelyReverseSplit) {
      ratingNotes.push(
        "Large share reduction detected (likely reverse split) - buyback credit removed."
      );
    }
    if (snapshot.interestCoveragePeriods && snapshot.interestCoveragePeriods < 4 && snapshot.interestCoverage != null) {
      ratingNotes.push(
        `Interest coverage uses limited quarters (${snapshot.interestCoveragePeriods}).`
      );
    }
    if (annualMode) {
      ratingNotes.push("Foreign filer: ratings/solvency/quality use annual (YoY) data; quarterly filings limited.");
    }
    if (currencyMismatch) {
      ratingNotes.push(
        `Cross-currency data: price in ${priceCurrency || "unknown"} but financials in ${reportingCurrency || "unknown"}; valuation ratios may be skewed.`
      );
    }
    if (Number.isFinite(filingSignalsAgeDays) && filingSignalsAgeDays > 7) {
      ratingNotes.push(`Filing intelligence is stale (${Math.round(filingSignalsAgeDays)} days); refresh pending.`);
    }
    rating.missingNotes = ratingNotes;
    const runwayYearsVm = computeRunwayYearsVm({ quarterlySeries: financialSeriesForRules, snapshot, ttm, sector });
    const pennyStockCheck = {
      priceUnder5: (Number.isFinite(priceSummary?.lastClose) && priceSummary.lastClose < 5),
      mcapUnder200M: (Number.isFinite(keyMetrics?.marketCap) && keyMetrics.marketCap < 200_000_000),
      highDilution: (Number.isFinite(percentToNumber(snapshot?.sharesOutChangeYoY)) && percentToNumber(snapshot.sharesOutChangeYoY) > 25),
      shortRunway: (Number.isFinite(runwayYearsVm) && runwayYearsVm < 1)
    };
    const pennyStock = Object.values(pennyStockCheck).some(Boolean);

    if (ticker === "WVE") {
      console.log("[DEBUG WVE PENNY CHECKS]", {
        pennyStockCheck,
        vals: {
          price: priceSummary?.lastClose,
          mcap: keyMetrics?.marketCap,
          dilution: snapshot?.sharesOutChangeYoY,
          runway: runwayYearsVm
        }
      });
    }

    // Persist a lightweight fundamentals snapshot for cache/debug
    try {
      const outPath = path.join(EDGAR_DIR, `${ticker.toUpperCase()}-fundamentals.json`);
      const nowIso = new Date().toISOString();
      // existing read earlier

      const payload = {
        ...existing,
        ticker: ticker.toUpperCase(),
        companyName: fundamentals[0]?.companyName || null,
        sector: sector || null,
        sic: baseSic ?? null,
        currency: currency || null,
        updatedAt: nowIso,
        periods: fundamentals,
        filingSignals: filingSignalsFinal,
        filingSignalsMeta: resolvedFilingMeta,
        filingSignalsCachedAt: resolvedFilingCachedAt || (filingSignals ? nowIso : existing.filingSignalsCachedAt),
        issuerType,
        filingProfile,
        dataBasis: annualMode ? "annual" : "quarterly"
      };
      fs.writeFileSync(outPath, JSON.stringify(payload));
    } catch (err) {
      console.warn("[tickerAssembler] failed to write fundamentals snapshot", err?.message || err);
    }


    function computeMomentumHealth(stock, filingSignals) {
      let score = 50; // Base Neutral
      const revTrend = stock.momentum?.revenueTrend || 0; // YoY trend of quarterly revenue
      const marginTrend = stock.momentum?.marginTrend || 0;
      const rndTrend = stock.momentum?.rndTrend || 0;
      const isHiddenCard = (card) =>
        card?.hidden === true || card?.suppressed === true || card?.includeInScore === false;
      const scoreableFilingSignals = (filingSignals || []).filter((s) => !isHiddenCard(s));

      // 1. Operational Momentum
      if (revTrend > 0.5) score += 15; // Hypergrowth
      else if (revTrend > 0.2) score += 10;
      else if (revTrend > 0.05) score += 5;
      else if (revTrend < -0.1) score -= 10;

      // marginTrend is percentage-points change in operating margin (e.g. +1.2 means +1.2pp).
      if (marginTrend > 1) score += 10; // Expanding margins
      else if (marginTrend < -1) score -= 10;

      // 2. Innovation/Catalyst Proxy (Sector specific)
      const sector = stock.sectorBucket;
      if ((sector === 'Biotech/Pharma' || sector === 'Tech/Internet') && rndTrend > 0.1) {
        score += 5; // Investing in future
      }

      // 3. Filing Sentiment Impact
      const filingScore = scoreableFilingSignals.reduce((acc, s) => acc + (s.score || 0), 0);
      // Cap filing impact to +/- 20
      score += Math.max(-20, Math.min(20, filingScore));

      return Math.max(0, Math.min(100, score));
    }

    function generateDynamicNarrative({
      stock,
      trends,
      filingSignals,
      pennyStock,
      scoreBand,
      metrics,
      strategicOutlook,
      seedTicker
    }) {
      const parts = [];
      const sector = stock.sectorBucket;
      const fcfMargin = metrics.fcfMargin || 0;
      const revGrowth = metrics.revenueGrowth || 0;
      const marketCap = toNumber(stock?.marketCap);
      const assetSize = toNumber(stock?.financialPosition?.totalAssets);
      const capexToRev = toNumber(stock?.cash?.capexToRevenue) ?? 0;

      const hashString = (str) => {
        // Deterministic 32-bit hash (FNV-1a)
        const s = String(str ?? "");
        let h = 0x811c9dc5;
        for (let i = 0; i < s.length; i++) {
          h ^= s.charCodeAt(i);
          h = Math.imul(h, 0x01000193);
        }
        return h >>> 0;
      };

      const pick = (key, choices) => {
        const list = Array.isArray(choices) ? choices.filter(Boolean) : [];
        if (!list.length) return null;
        const seed = `${String(seedTicker || stock?.ticker || stock?.identity?.ticker || "NA").toUpperCase()}|${key}`;
        return list[hashString(seed) % list.length];
      };

      const isBalancedCompounder = revGrowth > 15 && fcfMargin > 10;
      const isMatureCashCow = revGrowth < 5 && fcfMargin > 15;

      const isHiddenCard = (card) =>
        card?.hidden === true || card?.suppressed === true || card?.includeInScore === false;
      const visibleFilingSignals = (filingSignals || []).filter((s) => !isHiddenCard(s));

      // Classify company scale
      const isMegaCap = marketCap > 200e9 || assetSize > 500e9;
      const isLargeCap = !isMegaCap && (marketCap > 10e9 || assetSize > 10e9);
      const isMidCap = !isLargeCap && (marketCap > 1e9 || assetSize > 500e6);
      const isSmallCap = !isMidCap && (marketCap > 200e6 || assetSize > 100e6);

      // ========== 1. EFFICIENCY / CASH FLOW NARRATIVE ==========

      // For MEGA/LARGE CAPS: Focus on operational excellence, not "burn"
      if (isMegaCap || isLargeCap) {
        // Avoid stacking cash-flow blurbs with the Growth-vs-Profitability section.
        if (!isBalancedCompounder && !isMatureCashCow) {
          if (fcfMargin > 20) {
            parts.push(
              pick("efficiency.megacap.fcfStrong", [
                "Industry-leading cash generation with strong margin profile.",
                "Best-in-class cash generation and operating discipline.",
                "Strong cash conversion and consistently healthy margins.",
                "Robust free cash flow profile with high operating leverage."
              ])
            );
          } else if (fcfMargin > 10) {
            parts.push(
              pick("efficiency.megacap.fcfSolid", [
                "Solid free cash flow generation supporting sustainable operations.",
                "Consistent free cash flow supports a durable operating model.",
                "Healthy cash generation provides strategic flexibility.",
                "Cash generation remains solid, supporting reinvestment and resilience."
              ])
            );
          } else if (fcfMargin > 0 && fcfMargin <= 10) {
            parts.push(
              pick("efficiency.megacap.fcfThin", [
                "Positive cash flows, though efficiency could be optimized.",
                "Cash flow is positive, but margin efficiency looks mid-cycle.",
                "Generating cash, though operating efficiency appears pressured.",
                "Positive free cash flow, but there is room for margin improvement."
              ])
            );
          } else if (fcfMargin < 0 && revGrowth > 15) {
            parts.push(
              pick("efficiency.megacap.invest", [
                "Investing for growth: Near-term free cash flow is suppressed by expansion initiatives.",
                "Growth investment cycle: Cash flow is pressured while scaling initiatives ramp.",
                "Near-term cash flow is constrained as the business invests to accelerate growth.",
                "Expansion spending is weighing on near-term free cash flow."
              ])
            );
          } else if (fcfMargin < -10) {
            parts.push(
              pick("efficiency.megacap.concern", [
                "Operating efficiency concerns: Cash flows are negative despite scale.",
                "Scale is not translating into cash generation; efficiency looks challenged.",
                "Cash flow profile is weak for the company’s size.",
                "Efficiency is under pressure, with negative cash flows at scale."
              ])
            );
          }
        }
      }
      // For SMALL/MID CAPS: Use burn language where appropriate
      else {
        if (trends.burnTrend > 0.15 && fcfMargin < 0) {
          parts.push(
            pick("efficiency.smallcap.burnNarrowing", [
              "Cash burn is narrowing, indicating improved operational efficiency.",
              "Burn rate is moderating, suggesting improving operating discipline.",
              "Cash burn appears to be easing, pointing to better cost control.",
              "Operating burn is improving, indicating progress toward sustainability."
            ])
          );
        } else if (trends.burnTrend < -0.15 && fcfMargin < -20) {
          parts.push(
            pick("efficiency.smallcap.burnWorsening", [
              "Cash burn is accelerating.",
              "Burn rate is increasing, raising near-term funding risk.",
              "Cash outflows are widening, pressuring the balance sheet.",
              "Burn is picking up, increasing execution and financing risk."
            ])
          );
        } else if (fcfMargin > 10 && !isBalancedCompounder && !isMatureCashCow) {
          parts.push(
            pick("efficiency.smallcap.cashPositive", [
              "Cash flow positive with healthy margin.",
              "Positive free cash flow supports self-funded operations.",
              "Healthy cash generation reduces reliance on external financing.",
              "Cash generation looks healthy, supporting operational flexibility."
            ])
          );
        }
      }

      // ========== 2. GROWTH VS PROFITABILITY ==========

      // GROWTH-PHASE (Mid/Large-caps investing heavily)
      if (!pennyStock && revGrowth > 30 && capexToRev > 50 && fcfMargin < -20) {
        parts.push("Expansion mode: Deploying significant capital into infrastructure to scale rapidly.");
      }
      // HYPERGROWTH UNPROFITABLE (Smaller companies)
      else if (revGrowth > 40 && fcfMargin < 0) {
        if (sector === 'Biotech/Pharma') {
          parts.push("R&D-intensive development phase: Prioritizing pipeline advancement over near-term profitability.");
        } else if (sector === 'Tech/Internet') {
          parts.push("Aggressive growth phase: Investing heavily in customer acquisition and platform development.");
        } else if (isMidCap || isLargeCap) {
          parts.push("High-growth investment phase: Revenue scaling rapidly while building operational infrastructure.");
        } else {
          parts.push("Unprofitable growth: Revenue is surging, but at the cost of deep cash flow deficits.");
        }
      }
      // MATURE CASH COWS
      else if (revGrowth < 5 && fcfMargin > 15) {
        if (isMegaCap || isLargeCap) {
          parts.push(
            pick("growth.mature.large", [
              "Mature blue-chip: Stable operations generating consistent free cash flow for shareholders.",
              "Mature profile: Stable revenue base with reliable shareholder cash generation.",
              "Established leader: Cash generation is steady, supporting long-term resilience.",
              "Steady-state operator: Consistent cash flows and disciplined execution."
            ])
          );
        } else {
          parts.push(
            pick("growth.mature.small", [
              "Mature profile: Revenue is soft, but the business generates healthy free cash flow.",
              "Mature operator: Growth is muted, but free cash flow remains healthy.",
              "Cash-generative profile despite limited top-line growth.",
              "Stable, cash-generating business with modest revenue momentum."
            ])
          );
        }
      }
      // BALANCED COMPOUNDERS
      else if (revGrowth > 15 && fcfMargin > 10) {
        parts.push(
          pick("growth.balanced", [
            "Balanced compounder: Delivering both double-digit growth and healthy cash flows.",
            "Efficient growth profile: Strong revenue expansion paired with healthy cash generation.",
            "Quality growth: Double-digit top-line gains with positive cash flow support.",
            "Growth with discipline: Strong expansion while maintaining healthy cash generation."
          ])
        );
      }
      // DECLINING + UNPROFITABLE
      else if (revGrowth < -5 && fcfMargin < 0) {
        parts.push("Deteriorating fundamentals: Revenue is shrinking while cash flows remain negative.");
      }
      // STAGNANT
      else if (Math.abs(revGrowth) < 5 && Math.abs(fcfMargin) < 5) {
        if (isMegaCap || isLargeCap) {
          parts.push("Stable operations with modest growth and profitability.");
        } else {
          parts.push("Limited growth momentum; fundamentals appear range-bound.");
        }
      }

      // ========== 3. FILING SIGNALS ==========
      const posSignals = visibleFilingSignals.filter((s) => s.score > 0).length;
      const negSignals = visibleFilingSignals.filter((s) => s.score < 0).length;

      if (posSignals > negSignals && posSignals > 0) {
        parts.push(
          pick("filings.positive", [
            "Regulatory filings suggest positive underlying momentum.",
            "Recent filings read constructively on operating momentum.",
            "Filings point to a generally favorable operating tone.",
            "Regulatory disclosures indicate improving underlying momentum."
          ])
        );
      } else if (negSignals > posSignals && negSignals > 0) {
        // Specific flags
        const hasDilution = visibleFilingSignals.some((s) => s.id === "dilution_risk");
        const hasGoingConcern = visibleFilingSignals.some((s) => s.id === "going_concern");
        const hasRestatement = visibleFilingSignals.some((s) => s.id === "restatement");

        if (hasGoingConcern) {
          parts.push(
            pick("filings.goingConcern", [
              "Filings contain going concern warnings from auditors.",
              "Auditor language in filings raises going-concern concerns.",
              "Regulatory disclosures include going-concern cautionary language.",
              "Filings raise going-concern risk, indicating elevated financial uncertainty."
            ])
          );
        } else if (hasRestatement) {
          parts.push(
            pick("filings.restatement", [
              "Recent financial restatements raise accounting quality concerns.",
              "Restatement activity suggests elevated reporting-quality risk.",
              "Recent restatements introduce accounting and controls risk.",
              "Accounting restatements raise questions around reporting quality."
            ])
          );
        } else if (hasDilution && !isMegaCap) {
          parts.push(
            pick("filings.dilution", [
              "Filings indicate potential shareholder dilution.",
              "Regulatory filings highlight ongoing dilution risk.",
              "Disclosures suggest potential equity issuance and dilution risk.",
              "Filing language points to possible share dilution."
            ])
          );
        } else {
          parts.push(
            pick("filings.negative", [
              "Regulatory filings contain recent risk factors.",
              "Recent filings surface incremental risk disclosures.",
              "Filings highlight material risks worth monitoring.",
              "Regulatory disclosures include additional risk factors."
            ])
          );
        }
      }

      // ========== 4. PENNY STOCK / DISTRESS FLAGS ==========
      if (pennyStock) {
        if (Number.isFinite(metrics.runway) && metrics.runway < 0.75) {
          parts.push(
            pick("penny.runwayShort", [
              "Speculative: Extremely short cash runway creates high financing risk.",
              "Speculative: Limited cash runway increases near-term financing risk.",
              "High risk: Short runway raises the probability of additional funding needs.",
              "Speculative: Cash runway is thin, elevating refinancing and dilution risk."
            ])
          );
        } else if (metrics.dilution > 50) {
          parts.push(
            pick("penny.dilutionHeavy", [
              "Heavy dilution: Micro-cap structure relying heavily on equity financing.",
              "Heavy dilution risk: Equity issuance appears to be a key funding lever.",
              "Micro-cap funding risk: Significant dilution suggests frequent equity financing.",
              "Dilution-heavy profile: Equity financing appears to play an outsized role."
            ])
          );
        } else if (metrics.fcfMargin < -50) {
          parts.push(
            pick("penny.highBurn", [
              "Micro-cap profile: High volatility and burn rate create execution risk.",
              "Micro-cap risk: High volatility and heavy burn increase execution risk.",
              "Speculative micro-cap: High burn rate raises execution and financing risk.",
              "High-risk micro-cap: Volatility and burn elevate downside risk."
            ])
          );
        } else {
          parts.push(
            pick("penny.generic", [
              "Micro-cap profile: Volatility expected, but balance sheet appears stable.",
              "Micro-cap volatility expected; financial position looks broadly stable.",
              "Micro-cap risk: Price volatility is likely, but finances appear stable.",
              "Micro-cap characteristics: Volatile trading, with a relatively stable balance sheet."
            ])
          );
        }
      } else if (scoreBand === 'danger' && !isMidCap && strategicOutlook?.trajectory?.regime !== "growth-phase") {
        parts.push(
          pick("distress.generic", [
            "Financial position appears distressed.",
            "Balance sheet stress is elevated relative to peers.",
            "Financial profile looks stressed, increasing downside risk.",
            "Balance sheet appears strained, limiting flexibility."
          ])
        );
      }

      // Deduplicate and join
      return [...new Set(parts)].join(" ");
    }

    const stock = buildStockForRules({
      ticker: ticker.toUpperCase(),
      sector,
      quarterlySeries: financialSeriesForRules,
      annualSeries,
      snapshot,
      ttm,
      priceSummary,
      growth
    });

    const momentumScore = computeMomentumHealth(
      { momentum: stock.momentum, sectorBucket: stock.sectorBucket },
      filingSignalsFinal
    );

    // Construct simplified metrics for narrative
    const navMetrics = {
      revenueGrowth: percentToNumber(stock.growth?.revenueGrowthTTM),
      fcfMargin: percentToNumber(stock.profitMargins?.fcfMargin),
      runway: stock.financialPosition.runwayYears,
      dilution: percentToNumber(stock.shareStats?.sharesChangeYoY)
    };

    // Strategic Outlook: keep projections (statistical) and expose a separate, explainable outlook object (behavioral).
    // MUST be computed BEFORE narrative generation so narrative can use trajectory.regime
    const strategicOutlook = computeStrategicOutlook({
      stock,
      snapshot,
      filingSignals: filingSignalsFinal,
      momentumScore
    });
    projections.operationalMomentumScore = strategicOutlook?.operationalMomentum?.score01 ?? null;
    projections.operationalMomentumLabel = strategicOutlook?.operationalMomentum?.label ?? null;

    const narrativeWrapper = generateDynamicNarrative({
      stock,
      trends: stock.momentum,
      filingSignals: filingSignalsFinal,
      pennyStock,
      scoreBand: rating.tierLabel,
      metrics: navMetrics,
      strategicOutlook,
      seedTicker: ticker.toUpperCase()
    });

    const dataCompleteness = normalizeCompleteness(rating.completeness);
    const confidenceMeta = deriveConfidenceLevel({
      completenessPercent: dataCompleteness.percent,
      lastFiledDate: latestFiledDate,
      pricePending
    });
    const suppressedRiskReasons = new Set([
      "operating margin",
      "operating margin (health)",
      "operating margin (industrial)",
      "interest coverage"
    ]);

    const vm = {
      ticker: ticker.toUpperCase(),
      companyName: fundamentals[0]?.companyName || undefined,
      currency: currency || undefined,
      priceHistory,
      priceSummary,
      pricePending,
      quarterlySeries,
      annualSeries,
      ttm,
      keyMetrics,
      snapshot,
      projections,
      growth,
      cash: stock.cash,
      expenses: stock.expenses,
      taxes: stock.taxes,
      ratingRawScore: rating.rawScore,
      ratingNormalizedScore: rating.normalizedScore,
      ratingTierLabel: rating.tierLabel,
      ratingUpdatedAt: rating.updatedAt,
      ratingReasons: rating.reasons,
      ratingCompleteness: rating.completeness,
      ratingBasis: annualMode ? "annual" : "quarterly",
      annualMode,
      ratingNotes,
      dataCompleteness,
      confidence: confidenceMeta.level,
      confidenceMeta,
      // Populate riskFactors with all negative items for visibility
      riskFactors: rating.reasons
        .filter((r) => r.score < 0 && !r.missing && !r.notApplicable)
        .filter((r) => !suppressedRiskReasons.has(String(r.name || "").toLowerCase()))
        .sort((a, b) => (a.score || 0) - (b.score || 0))
        .map((r) => (r.message ? `${r.name}: ${r.message}` : r.name)),
      pennyStock,
      filingSignals: filingSignalsFinal,
      filingProfile,
      issuerType,
      filingSignalsMeta: resolvedFilingMeta,
      fundamentalsAsOf: ttm?.asOf ?? latestEnd ?? null,
      lastFilingDate: latestFiledDate,
      priceAsOf: priceSummary?.lastCloseDate ?? null,
      sector: sector || null,
      sic: baseSic ?? null,
      narrative: narrativeWrapper,
      momentumScore,
      strategicOutlook,
      dataQuality: stock.dataQuality,
      ratingNotes: (() => {
        // Merge data quality warnings into rating notes
        const dqNotes = [];
        if (stock.dataQuality?.mismatchedPeriods) {
          dqNotes.push(`Data Warning: Mismatched reporting periods detected (Income: ${stock.dataQuality.incomeDate}, Balance: ${stock.dataQuality.balanceDate}).`);
        }
        stock.dataQuality?.materialMismatches?.forEach(m => {
          dqNotes.push(`Data Warning: ${m.metric} - ${m.details}`);
        });
        return [...(ratingNotes || []), ...dqNotes];
      })()
    };
    console.log("[tickerAssembler] built view model", {
      ticker: vm.ticker,
      periods: fundamentals.length,
      pricePoints: vm.priceHistory.length,
      narrative: vm.narrative
    });
    return vm;
  } catch (err) {
    console.error("[tickerAssembler] error building view model for", ticker, err);
    return null;
  }
}
