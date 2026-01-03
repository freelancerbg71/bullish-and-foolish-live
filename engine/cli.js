
import { rules } from "./index.js";
import { normalizeRuleScore, getScoreBand } from "./index.js";

/**
 * CLI / Demo script for the Open Fundamentals Engine.
 * 
 * Usage: node engine/cli.js
 */

// 1. Create a mock company object (e.g. "Tech Giant Corp")
const mockStock = {
    ticker: "MOCK",
    sector: "Technology",
    marketCap: 2500000000000, // $2.5T

    // Financial Ratios (pre-calculated or raw, depending on how rules expect them)
    valuationRatios: {
        peRatio: 25.5,
        psRatio: 6.2,
        pbRatio: 15.0
    },
    profitMargins: {
        grossMargin: "45.0%",
        operatingMargin: "30.0%",
        fcfMargin: "25.0%",
        netIncome: 100000000000 // Only needed if rule checks it directly
    },
    growth: {
        revenueGrowthYoY: "12.5%",
        revenueCagr3y: 0.15
    },
    financialPosition: {
        debtToEquity: 1.2,
        netDebtToFcf: 0.5,
        totalAssets: 400000000000
    },
    shareStats: {
        sharesChangeYoY: "-3.5%" // Buybacks
    },
    cash: {
        shareBuybacksTTM: 80000000000,
        dividendsPaidTTM: 15000000000,
        shareholderReturnTTM: 95000000000,
        totalReturnPctFcf: "0.95",
        freeCashFlowTTM: 100000000000
    },
    returns: {
        roic: "28.5%",
        roe: "35.0%"
    }
};

console.log("------------------------------------------");
console.log(`🤖 Open Fundamentals Engine - CLI Demo`);
console.log("------------------------------------------");
console.log(`Analyzing: ${mockStock.ticker} (${mockStock.sector})`);
console.log(`Market Cap: $${(mockStock.marketCap / 1e9).toFixed(1)}B`);
console.log("------------------------------------------\n");

let totalScore = 0;
let ruleCount = 0;

// 2. Run the Rules
rules.forEach(rule => {
    // Some rules might skip if missing data, returns { score, message, missing, notApplicable }
    const result = rule.evaluate(mockStock);

    // Skip if null (internal error) or notApplicable
    if (!result || result.notApplicable) return;

    // missing data usually scores 0 or penalty
    const score = result.score || 0;

    console.log(`[${result.score >= 0 ? '+' : ''}${Math.round(score)}] ${rule.name}`);
    console.log(`   └─ ${result.message}`);

    totalScore += score;
    ruleCount++;
});

// 3. Normalize & Finalize
const finalScore = normalizeRuleScore(totalScore);
const tier = getScoreBand(finalScore);

console.log("\n------------------------------------------");
console.log(`Final Raw Score: ${Math.round(totalScore)}`);
console.log(`Normalized Score: ${finalScore} / 100`);
console.log(`Rating Tier: ${tier.toUpperCase()}`);
console.log("------------------------------------------");
