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
}

await import("../server.js");
