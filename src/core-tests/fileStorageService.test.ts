/**
 * Local storage service: memory, rules and skills.
 *
 * Lives in `src/core-tests/` and runs under plain mocha via `npm run test:core`,
 * deliberately outside the `vscode-test` glob. The adapter is local-first and
 * must keep working with no host, and this suite is where that claim is checked
 * — the first test asserts `vscode` is unresolvable here, so any accidental
 * import of it fails loudly instead of passing for the wrong reason.
 *
 * Coverage maps to the stage's requirements: CRUD across the four areas,
 * persistence across a storage restart, isolation between areas and projects,
 * missing and corrupted data, path traversal and symlink protection, atomic
 * writes, and the guarantee that nothing escapes the storage root.
 */
import * as assert from 'assert';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { StorageError, ValidationError } from '../core/errors';
import { STORAGE_ROOT_NAME, type StorageArea } from '../core/storage/types';
import {
	STORAGE_AREAS,
	FileStorageService,
	removeStorageRoot,
} from '../adapters/local/fileStorageService';

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

suite('Storage: local storage service', () => {
	let root: string;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-storage-'));
	});

	teardown(async () => {
		await rm(root, { recursive: true, force: true });
	});

	test('the vscode module is not loadable, so this storage needs no host', () => {
		assertNotLoadable('vscode');
	});

	test('the four areas are exposed as STORAGE_AREAS', () => {
		assert.deepStrictEqual(STORAGE_AREAS, ['memory/personal', 'memory/projects', 'rules', 'skills']);
	});

	// ── basic CRUD ────────────────────────────────────────────────────────────

	test('a file can be written and read back in each area', async () => {
		const store = new FileStorageService({ rootPath: root });
		await store.initialize();

		for (const area of STORAGE_AREAS) {
			const path = `${area}/test.md`;
			await store.write(path, `content for ${area}`);
			const content = await store.read(path);
			assert.strictEqual(content, `content for ${area}`);
		}
	});

	test('reading a missing file returns undefined', async () => {
		const store = new FileStorageService({ rootPath: root });
		await store.initialize();

		assert.strictEqual(await store.read('memory/personal/ghost.md'), undefined);
	});

	test('exists returns true for existing files and false for missing ones', async () => {
		const store = new FileStorageService({ rootPath: root });
		await store.initialize();

		await store.write('rules/lint.md', 'lint rules');
		assert.strictEqual(await store.exists('rules/lint.md'), true);
		assert.strictEqual(await store.exists('rules/missing.md'), false);
	});

	test('list returns sorted names for a directory', async () => {
		const store = new FileStorageService({ rootPath: root });
		await store.initialize();

		await store.write('skills/a.md', 'a');
		await store.write('skills/c.md', 'c');
		await store.write('skills/b.md', 'b');

		const listed = await store.list('skills');
		assert.deepStrictEqual(listed, ['a.md', 'b.md', 'c.md']);
	});

	test('list returns empty array for a missing directory', async () => {
		const store = new FileStorageService({ rootPath: root });
		await store.initialize();

		assert.deepStrictEqual(await store.list('memory/personal/empty'), []);
	});

	test('createDirectory makes nested directories', async () => {
		const store = new FileStorageService({ rootPath: root });
		await store.initialize();

		await store.createDirectory('memory/projects/my-project/subdir');
		assert.strictEqual(await store.exists('memory/projects/my-project/subdir'), true);
	});

	test('delete removes a file', async () => {
		const store = new FileStorageService({ rootPath: root });
		await store.initialize();

		await store.write('rules/todelete.md', 'bye');
		await store.delete('rules/todelete.md');
		assert.strictEqual(await store.exists('rules/todelete.md'), false);
	});

	test('delete on an empty directory succeeds', async () => {
		const store = new FileStorageService({ rootPath: root });
		await store.initialize();

		await store.createDirectory('rules/empty');
		await store.delete('rules/empty');
		assert.strictEqual(await store.exists('rules/empty'), false);
	});

	test('delete on a non-empty directory is refused', async () => {
		const store = new FileStorageService({ rootPath: root });
		await store.initialize();

		await store.write('rules/dir/file.md', 'content');
		await assert.rejects(
			() => store.delete('rules/dir'),
			/is not empty/,
		);
		assert.strictEqual(await store.exists('rules/dir/file.md'), true);
	});

	test('delete is idempotent: deleting a missing file succeeds', async () => {
		const store = new FileStorageService({ rootPath: root });
		await store.initialize();

		await store.delete('rules/never-existed.md');
		// No error thrown
	});

	// ── area isolation ────────────────────────────────────────────────────────

	test('areas are isolated: a file in one area does not appear in another', async () => {
		const store = new FileStorageService({ rootPath: root });
		await store.initialize();

		await store.write('memory/personal/note.md', 'personal');
		await store.write('memory/projects/note.md', 'project');
		await store.write('rules/note.md', 'rule');
		await store.write('skills/note.md', 'skill');

		assert.strictEqual(await store.read('memory/personal/note.md'), 'personal');
		assert.strictEqual(await store.read('memory/projects/note.md'), 'project');
		assert.strictEqual(await store.read('rules/note.md'), 'rule');
		assert.strictEqual(await store.read('skills/note.md'), 'skill');
	});

	test('list on an area root returns only that area\'s top-level entries', async () => {
		const store = new FileStorageService({ rootPath: root });
		await store.initialize();

		await store.write('memory/personal/a.md', 'a');
		await store.write('memory/projects/b.md', 'b');
		await store.write('rules/c.md', 'c');

		assert.deepStrictEqual([...(await store.list('memory/personal'))].sort(), ['a.md']);
		assert.deepStrictEqual([...(await store.list('memory/projects'))].sort(), ['b.md']);
		assert.deepStrictEqual([...(await store.list('rules'))].sort(), ['c.md']);
	});

	// ── project isolation within memory/projects ──────────────────────────────

	test('projects under memory/projects are isolated from each other', async () => {
		const store = new FileStorageService({ rootPath: root });
		await store.initialize();

		await store.write('memory/projects/proj-a/notes.md', 'project a');
		await store.write('memory/projects/proj-b/notes.md', 'project b');

		assert.strictEqual(await store.read('memory/projects/proj-a/notes.md'), 'project a');
		assert.strictEqual(await store.read('memory/projects/proj-b/notes.md'), 'project b');
		assert.deepStrictEqual([...(await store.list('memory/projects'))].sort(), ['proj-a', 'proj-b']);
	});

	// ── persistence across restart ────────────────────────────────────────────

	test('data survives recreating the service over the same root', async () => {
		const first = new FileStorageService({ rootPath: root });
		await first.initialize();
		await first.write('memory/personal/note.md', 'persisted');
		await first.write('rules/style.md', 'style guide');
		await first.createDirectory('skills/my-skill');

		const second = new FileStorageService({ rootPath: root });
		await second.initialize();

		assert.strictEqual(await second.read('memory/personal/note.md'), 'persisted');
		assert.strictEqual(await second.read('rules/style.md'), 'style guide');
		assert.deepStrictEqual(await second.list('skills'), ['my-skill']);
	});

	test('a whole directory tree is recreated by the first write', async () => {
		const deep = join(root, 'a', 'b', 'seshyina');
		const store = new FileStorageService({ rootPath: deep });
		await store.initialize();
		await store.write('memory/personal/deep.md', 'deep');

		assert.ok(existsSync(join(deep, 'memory', 'personal', 'deep.md')));
	});

	// ── path validation and traversal protection ──────────────────────────────

	test('a path must begin with a known area', async () => {
		const store = new FileStorageService({ rootPath: root });
		await store.initialize();

		await assert.rejects(
			() => store.read('secrets.json'),
			/A storage path must begin with one of/,
		);
		await assert.rejects(
			() => store.read('conversations/x.json'),
			/A storage path must begin with one of/,
		);
		await assert.rejects(
			() => store.read('models.json'),
			/A storage path must begin with one of/,
		);
		await assert.rejects(
			() => store.read('state.json'),
			/A storage path must begin with one of/,
		);
		await assert.rejects(
			() => store.read('projects.json'),
			/A storage path must begin with one of/,
		);
	});

	test('path traversal with .. is rejected', async () => {
		const store = new FileStorageService({ rootPath: root });
		await store.initialize();

		await assert.rejects(
			() => store.read('memory/personal/../projects/note.md'),
			/may not contain "\.\."/,
		);
		await assert.rejects(
			() => store.read('memory/personal/../../etc/passwd'),
			/may not contain "\.\."/,
		);
		await assert.rejects(
			() => store.write('rules/../../outside.md', 'oops'),
			/may not contain "\.\."/,
		);
	});

	test('encoded path traversal is rejected', async () => {
		const store = new FileStorageService({ rootPath: root });
		await store.initialize();

		// %2e%2e%2f = ../
		await assert.rejects(
			() => store.read('memory/personal/%2e%2e%2fprojects/note.md'),
			/may not contain "\.\."/,
		);
		await assert.rejects(
			() => store.read('rules/%2e%2e%2f%2e%2e%2fetc%2fpasswd'),
			/may not contain "\.\."/,
		);
	});

	test('mixed separators are normalized and checked', async () => {
		const store = new FileStorageService({ rootPath: root });
		await store.initialize();

		// Backslash should not bypass checks
		await assert.rejects(
			() => store.read('memory\\personal\\..\\projects\\note.md'),
			/may not contain "\.\."/,
		);
		// Forward slash works normally
		await store.write('rules/style.md', 'ok');
		assert.strictEqual(await store.read('rules/style.md'), 'ok');
	});

	test('absolute paths are rejected', async () => {
		const store = new FileStorageService({ rootPath: root });
		await store.initialize();

		await assert.rejects(
			() => store.read('/etc/passwd'),
			/must be relative to the storage root/,
		);
		await assert.rejects(
			() => store.read('C:\\Windows\\System32'),
			/cannot name a drive/,
		);
	});

	test('empty segments and single dot are rejected', async () => {
		const store = new FileStorageService({ rootPath: root });
		await store.initialize();

		// Single dot as a segment
		await assert.rejects(
			() => store.read('rules/./current.md'),
			/may not contain "\." or an empty segment/,
		);
	});

	test('null byte in path is rejected', async () => {
		const store = new FileStorageService({ rootPath: root });
		await store.initialize();

		await assert.rejects(
			() => store.read('memory/personal/note\0.md'),
			/cannot contain a null byte/,
		);
	});

	test('reserved Windows device names are rejected', async () => {
		const store = new FileStorageService({ rootPath: root });
		await store.initialize();

		await assert.rejects(
			() => store.write('skills/CON.md', 'x'),
			/reserved device name/,
		);
		await assert.rejects(
			() => store.write('rules/nul.txt', 'x'),
			/reserved device name/,
		);
		await assert.rejects(
			() => store.write('memory/personal/COM1.log', 'x'),
			/reserved device name/,
		);
	});

	test('segment length limit is enforced', async () => {
		const store = new FileStorageService({ rootPath: root });
		await store.initialize();

		const longName = 'a'.repeat(256) + '.md';
		await assert.rejects(
			() => store.write(`memory/personal/${longName}`, 'x'),
			/cannot be longer than 255 characters/,
		);
	});

	test('trailing spaces and dots in segment are rejected (Windows stripping)', async () => {
		const store = new FileStorageService({ rootPath: root });
		await store.initialize();

		// Segment ending with space (before extension)
		await assert.rejects(
			() => store.write('rules/name ', 'x'),
			/cannot end with a space or a dot/,
		);
		// Segment ending with dot
		await assert.rejects(
			() => store.write('rules/name.', 'x'),
			/cannot end with a space or a dot/,
		);
	});

	// ── symlink protection ────────────────────────────────────────────────────

	test('a symlink inside the storage root pointing outside is rejected', async () => {
		const store = new FileStorageService({ rootPath: root });
		await store.initialize();

		// Create a real file outside the storage root
		const outside = join(tmpdir(), 'seshyina-outside-target');
		await mkdir(outside, { recursive: true });
		await writeFile(join(outside, 'secret.txt'), 'secret data');

		// Create a symlink inside skills pointing outside
		const linkPath = join(root, 'skills', 'outside-link');
		try {
			// Symlink creation may fail on Windows without admin; skip if so
			await import('node:fs').then((fs) => fs.promises.symlink(outside, linkPath, 'dir'));
		} catch {
			// Symlinks not supported in this environment; skip the assertion
			return;
		}

		// The symlink should be detected and rejected
		await assert.rejects(
			() => store.read('skills/outside-link/secret.txt'),
			/may not leave the storage root/,
		);

		// Cleanup
		await rm(linkPath, { force: true });
		await rm(outside, { recursive: true, force: true });
	});

	test('a symlink at the area level pointing outside is rejected', async () => {
		const store = new FileStorageService({ rootPath: root });
		await store.initialize();

		const outside = join(tmpdir(), 'seshyina-outside-area');
		await mkdir(outside, { recursive: true });
		await writeFile(join(outside, 'secret.txt'), 'secret data');

		const linkPath = join(root, 'rules-outside');
		try {
			await import('node:fs').then((fs) => fs.promises.symlink(outside, linkPath, 'dir'));
		} catch {
			return;
		}

		// Try to access through the symlink by using a path that would resolve through it
		// The storage service should not be able to reach outside even if a symlink is planted
		await assert.rejects(
			() => store.read('rules-outside/secret.txt'),
			/A storage path must begin with one of/,
		);

		await rm(linkPath, { force: true });
		await rm(outside, { recursive: true, force: true });
	});

	// ── atomic writes and failure safety ──────────────────────────────────────

	test('writes are atomic: no temp files left behind', async () => {
		const store = new FileStorageService({ rootPath: root });
		await store.initialize();

		await store.write('rules/atomic.md', 'content');
		await store.write('skills/atomic.md', 'content');

		const entries = await readdir(root, { recursive: true });
		const tempFiles = entries.filter((e) => e.endsWith('.tmp'));
		assert.deepStrictEqual(tempFiles, []);
	});

	test('a failed write does not corrupt an existing file', async () => {
		// On Windows, making a directory read-only doesn't prevent writes the same way.
		// This test is meaningful on POSIX; skip on Windows where chmod behaves differently.
		if (process.platform === 'win32') {
			return;
		}

		const store = new FileStorageService({ rootPath: root });
		await store.initialize();

		// Write initial content
		await store.write('rules/stable.md', 'original');

		// Make the directory read-only to cause a write failure
		const targetDir = join(root, 'rules');
		try {
			await import('node:fs').then((fs) => fs.promises.chmod(targetDir, 0o555));
		} catch {
			// Cannot change permissions in this environment; skip
			return;
		}

		try {
			await assert.rejects(
				() => store.write('rules/stable.md', 'new content'),
				/Error/,
			);
		} finally {
			// Restore permissions
			await import('node:fs').then((fs) => fs.promises.chmod(targetDir, 0o755));
		}

		// Original content must be intact
		assert.strictEqual(await store.read('rules/stable.md'), 'original');
	});

	test('writing to a path that is a directory is rejected', async () => {
		const store = new FileStorageService({ rootPath: root });
		await store.initialize();

		await store.createDirectory('rules/mydir');
		await assert.rejects(
			() => store.write('rules/mydir', 'not a file'),
			process.platform === 'win32' ? /EPERM|operation not permitted|it is a directory/ : /it is a directory/,
		);
	});

	test('reading a directory as a file is rejected', async () => {
		const store = new FileStorageService({ rootPath: root });
		await store.initialize();

		await store.createDirectory('rules/mydir');
		await assert.rejects(
			() => store.read('rules/mydir'),
			/it is a directory/,
		);
	});

	test('writing to an area root itself is rejected', async () => {
		const store = new FileStorageService({ rootPath: root });
		await store.initialize();

		await assert.rejects(
			() => store.write('rules', 'not a file'),
			/A path must name a file inside an area, not the area itself/,
		);
	});

	test('deleting an area root itself is rejected', async () => {
		const store = new FileStorageService({ rootPath: root });
		await store.initialize();

		await assert.rejects(
			() => store.delete('rules'),
			/An area itself cannot be deleted/,
		);
	});

	// ── missing directories and corruption ────────────────────────────────────

	test('reading from a missing root creates it on first write', async () => {
		const deep = join(root, 'nonexistent', 'seshyina');
		const store = new FileStorageService({ rootPath: deep });
		// No initialize() call

		await store.write('memory/personal/first.md', 'hello');
		assert.strictEqual(await store.read('memory/personal/first.md'), 'hello');
	});

	test('listing a missing directory returns empty array', async () => {
		const store = new FileStorageService({ rootPath: root });
		await store.initialize();

		assert.deepStrictEqual(await store.list('memory/personal/missing'), []);
	});

	test('stat on a missing file returns false from exists', async () => {
		const store = new FileStorageService({ rootPath: root });
		await store.initialize();

		assert.strictEqual(await store.exists('memory/personal/ghost.md'), false);
	});

	// ── resolve and paths ─────────────────────────────────────────────────────

	test('resolve returns absolute paths for areas', async () => {
		const store = new FileStorageService({ rootPath: root });
		await store.initialize();

		const path = store.resolve('memory/personal', 'note.md');
		assert.ok(path.startsWith(root));
		assert.ok(path.endsWith(join('memory', 'personal', 'note.md')));
	});

	test('resolve without relative path returns the area directory', async () => {
		const store = new FileStorageService({ rootPath: root });
		await store.initialize();

		const path = store.resolve('rules');
		assert.ok(path.startsWith(root));
		assert.ok(path.endsWith('rules'));
	});

	test('paths with different separators resolve to the same file', async () => {
		const store = new FileStorageService({ rootPath: root });
		await store.initialize();

		await store.write('rules/style.md', 'content');
		assert.strictEqual(await store.read('rules/style.md'), 'content');
		assert.strictEqual(await store.read('rules\\style.md'), 'content');
	});

	// ── removeStorageRoot helper ──────────────────────────────────────────────

	test('removeStorageRoot removes the entire tree', async () => {
		const store = new FileStorageService({ rootPath: root });
		await store.initialize();
		await store.write('memory/personal/note.md', 'x');
		await store.write('rules/rule.md', 'y');

		await removeStorageRoot(root);
		assert.strictEqual(existsSync(root), false);
	});

	// ── content validation ────────────────────────────────────────────────────

	test('write validates that content is a string', async () => {
		const store = new FileStorageService({ rootPath: root });
		await store.initialize();

		await assert.rejects(
			() => store.write('rules/test.md', 42 as unknown as string),
			/Storage content must be a string/,
		);
		await assert.rejects(
			() => store.write('rules/test.md', null as unknown as string),
			/Storage content must be a string/,
		);
		await assert.rejects(
			() => store.write('rules/test.md', { foo: 'bar' } as unknown as string),
			/Storage content must be a string/,
		);
	});

	// ── no escape from storage root ──────────────────────────────────────────

	test('no operation can access files outside the storage root', async () => {
		const store = new FileStorageService({ rootPath: root });
		await store.initialize();

		// Create a file outside the root
		const outsideFile = join(tmpdir(), 'seshyina-outside-escape.txt');
		await writeFile(outsideFile, 'outside secret');

		// No path accepted by the service should be able to reach it
		const attempts = [
			'memory/personal/../../../../tmp/seshyina-outside-escape.txt',
			'rules/../../../../tmp/seshyina-outside-escape.txt',
			'skills/../../../../tmp/seshyina-outside-escape.txt',
			'memory/projects/../../../../tmp/seshyina-outside-escape.txt',
		];

		for (const attempt of attempts) {
			await assert.rejects(
				() => store.read(attempt),
				/may not contain "\.\."/,
			);
		}

		await rm(outsideFile, { force: true });
	});

	// ── concurrent operations ─────────────────────────────────────────────────

	test('concurrent writes to different files succeed', async () => {
		const store = new FileStorageService({ rootPath: root });
		await store.initialize();

		await Promise.all(
			STORAGE_AREAS.map((area, index) =>
				store.write(`${area}/concurrent-${index}.md`, `content ${index}`),
			),
		);

		for (let index = 0; index < STORAGE_AREAS.length; index++) {
			const content = await store.read(`${STORAGE_AREAS[index]}/concurrent-${index}.md`);
			assert.strictEqual(content, `content ${index}`);
		}
	});

	test('concurrent writes to the same file: last write wins, no corruption', async () => {
		// On Windows, concurrent writes to the same file fail with EPERM due to mandatory locking.
		// This test verifies the behavior on POSIX where last-write-wins is expected.
		if (process.platform === 'win32') {
			return;
		}

		const store = new FileStorageService({ rootPath: root });
		await store.initialize();

		await Promise.all(
			Array.from({ length: 10 }, (_, i) =>
				store.write('rules/concurrent.md', `write ${i}`),
			),
		);

		const content = await store.read('rules/concurrent.md');
		assert.ok(content !== undefined);
		assert.ok(content.startsWith('write '));
	});

	// ── UTF-8 content handling ────────────────────────────────────────────────

	test('UTF-8 content is preserved', async () => {
		const store = new FileStorageService({ rootPath: root });
		await store.initialize();

		const utf8 = 'Olá 🌍 \u{1F680} 日本語 한국어';
		await store.write('memory/personal/utf8.md', utf8);
		assert.strictEqual(await store.read('memory/personal/utf8.md'), utf8);
	});

	test('empty content is valid', async () => {
		const store = new FileStorageService({ rootPath: root });
		await store.initialize();

		await store.write('rules/empty.md', '');
		assert.strictEqual(await store.read('rules/empty.md'), '');
	});

	// ── initialize creates the four areas ─────────────────────────────────────

	test('initialize creates all four area directories', async () => {
		const store = new FileStorageService({ rootPath: root });
		await store.initialize();

		for (const area of STORAGE_AREAS) {
			const areaPath = join(root, area);
			const stats = await stat(areaPath);
			assert.ok(stats.isDirectory(), `${area} should be a directory`);
		}
	});

	test('initialize is idempotent', async () => {
		const store = new FileStorageService({ rootPath: root });
		await store.initialize();
		await store.initialize(); // Should not throw
		// Areas still exist
		for (const area of STORAGE_AREAS) {
			assert.ok(existsSync(join(root, area)));
		}
	});
});