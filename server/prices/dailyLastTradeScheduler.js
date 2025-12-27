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
    if (!fs.existsSync(filePath)) return { exists: false, entries: 0, newestAt: null };
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { exists: true, entries: 0, newestAt: null };

    let newestMs = null;
    let entries = 0;
    for (const val of Object.values(parsed)) {
      if (!val || typeof val !== "object") continue;
      entries += 1;
      const ts = safeDateMs(val.t);
      if (ts == null) continue;
      if (newestMs == null || ts > newestMs) newestMs = ts;
    }
    return { exists: true, entries, newestAt: newestMs ? new Date(newestMs).toISOString() : null };
  } catch (err) {
    console.warn("[dailyPricesScheduler] failed to read prices.json", err?.message || err);
    return { exists: false, entries: 0, newestAt: null };
  }
}

function isStale(iso, staleAfterMs) {
  const ts = safeDateMs(iso);
  if (ts == null) return true;
  const ageMs = Date.now() - ts;
  return !Number.isFinite(ageMs) || ageMs > staleAfterMs;
}

function spawnDailyLastTradeJob({ force = false } = {}) {
  if (jobProc && jobProc.exitCode == null) return false;

  const scriptPath = path.join(ROOT, "worker", "jobs", "daily-last-trade.js");
  const args = [scriptPath];
  if (force) args.push("--force");

  jobProc = spawn(process.execPath, args, { stdio: "inherit", env: process.env });
  jobProc.on("exit", (code) => {
    jobProc = null;
    if (code === 0) return;
    console.warn("[dailyPricesScheduler] daily-last-trade exited non-zero", code);
  });

  return true;
}

export async function startDailyPricesScheduler() {
  const staleAfterMs = Number(process.env.PRICES_PATCH_MAX_AGE_MS) || 48 * 60 * 60 * 1000;
  const warmOnStart = process.env.PRICES_WARM_ON_START !== "0";
  const forceOnStart = process.env.PRICES_FORCE_RUN_ON_START === "1";
  const runOnWeekends = process.env.PRICES_RUN_ON_WEEKENDS === "1";

  if (warmOnStart || forceOnStart) {
    const info = summarizePricePatch(PRICE_PATCH_PATH);
    const shouldWarm = forceOnStart || !info.exists || isStale(info.newestAt, staleAfterMs);
    if (shouldWarm) {
      console.info("[dailyPricesScheduler] warming daily prices in background...", { ...info, force: forceOnStart });
      // If the patch is stale, run even on weekends so fresh prices are available after deploys.
      const force = forceOnStart || runOnWeekends || isStale(info.newestAt, staleAfterMs);
      const spawned = spawnDailyLastTradeJob({ force });
      if (!spawned) {
        console.info("[dailyPricesScheduler] daily-last-trade already running; skipping warm start");
      }
    } else {
      console.info("[dailyPricesScheduler] price patch fresh", info);
    }
  }

  const hourUtc = Number(process.env.PRICES_REFRESH_UTC_HOUR) || 3;
  const scheduleNext = () => {
    const next = nextRunAt(hourUtc);
    const delay = Math.max(5_000, next.getTime() - Date.now());
    setTimeout(() => {
      console.info("[dailyPricesScheduler] nightly price refresh started", { at: new Date().toISOString() });
      const spawned = spawnDailyLastTradeJob({ force: runOnWeekends });
      if (!spawned) {
        console.info("[dailyPricesScheduler] daily-last-trade already running; skipping nightly run");
      }
      scheduleNext();
    }, delay);
  };

  scheduleNext();
}
