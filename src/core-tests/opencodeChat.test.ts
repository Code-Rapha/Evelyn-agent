/**
 * O adaptador de conversação do OpenCode — com continuidade de sessão.
 *
 * ## O que se prova, com um `fetch` simulado
 *
 * 1. **Seleção**: o modelo volta a ser `providerID`/`modelID`, e só é enviado
 *    se estiver no catálogo (e com catálogo atual);
 * 2. **Sessão reutilizada**: dois turnos no mesmo modelo usam a **mesma**
 *    sessão, criada uma vez;
 * 3. **Troca de modelo**: a sessão antiga não é reutilizada — uma nova é
 *    criada, com o modelo novo;
 * 4. **Isolamento**: sessão de outro adaptador/base não é reutilizada; evento
 *    de outra sessão não entra na resposta;
 * 5. **Streaming sem duplicação**: o texto vem dos deltas, ou do corpo da
 *    resposta, nunca dos dois; o texto do usuário nunca entra;
 * 6. **Cancelamento, timeout, 401, rede e sessão perdida**;
 * 7. **Sem reenvio**: um turno é **um** pedido; um resultado ambíguo não é
 *    reenviado;
 * 8. **Ciclo de vida**: `closeSession` só encerra sessão deste adaptador;
 * 9. **Sem vazamento**: senha não aparece em evento, erro nem log; nenhuma
 *    rota insegura é pedida.
 */
import * as assert from 'assert';

import { OpencodeChatAdapter, OpencodeChatError, parseOpencodeModelId, type OpencodeSession } from '../app/opencodeChat';
import type { ChatMessage, ChatStreamEvent } from '../core/providers/chat/types';

const PASSWORD = 'senha-que-nao-pode-vazar';
const SESSION_ID = 'ses_teste_1';
const MODEL = 'river/deepseek-ai/DeepSeek-V4.1-Flash';
const OTHER_MODEL = 'river/zai-org/GLM-5.3-Flash';

const MESSAGES: readonly ChatMessage[] = [{ role: 'user', content: 'Diga oi' }];

/** Um corpo SSE a partir de eventos. */
function sse(events: readonly Record<string, unknown>[]): string {
	return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
}

function partUpdated(sessionID: string, messageID: string, partID: string, text: string): Record<string, unknown> {
	return {
		type: 'message.part.updated',
		properties: { sessionID, part: { id: partID, messageID, sessionID, type: 'text', text } },
	};
}

function delta(sessionID: string, messageID: string, partID: string, text: string): Record<string, unknown> {
	return {
		type: 'message.part.delta',
		properties: { sessionID, messageID, partID, field: 'text', delta: text },
	};
}

function updatedInfo(
	sessionID: string,
	id: string,
	role: string,
	model?: { readonly providerID: string; readonly modelID: string },
): Record<string, unknown> {
	return { type: 'message.updated', properties: { sessionID, info: { id, role, ...(model ?? {}) } } };
}

function idle(sessionID: string): Record<string, unknown> {
	return { type: 'session.idle', properties: { sessionID } };
}

/** Um turno do assistente, como o `POST /session/{id}/message` devolve. */
function turnBody(options: {
	readonly text: string;
	readonly model?: string;
	readonly sessionID?: string;
	readonly parentID?: string;
}): string {
	const [providerID, ...rest] = (options.model ?? MODEL).split('/');
	const modelID = rest.join('/');
	const info: Record<string, unknown> = {
		role: 'assistant',
		...(options.sessionID !== undefined ? { sessionID: options.sessionID } : {}),
		...(options.parentID !== undefined ? { parentID: options.parentID } : {}),
		...(options.model !== undefined ? { providerID, modelID } : {}),
	};
	return JSON.stringify({
		info,
		parts: options.text.length > 0 ? [{ type: 'text', text: options.text }] : [{ type: 'step-start' }],
	});
}

/** O que o `fetch` simulado responde. */
interface Script {
	/** O stream de eventos. */
	events: string;
	/** Os eventos, quando dependem do id da sessão criada. */
	eventsFor?: (sessionId: string) => string;
	/** O corpo do turno (string JSON), um status de erro, ou um turno que não responde. */
	turn: { readonly status: number; readonly body: string } | 'network' | 'hold';
	/** A sonda da sessão: existe? */
	sessionAlive: boolean;
	/** A sessão criada, ou `401`/`500`. */
	create: 'ok' | '401' | '500';
	/** Segurar o `/event` aberto (cancelamento). */
	holdEvents?: boolean;
}

/** Um `fetch` simulado que responde por rota e guarda as chamadas. */
interface FakeFetch {
	readonly fetch: typeof fetch;
	readonly calls: Array<{ readonly url: string; readonly method: string; readonly body: string | undefined; readonly headers: Record<string, string> }>;
	script: Script;
	/** Quantas sessões foram criadas. */
	sessionsCreated: number;
	/** Quantas sessões existem "no servidor" (para provar o encerramento). */
	liveSessions: Set<string>;
	/** O que veio no `POST /session/{id}/abort`. */
	aborted: string[];
	/** As sessões removidas (`DELETE /api/session/{id}`). */
	deleted: string[];
	/** Quando o pedido do turno entrou (para o teste esperar antes de abortar). */
	turnRequested: boolean;
	/** Quantos chunks do /event foram enfileirados. */
	eventsLog: Set<string>;
}

/**
 * O corpo do turno responde na sessão em que foi enviado. O fake completa o
 * `sessionID` (o teste pode querer um diferente, e o dele vence).
 */
function withSession(body: string, sessionId: string): string {
	try {
		const parsed = JSON.parse(body) as { info?: Record<string, unknown> };
		if (parsed.info === undefined || parsed.info['sessionID'] !== undefined) {
			return body;
		}
		parsed.info['sessionID'] = sessionId;
		return JSON.stringify(parsed);
	} catch {
		return body;
	}
}

let fakePrefix = 1;

function fakeFetch(overrides: Partial<Script> = {}): FakeFetch {
	fakePrefix += 1;
	const prefix = fakePrefix;
	const calls: FakeFetch['calls'] = [];
	const fake: FakeFetch = {
		calls,
		sessionsCreated: 0,
		liveSessions: new Set<string>(),
		aborted: [],
		deleted: [],
		turnRequested: false,
		eventsLog: new Set(),
		script: {
			events: '',
			turn: { status: 200, body: turnBody({ text: 'oi' }) },
			sessionAlive: true,
			create: 'ok',
			...overrides,
		},
		fetch: (async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			const method = init?.method ?? 'GET';
			const headers = (init?.headers ?? {}) as Record<string, string>;
			calls.push({ url, method, body: init?.body === undefined ? undefined : String(init.body), headers });
			if (method === 'POST' && url.endsWith('/api/session')) {
				if (fake.script.create === '401') {
					return new Response('', { status: 401 });
				}
				if (fake.script.create === '500') {
					return new Response(JSON.stringify({ name: 'UnknownError' }), { status: 500 });
				}
				fake.sessionsCreated += 1;
				const id = `ses_teste_${prefix}_${fake.sessionsCreated}`;
				fake.liveSessions.add(id);
				const body = JSON.parse(String(init?.body)) as { model: { providerID: string; id: string } };
				return new Response(
					JSON.stringify({
						data: { id, model: { providerID: body.model.providerID, id: body.model.id, variant: 'default' } },
					}),
					{ status: 200 },
				);
			}
			if (method === 'GET' && /\/api\/session\/[^/]+$/.test(url)) {
				const id = url.split('/').pop() ?? '';
				if (!fake.script.sessionAlive || !fake.liveSessions.has(id)) {
					return new Response(JSON.stringify({ _tag: 'NotFound', sessionID: id, message: 'Session not found' }), {
						status: 404,
					});
				}
				return new Response(
					JSON.stringify({ data: { id, model: { providerID: 'river', id: 'deepseek-ai/DeepSeek-V4.1-Flash' } } }),
					{ status: 200 },
				);
			}
			if (method === 'DELETE' && /\/session\/[^/]+$/.test(url)) {
				const id = url.split('/').pop() ?? '';
				fake.deleted.push(id);
				fake.liveSessions.delete(id);
				return new Response('', { status: 200 });
			}
			if (method === 'POST' && url.includes('/abort')) {
				const id = url.split('/').slice(-2)[0] ?? '';
				fake.aborted.push(id);
				fake.liveSessions.delete(id);
				return new Response('', { status: 200 });
			}
			if (method === 'POST' && /\/session\/[^/]+\/message$/.test(url)) {
				fake.turnRequested = true;
				if (fake.script.turn === 'network') {
					throw new Error('connect ECONNREFUSED');
				}
				if (fake.script.turn === 'hold') {
					// Um turno que não responde: o cancelamento chega antes.
					return await new Promise<Response>((resolve, reject) => {
						if (init?.signal?.aborted === true) {
							reject(new DOMException('aborted', 'AbortError'));
							return;
						}
						init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
					});
				}
				const sessionId = url.split('/').slice(-2)[0] ?? '';
				return new Response(withSession(fake.script.turn.body, sessionId), { status: fake.script.turn.status });
			}
			if (url.endsWith('/event')) {
				const live = [...fake.liveSessions][0];
				const stream = fake.script.eventsFor !== undefined && live !== undefined ? fake.script.eventsFor(live) : fake.script.events;
				// O servidor mantém a conexão aberta. Os eventos já emitidos
				// entram **antes** de qualquer leitura e o stream fica aberto —
				// com `holdEvents`, para sempre (como o servidor real faz).
				const encoder = new TextEncoder();
				const body = new ReadableStream<Uint8Array>({
					start(controller) {
						const chunks = stream.match(/[\s\S]*?\n\n/g) ?? [];
						for (const chunk of chunks) {
							fake.eventsLog.add(chunk.slice(0, 40));
							controller.enqueue(encoder.encode(chunk));
						}
						if (fake.script.holdEvents !== true) {
							controller.close();
						}
					},
				});
				return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
			}
			return new Response('', { status: 404 });
		}) as typeof fetch,
	};
	return fake;
}

const createdAdapters: OpencodeChatAdapter[] = [];

function makeAdapter(
	fake: FakeFetch,
	options: {
		readonly catalog?: readonly { providerId: string; modelId: string }[];
		readonly catalogState?: 'ok' | 'stale';
		readonly connection?: { baseUrl: string; password: string } | undefined;
		readonly turnTimeoutMs?: number;
		readonly logs?: Array<Record<string, unknown>>;
	} = {},
): OpencodeChatAdapter {
	const adapter = new OpencodeChatAdapter({
		connection: () => ('connection' in options ? options.connection : { baseUrl: 'http://127.0.0.1:4096', password: PASSWORD }),
		catalog: async () => ({
			state: options.catalogState ?? 'ok',
			models: options.catalog ?? [
				{ providerId: 'river', modelId: 'deepseek-ai/DeepSeek-V4.1-Flash' },
				{ providerId: 'river', modelId: 'zai-org/GLM-5.3-Flash' },
			],
		}),
		fetch: fake.fetch,
		...(options.turnTimeoutMs !== undefined ? { turnTimeoutMs: options.turnTimeoutMs } : {}),
		log: (message, data) => options.logs?.push({ message, ...(data ?? {}) }),
	});
	createdAdapters.push(adapter);
	return adapter;
}

/** Coleta todos os eventos do stream. */
async function collect(stream: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
	const events: ChatStreamEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

function textOf(events: readonly ChatStreamEvent[]): string {
	return events
		.filter((event): event is Extract<ChatStreamEvent, { type: 'TextDelta' }> => event.type === 'TextDelta')
		.map((event) => event.text)
		.join('');
}

/** O `SessionStarted` que o adaptador publica no stream. */
function startedOf(stream: unknown): { readonly session: OpencodeSession; readonly origin: string } | undefined {
	return (stream as { readonly started?: { readonly session: OpencodeSession; readonly origin: string } }).started;
}

suite('OpenCode: o adaptador de conversação', () => {
	teardown(() => {
		for (const adapter of createdAdapters.splice(0)) {
			adapter.dispose();
		}
	});

	test('o id composto vira providerID + modelID, preservando o id original', () => {
		assert.deepStrictEqual(parseOpencodeModelId(MODEL), {
			providerID: 'river',
			modelID: 'deepseek-ai/DeepSeek-V4.1-Flash',
		});
		assert.deepStrictEqual(parseOpencodeModelId('openrouter/recursive/flint-v1.0:free'), {
			providerID: 'openrouter',
			modelID: 'recursive/flint-v1.0:free',
		});
		assert.strictEqual(parseOpencodeModelId('sem-barra'), undefined);
	});

	test('um modelo fora do catálogo é recusado antes de qualquer requisição', async () => {
		const fake = fakeFetch();
		const adapter = makeAdapter(fake);
		await assert.rejects(
			() => adapter.streamChat({ model: 'river/nao-existe', messages: MESSAGES }),
			(error: unknown) => error instanceof OpencodeChatError && error.code === 'model-not-in-catalog',
		);
		assert.strictEqual(fake.calls.length, 0);
	});

	test('catálogo desatualizado recusa antes de qualquer requisição', async () => {
		const fake = fakeFetch();
		const adapter = makeAdapter(fake, { catalogState: 'stale' });
		await assert.rejects(
			() => adapter.streamChat({ model: MODEL, messages: MESSAGES }),
			(error: unknown) => error instanceof OpencodeChatError && error.code === 'model-not-in-catalog',
		);
		assert.strictEqual(fake.calls.length, 0);
	});

	test('sem conexão, recusa sem consultar nada', async () => {
		const fake = fakeFetch();
		const adapter = makeAdapter(fake, { connection: undefined });
		await assert.rejects(
			() => adapter.streamChat({ model: MODEL, messages: MESSAGES }),
			(error: unknown) => error instanceof OpencodeChatError && error.code === 'no-connection',
		);
		assert.strictEqual(fake.calls.length, 0);
	});

	test('a sessão é criada com o modelo, e o turno usa os ids originais', async () => {
		const fake = fakeFetch();
		const adapter = makeAdapter(fake);

		const stream = await adapter.streamChat({ model: MODEL, messages: MESSAGES });
		await collect(stream);

		const sessionCall = fake.calls.find((call) => call.method === 'POST' && call.url.endsWith('/api/session'));
		assert.ok(sessionCall !== undefined);
		const body = JSON.parse(String(sessionCall.body)) as { model: { providerID: string; id: string } };
		assert.deepStrictEqual(body.model, { providerID: 'river', id: 'deepseek-ai/DeepSeek-V4.1-Flash' });

		const turn = fake.calls.find((call) => call.method === 'POST' && /\/session\/[^/]+\/message$/.test(call.url));
		assert.ok(turn !== undefined);
		const turnBodySent = JSON.parse(String(turn.body)) as { parts: Array<{ type: string; text: string }> };
		assert.deepStrictEqual(turnBodySent.parts, [{ type: 'text', text: 'Diga oi' }]);
		// A mensagem nova vai sozinha: o servidor é a memória da conversa.
		assert.ok(!('model' in turnBodySent), 'o modelo é o da sessão');
	});

	test('dois turnos no mesmo modelo usam a MESMA sessão, criada uma vez', async () => {
		const fake = fakeFetch();
		const adapter = makeAdapter(fake);

		const first = await adapter.streamChat({ model: MODEL, messages: MESSAGES });
		await collect(first);
		const firstSession = startedOf(first)?.session;
		assert.ok(firstSession !== undefined);
		assert.strictEqual(startedOf(first)?.origin, 'new');

		const second = await adapter.streamChat({ model: MODEL, messages: MESSAGES }, { session: firstSession });
		await collect(second);
		const secondSession = startedOf(second)?.session;

		assert.strictEqual(secondSession?.id, firstSession.id, 'a mesma sessão');
		assert.strictEqual(fake.sessionsCreated, 1, 'uma sessão só foi criada');
		assert.strictEqual(startedOf(second)?.origin, 'reused-unverified');
		// O segundo turno enviou a mensagem para a mesma sessão.
		const turns = fake.calls.filter((call) => call.method === 'POST' && /\/session\/[^/]+\/message$/.test(call.url));
		assert.strictEqual(turns.length, 2);
		assert.ok(turns.every((call) => call.url.includes(firstSession.id)));
	});

	test('trocar de modelo cria uma sessão nova, compatível com o novo modelo', async () => {
		const fake = fakeFetch();
		const adapter = makeAdapter(fake);
		const first = await adapter.streamChat({ model: MODEL, messages: MESSAGES });
		await collect(first);
		const firstSession = startedOf(first)?.session;
		assert.ok(firstSession !== undefined);

		// O modelo antigo numa sessão nova: o adaptador não aceita a sessão.
		const second = await adapter.streamChat({ model: OTHER_MODEL, messages: MESSAGES }, { session: firstSession });
		await collect(second);
		const secondSession = startedOf(second)?.session;

		assert.notStrictEqual(secondSession?.id, firstSession.id);
		assert.strictEqual(fake.sessionsCreated, 2);
		assert.strictEqual(secondSession?.model.modelID, 'zai-org/GLM-5.3-Flash');
		// A sessão antiga não foi encerrada pelo adaptador (quem troca o modelo
		// a encerra: o controller); mas a nova foi criada com o modelo novo.
		const created = fake.calls.filter((call) => call.method === 'POST' && call.url.endsWith('/api/session'));
		const lastBody = JSON.parse(String(created[1]?.body)) as { model: { providerID: string; id: string } };
		assert.deepStrictEqual(lastBody.model, { providerID: 'river', id: 'zai-org/GLM-5.3-Flash' });
	});

	test('sessão de outro adaptador não é reutilizada', async () => {
		const firstFake = fakeFetch();
		const firstAdapter = makeAdapter(firstFake);
		const first = await firstAdapter.streamChat({ model: MODEL, messages: MESSAGES });
		await collect(first);
		const foreignSession = startedOf(first)?.session;
		assert.ok(foreignSession !== undefined);

		const secondFake = fakeFetch();
		const secondAdapter = makeAdapter(secondFake);
		const second = await secondAdapter.streamChat({ model: MODEL, messages: MESSAGES }, { session: foreignSession });
		await collect(second);

		assert.notStrictEqual(startedOf(second)?.session.id, foreignSession.id);
		assert.strictEqual(secondFake.sessionsCreated, 1, 'o segundo adaptador abriu a sua');
	});

	test('sessão de outra base não é reutilizada', async () => {
		const fake = fakeFetch();
		const adapter = makeAdapter(fake);
		const first = await adapter.streamChat({ model: MODEL, messages: MESSAGES });
		await collect(first);
		const moved = { ...(startedOf(first)?.session as OpencodeSession), baseUrl: 'http://127.0.0.1:9999' };
		const second = await adapter.streamChat({ model: MODEL, messages: MESSAGES }, { session: moved });
		await collect(second);
		assert.notStrictEqual(startedOf(second)?.session.id, moved.id);
		assert.strictEqual(fake.sessionsCreated, 2);
	});

	test('servidor reiniciado: a sessão não existe mais, e uma nova é aberta', async () => {
		const fake = fakeFetch();
		const adapter = makeAdapter(fake);
		const first = await adapter.streamChat({ model: MODEL, messages: MESSAGES });
		await collect(first);
		const session = startedOf(first)?.session;
		assert.ok(session !== undefined);

		// O servidor reiniciou e perdeu a sessão.
		fake.script.sessionAlive = false;
		const second = await adapter.streamChat({ model: MODEL, messages: MESSAGES }, { session });
		await collect(second);

		assert.strictEqual(startedOf(second)?.origin, 'new');
		assert.notStrictEqual(startedOf(second)?.session.id, session.id);
		assert.strictEqual(fake.sessionsCreated, 2);
	});

	test('streaming incremental sem duplicação, e o texto do usuário não entra', async () => {
		const fake = fakeFetch({
			events: sse([
				updatedInfo(SESSION_ID, 'msg_user', 'user'),
				partUpdated(SESSION_ID, 'msg_user', 'prt_user', 'Diga oi'),
				updatedInfo(SESSION_ID, 'msg_a', 'assistant'),
				delta(SESSION_ID, 'msg_a', 'prt_a', 'Oi'),
				delta(SESSION_ID, 'msg_a', 'prt_a', ', '),
				delta(SESSION_ID, 'msg_a', 'prt_a', 'tudo'),
				partUpdated(SESSION_ID, 'msg_a', 'prt_a', 'Oi, tudo'),
				delta(SESSION_ID, 'msg_a', 'prt_a', ' bem?'),
				idle(SESSION_ID),
			]),
			turn: { status: 200, body: turnBody({ text: 'Oi, tudo bem?', model: MODEL }) },
		});
		const adapter = makeAdapter(fake);
		const stream = await adapter.streamChat({ model: MODEL, messages: MESSAGES });
		const events = await collect(stream);

		assert.strictEqual(textOf(events), 'Oi, tudo bem?', 'o texto entra uma vez só, e o do usuário nunca');
		assert.strictEqual(events.filter((event) => event.type === 'Done').length, 1);
		assert.ok(!events.some((event) => event.type === 'Error'));
		assert.strictEqual(stream.closedReason, 'completed');
		assert.strictEqual(stream.respondedModel, MODEL);
	});

	test('sem deltas, o texto vem do corpo da resposta, uma vez', async () => {
		const fake = fakeFetch({
			events: sse([updatedInfo(SESSION_ID, 'msg_a', 'assistant'), idle(SESSION_ID)]),
			turn: { status: 200, body: turnBody({ text: 'Resposta única' }) },
		});
		const adapter = makeAdapter(fake);
		const events = await collect(await adapter.streamChat({ model: MODEL, messages: MESSAGES }));
		assert.strictEqual(textOf(events), 'Resposta única');
	});

	test('resposta vazia: o turno termina sem texto e com Done', async () => {
		const fake = fakeFetch({
			events: sse([updatedInfo(SESSION_ID, 'msg_a', 'assistant'), idle(SESSION_ID)]),
			turn: { status: 200, body: turnBody({ text: '' }) },
		});
		const adapter = makeAdapter(fake);
		const events = await collect(await adapter.streamChat({ model: MODEL, messages: MESSAGES }));
		assert.strictEqual(textOf(events), '');
		assert.strictEqual(events.filter((event) => event.type === 'Done').length, 1);
	});

	test('evento de outra sessão não entra na resposta', async () => {
		const fake = fakeFetch({
			events: sse([
				updatedInfo(SESSION_ID, 'msg_a', 'assistant'),
				delta('ses_outra', 'msg_x', 'prt_x', 'INTROMETIDO'),
				delta(SESSION_ID, 'msg_a', 'prt_a', 'certo'),
				idle('ses_outra'),
				idle(SESSION_ID),
			]),
			turn: { status: 200, body: turnBody({ text: 'certo' }) },
		});
		const adapter = makeAdapter(fake);
		const events = await collect(await adapter.streamChat({ model: MODEL, messages: MESSAGES }));
		assert.strictEqual(textOf(events), 'certo');
	});

	test('uma resposta de outra sessão é "sessão perdida"', async () => {
		const fake = fakeFetch({
			events: sse([]),
			turn: { status: 200, body: turnBody({ text: 'x', sessionID: 'ses_outra' }) },
		});
		const adapter = makeAdapter(fake);
		const events = await collect(await adapter.streamChat({ model: MODEL, messages: MESSAGES }));
		const error = events.find((event) => event.type === 'Error');
		assert.ok(error !== undefined && error.type === 'Error');
		if (error !== undefined && error.type === 'Error') {
			assert.ok(error.error instanceof OpencodeChatError);
			assert.strictEqual((error.error as OpencodeChatError).code, 'session-lost');
		}
	});

	test('uma resposta sem parentID conhecido não é recusada por suposição', async () => {
		// Sem o id da mensagem do usuário no stream, não há como comparar o
		// pai: o adaptador não inventa "sessão perdida" — usa a sessão da
		// resposta, que é a única evidência que tem.
		const fake = fakeFetch({
			events: sse([updatedInfo(SESSION_ID, 'msg_a', 'assistant'), delta(SESSION_ID, 'msg_a', 'prt_a', 'parcial'), idle(SESSION_ID)]),
			turn: { status: 200, body: turnBody({ text: 'parcial', parentID: 'msg_qualquer' }) },
		});
		const adapter = makeAdapter(fake);
		const events = await collect(await adapter.streamChat({ model: MODEL, messages: MESSAGES }));
		assert.strictEqual(textOf(events), 'parcial');
		assert.ok(!events.some((event) => event.type === 'Error'));
	});
;

		test('cancelamento: o stream fecha sem Done e sem Error, e o texto que chegou fica', async () => {
		const fake = fakeFetch({
			holdEvents: true,
			// Os eventos usam o id da sessão que o fake criar: pedidos na
			// hora da leitura, não antes.
			eventsFor: (sessionId) =>
				sse([
					updatedInfo(sessionId, 'msg_user', 'user'),
					updatedInfo(sessionId, 'msg_a', 'assistant'),
					delta(sessionId, 'msg_a', 'prt_a', 'começo'),
				]),
			turn: 'hold',
		});
		const adapter = makeAdapter(fake, { turnTimeoutMs: 60_000 });
		const controller = new AbortController();
		const stream = await adapter.streamChat({ model: MODEL, messages: MESSAGES }, { signal: controller.signal });

		const received: ChatStreamEvent[] = [];
		for await (const event of stream) {
			received.push(event);
			if (event.type === 'TextDelta') {
				await new Promise((resolve) => setTimeout(resolve, 50));
				controller.abort();
			}
		}
		assert.strictEqual(textOf(received), 'começo', 'o que chegou fica');
		assert.ok(!received.some((event) => event.type === 'Done' || event.type === 'Error'));
		assert.strictEqual(stream.closedReason, 'aborted');
	});

	test('timeout: o turno termina com Error de prazo, sem esperar o stream', async () => {
		// O turno não responde e os eventos ficam abertos: tudo que existe é o
		// prazo — e o texto/desfecho não pode depender do servidor para acabar.
		const fake = fakeFetch({
			holdEvents: true,
			events: sse([]),
			turn: 'hold',
		});
		const adapter = makeAdapter(fake, { turnTimeoutMs: 120 });
		const events = await collect(await adapter.streamChat({ model: MODEL, messages: MESSAGES }));
		const error = events.find((event) => event.type === 'Error');
		assert.ok(error !== undefined && error.type === 'Error');
		if (error !== undefined && error.type === 'Error') {
			assert.strictEqual((error.error as OpencodeChatError).code, 'timeout');
		}
		assert.ok(!events.some((event) => event.type === 'Done'));
	});
;

	test('401 ao abrir a sessão vira Error com o código "auth"', async () => {
		const fake = fakeFetch({ create: '401' });
		const adapter = makeAdapter(fake);
		const events = await collect(await adapter.streamChat({ model: MODEL, messages: MESSAGES }));
		const error = events.find((event) => event.type === 'Error');
		assert.ok(error !== undefined && error.type === 'Error');
		if (error !== undefined && error.type === 'Error') {
			assert.strictEqual((error.error as OpencodeChatError).code, 'auth');
			assert.ok(!error.error.message.includes(PASSWORD));
		}
	});

	test('falha de rede no turno vira Error, sem vazar cabeçalho', async () => {
		const fake = fakeFetch({ turn: 'network' });
		const logs: Array<Record<string, unknown>> = [];
		const adapter = makeAdapter(fake, { logs });
		const events = await collect(await adapter.streamChat({ model: MODEL, messages: MESSAGES }));
		const error = events.find((event) => event.type === 'Error');
		assert.ok(error !== undefined && error.type === 'Error');
		if (error !== undefined && error.type === 'Error') {
			assert.ok(/falha de rede/.test(error.error.message), error.error.message);
			assert.ok(!error.error.message.includes(PASSWORD));
			assert.ok(!error.error.message.includes('Basic '));
		}
		for (const entry of logs) {
			assert.ok(!JSON.stringify(entry).includes(PASSWORD));
		}
	});

	test('um turno é UM pedido: nada é reenviado', async () => {
		const fake = fakeFetch({ turn: { status: 500, body: JSON.stringify({ name: 'UnknownError' }) } });
		const adapter = makeAdapter(fake);
		await collect(await adapter.streamChat({ model: MODEL, messages: MESSAGES }));
		const turns = fake.calls.filter((call) => call.method === 'POST' && /\/session\/[^/]+\/message$/.test(call.url));
		assert.strictEqual(turns.length, 1, 'sem retentativa automática');
	});

	test('um envio aceito com corpo inesperado é "ambíguo", e não é reenviado', async () => {
		const fake = fakeFetch({ turn: { status: 200, body: JSON.stringify({ ok: true }) } });
		const adapter = makeAdapter(fake);
		const events = await collect(await adapter.streamChat({ model: MODEL, messages: MESSAGES }));
		const error = events.find((event) => event.type === 'Error');
		assert.ok(error !== undefined && error.type === 'Error');
		if (error !== undefined && error.type === 'Error') {
			assert.strictEqual((error.error as OpencodeChatError).code, 'ambiguous');
			assert.ok(/não reenvie/.test(error.error.message));
		}
		const turns = fake.calls.filter((call) => call.method === 'POST' && /\/session\/[^/]+\/message$/.test(call.url));
		assert.strictEqual(turns.length, 1);
	});

	test('closeSession encerra só a sessão deste adaptador', async () => {
		const fake = fakeFetch();
		const adapter = makeAdapter(fake);
		const stream = await adapter.streamChat({ model: MODEL, messages: MESSAGES });
		await collect(stream);
		const session = startedOf(stream)?.session;
		assert.ok(session !== undefined);

		assert.strictEqual(await adapter.closeSession(session), true);
		assert.deepStrictEqual(fake.aborted, [session.id], 'o turno é interrompido');
		assert.deepStrictEqual(fake.deleted, [session.id], 'a sessão é removida do servidor');
		assert.deepStrictEqual(adapter.activeSessions, []);
		// De novo: não é mais deste adaptador.
		assert.strictEqual(await adapter.closeSession(session), false);
		// E uma sessão que ele nunca abriu nunca é tocada.
		const foreign: OpencodeSession = { id: 'ses_manual_do_usuario', model: session.model, baseUrl: session.baseUrl };
		assert.strictEqual(await adapter.closeSession(foreign), false);
		assert.deepStrictEqual(fake.aborted, [session.id], 'nenhum pedido para a sessão alheia');
		assert.deepStrictEqual(fake.deleted, [session.id], 'nenhuma remoção da sessão alheia');
	});

	test('dispose encerra as sessões que o adaptador abriu', async () => {
		const fake = fakeFetch();
		const adapter = makeAdapter(fake);
		const stream = await adapter.streamChat({ model: MODEL, messages: MESSAGES });
		await collect(stream);
		const session = startedOf(stream)?.session;
		adapter.dispose();
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.deepStrictEqual(fake.aborted, [session?.id]);
		assert.deepStrictEqual(fake.deleted, [session?.id], 'o host que fecha não deixa sessão no servidor');
	});

	test('só as rotas nativas são pedidas — nunca /provider nem /config/providers', async () => {
		const fake = fakeFetch();
		const adapter = makeAdapter(fake);
		const first = await adapter.streamChat({ model: MODEL, messages: MESSAGES });
		await collect(first);
		await collect(await adapter.streamChat({ model: MODEL, messages: MESSAGES }, { session: startedOf(first)?.session }));

		const allowed = [
			/^http:\/\/127\.0\.0\.1:4096\/api\/session$/,
			/^http:\/\/127\.0\.0\.1:4096\/api\/session\/[^/]+$/,
			/^http:\/\/127\.0\.0\.1:4096\/session\/[^/]+\/message$/,
			/^http:\/\/127\.0\.0\.1:4096\/session\/[^/]+\/abort$/,
			/^http:\/\/127\.0\.0\.1:4096\/event$/,
		];
		for (const call of fake.calls) {
			assert.ok(allowed.some((pattern) => pattern.test(call.url)), `rota inesperada: ${call.url}`);
			assert.ok(!/\/(config\/providers|api\/provider|provider)$/.test(call.url));
		}
	});

	test('a senha vai no cabeçalho e não aparece em evento nem no stream', async () => {
		const fake = fakeFetch();
		const adapter = makeAdapter(fake);
		const stream = await adapter.streamChat({ model: MODEL, messages: MESSAGES });
		await collect(stream);
		for (const call of fake.calls) {
			assert.strictEqual(
				call.headers['authorization'],
				`Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}`,
			);
		}
		assert.ok(!JSON.stringify({ started: startedOf(stream), model: stream.respondedModel }).includes(PASSWORD));
	});
});
