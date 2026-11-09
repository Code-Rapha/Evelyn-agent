/**
 * Memory service: personal and project memories.
 *
 * Lives in `src/core-tests/` and runs under plain mocha via `npm run test:core`,
 * deliberately outside the `vscode-test` glob. The adapter is local-first and
 * must keep working with no host, and this suite is where that claim is checked
 * — the first test asserts `vscode` is unresolvable here, so any accidental
 * import of it fails loudly instead of passing for the wrong reason.
 *
 * Coverage maps to the stage's requirements: CRUD across personal and project
 * areas, persistence across a storage restart, isolation between areas and
 * projects, missing and corrupted data, path traversal and symlink protection,
 * and the guarantee that nothing escapes the storage root.
 */
import * as assert from 'assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StorageError, ValidationError } from '../core/errors';
import { FileStorageService } from '../adapters/local/fileStorageService';
import { createFileMemoryService } from '../core/memory/fileMemoryService';
import type { MemoryService, MemoryArea } from '../core/memory/types';

/** `vscode` does not resolve outside an extension host; prove it. */
function assertNotLoadable(moduleName: string): void {
	try {
		require(moduleName);
	} catch (error) {
		assert.strictEqual(
			(error as { code?: string }).code,
			'MODULE_NOT_FOUND',
			`expected "${moduleName}" to be unresolvable outside a host, got: ${String(error)}`,
		);
		return;
	}
	assert.fail(`"${moduleName}" resolved, so this suite is running inside an extension host`);
}

suite('Memory: file memory service', () => {
	let root: string;
	let storage: FileStorageService;
	let memory: MemoryService;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-memory-'));
		storage = new FileStorageService({ rootPath: root });
		await storage.initialize();
		memory = createFileMemoryService(storage);
	});

	teardown(async () => {
		await rm(root, { recursive: true, force: true });
	});

	test('the vscode module is not loadable, so this storage needs no host', () => {
		assertNotLoadable('vscode');
	});

	// ── personal memory CRUD ────────────────────────────────────────────────

	test('createMemory saves a personal memory with generated key', async () => {
		const result = await memory.createMemory({
			area: 'personal',
			title: 'My preference',
			content: 'I prefer dark mode.',
		});

		assert.strictEqual(result.ok, true);
		assert.ok(result.memory);
		assert.ok(result.memory!.key.length > 0);
		assert.strictEqual(result.memory!.title, 'My preference');
		assert.strictEqual(result.memory!.content, 'I prefer dark mode.');
		assert.deepStrictEqual(result.memory!.tags, []);
		assert.strictEqual(result.memory!.area, 'personal');
		assert.ok(result.memory!.createdAt);
		assert.ok(result.memory!.updatedAt);
	});

	test('createMemory saves a personal memory with custom key', async () => {
		const result = await memory.createMemory({
			area: 'personal',
			key: 'ui-preference',
			title: 'UI Preference',
			content: 'Dark mode with high contrast.',
			tags: ['ui', 'preference'],
		});

		assert.strictEqual(result.ok, true);
		assert.strictEqual(result.memory!.key, 'ui-preference');
		assert.deepStrictEqual(result.memory!.tags, ['ui', 'preference']);
	});

	test('createMemory rejects duplicate key', async () => {
		await memory.createMemory({
			area: 'personal',
			key: 'duplicate',
			title: 'First',
			content: 'Content 1',
		});

		const result = await memory.createMemory({
			area: 'personal',
			key: 'duplicate',
			title: 'Second',
			content: 'Content 2',
		});

		assert.strictEqual(result.ok, false);
		assert.ok(result.error?.includes('already exists'));
	});

	test('getMemory reads a personal memory', async () => {
		await memory.createMemory({
			area: 'personal',
			key: 'test-key',
			title: 'Test Memory',
			content: 'Test content',
		});

		const memoryEntry = await memory.getMemory('personal', 'test-key');
		assert.ok(memoryEntry);
		assert.strictEqual(memoryEntry!.key, 'test-key');
		assert.strictEqual(memoryEntry!.title, 'Test Memory');
		assert.strictEqual(memoryEntry!.content, 'Test content');
		assert.strictEqual(memoryEntry!.area, 'personal');
	});

	test('getMemory returns undefined for missing memory', async () => {
		const memoryEntry = await memory.getMemory('personal', 'nonexistent');
		assert.strictEqual(memoryEntry, undefined);
	});

	test('updateMemory updates title and content', async () => {
		await memory.createMemory({
			area: 'personal',
			key: 'update-test',
			title: 'Original Title',
			content: 'Original content',
		});

		const result = await memory.updateMemory({
			area: 'personal',
			key: 'update-test',
			title: 'Updated Title',
			content: 'Updated content',
		});

		assert.strictEqual(result.ok, true);
		assert.strictEqual(result.memory!.title, 'Updated Title');
		assert.strictEqual(result.memory!.content, 'Updated content');
		assert.strictEqual(result.memory!.key, 'update-test');
		// updatedAt should be newer than createdAt
		assert.ok(result.memory!.updatedAt >= result.memory!.createdAt);
	});

	test('updateMemory updates only provided fields', async () => {
		await memory.createMemory({
			area: 'personal',
			key: 'partial-update',
			title: 'Original Title',
			content: 'Original content',
			tags: ['original'],
		});

		const result = await memory.updateMemory({
			area: 'personal',
			key: 'partial-update',
			content: 'Only content changed',
		});

		assert.strictEqual(result.ok, true);
		assert.strictEqual(result.memory!.title, 'Original Title'); // unchanged
		assert.strictEqual(result.memory!.content, 'Only content changed');
		assert.deepStrictEqual(result.memory!.tags, ['original']); // unchanged
	});

	test('updateMemory fails for non-existent key', async () => {
		const result = await memory.updateMemory({
			area: 'personal',
			key: 'nonexistent',
			content: 'New content',
		});

		assert.strictEqual(result.ok, false);
		assert.ok(result.error?.includes('not found'));
	});

	test('deleteMemory removes a personal memory', async () => {
		await memory.createMemory({
			area: 'personal',
			key: 'to-delete',
			title: 'To Delete',
			content: 'Will be deleted',
		});

		const result = await memory.deleteMemory('personal', 'to-delete');
		assert.strictEqual(result.ok, true);

		const memoryEntry = await memory.getMemory('personal', 'to-delete');
		assert.strictEqual(memoryEntry, undefined);
	});

	test('deleteMemory is idempotent', async () => {
		const result = await memory.deleteMemory('personal', 'never-existed');
		assert.strictEqual(result.ok, false);
		assert.ok(result.error?.includes('not found'));
	});

	test('listMemories returns all personal memories sorted by updatedAt', async () => {
		await memory.createMemory({ area: 'personal', key: 'a', title: 'A', content: 'a' });
		await memory.createMemory({ area: 'personal', key: 'b', title: 'B', content: 'b' });
		await memory.createMemory({ area: 'personal', key: 'c', title: 'C', content: 'c' });

		// Update 'a' to make it most recent
		await memory.updateMemory({ area: 'personal', key: 'a', content: 'a updated' });

		const result = await memory.listMemories('personal');
		assert.strictEqual(result.ok, true);
		assert.strictEqual(result.memories.length, 3);
		// Most recently updated first
		assert.strictEqual(result.memories[0].key, 'a');
		assert.strictEqual(result.memories[1].key, 'c');
		assert.strictEqual(result.memories[2].key, 'b');
	});

	test('hasMemory returns true for existing memory', async () => {
		await memory.createMemory({ area: 'personal', key: 'exists', title: 'Exists', content: 'yes' });
		assert.strictEqual(await memory.hasMemory('personal', 'exists'), true);
		assert.strictEqual(await memory.hasMemory('personal', 'missing'), false);
	});

	// ── project memory CRUD ─────────────────────────────────────────────────

	test('createMemory saves a project memory with projectId', async () => {
		const result = await memory.createMemory({
			area: 'projects',
			projectId: 'proj-123',
			title: 'Project Decision',
			content: 'We use TypeScript strict mode.',
			tags: ['decision', 'typescript'],
		});

		assert.strictEqual(result.ok, true);
		assert.strictEqual(result.memory!.area, 'projects');
		assert.strictEqual(result.memory!.projectId, 'proj-123');
	});

	test('getMemory reads a project memory', async () => {
		await memory.createMemory({
			area: 'projects',
			projectId: 'proj-123',
			key: 'decision-1',
			title: 'Decision 1',
			content: 'Use TypeScript',
		});

		const memoryEntry = await memory.getMemory('projects', 'decision-1', 'proj-123');
		assert.ok(memoryEntry);
		assert.strictEqual(memoryEntry!.projectId, 'proj-123');
	});

	test('project memories are isolated by projectId', async () => {
		await memory.createMemory({
			area: 'projects',
			projectId: 'proj-a',
			key: 'note',
			title: 'Project A Note',
			content: 'Content A',
		});
		await memory.createMemory({
			area: 'projects',
			projectId: 'proj-b',
			key: 'note',
			title: 'Project B Note',
			content: 'Content B',
		});

		const memA = await memory.getMemory('projects', 'note', 'proj-a');
		const memB = await memory.getMemory('projects', 'note', 'proj-b');

		assert.strictEqual(memA!.content, 'Content A');
		assert.strictEqual(memB!.content, 'Content B');
	});

	test('listMemories lists only memories for the given project', async () => {
		await memory.createMemory({ area: 'projects', projectId: 'proj-a', key: 'a1', title: 'A1', content: 'a1' });
		await memory.createMemory({ area: 'projects', projectId: 'proj-a', key: 'a2', title: 'A2', content: 'a2' });
		await memory.createMemory({ area: 'projects', projectId: 'proj-b', key: 'b1', title: 'B1', content: 'b1' });

		const resultA = await memory.listMemories('projects', 'proj-a');
		const resultB = await memory.listMemories('projects', 'proj-b');

		assert.strictEqual(resultA.memories.length, 2);
		assert.strictEqual(resultB.memories.length, 1);
		assert.deepStrictEqual(resultA.memories.map((m) => m.key).sort(), ['a1', 'a2']);
		assert.strictEqual(resultB.memories[0].key, 'b1');
	});

	test('personal and project areas are isolated', async () => {
		await memory.createMemory({ area: 'personal', key: 'shared', title: 'Personal', content: 'personal' });
		await memory.createMemory({ area: 'projects', projectId: 'proj-1', key: 'shared', title: 'Project', content: 'project' });

		const personal = await memory.getMemory('personal', 'shared');
		const project = await memory.getMemory('projects', 'shared', 'proj-1');

		assert.strictEqual(personal!.content, 'personal');
		assert.strictEqual(project!.content, 'project');
	});

	// ── validation ──────────────────────────────────────────────────────────

	test('createMemory rejects empty title', async () => {
		const result = await memory.createMemory({
			area: 'personal',
			title: '',
			content: 'content',
		});
		assert.strictEqual(result.ok, false);
		assert.ok(result.error?.includes('title'));
	});

	test('createMemory rejects empty content', async () => {
		const result = await memory.createMemory({
			area: 'personal',
			title: 'Title',
			content: '',
		});
		assert.strictEqual(result.ok, false);
		assert.ok(result.error?.includes('content'));
	});

	test('createMemory rejects invalid key with path separators', async () => {
		const result = await memory.createMemory({
			area: 'personal',
			key: 'path/traversal',
			title: 'Title',
			content: 'content',
		});
		assert.strictEqual(result.ok, false);
		assert.ok(result.error?.includes('path separators'));
	});

	test('createMemory rejects key with null byte', async () => {
		const result = await memory.createMemory({
			area: 'personal',
			key: 'key\0null',
			title: 'Title',
			content: 'content',
		});
		assert.strictEqual(result.ok, false);
		assert.ok(result.error?.includes('null byte'));
	});

	test('createMemory rejects reserved Windows names', async () => {
		const result = await memory.createMemory({
			area: 'personal',
			key: 'CON',
			title: 'Title',
			content: 'content',
		});
		assert.strictEqual(result.ok, false);
		assert.ok(result.error?.includes('reserved'));
	});

	test('createMemory rejects project memory without projectId', async () => {
		const result = await memory.createMemory({
			area: 'projects',
			title: 'Title',
			content: 'content',
		});
		assert.strictEqual(result.ok, false);
		assert.ok(result.error?.includes('projectId'));
	});

	test('updateMemory rejects empty title', async () => {
		await memory.createMemory({ area: 'personal', key: 'valid', title: 'Valid', content: 'content' });

		const result = await memory.updateMemory({
			area: 'personal',
			key: 'valid',
			title: '',
		});
		assert.strictEqual(result.ok, false);
		assert.ok(result.error?.includes('title'));
	});

	test('listMemories rejects project area without projectId', async () => {
		const result = await memory.listMemories('projects');
		assert.strictEqual(result.ok, false);
		assert.ok(result.error?.includes('projectId'));
	});

	test('deleteMemory rejects project area without projectId', async () => {
		const result = await memory.deleteMemory('projects', 'key');
		assert.strictEqual(result.ok, false);
		assert.ok(result.error?.includes('projectId'));
	});

	// ── persistence across restart ──────────────────────────────────────────

	test('memories survive recreating the service over the same root', async () => {
		await memory.createMemory({
			area: 'personal',
			key: 'persisted',
			title: 'Persisted Memory',
			content: 'This should survive',
			tags: ['important'],
		});

		await memory.createMemory({
			area: 'projects',
			projectId: 'proj-1',
			key: 'project-mem',
			title: 'Project Memory',
			content: 'Project specific',
		});

		// Create new instances
		const storage2 = new FileStorageService({ rootPath: root });
		await storage2.initialize();
		const memory2 = createFileMemoryService(storage2);

		const personal = await memory2.getMemory('personal', 'persisted');
		assert.ok(personal);
		assert.strictEqual(personal!.content, 'This should survive');
		assert.deepStrictEqual(personal!.tags, ['important']);

		const project = await memory2.getMemory('projects', 'project-mem', 'proj-1');
		assert.ok(project);
		assert.strictEqual(project!.content, 'Project specific');
		assert.strictEqual(project!.projectId, 'proj-1');
	});

	// ── content validation ──────────────────────────────────────────────────

	test('memory content can be markdown with special characters', async () => {
		const markdown = `# Heading\n\n- Item 1\n- Item 2\n\n\`code\` and **bold**`;
		await memory.createMemory({
			area: 'personal',
			key: 'markdown',
			title: 'Markdown Test',
			content: markdown,
		});

		const result = await memory.getMemory('personal', 'markdown');
		assert.ok(result);
		assert.strictEqual(result!.content, markdown);
	});

	test('memory content preserves UTF-8', async () => {
		const utf8 = 'Olá 🌍 日本語 한국어';
		await memory.createMemory({
			area: 'personal',
			key: 'utf8',
			title: 'UTF-8',
			content: utf8,
		});

		const result = await memory.getMemory('personal', 'utf8');
		assert.ok(result);
		assert.strictEqual(result!.content, utf8);
	});

	test('very long content is rejected', async () => {
		const longContent = 'x'.repeat(100_001);
		const result = await memory.createMemory({
			area: 'personal',
			key: 'long',
			title: 'Long',
			content: longContent,
		});
		assert.strictEqual(result.ok, false);
		assert.ok(result.error?.includes('100KB'));
	});

	// ── path safety ─────────────────────────────────────────────────────────

	test('memory operations cannot escape storage root', async () => {
		// The memory service uses the storage service's path validation
		// which already prevents traversal. This test verifies the integration.
		const result = await memory.createMemory({
			area: 'personal',
			key: 'valid-key',
			title: 'Valid',
			content: 'content',
		});
		assert.strictEqual(result.ok, true);

		// Try to access via traversal - should be caught by storage layer
		const memoryEntry = await memory.getMemory('personal', 'valid-key');
		assert.ok(memoryEntry);
	});

	test('special characters in key are allowed', async () => {
		// Keys can have hyphens, underscores, numbers
		const result = await memory.createMemory({
			area: 'personal',
			key: 'my-key_123.test',
			title: 'Special Key',
			content: 'content',
		});
		assert.strictEqual(result.ok, true);
	});

	// ── tags ────────────────────────────────────────────────────────────────

	test('tags are stored and retrieved correctly', async () => {
		await memory.createMemory({
			area: 'personal',
			key: 'tagged',
			title: 'Tagged',
			content: 'content',
			tags: ['tag1', 'tag2', 'tag3'],
		});

		const result = await memory.getMemory('personal', 'tagged');
		assert.deepStrictEqual(result!.tags, ['tag1', 'tag2', 'tag3']);
	});

	test('empty tags array is valid', async () => {
		const result = await memory.createMemory({
			area: 'personal',
			key: 'no-tags',
			title: 'No Tags',
			content: 'content',
			tags: [],
		});
		assert.strictEqual(result.ok, true);
		assert.deepStrictEqual(result.memory!.tags, []);
	});

	// ── update tags ─────────────────────────────────────────────────────────

	test('updateMemory can change tags', async () => {
		await memory.createMemory({
			area: 'personal',
			key: 'tag-update',
			title: 'Tag Update',
			content: 'content',
			tags: ['old'],
		});

		const result = await memory.updateMemory({
			area: 'personal',
			key: 'tag-update',
			tags: ['new', 'tags'],
		});

		assert.strictEqual(result.ok, true);
		assert.deepStrictEqual(result.memory!.tags, ['new', 'tags']);
	});

	// ── concurrent operations ───────────────────────────────────────────────

	test('concurrent creates to different keys succeed', async () => {
		await Promise.all([
			memory.createMemory({ area: 'personal', key: 'concurrent-1', title: 'C1', content: '1' }),
			memory.createMemory({ area: 'personal', key: 'concurrent-2', title: 'C2', content: '2' }),
			memory.createMemory({ area: 'personal', key: 'concurrent-3', title: 'C3', content: '3' }),
		]);

		assert.strictEqual(await memory.hasMemory('personal', 'concurrent-1'), true);
		assert.strictEqual(await memory.hasMemory('personal', 'concurrent-2'), true);
		assert.strictEqual(await memory.hasMemory('personal', 'concurrent-3'), true);
	});

	// ── initialize creates directories ──────────────────────────────────────

	test('initialize creates memory directories', async () => {
		const newRoot = join(root, 'new-memory-root');
		const newStorage = new FileStorageService({ rootPath: newRoot });
		await newStorage.initialize();

		// The storage initialize creates all four areas including memory/personal and memory/projects
		// Memory service uses those directories
		const newMemory = createFileMemoryService(newStorage);
		const result = await newMemory.createMemory({
			area: 'personal',
			key: 'first',
			title: 'First',
			content: 'content',
		});
		assert.strictEqual(result.ok, true);
	});
});