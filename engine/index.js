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
 * @fileoverview Bullish & Foolish Fundamentals Engine
 * 
 * A rules-based, sector-aware scoring engine for evaluating public company
 * financial health using SEC EDGAR filings.
 * 
 * This module provides the core engine functionality that can be used
 * independently of the web UI.
 * 
 * @example
 * ```javascript
 * import { 
 *   toNumber, 
 *   resolveSectorBucket, 
 *   normalizeRuleScore,
 *   SECTOR_BUCKETS 
 * } from './engine/index.js';
 * 
 * const sector = resolveSectorBucket("Technology");
 * const normalized = normalizeRuleScore(rawScore);
 * ```
 * 
 * @license AGPL-3.0
 */

// ============================================================================
// CONSTANTS
// ============================================================================

export {
    /** One day in milliseconds (86,400,000) */
    ONE_DAY_MS,
    /** One week in milliseconds */
    ONE_WEEK_MS,
    /** One year in milliseconds (~31.5B) */
    ONE_YEAR_MS,
    /** Tolerance window for approximate date matching (30 days) */
    TOLERANCE_30D_MS,
    /** Data staleness threshold (180 days) */
    STALE_DATA_THRESHOLD_MS,

    /** Minimum raw score before normalization (-60) */
    RATING_MIN,
    /** Maximum raw score before normalization (100) */
    RATING_MAX,
    /** Range of score for normalization */
    RATING_RANGE,
    /** Theoretical risk-free rate for valuations */
    RISK_FREE_RATE_PCT,

    /** Market cap threshold: Micro Cap (<$200M) */
    MICRO_CAP_THRESHOLD,
    /** Market cap threshold: Small Cap (<$2B) */
    SMALL_CAP_THRESHOLD,
    /** Market cap threshold: Mid Cap (<$10B) */
    MID_CAP_THRESHOLD,
    /** Market cap threshold: Large Cap (>$50B) */
    LARGE_CAP_THRESHOLD,
    /** Biotech penny stock threshold ($50M) */
    BIOTECH_PENNY_CAP,

    /** Minimum asset floor for mid-cap logic */
    MID_CAP_ASSET_FLOOR,
    /** Large asset threshold for stability checks */
    LARGE_CAP_ASSET_THRESHOLD,
    /** Assets scale for large company detection */
    LARGE_SCALE_ASSETS,
    /** Revenue scale for large company detection */
    LARGE_SCALE_REVENUE,

    /** Map of sector keys to display names */
    SECTOR_BUCKETS,
    /** Fallback sector bucket if unknown */
    DEFAULT_SECTOR_BUCKET,
    /** Map of raw sector strings to bucket keys */
    SECTOR_ALIASES,

    /** Display labels for quality tiers */
    TIER_LABELS,
    /** Score thresholds for quality tiers */
    TIER_THRESHOLDS,

    /** Set of known fintech tickers */
    KNOWN_FINTECH_TICKERS,
    /** Regex for detecting fintech by name */
    FINTECH_NAME_PATTERNS,
    /** Regex for detecting fintech by SIC/sector */
    FINTECH_SIC_PATTERNS,

    /** Minimum value to avoid divide-by-zero errors */
    SAFE_DIVISION_THRESHOLD,
    /** Minimum interest expense to consider relevant */
    MIN_INTEREST_EXPENSE,
    /** Minimum debt load to consider relevant */
    MIN_DEBT_THRESHOLD,

    /** Minimum quarters required for Year-Over-Year comparisons */
    MIN_QUARTERS_FOR_YOY,
    /** Minimum quarters required for TTM calculations */
    MIN_QUARTERS_FOR_TTM,
    /** Minimum quarters required for 3-Year CAGR */
    MIN_QUARTERS_FOR_CAGR,
    /** Number of quarters in a fiscal year */
    QUARTERS_PER_YEAR,
    /** Allowed gap in days for period alignment */
    PERIOD_MISMATCH_TOLERANCE_DAYS
} from "./constants.js";

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

export {
    /** Safely parse a value to a number or null */
    toNumber,
    /** Parse percentage string (e.g. "5.5%") to number */
    percentToNumber,
    /** Check if a value is a finite number */
    isFiniteValue,

    /** Safe division (returns null on zero denominator) */
    safeDiv,
    /** Clamp a value between min and max */
    clamp,
    /** Clamp a value between 0 and 1 */
    clamp01,
    /** Average of an array of numbers */
    avg,
    /** Calculate percent change between two numbers */
    pctChange,
    /** Calculate margin percentage (num/den * 100) */
    calcMargin,
    /** Calculate Compound Annual Growth Rate */
    calcCagr,
    /** Convert decimal ratio to percentage (0.15 -> 15) */
    pctFromRatio,

    /** Map a raw sector string to a standardized bucket */
    resolveSectorBucket,
    /** Adjust rule weights based on sector */
    applySectorRuleAdjustments,

    /** Boolean check: Is this stock a fintech? */
    isFintech,

    /** Normalize a raw engine score to 0-100 */
    normalizeRuleScore,
    /** Get the text label for a given 0-100 score */
    getScoreBand,
    /** Score a value against a set of bands */
    bandScore,

    /** Format number as percentage string */
    fmtPct,
    /** Format number as currency string */
    fmtMoney,
    /** Standard missing data object */
    missing,

    /** Format date string as "Q3 2024" */
    formatQuarterLabel,
    /** Parse date string to timestamp or null */
    safeParseDateMs,
    /** Check if a date is older than N days */
    isDateStale,

    /** Sort series date ascending */
    sortByPeriodEndAsc,
    /** Get last N periods */
    lastNPeriods,
    /** Find comparable period from 1 year ago */
    findComparableYearAgo,
    /** Convert raw periods to quarterly series */
    toQuarterlySeries,
    /** Build TTM from quarters */
    buildTtmFromQuarters
} from "./utils.js";

// ============================================================================
// FINANCIAL CALCULATIONS
// ============================================================================

export {
    /** Infer tax rate from TTM or latest annual */
    inferTaxRate,
    /** Compute Interest Coverage Ratio (TTM) */
    computeInterestCoverageTtm,
    /** Compute Interest Coverage Ratio (Annual) */
    computeInterestCoverageAnnual,
    /** Calculate Free Cash Flow */
    calcFcf,
    /** Compute runway in years */
    computeRunwayYears
} from "./calculations.js";

// ============================================================================
// STOCK ADJUSTMENTS (SPLITS, ETC)
// ============================================================================

export {
    /** Detect potential stock split */
    detectLikelySplit,
    /** Detect potential reverse stock split */
    detectLikelyReverseSplit,
    /** Compute share changes with split guard */
    computeShareChangeWithSplitGuard
} from "./stockAdjustments.js";

// ============================================================================
// STOCK BUILDER
// ============================================================================

export {
    /** Build standardized stock object for rules */
    buildStockForRules
} from "./stockBuilder.js";


// ============================================================================
// RULE EXPLAINERS
// ============================================================================

export {
    /** Map of rule IDs to positive/negative explanations */
    ruleExplainers,
    /** Registry of active rules (runtime populated) */
    ruleRegistry,
    /** Map of data fields to rules that use them */
    coverageMap,
    /** Get the explanation string for a specific rule and score */
    getExplainerForRule
} from "./ruleExplainers.js";

// ============================================================================
// RULES
// ============================================================================

export {
    /** The complete set of scoring rules */
    rules
} from "./rules.js";

// ============================================================================
// ENGINE VERSION
// ============================================================================

/**
 * Engine version string for cache invalidation and debugging.
 */
export const ENGINE_VERSION = "1.0.1";

/**
 * Build date for reference.
 */
export const ENGINE_BUILD_DATE = "2025-12-30";
