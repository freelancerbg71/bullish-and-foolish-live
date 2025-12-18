
import { ruleExplainers, percentToNumber, resolveSectorBucket } from "./shared-rules.js";
const API_ROOT = window.API_ROOT || localStorage.getItem("apiRoot") || "/api";
const API_BASE = `${API_ROOT}/ticker`;
const RATE_LIMIT_MESSAGE = "You hit the request limit. Please wait a few seconds and try again.";
const ticker = new URLSearchParams(location.search).get("ticker")?.toUpperCase();
const statusEl = document.getElementById("status");
const CACHE_ONLY = false; // allow backend proxy calls; set true for offline cache-only runs
// Cache controls: keep bundles briefly but avoid stale VMs after code changes
const CACHE_VERSION = "2025-12-09-v2";
const CACHE_MAX_AGE_DAYS = 2;
const VM_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // align with server TTL for fundamentals
const USE_VM_CACHE = false; // Disable aggressive client caching; rely on server cache
if (!ticker) { statusEl.textContent = "No ticker provided."; throw new Error("No ticker"); }
document.getElementById("title").textContent = ticker;
const EDGAR_SNAPSHOT_BASE = `${API_ROOT}/edgar-facts?ticker=${encodeURIComponent(ticker)}&mode=snapshot`;
const compareBtn = document.getElementById("compareBtn");
if (compareBtn) {
  compareBtn.style.display = "none"; // hide compare in initial rollout
}
const manualPriceKey = `manual-price-${ticker}`;
const manualPriceInput = document.getElementById("manualPriceInput");
const manualPriceApply = document.getElementById("manualPriceApply");
const manualPriceClear = document.getElementById("manualPriceClear");
const manualPriceNote = document.getElementById("manualPriceNote");
const manualPriceModal = document.getElementById("manualPriceModal");
const manualPriceClose = document.getElementById("manualPriceClose");
const missingTickerModal = document.getElementById("missingTickerModal");
const missingTickerMessage = document.getElementById("missingTickerMessage");
const missingTickerBack = document.getElementById("missingTickerBack");
const missingTickerDismiss = document.getElementById("missingTickerDismiss");
const missingTickerClose = document.getElementById("missingTickerClose");
// Wire donation modal trigger if present (shared with about/support modal)
const supportLink = document.querySelector(".rating-meta a[href*='about.html#support']");
if (supportLink) {
  supportLink.addEventListener("click", (e) => {
    // If a modal exists on the page, use it; otherwise allow navigation
    const modal = document.getElementById("supportModal");
    const donateBtn = document.getElementById("donateBtn");
    const supportClose = document.getElementById("supportClose");
    const laterBtn = document.getElementById("laterBtn");
    if (modal && donateBtn) {
      e.preventDefault();
      modal.style.display = "flex";
      const closeModal = () => { modal.style.display = "none"; };
      if (supportClose) supportClose.onclick = closeModal;
      if (laterBtn) laterBtn.onclick = closeModal;
      modal.onclick = (evt) => { if (evt.target === modal) closeModal(); };
      window.addEventListener("keydown", function escClose(evt) { if (evt.key === "Escape") { closeModal(); window.removeEventListener("keydown", escClose); } });
      donateBtn.onclick = () => window.open("http://revolut.me/viktorc8gv", "_blank");
    }
  });
}
ensurePriceElements();
initManualPriceUi();
const lastPriceEl = document.getElementById("lastPrice");
const providerSelect = document.getElementById("providerSelect");
const goBtn = document.getElementById("goBtn");
const rangeSwitch = document.getElementById("rangeSwitch");
const tableToggles = Array.from(document.querySelectorAll(".table-toggle"));
const edgarNotesEl = document.getElementById("edgarNotes");
function cacheKey(kind) { const day = new Date().toISOString().slice(0, 10); return `edgar-${kind}-${ticker}-${day}`; }
function latestKey(kind) { return `edgar-${kind}-${ticker}-latest`; }
const EXCLUDED_FILING_REASON_IDS = new Set(["going_concern", "reverse_split"]);

const isBiotechSector = (val) => {
  const bucket = resolveSectorBucket(val || "");
  const normalized = String(bucket || "").toLowerCase();
  return normalized.startsWith("biotech");
};

let selectedProvider = "edgar";
let edgarFundamentals = null;
let edgarNotes = [];
let filingSignals = [];
let priceSeriesFull = [];
let priceSeriesLight = [];
let chartPoints = [];
let selectedRange = "all";
let currentVm = null;
let priceAsOfDate = null;
let fundamentalsAsOfDate = null;
let lastFilingDate = null;
let lastPillars = null;
let lastStockForTakeaway = null;
const loadingOverlay = document.getElementById("loadingOverlay");
const varTextMuted = "rgba(159,179,200,0.9)";
const loadingText = loadingOverlay ? loadingOverlay.querySelector("div:nth-child(2)") : null;
const todayIso = () => new Date().toISOString().slice(0, 10);
let manualModalShown = false;
// Leave audit logs in code, but keep them off by default (enable manually when debugging).
const ENABLE_AUDIT_DUMP = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function showLoadingOverlay(text = "Loading...") {
  if (loadingOverlay) {
    loadingOverlay.classList.remove("hidden");
    if (loadingText) loadingText.textContent = text;
  }
}

function hideLoadingOverlay() {
  if (loadingOverlay) loadingOverlay.classList.add("hidden");
}

function readManualPrice() {
  try {
    const raw = localStorage.getItem(manualPriceKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const price = Number(parsed?.price);
    if (!Number.isFinite(price)) return null;
    const date = parsed?.date || todayIso();
    return { price, date };
  } catch (_) {
    return null;
  }
}

function saveManualPrice(price, date) {
  const payload = { price: Number(price), date: date || todayIso() };
  localStorage.setItem(manualPriceKey, JSON.stringify(payload));
  if (manualPriceNote && Number.isFinite(payload.price)) {
    manualPriceNote.textContent = `Using manual price $${payload.price.toFixed(2)} (${payload.date}).`;
  }
}

function showMissingTickerModal(msg) {
  hideLoadingOverlay();
  if (missingTickerMessage && msg) missingTickerMessage.textContent = msg;
  if (missingTickerModal) missingTickerModal.style.display = "flex";
}

function closeMissingTickerModal() {
  if (missingTickerModal) missingTickerModal.style.display = "none";
}

function clearManualPrice() {
  localStorage.removeItem(manualPriceKey);
  if (manualPriceNote) manualPriceNote.textContent = "";
  if (manualPriceInput) manualPriceInput.value = "";
}

function uniqueRiskFactors(vm) {
  const suppressedReasons = new Set([
    "operating margin",
    "operating margin (health)",
    "operating margin (industrial)",
    "interest coverage"
  ]);
  const reasonList = Array.isArray(vm?.ratingReasons)
    ? vm.ratingReasons
      .filter((r) => r && r.score < 0 && !r.missing && !r.notApplicable) // Show all negatives, not just <= -5
      .filter((r) => !suppressedReasons.has(String(r?.name || "").toLowerCase()))
      .sort((a, b) => (a.score || 0) - (b.score || 0)) // Ascending (most negative first)
    : [];

  // Take top 6 risks (most negative)
  const topRisks = reasonList.slice(0, 6).map((r) => r.message ? `${r.name}: ${r.message}` : r.name);

  const list = topRisks.length
    ? topRisks
    : Array.isArray(vm?.riskFactors)
      ? vm.riskFactors.filter(Boolean)
      : [];

  const narrative = (vm?.narrative || "").trim().toLowerCase();
  const seen = new Set();
  const deduped = [];
  list.forEach((item) => {
    const key = String(item).trim().toLowerCase();
    if (!key) return;
    // Dedup against narrative (exact or substring match)
    if (narrative && (key === narrative || narrative.includes(key) || key.includes(narrative))) return;
    if (seen.has(key)) return;
    seen.add(key);
    deduped.push(item);
  });
  return deduped;
}

function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function applyManualPriceToVm(vm) {
  const manual = readManualPrice();
  if (!manual || !vm) return vm;
  const priceSummary = {
    lastClose: manual.price,
    lastCloseDate: manual.date,
    prevClose: null,
    dayChangeAbs: null,
    dayChangePct: null,
    high52w: null,
    low52w: null
  };
  const priceHistory = [{ date: manual.date, close: manual.price }];
  if (manualPriceNote) manualPriceNote.textContent = `Using manual price $${manual.price.toFixed(2)} (${manual.date}).`;
  return { ...vm, priceSummary, priceHistory, pricePending: false };
}

function initManualPriceUi() {
  const manual = readManualPrice();
  if (manualPriceInput && manual?.price != null) {
    manualPriceInput.value = manual.price;
  }
  if (manual && manualPriceNote) {
    manualPriceNote.textContent = `Using manual price $${manual.price.toFixed(2)} (${manual.date}).`;
  }
}

function openManualPriceModal(message) {
  // Disabled: we auto-fetch price and avoid blocking UX with a modal.
  if (manualPriceNote && message) manualPriceNote.textContent = message;
  manualModalShown = false;
}

function closeManualPriceModal() {
  if (manualPriceModal) manualPriceModal.style.display = "none";
  manualModalShown = false;
}

async function fetchEdgarSnapshot({ cacheBust = false } = {}) {
  const url = cacheBust ? `${EDGAR_SNAPSHOT_BASE}&_ts=${Date.now()}` : EDGAR_SNAPSHOT_BASE;
  const res = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!res.ok) {
    const err = new Error(`EDGAR snapshot failed ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function ensureEdgarFundamentalsReady() {
  const cached = localStorage.getItem(latestKey("edgar-snapshot"));
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      const hasFilingSignals =
        Array.isArray(parsed?.filingSignals) && (parsed?.filingSignalsMeta || parsed?.filingSignalsCachedAt);
      if (parsed?.data) edgarFundamentals = parsed.data;
      if (parsed?.notes) edgarNotes = parsed.notes;
      if (hasFilingSignals) filingSignals = parsed.filingSignals;
      renderFilingSignals(hasFilingSignals ? filingSignals : []);
    } catch (_) { }
  }
  try {
    const payload = await fetchEdgarSnapshot();
    edgarNotes = Array.isArray(payload?.notes) ? payload.notes : [];
    filingSignals = Array.isArray(payload?.filingSignals?.signals) ? payload.filingSignals.signals : [];
    const filingSignalsMeta = payload?.filingSignals?.meta || null;
    const filingSignalsCachedAt = payload?.filingSignals?.cachedAt || null;
    const toCache = {
      data: payload?.data || null,
      notes: edgarNotes,
      filingSignals,
      filingSignalsMeta,
      filingSignalsCachedAt
    };
    try {
      localStorage.setItem(latestKey("edgar-snapshot"), JSON.stringify(toCache));
    } catch (_) { }
    renderFilingSignals(filingSignals);
    if (!filingSignals.length || !filingSignalsMeta) {
      // Try once more with cache-bust to avoid stale caches removing cards
      const fresh = await fetchEdgarSnapshot({ cacheBust: true }).catch(() => null);
      if (fresh && Array.isArray(fresh?.filingSignals?.signals)) {
        filingSignals = fresh.filingSignals.signals;
        const freshMeta = fresh?.filingSignals?.meta || null;
        const freshCachedAt = fresh?.filingSignals?.cachedAt || null;
        renderFilingSignals(filingSignals);
        const refreshed = {
          data: fresh?.data || edgarFundamentals,
          notes: fresh?.notes || edgarNotes,
          filingSignals,
          filingSignalsMeta: freshMeta,
          filingSignalsCachedAt: freshCachedAt
        };
        try { localStorage.setItem(latestKey("edgar-snapshot"), JSON.stringify(refreshed)); } catch (_) { }
      }
    }
    return edgarFundamentals;
  } catch (err) {
    console.warn("EDGAR snapshot fetch failed", err?.message || err);
    return edgarFundamentals;
  }
}

function renderEdgarNotes() {
  if (edgarNotesEl) edgarNotesEl.innerHTML = "";
}

function renderFilingSignals(stock, signals = []) {
  const row = document.getElementById("filingSignalsRow");
  const grid = document.getElementById("filingSignalsGrid");
  const bioRow = document.getElementById("bioIntelRow");
  const bioGrid = document.getElementById("bioIntelGrid");
  if (!row || !grid) return;
  const list = Array.isArray(signals) ? signals.filter(Boolean) : [];
  if (!list.length) {
    row.classList.add("hidden");
    grid.innerHTML = "";
    if (bioRow && bioGrid) {
      bioRow.classList.add("hidden");
      bioGrid.innerHTML = "";
    }
    return;
  }
  row.classList.remove("hidden");
  grid.innerHTML = "";
  list
    .slice()
    .filter(sig => {
      if (sig.id === "going_concern") {
        // Suppress for established companies OR foreign filers (who often lack market cap data but are large)
        const isEstablished = stock.ratingTierLabel === "solid" || stock.ratingTierLabel === "bullish" || stock.ratingTierLabel === "elite" || (stock.marketCap && stock.marketCap > 10000000000) || stock.issuerType === "foreign";
        if (isEstablished) return false;
      }
      return true;
    })
    .sort((a, b) => Math.abs(Number(b.score) || 0) - Math.abs(Number(a.score) || 0))
    .forEach((sig) => {
      const score = Number(sig.score) || 0;
      const tone = score > 0 ? "tone-good" : score < 0 ? "tone-risk" : "";
      const scoreText = score > 0 ? `+${score}` : `${score}`;
      const snippet = (sig.snippet || "").slice(0, 220) + ((sig.snippet || "").length > 220 ? "..." : "");
      const card = document.createElement("div");
      card.className = `filing-card ${tone}`.trim();
      card.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
          <div class="tag">${scoreText}</div>
          <div class="score">${sig.title || "Filing signal"}</div>
        </div>
        <div class="title">${sig.form || ""}${sig.filed ? ` - ${sig.filed}` : ""}</div>
        <div class="snippet">${snippet || "Language detected in latest filing."}</div>
        <div class="foot">
          ${sig.docUrl ? `<a class="link" href="${sig.docUrl}" target="_blank" rel="noopener">Open filing &nearr;</a>` : ""}
        </div>
      `;
      grid.appendChild(card);
    });
  renderBiotechIntel(list, bioRow, bioGrid);
  // Move filing row below score reasons
  const scoreReasonsEl = document.getElementById("scoreReasons");
  if (scoreReasonsEl && row) {
    scoreReasonsEl.insertAdjacentElement("afterend", row);
  }
}

const BIOTECH_IDS = new Set([
  "clinical_positive",
  "clinical_negative",
  "safety_good",
  "safety_bad",
  "regulatory_positive",
  "regulatory_negative",
  "regulatory_setback",
  "catalyst_upcoming",
  "moa_strength",
  "moa_weak",
  "trial_execution_risk",
  "biotech_cash_dependency",
  "non_dilutive_finance"
]);

function renderBiotechIntel(signals, bioRow, bioGrid) {
  if (!bioRow || !bioGrid) return;
  const vm = currentVm;
  const bucket = resolveSectorBucket(vm?.sector || vm?.sectorBucket);
  const isBio = isBiotechSector(bucket) ||
    (vm?.sicDescription && /pharm|bio|drug|device/i.test(vm?.sicDescription)) ||
    (vm?.companyName && /therapeutics|pharm|bio|sciences|medicine/i.test(vm?.companyName));

  if (!isBio) {
    bioRow.classList.add("hidden");
    bioGrid.innerHTML = "";
    return;
  }
  const list = Array.isArray(signals) ? signals.filter(Boolean) : [];
  const idSet = new Set(list.map((s) => s.id));
  const hasBio = list.some((s) => BIOTECH_IDS.has(s.id));
  if (!hasBio) {
    bioRow.classList.add("hidden");
    bioGrid.innerHTML = "";
    return;
  }
  bioRow.classList.remove("hidden");
  const pick = (pos, neg, fallback) => {
    if (idSet.has(pos)) return "good";
    if (idSet.has(neg)) return "risk";
    return fallback || "warn";
  };
  const findSignal = (ids) => {
    for (const id of ids) {
      const match = list.find((s) => s.id === id);
      if (match) return match;
    }
    return null;
  };

  const chips = [
    {
      ids: ["moa_strength", "moa_weak"],
      label: "Mechanism Strength",
      tone: pick("moa_strength", "moa_weak", "warn"),
      value: idSet.has("moa_strength") ? "First/Best-in-class" : idSet.has("moa_weak") ? "Crowded MoA" : "TBD",
    },
    {
      ids: ["clinical_positive", "clinical_negative"],
      label: "Phase Progress",
      tone: pick("clinical_positive", "clinical_negative", "warn"),
      value: idSet.has("clinical_positive") ? "Positive readout" : idSet.has("clinical_negative") ? "Failed endpoint" : "Pending",
    },
    {
      ids: ["regulatory_positive", "regulatory_negative", "regulatory_setback"],
      label: "Regulatory Status",
      tone: pick("regulatory_positive", "regulatory_negative", "warn"),
      value: idSet.has("regulatory_positive") ? "Designation/positive" : idSet.has("regulatory_negative") || idSet.has("regulatory_setback") ? "Hold/CRL/Setback" : "Monitoring",
    },
    {
      ids: ["moa_strength", "moa_weak"],
      label: "Competitive Moat",
      tone: pick("moa_strength", "moa_weak", "neutral"),
      value: idSet.has("moa_strength") ? "Differentiated" : idSet.has("moa_weak") ? "Crowded space" : "Unclear",
    }
  ];

  bioGrid.innerHTML = chips
    .map((chip) => {
      const signal = findSignal(chip.ids);
      const note = signal?.snippet ? signal.snippet.slice(0, 140) : "";
      const docUrl = signal?.docUrl || "";
      const meta = signal ? `<div style="font-size:10px; opacity:0.7; margin-bottom:4px;">${signal.form || ""} &middot; ${signal.filed || ""}</div>` : "";

      const cls = `bio-chip ${chip.tone}`;
      const noteHtml = note ? `<div class="note">${note}</div>` : "";
      const linkHtml = docUrl ? `<div style="margin-top:auto; font-size:11px;"><a href="${docUrl}" target="_blank" class="bio-link">Open filing &nearr;</a></div>` : "";

      return `<div class="${cls}">
        <div class="label">${chip.label}</div>
        <div class="value">${chip.value}</div>
        ${meta}
        ${noteHtml}
        ${linkHtml}
      </div>`;
    })
    .join("");
}


async function runBatched(taskFns, batchSize = 5, delayMs = 1000) {
  const results = [];
  for (let i = 0; i < taskFns.length; i += batchSize) {
    const chunk = taskFns.slice(i, i + batchSize);
    console.debug(`Batch ${i / batchSize + 1}: starting ${chunk.length} requests`);
    const chunkResults = await Promise.all(
      chunk.map(async (fn, idx) => {
        try {
          const r = await fn();
          console.debug(`   chunk item ${idx + 1} ok`);
          return r;
        } catch (err) {
          console.warn(`   chunk item ${idx + 1} failed: ${err.message || err}`);
          throw err;
        }
      })
    );
    results.push(...chunkResults);
    if (i + batchSize < taskFns.length) {
      console.debug(`Batch ${i / batchSize + 1}: sleeping ${delayMs}ms`);
      await sleep(delayMs);
    }
  }
  return results;
}

function buildApiUrl(kind) {
  const params = new URLSearchParams({ symbol: ticker, section: kind });
  return `${API_BASE}?${params.toString()}`;
}

function showRateLimitNotice() {
  if (statusEl) statusEl.textContent = RATE_LIMIT_MESSAGE;
}

function handleLoadError(err) {
  if (err?.rateLimited) {
    showRateLimitNotice();
    return;
  }
  statusEl.textContent = `Error: ${err?.message || "Failed to load data"}`;
  console.error(err);
  hideLoadingOverlay();
}

function hasPrice(vm) {
  return Number.isFinite(vm?.priceSummary?.lastClose);
}

function isPriceStale(vm, maxAgeHours = 36) {
  if (!vm) return true;
  const dateStr =
    vm.priceSummary?.lastCloseDate ||
    (Array.isArray(vm.priceHistory) && vm.priceHistory.length ? vm.priceHistory.map((p) => p.date).filter(Boolean).sort().slice(-1)[0] : null);
  if (!dateStr) return true;
  const ts = Date.parse(dateStr);
  if (!Number.isFinite(ts)) return true;

  const now = new Date();
  const day = now.getDay(); // 0=Sun, 6=Sat
  // Relax staleness check during weekends/Monday morning to avoid rejecting Friday's close
  let allowed = maxAgeHours;
  if (day === 0) allowed = 72; // Sunday: allow Friday data
  if (day === 6) allowed = 48; // Saturday: allow Friday data
  if (day === 1) allowed = 80; // Monday: allow Friday data until market close

  const ageHours = (now.getTime() - ts) / (1000 * 60 * 60);
  return ageHours > allowed;
}

function priceAgeHours(vm) {
  if (!vm) return null;
  const dateStr =
    vm.priceSummary?.lastCloseDate ||
    (Array.isArray(vm.priceHistory) && vm.priceHistory.length ? vm.priceHistory.map((p) => p.date).filter(Boolean).sort().slice(-1)[0] : null);
  if (!dateStr) return null;
  const ts = Date.parse(dateStr);
  if (!Number.isFinite(ts)) return null;
  return (Date.now() - ts) / (1000 * 60 * 60);
}

async function ensurePriceReady(vm, maxTries = 3) {
  const manual = readManualPrice();
  if (manual) {
    const withManual = applyManualPriceToVm(vm);
    updatePriceDisplay(manual.price, `$${manual.price.toFixed(2)}`, null);
    return withManual;
  }
  // If we already have a reasonably fresh price (<24h), show it and avoid polling
  if (hasPrice(vm) && vm?.pricePending === false) {
    if (!isPriceStale(vm)) return vm;
    const age = priceAgeHours(vm);
    if (age !== null && age <= 24) {
      const asOf = vm.priceSummary?.lastCloseDate || "recently";
      statusEl.textContent = `Last close as of ${asOf} (showing cached price)`;
      return vm;
    }
  }
  let latest = vm;
  const delays = [0, 1500, 5000].slice(0, Math.max(1, Math.min(3, maxTries)));
  for (let i = 0; i < delays.length; i++) {
    const wait = delays[i];
    if (wait) await sleep(wait);
    try {
      const res = await fetch(`${API_ROOT}/ticker/${encodeURIComponent(ticker)}`, {
        headers: { Accept: "application/json" }
      });
      const data = await res.json();
      const nextVm = data?.data || data;
      latest = nextVm || latest;
      // Only return if we have a price AND it's fresh (or if backend says it's done pending)
      if (nextVm?.pricePending === false) {
        return nextVm;
      }
      if (hasPrice(nextVm) && !isPriceStale(nextVm)) {
        return nextVm;
      }
      const age = priceAgeHours(nextVm);
      if (hasPrice(nextVm) && age !== null && age <= 24) {
        statusEl.textContent = `Last close as of ${nextVm.priceSummary?.lastCloseDate || "recently"} (cached)`;
        return nextVm;
      }
    } catch (err) {
      console.warn("price poll failed", err);
    }
  }
  statusEl.textContent = "Price unavailable; retry shortly.";
  return latest;
}

async function waitForTickerReady(maxTries = 10, delayMs = 1500) {
  let lastPayload = null;
  let lastStatus = null;
  let notFound = false;
  for (let i = 0; i < maxTries; i++) {
    try {
      const res = await fetch(`${API_ROOT}/ticker/${encodeURIComponent(ticker)}`, {
        headers: { Accept: "application/json" }
      });
      if (res.status === 404) {
        notFound = true;
        break;
      }
      const data = await res.json();
      lastPayload = data;
      lastStatus = data?.status || data?.data?.status || null;
      const vm = data?.data || data;
      const message = data?.message || vm?.message || "";
      const explicitNotFound =
        vm?.notFound === true ||
        lastStatus === "not_found" ||
        lastStatus === "missing" ||
        /not found/i.test(message);
      if (explicitNotFound) {
        notFound = true;
        break;
      }
      if (!lastStatus || lastStatus === "ready") return vm;
      if (lastStatus === "error") {
        throw new Error(data?.message || "Ticker failed to load");
      }
      const overlayLabel = `Loading EDGAR data... (${lastStatus})`;
      statusEl.textContent = overlayLabel;
      showLoadingOverlay(overlayLabel);
    } catch (err) {
      lastPayload = err;
      console.warn("ticker poll failed", err);
    }
    await sleep(delayMs);
  }
  if (notFound) return { notFound: true };
  const timedOutPayload = lastPayload?.data || lastPayload || null;
  return { timedOut: true, lastStatus, data: timedOutPayload };
}

function cacheEntryFresh(entry) {
  if (!entry || typeof entry !== "object") return null;
  const versionOk = entry.version === CACHE_VERSION;
  const updatedAt = entry.updatedAt ? Date.parse(entry.updatedAt) : null;
  const maxAgeMs = CACHE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const fresh = versionOk && Number.isFinite(updatedAt) && Date.now() - updatedAt < maxAgeMs;
  return fresh ? entry.payload : null;
}

function vmCacheFresh(entry) {
  if (!entry || typeof entry !== "object") return null;
  const versionOk = entry.version === CACHE_VERSION;
  const updatedAt = entry.updatedAt ? Date.parse(entry.updatedAt) : null;
  const fresh = versionOk && Number.isFinite(updatedAt) && Date.now() - updatedAt < VM_CACHE_MAX_AGE_MS;
  return fresh ? entry.payload : null;
}

function readCachedVm() {
  try {
    const raw = localStorage.getItem(`edgar-vm-${ticker}-latest`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const vm = vmCacheFresh(parsed);
    // Invalidate legacy caches that lack rating reasons/completeness (post-upgrade)
    if (vm && (!Array.isArray(vm.ratingReasons) || vm.ratingCompleteness == null)) {
      return null;
    }
    return vm;
  } catch (_) {
    return null;
  }
}

function writeCachedVm(vm) {
  if (!vm) return;
  const payload = {
    version: CACHE_VERSION,
    updatedAt: new Date().toISOString(),
    payload: vm
  };
  try {
    localStorage.setItem(`edgar-vm-${ticker}-latest`, JSON.stringify(payload));
  } catch (_) { }
}

async function fetchWithCache(kind, url, options = {}) {
  const { allowPaywall = false, allowRetry = false, noApiWhenMissing = false, treatEmptyAsMissing = false } = options;
  const cacheOnly = CACHE_ONLY || noApiWhenMissing;
  const key = cacheKey(kind); const latest = latestKey(kind);
  const cachedRaw = localStorage.getItem(key) || localStorage.getItem(latest);
  let cachedPayload;
  if (cachedRaw) {
    try {
      const parsed = JSON.parse(cachedRaw);
      if (parsed && parsed.payload !== undefined) {
        cachedPayload = cacheEntryFresh(parsed);
      } else {
        // legacy cache entries: treat as stale to avoid ghost values
        cachedPayload = null;
      }
    } catch (_) {
      cachedPayload = null;
    }
  }
  if (cachedPayload !== undefined && cachedPayload !== null) {
    if (treatEmptyAsMissing && Array.isArray(cachedPayload) && cachedPayload.length === 0) {
      // fall through to bundle/API
    } else {
      return cachedPayload;
    }
  }
  // Optional: skip API entirely if not cached (to avoid burning calls in testing).
  if (cacheOnly) return null;
  // As last resort, hit API.
  const paywallKey = `paywall-${ticker}-${kind}`;
  if (allowPaywall && allowRetry) localStorage.removeItem(paywallKey);
  const paywallFlag = localStorage.getItem(paywallKey);
  if (allowPaywall && paywallFlag === "1" && !options.allowRetry) {
    console.warn(`${kind} marked paywalled - skipping API`);
    return null;
  }
  try {
    const requestUrl = url || buildApiUrl(kind);
    console.debug(`fetch ${kind} -> ${requestUrl}`);
    const res = await fetch(requestUrl);
    if (res.status === 429) {
      showRateLimitNotice();
      if (cachedPayload !== undefined && cachedPayload !== null) return cachedPayload;
      const rateErr = new Error("Rate limited");
      rateErr.rateLimited = true;
      throw rateErr;
    }
    if (!res.ok) {
      console.warn(`fetch ${kind} failed`, res.status, res.statusText);
      if (allowPaywall && res.status === 402) {
        console.warn(`${kind} is paywalled (402) - returning null for now`);
        if (!CACHE_ONLY) {
          localStorage.setItem(key, JSON.stringify(null));
          localStorage.setItem(latest, JSON.stringify(null));
          localStorage.setItem(paywallKey, "1");
        }
        return null;
      }
      const errText = await res.text().catch(() => "");
      const err = new Error(`${kind} fetch failed ${res.status}`);
      err.status = res.status;
      err.body = errText;
      console.error(`fetch ${kind} failed ${res.status}`, { url: requestUrl, body: errText });
      throw err;
    }
    const data = await res.json();
    if (!CACHE_ONLY) {
      const wrapped = {
        version: CACHE_VERSION,
        updatedAt: new Date().toISOString(),
        payload: data
      };
      localStorage.setItem(key, JSON.stringify(wrapped));
      localStorage.setItem(latest, JSON.stringify(wrapped));
      if (allowPaywall) localStorage.removeItem(paywallKey);
    }
    return data;
  } catch (err) {
    console.error(`fetchWithCache error for ${kind}`, err);
    if (cachedPayload !== undefined) {
      console.warn(`Using cached ${kind} due to error`, err.message);
      return cachedPayload;
    }
    if (allowPaywall) return null;
    throw err;
  }
}

async function loadAll() {
  showLoadingOverlay("Loading EDGAR data...");
  let cachedVm = USE_VM_CACHE ? readCachedVm() : null;
  if (cachedVm && isPriceStale(cachedVm)) {
    try { localStorage.removeItem(`edgar-vm-${ticker}-latest`); } catch (_) { }
    try { localStorage.removeItem(`latest-price-${ticker}`); } catch (_) { }
    cachedVm = null;
  }
  let vmPayload = cachedVm || null;
  await ensureEdgarFundamentalsReady();
  renderEdgarNotes();
  if (cachedVm) {
    statusEl.textContent = "Loaded cached fundamentals (local)";
  } else {
    statusEl.innerHTML = `<span style="color:var(--muted); font-weight:600;">Last Close</span> <span style="font-weight:800; color:var(--text);">--</span>`;
    showLoadingOverlay("Loading EDGAR data...");
    try {
      let initialNotFound = false;
      const res = await fetch(`${API_ROOT}/ticker/${encodeURIComponent(ticker)}`, {
        headers: { Accept: "application/json" }
      });
      if (res.status === 404) {
        // Allow backend pipeline to finish its checks before showing a hard not-found state.
        initialNotFound = true;
      } else {
        const data = await res.json();
        const status = data?.status;
        const msg = data?.message || data?.data?.message || "";
        const explicitNotFound = data?.data?.notFound === true || /not found/i.test(msg);
        if (status && status !== "ready") {
          vmPayload = await waitForTickerReady();
        } else {
          vmPayload = data?.data || data;
        }
        if (explicitNotFound) {
          vmPayload = { notFound: true };
        }
      }
      if (initialNotFound) {
        const awaited = await waitForTickerReady();
        if (awaited?.notFound) {
          showMissingTickerModal(`We couldn't find EDGAR fundamentals for ${ticker}. It may be mistyped or unsupported.`);
          return;
        }
        if (awaited?.timedOut || awaited?.lastStatus === "pending" || awaited?.lastStatus === "processing") {
          showMissingTickerModal(`We couldn't find EDGAR fundamentals for ${ticker} after checking filings. It may be mistyped or unsupported.`);
          return;
        }
        vmPayload = awaited?.data || awaited || null;
      }
      const pendingLike =
        vmPayload?.timedOut === true ||
        vmPayload?.lastStatus === "running" ||
        vmPayload?.lastStatus === "pending" ||
        vmPayload?.lastStatus === "processing" ||
        vmPayload?.status === "running" ||
        vmPayload?.status === "pending" ||
        vmPayload?.status === "processing";
      if (vmPayload?.notFound) {
        showMissingTickerModal(`We couldn't find EDGAR fundamentals for ${ticker}. It may be mistyped or unsupported.`);
        return;
      }
      if (pendingLike || !vmPayload) {
        showMissingTickerModal(`We couldn't find EDGAR fundamentals for ${ticker} after checking filings. It may be mistyped or unsupported.`);
        return;
      }
    } catch (err) {
      console.error("Failed to fetch ticker view model", err);
      statusEl.textContent = `Error: ${err?.message || "Could not load ticker"}`;
      hideLoadingOverlay();
      return;
    }
    if (!vmPayload) {
      statusEl.textContent = "Still preparing EDGAR data... refresh in a moment.";
      hideLoadingOverlay();
      return;
    }
  }

  function showDeadTickerState() {
    hideLoadingOverlay();
    const shell = document.querySelector(".shell");
    if (shell) shell.style.display = "none";

    const page = document.querySelector(".page") || document.body;
    const msgContainer = document.createElement("div");
    msgContainer.style.cssText = "display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:60vh; text-align:center; padding:20px; color:#e8f0ff;";

    msgContainer.innerHTML = `
    <div style="font-size:48px; margin-bottom:16px;">:(</div>
    <h2 style="font-size:24px; margin-bottom:12px; font-weight:700;">Ticker Not Found</h2>
    <p style="font-size:16px; color:#9fb3c8; max-width:400px; line-height:1.5;">
      We couldn't find usable EDGAR filings for <strong>${ticker}</strong>.
      <br><br>
      Check the symbol or try a US-listed stock.
    </p>
    <a href="index.html" class="ghost-btn" style="margin-top:24px; text-decoration:none;">&larr; Back to Search</a>
  `;

    page.appendChild(msgContainer);
  }

  // If price is missing/pending, clear stale cached price so we don't reuse bad values.
  const hasPriceInVm = Number.isFinite(vmPayload?.priceSummary?.lastClose) || (vmPayload?.priceHistory || []).length > 0;
  if (!hasPriceInVm) {
    localStorage.removeItem(`latest-price-${ticker}`);
  }

  vmPayload = await ensurePriceReady(vmPayload);
  currentVm = vmPayload;
  if ((!filingSignals || !filingSignals.length) && Array.isArray(vmPayload?.filingSignals)) {
    filingSignals = vmPayload.filingSignals;
  }
  // If filing signals still empty, attempt a cache-bust snapshot fetch now
  if (!Array.isArray(filingSignals) || !filingSignals.length) {
    try {
      const fresh = await fetchEdgarSnapshot({ cacheBust: true });
      if (Array.isArray(fresh?.filingSignals?.signals)) {
        filingSignals = fresh.filingSignals.signals;
        renderFilingSignals(currentVm, filingSignals);
      }
    } catch (err) {
      console.warn("Filing signals refresh failed", err?.message || err);
    }
  }
  priceAsOfDate = vmPayload?.priceAsOf || vmPayload?.priceSummary?.lastCloseDate || null;
  fundamentalsAsOfDate = vmPayload?.fundamentalsAsOf || vmPayload?.ttm?.asOf || null;
  lastFilingDate = vmPayload?.lastFilingDate || null;
  if (!cachedVm) writeCachedVm(vmPayload);
  if (Array.isArray(vmPayload?.ratingNotes) && vmPayload.ratingNotes.length) {
    edgarNotes = Array.isArray(edgarNotes) ? edgarNotes.slice() : [];
    edgarNotes.push(...vmPayload.ratingNotes);
    renderEdgarNotes();
  }
  renderFilingSignals(currentVm, filingSignals);

  // Map view model -> legacy shapes for renderers
  const financialSeries = (vmPayload.quarterlySeries && vmPayload.quarterlySeries.length ? vmPayload.quarterlySeries : vmPayload.annualSeries || []);
  const quartersDesc = financialSeries
    .slice()
    .sort((a, b) => Date.parse(b.periodEnd) - Date.parse(a.periodEnd));
  const income = quartersDesc.map((q) => ({
    date: q.periodEnd,
    revenue: q.revenue,
    grossProfit: q.grossProfit,
    operatingIncome: q.operatingIncome,
    netIncome: q.netIncome,
    eps: q.epsBasic,
    epsdiluted: q.epsBasic,
    epsDiluted: q.epsBasic
  }));
  const balance = quartersDesc.map((q) => ({
    date: q.periodEnd,
    cashAndCashEquivalents: q.cash,
    totalDebt: q.totalDebt,
    totalStockholdersEquity: q.totalEquity,
    totalAssets: q.totalAssets,
    totalLiabilities: q.totalLiabilities,
    deferredRevenue: q.deferredRevenue ?? q.contractWithCustomerLiability ?? null,
    contractWithCustomerLiability: q.contractWithCustomerLiability ?? q.deferredRevenue ?? null,
    commonStockSharesOutstanding: q.sharesOutstanding,
    shortTermInvestments: q.shortTermInvestments
  }));
  const cash = quartersDesc.map((q) => ({
    date: q.periodEnd,
    netCashProvidedByOperatingActivities: q.operatingCashFlow,
    operatingCashFlow: q.operatingCashFlow,
    capitalExpenditure: q.capex,
    depreciationDepletionAndAmortization: q.depreciationDepletionAndAmortization ?? null,
    fcfComputed:
      q.freeCashFlow != null
        ? q.freeCashFlow
        : q.operatingCashFlow != null && q.capex != null
          ? q.operatingCashFlow - q.capex
          : null
  }));
  const findLatestFinite = (arr, key) => {
    if (!Array.isArray(arr)) return null;
    for (const item of arr) {
      const v = Number(item?.[key]);
      if (Number.isFinite(v) && v > 0) return v;
    }
    return null;
  };
  const sharesLatest = findLatestFinite(quartersDesc, "sharesOutstanding");
  const hasShares = Number.isFinite(sharesLatest) && sharesLatest > 0;
  const revenueTtm = vmPayload.ttm?.revenue ?? null;
  const fcfTtm = vmPayload.ttm?.freeCashFlow ?? null;
  const equityLatest = findLatestFinite(quartersDesc, "totalEquity");
  const priceCloseVm = vmPayload.priceSummary?.lastClose ?? null;
  const priceHistoryRaw = Array.isArray(vmPayload.priceHistory) ? vmPayload.priceHistory.slice() : [];
  const priceHistorySorted = priceHistoryRaw.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const lastHistoryPrice = priceHistorySorted.length ? Number(priceHistorySorted[priceHistorySorted.length - 1].close) : null;
  const priceCloseFallback = Number.isFinite(priceCloseVm) ? priceCloseVm : (Number.isFinite(lastHistoryPrice) ? lastHistoryPrice : null);
  const pricePrevFallback = (() => {
    if (Number.isFinite(vmPayload.priceSummary?.prevClose)) return vmPayload.priceSummary.prevClose;
    if (priceHistorySorted.length >= 2) {
      const prev = Number(priceHistorySorted[priceHistorySorted.length - 2].close);
      return Number.isFinite(prev) ? prev : null;
    }
    return null;
  })();
  const epsTtm = vmPayload.ttm?.epsBasic ?? null;
  const safeDivide = (num, den) => {
    if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0 || Math.abs(den) < 1e-6) return null;
    return num / den;
  };
  const runwayYears = computeRunwayYears(vmPayload);
  const ratingMeta = {
    rawScore: vmPayload.ratingRawScore ?? vmPayload.rating?.rawScore,
    normalizedScore: vmPayload.ratingNormalizedScore ?? vmPayload.rating?.normalizedScore,
    tierLabel: vmPayload.ratingTierLabel ?? vmPayload.rating?.tierLabel
  };

  const makeKeyMetricRow = (label, rev, fcf, equity, eps, shares, price, vmFallback = {}) => {
    const revenuePerShare = safeDivide(rev, shares);
    const fcfPerShare = safeDivide(fcf, shares);
    const bvPerShare = safeDivide(equity, shares);
    return {
      date: label,
      freeCashFlowPerShareTTM: fcfPerShare ?? vmFallback.freeCashFlowPerShareTTM ?? null,
      revenuePerShareTTM: revenuePerShare ?? vmFallback.revenuePerShareTTM ?? null,
      bookValuePerShareTTM: bvPerShare ?? vmFallback.bookValuePerShareTTM ?? null,
      pfcfRatio: (() => {
        if (vmFallback.pfcfRatio != null) return vmFallback.pfcfRatio;
        if (price != null && fcfPerShare != null) return safeDivide(price, fcfPerShare);
        return null;
      })(),
      peRatio: (() => {
        if (vmFallback.peRatio != null) return vmFallback.peRatio;
        if (price != null && eps != null && Math.abs(eps) >= 1e-6) return price / eps;
        return null;
      })(),
      priceToSalesRatio: (() => {
        if (vmFallback.priceToSalesRatio != null) return vmFallback.priceToSalesRatio;
        if (price != null && revenuePerShare != null) return safeDivide(price, revenuePerShare);
        return null;
      })(),
      priceToBookRatio: (() => {
        if (vmFallback.priceToBookRatio != null) return vmFallback.priceToBookRatio;
        if (price != null && bvPerShare != null) return safeDivide(price, bvPerShare);
        return null;
      })()
    };
  };

  const keyMetrics = [
    {
      date: vmPayload.ttm?.asOf || "TTM",
      ...makeKeyMetricRow(
        "TTM",
        revenueTtm,
        fcfTtm,
        equityLatest,
        epsTtm,
        sharesLatest,
        priceCloseFallback,
        {
          pfcfRatio: vmPayload.keyMetrics?.freeCashFlowYield ? 1 / vmPayload.keyMetrics.freeCashFlowYield : null,
          peRatio: vmPayload.keyMetrics?.peTtm ?? null,
          priceToSalesRatio: vmPayload.keyMetrics?.psTtm ?? null,
          priceToBookRatio: vmPayload.keyMetrics?.pb ?? null,
          revenuePerShareTTM: vmPayload.keyMetrics?.revenuePerShareTTM ?? null,
          freeCashFlowPerShareTTM: vmPayload.keyMetrics?.freeCashFlowPerShareTTM ?? null,
          bookValuePerShareTTM: vmPayload.keyMetrics?.bookValuePerShareTTM ?? null
        }
      )
    },
    ...quartersDesc.slice(0, 2).map((q) =>
      makeKeyMetricRow(q.periodEnd || q.label || "Q", q.revenue, q.freeCashFlow ?? q.operatingCashFlow, q.totalEquity, q.epsBasic, q.sharesOutstanding, priceCloseFallback)
    )
  ];
  const latestQuarter = quartersDesc[0] || {};
  const ratios = [
    {
      date: latestQuarter.periodEnd || "latest",
      grossProfitMargin: vmPayload.keyMetrics?.grossMargin ?? safeDivide(latestQuarter.grossProfit, latestQuarter.revenue),
      operatingProfitMargin: vmPayload.keyMetrics?.operatingMargin ?? safeDivide(latestQuarter.operatingIncome, latestQuarter.revenue),
      netProfitMargin: vmPayload.keyMetrics?.netMargin ?? safeDivide(latestQuarter.netIncome, latestQuarter.revenue),
      returnOnEquity: vmPayload.keyMetrics?.roe ?? safeDivide(latestQuarter.netIncome, latestQuarter.totalEquity),
      returnOnInvestedCapital:
        vmPayload.keyMetrics?.roic ??
        safeDivide(
          latestQuarter.netIncome,
          latestQuarter.totalEquity != null && latestQuarter.totalDebt != null && latestQuarter.cash != null
            ? latestQuarter.totalEquity + latestQuarter.totalDebt - latestQuarter.cash
            : null
        ),
      debtEquityRatio: vmPayload.keyMetrics?.debtToEquity ?? safeDivide(latestQuarter.totalDebt, latestQuarter.totalEquity)
    },
    ...quartersDesc.slice(0, 2).map((q) => ({
      date: q.periodEnd || q.label || "Q",
      grossProfitMargin: safeDivide(q.grossProfit, q.revenue),
      operatingProfitMargin: safeDivide(q.operatingIncome, q.revenue),
      netProfitMargin: safeDivide(q.netIncome, q.revenue),
      returnOnEquity: safeDivide(q.netIncome, q.totalEquity),
      returnOnInvestedCapital: safeDivide(
        q.netIncome,
        q.totalEquity != null && q.totalDebt != null && q.cash != null ? q.totalEquity + q.totalDebt - q.cash : null
      ),
      debtEquityRatio: safeDivide(q.totalDebt, q.totalEquity)
    }))
  ];


  // Price mapping
  let priceFull = (vmPayload.priceHistory || []).map((p) => ({
    date: p.date,
    close: Number(p.close),
    adjClose: Number(p.close),
    high: Number(p.close),
    low: Number(p.close),
    open: Number(p.close),
    volume: 0
  }));
  if ((!priceFull || !priceFull.length) && Array.isArray(priceSeriesFull) && priceSeriesFull.length) {
    priceFull = priceSeriesFull; // reuse any preloaded chart data
  }
  if ((!priceFull || !priceFull.length) && Number.isFinite(vmPayload?.priceSummary?.lastClose)) {
    const fallbackDate = vmPayload.priceSummary.lastCloseDate || todayIso();
    priceFull = [{ date: fallbackDate, close: Number(vmPayload.priceSummary.lastClose) }];
  }
  const priceLight = priceFull;
  const priceInfo = renderPriceBlock(priceLight, priceFull);
  priceSeriesFull = priceInfo.seriesForChart || [];
  priceSeriesLight = priceLight || [];
  renderPriceChart(filterSeriesByRange(priceSeriesFull, selectedRange));
  const sortedHistory = [...priceSeriesFull].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const histLatest = sortedHistory.at(-1);
  const histPrev = sortedHistory.slice(-2, -1)[0];
  const historyPrevClose = Number(histPrev?.close);
  const latestPrice =
    vmPayload.priceSummary?.lastClose ??
    getLatestPrice(priceFull, priceLight) ??
    parsePriceString(priceInfo.lastCloseText);
  const dayChangePct =
    vmPayload.priceSummary?.dayChangePct != null
      ? vmPayload.priceSummary.dayChangePct * 100
      : priceInfo.dayChange;
  if (Number.isFinite(latestPrice)) {
    const prev =
      vmPayload.priceSummary?.prevClose ??
      (Number.isFinite(historyPrevClose) ? historyPrevClose : null);
    const derivedDayChange =
      prev != null && prev !== 0 ? ((latestPrice - prev) / prev) * 100 : dayChangePct;
    updatePriceDisplay(latestPrice, priceInfo.lastCloseText, derivedDayChange);
  } else {
    updatePriceDisplay(null, priceInfo.lastCloseText, dayChangePct);
  }
  if (histLatest?.date) {
    priceAsOfDate = histLatest.date;
    currentVm = { ...vmPayload, priceHistory: priceSeriesFull };
  }

  const baseReasons = Array.isArray(vmPayload.ratingReasons) ? vmPayload.ratingReasons : [];
  renderTables(income, balance, cash, keyMetrics, ratios, [], []);
  const stock = buildStockFromStatements({
    income,
    balance,
    cash,
    keyMetrics,
    ratios,
    keyMetricsTtm: [],
    ratiosTtm: [],
    financialScores: [],
    ownerEarnings: [],
    incomeGrowth: [],
    priceFull,
    priceSummary: vmPayload.priceSummary,
    sector: vmPayload.sector || vmPayload.sectorBucket || null,
    runwayYears,
    narrative: vmPayload.narrative,
    filingProfile: vmPayload.filingProfile
  });

  // FIX: Explicitly attach metadata that buildStockFromStatements ignores
  stock.ratingReasons = baseReasons;
  stock.ratingTierLabel = ratingMeta?.tierLabel || "neutral";
  stock.issuerType = vmPayload.issuerType;
  stock.filingProfile = vmPayload.filingProfile;
  stock.keyMetrics = vmPayload.keyMetrics;

  // Keep filing intelligence out of the finance cards; those show in the filing section.
  const combinedReasons = baseReasons.filter(
    (reason) =>
      (reason?.source || "").toLowerCase() !== "filing" &&
      !String(reason?.name || "").toLowerCase().startsWith("filing")
  );
  renderScoreboard(combinedReasons, stock, ratingMeta, vmPayload.ratingCompleteness);
  renderFilingSignals(stock, filingSignals);
  const effectivePrice = Number.isFinite(latestPrice)
    ? latestPrice
    : parsePriceString(priceInfo.lastCloseText) ?? getCachedPrice();
  renderSnapshot(income, balance, cash, keyMetrics, [], ratios, priceSeriesFull, effectivePrice);
  renderProjections(vmPayload);
  const chartWrapper = document.getElementById("priceChartWrapper");
  if (chartWrapper) chartWrapper.style.display = "none";
  const rangeSwitchEl = document.getElementById("rangeSwitch");
  if (rangeSwitchEl) rangeSwitchEl.style.display = "none";
  const momentumSection = document.querySelector(".future-outlook");
  const trendSection = document.querySelector(".sparkline-wrap");
  if (momentumSection) momentumSection.style.display = "block";
  if (trendSection) trendSection.style.display = "none";
  const subtitleEl = document.getElementById("subtitle");
  if (subtitleEl) subtitleEl.textContent = "";
  hideLoadingOverlay();
  if (ENABLE_AUDIT_DUMP) {
    console.log("[AUDIT DUMP] Final Stock Object:", stock);
    console.log("[AUDIT DUMP] Combined Reasons:", combinedReasons);
  }
}

function renderProjections(vm) {
  const wrap = document.querySelector(".future-outlook");
  const grid = document.getElementById("futureGrid");
  if (!wrap || !grid) return;
  const proj = vm.projections || {};
  const strategic = vm.strategicOutlook || {};
  const opOutlook = strategic.operationalMomentum || {};
  const trajOutlook = strategic.trajectory || {};
  const snapshot = vm.snapshot || {};
  const keyMetrics = vm.keyMetrics || {};

  const clampScore = (val) => {
    const num = Number(val);
    return Number.isFinite(num) ? Math.max(0, Math.min(1, num)) : null;
  };

  // Using labels instead of percentages
  const classifyGrowth = (score) => {
    if (score == null) return { label: "Data missing", className: "", color: "#8ea3c0" };
    if (score >= 0.6) return { label: "Strengthening", className: "pill-good", color: "#4ade80" };
    if (score >= 0.3) return { label: "Stable", className: "pill-warn", color: "#f6c453" };
    return { label: "Softening", className: "pill-risk", color: "#ff9b9b" };
  };
  const classifyRisk = (score, suffix = "") => {
    if (score == null) return { label: "Data missing", className: "", color: "#8ea3c0" };
    if (score < 0.3) return { label: "Low" + suffix, className: "pill-good", color: "#4ade80" };
    if (score < 0.6) return { label: "Medium" + suffix, className: "pill-warn", color: "#f6c453" };
    return { label: "High" + suffix, className: "pill-risk", color: "#ff9b9b" };
  };

  const normalizeTrend = (label) => {
    if (!label) return null;
    const lower = String(label).toLowerCase();
    if (lower.includes("wors") || lower.includes("declin") || lower.includes("down")) return "Worsening";
    if (lower.includes("improv") || lower.includes("up")) return "Improving";
    return "Stable";
  };
  const growthScore = clampScore(
    opOutlook.score01 ?? proj.operationalMomentumScore ?? proj.growthContinuationScore ?? proj.futureGrowthScore
  );
  const dilutionScore = clampScore(proj.dilutionRiskScore ?? proj.dilutionRisk);
  const rawBankruptcyScore = clampScore(proj.bankruptcyRiskScore);
  const businessTrend = normalizeTrend(proj.businessTrendLabel ?? proj.deteriorationLabel);
  const trajectoryTitle = trajOutlook.label ?? proj.trajectoryLabel ?? businessTrend;
  const marketCap = Number(keyMetrics.marketCap ?? keyMetrics.marketCapTTM);
  const interestCoverSnap = toNumber(snapshot.interestCoverage);
  const netDebtYears = toNumber(snapshot.netDebtToFcfYears ?? snapshot.netDebtToFCFYears);
  const largeCap = Number.isFinite(marketCap) && marketCap >= 5e10;
  const revenueSlope = toNumber(proj.revenueSlope);
  const marginSlope = toNumber(proj.marginSlope);
  const ocfSlope = toNumber(proj.ocfTrendSlope);
  let bankruptcyScore = rawBankruptcyScore;
  if (largeCap && bankruptcyScore !== null) {
    const strongCover = Number.isFinite(interestCoverSnap) && interestCoverSnap > 8;
    const lightLeverage = Number.isFinite(netDebtYears) && netDebtYears < 2;
    const cap = (strongCover || lightLeverage) ? 0.25 : 0.35;
    bankruptcyScore = Math.min(bankruptcyScore, cap);
  }

  const growthMeta = classifyGrowth(growthScore);
  // Override label if server provided a specific momentum label (new or legacy)
  if (opOutlook.label) growthMeta.label = opOutlook.label;
  else if (proj.operationalMomentumLabel) growthMeta.label = proj.operationalMomentumLabel;
  else if (proj.growthContinuationLabel) growthMeta.label = proj.growthContinuationLabel;
  const dilutionMeta = classifyRisk(dilutionScore);
  const bankruptcyMeta = classifyRisk(bankruptcyScore, " Risk");

  const trajectoryCopy =
    trajOutlook.narrative ||
    (businessTrend === "Improving"
      ? "Revenue and FCF slopes are strengthening."
      : businessTrend === "Worsening"
        ? "Key profitability or cash metrics are deteriorating."
        : "Core metrics are moving sideways.");
  const trajectoryRegime = String(trajOutlook.regime || "").toLowerCase();
  const trajectoryColor =
    trajectoryRegime === "grow"
      ? "#5ce0c2"
      : trajectoryRegime === "fade"
        ? "#ff9b9b"
        : trajectoryTitle === "Improving"
          ? "#5ce0c2"
          : trajectoryTitle === "Worsening"
            ? "#ff9b9b"
            : "#e0e8f5";
  const ocfTrend =
    snapshot.operatingCashFlowTrend4Q === "up"
      ? "up"
      : snapshot.operatingCashFlowTrend4Q === "down"
        ? "down"
        : snapshot.operatingCashFlowTrend4Q === "flat"
          ? "flat"
          : "n/a";
  const growthContext =
    businessTrend === "Improving"
      ? "Revenue & cash flow trending upward."
      : businessTrend === "Worsening"
        ? "Growth momentum may be fading."
        : "Signals are balanced; momentum is steady.";
  const driverText = (() => {
    const MIN_DRIVER_WEIGHT = 0.01;
    const candidates = [];
    if (Number.isFinite(revenueSlope)) candidates.push({ label: revenueSlope >= 0 ? "revenue improving" : "revenue softening", weight: Math.abs(revenueSlope) });
    if (Number.isFinite(marginSlope)) candidates.push({ label: marginSlope >= 0 ? "margins improving" : "margins deteriorating", weight: Math.abs(marginSlope) });
    if (Number.isFinite(ocfSlope)) candidates.push({ label: ocfSlope >= 0 ? "OCF strengthening" : "OCF weakening", weight: Math.abs(ocfSlope) });
    candidates.sort((a, b) => (b.weight || 0) - (a.weight || 0));
    const top = candidates[0];
    if (!top || top.weight < MIN_DRIVER_WEIGHT) return "Drivers: mixed / no clear trend.";
    const second = candidates[1];
    if (second && second.weight >= MIN_DRIVER_WEIGHT) return `Driven by ${top.label} and ${second.label}.`;
    return `Driven by ${top.label}.`;
  })();
  const momentumMicro = `Revenue CAGR (3Y): ${pctf(snapshot.revenueCAGR3Y)} | OCF trend: ${ocfTrend}`;
  const momentumSource = "Source: Strategic Outlook (fundamentals + filings)";

  // Removed barWidth calculation as bars are being removed/hidden or just decorative
  const barWidth = (score) => `${(clampScore(score) ?? 0) * 100}%`;

  // Restoring grid.style for card layout compatibility
  grid.style.display = "grid";
  // Re-implementing cards - Removing Risk Radar as requested
  grid.style.gridTemplateColumns = "1fr 1fr"; // Force 2 columns
  grid.innerHTML = `
        <div class="future-card">
          <div class="future-label">Operational momentum</div>
          <div class="future-value-row">
            <div class="future-value" style="font-size:1.3em;">${growthMeta.label}</div>
          </div>
          <div class="future-bar"><div class="fill" style="width:${barWidth(growthScore)}; background:${growthMeta.color};"></div></div>
          <div class="future-footnote">Momentum (model-based)</div>
          <div class="future-note">${momentumSource}${growthContext ? ` ${growthContext}` : ""}${driverText ? ` ${driverText}` : ""}</div>
        </div>
        <div class="future-card">
          <div class="future-label">Trajectory</div>
          <div class="trajectory-title" style="color:${trajectoryColor};">${trajectoryTitle || "Pending"}</div>
          <div class="trajectory-narrative">${trajectoryCopy}</div>
          <div class="chip-row">
            <div class="mini-chip">Net Margin (TTM): ${pctf(snapshot.netMarginTTM)}</div>
            <div class="mini-chip">Free Cash Flow (TTM): ${nf(snapshot.freeCashFlowTTM)}</div>
          </div>
        </div>
      `;
}

function buildStockFromStatements(all) {
  const {
    income = [],
    balance = [],
    cash = [],
    keyMetrics = [],
    ratios = [],
    keyMetricsTtm = [],
    ratiosTtm = [],
    financialScores = [],
    ownerEarnings = [],
    incomeGrowth = [],
    priceFull = [],
    priceSummary = null,
    sector = null,
    runwayYears = null,
    narrative = null
  } = all || {};
  const inc = income; const bal = balance; const cf = cash;
  const curInc = inc[0] || {}; const prevInc = inc[1] || {}; const curBal = bal[0] || {}; const prevBal = bal[1] || {}; const curCf = cf[0] || {};
  const ratiosLatest = ratios?.[0] || {}; const ratiosT = ratiosTtm?.[0] || {}; const keyLatest = keyMetrics?.[0] || {}; const keyT = keyMetricsTtm?.[0] || {}; const scoreObj = financialScores?.[0] || {};
  const owner = ownerEarnings?.[0] || {};
  const incGrowthLatest = incomeGrowth?.[0] || {};
  const sectorBucket = resolveSectorBucket(sector);
  const revGrowth = pctChange(toNumber(curInc.revenue), toNumber(prevInc.revenue)) ?? pctFromRatio(incGrowthLatest.revenueGrowth);
  const sharesChange = pctChange(toNumber(curBal.commonStockSharesOutstanding), toNumber(prevBal.commonStockSharesOutstanding));
  const sharesChangeYoY = (() => {
    if (inc.length >= 5) {
      const prevYear = income[4]?.revenue !== undefined ? balance[4] : null;
      if (prevYear) return pctChange(toNumber(curBal.commonStockSharesOutstanding), toNumber(prevYear.commonStockSharesOutstanding));
    }
    if (inc.length >= 2) return sharesChange;
    return null;
  })();
  const fcf = calcFcf(curCf);
  const fcfMarginLatest = calcMargin(fcf, toNumber(curInc.revenue));
  const prevFcf = calcFcf(prevInc ? cf[1] : null);
  const prevFcfMargin = prevInc ? calcMargin(prevFcf, toNumber(prevInc.revenue)) : null;
  const fcfMarginTtm = (() => {
    const fcfTtm = toNumber(currentVm?.snapshot?.freeCashFlowTTM ?? currentVm?.ttm?.freeCashFlow);
    const revTtm = toNumber(currentVm?.ttm?.revenue);
    if (!Number.isFinite(fcfTtm) || !Number.isFinite(revTtm) || revTtm === 0) return null;
    return (fcfTtm / revTtm) * 100;
  })();
  const profitGrowth = pctChange(toNumber(curInc.netIncome), toNumber(prevInc.netIncome));
  const fcfTrend = pctChange(fcfMarginLatest, prevFcfMargin);
  const positiveEbitdaQuarters = inc.slice(0, 4).filter((q) => toNumber(q.operatingIncome) > 0).length;
  const fcfYears = (fcf && toNumber(curBal.totalDebt) && fcf > 0) ? (toNumber(curBal.totalDebt) / (fcf * 4)) : null;
  const debtBal = toNumber(
    curBal.totalDebt ??
    curBal.financialDebt ??
    curBal.longTermDebt ??
    curBal.longTermDebtNoncurrent ??
    curBal.shortLongTermDebtTotal ??
    curBal.shortTermDebt ??
    curBal.totalDebtAndCapitalLeaseObligation
  );
  const debtReported = hasDebtField(curBal) || Number.isFinite(debtBal);
  const cashBal = toNumber(
    curBal.cashAndCashEquivalents ??
    curBal.cashAndCashEquivalentsAtCarryingValue ??
    curBal.cashAndCashEquivalentsAndShortTermInvestments ??
    curBal.cashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents ??
    curBal.cashAndShortTermInvestments ??
    curBal.cash
  );
  const cashReported = hasCashField(curBal) || Number.isFinite(cashBal);
  const debtIsZero = debtReported && debtBal === 0;
  const stiBal = toNumber(curBal.shortTermInvestments);
  const netDebt = (() => {
    if (!Number.isFinite(debtBal)) return null;
    if (!Number.isFinite(cashBal) && !Number.isFinite(stiBal)) {
      if (debtBal === 0) return 0; // Debt is zero, so Net Debt is at least <= 0
      return null; // Both missing, can't compute
    }
    const cashTotal = (Number.isFinite(cashBal) ? cashBal : 0) + (Number.isFinite(stiBal) ? stiBal : 0);
    return debtBal - cashTotal;
  })();
  const netCash = Number.isFinite(netDebt) && netDebt < 0;
  const netDebtToFcfYears = (() => {
    if (!Number.isFinite(netDebt) || !Number.isFinite(fcf) || fcf <= 0) return null;
    return netDebt / (fcf * 4);
  })();
  const roe = pctFromRatio(
    ratiosLatest.returnOnEquity
    ?? ratiosT.returnOnEquity
    ?? keyLatest.roe
    ?? keyLatest.returnOnEquityTTM
    ?? keyT.roe
    ?? keyT.returnOnEquityTTM
    ?? calcMargin(toNumber(curInc.netIncome), toNumber(curBal.totalStockholdersEquity))
  );
  const roic = pctFromRatio(
    ratiosLatest.returnOnInvestedCapital
    ?? ratiosT.returnOnInvestedCapital
    ?? keyLatest.returnOnInvestedCapital
    ?? keyT.returnOnInvestedCapital
  );
  const capexToRev = calcMargin(toNumber(curCf.capitalExpenditure), toNumber(curInc.revenue));
  const sbc = toNumber(
    curCf.shareBasedCompensation ??
    curCf.shareBasedCompensationExpense ??
    curCf.stockBasedCompensation ??
    curCf.stockBasedCompensationExpense ??
    curInc.shareBasedCompensation ??
    curInc.shareBasedCompensationExpense ??
    curInc.stockBasedCompensation ??
    curInc.stockBasedCompensationExpense
  );
  const sbcToRevenue = (() => {
    const rev = toNumber(curInc.revenue);
    if (!Number.isFinite(sbc) || !Number.isFinite(rev) || rev <= 0) return null;
    return (sbc / rev) * 100;
  })();
  const grossMargin = pctFromRatio(ratiosLatest.grossProfitMargin) ?? calcMargin(toNumber(curInc.grossProfit), toNumber(curInc.revenue));
  const prevGrossMargin = calcMargin(toNumber(prevInc.grossProfit), toNumber(prevInc.revenue));
  const opMargin = pctFromRatio(ratiosLatest.operatingProfitMargin) ?? calcMargin(toNumber(curInc.operatingIncome), toNumber(curInc.revenue));
  const prevOpMargin = pctFromRatio(calcMargin(Number(prevInc.operatingIncome), Number(prevInc.revenue)));
  const marginTrend = pctChange(opMargin, prevOpMargin);
  const netMargin = pctFromRatio(ratiosLatest.netProfitMargin) ?? calcMargin(toNumber(curInc.netIncome), toNumber(curInc.revenue));
  const currentRatio = toNumber(
    ratiosLatest.currentRatio
    ?? ratiosT.currentRatio
    ?? ratiosT.currentRatioTTM
    ?? ((toNumber(curBal.totalCurrentAssets) && toNumber(curBal.totalCurrentLiabilities))
      ? toNumber(curBal.totalCurrentAssets) / toNumber(curBal.totalCurrentLiabilities)
      : null)
  );
  const quickRatio = toNumber(
    ratiosLatest.quickRatio
    ?? ratiosT.quickRatio
    ?? ratiosT.quickRatioTTM
  );
  const interestCoverageTtm = (() => {
    const pairs = [];
    for (let i = 0; i < Math.min(4, inc.length); i += 1) {
      const ebit = toNumber(inc[i]?.operatingIncome);
      const interest = toNumber(balance[i]?.interestExpense ?? inc[i]?.interestExpense);
      if (Number.isFinite(ebit) && Number.isFinite(interest)) {
        pairs.push({ ebit, interest: Math.abs(interest) });
      }
    }
    if (pairs.length < 2) return { value: null, periods: pairs.length };
    const ebitSum = pairs.reduce((acc, p) => acc + p.ebit, 0);
    const interestSum = pairs.reduce((acc, p) => acc + p.interest, 0);
    if (!Number.isFinite(ebitSum) || !Number.isFinite(interestSum) || interestSum === 0) {
      return { value: null, periods: pairs.length };
    }
    return { value: ebitSum / interestSum, periods: pairs.length };
  })();
  const interestCoverage = interestCoverageTtm.value ?? toNumber(ratiosLatest.interestCoverage ?? ratiosT.interestCoverage);
  const debtToEquity = toNumber(
    ratiosLatest.debtEquityRatio
    ?? ratiosLatest.debtToEquity
    ?? ratiosT.debtEquityRatio
    ?? ratiosT.debtToEquity
    ?? (curBal.totalDebt && curBal.totalStockholdersEquity ? curBal.totalDebt / curBal.totalStockholdersEquity : null)
  );
  const psRatio = toNumber(keyLatest.priceToSalesRatio ?? keyLatest.priceToSalesRatioTTM ?? ratiosLatest.priceToSalesRatio ?? ratiosT.priceToSalesRatio);
  const pbRatio = toNumber(keyLatest.priceToBookRatio ?? ratiosLatest.priceToBookRatio ?? ratiosT.priceToBookRatio);
  const peRatio = toNumber(keyLatest.peRatio ?? ratiosLatest.priceEarningsRatio ?? ratiosT.priceEarningsRatio);
  const pfcfRatio = toNumber(keyLatest.pfcfRatio ?? keyLatest.priceToFreeCashFlowsRatio ?? ratiosLatest.priceToFreeCashFlowsRatio ?? ratiosT.priceToFreeCashFlowsRatio);
  const fcfYield = pctFromRatio(ratiosLatest.freeCashFlowYieldTTM ?? ratiosT.freeCashFlowYieldTTM ?? ratiosLatest.freeCashFlowPerShareTTM);
  const evToEbitda = toNumber(keyLatest.enterpriseValueOverEBITDA ?? ratiosLatest.enterpriseValueMultiple ?? ratiosT.enterpriseValueMultiple);
  const ownerE = toNumber(owner.ownerEarnings ?? owner.ownerEarningsTTM);
  const priceStats = computePriceStats(priceFull);
  priceStats.high52 = priceSummary?.high52w ?? priceStats.high52;
  priceStats.low52 = priceSummary?.low52w ?? priceStats.low52;
  priceStats.lastClose = priceSummary?.lastClose ?? priceStats.latestPrice ?? null;
  return {
    ticker,
    sector,
    sectorBucket,
    revenueLatest: toNumber(curInc.revenue),
    cashLatest: toNumber(curBal.cashAndCashEquivalents ?? curBal.cash),
    growth: { revenueGrowthTTM: revGrowth, revenueCagr3y: pctFromRatio(keyLatest.threeYRevenueGrowthPerShare ?? keyLatest.threeYearRevenueGrowthPerShare), perShareGrowth: pctFromRatio(keyLatest.freeCashFlowPerShareTTM ?? keyLatest.freeCashFlowPerShareGrowth) },
    momentum: { marginTrend, fcfTrend, grossMarginPrev: prevGrossMargin },
    profitGrowthTTM: profitGrowth,
    stability: {
      growthYearsCount: null,
      fcfPositiveYears: cf.filter(r => calcFcf(r) > 0).length,
      ebitdaPositiveQuarters: positiveEbitdaQuarters
    },
    profitMargins: {
      grossMargin,
      operatingMargin: opMargin,
      profitMargin: netMargin,
      fcfMargin: fcfMarginTtm,
      fcfMarginLatest,
      netIncome: toNumber(curInc.netIncome)
    },
    financialPosition: {
      currentRatio,
      quickRatio,
      debtToEquity,
      netDebtToEquity: null,
      debtToEbitda: toNumber(ratiosLatest.debtToAssets),
      debtToFCF: null,
      interestCoverage,
      netDebtToFcfYears: netDebtToFcfYears ?? fcfYears,
      netCashToPrice: null,
      runwayYears,
      debtReported,
      cashReported,
      debtIsZero,
      netCash,
      netDebt,
      totalDebt: debtBal,
      cashBalance: cashBal,
      shortTermInvestments: stiBal
    },
    returns: { roe, roic },
    cash: { cashConversion: fcf != null && toNumber(curInc.netIncome) ? fcf / toNumber(curInc.netIncome) : null, capexToRevenue: capexToRev },
    shareStats: { sharesOutstanding: curBal.commonStockSharesOutstanding, sharesChangeYoY, sharesChangeQoQ: sharesChange, likelySplit: !!currentVm?.snapshot?.splitSignal, insiderOwnership: toNumber(currentVm?.snapshot?.heldPercentInsiders), institutionOwnership: null, float: null },
    valuationRatios: { peRatio, forwardPE: toNumber(keyLatest.forwardPE), psRatio, forwardPS: toNumber(keyLatest.forwardPS), pbRatio, pfcfRatio, pegRatio: toNumber(keyLatest.pegRatio), evToEbitda, fcfYield },
    expenses: {
      rdToRevenue: pctFromRatio(curInc.researchAndDevelopmentExpenses && curInc.revenue ? curInc.researchAndDevelopmentExpenses / curInc.revenue * 100 : null),
      sbcToRevenue
    },
    capitalReturns: { shareholderYield: pctFromRatio(keyLatest.shareholderYieldTTM), totalYield: pctFromRatio(keyLatest.shareholderYieldTTM) },
    dividends: { payoutToFcf: pctFromRatio(ratiosLatest.dividendPayoutRatio ?? ratiosT.dividendPayoutRatio), growthYears: toNumber(keyLatest.dividendGrowthYears) },
    priceStats,
    scores: { altmanZ: toNumber(scoreObj.altmanZScore ?? scoreObj.altmanZscore), piotroskiF: toNumber(scoreObj.piotroskiScore ?? scoreObj.piotroskiFScore ?? scoreObj.piotroskiFscore) },
    ownerEarnings: ownerE,
    ownerIncomeBase: toNumber(curInc.netIncome),
    lastUpdated: curInc.date || curInc.filingDate || curInc.fillingDate || "n/a",
    narrative // Pass through for UI
  };
}

function computeRunwayYears(vm) {
  if (!vm) return null;
  const sectorBucket = resolveSectorBucket(vm?.sector || vm?.sectorBucket);
  if (sectorBucket === "Financials") return null; // Lending cash flows distort runway math
  const series = (vm.quarterlySeries && vm.quarterlySeries.length ? vm.quarterlySeries : vm.annualSeries || []);
  const latestQuarter = [...series].sort((a, b) => Date.parse(b.periodEnd) - Date.parse(a.periodEnd))[0] || {};
  const rawCash = latestQuarter.cash ?? latestQuarter.cashAndCashEquivalents;
  const rawSti = latestQuarter.shortTermInvestments;
  const cash = toNumber(rawCash);
  const sti = toNumber(rawSti);
  if (rawCash == null && rawSti == null) return null; // don't assume zero cash when it's unreported
  const cashTotal = (Number.isFinite(cash) ? cash : 0) + (Number.isFinite(sti) ? sti : 0);
  const fcfTtm = toNumber(vm.snapshot?.freeCashFlowTTM ?? vm.ttm?.freeCashFlow);
  if (!Number.isFinite(cashTotal) || !Number.isFinite(fcfTtm)) return null;
  if (fcfTtm >= 0) return Infinity;
  if (cashTotal <= 0) return 0;
  return cashTotal / Math.abs(fcfTtm);
}

function isPennyStockVm(vm = currentVm, stock = {}) {
  if (vm?.pennyStock) return true;

  const bucket = resolveSectorBucket(vm?.sector || vm?.sectorBucket);
  const isBio = isBiotechSector(bucket) ||
    (vm?.sicDescription && /pharm|bio|drug|device/i.test(vm?.sicDescription)) ||
    (vm?.companyName && /therapeutics|pharm|bio|sciences|medicine/i.test(vm?.companyName));

  const latestPrice = (() => {
    if (Number.isFinite(vm?.priceSummary?.lastClose)) return Number(vm.priceSummary.lastClose);
    const hist = Array.isArray(vm?.priceHistory) ? vm.priceHistory.slice() : [];
    const sorted = hist.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
    return Number(sorted[0]?.close);
  })();
  const marketCap = Number(
    vm?.keyMetrics?.marketCap ?? vm?.snapshot?.marketCap ?? stock?.valuationRatios?.marketCap ?? stock?.marketCap
  );
  const dilution = percentToNumber(
    stock?.shareStats?.sharesChangeYoY ?? vm?.snapshot?.sharesOutChangeYoY ?? vm?.snapshot?.sharesOutChangeYoYRaw
  );
  const runway = computeRunwayYears(vm);

  return (
    (!isBio && Number.isFinite(latestPrice) && latestPrice < 5) ||
    (!isBio && Number.isFinite(marketCap) && marketCap > 0 && marketCap < 200_000_000) ||
    (isBio && Number.isFinite(marketCap) && marketCap > 0 && marketCap < 50_000_000) ||
    (Number.isFinite(dilution) && dilution > 25) ||
    (Number.isFinite(runway) && runway < 1)
  );
}

function computeFcfMargin(vm) {
  const fcf = toNumber(vm?.snapshot?.freeCashFlowTTM ?? vm?.ttm?.freeCashFlow);
  const rev = toNumber(vm?.ttm?.revenue);
  if (!Number.isFinite(fcf) || !Number.isFinite(rev) || rev === 0) return null;
  return (fcf / rev) * 100;
}

function computeGamificationSignals(vm = {}, stock = {}) {
  const bankruptcyRisk = toNumber(vm?.projections?.bankruptcyRiskScore);
  const dilutionYoY = toNumber(stock?.shareStats?.sharesChangeYoY ?? vm?.snapshot?.sharesOutChangeYoY);
  const fcfMargin = computeFcfMargin(vm);
  const runwayYears = computeRunwayYears(vm);
  const operationalRiskHigh =
    vm?.projections?.businessTrendLabel === "Worsening" ||
    vm?.snapshot?.operatingCashFlowTrend4Q === "down";
  const sbcToRevenue = toNumber(stock?.expenses?.sbcToRevenue);
  const growthContinuation = toNumber(vm?.projections?.growthContinuationScore);
  const roe = toNumber(vm?.keyMetrics?.roe);
  const profitability = toNumber(vm?.snapshot?.netMarginTTM ?? null);
  const revenueCagr = toNumber(vm?.snapshot?.revenueCAGR3Y ?? vm?.growth?.revenueCagr3y);
  const dilutionRiskScore = toNumber(vm?.projections?.dilutionRiskScore);
  const toPct = (val) => {
    if (val === null || val === undefined) return null;
    const num = Number(val);
    if (!Number.isFinite(num)) return null;
    return Math.abs(num) <= 1 ? num * 100 : num;
  };
  const netMarginPct = toPct(profitability);
  const roePct = toPct(roe);
  const revenueCagrPct = toPct(revenueCagr);

  return {
    red: {
      bankruptcyRisk: bankruptcyRisk != null && bankruptcyRisk > 0.5,
      runwayShort: runwayYears != null && runwayYears < 1,
      // Dilution is expressed as percentage points (e.g., 25 = +25% YoY).
      dilutionHigh: dilutionYoY != null && dilutionYoY > 20,
      fcfMarginDeep: fcfMargin != null && fcfMargin < -80,
      operationalRiskHigh
    },
    orange: {
      runwayTight: runwayYears != null && runwayYears >= 1 && runwayYears < 2,
      heavySbc: sbcToRevenue != null && sbcToRevenue > 15,
      inconsistentGrowth: growthContinuation != null && growthContinuation < 0.3
    },
    green: {
      profitability: netMarginPct != null && netMarginPct > 5 && fcfMargin != null && fcfMargin > 0,
      roeStrong: roePct != null && roePct > 12,
      growthGood:
        (growthContinuation != null && growthContinuation >= 0.6) ||
        (revenueCagrPct != null && revenueCagrPct > 10),
      lowDilution: dilutionYoY != null && dilutionYoY <= 2 && (!dilutionRiskScore || dilutionRiskScore < 0.3)
    },
    runwayYears,
    fcfMargin
  };
}

function resolveZoneForRule(ruleName, signals) {
  if (!signals) return null;
  const red = signals.red || {};
  const orange = signals.orange || {};
  const green = signals.green || {};
  const redAny = Object.values(red).some(Boolean);
  const orangeAny = Object.values(orange).some(Boolean);
  const greenAny = Object.values(green).some(Boolean);

  const redRules = {
    bankruptcyRisk: ["Net debt / FCF (years)", "Net debt / equity", "Interest coverage"],
    runwayShort: ["FCF margin", "Net margin", "Capex intensity"],
    dilutionHigh: ["Shares dilution YoY", "SBC / revenue"],
    fcfMarginDeep: ["FCF margin"],
    operationalRiskHigh: ["Operating leverage", "Revenue growth YoY", "FCF growth YoY"]
  };
  for (const [key, list] of Object.entries(redRules)) {
    if (red[key] && list.includes(ruleName)) return "zone-red";
  }

  const orangeRules = {
    runwayTight: ["FCF margin", "Net margin", "Capex intensity"],
    heavySbc: ["SBC / revenue", "Shares dilution YoY"],
    inconsistentGrowth: ["Operating leverage", "Revenue growth YoY", "FCF growth YoY"]
  };
  for (const [key, list] of Object.entries(orangeRules)) {
    if (orange[key] && list.includes(ruleName)) return "zone-orange";
  }

  const greenRules = {
    profitability: ["Net margin", "FCF margin"],
    roeStrong: ["ROE"],
    growthGood: ["Revenue growth YoY", "Operating leverage", "FCF growth YoY"],
    lowDilution: ["Shares dilution YoY"]
  };
  for (const [key, list] of Object.entries(greenRules)) {
    if (green[key] && list.includes(ruleName)) return "zone-green";
  }

  if (redAny) return "zone-red";
  if (orangeAny) return "zone-orange";
  if (greenAny) return "zone-green";
  return null;
}

function renderScoreboard(reasonList = [], stock = {}, ratingMeta = null, completeness = null) {
  const scoreReasonsEl = document.getElementById("scoreReasons");
  scoreReasonsEl.className = "reason-grid";
  const missingReasonsEl = document.getElementById("missingReasons");
  const missingToggle = document.getElementById("missingToggle");
  if (missingToggle) missingToggle.style.display = "none"; // hide toggle in prod
  scoreReasonsEl.innerHTML = "";
  missingReasonsEl.innerHTML = "";
  const achievementsEl = document.getElementById("achievements");
  if (achievementsEl) {
    achievementsEl.innerHTML = "";
    achievementsEl.style.display = "none";
  }

  const friendlyReasonName = (name) => {
    const peRegex = /\b(p\/?e|price\s*\/\s*earnings|price\s*to\s*earnings)\b/i;
    const deRegex = /\bdebt\s*(\/|to)\s*equity\b|\bd\s*\/\s*e\b/i;
    const n = String(name || "").toLowerCase();
    if (/capital return/.test(n)) return "Capital Return";
    if (/innovation investment/.test(n)) return "Innovation Investment";
    if (/working capital/.test(n)) return "Working Capital";
    if (/effective tax rate/.test(n)) return "Effective Tax Rate";
    if (/price\s*\/\s*sales|p\/?s/.test(n)) return "Price vs Sales";
    if (/price\s*\/\s*book|p\/?b/.test(n)) return "Price vs Book Value";
    if (peRegex.test(n)) return "Price vs Earnings";
    if (/net debt.*fcf/.test(n)) return "Debt Payback Time";
    if (/debt maturity runway/.test(n)) return "Debt Maturity Mix";
    if (deRegex.test(n)) return "Debt Level (D/E)";
    if (/interest coverage/i.test(n)) return "Interest Coverage";
    if (/fcf margin/i.test(n)) return "Cash Profit Margin";
    if (/cash runway/i.test(n)) return "Cash Remaining (Runway)";
    if (/dilution/i.test(n)) return "Share Count Change";
    if (/share buybacks|buybacks/.test(n)) return "Share Buybacks";
    if (/drawdown/i.test(n)) return "Drop from Highs";
    if (/gross margin/i.test(n)) return "Gross Profit Margin";
    if (/operating leverage/i.test(n)) return "Operating Leverage";
    if (/roe/.test(n)) return "Return on Equity";
    if (/roic/.test(n)) return "Return on Invested Capital";
    if (/cagr/i.test(n)) return "Growth Trend (3Y)";
    if (/50d.*200d|moving average|trend/i.test(n)) return "Price Trend";
    if (/rd intensity|r&d/.test(n)) return "R&D Investment";
    if (/capex intensity/.test(n)) return "Reinvestment Rate";
    if (/revenue growth/i.test(n)) return "Revenue Growth";
    return null;
  };

  const friendlyReasonMessage = (message) => {
    const msg = String(message || "").trim();
    if (/No P\/S data/i.test(msg)) return "Missing Price vs Sales data";
    if (/No P\/B data/i.test(msg)) return "Missing Price vs Book data";
    const hasLastClose = Number.isFinite(currentVm?.priceSummary?.lastClose);
    if (/No price data/i.test(msg)) {
      return hasLastClose ? "Price history unavailable; using last close only." : "Price data missing";
    }
    if (/No moving average data/i.test(msg)) {
      return hasLastClose ? "Price history too thin for moving averages." : "Moving average data missing";
    }
    if (/No gross margin data/i.test(msg)) return "Margin data missing";
    if (/No ROIC data/i.test(msg)) return "ROIC data missing";
    if (/No EPS CAGR data/i.test(msg)) return "EPS growth data missing";
    if (/No CAGR data/i.test(msg)) return "Growth data missing";
    if (/No dividend payout data/i.test(msg)) return "Dividend data missing";
    if (/Not applicable/i.test(msg)) return msg; // keep explicit NA
    return msg;
  };

  const reasons = Array.isArray(reasonList) ? reasonList.slice() : [];
  const missing = reasons.filter(r => r.missing);
  // Filter out Neutral (0 score) items and explicitly N/A items to reduce nose
  const applicable = reasons.filter(r => !r.missing && !r.notApplicable && r.score !== 0);
  applicable.sort((a, b) => Math.abs(b.score) - Math.abs(a.score) || b.score - a.score);
  const dilutionYoY = toNumber(
    stock?.shareStats?.sharesChangeYoY ??
    currentVm?.snapshot?.sharesOutChangeYoY ??
    currentVm?.snapshot?.sharesOutChangeYoYRaw
  );
  const hasGoingConcernReason = reasons.some(
    (r) => /going.?concern/i.test(r?.name || "") || /going.?concern/i.test(r?.message || "")
  );
  const hasGoingConcernSignal =
    Array.isArray(filingSignals) &&
    filingSignals.some(
      (sig) =>
        sig?.id === "going_concern" ||
        /going.?concern/i.test(sig?.title || "") ||
        /going.?concern/i.test(sig?.snippet || "")
    );
  const netIncomeTrend =
    percentToNumber(stock?.profitGrowthTTM) ??
    percentToNumber(currentVm?.snapshot?.netIncomeTrend) ??
    percentToNumber(currentVm?.snapshot?.profitGrowthTTM) ??
    (() => {
      const inc = currentVm?.income || currentVm?.incomeStatements;
      return Array.isArray(inc) ? yoyChange(inc, "netIncome") : null;
    })();
  const hasGoingConcernFlag =
    hasGoingConcernSignal ||
    hasGoingConcernReason ||
    currentVm?.snapshot?.goingConcern === true ||
    currentVm?.snapshot?.goingConcernFlag === true ||
    currentVm?.snapshot?.warnings?.includes?.("going concern") ||
    currentVm?.projections?.goingConcern === true ||
    currentVm?.flags?.goingConcern === true ||
    currentVm?.ratingMeta?.goingConcern === true ||
    currentVm?.ratingMeta?.flags?.goingConcern === true;
  // More nuanced distressed detection - only flag truly troubled companies
  const marketCap = toNumber(
    currentVm?.keyMetrics?.marketCap ?? currentVm?.snapshot?.marketCap ?? stock?.marketCap
  );
  const fcfMargin = computeFcfMargin(currentVm);
  const runwayYears = computeRunwayYears(currentVm);
  const bankruptcyRisk = toNumber(currentVm?.projections?.bankruptcyRiskScore);
  const netMargin = toNumber(currentVm?.snapshot?.netMarginTTM ?? stock?.profitMargins?.profitMargin);
  const isEstablished = Number.isFinite(marketCap) && marketCap > 10_000_000_000; // >$10B = established
  const isProfitable = Number.isFinite(netMargin) && netMargin > 0;
  const hasPositiveCashFlow = Number.isFinite(fcfMargin) && fcfMargin > 0;

  const isDistressed =
    !!hasGoingConcernFlag ||
    (Number.isFinite(dilutionYoY) && dilutionYoY > 50) ||
    (Number.isFinite(netIncomeTrend) && netIncomeTrend < -40) ||
    (Number.isFinite(runwayYears) && runwayYears < 1) ||
    (Number.isFinite(bankruptcyRisk) && bankruptcyRisk > 0.5);

  // Only apply caution messages to truly troubled companies, not profitable established ones
  const shouldShowCautions = isDistressed && !isEstablished && (!isProfitable || !hasPositiveCashFlow);
  const psCautions = [
    "Price is low because the market expects trouble, not because it's cheap.",
    "Cheap price might mean investors are worried about survival.",
    "Low price likely reflects fear about running out of cash.",
    "Low price suggests financial distress, not a bargain.",
    "Cheap valuations can signal a broken business, not a hidden gem."
  ];
  const deCautions = [
    "Low debt is due to selling more shares, not business strength.",
    "Debt looks low only because they sold so much stock.",
    "Debt seems low, but it's likely due to share dilution.",
    "Low debt/equity ratio is misleading due to dilution.",
    "Selling stock distorts the debt ratio; don't assume it's safe."
  ];
  const pickVariant = (arr, seed = 1) => {
    if (!arr.length) return "";
    const s = Math.abs(Math.floor(seed)) || 1;
    return arr[s % arr.length];
  };
  const tickerSeed = (stock?.ticker || ticker || "").split("").reduce((acc, ch) => acc + ch.charCodeAt(0), 0) || 1;
  const iconPool = [
    "&#128200;", // chart rising
    "&#128202;", // bar chart
    "&#128176;", // money bag
    "&#128184;", // money with wings
    "&#127974;", // bank
    "&#128181;", // banknote
    "&#127942;", // trophy
    "&#128188;", // briefcase
    "&#128201;", // chart trend
    "&#128640;", // rocket
    "&#128293;", // fire
    "&#128179;"  // credit card
  ];
  const usedIcons = new Set();
  applicable.forEach(reason => {
    const div = document.createElement("div");
    const highlight = /^(Capital Return|Innovation Investment|Working Capital|Effective Tax Rate)$/.test(String(reason?.name || ""));
    const numericForBadge = Number(reason.score) || 0;
    const badgeClass = highlight
      ? (numericForBadge > 0 ? "good" : numericForBadge < 0 ? "risk" : "neutral")
      : getScoreClass(reason.score);
    div.className = "reason-card".trim();
    const explainer = ruleExplainers[reason.name] || {};
    const posText = explainer.pos || "Positive scores mean the metric meets or beats the target, reinforcing quality/valuation strength.";
    const negText = explainer.neg || "Negative scores mean the metric falls short, signaling risk, dilution, or overvaluation.";
    let numericScore = numericForBadge;
    let explainerText = numericScore >= 0 ? posText : negText;
    const reasonName = String(reason.name || "");
    const peRegex = /\b(p\/?e|price\s*\/\s*earnings|price\s*to\s*earnings)\b/i;
    const isPs = /p\/?s|price.?\/.?sales|price.?to.?sales/i.test(reasonName);
    const isDe = /\bdebt\s*(\/|to)\s*equity\b|\bd\s*\/\s*e\b/i.test(reasonName);
    const isValuation =
      isPs ||
      isDe ||
      peRegex.test(reasonName) ||
      /price.?to.?book|p\/?b|ev.?\/.?ebitda|price.?to.?fcf/i.test(reasonName);
    const isMargin = /margin|profit/i.test(reasonName);
    const isBiotech =
      resolveSectorBucket(stock?.sector || stock?.sectorBucket) === "Biotech/Pharma" ||
      (/pharm|bio|therapeutic|sciences|medicine/i.test(stock?.sicDescription || "") ||
        /pharm|bio|therapeutic|sciences|medicine/i.test(stock?.companyName || ""));
    const preRevenueBiotech = isBiotech && (!Number.isFinite(stock?.revenueLatest) || Math.abs(stock?.revenueLatest) < 1_000_000);
    // Only apply caution overlays and score caps for genuinely distressed companies
    if (shouldShowCautions && isValuation && numericScore > 2) {
      // Cap upside for distressed names but keep the message unchanged for users.
      numericScore = 2;
    }
    if (shouldShowCautions && numericScore > 0) {
      if (isPs) {
        explainerText = pickVariant(psCautions, tickerSeed + numericScore);
      } else if (isDe && Number.isFinite(dilutionYoY) && dilutionYoY > 10) {
        // Only show debt distortion warning if dilution is actually significant (>10%)
        explainerText = pickVariant(deCautions, tickerSeed + numericScore * 2);
      }
    }
    if (preRevenueBiotech && (isPs || isMargin)) {
      explainerText = "Pre-revenue biotech: focus on runway, dilution, and trial milestones; valuation/margins are less meaningful.";
    }
    let titleText = friendlyReasonName(reason.name) || toTitleCase(reason.name);
    // Custom Card Titles
    if (reason.name === "Debt / Equity" && reason.message.includes("Net Cash")) titleText = "Strong Balance Sheet";
    if (reason.name === "Shares dilution YoY") {
      const pctVal = percentToNumber(reason.message);
      const collapseRaw = percentToNumber(
        currentVm?.snapshot?.sharesOutChangeYoYRaw ??
        currentVm?.snapshot?.sharesOutChangeYoY ??
        reason.message
      );
      const collapsePct = Number.isFinite(collapseRaw) && Math.abs(collapseRaw) <= 1
        ? collapseRaw * 100
        : collapseRaw;
      const likelyReverseSplit =
        currentVm?.snapshot?.shareChangeLikelyReverseSplit ||
        currentVm?.shareStats?.likelyReverseSplit ||
        stock?.shareStats?.likelyReverseSplit ||
        (Number.isFinite(collapsePct) && collapsePct < -40);
      // Show extra precision for tiny moves so "-0.0%" becomes clearer (e.g., -0.04%)
      if (Number.isFinite(pctVal) && Math.abs(pctVal) < 0.1) {
        reason.message = `${pctVal.toFixed(2)}%`;
      }
      // Distinguish true buybacks from effectively flat share counts
      if (likelyReverseSplit) {
        titleText = "Reverse Split / Share Collapse";
        explainerText = "Share count collapsed; likely a reverse split. Treat this as dilution risk, not a buyback.";
        if (Number.isFinite(collapsePct)) {
          reason.message = `${collapsePct.toFixed(1)}%`;
        }
      } else if (Number.isFinite(pctVal) && pctVal < -0.1) {
        titleText = "Share Buybacks";
      } else if (Number.isFinite(pctVal) && pctVal > 2) {
        titleText = pctVal >= 20 ? "Heavy Dilution" : "Share Dilution";
      } else {
        titleText = "Share Count";
      }
    }
    const scoreText = numericScore > 0 ? `+${numericScore}` : (numericScore < 0 ? `${numericScore}` : "0");
    const displayValue = escapeHtml(friendlyReasonMessage(reason.message) || "N/A").replace(/\n/g, "<br>");
    const icon = iconForRule(reason.name, usedIcons, iconPool);
    const timeBasis = reason?.timeBasis ? String(reason.timeBasis) : null;
    const sourcePeriods = Array.isArray(reason?.sourcePeriods) ? reason.sourcePeriods : [];
    const sourcesText = sourcePeriods.length
      ? sourcePeriods
        .map((p) => {
          const field = p?.field ? String(p.field) : "unknown";
          const basis = p?.basis ? String(p.basis) : "unknown";
          const end = p?.periodEnd ? String(p.periodEnd) : "";
          return end ? `${field} (${basis}@${end})` : `${field} (${basis})`;
        })
        .join(" | ")
      : null;
    const normalizationApplied = reason?.normalizationApplied ? String(reason.normalizationApplied) : null;

    // Data Quality Badges
    const dqDefaults = currentVm?.dataQuality?.defaultsUsed || [];
    const dqMismatches = currentVm?.dataQuality?.materialMismatches || [];
    let badgeHtml = "";

    // 1. Net Debt Default Assumption
    if (/Debt|Leverage/i.test(reason.name) && dqDefaults.some(d => d.field === "netDebt")) {
      badgeHtml += `<div style="display:inline-block; margin-top:4px; padding:2px 5px; background:rgba(255,165,0,0.15); color:#d97706; border-radius:4px; font-size:10px; font-weight:600;">⚠️ Assumed Net Debt 0</div>`;
    }

    // 2. Period Mismatch (affects mixed-statement ratios: ROE, ROIC, Asset Turnover, Debt/Equity if using Net Debt vs EBITDA etc)
    const isMixedRatio = /ROE|ROIC|Asset Efficiency|Debt|Turnover/i.test(reason.name);
    if (isMixedRatio && dqMismatches.some(m => m.issue === "Statement Mismatch")) {
      badgeHtml += `<div style="display:inline-block; margin-top:4px; margin-right:4px; padding:2px 5px; background:rgba(255,165,0,0.15); color:#d97706; border-radius:4px; font-size:10px; font-weight:600;">⚠️ Period Mismatch</div>`;
    }

    // 3. Stale Data (affects everything really, but flag core financials)
    if (dqMismatches.some(m => m.issue === "Stale Data")) {
      badgeHtml += `<div style="display:inline-block; margin-top:4px; margin-right:4px; padding:2px 5px; background:rgba(255,165,0,0.15); color:#d97706; border-radius:4px; font-size:10px; font-weight:600;">⚠️ Stale Data (>180d)</div>`;
    }

    const basisMetaHtml = (timeBasis)
      ? `
          <div style="font-size:11px; line-height:1.35; margin-top:auto; padding-top:6px; font-weight:600; color:var(--text-main); opacity:0.85;">
            Basis: ${escapeHtml(timeBasis)}
          </div>
        `
      : `<div style="margin-top:auto;"></div>`; // Spacer to ensure alignment if basis is missing
    div.style.cssText = "display: flex; flex-direction: column; height: 100%;";
    div.innerHTML = `
          <div class="header">
            <div class="icon">${icon}</div>
            <div class="title whitespace-normal leading-tight">${titleText}</div>
            <div class="score-tag ${badgeClass}">${scoreText}</div>
          </div>
          <div class="value-pill ${badgeClass} whitespace-normal leading-tight" style="margin-top:4px;">${displayValue}</div>
          ${badgeHtml ? `<div style="margin-top:2px;">${badgeHtml}</div>` : ""}
          <div class="muted" style="font-size:12px; line-height:1.35; margin-bottom: 4px;">${explainerText}</div>
          ${basisMetaHtml}
        `;
    if (window.matchMedia("(pointer: coarse)").matches) {
      div.addEventListener("click", () => div.classList.toggle("expanded"));
    }
    scoreReasonsEl.appendChild(div);
  });
  missingReasonsEl.classList.add("hidden"); // keep hidden even if missing reasons
  const scoreEl = document.getElementById("score");
  if (scoreEl) scoreEl.textContent = ""; // hide numeric score in UI
  const resolvedCompleteness = (() => {
    if (completeness && Number.isFinite(completeness.percent)) return completeness;
    if (reasons.length) {
      const missingCount = reasons.filter(r => r.missing).length;
      const rawPct = ((reasons.length - missingCount) / reasons.length) * 100;
      // Normalize: scaled such that ~80% looks like 100%, 50% like 50%.
      // We assume <20% is trash (0), 20%->80% maps to 0->100
      const pct = Math.max(0, Math.min(100, (rawPct - 20) * 1.6));
      return { missing: missingCount, applicable: reasons.length - missingCount, percent: pct, rawPercent: rawPct };
    }
    return null;
  })();
  updateSummaries(stock);
  updatePillars(stock, ratingMeta);
  applyCompleteness(resolvedCompleteness);
}

// Tooltip for Completeness
const completenessPill = document.getElementById("completenessPill");
if (completenessPill) {
  const tooltip = document.createElement("div");
  tooltip.id = "completenessTooltip";
  tooltip.style.cssText = "position:absolute; background:rgba(15,23,42,0.95); color:#fff; padding:8px 12px; border-radius:8px; border:1px solid rgba(255,255,255,0.1); font-size:12px; max-width:220px; display:none; z-index:100; pointer-events:none; box-shadow:0 10px 25px -5px rgba(0,0,0,0.5);";
  tooltip.textContent = "Confidence Score: Indicates data completeness. Higher score means fewer missing metrics in the analysis.";
  document.body.appendChild(tooltip);

  completenessPill.addEventListener("mouseenter", () => {
    const rect = completenessPill.getBoundingClientRect();
    tooltip.style.left = `${rect.left}px`;
    tooltip.style.top = `${rect.bottom + 8}px`;
    tooltip.style.display = "block";
  });
  completenessPill.addEventListener("mouseleave", () => {
    tooltip.style.display = "none";
  });
}

function renderSnapshot(income, balance, cash, keyMetrics, keyMetricsTtm, ratios, priceSeries, latestPrice) {
  renderMomentumCards(income, cash, ratios);
  renderSparklineBlocks(income, cash);
}

function renderMomentumCards(income, cash, ratios) {
  const grid = document.getElementById("momentumGrid");
  if (!grid) return;
  grid.innerHTML = "";
  const revTrend = yoyChange(income, "revenue");
  const epsTrend = yoyChange(income, "eps")
    ?? yoyChange(income, "epsdiluted")
    ?? yoyChange(income, "epsDiluted")
    ?? yoyChange(income, "netIncome");
  const fcfTrend = yoyChange(cash, "fcfComputed", (r) => calcFcf(r));
  const netMarginTrend = marginDelta(income);
  const cards = [
    { label: "Revenue Trend", change: revTrend, suffix: "YoY" },
    { label: "EPS Trend", change: epsTrend, suffix: "YoY" },
    { label: "Cash Trend", change: fcfTrend, suffix: "YoY", formatter: (val) => val?.toFixed(1) + "%" },
    { label: "Margin Trend", change: netMarginTrend, suffix: "ppt YoY", formatter: (val) => val === null ? null : `${val >= 0 ? "+" : ""}${val.toFixed(1)}` }
  ];
  cards.forEach(card => {
    const div = document.createElement("div");
    div.className = "momentum-card";
    const trend = formatTrend(card.change, card.formatter, card.suffix);
    div.innerHTML = `
          <div class="momentum-label">${card.label}</div>
          <div class="momentum-change" style="color:${trend.color};">
            <span class="dir">${trend.icon}</span>
            <span style="font-size:20px; font-weight:800;">${trend.text}</span>
          </div>
          <div class="momentum-sub">${trend.sub}</div>
        `;
    grid.appendChild(div);
  });
}

function renderSparklineBlocks(income, cash) {
  const row = document.getElementById("sparklineRow");
  if (!row) return;
  row.innerHTML = "";
  const revSeries = extractSeriesValues(income, "revenue");
  const epsSeries = extractSeriesValues(income, "eps")
    || extractSeriesValues(income, "epsdiluted")
    || extractSeriesValues(income, "epsDiluted")
    || extractSeriesValues(income, "netIncome");
  const fcfSeries = extractSeriesValues(cash, "fcfComputed", (r) => calcFcf(r));
  const marginSeries = Array.isArray(income)
    ? income.map(r => ({ date: r.date || r.filingDate || r.fillingDate, value: calcMargin(toNumber(r.netIncome), toNumber(r.revenue)) })).filter(r => r.value !== null)
    : null;
  const blocks = [
    { label: "Sales", series: revSeries, formatter: nf, type: "revenue" },
    { label: "Earnings", series: epsSeries, formatter: numf, type: "earnings" },
    { label: "Cash Flow", series: fcfSeries, formatter: nf, type: "fcf" },
    { label: "Margins", series: marginSeries, formatter: (v) => `${v.toFixed(1)}%`, type: "margin" }
  ];
  blocks.forEach(block => {
    const div = document.createElement("div");
    div.className = "sparkline-card";
    const spark = buildSparkline(block.series);
    const lastVal = block.series?.length ? block.series.at(-1).value : null;
    const change = Array.isArray(block.series) && block.series.length ? pctChange(block.series.at(-1).value, block.series[0].value) : null;

    const label = block.label;
    let status = "Neutral";
    let tone = "neutral";

    if (block.type === "revenue") {
      if (change != null) {
        if (change > 10) { status = "Strengthening"; tone = "good"; }
        else if (change > 0) { status = "Stable"; tone = "neutral"; }
        else { status = "Softening"; tone = "risk"; }
      }
    } else if (block.type === "earnings") {
      if (lastVal != null) {
        if (lastVal > 0) { status = "Positive"; tone = "good"; }
        else { status = "Negative"; tone = "risk"; }
      }
    } else if (block.type === "fcf") {
      if (lastVal != null) {
        if (lastVal > 0) { status = "Generating"; tone = "good"; }
        else { status = "Burning"; tone = "risk"; }
      }
    } else if (block.type === "margin") {
      if (lastVal != null) {
        if (lastVal > 15) { status = "Strong"; tone = "good"; }
        else if (lastVal > 5) { status = "Healthy"; tone = "neutral"; }
        else { status = "Compressed"; tone = "risk"; }
      }
    }

    div.innerHTML = `
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px; font-size:12px;">
            <span style="color:#9fb3c8; font-weight:500;">${label}</span>
            <span style="font-weight:700; color:${tone === 'good' ? '#4cd964' : tone === 'risk' ? '#ff3b30' : '#ffcc00'};">${status}</span>
          </div>
          <div class="sparkline-text" style="opacity:0.8;">${spark.line}</div>
        `;
    row.appendChild(div);
  });
}

const tonePositive = (val) => {
  const v = toNumber(val);
  if (v == null) return "";
  if (v > 0) return "good";
  if (v < 0) return "risk";
  return "warn";
};
const toneValuationCheap = (val, good = 15, warn = 25) => {
  const v = toNumber(val);
  if (v == null) return "";
  if (v <= good) return "good";
  if (v <= warn) return "warn";
  return "risk";
};
const toneMargin = (val, good = 15, warn = 5) => {
  const v = toNumber(val);
  if (v == null) return "";
  if (v >= good) return "good";
  if (v >= warn) return "warn";
  return "risk";
};
const toneReturn = (val, good = 12, warn = 6) => {
  const v = toNumber(val);
  if (v == null) return "";
  if (v >= good) return "good";
  if (v >= warn) return "warn";
  return "risk";
};
const toneLiquidity = (val) => {
  const v = toNumber(val);
  if (v == null) return "";
  if (v < 1) return "risk";
  if (v < 1.5) return "warn";
  if (v <= 3) return "good";
  if (v > 5) return "warn";
  return "good";
};
const toneLeverage = (val) => {
  const v = toNumber(val);
  if (v == null) return "";
  if (v < 1) return "good";
  if (v < 2) return "warn";
  return "risk";
};
const toneCoverage = (val) => {
  const v = toNumber(val);
  if (v == null) return "";
  if (v >= 10) return "good";
  if (v >= 4) return "warn";
  return "risk";
};

function renderTables(income, balance, cash, keyMetrics, ratios, keyMetricsTtm, ratiosTtm) {
  const incomeTtm = buildTtmFromSeries(income, ["revenue", "grossProfit", "operatingIncome", "netIncome"]);
  const cashTtm = buildTtmFromSeries(cash, ["netCashProvidedByOperatingActivities", "operatingCashFlow", "capitalExpenditure"]);
  const balanceTtm = buildPointInTimeTtm(balance, ["cashAndCashEquivalents", "totalDebt", "totalStockholdersEquity", "commonStockSharesOutstanding"]);
  renderTransposed(document.getElementById("incomeTable"), income, [
    { key: "revenue", label: "Revenue", formatter: nf, change: { mode: "higher-good" }, tone: tonePositive },
    { key: "grossProfit", label: "Gross Profit", formatter: nf, change: { mode: "higher-good" }, tone: tonePositive },
    { key: "operatingIncome", label: "Operating Income", formatter: nf, change: { mode: "higher-good" }, tone: tonePositive },
    { key: "netIncome", label: "Net Income", formatter: nf, change: { mode: "higher-good" }, tone: tonePositive }
  ], incomeTtm);
  renderTransposed(document.getElementById("balanceTable"), balance, [
    { key: "totalCurrentAssets", alt: "cashAndCashEquivalents", label: "Current Assets", formatter: nf, change: { mode: "higher-good" }, tone: tonePositive },
    { key: "totalDebt", label: "Total Debt", formatter: nf, change: { mode: "lower-good" }, tone: "" },
    { key: "totalStockholdersEquity", label: "Equity", formatter: nf, change: { mode: "higher-good" }, tone: "" },
    { key: "commonStockSharesOutstanding", label: "Shares Outstanding", formatter: nf, change: { mode: "lower-good" }, tone: "" }
  ], balanceTtm);
  renderTransposed(document.getElementById("cashTable"), cash, [
    { key: "netCashProvidedByOperatingActivities", alt: "operatingCashFlow", label: "CFO", formatter: nf, change: { mode: "higher-good" }, tone: tonePositive },
    { key: "capitalExpenditure", label: "Capex", formatter: nf },
    { key: "fcfComputed", label: "FCF", formatter: nf, change: { mode: "higher-good" }, tone: tonePositive }
  ], cashTtm);

  const kmsTtmEntry = keyMetricsTtm?.[0] ? { ...keyMetricsTtm[0], date: keyMetricsTtm[0].date || "TTM" } : null;
  const ratiosTtmEntry = ratiosTtm?.[0] ? { ...ratiosTtm[0], date: ratiosTtm[0].date || "TTM" } : null;
  console.debug("key metrics dataset", keyMetrics);
  console.debug("ratios dataset", ratios);
  renderTransposed(document.getElementById("keyMetricsTable"), keyMetrics, [
    { key: "freeCashFlowPerShareTTM", label: "FCF/Share", formatter: nf, tone: "", noTone: true },
    { key: "revenuePerShareTTM", label: "Revenue/Share", formatter: nf, tone: "", noTone: true },
    { key: "bookValuePerShareTTM", label: "Book Value/Share", formatter: nf, tone: "", noTone: true },
    { key: "pfcfRatio", alt: "priceToFreeCashFlowsRatio", label: "P/FCF", formatter: formatValuation, tone: "", noTone: true },
    { key: "peRatio", label: "P/E", formatter: formatValuation, tone: "", noTone: true },
    { key: "priceToSalesRatio", label: "P/S", formatter: formatValuation, tone: "", noTone: true },
    { key: "priceToBookRatio", label: "P/B", formatter: formatValuation, tone: "", noTone: true }
  ], kmsTtmEntry);

  renderTransposed(document.getElementById("ratiosTable"), ratios, [
    { key: "currentRatio", label: "Current Ratio", formatter: numf, tone: "", noTone: true },
    { key: "quickRatio", label: "Quick Ratio", formatter: numf, tone: "", noTone: true },
    { key: "debtEquityRatio", alt: "debtToEquity", label: "Debt/Equity", formatter: numf, tone: "", noTone: true },
    { key: "interestCoverage", label: "Interest Coverage (TTM)", formatter: formatCoverage, tone: "", noTone: true },
    { key: "grossProfitMargin", label: "Gross Margin %", formatter: pctf, tone: "", noTone: true },
    { key: "operatingProfitMargin", label: "Operating Margin %", formatter: pctf, tone: "", noTone: true },
    { key: "netProfitMargin", label: "Net Margin %", formatter: pctf, tone: "", noTone: true },
    { key: "returnOnEquity", label: "ROE %", formatter: pctf, tone: "", noTone: true },
    { key: "returnOnInvestedCapital", label: "ROIC %", formatter: pctf, tone: "", noTone: true }
  ], ratiosTtmEntry);
}

function renderTransposed(el, data, metrics, ttmEntry = null) {
  const rows = [];
  if (ttmEntry) rows.push(ttmEntry);
  const sorted = [...(data || [])].sort((a, b) => new Date(b.date || b.filingDate || b.fillingDate || 0) - new Date(a.date || a.filingDate || a.fillingDate || 0));
  const seen = new Set();
  sorted.forEach(r => {
    const label = r.date || r.filingDate || r.fillingDate || "n/a";
    if (seen.has(label)) return;
    seen.add(label);
    rows.push(r);
  });
  if (rows.length > 5) {
    const ttm = rows[0]?.date === "TTM" ? [rows[0]] : [];
    const remaining = rows.slice(ttm.length, 5);
    rows.splice(0, rows.length, ...ttm, ...remaining);
  }
  const periods = rows.map(r => r.date || r.filingDate || r.fillingDate || "n/a");
  if (!rows.length) { el.innerHTML = "<tbody><tr><td colspan=\"99\">No quarterly data (missing or paywalled bundle).</td></tr></tbody>"; return; }
  let html = "<thead><tr><th>Metric</th>"; periods.forEach(p => html += `<th>${p}</th>`); html += "</tr></thead><tbody>";
  metrics.forEach(m => {
    html += `<tr><td>${m.label}</td>`;
    rows.forEach((r, idx) => {
      let val = r[m.key];
      if (val === undefined && m.alt) val = r[m.alt];
      if (m.label === "FCF") val = calcFcf(r);
      if (m.label === "FCF" && val === undefined) val = calcFcf(r);
      const shown = m.formatter(val);
      const isTtmRow = (r.date || r.filingDate || r.fillingDate) === "TTM" && idx === 0;
      const toneAllowed = !m.noTone && !isTtmRow;
      const toneClass = toneAllowed && typeof m.tone === "function" ? m.tone(val, r) : (toneAllowed ? (m.tone || "") : "");
      const valueHtml = toneClass ? `<span class="metric-${toneClass}">${shown}</span>` : shown;
      let cell = valueHtml;
      if (m.change && idx + 1 < rows.length && !isTtmRow) {
        let prevVal = rows[idx + 1][m.key];
        if (prevVal === undefined && m.alt) prevVal = rows[idx + 1][m.alt];
        if (m.label === "FCF") prevVal = calcFcf(rows[idx + 1]);
        const currNum = toNumber(val);
        const prevNum = toNumber(prevVal);
        if (Number.isFinite(currNum) && Number.isFinite(prevNum) && prevNum !== 0) {
          const diffPct = ((currNum - prevNum) / Math.abs(prevNum)) * 100;
          const mode = m.change.mode;
          let tone = "neutral";
          if (mode === "higher-good") {
            if (diffPct > 0.5) tone = "up";
            else if (diffPct < -5) tone = "down-bad";
          } else if (mode === "lower-good") {
            if (diffPct < -0.5) tone = "down-good";
            else if (diffPct > 0) tone = "up-bad";
          }
          const icon = (() => {
            if (tone === "up" || tone === "up-warn" || tone === "up-bad") return "&#9650;";
            if (tone === "down-good" || tone === "down-bad") return "&#9660;";
            return "";
          })();
          const wrapClass = (() => {
            if (tone === "up-bad") return "delta-up-bad";
            if (tone === "down-bad") return "delta-down-bad";
            if (tone === "up-warn") return "delta-up";
            if (tone === "down-good") return "delta-down";
            if (tone === "up") return "delta-up";
            if (tone === "down") return "delta-down";
            return "";
          })();
          cell = `<span class="delta-cell ${wrapClass}">${valueHtml} ${icon ? `<span class="delta-icon">${icon}</span>` : ""}</span>`;
        }
      }
      html += `<td>${cell}</td>`;
    });
    html += "</tr>";
  });
  html += "</tbody>"; el.innerHTML = html;
}

function yoyChange(series, key, getter) {
  if (!Array.isArray(series) || series.length < 4) return null;
  const sorted = [...series].sort((a, b) => new Date(b.date || b.filingDate || b.fillingDate || 0) - new Date(a.date || a.filingDate || a.fillingDate || 0));
  const latest = getter ? getter(sorted[0]) : toNumber(sorted[0]?.[key]);
  const prev = getter ? getter(sorted[3]) : toNumber(sorted[3]?.[key]);
  return pctChange(latest, prev);
}

function marginDelta(income) {
  if (!Array.isArray(income) || income.length < 4) return null;
  const sorted = [...income].sort((a, b) => new Date(b.date || b.filingDate || b.fillingDate || 0) - new Date(a.date || a.filingDate || a.fillingDate || 0));
  const latest = calcMargin(toNumber(sorted[0]?.netIncome), toNumber(sorted[0]?.revenue));
  const prev = calcMargin(toNumber(sorted[3]?.netIncome), toNumber(sorted[3]?.revenue));
  if (!isFinite(latest) || !isFinite(prev)) return null;
  return latest - prev;
}

function formatTrend(change, formatter = null, suffix = "") {
  if (change === null || change === undefined || isNaN(change)) {
    return { icon: "--", color: "#cbd5e1", text: "-", sub: "No data" };
  }
  const isUp = change >= 0;
  const color = isUp ? "#4ade80" : "#ff6b6b";
  const icon = isUp ? "^" : "v";
  const formatted = formatter ? formatter(change) : `${change >= 0 ? "+" : ""}${change.toFixed(1)}%`;
  const sub = change === 0 ? "Mixed" : (isUp ? "Improving" : "Weakening");
  return { icon, color, text: `${formatted}${suffix ? " " + suffix : ""}`, sub };
}

function extractSeriesValues(series, key, getter) {
  if (!Array.isArray(series) || !series.length) return null;
  const sorted = [...series].sort((a, b) => new Date(a.date || a.filingDate || a.fillingDate || 0) - new Date(b.date || b.filingDate || b.fillingDate || 0));
  return sorted.map(r => {
    const raw = getter ? getter(r) : toNumber(r?.[key]);
    return { date: r.date || r.filingDate || r.fillingDate, value: isFinite(raw) ? raw : null };
  }).filter(r => r.value !== null);
}

function buildSparkline(series) {
  if (!Array.isArray(series) || !series.length) return { line: "no data", label: "n/a" };
  const values = series.map(s => s.value).filter(v => isFinite(v));
  if (!values.length) return { line: "no data", label: "n/a" };
  const min = Math.min(...values);
  const max = Math.max(...values);
  const blocks = [".", ":", ";", "-", "=", "+", "*", "#"];
  const range = max - min || 1;
  const line = values.map(v => {
    const norm = (v - min) / range;
    const idx = Math.max(0, Math.min(blocks.length - 1, Math.round(norm * (blocks.length - 1))));
    return blocks[idx];
  }).join("");
  const change = pctChange(values.at(-1), values[0]);
  const label = change === null ? "n/a" : `${change >= 0 ? "+" : ""}${change.toFixed(1)}%`;
  return { line, label };
}
function formatPrice(val) { if (!Number.isFinite(val)) return "n/a"; return `$${Number(val).toFixed(2)}`; }
function interpretTrend(change) {
  if (change === null || change === undefined || isNaN(change)) return { label: "Mixed", color: "#cbd5e1" };
  if (change > 10) return { label: "Rising", color: "#4ade80" };
  if (change > 3) return { label: "Improving", color: "#7ae3ff" };
  if (change > -3) return { label: "Stable", color: "#e3d28f" };
  if (change > -10) return { label: "Weakening", color: "#f59e0b" };
  return { label: "Falling", color: "#ff6b6b" };
}

function computeVolume(series = []) {
  const arr = Array.isArray(series) ? series : (series?.historical || []);
  const withVol = arr.filter(r => Number.isFinite(Number(r.volume)));
  if (!withVol.length) return { text: "n/a" };
  const latest = Number(withVol[0].volume);
  const sample = withVol.slice(0, 30);
  const avg = sample.reduce((a, b) => a + Number(b.volume), 0) / sample.length;
  return { text: `${nf(avg)} avg / ${nf(latest)} last` };
}

function computeRangeInfo(series = [], latestPrice = null) {
  const arr = Array.isArray(series) ? series : (series?.historical || []);
  if (!arr.length) return { rangeText: "n/a", label: "Range unavailable", position: null };
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 365);
  const filtered = arr.filter(r => new Date(r.date) >= cutoff);
  const scoped = filtered.length ? filtered : arr;
  const prices = scoped.map(r => Number(r.close ?? r.price)).filter(v => isFinite(v));
  if (!prices.length) return { rangeText: "n/a", label: "Range unavailable", position: null };
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const price = Number.isFinite(latestPrice) ? latestPrice : prices.at(-1);
  const span = high - low || 1;
  let position = (price - low) / span;
  position = Math.max(0, Math.min(1, position));
  const label = (() => {
    if (!Number.isFinite(price)) return "Price position unavailable.";
    if (position >= 0.66) return "Near the recent highs - momentum needs to hold.";
    if (position >= 0.33) return "Mid-range price - neither stretched nor cheap.";
    return "Closer to the lows - look for a catalyst before it can re-rate.";
  })();
  const positionLabel = (() => {
    if (!Number.isFinite(price)) return "Position unknown";
    if (position >= 0.66) return "Near high";
    if (position >= 0.33) return "Middle";
    return "Near low";
  })();
  return { rangeText: `${formatPrice(low)} - ${formatPrice(high)}`, label, positionLabel, position, low, high, price };
}

function renderPriceBlock(light, full) {
  const series = Array.isArray(full)
    ? full
    : (full?.historical || light?.historical || light || []);
  const hasContainer = Boolean(document.getElementById("priceBlock"));
  const container = hasContainer ? document.getElementById("priceBlock") : null;
  if (container) container.innerHTML = "";
  if (!Array.isArray(series) || !series.length) {
    const div = document.createElement("div");
    div.className = "pill";
    div.textContent = "No price data";
    if (container) container.appendChild(div);
    return { latestPrice: null, lastCloseText: null, seriesForChart: [], dayChange: null };
  }
  const sorted = [...series].sort((a, b) => new Date(b.date) - new Date(a.date));
  const latest = sorted[0];
  const oldest = sorted.at(-1);
  const maxClose = Math.max(...sorted.map(r => Number(r.close) || 0));
  const change = pctChange(Number(latest.close), Number(oldest.close));
  const dd = pctChange(Number(latest.close), Number(maxClose));
  const prev = sorted[1];
  const dayChange = prev ? pctChange(Number(latest.close), Number(prev.close ?? prev.price)) : null;
  let lastCloseText = null;
  if (container) {
    const items = [
      { label: "Last Close \u00b7", value: nf(latest.close ?? latest.price) },
      { label: "Period Change", value: change === null ? "n/a" : `${change.toFixed(2)}%` },
      { label: "From 52-week high", value: dd === null ? "n/a" : `${dd.toFixed(2)}%` },
      { label: "Last Volume", value: nf(latest.volume) }
    ];
    items.forEach(it => {
      const div = document.createElement("div");
      div.className = "pill";
      div.style.display = "flex";
      div.style.justifyContent = "space-between";
      div.innerHTML = `<span class="muted">${it.label}</span><span>${it.value}</span>`;
      container.appendChild(div);
      if (it.label.startsWith("Last Close")) lastCloseText = it.value;
    });
  } else {
    lastCloseText = nf(latest.close ?? latest.price);
  }
  const lp = Number(latest.close ?? latest.price);
  if (isFinite(lp)) localStorage.setItem(`latest-price-${ticker}`, String(lp));
  const lcText = nf(latest.close ?? latest.price);
  return { latestPrice: isFinite(lp) ? lp : null, lastVolume: latest.volume ?? null, periodChange: change, drawdown: dd, dayChange, lastCloseText: lcText, seriesForChart: sorted };
}

function buildTtmFromSeries(series, keys) {
  if (!Array.isArray(series) || !series.length) return null;
  const entry = { date: "TTM" };
  keys.forEach(key => {
    let total = 0; let count = 0;
    for (let i = 0; i < Math.min(4, series.length); i++) {
      const val = toNumber(series[i][key] ?? series[i][key?.alt]);
      if (isFinite(val)) { total += val; count++; }
    }
    entry[key] = count ? total : null;
    if (key === "capitalExpenditure") entry.key = entry.key; // no-op to keep structure
  });
  return entry;
}

function buildPointInTimeTtm(series, keys) {
  if (!Array.isArray(series) || !series.length) return null;
  const entry = { date: "TTM" };
  keys.forEach(k => { entry[k] = series[0][k]; });
  return entry;
}

function computeWinsLosses(series = [], lookback = 5) {
  if (!Array.isArray(series) || series.length < 2) return { wins: 0, losses: 0, streak: 0, direction: 0 };
  const sorted = [...series].sort((a, b) => new Date(b.date) - new Date(a.date));
  let wins = 0; let losses = 0; let streak = 0; let direction = 0;
  for (let i = 0; i < Math.min(lookback, sorted.length - 1); i++) {
    const today = Number(sorted[i].close ?? sorted[i].price);
    const prev = Number(sorted[i + 1].close ?? sorted[i + 1].price);
    if (!isFinite(today) || !isFinite(prev)) continue;
    const diff = today - prev;
    const dir = diff > 0 ? 1 : diff < 0 ? -1 : 0;
    if (dir > 0) wins++; else if (dir < 0) losses++;
    if (dir === direction && dir !== 0) {
      streak += 1;
    } else if (dir !== 0) {
      streak = 1;
      direction = dir;
    }
  }
  return { wins, losses, streak, direction };
}

function changeSince(sortedDesc, days) {
  if (!Array.isArray(sortedDesc) || !sortedDesc.length) return null;
  const latest = sortedDesc[0];
  const latestDate = new Date(latest.date);
  const cutoff = new Date(latestDate);
  cutoff.setDate(cutoff.getDate() - days);
  const past = sortedDesc.find((r) => new Date(r.date) <= cutoff);
  if (!past) return null;
  return pctChange(Number(latest.close ?? latest.price), Number(past.close ?? past.price));
}

function computePriceStats(priceSeries) {
  const series = Array.isArray(priceSeries) ? priceSeries : (priceSeries?.historical || []);
  if (!series.length) {
    return {
      beta: null,
      week52Change: null,
      drawdownFromHigh: null,
      rsi: null,
      movingAverage50: null,
      movingAverage200: null,
      change7d: null,
      change30d: null,
      change90d: null,
      wins: 0,
      losses: 0,
      priceStreak: 0,
      rangePosition: null,
      rangeLabel: null,
      latestPrice: null,
      week52High: null,
      week52Low: null,
      distanceFromLow: null
    };
  }
  const sortedDesc = [...series].sort((a, b) => new Date(b.date) - new Date(a.date));
  const sortedAsc = [...sortedDesc].reverse();
  const latest = sortedDesc[0];
  const latestClose = Number(latest.close ?? latest.price);
  const closesAsc = sortedAsc.map(r => Number(r.close ?? r.price)).filter(v => isFinite(v));
  const change7d = changeSince(sortedDesc, 7);
  const change30d = changeSince(sortedDesc, 30);
  const change90d = changeSince(sortedDesc, 90);
  const change52w = changeSince(sortedDesc, 365);
  const rangeInfo = computeRangeInfo(series, latestClose);
  const average = (window) => {
    if (!closesAsc.length || closesAsc.length < window) return null;
    const slice = closesAsc.slice(-window);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  };
  const movingAverage50 = average(50);
  const movingAverage200 = average(200);
  const rsi = (() => {
    const lookback = 14;
    if (closesAsc.length <= lookback) return null;
    const recent = closesAsc.slice(-1 - lookback);
    let gains = 0;
    let losses = 0;
    for (let i = 1; i < recent.length; i++) {
      const diff = recent[i] - recent[i - 1];
      if (diff > 0) gains += diff; else losses -= diff;
    }
    const avgGain = gains / lookback;
    const avgLoss = losses / lookback;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  })();
  const winsLosses = computeWinsLosses(sortedDesc, 5);
  return {
    beta: null,
    week52Change: change52w,
    drawdownFromHigh: rangeInfo.distanceFromHigh,
    rsi,
    movingAverage50,
    movingAverage200,
    change7d,
    change30d,
    change90d,
    wins: winsLosses.wins,
    losses: winsLosses.losses,
    priceStreak: winsLosses.streak,
    rangePosition: rangeInfo.position,
    rangeLabel: rangeInfo.positionLabel,
    latestPrice: latestClose,
    week52High: rangeInfo.high,
    week52Low: rangeInfo.low,
    distanceFromLow: rangeInfo.distanceFromLow
  };
}

function getLatestPrice(full, light) {
  const series = Array.isArray(full) ? full : (full?.historical || light?.historical || light || []);
  if (!Array.isArray(series) || !series.length) return null;
  const sorted = [...series].sort((a, b) => new Date(b.date) - new Date(a.date));
  const latest = sorted[0];
  const price = Number(latest.close ?? latest.price);
  if (isFinite(price)) {
    localStorage.setItem(`latest-price-${ticker}`, String(price));
    return price;
  }
  return null;
}

function getCachedPrice() {
  const raw = localStorage.getItem(`latest-price-${ticker}`);
  if (!raw) return null;
  const num = Number(raw);
  return isFinite(num) ? num : null;
}

function parsePriceString(val) {
  if (!val) return null;
  const num = Number(String(val).replace(/[^0-9.\-]/g, ""));
  return isFinite(num) ? num : null;
}

function ensurePriceElements() {
  const titleEl = document.getElementById("title");
  if (!titleEl) return;
  // intentionally no longer injecting lastPrice next to ticker
}


function updatePriceDisplay(valueNum, valueText, dayChange) {
  ensurePriceElements();
  const lpEl = document.getElementById("lastPrice");
  const stEl = document.getElementById("status");
  if (!stEl) return;

  const getLatestDate = () => {
    const series = Array.isArray(currentVm?.priceHistory) ? currentVm.priceHistory : null;
    const fromSeries = series && series.length ? series.map(p => p.date).filter(Boolean).sort().slice(-1)[0] : null;
    return fromSeries || priceAsOfDate || null;
  };

  const formatDate = (d) => {
    if (!d) return "Unknown date";
    const parsed = new Date(d);
    if (Number.isNaN(parsed.getTime())) return d;
    const dd = String(parsed.getDate()).padStart(2, "0");
    const mm = String(parsed.getMonth() + 1).padStart(2, "0");
    const yy = parsed.getFullYear();
    return `${dd}-${mm}-${yy}`;
  };

  const asOfRaw = getLatestDate();
  const dateStr = formatDate(asOfRaw);

  const priceDisplay = Number.isFinite(valueNum) ? `$${valueNum.toFixed(2)}` : (valueText || "--");
  if (lpEl) lpEl.textContent = priceDisplay;

  const hasPriceVal = Number.isFinite(valueNum);
  // Only show "pending" if we truly don't have a usable price yet.
  // The backend may set `pricePending=true` while we are showing a cached/local fallback close.
  const pending = currentVm?.pricePending === true && !hasPriceVal;
  const stale = hasPrice(currentVm) && isPriceStale(currentVm);
  // Keep wording stable in the UI: always show "Last Close" as the label.
  const statusLabel = "Last Close";
  const statusNote = pending
    ? "Waiting for official end-of-day pricing."
    : stale
      ? `Showing cached close from ${dateStr}; refresh once new close posts.`
      : hasPriceVal
        ? "Official end-of-day pricing."
        : "No valid price returned; chart is hidden until pricing loads.";

  stEl.innerHTML = `
    <div class="price-main-row">
      <span class="status-label">${statusLabel}</span> 
      <span class="status-value">${priceDisplay}</span>
    </div>
    <div style="display:flex; flex-direction:column; line-height:1.25; margin-top:4px; align-items:flex-end; text-align:right;">
      <div style="font-size:10px; color:#9fb3c8; margin-bottom:2px; opacity:0.8;">
        ${pending ? "Price timestamp pending" : `Price last updated: ${dateStr}`} &middot; End-of-Day
      </div>
      <div style="font-size:9px; color:#5da4b4; opacity:0.6; margin-top:0;">
        ${statusNote}<br>Bullish And Foolish uses official end-of-day pricing; intraday updates are not provided.
      </div>
    </div>
  `;

  if (Number.isFinite(valueNum)) {
    localStorage.setItem(`latest-price-${ticker}`, String(valueNum));
  }
}

function formatChange(changePct) {
  if (!Number.isFinite(changePct)) return "";
  const arrow = changePct >= 0 ? "&uarr;" : "&darr;";
  const color = changePct >= 0 ? "#4ade80" : "#ff6b6b";
  return `<span style="color:${color}; font-weight:700; margin-left:6px;">${arrow} ${changePct.toFixed(2)}%</span>`;
}

function applyTier(qualityScore, { tierLabel = null } = {}) {
  const tierBadge = document.getElementById("tierBadge");
  const band = (tierLabel || getScoreBand(qualityScore)).toLowerCase();
  const isPenny = isPennyStockVm(currentVm);
  let customLabel = null;
  let customTooltip = null;

  // Check if this is a biotech/pharma company
  const isBiotechSector = (() => {
    const sector = String(currentVm?.sectorBucket || currentVm?.sector || "").toLowerCase();
    const sicDesc = String(currentVm?.sicDescription || "").toLowerCase();
    const name = String(currentVm?.companyName || "").toLowerCase();
    return sector.includes("biotech") ||
      sector.includes("pharma") ||
      sicDesc.includes("pharmaceutical") ||
      sicDesc.includes("biological") ||
      sicDesc.includes("medicinal") ||
      /\b(therapeutics|biopharma|oncology|biosciences)\b/i.test(name);
  })();

  // Distinguish clinical-stage (pre-revenue) from established pharma (LLY, AMGN, etc.)
  const isEstablishedPharma = (() => {
    if (!isBiotechSector) return false;
    const revenueTTM = Number(currentVm?.snapshot?.revenueTTM ?? currentVm?.keyMetrics?.revenueTTM ?? 0);
    const netIncome = Number(currentVm?.snapshot?.netIncomeTTM ?? currentVm?.keyMetrics?.netIncome ?? 0);
    const marketCap = Number(currentVm?.marketCap ?? currentVm?.keyMetrics?.marketCap ?? 0);
    // Established if: revenue > $2B OR (revenue > $500M AND profitable) OR mega-cap
    return revenueTTM > 2_000_000_000 ||
      (revenueTTM > 500_000_000 && netIncome > 0) ||
      marketCap > 50_000_000_000;
  })();

  const isClinicalStageBiotech = isBiotechSector && !isEstablishedPharma;

  // Only apply "Trial Dependent" to clinical-stage biotechs, not established pharma
  if (isClinicalStageBiotech) {
    customLabel = "Trial Dependent";
    customTooltip = "Pre-revenue biotech – investment thesis depends on clinical trial outcomes. Traditional financial metrics have limited relevance.";
  } else if (isPenny && Number.isFinite(qualityScore)) {
    if (qualityScore < 15) customLabel = "Severe Risk";
    else if (qualityScore < 30) {
      customLabel = "Likely Value Trap";
    }
  }

  const labelMap = {
    incomplete: "Data Incomplete",
    danger: "Likely Value Trap",
    spec: "High-Risk Upside Play",
    mixed: "Balanced",
    solid: "Reliable Performer",
    bullish: "High-Conviction Winner",
    elite: "Elite Compounder"
  };
  const tooltipMap = {
    incomplete: "Critical financial data is missing. Rating suspended.",
    danger: "Severe weaknesses. Avoid unless you like gambling.",
    spec: "Volatile or early-stage. Could run hard - or collapse.",
    mixed: "Neutral profile - upside exists but not without caveats.",
    solid: "Steady fundamentals. Good for conservative portfolios.",
    bullish: "Strong financials & momentum. Attractive long-term setup.",
    elite: "Top-tier resilience + growth. Long-term compounder potential."
  };

  const tier = customLabel || labelMap[band] || "Analyst";
  if (tierBadge) {
    tierBadge.textContent = tier;
    tierBadge.title = customTooltip || tooltipMap[band] || "";
    if (band === "incomplete") {
      tierBadge.style.background = "#e2e8f0";
      tierBadge.style.color = "#64748b";
    } else if (isClinicalStageBiotech) {
      // Special purple styling for clinical-stage biotechs
      tierBadge.style.background = "rgba(147, 51, 234, 0.15)";
      tierBadge.style.color = "#c084fc";
    } else {
      tierBadge.style.background = ""; // reset
      tierBadge.style.color = "";
    }
  }

  const dot = document.getElementById("tierDotTop");
  if (dot) {
    dot.classList.remove("bullish", "neutral", "bearish", "incomplete");
    if (band === "incomplete") {
      dot.classList.add("neutral"); // grey
      dot.style.background = "#cbd5e1";
    } else if (isClinicalStageBiotech) {
      // Clinical-stage biotechs always show neutral bull - it's 50/50
      dot.classList.add("neutral");
      dot.style.background = "";
    } else {
      dot.style.background = "";
      if (band === "danger" || band === "spec") dot.classList.add("bearish");
      else if (band === "mixed") dot.classList.add("neutral");
      else dot.classList.add("bullish");
    }
  }
  const scoreEl = document.getElementById("score");
  if (scoreEl) {
    if (band === "incomplete") {
      scoreEl.textContent = "--";
      scoreEl.classList.remove("score-anim");
    } else {
      scoreEl.textContent = "";
      scoreEl.classList.remove("score-anim");
    }
  }
}


function applyCompleteness(completeness) {
  const fill = document.getElementById("completenessFill");
  const text = document.getElementById("completenessText");
  const pill = document.getElementById("completenessPill");
  const icon = document.getElementById("completenessIcon");
  if (!fill || !text) return;
  const pct = Number(completeness?.percent);
  if (!Number.isFinite(pct)) {
    fill.style.width = "0%";
    fill.style.background = colorForBand(0);
    text.textContent = "Confidence: n/a";
    if (pill) pill.classList.add("dim");
    if (icon) icon.textContent = "!";
    return;
  }
  const clamped = Math.max(0, Math.min(100, pct));
  const level = clamped >= 90 ? "High" : clamped >= 75 ? "Medium" : "Low";
  fill.style.width = `${clamped.toFixed(0)}%`;
  fill.style.background = colorForBand(clamped);
  text.innerHTML = `Confidence: ${level}<br><span style="opacity:0.75;">(${clamped.toFixed(0)}% data coverage)</span>`;
  if (pill) {
    pill.classList.remove("good", "dim");
    if (clamped >= 90) pill.classList.add("good");
    else if (clamped < 60) pill.classList.add("dim");
  }
  if (icon) icon.textContent = clamped < 60 ? "!" : level === "Medium" ? "i" : "";
}

function getScoreBand(val) {
  if (typeof val === "string" && val.toLowerCase() === "incomplete") return "incomplete";
  const v = Number(val);
  if (!Number.isFinite(v)) return "incomplete"; // Default to incomplete if null/nan passed without label
  if (v >= 90) return "elite";
  if (v >= 75) return "bullish";
  if (v >= 60) return "solid";
  if (v >= 40) return "mixed";
  return "danger";
}

function colorForBand(val) {
  const band = getScoreBand(val);
  switch (band) {
    case "elite": return "#22c55e";
    case "bullish": return "#38b972";
    case "solid": return "#6be48c";
    case "mixed": return "#d8ad38";
    case "spec": return "#d65b5b";
    case "danger": return "#b83232";
    case "incomplete": return "#cbd5e1";
    default: return "#cbd5e1";
  }
}

function renderAchievements() {
  const el = document.getElementById("achievements");
  if (!el) return;
  el.innerHTML = "";

  const highlightNames = [
    "Capital Return",
    "Innovation Investment",
    "Working Capital",
    "Effective Tax Rate"
  ];

  const friendlyReasonName = (name) => {
    const n = String(name || "").toLowerCase();
    if (/capital return/.test(n)) return "Capital Return";
    if (/innovation investment/.test(n)) return "Innovation Investment";
    if (/working capital/.test(n)) return "Working Capital";
    if (/effective tax rate/.test(n)) return "Effective Tax Rate";
    return null;
  };

  const friendlyReasonMessage = (message) => String(message || "").trim();

  const reasons = Array.isArray(currentVm?.ratingReasons)
    ? currentVm.ratingReasons
    : Array.isArray(currentVm?.rating?.reasons)
      ? currentVm.rating.reasons
      : [];

  const byName = new Map(reasons.map((r) => [r?.name, r]).filter(([k]) => k));
  const iconPool = ["&#128176;", "&#128640;", "&#128184;", "&#129514;", "&#128202;", "&#128200;"];
  const usedIcons = new Set();

  highlightNames
    .map((name) => byName.get(name))
    .filter(Boolean)
    .forEach((reason) => {
      const unavailable = !!reason.missing || !!reason.notApplicable;
      const numericScore = unavailable ? 0 : (Number(reason.score) || 0);
      const badgeClass = numericScore > 0 ? "good" : numericScore < 0 ? "risk" : "neutral";
      const scoreText = numericScore > 0 ? `+${numericScore}` : (numericScore < 0 ? `${numericScore}` : "0");
      const titleText = friendlyReasonName(reason.name) || toTitleCase(reason.name);
      const displayValue = friendlyReasonMessage(reason.message) || "N/A";
      const displayHtml = escapeHtml(displayValue).replace(/\n/g, "<br>");
      const explainer = ruleExplainers[reason.name] || {};
      const posText = explainer.pos || "Positive scores mean the metric meets the target.";
      const negText = explainer.neg || "Negative scores mean the metric falls short of the target.";
      const explainerText = numericScore >= 0 ? posText : negText;
      const icon = iconForRule(reason.name, usedIcons, iconPool);
      const timeBasis = reason?.timeBasis ? String(reason.timeBasis) : null;
      const basisMetaHtml = (timeBasis)
        ? `
            <div style="font-size:11px; line-height:1.35; margin-top:auto; padding-top:6px; font-weight:600; color:var(--text-main); opacity:0.85;">
              Basis: ${escapeHtml(timeBasis)}
            </div>
          `
        : `<div style="margin-top:auto;"></div>`;

      const div = document.createElement("div");
      div.className = "reason-card".trim();
      div.style.cssText = "display: flex; flex-direction: column; height: 100%;";
      div.innerHTML = `
        <div class="header">
          <div class="icon">${icon}</div>
          <div class="title whitespace-normal leading-tight">${escapeHtml(titleText)}</div>
          <div class="score-tag ${badgeClass}">${scoreText}</div>
        </div>
        <div class="value-pill ${badgeClass} whitespace-normal leading-tight" style="margin-top:4px;">${displayHtml}</div>
        <div class="muted" style="font-size:12px; line-height:1.35; margin-bottom: 4px;">${escapeHtml(explainerText)}</div>
        ${basisMetaHtml}
      `;
      if (window.matchMedia("(pointer: coarse)").matches) {
        div.addEventListener("click", () => div.classList.toggle("expanded"));
      }
      el.appendChild(div);
    });
}
function iconForRule(name, usedIcons = null, pool = []) {
  const map = {
    "Revenue momentum": "&#128200;",
    "Gross margin quality": "&#129534;",
    "Operating leverage": "&#128736;",
    "Net margin": "&#10135;",
    "FCF margin": "&#128181;",
    "ROE": "&#127942;",
    "ROIC": "&#127919;",
    "Debt load": "&#127947;",
    "Liquidity": "&#128167;",
    "P/FCF": "&#128184;",
    "P/E sanity": "&#129504;",
    "EV/EBITDA": "&#127970;",
    "Moat quality": "&#127984;",
    "Altman Z": "&#128737;",
    "Piotroski F": "&#128200;",
    "Dilution watch": "&#129720;",
    "Buyback / issuance quality": "&#128260;",
    "Share buybacks (TTM)": "&#128176;",
    "Capital Return": "&#128176;",
    "Innovation Investment": "&#128640;",
    "Working Capital": "&#128184;",
    "Effective Tax Rate": "&#129514;",
    "Total shareholder yield": "&#127873;",
    "R&D intensity": "&#128300;",
    "SG&A efficiency": "&#128201;",
    "EPS vs cash quality": "&#128176;",
    "Short interest": "&#128059;",
    "Share count trend (3Y)": "&#128201;",
    "Small-cap risk": "&#9888;",
    "FCF trend": "&#127793;",
    "Gross margin trend": "&#128202;",
    "Capex intensity": "&#128295;",
    "Capex Intensity": "&#128295;",
    "FCF stability": "&#128202;",
    "FCF Stability": "&#128202;",
    "Drawdown vs 52 high": "&#128201;",
    "Drawdown Vs 52 high": "&#128201;",
    "Drawdown vs 52w high": "&#128201;",
    "Drawdown Vs 52w High": "&#128201;",
    "Net Debt vs FCF": "&#128182;",
    "Cash conversion": "&#128184;",
    "Cash Conversion": "&#128184;"
  };
  const basePool = pool && pool.length ? pool : [
    "&#128200;", "&#128202;", "&#128176;", "&#9881;", "&#128736;", "&#127942;", "&#128167;", "&#129351;", "&#128185;", "&#127744;"
  ];
  const pickFromPool = (iconList) => {
    for (const icon of iconList) {
      if (!icon) continue;
      if (!usedIcons) return icon;
      if (!usedIcons.has(icon)) {
        usedIcons.add(icon);
        return icon;
      }
    }
    return null;
  };
  const preferred = map[name];
  const chosen = pickFromPool(preferred ? [preferred] : []);
  if (chosen) return chosen;
  const pooled = pickFromPool(basePool.filter((i) => i !== preferred));
  if (pooled) return pooled;
  return preferred || "&#128196;";
}
function toTitleCase(str = "") {
  return String(str)
    .split(" ")
    .map(word => {
      if (!word) return word;
      if (word === word.toUpperCase()) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

function getScoreClass(score) {
  const val = Number(score);
  if (val >= 4) return "good";
  if (val >= 0) return "neutral";
  if (val <= -10) return "risk";
  if (val < 0) return "risk";
  return "neutral";
}



function buildTakeaway(band) {
  const t = ticker || "This stock";
  if (isPennyStockVm(currentVm)) {
    const sayings = [
      "Penny-stock profile: fragile balance sheet; financing risk is high.",
      "Speculative setup; dilution and cash burn drive the story.",
      "Tiny-cap risk zone; treat any upside as optionality, not certainty."
    ];
    const seed = (ticker || "")
      .split("")
      .reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
    return sayings[Math.abs(seed) % sayings.length];
  }
  const base = {
    elite: `Cash - rich, strong margins, durable moat; looks elite.`,
    bullish: `High quality fundamentals; worth serious attention.`,
    solid: `Reliable performer with decent balance and margins.`,
    mixed: `Mixed picture; execution and discipline matter.`,
    spec: `Higher risk setup; execution must improve to pay off.`,
    danger: `Value trap risk; fragile balance sheet or weak cash flows.`
  };
  if (lastPillars) {
    const entries = [
      ["fundamentals", lastPillars.fundamentals],
      ["strength", lastPillars.strength],
      ["momentum", lastPillars.momentum],
      ["consistency", lastPillars.consistency]
    ].filter(([, v]) => Number.isFinite(v));
    if (entries.length) {
      entries.sort((a, b) => b[1] - a[1]);
      const best = entries[0][0];
      const worst = entries.at(-1)[0];
      const bestMap = {
        fundamentals: "Strong fundamentals",
        strength: "Fortress balance sheet",
        momentum: "Momentum is improving",
        consistency: "Steady execution"
      };
      const weakMap = {
        fundamentals: "fundamentals need work",
        strength: "balance sheet is the weak spot",
        momentum: "momentum is soft",
        consistency: "results are choppy"
      };
      const bestPhrase = bestMap[best] || "Strengths stand out";
      const weakPhrase = weakMap[worst] || "one pillar lags";
      return `${bestPhrase}${entries.length > 1 ? ` but ${weakPhrase}` : ""}.`;
    }
  }
  return base[band] || `Snapshot unavailable.`;
}

const BULLET_PREFIX = {
  good: "Good:",
  risk: "Risk:",
  note: "Note:"
};
const makeBullet = (kind, text) => `${BULLET_PREFIX[kind] || BULLET_PREFIX.note} ${text} `;

function computeRiskSummary(stock = {}) {
  const f = stock.financialPosition || {};
  const proj = currentVm?.projections || {};
  const isPenny = isPennyStockVm(currentVm, stock);
  const sectorBucket = resolveSectorBucket(stock?.sectorBucket || stock?.sector);
  const isEstablished =
    stock?.ratingTierLabel === "solid" ||
    stock?.ratingTierLabel === "bullish" ||
    stock?.ratingTierLabel === "elite" ||
    (stock?.keyMetrics?.marketCap && stock.keyMetrics.marketCap > 10_000_000_000);

  const hasCards = Array.isArray(stock.ratingReasons) && stock.ratingReasons.length > 0;
  const bullets = [];
  const grouped = { solvency: [], quality: [], valuation: [] };
  const seenTags = new Set();
  const baseBasis = (currentVm?.ratingBasis === "annual" || currentVm?.annualMode === true) ? "Annual" : "TTM";
  const basisFor = (kind) => {
    if (kind === "mixed") return "Mixed";
    if (kind === "ttm") return "TTM";
    if (kind === "annual") return "Annual";
    return baseBasis;
  };

  const getReason = (re) =>
    (Array.isArray(stock.ratingReasons) ? stock.ratingReasons : []).find((r) => re.test(String(r?.name || "")));
  const getReasonScore = (re) => {
    const r = getReason(re);
    const n = Number(r?.score);
    return Number.isFinite(n) ? n : null;
  };

  const fmtPct0 = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return "n/a";
    const r = Math.round(n);
    return `${r === 0 ? 0 : r}%`;
  };
  const fmtPct1 = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return "n/a";
    const r = Math.round(n * 10) / 10;
    return `${r === 0 ? 0 : r}%`;
  };
  const fmtYears1 = (v) => `${Number(v).toFixed(1)}y`;
  const fmtX1 = (v) => `${Number(v).toFixed(1)}x`;

  const stableHash32 = (str) => {
    let h = 2166136261;
    const s = String(str || "");
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  };
  const pick = (tag, variants) => {
    const arr = Array.isArray(variants) ? variants.filter(Boolean) : [];
    if (!arr.length) return null;
    const seedKey = String(currentVm?.ticker || ticker || stock?.ticker || "");
    const idx = stableHash32(`${seedKey}:${tag}`) % arr.length;
    return arr[idx];
  };

  const describeDilution = (pctYoY) => {
    const v = Number(pctYoY);
    if (!Number.isFinite(v)) return null;
    if (v >= 80) return "share count jumped a lot";
    if (v >= 40) return "share count rose sharply";
    if (v >= 20) return "share count rose meaningfully";
    if (v >= 8) return "share count rose modestly";
    if (v <= -8) return "share count fell (buybacks)";
    return "share count was roughly flat";
  };

  const describeCashBurn = (fcfMarginPct) => {
    const v = Number(fcfMarginPct);
    if (!Number.isFinite(v)) return null;
    if (v >= 10) return "generating cash";
    if (v >= 0) return "roughly cash-neutral";
    if (v <= -200) return "burning cash very heavily";
    if (v <= -50) return "burning cash heavily";
    if (v <= -10) return "burning cash";
    return "slightly cash-flow negative";
  };

  const revenueTtm = toNumber(stock?.revenueTtm ?? stock?.revenueLatest);
  const isPreRevenueBiotech =
    sectorBucket === "Biotech/Pharma" && (!Number.isFinite(revenueTtm) || revenueTtm < 50_000_000);

  const add = (cat, kind, text, { severity = null, tag = null, basis = null } = {}) => {
    if (!text) return;
    const resolvedSeverity =
      severity != null
        ? severity
        : kind === "risk"
          ? 3
          : kind === "note"
            ? 2
            : 1;
    const resolvedTag = tag || text;
    if (seenTags.has(resolvedTag)) return;
    seenTags.add(resolvedTag);
    bullets.push(makeBullet(kind, text));
    const icon = kind === "good" ? "&#9989;" : kind === "risk" ? "&#10060;" : "&#9888;&#65039;";
    if (!grouped[cat]) grouped[cat] = [];
    const basisLabel = basisFor(basis || "mixed");
    const basisHtml = ` <span style="opacity:0.75; font-size:11px;">Basis: ${basisLabel}</span>`;
    grouped[cat].push({ level: kind, text, label: `${icon} ${text}${basisHtml} `, severity: resolvedSeverity, basis: basisLabel });
  };

  const runwayYears = toNumber(f.runwayYears);
  const fcfMargin = percentToNumber(stock.profitMargins?.fcfMargin);
  const opMargin = percentToNumber(stock.profitMargins?.operatingMargin);
  const revGrowth = (() => {
    const fromRule = percentToNumber(getReason(/revenue growth yoy/i)?.message);
    if (Number.isFinite(fromRule)) return fromRule;
    return percentToNumber(stock?.growth?.revenueGrowthTTM);
  })();
  const marginTrend = toNumber(stock?.momentum?.marginTrend);
  const fcfTrend = toNumber(stock?.momentum?.fcfTrend);
  const dilutionYoY = percentToNumber(
    stock?.shareStats?.sharesChangeYoY ??
    currentVm?.snapshot?.sharesOutChangeYoY ??
    currentVm?.snapshot?.sharesOutChangeYoYRaw
  );
  const dilutionQoQ = percentToNumber(stock?.shareStats?.sharesChangeQoQ);
  const bankruptcyRisk = toNumber(proj.bankruptcyRiskScore);
  const dilutionRisk = toNumber(proj.dilutionRiskScore);
  const ndFcfYears = toNumber(f.netDebtToFcfYears);
  const interestCoverage = toNumber(f.interestCoverage);

  const hasNegativeEquity = (stock.ratingReasons || []).some(
    (r) => /negative equity/i.test(r?.message || "") || /negative equity/i.test(r?.name || "")
  );

  const hasFilingSignals = Array.isArray(filingSignals) && filingSignals.length > 0;
  const hasGoingConcernSignal =
    hasFilingSignals &&
    filingSignals.some(
      (sig) =>
        sig?.id === "going_concern" ||
        /going.?concern/i.test(sig?.title || "") ||
        /going.?concern/i.test(sig?.snippet || "")
    );

  const debtScore = getReasonScore(/debt\s*\/\s*equity/i);
  const psScore = getReasonScore(/price\s*\/\s*sales|p\/?s/i);
  const peScore = getReasonScore(/price\s*\/\s*earnings|p\/?e/i);
  const pfcfScore = getReasonScore(/price\s*\/\s*fcf|p\/?fcf/i);
  const valuationOverstretched =
    [psScore, peScore, pfcfScore].some((v) => Number.isFinite(v) && v < 0);
  const valuationCheapish =
    [psScore, peScore, pfcfScore].some((v) => Number.isFinite(v) && v >= 4);

  const runwayShort = Number.isFinite(runwayYears) && runwayYears < 1;
  const runwayTight = Number.isFinite(runwayYears) && runwayYears >= 1 && runwayYears < 2;
  const deepBurn = Number.isFinite(fcfMargin) && fcfMargin < -50;
  const burn = Number.isFinite(fcfMargin) && fcfMargin < 0;
  const marginsCompressing = Number.isFinite(marginTrend) && marginTrend < -5;
  const cashImproving = Number.isFinite(fcfTrend) && fcfTrend > 10;
  const cashWorsening = Number.isFinite(fcfTrend) && fcfTrend < -10;
  const dilutionHigh = Number.isFinite(dilutionYoY) && dilutionYoY > 25;
  const dilutionPersistent = Number.isFinite(dilutionQoQ) && dilutionQoQ > 5 && !proj?.dilutionOneOff;
  const growthStrong = Number.isFinite(revGrowth) && revGrowth > 25;
  const growthWeak = Number.isFinite(revGrowth) && revGrowth < 0;
  const profitStrong = Number.isFinite(opMargin) && opMargin > 15;
  const profitWeak = Number.isFinite(opMargin) && opMargin < 0;

  if (isPreRevenueBiotech) {
    add(
      "quality",
      "note",
      pick("bio_context", [
        "Pre-revenue biotech: focus on cash runway, dilution, and trial milestones; margins and valuation multiples are less informative.",
        "Biotech context: before steady product revenue, runway and dilution usually matter more than margins or traditional valuation ratios.",
        "Early-stage biotech often runs cash-flow negative; the key is runway and whether dilution is manageable until milestones land."
      ]),
      { severity: 1, tag: "bio_context", basis: "mixed" }
    );
  }

  // Model-level & data-quality risk (allowed even if it's single-source)
  if (bankruptcyRisk != null && bankruptcyRisk > 0.5 && !isEstablished) {
    add(
      "solvency",
      "risk",
      pick("model_bankruptcy", [
        "Model flag: elevated financial stress risk (may need refinancing or a cash raise).",
        "Model flag: higher-than-usual solvency risk (watch funding and debt maturity timelines).",
        "Model flag: heightened failure/financing risk if conditions worsen."
      ]),
      { severity: 3, tag: "model_bankruptcy", basis: "mixed" }
    );
  }
  if (dilutionRisk != null && dilutionRisk > 0.5) {
    add(
      "quality",
      "risk",
      pick("model_dilution", [
        "Model flag: dilution risk is elevated (more new shares could be issued).",
        "Model flag: higher dilution risk (future fundraising may reduce existing ownership).",
        "Model flag: dilution pressure looks high (equity issuance may be part of the plan)."
      ]),
      { severity: 2, tag: "model_dilution", basis: "mixed" }
    );
  } else if (proj?.dilutionOneOff) {
    add(
      "quality",
      "note",
      pick("model_dilution_oneoff", [
        "Model note: recent dilution looks like a one-off raise, not a steady pattern.",
        "Model note: share issuance appears episodic (may not repeat every quarter).",
        "Model note: dilution spike looks one-time; watch if it continues."
      ]),
      { severity: 2, tag: "model_dilution_oneoff", basis: "mixed" }
    );
  }
  if (hasGoingConcernSignal) {
    add(
      "solvency",
      "risk",
      pick("filing_going_concern", [
        "SEC filing uses “going concern” language (management is warning about funding risk).",
        "SEC filing includes “going concern” wording (they’re signaling uncertainty about funding).",
        "SEC filing flags “going concern” risk (keep an eye on runway/financing plans)."
      ]),
      { severity: 3, tag: "filing_going_concern", basis: "mixed" }
    );
  }
  if (currentVm?.dataQuality?.mismatchedPeriods) {
    add(
      "quality",
      "note",
      pick("dq_mismatch", [
        "Data note: some statements look out of sync by period, so a few ratios may be noisy.",
        "Data note: statements don’t line up perfectly by date; treat some ratios as approximate.",
        "Data note: mismatched reporting periods can make trend signals jumpy."
      ]),
      { severity: 2, tag: "dq_mismatch", basis: "mixed" }
    );
  }
  if (Array.isArray(currentVm?.dataQuality?.materialMismatches) && currentVm.dataQuality.materialMismatches.length) {
    add(
      "quality",
      "note",
      pick("dq_material", [
        "Data note: a few statement fields don’t reconcile cleanly; treat the summary as directional.",
        "Data note: some numbers conflict across statements; double-check the underlying cards.",
        "Data note: statement consistency looks off in places; use the details below for context."
      ]),
      { severity: 2, tag: "dq_material", basis: "mixed" }
    );
  }
  const completenessPct = Number(currentVm?.dataCompleteness?.percent);
  if (Number.isFinite(completenessPct) && completenessPct < 45) {
    add(
      "quality",
      "note",
      pick("low_confidence", [
        "Lower confidence: lots of data is missing, so the summary can be incomplete.",
        "Lower confidence: missing data limits what can be concluded from EDGAR right now.",
        "Lower confidence: several metrics are missing, so treat the score as a rough read."
      ]),
      { severity: 2, tag: "low_confidence", basis: "mixed" }
    );
  }
  if (currentVm?.confidenceMeta?.level === "low") {
    add(
      "quality",
      "note",
      pick("confidence_low", [
        "Lower confidence: filings may be stale or incomplete (see the confidence pill).",
        "Lower confidence: this ticker has limited/stale filing coverage right now.",
        "Lower confidence: some filing data may be old; treat the read as provisional."
      ]),
      { severity: 2, tag: "confidence_low", basis: "mixed" }
    );
  }

  // ========== Cash Flow / Liability Quality Signals ==========
  const seriesDesc = (() => {
    const src = (currentVm?.quarterlySeries && currentVm.quarterlySeries.length)
      ? currentVm.quarterlySeries
      : (currentVm?.annualSeries || []);
    return src
      .slice()
      .filter((p) => p && p.periodEnd)
      .sort((a, b) => Date.parse(b.periodEnd) - Date.parse(a.periodEnd));
  })();
  const recentSeries = (n = 12) => seriesDesc.slice(0, n);

  const sumRecentSeries = (getter, n = 12) => {
    const list = recentSeries(n);
    let sum = 0;
    let used = 0;
    for (const row of list) {
      const v = getter(row);
      const num = Number(v);
      if (!Number.isFinite(num)) continue;
      sum += num;
      used += 1;
    }
    return used ? { sum, used } : { sum: null, used: 0 };
  };

  // Cash conversion quality (3y): CFO vs Net Income
  const ni = sumRecentSeries((q) => q.netIncome, 12);
  const cfo = sumRecentSeries((q) => q.operatingCashFlow, 12);
  if (Number.isFinite(ni.sum) && ni.sum > 0 && Number.isFinite(cfo.sum)) {
    const ratio = cfo.sum / ni.sum;
    if (ratio > 1.1) {
      add(
        "quality",
        "good",
        pick("cash_conversion_good", [
          "Cash-rich earnings: operating cash flow has exceeded net income over the last ~3 years.",
          "Strong cash conversion: operating cash flow is running ahead of accounting profits.",
          "High-quality earnings: cash generation has outpaced reported profits recently.",
          "Cash conversion looks strong: the business is turning earnings into cash efficiently."
        ]),
        { severity: 2, tag: "cash_conversion_good", basis: "ttm" }
      );
    } else if (ratio < 0.8) {
      add(
        "quality",
        "risk",
        pick("cash_conversion_suspect", [
          "Accrual-heavy earnings: cash from operations is lagging net income over the last ~3 years.",
          "Cash conversion looks weak: reported profits are not translating into operating cash flow.",
          "Earnings quality flag: operating cash flow has trailed net income for an extended period.",
          "Profit may be less cash-backed than it looks: CFO is running below net income."
        ]),
        { severity: 2, tag: "cash_conversion_suspect", basis: "ttm" }
      );
    }
  }

  // Capex vs Depreciation (3y): reinvestment intensity proxy
  const capex = sumRecentSeries((q) => q.capex, 12);
  const dep = sumRecentSeries((q) => q.depreciationDepletionAndAmortization, 12);
  if (Number.isFinite(capex.sum) && Number.isFinite(dep.sum) && dep.sum > 0) {
    const capexOut = Math.abs(capex.sum);
    const ratio = capexOut / dep.sum;
    if (ratio > 1.5) {
      add(
        "quality",
        "note",
        pick("capex_vs_dep_expand", [
          "Reinvestment is elevated: CapEx has run well above depreciation (expanding infrastructure).",
          "CapEx intensity is high versus depreciation, suggesting the company is building/expanding assets.",
          "Investment-heavy phase: CapEx is outpacing depreciation by a wide margin.",
          "CapEx is running meaningfully above depreciation, signaling expansion or major upgrades."
        ]),
        { severity: 1, tag: "capex_vs_dep_expand", basis: "ttm" }
      );
    } else if (ratio < 1.0) {
      add(
        "quality",
        "note",
        pick("capex_vs_dep_harvest", [
          "CapEx is running below depreciation, which can signal underinvestment or asset harvesting.",
          "Reinvestment looks light: CapEx is below depreciation, potentially indicating aging assets.",
          "CapEx vs depreciation is low; growth may rely more on existing assets than new investment.",
          "CapEx is trailing depreciation, which may indicate maintenance-only spending."
        ]),
        { severity: 1, tag: "capex_vs_dep_harvest", basis: "ttm" }
      );
    }
  }

  // Deferred revenue trajectory (YoY): contract liabilities as a proxy for future revenue locked in
  const drSeries = recentSeries(8)
    .map((r) => ({
      date: r.periodEnd,
      val: toNumber(r.deferredRevenue ?? r.contractWithCustomerLiability)
    }))
    .filter((r) => Number.isFinite(r.val));
  if (drSeries.length >= 5) {
    const latest = drSeries[0];
    const latestTs = Date.parse(latest.date);
    const target = latestTs - 31536000000;
    const windowMs = 2600000000;
    const yearAgo = drSeries.find((p) => {
      const ts = Date.parse(p.date);
      return Number.isFinite(ts) && Math.abs(ts - target) < windowMs;
    });
    if (yearAgo && Number.isFinite(yearAgo.val) && yearAgo.val !== 0) {
      const yoy = (latest.val - yearAgo.val) / Math.abs(yearAgo.val);
      if (yoy > 0.15) {
        add(
          "quality",
          "good",
          pick("deferred_rev_up", [
            "Deferred revenue is rising year-over-year, which can indicate future revenue already locked in.",
            "Contract liabilities are growing YoY, suggesting improving forward revenue visibility.",
            "Deferred revenue is trending higher, supporting subscription/backlog strength.",
            "Rising deferred revenue can be a positive signal for renewal strength and future revenue."
          ]),
          { severity: 1, tag: "deferred_rev_up", basis: baseBasis }
        );
      } else if (yoy < -0.15) {
        add(
          "quality",
          "risk",
          pick("deferred_rev_down", [
            "Deferred revenue is declining year-over-year, which can be an early churn/backlog risk signal.",
            "Contract liabilities are down YoY, potentially signaling weaker forward revenue visibility.",
            "Deferred revenue is shrinking, which can indicate softer renewals or backlog burn-off.",
            "Declining deferred revenue may point to demand softness or higher churn risk."
          ]),
          { severity: 1, tag: "deferred_rev_down", basis: baseBasis }
        );
      }
    }
  }

  // Contingent liabilities (filing language) -> solvency note
  const hasContingentLiabilities = (Array.isArray(filingSignals) ? filingSignals : [])
    .some((s) => String(s?.id || "") === "contingent_liabilities");
  if (hasContingentLiabilities) {
    add(
      "solvency",
      "note",
      pick("contingent_liabilities", [
        "Filing language mentions commitments/contingencies; review the footnotes for potential off-balance-sheet risks.",
        "Commitments and contingencies are referenced in filings—worth checking for legal, warranty, or environmental exposures.",
        "Filings flag commitments/contingencies; these can be material even when not obvious in the main statements.",
        "Contingency language appears in filings; potential obligations may not be fully captured in headline metrics."
      ]),
      { severity: 1, tag: "contingent_liabilities", basis: "mixed" }
    );
  }

  // Multi-signal / tension bullets (hard rule compliant)
  if (runwayShort && deepBurn) {
    add(
      "solvency",
      "risk",
      pick("runway_short_burn", [
        `Cash looks tight: at the current pace, it may last under a year (${fmtYears1(runwayYears)} runway).`,
        `Short runway (${fmtYears1(runwayYears)}): unless spending drops or funding arrives, cash could run out within ~12 months.`,
        `Funding risk: runway is under a year (${fmtYears1(runwayYears)}) while the business is still ${describeCashBurn(fcfMargin) || "cash-flow negative"}.`
      ]),
      { severity: 3, tag: "runway_short_burn", basis: "mixed" }
    );
  } else if (runwayShort && dilutionHigh) {
    add(
      "solvency",
      "risk",
      pick("runway_short_dilution", [
        `Short runway (${fmtYears1(runwayYears)}): the company has likely needed outside funding, and share issuance can dilute holders.`,
        `Runway is under a year (${fmtYears1(runwayYears)}). Recent share issuance suggests fundraising may be ongoing.`,
        `Cash runway is short (${fmtYears1(runwayYears)}), and ${describeDilution(dilutionYoY) || "share issuance is elevated"}—a common funding path when cash is tight.`
      ]),
      { severity: 3, tag: "runway_short_dilution", basis: "mixed" }
    );
  } else if (runwayTight && burn) {
    add(
      "solvency",
      "note",
      pick("runway_tight_burn", [
        `Runway is limited (~${fmtYears1(runwayYears)}). It’s still spending more cash than it brings in.`,
        `Cash runway is around ${fmtYears1(runwayYears)}. Funding risk is present if burn stays high.`,
        `Runway is about ${fmtYears1(runwayYears)} and the business is still ${describeCashBurn(fcfMargin) || "cash-flow negative"}.`
      ]),
      { severity: 2, tag: "runway_tight_burn", basis: "mixed" }
    );
  }

  if (burn && runwayTight && cashImproving) {
    add(
      "quality",
      "note",
      pick("burn_improving_but_tight", [
        `Cash burn is improving, but the runway is still only about ${fmtYears1(runwayYears)}.`,
        `Spending is trending in the right direction, but cash runway remains tight (~${fmtYears1(runwayYears)}).`,
        `Burn rate looks better lately, but runway is still limited (${fmtYears1(runwayYears)}).`
      ]),
      { severity: 2, tag: "burn_improving_but_tight", basis: "mixed" }
    );
  } else if (burn && runwayShort && cashWorsening) {
    add(
      "solvency",
      "risk",
      pick("burn_worsening_and_short", [
        `Cash burn is getting worse and the runway is under a year (${fmtYears1(runwayYears)}).`,
        `Runway is short (${fmtYears1(runwayYears)}) and the burn rate is deteriorating—financing risk rises.`,
        `Spending pressure is increasing while runway is under a year (${fmtYears1(runwayYears)}).`
      ]),
      { severity: 3, tag: "burn_worsening_and_short", basis: "mixed" }
    );
  }

  if (deepBurn && dilutionHigh) {
    add(
      "quality",
      "risk",
      pick("burn_plus_dilution", [
        "Burn + dilution: they appear to be funding operations by issuing shares (which can reduce each shareholder’s slice).",
        "Cash burn plus share issuance: growth may be funded by new shares rather than profits.",
        "They’re burning cash and raising money through equity—good for survival, but it can dilute holders."
      ]),
      { severity: 2, tag: "burn_plus_dilution", basis: "mixed" }
    );
  }
  if (dilutionHigh && debtScore != null && debtScore >= 4) {
    add(
      "quality",
      "note",
      pick("dilution_masks_leverage", [
        "Debt looks manageable, but share issuance suggests they may be raising cash via equity instead of borrowing.",
        "Low debt can be a strength—but if new shares are being issued, funding may be coming from dilution.",
        "Leverage is fine, yet dilution is notable; the company may be choosing equity raises over debt."
      ]),
      { severity: 2, tag: "dilution_masks_leverage", basis: "mixed" }
    );
  }
  if (dilutionPersistent && dilutionHigh) {
    add(
      "quality",
      "note",
      pick("dilution_persistent", [
        "Dilution looks ongoing: share count keeps rising quarter after quarter.",
        "Share issuance appears persistent (not just a one-time event).",
        "New shares seem to be a recurring funding tool right now."
      ]),
      { severity: 2, tag: "dilution_persistent", basis: "mixed" }
    );
  }

  if (growthStrong && burn) {
    add(
      "quality",
      "note",
      pick("growth_burn", [
        "Sales are growing, but the business isn’t generating free cash yet.",
        "Top-line growth is strong, but it’s still spending more cash than it brings in.",
        "Growth is healthy, but profitability hasn’t turned into cash generation yet."
      ]),
      { severity: 2, tag: "growth_burn", basis: "ttm" }
    );
  } else if (growthStrong && profitWeak) {
    add(
      "quality",
      "note",
      pick("growth_profit_weak", [
        "Sales are growing, but core operations are still losing money.",
        "Revenue is up, but the business hasn’t reached operating profitability yet.",
        "Growth is there, but operating profits haven’t followed yet."
      ]),
      { severity: 2, tag: "growth_profit_weak", basis: "ttm" }
    );
  } else if (growthWeak && profitStrong && !marginsCompressing) {
    add(
      "quality",
      "note",
      pick("shrink_but_profitable", [
        "Revenue is down, but the core business still looks profitable.",
        "Sales are shrinking, yet margins remain healthy—this can signal a mature cash-generator.",
        "Top line is soft, but profitability is holding up."
      ]),
      { severity: 2, tag: "shrink_but_profitable", basis: "ttm" }
    );
  }

  // Positive multi-signal bullets (to avoid “quiet” sections on strong large caps)
  if (growthStrong && profitStrong && !burn) {
    add(
      "quality",
      "good",
      pick("good_growth_profit_cash", [
        "Strong combo: growing sales, profitable operations, and positive cash generation.",
        "This looks like a healthy business mix: growth + profits + cash flow.",
        "Growth is supported by profitability and cash generation (not just accounting profits)."
      ]),
      { severity: 1, tag: "good_growth_profit_cash", basis: "mixed" }
    );
  }
  if (profitStrong && Number.isFinite(fcfMargin) && fcfMargin > 5 && Number.isFinite(dilutionYoY) && dilutionYoY <= 5) {
    add(
      "quality",
      "good",
      pick("good_profit_cash_low_dilution", [
        "Strong quality setup: profitable, cash-generating, and not issuing many new shares.",
        "Healthy profile: profits turn into cash, and dilution is minimal.",
        "A shareholder-friendly mix: strong cash generation and low dilution."
      ]),
      { severity: 1, tag: "good_profit_cash_low_dilution", basis: "mixed" }
    );
  }
  if (Number.isFinite(dilutionYoY) && dilutionYoY < -2 && Number.isFinite(fcfMargin) && fcfMargin > 0) {
    add(
      "quality",
      "good",
      pick("good_buybacks_cash", [
        "Cash is positive and the company is reducing share count (buybacks).",
        "They’re generating cash and shrinking the share count—often a good shareholder signal.",
        "Positive cash flow plus buybacks: shareholders aren’t being diluted."
      ]),
      { severity: 1, tag: "good_buybacks_cash", basis: "mixed" }
    );
  }
  if (valuationCheapish && profitStrong && !burn) {
    add(
      "valuation",
      "good",
      pick("good_value_plus_quality", [
        "Valuation looks reasonable given the profitability (see cards).",
        "Looks fairly priced relative to business quality and profitability.",
        "Valuation and fundamentals both look supportive."
      ]),
      { severity: 1, tag: "good_value_plus_quality", basis: "mixed" }
    );
  }

  if (growthStrong && marginsCompressing) {
    add(
      "quality",
      "note",
      pick("growth_but_margin_pressure", [
        "Sales are growing, but profits per dollar of sales are slipping.",
        "Revenue is up, but margins are under pressure.",
        "Growth is strong, yet profitability is tightening."
      ]),
      { severity: 2, tag: "growth_but_margin_pressure", basis: "mixed" }
    );
  } else if (growthWeak && marginsCompressing) {
    add(
      "quality",
      "risk",
      pick("downturn_operating_leverage", [
        "Sales are shrinking and margins are falling—often a tough mix.",
        "Revenue is down and profitability is worsening; costs may not be flexing down yet.",
        "Both sales and margins are moving the wrong way at the same time."
      ]),
      { severity: 2, tag: "downturn_operating_leverage", basis: "mixed" }
    );
  }

  if (Number.isFinite(ndFcfYears) && Number.isFinite(interestCoverage) && ndFcfYears > 6 && interestCoverage < 2.5) {
    add(
      "solvency",
      "risk",
      pick("leverage_plus_coverage", [
        "Debt looks heavy relative to cash generation, and interest coverage is thin.",
        "Debt burden looks high and profits may not comfortably cover interest costs.",
        "Leverage looks stretched and interest payments may be hard to cover."
      ]),
      { severity: 3, tag: "leverage_plus_coverage", basis: "mixed" }
    );
  }

  if (hasNegativeEquity && dilutionHigh) {
    add(
      "solvency",
      "risk",
      pick("neg_equity_plus_dilution", [
        "Balance sheet shows negative equity, and the company has been issuing shares—higher-risk setup.",
        "Negative equity plus share issuance suggests the balance sheet is under strain.",
        "With negative equity and ongoing dilution, financing flexibility may be limited."
      ]),
      { severity: 3, tag: "neg_equity_plus_dilution", basis: "mixed" }
    );
  }

  if (valuationOverstretched && (growthWeak || burn || profitWeak)) {
    add(
      "valuation",
      "risk",
      pick("val_stretched_fundamentals", isPreRevenueBiotech ? [
        "Valuation looks stretched while the company is still in a cash-burn phase; biotech pricing can swing hard on milestone news.",
        "The stock looks priced for success, but the fundamentals are still early-stage—biotech valuations can reset quickly.",
        "Valuation looks demanding for a pre-revenue biotech; upside often hinges on milestones, and downside can be sharp if expectations reset."
      ] : [
        "The stock looks priced for good news, but the fundamentals are currently weak—risk of a valuation reset.",
        "Valuation looks demanding relative to current fundamentals; downside if expectations come down.",
        "If results don’t improve, the market may pay a lower price for the same business (valuation compression risk)."
      ]),
      { severity: 2, tag: "val_stretched_fundamentals", basis: "mixed" }
    );
  } else if (valuationCheapish && (runwayShort || deepBurn || dilutionHigh)) {
    add(
      "valuation",
      "note",
      pick("cheap_but_fragile", [
        "It may look cheap on paper, but funding risk matters (runway/dilution).",
        "Some valuation metrics look attractive, but financing risk can still dominate the story.",
        "Valuation looks better than peers, but the company may still need to raise cash."
      ]),
      { severity: 2, tag: "cheap_but_fragile", basis: "mixed" }
    );
  }

  // Filing-only fallback (demoted): show a single filing-driven risk if there are no cards.
  if (!hasCards && hasFilingSignals) {
    const topNeg = filingSignals
      .filter((s) => Number(s?.score) < 0)
      .sort((a, b) => Number(a?.score || 0) - Number(b?.score || 0))[0];
    const title = String(topNeg?.title || topNeg?.id || "").trim();
    if (title) {
      add("quality", "risk", `Filing signal: ${title}.`, { severity: 2, tag: "filing_fallback", basis: "mixed" });
    }
  }

  // Red single-metric fallback: allow only when severe (or data-quality critical) to prevent “quiet bullets”.
  if (runwayShort && !seenTags.has("runway_short_burn") && !seenTags.has("runway_short_dilution")) {
    add(
      "solvency",
      "risk",
      pick("red_runway", [
        `Cash runway looks under a year (${fmtYears1(runwayYears)}).`,
        `Short runway (${fmtYears1(runwayYears)}): watch for financing or cost-cutting.`,
        `Runway is tight (${fmtYears1(runwayYears)}); a cash raise may be needed if burn persists.`
      ]),
      { severity: 3, tag: "red_runway", basis: "mixed" }
    );
  }
  if (Number.isFinite(dilutionYoY) && dilutionYoY > 50 && !seenTags.has("burn_plus_dilution") && !seenTags.has("neg_equity_plus_dilution")) {
    add(
      "quality",
      "risk",
      pick("red_dilution", [
        "Share count jumped a lot over the last year (high dilution risk).",
        "Large share issuance over the last year can meaningfully dilute holders.",
        "Significant dilution: the company has issued a lot of new shares recently."
      ]),
      { severity: 3, tag: "red_dilution", basis: "annual" }
    );
  }
  if (hasNegativeEquity && !seenTags.has("neg_equity_plus_dilution")) {
    add(
      "solvency",
      "risk",
      pick("red_negative_equity", [
        "Negative equity: liabilities exceed assets on the balance sheet.",
        "Negative equity flag: the balance sheet is in a deficit position.",
        "Balance sheet deficit (negative equity) increases financial risk."
      ]),
      { severity: 3, tag: "red_negative_equity", basis: baseBasis }
    );
  }
  if (Number.isFinite(interestCoverage) && interestCoverage < 1.5 && !seenTags.has("leverage_plus_coverage")) {
    add(
      "solvency",
      "risk",
      pick("red_coverage", [
        "Interest payments may be hard to cover from operating profits.",
        "Debt interest looks hard to cover from profits (thin coverage).",
        "Thin interest coverage: profits don’t leave much cushion for interest costs."
      ]),
      { severity: 3, tag: "red_coverage", basis: baseBasis }
    );
  }
  if (Number.isFinite(ndFcfYears) && ndFcfYears > 8 && !seenTags.has("leverage_plus_coverage")) {
    add(
      "solvency",
      "risk",
      pick("red_netdebt_fcf", [
        "Debt looks large compared with the cash the business generates.",
        "Debt burden looks high relative to cash generation.",
        "Paying down debt could take a long time at the current cash generation pace."
      ]),
      { severity: 3, tag: "red_netdebt_fcf", basis: "mixed" }
    );
  }
  if (f.debtReported && !f.cashReported) {
    add(
      "quality",
      "risk",
      pick("dq_cash_missing", [
        "Data note: cash is missing, so it’s harder to judge debt safety.",
        "Data note: missing cash data makes leverage and runway harder to estimate.",
        "Data note: cash isn’t reported here; treat leverage signals as lower confidence."
      ]),
      { severity: 3, tag: "dq_cash_missing", basis: "mixed" }
    );
  }

  if (!bullets.length) {
    add("quality", "note", "No bullets triggered (limited signals); use the cards for metric-level detail.", { severity: 1, tag: "no_combined_alerts", basis: baseBasis });
  }

  const score =
    bullets.filter((b) => b.startsWith(BULLET_PREFIX.good)).length -
    bullets.filter((b) => b.startsWith(BULLET_PREFIX.risk)).length;

  const label = (() => {
    const marketCap = Number(stock?.marketCap ?? currentVm?.marketCap ?? currentVm?.keyMetrics?.marketCap);
    const assetSize = (() => {
      const series = Array.isArray(currentVm?.quarterlySeries) && currentVm.quarterlySeries.length
        ? currentVm.quarterlySeries
        : Array.isArray(currentVm?.annualSeries)
          ? currentVm.annualSeries
          : [];
      const latest = series
        .slice()
        .sort((a, b) => Date.parse(b?.periodEnd || 0) - Date.parse(a?.periodEnd || 0))[0] || null;
      const v = Number(latest?.totalAssets);
      return Number.isFinite(v) ? v : null;
    })();

    const scaleRef = (() => {
      // Market cap can be garbage when pricing is sparse; fall back to asset size when it looks implausible.
      if (Number.isFinite(marketCap) && marketCap > 0) {
        if (Number.isFinite(assetSize) && assetSize > 100_000_000 && marketCap < 25_000_000) {
          return assetSize;
        }
        return marketCap;
      }
      return Number.isFinite(assetSize) ? assetSize : null;
    })();

    const capClass = (() => {
      const v = Number(scaleRef);
      if (!Number.isFinite(v) || v <= 0) return null;
      if (v < 200_000_000) return "micro";
      if (v < 1_000_000_000) return "small";
      if (v < 10_000_000_000) return "mid";
      if (v < 200_000_000_000) return "large";
      return "mega";
    })();

    if (isPenny && capClass === "micro") {
      return pick("risk.penny.microcap", [
        "Higher risk setup; micro-cap volatility and financing constraints.",
        "Speculative micro-cap profile: expect volatility and funding risk.",
        "Micro-cap risk profile: volatility is likely and funding can be episodic."
      ]);
    }
    if (isPenny) {
      return pick("risk.penny.nonmicro", [
        "Higher risk setup; low-priced stock volatility and financing constraints.",
        "Higher risk profile: low-priced shares can be volatile and funding-sensitive.",
        "Higher risk setup: expect elevated volatility and periodic financing risk."
      ]);
    }

    const band = stock?.ratingTierLabel || currentVm?.ratingTierLabel || null;
    const riskCount = bullets.filter((b) => b.startsWith(BULLET_PREFIX.risk)).length;
    const goodCount = bullets.filter((b) => b.startsWith(BULLET_PREFIX.good)).length;
    const onlyNoSignalNote = bullets.length === 1 && seenTags.has("no_combined_alerts");

    const hasSevere =
      [...seenTags].some((t) => String(t).startsWith("red_")) ||
      seenTags.has("dq_cash_missing") ||
      seenTags.has("model_bankruptcy") ||
      seenTags.has("filing_going_concern") ||
      seenTags.has("runway_short_burn") ||
      seenTags.has("runway_short_dilution") ||
      seenTags.has("leverage_plus_coverage");

    if (hasSevere) {
      return pick("risk.severe", [
        "Higher risk; financing or data-quality flags are red.",
        "Higher risk setup: multiple red flags need close monitoring.",
        "Elevated risk: key funding, leverage, or data-quality signals are flashing red."
      ]);
    }
    if (seenTags.has("burn_plus_dilution") || seenTags.has("dilution_persistent")) {
      return pick("risk.funding", [
        "Elevated risk; funding and issuance likely drive the story.",
        "Financing-driven profile: dilution and burn appear to be key risks.",
        "Capital dependence risk: funding needs may be a recurring theme."
      ]);
    }
    if (seenTags.has("val_stretched_fundamentals")) {
      return pick("risk.valuation", [
        "Valuation-sensitive setup; fundamentals must deliver.",
        "Valuation risk: the setup requires execution to justify expectations.",
        "Expectations look high; fundamentals need to keep compounding."
      ]);
    }
    if (onlyNoSignalNote) {
      if (band === "elite" || band === "bullish" || band === "solid") {
        return pick("risk.low.none", [
          "Lower risk profile; no combined red flags triggered.",
          "Lower risk profile: no major combined red flags detected.",
          "Lower risk profile: nothing critical is flashing red right now."
        ]);
      }
      if (band === "danger" || band === "spec") {
        return pick("risk.uncertain", [
          "Higher uncertainty; limited combined signals triggered.",
          "Higher uncertainty: signals are thin; rely on the cards for detail.",
          "Uncertain setup: limited signals available to form strong conclusions."
        ]);
      }
      return pick("risk.moderate.limited", [
        "Moderate risk; limited combined signals triggered.",
        "Moderate risk profile: limited combined signals, but no major red flags.",
        "Moderate risk: signals are mixed and somewhat sparse."
      ]);
    }
    if (goodCount >= 2 && riskCount === 0) {
      return pick("risk.low.strong", [
        "Lower risk profile; cash generation and margins look strong.",
        "Lower risk setup: strong cash generation and healthy margins support resilience.",
        "Lower risk profile: profitability and cash flow look supportive."
      ]);
    }
    if (score >= 2 && riskCount === 0) {
      return pick("risk.low.supportive", [
        "Lower risk profile; fundamentals look supportive.",
        "Lower risk setup: fundamentals look broadly supportive.",
        "Lower risk profile: underlying fundamentals look steady."
      ]);
    }
    if (goodCount >= 1 && riskCount >= 1) {
      return pick("risk.mixed", [
        "Mixed setup; strengths exist but risks need monitoring.",
        "Balanced setup: upside exists, but risks should be monitored.",
        "Mixed profile: positives show up, but key risks remain."
      ]);
    }
    return pick("risk.moderate.default", [
      "Moderate risk; see combined-signal notes below.",
      "Moderate risk profile; review the combined signals for details.",
      "Moderate risk setup; the signal mix is not one-sided."
    ]);
  })();
  return { score, label, bullets, grouped };
}

function updateSummaries(stock) {
  const risk = computeRiskSummary(stock);
  const riskEl = document.getElementById("riskSummary");
  const riskList = document.getElementById("riskReasons");
  if (riskEl) riskEl.textContent = risk.label;
  if (riskList) {
    const groups = risk.grouped || {};
    const ordered = [
      ["solvency", "SOLVENCY", "&#127974;"], // Bank
      ["quality", "QUALITY", "&#128202;"],     // Chart (top-right)
      ["valuation", "VALUATION", "&#128181;"]  // Banknote (second row under Solvency)
    ];
    const html = ordered
      .map(([key, label, icon]) => {
        const items = (groups[key] || [])
          .sort((a, b) => (b.severity || 0) - (a.severity || 0))
          .slice(0, 4);
        if (!items.length) return "";
        const lis = items.map((i) => `<li>${i.label}</li>`).join("");
        return `<div class="risk-group"><div class="risk-heading">${icon} ${label}</div><ul class="muted" style="padding-left:16px; margin:0; line-height:1.3;">${lis}</ul></div>`;
      })
      .filter(Boolean)
      .join("");
    if (html) riskList.innerHTML = html;
    else {
      const bullets = (risk.bullets || []).slice(0, 10);
      riskList.innerHTML = bullets.map(b => `<li>${b}</li>`).join("") || "";
    }
  }
}

function updatePillars(stock, ratingMeta = null) {
  const { fundamentals, strength, momentum, consistency, quality } = computePillarScores(stock, 0);
  lastPillars = { fundamentals, strength, momentum, consistency, quality };
  lastStockForTakeaway = stock;
  const ratingNormalized = ratingMeta?.normalizedScore ?? ratingMeta?.normalized ?? null;
  const ratingRaw = ratingMeta?.rawScore ?? null;
  const ratingTier = ratingMeta?.tierLabel ?? null;
  const normalizedRating = applyQuality(ratingNormalized ?? quality, {
    rawScore: ratingRaw,
    normalizedScore: ratingNormalized,
    tierLabel: ratingTier,
    takeaway: stock.narrative // Pass narrative to applyQuality
  });
  applyTier(normalizedRating, { tierLabel: ratingTier });
  renderSignalGrid(stock);
}

// Recommended normalization: wider bounds to avoid easy 100/100 scores.
const RATING_MIN = -60; // Captures truly distressed companies
const RATING_MAX = 100; // Reserves 100/100 for near-perfect execution
const RATING_RANGE = RATING_MAX - RATING_MIN || 1;
function normalizeRuleScore(score) {
  const num = Number(score);
  if (!Number.isFinite(num)) return null;
  const normalized = ((num - RATING_MIN) / RATING_RANGE) * 100;
  return Math.round(Math.max(0, Math.min(100, normalized)));
}
function formatRatingText(rawScore, normalized) {
  if (Number.isFinite(normalized)) return `${normalized.toFixed(0)}/100`;
  if (Number.isFinite(rawScore)) {
    const rounded = Math.round(rawScore);
    const prefix = rounded > 0 ? "+" : "";
    return `${prefix}${rounded}`;
  }
  return "--";
}
function applyQuality(value, { rawScore = null, normalizedScore = null, tierLabel = null, takeaway = null } = {}) {
  const dot = document.getElementById("tierDotTop");
  const text = document.getElementById("qualityTextTop");
  const gauge = document.getElementById("qualityGaugeFill");
  const takeawayEl = document.getElementById("ratingTakeaway");
  const normalizedFromRaw = normalizeRuleScore(rawScore);

  let v = Number.isFinite(normalizedScore)
    ? normalizedScore
    : Number.isFinite(normalizedFromRaw)
      ? normalizedFromRaw
      : Math.max(0, Math.min(100, value || 0));

  // Client-side overrides removed - relying on server-side logic for caps & completeness.

  if (text) text.textContent = formatRatingText(rawScore, v);

  const band = tierLabel || getScoreBand(v);

  if (dot) {
    dot.classList.remove("bullish", "neutral", "bearish", "insufficient");
    if (band === "danger" || band === "spec") dot.classList.add("bearish");
    else if (band === "mixed") dot.classList.add("neutral");
    else dot.classList.add("bullish");
  }

  if (gauge) {
    gauge.style.width = `${v}%`;
    gauge.style.background = colorForBand(v);
  }

  if (takeawayEl) {
    // PRIORITIZE DYNAMIC NARRATIVE FROM BACKEND
    let baseTakeaway = takeaway || buildTakeaway(band);

    const formatted = (() => {
      const target = baseTakeaway || "";
      const idx = target.toLowerCase().indexOf("regulatory filings");
      if (idx > -1) {
        const first = target.slice(0, idx).trim();
        const second = target.slice(idx).trim();
        return [first, second].filter(Boolean).join("\n");
      }
      return target;
    })();
    takeawayEl.innerHTML = escapeHtml(formatted).replace(/\n/g, "<br>");
  }

  // Update tier badge if it exists
  const tierBadge = document.getElementById("tierBadge");
  if (tierBadge) {
    tierBadge.textContent = tierLabel || band;
    tierBadge.style.color = ""; // reset color
  }

  return v;
}


function applyBar(fillId, textId, value, isQuality = false) {
  const fill = document.getElementById(fillId);
  const text = textId ? document.getElementById(textId) : null;
  const v = Math.max(0, Math.min(100, value || 0));
  if (fill) {
    fill.style.width = `${v}%`;
    fill.style.background = colorForBand(v);
  }
  if (text) text.textContent = isQuality ? `${v.toFixed(0)}/100` : `${v.toFixed(0)}%`;
}

function computePillarScores(stock, totalScore) {
  const clamp = (v) => Math.max(0, Math.min(100, v));
  const g = stock.growth || {};
  const p = stock.profitMargins || {};
  const f = stock.financialPosition || {};
  const m = stock.momentum || {};
  const s = stock.stability || {};
  const ps = stock.priceStats || {};
  const isPenny = isPennyStockVm(currentVm, stock);

  let fundamentals = 50;
  if (g.revenueGrowthTTM != null) fundamentals += g.revenueGrowthTTM > 20 ? 12 : g.revenueGrowthTTM > 8 ? 8 : g.revenueGrowthTTM > 0 ? 4 : -8;
  if (p.profitMargin != null) fundamentals += p.profitMargin > 15 ? 10 : p.profitMargin > 5 ? 6 : p.profitMargin > 0 ? 3 : -8;
  if (p.fcfMargin != null) fundamentals += p.fcfMargin > 15 ? 8 : p.fcfMargin > 5 ? 5 : p.fcfMargin > 0 ? 2 : -6;

  let strength = 50;
  if (f.netDebtToFcfYears != null) strength += f.netDebtToFcfYears < 2 ? 14 : f.netDebtToFcfYears < 4 ? 8 : f.netDebtToFcfYears < 6 ? 2 : -12;
  if (f.interestCoverage != null) strength += f.interestCoverage > 12 ? 10 : f.interestCoverage > 6 ? 6 : f.interestCoverage > 2 ? 2 : -10;
  if (f.currentRatio != null) strength += f.currentRatio > 1.8 ? 6 : f.currentRatio > 1.2 ? 3 : f.currentRatio > 1 ? 1 : -6;
  if (s.fcfPositiveYears != null) strength += s.fcfPositiveYears >= 4 ? 8 : s.fcfPositiveYears >= 2 ? 4 : -8;

  let momentum = 50;
  if (m.marginTrend != null) momentum += m.marginTrend > 3 ? 6 : m.marginTrend > 0 ? 3 : -4;
  if (m.fcfTrend != null) momentum += m.fcfTrend > 5 ? 6 : m.fcfTrend > 0 ? 3 : -4;
  if (ps.change30d != null) momentum += ps.change30d > 10 ? 6 : ps.change30d > 2 ? 3 : ps.change30d < -5 ? -6 : 0;
  if (ps.rangePosition != null) momentum += ps.rangePosition >= 0.66 ? 2 : ps.rangePosition <= 0.33 ? -2 : 0;

  let consistency = 50;
  if (s.fcfPositiveYears != null) consistency += s.fcfPositiveYears >= 4 ? 8 : s.fcfPositiveYears >= 2 ? 4 : -6;
  if (ps.priceStreak != null) consistency += ps.priceStreak >= 3 ? 4 : ps.priceStreak <= -3 ? -4 : 0;
  const ebitdaQuarters = s.ebitdaPositiveQuarters;
  if (isPenny && (!Number.isFinite(ebitdaQuarters) || ebitdaQuarters < 4)) {
    consistency = Math.min(consistency, 25);
  }

  const quality = clamp(
    (fundamentals * 0.4) +
    (strength * 0.25) +
    (momentum * 0.2) +
    (consistency * 0.15)
  );
  return {
    fundamentals: clamp(fundamentals),
    strength: clamp(strength),
    momentum: clamp(momentum),
    consistency: clamp(consistency),
    quality
  };
}

function toneClass(val, good, warn = 0) {
  if (!Number.isFinite(val)) return "tone-neutral";
  if (val >= good) return "tone-good";
  if (val >= warn) return "tone-warn";
  return "tone-risk";
}

function renderSignalGrid(stock) {
  const el = document.getElementById("signalGrid");
  if (!el) return;
  const g = stock.growth || {};
  const p = stock.profitMargins || {};
  const f = stock.financialPosition || {};
  const sectorBucket = stock.sectorBucket || "";
  const preRevenueBiotech = isBiotechSector(sectorBucket) && (!Number.isFinite(stock.revenueLatest) || Math.abs(stock.revenueLatest) < 1_000_000);
  const revenueValue = Number.isFinite(g.revenueGrowthTTM)
    ? formatPctCompact(g.revenueGrowthTTM)
    : (preRevenueBiotech ? "Pre-revenue biotech" : "n/a");
  const revenueNote = Number.isFinite(g.revenueGrowthTTM)
    ? (g.revenueGrowthTTM > 0 ? "Sales are growing." : "Sales are shrinking.")
    : (preRevenueBiotech ? "Early-stage biotech; revenue not meaningful yet." : "Revenue trend unavailable.");
  const profitValue = Number.isFinite(p.profitMargin) ? `${formatPctCompact(p.profitMargin)} margin` : (preRevenueBiotech ? "Pre-revenue biotech" : "n/a");
  const profitNote = Number.isFinite(p.profitMargin)
    ? (p.profitMargin > 0 ? "Profits positive." : "Still losing money.")
    : (preRevenueBiotech ? "Margins not meaningful for a pre-revenue biotech." : "Margin data missing.");
  const latestPrice = (() => {
    const series = Array.isArray(priceSeriesFull) ? priceSeriesFull : [];
    const fromVm = Number(currentVm?.priceSummary?.lastClose);
    const fromSeries = series.length ? Number(series[series.length - 1]?.close) : null;
    return Number.isFinite(fromVm) ? fromVm : (Number.isFinite(fromSeries) ? fromSeries : null);
  })();
  el.innerHTML = "";

  const isForeign = stock?.issuerType === "foreign" || stock?.filingProfile?.annual === "20-F" || stock?.filingProfile?.interim === "6-K";
  if (isForeign) {
    el.style.display = 'block';
    el.style.width = '100%';
    el.style.maxWidth = '100%';
    el.style.gridTemplateColumns = 'none'; // reset any grid columns
    const currencyMismatch = stock?.snapshot?.currencyMismatch;
    const reportingCur = stock?.snapshot?.reportingCurrency || "local currency";
    const priceCur = stock?.snapshot?.priceCurrency || "price currency";
    const currencyNote = currencyMismatch
      ? ` Pricing uses ${priceCur}, filings use ${reportingCur}; valuation ratios may be skewed.`
      : "";
    const text = `<strong>Foreign Issuer:</strong> This is a foreign company on the stock market and ratings are based on year on year documents.${currencyNote}`;

    el.innerHTML = `
        <div style="width: 100%; box-sizing: border-box; background: rgba(245, 158, 11, 0.1); border: 1px solid rgba(245, 158, 11, 0.3); border-radius: 6px; padding: 12px; display: flex; align-items: center; gap: 10px; color: #fbbf24; font-size: 0.9rem; margin-bottom: 8px;">
           <div style="font-size: 1.2rem; line-height: 1; margin-top: -2px;">&#9888;</div>
           <div style="white-space: normal; line-height: 1.4; flex: 1;">${text}</div>
        </div>
      `;
  }

  // Biotech warning bubble - only for clinical-stage biotechs, not established pharma
  const isBiotechSectorLocal = (() => {
    const sector = String(stock?.sectorBucket || stock?.sector || "").toLowerCase();
    const sicDesc = String(stock?.sicDescription || "").toLowerCase();
    const name = String(stock?.companyName || "").toLowerCase();
    return sector.includes("biotech") ||
      sector.includes("pharma") ||
      sicDesc.includes("pharmaceutical") ||
      sicDesc.includes("biological") ||
      sicDesc.includes("medicinal") ||
      /\b(therapeutics|biopharma|oncology|biosciences)\b/i.test(name);
  })();

  const isEstablishedPharmaLocal = (() => {
    if (!isBiotechSectorLocal) return false;
    const revenueTTM = Number(stock?.snapshot?.revenueTTM ?? stock?.keyMetrics?.revenueTTM ?? 0);
    const netIncome = Number(stock?.snapshot?.netIncomeTTM ?? stock?.keyMetrics?.netIncome ?? 0);
    const marketCap = Number(stock?.marketCap ?? stock?.keyMetrics?.marketCap ?? 0);
    return revenueTTM > 2_000_000_000 ||
      (revenueTTM > 500_000_000 && netIncome > 0) ||
      marketCap > 50_000_000_000;
  })();

  const isClinicalStageBiotechLocal = isBiotechSectorLocal && !isEstablishedPharmaLocal;

  if (isClinicalStageBiotechLocal) {
    const existingHtml = el.innerHTML;
    const biotechText = `<strong>Clinical Stage Biotech:</strong> Traditional financial metrics have limited relevance. Investment thesis depends on clinical trial outcomes - a binary bet.`;
    el.innerHTML = existingHtml + `
        <div style="width: 100%; box-sizing: border-box; background: rgba(147, 51, 234, 0.1); border: 1px solid rgba(147, 51, 234, 0.3); border-radius: 6px; padding: 12px; display: flex; align-items: center; gap: 10px; color: #c084fc; font-size: 0.9rem; margin-bottom: 8px;">
           <div style="font-size: 1.2rem; line-height: 1; margin-top: -2px;">&#129516;</div>
           <div style="white-space: normal; line-height: 1.4; flex: 1;">${biotechText}</div>
        </div>
      `;
    el.style.display = 'block';
    el.style.width = '100%';
  }
  // Removed "achievements" cards (Revenue, Profit, Cash & Debt main blocks) per user request
}

function renderPriceChart(series) {
  const canvas = document.getElementById("priceChart");
  const tooltip = document.getElementById("priceTooltip");
  if (!canvas || !Array.isArray(series) || !series.length) { if (tooltip) tooltip.style.display = "none"; return; }
  const ctx = canvas.getContext("2d");
  const width = canvas.width = canvas.clientWidth || 600;
  const height = canvas.height = 220;
  const sorted = [...series].sort((a, b) => new Date(a.date) - new Date(b.date)); // oldest -> newest
  const closes = sorted.map(p => Number(p.close || p.price)).filter(v => isFinite(v));
  const dates = sorted.map(p => new Date(p.date));
  if (!closes.length) { ctx.clearRect(0, 0, width, height); if (tooltip) tooltip.style.display = "none"; return; }
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const range = max - min || 1;
  ctx.clearRect(0, 0, width, height);
  // Axes
  ctx.strokeStyle = "rgba(255,255,255,0.1)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(40, 10);
  ctx.lineTo(40, height - 25);
  ctx.lineTo(width - 10, height - 25);
  ctx.stroke();
  // Grid labels (min, mid, max)
  ctx.fillStyle = "rgba(255,255,255,0.6)";
  ctx.font = "12px Poppins, Segoe UI, sans-serif";
  ctx.fillText(max.toFixed(2), 4, 18);
  ctx.fillText(min.toFixed(2), 4, height - 28);
  const mid = (max + min) / 2;
  ctx.fillText(mid.toFixed(2), 4, (height - 25) / 2);
  // Dates: four ticks
  const tickCount = 4;
  for (let i = 0; i < tickCount; i++) {
    const idx = Math.floor((series.length - 1) * (i / (tickCount - 1)));
    const d = dates[idx];
    const label = d.toISOString().slice(0, 10);
    const x = 40 + (idx / (series.length - 1 || 1)) * (width - 50);
    ctx.fillText(label, x - 30, height - 8);
  }
  // Line + store points for hover
  ctx.strokeStyle = "#5dd0ff";
  ctx.lineWidth = 2;
  ctx.beginPath();
  chartPoints = [];
  sorted.forEach((p, idx) => {
    const x = 40 + (idx / (sorted.length - 1 || 1)) * (width - 50);
    const y = height - 25 - ((Number(p.close || p.price) - min) / range) * (height - 40);
    chartPoints.push({ x, y, date: dates[idx], close: Number(p.close || p.price) });
    if (idx === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
  // Hover
  canvas.onmousemove = (e) => {
    if (!chartPoints.length || !tooltip) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    let nearest = chartPoints[0];
    let minDist = Math.abs(mx - nearest.x);
    for (const pt of chartPoints) {
      const d = Math.abs(mx - pt.x);
      if (d < minDist) { minDist = d; nearest = pt; }
    }
    tooltip.style.display = "block";
    tooltip.style.left = `${nearest.x + 10}px`;
    tooltip.style.top = `${nearest.y - 30}px`;
    tooltip.innerHTML = `${nearest.date.toISOString().slice(0, 10)}<br>$${nearest.close.toFixed(2)}`;
  };
  canvas.onmouseleave = () => { if (tooltip) tooltip.style.display = "none"; };
}

function filterSeriesByRange(series, range) {
  if (!Array.isArray(series)) return [];
  if (range === "all") return series;
  const now = new Date(series[0]?.date || Date.now());
  const daysMap = { "1d": 1, "1w": 7, "3m": 90, "6m": 180, "1y": 365 };
  const days = daysMap[range] || 99999;
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - days);
  return series.filter(s => new Date(s.date) >= cutoff);
}

function nf(val) {
  if (val === Infinity) return "∞";
  if (val === -Infinity) return "-∞";
  if (val === null || val === undefined || isNaN(val)) return "-";
  const num = Number(val);
  if (Math.abs(num) >= 1e9) return (num / 1e9).toFixed(2) + "B";
  if (Math.abs(num) >= 1e6) return (num / 1e6).toFixed(2) + "M";
  return num.toLocaleString();
}
function numf(val, { nullLabel = "-" } = {}) {
  const num = toNumber(val);
  if (num === Infinity) return "∞";
  if (num === -Infinity) return "-∞";
  if (num === null || Number.isNaN(num)) return nullLabel;
  if (num === 0) return "0.00";
  return num.toFixed(2);
}
function pctf(val) {
  const num = pctFromRatio(val);
  if (num === Infinity) return "∞%";
  if (num === -Infinity) return "-∞%";
  return num === null ? "-" : `${num.toFixed(2)}%`;
}
function pctChange(curr, prev) { if (!isFinite(curr) || !isFinite(prev) || prev === 0) return null; return ((curr - prev) / Math.abs(prev)) * 100; }
function calcMargin(num, den) { if (!isFinite(num) || !isFinite(den) || den === 0) return null; return (num / den) * 100; }
function calcFcf(r) { if (!r) return null; const cfo = Number(r.netCashProvidedByOperatingActivities ?? r.operatingCashFlow); const capex = Number(r.capitalExpenditure); if (!isFinite(cfo) || !isFinite(capex)) return null; return cfo + capex; }
function pctFromRatio(val) { const num = percentToNumber(val); if (num === null) return null; return Math.abs(num) <= 1 ? num * 100 : num; }
function toNumber(val) {
  if (val === Infinity || val === -Infinity) return val;
  const num = percentToNumber(val);
  return num === null ? null : num;
}

const isForeignIssuer = () => {
  const issuerType = currentVm?.issuerType;
  const profile = currentVm?.filingProfile || {};
  const is20F = profile?.annual === "20-F" || profile?.interim === "6-K";
  return issuerType === "foreign" || is20F;
};

function formatValuation(val) {
  const num = toNumber(val);
  if (num === Infinity) return "∞";
  if (num === -Infinity) return "-∞";
  if (num === null || Number.isNaN(num)) {
    return isForeignIssuer() ? "Unavailable (not computed for foreign filers)" : "Not available";
  }
  return num.toFixed(2);
}

function formatRunway(val) {
  const num = toNumber(val);
  if (num === Infinity) return "∞ (no burn or cash flow positive)";
  if (num === -Infinity) return "-∞";
  if (num === null || Number.isNaN(num)) return "Not reported";
  if (num === 0) return "0 (no cash runway)";
  if (Number.isFinite(num) && num > 0 && num < 1) return `~${Math.max(1, Math.round(num * 12))} mo`;
  return `${num.toFixed(1)} yrs`;
}

function formatCoverage(val) {
  const num = toNumber(val);
  if (num === Infinity) return "∞ (no interest burden)";
  if (num === -Infinity) return "-∞";
  if (num === null || Number.isNaN(num)) return "Not reported";
  if (Number.isFinite(num) && num <= 0) return "Not covered";
  return `${num.toFixed(2)}x`;
}

function formatPaybackYears(val) {
  const num = toNumber(val);
  if (num === Infinity) return "∞";
  if (num === -Infinity) return "-∞";
  if (num === null || Number.isNaN(num)) return "Not reported";
  if (num === 0) return "0.0 yrs";
  return `${num.toFixed(1)} yrs`;
}

function hasDebtField(entry) {
  if (!entry) return false;
  const keys = ["totalDebt", "longTermDebt", "longTermDebtNoncurrent", "shortLongTermDebtTotal", "shortTermDebt", "totalDebtAndCapitalLeaseObligation"];
  return keys.some((k) => entry[k] !== undefined && entry[k] !== null);
}
function hasCashField(entry) {
  if (!entry) return false;
  const keys = ["cashAndCashEquivalents", "cashAndShortTermInvestments", "cash", "shortTermInvestments"];
  const explicit = [
    ...keys,
    "cashAndCashEquivalentsAtCarryingValue",
    "cashAndCashEquivalentsAndShortTermInvestments",
    "cashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
    "cashCashEquivalentsRestrictedCashAndRestrictedCashEquivalentsIncludingDisposalGroupAndDiscontinuedOperations"
  ];
  if (explicit.some((k) => entry[k] !== undefined && entry[k] !== null)) return true;
  // Fallback: some providers use slightly different cash field names; treat any balance-sheet key
  // that clearly looks like cash/cash equivalents as evidence of disclosure.
  return Object.keys(entry).some((k) => /cash/i.test(k) && /(equival|restrict|invest)/i.test(k));
}
function formatPctCompact(val, { cap = 200 } = {}) {
  if (!Number.isFinite(val)) return "n/a";
  const abs = Math.abs(val);
  if (abs >= cap) {
    const label = val < 0 ? `&lt; -${cap}%` : `>${cap}%`;
    return `<span class="pct-condensed" title="${val.toFixed(1)}%">${label}</span>`;
  }
  return `${val.toFixed(1)}%`;
}
function formatDebtSummary(f = {}, opts = {}) {
  const hasDebt = f.debtReported;
  const hasCash = f.cashReported;
  const debtIsZero = f.debtIsZero === true;
  const netCash = f.netCash === true || (Number.isFinite(f.netDebt) && f.netDebt < 0);
  const netDebtYears = f.netDebtToFcfYears;
  const debtVal = f.totalDebt;
  if (debtIsZero) {
    return { value: "Debt-free", note: "Company reported zero debt this period.", tone: "tone-good" };
  }
  if (netCash) {
    return { value: "Net cash (no net debt)", note: "Cash exceeds debt; balance sheet cushioned.", tone: "tone-good" };
  }
  if (Number.isFinite(netDebtYears) && Number.isFinite(f.netDebt) && f.netDebt > 0 && netDebtYears < 1) {
    const months = Math.max(1, Math.round(netDebtYears * 12));
    return {
      value: `~${months} mo to clear debt`,
      note: `Free Cash Flow could retire debt in about ${months} month${months === 1 ? "" : "s"}.`,
      tone: "tone-good"
    };
  }
  if (Number.isFinite(netDebtYears)) {
    const tone = netDebtYears <= 3 ? "tone-good" : netDebtYears <= 6 ? "tone-warn" : "tone-risk";
    const note =
      netDebtYears <= 3
        ? `Debt well-covered (${netDebtYears.toFixed(1)}x Free Cash Flow).`
        : netDebtYears <= 6
          ? `Debt leverage moderate (${netDebtYears.toFixed(1)}x Free Cash Flow).`
          : `Debt burden high relative to cash flow (${netDebtYears.toFixed(1)}x).`;
    return { value: `${netDebtYears.toFixed(1)} yrs debt/flow`, note, tone };
  }
  if (!hasDebt) {
    return { value: "Debt data missing", note: "Latest filing did not report debt detail.", tone: "tone-neutral" };
  }
  if (hasDebt && !hasCash) {
    return {
      value: "Debt reported; cash data missing.",
      note: "Cash disclosure is missing, so leverage can't be fully assessed.",
      tone: "tone-warn"
    };
  }
  if (hasDebt && Number.isFinite(debtVal) && debtVal === 0) {
    return { value: "Debt-free", note: "Company reported zero debt this period.", tone: "tone-good" };
  }
  return { value: "Debt data missing", note: "Latest filing did not report debt detail.", tone: "tone-neutral" };
}

if (manualPriceApply) {
  manualPriceApply.addEventListener("click", () => {
    const val = Number(manualPriceInput?.value);
    if (!Number.isFinite(val)) {
      if (manualPriceNote) manualPriceNote.textContent = "Enter a valid price (numbers only).";
      return;
    }
    saveManualPrice(val, todayIso());
    statusEl.textContent = "Applying manual price...";
    closeManualPriceModal();
    loadAll().catch(handleLoadError);
  });
}

if (manualPriceClear) {
  manualPriceClear.addEventListener("click", () => {
    clearManualPrice();
    if (manualPriceNote) manualPriceNote.textContent = "Manual price cleared.";
    statusEl.textContent = "Last Close - --";
    closeManualPriceModal();
    loadAll().catch(handleLoadError);
  });
}

if (manualPriceClose && manualPriceModal) {
  manualPriceClose.addEventListener("click", () => closeManualPriceModal());
  manualPriceModal.addEventListener("click", (e) => {
    if (e.target === manualPriceModal) closeManualPriceModal();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && manualModalShown) closeManualPriceModal();
  });
}

if (missingTickerModal) {
  const back = () => { window.location.href = "index.html"; };
  const dismiss = () => closeMissingTickerModal();
  missingTickerBack?.addEventListener("click", back);
  missingTickerDismiss?.addEventListener("click", dismiss);
  missingTickerClose?.addEventListener("click", dismiss);
  missingTickerModal.addEventListener("click", (e) => {
    if (e.target === missingTickerModal) dismiss();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && missingTickerModal.style.display === "flex") dismiss();
  });
}

goBtn.addEventListener("click", () => {
  selectedProvider = providerSelect.value;
  loadAll().catch(handleLoadError);
});

loadAll().catch(handleLoadError);

const setTableState = (btn, open) => {
  const label = btn.getAttribute("data-label") || "Table";
  btn.textContent = `${open ? "Hide" : "Show"} ${label}`;
  btn.setAttribute("aria-expanded", String(open));
};
const toggleTablePanel = (btn) => {
  const targetId = btn.getAttribute("data-panel-target");
  const panel = document.getElementById(targetId);
  if (!panel) return;
  const willOpen = panel.classList.contains("hidden");
  panel.classList.toggle("hidden");
  setTableState(btn, willOpen);
};
tableToggles.forEach(btn => {
  setTableState(btn, false);
  const targetId = btn.getAttribute("data-panel-target");
  const panel = document.getElementById(targetId);
  if (panel) panel.classList.add("hidden");
  btn.addEventListener("click", (e) => { e.preventDefault(); toggleTablePanel(btn); });
});

if (rangeSwitch) {
  rangeSwitch.addEventListener("click", (e) => {
    if (e.target.tagName !== "BUTTON") return;
    [...rangeSwitch.querySelectorAll("button")].forEach(btn => btn.classList.remove("active"));
    e.target.classList.add("active");
    selectedRange = e.target.getAttribute("data-range");
    const filtered = filterSeriesByRange(priceSeriesFull, selectedRange);
    renderPriceChart(filtered);
  });
}

statusEl.textContent = "Last Close - --";

// Preload from bundle/cache on first load for current ticker, before provider choice.
(async () => {
  try {
    // Attempt to load bundle and cached data without API
    const preloadedIncome = await fetchWithCache("income", "", { noApiWhenMissing: true });
    const preloadedBalance = await fetchWithCache("balance", "", { noApiWhenMissing: true });
    const preloadedCash = await fetchWithCache("cash", "", { noApiWhenMissing: true });
    const preloadedKeyMetrics = await fetchWithCache("key-metrics", "", { noApiWhenMissing: true });
    const preloadedRatios = await fetchWithCache("ratios", "", { noApiWhenMissing: true });
    const preloadedKeyMetricsTtm = await fetchWithCache("key-metrics-ttm", "", { noApiWhenMissing: true });
    const preloadedRatiosTtm = await fetchWithCache("ratios-ttm", "", { noApiWhenMissing: true });
    const preloadedPriceFull = await fetchWithCache("chart-full", "", { noApiWhenMissing: true });
    const preloadedPriceLight = await fetchWithCache("chart-light", "", { noApiWhenMissing: true });
    if (preloadedIncome || preloadedBalance || preloadedCash) {
      renderTables(preloadedIncome || [], preloadedBalance || [], preloadedCash || [], preloadedKeyMetrics || [], preloadedRatios || [], preloadedKeyMetricsTtm || [], preloadedRatiosTtm || []);
      const preStock = buildStockFromStatements({
        income: preloadedIncome || [],
        balance: preloadedBalance || [],
        cash: preloadedCash || [],
        keyMetrics: preloadedKeyMetrics || [],
        ratios: preloadedRatios || [],
        keyMetricsTtm: preloadedKeyMetricsTtm || [],
        ratiosTtm: preloadedRatiosTtm || [],
        financialScores: [],
        ownerEarnings: [],
        incomeGrowth: [],
        priceFull: preloadedPriceFull || []
      });
      renderScoreboard([], preStock, null, null);
      const priceInfo = renderPriceBlock(preloadedPriceLight || [], preloadedPriceFull || []);
      priceSeriesFull = priceInfo.seriesForChart || [];
      priceSeriesLight = preloadedPriceLight || [];
      renderPriceChart(filterSeriesByRange(priceSeriesFull, selectedRange));
      const parsedSnapshotPrice = parsePriceString(priceInfo.lastCloseText);
      const latestPrice = getLatestPrice(preloadedPriceFull, preloadedPriceLight);
      const resolvedPrice = latestPrice ?? priceInfo.latestPrice ?? parsedSnapshotPrice ?? getCachedPrice();
      const resolvedNum = Number(resolvedPrice);
      if (Number.isFinite(resolvedNum)) {
        updatePriceDisplay(resolvedNum, priceInfo.lastCloseText, priceInfo.dayChange);
      } else {
        const cachedOnly = getCachedPrice();
        if (Number.isFinite(cachedOnly)) {
          updatePriceDisplay(cachedOnly, `$${cachedOnly.toFixed(2)}`, null);
        }
      }
      const preResolvedPrice = Number.isFinite(resolvedNum)
        ? resolvedNum
        : (parsedSnapshotPrice ?? getCachedPrice());
      renderSnapshot(preloadedIncome || [], preloadedBalance || [], preloadedCash || [], preloadedKeyMetrics || [], preloadedKeyMetricsTtm || [], preloadedRatios || [], priceSeriesFull, preResolvedPrice);
    }
  } catch (err) {
    console.debug("preload cache failed", err);
  }
})();
