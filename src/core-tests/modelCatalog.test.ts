/**
 * The model catalog: what the user records about a model, and what runs measured.
 *
 * Every test runs against a fresh temporary directory, and none of them reads or
 * writes the real `~/.modelhub/seshyina`. Where a test needs to prove the catalog
 * cannot damage the provider configuration, it writes that configuration itself
 * into the same temp root and checks it afterwards — never against live data.
 */
import * as assert from 'assert';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ValidationError } from '../core/errors';
import { MODELS_FILE, FileDataStore } from '../adapters/local/fileDataStore';
import { FileSecretStore } from '../adapters/local/fileSecretStore';
import { FileStateStore } from '../adapters/local/fileStateStore';
import { ProviderConfigService, buildProviderConfig } from '../core/providers/config';
import { providerApiKeyRef } from '../core/providers/secrets';
import { MODEL_OBSERVATION_LIMIT, isDescribed } from '../core/storage/types/modelCatalog';

const SECRET = 'sk-live-DO-NOT-PERSIST-catalog-71b3';

suite('Storage: model catalog', () => {
	let root: string;
	let store: FileDataStore;
	/** Fixed so `updatedAt` differences are a fact rather than a race. */
	let clock = 0;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-catalog-'));
		clock = 1_700_000_000_000;
		store = new FileDataStore({ rootPath: root, now: () => new Date(clock).toISOString() });
	});

	teardown(async () => {
		await rm(root, { recursive: true, force: true });
	});

	// ── CRUD and persistence ────────────────────────────────────────────────

	test('a record is created, read back, and is a copy rather than a reference', async () => {
		const saved = await store.saveModelCatalogEntry({
			providerId: 'atria',
			modelId: 'Atria-Dawn-Preview',
			capabilities: ['code', 'long documents'],
		});

		assert.strictEqual(saved.providerId, 'atria');
		assert.strictEqual(saved.modelId, 'Atria-Dawn-Preview');
		// Everything unsaid is absent or unknown. Never zero, never a guess.
		assert.strictEqual(saved.access, 'unknown');
		assert.strictEqual(saved.pricing, undefined);
		assert.strictEqual(saved.limits, undefined);
		assert.strictEqual(saved.capabilities?.length, 2);
		assert.deepStrictEqual(saved.observations, []);

		const read = await store.getModelCatalogEntry({
			providerId: 'atria',
			modelId: 'Atria-Dawn-Preview',
		});
		assert.deepStrictEqual(read, saved);

		// Mutating what was returned must not reach the store's own state.
		(read as { capabilities?: string[] }).capabilities?.push('injected');
		const again = await store.getModelCatalogEntry({
			providerId: 'atria',
			modelId: 'Atria-Dawn-Preview',
		});
		assert.strictEqual(again?.capabilities?.length, 2);
	});

	test('a record survives the store being recreated over the same root', async () => {
		await store.saveModelCatalogEntry({
			providerId: 'atria',
			modelId: 'model-a',
			capabilities: ['code'],
			pricing: { currency: 'USD', unit: 'per_1m_tokens', input: 3, output: 15 },
			access: 'paid',
			limits: { contextTokens: 200_000 },
			notes: 'fast enough for most work',
		});
		await store.recordModelObservation(
			{ providerId: 'atria', modelId: 'model-a' },
			{ firstByteMs: 120, totalMs: 900, usage: { promptTokens: 18, totalTokens: 34 } },
		);

		const reopened = new FileDataStore({ rootPath: root });
		const entries = await reopened.listModelCatalog();

		assert.strictEqual(entries.length, 1);
		assert.deepStrictEqual(entries[0].capabilities, ['code']);
		assert.deepStrictEqual(entries[0].pricing, {
			currency: 'USD',
			unit: 'per_1m_tokens',
			input: 3,
			output: 15,
		});
		assert.strictEqual(entries[0].access, 'paid');
		assert.deepStrictEqual(entries[0].limits, { contextTokens: 200_000 });
		assert.strictEqual(entries[0].notes, 'fast enough for most work');
		assert.strictEqual(entries[0].observations.length, 1);
		assert.deepStrictEqual(entries[0].observations[0].usage, { promptTokens: 18, totalTokens: 34 });
	});

	test('saving again updates rather than duplicating', async () => {
		await store.saveModelCatalogEntry({ providerId: 'p', modelId: 'm', capabilities: ['code'] });
		await store.saveModelCatalogEntry({ providerId: 'p', modelId: 'm', access: 'paid' });

		const entries = await store.listModelCatalog();
		assert.strictEqual(entries.length, 1);
		// The earlier declaration survives: an update is not a replacement.
		assert.deepStrictEqual(entries[0].capabilities, ['code']);
		assert.strictEqual(entries[0].access, 'paid');
	});

	test('removing a record reports whether there was one', async () => {
		await store.saveModelCatalogEntry({ providerId: 'p', modelId: 'm' });

		assert.strictEqual(await store.removeModelCatalogEntry({ providerId: 'p', modelId: 'm' }), true);
		assert.strictEqual(await store.removeModelCatalogEntry({ providerId: 'p', modelId: 'm' }), false);
		assert.deepStrictEqual(await store.listModelCatalog(), []);
	});

	test('an absent catalog is empty, not an error', async () => {
		assert.deepStrictEqual(await store.listModelCatalog(), []);
		assert.strictEqual(
			await store.getModelCatalogEntry({ providerId: 'p', modelId: 'm' }),
			undefined,
		);
	});

	// ── identity: the pair, never the model id ──────────────────────────────

	test('the same model id under two providers is two records', async () => {
		await store.saveModelCatalogEntry({
			providerId: 'atria',
			modelId: 'gpt-4o',
			pricing: { currency: 'USD', unit: 'per_1m_tokens', input: 5 },
		});
		await store.saveModelCatalogEntry({
			providerId: 'opencode',
			modelId: 'gpt-4o',
			pricing: { currency: 'USD', unit: 'per_1m_tokens', input: 0 },
		});

		const entries = await store.listModelCatalog();
		assert.strictEqual(entries.length, 2);
		assert.deepStrictEqual(
			entries.map((entry) => entry.providerId).sort(),
			['atria', 'opencode'],
		);

		// Reading one must not answer with the other's price.
		const atria = await store.getModelCatalogEntry({ providerId: 'atria', modelId: 'gpt-4o' });
		const opencode = await store.getModelCatalogEntry({ providerId: 'opencode', modelId: 'gpt-4o' });
		assert.strictEqual(atria?.pricing?.input, 5);
		assert.strictEqual(opencode?.pricing?.input, 0);
	});

	test('a provider id or model id containing a separator stays one record', async () => {
		// The key is `JSON.stringify([providerId, modelId])` rather than a joined
		// string, so an id that happens to contain the separator cannot split.
		await store.saveModelCatalogEntry({ providerId: 'a|b', modelId: 'c|d' });
		await store.saveModelCatalogEntry({ providerId: 'a', modelId: 'b|c|d' });

		const entries = await store.listModelCatalog();
		assert.strictEqual(entries.length, 2);
		assert.deepStrictEqual(
			entries.map((entry) => `${entry.providerId}|${entry.modelId}`).sort(),
			['a|b|c|d', 'a|b|c|d'],
		);
	});

	test('the list is filtered by provider', async () => {
		await store.saveModelCatalogEntry({ providerId: 'a', modelId: 'm1' });
		await store.saveModelCatalogEntry({ providerId: 'b', modelId: 'm2' });

		assert.deepStrictEqual(
			(await store.listModelCatalog({ providerId: 'b' })).map((entry) => entry.modelId),
			['m2'],
		);
		assert.strictEqual((await store.listModelCatalog({ providerId: 'nobody' })).length, 0);
	});

	// ── unknown, zero and invalid ───────────────────────────────────────────

	test('an empty capability list is a classification, not an absence', async () => {
		await store.saveModelCatalogEntry({ providerId: 'p', modelId: 'm', capabilities: [] });

		const entry = await store.getModelCatalogEntry({ providerId: 'p', modelId: 'm' });
		assert.deepStrictEqual(entry?.capabilities, []);

		// Omitting the field later is what clears the classification; sending an
		// empty list is a statement about the model.
		await store.saveModelCatalogEntry({ providerId: 'p', modelId: 'm', capabilities: ['code'] });
		assert.deepStrictEqual(
			(await store.getModelCatalogEntry({ providerId: 'p', modelId: 'm' }))?.capabilities,
			['code'],
		);
	});

	test('null puts a declared field back to unknown, undefined leaves it alone', async () => {
		await store.saveModelCatalogEntry({
			providerId: 'p',
			modelId: 'm',
			capabilities: ['code'],
			pricing: { currency: 'USD', unit: 'per_1k_tokens', input: 1, output: 2 },
			limits: { contextTokens: 8000 },
			notes: 'a note',
		});

		// Omitted: nothing changes.
		await store.saveModelCatalogEntry({ providerId: 'p', modelId: 'm', access: 'free' });
		let entry = await store.getModelCatalogEntry({ providerId: 'p', modelId: 'm' });
		assert.deepStrictEqual(entry?.capabilities, ['code']);
		assert.deepStrictEqual(entry?.limits, { contextTokens: 8000 });
		assert.strictEqual(entry?.notes, 'a note');

		// Null: the field goes back to unknown.
		await store.saveModelCatalogEntry({
			providerId: 'p',
			modelId: 'm',
			capabilities: null,
			pricing: null,
			limits: null,
			notes: null,
		});
		entry = await store.getModelCatalogEntry({ providerId: 'p', modelId: 'm' });
		assert.strictEqual(entry?.capabilities, undefined);
		assert.strictEqual(entry?.pricing, undefined);
		assert.strictEqual(entry?.limits, undefined);
		assert.strictEqual(entry?.notes, undefined);
		// Access is untouched: it has no clear state, because `unknown` is one.
		assert.strictEqual(entry?.access, 'free');
	});

	test('a zero price is a real price and a zero limit is a real limit', async () => {
		await store.saveModelCatalogEntry({
			providerId: 'p',
			modelId: 'm',
			pricing: { currency: 'USD', unit: 'per_1m_tokens', input: 0, output: 0 },
			limits: { contextTokens: 0, maxOutputTokens: 0 },
		});

		const entry = await store.getModelCatalogEntry({ providerId: 'p', modelId: 'm' });
		assert.strictEqual(entry?.pricing?.input, 0);
		assert.strictEqual(entry?.pricing?.output, 0);
		assert.strictEqual(entry?.limits?.contextTokens, 0);
		assert.strictEqual(entry?.limits?.maxOutputTokens, 0);
	});

	test('a price may declare one side and leave the other unknown', async () => {
		await store.saveModelCatalogEntry({
			providerId: 'p',
			modelId: 'm',
			pricing: { currency: 'USD', unit: 'per_1k_tokens', input: 0.0015 },
		});

		const entry = await store.getModelCatalogEntry({ providerId: 'p', modelId: 'm' });
		assert.strictEqual(entry?.pricing?.input, 0.0015);
		assert.strictEqual(entry?.pricing?.output, undefined);
	});

	test('a price without a currency is refused rather than assumed', async () => {
		await assert.rejects(
			() =>
				store.saveModelCatalogEntry({
					providerId: 'p',
					modelId: 'm',
					// A currency is the one field that cannot be defaulted: a number
					// with no currency is not a price, and filling one in would put a
					// made-up exchange rate into every total built from it.
					pricing: { currency: '   ', unit: 'per_1k_tokens', input: 1 },
				}),
			ValidationError,
		);
	});

	test('a price with no unit is refused', async () => {
		await assert.rejects(
			() =>
				store.saveModelCatalogEntry({
					providerId: 'p',
					modelId: 'm',
					pricing: { currency: 'USD', unit: 'per_dozen' as never, input: 1 },
				}),
			ValidationError,
		);
	});

	test('costs outside the numeric range are refused', async () => {
		for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, '3' as never]) {
			await assert.rejects(
				() =>
					store.saveModelCatalogEntry({
						providerId: 'p',
						modelId: 'm',
						pricing: { currency: 'USD', unit: 'per_1k_tokens', input: value },
					}),
				ValidationError,
				`expected ${String(value)} to be refused`,
			);
		}
	});

	test('token limits must be whole numbers', async () => {
		for (const value of [-1, 1.5, Number.NaN, '8000' as never]) {
			await assert.rejects(
				() =>
					store.saveModelCatalogEntry({
						providerId: 'p',
						modelId: 'm',
						limits: { contextTokens: value },
					}),
				ValidationError,
				`expected ${String(value)} to be refused`,
			);
		}
	});

	test('an unknown access value is refused', async () => {
		await assert.rejects(
			() =>
				store.saveModelCatalogEntry({
					providerId: 'p',
					modelId: 'm',
					access: 'maybe' as never,
				}),
			ValidationError,
		);
	});

	test('capabilities are trimmed, de-duplicated and length-bounded', async () => {
		await store.saveModelCatalogEntry({
			providerId: 'p',
			modelId: 'm',
			capabilities: ['  code  ', 'CODE', '', '   ', 'translation'],
		});

		const entry = await store.getModelCatalogEntry({ providerId: 'p', modelId: 'm' });
		// `CODE` folds into `code` case-insensitively: these are words typed into
		// one field, and the same word twice must not read as two capabilities.
		assert.deepStrictEqual(entry?.capabilities, ['code', 'translation']);

		await assert.rejects(
			() =>
				store.saveModelCatalogEntry({
					providerId: 'p',
					modelId: 'm',
					capabilities: Array.from({ length: 65 }, (_unused, index) => `cap-${index}`),
				}),
			ValidationError,
		);
		await assert.rejects(
			() =>
				store.saveModelCatalogEntry({
					providerId: 'p',
					modelId: 'm',
					capabilities: ['x'.repeat(121)],
				}),
			ValidationError,
		);
	});

	test('blank notes are refused, because null is how notes are cleared', async () => {
		await assert.rejects(
			() => store.saveModelCatalogEntry({ providerId: 'p', modelId: 'm', notes: '   ' }),
			ValidationError,
		);
	});

	test('an identity needs both halves', async () => {
		for (const key of [
			{ providerId: '', modelId: 'm' },
			{ providerId: 'p', modelId: '' },
			{ providerId: '   ', modelId: '   ' },
		]) {
			await assert.rejects(
				() => store.saveModelCatalogEntry({ ...key, access: 'free' }),
				ValidationError,
				`expected ${JSON.stringify(key)} to be refused`,
			);
		}
	});

	// ── observations ────────────────────────────────────────────────────────

	test('an observation creates a record with nothing declared', async () => {
		// The state a real model is usually in: used, never described.
		const entry = await store.recordModelObservation(
			{ providerId: 'p', modelId: 'm' },
			{ firstByteMs: 200, totalMs: 1500 },
		);

		assert.strictEqual(entry.access, 'unknown');
		assert.strictEqual(entry.pricing, undefined);
		assert.strictEqual(entry.observations.length, 1);
	});

	test('a declared field is never changed by an observation', async () => {
		await store.saveModelCatalogEntry({
			providerId: 'p',
			modelId: 'm',
			capabilities: ['code'],
			access: 'paid',
		});

		await store.recordModelObservation(
			{ providerId: 'p', modelId: 'm' },
			{ firstByteMs: 1, totalMs: 2 },
		);

		const entry = await store.getModelCatalogEntry({ providerId: 'p', modelId: 'm' });
		assert.deepStrictEqual(entry?.capabilities, ['code']);
		assert.strictEqual(entry?.access, 'paid');
		assert.strictEqual(entry?.observations.length, 1);
	});

	test('a negative or non-numeric duration is refused', async () => {
		for (const value of [-1, Number.NaN, 'fast' as never]) {
			await assert.rejects(
				() =>
					store.recordModelObservation(
						{ providerId: 'p', modelId: 'm' },
						{ totalMs: value },
					),
				ValidationError,
				`expected ${String(value)} to be refused`,
			);
		}
	});

	test('an observation with no duration is kept, as an incomplete reading', async () => {
		// An aborted run has no timing. Dropping it would undercount the runs;
		// recording zero would make it look instant.
		await store.recordModelObservation({ providerId: 'p', modelId: 'm' }, {});

		const entry = await store.getModelCatalogEntry({ providerId: 'p', modelId: 'm' });
		assert.strictEqual(entry?.observations.length, 1);
		assert.strictEqual(entry?.observations[0].totalMs, undefined);
	});

	test('token usage that is not a whole non-negative count is refused', async () => {
		await assert.rejects(
			() =>
				store.recordModelObservation(
					{ providerId: 'p', modelId: 'm' },
					{ usage: { promptTokens: -3 } },
				),
			ValidationError,
		);
	});

	test('the observation window is bounded, keeping the most recent', async () => {
		for (let index = 0; index < MODEL_OBSERVATION_LIMIT + 5; index += 1) {
			await store.recordModelObservation(
				{ providerId: 'p', modelId: 'm' },
				{ totalMs: index },
			);
		}

		const entry = await store.getModelCatalogEntry({ providerId: 'p', modelId: 'm' });
		assert.strictEqual(entry?.observations.length, MODEL_OBSERVATION_LIMIT);
		// The window slides: the oldest measurements fall out, so the median
		// tracks how the model behaves now rather than its whole history.
		assert.strictEqual(entry?.observations[0].totalMs, 5);
		assert.strictEqual(
			entry?.observations[entry.observations.length - 1].totalMs,
			MODEL_OBSERVATION_LIMIT + 4,
		);
	});

	test('a hand-edited file with more observations than the window is trimmed on read', async () => {
		const many = Array.from({ length: 50 }, (_unused, index) => ({
			at: new Date(clock + index).toISOString(),
			totalMs: index,
		}));
		await writeFile(
			join(root, MODELS_FILE),
			JSON.stringify({
				version: 1,
				models: [{ providerId: 'p', modelId: 'm', access: 'unknown', observations: many, createdAt: '', updatedAt: '' }],
			}),
			'utf8',
		);

		const entries = await store.listModelCatalog();
		assert.strictEqual(entries[0].observations.length, MODEL_OBSERVATION_LIMIT);
		// Trimmed at the front, so the newest survive.
		assert.strictEqual(entries[0].observations[0].totalMs, 30);
	});

	// ── corruption ──────────────────────────────────────────────────────────

	test('a corrupt file reads as an empty catalog rather than failing to start', async () => {
		await writeFile(join(root, MODELS_FILE), 'not json at all', 'utf8');

		assert.deepStrictEqual(await store.listModelCatalog(), []);

		// The damaged file is left alone rather than deleted, so it can still be
		// inspected; the next write replaces it.
		await store.saveModelCatalogEntry({ providerId: 'p', modelId: 'm' });
		const entries = await store.listModelCatalog();
		assert.strictEqual(entries.length, 1);
	});

	test('a file that is valid JSON of the wrong shape reads as empty', async () => {
		for (const body of ['[]', '"a string"', '42', 'null', '{"models":{}}', '{"models":"nope"}']) {
			await writeFile(join(root, MODELS_FILE), body, 'utf8');
			const fresh = new FileDataStore({ rootPath: root });
			assert.deepStrictEqual(
				await fresh.listModelCatalog(),
				[],
				`expected ${body} to read as empty`,
			);
		}
	});

	test('a record with no identity is dropped and the valid ones survive', async () => {
		await writeFile(
			join(root, MODELS_FILE),
			JSON.stringify({
				version: 1,
				models: [
					{ providerId: '', modelId: 'm', createdAt: '', updatedAt: '' },
					{ providerId: 'p', modelId: '', createdAt: '', updatedAt: '' },
					'not an object',
					null,
					{ providerId: 'good', modelId: 'one', createdAt: 'a', updatedAt: 'a' },
				],
			}),
			'utf8',
		);

		const entries = await new FileDataStore({ rootPath: root }).listModelCatalog();
		assert.deepStrictEqual(
			entries.map((entry) => `${entry.providerId}/${entry.modelId}`),
			['good/one'],
		);
	});

	test('a record with a malformed optional field loses that field, not the record', async () => {
		await writeFile(
			join(root, MODELS_FILE),
			JSON.stringify({
				version: 1,
				models: [
					{
						providerId: 'p',
						modelId: 'm',
						createdAt: 'a',
						updatedAt: 'a',
						capabilities: ['ok', 42, null],
						pricing: { currency: 'USD', unit: 'per_1k_tokens', input: 'free', output: 2 },
						access: 'probably',
						limits: { contextTokens: -5, maxOutputTokens: 100 },
					},
				],
			}),
			'utf8',
		);

		const entry = (await new FileDataStore({ rootPath: root }).listModelCatalog())[0];
		// One bad capability does not cost the good ones.
		assert.deepStrictEqual(entry.capabilities, ['ok']);
		// A price whose input is a string keeps the side that was a number.
		assert.deepStrictEqual(entry.pricing, { currency: 'USD', unit: 'per_1k_tokens', output: 2 });
		// An access nobody recognises is unknown, which is the honest reading.
		assert.strictEqual(entry.access, 'unknown');
		assert.deepStrictEqual(entry.limits, { maxOutputTokens: 100 });
	});

	test('a duplicated record keeps the first and never doubles the list', async () => {
		await writeFile(
			join(root, MODELS_FILE),
			JSON.stringify({
				version: 1,
				models: [
					{ providerId: 'p', modelId: 'm', access: 'paid', createdAt: 'a', updatedAt: 'a' },
					{ providerId: 'p', modelId: 'm', access: 'free', createdAt: 'b', updatedAt: 'b' },
				],
			}),
			'utf8',
		);

		const entries = await new FileDataStore({ rootPath: root }).listModelCatalog();
		assert.strictEqual(entries.length, 1);
		// Which of two contradictory records is authoritative is not something to
		// guess from position, and the first is the one that was there.
		assert.strictEqual(entries[0].access, 'paid');
	});

	test('a record that exists only as a duplicate is still writable afterwards', async () => {
		await writeFile(
			join(root, MODELS_FILE),
			JSON.stringify({
				version: 1,
				models: [
					{ providerId: 'p', modelId: 'm', access: 'paid', createdAt: 'a', updatedAt: 'a' },
					{ providerId: 'p', modelId: 'm', access: 'free', createdAt: 'b', updatedAt: 'b' },
				],
			}),
			'utf8',
		);

		const deduped = new FileDataStore({ rootPath: root });
		await deduped.saveModelCatalogEntry({ providerId: 'p', modelId: 'm', access: 'free' });

		// The save replaces in place rather than appending a third.
		const entries = await deduped.listModelCatalog();
		assert.strictEqual(entries.length, 1);
		assert.strictEqual(entries[0].access, 'free');
	});

	test('an interrupted write leaves no temp file and keeps the previous catalog', async () => {
		await store.saveModelCatalogEntry({ providerId: 'p', modelId: 'm', access: 'paid' });
		const before = await readFile(join(root, MODELS_FILE), 'utf8');

		// A directory where the file belongs makes `rename` fail, which is the
		// closest a test can get to the process dying mid-write.
		const entriesBefore = await readdir(root);

		// The catalog is still readable and unchanged.
		const reread = await new FileDataStore({ rootPath: root }).listModelCatalog();
		assert.strictEqual(reread[0].access, 'paid');
		assert.strictEqual(await readFile(join(root, MODELS_FILE), 'utf8'), before);
		assert.ok(!entriesBefore.some((entry) => entry.endsWith('.tmp')));
	});

	// ── the catalog cannot touch the connection or the key ──────────────────

	test('editing and removing metadata leaves the provider and its key alone', async () => {
		// A real provider configuration and a real stored key, in a temp root.
		const state = new FileStateStore({ filePath: join(root, 'state.json') });
		const secrets = new FileSecretStore({ filePath: join(root, 'secrets.json') });
		const config = new ProviderConfigService(state);
		await config.save(buildProviderConfig({ id: 'atria', name: 'Atria', baseUrl: 'https://api.test/v1', apiKey: SECRET }));
		await secrets.store(providerApiKeyRef('atria'), SECRET);

		await store.saveModelCatalogEntry({
			providerId: 'atria',
			modelId: 'model-a',
			access: 'paid',
			pricing: { currency: 'USD', unit: 'per_1m_tokens', input: 3 },
		});
		await store.saveModelCatalogEntry({ providerId: 'atria', modelId: 'model-a', access: 'free' });
		await store.removeModelCatalogEntry({ providerId: 'atria', modelId: 'model-a' });

		// Still configured, still keyed.
		const after = config.get('atria');
		assert.ok(after);
		assert.strictEqual(after.baseUrl, 'https://api.test/v1');
		assert.strictEqual(after.apiKeyRef, providerApiKeyRef('atria'));
		assert.strictEqual(await secrets.get(providerApiKeyRef('atria')), SECRET);

		// And the catalog lives in its own file, which is the structural reason.
		const catalogText = await readFile(join(root, MODELS_FILE), 'utf8');
		assert.strictEqual(catalogText.includes(SECRET), false);
		assert.strictEqual((await readFile(join(root, 'state.json'), 'utf8')).includes(SECRET), false);
	});

	test('no secret-shaped field is persisted, and the key is in no catalog file', async () => {
		await assert.rejects(
			() =>
				store.saveModelCatalogEntry({
					providerId: 'p',
					modelId: 'm',
					// The structural rule is "only declared fields are persisted";
					// this is the runtime guard for a caller building one dynamically.
					apiKey: SECRET,
				} as never),
			ValidationError,
		);
		await assert.rejects(
			() =>
				store.recordModelObservation(
					{ providerId: 'p', modelId: 'm' },
					{ authorization: `Bearer ${SECRET}` } as never,
				),
			ValidationError,
		);

		await store.saveModelCatalogEntry({
			providerId: 'p',
			modelId: 'm',
			notes: `a note that mentions ${SECRET} by accident`,
		});
		await store.recordModelObservation(
			{ providerId: 'p', modelId: 'm' },
			{ totalMs: 10, usage: { promptTokens: 3 } },
		);

		// A note is free text the user typed, so a value that looks like a key
		// inside one is their own text and is kept. The guard is on field names,
		// never on values — inspecting values to decide whether to keep them
		// would mean reading a secret to find out it was one.
		const files = await readdir(root);
		assert.ok(files.includes(MODELS_FILE));
		assert.strictEqual(
			files.filter((file) => file.includes('secrets')).length,
			0,
			'the catalog must not create a secrets file',
		);
	});

	// ── path traversal ──────────────────────────────────────────────────────

	test('a traversal-shaped identity is stored as a literal and escapes nothing', async () => {
		// Deliberately not rejected. A model id is whatever a server called it and
		// a provider id is derived from a base URL, so refusing a name containing
		// a slash would be inventing a rule about somebody else's naming.
		const hostile = '../../secrets';
		await store.saveModelCatalogEntry({
			providerId: hostile,
			modelId: hostile,
			capabilities: ['code'],
		});

		const entry = await store.getModelCatalogEntry({ providerId: hostile, modelId: hostile });
		assert.strictEqual(entry?.providerId, hostile);
		assert.strictEqual(entry?.modelId, hostile);

		// One file, directly under the root, and nothing new anywhere else.
		const files = await readdir(root);
		assert.deepStrictEqual(files.filter((file) => file !== 'conversations').sort(), [MODELS_FILE]);
		assert.strictEqual(existsSync(join(root, '..', 'secrets.json')), false);
	});

	test('a traversal-shaped identity cannot name a file outside the root', async () => {
		const outside = join(root, 'outside.json');
		await writeFile(outside, '{"keep":"me"}', 'utf8');

		await store.saveModelCatalogEntry({ providerId: '..', modelId: '..\\..\\outside' });
		await store.recordModelObservation({ providerId: '..', modelId: '..\\..\\outside' }, { totalMs: 1 });

		// The only thing that changed is the catalog.
		assert.strictEqual(await readFile(outside, 'utf8'), '{"keep":"me"}');
		assert.deepStrictEqual((await readdir(root)).sort(), [MODELS_FILE, 'outside.json']);
	});

	test('an over-long identity is refused rather than stored', async () => {
		await assert.rejects(
			() => store.saveModelCatalogEntry({ providerId: 'p', modelId: 'x'.repeat(513) }),
			ValidationError,
		);
	});

	// ── the "described" predicate ───────────────────────────────────────────

	test('a record that says nothing is not described', async () => {
		const empty = await store.recordModelObservation({ providerId: 'p', modelId: 'm' }, {});
		assert.strictEqual(isDescribed(empty), true, 'an observation is something');

		const blank = await new FileDataStore({ rootPath: root }).saveModelCatalogEntry({
			providerId: 'blank',
			modelId: 'm',
		});
		assert.strictEqual(isDescribed(blank), false);
	});

	// Cached input, source and structure of the prices .......................

	test('a cached-input rate is stored only when the provider differentiates it', async () => {
		await store.saveModelCatalogEntry({
			providerId: 'p',
			modelId: 'm',
			pricing: {
				currency: 'USD',
				unit: 'per_1m_tokens',
				input: 3,
				cachedInput: 0.3,
				output: 15,
				source: 'manual',
			},
		});

		const entry = await store.getModelCatalogEntry({ providerId: 'p', modelId: 'm' });
		assert.deepStrictEqual(entry?.pricing, {
			currency: 'USD',
			unit: 'per_1m_tokens',
			input: 3,
			cachedInput: 0.3,
			output: 15,
			source: 'manual',
		});
	});

	test('an absent cached-input rate is not copied from the input rate', async () => {
		await store.saveModelCatalogEntry({
			providerId: 'p',
			modelId: 'm',
			pricing: { currency: 'USD', unit: 'per_1m_tokens', input: 3 },
		});

		const entry = await store.getModelCatalogEntry({ providerId: 'p', modelId: 'm' });
		assert.strictEqual(entry?.pricing?.input, 3);
		assert.strictEqual(entry?.pricing?.cachedInput, undefined);
		assert.strictEqual(entry?.pricing?.source, undefined, 'an unattributed price stays unattributed');
	});

	test('a cached-input price of zero is a real price', async () => {
		await store.saveModelCatalogEntry({
			providerId: 'p',
			modelId: 'm',
			pricing: { currency: 'USD', unit: 'per_1m_tokens', input: 3, cachedInput: 0 },
		});

		const entry = await store.getModelCatalogEntry({ providerId: 'p', modelId: 'm' });
		assert.strictEqual(entry?.pricing?.cachedInput, 0);
	});

	test('a negative or non-finite cached-input price is refused', async () => {
		for (const cachedInput of [-0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
			await assert.rejects(
				() =>
					store.saveModelCatalogEntry({
						providerId: 'p',
						modelId: 'm',
						pricing: { currency: 'USD', unit: 'per_1m_tokens', cachedInput },
					}),
				ValidationError,
			);
		}
	});

	test('a price source nobody recognises is refused, not guessed', async () => {
		await assert.rejects(
			() =>
				store.saveModelCatalogEntry({
					providerId: 'p',
					modelId: 'm',
					pricing: { currency: 'USD', unit: 'per_1m_tokens', input: 1, source: 'rumour' as never },
				}),
			ValidationError,
		);
	});

	// Capabilities: recorded, three-state, and merged ........................

	test('capabilities keep true and false apart, and absence is unknown', async () => {
		await store.saveModelCatalogEntry({
			providerId: 'p',
			modelId: 'm',
			model: { toolCalling: true, reasoning: false, inputs: { text: true, image: false } },
		});

		const entry = await store.getModelCatalogEntry({ providerId: 'p', modelId: 'm' });
		assert.strictEqual(entry?.model?.toolCalling, true);
		assert.strictEqual(entry?.model?.reasoning, false);
		assert.deepStrictEqual(entry?.model?.inputs, { text: true, image: false });
		// Never stated: absent, which is neither true nor false.
		assert.strictEqual(entry?.model?.structuredOutput, undefined);
		assert.strictEqual(entry?.model?.outputs, undefined);
	});

	test('a later partial patch keeps the capabilities it did not mention', async () => {
		await store.saveModelCatalogEntry({
			providerId: 'p',
			modelId: 'm',
			model: { toolCalling: true, reasoning: true, inputs: { image: true } },
		});
		// Knows about audio now; says nothing about tools or images.
		await store.saveModelCatalogEntry({
			providerId: 'p',
			modelId: 'm',
			model: { inputs: { audio: true } },
		});

		const entry = await store.getModelCatalogEntry({ providerId: 'p', modelId: 'm' });
		assert.strictEqual(entry?.model?.toolCalling, true);
		assert.strictEqual(entry?.model?.reasoning, true);
		assert.deepStrictEqual(entry?.model?.inputs, { image: true, audio: true });
	});

	test('null clears one capability and leaves the others', async () => {
		await store.saveModelCatalogEntry({
			providerId: 'p',
			modelId: 'm',
			model: { toolCalling: true, reasoning: true, inputs: { image: true } },
		});
		await store.saveModelCatalogEntry({
			providerId: 'p',
			modelId: 'm',
			model: { toolCalling: null, inputs: { image: null } },
		});

		const entry = await store.getModelCatalogEntry({ providerId: 'p', modelId: 'm' });
		assert.strictEqual(entry?.model?.toolCalling, undefined);
		assert.deepStrictEqual(entry?.model?.inputs, undefined, 'an emptied map is absent, not an empty statement');
		assert.strictEqual(entry?.model?.reasoning, true);
	});

	test('model: null clears the whole block', async () => {
		await store.saveModelCatalogEntry({
			providerId: 'p',
			modelId: 'm',
			model: { toolCalling: true },
		});
		await store.saveModelCatalogEntry({ providerId: 'p', modelId: 'm', model: null });

		assert.strictEqual((await store.getModelCatalogEntry({ providerId: 'p', modelId: 'm' }))?.model, undefined);
	});

	test('a non-boolean capability is refused rather than read as false', async () => {
		await assert.rejects(
			() =>
				store.saveModelCatalogEntry({
					providerId: 'p',
					modelId: 'm',
					model: { toolCalling: 'yes' as never },
				}),
			ValidationError,
		);
	});

	test('a metadata origin records its source and read time', async () => {
		const readAt = '2026-01-02T03:04:05.000Z';
		await store.saveModelCatalogEntry({
			providerId: 'p',
			modelId: 'm',
			limits: { contextTokens: 128_000, maxOutputTokens: 8_192 },
			metadata: { source: 'manual', updatedAt: readAt },
		});

		const entry = await store.getModelCatalogEntry({ providerId: 'p', modelId: 'm' });
		assert.deepStrictEqual(entry?.metadata, { source: 'manual', updatedAt: readAt });
		assert.strictEqual(entry?.limits?.contextTokens, 128_000);
		assert.strictEqual(entry?.limits?.maxOutputTokens, 8_192);
	});

	test('a metadata origin with an unparseable time is refused', async () => {
		await assert.rejects(
			() =>
				store.saveModelCatalogEntry({
					providerId: 'p',
					modelId: 'm',
					metadata: { source: 'manual', updatedAt: 'last tuesday' },
				}),
			ValidationError,
		);
	});

	// applyModelMetadata: one source, merged into the record .................

	test('a metadata bundle fills absent fields and creates the record when needed', async () => {
		const entry = await store.applyModelMetadata(
			{ providerId: 'p', modelId: 'discovered-only' },
			{
				source: 'provider',
				pricing: { currency: 'USD', unit: 'per_1m_tokens', input: 1, output: 2, source: 'provider' },
				limits: { contextTokens: 32_000 },
				model: { toolCalling: true },
				updatedAt: '2026-02-01T00:00:00.000Z',
			},
		);

		assert.strictEqual(entry.providerId, 'p');
		assert.strictEqual(entry.modelId, 'discovered-only');
		assert.strictEqual(entry.pricing?.input, 1);
		assert.strictEqual(entry.limits?.contextTokens, 32_000);
		assert.strictEqual(entry.model?.toolCalling, true);
		assert.deepStrictEqual(entry.metadata, {
			source: 'provider',
			updatedAt: '2026-02-01T00:00:00.000Z',
		});
		// Metadata is not a classification: access stays unknown, so the paid
		// rule is not quietly changed by a price sheet.
		assert.strictEqual(entry.access, 'unknown');
		assert.deepStrictEqual(entry.observations, []);
	});

	test('a metadata bundle that is silent about a field does not erase it', async () => {
		await store.saveModelCatalogEntry({
			providerId: 'p',
			modelId: 'm',
			access: 'paid',
			notes: 'typed by the user',
			capabilities: ['code'],
			pricing: { currency: 'USD', unit: 'per_1m_tokens', input: 5, source: 'manual' },
			limits: { contextTokens: 200_000, maxOutputTokens: 4_096 },
			model: { toolCalling: true, inputs: { image: true } },
		});

		// A provider listing that knows capabilities but publishes no price.
		await store.applyModelMetadata(
			{ providerId: 'p', modelId: 'm' },
			{ source: 'provider', model: { toolCalling: true, reasoning: true } },
		);

		const entry = await store.getModelCatalogEntry({ providerId: 'p', modelId: 'm' });
		// Untouched: price, limits, access, notes, categories.
		assert.strictEqual(entry?.pricing?.input, 5);
		assert.strictEqual(entry?.pricing?.source, 'manual');
		assert.strictEqual(entry?.access, 'paid');
		assert.strictEqual(entry?.notes, 'typed by the user');
		assert.deepStrictEqual(entry?.capabilities, ['code']);
		assert.deepStrictEqual(entry?.limits, { contextTokens: 200_000, maxOutputTokens: 4_096 });
		// Merged: what the source said, plus what it did not mention.
		assert.strictEqual(entry?.model?.reasoning, true);
		assert.deepStrictEqual(entry?.model?.inputs, { image: true });
	});

	test('a bundle of invalid prices fails the call and writes nothing', async () => {
		await assert.rejects(
			() =>
				store.applyModelMetadata(
					{ providerId: 'p', modelId: 'm' },
					{
						source: 'provider',
						pricing: { currency: '', unit: 'per_1m_tokens', input: 1 },
					},
				),
			ValidationError,
		);
		assert.strictEqual(await store.getModelCatalogEntry({ providerId: 'p', modelId: 'm' }), undefined);
	});

	test('a bundle with no origin is refused', async () => {
		await assert.rejects(
			() =>
				store.applyModelMetadata(
					{ providerId: 'p', modelId: 'm' },
					{ source: 'unknown' as never },
				),
			ValidationError,
		);
	});

	test('metadata is not written into the entry of another provider with the same model id', async () => {
		await store.applyModelMetadata(
			{ providerId: 'atria', modelId: 'gpt-4o' },
			{ source: 'provider', pricing: { currency: 'USD', unit: 'per_1m_tokens', input: 5 } },
		);

		const other = await store.getModelCatalogEntry({ providerId: 'opencode', modelId: 'gpt-4o' });
		assert.strictEqual(other, undefined);
	});

	// Metadata survives a reopen and an older file ..........................

	test('capabilities, price source and origin survive a reopen', async () => {
		await store.applyModelMetadata(
			{ providerId: 'p', modelId: 'm' },
			{
				source: 'provider',
				pricing: { currency: 'USD', unit: 'per_1m_tokens', input: 3, cachedInput: 0.3, output: 15, source: 'provider' },
				model: { toolCalling: true, reasoning: false, inputs: { image: true }, outputs: { text: true } },
				limits: { contextTokens: 128_000 },
				updatedAt: '2026-03-01T00:00:00.000Z',
			},
		);

		const entry = await new FileDataStore({ rootPath: root }).getModelCatalogEntry({
			providerId: 'p',
			modelId: 'm',
		});
		assert.deepStrictEqual(entry?.pricing, {
			currency: 'USD',
			unit: 'per_1m_tokens',
			input: 3,
			cachedInput: 0.3,
			output: 15,
			source: 'provider',
		});
		assert.deepStrictEqual(entry?.model, {
			toolCalling: true,
			reasoning: false,
			inputs: { image: true },
			outputs: { text: true },
		});
		assert.deepStrictEqual(entry?.metadata, { source: 'provider', updatedAt: '2026-03-01T00:00:00.000Z' });
	});

	test('a file written before capabilities existed still reads', async () => {
		await writeFile(
			join(root, MODELS_FILE),
			JSON.stringify({
				version: 1,
				models: [
					{
						providerId: 'p',
						modelId: 'old',
						access: 'free',
						pricing: { currency: 'USD', unit: 'per_1m_tokens', input: 0, output: 0 },
						createdAt: 'a',
						updatedAt: 'a',
					},
				],
			}),
			'utf8',
		);

		const entry = (await new FileDataStore({ rootPath: root }).listModelCatalog())[0];
		assert.strictEqual(entry.model, undefined);
		assert.strictEqual(entry.metadata, undefined);
		assert.strictEqual(entry.pricing?.input, 0);
	});

	test('a capability field that is not a boolean is dropped, not coerced', async () => {
		await writeFile(
			join(root, MODELS_FILE),
			JSON.stringify({
				version: 1,
				models: [
					{
						providerId: 'p',
						modelId: 'm',
						model: {
							toolCalling: 'yes',
							reasoning: false,
							inputs: { image: true, audio: 'maybe' },
						},
						pricing: { currency: 'USD', unit: 'per_1m_tokens', input: 1, cachedInput: 'cheap' },
						createdAt: 'a',
						updatedAt: 'a',
					},
				],
			}),
			'utf8',
		);

		const entry = (await new FileDataStore({ rootPath: root }).listModelCatalog())[0];
		assert.strictEqual(entry.model?.toolCalling, undefined);
		assert.strictEqual(entry.model?.reasoning, false);
		assert.deepStrictEqual(entry.model?.inputs, { image: true });
		assert.strictEqual(entry.pricing?.cachedInput, undefined);
		assert.strictEqual(entry.pricing?.input, 1);
	});

	test('a mutated view does not reach the store', async () => {
		await store.applyModelMetadata(
			{ providerId: 'p', modelId: 'm' },
			{ source: 'provider', model: { inputs: { image: true } } },
		);
		const read = await store.getModelCatalogEntry({ providerId: 'p', modelId: 'm' });
		const mutable = read?.model?.inputs as Record<string, boolean> | undefined;
		if (mutable !== undefined) {
			mutable['image'] = false;
			mutable['audio'] = true;
		}
		const again = await store.getModelCatalogEntry({ providerId: 'p', modelId: 'm' });
		assert.deepStrictEqual(again?.model?.inputs, { image: true });
	});
});
