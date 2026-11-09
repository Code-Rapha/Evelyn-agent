/**
 * Tests for SkillOpportunityService
 */
import { strict as assert } from 'node:assert';
import { test, suite, setup } from 'mocha';
import { createSkillOpportunityService } from '../core/skill/skillOpportunity';
import type { ConversationTurn, SkillOpportunityInput } from '../core/skill/types';

suite('Skill Opportunity', () => {
	let service: ReturnType<typeof createSkillOpportunityService>;

	setup(() => {
		service = createSkillOpportunityService();
	});

	function makeTurns(turns: Array<{ role: 'user' | 'assistant'; content: string; toolCalls?: Array<{ name: string; arguments: string }> }>): ConversationTurn[] {
		return turns.map((t) => ({
			role: t.role,
			content: t.content,
			toolCalls: t.toolCalls?.map((c) => ({ name: c.name, arguments: c.arguments })),
			toolResults: undefined,
		}));
	}

	test('analyze returns empty proposals for empty conversation', async () => {
		const input: SkillOpportunityInput = {
			recentTurns: [],
			availableTools: ['fs.read', 'fs.write'],
			existingSkillIds: [],
		};

		const result = await service.analyze(input);

		assert.strictEqual(result.ok, true);
		assert.deepStrictEqual(result.proposals, []);
	});

	test('analyze detects recurring tool sequence', async () => {
		const turns = makeTurns([
			{ role: 'user', content: 'Crie um arquivo' },
			{ role: 'assistant', content: 'Criando...', toolCalls: [{ name: 'write_file', arguments: '{}' }] },
			{ role: 'user', content: 'Ok' },
			{ role: 'user', content: 'Crie outro arquivo' },
			{ role: 'assistant', content: 'Criando...', toolCalls: [{ name: 'write_file', arguments: '{}' }] },
			{ role: 'user', content: 'Pronto' },
		]);

		const input: SkillOpportunityInput = {
			recentTurns: turns,
			availableTools: ['fs.read', 'fs.write', 'fs.modify'],
			existingSkillIds: [],
		};

		const result = await service.analyze(input);

		assert.strictEqual(result.ok, true);
		assert.ok(result.proposals.length > 0, 'Should find at least one proposal');
		const proposal = result.proposals[0];
		assert.ok(proposal.id.includes('write') || proposal.id.includes('file'));
		assert.ok(proposal.requiredTools.includes('fs.write'));
		assert.strictEqual(proposal.improvesSkillId, undefined);
	});

	test('analyze detects recurring user intent', async () => {
		const turns = makeTurns([
			{ role: 'user', content: 'Crie um componente React' },
			{ role: 'assistant', content: 'Criando...', toolCalls: [{ name: 'write_file', arguments: '{}' }, { name: 'run_test', arguments: '{}' }] },
			{ role: 'user', content: 'Ok' },
			{ role: 'user', content: 'Crie outro componente React' },
			{ role: 'assistant', content: 'Criando...', toolCalls: [{ name: 'write_file', arguments: '{}' }, { name: 'run_test', arguments: '{}' }] },
			{ role: 'user', content: 'Pronto' },
		]);

		const input: SkillOpportunityInput = {
			recentTurns: turns,
			availableTools: ['fs.read', 'fs.write', 'test.run'],
			existingSkillIds: [],
		};

		const result = await service.analyze(input);

		assert.strictEqual(result.ok, true);
		assert.ok(result.proposals.length > 0, 'Should find at least one proposal');
		// Should have a proposal related to "criar componente" or similar
		const hasRelevantProposal = result.proposals.some((p) =>
			p.title.toLowerCase().includes('criar') ||
			p.title.toLowerCase().includes('componente') ||
			p.objective.toLowerCase().includes('componente')
		);
		assert.ok(hasRelevantProposal, 'Should have proposal related to user intent');
	});

	test('analyze respects maxProposals limit', async () => {
		const turns = makeTurns([
			{ role: 'user', content: 'Tarefa A' },
			{ role: 'assistant', content: '...', toolCalls: [{ name: 'write_file', arguments: '{}' }] },
			{ role: 'user', content: 'Ok' },
			{ role: 'user', content: 'Tarefa B' },
			{ role: 'assistant', content: '...', toolCalls: [{ name: 'write_file', arguments: '{}' }] },
			{ role: 'user', content: 'Ok' },
			{ role: 'user', content: 'Tarefa C' },
			{ role: 'assistant', content: '...', toolCalls: [{ name: 'write_file', arguments: '{}' }] },
			{ role: 'user', content: 'Ok' },
			{ role: 'user', content: 'Tarefa D' },
			{ role: 'assistant', content: '...', toolCalls: [{ name: 'write_file', arguments: '{}' }] },
			{ role: 'user', content: 'Ok' },
		]);

		const input: SkillOpportunityInput = {
			recentTurns: turns,
			availableTools: ['fs.read', 'fs.write'],
			existingSkillIds: [],
			maxProposals: 2,
		};

		const result = await service.analyze(input);

		assert.strictEqual(result.ok, true);
		assert.ok(result.proposals.length <= 2);
	});

	test('analyze excludes existing skill IDs', async () => {
		const turns = makeTurns([
			{ role: 'user', content: 'Crie arquivo' },
			{ role: 'assistant', content: '...', toolCalls: [{ name: 'write_file', arguments: '{}' }] },
			{ role: 'user', content: 'Ok' },
			{ role: 'user', content: 'Crie arquivo' },
			{ role: 'assistant', content: '...', toolCalls: [{ name: 'write_file', arguments: '{}' }] },
			{ role: 'user', content: 'Ok' },
		]);

		const input: SkillOpportunityInput = {
			recentTurns: turns,
			availableTools: ['fs.read', 'fs.write'],
			existingSkillIds: ['create-file-sequence'], // This would match the slugified sequence
		};

		const result = await service.analyze(input);

		assert.strictEqual(result.ok, true);
		// The proposal with ID matching existingSkillIds should be excluded
		const hasExcluded = result.proposals.some((p) => p.id === 'create-file-sequence');
		assert.strictEqual(hasExcluded, false);
	});

	test('analyze returns proposals sorted by confidence', async () => {
		const turns = makeTurns([
			{ role: 'user', content: 'Tarefa repetida' },
			{ role: 'assistant', content: '...', toolCalls: [{ name: 'write_file', arguments: '{}' }] },
			{ role: 'user', content: 'Ok' },
			{ role: 'user', content: 'Tarefa repetida' },
			{ role: 'assistant', content: '...', toolCalls: [{ name: 'write_file', arguments: '{}' }] },
			{ role: 'user', content: 'Ok' },
			{ role: 'user', content: 'Outra tarefa repetida' },
			{ role: 'assistant', content: '...', toolCalls: [{ name: 'write_file', arguments: '{}' }] },
			{ role: 'user', content: 'Ok' },
			{ role: 'user', content: 'Outra tarefa repetida' },
			{ role: 'assistant', content: '...', toolCalls: [{ name: 'write_file', arguments: '{}' }] },
			{ role: 'user', content: 'Ok' },
		]);

		const input: SkillOpportunityInput = {
			recentTurns: turns,
			availableTools: ['fs.read', 'fs.write'],
			existingSkillIds: [],
		};

		const result = await service.analyze(input);

		assert.strictEqual(result.ok, true);
		if (result.proposals.length > 1) {
			for (let i = 0; i < result.proposals.length - 1; i++) {
				assert.ok(
					result.proposals[i].confidence >= result.proposals[i + 1].confidence,
					'Proposals should be sorted by confidence descending'
				);
			}
		}
	});

	test('analyze only considers available tools', async () => {
		const turns = makeTurns([
			{ role: 'user', content: 'Crie arquivo' },
			{ role: 'assistant', content: '...', toolCalls: [{ name: 'run_command', arguments: '{}' }] },
			{ role: 'user', content: 'Ok' },
			{ role: 'user', content: 'Crie arquivo' },
			{ role: 'assistant', content: '...', toolCalls: [{ name: 'run_command', arguments: '{}' }] },
			{ role: 'user', content: 'Ok' },
		]);

		const input: SkillOpportunityInput = {
			recentTurns: turns,
			availableTools: ['fs.read', 'fs.write'], // terminal.execute not available
			existingSkillIds: [],
		};

		const result = await service.analyze(input);

		assert.strictEqual(result.ok, true);
		// Should not propose a skill requiring terminal.execute since it's not available
		for (const proposal of result.proposals) {
			for (const tool of proposal.requiredTools) {
				assert.ok(input.availableTools!.includes(tool), `Proposal requires unavailable tool: ${tool}`);
			}
		}
	});

	test('analyze handles single turn without tool calls', async () => {
		const turns = makeTurns([
			{ role: 'user', content: 'Olá, como vai?' },
		]);

		const input: SkillOpportunityInput = {
			recentTurns: turns,
			availableTools: ['fs.read', 'fs.write'],
			existingSkillIds: [],
		};

		const result = await service.analyze(input);

		assert.strictEqual(result.ok, true);
		assert.deepStrictEqual(result.proposals, []);
	});

	test('analyze only looks at recent turns up to maxTurns', async () => {
		const manyTurns = makeTurns([
			{ role: 'user', content: 'Antiga' },
			{ role: 'assistant', content: '...', toolCalls: [{ name: 'write_file', arguments: '{}' }] },
			{ role: 'user', content: 'Ok' },
			{ role: 'user', content: 'Nova' },
			{ role: 'assistant', content: '...', toolCalls: [{ name: 'write_file', arguments: '{}' }] },
			{ role: 'user', content: 'Ok' },
			{ role: 'user', content: 'Nova' },
			{ role: 'assistant', content: '...', toolCalls: [{ name: 'write_file', arguments: '{}' }] },
			{ role: 'user', content: 'Ok' },
		]);

		const input: SkillOpportunityInput = {
			recentTurns: manyTurns,
			availableTools: ['fs.read', 'fs.write'],
			existingSkillIds: [],
			maxTurns: 3, // Should only look at last 3 turns
		};

		const result = await service.analyze(input);

		assert.strictEqual(result.ok, true);
		// With maxTurns=3, only the last user+assistant pair is seen, not enough for recurrence
		assert.deepStrictEqual(result.proposals, []);
	});
});