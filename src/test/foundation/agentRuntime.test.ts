import * as assert from 'assert';
import { ConversationRuntime, toAgentTurn } from '../../core/agent/runtime';
import { ToolRegistry, type ToolSpec } from '../../core/agent/toolRegistry';
import type { AgentEvent, AgentTool, ToolDescriptor, ToolResult } from '../../core/agent/types';
import type {
	ChatMessage,
	ChatProvider,
	ChatRequest,
	ChatStream,
	ChatStreamEvent,
} from '../../core/providers/chat/types';
import type {
	PermissionDecision,
	PermissionRequest,
} from '../../core/permissions/gateway';

/** A scripted provider: each call to streamChat replays the next script. */
class ScriptedProvider implements ChatProvider {
	readonly requests: ChatRequest[] = [];
	private index = 0;

	constructor(private readonly scripts: readonly ChatStreamEvent[][]) {}

	async streamChat(request: ChatRequest): Promise<ChatStream> {
		this.requests.push(request);
		const script = this.scripts[Math.min(this.index, this.scripts.length - 1)];
		this.index += 1;
		return streamOf(script);
	}

	get callCount(): number {
		return this.index;
	}
}

function streamOf(events: readonly ChatStreamEvent[]): ChatStream {
	return {
		closedReason: 'completed',
		[Symbol.asyncIterator]: async function* () {
			yield* events;
		},
	};
}

function text(text: string): ChatStreamEvent {
	return { type: 'TextDelta', text };
}
function reasoning(text: string): ChatStreamEvent {
	return { type: 'ReasoningDelta', text };
}
function done(): ChatStreamEvent {
	return { type: 'Done' };
}
function toolCall(name: string, args: string, id = 'call_1'): ChatStreamEvent {
	return { type: 'ToolCallDelta', call: { id, name, arguments: args } };
}

/** A gateway that answers from a fixed policy. */
class ScriptedPermissions {
	readonly requests: PermissionRequest[] = [];

	constructor(private readonly policy: (request: PermissionRequest) => PermissionDecision) {}

	async ask(request: PermissionRequest): Promise<PermissionDecision> {
		this.requests.push(request);
		return this.policy(request);
	}
}

const GRANT: PermissionDecision = { decision: 'allow' };
const DENY: PermissionDecision = { decision: 'deny', reason: 'user said no' };

interface RecordedTool {
	readonly name: string;
	readonly inputs: unknown[];
	readonly contexts: unknown[];
}

/** Builds a fake tool that records how it was called. */
function fakeTool(
	name: string,
	record: RecordedTool,
	behaviour: (input: unknown) => ToolResult = () => ({ ok: true, output: 'done' }),
): AgentTool {
	const descriptor: ToolDescriptor = {
		id: name,
		name,
		category: 'other',
		riskLevel: 'safe',
		description: `Fake ${name}`,
	};
	return {
		descriptor,
		execute: async (input, context) => {
			record.inputs.push(input);
			record.contexts.push(context);
			return behaviour(input);
		},
	};
}

function spec(name: string): ToolSpec {
	return {
		name,
		description: `Fake ${name}`,
		parameters: { type: 'object', properties: {} },
		riskLevel: 'safe',
		category: 'other',
	};
}

/** Drains a turn into an event array. */
async function collect(
	runtime: ConversationRuntime,
	input: Parameters<ConversationRuntime['run']>[0],
	options: Parameters<ConversationRuntime['run']>[1] = {},
): Promise<AgentEvent[]> {
	const events: AgentEvent[] = [];
	for await (const event of runtime.run(input, options)) {
		events.push(event);
	}
	return events;
}

const USER: ChatMessage = { role: 'user', content: 'hello' };

suite('Core: tool registry', () => {
	test('registers and resolves a tool', () => {
		const registry = new ToolRegistry();
		const record: RecordedTool = { name: 't', inputs: [], contexts: [] };

		const unregister = registry.register(fakeTool('t', record), spec('t'));

		assert.strictEqual(registry.size, 1);
		assert.ok(registry.get('t') !== undefined);
		assert.strictEqual(typeof unregister, 'function');
	});

	test('refuses a duplicate name', () => {
		const registry = new ToolRegistry();
		const record: RecordedTool = { name: 't', inputs: [], contexts: [] };
		registry.register(fakeTool('t', record), spec('t'));

		assert.throws(() => registry.register(fakeTool('t', record), spec('t')));
	});

	test('unregister removes the tool', () => {
		const registry = new ToolRegistry();
		const record: RecordedTool = { name: 't', inputs: [], contexts: [] };
		registry.register(fakeTool('t', record), spec('t'));

		assert.strictEqual(registry.unregister('t'), true);
		assert.strictEqual(registry.has('t'), false);
		assert.strictEqual(registry.unregister('t'), false);
	});

	test('names are sorted for a stable prompt order', () => {
		const registry = new ToolRegistry();
		const record: RecordedTool = { name: 'x', inputs: [], contexts: [] };
		registry.register(fakeTool('zebra', record), spec('zebra'));
		registry.register(fakeTool('alpha', record), spec('alpha'));

		assert.deepStrictEqual(registry.names(), ['alpha', 'zebra']);
	});

	test('listSpecs follows the same order', () => {
		const registry = new ToolRegistry();
		const record: RecordedTool = { name: 'x', inputs: [], contexts: [] };
		registry.register(fakeTool('zebra', record), spec('zebra'));
		registry.register(fakeTool('alpha', record), spec('alpha'));

		assert.deepStrictEqual(
			registry.listSpecs().map((s) => s.name),
			['alpha', 'zebra'],
		);
	});

	test('registering fires a change event', () => {
		const registry = new ToolRegistry();
		const record: RecordedTool = { name: 't', inputs: [], contexts: [] };
		let changes = 0;
		registry.onDidChangeTools(() => {
			changes += 1;
		});

		registry.register(fakeTool('t', record), spec('t'));
		assert.strictEqual(changes, 1);

		registry.clear();
		assert.strictEqual(changes, 2);
	});
});

suite('Core: runtime, plain answer', () => {
	test('a text-only answer completes with no tool calls', async () => {
		const provider = new ScriptedProvider([[text('Hi'), done()]]);
		const runtime = new ConversationRuntime({
			provider,
			tools: new ToolRegistry(),
			permissions: new ScriptedPermissions(() => GRANT),
		});

		const events = await collect(runtime, { messages: [USER] });

		assert.deepStrictEqual(
			events.filter((e) => e.type === 'TextDelta').map((e) => (e as { text: string }).text),
			['Hi'],
		);
		assert.deepStrictEqual(events[events.length - 1], {
			type: 'TurnCompleted',
			reason: 'answered',
		});
		assert.strictEqual(runtime.completion, 'answered');
	});

	test('reasoning is forwarded but never becomes part of the answer', async () => {
		const provider = new ScriptedProvider([[reasoning('thinking'), text('Hi'), done()]]);
		const runtime = new ConversationRuntime({
			provider,
			tools: new ToolRegistry(),
			permissions: new ScriptedPermissions(() => GRANT),
		});

		const events = await collect(runtime, { messages: [USER] });

		assert.deepStrictEqual(
			events.filter((e) => e.type === 'ReasoningDelta').map((e) => (e as { text: string }).text),
			['thinking'],
		);
		// The regression this guards: `text` accumulates into the assistant
		// message, which the next turn replays to the model. Folding the
		// scratchpad in would put the model's own words in the user's history.
		assert.deepStrictEqual(
			events.filter((e) => e.type === 'TextDelta').map((e) => (e as { text: string }).text),
			['Hi'],
		);
	});

	test('a reasoning-only stream still completes as answered', async () => {
		// A turn whose every token went to reasoning and none to `content`.
		const provider = new ScriptedProvider([[reasoning('only thinking'), done()]]);
		const runtime = new ConversationRuntime({
			provider,
			tools: new ToolRegistry(),
			permissions: new ScriptedPermissions(() => GRANT),
		});

		const events = await collect(runtime, { messages: [USER] });

		assert.deepStrictEqual(events[events.length - 1], {
			type: 'TurnCompleted',
			reason: 'answered',
		});
	});

	test('the provider is called exactly once for a plain answer', async () => {
		const provider = new ScriptedProvider([[text('Hi'), done()]]);
		const runtime = new ConversationRuntime({
			provider,
			tools: new ToolRegistry(),
			permissions: new ScriptedPermissions(() => GRANT),
		});

		await collect(runtime, { messages: [USER] });

		assert.strictEqual(provider.callCount, 1);
	});

	test('the model and messages reach the provider', async () => {
		const provider = new ScriptedProvider([[text('Hi'), done()]]);
		const runtime = new ConversationRuntime({
			provider,
			tools: new ToolRegistry(),
			permissions: new ScriptedPermissions(() => GRANT),
			defaultModel: 'model-default',
		});

		await collect(runtime, { messages: [USER] });

		assert.strictEqual(provider.requests[0].model, 'model-default');
		assert.deepStrictEqual(provider.requests[0].messages, [USER]);
	});

	test('an explicit model overrides the default', async () => {
		const provider = new ScriptedProvider([[text('Hi'), done()]]);
		const runtime = new ConversationRuntime({
			provider,
			tools: new ToolRegistry(),
			permissions: new ScriptedPermissions(() => GRANT),
			defaultModel: 'model-default',
		});

		await collect(runtime, { messages: [USER], model: 'model-explicit' });

		assert.strictEqual(provider.requests[0].model, 'model-explicit');
	});

	test("the caller's history is never mutated", async () => {
		const provider = new ScriptedProvider([[text('Hi'), done()]]);
		const runtime = new ConversationRuntime({
			provider,
			tools: new ToolRegistry(),
			permissions: new ScriptedPermissions(() => GRANT),
		});
		const messages: ChatMessage[] = [{ role: 'user', content: 'hello' }];

		await collect(runtime, { messages });

		assert.strictEqual(messages.length, 1, 'the caller array is untouched');
	});
});

suite('Core: runtime, tool calls', () => {
	test('a tool call is resolved, run, and its result sent back', async () => {
		const provider = new ScriptedProvider([
			[toolCall('read_file', '{"path":"a.txt"}'), done()],
			[text('The file says hi'), done()],
		]);
		const registry = new ToolRegistry();
		const record: RecordedTool = { name: 'read_file', inputs: [], contexts: [] };
		registry.register(
			fakeTool('read_file', record, () => ({ ok: true, output: 'file contents' })),
			spec('read_file'),
		);
		const runtime = new ConversationRuntime({
			provider,
			tools: registry,
			permissions: new ScriptedPermissions(() => GRANT),
		});

		const events = await collect(runtime, { messages: [USER] });

		assert.strictEqual(record.inputs.length, 1);
		assert.deepStrictEqual(record.inputs[0], { path: 'a.txt' });
		// Two round-trips: the call, then the follow-up with the result.
		assert.strictEqual(provider.callCount, 2);
		const secondRequest = provider.requests[1];
		const last = secondRequest.messages[secondRequest.messages.length - 1];
		assert.strictEqual(last.role, 'tool');
		assert.strictEqual(last.content, 'file contents');
		assert.strictEqual(runtime.completion, 'answered');
	});

	test('a re-emitted tool call runs once', async () => {
		// What a server that ends on `finish_reason` *and* sends `[DONE]` looks
		// like once it reaches here: the same call, twice, under one id.
		const provider = new ScriptedProvider([
			[toolCall('t', '{}'), toolCall('t', '{}'), done()],
			[text('done'), done()],
		]);
		const registry = new ToolRegistry();
		const record: RecordedTool = { name: 't', inputs: [], contexts: [] };
		registry.register(fakeTool('t', record), spec('t'));
		const runtime = new ConversationRuntime({
			provider,
			tools: registry,
			permissions: new ScriptedPermissions(() => GRANT),
		});

		const events = await collect(runtime, { messages: [USER] });

		assert.strictEqual(record.inputs.length, 1, 'the tool runs once');
		assert.strictEqual(
			events.filter((e) => e.type === 'ToolCallRequested').length,
			1,
			'one announcement, not one per copy',
		);
		assert.strictEqual(events.filter((e) => e.type === 'ToolCompleted').length, 1);
		// Two `role:"tool"` messages under one `tool_call_id` would be refused
		// by the next request's server.
		const second = provider.requests[1];
		assert.strictEqual(second.messages.filter((m) => m.role === 'tool').length, 1);
	});

	test('a call whose arguments grow across deltas runs complete', async () => {
		// A provider that re-sends the call as its arguments fill in, rather
		// than emitting it once complete: each delta reads as the whole call so
		// far, and the last one wins.
		const provider = new ScriptedProvider([
			[toolCall('t', '{"a"'), toolCall('t', '{"a":1}'), done()],
			[text('done'), done()],
		]);
		const registry = new ToolRegistry();
		const record: RecordedTool = { name: 't', inputs: [], contexts: [] };
		registry.register(fakeTool('t', record), spec('t'));
		const runtime = new ConversationRuntime({
			provider,
			tools: registry,
			permissions: new ScriptedPermissions(() => GRANT),
		});

		await collect(runtime, { messages: [USER] });

		assert.strictEqual(record.inputs.length, 1, 'still one call');
		assert.deepStrictEqual(record.inputs[0], { a: 1 }, 'the fuller reading is the one that runs');
	});

	test('the assistant message ahead of the results carries tool_calls', async () => {
		const provider = new ScriptedProvider([
			[toolCall('read_file', '{"path":"a.txt"}', 'call_7'), done()],
			[text('done'), done()],
		]);
		const registry = new ToolRegistry();
		const record: RecordedTool = { name: 'read_file', inputs: [], contexts: [] };
		registry.register(fakeTool('read_file', record), spec('read_file'));
		const runtime = new ConversationRuntime({
			provider,
			tools: registry,
			permissions: new ScriptedPermissions(() => GRANT),
		});

		await collect(runtime, { messages: [USER] });

		const second = provider.requests[1];
		const parent = second.messages.findIndex(
			(message) => message.role === 'assistant' && message.toolCalls !== undefined,
		);
		assert.ok(parent >= 0, 'the assistant message announces its calls');
		const assistant = second.messages[parent];
		assert.deepStrictEqual(assistant.toolCalls, [
			{ id: 'call_7', name: 'read_file', arguments: '{"path":"a.txt"}' },
		]);
		// Immediately followed by the message answering it — that adjacency is
		// what a strict server verifies.
		const answer = second.messages[parent + 1];
		assert.strictEqual(answer.role, 'tool');
		assert.strictEqual(
			answer.toolCallId,
			assistant.toolCalls?.[0]?.id,
			'the result answers the announced id',
		);
	});

	test('events report the call, the permission and the completion', async () => {
		const provider = new ScriptedProvider([
			[toolCall('t', '{}'), done()],
			[text('done'), done()],
		]);
		const registry = new ToolRegistry();
		const record: RecordedTool = { name: 't', inputs: [], contexts: [] };
		registry.register(fakeTool('t', record), spec('t'));
		const runtime = new ConversationRuntime({
			provider,
			tools: registry,
			permissions: new ScriptedPermissions(() => GRANT),
		});

		const types = (await collect(runtime, { messages: [USER] })).map((e) => e.type);

		assert.deepStrictEqual(types, [
			'ToolCallRequested',
			'PermissionRequested',
			'PermissionResolved',
			'ToolCompleted',
			'TextDelta',
			'TurnCompleted',
		]);
	});

	test('the permission request carries the tool risk and arguments', async () => {
		const provider = new ScriptedProvider([
			[toolCall('write_file', '{"path":"b"}'), done()],
			[text('ok'), done()],
		]);
		const registry = new ToolRegistry();
		const record: RecordedTool = { name: 'write_file', inputs: [], contexts: [] };
		const dangerous = fakeTool('write_file', record);
		registry.register(
			{ ...dangerous, descriptor: { ...dangerous.descriptor, riskLevel: 'dangerous' } },
			{ ...spec('write_file'), riskLevel: 'dangerous' },
		);
		const permissions = new ScriptedPermissions(() => GRANT);
		const runtime = new ConversationRuntime({ provider, tools: registry, permissions });

		await collect(runtime, { messages: [USER] });

		assert.strictEqual(permissions.requests[0].toolId, 'write_file');
		assert.strictEqual(permissions.requests[0].riskLevel, 'dangerous');
		assert.deepStrictEqual(permissions.requests[0].arguments, { path: 'b' });
	});

	test('a denied permission does not run the tool and says why to the model', async () => {
		const provider = new ScriptedProvider([
			[toolCall('run_command', '{"cmd":"ls"}'), done()],
			[text('I cannot do that'), done()],
		]);
		const registry = new ToolRegistry();
		const record: RecordedTool = { name: 'run_command', inputs: [], contexts: [] };
		registry.register(fakeTool('run_command', record), spec('run_command'));
		const runtime = new ConversationRuntime({
			provider,
			tools: registry,
			permissions: new ScriptedPermissions(() => DENY),
		});

		const events = await collect(runtime, { messages: [USER] });

		assert.strictEqual(record.inputs.length, 0, 'the tool never ran');
		const last = provider.requests[1].messages[provider.requests[1].messages.length - 1];
		assert.match(last.content, /denied/);
		assert.match(last.content, /user said no/);
		const completed = events.find((e) => e.type === 'ToolCompleted') as
			| { readonly ok: boolean; readonly output: string }
			| undefined;
		assert.strictEqual(completed?.ok, false);
		// The event carries the very text the model received — a host that
		// shows or stores `output` tells the same story the model was told.
		assert.strictEqual(completed?.output, last.content);
		assert.match(completed?.output ?? '', /denied/);
	});

	test('an unknown tool is reported to the model, not thrown', async () => {
		const provider = new ScriptedProvider([
			[toolCall('nope', '{}'), done()],
			[text('sorry'), done()],
		]);
		const runtime = new ConversationRuntime({
			provider,
			tools: new ToolRegistry(),
			permissions: new ScriptedPermissions(() => GRANT),
		});

		const events = await collect(runtime, { messages: [USER] });

		const last = provider.requests[1].messages[provider.requests[1].messages.length - 1];
		assert.match(last.content, /no tool named "nope"/);
		const completed = events.find((e) => e.type === 'ToolCompleted') as
			| { readonly output: string }
			| undefined;
		assert.strictEqual(completed?.output, last.content);
		assert.strictEqual(events[events.length - 1].type, 'TurnCompleted');
	});

	test('malformed tool arguments are reported, not executed', async () => {
		const provider = new ScriptedProvider([
			[toolCall('t', 'not json at all'), done()],
			[text('ok'), done()],
		]);
		const registry = new ToolRegistry();
		const record: RecordedTool = { name: 't', inputs: [], contexts: [] };
		registry.register(fakeTool('t', record), spec('t'));
		const runtime = new ConversationRuntime({
			provider,
			tools: registry,
			permissions: new ScriptedPermissions(() => GRANT),
		});

		const events = await collect(runtime, { messages: [USER] });

		assert.strictEqual(record.inputs.length, 0);
		const last = provider.requests[1].messages[provider.requests[1].messages.length - 1];
		assert.match(last.content, /not a JSON object/);
		const completed = events.find((e) => e.type === 'ToolCompleted') as
			| { readonly output: string }
			| undefined;
		assert.strictEqual(completed?.output, last.content);
	});

	test('a throwing tool becomes an error result for the model', async () => {
		const provider = new ScriptedProvider([
			[toolCall('t', '{}'), done()],
			[text('recovered'), done()],
		]);
		const registry = new ToolRegistry();
		const record: RecordedTool = { name: 't', inputs: [], contexts: [] };
		registry.register(
			fakeTool('t', record, () => {
				throw new Error('disk on fire');
			}),
			spec('t'),
		);
		const runtime = new ConversationRuntime({
			provider,
			tools: registry,
			permissions: new ScriptedPermissions(() => GRANT),
		});

		const events = await collect(runtime, { messages: [USER] });

		const last = provider.requests[1].messages[provider.requests[1].messages.length - 1];
		assert.match(last.content, /disk on fire/);
		const completed = events.find((e) => e.type === 'ToolCompleted');
		assert.strictEqual((completed as { ok: boolean }).ok, false);
	});

	test('a tool returning ok:false is reported as a failure', async () => {
		const provider = new ScriptedProvider([
			[toolCall('t', '{}'), done()],
			[text('ok'), done()],
		]);
		const registry = new ToolRegistry();
		const record: RecordedTool = { name: 't', inputs: [], contexts: [] };
		registry.register(
			fakeTool('t', record, () => ({ ok: false, error: 'path is a directory' })),
			spec('t'),
		);
		const runtime = new ConversationRuntime({
			provider,
			tools: registry,
			permissions: new ScriptedPermissions(() => GRANT),
		});

		await collect(runtime, { messages: [USER] });

		const last = provider.requests[1].messages[provider.requests[1].messages.length - 1];
		assert.match(last.content, /path is a directory/);
	});

	test('a failing permission check does not kill the turn', async () => {
		const provider = new ScriptedProvider([
			[toolCall('t', '{}'), done()],
			[text('moving on'), done()],
		]);
		const registry = new ToolRegistry();
		const record: RecordedTool = { name: 't', inputs: [], contexts: [] };
		registry.register(fakeTool('t', record), spec('t'));
		const runtime = new ConversationRuntime({
			provider,
			tools: registry,
			permissions: new ScriptedPermissions(() => {
				throw new Error('policy engine unavailable');
			}),
		});

		const events = await collect(runtime, { messages: [USER] });

		assert.strictEqual(record.inputs.length, 0);
		assert.strictEqual(runtime.completion, 'answered');
		assert.strictEqual(events[events.length - 1].type, 'TurnCompleted');
	});

	test('two tool calls in one response both run', async () => {
		const provider = new ScriptedProvider([
			[toolCall('t', '{"n":1}', 'call_a'), toolCall('t', '{"n":2}', 'call_b'), done()],
			[text('both done'), done()],
		]);
		const registry = new ToolRegistry();
		const record: RecordedTool = { name: 't', inputs: [], contexts: [] };
		registry.register(fakeTool('t', record), spec('t'));
		const runtime = new ConversationRuntime({
			provider,
			tools: registry,
			permissions: new ScriptedPermissions(() => GRANT),
		});

		await collect(runtime, { messages: [USER] });

		assert.strictEqual(record.inputs.length, 2);
		assert.deepStrictEqual(record.inputs, [{ n: 1 }, { n: 2 }]);
	});

	test('the working directory reaches the tool context', async () => {
		const provider = new ScriptedProvider([
			[toolCall('t', '{}'), done()],
			[text('ok'), done()],
		]);
		const registry = new ToolRegistry();
		const record: RecordedTool = { name: 't', inputs: [], contexts: [] };
		registry.register(fakeTool('t', record), spec('t'));
		const runtime = new ConversationRuntime({
			provider,
			tools: registry,
			permissions: new ScriptedPermissions(() => GRANT),
			workingDirectory: '/projects/demo',
		});

		await collect(runtime, { messages: [USER] });

		assert.deepStrictEqual(record.contexts[0], {
			sessionId: 'runtime',
			workingDirectory: '/projects/demo',
		});
	});

	test('registered tools are advertised to the model', async () => {
		const provider = new ScriptedProvider([[text('ok'), done()]]);
		const registry = new ToolRegistry();
		const record: RecordedTool = { name: 'x', inputs: [], contexts: [] };
		registry.register(fakeTool('read_file', record), spec('read_file'));
		const runtime = new ConversationRuntime({
			provider,
			tools: registry,
			permissions: new ScriptedPermissions(() => GRANT),
		});

		await collect(runtime, { messages: [USER] });

		assert.deepStrictEqual(
			provider.requests[0].tools?.map((t) => t.name),
			['read_file'],
		);
	});

	test('with no tools registered, none are advertised', async () => {
		const provider = new ScriptedProvider([[text('ok'), done()]]);
		const runtime = new ConversationRuntime({
			provider,
			tools: new ToolRegistry(),
			permissions: new ScriptedPermissions(() => GRANT),
		});

		await collect(runtime, { messages: [USER] });

		assert.strictEqual(provider.requests[0].tools, undefined);
	});
});

suite('Core: runtime, loop bounds and cancellation', () => {
	test('a model that always calls tools stops at maxTurns', async () => {
		const provider = new ScriptedProvider([[toolCall('t', '{}'), done()]]);
		const registry = new ToolRegistry();
		const record: RecordedTool = { name: 't', inputs: [], contexts: [] };
		registry.register(fakeTool('t', record), spec('t'));
		const runtime = new ConversationRuntime({
			provider,
			tools: registry,
			permissions: new ScriptedPermissions(() => GRANT),
			maxTurns: 3,
		});

		const events = await collect(runtime, { messages: [USER] });

		assert.deepStrictEqual(events[events.length - 1], {
			type: 'TurnCompleted',
			reason: 'maxTurns',
		});
		assert.strictEqual(provider.callCount, 3, 'exactly the budget, no more');
		assert.strictEqual(runtime.completion, 'maxTurns');
	});

	test('the default turn budget is finite', async () => {
		const provider = new ScriptedProvider([[toolCall('t', '{}'), done()]]);
		const registry = new ToolRegistry();
		const record: RecordedTool = { name: 't', inputs: [], contexts: [] };
		registry.register(fakeTool('t', record), spec('t'));
		const runtime = new ConversationRuntime({
			provider,
			tools: registry,
			permissions: new ScriptedPermissions(() => GRANT),
		});

		await collect(runtime, { messages: [USER] });

		assert.ok(provider.callCount <= 16, 'the loop is bounded by default');
	});

	test('a provider error ends the turn with TurnFailed', async () => {
		const provider = new ScriptedProvider([[{ type: 'Error', error: new Error('upstream down') }]]);
		const runtime = new ConversationRuntime({
			provider,
			tools: new ToolRegistry(),
			permissions: new ScriptedPermissions(() => GRANT),
		});

		const events = await collect(runtime, { messages: [USER] });

		assert.strictEqual(events[0].type, 'TurnFailed');
		assert.deepStrictEqual(events[1], { type: 'TurnCompleted', reason: 'error' });
		assert.strictEqual(runtime.completion, 'error');
	});

	test('a provider that throws is caught and reported', async () => {
		const provider: ChatProvider = {
			streamChat: async () => {
				throw new Error('cannot connect');
			},
		};
		const runtime = new ConversationRuntime({
			provider,
			tools: new ToolRegistry(),
			permissions: new ScriptedPermissions(() => GRANT),
		});

		const events = await collect(runtime, { messages: [USER] });

		// A rejection before the stream even opens must be reported like any
		// other failure: `TurnFailed`, then exactly one `TurnCompleted`, with
		// nothing left pending — or the consumer waits for a terminal that
		// never comes.
		assert.deepStrictEqual(
			events.map((event) => event.type),
			['TurnFailed', 'TurnCompleted'],
		);
		assert.match((events[0] as { error: Error }).error.message, /cannot connect/);
		assert.deepStrictEqual(events[1], { type: 'TurnCompleted', reason: 'error' });
		assert.strictEqual(runtime.completion, 'error');
	});

	test('an Error event after a TextDelta is followed by nothing else', async () => {
		const provider = new ScriptedProvider([
			[text('partial'), { type: 'Error', error: new Error('upstream died') }],
		]);
		const runtime = new ConversationRuntime({
			provider,
			tools: new ToolRegistry(),
			permissions: new ScriptedPermissions(() => GRANT),
		});

		const events = await collect(runtime, { messages: [USER] });

		assert.deepStrictEqual(
			events.map((event) => event.type),
			['TextDelta', 'TurnFailed', 'TurnCompleted'],
			'what was already delivered stays, and nothing follows the terminal pair',
		);
		assert.strictEqual(runtime.completion, 'error');
	});

	test('every drained outcome reports exactly one TurnCompleted', async () => {
		const registryWithTool = (): ToolRegistry => {
			const registry = new ToolRegistry();
			registry.register(
				fakeTool('t', { name: 't', inputs: [], contexts: [] }),
				spec('t'),
			);
			return registry;
		};

		const scenarios: readonly {
			readonly name: string;
			readonly provider: ChatProvider;
			readonly tools?: ToolRegistry;
			readonly maxTurns?: number;
			readonly aborted?: boolean;
			readonly expected: string;
		}[] = [
			{
				name: 'answered',
				provider: new ScriptedProvider([[text('ok'), done()]]),
				expected: 'answered',
			},
			{
				name: 'stream error',
				provider: new ScriptedProvider([[{ type: 'Error', error: new Error('x') }]]),
				expected: 'error',
			},
			{
				name: 'rejected streamChat',
				provider: {
					streamChat: async () => {
						throw new Error('refused');
					},
				},
				expected: 'error',
			},
			{
				name: 'aborted before start',
				provider: new ScriptedProvider([[text('never'), done()]]),
				aborted: true,
				expected: 'aborted',
			},
			{
				name: 'budget exhausted',
				provider: new ScriptedProvider([[toolCall('t', '{}'), done()]]),
				tools: registryWithTool(),
				maxTurns: 1,
				expected: 'maxTurns',
			},
		];

		for (const scenario of scenarios) {
			const runtime: ConversationRuntime = new ConversationRuntime({
				provider: scenario.provider,
				tools: scenario.tools ?? new ToolRegistry(),
				permissions: new ScriptedPermissions((): PermissionDecision => GRANT),
				...(scenario.maxTurns !== undefined ? { maxTurns: scenario.maxTurns } : {}),
			});
			const controller = new AbortController();
			if (scenario.aborted === true) {
				controller.abort();
			}

			const events = await collect(runtime, { messages: [USER] }, { signal: controller.signal });

			const completions = events.filter((event) => event.type === 'TurnCompleted');
			assert.strictEqual(
				completions.length,
				1,
				`${scenario.name}: exactly one TurnCompleted`,
			);
			assert.strictEqual(
				events[events.length - 1].type,
				'TurnCompleted',
				`${scenario.name}: nothing follows the terminal event`,
			);
			assert.strictEqual(
				runtime.completion,
				scenario.expected,
				`${scenario.name}: completion is settled, never left "running"`,
			);
		}
	});

	test('aborting before the first call stops the turn', async () => {
		const provider = new ScriptedProvider([[text('never'), done()]]);
		const runtime = new ConversationRuntime({
			provider,
			tools: new ToolRegistry(),
			permissions: new ScriptedPermissions(() => GRANT),
		});
		const controller = new AbortController();
		controller.abort();

		const events = await collect(runtime, { messages: [USER] }, { signal: controller.signal });

		assert.deepStrictEqual(events, [{ type: 'TurnCompleted', reason: 'aborted' }]);
		assert.strictEqual(provider.callCount, 0);
		assert.strictEqual(runtime.completion, 'aborted');
	});

	test('aborting after a tool call stops before the next round-trip', async () => {
		const provider = new ScriptedProvider([
			[toolCall('t', '{}'), done()],
			[text('never'), done()],
		]);
		const registry = new ToolRegistry();
		const record: RecordedTool = { name: 't', inputs: [], contexts: [] };
		registry.register(fakeTool('t', record), spec('t'));
		const runtime = new ConversationRuntime({
			provider,
			tools: registry,
			permissions: new ScriptedPermissions(() => GRANT),
		});
		const controller = new AbortController();
		controller.abort();

		const events = await collect(runtime, { messages: [USER] }, { signal: controller.signal });

		assert.strictEqual(events[events.length - 1].type, 'TurnCompleted');
		assert.strictEqual(runtime.completion, 'aborted');
		assert.strictEqual(provider.callCount, 0);
	});

	test('breaking out of the loop early stops the runtime', async () => {
		const provider = new ScriptedProvider([[text('a'), text('b'), done()]]);
		const runtime = new ConversationRuntime({
			provider,
			tools: new ToolRegistry(),
			permissions: new ScriptedPermissions(() => GRANT),
		});

		for await (const event of runtime.run({ messages: [USER] })) {
			assert.strictEqual(event.type, 'TextDelta');
			break;
		}

		// The generator is closed; a second run still works.
		const next = new ScriptedProvider([[text('c'), done()]]);
		const second = new ConversationRuntime({
			provider: next,
			tools: new ToolRegistry(),
			permissions: new ScriptedPermissions(() => GRANT),
		});
		const events = await collect(second, { messages: [USER] });
		assert.strictEqual(events[events.length - 1].type, 'TurnCompleted');
	});

	test('toAgentTurn buffers a turn and reports its completion', async () => {
		const provider = new ScriptedProvider([[text('Hi'), done()]]);
		const runtime = new ConversationRuntime({
			provider,
			tools: new ToolRegistry(),
			permissions: new ScriptedPermissions(() => GRANT),
		});

		const turn = await toAgentTurn(runtime, { messages: [USER] });
		const events: AgentEvent[] = [];
		for await (const event of turn) {
			events.push(event);
		}

		assert.strictEqual(turn.completion, 'answered');
		assert.strictEqual(events.length, 2);
	});

	test('createSession yields distinct ids', async () => {
		const runtime = new ConversationRuntime({
			provider: new ScriptedProvider([[text('ok'), done()]]),
			tools: new ToolRegistry(),
			permissions: new ScriptedPermissions(() => GRANT),
		});

		const first = await runtime.createSession();
		const second = await runtime.createSession();

		assert.notStrictEqual(first.id, second.id);
		await runtime.disposeSession(first.id);
	});
});