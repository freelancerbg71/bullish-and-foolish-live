/**
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
    FINTECH_SIC_PATTERNS
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
