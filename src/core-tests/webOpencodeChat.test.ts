/**
 * A conversa do OpenCode pela interface web.
 *
 * ## O que se prova
 *
 * 1. **Só com conexão e catálogo atual**: sem conexão, sem catálogo ou com o
 *    catálogo marcado como desatualizado, a escolha é recusada com o motivo;
 * 2. **Seleção explícita**: só um id que está no catálogo é aceito; um id
 *    inexistente é recusado;
 * 3. **O envio leva o modelo** e devolve um stream SSE com `started`, os
 *    `delta` e um `done`;
 * 4. **Uma conversa por vez**: o mesmo histórico de mensagens, o turno em
 *    curso e o `stop`;
 * 5. **Campos proibidos** (url, rota, cabeçalho) são recusados;
 * 6. **A senha não aparece** em nenhum evento nem no histórico.
 *
 * A rede é substituída: nenhum socket é aberto.
 */
import * as assert from 'assert';

import { OpencodeChatController } from '../web/opencodeChat';
import type { OpencodeCatalogService, OpencodeCatalogState } from '../app/opencodeCatalogService';
import type { OpencodeManager } from '../app/opencodeManager';

const PASSWORD = 'senha-que-nao-pode-vazar';
const MODEL = 'river/deepseek-ai/DeepSeek-V4.1-Flash';

/** Um catálogo com dois modelos. */
function catalogState(state: 'ok' | 'stale' = 'ok'): OpencodeCatalogState {
	return {
		state,
		catalog: {
			version: 1,
			discoveredAt: '2026-10-23T12:00:00.000Z',
			providers: [{ id: 'river', modelCount: 2, connected: true }],
			models: [
				{ providerId: 'river', modelId: 'deepseek-ai/DeepSeek-V4.1-Flash', status: 'active' },
				{ providerId: 'river', modelId: 'zai-org/GLM-5.3-Flash', status: 'active' },
			],
		},
		...(state === 'stale'
			? { stale: true as const, reason: 'falhou', code: 'unavailable' as const, failedAt: '2026-10-23T12:01:00.000Z' }
			: { stale: false as const }),
		connectionsUnknown: false,
	} as OpencodeCatalogState;
}

function fakeManager(connected = true): OpencodeManager {
	return {
		connection: () =>
			connected ? { baseUrl: 'http://127.0.0.1:4096', password: PASSWORD, mode: 'managed' as const } : undefined,
	} as unknown as OpencodeManager;
}

function fakeCatalog(state: OpencodeCatalogState | undefined): OpencodeCatalogService {
	return { state: async () => state } as unknown as OpencodeCatalogService;
}

/** Um `fetch` que responde sessão, prompt e um stream de dois eventos. */
function fakeFetch(): {
	readonly fetch: typeof fetch;
	readonly calls: string[];
	/** Simula o servidor reiniciado: as sessões deixam de existir. */
	forgetSessions: () => void;
} {
	const calls: string[] = [];
	let sessionsCreated = 0;
	let liveSession = 'ses_web_1';
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		calls.push(`${init?.method ?? 'GET'} ${url}`);
		if (url.endsWith('/api/session')) {
			sessionsCreated += 1;
			const created = `ses_web_${sessionsCreated}`;
			liveSession = created;
			return new Response(JSON.stringify({ data: { id: created } }), { status: 200 });
		}
		// A sonda da sessão: ela existe, com o mesmo modelo.
		if ((init?.method ?? 'GET') === 'GET' && /\/api\/session\/[^/]+$/.test(url)) {
			const id = url.split('/').pop() ?? '';
			if (id !== liveSession) {
				return new Response(JSON.stringify({ _tag: 'NotFound' }), { status: 404 });
			}
			return new Response(
				JSON.stringify({ data: { id, model: { providerID: 'river', id: 'deepseek-ai/DeepSeek-V4.1-Flash' } } }),
				{ status: 200 },
			);
		}
		if (url.includes('/prompt_async')) {
			return new Response(null, { status: 204 });
		}
		if (/\/session\/[^/]+\/message$/.test(url) && (init?.method ?? 'GET') === 'POST') {
			return new Response(
				JSON.stringify({
					info: { role: 'assistant', providerID: 'river', modelID: 'deepseek-ai/DeepSeek-V4.1-Flash', sessionID: liveSession },
					parts: [{ type: 'text', text: 'Olá, mundo' }],
				}),
				{ status: 200 },
			);
		}
		if (url.endsWith('/event')) {
			const frames = [
				{ type: 'message.updated', properties: { sessionID: 'ses_web_1', info: { id: 'm1', role: 'assistant', providerID: 'river', modelID: 'deepseek-ai/DeepSeek-V4.1-Flash' } } },
				{ type: 'message.part.delta', properties: { sessionID: 'ses_web_1', messageID: 'm1', partID: 'p1', field: 'text', delta: 'Olá' } },
				{ type: 'message.part.delta', properties: { sessionID: 'ses_web_1', messageID: 'm1', partID: 'p1', field: 'text', delta: ', mundo' } },
				{ type: 'session.idle', properties: { sessionID: 'ses_web_1' } },
			];
			const payload = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('');
			return new Response(payload, { status: 200, headers: { 'content-type': 'text/event-stream' } });
		}
		return new Response('', { status: 404 });
	}) as typeof fetch;
	return {
		fetch: fetchImpl,
		calls,
		forgetSessions: () => {
			liveSession = 'nenhuma';
		},
	};
}

/** Lê os eventos do stream HTTP. */
async function readEvents(stream: ReadableStream<Uint8Array>): Promise<Array<Record<string, unknown>>> {
	const decoder = new TextDecoder();
	const reader = stream.getReader();
	let buffer = '';
	const events: Array<Record<string, unknown>> = [];
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		buffer += decoder.decode(value, { stream: true });
		let index: number;
		while ((index = buffer.indexOf('\n\n')) >= 0) {
			const frame = buffer.slice(0, index);
			buffer = buffer.slice(index + 2);
			const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('');
			if (data.length > 0) {
				events.push(JSON.parse(data) as Record<string, unknown>);
			}
		}
	}
	return events;
}

suite('Web: a conversa com o OpenCode', () => {
	// O adaptador usa o `fetch` global: o do teste é injetado por aqui.
	let originalFetch: typeof fetch;

	setup(() => {
		originalFetch = globalThis.fetch;
	});

	teardown(() => {
		globalThis.fetch = originalFetch;
	});

	test('sem conexão, o envio é recusado sem consultar o servidor', async () => {
		const fake = fakeFetch();
		globalThis.fetch = fake.fetch;
		const controller = new OpencodeChatController(fakeManager(false), fakeCatalog(catalogState()));
		const reply = await controller.send({ model: MODEL, text: 'oi' });
		assert.strictEqual(reply.status, 409);
		assert.deepStrictEqual(fake.calls, []);
	});

	test('com o catálogo desatualizado, a escolha exige atualização', async () => {
		const fake = fakeFetch();
		globalThis.fetch = fake.fetch;
		const controller = new OpencodeChatController(fakeManager(), fakeCatalog(catalogState('stale')));
		const reply = await controller.send({ model: MODEL, text: 'oi' });
		assert.strictEqual(reply.status, 409);
		const body = reply.body as { error: string };
		assert.ok(/desatualizado/.test(body.error));
		assert.deepStrictEqual(fake.calls, []);
	});

	test('um modelo fora do catálogo é recusado, e um do catálogo é aceito', async () => {
		const fake = fakeFetch();
		globalThis.fetch = fake.fetch;
		const controller = new OpencodeChatController(fakeManager(), fakeCatalog(catalogState()));

		const missing = await controller.send({ model: 'river/modelo-que-nao-existe', text: 'oi' });
		assert.strictEqual(missing.status, 409);
		assert.deepStrictEqual(fake.calls, []);

		const accepted = await controller.send({ model: MODEL, text: 'oi' });
		assert.strictEqual(accepted.status, 200);
		assert.ok(accepted.stream !== undefined);
	});

	test('o envio leva o modelo escolhido ao servidor, e o stream entrega o texto', async () => {
		const fake = fakeFetch();
		globalThis.fetch = fake.fetch;
		const controller = new OpencodeChatController(fakeManager(), fakeCatalog(catalogState()));

		const reply = await controller.send({ model: MODEL, text: 'Diga olá' });
		assert.strictEqual(reply.status, 200);
		const events = await readEvents(reply.stream as ReadableStream<Uint8Array>);
		const types = events.map((event) => event['type']);
		assert.ok(types.includes('started'), 'a sessão é anunciada');
		assert.ok(types.includes('delta'));
		assert.ok(types.includes('done'));
		const started = events.find((event) => event['type'] === 'started') as { readonly session?: { readonly status: string } };
		assert.strictEqual(started.session?.status, 'active');
		const text = events.filter((event) => event['type'] === 'delta').map((event) => String(event['text'])).join('');
		assert.strictEqual(text, 'Olá, mundo');
		// O `done` traz o modelo quando o servidor declarou; o do fake declara.
		const done = events.find((event) => event['type'] === 'done');
		assert.strictEqual(done?.['model'], MODEL, 'o modelo que respondeu vem no done');

		// A sessão foi criada com o par providerID/id.
		const sessionCall = fake.calls.find((call) => call.endsWith('/api/session'));
		assert.ok(sessionCall !== undefined);
		assert.ok(!JSON.stringify(events).includes(PASSWORD));
	});

	test('o histórico fica na conversa, e o turno em curso bloqueia outro', async () => {
		const fake = fakeFetch();
		globalThis.fetch = fake.fetch;
		const controller = new OpencodeChatController(fakeManager(), fakeCatalog(catalogState()));
		const first = await controller.send({ model: MODEL, text: 'primeira' });
		const conversationId = String((first.body as { conversationId: string }).conversationId);
		const events = await readEvents(first.stream as ReadableStream<Uint8Array>);
		assert.ok(events.length > 0);

		const conversation = await controller.get(conversationId);
		const messages = (conversation.body as { messages: Array<{ role: string; text: string; model?: string }> }).messages;
		assert.deepStrictEqual(
			messages.map((message) => message.role),
			['user', 'assistant'],
		);
		assert.strictEqual(messages[1]?.text, 'Olá, mundo');
		assert.strictEqual(messages[1]?.model, MODEL);
		assert.strictEqual((conversation.body as { busy: boolean }).busy, false, 'o turno terminou');

		const listed = await controller.list();
		const listBody = listed.body as { conversations: Array<{ id: string; messages: number }> };
		assert.strictEqual(listBody.conversations.length, 1);
		assert.strictEqual(listBody.conversations[0]?.messages, 2);
	});

	test('campos proibidos são recusados: a página não escolhe servidor nem rota', async () => {
		const fake = fakeFetch();
		globalThis.fetch = fake.fetch;
		const controller = new OpencodeChatController(fakeManager(), fakeCatalog(catalogState()));
		for (const extra of [{ url: 'http://exemplo.com' }, { route: '/provider' }, { headers: {} }]) {
			const reply = await controller.send({ model: MODEL, text: 'oi', ...extra });
			assert.strictEqual(reply.status, 400, JSON.stringify(extra));
		}
		assert.deepStrictEqual(fake.calls, []);
	});

	test('escolher o modelo de uma conversa parada troca o próximo turno', async () => {
		const fake = fakeFetch();
		globalThis.fetch = fake.fetch;
		const controller = new OpencodeChatController(fakeManager(), fakeCatalog(catalogState()));
		const first = await controller.send({ model: MODEL, text: 'oi' });
		const conversationId = String((first.body as { conversationId: string }).conversationId);
		await readEvents(first.stream as ReadableStream<Uint8Array>);

		const changed = await controller.selectModel({ conversationId, model: 'river/zai-org/GLM-5.3-Flash' });
		assert.strictEqual(changed.status, 200);
		const missing = await controller.selectModel({ conversationId, model: 'river/nao-existe' });
		assert.strictEqual(missing.status, 409);
	});

	test('parar sem turno em curso não é erro, e sem conversa é 404', async () => {
		const fake = fakeFetch();
		globalThis.fetch = fake.fetch;
		const controller = new OpencodeChatController(fakeManager(), fakeCatalog(catalogState()));
		const withoutTurn = await controller.stop({ conversationId: 'cnv_x' });
		assert.strictEqual(withoutTurn.status, 404);
		const first = await controller.send({ model: MODEL, text: 'oi' });
		const conversationId = String((first.body as { conversationId: string }).conversationId);
		await readEvents(first.stream as ReadableStream<Uint8Array>);
		const stopped = await controller.stop({ conversationId });
		assert.strictEqual(stopped.status, 200);
		assert.strictEqual((stopped.body as { stopped: boolean }).stopped, false, 'nada em curso');
	});

	test('sem catálogo lido, o envio pede atualização', async () => {
		const fake = fakeFetch();
		globalThis.fetch = fake.fetch;
		const controller = new OpencodeChatController(fakeManager(), fakeCatalog(undefined));
		const reply = await controller.send({ model: MODEL, text: 'oi' });
		assert.strictEqual(reply.status, 409);
		assert.ok(/atualize o catálogo/.test((reply.body as { error: string }).error));
	});

	test('dispose encerra os turnos e nada fica pendurado', async () => {
		const fake = fakeFetch();
		globalThis.fetch = fake.fetch;
		const controller = new OpencodeChatController(fakeManager(), fakeCatalog(catalogState()));
		const first = await controller.send({ model: MODEL, text: 'oi' });
		await readEvents(first.stream as ReadableStream<Uint8Array>);
		controller.dispose();
		const listed = await controller.list();
		assert.deepStrictEqual((listed.body as { conversations: unknown[] }).conversations, []);
	});
test('dois turnos no mesmo modelo reutilizam a sessão, e a página vê o mesmo id', async () => {
		const fake = fakeFetch();
		globalThis.fetch = fake.fetch;
		const controller = new OpencodeChatController(fakeManager(), fakeCatalog(catalogState()));

		const first = await controller.send({ model: MODEL, text: 'primeira' });
		const conversationId = String((first.body as { conversationId: string }).conversationId);
		const firstEvents = await readEvents(first.stream as ReadableStream<Uint8Array>);
		const firstStarted = firstEvents.find((event) => event['type'] === 'started') as {
			readonly origin: string;
			readonly session: { readonly id: string; readonly status: string };
		};
		assert.strictEqual(firstStarted.origin, 'new');
		assert.strictEqual(firstStarted.session.status, 'active');

		const second = await controller.send({ conversationId, model: MODEL, text: 'segunda' });
		const secondEvents = await readEvents(second.stream as ReadableStream<Uint8Array>);
		const secondStarted = secondEvents.find((event) => event['type'] === 'started') as {
			readonly origin: string;
			readonly session: { readonly id: string };
		};
		assert.strictEqual(secondStarted.session.id, firstStarted.session.id, 'a mesma sessão');
		assert.strictEqual(secondStarted.origin, 'reused-unverified');
		assert.strictEqual(
			fake.calls.filter((call) => call.includes('POST http://127.0.0.1:4096/api/session')).length,
			1,
			'uma sessão criada para os dois turnos',
		);

		const conversation = await controller.get(conversationId);
		const session = (conversation.body as { session: { status: string; id: string } }).session;
		assert.strictEqual(session.status, 'active');
		assert.strictEqual(session.id, firstStarted.session.id);
	});

	test('trocar o modelo encerra a sessão antiga e o turno seguinte abre outra', async () => {
		const fake = fakeFetch();
		globalThis.fetch = fake.fetch;
		const controller = new OpencodeChatController(fakeManager(), fakeCatalog(catalogState()));
		const first = await controller.send({ model: MODEL, text: 'primeira' });
		const conversationId = String((first.body as { conversationId: string }).conversationId);
		await readEvents(first.stream as ReadableStream<Uint8Array>);

		const changed = await controller.selectModel({ conversationId, model: 'river/zai-org/GLM-5.3-Flash' });
		assert.strictEqual(changed.status, 200);
		// A sessão antiga foi encerrada no servidor.
		assert.ok(fake.calls.some((call) => call.includes('/session/ses_web_1/abort')));

		const second = await controller.send({ conversationId, model: 'river/zai-org/GLM-5.3-Flash', text: 'segunda' });
		const events = await readEvents(second.stream as ReadableStream<Uint8Array>);
		const started = events.find((event) => event['type'] === 'started') as {
			readonly origin: string;
			readonly session: { readonly id: string; readonly model: string };
		};
		assert.strictEqual(started.origin, 'new');
		assert.strictEqual(started.session.model, 'river/zai-org/GLM-5.3-Flash');
		assert.strictEqual(
			fake.calls.filter((call) => call.includes('POST http://127.0.0.1:4096/api/session')).length,
			2,
		);
	});

	test('uma sessão perdida é dita sem apagar o histórico, e o próximo turno abre outra', async () => {
		const fake = fakeFetch();
		globalThis.fetch = fake.fetch;
		const controller = new OpencodeChatController(fakeManager(), fakeCatalog(catalogState()));
		const first = await controller.send({ model: MODEL, text: 'primeira' });
		const conversationId = String((first.body as { conversationId: string }).conversationId);
		const firstEvents = await readEvents(first.stream as ReadableStream<Uint8Array>);
		const firstSession = (firstEvents.find((event) => event['type'] === 'started') as { session: { id: string } }).session.id;

		// O servidor reiniciou e perdeu a sessão: a sonda responde 404.
		fake.forgetSessions();

		const second = await controller.send({ conversationId, model: MODEL, text: 'segunda' });
		const events = await readEvents(second.stream as ReadableStream<Uint8Array>);
		const started = events.find((event) => event['type'] === 'started') as {
			readonly origin: string;
			readonly session: { readonly id: string };
		};
		assert.strictEqual(started.origin, 'new', 'o próximo turno abre uma sessão nova');
		assert.notStrictEqual(started.session.id, firstSession);

		const conversation = await controller.get(conversationId);
		const messages = (conversation.body as { messages: Array<{ role: string }> }).messages;
		assert.deepStrictEqual(
			messages.map((message) => message.role),
			['user', 'assistant', 'user', 'assistant'],
			'o histórico visível não é apagado',
		);
		assert.strictEqual((conversation.body as { session: { status: string } }).session.status, 'active');
	});
;

	test('descartar a conversa encerra a sessão e a tira da lista', async () => {
		const fake = fakeFetch();
		globalThis.fetch = fake.fetch;
		const controller = new OpencodeChatController(fakeManager(), fakeCatalog(catalogState()));
		const first = await controller.send({ model: MODEL, text: 'primeira' });
		const conversationId = String((first.body as { conversationId: string }).conversationId);
		await readEvents(first.stream as ReadableStream<Uint8Array>);

		const discarded = await controller.discard({ conversationId });
		assert.strictEqual(discarded.status, 200);
		assert.ok(fake.calls.some((call) => call.includes('/session/ses_web_1/abort')));
		const listed = await controller.list();
		assert.deepStrictEqual((listed.body as { conversations: unknown[] }).conversations, []);
	});

	test('duas conversas têm sessões diferentes, e descartar uma não toca na outra', async () => {
		const fake = fakeFetch();
		globalThis.fetch = fake.fetch;
		const controller = new OpencodeChatController(fakeManager(), fakeCatalog(catalogState()));
		const one = await controller.send({ model: MODEL, text: 'um' });
		const oneId = String((one.body as { conversationId: string }).conversationId);
		const oneEvents = await readEvents(one.stream as ReadableStream<Uint8Array>);
		const two = await controller.send({ model: MODEL, text: 'dois' });
		const twoId = String((two.body as { conversationId: string }).conversationId);
		const twoEvents = await readEvents(two.stream as ReadableStream<Uint8Array>);

		const sessionOf = (events: Array<Record<string, unknown>>): string =>
			(events.find((event) => event['type'] === 'started') as { session: { id: string } }).session.id;
		assert.strictEqual(sessionOf(oneEvents), 'ses_web_1');
		assert.strictEqual(sessionOf(twoEvents), 'ses_web_2', 'cada conversa tem a sua sessão');
		assert.notStrictEqual(sessionOf(oneEvents), sessionOf(twoEvents));

		await controller.discard({ conversationId: oneId });
		const other = await controller.get(twoId);
		assert.strictEqual((other.body as { session: { status: string } }).session.status, 'active');
	});
});

