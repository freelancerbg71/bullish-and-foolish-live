import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getDb } from "./fundamentalsStore.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(ROOT, "data");
const EDGAR_DIR = path.join(DATA_DIR, "edgar");
export const RELEVANT_FORMS = ["10-K", "10-Q", "8-K", "6-K", "20-F", "DEF 14A", "DEF14A"];

function fundamentalsPath(ticker) {
  return path.join(EDGAR_DIR, `${ticker.toUpperCase()}-fundamentals.json`);
}

export async function upsertEdgarTicker({
  ticker,
  cik = null,
  lastCheckedAt = null,
  lastFilingDate = null,
  lastFilingType = null,
  priority = null,
  refreshIntervalDays = null,
  nextCheckAt = null,
  isActive = 1
}) {
  if (!ticker) throw new Error("ticker is required");
  const db = await getDb();
  const stmt = db.prepare(`
    INSERT INTO edgar_tickers (
      ticker, cik, last_checked_at, last_filing_date, last_filing_type,
      priority, refresh_interval_days, next_check_at,
      is_active
    )
    VALUES (
      @ticker, @cik, @lastCheckedAt, @lastFilingDate, @lastFilingType,
      @priority, @refreshIntervalDays, @nextCheckAt,
      @isActive
    )
    ON CONFLICT(ticker) DO UPDATE SET
      cik = COALESCE(excluded.cik, edgar_tickers.cik),
      last_checked_at = excluded.last_checked_at,
      last_filing_date = excluded.last_filing_date,
      last_filing_type = excluded.last_filing_type,
      priority = COALESCE(excluded.priority, edgar_tickers.priority),
      refresh_interval_days = COALESCE(excluded.refresh_interval_days, edgar_tickers.refresh_interval_days),
      next_check_at = COALESCE(excluded.next_check_at, edgar_tickers.next_check_at),
      is_active = excluded.is_active;
  `);
  stmt.run({
    ticker: ticker.toUpperCase(),
    cik,
    lastCheckedAt,
    lastFilingDate,
    lastFilingType,
    priority: priority == null ? null : Number(priority),
    refreshIntervalDays: refreshIntervalDays == null ? null : Number(refreshIntervalDays),
    nextCheckAt,
    isActive
  });
}

export async function getEdgarTicker(ticker) {
  if (!ticker) return null;
  const db = await getDb();
  const stmt = db.prepare(`
    SELECT ticker, cik, last_checked_at as lastCheckedAt, last_filing_date as lastFilingDate,
           last_filing_type as lastFilingType, is_active as isActive,
           priority, refresh_interval_days as refreshIntervalDays, next_check_at as nextCheckAt
    FROM edgar_tickers
    WHERE ticker = @ticker
  `);
  const row = stmt.get({ ticker: ticker.toUpperCase() });
  return row || null;
}

function daysToMs(days) {
  return Number(days) * 24 * 60 * 60 * 1000;
}

function computeDefaultRefreshDays(priority) {
  const p = Number(priority) || 0;
  if (p >= 2) return Number(process.env.EDGAR_REFRESH_DAYS_WATCHED) || 1;
  if (p === 1) return Number(process.env.EDGAR_REFRESH_DAYS_ACTIVE) || 7;
  return Number(process.env.EDGAR_REFRESH_DAYS_DEFAULT) || 30;
}

export async function markTickerChecked(ticker, ts = new Date().toISOString(), { scheduleNext = true } = {}) {
  if (!ticker) return;
  const db = await getDb();
  const key = ticker.toUpperCase();
  if (!scheduleNext) {
    db.prepare(`UPDATE edgar_tickers SET last_checked_at = @ts WHERE ticker = @ticker`).run({ ts, ticker: key });
    return;
  }
  const row = db.prepare(`SELECT priority, refresh_interval_days as refreshIntervalDays FROM edgar_tickers WHERE ticker=@ticker`).get({ ticker: key });
  const refreshDays = Number(row?.refreshIntervalDays) || computeDefaultRefreshDays(row?.priority);
  const next = new Date(Date.parse(ts) + daysToMs(refreshDays)).toISOString();
  db.prepare(`
    UPDATE edgar_tickers
    SET last_checked_at = @ts,
        next_check_at = @next
    WHERE ticker = @ticker
  `).run({ ts, next, ticker: key });
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

export async function getTickersDueForCheck(limit = 200, { nowIso = new Date().toISOString() } = {}) {
  const db = await getDb();
  const rows = db
    .prepare(
      `
      SELECT ticker, cik,
             last_checked_at as lastCheckedAt,
             last_filing_date as lastFilingDate,
             last_filing_type as lastFilingType,
             priority,
             refresh_interval_days as refreshIntervalDays,
             next_check_at as nextCheckAt
      FROM edgar_tickers
      WHERE is_active = 1
        AND (next_check_at IS NULL OR next_check_at = '' OR next_check_at <= @now)
      ORDER BY priority DESC, COALESCE(next_check_at, '') ASC, COALESCE(last_checked_at, '') ASC, ticker ASC
      LIMIT @limit
    `
    )
    .all({ now: nowIso, limit: Math.max(1, Number(limit) || 200) });
  return rows || [];
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
             last_filing_type as lastFilingType, is_active as isActive,
             priority, refresh_interval_days as refreshIntervalDays, next_check_at as nextCheckAt
      FROM edgar_tickers
      WHERE is_active = 1
      ORDER BY ticker ASC
    `
    )
    .all();
  return rows || [];
}
