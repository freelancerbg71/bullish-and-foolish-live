import { fetchCompanyFundamentals } from "./edgarFundamentals.js";
import { upsertFundamentals } from "./fundamentalsStore.js";
import { pathToFileURL } from "url";

function usage() {
  console.log("Usage: node server/edgar/refresh_fundamentals.js <TICKER...>");
  console.log("Example: node server/edgar/refresh_fundamentals.js AAPL SOFI MSFT");
}

async function main() {
  const tickers = process.argv.slice(2).filter(Boolean);
  if (!tickers.length) {
    usage();
    process.exit(1);
  }

  for (const raw of tickers) {
    const ticker = String(raw).toUpperCase();
    console.log(`[refresh_fundamentals] fetching ${ticker}...`);
    const periods = await fetchCompanyFundamentals(ticker);
    console.log(`[refresh_fundamentals] upserting ${ticker} periods=${periods.length}`);
    await upsertFundamentals(periods);
    console.log(`[refresh_fundamentals] done ${ticker}`);
  }
}

const invokedAsScript = (() => {
  const argvPath = process.argv[1];
  if (!argvPath) return false;
  try {
    return pathToFileURL(argvPath).href === import.meta.url;
  } catch (_) {
    return false;
  }
})();

if (invokedAsScript) {
  main().catch((err) => {
    console.error("[refresh_fundamentals] failed", err?.stack || err);
    process.exit(1);
  });
}
