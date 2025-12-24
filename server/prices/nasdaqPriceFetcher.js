import { fetchText } from "../../worker/lib/http.js";

/**
 * Fetches last sale prices from the public Nasdaq screener API.
 * URL: https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=0&download=true
 */
export async function fetchNasdaqBulkPrices(url) {
    const target = url || "https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=0&download=true";

    console.info("[nasdaqPriceFetcher] downloading from", target);

    // Nasdaq API often requires standard headers
    const text = await fetchText(target);
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
}
