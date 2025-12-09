import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const OVERRIDES_PATH = path.join(ROOT, "config", "sector-overrides.json");

const DEFAULT_SECTOR = "Other";

const SIC_RULES = [
  // Real estate first to avoid being swallowed by broad financial buckets.
  { sector: "Real Estate", ranges: [[6500, 6599], [6798, 6798]] },
  // Healthcare / pharma
  { sector: "Biotech/Pharma", ranges: [[2830, 2839]] },
  // Energy and materials carve-out
  { sector: "Energy/Materials", ranges: [[1300, 1399], [2900, 2999], [5171, 5171], [1311, 1311]] },
  // Financials (banks, insurers, brokers, asset managers)
  { sector: "Financials", ranges: [[6000, 6399], [6700, 6797]] },
  // Technology / internet
  { sector: "Tech/Internet", ranges: [[7300, 7399]] },
  // Consumer discretionary & services
  { sector: "Consumer & Services", ranges: [[5000, 5999]] },
  // Industrial / cyclical (after carving out energy)
  { sector: "Industrial/Cyclical", ranges: [[1000, 1299], [1400, 2899], [3000, 3999]] }
];

let overridesCache = null;

function normalizeTicker(ticker) {
  return ticker ? String(ticker).trim().toUpperCase() : null;
}

function loadOverrides() {
  if (overridesCache !== null) return overridesCache;
  try {
    const raw = fs.readFileSync(OVERRIDES_PATH, "utf8");
    overridesCache = JSON.parse(raw);
  } catch (_) {
    overridesCache = {};
  }
  return overridesCache;
}

function sectorFromSic(sic) {
  const sicNum = typeof sic === "string" ? Number(sic) : sic;
  if (!Number.isFinite(sicNum)) return null;
  for (const rule of SIC_RULES) {
    for (const [min, max] of rule.ranges) {
      if (sicNum >= min && sicNum <= max) return rule.sector;
    }
  }
  return null;
}

export function classifySector({ ticker, sic }) {
  const normalizedTicker = normalizeTicker(ticker);
  const overrides = loadOverrides();
  if (normalizedTicker && overrides[normalizedTicker]) {
    return { sector: overrides[normalizedTicker], source: "override" };
  }

  const sicSector = sectorFromSic(sic);
  if (sicSector) return { sector: sicSector, source: "sic" };

  return { sector: DEFAULT_SECTOR, source: "fallback" };
}

export function resetSectorOverridesCache() {
  overridesCache = null;
}

export { sectorFromSic, DEFAULT_SECTOR };
