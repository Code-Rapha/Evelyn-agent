/**
 * The desktop chat session: providers, model discovery and a streaming turn.
 *
 * Lives in `src/core-tests/` and runs under plain mocha via `npm run test:core`,
 * deliberately outside the `vscode-test` glob. `chatSession.ts` imports no
 * `electron` — which is the whole reason the conversation flow lives in its own
 * file — so the entire flow is testable here with an injected `fetch` and no
 * window.
 *
 * No test touches the network and none patches a global: every case builds a
 * session with a `fetchImpl` that returns scripted bytes.
 */
import * as assert from 'assert';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProviderConfigService } from '../core/providers/config';
import { LoggingService } from '../core/logging';
import { providerApiKeyRef } from '../core/providers/secrets';
import type { FetchLike, FetchResponseLike } from '../core/providers/openaiCompatible';
import { ConsoleLogSink } from '../adapters/local/consoleLogSink';
import { FileDataStore } from '../adapters/local/fileDataStore';
import { FileSecretStore } from '../adapters/local/fileSecretStore';
import { FileStateStore } from '../adapters/local/fileStateStore';
import { ChatSession, deriveProviderId } from '../desktop/chatSession';
import type { AgentUiEvent } from '../desktop/agentTurn';
import { shouldFallback } from '../desktop/modelSelector';
import { continueOrchestration } from '../desktop/orchestrator';
import type { SelectableModel } from '../desktop/modelSelector';
import {
	parseChatStreamEvent,
	parseProviderSummary,
	type SendMessageInput,
} from '../desktop/contract';
import { SESHYINA_AGENT_IDENTITY } from '../core/agent/seshyinaAgent';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const KEY = 'sk-test-DO-NOT-PERSIST-9c1e2b';
const LOCAL_URL = 'http://127.0.0.1:11434/v1';
const LOCAL_ID = '127.0.0.1-11434-v1';
/** A second endpoint, for the tests about more than one provider. */
const SECOND_URL = 'http://127.0.0.1:11435/v1';

/** Wraps SSE text as the byte chunks the provider's decoder consumes. */
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

/** One streamed `content` fragment, as the server would send it. */
function delta(text: string): string {
	return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
}

const DONE = 'data: [DONE]\n\n';

/** A streamed tool call, in the OpenAI shape the Core's decoder expects. */
function toolChunk(id: string, name: string, args: unknown, index = 0): string {
	return `data: ${JSON.stringify({
		choices: [
			{ delta: { tool_calls: [{ index, id, function: { name, arguments: JSON.stringify(args) } }] } },
		],
	})}\n\n`;
}

/** One recorded request, so a test can assert on headers and body. */
interface Recorded {
	url: string;
	headers: Record<string, string>;
	body?: string;
}

/** Serves a model list on GET and the given stream on POST, recording both. */
function scriptedFetch(chunks: readonly string[]): { fetchImpl: FetchLike; calls: Recorded[] } {
	const calls: Recorded[] = [];
	const fetchImpl: FetchLike = async (url, init) => {
		calls.push({
			url,
			headers: init?.headers ?? {},
			...(init?.body !== undefined ? { body: init.body } : {}),
		});
		if (url.endsWith('/models')) {
			return {
				ok: true,
				status: 200,
				text: async () => JSON.stringify({ data: [{ id: 'llama3' }, { id: 'qwen' }] }),
			};
		}
		return sseResponse(chunks);
	};
	return { fetchImpl, calls };
}

/** A model the selector could have returned, for the orchestration tests. */
function selectable(providerId: string, modelId: string): SelectableModel {
	return {
		providerId,
		modelId,
		providerName: providerId,
		available: true,
		catalog: {
			providerId,
			modelId,
			access: 'unknown',
			observations: [],
			createdAt: '2024-01-01T00:00:00.000Z',
			updatedAt: '2024-01-01T00:00:00.000Z',
		},
	};
}

/** Collects stream events and lets a test await the turn's terminal event. */class EventLog {
	readonly events: AgentUiEvent[] = [];
	private finished: (() => void) | undefined;

	readonly sink = (event: AgentUiEvent): void => {
		this.events.push(event);
		if (event.type === 'done' || event.type === 'error') {
			this.finished?.();
		}
	};

	/** Resolves on a terminal event; rejects if none arrives. */
	wait(): Promise<void> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.finished = undefined;
				reject(new Error('the turn produced no terminal event'));
			}, 3000);
			this.finished = () => {
				clearTimeout(timer);
				this.finished = undefined;
				resolve();
			};
		});
	}

	get types(): string[] {
		return this.events.map((event) => event.type);
	}

	/** The last event, if one arrived at all. */

		/** The `done` or `error` event, or undefined while the turn is still open. */
			get settled(): AgentUiEvent | undefined {
			return this.events.find(
				(event): event is Extract<AgentUiEvent, { type: 'done' | 'error' }> =>
					event.type === 'done' || event.type === 'error',
			);
		}

		get deltas(): string {
		return this.events
			.filter(
				(event): event is Extract<AgentUiEvent, { type: 'delta' }> => event.type === 'delta',
			)
			.map((event) => event.text)
			.join('');
	}

	get terminal(): AgentUiEvent {
		const terminal = this.events.find(
			(event): event is Extract<AgentUiEvent, { type: 'done' | 'error' }> =>
				event.type === 'done' || event.type === 'error',
		);
		assert.ok(terminal !== undefined, 'expected a terminal event');
		return terminal;
	}
}

/**
 * A send input bound to a fresh conversation.
 *
 * Every turn gets its own, because the session now requires an explicit
 * conversation id — a test that reused one would be testing the wrong thing
 * about context.
 */
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

suite('Desktop: chat session', () => {
	let root: string;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-chat-'));
	});

	teardown(async () => {
		await removeFixtureTree(root);
	});

	/** A session over fresh temp files. Everything is real except `fetch`. */
	function session(
		fetchImpl?: FetchLike,
		options: { readonly turnTimeoutMs?: number; readonly firstTokenTimeoutMs?: number } = {},
	): ChatSession {
		return new ChatSession({
			config: new ProviderConfigService(new FileStateStore({ filePath: join(root, 'state.json') })),
			secrets: new FileSecretStore({ filePath: join(root, 'secrets.json') }),
			history: new FileDataStore({ rootPath: join(root, 'data') }),
			logger: new LoggingService(
				new ConsoleLogSink({ out: () => undefined, err: () => undefined }),
			),
			...(fetchImpl !== undefined ? { fetchImpl } : {}),
			...(options.turnTimeoutMs !== undefined ? { turnTimeoutMs: options.turnTimeoutMs } : {}),
			...(options.firstTokenTimeoutMs !== undefined
				? { firstTokenTimeoutMs: options.firstTokenTimeoutMs }
				: {}),
		});
	}

	/** A session plus a provider already saved, which most turn tests need. */
	async function readySession(fetchImpl: FetchLike): Promise<ChatSession> {
		const chat = session(fetchImpl);
		await chat.saveProvider({ baseUrl: LOCAL_URL });
		return chat;
	}

	/**
	 * A session whose *stored* key exists, driven by a given fetch.
	 *
	 * The key is saved through one session and the turn sent through a second
	 * over the same files, so the provider is built after the reference exists —
	 * which is what happens on a real restart.
	 */
	async function sessionWithStoredKey(fetchImpl: FetchLike): Promise<ChatSession> {
		await session().saveProvider({ baseUrl: LOCAL_URL, apiKey: KEY });
		return session(fetchImpl);
	}

	// ── providers ────────────────────────────────────────────────────────────

	test('deriveProviderId is stable and readable for the same URL', () => {
		assert.strictEqual(deriveProviderId(LOCAL_URL), LOCAL_ID);
		// A trailing slash or different case must not create a second provider.
		assert.strictEqual(
			deriveProviderId('http://127.0.0.1:11434/v1/'),
			deriveProviderId('HTTP://127.0.0.1:11434/V1'),
		);
		assert.strictEqual(deriveProviderId('https://api.openai.com/v1'), 'api.openai.com-v1');
	});

	test('a saved provider comes back without its key', async () => {
		const chat = session();

		const saved = await chat.saveProvider({ baseUrl: LOCAL_URL, apiKey: KEY });

		assert.strictEqual(saved.baseUrl, LOCAL_URL);
		assert.strictEqual(saved.hasApiKeyRef, true);
		// The one thing that must never appear on the way out.
		assert.ok(!JSON.stringify(saved).includes(KEY));
		assert.ok(!JSON.stringify(chat.listProviders()).includes(KEY));
	});

	test('saving the same URL twice updates rather than duplicating', async () => {
		const chat = session();
		await chat.saveProvider({ baseUrl: LOCAL_URL, name: 'First' });
		await chat.saveProvider({ baseUrl: LOCAL_URL, name: 'Second' });

		const listed = chat.listProviders();
		assert.strictEqual(listed.length, 1);
		assert.strictEqual(listed[0].name, 'Second');
	});

	test('an omitted key keeps the stored one; a blank key clears it', async () => {
		const chat = session();
		await chat.saveProvider({ baseUrl: LOCAL_URL, apiKey: KEY });

		// Omitted: the URL changes, the key stays. This is what lets the form save
		// a base URL without making the user retype the key.
		await chat.saveProvider({ baseUrl: 'http://127.0.0.1:9999/v1' });
		assert.strictEqual(await chat.listProviders()[0].hasApiKeyRef, true);
		const state = await readFile(join(root, 'state.json'), 'utf8');
		assert.ok(state.includes('127.0.0.1:9999'));

		// Blank: the key goes.
		const moved = deriveProviderId('http://127.0.0.1:9999/v1');
		await chat.saveProvider({ id: moved, baseUrl: 'http://127.0.0.1:9999/v1', apiKey: '' });
		const secrets = new FileSecretStore({ filePath: join(root, 'secrets.json') });
		assert.strictEqual(await secrets.get(providerApiKeyRef(moved)), undefined);
	});

	test('removing a provider takes its key with it', async () => {
		const chat = session();
		await chat.saveProvider({ baseUrl: LOCAL_URL, apiKey: KEY });

		assert.strictEqual(await chat.removeProvider(LOCAL_ID), true);
		assert.strictEqual(await chat.removeProvider(LOCAL_ID), false);
		const secrets = new FileSecretStore({ filePath: join(root, 'secrets.json') });
		assert.strictEqual(await secrets.get(providerApiKeyRef(LOCAL_ID)), undefined);
		assert.deepStrictEqual(chat.listProviders(), []);
	});

	test('models come from the provider endpoint', async () => {
		const chat = await readySession(scriptedFetch([]).fetchImpl);

		assert.deepStrictEqual(await chat.listModels(LOCAL_ID), ['llama3', 'qwen']);
	});

	test('an unreachable model endpoint reports the failure', async () => {
		const chat = await readySession(async () => {
			throw new Error('ECONNREFUSED');
		});

		await assert.rejects(() => chat.listModels(LOCAL_ID), /Could not reach the model endpoint/);
	});

	test('an unknown provider is refused by name', async () => {
		const chat = session();

		await assert.rejects(() => chat.listModels('ghost'), /No provider named "ghost"/);
	});

	// ── disabled providers ──────────────────────────────────────────────────

	/** Seeds a disabled provider directly: the save form always writes `enabled: true`. */
	async function saveDisabledProvider(): Promise<void> {
		await new ProviderConfigService(
			new FileStateStore({ filePath: join(root, 'state.json') }),
		).save({ id: LOCAL_ID, name: 'local', baseUrl: LOCAL_URL, enabled: false });
	}

	test('a disabled provider is refused without touching the network', async () => {
		const { fetchImpl, calls } = scriptedFetch([]);
		await saveDisabledProvider();
		const chat = session(fetchImpl);

		await assert.rejects(() => chat.listModels(LOCAL_ID), /"127.0.0.1-11434-v1" is disabled/);

		assert.deepStrictEqual(calls, [], 'a disabled provider must never reach the socket');
		assert.strictEqual(chat.listProviders()[0]?.status, 'disabled');
	});

	test('sending through a disabled provider reports one error event and no request', async () => {
		const { fetchImpl, calls } = scriptedFetch([delta('never'), DONE]);
		await saveDisabledProvider();
		const chat = session(fetchImpl);
		const log = new EventLog();

		await chat.sendMessage(await sendInput(chat), log.sink);
		await log.wait();

		assert.strictEqual(log.terminal.type, 'error');
		assert.match(
			log.terminal.type === 'error' ? log.terminal.message : '',
			/is disabled/,
		);
		assert.strictEqual(
			log.events.filter((event) => event.type === 'done' || event.type === 'error').length,
			1,
			'exactly one terminal event',
		);
		assert.deepStrictEqual(
			calls.filter((call) => call.url.endsWith('/chat/completions')),
			[],
			'the chat endpoint is never called',
		);
		assert.strictEqual(chat.isBusy, false, 'the session is free again');
	});

	// ── one turn ─────────────────────────────────────────────────────────────

	test('a turn streams started, deltas and done, in order', async () => {
		const chat = await readySession(scriptedFetch([delta('Hello'), delta(', '), delta('world'), DONE]).fetchImpl);
		const log = new EventLog();

		const ack = await chat.sendMessage(await sendInput(chat, ), log.sink);
		assert.strictEqual(ack.accepted, true);
		await log.wait();

		assert.deepStrictEqual(log.types, ['started', 'delta', 'delta', 'delta', 'done']);
		assert.strictEqual(log.deltas, 'Hello, world');
		const terminal = log.terminal;
		assert.strictEqual(terminal.type, 'done');
		assert.strictEqual(terminal.type === 'done' ? terminal.content : '', 'Hello, world');
		assert.strictEqual(terminal.type === 'done' ? terminal.reason : '', 'answered');
	});

	test('every event of a turn carries the same turnId', async () => {
		const chat = await readySession(scriptedFetch([delta('x'), DONE]).fetchImpl);
		const log = new EventLog();

		await chat.sendMessage(await sendInput(chat, ), log.sink);
		await log.wait();

		assert.strictEqual(new Set(log.events.map((event) => event.turnId)).size, 1);
	});

	test('sendMessage resolves while the stream is still open', async () => {
		// A gate the test controls, so this is deterministic rather than a race
		// against a timer: the stream cannot finish until the test opens it.
		let openGate = (): void => undefined;
		const gate = new Promise<void>((resolve) => {
			openGate = resolve;
		});
		const chat = await readySession(async () => ({
			ok: true,
			status: 200,
			body: {
				[Symbol.asyncIterator]: async function* () {
					yield delta('slow');
					await gate;
					yield DONE;
				},
			},
			text: async () => '',
		}));
		const log = new EventLog();

		const ack = await chat.sendMessage(await sendInput(chat, ), log.sink);

		assert.strictEqual(ack.accepted, true);
		assert.strictEqual(log.settled, undefined, 'the turn has not finished');
		assert.strictEqual(chat.isBusy, true);

		openGate();
		await log.wait();
		assert.strictEqual(log.deltas, 'slow');
	});

	test('an unreachable endpoint produces one error event and no deltas', async () => {
		const chat = await readySession(async () => {
			throw new Error('ECONNREFUSED');
		});
		const log = new EventLog();

		await chat.sendMessage(await sendInput(chat, ), log.sink);
		await log.wait();

		assert.strictEqual(log.terminal.type, 'error');
		assert.match(log.terminal.type === 'error' ? log.terminal.message : '', /Could not reach the chat endpoint/);
		assert.deepStrictEqual(log.types.filter((type) => type === 'delta'), []);
		assert.strictEqual(
			log.events.filter((event) => event.type === 'done' || event.type === 'error').length,
			1,
			'one terminal event, never a done after the error',
		);
		assert.strictEqual(chat.isBusy, false, 'a failed turn frees the session for the next send');
	});

	test('an auth failure reaches the user without leaking the key', async () => {
		const chat = await sessionWithStoredKey(async () => ({
			ok: false,
			status: 401,
			text: async () => '',
		}));
		const log = new EventLog();

		await chat.sendMessage(await sendInput(chat, ), log.sink);
		await log.wait();

		const message = log.terminal.type === 'error' ? log.terminal.message : '';
		assert.match(message, /401/);
		assert.ok(!message.includes(KEY), 'the key must never reach an error message');
	});

	test('a failure after some text keeps the text and reports the reason', async () => {
		const chat = await readySession(async () => ({
			ok: true,
			status: 200,
			body: {
				[Symbol.asyncIterator]: async function* () {
					yield delta('partial');
					throw new Error('the connection dropped');
				},
			},
			text: async () => '',
		}));
		const log = new EventLog();

		await chat.sendMessage(await sendInput(chat, ), log.sink);
		await log.wait();

		// The delta reached the renderer before the failure, so it is not erased.
		assert.strictEqual(log.deltas, 'partial');
		assert.strictEqual(log.terminal.type, 'error');
	});

	test('a stream failure after a tool round keeps the completed round in the transcript', async () => {
		// One round per POST: the first answers with a tool call, the second
		// dies — the failure lands while the round is still buffered.
		let posts = 0;
		const fetchImpl: FetchLike = async (url) => {
			if (url.endsWith('/models')) {
				return {
					ok: true,
					status: 200,
					text: async () => JSON.stringify({ data: [{ id: 'llama3' }] }),
				};
			}
			posts += 1;
			if (posts === 1) {
				return sseResponse([toolChunk('c1', 'list_files', { path: '.' }), DONE]);
			}
			throw new Error('connection dropped');
		};
		const chat = session(fetchImpl);
		await chat.saveProvider({ baseUrl: LOCAL_URL });
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
				model: 'llama3',
				messages: [{ role: 'user', content: 'list the files' }],
			},
			log.sink,
		);
		await log.wait();

		assert.strictEqual(log.terminal.type, 'error');
		assert.match(
			log.terminal.type === 'error' ? log.terminal.message : '',
			/Could not reach the chat endpoint/,
		);

		const messages = (await chat.openConversation(conversation.summary.id)).messages;
		assert.deepStrictEqual(
			messages.map((message) => message.role),
			['user', 'assistant', 'tool'],
			'the round the failure cut short is still in the transcript',
		);
		assert.match(messages[1].content, /list_files/);
	});

	test('a turn that times out while a permission dialog is open still ends', async () => {
		const chat = session(async () => sseResponse([toolChunk('c1', 'run_command', { command: 'echo hi' }), DONE]), {
			// Long enough that the dialog is open before it fires, short enough
			// to land well inside `EventLog.wait`'s 3s ceiling.
			turnTimeoutMs: 400,
		});
		await chat.saveProvider({ baseUrl: LOCAL_URL });
		const log = new EventLog();

		await chat.sendMessage(await sendInput(chat), log.sink);
		await log.wait();

		assert.ok(log.types.includes('permissionRequested'), 'the dialog was opened');
		const terminals = log.events.filter(
			(event) => event.type === 'done' || event.type === 'error',
		);
		assert.strictEqual(terminals.length, 1, 'exactly one terminal event');
		// A timeout is a failure the user can act on, so it is reported as an
		// error that names the cause — not as a bare "stopped".
		assert.strictEqual(log.terminal.type, 'error');
		assert.match(
			log.terminal.type === 'error' ? log.terminal.message : '',
			/excedeu 0s no total/,
		);
		assert.strictEqual(chat.isBusy, false, 'the session is not stuck after the timeout');
		assert.strictEqual(chat.openPermissionCount, 0, 'no dialog outlives its turn');
	});

	/** A byte stream that produces nothing ever, but ends when aborted. */
	function neverStream(signal?: AbortSignal): Exclude<FetchResponseLike['body'], null | undefined> {
		const rejectAsAbort = (reject: (error: Error) => void): void =>
			reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
		return {
			[Symbol.asyncIterator]: () => ({
				next: () =>
					new Promise<IteratorResult<Uint8Array | string>>((_, reject) => {
						if (signal?.aborted) {
							rejectAsAbort(reject);
							return;
						}
						signal?.addEventListener('abort', () => rejectAsAbort(reject), { once: true });
					}),
			}),
		};
	}

	/** Serves `/models` and a POST stream that never sends a single byte. */
	function stalledFetch(signalRef: { signal?: AbortSignal }): FetchLike {
		return async (url, init) => {
			signalRef.signal = init?.signal;
			if (url.endsWith('/models')) {
				return {
					ok: true,
					status: 200,
					text: async () => JSON.stringify({ data: [{ id: 'llama3' }] }),
				};
			}
			return { ok: true, status: 200, body: neverStream(init?.signal), text: async () => '' };
		};
	}

	test('a stream that never emits its first token is aborted as a stall, with a clear message', async () => {
		const signalRef: { signal?: AbortSignal } = {};
		const chat = session(stalledFetch(signalRef), {
			turnTimeoutMs: 5_000,
			firstTokenTimeoutMs: 80,
		});
		await chat.saveProvider({ baseUrl: LOCAL_URL });
		const log = new EventLog();

		await chat.sendMessage(await sendInput(chat), log.sink);
		await log.wait();

		assert.strictEqual(log.terminal.type, 'error', 'the stall is an error, not a silent stop');
		assert.match(
			log.terminal.type === 'error' ? log.terminal.message : '',
			/não começou a responder/,
		);
		assert.strictEqual(chat.isBusy, false, 'the session is free right after the stall');
	});

	test('a stream that stalls after outputting is cut by the turn timeout, not the stall timer', async () => {
		const chat = session(async (_url, init) => {
			let listener: (() => void) | undefined;
			return {
				ok: true,
				status: 200,
				body: {
					[Symbol.asyncIterator]: () => ({
						next: () => {
							if (listener === undefined && init?.signal !== undefined) {
								// One token arrives, then nothing — the stall timer is
								// satisfied and the total-time timeout must take over.
								return new Promise<IteratorResult<Uint8Array | string>>((resolve, reject) => {
									listener = () =>
										reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
									init?.signal?.addEventListener('abort', listener, { once: true });
									resolve({ value: delta('começou'), done: false });
								});
							}
							return new Promise<IteratorResult<Uint8Array | string>>((_, reject) => {
								init?.signal?.addEventListener(
									'abort',
									() => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })),
									{ once: true },
								);
							});
						},
					}),
				},
				text: async () => '',
			};
		}, {
			turnTimeoutMs: 200,
			firstTokenTimeoutMs: 5_000,
		});
		await chat.saveProvider({ baseUrl: LOCAL_URL });
		const log = new EventLog();

		await chat.sendMessage(await sendInput(chat), log.sink);
		await log.wait();

		assert.notStrictEqual(log.deltas, '', 'the first token arrived before the stall');
		assert.strictEqual(log.terminal.type, 'error');
		assert.match(
			log.terminal.type === 'error' ? log.terminal.message : '',
			/excedeu 0s no total/,
		);
		assert.strictEqual(chat.isBusy, false);
	});

	test('a stop keeps reading as a stop: no cause is invented for it', async () => {
		const chat = await readySession(async (url, init) => ({
			ok: true,
			status: 200,
			body: neverStream(init?.signal),
			text: async () => (url.endsWith('/models') ? JSON.stringify({ data: [{ id: 'llama3' }] }) : ''),
		}));
		const log = new EventLog();

		await chat.sendMessage(await sendInput(chat), log.sink);
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.strictEqual(chat.stop(), true);
		await log.wait();

		assert.strictEqual(log.terminal.type, 'done');
		assert.strictEqual(log.terminal.type === 'done' ? log.terminal.reason : '', 'aborted');
	});

	test('stop ends the turn and reports aborted rather than failing', async () => {
		const chat = await readySession(async () => ({
			ok: true,
			status: 200,
			body: {
				[Symbol.asyncIterator]: async function* () {
					yield delta('before the stop');
					// Long enough that stop() lands inside the stream.
					await new Promise((resolve) => setTimeout(resolve, 300));
					yield delta('never delivered');
					yield DONE;
				},
			},
			text: async () => '',
		}));
		const log = new EventLog();

		await chat.sendMessage(await sendInput(chat, ), log.sink);
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.strictEqual(chat.stop(), true);
		await log.wait();

		assert.strictEqual(log.terminal.type, 'done');
		assert.strictEqual(log.terminal.type === 'done' ? log.terminal.reason : '', 'aborted');
		assert.strictEqual(log.deltas, 'before the stop', 'what arrived is kept, what did not never appears');
	});

	test('stop with nothing running reports false', () => {
		assert.strictEqual(session().stop(), false);
	});

	// ── Etapa 14A, Bloco 1: the abort cause travels as data ─────────────────
	//
	// The defect these cover: the orchestrator decided "is this worth retrying"
	// by searching the failure message for the English words `timeout`,
	// `overloaded`, `rate limit`. The message the timers produce is Portuguese,
	// so every real timeout classified as *not* recoverable and the fallback path
	// silently never ran. The fix moves the fact out of the prose and into a
	// typed field; these assert the field, and that the two things which must
	// never trigger a retry still do not.

	test('a stall reports its cause as data, not only as prose', async () => {
		const signalRef: { signal?: AbortSignal } = {};
		const chat = session(stalledFetch(signalRef), {
			turnTimeoutMs: 5_000,
			firstTokenTimeoutMs: 80,
		});
		await chat.saveProvider({ baseUrl: LOCAL_URL });
		const log = new EventLog();

		await chat.sendMessage(await sendInput(chat), log.sink);
		await log.wait();

		assert.strictEqual(log.terminal.type, 'error');
		assert.strictEqual(
			log.terminal.type === 'error' ? log.terminal.abortCause : undefined,
			'first-token',
			'the cause must survive as data, because the message cannot be trusted to carry it',
		);
	});

	test('a total-time abort reports its own cause, distinct from a stall', async () => {
		const chat = session(
			async (_url, init) => {
				let listener: (() => void) | undefined;
				return {
					ok: true,
					status: 200,
					body: {
						[Symbol.asyncIterator]: () => ({
							next: () => {
								if (listener === undefined && init?.signal !== undefined) {
									return new Promise<IteratorResult<Uint8Array | string>>((resolve, reject) => {
										listener = () =>
											reject(
												Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }),
											);
										init?.signal?.addEventListener('abort', listener, { once: true });
										resolve({ value: delta('começou'), done: false });
									});
								}
								return new Promise<IteratorResult<Uint8Array | string>>((_, reject) => {
									init?.signal?.addEventListener(
										'abort',
										() => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })),
										{ once: true },
									);
								});
							},
						}),
					},
					text: async () => '',
				};
			},
			{ turnTimeoutMs: 200, firstTokenTimeoutMs: 5_000 },
		);
		await chat.saveProvider({ baseUrl: LOCAL_URL });
		const log = new EventLog();

		await chat.sendMessage(await sendInput(chat), log.sink);
		await log.wait();

		assert.strictEqual(log.terminal.type, 'error');
		assert.strictEqual(
			log.terminal.type === 'error' ? log.terminal.abortCause : undefined,
			'total-time',
		);
	});

	test('a genuine failure carries no abort cause at all', async () => {
		const chat = await readySession(async () => ({
			ok: false,
			status: 400,
			body: null,
			text: async () => 'bad request',
		}));
		const log = new EventLog();

		await chat.sendMessage(await sendInput(chat), log.sink);
		await log.wait();

		assert.strictEqual(log.terminal.type, 'error');
		// Absent, not `'total-time'` or some invented value: "no cause" is what
		// tells the orchestrator to classify the failure on its own merits.
		assert.strictEqual(
			log.terminal.type === 'error' ? log.terminal.abortCause : 'set',
			undefined,
		);
	});

	test('the abort cause crosses the bridge without being rewritten', () => {
		const parsed = parseChatStreamEvent({
			type: 'error',
			turnId: 'turn-1',
			message: 'O modelo não começou a responder em 60s.',
			abortCause: 'first-token',
		});

		assert.strictEqual(parsed.type, 'error');
		assert.strictEqual(
			parsed.type === 'error' ? parsed.abortCause : undefined,
			'first-token',
		);
	});

	test('an invented abort cause is refused rather than becoming a fourth kind', () => {
		assert.throws(
			() =>
				parseChatStreamEvent({
					type: 'error',
					turnId: 'turn-1',
					message: 'x',
					abortCause: 'felt-slow',
				}),
			/unknown abortCause/,
		);
	});

	test('a user stop is never treated as a recoverable failure', () => {
		// The user pressing Stop is a decision, not a fault of the model. Retrying
		// elsewhere would override it.
		assert.strictEqual(
			shouldFallback({ abortCause: 'user-stop', timeoutConfigured: true }),
			false,
		);
		assert.strictEqual(
			shouldFallback({ abortCause: 'user-stop', timeoutConfigured: true, hadToolCalls: false }),
			false,
		);
	});

	test('a timeout with a configured budget is recoverable', () => {
		assert.strictEqual(
			shouldFallback({ abortCause: 'first-token', timeoutConfigured: true }),
			true,
		);
		assert.strictEqual(
			shouldFallback({ abortCause: 'total-time', timeoutConfigured: true }),
			true,
		);
	});

	test('a timeout with no configured budget is not recoverable', () => {
		// The "no fallback on an arbitrary delay" rule. With no budget there is
		// nothing to have exceeded, so a slow-but-progressing turn must not move
		// the turn to a different model mid-answer.
		assert.strictEqual(
			shouldFallback({ abortCause: 'first-token', timeoutConfigured: false }),
			false,
		);
		assert.strictEqual(
			shouldFallback({ abortCause: 'total-time' }),
			false,
			'an unconfigured budget defaults to not treating a delay as a fault',
		);
	});

	test('a turn that already ran a tool is never retried, however innocent the failure', () => {
		// Checked before the cause on purpose: a turn that wrote a file or ran a
		// command cannot be repeated just because the model was then slow.
		assert.strictEqual(
			shouldFallback({ abortCause: 'total-time', timeoutConfigured: true, hadToolCalls: true }),
			false,
		);
		assert.strictEqual(
			shouldFallback({ error: new Error('503 service unavailable'), hadToolCalls: true }),
			false,
		);
	});

	test('a real failure with no cause is still classified on its own message', () => {
		assert.strictEqual(shouldFallback({ error: new Error('503 service unavailable') }), true);
		assert.strictEqual(shouldFallback({ error: new Error('Authentication failed (HTTP 401)') }), false);
		assert.strictEqual(shouldFallback({ error: 'not an Error' }), false);
	});

	test('a timeout moves on to the next eligible model', () => {
		const second = selectable('p', 'segundo');
		const continuation = continueOrchestration(
			{ primary: selectable('p', 'primeiro'), candidates: [second] },
			[
				{
					attempt: 1,
					model: selectable('p', 'primeiro'),
					error: new Error('O modelo não começou a responder em 60s.'),
					recoverable: true,
					timestamp: '2024-01-01T00:00:00.000Z',
				},
			],
			new Error('O modelo não começou a responder em 60s.'),
			3,
			'fallback',
			{ abortCause: 'first-token' },
		);

		assert.strictEqual(continuation.nextModel?.modelId, 'segundo');
		assert.strictEqual(continuation.recoverable, true);
		assert.match(continuation.reason, /Timeout esperando o primeiro token/);
	});

	test('a user stop moves on to nothing', () => {
		const continuation = continueOrchestration(
			{ primary: selectable('p', 'primeiro'), candidates: [selectable('p', 'segundo')] },
			[
				{
					attempt: 1,
					model: selectable('p', 'primeiro'),
					error: new Error('abortado'),
					recoverable: true,
					timestamp: '2024-01-01T00:00:00.000Z',
				},
			],
			new Error('abortado'),
			3,
			'fallback',
			{ abortCause: 'user-stop' },
		);

		assert.strictEqual(continuation.nextModel, undefined);
		assert.strictEqual(continuation.recoverable, false);
	});

	test('a timeout does not retry a model that already ran tools', () => {
		// `continueOrchestration` trusts the caller's `recoverable`, which is what
		// `shouldFallback` already set to false once a tool ran. The two decisions
		// together are the guarantee; this pins the second half.
		const continuation = continueOrchestration(
			{ primary: selectable('p', 'primeiro'), candidates: [selectable('p', 'segundo')] },
			[
				{
					attempt: 1,
					model: selectable('p', 'primeiro'),
					error: new Error('excedeu o tempo'),
					// What `shouldFallback` records when a tool had already run.
					recoverable: false,
					timestamp: '2024-01-01T00:00:00.000Z',
				},
			],
			new Error('excedeu o tempo'),
			3,
			'fallback',
			{ abortCause: 'total-time' },
		);

		assert.strictEqual(continuation.nextModel, undefined);
	});

	// ── Etapa 14A, correções: stop reaches the fallback, timers never leak ──

	/**
	 * Two providers: the first stalls until its budget runs out, the second would
	 * answer. This is the shape needed to prove both corrections — that the stop
	 * lands on the *fallback* attempt, and that the loop's timers do not outlive
	 * the turn.
	 */
	function twoProviderFetch(options: {
		readonly firstHangs?: boolean;
		readonly secondHangs?: boolean;
		readonly stallMs?: number;
	}): { fetch: FetchLike; posts: string[] } {
		const posts: string[] = [];
		const fetchImpl: FetchLike = async (url, init) => {
			if (url.endsWith('/models')) {
				// Two providers, two models, so the selector has a fallback to pick.
				return {
					ok: true,
					status: 200,
					text: async () =>
						JSON.stringify(
							url.includes('11434')
								? { data: [{ id: 'modelo-lento' }] }
								: { data: [{ id: 'modelo-rapido' }] },
						),
				};
			}
			const isSecond = url.includes('11435');
			posts.push(isSecond ? 'segundo' : 'primeiro');
			const hangs = isSecond ? options.secondHangs === true : options.firstHangs === true;
			if (!hangs) {
				return sseResponse([delta('resposta'), DONE]);
			}
			return {
				ok: true,
				status: 200,
				body: neverStream(init?.signal),
				text: async () => '',
			};
		};
		return { fetch: fetchImpl, posts };
	}

	/** Saves both providers on one session, so the fallback has somewhere to go. */
	async function twoProviderSession(
		fetchImpl: FetchLike,
		options: { readonly turnTimeoutMs?: number; readonly firstTokenTimeoutMs?: number } = {},
	): Promise<ChatSession> {
		const chat = session(fetchImpl, options);
		await chat.saveProvider({ baseUrl: LOCAL_URL });
		await chat.saveProvider({ baseUrl: SECOND_URL });
		return chat;
	}

	test('stop reaches the fallback attempt that is currently running', async () => {
		// The defect: each attempt releases the session slot on its way out, so
		// between attempts nothing is registered and `stop()` answered `false` while
		// the second model was already generating. The user pressed stop and the
		// turn carried on.
		const { fetch: fetchImpl, posts } = twoProviderFetch({
			firstHangs: true,
			secondHangs: true,
			stallMs: 40,
		});
		const chat = await twoProviderSession(fetchImpl, {
			firstTokenTimeoutMs: 40,
			turnTimeoutMs: 5_000,
		});
		const log = new EventLog();

		await chat.sendMessage(await sendInput(chat, { strategy: 'fallback' }), log.sink);

		// Wait until the first attempt has timed out and the second has started.
		const deadline = Date.now() + 2_000;
		while (posts.length < 2 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		assert.deepStrictEqual(posts, ['primeiro', 'segundo'], 'the fallback attempt really did start');

		// The stop has to land *here*: on the second attempt, with the session
		// still reporting busy.
		assert.strictEqual(chat.isBusy, true, 'the turn is still running when stop is pressed');
		assert.strictEqual(chat.stop(), true, 'stop must find the fallback attempt to abort');

		await log.wait();
		assert.strictEqual(chat.isBusy, false, 'and the session is free once it settles');
	});

	test('an orchestration gives the slot back exactly once, when it is over', async () => {
		const { fetch: fetchImpl } = twoProviderFetch({});
		const chat = await twoProviderSession(fetchImpl, {
			firstTokenTimeoutMs: 2_000,
			turnTimeoutMs: 5_000,
		});
		const log = new EventLog();

		await chat.sendMessage(await sendInput(chat, { strategy: 'fallback' }), log.sink);
		await log.wait();

		assert.strictEqual(chat.isBusy, false, 'a finished orchestration does not keep the session busy');
		assert.strictEqual(chat.stop(), false, 'and there is nothing left to stop');
	});

	test('a turn that throws before its stream exists still frees the session', async () => {
		// The path `release()` never covered: the provider throws before the stream
		// exists, so `runAgentTurn` is never reached and the only thing standing
		// between a throw and two armed timers was the `finally`. Without it the
		// stall timer stays armed for its whole budget and, on firing, calls
		// `cancelAll` on the session's broker — denying whichever turn's
		// permission dialog happens to be open at that moment.
		const chat = await readySession(async (url, init) => {
			if (url.endsWith('/models')) {
				return {
					ok: true,
					status: 200,
					text: async () => JSON.stringify({ data: [{ id: 'llama3' }] }),
				};
			}
			if (throwing) {
				throw Object.assign(new Error('socket destroyed'), { code: 'ECONNRESET' });
			}
			// The second turn hangs, so a leftover timer from the first has a
			// window in which to act on it.
			return { ok: true, status: 200, body: neverStream(init?.signal), text: async () => '' };
		});
		let throwing = true;
		const log = new EventLog();

		await chat.sendMessage(await sendInput(chat), log.sink);
		await log.wait();

		assert.strictEqual(log.terminal.type, 'error', 'the thrown provider surfaced as an error');
		assert.strictEqual(chat.isBusy, false, 'and the session is free');

		throwing = false;
		const second = new EventLog();
		await chat.sendMessage(await sendInput(chat), second.sink);
		// Past the first turn's whole stall budget, which is where a leaked timer
		// would have fired against this turn. The second turn's own budgets are the
		// 60s/120s defaults, so it is nowhere near ending on its own.
		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.strictEqual(
			second.settled,
			undefined,
			'a leftover timer from the finished turn must not settle the turn that replaced it',
		);
		assert.strictEqual(chat.isBusy, true, 'the second turn is still running on its own budget');
		assert.strictEqual(chat.stop(), true, 'and it is still stoppable');
		await second.wait();
	});

	test('a second send while a turn runs is refused', async () => {
		const chat = await readySession(async () => ({
			ok: true,
			status: 200,
			body: {
				[Symbol.asyncIterator]: async function* () {
					await new Promise((resolve) => setTimeout(resolve, 120));
					yield delta('slow');
					yield DONE;
				},
			},
			text: async () => '',
		}));
		const log = new EventLog();

		await chat.sendMessage(await sendInput(chat), log.sink);
		// A *different* conversation, so the refusal is about the running turn and
		// not about the id being reused.
		const other = await sendInput(chat);
		await assert.rejects(() => chat.sendMessage(other, log.sink), /already running/);
		await log.wait();

		assert.strictEqual(chat.isBusy, false, 'and the session is free again afterwards');
	});

	test('two sends overlapping before the first turn starts are refused', async () => {
		const chat = await readySession(async () => ({
			ok: true,
			status: 200,
			body: {
				[Symbol.asyncIterator]: async function* () {
					yield delta('slow');
					yield DONE;
				},
			},
			text: async () => '',
		}));
		const firstInput = await sendInput(chat);
		const secondInput = await sendInput(chat);
		const firstLog = new EventLog();

		// No await between them: the first send is still inside its own first
		// `await` when the second arrives. The slot used to be reserved after
		// that await, so both passed the guard and two turns ran over one
		// session — with `stop()` reaching only the one still registered.
		const first = chat.sendMessage(firstInput, firstLog.sink);
		const second = chat.sendMessage(secondInput, new EventLog().sink);
		await assert.rejects(() => second, /already running/);

		await first;
		await firstLog.wait();
		assert.strictEqual(chat.isBusy, false, 'and the session is free again afterwards');
	});

	test('a conversation continues through a different provider', async () => {
		// This used to be refused outright, on the grounds that answering a
		// conversation from another endpoint "mixes transcripts". From the user's
		// side that was the same thing as not being able to try a second model on
		// an existing thread: the conversation disappeared from the list and an
		// empty one took its place.
		const { fetchImpl } = scriptedFetch([delta('from the second provider'), DONE]);
		const chat = await readySession(fetchImpl);
		const input = await sendInput(chat);

		// A second endpoint, configured exactly as a user would add one.
		await chat.saveProvider({ baseUrl: SECOND_URL, name: 'Second' });
		const second = chat.listProviders().find((p) => p.baseUrl === SECOND_URL);
		assert.ok(second, 'the second provider is configured');

		const log = new EventLog();
		await chat.sendMessage({ ...input, providerId: second.id }, log.sink);
		await log.wait();

		assert.strictEqual(log.deltas, 'from the second provider');
		assert.strictEqual(chat.isBusy, false, 'and the session is free afterwards');
	});

	test('a retry with empty messages re-runs the turn without duplicating the user text', async () => {
		const { fetchImpl, calls } = scriptedFetch([delta('answer'), DONE]);
		const chat = await readySession(fetchImpl);
		const input = await sendInput(chat);

		const firstLog = new EventLog();
		await chat.sendMessage(input, firstLog.sink);
		await firstLog.wait();
		assert.strictEqual(firstLog.terminal.type, 'done', 'the first turn itself works');

		// The retry: same conversation, same model, no new message — the user's
		// text is already in the transcript and must not be appended again.
		const retryLog = new EventLog();
		await chat.sendMessage({ ...input, messages: [] }, retryLog.sink);
		await retryLog.wait();

		assert.strictEqual(retryLog.terminal.type, 'done');
		const posts = calls.filter((call) => call.url.endsWith('/chat/completions'));
		assert.strictEqual(posts.length, 2, 'the model was called once per turn');
		const secondMessages = JSON.parse(posts[1].body ?? '{}').messages as { role: string }[];
		assert.strictEqual(
			secondMessages.filter((message) => message.role === 'user').length,
			1,
			'exactly one user message, from the original send',
		);

		const opened = await chat.openConversation(input.conversationId);
		const transcript = opened.messages.map((message) => message.role);
		assert.deepStrictEqual(transcript, ['user', 'assistant', 'assistant']);
	});

	test('a missing conversation fails the send, not the stream', async () => {
		const chat = session();
		const log = new EventLog();

		// Nothing was created, so this rejects before a single event is emitted.
		await assert.rejects(
			() =>
				chat.sendMessage(
					{
						providerId: LOCAL_ID,
						conversationId: 'ghost',
						model: 'llama3',
						messages: [{ role: 'user', content: 'hello' }],
					},
					log.sink,
				),
			/No conversation with id "ghost"/,
		);
		assert.deepStrictEqual(log.events, []);
	});

	// ── history ──────────────────────────────────────────────────────────────

	test('the turn is persisted and replayed as context on the next one', async () => {
		const { fetchImpl, calls } = scriptedFetch([delta('first answer'), DONE]);
		const chat = await readySession(fetchImpl);
		// One conversation for both turns: context continuity is the thing under
		// test, and two conversations would prove the opposite.
		const conversation = await chat.createConversation({ providerId: LOCAL_ID });
		const input = (content: string): SendMessageInput => ({
			providerId: LOCAL_ID,
			conversationId: conversation.summary.id,
			model: 'llama3',
			messages: [{ role: 'user', content }],
		});

		const first = new EventLog();
		await chat.sendMessage(input('one'), first.sink);
		await first.wait();

		const second = new EventLog();
		await chat.sendMessage(input('two'), second.sink);
		await second.wait();

		// The second request carries the whole transcript, in order.
		const bodies = calls
			.filter((call) => call.body !== undefined)
			.map((call) => call.body as string);
		assert.strictEqual(bodies.length, 2);
		const firstBody = JSON.parse(bodies[0]) as { messages: { content: string }[] };
		// The Seshyina Agent identity leads every request, injected per turn.
		assert.deepStrictEqual(firstBody.messages.map((message) => message.content), [
			SESHYINA_AGENT_IDENTITY,
			'one',
		]);

		const secondBody = JSON.parse(bodies[1]) as { messages: { content: string }[] };
		assert.deepStrictEqual(secondBody.messages.map((message) => message.content), [
			SESHYINA_AGENT_IDENTITY,
			'one',
			'first answer',
			'two',
		]);
	});

	test('the transcript survives recreating the session over the same files', async () => {
		const first = await readySession(scriptedFetch([delta('remembered'), DONE]).fetchImpl);
		const conversation = await first.createConversation({ providerId: LOCAL_ID });
		const log = new EventLog();
		await first.sendMessage(
			{
				providerId: LOCAL_ID,
				conversationId: conversation.summary.id,
				model: 'llama3',
				messages: [{ role: 'user', content: 'remember me' }],
			},
			log.sink,
		);
		await log.wait();

		// Second process: same files, fresh objects.
		const second = session();
		assert.deepStrictEqual(second.listProviders().map((provider) => provider.baseUrl), [LOCAL_URL]);

		const listed = await second.listConversations();
		assert.strictEqual(listed.length, 1);
		assert.strictEqual(listed[0].id, conversation.summary.id);

		const opened = await second.openConversation(conversation.summary.id);
		assert.deepStrictEqual(opened.messages, [
			{ role: 'user', content: 'remember me' },
			{ role: 'assistant', content: 'remembered' },
		]);
	});

	test('the stored key is used without the renderer resending it', async () => {
		const { fetchImpl, calls } = scriptedFetch([delta('ok'), DONE]);
		const chat = await sessionWithStoredKey(fetchImpl);
		const log = new EventLog();

		await chat.sendMessage(await sendInput(chat, ), log.sink);
		await log.wait();

		const chatCall = calls.find((call) => call.url.endsWith('/chat/completions'));
		assert.strictEqual(chatCall?.headers.authorization, `Bearer ${KEY}`);
	});

	test('no key stored means no authorization header at all', async () => {
		const { fetchImpl, calls } = scriptedFetch([delta('ok'), DONE]);
		const chat = await readySession(fetchImpl);
		const log = new EventLog();

		await chat.sendMessage(await sendInput(chat, ), log.sink);
		await log.wait();

		const chatCall = calls.find((call) => call.url.endsWith('/chat/completions'));
		assert.ok(!('authorization' in (chatCall?.headers ?? {})));
	});

	// ── secrets on disk ──────────────────────────────────────────────────────

	test('the key is in secrets.json and in no other file', async () => {
		await session().saveProvider({ baseUrl: LOCAL_URL, apiKey: KEY });

		assert.ok((await readFile(join(root, 'secrets.json'), 'utf8')).includes(KEY));

		const state = await readFile(join(root, 'state.json'), 'utf8');
		assert.ok(!state.includes(KEY), 'the state file must not hold the key');
		assert.ok(state.includes(providerApiKeyRef(LOCAL_ID)), 'but it holds the reference');
	});

	test('a transcript written by a turn contains no key', async () => {
		const chat = await sessionWithStoredKey(scriptedFetch([delta('all good'), DONE]).fetchImpl);
		const log = new EventLog();

		await chat.sendMessage(await sendInput(chat, ), log.sink);
		await log.wait();

		const files = await readdir(join(root, 'data', 'conversations'));
		assert.ok(files.length > 0);
		for (const file of files) {
			assert.ok(!(await readFile(join(root, 'data', 'conversations', file), 'utf8')).includes(KEY));
		}
	});

	// ── conversations ────────────────────────────────────────────────────────

	test('conversations are created, listed and opened independently', async () => {
		const chat = await readySession(scriptedFetch([]).fetchImpl);

		const first = await chat.createConversation({ providerId: LOCAL_ID, title: 'First' });
		const second = await chat.createConversation({ providerId: LOCAL_ID, title: 'Second' });

		assert.notStrictEqual(first.summary.id, second.summary.id);
		const listed = await chat.listConversations();
		assert.strictEqual(listed.length, 2);
		assert.deepStrictEqual(new Set(listed.map((item) => item.id)), new Set([
			first.summary.id,
			second.summary.id,
		]));
		assert.deepStrictEqual((await chat.openConversation(first.summary.id)).messages, []);
	});

	test('a conversation can be renamed and the title persists', async () => {
		const chat = await readySession(scriptedFetch([]).fetchImpl);
		const conversation = await chat.createConversation({ providerId: LOCAL_ID, title: 'Before' });

		const renamed = await chat.renameConversation(conversation.summary.id, 'After');

		assert.strictEqual(renamed.title, 'After');
		assert.strictEqual(
			(await chat.openConversation(conversation.summary.id)).summary.title,
			'After',
		);
	});

	test('creating a conversation for an unknown provider is refused', async () => {
		const chat = session();

		await assert.rejects(
			() => chat.createConversation({ providerId: 'ghost' }),
			/No provider named "ghost"/,
		);
		// The list is not scoped to a provider, so there is nothing to be empty
		// for here: a conversation created for a provider that does not exist is
		// refused above, and every conversation that does exist is listed.
		assert.ok(Array.isArray(await chat.listConversations()));
	});

	test('a conversation outlives the provider it was created with', async () => {
		// The regression this pins: the list used to be filtered by provider, so
		// selecting a second provider's model swapped the conversation list and the
		// conversation being read appeared to be thrown away. A turn names its own
		// provider, so a conversation is a transcript and the provider is a
		// per-turn choice — the two are independent.
		const chat = await readySession(scriptedFetch([]).fetchImpl);
		const conversation = await chat.createConversation({ providerId: LOCAL_ID, title: 'Carried' });

		// A second provider, configured and enabled, exactly like a user adding a
		// second endpoint.
		await chat.saveProvider({ baseUrl: SECOND_URL, name: 'Second' });

		const listed = await chat.listConversations();
		assert.deepStrictEqual(
			new Set(listed.map((item) => item.id)),
			new Set([conversation.summary.id]),
			'the conversation is listed once, not once per configured provider',
		);

		// And it is still readable under the new provider's selection.
		const opened = await chat.openConversation(conversation.summary.id);
		assert.strictEqual(opened.summary.title, 'Carried');
	});

	test('opening a missing conversation is refused rather than returning an empty one', async () => {
		const chat = await readySession(scriptedFetch([]).fetchImpl);

		// An empty view would look like lost history.
		await assert.rejects(() => chat.openConversation('ghost'), /No conversation with id "ghost"/);
	});

	test('deleting a conversation removes it and leaves the others', async () => {
		const chat = await readySession(scriptedFetch([]).fetchImpl);
		const first = await chat.createConversation({ providerId: LOCAL_ID, title: 'Keep' });
		const second = await chat.createConversation({ providerId: LOCAL_ID, title: 'Drop' });

		assert.strictEqual(await chat.deleteConversation(second.summary.id), 'deleted');
		// R4M: a segunda exclusão é um sucesso idempotente, e diz que
		// encontrou a conversa já ausente — não um `false` ambíguo.
		assert.strictEqual(await chat.deleteConversation(second.summary.id), 'absent');
		assert.deepStrictEqual(
			(await chat.listConversations()).map((item) => item.id),
			[first.summary.id],
		);
	});

	// O resgate do histórico envenenado.
	//
	// Medido: "Preferências de modelo" acumulou 56 mensagens em duas semanas,
	// quatro delas seguidas do usuário e sem resposta. O modelo lê o transcript
	// inteiro a cada turno, então o lixo não sai sozinho — e a conversa
	// permanente não tem lixeira, o que deixava a edição do disco como única
	// saída. O reset limpa as mensagens e mantém o que a pessoa escolheu.
	test('o reset limpa as mensagens e mantém título, vínculos e a marca de permanente', async () => {
		const chat = await readySession(scriptedFetch([]).fetchImpl);
		const dialogue = await chat.createConversation({
			providerId: LOCAL_ID,
			title: 'Preferências de modelo',
			systemPrompt: 'Você configura as preferências de modelo.',
		});
		await chat.setConversationPinned(dialogue.summary.id, true);

		// Um histórico com o defeito: mensagens do usuário sem resposta.
		const store = new FileDataStore({ rootPath: join(root, 'data') });
		await store.appendMessages(dialogue.summary.id, [
			{ role: 'user', content: 'quais sao os modelos disponiveis?' },
			{ role: 'user', content: 'ola' },
			{ role: 'user', content: 'ola' },
		]);
		assert.ok((await chat.listConversations())[0]?.messageCount === 3);

		const reset = await chat.resetConversation(dialogue.summary.id);

		assert.equal(reset.title, 'Preferências de modelo', 'o título fica');
		assert.equal(reset.pinned, true, 'a marca de permanente fica');
		assert.equal(reset.providerId, LOCAL_ID, 'o provedor fica');

		// A instrução de sistema é uma mensagem `system`; ela não pode sumir
		// junto, ou o diálogo passa a responder como um chat comum.
		const stored = await new FileDataStore({ rootPath: join(root, 'data') }).getConversation(
			dialogue.summary.id,
		);
		const roles = (stored?.messages ?? []).map((message) => message.role);
		assert.deepEqual(roles, ['system'], 'só a instrução de sistema sobrou');
		const system = stored?.messages[0];
		assert.equal(
			system?.role === 'system' ? system.content : '',
			'Você configura as preferências de modelo.',
		);
		// `seq` recomeça: o modelo não deve ver buracos na numeração.
		assert.equal(stored?.messages[0]?.seq, 0);

		// A permanente continua recusando a exclusão — o reset não a tornou
		// uma conversa comum.
		await assert.rejects(() => chat.deleteConversation(dialogue.summary.id), /permanente/);
	});

	test('uma conversa permanente recusa a exclusão e sobrevive ao relê', async () => {
		const chat = await readySession(scriptedFetch([]).fetchImpl);
		const dialogue = await chat.createConversation({
			providerId: LOCAL_ID,
			title: 'Preferências de modelo',
		});
		await chat.setConversationPinned(dialogue.summary.id, true);

		await assert.rejects(
			() => chat.deleteConversation(dialogue.summary.id),
			/permanente/,
			'a exclusão é recusada pelo store, não só escondida na interface',
		);
		// A recusa não pode ter deixado a lista num estado que diga o contrário.
		const listed = await chat.listConversations();
		assert.strictEqual(listed[0]?.pinned, true);
		assert.strictEqual(listed[0]?.id, dialogue.summary.id);

		// Uma sessão nova sobre os mesmos arquivos lê a marca do disco.
		const reopened = session();
		const again = (await reopened.listConversations()).find(
			(item) => item.id === dialogue.summary.id,
		);
		assert.strictEqual(again?.pinned, true);

		// Desmarcada, volta a ser uma conversa comum — e a chave some do disco.
		await reopened.setConversationPinned(dialogue.summary.id, false);
		const record = await new FileDataStore({ rootPath: join(root, 'data') }).getConversation(
			dialogue.summary.id,
		);
		assert.strictEqual(record?.pinned, undefined);
		assert.strictEqual(await reopened.deleteConversation(dialogue.summary.id), 'deleted');
	});

	test('conversations are listed newest activity first', async () => {
		// Timestamps come from an injected clock rather than a `createdAt` field:
		// the contract has no such field, and inventing one only for a test would
		// be a way for a caller to fake its own position in the list.
		const stamps = ['2026-01-01T00:00:00.000Z', '2026-01-05T00:00:00.000Z'];
		let index = 0;
		const chat = new ChatSession({
			config: new ProviderConfigService(
				new FileStateStore({ filePath: join(root, 'state.json') }),
			),
			secrets: new FileSecretStore({ filePath: join(root, 'secrets.json') }),
			history: new FileDataStore({ rootPath: join(root, 'data') }),
			logger: new LoggingService(
				new ConsoleLogSink({ out: () => undefined, err: () => undefined }),
			),
			now: () => stamps[Math.min(index++, stamps.length - 1)],
		});
		await chat.saveProvider({ baseUrl: LOCAL_URL });

		const older = await chat.createConversation({ providerId: LOCAL_ID, title: 'Older' });
		const newer = await chat.createConversation({ providerId: LOCAL_ID, title: 'Newer' });

		const listed = await chat.listConversations();
		assert.deepStrictEqual(
			listed.map((item) => item.id),
			[newer.summary.id, older.summary.id],
		);
	});

	// ── the system prompt ────────────────────────────────────────────────────

	test('a system prompt reaches the model on the very first turn', async () => {
		const { fetchImpl, calls } = scriptedFetch([delta('ok'), DONE]);
		const chat = await readySession(fetchImpl);
		const conversation = await chat.createConversation({
			providerId: LOCAL_ID,
			systemPrompt: 'you are a terse assistant',
		});

		const log = new EventLog();
		await chat.sendMessage(
			{
				providerId: LOCAL_ID,
				conversationId: conversation.summary.id,
				model: 'llama3',
				messages: [{ role: 'user', content: 'hi' }],
			},
			log.sink,
		);
		await log.wait();

		const body = JSON.parse(calls[0].body ?? '{}') as {
			messages: { role: string; content: string }[];
		};
		// Uma **só** mensagem `system`: a identidade e o prompt da conversa
		// juntos. Duas recebem `invalid_request` em provedores como o River —
		// medido com o Qwen: a conversa com prompt próprio nunca respondia.
		assert.deepStrictEqual(body.messages, [
			{
				role: 'system',
				content: `${SESHYINA_AGENT_IDENTITY}\n\n---\n\nyou are a terse assistant`,
			},
			{ role: 'user', content: 'hi' },
		]);
	});

	test('a prompt set later is replayed before the existing history', async () => {
		const { fetchImpl, calls } = scriptedFetch([delta('ok'), DONE]);
		const chat = await readySession(fetchImpl);
		const conversation = await chat.createConversation({ providerId: LOCAL_ID });

		const first = new EventLog();
		await chat.sendMessage(
			{
				providerId: LOCAL_ID,
				conversationId: conversation.summary.id,
				model: 'llama3',
				messages: [{ role: 'user', content: 'before' }],
			},
			first.sink,
		);
		await first.wait();

		await chat.setSystemPrompt(conversation.summary.id, 'added later');

		const second = new EventLog();
		await chat.sendMessage(
			{
				providerId: LOCAL_ID,
				conversationId: conversation.summary.id,
				model: 'llama3',
				messages: [{ role: 'user', content: 'after' }],
			},
			second.sink,
		);
		await second.wait();

		const bodies = calls
			.filter((call) => call.body !== undefined)
			.map((call) => call.body as string);
		const secondBody = JSON.parse(bodies[1]) as {
			messages: { role: string; content: string }[];
		};
		// A identidade e o prompt são **uma** mensagem, e ela vem antes de todo
		// o histórico. Duas mensagens `system` recebem `invalid_request` em
		// provedores como o River (medido com o Qwen), então a junção é o que
		// faz um prompt adicionado depois chegar ao modelo.
		assert.deepStrictEqual(secondBody.messages.map((message) => message.role), [
			'system',
			'user',
			'assistant',
			'user',
		]);
		assert.match(secondBody.messages[0]?.content ?? '', /added later/);
		// Uma mensagem só: a identidade e o prompt juntos.
		assert.strictEqual(
			secondBody.messages[0].content,
			`${SESHYINA_AGENT_IDENTITY}\n\n---\n\nadded later`,
		);
	});

	test('a prompt belongs to one conversation and never leaks into another', async () => {
		const { fetchImpl, calls } = scriptedFetch([delta('ok'), DONE]);
		const chat = await readySession(fetchImpl);
		const prompted = await chat.createConversation({
			providerId: LOCAL_ID,
			systemPrompt: 'only for this one',
		});
		const plain = await chat.createConversation({ providerId: LOCAL_ID });

		const log = new EventLog();
		await chat.sendMessage(
			{
				providerId: LOCAL_ID,
				conversationId: plain.summary.id,
				model: 'llama3',
				messages: [{ role: 'user', content: 'hi' }],
			},
			log.sink,
		);
		await log.wait();

		const body = JSON.parse(calls[0].body ?? '{}') as { messages: { role: string; content: string }[] };
		// The identity is injected per turn; the conversation's own prompt stays empty.
		assert.deepStrictEqual(body.messages.map((message) => message.role), ['system', 'user']);
		assert.strictEqual(body.messages[0].content, SESHYINA_AGENT_IDENTITY);
		assert.strictEqual((await chat.openConversation(plain.summary.id)).systemPrompt, '');
		assert.strictEqual(
			(await chat.openConversation(prompted.summary.id)).systemPrompt,
			'only for this one',
		);
	});

	test('clearing a prompt removes it from the next request', async () => {
		const { fetchImpl, calls } = scriptedFetch([delta('ok'), DONE]);
		const chat = await readySession(fetchImpl);
		const conversation = await chat.createConversation({
			providerId: LOCAL_ID,
			systemPrompt: 'temporary',
		});

		await chat.setSystemPrompt(conversation.summary.id, '');

		const log = new EventLog();
		await chat.sendMessage(
			{
				providerId: LOCAL_ID,
				conversationId: conversation.summary.id,
				model: 'llama3',
				messages: [{ role: 'user', content: 'hi' }],
			},
			log.sink,
		);
		await log.wait();

		const body = JSON.parse(calls[0].body ?? '{}') as { messages: { role: string; content: string }[] };
		// The prompt was cleared; only the injected identity remains as system.
		assert.deepStrictEqual(body.messages.map((message) => message.role), ['system', 'user']);
		assert.strictEqual(body.messages[0].content, SESHYINA_AGENT_IDENTITY);
		assert.strictEqual((await chat.openConversation(conversation.summary.id)).systemPrompt, '');
	});

	test('two conversations keep entirely separate contexts', async () => {
		const { fetchImpl, calls } = scriptedFetch([delta('answer'), DONE]);
		const chat = await readySession(fetchImpl);
		const first = await chat.createConversation({ providerId: LOCAL_ID, title: 'A' });
		const second = await chat.createConversation({ providerId: LOCAL_ID, title: 'B' });

		const send = async (conversationId: string, text: string): Promise<void> => {
			const log = new EventLog();
			await chat.sendMessage(
				{
					providerId: LOCAL_ID,
					conversationId,
					model: 'llama3',
					messages: [{ role: 'user', content: text }],
				},
				log.sink,
			);
			await log.wait();
		};

		await send(first.summary.id, 'in A');
		await send(second.summary.id, 'in B');
		// A second turn in A must not see B.
		await send(first.summary.id, 'still A');

		const bodies = calls
			.filter((call) => call.body !== undefined)
			.map((call) => call.body as string);
		const third = JSON.parse(bodies[2]) as { messages: { content: string }[] };
		assert.deepStrictEqual(third.messages.map((message) => message.content), [
			SESHYINA_AGENT_IDENTITY,
			'in A',
			'answer',
			'still A',
		]);

		const openedB = await chat.openConversation(second.summary.id);
		assert.deepStrictEqual(openedB.messages.map((message) => message.content), [
			'in B',
			'answer',
		]);
	});

	test('conversations and prompts survive recreating the session', async () => {
		const { fetchImpl } = scriptedFetch([delta('kept'), DONE]);
		const first = await readySession(fetchImpl);
		const conversation = await first.createConversation({
			providerId: LOCAL_ID,
			title: 'Persisted',
			systemPrompt: 'stay sharp',
		});
		await first.renameConversation(conversation.summary.id, 'Renamed after restart');

		const log = new EventLog();
		await first.sendMessage(
			{
				providerId: LOCAL_ID,
				conversationId: conversation.summary.id,
				model: 'llama3',
				messages: [{ role: 'user', content: 'remembered' }],
			},
			log.sink,
		);
		await log.wait();

		// Second process: same files, fresh objects.
		const second = session();
		const listed = await second.listConversations();
		assert.strictEqual(listed.length, 1);
		assert.strictEqual(listed[0].title, 'Renamed after restart');

		const opened = await second.openConversation(conversation.summary.id);
		assert.strictEqual(opened.systemPrompt, 'stay sharp');
		assert.deepStrictEqual(opened.messages, [
			{ role: 'system', content: 'stay sharp' },
			{ role: 'user', content: 'remembered' },
			{ role: 'assistant', content: 'kept' },
		]);
	});

	// ── corrupted state ──────────────────────────────────────────────────────

	test('a corrupt state file degrades to no providers rather than failing to start', async () => {
		await writeFile(join(root, 'state.json'), 'not json', 'utf8');
		const chat = session();

		assert.deepStrictEqual(chat.listProviders(), []);
		// And the session is still usable.
		await chat.saveProvider({ baseUrl: LOCAL_URL });
		assert.strictEqual(chat.listProviders().length, 1);
	});
});

suite('Desktop: provider summary shape', () => {
	test('a summary without a valid status is refused', () => {
		assert.throws(
			() =>
				parseProviderSummary({
					id: 'p',
					name: 'P',
					baseUrl: 'http://x/v1',
					status: 'invented',
					hasApiKeyRef: false,
					models: [],
				}),
			/unknown provider status/,
		);
	});

	test('hasApiKeyRef must be a boolean, not a truthy value', () => {
		assert.throws(
			() =>
				parseProviderSummary({
					id: 'p',
					name: 'P',
					baseUrl: 'http://x/v1',
					status: 'configured',
					hasApiKeyRef: 'yes',
					models: [],
				}),
			/hasApiKeyRef must be a boolean/,
		);
	});

	test('a complete summary parses and copies its models', () => {
		const source = { models: ['a', 'b'] };
		const summary = parseProviderSummary({
			id: 'p',
			name: 'P',
			baseUrl: 'http://x/v1',
			status: 'available',
			hasApiKeyRef: true,
			models: source.models,
		});

		source.models.push('mutated');
		assert.deepStrictEqual(summary.models, ['a', 'b']);
	});
});

suite('Desktop: model catalog through the session', () => {
	let root: string;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-catalog-chat-'));
	});

	teardown(async () => {
		await removeFixtureTree(root);
	});

	function session(): ChatSession {
		return new ChatSession({
			config: new ProviderConfigService(new FileStateStore({ filePath: join(root, 'state.json') })),
			secrets: new FileSecretStore({ filePath: join(root, 'secrets.json') }),
			history: new FileDataStore({ rootPath: join(root, 'data') }),
			logger: new LoggingService(
				new ConsoleLogSink({ out: () => undefined, err: () => undefined }),
			),
		});
	}

	test('a described model comes back as a form the window can fill in', async () => {
		const chat = session();
		const saved = await chat.saveModelCatalogEntry({
			providerId: 'atria',
			modelId: 'model-a',
			capabilities: 'code, translation',
			pricing: { currency: 'USD', unit: 'per_1m_tokens', input: '3', output: '15' },
			access: 'paid',
			limits: { contextTokens: '200000' },
			notes: 'fast enough for most work',
		});

		assert.strictEqual(saved.providerId, 'atria');
		// The list the form stores becomes the one field the form shows.
		assert.strictEqual(saved.capabilities, 'code, translation');
		assert.deepStrictEqual(saved.pricing, {
			currency: 'USD',
			unit: 'per_1m_tokens',
			input: '3',
			output: '15',
		});
		assert.strictEqual(saved.access, 'paid');
		assert.deepStrictEqual(saved.limits, { contextTokens: '200000' });
		assert.strictEqual(saved.notes, 'fast enough for most work');
		assert.strictEqual(saved.observations, 0);
	});

	test('a blank capability field is stored as an empty list, not as no answer', async () => {
		const chat = session();
		const saved = await chat.saveModelCatalogEntry({
			providerId: 'p',
			modelId: 'm',
			// The user filled the box in with nothing. That is them saying the model
			// is good for nothing they listed, which is not the same as never having
			// opened the form.
			capabilities: '   ',
		});

		assert.strictEqual(saved.capabilities, '');
		const reopened = await session().getModelCatalogEntry({ providerId: 'p', modelId: 'm' });
		assert.strictEqual(reopened?.capabilities, '');
	});

	test('a blank price box is stored as unknown, never as a free price', async () => {
		const chat = session();
		await chat.saveModelCatalogEntry({
			providerId: 'p',
			modelId: 'm',
			pricing: { currency: 'USD', unit: 'per_1m_tokens' },
		});
		const cleared = await chat.saveModelCatalogEntry({ providerId: 'p', modelId: 'm' });

		// A price with a currency but no numbers is still a declared price, with
		// both halves unknown. The Core's rule about a zero surviving is what makes
		// blank and free different all the way down.
		assert.deepStrictEqual(cleared.pricing, { currency: 'USD', unit: 'per_1m_tokens' });
		assert.strictEqual(cleared.pricing?.input, undefined);
		assert.strictEqual(cleared.pricing?.output, undefined);
	});

	test('a price with no currency at all is put back to unknown', async () => {
		const chat = session();
		await chat.saveModelCatalogEntry({
			providerId: 'p',
			modelId: 'm',
			pricing: { currency: 'USD', unit: 'per_1k_tokens', input: '1' },
		});

		const cleared = await chat.saveModelCatalogEntry({
			providerId: 'p',
			modelId: 'm',
			// Half a price with no currency is not a price. Saving it would leave a
			// number on screen that cannot be costed.
			pricing: { currency: '', unit: 'per_1k_tokens', input: '1' },
		});
		assert.strictEqual(cleared.pricing, undefined);
	});

	test('a real zero price survives the trip to the form and back', async () => {
		const chat = session();
		const saved = await chat.saveModelCatalogEntry({
			providerId: 'p',
			modelId: 'm',
			access: 'free',
			pricing: { currency: 'USD', unit: 'per_1m_tokens', input: '0', output: '0' },
		});

		assert.strictEqual(saved.pricing?.input, '0');
		assert.strictEqual(saved.pricing?.output, '0');
		// Not folded away by the blank check: a zero is a value, not an absence.
		assert.deepStrictEqual(saved.pricing, {
			currency: 'USD',
			unit: 'per_1m_tokens',
			input: '0',
			output: '0',
		});
	});

	test('half-typed input is dropped rather than failing the save', async () => {
		const chat = session();
		// A field mid-edit must not throw on every keystroke, and the half of a
		// number that is not one yet must not be stored as a price. `"1."` is the
		// exception and is left out: that is unambiguously 1, not a half.
		for (const input of ['-', '1e', 'abc', '.', '1,5']) {
			const saved = await chat.saveModelCatalogEntry({
				providerId: 'p',
				modelId: 'm',
				pricing: { currency: 'USD', unit: 'per_1k_tokens', input },
			});
			assert.deepStrictEqual(
				saved.pricing,
				{ currency: 'USD', unit: 'per_1k_tokens' },
				`expected "${input}" to be dropped`,
			);
		}
	});

	test('a decimal point the user already typed is a number, not a half', async () => {
		const chat = session();
		const saved = await chat.saveModelCatalogEntry({
			providerId: 'p',
			modelId: 'm',
			pricing: { currency: 'USD', unit: 'per_1k_tokens', input: '1.' },
		});
		assert.strictEqual(saved.pricing?.input, '1');
	});

	test('the median of an even number of readings is the mean of the middle two', async () => {
		const chat = session();
		for (const totalMs of [1000, 2000, 3000, 4000]) {
			await chat.recordModelObservation({ providerId: 'p', modelId: 'm' }, { totalMs });
		}

		const entry = await chat.getModelCatalogEntry({ providerId: 'p', modelId: 'm' });
		// 2000 and 3000 are the middle; the mean is 2500.
		assert.strictEqual(entry?.medianTotalMs, 2500);
		assert.strictEqual(entry?.observations, 4);
	});

	test('an odd number of readings takes the middle one exactly', async () => {
		const chat = session();
		for (const totalMs of [1000, 2000, 99_000]) {
			await chat.recordModelObservation({ providerId: 'p', modelId: 'm' }, { totalMs });
		}

		const entry = await chat.getModelCatalogEntry({ providerId: 'p', modelId: 'm' });
		assert.strictEqual(entry?.medianTotalMs, 2000);
	});

	test('a median of zero is reported as zero, not as missing', async () => {
		const chat = session();
		await chat.recordModelObservation({ providerId: 'p', modelId: 'm' }, { totalMs: 0 });

		const entry = await chat.getModelCatalogEntry({ providerId: 'p', modelId: 'm' });
		assert.strictEqual(entry?.medianTotalMs, 0);
	});

	test('runs with no timing do not drag the median down to zero', async () => {
		const chat = session();
		// Three fast runs and one that reported nothing at all, as an aborted
		// request would. Counting the fourth as zero would halve the median and
		// make a quick model look slow.
		for (const totalMs of [100, 110, 120]) {
			await chat.recordModelObservation({ providerId: 'p', modelId: 'm' }, { totalMs });
		}
		await chat.recordModelObservation({ providerId: 'p', modelId: 'm' }, {});

		const entry = await chat.getModelCatalogEntry({ providerId: 'p', modelId: 'm' });
		// All four are counted as runs…
		assert.strictEqual(entry?.observations, 4);
		// …but only the three that reported are averaged.
		assert.strictEqual(entry?.medianTotalMs, 110);
	});

	test('a model with no runs reports no median rather than a zero', async () => {
		const chat = session();
		await chat.saveModelCatalogEntry({ providerId: 'p', modelId: 'm', access: 'paid' });

		const entry = await chat.getModelCatalogEntry({ providerId: 'p', modelId: 'm' });
		assert.strictEqual(entry?.observations, 0);
		assert.strictEqual(entry?.medianTotalMs, undefined);
		assert.strictEqual(entry?.medianFirstByteMs, undefined);
	});

	test('first byte and total are medians of their own readings', async () => {
		const chat = session();
		await chat.recordModelObservation(
			{ providerId: 'p', modelId: 'm' },
			{ firstByteMs: 100, totalMs: 1000 },
		);
		await chat.recordModelObservation(
			{ providerId: 'p', modelId: 'm' },
			{ firstByteMs: 300, totalMs: 3000 },
		);

		const entry = await chat.getModelCatalogEntry({ providerId: 'p', modelId: 'm' });
		assert.strictEqual(entry?.medianFirstByteMs, 200);
		assert.strictEqual(entry?.medianTotalMs, 2000);
	});

	test('the catalog is keyed by the pair, so two providers keep separate prices', async () => {
		const chat = session();
		await chat.saveModelCatalogEntry({
			providerId: 'atria',
			modelId: 'gpt-4o',
			pricing: { currency: 'USD', unit: 'per_1m_tokens', input: '5' },
		});
		await chat.saveModelCatalogEntry({
			providerId: 'opencode',
			modelId: 'gpt-4o',
			pricing: { currency: 'USD', unit: 'per_1m_tokens', input: '0' },
		});

		const listed = await chat.listModelCatalog();
		assert.strictEqual(listed.length, 2);
		assert.deepStrictEqual(await chat.listModelCatalog('atria'), [
			(await chat.getModelCatalogEntry({ providerId: 'atria', modelId: 'gpt-4o' })) as never,
		]);
		assert.strictEqual(
			(await chat.getModelCatalogEntry({ providerId: 'opencode', modelId: 'gpt-4o' }))?.pricing?.input,
			'0',
		);
	});

	test('an empty provider filter means every provider', async () => {
		const chat = session();
		await chat.saveModelCatalogEntry({ providerId: 'a', modelId: 'm' });
		await chat.saveModelCatalogEntry({ providerId: 'b', modelId: 'm' });

		// The IPC handler passes undefined for a blank string, and the session
		// treats it as no filter rather than as a provider called "".
		assert.strictEqual((await chat.listModelCatalog('')).length, 2);
		assert.strictEqual((await chat.listModelCatalog(undefined)).length, 2);
	});

	test('forgetting a model leaves the provider configured and its key stored', async () => {
		const chat = session();
		await chat.saveProvider({ baseUrl: LOCAL_URL, apiKey: KEY });
		await chat.saveModelCatalogEntry({ providerId: LOCAL_ID, modelId: 'm', access: 'paid' });

		assert.strictEqual(
			await chat.removeModelCatalogEntry({ providerId: LOCAL_ID, modelId: 'm' }),
			true,
		);

		// The connection is untouched: a forgotten price must not un-configure
		// the model the user is still talking to.
		assert.deepStrictEqual(
			(await chat.listProviders()).map((provider) => provider.id),
			[LOCAL_ID],
		);
		const secrets = new FileSecretStore({ filePath: join(root, 'secrets.json') });
		assert.strictEqual(await secrets.get(providerApiKeyRef(LOCAL_ID)), KEY);
	});

	test('a record survives a new session over the same files', async () => {
		await session().saveModelCatalogEntry({
			providerId: 'p',
			modelId: 'm',
			capabilities: 'code',
			pricing: { currency: 'USD', unit: 'per_1k_tokens', input: '1.5' },
			access: 'paid',
		});

		const reopened = await session().listModelCatalog();
		assert.strictEqual(reopened.length, 1);
		assert.strictEqual(reopened[0].capabilities, 'code');
		assert.strictEqual(reopened[0].pricing?.input, '1.5');
		assert.strictEqual(reopened[0].access, 'paid');
	});

	test('nothing in the catalog is used to choose a model', async () => {
		// This stage must not touch model selection. The proof is that the model
		// list is still exactly what the providers report, with a record present
		// that claims something quite different.
		const chat = session();
		await chat.saveProvider({ baseUrl: LOCAL_URL });
		await chat.saveModelCatalogEntry({
			providerId: LOCAL_ID,
			modelId: 'never-recommend-me',
			access: 'paid',
			capabilities: 'nothing useful',
		});

		const available = await chat.listAvailableModels();
		assert.ok(available.every((entry) => entry.model !== 'never-recommend-me'));
	});
});

suite('Desktop: default provider seed', () => {
	let root: string;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-seed-'));
	});

	teardown(async () => {
		await removeFixtureTree(root);
	});

	function session(): ChatSession {
		return new ChatSession({
			config: new ProviderConfigService(new FileStateStore({ filePath: join(root, 'state.json') })),
			secrets: new FileSecretStore({ filePath: join(root, 'secrets.json') }),
			history: new FileDataStore({ rootPath: join(root, 'data') }),
			logger: new LoggingService(
				new ConsoleLogSink({ out: () => undefined, err: () => undefined }),
			),
		});
	}

	test('a fresh session starts with no providers (R4S: nothing is seeded)', async () => {
		const chat = session();
		assert.strictEqual(chat.listProviders().length, 0);

		await chat.seedDefaultProviders();

		// O `9router` deixou de ser semeado: uma instalação nova não ganha um
		// provedor que não responde.
		assert.strictEqual(chat.listProviders().length, 0);
	});

	test('a provider the user configured is never touched by the seed step', async () => {
		const chat = session();
		await chat.saveProvider({
			id: 'meu-proxy',
			name: 'Meu proxy',
			baseUrl: 'https://my-proxy.example/v1',
			apiKey: 'k',
		});

		await chat.seedDefaultProviders();

		const stored = chat.listProviders().find((provider) => provider.id === 'meu-proxy');
		assert.strictEqual(stored?.baseUrl, 'https://my-proxy.example/v1');
		assert.strictEqual(stored?.name, 'Meu proxy');
		assert.strictEqual(stored?.hasApiKeyRef, true);
	});

	test('a provider kept from an older install survives the seed step', async () => {
		// Instalação anterior: o `9router` existe e tem URL editada pelo
		// usuário. A R4S não o semeia nem o remove — ele continua como está.
		const chat = session();
		await chat.saveProvider({
			id: '9router',
			name: 'My 9Router',
			baseUrl: 'https://my-proxy.example/v1',
			apiKey: 'k',
		});

		await chat.seedDefaultProviders();

		const stored = chat.listProviders().find((provider) => provider.id === '9router');
		assert.strictEqual(stored?.baseUrl, 'https://my-proxy.example/v1');
		assert.strictEqual(stored?.name, 'My 9Router');
	});

	test('removing the last provider leaves none, and the seed step does not bring one back', async () => {
		const chat = session();
		await chat.saveProvider({
			id: '9router',
			name: '9Router',
			baseUrl: 'http://localhost:20128/v1',
		});
		assert.strictEqual(chat.listProviders().length, 1);

		await chat.removeProvider('9router');
		assert.strictEqual(chat.listProviders().length, 0);

		await chat.seedDefaultProviders();

		assert.strictEqual(chat.listProviders().length, 0);
	});
});
