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
 * @fileoverview Logic for detecting stock splits and adjusting share counts.
 */

import {
    isFiniteValue,
    pctChange
} from "./utils.js";

import {
    ONE_YEAR_MS,
    TOLERANCE_30D_MS
} from "./constants.js";

/**
 * Detects signs of a forward stock split (shares increase, EPS decrease proportionally).
 * @param {Array} quartersDesc - Quarters sorted descending by date
 * @param {Object} options
 * @returns {Object|null} - Split signal object or null
 */
export function detectLikelySplit(quartersDesc, { tolerance = 0.25, minRatio = 2, epsFloor = 0.01 } = {}) {
    const series = [...(quartersDesc || [])].filter((q) => q && q.periodEnd);
    for (let i = 0; i < series.length - 1; i += 1) {
        const curr = series[i];
        const prev = series[i + 1];
        const sharesCurr = Number(curr?.sharesOutstanding ?? curr?.shares);
        const sharesPrev = Number(prev?.sharesOutstanding ?? prev?.shares);
        if (!Number.isFinite(sharesCurr) || !Number.isFinite(sharesPrev) || sharesPrev === 0) continue;
        const sharesRatio = sharesCurr / sharesPrev;
        if (!Number.isFinite(sharesRatio) || sharesRatio < minRatio) continue;
        const epsCurr = Number(curr?.epsBasic);
        const epsPrev = Number(prev?.epsBasic);
        if (
            !Number.isFinite(epsCurr) ||
            !Number.isFinite(epsPrev) ||
            epsCurr === 0 ||
            epsPrev === 0 ||
            Math.sign(epsCurr) !== Math.sign(epsPrev) ||
            Math.abs(epsCurr) < epsFloor ||
            Math.abs(epsPrev) < epsFloor
        ) {
            continue;
        }
        const epsRatio = epsCurr / epsPrev;
        const inverseProduct = Math.abs(sharesRatio * epsRatio - 1);
        if (inverseProduct <= tolerance) {
            const niCurr = Number(curr?.netIncome);
            const niPrev = Number(prev?.netIncome);
            const niStable =
                Number.isFinite(niCurr) &&
                Number.isFinite(niPrev) &&
                Math.abs(niPrev) > 1e-6 &&
                Math.abs(niCurr / niPrev - 1) < 0.35;
            if (niStable === false) continue;
            return {
                flagged: true,
                sharesRatio,
                epsRatio,
                inverseProduct,
                currentPeriod: curr.periodEnd,
                priorPeriod: prev.periodEnd,
                netIncomeStable: niStable
            };
        }
    }
    return null;
}

/**
 * Detects signs of a reverse stock split (shares decrease, EPS increase proportionally).
 * @param {Array} quartersDesc - Quarters sorted descending by date
 * @param {Object} options
 * @returns {Object|null} - Reverse split signal object or null
 */
export function detectLikelyReverseSplit(quartersDesc, { tolerance = 0.25, minRatio = 4, epsFloor = 0.01 } = {}) {
    const series = [...(quartersDesc || [])].filter((q) => q && q.periodEnd);
    for (let i = 0; i < series.length - 1; i += 1) {
        const curr = series[i];
        const prev = series[i + 1];
        const sharesCurr = Number(curr?.sharesOutstanding ?? curr?.shares);
        const sharesPrev = Number(prev?.sharesOutstanding ?? prev?.shares);
        if (!Number.isFinite(sharesCurr) || !Number.isFinite(sharesPrev) || sharesCurr === 0) continue;
        const reverseRatio = sharesPrev / sharesCurr;
        if (!Number.isFinite(reverseRatio) || reverseRatio < minRatio) continue;
        const epsCurr = Number(curr?.epsBasic);
        const epsPrev = Number(prev?.epsBasic);
        if (
            !Number.isFinite(epsCurr) ||
            !Number.isFinite(epsPrev) ||
            epsCurr === 0 ||
            epsPrev === 0 ||
            Math.sign(epsCurr) !== Math.sign(epsPrev) ||
            Math.abs(epsCurr) < epsFloor ||
            Math.abs(epsPrev) < epsFloor
        ) {
            continue;
        }
        const epsRatio = epsCurr / epsPrev;
        const inverseProduct = Math.abs(epsRatio / reverseRatio - 1);
        if (inverseProduct <= tolerance) {
            const niCurr = Number(curr?.netIncome);
            const niPrev = Number(prev?.netIncome);
            const niStable =
                Number.isFinite(niCurr) &&
                Number.isFinite(niPrev) &&
                Math.abs(niPrev) > 1e-6 &&
                Math.abs(niCurr / niPrev - 1) < 0.35;
            if (niStable === false) continue;
            return {
                flagged: true,
                sharesRatio: reverseRatio,
                epsRatio,
                inverseProduct,
                currentPeriod: curr.periodEnd,
                priorPeriod: prev.periodEnd,
                netIncomeStable: niStable
            };
        }
    }
    return null;
}

/**
 * Computes share changes (QoQ, YoY) with guards against split artifacts.
 * @param {Array} quartersDesc
 * @returns {Object}
 */
export function computeShareChangeWithSplitGuard(quartersDesc) {
    const series = [...(quartersDesc || [])]
        .filter((q) => q && q.periodEnd && Number.isFinite(q.sharesOutstanding ?? q.shares))
        .sort((a, b) => Date.parse(b.periodEnd) - Date.parse(a.periodEnd));
    const latest = series[0] || null;
    const prev = series[1] || null;
    const yearAgo = series.find(q => {
        const d1 = new Date(latest.periodEnd);
        const d2 = new Date(q.periodEnd);
        return Math.abs(d1 - d2 - ONE_YEAR_MS) < TOLERANCE_30D_MS; // ~365 days +/- 30 days
    }) || series[4] || null;
    const rawQoQ = pctChange(
        Number(latest?.sharesOutstanding ?? latest?.shares),
        Number(prev?.sharesOutstanding ?? prev?.shares)
    );
    const rawYoY = yearAgo
        ? pctChange(
            Number(latest?.sharesOutstanding ?? latest?.shares),
            Number(yearAgo?.sharesOutstanding ?? yearAgo?.shares)
        )
        : rawQoQ;
    const splitSignal = detectLikelySplit(series);
    const reverseSplitSignal = detectLikelyReverseSplit(series);
    let adjustedYoY = rawYoY;
    const ratioFromSignal = splitSignal?.sharesRatio ?? null;
    if (ratioFromSignal && ratioFromSignal >= 2 && rawYoY != null) {
        adjustedYoY = null; // treat as split-driven jump; skip dilution penalty
    }
    if (reverseSplitSignal && rawYoY != null) {
        // Reverse splits can look like buybacks; neutralize change to avoid +score credits.
        adjustedYoY = null;
    }
    return {
        changeQoQ: rawQoQ,
        changeYoY: adjustedYoY,
        rawYoY,
        splitSignal,
        reverseSplitSignal
    };
}
