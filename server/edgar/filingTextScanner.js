import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  detectIssuerTypeFromSubmissions,
  fetchCompanySubmissions,
  limitedFetch,
} from "./edgarFundamentals.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(ROOT, "data");
const EDGAR_DIR = path.join(DATA_DIR, "edgar");

const DEFAULT_FORMS = ["10-Q", "10-K", "8-K", "6-K", "20-F", "DEF 14A", "DEF14A"];
const CACHE_TTL_MS =
  Number(process.env.FILING_SIGNALS_CACHE_TTL_MS) ||
  Number(process.env.FILING_SIGNALS_CACHE_TTL_HOURS) * 60 * 60 * 1000 ||
  72 * 60 * 60 * 1000; // default: 72 hours
const FILING_SIGNALS_ALLOW_STALE = process.env.FILING_SIGNALS_ALLOW_STALE !== "0"; // default: allow stale disk cache
const EDGAR_FILING_SIGNALS_ENABLED = process.env.EDGAR_FILING_SIGNALS_ENABLED !== "0"; // default: enabled
const FILING_SIGNALS_SCANNER_VERSION = "2025-12-24-label-fix-v7";
const goingConcernCache = new Map();
const filingSignalCache = new Map();
const MAX_RECENT_FILINGS_DEFAULT = Number(process.env.FILING_SIGNALS_MAX_FILINGS) || 3;
const MAX_RECENT_FILINGS_DEEP = Number(process.env.FILING_SIGNALS_MAX_FILINGS_DEEP) || 10;
const PRIMARY_FORMS = new Set(["10-Q", "10-K", "20-F", "6-K"]);
const INSIDER_FORMS = ["4", "4/A"];
const BOILERPLATE_SECTION_TOKENS = [
  "risk factors",
  "forward-looking statements",
  "cautionary statements",
  "cautionary note",
  "general legal",
  "legal proceedings",
  "liquidity risks may include",
  "cautionary note regarding",
  "cautionary statement regarding",
  "private securities litigation reform act",
  "actual results could vary materially",
  "actual results may differ materially",
  "could differ materially",
  "you are cautioned not to rely",
  "inherently subject to uncertainty",
  "undue reliance"
];
const ALLOWED_SECTION_TOKENS = [
  "management's discussion",
  "managements discussion",
  "results of operations",
  "financial condition",
  "liquidity",
  "business",
  "clinical",
  "clinical update",
  "clinical results",
  "regulatory update",
  "subsequent events",
  "material weakness",
  "commitments",
  "contingencies",
  "notes to consolidated financial statements",
  "notes to financial statements"
];
const MODAL_HINTS = [" could ", " may ", " might ", " would ", " should ", " in the event that "];
const HISTORICAL_HINTS = [" historically", " in the past", " previously", " prior ", " legacy "];

const GOING_CONCERN_PHRASES = [
  "going concern",
  "going-concern",
  "ability to continue as a going concern",
  "continue as a going concern",
  "substantial doubt",
  "substantial doubt about our ability to continue as a going concern",
  "substantial doubt about its ability to continue as a going concern",
  "may not be able to continue operations",
  "ability to meet obligations",
  "doubt regarding continued operation",
  "inability to continue as a going concern"
];

const NEGATION_TOKENS = ["no ", "not ", "without ", "does not ", "did not ", "will not ", "hardly ", "unlikely ", "neither ", "never "];
const SEVERITY_LEVELS = {
  CRITICAL: "critical",
  WARNING: "warning",
  INFO: "info"
};

/**
 * Signal conflicts: When a negative signal is detected, its positive counterpart should be suppressed.
 * Map format: { negative_signal_id: positive_signal_id_to_suppress }
 * 
 * Logic: If we detect both the problem AND its resolution, we keep only the problem.
 * This is conservative - better to flag risk than to assume it's fully resolved.
 */
const SIGNAL_CONFLICTS = {
  // Internal control weakness vs remediation
  material_weakness: "material_weakness_remediated",

  // Clinical failure/negative vs clinical positive (pipeline quality)
  clinical_failure: "clinical_positive",
  clinical_negative: "clinical_positive",

  // Regulatory setback vs regulatory positive
  regulatory_setback: "regulatory_positive",
  regulatory_negative: "regulatory_positive",

  // Safety concerns vs favorable safety
  safety_bad: "safety_good",

  // Going concern vs debt refinanced (if company has going concern, debt refinance doesn't matter much)
  going_concern: "debt_refinance",

  // Covenant risk vs credit upgrade
  covenant_risk: "credit_upgrade",

  // Leadership turnover vs governance signals (not a direct conflict, but keep both)
};

function formMatches(candidate, allowed) {
  const upper = (candidate || "").toUpperCase();
  const cleaned = upper.trim();
  return allowed.some((f) => {
    const target = (f || "").toUpperCase();
    return cleaned === target || cleaned.startsWith(`${target}/`);
  });
}

function stripTagsToText(html) {
  if (!html) return "";
  const withoutTags = html.replace(/<[^>]+>/g, " ");
  const text = withoutTags.replace(/\s+/g, " ").trim();
  return truncateForwardLookingFooter(text);
}

export function truncateForwardLookingFooter(text) {
  const raw = String(text || "");
  if (!raw) return "";
  const lower = raw.toLowerCase();
  const len = lower.length;
  if (!len) return raw;

  const tokens = [
    "forward-looking statements",
    "forward looking statements",
    "cautionary statement regarding forward-looking statements",
    "cautionary statement regarding forward looking statements",
    "safe harbor"
  ];

  // Use the last occurrence of any footer token (many filings repeat similar phrases earlier).
  let lastIdx = -1;
  for (const token of tokens) {
    const idx = lower.lastIndexOf(token);
    if (idx > lastIdx) lastIdx = idx;
  }
  if (lastIdx === -1) return raw;

  // Heuristic: only treat as a boilerplate footer if it appears late in the document.
  // This avoids truncating legitimate sections that happen to discuss forward-looking items earlier.
  if (lastIdx < len * 0.35) return raw;

  const tail = lower.slice(lastIdx, Math.min(len, lastIdx + 2400));
  const disclaimerHints = [
    "private securities litigation reform act",
    "current report on form 8-k",
    "this current report on form 8-k",
    "section 27a",
    "section 21e",
    "undue reliance",
    "no obligation to",
    "risks and uncertainties",
    "could differ materially",
    "actual results may differ",
    "actual results could vary materially",
    "forward-looking statement",
    "this press release",
    "this report",
    "this release",
    "regarding, among other things",
    "future operating and financial performance",
    "product development",
    "market position",
    "business strategy",
    "objectives",
    "future financing plans",
    "you are cautioned not to rely",
    "inherently subject to uncertainty",
    "known or unknown risks or uncertainties",
    "assumptions prove inaccurate",
    "materialize"
  ];
  const looksLikeFooter = disclaimerHints.some((h) => tail.includes(h));
  if (!looksLikeFooter) return raw;

  return raw.slice(0, lastIdx).trim();
}

function checkNegation(text, matchIndex, windowSize = 60) {
  const start = Math.max(0, matchIndex - windowSize);
  const preceding = text.slice(start, matchIndex).toLowerCase();
  // Check if any negation token is "close" to the match (within the window)
  return NEGATION_TOKENS.some((token) => preceding.includes(token));
}

function scanForPhrases(text) {
  const lower = text.toLowerCase();
  const snippets = [];
  // Families are now handled by ID in SIGNAL_DEFS, this function scans generic "phrases"
  // but usually we rely on scanFilingForSignals loop.
  // Wait, scanForPhrases below is only used by scanFilingForGoingConcern.
  // We will enhance it to support negation.

  for (const phrase of GOING_CONCERN_PHRASES) {
    let pos = 0;
    while (true) {
      const idx = lower.indexOf(phrase, pos);
      if (idx === -1) break;

      if (!checkNegation(text, idx)) {
        const start = Math.max(0, idx - 160);
        const end = Math.min(text.length, idx + 160);
        snippets.push(text.slice(start, end));
      }
      pos = idx + phrase.length;
    }
  }
  return snippets;
}

function contextWindow(text, idx, radius = 1800) {
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + radius);
  return text.slice(start, end).toLowerCase();
}

function isBoilerplateContext(ctx) {
  return BOILERPLATE_SECTION_TOKENS.some((t) => ctx.includes(t));
}

function isAllowedContext(ctx) {
  return ALLOWED_SECTION_TOKENS.some((t) => ctx.includes(t));
}

function isHypothetical(snippetLower) {
  const modalHits = MODAL_HINTS.filter((m) => snippetLower.includes(m)).length;
  // Treat as hypothetical if modal verbs dominate and no concrete verbs present
  const concreteHits = ["received ", "breached", "accelerate", "defaulted", "issued", "announced", "filed"].filter(
    (m) => snippetLower.includes(m)
  ).length;
  return modalHits > 0 && concreteHits === 0;
}

function isHistorical(snippetLower) {
  return HISTORICAL_HINTS.some((h) => snippetLower.includes(h));
}

const STALE_YEARS = ["2019", "2020", "2021", "2022", "2023", "2024"];

function shouldSuppressFlag(text, idx, snippet) {
  const ctx = contextWindow(text, idx);
  const snippetLower = (snippet || "").toLowerCase();

  // Foreign filers often state "Assumptions for going concern: none" in footnotes; treat that as explicit no-risk.
  if (snippetLower.includes("going concern") && (snippetLower.includes(" none") || snippetLower.includes("no substantial doubt"))) {
    return true;
  }

  // IOVA Fix: Suppress "clinical failure" or "hold" if referring to stale years
  // e.g. "On December 22, 2023..."
  // Check 'ctx' (wider context) because the year might be 50 chars back and not in the tight snippet
  /* 
  if (STALE_YEARS.some(year => ctx.includes(year))) {
    return true;
  }
  */

  // IOVA Fix: Suppress "clinical hold" if it says "lifted" or "resumed" in the context
  const resolutionPhrases = [
    "lifted clinical hold",
    "lifted the clinical hold",
    "lifted the partial clinical hold",
    "lifted a partial clinical hold",
    "hold has been lifted",
    "hold was lifted",
    "remove the clinical hold",
    "removed the clinical hold",
    "resumed patient enrollment",
    "resume patient enrollment",
    "enrollment has resumed",
    "trial has resumed",
    "resumed enrollment"
  ];
  if (resolutionPhrases.some(p => ctx.includes(p))) return true;

  // IOVA Fix: Suppress risk factor lists e.g. "imposition of a clinical hold"
  const hypotheticalPrefixes = [
    "imposition of",
    "possibility of",
    "risk of",
    "potential for",
    "investigation into",
    "subject to"
  ];
  if (hypotheticalPrefixes.some(p => snippetLower.includes(p) || ctx.includes(p + " a " + snippetLower) || ctx.includes(p + " " + snippetLower))) {
    return true;
  }

  if (isBoilerplateContext(ctx)) return true;
  if (!isAllowedContext(ctx)) {
    return true;
  }

  if (
    snippetLower.includes("restructuring") &&
    (snippetLower.includes("government") || snippetLower.includes("federal") || snippetLower.includes("state") || snippetLower.includes("non-company-level"))
  )
    return true;

  // IOVA Fix: "prevalence and severity of adverse events" is hypothetical risk factor language
  if (snippetLower.includes("adverse events") && (snippetLower.includes("prevalence") || snippetLower.includes("severity") || snippetLower.includes("risk"))) return true;

  // NEW: Negation check
  if (checkNegation(text, idx)) return true;

  if (isHypothetical(snippetLower)) return true;
  if (isHistorical(snippetLower)) return true;
  return false;
}

function fundamentalsCachePath(ticker) {
  return path.join(EDGAR_DIR, `${ticker.toUpperCase()}-fundamentals.json`);
}

function loadCachedFilingSignals(ticker, now = Date.now()) {
  try {
    const file = fundamentalsCachePath(ticker);
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const version = parsed?.filingSignalsScannerVersion || null;
    if (version !== FILING_SIGNALS_SCANNER_VERSION) return null;
    const signals = Array.isArray(parsed?.filingSignals) ? parsed.filingSignals : null;
    const meta = parsed?.filingSignalsMeta || null;
    const cachedAtStr = parsed?.filingSignalsCachedAt || parsed?.updatedAt || null;
    const latestFiledInPeriods = Array.isArray(parsed?.periods)
      ? parsed.periods
        .map((p) => p?.filedDate)
        .filter(Boolean)
        .sort()
        .slice(-1)[0] || null
      : null;
    const metaFiled = meta?.filed || null;
    const maxFilings = parsed?.filingSignalsMaxDepth || 0;
    if (!signals || !signals.length) return null;
    const cachedAt = cachedAtStr ? Date.parse(cachedAtStr) : null;
    const isFresh = cachedAt == null || !Number.isFinite(cachedAt) || now - cachedAt <= CACHE_TTL_MS;
    const matchesLatestFiling =
      metaFiled && latestFiledInPeriods && metaFiled === latestFiledInPeriods;
    if (!isFresh && !matchesLatestFiling && !FILING_SIGNALS_ALLOW_STALE) return null;
    const metaOut = meta ? { ...meta } : null;
    if (!isFresh && !matchesLatestFiling) {
      if (metaOut) metaOut.staleCache = true;
    }
    return {
      signals,
      meta: metaOut,
      cachedAt: cachedAtStr || null,
      maxFilings
    };
  } catch (err) {
    console.warn("[filingTextScanner] failed to read fundamentals cache", ticker, err?.message || err);
    return null;
  }
}

function persistFilingSignals(ticker, payload) {
  try {
    fs.mkdirSync(EDGAR_DIR, { recursive: true });
    const file = fundamentalsCachePath(ticker);
    let existing = {};
    try {
      if (fs.existsSync(file)) {
        existing = JSON.parse(fs.readFileSync(file, "utf8"));
      }
    } catch (err) {
      console.warn("[filingTextScanner] failed to load existing fundamentals cache", ticker, err?.message || err);
    }
    const keepExistingSignals =
      (!payload?.signals || payload.signals.length === 0) &&
      Array.isArray(existing?.filingSignals) &&
      existing?.filingSignalsScannerVersion === FILING_SIGNALS_SCANNER_VERSION;
    const merged = {
      ...existing,
      filingSignalsScannerVersion: FILING_SIGNALS_SCANNER_VERSION,
      filingSignals: keepExistingSignals
        ? existing.filingSignals
        : Array.isArray(payload?.signals)
          ? payload.signals
          : [],
      filingSignalsMeta: payload?.meta ?? (keepExistingSignals ? existing.filingSignalsMeta : null) ?? null,
      filingSignalsCachedAt:
        payload?.cachedAt ?? (keepExistingSignals ? existing.filingSignalsCachedAt : null) ?? new Date().toISOString(),
      filingSignalsMaxDepth: payload?.maxFilings ?? existing?.filingSignalsMaxDepth ?? 0
    };
    fs.writeFileSync(file, JSON.stringify(merged));
  } catch (err) {
    console.warn("[filingTextScanner] failed to persist filing signals cache", ticker, err?.message || err);
  }
}

export async function fetchLatestFilingMeta(ticker, forms = DEFAULT_FORMS, opts = {}) {
  const { submissions: subs, cik } = await fetchCompanySubmissions(ticker, opts);
  const recent = subs?.filings?.recent;
  const formList = recent?.form || [];
  const accList = recent?.accessionNumber || [];
  const filedList = recent?.filingDate || [];
  const primaryDocs = recent?.primaryDocument || [];

  for (let i = 0; i < formList.length; i += 1) {
    const f = (formList[i] || "").toUpperCase();
    if (!formMatches(f, forms)) continue;
    const canonicalForm = f.trim();
    const accession = accList[i];
    const filed = filedList[i];
    const primary = primaryDocs[i] || "";
    if (!accession) continue;
    return { cik, accession, filed, form: canonicalForm, primary };
  }

  return null;
}

async function fetchRecentFilingsMeta(ticker, forms = DEFAULT_FORMS, maxCount = MAX_RECENT_FILINGS, opts = {}) {
  const { submissions: subs, cik } = await fetchCompanySubmissions(ticker, opts);
  const recent = subs?.filings?.recent;
  const formList = recent?.form || [];
  const accList = recent?.accessionNumber || [];
  const filedList = recent?.filingDate || [];
  const primaryDocs = recent?.primaryDocument || [];
  const rows = [];
  for (let i = 0; i < formList.length; i += 1) {
    const f = (formList[i] || "").toUpperCase();
    if (!formMatches(f, forms)) continue;
    const canonicalForm = f.trim();
    const accession = accList[i];
    const filed = filedList[i];
    const primary = primaryDocs[i] || "";
    if (!accession) continue;
    rows.push({ cik, accession, filed, form: canonicalForm, primary });
    if (rows.length >= maxCount) break;
  }
  const issuerProfile = detectIssuerTypeFromSubmissions(subs);
  rows.issuerProfile = issuerProfile;
  return rows;
}

async function fetchFilingHtml({ cik, accession, primary }) {
  const accessionNoDashes = accession.replace(/-/g, "");
  const cikTrim = cik.replace(/^0+/, "");
  let mainDoc = primary;
  if (!mainDoc) {
    // Fallback name
    mainDoc = `${accession}.txt`;
  }
  const docUrl = `https://www.sec.gov/Archives/edgar/data/${cikTrim}/${accessionNoDashes}/${mainDoc}`;
  const html = await limitedFetch(docUrl, { parse: "text" });
  return { html, docUrl };
}

function isRecentDateWithinDays(dateStr, days) {
  const ts = Date.parse(dateStr || "");
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts <= Number(days) * 24 * 60 * 60 * 1000;
}

function parseForm4TransactionCounts(text) {
  const t = String(text || "");
  if (!t) return { buy: 0, sell: 0 };
  const upper = t.toUpperCase();
  // SEC "Form 4 XML" is often an HTML-ish XSL output where the transaction code cell uses SmallFormData spans.
  // Example: <span class="SmallFormData">S</span>
  const buy = (upper.match(/CLASS="SMALLFORMDATA">\s*P\s*<\/SPAN>/g) || []).length;
  const sell = (upper.match(/CLASS="SMALLFORMDATA">\s*S\s*<\/SPAN>/g) || []).length;
  return { buy, sell };
}

export async function scanFilingForGoingConcern(ticker) {
  const key = ticker.toUpperCase();
  const now = Date.now();
  const cached = goingConcernCache.get(key);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.result;
  }

  const meta = await fetchLatestFilingMeta(ticker);
  if (!meta) {
    const result = { found: false, reason: "No recent 10-Q/10-K found" };
    goingConcernCache.set(key, { fetchedAt: now, result });
    return result;
  }

  try {
    const { html, docUrl } = await fetchFilingHtml(meta);
    const text = stripTagsToText(html);
    const snippets = scanForPhrases(text);
    const result = {
      found: snippets.length > 0,
      snippets: snippets.slice(0, 5),
      docUrl,
      form: meta.form,
      filed: meta.filed,
      cik: meta.cik
    };
    goingConcernCache.set(key, { fetchedAt: now, result });
    return result;
  } catch (err) {
    const result = { found: false, error: err?.message || String(err) };
    goingConcernCache.set(key, { fetchedAt: now, result });
    return result;
  }
}

export async function getLatestFilingText(ticker, forms = DEFAULT_FORMS) {
  const meta = await fetchLatestFilingMeta(ticker, forms);
  if (!meta) return null;
  const { html, docUrl } = await fetchFilingHtml(meta);
  const text = stripTagsToText(html);
  return { ...meta, text, docUrl };
}

const SIGNAL_DEFS = [
  {
    id: "going_concern",
    score: -10,
    severity: "critical",
    title: "Going-Concern Warning",
    phrases: GOING_CONCERN_PHRASES
  },
  {
    id: "material_weakness",
    score: -8,
    severity: "critical",
    title: "Internal Control Weakness",
    phrases: [
      "material weakness in internal control",
      "material weakness in our internal control",
      "ineffective internal control",
      "controls over financial reporting were not effective",
      "not effective disclosure controls"
    ]
  },
  {
    id: "substantial_doubt",
    score: -5,
    severity: "ranking", /* High warning */
    title: "Funding Uncertainty",
    phrases: [
      "substantial doubt about our ability to continue",
      "may not have sufficient capital to fund operations",
      "may not have sufficient liquidity",
      "may not be able to fund operations for the next 12 months"
    ]
  },
  {
    id: "liquidity_shortage",
    score: -6,
    title: "Liquidity Shortage",
    phrases: [
      "insufficient capital",
      "may not have adequate liquidity",
      "we do not have enough cash to fund operations beyond",
      "cash resources are expected to be depleted"
    ]
  },
  {
    id: "needs_financing",
    score: -3,
    title: "External Financing Required",
    phrases: [
      "expect to raise additional capital",
      "will need to raise additional capital",
      "financing will be required to sustain operations",
      "may issue additional equity securities",
      "additional financing will be necessary",
      "our business depends on securing additional funding",
      "future financing may not be available",
      "our survival depends on obtaining financing",
      "we expect to raise additional capital"
    ]
  },
  {
    id: "dilution_risk",
    score: -4,
    title: "Shareholder Dilution Risk",
    phrases: [
      "we may issue additional equity securities",
      "future equity raises will dilute investors",
      "substantial dilution to existing shareholders"
    ]
  },
  {
    id: "covenant_risk",
    score: -5,
    title: "Covenant Risk",
    phrases: [
      "in breach of debt covenants",
      "in violation of covenants",
      "breach of covenants",
      "may breach covenants",
      "lender may accelerate",
      "lender may accelerate repayment",
      "default under our credit agreement",
      "may violate financial covenants"
    ]
  },
  {
    id: "debt_refinance_risk",
    score: -4,
    title: "Refinancing Pressure",
    phrases: [
      "unable to refinance existing debt",
      "debt maturities create liquidity pressure",
      "high interest burden"
    ]
  },
  {
    id: "reverse_split",
    score: -4,
    title: "Reverse Split Authorized",
    phrases: [
      "reverse split",
      "reverse stock split",
      "amend articles to effect a reverse split",
      "authorization to effect a reverse split",
      "needed to comply with listing requirements"
    ]
  },
  {
    id: "atm_or_shelf",
    score: -3,
    title: "Shelf/ATM Offering",
    phrases: [
      "at-the-market equity offering",
      "shelf registration",
      "equity distribution agreement"
    ]
  },
  {
    id: "auditor_change",
    score: -4,
    title: "Auditor Turnover",
    phrases: [
      "auditor resigned",
      "auditor withdrawal",
      "change in independent registered public accounting firm",
      "dismissed our independent auditor"
    ]
  },
  {
    id: "restatement",
    score: -8,
    title: "Restatement Warning",
    phrases: [
      "financial statements should no longer be relied upon",
      "restatement of prior period results"
    ]
  },
  {
    id: "contingent_liabilities",
    score: -3,
    title: "Contingent Liabilities",
    includeInScore: false,
    phrases: [
      "commitments and contingencies",
      "commitments & contingencies",
      "contingent liabilities",
      "environmental remediation",
      "warranty reserve",
      "material legal proceedings",
      "legal proceedings"
    ]
  },
  {
    id: "audit_opinion_issue",
    score: -6,
    title: "Audit Opinion Issue",
    phrases: [
      "audit opinion includes an adverse opinion",
      "disagreement with auditor",
      "audit committee raised concerns"
    ]
  },
  {
    id: "restructuring",
    score: -2,
    title: "Restructuring Activity",
    phrases: [
      "restructuring charges",
      "restructuring expense",
      "employee reductions",
      "workforce reduction",
      "severance costs"
    ]
  },
  {
    id: "demand_decline",
    score: -3,
    title: "Demand Decline",
    phrases: [
      "decline in demand",
      "soft market conditions",
      "reduced customer orders",
      "deceleration in revenue growth",
      "slowing growth",
      "growth moderated",
      "lower than expected demand",
      "customer churn increased",
      "user growth slowed",
      "engagement declined",
      "retention rates declined",
      "average revenue per user declined",
      "arpu declined"
    ]
  },
  {
    id: "supply_chain",
    score: -3,
    title: "Supply Chain Disruption",
    phrases: [
      "supply chain disruptions",
      "component shortages",
      "inability to source materials"
    ]
  },
  {
    id: "inventory_problem",
    score: -3,
    title: "Inventory Problems",
    phrases: [
      "inventory obsolescence",
      "excess inventory",
      "write-downs"
    ]
  },
  {
    id: "reg_investigation",
    score: -5,
    title: "Regulatory Investigation",
    phrases: [
      "under investigation by",
      "received a subpoena",
      "regulatory inquiry",
      "doj/ftc/sec investigation",
      "sec inquiry",
      "doj investigation",
      "ftc investigation",
      "antitrust investigation",
      "competition authority",
      "privacy breach",
      "data breach",
      "cybersecurity incident",
      "unauthorized access"
    ]
  },
  {
    id: "litigation_risk",
    score: -4,
    title: "Litigation Risk",
    phrases: [
      "class action lawsuit",
      "material litigation",
      "significant legal exposure",
      "pending litigation could materially affect results",
      "shareholder lawsuit",
      "derivative action",
      "securities fraud",
      "patent infringement claim",
      "breach of contract",
      "indemnification claim",
      "settlement discussions ongoing",
      "reserve for litigation"
    ]
  },
  {
    id: "compliance_penalty",
    score: -3,
    title: "Compliance Risk",
    phrases: [
      "non-compliance could result in penalties",
      "violation of regulations"
    ]
  },
  {
    id: "customer_concentration",
    score: -3,
    title: "Customer Concentration Risk",
    phrases: [
      "customer a accounted for",
      "loss of a major customer would be material"
    ]
  },
  {
    id: "supplier_dependence",
    score: -3,
    title: "Supplier Dependence",
    phrases: [
      "single-source supplier risk",
      "dependence on one supplier"
    ]
  },
  {
    id: "market_shrinkage",
    score: -3,
    title: "Market Shrinkage",
    phrases: [
      "market size declining",
      "industry contraction"
    ]
  },
  {
    id: "spinoff_separation",
    score: 0,
    severity: "info",
    title: "Spin-off / Separation",
    phrases: [
      "spin-off",
      "spinoff",
      "split-off",
      "carve-out",
      "carve out",
      "demerger",
      "demerged",
      "separation and distribution",
      "separation of the company",
      "separation transaction",
      "separated from",
      "separated into",
      "newly formed company",
      "distribution of shares",
      "exchange offer",
      "contributed to the newly formed",
      "kenvue"
    ]
  },
  {
    id: "clinical_failure",
    score: -6,
    title: "Clinical Failure",
    phrases: [
      "trial did not meet primary endpoint",
      "failure to achieve statistical significance"
    ]
  },
  {
    id: "regulatory_setback",
    score: -6,
    title: "Regulatory Setback",
    phrases: [
      "fda placed a clinical hold",
      "complete response letter (crl)",
      "additional data required for approval",
      "fda asked for additional data"
    ]
  },
  {
    id: "biotech_cash_dependency",
    score: -5,
    title: "Funding Needed for Trials",
    phrases: [
      "substantial doubt... funding trials",
      "funding trials depends on raising capital"
    ]
  },
  {
    id: "clinical_negative",
    score: -12,
    title: "Clinical Failure",
    phrases: [
      "did not meet primary endpoint",
      "did not meet its primary endpoint",
      "did not meet the primary endpoint",
      "failed to meet primary endpoint",
      "failed to meet the primary endpoint",
      "failed to meet its primary endpoint",
      "failed to achieve significance",
      "failed to achieve statistical significance",
      "trial failed",
      "trial paused",
      "trial terminated",
      "trial discontinued",
      // Phrase family: Safety Failure
      "dose-limiting toxicity",
      "serious adverse reaction",
      "fda placed a clinical hold",
      "received a complete response letter",
      "complete response letter (crl)",
      "clinical hold"
    ]
  },
  {
    id: "clinical_positive",
    score: 10,
    severity: "info",
    title: "Clinical Pipeline Quality",
    phrases: [
      "met primary endpoint",
      "achieved statistical significance",
      "trial success",
      "positive topline results",
      "robust safety profile",
      "well-tolerated",
      "well tolerated",
      "pdufa date scheduled",
      "pdufa date set",
      "phase 2 readout",
      "phase 3 enrollment complete"
    ]
  },
  {
    id: "safety_bad",
    score: -6,
    title: "Safety Concerns",
    phrases: [
      "severe adverse events",
      "saes",
      "grade 3 toxicity",
      "grade 4 toxicity",
      "dose reduction required"
    ]
  },
  {
    id: "safety_good",
    score: 4,
    title: "Favorable Safety",
    phrases: [
      "well tolerated",
      "well-tolerated",
      "no dose-limiting toxicities",
      "no dose limiting toxicities"
    ]
  },
  {
    id: "regulatory_positive",
    score: 6,
    title: "Regulatory Tailwind",
    phrases: [
      "fast track designation granted",
      "breakthrough therapy designation",
      "priority review",
      "successful type a meeting",
      "successful type b meeting",
      "successful type c meeting",
      "fast track",
      "breakthrough therapy",
      "priority review granted"
    ]
  },
  {
    id: "regulatory_negative",
    score: -8,
    title: "Regulatory Risk",
    phrases: [
      "fda clinical hold",
      "crl issued",
      "additional trials required",
      "manufacturing issues",
      "manufacturing deficiencies"
    ]
  },
  {
    id: "catalyst_upcoming",
    score: 3,
    title: "Upcoming Catalyst",
    phrases: [
      "pdufa date",
      "nda submission planned",
      "phase 2 readout",
      "phase 3 readout",
      "phase 3 enrollment complete",
      "topline data expected",
      "data readout",
      "catalyst"
    ]
  },
  {
    id: "moa_strength",
    score: 3,
    title: "Mechanism Strength",
    phrases: [
      "first-in-class",
      "best-in-class",
      "novel mechanism of action",
      "addressing unmet medical need"
    ]
  },
  {
    id: "moa_weak",
    score: -3,
    title: "Competitive Pressure",
    phrases: [
      "crowded space",
      "generic competition",
      "biosimilar threat",
      "market dominated by",
      "increased competition",
      "competitive pressure",
      "pricing pressure",
      "compressed margins",
      "new entrants",
      "disruption from",
      "market share loss",
      "losing market share",
      "aggressive pricing by competitors",
      "intensifying competition"
    ]
  },
  {
    id: "trial_execution_risk",
    score: -3,
    title: "Trial Execution Risk",
    phrases: [
      "slow enrollment",
      "trial delays",
      "enrollment delays",
      "supply issues for investigational product",
      "supply issues for study drug"
    ]
  },
  {
    id: "non_dilutive_finance",
    score: 4,
    title: "Non-Dilutive Funding",
    phrases: [
      "non-dilutive financing",
      "grant funding",
      "barda",
      "nih grant"
    ]
  },
  {
    id: "leadership_turnover",
    score: -3,
    title: "Leadership Turnover",
    phrases: [
      "ceo resigned",
      "cfo departure",
      "executive turnover",
      "chief executive officer resigned",
      "chief financial officer resigned",
      "chief operating officer resigned",
      "president resigned",
      "board member resigned",
      "departure of executive",
      "transition in leadership",
      "search for new ceo",
      "interim ceo",
      "acting cfo"
    ]
  },
  {
    id: "board_conflict",
    score: -3,
    title: "Board/Governance Conflict",
    phrases: [
      "board investigation",
      "governance concerns"
    ]
  },
  {
    id: "macro_sensitivity",
    score: -2,
    title: "Macro Sensitivity",
    phrases: [
      "sensitive to interest rates",
      "limited pricing power",
      "foreign currency headwinds"
    ]
  },
  // Positive / supportive signals
  {
    id: "buyback_authorized",
    score: 3,
    title: "Buyback Increased",
    phrases: [
      "share repurchase authorization increased",
      "repurchase program increased",
      "expanded share repurchase program",
      "repurchased shares",
      "repurchased common stock"
    ]
  },
  {
    id: "dividend_raised",
    score: 3,
    title: "Dividend Raised",
    phrases: [
      "dividend increased",
      "raised our dividend",
      "increase our dividend",
      "quarterly dividend of",
      "initiating a dividend"
    ]
  },
  {
    id: "long_term_contract",
    score: 2,
    title: "Long-Term Contract Signed",
    phrases: [
      "long-term contract",
      "multi-year contract",
      "multi year contract",
      "long-term agreement",
      "multi-year agreement",
      "backlog reached",
      "award of multi-year contract"
    ]
  },
  {
    id: "backlog_record",
    score: 3,
    title: "Record Backlog",
    phrases: [
      "record backlog",
      "backlog at record",
      "highest backlog",
      "order book strong"
    ]
  },
  {
    id: "credit_upgrade",
    score: 4,
    title: "Credit Upgraded",
    phrases: [
      "credit rating upgraded",
      "outlook raised to",
      "rating upgraded"
    ]
  },
  {
    id: "debt_refinance",
    score: 2,
    title: "Debt Refinanced",
    phrases: [
      "refinanced at lower rate",
      "refinanced our debt",
      "reprice our term loan",
      "reprice our credit facility",
      "refinanced debt at lower rates",
      "extended maturities"
    ]
  },
  {
    id: "material_weakness_remediated",
    score: 4,
    title: "Controls Remediated",
    phrases: [
      "material weakness has been remediated",
      "remediated the material weakness",
      "remediation of material weakness",
      "material weaknesses have been remediated"
    ]
  },
  {
    id: "auditor_clean",
    score: 2,
    title: "Auditor Clean Opinion",
    phrases: [
      "no issues noted by auditor",
      "unqualified opinion",
      "clean opinion",
      "no material weaknesses identified"
    ]
  },
  {
    id: "ai_disruption_risk",
    score: -4,
    title: "AI Disruption Risk",
    phrases: [
      "ai may disrupt our business",
      "artificial intelligence competition",
      "generative ai",
      "ai models may reduce demand",
      "competitors using ai",
      "ai-powered alternatives",
      "machine learning competition",
      "automation of our services"
    ]
  },
  {
    id: "guidance_cut",
    score: -6,
    title: "Guidance Cut",
    phrases: [
      "lowered guidance",
      "reduced guidance",
      "guidance below expectations",
      "revised guidance downward",
      "expect lower revenue",
      "expect lower earnings",
      "below our prior guidance",
      "no longer expect to achieve"
    ]
  }
];

export async function scanFilingForSignals(ticker, opts = {}) {
  const key = ticker.toUpperCase();
  const now = Date.now();
  const cached = filingSignalCache.get(key);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.result;
  }

  const diskCached = loadCachedFilingSignals(key, now);
  const requestedMax = Number.isFinite(Number(opts?.maxFilings))
    ? Number(opts.maxFilings)
    : (opts?.deep ? MAX_RECENT_FILINGS_DEEP : MAX_RECENT_FILINGS_DEFAULT);

  if (diskCached) {
    const cachedMax = diskCached.maxFilings || 0;
    // If we need a deep scan but cache is shallow, bypass cache and re-scan.
    if (requestedMax <= cachedMax) {
      filingSignalCache.set(key, { fetchedAt: now, result: diskCached });
      return diskCached;
    }
  }

  if (!EDGAR_FILING_SIGNALS_ENABLED) {
    return { signals: [], meta: null, cachedAt: null };
  }

  const maxFilingsRaw = opts?.maxFilings ?? null;
  const maxFilings = Number.isFinite(Number(maxFilingsRaw))
    ? Math.max(1, Math.min(25, Number(maxFilingsRaw)))
    : (opts?.deep ? MAX_RECENT_FILINGS_DEEP : MAX_RECENT_FILINGS_DEFAULT);
  const deep = opts?.deep === true;

  const metas = await fetchRecentFilingsMeta(ticker, DEFAULT_FORMS, maxFilings, opts);
  const issuerProfile = metas?.issuerProfile;
  console.log('[filingTextScanner] scanFilingForSignals', key, {
    metasCount: metas?.length || 0,
    issuerType: issuerProfile?.issuerType || 'unknown',
    deep,
    maxFilings
  });
  if (!metas || metas.length === 0) {
    console.log('[filingTextScanner] no metas found for', key);
    return {
      signals: [],
      meta: issuerProfile ? { issuerType: issuerProfile.issuerType, filingProfile: issuerProfile.filingProfile } : null
    };
  }

  const dedupedSignals = new Map();
  const signalCounts = new Map(); // Track how many filings have this signal
  let latestMeta = metas[0] || null;

  for (const meta of metas) {
    // Yield to keep the event loop responsive during heavy text processing
    await new Promise(resolve => setImmediate(resolve));
    try {
      const { html, docUrl } = await fetchFilingHtml(meta);
      const text = stripTagsToText(html);
      const lower = text.toLowerCase();
      for (const def of SIGNAL_DEFS) {
        let foundSnippet = null;
        let foundIdx = -1;

        // Scan phrases to find first VALID occurrence (not suppressed)
        phraseLoop: for (const phrase of def.phrases) {
          const phraseLower = phrase.toLowerCase();
          let pos = 0;
          while (true) {
            const idx = lower.indexOf(phraseLower, pos);
            if (idx === -1) break;

            const start = Math.max(0, idx - 160);
            const end = Math.min(text.length, idx + 160);
            const snippet = text.slice(start, end);

            // Check suppression for this specific occurrence
            if (!shouldSuppressFlag(text, idx, snippet)) {
              foundSnippet = snippet;
              foundIdx = idx;
              break phraseLoop; // Found valid signal for this definition
            }

            // If suppressed, keep searching strictly after this occurrence
            pos = idx + phraseLower.length;
          }
        }

        if (foundSnippet) {
          // Track counts for threshold logic (Foreign GC check)
          const id = def.id;
          if (!signalCounts.has(id)) signalCounts.set(id, 0);
          signalCounts.set(id, signalCounts.get(id) + 1);

          const existing = dedupedSignals.get(def.id);
          // Keep the strongest (by abs score), otherwise prefer latest filing (first in list).
          // Since we process files latest-first, the first time we see a signal ID it is from the latest filing.
          // We only overwrite if a subsequent (older) filing has a strictly stronger score (abs value).
          // Actually, if scores are same, we prefer existing (latest).
          if (!existing || Math.abs(def.score) > Math.abs(existing.score)) {
            dedupedSignals.set(def.id, {
              id: def.id,
              title: def.title,
              score: def.score,
              includeInScore: def.includeInScore,
              snippet: foundSnippet,
              form: meta.form,
              filed: meta.filed,
              docUrl,
              accession: meta.accession,
              cik: meta.cik
            });
          }
        }
      }
    } catch (err) {
      console.warn("[filingTextScanner] failed to scan filing", meta?.form, meta?.accession, err?.message || err);
      continue;
    }
  }

  // Post-Processing: Foreign issuers often include boilerplate "going concern" language; suppress entirely.
  const isForeign = issuerProfile?.issuerType === "foreign";
  if (isForeign) {
    dedupedSignals.delete("going_concern");
  }

  // ========== Signal Conflict Resolution ==========
  // When both a negative signal and its positive counterpart are detected,
  // suppress the positive one. Better to flag risk than to assume resolution.
  for (const [negativeId, positiveIdToSuppress] of Object.entries(SIGNAL_CONFLICTS)) {
    if (dedupedSignals.has(negativeId) && dedupedSignals.has(positiveIdToSuppress)) {
      console.log(`[filingTextScanner] suppressing conflicting signal: ${positiveIdToSuppress} (due to ${negativeId})`);
      dedupedSignals.delete(positiveIdToSuppress);
    }
  }

  let signals = Array.from(dedupedSignals.values());

  // If no new signals but we have cached historical ones, keep them.
  if ((!signals || signals.length === 0) && diskCached?.signals?.length) {
    const profileMeta = issuerProfile
      ? { issuerType: issuerProfile.issuerType, filingProfile: issuerProfile.filingProfile }
      : {};
    const result = {
      signals: diskCached.signals,
      meta: {
        ...(diskCached.meta || {}),
        ...profileMeta,
        reused: true,
        note: "No new flags detected; showing prior risks."
      },
      cachedAt: diskCached.cachedAt || new Date().toISOString()
    };
    filingSignalCache.set(key, { fetchedAt: now, result });
    return result;
  }

  // ========== Derived Filing Intelligence (non-phrase based) ==========
  // These add extra network requests; keep them for deep scans only.
  if (!deep) {
    const result = {
      signals,
      meta: issuerProfile ? { issuerType: issuerProfile.issuerType, filingProfile: issuerProfile.filingProfile } : null,
      cachedAt: new Date().toISOString()
    };
    persistFilingSignals(key, result);
    filingSignalCache.set(key, { fetchedAt: now, result });
    return result;
  }

  // 1) Restatement history via amendment forms (10-K/A, 10-Q/A)
  try {
    const amendMetas = await fetchRecentFilingsMeta(ticker, ["10-K/A", "10-Q/A"], 2, opts);
    const amendment = (amendMetas || []).find((m) => isRecentDateWithinDays(m?.filed, 365 * 3));
    if (amendment) {
      dedupedSignals.set("restatement_history", {
        id: "restatement_history",
        title: "Amended Filing History",
        score: -6,
        includeInScore: false,
        snippet: `${amendment.form} filed ${amendment.filed} (amendment filing; can indicate corrections/restatement or administrative updates).`,
        form: amendment.form,
        filed: amendment.filed,
        docUrl: `https://www.sec.gov/Archives/edgar/data/${String(amendment.cik || "").replace(/^0+/, "")}/${String(amendment.accession || "").replace(/-/g, "")}/${amendment.primary || ""}`,
        accession: amendment.accession,
        cik: amendment.cik
      });
    }
  } catch (err) {
    // Non-critical
  }

  // 2) Insider trading pattern via recent Form 4 filings (best-effort)
  try {
    const form4Metas = await fetchRecentFilingsMeta(ticker, INSIDER_FORMS, 12, opts);
    const recentForm4 = (form4Metas || []).filter((m) => isRecentDateWithinDays(m?.filed, 180));
    if (recentForm4.length >= 2) {
      let buys = 0;
      let sells = 0;
      const sample = recentForm4.slice(0, 8);
      for (const meta of sample) {
        try {
          const { html } = await fetchFilingHtml(meta);
          const counts = parseForm4TransactionCounts(html);
          buys += counts.buy;
          sells += counts.sell;
        } catch (_) {
          // Ignore individual failures
        }
      }
      if (buys || sells) {
        // Prefer insider buying as a stronger signal than selling (selling is often planned/comp-driven).
        // Weight sells at half-strength so mixed activity doesn't net to zero too easily.
        const netSignal = buys - sells * 0.5;
        const clustered = recentForm4.length >= 3;
        // Keep the signal directionally useful, but avoid over-weighting (Form 4 code noise is common).
        const score =
          netSignal >= 2
            ? 4
            : netSignal >= 1
              ? 2
              : netSignal <= -2
                ? -2
                : 0;
        const title = "Insider Trading Pattern";
        const snippet = `Recent Form 4 activity: ${buys} buy-coded vs ${sells} sell-coded transactions (${recentForm4.length} filings / 180d).`;
        // Build a link to the most recent Form 4 filing
        const latestForm4 = recentForm4[0];
        const form4DocUrl = latestForm4?.cik && latestForm4?.accession
          ? `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${String(latestForm4.cik).replace(/^0+/, '')}&type=4&dateb=&owner=include&count=40`
          : null;
        dedupedSignals.set("insider_trading_pattern", {
          id: "insider_trading_pattern",
          title,
          score,
          includeInScore: false,
          snippet,
          form: "4",
          filed: latestForm4?.filed || null,
          docUrl: form4DocUrl,
          accession: latestForm4?.accession || null,
          cik: latestForm4?.cik || null
        });
      }
    }
  } catch (err) {
    // Non-critical; only enriches UI cards.
  }

  signals = Array.from(dedupedSignals.values());

  const result = {
    signals,
    maxFilings, // Save the depth of this scan
    cachedAt: now,
    meta: {
      latestForm: latestMeta?.form || null,
      latestFiled: latestMeta?.filed || null,
      latestAccession: latestMeta?.accession || null,
      latestDocUrl: signals.find((s) => s.form === latestMeta?.form && s.filed === latestMeta?.filed)?.docUrl || null,
      issuerType: issuerProfile?.issuerType || "domestic",
      filingProfile: issuerProfile?.filingProfile || { annual: "10-K", interim: "10-Q", current: "8-K" }
    },
    cachedAt: new Date().toISOString()
  };
  console.log('[filingTextScanner] scan complete', key, {
    signalsCount: signals.length,
    signalIds: signals.map(s => s.id).join(',') || 'none'
  });
  persistFilingSignals(key, result);
  filingSignalCache.set(key, { fetchedAt: now, result });
  return result;
}

export { fetchRecentFilingsMeta };
