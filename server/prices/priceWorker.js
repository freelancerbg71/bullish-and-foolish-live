import { fetchPriceFromPrimarySource } from "./priceFetcher.js";
import { ensurePriceJobForTicker, getPriceJobStatus, inFlight, queue } from "./priceQueue.js";
import { upsertCachedPrice, getLatestCachedPrice } from "./priceStore.js";

const PRICE_REQUEST_SPACING_MS = 10_000;
const MAX_JUMP_FACTOR = 12; // reject prices that are >12x or <1/12x the last cached

function isPlausiblePrice(newPrice, lastPrice) {
  if (!Number.isFinite(newPrice) || newPrice <= 0) return false;
  if (!Number.isFinite(lastPrice) || lastPrice <= 0) return true;
  const ratio = newPrice / lastPrice;
  return ratio <= MAX_JUMP_FACTOR && ratio >= 1 / MAX_JUMP_FACTOR;
}

async function processNextPriceJob() {
  const ticker = queue.shift();
  if (!ticker) {
    console.debug("[priceWorker] idle, queue empty; retrying in", PRICE_REQUEST_SPACING_MS, "ms");
    setTimeout(processNextPriceJob, PRICE_REQUEST_SPACING_MS);
    return;
  }

  inFlight.set(ticker, "running");
  console.info("[priceWorker] start job", ticker, "queue length", queue.length);

  try {
    const lastCached = await getLatestCachedPrice(ticker);
    const price = await fetchPriceFromPrimarySource(ticker);
    if (price && isPlausiblePrice(price.close, lastCached?.close)) {
      await upsertCachedPrice(price.ticker, price.date, price.close, price.source);
      console.info("[priceWorker] success", ticker, {
        close: price.close,
        date: price.date,
        source: price.source,
        lastCached: lastCached?.close
      });
      inFlight.set(ticker, "done");
    } else if (price) {
      console.warn("[priceWorker] price rejected as implausible", {
        ticker,
        fetched: price.close,
        lastCached: lastCached?.close
      });
      inFlight.set(ticker, "error");
    } else {
      console.warn("[priceWorker] no price returned", ticker);
      inFlight.set(ticker, "error");
    }
  } catch (err) {
    console.error("[priceWorker] error fetching price for", ticker, err);
    inFlight.set(ticker, "error");
  } finally {
    setTimeout(processNextPriceJob, PRICE_REQUEST_SPACING_MS);
  }
}

// Start the loop once at server startup
export function startPriceWorker() {
  console.info("[priceWorker] starting loop with spacing", PRICE_REQUEST_SPACING_MS, "ms");
  setTimeout(processNextPriceJob, PRICE_REQUEST_SPACING_MS);
}

export { ensurePriceJobForTicker, getPriceJobStatus };
