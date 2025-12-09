const YAHOO_QUOTE_SUMMARY_BASE = "https://query1.finance.yahoo.com/v10/finance/quoteSummary/";
const DEFAULT_HEADERS = { "User-Agent": "stocks-tools/0.1 (+short-interest)" };

function normalizeTicker(ticker) {
  return ticker ? String(ticker).trim().toUpperCase() : "";
}

function pickNumber(...vals) {
  for (const v of vals) {
    const num = Number(v);
    if (Number.isFinite(num)) return num;
  }
  return null;
}

/**
 * Fetch short interest metrics from Yahoo Finance quoteSummary.
 * Returns null if nothing useful is found.
 */
export async function fetchShortInterest(ticker) {
  const symbol = normalizeTicker(ticker);
  if (!symbol) return null;
  const variants = [symbol];
  if (symbol.includes("-")) variants.push(symbol.replace("-", "."));
  if (symbol.includes(".")) variants.push(symbol.replace(".", "-"));

  for (const variant of variants) {
    const url = `${YAHOO_QUOTE_SUMMARY_BASE}${encodeURIComponent(
      variant
    )}?modules=defaultKeyStatistics%2CsummaryDetail`;
    try {
      const res = await fetch(url, { headers: DEFAULT_HEADERS });
      if (!res.ok) {
        console.warn("[shortInterestFetcher] yahoo short fetch failed", res.status, variant);
        continue;
      }
      const body = await res.json();
      const payload = body?.quoteSummary?.result?.[0];
      if (!payload) continue;
      const ks = payload.defaultKeyStatistics || {};
      const sd = payload.summaryDetail || {};
      const shortPercentFloat = pickNumber(
        ks.shortPercentOfFloat?.raw,
        sd.shortPercentOfFloat?.raw,
        ks.sharesPercentSharesOut?.raw
      );
      const sharesShort = pickNumber(ks.sharesShort?.raw, sd.sharesShort?.raw);
      const sharesShortPrev = pickNumber(ks.sharesShortPriorMonth?.raw, sd.sharesShortPriorMonth?.raw);
      const floatShares = pickNumber(ks.floatShares?.raw, sd.floatShares?.raw);
      const shortRatio = pickNumber(ks.shortRatio?.raw, sd.shortRatio?.raw);
      const avgVolume10Day = pickNumber(sd.averageDailyVolume10Day?.raw, sd.averageDailyVolume10Day?.fmt);
      const avgVolume30Day = pickNumber(sd.averageDailyVolume3Month?.raw, sd.averageDailyVolume3Month?.fmt);

      const daysToCover = shortRatio ?? (sharesShort && avgVolume10Day ? sharesShort / avgVolume10Day : null);

      return {
        shortPercentFloat,
        sharesShort,
        sharesShortPrev,
        floatShares,
        shortRatio: daysToCover,
        daysToCover,
        avgVolume10Day,
        avgVolume30Day
      };
    } catch (err) {
      console.error("[shortInterestFetcher] error fetching yahoo short interest for", variant, err);
    }
  }
  return null;
}
