import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "data", "edgar");
const OUT_FILE = path.join(OUT_DIR, "company_tickers_exchange.json");
const SRC_URL = process.env.DIRECTORY_URL || "https://www.sec.gov/files/company_tickers_exchange.json";
const USER_AGENT =
  process.env.EDGAR_USER_AGENT ||
  process.env.DATA_USER_AGENT ||
  "stocks-tools/0.1 (+refresh-directory)";

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Fetch failed ${res.status}: ${text || res.statusText}`);
  }
  return res.json();
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log("[refreshDirectory] downloading", SRC_URL);
  const data = await fetchJson(SRC_URL);
  if (!data?.data?.length) {
    throw new Error("Downloaded directory missing data");
  }
  fs.writeFileSync(OUT_FILE, JSON.stringify(data, null, 2));
  console.log("[refreshDirectory] wrote", OUT_FILE, "rows", data.data.length);
}

main().catch((err) => {
  console.error("[refreshDirectory] failed", err?.message || err);
  process.exit(1);
});
