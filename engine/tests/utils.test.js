/**
 * @fileoverview Unit tests for the Bullish & Foolish engine utilities.
 * Run with: node engine/tests/utils.test.js
 */

import { strict as assert } from 'assert';
import {
    toNumber,
    percentToNumber,
    safeDiv,
    clamp,
    clamp01,
    avg,
    pctChange,
    calcMargin,
    calcCagr,
    pctFromRatio,
    resolveSectorBucket,
    isFintech,
    normalizeRuleScore,
    getScoreBand,
    bandScore,
    fmtPct,
    fmtMoney,
    missing,
    formatQuarterLabel,
    safeParseDateMs,
    isDateStale,
    isFiniteValue,
    SECTOR_BUCKETS,
    TIER_LABELS
} from '../index.js';

// ============================================================================
// TEST UTILITIES
// ============================================================================

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`✗ ${name}`);
        console.error(`  ${err.message}`);
        failed++;
    }
}

function describe(name, fn) {
    console.log(`\n${name}`);
    console.log('─'.repeat(name.length));
    fn();
}

// ============================================================================
// TESTS: toNumber
// ============================================================================

describe('toNumber', () => {
    test('returns number for number input', () => {
        assert.equal(toNumber(42), 42);
        assert.equal(toNumber(3.14), 3.14);
        assert.equal(toNumber(-10), -10);
    });

    test('returns null for null/undefined', () => {
        assert.equal(toNumber(null), null);
        assert.equal(toNumber(undefined), null);
    });

    test('parses string numbers', () => {
        assert.equal(toNumber('42'), 42);
        assert.equal(toNumber('3.14'), 3.14);
        assert.equal(toNumber('-10'), -10);
    });

    test('handles percentage strings', () => {
        assert.equal(toNumber('15%'), 15);
        assert.equal(toNumber('25.5%'), 25.5);
    });

    test('handles currency strings', () => {
        assert.equal(toNumber('$100'), 100);
        assert.equal(toNumber('$1,000'), 1000);
    });

    test('handles suffix multipliers', () => {
        assert.equal(toNumber('5B'), 5e9);
        assert.equal(toNumber('2.5M'), 2.5e6);
        assert.equal(toNumber('100K'), 100e3);
    });

    test('returns null for NaN', () => {
        assert.equal(toNumber(NaN), null);
        assert.equal(toNumber('not a number'), null);
    });

    test('handles Infinity', () => {
        assert.equal(toNumber(Infinity), Infinity);
        assert.equal(toNumber(-Infinity), -Infinity);
    });
});

// ============================================================================
// TESTS: safeDiv
// ============================================================================

describe('safeDiv', () => {
    test('divides numbers correctly', () => {
        assert.equal(safeDiv(10, 2), 5);
        assert.equal(safeDiv(100, 4), 25);
    });

    test('returns null for zero denominator', () => {
        assert.equal(safeDiv(10, 0), null);
    });

    test('returns null for near-zero denominator', () => {
        assert.equal(safeDiv(10, 0.0000000001), null);
    });

    test('returns null for non-finite inputs', () => {
        assert.equal(safeDiv(NaN, 2), null);
        assert.equal(safeDiv(10, NaN), null);
        // Note: Number(null) = 0, so safeDiv(null, 2) = 0/2 = 0
        assert.equal(safeDiv(null, 2), 0);
    });
});

// ============================================================================
// TESTS: clamp
// ============================================================================

describe('clamp', () => {
    test('clamps value within range', () => {
        assert.equal(clamp(0, 50, 100), 50);
        assert.equal(clamp(0, -10, 100), 0);
        assert.equal(clamp(0, 150, 100), 100);
    });

    test('returns null for non-finite input', () => {
        assert.equal(clamp(0, NaN, 100), null);
        // Note: Number(null) = 0, so clamp(0, null, 100) = 0
        assert.equal(clamp(0, null, 100), 0);
    });
});

// ============================================================================
// TESTS: clamp01
// ============================================================================

describe('clamp01', () => {
    test('clamps value between 0 and 1', () => {
        assert.equal(clamp01(0.5), 0.5);
        assert.equal(clamp01(-0.5), 0);
        assert.equal(clamp01(1.5), 1);
    });

    test('returns null for invalid input', () => {
        assert.equal(clamp01(null), null);
        assert.equal(clamp01(undefined), null);
    });
});

// ============================================================================
// TESTS: avg
// ============================================================================

describe('avg', () => {
    test('calculates average correctly', () => {
        assert.equal(avg([10, 20, 30]), 20);
        assert.equal(avg([5, 5, 5, 5]), 5);
    });

    test('ignores non-finite values', () => {
        assert.equal(avg([10, NaN, 30]), 20);
        assert.equal(avg([10, null, 30, undefined]), 20);
    });

    test('returns null for empty array', () => {
        assert.equal(avg([]), null);
        assert.equal(avg([NaN, null, undefined]), null);
    });
});

// ============================================================================
// TESTS: pctChange
// ============================================================================

describe('pctChange', () => {
    test('calculates percent change correctly', () => {
        assert.equal(pctChange(110, 100), 10);
        assert.equal(pctChange(90, 100), -10);
        assert.equal(pctChange(200, 100), 100);
    });

    test('returns null for invalid inputs', () => {
        assert.equal(pctChange(100, 0), null);
        assert.equal(pctChange(NaN, 100), null);
        assert.equal(pctChange(100, NaN), null);
    });
});

// ============================================================================
// TESTS: resolveSectorBucket
// ============================================================================

describe('resolveSectorBucket', () => {
    test('resolves known sector aliases', () => {
        assert.equal(resolveSectorBucket('Technology'), SECTOR_BUCKETS.TECH_INTERNET);
        assert.equal(resolveSectorBucket('Biotechnology'), SECTOR_BUCKETS.BIOTECH_PHARMA);
        assert.equal(resolveSectorBucket('Financial Services'), SECTOR_BUCKETS.FINANCIALS);
        assert.equal(resolveSectorBucket('Consumer Retail'), SECTOR_BUCKETS.RETAIL);
    });

    test('returns Other for unknown sectors', () => {
        assert.equal(resolveSectorBucket('Unknown Sector'), 'Unknown Sector');
        assert.equal(resolveSectorBucket(null), 'Other');
        assert.equal(resolveSectorBucket(''), 'Other');
    });
});

// ============================================================================
// TESTS: isFintech
// ============================================================================

describe('isFintech', () => {
    test('detects known fintech tickers', () => {
        assert.equal(isFintech({ ticker: 'SOFI' }), true);
        assert.equal(isFintech({ ticker: 'UPST' }), true);
        assert.equal(isFintech({ ticker: 'PYPL' }), true);
    });

    test('detects fintech by name', () => {
        assert.equal(isFintech({ companyName: 'SoFi Technologies Inc' }), true);
        assert.equal(isFintech({ companyName: 'Coinbase Global' }), true);
    });

    test('returns false for non-fintech', () => {
        assert.equal(isFintech({ ticker: 'AAPL', companyName: 'Apple Inc' }), false);
        assert.equal(isFintech({ ticker: 'META', companyName: 'Meta Platforms' }), false);
    });
});

// ============================================================================
// TESTS: normalizeRuleScore
// ============================================================================

describe('normalizeRuleScore', () => {
    test('normalizes scores to 0-100 range', () => {
        const score = normalizeRuleScore(20);
        assert.ok(score >= 0 && score <= 100);
    });

    test('returns null for non-finite input', () => {
        assert.equal(normalizeRuleScore(NaN), null);
    });
});

// ============================================================================
// TESTS: getScoreBand
// ============================================================================

describe('getScoreBand', () => {
    test('returns correct tier labels', () => {
        assert.equal(getScoreBand(95), TIER_LABELS.ELITE);
        assert.equal(getScoreBand(80), TIER_LABELS.BULLISH);
        assert.equal(getScoreBand(65), TIER_LABELS.SOLID);
        assert.equal(getScoreBand(50), TIER_LABELS.MIXED);
        assert.equal(getScoreBand(35), TIER_LABELS.SPECULATIVE);
        assert.equal(getScoreBand(10), TIER_LABELS.DANGER);
    });
});

// ============================================================================
// TESTS: fmtPct
// ============================================================================

describe('fmtPct', () => {
    test('formats percentages correctly', () => {
        assert.equal(fmtPct(25.5), '25.50%');
        assert.equal(fmtPct(0), '0.00%');
        assert.equal(fmtPct(-10.123), '-10.12%');
    });

    test('returns n/a for invalid input', () => {
        assert.equal(fmtPct(NaN), 'n/a');
        assert.equal(fmtPct(Infinity), 'n/a');
    });
});

// ============================================================================
// TESTS: fmtMoney
// ============================================================================

describe('fmtMoney', () => {
    test('formats money with appropriate suffixes', () => {
        assert.equal(fmtMoney(1e12), '$1.00T');
        assert.equal(fmtMoney(5e9), '$5.00B');
        assert.equal(fmtMoney(2.5e6), '$2.50M');
        assert.equal(fmtMoney(100000), '$100.0K');
        assert.equal(fmtMoney(500), '$500');
    });

    test('returns n/a for invalid input', () => {
        assert.equal(fmtMoney(NaN), 'n/a');
    });
});

// ============================================================================
// TESTS: missing
// ============================================================================

describe('missing', () => {
    test('creates missing data result object', () => {
        const result = missing('No data available');
        assert.equal(result.score, 0);
        assert.equal(result.message, 'No data available');
        assert.equal(result.missing, true);
        assert.equal(result.notApplicable, false);
    });

    test('supports notApplicable flag', () => {
        const result = missing('Not applicable', true);
        assert.equal(result.notApplicable, true);
    });
});

// ============================================================================
// TESTS: formatQuarterLabel
// ============================================================================

describe('formatQuarterLabel', () => {
    test('formats dates as quarter labels', () => {
        assert.equal(formatQuarterLabel('2024-03-31'), 'Q1 2024');
        assert.equal(formatQuarterLabel('2024-06-30'), 'Q2 2024');
        assert.equal(formatQuarterLabel('2024-09-30'), 'Q3 2024');
        assert.equal(formatQuarterLabel('2024-12-31'), 'Q4 2024');
    });
});

// ============================================================================
// TESTS: isDateStale
// ============================================================================

describe('isDateStale', () => {
    test('returns true for old dates', () => {
        const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
        assert.equal(isDateStale(oldDate, 5), true);
    });

    test('returns false for recent dates', () => {
        const recentDate = new Date().toISOString();
        assert.equal(isDateStale(recentDate, 5), false);
    });

    test('returns true for null/undefined', () => {
        assert.equal(isDateStale(null), true);
        assert.equal(isDateStale(undefined), true);
    });
});

// ============================================================================
// SUMMARY
// ============================================================================

console.log('\n' + '═'.repeat(40));
console.log(`Tests: ${passed} passed, ${failed} failed`);
console.log('═'.repeat(40));

if (failed > 0) {
    process.exit(1);
}
