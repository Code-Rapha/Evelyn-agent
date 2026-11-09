/**
 * A exclusão pelo IPC do desktop, com o desfecho da R4M.
 *
 * ## Por que não é um booleano
 *
 * O store devolve três desfechos: `deleted` (removeu), `absent` (já não
 * estava lá — outra exclusão venceu, ou nunca existiu) e `unknown` (não foi
 * possível confirmar a lista). Os dois primeiros são sucesso para quem pediu
 * a exclusão; o terceiro **não** é: dizer "deu certo" faria a interface apagar
 * a conversa da lista como se tivesse acontecido.
 *
 * O canal do IPC devolve `{ deleted }` — `true` só quando esta chamada removeu
 * de fato — e `unknown` vira erro, para a tela mostrar a falha em vez de
 * escondê-la atrás de um sucesso.
 */
import type { ConversationDeleteOutcome } from '../core/storage/types/dataStore';

/** O que o canal `conversation` responde a `delete`. */
export interface DesktopDeleteResult {
	/** `true` só quando **esta** chamada removeu a conversa. */
	readonly deleted: boolean;
}

/**
 * Converte o desfecho do store no resultado do canal.
 *
 * Lança quando o desfecho é `unknown`: não há como afirmar que a conversa
 * sumiu, e um erro é a informação honesta.
 */
export async function deleteForDesktop(
	chat: { deleteConversation(id: string): Promise<ConversationDeleteOutcome> },
	id: string,
): Promise<DesktopDeleteResult> {
	const outcome = await chat.deleteConversation(id);
	if (outcome === 'unknown') {
		throw new Error('não foi possível confirmar a exclusão da conversa');
	}
	return { deleted: outcome === 'deleted' };
}
