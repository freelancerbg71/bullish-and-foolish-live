import fs from "fs";
import os from "os";
import path from "path";
import assert from "assert/strict";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prices-store-"));
process.env.PRICES_DB_FILE = path.join(tmpDir, "prices.db");

const { upsertCachedPrice, getRecentPrices } = await import("./priceStore.js");

async function testKeepsHistoryForChart() {
  await upsertCachedPrice("TEST", "2024-12-01", 10, "yahoo");
  await upsertCachedPrice("TEST", "2024-12-02", 11, "yahoo");
  await upsertCachedPrice("TEST", "2024-12-03", 12, "yahoo");

  const rows = await getRecentPrices("TEST", 3);
  assert.equal(rows.length, 3, "should keep recent history rows");
  assert.deepEqual(
    rows.map((r) => r.date),
    ["2024-12-03", "2024-12-02", "2024-12-01"],
    "keeps newest dates"
  );
  assert.equal(rows[0].close, 12);
  assert.equal(rows[1].close, 11);
}

async function run() {
  await testKeepsHistoryForChart();
  console.log("priceStore tests passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
