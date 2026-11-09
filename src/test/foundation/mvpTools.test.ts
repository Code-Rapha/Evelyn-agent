import * as assert from 'assert';
import { mkdtemp, writeFile, mkdir, rm, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	READ_FILE,
	WRITE_FILE,
	LIST_FILES,
	RUN_COMMAND,
	createReadFileTool,
	createWriteFileTool,
	createListFilesTool,
	createRunCommandTool,
	createMvpTools,
	MVP_TOOL_SPECS,
	type CommandOutcome,
	type CommandRunner,
} from '../../core/agent/mvpTools';
import { Workspace, WorkspaceEscapeError } from '../../core/agent/workspace';
import { createMvpAgentStack, allowAllGateway } from '../../core/agent/composition';
import { ConversationRuntime } from '../../core/agent/runtime';
import { DEFAULT_PERMISSION_LEVEL_BY_RISK } from '../../core/permissions/types';
import type { ToolExecutionContext, ToolResult } from '../../core/agent/types';
import type { ChatProvider, ChatRequest, ChatStream, ChatStreamEvent } from '../../core/providers/chat/types';

/** Executes a tool with a workspace, the way the runtime does. */
async function run(
	tool: { execute(input: unknown, context: ToolExecutionContext): Promise<ToolResult> },
	root: string,
	input: unknown,
	signal?: AbortSignal,
): Promise<ToolResult> {
	return tool.execute(input, {
		sessionId: 'test',
		workingDirectory: root,
		...(signal !== undefined ? { signal } : {}),
	});
}

/** A command runner that records what it was asked to run. */
function fakeRunner(
	outcome: Partial<Omit<CommandOutcome, 'command' | 'cwd'>> = {},
): { runner: CommandRunner; calls: Array<{ command: string; cwd: string }> } {
	const calls: Array<{ command: string; cwd: string }> = [];
	const runner: CommandRunner = async (command, cwd) => {
		calls.push({ command, cwd });
		return { exitCode: 0, stdout: '', stderr: '', aborted: false, ...outcome };
	};
	return { runner, calls };
}

/**
 * Creates a directory link, reporting whether the platform allowed it.
 *
 * Windows wants elevation for a plain directory symlink, so a junction stands
 * in there — `realpath` resolves both, and that is the only thing the
 * containment check reads. A locked-down machine can refuse even a junction,
 * so a caller that gets `false` skips rather than going red over a filesystem
 * permission the test cannot grant.
 */
async function tryLinkDirectory(target: string, path: string): Promise<boolean> {
	try {
		await symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir');
		return true;
	} catch {
		return false;
	}
}

suite('Core: workspace containment', () => {
	let root: string;
	let outside: string;

	setup(async () => {
		const base = await mkdtemp(join(tmpdir(), 'seshyina-tools-'));
		root = join(base, 'project');
		outside = join(base, 'outside');
		await mkdir(root, { recursive: true });
		await mkdir(outside, { recursive: true });
		await writeFile(join(root, 'inside.txt'), 'inside content', 'utf8');
		await writeFile(join(outside, 'secret.txt'), 'SECRET', 'utf8');
	});

	teardown(async () => {
		await rm(join(root, '..'), { recursive: true, force: true });
	});

	test('a relative path inside the workspace resolves', async () => {
		const workspace = new Workspace(root);

		const resolved = await workspace.resolveInside('inside.txt');

		assert.strictEqual(await workspace.contains(resolved), true);
	});

	test('a nested relative path resolves', async () => {
		await mkdir(join(root, 'a', 'b'), { recursive: true });
		await writeFile(join(root, 'a', 'b', 'deep.txt'), 'deep', 'utf8');
		const workspace = new Workspace(root);

		assert.ok((await workspace.resolveInside('a/b/deep.txt')).endsWith('deep.txt'));
	});

	test('a relative path that walks out is refused', async () => {
		const workspace = new Workspace(root);

		await assert.rejects(() => workspace.resolveInside('../outside/secret.txt'), WorkspaceEscapeError);
	});

	test('a deep traversal is refused', async () => {
		const workspace = new Workspace(root);

		await assert.rejects(
			() => workspace.resolveInside('a/../../../../etc/passwd'),
			WorkspaceEscapeError,
		);
	});

	test('an absolute path outside the workspace is refused', async () => {
		const workspace = new Workspace(root);

		await assert.rejects(() => workspace.resolveInside(join(outside, 'secret.txt')), WorkspaceEscapeError);
	});

	test('an absolute path inside the workspace is allowed', async () => {
		const workspace = new Workspace(root);

		const resolved = await workspace.resolveInside(join(root, 'inside.txt'));

		assert.ok(resolved.endsWith('inside.txt'));
	});

	test('a path that normalises to the workspace root is allowed', async () => {
		const workspace = new Workspace(root);

		assert.ok((await workspace.resolveInside('.')).length > 0);
		assert.ok((await workspace.resolveInside('./')).length > 0);
	});

	test('a symlink pointing outside is refused', async function () {
		try {
			await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'));
		} catch {
			// Windows refuses file symlinks without privilege, and a junction
			// only stands in for a directory. Nothing to prove if it cannot be
			// built.
			this.skip();
			return;
		}
		const workspace = new Workspace(root);

		await assert.rejects(() => workspace.resolveInside('link.txt'), WorkspaceEscapeError);
	});

	test('a symlinked directory cannot be used to escape', async function () {
		if (!(await tryLinkDirectory(outside, join(root, 'outlink')))) {
			this.skip();
			return;
		}
		const workspace = new Workspace(root);

		await assert.rejects(() => workspace.resolveInside('outlink/secret.txt'), WorkspaceEscapeError);
	});

	test('resolveInsideForCreate allows a new file but not a new path outside', async () => {
		const workspace = new Workspace(root);

		assert.ok((await workspace.resolveInsideForCreate('brand/new.txt')).endsWith('new.txt'));
		await assert.rejects(
			() => workspace.resolveInsideForCreate('../outside/new.txt'),
			WorkspaceEscapeError,
		);
	});

	test('resolveInsideForCreate refuses a file behind a link out of the workspace', async function () {
		if (!(await tryLinkDirectory(outside, join(root, 'outlink')))) {
			this.skip();
			return;
		}
		const workspace = new Workspace(root);

		// Lexically this is `root/outlink/new.txt` and reads as inside; what a
		// write would actually reach is `outside/new.txt`. Only the resolved
		// parent separates the two, which is what `resolveInsideForCreate` had
		// been throwing away.
		await assert.rejects(
			() => workspace.resolveInsideForCreate('outlink/new.txt'),
			WorkspaceEscapeError,
		);
		await assert.rejects(
			() => workspace.resolveInsideForCreate('outlink/deeper/new.txt'),
			WorkspaceEscapeError,
		);
	});

	test('resolveInsideForCreate accepts a new file behind a link that stays inside', async function () {
		await mkdir(join(root, 'real'), { recursive: true });
		if (!(await tryLinkDirectory(join(root, 'real'), join(root, 'alias')))) {
			this.skip();
			return;
		}
		const workspace = new Workspace(root);

		// Containment is about where the bytes land, not about the spelling.
		// A link the workspace owns is a normal way to address a directory in
		// it, and refusing it would break a legitimate project layout.
		const resolved = await workspace.resolveInsideForCreate('alias/new.txt');
		assert.ok(resolved.endsWith('new.txt'));

		await writeFile(resolved, 'written', 'utf8');

		assert.strictEqual(await workspace.contains(join(root, 'real', 'new.txt')), true);
		assert.strictEqual(await workspace.contains(resolved), true);
	});

	test('an empty path is refused', async () => {
		const workspace = new Workspace(root);

		await assert.rejects(() => workspace.resolveInside(''));
	});
});

suite('Core: read_file', () => {
	let root: string;
	let outside: string;

	setup(async () => {
		const base = await mkdtemp(join(tmpdir(), 'seshyina-read-'));
		root = join(base, 'project');
		outside = join(base, 'outside');
		await mkdir(root, { recursive: true });
		await mkdir(outside, { recursive: true });
		await writeFile(join(root, 'a.txt'), 'hello', 'utf8');
		await writeFile(join(outside, 'secret.txt'), 'SECRET', 'utf8');
	});

	teardown(async () => {
		await rm(join(root, '..'), { recursive: true, force: true });
	});

	test('reads a file and returns its content', async () => {
		const result = await run(createReadFileTool(), root, { path: 'a.txt' });

		assert.strictEqual(result.ok, true);
		assert.strictEqual((result.output as { content: string }).content, 'hello');
	});

	test('reads UTF-8 content intact', async () => {
		await writeFile(join(root, 'utf.txt'), 'ação — 日本語 ✓', 'utf8');
		const result = await run(createReadFileTool(), root, { path: 'utf.txt' });

		assert.strictEqual((result.output as { content: string }).content, 'ação — 日本語 ✓');
	});

	test('a missing file returns a controlled error', async () => {
		const result = await run(createReadFileTool(), root, { path: 'nope.txt' });

		assert.strictEqual(result.ok, false);
		assert.match(result.error ?? '', /no such file/i);
	});

	test('a missing path argument returns a controlled error', async () => {
		const result = await run(createReadFileTool(), root, {});

		assert.strictEqual(result.ok, false);
		assert.match(result.error ?? '', /path/i);
	});

	test('path traversal is refused and the file outside is untouched', async () => {
		const result = await run(createReadFileTool(), root, { path: '../outside/secret.txt' });

		assert.strictEqual(result.ok, false);
		assert.match(result.error ?? '', /outside the workspace/i);
		assert.ok(!JSON.stringify(result).includes('SECRET'), 'the content never leaks');
	});

	test('an absolute path outside is refused', async () => {
		const result = await run(createReadFileTool(), root, {
			path: join(outside, 'secret.txt'),
		});

		assert.strictEqual(result.ok, false);
		assert.ok(!JSON.stringify(result).includes('SECRET'));
	});

	test('reading a directory returns an error, not a listing', async () => {
		const result = await run(createReadFileTool(), root, { path: '.' });

		assert.strictEqual(result.ok, false);
	});

	test('without a workspace it fails rather than guessing a directory', async () => {
		const result = await createReadFileTool().execute(
			{ path: 'a.txt' },
			{ sessionId: 'test' },
		);

		assert.strictEqual(result.ok, false);
		assert.match(result.error ?? '', /workspace/i);
	});

	test('the risk level is safe, which maps to automatic', () => {
		assert.strictEqual(createReadFileTool().descriptor.riskLevel, 'safe');
		assert.strictEqual(DEFAULT_PERMISSION_LEVEL_BY_RISK.safe, 'automatic');
	});
});

suite('Core: write_file', () => {
	let root: string;
	let outside: string;

	setup(async () => {
		const base = await mkdtemp(join(tmpdir(), 'seshyina-write-'));
		root = join(base, 'project');
		outside = join(base, 'outside');
		await mkdir(root, { recursive: true });
		await mkdir(outside, { recursive: true });
	});

	teardown(async () => {
		await rm(join(root, '..'), { recursive: true, force: true });
	});

	test('writes a new file', async () => {
		const result = await run(createWriteFileTool(), root, {
			path: 'new.txt',
			content: 'created',
		});

		assert.strictEqual(result.ok, true);
		assert.ok(existsSync(join(root, 'new.txt')));
	});

	test('write then read round-trips', async () => {
		await run(createWriteFileTool(), root, { path: 'round.txt', content: 'round trip' });

		const read = await run(createReadFileTool(), root, { path: 'round.txt' });

		assert.strictEqual((read.output as { content: string }).content, 'round trip');
	});

	test('creates missing parent directories', async () => {
		const result = await run(createWriteFileTool(), root, {
			path: 'deep/nested/file.txt',
			content: 'x',
		});

		assert.strictEqual(result.ok, true);
		assert.ok(existsSync(join(root, 'deep', 'nested', 'file.txt')));
	});

	test('overwrites an existing file', async () => {
		await writeFile(join(root, 'existing.txt'), 'old', 'utf8');

		await run(createWriteFileTool(), root, { path: 'existing.txt', content: 'new' });

		const read = await run(createReadFileTool(), root, { path: 'existing.txt' });
		assert.strictEqual((read.output as { content: string }).content, 'new');
	});

	test('reports the byte count written', async () => {
		const result = await run(createWriteFileTool(), root, {
			path: 'bytes.txt',
			content: '12345',
		});

		assert.strictEqual((result.output as { bytes: number }).bytes, 5);
	});

	test('writing outside the workspace is refused and writes nothing', async () => {
		const result = await run(createWriteFileTool(), root, {
			path: '../outside/planted.txt',
			content: 'should not exist',
		});

		assert.strictEqual(result.ok, false);
		assert.match(result.error ?? '', /outside the workspace/i);
		assert.ok(!existsSync(join(outside, 'planted.txt')), 'nothing was written outside');
	});

	test('writing to an absolute path outside is refused', async () => {
		const result = await run(createWriteFileTool(), root, {
			path: join(outside, 'planted.txt'),
			content: 'nope',
		});

		assert.strictEqual(result.ok, false);
		assert.ok(!existsSync(join(outside, 'planted.txt')));
	});

	test('a missing content argument returns a controlled error', async () => {
		const result = await run(createWriteFileTool(), root, { path: 'x.txt' });

		assert.strictEqual(result.ok, false);
		assert.match(result.error ?? '', /content/i);
	});

	test('the risk level is moderate, which maps to ask', () => {
		assert.strictEqual(createWriteFileTool().descriptor.riskLevel, 'moderate');
		assert.strictEqual(DEFAULT_PERMISSION_LEVEL_BY_RISK.moderate, 'ask');
	});
});

suite('Core: list_files', () => {
	let root: string;

	setup(async () => {
		const base = await mkdtemp(join(tmpdir(), 'seshyina-list-'));
		root = join(base, 'project');
		await mkdir(join(root, 'src'), { recursive: true });
		await writeFile(join(root, 'b.txt'), 'bb', 'utf8');
		await writeFile(join(root, 'a.txt'), 'a', 'utf8');
		await writeFile(join(root, 'src', 'index.ts'), 'x', 'utf8');
	});

	teardown(async () => {
		await rm(join(root, '..'), { recursive: true, force: true });
	});

	test('lists the workspace root when no path is given', async () => {
		const result = await run(createListFilesTool(), root, {});

		assert.strictEqual(result.ok, true);
		const entries = (result.output as { entries: Array<{ name: string; type: string }> }).entries;
		assert.deepStrictEqual(
			entries.map((e) => e.name),
			['a.txt', 'b.txt', 'src'],
		);
	});

	test('marks directories and files distinctly', async () => {
		const result = await run(createListFilesTool(), root, {});
		const entries = (result.output as { entries: Array<{ name: string; type: string }> }).entries;

		assert.strictEqual(entries.find((e) => e.name === 'src')?.type, 'directory');
		assert.strictEqual(entries.find((e) => e.name === 'a.txt')?.type, 'file');
	});

	test('the result is deterministic across repeated calls', async () => {
		const first = await run(createListFilesTool(), root, {});
		const second = await run(createListFilesTool(), root, {});

		assert.deepStrictEqual(first.output, second.output);
	});

	test('lists a subdirectory', async () => {
		const result = await run(createListFilesTool(), root, { path: 'src' });

		assert.deepStrictEqual(
			(result.output as { entries: Array<{ name: string }> }).entries.map((e) => e.name),
			['index.ts'],
		);
	});

	test('a missing directory returns a controlled error', async () => {
		const result = await run(createListFilesTool(), root, { path: 'nope' });

		assert.strictEqual(result.ok, false);
		assert.match(result.error ?? '', /no such file/i);
	});

	test('traversal is refused', async () => {
		const result = await run(createListFilesTool(), root, { path: '../..' });

		assert.strictEqual(result.ok, false);
		assert.match(result.error ?? '', /outside the workspace/i);
	});

	test('the risk level is safe, which maps to automatic', () => {
		assert.strictEqual(createListFilesTool().descriptor.riskLevel, 'safe');
	});
});

suite('Core: run_command', () => {
	let root: string;

	setup(async () => {
		const base = await mkdtemp(join(tmpdir(), 'seshyina-cmd-'));
		root = join(base, 'project');
		await mkdir(root, { recursive: true });
	});

	teardown(async () => {
		await rm(join(root, '..'), { recursive: true, force: true });
	});

	test('returns stdout, stderr and the exit code', async () => {
		const { runner } = fakeRunner({ exitCode: 3, stdout: 'out', stderr: 'err' });

		const result = await run(createRunCommandTool(runner), root, { command: 'thing --flag' });

		assert.strictEqual(result.ok, true);
		const output = result.output as CommandOutcome;
		assert.strictEqual(output.stdout, 'out');
		assert.strictEqual(output.stderr, 'err');
		assert.strictEqual(output.exitCode, 3);
	});

	test('runs in the workspace', async () => {
		const { runner, calls } = fakeRunner();

		await run(createRunCommandTool(runner), root, { command: 'ls' });

		assert.strictEqual(calls[0].cwd, await new Workspace(root).realRootForExecution());
	});

	test('a non-zero exit is a result, not a failure', async () => {
		const { runner } = fakeRunner({ exitCode: 1, stderr: 'boom' });

		const result = await run(createRunCommandTool(runner), root, { command: 'false' });

		assert.strictEqual(result.ok, true);
	});

	test('a missing command argument returns a controlled error', async () => {
		const { runner, calls } = fakeRunner();

		const result = await run(createRunCommandTool(runner), root, {});

		assert.strictEqual(result.ok, false);
		assert.strictEqual(calls.length, 0, 'nothing was launched');
	});

	test('the signal is forwarded to the runner', async () => {
		const controller = new AbortController();
		let seen: AbortSignal | undefined;
		const runner: CommandRunner = async (_command, _cwd, signal) => {
			seen = signal;
			return { exitCode: 0, stdout: '', stderr: '', aborted: signal?.aborted === true };
		};

		await run(createRunCommandTool(runner), root, { command: 'x' }, controller.signal);

		assert.strictEqual(seen, controller.signal);
	});

	test('an aborted run reports aborted rather than throwing', async () => {
		const controller = new AbortController();
		const runner: CommandRunner = async (_command, _cwd, signal) => {
			controller.abort();
			return { exitCode: -1, stdout: '', stderr: '', aborted: signal?.aborted === true };
		};

		const result = await run(createRunCommandTool(runner), root, { command: 'x' }, controller.signal);

		assert.strictEqual((result.output as CommandOutcome).aborted, true);
	});

	test('without a workspace it refuses to run', async () => {
		const { runner, calls } = fakeRunner();

		const result = await createRunCommandTool(runner).execute(
			{ command: 'ls' },
			{ sessionId: 'test' },
		);

		assert.strictEqual(result.ok, false);
		assert.strictEqual(calls.length, 0, 'no process was started outside a workspace');
	});

	test('the risk level is dangerous, which maps to deny by default', () => {
		assert.strictEqual(createRunCommandTool().descriptor.riskLevel, 'dangerous');
		assert.strictEqual(DEFAULT_PERMISSION_LEVEL_BY_RISK.dangerous, 'deny');
	});
});

suite('Core: composition root', () => {
	let root: string;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-comp-'));
	});

	teardown(async () => {
		await rm(root, { recursive: true, force: true });
	});

	test('registers exactly the four MVP tools', () => {
		const stack = createMvpAgentStack({ commandRunner: async () => ({ exitCode: 0, stdout: '', stderr: '', aborted: false }) });

		assert.deepStrictEqual(stack.registry.names(), [
			'list_files',
			'read_file',
			'run_command',
			'write_file',
		]);
		stack.dispose();
	});

	test('every registered tool has a spec, so the model can be told about it', () => {
		const stack = createMvpAgentStack({ commandRunner: async () => ({ exitCode: 0, stdout: '', stderr: '', aborted: false }) });

		for (const name of stack.registry.names()) {
			assert.ok(stack.registry.spec(name) !== undefined, `${name} has a spec`);
		}
		assert.strictEqual(MVP_TOOL_SPECS.length, 4);
		stack.dispose();
	});

	test('createMvpTools returns the four tools', () => {
		assert.strictEqual(createMvpTools().length, 4);
	});

	test('dispose unregisters everything', () => {
		const stack = createMvpAgentStack({ commandRunner: async () => ({ exitCode: 0, stdout: '', stderr: '', aborted: false }) });

		stack.dispose();

		assert.strictEqual(stack.registry.size, 0);
	});

	test('extra tools can be registered alongside', () => {
		const extra = createReadFileTool();
		const stack = createMvpAgentStack({
			commandRunner: async () => ({ exitCode: 0, stdout: '', stderr: '', aborted: false }),
			extraTools: [
				{
					tool: { ...extra, descriptor: { ...extra.descriptor, id: 'custom', name: 'custom' } },
					spec: {
						name: 'custom',
						description: 'a custom tool',
						parameters: { type: 'object' },
						riskLevel: 'safe',
						category: 'other',
					},
				},
			],
		});

		assert.strictEqual(stack.registry.size, 5);
		stack.dispose();
	});

	test('allowAllGateway grants without asking', async () => {
		const decision = await allowAllGateway().ask({
			toolId: 't',
			toolName: 't',
			action: 'run',
			description: 's',
			riskLevel: 'safe',
			arguments: {},
			sessionId: 'test',
		});

		assert.strictEqual(decision.decision, 'allow');
	});
});

suite('Core: runtime drives the real tools', () => {
	let root: string;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-e2e-'));
	});

	teardown(async () => {
		await rm(root, { recursive: true, force: true });
	});

	/** A provider that calls one tool, then answers. */
	function toolThenAnswer(toolName: string, args: string): ChatProvider {
		const scripts: ChatStreamEvent[][] = [
			[
				{ type: 'ToolCallDelta', call: { id: 'c1', name: toolName, arguments: args } },
				{ type: 'Done' },
			],
			[{ type: 'TextDelta', text: 'finished' }, { type: 'Done' }],
		];
		let index = 0;
		const requests: ChatRequest[] = [];
		return {
			requests,
			async streamChat(request: ChatRequest): Promise<ChatStream> {
				requests.push(request);
				const script = scripts[Math.min(index, scripts.length - 1)];
				index += 1;
				return {
					closedReason: 'completed',
					// Never measured: this is a fixture, not a request.
					timing: {},
					[Symbol.asyncIterator]: async function* () {
						yield* script;
					},
				};
			},
		} as ChatProvider & { requests: ChatRequest[] };
	}

	test('the runtime writes a real file through write_file', async () => {
		const stack = createMvpAgentStack({
			commandRunner: async () => ({ exitCode: 0, stdout: '', stderr: '', aborted: false }),
		});
		const runtime = new ConversationRuntime({
			provider: toolThenAnswer('write_file', '{"path":"made.txt","content":"from the agent"}'),
			tools: stack.registry,
			permissions: allowAllGateway(),
			workingDirectory: root,
		});

		const events = [];
		for await (const event of runtime.run({ messages: [{ role: 'user', content: 'write it' }] })) {
			events.push(event);
		}

		assert.ok(existsSync(join(root, 'made.txt')));
		assert.strictEqual(events[events.length - 1].type, 'TurnCompleted');
		stack.dispose();
	});

	test('a denied run_command never reaches the runner', async () => {
		let launched = false;
		const stack = createMvpAgentStack({
			commandRunner: async () => {
				launched = true;
				return { exitCode: 0, stdout: '', stderr: '', aborted: false };
			},
		});
		const runtime = new ConversationRuntime({
			provider: toolThenAnswer('run_command', '{"command":"rm -rf /"}'),
			tools: stack.registry,
			permissions: { ask: async () => ({ decision: 'deny', reason: 'not this time' }) },
			workingDirectory: root,
		});

		for await (const _event of runtime.run({ messages: [{ role: 'user', content: 'run it' }] })) {
			// drain
		}

		assert.strictEqual(launched, false, 'the process was never started');
		stack.dispose();
	});

	test('an allowed run_command reaches the runner', async () => {
		const calls: string[] = [];
		const stack = createMvpAgentStack({
			commandRunner: async (command) => {
				calls.push(command);
				return { exitCode: 0, stdout: 'hi', stderr: '', aborted: false };
			},
		});
		const runtime = new ConversationRuntime({
			provider: toolThenAnswer('run_command', '{"command":"echo hi"}'),
			tools: stack.registry,
			permissions: allowAllGateway(),
			workingDirectory: root,
		});

		for await (const _event of runtime.run({ messages: [{ role: 'user', content: 'run it' }] })) {
			// drain
		}

		assert.deepStrictEqual(calls, ['echo hi']);
		stack.dispose();
	});

	test('a traversal attempt is refused even with permission granted', async () => {
		const stack = createMvpAgentStack({
			commandRunner: async () => ({ exitCode: 0, stdout: '', stderr: '', aborted: false }),
		});
		const provider = toolThenAnswer('read_file', '{"path":"../../../etc/passwd"}');
		const runtime = new ConversationRuntime({
			provider,
			tools: stack.registry,
			permissions: allowAllGateway(),
			workingDirectory: root,
		});

		for await (const _event of runtime.run({ messages: [{ role: 'user', content: 'read it' }] })) {
			// drain
		}

		const second = (provider as unknown as { requests: ChatRequest[] }).requests[1];
		const last = second.messages[second.messages.length - 1];
		assert.strictEqual(last.role, 'tool');
		assert.match(last.content, /outside the workspace/i);
		stack.dispose();
	});
});