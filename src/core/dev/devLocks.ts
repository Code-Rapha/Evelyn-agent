/**
 * A coordenação entre o DEV e os comandos comuns (DEV-2.1).
 *
 * ## O problema
 *
 * `run_command` (a ferramenta comum do agente) e `dev_run`/`dev_write` podem
 * tocar o **mesmo repositório**: o agente abre um `npm run build` com a
 * ferramenta normal e, enquanto isso, o DEV escreve um arquivo. O build lê
 * metade de cada versão e o resultado não significa nada — nem para o teste,
 * nem para o modelo.
 *
 * ## O mecanismo
 *
 * Uma trava por **recurso** (aqui, a raiz do repositório), com a mesma forma
 * das filas que o projeto já usa (`FileDataStore.queueWrite`): uma promessa
 * que a próxima operação aguarda. Quem espera é a operação que quer o mesmo
 * recurso; operações em raízes diferentes correm em paralelo.
 *
 * ## Sem bloqueio indefinido
 *
 * Toda aquisição tem prazo. Um comando longo (a suíte inteira leva ~2 min)
 * não pode fazer a escrita do DEV esperar para sempre; estourar o prazo é uma
 * recusa clara ("o repositório está ocupado por outro comando"), não um
 * travamento. E quem detém a trava **sempre** a solta: `finally` no caminho
 * feliz, no erro, no cancelamento e no timeout.
 *
 * ## O que não é
 *
 * Não é uma trava de sistema de arquivos: dois processos diferentes não a
 * veem. Dentro do processo — que é onde `run_command`, `dev_run` e `dev_write`
 * vivem juntos — é o suficiente, e é o mínimo que resolve o problema que foi
 * identificado.
 */

/** O recurso: uma chave (a raiz do repositório, normalizada). */
export type DevResourceKey = string;

interface Waiter {
	readonly grant: () => void;
	readonly expire: (message: string) => void;
}

/**
 * A trava.
 *
 * `acquire` devolve o `release`; quem chama tem de chamá-lo no `finally`.
 */
export class DevLocks {
	private readonly held = new Set<DevResourceKey>();
	private readonly waiters = new Map<DevResourceKey, Waiter[]>();

	constructor(private readonly defaultWaitMs = 15_000) {}

	/** Há uma operação com a trava deste recurso? */
	isHeld(key: DevResourceKey): boolean {
		return this.held.has(key);
	}

	/**
	 * Pega a trava, esperando até `waitMs`.
	 *
	 * Lança `DevBusyError` quando o prazo estoura — nunca espera para sempre.
	 */
	async acquire(key: DevResourceKey, waitMs = this.defaultWaitMs): Promise<() => void> {
		if (!this.held.has(key)) {
			this.held.add(key);
			return () => this.release(key);
		}
		const queue = this.waiters.get(key) ?? [];
		this.waiters.set(key, queue);
		await new Promise<void>((resolve, reject) => {
			const waiter: Waiter = {
				grant: () => {
					clearTimeout(timer);
					resolve();
				},
				expire: (message) => {
					clearTimeout(timer);
					reject(new DevBusyError(message));
				},
			};
			const timer = setTimeout(() => {
				const current = this.waiters.get(key) ?? [];
				this.waiters.set(
					key,
					current.filter((entry) => entry !== waiter),
				);
				reject(new DevBusyError(`${key} está ocupado por outra operação do DEV`));
			}, waitMs);
			queue.push(waiter);
		});
		return () => this.release(key);
	}

	private release(key: DevResourceKey): void {
		const queue = this.waiters.get(key);
		const next = queue?.shift();
		if (next !== undefined) {
			// A trava passa direto para o próximo: não existe janela em que
			// ninguém a tem e dois a disputam.
			next.grant();
			return;
		}
		if (queue !== undefined && queue.length === 0) {
			this.waiters.delete(key);
		}
		this.held.delete(key);
	}

	/** Quantos esperam por um recurso (para o teste provar que ninguém ficou preso). */
	pending(key: DevResourceKey): number {
		return this.waiters.get(key)?.length ?? 0;
	}
}

/** A recusa quando o recurso está ocupado além do prazo. */
export class DevBusyError extends Error {
	readonly code = 'dev_busy';
	constructor(message: string) {
		super(message);
		this.name = 'DevBusyError';
	}
}

/**
 * A recusa de uma trava de arquivo, com o **PID** e o **motivo**.
 *
 * DEV-AUDIT-01: "em uso por outro processo" não diz quem; a auditoria mostrou
 * que essa falta de detalhe é o que transforma um diagnóstico de cinco
 * minutos em uma caçada. O `reason` da inspeção já nomeia o dono e a
 * divergência; o PID vem separado para a interface poder copiar.
 */
export function busyMessage(result: {
	readonly kind: 'busy' | 'failed';
	readonly owner?: { readonly pid: number; readonly acquiredAt: string };
	readonly reason?: string;
	readonly message?: string;
}): string {
	if (result.kind === 'failed') {
		return `não foi possível coordenar o uso do repositório: ${result.message ?? 'motivo desconhecido'}`;
	}
	const pid = result.owner !== undefined ? ` (PID ${result.owner.pid})` : '';
	return `o repositório está em uso por outro processo${pid}: ${result.reason ?? 'motivo não informado'}`;
}

/** Normaliza a raiz para a chave da trava (Windows não distingue caixa). */
export function resourceKeyFor(root: string): DevResourceKey {
	return root.replace(/[\\/]+$/, '').toLowerCase();
}

/**
 * Um coordenador com duas visões da mesma trava.
 *
 * `dev` é o que as ferramentas `dev_*` usam; `command` é o que o
 * `CommandRunner` comum usa. As duas visões compartilham o mesmo `DevLocks`,
 * então `run_command` e `dev_write` no mesmo repositório se enxergam.
 */
export interface StagedCommandRunnerResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly aborted: boolean;
}

export interface StagedCommandRunner {
	(command: string, cwd: string, signal?: AbortSignal): Promise<StagedCommandRunnerResult>;
}

/** Import local para o decorador não criar ciclo com `devTools`. */
import { acquireDevLockForRoot } from './devFileLock';

/**
 * Envolve um `CommandRunner` (o do `run_command`) para que ele respeite a
 * **mesma** trava do DEV.
 *
 * O `run_command` comum roda no workspace de um projeto, que pode ser o
 * repositório da Evelyn. Sem isto, o agente poderia rodar `npm run build` com
 * a ferramenta normal enquanto o DEV escreve um arquivo — exatamente a corrida
 * que a DEV-2.1 fecha.
 *
 * O `cwd` é a chave: a trava é por diretório de trabalho, então um comando em
 * outro projeto não é afetado. Se a trava não for liberada a tempo, o comando
 * comum é **recusado** com a mensagem de ocupado — ele não espera para sempre.
 */
export function coordinateCommandRunner(
	inner: StagedCommandRunner,
	locks: DevLocks,
	options: { readonly waitMs?: number; readonly crossProcessWaitMs?: number } = {},
): StagedCommandRunner {
	return async (command, cwd, signal) => {
		const release = await locks.acquire(resourceKeyFor(cwd), options.waitMs);
		try {
			// A trava entre processos (DEV-2.2) entra **depois** da local, na
			// mesma ordem do DEV: processo, depois arquivo.
			//
			// `acquireDevLockForRoot`, e não `acquireDevLock`: quando a sessão
			// DEV deste processo já é dona da raiz, o arquivo está aberto por
			// ela, e a aquisição crua recusava "em uso por outro processo"
			// apontando o **próprio PID** — reproduzido. Fora isso, a aquisição
			// é a mesma de sempre: espera e recusa no prazo.
			const fileLock = await acquireDevLockForRoot(cwd, {
				waitMs: options.crossProcessWaitMs ?? 30_000,
			});
			if (fileLock.kind !== 'acquired') {
				throw new DevBusyError(busyMessage(fileLock));
			}
			try {
				return await inner(command, cwd, signal);
			} finally {
				await fileLock.lock.release();
			}
		} finally {
			release();
		}
	};
}
