/**
 * O adaptador de conversação do OpenCode: o protocolo nativo traduzido para
 * `ChatStream`.
 *
 * ## O protocolo real (1.18.34), verificado no servidor instalado
 *
 * - **Sessão**: `POST /api/session` com `{ title, model: { providerID, id } }`
 *   — o modelo fica preso à sessão e volta em `data.model`. É o que permite
 *   **reutilizar** a sessão entre turnos.
 * - **Turno**: `POST /session/{id}/message`, que responde o turno inteiro
 *   (`{ info, parts }`). Duas mensagens na mesma sessão **veem a anterior**
 *   (testado: o modelo repetiu um número guardado no turno anterior).
 * - **Eventos**: `GET /event` (SSE), por `sessionID`, com
 *   `message.part.delta` e `session.idle`.
 *
 * `/api/session/{id}/prompt` **não** é usado: falha com
 * `SQLiteError: no such table: session_input` (500).
 *
 * ## A regra que impede a duplicação do histórico
 *
 * O servidor é a memória da conversa: cada turno manda **só a mensagem nova**.
 * Reenviar as mensagens anteriores as faria aparecer duas vezes no contexto.
 * O envio é **um pedido** por turno — não há retentativa automática, porque um
 * turno cujo resultado é ambíguo pode já ter sido processado pelo modelo.
 *
 * ## Como o texto da resposta chega
 *
 * O texto vem **de um lugar só** por parte:
 *
 * 1. os deltas `message.part.delta` (campo `text`) de partes do assistente;
 * 2. se o stream não estiver disponível, a mensagem final da própria resposta.
 *
 * Um `message.part.updated` do assistente só entrega o que nenhum delta
 * entregou. E o texto do usuário nunca entra: o papel vem de
 * `message.updated` (`info.role`), e um evento cuja mensagem seja a própria
 * pergunta é ignorado.
 *
 * ## Resultado ambíguo
 *
 * Um envio aceito (`200`) cujo corpo não traz a mensagem do assistente é
 * `ambiguous`: o modelo pode já ter processado a mensagem. O adaptador
 * **não** reenvia — quem chama decide, sabendo do risco.
 *
 * ## Sessão perdida
 *
 * A resposta do turno tem de pertencer à sessão (e, se ele respondeu com
 * `parentID`, à mensagem que foi enviada). Se não pertencer — o servidor perdeu
 * o contexto —, o turno termina com `session-lost`: o texto já recebido fica, a
 * sessão é dada por inválida, e **nada é reenviado**.
 */
import type {
	ChatMessage,
	ChatProvider,
	ChatRequest,
	ChatStream,
	ChatStreamEvent,
	StreamTiming,
} from '../core/providers/chat/types';

const SESSION_PATH = '/api/session';
/** O turno: responde o corpo inteiro quando o servidor não transmite. */
const messagePath = (sessionId: string): string => `/session/${encodeURIComponent(sessionId)}/message`;
const abortPath = (sessionId: string): string => `/session/${encodeURIComponent(sessionId)}/abort`;
/**
 * Onde a sessão é **descrita** (sonda) e **removida**.
 *
 * Descrever é `/api/session/{id}`; remover é `DELETE /session/{id}` — na mesma
 * família da rota de mensagens. A `/api/session/{id}` responde HTML para
 * `DELETE`, e não apaga nada.
 */
const sessionPath = (sessionId: string): string => `/api/session/${encodeURIComponent(sessionId)}`;
const removeSessionPath = (sessionId: string): string => `/session/${encodeURIComponent(sessionId)}`;
const EVENT_PATH = '/event';

/** O prazo padrão de um turno: cinco minutos. */
const DEFAULT_TURN_TIMEOUT_MS = 5 * 60_000;

/** O prazo da sonda de saúde da sessão antes de reutilizá-la. */
const SESSION_PROBE_TIMEOUT_MS = 5_000;

/** O modelo escolhido, pelos ids originais do catálogo. */
export interface OpencodeModelRef {
	readonly providerID: string;
	readonly modelID: string;
}

/** Uma sessão do OpenCode, com o modelo que ela tem preso. */
export interface OpencodeSession {
	/** O id da sessão no servidor (`ses_...`). */
	readonly id: string;
	/** O modelo com que a sessão foi criada. */
	readonly model: OpencodeModelRef;
	/** A conexão do servidor (base sem barra final) em que ela vive. */
	readonly baseUrl: string;
}

/**
 * Como a sessão de um turno foi decidida.
 *
 * `resumed` é o único estado em que se pode dizer que o modelo **recebeu o
 * contexto anterior**.
 */
export type SessionOrigin = 'new' | 'resumed' | 'reused-unverified';

/** O primeiro evento de todo turno: qual sessão ele usa, e como ela veio. */
export interface SessionStartedEvent {
	readonly type: 'SessionStarted';
	readonly session: OpencodeSession;
	readonly model: string;
	readonly origin: SessionOrigin;
}

/**
 * O que o adaptador entrega: os eventos do `ChatStream` e o `SessionStarted`.
 *
 * O núcleo não conhece sessão do OpenCode; quem escuta o adaptador conhece.
 */
export type OpencodeChatEvent = ChatStreamEvent | SessionStartedEvent;

/** O código de uma falha, para a interface dizer o que aconteceu. */
export type OpencodeChatFailure =
	| 'no-connection'
	| 'model-not-in-catalog'
	| 'session-lost'
	| 'ambiguous'
	| 'auth'
	| 'network'
	| 'timeout'
	| 'server'
	| 'bad-format';

/** O erro do turno. */
export class OpencodeChatError extends Error {
	constructor(
		message: string,
		readonly code: OpencodeChatFailure,
	) {
		super(message);
		this.name = 'OpencodeChatError';
	}
}

/** O que o adaptador precisa do ambiente. */
export interface OpencodeChatOptions {
	/** A conexão viva (base + senha), do gerenciador da 4C. */
	readonly connection: () => { readonly baseUrl: string; readonly password: string } | undefined;
	/**
	 * O catálogo atual, do serviço da 4D. O modelo pedido tem de estar nele.
	 *
	 * Ausente = não há catálogo para validar: o adaptador recusa conversar,
	 * porque escolher um modelo que não se pode verificar seria adivinhar.
	 */
	readonly catalog?: () => Promise<
		| {
				readonly state: 'ok' | 'stale';
				readonly models: readonly { readonly providerId: string; readonly modelId: string }[];
		  }
		| undefined
	>;
	/** O `fetch` — injetável para o teste não abrir socket. */
	readonly fetch: typeof fetch;
	readonly turnTimeoutMs?: number;
	readonly log?: (message: string, data?: Record<string, unknown>) => void;
	readonly now?: () => number;
}

/** O estado mutável de um turno. */
interface TurnState {
	closedReason: 'completed' | 'aborted' | 'failed' | 'closed';
	respondedModel: string | undefined;
	readonly events: OpencodeChatEvent[];
	/** O `SessionStarted` do turno, para fora do `ChatStream`. */
	startedEvent: SessionStartedEvent | undefined;
	/** Resolvido quando há novidade (evento ou fim); trocado a cada espera. */
	signal: Promise<void>;
	/** Resolve o sinal atual. */
	notify: () => void;
	/** Chamado quando o `SessionStarted` entra na fila. */
	onStarted?: (event: SessionStartedEvent) => void;
	done: boolean;
}

interface MutableTiming {
	headersMs?: number;
	firstTokenMs?: number;
	firstByteMs?: number;
	totalMs?: number;
}

/** O que o `run` precisa. */
interface RunInput {
	readonly request: ChatRequest;
	readonly text: string;
	readonly model: OpencodeModelRef;
	readonly requested: OpencodeSession | undefined;
	readonly base: string;
	readonly authorization: string;
	readonly state: TurnState;
	readonly timing: MutableTiming;
	readonly startedAt: number;
	readonly controller: AbortController;
	/** O prazo do turno disparou? */
	readonly timedOut: () => boolean;
	/** Desarma o prazo do turno (o `finally`). */
	readonly clearTimer: () => void;
	/** Remove o ouvinte do sinal externo. */
	readonly detach: () => void;
}

/** O que o produtor dos eventos aprendeu até aqui. */
interface EventCapture {
	/** O id da mensagem do usuário (a que foi enviada neste turno). */
	userMessageID: string | undefined;
	/** O id da mensagem do assistente que está sendo lida. */
	assistantMessageID: string | undefined;
	/** Se o assistente começou a emitir texto. */
	sawAssistantText: boolean;
	/** O turno terminou (`session.idle`). */
	sawIdle: boolean;
	/** As partes já entregues, por id. */
	readonly sent: Map<string, string>;
	/** O papel de cada mensagem, por id. */
	readonly roles: Map<string, string>;
}

export class OpencodeChatAdapter implements ChatProvider {
	/** As sessões que este adaptador abriu (e não encerrou). */
	private readonly owned = new Map<string, OpencodeSession>();
	/** Os turnos vivos: o `dispose` desarma o prazo e corta o stream de cada um. */
	private readonly turns = new Set<{ readonly stop: () => void }>();
	private disposed = false;

	constructor(private readonly options: OpencodeChatOptions) {}

	/** Os ids das sessões que o adaptador ainda considera vivas. */
	get activeSessions(): readonly string[] {
		return [...this.owned.keys()];
	}

	/**
	 * Um turno, numa sessão nova ou na que veio.
	 *
	 * `options.session` é a sessão da conversa: se ela é deste adaptador e do
	 * mesmo modelo, e responde ao servidor, ela é **reutilizada**; se não,
	 * uma nova é criada e a antiga é dada por perdida. Sessão de outro
	 * adaptador (outra conversa, outro backend) nunca é reutilizada.
	 */
	async streamChat(
		request: ChatRequest,
		options?: { readonly signal?: AbortSignal; readonly session?: OpencodeSession },
	): Promise<ChatStream> {
		if (this.disposed) {
			throw new OpencodeChatError('o adaptador foi encerrado', 'server');
		}
		const model = parseOpencodeModelId(request.model);
		if (model === undefined) {
			throw new OpencodeChatError(
				'o modelo pedido não é do catálogo do OpenCode (esperado: providerID/modelID)',
				'model-not-in-catalog',
			);
		}
		const connection = this.options.connection();
		if (connection === undefined) {
			throw new OpencodeChatError('não há conexão com o servidor OpenCode', 'no-connection');
		}
		if (this.options.catalog === undefined) {
			throw new OpencodeChatError('não há catálogo para validar o modelo escolhido', 'model-not-in-catalog');
		}
		const catalog = await this.options.catalog();
		if (catalog === undefined || catalog.state === 'stale') {
			throw new OpencodeChatError('o catálogo do OpenCode está desatualizado; atualize-o antes de conversar', 'model-not-in-catalog');
		}
		const known = catalog.models.some(
			(entry) => entry.providerId === model.providerID && entry.modelId === model.modelID,
		);
		if (!known) {
			throw new OpencodeChatError(
				`o modelo "${request.model}" não está no catálogo atual do OpenCode`,
				'model-not-in-catalog',
			);
		}
		const text = lastUserText(request.messages);
		if (text.length === 0) {
			throw new OpencodeChatError('a mensagem do usuário está vazia', 'bad-format');
		}
		const base = connection.baseUrl.replace(/\/+$/, '');
		const authorization = basicAuth(connection.password);
		const requested = this.acceptSession(options?.session, model, base);
		return this.openTurn({ request, text, model, requested, base, authorization, signal: options?.signal });
	}

	/**
	 * O estado, no servidor, de um conjunto de sessões.
	 *
	 * Por id:
	 * - `missing`: o servidor não tem mais esta sessão (404 ou erro);
	 * - `unverified`: existe, mas não foi este adaptador quem a criou — não
	 *   há prova de propriedade;
	 * - `active`: existe e é deste adaptador (e responde com o modelo dela).
	 *
	 * Não altera o que o adaptador administra: sessão desconhecida continua
	 * desconhecida, e nunca é encerrada por causa desta sonda.
	 */
	async probeSessions(
		sessions: readonly OpencodeSession[],
	): Promise<Map<string, 'active' | 'missing' | 'unverified'>> {
		const result = new Map<string, 'active' | 'missing' | 'unverified'>();
		const connection = this.options.connection();
		if (connection === undefined) {
			// Sem conexão não há como confirmar: "desconhecido" é a resposta
			// honesta, e o chamador decide o que isso significa.
			for (const session of sessions) {
				result.set(session.id, 'missing');
			}
			return result;
		}
		const base = connection.baseUrl.replace(/\/+$/, '');
		const authorization = basicAuth(connection.password);
		for (const session of sessions) {
			if (!this.owned.has(session.id)) {
				// O adaptador não criou esta sessão: mesmo que o servidor a
				// conheça, não há prova de propriedade.
				result.set(session.id, 'unverified');
				continue;
			}
			try {
				const answer = await this.options.fetch(`${base}${sessionPath(session.id)}`, {
					headers: { authorization },
					signal: AbortSignal.timeout(SESSION_PROBE_TIMEOUT_MS),
				});
				if (answer.status === 404) {
					result.set(session.id, 'missing');
					continue;
				}
				if (answer.status !== 200) {
					result.set(session.id, 'missing');
					continue;
				}
				const body = (await answer.json().catch(() => undefined)) as Record<string, unknown> | undefined;
				const data = (body?.['data'] ?? body) as Record<string, unknown> | undefined;
				result.set(session.id, data?.['id'] === session.id ? 'active' : 'missing');
			} catch {
				result.set(session.id, 'missing');
			}
		}
		return result;
	}

	/**
	 * Adota uma sessão restaurada, com a prova de propriedade.
	 *
	 * A restauração do disco traz o id e a prova `owner`. O adaptador só pode
	 * administrar a sessão se ela também estiver no conjunto dele — este é o
	 * único caminho para isso, e só é chamado com sessão cujo registro diz
	 * "a Evelyn a criou".
	 */
	adoptSession(session: OpencodeSession): void {
		this.owned.set(session.id, session);
	}

	/**
	 * Encerra uma sessão que este adaptador abriu.
	 *
	 * Uma sessão que não é deste adaptador (outra conversa, outro backend, ou
	 * criada manualmente no servidor) **não** é tocada: devolve `false`.
	 */
	async closeSession(session: OpencodeSession): Promise<boolean> {
		if (!this.owned.has(session.id)) {
			return false;
		}
		this.owned.delete(session.id);
		const connection = this.options.connection();
		const base = connection === undefined ? session.baseUrl : connection.baseUrl.replace(/\/+$/, '');
		if (connection === undefined) {
			return false;
		}
		const authorization = basicAuth(connection.password);
		// Primeiro o turno em curso (se houver), depois a sessão em si. O
		// `abort` **não** a apaga — só o `DELETE` apaga.
		await this.abortSession(base, authorization, session.id);
		await this.deleteSession(base, authorization, session.id);
		return true;
	}

	/**
	 * Remove a sessão do servidor, e confere.
	 *
	 * Um `abort` interrompe o turno e deixa a sessão viva; sem o `DELETE` ela
	 * fica no servidor para sempre, consumindo o armazenamento dele. A remoção
	 * é feita e confirmada com a sonda (404 = removida).
	 */
	private async deleteSession(base: string, authorization: string, sessionId: string): Promise<void> {
		try {
			const answer = await this.options.fetch(`${base}${removeSessionPath(sessionId)}`, {
				method: 'DELETE',
				headers: { authorization },
				signal: AbortSignal.timeout(5_000),
			});
			if (answer.status >= 400 && answer.status !== 404) {
				this.options.log?.('OpenCode: a sessão não foi removida', { status: answer.status });
				return;
			}
			// Confirma: uma sessão que continua existindo é dita aqui.
			const check = await this.options.fetch(`${base}${sessionPath(sessionId)}`, {
				headers: { authorization },
				signal: AbortSignal.timeout(SESSION_PROBE_TIMEOUT_MS),
			});
			if (check.status !== 404) {
				this.options.log?.('OpenCode: a sessão removida ainda responde', { status: check.status });
			}
		} catch {
			this.options.log?.('OpenCode: a sessão não pôde ser removida', { reason: 'request failed' });
		}
	}

	/** O aviso de cancelamento: nada mais a entregar, e nada a manter vivo. */

	/** Desliga tudo o que este adaptador mantém vivo. */
	dispose(): void {
		this.disposed = true;
		for (const turn of this.turns) {
			turn.stop();
		}
		this.turns.clear();
		const connection = this.options.connection();
		const base = connection?.baseUrl.replace(/\/+$/, '');
		const authorization = connection === undefined ? undefined : basicAuth(connection.password);
		for (const session of this.owned.values()) {
			const target = base ?? session.baseUrl;
			if (authorization !== undefined) {
				// O host está fechando: a sessão não deve ficar no servidor.
				void this.abortSession(target, authorization, session.id).then(() =>
					this.deleteSession(target, authorization ?? '', session.id),
				);
			}
		}
		this.owned.clear();
	}

	/**
	 * A sessão que o turno vai usar.
	 *
	 * Só uma sessão deste adaptador, do mesmo modelo e da mesma conexão pode
	 * ser reutilizada; qualquer outra é ignorada (e uma nova é criada).
	 */
	private acceptSession(
		session: OpencodeSession | undefined,
		model: OpencodeModelRef,
		base: string,
	): OpencodeSession | undefined {
		if (session === undefined) {
			return undefined;
		}
		if (!this.owned.has(session.id)) {
			return undefined;
		}
		if (session.model.providerID !== model.providerID || session.model.modelID !== model.modelID) {
			return undefined;
		}
		if (session.baseUrl !== base) {
			return undefined;
		}
		return session;
	}

	private openTurn(input: {
		readonly request: ChatRequest;
		readonly text: string;
		readonly model: OpencodeModelRef;
		readonly requested: OpencodeSession | undefined;
		readonly base: string;
		readonly authorization: string;
		readonly signal: AbortSignal | undefined;
	}): ChatStream {
		const state: TurnState = {
			closedReason: 'completed',
			respondedModel: undefined,
			events: [],
			startedEvent: undefined,
			done: false,
			...createSignal(),
		};
		const timing: MutableTiming = {};
		const controller = new AbortController();
		let timedOut = false;
		let turnTimer: ReturnType<typeof setTimeout> | undefined;
		const onAbort = (): void => {
			if (state.closedReason === 'completed') {
				state.closedReason = 'aborted';
			}
			timedOut = false;
			controller.abort();
			state.done = true;
			wakeAll(state);
		};
		input.signal?.addEventListener('abort', onAbort, { once: true });
		const startedAt = (this.options.now ?? Date.now)();
		const timeoutMs = this.options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
		turnTimer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, timeoutMs);
		const turnRecord = {
			stop: (): void => {
				if (turnTimer !== undefined) {
					clearTimeout(turnTimer);
					turnTimer = undefined;
				}
				controller.abort();
			},
		};
		this.turns.add(turnRecord);
		void this.run({
			request: input.request,
			text: input.text,
			model: input.model,
			requested: input.requested,
			base: input.base,
			authorization: input.authorization,
			state,
			timing,
			startedAt,
			controller,
			timedOut: () => timedOut,
			clearTimer: () => {
				this.turns.delete(turnRecord);
				if (turnTimer !== undefined) {
					clearTimeout(turnTimer);
					turnTimer = undefined;
				}
			},
			detach: () => input.signal?.removeEventListener('abort', onAbort),
		});
		return makeStream(state, timing, () => {
			// Fechar o stream cedo: o turno é cancelado.
			onAbort();
			input.signal?.removeEventListener('abort', onAbort);
		});
	}

	private async run(input: RunInput): Promise<void> {
		const { state, timing, controller } = input;
		const now = this.options.now ?? Date.now;
		let session: OpencodeSession | undefined;
		let origin: SessionOrigin | undefined;
		try {
			// 1. A sessão: a pedida (se ainda existe) ou uma nova.
			const alive =
				input.requested !== undefined ? await this.probeSession(input, input.requested) : undefined;
			if (alive !== undefined) {
				session = alive;
				origin = 'reused-unverified';
				this.options.log?.('OpenCode: sessão reutilizada', { origin });
			} else {
				session = await this.createSession(input);
				origin = 'new';
			}
			timing.headersMs = now() - input.startedAt;
			push(state, {
				type: 'SessionStarted',
				session,
				model: `${input.model.providerID}/${input.model.modelID}`,
				origin: origin ?? 'new',
			});

			// 2. Os eventos, antes do envio, para não perder o começo.
			const wantsStream = input.request.stream !== false;
			const reader = wantsStream ? this.readEvents(input, session.id) : undefined;
			if (reader !== undefined) {
				await reader.ready;
			}

			// 3. O turno — **um** pedido, sem retentativa.
			const sent = await this.sendTurn(input, session.id);
			if (sent.status === 401 || sent.status === 403) {
				throw new OpencodeChatError('o servidor recusou a autenticação', 'auth');
			}
			if (sent.status >= 400) {
				throw new OpencodeChatError(
					`o servidor respondeu ${sent.status}${reader !== undefined ? ' ao enviar o turno' : ''}`,
					'server',
				);
			}
			// O prazo já venceu (ou o turno foi cancelado) enquanto a resposta
			// vinha: o desfecho é esse, e o corpo que chegou é descartado — um
			// turno tem um desfecho só.
			if (input.timedOut()) {
				throw new OpencodeChatError('o turno passou do prazo', 'timeout');
			}
			if (controller.signal.aborted) {
				return;
			}
			const body = readTurnBody(sent.body);
			if (body === undefined) {
				// O servidor aceitou o turno (200) e o corpo não veio como
				// esperado: o modelo **pode** ter processado a mensagem. Não é
				// um erro simples — é um resultado ambíguo.
				throw new OpencodeChatError(
					'o servidor aceitou a mensagem, mas a resposta não veio no formato esperado; não reenvie o turno sem antes conferir',
					'ambiguous',
				);
			}
			// A resposta tem de ser do assistente **desta** sessão; um
			// `parentID` diferente do nosso é outro turno.
			if (body.sessionID !== undefined && body.sessionID !== session.id) {
				throw new OpencodeChatError(
					'a resposta veio de outra sessão; o contexto desta conversa não pode ser confirmado',
					'session-lost',
				);
			}
			if (body.parentID !== undefined && reader?.capture.userMessageID !== undefined && body.parentID !== reader.capture.userMessageID) {
				throw new OpencodeChatError(
					'o servidor respondeu a outra mensagem; o contexto desta conversa não pode ser confirmado',
					'session-lost',
				);
			}
			timing.totalMs = now() - input.startedAt;
			if (body.model !== undefined) {
				state.respondedModel = body.model;
			}
			// O texto: o que os deltas não entregaram entra agora, uma vez.
			const delivered = deliveredText(state);
			const remaining = body.text.startsWith(delivered) ? body.text.slice(delivered.length) : delivered.length === 0 ? body.text : '';
			if (remaining.length > 0) {
				push(state, { type: 'TextDelta', text: remaining });
			}
			if (reader !== undefined) {
				reader.cancel();
			}
			push(state, { type: 'Done', finishReason: 'stop' });
		} catch (error) {
			if (input.timedOut()) {
				state.closedReason = 'failed';
				push(state, { type: 'Error', error: new OpencodeChatError('o turno passou do prazo', 'timeout') });
			} else if (controller.signal.aborted) {
				// Cancelado: o contrato diz que um cancelamento termina **sem**
				// evento de erro. O texto que já veio fica na fila.
				if (state.closedReason === 'completed') {
					state.closedReason = 'aborted';
				}
			} else {
				state.closedReason = 'failed';
				push(state, { type: 'Error', error: toError(error) });
			}
		} finally {
			input.clearTimer();
			input.detach();
			state.done = true;
			wakeAll(state);
			void session;
		}
	}

	/**
	 * A sessão pedida ainda serve?
	 *
	 * `GET /api/session/{id}` com a sessão olhando o modelo: existe (`200`),
	 * no servidor (`data.id` é o mesmo) e com o modelo dela igual ao pedido.
	 * Qualquer outro resultado — `404`, erro, rede — e ela não é usada.
	 *
	 * A sonda **não** prova que o histórico está intacto (a API não expõe
	 * "quantas mensagens o contexto tem"); ela prova que a sessão existe.
	 */
	private async probeSession(input: RunInput, session: OpencodeSession): Promise<OpencodeSession | undefined> {
		try {
			const answer = await this.options.fetch(`${input.base}${SESSION_PATH}/${encodeURIComponent(session.id)}`, {
				headers: { authorization: input.authorization },
				signal: AbortSignal.timeout(SESSION_PROBE_TIMEOUT_MS),
			});
			if (answer.status !== 200) {
				this.owned.delete(session.id);
				return undefined;
			}
			const body = (await answer.json().catch(() => undefined)) as Record<string, unknown> | undefined;
			const data = (body?.['data'] ?? body) as Record<string, unknown> | undefined;
			if (typeof data?.['id'] !== 'string' || data['id'] !== session.id) {
				this.owned.delete(session.id);
				return undefined;
			}
			const model = (data['model'] ?? {}) as Record<string, unknown>;
			const sessionModel = typeof model['providerID'] === 'string' && typeof model['id'] === 'string'
				? `${model['providerID']}/${model['id']}`
				: undefined;
			if (sessionModel !== `${input.model.providerID}/${input.model.modelID}`) {
				// A sessão existe, mas com outro modelo: não é compatível.
				this.owned.delete(session.id);
				return undefined;
			}
			this.owned.set(session.id, session);
			return session;
		} catch {
			this.owned.delete(session.id);
			return undefined;
		}
	}

	/** Cria a sessão com o modelo preso a ela. */
	private async createSession(input: RunInput): Promise<OpencodeSession> {
		let response: Response;
		try {
			response = await this.options.fetch(`${input.base}${SESSION_PATH}`, {
				method: 'POST',
				headers: { authorization: input.authorization, 'content-type': 'application/json' },
				body: JSON.stringify({
					title: 'Evelyn',
					model: { providerID: input.model.providerID, id: input.model.modelID },
				}),
				signal: input.controller.signal,
			});
		} catch (error) {
			throw new OpencodeChatError(`falha de rede ao abrir a sessão: ${messageOf(error)}`, 'network');
		}
		if (response.status === 401 || response.status === 403) {
			throw new OpencodeChatError('o servidor recusou a autenticação', 'auth');
		}
		const text = await response.text();
		if (response.status >= 400) {
			throw new OpencodeChatError(`o servidor respondeu ${response.status} ao abrir a sessão`, 'server');
		}
		let body: unknown;
		try {
			body = JSON.parse(text) as unknown;
		} catch {
			throw new OpencodeChatError('a sessão criada não veio em JSON', 'bad-format');
		}
		const data = ((body as Record<string, unknown> | undefined)?.['data'] ?? body) as Record<string, unknown> | undefined;
		const id = data?.['id'];
		if (typeof id !== 'string' || id.length === 0) {
			throw new OpencodeChatError('o servidor não devolveu a sessão criada', 'bad-format');
		}
		const session: OpencodeSession = { id, model: input.model, baseUrl: input.base };
		this.owned.set(id, session);
		return session;
	}

	/** O envio do turno: exatamente um pedido. */
	private async sendTurn(
		input: RunInput,
		sessionId: string,
	): Promise<{ readonly status: number; readonly body: unknown }> {
		let response: Response;
		try {
			// O prazo do turno (e o cancelamento) interrompem a espera; a
			// mensagem já foi entregue ao servidor — **não** é reenviada.
			const deadline = new AbortController();
			const stop = (): void => deadline.abort();
			const timer = setTimeout(stop, this.options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS);
			try {
				response = await this.options.fetch(`${input.base}${messagePath(sessionId)}`, {
					method: 'POST',
					headers: { authorization: input.authorization, 'content-type': 'application/json' },
					body: JSON.stringify({ parts: [{ type: 'text', text: input.text }] }),
					signal: deadline.signal,
				});
			} finally {
				clearTimeout(timer);
				input.controller.signal.removeEventListener('abort', stop);
			}
		} catch (error) {
			if (input.controller.signal.aborted && !input.timedOut()) {
				throw new OpencodeChatError('o turno foi cancelado', 'network');
			}
			if (input.timedOut()) {
				throw new OpencodeChatError('o turno passou do prazo', 'timeout');
			}
			throw new OpencodeChatError(`falha de rede ao enviar o turno: ${messageOf(error)}`, 'network');
		}
		const text = await response.text();
		let body: unknown = text;
		if (text.length === 0) {
			body = undefined;
		} else {
			try {
				body = JSON.parse(text) as unknown;
			} catch {
				body = text;
			}
		}
		return { status: response.status, body };
	}

	/**
	 * Abre o `/event` e lê em segundo plano, filtrando pela sessão.
	 *
	 * `ready` é resolvido no primeiro pedido de leitura do corpo. O produtor
	 * só alimenta o estado enquanto o turno está em andamento (`live()`), e é
	 * cancelado assim que o turno termina.
	 */
	private readEvents(
		input: RunInput,
		sessionId: string,
	): {
		readonly ready: Promise<void>;
		readonly cancel: () => void;
		readonly capture: EventCapture;
	} {
		const capture: EventCapture = {
			userMessageID: undefined,
			assistantMessageID: undefined,
			sawAssistantText: false,
			sawIdle: false,
			sent: new Map(),
			roles: new Map(),
		};
		let resolveReady: () => void = () => undefined;
		const ready = new Promise<void>((resolve) => {
			resolveReady = resolve;
		});
		let cancelled = false;
		let stopReader: (() => void) | undefined;
		const live = (): boolean => !cancelled && !input.state.done && !input.controller.signal.aborted;
		void this.consumeEvents(input, sessionId, capture, {
			resolve: resolveReady,
			live,
			registered: (stop) => {
				stopReader = stop;
			},
		});
		return {
			ready,
			capture,
			cancel: () => {
				cancelled = true;
				stopReader?.();
			},
		};
	}

	private async consumeEvents(
		input: RunInput,
		sessionId: string,
		capture: EventCapture,
		control: {
			readonly resolve: () => void;
			readonly live: () => boolean;
			readonly registered: (stop: () => void) => void;
		},
	): Promise<void> {
		let response: Response;
		try {
			response = await this.options.fetch(`${input.base}${EVENT_PATH}`, {
				headers: { authorization: input.authorization, accept: 'text/event-stream' },
				signal: input.controller.signal,
			});
		} catch {
			control.resolve();
			return;
		}
		if (response.status >= 400 || response.body === null) {
			control.resolve();
			return;
		}
		const reader = response.body.getReader();
		control.registered(() => {
			void reader.cancel().catch(() => undefined);
		});
		const decoder = new TextDecoder();
		let buffer = '';
		let announced = false;
		try {
			for (;;) {
				if (!announced) {
					announced = true;
					control.resolve();
				}
				if (!control.live()) {
					break;
				}
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				buffer += decoder.decode(value, { stream: true });
				let index: number;
				while ((index = buffer.indexOf('\n\n')) >= 0) {
					const frame = buffer.slice(0, index);
					buffer = buffer.slice(index + 2);
					if (!control.live()) {
						break;
					}
					this.applyFrame(frame, sessionId, input, capture);
					if (capture.sawIdle) {
						break;
					}
				}
				if (capture.sawIdle) {
					break;
				}
			}
		} catch {
			// O stream foi cortado (fim do turno ou falha): o corpo do turno é a
			// fonte de verdade do texto.
		} finally {
			try {
				await reader.cancel();
			} catch {
				// já fechado
			}
		}
	}

	/**
	 * Aplica um frame SSE ao estado.
	 *
	 * O `message.updated` da mensagem do usuário guarda o id dela: é a
	 * mensagem que o assistente responde (`parentID`). O texto do assistente
	 * entra por delta; o `updated` do assistente só completa o que faltou.
	 */
	private applyFrame(frame: string, sessionId: string, input: RunInput, capture: EventCapture): void {
		const data = frame
			.split('\n')
			.filter((line) => line.startsWith('data:'))
			.map((line) => line.slice(5).trimStart())
			.join('');
		if (data.length === 0) {
			return;
		}
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(data) as Record<string, unknown>;
		} catch {
			return;
		}
		const properties = (event['properties'] ?? {}) as Record<string, unknown>;
		if (properties['sessionID'] !== sessionId) {
			return;
		}
		const type = event['type'];
		if (type === 'session.idle') {
			// Só é o fim deste turno se o assistente já falou: um `idle` antes
			// disso é o servidor ocioso, esperando o envio.
			capture.sawIdle = capture.sawAssistantText;
			return;
		}
		if (type === 'message.updated') {
			const info = (properties['info'] ?? {}) as Record<string, unknown>;
			const id = typeof info['id'] === 'string' ? info['id'] : undefined;
			const role = typeof info['role'] === 'string' ? info['role'] : undefined;
			if (id === undefined || role === undefined) {
				return;
			}
			capture.roles.set(id, role);
			if (role === 'user' && capture.userMessageID === undefined) {
				capture.userMessageID = id;
			}
			if (role === 'assistant') {
				capture.assistantMessageID = id;
				input.state.respondedModel = readInfoModel(info) ?? input.state.respondedModel;
			}
			return;
		}
		if (type === 'message.part.delta') {
			if (properties['field'] !== 'text') {
				return;
			}
			const delta = properties['delta'];
			const partID = properties['partID'];
			const messageID = properties['messageID'];
			if (typeof delta !== 'string' || delta.length === 0 || typeof partID !== 'string') {
				return;
			}
			// Um delta da própria pergunta não é resposta.
			if (typeof messageID === 'string' && (capture.roles.get(messageID) === 'user' || messageID === capture.userMessageID)) {
				return;
			}
			capture.sent.set(partID, `${capture.sent.get(partID) ?? ''}${delta}`);
			if (input.timing.firstTokenMs === undefined) {
				input.timing.firstTokenMs = (this.options.now ?? Date.now)() - input.startedAt;
			}
			capture.sawAssistantText = true;
			push(input.state, { type: 'TextDelta', text: delta });
			return;
		}
		if (type === 'message.part.updated') {
			const part = (properties['part'] ?? {}) as Record<string, unknown>;
			if (part['type'] !== 'text' || typeof part['text'] !== 'string') {
				return;
			}
			const messageID = typeof part['messageID'] === 'string' ? part['messageID'] : undefined;
			const partID = typeof part['id'] === 'string' ? part['id'] : undefined;
			if (messageID === undefined || partID === undefined || capture.roles.get(messageID) !== 'assistant') {
				return;
			}
			const already = capture.sent.get(partID) ?? '';
			const full = part['text'];
			if (full.startsWith(already) && full.length > already.length) {
				const rest = full.slice(already.length);
				capture.sent.set(partID, full);
				if (input.timing.firstTokenMs === undefined) {
					input.timing.firstTokenMs = (this.options.now ?? Date.now)() - input.startedAt;
				}
				capture.sawAssistantText = true;
				push(input.state, { type: 'TextDelta', text: rest });
			}
		}
	}

	/**
	 * Avisa o servidor que a sessão acabou. Uma falha aqui não é do usuário.
	 *
	 * O pedido **não** usa o sinal do turno: no cancelamento esse sinal já
	 * está abortado, e o `fetch` recusaria o pedido antes de sair.
	 */
	private async abortSession(base: string, authorization: string | undefined, sessionId: string): Promise<void> {
		if (authorization === undefined) {
			return;
		}
		try {
			await this.options.fetch(`${base}${abortPath(sessionId)}`, {
				method: 'POST',
				headers: { authorization },
				signal: AbortSignal.timeout(3_000),
			});
		} catch {
			this.options.log?.('OpenCode: a sessão não pôde ser desligada', { reason: 'abort request failed' });
		}
	}
}

/** Um sinal de novidade, com o seu resolvedor. */
function createSignal(): { signal: Promise<void>; notify: () => void } {
	let notify: () => void = () => undefined;
	const signal = new Promise<void>((resolve) => {
		notify = resolve;
	});
	return { signal, notify };
}

/** O `ChatStream` que consome o estado do turno. */
function makeStream(state: TurnState, timing: MutableTiming, onClose: () => void): ChatStream {
	let index = 0;
	let closed = false;
	const end = (reason: 'closed' | 'aborted'): void => {
		if (closed) {
			return;
		}
		closed = true;
		if (state.closedReason === 'completed') {
			state.closedReason = reason;
		}
		state.done = true;
		wakeAll(state);
		onClose();
	};
	const iterator: AsyncIterator<OpencodeChatEvent> = {
		async next(): Promise<IteratorResult<OpencodeChatEvent>> {
			for (;;) {
				// O sinal é lido **antes** de olhar a fila: um evento que chegue
				// entre a checagem e a espera acorda este sinal.
				const signal = state.signal;
				// Consome **tudo** o que já está na fila — o `SessionStarted` é
				// pulado e a volta seguinte olha a fila de novo, sem esperar.
				while (index < state.events.length) {
					const event = state.events[index];
					index += 1;
					if (event.type === 'SessionStarted') {
						continue;
					}
					return { done: false, value: event };
				}
				if (state.done) {
					return { done: true, value: undefined };
				}
				await signal;
			}
		},
		async return(): Promise<IteratorResult<OpencodeChatEvent>> {
			// O consumidor que abandona o `for await` fecha o turno aqui: o
			// contrato diz que fechar cedo encerra a stream, sem erro.
			end('closed');
			return { done: true, value: undefined };
		},
		async throw(error?: unknown): Promise<IteratorResult<OpencodeChatEvent>> {
			end('closed');
			throw error instanceof Error ? error : new Error('stream encerrado');
		},
	};
	// O núcleo só conhece eventos do `ChatStream`; o `SessionStarted` é filtrado
	// aqui, e é anunciado por `onStarted`.
	const stream = {
		get started(): SessionStartedEvent | undefined {
			return state.startedEvent;
		},
		get closedReason() {
			return state.closedReason;
		},
		get timing(): StreamTiming {
			return { ...timing };
		},
		get respondedModel() {
			return state.respondedModel;
		},
		[Symbol.asyncIterator](): AsyncIterator<ChatStreamEvent> {
			return iterator as AsyncIterator<ChatStreamEvent>;
		},
	} as ChatStream & { readonly started: SessionStartedEvent | undefined };
	return stream;
}

function push(state: TurnState, event: OpencodeChatEvent): void {
	if (event.type === 'SessionStarted') {
		state.startedEvent = event;
		state.onStarted?.(event);
	}
	state.events.push(event);
	wakeAll(state);
}

/**
 * Publica uma novidade: resolve o sinal atual e cria outro para a próxima
 * espera. Quem já estava esperando acorda; quem não estava lerá o estado na
 * próxima iteração.
 */
function wakeAll(state: TurnState): void {
	const notify = state.notify;
	state.signal = new Promise<void>((resolve) => {
		state.notify = resolve;
	});
	notify();
}

/** O texto que já foi entregue ao consumidor por `TextDelta`. */
function deliveredText(state: TurnState): string {
	return state.events
		.filter((event): event is Extract<ChatStreamEvent, { type: 'TextDelta' }> => event.type === 'TextDelta')
		.map((event) => event.text)
		.join('');
}

/** O id composto do catálogo (`providerID/modelID`). */
export function parseOpencodeModelId(value: string): OpencodeModelRef | undefined {
	const slash = value.indexOf('/');
	if (slash <= 0 || slash === value.length - 1) {
		return undefined;
	}
	return { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) };
}

/** A última mensagem do usuário, como o OpenCode espera. */
function lastUserText(messages: readonly ChatMessage[]): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message !== undefined && message.role === 'user') {
			return message.content.trim();
		}
	}
	return '';
}

function basicAuth(password: string): string {
	return `Basic ${Buffer.from(`opencode:${password}`, 'utf8').toString('base64')}`;
}

/** O corpo do turno, só com o que o adaptador usa. */
interface TurnBody {
	readonly text: string;
	readonly model?: string;
	readonly sessionID?: string;
	readonly parentID?: string;
}

/** Lê `{ info, parts }` (ou `{ data: { ... } }`) de uma resposta de turno. */
function readTurnBody(body: unknown): TurnBody | undefined {
	if (body === null || typeof body !== 'object') {
		return undefined;
	}
	const record = body as Record<string, unknown>;
	const message = (record['data'] ?? record) as Record<string, unknown>;
	const info = (message['info'] ?? {}) as Record<string, unknown>;
	if (Object.keys(info).length === 0 && !Array.isArray(message['parts'])) {
		return undefined;
	}
	const parts = Array.isArray(message['parts']) ? message['parts'] : [];
	const text = parts
		.map((part) => part as Record<string, unknown>)
		.filter((part) => part['type'] === 'text' && typeof part['text'] === 'string')
		.map((part) => part['text'] as string)
		.join('');
	const model = readInfoModel(info);
	const sessionID = typeof info['sessionID'] === 'string' ? info['sessionID'] : undefined;
	const parentID = typeof info['parentID'] === 'string' ? info['parentID'] : undefined;
	return {
		text,
		...(model !== undefined ? { model } : {}),
		...(sessionID !== undefined ? { sessionID } : {}),
		...(parentID !== undefined ? { parentID } : {}),
	};
}

function readInfoModel(info: Record<string, unknown>): string | undefined {
	const providerID = typeof info['providerID'] === 'string' ? info['providerID'] : undefined;
	const modelID = typeof info['modelID'] === 'string' ? info['modelID'] : undefined;
	return providerID !== undefined && modelID !== undefined ? `${providerID}/${modelID}` : undefined;
}

function toError(error: unknown): Error {
	if (error instanceof OpencodeChatError) {
		return error;
	}
	return new OpencodeChatError(messageOf(error), 'server');
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
