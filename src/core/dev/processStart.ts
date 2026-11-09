/**
 * Quando um processo começou, pelo sistema operacional (DEV-2.2).
 *
 * ## Por que isso importa
 *
 * O PID sozinho não identifica um processo: o sistema o reaproveita. Uma
 * trava abandonada cujo dono `4212` morreu e cujo PID foi reciclado por outro
 * programa pareceria "viva" para sempre — ou pior, a recuperação desistiria
 * de uma trava realmente órfã. O momento de criação **junto** do PID é a
 * identidade: um processo novo tem outro instante.
 *
 * ## Como é lido
 *
 * - **Windows**: `Get-CimInstance Win32_Process` (o projeto já usa CIM em
 *   outro lugar)? Não: aqui se usa `wmic`/PowerShell? Também não — ambos são
 *   pesados e podem faltar. O caminho usado é `GetProcessTimes` via
 *   `node:child_process` com `tasklist`? Nenhum deles dá o instante.
 *
 *   A escolha é **PowerShell com `Get-Process`**, que existe em todo Windows
 *   suportado, com um prazo curto e resultado em milissegundos:
 *   `(Get-Process -Id <pid>).StartTime.ToUniversalTime()`.
 * - **Linux**: `/proc/<pid>/stat`, campo 22 (`starttime`), em ticks desde o
 *   boot, convertido com o `btime` de `/proc/stat`.
 *
 * Quando a leitura não é possível, a resposta é `undefined` — "não sei". Quem
 * decide o que fazer com "não sei" é o chamador, e a regra aqui é a mesma do
 * resto do projeto: **não sei não é prova de vivo**, mas também não é licença
 * para apagar uma trava de alguém.
 */

import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';

/** O tempo máximo que uma leitura pode levar. */
const LOOKUP_TIMEOUT_MS = 2_000;

/**
 * O instante de criação do processo, em ms desde a época, ou `undefined`.
 *
 * Nunca lança: um processo que já morreu, uma plataforma sem a fonte de dados,
 * um utilitário ausente — todos são "não sei".
 */
export async function processStartedAtMs(
	pid: number,
	options: { readonly platform?: NodeJS.Platform; readonly run?: (command: string, args: readonly string[]) => Promise<string> } = {},
): Promise<number | undefined> {
	if (!Number.isInteger(pid) || pid <= 0) {
		return undefined;
	}
	const platform = options.platform ?? process.platform;
	if (platform === 'linux') {
		return await linuxStartMs(pid);
	}
	if (platform === 'win32') {
		return await windowsStartMs(pid, options.run ?? runCommand);
	}
	return undefined;
}

async function linuxStartMs(pid: number): Promise<number | undefined> {
	try {
		const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
		// O campo 2 (`comm`) pode ter espaços e parênteses: o corte é o último
		// `)`, e a contagem dos campos começa depois dele.
		const close = stat.lastIndexOf(')');
		if (close < 0) {
			return undefined;
		}
		const fields = stat.slice(close + 2).split(' ');
		// Desde o `)` o primeiro campo é o 3 (`state`); `starttime` é o 22,
		// então o índice é 19 na fatia.
		const startTimeTicks = Number(fields[19]);
		if (!Number.isFinite(startTimeTicks)) {
			return undefined;
		}
		const btime = await readFile('/proc/stat', 'utf8')
			.then((raw) => {
				const match = /^btime\s+(\d+)$/m.exec(raw);
				return match === null ? undefined : Number(match[1]) * 1000;
			})
			.catch(() => undefined);
		if (btime === undefined) {
			return undefined;
		}
		// `_SC_CLK_TCK` é 100 em todas as arquiteturas que o Node suporta.
		return Math.round(btime + (startTimeTicks / 100) * 1000);
	} catch {
		return undefined;
	}
}

async function windowsStartMs(
	pid: number,
	run: (command: string, args: readonly string[]) => Promise<string>,
): Promise<number | undefined> {
	try {
		const raw = await run('powershell', [
			'-NoProfile',
			'-NonInteractive',
			'-Command',
			`(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.ToUniversalTime().ToString('o')`,
		]);
		const text = raw.trim();
		if (text.length === 0) {
			return undefined;
		}
		const parsed = Date.parse(text);
		return Number.isFinite(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/** Executa e devolve a saída, com prazo. */
function runCommand(command: string, args: readonly string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			command,
			args,
			{ timeout: LOOKUP_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 },
			(error, stdout) => {
				if (error) {
					reject(error);
					return;
				}
				resolve(stdout);
			},
		);
	});
}
