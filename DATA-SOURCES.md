# Data Sources

This document describes the data sources used by the Open Fundamentals Engine and the Bullish & Foolish demo application.

## Primary Data Source: SEC EDGAR

The engine's core financial data comes from the **SEC EDGAR** (Electronic Data Gathering, Analysis, and Retrieval) system, which is:

- **Public**: Freely accessible to all
- **Authoritative**: Official source for US public company filings
- **Stable**: Well-documented, programmatic API
- **Legal**: Explicitly designed for public access

### Data Retrieved from SEC EDGAR

- 10-K (Annual Reports)
- 10-Q (Quarterly Reports)
- 8-K (Current Reports)
- Company Facts JSON (structured financial metrics)
- Filing metadata and accession numbers

### Fair Use Compliance

All SEC EDGAR requests include a descriptive `User-Agent` header per SEC guidelines and respect rate limits (10 requests/second max).

---

## Secondary Data Source: NASDAQ Screener API

For **end-of-day (EOD) price and market cap data**, the demo application uses the NASDAQ website's public screener endpoint:

```
https://api.nasdaq.com/api/screener/stocks
```

### Important Legal Notice

> **This API is not officially documented for programmatic use.**
>
> While the endpoint is publicly accessible (no authentication required), NASDAQ does not provide official developer documentation or Terms of Service for this specific API. This represents a "legal gray area" for commercial or production use.

### Current Usage

- EOD prices fetched once daily via a scheduled job
- Data is cached locally to minimize requests
- Used only for display purposes (price display, market cap calculation)
- **Not used** for the core fundamental scoring logic

### Alternatives & Fallback Plan

If NASDAQ access becomes restricted or problematic, the following alternatives are available:

| Provider | Type | Notes |
|----------|------|-------|
| **Alpha Vantage** | Free tier | 25 requests/day, API key required |
| **Polygon.io** | Freemium | Good free tier for EOD data |
| **Yahoo Finance** | Unofficial | Similar legal gray area |
| **IEX Cloud** | Paid | Reliable, documented API |
| **Tiingo** | Freemium | Developer-friendly, documented |

For self-hosting or minimal-dependency deployments, the engine can operate without real-time prices by:
1. Using SEC-reported share counts for rough valuation
2. Omitting price-based metrics from scoring
3. Allowing users to input their own price data

---

## Data Independence

The **Open Fundamentals Engine** (`engine/` module) itself is **data-source agnostic**:

- It receives a normalized `stock` object
- It does not make any external API calls
- It can be fed data from any source (SEC, European regulators, manual input)

This separation ensures the engine can be adapted for:
- European markets (using national registry data)
- Private companies (using manually provided financials)
- Academic research (using historical datasets)

---

## Recommendations for Production Use

1. **For fundamental data**: Continue using SEC EDGAR (no concerns)
2. **For price data**: Consider a paid provider with clear ToS for production deployments
3. **For academic/research use**: Current setup is appropriate
4. **For compliance**: Document any paid data dependencies in your deployment

---

*Last updated: 2025-12-31*
