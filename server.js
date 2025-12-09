import http from "http";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { getFundamentalsFreshness } from "./server/edgar/fundamentalsStore.js";
import { enqueueFundamentalsJob, getJobState } from "./server/edgar/edgarQueue.js";
import { getCoreFinancialSnapshot } from "./server/edgar/edgarService.js";
import {
  getExtractStatus,
  setBootstrapEnabled,
  startEdgarWorker
} from "./server/edgar/bootstrapWorker.js";
import { fetchLatestRelevantFiling, processFilingForTicker } from "./server/edgar/filingWorkflow.js";
import { getRecentFilingEvents } from "./server/edgar/edgarRegistry.js";
import { buildTickerViewModel } from "./server/ticker/tickerAssembler.js";
import { startPriceWorker } from "./server/prices/priceWorker.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = __dirname;

await loadEnv();
startPriceWorker();
startEdgarWorker();

const DEFAULT_DATA_BASE = "https://data.sec.gov";
const DATA_API_KEY = process.env.DATA_API_KEY;
const DATA_API_BASE = (process.env.DATA_API_BASE || DEFAULT_DATA_BASE).replace(/\/$/, "");

const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) || 1_000; // default: 1 second window
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX) || 5; // default: 5 req/s per IP
const rateBuckets = new Map();

const OUTBOUND_MIN_INTERVAL_MS = Number(process.env.DATA_MIN_INTERVAL_MS) || 250; // ~4 req/s spacing
const OUTBOUND_MAX_INFLIGHT = Number(process.env.DATA_MAX_INFLIGHT) || 1; // serial by default
const OUTBOUND_MAX_RETRIES = Number(process.env.DATA_MAX_RETRIES) || 3;
const OUTBOUND_BASE_BACKOFF_MS = Number(process.env.DATA_BASE_BACKOFF_MS) || 60_000; // 60s backoff for 429/503
const DATA_USER_AGENT =
  process.env.DATA_USER_AGENT || "BullishAndFoolishBot/0.1 (+freelancer.bg@gmail.com)";
// Default: keep EDGAR fundamentals fresh for 30 days to avoid re-fetching on every visit.
const EDGAR_CACHE_TTL_MS = Number(process.env.EDGAR_CACHE_TTL_MS) || 30 * 24 * 60 * 60 * 1000;

let outboundInFlight = 0;
let nextOutboundSlot = Date.now();
let tickerCachePromise = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length) return forwarded.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

function isRateLimited(ip) {
  const now = Date.now();
  const bucket = rateBuckets.get(ip) || [];
  const recent = bucket.filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX) {
    rateBuckets.set(ip, recent);
    return true;
  }
  recent.push(now);
  rateBuckets.set(ip, recent);
  return false;
}

function setApiCors(res) {
  const allowOrigin = process.env.CORS_ALLOW_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function sendRateLimit(res) {
  sendJson(res, 429, { error: "Rate limit exceeded, try again shortly." });
}

async function waitForOutboundSlot() {
  while (true) {
    const now = Date.now();
    if (outboundInFlight < OUTBOUND_MAX_INFLIGHT && now >= nextOutboundSlot) {
      outboundInFlight++;
      return;
    }
    const waitMs = Math.max(nextOutboundSlot - now, 50);
    await sleep(waitMs);
  }
}

function releaseOutboundSlot() {
  outboundInFlight = Math.max(0, outboundInFlight - 1);
  nextOutboundSlot = Date.now() + OUTBOUND_MIN_INTERVAL_MS;
}

async function callDataProvider(endpoint, params = {}) {
  if (!DATA_API_BASE) {
    const err = new Error("External data provider is not configured");
    err.status = 503;
    throw err;
  }
  const url = new URL(`${DATA_API_BASE}/${endpoint}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, value);
  }
  if (DATA_API_KEY) {
    url.searchParams.set("apikey", DATA_API_KEY);
  }

  let attempt = 0;
  while (attempt < OUTBOUND_MAX_RETRIES) {
    await waitForOutboundSlot();
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": DATA_USER_AGENT }
      });
      if ([429, 503].includes(res.status) && attempt < OUTBOUND_MAX_RETRIES - 1) {
        const backoff = OUTBOUND_BASE_BACKOFF_MS * Math.pow(2, attempt);
        await res.text().catch(() => "");
        releaseOutboundSlot();
        await sleep(backoff);
        attempt++;
        continue;
      }
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        const err = new Error(`Data request failed ${res.status}`);
        err.status = res.status;
        err.body = errText;
        throw err;
      }
      const data = await res.json();
      releaseOutboundSlot();
      return data;
    } catch (err) {
      releaseOutboundSlot();
      const status = err?.status;
      const retriable = status === 429 || status === 503 || status === undefined;
      if (!retriable) throw err;
      if (attempt >= OUTBOUND_MAX_RETRIES - 1) throw err;
      const backoff = OUTBOUND_BASE_BACKOFF_MS * Math.pow(2, attempt);
      await sleep(backoff);
      attempt++;
    }
  }
}

async function getTickerMap() {
  if (!tickerCachePromise) {
    tickerCachePromise = (async () => {
      // Fetch fresh from SEC and cache in memory (24h validity handled by upstream cache/CDN).
      return callDataProvider("files/company_tickers_exchange.json");
    })();
  }
  try {
    return await tickerCachePromise;
  } catch (err) {
    tickerCachePromise = null;
    // Minimal fallback for common tickers if both local and remote fail
    return {
      fallback: { cik_str: "0000789019", ticker: "MSFT", title: "MICROSOFT CORP" },
      meta: { cik_str: "0001326801", ticker: "META", title: "META PLATFORMS, INC." },
      aapl: { cik_str: "0000320193", ticker: "AAPL", title: "APPLE INC." }
    };
  }
}

function normalizeCik(cik) {
  if (!cik) return null;
  const num = String(cik).replace(/\D/g, "");
  if (!num) return null;
  return num.padStart(10, "0");
}

function selectLatestFact(fact) {
  if (!fact?.units) return null;
  const units = fact.units.USD || Object.values(fact.units)[0];
  if (!Array.isArray(units) || !units.length) return null;
  const sorted = [...units].sort((a, b) => {
    const aEnd = Date.parse(a.end || "") || 0;
    const bEnd = Date.parse(b.end || "") || 0;
    if (aEnd !== bEnd) return bEnd - aEnd;
    const aFiled = Date.parse(a.filed || "") || 0;
    const bFiled = Date.parse(b.filed || "") || 0;
    return bFiled - aFiled;
  });
  return sorted[0];
}

function pickFact(facts, tags) {
  const gaap = facts?.facts?.["us-gaap"];
  if (!gaap) return null;
  for (const tag of tags) {
    const fact = gaap[tag];
    const best = selectLatestFact(fact);
    if (best) return best;
  }
  return null;
}

const tickerSections = {
  income: { path: "income-statement", params: (symbol) => ({ symbol, limit: 4, period: "quarter" }) },
  balance: { path: "balance-sheet-statement", params: (symbol) => ({ symbol, limit: 4, period: "quarter" }) },
  cash: { path: "cash-flow-statement", params: (symbol) => ({ symbol, limit: 4, period: "quarter" }) },
  "key-metrics": { path: "key-metrics", params: (symbol) => ({ symbol, limit: 4, period: "quarter" }) },
  ratios: { path: "ratios", params: (symbol) => ({ symbol, limit: 4, period: "quarter" }) },
  "key-metrics-ttm": { path: "key-metrics-ttm", params: (symbol) => ({ symbol }) },
  "ratios-ttm": { path: "ratios-ttm", params: (symbol) => ({ symbol }) },
  "financial-scores": { path: "financial-scores", params: (symbol) => ({ symbol }) },
  "owner-earnings": { path: "owner-earnings", params: (symbol) => ({ symbol, limit: 4 }) },
  "income-growth": { path: "income-statement-growth", params: (symbol) => ({ symbol, limit: 4, period: "quarter" }) },
  "chart-light": { path: "historical-price-eod/light", params: (symbol) => ({ symbol }) },
  "chart-full": { path: "historical-price-eod/full", params: (symbol) => ({ symbol }) }
};

async function fetchTickerSection(symbol, section) {
  const cfg = tickerSections[section];
  if (!cfg) {
    const err = new Error("Unknown ticker section");
    err.status = 400;
    throw err;
  }
  return callDataProvider(cfg.path, cfg.params(symbol));
}

async function buildTickerPayload(symbol, section) {
  if (!symbol) {
    const err = new Error("Missing symbol");
    err.status = 400;
    throw err;
  }
  // Legacy section endpoints are disabled for fundamentals. Return unified view model instead.
  if (section) {
    const err = new Error("Section endpoints are disabled; use unified ticker view model.");
    err.status = 410;
    throw err;
  }
  const vm = await buildTickerViewModel(symbol);
  if (!vm) {
    const err = new Error("Ticker data unavailable");
    err.status = 404;
    throw err;
  }
  return vm;
}

async function buildEdgarStatusPayload(ticker, { enqueueIfStale = true } = {}) {
  const normalized = ticker?.toUpperCase();
  if (!normalized) {
    const err = new Error("ticker is required");
    err.status = 400;
    throw err;
  }
  const { rows, latestUpdated, isFresh } = await getFundamentalsFreshness(normalized, EDGAR_CACHE_TTL_MS);
  if (isFresh && rows.length) {
    const vm = await buildTickerViewModel(normalized);
    if (!vm) return { status: "error", error: "Could not assemble ticker view model" };
    console.log("[tickerRoute] fundamentals ready for", normalized);
    return { status: "ready", updatedAt: latestUpdated, data: vm };
  }
  const job = enqueueIfStale ? enqueueFundamentalsJob(normalized) : getJobState(normalized);
  if (job?.status === "failed") {
    const msg = job.error || "EDGAR fetch failed";
    return { status: "error", error: msg, message: msg, job };
  }
  if (job?.status === "busy") {
    const msg = job.message || "EDGAR queue is full, try again shortly.";
    return { status: "busy", error: msg, message: msg, job };
  }
  const status = job?.status || "queued";
  return {
    status,
    updatedAt: latestUpdated,
    data: isFresh ? rows : undefined,
    job,
    nextPollMs: status === "running" ? 1500 : 2500
  };
}

function buildSnapshotPayload(raw) {
  const snapshot = raw.snapshot || {};
  const notesArr = [];
  if (snapshot.notes) notesArr.push(...Object.values(snapshot.notes));
  if (snapshot.ttmIncomplete) {
    notesArr.push(
      `TTM is based on the last ${snapshot.ttmSourceCount || "few"} reported quarter(s). Final TTM will refresh after the next filing.`
    );
  }
  if (raw.inactive) notesArr.push("This ticker is not reporting new filings. Data may be stale or incomplete.");
  if (!raw.inactive && !raw.pending && raw.source === "none") {
    notesArr.push("No fundamentals available yet for this ticker.");
  }
  const status = raw.inactive && !raw.snapshot ? "none" : raw.pending ? "pending" : raw.snapshot ? "ok" : "none";
  return {
    ticker: raw.ticker,
    status,
    ttm: snapshot.ttm || null,
    ttmIncomplete: Boolean(snapshot.ttmIncomplete),
    ttmSourceCount: snapshot.ttmSourceCount || 0,
    stale: Boolean(snapshot.notes?.stale),
    inactive: Boolean(raw.inactive),
    notes: notesArr,
    lastUpdated: raw.updatedAt || null,
    source: raw.source,
    data: raw.data || null,
    filingSignals: raw.filingSignals || null
  };
}

async function getOrRefreshSnapshot(ticker) {
  let raw = await getCoreFinancialSnapshot(ticker, {
    enqueueIfStale: false,
    includeFilingTextScan: true
  });
  if (raw && raw.data && raw.data.length) return raw;
  try {
    const latestFiling = await fetchLatestRelevantFiling(ticker);
    await processFilingForTicker(ticker, latestFiling, { createEvent: true });
    raw = await getCoreFinancialSnapshot(ticker, {
      enqueueIfStale: false,
      includeFilingTextScan: true
    });
  } catch (err) {
    console.warn("[edgarFacts] fallback fetch failed", ticker, err?.message || err);
    throw err;
  }
  return raw;
}

async function handleTicker(req, res, url) {
  if (req.method !== "GET") return sendJson(res, 405, { error: "Method not allowed" });
  const symbol = url.searchParams.get("symbol")?.toUpperCase();
  const section = url.searchParams.get("section");
  const data = await buildTickerPayload(symbol, section);
  if (!data) {
    console.error("[tickerRoute] failed to build view model for", symbol);
    return sendJson(res, 500, { status: "error", message: "Failed to build ticker view model" });
  }
  sendJson(res, 200, data);
}

async function handleTickerStatus(req, res, url) {
  if (req.method !== "GET") return sendJson(res, 405, { error: "Method not allowed" });
  const parts = url.pathname.split("/").filter(Boolean);
  const symbol = parts[2];
  if (!symbol) return sendJson(res, 400, { error: "ticker is required" });
  const payload = await buildEdgarStatusPayload(symbol);
  const statusCode =
    payload.status === "ready"
      ? 200
      : payload.status === "error"
      ? 500
      : payload.status === "busy"
      ? 429
      : 202;
  sendJson(res, statusCode, payload);
}

async function handleCompare(req, res, url) {
  if (req.method !== "GET") return sendJson(res, 405, { error: "Method not allowed" });
  const left = url.searchParams.get("left")?.toUpperCase();
  const right = url.searchParams.get("right")?.toUpperCase();
  if (!left || !right) return sendJson(res, 400, { error: "left and right query params are required" });
  const [leftData, rightData] = await Promise.all([buildTickerPayload(left), buildTickerPayload(right)]);
  sendJson(res, 200, { left: leftData, right: rightData });
}

async function handleSearch(req, res, url) {
  if (req.method !== "GET") return sendJson(res, 405, { error: "Method not allowed" });
  const query = url.searchParams.get("query") || url.searchParams.get("q");
  if (!query) return sendJson(res, 400, { error: "query param is required" });
  const results = await callDataProvider("search-symbol", { query });
  sendJson(res, 200, results);
}

async function handleScreener(req, res, url) {
  if (req.method !== "GET") return sendJson(res, 405, { error: "Method not allowed" });
  const allowed = [
    "marketCapMoreThan",
    "marketCapLowerThan",
    "priceLowerThan",
    "priceHigherThan",
    "volumeMoreThan",
    "sector",
    "industry",
    "exchange",
    "limit"
  ];
  const params = {};
  for (const key of allowed) {
    const val = url.searchParams.get(key);
    if (val) params[key] = val;
  }
  const data = await callDataProvider("stock-screener", params);
  sendJson(res, 200, data);
}

async function handleEdgarFacts(req, res, url) {
  if (req.method !== "GET") return sendJson(res, 405, { error: "Method not allowed" });
  const ticker = url.searchParams.get("ticker")?.toUpperCase();
  const cikParam = url.searchParams.get("cik");
  if (!ticker && !cikParam) return sendJson(res, 400, { error: "ticker is required" });

  const mode = url.searchParams.get("mode") || url.searchParams.get("view");
  try {
    if (mode === "snapshot") {
      let raw = await getCoreFinancialSnapshot(ticker || cikParam, {
        enqueueIfStale: false,
        includeFilingTextScan: true
      });
      if (!raw?.data?.length) {
        raw = await getOrRefreshSnapshot(ticker || cikParam);
      }
      const payload = buildSnapshotPayload(raw);
      return sendJson(res, 200, payload);
    }
    const statusPayload = await buildEdgarStatusPayload(ticker, { enqueueIfStale: true });
    const wantsStatus = url.searchParams.get("status") === "1" || url.searchParams.get("mode") === "status";
    if (statusPayload.status === "ready" && Array.isArray(statusPayload.data)) {
      if (wantsStatus) return sendJson(res, 200, statusPayload);
      return sendJson(res, 200, statusPayload.data);
    }
    const statusCode =
      statusPayload.status === "error"
        ? 500
        : statusPayload.status === "busy"
        ? 429
        : statusPayload.status === "ready"
        ? 200
        : 202;
    sendJson(res, statusCode, statusPayload);
  } catch (err) {
    const status = err.status && Number.isInteger(err.status) ? err.status : 500;
    sendJson(res, status, { error: err.message || "Server error" });
  }
}

async function handleFilingNews(req, res, url) {
  if (req.method !== "GET") return sendJson(res, 405, { error: "Method not allowed" });
  const since = url.searchParams.get("since") || null;
  const ticker = url.searchParams.get("ticker")?.toUpperCase() || null;
  const type = url.searchParams.get("type") || null;
  const limitParam = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 200) : 50;
  const rows = await getRecentFilingEvents({ since, ticker, type, limit });
  const enriched = [];
  for (const row of rows) {
    let companyName = null;
    let cik = null;
    try {
      const file = path.join(ROOT, "data", "edgar", `${row.ticker}-fundamentals.json`);
      const raw = await fs.readFile(file, "utf8");
      const parsed = JSON.parse(raw);
      companyName = parsed?.companyName || null;
      cik = parsed?.cik || null;
    } catch (_) {}
    const accessionNoDashes = row.accession ? row.accession.replace(/-/g, "") : null;
    const cikTrim = cik ? String(cik).replace(/^0+/, "") : null;
    const urlStr =
      accessionNoDashes && cikTrim
        ? `https://www.sec.gov/Archives/edgar/data/${cikTrim}/${accessionNoDashes}/${row.accession}-index.html`
        : null;
    enriched.push({
      ...row,
      companyName,
      url: urlStr,
      headline: row.headline || (row.filingType ? `New ${row.filingType} filed` : "New filing")
    });
  }
  sendJson(res, 200, { events: enriched });
}

async function handleEdgarExtractStatus(req, res) {
  const status = await getExtractStatus();
  sendJson(res, 200, status);
}

async function handleEdgarExtractStart(req, res, url) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });
  setBootstrapEnabled(true);
  const status = await getExtractStatus();
  sendJson(res, 202, { message: "Bootstrap enabled", status });
}

async function handleEdgarExtractTestStart(req, res, url) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });
  const limitParam = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 100) : 5;
  saveSettings({ bootstrapEnabled: true, bootstrapTestLimit: limit });
  const status = await getExtractStatus();
  sendJson(res, 202, { message: `Test run enabled (limit ${limit})`, status });
}

async function handleEdgarExtractStop(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });
  setBootstrapEnabled(false);
  const status = await getExtractStatus();
  sendJson(res, 200, { message: "Bootstrap disabled", status });
}

async function handleApi(req, res, url) {
  setApiCors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }
  // Apply rate limits to general traffic, but allow the EDGAR endpoints to skip
  // the per-IP limiter because they already have outbound throttling and caching.
  const skipRateLimit =
    url.pathname === "/api/edgar-facts" || url.pathname.startsWith("/api/ticker/");
  if (!skipRateLimit) {
    const ip = getClientIp(req);
    if (isRateLimited(ip)) return sendRateLimit(res);
  }

  try {
    if (url.pathname.startsWith("/api/ticker/")) return await handleTickerStatus(req, res, url);
    if (url.pathname === "/api/ticker") return await handleTicker(req, res, url);
    if (url.pathname === "/api/compare") return await handleCompare(req, res, url);
    if (url.pathname === "/api/search") return await handleSearch(req, res, url);
    if (url.pathname === "/api/screener") return await handleScreener(req, res, url);
    if (url.pathname === "/api/filing-news") return await handleFilingNews(req, res, url);
    if (url.pathname === "/api/edgar-bootstrap/status" || url.pathname === "/api/edgar-extract/status")
      return await handleEdgarExtractStatus(req, res, url);
    if (url.pathname === "/api/edgar-bootstrap/start" || url.pathname === "/api/edgar-extract/start")
      return await handleEdgarExtractStart(req, res, url);
    if (url.pathname === "/api/edgar-bootstrap/test-start" || url.pathname === "/api/edgar-extract/test-start")
      return await handleEdgarExtractTestStart(req, res, url);
    if (url.pathname === "/api/edgar-bootstrap/stop" || url.pathname === "/api/edgar-extract/stop")
      return await handleEdgarExtractStop(req, res, url);
    if (url.pathname === "/api/edgar-facts") return await handleEdgarFacts(req, res, url);
    return sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    if (err.status === 429) return sendRateLimit(res);
    const status = err.status && Number.isInteger(err.status) ? err.status : 500;
    const message = err.message || "Server error";
    sendJson(res, status, { error: message });
  }
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf"
};

async function serveStatic(req, res, url) {
  if (url.pathname.startsWith("/.")) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }
  // Handle favicon explicitly to avoid noisy 404s in the browser console.
  if (url.pathname === "/favicon.ico") {
    const fav = path.join(ROOT, "assets", "images", "bullfavicon.png");
    try {
      const data = await fs.readFile(fav);
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(data);
      return;
    } catch (_) {
      res.writeHead(204);
      res.end();
      return;
    }
  }

  const safePath = decodeURIComponent(url.pathname || "/");
  let filePath = path.join(ROOT, safePath);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(ROOT)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return;
  }
  if (path.basename(resolved).startsWith(".")) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }
  if (url.pathname === "/" || url.pathname === "") {
    filePath = path.join(ROOT, "index.html");
  }
  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) filePath = path.join(filePath, "index.html");
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(data);
  } catch (err) {
    if (err.code === "ENOENT") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    } else {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Server error");
    }
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith("/api/")) {
    return handleApi(req, res, url);
  }
  return serveStatic(req, res, url);
});

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT) || Number(process.env.SERVER_PORT) || 3000;

server.listen(PORT, HOST, () => {
  const hostLabel = HOST === "0.0.0.0" ? "localhost" : HOST;
  console.log(`Server listening on http://${hostLabel}:${PORT}`);
});

async function loadEnv() {
  const envFiles = [".env.local", ".env"];
  for (const name of envFiles) {
    const full = path.join(ROOT, name);
    try {
      const raw = await fs.readFile(full, "utf8");
      raw.split(/\r?\n/).forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return;
        const idx = trimmed.indexOf("=");
        if (idx === -1) return;
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim();
        if (key && process.env[key] === undefined) {
          process.env[key] = val;
        }
      });
    } catch (err) {
      if (err.code !== "ENOENT") console.warn(`Could not read ${name}:`, err.message);
    }
  }
}
