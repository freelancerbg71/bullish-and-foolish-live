import http from 'http';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import zlib from 'zlib';
import { processFilingForTicker } from './server/edgar/filingWorkflow.js';
import { getRecentFilingEvents } from './server/edgar/edgarRegistry.js';
import { searchCompaniesByName } from './server/edgar/edgarFundamentals.js';
import { buildTickerViewModel } from './server/ticker/tickerAssembler.js';
import { queryScreener, getScreenerMeta } from './server/screener/screenerService.js';
import { startScreenerScheduler } from './server/screener/screenerScheduler.js';
import { enqueueFundamentalsJob, getQueueDepth } from './server/edgar/edgarQueue.js';
import { closeDb as closeFundamentalsDb, getFundamentalsForTicker, writeFundamentalsSnapshot, getDb as getFundamentalsDb } from './server/edgar/fundamentalsStore.js';
import { closeDb as closeScreenerDb } from './server/screener/screenerStore.js';
import { closeDb as closePricesDb } from './server/prices/priceStore.js';
import { startDailyPricesScheduler } from './server/prices/dailyLastTradeScheduler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(PROJECT_ROOT, 'data');
const EDGAR_SNAPSHOT_DIR = path.join(DATA_DIR, 'edgar');
const JSON_SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function loadEnv() {
    const envFiles = ['.env.local', '.env'];
    for (const name of envFiles) {
        const full = path.join(PROJECT_ROOT, name);
        try {
            const raw = fs.readFileSync(full, 'utf8');
            raw.split(/\r?\n/).forEach((line) => {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#')) return;
                const idx = trimmed.indexOf('=');
                if (idx === -1) return;
                const key = trimmed.slice(0, idx).trim();
                const val = trimmed.slice(idx + 1).trim();
                if (key && process.env[key] === undefined) {
                    process.env[key] = val;
                }
            });
        } catch (err) {
            if (err.code !== 'ENOENT') console.warn(`Could not read ${name}:`, err.message);
        }
    }
}

await loadEnv();

async function seedPersistentData() {
    const seedEnabled = process.env.SEED_DATA_ON_BOOT === '1';
    if (!seedEnabled) return;
    const seedForce = process.env.SEED_DATA_FORCE === '1';
    const seedDebug = process.env.SEED_DATA_DEBUG === '1';

    const sourceDir = path.join(PROJECT_ROOT, 'data');
    const targetDir = DATA_DIR;
    if (path.resolve(sourceDir) === path.resolve(targetDir)) return;

    const targetEdgarDir = path.join(targetDir, 'edgar');
    const targetDbFile = path.join(targetEdgarDir, 'fundamentals.db');
    const sourceDbFile = path.join(sourceDir, 'edgar', 'fundamentals.db');
    const sourcePricesFile = path.join(sourceDir, 'prices.json');

    async function backupSourceDb(sourceFile, targetFile) {
        try {
            const { default: Database } = await import('better-sqlite3');
            const src = new Database(sourceFile, { readonly: true, fileMustExist: true });
            await src.backup(targetFile);
            src.close();
            console.log('[seed] source db backup complete');
        } catch (err) {
            console.warn('[seed] source db backup failed', err?.message || err);
        }
    }

    async function flushSourceDb(filePath) {
        try {
            const { default: Database } = await import('better-sqlite3');
            const db = new Database(filePath, { fileMustExist: true });
            db.pragma('wal_checkpoint(TRUNCATE);');
            db.pragma('journal_mode=DELETE;');
            db.close();
            console.log('[seed] source db checkpointed');
        } catch (err) {
            console.warn('[seed] source db checkpoint failed', err?.message || err);
        }
    }

    async function logDbRowCount(label, filePath) {
        if (!seedDebug) return;
        try {
            const { default: Database } = await import('better-sqlite3');
            const db = new Database(filePath, { readonly: true, fileMustExist: true });
            const count = db.prepare('SELECT COUNT(*) as n FROM fundamentals').get()?.n ?? 0;
            db.close();
            console.log(`[seed] ${label} fundamentals rows`, count);
        } catch (err) {
            console.warn(`[seed] ${label} db check failed`, err?.message || err);
        }
    }
    try {
        await fsPromises.access(sourceDir);
    } catch (err) {
        console.warn('[seed] source data dir missing:', sourceDir);
        return;
    }

    if (seedForce) {
        await flushSourceDb(sourceDbFile);
    }

    try {
        const sourceDbStats = await fsPromises.stat(sourceDbFile);
        console.log('[seed] source fundamentals.db size', sourceDbStats.size);
        await logDbRowCount('source', sourceDbFile);
    } catch (err) {
        console.warn('[seed] source fundamentals.db missing', sourceDbFile);
    }
    try {
        const sourcePricesStats = await fsPromises.stat(sourcePricesFile);
        console.log('[seed] source prices.json size', sourcePricesStats.size);
    } catch (err) {
        console.warn('[seed] source prices.json missing', sourcePricesFile);
    }

    try {
        const stats = await fsPromises.stat(targetDbFile);
        if (!seedForce && stats.size > 1024) return;
    } catch (err) {
        if (err.code && err.code !== 'ENOENT') {
            console.warn('[seed] failed to check target db:', err.message);
            return;
        }
    }

    try {
        // Step 1: Create target directories first
        await fsPromises.mkdir(targetEdgarDir, { recursive: true });
        console.log('[seed] created target directories');

        // Step 2: Backup the SQLite DB FIRST (materializes all WAL data)
        // This MUST happen before the cp to avoid overwriting with empty file
        await backupSourceDb(sourceDbFile, targetDbFile);

        // Step 3: Copy other files (prices.json, JSON snapshots, etc.)
        // Use a filter to skip the .db file since backup already handled it
        const copyOptions = {
            recursive: true,
            force: seedForce,
            filter: (src) => {
                // Skip the main database files - backup already handled this
                const basename = path.basename(src);
                if (basename === 'fundamentals.db' || basename.endsWith('-wal') || basename.endsWith('-shm')) {
                    console.log('[seed] skipping (already backed up):', basename);
                    return false;
                }
                return true;
            }
        };
        await fsPromises.cp(sourceDir, targetDir, copyOptions);
        console.log('[seed] copied non-db files from app bundle');

        // Step 4: Verify what we have
        let targetDbSize = null;
        let targetPricesSize = null;
        try {
            targetDbSize = (await fsPromises.stat(targetDbFile)).size;
        } catch (_) { }
        try {
            targetPricesSize = (await fsPromises.stat(path.join(targetDir, 'prices.json'))).size;
        } catch (_) { }
        console.log('[seed] final verification', { force: seedForce, targetDbSize, targetPricesSize });
        await logDbRowCount('target', targetDbFile);
    } catch (err) {
        console.warn('[seed] failed to seed data:', err?.message || err);
    }
}

await seedPersistentData();

async function logScreenerBootStatus() {
    if (process.env.SCREENER_BOOT_LOG !== '1') return;
    try {
        const meta = await getScreenerMeta();
        console.log('[screener] boot meta', meta);
        const db = await getFundamentalsDb();
        const fundamentalsCount = db.prepare("SELECT COUNT(*) as n FROM fundamentals").get()?.n ?? 0;
        console.log('[fundamentals] boot count', fundamentalsCount);
    } catch (err) {
        console.warn('[screener] boot meta failed', err?.message || err);
    }
}

await logScreenerBootStatus();

const PORT = Number(process.env.PORT) || 3003;

const DEFAULT_DATA_BASE = 'https://data.sec.gov';
const DATA_API_KEY = process.env.DATA_API_KEY;
const DATA_API_BASE = (process.env.DATA_API_BASE || DEFAULT_DATA_BASE).replace(/\/$/, '');

const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) || 1000;
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX) || 5;
const rateBuckets = new Map();

const OUTBOUND_MIN_INTERVAL_MS = Number(process.env.DATA_MIN_INTERVAL_MS) || 250;
const OUTBOUND_MAX_INFLIGHT = Number(process.env.DATA_MAX_INFLIGHT) || 1;
const OUTBOUND_MAX_RETRIES = Number(process.env.DATA_MAX_RETRIES) || 3;
const OUTBOUND_BASE_BACKOFF_MS = Number(process.env.DATA_BASE_BACKOFF_MS) || 60000;
const DATA_USER_AGENT = process.env.DATA_USER_AGENT || 'BullishAndFoolishBot/0.1';
if (!process.env.DATA_USER_AGENT && /sec\.gov/i.test(DATA_API_BASE)) {
    console.warn('[config] DATA_USER_AGENT is not set; SEC requests may be rate-limited or blocked without a descriptive UA.');
}
const EDGAR_CACHE_TTL_MS = Number(process.env.EDGAR_CACHE_TTL_MS) || 30 * 24 * 60 * 60 * 1000;
const VM_CACHE_DIR = path.join(DATA_DIR, 'cache', 'vm');
const VM_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const PRICE_PATCH_MAX_AGE_MS = Number(process.env.PRICES_PATCH_MAX_AGE_MS) || 48 * 60 * 60 * 1000;
const DATA_REQUEST_TIMEOUT_MS = Number(process.env.DATA_REQUEST_TIMEOUT_MS) || 30_000;
const MAX_TICKER_CONCURRENCY = Number(process.env.TICKER_MAX_CONCURRENCY) || 50;
const EDGAR_SYNC_MAX_QUEUE = Number(process.env.EDGAR_SYNC_MAX_QUEUE) || 25;

let outboundInFlight = 0;
let nextOutboundSlot = Date.now();
let activeTickerRequests = 0;
let loggedStalePricePatch = false;

function safeParseDateMs(dateStr) {
    const ts = Date.parse(String(dateStr || ''));
    return Number.isFinite(ts) ? ts : null;
}

function readPricesPatchMeta(filePath) {
    try {
        if (!fs.existsSync(filePath)) {
            return { exists: false, entries: 0, newestAt: null, newestAtMs: null, error: null };
        }
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') {
            return { exists: true, entries: 0, newestAt: null, newestAtMs: null, error: 'invalid_json_shape' };
        }

        let newestAtMs = null;
        let entries = 0;
        for (const v of Object.values(parsed)) {
            if (!v || typeof v !== 'object') continue;
            entries += 1;
            const ts = safeParseDateMs(v.t);
            if (ts == null) continue;
            if (newestAtMs == null || ts > newestAtMs) newestAtMs = ts;
        }

        return {
            exists: true,
            entries,
            newestAtMs,
            newestAt: newestAtMs ? new Date(newestAtMs).toISOString() : null,
            error: null
        };
    } catch (err) {
        return { exists: false, entries: 0, newestAt: null, newestAtMs: null, error: err?.message || String(err) };
    }
}

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
};

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function snapshotPath(ticker) {
    return path.join(EDGAR_SNAPSHOT_DIR, `${ticker.toUpperCase()}-fundamentals.json`);
}

async function loadFundamentalsSnapshot(ticker) {
    const filePath = snapshotPath(ticker);
    try {
        const raw = await fsPromises.readFile(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        let updatedAt = parsed?.updatedAt || null;
        if (!updatedAt) {
            const stats = await fsPromises.stat(filePath);
            updatedAt = stats?.mtime ? new Date(stats.mtime).toISOString() : null;
        }
        return { data: parsed, updatedAt };
    } catch (err) {
        if (err.code !== 'ENOENT') console.warn('[snapshot] failed to read', filePath, err.message);
        return null;
    }
}

function isSnapshotFresh(updatedAt, ttlMs = JSON_SNAPSHOT_TTL_MS) {
    if (!updatedAt) return false;
    const ts = Date.parse(updatedAt);
    if (!Number.isFinite(ts)) return false;
    return Date.now() - ts < ttlMs;
}

async function ensureFundamentalsSnapshot(ticker, { ttlMs = JSON_SNAPSHOT_TTL_MS } = {}) {
    const existing = await loadFundamentalsSnapshot(ticker);
    if (existing?.data?.periods?.length && !isSnapshotFresh(existing.updatedAt, ttlMs)) {
        try {
            const dbRows = await getFundamentalsForTicker(ticker);
            if (dbRows?.length) {
                writeFundamentalsSnapshot(dbRows);
                return await loadFundamentalsSnapshot(ticker);
            }
        } catch (err) {
            console.warn('[snapshot] DB refresh failed', ticker, err?.message || err);
        }
        return existing;
    }
    if (existing?.data?.periods?.length && isSnapshotFresh(existing.updatedAt, ttlMs)) {
        return existing;
    }
    try {
        const dbRows = await getFundamentalsForTicker(ticker);
        if (dbRows?.length) {
            writeFundamentalsSnapshot(dbRows);
            return await loadFundamentalsSnapshot(ticker);
        }
    } catch (err) {
        console.warn('[snapshot] DB fallback failed', ticker, err?.message || err);
    }
    const { pending, active } = getQueueDepth();
    if (pending + active >= EDGAR_SYNC_MAX_QUEUE) {
        try {
            enqueueFundamentalsJob(ticker);
        } catch (err) {
            console.warn('[snapshot] enqueue failed', ticker, err?.message || err);
        }
        return existing;
    }
    await processFilingForTicker(ticker, null, {
        createEvent: true,
        includeFilingSignals: true,
        includeLatestFilingMeta: true,
        jsonOnly: true
    });
    return loadFundamentalsSnapshot(ticker);
}

function computeSnapshotFromPeriods(rows = []) {
    const sorted = [...(rows || [])].filter(Boolean).sort((a, b) => Date.parse(b.periodEnd) - Date.parse(a.periodEnd));
    const quarters = sorted.filter((p) => p.periodType === 'quarter');
    const years = sorted.filter((p) => p.periodType === 'year');
    const latestQuarter = quarters[0] || null;
    const latestYear = years[0] || null;
    const take = quarters.slice(0, 4);
    const sourceCount = take.length;
    const ttm = sourceCount
        ? {
            revenue: take.reduce((acc, p) => acc + (Number(p.revenue) || 0), 0),
            netIncome: take.reduce((acc, p) => acc + (Number(p.netIncome) || 0), 0),
            grossProfit: take.reduce((acc, p) => acc + (Number(p.grossProfit) || 0), 0),
            operatingIncome: take.reduce((acc, p) => acc + (Number(p.operatingIncome) || 0), 0),
            operatingCashFlow: take.reduce((acc, p) => acc + (Number(p.operatingCashFlow) || 0), 0),
            capex: take.reduce((acc, p) => acc + (Number(p.capex) || 0), 0),
            periodEnd: take[0]?.periodEnd || null
        }
        : null;
    if (ttm && Number.isFinite(ttm.operatingCashFlow) && Number.isFinite(ttm.capex)) {
        ttm.freeCashFlow = ttm.operatingCashFlow - ttm.capex;
    }
    const snapshot = {
        latestQuarter,
        latestYear,
        ttm: ttm || null,
        ttmIncomplete: sourceCount < 4,
        ttmSourceCount: sourceCount,
        notes: {},
        coverage: { quarters: quarters.length, years: years.length },
        ratios: {}
    };
    if (snapshot.ttmIncomplete) {
        snapshot.notes.ttm = `Trailing twelve months is based on the last ${snapshot.ttmSourceCount} reported quarter(s). Final TTM will refresh after the next filing.`;
    }
    const base = latestYear || latestQuarter || {};
    if (base.revenue) {
        snapshot.ratios.grossMargin = base.grossProfit != null ? base.grossProfit / base.revenue : null;
        snapshot.ratios.netMargin = base.netIncome != null ? base.netIncome / base.revenue : null;
        snapshot.ratios.operatingMargin = base.operatingIncome != null ? base.operatingIncome / base.revenue : null;
    }
    if (base.totalAssets && base.totalLiabilities != null) {
        snapshot.ratios.debtToAssets = base.totalLiabilities / base.totalAssets;
    }
    if (base.totalEquity) {
        snapshot.ratios.debtToEquity = base.totalDebt != null ? base.totalDebt / base.totalEquity : null;
    }
    if (base.operatingCashFlow != null && base.capex != null) {
        snapshot.ratios.cashFlowCoverage = (base.operatingCashFlow - base.capex) / (base.totalDebt || 1);
    }
    return snapshot;
}

function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length) return forwarded.split(',')[0].trim();
    return req.socket.remoteAddress || 'unknown';
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

function setSecurityHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
}

function setApiCors(res) {
    const allowOrigin = process.env.CORS_ALLOW_ORIGIN || '*';
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    setSecurityHeaders(res);
}

function sendJson(req, res, status, payload) {
    const json = JSON.stringify(payload);
    const acceptEncoding = req.headers['accept-encoding'] || '';

    if (acceptEncoding.includes('gzip')) {
        res.writeHead(status, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Encoding': 'gzip',
            'Vary': 'Accept-Encoding'
        });
        zlib.gzip(json, (err, buffer) => {
            if (err) return res.end(json);
            res.end(buffer);
        });
    } else {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Vary': 'Accept-Encoding' });
        res.end(json);
    }
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
        const err = new Error('External data provider is not configured');
        err.status = 503;
        throw err;
    }
    const url = new URL(`${DATA_API_BASE}/${endpoint}`);
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null || value === '') continue;
        url.searchParams.set(key, value);
    }
    if (DATA_API_KEY) url.searchParams.set('apikey', DATA_API_KEY);

    let attempt = 0;
    while (attempt < OUTBOUND_MAX_RETRIES) {
        await waitForOutboundSlot();
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), DATA_REQUEST_TIMEOUT_MS);
        try {
            const res = await fetch(url, {
                headers: { 'User-Agent': DATA_USER_AGENT },
                signal: controller.signal
            });
            if ([429, 503].includes(res.status) && attempt < OUTBOUND_MAX_RETRIES - 1) {
                const backoff = OUTBOUND_BASE_BACKOFF_MS * Math.pow(2, attempt);
                await res.text().catch(() => '');
                releaseOutboundSlot();
                await sleep(backoff);
                attempt++;
                continue;
            }
            if (!res.ok) {
                const errText = await res.text().catch(() => '');
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
        } finally {
            clearTimeout(timeoutId);
        }
    }
}
async function getCachedViewModel(symbol) {
    const cachePath = path.join(VM_CACHE_DIR, `${symbol.toUpperCase()}.json`);
    try {
        const stats = await fsPromises.stat(cachePath);
        const age = Date.now() - stats.mtimeMs;
        if (age < VM_CACHE_TTL_MS) {
            const data = await fsPromises.readFile(cachePath, 'utf8');
            return JSON.parse(data);
        }
    } catch (err) { }
    return null;
}

async function saveCachedViewModel(symbol, vm) {
    try {
        await fsPromises.mkdir(VM_CACHE_DIR, { recursive: true });
        const cachePath = path.join(VM_CACHE_DIR, `${symbol.toUpperCase()}.json`);
        await fsPromises.writeFile(cachePath, JSON.stringify(vm), 'utf8');
    } catch (err) {
        console.warn(`[cache] failed to save vm cache for ${symbol}:`, err.message);
    }
}

async function buildTickerPayload(symbol, section) {
    if (!symbol) {
        const err = new Error('Missing symbol');
        err.status = 400;
        throw err;
    }
    if (section) {
        const err = new Error('Section endpoints are disabled; use unified ticker view model.');
        err.status = 410;
        throw err;
    }
    const snapshot = await ensureFundamentalsSnapshot(symbol);
    const fundamentals = snapshot?.data?.periods || [];
    if (!fundamentals.length) {
        const err = new Error('Ticker data unavailable');
        err.status = 404;
        throw err;
    }
    const vm = await buildTickerViewModel(symbol, {
        fundamentalsOverride: fundamentals,
        allowFilingScan: true
    });
    if (!vm) {
        const err = new Error('Ticker data unavailable');
        err.status = 404;
        throw err;
    }
    await saveCachedViewModel(symbol, vm);
    return vm;
}

async function buildEdgarStatusPayload(ticker, { enqueueIfStale = true } = {}) {
    const normalized = ticker?.toUpperCase();
    if (!normalized) {
        const err = new Error('ticker is required');
        err.status = 400;
        throw err;
    }
    const snap = await loadFundamentalsSnapshot(normalized);
    if (snap?.data?.periods?.length && isSnapshotFresh(snap.updatedAt, JSON_SNAPSHOT_TTL_MS)) {
        const cached = await getCachedViewModel(normalized);
        if (cached) return { status: 'ready', updatedAt: snap.updatedAt, data: cached };
        const vm = await buildTickerViewModel(normalized, {
            fundamentalsOverride: snap.data.periods,
            allowFilingScan: true
        });
        if (!vm) return { status: 'error', error: 'Could not assemble ticker view model' };
        await saveCachedViewModel(normalized, vm);
        return { status: 'ready', updatedAt: snap.updatedAt, data: vm };
    }
    if (enqueueIfStale) {
        const refreshed = await ensureFundamentalsSnapshot(normalized);
        if (refreshed?.data?.periods?.length) {
            const vm = await buildTickerViewModel(normalized, {
                fundamentalsOverride: refreshed.data.periods,
                allowFilingScan: true
            });
            if (vm) {
                await saveCachedViewModel(normalized, vm);
                return { status: 'ready', updatedAt: refreshed.updatedAt, data: vm };
            }
        }
    }
    return {
        status: 'missing',
        updatedAt: snap?.updatedAt || null,
        data: undefined
    };
}

function normalizeSnapshotCompleteness(snapshot) {
    const percent = Number.isFinite(snapshot?.completeness?.percent)
        ? Math.max(0, Math.min(100, Math.round(snapshot.completeness.percent)))
        : null;
    const tier = percent == null ? 'low' : percent >= 75 ? 'high' : percent >= 50 ? 'medium' : 'low';
    return { ...(snapshot?.completeness || {}), percent, tier };
}

function deriveSnapshotConfidence({ completenessPercent, lastFiledDate, stale }) {
    const pct = Number.isFinite(completenessPercent) ? completenessPercent : 0;
    const daysSinceFiled = lastFiledDate ? (Date.now() - Date.parse(lastFiledDate)) / (1000 * 60 * 60 * 24) : null;
    let score = pct;
    if (Number.isFinite(daysSinceFiled)) {
        if (daysSinceFiled > 540) score -= 30;
        else if (daysSinceFiled > 365) score -= 20;
        else if (daysSinceFiled > 270) score -= 10;
        else if (daysSinceFiled <= 180) score += 5;
    } else {
        score -= 10;
    }
    if (stale) score -= 10;
    const capped = Math.max(0, Math.min(100, Math.round(score)));
    const level = capped >= 75 ? 'high' : capped >= 45 ? 'medium' : 'low';
    return { level, score: capped, freshnessDays: Number.isFinite(daysSinceFiled) ? Math.round(daysSinceFiled) : null };
}

function buildSnapshotPayload(raw) {
    const snapshot = raw.snapshot || {};
    const notesArr = [];
    if (snapshot.notes) notesArr.push(...Object.values(snapshot.notes));
    if (snapshot.ttmIncomplete) {
        notesArr.push(
            `TTM is based on the last ${snapshot.ttmSourceCount || 'few'} reported quarter(s). Final TTM will refresh after the next filing.`,
        );
    }
    if (raw.inactive) notesArr.push('This ticker is not reporting new filings. Data may be stale or incomplete.');
    if (!raw.inactive && !raw.pending && raw.source === 'none') {
        notesArr.push('No fundamentals available yet for this ticker.');
    }
    const completeness = normalizeSnapshotCompleteness(snapshot);
    const issuerType = raw?.filingSignals?.meta?.issuerType || 'domestic';
    const filingProfile =
        raw?.filingSignals?.meta?.filingProfile || { annual: '10-K', interim: '10-Q', current: '8-K' };
    const latestFiled =
        snapshot?.latestQuarter?.filedDate ||
        snapshot?.latestYear?.filedDate ||
        snapshot?.latestQuarter?.filed ||
        snapshot?.latestYear?.filed ||
        raw.updatedAt ||
        null;
    const confidenceMeta = deriveSnapshotConfidence({
        completenessPercent: completeness.percent,
        lastFiledDate: latestFiled,
        stale: Boolean(snapshot.notes?.stale),
    });
    const status = raw.inactive && !raw.snapshot ? 'none' : raw.pending ? 'pending' : raw.snapshot ? 'ok' : 'none';
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
        filingSignals: raw.filingSignals || null,
        issuerType,
        filingProfile,
        dataCompleteness: completeness,
        confidence: confidenceMeta.level,
        confidenceMeta,
    };
}

async function handleApi(req, res, url) {
    setApiCors(res);
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
    }
    const isTickerEndpoint = url.pathname === '/api/ticker' || url.pathname.startsWith('/api/ticker/');
    const skipRateLimit = isTickerEndpoint;
    if (!skipRateLimit) {
        const ip = getClientIp(req);
        if (isRateLimited(ip)) return sendJson(req, res, 429, { error: 'Rate limit exceeded, try again shortly.' });
    }

    try {
        if (isTickerEndpoint) {
            if (activeTickerRequests >= MAX_TICKER_CONCURRENCY) {
                return sendJson(req, res, 503, { error: 'Server busy, try again shortly.' });
            }
            activeTickerRequests++;
            try {
                if (url.pathname.startsWith('/api/ticker/')) {
                    const parts = url.pathname.split('/').filter(Boolean);
                    const symbol = parts[2];
                    if (!symbol) return sendJson(req, res, 400, { error: 'ticker is required' });
                    const payload = await buildEdgarStatusPayload(symbol);
                    const statusCode =
                        payload.status === 'ready'
                            ? 200
                            : payload.status === 'error'
                                ? 500
                                : payload.status === 'busy'
                                    ? 429
                                    : 202;
                    return sendJson(req, res, statusCode, payload);
                }
                if (url.pathname === '/api/ticker') {
                    const ticker = url.searchParams.get('symbol')?.toUpperCase();
                    const section = url.searchParams.get('section');
                    const refresh = url.searchParams.get('refresh') === 'true';

                    if (!refresh) {
                        const cached = await getCachedViewModel(ticker);
                        if (cached) {
                            const cachedAt = cached?.filingSignalsCachedAt ? Date.parse(cached.filingSignalsCachedAt) : NaN;
                            // If the cached VM predates filingSignalsCachedAt support, rebuild once so filing cards can render.
                            if (Number.isFinite(cachedAt)) {
                                return sendJson(req, res, 200, cached);
                            }
                        }
                    }

                    const data = await buildTickerPayload(ticker, section);
                    return sendJson(req, res, 200, data);
                }
            } finally {
                activeTickerRequests = Math.max(0, activeTickerRequests - 1);
            }
        }
        if (url.pathname === '/api/prices/patch') {
            const { getScreenerPricePatch } = await import('./server/screener/screenerService.js');
            const data = await getScreenerPricePatch();
            return sendJson(req, res, 200, data);
        }
        if (url.pathname === '/api/prices/status') {
            const filePath = path.join(DATA_DIR, 'prices.json');
            const meta = readPricesPatchMeta(filePath);
            const staleAfterMs = Number(process.env.PRICES_PATCH_MAX_AGE_MS) || 48 * 60 * 60 * 1000;
            const ageMs = meta.newestAtMs != null ? Date.now() - meta.newestAtMs : null;
            const isStale = !meta.newestAtMs || !Number.isFinite(ageMs) || ageMs > staleAfterMs;
            return sendJson(req, res, 200, { ...meta, ageMs, staleAfterMs, isStale, filePath });
        }
        if (url.pathname === '/api/screener') {
            const data = await queryScreener(url);
            return sendJson(req, res, 200, data);
        }
        if (url.pathname === '/api/screener/find') {
            const ticker = url.searchParams.get('ticker')?.toUpperCase();
            if (!ticker) return sendJson(req, res, 400, { error: 'ticker param is required' });
            const pageSizeParam = Number(url.searchParams.get('pageSize'));
            const pageSize = Number.isFinite(pageSizeParam) ? Math.min(Math.max(pageSizeParam, 1), 200) : 50;
            const { findTickerPosition } = await import('./server/screener/screenerService.js');
            const result = await findTickerPosition(ticker, pageSize);
            return sendJson(req, res, 200, result);
        }
        if (url.pathname === '/api/compare') {
            const left = url.searchParams.get('left')?.toUpperCase();
            const right = url.searchParams.get('right')?.toUpperCase();
            if (!left || !right) return sendJson(req, res, 400, { error: 'left and right query params are required' });
            const [leftData, rightData] = await Promise.all([buildTickerPayload(left), buildTickerPayload(right)]);
            return sendJson(req, res, 200, { left: leftData, right: rightData });
        }
        if (url.pathname === '/api/search') {
            const query = url.searchParams.get('query') || url.searchParams.get('q');
            if (!query) return sendJson(req, res, 400, { error: 'query param is required' });
            const limitParam = Number(url.searchParams.get('limit'));
            const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 20) : 10;
            // Use local SEC company directory - no network call, instant results
            const results = await searchCompaniesByName(query, limit);
            return sendJson(req, res, 200, results);
        }
        if (url.pathname === '/api/filing-news') {
            const since = url.searchParams.get('since') || null;
            const ticker = url.searchParams.get('ticker')?.toUpperCase() || null;
            const type = url.searchParams.get('type') || null;
            const limitParam = Number(url.searchParams.get('limit'));
            const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 200) : 50;
            const rows = await getRecentFilingEvents({ since, ticker, type, limit });
            const enriched = [];
            for (const row of rows) {
                let companyName = null;
                let cik = null;
                try {
                    const file = path.join(DATA_DIR, 'edgar', `${row.ticker}-fundamentals.json`);
                    const raw = await fsPromises.readFile(file, 'utf8');
                    const parsed = JSON.parse(raw);
                    companyName = parsed?.companyName || null;
                    cik = parsed?.cik || null;
                } catch (_) { }
                const accessionNoDashes = row.accession ? row.accession.replace(/-/g, '') : null;
                const cikTrim = cik ? String(cik).replace(/^0+/, '') : null;
                const urlStr =
                    accessionNoDashes && cikTrim
                        ? `https://www.sec.gov/Archives/edgar/data/${cikTrim}/${accessionNoDashes}/${row.accession}-index.html`
                        : null;
                enriched.push({
                    ...row,
                    companyName,
                    url: urlStr,
                    headline: row.headline || (row.filingType ? `New ${row.filingType} filed` : 'New filing'),
                });
            }
            return sendJson(req, res, 200, { events: enriched });
        }
        if (url.pathname === '/api/edgar-facts') {
            const ticker = url.searchParams.get('ticker')?.toUpperCase();
            const cikParam = url.searchParams.get('cik');
            if (!ticker && !cikParam) return sendJson(req, res, 400, { error: 'ticker is required' });
            const mode = url.searchParams.get('mode') || url.searchParams.get('view');
            if (mode === 'snapshot') {
                const key = ticker || cikParam;
                const snap = await ensureFundamentalsSnapshot(key);
                if (!snap?.data?.periods?.length) {
                    return sendJson(req, res, 404, { error: 'Ticker data unavailable' });
                }
                const filingSignals = snap.data.filingSignals
                    ? { signals: snap.data.filingSignals, meta: snap.data.filingSignalsMeta || null, cachedAt: snap.data.filingSignalsCachedAt || null }
                    : null;
                const snapshot = computeSnapshotFromPeriods(snap.data.periods);
                const raw = {
                    ticker: key.toUpperCase(),
                    source: isSnapshotFresh(snap.updatedAt, JSON_SNAPSHOT_TTL_MS) ? 'cache:fresh' : 'cache:stale',
                    updatedAt: snap.updatedAt || null,
                    snapshot,
                    pending: false,
                    inactive: !snap.data?.periods?.length,
                    data: snap.data.periods,
                    filingSignals
                };
                const payload = buildSnapshotPayload(raw);
                return sendJson(req, res, 200, payload);
            }
            const statusPayload = await buildEdgarStatusPayload(ticker, { enqueueIfStale: true });
            const wantsStatus = url.searchParams.get('status') === '1' || url.searchParams.get('mode') === 'status';
            if (statusPayload.status === 'ready' && Array.isArray(statusPayload.data)) {
                return sendJson(req, res, 200, wantsStatus ? statusPayload : statusPayload.data);
            }
            const statusCode =
                statusPayload.status === 'error'
                    ? 500
                    : statusPayload.status === 'busy'
                        ? 429
                        : statusPayload.status === 'ready'
                            ? 200
                            : 202;
            return sendJson(req, res, statusCode, statusPayload);
        }
        return sendJson(req, res, 404, { error: 'Not found' });
    } catch (err) {
        const status = err?.status && Number.isInteger(err.status) ? err.status : 500;
        console.error('[api] error', url?.pathname, err?.stack || err);
        return sendJson(req, res, status, { error: err.message || 'Server error' });
    }
}

function isPathInside(base, target) {
    const rel = path.relative(base, target);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function resolveSafePath(base, urlPath) {
    const clean = decodeURIComponent(urlPath || '/');
    if (clean.includes('\0')) return null;
    const resolved = path.resolve(base, '.' + clean);
    if (!isPathInside(base, resolved)) return null;
    return resolved;
}

const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
    let pathname = parsedUrl.pathname;

    if (pathname.startsWith('/api/')) {
        return handleApi(req, res, parsedUrl);
    }

    if (pathname === '/favicon.ico') {
        const filePath = path.join(PROJECT_ROOT, 'assets', 'images', 'bullfavicon.webp');
        return fs.readFile(filePath, (error, content) => {
            if (error) {
                res.writeHead(204);
                return res.end();
            }
            res.writeHead(200, { 'Content-Type': 'image/webp' });
            return res.end(content);
        });
    }

    if (pathname === '/' || pathname === '') pathname = '/index.html';

    // Support pretty URLs: /ticker/AAPL -> serve ticker.html
    // Only capture 2-segment paths under /ticker/ that don't look like file requests
    if (pathname.startsWith('/ticker/')) {
        const parts = pathname.split('/').filter(Boolean);
        // parts[0] is 'ticker', parts[1] is symbol.
        if (parts.length === 2) {
            // Allow dots for tickers like BRK.B, but exclude common web extensions
            const isAsset = /\.(css|js|png|jpg|jpeg|webp|gif|ico|json|map|svg|woff2?|ttf|html)$/i.test(parts[1]);
            if (!isAsset) {
                pathname = '/ticker.html';
            }
        }
    }

    let base = __dirname;
    let staticPath = pathname;
    if (pathname.startsWith('/assets/')) {
        base = PROJECT_ROOT;
    } else if (pathname === '/data/prices.json') {
        base = DATA_DIR;
        staticPath = '/prices.json';
    } else if (pathname.startsWith('/data/')) {
        res.writeHead(404);
        return res.end('Not found');
    }
    const filePath = resolveSafePath(base, staticPath);
    if (!filePath) {
        res.writeHead(403);
        return res.end('Forbidden');
    }

    const extname = path.extname(filePath);
    const contentType = MIME_TYPES[extname] || 'application/octet-stream';

    if (pathname === '/data/prices.json') {
        try {
            const meta = readPricesPatchMeta(filePath);
            const ageMs = meta.newestAtMs != null ? Date.now() - meta.newestAtMs : null;
            const isStale = !meta.exists || !Number.isFinite(ageMs) || ageMs > PRICE_PATCH_MAX_AGE_MS;

            // In production, stale/missing prices should not crash the deploy/healthcheck loop.
            // Serve an empty object when missing; serve stale data when present, and expose status via headers.
            res.setHeader('X-Prices-Stale', isStale ? '1' : '0');
            if (meta.newestAt) res.setHeader('X-Prices-Newest-At', meta.newestAt);
            res.setHeader('X-Prices-Entries', String(meta.entries || 0));

            if (isStale && !loggedStalePricePatch) {
                console.error('[prices] prices.json missing or stale (serving fallback)', { ageMs, filePath, newestAt: meta.newestAt, entries: meta.entries });
                loggedStalePricePatch = true;
            }

            if (!meta.exists) {
                res.writeHead(200, {
                    'Content-Type': 'application/json; charset=utf-8',
                    'Cache-Control': 'no-store',
                    'Vary': 'Accept-Encoding'
                });
                return res.end('{}');
            }
        } catch (err) {
            if (!loggedStalePricePatch) {
                console.error('[prices] prices.json read failed (serving fallback)', { filePath, error: err?.message || err });
                loggedStalePricePatch = true;
            }
            res.writeHead(200, {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-store',
                'Vary': 'Accept-Encoding'
            });
            return res.end('{}');
        }
    }

    fs.readFile(filePath, (error, content) => {
        if (error) {
            if (error.code === 'ENOENT') {
                res.writeHead(404);
                res.end('File not found: ' + pathname);
            } else {
                res.writeHead(500);
                res.end(`Server error: ${error.code}`);
            }
        } else {
            const staticCacheLimit = 31536000; // 1 year for versioned assets
            const dataCacheLimit = 3600 * 8; // 8 hours for data files
            const pricesCacheLimit = Number(process.env.PRICES_JSON_MAX_AGE_SEC) || 300; // 5 minutes
            const isAsset = pathname.startsWith('/assets/') || pathname.endsWith('.css') || pathname.endsWith('.js');
            const isData = pathname.startsWith('/data/') && pathname.endsWith('.json');
            const isPricesPatch = pathname === '/data/prices.json';

            const headers = { 'Content-Type': contentType };
            // Security headers for all responses
            headers['X-Content-Type-Options'] = 'nosniff';
            headers['X-Frame-Options'] = 'SAMEORIGIN';
            headers['Referrer-Policy'] = 'strict-origin-when-cross-origin';
            if (isAsset) {
                headers['Cache-Control'] = `public, max-age=${staticCacheLimit}, immutable`;
            } else if (isData) {
                headers['Cache-Control'] = isPricesPatch
                    ? `public, max-age=${pricesCacheLimit}`
                    : `public, max-age=${dataCacheLimit}`;
            }

            const acceptEncoding = req.headers['accept-encoding'] || '';
            if (acceptEncoding.includes('gzip')) {
                headers['Content-Encoding'] = 'gzip';
                headers['Vary'] = 'Accept-Encoding';
                res.writeHead(200, headers);
                zlib.gzip(content, (err, buffer) => {
                    if (err) return res.end(content);
                    res.end(buffer);
                });
            } else {
                headers['Vary'] = 'Accept-Encoding';
                res.writeHead(200, headers);
                res.end(content);
            }
        }
    });
});

server.listen(PORT, () => {
    console.log(`Bullish and Foolish v1.30 is live on port ${PORT}`);
});

if (process.env.SCREENER_SCHEDULER_ENABLED === '1') {
    startScreenerScheduler().catch((err) => {
        console.warn('[screenerScheduler] failed to start', err?.message || err);
    });
}

const pricesSchedulerEnabled =
    process.env.PRICES_SCHEDULER_ENABLED === '1' || Boolean(process.env.RAILWAY_VOLUME_MOUNT_PATH);
if (pricesSchedulerEnabled) {
    startDailyPricesScheduler().catch((err) => {
        console.warn('[dailyPricesScheduler] failed to start', err?.message || err);
    });
}

async function shutdown(signal) {
    console.warn(`[shutdown] ${signal} received, closing resources...`);
    try {
        await Promise.all([
            closeFundamentalsDb(),
            closeScreenerDb(),
            closePricesDb()
        ]);
    } catch (err) {
        console.warn('[shutdown] failed to close databases', err?.message || err);
    }
    server.close(() => process.exit(0));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
