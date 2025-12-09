
import { buildTickerViewModel } from "./tickerAssembler.js";

async function debugRatingFor(ticker) {
    console.log(`\n=== DEBUGGING RATING FOR ${ticker} ===`);
    try {
        const vm = await buildTickerViewModel(ticker);

        if (!vm) {
            console.log("Failed to build View Model.");
            return;
        }

        // Extract rating info
        const score = vm.ratingNormalizedScore;
        const reasons = vm.ratingReasons || [];
        const completeness = vm.ratingCompleteness;

        console.log(`Final Score: ${score} / 100 (Completeness: ${completeness})`);
        console.log("--- Breakdown ---");
        const sorted = [...reasons].sort((a, b) => b.score - a.score);

        // Group by Positive / Negative
        const pos = sorted.filter(r => r.score > 0);
        const neg = sorted.filter(r => r.score < 0);
        const neutral = sorted.filter(r => r.score === 0);

        console.log("\n[+] POSITIVE IMPACT FACTORS:");
        pos.forEach(r => console.log(`   +${r.score}  ${r.name}: ${r.message}`));

        console.log("\n[-] NEGATIVE IMPACT FACTORS:");
        neg.forEach(r => console.log(`   ${r.score}  ${r.name}: ${r.message}`));

        console.log("\n[.] NEUTRAL / MISSING:");
        neutral.forEach(r => console.log(`    0   ${r.name}: ${r.message}`));

    } catch (err) {
        console.error("Error debugging:", err);
    }
}

const tickers = ["IOVA", "SOFI", "APLD"];
for (const t of tickers) {
    await debugRatingFor(t);
}
