/**
 * O cliente de **conversa** do Desktop conectado (R4C).
 *
 * ## O que ele faz
 *
 * Envia um turno ao serviço, lê os eventos em SSE, responde permissões e
 * cancela **o próprio** turno. É o transporte: o turno em si roda no motor do
 * serviço (`ChatSession.runExternalTurn`), com o roteamento, as ferramentas e
 * o orçamento daquele Core.
 *
 * ## Isolamento entre turnos
 *
 * Cada `run` cria o próprio leitor de SSE, o próprio `AbortController` e a
 * própria saída de eventos. O serviço entrega a cada conexão só os eventos do
 * turno dela; aqui todos os eventos são ainda reatribuídos ao `turnId` da
 * conexão, para um serviço com defeito não fazer este cliente mostrar um
 * evento em outro turno.
 *
 * ## A credencial
 *
 * `chatToken`, no header `x-seshyina-chat`. Executa turnos e responde a
 * permissão do próprio turno. Não lê configuração, não escreve provedor e não
 * encerra o serviço — e o serviço a recusa em todas essas rotas.
 */
import { ServiceClient, READER_HEADER, type ServiceClientFailureCode } from './serviceClient';
import { probeService } from '../app/discoverService';
import type { ServiceRecord } from '../app/serviceRecord';
import { parseAvailableModels, type AvailableModel, type PermissionAnswer, type TurnRouting } from './contract';

/** O header da credencial de conversa. */
export const CHAT_HEADER = 'x-seshyina-chat';

/** As rotas do serviço. */
const TURN_ROUTE = '/api/chat/turn';
const CANCEL_ROUTE = '/api/chat/cancel';
const ANSWER_ROUTE = '/api/chat/answer';
/** R4D: o histórico. */
const CONVERSATIONS_ROUTE = '/api/chat/conversations';
const CONVERSATION_ROUTE = '/api/chat/conversation';
/** R4E: criar. */
const CREATE_ROUTE = '/api/chat/create';
/** R4F: renomear e excluir. */
const RENAME_ROUTE = '/api/chat/rename';
const DELETE_ROUTE = '/api/chat/delete';
/** R4H: estado dos turnos. */
const TURN_STATE_ROUTE = '/api/chat/turn-state';

/** Um evento do turno, como o serviço o enviou. */
export interface RemoteTurnEvent {
	readonly type: string;
	readonly turnId: string;
	readonly [key: string]: unknown;
}

/** O que o cliente precisa. */
export interface ServiceChatOptions {
	readonly root: string;
	/** A descoberta já configurada; padrão: uma nova sobre a raiz. */
	readonly service?: ServiceClient;
	readonly fetch?: typeof fetch;
}

/** Um turno em andamento neste cliente. */
export interface RunningTurn {
	readonly turnId: string;
	/** Cancela o turno no serviço **e** fecha a conexão. */
	cancel(): Promise<void>;
	/** Termina quando o stream acaba (por fim, erro ou cancelamento). */
	readonly done: Promise<void>;
}

/** O cliente de conversa. */
export class ServiceChatClient {
	constructor(private readonly options: ServiceChatOptions) {}

	private service(): ServiceClient {
		return this.options.service ?? new ServiceClient({ root: this.options.root });
	}

	private async record(): Promise<ServiceRecord | undefined> {
		// A descoberta usa o **mesmo** cliente do resto (R4S): `options.service`
		// era ignorado aqui, e um cliente com descoberta injetada (teste,
		// host com outro transporte) descobria por um caminho e conversava por
		// outro — ou, no caso de um teste, batia na rede sem querer.
		const client = this.options.service;
		if (client !== undefined) {
			return await client.record();
		}
		const doFetch = this.options.fetch;
		const probe = await probeService({
			root: this.options.root,
			...(doFetch !== undefined
				? {
						fetchHealth: async (url: string, token: string) => {
							const response = await doFetch(url, { headers: { 'x-seshyina-token': token } });
							if (!response.ok) {
								return undefined;
							}
							const body = (await response.json().catch(() => undefined)) as
								| Record<string, unknown>
								| undefined;
							if (body === undefined) {
								return undefined;
							}
							return {
								status: String(body['status'] ?? ''),
								app: String(body['app'] ?? ''),
								version: String(body['version'] ?? ''),
								listening: String(body['listening'] ?? ''),
								coreMounted: body['coreMounted'] === true,
								storageHost: typeof body['storageHost'] === 'string' ? body['storageHost'] : null,
								...(typeof body['pid'] === 'number' ? { pid: body['pid'] } : {}),
							};
						},
					}
				: {}),
		});
		return probe.kind === 'active' ? probe.record : undefined;
	}

	/**
	 * Roda um turno e entrega os eventos a `onEvent`, na ordem.
	 *
	 * Resolve quando o turno é **aceito** (o serviço anunciou o `turnId`);
	 * `turn.done` termina quando o stream acaba.
	 */
	async run(input: {
		readonly conversationId: string;
		readonly providerId: string;
		readonly model: string;
		readonly text: string;
		/** O modo do chat (DEV-8.10). Ausente = par obrigatório, como antes. */
		readonly routing?: TurnRouting;
		readonly onEvent: (event: RemoteTurnEvent) => void;
		readonly signal?: AbortSignal;
	}): Promise<
		| { readonly ok: true; readonly turn: RunningTurn }
		| {
				readonly ok: false;
				readonly code: ServiceClientFailureCode | 'rejected';
				readonly message: string;
		  }
	> {
		const record = await this.record();
		if (record === undefined) {
			return { ok: false, code: 'inactive', message: 'o serviço local não está ativo' };
		}

		const doFetch = this.options.fetch ?? globalThis.fetch;
		const controller = new AbortController();
		const onExternalAbort = (): void => controller.abort(input.signal?.reason);
		if (input.signal?.aborted === true) {
			controller.abort(input.signal.reason);
		} else {
			input.signal?.addEventListener('abort', onExternalAbort, { once: true });
		}
		const detach = (): void => input.signal?.removeEventListener('abort', onExternalAbort);

		let response: Response;
		try {
			response = await doFetch(`${baseUrl(record)}${TURN_ROUTE}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', [CHAT_HEADER]: record.chatToken },
				body: JSON.stringify({
					conversationId: input.conversationId,
					providerId: input.providerId,
					model: input.model,
					text: input.text,
					...(input.routing !== undefined ? { routing: input.routing } : {}),
				}),
				signal: controller.signal,
			});
		} catch (error) {
			detach();
			return {
				ok: false,
				code: nameOf(error) === 'TimeoutError' ? 'timeout' : 'unreachable',
				message: 'não foi possível conectar ao serviço local',
			};
		}

		if (response.status !== 200 || response.body === null) {
			const body = await response.text().catch(() => '');
			detach();
			return {
				ok: false,
				code: statusCode(response.status),
				message: messageFrom(body, response.status),
			};
		}

		// Um leitor só para o stream inteiro: o `started` é o primeiro evento
		// e o restante continua sendo lido pela mesma leitura.
		const reader = new SseReader(response.body);
		const first = await reader.next();
		if (first === undefined || first.type !== 'started' || typeof first.turnId !== 'string') {
			await reader.close();
			return {
				ok: false,
				code: 'invalid-response',
				message: 'o serviço não anunciou o turno',
			};
		}
		const turnId = first.turnId;

		const done = (async (): Promise<void> => {
			try {
				for (;;) {
					const event = await reader.next();
					if (event === undefined) {
						return;
					}
					// Reatribuído ao turno **desta** conexão.
					input.onEvent({
						...event,
						type: typeof event['type'] === 'string' ? event['type'] : 'unknown',
						turnId,
					});
				}
			} catch (error) {
				input.onEvent({
					type: 'error',
					turnId,
					message:
						nameOf(error) === 'AbortError'
							? 'o turno foi cancelado'
							: 'a conexão com o serviço local foi interrompida',
				});
			} finally {
				detach();
			}
		})();

		return {
			ok: true,
			turn: {
				turnId,
				async cancel() {
					controller.abort();
					await doFetch(`${baseUrl(record)}${CANCEL_ROUTE}`, {
						method: 'POST',
						headers: { 'content-type': 'application/json', [CHAT_HEADER]: record.chatToken },
						body: JSON.stringify({ turnId }),
					}).catch(() => undefined);
				},
				done,
			},
		};
	}

	/**
	 * Renomeia uma conversa (R4F).
	 *
	 * `rejected` quando o id não existe (`404`); a interface diz isso e
	 * mantém a seleção como está — renomear uma conversa que sumiu não é
	 * motivo para perder o que está na tela.
	 */
	async renameConversation(
		conversationId: string,
		title: string,
	): Promise<
		| { readonly ok: true; readonly conversation: RemoteConversationSummary }
		| {
				readonly ok: false;
				readonly code: ServiceClientFailureCode | 'rejected' | 'unknown';
				readonly message: string;
		  }
	> {
		const record = await this.record();
		if (record === undefined) {
			return { ok: false, code: 'inactive', message: 'o serviço local não está ativo' };
		}
		const doFetch = this.options.fetch ?? globalThis.fetch;
		let response: Response;
		try {
			response = await doFetch(`${baseUrl(record)}${RENAME_ROUTE}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', [CHAT_HEADER]: record.chatToken },
				body: JSON.stringify({ id: conversationId, title }),
			});
		} catch {
			// Renomear é idempotente: tentar de novo é seguro. "Desconhecido"
			// ainda é a resposta honesta, porque não sabemos se gravou.
			return {
				ok: false,
				code: 'unknown',
				message: 'a conexão caiu antes da resposta; recarregue a lista para ver o título',
			};
		}
		if (response.status !== 200) {
			const body = await response.text().catch(() => '');
			return { ok: false, code: statusCode(response.status), message: messageFrom(body, response.status) };
		}
		const body = (await response.json().catch(() => undefined)) as
			| { readonly conversation?: unknown }
			| undefined;
		const conversation = parseConversationSummary(body?.conversation);
		if (conversation === undefined) {
			return { ok: false, code: 'unknown', message: 'o serviço respondeu um título fora do contrato' };
		}
		return { ok: true, conversation };
	}

	/**
	 * Exclui uma conversa (R4F, protegida na R4G).
	 *
	 * `rejected` quando ela já não existe (`404`); **`busy`** quando há um
	 * turno em curso nela (`409 conversation_busy`) — a conversa não foi
	 * tocada, e a interface deve manter seleção e histórico.
	 *
	 * Sem conexão **antes** do envio: nada foi excluído. Se a conexão cai
	 * depois, o resultado é desconhecido: a exclusão pode ter acontecido.
	 */
	async deleteConversation(conversationId: string): Promise<
		| { readonly ok: true }
		| {
				readonly ok: false;
				readonly code: ServiceClientFailureCode | 'rejected' | 'unknown' | 'busy';
				readonly message: string;
		  }
	> {
		const record = await this.record();
		if (record === undefined) {
			return { ok: false, code: 'inactive', message: 'o serviço local não está ativo' };
		}
		const doFetch = this.options.fetch ?? globalThis.fetch;
		let response: Response;
		try {
			response = await doFetch(`${baseUrl(record)}${DELETE_ROUTE}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', [CHAT_HEADER]: record.chatToken },
				body: JSON.stringify({ id: conversationId }),
			});
		} catch {
			return {
				ok: false,
				code: 'unknown',
				message:
					'a conexão caiu antes da resposta: não é possível saber se a conversa foi excluída. ' +
					'Recarregue a lista antes de tentar de novo.',
			};
		}
		if (response.status !== 200) {
			const text = await response.text().catch(() => '');
			// R4G: o código é estável de propósito — a interface decide por
			// ele, e não pela frase.
			if (response.status === 409 && text.includes('conversation_busy')) {
				return {
					ok: false,
					code: 'busy',
					message: 'a conversa não pode ser excluída enquanto uma resposta está sendo gerada',
				};
			}
			return { ok: false, code: statusCode(response.status), message: messageFrom(text, response.status) };
		}
		await response.text().catch(() => undefined);
		return { ok: true };
	}

	/**
	 * Cria uma conversa no serviço (R4E).
	 *
	 * ## Por que existe um resultado "desconhecido"
	 *
	 * Se o pedido sai e a conexão cai **antes** da resposta, o serviço pode
	 * ter criado a conversa. Não há como saber pelo cliente, e tentar de novo
	 * criaria uma duplicata. A resposta certa é dizer que não se sabe e
	 * sugerir recarregar a lista — que mostra a verdade.
	 */
	async createConversation(input: { readonly providerId: string; readonly title?: string }): Promise<
		| { readonly ok: true; readonly conversation: RemoteConversationSummary }
		| {
				readonly ok: false;
				/** `unknown` = o pedido pode ter sido aplicado. */
				readonly code: ServiceClientFailureCode | 'rejected' | 'unknown';
				readonly message: string;
		  }
	> {
		const record = await this.record();
		if (record === undefined) {
			return { ok: false, code: 'inactive', message: 'o serviço local não está ativo' };
		}
		const doFetch = this.options.fetch ?? globalThis.fetch;
		let response: Response;
		try {
			response = await doFetch(`${baseUrl(record)}${CREATE_ROUTE}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', [CHAT_HEADER]: record.chatToken },
				body: JSON.stringify({
					providerId: input.providerId,
					...(input.title !== undefined && input.title.length > 0 ? { title: input.title } : {}),
				}),
			});
		} catch {
			// O pedido pode ter chegado: não é "não foi criada".
			return {
				ok: false,
				code: 'unknown',
				message:
					'a conexão caiu antes da resposta: não é possível saber se a conversa foi criada. ' +
					'Recarregue a lista antes de tentar de novo.',
			};
		}
		if (response.status !== 201) {
			const body = await response.text().catch(() => '');
			return { ok: false, code: statusCode(response.status), message: messageFrom(body, response.status) };
		}
		const body = (await response.json().catch(() => undefined)) as
			| { readonly conversation?: unknown }
			| undefined;
		const conversation = parseConversationSummary(body?.conversation);
		if (conversation === undefined) {
			return {
				ok: false,
				code: 'unknown',
				message: 'o serviço respondeu algo fora do contrato; a conversa pode ter sido criada',
			};
		}
		return { ok: true, conversation };
	}

	/**
	 * O estado dos turnos de uma conversa (R4H).
	 *
	 * Leitura. Serve para a interface dizer que uma resposta foi interrompida
	 * — nunca para reconstruir conteúdo, que não está aqui.
	 */
	async turnStates(conversationId: string): Promise<
		| { readonly ok: true; readonly turns: readonly RemoteTurnState[] }
		| { readonly ok: false; readonly code: ServiceClientFailureCode | 'rejected'; readonly message: string }
	> {
		const record = await this.record();
		if (record === undefined) {
			return { ok: false, code: 'inactive', message: 'o serviço local não está ativo' };
		}
		const doFetch = this.options.fetch ?? globalThis.fetch;
		let response: Response;
		try {
			response = await doFetch(`${baseUrl(record)}${TURN_STATE_ROUTE}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', [CHAT_HEADER]: record.chatToken },
				body: JSON.stringify({ id: conversationId }),
			});
		} catch {
			return { ok: false, code: 'unreachable', message: 'não foi possível conectar ao serviço local' };
		}
		if (response.status !== 200) {
			const body = await response.text().catch(() => '');
			return { ok: false, code: statusCode(response.status), message: messageFrom(body, response.status) };
		}
		const body = (await response.json().catch(() => undefined)) as
			| { readonly turns?: unknown }
			| undefined;
		const turns = parseTurnStates(body?.turns);
		if (turns === undefined) {
			return {
				ok: false,
				code: 'invalid-response',
				message: 'o serviço respondeu estados de turno fora do contrato',
			};
		}
		return { ok: true, turns };
	}

	/**
	 * A lista de modelos disponíveis do serviço (R4S).
	 *
	 * É o equivalente remoto de `ChatSession.listAvailableModels()`: o app
	 * conectado não monta Core e não tem como consultar os provedores por
	 * conta própria — quem os conhece é o serviço. Sem esta leitura, o modo
	 * conectado oferecia **nenhum** modelo, mesmo com provedores configurados.
	 *
	 * Usa a credencial de **leitura**: é uma consulta, e não precisa de mais.
	 */
	async listAvailableModels(): Promise<
		| { readonly ok: true; readonly models: readonly AvailableModel[] }
		| { readonly ok: false; readonly code: ServiceClientFailureCode | 'rejected'; readonly message: string }
	> {
		const record = await this.record();
		if (record === undefined) {
			return { ok: false, code: 'inactive', message: 'o serviço local não está ativo' };
		}
		const doFetch = this.options.fetch ?? globalThis.fetch;
		let response: Response;
		try {
			response = await doFetch(`${baseUrl(record)}/api/models`, {
				headers: { [READER_HEADER]: record.readerToken, accept: 'application/json' },
			});
		} catch {
			return { ok: false, code: 'unreachable', message: 'não foi possível conectar ao serviço local' };
		}
		if (response.status !== 200) {
			const body = await response.text().catch(() => '');
			return { ok: false, code: statusCode(response.status), message: messageFrom(body, response.status) };
		}
		const body = (await response.json().catch(() => undefined)) as { readonly available?: unknown } | undefined;
		// O contrato: `available` tem de ser uma lista. Fora disso a resposta é
		// recusada — uma lista vazia por resposta inválida seria "nenhum
		// modelo" mentindo sobre um erro.
		if (body === undefined || !Array.isArray(body.available)) {
			return {
				ok: false,
				code: 'invalid-response',
				message: 'o serviço respondeu uma lista de modelos fora do contrato',
			};
		}
		return { ok: true, models: parseAvailableModels(body.available) };
	}

	/**
	 * As conversas do serviço (R4D).
	 *
	 * Leitura. Uma lista vazia é uma lista vazia — nunca um erro disfarçado;
	 * um serviço ausente é um erro com motivo.
	 */
	async listConversations(): Promise<
		| { readonly ok: true; readonly conversations: readonly RemoteConversationSummary[] }
		| { readonly ok: false; readonly code: ServiceClientFailureCode | 'rejected'; readonly message: string }
	> {
		const record = await this.record();
		if (record === undefined) {
			return { ok: false, code: 'inactive', message: 'o serviço local não está ativo' };
		}
		const doFetch = this.options.fetch ?? globalThis.fetch;
		let response: Response;
		try {
			response = await doFetch(`${baseUrl(record)}${CONVERSATIONS_ROUTE}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', [CHAT_HEADER]: record.chatToken },
				body: '{}',
			});
		} catch {
			return { ok: false, code: 'unreachable', message: 'não foi possível conectar ao serviço local' };
		}
		if (response.status !== 200) {
			const body = await response.text().catch(() => '');
			return { ok: false, code: statusCode(response.status), message: messageFrom(body, response.status) };
		}
		const body = (await response.json().catch(() => undefined)) as
			| { readonly conversations?: unknown }
			| undefined;
		const conversations = parseConversationSummaries(body?.conversations);
		if (conversations === undefined) {
			return {
				ok: false,
				code: 'invalid-response',
				message: 'o serviço respondeu uma lista fora do contrato',
			};
		}
		return { ok: true, conversations };
	}

	/**
	 * Uma conversa e o histórico (R4D).
	 *
	 * `rejected` quando o id não existe no serviço (`404`) — a interface diz
	 * "essa conversa não existe", e não uma lista vazia.
	 */
	async openConversation(conversationId: string): Promise<
		| { readonly ok: true; readonly conversation: RemoteConversationDetail }
		| { readonly ok: false; readonly code: ServiceClientFailureCode | 'rejected'; readonly message: string }
	> {
		const record = await this.record();
		if (record === undefined) {
			return { ok: false, code: 'inactive', message: 'o serviço local não está ativo' };
		}
		const doFetch = this.options.fetch ?? globalThis.fetch;
		let response: Response;
		try {
			response = await doFetch(`${baseUrl(record)}${CONVERSATION_ROUTE}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', [CHAT_HEADER]: record.chatToken },
				body: JSON.stringify({ id: conversationId }),
			});
		} catch {
			return { ok: false, code: 'unreachable', message: 'não foi possível conectar ao serviço local' };
		}
		if (response.status !== 200) {
			const body = await response.text().catch(() => '');
			return { ok: false, code: statusCode(response.status), message: messageFrom(body, response.status) };
		}
		const body = (await response.json().catch(() => undefined)) as unknown;
		const detail = parseConversationDetail(body);
		if (detail === undefined) {
			return {
				ok: false,
				code: 'invalid-response',
				message: 'o serviço respondeu um histórico fora do contrato',
			};
		}
		return { ok: true, conversation: detail };
	}

	/**
	 * Responde uma permissão de um turno.
	 *
	 * O `turnId` vai no corpo e o serviço só responde a permissões de turnos
	 * ativos daquele id; `answered: false` para tudo o mais.
	 */
	async answer(input: {
		readonly turnId: string;
		readonly answer: PermissionAnswer;
	}): Promise<{ readonly answered: boolean }> {
		const record = await this.record();
		if (record === undefined) {
			return { answered: false };
		}
		const doFetch = this.options.fetch ?? globalThis.fetch;
		try {
			const response = await doFetch(`${baseUrl(record)}${ANSWER_ROUTE}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', [CHAT_HEADER]: record.chatToken },
				body: JSON.stringify({
					turnId: input.turnId,
					id: input.answer.id,
					decision: input.answer.decision,
				}),
			});
			if (!response.ok) {
				await response.text().catch(() => undefined);
				return { answered: false };
			}
			const body = (await response.json().catch(() => undefined)) as
				| { readonly answered?: unknown }
				| undefined;
			return { answered: body?.answered === true };
		} catch {
			return { answered: false };
		}
	}
}

/** Lê o SSE de um turno, um evento por vez. */
class SseReader {
	private buffer = '';
	private ended = false;
	private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
	private readonly decoder = new TextDecoder();

	constructor(body: ReadableStream<Uint8Array>) {
		this.reader = body.getReader();
	}

	async next(): Promise<Record<string, unknown> | undefined> {
		for (;;) {
			const parsed = this.take();
			if (parsed !== undefined) {
				return parsed;
			}
			if (this.ended) {
				return undefined;
			}
			const { value, done } = await this.reader.read();
			if (done === true) {
				this.ended = true;
				continue;
			}
			this.buffer += this.decoder.decode(value, { stream: true });
		}
	}

	async close(): Promise<void> {
		this.ended = true;
		await this.reader.cancel().catch(() => undefined);
	}

	private take(): Record<string, unknown> | undefined {
		for (;;) {
			const separator = this.buffer.indexOf('\n\n');
			if (separator < 0) {
				return undefined;
			}
			const block = this.buffer.slice(0, separator);
			this.buffer = this.buffer.slice(separator + 2);
			const line = block.split('\n').find((candidate) => candidate.startsWith('data: '));
			if (line === undefined) {
				continue;
			}
			const payload = line.slice('data: '.length);
			if (payload === '[DONE]') {
				this.ended = true;
				return undefined;
			}
			try {
				const event = JSON.parse(payload) as unknown;
				if (event !== null && typeof event === 'object') {
					return event as Record<string, unknown>;
				}
			} catch {
				// Linha malformada: descartada, e a leitura segue.
			}
		}
	}
}

/** O estado de um turno, como o serviço o publica (R4H). */
export interface RemoteTurnState {
	readonly turnId: string;
	readonly conversationId: string;
	readonly status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
	readonly startedAt: string;
	readonly finishedAt?: string;
	readonly reason?: string;
}

/** Lê a lista de estados de turno, recusando o que estiver fora do contrato. */
export function parseTurnStates(value: unknown): readonly RemoteTurnState[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const states: RemoteTurnState[] = [];
	for (const entry of value) {
		if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
			return undefined;
		}
		const record = entry as Record<string, unknown>;
		const { turnId, conversationId, status, startedAt } = record;
		if (
			typeof turnId !== 'string' ||
			turnId.length === 0 ||
			typeof conversationId !== 'string' ||
			typeof startedAt !== 'string' ||
			(status !== 'running' &&
				status !== 'completed' &&
				status !== 'failed' &&
				status !== 'cancelled' &&
				status !== 'interrupted')
		) {
			return undefined;
		}
		states.push({
			turnId,
			conversationId,
			status,
			startedAt,
			...(typeof record['finishedAt'] === 'string' ? { finishedAt: record['finishedAt'] } : {}),
			...(typeof record['reason'] === 'string' ? { reason: record['reason'] } : {}),
		});
	}
	return states;
}

/** Uma conversa, como o serviço a publica (R4D). */
export interface RemoteConversationSummary {
	readonly id: string;
	readonly title: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly messageCount: number;
	/** Permanente: é o diálogo de preferências e não tem lixeira. */
	readonly pinned?: boolean;
}

/** O histórico aberto. */
export interface RemoteConversationDetail {
	readonly conversation: RemoteConversationSummary;
	readonly messages: readonly { readonly role: 'user' | 'assistant'; readonly content: string }[];
}

/**
 * Lê a lista de conversas, exigindo a identidade de cada item.
 *
 * Um item sem `id` ou `title` invalida a lista inteira: entregar à interface
 * uma lista onde parte das linhas não abre seria pior que dizer que a
 * resposta não está no contrato.
 */
export function parseConversationSummaries(value: unknown): readonly RemoteConversationSummary[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const summaries: RemoteConversationSummary[] = [];
	for (const entry of value) {
		const summary = parseConversationSummary(entry);
		if (summary === undefined) {
			return undefined;
		}
		summaries.push(summary);
	}
	return summaries;
}

/** Lê um histórico completo. */
export function parseConversationDetail(value: unknown): RemoteConversationDetail | undefined {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const conversation = parseConversationSummary(record['conversation']);
	if (conversation === undefined || !Array.isArray(record['messages'])) {
		return undefined;
	}
	const messages: { role: 'user' | 'assistant'; content: string }[] = [];
	for (const entry of record['messages']) {
		if (entry === null || typeof entry !== 'object') {
			return undefined;
		}
		const message = entry as Record<string, unknown>;
		if (
			(message['role'] !== 'user' && message['role'] !== 'assistant') ||
			typeof message['content'] !== 'string'
		) {
			return undefined;
		}
		messages.push({ role: message['role'], content: message['content'] });
	}
	return { conversation, messages };
}

function parseConversationSummary(value: unknown): RemoteConversationSummary | undefined {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const { id, title, createdAt, updatedAt, messageCount } = record;
	if (
		typeof id !== 'string' ||
		id.length === 0 ||
		typeof title !== 'string' ||
		typeof createdAt !== 'string' ||
		typeof updatedAt !== 'string' ||
		typeof messageCount !== 'number' ||
		!Number.isInteger(messageCount) ||
		messageCount < 0
	) {
		return undefined;
	}
	return {
		id,
		title,
		createdAt,
		updatedAt,
		messageCount,
		// A marca só atravessa como `true`: um valor de outro tipo não pode
		// tornar uma conversa do serviço permanente por acidente.
		...(record.pinned === true ? { pinned: true } : {}),
	};
}

function baseUrl(record: ServiceRecord): string {
	return `http://${record.address}:${record.port}`;
}

function nameOf(error: unknown): string {
	return typeof error === 'object' && error !== null && 'name' in error
		? String((error as { readonly name?: unknown }).name)
		: '';
}

function statusCode(status: number): ServiceClientFailureCode | 'rejected' {
	if (status === 401 || status === 403) {
		return 'unauthorized';
	}
	if (status === 404) {
		return 'rejected';
	}
	if (status >= 500) {
		return 'server-error';
	}
	return 'invalid-response';
}

/** A mensagem de erro do serviço, quando é o JSON dele; senão, o status. */
function messageFrom(body: string, status: number): string {
	try {
		const parsed = JSON.parse(body) as { readonly error?: { readonly message?: unknown } };
		if (typeof parsed.error?.message === 'string' && parsed.error.message.length > 0) {
			return parsed.error.message;
		}
	} catch {
		// Corpo não-JSON: a mensagem é o status.
	}
	return `o serviço local recusou o turno (status ${status})`;
}
