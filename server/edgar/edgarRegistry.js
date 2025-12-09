import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getDb } from "./fundamentalsStore.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const EDGAR_DIR = path.join(ROOT, "data", "edgar");
export const RELEVANT_FORMS = ["10-K", "10-Q", "8-K", "DEF 14A", "DEF14A"];

function fundamentalsPath(ticker) {
  return path.join(EDGAR_DIR, `${ticker.toUpperCase()}-fundamentals.json`);
}

export async function upsertEdgarTicker({
  ticker,
  cik = null,
  lastCheckedAt = null,
  lastFilingDate = null,
  lastFilingType = null,
  isActive = 1
}) {
  if (!ticker) throw new Error("ticker is required");
  const db = await getDb();
  const stmt = db.prepare(`
    INSERT INTO edgar_tickers (ticker, cik, last_checked_at, last_filing_date, last_filing_type, is_active)
    VALUES (@ticker, @cik, @lastCheckedAt, @lastFilingDate, @lastFilingType, @isActive)
    ON CONFLICT(ticker) DO UPDATE SET
      cik = COALESCE(excluded.cik, edgar_tickers.cik),
      last_checked_at = excluded.last_checked_at,
      last_filing_date = excluded.last_filing_date,
      last_filing_type = excluded.last_filing_type,
      is_active = excluded.is_active;
  `);
  stmt.run({
    ticker: ticker.toUpperCase(),
    cik,
    lastCheckedAt,
    lastFilingDate,
    lastFilingType,
    isActive
  });
}

export async function getEdgarTicker(ticker) {
  if (!ticker) return null;
  const db = await getDb();
  const stmt = db.prepare(`
    SELECT ticker, cik, last_checked_at as lastCheckedAt, last_filing_date as lastFilingDate,
           last_filing_type as lastFilingType, is_active as isActive
    FROM edgar_tickers
    WHERE ticker = @ticker
  `);
  const row = stmt.get({ ticker: ticker.toUpperCase() });
  return row || null;
}

export async function markTickerChecked(ticker, ts = new Date().toISOString()) {
  if (!ticker) return;
  const db = await getDb();
  db.prepare(`UPDATE edgar_tickers SET last_checked_at = @ts WHERE ticker = @ticker`).run({
    ts,
    ticker: ticker.toUpperCase()
  });
}

export async function getTickersForBootstrap(limit = 50) {
  const db = await getDb();
  const candidates = db
    .prepare(
      `
      SELECT ticker, cik, last_checked_at as lastCheckedAt, last_filing_date as lastFilingDate
      FROM edgar_tickers
      WHERE is_active = 1
      ORDER BY CASE WHEN last_filing_date IS NULL OR last_filing_date = '' THEN 0 ELSE 1 END,
               COALESCE(last_checked_at, '') ASC,
               ticker ASC
      LIMIT @limit
    `
    )
    .all({ limit: Math.max(limit * 3, limit) });
  const missing = [];
  for (const row of candidates) {
    const fileMissing = !fs.existsSync(fundamentalsPath(row.ticker));
    if (!row.lastFilingDate || fileMissing) {
      missing.push(row);
    }
    if (missing.length >= limit) break;
  }
  return missing;
}

export async function recordFilingEvent({ ticker, filingType, filingDate, accession = null, headline = null }) {
  if (!ticker || !filingType || !filingDate) return null;
  const db = await getDb();
  const stmt = db.prepare(`
    INSERT INTO filing_events (ticker, filing_type, filing_date, accession, headline)
    VALUES (@ticker, @filingType, @filingDate, @accession, @headline)
  `);
  const info = stmt.run({
    ticker: ticker.toUpperCase(),
    filingType,
    filingDate,
    accession,
    headline
  });
  return info?.lastInsertRowid || null;
}

export async function getRecentFilingEvents({ limit = 50, since = null, ticker = null, type = null } = {}) {
  const db = await getDb();
  const clauses = [];
  const params = { limit };
  if (since) {
    clauses.push("filing_date >= @since");
    params.since = since;
  }
  if (ticker) {
    clauses.push("ticker = @ticker");
    params.ticker = ticker.toUpperCase();
  }
  if (type) {
    clauses.push("filing_type = @type");
    params.type = type;
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const stmt = db.prepare(
    `
    SELECT ticker, filing_type as filingType, filing_date as filingDate,
           accession, headline, created_at as createdAt
    FROM filing_events
    ${where}
    ORDER BY filing_date DESC, created_at DESC
    LIMIT @limit
  `
  );
  return stmt.all(params);
}

export async function listAllTickers() {
  const db = await getDb();
  const rows = db
    .prepare(
      `
      SELECT ticker, cik, last_checked_at as lastCheckedAt, last_filing_date as lastFilingDate,
             last_filing_type as lastFilingType, is_active as isActive
      FROM edgar_tickers
      WHERE is_active = 1
      ORDER BY ticker ASC
    `
    )
    .all();
  return rows || [];
}
