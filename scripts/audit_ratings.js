import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import { buildTickerViewModel } from "../server/ticker/tickerAssembler.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const DB_PATH = path.join(ROOT, "data", "edgar", "fundamentals.db");

// Heuristic checks
function auditResult(vm) {
    const issues = [];
    const score = vm.rating?.scoreTotal ?? 0;
    const risks = vm.riskFactors || [];
    const summary = vm.rating?.ratingLabel || "";

    // 1. "High Bankruptcy Risk" vs Cash Rich
    // Check if bankruptcy is flagged but company has huge cash/runway
    const riskLabels = risks.join(" ").toLowerCase();
    const bankruptcyFlag = riskLabels.includes("bankruptcy") || riskLabels.includes("solvency");
    const cash = vm.financialPosition?.cash || 0;
    const marketCap = vm.marketCap || 0;

    if (bankruptcyFlag && cash > 1e9 && marketCap > 50e9) {
        issues.push("CRITICAL: Large Cap w/ >$1B cash flagged for bankruptcy risk.");
    }

    // 2. High Rating but Unprofitable & High Debt
    if (score > 70) {
        const profitMargin = vm.profitMargins?.profitMargin;
        const debtToEq = vm.financialPosition?.debtToEquity;

        if (profitMargin !== null && profitMargin < -0.10 && debtToEq > 3) {
            issues.push(`SUSPICIOUS: Rated High (${score}) despite negative margin (${(profitMargin * 100).toFixed(1)}%) and high leverage (${debtToEq.toFixed(1)}x).`);
        }
    }

    // 3. Narrative Contradiction
    // "Balanced compounder" but negative growth
    if (summary.includes("Balanced compounder")) {
        const revGrowth = vm.growth?.revenueGrowthTTM;
        if (revGrowth !== null && revGrowth < 0) {
            issues.push("CONTRADICTION: 'Balanced compounder' label but negative revenue growth.");
        }
    }

    // 4. Missing Data Impact
    if (vm.audit?.missingCritical) {
        issues.push(`MISSING DATA: ${vm.audit.missingCritical.join(", ")}`);
    }

    return issues;
}

async function runAudit() {
    console.log("=== Starting Autonomous Rating Auditor ===");
    console.log(`DB Path: ${DB_PATH}`);

    const db = new Database(DB_PATH, { verbose: null });

    // 1. Get Tickers
    let tickers = [];
    try {
        const rows = db.prepare("SELECT DISTINCT ticker FROM fundamentals").all();
        tickers = rows.map(r => r.ticker);
    } catch (err) {
        console.error("Failed to query tickers:", err.message);
        process.exit(1);
    }

    // 2. Focused Audit for manual review
    const selected = ["KULR", "TSLA", "O"]; // small, tech, REIT

    console.log(`Selected tickers for detailed audit:\n${selected.join(", ")}\n`);

    const results = [];
    const detailedAuditTickers = selected; // Audit all of them

    // 3. Process Each
    for (const ticker of selected) {
        try {
            // console.log(`Auditing ${ticker}...`); // reduce noise
            const vm = await buildTickerViewModel(ticker);

            const issues = auditResult(vm);
            const rating = vm.rating || {};
            const score = rating.scoreTotal;
            const tier = rating.tierLabel;

            if (rating.reasons && rating.reasons.length < 5) {
                issues.push("CRITICAL: Fewer than 5 rating rules applied.");
            }

            if (rating.completeness && rating.completeness.percent < 50) {
                issues.push(`LOW COMPLETENESS: Only ${rating.completeness.percent.toFixed(0)}% relevant data found.`);
            }

            // Detailed Audit
            if (detailedAuditTickers.includes(ticker)) {
                console.log(`\n--------------------------------------------------`);
                console.log(`[DETAILED AUDIT: ${ticker}]`);
                console.log(`Score: ${rating.rawScore} -> ${rating.scoreTotal} (${tier})`);
                console.log(`Sector: ${vm.sector}`);
                console.log(`Narrative: ${vm.narrative}`);
                console.log("Reasons:");
                (rating.reasons || []).forEach(r => {
                    console.log(`  ${r.name.padEnd(35)} | ${r.score.toString().padEnd(3)} | ${r.message}`);
                });
                console.log("Override Notes:");
                (rating.notes || []).forEach(n => console.log(`  - ${n}`));
                console.log(`--------------------------------------------------\n`);
            }

            results.push({
                ticker,
                score,
                tier,
                issues,
                sector: vm.sector,
                marketCap: vm.marketCap
            });

        } catch (error) {
            console.error(`ERROR processing ${ticker}:`, error.message);
            results.push({ ticker, error: error.message });
        }
    }

    // 4. Report
    console.log("\n\n=== AUDIT REPORT SUMMARY ===");

    const errored = results.filter(r => r.error);
    const flagged = results.filter(r => r.issues && r.issues.length > 0);
    const clean = results.filter(r => !r.error && (!r.issues || r.issues.length === 0));

    console.log(`Total Audited: ${results.length}`);
    console.log(`Clean: ${clean.length}`);
    console.log(`Flagged Issues: ${flagged.length}`);
    console.log(`Errors: ${errored.length}`);

    if (flagged.length > 0) {
        console.log("\n--- FLAGGED TICKERS ---");
        flagged.forEach(f => {
            console.log(`[${f.ticker}] Score: ${f.score} (${f.tier}) | Sector: ${f.sector}`);
            f.issues.forEach(i => console.log(`   !! ${i}`));
        });
    }

    if (errored.length > 0) {
        console.log("\n--- ERRORS ---");
        errored.forEach(e => console.log(`[${e.ticker}] ${e.error}`));
    }

    console.log("\n=== END OF AUDIT ===");
}

runAudit();
