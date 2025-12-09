import fs from "fs";
import path from "path";

const CIK = "0001326801"; // META PLATFORMS INC.
const TICKER = "META";
const SEC_BASE = process.env.EDGAR_BASE || process.env.DATA_API_BASE || "https://data.sec.gov";
const USER_AGENT =
  process.env.EDGAR_USER_AGENT ||
  process.env.DATA_USER_AGENT ||
  process.env.SEC_EDGAR_TOOLKIT_USER_AGENT ||
  "BullishAndFoolishBot/0.1 (contact: myemail@example.com)";

const OUT_DIR = path.join(process.cwd(), "data", "edgar");
const OUT_FILE = path.join(OUT_DIR, "meta-companyfacts-raw.json");

const LIMIT_TAGS_PRINT = 50;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Request failed ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

function collectFactsSummary(factsRoot) {
  const summaries = [];
  const taxonomies = Object.keys(factsRoot || {});
  for (const tax of taxonomies) {
    const tags = factsRoot[tax] || {};
    for (const [tag, payload] of Object.entries(tags)) {
      const units = payload.units || {};
      let count = 0;
      const samples = [];
      for (const [unitName, entries] of Object.entries(units)) {
        if (!Array.isArray(entries)) continue;
        count += entries.length;
        const sorted = [...entries].sort((a, b) => Date.parse(b.end || "") - Date.parse(a.end || ""));
        if (sorted.length) {
          const ex = sorted[0];
          samples.push({
            unit: unitName,
            end: ex.end,
            value: ex.val ?? ex.value,
            filed: ex.filed
          });
        }
      }
      summaries.push({
        tag: `${tax}:${tag}`,
        count,
        sample: samples[0] || null
      });
    }
  }
  summaries.sort((a, b) => b.count - a.count);
  return summaries;
}

async function main() {
  const url = `${SEC_BASE}/api/xbrl/companyfacts/CIK${CIK}.json`;
  console.log(`Fetching companyfacts for ${TICKER} from ${url}`);
  const facts = await fetchJson(url);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(facts, null, 2), "utf8");
  console.log(`Saved raw facts to ${OUT_FILE}`);

  const summaries = collectFactsSummary(facts?.facts);
  console.log(`\nTop ${Math.min(LIMIT_TAGS_PRINT, summaries.length)} tags by count:`);
  summaries.slice(0, LIMIT_TAGS_PRINT).forEach((s) => {
    const sample = s.sample
      ? `end=${sampleSafe(sample.end)}, value=${sampleSafe(sample.value)}, unit=${sampleSafe(sample.unit)}`
      : "no sample";
    console.log(`- ${s.tag}: ${s.count} periods (${sample})`);
  });
}

function sampleSafe(v) {
  if (v === null || v === undefined) return "n/a";
  if (typeof v === "number") return v;
  return String(v);
}

main().catch((err) => {
  console.error("dumpMetaFacts failed:", err);
  process.exit(1);
});
