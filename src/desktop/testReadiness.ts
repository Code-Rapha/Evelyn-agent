/**
 * O sinal de prontidão para testes de integração (R4L).
 *
 * ## Por que existe
 *
 * O teste de integração precisa saber que o app **abriu já conectado** ao
 * serviço, e não apenas que o processo continua vivo. Antes, ele esperava 12 s
 * fixos e deduzia a conexão olhando o texto do erro: uma espera longa que não
 * provava nada no meio do caminho, e que estourava o limite da suíte quando o
 * arranque ficava mais lento.
 *
 * ## O que é o sinal
 *
 * Uma linha no stderr, **só** quando a variável de ambiente
 * `SESHYINA_TEST_READY=1` está presente, emitida **depois** de o app ter
 * decidido e concluído o seu modo de arranque:
 *
 * ```
 * [evelyn-test] ready mode=connected pid=<pid> service=<pid do serviço>
 * ```
 *
 * No modo local, `mode=local` e sem `service=`.
 *
 * ## O que ele garante — e o que não garante
 *
 * Garante o que aconteceu **até** a linha: a conexão (ou a montagem do Core)
 * foi concluída. Não garante o futuro: quem lê o sinal ainda precisa
 * observar que o processo não saiu depois dele. É por isso que o teste
 * continua verificando a sobrevivência.
 *
 * ## Isolamento
 *
 * Desativado por padrão: sem a variável, nada é escrito e nenhum código
 * deste módulo muda a saída do app. A linha não carrega token, caminho nem
 * conteúdo — só o modo e os pids, que o próprio operador vê no processo.
 */

import { APP_NAME } from './contract';

/** A variável que liga o sinal. Qualquer outro valor a deixa desligada. */
export const READY_ENV = 'SESHYINA_TEST_READY';

/** O prefixo da linha, estável para quem lê em teste. */
export const READY_PREFIX = '[evelyn-test] ready';

/**
 * O modo de arranque, do ponto de vista de quem testa.
 *
 * - `connected`: o app abriu em modo conectado ao serviço local;
 * - `local`: o app montou o Core próprio;
 * - `unavailable`: abriu sem dados (há serviço, mas ele não respondeu);
 * - `refused`: saiu com a explicação, sem abrir janela.
 */
export type ReadyMode = 'connected' | 'local' | 'unavailable' | 'refused';

/** O que o sinal diz. */
export interface ReadySignal {
	readonly mode: ReadyMode;
	readonly pid: number;
	/** O pid do serviço, quando o modo é `connected`. */
	readonly service?: number;
}

/**
 * O sinal está ligado?
 *
 * Um leitor explícito do ambiente em vez de `process.env` espalhado pelo
 * arquivo: o teste do comportamento normal passa um ambiente vazio e prova
 * que nada sai.
 */
export function readyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[READY_ENV] === '1';
}

/** A linha a escrever, ou `undefined` quando o sinal está desligado. */
export function readyLine(
	signal: ReadySignal,
	options: { readonly enabled?: boolean; readonly env?: NodeJS.ProcessEnv } = {},
): string | undefined {
	const enabled = options.enabled ?? readyEnabled(options.env);
	if (!enabled) {
		return undefined;
	}
	const parts = [`${READY_PREFIX} mode=${signal.mode}`, `pid=${signal.pid}`];
	if (signal.service !== undefined) {
		parts.push(`service=${signal.service}`);
	}
	return parts.join(' ');
}

/**
 * O casamento do formato, para quem lê a saída do processo.
 *
 * Exportado para o teste não ter uma segunda cópia da expressão: um formato
 * que muda num lugar e não no outro vira um teste que passa lendo nada.
 */
export const READY_LINE_PATTERN = new RegExp(
	`^\\[evelyn-test\\] ready mode=(connected|local|unavailable|refused) pid=(\\d+)(?: service=(\\d+))?$`,
	'm',
);

/** O primeiro sinal de prontidão na saída, ou `undefined`. */
export function parseReady(output: string): ReadySignal | undefined {
	const match = READY_LINE_PATTERN.exec(output);
	if (match === null) {
		return undefined;
	}
	return {
		mode: match[1] as ReadyMode,
		pid: Number(match[2]),
		...(match[3] !== undefined ? { service: Number(match[3]) } : {}),
	};
}

/** A mensagem de diagnóstico quando o sinal não veio, para o teste falhar claro. */
export function missingReadyHint(mode: ReadyMode, output: string): string {
	const tail = output.trim().slice(-600);
	return [
		`${APP_NAME} não emitiu o sinal de prontidão para o modo "${mode}".`,
		`O teste lança o Electron com ${READY_ENV}=1; sem essa variável o app não sinaliza.`,
		`Saída observada (últimos 600 caracteres): ${tail.length > 0 ? tail : '<vazia>'}`,
	].join(' ');
}
