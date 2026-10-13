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
import { parseProviderSummary, type SendMessageInput } from '../desktop/contract';

const KEY = 'sk-test-DO-NOT-PERSIST-9c1e2b';
const LOCAL_URL = 'http://127.0.0.1:11434/v1';
const LOCAL_ID = '127.0.0.1-11434-v1';

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

/** Collects stream events and lets a test await the turn's terminal event. */
class EventLog {
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
		await rm(root, { recursive: true, force: true });
	});

	/** A session over fresh temp files. Everything is real except `fetch`. */
	function session(
		fetchImpl?: FetchLike,
		options: { readonly turnTimeoutMs?: number } = {},
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
		assert.strictEqual(log.terminal.type, 'done');
		assert.strictEqual(log.terminal.type === 'done' ? log.terminal.reason : '', 'aborted');
		assert.strictEqual(chat.isBusy, false, 'the session is not stuck after the timeout');
		assert.strictEqual(chat.openPermissionCount, 0, 'no dialog outlives its turn');
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

	test('a conversation cannot be answered through a different provider', async () => {
		const { fetchImpl } = scriptedFetch([delta('never sent'), DONE]);
		const chat = await readySession(fetchImpl);
		const input = await sendInput(chat);
		const log = new EventLog();

		await assert.rejects(
			() => chat.sendMessage({ ...input, providerId: 'another-endpoint' }, log.sink),
			/belongs to provider/,
		);

		assert.strictEqual(chat.isBusy, false, 'the refused send must not reserve a turn');
		assert.deepStrictEqual(log.events, [], 'and no event may arrive for it');
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
		assert.deepStrictEqual(firstBody.messages.map((message) => message.content), ['one']);

		const secondBody = JSON.parse(bodies[1]) as { messages: { content: string }[] };
		assert.deepStrictEqual(secondBody.messages.map((message) => message.content), [
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

		const listed = await second.listConversations(LOCAL_ID);
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
		const listed = await chat.listConversations(LOCAL_ID);
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
		assert.deepStrictEqual(await chat.listConversations('ghost'), []);
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

		assert.strictEqual(await chat.deleteConversation(second.summary.id), true);
		assert.strictEqual(await chat.deleteConversation(second.summary.id), false);
		assert.deepStrictEqual(
			(await chat.listConversations(LOCAL_ID)).map((item) => item.id),
			[first.summary.id],
		);
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

		const listed = await chat.listConversations(LOCAL_ID);
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
		assert.deepStrictEqual(body.messages, [
			{ role: 'system', content: 'you are a terse assistant' },
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
		// The prompt leads, then the whole prior conversation, then the new turn.
		assert.deepStrictEqual(secondBody.messages.map((message) => message.role), [
			'system',
			'user',
			'assistant',
			'user',
		]);
		assert.strictEqual(secondBody.messages[0].content, 'added later');
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

		const body = JSON.parse(calls[0].body ?? '{}') as { messages: { role: string }[] };
		assert.deepStrictEqual(body.messages.map((message) => message.role), ['user']);
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

		const body = JSON.parse(calls[0].body ?? '{}') as { messages: { role: string }[] };
		assert.deepStrictEqual(body.messages.map((message) => message.role), ['user']);
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
		const listed = await second.listConversations(LOCAL_ID);
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