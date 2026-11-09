/**
 * O `ApplyTarget` do modo DEV, com as dependências do host injetadas (DEV-4).
 *
 * ## O desenho
 *
 * A DEV-3 deixou o fluxo (`applyChange`) pedindo quatro coisas ao host:
 * recarregar a janela, reiniciar o aplicativo, rodar uma verificação e
 * conferir que a nova versão responde. Este módulo implementa essas quatro
 * **sem** importar `electron`: recebe funções (e um runner do DEV para os
 * comandos). Assim ele é testável com o host simulado, e o `main.ts` só liga
 * os cabos — que é onde a decisão de recarregar ou reiniciar realmente mora.
 *
 * ## O que cada estratégia faz de fato
 *
 * - `hot`/`reload-ui`: `window.webContents.reload()`. Só a janela. O processo,
 *   o Core e a conversa continuam.
 * - `restart-app`: `app.relaunch()` + `app.quit()`. **Não retorna** num
 *   reinício real — quem chama está num processo que vai morrer.
 * - `restart-controlled`: o mesmo, mas exige que a operação tenha passado por
 *   todas as verificações (o `applyChange` já garantiu isso) e mantém o
 *   checkpoint.
 *
 * ## "Não afirmar que aplicou quando só aceitou"
 *
 * `reloadUi()` resolve **depois** de a janela terminar de carregar — não
 * quando o pedido é enviado. `probe()` confere que a janela voltou a ter uma
 * página viva. Se a recarga não acontecer (janela fechada, `webkit` travado,
 * erro de carga), a promessa rejeita e o fluxo desfaz pelo checkpoint em vez
 * de dizer "concluído".
 */

import type { ApplyTarget } from './devApply';
import type { DevRunner } from './devRunner';

/** O que o adaptador precisa do Electron, sem conhecê-lo. */
export interface ElectronApplyHost {
	/** A janela principal existe e não foi destruída? */
	isWindowAlive(): boolean;
	/** Recarrega a página da janela; resolve quando o carregamento termina. */
	reloadWindow(timeoutMs: number): Promise<void>;
	/**
	 * Reinicia o aplicativo.
	 *
	 * Em produção, `app.relaunch()` + `app.quit()`. O `reloaded` é a promessa
	 * de que a nova instância subiu — que não existe num reinício de verdade
	 * (o processo morre antes).
	 */
	restartApplication(): Promise<void>;
	/** A janela está pronta para receber eventos? */
	isWindowReady(): boolean;
}

/** O que o adaptador precisa para rodar verificações. */
export interface LocalCheckRunner {
	run(
		command: string,
		cwd: string,
		signal?: AbortSignal,
	): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string; readonly aborted: boolean }>;
}

export interface ElectronApplyOptions {
	readonly host: ElectronApplyHost;
	/** A raiz do repositório — as verificações rodam nela. */
	readonly repositoryRoot: string;
	/** O runner do DEV (allowlist, timeout, teto de saída). */
	readonly runner: DevRunner;
	/** Opcional: sonda específica. Padrão: a janela está viva e pronta. */
	readonly probeWindow?: () => Promise<{ readonly ok: boolean; readonly detail: string }>;
	/** Prazo de uma recarga, em ms. */
	readonly reloadTimeoutMs?: number;
	/**
	 * A verificação, quando o host quer injetá-la em vez de rodar o comando.
	 *
	 * Nenhum caminho de produção passa isto: em produção, verificações rodam
	 * pelo `runner`. É para um teste julgar **o fluxo** sem rodar `npm run
	 * test:core` dentro de `npm run test:core`.
	 */
	readonly runCheck?: (
		command: string,
	) => Promise<{ readonly exitCode: number; readonly summary: string }>;
	/** Registro de diagnóstico (não recebe segredo). */
	readonly log?: (message: string, data?: Record<string, unknown>) => void;
}

/** A recusa quando a janela não está em condições de recarregar. */
export class ApplyHostError extends Error {
	readonly code = 'dev_apply_host';
	constructor(message: string) {
		super(message);
		this.name = 'ApplyHostError';
	}
}

/**
 * Cria o alvo.
 *
 * `restartApplication` é chamado **uma vez** por fluxo: o `applyChange` pede
 * a aplicação e espera; num reinício real ele nunca retorna. Guardar o
 * "já pedi" evita que uma segunda chamada na mesma operação dispare um
 * segundo `relaunch` — que é o "reinício repetido" que a etapa pede para
 * evitar.
 */
export function createElectronApplyTarget(options: ElectronApplyOptions): ApplyTarget & {
	readonly restarted: () => boolean;
} {
	const log = options.log ?? (() => undefined);
	const reloadTimeoutMs = options.reloadTimeoutMs ?? 15_000;
	let restartRequested = false;
	let reloads = 0;

	const probeWindow =
		options.probeWindow ??
		(async () => {
			if (!options.host.isWindowAlive()) {
				return { ok: false, detail: 'a janela principal não existe mais' };
			}
			if (!options.host.isWindowReady()) {
				return { ok: false, detail: 'a janela existe mas não terminou de carregar' };
			}
			return { ok: true, detail: 'a janela respondeu com a página carregada' };
		});

	return {
		restarted: () => restartRequested,
		async runCheck(command) {
			// O host pode injetar a verificação (teste do fluxo); em produção
			// ela roda pelo `DevRunner`: allowlist, prazo e teto de saída são
			// os da DEV-2.2, não um shell novo.
			try {
				if (options.runCheck !== undefined) {
					return await options.runCheck(command);
				}
				const outcome = await options.runner.run(command, options.repositoryRoot);
				const summary =
					outcome.aborted
						? 'interrompido'
						: outcome.exitCode === 0
							? 'ok'
							: lastLine(outcome.stderr) || lastLine(outcome.stdout) || `saída ${outcome.exitCode}`;
				return { exitCode: outcome.exitCode, summary };
			} catch (error) {
				// Recusa da allowlist ou falha de processo: é falha de
				// verificação, não sucesso silencioso.
				return {
					exitCode: 1,
					summary: error instanceof Error ? error.message : String(error),
				};
			}
		},
		async reloadUi() {
			if (!options.host.isWindowAlive()) {
				throw new ApplyHostError('não há janela para recarregar; a mudança não foi aplicada');
			}
			reloads += 1;
			log('Recarregando a janela para aplicar a mudança', { reloads });
			try {
				await options.host.reloadWindow(reloadTimeoutMs);
			} catch (error) {
				throw new ApplyHostError(
					`a janela não recarregou: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		},
		async restartApp({ controlled }) {
			if (restartRequested) {
				// Um fluxo, um reinício. Repetir aqui mataria o processo duas
				// vezes no meio de uma operação já em andamento.
				return;
			}
			restartRequested = true;
			log(controlled ? 'Reinício controlado pedido' : 'Reinício pedido');
			await options.host.restartApplication();
		},
		async probe() {
			return await probeWindow();
		},
	};
}

/** A última linha útil de uma saída, para o resumo do erro. */
function lastLine(text: string): string {
	const lines = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	return lines[lines.length - 1] ?? '';
}
