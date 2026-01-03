/**
 * @fileoverview Unit tests for engine/calculations.js
 * Run with: node engine/tests/calculations.test.js
 */

import { strict as assert } from 'assert';
import {
    inferTaxRate,
    computeInterestCoverageTtm,
    computeInterestCoverageAnnual,
    calcFcf,
    computeRunwayYears
} from '../index.js';

// Test runner (simplified from utils.test.js)
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

describe('inferTaxRate', () => {
    test('prefers TTM if available and valid', () => {
        const ttm = { incomeBeforeIncomeTaxes: 100, incomeTaxExpenseBenefit: 25 };
        const rate = inferTaxRate({ ttm, latestAnnual: null });
        assert.equal(rate, 0.25);
    });

    test('falls back to latestAnnual if TTM invalid', () => {
        const ttm = { incomeBeforeIncomeTaxes: 0, incomeTaxExpenseBenefit: 0 };
        const latestAnnual = { incomeBeforeIncomeTaxes: 1000, incomeTaxExpenseBenefit: 210 };
        const rate = inferTaxRate({ ttm, latestAnnual });
        assert.equal(rate, 0.21);
    });

    test('returns null if both invalid', () => {
        const rate = inferTaxRate({ ttm: {}, latestAnnual: {} });
        assert.equal(rate, null);
    });

    test('clamps rate between 0 and 0.5', () => {
        const ttm = { incomeBeforeIncomeTaxes: 100, incomeTaxExpenseBenefit: 80 }; // 80%
        const rate = inferTaxRate({ ttm });
        assert.equal(rate, 0.5);

        const ttmNeg = { incomeBeforeIncomeTaxes: 100, incomeTaxExpenseBenefit: -10 }; // negative tax
        const rateNeg = inferTaxRate({ ttm: ttmNeg });
        assert.equal(rateNeg, 0);
    });
});

describe('computeInterestCoverageTtm', () => {
    test('computes coverage for 4 quarters', () => {
        const quarters = [
            { periodEnd: '2023-12-31', operatingIncome: 100, interestExpense: -10 },
            { periodEnd: '2023-09-30', operatingIncome: 100, interestExpense: -10 },
            { periodEnd: '2023-06-30', operatingIncome: 100, interestExpense: -10 },
            { periodEnd: '2023-03-31', operatingIncome: 100, interestExpense: -10 }
        ];
        // EBIT = 400, Interest = 40
        const result = computeInterestCoverageTtm(quarters);
        assert.equal(result.value, 10);
        assert.equal(result.status, 'ok');
    });

    test('annualizes interest if < 4 quarters available', () => {
        const quarters = [
            { periodEnd: '2023-12-31', operatingIncome: 100, interestExpense: -10 },
            { periodEnd: '2023-09-30', operatingIncome: 100, interestExpense: -10 }
        ];
        // EBIT = 200, Interest = 20. But annualized interest = (20/2)*4 = 40. Coverage = 200/40 = 5.
        const result = computeInterestCoverageTtm(quarters);
        assert.equal(result.value, 5);
        assert.equal(result.status, 'annualized-interest');
    });

    test('handles debt-free case (zero interest, low debt)', () => {
        const quarters = [
            { periodEnd: '2023-12-31', operatingIncome: 100, interestExpense: 0, totalDebt: 0 },
            { periodEnd: '2023-09-30', operatingIncome: 100, interestExpense: 0, totalDebt: 0 }
        ];
        const result = computeInterestCoverageTtm(quarters);
        assert.equal(result.value, Infinity);
        assert.equal(result.status, 'debt-free');
    });
});

describe('calcFcf', () => {
    test('computes FCF correctly (OCF + Capex)', () => {
        const row = { operatingCashFlow: 100, capex: -20 };
        assert.equal(calcFcf(row), 80);
    });
    test('handles missing inputs as null', () => {
        assert.equal(calcFcf({ operatingCashFlow: 100 }), null);
    });
});

describe('computeRunwayYears', () => {
    test('returns Infinity if FCF positive', () => {
        const data = {
            snapshot: { freeCashFlowTTM: 100 },
            quarterlySeries: [{ cash: 50, periodEnd: '2023-12-31' }]
        };
        assert.equal(computeRunwayYears(data), Infinity);
    });

    test('calculates runway years if burn', () => {
        const data = {
            snapshot: { freeCashFlowTTM: -50 }, // Burn 50/yr
            quarterlySeries: [{ cash: 100, periodEnd: '2023-12-31' }] // Cash 100
        };
        // 100 / 50 = 2 years
        assert.equal(computeRunwayYears(data), 2);
    });

    test('returns 0 if cash is empty but burn exists', () => {
        const data = {
            snapshot: { freeCashFlowTTM: -50 },
            quarterlySeries: [{ cash: 0, periodEnd: '2023-12-31' }]
        };
        assert.equal(computeRunwayYears(data), 0);
    });

    test('skips Financials sector', () => {
        const data = { sector: 'Finance' };
        assert.equal(computeRunwayYears(data), null);
    });
});

// Summary
if (failed > 0) process.exit(1);
console.log(`\nAll ${passed} tests passed.`);
