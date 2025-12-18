const YAHOO_QUOTE_JSON_BASE = "https://query2.finance.yahoo.com/v7/finance/quote?symbols=";
const YAHOO_CHART_BASE = "https://query2.finance.yahoo.com/v8/finance/chart/";
const DEFAULT_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
  "Accept": "*/*",
  "Origin": "https://finance.yahoo.com",
  "Referer": "https://finance.yahoo.com"
};

function normalizeTicker(ticker) {
  return ticker ? String(ticker).trim().toUpperCase() : "";
}

async function fetchYahooQuoteJson(ticker) {
  const symbol = normalizeTicker(ticker);
  if (!symbol) return null;
  const variants = [symbol];
  if (symbol.includes("-")) variants.push(symbol.replace("-", "."));
  if (symbol.includes(".")) variants.push(symbol.replace(".", "-"));

  for (const variant of variants) {
    const url = `${YAHOO_QUOTE_JSON_BASE}${encodeURIComponent(variant)}`;
    try {
      const res = await fetch(url, { headers: DEFAULT_HEADERS });
      if (!res.ok) {
        console.warn("[priceFetcher] yahoo JSON fetch failed", res.status, variant);
        continue;
      }
      const body = await res.json();
      const result = body?.quoteResponse?.result?.[0];
      const price = Number(result?.regularMarketPreviousClose);
      const ts = Number(result?.regularMarketTime);
      const marketCap = Number(result?.marketCap);
      const currency = result?.currency;

      if (!Number.isFinite(price)) {
        console.warn("[priceFetcher] yahoo JSON missing price", variant);
        continue;
      }
      const date = Number.isFinite(ts)
        ? new Date(ts * 1000).toISOString().slice(0, 10)
        : new Date().toISOString().slice(0, 10);

      console.info("[priceFetcher] yahoo JSON parsed", { ticker: symbol, close: price, marketCap, currency });
      return {
        ticker: symbol,
        date,
        close: price,
        marketCap: Number.isFinite(marketCap) ? marketCap : null,
        currency,
        source: "yahoo-json"
      };
    } catch (err) {
      console.error("[priceFetcher] error fetching yahoo JSON for", variant, err);
    }
  }
  return null;
}

async function fetchYahooChart(ticker) {
  const symbol = normalizeTicker(ticker);
  if (!symbol) return null;
  const variants = [symbol];
  if (symbol.includes("-")) variants.push(symbol.replace("-", "."));
  if (symbol.includes(".")) variants.push(symbol.replace(".", "-"));

  for (const variant of variants) {
    // Extended range to 2y for 52w high/low calculation
    const url = `${YAHOO_CHART_BASE}${encodeURIComponent(variant)}?range=2y&interval=1d`;
    try {
      const res = await fetch(url, { headers: DEFAULT_HEADERS });
      if (!res.ok) {
        console.warn("[priceFetcher] yahoo chart fetch failed", res.status, variant);
        continue;
      }
      const body = await res.json();
      const result = body?.chart?.result?.[0];
      const meta = result?.meta || {};
      const quotes = result?.indicators?.quote?.[0];
      const closes = Array.isArray(quotes?.close) ? quotes.close : [];
      const timestamps = Array.isArray(result?.timestamp) ? result.timestamp : [];

      let close = null;
      let ts = null;
      const history = [];

      for (let i = 0; i < closes.length; i++) {
        const val = Number(closes[i]);
        const t = timestamps[i];
        if (Number.isFinite(val) && t) {
          history.push({
            date: new Date(t * 1000).toISOString().slice(0, 10),
            close: val
          });
          close = val;
          ts = t;
        }
      }

      if (!Number.isFinite(close) || close <= 0) {
        console.warn("[priceFetcher] yahoo chart missing/zero close", variant);
        continue;
      }

      const date = new Date(ts * 1000).toISOString().slice(0, 10);
      const currency = meta.currency; // Currency often in meta

      return {
        ticker: symbol,
        date,
        close,
        history,
        currency,
        source: "yfinance-chart"
      };
    } catch (err) {
      console.error("[priceFetcher] error fetching yahoo chart for", variant, err);
    }
  }
  return null;
}

/**
 * Fetch last close using Yahoo endpoints.
 * Merges Quote (Market Cap, Currency) with Chart (History).
 */
export async function fetchPriceFromPrimarySource(ticker) {
  // Parallel fetch request
  const [chartResult, quoteResult] = await Promise.all([
    fetchYahooChart(ticker).catch(e => null),
    fetchYahooQuoteJson(ticker).catch(e => null)
  ]);

  if (!chartResult && !quoteResult) return null;

  // Combine data
  // Quote is master for Snapshot (Close, Mcap, Currency)
  // Chart is master for History
  const combined = {
    ticker: normalizeTicker(ticker),
    date: quoteResult?.date || chartResult?.date,
    close: quoteResult?.close ?? chartResult?.close,
    marketCap: quoteResult?.marketCap ?? null,
    currency: quoteResult?.currency || chartResult?.currency,
    source: chartResult ? "yfinance-chart+json" : "yahoo-json",
    priceSeries: chartResult?.history || (quoteResult ? [{ date: quoteResult.date, close: quoteResult.close }] : [])
  };

  return combined;
}
