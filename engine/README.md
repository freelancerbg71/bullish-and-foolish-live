# Open Fundamentals Engine

A modular, rules-based scoring engine for evaluating public company financial health. Built for transparency, extensibility, and reuse.

## What Is This?

The **Open Fundamentals Engine** is the core analysis library behind the [Bullish & Foolish](https://bullishandfoolish.com) stock rating platform.  It is designed as a **standalone, reusable module** that can be embedded in other applications, research tools, or educational platforms.

**Key principles:**
- 📊 **Transparent methodology** — All scoring rules are explicit and auditable
- 🏭 **Sector-aware** — Benchmarks adapt to industry context (biotech ≠ retail)
- 🔓 **Open source (AGPL-3.0)** — Free to use, modify, and redistribute
- 🧩 **Modular** — Use the full engine or import individual utilities
- 🚫 **Price-Agnostic** — Fundamentals come first; price inputs are optional
- 🗣️ **No black boxes** — Every score can be explained

## Who Is This For?

| Audience | Use Case |
|----------|----------|
| **Developers** | Build your own stock analysis tools using the engine |
| **Researchers** | Study fundamental scoring methodologies |
| **Educators** | Teach financial analysis with transparent, auditable rules |
| **Analysts** | Extend the rules for custom sector analysis |
| **Regulators/Journalists** | Audit corporate financial health programmatically |

## Project Structure

```
engine/
├── index.js            # Main entry point - exports all public APIs
├── rules.js            # Scoring rules definitions (28+ rules)
├── calculations.js     # Financial calculations (FCF, runway, coverage)
├── stockBuilder.js     # Builds normalized stock object from raw data
├── stockAdjustments.js # Split detection, share change guards
├── constants.js        # All constants, thresholds, and configuration values
├── utils.js            # Pure utility functions (math, formatting, dates)
├── ruleExplainers.js   # Human-readable explanations for each scoring rule
├── types/
│   └── stock.d.ts      # TypeScript schema for the normalized stock object
└── tests/              # Unit tests (64 tests)
```

**Related modules** (in parent directory):
- `server/edgar/` — SEC EDGAR data ingestion (US-specific adapter)

## Quick Start

### Installation

```bash
# Clone the repository
git clone https://github.com/freelancerbg71/bullish-and-foolish-live.git
cd bullish-and-foolish-live

# Install dependencies
npm install
```

### Basic Usage

```javascript
import {
  // Constants
  SECTOR_BUCKETS,
  TIER_THRESHOLDS,
  MICRO_CAP_THRESHOLD,
  
  // Utilities
  toNumber,
  safeDiv,
  resolveSectorBucket,
  normalizeRuleScore,
  getScoreBand,
  isFintech,
  
  // Formatting
  fmtPct,
  fmtMoney,
  
  // Version
  ENGINE_VERSION
} from './engine/index.js';

// Resolve a sector string to a standard bucket
const sector = resolveSectorBucket("Technology");
// → "Tech/Internet"

// Normalize a raw score to 0-100 scale
const normalized = normalizeRuleScore(75);

// Get the tier label for a score
const tier = getScoreBand(85);
// → "bullish"

// Safe division with fallback
const ratio = safeDiv(netIncome, revenue);

// Check if a company is a fintech
const fintech = isFintech({ ticker: "SOFI", name: "SoFi Technologies" });
// → true
```

## API Reference

### Constants

#### Time Constants
| Constant | Value | Description |
|----------|-------|-------------|
| `ONE_DAY_MS` | 86,400,000 | One day in milliseconds |
| `ONE_YEAR_MS` | 31,536,000,000 | One year in milliseconds |
| `STALE_DATA_THRESHOLD_MS` | 15,552,000,000 | 180 days — data staleness threshold |

#### Market Cap Thresholds
| Constant | Value | Description |
|----------|-------|-------------|
| `MICRO_CAP_THRESHOLD` | $200M | Below this = micro-cap |
| `SMALL_CAP_THRESHOLD` | $2B | Below this = small-cap |
| `MID_CAP_THRESHOLD` | $10B | Below this = mid-cap |
| `LARGE_CAP_THRESHOLD` | $50B | Above this = mega-cap |

#### Sector Buckets
```javascript
SECTOR_BUCKETS = {
  BIOTECH_PHARMA: "Biotech/Pharma",
  TECH_INTERNET: "Tech/Internet",
  FINANCIALS: "Financials",
  REAL_ESTATE: "Real Estate",
  RETAIL: "Retail",
  INDUSTRIAL: "Industrial/Cyclical",
  ENERGY_MATERIALS: "Energy/Materials",
  OTHER: "Other"
}
```

#### Tier Thresholds
| Tier | Score Range | Label |
|------|-------------|-------|
| Elite | 91-100 | `elite` |
| Bullish | 76-90 | `bullish` |
| Solid | 61-75 | `solid` |
| Mixed | 46-60 | `mixed` |
| Speculative | 31-45 | `spec` |
| Danger | 0-30 | `danger` |

### Utility Functions

#### Number Operations
| Function | Description |
|----------|-------------|
| `toNumber(val)` | Safely convert any value to number or `null` |
| `percentToNumber(val)` | Convert "5.5%" → 5.5 |
| `safeDiv(a, b)` | Division with divide-by-zero protection |
| `clamp(min, val, max)` | Constrain value to range |
| `pctChange(curr, prev)` | Calculate percent change |
| `calcCagr(latest, older, years)` | Compound annual growth rate |

#### Sector Classification
| Function | Description |
|----------|-------------|
| `resolveSectorBucket(raw)` | Map sector string → standard bucket |
| `applySectorRuleAdjustments(bucket, rule)` | Adjust rule weights by sector |
| `isFintech(stock)` | Detect fintech companies |

#### Score Normalization
| Function | Description |
|----------|-------------|
| `normalizeRuleScore(score)` | Normalize raw score to 0-100 |
| `getScoreBand(val)` | Get tier label for score |
| `bandScore(val, bands)` | Score within custom bands |

#### Formatting
| Function | Description |
|----------|-------------|
| `fmtPct(num)` | Format as percentage: `12.5%` |
| `fmtMoney(num)` | Format as currency: `$1.2B` |
| `missing(val)` | Return '—' for null/undefined |

### Rule Explainers

Generate human-readable explanations for scoring decisions:

```javascript
import { ruleExplainers, getExplainerForRule } from './engine/index.js';

// Get explanation for a specific rule outcome
const explanation = getExplainerForRule("Revenue growth YoY", 8);
// → "Strong revenue growth indicates healthy demand"
```

## Design Principles

1. **Pure Functions** — No side effects, no hidden state
2. **Null Safety** — Invalid inputs return `null`, not exceptions
3. **Centralized Constants** — All magic numbers in `constants.js`
4. **Sector Awareness** — Rules adapt to industry context
5. **Explainability** — Every score decision can be explained

## Extending the Engine

### Adding New Rules

Rules are defined in `engine/rules.js`. Each rule has:

```javascript
{
  name: "Rule Name",
  weight: 10,  // Importance weight (1-15)
  evaluate: (stock) => {
    // Return { score, msg } or null
    return {
      score: 8,  // -10 to +10 typically
      msg: "Explanation for this score"
    };
  }
}
```

### Adding New Sectors

1. Add the sector to `SECTOR_BUCKETS` in `constants.js`
2. Add aliases in `SECTOR_ALIASES`
3. Update `applySectorRuleAdjustments()` in `utils.js`

### Adding New Data Sources

The engine is data-source agnostic. The current implementation uses SEC EDGAR, but you can adapt it to:
- European filings (ESEF)
- Other regulatory sources
- Private company data
- Custom datasets

See `server/edgar/edgarFundamentals.js` for the current adapter pattern.

## Testing

```bash
npm run test:engine
```

## Version

| Property | Value |
|----------|-------|
| `ENGINE_VERSION` | 1.0.0 |
| `ENGINE_BUILD_DATE` | 2025-12-28 |

Access programmatically:
```javascript
import { ENGINE_VERSION, ENGINE_BUILD_DATE } from './engine/index.js';
```

## Roadmap

- [ ] Publish as standalone npm package
- [x] CLI mode for headless scoring
- [ ] European data source adapters (ESEF)
- [ ] Additional sector-specific rule packs
- [ ] WebAssembly build for browser-only usage

## Related Projects

- **Bullish & Foolish** (bullishandfoolish.com) — Live demo analyzing US public companies
- **SEC EDGAR** — US regulatory filing source

## License

**AGPL-3.0** — This ensures the engine remains open source even when used in network services.

See the root [LICENSE](../LICENSE) file for full terms.

## Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md) for guidelines.

Key rules:
- No ticker-specific scoring logic
- All rules must be sector-based and data-driven
- Every rule needs an explainer message
