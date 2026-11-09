/**
 * O registro do provedor no disco e a regra de atualização.
 *
 * Prova o que a etapa exige de armazenamento: TTL por tipo, modelo que some
 * sem apagar histórico, falha que preserva e marca, reabertura, e nenhum
 * segredo no arquivo.
 */
import * as assert from 'assert';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileDataStore, PROVIDER_MODELS_FILE } from '../adapters/local/fileDataStore';
import { applyFailure, applyListing, freshness, usableAccess } from '../core/storage/providerModelsRules';
import { DEFAULT_DISCOVERY_TTL, type DiscoveredModel } from '../core/storage/types/providerModels';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const T0 = Date.parse('2026-10-20T12:00:00.000Z');

suite('Provider discovery: rules', () => {
	const base: DiscoveredModel = {
		providerId: 'p',
		modelId: 'm',
		listed: true,
		listedAt: new Date(T0).toISOString(),
		updatedAt: new Date(T0).toISOString(),
		accessConfirmedAt: new Date(T0).toISOString(),
	};

	test('a listing adds models and confirms the ones it saw', () => {
		const { models, outcome } = applyListing({
			providerId: 'p',
			existing: [],
			listing: [{ modelId: 'a' }, { modelId: 'b' }],
			fetchedAtMs: T0,
			ttl: DEFAULT_DISCOVERY_TTL,
			nowMs: T0,
		});
		assert.strictEqual(outcome.status, 'ok');
		assert.strictEqual(outcome.models, 2);
		assert.strictEqual(outcome.added, 2);
		assert.strictEqual(outcome.removed, 0);
		assert.deepStrictEqual(models.map((model) => model.listed), [true, true]);
	});

	test('a model that disappears is kept, unlisted, with the date it went missing', () => {
		const later = T0 + 60_000;
		const { models, outcome } = applyListing({
			providerId: 'p',
			existing: [base],
			listing: [{ modelId: 'other' }],
			fetchedAtMs: later,
			ttl: DEFAULT_DISCOVERY_TTL,
			nowMs: later,
		});
		assert.strictEqual(outcome.removed, 1);
		const gone = models.find((model) => model.modelId === 'm');
		assert.ok(gone !== undefined, 'the record is not deleted');
		assert.strictEqual(gone.listed, false);
		assert.strictEqual(gone.missingSince, new Date(later).toISOString());
		// The confirmation of access predates the disappearance and stays.
		assert.strictEqual(gone.accessConfirmedAt, base.accessConfirmedAt);
	});

	test('a published price becomes access free only when both directions are zero', () => {
		const free = applyListing({
			providerId: 'p',
			existing: [],
			listing: [{ modelId: 'f', pricing: { currency: 'USD', unit: 'per_1m_tokens', input: 0, output: 0 } }],
			fetchedAtMs: T0,
			ttl: DEFAULT_DISCOVERY_TTL,
			nowMs: T0,
		});
		assert.strictEqual(free.models[0]?.access?.access, 'free');
		assert.ok(free.models[0]?.access?.evidence?.includes('0'));

		const half = applyListing({
			providerId: 'p',
			existing: [],
			listing: [{ modelId: 'h', pricing: { currency: 'USD', unit: 'per_1m_tokens', input: 0, output: 5 } }],
			fetchedAtMs: T0,
			ttl: DEFAULT_DISCOVERY_TTL,
			nowMs: T0,
		});
		assert.strictEqual(half.models[0]?.access?.access, 'unknown', 'free input says nothing about output');

		const priced = applyListing({
			providerId: 'p',
			existing: [],
			listing: [{ modelId: 'x', pricing: { currency: 'USD', unit: 'per_1m_tokens', input: 3 } }],
			fetchedAtMs: T0,
			ttl: DEFAULT_DISCOVERY_TTL,
			nowMs: T0,
		});
		assert.strictEqual(priced.models[0]?.access?.access, 'unknown', 'a price is not "paid" without evidence');
	});

	test('an expired access is no longer usable, though it is still shown', () => {
		const { models } = applyListing({
			providerId: 'p',
			existing: [],
			listing: [{ modelId: 'f', pricing: { currency: 'USD', unit: 'per_1m_tokens', input: 0, output: 0 } }],
			fetchedAtMs: T0,
			ttl: DEFAULT_DISCOVERY_TTL,
			nowMs: T0,
		});
		const model = models[0];
		assert.ok(model !== undefined && model.access !== undefined);
		assert.strictEqual(usableAccess(model, T0 + 1).access, 'free');
		const afterExpiry = T0 + DEFAULT_DISCOVERY_TTL.pricingMs + 1;
		assert.strictEqual(usableAccess(model, afterExpiry).access, 'unknown', 'evidence does not outlive its validity');
		assert.strictEqual(freshness(model.access.expiresAt, afterExpiry), 'stale');
	});

	test('a failed refresh changes nothing and marks the copy stale', () => {
		const { models, outcome } = applyFailure({
			providerId: 'p',
			existing: [
				{
					...base,
					pricing: {
						pricing: { currency: 'USD', unit: 'per_1m_tokens', input: 1 },
						source: 'provider',
						verifiedAt: base.updatedAt,
						expiresAt: new Date(T0 + 1000).toISOString(),
						stale: false,
					},
				},
			],
			error: new Error('429'),
			nowMs: T0 + 10,
		});
		assert.strictEqual(outcome.status, 'failed');
		assert.strictEqual(outcome.stale, true);
		assert.strictEqual(models[0]?.listed, true, 'still listed from before');
		assert.strictEqual(models[0]?.pricing?.stale, true);
	});

	test('a failure with nothing recorded is not a stale answer', () => {
		const { outcome } = applyFailure({ providerId: 'p', existing: [], error: new Error('down'), nowMs: T0 });
		assert.strictEqual(outcome.status, 'failed');
		assert.strictEqual(outcome.stale, false);
		assert.strictEqual(outcome.error, 'down');
	});
});

suite('Provider discovery: persistence', () => {
	let root: string;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-provider-models-'));
	});

	teardown(async () => {
		await removeFixtureTree(root);
	});

	function store(): FileDataStore {
		return new FileDataStore({ rootPath: root });
	}

	test('a listing survives closing and reopening', async () => {
		await store().applyModelListing({
			providerId: 'p',
			models: [{ modelId: 'a', contextTokens: 8192 }],
			fetchedAt: new Date().toISOString(),
		});
		const reopened = store();
		const models = await reopened.listDiscoveredModels('p');
		assert.strictEqual(models.length, 1);
		assert.strictEqual(models[0]?.modelId, 'a');
		assert.strictEqual(models[0]?.contextTokens, 8192);
		assert.strictEqual(models[0]?.listed, true);
	});

	test('confirming access records the moment, without inventing a listing', async () => {
		const at = new Date().toISOString();
		await store().confirmAccess({ providerId: 'p', modelId: 'ghost' }, at);
		const model = await store().getDiscoveredModel({ providerId: 'p', modelId: 'ghost' });
		assert.ok(model !== undefined);
		assert.strictEqual(model.listed, false, 'a call proves access, not a listing');
		assert.strictEqual(model.accessConfirmedAt, at);
	});

	test('re-listing keeps the access confirmation', async () => {
		const at = new Date().toISOString();
		const store0 = store();
		await store0.applyModelListing({ providerId: 'p', models: [{ modelId: 'a' }], fetchedAt: at });
		await store0.confirmAccess({ providerId: 'p', modelId: 'a' }, at);
		await store0.applyModelListing({ providerId: 'p', models: [{ modelId: 'a' }], fetchedAt: at });
		const model = await store0.getDiscoveredModel({ providerId: 'p', modelId: 'a' });
		assert.strictEqual(model?.accessConfirmedAt, at);
	});

	test('a quota record round-trips with its source', async () => {
		const at = new Date().toISOString();
		await store().recordQuota({
			providerId: 'p',
			modelId: 'a',
			account: { source: 'account', limit: 100, remaining: 3, retryAfterMs: 1000, verifiedAt: at },
			updatedAt: at,
		});
		const quotas = await store().listQuotas('p');
		assert.strictEqual(quotas.length, 1);
		assert.strictEqual(quotas[0]?.account?.source, 'account');
		assert.strictEqual(quotas[0]?.account?.remaining, 3);
	});

	test('the file holds no credential-shaped field', async () => {
		await store().applyModelListing({
			providerId: 'p',
			models: [{ modelId: 'a', pricing: { currency: 'USD', unit: 'per_1m_tokens', input: 3 } }],
			fetchedAt: new Date().toISOString(),
		});
		const raw = await readFile(join(root, PROVIDER_MODELS_FILE), 'utf8');
		assert.strictEqual(/api[_-]?key|authorization|bearer|secret|sk-[A-Za-z0-9]/i.test(raw), false);
	});

	test('a corrupt file reads as nothing discovered rather than failing to start', async () => {
		await writeFile(join(root, PROVIDER_MODELS_FILE), '{ not json', 'utf8');
		assert.deepStrictEqual(await store().listDiscoveredModels(), []);
	});

	test('a damaged record is dropped, the valid ones stay', async () => {
		await writeFile(
			join(root, PROVIDER_MODELS_FILE),
			JSON.stringify({
				version: 1,
				models: [
					{ providerId: 'p', modelId: 'ok', listed: true, listedAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
{ providerId: 'p', listed: true, listedAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
				],
				quotas: [],
			}),
			'utf8',
		);
		const models = await store().listDiscoveredModels();
		assert.deepStrictEqual(models.map((model) => model.modelId), ['ok']);
	});

	test('a listing that never says "listed at" is not treated as listed', async () => {
		await writeFile(
			join(root, PROVIDER_MODELS_FILE),
			JSON.stringify({
				version: 1,
				models: [{ providerId: 'p', modelId: 'x', listed: true, updatedAt: new Date().toISOString() }],
				quotas: [],
			}),
			'utf8',
		);
		const models = await store().listDiscoveredModels();
		assert.strictEqual(models[0]?.listed, false, 'a listing claim without a date is not evidence');
	});

	test('a price without a currency is dropped on read, not read as zero', async () => {
		await writeFile(
			join(root, PROVIDER_MODELS_FILE),
			JSON.stringify({
				version: 1,
				models: [
					{
						providerId: 'p',
						modelId: 'x',
						listed: true,
						listedAt: new Date().toISOString(),
						updatedAt: new Date().toISOString(),
						pricing: {
							pricing: { currency: '', unit: 'per_1m_tokens', input: 0 },
							source: 'provider',
							verifiedAt: new Date().toISOString(),
							expiresAt: new Date(Date.now() + 1000).toISOString(),
							stale: false,
						},
					},
				],
				quotas: [],
			}),
			'utf8',
		);
		const models = await store().listDiscoveredModels();
		assert.strictEqual(models[0]?.pricing, undefined);
	});
});
