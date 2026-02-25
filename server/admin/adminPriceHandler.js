/**
 * Admin API handler for price updates
 * Allows triggering price refresh and pushing to GitHub from mobile
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(PROJECT_ROOT, 'data');

// GitHub configuration (set these in Railway environment variables)
const GITHUB_TOKEN = process.env.GITHUB_TOKEN; // Personal Access Token with repo scope
const GITHUB_REPO = process.env.GITHUB_REPO || 'freelancerbg71/bullish-and-foolish-live';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const ADMIN_KEY = process.env.ADMIN_KEY; // Simple shared secret for auth
const ADMIN_MAX_BODY_BYTES = Number(process.env.ADMIN_MAX_BODY_BYTES) || (8 * 1024 * 1024);
const ADMIN_SCREENER_REFRESH_LIMIT = Number(process.env.ADMIN_SCREENER_REFRESH_LIMIT) || 600;
const ADMIN_SCREENER_REFRESH_CONCURRENCY = Number(process.env.ADMIN_SCREENER_REFRESH_CONCURRENCY) || 2;
const ADMIN_SCREENER_REFRESH_INCLUDE_FILINGS = process.env.ADMIN_SCREENER_REFRESH_INCLUDE_FILINGS === '1';

/**
 * Push prices.json to GitHub via API
 */
async function pushToGithub(content, commitMessage) {
    if (!GITHUB_TOKEN) {
        return { success: false, error: 'GITHUB_TOKEN not configured' };
    }

    const filePath = 'data/prices.json';
    const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`;

    try {
        // First, get the current file SHA (required for updates)
        const getRes = await fetch(apiUrl, {
            headers: {
                'Authorization': `Bearer ${GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'BullishAndFoolish-PriceUpdater'
            }
        });

        let sha = null;
        if (getRes.ok) {
            const current = await getRes.json();
            sha = current.sha;
        } else if (getRes.status !== 404) {
            const errText = await getRes.text();
            console.error('[admin:github] failed to get current file', getRes.status, errText);
        }

        // Encode content as base64
        const contentBase64 = Buffer.from(content).toString('base64');

        // Create or update the file
        const body = {
            message: commitMessage || `data: update prices.json for ${new Date().toISOString().split('T')[0]}`,
            content: contentBase64,
            branch: GITHUB_BRANCH
        };
        if (sha) body.sha = sha;

        const putRes = await fetch(apiUrl, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'BullishAndFoolish-PriceUpdater',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });

        if (!putRes.ok) {
            const errText = await putRes.text();
            console.error('[admin:github] push failed', putRes.status, errText);
            return { success: false, error: `GitHub API error: ${putRes.status}` };
        }

        const result = await putRes.json();
        console.log('[admin:github] pushed successfully', result.commit?.sha?.substring(0, 7));

        return {
            success: true,
            sha: result.commit?.sha,
            url: result.content?.html_url
        };

    } catch (err) {
        console.error('[admin:github] error', err);
        return { success: false, error: err.message };
    }
}

/**
 * Attempt to fetch prices from NASDAQ
 * May fail if NASDAQ blocks the server IP
 */
async function fetchNasdaqPrices() {
    const url = 'https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=0&download=true';

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 60000);

        const res = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/json',
                'Accept-Language': 'en-US,en;q=0.9'
            },
            signal: controller.signal
        });

        clearTimeout(timeout);

        if (!res.ok) {
            throw new Error(`NASDAQ returned ${res.status}`);
        }

        const json = await res.json();
        const rows = json?.data?.rows || [];

        if (rows.length === 0) {
            throw new Error('No data returned from NASDAQ');
        }

        // Build prices object
        const todayDate = new Date().toISOString().split('T')[0];
        const prices = {};

        for (const r of rows) {
            const symbol = String(r.symbol || '').trim().toUpperCase();
            if (!symbol) continue;

            const priceRaw = String(r.lastsale || '').replace(/[$,]/g, '');
            const price = Number(priceRaw);
            const mcRaw = String(r.marketCap || '').replace(/[$,]/g, '');
            const marketCap = Number(mcRaw);

            if (Number.isFinite(price) && price > 0) {
                prices[symbol] = {
                    p: price,
                    t: todayDate,
                    mc: Number.isFinite(marketCap) ? marketCap : null,
                    s: 'NASDAQ-Public'
                };
            }
        }

        return {
            success: true,
            prices,
            count: Object.keys(prices).length
        };

    } catch (err) {
        console.warn('[admin:nasdaq] fetch failed', err.message);
        return {
            success: false,
            error: err.message
        };
    }
}

function parsePositiveInt(value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.trunc(n));
}

function normalizeTicker(value) {
    return String(value || '').trim().toUpperCase();
}

async function selectScreenerRefreshTickers(prices = {}, limit = ADMIN_SCREENER_REFRESH_LIMIT) {
    const incomingTickers = Object.keys(prices || {})
        .map(normalizeTicker)
        .filter(Boolean);
    if (!incomingTickers.length) return [];

    const tickerSet = new Set(incomingTickers);
    const { ensureScreenerSchema, getScreenerDb } = await import('../screener/screenerStore.js');
    await ensureScreenerSchema();
    const db = await getScreenerDb();
    const rows = db
        .prepare(`
            SELECT ticker, marketCap
            FROM screener_index
            ORDER BY COALESCE(marketCap, 0) DESC, ticker ASC
        `)
        .all();

    const eligible = rows
        .map((r) => normalizeTicker(r.ticker))
        .filter((t) => tickerSet.has(t));

    if (limit <= 0 || limit >= eligible.length) return eligible;
    return eligible.slice(0, limit);
}

async function refreshScreenerRowsForPrices({
    prices = {},
    limit = ADMIN_SCREENER_REFRESH_LIMIT,
    concurrency = ADMIN_SCREENER_REFRESH_CONCURRENCY,
    includeFilings = false
} = {}) {
    const tickers = await selectScreenerRefreshTickers(prices, limit);
    if (!tickers.length) {
        return { planned: 0, rows: 0, tickers: 0, durationMs: 0 };
    }

    const started = Date.now();
    const { refreshScreenerIndex } = await import('../screener/screenerService.js');
    const refresh = await refreshScreenerIndex({
        tickers,
        concurrency: Math.max(1, parsePositiveInt(concurrency, ADMIN_SCREENER_REFRESH_CONCURRENCY)),
        allowFilingScan: Boolean(includeFilings)
    });
    const durationMs = Date.now() - started;
    return {
        planned: tickers.length,
        rows: refresh?.rows ?? 0,
        tickers: refresh?.tickers ?? tickers.length,
        durationMs
    };
}

/**
 * Main handler for admin price update requests
 */
export async function handleAdminPriceUpdate(req, res, { sendJson }) {
    // Check authentication
    const providedKey = req.headers['x-admin-key'];
    if (!ADMIN_KEY || providedKey !== ADMIN_KEY) {
        return sendJson(req, res, 401, { error: 'Invalid or missing admin key' });
    }

    // Parse request body for uploaded prices
    let body = {};
    if (req.method === 'POST') {
        const chunks = [];
        let totalBytes = 0;
        for await (const chunk of req) {
            totalBytes += chunk.length;
            if (totalBytes > ADMIN_MAX_BODY_BYTES) {
                return sendJson(req, res, 413, {
                    error: `Payload too large. Max allowed is ${ADMIN_MAX_BODY_BYTES} bytes.`
                });
            }
            chunks.push(chunk);
        }
        const raw = Buffer.concat(chunks).toString();
        if (raw.trim()) {
            try {
                body = JSON.parse(raw);
            } catch (err) {
                return sendJson(req, res, 400, {
                    error: 'Invalid JSON body for admin update request.'
                });
            }
        }
    }

    const result = {
        timestamp: new Date().toISOString(),
        tickersUpdated: 0,
        nasdaqFetched: false,
        nasdaqError: null,
        uploadedPrices: false,
        githubPushed: false,
        githubCommit: null,
        githubError: null,
        screenerRefreshed: false,
        screenerRefreshPlanned: 0,
        screenerRowsRefreshed: 0,
        screenerRefreshDurationMs: null,
        screenerRefreshError: null
    };

    let pricesContent = null;
    let pricesObject = null;
    const skipNasdaqFetch = body.skipNasdaqFetch === true;

    // Option 1: User uploaded prices directly
    if (body.prices && typeof body.prices === 'object') {
        pricesObject = body.prices;
        pricesContent = JSON.stringify(pricesObject);
        result.tickersUpdated = Object.keys(pricesObject).length;
        result.uploadedPrices = true;
        console.log('[admin:update] using uploaded prices', { count: result.tickersUpdated });
    }
    // Option 2: Try to fetch from NASDAQ
    else if (!skipNasdaqFetch) {
        const nasdaq = await fetchNasdaqPrices();
        if (nasdaq.success) {
            pricesObject = nasdaq.prices;
            pricesContent = JSON.stringify(pricesObject);
            result.tickersUpdated = nasdaq.count;
            result.nasdaqFetched = true;
            console.log('[admin:update] fetched from NASDAQ', { count: nasdaq.count });
        } else {
            result.nasdaqError = nasdaq.error;
            console.warn('[admin:update] NASDAQ fetch failed', nasdaq.error);
        }
    }

    if (!pricesContent) {
        return sendJson(req, res, skipNasdaqFetch ? 422 : 500, {
            ...result,
            error: skipNasdaqFetch
                ? 'No uploaded price data provided. Use manual upload from /admin/prices.'
                : 'Failed to get price data. NASDAQ may be blocking this server. Try uploading prices directly.'
        });
    }

    // Write to local data directory
    try {
        const pricesPath = path.join(DATA_DIR, 'prices.json');
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(pricesPath, pricesContent);
        console.log('[admin:update] wrote local prices.json', { path: pricesPath });
    } catch (err) {
        console.error('[admin:update] failed to write local file', err);
        // Continue anyway - GitHub push is more important
    }

    // Push to GitHub if requested
    if (body.pushToGithub !== false) {
        const commitMsg = body.commitMessage ||
            `data: update prices.json for ${new Date().toISOString().split('T')[0]} (mobile)`;
        const github = await pushToGithub(pricesContent, commitMsg);

        if (github.success) {
            result.githubPushed = true;
            result.githubCommit = github.sha?.substring(0, 7);
            result.githubUrl = github.url;
        } else {
            result.githubError = github.error;
        }
    }

    const refreshScreener = body.refreshScreener !== false;
    if (refreshScreener && pricesObject && typeof pricesObject === 'object') {
        const limit = parsePositiveInt(body.screenerRefreshLimit, ADMIN_SCREENER_REFRESH_LIMIT);
        const concurrency = parsePositiveInt(body.screenerRefreshConcurrency, ADMIN_SCREENER_REFRESH_CONCURRENCY);
        const includeFilings = ADMIN_SCREENER_REFRESH_INCLUDE_FILINGS && body.screenerIncludeFilings === true;
        try {
            const refresh = await refreshScreenerRowsForPrices({
                prices: pricesObject,
                limit,
                concurrency,
                includeFilings
            });
            result.screenerRefreshed = true;
            result.screenerRefreshPlanned = refresh.planned;
            result.screenerRowsRefreshed = refresh.rows;
            result.screenerRefreshDurationMs = refresh.durationMs;
        } catch (err) {
            result.screenerRefreshError = err?.message || String(err);
            console.warn('[admin:update] screener refresh failed', result.screenerRefreshError);
        }
    }

    return sendJson(req, res, 200, result);
}

/**
 * Handler for getting current admin status
 */
export async function handleAdminStatus(req, res, { sendJson }) {
    const configured = {
        githubToken: !!GITHUB_TOKEN,
        githubRepo: GITHUB_REPO,
        adminKey: !!ADMIN_KEY
    };

    return sendJson(req, res, 200, {
        configured,
        message: 'Admin API is available'
    });
}
