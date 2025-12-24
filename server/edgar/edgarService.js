import { getFundamentalsFreshness, getFundamentalsForTicker } from "./fundamentalsStore.js";
import { enqueueFundamentalsJob, getJobState } from "./edgarQueue.js";
import { scanFilingForSignals } from "./filingTextScanner.js";

const DEFAULT_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 90; // 90 days

function toNumber(val) {
  if (val == null) return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

function sortByDateDesc(a, b) {
  return Date.parse(b.periodEnd) - Date.parse(a.periodEnd);
}

function latestOrNull(list) {
  return list.length ? list[0] : null;
}

function sum(values) {
  return values.reduce((acc, v) => acc + (toNumber(v) ?? 0), 0);
}

function computeTtm(periods) {
  const quarters = periods.filter((p) => p.periodType === "quarter").sort(sortByDateDesc);
  const take = quarters.slice(0, 4);
  const sourceCount = take.length;
  if (sourceCount < 3) {
    return { ttm: null, incomplete: true, sourceCount };
  }
  const ttm = {
    revenue: sum(take.map((p) => p.revenue)),
    netIncome: sum(take.map((p) => p.netIncome)),
    grossProfit: sum(take.map((p) => p.grossProfit)),
    operatingIncome: sum(take.map((p) => p.operatingIncome)),
    operatingCashFlow: sum(take.map((p) => p.operatingCashFlow)),
    capex: sum(take.map((p) => p.capex)),
    periodEnd: take[0]?.periodEnd || null,
  };
  if (ttm.operatingCashFlow != null && ttm.capex != null) {
    ttm.freeCashFlow = ttm.operatingCashFlow - ttm.capex;
  }
  if (ttm.revenue) ttm.grossMargin = ttm.grossProfit / ttm.revenue;
  if (ttm.revenue) ttm.netMargin = ttm.netIncome / ttm.revenue;
  if (ttm.revenue) ttm.operatingMargin = ttm.operatingIncome / ttm.revenue;
  return { ttm, incomplete: sourceCount < 4, sourceCount };
}

export const DATA_STATUS_MESSAGES = {
  ttmIncomplete: (count) =>
    `Trailing twelve months is based on the last ${count} reported quarter${count === 1 ? "" : "s"}. Final TTM will refresh after the next filing.`,
  staleData: "Latest fundamentals are older than our freshness window. We’ll refresh as soon as new filings arrive.",
  inactiveTicker: "This ticker is not reporting new filings. Data may be stale or incomplete.",
};

function computeSnapshot(rows) {
  const sorted = [...rows].sort(sortByDateDesc);
  const quarters = sorted.filter((p) => p.periodType === "quarter");
  const years = sorted.filter((p) => p.periodType === "year");
  const latestQuarter = latestOrNull(quarters);
  const latestYear = latestOrNull(years);
  const ttmMeta = computeTtm(sorted);

  const snapshot = {
    latestQuarter,
    latestYear,
    ttm: ttmMeta?.ttm ?? null,
    ttmIncomplete: ttmMeta?.incomplete ?? false,
    ttmSourceCount: ttmMeta?.sourceCount ?? 0,
    notes: {},
    coverage: {
      quarters: quarters.length,
      years: years.length,
    },
    ratios: {},
  };

  if (snapshot.ttmIncomplete) {
    snapshot.notes.ttm = DATA_STATUS_MESSAGES.ttmIncomplete(snapshot.ttmSourceCount);
  }
  const criticalFields = [
    "revenue",
    "grossProfit",
    "operatingIncome",
    "netIncome",
    "totalAssets",
    "totalLiabilities",
    "operatingCashFlow",
    "capex"
  ];
  const baseForCompleteness = latestQuarter || latestYear || {};
  const available = criticalFields.filter((f) => baseForCompleteness[f] != null).length;
  snapshot.completeness = {
    available,
    total: criticalFields.length,
    percent: criticalFields.length ? (available / criticalFields.length) * 100 : null
  };

  const base = latestYear || latestQuarter || {};
  if (base.revenue) {
    snapshot.ratios.grossMargin = base.grossProfit != null ? base.grossProfit / base.revenue : null;
    snapshot.ratios.netMargin = base.netIncome != null ? base.netIncome / base.revenue : null;
    snapshot.ratios.operatingMargin = base.operatingIncome != null ? base.operatingIncome / base.revenue : null;
  }
  if (base.totalAssets && base.totalLiabilities != null) {
    snapshot.ratios.debtToAssets = base.totalLiabilities / base.totalAssets;
  }
  if (base.totalEquity) {
    snapshot.ratios.debtToEquity = base.totalDebt != null ? base.totalDebt / base.totalEquity : null;
  }
  if (base.operatingCashFlow != null && base.capex != null) {
    snapshot.ratios.cashFlowCoverage = (base.operatingCashFlow - base.capex) / (base.totalDebt || 1);
  }
  return snapshot;
}

export async function getCoreFinancialSnapshot(ticker, options = {}) {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const enqueueIfStale = options.enqueueIfStale ?? true;
  const includeFilingTextScan = options.includeFilingTextScan ?? false;
  const tickerKey = ticker?.toUpperCase().trim();
  if (!tickerKey) throw new Error("ticker is required");

  const { rows, isFresh, latestUpdated } = await getFundamentalsFreshness(tickerKey, maxAgeMs);
  const hasData = rows.length > 0;

  let job = getJobState(tickerKey);
  if ((!hasData || !isFresh) && enqueueIfStale) {
    job = enqueueFundamentalsJob(tickerKey);
  }

  const snapshot = hasData ? computeSnapshot(rows) : null;
  if (snapshot && !isFresh) {
    snapshot.notes = { ...(snapshot.notes || {}), stale: DATA_STATUS_MESSAGES.staleData };
  }

  let filingSignals = null;
  if (includeFilingTextScan && snapshot) {
    try {
      filingSignals = await scanFilingForSignals(tickerKey);
    } catch (err) {
      console.warn("[edgarService] filing signal scan failed", tickerKey, err?.message || err);
    }
  }

  return {
    ticker: tickerKey,
    source: hasData ? (isFresh ? "cache:fresh" : "cache:stale") : "none",
    updatedAt: latestUpdated || null,
    snapshot,
    pending: job?.status === "queued" || job?.status === "running",
    inactive: !job && !hasData,
    job,
    data: rows,
    filingSignals,
  };
}

export async function computeTtmFundamentalsFromEdgar(ticker) {
  const rows = await getFundamentalsForTicker(ticker);
  const snap = computeSnapshot(rows);
  return {
    ttm: snap?.ttm ?? null,
    ttmIncomplete: snap?.ttmIncomplete ?? false,
    ttmSourceCount: snap?.ttmSourceCount ?? 0,
  };
}
