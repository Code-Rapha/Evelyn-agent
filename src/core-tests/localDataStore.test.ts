/**
 * Local storage: projects, conversation history and the secret boundary.
 *
 * Lives in `src/core-tests/` and runs under plain mocha via `npm run test:core`,
 * deliberately outside the `vscode-test` glob. The adapter is local-first and
 * must keep working with no host, and this suite is where that claim is checked
 * — the first test asserts `vscode` is unresolvable here, so any accidental
 * import of it fails loudly instead of passing for the wrong reason.
 *
 * Coverage maps to the stage's requirements: project CRUD, message ordering
 * across all three roles, multiple conversations, survival across a storage
 * restart, missing and corrupted data, and the guarantee that a secret never
 * reaches disk.
 */
import * as assert from 'assert';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import { StorageError, ValidationError } from '../core/errors';
import { providerApiKeyRef } from '../core/providers/secrets';
import {
	assertNoSecretFields,
	toAppendInputs,
	type ConversationMessage,
} from '../core/storage/types/dataStore';
import {
	CONVERSATIONS_DIR,
	FileDataStore,
	PROJECTS_FILE,
	defaultDataStoreRoot,
} from '../adapters/local/fileDataStore';
import { FileSecretStore } from '../adapters/local/fileSecretStore';

/** Distinct from the redaction placeholder used by the logger, on purpose. */
const SECRET = 'sk-live-DO-NOT-PERSIST-4f2a9c';

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

suite('Storage: local data store', () => {
	let root: string;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-data-'));
	});

	teardown(async () => {
		await rm(root, { recursive: true, force: true });
	});

	test('the vscode module is not loadable, so this storage needs no host', () => {
		assertNotLoadable('vscode');
	});

	test('the default root sits under ~/.modelhub/seshyina', () => {
		assert.strictEqual(defaultDataStoreRoot(), join(homedir(), '.modelhub', 'seshyina'));
	});

	// ── projects ────────────────────────────────────────────────────────────

	test('a project is created and read back with all five fields', async () => {
		const store = new FileDataStore({ rootPath: root });

		const created = await store.createProject({ name: 'ModelHub', rootPath: 'G:\\ModelHub' });

		assert.strictEqual(created.id.length > 0, true);
		assert.strictEqual(created.name, 'ModelHub');
		assert.strictEqual(created.rootPath, 'G:\\ModelHub');
		assert.strictEqual(created.createdAt, created.updatedAt);

		const fetched = await store.getProject(created.id);
		assert.deepStrictEqual(fetched, created);
		assert.strictEqual((await store.listProjects()).length, 1);
	});

	test('a missing project is undefined, not an error', async () => {
		const store = new FileDataStore({ rootPath: root });

		assert.strictEqual(await store.getProject('nope'), undefined);
		assert.deepStrictEqual(await store.listProjects(), []);
	});

	test('updating a project changes fields and bumps updatedAt only', async () => {
		const store = new FileDataStore({
			rootPath: root,
			now: makeClock(['2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z']),
		});
		const created = await store.createProject({ name: 'Old', rootPath: '/old' });

		const updated = await store.updateProject(created.id, { name: 'New' });

		assert.strictEqual(updated.name, 'New');
		assert.strictEqual(updated.rootPath, '/old', 'untouched fields survive');
		assert.strictEqual(updated.createdAt, '2026-01-01T00:00:00.000Z');
		assert.strictEqual(updated.updatedAt, '2026-01-02T00:00:00.000Z');
		assert.strictEqual((await store.getProject(created.id))?.name, 'New');
	});

	test('updating an absent project raises rather than creating a phantom', async () => {
		const store = new FileDataStore({ rootPath: root });

		await assert.rejects(() => store.updateProject('ghost', { name: 'x' }), StorageError);
		assert.deepStrictEqual(await store.listProjects(), []);
	});

	test('deleting a project removes it and reports whether it existed', async () => {
		const store = new FileDataStore({ rootPath: root });
		const project = await store.createProject({ name: 'Temp', rootPath: '/tmp' });

		assert.strictEqual(await store.deleteProject(project.id), true);
		assert.strictEqual(await store.deleteProject(project.id), false, 'second delete is a no-op');
		assert.deepStrictEqual(await store.listProjects(), []);
	});

	test('a duplicate project id is rejected', async () => {
		const store = new FileDataStore({ rootPath: root });
		await store.createProject({ id: 'fixed', name: 'First', rootPath: '/a' });

		await assert.rejects(
			() => store.createProject({ id: 'fixed', name: 'Second', rootPath: '/b' }),
			ValidationError,
		);
		assert.strictEqual((await store.listProjects()).length, 1);
	});

	test('a blank name or rootPath is rejected before anything is written', async () => {
		const store = new FileDataStore({ rootPath: root });

		await assert.rejects(() => store.createProject({ name: '  ', rootPath: '/a' }), ValidationError);
		await assert.rejects(() => store.createProject({ name: 'a', rootPath: '' }), ValidationError);
		assert.deepStrictEqual(await store.listProjects(), []);
		assert.ok(!existsSync(join(root, PROJECTS_FILE)), 'a rejected create must not touch disk');
	});

	// ── conversation history ────────────────────────────────────────────────

	test('user, assistant and tool messages are stored in order', async () => {
		const store = new FileDataStore({ rootPath: root });
		const conversation = await store.createConversation({ title: 'First' });

		await store.appendMessage(conversation.id, { role: 'user', content: 'read a.txt' });
		await store.appendMessage(conversation.id, { role: 'assistant', content: 'calling a tool' });
		await store.appendMessage(conversation.id, {
			role: 'tool',
			content: 'contents of a.txt',
			toolCallId: 'call-1',
		});

		const stored = await store.getConversation(conversation.id);
		assert.deepStrictEqual(
			stored?.messages.map((message) => [message.seq, message.role, message.content]),
			[
				[0, 'user', 'read a.txt'],
				[1, 'assistant', 'calling a tool'],
				[2, 'tool', 'contents of a.txt'],
			],
		);
		assert.strictEqual(stored?.messages[2].toolCallId, 'call-1');
	});

	test('an assistant message keeps the calls its results answer', async () => {
		const store = new FileDataStore({ rootPath: root });
		const conversation = await store.createConversation({ title: 'Tool round' });

		await store.appendMessages(conversation.id, [
			{ role: 'user', content: 'read a.txt' },
			{
				role: 'assistant',
				content: 'calling a tool\n\n[tool calls: read_file({"path":"a.txt"})]',
				toolCalls: [{ id: 'call-1', name: 'read_file', arguments: '{"path":"a.txt"}' }],
			},
			{ role: 'tool', content: 'contents', toolCallId: 'call-1' },
		]);

		// Read back, which is where the *next* turn gets its context. Calls
		// that only lived in memory would leave the tool message below
		// answering a call no message ever made.
		const stored = await store.getConversation(conversation.id);

		assert.deepStrictEqual(stored?.messages[1].toolCalls, [
			{ id: 'call-1', name: 'read_file', arguments: '{"path":"a.txt"}' },
		]);
		assert.strictEqual(stored?.messages[1].content, 'calling a tool\n\n[tool calls: read_file({"path":"a.txt"})]');
		assert.strictEqual(stored?.messages[2].toolCallId, 'call-1');
	});

	test('a half-formed toolCalls entry is refused rather than stored', async () => {
		const store = new FileDataStore({ rootPath: root });
		const conversation = await store.createConversation({ title: 'Bad calls' });

		await assert.rejects(
			() =>
				store.appendMessage(conversation.id, {
					role: 'assistant',
					content: 'x',
					toolCalls: [{ id: '', name: 'read_file', arguments: '{}' }],
				}),
			/id, name and string arguments/,
		);
		await assert.rejects(
			() =>
				store.appendMessage(conversation.id, {
					role: 'assistant',
					content: 'x',
					toolCalls: 'not an array' as never,
				}),
			/toolCalls must be an array/,
		);

		// Nothing half-written is left behind: the failure is visible now, not
		// several turns later as a request the server refuses.
		const stored = await store.getConversation(conversation.id);
		assert.strictEqual(stored?.messages.length, 0);
	});

	test('a batch append keeps its order and assigns contiguous seq', async () => {
		const store = new FileDataStore({ rootPath: root });
		const conversation = await store.createConversation({ title: 'Batch' });

		await store.appendMessage(conversation.id, { role: 'user', content: 'first' });
		const appended = await store.appendMessages(conversation.id, [
			{ role: 'assistant', content: 'a' },
			{ role: 'tool', content: 'b', toolCallId: 'c1' },
			{ role: 'assistant', content: 'c' },
		]);

		assert.deepStrictEqual(appended.map((message) => message.seq), [1, 2, 3]);
		const stored = await store.getConversation(conversation.id);
		assert.deepStrictEqual(stored?.messages.map((m) => m.content), ['first', 'a', 'b', 'c']);
		assert.deepStrictEqual(stored?.messages.map((m) => m.seq), [0, 1, 2, 3]);
	});

	test('concurrent appends do not interleave or lose a message', async () => {
		const store = new FileDataStore({ rootPath: root });
		const conversation = await store.createConversation({ title: 'Race' });

		await Promise.all(
			Array.from({ length: 12 }, (_, index) =>
				store.appendMessage(conversation.id, { role: 'user', content: `m${index}` }),
			),
		);

		const stored = await store.getConversation(conversation.id);
		assert.strictEqual(stored?.messages.length, 12, 'no write is lost');
		assert.deepStrictEqual(
			stored?.messages.map((message) => message.seq),
			[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
			'and none shares a position',
		);
	});

	test('appending to an unknown conversation raises instead of creating one', async () => {
		const store = new FileDataStore({ rootPath: root });

		await assert.rejects(
			() => store.appendMessage('missing', { role: 'user', content: 'hi' }),
			StorageError,
		);
		assert.deepStrictEqual(await store.listConversations(), []);
	});

	test('an unknown role or non-string content is rejected', async () => {
		const store = new FileDataStore({ rootPath: root });
		const conversation = await store.createConversation({ title: 'Bad input' });

		// `system` was refused here when it was not a persisted role; it is one
		// now, so the only role left to reject is a genuinely unknown one.
		await assert.rejects(
			() =>
				store.appendMessage(conversation.id, {
					role: 'narrator' as unknown as 'user',
					content: 'x',
				}),
			ValidationError,
		);
		await assert.rejects(
			() =>
				store.appendMessage(conversation.id, {
					role: 'user',
					content: 42 as unknown as string,
				}),
			ValidationError,
		);
		assert.strictEqual((await store.getConversation(conversation.id))?.messages.length, 0);
	});

	// ── multiple conversations ──────────────────────────────────────────────

	test('multiple conversations stay independent and listable', async () => {
		const store = new FileDataStore({
			rootPath: root,
			now: makeClock([
				'2026-01-01T00:00:00.000Z',
				'2026-01-02T00:00:00.000Z',
				'2026-01-03T00:00:00.000Z',
			]),
		});

		const first = await store.createConversation({ title: 'One' });
		const second = await store.createConversation({ title: 'Two' });
		const third = await store.createConversation({ title: 'Three' });

		await store.appendMessages(first.id, [
			{ role: 'user', content: 'one-1' },
			{ role: 'assistant', content: 'one-2' },
		]);
		await store.appendMessage(second.id, { role: 'user', content: 'two-1' });

		const listed = await store.listConversations();
		assert.deepStrictEqual(listed.map((summary) => summary.title), ['One', 'Two', 'Three']);
		assert.deepStrictEqual(listed.map((summary) => summary.messageCount), [2, 1, 0]);

		// Deleting one leaves the others untouched.
		await store.deleteConversation(second.id);
		const after = await store.listConversations();
		assert.deepStrictEqual(after.map((summary) => summary.id), [first.id, third.id]);
		assert.strictEqual((await store.getConversation(first.id))?.messages.length, 2);
		assert.strictEqual(await store.getConversation(second.id), undefined);
		assert.strictEqual(await store.deleteConversation(second.id), false);
	});

	test('conversations can be filtered by project and cascade on delete', async () => {
		const store = new FileDataStore({ rootPath: root });
		const project = await store.createProject({ name: 'P', rootPath: '/p' });
		const other = await store.createProject({ name: 'Q', rootPath: '/q' });

		const mine = await store.createConversation({ projectId: project.id, title: 'Mine' });
		await store.createConversation({ projectId: other.id, title: 'Theirs' });
		await store.createConversation({ title: 'Unattached' });
		await store.appendMessage(mine.id, { role: 'user', content: 'hi' });

		const scoped = await store.listConversations({ projectId: project.id });
		assert.deepStrictEqual(scoped.map((summary) => summary.title), ['Mine']);

		await store.deleteProject(project.id);

		assert.deepStrictEqual(
			(await store.listConversations()).map((summary) => summary.title),
			['Theirs', 'Unattached'],
			'the project conversation went with it; the others stayed',
		);
	});

	// ── restart ─────────────────────────────────────────────────────────────

	test('projects and history survive recreating the store over the same root', async () => {
		const first = new FileDataStore({ rootPath: root });
		const project = await first.createProject({ name: 'ModelHub', rootPath: 'G:\\ModelHub' });
		const conversation = await first.createConversation({
			projectId: project.id,
			title: 'Persisted',
		});
		await first.appendMessages(conversation.id, [
			{ role: 'user', content: 'hello' },
			{ role: 'assistant', content: 'hi' },
			{ role: 'tool', content: 'done', toolCallId: 'x' },
		]);

		// Second process: a fresh object, same root, nothing carried over.
		const second = new FileDataStore({ rootPath: root });

		assert.deepStrictEqual(await second.listProjects(), [project]);
		const restored = await second.getConversation(conversation.id);
		assert.strictEqual(restored?.title, 'Persisted');
		assert.strictEqual(restored?.projectId, project.id);
		assert.deepStrictEqual(restored?.messages.map((m) => m.content), ['hello', 'hi', 'done']);
		assert.deepStrictEqual(restored?.messages.map((m) => m.role), ['user', 'assistant', 'tool']);

		// And the reloaded instance stays writable.
		await second.appendMessage(conversation.id, { role: 'user', content: 'again' });
		assert.strictEqual((await second.getConversation(conversation.id))?.messages.length, 4);
	});

	test('a whole directory tree is recreated by the first write', async () => {
		const deep = join(root, 'a', 'b', 'seshyina');
		const store = new FileDataStore({ rootPath: deep });
		await store.createProject({ name: 'Deep', rootPath: '/deep' });

		assert.ok(existsSync(join(deep, PROJECTS_FILE)));
	});

	test('a message appended before a restart is visible after it, in order', async () => {
		const first = new FileDataStore({ rootPath: root });
		const conversation = await first.createConversation({ title: 'Split' });
		await first.appendMessage(conversation.id, { role: 'user', content: 'before' });

		const second = new FileDataStore({ rootPath: root });
		await second.appendMessage(conversation.id, { role: 'assistant', content: 'after' });

		const third = new FileDataStore({ rootPath: root });
		const stored = await third.getConversation(conversation.id);
		assert.deepStrictEqual(stored?.messages.map((m) => m.content), ['before', 'after']);
		assert.deepStrictEqual(stored?.messages.map((m) => m.seq), [0, 1]);
	});

	// ── missing and corrupted data ──────────────────────────────────────────

	test('a corrupt projects file degrades to empty rather than failing to start', async () => {
		await writeFile(join(root, PROJECTS_FILE), 'not json at all', 'utf8');
		const store = new FileDataStore({ rootPath: root });

		assert.deepStrictEqual(await store.listProjects(), []);

		// And the store is usable again afterwards.
		const project = await store.createProject({ name: 'Recovered', rootPath: '/r' });
		assert.strictEqual((await store.listProjects()).length, 1);
		assert.strictEqual((await new FileDataStore({ rootPath: root }).getProject(project.id))?.name, 'Recovered');
	});

	test('a projects file with junk entries keeps the valid ones', async () => {
		await writeFile(
			join(root, PROJECTS_FILE),
			JSON.stringify({
				version: 1,
				projects: [
					{ id: 'good', name: 'Good', rootPath: '/g', createdAt: 't0', updatedAt: 't0' },
					{ name: 'no id' },
					null,
					42,
					{ id: 'good', name: 'Duplicate', rootPath: '/d', createdAt: 't1', updatedAt: 't1' },
				],
			}),
			'utf8',
		);

		const projects = await new FileDataStore({ rootPath: root }).listProjects();
		assert.deepStrictEqual(projects.map((project) => project.id), ['good']);
		assert.strictEqual(projects[0].name, 'Good', 'the first duplicate wins');
	});

	test('a projects file that is not an object reads as empty', async () => {
		await writeFile(join(root, PROJECTS_FILE), '[1, 2, 3]', 'utf8');
		assert.deepStrictEqual(await new FileDataStore({ rootPath: root }).listProjects(), []);
	});

	test('one corrupt transcript is skipped when listing and reported when named', async () => {
		const store = new FileDataStore({ rootPath: root });
		const healthy = await store.createConversation({ title: 'Healthy' });
		const damaged = await store.createConversation({ title: 'Damaged' });
		await store.appendMessage(healthy.id, { role: 'user', content: 'fine' });

		await writeFile(
			join(root, CONVERSATIONS_DIR, `${damaged.id}.json`),
			'{ broken',
			'utf8',
		);

		// A fresh instance re-reads the directory.
		const reloaded = new FileDataStore({ rootPath: root });
		assert.deepStrictEqual((await reloaded.listConversations()).map((c) => c.title), ['Healthy']);
		await assert.rejects(() => reloaded.getConversation(damaged.id), StorageError);

		// The damaged file is left on disk rather than silently deleted.
		assert.ok(existsSync(join(root, CONVERSATIONS_DIR, `${damaged.id}.json`)));
	});

	test('a transcript with the wrong shape is treated as damaged, not as data', async () => {
		const store = new FileDataStore({ rootPath: root });
		const conversation = await store.createConversation({ title: 'Shape' });
		await writeFile(
			join(root, CONVERSATIONS_DIR, `${conversation.id}.json`),
			JSON.stringify({ id: conversation.id, messages: 'nope' }),
			'utf8',
		);

		const reloaded = new FileDataStore({ rootPath: root });
		assert.deepStrictEqual(await reloaded.listConversations(), []);
		await assert.rejects(() => reloaded.getConversation(conversation.id), StorageError);
	});

	test('individual malformed messages are dropped, the rest of the transcript survives', async () => {
		const store = new FileDataStore({ rootPath: root });
		const conversation = await store.createConversation({ title: 'Partial' });
		await writeFile(
			join(root, CONVERSATIONS_DIR, `${conversation.id}.json`),
			JSON.stringify({
				version: 1,
				id: conversation.id,
				title: 'Partial',
				createdAt: 't0',
				updatedAt: 't0',
				messages: [
					{ id: 'm0', seq: 0, role: 'user', content: 'kept', createdAt: 't0' },
					{ id: 'm1', role: 'assistant' },
					{ id: 'm2', seq: 2, role: 'nobody', content: 'bad role', createdAt: 't0' },
					'not an object',
					{ id: 'm3', seq: 3, role: 'assistant', content: 'also kept', createdAt: 't0' },
				],
			}),
			'utf8',
		);

		const stored = await new FileDataStore({ rootPath: root }).getConversation(conversation.id);
		assert.deepStrictEqual(stored?.messages.map((m) => m.content), ['kept', 'also kept']);
		assert.deepStrictEqual(stored?.messages.map((m) => m.seq), [0, 3], 'order follows seq');
	});

	test('a conversation id cannot address a file outside the directory', async () => {
		const store = new FileDataStore({ rootPath: root });
		await mkdir(root, { recursive: true });
		await writeFile(join(root, 'outside.json'), JSON.stringify({ id: 'x' }), 'utf8');

		// `../outside` resolves to the same bare name inside the conversations
		// directory, which does not exist — so nothing outside is ever touched.
		assert.strictEqual(await store.getConversation('../outside'), undefined);
		await assert.rejects(
			() => store.appendMessage('../outside', { role: 'user', content: 'x' }),
			StorageError,
		);

		assert.deepStrictEqual((await readdir(root)).sort(), ['outside.json']);
	});

	test('no temporary file is left behind after writes', async () => {
		const store = new FileDataStore({ rootPath: root });
		const conversation = await store.createConversation({ title: 'Clean' });
		await store.appendMessage(conversation.id, { role: 'user', content: 'hi' });
		await store.deleteConversation(conversation.id);

		const entries = await readdir(root);
		assert.deepStrictEqual(entries.filter((entry) => entry.endsWith('.tmp')), []);
		const inConversations = await readdir(join(root, CONVERSATIONS_DIR));
		assert.deepStrictEqual(inConversations.filter((entry) => entry.endsWith('.tmp')), []);
	});

	test('two concurrent deletes of the same conversation report true then false', async () => {
		const store = new FileDataStore({ rootPath: root });
		const conversation = await store.createConversation({ title: 'Once' });
		await store.listConversations(); // warm the index the presence check reads

		// Outside the write queue both deletes passed the check before either
		// removed the file, so both reported `true`.
		const results = await Promise.all([
			store.deleteConversation(conversation.id),
			store.deleteConversation(conversation.id),
		]);

		assert.deepStrictEqual(results, [true, false]);
	});

	test('a delete queued behind an append wins and nothing resurrects', async () => {
		const store = new FileDataStore({ rootPath: root });
		const conversation = await store.createConversation({ title: 'Race' });
		await store.listConversations(); // warm the index

		const [appended, deleted] = await Promise.all([
			store.appendMessage(conversation.id, { role: 'user', content: 'hi' }),
			store.deleteConversation(conversation.id),
		]);

		assert.strictEqual(appended.content, 'hi');
		assert.strictEqual(deleted, true);
		assert.strictEqual(
			await store.getConversation(conversation.id),
			undefined,
			'the append must not write back the file the delete removed',
		);
		assert.deepStrictEqual(
			(await store.listConversations()).filter((summary) => summary.id === conversation.id),
			[],
		);
	});

	test('parallel creates all land on disk and in the list', async () => {
		const store = new FileDataStore({ rootPath: root });

		await Promise.all(
			Array.from({ length: 20 }, (_, index) =>
				store.createConversation({ id: `c-${index}`, title: `C ${index}` }),
			),
		);

		assert.strictEqual((await store.listConversations()).length, 20);
		// A fresh instance reads the truth off disk, not the warm cache.
		const fresh = new FileDataStore({ rootPath: root });
		assert.strictEqual((await fresh.listConversations()).length, 20);
	});

	// ── secrets ─────────────────────────────────────────────────────────────

	test('a secret-shaped field is refused on every write path', async () => {
		const store = new FileDataStore({ rootPath: root });

		await assert.rejects(
			() =>
				store.createProject({
					name: 'Leaky',
					rootPath: '/l',
					apiKey: SECRET,
				} as unknown as { name: string; rootPath: string }),
			ValidationError,
		);
		await assert.rejects(
			() => store.createConversation({ title: 'Leaky', token: SECRET } as unknown as { title: string }),
			ValidationError,
		);

		const conversation = await store.createConversation({ title: 'Fine' });
		await assert.rejects(
			() =>
				store.appendMessage(conversation.id, {
					role: 'user',
					content: 'x',
					authorization: SECRET,
				} as unknown as { role: 'user'; content: string }),
			ValidationError,
		);

		assert.deepStrictEqual(await store.listProjects(), [], 'nothing was written');
		assert.strictEqual((await store.getConversation(conversation.id))?.messages.length, 0);
	});

	test('a rejected write leaves no trace in the stored file', async () => {
		const store = new FileDataStore({ rootPath: root });
		const conversation = await store.createConversation({ title: 'Guarded' });

		await assert.rejects(() =>
			store.appendMessage(conversation.id, {
				role: 'user',
				content: 'x',
				password: SECRET,
			} as unknown as { role: 'user'; content: string }),
		);

		const onDisk = await readFile(join(root, CONVERSATIONS_DIR, `${conversation.id}.json`), 'utf8');
		assert.ok(!onDisk.includes(SECRET), 'the secret must never be written');

		// Re-reading from disk shows the transcript is still empty.
		const stored = await new FileDataStore({ rootPath: root }).getConversation(conversation.id);
		assert.deepStrictEqual(stored?.messages, []);
	});

	test('nothing under the data root ever contains the value stored in the SecretStore', async () => {
		const secrets = new FileSecretStore({ filePath: join(root, 'secrets.json') });
		await secrets.store(providerApiKeyRef('test'), SECRET);

		const store = new FileDataStore({ rootPath: root });
		const project = await store.createProject({ name: 'ModelHub', rootPath: 'G:\\ModelHub' });
		const conversation = await store.createConversation({
			projectId: project.id,
			title: 'Keyed',
		});
		await store.appendMessages(conversation.id, [
			{ role: 'user', content: 'what is my key?' },
			{ role: 'assistant', content: 'I will not print it.' },
			{ role: 'tool', content: 'checked the keychain', toolCallId: 'c1' },
		]);

		// Only the secrets file itself holds the value; no data file does.
		const dataFiles = [join(root, PROJECTS_FILE), join(root, CONVERSATIONS_DIR, `${conversation.id}.json`)];
		for (const file of dataFiles) {
			assert.ok(!(await readFile(file, 'utf8')).includes(SECRET), `${file} must not hold the key`);
		}

		// A reference is fine and expected; that is the whole design.
		const projects = await readFile(join(root, PROJECTS_FILE), 'utf8');
		assert.strictEqual(projects.includes(providerApiKeyRef('test')), false);
	});

	test('assertNoSecretFields matches on the key and never inspects the value', () => {
		assert.doesNotThrow(() => assertNoSecretFields({ apiKeyRef: providerApiKeyRef('x') }));
		assert.throws(() => assertNoSecretFields({ apiKeyRef: 'sk-…', apiKey: 'anything' }), ValidationError);
		assert.throws(() => assertNoSecretFields({ nested: 1, refreshToken: SECRET }), ValidationError);
		assert.throws(() => assertNoSecretFields({ 'X-Api-Key': SECRET }), ValidationError);
		assert.throws(() => assertNoSecretFields({ passwordHash: SECRET }), ValidationError);
		assert.throws(() => assertNoSecretFields('a string'), ValidationError);
	});

	test('toAppendInputs keeps every role, system included', () => {
		// `system` used to be dropped here. It is kept now: the prompt is part of
		// the conversation the user edits, and dropping it would discard exactly
		// what they just typed.
		const inputs = toAppendInputs([
			{ role: 'system', content: 'you are Seshyina' },
			{ role: 'user', content: 'hello' },
			{ role: 'assistant', content: 'hi' },
			{ role: 'tool', content: 'result', toolCallId: 'c1' },
		]);

		assert.deepStrictEqual(inputs, [
			{ role: 'system', content: 'you are Seshyina' },
			{ role: 'user', content: 'hello' },
			{ role: 'assistant', content: 'hi' },
			{ role: 'tool', content: 'result', toolCallId: 'c1' },
		]);
	});

	test('a runtime history is persisted through the port, in order', async () => {
		const store = new FileDataStore({ rootPath: root });
		const conversation = await store.createConversation({ title: 'From a turn' });

		// The shape the runtime hands back: system prompt plus the real turn.
		const history = [
			{ role: 'system' as const, content: 'you are Seshyina' },
			{ role: 'user' as const, content: 'list the files' },
			{ role: 'assistant' as const, content: 'calling list_files' },
			{ role: 'tool' as const, content: 'a.txt\nb.txt', toolCallId: 'call-1' },
			{ role: 'assistant' as const, content: 'there are two files' },
		];

		await store.appendMessages(conversation.id, toAppendInputs(history));

		const stored = await store.getConversation(conversation.id);
		assert.deepStrictEqual(stored?.messages.map((m) => m.content), [
			'you are Seshyina',
			'list the files',
			'calling list_files',
			'a.txt\nb.txt',
			'there are two files',
		]);
		const roles: string[] = (stored?.messages ?? []).map((m: ConversationMessage) => m.role);
		assert.deepStrictEqual(roles, ['system', 'user', 'assistant', 'tool', 'assistant']);
	});

	// ── renaming and the system prompt ──────────────────────────────────────

	test('a conversation can be renamed and the title persists', async () => {
		const store = new FileDataStore({ rootPath: root });
		const conversation = await store.createConversation({ title: 'Original' });

		const renamed = await store.renameConversation(conversation.id, 'Renamed');

		assert.strictEqual(renamed.title, 'Renamed');
		assert.strictEqual(renamed.id, conversation.id);
		assert.strictEqual(
			(await new FileDataStore({ rootPath: root }).getConversation(conversation.id))?.title,
			'Renamed',
		);
	});

	test('renaming rejects a blank title and an unknown conversation', async () => {
		const store = new FileDataStore({ rootPath: root });
		const conversation = await store.createConversation({ title: 'Keep me' });

		await assert.rejects(() => store.renameConversation(conversation.id, '   '), ValidationError);
		await assert.rejects(() => store.renameConversation('ghost', 'Any'), StorageError);
		assert.strictEqual(
			(await store.getConversation(conversation.id))?.title,
			'Keep me',
			'a refused rename leaves the title alone',
		);
	});

	test('a system prompt becomes the first message and replays on every read', async () => {
		const store = new FileDataStore({ rootPath: root });
		const conversation = await store.createConversation({ title: 'Prompted' });
		await store.appendMessage(conversation.id, { role: 'user', content: 'first' });

		await store.setSystemPrompt(conversation.id, 'be brief');

		const stored = await store.getConversation(conversation.id);
		assert.deepStrictEqual(stored?.messages.map((m) => [m.seq, m.role, m.content]), [
			[0, 'system', 'be brief'],
			[1, 'user', 'first'],
		]);
		// And it survives a restart.
		assert.strictEqual(
			(await new FileDataStore({ rootPath: root }).getConversation(conversation.id))?.messages[0]
				.content,
			'be brief',
		);
	});

	test('setting a prompt twice replaces rather than duplicates it', async () => {
		const store = new FileDataStore({ rootPath: root });
		const conversation = await store.createConversation({ title: 'Once' });

		await store.setSystemPrompt(conversation.id, 'first version');
		await store.setSystemPrompt(conversation.id, 'second version');

		const stored = await store.getConversation(conversation.id);
		const systems = stored?.messages.filter((m) => m.role === 'system') ?? [];
		assert.strictEqual(systems.length, 1, 'exactly one prompt is ever sent');
		assert.strictEqual(systems[0].content, 'second version');
	});

	test('an empty prompt removes it instead of storing a blank one', async () => {
		const store = new FileDataStore({ rootPath: root });
		const conversation = await store.createConversation({ title: 'Cleared' });
		await store.setSystemPrompt(conversation.id, 'no longer wanted');

		await store.setSystemPrompt(conversation.id, '   ');

		const stored = await store.getConversation(conversation.id);
		assert.deepStrictEqual(stored?.messages, []);
	});

	test('seq stays contiguous after the prompt is spliced in or out', async () => {
		const store = new FileDataStore({ rootPath: root });
		const conversation = await store.createConversation({ title: 'Renumbered' });
		await store.appendMessages(conversation.id, [
			{ role: 'user', content: 'a' },
			{ role: 'assistant', content: 'b' },
		]);

		await store.setSystemPrompt(conversation.id, 'prompt');
		assert.deepStrictEqual(
			(await store.getConversation(conversation.id))?.messages.map((m) => m.seq),
			[0, 1, 2],
		);

		await store.setSystemPrompt(conversation.id, '');
		assert.deepStrictEqual(
			(await store.getConversation(conversation.id))?.messages.map((m) => m.seq),
			[0, 1],
		);
	});

	test('a prompt on an unknown conversation raises', async () => {
		const store = new FileDataStore({ rootPath: root });

		await assert.rejects(() => store.setSystemPrompt('ghost', 'x'), StorageError);
		// A non-string is rejected before the lookup, so it surfaces as validation
		// rather than as "no such conversation".
		await assert.rejects(
			() => store.setSystemPrompt('ghost', 42 as unknown as string),
			ValidationError,
		);
	});

	test('a write before any list keeps the conversations already on disk visible', async () => {
		const first = new FileDataStore({ rootPath: root });
		await first.createConversation({ title: 'One' });
		await first.createConversation({ title: 'Two' });

		// A fresh store — a restarted app — whose *first* operation is a write.
		// The index was never loaded, and seeding it from this one write used to
		// hide everything else: `loadConversations` saw a populated map, never
		// scanned the directory, and the sidebar lost the two conversations
		// above until the app restarted again.
		const second = new FileDataStore({ rootPath: root });
		await second.createConversation({ title: 'Three' });

		const listed = await second.listConversations();
		assert.deepStrictEqual(
			listed.map((summary) => summary.title).sort(),
			['One', 'Three', 'Two'],
		);
		assert.strictEqual(await second.deleteConversation(listed[0].id), true);
	});
});

/** A clock that returns the given timestamps in order, then repeats the last. */
function makeClock(timestamps: readonly string[]): () => string {
	let index = 0;
	return () => {
		const value = timestamps[Math.min(index, timestamps.length - 1)];
		index += 1;
		return value;
	};
}