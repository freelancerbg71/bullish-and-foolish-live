import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const DB_DIR = path.join(ROOT, "data", "edgar");
const DB_FILE = process.env.PRICES_DB_FILE || path.join(DB_DIR, "fundamentals.db");
const PRICE_FILE_DIR = path.join(ROOT, "data", "prices");

let dbPromise = null;

function normalizeTicker(ticker) {
  return ticker ? String(ticker).trim().toUpperCase() : "";
}

async function initDb() {
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    fs.mkdirSync(DB_DIR, { recursive: true });
    let Database;
    try {
      ({ default: Database } = await import("better-sqlite3"));
    } catch (err) {
      const e = new Error("better-sqlite3 is required for price caching. Install with `npm install better-sqlite3`.");
      e.cause = err;
      throw e;
    }
    const db = new Database(DB_FILE);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS prices_eod (
        id INTEGER PRIMARY KEY,
        ticker TEXT NOT NULL,
        date TEXT NOT NULL,
        close REAL NOT NULL,
        source TEXT NOT NULL,
        marketCap REAL,
        currency TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        UNIQUE (ticker, date)
      );
    `);

    // Auto-migration for existing tables
    try {
      db.prepare("ALTER TABLE prices_eod ADD COLUMN marketCap REAL").run();
    } catch (err) { /* ignore if exists */ }
    try {
      db.prepare("ALTER TABLE prices_eod ADD COLUMN currency TEXT").run();
    } catch (err) { /* ignore if exists */ }

    return db;
  })();
  return dbPromise;
}

export async function getLatestCachedPrice(ticker) {
  const key = normalizeTicker(ticker);
  if (!key) return null;
  const db = await initDb();
  const row = db
    .prepare(
      `SELECT ticker, date, close, source, marketCap, currency, updatedAt
       FROM prices_eod
       WHERE ticker = @ticker
       ORDER BY date DESC
       LIMIT 1`
    )
    .get({ ticker: key });
  if (!row) return null;
  return {
    ticker: row.ticker,
    date: row.date,
    close: Number(row.close),
    marketCap: row.marketCap ? Number(row.marketCap) : null,
    currency: row.currency || null,
    source: row.source,
    updatedAt: row.updatedAt
  };
}

export async function upsertCachedPrice(ticker, date, close, source, marketCap = null, currency = null) {
  const key = normalizeTicker(ticker);
  if (!key || !date || !Number.isFinite(Number(close)) || !source) return;
  const db = await initDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO prices_eod (ticker, date, close, source, marketCap, currency, createdAt, updatedAt)
     VALUES (@ticker, @date, @close, @source, @marketCap, @currency, @createdAt, @updatedAt)
     ON CONFLICT(ticker, date) DO UPDATE SET
       close=excluded.close,
       source=excluded.source,
       marketCap=excluded.marketCap,
       currency=excluded.currency,
       updatedAt=excluded.updatedAt`
  ).run({
    ticker: key,
    date,
    close: Number(close),
    source,
    marketCap: Number.isFinite(marketCap) ? marketCap : null,
    currency: currency || null,
    createdAt: now,
    updatedAt: now
  });
  await pruneOldPrices(key, 400);
  await writePriceFile(key, db);
  console.info("[priceStore] upserted price", { ticker: key, date, close: Number(close), marketCap, currency, source, file: path.join(PRICE_FILE_DIR, `${key}.json`) });
}

export async function upsertCachedPriceSeries(ticker, series = [], source, marketCap = null, currency = null) {
  const key = normalizeTicker(ticker);
  const arr = Array.isArray(series) ? series : [];
  if (!key || !arr.length || !source) return;

  const normalized = arr
    .map((p) => ({ date: String(p?.date || ""), close: Number(p?.close) }))
    .filter((p) => p.date && Number.isFinite(p.close) && p.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!normalized.length) return;

  const latestDate = normalized[normalized.length - 1].date;
  const db = await initDb();
  const now = new Date().toISOString();

  const stmt = db.prepare(
    `INSERT INTO prices_eod (ticker, date, close, source, marketCap, currency, createdAt, updatedAt)
     VALUES (@ticker, @date, @close, @source, @marketCap, @currency, @createdAt, @updatedAt)
     ON CONFLICT(ticker, date) DO UPDATE SET
       close=excluded.close,
       source=excluded.source,
       marketCap=excluded.marketCap,
       currency=excluded.currency,
       updatedAt=excluded.updatedAt`
  );

  const tx = db.transaction((rows) => {
    for (const r of rows) {
      const isLatest = r.date === latestDate;
      stmt.run({
        ticker: key,
        date: r.date,
        close: r.close,
        source,
        marketCap: isLatest && Number.isFinite(marketCap) ? Number(marketCap) : null,
        currency: isLatest ? (currency || null) : null,
        createdAt: now,
        updatedAt: now
      });
    }
  });

  tx(normalized);
  await pruneOldPrices(key, 400);
  await writePriceFile(key, db);
  console.info("[priceStore] upserted price series", {
    ticker: key,
    points: normalized.length,
    latestDate,
    latestClose: normalized[normalized.length - 1].close,
    source,
    file: path.join(PRICE_FILE_DIR, `${key}.json`)
  });
}

export async function getRecentPrices(ticker, limit = 2) {
  const key = normalizeTicker(ticker);
  if (!key) return [];
  const db = await initDb();
  const rows = db
    .prepare(
      `SELECT ticker, date, close, source, updatedAt
       FROM prices_eod
       WHERE ticker = @ticker
       ORDER BY date DESC
       LIMIT @limit`
    )
    .all({ ticker: key, limit: Math.max(1, Number(limit) || 2) });
  return rows.map((r) => ({
    ticker: r.ticker,
    date: r.date,
    close: Number(r.close),
    source: r.source,
    updatedAt: r.updatedAt
  }));
}

export async function pruneOldPrices(ticker, keep = 2) {
  const key = normalizeTicker(ticker);
  if (!key) return;
  const db = await initDb();
  db.prepare(
    `DELETE FROM prices_eod
     WHERE ticker = @ticker
       AND date NOT IN (
         SELECT date FROM prices_eod
         WHERE ticker = @ticker
         ORDER BY date DESC
       LIMIT @keep
      )`
  ).run({ ticker: key, keep: Math.max(1, Number(keep) || 2) });
}

async function writePriceFile(ticker, db) {
  try {
    fs.mkdirSync(PRICE_FILE_DIR, { recursive: true });
    const rows = db
      .prepare(
        `SELECT date, close FROM prices_eod
         WHERE ticker = @ticker
         ORDER BY date ASC
         LIMIT 400`
      )
      .all({ ticker });
    const outPath = path.join(PRICE_FILE_DIR, `${ticker}.json`);
    fs.writeFileSync(outPath, JSON.stringify(rows, null, 2));
  } catch (err) {
    console.warn("[priceStore] failed to write price file", ticker, err?.message || err);
  }
}
