import { SecHttpClient } from "./httpClient.js";
import { CompanyDirectoryEntry, CompanyDirectoryResponse } from "./types.js";

const COMPANY_TICKERS_URL = "https://www.sec.gov/files/company_tickers_exchange.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export const normalizeCik = (cik: string | number): string => {
  const numeric = String(cik).replace(/\D/g, "");
  return numeric.padStart(10, "0");
};

export class CompanyDirectory {
  private client: SecHttpClient;
  private cache?: { fetchedAt: number; entries: CompanyDirectoryEntry[] };

  constructor(client: SecHttpClient) {
    this.client = client;
  }

  private isCacheValid(): boolean {
    if (!this.cache) return false;
    return Date.now() - this.cache.fetchedAt < CACHE_TTL_MS;
  }

  private async load(): Promise<CompanyDirectoryEntry[]> {
    if (this.isCacheValid()) {
      return this.cache!.entries;
    }

    const raw = await this.client.getJson<CompanyDirectoryResponse>(COMPANY_TICKERS_URL);
    const entries: CompanyDirectoryEntry[] = [];

    const cikIdx = raw.fields.indexOf("cik");
    const nameIdx = raw.fields.indexOf("name");
    const tickerIdx = raw.fields.indexOf("ticker");
    const exchangeIdx = raw.fields.indexOf("exchange");

    for (const row of raw.data) {
      const cik = row[cikIdx];
      const name = row[nameIdx];
      const ticker = row[tickerIdx];
      const exchange = exchangeIdx >= 0 ? row[exchangeIdx] : null;

      if (cik == null || name == null || ticker == null) continue;
      entries.push({
        cik: normalizeCik(cik),
        name: String(name),
        ticker: String(ticker).toUpperCase(),
        exchange: exchange == null ? null : String(exchange),
      });
    }

    this.cache = { fetchedAt: Date.now(), entries };
    return entries;
  }

  async findByTicker(ticker: string): Promise<CompanyDirectoryEntry | null> {
    const entries = await this.load();
    const match = entries.find((entry) => entry.ticker === ticker.toUpperCase());
    return match ?? null;
  }

  async findByCik(cik: string | number): Promise<CompanyDirectoryEntry | null> {
    const target = normalizeCik(cik);
    const entries = await this.load();
    const match = entries.find((entry) => entry.cik === target);
    return match ?? null;
  }

  async searchByName(query: string): Promise<CompanyDirectoryEntry[]> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const entries = await this.load();
    return entries.filter((entry) => entry.name.toLowerCase().includes(q));
  }

  async getAll(): Promise<CompanyDirectoryEntry[]> {
    return this.load();
  }
}
