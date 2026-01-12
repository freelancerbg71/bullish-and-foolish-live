import fs from "fs";
import path from "path";

if (!process.env.DATA_USER_AGENT) {
  process.env.DATA_USER_AGENT = "BullishAndFoolish/1.0 (freelancer.bg@gmail.com)";
}

// On Railway: Sync git-tracked fundamentals.db to the persistent volume
// This ensures fresh deploys update the screener_index data
if (process.env.RAILWAY_VOLUME_MOUNT_PATH) {
  const gitDbPath = path.resolve("./data/edgar/fundamentals.db");
  const volumeDbPath = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, "edgar", "fundamentals.db");
  const volumeWalPath = `${volumeDbPath}-wal`;
  const volumeShmPath = `${volumeDbPath}-shm`;

  try {
    if (fs.existsSync(gitDbPath)) {
      // Ensure directory exists
      fs.mkdirSync(path.dirname(volumeDbPath), { recursive: true });

      // Copy if git version is newer or volume doesn't exist
      const gitStats = fs.statSync(gitDbPath);
      const volumeExists = fs.existsSync(volumeDbPath);
      const volumeStats = volumeExists ? fs.statSync(volumeDbPath) : null;

      // Sync if: volume doesn't exist, or git file is newer, or git file is larger (more data)
      if (!volumeExists || gitStats.size > (volumeStats?.size || 0)) {
        fs.copyFileSync(gitDbPath, volumeDbPath);
        console.log("[startup] Synced fundamentals.db to Railway volume", {
          gitSize: gitStats.size,
          volumeSize: volumeStats?.size || 0
        });
      } else {
        console.log("[startup] Railway volume DB is up to date");
      }
    }
  } catch (err) {
    console.warn("[startup] Failed to sync DB to volume:", err.message);
  }

  // Integrity guard: if the volume DB is corrupt, restore from the git-tracked copy.
  try {
    if (fs.existsSync(volumeDbPath) && fs.existsSync(gitDbPath)) {
      let isHealthy = false;
      try {
        const { default: Database } = await import("better-sqlite3");
        const db = new Database(volumeDbPath, { readonly: true });
        const check = db.prepare("PRAGMA quick_check").all();
        db.close();
        isHealthy = Array.isArray(check) && check.length === 1 && String(check[0]?.quick_check).toLowerCase() === "ok";
      } catch (err) {
        console.warn("[startup] DB integrity check failed", err?.message || err);
        isHealthy = false;
      }

      if (!isHealthy) {
        fs.copyFileSync(gitDbPath, volumeDbPath);
        fs.rmSync(volumeWalPath, { force: true });
        fs.rmSync(volumeShmPath, { force: true });
        console.warn("[startup] Restored volume DB from git copy after integrity failure");
      }
    }
  } catch (err) {
    console.warn("[startup] Failed integrity guard:", err.message);
  }
}

await import("../server.js");
