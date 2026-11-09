/**
 * Um `ChatProvider` que aprende com a resposta HTTP.
 *
 * ## Por que existe
 *
 * O motor de rota chama `streamChat` e recebe um `ChatStream`; quando o
 * provedor responde `429`, a informação de cota (restante, `Retry-After`) está
 * no erro e nos cabeçalhos, e o desfecho de uma rota bem-sucedida é a única
 * prova de que a conta **usa** aquele modelo. Nada disso chega ao roteador por
 * si: o `RouteAttempt` tem `httpStatus`/`retryAfterMs`, mas não os cabeçalhos,
 * e nunca diz "este modelo respondeu para esta credencial".
 *
 * Este adaptador fica na frente do provedor real e observa:
 *
 * - `streamChat` resolveu → o acesso está confirmado, e os cabeçalhos de cota
 *   da resposta (restante, limite, reinício) são registrados;
 * - `streamChat` rejeitou com `429` → `recordRateLimit` com o `Retry-After` e os
 *   cabeçalhos, que inicia a janela no rastreador de cotas.
 *
 * ## O que ele nunca faz
 *
 * Não altera a requisição, não lê o corpo e não bloqueia nada: o roteador
 * continua sendo quem decide. Não segura chaves: recebe o provedor já
 * construído, e o provedor é quem resolve a credencial.
 */
import type { ChatProvider, ChatRequest, ChatStream } from '../core/providers/chat/types';
import { ProviderError } from '../core/errors';
import type { ProviderDiscovery } from './providerDiscovery';

export interface ObservingProviderOptions {
	readonly inner: ChatProvider;
	readonly providerId: string;
	readonly discovery: Pick<ProviderDiscovery, 'confirmUse' | 'recordRateLimit' | 'recordChatResponse'>;
	/**
	 * Chamado quando o servidor publica qual modelo respondeu.
	 *
	 * Num **roteador**, o modelo que responde pode ser outro que o pedido, e
	 * a única afirmação que existe é a do servidor. Sem este gancho, o
	 * relatório teria de dizer "o modelo pedido respondeu" — o que é uma
	 * adivinhação.
	 */
	readonly onRespondedModel?: (
		target: { readonly providerId: string; readonly modelId: string },
		respondedModel: string,
	) => void;
	/** Injetado em testes. */
	readonly onFailure?: (error: unknown) => void;
}

function statusOf(error: unknown): number | undefined {
	if (error instanceof ProviderError) {
		const status = error.details?.status;
		if (typeof status === 'number' && Number.isInteger(status)) {
			return status;
		}
	}
	return undefined;
}

function retryAfterOf(error: unknown): number | undefined {
	if (error instanceof ProviderError) {
		const value = error.details?.retryAfterMs;
		if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
			return value;
		}
	}
	return undefined;
}

/**
 * Os cabeçalhos de cota que o provedor grudou no erro.
 *
 * Só os que dizem algo sobre limite e janela; o resto é descartado, porque o
 * erro também vaza para o log e um cabeçalho de autenticação dentro dele seria
 * um segredo em texto claro.
 */
function quotaHeadersOf(error: unknown): Readonly<Record<string, string>> | undefined {
	if (!(error instanceof ProviderError)) {
		return undefined;
	}
	const headers = error.details?.['quotaHeaders'];
	if (typeof headers !== 'object' || headers === null) {
		return undefined;
	}
	const kept: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
		if (typeof value !== 'string') {
			continue;
		}
		const lower = name.toLowerCase();
		if (lower === 'retry-after' || lower.startsWith('x-ratelimit-')) {
			kept[lower] = value;
		}
	}
	return Object.keys(kept).length === 0 ? undefined : kept;
}

/** Os cabeçalhos que o próprio stream carrega, quando o provedor os expõe. */
function streamHeaders(stream: ChatStream): Readonly<Record<string, string>> | undefined {
	const headers = (stream as unknown as { responseHeaders?: Readonly<Record<string, string>> }).responseHeaders;
	if (headers === undefined) {
		return undefined;
	}
	return Object.keys(headers).length === 0 ? undefined : headers;
}

/**
 * Encapsula um stream para observar o que o servidor disse no fim.
 *
 * ## Por que o encapsulamento
 *
 * O `model` que o servidor publica chega **dentro** do stream, no primeiro
 * pedaço — depois que a requisição foi feita. Ler o campo logo após o
 * `streamChat` resolveria encontraria `undefined` sempre, e o relatório
 * acabaria dizendo "o modelo pedido respondeu" num roteador que pode ter
 * respondido com outro.
 *
 * ## O que o wrapper preserva
 *
 * Tudo o que o consumidor lê: `closedReason`, `timing`, o `model` publicado e
 * o `return` que cancela. O wrapper **não** altera nenhum evento.
 */
function observeStream(
	stream: ChatStream,
	onDone: (respondedModel: string | undefined) => void,
): ChatStream {
	// Notifica **uma vez**, assim que o modelo é conhecido. Notificar no
	// `finally` do gerador não basta: o motor de rota consome o stream com um
	// laço próprio e pode abandoná-lo sem fechá-lo, e o `finally` então nunca
	// roda — o que faria o relatório dizer "não se sabe" sobre algo que o
	// servidor já tinha dito.
	let notified = false;
	const notify = (): void => {
		if (notified) {
			return;
		}
		const responded = stream.respondedModel;
		if (responded === undefined) {
			return;
		}
		notified = true;
		onDone(responded);
	};
	const wrapper: ChatStream = {
		closedReason: stream.closedReason,
		timing: stream.timing,
		...(stream.respondedModel !== undefined ? { respondedModel: stream.respondedModel } : {}),
		async *[Symbol.asyncIterator]() {
			try {
				for await (const event of stream) {
					yield event;
					// O pedaço com o `model` já foi processado quando o evento
					// chega; o que o servidor disse já é conhecida.
					notify();
				}
			} finally {
				// Notifica tanto no fim normal quanto num cancelamento: o que o
				// servidor disse até ali é o que se sabe.
				notify();
			}
		},
	};
	// O `return` do stream original - o cancelamento - continua acessível. Ele
	// não faz parte do tipo da interface, mas o runtime o usa.
	return Object.assign(wrapper, {
		async return(value?: unknown) {
			const close = (stream as { return?: (v?: unknown) => Promise<unknown> }).return;
			if (typeof close === 'function') {
				await close.call(stream, value);
			}
			notify();
			return value;
		},
	});
}

export function createObservingProvider(options: ObservingProviderOptions): ChatProvider {
	const report = (error: unknown): void => {
		try {
			options.onFailure?.(error);
		} catch {
			// Reportar não pode falhar a resposta.
		}
	};
	return {
		async streamChat(
			request: ChatRequest,
			streamOptions: { readonly signal?: AbortSignal } = {},
		): Promise<ChatStream> {
			try {
				const stream = await options.inner.streamChat(request, streamOptions);
				// A resposta existe: esta conta alcança este modelo.
				void options.discovery
					.confirmUse(options.providerId, request.model)
					.catch(report);
				// E os cabeçalhos dela dizem o que a conta ainda tem. Uma
				// resposta bem-sucedida é onde o saldo aparece, e sem isto a
				// cota da conta só seria conhecida depois de um `429`.
				const headers = streamHeaders(stream);
				if (headers !== undefined) {
					void options.discovery
						.recordChatResponse({
							providerId: options.providerId,
							modelId: request.model,
							status: 200,
							headers,
						})
						.catch(report);
				}
			// O modelo que o servidor disse que respondeu, quando disse. Num
			// roteador pode ser outro que o pedido, e e a unica
			// afirmacao que existe sobre quem respondeu.
			//
			// Ele chega DENTRO do stream, no primeiro pedaco - depois
			// que a requisicao foi feita. Ler o campo logo apos o
			// streamChat resolver encontraria undefined sempre, e o
			// relatorio acabaria dizendo "o modelo pedido respondeu" num
			// roteador que pode ter respondido com outro.
			if (options.onRespondedModel !== undefined) {
				return observeStream(stream, (responded) => {
					if (responded === undefined) {
						return;
					}
					try {
						options.onRespondedModel?.(
							{ providerId: options.providerId, modelId: request.model },
							responded,
						);
					} catch {
						// Notificar nao pode falhar a resposta.
					}
				});
			}
			return stream;
			} catch (error) {
				const status = statusOf(error);
				if (status === 429 || status === 503) {
					const retryAfterMs = retryAfterOf(error);
					const headers = quotaHeadersOf(error);
					// Fire-and-forget: a taxa de erro não pode atrasar o fallback.
					void options.discovery
						.recordRateLimit({
							providerId: options.providerId,
							modelId: request.model,
							...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
							...(headers !== undefined ? { headers } : {}),
						})
						.catch(report);
				}
				throw error;
			}
		},
	};
}
