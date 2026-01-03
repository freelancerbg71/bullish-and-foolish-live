/**
 * @fileoverview Unit tests for engine/stockAdjustments.js
 * Run with: node engine/tests/stockAdjustments.test.js
 */

import { strict as assert } from 'assert';
import {
    detectLikelySplit,
    detectLikelyReverseSplit,
    computeShareChangeWithSplitGuard
} from '../index.js';

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

// ----------------------------------------------------------------------------

describe('detectLikelySplit', () => {
    test('detects 2:1 split', () => {
        // newest first
        const periods = [
            { periodEnd: '2024-03-31', sharesOutstanding: 200, epsBasic: 0.5, netIncome: 100 },
            { periodEnd: '2023-12-31', sharesOutstanding: 100, epsBasic: 1.0, netIncome: 100 }
        ];
        const result = detectLikelySplit(periods, { tolerance: 0.1 });
        assert.ok(result);
        assert.equal(result.flagged, true);
        assert.equal(result.sharesRatio, 2);
    });

    test('ignores normal dilution', () => {
        const periods = [
            { periodEnd: '2024-03-31', sharesOutstanding: 110, epsBasic: 0.9, netIncome: 100 },
            { periodEnd: '2023-12-31', sharesOutstanding: 100, epsBasic: 1.0, netIncome: 100 }
        ];
        const result = detectLikelySplit(periods);
        assert.equal(result, null);
    });

    test('requires stable net income', () => {
        const periods = [
            { periodEnd: '2024-03-31', sharesOutstanding: 200, epsBasic: 0.5, netIncome: 50 }, // Earnings dropped by half!
            { periodEnd: '2023-12-31', sharesOutstanding: 100, epsBasic: 1.0, netIncome: 100 }
        ];
        // Income dropped by 50%. Shares doubled. EPS halved.
        // This looks like a split mathematically (shares*2, eps/2), but Net Income changed.
        // Logic says: if Net Income is NOT stable, it might NOT be a split (or maybe it is, but we are conservative).
        // Wait, logic says: "if (niStable === false) continue".
        // niStable logic: Math.abs(niCurr / niPrev - 1) < 0.35.
        // Here 50/100 - 1 = -0.5. |0.5| > 0.35. Stable = false.
        const result = detectLikelySplit(periods);
        assert.equal(result, null);
    });
});

describe('detectLikelyReverseSplit', () => {
    test('detects 1:4 reverse split', () => {
        const periods = [
            { periodEnd: '2024-03-31', sharesOutstanding: 25, epsBasic: 4.0, netIncome: 100 },
            { periodEnd: '2023-12-31', sharesOutstanding: 100, epsBasic: 1.0, netIncome: 100 }
        ];
        const result = detectLikelyReverseSplit(periods);
        assert.ok(result);
        assert.equal(result.sharesRatio, 4); // 4 shares became 1. Ratio = Prev/Curr = 100/25 = 4.
    });
});

describe('computeShareChangeWithSplitGuard', () => {
    test('reports normal YoY change', () => {
        // Needs 5 periods for YoY lookback logic
        const periods = [
            { periodEnd: '2024-12-31', sharesOutstanding: 110 },
            { periodEnd: '2024-09-30', sharesOutstanding: 108 },
            { periodEnd: '2024-06-30', sharesOutstanding: 106 },
            { periodEnd: '2024-03-31', sharesOutstanding: 104 },
            { periodEnd: '2023-12-31', sharesOutstanding: 100 }
        ];
        const result = computeShareChangeWithSplitGuard(periods);
        // 110 vs 100 = +10%
        assert.equal(result.rawYoY, 10);
        assert.equal(result.changeYoY, 10);
    });

    test('suppresses YoY change on split detection', () => {
        const periods = [
            { periodEnd: '2024-12-31', sharesOutstanding: 200, epsBasic: 0.5, netIncome: 100 },
            { periodEnd: '2024-09-30', sharesOutstanding: 100, epsBasic: 1.0, netIncome: 100 },
            { periodEnd: '2024-06-30', sharesOutstanding: 100 },
            { periodEnd: '2024-03-31', sharesOutstanding: 100 },
            { periodEnd: '2023-12-31', sharesOutstanding: 100 }
        ];
        // Raw YoY would be +100% (200 vs 100).
        // But detection should invoke split guard.
        const result = computeShareChangeWithSplitGuard(periods);
        assert.equal(result.rawYoY, 100);
        assert.equal(result.changeYoY, null); // Suppressed
        assert.ok(result.splitSignal?.flagged);
    });
});

if (failed > 0) process.exit(1);
console.log(`\nAll ${passed} tests passed.`);
