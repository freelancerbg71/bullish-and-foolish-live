import { fetchCompanyFundamentals } from "../server/edgar/edgarFundamentals.js";
import { upsertFundamentals } from "../server/edgar/fundamentalsStore.js";

const TICKERS = ["META", "AAPL", "MSFT"];
const BETWEEN_DELAY_MS = Number(process.env.EDGAR_INGEST_DELAY_MS) || 400;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  for (const ticker of TICKERS) {
    try {
      console.log(`Fetching ${ticker} fundamentals...`);
      const periods = await fetchCompanyFundamentals(ticker);
      await upsertFundamentals(periods);
      console.log(`${ticker}: upserted ${periods.length} periods`);
    } catch (err) {
      console.error(`${ticker}: failed -> ${err.message}`);
    }
    await sleep(BETWEEN_DELAY_MS);
  }
}

main().catch((err) => {
  console.error("Ingestion failed", err);
  process.exit(1);
});
