import { fetchText } from "../../worker/lib/http.js";

/**
 * Fetches last sale prices from the public Nasdaq screener API.
 * URL: https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=0&download=true
 * 
 * Includes retry logic for Railway environment where network can be flaky during boot.
 */
export async function fetchNasdaqBulkPrices(url, { maxRetries = 3, timeoutMs = 90000 } = {}) {
    const target = url || "https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=0&download=true";

    console.info("[nasdaqPriceFetcher] downloading from", target);

    let lastError = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.info("[nasdaqPriceFetcher] attempt", attempt, "of", maxRetries);
            const text = await fetchText(target, { timeoutMs });
            const json = JSON.parse(text);

            const rows = json?.data?.rows || [];
            const map = new Map();

            for (const r of rows) {
                const symbol = String(r.symbol || "").trim().toUpperCase();
                if (!symbol) continue;

                // Last sale often looks like "$137.24"
                const priceRaw = String(r.lastsale || "").replace(/[$,]/g, "");
                const price = Number(priceRaw);

                if (Number.isFinite(price) && price > 0) {
                    map.set(symbol, {
                        ticker: symbol,
                        price,
                        source: "NASDAQ-Public"
                    });
                }
            }

            console.info("[nasdaqPriceFetcher] parsed", map.size, "prices");
            return map;
        } catch (err) {
            lastError = err;
            console.warn("[nasdaqPriceFetcher] attempt", attempt, "failed:", err.message);
            if (attempt < maxRetries) {
                const backoffMs = Math.min(5000 * attempt, 15000);
                console.info("[nasdaqPriceFetcher] retrying in", backoffMs, "ms...");
                await new Promise(r => setTimeout(r, backoffMs));
            }
        }
    }

    throw lastError || new Error("Failed to fetch NASDAQ prices after retries");
}
