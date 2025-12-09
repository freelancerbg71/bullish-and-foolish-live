import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { limitedFetch, lookupCompanyByTicker, normalizeEdgarCik, SEC_BASE } from "./edgarFundamentals.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const EDGAR_DIR = path.join(ROOT, "data", "edgar");

const DEFAULT_FORMS = ["10-Q", "10-K", "8-K", "DEF 14A", "DEF14A"];
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const goingConcernCache = new Map();
const filingSignalCache = new Map();
const MAX_RECENT_FILINGS = 10;
const PRIMARY_FORMS = new Set(["10-Q", "10-K"]);
const BOILERPLATE_SECTION_TOKENS = [
  "risk factors",
  "forward-looking statements",
  "cautionary statements",
  "cautionary note",
  "general legal",
  "legal proceedings",
  "liquidity risks may include",
  "cautionary note regarding",
  "cautionary statement regarding"
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

function stripTagsToText(html) {
  if (!html) return "";
  const withoutTags = html.replace(/<[^>]+>/g, " ");
  return withoutTags.replace(/\s+/g, " ").trim();
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

function contextWindow(text, idx, radius = 320) {
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

  // IOVA Fix: Suppress "clinical failure" or "hold" if referring to stale years
  // e.g. "On December 22, 2023..."
  // Check 'ctx' (wider context) because the year might be 50 chars back and not in the tight snippet
  if (STALE_YEARS.some(year => ctx.includes(year))) {
    return true;
  }

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
    if (!signals || !signals.length) return null;
    const cachedAt = cachedAtStr ? Date.parse(cachedAtStr) : null;
    const isFresh = cachedAt == null || !Number.isFinite(cachedAt) || now - cachedAt <= CACHE_TTL_MS;
    const matchesLatestFiling =
      metaFiled && latestFiledInPeriods && metaFiled === latestFiledInPeriods;
    if (!isFresh && !matchesLatestFiling) return null;
    return {
      signals,
      meta,
      cachedAt: cachedAtStr || null
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
      (!payload?.signals || payload.signals.length === 0) && Array.isArray(existing?.filingSignals);
    const merged = {
      ...existing,
      filingSignals: keepExistingSignals
        ? existing.filingSignals
        : Array.isArray(payload?.signals)
          ? payload.signals
          : [],
      filingSignalsMeta: payload?.meta ?? (keepExistingSignals ? existing.filingSignalsMeta : null) ?? null,
      filingSignalsCachedAt:
        payload?.cachedAt ?? (keepExistingSignals ? existing.filingSignalsCachedAt : null) ?? new Date().toISOString()
    };
    fs.writeFileSync(file, JSON.stringify(merged));
  } catch (err) {
    console.warn("[filingTextScanner] failed to persist filing signals cache", ticker, err?.message || err);
  }
}

export async function fetchLatestFilingMeta(ticker, forms = DEFAULT_FORMS) {
  const company = await lookupCompanyByTicker(ticker);
  const cik = normalizeEdgarCik(company?.cik);
  if (!cik) throw new Error("CIK not found for ticker");

  const submissionsUrl = `${SEC_BASE}/submissions/CIK${cik}.json`;
  const subs = await limitedFetch(submissionsUrl, { parse: "json" });
  const recent = subs?.filings?.recent;
  const formList = recent?.form || [];
  const accList = recent?.accessionNumber || [];
  const filedList = recent?.filingDate || [];
  const primaryDocs = recent?.primaryDocument || [];

  for (let i = 0; i < formList.length; i += 1) {
    const f = (formList[i] || "").toUpperCase();
    if (!forms.includes(f)) continue;
    const accession = accList[i];
    const filed = filedList[i];
    const primary = primaryDocs[i] || "";
    if (!accession) continue;
    return { cik, accession, filed, form: f, primary };
  }

  return null;
}

async function fetchRecentFilingsMeta(ticker, forms = DEFAULT_FORMS, maxCount = MAX_RECENT_FILINGS) {
  const company = await lookupCompanyByTicker(ticker);
  const cik = normalizeEdgarCik(company?.cik);
  if (!cik) throw new Error("CIK not found for ticker");
  const submissionsUrl = `${SEC_BASE}/submissions/CIK${cik}.json`;
  const subs = await limitedFetch(submissionsUrl, { parse: "json" });
  const recent = subs?.filings?.recent;
  const formList = recent?.form || [];
  const accList = recent?.accessionNumber || [];
  const filedList = recent?.filingDate || [];
  const primaryDocs = recent?.primaryDocument || [];
  const rows = [];
  for (let i = 0; i < formList.length; i += 1) {
    const f = (formList[i] || "").toUpperCase();
    if (!forms.includes(f)) continue;
    const accession = accList[i];
    const filed = filedList[i];
    const primary = primaryDocs[i] || "";
    if (!accession) continue;
    rows.push({ cik, accession, filed, form: f, primary });
    if (rows.length >= maxCount) break;
  }
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
      "reduced customer orders"
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
      "doj/ftc/sec investigation"
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
      "pending litigation could materially affect results"
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
    title: "Crowded Mechanism",
    phrases: [
      "crowded space",
      "generic competition",
      "biosimilar threat",
      "market dominated by"
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
      "executive turnover"
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
  }
];

export async function scanFilingForSignals(ticker) {
  const key = ticker.toUpperCase();
  const now = Date.now();
  const cached = filingSignalCache.get(key);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.result;
  }

  const diskCached = loadCachedFilingSignals(key, now);
  if (diskCached) {
    filingSignalCache.set(key, { fetchedAt: now, result: diskCached });
    return diskCached;
  }

  const metas = await fetchRecentFilingsMeta(ticker, DEFAULT_FORMS, MAX_RECENT_FILINGS);
  if (!metas || metas.length === 0) return { signals: [], meta: null };

  const dedupedSignals = new Map();
  let latestMeta = metas[0] || null;

  for (const meta of metas) {
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

  let signals = Array.from(dedupedSignals.values());

  // If no new signals but we have cached historical ones, keep them.
  if ((!signals || signals.length === 0) && diskCached?.signals?.length) {
    const result = {
      signals: diskCached.signals,
      meta: { ...(diskCached.meta || {}), reused: true, note: "No new flags detected; showing prior risks." },
      cachedAt: diskCached.cachedAt || new Date().toISOString()
    };
    filingSignalCache.set(key, { fetchedAt: now, result });
    return result;
  }

  const result = {
    signals,
    meta: {
      latestForm: latestMeta?.form || null,
      latestFiled: latestMeta?.filed || null,
      latestAccession: latestMeta?.accession || null,
      latestDocUrl: signals.find((s) => s.form === latestMeta?.form && s.filed === latestMeta?.filed)?.docUrl || null
    },
    cachedAt: new Date().toISOString()
  };
  persistFilingSignals(key, result);
  filingSignalCache.set(key, { fetchedAt: now, result });
  return result;
}

export { fetchRecentFilingsMeta };
