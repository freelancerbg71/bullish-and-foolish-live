import { fetchLatestRelevantFiling, hasFundamentalsCache, processFilingForTicker } from "./filingWorkflow.js";
import { getTickersForBootstrap, getTickersDueForCheck, markTickerChecked, upsertEdgarTicker } from "./edgarRegistry.js";
import { loadSettings, saveSettings } from "./bootstrapSettings.js";

const BATCH_SIZE = Number(process.env.EDGAR_BOOTSTRAP_BATCH_SIZE) || 50;
const REQUEST_MIN_MS = Number(process.env.EDGAR_WORKER_MIN_MS) || 1500;
const REQUEST_MAX_MS = Number(process.env.EDGAR_WORKER_MAX_MS) || 2500;
const IDLE_SLEEP_MS = Number(process.env.EDGAR_WORKER_IDLE_MS) || 12 * 60 * 1000; // 12 minutes
const BACKOFF_MS = Number(process.env.EDGAR_WORKER_BACKOFF_MS) || 15 * 60 * 1000;
const IDLE_CHECK_MS = 15_000;

const extractState = {
  running: false,
  mode: "bootstrap",
  processed: 0,
  total: 0,
  remaining: 0,
  current: null,
  lastError: null,
  lastMessage: null,
  pausedForMs: 0,
  nextResumeAt: null,
  startedAt: null,
  finishedAt: null,
  respectingPauses: true,
  lastHttpStatus: null,
  backoffUntil: null,
  lastAction: "idle"
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withJitter(minMs, maxMs) {
  const span = Math.max(0, maxMs - minMs);
  return minMs + Math.floor(Math.random() * (span + 1));
}

async function pauseWithJitter() {
  const ms = withJitter(REQUEST_MIN_MS, REQUEST_MAX_MS);
  extractState.pausedForMs = ms;
  extractState.nextResumeAt = new Date(Date.now() + ms).toISOString();
  extractState.lastSleepMs = ms;
  await sleep(ms);
}

async function processSingleTicker(ticker, { createEvent = false } = {}) {
  try {
    const includeFilingSignals = process.env.EDGAR_BOOTSTRAP_INCLUDE_FILING_SIGNALS === "1";
    const includeLatestFilingMeta = process.env.EDGAR_BOOTSTRAP_INCLUDE_LATEST_FILING_META === "1";

    let filing = null;
    if (includeLatestFilingMeta) {
      extractState.lastAction = `fetching latest filing for ${ticker}`;
      filing = await fetchLatestRelevantFiling(ticker);
    }

    extractState.lastAction = `processing ${ticker}`;
    await processFilingForTicker(ticker, filing, { createEvent, includeFilingSignals, includeLatestFilingMeta });
    await markTickerChecked(ticker);
    extractState.lastHttpStatus = 200;
    extractState.lastMessage = `Processed ${ticker} (${filing?.form || "unknown"})`;
    extractState.lastError = null;
    console.log("[edgarWorker] processed", ticker, filing?.form || "unknown");
  } catch (err) {
    console.warn("[edgarWorker] ticker failed", ticker, err?.message || err);
    extractState.lastError = err?.message || "EDGAR fetch failed";
    extractState.lastHttpStatus = err?.status || null;
    // If SEC is unhappy, back off and require manual resume.
    if (err?.status === 429 || err?.status === 503 || /temporarily blocked/i.test(err?.body || "")) {
      const until = new Date(Date.now() + BACKOFF_MS).toISOString();
      extractState.backoffUntil = until;
      extractState.lastAction = `paused due to EDGAR error until ${until}`;
      saveSettings({ bootstrapEnabled: false, backoffUntil: until });
      return;
    }
  } finally {
    await pauseWithJitter();
  }
}

async function runBootstrapBatch(limitOverride = null) {
  const batchSize = limitOverride ? Math.min(limitOverride, BATCH_SIZE) : BATCH_SIZE;
  const batch = await getTickersForBootstrap(batchSize);
  if (!batch.length) return false;
  if (limitOverride && batch.length > limitOverride) {
    batch.length = limitOverride;
  }
  for (const row of batch) {
    extractState.current = row.ticker;
    await processSingleTicker(row.ticker);
  }
  return true;
}

async function runIncrementalSweep() {
  const limit = Number(process.env.EDGAR_INCREMENTAL_LIMIT) || 250;
  const tickers = await getTickersDueForCheck(limit);
  if (!tickers.length) return false;
  let processedAny = false;
  for (const row of tickers) {
    extractState.current = row.ticker;
    try {
      const includeLatestFilingMeta = process.env.EDGAR_INCREMENTAL_INCLUDE_LATEST_FILING_META !== "0"; // default: yes
      const includeFilingSignals = process.env.EDGAR_INCREMENTAL_INCLUDE_FILING_SIGNALS === "1"; // default: no

      let latestFiling = null;
      if (includeLatestFilingMeta) {
        latestFiling = await fetchLatestRelevantFiling(row.ticker);
      }

      const hasNew =
        latestFiling?.filed &&
        (!row.lastFilingDate || Date.parse(latestFiling.filed) > Date.parse(row.lastFilingDate));

      if (hasNew || !hasFundamentalsCache(row.ticker)) {
        await processFilingForTicker(row.ticker, latestFiling, {
          createEvent: true,
          includeLatestFilingMeta,
          includeFilingSignals
        });
        processedAny = true;
        extractState.lastHttpStatus = 200;
      } else {
        await upsertEdgarTicker({
          ticker: row.ticker,
          cik: row.cik,
          lastCheckedAt: new Date().toISOString(),
          lastFilingDate: row.lastFilingDate,
          lastFilingType: row.lastFilingType,
          isActive: row.isActive
        });
      }
    } catch (err) {
      console.warn("[edgarWorker] incremental check failed", row.ticker, err?.message || err);
      extractState.lastError = err?.message || "EDGAR incremental failed";
      extractState.lastHttpStatus = err?.status || null;
    }
    try {
      await markTickerChecked(row.ticker);
    } catch (_) {}
    await pauseWithJitter();
  }
  return processedAny;
}

async function buildBootstrapQueue() {
  const all = await listAllTickers();
  const queue = [];
  for (const row of all) {
    const missing = !row.lastFilingDate || !hasFundamentalsCache(row.ticker);
    if (missing) queue.push(row);
  }
  return queue;
}

async function computeProgress() {
  const settings = loadSettings();
  const tickers = await listAllTickers();
  const totalTickers = tickers.length;
  let processedTickers = 0;
  for (const row of tickers) {
    if (row.lastFilingDate && hasFundamentalsCache(row.ticker)) processedTickers += 1;
  }
  const testLimit = settings.bootstrapTestLimit;
  const targetTotal = testLimit ? Math.min(testLimit, totalTickers) : totalTickers;
  const targetProcessed =
    testLimit && testLimit > 0
      ? tickers
          .slice(0, testLimit)
          .filter((r) => r.lastFilingDate && hasFundamentalsCache(r.ticker)).length
      : processedTickers;
  return { totalTickers, processedTickers, targetTotal, targetProcessed, testLimit };
}

export async function getExtractStatus() {
  const { totalTickers, processedTickers, targetTotal, targetProcessed, testLimit } = await computeProgress();
  const percent =
    targetTotal > 0 ? Math.min(100, Math.round((targetProcessed / targetTotal) * 100)) : 0;
  return {
    ...extractState,
    total: totalTickers,
    processed: processedTickers,
    remaining: Math.max(0, totalTickers - processedTickers),
    percent,
    percentComplete: percent,
    totalTickers,
    processedTickers,
    currentTicker: extractState.current,
    sleepMsMin: REQUEST_MIN_MS,
    sleepMsMax: REQUEST_MAX_MS,
    lastSleepMs: extractState.lastSleepMs || extractState.pausedForMs || null,
    isRunning: loadSettings().bootstrapEnabled,
    lastErrorMessage: extractState.lastError,
    lastAction: extractState.lastAction,
    backoffUntil: extractState.backoffUntil,
    testLimit
  };
}

export function setBootstrapEnabled(enabled) {
  const settings = saveSettings({ bootstrapEnabled: !!enabled, bootstrapTestLimit: null });
  extractState.backoffUntil = settings.backoffUntil || null;
  if (enabled) {
    extractState.lastMessage = "Bootstrap enabled";
  } else {
    extractState.lastAction = "idle";
    extractState.lastMessage = "Bootstrap paused";
  }
  return settings;
}

export function startEdgarWorker() {
  const enabled = process.env.EDGAR_WORKER_ENABLED === "1" || process.env.EDGAR_BOOTSTRAP_ENABLED === "1";
  if (!enabled) {
    console.info("[edgarWorker] disabled (set EDGAR_WORKER_ENABLED=1 to enable)");
    return;
  }
  console.info("[edgarWorker] starting background loop");
  (async function loop() {
    while (true) {
      const settings = loadSettings();
      const now = Date.now();
      if (settings.backoffUntil && Date.parse(settings.backoffUntil) > now) {
        extractState.backoffUntil = settings.backoffUntil;
        extractState.lastAction = `paused due to EDGAR error until ${settings.backoffUntil}`;
        extractState.running = false;
        await sleep(IDLE_CHECK_MS);
        continue;
      } else if (settings.backoffUntil && Date.parse(settings.backoffUntil) <= now) {
        saveSettings({ backoffUntil: null });
        extractState.backoffUntil = null;
      }

      if (!settings.bootstrapEnabled) {
        extractState.running = false;
        extractState.lastAction = "idle (bootstrap disabled)";
        extractState.current = null;
        await sleep(IDLE_CHECK_MS);
        continue;
      }

      extractState.mode = settings.bootstrapTestLimit ? "test" : "bootstrap";
      extractState.running = true;
      extractState.startedAt = extractState.startedAt || new Date().toISOString();
      extractState.finishedAt = null;
      const worked = await runBootstrapBatch(settings.bootstrapTestLimit || null);
      if (!worked) {
        extractState.lastAction = "idle (no bootstrap candidates)";
        extractState.running = false;
        await sleep(IDLE_SLEEP_MS);
      }
    }
  })().catch((err) => console.error("[edgarWorker] fatal error", err?.message || err));
}
