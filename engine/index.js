/**
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
    // Time constants
    ONE_DAY_MS,
    ONE_WEEK_MS,
    ONE_YEAR_MS,
    TOLERANCE_30D_MS,
    STALE_DATA_THRESHOLD_MS,

    // Scoring constants
    RATING_MIN,
    RATING_MAX,
    RATING_RANGE,
    RISK_FREE_RATE_PCT,

    // Market cap thresholds
    MICRO_CAP_THRESHOLD,
    SMALL_CAP_THRESHOLD,
    MID_CAP_THRESHOLD,
    LARGE_CAP_THRESHOLD,
    BIOTECH_PENNY_CAP,

    // Asset thresholds
    MID_CAP_ASSET_FLOOR,
    LARGE_CAP_ASSET_THRESHOLD,
    LARGE_SCALE_ASSETS,
    LARGE_SCALE_REVENUE,

    // Sector classifications
    SECTOR_BUCKETS,
    DEFAULT_SECTOR_BUCKET,
    SECTOR_ALIASES,

    // Tier classifications
    TIER_LABELS,
    TIER_THRESHOLDS,

    // Fintech detection
    KNOWN_FINTECH_TICKERS,
    FINTECH_NAME_PATTERNS,
    FINTECH_SIC_PATTERNS,

    // Safety thresholds
    SAFE_DIVISION_THRESHOLD,
    MIN_INTEREST_EXPENSE,
    MIN_DEBT_THRESHOLD,

    // Data quality thresholds
    MIN_QUARTERS_FOR_YOY,
    MIN_QUARTERS_FOR_TTM,
    MIN_QUARTERS_FOR_CAGR,
    QUARTERS_PER_YEAR,
    PERIOD_MISMATCH_TOLERANCE_DAYS
} from "./constants.js";

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

export {
    // Number parsing
    toNumber,
    percentToNumber,
    isFiniteValue,

    // Math operations
    safeDiv,
    clamp,
    clamp01,
    avg,
    pctChange,
    calcMargin,
    calcCagr,
    pctFromRatio,

    // Sector classification
    resolveSectorBucket,
    applySectorRuleAdjustments,

    // Fintech detection
    isFintech,

    // Score normalization
    normalizeRuleScore,
    getScoreBand,
    bandScore,

    // Formatting
    fmtPct,
    fmtMoney,
    missing,

    // Date utilities
    formatQuarterLabel,
    safeParseDateMs,
    isDateStale
} from "./utils.js";

// ============================================================================
// RULE EXPLAINERS
// ============================================================================

export {
    ruleExplainers,
    ruleRegistry,
    coverageMap,
    getExplainerForRule
} from "./ruleExplainers.js";

// ============================================================================
// ENGINE VERSION
// ============================================================================

/**
 * Engine version string for cache invalidation and debugging.
 */
export const ENGINE_VERSION = "1.0.0";

/**
 * Build date for reference.
 */
export const ENGINE_BUILD_DATE = "2025-12-28";
