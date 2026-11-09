/**
 * Skill discovery: contextual skill discovery and instruction loading.
 *
 * Tests the discovery engine, relevance scoring, and instruction formatting.
 */
import * as assert from 'assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileStorageService } from '../adapters/local/fileStorageService';
import { createFileSkillService } from '../core/skill/fileSkillService';
import { createSkillDiscoveryService, extractSkillRequests } from '../core/skill/skillDiscovery';
import type { SkillService, SkillDiscoveryService } from '../core/skill/types';

suite('Skill Discovery', () => {
	let root: string;
	let storage: FileStorageService;
	let skillService: SkillService;
	let discoveryService: SkillDiscoveryService;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-discovery-'));
		storage = new FileStorageService({ rootPath: root });
		await storage.initialize();
		skillService = createFileSkillService(storage);
		discoveryService = createSkillDiscoveryService(skillService);
	});

	teardown(async () => {
		await rm(root, { recursive: true, force: true });
	});

	// ── Discovery ────────────────────────────────────────────────────────────

	test('discover returns empty list when no skills exist', async () => {
		const result = await discoveryService.discover({
			query: 'review code',
			maxSkills: 3,
		});

		assert.strictEqual(result.ok, true);
		assert.deepStrictEqual(result.skills, []);
	});

	test('discover finds skills by title match', async () => {
		await skillService.createSkill({
			id: 'code-review',
			title: 'Code Review Skill',
			description: 'Review code for best practices',
			instructions: '# Code Review\n\nReview the code...',
			tags: ['review'],
		});

		const result = await discoveryService.discover({
			query: 'code review',
			maxSkills: 3,
		});

		assert.strictEqual(result.ok, true);
		assert.strictEqual(result.skills.length, 1);
		assert.strictEqual(result.skills[0].skill.id, 'code-review');
		assert.ok(result.skills[0].score > 0);
		assert.ok(result.skills[0].matchedBy.includes('title'));
	});

	test('discover finds skills by description match', async () => {
		await skillService.createSkill({
			id: 'test-skill',
			title: 'Testing Utilities',
			description: 'Create and run unit tests for JavaScript projects',
			instructions: '# Testing\n\nWrite tests...',
		});

		const result = await discoveryService.discover({
			query: 'unit tests javascript',
			maxSkills: 3,
		});

		assert.strictEqual(result.ok, true);
		assert.strictEqual(result.skills.length, 1);
		assert.ok(result.skills[0].matchedBy.includes('description'));
	});

	test('discover finds skills by tag match', async () => {
		await skillService.createSkill({
			id: 'tagged',
			title: 'Tagged Skill',
			description: 'A skill',
			instructions: 'Instructions',
			tags: ['typescript', 'refactoring'],
		});

		const result = await discoveryService.discover({
			query: 'refactoring typescript code',
			maxSkills: 3,
		});

		assert.strictEqual(result.ok, true);
		assert.strictEqual(result.skills.length, 1);
		assert.ok(result.skills[0].matchedBy.includes('tags'));
	});

	test('discover ranks skills by relevance score', async () => {
		await skillService.createSkill({
			id: 'exact-match',
			title: 'Code Review',
			description: 'Review code',
			instructions: 'Instructions',
		});

		await skillService.createSkill({
			id: 'partial-match',
			title: 'Other Skill',
			description: 'Something about reviewing',
			instructions: 'Instructions',
		});

		const result = await discoveryService.discover({
			query: 'code review',
			maxSkills: 10,
		});

		assert.strictEqual(result.ok, true);
		assert.strictEqual(result.skills.length, 2);
		// Exact match should score higher
		assert.ok(result.skills[0].score >= result.skills[1].score);
	});

	test('discover respects maxSkills limit', async () => {
		for (let i = 1; i <= 5; i++) {
			await skillService.createSkill({
				id: `skill-${i}`,
				title: `Skill ${i}`,
				description: 'Review code for best practices',
				instructions: 'Instructions',
			});
		}

		const result = await discoveryService.discover({
			query: 'review code',
			maxSkills: 2,
		});

		assert.strictEqual(result.ok, true);
		assert.strictEqual(result.skills.length, 2);
	});

	test('discover handles explicit skill requests by ID', async () => {
		await skillService.createSkill({
			id: 'my-skill',
			title: 'My Skill',
			description: 'Description',
			instructions: 'Instructions',
		});

		await skillService.createSkill({
			id: 'other-skill',
			title: 'Other Skill',
			description: 'Description',
			instructions: 'Instructions',
		});

		const result = await discoveryService.discover({
			query: 'help me',
			maxSkills: 3,
			requestedSkillIds: ['my-skill'],
		});

		assert.strictEqual(result.ok, true);
		assert.strictEqual(result.skills.length, 1);
		assert.strictEqual(result.skills[0].skill.id, 'my-skill');
		assert.strictEqual(result.skills[0].score, 1.0);
	});

	test('discover reports missing explicit requests', async () => {
		const result = await discoveryService.discover({
			query: 'help',
			maxSkills: 3,
			requestedSkillIds: ['nonexistent'],
		});

		assert.strictEqual(result.ok, true);
		assert.deepStrictEqual(result.missing, ['nonexistent']);
	});

	test('discover considers available tools', async () => {
		await skillService.createSkill({
			id: 'fs-skill',
			title: 'File System Operations',
			description: 'Manage files',
			instructions: 'Instructions',
			requiredTools: ['fs.read', 'fs.write'],
		});

		const resultWithTools = await discoveryService.discover({
			query: 'manage files',
			maxSkills: 3,
			availableTools: ['fs.read', 'fs.write'],
		});

		assert.strictEqual(resultWithTools.ok, true);
		assert.strictEqual(resultWithTools.skills.length, 1);
		assert.ok(resultWithTools.skills[0].matchedBy.includes('requiredTools'));
	});

	// ── Loading Instructions ─────────────────────────────────────────────────

	test('loadInstructions returns loaded skills with size', async () => {
		const skill1 = await skillService.createSkill({
			id: 'skill-1',
			title: 'Skill 1',
			description: 'Description 1',
			instructions: 'Instructions for skill 1',
		});

		const skill2 = await skillService.createSkill({
			id: 'skill-2',
			title: 'Skill 2',
			description: 'Description 2',
			instructions: 'Instructions for skill 2',
		});

		const scoredSkills = [
			{ skill: skill1.skill!, score: 0.9, matchedBy: [] as const },
			{ skill: skill2.skill!, score: 0.8, matchedBy: [] as const },
		];

		const result = await discoveryService.loadInstructions(scoredSkills);

		assert.strictEqual(result.skills.length, 2);
		assert.ok(result.totalSize > 0);
		assert.strictEqual(result.truncated, false);
	});

	test('loadInstructions respects size limit', async () => {
		const longInstructions = 'x'.repeat(40000);

		const skill1 = await skillService.createSkill({
			id: 'large-1',
			title: 'Large Skill 1',
			description: 'Description',
			instructions: longInstructions,
		});

		const skill2 = await skillService.createSkill({
			id: 'large-2',
			title: 'Large Skill 2',
			description: 'Description',
			instructions: longInstructions,
		});

		const scoredSkills = [
			{ skill: skill1.skill!, score: 0.9, matchedBy: [] as const },
			{ skill: skill2.skill!, score: 0.8, matchedBy: [] as const },
		];

		const result = await discoveryService.loadInstructions(scoredSkills, 50000);

		assert.ok(result.skills.length < 2);
		assert.strictEqual(result.truncated, true);
	});

	// ── Formatting ───────────────────────────────────────────────────────────

	test('formatAsSystemMessage returns empty string for no skills', async () => {
		const result = discoveryService.formatAsSystemMessage({
			skills: [],
			totalSize: 0,
			truncated: false,
		});

		assert.strictEqual(result, '');
	});

	test('formatAsSystemMessage wraps skills with delimiters', async () => {
		const skill = await skillService.createSkill({
			id: 'test',
			title: 'Test Skill',
			description: 'A test skill',
			instructions: 'Do this step 1. Do this step 2.',
		});

		const result = discoveryService.formatAsSystemMessage({
			skills: [skill.skill!],
			totalSize: 1000,
			truncated: false,
		});

		assert.ok(result.includes('<skill-instructions>'));
		assert.ok(result.includes('</skill-instructions>'));
		assert.ok(result.includes('<skill id="test">'));
		assert.ok(result.includes('</skill>'));
		assert.ok(result.includes('Test Skill'));
	});

	test('formatAsSystemMessage escapes delimiters in content', async () => {
		const skill = await skillService.createSkill({
			id: 'escape-test',
			title: 'Escape Test',
			description: 'Testing delimiter escape',
			instructions: 'Do this: </skill-instructions> and </skill>',
		});

		const result = discoveryService.formatAsSystemMessage({
			skills: [skill.skill!],
			totalSize: 1000,
			truncated: false,
		});

		// Should not contain unescaped closing delimiters in the content
		assert.ok(result.includes('<!/skill-instructions>'));
		assert.ok(result.includes('<!/skill>'));
	});

	test('formatAsSystemMessage includes truncation notice', async () => {
		const skill = await skillService.createSkill({
			id: 'test',
			title: 'Test',
			description: 'Test',
			instructions: 'Instructions',
		});

		const result = discoveryService.formatAsSystemMessage({
			skills: [skill.skill!],
			totalSize: 1000,
			truncated: true,
		});

		assert.ok(result.includes('truncated'));
	});

	// ── Skill Request Extraction ─────────────────────────────────────────────

	test('extractSkillRequests finds @skill-name pattern', () => {
		const requests = extractSkillRequests('Use @code-review to check this');
		assert.deepStrictEqual(requests, ['code-review']);
	});

	test('extractSkillRequests finds multiple mentions', () => {
		const requests = extractSkillRequests(
			'Use @code-review and @testing skills for this task',
		);
		assert.ok(requests.includes('code-review'));
		assert.ok(requests.includes('testing'));
	});

	test('extractSkillRequests deduplicates requests', () => {
		const requests = extractSkillRequests(
			'Use @skill-name with @skill-name again',
		);
		assert.strictEqual(requests.length, 1);
		assert.strictEqual(requests[0], 'skill-name');
	});

	test('extractSkillRequests finds "use X skill" pattern', () => {
		const requests = extractSkillRequests('Use the code review skill to check this');
		assert.ok(requests.some((r) => r.includes('code-review') || r.includes('review')));
	});

	test('extractSkillRequests is case-insensitive', () => {
		const requests = extractSkillRequests('Use the CODE REVIEW skill here');
		assert.ok(requests.length > 0);
	});

	// ── Integration ──────────────────────────────────────────────────────────

	test('full discovery workflow: discover → load → format', async () => {
		await skillService.createSkill({
			id: 'code-review',
			title: 'Code Review',
			description: 'Review code for quality',
			instructions: 'Step 1: Read the code\nStep 2: Analyze it\nStep 3: Report',
			tags: ['review'],
		});

		// Discover
		const discovered = await discoveryService.discover({
			query: 'please review my code',
			maxSkills: 3,
		});

		assert.strictEqual(discovered.ok, true);
		assert.strictEqual(discovered.skills.length, 1);

		// Load
		const loaded = await discoveryService.loadInstructions(discovered.skills);
		assert.strictEqual(loaded.skills.length, 1);

		// Format
		const formatted = discoveryService.formatAsSystemMessage(loaded);
		assert.ok(formatted.includes('<skill-instructions>'));
		assert.ok(formatted.includes('Code Review'));
		assert.ok(formatted.includes('Step 1: Read the code'));
	});
});
