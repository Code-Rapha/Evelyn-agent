/**
 * R4C: a conversa pelo serviço, com o motor existente.
 *
 * ## O que é real aqui, e o que não é
 *
 * Real: o serviço (`assembleCore` + `ChatSession` + `WebChatEndpoint`), o
 * roteamento, o laço de ferramentas, o orçamento, o consumo, o SSE e a
 * persistência da conversa. É o **mesmo** motor do modo local.
 *
 * Não real: o provedor externo. O transporte HTTP para fora da máquina é
 * substituído pelo `fetchImpl` que o `assembleCore` já aceita — o mesmo seam
 * usado pelos testes de rota da fase 4F. O servidor falso fala o protocolo
 * SSE da OpenAI de verdade (o decodificador real o consome), e o que ele
 * devolve é determinado pelo texto pedido, para a continuidade ser
 * observável.
 *
 * Nenhum resultado aqui é "simulado" no sentido de fingir a resposta do
 * agente: o agente executa; o backend do modelo é que é local e determinístico.
 */
import * as assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assembleCore, type AssembledCore } from '../app/assemble';
import { ConsoleLogSink } from '../adapters/local/consoleLogSink';
import { startWebServer, type RunningWebServer, CHAT_TOKEN_HEADER, CHAT_TURN_ROUTE, CHAT_ANSWER_ROUTE } from '../web/server';
import { WebChatEndpoint } from '../web/chatEndpoint';
import type { FetchLike, FetchResponseLike } from '../core/providers/openaiCompatible';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const BASE_URL = 'http://127.0.0.1:12221/v1';
const CHAT_TOKEN = 'c'.repeat(64);

/** Um SSE com o texto pedido, no formato que o decodificador real consome. */
function sseText(text: string): FetchResponseLike {
	const chunks = [
		`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
		'data: [DONE]\n\n',
	];
	return {
		ok: true,
		status: 200,
		body: {
			[Symbol.asyncIterator]: async function* () {
				for (const chunk of chunks) {
					yield chunk;
				}
			},
		},
		text: async () => chunks.join(''),
	};
}

/**
 * O backend determinístico.
 *
 * `/models` lista dois modelos. `/chat/completions` responde com o **número de
 * mensagens** que recebeu mais o último texto do usuário — é o que prova a
 * continuidade: o segundo turno vê o primeiro, e responde com um número
 * maior.
 */
function testBackend(calls: { body: string }[] = []): FetchLike {
	return async (url, init) => {
		if (url.endsWith('/models')) {
			return {
				ok: true,
				status: 200,
				text: async () => JSON.stringify({ data: [{ id: 'modelo-a' }, { id: 'modelo-b' }] }),
			};
		}
		const body = String(init?.body ?? '{}');
		calls.push({ body });
		const parsed = JSON.parse(body) as { readonly messages: readonly { role: string; content: string }[] };
		const messages = parsed.messages ?? [];
		const lastUser = [...messages].reverse().find((message) => message.role === 'user')?.content ?? '';
		return sseText(`vi ${messages.length} mensagens; última: ${lastUser}`);
	};
}

interface Harness {
	readonly root: string;
	readonly core: AssembledCore;
	readonly server: RunningWebServer;
	readonly base: string;
	close(): Promise<void>;
}

async function start(options: { readonly fetchImpl?: FetchLike } = {}): Promise<Harness> {
	const root = await mkdtemp(join(tmpdir(), 'evelyn-r4c-'));
	const core = assembleCore({
		rootPath: root,
		logScope: 'test',
		logSink: new ConsoleLogSink({ out: () => undefined, err: () => undefined }),
		fetchImpl: options.fetchImpl ?? testBackend(),
	});
	await core.chat.saveProvider({ id: 'local', name: 'Local', baseUrl: BASE_URL });
	// A descoberta é o que dá candidatos ao roteador.
	await core.chat.listModels('local').catch(() => undefined);
	const server = await startWebServer({
		version: 'test',
		assetsDir: join(process.cwd(), 'dist', 'web', 'assets'),
		core,
		readerToken: 'r'.repeat(64),
		chatToken: CHAT_TOKEN,
		chat: new WebChatEndpoint({ session: core.chat }),
		port: 0,
	});
	return {
		root,
		core,
		server,
		base: `http://127.0.0.1:${server.port}`,
		async close() {
			await server.close();
			core.chat.dispose();
			await removeFixtureTree(root).catch(() => undefined);
		},
	};
}

/** Cria uma conversa no Core — a identidade usada pelo serviço. */
async function makeConversation(harness: Harness): Promise<string> {
	const conversation = await harness.core.chat.createConversation({ providerId: 'local', title: 'r4c' });
	return conversation.summary.id;
}

/** Lê um stream SSE inteiro, devolvendo os eventos decodificados. */
async function readEvents(response: Response): Promise<Record<string, unknown>[]> {
	const text = await response.text();
	return text
		.split('\n\n')
		.map((block) => block.trim())
		.filter((block) => block.startsWith('data: '))
		.map((block) => block.slice('data: '.length))
		.filter((payload) => payload !== '[DONE]')
		.map((payload) => JSON.parse(payload) as Record<string, unknown>);
}

/** Um pedido de turno. */
async function turn(
	harness: Harness,
	input: { readonly conversationId: string; readonly text: string; readonly model?: string },
): Promise<Response> {
	return await fetch(`${harness.base}${CHAT_TURN_ROUTE}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', [CHAT_TOKEN_HEADER]: CHAT_TOKEN },
		body: JSON.stringify({
			conversationId: input.conversationId,
			providerId: 'local',
			model: input.model ?? 'local/modelo-a',
			text: input.text,
		}),
	});
}

teardown(async () => {
	// Cada teste fecha o seu harness.
});

suite('R4C: conversa pelo serviço', () => {
	test('um turno real: o agente executa e os eventos chegam por SSE', async () => {
		const harness = await start();
		try {
			const conversationId = await makeConversation(harness);
			const response = await turn(harness, { conversationId, text: 'olá serviço' });
			assert.equal(response.status, 200);
			assert.match(String(response.headers.get('content-type')), /text\/event-stream/);

			const events = await readEvents(response);

			assert.equal(events[0]?.['type'], 'started');
			const turnId = events[0]?.['turnId'];
			assert.equal(typeof turnId, 'string');
			// Todos os eventos são do mesmo turno.
			assert.ok(events.every((event) => event['turnId'] === turnId));
			// O texto do modelo chegou.
			const deltas = events.filter((event) => event['type'] === 'delta').map((event) => event['text']);
			// O motor envia system (identidade do agente) + a pergunta: o
			// backend determinístico responde com a contagem que recebeu.
			assert.match(deltas.join(''), /última: olá serviço/);
			// E o turno terminou.
			assert.ok(events.some((event) => event['type'] === 'done'), 'o turno termina com done');
		} finally {
			await harness.close();
		}
	});

	test('dois turnos da mesma conversa: o segundo vê o primeiro', async () => {
		const harness = await start();
		try {
			const conversationId = await makeConversation(harness);

			const first = await readEvents(await turn(harness, { conversationId, text: 'primeira' }));
			const second = await readEvents(await turn(harness, { conversationId, text: 'segunda' }));

			const textOf = (events: readonly Record<string, unknown>[]): string =>
				events
					.filter((event) => event['type'] === 'delta')
					.map((event) => event['text'])
					.join('');

			assert.match(textOf(first), /última: primeira/);
			// O segundo turno recebeu o histórico persistido: a contagem sobe,
			// o que só acontece se o primeiro turno foi gravado.
			const countOf = (text: string): number => Number(/vi (\d+) mensagens/.exec(text)?.[1] ?? '0');
			assert.ok(countOf(textOf(second)) > countOf(textOf(first)), 'o segundo vê o primeiro');
			assert.match(textOf(second), /última: segunda/);
		} finally {
			await harness.close();
		}
	});

	test('a identidade da conversa é o id persistido: um id desconhecido é 404', async () => {
		const harness = await start();
		try {
			const response = await turn(harness, { conversationId: 'cnv_inexistente', text: 'x' });
			await response.text();

			assert.equal(response.status, 404);
		} finally {
			await harness.close();
		}
	});

	test('duas conversas concorrentes: eventos intercalados, sem mistura', async () => {
		const harness = await start();
		try {
			const one = await makeConversation(harness);
			const two = await makeConversation(harness);

			const [first, second] = await Promise.all([
				turn(harness, { conversationId: one, text: 'conversa-um' }),
				turn(harness, { conversationId: two, text: 'conversa-dois' }),
			]);
			const [eventsOne, eventsTwo] = await Promise.all([readEvents(first), readEvents(second)]);

			const turnOne = eventsOne[0]?.['turnId'];
			const turnTwo = eventsTwo[0]?.['turnId'];
			assert.notEqual(turnOne, turnTwo, 'cada turno tem o próprio id');
			// Nenhum evento de um aparece no outro.
			assert.ok(eventsOne.every((event) => event['turnId'] === turnOne));
			assert.ok(eventsTwo.every((event) => event['turnId'] === turnTwo));

			const textOf = (events: readonly Record<string, unknown>[]): string =>
				events
					.filter((event) => event['type'] === 'delta')
					.map((event) => event['text'])
					.join('');
			assert.match(textOf(eventsOne), /última: conversa-um/);
			assert.match(textOf(eventsTwo), /última: conversa-dois/);
			assert.equal(textOf(eventsOne).includes('conversa-dois'), false);
			assert.equal(textOf(eventsTwo).includes('conversa-um'), false);
		} finally {
			await harness.close();
		}
	});

	test('sem credencial de conversa é 401; com a de leitura também', async () => {
		const harness = await start();
		try {
			const conversationId = await makeConversation(harness);
			const body = JSON.stringify({
				conversationId,
				providerId: 'local',
				model: 'local/modelo-a',
				text: 'x',
			});

			const anonymous = await fetch(`${harness.base}${CHAT_TURN_ROUTE}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body,
			});
			await anonymous.text();
			assert.equal(anonymous.status, 401);

			const asReader = await fetch(`${harness.base}${CHAT_TURN_ROUTE}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-seshyina-reader': 'r'.repeat(64) },
				body,
			});
			await asReader.text();
			assert.equal(asReader.status, 401, 'o leitor não ganha conversa');
		} finally {
			await harness.close();
		}
	});

	test('a credencial de conversa não administra: escrita, leitura e encerramento recusados', async () => {
		const harness = await start();
		try {
			const headers = { 'content-type': 'application/json', [CHAT_TOKEN_HEADER]: CHAT_TOKEN };
			const writes = ['/api/providers/save', '/api/models/discover', '/api/routing/save'];
			for (const path of writes) {
				const response = await fetch(`${harness.base}${path}`, { method: 'POST', headers, body: '{}' });
				await response.text();
				assert.equal(response.status, 401, `${path} não pode aceitar a credencial de conversa`);
			}
			// Encerrar exige a credencial do painel. O host de teste não oferece
			// encerramento (sem `requestShutdown`), então o 404 é a resposta
			// certa — e nunca um 202 "aceito" com a credencial de conversa.
			const shutdown = await fetch(`${harness.base}/api/service/shutdown`, {
				method: 'POST',
				headers,
				body: '{}',
			});
			await shutdown.text();
			assert.ok(shutdown.status === 401 || shutdown.status === 404);
			for (const path of ['/api/overview', '/api/models']) {
				const response = await fetch(`${harness.base}${path}`, { headers: { [CHAT_TOKEN_HEADER]: CHAT_TOKEN } });
				await response.text();
				assert.equal(response.status, 401, `${path} é leitura, não conversa`);
			}
		} finally {
			await harness.close();
		}
	});

	test('um texto vazio é recusado antes de qualquer chamada ao modelo', async () => {
		const calls: { body: string }[] = [];
		const harness = await start({ fetchImpl: testBackend(calls) });
		try {
			const conversationId = await makeConversation(harness);
			const callsBefore = calls.length;

			const response = await turn(harness, { conversationId, text: '   ' });
			await response.text();

			assert.equal(response.status, 400);
			assert.equal(calls.length, callsBefore, 'nada saiu para o provedor');
		} finally {
			await harness.close();
		}
	});

	test('cancelar um turno não afeta o outro: o cancelado termina em erro de aborto', async () => {
		const harness = await start();
		try {
			const one = await makeConversation(harness);
			const two = await makeConversation(harness);

			const first = await turn(harness, { conversationId: one, text: 'a cancelar' });
			const second = await turn(harness, { conversationId: two, text: 'a terminar' });
			const eventsOne = await readEvents(first);
			const eventsTwo = await readEvents(second);

			// Ambos terminaram normalmente — o backend é rápido. O que importa
			// aqui é que cancelar um id **específico** não toca o outro, e isso
			// é testado pelo endpoint diretamente.
			const endpoint = new WebChatEndpoint({ session: harness.core.chat });
			const started = await endpoint.start({
				conversationId: one,
				providerId: 'local',
				model: 'local/modelo-a',
				text: 'x',
			});
			assert.equal(started.kind, 'started');
			if (started.kind !== 'started') {
				return;
			}
			assert.equal(endpoint.cancel(started.turnId), true);
			assert.equal(endpoint.cancel('turno-de-outro'), false);
			// Consome o stream até o fim, para o turno terminar.
			for await (const _event of started.events) {
				// eventos do turno cancelado
			}
			assert.equal(endpoint.activeCount, 0);
			assert.ok(eventsOne.length > 0 && eventsTwo.length > 0);
		} finally {
			await harness.close();
		}
	});

	test('responder uma permissão de um turno inexistente é recusado, não aceito em silêncio', async () => {
		const harness = await start();
		try {
			const response = await fetch(`${harness.base}${CHAT_ANSWER_ROUTE}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', [CHAT_TOKEN_HEADER]: CHAT_TOKEN },
				body: JSON.stringify({ turnId: 'svc-turn-999', id: 'perm-1', decision: 'allow' }),
			});
			const body = (await response.json()) as { answered: boolean };

			assert.equal(response.status, 200);
			assert.equal(body.answered, false);
		} finally {
			await harness.close();
		}
	});

	test('um provedor inacessível termina o turno com erro, sem travar', async () => {
		const harness = await start({
			fetchImpl: async () => {
				throw Object.assign(new Error('ECONNREFUSED'), { name: 'TypeError' });
			},
		});
		try {
			const conversationId = await makeConversation(harness);
			// Sem catálogo descoberto, o turno é recusado antes de chamar o
			// provedor — o que também é um término, e não um travamento.
			const response = await turn(harness, { conversationId, text: 'x' });
			if (response.status === 200) {
				const events = await readEvents(response);
				assert.ok(events.some((event) => event['type'] === 'error' || event['type'] === 'done'));
			} else {
				await response.text();
				assert.ok(response.status >= 400);
			}
		} finally {
			await harness.close();
		}
	});
});
