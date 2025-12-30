
import fs from 'fs';

const readJson = (p) => {
    try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
        return null;
    }
};

const analyze = (ticker) => {
    const data = readJson(`./data/edgar/${ticker}-fundamentals.json`);
    if (!data) return;
    console.log(`=== ${ticker} Signals ===`);
    console.log(JSON.stringify(data.filingSignals, null, 2));
};

analyze('DFLI');
