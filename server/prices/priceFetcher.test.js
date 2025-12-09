import assert from "assert/strict";
import { fetchPriceFromPrimarySource, parseYahooQuotePage } from "./priceFetcher.js";

const FIXTURE_HTML = `
<!doctype html><html><head></head><body>
{"context":{"dispatcher":{"stores":{"QuoteSummaryStore":{
  "price":{
    "regularMarketPreviousClose":{"raw":647.95,"fmt":"647.95"},
    "regularMarketTime":{"raw":1733250000,"fmt":"2024-12-04 16:00:00"}
  }
}}}}}
</body></html>
`;

function mockFetchWith(html, status = 200) {
  global.fetch = async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => html
  });
}

async function testParseYahooQuotePage() {
  const parsed = parseYahooQuotePage(FIXTURE_HTML, "META");
  assert.ok(parsed, "should parse payload");
  assert.equal(parsed.ticker, "META");
  assert.equal(parsed.close, 647.95);
  assert.equal(parsed.date, "2024-12-03"); // 1733250000 UTC is 2024-12-03 date slice
}

async function testFetchPriceFromPrimarySource() {
  mockFetchWith(FIXTURE_HTML);
  const price = await fetchPriceFromPrimarySource("META");
  assert.ok(price, "fetch should return price object");
  assert.equal(price.ticker, "META");
  assert.equal(price.close, 647.95);
}

async function run() {
  await testParseYahooQuotePage();
  await testFetchPriceFromPrimarySource();
  console.log("priceFetcher tests passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

