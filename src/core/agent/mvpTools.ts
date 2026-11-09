/**
 * The four MVP tools, bound to a workspace.
 *
 * They are ordinary `AgentTool` implementations: they hold no authority of
 * their own. The runtime resolves them by name, asks the permission port, and
 * only then calls `execute`. That ordering is the whole security story — a tool
 * cannot be reached except through it.
 *
 * Risk levels come from the existing taxonomy and nothing more is invented:
 *
 *   read_file   safe        reading a file the user already opened
 *   list_files  safe        listing names, not contents
 *   write_file  moderate    changes the project
 *   run_command dangerous   arbitrary code execution
 *
 * `write_file` and `run_command` therefore land on `ask` and `deny` under the
 * default risk map, which is the intended behaviour, not an accident.
 */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, relative } from 'node:path';
import { AgentError } from '../errors';
import type { AgentTool, ToolDescriptor, ToolExecutionContext, ToolResult } from './types';
import type { ToolSpec } from './toolRegistry';
import { Workspace } from './workspace';
import { acquireDevLock, repositoryRootOf } from '../dev/devFileLock';

/** Tool names. Constants so a host never hardcodes a string literal. */
export const READ_FILE = 'read_file';
export const WRITE_FILE = 'write_file';
export const LIST_FILES = 'list_files';
export const RUN_COMMAND = 'run_command';

/** Turns a thrown error into a tool result the model can read. */
function failure<T>(error: unknown): ToolResult<T> {
	if (error instanceof AgentError) {
		return { ok: false, error: error.message };
	}
	if (error instanceof Error) {
		const code = (error as NodeJS.ErrnoException).code;
		// ENOENT and EACCES are ordinary answers to ordinary questions, not
		// crashes: the model should be told "there is no such file", not be
		// handed a stack trace.
		if (code === 'ENOENT') {
			return { ok: false, error: 'no such file or directory' };
		}
		if (code === 'EACCES' || code === 'EPERM') {
			return { ok: false, error: 'permission denied' };
		}
		if (code === 'EISDIR') {
			return { ok: false, error: 'path is a directory' };
		}
		return { ok: false, error: error.message };
	}
	return { ok: false, error: String(error) };
}

function argString(input: unknown, key: string): string {
	const value = (input as Record<string, unknown> | undefined)?.[key];
	if (typeof value !== 'string' || value.length === 0) {
		throw new AgentError(`The "${key}" argument must be a non-empty string`);
	}
	return value;
}

/** The workspace a tool was bound to, or a clear failure. */
function requireWorkspace(context: ToolExecutionContext, toolName: string): Workspace {
	if (context.workingDirectory === undefined) {
		throw new AgentError(`"${toolName}" needs a workspace`);
	}
	return new Workspace(context.workingDirectory);
}

/**
 * Reads a UTF-8 file from inside the workspace.
 *
 * Refuses to read a directory: the model asked for a file, and silently
 * returning a listing would hide the mistake.
 */
export function createReadFileTool(): AgentTool<unknown, { readonly path: string; readonly content: string }> {
	const descriptor: ToolDescriptor = {
		id: READ_FILE,
		name: READ_FILE,
		category: 'filesystem',
		riskLevel: 'safe',
		description: 'Read a UTF-8 text file from the project',
	};
	return {
		descriptor,
		async execute(input, context): Promise<ToolResult<{ path: string; content: string }>> {
			try {
				const workspace = requireWorkspace(context, READ_FILE);
				const requested = argString(input, 'path');
				const resolved = await workspace.resolveInside(requested);
				const content = await readFile(resolved, 'utf8');
				return { ok: true, output: { path: requested, content } };
			} catch (error) {
				return failure(error);
			}
		},
	};
}

/**
 * Writes a UTF-8 file inside the workspace, creating parents as needed.
 *
 * ## A trava do repositório (DEV-2.3)
 *
 * O workspace pode ser a raiz do repositório da Evelyn ou uma subpasta dele.
 * Quando o destino está dentro de um repositório Git, a escrita adquire a
 * **mesma** trava que `dev_write`, `dev_run` e `run_command` usam — a por
 * arquivo, de `devFileLock` —, na mesma ordem (processo → arquivo) e com
 * liberação em `finally`.
 *
 * Sem esse cuidado, o agente comum podia gravar um arquivo no meio de um
 * `npm run build` que outro processo executava no mesmo repositório.
 *
 * Fora de um repositório não há trava a adquirir: um workspace que não é Git
 * continua sendo escrito como sempre foi, sem espera. A validação de caminho
 * (`Workspace`) e o risco `moderate` são os mesmos de antes.
 */
export function createWriteFileTool(
	options: { readonly crossProcessWaitMs?: number } = {},
): AgentTool<unknown, { readonly path: string; readonly bytes: number }> {
	const descriptor: ToolDescriptor = {
		id: WRITE_FILE,
		name: WRITE_FILE,
		category: 'filesystem',
		riskLevel: 'moderate',
		description: 'Write a UTF-8 text file to the project, creating it if needed',
	};
	return {
		descriptor,
		async execute(input, context): Promise<ToolResult<{ path: string; bytes: number }>> {
			try {
				const workspace = requireWorkspace(context, WRITE_FILE);
				const requested = argString(input, 'path');
				const content = argString(input, 'content');
				const resolved = await workspace.resolveInsideForCreate(requested);
				return await withRepositoryLock(resolved, options.crossProcessWaitMs, async () => {
					// `mkdir` e a escrita dentro da trava: criar um diretório no
					// repositório também é mudar o repositório.
					await mkdir(dirname(resolved), { recursive: true });
					await writeFile(resolved, content, 'utf8');
					return { ok: true, output: { path: requested, bytes: Buffer.byteLength(content, 'utf8') } };
				});
			} catch (error) {
				return failure(error);
			}
		},
	};
}

/**
 * A escrita da ferramenta comum, sob a trava do repositório quando houver um.
 *
 * A ordem é a mesma do DEV — processo, depois arquivo — para que dois
 * caminhos nunca adquiram em ordens opostas (o que seria um deadlock entre
 * processos). A trava é liberada **depois** de a escrita terminar; o retorno
 * da ferramenta só acontece com o `finally` executado.
 */
async function withRepositoryLock<T>(
	target: string,
	waitMs: number | undefined,
	work: () => Promise<T>,
): Promise<T> {
	const root = await repositoryRootOf(dirname(target));
	if (root === undefined) {
		// Workspace sem Git: nada a coordenar entre processos.
		return await work();
	}
	const fileLock = await acquireDevLock(root, { waitMs: waitMs ?? 30_000 });
	if (fileLock.kind !== 'acquired') {
		// `AgentError` porque `failure()` já sabe transformá-lo em mensagem de
		// ferramenta — o modelo precisa ler o motivo, não uma exceção crua.
		throw new AgentError(
			fileLock.kind === 'busy'
				? `o repositório está em uso por outra operação (${fileLock.reason}); nada foi escrito`
				: `não foi possível coordenar a escrita no repositório: ${fileLock.message}`,
		);
	}
	try {
		return await work();
	} finally {
		await fileLock.lock.release();
	}
}

/** One entry in a directory listing. */
export interface DirectoryEntry {
	readonly name: string;
	readonly type: 'file' | 'directory' | 'other';
	/** Size in bytes; undefined for directories. */
	readonly size?: number;
}

/**
 * Lists a directory inside the workspace.
 *
 * Entries are sorted by name so two calls on an unchanged directory return
 * identical results — a model diffing two listings should see only real
 * changes. Hidden entries are included: a project that depends on `.env` or
 * `.gitignore` is not one where hiding files helps.
 */
export function createListFilesTool(): AgentTool<unknown, { readonly path: string; readonly entries: readonly DirectoryEntry[] }> {
	const descriptor: ToolDescriptor = {
		id: LIST_FILES,
		name: LIST_FILES,
		category: 'filesystem',
		riskLevel: 'safe',
		description: 'List the files and directories at a path inside the project',
	};
	return {
		descriptor,
		async execute(input, context): Promise<ToolResult<{ path: string; entries: readonly DirectoryEntry[] }>> {
			try {
				const workspace = requireWorkspace(context, LIST_FILES);
				const requested = (input as { path?: unknown })?.path;
				// An omitted path means the workspace root, which is the common
				// case: "what is in this project?"
				const target: string =
					typeof requested === 'string' && requested.length > 0 ? requested : '.';
				const resolved = await workspace.resolveInside(target);
				const raw = await readdir(resolved, { withFileTypes: true });

				const entries: DirectoryEntry[] = raw
					.map((entry): DirectoryEntry => {
						if (entry.isDirectory()) {
							return { name: entry.name, type: 'directory' };
						}
						if (entry.isFile()) {
							return { name: entry.name, type: 'file' };
						}
						return { name: entry.name, type: 'other' };
					})
					.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

				return { ok: true, output: { path: target, entries } };
			} catch (error) {
				return failure(error);
			}
		},
	};
}

/** What a command produced. */
export interface CommandOutcome {
	readonly command: string;
	readonly cwd: string;
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
	/** True when the process was killed because the caller aborted. */
	readonly aborted: boolean;
}

/** How `run_command` is allowed to invoke a process. Injected for tests. */
export interface CommandRunner {
	(command: string, cwd: string, signal?: AbortSignal): Promise<{
		exitCode: number;
		stdout: string;
		stderr: string;
		aborted: boolean;
	}>;
}

/** Default runner: no shell, so a command string is never word-split. */
export const defaultCommandRunner: CommandRunner = (command, cwd, signal) =>
	new Promise((resolve, reject) => {
		// `shell: false` on purpose. With a shell, a command containing `;` or
		// `&&` would run something the user never approved as one action.
		const child = spawn(command, {
			cwd,
			shell: false,
			stdio: ['ignore', 'pipe', 'pipe'],
			...(signal !== undefined ? { signal } : {}),
			windowsHide: true,
		});

		let stdout = '';
		let stderr = '';
		let aborted = false;

		child.stdout?.on('data', (chunk: Buffer) => {
			stdout += chunk.toString('utf8');
		});
		child.stderr?.on('data', (chunk: Buffer) => {
			stderr += chunk.toString('utf8');
		});
		child.on('error', (error) => {
			reject(new AgentError(`Could not run "${command}": ${error.message}`));
		});
		child.on('close', (code, terminationSignal) => {
			if (terminationSignal !== null || aborted) {
				resolve({ exitCode: code ?? -1, stdout, stderr, aborted: true });
				return;
			}
			resolve({ exitCode: code ?? 0, stdout, stderr, aborted: false });
		});

		signal?.addEventListener('abort', () => {
			aborted = true;
			child.kill();
		});
	});

/**
 * Runs a command in the workspace.
 *
 * A non-zero exit is a *result*, not a failure: the model asked the command to
 * do something and the answer is that it exited 1 with output. Only a failure
 * to launch at all is `ok: false`.
 *
 * The runner is injected so tests never spawn a real process, and so a future
 * host can impose its own policy (a sandbox, a resource limit) without this
 * file changing.
 */
export function createRunCommandTool(runner: CommandRunner = defaultCommandRunner): AgentTool<unknown, CommandOutcome> {
	const descriptor: ToolDescriptor = {
		id: RUN_COMMAND,
		name: RUN_COMMAND,
		category: 'terminal',
		riskLevel: 'dangerous',
		description: 'Run a program in the project directory and capture its output',
	};
	return {
		descriptor,
		async execute(input, context): Promise<ToolResult<CommandOutcome>> {
			try {
				const workspace = requireWorkspace(context, RUN_COMMAND);
				const command = argString(input, 'command');
				// Resolve the workspace so the child cannot start somewhere else,
				// then report the path relative to it when we know it.
				const cwd = await workspace.realRootForExecution();
				const outcome = await runner(command, cwd, context.signal);
				return {
					ok: true,
					output: {
						command,
						cwd: relative(workspace.root, cwd) || '.',
						exitCode: outcome.exitCode,
						stdout: outcome.stdout,
						stderr: outcome.stderr,
						aborted: outcome.aborted,
					},
				};
			} catch (error) {
				return failure(error);
			}
		},
	};
}

/** Specs for the four tools, in the shape the model receives. */
export const MVP_TOOL_SPECS: readonly ToolSpec[] = [
	{
		name: READ_FILE,
		description: 'Read a UTF-8 text file from the project',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Path to the file, relative to the project root' },
			},
			required: ['path'],
		},
		riskLevel: 'safe',
		category: 'filesystem',
	},
	{
		name: WRITE_FILE,
		description: 'Write a UTF-8 text file to the project, creating it if needed',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Path to the file, relative to the project root' },
				content: { type: 'string', description: 'The full text to write' },
			},
			required: ['path', 'content'],
		},
		riskLevel: 'moderate',
		category: 'filesystem',
	},
	{
		name: LIST_FILES,
		description: 'List the files and directories at a path inside the project',
		parameters: {
			type: 'object',
			properties: {
				path: {
					type: 'string',
					description: 'Directory to list, relative to the project root. Omit for the root.',
				},
			},
		},
		riskLevel: 'safe',
		category: 'filesystem',
	},
	{
		name: RUN_COMMAND,
		description: 'Run a program in the project directory and capture its output',
		parameters: {
			type: 'object',
			properties: {
				command: { type: 'string', description: 'The program to run, with its arguments' },
			},
			required: ['command'],
		},
		riskLevel: 'dangerous',
		category: 'terminal',
	},
];

/** The four MVP tools, ready to register. */
export function createMvpTools(runner?: CommandRunner, crossProcessWaitMs?: number): readonly AgentTool[] {
	return [
		createReadFileTool(),
		createWriteFileTool({ ...(crossProcessWaitMs !== undefined ? { crossProcessWaitMs } : {}) }),
		createListFilesTool(),
		createRunCommandTool(runner),
	];
}