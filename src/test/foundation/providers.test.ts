import * as assert from 'assert';
import { ProviderRegistry } from '../../providers/registry';
import type { ModelInfo, Provider } from '../../providers/types';
import { ProviderError } from '../../core/errors';

function createProvider(id: string, name = id): Provider {
	const models: readonly ModelInfo[] = [{ id: `${id}-model`, name: `${name} Model` }];
	return {
		descriptor: {
			id,
			name,
			type: 'predefined',
			status: 'unconfigured',
			configuration: { enabled: true },
			capabilities: ['chat', 'streaming'],
			models: models,
		},
		listModels: async () => models,
	};
}

suite('Foundation: provider registry', () => {
	let registry: ProviderRegistry;

	setup(() => {
		registry = new ProviderRegistry();
	});

	teardown(() => {
		registry.dispose();
	});

	test('registers and resolves providers (predefined and custom)', () => {
		const unregister = registry.register(createProvider('openrouter'));
		registry.register({ ...createProvider('custom'), descriptor: { ...createProvider('custom').descriptor, type: 'custom-openai-compatible' } });

		assert.strictEqual(registry.size, 2);
		assert.strictEqual(registry.get('openrouter')?.descriptor.id, 'openrouter');
		assert.strictEqual(
			registry.get('custom')?.descriptor.type,
			'custom-openai-compatible',
		);
		assert.strictEqual(typeof unregister, 'function');
	});

	test('rejects duplicate provider ids with a ProviderError', () => {
		registry.register(createProvider('ollama'));
		assert.throws(() => registry.register(createProvider('ollama')), (error: unknown) => {
			assert.ok(error instanceof ProviderError);
			assert.strictEqual(error.category, 'provider');
			return true;
		});
	});

	test('unregister removes the provider and fires change events', () => {
		let changes = 0;
		const unsubscribe = registry.onDidChangeProviders(() => {
			changes += 1;
		});

		const unregister = registry.register(createProvider('groq'));
		assert.strictEqual(changes, 1);

		unregister();
		assert.strictEqual(changes, 2);
		assert.strictEqual(registry.size, 0);

		unsubscribe();
		registry.register(createProvider('together'));
		assert.strictEqual(changes, 2);
	});

	test('list() sorts by name and exposes descriptors', () => {
		registry.register(createProvider('zai', 'Z.AI'));
		registry.register(createProvider('anthropic-like', 'Alpha'));

		const descriptors = registry.listDescriptors();
		assert.deepStrictEqual(
			descriptors.map((descriptor) => descriptor.name),
			['Alpha', 'Z.AI'],
		);
	});

	test('getRequired throws a ProviderError for unknown providers', () => {
		assert.throws(() => registry.getRequired('nope'), ProviderError);
	});
});
