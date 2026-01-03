/**
 * Live Ticker Rating Comparison
 * 
 * Fetches ratings for 10 tickers from the live server
 * to verify consistent scoring behavior.
 * 
 * Run: npm run dev (in separate terminal)
 * Then: node engine/tests/live_ticker_test.js
 */

const TEST_TICKERS = [
    'GNE',    // The problematic one - was 97 live vs 78 local
    'AAPL',   // Large cap tech - should be stable
    'META',   // Large cap tech
    'NVDA',   // Large cap tech
    'PFE',    // Large cap pharma
    'KULR',   // Small cap (known edge case)
    'DFLI',   // Small cap
    'JPM',    // Financials
    'XOM',    // Energy
    'MSFT'    // Large cap tech (stable benchmark)
];

const BASE_URL = process.env.API_URL || 'http://localhost:3000';

async function fetchTickerRating(ticker) {
    const url = `${BASE_URL}/api/ticker/${ticker}`;

    try {
        const response = await fetch(url);
        if (!response.ok) {
            return { ticker, error: `HTTP ${response.status}` };
        }

        const json = await response.json();
        const data = json.data || json; // Handle both wrapped and unwrapped responses

        // API returns flat structure: ratingNormalizedScore, ratingRawScore, etc.
        const reasons = data.ratingReasons || [];

        return {
            ticker,
            normalizedScore: data.ratingNormalizedScore ?? null,
            rawScore: data.ratingRawScore ?? null,
            tierLabel: data.ratingTierLabel ?? null,
            pennyStock: data.pennyStock ?? false,
            completeness: data.ratingCompleteness?.percent ?? null,
            sector: data.sector ?? 'Unknown',
            marketCap: data.snapshot?.marketCap ?? data.keyMetrics?.marketCap ?? null,
            rulesApplied: reasons.filter(r => !r.missing && !r.notApplicable).length,
            rulesMissing: reasons.filter(r => r.missing).length,
            topContributors: reasons
                .filter(r => !r.missing && !r.notApplicable && r.score > 0)
                .sort((a, b) => b.score - a.score)
                .slice(0, 5)
                .map(r => ({ name: r.name, score: r.score })),
            topDetractors: reasons
                .filter(r => !r.missing && !r.notApplicable && r.score < 0)
                .sort((a, b) => a.score - b.score)
                .slice(0, 5)
                .map(r => ({ name: r.name, score: r.score })),
            overrideNotes: data.ratingNotes?.overrideNotes || [],
            missingNotes: data.ratingNotes?.missingNotes || [],
            allRules: reasons // Keep all rules for detailed analysis
        };
    } catch (err) {
        return { ticker, error: err.message };
    }
}

function formatMarketCap(val) {
    if (val == null || !Number.isFinite(val)) return 'N/A';
    if (val >= 1e12) return `$${(val / 1e12).toFixed(1)}T`;
    if (val >= 1e9) return `$${(val / 1e9).toFixed(1)}B`;
    if (val >= 1e6) return `$${(val / 1e6).toFixed(0)}M`;
    return `$${val.toFixed(0)}`;
}

async function main() {
    console.log('='.repeat(80));
    console.log('LIVE TICKER RATING COMPARISON TEST');
    console.log('='.repeat(80));
    console.log(`Base URL: ${BASE_URL}`);
    console.log(`Testing ${TEST_TICKERS.length} tickers...`);
    console.log();

    const results = [];

    for (const ticker of TEST_TICKERS) {
        process.stdout.write(`Fetching ${ticker}... `);
        const result = await fetchTickerRating(ticker);
        results.push(result);

        if (result.error) {
            console.log(`ERROR: ${result.error}`);
        } else {
            console.log(`Score: ${result.normalizedScore} (${result.tierLabel})`);
        }
    }

    console.log();
    console.log('='.repeat(80));
    console.log('RESULTS SUMMARY');
    console.log('='.repeat(80));
    console.log();

    // Table header
    console.log('Ticker | Score | Tier     | Raw   | Rules | Penny | Sector            | Market Cap');
    console.log('-'.repeat(95));

    results.forEach(r => {
        if (r.error) {
            console.log(`${r.ticker.padEnd(6)} | ERROR: ${r.error}`);
        } else {
            const score = r.normalizedScore != null ? String(r.normalizedScore).padStart(3) : 'N/A';
            const tier = (r.tierLabel || 'N/A').padEnd(8);
            const raw = r.rawScore != null ? String(r.rawScore).padStart(4) : 'N/A ';
            const rulesStr = `${r.rulesApplied}/${r.rulesApplied + r.rulesMissing}`;
            const penny = r.pennyStock ? 'YES' : 'no ';
            const sector = (r.sector || 'N/A').substring(0, 17).padEnd(17);
            const mcap = formatMarketCap(r.marketCap).padStart(10);

            console.log(`${r.ticker.padEnd(6)} | ${score} | ${tier} | ${raw} | ${rulesStr.padEnd(5)} | ${penny}   | ${sector} | ${mcap}`);
        }
    });

    console.log();

    // Detailed breakdown for GNE (the problematic one)
    const gne = results.find(r => r.ticker === 'GNE');
    if (gne && !gne.error) {
        console.log('='.repeat(80));
        console.log('DETAILED BREAKDOWN: GNE (Problem Ticker)');
        console.log('='.repeat(80));
        console.log();
        console.log(`Normalized Score: ${gne.normalizedScore}`);
        console.log(`Raw Score: ${gne.rawScore}`);
        console.log(`Tier: ${gne.tierLabel}`);
        console.log(`Penny Stock Flag: ${gne.pennyStock}`);
        console.log(`Data Completeness: ${gne.completeness}%`);
        console.log();

        console.log('Top Score Contributors:');
        gne.topContributors.forEach(c => {
            console.log(`   +${String(c.score).padStart(2)} | ${c.name}`);
        });
        console.log();

        console.log('Top Score Detractors:');
        gne.topDetractors.forEach(d => {
            console.log(`   ${String(d.score).padStart(3)} | ${d.name}`);
        });
        console.log();

        if (gne.overrideNotes.length > 0) {
            console.log('Override Notes:');
            gne.overrideNotes.forEach(n => console.log(`   - ${n}`));
            console.log();
        }

        if (gne.missingNotes.length > 0) {
            console.log('Missing Data Notes:');
            gne.missingNotes.forEach(n => console.log(`   - ${n}`));
            console.log();
        }
    }

    // Check for anomalies
    console.log('='.repeat(80));
    console.log('ANOMALY CHECK');
    console.log('='.repeat(80));
    console.log();

    const anomalies = [];

    // Check for unexpectedly high scores for small caps
    results.forEach(r => {
        if (r.error) return;

        // Small cap + high score = suspicious
        if (r.marketCap && r.marketCap < 500e6 && r.normalizedScore > 85) {
            anomalies.push(`${r.ticker}: High score (${r.normalizedScore}) for small-cap ($${(r.marketCap / 1e6).toFixed(0)}M)`);
        }

        // Penny stock + very high score = very suspicious
        if (r.pennyStock && r.normalizedScore > 70) {
            anomalies.push(`${r.ticker}: High score (${r.normalizedScore}) despite penny stock flag`);
        }

        // Low completeness + high score = suspicious
        if (r.completeness && r.completeness < 50 && r.normalizedScore > 70) {
            anomalies.push(`${r.ticker}: High score (${r.normalizedScore}) with only ${r.completeness}% data completeness`);
        }
    });

    if (anomalies.length > 0) {
        console.log('⚠️  Potential Anomalies Detected:');
        anomalies.forEach(a => console.log(`   - ${a}`));
    } else {
        console.log('✓  No obvious anomalies detected');
    }

    console.log();
    console.log('='.repeat(80));
    console.log('TEST COMPLETE');
    console.log('='.repeat(80));
}

main().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
