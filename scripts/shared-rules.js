// Sector-aware scoring using only EDGAR + Yahoo-safe inputs.
function toNumber(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === "number") return isFinite(val) ? val : null;
  if (typeof val === "string") {
    const cleaned = val.replace(/[%,$]/g, "").trim();
    const mult = cleaned.endsWith("B") ? 1e9 : cleaned.endsWith("M") ? 1e6 : cleaned.endsWith("K") ? 1e3 : 1;
    const num = parseFloat(cleaned.replace(/[BMK]$/i, ""));
    return isFinite(num) ? num * mult : null;
  }
  return null;
}

export function percentToNumber(val) {
  const num = toNumber(val);
  return num === null ? null : num;
}

function bandScore(value, bands) {
  for (const band of bands) {
    if (value >= band.min) return band.score;
  }
  return bands[bands.length - 1]?.score ?? 0;
}

function missing(message, notApplicable = false) {
  return { score: 0, message, missing: true, notApplicable };
}

const fmtPct = (num) => `${Number(num).toFixed(1)}%`;

const DEFAULT_SECTOR_BUCKET = "Other";
const sectorAliases = {
  biotech: "Biotech/Pharma",
  pharma: "Biotech/Pharma",
  pharmaceutical: "Biotech/Pharma",
  financial: "Financials",
  bank: "Financials",
  finance: "Financials",
  insurance: "Financials",
  tech: "Tech/Internet",
  technology: "Tech/Internet",
  internet: "Tech/Internet",
  software: "Tech/Internet",
  consumer: "Retail",
  "consumer & services": "Retail",
  retail: "Retail",
  energy: "Energy/Materials",
  materials: "Energy/Materials",
  industrial: "Industrial/Cyclical",
  cyclical: "Industrial/Cyclical",
  real: "Real Estate",
  reit: "Real Estate"
};

export function resolveSectorBucket(raw) {
  if (!raw) return DEFAULT_SECTOR_BUCKET;
  const norm = String(raw).trim();
  if (!norm) return DEFAULT_SECTOR_BUCKET;
  const lower = norm.toLowerCase();
  for (const [needle, bucket] of Object.entries(sectorAliases)) {
    if (lower.includes(needle)) return bucket;
  }
  return norm;
}

export function applySectorRuleAdjustments(_ruleName, baseScore, sector) {
  return { score: baseScore, skipped: false, bucket: resolveSectorBucket(sector), multiplier: 1 };
}

export const ruleExplainers = {
  "Revenue growth YoY": { pos: "Revenue expansion suggests market traction.", neg: "Revenue contraction may indicate demand headwinds." },
  "Gross margin": { pos: "High margins often imply pricing power or differentiation.", neg: "Lower margins can reflect competitive pressure." },
  "Gross margin (health)": { pos: "Strong margins support R&D and commercialization.", neg: "Compressed margins may signal pricing challenges." },
  "Gross margin trend": { pos: "Margin expansion suggests efficiency gains.", neg: "Margin compression warrants monitoring." },
  "Operating margin": { pos: "Positive operating leverage indicates scalable economics.", neg: "Operational losses consume cash buffers." },
  "Operating margin (health)": { pos: "Healthy operations support pipeline development.", neg: "Operational burn increases reliance on capital markets." },
  "Operating margin (industrial)": { pos: "Solid margins reflect disciplined cost management.", neg: "Thin margins leave little room for error." },
  "Gross margin (industrial)": { pos: "Healthy margins suggest value-add manufacturing.", neg: "Weak margins may indicate commoditization." },
  "FCF margin": { pos: "Cash generation supports self-funded growth.", neg: "Cash burn necessitates external financing." },
  "Cash Runway (years)": { pos: "Ample runway provides strategic flexibility.", neg: "Short runway elevates dilution or insolvency risk." },
  "Shares dilution YoY": { pos: "Stable share count protects shareholder value.", neg: "Dilution reduces per-share value ownership." },
  "Debt / Equity": { pos: "Conservative leverage reduces financial fragility.", neg: "High leverage increases sensitivity to rates/downturns." },
  "Net Debt / FCF": { pos: "Manageable debt load allows for rapid deleveraging.", neg: "Long payback period suggests structural debt burden." },
  "Interest coverage": { pos: "Earnings comfortably cover interest obligations.", neg: "Tight coverage raises default or refinancing risk." },
  "Capex intensity": { pos: "Capital efficiency preserves cash flow.", neg: "Heavy reinvestment needs limit free cash potential." },
  "Revenue growth (small)": { pos: "Growth confirms viability/traction.", neg: "Contraction threatens scale-dependent economics." },
  "ROE": { pos: "High ROE indicates efficient capital compounding.", neg: "Low ROE suggests suboptimal capital allocation." },
  "ROE quality": { pos: "Quality returns demonstrate a potential moat.", neg: "Weak returns fail to justify cost of capital." },
  "ROIC": { pos: "Value-creating returns on invested capital.", neg: "Returns lag the likely cost of capital." },
  "Dividend coverage": { pos: "Payout appears sustainable from free cash flow.", neg: "Payout exceeds free cash flow; may be strained." },
  "50d vs 200d trend": { pos: "Price action suggests constructive momentum.", neg: "Price trend leans bearish relative to history." },
  "Net income trend": { pos: "Earnings trajectory is improving.", neg: "Earnings deterioration suggests fundamental drag." },
  "Revenue CAGR (3Y)": { pos: "Sustained growth indicates durable demand.", neg: "Anemic growth suggests stagnation." },
  "EPS CAGR (3Y)": { pos: "Long-term earnings growth builds shareholder value.", neg: "Earnings stagnation limits compounding potential." },
  "R&D intensity": { pos: "Significant R&D investment fuels future innovation.", neg: "Low R&D may compromise long-term competitiveness." },
  "52w drawdown": { pos: "Price holding up relatively well.", neg: "Significant drawdown reflects heavy market pessimism." }
};

export const ruleRegistry = {};
export const coverageMap = {};

// Metric helpers
function revenueGrowth(stock) {
  return percentToNumber(stock?.growth?.revenueGrowthTTM);
}
function fcfMargin(stock) {
  return percentToNumber(stock?.profitMargins?.fcfMargin);
}
function dilutionYoY(stock) {
  return percentToNumber(stock?.shareStats?.sharesChangeYoY);
}
function runwayYears(stock) {
  const val = stock?.financialPosition?.runwayYears;
  if (val === Infinity) return Infinity;
  // If undefined but cash/burn implies infinite, return Infinity or high val
  return percentToNumber(val);
}
function debtToEquity(stock) {
  return percentToNumber(stock?.financialPosition?.netDebtToEquity ?? stock?.financialPosition?.debtToEquity);
}
function netDebtToFcf(stock) {
  return percentToNumber(stock?.financialPosition?.netDebtToFcfYears ?? stock?.financialPosition?.netDebtToFcf);
}
function capexToRevenue(stock) {
  return percentToNumber(stock?.cash?.capexToRevenue);
}
function roePct(stock) {
  return percentToNumber(stock?.returns?.roe);
}
function netIncomeTrend(stock) {
  return percentToNumber(stock?.profitGrowthTTM);
}
function grossMargin(stock) {
  return percentToNumber(stock?.profitMargins?.grossMargin);
}
function grossMarginTrend(stock) {
  const latest = percentToNumber(stock?.profitMargins?.grossMargin);
  const prev = percentToNumber(stock?.momentum?.grossMarginPrev);
  if (latest === null || prev === null) return null;
  return latest - prev;
}
function operatingMargin(stock) {
  return percentToNumber(stock?.profitMargins?.operatingMargin);
}
function dividendPayout(stock) {
  return percentToNumber(stock?.dividends?.payoutToFcf);
}
function maSpread(stock) {
  const ma = maSlope(stock);
  if (!ma) return null;
  return { above200: ma.last - ma.ma200, above50: ma.last - ma.ma50, ratio: ma.ma50 - ma.ma200, ma50: ma.ma50, ma200: ma.ma200 };
}
function roic(stock) {
  return percentToNumber(stock?.returns?.roic);
}
function drawdown52w(stock) {
  const high = percentToNumber(stock?.priceStats?.high52);
  const last = percentToNumber(stock?.priceStats?.lastClose);
  if (last === null || high === null || high === 0) return null;
  return ((last / high) - 1) * 100;
}
function maSlope(stock) {
  const ma50 = percentToNumber(stock?.priceStats?.movingAverage50);
  const ma200 = percentToNumber(stock?.priceStats?.movingAverage200);
  const last = percentToNumber(stock?.priceStats?.lastClose);
  if (ma50 === null || ma200 === null || last === null) return null;
  return { ma50, ma200, last };
}

export const rules = [
  // Revenue growth (sector-specific bands)
  {
    name: "Revenue growth YoY",
    weight: 10,
    evaluate(stock) {
      const g = revenueGrowth(stock);
      const bucket = resolveSectorBucket(stock?.sector || stock?.sectorBucket);
      if (g === null) return missing("No revenue growth data");
      if (bucket === "Tech/Internet") {
        const score = bandScore(g, [
          { min: 30, score: 10 },
          { min: 20, score: 8 },
          { min: 10, score: 4 },
          { min: 0, score: 0 },
          { min: -10, score: -4 },
          { min: -1000, score: -8 }
        ]);
        return { score, message: fmtPct(g) };
      }
      if (bucket === "Biotech/Pharma") {
        const score = bandScore(g, [
          { min: 50, score: 4 },
          { min: 0, score: 2 },
          { min: -1000, score: -4 }
        ]);
        return { score, message: fmtPct(g) };
      }
      // General
      const score = bandScore(g, [
        { min: 10, score: 4 },
        { min: 0, score: 0 },
        { min: -1000, score: -4 }
      ]);
      return { score, message: fmtPct(g) };
    }
  },
  // Price / Sales (Valuation)
  {
    name: "Price / Sales",
    weight: 8,
    evaluate(stock) {
      const ps = stock?.valuationRatios?.psRatio;
      const bucket = resolveSectorBucket(stock?.sector || stock?.sectorBucket);

      // Fix: 0.0x P/S usually means missing data (Market Cap 0 or Price 0).
      if (ps !== null && ps < 0.01) return missing("Data invalid", true);

      if (ps === null || ps === undefined) return missing("No P/S data");

      const g = revenueGrowth(stock) || 0;
      // Hyper Growth Exception
      if (bucket === "Tech/Internet" && g > 40) {
        const score = bandScore(-ps, [
          { min: -10, score: 8 },
          { min: -18, score: 6 },
          { min: -25, score: 4 },
          { min: -40, score: 0 },
          { min: -1000, score: -4 }
        ]);
        return { score, message: `${ps.toFixed(1)}x (High Growth)` };
      }

      // Tech/biotech often trade at higher multiples
      if (bucket === "Tech/Internet" || bucket === "Biotech/Pharma") {
        const score = bandScore(-ps, [
          { min: -3, score: 8 },  // < 3x
          { min: -6, score: 5 },  // < 6x
          { min: -12, score: 2 },
          { min: -18, score: -2 },
          { min: -1000, score: -6 }
        ]);
        return { score, message: `${ps.toFixed(1)}x` };
      }
      // General
      const score = bandScore(-ps, [
        { min: -1.5, score: 8 },
        { min: -3, score: 6 },
        { min: -5, score: 2 },
        { min: -1000, score: -4 }
      ]);
      return { score, message: `${ps.toFixed(1)}x` };
    }
  },
  // Price / Earnings (Valuation)
  {
    name: "Price / Earnings",
    weight: 8,
    evaluate(stock) {
      const pe = stock?.valuationRatios?.peRatio;
      const g = revenueGrowth(stock) || 0;
      const bucket = resolveSectorBucket(stock?.sector || stock?.sectorBucket);

      // SaaS/High Growth Exemption: Unprofitable is okay if growing > 30%
      if (pe === null || pe === undefined) {
        if (bucket === "Tech/Internet" && g > 30) {
          return { score: 0, message: "Unprofitable (Growth Mode)" };
        }
        return missing("Unprofitable", true);
      }
      const score = bandScore(-pe, [
        { min: -12, score: 8 },
        { min: -20, score: 5 },
        { min: -30, score: 0 },
        { min: -50, score: -4 },
        { min: -1000, score: -8 }
      ]);
      return { score, message: `${pe.toFixed(1)}x` };
    }
  },
  // Price / Book (Financials/REITs)
  {
    name: "Price / Book",
    weight: 6,
    evaluate(stock) {
      const bucket = resolveSectorBucket(stock?.sector || stock?.sectorBucket);
      if (bucket !== "Financials" && bucket !== "Real Estate") return missing("Not applicable", true);
      const pb = stock?.valuationRatios?.pbRatio;
      if (pb === null) return missing("No P/B data");
      const score = bandScore(-pb, [
        { min: -1, score: 8 },
        { min: -1.5, score: 5 },
        { min: -3, score: 0 },
        { min: -1000, score: -4 }
      ]);
      return { score, message: `${pb.toFixed(1)}x` };
    }
  },
  // Gross margin
  {
    name: "Gross margin",
    weight: 8,
    evaluate(stock) {
      const gm = grossMargin(stock);
      const bucket = resolveSectorBucket(stock?.sector || stock?.sectorBucket);
      if (bucket !== "Tech/Internet") return missing("Not applicable", true);
      if (gm === null) return missing("No gross margin data");
      const score = bandScore(gm, [
        { min: 75, score: 8 },
        { min: 60, score: 6 },
        { min: 50, score: 2 },
        { min: 40, score: -2 },
        { min: -1000, score: -6 }
      ]);
      return { score, message: fmtPct(gm) };
    }
  },
  // Gross margin (industrial)
  {
    name: "Gross margin (industrial)",
    weight: 5,
    evaluate(stock) {
      const gm = grossMargin(stock);
      const bucket = resolveSectorBucket(stock?.sector || stock?.sectorBucket);
      if (bucket !== "Industrial/Cyclical") return missing("Not applicable", true);
      if (gm === null) return missing("No gross margin data");
      const score = bandScore(gm, [
        { min: 35, score: 5 },
        { min: 25, score: 2 },
        { min: 15, score: 0 },
        { min: 0, score: -4 },
        { min: -1000, score: -6 }
      ]);
      return { score, message: fmtPct(gm) };
    }
  },
  // Gross margin trend
  {
    name: "Gross margin trend",
    weight: 6,
    evaluate(stock) {
      const trend = grossMarginTrend(stock);
      const bucket = resolveSectorBucket(stock?.sector || stock?.sectorBucket);
      if (bucket !== "Retail") return missing("Not applicable", true);
      if (trend === null) return missing("No gross margin trend data");
      const score = trend > 0 ? 6 : trend === 0 ? 0 : -6;
      return { score, message: fmtPct(trend) };
    }
  },
  // Gross margin (health)
  {
    name: "Gross margin (health)",
    weight: 6,
    evaluate(stock) {
      const gm = grossMargin(stock);
      const bucket = resolveSectorBucket(stock?.sector || stock?.sectorBucket);
      if (bucket !== "Healthcare" && bucket !== "Staples" && bucket !== "Biotech/Pharma") return missing("Not applicable", true);

      const isBio = bucket === "Biotech/Pharma" || (stock?.sicDescription && /pharm|bio|drug|device/i.test(stock?.sicDescription));
      const revenue = stock?.expenses?.revenue;

      if (isBio) {
        if (Number.isFinite(revenue) && revenue < 50_000_000) return missing("Not applicable (early stage)", true);
        // Relaxed for commercial bio
        const score = bandScore(gm, [
          { min: 80, score: 6 },
          { min: 60, score: 3 },
          { min: 40, score: 0 },
          { min: -1000, score: -2 }
        ]);
        return { score, message: fmtPct(gm) };
      }

      if (gm === null) return missing("No gross margin data");
      const score = bandScore(gm, [
        { min: 55, score: 6 },
        { min: 45, score: 3 },
        { min: 35, score: 0 },
        { min: 0, score: -4 },
        { min: -1000, score: -8 }
      ]);
      return { score, message: fmtPct(gm) };
    }
  },
  // Operating margin
  {
    name: "Operating margin",
    weight: 8,
    evaluate(stock) {
      const om = operatingMargin(stock);
      const bucket = resolveSectorBucket(stock?.sector || stock?.sectorBucket);
      if (bucket !== "Industrial/Cyclical") return missing("Not applicable", true);
      if (om === null) return missing("No operating margin data");
      const score = bandScore(om, [
        { min: 15, score: 8 },
        { min: 10, score: 4 },
        { min: 5, score: 0 },
        { min: 0, score: -4 },
        { min: -1000, score: -8 }
      ]);
      return { score, message: fmtPct(om) };
    }
  },

  // Operating margin (health)
  {
    name: "Operating margin (health)",
    weight: 6,
    evaluate(stock) {
      const bucket = resolveSectorBucket(stock?.sector || stock?.sectorBucket);
      if (bucket !== "Healthcare" && bucket !== "Staples" && bucket !== "Biotech/Pharma") return missing("Not applicable", true);

      if (bucket === "Biotech/Pharma") return missing("Not applicable (Focus on Cash Burn)", true);

      const om = operatingMargin(stock);
      if (om === null) return missing("No operating margin data");
      const score = bandScore(om, [
        { min: 20, score: 6 },
        { min: 15, score: 3 },
        { min: 8, score: 0 },
        { min: 0, score: -4 },
        { min: -1000, score: -8 }
      ]);
      return { score, message: fmtPct(om) };
    }
  },
  // FCF margin
  {
    name: "FCF margin",
    weight: 10,
    evaluate(stock) {
      const fcf = fcfMargin(stock);
      const bucket = resolveSectorBucket(stock?.sector || stock?.sectorBucket);
      if (fcf === null) return missing("No FCF margin data");

      if (bucket === "Biotech/Pharma") {
        const mcap = stock?.marketCap || 0;
        const isMiddleOrLarge = mcap > 2e9;

        // Healthy Burn Logic:
        const burnTrend = percentToNumber(stock?.momentum?.burnTrend);
        const g = revenueGrowth(stock);
        const isHealthyBurn = (burnTrend && burnTrend > 15) || (g && g > 50);

        const score = bandScore(fcf, [
          { min: 10, score: 2 },
          { min: 0, score: 0 },
          { min: -20, score: -2 },
          { min: -50, score: isHealthyBurn ? -2 : (isMiddleOrLarge ? -2 : -4) },
          { min: -100, score: isHealthyBurn ? -2 : (isMiddleOrLarge ? -4 : -6) },
          { min: -1000000, score: isHealthyBurn ? -2 : (isMiddleOrLarge ? -6 : -8) }
        ]);
        return { score, message: isHealthyBurn ? `${fmtPct(fcf)} (Inv. Mode)` : fmtPct(fcf) };
      }
      if (bucket === "Real Estate") return missing("Not applicable (Use FFO)", true);
      if (bucket === "Tech/Internet") {
        const score = bandScore(fcf, [
          { min: 20, score: 6 },
          { min: 10, score: 3 },
          { min: 0, score: 0 },
          { min: -20, score: -4 },
          { min: -50, score: -8 },
          { min: -1000000, score: -12 }
        ]);
        return { score, message: fmtPct(fcf) };
      }
      return { score: 0, message: fmtPct(fcf) };
    }
  },
  // Cash Runway
  {
    name: "Cash Runway (years)",
    weight: 10,
    evaluate(stock) {
      const bucket = resolveSectorBucket(stock?.sector || stock?.sectorBucket);
      if (bucket !== "Biotech/Pharma") return missing("Not applicable", true);
      const runway = runwayYears(stock);
      if (runway === null) return missing("No runway data");
      if (runway === Infinity || runway > 50) return { score: 4, message: "Self-funded" };

      const score = bandScore(runway, [
        { min: 3, score: 3 },
        { min: 1.5, score: 2 },
        { min: 0.75, score: 0 },
        { min: 0.5, score: -3 },
        { min: -1000, score: -6 }
      ]);
      return { score, message: `${runway.toFixed(2)}y` };
    }
  },
  // Shares dilution YoY
  {
    name: "Shares dilution YoY",
    weight: 10,
    evaluate(stock) {
      const d = dilutionYoY(stock);
      const bucket = resolveSectorBucket(stock?.sector || stock?.sectorBucket);
      if (d === null) return missing("No share count data");

      const g = revenueGrowth(stock) || 0;
      const isHighGrowth = g > 40;

      if (bucket === "Biotech/Pharma") {
        const mcap = stock?.marketCap || 0;
        const score = bandScore(d, [
          { min: -20, score: 2 },
          { min: 0, score: 0 },
          { min: 20, score: -5 }, // Softer
          { min: 50, score: -10 },
          { min: -1000, score: -15 }
        ]);
        // Cap penalty for large biotechs
        if (mcap > 1e9 && score < -10) return { score: -10, message: fmtPct(d) };
        return { score, message: fmtPct(d) };
      }

      if (isHighGrowth) {
        const score = bandScore(d, [
          { min: -5, score: 5 },
          { min: 5, score: 4 },
          { min: 15, score: 2 },
          { min: 25, score: 0 },
          { min: 50, score: -6 },
          { min: -1000, score: -12 }
        ]);
        return { score, message: `${fmtPct(d)} (Growth Mode)` };
      }

      const score = bandScore(d, [
        { min: -15, score: 8 },
        { min: -3, score: 5 },
        { min: 2, score: 3 },
        { min: 6, score: 0 },
        { min: 12, score: -6 },
        { min: -1000, score: -12 }
      ]);
      return { score, message: fmtPct(d) };
    }
  },
  // Debt / Equity
  {
    name: "Debt / Equity",
    weight: 8,
    evaluate(stock) {
      const d = debtToEquity(stock);
      const bucket = resolveSectorBucket(stock?.sector || stock?.sectorBucket);
      const totalDebt = stock?.financialPosition?.totalDebt;
      const finDebt = stock?.financialPosition?.financialDebt;

      // Explicit Zero Debt Bonus
      if (totalDebt === 0 || (finDebt === 0) || (finDebt != null && stock?.financialPosition?.totalAssets && finDebt < stock.financialPosition.totalAssets * 0.01)) {
        const bonus = bucket === "Biotech/Pharma" ? 5 : 10;
        return { score: bonus, message: "No financial debt (debt-free)" };
      }

      if (bucket === "Financials") return missing("Not applicable (Sector standard)", true);

      if (d === null) return missing("No leverage data");
      const score = bandScore(-d, [
        { min: -1.5, score: 8 },
        { min: -3, score: 6 },
        { min: -4, score: 2 },
        { min: -1000, score: -6 }
      ]);
      return { score, message: `${d.toFixed(2)}x` };
    }
  },
  // Lease Obligations
  {
    name: "Lease Obligations",
    weight: 5,
    evaluate(stock) {
      const leases = stock?.financialPosition?.leaseLiabilities || 0;
      const assets = stock?.financialPosition?.totalAssets || 0;
      const bucket = resolveSectorBucket(stock?.sector || stock?.sectorBucket);

      // Examples where real estate/leases matter less or are just standard OpEx
      const lightweightSectors = new Set(["Biotech/Pharma", "Tech/Internet", "Software"]);

      if (assets > 0 && (leases / assets) > 0.30) return { score: -4, message: "High lease burden (>30% assets)" };

      // For lightweight sectors, don't award points for low leases (it's expected) -> Hide card via notApplicable
      if (lightweightSectors.has(bucket)) {
        if ((leases / assets) < 0.10) return { score: 0, message: "Low lease burden", notApplicable: true };
      }

      if (assets > 0 && (leases / assets) < 0.10) return { score: 4, message: "Low lease burden (<10% assets)" };
      return { score: 0, message: "Moderate" };
    }
  },
  // Net Debt / FCF
  {
    name: "Net Debt / FCF",
    weight: 6,
    evaluate(stock) {
      const bucket = resolveSectorBucket(stock?.sector || stock?.sectorBucket);
      if (bucket !== "Energy/Materials" && bucket !== "Real Estate") return missing("Not applicable", true);
      const years = netDebtToFcf(stock);
      if (years === null) return missing("No data");
      const score = bandScore(-years, [{ min: -1, score: 4 }, { min: -3, score: 0 }, { min: -1000, score: -6 }]);
      return { score, message: `${years.toFixed(1)}y` };
    }
  },
  // Capex intensity
  {
    name: "Capex intensity",
    weight: 4,
    evaluate(stock) {
      const bucket = resolveSectorBucket(stock?.sector || stock?.sectorBucket);
      if (bucket !== "Energy/Materials") return missing("Not applicable", true);
      const v = capexToRevenue(stock);
      if (v === null) return missing("No data");
      const score = bandScore(-v, [{ min: -5, score: 2 }, { min: -10, score: 0 }, { min: -1000, score: -4 }]);
      return { score, message: fmtPct(v) };
    }
  },
  // ROE
  {
    name: "ROE",
    weight: 10,
    evaluate(stock) {
      const bucket = resolveSectorBucket(stock?.sector || stock?.sectorBucket);
      if (bucket !== "Financials") return missing("Not applicable", true);
      const v = roePct(stock);
      if (v === null) return missing("No ROE data");
      const score = bandScore(v, [{ min: 15, score: 10 }, { min: 8, score: 5 }, { min: 0, score: -4 }, { min: -1000, score: -10 }]);
      return { score, message: fmtPct(v) };
    }
  },
  // ROE quality
  {
    name: "ROE quality",
    weight: 8,
    evaluate(stock) {
      const roe = roePct(stock);
      const bucket = resolveSectorBucket(stock?.sector || stock?.sectorBucket);
      if (bucket === "Financials") return missing("Not applicable", true);
      if (bucket === "Biotech/Pharma") return missing("Not applicable (pre-profit)", true);
      if (roe === null) return missing("No ROE data");
      const score = bandScore(roe, [
        { min: 80, score: -4 },
        { min: 40, score: 6 },
        { min: 15, score: 4 },
        { min: 10, score: 2 },
        { min: 0, score: 0 },
        { min: -1000, score: -8 }
      ]);
      return { score, message: fmtPct(roe) };
    }
  },
  // ROIC
  {
    name: "ROIC",
    weight: 8,
    evaluate(stock) {
      const bucket = resolveSectorBucket(stock?.sector || stock?.sectorBucket);
      if (bucket === "Financials") return missing("Not applicable", true);
      const v = roic(stock);
      if (v === null) return missing("No ROIC data");
      const score = bandScore(v, [
        { min: 25, score: 8 },  // Elite
        { min: 15, score: 4 },  // Good
        { min: 6, score: 1 },
        { min: 0, score: -4 },
        { min: -1000, score: -8 }
      ]);
      return { score, message: fmtPct(v) };
    }
  },
  // Net income trend (Financials)
  // Net income trend (Financials OR Improved Profitability)
  {
    name: "Net income trend",
    weight: 6,
    evaluate(stock) {
      const bucket = resolveSectorBucket(stock?.sector || stock?.sectorBucket);
      const v = netIncomeTrend(stock);
      if (v === null) return missing("No net income data");

      // Case 1: Financials (Standard metric)
      if (bucket === "Financials") {
        const score = bandScore(v, [
          { min: 10, score: 4 },
          { min: 0, score: 0 },
          { min: -1000, score: -4 }
        ]);
        return { score, message: fmtPct(v) };
      }

      // Case 2: Turnaround / Breakout (Tech/Industrial)
      // If unprofitable but improving aggressively (>15% reduction in loss), reward it.
      // This offsets the "No P/E" penalty.
      const isUnprofitable = stock?.profitMargins?.netIncome < 0;
      if (isUnprofitable && (bucket === "Tech/Internet" || bucket === "Industrial/Cyclical")) {
        const score = bandScore(v, [
          { min: 50, score: 6 }, // Massive improvement
          { min: 20, score: 4 }, // Solid narrowing
          { min: 10, score: 2 },
          { min: 0, score: 0 },
          { min: -1000, score: -2 }
        ]);
        return { score, message: score > 0 ? `${fmtPct(v)} (Loss narrowing)` : fmtPct(v) };
      }

      return missing("Not applicable");
    }
  },
  // 52w drawdown (generic)
  {
    name: "52w drawdown",
    weight: 4,
    evaluate(stock) {
      const dd = drawdown52w(stock);
      if (dd === null) return missing("No price data");
      const score = bandScore(dd, [
        { min: -10, score: 4 },
        { min: -25, score: 1 },
        { min: -40, score: -2 },
        { min: -1000, score: -4 }
      ]);
      return { score, message: fmtPct(dd) };
    }
  },
  // Interest coverage (critical)
  {
    name: "Interest coverage",
    weight: 8,
    evaluate(stock) {
      const ic = stock?.financialPosition?.interestCoverage;
      const de = stock?.financialPosition?.debtToEquity;
      if (ic === null || ic === undefined) {
        if (de !== null && de !== undefined && de < 0.2) {
          return { score: 10, message: "Debt-Free", missing: true, notApplicable: true };
        }
        return missing("Data unavailable");
      }
      if (ic === Infinity || ic > 1e6) return { score: 10, message: "Debt-Free", missing: true, notApplicable: true };
      const score = bandScore(ic, [
        { min: 12, score: 8 },
        { min: 6, score: 4 },
        { min: 3, score: 1 },
        { min: 1, score: -4 },
        { min: -1000, score: -8 }
      ]);
      return { score, message: `${ic.toFixed(1)}x` };
    }
  },
  // Revenue CAGR (3Y) for mature sectors
  {
    name: "Revenue CAGR (3Y)",
    weight: 6,
    evaluate(stock) {
      const bucket = resolveSectorBucket(stock?.sector || stock?.sectorBucket);
      if (bucket === "Tech/Internet") return missing("Not applicable", true);
      const g = percentToNumber(stock?.growth?.revenueCagr3y);
      if (g === null) return missing("No CAGR data");
      const score = bandScore(g, [
        { min: 12, score: 6 },
        { min: 7, score: 3 },
        { min: 3, score: 1 },
        { min: 0, score: -2 },
        { min: -1000, score: -6 }
      ]);
      return { score, message: fmtPct(g) };
    }
  },
  // EPS CAGR (3Y) for mature sectors
  {
    name: "EPS CAGR (3Y)",
    weight: 6,
    evaluate(stock) {
      const bucket = resolveSectorBucket(stock?.sector || stock?.sectorBucket);
      if (bucket === "Tech/Internet") return missing("Not applicable", true);
      const g = percentToNumber(stock?.growth?.epsCagr3y);
      if (g === null) return missing("No EPS CAGR data");
      const score = bandScore(g, [
        { min: 15, score: 6 },
        { min: 8, score: 3 },
        { min: 3, score: 1 },
        { min: 0, score: -2 },
        { min: -1000, score: -6 }
      ]);
      return { score, message: fmtPct(g) };
    }
  },
  // Dividend coverage vs FCF
  {
    name: "Dividend coverage",
    weight: 5,
    evaluate(stock) {
      const payout = dividendPayout(stock);
      if (payout === null) return missing("No dividend payout data");
      if (payout < 0.2) return { score: 2, message: fmtPct(payout) };
      if (payout <= 0.8) return { score: 5, message: fmtPct(payout) };
      if (payout <= 1.0) return { score: 2, message: fmtPct(payout) };
      if (payout <= 1.3) return { score: -4, message: fmtPct(payout) };
      return { score: -6, message: fmtPct(payout) };
    }
  },
  // Momentum: 50d vs 200d
  {
    name: "50d vs 200d trend",
    weight: 4,
    evaluate(stock) {
      const ma = maSpread(stock);
      if (!ma) return missing("No moving average data");
      const above50 = ma.above50;
      const above200 = ma.above200;
      const ratio = ma.ratio;
      const score = (() => {
        if (above200 > 0 && ratio > 0) return 4;
        if (above200 > 0 && ratio >= -0.02 * Math.abs(ma.ma200)) return 2;
        if (above200 < 0 && ratio < 0) return -4;
        return 0;
      })();
      return { score, message: `50d-200d: ${ratio != null ? ratio.toFixed(2) : "n/a"}` };
    }
  },
  // R&D intensity (Biotech/Pharma)
  {
    name: "R&D intensity",
    weight: 5,
    evaluate(stock) {
      const bucket = resolveSectorBucket(stock?.sector || stock?.sectorBucket);
      const isBio = bucket === "Biotech/Pharma" ||
        (stock?.sicDescription && /pharm|bio|drug|device/i.test(stock?.sicDescription)) ||
        (bucket === "Healthcare" && (Number(stock?.expenses?.rdToRevenue) > 10 || (stock?.expenses?.revenue < 50e6 && stock?.expenses?.rdSpend > 1e6)));

      if (!isBio) return missing("Not applicable", true);
      const v = percentToNumber(stock?.expenses?.rdToRevenue);
      const rdSpend = stock?.expenses?.rdSpend;

      if (v === null) {
        if (Number.isFinite(rdSpend) && rdSpend > 0) {
          return { score: 5, message: `High Intensity ($${(rdSpend / 1e6).toFixed(1)}M)` };
        }
        return missing("No R&D data");
      }
      const score = bandScore(v, [
        { min: 18, score: 2 },
        { min: 12, score: 5 },
        { min: 8, score: 0 },
        { min: 4, score: -2 },
        { min: 0, score: -4 },
        { min: -1000, score: -6 }
      ]);
      return { score, message: fmtPct(v) };
    }
  }
];
