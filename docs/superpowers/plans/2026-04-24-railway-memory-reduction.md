# Railway Memory Reduction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the Railway memory line item ~50–70% by capping Node heap, LRU-bounding in-memory filing caches, sweeping stale queue state, and disabling sqlite mmap.

**Architecture:** Pure infra tuning. No new files, no new dependencies. Changes are confined to six existing files plus one Railway env var. The disk-backed VM cache is unaffected; scoring, ingestion, and screener pipelines are untouched.

**Tech Stack:** Node.js ES modules, `better-sqlite3`. No test framework — existing tests are plain `node` scripts that throw on failure.

**Spec:** `docs/superpowers/specs/2026-04-24-railway-memory-reduction-design.md`

---

## File Structure

Modified files only — no new files.

| File | What changes |
|---|---|
| `server/edgar/filingTextScanner.js` | Add module-local LRU helper; route the two caches through it |
| `server/edgar/edgarQueue.js` | Add interval that sweeps stale `jobState` / `notFoundLogOnce` |
| `server/edgar/edgarFundamentals.js` | Add interval that sweeps stale `notFoundLogCache` |
| `server/edgar/fundamentalsStore.js` | Add `cache_size` and `mmap_size` pragmas |
| `server/screener/screenerStore.js` | Same pragmas |
| `server/prices/priceStore.js` | Same pragmas |
| `server/ratings/ratingsHistoryStore.js` | Same pragmas |
| `server.js` | Add guarded scheduled GC near boot |

---

## Task 1: LRU-bound the filing caches

**Files:**
- Modify: `server/edgar/filingTextScanner.js` (lines 24-25 and all `.set()` call sites on these two maps)

Both `goingConcernCache` and `filingSignalCache` are plain `Map()`s. They grow forever. Disk cache at `cache_dir/` is the fallback, so in-memory eviction costs at most one JSON read on the next hit. Cap at 100 entries each.

- [ ] **Step 1.1: Add LRU helper and constant near the top of the file**

After line 25 (`const filingSignalCache = new Map();`), add:

```js
const FILING_CACHE_MAX_ENTRIES = Number(process.env.FILING_CACHE_MAX_ENTRIES) || 100;

function lruCacheSet(map, key, value) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > FILING_CACHE_MAX_ENTRIES) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
}
```

Rationale: inserting after delete re-homes the key at the end of insertion order, so `map.keys().next().value` is always the least-recently-set entry. No new dependency.

- [ ] **Step 1.2: Route `goingConcernCache.set` calls through the helper**

In `scanFilingForGoingConcern` (around lines 525, 541, 545), replace the three occurrences of:

```js
goingConcernCache.set(key, { fetchedAt: now, result });
```

with:

```js
lruCacheSet(goingConcernCache, key, { fetchedAt: now, result });
```

- [ ] **Step 1.3: Route `filingSignalCache.set` calls through the helper**

In `scanFilingForSignals` (around lines 1173, 1309, 1322, 1426), replace the four occurrences of:

```js
filingSignalCache.set(key, { fetchedAt: now, result });
```

and (line 1173 variant):

```js
filingSignalCache.set(key, { fetchedAt: now, result: diskCached });
```

with their `lruCacheSet` equivalents. Example for line 1173:

```js
lruCacheSet(filingSignalCache, key, { fetchedAt: now, result: diskCached });
```

- [ ] **Step 1.4: Verify the file parses**

Run: `node -e "import('./server/edgar/filingTextScanner.js').then(() => console.log('ok'))"`
Expected: prints `ok` with no errors.

- [ ] **Step 1.5: Run existing tests**

Run: `npm test`
Expected: all engine, price, and bot tests pass. (The filing caches have no direct tests; this just confirms no accidental regression.)

- [ ] **Step 1.6: Commit**

```bash
git add server/edgar/filingTextScanner.js
git commit -m "perf(edgar): LRU-bound goingConcernCache and filingSignalCache

Both Maps grew unboundedly. Cap at 100 entries each; disk cache at
cache_dir/ remains the canonical store, so evictions cost one JSON
read on the next hit. Part of Railway memory reduction."
```

---

## Task 2: Sweep stale state from edgarQueue

**Files:**
- Modify: `server/edgar/edgarQueue.js`

`jobState` holds every ticker ever processed. `notFoundLogOnce` holds a log-throttle timestamp per missing ticker. Neither ever evicts. Add a 15-minute sweep.

- [ ] **Step 2.1: Add sweep constants and helper after the `MAX_QUEUE_LENGTH` constant (line 5)**

After line 6 (`const TICKER_NOT_FOUND_COOLDOWN_MS = ...`), add:

```js
const QUEUE_STATE_SWEEP_INTERVAL_MS = 15 * 60 * 1000; // 15 min
const JOB_STATE_RETENTION_MS = 60 * 60 * 1000; // 1 hour after finishedAt
const NOT_FOUND_LOG_RETENTION_MS = TICKER_NOT_FOUND_COOLDOWN_MS; // 24 hours

function sweepQueueState() {
  const now = Date.now();
  for (const [key, job] of jobState.entries()) {
    const active = job?.status === "queued" || job?.status === "running";
    if (active) continue;
    const finishedIso = job?.finishedAt || job?.startedAt || job?.enqueuedAt;
    const finishedAt = finishedIso ? Date.parse(finishedIso) : NaN;
    if (!Number.isFinite(finishedAt)) continue;
    if (now - finishedAt > JOB_STATE_RETENTION_MS) jobState.delete(key);
  }
  for (const [key, ts] of notFoundLogOnce.entries()) {
    if (!Number.isFinite(ts) || now - ts > NOT_FOUND_LOG_RETENTION_MS) {
      notFoundLogOnce.delete(key);
    }
  }
}

setInterval(sweepQueueState, QUEUE_STATE_SWEEP_INTERVAL_MS).unref();
```

`.unref()` so the interval does not keep the event loop alive during graceful shutdown.

- [ ] **Step 2.2: Verify the file parses and the interval does not block exit**

Run: `node -e "import('./server/edgar/edgarQueue.js').then(() => console.log('ok'))"`
Expected: prints `ok` and the process exits immediately (not hung).

- [ ] **Step 2.3: Run existing tests**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 2.4: Commit**

```bash
git add server/edgar/edgarQueue.js
git commit -m "perf(edgar): sweep stale jobState and notFoundLogOnce every 15m

Both Maps accumulated entries for the process lifetime. Drop finished
jobs older than 1h and not-found log timestamps older than the 24h
cooldown window."
```

---

## Task 3: Sweep stale entries from notFoundLogCache

**Files:**
- Modify: `server/edgar/edgarFundamentals.js` (around lines 29-30)

Same pattern — `notFoundLogCache` is log-throttle state with a 10-minute TTL. Add a matching sweep.

- [ ] **Step 3.1: Add sweep after the existing `notFoundLogCache` declaration (line 30)**

Replace the block at lines 28-30:

```js
// Throttle noisy "not found" logs so missing tickers don't spam the console
const NOT_FOUND_LOG_TTL_MS = 10 * 60 * 1000;
const notFoundLogCache = new Map();
```

with:

```js
// Throttle noisy "not found" logs so missing tickers don't spam the console
const NOT_FOUND_LOG_TTL_MS = 10 * 60 * 1000;
const notFoundLogCache = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of notFoundLogCache.entries()) {
    if (!Number.isFinite(ts) || now - ts > NOT_FOUND_LOG_TTL_MS) {
      notFoundLogCache.delete(key);
    }
  }
}, NOT_FOUND_LOG_TTL_MS).unref();
```

- [ ] **Step 3.2: Verify the file parses**

Run: `node -e "import('./server/edgar/edgarFundamentals.js').then(() => console.log('ok'))"`
Expected: prints `ok` and the process exits immediately.

- [ ] **Step 3.3: Commit**

```bash
git add server/edgar/edgarFundamentals.js
git commit -m "perf(edgar): sweep stale notFoundLogCache entries

Log-throttle Map was unbounded. Sweep every 10 minutes, dropping
entries past TTL."
```

---

## Task 4: Sqlite RSS diet — all four stores

**Files:**
- Modify: `server/edgar/fundamentalsStore.js` (line 260)
- Modify: `server/screener/screenerStore.js` (line 35)
- Modify: `server/prices/priceStore.js` (line 40)
- Modify: `server/ratings/ratingsHistoryStore.js` (line 34)

Each store has exactly one `db.pragma("journal_mode = WAL")` call. Add two more pragmas immediately after it. Disabling `mmap_size` is the real RSS saver — Railway bills on RSS, and mmap inflates RSS without a measurable perf win at this query volume.

- [ ] **Step 4.1: Edit `fundamentalsStore.js`**

Change line 260 from:

```js
db.pragma("journal_mode = WAL");
```

to:

```js
db.pragma("journal_mode = WAL");
db.pragma("cache_size = -2000"); // 2 MB page cache
db.pragma("mmap_size = 0"); // no mmap → smaller RSS
```

- [ ] **Step 4.2: Edit `screenerStore.js`**

Change line 35 from:

```js
db.pragma("journal_mode = WAL");
```

to:

```js
db.pragma("journal_mode = WAL");
db.pragma("cache_size = -2000"); // 2 MB page cache
db.pragma("mmap_size = 0"); // no mmap → smaller RSS
```

- [ ] **Step 4.3: Edit `priceStore.js`**

Change line 40 from:

```js
db.pragma("journal_mode = WAL");
```

to:

```js
db.pragma("journal_mode = WAL");
db.pragma("cache_size = -2000"); // 2 MB page cache
db.pragma("mmap_size = 0"); // no mmap → smaller RSS
```

- [ ] **Step 4.4: Edit `ratingsHistoryStore.js`**

Change line 34 from:

```js
db.pragma("journal_mode = WAL");
```

to:

```js
db.pragma("journal_mode = WAL");
db.pragma("cache_size = -2000"); // 2 MB page cache
db.pragma("mmap_size = 0"); // no mmap → smaller RSS
```

- [ ] **Step 4.5: Run tests (price tests actually open the DB)**

Run: `npm run test:prices`
Expected: all price store tests pass.

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 4.6: Commit**

```bash
git add server/edgar/fundamentalsStore.js server/screener/screenerStore.js server/prices/priceStore.js server/ratings/ratingsHistoryStore.js
git commit -m "perf(sqlite): disable mmap and set explicit 2MB cache on all DBs

Railway bills on RSS. Sqlite mmap inflates RSS with no measurable
perf benefit at our query volume. Disable mmap and set an explicit
2 MB page cache per connection across all four better-sqlite3 stores."
```

---

## Task 5: Scheduled GC in server.js

**Files:**
- Modify: `server.js` (insert near top of boot path, after existing top-level constants)

Pair this with the `--expose-gc` flag set on Railway in Task 6. Guarded, so it is a silent no-op in dev/test.

- [ ] **Step 5.1: Locate a stable insertion point**

Open `server.js` and find the line after the `DATA_DIR` / `EDGAR_SNAPSHOT_DIR` constants (around line 46, after `const JSON_SNAPSHOT_TTL_MS = ...`). Insert this block:

```js
// Periodic GC when --expose-gc is set (Railway boot flag). No-op in dev.
if (typeof global.gc === "function") {
  setInterval(() => {
    try { global.gc(); } catch { /* ignore */ }
  }, 30 * 60 * 1000).unref();
}
```

- [ ] **Step 5.2: Verify the file parses and the guard works**

Run without `--expose-gc` (guard should skip):

```bash
node -e "import('./server.js').catch(() => {}); setTimeout(() => process.exit(0), 200);"
```

Expected: process exits cleanly with no errors.

Run with `--expose-gc` (guard should enable the interval, then unref lets it exit):

```bash
node --expose-gc -e "import('./server.js').catch(() => {}); setTimeout(() => process.exit(0), 200);"
```

Expected: process exits cleanly with no errors.

- [ ] **Step 5.3: Commit**

```bash
git add server.js
git commit -m "perf(server): schedule GC every 30m when --expose-gc is set

Paired with NODE_OPTIONS=--expose-gc on Railway to keep RSS flat
on the idle server. Guarded so dev/test are unaffected."
```

---

## Task 6: Railway env var + deploy + verify

This task is operational and partly manual. Do not skip the verification window.

- [ ] **Step 6.1: Confirm current Railway usage baseline**

Capture the current memory graph before deploying, so we have a before/after comparison. Screenshot or note the peak RAM from the Railway dashboard.

- [ ] **Step 6.2: Set the Railway env var**

Add to the Railway service (`bullish-and-foolish-live` or equivalent):

```
NODE_OPTIONS=--max-old-space-size=384 --expose-gc
```

Methods:
- Dashboard: Service → Variables → New Variable.
- CLI: `railway variables --set 'NODE_OPTIONS=--max-old-space-size=384 --expose-gc'` (project must be linked).

**Do not deploy yet.** The env var takes effect on next deploy.

- [ ] **Step 6.3: Push the code changes to main**

> IMPORTANT: Per the user's standing feedback, Railway deploys require explicit per-action approval. Before running `git push`, confirm with the user that this is the intended deploy moment.

```bash
git log --oneline main...origin/main  # sanity-check what will push
git push origin main
```

- [ ] **Step 6.4: Verify the deploy used the new NODE_OPTIONS**

In Railway's deploy logs, find the startup line and confirm Node started with the flags. A grep of the deploy logs for `max-old-space-size` should match.

- [ ] **Step 6.5: Watch memory for 48 hours**

Target: RSS plateaus between 250–400 MB. Acceptance criteria:

- Memory line on the Railway usage graph trends flat instead of climbing.
- No OOM restarts in the deploy logs. (One OOM early on would be informative but not acceptable long-term — see rollback.)
- The next billing snapshot shows the memory line dropped ~50%+ vs. the April MTD baseline from `bullish.png`.

- [ ] **Step 6.6: Rollback criteria**

If after 48h:
- RSS still climbs past 384 MB and OOM-restarts, open a new investigation (likely a genuine leak; consider `--max-old-space-size=512` temporarily while profiling).
- A regression appears (stale filing-cache hits, wrong data), revert the offending commit with `git revert <sha>` and push.
- Env var rollback: remove `NODE_OPTIONS` from Railway and redeploy.

---

## Self-review

**Spec coverage:**
- § Change 1 (Node heap cap) → Task 6.2.
- § Change 2 (LRU filing caches) → Task 1.
- § Change 3 (TTL sweep on queue state) → Tasks 2 and 3.
- § Change 4 (Sqlite RSS diet) → Task 4.
- § Change 5 (Scheduled GC) → Task 5.
- § Verification → Task 6.5.
- § Rollback → Task 6.6.

**Placeholders:** none — every step has exact code or an exact command.

**Type/name consistency:**
- `lruCacheSet` is defined in Task 1.1 and referenced in Tasks 1.2 and 1.3 — same name.
- `sweepQueueState`, `QUEUE_STATE_SWEEP_INTERVAL_MS`, `JOB_STATE_RETENTION_MS`, `NOT_FOUND_LOG_RETENTION_MS` defined and used inside Task 2.
- `FILING_CACHE_MAX_ENTRIES` defined and used inside Task 1.
- Pragma strings (`cache_size = -2000`, `mmap_size = 0`) identical across all four Task 4 substeps.

No inconsistencies.
