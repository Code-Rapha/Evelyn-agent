/**
 * A superfície compatível com a API OpenAI: `/v1/models` e `/v1/chat/completions`.
 *
 * ## O que esta camada faz, e o que ela entrega a quem
 *
 * Ela traduz HTTP ↔ `ApiChatRuntime`. Nada de roteamento acontece aqui: o
 * motor da Evelyn decide os candidatos, o fallback, o orçamento e as cotas, e
 * esta camada só escreve o resultado no formato que um cliente OpenAI
 * entende. Um segundo roteador aqui seria a divergência que o `assemble.ts`
 * existe para evitar.
 *
 * ## Isolamento
 *
 * Cada `handle` cria o próprio runtime de requisição (`ApiChatRuntime`
 * recebe os dados e devolve um gerador fechado sobre eles). Nenhum estado
 * atravessa requisições, exceto o `CircuitBreaker` — que é saúde de endpoint
 * e deve atravessar.
 *
 * O `AbortController` é local: fechar a conexão aborta **esta** requisição.
 *
 * ## Segurança da resposta
 *
 * Erros saem como `{ error: { message, type, code } }` e nada mais: sem
 * stack, sem caminho de arquivo, sem chave, sem corpo de provedor. A
 * mensagem é a do motor quando ele classificou a falha; o resto é genérico.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { TokenUsage } from '../core/providers/chat/types';
import {
	ApiChatError,
	ApiChatRuntime,
	type ApiChatCompletion,
	type ApiChatEvent,
	type ApiErrorCode,
	type FinishReason,
} from './apiChat';
import { BASE_HEADERS } from './policy';

/**
 * O teto de um corpo em `/v1`.
 *
 * Maior que o do painel (64 KiB) porque um cliente manda o histórico
 * inteiro; ainda assim um teto, para uma requisição não consumir a memória
 * do processo. 1 MiB cobre conversas longas com folga.
 */
export const MAX_API_BODY_BYTES = 1024 * 1024;

/** O cabeçalho do SSE, como os clientes OpenAI esperam. */
const SSE_HEADERS: Readonly<Record<string, string>> = {
	'Content-Type': 'text/event-stream; charset=utf-8',
	'Cache-Control': 'no-cache, no-transform',
	Connection: 'keep-alive',
	// Alguns proxies guardam a resposta sem este cabeçalho.
	'X-Accel-Buffering': 'no',
};

/** Um modelo, no formato de `/v1/models`. */
export interface ApiModelEntry {
	/** `providerId/modelId`, o id que o cliente devolve no pedido. */
	readonly id: string;
	readonly created: number;
	readonly ownedBy: string;
}

/** O que a camada precisa para responder a uma requisição. */
export interface OpenAiApiOptions {
	/** O runtime por requisição. */
	readonly runtime: ApiChatRuntime;
	/** O catálogo real: os modelos que este serviço de fato atende. */
	readonly listModels: () => Promise<readonly ApiModelEntry[]>;
}

/** O resultado: ou a resposta foi escrita, ou um status com corpo JSON. */
export interface OpenAiReply {
	readonly status: number;
	readonly body: unknown;
	/** Presente quando a resposta é em streaming (status 200). */
	readonly stream?: AsyncIterable<ApiChatEvent>;
	/** O que abortar quando o cliente sai. */
	readonly abort?: AbortController;
}

/**
 * Uma requisição validada de `chat/completions`.
 *
 * Tipos maliciosos ou fora do contrato são **recusados**, não coagidos: um
 * `messages: "oi"` virando `[]` produziria uma resposta que ninguém pediu.
 */
export interface ParsedChatRequest {
	readonly model: string;
	readonly messages: readonly {
		readonly role: 'system' | 'user' | 'assistant';
		readonly content: string;
	}[];
	readonly stream: boolean;
	readonly maxTokens?: number;
}

/** Por que o corpo não serve, em termos que o cliente entende. */
export class InvalidRequest extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InvalidRequest';
	}
}

/**
 * Valida o corpo de `chat/completions`.
 *
 * O que é aceito é o subconjunto que o Core sabe conversar hoje: papéis
 * `system`/`user`/`assistant` com conteúdo textual. `tool` e `tool_calls`
 * exigem o laço de ferramentas, que não roda nesta superfície — recusá-los é
 * mais honesto do que executá-los em nome do cliente ou descartá-los em
 * silêncio.
 */
export function parseChatRequest(body: unknown): ParsedChatRequest {
	if (body === null || typeof body !== 'object' || Array.isArray(body)) {
		throw new InvalidRequest('o corpo deve ser um objeto JSON');
	}
	const input = body as Record<string, unknown>;
	const model = input['model'];
	if (typeof model !== 'string' || model.trim().length === 0) {
		throw new InvalidRequest('"model" é obrigatório e precisa ser uma string não vazia');
	}
	if (model.length > 200) {
		throw new InvalidRequest('"model" é grande demais');
	}
	const messages = input['messages'];
	if (!Array.isArray(messages) || messages.length === 0) {
		throw new InvalidRequest('"messages" precisa ser uma lista com ao menos uma mensagem');
	}
	if (messages.length > MAX_MESSAGES) {
		throw new InvalidRequest(`"messages" tem mais de ${MAX_MESSAGES} itens`);
	}
	const parsed: { role: 'system' | 'user' | 'assistant'; content: string }[] = [];
	for (const [index, entry] of messages.entries()) {
		if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
			throw new InvalidRequest(`messages[${index}] não é um objeto`);
		}
		const message = entry as Record<string, unknown>;
		const role = message['role'];
		if (role !== 'system' && role !== 'user' && role !== 'assistant') {
			throw new InvalidRequest(
				`messages[${index}].role deve ser "system", "user" ou "assistant" (recebido ${describe(role)})`,
			);
		}
		const content = message['content'];
		if (typeof content !== 'string') {
			throw new InvalidRequest(`messages[${index}].content precisa ser uma string`);
		}
		if (content.length > MAX_MESSAGE_CHARS) {
			throw new InvalidRequest(`messages[${index}].content passa de ${MAX_MESSAGE_CHARS} caracteres`);
		}
		parsed.push({ role, content });
	}
	const stream = input['stream'] ?? false;
	if (typeof stream !== 'boolean') {
		throw new InvalidRequest('"stream" precisa ser um booleano');
	}
	const maxTokensRaw = input['max_tokens'] ?? input['max_completion_tokens'];
	let maxTokens: number | undefined;
	if (maxTokensRaw !== undefined && maxTokensRaw !== null) {
		if (
			typeof maxTokensRaw !== 'number' ||
			!Number.isInteger(maxTokensRaw) ||
			maxTokensRaw < 1 ||
			maxTokensRaw > MAX_TOKENS
		) {
			throw new InvalidRequest(`"max_tokens" precisa ser um inteiro entre 1 e ${MAX_TOKENS}`);
		}
		maxTokens = maxTokensRaw;
	}
	// `temperature` e `top_p` são aceitos pela API OpenAI mas não fazem parte
	// do pedido do Core (o adaptador não os envia). Ausentes, nada muda;
	// presentes, eles não são aplicados — e a resposta não finge que foram.
	return {
		model: model.trim(),
		messages: parsed,
		stream,
		...(maxTokens !== undefined ? { maxTokens } : {}),
	};
}

/** Um teto de mensagens por pedido. */
const MAX_MESSAGES = 500;
/** Um teto de caracteres por mensagem. */
const MAX_MESSAGE_CHARS = 100_000;
/** Um teto de tokens pedidos. */
const MAX_TOKENS = 100_000;

/** Descreve o valor recebido sem o devolver inteiro (pode ser enorme). */
function describe(value: unknown): string {
	if (value === null) {
		return 'null';
	}
	if (typeof value === 'string') {
		return value.length > 40 ? `"${value.slice(0, 40)}…"` : `"${value}"`;
	}
	return typeof value;
}

/**
 * Lê o corpo com teto, sem `Content-Length` confiável.
 *
 * O limite é aplicado **durante** a leitura: esperar o `end` para medir
 * permitiria um corpo de gigabytes ocupar a memória antes da recusa.
 */
export async function readApiBody(
	request: IncomingMessage,
): Promise<{ readonly kind: 'ok'; readonly value: unknown } | { readonly kind: 'invalid'; readonly reason: string }> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
		size += buffer.length;
		if (size > MAX_API_BODY_BYTES) {
			return { kind: 'invalid', reason: `o corpo passa de ${MAX_API_BODY_BYTES} bytes` };
		}
		chunks.push(buffer);
	}
	if (size === 0) {
		return { kind: 'invalid', reason: 'o corpo está vazio' };
	}
	try {
		return { kind: 'ok', value: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
	} catch {
		return { kind: 'invalid', reason: 'o corpo não é JSON válido' };
	}
}

/** O status HTTP de cada classe de erro. */
export function statusFor(code: ApiErrorCode): number {
	switch (code) {
		case 'bad_request':
			return 400;
		case 'auth':
			return 401;
		case 'budget_exhausted':
			return 402;
		case 'cancelled':
			// 499 não é RFC, mas é o que os proxies usam para "cliente desistiu".
			return 499;
		case 'no_candidate':
			return 404;
		case 'timeout':
			return 504;
		case 'rate_limit':
			return 429;
		case 'upstream':
			return 502;
		case 'internal':
			return 500;
	}
}

/** O tipo de erro no vocabulário OpenAI. */
function errorType(code: ApiErrorCode): string {
	switch (code) {
		case 'bad_request':
			return 'invalid_request_error';
		case 'auth':
			return 'authentication_error';
		case 'no_candidate':
			return 'not_found_error';
		case 'rate_limit':
			return 'rate_limit_error';
		case 'cancelled':
			return 'aborted_error';
		default:
			return 'api_error';
	}
}

/** O corpo de erro, sem detalhe interno. */
export function errorBody(code: ApiErrorCode, message: string): Record<string, unknown> {
	return {
		error: {
			message,
			type: errorType(code),
			code,
		},
	};
}

/** Traduz um erro qualquer em `(status, corpo)` — nunca vaza stack. */
export function classifyReply(error: unknown): OpenAiReply {
	if (error instanceof InvalidRequest) {
		return { status: 400, body: errorBody('bad_request', error.message) };
	}
	if (error instanceof ApiChatError) {
		return { status: statusFor(error.code), body: errorBody(error.code, error.message) };
	}
	// Sem classe: uma falha de programação. A mensagem genérica é
	// proposital — a original já foi para o log do host.
	return {
		status: 500,
		body: errorBody('internal', 'falha interna ao atender a requisição'),
	};
}

/** `GET /v1/models`. */
export async function listModelsReply(options: OpenAiApiOptions): Promise<OpenAiReply> {
	try {
		const models = await options.listModels();
		return {
			status: 200,
			body: {
				object: 'list',
				data: models.map((model) => ({
					id: model.id,
					object: 'model',
					created: model.created,
					owned_by: model.ownedBy,
				})),
			},
		};
	} catch (error) {
		return classifyReply(error);
	}
}

/**
 * `POST /v1/chat/completions`.
 *
 * Devolve o stream em vez de escrever: quem chama é o servidor, que sabe
 * fechar a conexão. Assim a camada é testável sem socket.
 *
 * O primeiro evento é consumido **aqui** em ambos os modos. Num pedido em
 * streaming isso é o que garante que um erro de rota (nenhum candidato,
 * orçamento) vire um status HTTP antes de qualquer cabeçalho SSE; num pedido
 * comum, é o que permite juntar tudo e responder com um corpo só — e com o
 * status certo.
 */
export async function chatCompletionsReply(input: {
	readonly options: OpenAiApiOptions;
	readonly body: unknown;
	/** O `signal` da conexão: cancelar fecha o provedor. */
	readonly signal: AbortSignal;
}): Promise<OpenAiReply> {
	let parsed: ParsedChatRequest;
	try {
		parsed = parseChatRequest(input.body);
	} catch (error) {
		return classifyReply(error);
	}
	const abort = new AbortController();
	const onExternal = (): void => abort.abort(input.signal.reason);
	if (input.signal.aborted) {
		abort.abort(input.signal.reason);
	} else {
		input.signal.addEventListener('abort', onExternal, { once: true });
	}
	try {
		const events = input.options.runtime.execute({
			model: parsed.model,
			messages: parsed.messages,
			stream: parsed.stream,
			...(parsed.maxTokens !== undefined ? { maxTokens: parsed.maxTokens } : {}),
			signal: abort.signal,
		});
		const first = await events.next();
		if (first.done) {
			input.signal.removeEventListener('abort', onExternal);
			return {
				status: 502,
				body: errorBody('upstream', 'o provedor terminou sem produzir resposta'),
			};
		}
		// O primeiro evento é um erro e o pedido não é stream: o status pode
		// ser o do erro, porque nenhum cabeçalho foi escrito ainda.
		if (first.value.type === 'error' && !parsed.stream) {
			input.signal.removeEventListener('abort', onExternal);
			return {
				status: statusFor(first.value.code),
				body: errorBody(first.value.code, first.value.message),
			};
		}
		if (!parsed.stream) {
			return collect(first.value, events, input.signal, onExternal);
		}
		return {
			status: 200,
			body: undefined,
			stream: prepend(first.value, events),
			abort,
		};
	} catch (error) {
		input.signal.removeEventListener('abort', onExternal);
		return classifyReply(error);
	}
}

/**
 * Junta os eventos de um pedido não-streaming numa resposta só.
 *
 * Um erro que chegue **depois** do primeiro evento não muda o status: o
 * modelo já produziu algo, e o corpo diz o que aconteceu em vez de devolver
 * um 200 vazio. É a mesma regra do motor — depois do primeiro token não há
 * retry.
 */
async function collect(
	first: ApiChatEvent,
	rest: AsyncIterator<ApiChatEvent>,
	signal: AbortSignal,
	onExternal: () => void,
): Promise<OpenAiReply> {
	let completion: ApiChatCompletion | undefined;
	let failure: { readonly message: string; readonly code: ApiErrorCode } | undefined;
	try {
		let next: IteratorResult<ApiChatEvent> = { done: false, value: first };
		while (next.done !== true) {
			const event = next.value;
			if (event.type === 'done') {
				completion = event.completion;
			} else if (event.type === 'error') {
				failure = { message: event.message, code: event.code };
			}
			if (completion !== undefined || failure !== undefined) {
				break;
			}
			next = await rest.next();
		}
	} finally {
		signal.removeEventListener('abort', onExternal);
		// Fecha o gerador: sem isto, um pedido juntado que abortou no meio
		// deixaria o `finally` do runtime sem rodar até o coletor ser descartado.
		await rest.return?.(undefined as never);
	}
	if (completion !== undefined) {
		return { status: 200, body: completionBody(completion) };
	}
	const code = failure?.code ?? 'upstream';
	return {
		status: statusFor(code),
		body: errorBody(code, failure?.message ?? 'o provedor terminou sem produzir resposta'),
	};
}

/** Um iterador que entrega o primeiro item já consumido e continua o resto. */
async function* prepend(
	first: ApiChatEvent,
	rest: AsyncIterator<ApiChatEvent>,
): AsyncGenerator<ApiChatEvent> {
	yield first;
	for (;;) {
		const next = await rest.next();
		if (next.done === true) {
			return;
		}
		yield next.value;
	}
}

/** O corpo de uma resposta não-streaming, no formato OpenAI. */
export function completionBody(completion: ApiChatCompletion): Record<string, unknown> {
	return {
		id: completion.id,
		object: 'chat.completion',
		created: Math.floor(Date.now() / 1000),
		model: completion.model,
		choices: [
			{
				index: 0,
				message: {
					role: 'assistant',
					content: completion.content,
					...(completion.reasoning !== undefined ? { reasoning_content: completion.reasoning } : {}),
				},
				finish_reason: finishReasonWire(completion.finishReason),
			},
		],
		...(completion.usage !== undefined ? { usage: usageBody(completion.usage) } : {}),
	};
}

/** O uso em nomes de fio, omitindo o desconhecido (nunca inventando zero). */
export function usageBody(usage: TokenUsage): Record<string, number> {
	return {
		...(usage.promptTokens !== undefined ? { prompt_tokens: usage.promptTokens } : {}),
		...(usage.completionTokens !== undefined ? { completion_tokens: usage.completionTokens } : {}),
		...(usage.totalTokens !== undefined ? { total_tokens: usage.totalTokens } : {}),
	};
}

function finishReasonWire(reason: FinishReason): string {
	return reason === 'cancelled' ? 'stop' : reason;
}

/**
 * O corpo de um `data:` do SSE.
 *
 * Os clientes OpenAI esperam `chat.completion.chunk`, com `finish_reason`
 * nulo até o último fragmento e `[DONE]` no fim — o `[DONE]` é escrito pelo
 * servidor, não por esta função.
 */
export function chunkBody(input: {
	readonly id: string;
	readonly model: string;
	readonly delta: Record<string, unknown>;
	readonly finishReason?: string;
	readonly usage?: TokenUsage;
}): Record<string, unknown> {
	return {
		id: input.id,
		object: 'chat.completion.chunk',
		created: Math.floor(Date.now() / 1000),
		model: input.model,
		choices: [
			{
				index: 0,
				delta: input.delta,
				finish_reason: input.finishReason ?? null,
			},
		],
		...(input.usage !== undefined ? { usage: usageBody(input.usage) } : {}),
	};
}

/** Escreve um erro JSON numa resposta já aberta. */
export function writeJsonError(response: ServerResponse, status: number, code: ApiErrorCode, message: string): void {
	const payload = `${JSON.stringify(errorBody(code, message))}\n`;
	response.writeHead(status, {
		...BASE_HEADERS,
		'Content-Type': 'application/json; charset=utf-8',
		'Content-Length': String(Buffer.byteLength(payload)),
	});
	response.end(payload);
}

/** Escreve uma resposta JSON de sucesso. */
export function writeJson(response: ServerResponse, status: number, body: unknown): void {
	const payload = `${JSON.stringify(body)}\n`;
	response.writeHead(status, {
		...BASE_HEADERS,
		'Content-Type': 'application/json; charset=utf-8',
		'Content-Length': String(Buffer.byteLength(payload)),
	});
	response.end(payload);
}

/** Abre o SSE e devolve o escritor de eventos. */
export function openStream(response: ServerResponse): {
	readonly write: (payload: Record<string, unknown>) => void;
	readonly writeRaw: (text: string) => void;
	readonly close: () => void;
} {
	response.writeHead(200, { ...BASE_HEADERS, ...SSE_HEADERS });
	let closed = false;
	return {
		write(payload) {
			if (closed) {
				return;
			}
			response.write(`data: ${JSON.stringify(payload)}\n\n`);
		},
		writeRaw(text) {
			if (closed) {
				return;
			}
			response.write(text);
		},
		close() {
			if (closed) {
				return;
			}
			closed = true;
			response.end();
		},
	};
}
