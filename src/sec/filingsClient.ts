import { CompanyDirectory, normalizeCik } from "./companyDirectory.js";
import { SecHttpClient } from "./httpClient.js";
import {
  FilingFilterOptions,
  FilingIndexJson,
  RecentFiling,
  RecentFilingsRaw,
  SubmissionsJson,
} from "./types.js";

const SUBMISSIONS_BASE = "https://data.sec.gov/submissions/CIK";
const ARCHIVES_BASE = "https://data.sec.gov/Archives/edgar/data/";

export class FilingsClient {
  private client: SecHttpClient;
  private directory: CompanyDirectory;

  constructor(client: SecHttpClient, directory: CompanyDirectory) {
    this.client = client;
    this.directory = directory;
  }

  async getSubmissionsByCik(cik: string | number): Promise<SubmissionsJson> {
    const padded = normalizeCik(cik);
    const url = `${SUBMISSIONS_BASE}${padded}.json`;
    return this.client.getJson<SubmissionsJson>(url);
  }

  async getSubmissionsByTicker(ticker: string): Promise<SubmissionsJson> {
    const match = await this.directory.findByTicker(ticker);
    if (!match) {
      throw new Error(`Ticker not found in directory: ${ticker}`);
    }
    return this.getSubmissionsByCik(match.cik);
  }

  async getFilingIndex(cik: string | number, accessionNumber: string): Promise<FilingIndexJson> {
    const padded = normalizeCik(cik);
    const cikPath = padded.replace(/^0+/, "") || "0";
    const accession = accessionNumber.includes("-") ? accessionNumber : addAccessionDashes(accessionNumber);
    const accessionNoDashes = accession.replace(/-/g, "");

    const url = `${ARCHIVES_BASE}${cikPath}/${accessionNoDashes}/${accession}-index.json`;
    return this.client.getJson<FilingIndexJson>(url);
  }
}

export const buildRecentFilings = (recent?: RecentFilingsRaw): RecentFiling[] => {
  if (!recent) return [];
  const filings: RecentFiling[] = [];
  const maxLen = Math.max(
    recent.accessionNumber?.length ?? 0,
    recent.filingDate?.length ?? 0,
    recent.form?.length ?? 0,
  );

  for (let i = 0; i < maxLen; i += 1) {
    const filing: RecentFiling = {
      accessionNumber: recent.accessionNumber?.[i] ?? "",
      filingDate: recent.filingDate?.[i] ?? "",
      form: recent.form?.[i],
      reportDate: recent.reportDate?.[i],
      acceptanceDateTime: recent.acceptanceDateTime?.[i],
      primaryDocument: recent.primaryDocument?.[i],
      primaryDocDescription: recent.primaryDocDescription?.[i],
    };
    filings.push(filing);
  }

  return filings;
};

export const filterRecentFilings = (recent: RecentFiling[], opts: FilingFilterOptions = {}): RecentFiling[] => {
  const forms = opts.forms?.map((f) => f.toUpperCase());
  const fromDate = opts.from;
  const toDate = opts.to;
  let result = recent;

  if (forms?.length) {
    result = result.filter((f) => (f.form ? forms.includes(f.form.toUpperCase()) : false));
  }

  if (fromDate) {
    result = result.filter((f) => !f.filingDate || f.filingDate >= fromDate);
  }

  if (toDate) {
    result = result.filter((f) => !f.filingDate || f.filingDate <= toDate);
  }

  if (opts.limit && opts.limit > 0) {
    result = result.slice(0, opts.limit);
  }

  return result;
};

const addAccessionDashes = (accession: string): string => {
  // Accession numbers are typically 10-2-6 digits (CIK + YY + sequence)
  if (accession.includes("-")) return accession;
  const trimmed = accession.trim();
  if (trimmed.length !== 20) return trimmed;
  const part1 = trimmed.slice(0, 10);
  const part2 = trimmed.slice(10, 12);
  const part3 = trimmed.slice(12);
  return `${part1}-${part2}-${part3}`;
};
