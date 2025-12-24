import { parseArgs, envNumber, envString } from "../lib/args.js";
import { fetchText } from "../lib/http.js";
import { loadSupportedTickers } from "../lib/tickerUniverse.js";
import { getDb } from "../../server/edgar/fundamentalsStore.js";

function normalizeTicker(t) {
  return t ? String(t).trim().toUpperCase() : "";
}

function parseDelimitedRows(text, { delimiter = "|", hasHeader = true } = {}) {
  const rows = [];
  const lines = String(text || "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  if (!lines.length) return rows;

  const split = (line) => line.split(delimiter).map((c) => String(c ?? "").trim());
  const header = hasHeader ? split(lines[0]).map((h) => h.toLowerCase()) : null;
  const start = hasHeader ? 1 : 0;
  for (let i = start; i < lines.length; i += 1) {
    const cols = split(lines[i]);
    rows.push({ header, cols });
  }
  return rows;
}

function extractPriceMap(text, { sourceLabel, delimiter, hasHeader, symbolCol, priceCol } = {}) {
  const map = new Map();
  const rows = parseDelimitedRows(text, { delimiter, hasHeader });

  for (const r of rows) {
    const header = r.header || [];
    const idxSymbol =
      header.length ? header.indexOf(String(symbolCol || "symbol").toLowerCase()) : 0;
    const idxPrice =
      header.length ? header.indexOf(String(priceCol || "last").toLowerCase()) : 1;

    const sym = normalizeTicker(r.cols[idxSymbol] || "");
    if (!sym) continue;
    const priceRaw = r.cols[idxPrice];
    const price = Number(priceRaw);
    if (!Number.isFinite(price) || price <= 0) continue;
    if (!map.has(sym)) map.set(sym, { ticker: sym, price, source: sourceLabel });
  }

  return map;
}

function lookupPrice(priceMaps, ticker) {
  const t = normalizeTicker(ticker);
  const variants = [t, t.replace(".", "-"), t.replace("-", ".")];
  for (const v of variants) {
    for (const m of priceMaps) {
      const hit = m.get(v);
      if (hit) return hit;
    }
  }
  return null;
}

async function ensureLastTradeColumns(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ticker_last_trade (
      ticker TEXT PRIMARY KEY,
      lastTradePrice REAL,
      lastTradeAt TEXT,
      source TEXT,
      updatedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ticker_last_trade_updatedAt ON ticker_last_trade (updatedAt DESC);
  `);
}

async function main() {
  const day = new Date().getUTCDay();
  const isWeekend = day === 0 || day === 6; // 0=Sunday, 6=Saturday
  if (isWeekend && !process.argv.includes("--force")) {
    console.log("[worker:daily-last-trade] skipping: market is closed on weekends. Use --force to override.");
    return;
  }

  parseArgs(process.argv.slice(2)); // reserved for future flags

  const dbFile = envString("FUNDAMENTALS_DB_FILE");
  if (!dbFile) throw new Error("Missing required env var: FUNDAMENTALS_DB_FILE");

  const nasdaqUrl = envString("NASDAQ_LAST_TRADE_URL");
  const nyseUrl = envString("NYSE_LAST_TRADE_URL");
  if (!nasdaqUrl && !nyseUrl) {
    throw new Error("Set at least one of NASDAQ_LAST_TRADE_URL or NYSE_LAST_TRADE_URL");
  }

  const delimiter = envString("LAST_TRADE_DELIMITER", "|");
  const hasHeader = envString("LAST_TRADE_HEADER_ROW", "1") !== "0";
  const symbolCol = envString("LAST_TRADE_SYMBOL_COL", "symbol");
  const priceCol = envString("LAST_TRADE_PRICE_COL", "last");
  const limit = envNumber("WORKER_LIMIT", null);

  const priceMaps = [];
  if (nasdaqUrl) {
    console.log("[worker:daily-last-trade] downloading NASDAQ source...");
    try {
      // Try JSON fetcher first
      const { fetchNasdaqBulkPrices } = await import("../../server/prices/nasdaqPriceFetcher.js");
      const map = await fetchNasdaqBulkPrices(nasdaqUrl);
      priceMaps.push(map);
    } catch (err) {
      console.warn("[worker:daily-last-trade] JSON fetcher failed, falling back to delimited parser", err.message);
      const txt = await fetchText(nasdaqUrl);
      priceMaps.push(extractPriceMap(txt, { sourceLabel: "NASDAQ", delimiter, hasHeader, symbolCol, priceCol }));
    }
  }
  if (nyseUrl) {
    console.log("[worker:daily-last-trade] downloading NYSE source...");
    const txt = await fetchText(nyseUrl);
    priceMaps.push(extractPriceMap(txt, { sourceLabel: "NYSE", delimiter, hasHeader, symbolCol, priceCol }));
  }

  const tickersAll = await loadSupportedTickers();
  const tickers = Number.isFinite(limit) && limit > 0 ? tickersAll.slice(0, limit) : tickersAll;
  console.log("[worker:daily-last-trade] mapping prices", { tickers: tickers.length });

  const nowIso = new Date().toISOString();
  const todayDate = nowIso.split('T')[0];
  const db = await getDb();
  await ensureLastTradeColumns(db);

  const upsert = db.prepare(`
    INSERT INTO ticker_last_trade (ticker, lastTradePrice, lastTradeAt, source, updatedAt)
    VALUES (@ticker, @lastTradePrice, @lastTradeAt, @source, @updatedAt)
    ON CONFLICT(ticker) DO UPDATE SET
      lastTradePrice=excluded.lastTradePrice,
      lastTradeAt=excluded.lastTradeAt,
      source=excluded.source,
      updatedAt=excluded.updatedAt
  `);

  const upsertEod = db.prepare(`
    INSERT INTO prices_eod (ticker, date, close, source, createdAt, updatedAt)
    VALUES (@ticker, @date, @close, @source, @createdAt, @updatedAt)
    ON CONFLICT(ticker, date) DO UPDATE SET
      close=excluded.close,
      source=excluded.source,
      updatedAt=excluded.updatedAt
  `);

  const tx = db.transaction((batch) => {
    for (const row of batch) {
      upsert.run(row);
      try {
        upsertEod.run({
          ticker: row.ticker,
          date: todayDate,
          close: row.lastTradePrice,
          source: row.source,
          createdAt: nowIso,
          updatedAt: nowIso
        });
      } catch (_) { }
    }
  });

  const batch = [];
  let matched = 0;
  for (const ticker of tickers) {
    const hit = lookupPrice(priceMaps, ticker);
    if (!hit) continue;
    matched += 1;
    batch.push({
      ticker: ticker,
      lastTradePrice: hit.price,
        lastTradeAt: todayDate,
      source: hit.source,
      updatedAt: nowIso
    });
  }
  tx(batch);

  // Best-effort: also copy onto screener_index if the columns exist.
  try {
    db.exec(`
      UPDATE screener_index
      SET lastTradePrice = (SELECT lastTradePrice FROM ticker_last_trade WHERE ticker_last_trade.ticker = screener_index.ticker),
          lastTradeAt = (SELECT lastTradeAt FROM ticker_last_trade WHERE ticker_last_trade.ticker = screener_index.ticker),
          lastTradeSource = (SELECT source FROM ticker_last_trade WHERE ticker_last_trade.ticker = screener_index.ticker)
      WHERE ticker IN (SELECT ticker FROM ticker_last_trade);
    `);
  } catch (_) { }

  console.log("[worker:daily-last-trade] done", { matched, written: batch.length, asOf: nowIso });

  // 4. Export static prices.json for high-efficiency frontend delivery
  try {
    const fs = await import("fs");
    const path = await import("path");
    const dataDir =
      process.env.DATA_DIR ||
      process.env.RAILWAY_VOLUME_MOUNT_PATH ||
      path.join(process.cwd(), "data");
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // Create a compact map for the static file
    const patch = {};
    for (const r of batch) {
      patch[r.ticker] = {
        p: r.lastTradePrice,
        t: todayDate,
        s: r.source
      };
    }

    const filePath = path.join(dataDir, "prices.json");
    fs.writeFileSync(filePath, JSON.stringify(patch));
    console.log("[worker:daily-last-trade] exported static price patch", { filePath, entries: batch.length });
  } catch (err) {
    console.warn("[worker:daily-last-trade] failed to export static prices.json", err.message);
  }
}

main().catch((err) => {
  console.error("[worker:daily-last-trade] failed", err?.stack || err);
  process.exit(1);
});
