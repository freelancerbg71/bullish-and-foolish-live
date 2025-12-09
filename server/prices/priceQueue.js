const inFlight = new Map();
const queue = [];

function normalizeTicker(ticker) {
  return ticker ? String(ticker).trim().toUpperCase() : "";
}

/**
 * Ensure only one job per ticker is queued/running at a time.
 * @returns {'queued' | 'running' | 'done' | 'error'}
 */
export function ensurePriceJobForTicker(ticker) {
  const key = normalizeTicker(ticker);
  if (!key) throw new Error("ticker is required for price job");
  const existing = inFlight.get(key);
  if (existing === "queued" || existing === "running") {
    console.debug("[priceQueue] skip enqueue, already", existing, key);
    return existing;
  }
  queue.push(key);
  inFlight.set(key, "queued");
  console.info("[priceQueue] enqueued", key, "queue length", queue.length);
  return "queued";
}

/**
 * @returns {'queued' | 'running' | 'done' | 'error' | null}
 */
export function getPriceJobStatus(ticker) {
  const key = normalizeTicker(ticker);
  if (!key) return null;
  return inFlight.get(key) || null;
}

export { inFlight, queue };
