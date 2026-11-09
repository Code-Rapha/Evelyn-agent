/**
 * The model orchestration policy: rotation within one provider only, on real
 * catalog data, with no silent provider switch and no loops back to a model
 * that just failed.
 *
 * Pure functions, no network: the catalog the tests pass in is exactly what
 * `listAvailableModels` would return.
 */
import * as assert from 'assert';

import { pickNextModel } from '../desktop/modelOrchestrator';

const CATALOG = [
	{ providerId: 'local', model: 'llama3' },
	{ providerId: 'local', model: 'qwen' },
	{ providerId: 'local', model: 'mistral' },
	{ providerId: 'other', model: 'gpt-x' },
];

suite('Desktop: model orchestration', () => {
	test('rotates within the same provider, in server order', () => {
		const next = pickNextModel({
			available: CATALOG,
			providerId: 'local',
			current: 'llama3',
		});
		assert.deepStrictEqual(next, { providerId: 'local', model: 'qwen' });
	});

	test('never leaves the provider, even when another one has models', () => {
		const next = pickNextModel({
			available: CATALOG,
			providerId: 'local',
			current: 'mistral',
		});
		// Every local model but the current one already appeared before; the
		// caller marks those as failed, so only exhaustion is left.
		const wrapped = pickNextModel({
			available: CATALOG,
			providerId: 'local',
			current: 'mistral',
			failed: ['llama3', 'qwen'],
		});
		assert.strictEqual(next?.providerId, 'local');
		assert.strictEqual(wrapped, undefined, 'an exhausted provider ends the rotation');
	});

	test('a model that just failed is not suggested again', () => {
		const next = pickNextModel({
			available: CATALOG,
			providerId: 'local',
			current: 'llama3',
			failed: ['qwen'],
		});
		assert.deepStrictEqual(next, { providerId: 'local', model: 'mistral' });
	});

	test('without a current model, the provider default is offered', () => {
		const next = pickNextModel({ available: CATALOG, providerId: 'local' });
		assert.deepStrictEqual(next, { providerId: 'local', model: 'llama3' });
	});

	test('an unknown provider yields nothing at all', () => {
		assert.strictEqual(pickNextModel({ available: CATALOG, providerId: 'ghost' }), undefined);
	});

	test('the same model listed twice is skipped once, then suggested once', () => {
		const doubled = [
			{ providerId: 'p', model: 'm1' },
			{ providerId: 'p', model: 'm1' },
			{ providerId: 'p', model: 'm2' },
		];
		const first = pickNextModel({ available: doubled, providerId: 'p', current: 'm0' });
		assert.deepStrictEqual(first, { providerId: 'p', model: 'm1' });
		const second = pickNextModel({
			available: doubled,
			providerId: 'p',
			current: 'm0',
			failed: ['m1'],
		});
		assert.deepStrictEqual(second, { providerId: 'p', model: 'm2' });
	});
});
