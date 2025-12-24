import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { fetchCompanyFundamentals, lookupCompanyByTicker, normalizeEdgarCik } from "./edgarFundamentals.js";
import { upsertFundamentals, writeFundamentalsSnapshot } from "./fundamentalsStore.js";
import {
  fetchRecentFilingsMeta,
  scanFilingForSignals
} from "./filingTextScanner.js";
import {
  getEdgarTicker,
  recordFilingEvent,
  RELEVANT_FORMS,
  upsertEdgarTicker
} from "./edgarRegistry.js";
import { refreshScreenerRow } from "../screener/screenerService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(ROOT, "data");
const EDGAR_DIR = path.join(DATA_DIR, "edgar");

function fundamentalsPath(ticker) {
  return path.join(EDGAR_DIR, `${ticker.toUpperCase()}-fundamentals.json`);
}

export function hasFundamentalsCache(ticker) {
  if (!ticker) return false;
  try {
    return fs.existsSync(fundamentalsPath(ticker));
  } catch (_) {
    return false;
  }
}

export async function fetchLatestRelevantFiling(ticker, opts = {}) {
  const rows = await fetchRecentFilingsMeta(ticker, RELEVANT_FORMS, 1, opts);
  return rows?.[0] || null;
}

function isAfter(dateA, dateB) {
  const a = Date.parse(dateA || "");
  const b = Date.parse(dateB || "");
  if (!Number.isFinite(a)) return false;
  if (!Number.isFinite(b)) return true;
  return a > b;
}

export async function processFilingForTicker(
  ticker,
  filingMeta = null,
  { createEvent = true, includeFilingSignals = true, includeLatestFilingMeta = true, jsonOnly = false } = {}
) {
  if (!ticker) throw new Error("ticker is required");
  const tickerKey = ticker.toUpperCase();
  const nowIso = new Date().toISOString();
  const company = await lookupCompanyByTicker(tickerKey);
  const cik = normalizeEdgarCik(company?.cik);
  if (!cik) {
    const err = new Error("CIK not found for ticker");
    err.code = "EDGAR_TICKER_NOT_FOUND";
    err.status = 404;
    err.ticker = tickerKey;
    throw err;
  }
  const existing = jsonOnly ? null : await getEdgarTicker(tickerKey);
  const latestFiling =
    includeLatestFilingMeta
      ? (filingMeta || (await fetchLatestRelevantFiling(tickerKey, { company, cik })))
      : null;

  const fundamentals = await fetchCompanyFundamentals(tickerKey, { company, cik });

  let filingSignals = null;
  if (includeFilingSignals) {
    try {
      const deep = process.env.EDGAR_FILING_SIGNALS_DEEP === "1";
      const maxFilings = deep
        ? (Number(process.env.FILING_SIGNALS_MAX_FILINGS_DEEP) || 10)
        : (Number(process.env.FILING_SIGNALS_MAX_FILINGS) || 3);
      filingSignals = await scanFilingForSignals(tickerKey, { company, cik, deep, maxFilings });
    } catch (err) {
      console.warn("[filingWorkflow] filing signal scan failed", tickerKey, err?.message || err);
    }
  }

  if (jsonOnly) {
    try {
      writeFundamentalsSnapshot(fundamentals, { filingSignalsResult: filingSignals });
    } catch (err) {
      console.warn("[filingWorkflow] JSON-only snapshot write failed", tickerKey, err?.message || err);
    }
  } else {
    await upsertFundamentals(fundamentals);
    try {
      await refreshScreenerRow(tickerKey);
    } catch (err) {
      console.warn("[filingWorkflow] screener refresh failed", tickerKey, err?.message || err);
    }
  }

  const filingDate = latestFiling?.filed || filingSignals?.meta?.latestFiled || null;
  const filingType = latestFiling?.form || filingSignals?.meta?.latestForm || null;
  const accession = latestFiling?.accession || filingSignals?.meta?.latestAccession || null;

  if (!jsonOnly) {
    await upsertEdgarTicker({
      ticker: tickerKey,
      cik,
      lastCheckedAt: nowIso,
      lastFilingDate: filingDate,
      lastFilingType: filingType,
      isActive: 1
    });

    if (createEvent && filingDate && isAfter(filingDate, existing?.lastFilingDate)) {
      await recordFilingEvent({
        ticker: tickerKey,
        filingType: filingType || "FILING",
        filingDate,
        accession,
        headline: filingType ? `New ${filingType} filed` : null
      });
    }
  }

  return {
    fundamentals,
    filingSignals,
    filing: {
      filingDate,
      filingType,
      accession
    }
  };
}
