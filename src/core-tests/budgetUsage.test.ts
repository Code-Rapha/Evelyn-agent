/**
 * Agregação de consumo e decisão de orçamento, sem disco.
 *
 * As execuções daqui são construídas com `summarizeExecution` sobre tentativas
 * de `resolveAttemptAccounting` — as mesmas funções da Etapa 5A — para que o
 * teste verifique a agregação e não uma segunda aritmética de custo inventada
 * no próprio teste.
 */
import * as assert from 'assert';

import type { AttemptCost, AttemptRecord, ExecutionRecord } from '../core/storage/types/consumption';
import { resolveAttemptAccounting, summarizeExecution } from '../core/storage/types/consumption';
import {
	aggregateUsage,
	evaluateBudget,
	evaluateBudgets,
	scopeIdFor,
	windowRange,
	type SpendingLimit,
} from '../core/budget';

const USD_3_15 = {
	currency: 'USD',
	unit: 'per_1m_tokens' as const,
	input: 3,
	output: 15,
};

/** An attempt as the store would hold it, priced with the given pricing. */
function attempt(
	sequence: number,
	input: number,
	output: number,
	options: {
		readonly providerId?: string;
		readonly modelId?: string;
		readonly pricing?: typeof USD_3_15;
	} = {},
): AttemptRecord {
	const providerId = options.providerId ?? 'local';
	const modelId = options.modelId ?? 'model-a';
	const accounting = resolveAttemptAccounting({
		reportedTokens: { input, output },
		...(options.pricing !== undefined ? { pricing: options.pricing } : {}),
	});
	return {
		attemptId: `${providerId}/${modelId}#${sequence}`,
		executionId: `${providerId}/${modelId}`,
		providerId,
		modelId,
		sequence,
		retry: false,
		fallback: false,
		status: 'success',
		startedAt: '2026-10-19T10:00:00.000Z',
		recordedAt: '2026-10-19T10:00:00.000Z',
		...(accounting.reportedTokens !== undefined ? { reportedTokens: accounting.reportedTokens } : {}),
		...(accounting.tokenSource !== undefined ? { tokenSource: accounting.tokenSource } : {}),
		...(accounting.pricing !== undefined ? { pricing: accounting.pricing } : {}),
		cost: accounting.cost,
	};
}

function execution(
	id: string,
	startedAt: string,
	attempts: readonly AttemptRecord[],
	options: { readonly providerId?: string; readonly modelId?: string } = {},
): ExecutionRecord {
	return {
		executionId: id,
		kind: 'routing',
		...(options.providerId !== undefined ? { providerId: options.providerId } : {}),
		...(options.modelId !== undefined ? { modelId: options.modelId } : {}),
		status: 'success',
		startedAt,
		finishedAt: startedAt,
		attemptIds: attempts.map((a) => a.attemptId),
		totals: summarizeExecution(attempts),
	};
}

function limit(overrides: Partial<SpendingLimit> = {}): SpendingLimit {
	return {
		limitId: 'global',
		currency: 'USD',
		amount: 10,
		window: 'month',
		createdAt: '2026-10-01T00:00:00.000Z',
		updatedAt: '2026-10-01T00:00:00.000Z',
		...overrides,
	};
}

suite('Budget: aggregation', () => {
	suite('by period, provider, model and execution', () => {
		const morning = execution('e1', '2026-10-19T09:00:00.000Z', [attempt(1, 1_000, 500, { pricing: USD_3_15 })], {
			providerId: 'local',
			modelId: 'model-a',
		});
		const afternoon = execution('e2', '2026-10-19T15:00:00.000Z', [attempt(1, 2_000, 0, { pricing: USD_3_15 })], {
			providerId: 'remote',
			modelId: 'model-b',
		});
		const both = [afternoon, morning];

		test('the total counts every execution once, with its tokens', () => {
			const summary = aggregateUsage(both);
			assert.strictEqual(summary.total.executions, 2);
			assert.strictEqual(summary.total.attempts, 2);
			assert.deepStrictEqual(summary.total.tokens, { input: 3_000, output: 500 });
			assert.strictEqual(summary.total.tokenSource, 'provider');
			assert.strictEqual(summary.total.executionsWithoutCost, 0);
		});

		test('providers are separate slices and add up to the total', () => {
			const summary = aggregateUsage(both);
			assert.strictEqual(summary.byProvider.length, 2);
			const local = summary.byProvider.find((slice) => slice.providerId === 'local');
			const remote = summary.byProvider.find((slice) => slice.providerId === 'remote');
			assert.ok(local !== undefined && remote !== undefined);
			assert.deepStrictEqual(local.tokens, { input: 1_000, output: 500 });
			assert.deepStrictEqual(remote.tokens, { input: 2_000, output: 0 });
		});

		test('models are separate slices, named by provider and model', () => {
			const summary = aggregateUsage(both);
			assert.deepStrictEqual(
				summary.byModel.map((slice) => `${slice.providerId}/${slice.modelId}`).sort(),
				['local/model-a', 'remote/model-b'],
			);
		});

		test('every execution appears once, newest first', () => {
			const summary = aggregateUsage(both);
			assert.deepStrictEqual(
				summary.byExecution.map((slice) => slice.executionId),
				['e2', 'e1'],
			);
		});

		test('a priced period sums its costs exactly', () => {
			const priced = [
				execution('p1', '2026-10-19T09:00:00.000Z', [attempt(1, 1_000, 500, { pricing: USD_3_15 })], {
					providerId: 'local',
					modelId: 'model-a',
				}),
				execution('p2', '2026-10-19T10:00:00.000Z', [attempt(1, 1_000, 0, { pricing: USD_3_15 })], {
					providerId: 'local',
					modelId: 'model-a',
				}),
			];
			const summary = aggregateUsage(priced);
			assert.strictEqual(summary.total.cost.status, 'estimated');
			if (summary.total.cost.status === 'estimated') {
				// Two executions, each 1000 in at 3/M plus 500 out at 15/M once.
				const expected = Math.round((0.003 + 0.0075 + 0.003) * 1e12) / 1e12;
				assert.strictEqual(summary.total.cost.total, expected);
			}
		});

		test('an unpriced execution makes the total unknown, never a subtotal', () => {
			const priced = execution('u1', '2026-10-19T09:00:00.000Z', [attempt(1, 1_000, 500, { pricing: USD_3_15 })], {
				providerId: 'local',
				modelId: 'model-a',
			});
			const unpriced = execution('u2', '2026-10-19T10:00:00.000Z', [attempt(1, 1_000, 500)], {
				providerId: 'local',
				modelId: 'model-b',
			});
			const summary = aggregateUsage([priced, unpriced]);
			assert.strictEqual(summary.total.cost.status, 'unknown');
			assert.strictEqual(summary.total.executionsWithoutCost, 1);
			if (summary.total.cost.status === 'unknown') {
				assert.deepStrictEqual(summary.total.costReasons, [...summary.total.cost.reasons]);
				assert.ok(summary.total.cost.reasons.length > 0, 'the reason travels with the total');
			}
		});

		test('an execution with no provider is kept, not dropped', () => {
			const orphan = execution('o1', '2026-10-19T09:00:00.000Z', [attempt(1, 10, 5, { pricing: USD_3_15 })]);
			const summary = aggregateUsage([orphan]);
			assert.strictEqual(summary.total.executions, 1);
			assert.strictEqual(summary.byProvider.length, 1);
			assert.strictEqual(summary.byProvider[0].providerId, '');
		});

		test('an empty period has no cost and no slices', () => {
			const summary = aggregateUsage([]);
			assert.strictEqual(summary.total.executions, 0);
			assert.strictEqual(summary.total.cost.status, 'unknown');
			assert.deepStrictEqual(summary.byProvider, []);
			assert.deepStrictEqual(summary.byModel, []);
			assert.deepStrictEqual(summary.byExecution, []);
		});

		test('executions in different currencies are not summed into one number', () => {
			const usd = execution('c1', '2026-10-19T09:00:00.000Z', [attempt(1, 1_000, 0, { pricing: USD_3_15 })], {
				providerId: 'local',
				modelId: 'model-a',
			});
			const conversion = summarizeExecution([
				attempt(1, 1_000, 0, {
					pricing: { currency: 'BRL', unit: 'per_1m_tokens', input: 5, output: 20 },
				}),
			]);
			const brl: ExecutionRecord = {
				executionId: 'c2',
				kind: 'routing',
				providerId: 'local',
				modelId: 'model-b',
				status: 'success',
				startedAt: '2026-10-19T10:00:00.000Z',
				finishedAt: '2026-10-19T10:00:00.000Z',
				attemptIds: ['x#1'],
				totals: conversion,
			};
			const summary = aggregateUsage([usd, brl]);
			assert.strictEqual(summary.total.cost.status, 'unknown');
		});
	});

	suite('calendar windows', () => {
		test('today starts at local midnight and ends at the given instant', () => {
			const now = new Date(2026, 9, 19, 16, 30, 0);
			const range = windowRange('day', now);
			const since = new Date(range.since);
			assert.strictEqual(since.getHours(), 0);
			assert.strictEqual(since.getMinutes(), 0);
			assert.strictEqual(since.getDate(), 19);
			assert.strictEqual(range.until, now.toISOString());
		});

		test('this month starts on the first day at local midnight', () => {
			const now = new Date(2026, 9, 19, 16, 30, 0);
			const range = windowRange('month', now);
			const since = new Date(range.since);
			assert.strictEqual(since.getDate(), 1);
			assert.strictEqual(since.getMonth(), 9);
			assert.strictEqual(since.getHours(), 0);
		});
	});
});

suite('Budget: limits and decisions', () => {
	const paid = { providerId: 'remote', modelId: 'model-b', access: 'paid' as const };
	const free = { providerId: 'local', modelId: 'model-a', access: 'free' as const };
	const unknown = { providerId: 'local', modelId: 'model-c', access: 'unknown' as const };
	const spent = (amount: number, cost?: AttemptCost): { cost: AttemptCost; spent?: number } => ({
		cost: cost ?? {
			status: 'estimated',
			currency: 'USD',
			unit: 'per_1m_tokens',
			parts: [{ currency: 'USD', unit: 'per_1m_tokens', amount }],
			total: amount,
		},
		spent: amount,
	});
	const unmeasured: { cost: AttemptCost } = {
		cost: { status: 'unknown', parts: [], reasons: ['no price was recorded for this model'] },
	};

	test('under the limit is allowed', () => {
		const decision = evaluateBudget({ limit: limit(), candidate: paid, usage: spent(4.99), allowPaid: true });
		assert.strictEqual(decision.kind, 'allow');
	});

	test('spending exactly the limit blocks, with the numbers the user needs', () => {
		const decision = evaluateBudget({ limit: limit({ amount: 5 }), candidate: paid, usage: spent(5), allowPaid: true });
		assert.strictEqual(decision.kind, 'blocked');
		if (decision.kind === 'blocked') {
			assert.strictEqual(decision.spent, 5);
			assert.strictEqual(decision.amount, 5);
			assert.strictEqual(decision.currency, 'USD');
			assert.strictEqual(decision.scope, 'global');
			assert.ok(decision.reason.includes('atingido'));
		}
	});

	test('a free model is never blocked by a spent budget', () => {
		const decision = evaluateBudget({ limit: limit({ amount: 0 }), candidate: free, usage: spent(100), allowPaid: true });
		assert.strictEqual(decision.kind, 'allow');
	});

	test('an unknown price is not treated as free and not treated as a charge', () => {
		// `unknown` access is not evidence of spending, so it is allowed...
		const access = evaluateBudget({ limit: limit({ amount: 0 }), candidate: unknown, usage: spent(100), allowPaid: true });
		assert.strictEqual(access.kind, 'allow');
		// ...and a period whose cost cannot be computed does not block a paid
		// model either: it is reported as unknown rather than as "limit ok".
		const measured = evaluateBudget({ limit: limit(), candidate: paid, usage: unmeasured, allowPaid: true });
		assert.strictEqual(measured.kind, 'unknown');
		if (measured.kind === 'unknown') {
			assert.ok(measured.reason.includes('USD'));
		}
	});

	test('an unmeasured period never becomes a zero spent', () => {
		const decision = evaluateBudget({ limit: limit({ amount: 1 }), candidate: paid, usage: unmeasured, allowPaid: true });
		assert.notStrictEqual(decision.kind, 'blocked');
	});

	test('without paid authorization the budget does not add a second veto', () => {
		const decision = evaluateBudget({ limit: limit({ amount: 0 }), candidate: paid, usage: spent(50), allowPaid: false });
		assert.strictEqual(decision.kind, 'allow');
	});

	test('a model limit covers only its model', () => {
		const modelLimit = limit({
			limitId: scopeIdFor({ providerId: 'remote', modelId: 'model-b' }),
			providerId: 'remote',
			modelId: 'model-b',
			amount: 0,
		});
		// `evaluateBudget` is handed a limit already chosen for the model; the
		// scoping is the caller's. What this asserts is that the numbers decide:
		// another model the caller did not scope in is not reached here, and
		// `evaluateBudgets` is what filters.
		const scoped = evaluateBudgets([modelLimit], paid, () => spent(0), true);
		assert.strictEqual(scoped.kind, 'blocked');
		const other = evaluateBudgets(
			[modelLimit],
			{ providerId: 'remote', modelId: 'model-z', access: 'paid' },
			() => spent(0),
			true,
		);
		assert.strictEqual(other.kind, 'allow', 'a model limit does not reach another model');
	});

	test('the most specific blocking limit explains the decision', () => {
		const globalLimit = limit({ amount: 100 });
		const modelLimit = limit({
			limitId: scopeIdFor({ providerId: 'remote', modelId: 'model-b' }),
			providerId: 'remote',
			modelId: 'model-b',
			amount: 2,
		});
		const decision = evaluateBudgets(
			[globalLimit, modelLimit],
			paid,
			(entry) => (entry.limitId === modelLimit.limitId ? spent(3) : spent(1)),
			true,
		);
		assert.strictEqual(decision.kind, 'blocked');
		if (decision.kind === 'blocked') {
			assert.strictEqual(decision.scope, 'model');
		}
	});

	test('a block beats an unknown, and an unknown beats an allow', () => {
		const blocking = limit({ limitId: 'a', amount: 1 });
		const unknownLimit = limit({ limitId: 'b', amount: 50 });
		const decision = evaluateBudgets(
			[unknownLimit, blocking],
			paid,
			(entry) => (entry.limitId === blocking.limitId ? spent(1) : unmeasured),
			true,
		);
		assert.strictEqual(decision.kind, 'blocked');

		const onlyUnknown = evaluateBudgets([unknownLimit], paid, () => unmeasured, true);
		assert.strictEqual(onlyUnknown.kind, 'unknown');

		const none = evaluateBudgets([], paid, () => spent(0), true);
		assert.strictEqual(none.kind, 'allow');
	});

	test('a zero limit is a real cap, not a missing one', () => {
		const decision = evaluateBudget({ limit: limit({ amount: 0 }), candidate: paid, usage: spent(0), allowPaid: true });
		assert.strictEqual(decision.kind, 'blocked');
	});
});
