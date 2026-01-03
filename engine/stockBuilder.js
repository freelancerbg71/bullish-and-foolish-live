/**
 * Open Fundamentals Engine
 * Copyright (C) 2024-2025 Bullish & Foolish Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 *
 * @fileoverview Logic to assemble the standard 'stock' object used by the rules engine.
 */

import {
    toNumber,
    calcMargin,
    pctChange,
    pctFromRatio,
    isFiniteValue,
    resolveSectorBucket
} from "./utils.js";

import {
    ONE_YEAR_MS,
    TOLERANCE_30D_MS
} from "./constants.js";

import {
    calcFcf,
    computeInterestCoverageAnnual,
    computeInterestCoverageTtm,
    inferTaxRate,
    computeRunwayYears
} from "./calculations.js";

import {
    computeShareChangeWithSplitGuard
} from "./stockAdjustments.js";

/**
 * Calculates trend between latest quarter and same quarter last year.
 * @param {Array} quarters - Ascending quarters
 * @param {string} field - Field to check
 */
function calcTrend(quarters, field) {
    if (!quarters || quarters.length < 2) return null;
    // Assumes quarters are ASCENDING (oldest -> newest)
    const latestQ = quarters[quarters.length - 1];
    // Find same quarter last year
    const priorY = quarters.find(q => {
        const d1 = new Date(latestQ.periodEnd);
        const d2 = new Date(q.periodEnd);
        return Math.abs(d1 - d2 - ONE_YEAR_MS) < TOLERANCE_30D_MS; // rough 1 year check
    });

    if (!priorY) return null;

    if (!isFiniteValue(latestQ[field]) || !isFiniteValue(priorY[field])) return null;
    const valNow = Number(latestQ[field]);
    const valPrior = Number(priorY[field]);

    if (!Number.isFinite(valNow) || !Number.isFinite(valPrior) || valPrior === 0) return null;
    return (valNow - valPrior) / Math.abs(valPrior);
}

/**
 * Build the standardized 'stock' object for the rules engine.
 * @param {Object} vm - ViewModel containing series, snapshot, ttm, etc.
 * @returns {Object} - Stock object ready for rules.evaluate()
 */
export function buildStockForRules(vm) {
    const series = (vm.quarterlySeries && vm.quarterlySeries.length ? vm.quarterlySeries : vm.annualSeries || []);
    const annualMode = vm?.annualMode === true || vm?.snapshot?.basis === "annual";
    const quartersAsc = [...series].sort((a, b) => Date.parse(a.periodEnd) - Date.parse(b.periodEnd));
    const quartersDesc = [...quartersAsc].reverse();

    const income = quartersDesc.map((q) => ({
        date: q.periodEnd,
        revenue: q.revenue,
        grossProfit: q.grossProfit,
        costOfRevenue: q.costOfRevenue,
        operatingIncome: q.operatingIncome,
        operatingExpenses: q.operatingExpenses,
        netIncome: q.netIncome,
        researchAndDevelopmentExpenses: q.researchAndDevelopmentExpenses,
        interestIncome: q.interestIncome,
        interestAndDividendIncome: q.interestAndDividendIncome,
        interestExpense: q.interestExpense,
        technologyExpenses: q.technologyExpenses,
        softwareExpenses: q.softwareExpenses,
        depreciationDepletionAndAmortization: q.depreciationDepletionAndAmortization,
        eps: q.epsBasic,
        epsdiluted: q.epsBasic,
        epsDiluted: q.epsBasic
    }));

    const balance = quartersDesc.map((q) => ({
        date: q.periodEnd,
        cashAndCashEquivalents: q.cash ?? q.cashAndCashEquivalents,
        totalDebt: q.totalDebt,
        financialDebt: q.financialDebt,
        shortTermDebt: q.shortTermDebt,
        longTermDebt: q.longTermDebt,
        leaseLiabilities: q.leaseLiabilities,
        totalStockholdersEquity: q.totalEquity,
        totalAssets: q.totalAssets,
        totalLiabilities: q.totalLiabilities,
        currentAssets: q.currentAssets,
        currentLiabilities: q.currentLiabilities,
        commonStockSharesOutstanding: q.sharesOutstanding,
        shortTermInvestments: q.shortTermInvestments,
        accountsReceivable: q.accountsReceivable,
        deferredRevenue: q.deferredRevenue,
        contractWithCustomerLiability: q.contractWithCustomerLiability,
        deposits: q.deposits,
        customerDeposits: q.customerDeposits,
        totalDeposits: q.totalDeposits,
        depositLiabilities: q.depositLiabilities,
        interestExpense: q.interestExpense ?? null
    }));

    const cashArr = quartersDesc.map((q) => ({
        date: q.periodEnd,
        netCashProvidedByOperatingActivities: q.operatingCashFlow,
        operatingCashFlow: q.operatingCashFlow,
        capitalExpenditure: q.capex,
        freeCashFlow: q.freeCashFlow,
        depreciationDepletionAndAmortization: q.depreciationDepletionAndAmortization,
        treasuryStockRepurchased: q.treasuryStockRepurchased,
        dividendsPaid: q.dividendsPaid,
        fcfComputed:
            q.freeCashFlow != null
                ? q.freeCashFlow
                : q.operatingCashFlow != null && q.capex != null
                    ? q.operatingCashFlow - Math.abs(q.capex ?? 0)
                    : null
    }));

    const incomeValid = income.filter((i) =>
        Number.isFinite(i.revenue) || Number.isFinite(i.operatingIncome) || Number.isFinite(i.netIncome)
    );
    const balanceValid = balance.filter((b) =>
        Number.isFinite(b.totalAssets) || Number.isFinite(b.totalDebt) || Number.isFinite(b.cashAndCashEquivalents)
    );
    const cashValid = cashArr.filter((c) =>
        Number.isFinite(c.operatingCashFlow) || Number.isFinite(c.capitalExpenditure) || Number.isFinite(c.fcfComputed)
    );

    const curInc = incomeValid[0] || {};
    const prevInc = incomeValid[1] || {};
    const curBal = balanceValid[0] || {};
    const prevBal = balanceValid[1] || {};
    const curCf = cashValid[0] || {};
    const prevCf = cashValid[1] || {};

    const effectiveIncIndex = (() => {
        const idx = income.indexOf(curInc);
        return idx >= 0 ? idx : 0;
    })();

    const shareChangeMeta = computeShareChangeWithSplitGuard(quartersDesc);
    const interestCoverageMeta = annualMode
        ? computeInterestCoverageAnnual(quartersDesc[effectiveIncIndex] || null)
        : computeInterestCoverageTtm(quartersDesc);

    const revGrowth = pctChange(toNumber(curInc.revenue), toNumber(prevInc.revenue));
    const fcf = calcFcf(curCf);

    const ttmRevenue = toNumber(vm?.ttm?.revenue);
    const ttmFcf = toNumber(vm?.ttm?.freeCashFlow);
    const ttmNetIncome = toNumber(vm?.ttm?.netIncome);

    const latestAnnual = (() => {
        const years = Array.isArray(vm?.annualSeries) ? vm.annualSeries : [];
        if (!years.length) return null;
        return [...years]
            .filter((p) => p?.periodEnd)
            .sort((a, b) => Date.parse(b.periodEnd) - Date.parse(a.periodEnd))[0] || null;
    })();
    const annualRevenue = toNumber(latestAnnual?.revenue);
    const annualNetIncome = toNumber(latestAnnual?.netIncome);
    const annualFcf = (() => {
        const explicit = toNumber(latestAnnual?.freeCashFlow);
        if (Number.isFinite(explicit)) return explicit;
        const ocf = toNumber(latestAnnual?.operatingCashFlow);
        const capex = toNumber(latestAnnual?.capex);
        if (!Number.isFinite(ocf) || !Number.isFinite(capex)) return null;
        return ocf - Math.abs(capex);
    })();

    const sumAbsLast4 = (field) => {
        if (!quartersAsc || quartersAsc.length < 4) return null;
        const latest4 = quartersAsc.slice(-4);
        let used = 0;
        let acc = 0;
        for (const q of latest4) {
            const v = Number(q?.[field]);
            if (!Number.isFinite(v)) continue;
            used += 1;
            acc += Math.abs(v);
        }
        return used ? acc : null;
    };

    const buybacksTtm = sumAbsLast4("treasuryStockRepurchased");
    const dividendsTtm = sumAbsLast4("dividendsPaid");
    const shareholderReturnTtm =
        Number.isFinite(buybacksTtm) || Number.isFinite(dividendsTtm)
            ? (Number.isFinite(buybacksTtm) ? buybacksTtm : 0) + (Number.isFinite(dividendsTtm) ? dividendsTtm : 0)
            : null;
    const buybacksPctFcf =
        Number.isFinite(buybacksTtm) && Number.isFinite(ttmFcf) && ttmFcf > 0 ? buybacksTtm / ttmFcf : null;
    const totalReturnPctFcf =
        Number.isFinite(shareholderReturnTtm) && Number.isFinite(ttmFcf) && ttmFcf > 0
            ? shareholderReturnTtm / ttmFcf
            : null;

    const rdSpendTtm = sumAbsLast4("researchAndDevelopmentExpenses");
    const rdToRevenueTtm = Number.isFinite(rdSpendTtm) && Number.isFinite(ttmRevenue) && ttmRevenue !== 0
        ? (rdSpendTtm / ttmRevenue) * 100
        : null;

    const ar = toNumber(curBal.accountsReceivable);
    const inv = toNumber(curBal.inventories);
    const ap = toNumber(curBal.accountsPayable);
    const cogsTtm = (() => {
        const rev = toNumber(vm?.ttm?.revenue);
        const gp = toNumber(vm?.ttm?.grossProfit);
        if (Number.isFinite(rev) && Number.isFinite(gp)) return rev - gp;
        return null;
    })();

    const dsoDays =
        Number.isFinite(ar) && Number.isFinite(ttmRevenue) && ttmRevenue > 0 ? (ar / ttmRevenue) * 365 : null;
    const dioDays =
        Number.isFinite(inv) && Number.isFinite(cogsTtm) && cogsTtm > 0 ? (inv / cogsTtm) * 365 : null;
    const dpoDays =
        Number.isFinite(ap) && Number.isFinite(cogsTtm) && cogsTtm > 0 ? (ap / cogsTtm) * 365 : null;
    const cashConversionCycleDays =
        Number.isFinite(dsoDays) && Number.isFinite(dpoDays)
            ? dsoDays + (Number.isFinite(dioDays) ? dioDays : 0) - dpoDays
            : null;

    const effectiveTaxRateTTM = inferTaxRate({ ttm: vm?.ttm, latestAnnual: null });

    const operatingLeverage = (() => {
        const op = toNumber(vm?.ttm?.operatingIncome);
        const gp = toNumber(vm?.ttm?.grossProfit);
        if (!Number.isFinite(op) || !Number.isFinite(gp) || gp === 0) return null;
        return op / gp;
    })();

    const fcfMarginTtmPct =
        Number.isFinite(ttmFcf) && Number.isFinite(ttmRevenue) && ttmRevenue !== 0
            ? (ttmFcf / ttmRevenue) * 100
            : null;
    const fcfMarginVal = fcfMarginTtmPct ?? calcMargin(fcf, toNumber(curInc.revenue));

    const prevFcf = calcFcf(prevCf);
    const prevFcfMargin = prevCf ? calcMargin(prevFcf, toNumber(prevInc.revenue)) : null;
    const profitGrowth =
        calcTrend(quartersAsc, "netIncome") ?? pctChange(toNumber(curInc.netIncome), toNumber(prevInc.netIncome));
    const fcfTrend = pctChange(fcfMarginVal, prevFcfMargin);
    const debtTotal = (() => {
        const totalDebt = toNumber(curBal.totalDebt);
        const finDebt = toNumber(curBal.financialDebt);
        const stDebt = toNumber(curBal.shortTermDebt);
        const lease = toNumber(curBal.leaseLiabilities);
        const parts = [finDebt, stDebt, lease].filter((v) => Number.isFinite(v));
        const partsSum = parts.length ? parts.reduce((acc, v) => acc + Number(v), 0) : null;
        if (Number.isFinite(totalDebt) && Number.isFinite(partsSum)) return Math.max(totalDebt, partsSum);
        return Number.isFinite(totalDebt) ? totalDebt : partsSum;
    })();

    const fcfYears =
        Number.isFinite(debtTotal) && Number.isFinite(ttmFcf) && ttmFcf > 0
            ? debtTotal / ttmFcf
            : Number.isFinite(annualFcf) && annualFcf > 0
                ? debtTotal / annualFcf
                : null;

    const roe = (() => {
        const ni = Number.isFinite(ttmNetIncome)
            ? ttmNetIncome
            : annualMode
                ? toNumber(curInc.netIncome)
                : annualNetIncome;
        const eq = toNumber(curBal.totalStockholdersEquity);
        if (!Number.isFinite(ni) || !Number.isFinite(eq) || eq === 0) return null;
        return (ni / eq) * 100;
    })();

    const taxRate = inferTaxRate({ ttm: vm?.ttm, latestAnnual: vm?.annualSeries?.[0] });
    const ebitTtm = toNumber(vm?.ttm?.operatingIncome);
    const nopatTtm =
        Number.isFinite(ebitTtm)
            ? ebitTtm * (1 - (taxRate ?? 0.21))
            : null;

    const debtForIc = (b) => {
        const totalDebt = toNumber(b?.totalDebt);
        const finDebt = toNumber(b?.financialDebt);
        const stDebt = toNumber(b?.shortTermDebt);
        const lease = toNumber(b?.leaseLiabilities);
        const parts = [finDebt, stDebt, lease].filter((v) => Number.isFinite(v));
        const partsSum = parts.length ? parts.reduce((acc, v) => acc + Number(v), 0) : null;
        if (Number.isFinite(totalDebt) && Number.isFinite(partsSum)) return Math.max(totalDebt, partsSum);
        if (Number.isFinite(totalDebt)) return totalDebt;
        return Number.isFinite(partsSum) ? partsSum : null;
    };

    const investedCapitalForBal = (b) => {
        const eq = toNumber(b?.totalStockholdersEquity);
        const debt = debtForIc(b);
        const cash = toNumber(b?.cashAndCashEquivalents);
        const sti = toNumber(b?.shortTermInvestments);
        if (!Number.isFinite(eq) || !Number.isFinite(debt) || !Number.isFinite(cash)) return null;
        return eq + debt - cash - (Number.isFinite(sti) ? sti : 0);
    };

    const investedCapitalNow = investedCapitalForBal(curBal);
    const investedCapitalPrev = investedCapitalForBal(prevBal);
    const avgInvestedCapital =
        Number.isFinite(investedCapitalNow) && Number.isFinite(investedCapitalPrev)
            ? (investedCapitalNow + investedCapitalPrev) / 2
            : investedCapitalNow ?? investedCapitalPrev ?? null;

    const roic = (() => {
        if (!Number.isFinite(nopatTtm) || !Number.isFinite(avgInvestedCapital) || avgInvestedCapital === 0) return null;
        return (nopatTtm / avgInvestedCapital) * 100;
    })();

    const interestCoverage =
        interestCoverageMeta.value != null
            ? interestCoverageMeta.value
            : (() => {
                const ttmOpInc = toNumber(vm?.ttm?.operatingIncome);
                const latestAnnual = Array.isArray(vm?.annualSeries)
                    ? [...vm.annualSeries]
                        .filter((p) => String(p?.periodType || "").toLowerCase() === "year" && p?.periodEnd)
                        .sort((a, b) => Date.parse(b.periodEnd) - Date.parse(a.periodEnd))[0] || null
                    : null;
                const annualInterest = toNumber(latestAnnual?.interestExpense);
                if (Number.isFinite(ttmOpInc) && Number.isFinite(annualInterest) && annualInterest !== 0) {
                    return ttmOpInc / Math.abs(annualInterest);
                }
                return vm?.snapshot?.interestCoverage ?? null;
            })();

    const capexToRev = calcMargin(toNumber(curCf.capitalExpenditure), toNumber(curInc.revenue));
    const grossMargin = (() => {
        const gpTtm = toNumber(vm?.ttm?.grossProfit);
        const revTtm = toNumber(vm?.ttm?.revenue);
        const ttm = calcMargin(gpTtm, revTtm);
        if (ttm != null) return ttm;
        return calcMargin(toNumber(curInc.grossProfit), toNumber(curInc.revenue));
    })();

    const opMargin = (() => {
        const opTtm = toNumber(vm?.ttm?.operatingIncome);
        const revTtm = toNumber(vm?.ttm?.revenue);
        const ttm = calcMargin(opTtm, revTtm);
        if (ttm != null) return ttm;
        return calcMargin(toNumber(curInc.operatingIncome), toNumber(curInc.revenue));
    })();

    const prevOpMargin = calcMargin(Number(prevInc.operatingIncome), Number(prevInc.revenue));
    const marginTrend = Number.isFinite(opMargin) && Number.isFinite(prevOpMargin) ? opMargin - prevOpMargin : null;

    const netMargin = (() => {
        const niTtm = Number.isFinite(ttmNetIncome) ? ttmNetIncome : null;
        const revTtm = toNumber(vm?.ttm?.revenue);
        const ttm = calcMargin(niTtm, revTtm);
        if (ttm != null) return ttm;
        return calcMargin(toNumber(curInc.netIncome), toNumber(curInc.revenue));
    })();

    const incomeDate = curInc.date ? new Date(curInc.date) : null;
    const balanceDate = curBal.date ? new Date(curBal.date) : null;
    const temporalMismatch = incomeDate && balanceDate && Math.abs(incomeDate - balanceDate) > 65 * 24 * 60 * 60 * 1000;

    const dataQuality = {
        mismatchedPeriods: temporalMismatch,
        incomeDate: curInc.date,
        balanceDate: curBal.date,
        defaultsUsed: [],
        inferredValues: [],
        materialMismatches: []
    };

    if (temporalMismatch) {
        dataQuality.materialMismatches.push({
            metric: "Financial Position",
            issue: "Statement Mismatch",
            details: `Income statement (${curInc.date}) and Balance Sheet (${curBal.date}) are from different periods.`,
            severity: "material"
        });
    }

    const annualDateRaw = vm?.annualSeries?.[0]?.periodEnd || vm?.annualSeries?.[0]?.date || null;
    const annualDate = annualDateRaw ? new Date(annualDateRaw) : null;
    const latestReportMs = Math.max(
        incomeDate ? incomeDate.getTime() : 0,
        balanceDate ? balanceDate.getTime() : 0,
        annualDate ? annualDate.getTime() : 0
    );

    const daysSinceReport = latestReportMs ? (Date.now() - latestReportMs) / (1000 * 60 * 60 * 24) : null;
    if (daysSinceReport && daysSinceReport > 180) {
        dataQuality.materialMismatches.push({
            metric: "Financials",
            issue: "Stale Data",
            details: `Latest income statement is ${Math.round(daysSinceReport)} days old.`,
            severity: "material"
        });
    }

    const netDebt = (() => {
        const cashBal = toNumber(curBal.cashAndCashEquivalents);
        const stiBal = toNumber(curBal.shortTermInvestments);
        const debtBal = debtTotal;
        if (!Number.isFinite(debtBal)) return null;
        const cashKnown = Number.isFinite(cashBal);
        const stiKnown = Number.isFinite(stiBal);
        const cashTotal = (cashKnown ? cashBal : 0) + (stiKnown ? stiBal : 0);

        if (!cashKnown && !stiKnown) {
            if (debtBal === 0) {
                dataQuality.defaultsUsed.push({ field: "netDebt", reason: "Net debt treated as zero due to no reported debt", value: 0 });
                return 0;
            }
            return null;
        }
        return debtBal - cashTotal;
    })();

    const debtToEquity = toNumber(
        Number.isFinite(debtTotal) && curBal.totalStockholdersEquity
            ? debtTotal / curBal.totalStockholdersEquity
            : null
    );

    const netDebtToEquity =
        Number.isFinite(netDebt) && Number.isFinite(toNumber(curBal.totalStockholdersEquity))
            ? netDebt / toNumber(curBal.totalStockholdersEquity)
            : debtToEquity;

    const lastClose = vm?.priceSummary?.lastClose != null ? Number(vm.priceSummary.lastClose) : null;
    const marketCap = vm?.snapshot?.marketCap != null ? Number(vm.snapshot.marketCap) : (lastClose != null && curBal.commonStockSharesOutstanding != null ? lastClose * curBal.commonStockSharesOutstanding : null);

    const revenueForValuation =
        annualMode
            ? toNumber(curInc.revenue)
            : Number.isFinite(ttmRevenue)
                ? ttmRevenue
                : annualRevenue;

    const fcfForValuation =
        annualMode
            ? Number.isFinite(fcf) ? fcf : null
            : Number.isFinite(ttmFcf)
                ? ttmFcf
                : annualFcf;

    const netIncomeForValuation = annualMode
        ? toNumber(curInc.netIncome)
        : Number.isFinite(ttmNetIncome)
            ? ttmNetIncome
            : annualNetIncome;

    return {
        ticker: vm.ticker,
        companyName: vm.companyName,
        sector: vm.sector,
        sic: vm.sic ?? vm.snapshot?.sic,
        sicDescription: vm.sicDescription ?? vm.snapshot?.sicDescription,
        marketCap,
        sectorBucket: resolveSectorBucket(vm.sector),
        issuerType: vm.issuerType ?? vm.snapshot?.issuerType ?? null,
        quarterCount: quartersDesc.length,
        ttm: vm.ttm ?? null,
        growth: {
            revenueGrowthTTM: (() => {
                const trendRatio = calcTrend(quartersAsc, "revenue");
                if (trendRatio == null) return revGrowth;
                return trendRatio * 100;
            })(),
            revenueCagr3y: pctFromRatio(vm?.snapshot?.revenueCAGR3Y ?? vm?.growth?.revenueCagr3y),
            epsCagr3y: pctFromRatio(vm?.growth?.epsCagr3y),
            perShareGrowth: null
        },
        // Populate the flattened structure expected by rules
        income,
        balance,
        cashFlows: cashArr,

        profitMargins: {
            grossMargin,
            operatingMargin: opMargin,
            profitMargin: netMargin,
            netIncome: Number.isFinite(ttmNetIncome)
                ? ttmNetIncome
                : annualMode
                    ? toNumber(curInc.netIncome)
                    : annualNetIncome,
            fcfMargin: fcfMarginVal,
            operatingLeverage,
            roe
        },
        revenueLatest: toNumber(curInc.revenue),
        revenueTtm: toNumber(vm?.ttm?.revenue),
        momentum: {
            grossMarginPrev: prevInc.grossProfit && prevInc.revenue ? calcMargin(toNumber(prevInc.grossProfit), toNumber(prevInc.revenue)) : null,
            operatingMarginTrend: marginTrend,
            fcfMarginTrend: fcfTrend,
            profitGrowthTTM: profitGrowth,
            burnTrend: calcTrend(quartersAsc, "freeCashFlow"),
            rndTrend: calcTrend(quartersAsc, "researchAndDevelopmentExpenses"),
            revenueTrend: calcTrend(quartersAsc, "revenue"),
            sgaTrend: calcTrend(quartersAsc, "sellingGeneralAndAdministrativeExpenses")
        },
        profitGrowthTTM: profitGrowth,
        stability: { growthYearsCount: null, fcfPositiveYears: cashArr.filter((r) => calcFcf(r) > 0).length },
        financialPosition: {
            totalAssets: toNumber(curBal.totalAssets),
            totalDebt: debtTotal,
            financialDebt: toNumber(curBal.financialDebt),
            cash: toNumber(curBal.cashAndCashEquivalents),
            shortTermDebt: toNumber(curBal.shortTermDebt),
            longTermDebt: toNumber(curBal.longTermDebt),
            leaseLiabilities: toNumber(curBal.leaseLiabilities),
            netDebt,
            debtToEquity,
            netDebtToEquity,
            netDebtToFcf: Number.isFinite(netDebt) && Number.isFinite(fcfForValuation) && fcfForValuation > 0 ? netDebt / fcfForValuation : null,
            netDebtToFcfYears: fcfYears, // using TTM FCF
            interestCoverage,
            debtIsZero: debtTotal === 0,
            currentRatio: safeDiv(toNumber(curBal.currentAssets), toNumber(curBal.currentLiabilities)),
            quickRatio: safeDiv((toNumber(curBal.cashAndCashEquivalents) || 0) + (toNumber(curBal.shortTermInvestments) || 0) + (toNumber(curBal.accountsReceivable) || 0), toNumber(curBal.currentLiabilities)),
            dsoDays: dsoDays,
            cashConversionCycleDays,
            accountsReceivable: toNumber(curBal.accountsReceivable),
            inventories: toNumber(curBal.inventories),
            accountsPayable: toNumber(curBal.accountsPayable),
            interestExpense: toNumber(curBal.interestExpense),
            runwayYears: computeRunwayYears(vm)
        },
        cash: {
            capexToRevenue: capexToRev,
            capitalExpenditure: toNumber(curCf.capitalExpenditure),
            shareBuybacksTTM: buybacksTtm,
            dividendsPaidTTM: dividendsTtm,
            shareholderReturnTTM: shareholderReturnTtm,
            buybacksPctFcf,
            totalReturnPctFcf,
            freeCashFlowTTM: ttmFcf
        },
        expenses: {
            rdToRevenue: calcMargin(
                Number.isFinite(rdSpendTtm) ? rdSpendTtm : toNumber(curInc.researchAndDevelopmentExpenses),
                Number.isFinite(ttmRevenue) ? ttmRevenue : toNumber(curInc.revenue)
            ),
            rdSpend: Number.isFinite(rdSpendTtm) ? rdSpendTtm : toNumber(curInc.researchAndDevelopmentExpenses),
            rdSpendTTM: rdSpendTtm,
            rdToRevenueTTM: rdToRevenueTtm,
            revenue: Number.isFinite(ttmRevenue) ? ttmRevenue : toNumber(curInc.revenue)
        },
        taxes: { effectiveTaxRateTTM },
        returns: {
            roe,
            roic
        },
        shareStats: {
            sharesOutstanding: toNumber(curBal.commonStockSharesOutstanding),
            sharesChangeQoQ: shareChangeMeta.changeQoQ,
            sharesChangeYoY: shareChangeMeta.changeYoY,
            sharesChangeYoYRaw: shareChangeMeta.rawYoY,
            likelySplit: !!shareChangeMeta.splitSignal,
            likelyReverseSplit: !!shareChangeMeta.reverseSplitSignal,
            buybacksToFcf: buybacksPctFcf,
            shareholderReturnToFcf: totalReturnPctFcf,
            insiderOwnership: toNumber(vm?.snapshot?.heldPercentInsiders)
        },
        valuationRatios: {
            peRatio: Number.isFinite(lastClose) && Number.isFinite(netIncomeForValuation) && netIncomeForValuation !== 0
                ? valRatio(marketCap, netIncomeForValuation)
                : null,
            psRatio: Number.isFinite(lastClose) && Number.isFinite(revenueForValuation) && revenueForValuation !== 0
                ? valRatio(marketCap, revenueForValuation)
                : null,
            pfcfRatio: Number.isFinite(lastClose) && Number.isFinite(fcfForValuation) && fcfForValuation !== 0
                ? valRatio(marketCap, fcfForValuation)
                : null,
            pbRatio: Number.isFinite(lastClose) && Number.isFinite(toNumber(curBal.totalStockholdersEquity)) && curBal.totalStockholdersEquity > 0
                ? valRatio(marketCap, toNumber(curBal.totalStockholdersEquity))
                : null
        },
        dividends: { payoutToFcf: null, growthYears: null },
        dataQuality,
        // Original raw series for deep inspection if needed
        quarterlySeries: series,
        annualSeries: vm.annualSeries
    };
}

function safeDiv(a, b) {
    if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
    return a / b;
}

function valRatio(num, den) {
    if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
    return num / den;
}
