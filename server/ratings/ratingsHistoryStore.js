import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(ROOT, "data");
const DB_DIR = path.join(DATA_DIR, "ratings");
const DEFAULT_DB_FILE = path.join(DB_DIR, "ratings_history.db");

let dbPromise = null;
let dbInstance = null;

function resolveDbFile() {
  return process.env.RATINGS_DB_FILE || DEFAULT_DB_FILE;
}

async function initDb() {
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    let Database;
    try {
      ({ default: Database } = await import("better-sqlite3"));
    } catch (err) {
      const e = new Error("better-sqlite3 is required for ratings history persistence. Install with `npm install better-sqlite3`.");
      e.cause = err;
      throw e;
    }
    fs.mkdirSync(DB_DIR, { recursive: true });
    const dbFile = resolveDbFile();
    const db = new Database(dbFile);
    dbInstance = db;
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS rating_history (
        ticker TEXT NOT NULL,
        periodEnd TEXT NOT NULL,
        filedDate TEXT,
        basis TEXT NOT NULL,
        score REAL,
        rawScore REAL,
        tier TEXT,
        priceAt REAL,
        priceDate TEXT,
        modelVersion TEXT,
        computedAt TEXT NOT NULL,
        PRIMARY KEY (ticker, periodEnd, basis)
      );
      CREATE INDEX IF NOT EXISTS idx_rating_history_ticker_period
        ON rating_history (ticker, periodEnd DESC);
    `);
    return db;
  })();
  return dbPromise;
}

export async function closeRatingsDb() {
  if (!dbPromise || !dbInstance) return;
  try {
    dbInstance.close();
  } catch (_) { }
  dbPromise = null;
  dbInstance = null;
}

export async function insertRatingSnapshot(snapshot) {
  if (!snapshot?.ticker || !snapshot?.periodEnd || !snapshot?.basis) return false;
  const db = await initDb();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO rating_history (
      ticker, periodEnd, filedDate, basis, score, rawScore, tier, priceAt, priceDate, modelVersion, computedAt
    ) VALUES (
      @ticker, @periodEnd, @filedDate, @basis, @score, @rawScore, @tier, @priceAt, @priceDate, @modelVersion, @computedAt
    )
  `);
  const result = stmt.run(snapshot);
  return result.changes > 0;
}

export async function getLatestRatingSnapshots(ticker, { basis = null, limit = 2 } = {}) {
  if (!ticker) return [];
  const db = await initDb();
  const sql = `
    SELECT ticker, periodEnd, filedDate, basis, score, rawScore, tier, priceAt, priceDate, modelVersion, computedAt
    FROM rating_history
    WHERE ticker = @ticker
    ${basis ? "AND basis = @basis" : ""}
    ORDER BY periodEnd DESC
    LIMIT @limit
  `;
  return db.prepare(sql).all({
    ticker: String(ticker).toUpperCase(),
    basis,
    limit: Math.max(1, Math.trunc(Number(limit) || 2))
  });
}
