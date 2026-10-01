import * as assert from 'assert';
import {
	OpenAICompatibleProvider,
	type FetchLike,
} from '../../providers/openaiCompatible';
import { InMemorySecretStore, providerApiKeyRef } from '../../providers/secrets';
import { ProviderError, ValidationError } from '../../core/errors';

interface RecordedCall {
	readonly url: string;
	readonly headers: Record<string, string>;
}

interface FakeResponse {
	readonly ok?: boolean;
	readonly status: number;
	readonly body?: string;
}

/**
 * Records every request and replies with a canned response, so the provider is
 * exercised without a network. `failWith` simulates a transport-level error.
 */
function createFakeFetch(
	response: FakeResponse | Error,
): { fetch: FetchLike; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	const fetch: FetchLike = async (url, init) => {
		calls.push({ url, headers: init?.headers ?? {} });
		if (response instanceof Error) {
			throw response;
		}
		return {
			ok: response.ok ?? (response.status >= 200 && response.status < 300),
			status: response.status,
			text: async () => response.body ?? '',
		};
	};
	return { fetch, calls };
}

const BASE_URL = 'https://api.example.test/v1';

function createProvider(
	overrides: Partial<{
		status: number;
		body: string;
		transportError: Error;
		apiKey: string | undefined;
		secrets: InMemorySecretStore;
		withRef: boolean;
		withoutSecrets: boolean;
	}> = {},
): { provider: OpenAICompatibleProvider; calls: RecordedCall[]; secrets: InMemorySecretStore } {
	const secrets = overrides.secrets ?? new InMemorySecretStore();
	if (overrides.apiKey !== undefined) {
		void secrets.store('ref-key', overrides.apiKey);
	}

	const { fetch, calls } = createFakeFetch(
		overrides.transportError ??
			({
				status: overrides.status ?? 200,
				body: overrides.body ?? JSON.stringify({ data: [{ id: 'model-a' }] }),
			} as FakeResponse),
	);

	const provider = new OpenAICompatibleProvider({
		id: 'test-provider',
		name: 'Test Provider',
		baseUrl: BASE_URL,
		fetch,
		...(overrides.withRef === false ? {} : { apiKeyRef: 'ref-key' }),
		...(overrides.withoutSecrets === true ? {} : { secrets }),
	});

	return { provider, calls, secrets };
}

/** Every string a thrown error exposes, including nested `cause`. */
function collectErrorText(error: unknown, seen = new Set<unknown>()): string {
	if (error === null || error === undefined || seen.has(error)) {
		return '';
	}
	seen.add(error);
	if (typeof error === 'string') {
		return error;
	}
	if (error instanceof Error) {
		const cause = (error as { cause?: unknown }).cause;
		return [error.name, error.message, error.stack ?? '', collectErrorText(cause, seen)].join('\n');
	}
	if (typeof error === 'object') {
		return Object.values(error as Record<string, unknown>)
			.map((value) => collectErrorText(value, seen))
			.join('\n');
	}
	return String(error);
}

suite('Foundation: OpenAI-compatible provider', () => {
	test('requests {baseUrl}/models with a GET', async () => {
		const { provider, calls } = createProvider();

		await provider.listModels();

		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0].url, `${BASE_URL}/models`);
	});

	test('maps { data: [{ id }] } to ModelInfo entries', async () => {
		const { provider } = createProvider({
			body: JSON.stringify({
				data: [
					{ id: 'model-a' },
					{ id: 'model-b' },
					{ id: 'model-c' },
				],
			}),
		});

		const models = await provider.listModels();

		assert.deepStrictEqual(
			models.map((model) => ({ id: model.id, name: model.name })),
			[
				{ id: 'model-a', name: 'model-a' },
				{ id: 'model-b', name: 'model-b' },
				{ id: 'model-c', name: 'model-c' },
			],
		);
	});

	test('an empty data array yields no models without error', async () => {
		const { provider } = createProvider({ body: JSON.stringify({ data: [] }) });

		assert.deepStrictEqual(await provider.listModels(), []);
	});

	test('a trailing slash on baseUrl does not double the separator', async () => {
		const { fetch, calls } = createFakeFetch({ status: 200, body: JSON.stringify({ data: [] }) });
		const provider = new OpenAICompatibleProvider({
			id: 'p',
			name: 'P',
			baseUrl: `${BASE_URL}///`,
			fetch,
		});

		await provider.listModels();

		assert.strictEqual(calls[0].url, `${BASE_URL}/models`);
	});

	test('sends Authorization: Bearer with a stored key', async () => {
		const { provider, calls } = createProvider({ apiKey: 'sk-secret-value' });

		await provider.listModels();

		assert.strictEqual(calls[0].headers.authorization, 'Bearer sk-secret-value');
	});

	test('sends no authorization header when no key is stored', async () => {
		const { provider, calls } = createProvider();

		await provider.listModels();

		assert.ok(!('authorization' in calls[0].headers));
	});

	test('sends no authorization header when the provider has no key reference', async () => {
		const { provider, calls } = createProvider({ withRef: false, apiKey: 'ignored' });

		await provider.listModels();

		assert.ok(!('authorization' in calls[0].headers));
	});

	test('a blank stored key is treated as no key', async () => {
		const { provider, calls } = createProvider({ apiKey: '   ' });

		await provider.listModels();

		assert.ok(!('authorization' in calls[0].headers));
	});

	test('a declared key reference without a secret store raises a ProviderError', async () => {
		const { provider } = createProvider({ withoutSecrets: true, apiKey: 'sk-x' });

		await assert.rejects(() => provider.listModels(), (error: unknown) => {
			assert.ok(error instanceof ProviderError);
			assert.match(error.message, /no secret store/i);
			return true;
		});
	});

	test('401 raises a ProviderError naming the endpoint and the status', async () => {
		const { provider } = createProvider({ status: 401 });

		await assert.rejects(() => provider.listModels(), (error: unknown) => {
			assert.ok(error instanceof ProviderError);
			assert.strictEqual(error.category, 'provider');
			assert.match(error.message, /Authentication failed/i);
			assert.match(error.message, /401/);
			assert.match(error.message, /API key/i);
			assert.match(error.message, new RegExp(BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
			return true;
		});
	});

	test('403 is treated as an authentication failure', async () => {
		const { provider } = createProvider({ status: 403 });

		await assert.rejects(() => provider.listModels(), (error: unknown) => {
			assert.ok(error instanceof ProviderError);
			assert.match(error.message, /Authentication failed/i);
			return true;
		});
	});

	test('other HTTP failures report the status without claiming auth', async () => {
		const { provider } = createProvider({ status: 500 });

		await assert.rejects(() => provider.listModels(), (error: unknown) => {
			assert.ok(error instanceof ProviderError);
			assert.match(error.message, /500/);
			assert.ok(!/Authentication failed/i.test(error.message));
			return true;
		});
	});

	test('a non-JSON body raises a ProviderError', async () => {
		const { provider } = createProvider({ status: 200, body: '<html>gateway timeout</html>' });

		await assert.rejects(() => provider.listModels(), (error: unknown) => {
			assert.ok(error instanceof ProviderError);
			assert.match(error.message, /not valid JSON/i);
			return true;
		});
	});

	test('JSON without a data array raises a ProviderError', async () => {
		const { provider } = createProvider({ status: 200, body: JSON.stringify({ models: [] }) });

		await assert.rejects(() => provider.listModels(), (error: unknown) => {
			assert.ok(error instanceof ProviderError);
			assert.match(error.message, /"data" array/i);
			return true;
		});
	});

	test('a data entry without a usable id raises a ProviderError', async () => {
		const { provider } = createProvider({
			status: 200,
			body: JSON.stringify({ data: [{ id: 'ok' }, { name: 'no-id' }] }),
		});

		await assert.rejects(() => provider.listModels(), (error: unknown) => {
			assert.ok(error instanceof ProviderError);
			assert.match(error.message, /usable "id"/i);
			return true;
		});
	});

	test('a transport failure raises a ProviderError preserving the cause', async () => {
		const transportError = new Error('getaddrinfo ENOTFOUND api.example.test');
		const { provider } = createProvider({ transportError });

		await assert.rejects(() => provider.listModels(), (error: unknown) => {
			assert.ok(error instanceof ProviderError);
			assert.strictEqual(error.cause, transportError);
			assert.match(error.message, /Could not reach/i);
			return true;
		});
	});

	test('an empty baseUrl is rejected at construction', () => {
		const { fetch } = createFakeFetch({ status: 200, body: JSON.stringify({ data: [] }) });

		assert.throws(
			() => new OpenAICompatibleProvider({ id: 'p', name: 'P', baseUrl: '   ', fetch }),
			ValidationError,
		);
	});

	test('the descriptor exposes the normalized baseUrl and the key reference only', () => {
		const { provider } = createProvider({ apiKey: 'sk-secret-value' });

		assert.strictEqual(provider.descriptor.type, 'custom-openai-compatible');
		assert.strictEqual(provider.descriptor.configuration.baseUrl, BASE_URL);
		assert.strictEqual(provider.descriptor.configuration.apiKeyRef, 'ref-key');
		assert.ok(!JSON.stringify(provider.descriptor).includes('sk-secret-value'));
	});

	test('no error path leaks the API key into the thrown value', async () => {
		const secret = 'sk-do-not-leak-me';
		const scenarios = [
			createProvider({ status: 401, apiKey: secret }),
			createProvider({ status: 500, apiKey: secret }),
			createProvider({ status: 200, body: 'not json', apiKey: secret }),
			createProvider({ status: 200, body: '{"models":[]}', apiKey: secret }),
			createProvider({ transportError: new Error('socket hang up'), apiKey: secret }),
		];

		for (const scenario of scenarios) {
			await assert.rejects(() => scenario.provider.listModels());
		}

		for (const scenario of scenarios) {
			await scenario.provider.listModels().catch((error: unknown) => {
				assert.ok(
					!collectErrorText(error).includes(secret),
					`secret leaked in: ${collectErrorText(error)}`,
				);
			});
		}
	});

	test('the key reference built by providerApiKeyRef is what gets read', async () => {
		const secrets = new InMemorySecretStore();
		await secrets.store(providerApiKeyRef('test-provider'), 'sk-namespaced');
		const { fetch, calls } = createFakeFetch({
			status: 200,
			body: JSON.stringify({ data: [{ id: 'model-a' }] }),
		});
		const provider = new OpenAICompatibleProvider({
			id: 'test-provider',
			name: 'Test Provider',
			baseUrl: BASE_URL,
			apiKeyRef: providerApiKeyRef('test-provider'),
			secrets,
			fetch,
		});

		await provider.listModels();

		assert.strictEqual(calls[0].headers.authorization, 'Bearer sk-namespaced');
	});
});

suite('Foundation: provider status transitions', () => {
	function build(
		options: {
			status?: number;
			body?: string;
			transportError?: Error;
			apiKey?: string;
			withRef?: boolean;
			secrets?: InMemorySecretStore;
		} = {},
	): { provider: OpenAICompatibleProvider; calls: RecordedCall[]; secrets: InMemorySecretStore } {
		const secrets = options.secrets ?? new InMemorySecretStore();
		if (options.apiKey !== undefined) {
			void secrets.store('ref-key', options.apiKey);
		}
		const { fetch, calls } = createFakeFetch(
			options.transportError ??
				({
					status: options.status ?? 200,
					body: options.body ?? JSON.stringify({ data: [{ id: 'model-a' }] }),
				} as FakeResponse),
		);
		const provider = new OpenAICompatibleProvider({
			id: 'status-provider',
			name: 'Status Provider',
			baseUrl: BASE_URL,
			fetch,
			...(options.withRef === false ? {} : { apiKeyRef: 'ref-key' }),
			secrets,
		});
		return { provider, calls, secrets };
	}

	test('is unconfigured at construction when a key is expected but absent', () => {
		const { provider } = build();
		assert.strictEqual(provider.descriptor.status, 'unconfigured');
	});

	test('a provider that declares no key reference starts as configured', () => {
		// Nothing about it is missing, so it is ready to call even though it has
		// never been called.
		const { provider } = build({ withRef: false });
		assert.strictEqual(provider.descriptor.status, 'configured');
	});

	test('a stored key moves the provider from unconfigured to configured', async () => {
		// A provider whose only requirement is a stored key must leave
		// `unconfigured` as soon as that key resolves, before any success.
		const { provider } = build({ apiKey: 'sk-present' });

		assert.strictEqual(provider.descriptor.status, 'unconfigured');

		await provider.listModels();

		assert.strictEqual(provider.descriptor.status, 'available');
	});

	test('a failed call on a keyless provider still lands on error', async () => {
		const { provider } = build({ withRef: false, status: 500 });

		await assert.rejects(() => provider.listModels());

		assert.strictEqual(provider.descriptor.status, 'error');
	});

	test('is available after listModels succeeds', async () => {
		const { provider } = build({ apiKey: 'sk-present' });

		await provider.listModels();

		assert.strictEqual(provider.descriptor.status, 'available');
	});

	test('is available for a keyless provider after a successful call', async () => {
		const { provider } = build({ withRef: false });

		await provider.listModels();

		assert.strictEqual(provider.descriptor.status, 'available');
	});

	test('is error after an authentication failure', async () => {
		const { provider } = build({ status: 401, apiKey: 'sk-bad' });

		await assert.rejects(() => provider.listModels());

		assert.strictEqual(provider.descriptor.status, 'error');
	});

	test('is error after a non-auth HTTP failure', async () => {
		const { provider } = build({ status: 500, apiKey: 'sk-present' });

		await assert.rejects(() => provider.listModels());

		assert.strictEqual(provider.descriptor.status, 'error');
	});

	test('is error after a malformed payload', async () => {
		const { provider } = build({ status: 200, body: 'not json', apiKey: 'sk-present' });

		await assert.rejects(() => provider.listModels());

		assert.strictEqual(provider.descriptor.status, 'error');
	});

	test('is error after a transport failure', async () => {
		const { provider } = build({
			transportError: new Error('socket hang up'),
			apiKey: 'sk-present',
		});

		await assert.rejects(() => provider.listModels());

		assert.strictEqual(provider.descriptor.status, 'error');
	});

	test('is error when a key reference has no secret store to read from', async () => {
		const { fetch } = createFakeFetch({ status: 200, body: JSON.stringify({ data: [] }) });
		const provider = new OpenAICompatibleProvider({
			id: 'no-store',
			name: 'No Store',
			baseUrl: BASE_URL,
			apiKeyRef: 'ref-key',
			fetch,
		});

		await assert.rejects(() => provider.listModels());

		assert.strictEqual(provider.descriptor.status, 'error');
	});

	test('recovers from error to available on a later successful call', async () => {
		let attempt = 0;
		const responses: FakeResponse[] = [
			{ status: 500, body: '' },
			{ status: 200, body: JSON.stringify({ data: [{ id: 'model-a' }] }) },
		];
		const secrets = new InMemorySecretStore();
		await secrets.store('ref-key', 'sk-present');
		const provider = new OpenAICompatibleProvider({
			id: 'recovering',
			name: 'Recovering',
			baseUrl: BASE_URL,
			apiKeyRef: 'ref-key',
			secrets,
			fetch: async () => {
				const current = responses[attempt];
				attempt += 1;
				return {
					ok: current.status >= 200 && current.status < 300,
					status: current.status,
					text: async () => current.body ?? '',
				};
			},
		});

		await assert.rejects(() => provider.listModels());
		assert.strictEqual(provider.descriptor.status, 'error');

		await provider.listModels();
		assert.strictEqual(provider.descriptor.status, 'available');
	});

	test('a successful call publishes the models through the descriptor', async () => {
		const { provider } = build({
			apiKey: 'sk-present',
			body: JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] }),
		});

		assert.strictEqual(provider.descriptor.models.length, 0);

		const models = await provider.listModels();

		assert.deepStrictEqual(
			models.map((model) => model.id),
			['model-a', 'model-b'],
		);
		assert.deepStrictEqual(
			[...provider.descriptor.models].map((model) => model.id),
			['model-a', 'model-b'],
		);
	});

	test('a failed call clears previously discovered models', async () => {
		let attempt = 0;
		const secrets = new InMemorySecretStore();
		await secrets.store('ref-key', 'sk-present');
		const provider = new OpenAICompatibleProvider({
			id: 'flapping',
			name: 'Flapping',
			baseUrl: BASE_URL,
			apiKeyRef: 'ref-key',
			secrets,
			fetch: async () => {
				attempt += 1;
				const ok = attempt === 1;
				return {
					ok,
					status: ok ? 200 : 503,
					text: async () =>
						ok ? JSON.stringify({ data: [{ id: 'stale-model' }] }) : '',
				};
			},
		});

		await provider.listModels();
		assert.strictEqual(provider.descriptor.models.length, 1);

		await assert.rejects(() => provider.listModels());

		assert.deepStrictEqual(provider.descriptor.models, []);
		assert.strictEqual(provider.descriptor.status, 'error');
	});

	test('the descriptor is a fresh snapshot, not a shared mutable object', async () => {
		const { provider } = build({ apiKey: 'sk-present' });

		const before = provider.descriptor;
		await provider.listModels();
		const after = provider.descriptor;

		assert.notStrictEqual(before, after);
		assert.strictEqual(before.status, 'unconfigured');
		assert.strictEqual(after.status, 'available');
	});

	test('the descriptor never carries the API key in any status', async () => {
		const secret = 'sk-status-leak-check';
		const { provider } = build({ status: 401, apiKey: secret });

		await assert.rejects(() => provider.listModels());

		for (const status of ['unconfigured', 'configured', 'available', 'error'] as const) {
			assert.ok(!JSON.stringify({ ...provider.descriptor, status }).includes(secret));
		}
	});
});