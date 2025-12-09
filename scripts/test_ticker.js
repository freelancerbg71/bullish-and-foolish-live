import { buildTickerViewModel } from "../server/ticker/tickerAssembler.js";
import { getFundamentalsForTicker } from "../server/edgar/fundamentalsStore.js";

async function run() {
    const tickers = ["KULR"];

    for (const ticker of tickers) {
        try {
            console.log(`\n=== Analyzing ${ticker} ===`);
            const result = await buildTickerViewModel(ticker);
            if (result) {
                console.log(`[PASS] ${ticker} | Score: ${result.ratingRawScore} (Norm: ${Math.round(result.ratingNormalizedScore)}) | Tier: ${result.ratingTierLabel}`);
                console.log(`  Market Cap: ${result.keyMetrics?.marketCap ? (result.keyMetrics.marketCap / 1e9).toFixed(1) + "B" : "N/A"}`);

                // Debug Risk Scores
                console.log("  --- Risk Scores ---");
                const bScore = result.projections?.bankruptcyRiskScore;
                const dScore = result.projections?.dilutionRiskScore;
                console.log(`  Bankruptcy Risk Score: ${bScore} (Threshold > 0.5 triggers flag)`);
                console.log(`  Dilution Risk Score: ${dScore} (Threshold > 0.5 triggers flag)`);

                if (result.ratingNotes && result.ratingNotes.length) {
                    console.log("  Rating Notes:", result.ratingNotes.join("; "));
                }
                if (result.riskFactors && result.riskFactors.length) {
                    console.log("  Risk Factors:", result.riskFactors);
                }
            } else {
                console.log(`[FAIL] ${ticker} returned null`);
            }
        } catch (err) {
            console.error(`[ERROR] ${ticker}:`, err.message);
        }
    }
}

run();
