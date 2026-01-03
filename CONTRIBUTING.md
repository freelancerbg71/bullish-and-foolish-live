# Contributing

Thanks for your interest in contributing to the Bullish & Foolish engine.

This repo is intentionally small and fast: the goal is to keep the rating engine understandable, auditable, and cheap to run.

## Quick Start

### Prerequisites

- Node.js (recent LTS recommended)
- `npm`

### Install

```bash
npm install
```

### Run locally

```bash
npm start
```

By default, the server uses `./data` for persisted state.

## Where the rating logic lives

- Rules + sector-aware scoring: `engine/rules.js`
- Financial calculations: `engine/calculations.js`
- Stock split detection: `engine/stockAdjustments.js`
- Stock object builder: `engine/stockBuilder.js`
- Server-side rating assembly: `server/ticker/tickerAssembler.js`

## Reporting Scoring Anomalies (Edge Cases)

Found a company that scores unexpectedly high or low? This is valuable feedback!

### Open an Issue With:

```
**Ticker**: [e.g., SOFI]
**Expected Score Range**: [e.g., 60-75, "solid growth company"]
**Actual Score**: [e.g., 35]
**Why It Seems Wrong**: [e.g., "It's a fintech being penalized by bank capital ratios"]
```

### Why This Matters

Financial analysis isn't black and white - it's 50 shades of grey. Our goal is to build **contextual intelligence** that handles edge cases gracefully:

- Stock splits vs. genuine dilution
- Fintech companies misclassified as traditional banks
- Pre-revenue biotechs with strong cash runways
- REITs with "high" payout ratios (required by structure)
- Hypergrowth companies investing heavily (burn ≠ failure)

See `engine/METHODOLOGY.md` → "Contextual Intelligence" for our philosophy.

### Propose a Fix

If you've identified a systematic pattern:

1. **Describe the pattern**: "Pre-revenue biotechs with >$500M cash are penalized for zero revenue"
2. **Propose the guard**: "Skip revenue growth rule if sector is Biotech AND cash runway > 3 years"
3. **Provide test cases**: List 3-5 tickers that would benefit

## Design rules for contributions

### No ticker-specific scoring

Scoring must be **sector-based** and **data-driven**. Avoid rules like:

- “+10 points because ticker is XYZ”
- “special-case this one company”

If you need to debug one ticker, use `DEBUG_TICKER` (logs only; no scoring changes).

### Keep rules explainable

Each rule should have:

- a clear name
- a deterministic score calculation
- a short explanation message suitable for UI display

### Prefer bulk data paths

The app is designed to be efficient:

- use the `prices.json` patch (bulk EOD) for UI price display
- avoid per-ticker external price calls during normal page loads

## Daily price updates (EOD patch)

The UI reads end-of-day prices from `data/prices.json` (served as `/data/prices.json`).

### One-off refresh

```bash
node worker/jobs/daily-last-trade.js --force
```

This downloads bulk prices and writes:

- `DATA_DIR/prices.json` (static patch used by the screener + ticker pages)

### Auto-refresh scheduler

The server can run the daily price updater automatically (boot warm-up + nightly UTC schedule):

- `PRICES_SCHEDULER_ENABLED=1` to enable explicitly
- On Railway, it auto-enables when `RAILWAY_VOLUME_MOUNT_PATH` is present

Key env vars:

- `PRICES_REFRESH_UTC_HOUR` (default: `3`)
- `PRICES_PATCH_MAX_AGE_MS` (default: `48h`) – when exceeded, `/data/prices.json` is treated as stale
- `PRICES_FORCE_RUN_ON_START=1` – forces a refresh on boot (useful when debugging)

Debug endpoint:

- `GET /api/prices/status`

## Running tests

```bash
npm run test:prices
```

## Pull request checklist

- Changes are limited in scope and easy to review
- No ticker-specific scoring logic added
- Any new env vars are documented in this file
- If you changed tier thresholds or labels, update both backend and UI mappings

## Governance

Please see [GOVERNANCE.md](./GOVERNANCE.md) for details on project roles, decision making, and our code of conduct.
