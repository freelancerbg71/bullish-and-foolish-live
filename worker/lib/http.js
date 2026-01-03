import { envString } from "./args.js";

const DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function resolveUserAgent() {
  return (
    envString("DATA_USER_AGENT") ||
    envString("EDGAR_USER_AGENT") ||
    envString("USER_AGENT") ||
    DEFAULT_UA
  );
}

export async function fetchText(url, { timeoutMs = 45_000 } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), Math.max(1_000, Number(timeoutMs) || 45_000));
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": resolveUserAgent(),
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.nasdaq.com/"
      },
      signal: controller.signal
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const err = new Error(`Fetch failed ${res.status} ${res.statusText}${body ? `: ${body.slice(0, 200)}` : ""}`);
      err.status = res.status;
      throw err;
    }
    return res.text();
  } finally {
    clearTimeout(t);
  }
}
