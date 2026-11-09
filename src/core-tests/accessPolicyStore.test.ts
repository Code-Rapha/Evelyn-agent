/**
 * Persistência da política e o contrato da janela.
 *
 * O que se prova: o arquivo é próprio (declarar preços nunca o cria), a
 * leitura distingue "nunca escolhido" de "escolhido como o padrão", e os
 * parsers da ponte descartam linha malformada em vez de mostrar preço
 * inventado.
 */
import * as assert from 'assert';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ACCESS_POLICY_FILE, FileDataStore, PROVIDER_MODELS_FILE } from '../adapters/local/fileDataStore';
import {
	parseAccessPolicyView,
	parseMergedCatalog,
	parseMergedModelView,
} from '../desktop/catalogFusionParsers';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const T0 = '2026-10-20T12:00:00.000Z';

suite('Access policy: storage', () => {
	let root: string;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-policy-store-'));
	});

	teardown(async () => {
		await removeFixtureTree(root);
	});

	function store(): FileDataStore {
		return new FileDataStore({ rootPath: root });
	}

	test('a fresh install has no policy, not a default written', async () => {
		assert.strictEqual(await store().readAccessPolicy(), undefined);
		let exists = true;
		try {
			await access(join(root, ACCESS_POLICY_FILE));
		} catch {
			exists = false;
		}
		assert.strictEqual(exists, false, 'reading does not create the file');
	});

	test('a saved policy survives a reopen', async () => {
		await store().saveAccessPolicy({
			policy: 'free_only',
			priceSource: 'discovered',
			limitsSource: 'user',
			capabilitiesSource: 'user',
			updatedAt: T0,
			changedBy: 'phrase',
		});
		const reopened = await store().readAccessPolicy();
		assert.deepStrictEqual(reopened, {
			policy: 'free_only',
			priceSource: 'discovered',
			limitsSource: 'user',
			capabilitiesSource: 'user',
			updatedAt: T0,
			changedBy: 'phrase',
		});
	});

	test('the policy lives in its own file, not with the models', async () => {
		await store().saveAccessPolicy({
			policy: 'free_preferred',
			priceSource: 'user',
			limitsSource: 'user',
			capabilitiesSource: 'user',
			updatedAt: T0,
			changedBy: 'user',
		});
		const raw = await readFile(join(root, ACCESS_POLICY_FILE), 'utf8');
		assert.ok(raw.includes('free_preferred'));
		// Declaring a model does not touch the policy, and vice versa.
		await store().saveModelCatalogEntry({
			providerId: 'p',
			modelId: 'm',
			pricing: { currency: 'USD', unit: 'per_1m_tokens', input: 3 },
		});
		const policyAfter = await store().readAccessPolicy();
		assert.strictEqual(policyAfter?.policy, 'free_preferred');
	});

	test('a malformed file reads as no policy rather than as a failure', async () => {
		await writeFile(join(root, ACCESS_POLICY_FILE), '{ nope', 'utf8');
		assert.strictEqual(await store().readAccessPolicy(), undefined);
	});

	test('no credential is ever written', async () => {
		await store().saveAccessPolicy({
			policy: 'free_only',
			priceSource: 'user',
			limitsSource: 'user',
			capabilitiesSource: 'user',
			updatedAt: T0,
			changedBy: 'user',
		});
		const raw = await readFile(join(root, ACCESS_POLICY_FILE), 'utf8');
		assert.strictEqual(/api[_-]?key|authorization|bearer|secret|sk-/i.test(raw), false);
	});
});

suite('Access policy: the bridge parsers', () => {
	const status = { policy: 'any', eligible: true };

	test('a policy view round-trips', () => {
		const view = parseAccessPolicyView({
			policy: 'free_only',
			priceSource: 'discovered',
			limitsSource: 'user',
			capabilitiesSource: 'user',
			updatedAt: T0,
			changedBy: 'phrase',
			hint: 'Seshyina, use somente os modelos gratuitos',
		});
		assert.deepStrictEqual(view, {
			policy: 'free_only',
			priceSource: 'discovered',
			limitsSource: 'user',
			capabilitiesSource: 'user',
			updatedAt: T0,
			changedBy: 'phrase',
			hint: 'Seshyina, use somente os modelos gratuitos',
		});
	});

	test('an unknown policy is rejected rather than coerced', () => {
		assert.strictEqual(parseAccessPolicyView({ policy: 'cheap', priceSource: 'user' }), undefined);
		assert.strictEqual(parseAccessPolicyView(null), undefined);
	});

	test('a merged catalog without models is an empty list, not a failure', () => {
		const parsed = parseMergedCatalog({ policy: { policy: 'any', priceSource: 'user' }, models: [] });
		assert.deepStrictEqual(parsed?.models, []);
	});

	test('a model row without a policy status is dropped', () => {
		const row = { providerId: 'p', modelId: 'm', listed: true, updatedAt: T0 };
		assert.strictEqual(parseMergedModelView(row), undefined);
	});

	test('a price without a currency is dropped, never read as zero', () => {
		const parsed = parseMergedModelView({
			providerId: 'p',
			modelId: 'm',
			listed: true,
			updatedAt: T0,
			policyStatus: status,
			price: { user: { currency: '', unit: 'per_1m_tokens', input: 0 }, comparable: false, fellBack: false },
		});
		assert.strictEqual(parsed, undefined);
	});

	test('a price with an unknown unit is dropped', () => {
		const parsed = parseMergedModelView({
			providerId: 'p',
			modelId: 'm',
			listed: true,
			updatedAt: T0,
			policyStatus: status,
			price: { user: { currency: 'USD', unit: 'per_call', input: 1 }, comparable: false, fellBack: false },
		});
		assert.strictEqual(parsed, undefined);
	});

	test('absent amounts stay absent through the bridge', () => {
		const parsed = parseMergedModelView({
			providerId: 'p',
			modelId: 'm',
			listed: true,
			updatedAt: T0,
			policyStatus: status,
			price: {
				user: { currency: 'USD', unit: 'per_1m_tokens', input: 3 },
				comparable: true,
				selected: 'user',
				fellBack: false,
			},
		});
		assert.strictEqual(parsed?.price?.user?.input, 3);
		assert.strictEqual(parsed?.price?.user?.output, undefined);
	});

	test('the discovered side keeps its provenance and staleness', () => {
		const parsed = parseMergedModelView({
			providerId: 'p',
			modelId: 'm',
			listed: true,
			updatedAt: T0,
			policyStatus: { policy: 'free_only', eligible: false, reason: 'free_not_confirmed' },
			price: {
				discovered: {
					currency: 'USD',
					unit: 'per_1m_tokens',
					input: 2,
					output: 8,
					source: 'provider',
					verifiedAt: T0,
					expiresAt: T0,
					stale: true,
					usable: false,
					unusableReason: 'a verificação venceu',
				},
				comparable: false,
				fellBack: false,
			},
		});
		assert.strictEqual(parsed?.price?.discovered?.source, 'provider');
		assert.strictEqual(parsed?.price?.discovered?.usable, false);
		assert.strictEqual(parsed?.price?.discovered?.unusableReason, 'a verificação venceu');
		assert.strictEqual(parsed?.policyStatus.reason, 'free_not_confirmed');
	});
});
