/**
 * Stock Object Schema
 * 
 * This TypeScript declaration documents the normalized `stock` object
 * that the rules engine expects. Data providers (SEC EDGAR, Companies House, etc.)
 * must transform their raw filings into this shape for rule evaluation.
 * 
 * @fileoverview Schema for the normalized stock object used by engine/rules.js
 */

/**
 * The normalized stock object passed to rule evaluators.
 * All monetary values are in the company's reporting currency (typically USD/GBP/EUR).
 * All percentages are expressed as numbers (e.g., 15 for 15%, not 0.15).
 */
export interface Stock {
    // ============================================================================
    // IDENTIFIERS
    // ============================================================================

    /** Stock ticker symbol (e.g., "AAPL", "VOD.L") */
    ticker: string;

    /** Company name */
    companyName: string;

    /** Sector classification (resolved to internal bucket via resolveSectorBucket) */
    sector: string;

    /** Internal sector bucket for rule thresholds */
    sectorBucket?: 'Biotech/Pharma' | 'Tech/Internet' | 'Financials' | 'Real Estate' | 'Retail' | 'Industrial/Cyclical' | 'Energy/Materials' | 'Other';

    /** Market capitalization in reporting currency */
    marketCap?: number;

    /** Whether this company is flagged as fintech (overrides Financials sector logic) */
    isFintech?: boolean;

    // ============================================================================
    // PROFIT MARGINS (as percentages)
    // ============================================================================

    profitMargins?: {
        /** Gross margin: (Gross Profit / Revenue) * 100 */
        grossMargin?: number;

        /** Operating margin: (Operating Income / Revenue) * 100 */
        operatingMargin?: number;

        /** Net income margin: (Net Income / Revenue) * 100 */
        netIncome?: number;

        /** FCF margin: (Free Cash Flow / Revenue) * 100 */
        fcfMargin?: number;

        /** Operating leverage: OpEx growth relative to Revenue growth */
        operatingLeverage?: number;
    };

    // ============================================================================
    // GROWTH METRICS (as percentages)
    // ============================================================================

    growth?: {
        /** Revenue growth YoY (TTM vs prior TTM) */
        revenueGrowthYoY?: number;

        /** Revenue growth TTM */
        revenueGrowthTTM?: number;

        /** 3-year revenue CAGR */
        revenueCagr3y?: number;

        /** 3-year EPS CAGR */
        epsCagr3y?: number;
    };

    // ============================================================================
    // FINANCIAL POSITION
    // ============================================================================

    financialPosition?: {
        /** Total debt */
        totalDebt?: number;

        /** Financial debt (excluding operating leases) */
        financialDebt?: number;

        /** Net debt (Total Debt - Cash) */
        netDebt?: number;

        /** Debt to Equity ratio (as decimal, e.g., 0.5 for 50%) */
        debtToEquity?: number;

        /** Net Debt / FCF (years to pay off debt) */
        netDebtToFcfYears?: number;

        /** Cash runway in years (for unprofitable companies) */
        runwayYears?: number;

        /** Total assets */
        totalAssets?: number;

        /** Total equity */
        totalEquity?: number;

        /** Flag: company has zero or negligible debt */
        debtIsZero?: boolean;

        /** Long-term debt portion */
        longTermDebt?: number;

        /** Short-term debt portion */
        shortTermDebt?: number;
    };

    // ============================================================================
    // SHARE STATISTICS
    // ============================================================================

    shareStats?: {
        /** Shares outstanding */
        sharesOutstanding?: number;

        /** Share count change QoQ (percentage) */
        sharesChangeQoQ?: number;

        /** Share count change YoY (percentage) */
        sharesChangeYoY?: number;

        /** Buybacks as % of FCF */
        buybacksToFcf?: number;

        /** Total shareholder return (buybacks + dividends) as % of FCF */
        shareholderReturnToFcf?: number;
    };

    // ============================================================================
    // VALUATION RATIOS
    // ============================================================================

    valuationRatios?: {
        /** Price / Sales ratio */
        psRatio?: number;

        /** Price / Earnings ratio */
        peRatio?: number;

        /** Price / Book ratio */
        pbRatio?: number;

        /** Price / Free Cash Flow ratio */
        pfcfRatio?: number;
    };

    // ============================================================================
    // RETURNS
    // ============================================================================

    returns?: {
        /** Return on Equity (percentage) */
        roe?: number;

        /** Return on Invested Capital (percentage) */
        roic?: number;

        /** Return on Assets (percentage) */
        roa?: number;
    };

    // ============================================================================
    // CASH FLOW
    // ============================================================================

    cash?: {
        /** CapEx as % of Revenue */
        capexToRevenue?: number;

        /** Operating Cash Flow */
        operatingCashFlow?: number;

        /** Free Cash Flow */
        freeCashFlow?: number;
    };

    // ============================================================================
    // DIVIDENDS
    // ============================================================================

    dividends?: {
        /** Dividend yield (percentage) */
        yield?: number;

        /** Payout ratio as % of FCF */
        payoutToFcf?: number;
    };

    // ============================================================================
    // DATA QUALITY METADATA
    // ============================================================================

    dataQuality?: {
        /** Number of quarters of data available */
        quarterCount?: number;

        /** Data basis: 'quarterly' or 'annual' */
        basis?: 'quarterly' | 'annual';

        /** Date of most recent filing */
        lastFilingDate?: string;

        /** Whether data is considered stale (>180 days old) */
        isStale?: boolean;
    };

    // ============================================================================
    // RAW DATA (for advanced calculations)
    // ============================================================================

    /** TTM revenue in reporting currency */
    revenueTtm?: number;

    /** Latest period revenue */
    revenueLatest?: number;

    /** Profit growth TTM (percentage) */
    profitGrowthTTM?: number;

    /** Interest coverage ratio */
    interestCoverage?: number;

    /** Snapshot object with additional derived metrics */
    snapshot?: {
        revenueYoYPct?: number;
        sharesOutChangeYoY?: string;
        [key: string]: unknown;
    };
}

/**
 * Result returned by a rule's evaluate() function.
 */
export interface RuleResult {
    /** Score contribution (typically -10 to +10) */
    score: number;

    /** Human-readable message for UI display */
    message: string;

    /** If true, required data was unavailable */
    missing?: boolean;

    /** If true, rule doesn't apply to this stock type */
    notApplicable?: boolean;
}

/**
 * A scoring rule definition.
 */
export interface Rule {
    /** Human-readable rule name */
    name: string;

    /** Weight (1-10 scale) for final score calculation */
    weight: number;

    /** Evaluation function */
    evaluate: (stock: Stock) => RuleResult;
}
