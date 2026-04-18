import { isBot } from "../lib/botDetection.js";

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

// Known bots → true
assert(isBot("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"), "Googlebot");
assert(isBot("Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)"), "Bingbot");
assert(isBot("AhrefsBot/7.0; +https://ahrefs.com/robot/"), "AhrefsBot");
assert(isBot("SemrushBot/7~bl; +https://www.semrush.com/bot.html"), "SemrushBot");
assert(isBot("Python-requests/2.28.0"), "python-requests");
assert(isBot("Go-http-client/1.1"), "Go-http-client");
assert(isBot("curl/7.88.1"), "curl");
assert(isBot("Wget/1.21"), "wget");
assert(isBot("DotBot/1.2; +https://opensiteexplorer.org/dotbot"), "DotBot");
assert(isBot("GPTBot/1.0; +https://openai.com/gptbot"), "GPTBot");
assert(isBot("ClaudeBot/1.0; +https://www.anthropic.com/claude-bot"), "ClaudeBot");
assert(isBot(""), "empty UA");
assert(isBot(null), "null UA");
assert(isBot(undefined), "undefined UA");
// catch-all: missing Mozilla/ and AppleWebKit
assert(isBot("CustomScraper/1.0"), "custom scraper without browser markers");

// Real browsers → false
assert(!isBot("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"), "Chrome");
assert(!isBot("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"), "Safari");
assert(!isBot("Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/115.0"), "Firefox");

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log(`\n${passed} tests passed`);
