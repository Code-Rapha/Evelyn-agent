/**
 * R2: a camada de execução por requisição.
 *
 * ## O que estes testes provam
 *
 * Não que "o código compila", mas que duas requisições concorrentes são
 * independentes de fato: respostas distintas, cancelamento de uma sem tocar
 * na outra, e nenhum evento de uma aparecendo na outra.
 *
 * O provedor é falso (scripted `fetch` não é usado aqui; é um `ChatProvider`
 * injetado), porque o que está sob teste é a camada por requisição, não o
 * transporte. O teste de integração com o motor real está em
 * `webOpenAiIntegration.test.ts`.
 */
import * as assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	ApiChatError,
	ApiChatRuntime,
	parseModelId,
	type ApiChatEvent,
	type ApiRouteCandidate,
} from '../web/apiChat';
import type { ChatProvider, ChatRequest, ChatStream, ChatStreamEvent } from '../core/providers/chat/types';
import { CircuitBreaker } from '../core/providers/routing/breaker';
import { DEFAULT_ROUTE_POLICY } from '../desktop/chatSession';
import { FileDataStore } from '../adapters/local/fileDataStore';
import { DEFAULT_ACCESS_POLICY } from '../core/catalog/policy';

const roots: string[] = [];

async function makeStore(): Promise<FileDataStore> {
	const root = await mkdtemp(join(tmpdir(), 'evelyn-v1-'));
	roots.push(root);
	return new FileDataStore({ rootPath: root });
}

teardown(async () => {
	for (const root of roots.splice(0)) {
		await rm(root, { recursive: true, force: true }).catch(() => undefined);
	}
});

/** Um stream de eventos já decididos, com `closedReason` controlável. */
function scriptedStream(
	events: readonly ChatStreamEvent[],
	options: {
		readonly closedReason?: ChatStream['closedReason'];
		readonly respondedModel?: string;
		/** Espera entre eventos, para o cancelamento ter onde acontecer. */
		readonly gate?: Promise<void>;
	} = {},
): ChatStream {
	let closed: ChatStream['closedReason'] = options.closedReason ?? 'completed';
	const stream: ChatStream = {
		get closedReason() {
			return closed;
		},
		timing: {},
		...(options.respondedModel !== undefined ? { respondedModel: options.respondedModel } : {}),
		[Symbol.asyncIterator]: async function* () {
			try {
				for (const event of events) {
					if (options.gate !== undefined) {
						await options.gate;
					}
					yield event;
				}
			} catch {
				closed = 'aborted';
				throw new Error('abort');
			}
		},
	};
	return stream;
}

/** Um provedor que responde com o script da sua chave. */
function scriptedProvider(scripts: Map<string, () => ChatStream>): ChatProvider {
	return {
		async streamChat(request: ChatRequest): Promise<ChatStream> {
			const script = scripts.get(request.model);
			if (script === undefined) {
				throw new Error(`sem script para ${request.model}`);
			}
			return script();
		},
	};
}

/** A camada, com portas mínimas e um provedor falso. */
function runtimeWith(options: {
	readonly store: FileDataStore;
	readonly scripts: Map<string, () => ChatStream>;
	readonly candidates?: (requested: ApiRouteCandidate) => readonly ApiRouteCandidate[];
	readonly breaker?: CircuitBreaker;
}): ApiChatRuntime {
	return new ApiChatRuntime({
		providerFor: () => scriptedProvider(options.scripts),
		candidatesFor: async ({ requested }) => options.candidates?.(requested) ?? [requested],
		policy: DEFAULT_ROUTE_POLICY,
		breaker: options.breaker ?? new CircuitBreaker(() => DEFAULT_ROUTE_POLICY.breaker),
		ledger: options.store,
		store: options.store,
		pricing: async () => undefined,
		accessPolicy: async () => DEFAULT_ACCESS_POLICY,
	});
}

/** Junta todos os eventos de uma execução. */
async function drain(events: AsyncIterable<ApiChatEvent>): Promise<ApiChatEvent[]> {
	const seen: ApiChatEvent[] = [];
	for await (const event of events) {
		seen.push(event);
	}
	return seen;
}

/** O texto entregue por uma execução, concatenado. */
function textOf(events: readonly ApiChatEvent[]): string {
	return events
		.map((event) => (event.type === 'delta' ? event.text : ''))
		.join('');
}

suite('R2: uma requisição por execução', () => {
	test('uma requisição simples entrega texto e um done com o conteúdo', async () => {
		const store = await makeStore();
		const runtime = runtimeWith({
			store,
			scripts: new Map([
				[
					'm1',
					() =>
						scriptedStream([
							{ type: 'TextDelta', text: 'olá' },
							{ type: 'TextDelta', text: ' mundo' },
							{ type: 'Done', finishReason: 'stop' },
						]),
				],
			]),
		});

		const events = await drain(
			runtime.execute({
				model: 'p/m1',
				messages: [{ role: 'user', content: 'oi' }],
				stream: false,
				signal: new AbortController().signal,
			}),
		);

		assert.equal(textOf(events), 'olá mundo');
		const done = events.find((event) => event.type === 'done');
		assert.ok(done !== undefined && done.type === 'done');
		assert.equal(done.completion.content, 'olá mundo');
		assert.equal(done.completion.finishReason, 'stop');
		assert.equal(done.completion.model, 'm1');
	});

	test('duas requisições simultâneas recebem respostas distintas', async () => {
		const store = await makeStore();
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const runtime = runtimeWith({
			store,
			scripts: new Map([
				['a', () => scriptedStream([{ type: 'TextDelta', text: 'resposta-A' }, { type: 'Done' }], { gate })],
				['b', () => scriptedStream([{ type: 'TextDelta', text: 'resposta-B' }, { type: 'Done' }], { gate })],
			]),
		});

		const first = drain(
			runtime.execute({
				model: 'p/a',
				messages: [{ role: 'user', content: 'um' }],
				stream: false,
				signal: new AbortController().signal,
			}),
		);
		const second = drain(
			runtime.execute({
				model: 'p/b',
				messages: [{ role: 'user', content: 'dois' }],
				stream: false,
				signal: new AbortController().signal,
			}),
		);
		// As duas estão vivas ao mesmo tempo: se houvesse um slot global, a
		// segunda teria sido recusada antes daqui.
		await new Promise((resolve) => setTimeout(resolve, 10));
		release?.();

		const [a, b] = await Promise.all([first, second]);

		assert.equal(textOf(a), 'resposta-A');
		assert.equal(textOf(b), 'resposta-B');
	});

	test('cancelar uma não afeta a outra', async () => {
		const store = await makeStore();
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const runtime = runtimeWith({
			store,
			scripts: new Map([
				['a', () => scriptedStream([{ type: 'TextDelta', text: 'A1' }, { type: 'TextDelta', text: 'A2' }, { type: 'Done' }], { gate })],
				['b', () => scriptedStream([{ type: 'TextDelta', text: 'B1' }, { type: 'TextDelta', text: 'B2' }, { type: 'Done' }], { gate })],
			]),
		});
		const cancelA = new AbortController();

		const a = drain(
			runtime.execute({
				model: 'p/a',
				messages: [{ role: 'user', content: 'a' }],
				stream: true,
				signal: cancelA.signal,
			}),
		);
		const b = drain(
			runtime.execute({
				model: 'p/b',
				messages: [{ role: 'user', content: 'b' }],
				stream: true,
				signal: new AbortController().signal,
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 5));
		cancelA.abort();
		release?.();

		const [eventsA, eventsB] = await Promise.all([a, b]);

		const errorA = eventsA.find((event) => event.type === 'error');
		assert.ok(errorA !== undefined && errorA.type === 'error');
		assert.equal(errorA.code, 'cancelled');
		assert.equal(eventsA.some((event) => event.type === 'done'), false);
		// A outra terminou normalmente.
		assert.equal(eventsB.some((event) => event.type === 'done'), true);
		assert.equal(eventsB.some((event) => event.type === 'error'), false);
	});

	test('os eventos de um stream nunca aparecem em outro', async () => {
		const store = await makeStore();
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const runtime = runtimeWith({
			store,
			scripts: new Map([
				[
					'a',
					() =>
						scriptedStream(
							[
								{ type: 'TextDelta', text: 'um-' },
								{ type: 'TextDelta', text: 'dois-' },
								{ type: 'TextDelta', text: 'tres' },
								{ type: 'Done' },
							],
							{ gate },
						),
				],
				[
					'b',
					() =>
						scriptedStream(
							[
								{ type: 'TextDelta', text: 'alpha-' },
								{ type: 'TextDelta', text: 'beta' },
								{ type: 'Done' },
							],
							{ gate },
						),
				],
			]),
		});

		const runs = ['a', 'b', 'a', 'b', 'a'].map((model) =>
			drain(
				runtime.execute({
					model: `p/${model}`,
					messages: [{ role: 'user', content: model }],
					stream: true,
					signal: new AbortController().signal,
				}),
			),
		);
		await new Promise((resolve) => setTimeout(resolve, 10));
		release?.();
		const results = await Promise.all(runs);

		for (const [index, events] of results.entries()) {
			const expected = index % 2 === 0 ? 'um-dois-tres' : 'alpha-beta';
			assert.equal(textOf(events), expected, `a execução ${index} vazou texto`);
		}
	});

	test('um erro do provedor vira um evento de erro, sem derrubar o stream', async () => {
		const store = await makeStore();
		const runtime = runtimeWith({
			store,
			scripts: new Map([
				['m', () => scriptedStream([{ type: 'Error', error: new Error('o provedor recusou') }])],
			]),
		});

		const events = await drain(
			runtime.execute({
				model: 'p/m',
				messages: [{ role: 'user', content: 'x' }],
				stream: false,
				signal: new AbortController().signal,
			}),
		);

		const error = events.find((event) => event.type === 'error');
		assert.ok(error !== undefined && error.type === 'error');
		assert.match(error.message, /recusou/);
		assert.equal(events.some((event) => event.type === 'done'), false);
	});

	test('nenhum modelo utilizável é um erro classificado, não uma resposta vazia', async () => {
		const store = await makeStore();
		const runtime = runtimeWith({
			store,
			scripts: new Map(),
			candidates: () => [],
		});

		await assert.rejects(
			() =>
				drain(
					runtime.execute({
						model: 'p/fora-do-catalogo',
						messages: [{ role: 'user', content: 'x' }],
						stream: false,
						signal: new AbortController().signal,
					}),
				),
			(error: unknown) => error instanceof ApiChatError && error.code === 'no_candidate',
		);
	});

	test('um pedido sem mensagens é recusado', async () => {
		const store = await makeStore();
		const runtime = runtimeWith({ store, scripts: new Map() });

		await assert.rejects(
			() =>
				drain(
					runtime.execute({
						model: 'p/m',
						messages: [],
						stream: false,
						signal: new AbortController().signal,
					}),
				),
			(error: unknown) => error instanceof ApiChatError && error.code === 'bad_request',
		);
	});

	test('um modelo sem provedor é recusado antes de qualquer chamada', async () => {
		const store = await makeStore();
		const runtime = runtimeWith({ store, scripts: new Map() });

		await assert.rejects(
			() =>
				drain(
					runtime.execute({
						model: 'sem-barra',
						messages: [{ role: 'user', content: 'x' }],
						stream: false,
						signal: new AbortController().signal,
					}),
				),
			(error: unknown) => error instanceof ApiChatError && error.code === 'bad_request',
		);
	});

	test('parseModelId guarda o provedor e o modelo, inclusive com barras no modelo', () => {
		assert.deepEqual(parseModelId('river/deepseek-ai/DeepSeek-V4.1-Flash'), {
			providerId: 'river',
			modelId: 'deepseek-ai/DeepSeek-V4.1-Flash',
		});
		assert.equal(parseModelId('sem-barra'), undefined);
		assert.equal(parseModelId('/modelo'), undefined);
		assert.equal(parseModelId(''), undefined);
	});

	test('o consumo é gravado por requisição, na conversa criada para ela', async () => {
		const store = await makeStore();
		const runtime = runtimeWith({
			store,
			scripts: new Map([
				[
					'p/m',
					() =>
						scriptedStream([
							{ type: 'TextDelta', text: 'ok' },
							{ type: 'Usage', usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } },
							{ type: 'Done' },
						]),
				],
			]),
		});

		await drain(
			runtime.execute({
				model: 'p/m',
				messages: [{ role: 'user', content: 'x' }],
				stream: false,
				signal: new AbortController().signal,
			}),
		);

		const executions = await store.listConsumption({});
		assert.equal(executions.length, 1);
		// O id é da API, nunca o de uma sessão de chat.
		assert.match(executions[0].conversationId ?? '', /^api_/);
	});

	test('o breaker é compartilhado: uma falha numa requisição conta para a próxima', async () => {
		const store = await makeStore();
		let calls = 0;
		const breaker = new CircuitBreaker(
			() => ({ failureThreshold: 2, windowMs: 60_000, openMs: 60_000, halfOpenProbes: 1 }),
		);
		const runtime = new ApiChatRuntime({
			providerFor: () => ({
				async streamChat(): Promise<ChatStream> {
					calls += 1;
					// Um 503 é `unavailable`: a classe que abre o circuito.
					throw Object.assign(new Error('indisponível'), { errorClass: 'unavailable', httpStatus: 503 });
				},
			}),
			candidatesFor: async ({ requested }) => [requested],
			policy: { ...DEFAULT_ROUTE_POLICY, retries: 0 },
			breaker,
			ledger: store,
			store,
			pricing: async () => undefined,
			accessPolicy: async () => DEFAULT_ACCESS_POLICY,
		});

		const call = async (): Promise<void> => {
			try {
				await drain(
					runtime.execute({
						model: 'p/m',
						messages: [{ role: 'user', content: 'x' }],
						stream: false,
						signal: new AbortController().signal,
					}),
				);
			} catch {
				// Cada requisição falha; o que importa é quantas chegaram ao provedor.
			}
		};
		await call();
		await call();
		const callsBeforeOpen = calls;
		await call();

		assert.equal(calls, callsBeforeOpen, 'com o circuito aberto, a terceira não chega ao provedor');
	});
});
