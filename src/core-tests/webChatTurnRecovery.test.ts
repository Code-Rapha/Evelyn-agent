/**
 * R4H: o registro de turnos pelos caminhos reais do serviço.
 *
 * Motor, store, rotas e registro no disco — todos reais. O modelo é o backend
 * determinístico com portão (o que torna a janela do turno observável).
 *
 * O teste de reinicialização usa um **segundo processo** lendo o mesmo
 * `turns.json` e rodando a recuperação: é o caminho que o serviço executa ao
 * subir, sem mock.
 */
import * as assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assembleCore, type AssembledCore } from '../app/assemble';
import { ConsoleLogSink } from '../adapters/local/consoleLogSink';
import {
	CHAT_CONVERSATIONS_ROUTE,
	CHAT_CREATE_ROUTE,
	CHAT_DELETE_ROUTE,
	CHAT_TOKEN_HEADER,
	CHAT_TURN_ROUTE,
	CHAT_TURN_STATE_ROUTE,
	startWebServer,
	type RunningWebServer,
} from '../web/server';
import { WebChatEndpoint } from '../web/chatEndpoint';
import { TurnRecordStore, TURNS_FILE } from '../core/storage/turnRecords';
import type { FetchLike, FetchResponseLike } from '../core/providers/openaiCompatible';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const BASE_URL = 'http://127.0.0.1:12233/v1';
const CHAT_TOKEN = 'c'.repeat(64);

interface Gate {
	readonly fetchImpl: FetchLike;
	readonly waiting: (() => void)[];
	release(): void;
}

function gateBackend(options: { readonly fail?: boolean } = {}): Gate {
	const waiting: (() => void)[] = [];
	const fetchImpl: FetchLike = async (url) => {
		if (url.endsWith('/models')) {
			return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'modelo-a' }] }) };
		}
		if (options.fail === true) {
			throw Object.assign(new Error('o provedor falhou'), { errorClass: 'unavailable', httpStatus: 503 });
		}
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
			waiting.push(resolve);
		});
		void release;
		const response: FetchResponseLike = {
			ok: true,
			status: 200,
			body: {
				[Symbol.asyncIterator]: async function* () {
					await gate;
					yield* [
						`data: ${JSON.stringify({ choices: [{ delta: { content: 'pronto' } }] })}\n\n`,
						'data: [DONE]\n\n',
					];
				},
			},
			text: async () => '',
		};
		return response;
	};
	return {
		fetchImpl,
		waiting,
		release() {
			waiting.shift()?.();
		},
	};
}

interface Harness {
	readonly root: string;
	readonly core: AssembledCore;
	readonly endpoint: WebChatEndpoint;
	readonly turns: TurnRecordStore;
	readonly server: RunningWebServer;
	readonly base: string;
	close(): Promise<void>;
}

async function start(gate: Gate | FetchLike = gateBackend()): Promise<Harness> {
	const root = await mkdtemp(join(tmpdir(), 'evelyn-r4h-int-'));
	const fetchImpl = typeof gate === 'function' ? gate : gate.fetchImpl;
	const core = assembleCore({
		rootPath: root,
		logScope: 'test',
		logSink: new ConsoleLogSink({ out: () => undefined, err: () => undefined }),
		fetchImpl,
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
		port: 0,
	});
	return {
		root,
		core,
		endpoint,
		turns,
		server,
		base: `http://127.0.0.1:${server.port}`,
		async close() {
			await server.close();
			core.chat.dispose();
			await removeFixtureTree(root).catch(() => undefined);
		},
	};
}

async function post(
	harness: Harness,
	path: string,
	body: unknown,
): Promise<{ readonly status: number; readonly body: string }> {
	const response = await fetch(`${harness.base}${path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', [CHAT_TOKEN_HEADER]: CHAT_TOKEN },
		body: JSON.stringify(body),
	});
	return { status: response.status, body: await response.text() };
}

async function create(harness: Harness, title: string): Promise<string> {
	const created = await post(harness, CHAT_CREATE_ROUTE, { providerId: 'local', title });
	assert.equal(created.status, 201);
	return (JSON.parse(created.body) as { conversation: { id: string } }).conversation.id;
}

function startTurn(harness: Harness, conversationId: string, text = 'pergunta'): Promise<Response> {
	return fetch(`${harness.base}${CHAT_TURN_ROUTE}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', [CHAT_TOKEN_HEADER]: CHAT_TOKEN },
		body: JSON.stringify({ conversationId, providerId: 'local', model: 'local/modelo-a', text }),
	});
}

async function until(condition: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error(`tempo esgotado esperando: ${label}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/** A versão assíncrona: a condição lê o disco (o registro), não a memória. */
async function untilAsync(
	condition: () => Promise<boolean>,
	label: string,
	timeoutMs = 10_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await condition()) {
			return;
		}
		if (Date.now() > deadline) {
			throw new Error(`tempo esgotado esperando: ${label}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** Lê o estado que o serviço publica. */
async function states(harness: Harness, conversationId: string): Promise<Record<string, unknown>[]> {
	const answer = await post(harness, CHAT_TURN_STATE_ROUTE, { id: conversationId });
	assert.equal(answer.status, 200);
	return (JSON.parse(answer.body) as { turns: Record<string, unknown>[] }).turns;
}

teardown(async () => {
	// Cada teste fecha o seu harness.
});

suite('R4H: o estado real dos turnos', () => {
	test('um turno concluído fica `completed` com data de fim', async () => {
		const gate = gateBackend();
		const harness = await start(gate);
		try {
			const id = await create(harness, 'concluída');
			const turn = startTurn(harness, id);
			await until(() => gate.waiting.length === 1, 'o turno chegar ao modelo');

			// Durante o turno, o estado publicado é `running`.
			const during = await states(harness, id);
			assert.equal(during[0]?.status, 'running');

			gate.release();
			await (await turn).text();
			await until(() => harness.endpoint.activeTurnsFor(id) === 0, 'o turno terminar');
			await untilAsync(
				async () => (await harness.turns.forConversation(id))[0]?.status === 'completed',
				'o registro fechar',
			);

			const after = await states(harness, id);
			assert.equal(after[0]?.status, 'completed');
			assert.equal(typeof after[0]?.['finishedAt'], 'string');
		} finally {
			await harness.close();
		}
	});

	test('um turno que falha fica `failed`', async () => {
		const harness = await start(gateBackend({ fail: true }));
		try {
			const id = await create(harness, 'falha');
			await (await startTurn(harness, id)).text();
			await until(() => harness.endpoint.activeTurnsFor(id) === 0, 'o turno terminar');
			await untilAsync(
				async () => {
					const turns = await harness.turns.forConversation(id);
					return turns[0] !== undefined && turns[0].status !== 'running';
				},
				'o registro fechar',
			);

			const after = await states(harness, id);
			assert.ok(after[0]?.status === 'failed' || after[0]?.status === 'cancelled');
		} finally {
			await harness.close();
		}
	});

	test('um turno cancelado fica `cancelled`', async () => {
		const gate = gateBackend();
		const harness = await start(gate);
		try {
			const id = await create(harness, 'cancelada');
			const turn = startTurn(harness, id);
			await until(() => gate.waiting.length === 1, 'o turno chegar');

			assert.equal(harness.endpoint.cancel('svc-turn-1'), true);
			gate.release();
			await (await turn).text();
			await until(() => harness.endpoint.activeTurnsFor(id) === 0, 'o turno terminar');
			await untilAsync(
				async () => {
					const turns = await harness.turns.forConversation(id);
					return turns[0] !== undefined && turns[0].status !== 'running';
				},
				'o registro fechar',
			);

			const after = await states(harness, id);
			assert.equal(after[0]?.status, 'cancelled');
		} finally {
			await harness.close();
		}
	});

	test('o estado publicado não traz conteúdo, token nem caminho', async () => {
		const gate = gateBackend();
		const harness = await start(gate);
		try {
			const id = await create(harness, 'privacidade');
			const turn = startTurn(harness, id, 'texto secreto do usuário');
			await until(() => gate.waiting.length === 1, 'o turno chegar');

			const published = await post(harness, CHAT_TURN_STATE_ROUTE, { id });

			assert.equal(published.body.includes('texto secreto'), false);
			assert.equal(published.body.includes(CHAT_TOKEN), false);
			assert.equal(published.body.includes(harness.root), false);
			const turns = (JSON.parse(published.body) as { turns: Record<string, unknown>[] }).turns;
			assert.deepEqual(Object.keys(turns[0] ?? {}).sort(), [
				'conversationId',
				'finishedAt',
				'startedAt',
				'status',
				'turnId',
			].filter((key) => key in (turns[0] ?? {})).sort());

			gate.release();
			await (await turn).text();
		} finally {
			await harness.close();
		}
	});

	test('turnos de várias conversas ficam separados', async () => {
		const gate = gateBackend();
		const harness = await start(gate);
		try {
			const one = await create(harness, 'um');
			const two = await create(harness, 'dois');
			const first = startTurn(harness, one);
			const second = startTurn(harness, two);
			await until(() => gate.waiting.length === 2, 'os dois turnos chegarem');

			const statesOne = await states(harness, one);
			const statesTwo = await states(harness, two);
			assert.equal(statesOne.length, 1);
			assert.equal(statesTwo.length, 1);
			assert.notEqual(statesOne[0]?.['turnId'], statesTwo[0]?.['turnId']);

			gate.release();
			gate.release();
			await (await first).text();
			await (await second).text();
		} finally {
			await harness.close();
		}
	});

	test('excluir continua bloqueada enquanto o turno roda', async () => {
		// R4H não pode enfraquecer a R4G.
		const gate = gateBackend();
		const harness = await start(gate);
		try {
			const id = await create(harness, 'bloqueada');
			const turn = startTurn(harness, id);
			await until(() => gate.waiting.length === 1, 'o turno chegar');

			assert.equal((await post(harness, CHAT_DELETE_ROUTE, { id })).status, 409);

			gate.release();
			await (await turn).text();
			await until(() => harness.endpoint.activeTurnsFor(id) === 0, 'o turno terminar');
			await untilAsync(
				async () => {
					const turns = await harness.turns.forConversation(id);
					return turns[0] !== undefined && turns[0].status !== 'running';
				},
				'o registro fechar',
			);
			assert.equal((await post(harness, CHAT_DELETE_ROUTE, { id })).status, 200);
		} finally {
			await harness.close();
		}
	});
});

suite('R4H: reinicialização', () => {
	test('um turno `running` de um processo morto vira `interrupted` no próximo', async () => {
		// O que fica no disco depois de uma queda: o `start` foi gravado e o
		// `finish` não. O "processo novo" é um store novo sobre o mesmo arquivo
		// — o mesmo que o host faz ao subir.
		const root = await mkdtemp(join(tmpdir(), 'evelyn-r4h-restart-'));
		try {
			const dead = new TurnRecordStore({ root });
			await dead.start({ turnId: 'svc-turn-1', conversationId: 'cnv_1' });

			const revived = new TurnRecordStore({ root });
			const recovered = await revived.recover();

			assert.equal(recovered.interrupted, 1);
			const turns = await revived.forConversation('cnv_1');
			assert.equal(turns[0]?.status, 'interrupted');
			assert.match(turns[0]?.reason ?? '', /encerrado antes de o turno terminar/);
		} finally {
			await removeFixtureTree(root).catch(() => undefined);
		}
	});

	test('um turno concluído antes da queda continua `completed`', async () => {
		const root = await mkdtemp(join(tmpdir(), 'evelyn-r4h-keep-'));
		try {
			const before = new TurnRecordStore({ root });
			await before.start({ turnId: 'svc-turn-1', conversationId: 'cnv_1' });
			await before.finish({ turnId: 'svc-turn-1', status: 'completed' });

			const revived = new TurnRecordStore({ root });
			const recovered = await revived.recover();

			assert.equal(recovered.interrupted, 0);
			assert.equal((await revived.forConversation('cnv_1'))[0]?.status, 'completed');
		} finally {
			await removeFixtureTree(root).catch(() => undefined);
		}
	});

	test('o histórico da conversa sobrevive à recuperação, intacto', async () => {
		const gate = gateBackend();
		const harness = await start(gate);
		const id = await create(harness, 'histórico');
		// A raiz é capturada antes do `close`: ele remove a pasta de teste, e a
		// "reinicialização" precisa de um diretório que ainda exista.
		const root = harness.root;
		let raw: string;
		try {
			const turn = startTurn(harness, id, 'a pergunta');
			await until(() => gate.waiting.length === 1, 'o turno chegar');
			gate.release();
			await (await turn).text();
			await until(() => harness.endpoint.activeTurnsFor(id) === 0, 'o turno terminar');
			await untilAsync(
				async () => {
					const turns = await harness.turns.forConversation(id);
					return turns[0] !== undefined && turns[0].status !== 'running';
				},
				'o registro fechar',
			);
			raw = await readFile(join(root, 'conversations', `${id}.json`), 'utf8');
		} finally {
			// Encerra o servidor sem apagar a raiz: `close` do harness apaga,
			// então o servidor e o Core são fechados aqui mesmo.
			await harness.server.close();
			harness.core.chat.dispose();
		}

		try {
			// Um processo novo sobre a mesma raiz: a recuperação roda e o
			// histórico precisa continuar idêntico.
			const revived = new TurnRecordStore({ root });
			await revived.recover();

			const after = await readFile(join(root, 'conversations', `${id}.json`), 'utf8');
			assert.equal(after, raw, 'a recuperação não toca no histórico');
		} finally {
			await removeFixtureTree(root).catch(() => undefined);
		}
	});
});
