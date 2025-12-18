import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const DB_DIR = path.join(ROOT, "data", "edgar");
const DB_FILE = path.join(DB_DIR, "fundamentals.db");
const REQUIRED_ADDITIONAL_COLUMNS = {
  companyName: "TEXT",
  sector: "TEXT",
  sic: "INTEGER",
  sicDescription: "TEXT",
  grossProfit: "REAL",
  costOfRevenue: "REAL",
  operatingExpenses: "REAL",
  operatingIncome: "REAL",
  incomeBeforeIncomeTaxes: "REAL",
  incomeTaxExpenseBenefit: "REAL",
  epsDiluted: "REAL",
  sharesOutstanding: "REAL",
  cashAndCashEquivalents: "REAL",
  freeCashFlow: "REAL",
  shareBasedCompensation: "REAL",
  researchAndDevelopmentExpenses: "REAL",
  technologyExpenses: "REAL",
  softwareExpenses: "REAL",
  depreciationDepletionAndAmortization: "REAL",
  interestIncome: "REAL",
  shortTermDebt: "REAL",
  longTermDebt: "REAL",
  leaseLiabilities: "REAL",
  currentAssets: "REAL",
  currentLiabilities: "REAL",
  shortTermInvestments: "REAL",
  interestExpense: "REAL",
  financialDebt: "REAL",
  deposits: "REAL",
  customerDeposits: "REAL",
  totalDeposits: "REAL",
  depositLiabilities: "REAL",
  deferredRevenue: "REAL",
  contractWithCustomerLiability: "REAL",
  treasuryStockRepurchased: "REAL",
  dividendsPaid: "REAL",
  accountsReceivable: "REAL",
  inventories: "REAL",
  accountsPayable: "REAL"
};

let dbPromise = null;

function ensureAuxTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS edgar_tickers (
      ticker TEXT PRIMARY KEY,
      cik TEXT,
      last_checked_at TEXT,
      last_filing_date TEXT,
      last_filing_type TEXT,
      is_active INTEGER DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_edgar_tickers_checked ON edgar_tickers (last_checked_at);
    CREATE INDEX IF NOT EXISTS idx_edgar_tickers_filing_date ON edgar_tickers (last_filing_date);

    CREATE TABLE IF NOT EXISTS filing_events (
      id INTEGER PRIMARY KEY,
      ticker TEXT,
      filing_type TEXT,
      filing_date TEXT,
      accession TEXT,
      headline TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_filing_events_date ON filing_events (filing_date DESC, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_filing_events_ticker ON filing_events (ticker);
  `);
}

function ensureColumns(db) {
  const existing = new Set(db.prepare("PRAGMA table_info(fundamentals)").all().map((c) => c.name));
  for (const [name, type] of Object.entries(REQUIRED_ADDITIONAL_COLUMNS)) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE fundamentals ADD COLUMN ${name} ${type}`);
    }
  }
}

async function initDb() {
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    fs.mkdirSync(DB_DIR, { recursive: true });
    let Database;
    try {
      ({ default: Database } = await import("better-sqlite3"));
    } catch (err) {
      const e = new Error(
        "better-sqlite3 is required for EDGAR persistence. Install with `npm install better-sqlite3`."
      );
      e.cause = err;
      throw e;
    }
    const db = new Database(DB_FILE);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS fundamentals (
        id INTEGER PRIMARY KEY,
        ticker TEXT NOT NULL,
        cik TEXT NOT NULL,
        companyName TEXT,
        sector TEXT,
        sic INTEGER,
        sicDescription TEXT,
        periodType TEXT NOT NULL,
        periodEnd TEXT NOT NULL,
        filedDate TEXT NOT NULL,
        currency TEXT,
        revenue REAL,
        grossProfit REAL,
        costOfRevenue REAL,
        operatingIncome REAL,
        incomeBeforeIncomeTaxes REAL,
        incomeTaxExpenseBenefit REAL,
        netIncome REAL,
        epsBasic REAL,
      epsDiluted REAL,
      totalAssets REAL,
      totalLiabilities REAL,
      totalEquity REAL,
      totalDebt REAL,
      financialDebt REAL,
      shortTermDebt REAL,
      leaseLiabilities REAL,
      shortTermInvestments REAL,
      interestExpense REAL,
      operatingCashFlow REAL,
      capex REAL,
      shareBasedCompensation REAL,
      researchAndDevelopmentExpenses REAL,
      treasuryStockRepurchased REAL,
      dividendsPaid REAL,
      accountsReceivable REAL,
      inventories REAL,
      accountsPayable REAL,
      sharesOutstanding REAL,
      cashAndCashEquivalents REAL,
      freeCashFlow REAL,
      source TEXT DEFAULT 'edgar',
      createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS fundamentals_unique_period
        ON fundamentals (ticker, periodType, periodEnd);
    `);
    ensureColumns(db);
    ensureAuxTables(db);
    return db;
  })();
  return dbPromise;
}

export async function getDb() {
  return initDb();
}

export async function upsertFundamentals(periods) {
  if (!Array.isArray(periods) || periods.length === 0) return;
  const db = await initDb();
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO fundamentals (
      ticker, cik, companyName, sector, sic, sicDescription, periodType, periodEnd, filedDate, currency,
      revenue, grossProfit, costOfRevenue, operatingExpenses, operatingIncome, incomeBeforeIncomeTaxes, incomeTaxExpenseBenefit, netIncome, epsBasic, epsDiluted,
      totalAssets, currentAssets, totalLiabilities, currentLiabilities, totalEquity, totalDebt, financialDebt, shortTermDebt, longTermDebt, leaseLiabilities, shortTermInvestments, interestIncome, interestExpense,
      operatingCashFlow, capex, freeCashFlow, shareBasedCompensation, researchAndDevelopmentExpenses,
      technologyExpenses, softwareExpenses, depreciationDepletionAndAmortization,
      treasuryStockRepurchased, dividendsPaid, accountsReceivable, inventories, accountsPayable,
      deposits, customerDeposits, totalDeposits, depositLiabilities,
      sharesOutstanding, cashAndCashEquivalents,
      deferredRevenue, contractWithCustomerLiability,
      source, createdAt, updatedAt
    ) VALUES (
      @ticker, @cik, @companyName, @sector, @sic, @sicDescription, @periodType, @periodEnd, @filedDate, @currency,
      @revenue, @grossProfit, @costOfRevenue, @operatingExpenses, @operatingIncome, @incomeBeforeIncomeTaxes, @incomeTaxExpenseBenefit, @netIncome, @epsBasic, @epsDiluted,
      @totalAssets, @currentAssets, @totalLiabilities, @currentLiabilities, @totalEquity, @totalDebt, @financialDebt, @shortTermDebt, @longTermDebt, @leaseLiabilities, @shortTermInvestments, @interestIncome, @interestExpense,
      @operatingCashFlow, @capex, @freeCashFlow, @shareBasedCompensation, @researchAndDevelopmentExpenses,
      @technologyExpenses, @softwareExpenses, @depreciationDepletionAndAmortization,
      @treasuryStockRepurchased, @dividendsPaid, @accountsReceivable, @inventories, @accountsPayable,
      @deposits, @customerDeposits, @totalDeposits, @depositLiabilities,
      @sharesOutstanding, @cashAndCashEquivalents,
      @deferredRevenue, @contractWithCustomerLiability,
      @source, @createdAt, @updatedAt
    )
    ON CONFLICT(ticker, periodType, periodEnd) DO UPDATE SET
      companyName=excluded.companyName,
      sector=excluded.sector,
      sic=excluded.sic,
      sicDescription=excluded.sicDescription,
      filedDate=excluded.filedDate,
      currency=excluded.currency,
      revenue=excluded.revenue,
      grossProfit=excluded.grossProfit,
      costOfRevenue=excluded.costOfRevenue,
      operatingExpenses=excluded.operatingExpenses,
      operatingIncome=excluded.operatingIncome,
      incomeBeforeIncomeTaxes=excluded.incomeBeforeIncomeTaxes,
      incomeTaxExpenseBenefit=excluded.incomeTaxExpenseBenefit,
      netIncome=excluded.netIncome,
      epsBasic=excluded.epsBasic,
      epsDiluted=excluded.epsDiluted,
      totalAssets=excluded.totalAssets,
      currentAssets=excluded.currentAssets,
      totalLiabilities=excluded.totalLiabilities,
      currentLiabilities=excluded.currentLiabilities,
      totalEquity=excluded.totalEquity,
      totalDebt=excluded.totalDebt,
      financialDebt=excluded.financialDebt,
      shortTermDebt=excluded.shortTermDebt,
      longTermDebt=excluded.longTermDebt,
      leaseLiabilities=excluded.leaseLiabilities,
      shortTermInvestments=excluded.shortTermInvestments,
      interestIncome=excluded.interestIncome,
      interestExpense=excluded.interestExpense,
      operatingCashFlow=excluded.operatingCashFlow,
      capex=excluded.capex,
      shareBasedCompensation=excluded.shareBasedCompensation,
      researchAndDevelopmentExpenses=excluded.researchAndDevelopmentExpenses,
      technologyExpenses=excluded.technologyExpenses,
      softwareExpenses=excluded.softwareExpenses,
      depreciationDepletionAndAmortization=excluded.depreciationDepletionAndAmortization,
      treasuryStockRepurchased=excluded.treasuryStockRepurchased,
      dividendsPaid=excluded.dividendsPaid,
      accountsReceivable=excluded.accountsReceivable,
      inventories=excluded.inventories,
      accountsPayable=excluded.accountsPayable,
      deposits=excluded.deposits,
      customerDeposits=excluded.customerDeposits,
      totalDeposits=excluded.totalDeposits,
      depositLiabilities=excluded.depositLiabilities,
      deferredRevenue=excluded.deferredRevenue,
      contractWithCustomerLiability=excluded.contractWithCustomerLiability,
      freeCashFlow=excluded.freeCashFlow,
      sharesOutstanding=excluded.sharesOutstanding,
      cashAndCashEquivalents=excluded.cashAndCashEquivalents,
      source=excluded.source,
      updatedAt=excluded.updatedAt;
  `);
  const rows = periods.map((p) => ({
    ...p,
    source: "edgar",
    createdAt: now,
    updatedAt: now
  }));
  const tx = db.transaction((list) => list.forEach((row) => stmt.run(row)));
  tx(rows);

  try {
    const [first] = rows;
    if (first?.ticker) {
      const outPath = path.join(DB_DIR, `${first.ticker.toUpperCase()}-fundamentals.json`);
      let existing = {};
      try {
        if (fs.existsSync(outPath)) {
          existing = JSON.parse(fs.readFileSync(outPath, "utf8"));
        }
      } catch (err) {
        console.warn("[fundamentalsStore] failed to read existing JSON snapshot", err?.message || err);
      }
      const payload = {
        ...existing,
        ticker: first.ticker,
        cik: first.cik,
        companyName: first.companyName || null,
        sector: first.sector || null,
        sic: first.sic ?? null,
        sicDescription: first.sicDescription || null,
        currency: first.currency || null,
        updatedAt: now,
        periods: rows.map((p) => ({
          periodType: p.periodType,
          periodEnd: p.periodEnd,
          filedDate: p.filedDate,
          revenue: p.revenue ?? null,
          grossProfit: p.grossProfit ?? null,
          costOfRevenue: p.costOfRevenue ?? null,
          operatingExpenses: p.operatingExpenses ?? null,
          operatingIncome: p.operatingIncome ?? null,
          incomeBeforeIncomeTaxes: p.incomeBeforeIncomeTaxes ?? null,
          incomeTaxExpenseBenefit: p.incomeTaxExpenseBenefit ?? null,
          netIncome: p.netIncome ?? null,
          epsBasic: p.epsBasic ?? null,
          epsDiluted: p.epsDiluted ?? null,
          totalAssets: p.totalAssets ?? null,
          currentAssets: p.currentAssets ?? null,
          totalLiabilities: p.totalLiabilities ?? null,
          currentLiabilities: p.currentLiabilities ?? null,
          totalEquity: p.totalEquity ?? null,
          totalDebt: p.totalDebt ?? null,
          financialDebt: p.financialDebt ?? null,
          shortTermDebt: p.shortTermDebt ?? null,
          longTermDebt: p.longTermDebt ?? null,
          leaseLiabilities: p.leaseLiabilities ?? null,
          shortTermInvestments: p.shortTermInvestments ?? null,
          interestIncome: p.interestIncome ?? null,
          interestExpense: p.interestExpense ?? null,
          deposits: p.deposits ?? null,
          customerDeposits: p.customerDeposits ?? null,
          totalDeposits: p.totalDeposits ?? null,
          depositLiabilities: p.depositLiabilities ?? null,
          technologyExpenses: p.technologyExpenses ?? null,
          softwareExpenses: p.softwareExpenses ?? null,
          depreciationDepletionAndAmortization: p.depreciationDepletionAndAmortization ?? null,
          deferredRevenue: p.deferredRevenue ?? null,
          contractWithCustomerLiability: p.contractWithCustomerLiability ?? null,
          sector: p.sector ?? null,
          sic: p.sic ?? null,
          sicDescription: p.sicDescription ?? null,
          sharesOutstanding: p.sharesOutstanding ?? null,
          cashAndCashEquivalents: p.cashAndCashEquivalents ?? null,
          operatingCashFlow: p.operatingCashFlow ?? null,
          capex: p.capex ?? null,
          freeCashFlow: p.freeCashFlow ?? null,
          treasuryStockRepurchased: p.treasuryStockRepurchased ?? null,
          dividendsPaid: p.dividendsPaid ?? null,
          accountsReceivable: p.accountsReceivable ?? null,
          inventories: p.inventories ?? null,
          accountsPayable: p.accountsPayable ?? null
        }))
      };
      if (existing?.filingSignals) payload.filingSignals = existing.filingSignals;
      if (existing?.filingSignalsMeta) payload.filingSignalsMeta = existing.filingSignalsMeta;
      if (existing?.filingSignalsCachedAt) payload.filingSignalsCachedAt = existing.filingSignalsCachedAt;
      fs.writeFileSync(outPath, JSON.stringify(payload));
    }
  } catch (err) {
    console.warn("[fundamentalsStore] failed to write JSON snapshot", err?.message || err);
  }
}

export async function getFundamentalsForTicker(ticker) {
  if (!ticker) return [];
  const db = await initDb();
  const rows = db
    .prepare(
      `SELECT ticker, cik, companyName, sector, sic, sicDescription, periodType, periodEnd, filedDate, currency,
              revenue, grossProfit, costOfRevenue, operatingExpenses, operatingIncome, incomeBeforeIncomeTaxes, incomeTaxExpenseBenefit, netIncome, epsBasic, epsDiluted,
              totalAssets, currentAssets, totalLiabilities, currentLiabilities, totalEquity, totalDebt, financialDebt, shortTermDebt, longTermDebt, leaseLiabilities, shortTermInvestments, interestIncome, interestExpense,
              operatingCashFlow, capex,
              shareBasedCompensation, researchAndDevelopmentExpenses,
              technologyExpenses, softwareExpenses, depreciationDepletionAndAmortization,
              treasuryStockRepurchased, dividendsPaid, accountsReceivable, inventories, accountsPayable,
              deposits, customerDeposits, totalDeposits, depositLiabilities,
              deferredRevenue, contractWithCustomerLiability,
              sharesOutstanding, cashAndCashEquivalents, freeCashFlow, createdAt, updatedAt
       FROM fundamentals
       WHERE ticker = @ticker
       ORDER BY periodEnd DESC`
    )
    .all({ ticker: ticker.toUpperCase() });
  if (!rows || rows.length === 0) {
    console.log("[fundamentalsStore] no fundamentals in DB for", ticker);
  } else {
    const ends = rows.map((r) => r.periodEnd).filter(Boolean).sort();
    console.log(
      "[fundamentalsStore] fundamentals rows",
      rows.length,
      "range",
      ends[0],
      ends[ends.length - 1],
      "for",
      ticker
    );
  }
    return rows.map((r) => ({
    ...r,
    ticker: r.ticker.toUpperCase(),
    companyName: r.companyName || null,
    sector: r.sector || null,
    sic: r.sic ?? null,
    sicDescription: r.sicDescription || null,
    periodType: r.periodType,
    periodEnd: r.periodEnd,
    filedDate: r.filedDate,
    currency: r.currency,
    revenue: r.revenue,
    netIncome: r.netIncome,
    epsBasic: r.epsBasic,
    grossProfit: r.grossProfit,
    costOfRevenue: r.costOfRevenue,
    operatingExpenses: r.operatingExpenses,
    operatingIncome: r.operatingIncome,
    incomeBeforeIncomeTaxes: r.incomeBeforeIncomeTaxes,
    incomeTaxExpenseBenefit: r.incomeTaxExpenseBenefit,
    epsDiluted: r.epsDiluted,
    sharesOutstanding: r.sharesOutstanding,
    cashAndCashEquivalents: r.cashAndCashEquivalents,
    totalAssets: r.totalAssets,
    currentAssets: r.currentAssets,
    totalLiabilities: r.totalLiabilities,
    currentLiabilities: r.currentLiabilities,
    totalEquity: r.totalEquity,
    totalDebt: r.totalDebt,
    financialDebt: r.financialDebt,
    shortTermDebt: r.shortTermDebt,
    longTermDebt: r.longTermDebt,
    leaseLiabilities: r.leaseLiabilities,
    shortTermInvestments: r.shortTermInvestments,
    interestIncome: r.interestIncome,
    interestExpense: r.interestExpense,
      shareBasedCompensation: r.shareBasedCompensation,
      researchAndDevelopmentExpenses: r.researchAndDevelopmentExpenses,
      technologyExpenses: r.technologyExpenses,
      softwareExpenses: r.softwareExpenses,
      depreciationDepletionAndAmortization: r.depreciationDepletionAndAmortization,
      treasuryStockRepurchased: r.treasuryStockRepurchased,
      dividendsPaid: r.dividendsPaid,
      accountsReceivable: r.accountsReceivable,
      inventories: r.inventories,
      accountsPayable: r.accountsPayable,
      deposits: r.deposits,
      customerDeposits: r.customerDeposits,
      totalDeposits: r.totalDeposits,
      depositLiabilities: r.depositLiabilities,
      deferredRevenue: r.deferredRevenue,
      contractWithCustomerLiability: r.contractWithCustomerLiability,
      freeCashFlow: r.freeCashFlow,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt
    }));
}

export async function getFundamentalsFreshness(ticker, maxAgeMs) {
  const rows = await getFundamentalsForTicker(ticker);
  let latestUpdated = null;
  for (const row of rows) {
    if (!row.updatedAt) continue;
    if (!latestUpdated || Date.parse(row.updatedAt) > Date.parse(latestUpdated)) {
      latestUpdated = row.updatedAt;
    }
  }
  const isFresh = latestUpdated ? Date.now() - Date.parse(latestUpdated) < (maxAgeMs ?? Infinity) : false;
  return { rows, latestUpdated, isFresh };
}
