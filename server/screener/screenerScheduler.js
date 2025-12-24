import { ensureScreenerSchema, getScreenerDb } from "./screenerStore.js";
import { refreshScreenerIndex } from "./screenerService.js";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");

let refreshProc = null;

function spawnScreenerRefresh({ warmLimit = null } = {}) {
  if (refreshProc && refreshProc.exitCode == null) return false;

  const scriptPath = path.join(ROOT, "scripts", "refresh_screener_index.js");
  const args = [scriptPath];
  if (warmLimit != null) args.push("--warmLimit", String(warmLimit));

  refreshProc = spawn(process.execPath, args, {
    stdio: "inherit",
    env: process.env
  });
  refreshProc.on("exit", (code) => {
    refreshProc = null;
    if (code === 0) return;
    console.warn("[screenerScheduler] refresh process exited non-zero", code);
  });

  return true;
}

function hoursToMs(h) {
  return Number(h) * 60 * 60 * 1000;
}

function nextRunAt(hourUtc = 3) {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(hourUtc, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

async function getIndexStalenessMs() {
  const db = await getScreenerDb();
  const row = db.prepare("SELECT MAX(updatedAt) as updatedAt, COUNT(*) as n FROM screener_index").get();
  const count = Number(row?.n || 0);
  const ts = Date.parse(row?.updatedAt || "");
  return {
    count,
    newestAt: row?.updatedAt || null,
    ageMs: Number.isFinite(ts) ? Date.now() - ts : null
  };
}

export async function startScreenerScheduler() {
  await ensureScreenerSchema();
  const warmOnStart = process.env.SCREENER_WARM_ON_START === "1";
  const nightlyEnabled = process.env.SCREENER_NIGHTLY_REFRESH_ENABLED === "1";
  const intervalHours = Number(process.env.SCREENER_REFRESH_INTERVAL_HOURS) || 24;
  const staleAfterMs = hoursToMs(intervalHours);

  try {
    const staleness = await getIndexStalenessMs();
    const shouldWarm =
      warmOnStart &&
      (staleness.count === 0 ||
        (Number.isFinite(staleness.ageMs) && staleness.ageMs > staleAfterMs));
    if (shouldWarm) {
      const warmLimit = Number(process.env.SCREENER_WARM_LIMIT) || 200;
      console.info("[screenerScheduler] refreshing screener index in background...", {
        mode: warmLimit > 0 ? "warm" : "full",
        warmLimit,
        tickers: warmLimit > 0 ? warmLimit : null
      });
      const spawned = spawnScreenerRefresh({ warmLimit: warmLimit > 0 ? warmLimit : null });
      if (!spawned) {
        console.info("[screenerScheduler] refresh already running; skipping warm start");
      }
    } else {
      console.info("[screenerScheduler] screener index fresh", {
        count: staleness.count,
        newestAt: staleness.newestAt
      });
    }
  } catch (err) {
    console.warn("[screenerScheduler] initial check failed", err?.message || err);
  }

  if (!nightlyEnabled) {
    console.info("[screenerScheduler] nightly refresh disabled (set SCREENER_NIGHTLY_REFRESH_ENABLED=1 to enable)");
    return;
  }

  const hourUtc = Number(process.env.SCREENER_REFRESH_UTC_HOUR) || 3;
  const scheduleNext = () => {
    const next = nextRunAt(hourUtc);
    const delay = Math.max(5_000, next.getTime() - Date.now());
    setTimeout(() => {
      console.info("[screenerScheduler] nightly refresh started", { at: new Date().toISOString() });
      const spawned = spawnScreenerRefresh();
      if (!spawned) {
        console.info("[screenerScheduler] refresh already running; skipping nightly run");
      }
      scheduleNext();
    }, delay);
  };
  scheduleNext();
}
