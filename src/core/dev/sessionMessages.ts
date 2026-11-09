/**
 * A validação do que o renderer manda sobre a sessão de interface (DEV-4).
 *
 * ## O que o renderer **pode** dizer
 *
 * Só o suficiente para reabrir no lugar certo:
 *
 * - qual conversa ele abriu (`conversationId`);
 * - se há um turno em andamento agora (`generating`).
 *
 * ## O que ele **não** pode dizer
 *
 * Caminho, conteúdo de mensagem, token, autorização de DEV, comando ou
 * "aplique esta mudança". Estas mensagens vêm de uma página; a página é
 * conteúdo, e conteúdo não escolhe caminho nem executa comando. Quem decide o
 * que aplicar é o fluxo da DEV-3, no processo principal, com a sessão em
 * memória e as ferramentas autorizadas.
 *
 * Um campo desconhecido **recusa a mensagem inteira** em vez de ser ignorado:
 * um renderer que manda `root: "C:\\"` está tentando algo, e é melhor dizer
 * que não do que fingir que não viu.
 */

import type { UiBootState, UiSession } from './uiSession';

/** A recusa de uma mensagem fora do contrato. */
export class SessionMessageError extends Error {
	readonly code = 'bad_session_message';
	constructor(message: string) {
		super(message);
		this.name = 'SessionMessageError';
	}
}

/** Os campos aceitos em `uiSession:set`. */
const SESSION_FIELDS: ReadonlySet<string> = new Set(['conversationId', 'generating']);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Valida `uiSession:set`.
 *
 * Devolve o patch que o host grava, ou lança `SessionMessageError`.
 */
export function parseSessionPatch(payload: unknown): Partial<UiSession> {
	if (!isRecord(payload)) {
		throw new SessionMessageError('a mensagem precisa ser um objeto');
	}
	for (const key of Object.keys(payload)) {
		if (!SESSION_FIELDS.has(key)) {
			throw new SessionMessageError(`o campo "${key}" não é aceito na sessão da interface`);
		}
	}
	const patch: { lastConversationId?: string; wasGenerating?: boolean } = {};
	if (payload['conversationId'] !== undefined) {
		const id = payload['conversationId'];
		// Mesmo teto do resto do app para ids de conversa; um id gigante é
		// tentativa de inchar o arquivo de sessão.
		if (typeof id !== 'string' || id.length === 0 || id.length > 200) {
			throw new SessionMessageError('conversationId precisa ser um texto de 1 a 200 caracteres');
		}
		patch.lastConversationId = id;
	}
	if (payload['generating'] !== undefined) {
		if (typeof payload['generating'] !== 'boolean') {
			throw new SessionMessageError('generating precisa ser verdadeiro ou falso');
		}
		patch.wasGenerating = payload['generating'];
	}
	if (patch.lastConversationId === undefined && patch.wasGenerating === undefined) {
		throw new SessionMessageError('a mensagem não traz nada para atualizar');
	}
	return patch;
}

/**
 * Valida a forma do que vai **para** o renderer.
 *
 * O host monta esse objeto; esta função protege contra a montagem errada de
 * um caminho de código futuro — se alguém acrescentar um campo proibido, o
 * teste (e a validação em produção) recusam antes de a página ver.
 *
 * A mensagem é **texto do aviso do host**, nunca conteúdo de arquivo: por
 * isso o teto de tamanho (um aviso é curto) e a recusa de padrões de
 * credencial. Não é uma prova de que o texto é seguro — é um limite para um
 * campo que o próprio host escreve.
 */
export function assertBootStateSafe(state: UiBootState): UiBootState {
	const allowed: ReadonlySet<string> = new Set(['conversationId', 'message', 'canRetry']);
	for (const key of Object.keys(state)) {
		if (!allowed.has(key)) {
			throw new SessionMessageError(`o boot state não pode carregar "${key}" para a interface`);
		}
	}
	if (state.message !== undefined) {
		if (typeof state.message !== 'string' || state.message.length > 4_000) {
			throw new SessionMessageError('a mensagem do aviso precisa ser texto curto');
		}
		// Padrões de credencial conhecidos: `sk-…`, `Bearer …`, token longo
		// hexadecimal. Um aviso do host nunca precisa deles.
		if (/\bsk-[A-Za-z0-9_-]{8,}|\bBearer\s+\S+|\b[0-9a-f]{32,}\b/i.test(state.message)) {
			throw new SessionMessageError('o aviso carrega algo com cara de credencial');
		}
	}
	return state;
}
