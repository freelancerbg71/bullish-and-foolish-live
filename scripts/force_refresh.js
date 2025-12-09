
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const EDGAR_DIR = path.join(ROOT, "data", "edgar");
const DB_FILE = path.join(EDGAR_DIR, "fundamentals.db");

const TARGETS = ["NVDA", "META", "TNXP"];

async function run() {
    console.log("Forcing refresh for:", TARGETS.join(", "));

    // 1. Delete from DB
    if (fs.existsSync(DB_FILE)) {
        try {
            const db = new Database(DB_FILE);
            const delStmt = db.prepare("DELETE FROM fundamentals WHERE ticker = ?");

            for (const t of TARGETS) {
                const info = delStmt.run(t);
                console.log(`[DB] Deleted ${info.changes} rows for ${t}`);
            }
            db.close();
        } catch (err) {
            console.error("Failed to access DB:", err.message);
        }
    } else {
        console.log("DB file not found, skipping DB delete.");
    }

    // 2. Delete JSON snapshots
    for (const t of TARGETS) {
        const jsonPath = path.join(EDGAR_DIR, `${t}-fundamentals.json`);
        if (fs.existsSync(jsonPath)) {
            try {
                fs.unlinkSync(jsonPath);
                console.log(`[File] Deleted ${jsonPath}`);
            } catch (err) {
                console.error(`Failed to delete ${jsonPath}:`, err.message);
            }
        } else {
            console.log(`[File] No JSON found for ${t} at ${jsonPath}`);
        }
    }

    console.log("\nDone. Please restart the server and reload the ticker pages to trigger a fresh fetch.");
}

run();
