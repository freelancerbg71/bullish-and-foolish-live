const BOT_PATTERNS = [
  "googlebot", "bingbot", "slurp", "duckduckbot", "baiduspider",
  "yandexbot", "ahrefsbot", "semrushbot", "dotbot", "mj12bot",
  "rogerbot", "facebookexternalhit", "linkedinbot", "twitterbot",
  "ia_archiver", "python-requests", "go-http-client", "curl/",
  "wget/", "scrapy", "httpclient", "apache-httpclient", "okhttp",
  "petalbot", "claudebot", "gptbot", "chatgpt-user", "ccbot",
  "bytespider", "dataforseo", "semji", "sistrix", "magestic",
];

export function isBot(ua) {
  if (!ua) return true;
  const lower = ua.toLowerCase();
  if (BOT_PATTERNS.some((p) => lower.includes(p))) return true;
  // catch-all: real browsers always include Mozilla/ or AppleWebKit
  if (!lower.includes("mozilla/") && !lower.includes("applewebkit")) return true;
  return false;
}
