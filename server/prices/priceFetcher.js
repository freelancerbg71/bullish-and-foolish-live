const YAHOO_QUOTE_JSON_BASE = "https://query1.finance.yahoo.com/v7/finance/quote?symbols=";
const YAHOO_CHART_BASE = "https://query1.finance.yahoo.com/v8/finance/chart/";
const DEFAULT_HEADERS = { "User-Agent": "stocks-tools/0.1 (+price-fetcher)" };

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
      if (!Number.isFinite(price)) {
        console.warn("[priceFetcher] yahoo JSON missing price", variant);
        continue;
      }
      const date = Number.isFinite(ts)
        ? new Date(ts * 1000).toISOString().slice(0, 10)
        : new Date().toISOString().slice(0, 10);
      console.info("[priceFetcher] yahoo JSON price parsed", { ticker: symbol, variant, close: price, date });
      return { ticker: symbol, date, close: price, source: "yahoo-json" };
    } catch (err) {
      console.error("[priceFetcher] error fetching yahoo JSON for", variant, err);
    }
  }
  return null;
}

/**
 * Fetch via the Yahoo Finance chart endpoint (same backing API yfinance uses).
 * Pulls the most recent close from the returned candles.
 */
async function fetchYahooChart(ticker) {
  const symbol = normalizeTicker(ticker);
  if (!symbol) return null;
  const variants = [symbol];
  if (symbol.includes("-")) variants.push(symbol.replace("-", "."));
  if (symbol.includes(".")) variants.push(symbol.replace(".", "-"));

  for (const variant of variants) {
    const url = `${YAHOO_CHART_BASE}${encodeURIComponent(variant)}?range=5d&interval=1d`;
    try {
      const res = await fetch(url, { headers: DEFAULT_HEADERS });
      if (!res.ok) {
        console.warn("[priceFetcher] yahoo chart fetch failed", res.status, variant);
        continue;
      }
      const body = await res.json();
      const result = body?.chart?.result?.[0];
      const quotes = result?.indicators?.quote?.[0];
      const closes = Array.isArray(quotes?.close) ? quotes.close : [];
      const timestamps = Array.isArray(result?.timestamp) ? result.timestamp : [];
      // pick the last non-null close
      let close = null;
      let ts = null;
      for (let i = closes.length - 1; i >= 0; i--) {
        const val = Number(closes[i]);
        if (Number.isFinite(val)) {
          close = val;
          ts = timestamps[i] ? Number(timestamps[i]) * 1000 : Date.now();
          break;
        }
      }
      if (!Number.isFinite(close)) {
        console.warn("[priceFetcher] yahoo chart missing close", variant);
        continue;
      }
      const date = new Date(ts || Date.now()).toISOString().slice(0, 10);
      console.info("[priceFetcher] yahoo chart price parsed", { ticker: symbol, variant, close, date });
      return { ticker: symbol, date, close, source: "yfinance-chart" };
    } catch (err) {
      console.error("[priceFetcher] error fetching yahoo chart for", variant, err);
    }
  }
  return null;
}

/**
 * Fetch last close using Yahoo endpoints (chart first, quote JSON as backup).
 */
export async function fetchPriceFromPrimarySource(ticker) {
  const chartQuote = await fetchYahooChart(ticker);
  if (chartQuote) return chartQuote;
  const jsonQuote = await fetchYahooQuoteJson(ticker);
  if (jsonQuote) return jsonQuote;
  return null;
}
