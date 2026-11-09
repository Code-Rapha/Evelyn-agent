/**
 * Contabilização ligada ao roteamento real.
 *
 * Duas camadas, de propósito:
 *
 * - os testes do gravador entregam tentativas ao `createConsumptionRecorder`
 *   com um armazenamento de memória, e conseguem assim fixar as regras de
 *   retry, fallback, timeout, cancelamento e falha de escrita sem um socket;
 * - os testes de sessão usam o `ChatSession` de verdade, com `fetch` roteirizado
 *   e armazenamento em diretório temporário, para provar que a ligação existe
 *   e que nada passa duas vezes.
 */
import * as assert from 'assert';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProviderConfigService } from '../core/providers/config';
import { LoggingService } from '../core/logging';
import type { FetchLike, FetchResponseLike } from '../core/providers/openaiCompatible';
import { ConsoleLogSink } from '../adapters/local/consoleLogSink';
import { CONSUMPTION_FILE, FileDataStore } from '../adapters/local/fileDataStore';
import { FileSecretStore } from '../adapters/local/fileSecretStore';
import { FileStateStore } from '../adapters/local/fileStateStore';
import { ChatSession, DEFAULT_ROUTE_POLICY } from '../desktop/chatSession';
import type { AgentUiEvent } from '../desktop/agentTurn';
import type { SendMessageInput } from '../desktop/contract';
import { CircuitBreaker } from '../core/providers/routing/breaker';
import type {
	RouteAttempt,
	RoutePolicy,
} from '../core/providers/routing/types';
import {
	catalogPricingLookup,
	createConsumptionRecorder,
	type ConsumptionWriter,
} from '../desktop/consumptionRecorder';
import type {
	AttemptRecord,
	ConsumptionLedgerPort,
	ExecutionRecord,
	RecordAttemptInput,
	RecordExecutionInput,
} from '../core/storage/types/consumption';
import type { ModelPricing } from '../core/storage/types/modelCatalog';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const LOCAL_URL = 'http://127.0.0.1:11434/v1';
const LOCAL_ID = '127.0.0.1-11434-v1';
const SECOND_URL = 'http://127.0.0.1:11435/v1';

const DONE = 'data: [DONE]\n\n';

/** A resposta de `/models`, no formato que o provedor OpenAI-compatible lê. */
function endpointModels(models: readonly string[]): string {
	return JSON.stringify({ data: models.map((id) => ({ id })) });
}

function delta(text: string): string {
	return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
}

function usageChunk(prompt: number, completion: number, cached?: number): string {
	const usage = {
		prompt_tokens: prompt,
		completion_tokens: completion,
		total_tokens: prompt + completion,
		...(cached !== undefined ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
	};
	return `data: ${JSON.stringify({ choices: [], usage })}\n\n`;
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

function httpErrorResponse(status: number, body = '{"error":{"message":"down"}}'): FetchResponseLike {
	return { ok: false, status, text: async () => body };
}

interface Recorded {
	url: string;
	body?: string;
}

/**
 * O que cada endpoint declara em `/models`.
 *
 * A sessão passa a listar estes nomes e a usá-los como candidatos, então o
 * padrão é vazio - o caso de um servidor que responde mas não anuncia nada - e
 * só os testes que querem descoberta preenchem o mapa. Sem isso, uma sessão
 * começaria a rotear para modelos que o teste nunca declarou.
 */
const advertisedModels = new Map<string, readonly string[]>();

function scriptedFetch(
	post: (which: 'local' | 'second', index: number) => FetchResponseLike,
): { fetchImpl: FetchLike; calls: Recorded[] } {
	const calls: Recorded[] = [];
	const counts = { local: 0, second: 0 };
	const fetchImpl: FetchLike = async (url, init) => {
		calls.push({ url, ...(init?.body !== undefined ? { body: init.body } : {}) });
		if (url.endsWith('/models')) {
			const which = url.includes('11435') ? 'second' : 'local';
			return {
				ok: true,
				status: 200,
				text: async () => endpointModels(advertisedModels.get(which) ?? []),
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
			const timer = setTimeout(() => reject(new Error('the turn produced no terminal event')), 4000);
			this.finished = () => {
				clearTimeout(timer);
				resolve();
			};
		});
	}

	get terminals(): AgentUiEvent[] {
		return this.events.filter((event) => event.type === 'done' || event.type === 'error');
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

/**
 * Polls until a condition holds, up to a bounded wait.
 *
 * The session settles its own writes after the turn returns; a test that reads
 * from a second store instance would otherwise race that write. Polling the
 * public surface keeps this honest: nothing private is waited on.
 */
async function waitFor(condition: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await condition()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error('condition not met before the deadline');
}

/** An in-memory ledger, so the recorder's rules can be asserted without a file. */class MemoryLedger implements ConsumptionWriter {
	readonly executions = new Map<string, ExecutionRecord>();
	readonly attempts = new Map<string, AttemptRecord>();
	readonly attemptInputs: RecordAttemptInput[] = [];

	async recordExecution(input: RecordExecutionInput): Promise<ExecutionRecord> {
		const existing = this.executions.get(input.executionId);
		const record: ExecutionRecord = {
			...input,
			attemptIds: existing?.attemptIds ?? [],
			totals: existing?.totals ?? {
				attempts: 0,
				cost: { status: 'unknown', parts: [], reasons: ['no attempts were recorded'] },
			},
		};
		this.executions.set(record.executionId, record);
		return record;
	}

	async recordAttempt(input: RecordAttemptInput): Promise<AttemptRecord> {
		this.attemptInputs.push(input);
		const id = `${input.executionId}#${input.sequence}`;
		const record: AttemptRecord = {
			attemptId: id,
			executionId: input.executionId,
			providerId: input.providerId,
			modelId: input.modelId,
			sequence: input.sequence,
			retry: input.retry,
			fallback: input.fallback,
			status: input.status,
			startedAt: input.startedAt,
			recordedAt: input.startedAt,
			...(input.reportedTokens !== undefined ? { reportedTokens: input.reportedTokens } : {}),
			...(input.errorClass !== undefined ? { errorClass: input.errorClass } : {}),
			...(input.abortCause !== undefined ? { abortCause: input.abortCause } : {}),
			...(input.httpStatus !== undefined ? { httpStatus: input.httpStatus } : {}),
			cost: { status: 'unknown', parts: [], reasons: ['memory ledger'] },
		};
		this.attempts.set(id, record);
		const execution = this.executions.get(input.executionId);
		if (execution !== undefined) {
			this.executions.set(input.executionId, {
				...execution,
				attemptIds: execution.attemptIds.includes(id)
					? execution.attemptIds
					: [...execution.attemptIds, id],
			});
		}
		return record;
	}
}

const USD: ModelPricing = {
	currency: 'USD',
	unit: 'per_1m_tokens',
	input: 3,
	output: 15,
	cachedInput: 0.3,
};

function attempt(overrides: Partial<RouteAttempt> = {}): RouteAttempt {
	return {
		requestId: 'req-1',
		providerId: 'atria',
		modelId: 'modelo-a',
		sequence: 1,
		startedAtMs: Date.parse('2026-01-01T10:00:00.000Z'),
		retry: false,
		fallback: false,
		outcome: 'success',
		...overrides,
	};
}

suite('Desktop: consumption recorder', () => {
	let ledger: MemoryLedger;

	setup(() => {
		ledger = new MemoryLedger();
	});

	function recorder(pricing: ModelPricing | undefined = USD) {
		return createConsumptionRecorder({
			ledger,
			pricing: () => pricing,
			now: () => Date.parse('2026-01-01T10:00:05.000Z'),
		});
	}

	// Retry and fallback ......................................................

	test('a retry and a fallback are attempts of one execution, not three executions', async () => {
		const consumption = recorder();
		await consumption.recordAttempt(
			attempt({ sequence: 1, outcome: 'failure', errorClass: 'unavailable', httpStatus: 503 }),
		);
		await consumption.recordAttempt(attempt({ sequence: 2, retry: true, outcome: 'failure', errorClass: 'timeout', abortCause: 'first-token' }));
		await consumption.recordAttempt(
			attempt({
				sequence: 3,
				fallback: true,
				providerId: 'opencode',
				modelId: 'modelo-b',
				usage: { promptTokens: 100, completionTokens: 20 },
			}),
		);
		await consumption.settled();

		assert.strictEqual(ledger.executions.size, 1, 'one logical execution');
		assert.strictEqual(ledger.attempts.size, 3, 'three attempts');
		assert.deepStrictEqual(
			[...ledger.attempts.values()].map((record) => `${record.modelId}:${record.status}`),
			['modelo-a:failure', 'modelo-a:timeout', 'modelo-b:success'],
		);
		assert.strictEqual(
			[...ledger.attempts.values()][1].abortCause,
			'first-token',
			'the budget that cut the attempt is kept',
		);
	});

	test('a skipped candidate was never called and is not billed', async () => {
		const consumption = recorder();
		await consumption.recordAttempt(attempt({ sequence: 1, outcome: 'skipped', errorClass: 'breaker_open' }));
		await consumption.recordAttempt(attempt({ sequence: 2, fallback: true, providerId: 'opencode', modelId: 'b' }));
		await consumption.settled();

		assert.strictEqual(ledger.attempts.size, 1);
		assert.strictEqual([...ledger.attempts.values()][0].modelId, 'b');
	});

	test('a user stop is cancelled, not a timeout', async () => {
		const consumption = recorder();
		await consumption.recordAttempt(
			attempt({ outcome: 'cancelled', abortCause: 'user-stop' }),
		);
		await consumption.settled();
		assert.strictEqual([...ledger.attempts.values()][0].status, 'cancelled');
	});

	test('a timer that cut an attempt is a timeout', async () => {
		const consumption = recorder();
		await consumption.recordAttempt(
			attempt({ outcome: 'cancelled', abortCause: 'idle' }),
		);
		await consumption.settled();
		assert.strictEqual([...ledger.attempts.values()][0].status, 'timeout');
	});

	test('a plain failure stays a failure', async () => {
		const consumption = recorder();
		await consumption.recordAttempt(attempt({ outcome: 'failure', errorClass: 'auth', httpStatus: 401 }));
		await consumption.settled();
		const record = [...ledger.attempts.values()][0];
		assert.strictEqual(record.status, 'failure');
		assert.strictEqual(record.errorClass, 'auth');
		assert.strictEqual(record.httpStatus, 401);
	});

	// Token provenance ........................................................

	test('a provider reading is stored as reported and priced from the catalog', async () => {
		const consumption = recorder();
		await consumption.recordAttempt(
			attempt({ usage: { promptTokens: 1_000, completionTokens: 500, totalTokens: 1_500 } }),
		);
		await consumption.settled();

		const input = ledger.attemptInputs[0];
		assert.deepStrictEqual(input.reportedTokens, { input: 1_000, output: 500 });
		assert.strictEqual(input.estimatedTokens, undefined);
		// The tariffs the ledger will apply, not only the currency: the record
		// must say what it was priced with, or a later repricing would look
		// like the same thing.
		assert.deepStrictEqual(input.pricing, {
			currency: 'USD',
			unit: 'per_1m_tokens',
			input: 3,
			output: 15,
			cachedInput: 0.3,
		});
	});

	test('a cached input count reported by the provider is kept as a subset', async () => {
		const consumption = recorder();
		await consumption.recordAttempt(
			attempt({ usage: { promptTokens: 1_000, completionTokens: 0, cachedInputTokens: 400 } }),
		);
		await consumption.settled();

		assert.deepStrictEqual(ledger.attemptInputs[0].reportedTokens, {
			input: 1_000,
			output: 0,
			cachedInput: 400,
		});
	});

	test('a provider that reported no usage records nothing invented', async () => {
		const consumption = recorder();
		await consumption.recordAttempt(attempt());
		await consumption.settled();

		const input = ledger.attemptInputs[0];
		assert.strictEqual(input.reportedTokens, undefined);
		assert.strictEqual(input.estimatedTokens, undefined);
		assert.strictEqual(input.pricing, undefined, 'no price is attached to an attempt with no tokens');
	});

	test('a provider that reported half a reading is not treated as reporting', async () => {
		const consumption = recorder();
		await consumption.recordAttempt(attempt({ usage: { promptTokens: 10 } }));
		await consumption.settled();
		assert.strictEqual(ledger.attemptInputs[0].reportedTokens, undefined);
	});

	test('a model with no catalog price is recorded without a price and without a zero cost', async () => {
		const consumption = createConsumptionRecorder({
			ledger,
			pricing: () => undefined,
		});
		await consumption.recordAttempt(attempt({ usage: { promptTokens: 10, completionTokens: 5 } }));
		await consumption.settled();
		assert.strictEqual(ledger.attemptInputs[0].pricing, undefined);
	});

	test('an attempt with no tokens carries no price at all', async () => {
		// A price on an attempt that spent nothing would read as a computed cost
		// of zero. Nothing was computed, so nothing is priced.
		const consumption = recorder();
		await consumption.recordAttempt(attempt({ outcome: 'failure', errorClass: 'unavailable' }));
		await consumption.settled();
		assert.strictEqual(ledger.attemptInputs[0].pricing, undefined);
	});
	test('a price is read at the attempt, from the catalog lookup', async () => {
		const seen: string[] = [];
		const consumption = createConsumptionRecorder({
			ledger,
			pricing: catalogPricingLookup(async (providerId, modelId) => {
				seen.push(`${providerId}/${modelId}`);
				return modelId === 'modelo-a' ? USD : undefined;
			}),
		});
		await consumption.recordAttempt(attempt({ usage: { promptTokens: 1, completionTokens: 1 } }));
		await consumption.recordAttempt(
			attempt({ sequence: 2, fallback: true, providerId: 'opencode', modelId: 'modelo-b', usage: { promptTokens: 1, completionTokens: 1 } }),
		);
		await consumption.settled();

		assert.deepStrictEqual(seen, ['atria/modelo-a', 'opencode/modelo-b']);
		assert.strictEqual(ledger.attemptInputs[0].pricing?.currency, 'USD');
		assert.strictEqual(ledger.attemptInputs[1].pricing, undefined);
	});

	// Idempotency .............................................................

	test('the same attempt delivered twice is stored once', async () => {
		const consumption = recorder();
		const event = attempt({ usage: { promptTokens: 10, completionTokens: 5 } });
		await consumption.recordAttempt(event);
		await consumption.recordAttempt(event);
		await consumption.settled();

		assert.strictEqual(ledger.attempts.size, 1);
		assert.strictEqual(ledger.executions.size, 1);
	});

	// Write failures ..........................................................

	test('a ledger that refuses writes reports the failure and does not reject the engine', async () => {
		const failures: unknown[] = [];
		const consumption = createConsumptionRecorder({
			ledger: {
				async recordExecution(): Promise<ExecutionRecord> {
					throw new Error('disk full');
				},
				async recordAttempt(): Promise<AttemptRecord> {
					throw new Error('unreachable');
				},
			},
			onFailure: (error) => failures.push(error),
		});

		await assert.doesNotReject(async () => {
			await consumption.recordAttempt(attempt({ usage: { promptTokens: 1, completionTokens: 1 } }));
		});
		await consumption.settled();
		assert.strictEqual(failures.length, 1);
		assert.strictEqual(consumption.failures.length, 1);
	});

	test('a failure while reading the price still records the attempt', async () => {
		const failures: unknown[] = [];
		const consumption = createConsumptionRecorder({
			ledger,
			pricing: () => {
				throw new Error('catalog unreadable');
			},
			onFailure: (error) => failures.push(error),
		});
		await consumption.recordAttempt(attempt({ usage: { promptTokens: 4, completionTokens: 2 } }));
		await consumption.settled();

		assert.strictEqual(failures.length, 1);
		assert.strictEqual(ledger.attempts.size, 1, 'the token reading still landed');
		assert.strictEqual(ledger.attemptInputs[0].pricing, undefined);
	});

	test('settling a request closes the execution with the outcome the caller knows', async () => {
		const consumption = recorder();
		await consumption.recordAttempt(attempt({ outcome: 'failure', errorClass: 'network' }));
		await consumption.settleRequest('req-1', 'failure');
		await consumption.settled();
		assert.strictEqual(ledger.executions.get('req-1')?.status, 'failure');
	});

	test('a route id scopes the execution id to the route', async () => {
		const consumption = recorder();
		await consumption.recordAttempt(attempt({ routeId: 'turn-9', usage: { promptTokens: 1, completionTokens: 1 } }));
		await consumption.settleRequest('req-1', 'success');
		await consumption.settled();
		assert.deepStrictEqual([...ledger.executions.keys()], ['turn-9:req-1']);
		assert.strictEqual(ledger.executions.get('turn-9:req-1')?.turnId, 'turn-9');
	});
});

suite('Desktop: consumption through the chat session', () => {
	let root: string;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-consumption-session-'));
		advertisedModels.clear();
	});

	teardown(async () => {
		await removeFixtureTree(root);
	});

	function freshStore(): FileDataStore {
		return new FileDataStore({ rootPath: join(root, 'data') });
	}

	function session(
		fetchImpl: FetchLike,
		routing?: Partial<Parameters<typeof buildRouting>[0]> & { readonly allowPaid?: boolean },
	): ChatSession {
		return new ChatSession({
			config: new ProviderConfigService(new FileStateStore({ filePath: join(root, 'state.json') })),
			secrets: new FileSecretStore({ filePath: join(root, 'secrets.json') }),
			history: freshStore(),
			logger: new LoggingService(new ConsoleLogSink({ out: () => undefined, err: () => undefined })),
			fetchImpl,
			turnTimeoutMs: 5_000,
			...(routing !== undefined
				? { routing: { policy: policy(routing.policy), breaker: routing.breaker ?? new CircuitBreaker(() => policy().breaker, () => Date.now()), sleep: async () => true } }
				: {}),
			...(routing?.allowPaid !== undefined ? { allowPaid: routing.allowPaid } : {}),
		});
	}

	function buildRouting(input: { readonly policy: Partial<RoutePolicy>; readonly breaker?: CircuitBreaker }) {
		return { policy: input.policy, breaker: input.breaker };
	}

	async function sendInput(chat: ChatSession, overrides: Partial<SendMessageInput> = {}): Promise<SendMessageInput> {
		const conversation = await chat.createConversation({ providerId: LOCAL_ID });
		return {
			providerId: LOCAL_ID,
			conversationId: conversation.summary.id,
			model: 'llama3',
			messages: [{ role: 'user', content: 'hello' }],
			...overrides,
		};
	}

	async function twoProviders(chat: ChatSession): Promise<void> {
		await chat.saveProvider({ baseUrl: LOCAL_URL });
		await chat.saveProvider({ baseUrl: SECOND_URL });
	}

	/** What each endpoint announces in `/models`; reset before every test. */
	function advertise(models: { readonly local?: readonly string[]; readonly second?: readonly string[] }): void {
		advertisedModels.clear();
		if (models.local !== undefined) {
			advertisedModels.set('local', models.local);
		}
		if (models.second !== undefined) {
			advertisedModels.set('second', models.second);
		}
	}

	test('a fallback turn records one execution with two attempts and the winner priced', async () => {
		advertise({ local: ['modelo-lento'], second: ['modelo-rapido'] });
		const { fetchImpl, calls } = scriptedFetch((which) =>
			which === 'local'
				? hangingResponse()
				: sseResponse([delta('resposta'), usageChunk(1_000, 500), DONE]),
		);
		const chat = session(fetchImpl, { policy: { timeouts: { ttfbMs: 40, idleMs: 0, totalMs: 0 } }, allowPaid: true });
		await twoProviders(chat);
		// The price of the model that ends up answering.
		await chat.saveModelCatalogEntry({
			providerId: '127.0.0.1-11435-v1',
			modelId: 'modelo-rapido',
			access: 'paid',
			pricing: { currency: 'USD', unit: 'per_1m_tokens', input: '3', output: '15' },
		});

		const log = new EventLog();
		await chat.sendMessage(await sendInput(chat, { strategy: 'fallback' }), log.sink);
		await log.wait();
		assert.strictEqual(log.terminal.type, 'done', 'the answer is delivered');

		const ledger = freshStore();
		const executions = await ledger.listConsumption();
		assert.strictEqual(executions.length, 1, 'one logical execution for the turn');
		const loaded = await ledger.getExecution(executions[0].executionId);
		assert.ok(loaded !== undefined);
		assert.strictEqual(loaded.execution.status, 'success');
		// The manual model stalls on its first token; the fallback answers. The
		// fallback model is paid, declared as such by the catalog, and allowed by
		// the host - otherwise llowPaid: false would refuse it before any call.
		assert.deepStrictEqual(
			loaded.attempts.map((record) => `${record.modelId}:${record.status}`),
			['modelo-lento:timeout', 'modelo-rapido:success'],
		);

		const winner = loaded.attempts[1];
		assert.deepStrictEqual(winner.reportedTokens, { input: 1_000, output: 500 });
		assert.strictEqual(winner.tokenSource, 'provider');
		assert.strictEqual(winner.cost.status, 'estimated');
		if (winner.cost.status === 'estimated') {
			// 1000 in at USD 3/M and 500 out at USD 15/M.
			assert.strictEqual(winner.cost.total, 0.0105);
		}

		// The failed attempt spent no tokens and has no price: unknown, not zero.
		const loser = loaded.attempts[0];
		assert.strictEqual(loser.reportedTokens, undefined);
		assert.strictEqual(loser.cost.status, 'unknown');
	});

	test('a retried attempt is one execution with two attempts', async () => {
		advertise({ local: ['llama3'] });
		const { fetchImpl } = scriptedFetch((_which, index) =>
			index === 0 ? httpErrorResponse(503) : sseResponse([delta('ok'), usageChunk(10, 5), DONE]),
		);
		const chat = session(fetchImpl, { policy: { retries: 1 } });
		await twoProviders(chat);

		const log = new EventLog();
		await chat.sendMessage(await sendInput(chat), log.sink);
		await log.wait();

		const executions = await freshStore().listConsumption();
		assert.strictEqual(executions.length, 1);
		const loaded = await freshStore().getExecution(executions[0].executionId);
		assert.deepStrictEqual(
			loaded?.attempts.map((record) => `${record.sequence}:${record.retry}:${record.status}`),
			['1:false:failure', '2:true:success'],
		);
	});

	test('a turn with no routing configured writes no consumption at all', async () => {
		const { fetchImpl } = scriptedFetch(() => sseResponse([delta('ok'), DONE]));
		const chat = session(fetchImpl);
		await twoProviders(chat);
		const log = new EventLog();
		await chat.sendMessage(await sendInput(chat), log.sink);
		await log.wait();

		assert.strictEqual(existsSync(join(root, 'data', CONSUMPTION_FILE)), false);
	});

	test('the ledger survives the app being closed and reopened', async () => {
		advertise({ local: ['llama3'] });
		const { fetchImpl } = scriptedFetch(() => sseResponse([delta('ok'), usageChunk(20, 10), DONE]));
		const chat = session(fetchImpl, { policy: {} });
		await twoProviders(chat);
		await chat.saveModelCatalogEntry({
			providerId: LOCAL_ID,
			modelId: 'llama3',
			pricing: { currency: 'USD', unit: 'per_1m_tokens', input: '3', output: '15' },
		});
		const log = new EventLog();
		await chat.sendMessage(await sendInput(chat), log.sink);
		await log.wait();

		// A brand-new store over the same root: this is what a restart sees.
		const reopened = freshStore();
		const executions = await reopened.listConsumption();
		assert.strictEqual(executions.length, 1);
		assert.deepStrictEqual(executions[0].totals.tokens, { input: 20, output: 10 });
		// `sendMessage` resolves as soon as the turn ended; the session awaits
		// its metrics port right after. The catalog's observation is the last
		// write of that pass, so seeing it means the ledger write that priced
		// the attempt has landed too - which is what a restart would provide
		// by time alone. Re-read from a new instance, never from the session.
		await waitFor(
			async () =>
				(await freshStore().getModelCatalogEntry({ providerId: LOCAL_ID, modelId: 'llama3' }))
					?.observations.length === 1,
		);
		const settled = await freshStore().listConsumption();
		assert.strictEqual(settled[0].totals.cost.status, 'estimated');
		if (settled[0].totals.cost.status === 'estimated') {
			assert.strictEqual(
				settled[0].totals.cost.total,
				Math.round((20 * 3e-6 + 10 * 15e-6) * 1e12) / 1e12,
			);
		}
	});

	test('a broken ledger does not interrupt the answer', async () => {
		const { fetchImpl } = scriptedFetch(() => sseResponse([delta('a resposta'), DONE]));
		const chat = session(fetchImpl, { policy: {} });
		await twoProviders(chat);

		// A directory where the ledger file should be: every write fails.
		await mkdir(join(root, 'data', CONSUMPTION_FILE), { recursive: true });

		const log = new EventLog();
		await chat.sendMessage(await sendInput(chat), log.sink);
		await log.wait();

		assert.strictEqual(log.terminals.length, 1);
		assert.strictEqual(log.terminal.type, 'done');
		assert.strictEqual(log.deltas, 'a resposta');
	});

	test('the ledger holds no prompt, no answer and no key', async () => {
		const SECRET = 'sk-seshyina-should-never-appear';
		const PROMPT = 'meu segredo pessoal é quarenta e dois';
		const ANSWER = 'a resposta confidencial do modelo';
		const { fetchImpl } = scriptedFetch(() => sseResponse([delta(ANSWER), usageChunk(5, 5), DONE]));
		const chat = session(fetchImpl, { policy: {} });
		await chat.saveProvider({ baseUrl: LOCAL_URL, apiKey: SECRET });
		await chat.saveProvider({ baseUrl: SECOND_URL });

		const log = new EventLog();
		await chat.sendMessage(
			await sendInput(chat, { messages: [{ role: 'user', content: PROMPT }] }),
			log.sink,
		);
		await log.wait();
		assert.strictEqual(log.deltas, ANSWER);

		const raw = await readFile(join(root, 'data', CONSUMPTION_FILE), 'utf8');
		assert.strictEqual(raw.includes(SECRET), false);
		assert.strictEqual(raw.includes(PROMPT), false);
		assert.strictEqual(raw.includes(ANSWER), false);
	});

	test('the consumption ledger does not change the observations of 4A', async () => {
		advertise({ local: ['llama3'], second: ['modelo-rapido'] });
		const { fetchImpl } = scriptedFetch(() => sseResponse([delta('ok'), usageChunk(7, 3), DONE]));
		const chat = session(fetchImpl, { policy: {} });
		await twoProviders(chat);
		const log = new EventLog();
		await chat.sendMessage(await sendInput(chat), log.sink);
		await log.wait();

		const store = freshStore();
		const entry = await store.getModelCatalogEntry({ providerId: LOCAL_ID, modelId: 'llama3' });
		assert.strictEqual(entry?.observations.length, 1, 'one measurement, as before');
		assert.deepStrictEqual(entry?.observations[0].usage, { promptTokens: 7, completionTokens: 3, totalTokens: 10 });
		// The ledger has its own record, and the catalog's window is untouched
		// by the consumption write.
		assert.strictEqual((await store.listConsumption()).length, 1);
	});
});
