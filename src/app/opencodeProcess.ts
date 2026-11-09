/**
 * O processo e a CLI: as duas coisas que o gerenciador não pode inventar.
 *
 * ## A senha, e a ordem
 *
 * `startOpencodeServer` recusa nascer sem senha. Não há caminho em que o
 * servidor suba sem `OPENCODE_SERVER_PASSWORD` no ambiente do filho — está
 * escrito uma linha antes do `spawn`, isolado num teste que confere o ambiente
 * recebido.
 *
 * A senha é gerada pelo gerenciador, passa por aqui só como argumento e vai
 * para o ambiente do processo filho. Ela não aparece em `argv` (que outro
 * processo da máquina poderia ler), não vai para o log e não é guardada.
 *
 * ## A CLI
 *
 * `detectOpencodeCli` procura o binário em `PATH` (`opencode` ou
 * `opencode.exe`) e pergunta a versão com `--version`, com timeout. É só isso:
 * nenhum `providers list`, nenhum `auth.json` — a detecção não olha
 * credencial.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, join, normalize, sep } from 'node:path';
import type { ManagedProcess } from './opencodeManager';

/** O tempo máximo da consulta de versão. */
const CLI_PROBE_TIMEOUT_MS = 10_000;

/**
 * O caminho da CLI, ou `undefined`.
 *
 * ## O caso que importa no Windows
 *
 * O `npm i -g opencode-ai` não põe um `opencode.exe` no `PATH`: põe um
 * `opencode.cmd` (e um `.ps1`) que chama
 * `node_modules/opencode-ai/bin/opencode.exe`. Um `spawn` sem shell não
 * executa `.cmd` — e usar shell transformaria os argumentos em linha de
 * comando, onde `&` e `|` viram comando.
 *
 * Por isso o shim é **lido**, não executado: se ele tem a forma que o npm
 * gera — e chama um `.exe` que existe — é esse `.exe` que a Evelyn usa. Uma
 * linha fora dessa forma (um `|`, um `>`, um segundo comando, dois caminhos)
 * faz a CLI aparecer como não encontrada, em vez de ser executada às cegas.
 *
 * ## A saída manual
 *
 * `SESHYINA_OPENCODE_BIN` aponta um `.exe` explícito para quem instalou fora
 * do `PATH`. A página nunca informa caminho nenhum.
 */
export function findOpencodeBinary(
	env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
	const configured = env['SESHYINA_OPENCODE_BIN'];
	if (configured !== undefined && configured.trim().length > 0) {
		const trimmed = configured.trim();
		return isExecutable(trimmed) ? trimmed : undefined;
	}
	const names = process.platform === 'win32' ? ['opencode.exe', 'opencode.cmd'] : ['opencode'];
	const pathValue = env['PATH'] ?? env['Path'] ?? '';
	for (const folder of pathValue.split(delimiter)) {
		if (folder.trim().length === 0) {
			continue;
		}
		for (const name of names) {
			const candidate = join(folder, name);
			if (!existsSync(candidate)) {
				continue;
			}
			if (name.endsWith('.cmd')) {
				const target = resolveCmdShim(candidate);
				if (target !== undefined) {
					return target;
				}
				continue;
			}
			return candidate;
		}
	}
	return undefined;
}

/** O `.exe` que um shim `.cmd` do npm chama, ou `undefined` se não for o caso. */
export function resolveCmdShim(shimPath: string): string | undefined {
	let content: string;
	try {
		content = readFileSync(shimPath, 'utf8');
	} catch {
		return undefined;
	}
	// O npm gera o shim com esta forma: um `@ECHO off`, um `GOTO start`, o
	// `:find_dp0`, e no fim **uma** linha chamando o `.exe` com `%*`. Nada mais.
	// Qualquer linha que não esteja nesse formato é motivo para recusar: um
	// `|`, um `>`, um `&` ou um segundo comando tornam o shim impróprio.
	const accepted = /^\s*(@echo off|goto start|:find_dp0|:start|setlocal|call :find_dp0|set dp0=%~dp0|exit \/b|@?setlocal enableextensions|@?setlocal enabledelayedexpansion|"?"[^"\r\n]*\.exe"?\s+%\*\s*)$/i;
	for (const line of content.split(/\r?\n/)) {
		if (line.trim().length === 0) {
			continue;
		}
		if (!accepted.test(line)) {
			return undefined;
		}
	}
	const matches = [...content.matchAll(/"([^"\r\n]+\.exe)"/gi)].map((match) => match[1]);
	if (matches.length !== 1) {
		return undefined;
	}
	const target = normalize(matches[0].replace(/%dp0%/gi, dirnameOf(shimPath)));
	return isExecutable(target) ? target : undefined;
}

/** O diretório de um arquivo, sem resolver o link do caminho. */
function dirnameOf(filePath: string): string {
	return filePath.slice(0, filePath.lastIndexOf(sep) + 1);
}

/** O caminho aponta um `.exe` existente (o único que rodamos sem shell)? */
function isExecutable(filePath: string): boolean {
	if (!existsSync(filePath)) {
		return false;
	}
	return process.platform !== 'win32' || filePath.toLowerCase().endsWith('.exe');
}

/** Roda um binário e devolve a saída, com timeout. Nunca rejeita sem motivo. */
function runOnce(
	binary: string,
	args: readonly string[],
	timeoutMs: number,
): Promise<{ readonly code: number | null; readonly stdout: string }> {
	return new Promise((resolve, reject) => {
		execFile(
			binary,
			[...args],
			{ timeout: timeoutMs, windowsHide: true, env: process.env, maxBuffer: 64 * 1024 },
			(error, stdout, stderr) => {
				if (error !== null) {
					// Saída não vazia com código de erro: a mensagem interessa
					// mais que o código.
					const text = `${stdout}${stderr}`.trim();
					reject(new Error(text.length > 0 ? text.slice(0, 200) : error.message));
					return;
				}
				resolve({ code: 0, stdout: String(stdout) });
			},
		);
	});
}

/**
 * A versão da CLI, ou `undefined` quando ela não está instalada nem responde.
 *
 * Só `--version` é executado. Nada de `providers`, nada de `models`.
 */
export async function detectOpencodeCli(
	options: {
		readonly binary?: string;
		readonly env?: Readonly<Record<string, string | undefined>>;
		readonly timeoutMs?: number;
	} = {},
): Promise<string | undefined> {
	const binary = options.binary ?? findOpencodeBinary(options.env ?? process.env);
	if (binary === undefined) {
		return undefined;
	}
	try {
		const { stdout } = await runOnce(binary, ['--version'], options.timeoutMs ?? CLI_PROBE_TIMEOUT_MS);
		const version = stdout.trim().split(/\r?\n/)[0]?.trim() ?? '';
		return version.length > 0 ? version : 'unknown';
	} catch {
		return undefined;
	}
}

/** O que `startOpencodeServer` precisa. */
export interface StartOpencodeServerOptions {
	readonly binary: string;
	readonly port: number;
	/** A senha. Vazia é recusada — o servidor não sobe aberto. */
	readonly password: string;
	/** Saída do processo, para o log do gerenciador (nunca a senha). */
	readonly onOutput?: (line: string) => void;
}

/**
 * Inicia `opencode serve` em loopback.
 *
 * ## Por que sem `shell`
 *
 * `shell: true` faria o navegador/usuário comandar um interpretador: o
 * argumento passaria pela linha de comando do `cmd.exe`, onde `&` e `|` viram
 * comandos. Sem shell, os argumentos são um vetor e só isso.
 *
 * ## O que o processo recebe
 *
 * `OPENCODE_SERVER_PASSWORD` — e nada mais da senha. A porta e o hostname vão
 * em `argv`, que não é segredo.
 */
export function startOpencodeServer(options: StartOpencodeServerOptions): ManagedProcess {
	const password = options.password;
	if (password.length === 0) {
		throw new Error('o servidor OpenCode não pode iniciar sem senha');
	}
	if (!Number.isInteger(options.port) || options.port <= 0 || options.port > 65535) {
		throw new Error('porta inválida para o servidor OpenCode');
	}

	let child: ChildProcess;
	try {
		child = spawn(
			options.binary,
			['serve', '--hostname', '127.0.0.1', '--port', String(options.port)],
			{
				// O ambiente é herdado e a senha é acrescentada: o OpenCode
				// precisa do PATH e da própria configuração para achar a CLI.
				env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
				stdio: ['ignore', 'pipe', 'pipe'],
				windowsHide: true,
				shell: false,
			},
		);
	} catch (error) {
		throw new Error(error instanceof Error ? error.message : String(error));
	}

	let settled = false;
	let resolveExited: () => void = () => undefined;
	const exited = new Promise<void>((resolve) => {
		resolveExited = () => {
			if (!settled) {
				settled = true;
				resolve();
			}
		};
	});

	child.on('error', () => {
		resolveExited();
	});
	child.on('exit', () => {
		resolveExited();
	});

	// As linhas ficam só para o log, com a senha removida caso ela apareça —
	// o OpenCode não a imprime, mas o filtro é barato. As últimas linhas são
	// guardadas em memória: é delas que sai o motivo real de uma falha de
	// início (um `ServeError` por porta ocupada, por exemplo).
	let recent = '';
	let outBuffer = '';
	const forward = (chunk: Buffer): void => {
		outBuffer += chunk.toString('utf8');
		const lines = outBuffer.split(/\r?\n/);
		outBuffer = lines.pop() ?? '';
		for (const line of lines) {
			const clean = line.replace(new RegExp(escapeRegExp(password), 'g'), '[redigido]').trim();
			if (clean.length > 0) {
				recent = `${recent}\n${clean}`.slice(-2_000);
				options.onOutput?.(clean);
			}
		}
	};
	child.stdout?.on('data', forward);
	child.stderr?.on('data', forward);

	return {
		pid: child.pid,
		exited,
		lastOutput: () => recent,
		kill(): void {
			if (child.exitCode !== null || child.signalCode !== null) {
				return;
			}
			try {
				// Só este processo, e só a árvore dele: o `opencode` pode ter
				// filhos próprios, e nenhum outro processo da máquina é tocado.
				child.kill();
			} catch {
				// Já morto.
			}
		},
	};
}

/** Escapa um texto para uso literal numa RegExp. */
function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
