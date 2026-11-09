/**
 * A integração do provedor OpenAI-compatible com a descoberta da 5D.
 *
 * Um servidor falso responde às mesmas rotas que um serviço real
 * (`/models`, `/chat/completions`) e devolve os cabeçalhos e os registros que
 * esses serviços devolvem. O que se prova aqui é o caminho inteiro: resposta →
 * `ModelInfo` publicado → `/models` gravado no catálogo do provedor → cota
 * lida → motor pulando o modelo com janela aberta.
 */
import * as assert from 'assert';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { ProviderError } from '../core/errors';
import { OpenAICompatibleProvider, type FetchLike, type FetchResponseLike, type HeadersLike } from '../core/providers/openaiCompatible';
import { join } from 'node:path';
import { CircuitBreaker } from '../core/providers/routing/breaker';
import { runRoute } from '../core/providers/routing/engine';
import type { RoutePolicy, RouteTarget } from '../core/providers/routing/types';
import type { ChatProvider, ChatRequest, ChatStream, ChatStreamEvent } from '../core/providers/chat/types';
import { createQuotaTracker } from '../core/providers/quota';
import { FileDataStore, PROVIDER_MODELS_FILE } from '../adapters/local/fileDataStore';
import { createProviderDiscovery } from '../desktop/providerDiscovery';
import { createObservingProvider } from '../desktop/observingProvider';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

function headersOf(values: Record<string, string>): HeadersLike {
	const lower = new Map(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]));
	return {
		get: (name: string) => lower.get(name.toLowerCase()) ?? null,
		entries: () => lower.entries(),
	};
}

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): FetchResponseLike {
	return {
		ok: (init.status ?? 200) < 400,
		status: init.status ?? 200,
		headers: headersOf(init.headers ?? { 'content-type': 'application/json' }),
		text: async () => JSON.stringify(body),
	};
}

function streamResponse(chunks: readonly string[], headers: Record<string, string> = {}): FetchResponseLike {
	return {
		ok: true,
		status: 200,
		headers: headersOf({ 'content-type': 'text/event-stream', ...headers }),
		body: {
			[Symbol.asyncIterator]: async function* () {
				for (const chunk of chunks) {
					yield chunk;
				}
			},
		},
		text: async () => chunks.join(''),
	};
}

function sse(text: string): string {
	return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`;
}

suite('Discovery: the OpenAI-compatible provider', () => {
	test('a listing keeps the exact ids and the fields the server published', async () => {
		const fetchImpl: FetchLike = async (url) => {
			if (!url.endsWith('/models')) {
				throw new Error(`unexpected ${url}`);
			}
			return jsonResponse({
				data: [
					{ id: 'free-model', pricing: { currency: 'USD', input: 0, output: 0 }, context_length: 8192 },
					{ id: 'paid-model', pricing: { currency: 'USD', input: 0.0000025, output: 0.00001 } },
					{ id: 'bare-model' },
				],
			});
		};
		const provider = new OpenAICompatibleProvider({ id: 'p', name: 'P', baseUrl: 'http://p/v1', fetch: fetchImpl });
		const models = await provider.listModels();
		assert.deepStrictEqual(models.map((model) => model.id), ['free-model', 'paid-model', 'bare-model']);
		assert.deepStrictEqual(models[0]?.pricing, {
			currency: 'USD',
			unit: 'per_1m_tokens',
			input: 0,
			output: 0,
		});
		assert.strictEqual(models[0]?.contextWindow, 8192);
		assert.deepStrictEqual(models[1]?.pricing, { currency: 'USD', unit: 'per_1m_tokens', input: 2.5, output: 10 });
		assert.strictEqual(models[2]?.pricing, undefined, 'no price published is no price, not zero');
	});

	test('a 429 carries Retry-After from the header', async () => {
		const provider = new OpenAICompatibleProvider({
			id: 'p',
			name: 'P',
			baseUrl: 'http://p/v1',
			now: () => 1_000_000,
			fetch: async () => jsonResponse({ error: 'slow down' }, { status: 429, headers: { 'retry-after': '12' } }),
		});
		await assert.rejects(
			() => provider.streamChat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
			(error: unknown) => {
				const details = (error as { details?: { retryAfterMs?: number; status?: number } }).details;
				assert.strictEqual(details?.status, 429);
				assert.strictEqual(details?.retryAfterMs, 12_000);
				return true;
			},
		);
	});

	test('a 429 without a header reads Retry-After from the body', async () => {
		const provider = new OpenAICompatibleProvider({
			id: 'p',
			name: 'P',
			baseUrl: 'http://p/v1',
			now: () => 0,
			fetch: async () => jsonResponse({ error: { message: 'quota', retry_after: 30 } }, { status: 429 }),
		});
		await assert.rejects(
			() => provider.streamChat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
			(error: unknown) => {
				const details = (error as { details?: { retryAfterMs?: number } }).details;
				assert.strictEqual(details?.retryAfterMs, 30_000);
				return true;
			},
		);
	});

	test('a 429 with nothing usable leaves the wait unknown', async () => {
		const provider = new OpenAICompatibleProvider({
			id: 'p',
			name: 'P',
			baseUrl: 'http://p/v1',
			fetch: async () => jsonResponse({ error: 'nope' }, { status: 429 }),
		});
		await assert.rejects(
			() => provider.streamChat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
			(error: unknown) => {
				const details = (error as { details?: { retryAfterMs?: number } }).details;
				assert.strictEqual(details?.retryAfterMs, undefined, 'no invented wait');
				return true;
			},
		);
	});

	test('a successful stream exposes the rate-limit headers', async () => {
		const provider = new OpenAICompatibleProvider({
			id: 'p',
			name: 'P',
			baseUrl: 'http://p/v1',
			fetch: async () => streamResponse([sse('ok')], { 'x-ratelimit-remaining-requests': '9' }),
		});
		const stream = await provider.streamChat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
		const headers = (stream as unknown as { responseHeaders: Record<string, string> }).responseHeaders;
		assert.strictEqual(headers['x-ratelimit-remaining-requests'], '9');
	});
});

suite('Discovery: recording and routing', () => {
	let root: string;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-discovery-5d-'));
	});

	teardown(async () => {
		await removeFixtureTree(root);
	});

	function policy(): RoutePolicy {
		return {
			retries: 0,
			retryBackoffMs: 0,
			maxRetryBackoffMs: 0,
			timeouts: { ttfbMs: 0, idleMs: 0, totalMs: 0 },
			fallbackOn: ['rate_limit', 'unavailable', 'timeout'],
			breaker: { failureThreshold: 3, windowMs: 60_000, openMs: 30_000, halfOpenProbes: 1 },
		};
	}

	function answer(text: string): ChatStream {
		const events: ChatStreamEvent[] = [
			{ type: 'TextDelta', text },
			{ type: 'Done', finishReason: 'stop' },
		];
		let index = 0;
		return {
			closedReason: 'completed',
			timing: {},
			[Symbol.asyncIterator]() {
				return {
					async next() {
						if (index < events.length) {
							const value = events[index] as ChatStreamEvent;
							index += 1;
							return { done: false, value };
						}
						return { done: true, value: undefined };
					},
				};
			},
		};
	}

	function failing(): ChatProvider {
		return {
			async streamChat(_request: ChatRequest) {
				throw new Error('should not be called');
			},
		};
	}

	test('a 429 in the route opens a window, and the next route skips that model', async () => {
		const store = new FileDataStore({ rootPath: root });
		const quota = createQuotaTracker({ now: () => clock });
		let clock = Date.parse('2026-10-20T12:00:00.000Z');
		const discovery = createProviderDiscovery({
			store,
			now: () => new Date(clock),
			quotas: quota,
		});
		const inner: ChatProvider = {
			async streamChat() {
				throw Object.assign(new Error('HTTP 429'), {
					name: 'ProviderError',
					details: { status: 429, retryAfterMs: 30_000 },
				});
			},
		};
		// The observing adapter reads `instanceof ProviderError`, so build one.
		const rejecting: ChatProvider = {
			async streamChat() {
				throw new ProviderError('HTTP 429', { details: { status: 429, retryAfterMs: 30_000 } });
			},
		};
		void inner;
		const observing = createObservingProvider({ inner: rejecting, providerId: 'p', discovery });
		const stream = runRoute({
			request: { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
			requestId: 'r1',
			targets: [{ providerId: 'p', modelId: 'm', provider: observing }],
			policy: policy(),
			breaker: new CircuitBreaker(() => policy().breaker, () => clock),
			quotas: quota,
		});
		for await (const _event of stream) {
			// consume
		}
		// The adapter's observation is fire-and-forget; let it land.
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.strictEqual(quota.check({ providerId: 'p', modelId: 'm' }).allowed, false);
		const persisted = await store.listQuotas('p');
		assert.strictEqual(persisted[0]?.account?.retryAfterMs, 30_000);

		// Second route: the model is skipped without being called.
		const stream2 = runRoute({
			request: { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
			requestId: 'r2',
			targets: [
				{ providerId: 'p', modelId: 'm', provider: failing() },
				{ providerId: 'p', modelId: 'other', provider: { streamChat: async () => answer('ok') } },
			],
			policy: policy(),
			breaker: new CircuitBreaker(() => policy().breaker, () => clock),
			quotas: quota,
		});
		const events: ChatStreamEvent[] = [];
		for await (const event of stream2) {
			events.push(event);
		}
		assert.strictEqual(events[events.length - 1]?.type, 'Done', 'the fallback answered');
		const attempts = (stream2 as unknown as { readonly recordedAttempts: readonly { readonly outcome: string; readonly errorClass?: string; readonly retryAfterMs?: number }[] }).recordedAttempts;
		assert.strictEqual(attempts[0]?.outcome, 'skipped');
		assert.strictEqual(attempts[0]?.errorClass, 'rate_limit');
		assert.ok((attempts[0]?.retryAfterMs ?? 0) > 29_000, 'the window is reported to the next route');
		// When the window turns, the model is eligible again.
		const window = quota.snapshot()[0];
		clock = (window?.untilMs ?? clock) + 1;
		assert.strictEqual(quota.check({ providerId: 'p', modelId: 'm' }).allowed, true);
	});

	test('a successful response records the account quota it carried', async () => {
		const store = new FileDataStore({ rootPath: root });
		const discovery = createProviderDiscovery({ store });
		const inner: ChatProvider = {
			async streamChat() {
				const stream = answer('ok');
				// The provider hands the rate-limit headers to the stream.
				return Object.assign(stream, {
					responseHeaders: { 'x-ratelimit-remaining-requests': '7', 'x-ratelimit-limit-requests': '20' },
				});
			},
		};
		const observing = createObservingProvider({ inner, providerId: 'p', discovery });
		await observing.streamChat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
		await new Promise((resolve) => setTimeout(resolve, 20));
		const quotas = await store.listQuotas('p');
		assert.strictEqual(quotas[0]?.account?.source, 'account');
		assert.strictEqual(quotas[0]?.account?.remaining, 7);
		assert.strictEqual(quotas[0]?.account?.limit, 20);
	});

	test('a 429 keeps the quota headers the provider sent', async () => {
		const store = new FileDataStore({ rootPath: root });
		const discovery = createProviderDiscovery({ store });
		const inner: ChatProvider = {
			async streamChat() {
				throw new ProviderError('HTTP 429', {
					details: {
						status: 429,
						retryAfterMs: 5_000,
						quotaHeaders: {
							'x-ratelimit-remaining-requests': '0',
							'x-ratelimit-limit-requests': '20',
							'authorization': 'Bearer sk-secret',
						},
					},
				});
			},
		};
		const observing = createObservingProvider({ inner, providerId: 'p', discovery });
		await assert.rejects(
			() => observing.streamChat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		const quotas = await store.listQuotas('p');
		assert.strictEqual(quotas[0]?.account?.remaining, 0);
		assert.strictEqual(quotas[0]?.account?.retryAfterMs, 5_000);
		const raw = await readFile(join(root, PROVIDER_MODELS_FILE), 'utf8');
		assert.strictEqual(raw.includes('sk-secret'), false, 'no credential in the discovery file');
	});

	test('a model that answered is confirmed for the account', async () => {		const store = new FileDataStore({ rootPath: root });
		const discovery = createProviderDiscovery({ store });
		const observing = createObservingProvider({
			inner: { streamChat: async () => answer('ok') },
			providerId: 'p',
			discovery,
		});
		await observing.streamChat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
		await new Promise((resolve) => setTimeout(resolve, 20));
		const model = await store.getDiscoveredModel({ providerId: 'p', modelId: 'm' });
		assert.ok(model?.accessConfirmedAt !== undefined);
		assert.strictEqual(model.listed, false, 'answering does not make it listed');
	});

	test('a listing failure never rejects and is reported once', async () => {
		const failures: string[] = [];
		const discovery = createProviderDiscovery({
			store: {
				applyModelListing: async () => {
					throw new Error('disk full');
				},
				confirmAccess: async () => undefined,
				recordQuota: async () => undefined,
				getDiscoveredModel: async () => undefined,
			},
			onFailure: (_error, context) => failures.push(context.phase),
		});
		const outcome = await discovery.recordListing('p', [{ id: 'm', name: 'm' }]);
		assert.strictEqual(outcome.status, 'failed');
		assert.deepStrictEqual(failures, ['listing']);
	});

	test('a listed free model is filtering-eligible only with fresh evidence', async () => {
		const store = new FileDataStore({ rootPath: root });
		const discovery = createProviderDiscovery({ store });
		const now = new Date();
		await discovery.recordListing(
			'p',
			[
				{ id: 'free', name: 'free', pricing: { currency: 'USD', unit: 'per_1m_tokens', input: 0, output: 0 } },
				{ id: 'paid', name: 'paid', pricing: { currency: 'USD', unit: 'per_1m_tokens', input: 1, output: 2 } },
				{ id: 'unknown', name: 'unknown' },
			],
			{ fetchedAt: now },
		);
		const models = await store.listDiscoveredModels('p');
		const byId = new Map(models.map((model) => [model.modelId, model]));
		assert.strictEqual(byId.get('free')?.access?.access, 'free');
		assert.strictEqual(byId.get('paid')?.access?.access, 'unknown', 'a price is not paid without evidence');
		assert.strictEqual(byId.get('paid')?.pricing?.pricing.input, 1);
		assert.strictEqual(byId.get('unknown')?.access, undefined);
	});

	test('a credential never reaches the discovery file', async () => {
		const { readFile } = await import('node:fs/promises');
		const store = new FileDataStore({ rootPath: root });
		const discovery = createProviderDiscovery({ store });
		await discovery.recordListing('p', [{ id: 'm', name: 'm' }], {
			quotaHeaders: { 'x-ratelimit-remaining-requests': '5', authorization: 'Bearer sk-should-not-appear' },
		});
		const raw = await readFile(join(root, PROVIDER_MODELS_FILE), 'utf8');
		assert.strictEqual(raw.includes('sk-should-not-appear'), false);
		assert.strictEqual(raw.includes('authorization'), false);
	});
});
