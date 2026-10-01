import * as assert from 'assert';
import {
	ProviderConfigService,
	VsCodeStateStore,
	buildProviderConfig,
	PROVIDER_CONFIG_KEY,
	type PersistedProviderConfig,
	type StateStore,
} from '../../providers/config';
import { InMemorySecretStore, providerApiKeyRef } from '../../providers/secrets';
import { ValidationError } from '../../core/errors';
import type { Provider } from '../../providers/types';

/**
 * Fake `vscode.Memento`: an in-memory map with the same two operations the
 * service uses. It records every write so a test can assert on what actually
 * reached `globalState`.
 */
class FakeMemento implements StateStore {
	readonly writes: unknown[] = [];

	constructor(private readonly values: Map<string, unknown> = new Map()) {}

	get<T>(key: string, defaultValue: T): T {
		return this.values.has(key) ? (this.values.get(key) as T) : defaultValue;
	}

	async update(key: string, value: unknown): Promise<void> {
		this.writes.push({ key, value });
		this.values.set(key, value);
	}

	/** Seeds a raw value, bypassing `update`, to simulate pre-existing state. */
	seed(key: string, value: unknown): void {
		this.values.set(key, value);
	}

	/** Reads the raw stored value, bypassing the service's narrowing. */
	raw(key: string): unknown {
		return this.values.get(key);
	}
}

/**
 * Structural stand-in for `vscode.Memento`. Declared here so the adapter can be
 * exercised without importing `vscode` into the test file.
 */
interface MementoLike {
	get<T>(key: string): T | undefined;
	get<T>(key: string, defaultValue: T): T;
	update(key: string, value: unknown): Thenable<void>;
	keys(): readonly string[];
}

/** A Memento that only ever answers the default, like an untouched install. */
class EmptyMemento implements StateStore {
	constructor(private readonly failOnUpdate = false) {}
	get<T>(key: string, defaultValue: T): T {
		return defaultValue;
	}
	async update(): Promise<void> {
		if (this.failOnUpdate) {
			throw new Error('update failed');
		}
	}
}

function config(overrides: Partial<PersistedProviderConfig> = {}): PersistedProviderConfig {
	return {
		id: 'openai',
		name: 'OpenAI',
		baseUrl: 'https://api.openai.com/v1',
		enabled: true,
		...overrides,
	};
}

suite('Foundation: provider configuration persistence', () => {
	let memento: FakeMemento;
	let service: ProviderConfigService;

	setup(() => {
		memento = new FakeMemento();
		service = new ProviderConfigService(memento);
	});

	test('an untouched install lists nothing and does not throw', () => {
		assert.deepStrictEqual(service.list(), []);
		assert.strictEqual(service.get('openai'), undefined);
	});

	test('a globalState holding a non-array value lists nothing', () => {
		memento.seed(PROVIDER_CONFIG_KEY, 'not-an-array');
		assert.deepStrictEqual(service.list(), []);
	});

	test('a globalState holding null lists nothing', () => {
		memento.seed(PROVIDER_CONFIG_KEY, null);
		assert.deepStrictEqual(service.list(), []);
	});

	test('save then list returns the stored configuration', async () => {
		await service.save(config());

		assert.strictEqual(service.list().length, 1);
		assert.strictEqual(service.get('openai')?.baseUrl, 'https://api.openai.com/v1');
		assert.strictEqual(service.get('openai')?.enabled, true);
	});

	test('save writes under the documented globalState key', async () => {
		await service.save(config());

		assert.strictEqual(memento.writes.length, 1);
		assert.strictEqual((memento.writes[0] as { key: string }).key, PROVIDER_CONFIG_KEY);
	});

	test('save persists baseUrl, apiKeyRef and enabled', async () => {
		await service.save(
			config({ apiKeyRef: 'modelhub.provider.openai.apiKey', enabled: false }),
		);

		const stored = memento.raw(PROVIDER_CONFIG_KEY) as PersistedProviderConfig[];
		assert.strictEqual(stored.length, 1);
		assert.strictEqual(stored[0].baseUrl, 'https://api.openai.com/v1');
		assert.strictEqual(stored[0].apiKeyRef, 'modelhub.provider.openai.apiKey');
		assert.strictEqual(stored[0].enabled, false);
	});

	test('the API key is never written to globalState', async () => {
		const secret = 'sk-must-not-be-persisted';
		await service.save(config({ apiKeyRef: 'modelhub.provider.openai.apiKey' }));

		assert.ok(!JSON.stringify(memento.raw(PROVIDER_CONFIG_KEY)).includes(secret));
		assert.ok(!JSON.stringify(memento.writes).includes(secret));
	});

	test('buildProviderConfig derives the reference and never carries the key', () => {
		const built = buildProviderConfig({
			id: 'openai',
			name: 'OpenAI',
			baseUrl: 'https://api.openai.com/v1',
			apiKey: 'sk-secret-value',
		});

		assert.strictEqual(built.apiKeyRef, providerApiKeyRef('openai'));
		assert.ok(!JSON.stringify(built).includes('sk-secret-value'));
	});

	test('buildProviderConfig omits the reference for a keyless provider', () => {
		const built = buildProviderConfig({
			id: 'local',
			name: 'Local',
			baseUrl: 'http://127.0.0.1:11434/v1',
		});

		assert.ok(!('apiKeyRef' in built));
		assert.strictEqual(built.enabled, true);
	});

	test('saving the same id twice replaces instead of duplicating', async () => {
		await service.save(config({ baseUrl: 'https://first.test/v1' }));
		await service.save(config({ baseUrl: 'https://second.test/v1' }));

		assert.strictEqual(service.list().length, 1);
		assert.strictEqual(service.get('openai')?.baseUrl, 'https://second.test/v1');
	});

	test('distinct ids are kept side by side', async () => {
		await service.save(config({ id: 'openai' }));
		await service.save(config({ id: 'groq', name: 'Groq', baseUrl: 'https://groq.test/v1' }));

		assert.deepStrictEqual(
			service.list().map((entry) => entry.id).sort(),
			['groq', 'openai'],
		);
	});

	test('remove deletes one entry and reports whether it existed', async () => {
		await service.save(config({ id: 'openai' }));
		await service.save(config({ id: 'groq', baseUrl: 'https://groq.test/v1' }));

		assert.strictEqual(await service.remove('openai'), true);
		assert.strictEqual(service.list().length, 1);
		assert.strictEqual(service.get('groq')?.id, 'groq');
	});

	test('removing an unknown id is a no-op that writes nothing', async () => {
		await service.save(config());
		const writesBefore = memento.writes.length;

		assert.strictEqual(await service.remove('nope'), false);
		assert.strictEqual(memento.writes.length, writesBefore);
		assert.strictEqual(service.list().length, 1);
	});

	test('removeAll empties the list', async () => {
		await service.save(config({ id: 'openai' }));
		await service.save(config({ id: 'groq' }));

		await service.removeAll();

		assert.deepStrictEqual(service.list(), []);
	});

	test('a saved configuration survives a new service over the same state', async () => {
		await service.save(config({ apiKeyRef: 'modelhub.provider.openai.apiKey' }));

		// Simulates a window reload: fresh service, same globalState.
		const reloaded = new ProviderConfigService(memento);

		const restored = reloaded.list();
		assert.strictEqual(restored.length, 1);
		assert.strictEqual(restored[0].baseUrl, 'https://api.openai.com/v1');
		assert.strictEqual(restored[0].apiKeyRef, 'modelhub.provider.openai.apiKey');
	});

	test('save rejects an empty id', async () => {
		await assert.rejects(() => service.save(config({ id: '  ' })), ValidationError);
	});

	test('save rejects an empty baseUrl', async () => {
		await assert.rejects(
			() => service.save(config({ baseUrl: '   ' })),
			ValidationError,
		);
	});

	test('a rejected save leaves the stored list untouched', async () => {
		await service.save(config());

		await assert.rejects(() => service.save(config({ id: 'groq', baseUrl: '' })), ValidationError);

		assert.strictEqual(service.list().length, 1);
		assert.strictEqual(service.get('openai')?.id, 'openai');
	});

	test('a missing name falls back to the id', async () => {
		await service.save(config({ name: '' }));

		assert.strictEqual(service.get('openai')?.name, 'openai');
	});

	test('restoreAll on an empty store returns an empty list and registers nothing', () => {
		const registered: Provider[] = [];

		const restored = service.restoreAll(new InMemorySecretStore(), (provider) => {
			registered.push(provider);
			return () => undefined;
		});

		assert.deepStrictEqual(restored, []);
		assert.deepStrictEqual(registered, []);
	});

	test('restoreAll rebuilds live providers from stored configuration', async () => {
		await service.save(config({ id: 'openai', apiKeyRef: providerApiKeyRef('openai') }));
		await service.save(
			config({ id: 'local', name: 'Local', baseUrl: 'http://127.0.0.1:11434/v1' }),
		);

		const registered: Provider[] = [];
		const restored = new ProviderConfigService(memento).restoreAll(
			new InMemorySecretStore(),
			(provider) => {
				registered.push(provider);
				return () => undefined;
			},
		);

		assert.strictEqual(restored.length, 2);
		assert.strictEqual(registered.length, 2);
		assert.deepStrictEqual(
			restored.map((provider) => provider.descriptor.id).sort(),
			['local', 'openai'],
		);
		assert.strictEqual(
			restored.find((provider) => provider.descriptor.id === 'openai')?.descriptor.configuration
				.apiKeyRef,
			providerApiKeyRef('openai'),
		);
	});

	test('a restored provider exposes the persisted baseUrl', async () => {
		await service.save(config({ baseUrl: 'https://persisted.test/v1' }));

		const [provider] = service.restoreAll(
			new InMemorySecretStore(),
			() => () => undefined,
		);

		assert.strictEqual(provider.descriptor.configuration.baseUrl, 'https://persisted.test/v1');
	});

	test('a restored provider starts unconfigured when a key is expected', async () => {
		await service.save(config({ apiKeyRef: providerApiKeyRef('openai') }));

		const [provider] = service.restoreAll(new InMemorySecretStore(), () => () => undefined);

		assert.strictEqual(provider.descriptor.status, 'unconfigured');
	});

	test('a keyless restored provider starts configured', async () => {
		await service.save(config({ id: 'local' }));

		const [provider] = service.restoreAll(new InMemorySecretStore(), () => () => undefined);

		assert.strictEqual(provider.descriptor.status, 'configured');
	});

	test('restoreAll skips malformed records instead of failing entirely', () => {
		memento.seed(PROVIDER_CONFIG_KEY, [
			{ id: 'good', name: 'Good', baseUrl: 'https://good.test/v1', enabled: true },
			{ name: 'No Id', baseUrl: 'https://noid.test/v1' },
			'not-an-object',
		]);

		const restored = service.restoreAll(new InMemorySecretStore(), () => () => undefined);

		assert.deepStrictEqual(
			restored.map((provider) => provider.descriptor.id),
			['good'],
		);
	});

	test('VsCodeStateStore delegates get and update to the Memento', async () => {
		const fake = new FakeMemento();
		const store = new VsCodeStateStore(fake as unknown as MementoLike);

		await store.update('a-key', { hello: 'world' });

		assert.deepStrictEqual(fake.raw('a-key'), { hello: 'world' });
		assert.deepStrictEqual(store.get('a-key', null), { hello: 'world' });
	});

	test('VsCodeStateStore returns the default for an absent key', () => {
		const store = new VsCodeStateStore(new FakeMemento() as unknown as MementoLike);

		assert.deepStrictEqual(store.get('missing', { fallback: true }), { fallback: true });
	});

	test('a read-only state store does not break list()', () => {
		const readOnly = new ProviderConfigService(new EmptyMemento());

		assert.deepStrictEqual(readOnly.list(), []);
	});

	test('save surfaces a storage failure rather than swallowing it', async () => {
		const failing = new ProviderConfigService(new EmptyMemento(true));

		await assert.rejects(() => failing.save(config()), /update failed/);
	});
});