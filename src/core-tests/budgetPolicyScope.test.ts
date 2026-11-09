/**
 * O orçamento com escopo de política.
 *
 * A pergunta que estes testes respondem: um limite restrito a `free_only`
 * coexiste com o limite geral, ambos valem, e a precedência entre eles é
 * explícita.
 */
import * as assert from 'assert';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	appliesTo,
	evaluateBudget,
	evaluateBudgets,
	LIMIT_SCOPE_PRECEDENCE,
	scopeIdFor,
	scopeOf,
	type SpendingLimit,
} from '../core/budget/policy';
import { parseSpendingLimits, readSpendingLimit } from '../core/budget/limitsLedger';
import { FileDataStore } from '../adapters/local/fileDataStore';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const T0 = '2026-10-20T12:00:00.000Z';

function limit(overrides: Partial<SpendingLimit> = {}): SpendingLimit {
	return {
		limitId: 'global',
		currency: 'USD',
		amount: 10,
		window: 'month',
		createdAt: T0,
		updatedAt: T0,
		...overrides,
	};
}

suite('Budget: the policy scope', () => {
	test('a limit without a policy applies to every policy', () => {
		assert.strictEqual(
			appliesTo(limit(), { providerId: 'p', modelId: 'm', policy: 'free_only' }),
			true,
		);
		assert.strictEqual(
			appliesTo(limit(), { providerId: 'p', modelId: 'm', policy: 'any' }),
			true,
		);
	});

	test('a policy-scoped limit applies only to that policy', () => {
		const scoped = limit({ limitId: 'policy:free_only', policy: 'free_only' });
		assert.strictEqual(
			appliesTo(scoped, { providerId: 'p', modelId: 'm', policy: 'free_only' }),
			true,
		);
		assert.strictEqual(
			appliesTo(scoped, { providerId: 'p', modelId: 'm', policy: 'free_preferred' }),
			false,
		);
		assert.strictEqual(
			appliesTo(scoped, { providerId: 'p', modelId: 'm' }),
			false,
			'sem política em vigor, um limite restrito não se aplica',
		);
	});

	test('the scope id keeps a policy-scoped limit apart from the general one', () => {
		assert.notStrictEqual(scopeIdFor({ policy: 'free_only' }), scopeIdFor({}));
		assert.strictEqual(scopeIdFor({ policy: 'free_only' }), scopeIdFor({ policy: 'free_only' }));
		assert.strictEqual(
			scopeIdFor({ providerId: 'p', policy: 'free_only' }),
			scopeIdFor({ providerId: 'p', policy: 'free_only' }),
		);
	});

	test('the scope of a policy limit says so', () => {
		assert.strictEqual(scopeOf(limit()), 'global');
		assert.strictEqual(scopeOf(limit({ providerId: 'p' })), 'provider');
		assert.strictEqual(scopeOf(limit({ providerId: 'p', modelId: 'm' })), 'model');
		assert.strictEqual(scopeOf(limit({ policy: 'free_only' })), 'policy');
	});

	test('the precedence is explicit and from the most specific to the least', () => {
		assert.deepStrictEqual([...LIMIT_SCOPE_PRECEDENCE], ['model', 'provider', 'policy', 'global']);
	});

	test('every applicable limit is respected, and the most specific explains the block', () => {
		const general = limit({ limitId: 'global', amount: 100 });
		const policyScoped = limit({ limitId: 'policy:free_only', policy: 'free_only', amount: 5 });
		const decision = evaluateBudgets(
			[general, policyScoped],
			{ providerId: 'p', modelId: 'm', access: 'paid', policy: 'free_only' },
			() => ({ cost: { status: 'unknown', parts: [], reasons: [] }, spent: 7 }),
			true,
		);
		assert.strictEqual(decision.kind, 'blocked');
		assert.strictEqual(decision.kind === 'blocked' ? decision.scope : undefined, 'policy');
	});

	test('a limit of another policy is not even looked at', () => {
		const policyScoped = limit({ limitId: 'policy:free_only', policy: 'free_only', amount: 0 });
		const decision = evaluateBudgets(
			[policyScoped],
			{ providerId: 'p', modelId: 'm', access: 'paid', policy: 'any' },
			() => ({ cost: { status: 'unknown', parts: [], reasons: [] }, spent: 7 }),
			true,
		);
		assert.strictEqual(decision.kind, 'allow');
	});

	test('the general limit still blocks when the policy-scoped one allows', () => {
		const general = limit({ limitId: 'global', amount: 1 });
		const policyScoped = limit({ limitId: 'policy:free_only', policy: 'free_only', amount: 100 });
		const decision = evaluateBudgets(
			[general, policyScoped],
			{ providerId: 'p', modelId: 'm', access: 'paid', policy: 'free_only' },
			() => ({ cost: { status: 'unknown', parts: [], reasons: [] }, spent: 7 }),
			true,
		);
		assert.strictEqual(decision.kind, 'blocked');
		assert.strictEqual(decision.kind === 'blocked' ? decision.scope : undefined, 'global');
	});

	test('a free model is never blocked, whatever the limit', () => {
		const decision = evaluateBudget(
			{
				limit: limit({ amount: 0 }),
				candidate: { providerId: 'p', modelId: 'm', access: 'free', policy: 'free_only' },
				usage: { cost: { status: 'unknown', parts: [], reasons: [] }, spent: 7 },
				allowPaid: true,
			},
		);
		assert.strictEqual(decision.kind, 'allow');
	});
});

suite('Budget: the policy scope on disk', () => {
	let root: string;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-policy-budget-'));
	});

	teardown(async () => {
		await removeFixtureTree(root);
	});

	function store(): FileDataStore {
		return new FileDataStore({ rootPath: root });
	}

	test('a general limit and a policy-scoped one coexist', async () => {
		const data = store();
		await data.saveSpendingLimit({ currency: 'USD', amount: 10, window: 'month' });
		await data.saveSpendingLimit({
			currency: 'USD',
			amount: 5,
			window: 'month',
			policy: 'free_only',
		});
		const limits = await data.listSpendingLimits();
		assert.strictEqual(limits.length, 2);
		assert.strictEqual(limits.filter((entry) => entry.policy === 'free_only').length, 1);
		assert.strictEqual(limits.filter((entry) => entry.policy === undefined).length, 1);
	});

	test('saving the same policy scope replaces it, and does not touch the general one', async () => {
		const data = store();
		await data.saveSpendingLimit({ currency: 'USD', amount: 10, window: 'month' });
		await data.saveSpendingLimit({
			currency: 'USD',
			amount: 5,
			window: 'month',
			policy: 'free_only',
		});
		await data.saveSpendingLimit({
			currency: 'USD',
			amount: 7,
			window: 'month',
			policy: 'free_only',
		});
		const limits = await data.listSpendingLimits();
		assert.strictEqual(limits.length, 2);
		assert.strictEqual(limits.find((entry) => entry.policy === 'free_only')?.amount, 7);
		assert.strictEqual(limits.find((entry) => entry.policy === undefined)?.amount, 10);
	});

	test('the policy survives a reopen', async () => {
		const data = store();
		await data.saveSpendingLimit({
			currency: 'USD',
			amount: 5,
			window: 'month',
			policy: 'free_only',
		});
		const reopened = new FileDataStore({ rootPath: root });
		const limits = await reopened.listSpendingLimits();
		assert.strictEqual(limits[0]?.policy, 'free_only');
	});

	test('a record with an unknown policy is dropped, and the rest stays', () => {
		const parsed = parseSpendingLimits(
			JSON.stringify({
				version: 1,
				limits: [
					{
						limitId: 'x',
						currency: 'USD',
						amount: 1,
						window: 'month',
						createdAt: T0,
						updatedAt: T0,
						policy: 'whenever',
					},
					{
						limitId: 'y',
						currency: 'USD',
						amount: 2,
						window: 'month',
						createdAt: T0,
						updatedAt: T0,
					},
				],
			}),
		);
		assert.strictEqual(parsed.length, 1);
		assert.strictEqual(parsed[0]?.amount, 2);
	});

	test('the limit id is derived from the scope, policy included', () => {
		const record = readSpendingLimit({
			currency: 'USD',
			amount: 1,
			window: 'month',
			createdAt: T0,
			updatedAt: T0,
			policy: 'free_only',
		});
		assert.strictEqual(record?.limitId, 'policy:free_only');
	});
});
