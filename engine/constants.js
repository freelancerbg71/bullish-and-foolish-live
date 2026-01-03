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
 * @fileoverview Shared constants for the Bullish & Foolish fundamentals engine.
 * Centralizes magic numbers and configuration values for clarity and maintainability.
 */

// ============================================================================
// TIME CONSTANTS (in milliseconds)
// ============================================================================

/** One day in milliseconds */
export const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** One week in milliseconds */
export const ONE_WEEK_MS = 7 * ONE_DAY_MS;

/** One year in milliseconds (~365 days) */
export const ONE_YEAR_MS = 365 * ONE_DAY_MS;

/** Approximately 30 days in milliseconds (for tolerance windows) */
export const TOLERANCE_30D_MS = 30 * ONE_DAY_MS;

/** 180 days in milliseconds (stale data threshold) */
export const STALE_DATA_THRESHOLD_MS = 180 * ONE_DAY_MS;

// ============================================================================
// SCORING CONSTANTS
// ============================================================================

/** Minimum raw score before normalization */
export const RATING_MIN = -60;

/** Maximum raw score before normalization */
export const RATING_MAX = 100;

/** Range for normalization calculation */
export const RATING_RANGE = RATING_MAX - RATING_MIN || 1;

/** Risk-free rate used for macro adjustments (10Y Treasury proxy) */
export const RISK_FREE_RATE_PCT = 4.5;

// ============================================================================
// MARKET CAP THRESHOLDS (in USD)
// ============================================================================

/** Micro-cap threshold */
export const MICRO_CAP_THRESHOLD = 200_000_000;

/** Small-cap threshold */
export const SMALL_CAP_THRESHOLD = 2_000_000_000;

/** Mid-cap threshold */
export const MID_CAP_THRESHOLD = 10_000_000_000;

/** Large-cap threshold */
export const LARGE_CAP_THRESHOLD = 50_000_000_000;

/** Biotech penny-stock market cap threshold */
export const BIOTECH_PENNY_CAP = 50_000_000;

// ============================================================================
// ASSET THRESHOLDS (in USD)
// ============================================================================

/** Mid-cap asset floor */
export const MID_CAP_ASSET_FLOOR = 500_000_000;

/** Large-cap asset threshold */
export const LARGE_CAP_ASSET_THRESHOLD = 10_000_000_000;

/** Large-scale company detection (assets or revenue) */
export const LARGE_SCALE_ASSETS = 2_000_000_000;
export const LARGE_SCALE_REVENUE = 1_000_000_000;

// ============================================================================
// SECTOR BUCKETS
// ============================================================================

export const SECTOR_BUCKETS = {
    BIOTECH_PHARMA: "Biotech/Pharma",
    TECH_INTERNET: "Tech/Internet",
    FINANCIALS: "Financials",
    REAL_ESTATE: "Real Estate",
    RETAIL: "Retail",
    INDUSTRIAL: "Industrial/Cyclical",
    ENERGY_MATERIALS: "Energy/Materials",
    OTHER: "Other"
};

export const DEFAULT_SECTOR_BUCKET = SECTOR_BUCKETS.OTHER;

// ============================================================================
// SECTOR ALIASES (for classification)
// ============================================================================

export const SECTOR_ALIASES = {
    biotech: SECTOR_BUCKETS.BIOTECH_PHARMA,
    pharma: SECTOR_BUCKETS.BIOTECH_PHARMA,
    pharmaceutical: SECTOR_BUCKETS.BIOTECH_PHARMA,
    financial: SECTOR_BUCKETS.FINANCIALS,
    bank: SECTOR_BUCKETS.FINANCIALS,
    finance: SECTOR_BUCKETS.FINANCIALS,
    insurance: SECTOR_BUCKETS.FINANCIALS,
    tech: SECTOR_BUCKETS.TECH_INTERNET,
    technology: SECTOR_BUCKETS.TECH_INTERNET,
    internet: SECTOR_BUCKETS.TECH_INTERNET,
    software: SECTOR_BUCKETS.TECH_INTERNET,
    consumer: SECTOR_BUCKETS.RETAIL,
    "consumer & services": SECTOR_BUCKETS.RETAIL,
    retail: SECTOR_BUCKETS.RETAIL,
    energy: SECTOR_BUCKETS.ENERGY_MATERIALS,
    materials: SECTOR_BUCKETS.ENERGY_MATERIALS,
    industrial: SECTOR_BUCKETS.INDUSTRIAL,
    cyclical: SECTOR_BUCKETS.INDUSTRIAL,
    real: SECTOR_BUCKETS.REAL_ESTATE,
    reit: SECTOR_BUCKETS.REAL_ESTATE
};

// ============================================================================
// TIER LABELS
// ============================================================================

export const TIER_LABELS = {
    ELITE: "elite",
    BULLISH: "bullish",
    SOLID: "solid",
    MIXED: "mixed",
    SPECULATIVE: "spec",
    DANGER: "danger"
};

export const TIER_THRESHOLDS = {
    ELITE: 91,
    BULLISH: 76,
    SOLID: 61,
    MIXED: 46,
    SPECULATIVE: 31,
    DANGER: 0
};

// ============================================================================
// FINTECH DETECTION
// ============================================================================

/** Known fintech tickers (for explicit detection) */
export const KNOWN_FINTECH_TICKERS = new Set([
    "SOFI", "UPST", "AFRM", "SQ", "PYPL", "LC"
]);

/** Fintech name patterns */
export const FINTECH_NAME_PATTERNS = /sofi|upstart|affirm|square|paypal|lendingclub|robinhood|chime|coinbase/i;

/** Fintech SIC/Sector patterns */
export const FINTECH_SIC_PATTERNS = /fintech|digital.?bank|neo.?bank|online.?lend|peer.?to.?peer|payment.?platform|mobile.?pay/i;

// ============================================================================
// NUMERICAL SAFETY THRESHOLDS
// ============================================================================

/** Minimum denominator to avoid division by near-zero */
export const SAFE_DIVISION_THRESHOLD = 0.000001;

/** Minimum interest expense to consider as "has debt" (in USD) */
export const MIN_INTEREST_EXPENSE = 1;

/** Minimum debt to consider as "has debt" (in USD) */
export const MIN_DEBT_THRESHOLD = 1_000_000;

// ============================================================================
// DATA QUALITY THRESHOLDS
// ============================================================================

/** Minimum quarters required for YoY comparison */
export const MIN_QUARTERS_FOR_YOY = 5;

/** Minimum quarters for valid TTM calculation */
export const MIN_QUARTERS_FOR_TTM = 4;

/** Minimum quarters for valid CAGR calculation */
export const MIN_QUARTERS_FOR_CAGR = 16;

/** Number of quarters in a year */
export const QUARTERS_PER_YEAR = 4;

/** Period mismatch tolerance (in days) */
export const PERIOD_MISMATCH_TOLERANCE_DAYS = 65;
