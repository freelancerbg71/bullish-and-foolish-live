/**
 * update_sectors.js
 * 
 * Updates sector/SIC data ONLY from SEC submissions.
 * Does NOT re-download fundamentals - only patches existing data with sector info.
 * 
 * Usage:
 *   node scripts/update_sectors.js              - Update all tickers
 *   node scripts/update_sectors.js --limit 50  - Test with 50 tickers
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'edgar', 'fundamentals.db');

// SEC EDGAR URLs
const COMPANY_TICKERS_URL = 'https://www.sec.gov/files/company_tickers_exchange.json';
const SUBMISSIONS_BASE_URL = 'https://data.sec.gov/submissions';

// User-Agent as required by SEC
const USER_AGENT = process.env.DATA_USER_AGENT || 'BullishAndFoolish/1.0 (contact@example.com)';

// Rate limit: SEC requests max 10/sec
const RATE_LIMIT_MS = 150;

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(url, {
                headers: { 'User-Agent': USER_AGENT }
            });
            if (response.ok) {
                return await response.json();
            }
            if (response.status === 429 || response.status >= 500) {
                console.log(`  Retry ${i + 1}/${retries} after ${response.status}...`);
                await sleep(2000 * (i + 1));
                continue;
            }
            return null;
        } catch (err) {
            if (i === retries - 1) throw err;
            await sleep(1000);
        }
    }
    return null;
}

function padCik(cik) {
    return String(cik).padStart(10, '0');
}

async function main() {
    console.log('='.repeat(60));
    console.log('SECTOR/SIC UPDATE SCRIPT');
    console.log('='.repeat(60));
    console.log();

    // Parse args
    const args = process.argv.slice(2);
    const limitIdx = args.indexOf('--limit');
    const limit = limitIdx >= 0 && args[limitIdx + 1] ? parseInt(args[limitIdx + 1], 10) : null;

    // Check DB exists
    if (!fs.existsSync(DB_PATH)) {
        console.error(`ERROR: Database not found at ${DB_PATH}`);
        console.error('Run update_fundamentals.bat first to create the database.');
        process.exit(1);
    }

    const db = new Database(DB_PATH);

    // Check for company_tickers in DB or download
    console.log('1. Fetching company tickers list from SEC...');
    const tickersData = await fetchWithRetry(COMPANY_TICKERS_URL);
    if (!tickersData || !tickersData.data) {
        console.error('Failed to fetch company tickers');
        process.exit(1);
    }

    const allTickers = tickersData.data.map(row => ({
        cik: row[0],
        name: row[1],
        ticker: row[2],
        exchange: row[3]
    }));

    console.log(`   Found ${allTickers.length} tickers`);

    // Get tickers that exist in our DB but have NULL sector
    const existingTickers = db.prepare(`
        SELECT DISTINCT ticker, cik FROM fundamentals 
        WHERE (sector IS NULL OR sector = '' OR sector = 'Other')
    `).all();

    console.log(`   ${existingTickers.length} tickers need sector updates`);

    // Match with SEC data to get CIKs
    const tickerMap = new Map(allTickers.map(t => [t.ticker?.toUpperCase(), t]));
    const toUpdate = existingTickers
        .filter(t => tickerMap.has(t.ticker?.toUpperCase()))
        .map(t => ({
            ...t,
            cik: t.cik || tickerMap.get(t.ticker.toUpperCase()).cik
        }));

    const finalList = limit ? toUpdate.slice(0, limit) : toUpdate;
    console.log(`   Will update ${finalList.length} tickers${limit ? ` (limited to ${limit})` : ''}`);
    console.log();

    // Prepare update statement - update ALL rows for this ticker
    const updateStmt = db.prepare(`
        UPDATE fundamentals 
        SET sic = ?, sicDescription = ?, sector = ?
        WHERE ticker = ?
    `);


    // Simple sector mapping from SIC
    function sicToSector(sic, sicDesc) {
        const code = parseInt(sic, 10);
        const desc = (sicDesc || '').toLowerCase();

        // Tech/Internet
        if (code >= 7370 && code <= 7379) return 'Tech/Internet'; // Computer programming, data processing
        if (code >= 3570 && code <= 3579) return 'Tech/Internet'; // Computer and office equipment
        if (code >= 3660 && code <= 3669) return 'Tech/Internet'; // Communications equipment
        if (code >= 3670 && code <= 3679) return 'Tech/Internet'; // Electronic components
        if (desc.includes('software') || desc.includes('computer') || desc.includes('electronic')) return 'Tech/Internet';

        // Biotech/Pharma
        if (code >= 2830 && code <= 2836) return 'Biotech/Pharma'; // Drugs
        if (code >= 3841 && code <= 3845) return 'Biotech/Pharma'; // Medical instruments
        if (code >= 8731 && code <= 8734) return 'Biotech/Pharma'; // R&D services (often biotech)
        if (desc.includes('pharm') || desc.includes('biotech') || desc.includes('drug')) return 'Biotech/Pharma';

        // Financials
        if (code >= 6000 && code <= 6799) return 'Financials';
        if (desc.includes('bank') || desc.includes('insurance') || desc.includes('investment')) return 'Financials';

        // Energy/Utilities
        if (code >= 1300 && code <= 1389) return 'Energy/Materials'; // Oil & gas extraction
        if (code >= 4900 && code <= 4999) return 'Energy/Materials'; // Electric, gas, sanitary
        if (desc.includes('oil') || desc.includes('gas') || desc.includes('energy')) return 'Energy/Materials';

        // Real Estate
        if (code >= 6500 && code <= 6553) return 'Real Estate'; // Real estate
        if (desc.includes('reit') || desc.includes('real estate')) return 'Real Estate';

        // Industrial/Cyclical
        if (code >= 3700 && code <= 3799) return 'Industrial/Cyclical'; // Transportation equipment
        if (code >= 3500 && code <= 3599) return 'Industrial/Cyclical'; // Industrial machinery
        if (desc.includes('manufactur') || desc.includes('industrial')) return 'Industrial/Cyclical';

        // Retail
        if (code >= 5200 && code <= 5999) return 'Retail'; // Retail trade
        if (desc.includes('retail') || desc.includes('store')) return 'Retail';

        return 'Other';
    }

    console.log('2. Fetching sector data from SEC submissions...');
    let updated = 0;
    let errors = 0;

    for (let i = 0; i < finalList.length; i++) {
        const { ticker, cik } = finalList[i];
        const paddedCik = padCik(cik);
        const url = `${SUBMISSIONS_BASE_URL}/CIK${paddedCik}.json`;

        process.stdout.write(`   [${i + 1}/${finalList.length}] ${ticker}... `);

        try {
            const submission = await fetchWithRetry(url);
            if (!submission) {
                console.log('not found');
                errors++;
                await sleep(RATE_LIMIT_MS);
                continue;
            }

            const sic = submission.sic || null;
            const sicDesc = submission.sicDescription || null;
            const sector = sic ? sicToSector(sic, sicDesc) : 'Other';

            updateStmt.run(sic, sicDesc, sector, ticker);
            updated++;
            console.log(`SIC ${sic} -> ${sector}`);
        } catch (err) {
            console.log(`error: ${err.message}`);
            errors++;
        }

        await sleep(RATE_LIMIT_MS);
    }

    db.close();

    console.log();
    console.log('='.repeat(60));
    console.log('COMPLETED');
    console.log('='.repeat(60));
    console.log(`   Updated: ${updated}`);
    console.log(`   Errors: ${errors}`);
    console.log();
    console.log('Restart your server to see updated sector classifications.');
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
