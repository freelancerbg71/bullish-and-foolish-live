import { ensurePriceJobForTicker, getPriceJobStatus } from "./priceQueue.js";
import { getLatestCachedPrice, getRecentPrices } from "./priceStore.js";

const FRESHNESS_WINDOW_HOURS = 24;
const inflightPrice = new Map();

function hoursToMs(hours) {
  return Number(hours) * 60 * 60 * 1000;
}

function isFresh(updatedAt, hours = FRESHNESS_WINDOW_HOURS) {
  if (!updatedAt) return false;
  const ts = Date.parse(updatedAt);
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts < hoursToMs(hours);
}

export async function getOrFetchLatestPrice(ticker) {
  if (!ticker) return { state: "error", priceSeries: null };
  const key = String(ticker).toUpperCase();
  if (inflightPrice.has(key)) return inflightPrice.get(key);

  const run = (async () => {
    const recent = await getRecentPrices(key, 2);
    const latest = recent[0] || (await getLatestCachedPrice(key));
    if (latest && isFresh(latest.updatedAt, FRESHNESS_WINDOW_HOURS)) {
      const series = recent.length ? recent : [latest];
      return {
        state: "ready",
        marketCap: latest.marketCap || null,
        currency: latest.currency || null,
        priceSeries: series.map((p) => ({ ticker: p.ticker, date: p.date, close: p.close }))
      };
    }

    let status = "queued";
    try {
      status = ensurePriceJobForTicker(key);
      console.info("[priceService] enqueued price job", key, "status", status, "latestCachedAt", latest?.updatedAt);
    } catch (err) {
      console.warn("[priceService] failed to enqueue price job", err?.message || err);
      return { state: "error", price: null };
    }

    if (status === "error") {
      return { state: "error", priceSeries: null };
    }

    return { state: "pending", priceSeries: null };
  })();

  inflightPrice.set(key, run);
  try {
    return await run;
  } finally {
    inflightPrice.delete(key);
  }
}

export { isFresh, getPriceJobStatus, FRESHNESS_WINDOW_HOURS };
