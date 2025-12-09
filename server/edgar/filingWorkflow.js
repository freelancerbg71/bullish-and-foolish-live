import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { fetchCompanyFundamentals } from "./edgarFundamentals.js";
import { upsertFundamentals } from "./fundamentalsStore.js";
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const EDGAR_DIR = path.join(ROOT, "data", "edgar");

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

export async function fetchLatestRelevantFiling(ticker) {
  const rows = await fetchRecentFilingsMeta(ticker, RELEVANT_FORMS, 1);
  return rows?.[0] || null;
}

function isAfter(dateA, dateB) {
  const a = Date.parse(dateA || "");
  const b = Date.parse(dateB || "");
  if (!Number.isFinite(a)) return false;
  if (!Number.isFinite(b)) return true;
  return a > b;
}

export async function processFilingForTicker(ticker, filingMeta = null, { createEvent = true } = {}) {
  if (!ticker) throw new Error("ticker is required");
  const tickerKey = ticker.toUpperCase();
  const existing = await getEdgarTicker(tickerKey);
  const nowIso = new Date().toISOString();
  const latestFiling = filingMeta || (await fetchLatestRelevantFiling(tickerKey));

  const fundamentals = await fetchCompanyFundamentals(tickerKey);
  await upsertFundamentals(fundamentals);

  let filingSignals = null;
  try {
    filingSignals = await scanFilingForSignals(tickerKey);
  } catch (err) {
    console.warn("[filingWorkflow] filing signal scan failed", tickerKey, err?.message || err);
  }

  const filingDate = latestFiling?.filed || filingSignals?.meta?.latestFiled || null;
  const filingType = latestFiling?.form || filingSignals?.meta?.latestForm || null;
  const accession = latestFiling?.accession || filingSignals?.meta?.latestAccession || null;
  const cik =
    fundamentals?.[0]?.cik || latestFiling?.cik || existing?.cik || filingSignals?.meta?.cik || null;

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
