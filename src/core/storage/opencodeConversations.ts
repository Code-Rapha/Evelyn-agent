/**
 * O registro durável das conversas do OpenCode.
 *
 * ## Onde mora, e por quê
 *
 * No mesmo `FileDataStore` que guarda tudo o mais da Evelyn — pasta
 * `conversations/`, um arquivo por conversa, escrita atômica, índice de
 * resumos. É a infraestrutura que já existe, não uma segunda: um segundo
 * lugar criaria "onde está esta conversa?" com duas respostas possíveis.
 *
 * ## O que o arquivo guarda
 *
 * O que a continuidade **precisa**, e nada além:
 *
 * - o modelo escolhido (`providerID/modelID` do catálogo);
 * - a **sessão do OpenCode** e a prova de propriedade — um dono que a
 *   Evelyn registrou quando a sessão nasceu;
 * - as mensagens (`user`/`assistant`), com papel, texto, data e o modelo que
 *   respondeu.
 *
 * Nada de senha, token, cabeçalho ou corpo bruto do servidor: a credencial
 * continua só em memória (Fase 4C).
 *
 * ## Como o estado entra num arquivo que não tem esses campos
 *
 * O arquivo de conversa do `FileDataStore` tem id, título e mensagens — e
 * essa é a forma que ele valida. O modelo e a sessão entram como **uma
 * mensagem `system`** no cabeçalho do histórico, com um JSON curto e
 * prefixado (`OPENCODE_STATE_PREFIX`). A última vence, então atualizar a
 * sessão não reescreve o histórico do usuário.
 *
 * Essa linha **não** é enviada ao OpenCode: o servidor tem a memória da
 * conversa, e mandar estado nosso como instrução de sistema seria dizer ao
 * modelo algo que o usuário não escreveu.
 *
 * ## Por que o dono existe
 *
 * A sonda (`GET /api/session/{id}`) prova que **alguma** sessão com aquele id
 * existe — não que ela nasceu aqui. O registro guarda o dono que a Evelyn
 * gravou na criação; só uma sessão com esse dono pode ser excluída. Um id
 * que aparece no servidor sem ele é tratado como externo: nunca se apaga, e
 * a conversa pede uma sessão nova.
 */
import type { DataStore } from './types/dataStore';

/** Quem é dono da sessão: a Evelyn, quando ela a criou. */
export type SessionOwnership = 'evelyn';

/** A sessão do OpenCode que uma conversa usa. */
export interface StoredSession {
	readonly id: string;
	readonly providerId: string;
	readonly modelId: string;
	/**
	 * A prova de propriedade.
	 *
	 * `evelyn` = a sessão nasceu por esta instalação, e pode ser excluída.
	 * Ausente = restaurada de um registro antigo: **nunca** excluída.
	 */
	readonly owner?: SessionOwnership;
	/** Onde ela vive — muda com a porta do servidor gerenciado. */
	readonly baseUrl?: string;
	/** Quando a Evelyn a viu nascer (ISO-8601). */
	readonly startedAt?: string;
}

/** Uma mensagem persistida. */
export interface StoredMessage {
	readonly role: 'user' | 'assistant';
	readonly content: string;
	readonly createdAt: string;
	/** O modelo que respondeu, quando o servidor disse. */
	readonly model?: string;
}

/** Uma conversa persistida. */
export interface StoredConversation {
	readonly id: string;
	readonly title: string;
	/** O modelo escolhido, como `providerID/modelID`. */
	readonly model: string;
	readonly session?: StoredSession;
	readonly messages: readonly StoredMessage[];
	readonly createdAt: string;
	readonly updatedAt: string;
}

/** O estado da sessão de uma conversa restaurada. */
export type RestoredSessionState =
	/** O servidor confirmou a sessão, e ela tem a prova de propriedade. */
	| 'active'
	/** O servidor não tem mais esta sessão (ou não respondeu). */
	| 'invalid'
	/** A sessão existe no servidor, mas não há prova de que a Evelyn a criou. */
	| 'unverified'
	/** A conversa nunca teve sessão. */
	| 'none';

/** Uma conversa restaurada. */
export interface RestoredConversation {
	readonly conversation: StoredConversation;
	readonly session: RestoredSessionState;
	/** Por que está `invalid`/`unverified`, quando está. */
	readonly reason?: string;
	/** `true` quando o registro veio do disco nesta inicialização. */
	readonly restored: true;
}

/** A restauração: o que voltou, e o que existe e não pôde ser lido. */
export interface RestorationReport {
	readonly conversations: readonly RestoredConversation[];
	/** Arquivos presentes e ilegíveis — ditos, nunca apagados. */
	readonly unreadable: readonly { readonly id: string; readonly reason: string }[];
}

/** O prefixo da linha de estado no histórico. */
export const OPENCODE_STATE_PREFIX = 'evelyn.opencode.state=';

/** Serializa modelo e sessão na linha de estado. */
export function stateLine(state: { readonly model: string; readonly session?: StoredSession }): string {
	return `${OPENCODE_STATE_PREFIX}${JSON.stringify({ v: 1, model: state.model, ...(state.session !== undefined ? { session: state.session } : {}) })}`;
}

/** Lê a linha de estado, se ela for válida. */
export function parseStateLine(
	content: string,
): { readonly model: string; readonly session?: StoredSession } | undefined {
	if (!content.startsWith(OPENCODE_STATE_PREFIX)) {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(content.slice(OPENCODE_STATE_PREFIX.length));
	} catch {
		return undefined;
	}
	if (parsed === null || typeof parsed !== 'object') {
		return undefined;
	}
	const record = parsed as Record<string, unknown>;
	const model = record['model'];
	if (typeof model !== 'string' || model.length === 0) {
		return undefined;
	}
	const session = parseSession(record['session']);
	return { model, ...(session !== undefined ? { session } : {}) };
}

/** Lê a sessão gravada, aceitando só o que é verificável. */
export function parseSession(value: unknown): StoredSession | undefined {
	if (value === null || typeof value !== 'object') {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	if (
		typeof record['id'] !== 'string' ||
		record['id'].length === 0 ||
		typeof record['providerId'] !== 'string' ||
		typeof record['modelId'] !== 'string'
	) {
		return undefined;
	}
	return {
		id: record['id'],
		providerId: record['providerId'],
		modelId: record['modelId'],
		// Só a grafia exata conta: qualquer outro valor é "sem prova".
		...(record['owner'] === 'evelyn' ? { owner: 'evelyn' as const } : {}),
		...(typeof record['baseUrl'] === 'string' ? { baseUrl: record['baseUrl'] } : {}),
		...(typeof record['startedAt'] === 'string' ? { startedAt: record['startedAt'] } : {}),
	};
}

/** Converte o arquivo do store no registro de continuidade. */
export function fromRecord(record: {
	readonly id: string;
	readonly title: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly messages: readonly { readonly role: string; readonly content: string; readonly createdAt: string }[];
}): StoredConversation | undefined {
	let state: { readonly model: string; readonly session?: StoredSession } | undefined;
	const messages: StoredMessage[] = [];
	for (const message of record.messages) {
		if (message.role === 'system') {
			const parsed = parseStateLine(message.content);
			if (parsed !== undefined) {
				// A última linha de estado vence: é a mais nova.
				state = parsed;
			}
			continue;
		}
		if (message.role !== 'user' && message.role !== 'assistant') {
			continue;
		}
		messages.push({ role: message.role, content: message.content, createdAt: message.createdAt });
	}
	if (state === undefined) {
		// Sem modelo, a conversa não pode continuar: o OpenCode precisa dele.
		return undefined;
	}
	return {
		id: record.id,
		title: record.title,
		model: state.model,
		...(state.session !== undefined ? { session: state.session } : {}),
		messages,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
	};
}

/** O armazenamento que o registro usa (o mesmo `FileDataStore` do Core). */
export type ConversationPort = Pick<
	DataStore,
	'listConversations' | 'getConversation' | 'createConversation' | 'appendMessages' | 'deleteConversation' | 'renameConversation'
>;

/**
 * Grava e lê as conversas do OpenCode.
 *
 * A gravação é a do `FileDataStore`: atômica, serializada e com índice. Uma
 * conversa que não pôde ser gravada é dita por quem chama; o turno em
 * memória continua — perder a resposta do modelo por causa do disco seria
 * pior.
 */
export class OpencodeConversationStore {
	constructor(private readonly port: ConversationPort) {}

	/** As conversas gravadas, com o que a continuidade precisa. */
	async loadAll(): Promise<RestorationReport> {
		const summaries = await this.port.listConversations();
		const conversations: RestoredConversation[] = [];
		const unreadable: { id: string; reason: string }[] = [];
		for (const summary of summaries) {
			try {
				const record = await this.port.getConversation(summary.id);
				if (record === undefined) {
					unreadable.push({ id: summary.id, reason: 'o arquivo sumiu entre a listagem e a leitura' });
					continue;
				}
				const parsed = fromRecord(record);
				if (parsed === undefined) {
					unreadable.push({ id: summary.id, reason: 'o arquivo não tem o estado do OpenCode (modelo)' });
					continue;
				}
				const owned = parsed.session?.owner === 'evelyn';
				conversations.push({
					conversation: parsed,
					session: parsed.session === undefined ? 'none' : owned ? 'active' : 'unverified',
					...(parsed.session !== undefined && !owned
						? { reason: 'não há prova de que a sessão foi criada pela Evelyn' }
						: {}),
					restored: true,
				});
			} catch (error) {
				// Uma conversa ilegível não impede as outras de voltar — e não é
				// apagada.
				unreadable.push({ id: summary.id, reason: error instanceof Error ? error.message : String(error) });
			}
		}
		return { conversations, unreadable };
	}

	/** Cria a conversa no disco, já com o estado do OpenCode. */
	async create(conversation: StoredConversation): Promise<void> {
		await this.port.createConversation({
			id: conversation.id,
			title: conversation.title,
			createdAt: conversation.createdAt,
		});
		await this.port.appendMessages(conversation.id, [
			{ role: 'system', content: stateLine({ model: conversation.model, ...(conversation.session !== undefined ? { session: conversation.session } : {}) }) },
		]);
	}

	/**
	 * Reescreve o que a conversa "é" agora: modelo escolhido e sessão.
	 *
	 * Entra como uma linha de estado nova — a última lida vence —, então o
	 * histórico do usuário nunca é reescrito.
	 */
	async updateState(conversationId: string, state: { readonly model: string; readonly session?: StoredSession }): Promise<void> {
		await this.port.appendMessages(conversationId, [{ role: 'system', content: stateLine(state) }]);
	}

	/** Grava as mensagens de um turno, na ordem em que aconteceram. */
	async appendMessages(conversationId: string, messages: readonly StoredMessage[]): Promise<void> {
		if (messages.length === 0) {
			return;
		}
		await this.port.appendMessages(
			conversationId,
			messages.map((message) => ({ role: message.role, content: message.content, createdAt: message.createdAt })),
		);
	}

	/** Apaga a conversa do disco (e o resumo). Idempotente: `absent` conta como feito. */
	async remove(conversationId: string): Promise<boolean> {
		const outcome = await this.port.deleteConversation(conversationId);
		// `unknown` é falha, não sucesso: quem chama precisa saber que a
		// remoção não foi confirmada (R4M).
		if (outcome === 'unknown') {
			throw new Error(`Could not confirm the deletion of conversation "${conversationId}"`);
		}
		return outcome === 'deleted';
	}

	/** Renomeia na origem — usado para o título do primeiro turno. */
	async rename(conversationId: string, title: string): Promise<void> {
		await this.port.renameConversation(conversationId, title);
	}
}
