import { buildTickerViewModel } from "./tickerAssembler.js";

const tickers = ["FLUT", "TKO", "AAPL", "META"];

async function analyze(t) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`=== ${t} ===`);
    console.log("=".repeat(60));

    try {
        const vm = await buildTickerViewModel(t);
        if (!vm) {
            console.log("Failed to build View Model");
            return;
        }

        console.log(`\nSCORE: ${vm.ratingNormalizedScore}/100 (Raw: ${vm.ratingRawScore})`);
        console.log(`TIER: ${vm.ratingTierLabel}`);
        console.log(`SECTOR: ${vm.sector}`);
        console.log(`MARKET CAP: ${vm.keyMetrics?.marketCap ? "$" + (vm.keyMetrics.marketCap / 1e9).toFixed(2) + "B" : "N/A"}`);

        // Key valuation data
        console.log(`\nVALUATION METRICS:`);
        console.log(`  P/E: ${vm.valuationRatios?.peRatio ?? "N/A"}`);
        console.log(`  P/S: ${vm.valuationRatios?.psRatio ?? "N/A"}`);
        console.log(`  P/B: ${vm.valuationRatios?.pbRatio ?? "N/A"}`);

        // Key profitability
        console.log(`\nPROFITABILITY:`);
        console.log(`  Gross Margin: ${vm.keyMetrics?.grossMargin ? (vm.keyMetrics.grossMargin * 100).toFixed(1) + "%" : "N/A"}`);
        console.log(`  Operating Margin: ${vm.keyMetrics?.operatingMargin ? (vm.keyMetrics.operatingMargin * 100).toFixed(1) + "%" : "N/A"}`);
        console.log(`  Net Margin: ${vm.keyMetrics?.netMargin ? (vm.keyMetrics.netMargin * 100).toFixed(1) + "%" : "N/A"}`);
        console.log(`  ROE: ${vm.keyMetrics?.roe ? (vm.keyMetrics.roe * 100).toFixed(1) + "%" : "N/A"}`);
        console.log(`  ROIC: ${vm.keyMetrics?.roic ? (vm.keyMetrics.roic * 100).toFixed(1) + "%" : "N/A"}`);

        const reasons = vm.ratingReasons || [];
        const pos = reasons.filter(r => r.score > 0).sort((a, b) => b.score - a.score);
        const neg = reasons.filter(r => r.score < 0).sort((a, b) => a.score - b.score);

        console.log(`\n[+] TOP POSITIVE (${pos.length} total):`);
        pos.slice(0, 8).forEach(r => console.log(`  +${r.score}  ${r.name}: ${r.message}`));

        console.log(`\n[-] TOP NEGATIVE (${neg.length} total):`);
        neg.slice(0, 8).forEach(r => console.log(`  ${r.score}  ${r.name}: ${r.message}`));

    } catch (err) {
        console.error(`Error: ${err.message}`);
    }
}

// Run sequentially
for (const t of tickers) {
    await analyze(t);
}
console.log("\n\n=== DONE ===");
