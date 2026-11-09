/**
 * A instância que o Windows vê (DEV-6).
 *
 * ## O que isto é — e o que **não** é
 *
 * O Evelyn não tem cadastro de usuários, login nem servidor de identidade. Na
 * prática, "proprietário" aqui significa **a pessoa que controla a sessão de
 * usuário do Windows em que o aplicativo foi iniciado** — não uma pessoa
 * autenticada por uma conta da Evelyn, porque essa conta não existe.
 *
 * O que este módulo consegue provar, e importa de verdade:
 *
 * - **A instância é única.** Se há mais de um `Seshyina.exe` vivo, "o dono" é
 *   ambíguo: a sessão DEV que se abrisse num deles não teria um autor
 *   identificável. Com mais de uma, a ativação é recusada.
 * - **Em qual sessão do Windows o app roda** (`Process.SessionId`, que o
 *   sistema responde). Não é forjável pelo renderer e não é "quem clicou".
 *
 * O que **não** consegue provar: que o clique veio do humano e não de um
 * processo do **mesmo** usuário. Para um processo do mesmo usuário não há
 * separação — é o mesmo motivo pelo qual ele já pode ler os arquivos de dados
 * e os segredos. Nenhum mecanismo honesto neste app muda isso, e este módulo
 * não finge que muda. Também não há como distinguir, dentro da sessão, se a
 * janela que pediu é a do chat, a de configurações ou uma aba de outra origem:
 * a defesa contra essa última está em `devControl.ts` (origem da URL).
 *
 * ## Quando não pode decidir
 *
 * Fora do Windows, ou se a consulta falhar, o veredito é `unknown`. `allow`
 * nunca é o padrão: "não sei" não autoriza.
 */

import { execFile } from 'node:child_process';

/** O que a consulta ao sistema disse. */
export type LocalInstance =
	/** Uma instância, sessão de usuário identificável. */
	| { readonly kind: 'single'; readonly sessionId: string; readonly processes: number }
	/** Mais de uma instância: não há "o dono" de quem falar. */
	| { readonly kind: 'ambiguous'; readonly processes: number }
	/** Não foi possível perguntar. */
	| { readonly kind: 'unknown'; readonly reason: string };

/** O nome do executável empacotado (para a mensagem diagnóstica). */
export const PACKAGED_PROCESS_NAME = 'Seshyina';

/** Executa um comando do PowerShell e devolve a saída aparada. */
function runPowerShell(script: string): Promise<string> {
	return new Promise<string>((resolveRun, rejectRun) => {
		execFile(
			'powershell',
			['-NoProfile', '-NonInteractive', '-Command', script],
			{ timeout: 10_000, windowsHide: true },
			(error, stdout) => {
				if (error !== null) {
					rejectRun(error);
					return;
				}
				resolveRun(stdout.trim());
			},
		);
	});
}

/**
 * Quantos processos rodam **o mesmo executável** que o processo que pergunta?
 *
 * ## Por que não é o nome
 *
 * A versão anterior contava `Get-Process -Name Seshyina`. Dois problemas
 * medidos na DEV-8/8.1: um processo qualquer chamado `Seshyina.exe` entraria
 * na conta (e não é uma instância do app), e no desenvolvimento o Electron
 * roda como `electron.exe`, então a conta dava zero e a ativação era recusada
 * por um motivo falso. O identificador correto de "instância do app" é o
 * **executável de onde este processo veio** — `process.execPath`, no Node e no
 * Electron —, com o caminho completo comparado sem diferenciar caixa.
 *
 * ## O que isso prova, e o que não prova
 *
 * Prova: existe **uma só** instância viva do mesmo binário. Com duas, "o dono"
 * é ambíguo e a ativação recusa. Não prova quem clicou: a senha local e a
 * janela do host continuam sendo o que limita isso.
 */
export async function countSameExecutable(
	options: { readonly execPath?: string; readonly runner?: (script: string, env: Record<string, string>) => Promise<string> } = {},
): Promise<number> {
	const execPath = options.execPath ?? process.execPath;
	if (typeof execPath !== 'string' || execPath.length === 0) {
		throw new Error('o caminho do executável deste processo não é conhecido');
	}
	// O caminho do **app** vem do chamador: dentro do PowerShell, o "próprio
	// processo" seria o `powershell.exe` (medido). E vai por **variável de
	// ambiente**, não interpolado no script: um caminho com aspas ou `$` não
	// vira código do PowerShell.
	const script = [
		// `Get-Process | Where-Object` não é confiável aqui: medido, o mesmo
		// filtro devolveu 3, 3 e 0 em execuções consecutivas. O WMI lista por
		// caminho (`ExecutablePath`) **e** por linha de comando, que é o que
		// distingue o processo principal do app dos seus filhos (medido: 4 para
		// um app, sendo 1 principal + gpu + utility + renderer).
		`$all = @(Get-CimInstance Win32_Process -Filter "Name = '$env:EVELYN_SELF_NAME'" -ErrorAction SilentlyContinue | Where-Object { [string]::Equals($_.ExecutablePath, $env:EVELYN_SELF_EXE, [StringComparison]::OrdinalIgnoreCase) }); ` +
			// Sem `--type=` é o processo principal; os filhos do Electron trazem
			// `--type=...`.
			'@($all | Where-Object { -not ($_.CommandLine -match "--type=") }).Count',
	].join('; ');
	const name = execPath.split(/[\\/]/).pop() ?? '';
	const out = await (options.runner ?? runWithEnv)(script, { EVELYN_SELF_EXE: execPath, EVELYN_SELF_NAME: name });
	const parsed = Number.parseInt(out, 10);
	if (!Number.isFinite(parsed)) {
		throw new Error('a contagem devolveu algo que não é um número');
	}
	return parsed;
}

/** Executa com variáveis de ambiente (o caminho não entra no script). */
function runWithEnv(script: string, env: Record<string, string>): Promise<string> {
	return new Promise((resolveRun, rejectRun) => {
		execFile(
			'powershell',
			['-NoProfile', '-NonInteractive', '-Command', script],
			{ timeout: 10_000, windowsHide: true, env: { ...process.env, ...env } },
			(error, stdout) => {
				if (error !== null) {
					rejectRun(error);
					return;
				}
				resolveRun(stdout.trim());
			},
		);
	});
}

/**
 * Lê a instância local consultando o Windows.
 *
 * Dois fatos independentes:
 *
 * 1. **Há outro processo com o mesmo executável?** É o que decide se existe um
 *    dono único. O processo que pergunta não conta a si mesmo —
 *    `MainModule.FileName` não é acessível no próprio processo em determinadas
 *    configurações do Windows, e contar a si mesmo levava a "3 instâncias"
 *    para um único app (medido na DEV-8.1).
 * 2. **Qual é a sessão do processo atual** (`Process.SessionId`).
 *
 * Qualquer falha vira `unknown`, nunca `single`.
 */
export async function readLocalInstance(
	options: {
		/** Sobrescreve a verificação de outra instância, em teste. */
		readonly countProcesses?: () => Promise<number>;
		/** Sobrescreve a sessão, em teste. */
		readonly readSession?: () => Promise<string>;
		/** O caminho do executável deste processo (os testes fixam). */
		readonly execPath?: string;
		readonly platform?: NodeJS.Platform;
	} = {},
): Promise<LocalInstance> {
	const platform = options.platform ?? process.platform;
	const injected = options.countProcesses !== undefined || options.readSession !== undefined;
	if (platform !== 'win32' && !injected) {
		return {
			kind: 'unknown',
			reason: 'a identificação de instância não é implementada fora do Windows',
		};
	}
	const others =
		options.countProcesses ??
		(() =>
			countSameExecutable({
				...(options.execPath !== undefined ? { execPath: options.execPath } : {}),
			}));
	const session = options.readSession ?? (() => runPowerShell('[string][System.Diagnostics.Process]::GetCurrentProcess().SessionId'));

	let processes: number;
	try {
		processes = await others();
	} catch (error) {
		return { kind: 'unknown', reason: `não foi possível verificar outras instâncias: ${String(error)}` };
	}
	// `others()` devolve **quantos** processos usam este executável, contando o
	// atual quando o sistema o lista. Zero é uma resposta válida (o WMI pode não
	// listar o próprio processo): é uma instância só.
	const instances = Math.max(1, processes);
	if (instances > 1) {
		return { kind: 'ambiguous', processes: instances };
	}
	let sessionId: string;
	try {
		sessionId = await session();
	} catch (error) {
		return { kind: 'unknown', reason: `a consulta de sessão falhou: ${String(error)}` };
	}
	if (sessionId.length === 0 || !/^\d+$/.test(sessionId)) {
		return { kind: 'unknown', reason: 'o sistema não informou a sessão do processo' };
	}
	return { kind: 'single', sessionId, processes: 1 };
}

/**
 * A instância lida permite ativar o modo DEV?
 *
 * Conservador por construção: só `single` permite; `ambiguous` e `unknown`
 * recusam, com o motivo.
 */
export function activationVerdict(
	instance: LocalInstance,
): { readonly allowed: true; readonly sessionId: string } | { readonly allowed: false; readonly reason: string } {
	switch (instance.kind) {
		case 'single':
			return { allowed: true, sessionId: instance.sessionId };
		case 'ambiguous':
			return {
				allowed: false,
				reason:
					`há ${instance.processes} instâncias do Evelyn abertas nesta máquina; com mais de uma, ` +
					'não há um único dono da sessão DEV para quem falar',
			};
		case 'unknown':
			return { allowed: false, reason: `não foi possível confirmar a instância: ${instance.reason}` };
	}
}
