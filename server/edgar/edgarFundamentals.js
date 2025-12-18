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

const QUARTERS_TO_KEEP = Math.max(4, Number(process.env.EDGAR_QUARTERS_TO_KEEP) || 12); // ~3 years default
const YEARS_TO_KEEP = Math.max(2, Number(process.env.EDGAR_YEARS_TO_KEEP) || 4); // supports 3Y CAGR

// Throttle noisy "not found" logs so missing tickers don't spam the console
const NOT_FOUND_LOG_TTL_MS = 10 * 60 * 1000;
const notFoundLogCache = new Map();

const revenueTags = [
  "Revenues",
  "Revenue",
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
const costOfRevenueTags = [
  "CostOfRevenue",
  "CostOfGoodsAndServicesSold",
  "CostOfSales",
  "CostOfGoodsSold",
  "CostOfGoodsSoldExcludingDepreciationDepletionAndAmortization",
  "CostOfProductsSold",
  "CostOfServices"
];
const operatingIncomeTags = [
  "OperatingIncomeLoss",
  "OperatingProfitLoss",
  "OperatingIncomeLossContinuingOperations"
];
const pretaxIncomeTags = [
  "IncomeBeforeIncomeTaxes",
  "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
  "ProfitLossBeforeTax"
];
const incomeTaxExpenseTags = [
  "IncomeTaxExpenseBenefit",
  "IncomeTaxExpenseBenefitContinuingOperations"
];
const netIncomeTags = [
  "NetIncomeLoss",
  "ProfitLoss",
  "ProfitLossAttributableToOwnersOfParent",
  "ProfitLossAttributableToParent",
  "ProfitLossAttributableToEquityHoldersOfParent"
];
const epsBasicTags = [
  "EarningsPerShareBasic",
  "EarningsPerShareBasicAndDiluted",
  "EarningsPerShareBasicContinuingOperations",
  "BasicEarningsLossPerShare",
  "BasicEarningsLossPerShareContinuingOperations"
];
const epsDilutedTags = [
  "EarningsPerShareDiluted",
  "EarningsPerShareDilutedContinuingOperations",
  "DilutedEarningsLossPerShare",
  "DilutedEarningsLossPerShareContinuingOperations"
];
const assetsTags = ["Assets"];
const liabilitiesTags = ["Liabilities"];
const equityTags = [
  "StockholdersEquity",
  "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
  "Equity",
  "EquityAttributableToOwnersOfParent"
];
const longTermDebtTags = [
  "LongTermDebtAndCapitalLeaseObligations",
  "LongTermDebtNoncurrent",
  "LongTermDebt",
  "DebtNoncurrent",
  "LongTermNotesPayable",
  "NotesPayableNoncurrent",
  "LongTermLoansPayable",
  "ConvertibleDebtNoncurrent",
  "DebtLongtermAndShorttermCombinedAmount",
  "LongTermBorrowings",
  "LongTermDebtFairValue",
  "NoncurrentBorrowings",
  "InterestBearingBorrowingsNoncurrent",
  "NoncurrentLeaseLiabilities"
];
const shortTermDebtTags = [
  "DebtCurrent",
  "LongTermDebtCurrent",
  "ShortTermBorrowings",
  "ShortTermDebt",
  "CommercialPaper",
  "NotesPayableCurrent",
  "ConvertibleDebtCurrent",
  "CurrentBorrowings",
  "InterestBearingBorrowingsCurrent",
  "CurrentLeaseLiabilities"
];
const leaseLiabilityTags = [
  "OperatingLeaseLiabilityCurrent",
  "OperatingLeaseLiabilityNoncurrent",
  "FinanceLeaseLiabilityCurrent",
  "FinanceLeaseLiabilityNoncurrent",
  "LeaseLiabilitiesCurrent",
  "LeaseLiabilitiesNoncurrent"
];
const ocfTags = [
  "NetCashProvidedByUsedInOperatingActivities",
  "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
  "NetCashFlowsFromUsedInOperatingActivities",
  "NetCashFlowsFromUsedInOperatingActivitiesContinuingOperations",
  "NetCashFromOperatingActivities",
  "NetCashFlowsFromOperatingActivities",
  "NetCashFromUsedInOperatingActivities"
];
const capexTags = [
  "PaymentsToAcquirePropertyPlantAndEquipment",
  "CapitalExpendituresIncurredButNotYetPaid",
  "PaymentsToAcquireProductiveAssets",
  "PaymentsForPropertyPlantAndEquipment",
  "PurchaseOfPropertyPlantAndEquipment",
  "PurchaseOfTangibleAssets",
  "PaymentsForAcquisitionOfPropertyPlantAndEquipment",
  "PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities"
];
const sbcTags = ["ShareBasedCompensation"];
const rdTags = ["ResearchAndDevelopmentExpense", "ResearchAndDevelopmentExpenditure"];
const buybackTags = [
  "PaymentsForRepurchaseOfCommonStock",
  "PaymentsForRepurchaseOfEquity",
  "PaymentsForRepurchaseOfCommonStockAndAdditionalPaidInCapital",
  "PaymentsForRepurchaseOfCommonStockAndRelatedTaxes",
  "PaymentsForRepurchaseOfCommonStockIncludingTreasuryStockAcquired",
  "RepurchasesOfCommonStock"
];
const dividendsPaidTags = [
  "PaymentsOfDividends",
  "PaymentsOfDividendsCommonStock",
  "PaymentsOfDividendsAndDividendEquivalentsOnCommonStock",
  "PaymentsOfDividendsAndDividendEquivalents",
  "DividendsPaid"
];
const accountsReceivableTags = [
  "AccountsReceivableNetCurrent",
  "AccountsReceivableNet",
  "AccountsReceivable",
  "ReceivablesNetCurrent",
  "AccountsReceivableTradeCurrent",
  "Receivables",
  "ReceivablesNet"
];
const inventoriesTags = [
  "InventoryNet",
  "InventoryFinishedGoods",
  "InventoryFinishedGoodsAndWorkInProcess",
  "InventoryRawMaterialsAndSupplies",
  "Inventories"
];
const accountsPayableTags = [
  "AccountsPayableCurrent",
  "AccountsPayable",
  "AccountsPayableTradeCurrent",
  "AccountsPayableTrade"
];
const sharesTags = [
  "WeightedAverageNumberOfSharesOutstandingBasic",
  "WeightedAverageNumberOfDilutedSharesOutstanding",
  "CommonStockSharesOutstanding",
  "EntityCommonStockSharesOutstanding",
  "WeightedAverageNumberOfOrdinarySharesOutstandingBasic",
  "WeightedAverageNumberOfOrdinarySharesOutstandingDiluted"
];
const cashTags = [
  "CashAndCashEquivalentsAtCarryingValue",
  "CashAndCashEquivalents",
  "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
  "RestrictedCashAndCashEquivalentsAtCarryingValue",
  "RestrictedCashAndCashEquivalentsCurrent",
  "CashAndCashEquivalentsAndShortTermInvestments",
  "CashAndShortTermInvestments"
];
const shortTermInvestmentsTags = ["ShortTermInvestments"];
const interestExpenseTags = [
  "InterestExpense",
  "InterestExpenseDebt",
  "InterestExpenseNet",
  "InterestAndDebtExpense",
  "InterestExpenseBorrowings",
  "FinanceCosts"
];
const operatingExpensesTags = [
  "OperatingExpenses",
  "OperatingExpensesTotal",
  "OperatingCostsAndExpenses",
  "CostsAndExpenses"
];
const currentAssetsTags = ["AssetsCurrent"];
const currentLiabilitiesTags = ["LiabilitiesCurrent"];
const interestIncomeTags = [
  "InterestIncomeOperating",
  "InterestAndDividendIncomeOperating",
  "InvestmentIncomeInterest",
  "InterestIncome"
];
const depositsTags = ["Deposits", "DepositsTotal", "TotalDeposits"];
const totalDepositsTags = ["TotalDeposits", "DepositsTotal", "Deposits"];
const customerDepositsTags = ["CustomerDeposits", "DepositsFromCustomers"];
const depositLiabilitiesTags = ["DepositLiabilities"];
const technologyExpensesTags = [
  // Best-effort proxy; often the closest XBRL tag available.
  "ResearchAndDevelopmentExpense",
  "ResearchAndDevelopmentExpenditure",
  "InformationTechnologyExpense",
  "InformationTechnologyCosts",
  "SoftwareAndWebSiteDevelopmentCosts"
];
const softwareExpensesTags = [
  "SoftwareDevelopmentCosts",
  "SoftwareDevelopmentCost",
  "SoftwareDevelopmentCostsIncurred"
];
const depreciationTags = [
  "DepreciationDepletionAndAmortization",
  "DepreciationAndAmortization",
  "Depreciation",
  "AmortizationOfIntangibleAssets",
  "DepreciationAmortization"
];
const deferredRevenueTags = [
  "DeferredRevenue",
  "DeferredRevenueCurrent",
  "DeferredRevenueNoncurrent"
];
const contractWithCustomerLiabilityTags = [
  "ContractWithCustomerLiability",
  "ContractWithCustomerLiabilityCurrent",
  "ContractWithCustomerLiabilityNoncurrent"
];
const TAXONOMY_ORDER = ["us-gaap", "ifrs-full", "ifrs", "dei"];

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

export function detectIssuerTypeFromSubmissions(submissions) {
  const forms = (submissions?.filings?.recent?.form || []).map((f) => (f || "").toUpperCase());
  const has20F = forms.some((f) => f.startsWith("20-F"));
  const has6K = forms.some((f) => f.startsWith("6-K"));
  const issuerType = has20F || has6K ? "foreign" : "domestic";
  const filingProfile =
    issuerType === "foreign"
      ? { annual: has20F ? "20-F" : null, interim: has6K ? "6-K" : null, current: "6-K" }
      : { annual: "10-K", interim: "10-Q", current: "8-K" };
  return { issuerType, filingProfile };
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

function logTickerNotFound(upper) {
  const last = notFoundLogCache.get(upper) || 0;
  const now = Date.now();
  if (now - last < NOT_FOUND_LOG_TTL_MS) return;
  notFoundLogCache.set(upper, now);
  console.error("[edgarFundamentals] ticker not found in directory", upper);
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
  logTickerNotFound(upper);
  return null;
}

function classifyPeriod(fp) {
  if (!fp) return null;
  const v = String(fp).toUpperCase();
  if (v.startsWith("FY")) return "year";
  if (v.startsWith("Q")) return "quarter";
  // Many foreign issuers report half-year periods as HY/H1/H2/6M.
  if (v.startsWith("HY") || v.startsWith("H1") || v.startsWith("H2") || v.startsWith("6M") || v.startsWith("SR")) {
    return "quarter"; // treat half-year as an interim period for trend logic
  }
  return null;
}

function collectFacts(facts, tags) {
  const out = [];
  const allFacts = facts?.facts || {};
  for (const tag of tags) {
    let fact = null;
    let taxonomyUsed = null;
    for (const tax of TAXONOMY_ORDER) {
      if (fact) break;
      const space = allFacts[tax];
      if (space?.[tag]?.units) {
        fact = space[tag];
        taxonomyUsed = tax;
      }
    }
    if (!fact?.units) continue;
    const unitKey = fact.units.USD ? "USD" : Object.keys(fact.units)[0];
    const units = unitKey ? fact.units[unitKey] : [];
    if (!Array.isArray(units)) continue;
    for (const entry of units) {
      const periodType = classifyPeriod(entry.fp);
      if (!periodType) continue;
      out.push({
        tag,
        periodType,
        start: entry.start,
        end: entry.end,
        filed: entry.filed,
        form: entry.form,
        fy: entry.fy != null ? Number(entry.fy) : null,
        fp: entry.fp != null ? String(entry.fp).toUpperCase() : null,
        qtrs: entry.qtrs != null ? Number(entry.qtrs) : null,
        frame: entry.frame != null ? String(entry.frame) : null,
        val: typeof entry.val === "number" ? entry.val : Number(entry.val),
        currency: unitKey || "USD",
        taxonomy: taxonomyUsed
      });
    }
  }
  return out;
}

function buildPeriods({ ticker, cik, facts, companyName, sector, sic, sicDescription }) {
  const FLOW_FIELDS = new Set([
    "revenue",
    "bankRevenue",
    "grossProfit",
    "costOfRevenue",
    "operatingExpenses",
    "operatingIncome",
    "incomeBeforeIncomeTaxes",
    "incomeTaxExpenseBenefit",
    "netIncome",
    "epsBasic",
    "epsDiluted",
    "interestIncome",
    "operatingCashFlow",
    "capex",
    "freeCashFlow",
    "shareBasedCompensation",
    "researchAndDevelopmentExpenses",
    "technologyExpenses",
    "softwareExpenses",
    "depreciationDepletionAndAmortization",
    "treasuryStockRepurchased",
    "dividendsPaid",
    "interestExpense"
  ]);

  const isYtdishFrame = (frame) => frame && /ytd/i.test(String(frame));
  const parseIsoDate = (val) => {
    const ts = Date.parse(val || "");
    return Number.isFinite(ts) ? ts : null;
  };
  const isBetterFlowCandidate = ({ currentMeta, candidateEntry, periodType }) => {
    if (!candidateEntry) return false;
    if (!currentMeta) return true;

    const candStart = parseIsoDate(candidateEntry.start);
    const currStart = parseIsoDate(currentMeta.start);
    const candFrame = candidateEntry.frame || null;
    const currFrame = currentMeta.frame || null;

    // For quarters, prefer the shortest-duration (latest start) fact to avoid YTD values.
    if (periodType === "quarter") {
      if (candStart != null && (currStart == null || candStart > currStart)) return true;
      if (candStart == null && currStart != null) return false;

      const candYtd = isYtdishFrame(candFrame);
      const currYtd = isYtdishFrame(currFrame);
      if (candYtd === false && currYtd === true) return true;
      if (candYtd === true && currYtd === false) return false;
    }

    // For annual facts, prefer the longest-duration (earliest start) fact.
    if (periodType === "year") {
      if (candStart != null && (currStart == null || candStart < currStart)) return true;
      if (candStart == null && currStart != null) return false;
    }

    // Fall back to latest-filed when comparable.
    const candFiled = parseIsoDate(candidateEntry.filed);
    const currFiled = parseIsoDate(currentMeta.filed);
    if (candFiled != null && (currFiled == null || candFiled > currFiled)) return true;

    return false;
  };

  const upsertFlowField = (base, field, numeric, entry) => {
    if (!base._flowMeta) base._flowMeta = {};
    const currentMeta = base._flowMeta[field] || null;
    if (base[field] == null || isBetterFlowCandidate({ currentMeta, candidateEntry: entry, periodType: entry.periodType })) {
      base[field] = numeric;
      base._flowMeta[field] = {
        start: entry.start || null,
        end: entry.end || null,
        fp: entry.fp || null,
        fy: entry.fy ?? null,
        filed: entry.filed || null,
        form: entry.form || null,
        frame: entry.frame || null,
        tag: entry.tag || null
      };
    }
  };

  const metrics = {
    revenue: collectFacts(facts, revenueTags),
    bankRevenue: collectFacts(facts, bankRevenueTags),
    grossProfit: collectFacts(facts, grossProfitTags),
    costOfRevenue: collectFacts(facts, costOfRevenueTags),
    operatingExpenses: collectFacts(facts, operatingExpensesTags),
    operatingIncome: collectFacts(facts, operatingIncomeTags),
    incomeBeforeIncomeTaxes: collectFacts(facts, pretaxIncomeTags),
    incomeTaxExpenseBenefit: collectFacts(facts, incomeTaxExpenseTags),
    netIncome: collectFacts(facts, netIncomeTags),
    epsBasic: collectFacts(facts, epsBasicTags),
    epsDiluted: collectFacts(facts, epsDilutedTags),
    totalAssets: collectFacts(facts, assetsTags),
    currentAssets: collectFacts(facts, currentAssetsTags),
    totalLiabilities: collectFacts(facts, liabilitiesTags),
    currentLiabilities: collectFacts(facts, currentLiabilitiesTags),
    totalEquity: collectFacts(facts, equityTags),
    longTermDebt: collectFacts(facts, longTermDebtTags),
    shortTermDebt: collectFacts(facts, shortTermDebtTags),
    leaseLiabilities: collectFacts(facts, leaseLiabilityTags),
    operatingCashFlow: collectFacts(facts, ocfTags),
    capex: collectFacts(facts, capexTags),
    shareBasedCompensation: collectFacts(facts, sbcTags),
    researchAndDevelopmentExpenses: collectFacts(facts, rdTags),
    technologyExpenses: collectFacts(facts, technologyExpensesTags),
    softwareExpenses: collectFacts(facts, softwareExpensesTags),
    depreciationDepletionAndAmortization: collectFacts(facts, depreciationTags),
    treasuryStockRepurchased: collectFacts(facts, buybackTags),
    dividendsPaid: collectFacts(facts, dividendsPaidTags),
    shares: collectFacts(facts, sharesTags),
    cash: collectFacts(facts, cashTags),
    shortTermInvestments: collectFacts(facts, shortTermInvestmentsTags),
    accountsReceivable: collectFacts(facts, accountsReceivableTags),
    inventories: collectFacts(facts, inventoriesTags),
    accountsPayable: collectFacts(facts, accountsPayableTags),
    interestIncome: collectFacts(facts, interestIncomeTags),
    deposits: collectFacts(facts, depositsTags),
    customerDeposits: collectFacts(facts, customerDepositsTags),
    totalDeposits: collectFacts(facts, totalDepositsTags),
    depositLiabilities: collectFacts(facts, depositLiabilitiesTags),
    deferredRevenue: collectFacts(facts, deferredRevenueTags),
    contractWithCustomerLiability: collectFacts(facts, contractWithCustomerLiabilityTags),
    interestExpense: collectFacts(facts, interestExpenseTags)
  };

  const periods = new Map();
  function ensure(key, proto) {
    if (!periods.has(key)) periods.set(key, { ...proto });
    return periods.get(key);
  }

  for (const [field, entries] of Object.entries(metrics)) {
    for (const e of entries) {
      // For flow metrics, prefer true single-quarter facts over YTD facts.
      // SEC companyfacts entries often include `qtrs` (# of quarters covered). If present:
      // - quarter facts should usually have qtrs=1
      // - annual facts should usually have qtrs=4
      // We keep point-in-time metrics (assets/cash/debt/shares) unfiltered.
      if (FLOW_FIELDS.has(field)) {
        const qtrs = e.qtrs;
        // Do not hard-filter quarterly facts by qtrs: many issuers only report YTD (qtrs=2/3),
        // and we already prefer shorter-duration facts via start-date selection.
        if (e.periodType === "year" && Number.isFinite(qtrs) && qtrs !== 4) continue;
      }
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
        operatingExpenses: null,
        operatingIncome: null,
        incomeBeforeIncomeTaxes: null,
        incomeTaxExpenseBenefit: null,
        netIncome: null,
        epsBasic: null,
        epsDiluted: null,
        totalAssets: null,
        currentAssets: null,
        totalLiabilities: null,
        currentLiabilities: null,
        totalEquity: null,
        totalDebt: null,
        longTermDebt: null,
        totalDebtComponents: { longTermDebt: null, shortTermDebt: null, leaseLiabilities: null },
        deposits: null,
        customerDeposits: null,
        totalDeposits: null,
        depositLiabilities: null,
        operatingCashFlow: null,
        capex: null,
        shareBasedCompensation: null,
        researchAndDevelopmentExpenses: null,
        technologyExpenses: null,
        softwareExpenses: null,
        depreciationDepletionAndAmortization: null,
        treasuryStockRepurchased: null,
        dividendsPaid: null,
        sharesOutstanding: null,
        cashAndCashEquivalents: null,
        shortTermInvestments: null,
        accountsReceivable: null,
        inventories: null,
        accountsPayable: null,
        interestIncome: null,
        deferredRevenue: null,
        contractWithCustomerLiability: null,
        interestExpense: null,
        freeCashFlow: null
      });
      const numeric = e.val != null && !Number.isNaN(e.val) ? Number(e.val) : null;
      if (field === "cash") {
        if (base.cashAndCashEquivalents == null && numeric != null) {
          base.cashAndCashEquivalents = numeric;
        }
        if (!base.filedDate && e.filed) base.filedDate = e.filed;
        continue;
      }
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
      } else if (field === "deferredRevenue") {
        if (e.tag === "DeferredRevenue") {
          const current = base._deferredRevenueTotal;
          if (current == null || Math.abs(numeric ?? 0) > Math.abs(current)) base._deferredRevenueTotal = numeric;
        } else if (e.tag === "DeferredRevenueCurrent") {
          const current = base._deferredRevenueCurrent;
          if (current == null || Math.abs(numeric ?? 0) > Math.abs(current)) base._deferredRevenueCurrent = numeric;
        } else if (e.tag === "DeferredRevenueNoncurrent") {
          const current = base._deferredRevenueNoncurrent;
          if (current == null || Math.abs(numeric ?? 0) > Math.abs(current)) base._deferredRevenueNoncurrent = numeric;
        }
        const current = base.deferredRevenue;
        if (current == null || Math.abs(numeric ?? 0) > Math.abs(current)) base.deferredRevenue = numeric;
      } else if (field === "contractWithCustomerLiability") {
        if (e.tag === "ContractWithCustomerLiability") {
          const current = base._contractWithCustomerLiabilityTotal;
          if (current == null || Math.abs(numeric ?? 0) > Math.abs(current)) base._contractWithCustomerLiabilityTotal = numeric;
        } else if (e.tag === "ContractWithCustomerLiabilityCurrent") {
          const current = base._contractWithCustomerLiabilityCurrent;
          if (current == null || Math.abs(numeric ?? 0) > Math.abs(current)) base._contractWithCustomerLiabilityCurrent = numeric;
        } else if (e.tag === "ContractWithCustomerLiabilityNoncurrent") {
          const current = base._contractWithCustomerLiabilityNoncurrent;
          if (current == null || Math.abs(numeric ?? 0) > Math.abs(current)) base._contractWithCustomerLiabilityNoncurrent = numeric;
        }
        const current = base.contractWithCustomerLiability;
        if (current == null || Math.abs(numeric ?? 0) > Math.abs(current)) base.contractWithCustomerLiability = numeric;
      } else if (
        field === "currentAssets" ||
        field === "currentLiabilities" ||
        field === "accountsReceivable" ||
        field === "deposits" ||
        field === "customerDeposits" ||
        field === "totalDeposits" ||
        field === "depositLiabilities"
      ) {
        const current = base[field];
        if (current == null || Math.abs(numeric ?? 0) > Math.abs(current)) base[field] = numeric;
      } else if (field === "bankRevenue") {
        // Accumulate specific banking revenue components (Interest Income + Non-Interest Income)
        // Only if they are meaningful positive numbers
        if (numeric != null && numeric > 0) {
          base._bankRevSum = (base._bankRevSum ?? 0) + numeric;
        }
      } else if (FLOW_FIELDS.has(field) && numeric != null) {
        upsertFlowField(base, field, numeric, e);
      } else if (base[field] == null && numeric != null) {
        base[field] = numeric;
      }
      if (!base.filedDate && e.filed) base.filedDate = e.filed;
    }
  }

  // Derived values
  const derivePointInTimeTotal = (explicit, total, current, noncurrent) => {
    if (Number.isFinite(total)) return Number(total);
    if (Number.isFinite(current) && Number.isFinite(noncurrent)) return Number(current) + Number(noncurrent);
    if (explicit != null) return explicit;
    if (Number.isFinite(current)) return Number(current);
    if (Number.isFinite(noncurrent)) return Number(noncurrent);
    return null;
  };

  for (const period of periods.values()) {
    // Bank Revenue Fallback: If 'Revenue' tag was missing, use the sum of components
    if (period.revenue == null && period._bankRevSum != null && period._bankRevSum > 0) {
      period.revenue = period._bankRevSum;
    }

    if (period.grossProfit == null && period.revenue != null && period.costOfRevenue != null) {
      period.grossProfit = period.revenue - period.costOfRevenue;
    }
    if (period.operatingExpenses == null && period.grossProfit != null && period.operatingIncome != null) {
      // OperatingIncome ≈ GrossProfit - OperatingExpenses
      period.operatingExpenses = period.grossProfit - period.operatingIncome;
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
    period.longTermDebt = period.totalDebtComponents.longTermDebt ?? null;
    if (period.longTermDebt == null && period.totalDebt != null && period.shortTermDebt != null) {
      // Best-effort fallback: treat LT debt as total debt less ST debt and lease liabilities (when available).
      const lease = Number.isFinite(period.leaseLiabilities) ? Number(period.leaseLiabilities) : 0;
      const debt = Number(period.totalDebt);
      const stDebt = Number(period.shortTermDebt);
      if (Number.isFinite(debt) && Number.isFinite(stDebt)) {
        const inferred = debt - lease - stDebt;
        if (Number.isFinite(inferred)) period.longTermDebt = Math.max(0, inferred);
      }
    }
    if (debtSum && (period.totalDebt == null || debtSum > period.totalDebt)) {
      period.totalDebt = debtSum;
    }

    if (period.deposits == null) {
      period.deposits =
        period.totalDeposits ??
        period.customerDeposits ??
        period.depositLiabilities ??
        null;
    }

    // Deferred Revenue / Contract Liabilities can be split into current + noncurrent;
    // prefer the total tag, otherwise sum parts when both exist.
    period.deferredRevenue = derivePointInTimeTotal(
      period.deferredRevenue,
      period._deferredRevenueTotal,
      period._deferredRevenueCurrent,
      period._deferredRevenueNoncurrent
    );
    period.contractWithCustomerLiability = derivePointInTimeTotal(
      period.contractWithCustomerLiability,
      period._contractWithCustomerLiabilityTotal,
      period._contractWithCustomerLiabilityCurrent,
      period._contractWithCustomerLiabilityNoncurrent
    );

    if (period.deferredRevenue == null) period.deferredRevenue = period.contractWithCustomerLiability ?? null;
    if (period.contractWithCustomerLiability == null) period.contractWithCustomerLiability = period.deferredRevenue ?? null;

    if (period.technologyExpenses == null) {
      const rd = Number.isFinite(period.researchAndDevelopmentExpenses)
        ? Number(period.researchAndDevelopmentExpenses)
        : null;
      const sw = Number.isFinite(period.softwareExpenses) ? Number(period.softwareExpenses) : null;
      if (rd != null || sw != null) {
        period.technologyExpenses = (rd ?? 0) + (sw ?? 0);
      }
    }
  }

  // Filter to recent quarters (default ~3 years) and enough annual history for 3Y CAGR.
  const arr = Array.from(periods.values()).filter((p) => p.periodEnd);
  arr.sort((a, b) => Date.parse(b.periodEnd) - Date.parse(a.periodEnd));
  // EDGAR can include "as-of" points keyed as quarters (often shares-only rows).
  // Prefer statement-bearing quarters so YoY/trend logic isn't starved by placeholders.
  const quarterCandidates = arr.filter((p) => p.periodType === "quarter");
  const meaningfulQuarters = quarterCandidates.filter(
    (p) =>
      Number.isFinite(p.revenue) ||
      Number.isFinite(p.netIncome) ||
      Number.isFinite(p.totalAssets) ||
      Number.isFinite(p.currentAssets) ||
      Number.isFinite(p.currentLiabilities) ||
      Number.isFinite(p.accountsReceivable) ||
      Number.isFinite(p.operatingExpenses) ||
      Number.isFinite(p.interestIncome) ||
      Number.isFinite(p.interestExpense) ||
      Number.isFinite(p.deposits) ||
      Number.isFinite(p.customerDeposits) ||
      Number.isFinite(p.totalDeposits) ||
      Number.isFinite(p.depositLiabilities) ||
      Number.isFinite(p.operatingCashFlow) ||
      Number.isFinite(p.capex) ||
      Number.isFinite(p.freeCashFlow) ||
      Number.isFinite(p.cashAndCashEquivalents)
  );
  const quarters = meaningfulQuarters.slice(0, QUARTERS_TO_KEEP);
  // Retain enough annual points to support 3Y CAGR even when quarter history is present.
  const yearsAll = arr.filter((p) => p.periodType === "year");
  const meaningfulYears = yearsAll.filter(
    (p) => Number.isFinite(p.revenue) || Number.isFinite(p.totalAssets) || Number.isFinite(p.operatingCashFlow)
  );
  const years = meaningfulYears.slice(0, YEARS_TO_KEEP);
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

export async function fetchCompanyFundamentals(ticker, opts = {}) {
  if (!ticker) throw new Error("ticker is required");
  const match = opts.company || (await lookupCompanyByTicker(ticker));
  const cik = normalizeCik(opts.cik ?? match?.cik);
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
    console.warn("[edgarFundamentals] no fundamentals parsed from companyfacts for", ticker.toUpperCase());
    return [];
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

export async function fetchCompanySubmissions(ticker, opts = {}) {
  const company = opts.company || (await lookupCompanyByTicker(ticker));
  const cik = normalizeCik(opts.cik ?? company?.cik);
  if (!cik) throw new Error("CIK not found for ticker");
  const submissionsUrl = `${SEC_BASE}/submissions/CIK${cik}.json`;
  const submissions = opts.submissions || (await limitedFetchJson(submissionsUrl));
  return { submissions, cik, company };
}

// Lightweight exports for other EDGAR helpers
export { limitedFetchJson, limitedFetch, lookupCompanyByTicker };
