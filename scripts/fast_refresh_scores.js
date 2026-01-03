/**
 * Fast screener score refresh - LOCAL ONLY, no SEC network calls.
 * This recalculates scores from fundamentals.db without fetching filing signals.
 */
import { getDb } from "../server/edgar/fundamentalsStore.js";
import { getScreenerDb, ensureScreenerSchema, upsertScreenerRows } from "../server/screener/screenerStore.js";
import { buildScreenerRowForTicker } from "../server/ticker/tickerAssembler.js";

// Filter out tickers that will be excluded from screener anyway
function shouldIncludeTicker(ticker) {
    const t = String(ticker || "").trim().toUpperCase();
    if (!t) return false;

    // Skip warrants, preferreds, units (5+ chars ending in W, U, R)
    if (t.length >= 5 && /[WUR]$/.test(t)) return false;

    // Skip tickers with special chars (except allowed ones)
    if (/[-+. ]/.test(t) && !["GOOG", "GOOGL", "BRK.A", "BRK.B", "BRK-A", "BRK-B"].includes(t)) {
        return false;
    }

    return true;
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

async function main() {
    const startTime = Date.now();

    // Get tickers from fundamentals.db
    const db = await getDb();
    const allTickers = db
        .prepare("SELECT DISTINCT ticker FROM fundamentals ORDER BY ticker ASC")
        .all()
        .map((r) => r.ticker)
        .filter(Boolean);

    // Filter to only tickers that will appear in screener
    const tickers = allTickers.filter(shouldIncludeTicker);

    console.info(`[fast-refresh] Starting: ${tickers.length} tickers (filtered from ${allTickers.length})`);

    await ensureScreenerSchema();

    const concurrency = Number(process.env.SCREENER_REFRESH_CONCURRENCY) || 8; // Higher concurrency since no network
    let processed = 0;

    const built = await mapLimit(tickers, concurrency, async (ticker) => {
        try {
            // CRITICAL: allowFilingScan = false - NO network calls
            const row = await buildScreenerRowForTicker(ticker, { allowFilingScan: false });
            processed++;
            if (processed % 100 === 0) {
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                const rate = (processed / (Date.now() - startTime) * 1000).toFixed(1);
                console.info(`[fast-refresh] Progress: ${processed}/${tickers.length} (${rate}/sec, ${elapsed}s elapsed)`);
            }
            return row;
        } catch (err) {
            console.warn(`[fast-refresh] Failed: ${ticker}`, err?.message);
            return null;
        }
    });

    const rows = built.filter(Boolean);
    await upsertScreenerRows(rows);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.info(`[fast-refresh] Complete: ${rows.length} rows in ${elapsed}s`);
}

main().catch((err) => {
    console.error("[fast-refresh] failed", err?.stack || err);
    process.exit(1);
});
