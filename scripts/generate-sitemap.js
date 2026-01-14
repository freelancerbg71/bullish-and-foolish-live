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
const BASE_URL = 'https://bullishandfoolish.com';
const SITEMAP_CHUNK_SIZE = 2000;

/**
 * Detect non-SEC-filing tickers by suffix pattern
 * These are warrants, units, rights, preferred shares that don't file 10-K/10-Q
 */
function isNonFilingTicker(ticker) {
    const upperTicker = ticker.toUpperCase();

    // Warrants: -WT, -WS, +, ends with W after 4+ chars
    if (/-WT$|-WS$/.test(upperTicker)) return true;
    if (/\+$/.test(upperTicker)) return true;
    if (upperTicker.length >= 5 && /W$/.test(upperTicker) && !/^[A-Z]{1,4}W$/.test(upperTicker)) return true;

    // Units: -UN, -U, ends with U after base ticker
    if (/-UN$|-U$/.test(upperTicker)) return true;
    if (upperTicker.length >= 5 && /U$/.test(upperTicker) && !/^[A-Z]{1,4}U$/.test(upperTicker)) return true;

    // Rights: -R, -RT, ends with R after 4+ chars  
    if (/-R$|-RT$/.test(upperTicker)) return true;
    if (upperTicker.length >= 5 && /R$/.test(upperTicker) && !/^[A-Z]{1,4}R$/.test(upperTicker)) return true;

    // Preferred shares: -PA, -PB, -PC, -PD, -PE, -PF, -PG, -PH, -PI, -PJ, -PK, -PL, -PM, -PN, -PO, -PP
    if (/-P[A-Z]$/.test(upperTicker)) return true;

    // Notes/Debentures: -N
    if (/-N$/.test(upperTicker)) return true;

    return false;
}

async function loadTickers() {
    // Try to load from screener database - ONLY tickers with valid scores (actual SEC filers)
    try {
        const { getScreenerDb, closeDb } = await import('../server/screener/screenerStore.js');
        const db = await getScreenerDb();
        try {
            // Only include tickers that have a score (meaning they have SEC filing data)
            const rows = db.prepare(`
                SELECT ticker FROM screener_index 
                WHERE score IS NOT NULL 
                ORDER BY ticker
            `).all();

            // Additional filter: exclude warrants, units, rights, preferred shares by suffix
            const filtered = rows
                .map(r => r.ticker)
                .filter(ticker => !isNonFilingTicker(ticker));

            console.log(`[sitemap] Filtered out ${rows.length - filtered.length} non-filing tickers (warrants, units, etc.)`);
            return filtered;
        } finally {
            await closeDb();
        }
    } catch (err) {
        console.warn('[sitemap] Could not load from DB, trying prices.json...', err.message);
    }

    // Fallback to prices.json (less accurate, includes non-filers)
    try {
        const pricesPath = path.join(DATA_DIR, 'prices.json');
        const data = JSON.parse(fs.readFileSync(pricesPath, 'utf8'));
        const allTickers = Object.keys(data).sort();
        const filtered = allTickers.filter(ticker => !isNonFilingTicker(ticker));
        console.log(`[sitemap] Filtered out ${allTickers.length - filtered.length} non-filing tickers from prices.json`);
        return filtered;
    } catch (err) {
        console.error('[sitemap] Could not load tickers:', err.message);
        return [];
    }
}

async function loadArticles() {
    try {
        const articlesPath = path.join(DATA_DIR, 'articles.json');
        const data = JSON.parse(fs.readFileSync(articlesPath, 'utf8'));
        const articles = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
        if (!Array.isArray(data)) {
            console.warn('[sitemap] articles.json is not an array; using items[] if present');
        }
        console.log(`[sitemap] Loaded ${articles.length} articles from articles.json`);
        return articles;
    } catch (err) {
        console.warn('[sitemap] Could not load articles.json:', err.message);
        return [];
    }
}

function parseArticleDate(dateStr) {
    // Convert "Jan 4, 2026" or "Dec 28, 2025" to "2026-01-04" format
    try {
        const parsed = new Date(dateStr);
        if (!isNaN(parsed.getTime())) {
            return parsed.toISOString().split('T')[0];
        }
    } catch (_) { }
    // Fallback to today
    return new Date().toISOString().split('T')[0];
}

function formatDate(date) {
    return date.toISOString().split('T')[0];
}

function getFileLastmod(filePath) {
    try {
        const stats = fs.statSync(filePath);
        return formatDate(stats.mtime);
    } catch (_) {
        return formatDate(new Date());
    }
}

function chunkArray(items, chunkSize) {
    const chunks = [];
    for (let i = 0; i < items.length; i += chunkSize) {
        chunks.push(items.slice(i, i + chunkSize));
    }
    return chunks;
}

function buildUrlEntries(tickers, articles = []) {
    const today = formatDate(new Date());
    const entries = [];

    const staticPages = [
        { path: '/', changefreq: 'daily', priority: '1.0', file: path.join(PROJECT_ROOT, 'index.html') },
        { path: '/screener.html', changefreq: 'daily', priority: '0.9', file: path.join(PROJECT_ROOT, 'screener.html') },
        { path: '/articles.html', changefreq: 'weekly', priority: '0.8', file: path.join(PROJECT_ROOT, 'articles.html') },
        { path: '/about.html', changefreq: 'monthly', priority: '0.7', file: path.join(PROJECT_ROOT, 'about.html') },
        { path: '/rules.html', changefreq: 'monthly', priority: '0.6', file: path.join(PROJECT_ROOT, 'rules.html') }
    ];

    for (const page of staticPages) {
        entries.push({
            loc: `${BASE_URL}${page.path}`,
            lastmod: getFileLastmod(page.file),
            changefreq: page.changefreq,
            priority: page.priority
        });
    }

    for (const article of articles) {
        const articlePath = article.path || `/articles/${article.id}.html`;
        const fullUrl = `${BASE_URL}${articlePath}`;
        const lastmod = parseArticleDate(article.updatedAt || article.date);

        entries.push({
            loc: fullUrl,
            lastmod,
            changefreq: 'monthly',
            priority: '0.8'
        });
    }

    for (const ticker of tickers) {
        // Skip tickers with special characters that might cause URL issues
        if (!/^[A-Z0-9.-]+$/i.test(ticker)) continue;

        entries.push({
            loc: `${BASE_URL}/ticker/${encodeURIComponent(ticker)}`,
            lastmod: today,
            changefreq: 'weekly',
            priority: '0.5'
        });
    }

    return entries;
}

function buildSitemapXml(entries) {
    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
`;

    for (const entry of entries) {
        xml += `    <url>
        <loc>${entry.loc}</loc>
        <lastmod>${entry.lastmod}</lastmod>
        <changefreq>${entry.changefreq}</changefreq>
        <priority>${entry.priority}</priority>
    </url>
`;
    }

    xml += `</urlset>
`;
    return xml;
}

function buildSitemapIndexXml(sitemapFiles) {
    const today = formatDate(new Date());
    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
`;

    for (const file of sitemapFiles) {
        xml += `    <sitemap>
        <loc>${BASE_URL}/${file}</loc>
        <lastmod>${today}</lastmod>
    </sitemap>
`;
    }

    xml += `</sitemapindex>
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

    console.log('[sitemap] Loading articles...');
    const articles = await loadArticles();

    console.log('[sitemap] Building URL entries...');
    const entries = buildUrlEntries(tickers, articles);
    const chunks = chunkArray(entries, SITEMAP_CHUNK_SIZE);

    console.log(`[sitemap] Writing ${chunks.length} sitemap chunks...`);
    const sitemapFiles = [];
    chunks.forEach((chunk, index) => {
        const fileName = `sitemap-${index + 1}.xml`;
        const filePath = path.join(PROJECT_ROOT, fileName);
        fs.writeFileSync(filePath, buildSitemapXml(chunk), 'utf8');
        sitemapFiles.push(fileName);
    });

    const indexPath = path.join(PROJECT_ROOT, 'sitemap.xml');
    fs.writeFileSync(indexPath, buildSitemapIndexXml(sitemapFiles), 'utf8');

    const staticPages = 5; // home, screener, articles, about, rules
    const totalUrls = staticPages + articles.length + tickers.length;
    console.log(`[sitemap] Written sitemap index to ${indexPath}`);
    console.log(`[sitemap] Total URLs: ${totalUrls} (${staticPages} static + ${articles.length} articles + ${tickers.length} tickers)`);
}

main().catch(err => {
    console.error('[sitemap] Error:', err);
    process.exit(1);
});
