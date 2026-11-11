/**
 * analyze_skill_opportunities: the tool reads the real conversation.
 *
 * The tool used to return `{"proposals":[]}` unconditionally — a stub that
 * looked like a working analysis. These tests pin the two halves that make it
 * real:
 *
 * - the service is fed the turns and produces proposals from them;
 * - the runtime hands the transcript to the tool through
 *   `ToolExecutionContext.conversationTurns`, including the assistant call
 *   that is running it.
 *
 * Every test is offline: no model, no network, temporary storage only.
 */
import * as assert from 'assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileStorageService } from '../adapters/local/fileStorageService';
import { createFileSkillService } from '../core/skill/fileSkillService';
import { createSkillTools } from '../core/agent/skillTools';
import { ConversationRuntime } from '../core/agent/runtime';
import { ToolRegistry } from '../core/agent/toolRegistry';
import { SKILL_TOOL_SPECS } from '../core/agent/skillTools';
import type { ToolConversationTurn } from '../core/agent/types';
import type { ChatProvider, ChatStream, ChatStreamEvent } from '../core/providers/chat/types';
import type { ConversationTurn, SkillService } from '../core/skill/types';

/** The two user turns ask the same thing and the assistant reads a file. */
const REPEATED_INTENT_TURNS: readonly ConversationTurn[] = [
	{ role: 'user', content: 'revise o código' },
	{
		role: 'assistant',
		content: '',
		toolCalls: [{ name: 'read_file', arguments: '{"path":"a.ts"}' }],
	},
	{ role: 'user', content: 'revise o código de novo' },
	{
		role: 'assistant',
		content: '',
		toolCalls: [{ name: 'read_file', arguments: '{"path":"b.ts"}' }],
	},
];

/** A provider that calls the analyze tool once, then answers. */
class CallsAnalyzeOnce implements ChatProvider {
	private calls = 0;

	async streamChat(): Promise<ChatStream> {
		this.calls += 1;
		const script: ChatStreamEvent[] =
			this.calls === 1
				? [
						{
							type: 'ToolCallDelta',
							call: { id: 'c1', name: 'analyze_skill_opportunities', arguments: '{}' },
						},
						{ type: 'Done' },
					]
				: [{ type: 'TextDelta', text: 'ok' }, { type: 'Done' }];
		return {
			closedReason: 'completed',
			timing: {},
			[Symbol.asyncIterator]: async function* () {
				yield* script;
			},
		};
	}
}

const ALLOW = { ask: async () => ({ decision: 'allow' as const }) };

suite('Skill opportunity tool', () => {
	let root: string;
	let storage: FileStorageService;
	let skillService: SkillService;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-opportunity-tool-'));
		storage = new FileStorageService({ rootPath: root });
		await storage.initialize();
		skillService = createFileSkillService(storage);
	});

	teardown(async () => {
		await rm(root, { recursive: true, force: true });
	});

	function analyzeTool() {
		const tool = createSkillTools(skillService).find(
			(candidate) => candidate.descriptor.id === 'analyze_skill_opportunities',
		);
		assert.ok(tool !== undefined, 'the analyze tool is registered');
		return tool!;
	}

	test('returns real proposals from the turns instead of an empty stub', async () => {
		const result = await analyzeTool().execute(
			{},
			{ sessionId: 'test', conversationTurns: REPEATED_INTENT_TURNS },
		);

		assert.strictEqual(result.ok, true);
		const proposals = (result.output as { proposals: { id: string; requiredTools: string[] }[] })
			.proposals;
		assert.ok(proposals.length > 0, 'a repeated request produced at least one proposal');
		// The intent path names the proposal after what the user asked twice.
		const repeated = proposals.find((proposal) => proposal.id === 'revisar');
		assert.ok(repeated !== undefined, 'the repeated intent is proposed');
		// And it speaks in tool IDs the product actually has.
		assert.ok(repeated!.requiredTools.includes('fs.read'));
	});

	test('does not claim "nothing found" when there is no transcript to read', async () => {
		const result = await analyzeTool().execute({}, { sessionId: 'test' });

		assert.strictEqual(result.ok, false, 'no transcript is a failure, not an empty answer');
		assert.match(String(result.error), /No conversation is available/);
	});

	test('a repeated skill-tool sequence proposes the skill.read id', async () => {
		// The service maps the call name `read_skill` to the skill-tool id
		// `skill.read`. Before the catalog carried that id, the proposal was
		// built and then discarded for naming a tool that "did not exist".
		const turns: readonly ConversationTurn[] = [
			{ role: 'user', content: 'leia a skill teste' },
			{
				role: 'assistant',
				content: '',
				toolCalls: [{ name: 'read_skill', arguments: '{}' }],
			},
			{ role: 'user', content: 'leia de novo' },
			{
				role: 'assistant',
				content: '',
				toolCalls: [{ name: 'read_skill', arguments: '{}' }],
			},
		];

		const result = await analyzeTool().execute(
			{},
			{ sessionId: 'test', conversationTurns: turns },
		);

		assert.strictEqual(result.ok, true);
		const proposals = (
			result.output as { proposals: { id: string; requiredTools: string[] }[] }
		).proposals;
		const sequence = proposals.find((proposal) => proposal.id === 'read-skill');
		assert.ok(sequence !== undefined, 'the repeated tool sequence is proposed');
		assert.deepStrictEqual(sequence!.requiredTools, ['skill.read']);
	});

	test('an existing skill id suppresses its proposal', async () => {
		await skillService.createSkill({
			id: 'revisar',
			title: 'Revisar',
			description: 'Revisão de código.',
			instructions: 'Leia o diff e aponte problemas.',
		});

		const result = await analyzeTool().execute(
			{},
			{ sessionId: 'test', conversationTurns: REPEATED_INTENT_TURNS },
		);

		assert.strictEqual(result.ok, true);
		const proposals = (result.output as { proposals: { id: string }[] }).proposals;
		assert.ok(
			!proposals.some((proposal) => proposal.id === 'revisar'),
			'a skill that already exists is not proposed again',
		);
	});

	test('the runtime hands the live transcript to the tool', async () => {
		let seen: readonly ToolConversationTurn[] | undefined;
		const tool = analyzeTool();
		const wrapped = {
			...tool,
			execute: async (input: unknown, context: Parameters<typeof tool.execute>[1]) => {
				seen = context.conversationTurns;
				return tool.execute(input, context);
			},
		};

		const registry = new ToolRegistry();
		const spec = SKILL_TOOL_SPECS.find(
			(candidate) => candidate.name === 'analyze_skill_opportunities',
		);
		assert.ok(spec !== undefined);
		registry.register(wrapped, spec!);

		const runtime = new ConversationRuntime({
			provider: new CallsAnalyzeOnce(),
			tools: registry,
			permissions: ALLOW,
			sessionId: 'turn-1',
		});

		for await (const _event of runtime.run({
			messages: [{ role: 'user', content: 'revise o código' }],
		})) {
			// Drain the turn; the assertion is on what the tool received.
		}

		assert.ok(seen !== undefined, 'the tool received a transcript');
		// The user's message and the assistant call that is running the tool.
		assert.strictEqual(seen!.length, 2);
		assert.deepStrictEqual(seen![0], { role: 'user', content: 'revise o código' });
		assert.strictEqual(seen![1].role, 'assistant');
		assert.deepStrictEqual(
			seen![1].toolCalls?.map((call) => call.name),
			['analyze_skill_opportunities'],
		);
	});
});
