# Scoring Methodology & Weight Rationale

## Overview

This document explains how rule weights were determined for the **Open Fundamentals Engine**. 
The engine uses a weighted scoring system where each rule contributes to a final 0-100 quality score.
Scores are derived from SEC EDGAR filings, standardized into a consistent data model, and evaluated against sector-specific benchmarks.

## Weight Categories

| Weight | Label | Meaning |
|--------|-------|---------|
| 10 | **High Impact** | Core drivers of long-term value creation (e.g., FCF, Dilution) |
| 8 | **Significant** | Important financial health indicators (e.g., Margins, Valuation) |
| 5-6 | **Moderate** | Supporting signals (e.g., Operating Leverage) |
| 2-3 | **Bonus/Minor** | Tie-breakers, nice-to-haves (e.g., Efficiency ratios) |

## Weight Assignment Principles

### 1. Fundamentals First, Valuation Second
- Profitability, cash flow, and balance sheet health are weighted higher than valuation multiples.
- **Rationale:** A cheap stock with deteriorating fundamentals is often a value trap. A great business at a fair price is preferable to a fair business at a great price.

### 2. Cash is King
- **FCF Margin (weight: 10)** is the most heavily weighted profitability metric.
- **Rationale:** Reported earnings (Net Income) can be manipulated via accounting choices; Free Cash Flow is harder to fake and represents the actual cash potentially returning to shareholders.

### 3. Dilution Destroys Value
- **Shares Dilution YoY (weight: 10)** receives maximum weight.
- **Rationale:** For retail investors, dilution is often the #1 silent killer of returns, especially in biotech and speculative growth sectors. Companies funding operations solely through share issuance are penalized heavily.

### 4. Growth with Guardrails
- **Revenue Growth (weight: 10)** is important but checks are in place for "empty calories" growth.
- **Rationale:** Growth without improving margins or unit economics is unsustainable.

### 5. Sector Adaptation
- Rules are adjusted dynamically based on sector (e.g., Biotech, SaaS, Industrial).
- **Example:** "Cash Runway" is a critical (weight 10) metric for Biotech but irrelevant for profitable Apples/Microsofts. Gross Margin thresholds are >75% for Software but >35% for Retail.

## Core Rules & Weight Assignments

| Rule | Weight | Rationale |
|------|--------|-----------|
| **Revenue growth YoY** | 10 | Core indicator of demand and market position. Adjusted for sector standards. |
| **FCF margin** | 10 | The ultimate profitability metric. Cash generation relative to size. |
| **Shares dilution YoY** | 10 | Measures if the pie is shrinking for existing holders. Critical for small-caps. |
| **Cash Runway** | 10 | (Biotech/Unprofitable only) Survival time at current burn rate. Existential risk metric. |
| **Price / Sales** | 8 | Valuation relative to revenue. Useful for comparing unprofitable growth companies. |
| **Price / Earnings** | 8 | Classic valuation metric. Penalizes expensive profitable companies unless growth is extreme. |
| **Gross margin** | 8 | Proxy for pricing power and business model quality. |
| **Gross margin (health/trend)** | 6 | Sector-specific checks (e.g. Retail margin stability). |
| **Operating leverage** | 5 | Measures if OpEx is growing slower than Revenue (scalability). |
| **Price / Book** | 6 | (Financials/REITs only) Asset-based valuation standard for these sectors. |
| **Working Capital** | 2 | Bonus for operational efficiency (Cash Conversion Cycle). |
| **Capital Return** | 3 | Rewards shareholder-friendly capital allocation (Dividends + Buybacks). |

## Validation & Evolution

### Current State (v1.0)
- Weights were assigned based on **practitioner experience** and classic fundamental analysis frameworks (e.g., Piotroski F-Score, Altman Z-Score, Rule of 40).
- Validated via ongoing manual review against known "quality" and "distressed" companies across various sectors. Edge cases discovered through real-world use drive continuous refinement.

### Future Work
- **Backtesting:** We plan to run historical backtests to correlate high "Quality Scores" with stock performance over 3-5 year horizons.
- **Community Consensus:** As an open-source project, weights and benchmarks are subject to community discussion and refinement via Pull Requests.

---

## Contextual Intelligence: Beyond Binary Scoring

### The Problem with Traditional Screeners

Most stock screeners apply **rigid formulas** that ignore context:
- "Net margin < 0% = Bad" penalizes pre-revenue biotechs and hypergrowth companies equally
- "Shares increased 100%" flags both genuine dilution AND stock splits
- "Debt/Equity > 1" penalizes capital-intensive businesses regardless of cash generation

Financial reality is nuanced - **50 shades of grey, not black and white**.

### Our Approach: Context-Aware Adjustments

The Open Fundamentals Engine applies **contextual guards** that recognize when standard rules don't apply:

| Scenario | Naive Approach | Contextual Adjustment |
|----------|----------------|----------------------|
| **Stock Splits** | "100%+ share increase = dilution!" | Detect split via EPS inverse correlation; neutralize penalty |
| **Reverse Splits** | "75% share reduction = buyback!" | Detect reverse split; neutralize false positive credit |
| **Fintech in Financials** | Apply bank capital ratios | Flag as fintech, apply tech/growth evaluation lens |
| **Pre-Revenue Biotech** | "Zero revenue = zero score" | Weight cash runway, pipeline signals, R&D intensity instead |
| **REITs** | "90% payout ratio is unsustainable!" | Recognize REIT structure; adjust dividend threshold appropriately |
| **Hypergrowth Burn** | "-40% FCF margin = failing" | Check revenue growth + capex intensity; waive burn penalty if investing for growth |
| **Going Concern Warnings** | Always flag as terminal risk | Distinguish regulatory boilerplate vs genuine distress via text analysis |
| **Spinoffs/Separations** | "Revenue dropped 50%!" | Detect spinoff filings; flag but don't penalize structural change |

### Implementation Examples

**Split Detection** (`engine/stockAdjustments.js`):
```javascript
// If shares doubled but EPS halved (and net income stable), it's a split, not dilution
const inverseProduct = Math.abs(sharesRatio * epsRatio - 1);
if (inverseProduct <= tolerance && netIncomeStable) {
    return { flagged: true, reason: "likely-split" };
}
```

**Fintech Override** (`engine/utils.js`):
```javascript
// SoFi, Upstart, etc. are classified as "Financial Services" by SEC
// but should be evaluated as growth tech companies
const KNOWN_FINTECH_TICKERS = new Set(["SOFI", "UPST", "AFRM", "SQ", "PYPL"]);
```

**Filing Text Signals** (`server/edgar/filingTextScanner.js`):
```javascript
// Distinguish boilerplate "going concern" mentions from genuine warnings
const GOING_CONCERN_NEGATION = [
    "no going concern", "not a going concern", "does not raise going concern"
];
```

### Continuous Refinement Philosophy

Edge cases are **discovered through use**, not predicted in advance. Our open-source model enables:

1. **User-Reported Anomalies**: "Why did Company X score poorly when it's clearly healthy?"
2. **Root Cause Analysis**: Identify which rule misfired and why
3. **Contextual Guard Addition**: Add detection logic, document rationale
4. **Community Review**: Changes are visible, reviewable, and reversible

This creates a **virtuous cycle** where the methodology improves with every real-world edge case encountered.

### Educational Value

Each contextual adjustment teaches financial literacy:
- **Why do stock splits happen?** (Accessibility, psychology, index eligibility)
- **Why do REITs pay out 90%+?** (Tax structure requires it)
- **Why do pre-revenue biotechs exist for years?** (R&D timelines, FDA approval process)
- **What's the difference between capex burn and operational burn?** (Investment vs losses)

This transparency transforms the tool from a black-box score into a **learning platform**.

---

## European Expansion: Companies House UK Pilot

The same contextual philosophy applies to adapting the engine for European markets.

### Why Companies House UK First?

**Companies House** (UK) is the ideal pilot market for EU expansion:

| Factor | Benefit |
|--------|--------|
| **Language** | English - no translation layer required |
| **API Access** | Well-documented public REST API with free tier |
| **Filing Format** | XBRL/iXBRL with structured financial data |
| **IFRS Alignment** | UK uses IFRS, providing a test case for non-GAAP adaptation |
| **Developer Ecosystem** | Active open-source community and documentation |
| **Corporate Diversity** | Mix of sectors, sizes, and structures for comprehensive testing |

### Adaptation Requirements

| US Concept | UK Equivalent | Work Required |
|------------|---------------|---------------|
| SEC EDGAR | Companies House API | Data provider adapter |
| GAAP accounting | UK-adopted IFRS | Metric normalization layer |
| SIC sector codes | SIC 2007 (UK variant) | Sector mapping rules |
| 10-K/10-Q forms | Annual Accounts / Interim Reports | Form type detection |
| Going Concern (US GAAP) | Going Concern (ISA 570 UK) | Text pattern updates |

### Architecture for Multi-Jurisdiction Support

The modular `engine/` architecture separates:
- **Data ingestion** (jurisdiction-specific, in `server/edgar/` or `server/companies-house/`)
- **Scoring logic** (universal, in `engine/`)

New jurisdictions implement a `DataProvider` interface that normalizes filings into the standard `stock` object schema (see `engine/types/stock.d.ts`).
