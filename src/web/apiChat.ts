/**
 * Uma requisição de `chat/completions`, isolada das demais.
 *
 * ## Por que esta camada existe
 *
 * `ChatSession.sendMessage` é a fachada de **um** turno por vez: ela reserva
 * um slot (`inFlight`), guarda a conversa em curso em campos da instância
 * (`conversationInFlight`, `turnInFlight`), mantém um único broker de
 * permissões que o turno seguinte cancela, e acumula as decisões de orçamento
 * num array que qualquer turno drena. Todo esse estado é correto para uma
 * janela com um usuário e um pedido por vez — e é exatamente o que não pode
 * ser compartilhado por dois clientes HTTP simultâneos.
 *
 * O que a sessão **não** guarda é o que esta camada usa:
 *
 * - `RoutedChatProvider` — um por requisição, com os próprios `attempts`,
 *   política de rota, gate de orçamento e gravador de consumo;
 * - `CircuitBreaker` — **compartilhado** de propósito: é a saúde de um
 *   endpoint, e esquecê-la entre requisições é o único erro que um breaker
 *   existe para impedir;
 * - cancelamento — o `AbortSignal` da própria requisição. Nada aqui chama
 *   `stop()` nem `cancelAll`.
 *
 * Nenhum campo novo é compartilhado. Duas requisições concorrentes não se
 * veem: nem nos eventos, nem no cancelamento, nem no resultado.
 *
 * ## O que fica de fora, deliberadamente
 *
 * O laço de ferramentas. O agente abre diálogos de permissão para tools
 * `moderate`, e um cliente HTTP não tem ninguém para responder — o turno
 * ficaria pendente até o timeout. `/v1` responde o que o modelo produz, sem
 * executar nada em nome do cliente.
 *
 * ## Conversa
 *
 * A API compatível com OpenAI é sem estado: o cliente manda o histórico
 * inteiro a cada pedido. Por isso cada requisição usa uma conversa de
 * armazenamento **própria** (efêmera, só para o registro de consumo), e o
 * `conversationId` do consumo nasce dela — nunca de um campo da sessão.
 */
import { randomUUID } from 'node:crypto';

import type { ChatProvider, ChatRequest, ChatStream, ChatStreamEvent, TokenUsage } from '../core/providers/chat/types';
import { RoutedChatProvider } from '../core/providers/routing/routedProvider';
import type {
	BudgetGate,
	QuotaGate,
	RouteAttempt,
	RoutePolicy,
	RoutingClock,
	RoutingObserver,
} from '../core/providers/routing/types';
import type { RouteSleep } from '../core/providers/routing/types';
import type { RouterMode } from '../core/providers/routing/config';
import { createBudgetGate } from '../desktop/budgetGate';
import { createConsumptionRecorder, type ConsumptionRecorder } from '../desktop/consumptionRecorder';
import type { ProviderDiscovery } from '../desktop/providerDiscovery';
import type { ConsumptionLedgerPort } from '../core/storage/types/consumption';
import type { BudgetStore } from '../desktop/budgetGate';
import type { ModelPricing } from '../core/storage/types/modelCatalog';
import type { ModelAccessPolicyRecord } from '../core/catalog/policy';

/** Um candidato a modelo, como o catálogo o conhece. */
export interface ApiRouteCandidate {
	readonly providerId: string;
	readonly modelId: string;
}

/**
 * O que a camada precisa de fora.
 *
 * Cada item é uma **porta**, não o `ChatSession`: a camada não pode, por
 * construção, alcançar o slot do turno ou o broker.
 */
export interface ApiChatRuntimeOptions {
	/** Constrói o cliente de um provedor configurado. */
	readonly providerFor: (providerId: string) => ChatProvider;
	/**
	 * Os modelos elegíveis para um pedido.
	 *
	 * O primeiro é o principal; os seguintes, os fallbacks. É a política de
	 * seleção que decide — a mesma que a Evelyn usa na sessão.
	 */
	readonly candidatesFor: (input: {
		readonly requested: ApiRouteCandidate;
		readonly signal: AbortSignal;
	}) => Promise<readonly ApiRouteCandidate[]>;
	/** A política de rota em vigor. */
	readonly policy: RoutePolicy;
	/** A saúde dos endpoints, compartilhada entre requisições. */
	readonly breaker: ConstructorParameters<typeof RoutedChatProvider>[0]['breaker'];
	readonly ledger: ConsumptionLedgerPort;
	/**
	 * O armazenamento que lê limites, consumo e preço declarado.
	 *
	 * É o mesmo `FileDataStore` da sessão — o gate e o gravador de consumo
	 * leem o ledger, nunca um cache em memória que divergiria dele.
	 */
	readonly store: BudgetStore;
	readonly pricing: (candidate: ApiRouteCandidate) => Promise<ModelPricing | undefined>;
	readonly accessPolicy: () => Promise<ModelAccessPolicyRecord>;
	readonly discovery?: ProviderDiscovery;
	readonly allowPaid?: boolean;
	readonly clock?: RoutingClock;
	readonly sleep?: RouteSleep;
	/** Onde as falhas de registro são ditas. Nunca com conteúdo da conversa. */
	readonly onFailure?: (error: unknown, context: { readonly phase: string }) => void;
}

/** O pedido, já validado pela camada HTTP. */
export interface ApiChatRequest {
	readonly model: string;
	readonly messages: ChatRequest['messages'];
	readonly stream: boolean;
	/** Teto de tokens, quando o cliente mandou um. */
	readonly maxTokens?: number;
	readonly signal: AbortSignal;
}

/** O resultado de uma requisição, quando ela não é em streaming. */
export interface ApiChatCompletion {
	readonly id: string;
	readonly model: string;
	readonly content: string;
	readonly reasoning?: string;
	readonly usage?: TokenUsage;
	readonly finishReason: FinishReason;
	/** O modelo que **respondeu**, quando difere do pedido. */
	readonly respondedModel?: string;
	readonly attempts: readonly RouteAttempt[];
	readonly mode: RouterMode | 'native';
}

/** Por que o pedido terminou. Espelha o vocabulário de `ChatStream`. */
export type FinishReason = 'stop' | 'length' | 'cancelled' | 'error';

/** Um evento das duas formas (streaming e não-streaming). */
export type ApiChatEvent =
	| { readonly type: 'delta'; readonly text: string }
	| { readonly type: 'reasoning'; readonly text: string }
	| { readonly type: 'usage'; readonly usage: TokenUsage }
	| { readonly type: 'done'; readonly completion: ApiChatCompletion }
	| { readonly type: 'error'; readonly message: string; readonly code: ApiErrorCode };

/** As classes de erro que a camada HTTP traduz em status. */
export type ApiErrorCode =
	| 'no_candidate'
	| 'budget_exhausted'
	| 'bad_request'
	| 'auth'
	| 'rate_limit'
	| 'timeout'
	| 'cancelled'
	| 'upstream'
	| 'internal';

/** O erro de uma requisição, já classificado. */
export class ApiChatError extends Error {
	constructor(
		readonly code: ApiErrorCode,
		message: string,
	) {
		super(message);
		this.name = 'ApiChatError';
	}
}

/**
 * A camada de execução.
 *
 * Um `execute` por requisição: tudo o que é estado da requisição nasce
 * dentro dele e morre com ele.
 */
export class ApiChatRuntime {
	constructor(private readonly options: ApiChatRuntimeOptions) {}

	/**
	 * Executa um pedido e devolve os eventos na ordem em que aconteceram.
	 *
	 * O iterador é preguiçoso: o cliente que fecha a conexão para de puxar, e
	 * o `signal` cancela a requisição ao provedor. `finally` fecha o stream,
	 * para uma conexão abandonada não deixar uma geração viva.
	 */
	async *execute(request: ApiChatRequest): AsyncGenerator<ApiChatEvent> {
		const options = this.options;
		const id = `chatcmpl_${randomUUID()}`;
		// Um pedido sem histórico é um 400, não um problema de provedor.
		const last = request.messages[request.messages.length - 1];
		if (last === undefined) {
			throw new ApiChatError('bad_request', 'o pedido não tem mensagens');
		}
		const parsed = parseModelId(request.model);
		if (parsed === undefined) {
			throw new ApiChatError(
				'bad_request',
				'o modelo deve ser "provedor/modelo" — por exemplo "river/deepseek-ai/DeepSeek-V4.1-Flash"',
			);
		}

		// A conversa desta requisição: um id próprio, usado só para o
		// registro de consumo. Nunca o de uma sessão compartilhada.
		const conversationId = `api_${randomUUID()}`;
		const turnId = `api_turn_${randomUUID()}`;

		let candidates: readonly ApiRouteCandidate[];
		try {
			candidates = await options.candidatesFor({ requested: parsed, signal: request.signal });
		} catch (error) {
			throw classify(error, 'no_candidate');
		}
		if (candidates.length === 0) {
			throw new ApiChatError(
				'no_candidate',
				`nenhum modelo disponível para "${request.model}" com a configuração atual`,
			);
		}

		// O gate e o gravador são **desta** requisição. O gate lê os limites
		// a cada candidato, como o da sessão; nada é drenado de um array
		// compartilhado.
		const budget: BudgetGate = createBudgetGate({
			store: options.store,
			allowPaid: options.allowPaid ?? false,
			pricing: async (candidate) => options.pricing(candidate),
			policy: async () => (await options.accessPolicy()).policy,
			...(options.onFailure !== undefined
				? { onFailure: (error, context) => options.onFailure?.(error, { phase: `budget:${context.phase}` }) }
				: {}),
		});

		const consumption: ConsumptionRecorder = createConsumptionRecorder({
			ledger: options.ledger,
			pricing: async (providerId, modelId) => options.pricing({ providerId, modelId }),
			// Por requisição: os ids nascem aqui e não são lidos de lugar nenhum.
			conversationId: () => conversationId,
			turnId: () => turnId,
			...(options.onFailure !== undefined
				? {
						onFailure: (error, context) =>
							options.onFailure?.(error, { phase: `consumption:${context.phase}` }),
					}
				: {}),
		});

		const mode: RouterMode | 'native' = 'native';
		/**
		 * O port que o motor consulta a cada tentativa.
		 *
		 * Duas observações, ambas **desta** requisição: o gravador de consumo
		 * (que fecha a execução no ledger) e a descoberta (que aprende com o
		 * `429` ou o sucesso). Sem isto as tentativas aconteciam e não eram
		 * contadas — o consumo era coletado por ninguém.
		 */
		const metrics = {
			recordAttempt: async (attempt: RouteAttempt): Promise<void> => {
				await Promise.all([
					consumption.recordAttempt(attempt),
					...(options.discovery !== undefined
						? [discoveryMetrics(options.discovery, options.onFailure).recordAttempt(attempt)]
						: []),
				]);
			},
		};
		const provider = new RoutedChatProvider({
			targets: candidates.map((candidate) => ({
				...candidate,
				provider: options.providerFor(candidate.providerId),
			})),
			policy: options.policy,
			breaker: options.breaker,
			budget,
			metrics,
			...(options.clock !== undefined ? { clock: options.clock } : {}),
			...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
			routeId: turnId,
		});

		const chatRequest: ChatRequest = {
			// O modelo pedido é o do primeiro candidato: o roteador decide se
			// troca, e o evento `done` diz qual respondeu.
			model: candidates[0].modelId,
			messages: request.messages,
			stream: request.stream,
			...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
		};

		let stream: ChatStream;
		try {
			stream = await provider.streamChat(
				chatRequest,
				{ signal: request.signal },
			);
		} catch (error) {
			await settle(consumption, provider);
			throw classify(error, 'upstream');
		}

		const parts: string[] = [];
		const reasoning: string[] = [];
		let usage: TokenUsage | undefined;
		let failure: ApiChatError | undefined;

		try {
			for await (const event of stream) {
				if (request.signal.aborted) {
					break;
				}
				const translated = translate(event, parts, reasoning);
				if (translated === undefined) {
					continue;
				}
				if (translated.type === 'usage') {
					usage = translated.usage;
				}
				if (translated.type === 'error') {
					failure = new ApiChatError(translated.code, translated.message);
				}
				yield translated;
			}
		} catch (error) {
			failure = classify(error, 'upstream');
			yield { type: 'error', message: failure.message, code: failure.code };
		} finally {
			// O consumo é fechado antes do evento terminal: um cliente que
			// reage a `done` pode consultar o total e vê-lo completo.
			await settle(consumption, provider);
		}

		if (failure !== undefined) {
			return;
		}
		// Um turno cancelado não é um erro: o cliente pediu para parar.
		if (request.signal.aborted || stream.closedReason === 'aborted') {
			yield { type: 'error', message: 'a requisição foi cancelada', code: 'cancelled' };
			return;
		}
		const respondedModel = stream.respondedModel;
		const completion: ApiChatCompletion = {
			id,
			model: respondedModel ?? chatRequest.model,
			content: parts.join(''),
			...(reasoning.length > 0 ? { reasoning: reasoning.join('') } : {}),
			...(usage !== undefined ? { usage } : {}),
			finishReason: 'stop',
			...(respondedModel !== undefined && respondedModel !== chatRequest.model
				? { respondedModel }
				: {}),
			attempts: provider.attempts,
			mode,
		};
		yield { type: 'done', completion };
	}
}

/**
 * Fecha a contabilidade da requisição.
 *
 * As tentativas são publicadas enquanto a rota termina, então a fila precisa
 * drenar antes de fechar. Uma falha aqui é dita e **não** transformada em erro
 * do pedido: perder um registro de custo não pode apagar uma resposta que já
 * foi entregue.
 */
async function settle(consumption: ConsumptionRecorder, provider: RoutedChatProvider): Promise<void> {
	try {
		await consumption.settled();
		const requestIds = new Set(provider.attempts.map((attempt) => attempt.requestId));
		for (const requestId of requestIds) {
			const ofRequest = provider.attempts.filter((attempt) => attempt.requestId === requestId);
			const status = statusOf(ofRequest);
			await consumption.settleRequest(requestId, status);
		}
	} catch {
		// O gravador já reportou pelo `onFailure`.
	}
}

/** O desfecho de uma rodada, pelo mesmo critério do motor. */
function statusOf(attempts: readonly RouteAttempt[]): 'success' | 'failure' | 'cancelled' {
	if (attempts.some((attempt) => attempt.outcome === 'success')) {
		return 'success';
	}
	if (attempts.some((attempt) => attempt.outcome === 'failure')) {
		return 'failure';
	}
	return 'cancelled';
}

/** O port que o motor usa para publicar tentativas na descoberta. */
function discoveryMetrics(
	discovery: ProviderDiscovery,
	onFailure: ((error: unknown, context: { readonly phase: string }) => void) | undefined,
): { readonly recordAttempt: (attempt: RouteAttempt) => Promise<void> } {
	return {
		async recordAttempt(attempt) {
			try {
				if (attempt.outcome === 'success') {
					await discovery.confirmUse(attempt.providerId, attempt.modelId);
					return;
				}
				if (attempt.httpStatus === undefined) {
					return;
				}
				await discovery.recordChatResponse({
					providerId: attempt.providerId,
					modelId: attempt.modelId,
					status: attempt.httpStatus,
					headers: {},
					...(attempt.retryAfterMs !== undefined ? { retryAfterMs: attempt.retryAfterMs } : {}),
				});
			} catch (error) {
				onFailure?.(error, { phase: 'discovery' });
			}
		},
	};
}

/** Traduz um evento do provedor, acumulando o texto. */
function translate(
	event: ChatStreamEvent,
	parts: string[],
	reasoning: string[],
): ApiChatEvent | undefined {
	if (event.type === 'TextDelta') {
		parts.push(event.text);
		return { type: 'delta', text: event.text };
	}
	if (event.type === 'ReasoningDelta') {
		reasoning.push(event.text);
		return { type: 'reasoning', text: event.text };
	}
	if (event.type === 'Usage') {
		return { type: 'usage', usage: event.usage };
	}
	if (event.type === 'Error') {
		const classified = classify(event.error, 'upstream');
		return { type: 'error', message: classified.message, code: classified.code };
	}
	return undefined;
}

/** `provider/model` ou só `model`, como os clientes OpenAI costumam mandar. */
export function parseModelId(model: string): ApiRouteCandidate | undefined {
	const trimmed = model.trim();
	if (trimmed.length === 0) {
		return undefined;
	}
	const slash = trimmed.indexOf('/');
	if (slash <= 0 || slash === trimmed.length - 1) {
		return undefined;
	}
	return { providerId: trimmed.slice(0, slash), modelId: trimmed.slice(slash + 1) };
}

/**
 * A classe de erro do motor, no vocabulário da API.
 *
 * Um `Error` que não é do motor (uma falha de configuração, por exemplo) vira
 * `internal`: o status 500 não promete nada além de "não foi culpa do
 * pedido", e a mensagem já foi escrita para ser lida.
 */
export function classify(error: unknown, fallback: ApiErrorCode): ApiChatError {
	if (error instanceof ApiChatError) {
		return error;
	}
	const className =
		typeof error === 'object' && error !== null && 'errorClass' in error
			? (error as { readonly errorClass?: unknown }).errorClass
			: undefined;
	const message = error instanceof Error ? error.message : String(error);
	if (typeof className === 'string') {
		const mapped: Record<string, ApiErrorCode> = {
			timeout: 'timeout',
			unavailable: 'upstream',
			rate_limit: 'rate_limit',
			upstream_error: 'upstream',
			network: 'upstream',
			auth: 'auth',
			bad_request: 'bad_request',
			context_length: 'bad_request',
			cancelled: 'cancelled',
			breaker_open: 'upstream',
			budget_exhausted: 'budget_exhausted',
			no_candidate: 'no_candidate',
			model_not_found: 'bad_request',
			internal: 'internal',
		};
		const code = mapped[className];
		if (code !== undefined) {
			return new ApiChatError(code, message);
		}
	}
	return new ApiChatError(fallback, message);
}
