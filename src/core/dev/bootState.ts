/**
 * A decisão de abertura da janela, no processo principal (DEV-4).
 *
 * ## Por que no main e não no renderer
 *
 * A página precisa saber **antes de desenhar** qual conversa abrir. Se ela
 * perguntasse depois de montar, abriria a primeira da lista e pularia para a
 * certa — a mesma duplicação visual que a DEV-3 existe para evitar. O main lê
 * o estado guardado e a operação pendente, decide, e a janela só obedece.
 *
 * ## O que ele combina
 *
 * - a **operação DEV pendente** (se houver): é ela que diz a conversa, porque
 *   é nela que a mudança foi pedida;
 * - o **estado da sessão** salvo pelo renderer: última conversa e se havia
 *   geração em curso;
 * - a lista de conversas **válidas**, quando conhecida: um id salvo que já
 *   não existe não pode ser reaberto — cai para o comportamento padrão.
 *
 * Nada aqui executa ou aplica mudança: só decide o que a janela abre e o que
 * ela mostra.
 */

import { decideResume, type ResumeNotice } from './devContinuity';
import type { DevOperation } from './devOperation';
import type { UiSession } from './uiSession';

/** A entrada da decisão. */
export interface BootInput {
	readonly operation?: DevOperation;
	readonly session: UiSession;
	/**
	 * As conversas que existem, quando se sabe.
	 *
	 * `undefined` = não verificável agora (modo conectado antes de o serviço
	 * responder). Nesse caso o id é aceito como está: o serviço dirá "não há
	 * conversa" ao abrir, e a tela cai para o estado vazio, sem duplicar nada.
	 */
	readonly knownConversationIds?: readonly string[];
	/** Um turno **agora** está em andamento (deste processo)? */
	readonly generatingNow?: boolean;
}

/** A decisão, com o motivo dela. */
export interface BootDecision extends ResumeNotice {
	/** `operation`: veio da operação pendente; `last`: da última aberta; `default`: nada. */
	readonly source: 'operation' | 'last' | 'default';
}

/**
 * Decide o que a janela abre.
 *
 * A ordem: operação pendente → última válida → padrão. Um id que não existe
 * mais é descartado **sem erro**: a janela abre na primeira conversa, como
 * sempre fez, e o aviso (se houver) continua visível.
 */
export function decideBoot(input: BootInput): BootDecision {
	const notice = decideResume({
		...(input.operation !== undefined ? { operation: input.operation } : {}),
		restored: {
			...(input.session.lastConversationId !== undefined
				? { lastConversationId: input.session.lastConversationId }
				: {}),
			// A geração que importa para o aviso é a que existia **quando a
			// interface saiu**; a de agora é um turno normal em andamento e não
			// deve virar "interrompida".
			...(input.session.wasGenerating === true ? { wasGenerating: true } : {}),
		},
	});

	const source: BootDecision['source'] =
		notice.pendingOperation?.conversationId !== undefined
			? 'operation'
			: notice.conversationId !== undefined
				? 'last'
				: 'default';

	// Valida contra as conversas conhecidas, quando a lista é confiável.
	if (notice.conversationId !== undefined && input.knownConversationIds !== undefined) {
		const exists = input.knownConversationIds.includes(notice.conversationId);
		if (!exists) {
			// O id sumiu: descarta a escolha e mantém o aviso, se havia.
			return {
				...(notice.message !== undefined ? { message: notice.message } : {}),
				...(notice.action !== undefined ? { action: notice.action } : {}),
				...(input.operation !== undefined && notice.pendingOperation !== undefined
					? { pendingOperation: notice.pendingOperation }
					: {}),
				source: 'default',
			};
		}
	}

	return { ...notice, source };
}
