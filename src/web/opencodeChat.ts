/**
 * A conversa com o OpenCode, pela interface web.
 *
 * ## O que esta camada é (e o que ela não é)
 *
 * É a ponte entre a página e o adaptador (`opencodeChat`): mantém as
 * conversas abertas pelo **usuário**, envia um turno e entrega o stream. O
 * protocolo, a sessão do servidor e a tradução para `ChatStream` moram no
 * adaptador; nada disso é reimplementado aqui.
 *
 * ## Conversas do usuário × sessões do servidor
 *
 * Uma "conversa" é do navegador (um id opaco gerado aqui). Cada conversa
 * guarda:
 *
 * - o modelo escolhido (o id composto do catálogo);
 * - a **sessão do OpenCode** associada, e o modelo com que ela foi criada —
 *   é ele que decide se a sessão pode ser reutilizada;
 * - as mensagens já trocadas, para a página as mostrar no reabrir;
 * - o turno em curso, para o `parar`.
 *
 * Nada de senha, cabeçalho ou corpo bruto é guardado: as mensagens são o
 * texto que o usuário digitou e o texto que o modelo respondeu.
 *
 * ## O que a página pode e não pode pedir
 *
 * Ela escolhe **o modelo do catálogo** (por id), **o texto** e **quando
 * parar**. Não escolhe URL, rota, servidor nem cabeçalho — isso continua
 * sendo do gerenciador (4C) e do catálogo (4D).
 *
 * ## Trocar de modelo no meio da conversa
 *
 * É permitido trocar o modelo de uma conversa que **já terminou**; o próximo
 * turno abre uma sessão nova, compatível com o novo modelo, e a anterior é
 * encerrada. Com um turno em curso, a troca é recusada.
 */
import { randomUUID } from 'node:crypto';
import type { ApiReply } from './api';
import { OpencodeChatAdapter, OpencodeChatError, type OpencodeSession } from '../app/opencodeChat';
import type { OpencodeCatalogService } from '../app/opencodeCatalogService';
import type { OpencodeManager } from '../app/opencodeManager';
import type {
	OpencodeConversationStore,
	RestoredConversation,
	StoredConversation,
	StoredMessage,
	StoredSession,
} from '../core/storage/opencodeConversations';

/** O que a página manda começar um turno. */
interface SendInput {
	readonly conversationId?: string;
	readonly model: string;
	readonly text: string;
}

/** Uma mensagem da conversa, como a página a mostra. */
export interface ConversationMessage {
	readonly role: 'user' | 'assistant';
	readonly text: string;
	readonly at: string;
	/** O modelo que respondeu, quando o servidor disse. */
	readonly model?: string;
}

/** A situação da sessão do OpenCode de uma conversa. */
export type ConversationSessionStatus =
	/** Nenhum turno ainda: o primeiro abre a sessão. */
	| 'none'
	/** A sessão existe e é a que o próximo turno usa. */
	| 'active'
	/** A sessão deixou de existir no servidor (ou não respondeu). */
	| 'invalid'
	/** A sessão existe, mas a Evelyn não pode provar que a criou. */
	| 'unverified';

/** O que a página vê da sessão. */
interface SessionView {
	readonly status: ConversationSessionStatus;
	readonly id?: string;
	readonly model?: string;
	readonly reason?: string;
}

/** Uma conversa aberta pela página. */
interface Conversation {
	readonly id: string;
	readonly title: string;
	model: string;
	/** A sessão viva no adaptador, quando há. */
	session?: OpencodeSession;
	/** O modelo com que a sessão foi criada. */
	sessionModel?: string;
	/** A sessão caiu por um motivo: a página diz, e o próximo turno abre outra. */
	sessionInvalidReason?: string;
	/** `invalid` (sumiu) ou `unverified` (sem prova de propriedade). */
	sessionStatus?: 'invalid' | 'unverified';
	readonly messages: ConversationMessage[];
	/**
	 * A conversa veio do disco nesta inicialização.
	 *
	 * A página diz isso ao lado do estado da sessão: "restaurada" e "contexto
	 * não verificado" são fatos diferentes.
	 */
	readonly restored: boolean;
	/** Quando o registro foi criado (ISO), do disco. */
	readonly createdAt: string;
	/** O turno em curso, se houver. */
	current?: { readonly controller: AbortController; readonly turnId: string };
}

/** O erro de uma ação, para a página. */
function failure(status: number, error: string): ApiReply {
	return { status, body: { error } };
}

/** Lê o corpo de um envio. */
function parseSend(body: unknown): SendInput {
	if (body === null || typeof body !== 'object') {
		throw new Error('o envio precisa de modelo e texto');
	}
	const input = body as Record<string, unknown>;
	const model = typeof input['model'] === 'string' ? input['model'].trim() : '';
	const text = typeof input['text'] === 'string' ? input['text'] : '';
	const conversationId = typeof input['conversationId'] === 'string' ? input['conversationId'] : undefined;
	if (model.length === 0) {
		throw new Error('escolha um modelo do catálogo do OpenCode');
	}
	if (text.trim().length === 0) {
		throw new Error('escreva uma mensagem');
	}
	// Só os campos conhecidos: nada de URL, rota, cabeçalho ou servidor.
	for (const key of Object.keys(input)) {
		if (key !== 'conversationId' && key !== 'model' && key !== 'text') {
			throw new Error(`o campo "${key}" não é aceito no envio`);
		}
	}
	return { ...(conversationId !== undefined ? { conversationId } : {}), model, text };
}

/** O status HTTP do código de uma falha do adaptador. */
function statusOf(error: unknown): number {
	if (error instanceof OpencodeChatError) {
		switch (error.code) {
			case 'auth':
				return 401;
			case 'no-connection':
			case 'model-not-in-catalog':
			case 'session-lost':
				return 409;
			case 'timeout':
				return 504;
			default:
				return 502;
		}
	}
	return 500;
}

/**
 * As conversas do OpenCode.
 *
 * Um por host: as conversas vivem no processo que tem o adaptador.
 */
export class OpencodeChatController {
	private readonly conversations = new Map<string, Conversation>();
	private adapter: OpencodeChatAdapter | undefined;

	constructor(
		private readonly manager: OpencodeManager | undefined,
		private readonly catalog: OpencodeCatalogService | undefined,
		private readonly store?: OpencodeConversationStore,
		private readonly now: () => Date = () => new Date(),
	) {}

	/** A restauração do disco, iniciada uma vez (o construtor a dispara). */
	private restoring: Promise<void> | undefined;
	/** O que a restauração não conseguiu ler — dito, nunca apagado. */
	private unreadable: { readonly id: string; readonly reason: string }[] = [];

	/**
	 * Lê o registro do disco e coloca as conversas na lista.
	 *
	 * A sessão de cada conversa é **verificada** (a sonda do adaptador): só
	 * uma sessão que existe e tem a prova de propriedade fica "ativa". As
	 * outras ficam "inválida" ou "não verificada" — e o histórico fica.
	 *
	 * Roda **uma vez**: chamar de novo não relê.
	 */
	restoreOnce(): Promise<void> {
		this.restoring ??= this.restoreNow();
		return this.restoring;
	}

	private async restoreNow(): Promise<void> {
		if (this.store === undefined) {
			return;
		}
		let report;
		try {
			report = await this.store.loadAll();
		} catch (error) {
			// O registro inteiro ilegível não derruba o app: a página começa
			// vazia e diz o motivo.
			this.unreadable = [{ id: '-', reason: error instanceof Error ? error.message : String(error) }];
			return;
		}
		this.unreadable = [...report.unreadable];
		for (const entry of report.conversations) {
			// Uma conversa já aberta nesta execução vence o disco (é mais nova).
			if (this.conversations.has(entry.conversation.id)) {
				continue;
			}
			const conversation = toConversation(entry);
			// A sessão restaurada só é reutilizável se a Evelyn consegue provar
			// que a criou. Sem isso, o próximo turno abre uma nova — e a sessão
			// antiga **nunca** é excluída por nós. (`toConversation` só devolve
			// `session` para uma entrada `active`, que já vem com a prova.)
			if (entry.session !== 'active' && conversation.session !== undefined) {
				conversation.session = undefined;
			}
			this.conversations.set(conversation.id, conversation);
		}
		// A sessão restaurada só é adotada pelo adaptador quando o registro
		// prova a propriedade — é o que permite encerrá-la depois (troca de
		// modelo, descarte, fim do host). Uma sessão sem prova nunca entra.
		for (const conversation of this.conversations.values()) {
			if (conversation.session !== undefined) {
				this.adapterFor().adoptSession(conversation.session);
			}
		}
		// Valida as sessões restauradas com o servidor, se houver conexão.
		if (this.manager?.connection() !== undefined && this.conversations.size > 0) {
			await this.verifyRestoredSessions();
		}
	}

	/**
	 * Confirma no servidor as sessões restauradas.
	 *
	 * `probeSessions` do adaptador responde, por id: existe / sumiu / sem
	 * prova de propriedade. Um id que sumiu fica "inválido"; um que existe
	 * sem a prova fica "não verificado" — e nos dois casos o próximo turno
	 * abre uma sessão nova, e a antiga **não** é excluída.
	 */
	private async verifyRestoredSessions(): Promise<void> {
		const adapter = this.adapterFor();
		const targets = [...this.conversations.values()].filter(
			(conversation) => conversation.session !== undefined,
		);
		const states = await adapter.probeSessions(
			targets.map((conversation) => conversation.session as OpencodeSession),
		);
		for (const conversation of targets) {
			const session = conversation.session;
			if (session === undefined) {
				continue;
			}
			const state = states.get(session.id);
			if (state === 'missing') {
				conversation.session = undefined;
				conversation.sessionStatus = 'invalid';
				conversation.sessionInvalidReason =
					'o servidor não tem mais esta sessão; o próximo turno abre uma nova, e o contexto anterior não é reenviado';
			} else if (state === 'unverified') {
				conversation.session = undefined;
				conversation.sessionStatus = 'unverified';
				conversation.sessionInvalidReason =
					'a sessão existe no servidor, mas não há prova de que a Evelyn a criou; ela não será tocada, e o próximo turno abre uma nova';
			}
		}
	}

	/** As conversas abertas, sem o histórico completo. */
	async list(): Promise<ApiReply> {
		await this.restoreOnce();
		const connection = this.manager?.connection();
		return {
			status: 200,
			body: {
				connected: connection !== undefined,
				conversations: [...this.conversations.values()].map((conversation) => ({
					id: conversation.id,
					title: conversation.title,
					model: conversation.model,
					messages: conversation.messages.length,
					busy: conversation.current !== undefined,
					restored: conversation.restored,
					createdAt: conversation.createdAt,
					session: sessionView(conversation),
				})),
				unreadable: this.unreadable,
			},
		};
	}

	/** Uma conversa e o seu histórico. */
	async get(conversationId: string): Promise<ApiReply> {
		await this.restoreOnce();
		const conversation = this.conversations.get(conversationId);
		if (conversation === undefined) {
			return failure(404, 'não há conversa com esse id');
		}
		return {
			status: 200,
			body: {
				id: conversation.id,
				model: conversation.model,
				messages: conversation.messages,
				busy: conversation.current !== undefined,
				session: sessionView(conversation),
			},
		};
	}

	/**
	 * Troca o modelo de uma conversa parada.
	 *
	 * O modelo tem de estar no catálogo **atual**; a sessão anterior é
	 * encerrada aqui, porque ela não serve para o novo modelo.
	 */
	async selectModel(body: unknown): Promise<ApiReply> {
		const input = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
		const conversationId = typeof input['conversationId'] === 'string' ? input['conversationId'] : undefined;
		const model = typeof input['model'] === 'string' ? input['model'].trim() : '';
		if (conversationId === undefined || model.length === 0) {
			return failure(400, 'informe a conversa e o modelo');
		}
		for (const key of Object.keys(input)) {
			if (key !== 'conversationId' && key !== 'model') {
				return failure(400, `o campo "${key}" não é aceito`);
			}
		}
		const conversation = this.conversations.get(conversationId);
		if (conversation === undefined) {
			return failure(404, 'não há conversa com esse id');
		}
		if (conversation.current !== undefined) {
			return failure(409, 'pare o turno em curso antes de trocar o modelo');
		}
		const verdict = await this.validateModel(model);
		if (verdict !== undefined) {
			return verdict;
		}
		if (conversation.model !== model) {
			await this.retireSession(conversation);
		}
		conversation.model = model;
		await this.persistState(conversation);
		return { status: 200, body: { id: conversation.id, model, session: sessionView(conversation) } };
	}

	/**
	 * Discarta uma conversa: as mensagens e a sessão do OpenCode.
	 *
	 * A sessão é encerrada de verdade, e a conversa some da lista. Nenhuma
	 * outra conversa é tocada.
	 */
	async discard(body: unknown): Promise<ApiReply> {
		const input = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
		const conversationId = typeof input['conversationId'] === 'string' ? input['conversationId'] : undefined;
		if (conversationId === undefined) {
			return failure(400, 'informe a conversa');
		}
		const conversation = this.conversations.get(conversationId);
		if (conversation === undefined) {
			return failure(404, 'não há conversa com esse id');
		}
		conversation.current?.controller.abort();
		await this.retireSession(conversation);
		this.conversations.delete(conversationId);
		// O descarte apaga o registro; uma falha aqui é dita, e a conversa já
		// saiu da memória (não volta a aparecer nesta execução).
		if (this.store !== undefined) {
			try {
				await this.store.remove(conversationId);
			} catch (error) {
				return failure(409, `a conversa foi descartada, mas o registro não pôde ser apagado: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return { status: 200, body: { discarded: true, conversationId } };
	}

	/**
	 * Envia um turno e devolve o stream.
	 *
	 * O primeiro evento (`started`) diz qual sessão o turno usa — a mesma do
	 * turno anterior, ou uma nova. `delta` traz texto, `done` fecha, `error`
	 * tem o motivo.
	 */
	async send(body: unknown): Promise<ApiReply & { readonly stream?: ReadableStream<Uint8Array> }> {
		let input: SendInput;
		try {
			input = parseSend(body);
		} catch (error) {
			return failure(400, error instanceof Error ? error.message : String(error));
		}
		const connection = this.manager?.connection();
		if (connection === undefined) {
			return failure(409, 'não há conexão com um servidor OpenCode');
		}
		await this.restoreOnce();
		let conversation =
			input.conversationId === undefined ? undefined : this.conversations.get(input.conversationId);
		if (input.conversationId !== undefined && conversation === undefined) {
			return failure(404, 'não há conversa com esse id');
		}
		if (conversation?.current !== undefined) {
			return failure(409, 'já há um turno em curso nesta conversa');
		}
		const verdict = await this.validateModel(input.model);
		if (verdict !== undefined) {
			return verdict;
		}
		if (conversation !== undefined && conversation.model !== input.model) {
			// O modelo mudou: a sessão antiga não serve para o novo.
			await this.retireSession(conversation);
			conversation.model = input.model;
		}
		if (conversation === undefined) {
			const created: Conversation = {
				id: `cnv_${randomUUID()}`,
				title: titleFrom(input.text),
				model: input.model,
				messages: [],
				restored: false,
				createdAt: (this.now?.() ?? new Date()).toISOString(),
			};
			this.conversations.set(created.id, created);
			conversation = created;
			// O registro é gravado antes do turno: uma conversa que existe na
			// memória e não no disco sumiria no reinício.
			void this.persistNew(created);
		}

		const adapter = this.adapterFor();
		const nowIso = (): string => (this.now?.() ?? new Date()).toISOString();
		const controller = new AbortController();
		const turnId = `turn_${randomUUID()}`;
		conversation.current = { controller, turnId };
		conversation.messages.push({ role: 'user', text: input.text, at: nowIso() });
		const active = conversation;

		let stream;
		try {
			stream = await adapter.streamChat(
				{ model: active.model, messages: [{ role: 'user', content: input.text }] },
				{
					signal: controller.signal,
					...(active.session !== undefined ? { session: active.session } : {}),
				},
			);
		} catch (error) {
			active.current = undefined;
			const message = error instanceof Error ? error.message : String(error);
			return failure(statusOf(error), message);
		}

		const conversationRef = active;
		const userText = conversation.messages[conversation.messages.length - 1]?.text ?? '';
		const encoder = new TextEncoder();
		const persistTurn = (answer: string, answered: string | undefined, at: () => string): void => {
			// O turno vai para o disco no fim: a pergunta e a resposta, juntas.
			void this.persistTurn(conversationRef, userText, answer, answered, at);
		};
		const eventStream = new ReadableStream<Uint8Array>({
			start(streamController) {
				const write = (payload: Record<string, unknown>): void => {
					try {
						streamController.enqueue(encoder.encode(`data: ${JSON.stringify({ turnId, ...payload })}\n\n`));
					} catch {
						// O navegador já fechou a conexão: nada a entregar.
					}
				};
				void (async () => {
					const parts: string[] = [];
					let announcedSession = false;
					const announce = (): void => {
						if (announcedSession) {
							return;
						}
						const announced = turnInfo(stream);
						if (announced === undefined) {
							return;
						}
						announcedSession = true;
						conversationRef.session = announced.session;
						conversationRef.sessionModel = announced.model;
						conversationRef.sessionInvalidReason = undefined;
						write({
							type: 'started',
							conversationId: conversationRef.id,
							model: conversationRef.model,
							origin: announced.origin,
							session: sessionView(conversationRef),
						});
					};
					let respondedModel: string | undefined;
					let failure: { readonly message: string; readonly code: string } | undefined;
					try {
						for await (const event of stream) {
							announce();
							if (event.type === 'TextDelta') {
								parts.push(event.text);
								write({ type: 'delta', text: event.text });
								continue;
							}
							if (event.type === 'ReasoningDelta') {
								write({ type: 'reasoning', text: event.text });
								continue;
							}
							if (event.type === 'Error') {
								const code = event.error instanceof OpencodeChatError ? event.error.code : 'server';
								failure = { message: event.error.message, code };
								if (code === 'session-lost') {
									// O contexto no servidor não pode ser confirmado: a
									// conversa segue na lista, mas o próximo turno abre
									// uma sessão nova — e a página diz isso.
									conversationRef.session = undefined;
									conversationRef.sessionStatus = 'invalid';
									conversationRef.sessionInvalidReason = event.error.message;
								}
								write({
									type: 'error',
									error: event.error.message,
									code,
									session: sessionView(conversationRef),
								});
								continue;
							}
							if (event.type === 'Done') {
								respondedModel = stream.respondedModel;
								write({ type: 'done', finishReason: event.finishReason ?? null, model: respondedModel ?? null });
							}
						}
					} catch (error) {
						failure = { message: error instanceof Error ? error.message : String(error), code: 'stream' };
						write({ type: 'error', error: failure.message, code: failure.code });
					} finally {
						announce();
						// O estado da sessão vai no fim, para a página nunca mostrar uma
						// sessão que já não vale.
						write({
							type: 'session',
							session: sessionView(conversationRef),
						});
						const text = parts.join('');
						if (text.length > 0) {
							conversationRef.messages.push({
								role: 'assistant',
								text,
								at: nowIso(),
								...(respondedModel !== undefined ? { model: respondedModel } : {}),
							});
						}
						// O turno inteiro vai para o disco de uma vez: a pergunta
						// e a resposta, na ordem em que entraram. Um turno
						// interrompido grava só o que foi trocado.
						persistTurn(text, respondedModel, nowIso);
						conversationRef.current = undefined;
						if (stream.closedReason !== 'completed' && failure === undefined) {
							const reason =
								stream.closedReason === 'aborted'
									? 'o turno foi interrompido'
									: stream.closedReason === 'closed'
										? 'o navegador soltou o stream antes do fim'
										: 'o turno terminou sem resposta completa';
							write({ type: 'done', finishReason: stream.closedReason, model: stream.respondedModel ?? null, note: reason });
						}
						try {
							streamController.close();
						} catch {
							// já fechado
						}
					}
				})();
			},
			cancel() {
				// O navegador foi embora: o turno não pode ficar vivo.
				conversationRef.current?.controller.abort();
			},
		});
		return { status: 200, body: { conversationId: conversation.id, turnId }, stream: eventStream };
	}

	/** Para o turno de uma conversa. Sem turno, nada a fazer. */
	async stop(body: unknown): Promise<ApiReply> {
		const input = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
		const conversationId = typeof input['conversationId'] === 'string' ? input['conversationId'] : undefined;
		if (conversationId === undefined) {
			return failure(400, 'informe a conversa');
		}
		const conversation = this.conversations.get(conversationId);
		if (conversation === undefined) {
			return failure(404, 'não há conversa com esse id');
		}
		if (conversation.current === undefined) {
			return { status: 200, body: { stopped: false } };
		}
		conversation.current.controller.abort();
		return { status: 200, body: { stopped: true, conversationId } };
	}

	/**
	 * Grava uma conversa nova no disco.
	 *
	 * Antes do primeiro turno: uma conversa que só está na memória some no
	 * reinício, e o usuário perde o que já escreveu.
	 */
	private async persistNew(conversation: Conversation): Promise<void> {
		if (this.store === undefined) {
			return;
		}
		try {
			await this.store.create(toStored(conversation));
		} catch (error) {
			this.persistFailure('criar', error);
		}
	}

	/** Grava o turno (pergunta e resposta) e o estado da sessão. */
	private async persistTurn(
		conversation: Conversation,
		userText: string,
		answer: string,
		respondedModel: string | undefined,
		at: () => string,
	): Promise<void> {
		if (this.store === undefined) {
			return;
		}
		try {
			const turn: StoredMessage[] = [
				{ role: 'user', content: userText, createdAt: at() },
				...(answer.length > 0
					? [
							{
								role: 'assistant' as const,
								content: answer,
								createdAt: at(),
								...(respondedModel !== undefined ? { model: respondedModel } : {}),
							},
						]
					: []),
			];
			await this.store.appendMessages(conversation.id, turn);
			await this.persistState(conversation);
		} catch (error) {
			this.persistFailure('gravar o turno', error);
		}
	}

	/** Grava o modelo e a sessão, depois de uma troca ou de uma sessão nova. */
	private async persistState(conversation: Conversation): Promise<void> {
		if (this.store === undefined) {
			return;
		}
		try {
			await this.store.updateState(conversation.id, {
				model: conversation.model,
				...(conversation.session !== undefined ? { session: toStoredSession(conversation.session) } : {}),
			});
			// A sessão nova também atualiza o título da conversa, se ainda for o
			// inicial.
		} catch (error) {
			this.persistFailure('gravar o estado', error);
		}
	}

	/** Uma falha de gravação é dita no log — nunca com conteúdo da conversa. */
	private persistFailure(what: string, error: unknown): void {
		this.unreadable = [
			...this.unreadable.filter((entry) => entry.id !== 'write'),
			{ id: 'write', reason: `não foi possível ${what} no disco: ${error instanceof Error ? error.message : String(error)}` },
		];
	}

	/**
	 * Encerra os turnos e as sessões (o host está fechando, ou o backend
	 * desconectou).
	 */
	dispose(): void {
		for (const conversation of this.conversations.values()) {
			conversation.current?.controller.abort();
			conversation.session = undefined;
		}
		this.conversations.clear();
		this.adapter?.dispose();
		this.adapter = undefined;
	}

	/**
	 * Encerra a sessão de uma conversa, sem tocar nas outras.
	 *
	 * Depois de encerrada, a conversa passa a dizer "sem sessão": o próximo
	 * turno abre uma sessão nova, e o histórico visível não muda.
	 */
	private async retireSession(conversation: Conversation): Promise<void> {
		const session = conversation.session;
		conversation.session = undefined;
		conversation.sessionModel = undefined;
		conversation.sessionInvalidReason = undefined;
		if (session === undefined || this.adapter === undefined) {
			return;
		}
		await this.adapter.closeSession(session);
	}

	/** O adaptador, criado na primeira conversa e preso à conexão do gerenciador. */
	private adapterFor(): OpencodeChatAdapter {
		if (this.adapter !== undefined) {
			return this.adapter;
		}
		this.adapter = new OpencodeChatAdapter({
			connection: () => this.manager?.connection(),
			catalog: async () => {
				const state = await this.catalog?.state();
				if (state === undefined || (state.state !== 'ok' && state.state !== 'stale')) {
					return undefined;
				}
				return {
					state: state.state,
					models: state.catalog.models.map((model) => ({
						providerId: model.providerId,
						modelId: model.modelId,
					})),
				};
			},
			fetch: globalThis.fetch,
		});
		return this.adapter;
	}

	/** O modelo está no catálogo atual? O `undefined` é "sim". */
	private async validateModel(model: string): Promise<ApiReply | undefined> {
		const state = await this.catalog?.state();
		if (state === undefined || (state.state !== 'ok' && state.state !== 'stale')) {
			return failure(409, 'atualize o catálogo do OpenCode antes de escolher um modelo');
		}
		if (state.state === 'stale') {
			// Um catálogo desatualizado pode listar um modelo que o servidor já
			// não serve: a escolha exige uma leitura de agora.
			return failure(409, 'o catálogo está desatualizado; atualize-o antes de escolher um modelo');
		}
		const exists = state.catalog.models.some((entry) => `${entry.providerId}/${entry.modelId}` === model);
		if (!exists) {
			return failure(409, `o modelo "${model}" não está no catálogo atual`);
		}
		return undefined;
	}
}

/**
 * A sessão do turno que acabou de abrir, e como ela veio.
 *
 * O adaptador publica o `SessionStarted` num campo do stream devolvido; o
 * núcleo não o conhece, e o controller o lê aqui — num lugar só.
 */
export function turnInfo(stream: unknown): { readonly session: OpencodeSession; readonly model: string; readonly origin: string } | undefined {
	const started = (stream as { readonly started?: { readonly session?: OpencodeSession; readonly model?: string; readonly origin?: string } })
		?.started;
	if (started?.session === undefined || started.model === undefined || started.origin === undefined) {
		return undefined;
	}
	return { session: started.session, model: started.model, origin: started.origin };
}

/** O título inicial de uma conversa: a primeira linha da pergunta. */
function titleFrom(text: string): string {
	const first = text.trim().split(/\r?\n/)[0] ?? '';
	const trimmed = first.trim();
	if (trimmed.length === 0) {
		return 'Conversa';
	}
	return trimmed.length > 80 ? `${trimmed.slice(0, 77)}…` : trimmed;
}

/** A sessão no formato do disco, com a prova de propriedade. */
function toStoredSession(session: OpencodeSession): StoredSession {
	return {
		id: session.id,
		providerId: session.model.providerID,
		modelId: session.model.modelID,
		// A prova: esta sessão nasceu por este adaptador.
		owner: 'evelyn',
		baseUrl: session.baseUrl,
	};
}

/** A conversa no formato do disco. */
function toStored(conversation: Conversation): StoredConversation {
	return {
		id: conversation.id,
		title: conversation.title,
		model: conversation.model,
		...(conversation.session !== undefined ? { session: toStoredSession(conversation.session) } : {}),
		messages: conversation.messages.map((message) => ({
			role: message.role,
			content: message.text,
			createdAt: message.at,
			...(message.model !== undefined ? { model: message.model } : {}),
		})),
		createdAt: conversation.createdAt,
		updatedAt: (conversation.messages[conversation.messages.length - 1]?.at ?? conversation.createdAt),
	};
}

/** Uma conversa restaurada vira o que a página usa. */
function toConversation(entry: RestoredConversation): Conversation {
	const stored = entry.conversation;
	const session: OpencodeSession | undefined =
		stored.session !== undefined && stored.session.owner === 'evelyn'
			? {
					id: stored.session.id,
					model: { providerID: stored.session.providerId, modelID: stored.session.modelId },
					baseUrl: stored.session.baseUrl ?? '',
				}
			: undefined;
	return {
		id: stored.id,
		title: stored.title,
		model: stored.model,
		...(session !== undefined ? { session } : {}),
		...(stored.session !== undefined && session === undefined
			? { sessionInvalidReason: entry.reason ?? 'não há prova de que a sessão foi criada pela Evelyn' }
			: {}),
		messages: stored.messages.map((message) => ({
			role: message.role,
			text: message.content,
			at: message.createdAt,
			...(message.model !== undefined ? { model: message.model } : {}),
		})),
		restored: true,
		createdAt: stored.createdAt,
	};
}

/** A situação da sessão, como a página vê. */
function sessionView(conversation: Conversation): SessionView {
	if (conversation.session === undefined) {
		return conversation.sessionInvalidReason !== undefined
			? { status: 'invalid', reason: conversation.sessionInvalidReason }
			: { status: 'none' };
	}
	return {
		status: 'active',
		id: conversation.session.id,
		...(conversation.sessionModel !== undefined ? { model: conversation.sessionModel } : {}),
	};
}
