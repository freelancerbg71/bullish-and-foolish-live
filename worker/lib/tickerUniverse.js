import { getDb } from "../../server/edgar/fundamentalsStore.js";
import { envCsv, envNumber, envString } from "./args.js";

function normalizeTicker(t) {
  return t ? String(t).trim().toUpperCase() : "";
}

function normalizeCompanyNameForDedupe(name) {
  const raw = String(name || "");
  const cleaned = raw
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!cleaned) return null;
  // Keep only letters/numbers/spaces to reduce trivial differences.
  const alnum = cleaned.replace(/[^\p{L}\p{N} ]/gu, "");
  const collapsed = alnum.replace(/\s+/g, " ").trim();
  return collapsed || null;
}

function dedupeVariantTickersByCompanyName(rows, { allowlist = new Set(), keepIfMarketCapGte = null } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const groups = new Map(); // nameKey -> rows[]
  for (const r of list) {
    const key = normalizeCompanyNameForDedupe(r?.name);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const keepTickerByName = new Map(); // nameKey -> baseTicker
  for (const [key, group] of groups.entries()) {
    const tickers = [...new Set(group.map((r) => normalizeTicker(r?.ticker)).filter(Boolean))];
    if (tickers.length < 2) continue;

    if (keepIfMarketCapGte != null && Number.isFinite(keepIfMarketCapGte)) {
      const maxMcap = Math.max(
        ...group.map((r) => (Number.isFinite(Number(r?.marketCap)) ? Number(r.marketCap) : -Infinity))
      );
      if (Number.isFinite(maxMcap) && maxMcap >= keepIfMarketCapGte) continue;
    }

    // Prefer a "base" ticker that is a prefix of other variants.
    tickers.sort((a, b) => a.length - b.length || a.localeCompare(b));
    const base = tickers.find((t) => tickers.some((o) => o !== t && o.startsWith(t))) || null;
    if (!base) continue;

    // If any variant is explicitly allowlisted, don’t dedupe this name group.
    const allowlistedInGroup = tickers.some((t) => allowlist.has(t));
    if (allowlistedInGroup) continue;
    keepTickerByName.set(key, base);
  }

  if (!keepTickerByName.size) return list;

  return list.filter((r) => {
    const t = normalizeTicker(r?.ticker);
    if (!t) return false;
    if (allowlist.has(t)) return true;
    const key = normalizeCompanyNameForDedupe(r?.name);
    if (!key) return true;
    const base = keepTickerByName.get(key);
    if (!base) return true;
    return t === base;
  });
}

async function readUniverseFromDb(source) {
  const db = await getDb();
  const src = String(source || "db:fundamentals").toLowerCase();
  if (src === "db:edgar_tickers") {
    return db
      .prepare("SELECT ticker, NULL as name, NULL as marketCap FROM edgar_tickers WHERE is_active = 1 ORDER BY ticker ASC")
      .all();
  }
  if (src === "db:screener") {
    return db
      .prepare("SELECT ticker, name, marketCap FROM screener_index ORDER BY ticker ASC")
      .all();
  }
  // default: db:fundamentals
  return db
    .prepare("SELECT DISTINCT ticker, NULL as name, NULL as marketCap FROM fundamentals ORDER BY ticker ASC")
    .all();
}

async function hydrateNamesAndMarketCap(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return list;
  const db = await getDb();
  const tickers = list.map((r) => normalizeTicker(r?.ticker)).filter(Boolean);
  const uniq = [...new Set(tickers)];
  const placeholders = uniq.map((_, i) => `@t${i}`).join(",");
  const args = {};
  uniq.forEach((t, i) => (args[`t${i}`] = t));

  const meta = db
    .prepare(`SELECT ticker, name, marketCap FROM screener_index WHERE ticker IN (${placeholders})`)
    .all(args);
  const byTicker = new Map(meta.map((m) => [normalizeTicker(m.ticker), m]));
  return list.map((r) => {
    const t = normalizeTicker(r?.ticker);
    const m = byTicker.get(t) || null;
    return {
      ticker: t,
      name: r?.name ?? m?.name ?? null,
      marketCap: r?.marketCap ?? m?.marketCap ?? null
    };
  });
}

export async function loadSupportedTickers() {
  const source = envString("WORKER_TICKER_SOURCE", "db:fundamentals");
  const keepIfMarketCapGte = envNumber("WORKER_DEDUPE_KEEP_IF_MARKETCAP_GTE", null);
  const allowlist = new Set(envCsv("WORKER_DUPLICATE_ALLOWLIST").map(normalizeTicker));

  const raw = await readUniverseFromDb(source);
  const hydrated = await hydrateNamesAndMarketCap(raw);
  const deduped = dedupeVariantTickersByCompanyName(hydrated, { allowlist, keepIfMarketCapGte });

  return deduped.map((r) => normalizeTicker(r.ticker)).filter(Boolean);
}

