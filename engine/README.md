# Bullish & Foolish Fundamentals Engine

A rules-based, sector-aware scoring engine for evaluating public company financial health using SEC EDGAR filings.

## Overview

This directory contains the core fundamentals engine that powers the Bullish & Foolish stock analysis platform. The engine is designed to be **modular and reusable**, separate from the web UI.

## Module Structure

```
engine/
├── index.js          # Main entry point - exports all public APIs
├── constants.js      # All constants, thresholds, and configuration values
├── utils.js          # Pure utility functions (math, formatting, dates)
└── ruleExplainers.js # Human-readable explanations for each scoring rule
```

## Usage

```javascript
// Import from the main engine entry point
import {
  toNumber,
  resolveSectorBucket,
  normalizeRuleScore,
  getScoreBand,
  SECTOR_BUCKETS,
  TIER_THRESHOLDS,
  ENGINE_VERSION
} from './engine/index.js';

// Use utilities
const score = normalizeRuleScore(rawScore);
const band = getScoreBand(score);
const sector = resolveSectorBucket("Technology");
```

## Key Exports

### Constants

| Constant | Description |
|----------|-------------|
| `ONE_YEAR_MS` | One year in milliseconds |
| `MICRO_CAP_THRESHOLD` | Market cap threshold for micro-cap classification |
| `SMALL_CAP_THRESHOLD` | Market cap threshold for small-cap classification |
| `MID_CAP_THRESHOLD` | Market cap threshold for mid-cap classification |
| `SECTOR_BUCKETS` | Object containing all sector bucket names |
| `TIER_LABELS` | Object containing tier label strings |
| `TIER_THRESHOLDS` | Score thresholds for each tier |

### Utility Functions

| Function | Description |
|----------|-------------|
| `toNumber(val)` | Safely convert any value to a number |
| `percentToNumber(val)` | Convert percentage values to numbers |
| `safeDiv(a, b)` | Safe division avoiding divide-by-zero |
| `clamp(min, val, max)` | Clamp a value between min and max |
| `pctChange(curr, prev)` | Calculate percent change |
| `calcCagr(latest, older, years)` | Calculate CAGR |
| `resolveSectorBucket(raw)` | Resolve sector string to standard bucket |
| `normalizeRuleScore(score)` | Normalize raw score to 0-100 |
| `getScoreBand(val)` | Get tier label for a score |
| `isFintech(stock)` | Detect if a company is fintech |
| `fmtPct(num)` | Format number as percentage string |
| `fmtMoney(num)` | Format number as money string |

### Rule Explainers

```javascript
import { ruleExplainers, getExplainerForRule } from './engine/index.js';

// Get explainer for a rule
const explanation = getExplainerForRule("Revenue growth YoY", scoreValue);
```

## Design Principles

1. **No Side Effects**: All utility functions are pure and have no side effects
2. **Null Safety**: Functions return `null` for invalid inputs rather than throwing
3. **Centralized Constants**: All magic numbers are defined in `constants.js`
4. **Sector Awareness**: Functions handle sector-specific logic consistently

## Version

Current engine version: `1.0.0` (2025-12-28)

Access version programmatically:
```javascript
import { ENGINE_VERSION, ENGINE_BUILD_DATE } from './engine/index.js';
```

## License

AGPL-3.0 - See root LICENSE file.
