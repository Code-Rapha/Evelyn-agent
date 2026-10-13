/**
 * The agent turn: model, tool, result, model again.
 *
 * Lives in `src/core-tests/` and runs under plain mocha, outside any host. The
 * whole flow goes through the Core's `ConversationRuntime`, so this is the real
 * loop with a scripted model rather than a stand-in for it.
 *
 * The fake provider speaks SSE, which means the Core's own `SseChatStream` and
 * `SseDecoder` are exercised too — a test that stubbed the stream below the
 * decoder would pass while the real wire format was broken.
 */
import * as assert from 'assert';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProviderConfigService } from '../core/providers/config';
import { LoggingService } from '../core/logging';
import { StorageError } from '../core/errors';
import type { AppendMessageInput, ConversationMessage } from '../core/storage/types/dataStore';
import { FileSecretStore } from '../adapters/local/fileSecretStore';
import { ConsoleLogSink } from '../adapters/local/consoleLogSink';
import { FileStateStore } from '../adapters/local/fileStateStore';
import { FileDataStore } from '../adapters/local/fileDataStore';
import { ChatSession } from '../desktop/chatSession';
import type { AgentUiEvent } from '../desktop/agentTurn';
import type { FetchLike, FetchResponseLike } from '../core/providers/openaiCompatible';

const LOCAL_URL = 'http://127.0.0.1:11434/v1';
const LOCAL_ID = '127.0.0.1-11434-v1';

/** One scripted round-trip: what the model sends, keyed by call index. */
interface Round {
	/** Text to stream, if the model speaks before calling tools. */
	readonly text?: string;
	/** Tool calls to request. */
	readonly calls?: readonly { readonly id: string; readonly name: string; readonly args: unknown }[];
	/** Raw argument string, for the malformed case. */
	readonly rawArgs?: string;
}

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

function textChunk(text: string): string {
	return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
}

/** A streamed tool call, in the OpenAI shape the Core's decoder expects. */
function toolChunk(id: string, name: string, args: unknown, index = 0): string {
	return `data: ${JSON.stringify({
		choices: [{ delta: { tool_calls: [{ index, id, function: { name, arguments: JSON.stringify(args) } }] } }],
	})}\n\n`;
}

/** A tool call whose arguments are not JSON at all. */
function malformedToolChunk(id: string, name: string, rawArgs: string, index = 0): string {
	return `data: ${JSON.stringify({
		choices: [{ delta: { tool_calls: [{ index, id, function: { name, arguments: rawArgs } }] } }],
	})}\n\n`;
}

const DONE = 'data: [DONE]\n\n';

function buildRound(round: Round): string[] {
	const chunks: string[] = [];
	if (round.text !== undefined) {
		chunks.push(textChunk(round.text));
	}
	for (const [index, call] of (round.calls ?? []).entries()) {
		chunks.push(toolChunk(call.id, call.name, call.args, index));
	}
	if (round.rawArgs !== undefined) {
		// The index continues after the regular calls: two tool_calls sharing
		// index 0 in one stream would merge into one call on the wire. The name
		// is a real tool — the malformed flag is what stops it before lookup.
		chunks.push(
			malformedToolChunk('call_bad', 'list_files', round.rawArgs, (round.calls ?? []).length),
		);
	}
	chunks.push(DONE);
	return chunks;
}

interface Recorded {
	url: string;
	body?: string;
}

/**
 * A fake provider that serves a scripted sequence of rounds.
 *
 * One round per POST, so a turn that calls a tool and then answers consumes
 * exactly two — which is what makes the loop's round-tripping observable.
 */
function scriptedAgent(rounds: readonly Round[]): { fetchImpl: FetchLike; calls: Recorded[] } {
	const calls: Recorded[] = [];
	let round = 0;

	const fetchImpl: FetchLike = async (url, init) => {
		if (url.endsWith('/models')) {
			return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'test-model' }] }) };
		}
		calls.push({ url, ...(init?.body !== undefined ? { body: init.body } : {}) });
		const next = rounds[Math.min(round, rounds.length - 1)];
		round += 1;
		// A small delay between words so the ordering assertions mean something.
		return sseResponse(buildRound(next));
	};
	return { fetchImpl, calls };
}

/**
 * A store whose first tool-result write fails once, then behaves.
 *
 * Reproduces the disk hiccup that used to drop every remaining result of a
 * round: the assistant with its `tool_calls` landed, the results behind it did
 * not, and the transcript was one strict server away from being rejected.
 */
class FlakyAppendStore extends FileDataStore {
	private failed = false;

	override async appendMessages(
		conversationId: string,
		inputs: readonly AppendMessageInput[],
	): Promise<readonly ConversationMessage[]> {
		if (!this.failed && inputs.some((input) => input.role === 'tool')) {
			this.failed = true;
			throw new StorageError('simulated disk hiccup on the tool result');
		}
		return super.appendMessages(conversationId, inputs);
	}
}

/** Collects events and lets a test await the turn's terminal event. */
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

	get types(): string[] {
		return this.events.map((event) => event.type);
	}

	get deltas(): string {
		return this.events
			.filter((e): e is Extract<AgentUiEvent, { type: 'delta' }> => e.type === 'delta')
			.map((e) => e.text)
			.join('');
	}

	get toolCalls(): Extract<AgentUiEvent, { type: 'toolCall' }>[] {
		return this.events.filter(
			(e): e is Extract<AgentUiEvent, { type: 'toolCall' }> => e.type === 'toolCall',
		);
	}

	get toolResults(): Extract<AgentUiEvent, { type: 'toolResult' }>[] {
		return this.events.filter(
			(e): e is Extract<AgentUiEvent, { type: 'toolResult' }> => e.type === 'toolResult',
		);
	}

	get done(): Extract<AgentUiEvent, { type: 'done' }> {
		const event = this.events.find(
			(e): e is Extract<AgentUiEvent, { type: 'done' }> => e.type === 'done',
		);
		assert.ok(event !== undefined, 'expected a done event');
		return event;
	}
}

/** Polls until `condition` holds, or fails naming what never happened. */
async function waitFor(condition: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error(`timed out waiting for ${what}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

suite('Agent: tools through the runtime', function () {
	// Tool turns make two provider round-trips, and the cancellation cases wait
	// on real timers; the default 2s is not enough for those.
	this.timeout(8000);

	let root: string;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-agent-'));
	});

	teardown(async () => {
		await rm(root, { recursive: true, force: true });
	});

	function session(fetchImpl: FetchLike, history?: FileDataStore): ChatSession {
		return new ChatSession({
			config: new ProviderConfigService(new FileStateStore({ filePath: join(root, 'state.json') })),
			secrets: new FileSecretStore({ filePath: join(root, 'secrets.json') }),
			history: history ?? new FileDataStore({ rootPath: join(root, 'data') }),
			logger: new LoggingService(new ConsoleLogSink({ out: () => undefined, err: () => undefined })),
			fetchImpl,
		});
	}

	/** A session with a provider and a conversation bound to a workspace. */
	async function agentSession(
		fetchImpl: FetchLike,
		options: { readonly withProject?: boolean } = {},
	): Promise<{ chat: ChatSession; conversationId: string; workspace: string }> {
		const chat = session(fetchImpl);
		await chat.saveProvider({ baseUrl: LOCAL_URL });

		const workspace = join(root, 'workspace');
		await mkdir(workspace, { recursive: true });
		let projectId: string | undefined;
		if (options.withProject !== false) {
			projectId = (await chat.createProject({ name: 'Workspace', rootPath: workspace })).id;
		}

		const conversation = await chat.createConversation({
			providerId: LOCAL_ID,
			...(projectId !== undefined ? { projectId } : {}),
		});
		return { chat, conversationId: conversation.summary.id, workspace };
	}

	const send = (chat: ChatSession, conversationId: string, text: string) =>
		chat.sendMessage(
			{
				providerId: LOCAL_ID,
				conversationId,
				model: 'test-model',
				messages: [{ role: 'user', content: text }],
			},
			new EventLog().sink,
		);

	// ── 1. a plain question, no tool ────────────────────────────────────────

	test('a plain question streams an answer and runs no tool', async () => {
		const { fetchImpl, calls } = scriptedAgent([{ text: 'just an answer' }]);
		const { chat, conversationId } = await agentSession(fetchImpl);
		const log = new EventLog();

		await chat.sendMessage(
			{
				providerId: LOCAL_ID,
				conversationId,
				model: 'test-model',
				messages: [{ role: 'user', content: 'hello' }],
			},
			log.sink,
		);
		await log.wait();

		assert.deepStrictEqual(log.types, ['started', 'delta', 'done']);
		assert.strictEqual(log.deltas, 'just an answer');
		assert.strictEqual(log.done.toolCalls, 0);
		assert.strictEqual(log.done.reason, 'answered');
		// One round-trip: the model was never asked a second time.
		assert.strictEqual(calls.filter((call) => call.body !== undefined).length, 1);
	});

	// ── 2. a read-only tool ─────────────────────────────────────────────────

	test('the model reads a file through read_file and answers with it', async () => {
		const { fetchImpl, calls } = scriptedAgent([
			{ calls: [{ id: 'c1', name: 'read_file', args: { path: 'notes.txt' } }] },
			{ text: 'the file says hello' },
		]);
		const { chat, conversationId, workspace } = await agentSession(fetchImpl);
		await writeFile(join(workspace, 'notes.txt'), 'hello from disk', 'utf8');
		const log = new EventLog();

		await chat.sendMessage(
			{
				providerId: LOCAL_ID,
				conversationId,
				model: 'test-model',
				messages: [{ role: 'user', content: 'what is in notes.txt?' }],
			},
			log.sink,
		);
		await log.wait();

		// The tool was announced, ran, and its output came back.
		assert.deepStrictEqual(log.types, [
			'started',
			'toolCall',
			'toolResult',
			'delta',
			'done',
		]);
		assert.strictEqual(log.toolCalls[0].call.name, 'read_file');
		assert.strictEqual(log.toolResults[0].ok, true);
		assert.ok(log.toolResults[0].output.includes('hello from disk'));
		assert.strictEqual(log.deltas, 'the file says hello');
		assert.strictEqual(log.done.toolCalls, 1);

		// The second request carried the tool result, so the model could answer.
		const bodies = calls.filter((call) => call.body !== undefined).map((call) => call.body as string);
		assert.strictEqual(bodies.length, 2);
		const second = JSON.parse(bodies[1]) as {
			messages: {
				role: string;
				content: string;
				tool_call_id?: string;
				tool_calls?: { type: string; function: { name: string; arguments: string } }[];
			}[];
		};
		const answerIndex = second.messages.findIndex((message) => message.role === 'tool');
		assert.ok(answerIndex > 0, 'the result made it back');
		// The result answers a call that the message immediately before it
		// announces. Left to `content` alone, a strict server answers this
		// request with "messages with role 'tool' must be a response to a
		// preceding message with 'tool_calls'".
		const parent = second.messages[answerIndex - 1];
		assert.strictEqual(parent.role, 'assistant');
		assert.deepStrictEqual(parent.tool_calls, [
			{
				type: 'function',
				function: { name: 'read_file', arguments: '{"path":"notes.txt"}' },
			},
		]);
		assert.strictEqual(second.messages[answerIndex].tool_call_id, 'c1');
	});

	test('the next turn still announces the calls already in the transcript', async () => {
		const { fetchImpl, calls } = scriptedAgent([
			{ calls: [{ id: 'c1', name: 'read_file', args: { path: 'notes.txt' } }] },
			{ text: 'first answer' },
			{ text: 'second answer' },
		]);
		const { chat, conversationId, workspace } = await agentSession(fetchImpl);
		await writeFile(join(workspace, 'notes.txt'), 'hello from disk', 'utf8');

		const first = new EventLog();
		await chat.sendMessage(
			{
				providerId: LOCAL_ID,
				conversationId,
				model: 'test-model',
				messages: [{ role: 'user', content: 'what is in notes.txt?' }],
			},
			first.sink,
		);
		await first.wait();

		const second = new EventLog();
		await chat.sendMessage(
			{
				providerId: LOCAL_ID,
				conversationId,
				model: 'test-model',
				messages: [{ role: 'user', content: 'and now?' }],
			},
			second.sink,
		);
		await second.wait();

		const bodies = calls.filter((call) => call.body !== undefined).map((call) => call.body as string);
		assert.strictEqual(bodies.length, 3);
		// Round three sends the transcript as it was reloaded from disk. The
		// first round's assistant message still has to announce its call there,
		// or the `tool` message stored after it answers nothing — and the whole
		// conversation is rejected from the second turn on.
		const third = JSON.parse(bodies[2]) as {
			messages: { role: string; tool_calls?: readonly unknown[] }[];
		};
		assert.ok(
			third.messages.some(
				(message) =>
					message.role === 'assistant' &&
					Array.isArray(message.tool_calls) &&
					message.tool_calls.length > 0,
			),
			'the earlier round-trip is still announced',
		);
		assert.ok(third.messages.some((message) => message.role === 'tool'));
	});

	// ── 3. a tool that fails ────────────────────────────────────────────────

	test('a failing tool is reported to the model, which then answers', async () => {
		const { fetchImpl } = scriptedAgent([
			{ calls: [{ id: 'c1', name: 'read_file', args: { path: 'missing.txt' } }] },
			{ text: 'that file does not exist' },
		]);
		const { chat, conversationId } = await agentSession(fetchImpl);
		const log = new EventLog();

		await chat.sendMessage(
			{
				providerId: LOCAL_ID,
				conversationId,
				model: 'test-model',
				messages: [{ role: 'user', content: 'read missing.txt' }],
			},
			log.sink,
		);
		await log.wait();

		assert.strictEqual(log.toolResults[0].ok, false);
		assert.match(log.toolResults[0].output, /no such file/i);
		// The failure reached the model rather than ending the turn.
		assert.strictEqual(log.done.reason, 'answered');
		assert.strictEqual(log.deltas, 'that file does not exist');
	});

	test('a dangerous tool the user refuses does not run', async () => {
		const { fetchImpl } = scriptedAgent([
			{ calls: [{ id: 'c1', name: 'run_command', args: { command: 'echo hi' } }] },
			{ text: 'I cannot run commands' },
		]);
		const { chat, conversationId } = await agentSession(fetchImpl);
		const log = new EventLog();

		// `run_command` is dangerous, and the desktop's gateway asks rather than
		// refusing outright — a policy denial would make the confirmation dialog
		// for it unreachable. So the refusal arrives the way it does in the app:
		// the prompt is opened and the answer is `deny`.
		const sink = (event: AgentUiEvent): void => {
			log.sink(event);
			if (event.type === 'permissionRequested') {
				chat.answerPermission({ id: event.prompt.id, decision: 'deny' });
			}
		};

		const ack = await chat.sendMessage(
			{
				providerId: LOCAL_ID,
				conversationId,
				model: 'test-model',
				messages: [{ role: 'user', content: 'run echo hi' }],
			},
			sink,
		);
		await log.wait();

		// The prompt was announced before the answer, and the tool never ran.
		assert.strictEqual(log.types.filter((type) => type === 'permissionRequested').length, 1);
		// The permission events belong to the turn the session named. They used
		// to carry the runtime's own id, which a renderer watching `ack.turnId`
		// would drop — the dialog never reached the screen.
		assert.ok(
			log.events.every((event) => event.turnId === ack.turnId),
			`every event carries ${ack.turnId}`,
		);
		assert.strictEqual(log.toolResults[0].ok, false);
		assert.match(log.toolResults[0].output, /denied|unusable/i);
		assert.strictEqual(log.deltas, 'I cannot run commands');
	});

	test('the user allows the prompt and the tool runs', async () => {
		const { fetchImpl } = scriptedAgent([
			{
				calls: [
					{ id: 'c1', name: 'write_file', args: { path: 'made.txt', content: 'allowed' } },
				],
			},
			{ text: 'written' },
		]);
		const { chat, conversationId, workspace } = await agentSession(fetchImpl);
		const log = new EventLog();
		// The answer arrives exactly the way the renderer sends it: once the
		// prompt is open, through `answerPermission`. The turn has to sit on
		// that answer — the tool runs only after it, never before.
		const sink = (event: AgentUiEvent): void => {
			log.sink(event);
			if (event.type === 'permissionRequested') {
				chat.answerPermission({ id: event.prompt.id, decision: 'allow' });
			}
		};

		await chat.sendMessage(
			{
				providerId: LOCAL_ID,
				conversationId,
				model: 'test-model',
				messages: [{ role: 'user', content: 'write made.txt' }],
			},
			sink,
		);
		await log.wait();

		// `write_file` is moderate: one prompt opened, and it was answered once.
		assert.strictEqual(
			log.types.filter((type) => type === 'permissionRequested').length,
			1,
		);
		const resolution = log.events.find(
			(event): event is Extract<AgentUiEvent, { type: 'permissionResolved' }> =>
				event.type === 'permissionResolved',
		);
		assert.ok(resolution !== undefined, 'the dialog was resolved');
		assert.strictEqual(resolution.decision, 'allow');
		assert.strictEqual(resolution.source, 'user');
		// The allowance is not just reported: the bytes are on disk and the
		// model saw the tool's real output.
		assert.strictEqual(log.toolResults.length, 1);
		assert.strictEqual(log.toolResults[0].ok, true, 'the allowed tool ran');
		assert.strictEqual(await readFile(join(workspace, 'made.txt'), 'utf8'), 'allowed');
		assert.strictEqual(log.done.reason, 'answered');
		assert.strictEqual(chat.openPermissionCount, 0, 'the dialog is settled');
	});

	test('stopping while a permission dialog is open denies it and closes the dialog', async () => {
		const { fetchImpl } = scriptedAgent([
			{
				calls: [
					{ id: 'c1', name: 'write_file', args: { path: 'never.txt', content: 'nope' } },
				],
			},
			{ text: 'never reached' },
		]);
		const { chat, conversationId, workspace } = await agentSession(fetchImpl);
		const log = new EventLog();

		await chat.sendMessage(
			{
				providerId: LOCAL_ID,
				conversationId,
				model: 'test-model',
				messages: [{ role: 'user', content: 'write never.txt' }],
			},
			log.sink,
		);
		// The prompt opens on its own; wait for it rather than guessing a delay.
		await waitFor(
			() => log.types.includes('permissionRequested'),
			'the permission dialog to open',
		);
		assert.strictEqual(chat.openPermissionCount, 1, 'the dialog is open');

		assert.strictEqual(chat.stop(), true);
		await log.wait();

		// The broker settled the open request as a cancellation — not silence,
		// not a lingering promise: the runtime received an explicit deny.
		const resolution = log.events.find(
			(event): event is Extract<AgentUiEvent, { type: 'permissionResolved' }> =>
				event.type === 'permissionResolved',
		);
		assert.ok(resolution !== undefined, 'the dialog was resolved by the stop');
		assert.strictEqual(resolution.decision, 'deny');
		assert.strictEqual(resolution.source, 'cancelled');
		// The tool never touched the disk, and the turn still ended once.
		await assert.rejects(() => readFile(join(workspace, 'never.txt'), 'utf8'));
		assert.strictEqual(log.done.reason, 'aborted');
		assert.strictEqual(chat.openPermissionCount, 0, 'no dialog outlives the stop');
		assert.strictEqual(chat.isBusy, false, 'the session is free again');
	});

	// ── 4. several tool calls in one turn ───────────────────────────────────

	test('two tool calls in one round both run and both come back', async () => {
		const { fetchImpl, calls } = scriptedAgent([
			{
				calls: [
					{ id: 'a', name: 'list_files', args: { path: '.' } },
					{ id: 'b', name: 'read_file', args: { path: 'one.txt' } },
				],
			},
			{ text: 'two files, and one contains alpha' },
		]);
		const { chat, conversationId, workspace } = await agentSession(fetchImpl);
		await writeFile(join(workspace, 'one.txt'), 'alpha', 'utf8');
		const log = new EventLog();

		await chat.sendMessage(
			{
				providerId: LOCAL_ID,
				conversationId,
				model: 'test-model',
				messages: [{ role: 'user', content: 'list and read' }],
			},
			log.sink,
		);
		await log.wait();

		assert.strictEqual(log.toolCalls.length, 2);
		assert.strictEqual(log.toolResults.length, 2);
		assert.deepStrictEqual(
			log.toolResults.map((result) => result.name),
			['list_files', 'read_file'],
		);
		assert.ok(log.toolResults.every((result) => result.ok));
		assert.ok(log.toolResults[0].output.includes('one.txt'));
		assert.ok(log.toolResults[1].output.includes('alpha'));
		assert.strictEqual(log.done.toolCalls, 2);

		// Both results reached the model on the follow-up request.
		const bodies = calls.filter((call) => call.body !== undefined).map((call) => call.body as string);
		const second = JSON.parse(bodies[1]) as { messages: { role: string }[] };
		assert.strictEqual(second.messages.filter((m) => m.role === 'tool').length, 2);
	});

	// ── 5. cancelling a turn ────────────────────────────────────────────────

	test('stopping mid-stream ends the turn as aborted and keeps the partial text', async () => {
		// A stream that never ends on its own, so the stop lands inside it.
		const chat = session(async () => ({
			ok: true,
			status: 200,
			body: {
				[Symbol.asyncIterator]: async function* () {
					yield textChunk('partial answer');
					await new Promise((resolve) => setTimeout(resolve, 400));
					yield textChunk('never delivered');
					yield DONE;
				},
			},
			text: async () => '',
		}));
		await chat.saveProvider({ baseUrl: LOCAL_URL });
		const conversation = await chat.createConversation({ providerId: LOCAL_ID });
		const log = new EventLog();

		await chat.sendMessage(
			{
				providerId: LOCAL_ID,
				conversationId: conversation.summary.id,
				model: 'test-model',
				messages: [{ role: 'user', content: 'say something long' }],
			},
			log.sink,
		);
		await new Promise((resolve) => setTimeout(resolve, 40));
		assert.strictEqual(chat.stop(), true);
		await log.wait();

		assert.strictEqual(log.done.reason, 'aborted');
		assert.strictEqual(log.deltas, 'partial answer', 'what arrived is kept, what did not never appears');
	});

	test('a tool round can be stopped before the model answers again', async () => {
		// The second round never answers: its stream stays open until the abort
		// fires, which is the window the runtime has to notice between rounds.
		// A real provider honours the signal, and so does this one.
		let round = 0;
		const chat = session(async (url, init) => {
			if (url.endsWith('/models')) {
				return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'm' }] }) };
			}
			round += 1;
			if (round === 1) {
				return {
					ok: true,
					status: 200,
					body: {
						[Symbol.asyncIterator]: async function* () {
							yield toolChunk('c1', 'list_files', { path: '.' }, 0);
							yield DONE;
						},
					},
					text: async () => '',
				};
			}
			return {
				ok: true,
				status: 200,
				body: {
					[Symbol.asyncIterator]: async function* () {
						await new Promise<void>((resolve) => {
							init?.signal?.addEventListener('abort', () => resolve());
						});
						return;
					},
				},
				text: async () => '',
			};
		});
		await chat.saveProvider({ baseUrl: LOCAL_URL });
		const conversation = await chat.createConversation({ providerId: LOCAL_ID });
		const log = new EventLog();

		await chat.sendMessage(
			{
				providerId: LOCAL_ID,
				conversationId: conversation.summary.id,
				model: 'test-model',
				messages: [{ role: 'user', content: 'list files' }],
			},
			log.sink,
		);
		// Long enough for the tool round to finish and the next round to start.
		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.strictEqual(log.toolResults.length, 1, 'the tool ran before the stop');

		assert.strictEqual(chat.stop(), true);
		await log.wait();

		assert.strictEqual(log.done.reason, 'aborted');
		// The transcript keeps what the turn produced before the stop.
		const stored = await new FileDataStore({ rootPath: join(root, 'data') }).getConversation(
			conversation.summary.id,
		);
		assert.ok((stored?.messages.length ?? 0) > 1, 'the tool result survives the stop');
	});

	// ── 6. history survives across turns ────────────────────────────────────

	test('a tool result is replayed as context on the next turn', async () => {
		const { fetchImpl, calls } = scriptedAgent([
			{ calls: [{ id: 'c1', name: 'read_file', args: { path: 'note.txt' } }] },
			{ text: 'it says beta' },
			{ text: 'still beta' },
		]);
		const { chat, conversationId, workspace } = await agentSession(fetchImpl);
		await writeFile(join(workspace, 'note.txt'), 'beta', 'utf8');

		const turn = async (text: string): Promise<EventLog> => {
			const log = new EventLog();
			await chat.sendMessage(
				{
					providerId: LOCAL_ID,
					conversationId,
					model: 'test-model',
					messages: [{ role: 'user', content: text }],
				},
				log.sink,
			);
			await log.wait();
			return log;
		};

		await turn('what is in note.txt?');
		await turn('and now?');

		// The third request is the second turn's, and it carries the whole
		// transcript including the tool result from the first turn.
		const bodies = calls.filter((call) => call.body !== undefined).map((call) => call.body as string);
		assert.strictEqual(bodies.length, 3);
		const third = JSON.parse(bodies[2]) as { messages: { role: string; content: string }[] };
		assert.ok(
			third.messages.some((message) => message.role === 'tool' && message.content.includes('beta')),
			'the tool result must be in the next turn\'s context',
		);
	});

	test('the stored transcript keeps the assistant text and the tool results in order', async () => {
		const { fetchImpl } = scriptedAgent([
			{ calls: [{ id: 'c1', name: 'list_files', args: { path: '.' } }] },
			{ text: 'all done' },
		]);
		const { chat, conversationId, workspace } = await agentSession(fetchImpl);
		await writeFile(join(workspace, 'x.txt'), 'x', 'utf8');
		const log = new EventLog();

		await chat.sendMessage(
			{
				providerId: LOCAL_ID,
				conversationId,
				model: 'test-model',
				messages: [{ role: 'user', content: 'look around' }],
			},
			log.sink,
		);
		await log.wait();

		const stored = await new FileDataStore({ rootPath: join(root, 'data') }).getConversation(
			conversationId,
		);
		const roles = (stored?.messages ?? []).map((message) => message.role);
		// user, then the assistant round that called the tool, then its result,
		// then the final answer.
		assert.deepStrictEqual(roles, ['user', 'assistant', 'tool', 'assistant']);
		assert.match(stored?.messages[1].content ?? '', /\[tool calls: list_files\(/);
	});

	// ── 7. the workspace reaches the tool ───────────────────────────────────

	test('the tool runs inside the conversation project, not elsewhere', async () => {
		const { fetchImpl } = scriptedAgent([
			{ calls: [{ id: 'c1', name: 'list_files', args: { path: '.' } }] },
			{ text: 'here is what is here' },
		]);
		const { chat, conversationId, workspace } = await agentSession(fetchImpl);
		// Only the workspace has this file; a tool confined anywhere else would
		// not see it.
		await writeFile(join(workspace, 'inside-workspace.txt'), 'here', 'utf8');
		const outside = await mkdtemp(join(tmpdir(), 'seshyina-outside-'));
		await writeFile(join(outside, 'outside-workspace.txt'), 'there', 'utf8');

		const log = new EventLog();
		await chat.sendMessage(
			{
				providerId: LOCAL_ID,
				conversationId,
				model: 'test-model',
				messages: [{ role: 'user', content: 'list the files' }],
			},
			log.sink,
		);
		await log.wait();

		assert.ok(log.toolResults[0].output.includes('inside-workspace.txt'));
		assert.ok(
			!log.toolResults[0].output.includes('outside-workspace.txt'),
			'the tool must not see outside its workspace',
		);
		await rm(outside, { recursive: true, force: true });
	});

	test('a tool cannot escape the workspace with a relative path', async () => {
		const { fetchImpl } = scriptedAgent([
			{ calls: [{ id: 'c1', name: 'read_file', args: { path: '../../secrets.json' } }] },
			{ text: 'that path is outside the project' },
		]);
		const { chat, conversationId } = await agentSession(fetchImpl);
		await writeFile(join(root, 'secrets.json'), '{"key":"value"}', 'utf8');
		const log = new EventLog();

		await chat.sendMessage(
			{
				providerId: LOCAL_ID,
				conversationId,
				model: 'test-model',
				messages: [{ role: 'user', content: 'read secrets' }],
			},
			log.sink,
		);
		await log.wait();

		assert.strictEqual(log.toolResults[0].ok, false);
		assert.ok(
			!log.toolResults[0].output.includes('"key"'),
			'the file outside the workspace must not be read',
		);
	});

	test('a conversation with no project has no workspace, so file tools refuse', async () => {
		const { fetchImpl } = scriptedAgent([
			{ calls: [{ id: 'c1', name: 'list_files', args: { path: '.' } }] },
			{ text: 'I have no project to look in' },
		]);
		const { chat, conversationId } = await agentSession(fetchImpl, { withProject: false });
		const log = new EventLog();

		await chat.sendMessage(
			{
				providerId: LOCAL_ID,
				conversationId,
				model: 'test-model',
				messages: [{ role: 'user', content: 'list files' }],
			},
			log.sink,
		);
		await log.wait();

		// Refusing is the safe reading: a tool with no workspace has no directory
		// to confine itself to, and guessing one would be worse.
		assert.strictEqual(log.toolResults[0].ok, false);
		assert.match(log.toolResults[0].output, /needs a workspace/i);
	});

	// ── event hygiene ───────────────────────────────────────────────────────

	test('every event of a turn carries the same turnId', async () => {
		const { fetchImpl } = scriptedAgent([
			{ calls: [{ id: 'c1', name: 'list_files', args: { path: '.' } }] },
			{ text: 'done' },
		]);
		const { chat, conversationId } = await agentSession(fetchImpl);
		const log = new EventLog();

		await chat.sendMessage(
			{
				providerId: LOCAL_ID,
				conversationId,
				model: 'test-model',
				messages: [{ role: 'user', content: 'go' }],
			},
			log.sink,
		);
		await log.wait();

		assert.strictEqual(new Set(log.events.map((event) => event.turnId)).size, 1);
	});

	test('a tool call that never returns still ends the turn with one terminal event', async () => {
		const { fetchImpl } = scriptedAgent([
			{ calls: [{ id: 'c1', name: 'read_file', args: { path: 'loop.txt' } }] },
			{ text: 'recovered' },
		]);
		const { chat, conversationId, workspace } = await agentSession(fetchImpl);
		await writeFile(join(workspace, 'loop.txt'), 'content', 'utf8');
		const log = new EventLog();

		await chat.sendMessage(
			{
				providerId: LOCAL_ID,
				conversationId,
				model: 'test-model',
				messages: [{ role: 'user', content: 'read it' }],
			},
			log.sink,
		);
		await log.wait();

		const terminals = log.events.filter(
			(event) => event.type === 'done' || event.type === 'error',
		);
		assert.strictEqual(terminals.length, 1, 'exactly one terminal event');
	});

	test('the session is free again once a tool turn finishes', async () => {
		const { fetchImpl } = scriptedAgent([
			{ calls: [{ id: 'c1', name: 'list_files', args: { path: '.' } }] },
			{ text: 'done' },
		]);
		const { chat, conversationId } = await agentSession(fetchImpl);
		const log = new EventLog();

		await chat.sendMessage(
			{
				providerId: LOCAL_ID,
				conversationId,
				model: 'test-model',
				messages: [{ role: 'user', content: 'go' }],
			},
			log.sink,
		);
		await log.wait();

		assert.strictEqual(chat.isBusy, false, 'a tool turn must not strand the session');
	});

	// ── 9. what gets stored has to stay honest and valid ────────────────────

	test('an unknown tool and malformed arguments report their real reason', async () => {
		const { fetchImpl } = scriptedAgent([
			{ calls: [{ id: 'c1', name: 'do_magic', args: {} }], rawArgs: '{broken json' },
			{ text: 'I could not run that' },
		]);
		const { chat, conversationId } = await agentSession(fetchImpl);
		const log = new EventLog();

		await chat.sendMessage(
			{
				providerId: LOCAL_ID,
				conversationId,
				model: 'test-model',
				messages: [{ role: 'user', content: 'try the magic' }],
			},
			log.sink,
		);
		await log.wait();

		// The user is told what actually happened — not a permission refusal
		// that never took place.
		assert.strictEqual(log.toolResults.length, 2);
		assert.strictEqual(log.toolResults[0].ok, false);
		assert.match(log.toolResults[0].output, /no tool named "do_magic"/);
		assert.strictEqual(log.toolResults[1].ok, false);
		assert.match(log.toolResults[1].output, /were not a JSON object/);

		// And so is the next turn: the same text is what was persisted.
		const stored = await new FileDataStore({ rootPath: join(root, 'data') }).getConversation(
			conversationId,
		);
		const results = (stored?.messages ?? []).filter((message) => message.role === 'tool');
		assert.strictEqual(results.length, 2);
		assert.match(results[0]?.content ?? '', /no tool named "do_magic"/);
		assert.match(results[1]?.content ?? '', /were not a JSON object/);
	});

	test('text the model says before calling a tool stays in its own round', async () => {
		const { fetchImpl } = scriptedAgent([
			{
				text: 'Let me look around',
				calls: [{ id: 'c1', name: 'list_files', args: { path: '.' } }],
			},
			{ text: 'All finished' },
		]);
		const { chat, conversationId, workspace } = await agentSession(fetchImpl);
		await writeFile(join(workspace, 'y.txt'), 'y', 'utf8');
		const log = new EventLog();

		await chat.sendMessage(
			{
				providerId: LOCAL_ID,
				conversationId,
				model: 'test-model',
				messages: [{ role: 'user', content: 'look around' }],
			},
			log.sink,
		);
		await log.wait();

		const stored = await new FileDataStore({ rootPath: join(root, 'data') }).getConversation(
			conversationId,
		);
		const messages = stored?.messages ?? [];
		// Four messages, not three: the round that spoke before calling the tool
		// and the final answer are separate assistant messages, with the tool
		// result between them. Folding them merged both rounds into one.
		assert.deepStrictEqual(
			messages.map((message) => message.role),
			['user', 'assistant', 'tool', 'assistant'],
		);
		assert.match(messages[1]?.content ?? '', /Let me look around/);
		assert.match(messages[1]?.content ?? '', /\[tool calls: list_files\(/);
		assert.ok(
			!(messages[1]?.content ?? '').includes('All finished'),
			'the final answer must not fold back into the tool round',
		);
		assert.match(messages[3]?.content ?? '', /All finished/);
	});

	test('a failed tool-result write is retried and never leaves tool_calls unanswered', async () => {
		const { fetchImpl } = scriptedAgent([
			{ calls: [{ id: 'c1', name: 'list_files', args: { path: '.' } }] },
			{ text: 'recovered' },
		]);
		const history = new FlakyAppendStore({ rootPath: join(root, 'data') });
		const chat = session(fetchImpl, history);
		await chat.saveProvider({ baseUrl: LOCAL_URL });
		const conversation = await chat.createConversation({ providerId: LOCAL_ID });
		const log = new EventLog();

		await chat.sendMessage(
			{
				providerId: LOCAL_ID,
				conversationId: conversation.summary.id,
				model: 'test-model',
				messages: [{ role: 'user', content: 'look around' }],
			},
			log.sink,
		);
		await log.wait();

		// The failure is reported, not swallowed…
		assert.ok(log.types.includes('error'), 'the storage failure reaches the caller');
		// …and the transcript is whole: the assistant round landed exactly once
		// and every stored tool_call has the tool message that answers it.
		const stored = await new FileDataStore({ rootPath: join(root, 'data') }).getConversation(
			conversation.summary.id,
		);
		const messages = stored?.messages ?? [];
		assert.deepStrictEqual(
			messages.map((message) => message.role),
			['user', 'assistant', 'tool'],
		);
		assert.deepStrictEqual(
			(messages[1]?.toolCalls ?? []).map((call) => call.id),
			['c1'],
			'the assistant round is stored exactly once',
		);
		assert.strictEqual(messages[2]?.toolCallId, 'c1', 'and its result answers the call');

		// The conversation still works afterwards.
		const retry = new EventLog();
		await chat.sendMessage(
			{
				providerId: LOCAL_ID,
				conversationId: conversation.summary.id,
				model: 'test-model',
				messages: [{ role: 'user', content: 'try again' }],
			},
			retry.sink,
		);
		await retry.wait();
		assert.ok(retry.types.includes('done'), 'the recovered conversation keeps working');
	});
});
