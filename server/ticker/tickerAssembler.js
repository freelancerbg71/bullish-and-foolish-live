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
  percentToNumber
} from "../../scripts/shared-rules.js";
import { scanFilingForSignals } from "../edgar/filingTextScanner.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const EDGAR_DIR = path.join(ROOT, "data", "edgar");
const RISK_FREE_RATE_PCT = 4.5; // Placeholder for 10Y Treasury Yield or similar

const SAFE_THRESHOLD = 0.000001;

function safeDiv(a, b) {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(y) < SAFE_THRESHOLD) return null;
  return x / y;
}

function formatQuarterLabel(dateStr) {
  const d = new Date(dateStr);
  if (!Number.isFinite(d.getTime())) return dateStr;
  const month = d.getUTCMonth();
  const year = d.getUTCFullYear();
  const q = Math.floor(month / 3) + 1;
  return `Q${q} ${year}`;
}

function toQuarterlySeries(periods) {
  const quarters = periods
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
    const derivedGross = p.grossProfit == null && p.revenue != null && costOfRevenue != null
      ? p.revenue - costOfRevenue
      : p.grossProfit ?? null;
    return {
      periodEnd: p.periodEnd,
      label: formatQuarterLabel(p.periodEnd),
      sector: p.sector ?? null,
      sic: p.sic ?? null,
      sicDescription: p.sicDescription ?? null,
      revenue: p.revenue ?? null,
      grossProfit: derivedGross,
      operatingIncome: p.operatingIncome ?? null,
      netIncome: p.netIncome ?? null,
      epsBasic: p.epsBasic ?? null,
      sharesOutstanding: p.sharesOutstanding ?? p.shares ?? null,
      totalAssets: p.totalAssets ?? null,
      totalLiabilities: p.totalLiabilities ?? null,
      totalEquity: p.totalEquity ?? null,
      totalDebt: p.totalDebt ?? null,
      financialDebt: p.financialDebt ?? null,
      shortTermDebt: p.shortTermDebt ?? null,
      leaseLiabilities: p.leaseLiabilities ?? null,
      shortTermInvestments: p.shortTermInvestments ?? null,
      interestExpense: p.interestExpense ?? null,
      cash: p.cashAndCashEquivalents ?? p.cash ?? null,
      operatingCashFlow: p.operatingCashFlow ?? null,
      capex: p.capex ?? null,
      shareBasedCompensation: p.shareBasedCompensation ?? null,
      researchAndDevelopmentExpenses: p.researchAndDevelopmentExpenses ?? null,
      freeCashFlow: fcf
    };
  });
}

function buildTtmFromQuarters(quarters) {
  const latest4 = quarters.slice(-4);
  if (latest4.length < 4) return null;
  const sum = (field) =>
    latest4.reduce((acc, q) => (Number.isFinite(q[field]) ? acc + Number(q[field]) : acc), 0);
  const revenue = sum("revenue");
  const netIncome = sum("netIncome");
  const fcf = latest4.reduce((acc, q) => {
    const val = Number.isFinite(q.freeCashFlow)
      ? Number(q.freeCashFlow)
      : Number.isFinite(q.operatingCashFlow) && Number.isFinite(q.capex)
        ? Number(q.operatingCashFlow) - Math.abs(Number(q.capex))
        : null;
    return val != null ? acc + val : acc;
  }, 0);
  const epsBasic = sum("epsBasic");
  const asOf = latest4[latest4.length - 1].periodEnd;
  return {
    asOf,
    revenue: Number.isFinite(revenue) ? revenue : null,
    netIncome: Number.isFinite(netIncome) ? netIncome : null,
    epsBasic: Number.isFinite(epsBasic) ? epsBasic : null,
    freeCashFlow: Number.isFinite(fcf) ? fcf : null
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
  if (years.length < 4) return { revenueCagr3y: null, epsCagr3y: null };
  const latest = years[0];
  const older = years[3];
  const revenueCagr3y =
    older && latest ? calcCagr(latest.revenue ?? null, older.revenue ?? null, 3) : null;
  const epsCagr3y =
    older && latest ? calcCagr(latest.epsBasic ?? null, older.epsBasic ?? null, 3) : null;
  return { revenueCagr3y, epsCagr3y };
}

function buildPricePieces(prices) {
  // Ensure we consistently use the "previous" close relative to New York time
  // This filters out any intraday/live entries datestamped with "today"
  const nyDate = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

  const history = [...prices]
    .filter(p => p.date < nyDate) // Strictly prior to today in NY
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));

  const trimmed = history.slice(-400); // keep ~last 400 days to cover prior close + 52w range without bloating payloads
  const last = trimmed[trimmed.length - 1] || null;
  const prev = trimmed[trimmed.length - 2] || null;
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
  const usable = sorted.filter(
    (q) => Number.isFinite(q.operatingIncome) && (Number.isFinite(q.interestExpense) || Number.isFinite(q.totalDebt))
  );
  if (usable.length < 2) return { value: null, periods: usable.length };

  const ebit = usable.reduce((acc, q) => acc + Number(q.operatingIncome), 0);
  const interest = usable.reduce((acc, q) => acc + Math.abs(Number(q.interestExpense || 0)), 0);

  // If interest is effectively zero, check debt.
  if (interest < 1) {
    // If we have debt data and it's low, coverage is infinite.
    const lastQ = usable[0];
    const debt = Number(lastQ.totalDebt || 0);
    if (debt < 1e6) return { value: Infinity, periods: usable.length }; // Effectively debt free
  }

  if (!Number.isFinite(ebit) || !Number.isFinite(interest) || interest === 0) {
    if (interest === 0) return { value: Infinity, periods: usable.length };
    return { value: null, periods: usable.length };
  }
  return { value: ebit / interest, periods: usable.length };
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

function computeShareChangeWithSplitGuard(quartersDesc) {
  const series = [...(quartersDesc || [])]
    .filter((q) => q && q.periodEnd && Number.isFinite(q.sharesOutstanding ?? q.shares))
    .sort((a, b) => Date.parse(b.periodEnd) - Date.parse(a.periodEnd));
  const latest = series[0] || null;
  const prev = series[1] || null;
  const yearAgo = series[4] || null;
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
  let adjustedYoY = rawYoY;
  const ratioFromSignal = splitSignal?.sharesRatio ?? null;
  if (ratioFromSignal && ratioFromSignal >= 2 && rawYoY != null) {
    adjustedYoY = null; // treat as split-driven jump; skip dilution penalty
  }
  return {
    changeQoQ: rawQoQ,
    changeYoY: adjustedYoY,
    rawYoY,
    splitSignal
  };
}

// ---------- Rating helpers (shared-rule pipeline on the server) ----------
const RATING_MIN = -40;
const RATING_MAX = 60;

function normalizeRuleScore(score) {
  const num = Number(score);
  if (!Number.isFinite(num)) return null;
  const clamped = Math.max(RATING_MIN, Math.min(RATING_MAX, num));
  const span = RATING_MAX - RATING_MIN || 1;
  return ((clamped - RATING_MIN) / span) * 100;
}

function getScoreBand(val) {
  const v = Number(val) || 0;
  if (v >= 90) return "elite";
  if (v >= 75) return "bullish";
  if (v >= 60) return "solid";
  if (v >= 45) return "mixed";
  if (v >= 30) return "spec";
  return "danger";
}

function pctChange(curr, prev) {
  if (!Number.isFinite(curr) || !Number.isFinite(prev) || prev === 0) return null;
  return ((curr - prev) / Math.abs(prev)) * 100;
}

function calcMargin(num, den) {
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
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
  const latest = [...(vm.quarterlySeries || [])]
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

  const valNow = Number(latestQ[field]);
  const valPrior = Number(priorY[field]);

  if (!Number.isFinite(valNow) || !Number.isFinite(valPrior) || valPrior === 0) return null;
  return (valNow - valPrior) / Math.abs(valPrior);
}

function buildStockForRules(vm) {
  const quartersDesc = [...(vm.quarterlySeries || [])].sort(
    (a, b) => Date.parse(b.periodEnd) - Date.parse(a.periodEnd)
  );
  const income = quartersDesc.map((q) => ({
    date: q.periodEnd,
    revenue: q.revenue,
    grossProfit: q.grossProfit,
    operatingIncome: q.operatingIncome,
    netIncome: q.netIncome,
    eps: q.epsBasic,
    epsdiluted: q.epsBasic,
    epsDiluted: q.epsBasic
  }));
  const balance = quartersDesc.map((q) => ({
    date: q.periodEnd,
    cashAndCashEquivalents: q.cash ?? q.cashAndCashEquivalents,
    totalDebt: q.totalDebt,
    financialDebt: q.financialDebt,
    leaseLiabilities: q.leaseLiabilities,
    totalStockholdersEquity: q.totalEquity,
    totalAssets: q.totalAssets,
    totalLiabilities: q.totalLiabilities,
    commonStockSharesOutstanding: q.sharesOutstanding,
    shortTermInvestments: q.shortTermInvestments,
    interestExpense: q.interestExpense ?? null
  }));
  const cashArr = quartersDesc.map((q) => ({
    date: q.periodEnd,
    netCashProvidedByOperatingActivities: q.operatingCashFlow,
    operatingCashFlow: q.operatingCashFlow,
    capitalExpenditure: q.capex,
    fcfComputed:
      q.freeCashFlow != null
        ? q.freeCashFlow
        : q.operatingCashFlow != null && q.capex != null
          ? q.operatingCashFlow - Math.abs(q.capex ?? 0)
          : null
  }));
  const curInc = income[0] || {};
  const prevInc = income[1] || {};
  const curBal = balance[0] || {};
  const prevBal = balance[1] || {};
  const curCf = cashArr[0] || {};
  const prevCf = cashArr[1] || {};
  const shareChangeMeta = computeShareChangeWithSplitGuard(quartersDesc);
  const interestCoverageMeta = computeInterestCoverageTtm(quartersDesc);
  const revGrowth = pctChange(toNumber(curInc.revenue), toNumber(prevInc.revenue));
  const sharesChange = shareChangeMeta.changeQoQ;
  const sharesChangeYoY = shareChangeMeta.changeYoY;
  const fcf = calcFcf(curCf);
  const fcfMargin = calcMargin(fcf, toNumber(curInc.revenue));
  const prevFcf = calcFcf(prevCf);
  const prevFcfMargin = prevCf ? calcMargin(prevFcf, toNumber(prevInc.revenue)) : null;
  const profitGrowth = pctChange(toNumber(curInc.netIncome), toNumber(prevInc.netIncome));
  const fcfTrend = pctChange(fcfMargin, prevFcfMargin);
  const fcfYears =
    fcf && toNumber(curBal.totalDebt) && fcf > 0
      ? toNumber(curBal.totalDebt) / (fcf * 4)
      : null;
  const roe = pctFromRatio(
    calcMargin(toNumber(curInc.netIncome), toNumber(curBal.totalStockholdersEquity))
  );
  const investedCapital =
    Number.isFinite(curBal.totalEquity) && Number.isFinite(curBal.totalDebt) && Number.isFinite(curBal.cashAndCashEquivalents)
      ? curBal.totalEquity + curBal.totalDebt - curBal.cashAndCashEquivalents
      : null;
  const roic = calcMargin(toNumber(curInc.netIncome), investedCapital);
  const interestCoverage =
    interestCoverageMeta.value != null
      ? interestCoverageMeta.value
      : Number.isFinite(curBal.interestExpense) && Number.isFinite(curInc.operatingIncome) && curBal.interestExpense !== 0
        ? curInc.operatingIncome / Math.abs(curBal.interestExpense)
        : vm?.snapshot?.interestCoverage ?? null;
  const capexToRev = calcMargin(toNumber(curCf.capitalExpenditure), toNumber(curInc.revenue));
  const grossMargin = calcMargin(toNumber(curInc.grossProfit), toNumber(curInc.revenue));
  const opMargin = calcMargin(toNumber(curInc.operatingIncome), toNumber(curInc.revenue));
  const prevOpMargin = calcMargin(Number(prevInc.operatingIncome), Number(prevInc.revenue));
  const marginTrend = pctChange(opMargin, prevOpMargin);
  const netMargin = calcMargin(toNumber(curInc.netIncome), toNumber(curInc.revenue));
  const netDebt = (() => {
    const cashBal = toNumber(curBal.cashAndCashEquivalents);
    const stiBal = toNumber(curBal.shortTermInvestments);
    const debtBal = toNumber(curBal.totalDebt);
    if (!Number.isFinite(debtBal)) return null;
    const cashTotal = (Number.isFinite(cashBal) ? cashBal : 0) + (Number.isFinite(stiBal) ? stiBal : 0);
    return debtBal - cashTotal;
  })();
  const debtToEquity = toNumber(
    curBal.totalDebt && curBal.totalStockholdersEquity
      ? curBal.totalDebt / curBal.totalStockholdersEquity
      : null
  );
  const netDebtToEquity =
    Number.isFinite(netDebt) && Number.isFinite(toNumber(curBal.totalStockholdersEquity))
      ? netDebt / toNumber(curBal.totalStockholdersEquity)
      : debtToEquity;

  const lastClose = vm?.priceSummary?.lastClose != null ? Number(vm.priceSummary.lastClose) : null;
  const marketCap = vm?.snapshot?.marketCap != null ? Number(vm.snapshot.marketCap) : (lastClose != null && curBal.commonStockSharesOutstanding != null ? lastClose * curBal.commonStockSharesOutstanding : null);

  return {
    ticker: vm.ticker,
    companyName: vm.companyName,
    sector: vm.sector,
    sic: vm.sic ?? vm.snapshot?.sic,
    sicDescription: vm.sicDescription ?? vm.snapshot?.sicDescription,
    marketCap,
    sectorBucket: resolveSectorBucket(vm.sector),
    growth: {
      revenueGrowthTTM: revGrowth,
      revenueCagr3y: vm?.snapshot?.revenueCAGR3Y ?? vm?.growth?.revenueCagr3y ?? null,
      epsCagr3y: vm?.growth?.epsCagr3y ?? null,
      perShareGrowth: null
    },
    momentum: {
      marginTrend,
      fcfTrend,
      grossMarginPrev: null,
      burnTrend: calcTrend(vm.quarterlySeries, 'freeCashFlow'),
      rndTrend: calcTrend(vm.quarterlySeries, 'researchAndDevelopmentExpenses'),
      revenueTrend: calcTrend(vm.quarterlySeries, 'revenue'),
      sgaTrend: calcTrend(vm.quarterlySeries, 'sellingGeneralAndAdministrativeExpenses')
    },
    profitGrowthTTM: profitGrowth,
    stability: { growthYearsCount: null, fcfPositiveYears: cashArr.filter((r) => calcFcf(r) > 0).length },
    profitMargins: {
      grossMargin,
      operatingMargin: opMargin,
      profitMargin: netMargin,
      fcfMargin,
      netIncome: toNumber(curInc.netIncome)
    },
    financialPosition: {
      currentRatio: null,
      quickRatio: null,
      debtToEquity,
      netDebtToEquity,
      debtToEbitda: null,
      debtToFCF: null,
      interestCoverage,
      netDebtToFcfYears: netDebt != null && Number.isFinite(fcf) && fcf > 0 ? netDebt / (fcf * 4) : fcfYears,
      netCashToPrice: null,
      runwayYears: computeRunwayYearsVm(vm),
      totalDebt: curBal.totalDebt,
      financialDebt: curBal.financialDebt,
      leaseLiabilities: curBal.leaseLiabilities,
      totalAssets: curBal.totalAssets,
      cash: curBal.cashAndCashEquivalents,
      interestExpense: curBal.interestExpense
    },
    returns: { roe, roic },
    cash: {
      cashConversion:
        fcf != null && toNumber(curInc.netIncome) ? fcf / toNumber(curInc.netIncome) : null,
      capexToRevenue: capexToRev
    },
    shareStats: {
      sharesOutstanding: curBal.commonStockSharesOutstanding,
      sharesChangeYoY,
      sharesChangeQoQ: sharesChange,
      sharesChangeYoYRaw: shareChangeMeta.rawYoY,
      likelySplit: !!shareChangeMeta.splitSignal,
      insiderOwnership: null,
      institutionOwnership: null,
      float: null
    },
    valuationRatios: {
      peRatio:
        lastClose != null && curInc.epsBasic > 0
          ? lastClose / curInc.epsBasic
          : null,
      forwardPE: null,
      psRatio:
        marketCap != null && toNumber(curInc.revenue) > 0
          ? marketCap / toNumber(curInc.revenue)
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
        marketCap != null && fcf > 0
          ? marketCap / fcf
          : null,
      pegRatio: null,
      evToEbitda: null,
      fcfYield:
        marketCap != null && fcf != null
          ? fcf / marketCap
          : null
    },
    expenses: {
      rdToRevenue: calcMargin(
        toNumber(curInc.researchAndDevelopmentExpenses),
        toNumber(curInc.revenue)
      ),
      rdSpend: toNumber(curInc.researchAndDevelopmentExpenses),
      revenue: toNumber(curInc.revenue)
    },
    capitalReturns: { shareholderYield: null, totalYield: null },
    dividends: { payoutToFcf: null, growthYears: null },
    priceStats: {}, // decouple rating from price-derived momentum while price worker is beta
    scores: { altmanZ: null, piotroskiF: null },
    ownerEarnings: null,
    ownerIncomeBase: toNumber(curInc.netIncome),
    lastUpdated: curInc.date || "n/a"
  };
}

function computeRuleRating({
  ticker,
  sector,
  quarterlySeries,
  snapshot,
  ttm,
  priceSummary,
  growth,
  filingSignals,
  projections
}) {
  const stock = buildStockForRules({ ticker, sector, quarterlySeries, snapshot, ttm, priceSummary, growth });
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
  const pennyStock =
    (!isBio && Number.isFinite(lastClose) && lastClose < 5) ||
    (!isBio && Number.isFinite(marketCap) && marketCap > 0 && marketCap < 200_000_000) ||
    (isBio && Number.isFinite(marketCap) && marketCap > 0 && marketCap < 50_000_000) ||
    (Number.isFinite(dilutionYoY) && dilutionYoY > 25) ||
    (Number.isFinite(runwayYears) && runwayYears < 1);
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
    if (n.includes("margin") || n.includes("roe") || n.includes("roic") || n.includes("return")) return "profitability";
    if (n.includes("growth") || n.includes("trend") || n.includes("cagr")) return "growth";
    return "other";
  };
  rules.forEach((rule) => {
    const outcome = rule.evaluate(stock, metrics);
    const baseScore = outcome?.score ?? 0;
    const sectorTuning = applySectorRuleAdjustments(rule.name, baseScore, sectorBucket);
    const score = sectorTuning?.score ?? baseScore;

    // Define skipped early so logging can use it
    const skipped = outcome?.missing || sectorTuning?.skipped;
    // EXPOSE DETAIL FOR DEBUGGING
    console.log(`[RULES] ${ticker} Rule: ${rule.name} | Score: ${score} | Msg: ${outcome?.message}`);

    let appliedScore = score;
    let reasonMessage = outcome?.message || rule.name;
    const notApplicable = outcome?.notApplicable || sectorTuning?.skipped;

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

    if (pennyStock && rule.name === "Operating margin" && Number.isFinite(opMarginVal) && opMarginVal <= -50) {
      appliedScore = Math.min(appliedScore, -Math.max(12, Math.abs(rule.weight ?? 0)));
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
    if (!skipped) {
      total += appliedScore;
    } else {
      missingCategories[classifyMissing(rule.name)].push(rule.name);
      // If critical rule is missing, flag it but DO NOT apply penalty points.
      if (criticalRules.has(rule.name) && !notApplicable) {
        missingCritical = true;
        criticalMissingFields.push(rule.name);
      }
      appliedScore = 0;
    }
    if (skipped && !notApplicable) missingCount += 1;

    reasons.push({
      name: rule.name,
      score: appliedScore,
      message: reasonMessage,
      missing: skipped,
      notApplicable,
      weight: rule.weight
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
    const filingModifier = filingSignals.reduce((acc, s) => acc + (s.score || 0), 0);
    if (filingModifier !== 0) {
      total += filingModifier;
      if (filingModifier <= -5) {
        overrideNotes.push(`Regulatory filings signal caution (Net impact: ${filingModifier} pts).`);
      } else if (filingModifier >= 3) {
        overrideNotes.push(`Regulatory filings suggest positive underlying momentum (Net impact: +${filingModifier} pts).`);
      }
    }
  }

  let normalized = normalizeRuleScore(total);
  console.log(`[RATING FINAL] ${ticker} | RAW: ${total} | NORM: ${normalized ? normalized.toFixed(1) : 'N/A'} | TIER: ${getScoreBand(normalized)} | PENNY: ${pennyStock}`);
  if (missingCritical) console.log(`   !! MISSING CRITICAL DATA: ${criticalMissingFields.join(', ')}`);

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
  const equity = latestBalance?.totalEquity ?? null;
  const assets = latestBalance?.totalAssets ?? null;
  const debtParts = [
    latestBalance?.totalDebt,
    latestBalance?.shortTermDebt,
    latestBalance?.leaseLiabilities
  ].filter((v) => Number.isFinite(v));
  const debt =
    debtParts.length > 0 ? debtParts.reduce((acc, v) => acc + Number(v), 0) : null;
  const cash = Number.isFinite(latestBalance?.cash) ? Number(latestBalance.cash) : 0;
  const shortTermInvestments = Number.isFinite(latestBalance?.shortTermInvestments)
    ? Number(latestBalance.shortTermInvestments)
    : 0;
  const grossMargin = safeDiv(latestQuarter?.grossProfit, latestQuarter?.revenue);
  const operatingMargin = safeDiv(latestQuarter?.operatingIncome, latestQuarter?.revenue);
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

function buildSnapshot({ ttm, quarterlySeries, keyMetrics, growth, latestBalance, shortInterest }) {
  const netMarginTTM = keyMetrics.netMargin ?? null;
  const freeCashFlowTTM = ttm?.freeCashFlow ?? null;
  const revenueTTM = ttm?.revenue ?? null;
  const revenueCAGR3Y = growth.revenueCagr3y ?? null;
  const debtToEquity = keyMetrics.debtToEquity ?? null;
  const debtParts =
    latestBalance
      ? [latestBalance.totalDebt, latestBalance.shortTermDebt, latestBalance.leaseLiabilities].filter((v) =>
        Number.isFinite(v)
      )
      : [];
  const totalDebt = debtParts.length ? debtParts.reduce((acc, v) => acc + Number(v), 0) : null;
  const cashVal = Number.isFinite(latestBalance?.cash) ? Number(latestBalance.cash) : 0;
  const stiVal = Number.isFinite(latestBalance?.shortTermInvestments)
    ? Number(latestBalance.shortTermInvestments)
    : 0;
  const netDebt =
    Number.isFinite(totalDebt) && (Number.isFinite(cashVal) || Number.isFinite(stiVal))
      ? totalDebt - (Number.isFinite(cashVal) ? cashVal : 0) - (Number.isFinite(stiVal) ? stiVal : 0)
      : null;
  const netDebtToFCFYears =
    netDebt != null && freeCashFlowTTM
      ? freeCashFlowTTM !== 0
        ? netDebt / freeCashFlowTTM
        : null
      : null;
  const interestCoverageMeta = computeInterestCoverageTtm(quarterlySeries);
  const interestCoverage =
    interestCoverageMeta.value != null
      ? interestCoverageMeta.value
      : latestBalance?.interestExpense != null && latestBalance?.operatingIncome != null
        ? safeDiv(latestBalance.operatingIncome, Math.abs(latestBalance.interestExpense))
        : null;
  const sharesOutstanding = (() => {
    if (Number.isFinite(latestBalance?.sharesOutstanding)) return Number(latestBalance.sharesOutstanding);
    const latestSeriesShares = [...(quarterlySeries || [])]
      .map((q) => q.sharesOutstanding)
      .filter((v) => Number.isFinite(v))
      .at(-1);
    return latestSeriesShares ?? null;
  })();
  const shareChangeMeta = computeShareChangeWithSplitGuard(quarterlySeries);
  const sharesOutChangeYoY = shareChangeMeta.changeYoY != null ? shareChangeMeta.changeYoY / 100 : null;
  const ocfSeries = quarterlySeries
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

  return {
    netMarginTTM,
    fcfMarginTTM: safeDiv(freeCashFlowTTM, revenueTTM),
    freeCashFlowTTM,
    revenueCAGR3Y,
    debtToEquity,
    netDebtToFCFYears: netDebtToFCFYears ?? null,
    netDebtToFcfYears: netDebtToFCFYears ?? null,
    interestCoverage,
    interestCoveragePeriods: interestCoverageMeta.periods ?? null,
    sharesOutChangeYoY,
    sharesOutChangeYoYRaw: shareChangeMeta.rawYoY != null ? shareChangeMeta.rawYoY / 100 : null,
    shareChangeLikelySplit: !!shareChangeMeta.splitSignal,
    sharesOut: sharesOutstanding,
    sharesOutstanding,
    operatingCashFlowTrend4Q,
    shortPercentFloat: shortPctFloat,
    shortFloatPercent: shortPctFloat,
    shortInterestPercentOfFloat: shortPctFloat,
    daysToCover,
    shortRatio: daysToCover,
    avgVolume30d
  };
}

function buildProjections({ snapshot, growth, quarterlySeries, keyMetrics }) {
  const revenueSlope = slope(quarterlySeries.map((q) => q.revenue));
  const fcfSlope = slope(
    quarterlySeries.map((q) =>
      q.freeCashFlow != null
        ? q.freeCashFlow
        : q.operatingCashFlow != null && q.capex != null
          ? q.operatingCashFlow - Math.abs(q.capex)
          : null
    )
  );
  const marginSlope = slope(quarterlySeries.map((q) => q.netIncome && q.revenue ? q.netIncome / q.revenue : null));

  const margins = quarterlySeries
    .map((q) => (q.netIncome != null && q.revenue ? q.netIncome / q.revenue : null))
    .filter((v) => Number.isFinite(v));
  const gmStability =
    margins.length >= 2
      ? 1 - Math.min(1, Math.abs(margins[margins.length - 1] - margins[0]))
      : null;
  const ocfTrendSlope = slope(
    quarterlySeries.map((q) => (Number.isFinite(q.operatingCashFlow) ? q.operatingCashFlow : null)).slice(-4)
  );
  const revenueTtmFromSeries = (() => {
    const latest4 = quarterlySeries.slice(-4);
    if (latest4.length < 4) return null;
    const total = latest4.reduce((acc, q) => (Number.isFinite(q.revenue) ? acc + Number(q.revenue) : acc), 0);
    return Number.isFinite(total) ? total : null;
  })();
  const fcfTtmFromSnapshot = snapshot?.freeCashFlowTTM ?? null;
  const fcfMargin = Number.isFinite(fcfTtmFromSnapshot) && Number.isFinite(revenueTtmFromSeries) && revenueTtmFromSeries !== 0
    ? fcfTtmFromSnapshot / revenueTtmFromSeries
    : null;

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
  const netDebtRisk = normalize(snapshot.netDebtToFCFYears ?? 0, 0, 8);
  if (netDebtRisk != null) dilutionParts.push(netDebtRisk);
  if (snapshot.interestCoverage != null) {
    const coverageRisk = normalize(snapshot.interestCoverage, 1, 8);
    if (coverageRisk != null) dilutionParts.push(1 - coverageRisk);
  }
  if (fcfMargin != null && fcfMargin < 0) {
    dilutionParts.push(clamp01(normalize(-fcfMargin, 0, 0.25)));
  }
  if (snapshot.netDebtToFCFYears == null && fcfMargin != null && fcfMargin < 0) {
    dilutionParts.push(1); // negative FCF with unknown debt implies high dilution reliance
  }
  let dilutionRiskScore = clamp01(avg(dilutionParts));
  // Apply dampening for stable recent share counts (merger artifacts)
  const qoqDil = growth.sharesChangeQoQ || 0;
  if (dilutionRiskScore > 0.4 && qoqDil < 0.01) {
    dilutionRiskScore = Math.min(dilutionRiskScore, qoqDil < 0 ? 0 : 0.2);
  }

  const dilutionRisk =
    dilutionRiskScore != null ? dilutionRiskScore : normalize((snapshot.sharesOutChangeYoY ?? 0) / 100, -0.03, 0.1) || 0;

  const leverageFactor = normalize(keyMetrics?.debtToEquity ?? snapshot.debtToEquity ?? 0, 0, 3);
  const fallbackDebtYears = snapshot.netDebtToFCFYears ?? (fcfMargin != null && fcfMargin < 0 ? 12 : null);
  const debtYearsRisk = fallbackDebtYears != null ? normalize(fallbackDebtYears, 0, 10) : null;
  const coverageRisk =
    snapshot.interestCoverage != null ? clamp01(1 - normalize(snapshot.interestCoverage, 1, 8)) : null;
  const fcfMarginRisk =
    fcfMargin != null && fcfMargin < 0 ? clamp01(normalize(-fcfMargin, 0, 0.25)) : null;
  const marginRisk = clamp01(normalize(-(marginSlope ?? 0), -0.05, 0.05));
  let bankruptcyRiskScore = clamp01(
    avg([debtYearsRisk, leverageFactor, marginRisk, coverageRisk, fcfMarginRisk].filter((v) => v !== null))
  );

  // Dampeners for cash-rich mega-caps: if large, cash-generative, and low net-debt burden, cap risk at Low.
  const megaCap = Number.isFinite(keyMetrics?.marketCap) ? keyMetrics.marketCap > 50e9 : false;
  const hasLowDebtYears = (snapshot.netDebtToFCFYears ?? Infinity) <= 2;
  const hasStrongFcfMargin = Number.isFinite(fcfMargin) && fcfMargin > 0.15;
  const hasStrongCoverage = Number.isFinite(snapshot.interestCoverage) && snapshot.interestCoverage > 15;
  const netCash = Number.isFinite(snapshot.netDebtToFCFYears) && snapshot.netDebtToFCFYears < 0;

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

  // Refine Dilution Risk: If YoY is high but QoQ is flat, it was a one-time event (merger/offering)
  const qoqDilution = growth.sharesChangeQoQ || 0;
  if (sharesChangeRisk != null && sharesChangeRisk > 0.4 && qoqDilution < 0.01) {
    // Recent trend is stable, reduce risk score significantly
    const factor = qoqDilution < 0 ? 0 : 0.2; // if buybacks, 0 risk; if flat, 0.2
    // We manually override the score computed earlier
    // We need to re-assign or modify the variable if possible, but it's const block previously.
    // Wait, dilutionRiskScore includes other factors. Let's dampen the final result.
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
    dilutionRiskLabel: riskLabel(dilutionRiskScore),
    bankruptcyRiskScore,
    bankruptcyRiskLabel: riskLabel(bankruptcyRiskScore),
    businessTrendLabel
  };
}

export async function buildTickerViewModel(ticker) {
  try {
    if (!ticker) return null;
    console.log("[tickerAssembler] buildTickerViewModel start", ticker);
    const fundamentals = await getFundamentalsForTicker(ticker);
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
    if (!fundamentals || fundamentals.length === 0) return null;

    const priceState = await getOrFetchLatestPrice(ticker);
    console.log("[tickerAssembler] price state", priceState?.state, "for", ticker);
    let priceSummary = emptyPriceSummary();
    let priceHistory = [];
    const pricePending = priceState?.state === "pending";
    if (priceState?.state === "ready" && Array.isArray(priceState.priceSeries)) {
      const pricePieces = buildPricePieces(priceState.priceSeries);
      priceSummary = pricePieces.priceSummary;
      priceHistory = pricePieces.priceHistory;
    } else if (priceState?.state === "error") {
      console.warn("[tickerAssembler] price fetch error for", ticker);
    }

    // Fallback: if price looks implausible or is missing, try local price file
    const looksImplausible =
      !Number.isFinite(priceSummary.lastClose) ||
      priceSummary.lastClose <= 0 ||
      priceSummary.lastClose > 5_000 ||
      !priceHistory.length ||
      isPriceStale(priceSummary.lastCloseDate, 5);
    if (looksImplausible) {
      const localPrices = loadLocalPriceHistory(ticker);
      if (localPrices && localPrices.length) {
        const fallbackPieces = buildPricePieces(localPrices);
        priceSummary = fallbackPieces.priceSummary;
        priceHistory = fallbackPieces.priceHistory;
        console.warn("[tickerAssembler] using local price fallback for", ticker);
      } else if (isPriceStale(priceSummary.lastCloseDate, 5)) {
        // stale and no fallback; mark pending and clear price to avoid showing ghost values
        priceSummary = emptyPriceSummary();
        priceHistory = [];
        console.warn("[tickerAssembler] price stale and no fallback for", ticker);
      }
    }

    const quarterlySeries = toQuarterlySeries(fundamentals);
    const ttm = buildTtmFromQuarters(quarterlySeries);
    const growth = computeGrowth(fundamentals);
    const baseSic = fundamentals.find((p) => Number.isFinite(p.sic))?.sic ?? null;
    const baseSector = fundamentals.find((p) => p.sector)?.sector || null;
    const sectorInfo = classifySector({ ticker, sic: baseSic });
    const sector = baseSector || sectorInfo.sector || null;
    const latestFiledDate =
      fundamentals
        .map((p) => p.filedDate)
        .filter(Boolean)
        .sort()
        .slice(-1)[0] || null;

    const latestQuarter = quarterlySeries[quarterlySeries.length - 1] || null;
    const latestBalance = latestQuarter;
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
    const snapshot = buildSnapshot({
      ttm,
      quarterlySeries,
      keyMetrics,
      growth,
      latestBalance,
      shortInterest
    });
    const projections = buildProjections({ snapshot, growth, quarterlySeries, keyMetrics });
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

    const rating = computeRuleRating({
      ticker: ticker.toUpperCase(),
      sector,
      quarterlySeries,
      snapshot,
      ttm,
      ttm,
      priceSummary,
      growth,
      filingSignals: resolvedFilingSignals,
      projections
    });
    // Filing intelligence handled inside rating now
    let ratingNotes = Array.isArray(rating.missingNotes) ? rating.missingNotes.slice() : [];
    if (snapshot.shareChangeLikelySplit) {
      ratingNotes.push(
        "Large share change detected (likely split) - dilution score adjusted."
      );
    }
    if (snapshot.interestCoveragePeriods && snapshot.interestCoveragePeriods < 4 && snapshot.interestCoverage != null) {
      ratingNotes.push(
        `Interest coverage uses limited quarters (${snapshot.interestCoveragePeriods}).`
      );
    }
    rating.missingNotes = ratingNotes;
    const runwayYearsVm = computeRunwayYearsVm({ quarterlySeries, snapshot, ttm });
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
        filingSignals: resolvedFilingSignals,
        filingSignalsMeta: resolvedFilingMeta,
        filingSignalsCachedAt: resolvedFilingCachedAt || (filingSignals ? nowIso : existing.filingSignalsCachedAt)
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

      // 1. Operational Momentum
      if (revTrend > 0.5) score += 15; // Hypergrowth
      else if (revTrend > 0.2) score += 10;
      else if (revTrend > 0.05) score += 5;
      else if (revTrend < -0.1) score -= 10;

      if (marginTrend > 0.05) score += 10; // Expanding margins
      else if (marginTrend < -0.05) score -= 10;

      // 2. Innovation/Catalyst Proxy (Sector specific)
      const sector = stock.sectorBucket;
      if ((sector === 'Biotech/Pharma' || sector === 'Tech/Internet') && rndTrend > 0.1) {
        score += 5; // Investing in future
      }

      // 3. Filing Sentiment Impact
      const filingScore = filingSignals.reduce((acc, s) => acc + (s.score || 0), 0);
      // Cap filing impact to +/- 20
      score += Math.max(-20, Math.min(20, filingScore));

      return Math.max(0, Math.min(100, score));
    }

    function generateDynamicNarrative({ stock, trends, filingSignals, pennyStock, scoreBand, metrics }) {
      const parts = [];
      const sector = stock.sectorBucket;
      const fcfMargin = metrics.fcfMargin || 0;
      const revGrowth = metrics.revenueGrowth || 0;

      // 1. Efficiency / Burn Narrative
      if (trends.burnTrend > 0.15) {
        parts.push("Cash burn is narrowing, indicating improved operational efficiency.");
      } else if (trends.burnTrend < -0.15 && fcfMargin < -20) {
        parts.push("Cash burn is accelerating.");
      }

      // 2. Growth vs Profitability Logic
      if (revGrowth > 40 && fcfMargin < 0) {
        if (sector === 'Biotech/Pharma' || sector === 'Tech/Internet') {
          parts.push("Aggressive investment phase: Capital is being deployed into R&D to fuel rapid top-line growth.");
        } else {
          parts.push("Unprofitable growth: Revenue is surging, but at the cost of deep cash flow deficits.");
        }
      } else if (revGrowth < 0 && fcfMargin > 10) {
        parts.push("Mature profile: Revenue is soft, but the business generates healthy free cash flow.");
      } else if (revGrowth > 15 && fcfMargin > 10) {
        parts.push("Balanced compounder: Delivering both double-digit growth and healthy cash flows.");
      }

      // 3. Filing Signals Integration
      const posSignals = filingSignals.filter(s => s.score > 0).length;
      const negSignals = filingSignals.filter(s => s.score < 0).length;
      if (posSignals > negSignals && posSignals > 0) {
        parts.push("Regulatory filings suggest positive underlying momentum.");
      } else if (negSignals > posSignals && negSignals > 0) {
        // Be specific if possible
        if (filingSignals.some(s => s.id === 'dilution_risk')) {
          parts.push("Filings indicate potential shareholder dilution.");
        } else {
          parts.push("Regulatory filings contain recent risk factors.");
        }
      }

      // 4. Penny Stock Nuance (Replacing generic "fragile" label)
      if (pennyStock) {
        if (metrics.runway < 0.75) {
          parts.push("Speculative: Extremely short cash runway creates high financing risk.");
        } else if (metrics.dilution > 20) {
          parts.push("Dilution Risk: Micro-cap structure relying heavily on equity financing.");
        } else if (metrics.fcfMargin < -50) {
          parts.push("Micro-cap profile: High volatility and burn rate.");
        } else {
          parts.push("Micro-cap profile: Volatility expected, but balance sheet appears stable.");
        }
      } else if (scoreBand === 'danger') {
        parts.push("Financial position appears distressed.");
      }

      // Deduplicate and join
      return [...new Set(parts)].join(" ");
    }

    const stock = buildStockForRules({ ticker: ticker.toUpperCase(), sector, quarterlySeries, snapshot, ttm, priceSummary, growth });

    const momentumScore = computeMomentumHealth(
      { momentum: stock.momentum, sectorBucket: stock.sectorBucket },
      resolvedFilingSignals
    );

    // Construct simplified metrics for narrative
    const navMetrics = {
      revenueGrowth: percentToNumber(stock.growth?.revenueGrowthTTM),
      fcfMargin: percentToNumber(stock.profitMargins?.fcfMargin),
      runway: stock.financialPosition.runwayYears,
      dilution: percentToNumber(stock.shareStats?.sharesChangeYoY)
    };

    const narrativeWrapper = generateDynamicNarrative({
      stock,
      trends: stock.momentum,
      filingSignals: resolvedFilingSignals,
      pennyStock,
      scoreBand: rating.tierLabel,
      metrics: navMetrics
    });

    // OVERRIDE PROJECTIONS WITH MOMENTUM SCORE
    // The UI 'Upside Momentum' uses growthContinuationScore/Label.
    // Momentum score is 0-100, projection needs 0-1.
    projections.growthContinuationScore = momentumScore / 100;

    // Recalculate label based on momentum
    if (momentumScore >= 80) projections.growthContinuationLabel = "Strong Momentum";
    else if (momentumScore >= 60) projections.growthContinuationLabel = "Likely Continuation";
    else if (momentumScore >= 40) projections.growthContinuationLabel = "Stable / Mixed";
    else if (momentumScore >= 20) projections.growthContinuationLabel = "Weak / Stalling";
    else projections.growthContinuationLabel = "Deteriorating";

    const vm = {
      ticker: ticker.toUpperCase(),
      companyName: fundamentals[0]?.companyName || undefined,
      currency: currency || undefined,
      priceHistory,
      priceSummary,
      pricePending,
      quarterlySeries,
      ttm,
      keyMetrics,
      snapshot,
      projections,
      growth,
      ratingRawScore: rating.rawScore,
      ratingNormalizedScore: rating.normalizedScore,
      ratingTierLabel: rating.tierLabel,
      ratingUpdatedAt: rating.updatedAt,
      ratingReasons: rating.reasons,
      ratingCompleteness: rating.completeness,
      ratingNotes,
      // Inject the dynamic narrative into riskFactors (as a single item) so it appears in the existing UI slot
      // replacing the old static Penny Stock warnings.
      riskFactors: [narrativeWrapper],
      pennyStock,
      filingSignals: resolvedFilingSignals,
      fundamentalsAsOf: ttm?.asOf ?? latestEnd ?? null,
      lastFilingDate: latestFiledDate,
      priceAsOf: priceSummary?.lastCloseDate ?? null,
      sector: sector || null,
      sic: baseSic ?? null,
      narrative: narrativeWrapper,
      momentumScore
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
