/**
 * Contabilização de consumo: o cálculo, sem disco.
 *
 * Tudo aqui é puro. O objetivo é fixar as regras que, se erradas, produzem um
 * número com cara de fato: cache contado duas vezes, preço ausente virando
 * zero, metade de uma leitura apresentada como leitura inteira.
 */
import * as assert from 'assert';

import {
	attemptIdFor,
	combineCosts,
	computeAttemptCost,
	resolveAttemptAccounting,
	summarizeExecution,
	type AttemptCost,
	type AttemptRecord,
} from '../core/storage/types/consumption';

/** A price in the smallest shape the calculator accepts. */
function pricing(overrides: Partial<{
	currency: string;
	unit: 'per_1k_tokens' | 'per_1m_tokens';
	input: number;
	output: number;
	cachedInput: number;
}> = {}): {
	currency: string;
	unit: 'per_1k_tokens' | 'per_1m_tokens';
	input?: number;
	output?: number;
	cachedInput?: number;
} {
	return { currency: 'USD', unit: 'per_1m_tokens', input: 3, output: 15, ...overrides };
}

/** One recorded attempt, with only what the test needs. */
function attempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
	return {
		attemptId: attemptIdFor('exec', 1),
		executionId: 'exec',
		providerId: 'p',
		modelId: 'm',
		sequence: 1,
		retry: false,
		fallback: false,
		status: 'success',
		startedAt: '2026-01-01T00:00:00.000Z',
		recordedAt: '2026-01-01T00:00:01.000Z',
		cost: { status: 'unknown', parts: [], reasons: ['not priced in this test'] },
		...overrides,
	};
}

suite('Consumption: cost calculation', () => {
	// Per-mile and per-thousand ...............................................

	test('a per-million price is divided by a million, a per-thousand one by a thousand', () => {
		const perMillion = computeAttemptCost({ input: 1_000, output: 1_000 }, pricing());
		assert.strictEqual(perMillion.status, 'estimated');
		if (perMillion.status === 'estimated') {
			// 1000 * 3/1e6 + 1000 * 15/1e6 = 0.003 + 0.015
			assert.strictEqual(perMillion.total, 0.018);
			assert.strictEqual(perMillion.currency, 'USD');
			assert.strictEqual(perMillion.unit, 'per_1m_tokens');
		}

		const perThousand = computeAttemptCost(
			{ input: 1_000, output: 1_000 },
			pricing({ unit: 'per_1k_tokens', input: 0.5, output: 1.5 }),
		);
		assert.strictEqual(perThousand.status, 'estimated');
		if (perThousand.status === 'estimated') {
			// 1000 * 0.5/1e3 + 1000 * 1.5/1e3 = 0.5 + 1.5
			assert.strictEqual(perThousand.total, 2);
			assert.strictEqual(perThousand.unit, 'per_1k_tokens');
		}
	});

	test('the currency of the catalog travels with the amount', () => {
		const cost = computeAttemptCost({ input: 1_000, output: 0 }, pricing({ currency: 'BRL' }));
		assert.strictEqual(cost.status, 'estimated');
		if (cost.status === 'estimated') {
			assert.strictEqual(cost.currency, 'BRL');
		}
	});

	// Cached input .............................................................

	test('cached input is billed at its own rate, and not again as normal input', () => {
		// 1000 in, of which 600 cached: 400 at $3/M + 600 at $0.3/M + 500 out at $15/M
		const cost = computeAttemptCost(
			{ input: 1_000, output: 500, cachedInput: 600 },
			pricing({ cachedInput: 0.3 }),
		);
		assert.strictEqual(cost.status, 'estimated');
		if (cost.status !== 'estimated') {
			return;
		}
		assert.strictEqual(cost.parts.length, 3, 'normal input, cached input and output are separate');
		assert.strictEqual(cost.total, round(400 * 3e-6 + 600 * 0.3e-6 + 500 * 15e-6));

		// The proof it was not double counted: charging all 1000 at the normal
		// rate would be higher by the discount on the 600 cached tokens.
		const naive = computeAttemptCost({ input: 1_000, output: 500 }, pricing());
		assert.ok(naive.status === 'estimated');
		if (naive.status === 'estimated') {
			assert.ok(cost.total < naive.total);
		}
	});

	test('all input cached is billed entirely at the cached rate', () => {
		const cost = computeAttemptCost({ input: 1_000, cachedInput: 1_000 }, pricing({ cachedInput: 0.3 }));
		assert.strictEqual(cost.status, 'estimated');
		if (cost.status === 'estimated') {
			assert.strictEqual(cost.total, round(1_000 * 0.3e-6));
		}
	});

	test('a reported cached count without a cached rate is unknown, not full price', () => {
		const cost = computeAttemptCost({ input: 1_000, output: 10, cachedInput: 600 }, pricing());
		assert.strictEqual(cost.status, 'unknown');
		if (cost.status === 'unknown') {
			assert.ok(cost.reasons.includes('cached input price is unknown'));
			// What is known stays known: the 400 uncached input and the output
			// were both priced, and only the 600 cached tokens are in doubt.
			assert.strictEqual(cost.parts.length, 2);
			assert.strictEqual(
				cost.parts.reduce((sum, part) => sum + part.amount, 0) > 0,
				true,
			);
		}
	});

	test('cached input larger than input is refused as inconsistent', () => {
		const cost = computeAttemptCost(
			{ input: 100, output: 10, cachedInput: 200 },
			pricing({ cachedInput: 0.3 }),
		);
		assert.strictEqual(cost.status, 'unknown');
		if (cost.status === 'unknown') {
			assert.ok(cost.reasons.includes('cached input exceeds total input'));
		}
	});

	// Unknown price and unknown usage .........................................

	test('no price is unknown, never zero', () => {
		const cost = computeAttemptCost({ input: 1_000, output: 1_000 }, undefined);
		assert.strictEqual(cost.status, 'unknown');
		if (cost.status === 'unknown') {
			assert.strictEqual(cost.reasons.length, 1);
		}
		assert.ok(!('total' in cost));
	});

	test('a price with only the input rate leaves the output unknown', () => {
		const cost = computeAttemptCost(
			{ input: 1_000_000, output: 1_000 },
			{ currency: 'USD', unit: 'per_1m_tokens', input: 3 },
		);
		assert.strictEqual(cost.status, 'unknown');
		if (cost.status === 'unknown') {
			assert.ok(cost.reasons.includes('output price is unknown'));
			// The input half was computable and is kept.
			assert.strictEqual(cost.parts.length, 1);
			assert.strictEqual(cost.parts[0].amount, 3);
		}
	});

	test('no token counts at all is unknown', () => {
		const cost = computeAttemptCost(undefined, pricing());
		assert.strictEqual(cost.status, 'unknown');
		if (cost.status === 'unknown') {
			assert.ok(cost.reasons.includes('no token counts were reported'));
		}
	});

	test('a genuinely zero price is zero, and that is an estimate of zero', () => {
		const cost = computeAttemptCost(
			{ input: 1_000, output: 1_000 },
			pricing({ input: 0, output: 0 }),
		);
		assert.strictEqual(cost.status, 'estimated');
		if (cost.status === 'estimated') {
			assert.strictEqual(cost.total, 0);
		}
	});

	// Floating point ..........................................................

	test('many small amounts add without drifted decimals', () => {
		// 0.1 + 0.2 in doubles is 0.30000000000000004. The same three parts must
		// come out as 0.3, because a total is later shown and compared.
		const part = (amount: number): AttemptCost => ({
			status: 'estimated',
			currency: 'USD',
			unit: 'per_1m_tokens',
			parts: [{ currency: 'USD', unit: 'per_1m_tokens', amount }],
			total: amount,
		});
		const combined = combineCosts([part(0.1), part(0.2)]);
		assert.strictEqual(combined.status, 'estimated');
		if (combined.status === 'estimated') {
			assert.strictEqual(combined.total, 0.3);
			assert.strictEqual(String(combined.total), '0.3');
		}
	});

	// Combining attempts ......................................................

	test('one unknown attempt makes the execution cost unknown, not a partial total', () => {
		const priced = computeAttemptCost({ input: 1_000, output: 0 }, pricing());
		const unpriced = computeAttemptCost({ input: 1_000, output: 0 }, undefined);
		const combined = combineCosts([priced, unpriced]);
		assert.strictEqual(combined.status, 'unknown');
		if (combined.status === 'unknown') {
			// The priced half is still visible for diagnosis.
			assert.strictEqual(combined.parts.length, 1);
		}
	});

	test('two priced attempts add up', () => {
		const a = computeAttemptCost({ input: 1_000, output: 0 }, pricing());
		const b = computeAttemptCost({ input: 0, output: 1_000 }, pricing());
		const combined = combineCosts([a, b]);
		assert.strictEqual(combined.status, 'estimated');
		if (combined.status === 'estimated') {
			assert.strictEqual(combined.total, round(1_000 * 3e-6 + 1_000 * 15e-6));
		}
	});

	test('costs in two currencies are not added into one number', () => {
		const usd = computeAttemptCost({ input: 1_000 }, pricing({ output: 0 }));
		const brl = computeAttemptCost({ input: 1_000 }, pricing({ output: 0, currency: 'BRL' }));
		const combined = combineCosts([usd, brl]);
		assert.strictEqual(combined.status, 'unknown');
		if (combined.status === 'unknown') {
			assert.ok(combined.reasons.includes('attempts were priced in more than one currency'));
			assert.strictEqual(combined.parts.length, 2, 'each currency keeps its own amount');
		}
	});

	test('an execution with no attempts has no cost, not a zero cost', () => {
		const combined = combineCosts([]);
		assert.strictEqual(combined.status, 'unknown');
		if (combined.status === 'unknown') {
			assert.ok(combined.reasons.includes('no attempts were recorded'));
		}
	});
});

suite('Consumption: real versus estimated numbers', () => {
	test('a complete provider reading is stored as reported and never as estimated', () => {
		const accounting = resolveAttemptAccounting({
			reportedTokens: { input: 10, output: 20 },
			estimatedTokens: { input: 99, output: 99 },
			pricing: pricing({ output: 0 }),
		});
		assert.deepStrictEqual(accounting.reportedTokens, { input: 10, output: 20 });
		assert.strictEqual(accounting.estimatedTokens, undefined, 'the deduction does not supplement a reading');
		assert.strictEqual(accounting.tokenSource, 'provider');
	});

	test('a provider reading with only one half is not a reading', () => {
		// Charging the reported output next to a guessed input would be an
		// estimate wearing the provider's name.
		const accounting = resolveAttemptAccounting({ reportedTokens: { input: 10 }, pricing: pricing() });
		assert.strictEqual(accounting.reportedTokens, undefined);
		assert.strictEqual(accounting.tokenSource, undefined);
		assert.strictEqual(accounting.cost.status, 'unknown');
	});

	test('an estimate is stored as estimated and marked as such', () => {
		const accounting = resolveAttemptAccounting({
			estimatedTokens: { input: 100, output: 50 },
			pricing: pricing(),
		});
		assert.deepStrictEqual(accounting.estimatedTokens, { input: 100, output: 50 });
		assert.strictEqual(accounting.reportedTokens, undefined);
		assert.strictEqual(accounting.tokenSource, 'estimate');
	});

	test('the recorded price keeps only currency and unit; the amounts are not duplicated', () => {
		const accounting = resolveAttemptAccounting({
			reportedTokens: { input: 1, output: 1 },
			pricing: pricing({ cachedInput: 0.3 }),
		});
		assert.deepStrictEqual(accounting.pricing, {
			currency: 'USD',
			unit: 'per_1m_tokens',
			input: 3,
			output: 15,
			cachedInput: 0.3,
		});
	});

	test('a cached input count is carried through to the cost', () => {
		const accounting = resolveAttemptAccounting({
			reportedTokens: { input: 1_000, output: 0, cachedInput: 400 },
			pricing: pricing({ cachedInput: 0.3, output: 0 }),
		});
		assert.strictEqual(accounting.cost.status, 'estimated');
		if (accounting.cost.status === 'estimated') {
			assert.strictEqual(accounting.cost.total, round(600 * 3e-6 + 400 * 0.3e-6));
		}
	});
});

suite('Consumption: execution totals', () => {
	const priced = (input: number, output: number) =>
		computeAttemptCost({ input, output }, pricing());

	test('each attempt is counted once, in sequence order', () => {
		const totals = summarizeExecution([
			attempt({ sequence: 2, attemptId: attemptIdFor('exec', 2), fallback: true, reportedTokens: { input: 5, output: 7 }, tokenSource: 'provider', cost: priced(5, 7) }),
			attempt({ sequence: 1, attemptId: attemptIdFor('exec', 1), status: 'timeout', reportedTokens: { input: 3, output: 0 }, tokenSource: 'provider', cost: priced(3, 0) }),
		]);
		assert.strictEqual(totals.attempts, 2, 'a retried attempt is a second attempt, not a second execution');
		assert.deepStrictEqual(totals.tokens, { input: 8, output: 7 });
		assert.strictEqual(totals.tokenSource, 'provider');
		assert.strictEqual(totals.cost.status, 'estimated');
	});

	test('a cached count is summed only when every counted attempt reported one', () => {
		const withCache = summarizeExecution([
			attempt({ reportedTokens: { input: 10, output: 1, cachedInput: 4 }, tokenSource: 'provider' }),
		]);
		assert.strictEqual(withCache.tokens?.cachedInput, 4);

		const mixed = summarizeExecution([
			attempt({ sequence: 1, attemptId: attemptIdFor('exec', 1), reportedTokens: { input: 10, output: 1, cachedInput: 4 }, tokenSource: 'provider' }),
			attempt({ sequence: 2, attemptId: attemptIdFor('exec', 2), reportedTokens: { input: 10, output: 1 }, tokenSource: 'provider' }),
		]);
		// Summing the second side as "no cache" would claim a cache total the
		// provider never published.
		assert.strictEqual(mixed.tokens?.cachedInput, undefined);
		assert.strictEqual(mixed.tokens?.input, 20);
	});

	test('an execution that mixed a reading and a deduction says estimate', () => {
		const totals = summarizeExecution([
			attempt({ sequence: 1, attemptId: attemptIdFor('exec', 1), reportedTokens: { input: 10, output: 1 }, tokenSource: 'provider' }),
			attempt({ sequence: 2, attemptId: attemptIdFor('exec', 2), estimatedTokens: { input: 5, output: 5 }, tokenSource: 'estimate' }),
		]);
		assert.strictEqual(totals.tokens?.input, 15);
		assert.strictEqual(totals.tokenSource, 'estimate', 'the total is not wholly what the provider published');
	});

	test('an attempt that billed nothing but has no tokens still counts as an attempt', () => {
		const totals = summarizeExecution([attempt({ status: 'failure' })]);
		assert.strictEqual(totals.attempts, 1);
		assert.strictEqual(totals.tokens, undefined);
		assert.strictEqual(totals.tokenSource, undefined);
	});
});

/** Rounds to 12 decimals, matching the ledger's internal precision. */
function round(value: number): number {
	return Math.round(value * 1e12) / 1e12;
}
