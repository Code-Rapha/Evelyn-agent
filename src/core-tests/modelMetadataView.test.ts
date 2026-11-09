/**
 * The readable view of a model's metadata.
 *
 * These tests are about *reading*, not storage: every entry is built in memory
 * from the catalog types, so the assertions are about what a consumer sees and
 * about the three rules the view exists to state once — absent is not zero,
 * absent is not `false`, and two prices in different units are not comparable
 * numbers.
 */
import * as assert from 'assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileDataStore } from '../adapters/local/fileDataStore';
import {
	describeModel,
	describeModelById,
	describeModels,
	modelMetadataKey,
} from '../core/providers/catalog/view';
import type { ModelCatalogEntry, SaveModelCatalogInput } from '../core/storage/types/modelCatalog';

const AT = '2026-01-01T00:00:00.000Z';

/** A catalog entry with only the fields the test cares about. */
function entry(overrides: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry {
	return {
		providerId: 'atria',
		modelId: 'model-a',
		access: 'unknown',
		observations: [],
		createdAt: AT,
		updatedAt: AT,
		...overrides,
	};
}

suite('Catalog: the metadata view', () => {
	// Prices: known, unknown, free ..........................................

	test('a known price is reported per its declared unit, with its source', () => {
		const view = describeModel(
			entry({
				pricing: {
					currency: 'USD',
					unit: 'per_1m_tokens',
					input: 3,
					output: 15,
					source: 'manual',
				},
			}),
		);

		assert.strictEqual(view.cost.known, true);
		assert.strictEqual(view.cost.free, false);
		assert.strictEqual(view.cost.currency, 'USD');
		assert.strictEqual(view.cost.unit, 'per_1m_tokens');
		assert.deepStrictEqual(view.cost.input, {
			state: 'known',
			price: { amount: 3, source: 'manual' },
		});
		assert.deepStrictEqual(view.cost.output, {
			state: 'known',
			price: { amount: 15, source: 'manual' },
		});
		assert.strictEqual(view.cost.cachedInput, undefined);
	});

	test('a cached-input price is reported separately, and absent when not differentiated', () => {
		const differentiated = describeModel(
			entry({
				pricing: {
					currency: 'USD',
					unit: 'per_1m_tokens',
					input: 3,
					cachedInput: 0.3,
					source: 'provider',
				},
			}),
		);
		assert.deepStrictEqual(differentiated.cost.cachedInput, { amount: 0.3, source: 'provider' });

		const plain = describeModel(
			entry({ pricing: { currency: 'USD', unit: 'per_1m_tokens', input: 3 } }),
		);
		assert.strictEqual(plain.cost.cachedInput, undefined, 'never copied from the input rate');
	});

	test('an absent price is unknown, not zero and not free', () => {
		const view = describeModel(entry());

		assert.deepStrictEqual(view.cost.input, { state: 'unknown' });
		assert.deepStrictEqual(view.cost.output, { state: 'unknown' });
		assert.strictEqual(view.cost.known, false);
		assert.strictEqual(view.cost.free, false);
		assert.strictEqual(view.cost.currency, undefined);
		assert.strictEqual(view.cost.unit, undefined);
	});

	test('an explicitly free model says so, in both directions', () => {
		const view = describeModel(
			entry({ pricing: { currency: 'BRL', unit: 'per_1k_tokens', input: 0, output: 0, source: 'manual' } }),
		);

		assert.strictEqual(view.cost.free, true);
		assert.strictEqual(view.cost.known, true);
		assert.deepStrictEqual(view.cost.input, { state: 'free', source: 'manual' });
		assert.deepStrictEqual(view.cost.output, { state: 'free', source: 'manual' });
		assert.strictEqual(view.cost.currency, 'BRL');
	});

	test('a zero input with an unknown output is not a free model', () => {
		const view = describeModel(entry({ pricing: { currency: 'USD', unit: 'per_1m_tokens', input: 0 } }));

		assert.deepStrictEqual(view.cost.input, { state: 'free', source: 'unknown' });
		assert.deepStrictEqual(view.cost.output, { state: 'unknown' });
		assert.strictEqual(view.cost.free, false, 'one free side says nothing about the other');
		assert.strictEqual(view.cost.known, true);
	});

	test('an unattributed price carries source unknown rather than a guessed one', () => {
		const view = describeModel(entry({ pricing: { currency: 'USD', unit: 'per_1k_tokens', input: 1 } }));

		const input = view.cost.input;
		assert.strictEqual(input.state, 'known');
		if (input.state === 'known') {
			assert.strictEqual(input.price.source, 'unknown');
		}
	});

	test('a negative price in a hand-edited entry reads as unknown', () => {
		// The store refuses it on write; this is the read side of the same rule,
		// for a file that was edited while the app was closed.
		const view = describeModel(entry({ pricing: { currency: 'USD', unit: 'per_1m_tokens', input: -1 } }));

		assert.deepStrictEqual(view.cost.input, { state: 'unknown' });
		assert.strictEqual(view.cost.free, false);
	});

	test('a model is never priced from its name', () => {
		const view = describeModel(entry({ modelId: 'tiny-free-model:latest' }));

		assert.strictEqual(view.cost.known, false);
		assert.strictEqual(view.cost.free, false);
		assert.strictEqual(view.capabilities.toolCalling, 'unknown');
	});

	// Capabilities: true, false, unknown ....................................

	test('capabilities report supported, unsupported and unknown distinctly', () => {
		const view = describeModel(
			entry({
				model: {
					toolCalling: true,
					structuredOutput: false,
					inputs: { text: true, image: false },
					outputs: { text: true },
				},
			}),
		);

		assert.strictEqual(view.capabilities.toolCalling, 'supported');
		assert.strictEqual(view.capabilities.structuredOutput, 'unsupported');
		assert.strictEqual(view.capabilities.reasoning, 'unknown', 'never stated');
		assert.deepStrictEqual(view.capabilities.inputs, { text: 'supported', image: 'unsupported' });
		assert.deepStrictEqual(view.capabilities.outputs, { text: 'supported' });
		assert.strictEqual(view.capabilities.inputs['audio'], undefined, 'not stated = absent, not unsupported');
	});

	test('a model with no capability block has every capability unknown', () => {
		const view = describeModel(entry());

		assert.strictEqual(view.capabilities.toolCalling, 'unknown');
		assert.strictEqual(view.capabilities.structuredOutput, 'unknown');
		assert.strictEqual(view.capabilities.reasoning, 'unknown');
		assert.deepStrictEqual(view.capabilities.inputs, {});
		assert.deepStrictEqual(view.capabilities.outputs, {});
	});

	// Limits ...............................................................

	test('the context window is never reported as the output budget', () => {
		const view = describeModel(entry({ limits: { contextTokens: 128_000 } }));

		assert.strictEqual(view.capabilities.contextTokens, 128_000);
		assert.strictEqual(
			view.capabilities.maxOutputTokens,
			undefined,
			'a context window is an upper bound on the answer, not its budget',
		);
	});

	test('context and output limits are reported independently when both are known', () => {
		const view = describeModel(entry({ limits: { contextTokens: 200_000, maxOutputTokens: 8_192 } }));

		assert.strictEqual(view.capabilities.contextTokens, 200_000);
		assert.strictEqual(view.capabilities.maxOutputTokens, 8_192);
	});

	test('a zero limit is a stated zero, not an absent one', () => {
		const view = describeModel(entry({ limits: { contextTokens: 0 } }));

		assert.strictEqual(view.capabilities.contextTokens, 0);
	});

	// Identity .............................................................

	test('the same model id under two providers yields two different views', () => {
		const views = describeModels([
			entry({
				providerId: 'atria',
				modelId: 'gpt-4o',
				access: 'paid',
				pricing: { currency: 'USD', unit: 'per_1m_tokens', input: 5, output: 15 },
			}),
			entry({
				providerId: 'opencode',
				modelId: 'gpt-4o',
				access: 'free',
				pricing: { currency: 'USD', unit: 'per_1m_tokens', input: 0, output: 0 },
			}),
		]);

		assert.strictEqual(views.size, 2);
		const atria = views.get(modelMetadataKey({ providerId: 'atria', modelId: 'gpt-4o' }));
		const opencode = views.get(modelMetadataKey({ providerId: 'opencode', modelId: 'gpt-4o' }));
		assert.strictEqual(atria?.access, 'paid');
		assert.strictEqual(atria?.cost.free, false);
		assert.strictEqual(opencode?.access, 'free');
		assert.strictEqual(opencode?.cost.free, true);
	});

	test('an id containing the key delimiter does not collide with another pair', () => {
		// `:` is the obvious delimiter, and a model id is whatever the server
		// called it, so the view keys by a pair rather than by a joined string.
		const views = describeModels([
			entry({ providerId: 'a', modelId: 'b:c' }),
			entry({ providerId: 'a:b', modelId: 'c' }),
		]);

		assert.strictEqual(views.size, 2);
		assert.strictEqual(views.get(modelMetadataKey({ providerId: 'a', modelId: 'b:c' }))?.modelId, 'b:c');
		assert.strictEqual(views.get(modelMetadataKey({ providerId: 'a:b', modelId: 'c' }))?.modelId, 'c');
	});

	test('the model id is preserved exactly, case and punctuation included', () => {
		const view = describeModel(entry({ modelId: 'org/Modelo-Exato:2' }));

		assert.strictEqual(view.modelId, 'org/Modelo-Exato:2');
	});

	// Origin and "described" ...............................................

	test('the origin is reported, and unknown when none was recorded', () => {
		const attributed = describeModel(
			entry({ metadata: { source: 'provider', updatedAt: '2026-02-01T00:00:00.000Z' } }),
		);
		assert.strictEqual(attributed.source, 'provider');
		assert.strictEqual(attributed.sourceUpdatedAt, '2026-02-01T00:00:00.000Z');

		const unattributed = describeModel(entry());
		assert.strictEqual(unattributed.source, 'unknown');
		assert.strictEqual(unattributed.sourceUpdatedAt, undefined);
	});

	test('a record that only exists has nothing described', () => {
		const view = describeModel(entry());

		assert.strictEqual(view.described, false);
		assert.strictEqual(view.cost.known, false);
	});

	test('task categories are kept apart from structural capabilities', () => {
		const view = describeModel(entry({ capabilities: ['code', 'long documents'], model: { toolCalling: true } }));

		assert.deepStrictEqual(view.categories, ['code', 'long documents']);
		assert.strictEqual(view.capabilities.toolCalling, 'supported');
	});

	// Paired with the store ................................................

	test('an entry nobody recorded reads as undefined, not as an invented view', async () => {
		const root = await mkdtemp(join(tmpdir(), 'seshyina-view-'));
		try {
			const store = new FileDataStore({ rootPath: root });
			assert.strictEqual(
				await describeModelById(store, { providerId: 'p', modelId: 'ghost' }),
				undefined,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test('a discovered model with no metadata is unknown, and a typed one is known', async () => {
		const root = await mkdtemp(join(tmpdir(), 'seshyina-view-'));
		try {
			const store = new FileDataStore({ rootPath: root });
			// A model the endpoint listed and nobody described: it may not even
			// have a record, and if it has one it says nothing.
			await store.recordModelObservation({ providerId: 'p', modelId: 'discovered' }, { totalMs: 100 });
			const declared: SaveModelCatalogInput = {
				providerId: 'p',
				modelId: 'declared',
				access: 'paid',
				pricing: { currency: 'USD', unit: 'per_1m_tokens', input: 1, output: 2, source: 'manual' },
				limits: { contextTokens: 8_192 },
			};
			await store.saveModelCatalogEntry(declared);

			const discovered = await describeModelById(store, { providerId: 'p', modelId: 'discovered' });
			const manual = await describeModelById(store, { providerId: 'p', modelId: 'declared' });

			assert.strictEqual(discovered?.cost.known, false);
			assert.strictEqual(discovered?.cost.free, false);
			assert.strictEqual(discovered?.capabilities.toolCalling, 'unknown');
			assert.strictEqual(discovered?.source, 'unknown');

			assert.strictEqual(manual?.access, 'paid');
			assert.strictEqual(manual?.cost.known, true);
			assert.strictEqual(manual?.capabilities.contextTokens, 8_192);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
