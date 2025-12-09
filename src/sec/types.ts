export interface CompanyDirectoryResponse {
  fields: string[];
  data: Array<[number, string, string, string | null, ...unknown[]]>;
}

export interface CompanyDirectoryEntry {
  cik: string;
  name: string;
  ticker: string;
  exchange?: string | null;
}

export interface SubmissionsJson {
  cik: string;
  entityType?: string;
  tickers?: string[];
  exchanges?: string[];
  sic?: string;
  filings?: {
    recent?: RecentFilingsRaw;
    files?: Array<{ name: string; filingCount: number; filingFrom: string; filingTo: string }>;
  };
  [key: string]: unknown;
}

export interface RecentFilingsRaw {
  accessionNumber?: string[];
  filingDate?: string[];
  reportDate?: string[];
  acceptanceDateTime?: string[];
  act?: string[];
  form?: string[];
  fileNumber?: string[];
  filmNumber?: string[];
  items?: string[];
  size?: number[];
  isXBRL?: number[];
  primaryDocument?: string[];
  primaryDocDescription?: string[];
  [key: string]: unknown;
}

export interface RecentFiling {
  accessionNumber: string;
  filingDate: string;
  form?: string;
  reportDate?: string;
  acceptanceDateTime?: string;
  primaryDocument?: string;
  primaryDocDescription?: string;
  [key: string]: unknown;
}

export interface FilingIndexItem {
  name: string;
  lastModified?: string;
  type?: string;
  size?: string;
  href?: string;
}

export interface FilingIndexJson {
  directory?: {
    name?: string;
    item?: FilingIndexItem[];
  };
  [key: string]: unknown;
}

export interface CompanyFacts {
  cik: string;
  entityName?: string;
  facts?: Record<string, Record<string, CompanyFactItem>>;
  [key: string]: unknown;
}

export interface CompanyFactItem {
  label?: string;
  description?: string;
  units?: Record<string, FactUnit[]>;
  [key: string]: unknown;
}

export interface FactUnit {
  start?: string;
  end?: string;
  val?: number;
  accn?: string;
  fy?: number;
  fp?: string;
  form?: string;
  filed?: string;
  frame?: string;
  [key: string]: unknown;
}

export interface CompanyConcept {
  cik: string;
  taxonomy: string;
  tag: string;
  label?: string;
  description?: string;
  units?: Record<string, FactUnit[]>;
  [key: string]: unknown;
}

export interface Frame {
  taxonomy?: string;
  tag?: string;
  label?: string;
  description?: string;
  units?: Record<string, FactUnit[]>;
  data?: Array<
    FactUnit & {
      entityName?: string;
      entityId?: string;
    }
  >;
  [key: string]: unknown;
}

export interface FilingFilterOptions {
  forms?: string[];
  from?: string;
  to?: string;
  limit?: number;
}
