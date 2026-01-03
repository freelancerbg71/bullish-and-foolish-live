import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(ROOT, "data");
const PRICE_PATCH_PATH = path.join(DATA_DIR, "prices.json");

let jobProc = null;

function isWeekday() {
  const day = new Date().getUTCDay();
  return day >= 1 && day <= 5; // Mon=1 ... Fri=5
}

function nextRunAt(hourUtc = 3) {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(hourUtc, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

function safeDateMs(dateStr) {
  const ts = Date.parse(String(dateStr || ""));
  return Number.isFinite(ts) ? ts : null;
}

function summarizePricePatch(filePath) {
  try {
    if (!fs.existsSync(filePath)) return { exists: false, entries: 0, newestAt: null, newestDate: null };
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { exists: true, entries: 0, newestAt: null, newestDate: null };

    let newestMs = null;
    let entries = 0;
    for (const val of Object.values(parsed)) {
      if (!val || typeof val !== "object") continue;
      entries += 1;
      const ts = safeDateMs(val.t);
      if (ts == null) continue;
      if (newestMs == null || ts > newestMs) newestMs = ts;
    }
    const newestAt = newestMs ? new Date(newestMs).toISOString() : null;
    const newestDate = newestMs ? new Date(newestMs).toISOString().split("T")[0] : null;
    return { exists: true, entries, newestAt, newestDate };
  } catch (err) {
    console.warn("[dailyPricesScheduler] failed to read prices.json", err?.message || err);
    return { exists: false, entries: 0, newestAt: null, newestDate: null };
  }
}

function isStale(iso, staleAfterMs) {
  const ts = safeDateMs(iso);
  if (ts == null) return true;
  const ageMs = Date.now() - ts;
  return !Number.isFinite(ageMs) || ageMs > staleAfterMs;
}

function isMissingTodaysPrices(newestDate) {
  if (!newestDate) return true;
  const today = new Date().toISOString().split("T")[0];
  return newestDate !== today;
}

function spawnDailyLastTradeJob({ force = false } = {}) {
  if (jobProc && jobProc.exitCode == null) {
    console.info("[dailyPricesScheduler] job already running, skipping spawn");
    return false;
  }

  const scriptPath = path.join(ROOT, "worker", "jobs", "daily-last-trade.js");
  const args = [scriptPath];
  if (force) args.push("--force");

  console.info("[dailyPricesScheduler] spawning daily-last-trade", { force, script: scriptPath });
  jobProc = spawn(process.execPath, args, { stdio: "inherit", env: process.env });
  jobProc.on("exit", (code) => {
    console.info("[dailyPricesScheduler] daily-last-trade exited", { code });
    jobProc = null;
    if (code !== 0) {
      console.warn("[dailyPricesScheduler] daily-last-trade exited non-zero", code);
    }
  });
  jobProc.on("error", (err) => {
    console.error("[dailyPricesScheduler] failed to spawn daily-last-trade", err?.message || err);
    jobProc = null;
  });

  return true;
}

function syncBundledPrices() {
  const bundledPath = path.join(ROOT, "data", "prices.json");

  // If running locally where DATA_DIR is just "data", paths might be identical
  if (path.resolve(bundledPath) === path.resolve(PRICE_PATCH_PATH)) return;

  try {
    const bundledInfo = summarizePricePatch(bundledPath);
    if (!bundledInfo.exists) return;

    const targetInfo = summarizePricePatch(PRICE_PATCH_PATH);

    // If target missing, or bundled is strictly newer
    const bundledTs = bundledInfo.newestAt ? Date.parse(bundledInfo.newestAt) : 0;
    const targetTs = targetInfo.newestAt ? Date.parse(targetInfo.newestAt) : 0;

    if (!targetInfo.exists || bundledTs > targetTs) {
      console.info("[dailyPricesScheduler] bundled prices.json is newer, syncing to persistent volume", {
        bundled: bundledInfo.newestDate,
        target: targetInfo.newestDate
      });
      fs.copyFileSync(bundledPath, PRICE_PATCH_PATH);
    }
  } catch (err) {
    console.warn("[dailyPricesScheduler] failed to sync bundled prices", err.message);
  }
}

export async function startDailyPricesScheduler() {
  // Allow disabling the scheduler entirely (e.g., when NASDAQ blocks Railway IPs)
  if (process.env.PRICES_SCHEDULER_DISABLED === "1") {
    console.info("[dailyPricesScheduler] scheduler disabled via PRICES_SCHEDULER_DISABLED=1, skipping");
    return;
  }

  const staleAfterMs = Number(process.env.PRICES_PATCH_MAX_AGE_MS) || 48 * 60 * 60 * 1000;

  // Attempt to sync bundled prices (e.g. from git push) before checking status
  syncBundledPrices();

  const warmOnStart = process.env.PRICES_WARM_ON_START !== "0";
  const forceOnStart = process.env.PRICES_FORCE_RUN_ON_START === "1";
  const runOnWeekends = process.env.PRICES_RUN_ON_WEEKENDS === "1";
  const hourUtc = Number(process.env.PRICES_REFRESH_UTC_HOUR) || 3;

  const info = summarizePricePatch(PRICE_PATCH_PATH);
  const weekday = isWeekday();
  const pricesStale = isStale(info.newestAt, staleAfterMs);
  const missingToday = isMissingTodaysPrices(info.newestDate);

  console.info("[dailyPricesScheduler] boot check", {
    pricesPath: PRICE_PATCH_PATH,
    ...info,
    weekday,
    pricesStale,
    missingToday,
    warmOnStart,
    forceOnStart,
    runOnWeekends,
    nextScheduledRun: nextRunAt(hourUtc).toISOString()
  });

  // Determine if we should refresh prices on boot
  const shouldWarm = warmOnStart || forceOnStart;
  const needsRefresh = forceOnStart || !info.exists || pricesStale || (weekday && missingToday);

  if (shouldWarm && needsRefresh) {
    console.info("[dailyPricesScheduler] prices need refresh, starting job in 10s...", {
      reason: forceOnStart ? "forceOnStart" : !info.exists ? "missing" : pricesStale ? "stale" : "missingToday"
    });
    // Delay spawn to let Railway networking stabilize after boot
    setTimeout(() => {
      console.info("[dailyPricesScheduler] spawning price refresh job now");
      // Force the job to bypass weekend check when prices are stale or missing
      const force = forceOnStart || pricesStale || !info.exists || (weekday && missingToday);
      spawnDailyLastTradeJob({ force });
    }, 10_000);
  } else if (shouldWarm) {
    console.info("[dailyPricesScheduler] prices are fresh, no refresh needed");
  }

  // Schedule nightly runs
  const scheduleNext = () => {
    const next = nextRunAt(hourUtc);
    const delay = Math.max(5_000, next.getTime() - Date.now());
    const delayHours = (delay / (1000 * 60 * 60)).toFixed(1);
    console.info("[dailyPricesScheduler] next run scheduled", { at: next.toISOString(), inHours: delayHours });

    setTimeout(() => {
      const nowInfo = summarizePricePatch(PRICE_PATCH_PATH);
      const nowStale = isStale(nowInfo.newestAt, staleAfterMs);
      // Force if stale OR if it's a weekday and we don't have today's prices
      const needsForce = runOnWeekends || nowStale || (isWeekday() && isMissingTodaysPrices(nowInfo.newestDate));

      console.info("[dailyPricesScheduler] nightly refresh triggered", {
        at: new Date().toISOString(),
        force: needsForce,
        pricesStale: nowStale,
        newestDate: nowInfo.newestDate
      });

      spawnDailyLastTradeJob({ force: needsForce });
      scheduleNext();
    }, delay);
  };

  scheduleNext();
}
