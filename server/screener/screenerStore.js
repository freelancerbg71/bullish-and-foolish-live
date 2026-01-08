import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

let ensured = false;
let dbPromise = null;
let dbInstance = null;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(ROOT, "data");
const DB_DIR = path.join(DATA_DIR, "edgar");
const DEFAULT_DB_FILE = path.join(DB_DIR, "fundamentals.db");
const DB_FILE =
  process.env.SCREENER_DB_FILE ||
  process.env.FUNDAMENTALS_DB_FILE ||
  process.env.EDGAR_DB_FILE ||
  DEFAULT_DB_FILE;

async function initDb() {
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
    let Database;
    try {
      ({ default: Database } = await import("better-sqlite3"));
    } catch (err) {
      const e = new Error("better-sqlite3 is required for screener storage. Install with `npm install better-sqlite3`.");
      e.cause = err;
      throw e;
    }
    const db = new Database(DB_FILE);
    dbInstance = db;
    db.pragma("journal_mode = WAL");
    return db;
  })();
  return dbPromise;
}

export async function ensureScreenerSchema() {
  if (ensured) return;
  const db = await initDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS screener_index (
      ticker TEXT PRIMARY KEY,
      name TEXT,
      sector TEXT,
      sectorBucket TEXT,
      issuerType TEXT,
      annualMode INTEGER,
      score REAL,
      tier TEXT,
      marketCap REAL,
      marketCapBucket TEXT,
      revenueGrowthYoY REAL,
      fcfMarginTTM REAL,
      peTTM REAL,
      dividendYield REAL,
      dividendCovered INTEGER,
      lastTradePrice REAL,
      lastTradeAt TEXT,
      lastTradeSource TEXT,
      fcfPositive INTEGER,
      lowDebt INTEGER,
      highGrowth INTEGER,
      isFintech INTEGER,
      isBiotech INTEGER,
      isPenny INTEGER,
      growthAdjustment REAL,
      depositGrowthYoY REAL,
      keyRiskOneLiner TEXT,
      prominentSentiment TEXT,
      updatedAt TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_screener_score ON screener_index (score DESC);
    CREATE INDEX IF NOT EXISTS idx_screener_tier ON screener_index (tier);
    CREATE INDEX IF NOT EXISTS idx_screener_sectorBucket ON screener_index (sectorBucket);
    CREATE INDEX IF NOT EXISTS idx_screener_mcapBucket ON screener_index (marketCapBucket);
    CREATE INDEX IF NOT EXISTS idx_screener_marketCap ON screener_index (marketCap DESC);
    CREATE INDEX IF NOT EXISTS idx_screener_revGrowth ON screener_index (revenueGrowthYoY DESC);
    CREATE INDEX IF NOT EXISTS idx_screener_fcfMargin ON screener_index (fcfMarginTTM DESC);
    CREATE INDEX IF NOT EXISTS idx_screener_lastTradeAt ON screener_index (lastTradeAt DESC);
  `);

  // Best-effort migrations for existing DBs.
  try {
    const existing = new Set(db.prepare("PRAGMA table_info(screener_index)").all().map((c) => c.name));
    const desired = {
      issuerType: "TEXT",
      annualMode: "INTEGER",
      lastTradePrice: "REAL",
      lastTradeAt: "TEXT",
      lastTradeSource: "TEXT",
      prominentSentiment: "TEXT"
    };
    for (const [name, type] of Object.entries(desired)) {
      if (!existing.has(name)) {
        db.exec(`ALTER TABLE screener_index ADD COLUMN ${name} ${type}`);
      }
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_screener_lastTradeAt ON screener_index (lastTradeAt DESC);`);
  } catch (_) {
    // best-effort
  }
  ensured = true;
}

export async function getScreenerDb() {
  await ensureScreenerSchema();
  return initDb();
}

export async function closeDb() {
  if (!dbPromise || !dbInstance) return;
  try {
    dbInstance.close();
  } catch (_) { }
  dbInstance = null;
  dbPromise = null;
}

export async function upsertScreenerRows(rows = []) {
  await ensureScreenerSchema();
  const db = await initDb();
  const nowIso = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO screener_index (
      ticker, name, sector, sectorBucket,
      issuerType, annualMode, score, tier,
      marketCap, marketCapBucket,
      revenueGrowthYoY, fcfMarginTTM, peTTM,
      dividendYield, dividendCovered,
      lastTradePrice, lastTradeAt, lastTradeSource,
      fcfPositive, lowDebt, highGrowth, isFintech, isBiotech, isPenny,
      growthAdjustment, depositGrowthYoY,
      keyRiskOneLiner, prominentSentiment,
      updatedAt
    ) VALUES (
      @ticker, @name, @sector, @sectorBucket,
      @issuerType, @annualMode, @score, @tier,
      @marketCap, @marketCapBucket,
      @revenueGrowthYoY, @fcfMarginTTM, @peTTM,
      @dividendYield, @dividendCovered,
      @lastTradePrice, @lastTradeAt, @lastTradeSource,
      @fcfPositive, @lowDebt, @highGrowth, @isFintech, @isBiotech, @isPenny,
      @growthAdjustment, @depositGrowthYoY,
      @keyRiskOneLiner, @prominentSentiment,
      @updatedAt
    )
    ON CONFLICT(ticker) DO UPDATE SET
      name=excluded.name,
      sector=excluded.sector,
      sectorBucket=excluded.sectorBucket,
      issuerType=excluded.issuerType,
      annualMode=excluded.annualMode,
      score=excluded.score,
      tier=excluded.tier,
      marketCap=excluded.marketCap,
      marketCapBucket=excluded.marketCapBucket,
      revenueGrowthYoY=excluded.revenueGrowthYoY,
      fcfMarginTTM=excluded.fcfMarginTTM,
      peTTM=excluded.peTTM,
      dividendYield=excluded.dividendYield,
      dividendCovered=excluded.dividendCovered,
      lastTradePrice=COALESCE(excluded.lastTradePrice, screener_index.lastTradePrice),
      lastTradeAt=COALESCE(excluded.lastTradeAt, screener_index.lastTradeAt),
      lastTradeSource=COALESCE(excluded.lastTradeSource, screener_index.lastTradeSource),
      fcfPositive=excluded.fcfPositive,
      lowDebt=excluded.lowDebt,
      highGrowth=excluded.highGrowth,
      isFintech=excluded.isFintech,
      isBiotech=excluded.isBiotech,
      isPenny=excluded.isPenny,
      growthAdjustment=excluded.growthAdjustment,
      depositGrowthYoY=excluded.depositGrowthYoY,
      keyRiskOneLiner=excluded.keyRiskOneLiner,
      prominentSentiment=excluded.prominentSentiment,
      updatedAt=excluded.updatedAt
  `);

  const tx = db.transaction((batch) => {
    for (const row of batch) {
      if (!row?.ticker) continue;
      stmt.run({
        ticker: String(row.ticker).toUpperCase(),
        name: row.name ?? null,
        sector: row.sector ?? null,
        sectorBucket: row.sectorBucket ?? null,
        issuerType: row.issuerType ?? null,
        annualMode: row.annualMode ? 1 : 0,
        score: Number.isFinite(Number(row.score)) ? Number(row.score) : null,
        tier: row.tier ?? null,
        marketCap: Number.isFinite(Number(row.marketCap)) ? Number(row.marketCap) : null,
        marketCapBucket: row.marketCapBucket ?? null,
        revenueGrowthYoY: Number.isFinite(Number(row.revenueGrowthYoY)) ? Number(row.revenueGrowthYoY) : null,
        fcfMarginTTM: Number.isFinite(Number(row.fcfMarginTTM)) ? Number(row.fcfMarginTTM) : null,
        peTTM: Number.isFinite(Number(row.peTTM)) ? Number(row.peTTM) : null,
        dividendYield: Number.isFinite(Number(row.dividendYield)) ? Number(row.dividendYield) : null,
        dividendCovered:
          row.dividendCovered === null || row.dividendCovered === undefined
            ? null
            : row.dividendCovered
              ? 1
              : 0,
        lastTradePrice: Number.isFinite(Number(row.lastTradePrice)) ? Number(row.lastTradePrice) : null,
        lastTradeAt: row.lastTradeAt ?? null,
        lastTradeSource: row.lastTradeSource ?? null,
        fcfPositive: row.fcfPositive ? 1 : 0,
        lowDebt: row.lowDebt ? 1 : 0,
        highGrowth: row.highGrowth ? 1 : 0,
        isFintech: row.isFintech ? 1 : 0,
        isBiotech: row.isBiotech ? 1 : 0,
        isPenny: row.isPenny ? 1 : 0,
        growthAdjustment: Number.isFinite(Number(row.growthAdjustment)) ? Number(row.growthAdjustment) : 0,
        depositGrowthYoY: Number.isFinite(Number(row.depositGrowthYoY)) ? Number(row.depositGrowthYoY) : null,
        keyRiskOneLiner: row.keyRiskOneLiner ?? null,
        prominentSentiment: row.prominentSentiment ?? null,
        updatedAt: row.updatedAt ?? nowIso
      });
    }
  });

  tx(Array.isArray(rows) ? rows : []);
}
