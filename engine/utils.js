/**
 * Open Fundamentals Engine
 * Copyright (C) 2024-2025 Bullish & Foolish Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 *
 * @fileoverview Core utility functions for the Bullish & Foolish fundamentals engine.
 * These are pure functions with no side effects, designed for reusability.
 */

import {
    SAFE_DIVISION_THRESHOLD,
    DEFAULT_SECTOR_BUCKET,
    SECTOR_ALIASES,
    RATING_MIN,
    RATING_MAX,
    RATING_RANGE,
    TIER_THRESHOLDS,
    TIER_LABELS,
    KNOWN_FINTECH_TICKERS,
    FINTECH_NAME_PATTERNS,
    FINTECH_SIC_PATTERNS,
    ONE_YEAR_MS,
    TOLERANCE_30D_MS
} from "./constants.js";

// ============================================================================
// NUMBER PARSING & VALIDATION
// ============================================================================

/**
 * Safely converts a value to a number, handling percentages, currency suffixes, etc.
 * @param {*} val - Value to convert
 * @returns {number|null} - Parsed number or null if invalid
 */
export function toNumber(val) {
    if (val === null || val === undefined) return null;
    if (typeof val === "number") {
        if (Number.isFinite(val)) return val;
        if (val === Infinity || val === -Infinity) return val;
        return null;
    }
    if (typeof val === "string") {
        const cleaned = val.replace(/[%,$,]/g, "").trim();
        const mult = cleaned.endsWith("B") ? 1e9
            : cleaned.endsWith("M") ? 1e6
                : cleaned.endsWith("K") ? 1e3
                    : 1;
        const num = parseFloat(cleaned.replace(/[BMK]$/i, ""));
        return isFinite(num) ? num * mult : null;
    }
    return null;
}

/**
 * Alias for toNumber - used for percent values that may already be in ratio form.
 * @param {*} val - Value to convert
 * @returns {number|null} - Parsed number or null if invalid
 */
export function percentToNumber(val) {
    return toNumber(val);
}

/**
 * Checks if a value is a finite, usable number.
 * @param {*} val - Value to check
 * @returns {boolean}
 */
export function isFiniteValue(val) {
    if (val === null || val === undefined) return false;
    const num = Number(val);
    return Number.isFinite(num);
}

// ============================================================================
// SAFE MATH OPERATIONS
// ============================================================================

/**
 * Safe division that returns null for invalid/near-zero denominators.
 * @param {number} a - Numerator
 * @param {number} b - Denominator
 * @returns {number|null}
 */
export function safeDiv(a, b) {
    const x = Number(a);
    const y = Number(b);
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(y) < SAFE_DIVISION_THRESHOLD) {
        return null;
    }
    return x / y;
}

/**
 * Clamps a value between min and max.
 * @param {number} min - Minimum value
 * @param {*} val - Value to clamp
 * @param {number} max - Maximum value
 * @returns {number|null}
 */
export function clamp(min, val, max) {
    const n = Number(val);
    if (!Number.isFinite(n)) return null;
    return Math.max(min, Math.min(max, n));
}

/**
 * Clamps a value between 0 and 1.
 * @param {*} val - Value to clamp
 * @returns {number|null}
 */
export function clamp01(val) {
    if (val === null || val === undefined) return null;
    const num = Number(val);
    if (!Number.isFinite(num)) return null;
    return Math.max(0, Math.min(1, num));
}

/**
 * Calculates the average of an array of numbers, ignoring non-finite values.
 * @param {number[]} values - Array of values
 * @returns {number|null}
 */
export function avg(values) {
    const filtered = values.filter((v) => Number.isFinite(v));
    if (!filtered.length) return null;
    return filtered.reduce((acc, v) => acc + v, 0) / filtered.length;
}

/**
 * Calculates percent change between two values.
 * @param {number} curr - Current value
 * @param {number} prev - Previous value
 * @returns {number|null} - Percent change (e.g., 25 for 25%)
 */
export function pctChange(curr, prev) {
    if (!Number.isFinite(curr) || !Number.isFinite(prev) || prev === 0) return null;
    return ((curr - prev) / Math.abs(prev)) * 100;
}

/**
 * Calculates a margin (ratio) as a percentage.
 * @param {number} num - Numerator
 * @param {number} den - Denominator
 * @returns {number|null} - Margin as percentage (e.g., 25 for 25%)
 */
export function calcMargin(num, den) {
    if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) return null;
    return (num / den) * 100;
}

/**
 * Calculates CAGR (Compound Annual Growth Rate).
 * @param {number} latest - Latest value
 * @param {number} older - Older value
 * @param {number} years - Number of years between values
 * @returns {number|null} - CAGR as a decimal (e.g., 0.15 for 15%)
 */
export function calcCagr(latest, older, years) {
    const a = Number(latest);
    const b = Number(older);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0 || years <= 0) return null;
    return Math.pow(a / b, 1 / years) - 1;
}

/**
 * Converts a ratio to a percentage if it's in decimal form.
 * @param {*} val - Value to convert
 * @returns {number|null}
 */
export function pctFromRatio(val) {
    const num = percentToNumber(val);
    if (num === null) return null;
    return Math.abs(num) <= 1 ? num * 100 : num;
}

// ============================================================================
// SECTOR CLASSIFICATION
// ============================================================================

/**
 * Resolves a raw sector string to a standardized bucket.
 * @param {string} raw - Raw sector string
 * @returns {string} - Standardized sector bucket
 */
export function resolveSectorBucket(raw) {
    if (!raw) return DEFAULT_SECTOR_BUCKET;
    const norm = String(raw).trim();
    if (!norm) return DEFAULT_SECTOR_BUCKET;
    const lower = norm.toLowerCase();
    for (const [needle, bucket] of Object.entries(SECTOR_ALIASES)) {
        if (lower.includes(needle)) return bucket;
    }
    return norm;
}

/**
 * Applies sector-specific rule adjustments.
 * @param {string} _ruleName - Rule name (unused for now but available for future)
 * @param {number} baseScore - Base score from the rule
 * @param {string} sector - Sector string
 * @returns {Object} - Adjustment result
 */
export function applySectorRuleAdjustments(_ruleName, baseScore, sector) {
    return {
        score: baseScore,
        skipped: false,
        bucket: resolveSectorBucket(sector),
        multiplier: 1
    };
}

// ============================================================================
// FINTECH DETECTION
// ============================================================================

/**
 * Detects if a stock is a fintech company.
 * @param {Object} stock - Stock data object
 * @returns {boolean}
 */
export function isFintech(stock) {
    const ticker = String(stock?.ticker || "").toUpperCase();

    // Check against known fintech tickers
    if (KNOWN_FINTECH_TICKERS.has(ticker)) return true;

    // Name-based detection
    const name = String(stock?.companyName || stock?.ticker || "").toLowerCase();
    if (FINTECH_NAME_PATTERNS.test(name)) return true;

    // SIC/Sector-based detection
    const sicDesc = String(stock?.sicDescription || "").toLowerCase();
    const sector = String(stock?.sector || stock?.sectorBucket || "").toLowerCase();
    if (FINTECH_SIC_PATTERNS.test(sicDesc)) return true;
    if (/fintech/i.test(sector)) return true;

    return false;
}

// ============================================================================
// SCORE NORMALIZATION & TIER CLASSIFICATION
// ============================================================================

/**
 * Normalizes a raw score to 0-100 scale.
 * @param {number} score - Raw score
 * @returns {number|null}
 */
export function normalizeRuleScore(score) {
    const num = Number(score);
    if (!Number.isFinite(num)) return null;
    const normalized = ((num - RATING_MIN) / RATING_RANGE) * 100;
    return Math.round(Math.max(0, Math.min(100, normalized)));
}

/**
 * Gets the tier label for a score.
 * @param {number} val - Score value
 * @returns {string} - Tier label
 */
export function getScoreBand(val) {
    const v = Number(val) || 0;
    if (v >= TIER_THRESHOLDS.ELITE) return TIER_LABELS.ELITE;
    if (v >= TIER_THRESHOLDS.BULLISH) return TIER_LABELS.BULLISH;
    if (v >= TIER_THRESHOLDS.SOLID) return TIER_LABELS.SOLID;
    if (v >= TIER_THRESHOLDS.MIXED) return TIER_LABELS.MIXED;
    if (v >= TIER_THRESHOLDS.SPECULATIVE) return TIER_LABELS.SPECULATIVE;
    return TIER_LABELS.DANGER;
}

/**
 * Band scoring helper - returns score based on which band a value falls into.
 * @param {number} value - Value to score
 * @param {Array<{min: number, score: number}>} bands - Band definitions (sorted high to low)
 * @returns {number}
 */
export function bandScore(value, bands) {
    for (const band of bands) {
        if (value >= band.min) return band.score;
    }
    return bands[bands.length - 1]?.score ?? 0;
}

// ============================================================================
// FORMATTING UTILITIES
// ============================================================================

/**
 * Formats a number as a percentage string.
 * @param {number} num - Number to format
 * @returns {string}
 */
export function fmtPct(num) {
    if (!Number.isFinite(num)) return "n/a";
    return `${Number(num).toFixed(2)}%`;
}

/**
 * Formats a number as a money string with appropriate suffix.
 * @param {number} num - Number to format
 * @returns {string}
 */
export function fmtMoney(num) {
    const n = Number(num);
    if (!Number.isFinite(n)) return "n/a";
    const abs = Math.abs(n);
    if (abs >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
    if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
    if (abs >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
    return `$${n.toFixed(0)}`;
}

/**
 * Creates a missing data result object.
 * @param {string} message - Message explaining missing data
 * @param {boolean} notApplicable - Whether the rule is N/A for this stock
 * @returns {Object}
 */
export function missing(message, notApplicable = false) {
    return { score: 0, message, missing: true, notApplicable };
}

// ============================================================================
// DATE UTILITIES
// ============================================================================

/**
 * Formats a date string as a quarter label (e.g., "Q3 2024").
 * @param {string} dateStr - ISO date string
 * @returns {string}
 */
export function formatQuarterLabel(dateStr) {
    const d = new Date(dateStr);
    if (!Number.isFinite(d.getTime())) return dateStr;
    const month = d.getUTCMonth();
    const year = d.getUTCFullYear();
    const q = Math.floor(month / 3) + 1;
    return `Q${q} ${year}`;
}

/**
 * Safely parses a date string to milliseconds.
 * @param {string} dateStr - Date string to parse
 * @returns {number|null}
 */
export function safeParseDateMs(dateStr) {
    const ts = Date.parse(String(dateStr || ""));
    return Number.isFinite(ts) ? ts : null;
}

/**
 * Checks if a date is stale (older than maxAgeDays).
 * @param {string} dateStr - Date string to check
 * @param {number} maxAgeDays - Maximum age in days
 * @returns {boolean}
 */
export function isDateStale(dateStr, maxAgeDays = 1) {
    if (!dateStr) return true;
    const ts = Date.parse(dateStr);
    if (!Number.isFinite(ts)) return true;
    const ageMs = Date.now() - ts;
    return ageMs > maxAgeDays * 24 * 60 * 60 * 1000;
}

/**
 * Sorts a series by periodEnd ascending.
 * @param {Array} series
 * @returns {Array}
 */
export function sortByPeriodEndAsc(series = []) {
    return [...(series || [])]
        .filter((p) => p && p.periodEnd)
        .sort((a, b) => Date.parse(a.periodEnd) - Date.parse(b.periodEnd));
}

/**
 * Returns the last N periods from a series, sorted ascending.
 * @param {Array} series
 * @param {number} n
 * @returns {Array}
 */
export function lastNPeriods(series = [], n = 4) {
    const asc = sortByPeriodEndAsc(series);
    return asc.slice(-n);
}

/**
 * Finds a comparable period from one year ago (within tolerance).
 * @param {Array} seriesAsc - Series sorted ascending
 * @param {string} latestPeriodEnd - Date string of the target period
 * @returns {Object|null}
 */
export function findComparableYearAgo(seriesAsc = [], latestPeriodEnd) {
    const latestTs = Date.parse(latestPeriodEnd);
    if (!Number.isFinite(latestTs)) return null;

    // Need at least 5 quarters to reasonably compute a year-ago comparable.
    // With only 4 quarters, any fallback would be a wrong "YoY" comparison.
    if ((seriesAsc || []).length < 5) return null;

    const target = latestTs - ONE_YEAR_MS; // ~365d
    const windowMs = TOLERANCE_30D_MS; // ~30d
    const inWindow = seriesAsc.find((p) => {
        const ts = Date.parse(p.periodEnd);
        return Number.isFinite(ts) && Math.abs(ts - target) < windowMs;
    });
    if (inWindow) return inWindow;

    const latestIdx = seriesAsc.findIndex((p) => p.periodEnd === latestPeriodEnd);
    if (latestIdx >= 0) return seriesAsc[Math.max(0, latestIdx - 4)] || null;
    return seriesAsc[Math.max(0, seriesAsc.length - 5)] || null;
}

/**
 * Converts raw EDGAR periods to a normalized quarterly series.
 * @param {Array} periods
 * @returns {Array}
 */
export function toQuarterlySeries(periods = []) {
    const quarters = (periods || [])
        .filter((p) => (p.periodType || "").toLowerCase() === "quarter")
        .filter((p) => p.periodEnd)
        .sort((a, b) => Date.parse(a.periodEnd) - Date.parse(b.periodEnd));
    return quarters.map((p) => {
        const fcf =
            p.freeCashFlow != null
                ? p.freeCashFlow
                : p.operatingCashFlow != null
                    ? p.operatingCashFlow - Math.abs(p.capex ?? 0) // Assume 0 if capex is null but OCF exists
                    : null;
        const costOfRevenue = p.costOfRevenue ?? null;
        const derivedRevenue = p.revenue ?? (p.grossProfit != null && costOfRevenue != null ? p.grossProfit + costOfRevenue : null);
        const derivedGross = p.grossProfit == null && derivedRevenue != null && costOfRevenue != null
            ? derivedRevenue - costOfRevenue
            : p.grossProfit ?? null;
        return {
            periodEnd: p.periodEnd,
            label: formatQuarterLabel(p.periodEnd),
            sector: p.sector ?? null,
            sic: p.sic ?? null,
            sicDescription: p.sicDescription ?? null,
            revenue: derivedRevenue ?? null,
            grossProfit: derivedGross,
            costOfRevenue: costOfRevenue ?? null,
            operatingExpenses: p.operatingExpenses ?? null,
            operatingIncome: p.operatingIncome ?? null,
            incomeBeforeIncomeTaxes: p.incomeBeforeIncomeTaxes ?? null,
            incomeTaxExpenseBenefit: p.incomeTaxExpenseBenefit ?? null,
            netIncome: p.netIncome ?? null,
            epsBasic: p.epsBasic ?? null,
            sharesOutstanding: p.sharesOutstanding ?? p.shares ?? null,
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
            deposits: p.deposits ?? null,
            customerDeposits: p.customerDeposits ?? null,
            totalDeposits: p.totalDeposits ?? null,
            depositLiabilities: p.depositLiabilities ?? null,
            interestIncome: p.interestIncome ?? null,
            interestExpense: p.interestExpense ?? null,
            cash: p.cashAndCashEquivalents ?? p.cash ?? null,
            accountsReceivable: p.accountsReceivable ?? null,
            inventories: p.inventories ?? null,
            accountsPayable: p.accountsPayable ?? null,
            operatingCashFlow: p.operatingCashFlow ?? null,
            capex: p.capex ?? null,
            depreciationDepletionAndAmortization: p.depreciationDepletionAndAmortization ?? null,
            shareBasedCompensation: p.shareBasedCompensation ?? null,
            researchAndDevelopmentExpenses: p.researchAndDevelopmentExpenses ?? null,
            technologyExpenses: p.technologyExpenses ?? null,
            softwareExpenses: p.softwareExpenses ?? null,
            treasuryStockRepurchased: p.treasuryStockRepurchased ?? null,
            dividendsPaid: p.dividendsPaid ?? null,
            deferredRevenue: p.deferredRevenue ?? null,
            contractWithCustomerLiability: p.contractWithCustomerLiability ?? null,
            freeCashFlow: fcf
        };
    });
}

/**
 * Builds a TTM object from the latest 4 quarters.
 * @param {Array} quarters
 * @returns {Object|null}
 */
export function buildTtmFromQuarters(quarters) {
    const latest4 = quarters.slice(-4);
    if (latest4.length < 4) return null;

    const sumIfComplete = (field) => {
        let acc = 0;
        for (const q of latest4) {
            if (!isFiniteValue(q?.[field])) return null;
            acc += Number(q[field]);
        }
        return acc;
    };

    // TTM must be a true 4-quarter aggregate; avoid partial-TTM when any quarter is missing.
    const revenue = sumIfComplete("revenue");
    const netIncome = sumIfComplete("netIncome");
    if (revenue == null || netIncome == null) return null;

    const grossProfit = sumIfComplete("grossProfit");
    const operatingIncome = sumIfComplete("operatingIncome");
    const incomeBeforeIncomeTaxes = sumIfComplete("incomeBeforeIncomeTaxes");
    const incomeTaxExpenseBenefit = sumIfComplete("incomeTaxExpenseBenefit");
    const operatingCashFlow = sumIfComplete("operatingCashFlow");
    const capex = sumIfComplete("capex");

    const freeCashFlow = (() => {
        let acc = 0;
        for (const q of latest4) {
            const explicit = isFiniteValue(q?.freeCashFlow) ? Number(q.freeCashFlow) : null;
            const derived =
                explicit == null && isFiniteValue(q?.operatingCashFlow) && isFiniteValue(q?.capex)
                    ? Number(q.operatingCashFlow) - Math.abs(Number(q.capex))
                    : null;
            const val = explicit ?? derived;
            if (!Number.isFinite(val)) return null;
            acc += val;
        }
        return acc;
    })();

    // EPS TTM is only valid if all 4 quarters have EPS reported; otherwise leave null.
    const epsBasic = sumIfComplete("epsBasic");
    const asOf = latest4[latest4.length - 1].periodEnd;
    return {
        asOf,
        revenue,
        grossProfit,
        operatingIncome,
        incomeBeforeIncomeTaxes,
        incomeTaxExpenseBenefit,
        netIncome,
        epsBasic,
        operatingCashFlow,
        capex,
        freeCashFlow
    };
}
