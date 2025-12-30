/**
 * @fileoverview Rule explainers and metadata for the Bullish & Foolish engine.
 * Provides human-readable explanations for each scoring rule.
 */

/**
 * Map of rule names to positive/negative explanations.
 * Used to generate human-readable descriptions on the UI.
 */
export const ruleExplainers = {
    "Revenue growth YoY": {
        pos: "Sales are growing vs. last year.",
        neg: "Sales are shrinking vs. last year."
    },
    "Gross margin": {
        pos: "High profit on every product sold.",
        neg: "Low profit per product sold."
    },
    "Gross margin (health)": {
        pos: "Strong margins support R&D.",
        neg: "Margins are squeezed."
    },
    "Gross margin trend": {
        pos: "Business is becoming more efficient.",
        neg: "Profitability per unit is dropping."
    },
    "Operating leverage": {
        pos: "Converts gross profit into operating profit efficiently.",
        neg: "Overhead eats into gross profit."
    },
    "Gross margin (industrial)": {
        pos: "Healthy markup on goods.",
        neg: "Low markup suggests commodity pricing."
    },
    "FCF margin": {
        pos: "Business generates extra cash for growth.",
        neg: "Burning cash to operate."
    },
    "Cash Runway (years)": {
        pos: "Enough cash for the long haul.",
        neg: "Might need to raise money soon."
    },
    "Shares dilution YoY": {
        pos: "Share count is stable.",
        neg: "New shares reduce your ownership slice."
    },
    "Capital Return": {
        pos: "Returns cash to shareholders via buybacks and dividends.",
        neg: "Capital return is limited or constrained by weak cash generation."
    },
    "Working Capital": {
        pos: "Efficient cash cycle; sales turn into cash quickly.",
        neg: "Cash cycle is inefficient; working capital can trap cash."
    },
    "Effective Tax Rate": {
        pos: "Tax rate looks within a normal operating range.",
        neg: "Tax rate looks distorted (often one-time items or mix effects)."
    },
    "Debt / Equity": {
        pos: "Conservative debt levels.",
        neg: "High debt increases risk."
    },
    "Net Debt / FCF": {
        pos: "Debt can be paid off quickly.",
        neg: "Debt burden is heavy relative to cash flow."
    },
    "Debt Maturity Runway": {
        pos: "More long-term debt reduces near-term refinancing risk.",
        neg: "More short-term debt increases refinancing risk."
    },
    "Interest coverage": {
        pos: "Profits easily cover interest payments.",
        neg: "Struggling to pay interest costs."
    },
    "Capex intensity": {
        pos: "Efficient spending on assets.",
        neg: "Heavy spending required to maintain business."
    },
    "Revenue growth (small)": {
        pos: "Sales are climbing.",
        neg: "Sales are declining."
    },
    "ROE": {
        pos: "Efficiently using shareholder money.",
        neg: "Low return on shareholder capital."
    },
    "ROE quality": {
        pos: "High quality returns.",
        neg: "Weak returns on capital."
    },
    "ROIC": {
        pos: "Creating value on every dollar invested.",
        neg: "Returns are lower than the cost of capital."
    },
    "Asset Efficiency": {
        pos: "Assets are being put to work efficiently.",
        neg: "Assets are under-productive relative to revenue."
    },
    "Dividend coverage": {
        pos: "Dividend is safe and funded by cash.",
        neg: "Dividend costs more than the cash earned."
    },
    "Net income trend": {
        pos: "Profits are trending up.",
        neg: "Profits are shrinking."
    },
    "Revenue CAGR (3Y)": {
        pos: "Consistent long-term growth.",
        neg: "Growth has stalled over time."
    },
    "EPS CAGR (3Y)": {
        pos: "Earnings are compounding.",
        neg: "Earnings have stagnated."
    },
    "R&D intensity": {
        pos: "Investing heavily in the future.",
        neg: "Spending little on innovation."
    },
    "Price / Sales": {
        pos: "Valuation is reasonable relative to sales.",
        neg: "Expensive relative to sales."
    },
    "Price / Earnings": {
        pos: "Valuation is reasonable relative to profit.",
        neg: "Expensive relative to profit."
    },
    "Price / Book": {
        pos: "Valuation is reasonable relative to book value.",
        neg: "Expensive relative to book value."
    },
    "Return on Assets": {
        pos: "Profitable relative to total assets.",
        neg: "Low profit relative to asset base."
    }
};

/**
 * Registry for rule coverage tracking (populated at runtime).
 */
export const ruleRegistry = {};

/**
 * Coverage map for tracking which fields are used by which rules.
 */
export const coverageMap = {};

/**
 * Gets the explainer for a rule, based on whether the score is positive or negative.
 * @param {string} ruleName - Name of the rule
 * @param {number} score - Score value
 * @returns {string} - Explanation text
 */
export function getExplainerForRule(ruleName, score) {
    const explainer = ruleExplainers[ruleName];
    if (!explainer) return "";
    return score >= 0 ? explainer.pos : explainer.neg;
}
