const YAHOO_QUOTE_JSON_BASE = "https://query2.finance.yahoo.com/v7/finance/quote?symbols=";
const YAHOO_CHART_BASE = "https://query2.finance.yahoo.com/v8/finance/chart/";
const YAHOO_COOKIE_URL = "https://fc.yahoo.com";
const YAHOO_CRUMB_URL = "https://query1.finance.yahoo.com/v1/test/getcrumb";
const STOOQ_DAILY_CSV_BASE = "https://stooq.com/q/d/l/?i=d&s=";
const DEFAULT_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
  "Accept": "*/*",
  "Origin": "https://finance.yahoo.com",
  "Referer": "https://finance.yahoo.com"
};

const PRICE_PRIMARY_SOURCE = String(process.env.PRICE_PRIMARY_SOURCE || "yahoo").toLowerCase(); // yahoo|stooq
const PRICE_ALLOW_FALLBACK = String(process.env.PRICE_ALLOW_FALLBACK || "1") !== "0";
const YAHOO_BLOCK_COOLDOWN_MS = Number(process.env.YAHOO_BLOCK_COOLDOWN_MS) || 6 * 60 * 60 * 1000; // 6h
const YAHOO_SESSION_TTL_MS = Number(process.env.YAHOO_SESSION_TTL_MS) || 12 * 60 * 60 * 1000; // 12h

let yahooSessionCache = null; // { cookieHeader, crumb, fetchedAt }
let yahooBlockedUntilTs = 0;

function normalizeTicker(ticker) {
  return ticker ? String(ticker).trim().toUpperCase() : "";
}

function isYahooBlocked() {
  return Number.isFinite(yahooBlockedUntilTs) && Date.now() < yahooBlockedUntilTs;
}

function noteYahooBlocked(status, variant) {
  if (status !== 401) return;
  yahooBlockedUntilTs = Date.now() + YAHOO_BLOCK_COOLDOWN_MS;
  console.warn("[priceFetcher] yahoo blocked (401); disabling yahoo fetch temporarily", {
    until: new Date(yahooBlockedUntilTs).toISOString(),
    variant
  });
}

function parseSetCookieHeaders(setCookieHeaders = []) {
  const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders].filter(Boolean);
  const parts = [];
  for (const line of headers) {
    // take "NAME=VALUE" portion
    const first = String(line).split(";")[0]?.trim();
    if (!first) continue;
    parts.push(first);
  }
  return parts.length ? parts.join("; ") : null;
}

function extractSetCookie(res) {
  try {
    if (!res?.headers?.get) return null;
    // Node's fetch supports getSetCookie() (undici). If absent, fall back to single header.
    if (typeof res.headers.getSetCookie === "function") {
      const all = res.headers.getSetCookie();
      return parseSetCookieHeaders(all);
    }
    const single = res.headers.get("set-cookie");
    return parseSetCookieHeaders(single ? [single] : []);
  } catch (_) {
    return null;
  }
}

async function getYahooSession({ timeoutMs = 12_000 } = {}) {
  if (isYahooBlocked()) return null;

  const cached = yahooSessionCache;
  const age = cached?.fetchedAt ? Date.now() - cached.fetchedAt : Infinity;
  if (cached?.cookieHeader && cached?.crumb && Number.isFinite(age) && age < YAHOO_SESSION_TTL_MS) {
    return cached;
  }

  // This intentionally mimics yfinance's "basic" cookie+crumb flow:
  // 1) GET https://fc.yahoo.com to obtain a session cookie
  // 2) GET https://query1.finance.yahoo.com/v1/test/getcrumb with that cookie
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const cookieRes = await fetch(YAHOO_COOKIE_URL, {
      headers: { "User-Agent": DEFAULT_HEADERS["User-Agent"], "Accept": DEFAULT_HEADERS["Accept"] },
      redirect: "follow",
      signal: controller.signal
    });
    if (!cookieRes.ok) {
      console.warn("[priceFetcher] yahoo cookie fetch failed", cookieRes.status);
      noteYahooBlocked(cookieRes.status, "cookie");
      return null;
    }

    const cookieHeader = extractSetCookie(cookieRes);
    if (!cookieHeader) {
      console.warn("[priceFetcher] yahoo cookie missing set-cookie");
      return null;
    }

    const crumbRes = await fetch(YAHOO_CRUMB_URL, {
      headers: { "User-Agent": DEFAULT_HEADERS["User-Agent"], "Accept": "text/plain,*/*", "Cookie": cookieHeader },
      redirect: "follow",
      signal: controller.signal
    });
    if (!crumbRes.ok) {
      console.warn("[priceFetcher] yahoo crumb fetch failed", crumbRes.status);
      noteYahooBlocked(crumbRes.status, "crumb");
      return null;
    }
    const crumb = (await crumbRes.text())?.trim();
    if (!crumb) {
      console.warn("[priceFetcher] yahoo crumb missing");
      return null;
    }

    yahooSessionCache = { cookieHeader, crumb, fetchedAt: Date.now() };
    return yahooSessionCache;
  } catch (err) {
    console.error("[priceFetcher] yahoo session init failed", err?.message || err);
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function fetchYahooQuoteJson(ticker) {
  if (isYahooBlocked()) return null;
  const symbol = normalizeTicker(ticker);
  if (!symbol) return null;
  const variants = [symbol];
  if (symbol.includes("-")) variants.push(symbol.replace("-", "."));
  if (symbol.includes(".")) variants.push(symbol.replace(".", "-"));

  const session = await getYahooSession();
  if (!session) return null;
  const cookieHeader = session.cookieHeader;
  const crumb = session.crumb;

  for (const variant of variants) {
    const url = `${YAHOO_QUOTE_JSON_BASE}${encodeURIComponent(variant)}&crumb=${encodeURIComponent(crumb)}`;
    try {
      const res = await fetch(url, { headers: { ...DEFAULT_HEADERS, Cookie: cookieHeader } });
      if (!res.ok) {
        console.warn("[priceFetcher] yahoo JSON fetch failed", res.status, variant);
        noteYahooBlocked(res.status, variant);
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
        source: "yahoo-yfinance"
      };
    } catch (err) {
      console.error("[priceFetcher] error fetching yahoo JSON for", variant, err);
    }
  }
  return null;
}

async function fetchYahooChart(ticker) {
  if (isYahooBlocked()) return null;
  const symbol = normalizeTicker(ticker);
  if (!symbol) return null;
  const variants = [symbol];
  if (symbol.includes("-")) variants.push(symbol.replace("-", "."));
  if (symbol.includes(".")) variants.push(symbol.replace(".", "-"));

  const session = await getYahooSession();
  if (!session) return null;
  const cookieHeader = session.cookieHeader;
  const crumb = session.crumb;

  for (const variant of variants) {
    // Extended range to 2y for 52w high/low calculation
    const url = `${YAHOO_CHART_BASE}${encodeURIComponent(variant)}?range=2y&interval=1d&crumb=${encodeURIComponent(crumb)}`;
    try {
      const res = await fetch(url, { headers: { ...DEFAULT_HEADERS, Cookie: cookieHeader } });
      if (!res.ok) {
        console.warn("[priceFetcher] yahoo chart fetch failed", res.status, variant);
        noteYahooBlocked(res.status, variant);
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
        source: "yahoo-yfinance"
      };
    } catch (err) {
      console.error("[priceFetcher] error fetching yahoo chart for", variant, err);
    }
  }
  return null;
}

function stooqVariants(symbol) {
  const s = normalizeTicker(symbol);
  if (!s) return [];
  const base = s.toLowerCase();
  const variants = new Set();

  // Stooq typically uses ".us" for US equities: aapl.us, meta.us, brk.b.us
  const baseVariants = [base];
  if (base.includes("-")) baseVariants.push(base.replace("-", "."));
  if (base.includes(".")) baseVariants.push(base.replace(".", "-"));

  for (const v of baseVariants) {
    variants.add(`${v}.us`);
    variants.add(v);
  }

  return [...variants];
}

async function fetchStooqDailyCsv(ticker) {
  const symbol = normalizeTicker(ticker);
  if (!symbol) return null;
  const variants = stooqVariants(symbol);

  for (const variant of variants) {
    const url = `${STOOQ_DAILY_CSV_BASE}${encodeURIComponent(variant)}`;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": DEFAULT_HEADERS["User-Agent"], "Accept": "text/csv,*/*" }
      });
      if (!res.ok) {
        console.warn("[priceFetcher] stooq CSV fetch failed", res.status, variant);
        continue;
      }
      const text = await res.text();
      const lines = String(text || "")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);

      // Sometimes returns "404 Not Found" body with 200 status.
      if (!lines.length || lines[0].toLowerCase().includes("not found")) continue;

      // Header: Date,Open,High,Low,Close,Volume
      const rows = lines.slice(1);
      const history = [];
      for (const row of rows) {
        const parts = row.split(",");
        if (parts.length < 5) continue;
        const date = parts[0];
        const close = Number(parts[4]);
        if (!date || !Number.isFinite(close) || close <= 0) continue;
        history.push({ date, close });
      }
      if (!history.length) continue;

      const last = history[history.length - 1];
      return {
        ticker: symbol,
        date: last.date,
        close: last.close,
        priceSeries: history,
        source: "stooq-csv"
      };
    } catch (err) {
      console.error("[priceFetcher] error fetching stooq CSV for", variant, err);
    }
  }

  return null;
}

/**
 * Fetch last close using Yahoo endpoints.
 * Merges Quote (Market Cap, Currency) with Chart (History).
 */
export async function fetchPriceFromPrimarySource(ticker) {
  const fetchYahoo = async () => {
    const [chartResult, quoteResult] = await Promise.all([
      fetchYahooChart(ticker).catch(() => null),
      fetchYahooQuoteJson(ticker).catch(() => null)
    ]);
    return { chartResult, quoteResult };
  };

  let chartResult = null;
  let quoteResult = null;
  let stooqResult = null;

  if (PRICE_PRIMARY_SOURCE === "stooq") {
    stooqResult = await fetchStooqDailyCsv(ticker).catch(() => null);
  } else {
    ({ chartResult, quoteResult } = await fetchYahoo());
  }

  if (PRICE_ALLOW_FALLBACK) {
    const yahooFailed = !chartResult && !quoteResult;
    if ((PRICE_PRIMARY_SOURCE === "yahoo" && (yahooFailed || isYahooBlocked())) && !stooqResult) {
      stooqResult = await fetchStooqDailyCsv(ticker).catch(() => null);
    }
    if (PRICE_PRIMARY_SOURCE === "stooq" && !stooqResult && !isYahooBlocked()) {
      ({ chartResult, quoteResult } = await fetchYahoo());
    }
  }

  if (!chartResult && !quoteResult && !stooqResult) return null;

  // Combine data
  // Quote is master for Snapshot (Close, Mcap, Currency)
  // Chart is master for History
  if (stooqResult && !chartResult && !quoteResult) {
    return {
      ticker: normalizeTicker(ticker),
      date: stooqResult.date,
      close: stooqResult.close,
      marketCap: null,
      currency: null,
      source: stooqResult.source,
      priceSeries: stooqResult.priceSeries || [{ date: stooqResult.date, close: stooqResult.close }]
    };
  }

  const combined = {
    ticker: normalizeTicker(ticker),
    date: quoteResult?.date || chartResult?.date,
    close: quoteResult?.close ?? chartResult?.close,
    marketCap: quoteResult?.marketCap ?? null,
    currency: quoteResult?.currency || chartResult?.currency,
    source: chartResult ? "yahoo-yfinance" : "yahoo-yfinance",
    priceSeries: chartResult?.history || (quoteResult ? [{ date: quoteResult.date, close: quoteResult.close }] : [])
  };

  return combined;
}
