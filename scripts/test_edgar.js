
import { fetchCompanyFundamentals } from "../server/edgar/edgarFundamentals.js";

async function run() {
    try {
        console.log("Fetching IOVA...");
        const data = await fetchCompanyFundamentals("IOVA");
        console.log("Success! Rows:", data.length);
        const last = data[0];
        console.log("Last Period:", last.periodEnd);
        console.log("LongTermDebt:", last.totalDebtComponents.longTermDebt);
        console.log("ShortTermDebt:", last.totalDebtComponents.shortTermDebt);
    } catch (err) {
        console.error("FAILED:", err);
    }
}

run();
