import fs from 'fs';
const path = "g:\\Stocks\\data\\edgar\\IOVA-fundamentals.json";
try {
    const data = fs.readFileSync(path, 'utf8');
    const json = JSON.parse(data);
    const bad = (json.filingSignals || []).find(s => s.id === 'clinical_negative');
    if (bad) {
        console.log("FOUND clinical_negative!");
        console.log("Snippet:", bad.snippet);
    } else {
        console.log("clinical_negative NOT FOUND in current cache.");
    }
} catch (err) {
    console.error(err);
}
