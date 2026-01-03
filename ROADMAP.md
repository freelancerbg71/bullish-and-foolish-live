# Open Fundamentals Engine - Roadmap

This document outlines the development roadmap for the Open Fundamentals Engine.

## Vision

Build a **transparent, context-aware financial analysis engine** that:
- Provides clear, explainable scoring (no black boxes)
- Handles edge cases gracefully through continuous refinement
- Adapts to different markets and accounting standards
- Serves as an educational tool for financial literacy

---

## Phase 1: Foundation ✅ (Complete)

### Core Engine Architecture
- [x] Modular `engine/` structure with clear separation of concerns
- [x] 28+ scoring rules with sector-aware thresholds
- [x] Split detection and share change guards
- [x] Fintech override for misclassified financial companies
- [x] Filing text signal extraction (going concern, clinical trials, etc.)

### Data Pipeline
- [x] SEC EDGAR ingestion for US public companies
- [x] Quarterly and annual statement normalization
- [x] TTM (Trailing Twelve Months) calculations
- [x] EOD price integration for display

### Web Demo
- [x] Ticker page with score, narrative, and signal cards
- [x] Screener with sortable, paginated results
- [x] Rules transparency page

---

## Phase 2: Edge Case Refinement (In Progress)

### Contextual Intelligence
- [x] Stock split detection (EPS inverse correlation)
- [x] Reverse split detection
- [x] Cash runway for pre-revenue companies
- [ ] REIT payout ratio adjustment
- [ ] Hypergrowth burn vs operational loss distinction
- [ ] Spinoff/separation detection

### Filing Signal Improvements
- [x] Going concern warning detection
- [x] Clinical trial outcome signals (biotech)
- [x] Regulatory approval signals
- [ ] M&A announcement detection
- [ ] Debt covenant warning detection
- [ ] Management change signals

### Documentation
- [x] METHODOLOGY.md with weight rationale
- [x] CONTRIBUTING.md with edge case reporting
- [x] DATA-SOURCES.md with legal considerations
- [ ] JSDoc comments on all major functions
- [ ] API documentation for external consumers

---

## Phase 3: European Expansion (Planned)

### Data Source Abstraction
- [ ] Define `DataProvider` interface for pluggable data sources
- [ ] Abstract SEC-specific code paths in `server/edgar/`
- [ ] Create adapter pattern for different filing formats

### European Registry Integration
- [ ] Companies House UK (pilot market)
- [ ] German Federal Gazette (Bundesanzeiger)
- [ ] French AMF filings
- [ ] IFRS-to-GAAP metric normalization layer

### Sector Classification Harmonization
- [ ] Map NACE codes to internal sector buckets
- [ ] Handle dual-listed companies
- [ ] Cross-border subsidiary handling

---

## Phase 4: Community & Sustainability

### Developer Experience
- [ ] npm package for standalone engine usage
- [ ] CLI tool for local scoring
- [ ] Docker image for self-hosting
- [ ] GitHub Actions for automated testing

### Educational Features
- [ ] "Why this score?" explanation modal
- [ ] Rule-by-rule breakdown view
- [ ] Historical score tracking
- [ ] Comparison tool (Company A vs Company B)

### Quality Assurance
- [ ] Backtesting framework (score vs 3-5 year returns)
- [ ] Automated edge case regression tests
- [ ] Community-reported anomaly tracker

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for how to report scoring anomalies and propose edge case fixes.

---

## License

AGPL-3.0 - See [LICENSE](./LICENSE)
