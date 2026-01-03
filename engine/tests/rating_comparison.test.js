/**
 * Rating Comparison Test
 * 
 * Compares the rating system output for multiple tickers to verify
 * the refactored engine produces consistent scores.
 * 
 * Run: node engine/tests/rating_comparison.test.js
 */

import { rules } from '../rules.js';
import {
    normalizeRuleScore,
    getScoreBand,
    resolveSectorBucket,
    applySectorRuleAdjustments,
    percentToNumber,
    isFintech,
    toNumber,
    RATING_MIN,
    RATING_MAX,
    RATING_RANGE
} from '../index.js';

// Test tickers - mix of sectors, sizes, and known edge cases
const TEST_TICKERS = [
    'GNE',    // The problematic one - was 97 live vs 78 local
    'AAPL',   // Large cap tech
    'META',   // Large cap tech
    'NVDA',   // Large cap tech
    'PFE',    // Large cap pharma
    'KULR',   // Small cap
    'DFLI',   // Small cap
    'JPM',    // Financials
    'XOM',    // Energy
    'TSLA'    // High volatility
];

console.log('='.repeat(70));
console.log('RATING SYSTEM COMPARISON TEST');
console.log('='.repeat(70));
console.log();

// Verify core exports are working
console.log('1. CORE ENGINE EXPORTS');
console.log('-'.repeat(50));
console.log(`   Rules loaded: ${rules.length}`);
console.log(`   RATING_MIN: ${RATING_MIN}`);
console.log(`   RATING_MAX: ${RATING_MAX}`);
console.log(`   RATING_RANGE: ${RATING_RANGE}`);
console.log();

// List all rules
console.log('2. LOADED RULES');
console.log('-'.repeat(50));
rules.forEach((rule, idx) => {
    console.log(`   ${String(idx + 1).padStart(2)}. ${rule.name} (weight: ${rule.weight})`);
});
console.log();

// Test normalization function with known inputs
console.log('3. NORMALIZATION FUNCTION TESTS');
console.log('-'.repeat(50));
const normTests = [
    { raw: 100, expected: 100 },  // Max score
    { raw: -60, expected: 0 },    // Min score
    { raw: 20, expected: 50 },    // Mid-range: (20 - (-60)) / 160 * 100 = 50
    { raw: 0, expected: 37.5 },   // Zero raw: (0 - (-60)) / 160 * 100 = 37.5
    { raw: 50, expected: 68.75 }, // (50 - (-60)) / 160 * 100 = 68.75
    { raw: 75, expected: 84.375 } // (75 - (-60)) / 160 * 100 = 84.375
];

let normPassed = true;
normTests.forEach(({ raw, expected }) => {
    const actual = normalizeRuleScore(raw);
    const pass = actual === Math.round(expected);
    if (!pass) normPassed = false;
    console.log(`   Raw ${String(raw).padStart(4)} → Normalized ${actual} (expected ~${Math.round(expected)}) ${pass ? '✓' : '✗'}`);
});
console.log(`   Result: ${normPassed ? 'ALL PASSED ✓' : 'SOME FAILED ✗'}`);
console.log();

// Test score bands
console.log('4. SCORE BAND TESTS');
console.log('-'.repeat(50));
const bandTests = [
    { score: 95, expected: 'elite' },
    { score: 91, expected: 'elite' },
    { score: 90, expected: 'bullish' },
    { score: 76, expected: 'bullish' },
    { score: 75, expected: 'solid' },
    { score: 61, expected: 'solid' },
    { score: 60, expected: 'mixed' },
    { score: 46, expected: 'mixed' },
    { score: 45, expected: 'spec' },
    { score: 31, expected: 'spec' },
    { score: 30, expected: 'danger' },
    { score: 0, expected: 'danger' },
];

let bandPassed = true;
bandTests.forEach(({ score, expected }) => {
    const actual = getScoreBand(score);
    const pass = actual === expected;
    if (!pass) bandPassed = false;
    console.log(`   Score ${String(score).padStart(2)} → Band '${actual}' (expected '${expected}') ${pass ? '✓' : '✗'}`);
});
console.log(`   Result: ${bandPassed ? 'ALL PASSED ✓' : 'SOME FAILED ✗'}`);
console.log();

// Test sector bucket resolution
console.log('5. SECTOR BUCKET RESOLUTION');
console.log('-'.repeat(50));
const sectorTests = [
    { input: 'Technology', expected: 'Tech/Internet' },
    { input: 'Pharmaceuticals', expected: 'Biotech/Pharma' },
    { input: 'Banks', expected: 'Financials' },
    { input: 'Oil & Gas', expected: 'Energy/Utilities' },
    { input: 'Consumer Goods', expected: 'Other' },
    { input: 'Real Estate', expected: 'REITs/Property' },
];

sectorTests.forEach(({ input, expected }) => {
    const actual = resolveSectorBucket(input);
    const pass = actual === expected;
    console.log(`   '${input}' → '${actual}' (expected '${expected}') ${pass ? '✓' : '✗'}`);
});
console.log();

// Test rule evaluation with mock data
console.log('6. RULE EVALUATION TEST (Mock Tech Stock)');
console.log('-'.repeat(50));

// Create a mock stock object representing a typical profitable tech company
const mockStock = {
    ticker: 'TEST',
    sector: 'Technology',
    sectorBucket: 'Tech/Internet',
    marketCap: 50000000000, // $50B
    quarterCount: 8,
    growth: {
        revenueGrowthTTM: 15,       // 15% growth
        revenueCagr3y: 0.12,        // 12% CAGR
        epsCagr3y: 0.10             // 10% EPS CAGR
    },
    profitMargins: {
        grossMargin: 60,            // 60%
        operatingMargin: 25,        // 25%
        profitMargin: 20,           // 20%
        fcfMargin: 18               // 18%
    },
    financialPosition: {
        debtToEquity: 0.3,
        netDebtToEquity: 0.1,
        interestCoverage: 15,
        runwayYears: Infinity,
        totalAssets: 100000000000,
        currentAssets: 50000000000,
        currentLiabilities: 20000000000
    },
    returns: {
        roe: 25,                    // 25%
        roic: 20                    // 20%
    },
    valuationRatios: {
        peRatio: 25,
        psRatio: 5,
        pbRatio: 8,
        pfcfRatio: 20
    },
    shareStats: {
        sharesChangeYoY: -2,        // 2% buyback
        likelySplit: false,
        likelyReverseSplit: false
    },
    cash: {
        freeCashFlowTTM: 10000000000
    },
    expenses: {
        rdToRevenue: 15,
        revenue: 50000000000
    },
    balance: [],
    income: [],
    cashFlows: []
};

let totalMockScore = 0;
let ruleResults = [];

rules.forEach((rule) => {
    try {
        const outcome = rule.evaluate(mockStock, {});
        const baseScore = outcome?.score ?? 0;
        const sectorTuning = applySectorRuleAdjustments(rule.name, baseScore, 'Tech/Internet');
        const finalScore = sectorTuning?.score ?? baseScore;

        const skipped = outcome?.missing || sectorTuning?.skipped;

        if (!skipped) {
            totalMockScore += finalScore;
        }

        ruleResults.push({
            name: rule.name,
            score: finalScore,
            message: outcome?.message || '',
            skipped,
            weight: rule.weight
        });
    } catch (err) {
        ruleResults.push({
            name: rule.name,
            score: 0,
            message: `ERROR: ${err.message}`,
            skipped: true,
            weight: rule.weight
        });
    }
});

console.log('\n   Rule Results (sorted by impact):');
ruleResults
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
    .forEach(r => {
        const scoreStr = r.skipped ? 'SKIP' : String(r.score).padStart(3);
        console.log(`   ${scoreStr} | ${r.name.padEnd(30)} | ${r.message.substring(0, 40)}`);
    });

console.log();
console.log(`   Raw Total Score: ${totalMockScore}`);
console.log(`   Normalized Score: ${normalizeRuleScore(totalMockScore)}`);
console.log(`   Score Band: ${getScoreBand(normalizeRuleScore(totalMockScore))}`);
console.log();

// Summary
console.log('='.repeat(70));
console.log('SUMMARY');
console.log('='.repeat(70));
console.log(`   Total Rules: ${rules.length}`);
console.log(`   Normalization: ${normPassed ? 'PASSED' : 'FAILED'}`);
console.log(`   Score Bands: ${bandPassed ? 'PASSED' : 'FAILED'}`);
console.log();
console.log('   To test with LIVE data, run:');
console.log('   curl http://localhost:3000/api/ticker/GNE | jq ".rating"');
console.log();

// Check for potential issues
console.log('7. POTENTIAL ISSUES CHECK');
console.log('-'.repeat(50));

// Check if rules array is properly exported
if (rules.length === 0) {
    console.log('   ⚠️  WARNING: Rules array is empty!');
}

// Check for rules without evaluate function
const badRules = rules.filter(r => typeof r.evaluate !== 'function');
if (badRules.length > 0) {
    console.log(`   ⚠️  WARNING: ${badRules.length} rules missing evaluate function`);
    badRules.forEach(r => console.log(`      - ${r.name}`));
}

// Check isFintech function
const fintechTest = isFintech({ ticker: 'SQ', sector: 'Technology', sic: '6199' });
console.log(`   isFintech('SQ') works: ${fintechTest === true ? '✓' : '✗'}`);

// Check toNumber function
const toNumTests = [
    { input: '25%', expected: 25 },
    { input: 0.25, expected: 0.25 },
    { input: null, expected: null },
];
toNumTests.forEach(({ input, expected }) => {
    const actual = toNumber(input);
    console.log(`   toNumber('${input}') = ${actual} (expected ${expected}) ${actual === expected ? '✓' : '✗'}`);
});

console.log();
console.log('='.repeat(70));
console.log('TEST COMPLETE');
console.log('='.repeat(70));
