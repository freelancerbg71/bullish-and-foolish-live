/**
 * Simple daily cache in front of the quote endpoint.
 * Usage: node scripts/fmpCache.js AAPL MSFT
 * Writes data/<ticker>-YYYY-MM-DD.json and data/<ticker>-latest.json
 * Falls back to most recent cache on API failure.
 */

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, "..", "data");
const API_KEY = process.env.DATA_API_KEY;
const BASE = (process.env.DATA_API_BASE || "").replace(/\/$/, "");

if (!BASE) {
  throw new Error("DATA_API_BASE is not set. Configure a data provider before running this cache script.");
}

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

async function readLatestCache(ticker) {
  const latestFile = path.join(DATA_DIR, `${ticker}-latest.json`);
  try {
    const raw = await fs.readFile(latestFile, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeCache(ticker, payload) {
  const stamp = todayStamp();
  const dated = path.join(DATA_DIR, `${ticker}-${stamp}.json`);
  const latest = path.join(DATA_DIR, `${ticker}-latest.json`);
  const data = JSON.stringify(payload, null, 2);
  await fs.writeFile(dated, data, "utf8");
  await fs.writeFile(latest, data, "utf8");
  return payload;
}

async function fetchQuote(ticker) {
  const url = new URL(`${BASE}/quote/${encodeURIComponent(ticker)}`);
  if (API_KEY) url.searchParams.set("apikey", API_KEY);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Quote error ${res.status}`);
  const json = await res.json();
  if (!Array.isArray(json) || !json.length) throw new Error("Empty quote response");
  return json[0];
}

function transformQuote(ticker, quote) {
  const price = Number(quote.price);
  const yearLow = Number(quote.yearLow);
  const yearHigh = Number(quote.yearHigh);
  const changePct = yearLow && price ? (((price - yearLow) / yearLow) * 100).toFixed(2) + "%" : null;
  return {
    ticker,
    lastUpdated: todayStamp(),
    valuation: {
      marketCap: quote.marketCap ? `${quote.marketCap}` : null,
      enterpriseValue: null
    },
    shareStats: {
      sharesOutstanding: quote.sharesOutstanding ? `${quote.sharesOutstanding}` : null,
      sharesChangeYoY: null,
      sharesChangeQoQ: null,
      insiderOwnership: null,
      institutionOwnership: null,
      float: null
    },
    valuationRatios: {
      peRatio: Number(quote.pe) || null,
      forwardPE: null,
      psRatio: Number(quote.priceToSales) || null,
      forwardPS: null,
      pbRatio: Number(quote.priceToBook) || null,
      pfcfRatio: null,
      pegRatio: null,
      evToEbitda: null,
      fcfYield: null
    },
    financialPosition: {
      currentRatio: null,
      quickRatio: null,
      debtToEquity: null,
      debtToEbitda: null,
      debtToFCF: null,
      interestCoverage: null,
      netDebtToFcfYears: null,
      netCashToPrice: null
    },
    profitMargins: {
      grossMargin: null,
      operatingMargin: null,
      profitMargin: quote.eps && price ? ((Number(quote.eps) / price) * 100).toFixed(2) + "%" : null,
      fcfMargin: null
    },
    growth: {
      revenueGrowthTTM: null,
      revenueCagr3y: null,
      perShareGrowth: null
    },
    stability: {
      growthYearsCount: null,
      fcfPositiveYears: null
    },
    returns: {
      roe: null,
      roic: null
    },
    cash: {
      cashConversion: null,
      capexToRevenue: null
    },
    capitalReturns: {
      shareholderYield: null,
      totalYield: null
    },
    dividends: {
      payoutToFcf: null,
      growthYears: null
    },
    priceStats: {
      beta: Number(quote.beta) || null,
      week52Change: changePct,
      rsi: null,
      movingAverage50: Number(quote.priceAvg50) || null,
      movingAverage200: Number(quote.priceAvg200) || null
    }
  };
}

async function getTickerData(ticker) {
  await ensureDataDir();
  const stamp = todayStamp();
  const cachePath = path.join(DATA_DIR, `${ticker}-${stamp}.json`);
  try {
    const cached = await fs.readFile(cachePath, "utf8");
    return JSON.parse(cached);
  } catch {
    // not cached today
  }

  try {
    const quote = await fetchQuote(ticker);
    const transformed = transformQuote(ticker, quote);
    return await writeCache(ticker, transformed);
  } catch (err) {
    console.error(`[cache] API failed for ${ticker}:`, err.message);
    const latest = await readLatestCache(ticker);
    if (latest) {
      console.warn(`[cache] Falling back to latest cache for ${ticker} (${latest.lastUpdated || "unknown date"})`);
      return latest;
    }
    throw err;
  }
}

if (process.argv.length > 2) {
  const tickers = process.argv.slice(2).map(t => t.toUpperCase());
  (async () => {
    for (const t of tickers) {
      try {
        const data = await getTickerData(t);
        console.log(`[cache] ${t}: ok (lastUpdated ${data.lastUpdated})`);
      } catch (err) {
        console.error(`[cache] ${t}: failed -> ${err.message}`);
      }
    }
  })();
}

export { getTickerData };
