# Railway Memory Reduction — Design

**Date:** 2026-04-24
**Status:** Draft, pending implementation
**Owner:** trent

## Problem

Railway billing for Bullish & Foolish is dominated by memory. April MTD breakdown:

| Line | Usage | Cost | % of bill |
|------|-------|------|-----------|
| Memory | 10,755 minutely GB | $2.49 | ~96% |
| Volume | 15,365 minutely GB | $0.053 | ~2% |
| Egress | 0.58 GB total | $0.029 | ~1% |
| CPU | 16.29 minutely vCPU | $0.0075 | <1% |

The RAM graph climbs from near-0 at cycle start to ~1 GB by end-of-period. CPU is near-idle (~0.0–0.1 vCPU), confirming low traffic. The site is paying to hold ~1 GB of RAM 24/7. Railway charges ~$0.000231/GB/minute, so every 1 GB held for a month is ~$10.

Persistent volume cost is negligible — it is not the target of this work.

## Goal

Cut the memory line by ~60–70% by capping Node heap, bounding in-memory caches, and reducing sqlite RSS. Target: idle RAM plateau of 250–400 MB instead of ~1 GB.

Expected savings: ~$1.25–1.75/month off the memory line, bringing the estimated total from ~$5.76/mo toward ~$3–4/mo.

## Root cause

Three sources of RAM growth:

1. **Unbounded in-memory caches that never evict.**
   - `server/edgar/filingTextScanner.js:24-25` — `goingConcernCache` and `filingSignalCache` are plain `Map()` with no size cap. Filing scan results (multi-signal objects per filing) accumulate forever as new tickers are scanned.
   - `server/edgar/edgarQueue.js:9-11` — `jobState`, `notFoundUntil`, `notFoundLogOnce`. Only `notFoundUntil` self-expires.
   - `server/edgar/edgarFundamentals.js:30` — `notFoundLogCache`. Same pattern.

2. **Sqlite default memory behavior.** Four `better-sqlite3` connections are opened (fundamentals, screener, prices, ratings). `journal_mode = WAL` is set, but `cache_size` and `mmap_size` are left at defaults. On Linux, sqlite can mmap the entire DB file, which inflates RSS. Railway bills on RSS, not working set.

3. **No Node heap cap.** Default max-old-space-size on a 2 GB container is ~1.5 GB. Any slow leak or cache growth can drift toward that ceiling before the OS notices.

The disk-backed VM cache (`DATA_DIR/cache/vm/`, 1h TTL) is already filesystem-based and is **not** contributing to the RAM growth.

## Design

Five edits, ordered by impact per unit of risk.

### 1. Node heap cap (Railway env var)

Set `NODE_OPTIONS=--max-old-space-size=384 --expose-gc` on the Railway service.

- `--max-old-space-size=384` caps the V8 old-space at 384 MB. If a real leak exists, the process OOM-restarts rather than silently consuming headroom. Failure is visible, not billed.
- `--expose-gc` enables `global.gc()` for the scheduled sweep in change #5.

Rollback: remove the env var.

### 2. LRU-bound the filing caches

**File:** `server/edgar/filingTextScanner.js`

Replace both `new Map()` declarations at lines 24-25 with a bounded LRU. Insertion-order `Map` + manual eviction at 100 entries is sufficient — no new dependency. Rough shape:

```js
const FILING_CACHE_MAX = 100;
function lruSet(map, key, value) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  if (map.size > FILING_CACHE_MAX) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
}
```

Replace the existing `.set(...)` call sites (there are several — lines 525, 541, 545, 1173, 1309, 1322, 1426) with `lruSet(map, key, value)`.

The disk cache at `cache_dir/` is the canonical store; the in-memory map is a hot-path accelerator. Evictions cost one JSON file read on the next hit — negligible at current traffic.

### 3. TTL sweep on queue state

**Files:** `server/edgar/edgarQueue.js`, `server/edgar/edgarFundamentals.js`

Add a module-level `setInterval` (with `.unref()` so it does not block shutdown) that runs every 15 minutes and drops:
- `jobState` entries where `completedAt` or `startedAt` is older than 1 hour.
- `notFoundLogOnce` entries older than 24 hours.
- `notFoundLogCache` entries older than 24 hours.

`notFoundUntil` already self-expires on read — leave it.

### 4. Sqlite RSS diet

**Files:** all four stores — `fundamentalsStore.js`, `screenerStore.js`, `priceStore.js`, `ratingsHistoryStore.js`

Immediately after the existing `db.pragma("journal_mode = WAL")` call in each, add:

```js
db.pragma("cache_size = -2000");   // 2 MB page cache (explicit, per connection)
db.pragma("mmap_size = 0");         // disable mmap → smaller RSS
```

Disabling mmap trades a small read-path perf hit for a materially smaller RSS number. At this site's query volume, the perf hit is unmeasurable.

### 5. Scheduled GC

**File:** `server.js` (boot path, near top of file after imports)

```js
if (typeof global.gc === "function") {
  setInterval(() => global.gc(), 30 * 60 * 1000).unref();
}
```

Guarded by `typeof global.gc === "function"` so it is a no-op in dev/test where `--expose-gc` is not set. Pairs with change #1 to aggressively compact heap on the idle server.

## Verification

After deploy:
- Watch Railway memory graph for 48 hours. RSS should plateau between 250–400 MB instead of trending upward.
- If RSS still climbs past 384 MB, Node will OOM-restart. Railway shows the restart; that is the signal to escalate (hunt a real leak, or switch to route 2 — sleep/serverless mode).
- Within one billing week, the memory line on the usage graph should be ~50–70% lower than the baseline captured in `bullish.png`.

No new tests required. The existing engine and price tests cover scoring correctness; these changes do not touch scoring logic, only cache bookkeeping and sqlite tuning.

## Risk and rollback

- **Env var revert:** 10 seconds in Railway dashboard.
- **Code changes:** each edit is contained to a single file. Git revert is trivial.
- **User-visible change:** a filing-cache miss reads from disk instead of memory (~5 ms). Undetectable at current traffic.
- **Worst case:** Node OOMs at 384 MB. Railway auto-restarts. First request after restart is a cold cache, ~1–2 s slower. This is rare (only if a leak actually exists) and is strictly better than silent bill growth.

## Out of scope

- Route 2 (Railway sleep/serverless mode).
- Route 3 (migrating to a different host).
- Any changes to scoring logic, data ingestion, or the screener pipeline.
- Replacing `better-sqlite3` with another DB.
- Adding a new dependency (LRU library). The hand-rolled LRU is intentional.
