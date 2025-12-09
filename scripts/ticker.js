  <script type="module">
    import { rules, ruleExplainers, percentToNumber } from "./scripts/shared-rules.js";

    const API_ROOT = window.API_ROOT || localStorage.getItem("apiRoot") || "/api";
    const API_BASE = `${API_ROOT}/ticker`;
    const RATE_LIMIT_MESSAGE = "You hit the request limit. Please wait a few seconds and try again.";
    const ticker = new URLSearchParams(location.search).get("ticker")?.toUpperCase();
    const statusEl = document.getElementById("status");
    if (!ticker) { statusEl.textContent = "No ticker provided."; throw new Error("No ticker"); }
    document.getElementById("title").textContent = ticker;
    ensurePriceElements();
    const lastPriceEl = document.getElementById("lastPrice");
    const providerSelect = document.getElementById("providerSelect");
    const goBtn = document.getElementById("goBtn");
    const rangeSwitch = document.getElementById("rangeSwitch");
    const DISABLE_BUNDLE = true; // presentation mode: skip local bundle load/save

    function cacheKey(kind) { const day = new Date().toISOString().slice(0, 10); return `edgar-${kind}-${ticker}-${day}`; }
    function latestKey(kind) { return `edgar-${kind}-${ticker}-latest`; }

    let bundlePromise = null;
    let bundleCache = null;
    let selectedProvider = "edgar";
    let priceSeriesFull = [];
    let priceSeriesLight = [];
    let chartPoints = [];
    let selectedRange = "all";

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
    }

    async function fetchWithCache(kind, url, options = {}) {
      const { allowPaywall = false, allowRetry = false, noApiWhenMissing = false, treatEmptyAsMissing = false } = options;
      const key = cacheKey(kind); const latest = latestKey(kind);
      const cachedRaw = localStorage.getItem(key) || localStorage.getItem(latest);
      let cached;
      if (cachedRaw) { try { cached = JSON.parse(cachedRaw); } catch (_) {} }
      // If we already have a non-null cached copy, reuse it and avoid API calls (testing mode).
      if (cached !== undefined && cached !== null) {
        if (treatEmptyAsMissing && Array.isArray(cached) && cached.length === 0) {
          // fall through to bundle/API
        } else {
          return cached;
        }
      }
      // Try bundle file once per ticker (skipped when disabled)
      if (!DISABLE_BUNDLE) {
        const bundleVal = await loadFromBundle(kind);
        if (bundleVal !== undefined) {
          localStorage.setItem(key, JSON.stringify(bundleVal));
          localStorage.setItem(latest, JSON.stringify(bundleVal));
          return bundleVal;
        }
      }
      // Optional: skip API entirely if not cached (to avoid burning calls in testing).
      if (noApiWhenMissing) return null;
      // Try bundled file under /data if present
      if (!DISABLE_BUNDLE) {
        const bundlePath = `data/${ticker}-bundle-${new Date().toISOString().slice(0,10)}.json`;
        try {
          const res = await fetch(bundlePath);
          if (res.ok) {
            const bundle = await res.json();
            const fromBundle = bundle?.[kind] ?? bundle?.[kind.replace(/-/g,"")] ?? null;
            if (fromBundle !== null && fromBundle !== undefined) {
              localStorage.setItem(key, JSON.stringify(fromBundle));
              localStorage.setItem(latest, JSON.stringify(fromBundle));
              return fromBundle;
            }
          }
        } catch (_) {}
      }
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
            localStorage.setItem(key, JSON.stringify(null));
            localStorage.setItem(latest, JSON.stringify(null));
            localStorage.setItem(paywallKey, "1");
            return null;
          }
          throw new Error(`${kind} fetch failed ${res.status}`);
        }
        const data = await res.json();
        localStorage.setItem(key, JSON.stringify(data));
        localStorage.setItem(latest, JSON.stringify(data));
        if (allowPaywall) localStorage.removeItem(paywallKey);
        return data;
      } catch (err) {
        if (cached !== undefined) {
          console.warn(`Using cached ${kind} due to error`, err.message);
          return cached;
        }
        if (allowPaywall) return null;
        throw err;
      }
    }

    async function loadAll() {
      statusEl.textContent = "Fetching statements & metrics...";
      if (selectedProvider !== "edgar") {
        statusEl.textContent = `Provider ${selectedProvider} not wired yet; using cache-only if present.`;
      }
      const [
        income,
        balance,
        cash,
        keyMetrics,
        ratios,
        keyMetricsTtm,
        ratiosTtm,
        financialScores,
        ownerEarnings,
        incomeGrowth,
        priceLight,
        priceFull
      ] = await Promise.all([
        fetchWithCache("income", buildApiUrl("income")),
        fetchWithCache("balance", buildApiUrl("balance")),
        fetchWithCache("cash", buildApiUrl("cash")),
        // Key metrics / ratios can be paywalled; during testing, rely on cache only (no fresh calls) and render N/A if absent.
        fetchWithCache("key-metrics", buildApiUrl("key-metrics"), { allowPaywall: true, allowRetry: true, noApiWhenMissing: false, treatEmptyAsMissing: true }),
        fetchWithCache("ratios", buildApiUrl("ratios"), { allowPaywall: true, allowRetry: true, noApiWhenMissing: false, treatEmptyAsMissing: true }),
        fetchWithCache("key-metrics-ttm", buildApiUrl("key-metrics-ttm"), { allowPaywall: true }),
        fetchWithCache("ratios-ttm", buildApiUrl("ratios-ttm"), { allowPaywall: true }),
        fetchWithCache("financial-scores", buildApiUrl("financial-scores"), { allowPaywall: true }),
        fetchWithCache("owner-earnings", buildApiUrl("owner-earnings"), { allowPaywall: true }),
        fetchWithCache("income-growth", buildApiUrl("income-growth"), { allowPaywall: true }),
        fetchWithCache("chart-light", buildApiUrl("chart-light")),
        fetchWithCache("chart-full", buildApiUrl("chart-full"))
      ]);
      statusEl.textContent = "Last Close: --";
      const safeKeyMetrics = keyMetrics || [];
      const safeRatios = ratios || [];
      const safeKeyMetricsTtm = keyMetricsTtm || [];
      const safeRatiosTtm = ratiosTtm || [];
      const safeFinancialScores = financialScores || [];
      const safeOwnerEarnings = ownerEarnings || [];
      const safeIncomeGrowth = incomeGrowth || [];
      const latestPrice = getLatestPrice(priceFull, priceLight);
      const priceInfo = renderPriceBlock(priceLight, priceFull);
      priceSeriesFull = priceInfo.seriesForChart || [];
      priceSeriesLight = priceLight || [];
      renderPriceChart(filterSeriesByRange(priceSeriesFull, selectedRange));
      const parsedSnapshotPrice = parsePriceString(priceInfo.lastCloseText);
      const resolvedPrice = latestPrice ?? priceInfo.latestPrice ?? parsedSnapshotPrice ?? getCachedPrice();
      const resolvedNum = Number(resolvedPrice);
      console.debug("price debug", { latestPrice, priceInfo, parsedSnapshotPrice, cached: getCachedPrice(), resolvedPrice, resolvedNum, lastCloseText: priceInfo.lastCloseText });
      updatePriceDisplay(resolvedNum, priceInfo.lastCloseText, priceInfo.dayChange);
      maybePersistBundle({
        ticker,
        fetchedAt: new Date().toISOString(),
        income,
        balance,
        cash,
        keyMetrics: safeKeyMetrics,
        ratios: safeRatios,
        keyMetricsTtm: safeKeyMetricsTtm,
        ratiosTtm: safeRatiosTtm,
        financialScores: safeFinancialScores,
        ownerEarnings: safeOwnerEarnings,
        incomeGrowth: safeIncomeGrowth,
        priceLight,
        priceFull
      });
      renderTables(income, balance, cash, safeKeyMetrics, safeRatios, safeKeyMetricsTtm, safeRatiosTtm);
      const stock = buildStockFromStatements({ income, balance, cash, keyMetrics: safeKeyMetrics, ratios: safeRatios, keyMetricsTtm: safeKeyMetricsTtm, ratiosTtm: safeRatiosTtm, financialScores: safeFinancialScores, ownerEarnings: safeOwnerEarnings, incomeGrowth: safeIncomeGrowth, priceFull });
      renderScoreboard(stock);
      renderSnapshot(income, balance, cash, safeKeyMetrics, safeKeyMetricsTtm);
      document.getElementById("subtitle").textContent = `Showing last ${income?.length || 0} quarters plus TTM`;
    }

    function buildStockFromStatements(all) {
      const { income = [], balance = [], cash = [], keyMetrics = [], ratios = [], keyMetricsTtm = [], ratiosTtm = [], financialScores = [], ownerEarnings = [], incomeGrowth = [], priceFull = [] } = all || {};
      const inc = income; const bal = balance; const cf = cash;
      const curInc = inc[0] || {}; const prevInc = inc[1] || {}; const curBal = bal[0] || {}; const prevBal = bal[1] || {}; const curCf = cf[0] || {};
      const ratiosLatest = ratios?.[0] || {}; const ratiosT = ratiosTtm?.[0] || {}; const keyLatest = keyMetrics?.[0] || {}; const keyT = keyMetricsTtm?.[0] || {}; const scoreObj = financialScores?.[0] || {};
      const owner = ownerEarnings?.[0] || {};
      const incGrowthLatest = incomeGrowth?.[0] || {};
      const revGrowth = pctChange(toNumber(curInc.revenue), toNumber(prevInc.revenue)) ?? pctFromRatio(incGrowthLatest.revenueGrowth);
      const sharesChange = pctChange(toNumber(curBal.commonStockSharesOutstanding), toNumber(prevBal.commonStockSharesOutstanding));
      const fcf = calcFcf(curCf);
      const fcfMargin = calcMargin(fcf, toNumber(curInc.revenue));
      const fcfYears = (fcf && toNumber(curBal.totalDebt) && fcf > 0) ? (toNumber(curBal.totalDebt) / (fcf * 4)) : null;
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
      const opMargin = pctFromRatio(ratiosLatest.operatingProfitMargin) ?? calcMargin(toNumber(curInc.operatingIncome), toNumber(curInc.revenue));
      const netMargin = pctFromRatio(ratiosLatest.netProfitMargin) ?? calcMargin(toNumber(curInc.netIncome), toNumber(curInc.revenue));
      const currentRatio = toNumber(ratiosLatest.currentRatio ?? ratiosT.currentRatio);
      const quickRatio = toNumber(ratiosLatest.quickRatio ?? ratiosT.quickRatio);
      const interestCoverageTtm = (() => {
        const pairs = [];
        for (let i = 0; i < Math.min(4, inc.length); i += 1) {
          const ebit = toNumber(inc[i]?.operatingIncome);
          const interest = toNumber(bal[i]?.interestExpense ?? inc[i]?.interestExpense);
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
      return {
        ticker,
        growth: { revenueGrowthTTM: revGrowth, revenueCagr3y: pctFromRatio(keyLatest.threeYRevenueGrowthPerShare ?? keyLatest.threeYearRevenueGrowthPerShare), perShareGrowth: pctFromRatio(keyLatest.freeCashFlowPerShareTTM ?? keyLatest.freeCashFlowPerShareGrowth) },
        stability: { growthYearsCount: null, fcfPositiveYears: cf.filter(r => calcFcf(r) > 0).length },
        profitMargins: { grossMargin, operatingMargin: opMargin, profitMargin: netMargin, fcfMargin, netIncome: toNumber(curInc.netIncome) },
        financialPosition: { currentRatio, quickRatio, debtToEquity, debtToEbitda: toNumber(ratiosLatest.debtToAssets), debtToFCF: null, interestCoverage, netDebtToFcfYears: fcfYears, netCashToPrice: null },
        returns: { roe, roic },
        cash: { cashConversion: fcf != null && toNumber(curInc.netIncome) ? fcf / toNumber(curInc.netIncome) : null, capexToRevenue: capexToRev },
        shareStats: { sharesOutstanding: curBal.commonStockSharesOutstanding, sharesChangeYoY: sharesChange, sharesChangeQoQ: sharesChange, insiderOwnership: null, institutionOwnership: null, float: null },
        valuationRatios: { peRatio, forwardPE: toNumber(keyLatest.forwardPE), psRatio, forwardPS: toNumber(keyLatest.forwardPS), pbRatio, pfcfRatio, pegRatio: toNumber(keyLatest.pegRatio), evToEbitda, fcfYield },
        expenses: { rdToRevenue: pctFromRatio(curInc.researchAndDevelopmentExpenses && curInc.revenue ? curInc.researchAndDevelopmentExpenses / curInc.revenue * 100 : null) },
        capitalReturns: { shareholderYield: pctFromRatio(keyLatest.shareholderYieldTTM), totalYield: pctFromRatio(keyLatest.shareholderYieldTTM) },
        dividends: { payoutToFcf: pctFromRatio(ratiosLatest.dividendPayoutRatio ?? ratiosT.dividendPayoutRatio), growthYears: toNumber(keyLatest.dividendGrowthYears) },
        priceStats,
        scores: { altmanZ: toNumber(scoreObj.altmanZScore ?? scoreObj.altmanZscore), piotroskiF: toNumber(scoreObj.piotroskiScore ?? scoreObj.piotroskiFScore ?? scoreObj.piotroskiFscore) },
        ownerEarnings: ownerE,
        ownerIncomeBase: toNumber(curInc.netIncome),
        lastUpdated: curInc.date || curInc.filingDate || curInc.fillingDate || "n/a"
      };
    }

    function renderScoreboard(stock) {
      const scoreReasonsEl = document.getElementById("scoreReasons");
      scoreReasonsEl.className = "reason-grid";
      const missingReasonsEl = document.getElementById("missingReasons");
      const missingToggle = document.getElementById("missingToggle");
      scoreReasonsEl.innerHTML = "";
      missingReasonsEl.innerHTML = "";
      const metrics = { metric1: 0, metric2: 0, metric3: 0 };
      const reasons = [];
      let total = 0;
      rules.forEach(rule => {
        const outcome = rule.evaluate(stock, metrics);
        const score = outcome?.score || 0;
        total += score;
        reasons.push({ message: outcome?.message || rule.name, score, name: rule.name, description: rule.description, weight: rule.weight, missing: outcome?.missing });
      });
      const missing = reasons.filter(r => r.missing);
      const applicable = reasons.filter(r => !r.missing);
      applicable.sort((a,b)=> Math.abs(b.score) - Math.abs(a.score) || b.score - a.score);
      applicable.forEach(reason => {
        const div = document.createElement("div");
        let type = "bad"; if (reason.score >= 4) type = "good"; else if (reason.score <= -6) type = "ugly"; else if (reason.score >=0) type = "good"; else type = "bad";
        div.className = `reason-card ${type}`;
        const explainer = ruleExplainers[reason.name] || {};
        const posText = explainer.pos || "Positive scores mean the metric meets or beats the target, reinforcing quality/valuation strength.";
        const negText = explainer.neg || "Negative scores mean the metric falls short, signaling risk, dilution, or overvaluation.";
        const explainerText = reason.score >= 0 ? posText : negText;
        div.title = `${reason.name || "Rule"} (${reason.weight || ""}) - ${reason.message}. Rule: ${reason.description || ""} ${reason.score >= 0 ? "Positive" : "Negative"}: ${explainerText}`;
        div.innerHTML = `
          <div class="icon">${iconForRule(reason.name)}</div>
          <div><strong>${reason.name}</strong><br><span class="muted">${reason.message}</span><br><span class="muted">${explainerText}</span></div>
          <div class="pill score-pill">${reason.score >=0 ? "+" : ""}${reason.score}</div>
        `;
        scoreReasonsEl.appendChild(div);
      });
      if (missing.length) {
        missingToggle.classList.remove("hidden");
        missingReasonsEl.classList.add("hidden");
        missing.forEach(reason => {
          const div = document.createElement("div");
          div.className = "reason";
          div.innerHTML = `<strong>${reason.name}</strong> - ${reason.message}`;
          missingReasonsEl.appendChild(div);
        });
      } else {
        missingToggle.classList.add("hidden");
        missingReasonsEl.classList.add("hidden");
      }
      const scoreEl = document.getElementById("score");
      scoreEl.textContent = total;
      applyTier(total);
      renderAchievements();

      missingToggle.onclick = () => {
        const isHidden = missingReasonsEl.classList.contains("hidden");
        if (isHidden) missingReasonsEl.classList.remove("hidden"); else missingReasonsEl.classList.add("hidden");
      };
    }

    function renderSnapshot(income, balance, cash, keyMetrics, keyMetricsTtm) {
      const snapEl = document.getElementById("snapshot"); snapEl.innerHTML = "";
      const inc = income?.[0]; const bal = balance?.[0]; const cf = cash?.[0];
      const fcf = calcFcf(cf); const gm = calcMargin(Number(inc?.grossProfit), Number(inc?.revenue)); const opm = calcMargin(Number(inc?.operatingIncome), Number(inc?.revenue)); const nm = calcMargin(Number(inc?.netIncome), Number(inc?.revenue));
      const rev = inc?.revenue ? nf(inc.revenue) : "n/a"; const cashVal = bal?.cashAndCashEquivalents ? nf(bal.cashAndCashEquivalents) : "n/a"; const debtVal = bal?.totalDebt ? nf(bal.totalDebt) : "n/a"; const shares = bal?.commonStockSharesOutstanding ? nf(bal.commonStockSharesOutstanding) : "n/a"; const equity = bal?.totalStockholdersEquity; const bvps = equity && bal?.commonStockSharesOutstanding ? (equity / bal.commonStockSharesOutstanding) : null;
      const primary = [
        { label: "Revenue (latest qtr)", value: rev },
        { label: "Gross Margin", value: gm ? gm.toFixed(1) + "%" : "n/a" },
        { label: "Operating Margin", value: opm ? opm.toFixed(1) + "%" : "n/a" },
        { label: "Net Margin", value: nm ? nm.toFixed(1) + "%" : "n/a" },
        { label: "FCF (qtr)", value: nf(fcf) },
        { label: "Cash", value: cashVal },
        { label: "Total Debt", value: debtVal },
        { label: "Shares Outstanding", value: shares },
        { label: "Book Value/Share", value: bvps ? bvps.toFixed(2) : "n/a" }
      ];
      const km = keyMetricsTtm?.[0] || keyMetrics?.[0] || {};
      if (km && km.freeCashFlowPerShareTTM) { primary.push({ label: "FCF/Share TTM", value: km.freeCashFlowPerShareTTM }); }
      const date = inc?.date || inc?.fillingDate || "n/a";
      document.getElementById("snapshotDate").textContent = `Latest period: ${date}`;
      const wrap = document.createElement("div");
      wrap.style.display = "grid";
      wrap.style.gridTemplateColumns = "repeat(auto-fit,minmax(220px,1fr))";
      wrap.style.gap = "8px";
      primary.forEach(f => {
        const div = document.createElement("div");
        div.className = "pill";
        div.style.display = "flex";
        div.style.justifyContent = "space-between";
        div.style.gap = "8px";
        div.innerHTML = `<span class="muted">${f.label}</span><span>${f.value}</span>`;
        wrap.appendChild(div);
      });
      snapEl.appendChild(wrap);
      const health = computeHealthBars({
        debtToEquity: toNumber(bal?.totalDebt && bal?.totalStockholdersEquity ? bal.totalDebt / bal.totalStockholdersEquity : null),
        currentRatio: toNumber(bal?.currentRatio),
        fcfMargin: fcf && inc?.revenue ? (fcf / inc.revenue) * 100 : null,
        cash: toNumber(bal?.cashAndCashEquivalents),
        revenueGrowth: percentToNumber(keyMetrics?.[0]?.revenueGrowthTTM ?? null),
        grossMargin: gm,
        opMargin: opm
      });
      const secondaryBar = document.getElementById("secondaryBar");
      if (secondaryBar) {
        secondaryBar.innerHTML = "";
        secondaryBar.appendChild(renderHealthBars(health));
      }
    }

    function renderTables(income, balance, cash, keyMetrics, ratios, keyMetricsTtm, ratiosTtm) {
      const incomeTtm = buildTtmFromSeries(income, ["revenue", "grossProfit", "operatingIncome", "netIncome"]);
      const cashTtm = buildTtmFromSeries(cash, ["netCashProvidedByOperatingActivities", "operatingCashFlow", "capitalExpenditure"]);
      const balanceTtm = buildPointInTimeTtm(balance, ["cashAndCashEquivalents", "totalDebt", "totalStockholdersEquity", "commonStockSharesOutstanding"]);
      renderTransposed(document.getElementById("incomeTable"), income, [
        { key: "revenue", label: "Revenue", formatter: nf },
        { key: "grossProfit", label: "Gross Profit", formatter: nf },
        { key: "operatingIncome", label: "Operating Income", formatter: nf },
        { key: "netIncome", label: "Net Income", formatter: nf }
      ], incomeTtm);
      renderTransposed(document.getElementById("balanceTable"), balance, [
        { key: "cashAndCashEquivalents", label: "Cash", formatter: nf },
        { key: "totalDebt", label: "Total Debt", formatter: nf },
        { key: "totalStockholdersEquity", label: "Equity", formatter: nf },
        { key: "commonStockSharesOutstanding", label: "Shares Outstanding", formatter: nf }
      ], balanceTtm);
      renderTransposed(document.getElementById("cashTable"), cash, [
        { key: "netCashProvidedByOperatingActivities", alt: "operatingCashFlow", label: "CFO", formatter: nf },
        { key: "capitalExpenditure", label: "Capex", formatter: nf },
        { key: "fcfComputed", label: "FCF", formatter: nf }
      ], cashTtm);

      // Drop TTM for paywalled series: only quarterly columns remain.
      const kmsTtmEntry = keyMetricsTtm?.[0] ? { ...keyMetricsTtm[0], date: "TTM" } : { date: "TTM" };
      const ratiosTtmEntry = ratiosTtm?.[0] ? { ...ratiosTtm[0], date: "TTM" } : { date: "TTM" };
      console.debug("key metrics dataset", keyMetrics);
      console.debug("ratios dataset", ratios);
      renderTransposed(document.getElementById("keyMetricsTable"), keyMetrics, [
        { key: "freeCashFlowPerShareTTM", label: "FCF/Share", formatter: nf },
        { key: "revenuePerShareTTM", label: "Revenue/Share", formatter: nf },
        { key: "bookValuePerShareTTM", label: "Book Value/Share", formatter: nf },
        { key: "pfcfRatio", alt: "priceToFreeCashFlowsRatio", label: "P/FCF", formatter: numf },
        { key: "peRatio", label: "P/E", formatter: numf },
        { key: "priceToSalesRatio", label: "P/S", formatter: numf },
        { key: "priceToBookRatio", label: "P/B", formatter: numf }
      ], kmsTtmEntry);

      renderTransposed(document.getElementById("ratiosTable"), ratios, [
        { key: "currentRatio", label: "Current Ratio", formatter: numf },
        { key: "quickRatio", label: "Quick Ratio", formatter: numf },
        { key: "debtEquityRatio", alt: "debtToEquity", label: "Debt/Equity", formatter: numf },
        { key: "interestCoverage", label: "Interest Coverage (TTM)", formatter: numf },
        { key: "grossProfitMargin", label: "Gross Margin %", formatter: pctf },
        { key: "operatingProfitMargin", label: "Operating Margin %", formatter: pctf },
        { key: "netProfitMargin", label: "Net Margin %", formatter: pctf },
        { key: "returnOnEquity", label: "ROE %", formatter: pctf },
        { key: "returnOnInvestedCapital", label: "ROIC %", formatter: pctf }
      ], ratiosTtmEntry);
    }

    function renderTransposed(el, data, metrics, ttmEntry = null) {
      const rows = [];
      if (ttmEntry) rows.push(ttmEntry);
      (data || []).forEach(r => rows.push(r));
      const periods = rows.map(r => r.date || r.filingDate || r.fillingDate || "n/a");
      if (!rows.length) { el.innerHTML = "<tbody><tr><td colspan=\"99\">No quarterly data (missing or paywalled bundle).</td></tr></tbody>"; return; }
      let html = "<thead><tr><th>Metric</th>"; periods.forEach(p => html += `<th>${p}</th>`); html += "</tr></thead><tbody>";
      metrics.forEach(m => {
        html += `<tr><td>${m.label}</td>`;
        rows.forEach(r => {
          let val = r[m.key];
          if (val === undefined && m.alt) val = r[m.alt];
          if (m.label === "FCF") val = calcFcf(r);
          if (m.label === "FCF" && val === undefined) val = calcFcf(r);
          const shown = m.formatter(val);
          html += `<td>${shown}</td>`;
        });
        html += "</tr>";
      });
      html += "</tbody>"; el.innerHTML = html;
    }

    function renderPriceBlock(light, full) {
      const container = document.getElementById("priceBlock");
      container.innerHTML = "";
      const series = Array.isArray(full)
        ? full
        : (full?.historical || light?.historical || light || []);
      if (!Array.isArray(series) || !series.length) {
        const div = document.createElement("div");
        div.className = "pill";
        div.textContent = "No price data";
        container.appendChild(div);
        return { latestPrice: null, lastCloseText: null, seriesForChart: [] };
      }
      const sorted = [...series].sort((a,b) => new Date(b.date) - new Date(a.date));
      const latest = sorted[0];
      const oldest = sorted.at(-1);
      const maxClose = Math.max(...sorted.map(r => Number(r.close) || 0));
      const change = pctChange(Number(latest.close), Number(oldest.close));
      const dd = pctChange(Number(latest.close), Number(maxClose));
      const prev = sorted[1];
      const dayChange = prev ? pctChange(Number(latest.close), Number(prev.close ?? prev.price)) : null;
      const items = [
        { label: "Period Change", value: change === null ? "n/a" : `${change.toFixed(2)}%` },
        { label: "Drawdown from high", value: dd === null ? "n/a" : `${dd.toFixed(2)}%` },
        { label: "Last Volume", value: nf(latest.volume) }
      ];
      let lastCloseText = null;
      items.forEach(it => {
        const div = document.createElement("div");
        div.className = "pill";
        div.style.display = "flex";
        div.style.justifyContent = "space-between";
        div.innerHTML = `<span class="muted">${it.label}</span><span>${it.value}</span>`;
        container.appendChild(div);
        if (it.label === "Last Close") lastCloseText = it.value;
      });
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

    function computePriceStats(priceSeries) {
      const series = Array.isArray(priceSeries) ? priceSeries : (priceSeries?.historical || []);
      if (!series.length) return { beta: null, week52Change: null, rsi: null, movingAverage50: null, movingAverage200: null };
      const sorted = [...series].sort((a,b) => new Date(b.date) - new Date(a.date));
      const latest = sorted[0];
      const maxClose = Math.max(...sorted.map(r => Number(r.close) || 0));
      const dd = pctChange(Number(latest.close), maxClose);
      return { beta: null, week52Change: dd, rsi: null, movingAverage50: null, movingAverage200: null };
    }

    function getLatestPrice(full, light) {
      const series = Array.isArray(full) ? full : (full?.historical || light?.historical || light || []);
      if (!Array.isArray(series) || !series.length) return null;
      const sorted = [...series].sort((a,b) => new Date(b.date) - new Date(a.date));
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

    function updatePriceDisplay(valueNum, valueText, dayChange) {
      ensurePriceElements();
      const lpEl = document.getElementById("lastPrice");
      const stEl = document.getElementById("status");
      if (!stEl) {
        console.debug("price elements missing after ensure", { lpEl, stEl });
        return;
      }
      if (Number.isFinite(valueNum)) {
        if (lpEl) lpEl.textContent = `$${valueNum.toFixed(2)}`;
        stEl.innerHTML = `Last Close: ${valueNum.toFixed(2)}$ ${formatChange(dayChange)}`;
        localStorage.setItem(`latest-price-${ticker}`, String(valueNum));
        console.debug("price applied numeric", valueNum);
      } else if (valueText) {
        if (lpEl) lpEl.textContent = valueText;
        stEl.innerHTML = `Last Close: ${valueText} ${formatChange(dayChange)}`;
        console.debug("price applied text fallback", valueText);
      } else {
        if (lpEl) lpEl.textContent = "";
        stEl.textContent = "Last Close: --";
        console.debug("price missing");
      }
    }

    function ensurePriceElements() {
      const titleEl = document.getElementById("title");
      if (!titleEl) return;
      // intentionally no longer injecting lastPrice next to ticker
    }

    function maybePersistBundle(bundle) {
      if (DISABLE_BUNDLE) return; // presentation mode: skip bundle downloads
      try {
        const stamp = new Date().toISOString().slice(0,10);
        const key = `bundle-downloaded-${bundle.ticker}-${stamp}`;
        if (localStorage.getItem(key)) return;
        const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${bundle.ticker}-bundle-${stamp}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        localStorage.setItem(key, "1");
      } catch (e) {
        console.warn("Failed to persist bundle", e);
      }
    }

    function formatChange(changePct) {
      if (!Number.isFinite(changePct)) return "";
      const arrow = changePct >= 0 ? "?" : "?";
      const color = changePct >= 0 ? "#4ade80" : "#ff6b6b";
      return `<span style="color:${color}; font-weight:700; margin-left:6px;">${arrow} ${changePct.toFixed(2)}%</span>`;
    }

    function applyTier(total) {
      const tierBadge = document.getElementById("tierBadge");
      const streakFill = document.getElementById("streakFill");
      const scoreFill = document.getElementById("scoreFill");
      let tier = "Analyst";
      let pct = 40;
      if (total >= 80) { tier = "Mega Bull"; pct = 100; }
      else if (total >= 60) { tier = "Bullish"; pct = 85; }
      else if (total >= 40) { tier = "Neutral"; pct = 65; }
      else if (total >= 20) { tier = "Weak"; pct = 45; }
      else { tier = "Danger"; pct = 25; }
      if (tierBadge) tierBadge.textContent = `Tier: ${tier}`;
      if (streakFill) streakFill.style.width = `${pct}%`;
      if (scoreFill) scoreFill.style.width = `${Math.max(0, Math.min(100, total + 40))}%`;
      const scoreEl = document.getElementById("score");
      if (scoreEl) { scoreEl.classList.remove("score-anim"); void scoreEl.offsetWidth; scoreEl.classList.add("score-anim"); }
    }

    function renderAchievements() {
      const achEl = document.getElementById("achievements");
      if (!achEl) return;
      achEl.innerHTML = "";
    }

    function iconForRule(name) {
      const map = {
        "Revenue momentum": "ð",
        "Gross margin quality": "ð¡ï¸",
        "Operating margin": "âï¸",
        "Net margin": "ð°",
        "FCF margin": "ð§",
        "ROE": "ð",
        "ROIC": "ð¯",
        "Debt load": "ð",
        "Liquidity": "ð¦",
        "P/FCF": "ðª",
        "P/E sanity": "ð§®",
        "EV/EBITDA": "ð­",
        "Moat quality": "ðï¸",
        "Altman Z": "ð§­",
        "Piotroski F": "ð",
        "Dilution watch": "ð«",
        "Buyback / issuance quality": "ð",
        "Total shareholder yield": "ð"
      };
      return map[name] || "â­";
    }

    function lastBundleDateFromLocal(tick) {
      const prefix = `bundle-downloaded-${tick}-`;
      let latest = null;
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix)) {
          const datePart = k.slice(prefix.length);
          if (!latest || datePart > latest) latest = datePart;
        }
      }
      return latest;
    }

    async function loadFromBundle(kind) {
      if (!ticker) return undefined;
      if (bundleCache) return bundleCacheForKind(bundleCache, kind);
      if (!bundlePromise) {
        bundlePromise = (async () => {
          const today = new Date().toISOString().slice(0,10);
          const known = lastBundleDateFromLocal(ticker);
          const candidates = [`data/${ticker}-bundle-${today}.json`];
          if (known) candidates.push(`data/${ticker}-bundle-${known}.json`);
          candidates.push(`data/${ticker}-bundle-latest.json`);
          for (const path of candidates) {
            try {
              const res = await fetch(path);
              if (res.ok) {
                const data = await res.json();
                bundleCache = data;
                return data;
              }
            } catch (_) {}
          }
          return null;
        })();
      }
      const b = await bundlePromise;
      bundleCache = b;
      return bundleCacheForKind(b, kind);
    }

    function bundleCacheForKind(bundle, kind) {
      if (!bundle) return undefined;
      const sanitized = kind.replace(/-/g, "");
      const camel = kind.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      return bundle[kind] ?? bundle[sanitized] ?? bundle[camel] ?? undefined;
    }

    function renderPriceChart(series) {
      const canvas = document.getElementById("priceChart");
      const tooltip = document.getElementById("priceTooltip");
      if (!canvas || !Array.isArray(series) || !series.length) { if (tooltip) tooltip.style.display = "none"; return; }
      const ctx = canvas.getContext("2d");
      const width = canvas.width = canvas.clientWidth || 600;
      const height = canvas.height = 220;
      const sorted = [...series].sort((a,b)=> new Date(a.date) - new Date(b.date)); // oldest -> newest
      const closes = sorted.map(p => Number(p.close || p.price)).filter(v => isFinite(v));
      const dates = sorted.map(p => new Date(p.date));
      if (!closes.length) { ctx.clearRect(0,0,width,height); if (tooltip) tooltip.style.display = "none"; return; }
      const min = Math.min(...closes);
      const max = Math.max(...closes);
      const range = max - min || 1;
      ctx.clearRect(0,0,width,height);
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
        const label = d.toISOString().slice(0,10);
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
        tooltip.innerHTML = `${nearest.date.toISOString().slice(0,10)}<br>$${nearest.close.toFixed(2)}`;
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

    function nf(val) { if (val === null || val === undefined || isNaN(val)) return "n/a"; const num = Number(val); if (Math.abs(num) >= 1e9) return (num/1e9).toFixed(2) + "B"; if (Math.abs(num) >= 1e6) return (num/1e6).toFixed(2) + "M"; return num.toLocaleString(); }
    function numf(val) { const num = toNumber(val); return num === null ? "n/a" : num.toFixed(2); }
    function pctf(val) { const num = pctFromRatio(val); return num === null ? "n/a" : `${num.toFixed(2)}%`; }
    function pctChange(curr, prev) { if (!isFinite(curr) || !isFinite(prev) || prev === 0) return null; return ((curr - prev) / Math.abs(prev)) * 100; }
    function calcMargin(num, den) { if (!isFinite(num) || !isFinite(den) || den === 0) return null; return (num / den) * 100; }
    function calcFcf(r) { if (!r) return null; const cfo = Number(r.netCashProvidedByOperatingActivities ?? r.operatingCashFlow); const capex = Number(r.capitalExpenditure); if (!isFinite(cfo) || !isFinite(capex)) return null; return cfo + capex; }
    function pctFromRatio(val) { const num = percentToNumber(val); if (num === null) return null; return Math.abs(num) <= 1 ? num * 100 : num; }
    function toNumber(val) { const num = percentToNumber(val); return num === null ? null : num; }
    function computeHealthBars(inputs) {
      const clamp = (v) => Math.max(0, Math.min(100, v));
      return [
        { label: "Durability (balance sheet)", value: clamp(inputs.debtToEquity !== null ? 80 - inputs.debtToEquity * 20 : 40) },
        { label: "Stamina (cash & FCF)", value: clamp((inputs.cash ? 30 : 0) + (inputs.fcfMargin ? (inputs.fcfMargin / 2) : 0)) },
        { label: "Strength (margins)", value: clamp(((inputs.grossMargin || 0) * 0.2) + ((inputs.opMargin || 0) * 0.4)) },
        { label: "Agility (growth)", value: clamp((inputs.revenueGrowth || 0) * 2) }
      ];
    }
    function renderHealthBars(data) {
      const wrap = document.createElement("div");
      wrap.className = "health";
      data.forEach(item => {
        const box = document.createElement("div");
        box.className = "health-bar";
        box.innerHTML = `<div class="label"><span>${item.label}</span><span>${item.value.toFixed(0)}%</span></div><div class="bar"><div class="fill" style="width:${item.value}%"></div></div>`;
        wrap.appendChild(box);
      });
      return wrap;
    }

    goBtn.addEventListener("click", () => {
      selectedProvider = providerSelect.value;
      bundlePromise = null;
      bundleCache = null;
      loadAll().catch(handleLoadError);
    });

    rangeSwitch.addEventListener("click", (e) => {
      if (e.target.tagName !== "BUTTON") return;
      [...rangeSwitch.querySelectorAll("button")].forEach(btn => btn.classList.remove("active"));
      e.target.classList.add("active");
      selectedRange = e.target.getAttribute("data-range");
      const filtered = filterSeriesByRange(priceSeriesFull, selectedRange);
      renderPriceChart(filtered);
    });

    statusEl.textContent = "Select provider and click Go to load (cache-first).";

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
          renderScoreboard(preStock);
          renderSnapshot(preloadedIncome || [], preloadedBalance || [], preloadedCash || [], preloadedKeyMetrics || [], preloadedKeyMetricsTtm || []);
      const priceInfo = renderPriceBlock(preloadedPriceLight || [], preloadedPriceFull || []);
      priceSeriesFull = priceInfo.seriesForChart || [];
      priceSeriesLight = preloadedPriceLight || [];
      renderPriceChart(filterSeriesByRange(priceSeriesFull, selectedRange));
          const parsedSnapshotPrice = parsePriceString(priceInfo.lastCloseText);
          const latestPrice = getLatestPrice(preloadedPriceFull, preloadedPriceLight);
          const resolvedPrice = latestPrice ?? priceInfo.latestPrice ?? parsedSnapshotPrice ?? getCachedPrice();
          updatePriceDisplay(Number(resolvedPrice), priceInfo.lastCloseText, priceInfo.dayChange);
        }
      } catch (err) {
        console.debug("preload cache failed", err);
      }
    })();
  </script>
</body>
</html>


