/**
 * Os limites de orçamento no `FileDataStore`: persistência, reabertura,
 * idempotência por escopo, validação e leitura tolerante.
 *
 * O arquivo é lido de volta com uma instância **nova** sobre a mesma raiz,
 * porque é isso que "sobrevive a fechar e reabrir" significa. Nenhum teste
 * passa pelo banco em memória do armazenamento para provar o formato.
 */
import * as assert from 'assert';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileDataStore, SPENDING_LIMITS_FILE } from '../adapters/local/fileDataStore';
import { scopeIdFor } from '../core/budget';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const NOW = '2026-10-19T12:00:00.000Z';

suite('Spending limits: persistence', () => {
	let root: string;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-limits-'));
	});

	teardown(async () => {
		await removeFixtureTree(root);
	});

	function store(): FileDataStore {
		return new FileDataStore({ rootPath: root, now: () => NOW });
	}

	test('a limit survives closing and reopening the app', async () => {
		await store().saveSpendingLimit({ currency: 'usd', amount: 12.5, window: 'month' });

		const reopened = store();
		const limits = await reopened.listSpendingLimits();
		assert.strictEqual(limits.length, 1);
		assert.strictEqual(limits[0].currency, 'USD', 'the currency is normalized, not converted');
		assert.strictEqual(limits[0].amount, 12.5);
		assert.strictEqual(limits[0].window, 'month');
		assert.strictEqual(limits[0].limitId, 'global');
	});

	test('the scope is the identity: saving it again replaces the cap', async () => {
		const first = await store().saveSpendingLimit({ providerId: 'remote', currency: 'USD', amount: 5, window: 'day' });
		const second = await store().saveSpendingLimit({ providerId: 'remote', currency: 'USD', amount: 9, window: 'month' });

		const limits = await store().listSpendingLimits();
		assert.strictEqual(limits.length, 1, 'no second limit for the same provider');
		assert.strictEqual(first.limitId, second.limitId);
		assert.strictEqual(limits[0].amount, 9);
		assert.strictEqual(limits[0].window, 'month');
		// The moment the limit came into existence does not move on an edit.
		assert.strictEqual(limits[0].createdAt, first.createdAt);
	});

	test('global, provider and model limits coexist and list most specific first', async () => {
		const store0 = store();
		await store0.saveSpendingLimit({ currency: 'USD', amount: 100, window: 'month' });
		await store0.saveSpendingLimit({ providerId: 'remote', currency: 'USD', amount: 50, window: 'month' });
		await store0.saveSpendingLimit({
			providerId: 'remote',
			modelId: 'model-b',
			currency: 'USD',
			amount: 10,
			window: 'day',
		});

		const limits = await store().listSpendingLimits();
		assert.deepStrictEqual(
			limits.map((limit) => (limit.modelId !== undefined ? 'model' : limit.providerId !== undefined ? 'provider' : 'global')),
			['model', 'provider', 'global'],
		);
	});

	test('removing a limit returns whether it existed and is durable', async () => {
		const id = scopeIdFor({ providerId: 'remote' });
		await store().saveSpendingLimit({ providerId: 'remote', currency: 'USD', amount: 1, window: 'day' });
		assert.strictEqual(await store().removeSpendingLimit(id), true);
		assert.strictEqual(await store().removeSpendingLimit(id), false);
		assert.deepStrictEqual(await store().listSpendingLimits(), []);
	});

	test('a limit lives in its own file, not in the ledger', async () => {
		await store().saveSpendingLimit({ currency: 'USD', amount: 1, window: 'day' });
		const raw = await readFile(join(root, SPENDING_LIMITS_FILE), 'utf8');
		const parsed = JSON.parse(raw) as { limits: unknown[] };
		assert.strictEqual(parsed.limits.length, 1);
	});

	suite('validation on write', () => {
		test('a model limit needs the provider that serves it', async () => {
			await assert.rejects(
				() => store().saveSpendingLimit({ modelId: 'model-b', currency: 'USD', amount: 1, window: 'day' }),
				/provider that serves the model/,
			);
		});

		test('a negative or non-finite amount is refused', async () => {
			await assert.rejects(
				() => store().saveSpendingLimit({ currency: 'USD', amount: -1, window: 'day' }),
				/amount/,
			);
			await assert.rejects(
				() => store().saveSpendingLimit({ currency: 'USD', amount: Number.NaN, window: 'day' }),
				/amount/,
			);
		});

		test('a currency that is not a three-letter code is refused', async () => {
			await assert.rejects(
				() => store().saveSpendingLimit({ currency: 'dólares', amount: 1, window: 'day' }),
				/currency/,
			);
		});

		test('an unknown window is refused', async () => {
			await assert.rejects(
				() =>
					store().saveSpendingLimit({
						currency: 'USD',
						amount: 1,
						// Cast: the type already forbids it; this is the runtime guard.
						window: 'week' as unknown as 'day',
					}),
				/window/,
			);
		});

		test('a limit id that does not match its scope is refused', async () => {
			await assert.rejects(
				() =>
					store().saveSpendingLimit({
						providerId: 'remote',
						limitId: 'global',
						currency: 'USD',
						amount: 1,
						window: 'day',
					}),
				/does not match/,
			);
		});

		test('a secret-looking field is refused', async () => {
			await assert.rejects(
				() =>
					store().saveSpendingLimit({
						currency: 'USD',
						amount: 1,
						window: 'day',
						apiKey: 'sk-should-not-land',
					} as never),
				/secrets belong in the SecretStore/,
			);
		});
	});

	suite('tolerant reads', () => {
		async function writeRaw(payload: unknown): Promise<void> {
			await writeFile(join(root, SPENDING_LIMITS_FILE), JSON.stringify(payload), 'utf8');
		}

		test('a limit with a bad field is dropped, the valid ones stay', async () => {
			await writeRaw({
				version: 1,
				limits: [
					{
						limitId: 'global',
						currency: 'USD',
						amount: 3,
						window: 'month',
						createdAt: NOW,
						updatedAt: NOW,
					},
					{
						limitId: 'provider:bad',
						providerId: 'bad',
						currency: 'USD',
						amount: -2,
						window: 'month',
						createdAt: NOW,
						updatedAt: NOW,
					},
					{
						limitId: 'provider:weird',
						providerId: 'weird',
						currency: 'USD',
						amount: 1,
						window: 'week',
						createdAt: NOW,
						updatedAt: NOW,
					},
				],
			});
			const limits = await store().listSpendingLimits();
			assert.deepStrictEqual(limits.map((limit) => limit.limitId), ['global']);
		});

		test('a limit id that disagrees with its scope is rewritten from the scope', async () => {
			await writeRaw({
				version: 1,
				limits: [
					{
						limitId: 'something-else',
						providerId: 'remote',
						currency: 'USD',
						amount: 2,
						window: 'day',
						createdAt: NOW,
						updatedAt: NOW,
					},
				],
			});
			const limits = await store().listSpendingLimits();
			assert.strictEqual(limits.length, 1);
			// The id is derived so that saving the same scope reaches this row.
			assert.strictEqual(limits[0].limitId, scopeIdFor({ providerId: 'remote' }));
		});

		test('a model without a provider is discarded: it has no scope', async () => {
			await writeRaw({
				version: 1,
				limits: [
					{
						limitId: 'model::model-b',
						modelId: 'model-b',
						currency: 'USD',
						amount: 1,
						window: 'day',
						createdAt: NOW,
						updatedAt: NOW,
					},
				],
			});
			assert.deepStrictEqual(await store().listSpendingLimits(), []);
		});

		test('a malformed file reads as no limits', async () => {
			await writeFile(join(root, SPENDING_LIMITS_FILE), 'not json at all', 'utf8');
			assert.deepStrictEqual(await store().listSpendingLimits(), []);
		});

		test('a missing file reads as no limits, and a first save creates it', async () => {
			assert.deepStrictEqual(await store().listSpendingLimits(), []);
			await store().saveSpendingLimit({ currency: 'USD', amount: 1, window: 'day' });
			assert.strictEqual((await store().listSpendingLimits()).length, 1);
		});

		test('a duplicate scope in the file is counted once', async () => {
			const record = {
				limitId: 'global',
				currency: 'USD',
				amount: 5,
				window: 'month',
				createdAt: NOW,
				updatedAt: NOW,
			};
			await writeRaw({ version: 1, limits: [record, { ...record, amount: 9 }] });
			const limits = await store().listSpendingLimits();
			assert.strictEqual(limits.length, 1);
			assert.strictEqual(limits[0].amount, 5, 'the first record wins, not the last');
		});
	});
});
