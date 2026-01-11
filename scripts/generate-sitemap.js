/**
 * Generate a full sitemap with all ticker pages
 * Run with: node scripts/generate-sitemap.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(PROJECT_ROOT, 'data');

async function loadTickers() {
    // Try to load from screener database
    try {
        const { getScreenerDb } = await import('../server/screener/screenerStore.js');
        const db = await getScreenerDb();
        const rows = db.prepare('SELECT ticker FROM screener_index ORDER BY ticker').all();
        return rows.map(r => r.ticker);
    } catch (err) {
        console.warn('[sitemap] Could not load from DB, trying prices.json...');
    }

    // Fallback to prices.json
    try {
        const pricesPath = path.join(DATA_DIR, 'prices.json');
        const data = JSON.parse(fs.readFileSync(pricesPath, 'utf8'));
        return Object.keys(data).sort();
    } catch (err) {
        console.error('[sitemap] Could not load tickers:', err.message);
        return [];
    }
}

function generateSitemap(tickers) {
    const today = new Date().toISOString().split('T')[0];

    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <!-- Main Pages -->
    <url>
        <loc>https://bullishandfoolish.com/</loc>
        <changefreq>daily</changefreq>
        <priority>1.0</priority>
    </url>
    <url>
        <loc>https://bullishandfoolish.com/screener.html</loc>
        <changefreq>daily</changefreq>
        <priority>0.9</priority>
    </url>
    <url>
        <loc>https://bullishandfoolish.com/articles.html</loc>
        <changefreq>weekly</changefreq>
        <priority>0.8</priority>
    </url>
    <url>
        <loc>https://bullishandfoolish.com/about.html</loc>
        <changefreq>monthly</changefreq>
        <priority>0.7</priority>
    </url>
    <url>
        <loc>https://bullishandfoolish.com/rules.html</loc>
        <changefreq>monthly</changefreq>
        <priority>0.6</priority>
    </url>

    <!-- Articles -->
    <url>
        <loc>https://bullishandfoolish.com/articles/palantir-sci-fi-reality.html</loc>
        <lastmod>2026-01-11</lastmod>
        <changefreq>monthly</changefreq>
        <priority>0.8</priority>
    </url>
    <url>
        <loc>https://bullishandfoolish.com/articles/archer-aviation-flying-cars.html</loc>
        <lastmod>2026-01-11</lastmod>
        <changefreq>monthly</changefreq>
        <priority>0.8</priority>
    </url>
    <url>
        <loc>https://bullishandfoolish.com/articles/tesla-overvalued-reality-check.html</loc>
        <lastmod>2026-01-04</lastmod>
        <changefreq>monthly</changefreq>
        <priority>0.8</priority>
    </url>
    <url>
        <loc>https://bullishandfoolish.com/articles/meta-fundamental-reality-check.html</loc>
        <lastmod>2026-01-04</lastmod>
        <changefreq>monthly</changefreq>
        <priority>0.8</priority>
    </url>
    <url>
        <loc>https://bullishandfoolish.com/articles/going-concern.html</loc>
        <lastmod>2026-01-04</lastmod>
        <changefreq>monthly</changefreq>
        <priority>0.8</priority>
    </url>
    <url>
        <loc>https://bullishandfoolish.com/articles/investment-methodology.html</loc>
        <lastmod>2026-01-04</lastmod>
        <changefreq>monthly</changefreq>
        <priority>0.8</priority>
    </url>

    <!-- All Ticker Pages (${tickers.length} tickers) -->
`;

    // Add all ticker pages
    for (const ticker of tickers) {
        // Skip tickers with special characters that might cause URL issues
        if (!/^[A-Z0-9.-]+$/i.test(ticker)) continue;

        xml += `    <url>
        <loc>https://bullishandfoolish.com/ticker/${encodeURIComponent(ticker)}</loc>
        <lastmod>${today}</lastmod>
        <changefreq>weekly</changefreq>
        <priority>0.5</priority>
    </url>
`;
    }

    xml += `</urlset>
`;

    return xml;
}

async function main() {
    console.log('[sitemap] Loading tickers...');
    const tickers = await loadTickers();
    console.log(`[sitemap] Found ${tickers.length} tickers`);

    if (tickers.length === 0) {
        console.error('[sitemap] No tickers found, aborting');
        process.exit(1);
    }

    console.log('[sitemap] Generating sitemap...');
    const xml = generateSitemap(tickers);

    const outputPath = path.join(PROJECT_ROOT, 'sitemap.xml');
    fs.writeFileSync(outputPath, xml, 'utf8');

    console.log(`[sitemap] Written to ${outputPath}`);
    console.log(`[sitemap] Total URLs: ${tickers.length + 9} (9 static + ${tickers.length} tickers)`);
}

main().catch(err => {
    console.error('[sitemap] Error:', err);
    process.exit(1);
});
