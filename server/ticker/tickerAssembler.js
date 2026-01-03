import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getFundamentalsForTicker } from "../edgar/fundamentalsStore.js";
import { getLatestCachedPrice, getRecentPrices } from "../prices/priceStore.js";
import { classifySector } from "../sector/sectorClassifier.js";
import { normalize } from "./tickerUtils.js";
// import { fetchShortInterest } from "../prices/shortInterestFetcher.js"; // Removed

import {
  rules,
  applySectorRuleAdjustments,
  resolveSectorBucket,
  percentToNumber,
  isFintech,
  isFiniteValue,
  safeDiv,
  clamp,
  clamp01,
  avg,
  RISK_FREE_RATE_PCT as ENGINE_RISK_FREE_RATE_PCT,
  SAFE_DIVISION_THRESHOLD,
  ONE_YEAR_MS,
  TOLERANCE_30D_MS,
  STALE_DATA_THRESHOLD_MS,
  normalizeRuleScore,
  getScoreBand,
  pctChange,
  toNumber,
  calcMargin,
  calcFcf,
  calcCagr,
  pctFromRatio,
  formatQuarterLabel,
  isDateStale,
  sortByPeriodEndAsc,
  lastNPeriods,
  findComparableYearAgo,
  toQuarterlySeries,
  buildTtmFromQuarters,
  inferTaxRate,
  computeInterestCoverageTtm,
  computeInterestCoverageAnnual,
  computeRunwayYears,
  detectLikelySplit,
  detectLikelyReverseSplit,
  computeShareChangeWithSplitGuard,
  buildStockForRules
} from "../../engine/index.js";
import { scanFilingForSignals } from "../edgar/filingTextScanner.js";
import { enqueueFundamentalsJob, getJobState } from "../edgar/edgarQueue.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(ROOT, "data");
const EDGAR_DIR = path.join(DATA_DIR, "edgar");
const STATIC_PRICE_PATCH_PATH = path.join(DATA_DIR, "prices.json");
const PRICE_PATCH_MAX_AGE_DAYS = Number(process.env.PRICE_PATCH_MAX_AGE_DAYS) || 2;
const RISK_FREE_RATE_PCT = ENGINE_RISK_FREE_RATE_PCT;
const priceLogCache = new Map(); // throttle noisy price logs per ticker
const staticPricePatchCache = { loadedAt: 0, data: null };

const SAFE_THRESHOLD = SAFE_DIVISION_THRESHOLD;
const tickerDebug = process.env.TICKER_DEBUG === '1';

function logPriceOnce(kind, ticker, msg, windowMs = 60_000) {
  const key = `${kind}-${ticker}`;
  const last = priceLogCache.get(key) || 0;
  const now = Date.now();
  if (now - last < windowMs) return;
  priceLogCache.set(key, now);
  console.warn(msg);
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

  const trimmed = history.slice(-2); // only keep last/prev close
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
  return {
    priceHistory: trimmed.map((p) => ({ date: p.date, close: Number(p.close) })),
    priceSummary: {
      lastClose: lastClose ?? null,
      lastCloseDate: last ? last.date : null,
      prevClose: prevClose ?? null,
      dayChangeAbs,
      dayChangePct
    }
  };
}

function emptyPriceSummary() {
  return {
    lastClose: null,
    lastCloseDate: null,
    prevClose: null,
    dayChangeAbs: null,
    dayChangePct: null
  };
}

function loadLocalPriceHistory(ticker) {
  try {
    const file = path.join(DATA_DIR, "prices", `${ticker.toUpperCase()}.json`);
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

function loadStaticPricePatch(maxAgeMs = 5 * 60 * 1000) {
  const now = Date.now();
  if (staticPricePatchCache.data && now - staticPricePatchCache.loadedAt < maxAgeMs) {
    return staticPricePatchCache.data;
  }
  try {
    if (!fs.existsSync(STATIC_PRICE_PATCH_PATH)) return null;
    const raw = fs.readFileSync(STATIC_PRICE_PATCH_PATH, "utf8");
    const parsed = JSON.parse(raw);
    staticPricePatchCache.data = parsed && typeof parsed === "object" ? parsed : null;
    staticPricePatchCache.loadedAt = now;
    return staticPricePatchCache.data;
  } catch (err) {
    console.warn("[tickerAssembler] failed to load static price patch", err?.message || err);
    staticPricePatchCache.data = null;
    staticPricePatchCache.loadedAt = now;
    return null;
  }
}

function lookupPricePatch(patch, ticker) {
  const key = String(ticker || "").toUpperCase();
  if (!key || !patch) return null;
  const variants = [key, key.replace(".", "-"), key.replace("-", ".")];
  for (const v of variants) {
    if (patch[v]) return patch[v];
  }
  return null;
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

function buildPriceSummaryAt(prices, asOfDate) {
  if (!asOfDate) return { priceSummary: emptyPriceSummary(), priceHistory: [] };
  const asOf = Date.parse(asOfDate);
  if (!Number.isFinite(asOf)) return { priceSummary: emptyPriceSummary(), priceHistory: [] };

  const history = (prices || [])
    .filter((p) => p?.date && Date.parse(p.date) <= asOf)
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  if (!history.length) return { priceSummary: emptyPriceSummary(), priceHistory: [] };

  const last = history[history.length - 1];
  const prev = history[history.length - 2] || null;
  const lastClose = last ? Number(last.close) : null;
  const prevClose = prev ? Number(prev.close) : null;
  const dayChangeAbs =
    lastClose != null && prevClose != null ? Number((lastClose - prevClose).toFixed(4)) : null;
  const dayChangePct =
    lastClose != null && prevClose != null && prevClose !== 0
      ? Number(((lastClose - prevClose) / prevClose).toFixed(4))
      : null;

  return {
    priceHistory: history.slice(-5).map((p) => ({ date: p.date, close: Number(p.close) })),
    priceSummary: {
      lastClose: lastClose ?? null,
      lastCloseDate: last?.date ?? null,
      prevClose: prevClose ?? null,
      dayChangeAbs,
      dayChangePct
    }
  };
}

function deriveQuarterFromAnnual(latestAnnual, quartersAsc) {
  if (!latestAnnual?.periodEnd) return null;
  const endMs = Date.parse(latestAnnual.periodEnd);
  if (!Number.isFinite(endMs)) return null;
  const windowStart = endMs - (ONE_YEAR_MS + TOLERANCE_30D_MS);
  const candidates = (quartersAsc || []).filter((q) => {
    if (!q?.periodEnd) return false;
    const ts = Date.parse(q.periodEnd);
    return Number.isFinite(ts) && ts <= endMs && ts >= windowStart;
  });
  if (candidates.length < 3) return null;
  const last3 = candidates.slice(-3);

  const sumField = (field) => {
    let acc = 0;
    for (const q of last3) {
      const val = Number(q?.[field]);
      if (!Number.isFinite(val)) return null;
      acc += val;
    }
    return acc;
  };

  const sumFcf = () => {
    let acc = 0;
    for (const q of last3) {
      const explicit = Number(q?.freeCashFlow);
      const derived =
        Number.isFinite(Number(q?.operatingCashFlow)) && Number.isFinite(Number(q?.capex))
          ? Number(q.operatingCashFlow) - Math.abs(Number(q.capex))
          : null;
      const val = Number.isFinite(explicit) ? explicit : derived;
      if (!Number.isFinite(val)) return null;
      acc += val;
    }
    return acc;
  };

  const annualVal = (field) => {
    const v = Number(latestAnnual?.[field]);
    return Number.isFinite(v) ? v : null;
  };

  const revenue = annualVal("revenue");
  const netIncome = annualVal("netIncome");
  if (!Number.isFinite(revenue) || !Number.isFinite(netIncome)) return null;

  const revSum = sumField("revenue");
  const niSum = sumField("netIncome");
  if (!Number.isFinite(revSum) || !Number.isFinite(niSum)) return null;

  const derived = {
    periodEnd: latestAnnual.periodEnd,
    derived: true,
    revenue: revenue - revSum,
    netIncome: netIncome - niSum
  };

  const gpAnnual = annualVal("grossProfit");
  const gpSum = sumField("grossProfit");
  if (Number.isFinite(gpAnnual) && Number.isFinite(gpSum)) derived.grossProfit = gpAnnual - gpSum;

  const opAnnual = annualVal("operatingIncome");
  const opSum = sumField("operatingIncome");
  if (Number.isFinite(opAnnual) && Number.isFinite(opSum)) derived.operatingIncome = opAnnual - opSum;

  const pretaxAnnual = annualVal("incomeBeforeIncomeTaxes");
  const pretaxSum = sumField("incomeBeforeIncomeTaxes");
  if (Number.isFinite(pretaxAnnual) && Number.isFinite(pretaxSum)) {
    derived.incomeBeforeIncomeTaxes = pretaxAnnual - pretaxSum;
  }

  const taxAnnual = annualVal("incomeTaxExpenseBenefit");
  const taxSum = sumField("incomeTaxExpenseBenefit");
  if (Number.isFinite(taxAnnual) && Number.isFinite(taxSum)) {
    derived.incomeTaxExpenseBenefit = taxAnnual - taxSum;
  }

  const ocfAnnual = annualVal("operatingCashFlow");
  const ocfSum = sumField("operatingCashFlow");
  if (Number.isFinite(ocfAnnual) && Number.isFinite(ocfSum)) {
    derived.operatingCashFlow = ocfAnnual - ocfSum;
  }

  const capexAnnual = annualVal("capex");
  const capexSum = sumField("capex");
  if (Number.isFinite(capexAnnual) && Number.isFinite(capexSum)) {
    derived.capex = capexAnnual - capexSum;
  }

  const annualFcf =
    Number.isFinite(annualVal("freeCashFlow"))
      ? annualVal("freeCashFlow")
      : Number.isFinite(ocfAnnual) && Number.isFinite(capexAnnual)
        ? ocfAnnual - Math.abs(capexAnnual)
        : null;
  const fcfSum = sumFcf();
  if (Number.isFinite(annualFcf) && Number.isFinite(fcfSum)) {
    derived.freeCashFlow = annualFcf - fcfSum;
  }

  return derived;
}

function buildTtmWithDerived({ quartersAsc, latestAnnual }) {
  // Step 1: Check for gaps in the most recent quarters that could be filled by derivation.
  // Q4 often isn't filed separately (included in 10-K), so derive Q4 = Annual - (Q1+Q2+Q3)
  let workingQuarters = [...(quartersAsc || [])];

  // Look through all annual periods and try to derive missing Q4s
  if (latestAnnual?.periodEnd) {
    const annualEnd = Date.parse(latestAnnual.periodEnd);
    if (Number.isFinite(annualEnd)) {
      // Check if we have an incomplete quarter at the annual period end
      const existingQ4 = workingQuarters.find((q) =>
        q?.periodEnd && Math.abs(Date.parse(q.periodEnd) - annualEnd) < 5 * 24 * 60 * 60 * 1000
      );
      const q4IsIncomplete = !existingQ4 ||
        !Number.isFinite(Number(existingQ4.revenue)) ||
        !Number.isFinite(Number(existingQ4.netIncome));

      if (q4IsIncomplete) {
        const derivedQ4 = deriveQuarterFromAnnual(latestAnnual, workingQuarters);
        if (derivedQ4) {
          // Replace incomplete Q4 with derived one, or add if missing
          if (existingQ4) {
            workingQuarters = workingQuarters.filter((q) => q !== existingQ4);
          }
          workingQuarters.push(derivedQ4);
          workingQuarters = sortByPeriodEndAsc(workingQuarters);
        }
      }
    }
  }

  // Step 2: Now try to build TTM with potentially augmented quarters
  const ttmWithDerived = buildTtmFromQuarters(workingQuarters);
  if (ttmWithDerived) {
    const usedDerived = workingQuarters.some((q) => q?.derived === true);
    return {
      ttm: { ...ttmWithDerived, basis: usedDerived ? "derived" : "ttm" },
      basis: usedDerived ? "derived" : "ttm"
    };
  }

  // Step 3: Original fallback - try deriving if buildTtmFromQuarters still fails
  const derivedQuarter = deriveQuarterFromAnnual(latestAnnual, quartersAsc);
  if (derivedQuarter) {
    const existingAnnualQuarter = (quartersAsc || []).find((q) =>
      q?.periodEnd && latestAnnual?.periodEnd && Date.parse(q.periodEnd) === Date.parse(latestAnnual.periodEnd)
    );
    const existingIncomplete = existingAnnualQuarter
      ? !Number.isFinite(Number(existingAnnualQuarter.revenue)) || !Number.isFinite(Number(existingAnnualQuarter.netIncome))
      : false;
    const augmented = existingAnnualQuarter
      ? [
        ...(quartersAsc || []).filter((q) => q !== existingAnnualQuarter),
        ...(existingIncomplete ? [derivedQuarter] : [])
      ]
      : [...(quartersAsc || []), derivedQuarter];
    const ttmDerived = buildTtmFromQuarters(sortByPeriodEndAsc(augmented));
    if (ttmDerived) return { ttm: { ...ttmDerived, basis: "derived" }, basis: "derived" };
  }

  if (!latestAnnual) return { ttm: null, basis: null };

  const annualFcf =
    Number.isFinite(Number(latestAnnual?.freeCashFlow))
      ? Number(latestAnnual.freeCashFlow)
      : Number.isFinite(Number(latestAnnual?.operatingCashFlow)) && Number.isFinite(Number(latestAnnual?.capex))
        ? Number(latestAnnual.operatingCashFlow) - Math.abs(Number(latestAnnual.capex))
        : null;

  return {
    ttm: {
      asOf: latestAnnual.periodEnd || null,
      revenue: latestAnnual.revenue ?? null,
      grossProfit: latestAnnual.grossProfit ?? null,
      operatingIncome: latestAnnual.operatingIncome ?? null,
      incomeBeforeIncomeTaxes: latestAnnual.incomeBeforeIncomeTaxes ?? null,
      incomeTaxExpenseBenefit: latestAnnual.incomeTaxExpenseBenefit ?? null,
      netIncome: latestAnnual.netIncome ?? null,
      epsBasic: latestAnnual.epsBasic ?? (
        (latestAnnual.netIncome != null && latestAnnual.sharesOutstanding > 0)
          ? latestAnnual.netIncome / latestAnnual.sharesOutstanding
          : null
      ),
      operatingCashFlow: latestAnnual.operatingCashFlow ?? null,
      capex: latestAnnual.capex ?? null,
      freeCashFlow: annualFcf,
      basis: "annual"
    },
    basis: "annual"
  };
}

function computePriorTtmMeta({ quartersAsc, annualSeries }) {
  const quarters = sortByPeriodEndAsc(quartersAsc || []);
  if (quarters.length < 8) return null;

  const priorSlice = quarters.slice(0, -4);
  if (priorSlice.length < 4) return null;
  const priorEnd = priorSlice[priorSlice.length - 1]?.periodEnd || null;
  if (!priorEnd) return null;

  const annuals = Array.isArray(annualSeries) ? annualSeries : [];
  const priorAnnual = [...annuals]
    .filter((p) => p?.periodEnd && Date.parse(p.periodEnd) <= Date.parse(priorEnd))
    .sort((a, b) => Date.parse(b.periodEnd) - Date.parse(a.periodEnd))[0] || null;

  const ttmMeta = buildTtmWithDerived({
    quartersAsc: priorSlice,
    latestAnnual: priorAnnual
  });

  const priorWindow = priorSlice.slice(-4);
  const periodStart = priorWindow[0]?.periodEnd || null;
  const periodEnd = priorWindow[priorWindow.length - 1]?.periodEnd || null;

  return {
    ttm: ttmMeta?.ttm ?? null,
    basis: ttmMeta?.basis ?? null,
    periodStart,
    periodEnd
  };
}















// ---------- Rating helpers (shared-rule pipeline on the server) ----------
// Recommended normalization: wider bounds to avoid easy 100/100 scores.
const RATING_MIN = -60; // Captures truly distressed companies
const RATING_MAX = 100; // Reserves 100/100 for near-perfect execution
const RATING_RANGE = RATING_MAX - RATING_MIN || 1;

// Local definitions of normalizeRuleScore, getScoreBand, and pctChange removed.
// They are now imported from engine/index.js













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

    const incomeBasis = (() => {
      if (annualMode) return "Annual";
      if (ttm?.basis === "derived") return "Derived TTM";
      if (ttm?.basis === "ttm") return "TTM";
      if (ttm?.basis === "annual") return "Annual";
      return "Quarterly";
    })();
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
          incomeBasis === "Quarterly" ? "Quarterly" : incomeBasis,
          [
            { field: "treasuryStockRepurchased", basis: incomeBasis, periodEnd: incomePeriodEnd },
            { field: "dividendsPaid", basis: incomeBasis, periodEnd: incomePeriodEnd },
            { field: "freeCashFlow", basis: incomeBasis, periodEnd: incomePeriodEnd }
          ],
          "Capital return = buybacks + dividends; scored as a % of FCF."
        );
      case "Effective Tax Rate":
        return simple(
          incomeBasis === "Quarterly" ? "Quarterly" : incomeBasis,
          [
            { field: "incomeTaxExpenseBenefit", basis: incomeBasis, periodEnd: incomePeriodEnd },
            { field: "incomeBeforeIncomeTaxes", basis: incomeBasis, periodEnd: incomePeriodEnd }
          ],
          "ETR = income tax expense / pretax income; clamped to a reasonable range."
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
          incomeBasis === "Quarterly" ? "Quarterly" : incomeBasis,
          [
            { field: "freeCashFlow", basis: incomeBasis, periodEnd: incomePeriodEnd },
            { field: "revenue", basis: incomeBasis, periodEnd: incomePeriodEnd }
          ],
          ratioNorm
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
          ratioNorm
        );
      case "Interest coverage":
        return simple(
          incomeBasis === "Quarterly" ? "Quarterly" : incomeBasis,
          [
            { field: "operatingIncome", basis: incomeBasis, periodEnd: incomePeriodEnd },
            { field: "interestExpense", basis: incomeBasis, periodEnd: incomePeriodEnd }
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
          ratioNorm
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

  const formatBasisLabel = (ruleName, basisMeta) => {
    const timeBasis = basisMeta?.timeBasis ?? "Mixed";
    const rule = String(ruleName || "");
    if (/cagr|3y/i.test(rule)) return "CAGR";
    if (timeBasis === "Filings") return "Filings";
    if (timeBasis === "Strategic") return "Model";
    if (timeBasis === "Derived TTM") return "Derived TTM";
    if (timeBasis === "TTM") return "TTM";
    if (timeBasis === "Annual") return "Annual";
    if (timeBasis === "Quarterly") return "Quarterly";
    if (timeBasis === "Mixed") return "Mixed";
    return timeBasis;
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
    growth,
    issuerType
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

  // ========== GROWTH STAGE INTENSITY ==========
  // Identify companies in an aggressive investment/expansion phase.
  // Use a continuous intensity (0..1) to avoid hard cliffs (e.g. 39.5% vs 40% growth).
  const capexToRev = toNumber(stock?.cash?.capexToRevenue) ?? 0;
  const growthStageIntensity = (() => {
    if (pennyStock) return 0;
    if (!(isMidCap || isLargeCap)) return 0;
    if (!Number.isFinite(revenueGrowth) || !Number.isFinite(fcfMargin)) return 0;

    // Revenue growth ramp: 25% => 0, 60% => ~1
    const growthRamp = clamp01((revenueGrowth - 25) / 35);

    // Burn requirement ramp: -10% => 0, -30% => ~1 (more negative margin => higher intensity)
    const burnRamp = clamp01(((-fcfMargin) - 10) / 20);

    // Capex/reinvestment signal ramp: 30% => 0, 60% => ~1; if negative revenue edge-cases, treat as max.
    const capexRamp = capexToRev < 0 ? 1 : clamp01((capexToRev - 30) / 30);

    const combined = avg([growthRamp, burnRamp, capexRamp].filter((v) => v !== null));
    return combined != null ? combined : 0;
  })();

  // Keep a boolean for existing logs/logic, but gate it on intensity instead of a single growth breakpoint.
  const isGrowthStage = growthStageIntensity >= 0.6;

  if (ratingDebug && (isMidCap || isGrowthStage || growthStageIntensity > 0)) {
    console.log(`[TIER] ${ticker} | MidCap: ${isMidCap} | GrowthStage: ${isGrowthStage} | Intensity: ${growthStageIntensity.toFixed(2)} | Assets: ${assetSize ? (assetSize / 1e9).toFixed(2) + 'B' : 'N/A'} | MCap: ${marketCap ? (marketCap / 1e9).toFixed(2) + 'B' : 'N/A'} | RevGrowth: ${Number.isFinite(revenueGrowth) ? revenueGrowth.toFixed(1) + '%' : 'N/A'} | FCFMargin: ${Number.isFinite(fcfMargin) ? fcfMargin.toFixed(1) + '%' : 'N/A'} | CapexToRev: ${Number.isFinite(capexToRev) ? capexToRev.toFixed(1) + '%' : 'N/A'}`);
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
    if ((isMidCap || growthStageIntensity > 0) && appliedScore < 0) {
      const oldScore = appliedScore;
      let adjusted = false;

      // 1. FCF Margin: Soften progressively with growth-stage intensity (avoid hard cliffs)
      if (rule.name === "FCF margin" && growthStageIntensity > 0 && appliedScore <= -8) {
        const cap =
          Number.isFinite(revenueGrowth) && revenueGrowth > 60
            ? -4 // hypergrowth
            : -6; // strong growth
        const softened = Math.round(oldScore + (Math.max(oldScore, cap) - oldScore) * growthStageIntensity);
        appliedScore = Math.max(oldScore, Math.min(softened, cap));
        adjusted = appliedScore !== oldScore;
        if (adjusted) {
          reasonMessage =
            Number.isFinite(revenueGrowth) && revenueGrowth > 60
              ? `${reasonMessage.split(" - ")[0]} - Hypergrowth expansion (${revenueGrowth.toFixed(0)}% revenue growth)`
              : `${reasonMessage.split(" - ")[0]} - Growth investment phase (expansion spending)`;
        }
      }

      // 2. Operating Leverage: Soften during growth phase (efficiency comes later)
      if (rule.name === "Operating leverage" && growthStageIntensity > 0 && appliedScore < 0) {
        const softened = Math.round(oldScore * (1 - growthStageIntensity));
        appliedScore = Math.min(0, softened);
        adjusted = adjusted || appliedScore !== oldScore;
        if (growthStageIntensity >= 0.85) {
          notApplicable = true;
          reasonMessage = "Not applicable (expansion phase prioritizes scale over near-term efficiency)";
        } else if (appliedScore !== oldScore) {
          reasonMessage = `${reasonMessage.split(" - ")[0]} - Efficiency penalty softened (expansion phase)`;
        }
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
    const basisLabel = formatBasisLabel(rule.name, basisMeta);
    reasons.push({
      name: rule.name,
      score: appliedScore,
      message: reasonMessage,
      missing: skipped,
      notApplicable,
      weight: rule.weight,
      timeBasis: basisMeta?.timeBasis ?? null,
      sourcePeriods: basisMeta?.components ?? [],
      normalizationApplied: cleanDisclosureText(basisMeta?.normalizationApplied),
      basisLabel
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
    // Only apply when we have meaningful expansion-phase evidence.
    if (growthStageIntensity < 0.4) return 0;

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

    // Scale the adjustment smoothly to avoid threshold cliffs.
    offset = offset * growthStageIntensity;

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

  const debugTicker = String(process.env.DEBUG_TICKER || "").trim().toUpperCase();
  if (debugTicker && (stock.ticker === debugTicker || stock.symbol === debugTicker)) {
    console.log(
      `[DEBUG ${debugTicker} Rating] Raw=${total}, Norm=${normalized}, Tier=${tierLabel}, Missing=${missingCritical} (${criticalMissingFields.join(",")})`
    );
  }

  return {
    rawScore: total,
    normalizedScore: normalized,
    tierLabel: tierLabel,
    updatedAt: new Date().toISOString(),
    reasons,
    missingNotes: missingNotes, // Now cleaned/grouped
    overrideNotes: overrideNotes,
    completeness,
    pennyStock
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

  const effectiveTaxRateTTM = inferTaxRate({ ttm, latestAnnual: (Array.isArray(annualSeries) ? annualSeries[0] : null) });

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

export async function buildTickerViewModel(
  ticker,
  { fundamentalsOverride = null, allowFilingScan = true } = {}
) {
  try {
    if (!ticker) return null;
    if (tickerDebug) console.log("[tickerAssembler] buildTickerViewModel start", ticker);
    const fundamentals = Array.isArray(fundamentalsOverride)
      ? fundamentalsOverride
      : (await getFundamentalsForTicker(ticker)) || [];
    const latestEnd =
      fundamentals && fundamentals.length
        ? fundamentals
          .map((p) => p.periodEnd)
          .filter(Boolean)
          .sort()
          .slice(-1)[0]
        : null;
    if (tickerDebug) console.log(
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

    let priceSummary = emptyPriceSummary();
    let priceHistory = [];
    let pricePending = true;
    let externalMarketCap = null;
    let externalCurrency = null;

    const patch = loadStaticPricePatch();
    const patchHit = lookupPricePatch(patch, ticker);
    const patchPrice = Number(patchHit?.p);
    const patchTime = patchHit?.t || null;
    const patchDate = patchTime ? String(patchTime).slice(0, 10) : null;

    if (patchHit?.mc && Number.isFinite(Number(patchHit.mc))) {
      externalMarketCap = Number(patchHit.mc);
    }
    const patchLooksFresh = !isDateStale(patchDate, PRICE_PATCH_MAX_AGE_DAYS);
    if (Number.isFinite(patchPrice) && patchPrice > 0 && patchLooksFresh) {
      priceSummary.lastClose = patchPrice;
      priceSummary.lastCloseDate = patchDate;
      pricePending = false;
    } else if (Number.isFinite(patchPrice) && patchPrice > 0 && !patchLooksFresh) {
      // Keep the stale patch price as a best-effort value so the UI doesn't go blank on weekends/deploys.
      priceSummary.lastClose = patchPrice;
      priceSummary.lastCloseDate = patchDate;
      logPriceOnce("stale-patch", ticker, `[tickerAssembler] static price patch stale for ${ticker} (${patchDate || "n/a"})`);
    }

    // Fallback: if price looks implausible or is missing, try local price file
    const looksImplausible =
      !Number.isFinite(priceSummary.lastClose) ||
      priceSummary.lastClose <= 0 ||
      !priceHistory.length ||
      isDateStale(priceSummary.lastCloseDate, 5);
    if (looksImplausible) {
      const localPrices = loadLocalPriceHistory(ticker);
      if (localPrices && localPrices.length) {
        const fallbackPieces = buildPricePieces(localPrices);
        priceSummary = fallbackPieces.priceSummary;
        priceHistory = fallbackPieces.priceHistory;
        logPriceOnce("local-fallback", ticker, `[tickerAssembler] using local price fallback for ${ticker}`);
        // If we have a usable local close, don't show "pending" in the UI.
        if (Number.isFinite(priceSummary?.lastClose) && !isDateStale(priceSummary?.lastCloseDate, 7)) {
          pricePending = false;
        }
      } else if (isDateStale(priceSummary.lastCloseDate, 5)) {
        // Stale and no fallback. If we have a stale patch price, keep it as best-effort.
        pricePending = true;
        if (!Number.isFinite(priceSummary?.lastClose) || priceSummary.lastClose <= 0) {
          priceSummary = emptyPriceSummary();
          priceHistory = [];
        }
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
    const ttmMeta = buildTtmWithDerived({
      quartersAsc: sortByPeriodEndAsc(statementQuarterlySeries),
      latestAnnual
    });
    const ttm = ttmMeta.ttm;
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
    // shortInterest logic removed

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
    if (allowFilingScan) {
      try {
        const maxFilings = Number(process.env.FILING_SIGNALS_MAX_FILINGS_DEEP) || 10;
        filingSignals = await scanFilingForSignals(ticker, { deep: true, maxFilings });
      } catch (err) {
        console.warn("[tickerAssembler] filing signal scan failed", ticker, err?.message || err);
      }
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
    );

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
      shortInterest: null
    });
    // Propagate NASDAQ-provided market cap to snapshot so stockBuilder uses it for valuation ratios
    snapshot.marketCap = keyMetrics.marketCap;
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

    const priorTtmMeta = computePriorTtmMeta({
      quartersAsc: statementQuarterlySeries,
      annualSeries
    });
    let pastRating = null;
    if (priorTtmMeta?.ttm && priorTtmMeta?.periodEnd) {
      const priorQuarterly = statementQuarterlySeries.filter(
        (q) => q?.periodEnd && Date.parse(q.periodEnd) <= Date.parse(priorTtmMeta.periodEnd)
      );
      const priorAnnual = annualSeries.filter(
        (p) => p?.periodEnd && Date.parse(p.periodEnd) <= Date.parse(priorTtmMeta.periodEnd)
      );
      const priceAt = buildPriceSummaryAt(priceHistory, priorTtmMeta.periodEnd);
      const ratingPast = computeRuleRating({
        ticker: ticker.toUpperCase(),
        sector,
        quarterlySeries: priorQuarterly.length ? priorQuarterly : priorAnnual,
        annualSeries: priorAnnual,
        annualMode,
        snapshot,
        ttm: priorTtmMeta.ttm,
        priceSummary: priceAt.priceSummary,
        priceHistory: priceAt.priceHistory,
        growth,
        filingSignals: filingSignalsFinal,
        projections,
        issuerType
      });
      if (ratingPast) {
        pastRating = {
          score: ratingPast.normalizedScore ?? null,
          tier: ratingPast.tierLabel ?? null,
          rawScore: ratingPast.rawScore ?? null,
          periodStart: priorTtmMeta.periodStart ?? null,
          periodEnd: priorTtmMeta.periodEnd ?? null,
          basis: priorTtmMeta.basis ?? null
        };
      }
    }
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
    const runwayYearsVm = computeRunwayYears({ quarterlySeries: financialSeriesForRules, snapshot, ttm, sector });
    const pennyStockCheck = {
      priceUnder5: (Number.isFinite(priceSummary?.lastClose) && priceSummary.lastClose < 5),
      mcapUnder200M: (Number.isFinite(keyMetrics?.marketCap) && keyMetrics.marketCap < 200_000_000),
      highDilution: (Number.isFinite(percentToNumber(snapshot?.sharesOutChangeYoY)) && percentToNumber(snapshot.sharesOutChangeYoY) > 25),
      shortRunway: (Number.isFinite(runwayYearsVm) && runwayYearsVm < 1)
    };
    const pennyStock = Object.values(pennyStockCheck).some(Boolean);

    const debugTicker = String(process.env.DEBUG_TICKER || "").trim().toUpperCase();
    if (debugTicker && ticker.toUpperCase() === debugTicker) {
      console.log(`[DEBUG ${debugTicker} PENNY CHECKS]`, {
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
      // Accurate cap label for narrative templates
      const capLabel = isMegaCap ? "Mega-cap" : isLargeCap ? "Large-cap" : isMidCap ? "Mid-cap" : isSmallCap ? "Small-cap" : "Micro-cap";
      const isTrueMicroCap = !isMegaCap && !isLargeCap && !isMidCap && !isSmallCap;

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
        // SEVERE BURN: FCF margin below -100% = burning through cash at alarming rate
        if (fcfMargin < -100) {
          parts.push(
            pick("efficiency.smallcap.severeBurn", [
              "Burning cash rapidly; operating losses are severe.",
              "Burning through cash at a high rate; near-term funding risk is elevated.",
              "Cash burn is severe; sustainability depends on external financing.",
              "Burning cash rapidly; survival hinges on funding access."
            ])
          );
        }
        // BURN NARROWING (only if not severe)
        else if (trends.burnTrend > 0.15 && fcfMargin < 0 && fcfMargin > -100) {
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
          // Use accurate cap terminology, not hardcoded "Micro-cap"
          parts.push(
            isTrueMicroCap
              ? pick("penny.dilutionHeavy.micro", [
                "Heavy dilution: Micro-cap structure relying heavily on equity financing.",
                "Micro-cap funding risk: Significant dilution suggests frequent equity financing."
              ])
              : pick("penny.dilutionHeavy.other", [
                "Heavy dilution risk: Equity issuance appears to be a key funding lever.",
                "Dilution-heavy profile: Equity financing appears to play an outsized role.",
                "Significant dilution suggests frequent equity financing needs."
              ])
          );
        } else if (metrics.fcfMargin < -50) {
          parts.push(
            isTrueMicroCap
              ? pick("penny.highBurn.micro", [
                "Micro-cap profile: High volatility and burn rate create execution risk.",
                "Speculative micro-cap: High burn rate raises execution and financing risk."
              ])
              : pick("penny.highBurn.other", [
                "High cash burn: Heavy operating losses increase execution and financing risk.",
                "Cash-burn risk: Negative cash flow profile elevates financing needs.",
                "Elevated burn rate: Operating losses may require additional capital raises."
              ])
          );
        } else {
          parts.push(
            isTrueMicroCap
              ? pick("penny.generic.micro", [
                "Micro-cap profile: Volatility expected, but balance sheet appears stable.",
                "Micro-cap volatility expected; financial position looks broadly stable."
              ])
              : pick("penny.generic.other", [
                "Speculative profile: Volatility expected, but balance sheet appears stable.",
                "Price volatility is likely given the risk profile, but finances appear stable.",
                "Speculative characteristics present; financial position looks broadly stable."
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
      priceHistory: priceHistory.slice(-5),
      priceSummary,
      pricePending,
      quarterlySeries: quarterlySeries.slice(-12), // Keep 3 years of quarterly data
      annualSeries: annualSeries.slice(-4),      // Keep 4 years of annual data
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
      pastRating,
      pastRatingDelta: (pastRating?.score != null && rating.normalizedScore != null)
        ? Number(rating.normalizedScore - pastRating.score)
        : null,
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
      filingSignalsCachedAt: resolvedFilingCachedAt || null,
      fundamentalsAsOf: ttm?.asOf ?? latestEnd ?? null,
      lastFilingDate: latestFiledDate,
      priceAsOf: priceSummary?.lastCloseDate ?? null,
      sector: sector || null,
      sectorBucket: sectorBucket || null,
      isFintech: isFintech({ ticker: ticker.toUpperCase(), sector, sectorBucket }),
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
    if (tickerDebug) console.log("[tickerAssembler] built view model", {
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

function computeMarketCapBucket(marketCap) {
  const mc = Number(marketCap);
  if (!Number.isFinite(mc) || mc <= 0) return null;
  if (mc >= 10_000_000_000) return "Large";
  if (mc >= 2_000_000_000) return "Mid";
  if (mc >= 300_000_000) return "Small";
  return "Micro";
}

function ttmFromQuarterSeries(seriesAsc, field, n = 4) {
  const slice = (seriesAsc || []).slice(-n);
  if (slice.length < n) return null;
  let acc = 0;
  for (const q of slice) {
    const v = Number(q?.[field]);
    if (!Number.isFinite(v)) return null;
    acc += v;
  }
  return acc;
}

function computeRevenueGrowthYoY({ statementQuarterlySeries, annualSeries, annualMode }) {
  if (annualMode) {
    const years = Array.isArray(annualSeries) ? annualSeries : [];
    const sorted = years
      .filter((p) => p?.periodEnd && Number.isFinite(Number(p?.revenue)))
      .sort((a, b) => Date.parse(a.periodEnd) - Date.parse(b.periodEnd));
    if (sorted.length < 2) return null;
    const latest = Number(sorted.at(-1)?.revenue);
    const prior = Number(sorted.at(-2)?.revenue);
    return pctChange(latest, prior);
  }

  const quartersAsc = sortByPeriodEndAsc(statementQuarterlySeries || []).filter((q) =>
    Number.isFinite(Number(q?.revenue))
  );
  if (quartersAsc.length < 8) return null;
  const latestTtm = ttmFromQuarterSeries(quartersAsc, "revenue", 4);
  const priorTtm = ttmFromQuarterSeries(quartersAsc.slice(0, -4), "revenue", 4);
  return pctChange(latestTtm, priorTtm);
}

function computeFcfMarginTTM({ ttm, statementQuarterlySeries, annualSeries, annualMode }) {
  const fcf = Number(ttm?.freeCashFlow);
  const rev = Number(ttm?.revenue);
  if (Number.isFinite(fcf) && Number.isFinite(rev) && rev !== 0) return (fcf / Math.abs(rev)) * 100;

  if (annualMode) {
    const years = Array.isArray(annualSeries) ? annualSeries : [];
    const sorted = years
      .filter((p) => p?.periodEnd)
      .sort((a, b) => Date.parse(a.periodEnd) - Date.parse(b.periodEnd));
    const latest = sorted.at(-1) || null;
    const fcfAnnual = Number(latest?.freeCashFlow ?? (Number.isFinite(Number(latest?.operatingCashFlow)) && Number.isFinite(Number(latest?.capex)) ? Number(latest.operatingCashFlow) - Math.abs(Number(latest.capex)) : null));
    const revAnnual = Number(latest?.revenue);
    if (Number.isFinite(fcfAnnual) && Number.isFinite(revAnnual) && revAnnual !== 0) return (fcfAnnual / Math.abs(revAnnual)) * 100;
    return null;
  }

  const quartersAsc = sortByPeriodEndAsc(statementQuarterlySeries || []);
  const fcfTtm = ttmFromQuarterSeries(quartersAsc, "freeCashFlow", 4);
  const revTtm = ttmFromQuarterSeries(quartersAsc, "revenue", 4);
  if (Number.isFinite(fcfTtm) && Number.isFinite(revTtm) && revTtm !== 0) return (fcfTtm / Math.abs(revTtm)) * 100;
  return null;
}

function computeDividendStats({ quarterlySeries, annualSeries, annualMode, marketCap, ttmFcf }) {
  const mc = Number(marketCap);
  if (!Number.isFinite(mc) || mc <= 0) {
    return { dividendYield: null, dividendCovered: null, dividendsPaidTTM: null };
  }

  const getDividendsPaidTtm = () => {
    if (annualMode) {
      const years = Array.isArray(annualSeries) ? annualSeries : [];
      const latest = years
        .filter((p) => p?.periodEnd)
        .sort((a, b) => Date.parse(b.periodEnd) - Date.parse(a.periodEnd))[0] || null;
      const raw = Number(latest?.dividendsPaid);
      return Number.isFinite(raw) ? Math.abs(raw) : null;
    }

    const quartersAsc = sortByPeriodEndAsc(quarterlySeries || []);
    const slice = quartersAsc.slice(-4);
    if (slice.length < 4) return null;
    let acc = 0;
    let any = false;
    for (const q of slice) {
      const raw = Number(q?.dividendsPaid);
      if (Number.isFinite(raw)) {
        acc += Math.abs(raw);
        any = true;
      }
    }
    return any ? acc : null;
  };

  const dividendsPaidTTM = getDividendsPaidTtm();
  const dividendYield = dividendsPaidTTM != null ? (dividendsPaidTTM / mc) * 100 : null;
  const dividendCovered =
    dividendsPaidTTM != null && Number.isFinite(Number(ttmFcf))
      ? Number(ttmFcf) >= dividendsPaidTTM
      : null;

  return { dividendYield, dividendCovered, dividendsPaidTTM };
}

function computeDepositGrowthYoY({ quarterlySeries, issuerIsFintech }) {
  const seriesAsc = sortByPeriodEndAsc(quarterlySeries || []);
  if (!seriesAsc.length) return null;

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

  const latest = seriesAsc.at(-1);
  const now = depositsValue(latest);
  if (now == null) return null;

  const yearAgo = latest?.periodEnd ? findComparableYearAgo(seriesAsc, latest.periodEnd) : null;
  const prior = yearAgo ? depositsValue(yearAgo) : null;
  if (prior == null) return null;
  if (!issuerIsFintech) return null;
  return pctChange(now, prior);
}

function buildKeyRiskOneLinerFromReasons(reasons = []) {
  const negatives = (reasons || [])
    .filter((r) => r && r.score < 0 && !r.missing && !r.notApplicable)
    .sort((a, b) => (a.score || 0) - (b.score || 0));

  const looksLikeValuation = (name) => {
    const n = String(name || "").toLowerCase();
    return (
      n.includes("price /") ||
      n.includes("p/e") ||
      n.includes("p/s") ||
      n.includes("valuation") ||
      n.includes("earnings multiple") ||
      n.includes("multiple")
    );
  };

  const strongest = negatives[0] || null;
  const strongestIsValuation = strongest && looksLikeValuation(strongest?.name);
  const topNonVal = negatives.find((r) => !looksLikeValuation(r?.name)) || null;
  const chooseValuation =
    strongest &&
    strongestIsValuation &&
    (!topNonVal || Math.abs(Number(strongest.score) || 0) >= Math.abs(Number(topNonVal.score) || 0) * 1.5);

  const top = chooseValuation ? strongest : (topNonVal || strongest);
  if (!top) return null;
  const msg = top.message ? `${top.name}: ${top.message}` : String(top.name || "");
  const cleaned = String(msg).replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return cleaned.length > 160 ? `${cleaned.slice(0, 157)}...` : cleaned;
}

function buildProminentSentimentOneLinerFromReasons(reasons = [], normalizedScore = null) {
  const eligible = (reasons || [])
    .filter((r) => r && !r.missing && !r.notApplicable && Number.isFinite(Number(r.score)) && Number(r.score) !== 0);

  const looksLikeValuation = (name) => {
    const n = String(name || "").toLowerCase();
    return (
      n.includes("price /") ||
      n.includes("p/e") ||
      n.includes("p/s") ||
      n.includes("valuation") ||
      n.includes("earnings multiple") ||
      n.includes("multiple")
    );
  };

  const isPositive = normalizedScore != null && normalizedScore >= 70;
  const isNegative = normalizedScore != null && normalizedScore < 40;
  const isRedundant = (name) => {
    const n = String(name || "").toLowerCase();
    return n.includes("revenue growth") || n.includes("fcf margin");
  };

  // Prioritize based on overall score bias to resolve "Sentiment Paradox"
  const sorted = eligible
    .slice()
    .sort((a, b) => {
      const aScore = Number(a.score);
      const bScore = Number(b.score);

      // Deprioritize redundant metrics already in the screener table
      const aRed = isRedundant(a.name);
      const bRed = isRedundant(b.name);
      if (aRed && !bRed) return 1;
      if (!aRed && bRed) return -1;

      if (isPositive) {
        // For bullish stocks, prioritize positive highlights
        if (aScore > 0 && bScore <= 0) return -1;
        if (bScore > 0 && aScore <= 0) return 1;
      } else if (isNegative) {
        // For bearish stocks, prioritize negative risks
        if (aScore < 0 && bScore >= 0) return -1;
        if (bScore < 0 && aScore >= 0) return 1;
      }

      // Default: absolute magnitude
      return Math.abs(bScore) - Math.abs(aScore);
    });

  // Prefer non-valuation unless valuation dominates by a wide margin.
  const strongest = sorted[0] || null;
  const strongestIsValuation = strongest && looksLikeValuation(strongest?.name);
  const topNonVal = sorted.find((r) => !looksLikeValuation(r?.name)) || null;
  const chooseValuation =
    strongest &&
    strongestIsValuation &&
    (!topNonVal || Math.abs(Number(strongest.score) || 0) >= Math.abs(Number(topNonVal.score) || 0) * 1.5);
  const top = chooseValuation ? strongest : (topNonVal || strongest);
  if (!top) return null;

  const scoreNum = Number(top.score);
  const pts = Math.round(scoreNum);
  const ptsStr = pts > 0 ? `+${pts}` : `${pts}`;

  let ruleName = top.name || "";
  if (ruleName === "Shares dilution YoY" && pts > 0) {
    ruleName = "Share Buybacks";
  }

  const msg = top.message ? `${ruleName}: ${top.message}` : String(ruleName);
  const cleaned = String(msg).replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  const final = `${ptsStr} ${cleaned}`;
  return final.length > 160 ? `${final.slice(0, 157)}...` : final;
}

function readFundamentalsCache(ticker) {
  try {
    const key = String(ticker || "").toUpperCase();
    if (!key) return {};
    const outPath = path.join(EDGAR_DIR, `${key}-fundamentals.json`);
    if (!fs.existsSync(outPath)) return {};
    const raw = fs.readFileSync(outPath, "utf8");
    return JSON.parse(raw) || {};
  } catch (_) {
    return {};
  }
}

export async function buildScreenerRowForTicker(ticker, { allowFilingScan = false } = {}) {
  try {
    const key = String(ticker || "").toUpperCase().trim();
    if (!key) return null;

    const fundamentals = (await getFundamentalsForTicker(key)) || [];
    if (!fundamentals.length) return null;

    const nowIso = new Date().toISOString();

    const cached = readFundamentalsCache(key);
    const cachedSignals = Array.isArray(cached?.filingSignals) ? cached.filingSignals : [];
    const cachedMeta = cached?.filingSignalsMeta || null;

    const quarterlySeries = toQuarterlySeries(fundamentals);
    const statementQuarterlySeries = quarterlySeries.filter(
      (q) =>
        isFiniteValue(q?.revenue) ||
        isFiniteValue(q?.netIncome) ||
        isFiniteValue(q?.operatingCashFlow) ||
        isFiniteValue(q?.capex) ||
        isFiniteValue(q?.freeCashFlow)
    );

    // Cached prices only: no enqueues, no outbound calls.
    const dbCached = await getLatestCachedPrice(key);
    let latestCached = dbCached;

    // OVERRIDE from static prices.json if available (Git-synced source of truth for Railway)
    const patch = loadStaticPricePatch();
    const hit = lookupPricePatch(patch, key);
    if (hit && Number.isFinite(Number(hit.p))) {
      latestCached = {
        ticker: key,
        date: hit.t,
        close: Number(hit.p),
        marketCap: hit.mc ? Number(hit.mc) : (dbCached?.marketCap || null),
        currency: dbCached?.currency || "USD",
        source: hit.s,
        updatedAt: new Date().toISOString()
      };
    }
    const recent = await getRecentPrices(key, Number(process.env.SCREENER_PRICE_SERIES_LIMIT) || 260);
    const series = recent.map((p) => ({ date: p.date, close: p.close }));
    const pricePieces = series.length
      ? buildPricePieces(series)
      : { priceSummary: emptyPriceSummary(), priceHistory: [] };
    let priceSummary = pricePieces.priceSummary;
    let priceHistory = pricePieces.priceHistory;
    const externalMarketCap = latestCached?.marketCap || null;
    const externalCurrency = latestCached?.currency || null;

    // GLOBAL SHARE SCALING CORRECTION (same heuristic as ticker VM; cached price only)
    if (quarterlySeries.length && priceSummary?.lastClose != null) {
      const latestForScaling = quarterlySeries[quarterlySeries.length - 1];
      const sharesForScaling = Number(latestForScaling?.sharesOutstanding);
      const priceForScaling = Number(priceSummary?.lastClose);
      const assetsForScaling = Number(latestForScaling?.totalAssets);
      if (
        Number.isFinite(sharesForScaling) &&
        Number.isFinite(priceForScaling) &&
        Number.isFinite(assetsForScaling) &&
        sharesForScaling > 0
      ) {
        const impliedCap = sharesForScaling * priceForScaling;
        if (assetsForScaling > 100_000_000 && impliedCap < 25_000_000 && sharesForScaling < 5_000_000) {
          const scale = 1000;
          for (const q of quarterlySeries) {
            if (Number.isFinite(q.sharesOutstanding)) q.sharesOutstanding *= scale;
          }
          for (const p of fundamentals) {
            if (Number.isFinite(p.sharesOutstanding)) p.sharesOutstanding *= scale;
            if (Number.isFinite(p.shares)) p.shares *= scale;
          }
        }
      }
    }

    const annualSeries = [...(fundamentals || [])]
      .filter((p) => (p.periodType || "").toLowerCase() === "year")
      .sort((a, b) => Date.parse(b.periodEnd || 0) - Date.parse(a.periodEnd || 0));
    const latestAnnual = annualSeries[0] || null;
    const ttmMeta = buildTtmWithDerived({
      quartersAsc: sortByPeriodEndAsc(statementQuarterlySeries),
      latestAnnual
    });
    const ttm = ttmMeta.ttm;

    const growth = computeGrowth(fundamentals);
    const baseSic = fundamentals.find((p) => Number.isFinite(p.sic))?.sic ?? null;
    const baseSector = fundamentals.find((p) => p.sector)?.sector || null;
    const sectorInfo = classifySector({ ticker: key, sic: baseSic });
    const sector = (sectorInfo.sector && sectorInfo.sector !== "Other") ? sectorInfo.sector : (baseSector || sectorInfo.sector || null);
    const sectorBucket = resolveSectorBucket(sector);

    const latestQuarter = statementQuarterlySeries.at(-1) || quarterlySeries.at(-1) || null;
    const latestBalance = latestQuarter || latestAnnual || null;
    const shares = (() => {
      const fromQuarter = latestQuarter?.sharesOutstanding;
      if (Number.isFinite(fromQuarter)) return fromQuarter;
      const fromFundamentals = fundamentals
        .map((p) => p.sharesOutstanding ?? p.shares)
        .find((v) => Number.isFinite(v));
      if (Number.isFinite(fromFundamentals)) return fromFundamentals;
      return null;
    })();

    const keyMetrics = computeKeyMetrics({
      ttm,
      latestQuarter,
      latestBalance,
      shares,
      priceSummary,
      growth
    });

    // Filing intelligence: optional scan with fallback to cache.
    let filingSignals = null;
    if (allowFilingScan) {
      try {
        const maxFilings = Number(process.env.FILING_SIGNALS_MAX_FILINGS_DEEP) || 10;
        filingSignals = await scanFilingForSignals(key, { deep: true, maxFilings });
      } catch (err) {
        console.warn("[tickerAssembler] filing signal scan failed", key, err?.message || err);
      }
    }

    const resolvedFilingSignals = filingSignals?.signals || cachedSignals || [];
    const resolvedFilingMeta = filingSignals?.meta || cachedMeta || null;

    // Foreign issuer handling (from filing meta when available).
    const defaultFilingProfile = { annual: "10-K", interim: "10-Q", current: "8-K" };
    const filingProfile =
      resolvedFilingMeta?.filingProfile ||
      (resolvedFilingMeta?.latestForm === "20-F" ? { annual: "20-F", interim: "6-K", current: "6-K" } : null) ||
      defaultFilingProfile;
    const issuerType =
      resolvedFilingMeta?.issuerType ||
      (filingProfile?.annual === "20-F" || filingProfile?.interim === "6-K" ? "foreign" : "domestic");
    const annualMode = issuerType === "foreign" && quarterlySeries.length < 2 && annualSeries.length > 0;

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

    const snapshot = buildSnapshot({
      ttm,
      quarterlySeries,
      annualSeries,
      annualMode,
      keyMetrics,
      growth,
      latestBalance,
      shortInterest: null
    });
    const projections = buildProjections({ snapshot, growth, quarterlySeries, annualSeries, annualMode, keyMetrics });

    const filteredSignals = (resolvedFilingSignals || []).filter(
      (s) => !(issuerType === "foreign" && s?.id === "going_concern")
    );
    const clinicalSetback = detectClinicalSetbackSignal(filteredSignals, sectorBucket);
    const filingSignalsFinal = clinicalSetback ? [...filteredSignals, clinicalSetback] : filteredSignals;

    const financialSeriesForRules = statementQuarterlySeries.length ? statementQuarterlySeries : annualSeries;
    const rating = computeRuleRating({
      ticker: key,
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

    const score = rating?.normalizedScore ?? null;
    const marketCap = snapshot?.marketCap ?? keyMetrics?.marketCap ?? null;
    const marketCapBucket = computeMarketCapBucket(marketCap);

    const revenueGrowthYoY = computeRevenueGrowthYoY({
      statementQuarterlySeries,
      annualSeries,
      annualMode
    });
    const fcfMarginTTM = computeFcfMarginTTM({ ttm, statementQuarterlySeries, annualSeries, annualMode });

    const dividend = computeDividendStats({
      quarterlySeries,
      annualSeries,
      annualMode,
      marketCap,
      ttmFcf: ttm?.freeCashFlow
    });

    const growthAdjustment = (rating?.reasons || []).find((r) => r?.name === "Growth Phase Adjustment")?.score ?? 0;

    const issuerIsFintech = isFintech({ ticker: key, sector, sectorBucket });
    const depositGrowthYoY = computeDepositGrowthYoY({ quarterlySeries, issuerIsFintech });

    const fcfPositive = Number.isFinite(Number(ttm?.freeCashFlow)) && Number(ttm.freeCashFlow) > 0;
    const lowDebt = (() => {
      if (snapshot?.debtIsZero) return true;
      const years = Number(snapshot?.netDebtToFcfYears);
      if (Number.isFinite(years)) return years <= 3;
      const dte = Number(keyMetrics?.debtToEquity ?? snapshot?.debtToEquity);
      if (Number.isFinite(dte)) return dte <= 0.6;
      return false;
    })();
    const highGrowth = Number.isFinite(revenueGrowthYoY) ? revenueGrowthYoY >= 30 : false;
    // Compute isPenny and isBiotechFlag for screener row
    const isBiotechFlag = sectorBucket === "Biotech/Pharma";
    const lastClose = priceSummary?.lastClose;
    const hasPennyPrice = Number.isFinite(lastClose) && lastClose < 5;
    const hasMicroCap = Number.isFinite(marketCap) && marketCap > 0 && marketCap < 300_000_000;
    const isPenny = hasPennyPrice || (hasMicroCap && !isBiotechFlag);

    const prominentSentiment = (() => {
      // 1. Check for severe "Penny Stock" or "Microcap" warning
      if (isPenny || (marketCap && marketCap < 300_000_000 && sectorBucket !== "Biotech/Pharma")) {
        return "Micro-cap volatility expected; financial position looks broadly stable.";
      }
      // 2. Fallback to extracting from reasons (but prioritizing the penny check above)
      return buildProminentSentimentOneLinerFromReasons(rating?.reasons || [], score);
    })();
    return {
      ticker: key,
      name: fundamentals[0]?.companyName || cached?.companyName || null,
      sector: sector || null,
      sectorBucket,
      score: score == null ? null : Number(score),
      tier: rating?.tierLabel || null,
      marketCap: marketCap == null ? null : Number(marketCap),
      marketCapBucket,
      revenueGrowthYoY: revenueGrowthYoY == null ? null : Number(revenueGrowthYoY),
      fcfMarginTTM: fcfMarginTTM == null ? null : Number(fcfMarginTTM),
      peTTM: keyMetrics?.peTtm == null ? null : Number(keyMetrics.peTtm),
      dividendYield: dividend.dividendYield == null ? null : Number(dividend.dividendYield),
      dividendCovered: dividend.dividendCovered,
      fcfPositive,
      lowDebt,
      highGrowth,
      isFintech: issuerIsFintech,
      isBiotech: isBiotechFlag,
      isPenny,
      growthAdjustment: Number.isFinite(Number(growthAdjustment)) ? Number(growthAdjustment) : 0,
      depositGrowthYoY: depositGrowthYoY == null ? null : Number(depositGrowthYoY),
      keyRiskOneLiner: buildKeyRiskOneLinerFromReasons(rating?.reasons || []),
      prominentSentiment: buildProminentSentimentOneLinerFromReasons(rating?.reasons || [], score),
      updatedAt: nowIso
    };
  } catch (err) {
    console.warn("[tickerAssembler] buildScreenerRowForTicker failed", ticker, err?.message || err);
    return null;
  }
}
