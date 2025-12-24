import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const OVERRIDES_PATH = path.join(ROOT, "config", "sector-overrides.json");

const DEFAULT_SECTOR = "Other";

const SIC_RULES = [
  // Real estate
  { sector: "Real Estate", ranges: [[6500, 6599], [6798, 6798]] },
  // Healthcare / pharma
  { sector: "Biotech/Pharma", ranges: [[2830, 2839], [3840, 3849], [8000, 8099]] },
  // Tech / Internet
  { sector: "Tech/Internet", ranges: [[3570, 3579], [3670, 3679], [4800, 4899], [7370, 7379], [7380, 7389], [3600, 3699]] },
  // Energy and materials
  { sector: "Energy/Materials", ranges: [[100, 1499], [2900, 2999], [1000, 1499], [3300, 3399]] },
  // Financials
  { sector: "Financials", ranges: [[6000, 6499], [6700, 6797]] },
  // Consumer & Services
  { sector: "Consumer & Services", ranges: [[5000, 5999], [7000, 7299], [7400, 7999], [8100, 8999]] },
  // Industrial / cyclical
  { sector: "Industrial/Cyclical", ranges: [[1500, 4999]] }
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
