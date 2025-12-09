import { CompanyDirectory } from "./companyDirectory.js";
import { SecHttpClient } from "./httpClient.js";
import { FilingsClient, buildRecentFilings, filterRecentFilings } from "./filingsClient.js";
import { XbrlClient } from "./xbrlClient.js";
import { FilingFilterOptions, FilingIndexJson, RecentFiling, SubmissionsJson, CompanyConcept, CompanyFacts, Frame } from "./types.js";

export interface EdgarClientOptions {
  userAgent: string;
  baseDelayMs?: number;
  maxRetries?: number;
}

export class EdgarClient {
  private http: SecHttpClient;
  private directory: CompanyDirectory;
  private filings: FilingsClient;
  private xbrl: XbrlClient;

  constructor(options: EdgarClientOptions) {
    this.http = new SecHttpClient({
      userAgent: options.userAgent,
      baseDelayMs: options.baseDelayMs,
      maxRetries: options.maxRetries,
    });
    this.directory = new CompanyDirectory(this.http);
    this.filings = new FilingsClient(this.http, this.directory);
    this.xbrl = new XbrlClient(this.http);
  }

  getCompanyDirectory(): CompanyDirectory {
    return this.directory;
  }

  async getSubmissionsByTicker(ticker: string): Promise<SubmissionsJson> {
    return this.filings.getSubmissionsByTicker(ticker);
  }

  async getSubmissionsByCik(cik: string | number): Promise<SubmissionsJson> {
    return this.filings.getSubmissionsByCik(cik);
  }

  async getRecentFilingsByTicker(ticker: string, options: FilingFilterOptions = {}): Promise<RecentFiling[]> {
    const submissions = await this.getSubmissionsByTicker(ticker);
    const recent = buildRecentFilings(submissions.filings?.recent);
    return filterRecentFilings(recent, options);
  }

  async getRecentFilingsByCik(cik: string | number, options: FilingFilterOptions = {}): Promise<RecentFiling[]> {
    const submissions = await this.getSubmissionsByCik(cik);
    const recent = buildRecentFilings(submissions.filings?.recent);
    return filterRecentFilings(recent, options);
  }

  async getFilingIndexByTicker(ticker: string, accessionNumber: string): Promise<FilingIndexJson> {
    const match = await this.directory.findByTicker(ticker);
    if (!match) {
      throw new Error(`Ticker not found in directory: ${ticker}`);
    }
    return this.filings.getFilingIndex(match.cik, accessionNumber);
  }

  async getFilingIndexByCik(cik: string | number, accessionNumber: string): Promise<FilingIndexJson> {
    return this.filings.getFilingIndex(cik, accessionNumber);
  }

  async getCompanyFactsByTicker(ticker: string): Promise<CompanyFacts> {
    const match = await this.directory.findByTicker(ticker);
    if (!match) {
      throw new Error(`Ticker not found in directory: ${ticker}`);
    }
    return this.xbrl.getCompanyFacts(match.cik);
  }

  async getCompanyFactsByCik(cik: string | number): Promise<CompanyFacts> {
    return this.xbrl.getCompanyFacts(cik);
  }

  async getCompanyConceptByTicker(ticker: string, taxonomy: string, tag: string): Promise<CompanyConcept> {
    const match = await this.directory.findByTicker(ticker);
    if (!match) {
      throw new Error(`Ticker not found in directory: ${ticker}`);
    }
    return this.xbrl.getCompanyConcept(match.cik, taxonomy, tag);
  }

  async getCompanyConceptByCik(cik: string | number, taxonomy: string, tag: string): Promise<CompanyConcept> {
    return this.xbrl.getCompanyConcept(cik, taxonomy, tag);
  }

  async getFrame(taxonomy: string, tag: string, unit: string, period: string): Promise<Frame> {
    return this.xbrl.getFrame(taxonomy, tag, unit, period);
  }
}

/*
Example usage:

import { EdgarClient } from "./sec/index.js";

const edgar = new EdgarClient({ userAgent: "BullishAndFoolish/1.0 (freelancer.bg@gmail.com)" });

const filings = await edgar.getRecentFilingsByTicker("AAPL", { forms: ["10-K", "10-Q"], limit: 5 });
const revenue = await edgar.getCompanyConceptByTicker("AAPL", "us-gaap", "Revenues");
*/
