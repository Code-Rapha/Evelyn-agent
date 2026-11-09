/**
 * R4Q: concorrência real pelo HTTP, com dois pedidos simultâneos.
 *
 * ## Por que este arquivo existe
 *
 * A R4O testava a concorrência chamando o store direto; o transporte HTTP
 * ficou sem prova. Aqui os dois pedidos saem de verdade, no mesmo instante,
 * e o que se verifica é o contrato da R4Q:
 *
 * - **um turno ativo por conversa**: `200` e `409 conversation_busy`;
 * - a recusa **não** grava mensagem, **não** registra turno e **não** chama o
 *   modelo;
 * - o aceito grava a mensagem antes de confirmar.
 *
 * ## Sockets
 *
 * O backend responde na hora (sem portão), de modo que os dois streams
 * terminam sozinhos antes do `close()`. O teste não deixa conexão pendente:
 * é o cuidado que a R4O precisou para não pagar segundos no encerramento.
 */
import * as assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assembleCore, type AssembledCore } from '../app/assemble';
import { ConsoleLogSink } from '../adapters/local/consoleLogSink';
import {
	CHAT_CREATE_ROUTE,
	CHAT_DELETE_ROUTE,
	CHAT_TOKEN_HEADER,
	CHAT_TURN_ROUTE,
	startWebServer,
	type RunningWebServer,
} from '../web/server';
import { WebChatEndpoint } from '../web/chatEndpoint';
import { TurnRecordStore } from '../core/storage/turnRecords';
import type { FetchLike } from '../core/providers/openaiCompatible';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const BASE_URL = 'http://127.0.0.1:12241/v1';
const CHAT_TOKEN = 'c'.repeat(64);
const MESSAGE = 'duas ao mesmo tempo';

/** Um backend que responde na hora e conta as chamadas. */
function instantBackend(): { readonly fetchImpl: FetchLike; readonly calls: { value: number } } {
	const calls = { value: 0 };
	const fetchImpl: FetchLike = async (url) => {
		if (url.endsWith('/models')) {
			return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'modelo-a' }] }) };
		}
		calls.value += 1;
		return {
			ok: true,
			status: 200,
			body: {
				[Symbol.asyncIterator]: async function* () {
					yield `data: ${JSON.stringify({ choices: [{ delta: { content: 'pronto' } }] })}\n\n`;
					yield 'data: [DONE]\n\n';
				},
			},
			text: async () => '',
		};
	};
	return { fetchImpl, calls };
}

interface Harness {
	readonly root: string;
	readonly core: AssembledCore;
	readonly turns: TurnRecordStore;
	readonly endpoint: WebChatEndpoint;
	readonly server: RunningWebServer;
	readonly base: string;
	readonly calls: { value: number };
	close(): Promise<void>;
}

async function start(): Promise<Harness> {
	const root = await mkdtemp(join(tmpdir(), 'evelyn-r4q-http-'));
	const backend = instantBackend();
	const core = assembleCore({
		rootPath: root,
		logScope: 'test',
		logSink: new ConsoleLogSink({ out: () => undefined, err: () => undefined }),
		fetchImpl: backend.fetchImpl,
	});
	await core.chat.saveProvider({ id: 'local', name: 'Local', baseUrl: BASE_URL });
	await core.chat.listModels('local').catch(() => undefined);
	const turns = new TurnRecordStore({ root });
	const endpoint = new WebChatEndpoint({ session: core.chat, turns });
	const server = await startWebServer({
		version: 'test',
		assetsDir: join(process.cwd(), 'dist', 'web', 'assets'),
		core,
		chatToken: CHAT_TOKEN,
		chat: endpoint,
		turns,
		port: 0,
	});
	return {
		root,
		core,
		turns,
		endpoint,
		server,
		base: `http://127.0.0.1:${server.port}`,
		calls: backend.calls,
		async close() {
			await server.close();
			core.chat.dispose();
			await removeFixtureTree(root).catch(() => undefined);
		},
	};
}

const headers = { 'content-type': 'application/json', [CHAT_TOKEN_HEADER]: CHAT_TOKEN };

async function create(harness: Harness, title: string): Promise<string> {
	const response = await fetch(`${harness.base}${CHAT_CREATE_ROUTE}`, {
		method: 'POST',
		headers,
		body: JSON.stringify({ providerId: 'local', title }),
	});
	assert.equal(response.status, 201, await response.clone().text());
	const body = (await response.json()) as { readonly conversation: { readonly id: string } };
	return body.conversation.id;
}

function startTurn(harness: Harness, conversationId: string, extra: Record<string, unknown> = {}): Promise<Response> {
	return fetch(`${harness.base}${CHAT_TURN_ROUTE}`, {
		method: 'POST',
		headers,
		body: JSON.stringify({
			conversationId,
			providerId: 'local',
			model: 'local/modelo-a',
			text: MESSAGE,
			...extra,
		}),
	});
}

async function userMessages(harness: Harness, conversationId: string): Promise<string[]> {
	const raw = await readFile(join(harness.root, 'conversations', `${conversationId}.json`), 'utf8');
	const record = JSON.parse(raw) as { messages: readonly { readonly role: string; readonly content: string }[] };
	return record.messages.filter((message) => message.role === 'user').map((message) => message.content);
}

teardown(async () => {
	// Cada teste fecha o seu harness.
});

suite('R4Q: concorrência HTTP', () => {
	test('dois pedidos simultâneos: um 200 e um 409, uma mensagem, um turno, uma chamada ao modelo', async () => {
		const harness = await start();
		try {
			const id = await create(harness, 'simultâneos');

			// Os dois pedidos saem no mesmo instante, sem chave.
			const [first, second] = await Promise.all([startTurn(harness, id), startTurn(harness, id)]);
			const statuses = [first.status, second.status].sort();
			assert.deepEqual(statuses, [200, 409], 'um turno aceito, o outro recusado');

			// Consome os dois corpos: o aceito é SSE, a recusa é JSON curto.
			// Cada corpo é lido **pelo status da sua própria resposta** — ordenar
			// os status e indexar os corpos por posição fazia o teste parsear um
			// SSE como JSON quando a ordem das respostas variava.
			const bodies = await Promise.all([first.text(), second.text()]);
			const responses = [
				{ status: first.status, body: bodies[0] as string },
				{ status: second.status, body: bodies[1] as string },
			];
			const refused = responses.find((response) => response.status === 409);
			assert.notEqual(refused, undefined, `esperava uma recusa: ${responses.map((r) => r.status).join(',')}`);
			const refusal = JSON.parse(refused?.body ?? '{}') as { error?: { code?: string } };
			assert.equal(refusal.error?.code, 'conversation_busy', refused?.body?.slice(0, 200));

			assert.deepEqual(await userMessages(harness, id), [MESSAGE], 'gravada uma única vez');

			const recorded = await harness.turns.list();
			assert.equal(recorded.kind, 'valid');
			if (recorded.kind === 'valid') {
				assert.equal(recorded.turns.filter((turn) => turn.conversationId === id).length, 1, 'um turno');
			}
			assert.equal(harness.calls.value, 1, 'o modelo recebeu um único turno');
			assert.equal(harness.endpoint.activeTurnsFor(id), 0, 'a reserva foi liberada');
		} finally {
			await harness.close();
		}
	});

	test('a segunda requisição, depois que a primeira termina, é aceita', async () => {
		const harness = await start();
		try {
			const id = await create(harness, 'depois');

			const first = await startTurn(harness, id);
			assert.equal(first.status, 200);
			await first.text();

			const second = await startTurn(harness, id);
			assert.equal(second.status, 200);
			await second.text();

			// Duas intenções, duas mensagens: a mesma pergunta de novo é nova.
			assert.deepEqual(await userMessages(harness, id), [MESSAGE, MESSAGE]);
			assert.equal(harness.calls.value, 2);
		} finally {
			await harness.close();
		}
	});

	test('a mesma chave de idempotência não executa o modelo duas vezes', async () => {
		const harness = await start();
		try {
			const id = await create(harness, 'mesma chave');

			const first = await startTurn(harness, id, { requestId: 'req-1' });
			assert.equal(first.status, 200);
			await first.text();

			// A reentrega do mesmo envio: recusada, sem gravar e sem modelar.
			const replay = await startTurn(harness, id, { requestId: 'req-1' });
			assert.equal(replay.status, 409);
			const body = (await replay.json()) as { error: { code: string } };
			assert.equal(body.error.code, 'duplicate_request');

			assert.deepEqual(await userMessages(harness, id), [MESSAGE], 'sem mensagem duplicada');
			assert.equal(harness.calls.value, 1, 'o modelo rodou uma vez');
		} finally {
			await harness.close();
		}
	});

	test('a recusa não mexe na conversa: exclusão continua disponível depois', async () => {
		const harness = await start();
		try {
			const id = await create(harness, 'recusa limpa');

			const [first, second] = await Promise.all([startTurn(harness, id), startTurn(harness, id)]);
			await Promise.all([first.text(), second.text()]);

			const deleted = await fetch(`${harness.base}${CHAT_DELETE_ROUTE}`, {
				method: 'POST',
				headers,
				body: JSON.stringify({ id }),
			});
			assert.equal(deleted.status, 200, await deleted.clone().text());
			// A conversa sumiu do histórico e o registro de turnos continua
			// legível: a recusa do segundo pedido não deixou nada pendurado.
			const listed = JSON.parse(
				await readFile(join(harness.root, 'conversations', `${id}.json`), 'utf8').catch(() => 'null'),
			) as unknown;
			assert.equal(listed, null, 'a conversa foi apagada');
			const recorded = await harness.turns.list();
			assert.equal(recorded.kind, 'valid', 'o registro de turnos continua válido');
		} finally {
			await harness.close();
		}
	});
});
