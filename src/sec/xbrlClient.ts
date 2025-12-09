import { normalizeCik } from "./companyDirectory.js";
import { SecHttpClient } from "./httpClient.js";
import { CompanyConcept, CompanyFacts, FactUnit, Frame } from "./types.js";

const XBRL_BASE = "https://data.sec.gov/api/xbrl/";

export class XbrlClient {
  private client: SecHttpClient;

  constructor(client: SecHttpClient) {
    this.client = client;
  }

  async getCompanyFacts(cik: string | number): Promise<CompanyFacts> {
    const cikPadded = normalizeCik(cik);
    const url = `${XBRL_BASE}companyfacts/CIK${cikPadded}.json`;
    return this.client.getJson<CompanyFacts>(url);
  }

  async getCompanyConcept(cik: string | number, taxonomy: string, tag: string): Promise<CompanyConcept> {
    const cikPadded = normalizeCik(cik);
    const url = `${XBRL_BASE}companyconcept/CIK${cikPadded}/${taxonomy}/${tag}.json`;
    return this.client.getJson<CompanyConcept>(url);
  }

  async getFrame(taxonomy: string, tag: string, unit: string, period: string): Promise<Frame> {
    const url = `${XBRL_BASE}frames/${taxonomy}/${tag}/${unit}/${period}.json`;
    return this.client.getJson<Frame>(url);
  }
}

export const filterUnits = (units: Record<string, FactUnit[]> | undefined, unit: string): Record<string, FactUnit[]> => {
  if (!units || !units[unit]) return {};
  return { [unit]: units[unit] };
};
