import { refreshScreenerIndex } from "../server/screener/screenerService.js";
import { getDb } from "../server/edgar/fundamentalsStore.js";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

async function resolveWarmTickers(limit) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return null;
  const db = await getDb();
  const rows = db
    .prepare("SELECT DISTINCT ticker FROM fundamentals ORDER BY ticker ASC LIMIT @limit")
    .all({ limit: Math.trunc(n) });
  return rows.map((r) => r.ticker).filter(Boolean);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const warmLimit = args.warmLimit ?? null;

  const tickers = await resolveWarmTickers(warmLimit);
  const mode = tickers ? "warm" : "full";
  console.info("[refresh_screener_index] starting", { mode, tickers: tickers ? tickers.length : null });
  const allowFilingScan = process.env.SCREENER_INCLUDE_FILINGS === "1";
  const res = await refreshScreenerIndex({ tickers, allowFilingScan });
  console.info("[refresh_screener_index] complete", res);
}

main().catch((err) => {
  console.error("[refresh_screener_index] failed", err?.stack || err);
  process.exit(1);
});
