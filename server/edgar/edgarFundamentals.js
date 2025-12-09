import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { classifySector } from "../sector/sectorClassifier.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");

export const SEC_BASE = process.env.EDGAR_BASE || process.env.DATA_API_BASE || "https://data.sec.gov";
export const EDGAR_USER_AGENT =
  process.env.EDGAR_USER_AGENT ||
  process.env.DATA_USER_AGENT ||
  process.env.SEC_EDGAR_TOOLKIT_USER_AGENT ||
  "BullishAndFoolish/1.0 (freelancer.bg@gmail.com)";

const OUTBOUND_SPACING_MS = Number(process.env.EDGAR_REQUEST_SPACING_MS) || 400; // ~2-3 rps to stay polite
const OUTBOUND_MAX_RETRIES = 3;
const OUTBOUND_BASE_BACKOFF_MS = 60_000;
let lastOutboundTs = 0;

const revenueTags = [
  "Revenues",
  "RevenueFromContractWithCustomerExcludingAssessedTax",
  "SalesRevenueNet",
  "SalesRevenueGoodsNet",
  "SalesRevenueServicesNet"
];
const bankRevenueTags = [
  "InterestAndDividendIncomeOperating",
  "NonInterestIncome"
];
const grossProfitTags = ["GrossProfit"];
const costOfRevenueTags = ["CostOfRevenue", "CostOfGoodsAndServicesSold"];
const operatingIncomeTags = ["OperatingIncomeLoss"];
const netIncomeTags = ["NetIncomeLoss"];
const epsBasicTags = ["EarningsPerShareBasic", "EarningsPerShareBasicAndDiluted"];
const epsDilutedTags = ["EarningsPerShareDiluted"];
const assetsTags = ["Assets"];
const liabilitiesTags = ["Liabilities"];
const equityTags = ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"];
const longTermDebtTags = [
  "LongTermDebtAndCapitalLeaseObligations",
  "LongTermDebtNoncurrent",
  "DebtNoncurrent",
  "LongTermNotesPayable",
  "NotesPayableNoncurrent",
  "LongTermLoansPayable",
  "ConvertibleDebtNoncurrent",
  "DebtLongtermAndShorttermCombinedAmount",
  "LongTermBorrowings",
  "LongTermDebtFairValue"
];
const shortTermDebtTags = [
  "DebtCurrent",
  "LongTermDebtCurrent",
  "ShortTermBorrowings",
  "ShortTermDebt",
  "CommercialPaper",
  "NotesPayableCurrent",
  "ConvertibleDebtCurrent"
];
const leaseLiabilityTags = [
  "OperatingLeaseLiabilityCurrent",
  "OperatingLeaseLiabilityNoncurrent",
  "FinanceLeaseLiabilityCurrent",
  "FinanceLeaseLiabilityNoncurrent"
];
const ocfTags = [
  "NetCashProvidedByUsedInOperatingActivities",
  "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"
];
const capexTags = [
  "PaymentsToAcquirePropertyPlantAndEquipment",
  "CapitalExpendituresIncurredButNotYetPaid",
  "PaymentsToAcquireProductiveAssets",
  "PaymentsForPropertyPlantAndEquipment"
];
const sbcTags = ["ShareBasedCompensation"];
const rdTags = ["ResearchAndDevelopmentExpense"];
const sharesTags = [
  "WeightedAverageNumberOfSharesOutstandingBasic",
  "WeightedAverageNumberOfDilutedSharesOutstanding",
  "CommonStockSharesOutstanding"
];
const cashTags = ["CashAndCashEquivalentsAtCarryingValue"];
const shortTermInvestmentsTags = ["ShortTermInvestments"];
const interestExpenseTags = ["InterestExpense", "InterestExpenseDebt"];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeCik(cik) {
  if (!cik) return null;
  const num = String(cik).replace(/\D/g, "");
  if (!num) return null;
  return num.padStart(10, "0");
}

async function limitedFetch(url, { parse = "json" } = {}) {
  const now = Date.now();
  const wait = Math.max(0, lastOutboundTs + OUTBOUND_SPACING_MS - now);
  if (wait) await sleep(wait);
  lastOutboundTs = Date.now();

  let attempt = 0;
  while (attempt < OUTBOUND_MAX_RETRIES) {
    const res = await fetch(url, { headers: { "User-Agent": EDGAR_USER_AGENT } });
    if ([429, 503].includes(res.status) && attempt < OUTBOUND_MAX_RETRIES - 1) {
      const backoff = OUTBOUND_BASE_BACKOFF_MS * Math.pow(2, attempt);
      await res.text().catch(() => "");
      await sleep(backoff);
      attempt++;
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const err = new Error(`EDGAR request failed ${res.status} ${url}`);
      err.status = res.status;
      err.body = text;
      throw err;
    }
    if (parse === "json") return res.json();
    if (parse === "text") return res.text();
    return res;
  }
  throw new Error("Exceeded EDGAR retry attempts");
}

async function limitedFetchJson(url) {
  return limitedFetch(url, { parse: "json" });
}

const directoryCache = { data: null, fetchedAt: 0 };
const DIRECTORY_TTL_MS = 24 * 60 * 60 * 1000;

async function loadLocalDirectory() {
  const candidates = [
    path.join(ROOT, "data", "company_tickers_exchange.json"),
    path.join(ROOT, "data", "edgar", "company_tickers_exchange.json")
  ];
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const raw = fs.readFileSync(file, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed?.data?.length) {
        console.warn("[edgarFundamentals] using local ticker directory", file);
        return parsed;
      }
    } catch (err) {
      console.warn("[edgarFundamentals] failed to read local directory", file, err?.message || err);
    }
  }
  return null;
}

async function loadDirectory() {
  const now = Date.now();
  if (directoryCache.data && now - directoryCache.fetchedAt < DIRECTORY_TTL_MS) {
    return directoryCache.data;
  }

  // Try local cache first to avoid SEC 404/ratelimit noise.
  const localFirst = await loadLocalDirectory();
  if (localFirst) {
    directoryCache.data = localFirst;
    directoryCache.fetchedAt = now;
    return localFirst;
  }

  const url = `${SEC_BASE}/files/company_tickers_exchange.json`;
  try {
    const data = await limitedFetchJson(url);
    directoryCache.data = data;
    directoryCache.fetchedAt = now;
    console.info("[edgarFundamentals] directory fetched", url, "rows", data?.data?.length || 0);
    return data;
  } catch (err) {
    console.warn("[edgarFundamentals] directory fetch failed; no local cache available", err?.message || err);
    throw err;
  }
}

async function lookupCompanyByTicker(ticker) {
  const upper = ticker.toUpperCase();
  try {
    const dir = await loadDirectory();
    const fields = dir.fields || [];
    const cikIdx = fields.indexOf("cik");
    const nameIdx = fields.indexOf("name");
    const tickerIdx = fields.indexOf("ticker");
    const exchangeIdx = fields.indexOf("exchange");
    for (const row of dir.data || []) {
      const t = row[tickerIdx];
      if (String(t).toUpperCase() === upper) {
        return {
          cik: normalizeCik(row[cikIdx]),
          title: row[nameIdx],
          exchange: exchangeIdx >= 0 ? row[exchangeIdx] : null
        };
      }
    }
  } catch (err) {
    console.warn("[edgarFundamentals] directory lookup failed", err?.message || err);
  }
  console.error("[edgarFundamentals] ticker not found in directory", upper);
  return null;
}

function classifyPeriod(fp) {
  if (!fp) return null;
  const v = String(fp).toUpperCase();
  if (v.startsWith("FY")) return "year";
  if (v.startsWith("Q")) return "quarter";
  return null;
}

function collectFacts(facts, tags) {
  const out = [];
  const gaap = facts?.facts?.["us-gaap"];
  if (!gaap) return out;
  for (const tag of tags) {
    const fact = gaap[tag];
    if (!fact?.units) continue;
    const units = fact.units.USD || Object.values(fact.units)[0] || [];
    if (!Array.isArray(units)) continue;
    for (const entry of units) {
      const periodType = classifyPeriod(entry.fp);
      if (!periodType) continue;
      out.push({
        tag,
        periodType,
        end: entry.end,
        filed: entry.filed,
        form: entry.form,
        val: typeof entry.val === "number" ? entry.val : Number(entry.val),
        currency: "USD"
      });
    }
  }
  return out;
}

function buildPeriods({ ticker, cik, facts, companyName, sector, sic, sicDescription }) {
  const metrics = {
    revenue: collectFacts(facts, revenueTags),
    bankRevenue: collectFacts(facts, bankRevenueTags),
    grossProfit: collectFacts(facts, grossProfitTags),
    costOfRevenue: collectFacts(facts, costOfRevenueTags),
    operatingIncome: collectFacts(facts, operatingIncomeTags),
    netIncome: collectFacts(facts, netIncomeTags),
    epsBasic: collectFacts(facts, epsBasicTags),
    epsDiluted: collectFacts(facts, epsDilutedTags),
    totalAssets: collectFacts(facts, assetsTags),
    totalLiabilities: collectFacts(facts, liabilitiesTags),
    totalEquity: collectFacts(facts, equityTags),
    longTermDebt: collectFacts(facts, longTermDebtTags),
    shortTermDebt: collectFacts(facts, shortTermDebtTags),
    leaseLiabilities: collectFacts(facts, leaseLiabilityTags),
    operatingCashFlow: collectFacts(facts, ocfTags),
    capex: collectFacts(facts, capexTags),
    shareBasedCompensation: collectFacts(facts, sbcTags),
    researchAndDevelopmentExpenses: collectFacts(facts, rdTags),
    shares: collectFacts(facts, sharesTags),
    cash: collectFacts(facts, cashTags),
    shortTermInvestments: collectFacts(facts, shortTermInvestmentsTags),
    interestExpense: collectFacts(facts, interestExpenseTags)
  };

  const periods = new Map();
  function ensure(key, proto) {
    if (!periods.has(key)) periods.set(key, { ...proto });
    return periods.get(key);
  }

  for (const [field, entries] of Object.entries(metrics)) {
    for (const e of entries) {
      const key = `${e.periodType}-${e.end}`;
      const base = ensure(key, {
        ticker,
        cik,
        companyName: companyName || null,
        periodType: e.periodType,
        periodEnd: e.end,
        filedDate: e.filed || null,
        currency: e.currency || null,
        sector: sector || null,
        sic: sic ?? null,
        sicDescription: sicDescription || null,
        revenue: null,
        grossProfit: null,
        costOfRevenue: null,
        operatingIncome: null,
        netIncome: null,
        epsBasic: null,
        epsDiluted: null,
        totalAssets: null,
        totalLiabilities: null,
        totalEquity: null,
        totalDebt: null,
        totalDebtComponents: { longTermDebt: null, shortTermDebt: null, leaseLiabilities: null },
        operatingCashFlow: null,
        capex: null,
        shareBasedCompensation: null,
        researchAndDevelopmentExpenses: null,
        sharesOutstanding: null,
        cashAndCashEquivalents: null,
        shortTermInvestments: null,
        interestExpense: null,
        freeCashFlow: null
      });
      const numeric = e.val != null && !Number.isNaN(e.val) ? Number(e.val) : null;
      if (field === "leaseLiabilities") {
        const existing = base.totalDebtComponents.leaseLiabilities ?? 0;
        base.totalDebtComponents.leaseLiabilities = numeric != null ? existing + numeric : existing;
      } else if (field === "longTermDebt") {
        // PRECEDENCE LOGIC: Do not sum distinct tags that represent the same concept.
        // We prefer the most aggregate tag.
        const current = base.totalDebtComponents.longTermDebt;
        const currentTag = base._debug_ltDebtTag;

        // Hierarchy of tags (Higher index = Higher priority? No, let's just explicit check)
        // 1. LongTermDebtAndCapitalLeaseObligations (Includes leases, most comprehensive)
        // 2. LongTermDebtNoncurrent (Standard)
        // 3. LongTermBorrowings (Specific)
        // 4. DebtLongtermAndShorttermCombinedAmount (This is usually TOTAL, not just LT. We should be careful. 
        //    If we find this, it might be the only debt field.)

        // For now, simpliest fix: Max Strategy? No, a small specific loan might be larger than a net debt field?? Unlikely.
        // Precedence Strategy:
        const priority = [
          "LongTermDebtAndCapitalLeaseObligations",
          "LongTermDebtNoncurrent",
          "DebtNoncurrent",
          "LongTermNotesPayable",
          "NotesPayableNoncurrent",
          "LongTermLoansPayable",
          "ConvertibleDebtNoncurrent",
          "DebtLongtermAndShorttermCombinedAmount",
          "LongTermBorrowings",
          "LongTermDebtFairValue"
        ];

        // If we haven't set a value yet, or if the new tag is higher priority (lower index), take it.
        // OR if the tags are the SAME, we might have multiple values (periods). But we are in a loop of single units.
        // Actually, collectFacts returns multiple entries.

        // Wait, 'collectFacts' flattens periods. We are iterating 'entries'.
        // If we have multiple entries for the SAME period from DIFFERENT tags, we need to pick ONE.

        const newPriorityIdx = priority.indexOf(e.tag);
        const oldPriorityIdx = currentTag ? priority.indexOf(currentTag) : 999;

        const isBetterTag = newPriorityIdx !== -1 && newPriorityIdx < oldPriorityIdx;

        if (current == null || isBetterTag) {
          base.totalDebtComponents.longTermDebt = numeric;
          base._debug_ltDebtTag = e.tag;
        } else if (e.tag === currentTag) {
          // Same tag, maybe an adjustment? Usually duplicate or segment. 
          // XBRL usually has one value per context. Keep the largest magnitude if duplicates exist?
          if (Math.abs(numeric) > Math.abs(current)) {
            base.totalDebtComponents.longTermDebt = numeric;
          }
        }

      } else if (field === "shortTermDebt") {
        // Similar logic for Short Term
        const current = base.totalDebtComponents.shortTermDebt;
        const currentTag = base._debug_stDebtTag;
        const priority = [
          "DebtCurrent",
          "LongTermDebtCurrent",
          "ShortTermBorrowings",
          "ShortTermDebt",
          "CommercialPaper",
          "NotesPayableCurrent",
          "ConvertibleDebtCurrent"
        ];

        const newPriorityIdx = priority.indexOf(e.tag);
        const oldPriorityIdx = currentTag ? priority.indexOf(currentTag) : 999;

        const isBetterTag = newPriorityIdx !== -1 && newPriorityIdx < oldPriorityIdx;

        if (current == null || isBetterTag) {
          base.totalDebtComponents.shortTermDebt = numeric;
          base._debug_stDebtTag = e.tag;
        } else if (e.tag === currentTag) {
          if (Math.abs(numeric) > Math.abs(current)) {
            base.totalDebtComponents.shortTermDebt = numeric;
          }
        }
      } else if (field === "interestExpense") {
        const current = base.interestExpense;
        if (current == null || Math.abs(numeric ?? 0) > Math.abs(current)) base.interestExpense = numeric;
      } else if (field === "bankRevenue") {
        // Accumulate specific banking revenue components (Interest Income + Non-Interest Income)
        // Only if they are meaningful positive numbers
        if (numeric != null && numeric > 0) {
          base._bankRevSum = (base._bankRevSum ?? 0) + numeric;
        }
      } else if (base[field] == null && numeric != null) {
        base[field] = numeric;
      }
      if (!base.filedDate && e.filed) base.filedDate = e.filed;
    }
  }

  // Derived values
  for (const period of periods.values()) {
    // Bank Revenue Fallback: If 'Revenue' tag was missing, use the sum of components
    if (period.revenue == null && period._bankRevSum != null && period._bankRevSum > 0) {
      period.revenue = period._bankRevSum;
    }

    if (period.grossProfit == null && period.revenue != null && period.costOfRevenue != null) {
      period.grossProfit = period.revenue - period.costOfRevenue;
    }
    if (period.sharesOutstanding == null && period.shares != null) {
      period.sharesOutstanding = period.shares;
    }
    if (period.operatingCashFlow != null && period.capex != null) {
      const capexOutflow = Math.abs(period.capex);
      period.freeCashFlow = period.operatingCashFlow - capexOutflow;
    }
    const debtSum =
      (period.totalDebtComponents.longTermDebt ?? 0) +
      (period.totalDebtComponents.shortTermDebt ?? 0) +
      (period.totalDebtComponents.leaseLiabilities ?? 0);

    // Preserve null if both are missing, so we can flag "Unreported Debt" vs "Explicit Zero"
    const lt = period.totalDebtComponents.longTermDebt;
    const st = period.totalDebtComponents.shortTermDebt;
    period.financialDebt = (lt == null && st == null) ? null : ((lt ?? 0) + (st ?? 0));

    period.shortTermDebt = period.totalDebtComponents.shortTermDebt ?? null;
    period.leaseLiabilities = period.totalDebtComponents.leaseLiabilities ?? null;
    if (debtSum && (period.totalDebt == null || debtSum > period.totalDebt)) {
      period.totalDebt = debtSum;
    }
  }

  // Filter to last 4 quarters and a light annual trail
  const arr = Array.from(periods.values()).filter((p) => p.periodEnd);
  arr.sort((a, b) => Date.parse(b.periodEnd) - Date.parse(a.periodEnd));
  const quarters = arr.filter((p) => p.periodType === "quarter").slice(0, 4);
  // Keep a light annual trail (latest + prior) for YoY-style signals without bloating storage.
  const years = arr.filter((p) => p.periodType === "year").slice(0, 2);
  return [...quarters, ...years];
}

async function fetchCompanyMeta(cik) {
  if (!cik) return {};
  const url = `${SEC_BASE}/submissions/CIK${cik}.json`;
  try {
    const meta = await limitedFetchJson(url);
    return {
      sic: meta?.sic ? Number(meta.sic) : null,
      sicDescription: meta?.sicDescription || null,
      name: meta?.name || meta?.entityType || null
    };
  } catch (err) {
    console.warn("[edgarFundamentals] failed to fetch company meta", err?.message || err);
    return {};
  }
}

export async function fetchCompanyFundamentals(ticker) {
  if (!ticker) throw new Error("ticker is required");
  const match = await lookupCompanyByTicker(ticker);
  const cik = normalizeCik(match?.cik);
  if (!cik) throw new Error("CIK not found for ticker");
  console.info("[edgarFundamentals] fetching companyfacts", ticker.toUpperCase(), "CIK", cik, "base", SEC_BASE);

  const meta = await fetchCompanyMeta(cik);
  const facts = await limitedFetchJson(`${SEC_BASE}/api/xbrl/companyfacts/CIK${cik}.json`);

  const sic = meta?.sic ?? null;
  const sicDescription = meta?.sicDescription || null;
  const sectorResult = classifySector({ ticker, sic });

  const companyName = meta?.name || facts?.entityName || match?.title || null;
  const periods = buildPeriods({
    ticker: ticker.toUpperCase(),
    cik,
    facts,
    companyName,
    sector: sectorResult?.sector,
    sic,
    sicDescription
  });
  if (!periods.length) {
    const err = new Error("No fundamentals available from EDGAR");
    err.status = 503;
    throw err;
  }
  console.info("[edgarFundamentals] parsed periods", periods.length, "for", ticker.toUpperCase());
  return periods.map((p) => ({
    ...p,
    sector: sectorResult?.sector ?? p.sector ?? null,
    sic,
    sicDescription
  }));
}

export function normalizeEdgarCik(cik) {
  return normalizeCik(cik);
}

// Lightweight exports for other EDGAR helpers
export { limitedFetchJson, limitedFetch, lookupCompanyByTicker };
