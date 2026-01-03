/**
 * @fileoverview Unit tests for engine/stockBuilder.js
 * Run with: node engine/tests/stockBuilder.test.js
 */

import { strict as assert } from 'assert';
import { buildStockForRules } from '../index.js';

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

describe('buildStockForRules', () => {
    // Minimal valid VM
    const mockVm = {
        ticker: 'TEST',
        companyName: 'Test Corp',
        sector: 'Technology',
        snapshot: { marketCap: 1e9 },
        ttm: {
            revenue: 100,
            freeCashFlow: 20,
            netIncome: 15,
            operatingIncome: 25,
            grossProfit: 60
        },
        quarterlySeries: [
            { periodEnd: '2024-03-31', revenue: 25, netIncome: 5, operatingCashFlow: 10, capex: -5, totalDebt: 50, cash: 10, totalEquity: 200 },
            { periodEnd: '2023-12-31', revenue: 25, netIncome: 4, operatingCashFlow: 8, capex: -2, totalDebt: 50, cash: 8, totalEquity: 195 },
            { periodEnd: '2023-09-30', revenue: 25, netIncome: 3, operatingCashFlow: 5, capex: -2, totalDebt: 50, cash: 5, totalEquity: 190 },
            { periodEnd: '2023-06-30', revenue: 25, netIncome: 3, operatingCashFlow: 5, capex: -2, totalDebt: 50, cash: 3, totalEquity: 185 },
            // Year ago
            { periodEnd: '2023-03-31', revenue: 20, netIncome: 2, operatingCashFlow: 4, capex: -2, totalDebt: 45, cash: 2, totalEquity: 180 }
        ]
    };

    test('builds standard structure', () => {
        const stock = buildStockForRules(mockVm);
        assert.equal(stock.ticker, 'TEST');
        assert.equal(stock.sector, 'Technology');
        assert.equal(stock.marketCap, 1e9);
    });

    test('computes margins from TTM', () => {
        const stock = buildStockForRules(mockVm);
        // TTM Revenue 100, TTM NetIncome 15 -> 15%
        assert.equal(stock.profitMargins.netIncome, 15);
        // TTM FCF 20 -> 20%
        assert.equal(stock.profitMargins.fcfMargin, 20);
    });

    test('computes growth (revenue trend)', () => {
        const stock = buildStockForRules(mockVm);
        // Growth calc checks trend from quarters or snapshot.
        // We didn't provide snapshot.revenueYoYPct.
        // `calcTrend` inside builder uses quarters.
        // Latest (2024-03-31) Rev 25. YearAgo (2023-03-31) Rev 20.
        // Growth = (25 - 20) / 20 = 5/20 = 25%.
        assert.equal(stock.growth.revenueGrowthTTM, 25);
    });

    test('computes financial position', () => {
        const stock = buildStockForRules(mockVm);
        // Latest balance (2024-03-31): Debt 50, Cash 10. Net Debt = 40.
        assert.equal(stock.financialPosition.netDebt, 40);
        // Debt/Equity = 50 / 200 = 0.25 (or normalized to ratio?)
        // In builder: debtToEquity = toNumber(debtTotal / Equity)
        assert.equal(stock.financialPosition.debtToEquity, 0.25);
    });

    test('handles missing debt (assumed zero if none)', () => {
        const vmNoDebt = {
            ...mockVm,
            quarterlySeries: [
                { periodEnd: '2024-03-31', revenue: 10, totalDebt: 0, cash: 5, totalEquity: 100 }
            ]
        };
        const stock = buildStockForRules(vmNoDebt);
        assert.equal(stock.financialPosition.netDebt, -5); // 0 - 5 = -5
    });

    test('handles annual mode', () => {
        const vmAnnual = {
            ...mockVm,
            annualMode: true,
            annualSeries: [
                { periodEnd: '2023-12-31', revenue: 100, netIncome: 10, totalEquity: 100 }
            ],
            // Remove TTM so it falls back to Annual for margins, or check valuation logic
            ttm: null,
            quarterlySeries: null
        };
        const stock = buildStockForRules(vmAnnual);
        // Margins calls calcMargin(10, 100) -> 10%
        assert.equal(stock.profitMargins.netIncome, 10);
    });
});

if (failed > 0) process.exit(1);
console.log(`\nAll ${passed} tests passed.`);
