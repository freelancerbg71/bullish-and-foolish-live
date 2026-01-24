# Bullish & Foolish

Bullish & Foolish is a lightweight, explainable fundamentals engine that turns public SEC filings into a clear, sector-aware quality score and tier for public companies.

The goal: **signal over noise** - a transparent, rules-based view of financial health that doesn’t depend on hype or short-term price action.

## What It Does

- Ingests and normalizes financial statement data from SEC EDGAR filings.
- Applies a rules-based scoring model (sector-aware benchmarks) to produce a **0–100 Quality Score** and tier.
- Serves a fast UI for ticker pages and a screener view.
- Maintains a daily end-of-day (EOD) price patch used only for display and basic context.

## How It Works (High Level)

### Core Engine

The fundamentals engine lives in `engine/`:

- `engine/index.js` - Main entry point exporting all public APIs
- `engine/rules.js` - 28+ scoring rules with sector-aware thresholds
- `engine/calculations.js` - Financial calculations (FCF, runway, coverage ratios)
- `engine/stockBuilder.js` - Builds normalized stock object for rule evaluation
- `engine/stockAdjustments.js` - Split detection, share change guards
- `engine/constants.js` - All constants and thresholds
- `engine/utils.js` - Pure utility functions (math, formatting, sector classification)
- `engine/ruleExplainers.js` - Human-readable explanations for each scoring rule

### Contextual Intelligence

Financial analysis isn't black and white. The engine applies **contextual guards** that recognize when standard rules don't apply:

- **Stock splits** detected via EPS inverse correlation (not penalized as dilution)
- **Fintech companies** flagged separately from traditional banks
- **Pre-revenue biotechs** evaluated on runway and pipeline, not revenue growth
- **Hypergrowth burn** distinguished from operational losses

See `engine/METHODOLOGY.md` for the full philosophy and examples.

### Scoring Rules

- Rules are defined in `engine/rules.js` (imports core utilities from `engine/`)
- Server-side assembly and scoring live in `server/ticker/tickerAssembler.js`
- The server entrypoint is `server.js`

### Daily EOD price patch

The UI reads EOD prices from `data/prices.json` (served as `/data/prices.json`). This is intentionally separated from fundamentals ingestion so prices can be refreshed independently and efficiently.

Debug endpoint:

- `GET /api/prices/status`

## Running Locally

### Install

```bash
npm install
```

### Start the server

```bash
npm start
```

Open:

- `http://localhost:3003/`
- `http://localhost:3003/ticker/AAPL`

### Refresh EOD prices (one-off)

```bash
node worker/jobs/daily-last-trade.js --force
```

## Key URLs

- Ticker page: `/ticker/<SYMBOL>` (example: `/ticker/META`)
- Screener: `/screener.html`
- Methodology: `/about.html`
- Rules: `/rules.html`

## Deployment Notes (Railway)

This app is designed to run with a persistent volume mounted at `/data`:

- Set `RAILWAY_VOLUME_MOUNT_PATH=/data`
- The daily prices scheduler auto-enables when `RAILWAY_VOLUME_MOUNT_PATH` is present

Useful env vars:

- `PRICES_REFRESH_UTC_HOUR` (default: `3`)
- `PRICES_PATCH_MAX_AGE_MS` (default: `48h`)
- `PRICES_FORCE_RUN_ON_START=1` (force refresh on boot)

## License

This project is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0). See `LICENSE`.

## Contributing

See `CONTRIBUTING.md`.

