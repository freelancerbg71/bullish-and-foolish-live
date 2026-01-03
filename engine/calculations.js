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
 * @fileoverview Financial calculation utilities for the engine.
 * Moves complex logic out of tickerAssembler.js.
 */

import {
    isFiniteValue,
    toNumber,
    clamp,
    resolveSectorBucket
} from "./utils.js";

/**
 * Infers the effective tax rate from financial periods.
 * @param {Object} params
 * @param {Object} params.ttm - TTM data object
 * @param {Object} params.latestAnnual - Latest annual data object
 * @returns {number|null} - Tax rate between 0 and 0.5 (50%), or null
 */
export function inferTaxRate({ ttm, latestAnnual }) {
    const candidates = [
        {
            pretax: ttm?.incomeBeforeIncomeTaxes,
            tax: ttm?.incomeTaxExpenseBenefit
        },
        {
            pretax: latestAnnual?.incomeBeforeIncomeTaxes,
            tax: latestAnnual?.incomeTaxExpenseBenefit
        }
    ];
    for (const c of candidates) {
        const pretax = Number(c?.pretax);
        const tax = Number(c?.tax);
        if (!Number.isFinite(pretax) || !Number.isFinite(tax) || pretax === 0) continue;
        const rate = tax / pretax;
        const clamped = clamp(0, rate, 0.5);
        if (clamped != null) return clamped;
    }
    return null;
}

/**
 * Computes TTM Interest Coverage Ratio.
 * @param {Array} quarters - Array of quarterly data objects
 * @returns {Object} - { value, periods, status }
 */
export function computeInterestCoverageTtm(quarters) {
    const sorted = [...(quarters || [])]
        .filter((q) => q && q.periodEnd)
        .sort((a, b) => Date.parse(b.periodEnd) - Date.parse(a.periodEnd))
        .slice(0, 4);

    const ebitQuarters = sorted.filter((q) => Number.isFinite(q?.operatingIncome));
    if (ebitQuarters.length < 2) return { value: null, periods: ebitQuarters.length, status: "insufficient-data" };
    const ebitTtm = ebitQuarters.reduce((acc, q) => acc + Number(q.operatingIncome), 0);

    const interestQuarters = sorted.filter((q) => Number.isFinite(q?.interestExpense));
    const interestSum = interestQuarters.reduce((acc, q) => acc + Math.abs(Number(q.interestExpense)), 0);

    // If interest is effectively zero/missing, check debt to distinguish "debt-free" vs missing extraction.
    if (interestQuarters.length === 0 || !Number.isFinite(interestSum) || interestSum < 1) {
        const lastQ = sorted[0] || null;
        const debt = Number(lastQ?.totalDebt || 0);
        if (Number.isFinite(debt) && debt < 1e6) return { value: Infinity, periods: ebitQuarters.length, status: "debt-free" };
        return { value: null, periods: ebitQuarters.length, status: "missing-interest" };
    }

    // If we only have 1–3 quarters of interest expense, annualize the available quarters rather than treating missing as zero.
    const interestTtm = interestQuarters.length < 4 ? (interestSum / interestQuarters.length) * 4 : interestSum;
    if (!Number.isFinite(ebitTtm) || !Number.isFinite(interestTtm) || interestTtm === 0) {
        return { value: null, periods: ebitQuarters.length, status: "insufficient-data" };
    }

    return {
        value: ebitTtm / interestTtm,
        periods: interestQuarters.length,
        status: interestQuarters.length < 4 ? "annualized-interest" : "ok"
    };
}

/**
 * Computes Annual Interest Coverage Ratio.
 * @param {Object} latest - Latest annual data object
 * @returns {Object} - { value, periods, status }
 */
export function computeInterestCoverageAnnual(latest) {
    const row = latest || null;
    if (!row) return { value: null, periods: 0, status: "insufficient-data" };

    const ebit = Number(row.operatingIncome);
    const interest = Math.abs(Number(row.interestExpense || 0));

    if (!Number.isFinite(ebit)) return { value: null, periods: 0, status: "insufficient-data" };

    // If interest is effectively zero/missing, check debt to decide if "debt-free" vs "missing-interest".
    if (!Number.isFinite(interest) || interest < 1) {
        const debt = Number(row.totalDebt || 0);
        if (Number.isFinite(debt) && debt < 1e6) return { value: Infinity, periods: 1, status: "debt-free" };
        return { value: null, periods: 1, status: "missing-interest" };
    }

    return { value: ebit / interest, periods: 1, status: "ok" };
}

/**
 * Calculates Free Cash Flow from OCF and Capex.
 * @param {Object} row - Object with netCashProvidedByOperatingActivities/operatingCashFlow and capitalExpenditure/capex
 * @returns {number|null}
 */
export function calcFcf(row) {
    if (!row) return null;
    const cfo = Number(row.netCashProvidedByOperatingActivities ?? row.operatingCashFlow);
    const capex = Number(row.capitalExpenditure ?? row.capex);
    if (!Number.isFinite(cfo) || !Number.isFinite(capex)) return null;
    return cfo + capex;
}

/**
 * Computes runway in years based on cash, short-term investments, and burn rate.
 * @param {Object} data
 * @param {string} data.sector - Sector string
 * @param {string} [data.sectorBucket] - Resolved sector bucket (optional)
 * @param {Array} [data.quarterlySeries] - Quarterly data
 * @param {Array} [data.annualSeries] - Annual data
 * @param {Object} [data.snapshot] - Snapshot with freeCashFlowTTM
 * @param {Object} [data.ttm] - TTM object with freeCashFlow and netIncome
 * @returns {number|null} - Years of runway, Infinity, or null
 */
export function computeRunwayYears(data) {
    if (!data) return null;
    const sectorBucket = resolveSectorBucket(data.sector || data.sectorBucket);
    if (sectorBucket === "Financials") return null; // Lending cash flows distort runway math
    const series = (data.quarterlySeries && data.quarterlySeries.length ? data.quarterlySeries : data.annualSeries || []);
    const latest = [...series]
        .sort((a, b) => Date.parse(b.periodEnd) - Date.parse(a.periodEnd))[0] || {};

    const cash = toNumber(latest.cash ?? latest.cashAndCashEquivalents);
    const sti = toNumber(latest.shortTermInvestments);

    // If both are missing (null), and we have no other balance sheet data, return null.
    if (cash === null && sti === null) return null;

    const cashTotal = (Number.isFinite(cash) ? cash : 0) + (Number.isFinite(sti) ? sti : 0);
    const fcf = toNumber(data.snapshot?.freeCashFlowTTM ?? data.ttm?.freeCashFlow);

    if (!Number.isFinite(cashTotal)) return null;

    // Infinite runway cases
    if (Number.isFinite(fcf) && fcf >= 0) return Infinity; // Burn is 0 or positive cash flow

    // If FCF is missing but we are profitable (net income > 0), assume infinite runway
    const ni = toNumber(data.ttm?.netIncome);
    if (!Number.isFinite(fcf) && Number.isFinite(ni) && ni > 0) return Infinity;

    if (Number.isFinite(fcf) && fcf < 0) {
        if (cashTotal <= 0) return 0; // No cash left
        return cashTotal / Math.abs(fcf);
    }

    return null;
}
