/**
 * Quick EDGAR smoke test (Node + TypeScript).
 * - Fetches a company by ticker (default: AAPL)
 * - Pulls recent 10-K/10-Q submissions
 * - Fetches XBRL facts and surfaces revenue, net income, total assets, total liabilities
 *
 * Run (requires ts-node/tsx or similar):
 *   EDGAR_USER_AGENT="BullishAndFoolish/1.0 (freelancer.bg@gmail.com)" ts-node scripts/edgarTest.ts AAPL
 */

import { EdgarClient } from "../src/sec/index.js";

type FactUnit = { val: number; end?: string; filed?: string; form?: string; fy?: number; fp?: string };

const USER_AGENT =
  process.env.EDGAR_USER_AGENT ||
  process.env.DATA_USER_AGENT ||
  process.env.SEC_EDGAR_TOOLKIT_USER_AGENT ||
  "BullishAndFoolish/1.0 (freelancer.bg@gmail.com)";

async function main() {
  const ticker = (process.argv[2] || "AAPL").toUpperCase();
  const client = new EdgarClient({
    userAgent: USER_AGENT,
    baseDelayMs: 400, // ~2.5 req/s to stay well below SEC cap
    maxRetries: 3
  });

  const directory = client.getCompanyDirectory();
  const company = await directory.findByTicker(ticker);
  if (!company?.cik) {
    console.error(`No company found for ticker ${ticker}`);
    process.exit(1);
  }

  const cik = company.cik;
  console.log(`Using CIK ${cik} for ${company.name}`);

  const submissions = await client.getSubmissionsByCik(cik);
  const recent = submissions.filings?.recent;
  const filings =
    recent?.form?.map((form: string, idx: number) => ({
      form,
      accession: recent.accessionNumber?.[idx],
      filed: recent.filingDate?.[idx],
      report: recent.reportDate?.[idx]
    })) || [];

  const latest10x = filings.filter((f: any) => f.form === "10-K" || f.form === "10-Q").slice(0, 2);
  console.log("Recent filings (10-K/10-Q):");
  latest10x.forEach((f: any) => console.log(`- ${f.form} ${f.filed} (${f.accession})`));

  const facts = await client.getCompanyFactsByCik(cik);
  const metrics = {
    revenue: pickFact(facts, ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet"]),
    netIncome: pickFact(facts, ["NetIncomeLoss"]),
    totalAssets: pickFact(facts, ["Assets"]),
    totalLiabilities: pickFact(facts, ["Liabilities"])
  };

  console.log("\nKey metrics (latest USD fact):");
  Object.entries(metrics).forEach(([label, fact]) => {
    if (!fact) {
      console.log(`- ${label}: n/a`);
      return;
    }
    const { val, end, filed, form, fy, fp } = fact;
    console.log(
      `- ${label}: ${val?.toLocaleString()} (form ${form || "?"}, period ${fp || ""}${fy || ""} end ${end || "?"}, filed ${filed || "?"})`
    );
  });
}

function pickFact(facts: any, tags: string[]) {
  const gaap = facts?.facts?.["us-gaap"];
  if (!gaap) return null;
  for (const tag of tags) {
    const fact = gaap[tag];
    const best = selectLatest(fact);
    if (best) return best;
  }
  return null;
}

function selectLatest(fact: any): FactUnit | null {
  if (!fact?.units) return null;
  const units = fact.units.USD || Object.values(fact.units)[0];
  if (!Array.isArray(units) || !units.length) return null;
  const sorted = [...units].sort((a: FactUnit, b: FactUnit) => {
    const aEnd = Date.parse(a.end || "") || 0;
    const bEnd = Date.parse(b.end || "") || 0;
    if (aEnd !== bEnd) return bEnd - aEnd;
    const aFiled = Date.parse(a.filed || "") || 0;
    const bFiled = Date.parse(b.filed || "") || 0;
    return bFiled - aFiled;
  });
  return sorted[0];
}

main().catch((err) => {
  console.error("EDGAR test failed:", err);
  process.exit(1);
});
