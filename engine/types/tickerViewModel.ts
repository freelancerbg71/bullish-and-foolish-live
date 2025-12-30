export type PricePoint = {
  date: string; // ISO date
  close: number;
};

export type QuarterlyPoint = {
  periodEnd: string; // ISO date
  label: string;
  sector?: string | null;
  sic?: number | null;
  sicDescription?: string | null;
  sharesOutstanding?: number | null;
  revenue?: number | null;
  grossProfit?: number | null;
  costOfRevenue?: number | null;
  operatingIncome?: number | null;
  netIncome?: number | null;
  epsBasic?: number | null;
  totalAssets?: number | null;
  totalLiabilities?: number | null;
  totalEquity?: number | null;
  totalDebt?: number | null;
  financialDebt?: number | null;
  shortTermDebt?: number | null;
  leaseLiabilities?: number | null;
  shortTermInvestments?: number | null;
  interestExpense?: number | null;
  cash?: number | null;
  accountsReceivable?: number | null;
  inventories?: number | null;
  accountsPayable?: number | null;
  operatingCashFlow?: number | null;
  capex?: number | null;
  freeCashFlow?: number | null;
  shareBasedCompensation?: number | null;
  researchAndDevelopmentExpenses?: number | null;
  treasuryStockRepurchased?: number | null;
  dividendsPaid?: number | null;
};

export type TtmSnapshot = {
  asOf: string;
  revenue?: number | null;
  netIncome?: number | null;
  epsBasic?: number | null;
  freeCashFlow?: number | null;
};

export type KeyMetrics = {
  grossMargin?: number | null;
  operatingMargin?: number | null;
  netMargin?: number | null;
  roe?: number | null;
  roic?: number | null;
  debtToEquity?: number | null;
  debtToAssets?: number | null;
  revenueCagr3y?: number | null;
  epsCagr3y?: number | null;
  peTtm?: number | null;
  psTtm?: number | null;
  pb?: number | null;
  freeCashFlowYield?: number | null;
};

export type PriceSummary = {
  lastClose?: number | null;
  lastCloseDate?: string | null;
  prevClose?: number | null;
  dayChangeAbs?: number | null;
  dayChangePct?: number | null;
};

export type Snapshot = {
  netMarginTTM: number | null;
  fcfMarginTTM?: number | null;
  freeCashFlowTTM: number | null;
  revenueCAGR3Y: number | null;
  debtToEquity: number | null;
  netDebtToFCFYears: number | null;
  netDebtToFcfYears?: number | null;
  interestCoverage: number | null;
  interestCoveragePeriods?: number | null;
  interestCoverageStatus?: string | null;
  sharesOutChangeYoY: number | null;
  sharesOutChangeYoYRaw?: number | null;
  shareChangeLikelySplit?: boolean;
  sharesOut?: number | null;
  sharesOutstanding?: number | null;
  operatingCashFlowTrend4Q: "up" | "flat" | "down" | null;
  shareBuybacksTTM?: number | null;
  dividendsPaidTTM?: number | null;
  shareholderReturnTTM?: number | null;
  buybacksPctFcf?: number | null;
  rdSpendTTM?: number | null;
  rdIntensityTTM?: number | null;
  rdIntensityAnnual?: number | null;
  rdIntensityAnnualPrev?: number | null;
  dsoDays?: number | null;
  dioDays?: number | null;
  dpoDays?: number | null;
  cashConversionCycleDays?: number | null;
  effectiveTaxRateTTM?: number | null;
  shortPercentFloat?: number | null;
  shortFloatPercent?: number | null;
  shortInterestPercentOfFloat?: number | null;
  daysToCover?: number | null;
  shortRatio?: number | null;
  avgVolume30d?: number | null;
};

export type ProjectionModel = {
  futureGrowthScore: number | null;
  dilutionRisk: number | null;
  deteriorationLabel: string | null;
  growthContinuationScore: number | null;
  dilutionRiskScore: number | null;
  bankruptcyRiskScore: number | null;
  businessTrendLabel: "Improving" | "Stable" | "Worsening" | null;
  growthContinuationLabel?: string | null;
  dilutionRiskLabel?: string | null;
  bankruptcyRiskLabel?: string | null;
};

export type TickerViewModel = {
  ticker: string;
  companyName?: string;
  currency?: string;
  sector?: string | null;
  sic?: number | null;
  priceHistory: PricePoint[];
  priceSummary: PriceSummary;
  quarterlySeries: QuarterlyPoint[];
  ttm: TtmSnapshot | null;
  keyMetrics: KeyMetrics;
  snapshot: Snapshot;
  projections: ProjectionModel;
};
