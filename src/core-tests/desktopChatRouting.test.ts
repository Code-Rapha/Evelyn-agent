/**
 * Routing through the real chat session.
 *
 * The engine has its own unit suite; this one exists to prove the wiring: that
 * a session with `routing` enabled actually routes, that the same events the
 * renderer already understands still arrive once each, and that enabling the
 * option does not change what a stop means.
 *
 * Everything is a temp file and a scripted `fetch`; nothing touches a socket.
 */
import * as assert from 'assert';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProviderConfigService } from '../core/providers/config';
import { LoggingService } from '../core/logging';
import type { FetchLike, FetchResponseLike } from '../core/providers/openaiCompatible';
import { ConsoleLogSink } from '../adapters/local/consoleLogSink';
import { FileDataStore } from '../adapters/local/fileDataStore';
import { FileSecretStore } from '../adapters/local/fileSecretStore';
import { FileStateStore } from '../adapters/local/fileStateStore';
import {
	ChatSession,
	DEFAULT_MODELS_CACHE,
	DEFAULT_ROUTE_POLICY,
	type ChatSessionOptions,
} from '../desktop/chatSession';
import type { AgentUiEvent } from '../desktop/agentTurn';
import { CircuitBreaker } from '../core/providers/routing/breaker';
import type {
	RouteAttempt,
	RoutePolicy,
	RoutingMetricsPort,
} from '../core/providers/routing/types';

/** A metrics port as the session accepts it, named for the test helpers. */
type ChatSessionMetricsInput = RoutingMetricsPort;
import type { SendMessageInput } from '../desktop/contract';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const LOCAL_URL = 'http://127.0.0.1:11434/v1';
const LOCAL_ID = '127.0.0.1-11434-v1';
const SECOND_URL = 'http://127.0.0.1:11435/v1';
const SECOND_ID = '127.0.0.1-11435-v1';

const DONE = 'data: [DONE]\n\n';

function delta(text: string): string {
	return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
}

/** A streamed tool call, in the OpenAI shape the provider's decoder expects. */
function toolChunk(id: string, name: string, args: unknown, index = 0): string {
	return `data: ${JSON.stringify({
		choices: [
			{ delta: { tool_calls: [{ index, id, function: { name, arguments: JSON.stringify(args) } }] } },
		],
	})}\n\n`;
}

/** A streamed usage chunk, in the OpenAI shape the provider's decoder expects. */
function usageChunk(prompt: number, completion: number, total: number): string {
	return `data: ${JSON.stringify({
		choices: [],
		usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total },
	})}\n\n`;
}

function sseResponse(chunks: readonly string[]): FetchResponseLike {
	return {
		ok: true,
		status: 200,
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

/** A response whose body never produces a chunk, until the signal aborts. */
function hangingResponse(signal?: AbortSignal): FetchResponseLike {
	return {
		ok: true,
		status: 200,
		body: {
			[Symbol.asyncIterator]: async function* () {
				await new Promise<void>((resolve) => {
					if (signal?.aborted === true) {
						resolve();
						return;
					}
					signal?.addEventListener('abort', () => resolve(), { once: true });
				});
			},
		},
		text: async () => '',
	};
}

/** A body that streams one delta and then breaks mid-response. */
function breakingResponse(text: string): FetchResponseLike {
	return {
		ok: true,
		status: 200,
		body: {
			[Symbol.asyncIterator]: async function* () {
				yield delta(text);
				throw new Error('the connection dropped');
			},
		},
		text: async () => '',
	};
}

function httpErrorResponse(status: number): FetchResponseLike {
	return {
		ok: false,
		status,
		text: async () => JSON.stringify({ error: { message: 'down' } }),
	};
}

interface Recorded {
	url: string;
	body?: string;
}

type PostScript = (request: { readonly index: number }) => FetchResponseLike;

/**
 * A fake server for two providers.
 *
 * `/models` answers per provider so the selector has a fallback to choose;
 * every POST is handed to `post`, which decides by provider.
 */
function scriptedFetch(
	post: (provider: 'local' | 'second', index: number) => FetchResponseLike,
): { fetchImpl: FetchLike; calls: Recorded[] } {
	const calls: Recorded[] = [];
	const counts = { local: 0, second: 0 };
	const fetchImpl: FetchLike = async (url, init) => {
		calls.push({ url, ...(init?.body !== undefined ? { body: init.body } : {}) });
		if (url.endsWith('/models')) {
			return {
				ok: true,
				status: 200,
				text: async () =>
					JSON.stringify({
						data: url.includes('11434')
							? [{ id: 'modelo-lento' }]
							: [{ id: 'modelo-rapido' }],
					}),
			};
		}
		const which = url.includes('11435') ? 'second' : 'local';
		const index = counts[which];
		counts[which] += 1;
		return post(which, index);
	};
	return { fetchImpl, calls };
}

function policy(overrides: Partial<RoutePolicy> = {}): RoutePolicy {
	return {
		retries: 0,
		retryBackoffMs: 1,
		maxRetryBackoffMs: 5,
		timeouts: { ttfbMs: 0, idleMs: 0, totalMs: 0 },
		fallbackOn: ['timeout', 'unavailable', 'rate_limit', 'network', 'upstream_error'],
		breaker: { failureThreshold: 5, windowMs: 60_000, openMs: 30_000, halfOpenProbes: 1 },
		...overrides,
	};
}

class EventLog {
	readonly events: AgentUiEvent[] = [];
	private finished: (() => void) | undefined;

	readonly sink = (event: AgentUiEvent): void => {
		this.events.push(event);
		if (event.type === 'done' || event.type === 'error') {
			this.finished?.();
		}
	};

	wait(): Promise<void> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.finished = undefined;
				reject(new Error('the turn produced no terminal event'));
			}, 4000);
			this.finished = () => {
				clearTimeout(timer);
				this.finished = undefined;
				resolve();
			};
		});
	}

	get terminals(): AgentUiEvent[] {
		return this.events.filter((event) => event.type === 'done' || event.type === 'error');
	}

	/** The event type names, in order, for assertions about what happened. */
	get types(): string[] {
		return this.events.map((event) => event.type);
	}

	get terminal(): AgentUiEvent {
		const terminal = this.terminals[0];
		assert.ok(terminal !== undefined, 'expected a terminal event');
		return terminal;
	}

	get deltas(): string {
		return this.events
			.filter((event): event is Extract<AgentUiEvent, { type: 'delta' }> => event.type === 'delta')
			.map((event) => event.text)
			.join('');
	}
}

suite('Desktop: routed chat session', () => {
	let root: string;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-routing-'));
	});

	teardown(async () => {
		await removeFixtureTree(root);
	});

	/**
	 * A decorator for the session's own catalog-backed port that mirrors each
	 * attempt into `attempts` before letting it through.
	 *
	 * Wrapping rather than replacing is the point: a test that asserts both
	 * halves of the promise at once — "each attempt was counted once" and "the
	 * winner became an observation" — needs the catalog write to happen.
	 */
	function spyingMetrics(attempts: RouteAttempt[]) {
		return (inner: RoutingMetricsPort) => ({
			recordAttempt: async (attempt: RouteAttempt) => {
				attempts.push(attempt);
				await inner.recordAttempt(attempt);
			},
		});
	}

	function session(
		fetchImpl: FetchLike,
		routing: {
			readonly policy: RoutePolicy;
			readonly attempts?: RouteAttempt[];
			/** Wraps the session's own catalog-backed port, when both are wanted. */
			readonly wrapMetrics?: ReturnType<typeof spyingMetrics>;
			/** Lets a test hand the session its own port, e.g. a broken one. */
			readonly metrics?: ChatSessionMetricsInput;
			readonly breaker?: CircuitBreaker;
		},
		options: {
			readonly turnTimeoutMs?: number;
			readonly firstTokenTimeoutMs?: number;
			readonly allowPaid?: boolean;
			/** Built lazily so every session in a test gets its own store. */
			readonly history?: () => FileDataStore;
			/** Discovery settings; absent means the session's defaults. */
			readonly models?: ChatSessionOptions['models'];
		} = {},
	): ChatSession {
		const metrics =
			routing.metrics ??
			(routing.attempts !== undefined
				? {
						recordAttempt: (attempt: RouteAttempt) => {
							routing.attempts?.push(attempt);
						},
					}
				: undefined);
		return new ChatSession({
			config: new ProviderConfigService(new FileStateStore({ filePath: join(root, 'state.json') })),
			secrets: new FileSecretStore({ filePath: join(root, 'secrets.json') }),
			history: options.history?.() ?? new FileDataStore({ rootPath: join(root, 'data') }),
			logger: new LoggingService(new ConsoleLogSink({ out: () => undefined, err: () => undefined })),
			fetchImpl,
			turnTimeoutMs: options.turnTimeoutMs ?? 5_000,
			...(options.firstTokenTimeoutMs !== undefined
				? { firstTokenTimeoutMs: options.firstTokenTimeoutMs }
				: {}),
			...(options.allowPaid !== undefined ? { allowPaid: options.allowPaid } : {}),
			...(options.models !== undefined ? { models: options.models } : {}),
			routing: {
				policy: routing.policy,
				...(routing.breaker !== undefined ? { breaker: routing.breaker } : {}),
				...(metrics !== undefined ? { metrics } : {}),
				...(routing.wrapMetrics !== undefined ? { wrapMetrics: routing.wrapMetrics } : {}),
				// Real backoff would add tens of milliseconds of test time for
				// no coverage; the schedule itself is asserted in the engine suite.
				sleep: async () => true,
			},
		});
	}

	async function twoProviderSession(
		fetchImpl: FetchLike,
		routing: Parameters<typeof session>[1],
		options: Parameters<typeof session>[2] = {},
	): Promise<ChatSession> {		const chat = session(fetchImpl, routing, options);
		await chat.saveProvider({ baseUrl: LOCAL_URL });
		await chat.saveProvider({ baseUrl: SECOND_URL });
		return chat;
	}

	/**
	 * A session with routing left off â€” the behaviour this stage must preserve.
	 *
	 * Built beside `session` rather than through it so the "no routing" case
	 * really has no `routing` option, which is what the legacy path branches on.
	 */
	function legacySession(
		fetchImpl: FetchLike,
		options: { readonly turnTimeoutMs?: number; readonly firstTokenTimeoutMs?: number } = {},
	): ChatSession {
		return new ChatSession({
			config: new ProviderConfigService(new FileStateStore({ filePath: join(root, 'state.json') })),
			secrets: new FileSecretStore({ filePath: join(root, 'secrets.json') }),
			history: new FileDataStore({ rootPath: join(root, 'data') }),
			logger: new LoggingService(new ConsoleLogSink({ out: () => undefined, err: () => undefined })),
			fetchImpl,
			turnTimeoutMs: options.turnTimeoutMs ?? 5_000,
			...(options.firstTokenTimeoutMs !== undefined
				? { firstTokenTimeoutMs: options.firstTokenTimeoutMs }
				: {}),
		});
	}

	async function sendInput(
		chat: ChatSession,
		overrides: Partial<SendMessageInput> = {},
	): Promise<SendMessageInput> {
		const conversation = await chat.createConversation({ providerId: LOCAL_ID });
		return {
			providerId: LOCAL_ID,
			conversationId: conversation.summary.id,
			model: 'llama3',
			messages: [{ role: 'user', content: 'hello' }],
			...overrides,
		};
	}

	/**
	 * A fresh conversation id for a second turn.
	 *
	 * Each turn opens its own conversation so the first one's history cannot
	 * change what the second one is scored on.
	 */
	async function anotherConversation(chat: ChatSession): Promise<string> {
		return (await chat.createConversation({ providerId: LOCAL_ID })).summary.id;
	}

	/** The stored observations for one pair, read straight from the store. */
	async function storedObservations(
		store: FileDataStore,
		providerId = LOCAL_ID,
		// The model `sendInput` names. The scripted catalog advertises
		// `modelo-lento`, which only reaches a routed turn under `fallback`.
		modelId = 'llama3',
	): Promise<readonly { firstByteMs?: number; totalMs?: number; usage?: unknown }[]> {
		const entry = await store.getModelCatalogEntry({ providerId, modelId });
		return entry?.observations ?? [];
	}

	/** A store that reads what is on disk, not the cache of whoever wrote it. */
	function freshStore(): FileDataStore {
		return new FileDataStore({ rootPath: join(root, 'data') });
	}

	test('falls back before the first visible event and answers once', async () => {
		const attempts: RouteAttempt[] = [];
		const { fetchImpl } = scriptedFetch((which) =>
			which === 'local' ? hangingResponse() : sseResponse([delta('resposta'), DONE]),
		);
		const chat = await twoProviderSession(fetchImpl, {
			policy: policy({ timeouts: { ttfbMs: 40, idleMs: 0, totalMs: 0 } }),
			attempts,
		});
		const log = new EventLog();

		await chat.sendMessage(await sendInput(chat, { strategy: 'fallback' }), log.sink);
		await log.wait();

		assert.strictEqual(log.terminals.length, 1, 'exactly one terminal event');
		assert.strictEqual(log.terminal.type, 'done');
		assert.strictEqual(log.deltas, 'resposta');
		assert.strictEqual(
			log.events.filter((event) => event.type === 'fallbackAttempted').length,
			1,
		);
		assert.deepStrictEqual(
			attempts.map((attempt) => `${attempt.modelId}:${attempt.outcome}`),
			['modelo-lento:failure', 'modelo-rapido:success'],
		);
		assert.strictEqual(attempts[0].abortCause, 'first-token');
	});

	test('does not restart an answer after text was already delivered', async () => {
		const attempts: RouteAttempt[] = [];
		const { fetchImpl } = scriptedFetch((which) =>
			which === 'local'
				? breakingResponse('parcial')
				: sseResponse([delta('segunda resposta'), DONE]),
		);
		const chat = await twoProviderSession(fetchImpl, {
			policy: policy({ timeouts: { ttfbMs: 0, idleMs: 0, totalMs: 0 } }),
			attempts,
		});
		const log = new EventLog();

		await chat.sendMessage(await sendInput(chat, { strategy: 'fallback' }), log.sink);
		await log.wait();

		assert.strictEqual(log.deltas, 'parcial');
		assert.strictEqual(log.terminal.type, 'error');
		assert.strictEqual(
			log.events.some((event) => event.type === 'fallbackAttempted'),
			false,
			'a committed attempt is never replaced',
		);
		assert.strictEqual(attempts.length, 1);
		assert.strictEqual(attempts[0].outcome, 'failure');
		assert.strictEqual(attempts[0].modelId, 'modelo-lento');
	});

	test('retries the manual model before giving up on it', async () => {
		const attempts: RouteAttempt[] = [];
		const { fetchImpl } = scriptedFetch((which, index) =>
			index === 0 ? httpErrorResponse(503) : sseResponse([delta('recuperado'), DONE]),
		);
		const chat = session(fetchImpl, {
			policy: policy({ retries: 1 }),
			attempts,
		});
		await chat.saveProvider({ baseUrl: LOCAL_URL });
		const log = new EventLog();

		await chat.sendMessage(await sendInput(chat), log.sink);
		await log.wait();

		assert.strictEqual(log.terminal.type, 'done');
		assert.strictEqual(log.deltas, 'recuperado');
		assert.deepStrictEqual(
			attempts.map((attempt) => attempt.outcome),
			['failure', 'success'],
		);
	});

	test('a stop during a routed turn ends as aborted and retries nothing', async () => {
		const attempts: RouteAttempt[] = [];
		const { fetchImpl, calls } = scriptedFetch((which) =>
			which === 'local' ? hangingResponse() : sseResponse([delta('nunca'), DONE]),
		);
		const chat = await twoProviderSession(fetchImpl, {
			// The engine's own budget is far out, so the stop is what ends it.
			policy: policy({ timeouts: { ttfbMs: 5_000, idleMs: 0, totalMs: 0 } }),
			attempts,
		});
		const log = new EventLog();

		await chat.sendMessage(await sendInput(chat, { strategy: 'fallback' }), log.sink);
		const deadline = Date.now() + 2_000;
		while (calls.filter((call) => !call.url.endsWith('/models')).length < 1 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		assert.strictEqual(chat.stop(), true, 'the running route is stoppable');

		await log.wait();
		assert.strictEqual(log.terminal.type, 'done');
		if (log.terminal.type === 'done') {
			assert.strictEqual(log.terminal.reason, 'aborted');
		}
		assert.strictEqual(log.terminals.length, 1);
		assert.strictEqual(attempts.length, 1, 'a stop is not retried');
		assert.strictEqual(attempts[0].outcome, 'cancelled');
		assert.strictEqual(
			calls.filter((call) => call.url.includes('11435') && !call.url.endsWith('/models')).length,
			0,
			'the fallback is never reached after a user stop',
		);
	});

	test('the session slot is released once a routed turn ends', async () => {
		const { fetchImpl } = scriptedFetch(() => sseResponse([delta('ok'), DONE]));
		const chat = await twoProviderSession(fetchImpl, { policy: policy() });
		const log = new EventLog();

		await chat.sendMessage(await sendInput(chat, { strategy: 'fallback' }), log.sink);
		await log.wait();

		assert.strictEqual(chat.isBusy, false);
		assert.strictEqual(chat.stop(), false);
	});

	// â”€â”€ Etapa 3: the desktop host actually routes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

	test('the policy the desktop boots with routes a retry inside one turn', async () => {
		// The real default policy, not a test-shaped one: if `main.ts` wires a
		// policy that cannot retry, this is where it shows.
		const attempts: RouteAttempt[] = [];
		const { fetchImpl } = scriptedFetch((_which, index) =>
			index === 0 ? httpErrorResponse(503) : sseResponse([delta('depois do retry'), DONE]),
		);
		const chat = session(fetchImpl, { policy: DEFAULT_ROUTE_POLICY, attempts });
		await chat.saveProvider({ baseUrl: LOCAL_URL });
		const log = new EventLog();

		await chat.sendMessage(await sendInput(chat), log.sink);
		await log.wait();

		assert.strictEqual(log.terminal.type, 'done');
		assert.strictEqual(log.deltas, 'depois do retry');
		assert.deepStrictEqual(
			attempts.map((attempt) => attempt.outcome),
			['failure', 'success'],
			'the default policy retried the same candidate',
		);
	});

	test('reads the catalog of every candidate provider, not only the current one', async () => {
		// The defect: the catalog was loaded for `input.providerId` alone, so a
		// model on a second provider was scored as if nothing were known about
		// it. Here the entry that decides the plan belongs to the *other*
		// provider, and the primary must come from there.
		const { fetchImpl, calls } = scriptedFetch(() => sseResponse([delta('ok'), DONE]));
		const chat = await twoProviderSession(fetchImpl, { policy: policy() });
		await chat.saveModelCatalogEntry({ providerId: SECOND_ID, modelId: 'modelo-rapido', access: 'free' });
		for (let i = 0; i < 10; i += 1) {
			await chat.recordModelObservation({ providerId: SECOND_ID, modelId: 'modelo-rapido' }, { totalMs: 1_000 });
		}
		const log = new EventLog();

		// Sent through the *local* provider: the second provider's catalog must
		// still be read.
		await chat.sendMessage(await sendInput(chat, { strategy: 'fallback' }), log.sink);
		await log.wait();

		const posts = calls.filter((call) => !call.url.endsWith('/models'));
		assert.ok(posts.length >= 1, 'the turn reached a model');
		assert.ok(
			posts[0].url.includes('11435'),
			'the described model on the second provider won the plan',
		);
	});

	test('never reaches a paid model, not even as a fallback', async () => {
		// The local candidate stalls, so the only way this turn could end well
		// would be through the second model â€” which is paid. It must not be
		// used, so the turn fails instead.
		const { fetchImpl, calls } = scriptedFetch((which) =>
			which === 'local' ? hangingResponse() : sseResponse([delta('pago'), DONE]),
		);
		const chat = await twoProviderSession(fetchImpl, {
			policy: policy({ timeouts: { ttfbMs: 40, idleMs: 0, totalMs: 0 } }),
		});
		await chat.saveModelCatalogEntry({ providerId: SECOND_ID, modelId: 'modelo-rapido', access: 'paid' });
		for (let i = 0; i < 10; i += 1) {
			await chat.recordModelObservation({ providerId: SECOND_ID, modelId: 'modelo-rapido' }, { totalMs: 1_000 });
		}
		const log = new EventLog();

		await chat.sendMessage(await sendInput(chat, { strategy: 'fallback' }), log.sink);
		await log.wait();

		assert.strictEqual(
			calls.filter((call) => call.url.includes('11435') && !call.url.endsWith('/models')).length,
			0,
			'a paid fallback is never attempted without authorization',
		);
		assert.strictEqual(log.terminal.type, 'error');
	});

	test('the circuit breaker remembers a failing endpoint between turns', async () => {
		const { fetchImpl, calls } = scriptedFetch(() => httpErrorResponse(503));
		const chat = await twoProviderSession(fetchImpl, {
			policy: policy({
				timeouts: { ttfbMs: 0, idleMs: 0, totalMs: 0 },
				// One failure is enough to open, and the window is far longer
				// than the test so a reopened circuit is unambiguous.
				breaker: { failureThreshold: 1, windowMs: 60_000, openMs: 60_000, halfOpenProbes: 1 },
			}),
		});

		const first = new EventLog();
		await chat.sendMessage(await sendInput(chat, { strategy: 'fallback' }), first.sink);
		await first.wait();
		const afterFirst = calls.filter((call) => !call.url.endsWith('/models')).length;
		assert.ok(afterFirst >= 1, 'the first turn really called the endpoints');

		// A second turn, on its own conversation. A breaker rebuilt per turn
		// would forget and call the dead endpoints again; a session-wide one
		// skips them without a request.
		const second = new EventLog();
		await chat.sendMessage(await sendInput(chat, { strategy: 'fallback' }), second.sink);
		await second.wait();
		const afterSecond = calls.filter((call) => !call.url.endsWith('/models')).length;

		assert.strictEqual(afterSecond, afterFirst, 'the open circuits were not called again');
		assert.strictEqual(second.terminal.type, 'error');
	});

	test('after a tool round the pinned model keeps the turn', async () => {
		// The first round produces a tool call, which commits the local model.
		// The second round â€” after the tool ran â€” must go to that same model.
		// It fails there, and the second provider must not be used to continue
		// a transcript the first model started.
		let localPosts = 0;
		const fetchImpl: FetchLike = async (url) => {
			if (url.endsWith('/models')) {
				return {
					ok: true,
					status: 200,
					text: async () =>
						JSON.stringify({
							data: url.includes('11434') ? [{ id: 'modelo-lento' }] : [{ id: 'modelo-rapido' }],
						}),
				};
			}
			if (url.includes('11434')) {
				localPosts += 1;
				if (localPosts === 1) {
					return sseResponse([toolChunk('c1', 'list_files', { path: '.' }), DONE]);
				}
				return httpErrorResponse(503);
			}
			return sseResponse([delta('segundo modelo'), DONE]);
		};
		const chat = await twoProviderSession(fetchImpl, {
			policy: policy({ timeouts: { ttfbMs: 0, idleMs: 0, totalMs: 0 } }),
		});
		const project = await chat.createProject({ rootPath: root });
		const conversation = await chat.createConversation({
			providerId: LOCAL_ID,
			projectId: project.id,
		});
		const log = new EventLog();

		await chat.sendMessage(
			{
				providerId: LOCAL_ID,
				conversationId: conversation.summary.id,
				model: 'modelo-lento',
				messages: [{ role: 'user', content: 'liste os arquivos' }],
				strategy: 'fallback',
			},
			log.sink,
		);
		await log.wait();

		assert.strictEqual(localPosts, 2, 'the pinned model served both rounds');
		assert.strictEqual(log.terminal.type, 'error');
		assert.ok(log.types.includes('toolCall'), 'the tool round really happened');
	});

	test('a session without routing keeps the legacy outer-loop fallback', async () => {
		const posts: string[] = [];
		const fetchImpl: FetchLike = async (url, init) => {
			if (url.endsWith('/models')) {
				return {
					ok: true,
					status: 200,
					text: async () =>
						JSON.stringify({
							data: url.includes('11434') ? [{ id: 'modelo-lento' }] : [{ id: 'modelo-rapido' }],
						}),
				};
			}
			const second = url.includes('11435');
			posts.push(second ? 'segundo' : 'primeiro');
			// The stalled body has to honour the signal: with no engine to race
			// it, the legacy path's own abort is the only thing that ends it.
			return second ? sseResponse([delta('legado'), DONE]) : hangingResponse(init?.signal);
		};
		const chat = legacySession(fetchImpl, { firstTokenTimeoutMs: 40, turnTimeoutMs: 5_000 });
		await chat.saveProvider({ baseUrl: LOCAL_URL });
		await chat.saveProvider({ baseUrl: SECOND_URL });
		const log = new EventLog();

		await chat.sendMessage(await sendInput(chat, { strategy: 'fallback' }), log.sink);
		await log.wait();

		assert.strictEqual(log.terminal.type, 'done');
		assert.strictEqual(log.deltas, 'legado');
		assert.strictEqual(
			log.events.filter((event) => event.type === 'fallbackAttempted').length,
			1,
			'the outer loop, not the engine, narrated the fallback',
		);
		assert.deepStrictEqual(posts, ['primeiro', 'segundo']);
	});

	// â”€â”€ Etapa 4A: real routing metrics reach the catalog â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

	test('a real answer is measured into the catalog', async () => {
		// No injected metrics port: the session builds the catalog-backed one,
		// which is the wiring a boot has. The numbers come from the provider's
		// own stream timing, not from anything the test made up.
		const attempts: RouteAttempt[] = [];
		const { fetchImpl } = scriptedFetch(() =>
			sseResponse([delta('resposta'), usageChunk(7, 3, 10), DONE]),
		);
		const chat = session(fetchImpl, { policy: policy(), wrapMetrics: spyingMetrics(attempts) });
		await chat.saveProvider({ baseUrl: LOCAL_URL });
		const log = new EventLog();

		await chat.sendMessage(await sendInput(chat), log.sink);
		await log.wait();

		assert.strictEqual(log.terminal.type, 'done');
		assert.strictEqual(attempts.length, 1);
		const observations = await storedObservations(freshStore());
		assert.strictEqual(observations.length, 1, 'one answered attempt, one observation');
		const [observation] = observations;
		assert.strictEqual(typeof observation.totalMs, 'number');
		assert.ok((observation.totalMs ?? -1) >= 0);
		assert.ok(typeof observation.firstByteMs === 'number', 'the headers landed and were measured');
		assert.deepStrictEqual(observation.usage, {
			promptTokens: 7,
			completionTokens: 3,
			totalTokens: 10,
		});
	});

	test('a provider that reports no usage leaves it absent, not zero', async () => {
		const attempts: RouteAttempt[] = [];
		const { fetchImpl } = scriptedFetch(() => sseResponse([delta('sem uso'), DONE]));
		const chat = session(fetchImpl, { policy: policy(), wrapMetrics: spyingMetrics(attempts) });
		await chat.saveProvider({ baseUrl: LOCAL_URL });
		const log = new EventLog();

		await chat.sendMessage(await sendInput(chat), log.sink);
		await log.wait();

		assert.strictEqual(attempts.length, 1);
		// The attempt itself has no usage either: nothing was reported, so
		// nothing is made up at either layer.
		assert.strictEqual('usage' in attempts[0], false);
		const [observation] = await storedObservations(freshStore());
		assert.ok(observation !== undefined);
		assert.strictEqual('usage' in observation, false, 'absence is not a zero count');
	});

	test('only the answered attempt becomes a latency', async () => {
		// The local candidate fails with a 503 and the second answers. Both are
		// attempts; only the answer is a measurement of how long a model takes,
		// and the failing one must not drag either median down.
		const store = new FileDataStore({ rootPath: join(root, 'data') });
		const attempts: RouteAttempt[] = [];
		const { fetchImpl } = scriptedFetch((which) =>
			which === 'local' ? httpErrorResponse(503) : sseResponse([delta('bom'), DONE]),
		);
		const chat = await twoProviderSession(
			fetchImpl,
			{ policy: policy(), wrapMetrics: spyingMetrics(attempts) },
			{ history: () => store },
		);
		const log = new EventLog();

		await chat.sendMessage(await sendInput(chat, { strategy: 'fallback' }), log.sink);
		await log.wait();

		assert.strictEqual(attempts.length, 2, 'both attempts were counted once each');
		assert.deepStrictEqual(
			attempts.map((attempt) => `${attempt.modelId}:${attempt.fallback}`),
			['modelo-lento:false', 'modelo-rapido:true'],
		);
		assert.strictEqual((await storedObservations(freshStore())).length, 0, 'the failure is not a latency');
		assert.strictEqual(
			(await storedObservations(freshStore(), SECOND_ID, 'modelo-rapido')).length,
			1,
		);
	});

	test('a timeout is recorded as an attempt with its budget, never as a latency', async () => {
		const store = new FileDataStore({ rootPath: join(root, 'data') });
		const attempts: RouteAttempt[] = [];
		const { fetchImpl } = scriptedFetch(() => hangingResponse());
		// One candidate only, so the route fails rather than moving on.
		const chat = session(
			fetchImpl,
			{ policy: policy({ timeouts: { ttfbMs: 30, idleMs: 0, totalMs: 0 } }), attempts },
			{ history: () => store },
		);
		await chat.saveProvider({ baseUrl: LOCAL_URL });
		const log = new EventLog();

		await chat.sendMessage(await sendInput(chat), log.sink);
		await log.wait();

		assert.strictEqual(log.terminal.type, 'error');
		assert.strictEqual(attempts.length, 1);
		assert.strictEqual(attempts[0].outcome, 'failure');
		assert.strictEqual(attempts[0].abortCause, 'first-token');
		assert.strictEqual(
			(await storedObservations(freshStore())).length,
			0,
			'a budget that fired is not the model being fast',
		);
	});

	test('a cancellation is recorded once and never becomes a latency', async () => {
		const store = new FileDataStore({ rootPath: join(root, 'data') });
		const attempts: RouteAttempt[] = [];
		const { fetchImpl, calls } = scriptedFetch(() => hangingResponse());
		const chat = session(
			fetchImpl,
			{ policy: policy({ timeouts: { ttfbMs: 5_000, idleMs: 0, totalMs: 0 } }), attempts },
			{ history: () => store },
		);
		await chat.saveProvider({ baseUrl: LOCAL_URL });
		const log = new EventLog();

		await chat.sendMessage(await sendInput(chat), log.sink);
		const deadline = Date.now() + 2_000;
		while (calls.filter((call) => !call.url.endsWith('/models')).length < 1 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		assert.strictEqual(chat.stop(), true);
		await log.wait();

		assert.strictEqual(attempts.length, 1);
		assert.strictEqual(attempts[0].outcome, 'cancelled');
		assert.strictEqual('totalMs' in attempts[0], false, 'a cancelled attempt measured no total');
		assert.strictEqual((await storedObservations(freshStore())).length, 0);
	});

	test('a retry and a fallback are counted once each, and only the winner is observed', async () => {
		const store = new FileDataStore({ rootPath: join(root, 'data') });
		const attempts: RouteAttempt[] = [];
		const { fetchImpl } = scriptedFetch((which, index) => {
			if (which === 'local') {
				return httpErrorResponse(503);
			}
			return index === 0 ? httpErrorResponse(503) : sseResponse([delta('terceira'), DONE]);
		});
		const chat = await twoProviderSession(
			fetchImpl,
			{
				policy: policy({
					retries: 1,
					retryBackoffMs: 1,
					maxRetryBackoffMs: 1,
					fallbackOn: ['unavailable'],
				}),
				wrapMetrics: spyingMetrics(attempts),
			},
			{ history: () => store },
		);
		const log = new EventLog();

		await chat.sendMessage(await sendInput(chat, { strategy: 'fallback' }), log.sink);
		await log.wait();

		assert.strictEqual(log.terminal.type, 'done');
		assert.deepStrictEqual(
			attempts.map((attempt) => `${attempt.modelId}:${attempt.retry}:${attempt.fallback}:${attempt.outcome}`),
			[
				'modelo-lento:false:false:failure',
				'modelo-lento:true:false:failure',
				'modelo-rapido:false:true:failure',
				'modelo-rapido:true:true:success',
			],
			'each attempt appears once, with the reason it was reached',
		);
		assert.strictEqual((await storedObservations(freshStore())).length, 0);
		assert.strictEqual((await storedObservations(freshStore(), SECOND_ID, 'modelo-rapido')).length, 1);
	});

	test('observations survive into a later turn and reach the selector', async () => {
		// The point of persisting them at all: the next turn's plan has to see
		// what the previous one measured, across a fresh session object over the
		// same store. Both turns are manual sends to the same model, so the
		// window grows by exactly one each time and no selection has to agree.
		const store = new FileDataStore({ rootPath: join(root, 'data') });
		const firstAttempts: RouteAttempt[] = [];
		const { fetchImpl } = scriptedFetch(() => sseResponse([delta('medido'), DONE]));
		const first = session(
			fetchImpl,
			{ policy: policy(), wrapMetrics: spyingMetrics(firstAttempts) },
			{ history: () => store },
		);
		await first.saveProvider({ baseUrl: LOCAL_URL });
		const log = new EventLog();

		await first.sendMessage(await sendInput(first), log.sink);
		await log.wait();
		assert.strictEqual(firstAttempts.length, 1);
		assert.strictEqual((await storedObservations(freshStore())).length, 1);

		// A second session over the same files, as a restart would be.
		const reopened = new FileDataStore({ rootPath: join(root, 'data') });
		const second = session(fetchImpl, { policy: policy() }, { history: () => reopened });
		const before = await second.getModelCatalogEntry({
			providerId: LOCAL_ID,
			modelId: 'llama3',
		});
		assert.strictEqual(before?.observations, 1, 'the stored observation is still there');
		assert.ok(before?.medianTotalMs !== undefined, 'and it is readable as a median');

		const nextLog = new EventLog();
		await second.sendMessage(
			await sendInput(second, { conversationId: await anotherConversation(second) }),
			nextLog.sink,
		);
		await nextLog.wait();
		assert.strictEqual(
			(await storedObservations(freshStore())).length,
			2,
			'the second turn appended to the same window',
		);
	});

	test('a broken metrics port does not interrupt the answer', async () => {
		const { fetchImpl } = scriptedFetch(() => sseResponse([delta('resposta vale'), DONE]));
		const chat = session(fetchImpl, {
			policy: policy(),
			metrics: {
				recordAttempt: () => {
					throw new Error('the metrics store is unavailable');
				},
			},
		});
		await chat.saveProvider({ baseUrl: LOCAL_URL });
		const log = new EventLog();

		await chat.sendMessage(await sendInput(chat), log.sink);
		await log.wait();

		assert.strictEqual(log.terminal.type, 'done');
		assert.strictEqual(log.deltas, 'resposta vale');
	});

	test('no attempt record carries the prompt, the answer or the key', async () => {
		const attempts: RouteAttempt[] = [];
		const fetchImpl: FetchLike = async (url, init) => {
			if (url.endsWith('/models')) {
				return {
					ok: true,
					status: 200,
					text: async () => JSON.stringify({ data: [{ id: 'modelo-lento' }] }),
				};
			}
			// Every request carries a bearer key; the attempt must not.
			assert.ok(init?.headers !== undefined);
			return sseResponse([delta('a resposta privada'), usageChunk(1, 2, 3), DONE]);
		};
		const chat = session(fetchImpl, { policy: policy(), wrapMetrics: spyingMetrics(attempts) });
		await chat.saveProvider({ baseUrl: LOCAL_URL, apiKey: 'sk-live-should-never-be-recorded' });
		const log = new EventLog();

		await chat.sendMessage(
			await sendInput(chat, {
				messages: [{ role: 'user', content: 'segredo do prompt do usuÃ¡rio' }],
			}),
			log.sink,
		);
		await log.wait();

		assert.strictEqual(attempts.length, 1);
		const serialized = JSON.stringify(attempts[0]);
		assert.strictEqual(serialized.includes('segredo do prompt'), false);
		assert.strictEqual(serialized.includes('resposta privada'), false);
		assert.strictEqual(serialized.includes('sk-live-should-never-be-recorded'), false);
		assert.strictEqual(serialized.includes('Bearer'), false);
		// The observation the same attempt produced carries none of it either.
		const observation = JSON.stringify(await storedObservations(freshStore()));
		assert.strictEqual(observation.includes('sk-live-should-never-be-recorded'), false);
		assert.strictEqual(observation.includes('Bearer'), false);
		assert.strictEqual(observation.includes('resposta privada'), false);
	});

	test('a manual pick of a paid model is refused without authorization', async () => {
		// A click on a paid model is a preference, not a budget. Nothing is sent
		// to the provider, and the turn ends with one clear error.
		const { fetchImpl, calls } = scriptedFetch(() => sseResponse([delta('pago'), DONE]));
		const chat = session(fetchImpl, { policy: policy() });
		await chat.saveProvider({ baseUrl: LOCAL_URL });
		await chat.saveModelCatalogEntry({ providerId: LOCAL_ID, modelId: 'modelo-lento', access: 'paid' });
		const log = new EventLog();

		await chat.sendMessage(
			await sendInput(chat, { model: 'modelo-lento', strategy: 'manual' }),
			log.sink,
		);
		await log.wait();

		assert.strictEqual(log.terminal.type, 'error');
		assert.strictEqual(
			calls.filter((call) => !call.url.endsWith('/models')).length,
			0,
			'a paid model is never contacted without authorization',
		);
		assert.strictEqual(chat.isBusy, false, 'the refusal released the turn slot');
	});

	test('a manual pick of a paid model runs once spending is authorized', async () => {
		const { fetchImpl, calls } = scriptedFetch(() => sseResponse([delta('pago'), DONE]));
		const chat = session(fetchImpl, { policy: policy() }, { allowPaid: true });
		await chat.saveProvider({ baseUrl: LOCAL_URL });
		await chat.saveModelCatalogEntry({ providerId: LOCAL_ID, modelId: 'modelo-lento', access: 'paid' });
		const log = new EventLog();

		await chat.sendMessage(
			await sendInput(chat, { model: 'modelo-lento', strategy: 'manual' }),
			log.sink,
		);
		await log.wait();

		assert.strictEqual(log.terminal.type, 'done');
		assert.strictEqual(log.deltas, 'pago');
		assert.ok(calls.some((call) => !call.url.endsWith('/models')));
	});

	test('a manual model nobody has described still runs without authorization', async () => {
		// `unknown` access is not evidence of a charge; refusing it would make
		// every unclassified model unusable.
		const { fetchImpl } = scriptedFetch(() => sseResponse([delta('desconhecido'), DONE]));
		const chat = session(fetchImpl, { policy: policy() });
		await chat.saveProvider({ baseUrl: LOCAL_URL });
		const log = new EventLog();

		await chat.sendMessage(
			await sendInput(chat, { model: 'modelo-lento', strategy: 'manual' }),
			log.sink,
		);
		await log.wait();

		assert.strictEqual(log.terminal.type, 'done');
		assert.strictEqual(log.deltas, 'desconhecido');
	});
});

suite('Desktop: model discovery in the chat session', () => {
	let root: string;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-discovery-'));
	});

	teardown(async () => {
		await removeFixtureTree(root);
	});

	function session(
		fetchImpl: FetchLike,
		models?: ChatSessionOptions['models'],
	): ChatSession {
		return new ChatSession({
			config: new ProviderConfigService(new FileStateStore({ filePath: join(root, 'state.json') })),
			secrets: new FileSecretStore({ filePath: join(root, 'secrets.json') }),
			history: new FileDataStore({ rootPath: join(root, 'data') }),
			logger: new LoggingService(new ConsoleLogSink({ out: () => undefined, err: () => undefined })),
			fetchImpl,
			...(models !== undefined ? { models } : {}),
		});
	}

	/** A fake server: `/models` per port, chat streams, and every call recorded. */
	function server(options: {
		readonly models?: (url: string) => FetchResponseLike;
	} = {}): { fetchImpl: FetchLike; calls: Recorded[] } {
		const calls: Recorded[] = [];
		const fetchImpl: FetchLike = async (url, init) => {
			calls.push({ url, ...(init?.body !== undefined ? { body: init.body } : {}) });
			if (url.endsWith('/models')) {
				return (
					options.models?.(url) ?? {
						ok: true,
						status: 200,
						text: async () =>
							JSON.stringify({
								data: url.includes('11435')
									? [{ id: 'modelo-rapido' }, { id: 'org/Modelo-Exato:2' }]
									: [{ id: 'modelo-lento' }],
							}),
					}
				);
			}
			return sseResponse([delta('ok'), DONE]);
		};
		return { fetchImpl, calls };
	}

	const modelCalls = (calls: readonly Recorded[]): string[] =>
		calls.filter((call) => call.url.endsWith('/models')).map((call) => call.url);

	test('the session defaults are the documented ones', () => {
		assert.strictEqual(DEFAULT_MODELS_CACHE.ttlMs, 60_000);
		assert.strictEqual(DEFAULT_MODELS_CACHE.staleIfErrorMs, 15 * 60_000);
		assert.strictEqual(DEFAULT_MODELS_CACHE.concurrency, 3);
	});

	test('a second listing within the TTL does not ask the endpoints again', async () => {
		const { fetchImpl, calls } = server();
		const chat = session(fetchImpl);
		await chat.saveProvider({ baseUrl: LOCAL_URL });
		await chat.saveProvider({ baseUrl: SECOND_URL });

		const first = await chat.listAvailableModels();
		const second = await chat.listAvailableModels();

		assert.strictEqual(modelCalls(calls).length, 2, 'one request per provider, once');
		assert.deepStrictEqual(second, first);
	});

	test('listModels and listAvailableModels share the same cached answer', async () => {
		const { fetchImpl, calls } = server();
		const chat = session(fetchImpl);
		await chat.saveProvider({ baseUrl: LOCAL_URL });

		const ids = await chat.listModels(LOCAL_ID);
		const available = await chat.listAvailableModels();

		assert.deepStrictEqual(ids, ['modelo-lento']);
		assert.deepStrictEqual(
			available.map((model) => model.model),
			['modelo-lento'],
		);
		assert.strictEqual(modelCalls(calls).length, 1);
	});

	test('the TTL expires and the next listing refreshes', async () => {
		let now = 1_000;
		const { fetchImpl, calls } = server();
		const chat = session(fetchImpl, { ttlMs: 1_000, now: () => now });
		await chat.saveProvider({ baseUrl: LOCAL_URL });

		await chat.listAvailableModels();
		now += 1_000;
		await chat.listAvailableModels();

		assert.strictEqual(modelCalls(calls).length, 2);
	});

	test('concurrent listings share one request per provider', async () => {
		const { fetchImpl, calls } = server();
		const chat = session(fetchImpl);
		await chat.saveProvider({ baseUrl: LOCAL_URL });
		await chat.saveProvider({ baseUrl: SECOND_URL });

		await Promise.all([
			chat.listAvailableModels(),
			chat.listAvailableModels(),
			chat.listAvailableModels(),
		]);

		assert.strictEqual(modelCalls(calls).length, 2, 'one per provider, not one per call');
	});

	test('a failed refresh serves the previous answer inside the stale window', async () => {
		let now = 1_000;
		let mode: 'ok' | 'fail' = 'ok';
		const fetchImpl: FetchLike = async (url) => {
			if (url.endsWith('/models')) {
				if (mode === 'fail') {
					throw new Error('ECONNREFUSED');
				}
				return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'antes' }] }) };
			}
			return sseResponse([delta('ok'), DONE]);
		};
		const chat = session(fetchImpl, { ttlMs: 1_000, staleIfErrorMs: 60_000, now: () => now });
		await chat.saveProvider({ baseUrl: LOCAL_URL });
		await chat.listAvailableModels();

		now += 2_000;
		mode = 'fail';
		const stale = await chat.listAvailableModels();

		assert.deepStrictEqual(
			stale.map((model) => model.model),
			['antes'],
		);
	});

	test('a failure with nothing cached leaves the other providers listed', async () => {
		const { fetchImpl } = server({
			models: (url) => {
				if (url.includes('11434')) {
					throw new Error('ECONNREFUSED');
				}
				return {
					ok: true,
					status: 200,
					text: async () => JSON.stringify({ data: [{ id: 'modelo-rapido' }] }),
				};
			},
		});
		const chat = session(fetchImpl);
		await chat.saveProvider({ baseUrl: LOCAL_URL });
		await chat.saveProvider({ baseUrl: SECOND_URL });

		const available = await chat.listAvailableModels();

		assert.deepStrictEqual(available.map((model) => model.providerId), [SECOND_ID]);
		// And the failure is not remembered: the endpoint is asked again.
		const retry = await chat.listAvailableModels();
		assert.deepStrictEqual(retry, available);
	});

	test('a cancelled listing rejects and leaves no answer cached', async function () {
		this.timeout(10_000);
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let modelsCalls = 0;
		const fetchImpl: FetchLike = async (url, init) => {
			if (!url.endsWith('/models')) {
				return sseResponse([delta('ok'), DONE]);
			}
			modelsCalls += 1;
			// A fake that honours the abort, as a real socket does: the request
			// waits on the gate or on the cancellation, whichever comes first.
			const signal = init?.signal;
			await new Promise<void>((resolve) => {
				signal?.addEventListener('abort', () => resolve(), { once: true });
				void gate.then(() => resolve());
			});
			return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'tarde' }] }) };
		};
		const chat = session(fetchImpl);
		await chat.saveProvider({ baseUrl: LOCAL_URL });
		const controller = new AbortController();

		const pending = chat.listAvailableModels({ signal: controller.signal });
		// A caller that leaves gets a rejection, not a short list that would
		// read as if the endpoint advertised nothing.
		await new Promise((resolve) => setTimeout(resolve, 20));
		controller.abort();
		await assert.rejects(pending);

		// The next caller joins the request still in flight instead of opening
		// a second one, so the cancelled caller never poisoned the cache.
		release();
		const after = await chat.listAvailableModels();
		assert.strictEqual(modelsCalls, 1, 'the cancelled caller did not leave a cached answer behind');
		assert.deepStrictEqual(
			after.map((model) => model.model),
			['tarde'],
		);
	});

	test('a discovery that hangs is bounded by the session timeout', async () => {
		let modelsCalls = 0;
		const fetchImpl: FetchLike = async (url, init) => {
			if (!url.endsWith('/models')) {
				return sseResponse([delta('ok'), DONE]);
			}
			modelsCalls += 1;
			// The endpoint accepts the request and never answers.
			const signal = init?.signal;
			await new Promise<void>((resolve) => {
				signal?.addEventListener('abort', () => resolve(), { once: true });
			});
			throw new Error('the request was cancelled');
		};
		const chat = session(fetchImpl, { timeoutMs: 20 });
		await chat.saveProvider({ baseUrl: LOCAL_URL });

		const started = Date.now();
		const available = await chat.listAvailableModels();

		assert.deepStrictEqual(available, []);
		assert.strictEqual(modelsCalls, 1);
		assert.ok(Date.now() - started < 2_000, 'the hang did not exceed the bound by much');
	});

	test('manual invalidation refreshes the next listing', async () => {
		let answer = 'antes';
		const { fetchImpl, calls } = server({
			models: () => ({
				ok: true,
				status: 200,
				text: async () => JSON.stringify({ data: [{ id: answer }] }),
			}),
		});
		const chat = session(fetchImpl);
		await chat.saveProvider({ baseUrl: LOCAL_URL });
		await chat.listAvailableModels();

		answer = 'depois';
		chat.invalidateModelCache(LOCAL_ID);
		const after = await chat.listAvailableModels();

		assert.deepStrictEqual(
			after.map((model) => model.model),
			['depois'],
		);
		assert.strictEqual(modelCalls(calls).length, 2);
	});

	test('editing a provider forgets the answer discovered from the old URL', async () => {
		const seen: string[] = [];
		const fetchImpl: FetchLike = async (url) => {
			if (url.endsWith('/models')) {
				seen.push(url);
				return {
					ok: true,
					status: 200,
					text: async () =>
						JSON.stringify({ data: [{ id: url.includes('20000') ? 'novo' : 'antigo' }] }),
				};
			}
			return sseResponse([delta('ok'), DONE]);
		};
		const chat = session(fetchImpl);
		await chat.saveProvider({ baseUrl: LOCAL_URL });
		await chat.listAvailableModels();

		await chat.saveProvider({ id: LOCAL_ID, baseUrl: 'http://127.0.0.1:20000/v1' });
		const after = await chat.listAvailableModels();

		assert.deepStrictEqual(
			after.map((model) => model.model),
			['novo'],
		);
		assert.ok(seen.some((url) => url.includes('20000')));
	});

	test('the discovered ids are the endpoint ids, exactly', async () => {
		const { fetchImpl } = server();
		const chat = session(fetchImpl);
		await chat.saveProvider({ baseUrl: SECOND_URL });

		const available = await chat.listAvailableModels();

		assert.deepStrictEqual(
			available.map((model) => model.model),
			['modelo-rapido', 'org/Modelo-Exato:2'],
		);
	});

	test('a disabled provider is still skipped without a request', async () => {
		const { fetchImpl, calls } = server();
		const chat = session(fetchImpl);
		await chat.saveProvider({ baseUrl: LOCAL_URL });
		await new ProviderConfigService(
			new FileStateStore({ filePath: join(root, 'state.json') }),
		).save({ id: SECOND_ID, name: 'second', baseUrl: SECOND_URL, enabled: false });

		const available = await chat.listAvailableModels();

		assert.deepStrictEqual(
			available.map((model) => model.providerId),
			[LOCAL_ID],
		);
		assert.ok(modelCalls(calls).every((url) => url.includes('11434')));
	});

	test('discovery writes nothing to the capability catalog', async () => {
		const { fetchImpl } = server();
		const chat = session(fetchImpl);
		await chat.saveProvider({ baseUrl: LOCAL_URL });
		const before = await chat.listModelCatalog();

		await chat.listAvailableModels();

		assert.deepStrictEqual(await chat.listModelCatalog(), before);
	});

	test('no key reaches the cache, the listing or the log', async () => {
		const logged: string[] = [];
		const fetchImpl: FetchLike = async (url) => {
			if (url.endsWith('/models')) {
				return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'modelo' }] }) };
			}
			return sseResponse([delta('ok'), DONE]);
		};
		const chat = new ChatSession({
			config: new ProviderConfigService(new FileStateStore({ filePath: join(root, 'state.json') })),
			secrets: new FileSecretStore({ filePath: join(root, 'secrets.json') }),
			history: new FileDataStore({ rootPath: join(root, 'data') }),
			logger: new LoggingService(
				new ConsoleLogSink({
					out: (line: string) => logged.push(line),
					err: (line: string) => logged.push(line),
				}),
			),
			fetchImpl,
		});
		await chat.saveProvider({ baseUrl: LOCAL_URL, apiKey: 'sk-discovery-DO-NOT-LEAK-4242' });
		const listed = await chat.listAvailableModels();
		// A stale answer and a dead endpoint log too; neither may carry the key.
		const broken = new ChatSession({
			config: new ProviderConfigService(new FileStateStore({ filePath: join(root, 'state.json') })),
			secrets: new FileSecretStore({ filePath: join(root, 'secrets.json') }),
			history: new FileDataStore({ rootPath: join(root, 'data') }),
			logger: new LoggingService(
				new ConsoleLogSink({
					out: (line: string) => logged.push(line),
					err: (line: string) => logged.push(line),
				}),
			),
			fetchImpl: async () => {
				throw new Error('ECONNREFUSED');
			},
		});
		await broken.listAvailableModels();

		const serialized = JSON.stringify({ listed, logged });
		assert.ok(listed.length > 0, 'the listing itself happened');
		assert.ok(logged.length > 0, 'the failure was logged, so the check means something');
		assert.ok(!serialized.includes('sk-discovery-DO-NOT-LEAK-4242'));
	});

	test('a routed turn lists candidates from the cache after the first one', async () => {
		const { fetchImpl, calls } = server();
		const chat = new ChatSession({
			config: new ProviderConfigService(new FileStateStore({ filePath: join(root, 'state.json') })),
			secrets: new FileSecretStore({ filePath: join(root, 'secrets.json') }),
			history: new FileDataStore({ rootPath: join(root, 'data') }),
			logger: new LoggingService(new ConsoleLogSink({ out: () => undefined, err: () => undefined })),
			fetchImpl,
			routing: { policy: policy() },
		});
		await chat.saveProvider({ baseUrl: LOCAL_URL });

		const conversation = await chat.createConversation({ providerId: LOCAL_ID });
		const input: SendMessageInput = {
			providerId: LOCAL_ID,
			conversationId: conversation.summary.id,
			model: 'modelo-lento',
			messages: [{ role: 'user', content: 'hello' }],
		};
		const first = new EventLog();
		await chat.sendMessage(input, first.sink);
		await first.wait();

		const before = modelCalls(calls).length;
		const second = new EventLog();
		await chat.sendMessage({ ...input, conversationId: (await chat.createConversation({ providerId: LOCAL_ID })).summary.id }, second.sink);
		await second.wait();

		assert.strictEqual(second.terminal.type, 'done');
		assert.strictEqual(modelCalls(calls).length, before, 'the second turn used the cached list');
	});

	test('a configured model the discovery does not list stays selectable by hand', async () => {
		const { fetchImpl } = server({
			models: () => ({ ok: true, status: 200, text: async () => JSON.stringify({ data: [] }) }),
		});
		const chat = new ChatSession({
			config: new ProviderConfigService(new FileStateStore({ filePath: join(root, 'state.json') })),
			secrets: new FileSecretStore({ filePath: join(root, 'secrets.json') }),
			history: new FileDataStore({ rootPath: join(root, 'data') }),
			logger: new LoggingService(new ConsoleLogSink({ out: () => undefined, err: () => undefined })),
			fetchImpl,
			routing: { policy: policy() },
		});
		await chat.saveProvider({ baseUrl: LOCAL_URL });
		await chat.saveModelCatalogEntry({
			providerId: LOCAL_ID,
			modelId: 'meu-modelo-declarado',
			access: 'free',
			capabilities: 'code',
		});

		const conversation = await chat.createConversation({ providerId: LOCAL_ID });
		const log = new EventLog();
		await chat.sendMessage(
			{
				providerId: LOCAL_ID,
				conversationId: conversation.summary.id,
				model: 'meu-modelo-declarado',
				messages: [{ role: 'user', content: 'hello' }],
				strategy: 'manual',
			},
			log.sink,
		);
		await log.wait();

		assert.strictEqual(log.terminal.type, 'done');
		// The manual choice is a declared model, not a discovered one.
		assert.deepStrictEqual(await chat.listAvailableModels(), []);
	});

	test('discovery does not change routing metrics', async () => {
		const attempts: RouteAttempt[] = [];
		const { fetchImpl } = server();
		const chat = new ChatSession({
			config: new ProviderConfigService(new FileStateStore({ filePath: join(root, 'state.json') })),
			secrets: new FileSecretStore({ filePath: join(root, 'secrets.json') }),
			history: new FileDataStore({ rootPath: join(root, 'data') }),
			logger: new LoggingService(new ConsoleLogSink({ out: () => undefined, err: () => undefined })),
			fetchImpl,
			routing: {
				policy: policy(),
				metrics: {
					recordAttempt: (attempt: RouteAttempt) => {
						attempts.push(attempt);
					},
				},
			},
		});
		await chat.saveProvider({ baseUrl: LOCAL_URL });

		const conversation = await chat.createConversation({ providerId: LOCAL_ID });
		const log = new EventLog();
		await chat.sendMessage(
			{
				providerId: LOCAL_ID,
				conversationId: conversation.summary.id,
				model: 'modelo-lento',
				messages: [{ role: 'user', content: 'hello' }],
			},
			log.sink,
		);
		await log.wait();

		assert.strictEqual(attempts.length, 1, 'discovery adds no attempt');
		assert.strictEqual(attempts[0]?.modelId, 'modelo-lento');
		assert.strictEqual(attempts[0]?.outcome, 'success');
	});
});
