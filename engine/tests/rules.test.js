
/**
 * @fileoverview Unit tests for the Bullish & Foolish scoring rules.
 * Run with: node engine/tests/rules.test.js
 */

import { strict as assert } from 'assert';
import { rules } from '../index.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`✗ ${name}`);
        console.error(`  ${err.message}`);
        failed++;
    }
}

function describe(name, fn) {
    console.log(`\n${name}`);
    console.log('─'.repeat(name.length));
    fn();
}

console.log('\n🧪 Validating Scoring Rules');
console.log('==========================');

describe('Rule Definitions', () => {
    test('rules array is populated', () => {
        assert.ok(Array.isArray(rules), 'rules should be an array');
        assert.ok(rules.length > 0, 'rules array should not be empty');
        console.log(`  (Found ${rules.length} rules)`);
    });

    test('rules have correct schema', () => {
        rules.forEach((rule, idx) => {
            assert.ok(rule.name, `Rule #${idx} missing name`);
            assert.ok(typeof rule.weight === 'number', `Rule ${rule.name} missing weight`);
            assert.ok(typeof rule.evaluate === 'function', `Rule ${rule.name} missing evaluate function`);
        });
    });
});

describe('Rule Execution Sanity', () => {
    // Mock minimal stock object
    const mockStock = {
        ticker: "TEST",
        sector: "Technology",
        growth: { revenueGrowthYoY: 10 },
        valuationRatios: { peRatio: 20 },
        profitMargins: { grossMargin: 50 },
        // ... add fields as needed to prevent crashes, though engine uses optional chaining
    };

    test('all rules execute without throwing on valid object', () => {
        rules.forEach(rule => {
            try {
                const res = rule.evaluate(mockStock);
                // Result can be null (internal skip) or object
                if (res) {
                    assert.ok(typeof res.score === 'number', `Rule ${rule.name} returned non-number score`);
                }
            } catch (err) {
                throw new Error(`Rule ${rule.name} threw error: ${err.message}`);
            }
        });
    });

    test('all rules execute without throwing on empty object', () => {
        const emptyStock = {};
        rules.forEach(rule => {
            try {
                const res = rule.evaluate(emptyStock);
                // Should return missing() or null, but not throw
            } catch (err) {
                throw new Error(`Rule ${rule.name} threw error on empty object: ${err.message}`);
            }
        });
    });
});

console.log('\n' + '═'.repeat(40));
console.log(`Tests: ${passed} passed, ${failed} failed`);
console.log('═'.repeat(40));

if (failed > 0) process.exit(1);
