
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

function clearManualPrice() {
  localStorage.removeItem(manualPriceKey);
  if (manualPriceNote) manualPriceNote.textContent = "";
  if (manualPriceInput) manualPriceInput.value = "";
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

function renderFilingSignals(signals = []) {
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
    .sort((a, b) => Math.abs(Number(b.score) || 0) - Math.abs(Number(a.score) || 0))
    .forEach((sig) => {
      const score = Number(sig.score) || 0;
      const tone = score > 0 ? "tone-good" : score < 0 ? "tone-risk" : "";
      const scoreText = score > 0 ? `+${score}` : `${score}`;
      const snippet = (sig.snippet || "").slice(0, 220) + ((sig.snippet || "").length > 220 ? "…" : "");
      const card = document.createElement("div");
      card.className = `filing-card ${tone}`.trim();
      card.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
          <div class="tag">${scoreText}</div>
          <div class="score">${sig.title || "Filing signal"}</div>
        </div>
        <div class="title">${sig.form || ""}${sig.filed ? ` · ${sig.filed}` : ""}</div>
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
  const isBio = bucket === "Biotech/Pharma" ||
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
          console.debug(`  ✓ chunk item ${idx + 1} ok`);
          return r;
        } catch (err) {
          console.warn(`  ✗ chunk item ${idx + 1} failed: ${err.message || err}`);
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
  const ageHours = (Date.now() - ts) / (1000 * 60 * 60);
  return ageHours > maxAgeHours;
}

async function ensurePriceReady(vm, maxTries = 5, delayMs = 1500) {
  const manual = readManualPrice();
  if (manual) {
    const withManual = applyManualPriceToVm(vm);
    updatePriceDisplay(manual.price, `$${manual.price.toFixed(2)}`, null);
    return withManual;
  }
  if (hasPrice(vm) && !isPriceStale(vm) && vm?.pricePending === false) return vm;
  let latest = vm;
  const tries = Math.max(10, maxTries); // wait longer before giving up
  for (let i = 0; i < tries; i++) {
    await sleep(delayMs);
    try {
      const res = await fetch(`${API_ROOT}/ticker/${encodeURIComponent(ticker)}`, {
        headers: { Accept: "application/json" }
      });
      const data = await res.json();
      const nextVm = data?.data || data;
      latest = nextVm || latest;
      if (hasPrice(nextVm) || nextVm?.pricePending === false) {
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
  for (let i = 0; i < maxTries; i++) {
    try {
      const res = await fetch(`${API_ROOT}/ticker/${encodeURIComponent(ticker)}`, {
        headers: { Accept: "application/json" }
      });
      const data = await res.json();
      lastPayload = data;
      lastStatus = data?.status || data?.data?.status || null;
      const vm = data?.data || data;
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
  if (statusEl) statusEl.textContent = "Still preparing EDGAR data... try again shortly.";
  hideLoadingOverlay();
  return lastPayload?.data || lastPayload || null;
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
      if (cached !== undefined) return cached;
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
      const res = await fetch(`${API_ROOT}/ticker/${encodeURIComponent(ticker)}`, {
        headers: { Accept: "application/json" }
      });
      if (res.status === 404) {
        showDeadTickerState();
        return;
      }
      const data = await res.json();
      const status = data?.status;
      if (status && status !== "ready") {
        vmPayload = await waitForTickerReady();
      } else {
        vmPayload = data?.data || data;
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
    <div style="font-size:48px; margin-bottom:16px;">👻</div>
    <h2 style="font-size:24px; margin-bottom:12px; font-weight:700;">Ticker Not Found</h2>
    <p style="font-size:16px; color:#9fb3c8; max-width:400px; line-height:1.5;">
      We couldn’t find usable EDGAR filings for <strong>${ticker}</strong>.
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
        renderFilingSignals(filingSignals);
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
  renderFilingSignals(filingSignals);

  // Map view model -> legacy shapes for renderers
  const quartersDesc = (vmPayload.quarterlySeries || [])
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
    commonStockSharesOutstanding: q.sharesOutstanding,
    shortTermInvestments: q.shortTermInvestments
  }));
  const cash = quartersDesc.map((q) => ({
    date: q.periodEnd,
    netCashProvidedByOperatingActivities: q.operatingCashFlow,
    operatingCashFlow: q.operatingCashFlow,
    capitalExpenditure: q.capex,
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
  const debugTag = `[${ticker}-debug]`;
  console.debug(`${debugTag} quartersDesc head`, quartersDesc.slice(0, 3));
  console.debug(`${debugTag} price summary`, vmPayload.priceSummary, "price fallback", priceCloseFallback, "prev", pricePrevFallback);
  console.debug(`${debugTag} keyMetrics rows`, keyMetrics);
  console.debug(`${debugTag} ratios rows`, ratios);

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
    narrative: vmPayload.narrative
  });
  const baseReasons = Array.isArray(vmPayload.ratingReasons) ? vmPayload.ratingReasons : [];
  // Keep filing intelligence out of the finance cards; those show in the filing section.
  const combinedReasons = baseReasons.filter(
    (reason) =>
      (reason?.source || "").toLowerCase() !== "filing" &&
      !String(reason?.name || "").toLowerCase().startsWith("filing")
  );
  renderScoreboard(combinedReasons, stock, ratingMeta, vmPayload.ratingCompleteness);
  renderFilingSignals(filingSignals);
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
}

function renderProjections(vm) {
  const wrap = document.querySelector(".future-outlook");
  const grid = document.getElementById("futureGrid");
  if (!wrap || !grid) return;
  const proj = vm.projections || {};
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
  const growthScore = clampScore(proj.growthContinuationScore ?? proj.futureGrowthScore);
  const dilutionScore = clampScore(proj.dilutionRiskScore ?? proj.dilutionRisk);
  const rawBankruptcyScore = clampScore(proj.bankruptcyRiskScore);
  const businessTrend = normalizeTrend(proj.businessTrendLabel ?? proj.deteriorationLabel);
  const marketCap = Number(keyMetrics.marketCap ?? keyMetrics.marketCapTTM);
  const interestCoverSnap = toNumber(snapshot.interestCoverage);
  const netDebtYears = toNumber(snapshot.netDebtToFCFYears);
  const largeCap = Number.isFinite(marketCap) && marketCap >= 5e10;
  let bankruptcyScore = rawBankruptcyScore;
  if (largeCap && bankruptcyScore !== null) {
    const strongCover = Number.isFinite(interestCoverSnap) && interestCoverSnap > 8;
    const lightLeverage = Number.isFinite(netDebtYears) && netDebtYears < 2;
    const cap = (strongCover || lightLeverage) ? 0.25 : 0.35;
    bankruptcyScore = Math.min(bankruptcyScore, cap);
  }

  const growthMeta = classifyGrowth(growthScore);
  // Override label if server provided a specific momentum label
  if (proj.growthContinuationLabel) {
    growthMeta.label = proj.growthContinuationLabel;
  }
  const dilutionMeta = classifyRisk(dilutionScore);
  const bankruptcyMeta = classifyRisk(bankruptcyScore, " Risk");

  const trajectoryCopy =
    businessTrend === "Improving"
      ? "Revenue and FCF slopes are strengthening."
      : businessTrend === "Worsening"
        ? "Key profitability or cash metrics are deteriorating."
        : "Core metrics are moving sideways.";
  const trajectoryColor =
    businessTrend === "Improving" ? "#5ce0c2" : businessTrend === "Worsening" ? "#ff9b9b" : "#e0e8f5";
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
  const momentumMicro = `Revenue CAGR (3Y): ${pctf(snapshot.revenueCAGR3Y)} | OCF trend: ${ocfTrend}`;

  // Removed barWidth calculation as bars are being removed/hidden or just decorative
  const barWidth = (score) => `${(clampScore(score) ?? 0) * 100}%`;

  // Restoring grid.style for card layout compatibility
  grid.style.display = "grid";
  // Re-implementing cards - Removing Risk Radar as requested
  grid.style.gridTemplateColumns = "1fr 1fr"; // Force 2 columns
  grid.innerHTML = `
        <div class="future-card">
          <div class="future-label">Upside Momentum</div>
          <div class="future-value-row">
            <div class="future-value" style="font-size:1.3em;">${growthMeta.label}</div>
          </div>
          <div class="future-bar"><div class="fill" style="width:${barWidth(growthScore)}; background:${growthMeta.color};"></div></div>
          <div class="future-footnote">Trend Strength</div>
          <div class="future-note">${growthContext}</div>
        </div>
        <div class="future-card">
          <div class="future-label">Trajectory</div>
          <div class="trajectory-title" style="color:${trajectoryColor};">${businessTrend || "Pending"}</div>
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
  const debtReported = hasDebtField(curBal);
  const cashReported = hasCashField(curBal);
  const debtBal = toNumber(
    curBal.totalDebt ??
    curBal.longTermDebt ??
    curBal.longTermDebtNoncurrent ??
    curBal.shortLongTermDebtTotal ??
    curBal.shortTermDebt
  );
  const debtIsZero = debtReported && debtBal === 0;
  const cashBal = toNumber(curBal.cashAndCashEquivalents ?? curBal.cash);
  const stiBal = toNumber(curBal.shortTermInvestments);
  const netDebt = (() => {
    if (!Number.isFinite(debtBal)) return null;
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
    shareStats: { sharesOutstanding: curBal.commonStockSharesOutstanding, sharesChangeYoY, sharesChangeQoQ: sharesChange, insiderOwnership: null, institutionOwnership: null, float: null },
    valuationRatios: { peRatio, forwardPE: toNumber(keyLatest.forwardPE), psRatio, forwardPS: toNumber(keyLatest.forwardPS), pbRatio, pfcfRatio, pegRatio: toNumber(keyLatest.pegRatio), evToEbitda, fcfYield },
    expenses: { rdToRevenue: pctFromRatio(curInc.researchAndDevelopmentExpenses && curInc.revenue ? curInc.researchAndDevelopmentExpenses / curInc.revenue * 100 : null) },
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
  const latestQuarter = (vm.quarterlySeries || []).slice(-1)[0] || {};
  const cash = toNumber(latestQuarter.cash ?? latestQuarter.cashAndCashEquivalents);
  const sti = toNumber(latestQuarter.shortTermInvestments);
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
  const isBio = bucket === "Biotech/Pharma" ||
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
      dilutionHigh: dilutionYoY != null && dilutionYoY > 0.2,
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
      lowDilution: dilutionYoY != null && dilutionYoY <= 0.02 && (!dilutionRiskScore || dilutionRiskScore < 0.3)
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
  const reasons = Array.isArray(reasonList) ? reasonList.slice() : [];
  const missing = reasons.filter(r => r.missing);
  // Filter out Neutral (0 score) items from the main display to reduce noise
  const applicable = reasons.filter(r => !r.missing && r.score !== 0);
  applicable.sort((a, b) => Math.abs(b.score) - Math.abs(a.score) || b.score - a.score);
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
    const badgeClass = getScoreClass(reason.score);
    div.className = "reason-card".trim();
    const explainer = ruleExplainers[reason.name] || {};
    const posText = explainer.pos || "Positive scores mean the metric meets or beats the target, reinforcing quality/valuation strength.";
    const negText = explainer.neg || "Negative scores mean the metric falls short, signaling risk, dilution, or overvaluation.";
    const explainerText = reason.score >= 0 ? posText : negText;
    const titleText = toTitleCase(reason.name);
    const numericScore = Number(reason.score) || 0;
    const scoreText = numericScore > 0 ? `+${numericScore}` : (numericScore < 0 ? `${numericScore}` : "0");
    const displayValue = reason.message || "N/A";
    const icon = iconForRule(reason.name, usedIcons, iconPool);
    div.innerHTML = `
          <div class="header">
            <div class="icon">${icon}</div>
            <div class="title whitespace-normal leading-tight">${titleText}</div>
            <div class="score-tag ${badgeClass}">${scoreText}</div>
          </div>
          <div class="value-pill ${badgeClass} whitespace-normal leading-tight" style="margin-top:4px;">${displayValue}</div>
          <div class="muted" style="font-size:12px; line-height:1.35;">${explainerText}</div>
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
      const pct = Math.max(0, Math.min(100, ((reasons.length - missingCount) / reasons.length) * 100));
      return { missing: missingCount, applicable: reasons.length - missingCount, percent: pct };
    }
    return null;
  })();
  updateSummaries(stock);
  updatePillars(stock, ratingMeta);
  applyCompleteness(resolvedCompleteness);
  renderAchievements();
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
    { key: "pfcfRatio", alt: "priceToFreeCashFlowsRatio", label: "P/FCF", formatter: numf, tone: "", noTone: true },
    { key: "peRatio", label: "P/E", formatter: numf, tone: "", noTone: true },
    { key: "priceToSalesRatio", label: "P/S", formatter: numf, tone: "", noTone: true },
    { key: "priceToBookRatio", label: "P/B", formatter: numf, tone: "", noTone: true }
  ], kmsTtmEntry);

  renderTransposed(document.getElementById("ratiosTable"), ratios, [
    { key: "currentRatio", label: "Current Ratio", formatter: numf, tone: "", noTone: true },
    { key: "quickRatio", label: "Quick Ratio", formatter: numf, tone: "", noTone: true },
    { key: "debtEquityRatio", alt: "debtToEquity", label: "Debt/Equity", formatter: numf, tone: "", noTone: true },
    { key: "interestCoverage", label: "Interest Coverage (TTM)", formatter: numf, tone: "", noTone: true },
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
  return { rangeText: `${formatPrice(low)}  ${formatPrice(high)}`, label, positionLabel, position, low, high, price };
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

  stEl.innerHTML = `
    <div class="price-main-row">
      <span class="status-label">Last Close</span> 
      <span class="status-value">${priceDisplay}</span>
    </div>
    <div style="display:flex; flex-direction:column; line-height:1.2; margin-top:4px; align-items:flex-end; text-align:right;">
      <div style="font-size:10px; color:#9fb3c8; margin-bottom:2px; opacity:0.8;">
        Price last updated: ${dateStr} &middot; End-of-Day
      </div>
      <div style="font-size:9px; color:#5da4b4; opacity:0.6; margin-top:0;">
        (Bullish And Foolish uses official end-of-day pricing; intraday updates are not provided.)
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
  if (isPenny && Number.isFinite(qualityScore)) {
    if (qualityScore < 15) customLabel = "Severe Risk";
    else if (qualityScore < 30) customLabel = "Likely Value Trap";
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
    spec: "Volatile or early-stage. Could run hard — or collapse.",
    mixed: "Neutral profile — upside exists but not without caveats.",
    solid: "Steady fundamentals. Good for conservative portfolios.",
    bullish: "Strong financials & momentum. Attractive long-term setup.",
    elite: "Top-tier resilience + growth. Long-term compounder potential."
  };
  const tier = customLabel || labelMap[band] || "Analyst";
  console.debug("tier debug", { qualityScore, band, tier });
  if (tierBadge) {
    tierBadge.textContent = tier;
    tierBadge.title = customLabel || tooltipMap[band] || "";
    if (band === "incomplete") {
      tierBadge.style.background = "#e2e8f0";
      tierBadge.style.color = "#64748b";
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
    text.textContent = "Data completeness: n/a";
    if (pill) pill.classList.add("dim");
    if (icon) icon.textContent = "⚠️";
    return;
  }
  const clamped = Math.max(0, Math.min(100, pct));
  fill.style.width = `${clamped.toFixed(0)}% `;
  fill.style.background = colorForBand(clamped);
  text.textContent = `Data: ${clamped.toFixed(0)}% of key fields`;
  if (pill) {
    pill.classList.remove("good", "dim");
    if (clamped >= 90) pill.classList.add("good");
  }
  if (icon) icon.textContent = clamped < 70 ? "⚠️" : "ℹ️";
}

function getScoreBand(val) {
  if (typeof val === "string" && val.toLowerCase() === "incomplete") return "incomplete";
  const v = Number(val);
  if (!Number.isFinite(v)) return "incomplete"; // Default to incomplete if null/nan passed without label
  if (v >= 90) return "elite";
  if (v >= 75) return "bullish";
  if (v >= 60) return "solid";
  if (v >= 45) return "mixed";
  if (v >= 30) return "spec";
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
  if (el) el.innerHTML = "";
}
function iconForRule(name, usedIcons = null, pool = []) {
  const map = {
    "Revenue momentum": "&#128200;",
    "Gross margin quality": "&#129534;",
    "Operating margin": "&#128736;",
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
    let sayings = [
      "Penny-stock profile: fragile balance sheet; financing risk is high.",
      "Speculative setup; dilution and cash burn drive the story.",
      "Tiny-cap risk zone; treat any upside as optionality, not certainty."
    ];
    if (currentVm?.riskFactors && Array.isArray(currentVm.riskFactors) && currentVm.riskFactors.length) {
      sayings = [...sayings, ...currentVm.riskFactors];
    }
    return sayings[Math.floor(Math.random() * sayings.length)];
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
  const s = stock.stability || {};
  const p = stock.priceStats || {};
  const proj = currentVm?.projections || {};
  const isPenny = isPennyStockVm(currentVm, stock);
  const isBio = stock.sectorBucket === "biotech";
  const bullets = [];
  const grouped = { solvency: [], quality: [], valuation: [] };
  const seenTags = new Set();
  const push = (cat, kind, text) => {
    // Deduplication logic
    let tag = text;
    if (text.includes("runway")) tag = "runway";
    else if (text.includes("burn") || text.includes("FCF margin")) tag = "burn";
    else if (text.includes("dilution") || text.includes("Share count")) tag = "dilution";

    // User preference: keep "Short cash runway", suppress "going-concern" if runway already flagged
    if (seenTags.has(tag)) return;

    seenTags.add(tag);

    const bullet = makeBullet(kind, text);
    bullets.push(bullet);
    // Updated warning icon to emoji style ⚠️
    const icon = kind === "good" ? "&#9989;" : kind === "risk" ? "&#10060;" : "&#9888;&#65039;";
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push({ level: kind, text, label: `${icon} ${text} ` });
  };
  if (f.debtIsZero) {
    push("solvency", "good", "Debt-free balance sheet.");
  } else if (f.netCash) {
    push("solvency", "good", "Net cash position; no net debt.");
  }
  const ndFcf = f.netDebtToFcfYears;
  if (ndFcf != null) {
    if (ndFcf < 1 && Number.isFinite(f.netDebt) && f.netDebt > 0) {
      push("solvency", "good", "Net debt under ~1 year of FCF; light leverage.");
    } else if (ndFcf < 3) {
      push("solvency", "good", `Net debt payoff about ${ndFcf.toFixed(1)} yrs; manageable if FCF holds.`);
    } else if (ndFcf < 6) {
      push("solvency", "note", `Net debt / FCF ~${ndFcf.toFixed(1)} yrs; watch leverage.`);
    } else {
      push("solvency", "risk", `Heavy leverage: ~${ndFcf.toFixed(1)} yrs to clear debt; sensitive to shocks.`);
    }
  }
  const runwayYears = f.runwayYears;
  if (runwayYears != null) {
    if (runwayYears === Infinity) {
      push("solvency", "good", "Runway: Self-funded (FCF positive).");
    } else if (runwayYears < 1) {
      if (isBio) push("solvency", "risk", "Short cash runway; financing risk elevated.");
      else push("solvency", "risk", "Short cash runway; financing risk elevated.");

      if (runwayYears < 0.75) push("solvency", "risk", "Possible going-concern risk; cash runway under 9 months.");
    } else if (runwayYears < 2) {
      push("solvency", "note", `Cash runway ~${runwayYears.toFixed(1)} years; monitor burn vs catalysts.`);
    }
  }
  const fcfMargin = percentToNumber(stock.profitMargins?.fcfMargin);
  if (fcfMargin != null) {
    if (fcfMargin < -50) {
      if (isBio) {
        const burnRatio = Math.abs(fcfMargin / 100).toFixed(1);
        push("quality", "risk", `Cash Burn: ~$${burnRatio} per $1 of revenue — normal for early - stage biotech.Key factor is runway.`);
      } else {
        push("quality", "risk", "Deeply negative FCF margin; burn is heavy.");
      }
    }
    else if (fcfMargin < -10) push("quality", "note", "Negative FCF margin; needs funding or improvements.");
    if (isPenny && fcfMargin < 0) {
      // push("quality", "risk", "Deep negative free cash flow; burn rate elevated."); // deduplicated
    }
  }
  const bankruptcyRisk = toNumber(proj.bankruptcyRiskScore);
  if (bankruptcyRisk != null && bankruptcyRisk > 0.5) {
    push("solvency", "risk", "Model flags elevated bankruptcy risk; balance sheet is fragile.");
  }
  const dilutionRisk = toNumber(proj.dilutionRiskScore);
  if (dilutionRisk != null && dilutionRisk > 0.5) {
    push("quality", "risk", "High dilution risk; equity raises likely.");
  }
  if (f.interestCoverage != null) {
    if (f.interestCoverage > 8) push("solvency", "good", "Interest easily covered by earnings.");
    else if (f.interestCoverage > 4) push("solvency", "note", "Interest cover acceptable; monitor if earnings wobble.");
    else push("solvency", "risk", "Thin interest cover; downturn could stress payments.");
  }
  const dil = percentToNumber(stock?.shareStats?.sharesChangeYoY);
  if (dil != null) {
    if (dil < 2) {
      push("quality", "good", "Share count stable; low dilution risk.");
    } else if (dil <= 10) {
      push("quality", "note", `Share count up ~${formatPctCompact(dil)} YoY; monitor issuance.`);
    } else {
      if (isPenny && dil > 50) {
        push("quality", "risk", "Heavy dilution suggests continuous equity raises; survival depends on external capital.");
      } else if (dil > 100) {
        push("quality", "risk", "Death Spiral Dilution Risk.");
      } else {
        push("quality", "risk", "High dilution pattern; shareholder value pressure.");
      }
    }
  }
  if (Number.isFinite(fcfMargin) && fcfMargin < -25 && Number.isFinite(dil) && dil > 25) {
    push("quality", "risk", "Dependence on external financing (burn + dilution).");
  }
  if (s.fcfPositiveYears != null) {
    if (s.fcfPositiveYears >= 4) push("quality", "good", `Reliable FCF in ${s.fcfPositiveYears}/5 yrs; stability tailwind.`);
    else if (s.fcfPositiveYears >= 2) push("quality", "note", `Mixed FCF record (${s.fcfPositiveYears}/5 yrs).`);
    else push("quality", "risk", "Cash burn risk; FCF consistency weak.");
  }
  if (isPenny && (!Number.isFinite(s.ebitdaPositiveQuarters) || s.ebitdaPositiveQuarters < 4)) {
    push("quality", "risk", "Financial results show instability; business model not yet validated.");
  }
  if (f.debtToEquity != null) {
    if (f.debtToEquity < 0.6) push("solvency", "good", "Low leverage vs equity; balance sheet flexibility.");
    else if (f.debtToEquity > 2.5) push("solvency", "risk", "High leverage vs equity; limited cushion.");
  }
  if (p.drawdownFromHigh != null) {
    if (p.drawdownFromHigh < -20) push("valuation", "good", `Price ~${Math.abs(p.drawdownFromHigh).toFixed(1)}% below recent high.`);
    else if (p.drawdownFromHigh > -5) push("valuation", "note", "Trading near highs; needs continued momentum.");
  }
  const grossMargin = percentToNumber(stock?.profitMargins?.grossMargin);
  if (isPenny && Number.isFinite(grossMargin) && grossMargin < 20) {
    push("quality", "risk", "Cost structure inconsistent; pricing power limited.");
  }
  const revGrowth = percentToNumber(stock?.growth?.revenueGrowthTTM);
  if (Number.isFinite(revGrowth) && revGrowth > 50 && ((Number.isFinite(fcfMargin) && fcfMargin < 0) || (Number.isFinite(stock?.profitMargins?.operatingMargin) && stock.profitMargins.operatingMargin < 0))) {
    push("quality", "note", "Momentum strong, but fundamentals do not yet support a sustained trend.");
  }
  const score = bullets.filter(b => b.startsWith(BULLET_PREFIX.good)).length - bullets.filter(b => b.startsWith(BULLET_PREFIX.risk)).length;
  let label = "Moderate risk; read the factors below.";
  if (score >= 2) label = "Low risk profile; debt and cash flows look comfortable.";
  else if (score <= -2) label = "Higher risk; leverage or cash flow fragility.";
  if (isPenny) label = "Higher risk; leverage or cash flow fragility.";
  return { score, label, bullets, grouped };
}

function computeValuationSummary(stock = {}) {
  const v = stock.valuationRatios || {};
  const p = stock.priceStats || {};
  const bullets = [];
  const fcfMargin = percentToNumber(stock?.profitMargins?.fcfMargin);
  const isPenny = isPennyStockVm(currentVm, stock);
  const pfcfMeaningful = !(isPenny && Number.isFinite(fcfMargin) && fcfMargin < 0);
  if (pfcfMeaningful && v.pfcfRatio != null) {
    if (v.pfcfRatio < 12) bullets.push(makeBullet("good", "P/FCF in value zone; pricing leans cheap."));
    else if (v.pfcfRatio < 20) bullets.push(makeBullet("note", "P/FCF fair for quality."));
    else bullets.push(makeBullet("risk", "P/FCF elevated; needs strong execution."));
  } else if (!pfcfMeaningful) {
    bullets.push(makeBullet("note", "Valuation appears low on surface metrics, but negative cash flows reduce reliability."));
  }
  if (v.fcfYield != null) {
    if (v.fcfYield > 6) bullets.push(makeBullet("good", `FCF yield ${v.fcfYield.toFixed(1)}%: attractive cash return.`));
    else if (v.fcfYield > 3) bullets.push(makeBullet("note", `FCF yield ${v.fcfYield.toFixed(1)}%: reasonable.`));
    else bullets.push(makeBullet("risk", `Thin FCF yield ${v.fcfYield.toFixed(1)}%: limited cushion.`));
  }
  if (v.evToEbitda != null) {
    if (v.evToEbitda < 8) bullets.push(makeBullet("good", "EV/EBITDA below typical range; value tilt."));
    else if (v.evToEbitda > 20) bullets.push(makeBullet("risk", "EV/EBITDA rich vs fundamentals."));
  }
  if (p.drawdownFromHigh != null) {
    if (p.drawdownFromHigh < -20) bullets.push(makeBullet("good", `Discounted vs 52-week high (${p.drawdownFromHigh.toFixed(1)}%).`));
    else if (p.drawdownFromHigh > -5) bullets.push(makeBullet("note", "Trading near highs; needs continued momentum."));
  }
  const score = bullets.filter(b => b.startsWith(BULLET_PREFIX.good)).length - bullets.filter(b => b.startsWith(BULLET_PREFIX.risk)).length;
  let label = "Fairly priced; see context below.";
  if (score >= 2) label = "Value-leaning setup; multiples not stretched.";
  else if (score <= -2) label = "Rich valuation; upside needs strong catalysts.";
  return { score, label, bullets };
}

function updateSummaries(stock) {
  const risk = computeRiskSummary(stock);
  const val = computeValuationSummary(stock);
  const riskEl = document.getElementById("riskSummary");
  const riskList = document.getElementById("riskReasons");
  if (riskEl) riskEl.textContent = risk.label;
  if (riskList) {
    const groups = risk.grouped || {};
    const ordered = [
      ["solvency", "SOLVENCY", "&#127974;"], // Bank
      ["valuation", "VALUATION", "&#128181;"], // Banknote
      ["quality", "QUALITY", "&#128202;"]     // Chart
    ];
    const html = ordered
      .map(([key, label, icon]) => {
        const items = (groups[key] || []).slice(0, 4);
        if (!items.length) return "";
        const lis = items.map((i) => `<li>${i.label}</li>`).join("");
        return `<div class="risk-group"><div class="risk-heading">${icon} ${label}</div><ul class="muted" style="padding-left:16px; margin:0; line-height:1.3;">${lis}</ul></div>`;
      })
      .filter(Boolean)
      .join("");
    if (html) riskList.innerHTML = html;
    else {
      const bullets = (risk.bullets || []).slice(0, 6);
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

const RATING_MIN = -40;
const RATING_MAX = 60;
function normalizeRuleScore(score) {
  const num = Number(score);
  if (!Number.isFinite(num)) return null;
  const clamped = Math.max(RATING_MIN, Math.min(RATING_MAX, num));
  const span = RATING_MAX - RATING_MIN || 1;
  return ((clamped - RATING_MIN) / span) * 100;
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

  // Client-side overrides removed – relying on server-side logic for caps & completeness.

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
    takeawayEl.textContent = takeaway || buildTakeaway(band);
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
  const preRevenueBiotech = sectorBucket === "biotech" && (!Number.isFinite(stock.revenueLatest) || Math.abs(stock.revenueLatest) < 1);
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
  if (val === null || val === undefined || isNaN(val)) return "-";
  const num = Number(val);
  if (Math.abs(num) >= 1e9) return (num / 1e9).toFixed(2) + "B";
  if (Math.abs(num) >= 1e6) return (num / 1e6).toFixed(2) + "M";
  return num.toLocaleString();
}
function numf(val) {
  const num = toNumber(val);
  return num === null ? "-" : num.toFixed(2);
}
function pctf(val) {
  const num = pctFromRatio(val);
  return num === null ? "-" : `${num.toFixed(2)}%`;
}
function pctChange(curr, prev) { if (!isFinite(curr) || !isFinite(prev) || prev === 0) return null; return ((curr - prev) / Math.abs(prev)) * 100; }
function calcMargin(num, den) { if (!isFinite(num) || !isFinite(den) || den === 0) return null; return (num / den) * 100; }
function calcFcf(r) { if (!r) return null; const cfo = Number(r.netCashProvidedByOperatingActivities ?? r.operatingCashFlow); const capex = Number(r.capitalExpenditure); if (!isFinite(cfo) || !isFinite(capex)) return null; return cfo + capex; }
function pctFromRatio(val) { const num = percentToNumber(val); if (num === null) return null; return Math.abs(num) <= 1 ? num * 100 : num; }
function toNumber(val) { const num = percentToNumber(val); return num === null ? null : num; }

function hasDebtField(entry) {
  if (!entry) return false;
  const keys = ["totalDebt", "longTermDebt", "longTermDebtNoncurrent", "shortLongTermDebtTotal", "shortTermDebt", "totalDebtAndCapitalLeaseObligation"];
  return keys.some((k) => entry[k] !== undefined && entry[k] !== null);
}
function hasCashField(entry) {
  if (!entry) return false;
  const keys = ["cashAndCashEquivalents", "cashAndShortTermInvestments", "cash", "shortTermInvestments"];
  return keys.some((k) => entry[k] !== undefined && entry[k] !== null);
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
  const latestPrice = Number(opts.latestPrice);
  const isPenny = Number.isFinite(latestPrice) && latestPrice < 5;
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
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
      note: `FCF could retire debt in about ${months} month${months === 1 ? "" : "s"}.`,
      tone: "tone-good"
    };
  }
  if (Number.isFinite(netDebtYears)) {
    const tone = netDebtYears <= 3 ? "tone-good" : netDebtYears <= 6 ? "tone-warn" : "tone-risk";
    const note =
      netDebtYears <= 3
        ? "Debt is manageable."
        : netDebtYears <= 6
          ? "Debt acceptable if cash flow holds."
          : "Debt heavy vs cash flow.";
    return { value: `${netDebtYears.toFixed(1)} yrs debt/FCF`, note, tone };
  }
  if (!hasDebt) {
    return { value: "Debt data missing", note: "Latest filing did not report debt detail.", tone: "tone-neutral" };
  }
  if (hasDebt && !hasCash) {
    const baseNotes = [
      "Solvency and leverage can't be fully assessed.",
      "Missing cash figures leave leverage unclear."
    ];
    const pennyNotes = [
      "Solvency and leverage can't be fully assessed.",
      "Sparse cash disclosure heightens balance-sheet uncertainty.",
      "Balance sheet opacity raises solvency risk for penny issuers."
    ];
    const note = pick(isPenny ? pennyNotes : baseNotes);
    return { value: "Debt reported; cash data missing.", note, tone: "tone-warn" };
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
    statusEl.textContent = "Last Close · --";
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

statusEl.textContent = "Last Close · --";

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






















