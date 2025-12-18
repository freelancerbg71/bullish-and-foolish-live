import assert from "assert/strict";

function mockFetchStooqCsv(csv, status = 200) {
  global.fetch = async (url) => {
    const u = String(url);
    // This test forces PRICE_PRIMARY_SOURCE=stooq and should only touch Stooq.
    if (u.startsWith("https://stooq.com/q/d/l/?i=d&s=")) {
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => csv,
        headers: { get: () => null }
      };
    }
    return {
      ok: false,
      status: 500,
      text: async () => "unexpected url",
      headers: { get: () => null }
    };
  };
}

async function testFetchPriceFromPrimarySource_stooq() {
  process.env.PRICE_PRIMARY_SOURCE = "stooq";
  process.env.PRICE_ALLOW_FALLBACK = "0";

  const csv = [
    "Date,Open,High,Low,Close,Volume",
    "2025-12-16,635.0,650.0,630.0,645.12,123",
    "2025-12-17,645.0,660.0,640.0,659.58,456"
  ].join("\n");

  mockFetchStooqCsv(csv);

  // Dynamic import so env vars are read during module evaluation.
  const { fetchPriceFromPrimarySource } = await import("./priceFetcher.js");
  const price = await fetchPriceFromPrimarySource("META");
  assert.ok(price, "fetch should return price object");
  assert.equal(price.ticker, "META");
  assert.equal(price.close, 659.58);
  assert.equal(price.date, "2025-12-17");
  assert.equal(price.source, "stooq-csv");
  assert.ok(Array.isArray(price.priceSeries) && price.priceSeries.length === 2, "should include price series");
}

async function run() {
  await testFetchPriceFromPrimarySource_stooq();
  console.log("priceFetcher tests passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
