import * as assert from 'assert';
import {
	REDACTED,
	isDecision,
	redactArguments,
	allowAllGateway,
	denyAllGateway,
	createCallbackGateway,
	createRiskGateway,
	type PermissionDecision,
	type PermissionGateway,
	type PermissionRequest,
} from '../../core/permissions/gateway';
import { ConversationRuntime } from '../../core/agent/runtime';
import { ToolRegistry, type ToolSpec } from '../../core/agent/toolRegistry';
import type {
	AgentEvent,
	AgentTool,
	ToolDescriptor,
	ToolResult,
} from '../../core/agent/types';
import type {
	ChatProvider,
	ChatRequest,
	ChatStream,
	ChatStreamEvent,
} from '../../core/providers/chat/types';

/** A gateway that records requests and answers from a script. */
class RecordingGateway implements PermissionGateway {
	readonly requests: PermissionRequest[] = [];

	constructor(
		private readonly answers: readonly PermissionDecision[],
		private readonly failure?: Error,
	) {}

	async ask(request: PermissionRequest): Promise<PermissionDecision> {
		this.requests.push(request);
		if (this.failure !== undefined) {
			throw this.failure;
		}
		return this.answers[this.requests.length - 1] ?? { decision: 'deny', reason: 'ran out' };
	}
}

const ALLOW: PermissionDecision = { decision: 'allow' };
const DENY: PermissionDecision = { decision: 'deny', reason: 'user declined' };

interface RecordedTool {
	readonly inputs: unknown[];
	readonly contexts: unknown[];
}

function fakeTool(name: string, record: RecordedTool, riskLevel: ToolDescriptor['riskLevel'] = 'safe'): AgentTool {
	return {
		descriptor: { id: name, name, category: 'other', riskLevel, description: `Fake ${name}` },
		execute: async (input, context): Promise<ToolResult> => {
			record.inputs.push(input);
			record.contexts.push(context);
			return { ok: true, output: 'tool ran' };
		},
	};
}

function spec(name: string, riskLevel: ToolDescriptor['riskLevel'] = 'safe'): ToolSpec {
	return { name, description: `Fake ${name}`, parameters: { type: 'object' }, riskLevel, category: 'other' };
}

/** A provider that asks for tools once, then answers. */
function scriptedProvider(calls: readonly { name: string; args: string; id: string }[]): {
	provider: ChatProvider;
	requests: ChatRequest[];
} {
	const requests: ChatRequest[] = [];
	let round = 0;
	const provider: ChatProvider = {
		async streamChat(request: ChatRequest): Promise<ChatStream> {
			requests.push(request);
			const script: ChatStreamEvent[] =
				round === 0
					? [
							...calls.map((c) => ({
								type: 'ToolCallDelta' as const,
								call: { id: c.id, name: c.name, arguments: c.args },
							})),
							{ type: 'Done' as const },
						]
					: [{ type: 'TextDelta' as const, text: 'done' }, { type: 'Done' as const }];
			round += 1;
			return {
				closedReason: 'completed',
				// Never measured: this is a fixture, not a request.
				timing: {},
				[Symbol.asyncIterator]: async function* () {
					yield* script;
				},
			};
		},
	};
	return { provider, requests };
}

interface RuntimeFixture {
	runtime: ConversationRuntime;
	gateway: RecordingGateway;
	tool: RecordedTool;
}

function buildFixture(
	answers: readonly PermissionDecision[],
	failure?: Error,
	options: { risk?: ToolDescriptor['riskLevel'] } = {},
): RuntimeFixture {
	const { provider } = scriptedProvider([{ name: 't', args: '{"path":"a.txt"}', id: 'c1' }]);
	const registry = new ToolRegistry();
	const tool: RecordedTool = { inputs: [], contexts: [] };
	registry.register(fakeTool('t', tool, options.risk ?? 'safe'), spec('t', options.risk ?? 'safe'));
	const gateway = new RecordingGateway(answers, failure);
	const runtime = new ConversationRuntime({
		provider,
		tools: registry,
		permissions: gateway,
		workingDirectory: '/projects/demo',
	});
	return { runtime, gateway, tool };
}

async function drain(
	runtime: ConversationRuntime,
	options: { signal?: AbortSignal } = {},
): Promise<AgentEvent[]> {
	const events: AgentEvent[] = [];
	for await (const event of runtime.run(
		{ messages: [{ role: 'user', content: 'do it' }] },
		options,
	)) {
		events.push(event);
	}
	return events;
}

suite('Core: gateway redaction', () => {
	test('a secret-looking key is replaced', () => {
		const redacted = redactArguments({ apiKey: 'sk-live-123', path: 'a.txt' });

		assert.strictEqual(redacted.apiKey, REDACTED);
		assert.strictEqual(redacted.path, 'a.txt');
	});

	test('every secret key spelling is caught', () => {
		const redacted = redactArguments({
			token: 't',
			password: 'p',
			secret: 's',
			authorization: 'Bearer x',
			cookie: 'c',
			privateKey: 'k',
			api_key: 'x',
		});

		for (const value of Object.values(redacted)) {
			assert.strictEqual(value, REDACTED);
		}
	});

	test('a nested secret is redacted too', () => {
		const redacted = redactArguments({ config: { apiKey: 'sk-x', retries: 3 } });

		assert.strictEqual((redacted.config as Record<string, unknown>).apiKey, REDACTED);
		assert.strictEqual((redacted.config as Record<string, unknown>).retries, 3);
	});

	test('a deeply nested structure is truncated rather than recursing forever', () => {
		const deep: Record<string, unknown> = { level: 0 };
		let cursor = deep;
		for (let i = 1; i < 20; i += 1) {
			const next: Record<string, unknown> = { level: i };
			cursor.child = next;
			cursor = next;
		}

		// Must not throw and must not blow the stack.
		assert.doesNotThrow(() => redactArguments(deep));
	});

	test('a circular argument does not hang', () => {
		const circular: Record<string, unknown> = { name: 'x' };
		circular.self = circular;

		assert.doesNotThrow(() => redactArguments(circular));
	});

	test('a non-object input yields an empty map', () => {
		assert.deepStrictEqual(redactArguments('a string'), {});
		assert.deepStrictEqual(redactArguments(undefined), {});
		assert.deepStrictEqual(redactArguments(null), {});
	});

	test('an array argument is walked', () => {
		const redacted = redactArguments({ files: ['a.txt', 'b.txt'] });

		assert.deepStrictEqual(redacted.files, ['a.txt', 'b.txt']);
	});
});

suite('Core: gateway contract', () => {
	test('isDecision accepts only allow and deny', () => {
		assert.strictEqual(isDecision({ decision: 'allow' }), true);
		assert.strictEqual(isDecision({ decision: 'deny', reason: 'r' }), true);
		assert.strictEqual(isDecision({ decision: 'maybe' }), false);
		assert.strictEqual(isDecision({}), false);
		assert.strictEqual(isDecision(null), false);
		assert.strictEqual(isDecision('allow'), false);
	});

	test('allowAllGateway allows', async () => {
		const decision = await allowAllGateway().ask(requestFixture());

		assert.deepStrictEqual(decision, { decision: 'allow' });
	});

	test('denyAllGateway denies with a reason', async () => {
		const decision = await denyAllGateway().ask(requestFixture());

		assert.strictEqual(decision.decision, 'deny');
	});

	test('a callback gateway forwards the request', async () => {
		const seen: PermissionRequest[] = [];
		const gateway = createCallbackGateway(async (request) => {
			seen.push(request);
			return ALLOW;
		});

		const decision = await gateway.ask(requestFixture());

		assert.strictEqual(decision.decision, 'allow');
		assert.strictEqual(seen.length, 1);
	});

	test('the risk gateway allows safe without asking', async () => {
		let asked = 0;
		const gateway = createRiskGateway({
			onAsk: async () => {
				asked += 1;
				return ALLOW;
			},
		});

		const decision = await gateway.ask({ ...requestFixture(), riskLevel: 'safe' });

		assert.strictEqual(decision.decision, 'allow');
		assert.strictEqual(asked, 0, 'a safe action is not worth a prompt');
	});

	test('the risk gateway asks for moderate', async () => {
		let asked = 0;
		const gateway = createRiskGateway({
			onAsk: async () => {
				asked += 1;
				return ALLOW;
			},
		});

		await gateway.ask({ ...requestFixture(), riskLevel: 'moderate' });

		assert.strictEqual(asked, 1);
	});

	test('the risk gateway denies dangerous without asking', async () => {
		let asked = 0;
		const gateway = createRiskGateway({
			onAsk: async () => {
				asked += 1;
				return ALLOW;
			},
		});

		const decision = await gateway.ask({ ...requestFixture(), riskLevel: 'dangerous' });

		assert.strictEqual(decision.decision, 'deny');
		assert.strictEqual(asked, 0);
	});

	test('a dangerous action can be routed to a prompt instead', async () => {
		const gateway = createRiskGateway({
			onAsk: async () => DENY,
			denyDangerous: false,
		});

		const decision = await gateway.ask({ ...requestFixture(), riskLevel: 'dangerous' });

		assert.deepStrictEqual(decision, DENY);
	});
});

suite('Core: runtime obeys the gateway', () => {
	test('allow runs the tool', async () => {
		const fixture = buildFixture([ALLOW]);

		const events = await drain(fixture.runtime);

		assert.strictEqual(fixture.tool.inputs.length, 1);
		assert.strictEqual(events[events.length - 1].type, 'TurnCompleted');
	});

	test('deny never runs the tool', async () => {
		const fixture = buildFixture([DENY]);

		const events = await drain(fixture.runtime);

		assert.strictEqual(fixture.tool.inputs.length, 0, 'the tool was not executed');
		const resolved = events.find((e) => e.type === 'PermissionResolved');
		assert.strictEqual((resolved as { granted: boolean }).granted, false);
		const completed = events.find((e) => e.type === 'ToolCompleted');
		assert.strictEqual((completed as { ok: boolean }).ok, false);
	});

	test('the request carries everything a UI would show', async () => {
		const fixture = buildFixture([ALLOW], undefined, { risk: 'moderate' });

		await drain(fixture.runtime);

		const request = fixture.gateway.requests[0];
		assert.strictEqual(request.toolId, 't');
		assert.strictEqual(request.toolName, 't');
		assert.strictEqual(request.action, 't');
		assert.strictEqual(request.riskLevel, 'moderate');
		assert.match(request.description, /Fake t/);
		assert.deepStrictEqual(request.arguments, { path: 'a.txt' });
		assert.strictEqual(request.workspace, '/projects/demo');
		assert.match(request.sessionId, /^turn-/);
	});

	test('a secret in the arguments never reaches the gateway', async () => {
		const { provider } = scriptedProvider([
			{ name: 't', args: '{"path":"a.txt","apiKey":"sk-should-not-leak"}', id: 'c1' },
		]);
		const registry = new ToolRegistry();
		const record: RecordedTool = { inputs: [], contexts: [] };
		registry.register(fakeTool('t', record), spec('t'));
		const gateway = new RecordingGateway([ALLOW]);
		const runtime = new ConversationRuntime({
			provider,
			tools: registry,
			permissions: gateway,
			workingDirectory: '/projects/demo',
		});

		await drain(runtime);

		const serialized = JSON.stringify(gateway.requests[0]);
		assert.ok(!serialized.includes('sk-should-not-leak'), 'the key must be redacted');
		assert.ok(serialized.includes(REDACTED));
		// The tool itself still receives the real arguments: redaction is for the
		// request, not for execution.
		assert.deepStrictEqual(record.inputs[0], {
			path: 'a.txt',
			apiKey: 'sk-should-not-leak',
		});
	});

	test('a gateway that throws is reported and the tool stays unrun', async () => {
		const fixture = buildFixture([ALLOW], new Error('policy service down'));

		const events = await drain(fixture.runtime);

		assert.strictEqual(fixture.tool.inputs.length, 0);
		const failed = events.find((e) => e.type === 'ToolCompleted');
		assert.strictEqual((failed as { ok: boolean }).ok, false);
		const resolved = events.find((e) => e.type === 'PermissionResolved');
		assert.strictEqual((resolved as { granted: boolean }).granted, false);
	});

	test('a gateway returning nonsense denies rather than proceeding', async () => {
		const { provider } = scriptedProvider([{ name: 't', args: '{}', id: 'c1' }]);
		const registry = new ToolRegistry();
		const record: RecordedTool = { inputs: [], contexts: [] };
		registry.register(fakeTool('t', record), spec('t'));
		const runtime = new ConversationRuntime({
			provider,
			tools: registry,
			permissions: { ask: async () => ({ decision: 'maybe' }) as unknown as PermissionDecision },
			workingDirectory: '/projects/demo',
		});

		await drain(runtime);

		assert.strictEqual(record.inputs.length, 0, 'an unusable decision is not consent');
	});

	test('aborting while the permission is pending does not run the tool', async () => {
		const { provider } = scriptedProvider([{ name: 't', args: '{}', id: 'c1' }]);
		const registry = new ToolRegistry();
		const record: RecordedTool = { inputs: [], contexts: [] };
		registry.register(fakeTool('t', record), spec('t'));
		const controller = new AbortController();
		const runtime = new ConversationRuntime({
			provider,
			tools: registry,
			// The user closes the dialog by stopping the turn.
			permissions: {
				ask: async (_request, options) => {
					controller.abort();
					assert.ok(options?.signal?.aborted === true, 'the signal reaches the gateway');
					return ALLOW;
				},
			},
			workingDirectory: '/projects/demo',
		});

		const events = await drain(runtime, { signal: controller.signal });

		assert.strictEqual(record.inputs.length, 0, 'the tool was not run after the abort');
		assert.strictEqual(runtime.completion, 'aborted');
		assert.deepStrictEqual(events[events.length - 1], {
			type: 'TurnCompleted',
			reason: 'aborted',
		});
	});

	test('the signal is forwarded to the gateway', async () => {
		const { provider } = scriptedProvider([{ name: 't', args: '{}', id: 'c1' }]);
		const registry = new ToolRegistry();
		const record: RecordedTool = { inputs: [], contexts: [] };
		registry.register(fakeTool('t', record), spec('t'));
		const controller = new AbortController();
		let seen: AbortSignal | undefined;
		const runtime = new ConversationRuntime({
			provider,
			tools: registry,
			permissions: {
				ask: async (_request, options) => {
					seen = options?.signal;
					return ALLOW;
				},
			},
			workingDirectory: '/projects/demo',
		});

		await drain(runtime, { signal: controller.signal });

		assert.strictEqual(seen, controller.signal);
	});

	test('two calls are each decided independently', async () => {
		const { provider } = scriptedProvider([
			{ name: 't', args: '{"n":1}', id: 'call_a' },
			{ name: 't', args: '{"n":2}', id: 'call_b' },
		]);
		const registry = new ToolRegistry();
		const record: RecordedTool = { inputs: [], contexts: [] };
		registry.register(fakeTool('t', record), spec('t'));
		const gateway = new RecordingGateway([ALLOW, DENY]);
		const runtime = new ConversationRuntime({
			provider,
			tools: registry,
			permissions: gateway,
			workingDirectory: '/projects/demo',
		});

		await drain(runtime);

		assert.strictEqual(gateway.requests.length, 2, 'both were asked about');
		assert.strictEqual(record.inputs.length, 1, 'only the allowed one ran');
		assert.deepStrictEqual(record.inputs[0], { n: 1 });
	});

	test('a safe tool still goes through the gateway rather than skipping it', async () => {
		const fixture = buildFixture([ALLOW], undefined, { risk: 'safe' });

		await drain(fixture.runtime);

		assert.strictEqual(
			fixture.gateway.requests.length,
			1,
			'risk is advice to the policy, not a bypass',
		);
	});

	test('the runtime never asks a safe tool twice for one call', async () => {
		const fixture = buildFixture([ALLOW]);

		await drain(fixture.runtime);

		assert.strictEqual(fixture.gateway.requests.length, 1);
	});
});

/** A minimal valid request for gateway-only tests. */
function requestFixture(): PermissionRequest {
	return {
		toolId: 't',
		toolName: 't',
		action: 't',
		description: 'a fake tool',
		riskLevel: 'safe',
		arguments: {},
		sessionId: 'test',
	};
}
