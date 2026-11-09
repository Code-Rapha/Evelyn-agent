/**
 * A execução de comandos do modo DEV (DEV-2).
 *
 * ## Por que não é o `run_command`
 *
 * `run_command` roda **um binário** (`shell:false`) sem timeout próprio e sem
 * allowlist: serve para o agente investigar um projeto, não para o agente
 * executar as verificações que decidem se a mudança dele está boa. Aqui a
 * política é explícita e estreita: alguns binários, com argumentos validados,
 * prazo obrigatório, teto de saída e a árvore de processos morta no fim.
 *
 * ## O que a allowlist é (e não é)
 *
 * É uma lista de **binários** com **subcomandos** permitidos. `npm` só pode
 * rodar scripts do projeto; `node` só pode rodar um arquivo do repositório
 * (nunca `-e`, nunca `--eval`, nunca `-p`, que executam código arbitrário);
 * `git` só pode consultar (`status`, `diff`, `rev-parse`, `log`) e nunca
 * escrever. `npx` fica de fora de propósito: ele baixa e executa qualquer
 * pacote.
 *
 * `shell:false` é a primeira barreira, não a única: com allowlist, um
 * `&` ou `;` no argumento é só mais um argumento.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';

import { redactCommand, type DevAuditRecord, type DevAuditSink } from './devAudit';

/** Como um comando do DEV pode terminar. */
export interface DevCommandOutcome {
	readonly command: string;
	readonly exitCode: number;
	readonly durationMs: number;
	readonly stdout: string;
	readonly stderr: string;
	/** `true` quando o prazo ou o cancelamento o encerrou. */
	readonly aborted: boolean;
	/** `true` quando a saída passou do teto e foi cortada. */
	readonly truncated: boolean;
	/**
	 * Por que o processo terminou (DEV-9.1).
	 *
	 * Distinto de `exitCode`: um comando que falha sozinho (`exit 1`) e um
	 * que o runner matou por prazo têm os dois códigos, mas o **motivo** é
	 * outro — e a interface precisa dizer qual foi.
	 */
	readonly termination: DevTermination;
	/**
	 * Aviso quando o processo **não** terminou depois do encerramento forçado.
	 *
	 * Presente só nesse caso: quem lê o resultado precisa saber que pode haver
	 * um processo órfão em execução, em vez de assumir que o prazo funcionou.
	 */
	readonly abortWarning?: string;
}

/** Como uma execução terminou. */
export type DevTermination =
	/** O processo saiu por conta própria (código de saída normal). */
	| 'exited'
	/** O prazo do runner venceu. */
	| 'timeout'
	/** O turno foi cancelado (stop, sessão encerrada, saída do DEV). */
	| 'cancelled'
	/** O processo morreu por sinal (Windows: código exótico/abrupto). */
	| 'killed'
	/** O processo não pôde ser iniciado (binário ausente, contexto inválido). */
	| 'failed';

/** A recusa de um comando que a política não permite. */
export class DevCommandRefusedError extends Error {
	readonly code = 'dev_command_refused';
	constructor(message: string) {
		super(message);
		this.name = 'DevCommandRefusedError';
	}
}

/** O teto de saída, somando stdout e stderr. */
export const DEFAULT_OUTPUT_LIMIT_BYTES = 256 * 1024;
/**
 * O teto absoluto da saída (DEV-9.1).
 *
 * O host pode pedir menos; não mais. Sem esse teto, um `outputLimitBytes`
 * injetado seria a forma de despejar memória de dentro de um processo.
 */
export const MAX_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;
/** O prazo padrão de um comando. */
export const DEFAULT_TIMEOUT_MS = 10 * 60_000;
/** O teto absoluto do prazo (DEV-9.1): um dia inteiro segurando o repositório não é verificável. */
export const MAX_TIMEOUT_MS = 60 * 60_000;

/** O que a aprovação mostra antes de executar. */
export interface DevApprovalRequest {
	/** O comando, já redigido. */
	readonly command: string;
	/** O diretório de trabalho. */
	readonly cwd: string;
	/** O que o comando pode fazer, em uma linha. */
	readonly scope: string;
	/** O prazo que valerá. */
	readonly timeoutMs: number;
}

/** A decisão da pessoa. */
export type DevApprovalDecision = 'approved' | 'refused' | 'cancelled';

/** Opções de uma execução, por chamada. */
export interface DevRunOptions {
	/** A pergunta da aprovação. Ausente = sem pergunta (compatibilidade). */
	readonly approve?: (request: DevApprovalRequest) => Promise<DevApprovalDecision>;
	/** O diário da execução. Default: o do runner, se houver. */
	readonly audit?: DevAuditSink;
	/** Prazo desta execução (limitado a `MAX_TIMEOUT_MS`). */
	readonly timeoutMs?: number;
}

/**
 * O escopo, em uma linha, para a aprovação.
 *
 * É o que o comando **declara** fazer, não uma garantia: `npm run test` pode
 * executar qualquer coisa que o `package.json` mandar. A frase diz isso de
 * propósito — uma promessa maior seria mentira.
 */
export function describeScope(argv: readonly string[]): string {
	const binary = String(argv[0] ?? '');
	const first = String(argv[1] ?? '');
	if (binary === 'npm' && (first === 'test' || first === 'ci')) {
		return 'executa os testes declarados no package.json (pode rodar qualquer código do projeto)';
	}
	if (binary === 'npm' && first === 'run') {
		return `executa o script "${String(argv[2] ?? '')}" do package.json (pode rodar qualquer código do projeto)`;
	}
	if (binary === 'git') {
		return `consulta somente leitura do repositório (${first})`;
	}
	if (binary === 'tsc') {
		return 'checagem de tipos, sem emitir arquivos';
	}
	if (binary === 'node') {
		return `executa o arquivo "${String(argv[1] ?? '')}" do repositório (pode tocar qualquer arquivo do usuário)`;
	}
	return 'análise estática do projeto';
}

interface Rule {
	/** Argumentos que podem começar a linha (subcomandos e flags de consulta). */
	readonly allow: readonly (readonly string[])[];
	/** Estado de arquivo exigido, quando houver. */
	readonly mustBeFile?: 'package.json';
}

/**
 * A allowlist.
 *
 * Cada entrada é um binário e a **sequência exata** de argumentos que ele
 * aceita. Uma sequência vazia significa "o binário, sem argumento" (só
 * `git status` curto usa isso).
 */
const ALLOWLIST: Readonly<Record<string, Rule>> = {
	npm: {
		allow: [
			['test'],
			['run'],
			['ci'],
		],
	},
	node: {
		allow: [],
		mustBeFile: 'package.json',
	},
	git: {
		allow: [['status'], ['diff'], ['rev-parse'], ['log'], ['show']],
	},
	tsc: {
		allow: [['--noEmit'], ['-p']],
	},
	eslint: {
		allow: [],
	},
};

/** Scripts que o `npm run` pode executar. Nada de `postinstall` alheio. */
const ALLOWED_NPM_SCRIPTS = new Set([
	'test:core',
	'test',
	'check-types',
	'lint',
	'web:build',
	'desktop:build',
	'compile-tests',
	'compile',
]);

/**
 * Argumentos que transformam um binário permitido em execução arbitrária.
 *
 * `node script.js` é aceitável; `node -e "…"`, `node --eval`, `node -p`,
 * `node --import` não. `npm exec`/`npm x` baixam e executam pacotes, e
 * `git` com `-c` pode rodar um comando de configuração arbitrário.
 */
const FORBIDDEN_TOKENS: ReadonlySet<string> = new Set([
	'-e',
	'--eval',
	'-p',
	'--print',
	'--import',
	'--loader',
	'-r',
	'--require',
	'exec',
	'x',
	'-c',
	'-C',
	'--exec-path',
	'--upload-pack',
	'--receive-pack',
]);

/** Opções do runner. Injetáveis para o teste medir sem esperar de verdade. */
export interface DevRunnerOptions {
	readonly timeoutMs?: number;
	readonly outputLimitBytes?: number;
	/** Prazo curto para o teste do timeout. */
	readonly killGraceMs?: number;
	/**
	 * Onde procurar o binário, quando não é caminho absoluto.
	 *
	 * Padrão: o `PATH` do processo. Injetável para o teste provar a resolução
	 * de `.cmd` sem depender do Node instalado na máquina.
	 */
	readonly path?: string;
	/** O `PATHEXT` a usar no Windows. Injetável pelo mesmo motivo. */
	readonly pathExt?: string;
	/** Arquivo a executar em vez do que o `spawn` escolheria. Só para teste. */
	readonly fileExists?: (candidate: string) => Promise<boolean>;
	/** O diário das execuções. Ausente = sem registro. */
	readonly audit?: DevAuditSink;
}

/**
 * Os argumentos apontam para **fora do repositório**? Se sim, recusa.
 *
 * A allowlist decide **qual binário**; ela não diz o que esse binário vai
 * tocar. `node ler.js C:\Users\…\owner-credential.json` era aceito e o
 * arquivo era lido (DEV-AUDIT-01): o comando era permitido, o arquivo não.
 * Esta função fecha a passagem do caminho pela linha de comando sem tirar do
 * DEV o que ele precisa:
 *
 * - caminho absoluto POSIX (`/etc/passwd`) ou Windows (`C:\…`, `\\servidor`);
 * - caminho que sobe acima da raiz com `..` (`../../x`);
 * - URI com esquema (`https://…`, `file:///…`) fora do checkout.
 *
 * Caminho **relativo** continua aceito: o processo roda com `cwd` na raiz, e
 * o que fica dentro dela é o alvo legítimo de um teste ou build.
 *
 * ## O que isto **não** garante
 *
 * Não é sandbox. Um script permitido pode montar o caminho em tempo de
 * execução (`require('fs').readFileSync(process.env.X)`) e abrir qualquer
 * arquivo. O que aqui se garante é que o **modelo** não consegue nomear o
 * caminho do lado de fora na linha de comando. Confinamento real exigiria
 * um mecanismo de sistema operacional (Job Object/AppContainer no Windows),
 * que não existe neste projeto — a limitação fica registrada aqui e no
 * relatório do modo DEV.
 */
export function assertArgumentsInsideRepository(argv: readonly string[], root: string): void {
	const base = resolve(root);
	const baseKey = process.platform === 'win32' ? base.toLowerCase() : base;
	for (const arg of argv.slice(1)) {
		// Flags não são caminhos (`--noEmit`, `-p`, `--porcelain`).
		if (arg.startsWith('-')) {
			continue;
		}
		if (/^[a-z][a-z0-9+.-]*:\/\//i.test(arg) && !/^[a-z]:[\\/]/i.test(arg)) {
			if (!fileUrlInside(base, arg)) {
				throw new DevCommandRefusedError(
					`o argumento "${arg}" é uma URL; o modo DEV não abre recursos externos por comando`,
				);
			}
			continue;
		}
		if (isAbsolute(arg) || /^[a-z]:[\\/]/i.test(arg) || arg.startsWith('\\\\')) {
			throw new DevCommandRefusedError(
				`o argumento "${arg}" é um caminho absoluto; comandos do DEV só tocam o repositório`,
			);
		}
		const resolved = resolve(base, arg);
		const resolvedKey = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
		if (resolvedKey !== baseKey && !resolvedKey.startsWith(`${baseKey}${sep}`)) {
			throw new DevCommandRefusedError(
				`o argumento "${arg}" aponta para fora do repositório (${resolved})`,
			);
		}
	}
}

/** Uma URL `file:` apontando para dentro do checkout. */
function fileUrlInside(root: string, arg: string): boolean {
	if (!/^file:\/\//i.test(arg)) {
		return false;
	}
	try {
		const path = decodeURIComponent(new URL(arg).pathname).replace(/^\//, '');
		const resolved = resolve(root, path);
		const rootKey = process.platform === 'win32' ? root.toLowerCase() : root;
		const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
		return key === rootKey || key.startsWith(`${rootKey}${sep}`);
	} catch {
		return false;
	}
}

/**
 * Como um binário permitido será executado.
 *
 * No POSIX é o próprio caminho. No Windows, um `.cmd`/`.bat` **não pode** ser
 * executado com `shell:false` — ver `resolveCommand`.
 */
export interface ResolvedCommand {
	/** O arquivo a executar. */
	readonly file: string;
	/** Os argumentos, já com o comando original quando passa pelo `cmd.exe`. */
	readonly args: readonly string[];
	/** `true` quando o Windows interpreta a linha (`windowsVerbatimArguments`). */
	readonly viaShell: boolean;
}

/**
 * Acha o binário real, aplicando `PATHEXT` no Windows.
 *
 * ## Por que o `spawn` sozinho não basta
 *
 * Com `shell: false`, o Node procura o arquivo **exato** — não aplica o
 * `PATHEXT` que o `cmd.exe` aplicaria. O diretório do Node tem `npm`,
 * `npm.cmd` e `npm.ps1`; o `npm` sem extensão é um script *sh* que o Windows
 * não executa, e o `spawn` do nome puro devolve `ENOENT`.
 */
async function resolveBinary(
	binary: string,
	options: DevRunnerOptions,
): Promise<string> {
	const isWindows = process.platform === 'win32';
	const exists = options.fileExists ?? defaultFileExists;
	// Um caminho já resolvido não é procurado no PATH.
	if (isAbsolute(binary) || binary.includes('/') || (isWindows && binary.includes('\\'))) {
		if (await exists(binary)) {
			return binary;
		}
		throw new DevCommandRefusedError(`o programa "${binary}" não existe`);
	}
	const directories = (options.path ?? process.env['PATH'] ?? '')
		.split(isWindows ? ';' : ':')
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	const extensions = isWindows
		? (options.pathExt ?? process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD')
				.split(';')
				.map((entry) => entry.trim().toLowerCase())
				.filter((entry) => entry.length > 0)
		: [''];
	for (const directory of directories) {
		for (const extension of extensions) {
			const candidate = join(directory, binary + extension);
			if (await exists(candidate)) {
				return candidate;
			}
		}
	}
	throw new DevCommandRefusedError(
		`"${binary}" não foi encontrado no PATH; o modo DEV não executa nada fora dele`,
	);
}

async function defaultFileExists(candidate: string): Promise<boolean> {
	const found = await stat(candidate).catch(() => undefined);
	return found !== undefined && found.isFile();
}

/**
 * Quote for `cmd.exe /s /c`.
 *
 * ## Por que a linha vai entre aspas
 *
 * `/s` manda o `cmd` tratar **todo** o texto até a última aspas como o comando,
 * e remover só a primeira e a última. Sem um par externo, um caminho com espaço
 * (`C:\Program Files\nodejs\npm.cmd`) seria partido no espaço e a partir da
 * segunda aspas o `cmd` passaria a interpretar metacaracteres.
 *
 * ## O que é recusado
 *
 * `"%^!` expandem ou delimitam **antes** de qualquer escape valer. A allowlist
 * já não os aceita; recusá-los de novo aqui é a segunda barreira, e é a diferença
 * entre "não deveria" e "não consegue".
 */
function quoteForCmd(parts: readonly string[]): string {
	for (const part of parts) {
		if (/["%!^]/.test(part)) {
			throw new DevCommandRefusedError(
				`o argumento "${part}" tem caracteres que o shell do Windows interpreta`,
			);
		}
	}
	return `"${parts.map((part) => `"${part}"`).join(' ')}"`;
}

/**
 * Escolhe como executar o binário permitido, já validado.
 *
 * ## Windows: `.cmd`/`.bat` passam pelo `cmd.exe`
 *
 * Desde o endurecimento do `child_process` (CVE-2024-27980), o Node **recusa**
 * `.bat`/`.cmd` com `shell:false` (`EINVAL`), porque a execução de um batch
 * passa pelo `cmd.exe` de qualquer jeito, e sem escape correto um argumento
 * com `&` rodaria outro comando. O caminho suportado é o mesmo que o próprio
 * Node usa no modo `shell: true`: `cmd.exe /d /s /c "…"`.
 *
 * `.exe` e caminhos já executáveis seguem direto — nenhum shell no meio.
 */
export async function resolveCommand(
	binary: string,
	rest: readonly string[],
	options: DevRunnerOptions = {},
): Promise<ResolvedCommand> {
	const file = await resolveBinary(binary, options);
	const isWindows = process.platform === 'win32';
	const lower = file.toLowerCase();
	if (isWindows && (lower.endsWith('.cmd') || lower.endsWith('.bat'))) {
		const comspec = process.env['ComSpec'] ?? 'C:\\WINDOWS\\system32\\cmd.exe';
		return {
			file: comspec,
			args: ['/d', '/s', '/c', quoteForCmd([file, ...rest])],
			viaShell: true,
		};
	}
	return { file, args: rest, viaShell: false };
}

/**
 * Decide se um comando pode rodar, **sem executar**.
 *
 * Exportado para o teste provar a política sem iniciar processo nenhum.
 * Devolve o `argv` validado: o mesmo que o runner vai passar ao `spawn`.
 */
export function validateDevCommand(command: string): readonly string[] {
	const trimmed = command.trim();
	if (trimmed.length === 0) {
		throw new DevCommandRefusedError('o comando está vazio');
	}
	// `shell:false` não interpreta `;` nem `|`, mas um comando composto é
	// sintoma de que o modelo quis driblar a lista de um só passo.
	if (/[;&|`$><\n\r]/.test(trimmed)) {
		throw new DevCommandRefusedError(
			'o comando tem caracteres de encadeamento ou redirecionamento; use um passo por chamada',
		);
	}
	const argv = trimmed.split(/\s+/);
	const binary = argv[0] as string;
	const rule = ALLOWLIST[binary];
	if (rule === undefined) {
		throw new DevCommandRefusedError(
			`"${binary}" não está na lista de comandos permitidos do modo DEV`,
		);
	}
	const rest = argv.slice(1);
	for (const token of rest) {
		if (FORBIDDEN_TOKENS.has(token)) {
			throw new DevCommandRefusedError(`o argumento "${token}" não é permitido em "${binary}"`);
		}
	}

	if (binary === 'node') {
		const script = rest[0];
		if (script === undefined || script.startsWith('-')) {
			throw new DevCommandRefusedError(
				'node só pode rodar um arquivo; avaliação inline (-e, -p, --import) não é permitida',
			);
		}
		return [binary, ...rest];
	}

	if (binary === 'npm') {
		const sub = rest[0];
		if (sub === 'run') {
			const script = rest[1];
			if (script === undefined || !ALLOWED_NPM_SCRIPTS.has(script)) {
				throw new DevCommandRefusedError(
					`o script "${String(script)}" não está na lista permitida do modo DEV`,
				);
			}
			return [binary, ...rest];
		}
		if (sub === 'test' || sub === 'ci') {
			return [binary, ...rest];
		}
		throw new DevCommandRefusedError(`"npm ${String(sub)}" não é permitido no modo DEV`);
	}

	// `git` só consulta: qualquer subcomando que escreva é recusado.
	if (binary === 'git') {
		const sub = rest[0];
		if (sub === undefined || !rule.allow.some((entry) => entry[0] === sub)) {
			throw new DevCommandRefusedError(
				`"git ${String(sub)}" não é um comando de consulta permitido no modo DEV`,
			);
		}
		// `git diff --output=arquivo` escreve; `--ext-diff` executa um programa.
		for (const token of rest.slice(1)) {
			if (token.startsWith('--output') || token === '--ext-diff' || token === '--textconv') {
				throw new DevCommandRefusedError(`o argumento "${token}" não é permitido em git`);
			}
		}
		return [binary, ...rest];
	}

	if (binary === 'tsc') {
		const flag = rest[0];
		if (flag === '--noEmit') {
			return [binary, ...rest];
		}
		if (flag === '-p') {
			const project = rest[1];
			if (project === undefined || project.startsWith('-')) {
				throw new DevCommandRefusedError('tsc -p precisa do caminho do projeto');
			}
			return [binary, ...rest];
		}
		throw new DevCommandRefusedError(`"tsc ${String(flag)}" não é permitido no modo DEV`);
	}

	// `eslint` sem argumento é aceito: usa a configuração do repositório.
	return [binary, ...rest];
}

/** Um comando executado pelo DEV, com o que se registra dele. */
export interface DevAuditEntry {
	readonly command: string;
	readonly exitCode: number;
	readonly durationMs: number;
	readonly aborted: boolean;
}

/**
 * O runner.
 *
 * Um comando por vez: o DEV não deve rodar dois testes no mesmo repositório
 * enquanto o outro escreve. O `signal` do turno e o `onExit` da sessão
 * cancelam o mesmo processo.
 */
export class DevRunner {
	private running: ChildProcess | undefined;
	/** O cancelamento do comando em andamento: marca `aborted` e mata a árvore. */
	private cancel: (() => void) | undefined;
	/** Contador dos ids do diário. */
	private auditCounter = 0;

	constructor(private readonly options: DevRunnerOptions = {}) {}

	/**
	 * Grava um registro de auditoria, sem deixar a falha dele derrubar a
	 * execução: o diário é observação, não pode virar ponto de falha do
	 * comando que ele observa.
	 */
	private async writeAudit(sink: DevAuditSink | undefined, entry: DevAuditRecord): Promise<void> {
		if (sink === undefined) {
			return;
		}
		try {
			await sink.record(entry);
		} catch {
			// Um diário em disco cheio não pode fazer a verificação falhar.
		}
	}

	/** O comando em andamento, quando há um. */
	isRunning(): boolean {
		return this.running !== undefined && this.running.exitCode === null;
	}

	/**
	 * Roda um comando validado dentro do repositório.
	 *
	 * Lança `DevCommandRefusedError` **antes** de qualquer processo quando a
	 * política recusa. Um `signal` já abortado não inicia nada.
	 *
	 * ## A aprovação (DEV-9.1)
	 *
	 * Quando `options.audit` está presente, a execução **exige** uma
	 * aprovação por comando, apresentada por `options.approve`. A aprovação
	 * traz o comando exato, o diretório e o escopo; o runner confere que ela
	 * corresponde ao que vai executar — uma aprovação de `npm test` não
	 * autoriza `npm run lint`.
	 *
	 * Sem `options.audit`, o `run` tem o comportamento anterior (o host sem
	 * aprovação), e a execução é marcada `not-required` no diário — que é
	 * exatamente o diário ausente nesse caso. É a compatibilidade preservada
	 * para os testes e para o host que ainda não monta a aprovação.
	 */
	async run(
		command: string,
		cwd: string,
		signal?: AbortSignal,
		options: DevRunOptions = {},
	): Promise<DevCommandOutcome> {
		const argv = validateDevCommand(command);
		await assertCwdIsRepository(cwd);
		// O caminho do lado de fora não pode passar pela linha de comando
		// (DEV-AUDIT-01). Antes do processo existir, como a allowlist.
		assertArgumentsInsideRepository(argv, cwd);
		if (signal?.aborted === true) {
			throw new DevCommandRefusedError('o comando foi cancelado antes de começar');
		}
		if (this.isRunning()) {
			throw new DevCommandRefusedError('já há um comando do modo DEV em execução');
		}

		const audit = options.audit ?? this.options.audit;
		const timeoutMs = Math.min(
			options.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			MAX_TIMEOUT_MS,
		);
		const limit = Math.min(
			this.options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES,
			MAX_OUTPUT_LIMIT_BYTES,
		);
		const startedAt = new Date();
		const started = startedAt.getTime();
		const id = `run-${this.auditCounter++}-${started.toString(36)}`;

		// ── aprovação, antes de qualquer processo ────────────────────────
		let approval: DevAuditRecord['approval'] = 'not-required';
		if (options.approve !== undefined) {
			const request: DevApprovalRequest = {
				command: redactCommand(command),
				cwd: resolve(cwd),
				scope: describeScope(argv),
				timeoutMs,
			};
			const decision = await options.approve(request);
			if (decision !== 'approved') {
				approval = decision === 'refused' ? 'refused' : 'cancelled';
				await this.writeAudit(audit, {
					id,
					command: redactCommand(command),
					cwd: resolve(cwd),
					startedAt: startedAt.toISOString(),
					finishedAt: new Date().toISOString(),
					approval,
					durationMs: 0,
					exitCode: null,
					termination: 'failed',
					outputBytes: { stdout: 0, stderr: 0 },
					truncated: false,
					reason: decision === 'refused' ? 'a execução foi recusada' : 'a execução foi cancelada antes de começar',
				});
				throw new DevCommandRefusedError(
					decision === 'refused'
						? 'a execução deste comando foi recusada'
						: 'a execução deste comando foi cancelada antes de começar',
				);
			}
			approval = 'approved';
		}

		// A resolução vem **antes** do spawn: um binário ausente vira recusa
		// clara ("não está no PATH") em vez de um `ENOENT` cru do sistema.
		const resolved = await resolveCommand(argv[0] as string, argv.slice(1), this.options);

		return await new Promise<DevCommandOutcome>((resolveRun, rejectRun) => {
			const child = spawn(resolved.file, [...resolved.args], {
				cwd,
				shell: false,
				stdio: ['ignore', 'pipe', 'pipe'],
				windowsHide: true,
				// Só no caminho do `cmd.exe`: a linha já está entre aspas e não
				// deve ganhar mais uma camada de escape do Node.
				windowsVerbatimArguments: resolved.viaShell,
				// Grupo próprio no Unix, para matar os filhos junto.
				detached: process.platform !== 'win32',
			});
			this.running = child;

			let stdout = '';
			let stderr = '';
			let truncated = false;
			let aborted = false;
			/** O motivo real do encerramento: prazo, cancelamento ou natural. */
			let termination: DevTermination = 'exited';
			/** O processo sobreviveu ao encerramento? Aviso no resultado. */
			let survivedKill = false;

			const finish = (code: number): void => {
				this.running = undefined;
				this.cancel = undefined;
				clearTimeout(timer);
				signal?.removeEventListener('abort', onAbort);
				const durationMs = Date.now() - started;
				if (termination === 'exited' && code < 0) {
					termination = 'killed';
				}
				void this.writeAudit(audit, {
					id,
					command: redactCommand(command),
					cwd: resolve(cwd),
					startedAt: startedAt.toISOString(),
					finishedAt: new Date().toISOString(),
					approval,
					durationMs,
					exitCode: code,
					termination,
					outputBytes: { stdout: Buffer.byteLength(stdout, 'utf8'), stderr: Buffer.byteLength(stderr, 'utf8') },
					truncated,
				});
				resolveRun({
					command,
					exitCode: code,
					durationMs,
					stdout,
					stderr,
					aborted,
					truncated,
					termination,
					...(survivedKill
						? {
								abortWarning:
									'o processo não terminou depois do encerramento forçado; ele pode continuar rodando',
							}
						: {}),
				});
			};

			const kill = (cause: 'timeout' | 'cancelled'): void => {
				aborted = true;
				termination = cause;
				// `killTree` confirma a morte; se o processo sobreviver, o
				// resultado diz isso em vez de fingir que acabou.
				void killTree(child, this.options.killGraceMs ?? 3_000).then((killed) => {
					if (!killed) {
						survivedKill = true;
					}
				});
			};
			this.cancel = () => kill('cancelled');

			const onAbort = (): void => kill('cancelled');
			signal?.addEventListener('abort', onAbort);
			const timer = setTimeout(() => kill('timeout'), timeoutMs);

			const collect = (chunk: Buffer, into: 'out' | 'err'): void => {
				// O teto é sobre **bytes**, não sobre caracteres: um texto
				// multibyte contaria menos que o real se usássemos `.length`.
				const current = Buffer.byteLength(stdout, 'utf8') + Buffer.byteLength(stderr, 'utf8');
				if (current >= limit) {
					truncated = true;
					return;
				}
				const remaining = limit - current;
				const text = chunk.length > remaining ? chunk.subarray(0, remaining).toString('utf8') : chunk.toString('utf8');
				if (chunk.length > remaining) {
					truncated = true;
				}
				if (into === 'out') {
					stdout += text;
				} else {
					stderr += text;
				}
			};
			child.stdout?.on('data', (chunk: Buffer) => collect(chunk, 'out'));
			child.stderr?.on('data', (chunk: Buffer) => collect(chunk, 'err'));

			child.on('error', (error) => {
				this.running = undefined;
				this.cancel = undefined;
				clearTimeout(timer);
				signal?.removeEventListener('abort', onAbort);
				termination = 'failed';
				void this.writeAudit(audit, {
					id,
					command: redactCommand(command),
					cwd: resolve(cwd),
					startedAt: startedAt.toISOString(),
					finishedAt: new Date().toISOString(),
					approval,
					durationMs: Date.now() - started,
					exitCode: null,
					termination: 'failed',
					outputBytes: { stdout: 0, stderr: 0 },
					truncated: false,
					reason: error.message,
				});
				rejectRun(error);
			});
			child.on('close', (code, terminationSignal) => {
				if (terminationSignal !== null) {
					aborted = true;
				}
				finish(aborted ? -1 : (code ?? 0));
			});
		});
	}

	/**
	 * Mata o processo em andamento (usado ao sair da sessão).
	 *
	 * Não lança: sair do DEV não pode falhar por causa de um processo que já
	 * morreu.
	 */
	cancelRunning(): void {
		if (this.running !== undefined) {
			// `onAbort` é o mesmo caminho do prazo: ele marca `aborted` antes de
			// matar. Chamar só `killTree` deixava o resultado parecer uma saída
			// normal (código do sinal), e o teste — e o log — diriam "terminou".
			this.cancel?.();
		}
	}
}

/**
 * Mata o processo **e os filhos**, e devolve se conseguiu.
 *
 * ## Windows
 *
 * Não há grupo de processo. `taskkill /T /F` é o caminho que alcança a árvore,
 * mas ele pode falhar: o utilitário ausente no PATH, um código de saída
 * inesperado (128 quando o processo já morreu, 1 quando não há permissão), ou
 * demora. Por isso:
 *
 * 1. `taskkill` é chamado e **esperado** (até um prazo);
 * 2. o processo é conferido com `kill(pid, 0)` — `EPERM` conta como vivo;
 * 3. se `taskkill` falhou ou não resolveu, `child.kill()` é a segunda tentativa
 *    (mata o processo direto, não a árvore);
 * 4. o resultado diz se o processo ainda estava vivo ao fim.
 *
 * O chamador **não** considera a operação encerrada se o processo sobreviveu:
 * `killTree` devolve `false` nesse caso, e o runner reporta `aborted` com o
 * aviso em vez de fingir que matou.
 */
async function killTree(child: ChildProcess, graceMs: number): Promise<boolean> {
	const pid = child.pid;
	if (pid === undefined) {
		return true;
	}
	if (process.platform === 'win32') {
		await runTaskkill(pid, graceMs);
		if (!alive(pid)) {
			return true;
		}
		// Segunda tentativa: o processo direto. Não alcança netos, mas é o que
		// existe quando o utilitário falhou.
		child.kill('SIGKILL');
		await waitUntilGone(pid, graceMs);
		return !alive(pid);
	}
	try {
		process.kill(-pid, 'SIGKILL');
	} catch {
		child.kill('SIGKILL');
	}
	await waitUntilGone(pid, graceMs);
	return !alive(pid);
}

/** `taskkill /T /F`, esperado, sem depender do código de saída. */
async function runTaskkill(pid: number, graceMs: number): Promise<void> {
	await new Promise<void>((resolve) => {
		let settled = false;
		const done = (): void => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				resolve();
			}
		};
		const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
			stdio: 'ignore',
			windowsHide: true,
		});
		// Códigos de saída do taskkill: 0 sucesso; 128 processo inexistente;
		// 1 acesso negado. Nenhum deles é "o processo morreu", e por isso a
		// decisão vem de `alive()` — o código só é registrado para diagnóstico.
		killer.on('exit', (code) => {
			taskkillExitCodes.set(pid, code);
			done();
		});
		killer.on('error', () => done());
		const timer = setTimeout(done, graceMs);
	});
}

/** Os códigos de saída do último `taskkill` por pid (diagnóstico e teste). */
export const taskkillExitCodes = new Map<number, number | null>();

/** O processo existe? `EPERM` significa que existe e pertence a outro. */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/** Espera o processo sumir, até o prazo. */
async function waitUntilGone(pid: number, graceMs: number): Promise<void> {
	const deadline = Date.now() + graceMs;
	while (Date.now() < deadline) {
		if (!alive(pid)) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

/**
 * O diretório de trabalho é o repositório autorizado?
 *
 * O runner não aceita um `cwd` que seja uma subpasta arbitrária: o único
 * aceitável é a raiz (ou algo dentro dela, nunca a raiz de outro projeto).
 */
async function assertCwdIsRepository(cwd: string): Promise<void> {
	const resolved = resolve(cwd);
	const marker = await stat(join(resolved, '.git')).catch(() => undefined);
	if (marker === undefined) {
		throw new DevCommandRefusedError(
			`o comando rodaria fora do repositório autorizado (${resolved} não tem .git)`,
		);
	}
	if (resolved.endsWith(sep)) {
		throw new DevCommandRefusedError('caminho de trabalho inválido');
	}
}
