import { buildScreenerRowForTicker } from "../ticker/tickerAssembler.js";
import { getDb as getFundamentalsDb } from "../edgar/fundamentalsStore.js";
import { ensureScreenerSchema, upsertScreenerRows, getScreenerDb } from "./screenerStore.js";

function normalizeTierFilter(raw) {
  const tier = String(raw || "").trim().toLowerCase();
  if (!tier || tier === "all") return null;
  if (tier === "elite" || tier === "elite only" || tier === "elite-only") return ["elite"];
  if (tier === "bullish+" || tier === "bullishplus" || tier === "bullish plus") return ["bullish", "elite"];
  if (tier === "solid+" || tier === "solidplus" || tier === "solid plus")
    return ["solid", "bullish", "elite"];
  if (tier === "spec" || tier === "speculative") return ["spec"];
  if (tier === "danger") return ["danger"];
  if (tier === "mixed") return ["mixed"];
  if (tier === "solid") return ["solid"];
  if (tier === "bullish") return ["bullish"];
  return null;
}

function parseMulti(params, key) {
  const direct = params.getAll(key);
  const alt = params.get(key);
  const combined = [...direct, alt].filter(Boolean);
  const flat = combined
    .flatMap((v) => String(v).split(","))
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set(flat)];
}

function clampInt(val, min, max, fallback) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function normalizeSort(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s || s === "score") return { field: "score", dir: "desc" };
  if (s === "marketcap" || s === "mcap") return { field: "marketCap", dir: "desc" };
  if (s === "revenuegrowthyoy" || s === "revgrowth") return { field: "revenueGrowthYoY", dir: "desc" };
  if (s === "fcfmarginttm" || s === "fcfmargin") return { field: "fcfMarginTTM", dir: "desc" };
  if (s === "lasttradeprice" || s === "price" || s === "last") return { field: "lastTradePrice", dir: "desc" };
  return { field: "score", dir: "desc" };
}

function normalizeDir(raw, defaultDir) {
  const d = String(raw || "").trim().toLowerCase();
  if (d === "asc" || d === "ascending") return "asc";
  if (d === "desc" || d === "descending") return "desc";
  return defaultDir;
}

function normalizeTicker(val) {
  return val ? String(val).trim().toUpperCase() : "";
}

function getDedupAllowlist() {
  const raw = String(process.env.SCREENER_DUPLICATE_ALLOWLIST || process.env.WORKER_DUPLICATE_ALLOWLIST || "");
  const allowlist = new Set(
    raw
      .split(",")
      .map(normalizeTicker)
      .filter(Boolean)
  );
  // Always keep major dual-class tickers.
  ["GOOG", "GOOGL", "BRK.A", "BRK.B", "BRK-A", "BRK-B"].forEach((t) => allowlist.add(t));
  return allowlist;
}

export function getScreenerPresets() {
  return [
    { id: "elite_compounders", name: "Elite Compounders", filters: { tier: "Elite Only", scoreMin: 91 } },
    { id: "undervalued_quality", name: "Undervalued Quality", filters: { tier: "Solid", scoreMin: 60, scoreMax: 75, peMax: 20 } },
    {
      id: "growth_phase_bargains",
      name: "Growth Phase Bargains",
      filters: { growthAdjustmentMin: 1, revenueGrowthYoYMin: 30 }
    },
    { id: "fintech_rising", name: "Fintech Rising Stars", filters: { flags: ["isFintech"], depositGrowthYoYMin: 20 } },
    { id: "danger_zone", name: "Danger Zone", filters: { tier: "Danger" } },
    { id: "dividend_aristocrats", name: "Dividend Aristocrats", filters: { dividendYieldMin: 2, dividendCovered: true } }
  ];
}

export async function getScreenerPricePatch() {
  await ensureScreenerSchema();
  const db = await getScreenerDb();
  const rows = db.prepare(`
    SELECT ticker, lastTradePrice, lastTradeAt, lastTradeSource
    FROM screener_index
    WHERE lastTradePrice IS NOT NULL
  `).all();

  const patch = {};
  for (const r of rows) {
    if (r.ticker) {
      patch[r.ticker] = {
        p: r.lastTradePrice,
        t: r.lastTradeAt,
        s: r.lastTradeSource
      };
    }
  }
  return patch;
}

export async function queryScreener(url) {
  await ensureScreenerSchema();
  const params = url.searchParams;

  const tierList = normalizeTierFilter(params.get("tier"));
  const scoreMin = params.get("scoreMin");
  const scoreMax = params.get("scoreMax");
  const priceMin = params.get("priceMin");
  const priceMax = params.get("priceMax");
  const sector = params.get("sector");
  const sectorBucket = params.get("sectorBucket");
  const mcapBuckets = parseMulti(params, "mcapBucket");
  const flags = parseMulti(params, "flags");

  const peMax = params.get("peMax");
  const dividendYieldMin = params.get("dividendYieldMin");
  const dividendCovered = params.get("dividendCovered");
  const growthAdjustmentMin = params.get("growthAdjustmentMin");
  const revenueGrowthYoYMin = params.get("revenueGrowthYoYMin");
  const depositGrowthYoYMin = params.get("depositGrowthYoYMin");

  const page = clampInt(params.get("page") ?? 1, 1, 10_000, 1);
  const pageSize = clampInt(params.get("pageSize") ?? params.get("limit") ?? 50, 1, 200, 50);

  const sort = normalizeSort(params.get("sort"));
  const dir = normalizeDir(params.get("dir"), sort.dir);

  const where = [];
  const args = {};

  // Default Filter: Ignore warrants, preferreds, units, and other derivatives.
  // Warrants are typically 5+ chars ending in W (ALCYW, KIDZW). 4-char tickers like SNOW, PANW are legit.
  // Explicitly whitelist the "Golden" exceptions (Google & Berkshire).
  where.push(`(
    (
      INSTR(ticker, '-') = 0
      AND INSTR(ticker, '.') = 0
      AND INSTR(ticker, '+') = 0
      AND INSTR(ticker, ' ') = 0
      AND NOT (length(ticker) >= 5 AND (ticker LIKE '%W' OR ticker LIKE '%U' OR ticker LIKE '%R'))
    )
    OR ticker IN ('GOOG', 'GOOGL', 'BRK.A', 'BRK.B', 'BRK-A', 'BRK-B')
  )`);

  if (tierList && tierList.length) {
    where.push(`tier IN (${tierList.map((_, i) => `@tier${i}`).join(",")})`);
    tierList.forEach((t, i) => (args[`tier${i}`] = t));
  }

  if (scoreMin != null && scoreMin !== "") {
    const n = Number(scoreMin);
    if (Number.isFinite(n)) {
      where.push("score >= @scoreMin");
      args.scoreMin = n;
    }
  }
  if (scoreMax != null && scoreMax !== "") {
    const n = Number(scoreMax);
    if (Number.isFinite(n)) {
      where.push("score <= @scoreMax");
      args.scoreMax = n;
    }
  }

  if (priceMin != null && priceMin !== "" && priceMin !== "0") {
    const n = Number(priceMin);
    if (Number.isFinite(n)) {
      where.push("lastTradePrice >= @priceMin");
      args.priceMin = n;
    }
  }
  if (priceMax != null && priceMax !== "" && priceMax !== "0") {
    const n = Number(priceMax);
    if (Number.isFinite(n)) {
      where.push("lastTradePrice <= @priceMax");
      args.priceMax = n;
    }
  }

  if (sector) {
    where.push("sector = @sector");
    args.sector = sector;
  } else if (sectorBucket) {
    where.push("sectorBucket = @sectorBucket");
    args.sectorBucket = sectorBucket;
  }

  if (mcapBuckets.length) {
    where.push(`marketCapBucket IN (${mcapBuckets.map((_, i) => `@mcap${i}`).join(",")})`);
    mcapBuckets.forEach((b, i) => (args[`mcap${i}`] = b));
  }

  const flagColumns = new Set([
    "fcfPositive",
    "lowDebt",
    "highGrowth",
    "isFintech",
    "isBiotech",
    "isPenny"
  ]);
  for (const f of flags) {
    if (!flagColumns.has(f)) continue;
    where.push(`${f} = 1`);
  }

  if (peMax != null && peMax !== "") {
    const n = Number(peMax);
    if (Number.isFinite(n)) {
      where.push("peTTM IS NOT NULL AND peTTM <= @peMax");
      args.peMax = n;
    }
  }
  if (dividendYieldMin != null && dividendYieldMin !== "") {
    const n = Number(dividendYieldMin);
    if (Number.isFinite(n)) {
      where.push("dividendYield IS NOT NULL AND dividendYield >= @dividendYieldMin");
      args.dividendYieldMin = n;
    }
  }
  if (dividendCovered === "1" || String(dividendCovered).toLowerCase() === "true") {
    where.push("dividendCovered = 1");
  }
  if (growthAdjustmentMin != null && growthAdjustmentMin !== "") {
    const n = Number(growthAdjustmentMin);
    if (Number.isFinite(n)) {
      where.push("growthAdjustment >= @growthAdjustmentMin");
      args.growthAdjustmentMin = n;
    }
  }
  if (revenueGrowthYoYMin != null && revenueGrowthYoYMin !== "") {
    const n = Number(revenueGrowthYoYMin);
    if (Number.isFinite(n)) {
      where.push("revenueGrowthYoY IS NOT NULL AND revenueGrowthYoY >= @revenueGrowthYoYMin");
      args.revenueGrowthYoYMin = n;
    }
  }
  if (depositGrowthYoYMin != null && depositGrowthYoYMin !== "") {
    const n = Number(depositGrowthYoYMin);
    if (Number.isFinite(n)) {
      where.push("depositGrowthYoY IS NOT NULL AND depositGrowthYoY >= @depositGrowthYoYMin");
      args.depositGrowthYoYMin = n;
    }
  }

  const allowlist = getDedupAllowlist();
  const allowParams = [];
  for (const t of allowlist) {
    const key = `allow${allowParams.length}`;
    allowParams.push(`@${key}`);
    args[key] = t;
  }
  const allowSql = allowParams.length ? `ticker IN (${allowParams.join(",")})` : "0";
  where.push(`(name IS NULL OR name = '' OR ${allowSql} OR rn = 1)`);

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const orderFieldMap = {
    score: "score",
    marketCap: "marketCap",
    revenueGrowthYoY: "revenueGrowthYoY",
    fcfMarginTTM: "fcfMarginTTM",
    lastTradePrice: "lastTradePrice"
  };
  const orderField = orderFieldMap[sort.field] || "score";
  const orderSql = `ORDER BY ${orderField} ${dir.toUpperCase()}, score DESC, ticker ASC`;
  const offset = (page - 1) * pageSize;

  const db = await getScreenerDb();
  const baseQuery = `
      WITH ranked AS (
        SELECT
          *,
          ROW_NUMBER() OVER (PARTITION BY name ORDER BY LENGTH(ticker), ticker) AS rn
        FROM screener_index
      ),
      filtered AS (
        SELECT * FROM ranked
        ${whereSql}
      )
  `;
  const total = db.prepare(`${baseQuery} SELECT COUNT(*) as n FROM filtered`).get(args)?.n ?? 0;
  const rows = db
    .prepare(
      `
      ${baseQuery}
      SELECT
        ticker, name, sector, sectorBucket, issuerType, annualMode,
        score, tier,
        revenueGrowthYoY, fcfMarginTTM, marketCap,
        marketCapBucket, peTTM,
        dividendYield, dividendCovered,
        lastTradePrice, lastTradeAt, lastTradeSource,
        growthAdjustment, depositGrowthYoY,
        keyRiskOneLiner, prominentSentiment,
        fcfPositive, lowDebt, highGrowth, isFintech, isBiotech, isPenny,
        updatedAt
      FROM filtered
      ${orderSql}
      LIMIT @limit OFFSET @offset
    `
    )
    .all({ ...args, limit: pageSize, offset });

  const results = rows.map((r) => ({
    ticker: r.ticker,
    name: r.name,
    sector: r.sector,
    sectorBucket: r.sectorBucket,
    issuerType: r.issuerType || null,
    annualMode: r.annualMode == null ? null : Boolean(r.annualMode),
    score: r.score == null ? null : Number(r.score),
    tier: r.tier,
    marketCap: r.marketCap == null ? null : Number(r.marketCap),
    marketCapBucket: r.marketCapBucket,
    revenueGrowthYoY: r.revenueGrowthYoY == null ? null : Number(r.revenueGrowthYoY),
    fcfMarginTTM: r.fcfMarginTTM == null ? null : Number(r.fcfMarginTTM),
    peTTM: r.peTTM == null ? null : Number(r.peTTM),
    dividendYield: r.dividendYield == null ? null : Number(r.dividendYield),
    dividendCovered: r.dividendCovered == null ? null : Boolean(r.dividendCovered),
    lastTradePrice: r.lastTradePrice == null ? null : Number(r.lastTradePrice),
    lastTradeAt: r.lastTradeAt || null,
    lastTradeSource: r.lastTradeSource || null,
    flags: {
      fcfPositive: !!r.fcfPositive,
      lowDebt: !!r.lowDebt,
      highGrowth: !!r.highGrowth,
      isFintech: !!r.isFintech,
      isBiotech: !!r.isBiotech,
      isPenny: !!r.isPenny
    },
    growthAdjustment: r.growthAdjustment == null ? 0 : Number(r.growthAdjustment),
    depositGrowthYoY: r.depositGrowthYoY == null ? null : Number(r.depositGrowthYoY),
    keyRiskOneLiner: r.keyRiskOneLiner || null,
    prominentSentiment: r.prominentSentiment || null,
    updatedAt: r.updatedAt
  }));

  const newestAt = db.prepare("SELECT MAX(updatedAt) as newestAt FROM screener_index").get()?.newestAt || null;

  return {
    page,
    pageSize,
    total,
    meta: { newestAt },
    results
  };
}

export async function getScreenerMeta() {
  await ensureScreenerSchema();
  const db = await getScreenerDb();
  const row = db.prepare("SELECT MAX(updatedAt) as newestAt, COUNT(*) as rowCount FROM screener_index").get();
  return {
    newestAt: row?.newestAt || null,
    rowCount: Number(row?.rowCount || 0)
  };
}

/**
 * Find the page number where a specific ticker appears in the default screener sort.
 * Returns { found: true, page, row } if found, or { found: false } if not in index.
 */
export async function findTickerPosition(ticker, pageSize = 50) {
  if (!ticker) return { found: false };
  await ensureScreenerSchema();
  const db = await getScreenerDb();
  const normalizedTicker = String(ticker).trim().toUpperCase();

  // First check if ticker exists in screener
  const exists = db.prepare("SELECT 1 FROM screener_index WHERE ticker = ?").get(normalizedTicker);
  if (!exists) return { found: false };

  // Get the row number for this ticker in the default sort order (score DESC, ticker ASC)
  // Use the same filtering as the main screener query to ensure consistency
  const result = db.prepare(`
    WITH ranked AS (
      SELECT
        ticker,
        ROW_NUMBER() OVER (PARTITION BY name ORDER BY LENGTH(ticker), ticker) AS rn
      FROM screener_index
    ),
    filtered AS (
      SELECT s.ticker, s.score
      FROM screener_index s
      JOIN ranked r ON r.ticker = s.ticker
      WHERE (
        (
          INSTR(s.ticker, '-') = 0
          AND INSTR(s.ticker, '.') = 0
          AND INSTR(s.ticker, '+') = 0
          AND INSTR(s.ticker, ' ') = 0
          AND NOT (length(s.ticker) >= 5 AND (s.ticker LIKE '%W' OR s.ticker LIKE '%U' OR s.ticker LIKE '%R'))
        )
        OR s.ticker IN ('GOOG', 'GOOGL', 'BRK.A', 'BRK.B', 'BRK-A', 'BRK-B')
      )
      AND (r.rn = 1 OR s.name IS NULL OR s.name = '' OR s.ticker IN ('GOOG', 'GOOGL', 'BRK.A', 'BRK.B', 'BRK-A', 'BRK-B'))
    ),
    sorted AS (
      SELECT ticker, ROW_NUMBER() OVER (ORDER BY score DESC, ticker ASC) as row_num
      FROM filtered
    )
    SELECT row_num FROM sorted WHERE ticker = ?
  `).get(normalizedTicker);

  if (!result?.row_num) return { found: false };

  const rowNum = Number(result.row_num);
  const page = Math.ceil(rowNum / pageSize);

  return {
    found: true,
    ticker: normalizedTicker,
    rowNumber: rowNum,
    page,
    pageSize
  };
}

export async function refreshScreenerRow(ticker, { allowFilingScan = false } = {}) {
  await ensureScreenerSchema();
  const row = await buildScreenerRowForTicker(ticker, { allowFilingScan });
  if (!row) return null;
  await upsertScreenerRows([row]);
  return row;
}

async function listTickersWithFundamentals() {
  const db = await getFundamentalsDb();
  const rows = db.prepare("SELECT DISTINCT ticker FROM fundamentals").all();
  return rows.map((r) => r.ticker).filter(Boolean);
}

async function mapLimit(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  const concurrency = Math.max(1, Math.trunc(Number(limit) || 1));
  const results = [];
  let idx = 0;
  let active = 0;

  return new Promise((resolve) => {
    const launch = () => {
      while (active < concurrency && idx < list.length) {
        const current = idx++;
        active++;
        Promise.resolve(worker(list[current], current))
          .then((value) => results[current] = value)
          .catch(() => results[current] = null)
          .finally(() => {
            active--;
            if (idx >= list.length && active === 0) return resolve(results);
            launch();
          });
      }
    };
    launch();
  });
}

export async function refreshScreenerIndex({ tickers = null, concurrency = null, allowFilingScan = false } = {}) {
  await ensureScreenerSchema();
  const list = tickers && tickers.length ? tickers : await listTickersWithFundamentals();
  const limit = (concurrency ?? Number(process.env.SCREENER_REFRESH_CONCURRENCY)) || 2;

  const built = await mapLimit(list, limit, async (t) => buildScreenerRowForTicker(t, { allowFilingScan }));
  const rows = built.filter(Boolean);
  await upsertScreenerRows(rows);
  return { tickers: list.length, rows: rows.length };
}
