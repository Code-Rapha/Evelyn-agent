/**
 * Provider diagnostics: the latency table, and the rules around asking at all.
 *
 * Runs under plain mocha via `npm run test:core`. No Electron, no network, no
 * model call: every request goes through a fake `FetchLike` and every duration
 * comes from an injected clock, so the asserted milliseconds are exact rather
 * than "roughly however long the machine was busy".
 *
 * The claims under test, in the order they would hurt if wrong:
 *
 * 1. **A provider that is not configured is never contacted.** The known-provider
 *    list is a label, and a test that found a request to one of those endpoints
 *    would mean the label had become configuration.
 * 2. **Headers are not the first token.** A proxy that answers `200` at 40ms and
 *    then thinks for half a second must report both numbers, not the first one
 *    twice.
 * 3. **A paid model is not probed without permission**, and a keyless provider
 *    is not probed when its key is missing.
 * 4. **An unmeasurable phase is absent with a reason**, never zero.
 * 5. **No secret reaches the report.**
 */
import * as assert from 'assert';

import { OpenAICompatibleProvider } from '../core/providers/openaiCompatible';
import type { FetchLike, FetchResponseLike } from '../core/providers/openaiCompatible';
import type { PersistedProviderConfig } from '../core/providers/config';
import type { SecretStore } from '../core/providers/secrets';
import type { ModelCatalogEntry } from '../core/storage/types/modelCatalog';
import { KNOWN_PROVIDERS, diagnoseProviders } from '../desktop/providerDiagnostics';
import type { ProviderDiagnostic } from '../desktop/providerDiagnostics';

suite('Desktop: provider diagnostics', () => {
	const LOCAL_URL = 'http://127.0.0.1:20128/v1';
	const KEY_REF = 'modelhub.provider.keyed.apiKey';
	const SECRET = 'sk-do-not-leak-me-1234567890';

	/** A clock the fake network moves, so timings are exact. */
	function steps(start = 1_000): { now: () => number; advance: (ms: number) => void } {
		const state = { value: start };
		return {
			now: () => state.value,
			advance: (ms: number) => {
				state.value += ms;
			},
		};
	}

	function provider(
		overrides: Partial<PersistedProviderConfig> & Pick<PersistedProviderConfig, 'id'>,
	): PersistedProviderConfig {
		return {
			name: overrides.id,
			baseUrl: LOCAL_URL,
			enabled: true,
			...overrides,
		};
	}

	/** A store that answers `has` without pretending a read failure is an absence. */
	function secrets(values: Record<string, string> = {}): SecretStore {
		const copy = { ...values };
		return {
			get: async (ref) => copy[ref],
			store: async (ref, value) => {
				copy[ref] = value;
			},
			delete: async (ref) => {
				delete copy[ref];
			},
			has: async (ref) => copy[ref] !== undefined,
		};
	}

	interface Recorded {
		readonly url: string;
		readonly headers: Record<string, string>;
		readonly body?: string;
	}

	function json(body: unknown, status = 200): FetchResponseLike {
		return {
			ok: status >= 200 && status < 300,
			status,
			text: async () => JSON.stringify(body),
		};
	}

	/** A streamed body that moves the clock by `delays[index]` before each chunk. */
	function stream(
		chunks: readonly string[],
		options: { readonly advance?: (ms: number) => void; readonly delays?: readonly number[] } = {},
	): FetchResponseLike {
		return {
			ok: true,
			status: 200,
			text: async () => chunks.join(''),
			body: {
				[Symbol.asyncIterator]: async function* () {
					for (let index = 0; index < chunks.length; index += 1) {
						const delay = options.delays?.[index] ?? 0;
						if (delay > 0) {
							options.advance?.(delay);
						}
						yield chunks[index];
					}
				},
			},
		};
	}

	/** A body that never yields, so only the budget can end it. */
	function neverStream(signal?: AbortSignal): NonNullable<FetchResponseLike['body']> {
		const abort = (reject: (error: Error) => void): void =>
			reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
		return {
			[Symbol.asyncIterator]: () => ({
				next: () =>
					new Promise<IteratorResult<Uint8Array | string>>((_, reject) => {
						if (signal?.aborted === true) {
							abort(reject);
							return;
						}
						signal?.addEventListener('abort', () => abort(reject), { once: true });
					}),
			}),
		};
	}

	function delta(text: string): string {
		return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
	}

	const DONE = 'data: [DONE]\n\n';

	/**
	 * The live client the desktop builds, with the fake transport.
	 *
	 * Only used where the diagnostics' own secret store must differ from the
	 * provider's — every other test goes through the default `connect`, which is
	 * the production path.
	 */
	function liveClient(
		fetchImpl: FetchLike,
		now: () => number,
		store: SecretStore,
	): (config: PersistedProviderConfig) => OpenAICompatibleProvider {
		return (config) =>
			new OpenAICompatibleProvider({
				id: config.id,
				name: config.name,
				baseUrl: config.baseUrl,
				...(config.apiKeyRef !== undefined ? { apiKeyRef: config.apiKeyRef } : {}),
				enabled: config.enabled,
				fetch: fetchImpl,
				now,
				secrets: store,
			});
	}

	function row(results: readonly ProviderDiagnostic[], providerId: string, modelId?: string): ProviderDiagnostic {
		const found = results.find(
			(entry) => entry.providerId === providerId && entry.modelId === modelId,
		);
		assert.notStrictEqual(found, undefined, `no row for ${providerId}:${modelId ?? '(provider)'}`);
		return found as ProviderDiagnostic;
	}

	// ── The two numbers that get confused ──────────────────────────────────

	test('headers and first token are measured separately and reported as such', async () => {
		// The failure this guards against: a proxy that answers 200 in 40ms and
		// then queues the request for half a second. Reporting 40ms as the first
		// token makes a slow provider look instant.
		const clock = steps();
		const fetchImpl: FetchLike = async (url, init) => {
			if (url.endsWith('/models')) {
				return json({ data: [{ id: 'modelo' }] });
			}
			assert.notStrictEqual(init?.signal, undefined, 'the probe sends a signal so it can be cancelled');
			clock.advance(40);
			return stream([delta('o'), DONE], { advance: clock.advance, delays: [500, 100] });
		};

		const report = await diagnoseProviders({
			providers: [provider({ id: 'local' })],
			fetch: fetchImpl,
			knownProviders: [],
			now: clock.now,
		});

		const entry = row(report.results, 'local', 'modelo');
		assert.strictEqual(entry.outcome, 'ok');
		assert.strictEqual(entry.headersMs, 40, 'time to the HTTP response');
		assert.strictEqual(entry.firstTokenMs, 540, 'time to the first content chunk');
		assert.strictEqual(entry.totalMs, 640, 'time to the stream ending');
		assert.notStrictEqual(entry.headersMs, entry.firstTokenMs);
		assert.strictEqual(entry.unmeasured, undefined, 'all three phases were measured');
	});

	test('a stream that ends without a token reports the phase as unmeasured, not as zero', async () => {
		const clock = steps();
		const fetchImpl: FetchLike = async (url) => {
			if (url.endsWith('/models')) {
				return json({ data: [{ id: 'modelo' }] });
			}
			return stream([DONE], { advance: clock.advance, delays: [25] });
		};

		const report = await diagnoseProviders({
			providers: [provider({ id: 'local' })],
			fetch: fetchImpl,
			knownProviders: [],
			now: clock.now,
		});

		const entry = row(report.results, 'local', 'modelo');
		assert.strictEqual(entry.outcome, 'ok', 'the provider answered, it just had nothing to say');
		assert.strictEqual(entry.headersMs, 0);
		assert.strictEqual(entry.firstTokenMs, undefined, 'zero would read as an instant reply');
		assert.deepStrictEqual(
			entry.unmeasured?.map((item) => item.metric),
			['firstToken'],
		);
	});

	// ── What the probe actually sends ──────────────────────────────────────

	test('the probe is streaming, one token, and carries no tools', async () => {
		const clock = steps();
		const requests: Recorded[] = [];
		const fetchImpl: FetchLike = async (url, init) => {
			requests.push({ url, headers: init?.headers ?? {}, ...(init?.body !== undefined ? { body: init.body } : {}) });
			if (url.endsWith('/models')) {
				return json({ data: [{ id: 'modelo' }] });
			}
			return stream([delta('o'), DONE], { advance: clock.advance });
		};

		await diagnoseProviders({
			providers: [provider({ id: 'local' })],
			fetch: fetchImpl,
			knownProviders: [],
			now: clock.now,
		});

		const chat = requests.find((request) => request.url.endsWith('/chat/completions'));
		assert.notStrictEqual(chat, undefined);
		const body = JSON.parse(chat?.body ?? '{}') as Record<string, unknown>;
		assert.strictEqual(body.model, 'modelo');
		assert.strictEqual(body.stream, true);
		assert.strictEqual(body.max_tokens, 1, 'the probe must cost one token, not a generation');
		assert.strictEqual(body.tools, undefined);
		assert.strictEqual(body.tool_choice, undefined);
	});

	// ── Providers that must not be contacted ──────────────────────────────

	test('a provider that is not configured is listed and never called', async () => {
		const clock = steps();
		const urls: string[] = [];
		const fetchImpl: FetchLike = async (url) => {
			urls.push(url);
			return json({ data: [{ id: 'modelo' }] });
		};

		const report = await diagnoseProviders({
			providers: [provider({ id: 'local' })],
			fetch: fetchImpl,
			knownProviders: [
				{ id: 'local', name: 'Local' },
				{ id: 'ollama', name: 'Ollama' },
				{ id: 'openrouter', name: 'OpenRouter' },
			],
			now: clock.now,
		});

		const absent = row(report.results, 'ollama');
		assert.strictEqual(absent.outcome, 'not-configured');
		assert.strictEqual(absent.modelId, undefined, 'a provider-level row, not a model row');
		assert.strictEqual(row(report.results, 'openrouter').outcome, 'not-configured');
		// The configured one was called; the two others produced no request at
		// all, and none of the URLs points anywhere but the configured base.
		assert.ok(urls.length > 0);
		assert.ok(
			urls.every((url) => url.startsWith(LOCAL_URL)),
			`an unconfigured provider was contacted: ${urls.join(', ')}`,
		);
	});

	test('a disabled provider is reported without a request', async () => {
		const clock = steps();
		let calls = 0;
		const fetchImpl: FetchLike = async () => {
			calls += 1;
			return json({ data: [{ id: 'modelo' }] });
		};

		const report = await diagnoseProviders({
			providers: [provider({ id: 'local', enabled: false })],
			fetch: fetchImpl,
			knownProviders: [],
			now: clock.now,
		});

		assert.strictEqual(row(report.results, 'local').outcome, 'disabled');
		assert.strictEqual(calls, 0);
	});

	test('a provider whose key is missing is reported before any request', async () => {
		const clock = steps();
		let calls = 0;
		const fetchImpl: FetchLike = async () => {
			calls += 1;
			return json({ data: [{ id: 'modelo' }] });
		};

		const report = await diagnoseProviders({
			providers: [provider({ id: 'keyed', apiKeyRef: KEY_REF })],
			fetch: fetchImpl,
			secrets: secrets({}),
			knownProviders: [],
			now: clock.now,
		});

		assert.strictEqual(row(report.results, 'keyed').outcome, 'no-credentials');
		assert.strictEqual(calls, 0, 'a missing key is a known state, not a failed request');
	});

	test('a store that cannot answer does not become a missing key', async () => {
		const clock = steps();
		const store: SecretStore = {
			get: async () => {
				throw new Error('vault unavailable');
			},
			store: async () => undefined,
			delete: async () => undefined,
			has: async () => {
				throw new Error('vault unavailable');
			},
		};
		const fetchImpl: FetchLike = async (url) => {
			if (url.endsWith('/models')) {
				return json({ data: [{ id: 'modelo' }] });
			}
			return stream([delta('o'), DONE], { advance: clock.advance });
		};

		const report = await diagnoseProviders({
			providers: [provider({ id: 'keyed', apiKeyRef: KEY_REF })],
			fetch: fetchImpl,
			// The diagnostics gets a store that fails; the provider gets one that
			// works, so the test isolates "cannot read the keyring" from "has no
			// key".
			connect: liveClient(fetchImpl, clock.now, secrets({ [KEY_REF]: SECRET })),
			secrets: store,
			knownProviders: [],
			now: clock.now,
		});

		assert.strictEqual(
			row(report.results, 'keyed', 'modelo').outcome,
			'ok',
			'a read failure must not tell the user to re-enter a key they have',
		);
	});

	// ── Paid models ───────────────────────────────────────────────────────

	test('a paid model is skipped without a request unless it was allowed', async () => {
		const clock = steps();
		const posts: string[] = [];
		const fetchImpl: FetchLike = async (url, init) => {
			if (url.endsWith('/models')) {
				return json({ data: [{ id: 'brinde' }, { id: 'caro' }] });
			}
			posts.push(String(init?.body));
			return stream([delta('o'), DONE], { advance: clock.advance });
		};
		const catalog: ModelCatalogEntry[] = [
			{
				providerId: 'local',
				modelId: 'caro',
				access: 'paid',
				observations: [],
				createdAt: '2024-01-01T00:00:00.000Z',
				updatedAt: '2024-01-01T00:00:00.000Z',
			},
		];

		const blocked = await diagnoseProviders({
			providers: [provider({ id: 'local' })],
			fetch: fetchImpl,
			catalog,
			knownProviders: [],
			now: clock.now,
		});

		assert.strictEqual(row(blocked.results, 'local', 'caro').outcome, 'skipped-paid');
		assert.strictEqual(
			posts.length,
			1,
			'only the free model was probed',
		);
		assert.ok(!posts.some((body) => body.includes('"caro"')), 'no request for the paid model');

		const allowed = await diagnoseProviders({
			providers: [provider({ id: 'local' })],
			fetch: fetchImpl,
			catalog,
			allowPaid: true,
			knownProviders: [],
			now: clock.now,
		});

		assert.strictEqual(row(allowed.results, 'local', 'caro').outcome, 'ok');
		assert.strictEqual(posts.length, 3, 'both models were probed once each');
	});

	test('an unknown access is not treated as paid', async () => {
		const clock = steps();
		const posts: string[] = [];
		const fetchImpl: FetchLike = async (url, init) => {
			if (url.endsWith('/models')) {
				return json({ data: [{ id: 'modelo' }] });
			}
			posts.push(String(init?.body));
			return stream([delta('o'), DONE], { advance: clock.advance });
		};

		const report = await diagnoseProviders({
			providers: [provider({ id: 'local' })],
			fetch: fetchImpl,
			catalog: [
				{
					providerId: 'local',
					modelId: 'modelo',
					access: 'unknown',
					observations: [],
					createdAt: '2024-01-01T00:00:00.000Z',
					updatedAt: '2024-01-01T00:00:00.000Z',
				},
			],
			knownProviders: [],
			now: clock.now,
		});

		assert.strictEqual(row(report.results, 'local', 'modelo').outcome, 'ok');
		assert.strictEqual(posts.length, 1);
	});

	// ── Failure classification ────────────────────────────────────────────

	test('a rejected key is an auth error, not a generic HTTP error', async () => {
		const clock = steps();
		const fetchImpl: FetchLike = async (url) => {
			if (url.endsWith('/models')) {
				return json({ data: [{ id: 'modelo' }] });
			}
			return {
				ok: false,
				status: 401,
				text: async () => JSON.stringify({ error: { message: 'invalid key' } }),
			};
		};

		const report = await diagnoseProviders({
			providers: [provider({ id: 'keyed', apiKeyRef: KEY_REF })],
			fetch: fetchImpl,
			secrets: secrets({ [KEY_REF]: SECRET }),
			knownProviders: [],
			now: clock.now,
		});

		const entry = row(report.results, 'keyed', 'modelo');
		assert.strictEqual(entry.outcome, 'auth-error');
		assert.strictEqual(entry.httpStatus, 401);
	});

	test('a non-auth HTTP failure is an HTTP error', async () => {
		const clock = steps();
		const fetchImpl: FetchLike = async (url) => {
			if (url.endsWith('/models')) {
				return json({ data: [{ id: 'modelo' }] });
			}
			return { ok: false, status: 503, text: async () => 'unavailable' };
		};

		const report = await diagnoseProviders({
			providers: [provider({ id: 'local' })],
			fetch: fetchImpl,
			knownProviders: [],
			now: clock.now,
		});

		const entry = row(report.results, 'local', 'modelo');
		assert.strictEqual(entry.outcome, 'http-error');
		assert.strictEqual(entry.httpStatus, 503);
	});

	test('an unreachable endpoint is a network error', async () => {
		const clock = steps();
		const fetchImpl: FetchLike = async (url) => {
			if (url.endsWith('/models')) {
				return json({ data: [{ id: 'modelo' }] });
			}
			throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:20128'), {
				code: 'ECONNREFUSED',
			});
		};

		const report = await diagnoseProviders({
			providers: [provider({ id: 'local' })],
			fetch: fetchImpl,
			knownProviders: [],
			now: clock.now,
		});

		const entry = row(report.results, 'local', 'modelo');
		assert.strictEqual(entry.outcome, 'network-error');
		assert.ok(
			entry.detail === undefined || !entry.detail.includes('127.0.0.1'),
			'the message must not carry the endpoint back out',
		);
	});

	test('a provider that lists no models is reported without a probe', async () => {
		const clock = steps();
		const fetchImpl: FetchLike = async () => json({ data: [] });

		const report = await diagnoseProviders({
			providers: [provider({ id: 'local' })],
			fetch: fetchImpl,
			knownProviders: [],
			now: clock.now,
		});

		assert.strictEqual(row(report.results, 'local').outcome, 'no-models');
	});

	test('a failing model list is classified, and no chat request follows', async () => {
		const clock = steps();
		const paths: string[] = [];
		const fetchImpl: FetchLike = async (url) => {
			paths.push(url);
			return { ok: false, status: 500, text: async () => 'boom' };
		};

		const report = await diagnoseProviders({
			providers: [provider({ id: 'local' })],
			fetch: fetchImpl,
			knownProviders: [],
			now: clock.now,
		});

		assert.strictEqual(row(report.results, 'local').outcome, 'http-error');
		assert.deepStrictEqual(paths, [`${LOCAL_URL}/models`]);
	});

	test('the /models budget running out is a timeout, not an unreachable endpoint', async () => {
		const clock = steps();
		const fetchImpl: FetchLike = async (url, init) => {
			assert.ok(url.endsWith('/models'));
			return new Promise((_, reject) => {
				init?.signal?.addEventListener(
					'abort',
					() => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
					{ once: true },
				);
			});
		};

		const report = await diagnoseProviders({
			providers: [provider({ id: 'local' })],
			fetch: fetchImpl,
			modelsTimeoutMs: 20,
			knownProviders: [],
			now: clock.now,
			timeoutMs: 5_000,
		});

		assert.strictEqual(
			row(report.results, 'local').outcome,
			'timeout',
			'a budget that ran out must not be reported as a dead endpoint',
		);
	});

	// ── Timeouts and cancellation ─────────────────────────────────────────

	test('headers that never arrive are a timeout with every phase unmeasured', async () => {
		const clock = steps();
		const fetchImpl: FetchLike = async (url, init) => {
			if (url.endsWith('/models')) {
				return json({ data: [{ id: 'modelo' }] });
			}
			return new Promise((_, reject) => {
				init?.signal?.addEventListener(
					'abort',
					() => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
					{ once: true },
				);
			});
		};

		const report = await diagnoseProviders({
			providers: [provider({ id: 'local' })],
			fetch: fetchImpl,
			knownProviders: [],
			now: clock.now,
			timeoutMs: 25,
		});

		const entry = row(report.results, 'local', 'modelo');
		assert.strictEqual(entry.outcome, 'timeout');
		assert.strictEqual(entry.headersMs, undefined, 'nothing arrived, so nothing was measured');
		assert.strictEqual(entry.firstTokenMs, undefined);
		assert.strictEqual(entry.totalMs, undefined);
		assert.deepStrictEqual(
			entry.unmeasured?.map((item) => item.metric),
			['headers', 'firstToken', 'total'],
		);
	});

	test('a stream that stalls after the headers keeps the headers time and drops the total', async () => {
		const clock = steps();
		const fetchImpl: FetchLike = async (url, init) => {
			if (url.endsWith('/models')) {
				return json({ data: [{ id: 'modelo' }] });
			}
			clock.advance(30);
			return { ok: true, status: 200, body: neverStream(init?.signal), text: async () => '' };
		};

		const report = await diagnoseProviders({
			providers: [provider({ id: 'local' })],
			fetch: fetchImpl,
			knownProviders: [],
			now: clock.now,
			timeoutMs: 25,
		});

		const entry = row(report.results, 'local', 'modelo');
		assert.strictEqual(entry.outcome, 'timeout');
		assert.strictEqual(entry.headersMs, 30, 'the headers did land and are a real measurement');
		assert.strictEqual(entry.firstTokenMs, undefined);
		assert.strictEqual(
			entry.totalMs,
			undefined,
			'the wait until the budget fired is not the duration of a response',
		);
		assert.deepStrictEqual(
			entry.unmeasured?.map((item) => item.metric),
			['firstToken', 'total'],
		);
	});

	test('a caller who cancels gets `cancelled`, never `timeout`', async () => {
		const clock = steps();
		const controller = new AbortController();
		const fetchImpl: FetchLike = async (url, init) => {
			if (url.endsWith('/models')) {
				return json({ data: [{ id: 'modelo' }] });
			}
			setTimeout(() => controller.abort(), 5);
			return { ok: true, status: 200, body: neverStream(init?.signal), text: async () => '' };
		};

		const report = await diagnoseProviders({
			providers: [provider({ id: 'local' })],
			fetch: fetchImpl,
			knownProviders: [],
			now: clock.now,
			timeoutMs: 5_000,
			signal: controller.signal,
		});

		const entry = row(report.results, 'local', 'modelo');
		assert.strictEqual(entry.outcome, 'cancelled');
		assert.strictEqual(report.cancelled, true);
	});

	test('a signal that is already aborted produces no request at all', async () => {
		const clock = steps();
		const controller = new AbortController();
		controller.abort();
		let calls = 0;
		const fetchImpl: FetchLike = async () => {
			calls += 1;
			return json({ data: [{ id: 'modelo' }] });
		};

		const report = await diagnoseProviders({
			providers: [provider({ id: 'local' })],
			fetch: fetchImpl,
			knownProviders: [],
			now: clock.now,
			signal: controller.signal,
		});

		assert.strictEqual(calls, 0);
		assert.strictEqual(report.cancelled, true);
		assert.strictEqual(row(report.results, 'local').outcome, 'cancelled');
	});

	// ── Sampling and filtering ────────────────────────────────────────────

	test('only a sample of models is probed by default, and the caller can widen it', async () => {
		const clock = steps();
		const probed: string[] = [];
		const models = ['a', 'b', 'c', 'd', 'e'];
		const fetchImpl: FetchLike = async (url, init) => {
			if (url.endsWith('/models')) {
				return json({ data: models.map((id) => ({ id })) });
			}
			probed.push(String(JSON.parse(String(init?.body)).model));
			return stream([delta('o'), DONE], { advance: clock.advance });
		};

		const sample = await diagnoseProviders({
			providers: [provider({ id: 'local' })],
			fetch: fetchImpl,
			knownProviders: [],
			now: clock.now,
		});
		assert.strictEqual(sample.results.length, 3, 'a probe costs real tokens');

		probed.length = 0;
		const all = await diagnoseProviders({
			providers: [provider({ id: 'local' })],
			fetch: fetchImpl,
			knownProviders: [],
			now: clock.now,
			maxModelsPerProvider: 0,
		});
		assert.strictEqual(all.results.length, 5);
	});

	test('the caller can name the models to probe, in their own order', async () => {
		const clock = steps();
		const probed: string[] = [];
		const fetchImpl: FetchLike = async (url, init) => {
			if (url.endsWith('/models')) {
				return json({ data: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
			}
			probed.push(String(JSON.parse(String(init?.body)).model));
			return stream([delta('o'), DONE], { advance: clock.advance });
		};

		const report = await diagnoseProviders({
			providers: [provider({ id: 'local' })],
			fetch: fetchImpl,
			knownProviders: [],
			now: clock.now,
			models: ['c', 'a', 'nao-existe'],
		});

		assert.deepStrictEqual(probed, ['c', 'a'], 'a model the provider does not offer is not invented');
		assert.deepStrictEqual(
			report.results.map((entry) => entry.modelId),
			['c', 'a'],
		);
	});

	// ── Secrets ───────────────────────────────────────────────────────────

	test('no key, header or response body reaches the report', async () => {
		const clock = steps();
		const fetchImpl: FetchLike = async (url) => {
			if (url.endsWith('/models')) {
				return json({ data: [{ id: 'modelo' }] });
			}
			// A failure that carries nothing but a status: the worst case for a
			// report that copies provider text around.
			return { ok: false, status: 429, text: async () => `quota exceeded for ${SECRET}` };
		};

		const report = await diagnoseProviders({
			providers: [provider({ id: 'keyed', apiKeyRef: KEY_REF })],
			fetch: fetchImpl,
			secrets: secrets({ [KEY_REF]: SECRET }),
			knownProviders: [],
			now: clock.now,
		});

		const serialised = JSON.stringify(report);
		assert.ok(!serialised.includes(SECRET), 'the key must not appear anywhere in the report');
		assert.ok(!serialised.includes('authorization'), 'nor an authorization header');
		assert.strictEqual(row(report.results, 'keyed', 'modelo').outcome, 'http-error');
	});

	// ── Providers the product knows by name ───────────────────────────────

	test('the built-in known list is display data only', () => {
		for (const entry of KNOWN_PROVIDERS) {
			assert.deepStrictEqual(
				Object.keys(entry).sort(),
				['id', 'name'],
				'a known provider must not carry an endpoint or a key reference',
			);
		}
		assert.ok(KNOWN_PROVIDERS.some((entry) => entry.id === 'ollama'));
	});
});
