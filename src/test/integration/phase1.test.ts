import * as assert from 'assert';
import * as vscode from 'vscode';
import { ModelHubApplication } from '../../host/vscode/application';
import { ProviderConfigService, PROVIDER_CONFIG_KEY } from '../../core/providers/config';
import { VsCodeStateStore } from '../../host/vscode/storage/vsCodeStateStore';
import { InMemorySecretStore, providerApiKeyRef } from '../../core/providers/secrets';
import { ProviderRegistry } from '../../core/providers/registry';
import { ProviderFlow, type ProviderNotifierPort, type ProviderPromptPort } from '../../host/vscode/ui/providerFlow';
import { createUiContext } from '../../host/vscode/ui/context';
import { buildRootNodes } from '../../host/vscode/ui/viewModel';
import type { FetchLike } from '../../core/providers/openaiCompatible';
import type { Provider } from '../../core/providers/types';

const REMOTE = 'https://integration.example.test/v1';
const LOCAL = 'http://127.0.0.1:11434/v1';
const SECRET = 'sk-integration-secret';

/** Scripted prompts, so the flow can be driven without real dialogs. */
class ScriptedPrompt implements ProviderPromptPort {
	constructor(
		private readonly baseUrl: string | undefined,
		private readonly apiKey: string | undefined,
	) {}
	async askBaseUrl() {
		return this.baseUrl === undefined
			? ({ kind: 'cancelled' } as const)
			: ({ kind: 'accepted', value: this.baseUrl } as const);
	}
	async askApiKey() {
		return this.apiKey === undefined
			? ({ kind: 'skipped' } as const)
			: ({ kind: 'accepted', value: this.apiKey } as const);
	}
}

class SilentNotifier implements ProviderNotifierPort {
	readonly messages: string[] = [];
	info(message: string): void {
		this.messages.push(message);
	}
	error(message: string): void {
		this.messages.push(message);
	}
}

/** `globalState` fake sharing the same key space the application uses. */
function fakeMemento(): vscode.Memento {
	const values = new Map<string, unknown>();
	return {
		get<T>(key: string, defaultValue: T): T {
			return values.has(key) ? (values.get(key) as T) : defaultValue;
		},
		update(key: string, value: unknown): Thenable<void> {
			values.set(key, value);
			return Promise.resolve();
		},
		keys: () => [...values.keys()],
	} as unknown as vscode.Memento;
}

/** SecretStorage fake backed by a map, so a "restart" can share the keychain. */
function fakeSecretStorage(store: Map<string, string>): vscode.SecretStorage {
	return {
		get: async (key: string) => store.get(key),
		store: async (key: string, value: string) => {
			store.set(key, value);
		},
		delete: async (key: string) => {
			store.delete(key);
		},
		onDidChange: new vscode.EventEmitter<never>().event,
	} as unknown as vscode.SecretStorage;
}

/** A provider whose `listModels` is served by a stub, so no network is touched. */
function stubFetch(models: readonly string[]): FetchLike {
	return async () => ({
		ok: true,
		status: 200,
		text: async () => JSON.stringify({ data: models.map((id) => ({ id })) }),
	});
}

/** `SecretStore` over the shared keychain map, so a "restart" keeps the key. */
function keychainBackedStore(secretStore: Map<string, string>) {
	return {
		get: async (ref: string) => secretStore.get(ref),
		store: async (ref: string, value: string) => {
			secretStore.set(ref, value);
		},
		delete: async (ref: string) => {
			secretStore.delete(ref);
		},
		has: async (ref: string) => secretStore.has(ref),
	};
}

interface Context {
	subscriptions: vscode.Disposable[];
	globalState: vscode.Memento;
	secretStore: Map<string, string>;
}

function createContext(): Context {
	return {
		subscriptions: [],
		globalState: fakeMemento(),
		secretStore: new Map<string, string>(),
	};
}

function extensionContext(ctx: Context): vscode.ExtensionContext {
	return {
		subscriptions: ctx.subscriptions,
		globalState: ctx.globalState,
		secrets: fakeSecretStorage(ctx.secretStore),
		extension: { packageJSON: { version: '0.0.1' } },
	} as unknown as vscode.ExtensionContext;
}

suite('Integration: Phase 1 provider lifecycle', () => {
	test('activate starts the application and registers the open command', async () => {
		const ctx = createContext();
		const application = await ModelHubApplication.start(extensionContext(ctx));

		try {
			const commands = await vscode.commands.getCommands(true);
			assert.ok(commands.includes('modelhub.open'));
			assert.ok(commands.includes('modelhub.addProvider'));
			assert.ok(commands.includes('modelhub.removeProvider'));
			assert.ok(commands.includes('modelhub.refresh'));
		} finally {
			application.dispose();
		}
	});

	test('activate with an empty state tracks no providers', async () => {
		const ctx = createContext();
		const application = await ModelHubApplication.start(extensionContext(ctx));

		try {
			assert.strictEqual(application.providerRegistry.size, 0);
			assert.strictEqual(application.trackedProviderCount, 0);
		} finally {
			application.dispose();
		}
	});

	test('add → tree shows the provider → refreshModels lists its models', async () => {
		const ctx = createContext();
		const registry = new ProviderRegistry();
		const config = new ProviderConfigService(new VsCodeStateStore(ctx.globalState));
		const secrets = new InMemorySecretStore();
		const notifier = new SilentNotifier();
		const flow = new ProviderFlow({
			prompt: new ScriptedPrompt(REMOTE, SECRET),
			notifier,
			secrets,
			config,
			registry,
			fetch: stubFetch([]),
		});
		// 2. provider added
		const outcome = await flow.addProvider();
		assert.strictEqual(outcome.ok, true);
		const providerId = outcome.providerId as string;

		// 3. provider appears in the tree
		const treeAfterAdd = buildRootNodes(createUiContext('0.0.1', registry));
		const providerNodes = treeAfterAdd[0].children ?? [];
		assert.strictEqual(providerNodes.length, 1);
		assert.strictEqual(providerNodes[0].kind, 'provider');
		assert.strictEqual(providerNodes[0].label, 'integration.example.test');

		// 4. listModels is executed
		const provider = registry.get(providerId) as Provider;
		const models = await provider.listModels();

		// 5. models are associated with the provider
		assert.deepStrictEqual(models, [], 'the stub reports no models');
		assert.strictEqual(provider.descriptor.status, 'available');
	});

	test('refreshModels populates descriptors and the tree with models', async () => {
		const ctx = createContext();
		const registry = new ProviderRegistry();
		const config = new ProviderConfigService(new VsCodeStateStore(ctx.globalState));
		const secrets = new InMemorySecretStore();
		const flow = new ProviderFlow({
			prompt: new ScriptedPrompt(REMOTE, SECRET),
			notifier: new SilentNotifier(),
			secrets,
			config,
			registry,
			fetch: stubFetch(['model-a', 'model-b']),
		});

		await flow.addProvider();
		const providerId = flow.deriveProviderId(REMOTE);

		// 4. listModels is executed for the provider
		const provider = registry.get(providerId) as Provider;
		const models = await provider.listModels();
		assert.deepStrictEqual(
			models.map((model) => model.id),
			['model-a', 'model-b'],
		);

		// 5. models appear associated with the provider in the tree
		const tree = buildRootNodes(createUiContext('0.0.1', registry));
		const providerNode = (tree[0].children ?? [])[0];
		assert.strictEqual(providerNode.contextValue, 'modelhub.provider.available');
		const modelNodes = providerNode.children ?? [];
		assert.deepStrictEqual(
			modelNodes.map((node) => node.label),
			['model-a', 'model-b'],
		);
	});

	test('one failing provider does not hide the others', async () => {
		const ctx = createContext();
		const registry = new ProviderRegistry();
		const config = new ProviderConfigService(new VsCodeStateStore(ctx.globalState));
		const secrets = new InMemorySecretStore();
		const flow = new ProviderFlow({
			prompt: new ScriptedPrompt(REMOTE, SECRET),
			notifier: new SilentNotifier(),
			secrets,
			config,
			registry,
			fetch: stubFetch(['good-model']),
		});
		await flow.addProvider();
		const goodId = flow.deriveProviderId(REMOTE);

		// A second provider whose endpoint always fails.
		const failing = {
			descriptor: {
				id: 'failing',
				name: 'failing',
				type: 'custom-openai-compatible' as const,
				status: 'configured' as const,
				configuration: {},
				capabilities: ['chat'] as const,
				models: [] as const,
			},
			listModels: async () => {
				throw new Error('unreachable');
			},
		};
		registry.register(failing);

		const results = await Promise.allSettled(
			registry.list().map((provider) => provider.listModels()),
		);

		assert.strictEqual(results.filter((r) => r.status === 'fulfilled').length, 1);
		assert.strictEqual(results.filter((r) => r.status === 'rejected').length, 1);
		assert.strictEqual(registry.get(goodId)?.descriptor.status, 'available');
		assert.strictEqual(registry.get('failing')?.descriptor.status, 'configured');
	});

	test('remove clears the registry, the config and the key', async () => {
		const ctx = createContext();
		const registry = new ProviderRegistry();
		const config = new ProviderConfigService(new VsCodeStateStore(ctx.globalState));
		const secrets = new InMemorySecretStore();
		const flow = new ProviderFlow({
			prompt: new ScriptedPrompt(REMOTE, SECRET),
			notifier: new SilentNotifier(),
			secrets,
			config,
			registry,
		});
		await flow.addProvider();
		const id = flow.deriveProviderId(REMOTE);

		// 6. removal clears all three
		assert.strictEqual(await flow.removeProvider(id), true);
		assert.strictEqual(registry.size, 0);
		assert.strictEqual(config.get(id), undefined);
		assert.strictEqual(await secrets.get(providerApiKeyRef(id)), undefined);

		// and the tree is back to its empty state
		const tree = buildRootNodes(createUiContext('0.0.1', registry));
		const children = tree[0].children ?? [];
		assert.strictEqual(children.length, 1);
		assert.strictEqual(children[0].kind, 'empty');
	});

	test('a persisted provider is restored on the next activate', async () => {
		// First session: add a provider through the flow, writing into the
		// same keychain the next session will read.
		const ctx = createContext();
		const registry = new ProviderRegistry();
		const secrets = keychainBackedStore(ctx.secretStore);
		const config = new ProviderConfigService(new VsCodeStateStore(ctx.globalState));
		const flow = new ProviderFlow({
			prompt: new ScriptedPrompt(REMOTE, SECRET),
			notifier: new SilentNotifier(),
			secrets,
			config,
			registry,
		});
		await flow.addProvider();
		const id = flow.deriveProviderId(REMOTE);
		assert.ok(ctx.globalState.get(PROVIDER_CONFIG_KEY, []).length === 1);

		// Second session: the application restores from the same globalState.
		const application = await ModelHubApplication.start(extensionContext(ctx));
		try {
			assert.strictEqual(application.providerRegistry.size, 1);
			assert.strictEqual(application.trackedProviderCount, 1);

			const restored = application.providerRegistry.get(id);
			assert.ok(restored !== undefined);
			assert.strictEqual(restored.descriptor.configuration.baseUrl, REMOTE);
			assert.strictEqual(restored.descriptor.status, 'unconfigured');

			// The key is still in the keychain, not in globalState.
			assert.strictEqual(ctx.secretStore.get(providerApiKeyRef(id)), SECRET);
			assert.ok(
				!JSON.stringify(ctx.globalState.get(PROVIDER_CONFIG_KEY)).includes(SECRET),
			);
		} finally {
			application.dispose();
		}
	});

	test('dispose unregisters every restored provider', async () => {
		const ctx = createContext();
		// Seed a persisted config directly.
		await ctx.globalState.update(PROVIDER_CONFIG_KEY, [
			{
				id: 'local-remote.test',
				name: 'remote.test',
				baseUrl: REMOTE,
				apiKeyRef: providerApiKeyRef('local-remote.test'),
				enabled: true,
			},
		]);

		const application = await ModelHubApplication.start(extensionContext(ctx));
		assert.strictEqual(application.providerRegistry.size, 1);
		assert.strictEqual(application.trackedProviderCount, 1);

		// 7. teardown leaves nothing pending
		application.dispose();

		assert.strictEqual(application.providerRegistry.size, 0);
		assert.strictEqual(application.trackedProviderCount, 0);
	});

	test('dispose is idempotent and survives a failing unregister', async () => {
		const ctx = createContext();
		await ctx.globalState.update(PROVIDER_CONFIG_KEY, [
			{ id: 'p1', name: 'p1', baseUrl: REMOTE, enabled: true },
		]);
		const application = await ModelHubApplication.start(extensionContext(ctx));

		// Corrupt the registry so unregister throws during teardown.
		(application.providerRegistry as unknown as { unregister(id: string): boolean }).unregister =
			() => {
				throw new Error('teardown boom');
			};

		assert.doesNotThrow(() => application.dispose());
		assert.doesNotThrow(() => application.dispose());
		assert.strictEqual(application.trackedProviderCount, 0);
	});

	test('the real application refresh command does not throw with no providers', async () => {
		const ctx = createContext();
		const application = await ModelHubApplication.start(extensionContext(ctx));

		try {
			await assert.doesNotReject(async () => {
				await vscode.commands.executeCommand('modelhub.refresh');
			});
		} finally {
			application.dispose();
		}
	});

	test('the real application remove command reports cleanly with no node', async () => {
		const ctx = createContext();
		const application = await ModelHubApplication.start(extensionContext(ctx));

		try {
			await assert.doesNotReject(async () => {
				await vscode.commands.executeCommand('modelhub.removeProvider', undefined);
			});
		} finally {
			application.dispose();
		}
	});

	test('a keyless provider round-trips through persistence and restore', async () => {
		const ctx = createContext();
		const registry = new ProviderRegistry();
		const secrets = new InMemorySecretStore();
		const config = new ProviderConfigService(new VsCodeStateStore(ctx.globalState));
		const flow = new ProviderFlow({
			prompt: new ScriptedPrompt(LOCAL, undefined),
			notifier: new SilentNotifier(),
			secrets,
			config,
			registry,
		});

		const outcome = await flow.addProvider();
		assert.strictEqual(outcome.ok, true);
		const id = flow.deriveProviderId(LOCAL);
		assert.strictEqual(await secrets.size, 0, 'no key is written for a keyless provider');

		const application = await ModelHubApplication.start(extensionContext(ctx));
		try {
			const restored = application.providerRegistry.get(id);
			assert.ok(restored !== undefined);
			assert.strictEqual(restored.descriptor.status, 'configured');
			assert.ok(!('apiKeyRef' in restored.descriptor.configuration));
		} finally {
			application.dispose();
		}
	});
});