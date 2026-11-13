/**
 * Automatic skill learning: what may become live without a click.
 *
 * The suite is organised around the guarantees, not the functions:
 *
 * - **The gate is narrower than the analyzer.** A pattern worth proposing is
 *   not automatically a pattern worth activating. Only a new skill, built from
 *   read-only tools, with enough evidence and under the cap, passes.
 * - **The path is the real one.** The end-to-end tests file a proposal, record
 *   an `auto` decision and activate it through the evolution service. A test
 *   that wrote the skill directly would prove nothing about what the product
 *   does.
 * - **Nothing is learned while the switch is off.** Off means the transcript is
 *   not even analysed, and the audit file does not grow.
 *
 * Every test runs offline, under plain mocha, in a temporary root removed in
 * `teardown`.
 */
import * as assert from 'assert';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileStorageService } from '../adapters/local/fileStorageService';
import { createFileSkillService } from '../core/skill/fileSkillService';
import {
	DEFAULT_AUTO_SKILL_SETTINGS,
	READ_ONLY_TOOL_IDS,
	evaluateAutoSkill,
	toAutoSkillDraft,
} from '../core/skill/autoSkill';
import { createAutoSkillStore } from '../core/skill/autoSkillStore';
import {
	createAutoSkillService,
	type AutoSkillService,
} from '../core/skill/autoSkillService';
import { createSkillEvolutionStore } from '../core/skill/skillEvolutionStore';
import { createSkillEvolutionService } from '../core/skill/skillEvolutionService';
import { createSkillOpportunityService } from '../core/skill/skillOpportunity';
import type { SkillProposal, ConversationTurn, SkillService } from '../core/skill/types';
import { toAutoSkillStatusView } from '../desktop/autoSkillView';
import { parseAutoSkillStatusView } from '../desktop/contract';

/** One user request followed by the same two read-only calls. */
function readSequence(): readonly ConversationTurn[] {
	return [
		{ role: 'user', content: 'continue' },
		{
			role: 'assistant',
			content: '',
			toolCalls: [
				{ name: 'read_file', arguments: '{"path":"a.ts"}' },
				{ name: 'list_files', arguments: '{}' },
			],
		},
	];
}

/** `count` repetitions of the same read-only procedure. */
function readTurns(count: number): readonly ConversationTurn[] {
	const turns: ConversationTurn[] = [];
	for (let index = 0; index < count; index++) {
		turns.push(...readSequence());
	}
	return turns;
}

/** `count` repetitions of a procedure that writes. */
function writeTurns(count: number): readonly ConversationTurn[] {
	const turns: ConversationTurn[] = [];
	for (let index = 0; index < count; index++) {
		turns.push({ role: 'user', content: 'continue' });
		turns.push({
			role: 'assistant',
			content: '',
			toolCalls: [
				{ name: 'read_file', arguments: '{}' },
				{ name: 'write_file', arguments: '{"path":"a.ts"}' },
			],
		});
	}
	return turns;
}

/** A proposal the gate can be asked about without running the analyzer. */
function proposal(overrides: Partial<SkillProposal> = {}): SkillProposal {
	return {
		id: 'read-file-list-files',
		title: 'Read File List Files',
		objective: 'Ler arquivos e listar o diretório',
		justification: 'A sequência apareceu três vezes.',
		instructions: '# Passos\n1. read_file\n2. list_files',
		tags: ['automatizado', 'sequencia'],
		requiredTools: ['fs.read', 'fs.list'],
		riskLevel: 'safe',
		confidence: 0.6,
		observations: 3,
		...overrides,
	};
}

suite('Automatic skill learning', () => {
	let root: string;
	let storage: FileStorageService;
	let skillService: SkillService;
	let evolution: ReturnType<typeof createSkillEvolutionService>;
	let service: AutoSkillService;
	let idCounter: number;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-auto-skill-'));
		storage = new FileStorageService({ rootPath: root });
		await storage.initialize();
		skillService = createFileSkillService(storage);
		idCounter = 0;
		evolution = createSkillEvolutionService({
			skillService,
			store: createSkillEvolutionStore(storage),
			now: () => '2026-11-12T12:00:00.000Z',
			generateId: () => `prop-${++idCounter}`,
		});
		service = createAutoSkillService({
			skillService,
			evolution,
			store: createAutoSkillStore(storage),
			now: () => '2026-11-12T12:00:00.000Z',
		});
	});

	teardown(async () => {
		await rm(root, { recursive: true, force: true });
	});

	// ── the gate ─────────────────────────────────────────────────────────────

	suite('the gate', () => {
		const context = { autoSkillsCreated: 0 };

		test('a new read-only skill with enough evidence is eligible', () => {
			const decision = evaluateAutoSkill(proposal(), DEFAULT_AUTO_SKILL_SETTINGS, context);
			assert.strictEqual(decision.eligible, true, decision.reason);
		});

		test('off is the first reason, before any other rule', () => {
			const decision = evaluateAutoSkill(
				proposal({ confidence: 0.1, improvesSkillId: 'existing' }),
				{ ...DEFAULT_AUTO_SKILL_SETTINGS, enabled: false },
				context,
			);
			assert.strictEqual(decision.eligible, false);
			assert.match(decision.reason ?? '', /desligado/);
		});

		test('an improvement to an existing skill always needs a person', () => {
			const decision = evaluateAutoSkill(
				proposal({ improvesSkillId: 'code-review' }),
				DEFAULT_AUTO_SKILL_SETTINGS,
				context,
			);
			assert.strictEqual(decision.eligible, false);
			assert.match(decision.reason ?? '', /code-review/);
		});

		test('an empty id is refused, because it is also the filename', () => {
			const decision = evaluateAutoSkill(
				proposal({ id: '   ' }),
				DEFAULT_AUTO_SKILL_SETTINGS,
				context,
			);
			assert.strictEqual(decision.eligible, false);
		});

		test('a skill that already exists is not created again', () => {
			const decision = evaluateAutoSkill(proposal(), DEFAULT_AUTO_SKILL_SETTINGS, {
				autoSkillsCreated: 0,
				existingSkills: [
					{
						id: 'read-file-list-files',
						title: 'Other',
						description: '',
						version: '1.0.0',
						tags: [],
						requiredTools: [],
						instructions: '',
						riskLevel: 'moderate',
						constraints: [],
						createdAt: '',
						updatedAt: '',
					},
				],
			});
			assert.strictEqual(decision.eligible, false);
			assert.match(decision.reason ?? '', /já existe/);
		});

		test('confidence below the floor is refused', () => {
			const decision = evaluateAutoSkill(
				proposal({ confidence: 0.5, observations: 2 }),
				DEFAULT_AUTO_SKILL_SETTINGS,
				context,
			);
			assert.strictEqual(decision.eligible, false);
			assert.match(decision.reason ?? '', /confiança/);
		});

		test('a proposal that names no tool is refused', () => {
			const decision = evaluateAutoSkill(
				proposal({ requiredTools: [] }),
				DEFAULT_AUTO_SKILL_SETTINGS,
				context,
			);
			assert.strictEqual(decision.eligible, false);
		});

		test('a write tool is refused, no matter how often it repeated', () => {
			const decision = evaluateAutoSkill(
				proposal({ requiredTools: ['fs.read', 'fs.write'] }),
				DEFAULT_AUTO_SKILL_SETTINGS,
				context,
			);
			assert.strictEqual(decision.eligible, false);
			assert.match(decision.reason ?? '', /somente-leitura/);
		});

		test('the cap counts what the audit file recorded', () => {
			const decision = evaluateAutoSkill(proposal(), DEFAULT_AUTO_SKILL_SETTINGS, {
				autoSkillsCreated: DEFAULT_AUTO_SKILL_SETTINGS.maxAutoSkills,
			});
			assert.strictEqual(decision.eligible, false);
			assert.match(decision.reason ?? '', /teto/);
		});
	});

	// ── the draft ────────────────────────────────────────────────────────────

	suite('the draft', () => {
		test('never claims safe, and says it was learned automatically', () => {
			const draft = toAutoSkillDraft(proposal(), { conversationId: 'conv-1' });
			assert.strictEqual(draft.proposed.riskLevel, 'moderate');
			assert.ok(draft.proposed.tags.includes('auto'));
			assert.ok(
				draft.proposed.constraints?.some((constraint) => /automaticamente/.test(constraint)),
			);
			assert.strictEqual(draft.createsNewSkill, true);
			assert.strictEqual(draft.newSkillId, 'read-file-list-files');
			assert.strictEqual(draft.opportunity.skillId, undefined);
			assert.deepStrictEqual(draft.opportunity.supportingRuns, ['conversation-conv-1']);
			assert.ok(draft.opportunity.sampleSize >= 3);
		});

		test('keeps a dangerous proposal dangerous rather than lowering it', () => {
			const draft = toAutoSkillDraft(
				proposal({ riskLevel: 'dangerous', requiredTools: ['fs.read'] }),
				{ conversationId: 'conv-1' },
			);
			assert.strictEqual(draft.proposed.riskLevel, 'dangerous');
		});
	});

	// ── confidence is evidence, not a constant ───────────────────────────────

	suite('confidence', () => {
		test('rises with the number of observations', async () => {
			const analyzer = createSkillOpportunityService();
			const cases: readonly (readonly [number, number])[] = [
				[2, 0.5],
				[3, 0.6],
				[5, 0.7],
				[9, 0.85],
			];
			for (const [observations, expected] of cases) {
				const result = await analyzer.analyze({
					recentTurns: readTurns(observations),
					maxTurns: 100,
					availableTools: ['fs.read', 'fs.list'],
				});
				assert.strictEqual(result.ok, true, result.error);
				const found = result.proposals.find((entry) => entry.id === 'read-file-list-files');
				assert.ok(found !== undefined, `no proposal for ${observations} observations`);
				assert.strictEqual(found.confidence, expected, `${observations} observations`);
				assert.strictEqual(found.observations, observations);
			}
		});
	});

	// ── the real path ────────────────────────────────────────────────────────

	suite('learning from a finished turn', () => {
		test('files, approves and activates a new skill through the evolution service', async () => {
			const result = await service.learn({
				conversationId: 'conv-1',
				turns: readTurns(3),
				availableToolIds: ['read_file', 'list_files', 'read_skill'],
			});

			assert.strictEqual(result.error, undefined, result.error);
			assert.strictEqual(result.learned.length, 1, JSON.stringify(result.skipped));
			const learned = result.learned[0]!;
			assert.strictEqual(learned.id, 'read-file-list-files');
			// The proposal id names a file; a colon would make Windows refuse it.
			assert.doesNotMatch(learned.proposalId, /:/);

			const skill = await skillService.getSkill(learned.id);
			assert.ok(skill !== undefined);
			assert.ok(skill.tags.includes('auto'));
			assert.notStrictEqual(skill.riskLevel, 'safe');
			assert.deepStrictEqual([...skill.requiredTools].sort(), ['fs.list', 'fs.read']);

			const proposals = await evolution.listProposals();
			const stored = proposals.proposals.find((entry) => entry.id === learned.proposalId);
			assert.ok(stored !== undefined);
			assert.strictEqual(stored.status, 'activated');
			assert.strictEqual(stored.decision?.decidedBy, 'auto');
			assert.strictEqual(stored.createsNewSkill, true);
			assert.strictEqual(stored.skillId, learned.id);

			const status = await service.status();
			assert.strictEqual(status.learned.length, 1);
			assert.strictEqual(status.learned[0]!.skillId, learned.id);
			assert.strictEqual(status.learned[0]!.conversationId, 'conv-1');
			assert.strictEqual(status.learned[0]!.observations, 3);

			const raw = await readFile(
				join(root, 'skills', '_evolution', 'auto-skills.json'),
				'utf8',
			);
			const file = JSON.parse(raw) as { enabled: boolean; learned: unknown[] };
			assert.strictEqual(file.enabled, true);
			assert.strictEqual(file.learned.length, 1);
		});

		test('off writes nothing and does not even analyse', async () => {
			await service.setEnabled(false);
			const result = await service.learn({
				conversationId: 'conv-1',
				turns: readTurns(3),
				availableToolIds: ['read_file', 'list_files'],
			});
			assert.deepStrictEqual([...result.learned], []);
			assert.deepStrictEqual([...result.skipped], []);
			const skills = await skillService.listSkills();
			assert.strictEqual(skills.skills.length, 0);
			const status = await service.status();
			assert.strictEqual(status.settings.enabled, false);
			assert.strictEqual(status.learned.length, 0);
		});

		test('a write procedure is proposed by the analyzer and refused by the gate', async () => {
			const result = await service.learn({
				conversationId: 'conv-1',
				turns: writeTurns(3),
				availableToolIds: ['read_file', 'write_file'],
			});
			assert.strictEqual(result.learned.length, 0);
			assert.ok(result.skipped.length > 0);
			assert.match(result.skipped[0]!.reason, /somente-leitura/);
			const skills = await skillService.listSkills();
			assert.strictEqual(skills.skills.length, 0);
		});

		test('an improvement to an existing skill is skipped, not activated', async () => {
			await skillService.createSkill({
				id: 'existing-reader',
				title: 'Existing Reader',
				description: 'Já existe',
				instructions: '# Existing\n\n1. Leia arquivos.',
				tags: ['manual'],
				requiredTools: ['fs.read'],
				riskLevel: 'moderate',
				constraints: [],
			});
			const result = await service.learn({
				conversationId: 'conv-1',
				turns: readTurns(3),
				availableToolIds: ['read_file', 'list_files'],
			});
			assert.strictEqual(result.learned.length, 0);
			assert.ok(result.skipped.some((skip) => /melhorias continuam exigindo/.test(skip.reason)));
			const proposals = await evolution.listProposals();
			assert.strictEqual(proposals.proposals.length, 0);
		});

		test('the cap comes from the audit file, not from memory', async () => {
			const learned = Array.from({ length: DEFAULT_AUTO_SKILL_SETTINGS.maxAutoSkills }, (_, index) => ({
				skillId: `seed-${index}`,
				proposalId: `seed-prop-${index}`,
				title: `Seed ${index}`,
				conversationId: 'conv-0',
				observations: 3,
				confidence: 0.6,
				learnedAt: '2026-11-12T11:00:00.000Z',
				tools: ['fs.read'],
			}));
			await storage.write(
				'skills/_evolution/auto-skills.json',
				JSON.stringify({ version: 1, enabled: true, learned }),
			);

			const result = await service.learn({
				conversationId: 'conv-1',
				turns: readTurns(3),
				availableToolIds: ['read_file', 'list_files'],
			});
			assert.strictEqual(result.learned.length, 0);
			assert.ok(result.skipped.some((skip) => /teto/.test(skip.reason)));
			const status = await service.status();
			assert.strictEqual(status.learned.length, DEFAULT_AUTO_SKILL_SETTINGS.maxAutoSkills);
		});

		test('the audit file is repaired when it is corrupt', async () => {
			await storage.write('skills/_evolution/auto-skills.json', '{ not json');
			const status = await service.status();
			assert.strictEqual(status.settings.enabled, true);
			assert.deepStrictEqual([...status.learned], []);

			const result = await service.learn({
				conversationId: 'conv-1',
				turns: readTurns(3),
				availableToolIds: ['read_file', 'list_files'],
			});
			assert.strictEqual(result.learned.length, 1);
			const raw = await readFile(
				join(root, 'skills', '_evolution', 'auto-skills.json'),
				'utf8',
			);
			const file = JSON.parse(raw) as { learned: unknown[] };
			assert.strictEqual(file.learned.length, 1);
		});
	});

	// ── the allowlist itself ─────────────────────────────────────────────────

	test('the read-only allowlist names no write, command or delete tool', () => {
		for (const tool of READ_ONLY_TOOL_IDS) {
			assert.doesNotMatch(tool, /write|modify|delete|execute|terminal|commit/i, tool);
		}
	});

	// ── the bridge boundary ──────────────────────────────────────────────────

	test('the service status is flattened into the shape the preload validates', () => {
		const view = toAutoSkillStatusView({
			settings: { ...DEFAULT_AUTO_SKILL_SETTINGS, enabled: false },
			learned: [
				{
					skillId: 'read-skill',
					proposalId: 'prop-1',
					title: 'Read Skill',
					conversationId: 'conv-1',
					observations: 3,
					confidence: 0.6,
					learnedAt: '2026-11-12T12:00:00.000Z',
					tools: ['skill.read'],
				},
			],
		});
		assert.strictEqual(view.enabled, false);
		assert.strictEqual(view.minConfidence, 0.6);
		assert.strictEqual(view.maxAutoSkills, 10);
		assert.deepStrictEqual([...view.allowedTools], [...READ_ONLY_TOOL_IDS]);

		// The parser the preload uses is the regression: the nested status used
		// to reach it and was refused for having no boolean `enabled`.
		const parsed = parseAutoSkillStatusView(view);
		assert.strictEqual(parsed.enabled, false);
		assert.strictEqual(parsed.learned.length, 1);
		assert.strictEqual(parsed.learned[0]!.skillId, 'read-skill');
		assert.deepStrictEqual([...parsed.learned[0]!.tools], ['skill.read']);
	});
});
