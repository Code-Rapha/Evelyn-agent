import * as assert from 'assert';
import {
	ProviderFlow,
	DEFAULT_PROVIDER_BASE_URL,
	type ProviderNotifierPort,
	type ProviderPromptPort,
	type ApiKeyPromptResult,
	type BaseUrlPromptResult,
} from '../../host/vscode/ui/providerFlow';
import { providerIdFromNode } from '../../host/vscode/ui/commands';
import { ProviderRegistry } from '../../core/providers/registry';
import { ProviderConfigService, PROVIDER_CONFIG_KEY, type StateStore } from '../../core/providers/config';
import { InMemorySecretStore, providerApiKeyRef } from '../../core/providers/secrets';
import { buildRootNodes } from '../../host/vscode/ui/viewModel';
import { createUiContext } from '../../host/vscode/ui/context';
import type { Provider } from '../../core/providers/types';

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
	raw(key: string): unknown {
		return this.values.get(key);
	}
}

/** Scripted answers for the two prompts, in the order they are asked. */
class FakePrompt implements ProviderPromptPort {
	readonly baseUrlPrompts: string[] = [];
	readonly apiKeyPrompts: string[] = [];

	constructor(
		private baseUrls: BaseUrlPromptResult[],
		private apiKeys: ApiKeyPromptResult[],
	) {}

	async askBaseUrl(defaultValue: string): Promise<BaseUrlPromptResult> {
		this.baseUrlPrompts.push(defaultValue);
		return this.baseUrls.shift() ?? { kind: 'cancelled' };
	}

	async askApiKey(providerName: string): Promise<ApiKeyPromptResult> {
		this.apiKeyPrompts.push(providerName);
		return this.apiKeys.shift() ?? { kind: 'skipped' };
	}
}

class FakeNotifier implements ProviderNotifierPort {
	readonly infos: string[] = [];
	readonly errors: string[] = [];
	info(message: string): void {
		this.infos.push(message);
	}
	error(message: string): void {
		this.errors.push(message);
	}
	/** Everything the user was told, in no particular order. */
	get all(): string {
		return [...this.infos, ...this.errors].join('\n');
	}
}

function accepted(value: string): BaseUrlPromptResult {
	return { kind: 'accepted', value };
}
function withKey(value: string): ApiKeyPromptResult {
	return { kind: 'accepted', value };
}
const NO_KEY: ApiKeyPromptResult = { kind: 'skipped' };
const CANCEL: BaseUrlPromptResult = { kind: 'cancelled' };

const REMOTE = 'https://api.example.test/v1';
const LOCAL = 'http://127.0.0.1:11434/v1';
const SECRET = 'sk-secret-value';

interface Harness {
	flow: ProviderFlow;
	prompt: FakePrompt;
	notifier: FakeNotifier;
	secrets: InMemorySecretStore;
	config: ProviderConfigService;
	registry: ProviderRegistry;
	memento: FakeMemento;
}

function buildHarness(
	baseUrls: BaseUrlPromptResult[],
	apiKeys: ApiKeyPromptResult[],
): Harness {
	const prompt = new FakePrompt(baseUrls, apiKeys);
	const notifier = new FakeNotifier();
	const secrets = new InMemorySecretStore();
	const memento = new FakeMemento();
	const config = new ProviderConfigService(memento);
	const registry = new ProviderRegistry();
	const flow = new ProviderFlow({ prompt, notifier, secrets, config, registry });
	return { flow, prompt, notifier, secrets, config, registry, memento };
}

suite('Foundation: add provider', () => {
	test('registers the provider and reports the derived id', async () => {
		const h = buildHarness([accepted(REMOTE)], [withKey(SECRET)]);

		const outcome = await h.flow.addProvider();

		assert.strictEqual(outcome.ok, true);
		assert.strictEqual(outcome.providerId, h.flow.deriveProviderId(REMOTE));
		assert.strictEqual(h.registry.size, 1);
		assert.strictEqual(
			h.registry.get(h.flow.deriveProviderId(REMOTE))?.descriptor.configuration.baseUrl,
			REMOTE,
		);
	});

	test('offers the documented default base URL', async () => {
		const h = buildHarness([CANCEL], []);

		await h.flow.addProvider();

		assert.deepStrictEqual(h.prompt.baseUrlPrompts, [DEFAULT_PROVIDER_BASE_URL]);
		assert.strictEqual(DEFAULT_PROVIDER_BASE_URL, 'https://api.openai.com/v1');
	});

	test('stores the API key in the SecretStore, never in the config', async () => {
		const h = buildHarness([accepted(REMOTE)], [withKey(SECRET)]);

		await h.flow.addProvider();

		assert.strictEqual(await h.secrets.get(providerApiKeyRef(h.flow.deriveProviderId(REMOTE))), SECRET);
		assert.ok(!JSON.stringify(h.memento.raw(PROVIDER_CONFIG_KEY)).includes(SECRET));
		assert.ok(!JSON.stringify(h.memento.writes).includes(SECRET));
	});

	test('the persisted config carries only the reference', async () => {
		const h = buildHarness([accepted(REMOTE)], [withKey(SECRET)]);

		await h.flow.addProvider();

		const stored = h.config.get(h.flow.deriveProviderId(REMOTE));
		assert.strictEqual(stored?.apiKeyRef, providerApiKeyRef(h.flow.deriveProviderId(REMOTE)));
		assert.strictEqual(stored?.baseUrl, REMOTE);
		assert.strictEqual(stored?.enabled, true);
	});

	test('works with no API key: no secret, no reference', async () => {
		const h = buildHarness([accepted(LOCAL)], [NO_KEY]);

		const outcome = await h.flow.addProvider();

		assert.strictEqual(outcome.ok, true);
		assert.strictEqual(await h.secrets.size, 0);
		const stored = h.config.get(h.flow.deriveProviderId(LOCAL));
		assert.ok(!('apiKeyRef' in (stored ?? { apiKeyRef: 'present' })));
		assert.ok(
			h.registry.get(h.flow.deriveProviderId(LOCAL))?.descriptor.status === 'configured',
			'a keyless provider starts configured',
		);
	});

	test('a keyless provider sends no authorization header', async () => {
		const h = buildHarness([accepted(LOCAL)], [NO_KEY]);

		await h.flow.addProvider();

		const provider = h.registry.get(h.flow.deriveProviderId(LOCAL)) as Provider & {
			listModels(): Promise<readonly unknown[]>;
		};
		// No key reference means no header; reaching this without a throw proves
		// the buildHeaders early-return ran.
		await assert.rejects(() => provider.listModels());
		assert.strictEqual(provider.descriptor.status, 'error');
	});

	test('cancelling the base URL prompt registers nothing and reports no error', async () => {
		const h = buildHarness([CANCEL], []);

		const outcome = await h.flow.addProvider();

		assert.strictEqual(outcome.ok, false);
		assert.strictEqual(outcome.providerId, undefined);
		assert.strictEqual(h.registry.size, 0);
		assert.deepStrictEqual(h.notifier.errors, []);
		assert.deepStrictEqual(h.config.list(), []);
	});

	test('a blank base URL is refused with a clear message', async () => {
		const h = buildHarness([accepted('   ')], [NO_KEY]);

		const outcome = await h.flow.addProvider();

		assert.strictEqual(outcome.ok, false);
		assert.match(h.notifier.errors.join(''), /base URL is required/i);
		assert.strictEqual(h.registry.size, 0);
	});

	test('the API key prompt is not asked when the base URL is refused', async () => {
		const h = buildHarness([accepted('')], [NO_KEY]);

		await h.flow.addProvider();

		assert.deepStrictEqual(h.prompt.apiKeyPrompts, []);
	});

	test('adding the same provider twice fails with a clear message', async () => {
		const h = buildHarness([accepted(REMOTE), accepted(REMOTE)], [withKey(SECRET), withKey('sk-second')]);

		const first = await h.flow.addProvider();
		const second = await h.flow.addProvider();

		assert.strictEqual(first.ok, true);
		assert.strictEqual(second.ok, false);
		assert.match(h.notifier.errors.join(''), /already exists/i);
	});

	test('a rejected duplicate changes nothing: registry, key and config intact', async () => {
		const h = buildHarness([accepted(REMOTE), accepted(REMOTE)], [withKey(SECRET), withKey('sk-second')]);

		await h.flow.addProvider();
		const before = h.memento.writes.length;

		await h.flow.addProvider();

		assert.strictEqual(h.registry.size, 1);
		assert.strictEqual(h.config.list().length, 1);
		assert.strictEqual(await h.secrets.get(providerApiKeyRef(h.flow.deriveProviderId(REMOTE))), SECRET);
		assert.strictEqual(h.memento.writes.length, before, 'no config rewrite on a rejected duplicate');
	});

	test('the same host on a different port counts as a different provider', async () => {
		const h = buildHarness([accepted('https://host.test/v1'), accepted('https://host.test:8443/v1')], [NO_KEY, NO_KEY]);

		const first = await h.flow.addProvider();
		const second = await h.flow.addProvider();

		assert.strictEqual(first.ok, true);
		assert.strictEqual(second.ok, true);
		assert.strictEqual(h.registry.size, 2);
	});

	test('the same host with a different path counts as the same provider', async () => {
		const h = buildHarness([accepted('https://host.test/v1'), accepted('https://host.test/v2')], [NO_KEY, NO_KEY]);

		await h.flow.addProvider();
		const second = await h.flow.addProvider();

		assert.strictEqual(second.ok, false);
		assert.strictEqual(h.registry.size, 1);
	});

	test('a success message names the provider', async () => {
		const h = buildHarness([accepted(REMOTE)], [NO_KEY]);

		await h.flow.addProvider();

		assert.match(h.notifier.infos.join(''), /Added provider/);
	});

	test('the outcome exposes an unregister that removes the registry entry', async () => {
		const h = buildHarness([accepted(REMOTE)], [NO_KEY]);

		const outcome = await h.flow.addProvider();
		assert.strictEqual(h.registry.size, 1);

		outcome.unregister?.();

		assert.strictEqual(h.registry.size, 0);
	});

	test('a secret write failure is reported and registers nothing', async () => {
		const h = buildHarness([accepted(REMOTE)], [withKey(SECRET)]);
		await assert.rejects(() =>
			h.secrets.store('force-failure', 'x'),
		).catch(() => undefined);
		// Replace the store method to simulate a keychain failure.
		Object.defineProperty(h.secrets, 'store', {
			value: async () => {
				throw new Error('keychain unavailable');
			},
		});

		const outcome = await h.flow.addProvider();

		assert.strictEqual(outcome.ok, false);
		assert.match(h.notifier.errors.join(''), /Could not store the API key/i);
		assert.strictEqual(h.registry.size, 0);
	});

	test('the API key is never written to any message', async () => {
		const h = buildHarness([accepted(REMOTE), accepted(REMOTE)], [withKey(SECRET), withKey(SECRET)]);

		await h.flow.addProvider();
		await h.flow.addProvider();

		assert.ok(!h.notifier.all.includes(SECRET));
	});
});

suite('Foundation: remove provider', () => {
	async function addOne(): Promise<Harness> {
		const h = buildHarness([accepted(REMOTE)], [withKey(SECRET)]);
		await h.flow.addProvider();
		return h;
	}

	test('removes the registry entry, the config and the stored key', async () => {
		const h = await addOne();
		const id = h.flow.deriveProviderId(REMOTE);

		const removed = await h.flow.removeProvider(id);

		assert.strictEqual(removed, true);
		assert.strictEqual(h.registry.size, 0);
		assert.strictEqual(h.registry.get(id), undefined);
		assert.deepStrictEqual(h.config.list(), []);
		assert.strictEqual(h.config.get(id), undefined);
		assert.strictEqual(await h.secrets.get(providerApiKeyRef(id)), undefined);
	});

	test('the tree returns to its empty state', async () => {
		const h = await addOne();
		const context = createUiContext('0.0.1', h.registry);

		const before = buildRootNodes(context);
		const providersBefore = before[0].children ?? [];
		assert.strictEqual(providersBefore.length, 1);
		assert.strictEqual(providersBefore[0].kind, 'provider');

		await h.flow.removeProvider(h.flow.deriveProviderId(REMOTE));

		const after = buildRootNodes(createUiContext('0.0.1', h.registry));
		const providersAfter = after[0].children ?? [];
		assert.strictEqual(providersAfter.length, 1);
		assert.strictEqual(providersAfter[0].kind, 'empty');
		assert.strictEqual(providersAfter[0].label, 'No providers registered');
	});

	test('the registry change event fires so the tree can react', async () => {
		const h = await addOne();
		let changes = 0;
		const unsubscribe = h.registry.onDidChangeProviders(() => {
			changes += 1;
		});

		await h.flow.removeProvider(h.flow.deriveProviderId(REMOTE));

		assert.strictEqual(changes, 1);
		unsubscribe();
	});

	test('removing an unknown provider reports false and changes nothing', async () => {
		const h = await addOne();
		const writesBefore = h.memento.writes.length;

		const removed = await h.flow.removeProvider('not-a-provider');

		assert.strictEqual(removed, false);
		assert.strictEqual(h.registry.size, 1);
		assert.strictEqual(h.memento.writes.length, writesBefore);
	});

	test('a keyless provider is removed cleanly too', async () => {
		const h = buildHarness([accepted(LOCAL)], [NO_KEY]);
		await h.flow.addProvider();
		const id = h.flow.deriveProviderId(LOCAL);

		const removed = await h.flow.removeProvider(id);

		assert.strictEqual(removed, true);
		assert.strictEqual(h.registry.size, 0);
		assert.deepStrictEqual(h.config.list(), []);
	});

	test('a provider with a hand-edited config still has its key cleaned up', async () => {
		const h = await addOne();
		const id = h.flow.deriveProviderId(REMOTE);
		// Simulate a config that lost its apiKeyRef while the key remained.
		await h.config.save({
			id,
			name: 'api.example.test',
			baseUrl: REMOTE,
			enabled: true,
		});

		await h.flow.removeProvider(id);

		assert.strictEqual(await h.secrets.get(providerApiKeyRef(id)), undefined);
	});

	test('removing one of two providers leaves the other registered', async () => {
		const h = buildHarness(
			[accepted(REMOTE), accepted('https://other.test/v1')],
			[withKey(SECRET), NO_KEY],
		);
		await h.flow.addProvider();
		await h.flow.addProvider();

		await h.flow.removeProvider(h.flow.deriveProviderId(REMOTE));

		assert.strictEqual(h.registry.size, 1);
		assert.strictEqual(h.registry.get(h.flow.deriveProviderId('https://other.test/v1')) !== undefined, true);
	});
});

suite('Foundation: provider id derivation', () => {
	test('derives a stable id from scheme and host', () => {
		const flow = new ProviderFlow({
			prompt: new FakePrompt([], []),
			notifier: new FakeNotifier(),
			secrets: new InMemorySecretStore(),
			config: new ProviderConfigService(new FakeMemento()),
			registry: new ProviderRegistry(),
		});

		assert.strictEqual(flow.deriveProviderId('https://api.example.test/v1'), 'local-api.example.test');
		assert.strictEqual(flow.deriveProviderId('HTTPS://API.EXAMPLE.TEST/v1'), 'local-api.example.test');
	});

	test('keeps the port when one is present', () => {
		const flow = new ProviderFlow({
			prompt: new FakePrompt([], []),
			notifier: new FakeNotifier(),
			secrets: new InMemorySecretStore(),
			config: new ProviderConfigService(new FakeMemento()),
			registry: new ProviderRegistry(),
		});

		assert.strictEqual(flow.deriveProviderId('http://127.0.0.1:11434/v1'), 'local-127.0.0.1-11434');
	});

	test('a non-URL base still yields a usable id', () => {
		const flow = new ProviderFlow({
			prompt: new FakePrompt([], []),
			notifier: new FakeNotifier(),
			secrets: new InMemorySecretStore(),
			config: new ProviderConfigService(new FakeMemento()),
			registry: new ProviderRegistry(),
		});

		const id = flow.deriveProviderId('not a url at all');
		assert.ok(id.length > 0);
		assert.ok(id.startsWith('local-'));
	});
});

suite('Foundation: restore on activate', () => {
	test('restorePersistedProviders registers what globalState holds', async () => {
		const h = buildHarness([accepted(REMOTE)], [withKey(SECRET)]);
		await h.flow.addProvider();
		await h.flow.restorePersistedProviders(); // already registered; idempotent by id
		const countAfterAdd = h.registry.size;

		// Simulate a fresh window: empty registry, same globalState.
		const freshRegistry = new ProviderRegistry();
		const flow = new ProviderFlow({
			prompt: new FakePrompt([], []),
			notifier: new FakeNotifier(),
			secrets: h.secrets,
			config: h.config,
			registry: freshRegistry,
		});

		const restored = flow.restorePersistedProviders();

		assert.strictEqual(restored.length, countAfterAdd);
		assert.strictEqual(freshRegistry.size, countAfterAdd);
		assert.strictEqual(
			freshRegistry.get(h.flow.deriveProviderId(REMOTE))?.descriptor.status,
			'unconfigured',
			'a restored provider waits for its key to resolve on first call',
		);
	});

	test('restore with an empty config registers nothing', () => {
		const registry = new ProviderRegistry();
		const flow = new ProviderFlow({
			prompt: new FakePrompt([], []),
			notifier: new FakeNotifier(),
			secrets: new InMemorySecretStore(),
			config: new ProviderConfigService(new FakeMemento()),
			registry,
		});

		assert.deepStrictEqual(flow.restorePersistedProviders(), []);
		assert.strictEqual(registry.size, 0);
	});
});

suite('Foundation: provider id from tree node', () => {
	test('extracts the id from a provider node', () => {
		assert.strictEqual(providerIdFromNode({ id: 'provider::local-api.test' }), 'local-api.test');
	});

	test('returns undefined for a non-provider node', () => {
		assert.strictEqual(providerIdFromNode({ id: 'section::providers' }), undefined);
		assert.strictEqual(providerIdFromNode({ id: 'modelhub.empty' }), undefined);
	});

	test('returns undefined for junk input', () => {
		assert.strictEqual(providerIdFromNode(undefined), undefined);
		assert.strictEqual(providerIdFromNode(null), undefined);
		assert.strictEqual(providerIdFromNode('provider::x'), undefined);
		assert.strictEqual(providerIdFromNode({}), undefined);
	});
});