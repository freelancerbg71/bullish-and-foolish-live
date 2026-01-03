# Open Fundamentals Engine API Reference

This document provides a detailed reference for the public API of the Open Fundamentals Engine.

## Core Modules

The engine is composed of the following modules, all exported via `engine/index.js`:

### 1. Constants (`constants.js`)

Centralized configuration values, thresholds, and magic numbers.

#### Time Constants
- `ONE_DAY_MS`: 86,400,000
- `ONE_WEEK_MS`: 604,800,000
- `ONE_YEAR_MS`: 31,536,000,000
- `STALE_DATA_THRESHOLD_MS`: 15,552,000,000 (180 days)

#### Market Cap Classifications
- `MICRO_CAP_THRESHOLD`: $200M
- `SMALL_CAP_THRESHOLD`: $2B
- `MID_CAP_THRESHOLD`: $10B
- `LARGE_CAP_THRESHOLD`: $50B

#### Tiers
- `TIER_THRESHOLDS`: Scoring breakpoints for quality tiers.
  - `ELITE`: 91+
  - `BULLISH`: 76-90
  - `SOLID`: 61-75
  - `MIXED`: 46-60
  - `SPECULATIVE`: 31-45
  - `DANGER`: 0-30

### 2. Utilities (`utils.js`)

Pure functions for financial calculation and data normalization.

#### Numeric Helpers
- `toNumber(val)`: Converts string/number inputs to a safe number or `null`. Handles "5M", commas, etc.
- `percentToNumber(val)`: Parsers strings like "5.2%" into `5.2`.
- `safeDiv(num, den)`: Divisions that return `0` or `null` instead of `Infinity` / `NaN`.

#### Sector Logic
- `resolveSectorBucket(sectorString)`: Maps raw sector names (e.g., from EDGAR or Finviz) to internal buckets:
  - `Biotech/Pharma`
  - `Tech/Internet`
  - `Financials`
  - `Real Estate`
  - `Retail`
  - `Industrial/Cyclical`
  - `Energy/Materials`
  - `Other`
- `applySectorRuleAdjustments(sectorBucket, rule)`: Adjusts scoring weights dynamically. For example, 'Inventory Turnover' is ignored for Banks.

#### Scoring Normalization
- `normalizeRuleScore(rawScore)`: Converts the raw aggregate score (which can range from negative to >100) into a clamped 0-100 quality score.
- `getScoreBand(score)`: Returns the string label (e.g., "bullish") for a given 0-100 score.

### 3. Rule Explainers (`ruleExplainers.js`)

Helper functions to generate human-readable text for scoring outcomes.

- `getExplainerForRule(ruleName, score)`: Returns a specific explanation string.
  - Example: `getExplainerForRule("Gross margin", 8)` -> "High gross margins indicate strong pricing power."

## Data Interfaces

### The `stock` Object

The engine expects a standardized `stock` object as input for scoring. The minimal shape required is:

```javascript
{
  ticker: "AAPL",
  sector: "Technology", // or SIC code description
  // Financial Metrics
  revenue: 1000000,
  netIncome: 50000,
  totalAssets: 200000,
  totalLiabilities: 100000,
  operatingCashFlow: 60000,
  
  // Computed Metrics (if available, otherwise engine computes them)
  grossMargin: 0.45,
  operatingMargin: 0.30,
  
  // Historical Arrays (for trend analysis)
  quarterly: [
    { periodEnd: "2024-12-31", revenue: ... },
    { periodEnd: "2024-09-30", revenue: ... },
    ...
  ]
}
```

## Adding New Rules

Rules are defined declaratively. To extend the engine, you define rules in the following format:

```javascript
{
  id: "my_custom_rule",
  name: "My Custom Rule",
  weight: 5,
  evaluate: (stock) => {
    // Logic here
    if (stock.someMetric > 10) return { score: 10, msg: "Great!" };
    return { score: 0, msg: "Neutral" };
  }
}
```

## Error Handling

The engine follows a "graceful degradation" philosophy:
- Missing data points result in a generic "Missing Data" penalty or neutral score (0), depending on the rule.
- It does **not** throw exceptions for missing fields.
- `null` is propagated safely through utility functions.

## Versioning

The engine uses Semantic Versioning (SemVer).
- Current Version: `1.0.0`
