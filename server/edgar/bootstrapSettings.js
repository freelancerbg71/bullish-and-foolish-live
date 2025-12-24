import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(ROOT, "data");
const EDGAR_DIR = path.join(DATA_DIR, "edgar");
const SETTINGS_FILE = path.join(EDGAR_DIR, "settings.json");

const DEFAULT_SETTINGS = {
  bootstrapEnabled: false,
  backoffUntil: null,
  bootstrapTestLimit: null
};

export function loadSettings() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) {
      fs.mkdirSync(EDGAR_DIR, { recursive: true });
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(DEFAULT_SETTINGS, null, 2));
      return { ...DEFAULT_SETTINGS };
    }
    const raw = fs.readFileSync(SETTINGS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...(parsed || {}) };
  } catch (err) {
    console.warn("[bootstrapSettings] failed to read settings", err?.message || err);
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(partial = {}) {
  try {
    const merged = { ...loadSettings(), ...partial };
    fs.mkdirSync(EDGAR_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2));
    return merged;
  } catch (err) {
    console.warn("[bootstrapSettings] failed to write settings", err?.message || err);
    return loadSettings();
  }
}
