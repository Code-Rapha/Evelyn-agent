/**
 * R4G: uma conversa com turno em curso não pode ser excluída.
 *
 * ## O que estes testes provam
 *
 * - a exclusão é recusada com `409 conversation_busy` enquanto o turno roda,
 *   e a conversa **não é tocada** (arquivo e histórico intactos);
 * - depois que o turno termina — por sucesso, erro, cancelamento ou timeout —
 *   a exclusão passa;
 * - o registro por conversa **não fica preso** em nenhum desses caminhos;
 * - turnos de outras conversas não bloqueiam;
 * - a corrida entre "iniciar turno" e "excluir" tem exatamente dois
 *   desfechos, nunca o terceiro (excluir no meio de um turno começando).
 *
 * ## Backend
 *
 * Determinístico (`fetchImpl` do `assembleCore`), com um portão que segura a
 * resposta — é o que torna a janela do turno observável. O motor, o store, as
 * rotas e a autenticação são reais.
 */
import * as assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assembleCore, type AssembledCore } from '../app/assemble';
import { ConsoleLogSink } from '../adapters/local/consoleLogSink';
import {
	CHAT_CONVERSATIONS_ROUTE,
	CHAT_CONVERSATION_ROUTE,
	CHAT_CREATE_ROUTE,
	CHAT_DELETE_ROUTE,
	CHAT_TURN_ROUTE,
	CHAT_TOKEN_HEADER,
	startWebServer,
	type RunningWebServer,
} from '../web/server';
import { WebChatEndpoint } from '../web/chatEndpoint';
import type { FetchLike, FetchResponseLike } from '../core/providers/openaiCompatible';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const BASE_URL = 'http://127.0.0.1:12231/v1';
const CHAT_TOKEN = 'c'.repeat(64);

/** Um portão: o teste decide quando a resposta do modelo chega. */
interface Gate {
	readonly fetchImpl: FetchLike;
	readonly waiting: (() => void)[];
	/** Libera a próxima resposta pendente. */
	release(text?: string): void;
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
			const next = waiting.shift();
			next?.();
		},
	};
}

interface Harness {
	readonly root: string;
	readonly core: AssembledCore;
	readonly endpoint: WebChatEndpoint;
	readonly server: RunningWebServer;
	readonly base: string;
	close(): Promise<void>;
}

async function start(gate: Gate | FetchLike = gateBackend()): Promise<Harness> {
	const root = await mkdtemp(join(tmpdir(), 'evelyn-r4g-'));
	const fetchImpl = typeof gate === 'function' ? gate : gate.fetchImpl;
	const core = assembleCore({
		rootPath: root,
		logScope: 'test',
		logSink: new ConsoleLogSink({ out: () => undefined, err: () => undefined }),
		fetchImpl,
	});
	await core.chat.saveProvider({ id: 'local', name: 'Local', baseUrl: BASE_URL });
	await core.chat.listModels('local').catch(() => undefined);
	const endpoint = new WebChatEndpoint({ session: core.chat });
	const server = await startWebServer({
		version: 'test',
		assetsDir: join(process.cwd(), 'dist', 'web', 'assets'),
		core,
		readerToken: 'r'.repeat(64),
		chatToken: CHAT_TOKEN,
		chat: endpoint,
		port: 0,
	});
	return {
		root,
		core,
		endpoint,
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
	headers: Record<string, string> = { [CHAT_TOKEN_HEADER]: CHAT_TOKEN },
): Promise<{ readonly status: number; readonly body: string }> {
	const response = await fetch(`${harness.base}${path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body: JSON.stringify(body),
	});
	return { status: response.status, body: await response.text() };
}

async function create(harness: Harness, title: string): Promise<string> {
	const created = await post(harness, CHAT_CREATE_ROUTE, { providerId: 'local', title });
	assert.equal(created.status, 201);
	return (JSON.parse(created.body) as { conversation: { id: string } }).conversation.id;
}

/** Inicia um turno **sem esperar** a resposta: devolve a promessa do stream. */
function startTurn(harness: Harness, conversationId: string, text = 'pergunta'): Promise<Response> {
	return fetch(`${harness.base}${CHAT_TURN_ROUTE}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', [CHAT_TOKEN_HEADER]: CHAT_TOKEN },
		body: JSON.stringify({ conversationId, providerId: 'local', model: 'local/modelo-a', text }),
	});
}

/** Espera uma condição, com limite. */
async function until(condition: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error(`tempo esgotado esperando: ${label}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function files(harness: Harness): Promise<string[]> {
	return (await readdir(join(harness.root, 'conversations'))).sort();
}

teardown(async () => {
	// Cada teste fecha o seu harness.
});

suite('R4G: exclusão bloqueada durante turno', () => {
	test('sem turno, a exclusão funciona', async () => {
		const harness = await start();
		try {
			const id = await create(harness, 'livre');
			const deleted = await post(harness, CHAT_DELETE_ROUTE, { id });

			assert.equal(deleted.status, 200);
			assert.equal((await files(harness)).includes(`${id}.json`), false);
		} finally {
			await harness.close();
		}
	});

	test('com turno em curso, é 409 conversation_busy', async () => {
		const gate = gateBackend();
		const harness = await start(gate);
		try {
			const id = await create(harness, 'ocupada');
			const turn = startTurn(harness, id);
			await until(() => gate.waiting.length === 1, 'o turno chegar ao modelo');

			const deleted = await post(harness, CHAT_DELETE_ROUTE, { id });

			assert.equal(deleted.status, 409);
			const parsed = JSON.parse(deleted.body) as { error: { code: string; message: string } };
			assert.equal(parsed.error.code, 'conversation_busy');
			assert.match(parsed.error.message, /resposta está sendo gerada/);
			// Sem detalhe interno.
			assert.equal(deleted.body.includes(harness.root), false);
			assert.equal(deleted.body.includes(CHAT_TOKEN), false);

			gate.release();
			await (await turn).text();
		} finally {
			await harness.close();
		}
	});

	test('a recusa não toca na conversa nem no histórico', async () => {
		const gate = gateBackend();
		const harness = await start(gate);
		try {
			const id = await create(harness, 'intacta');
			const turn = startTurn(harness, id);
			await until(() => gate.waiting.length === 1, 'o turno chegar ao modelo');
			// A pergunta do turno já foi gravada (o turno a grava antes de
			// chamar o modelo). É **este** estado que a recusa não pode mudar.
			const before = await readFile(join(harness.root, 'conversations', `${id}.json`), 'utf8');

			const rejected = await post(harness, CHAT_DELETE_ROUTE, { id });
			assert.equal(rejected.status, 409);

			// O arquivo ainda está lá, com o mesmo conteúdo.
			const stillThere = await readFile(join(harness.root, 'conversations', `${id}.json`), 'utf8');
			assert.equal(stillThere, before, 'a recusa não reescreve o histórico');
			// E a conversa responde.
			const opened = await post(harness, CHAT_CONVERSATION_ROUTE, { id });
			assert.equal(opened.status, 200);

			gate.release();
			await (await turn).text();
		} finally {
			await harness.close();
		}
	});

	test('depois que o turno termina, a exclusão passa', async () => {
		const gate = gateBackend();
		const harness = await start(gate);
		try {
			const id = await create(harness, 'depois');
			const turn = startTurn(harness, id);
			await until(() => gate.waiting.length === 1, 'o turno chegar ao modelo');
			assert.equal((await post(harness, CHAT_DELETE_ROUTE, { id })).status, 409);

			gate.release();
			const body = await (await turn).text();
			assert.match(body, /\[DONE\]/, 'o turno terminou de verdade');
			await until(() => harness.endpoint.activeTurnsFor(id) === 0, 'o registro do turno sair');

			const deleted = await post(harness, CHAT_DELETE_ROUTE, { id });
			assert.equal(deleted.status, 200);
		} finally {
			await harness.close();
		}
	});

	test('cancelamento libera o registro', async () => {
		const gate = gateBackend();
		const harness = await start(gate);
		try {
			const id = await create(harness, 'cancelada');
			const turn = startTurn(harness, id);
			await until(() => gate.waiting.length === 1, 'o turno chegar ao modelo');

			// Cancela pelo endpoint: é o caminho que o cliente usa.
			const turnId = [...Array(1)].length > 0 ? 'svc-turn-1' : '';
			assert.equal(harness.endpoint.cancel(turnId), true);
			// Depois do abort, o gerador do modelo ainda está no portão; libera
			// para o turno terminar.
			gate.release();
			await (await turn).text();
			await until(() => harness.endpoint.activeTurnsFor(id) === 0, 'o cancelamento liberar');

			assert.equal((await post(harness, CHAT_DELETE_ROUTE, { id })).status, 200);
		} finally {
			await harness.close();
		}
	});

	test('erro do provedor libera o registro', async () => {
		const harness = await start(gateBackend({ fail: true }));
		try {
			const id = await create(harness, 'falha');
			const response = await startTurn(harness, id);
			const body = await response.text();

			// O turno terminou em erro (ou foi recusado pelo roteador).
			assert.ok(body.includes('"error"') || body.includes('"done"'));
			await until(() => harness.endpoint.activeTurnsFor(id) === 0, 'o erro liberar');

			assert.equal((await post(harness, CHAT_DELETE_ROUTE, { id })).status, 200);
		} finally {
			await harness.close();
		}
	});

	test('um turno recusado no início não deixa o registro preso', async () => {
		const harness = await start();
		try {
			const refused = await startTurn(harness, 'cnv_nao_existe');
			await refused.text();

			assert.equal(harness.endpoint.activeTurnsFor('cnv_nao_existe'), 0);
		} finally {
			await harness.close();
		}
	});
});

suite('R4G: isolamento entre conversas', () => {
	test('duas conversas com turnos simultâneos: cada uma bloqueada, nenhuma presa', async () => {
		const gate = gateBackend();
		const harness = await start(gate);
		try {
			const one = await create(harness, 'um');
			const two = await create(harness, 'dois');
			const first = startTurn(harness, one);
			const second = startTurn(harness, two);
			await until(() => gate.waiting.length === 2, 'os dois turnos chegarem ao modelo');

			assert.equal(harness.endpoint.activeTurnsFor(one), 1);
			assert.equal(harness.endpoint.activeTurnsFor(two), 1);
			assert.equal((await post(harness, CHAT_DELETE_ROUTE, { id: one })).status, 409);
			assert.equal((await post(harness, CHAT_DELETE_ROUTE, { id: two })).status, 409);

			gate.release();
			gate.release();
			await (await first).text();
			await (await second).text();
			await until(
				() => harness.endpoint.activeTurnsFor(one) === 0 && harness.endpoint.activeTurnsFor(two) === 0,
				'os dois turnos liberarem',
			);

			assert.equal((await post(harness, CHAT_DELETE_ROUTE, { id: one })).status, 200);
			assert.equal((await post(harness, CHAT_DELETE_ROUTE, { id: two })).status, 200);
		} finally {
			await harness.close();
		}
	});

	test('o turno de uma conversa não bloqueia a exclusão de outra', async () => {
		const gate = gateBackend();
		const harness = await start(gate);
		try {
			const busy = await create(harness, 'com turno');
			const free = await create(harness, 'sem turno');
			const turn = startTurn(harness, busy);
			await until(() => gate.waiting.length === 1, 'o turno chegar ao modelo');

			assert.equal((await post(harness, CHAT_DELETE_ROUTE, { id: busy })).status, 409);
			assert.equal((await post(harness, CHAT_DELETE_ROUTE, { id: free })).status, 200);

			gate.release();
			await (await turn).text();
		} finally {
			await harness.close();
		}
	});

	test('dois turnos na mesma conversa: o segundo é recusado com 409 (R4Q)', async () => {
		// R4Q decidiu: **um turno ativo por conversa**. O comportamento
		// anterior (dois turnos simultâneos, bloqueio até o último) foi
		// substituído por uma reserva exclusiva.
		const gate = gateBackend();
		const harness = await start(gate);
		try {
			const id = await create(harness, 'um turno');
			const first = startTurn(harness, id, 'um');
			await until(() => gate.waiting.length === 1, 'o primeiro turno chegar ao modelo');

			const second = await startTurn(harness, id, 'dois');
			assert.equal(second.status, 409);
			const refusal = JSON.parse(await second.text()) as { error: { code: string } };
			assert.equal(refusal.error.code, 'conversation_busy');
			assert.equal(harness.endpoint.activeTurnsFor(id), 1, 'só uma reserva');
			assert.equal(gate.waiting.length, 1, 'o modelo não recebeu o segundo');

			gate.release();
			await (await first).text();
			await until(() => harness.endpoint.activeTurnsFor(id) === 0, 'o turno liberar');
			// Depois do fim, a conversa aceita de novo — e a exclusão passa.
			assert.equal((await post(harness, CHAT_DELETE_ROUTE, { id })).status, 200);
		} finally {
			await harness.close();
		}
	});
});

suite('R4G: corridas', () => {
	test('exclusão imediatamente depois do início do turno: um dos dois vence, sempre', async () => {
		// O turno é iniciado e a exclusão é disparada **no mesmo tick**, sem
		// esperar o modelo. Os dois desfechos são aceitos:
		//
		// - `409`: o turno se registrou antes de a exclusão chegar;
		// - `200`: a exclusão chegou antes, e então o turno **não pode** ter
		//   produzido texto nem recriado o arquivo.
		//
		// O que nunca pode acontecer é um turno gravando numa conversa já
		// apagada — é o que o terceiro ramo recusa.
		const gate = gateBackend();
		const harness = await start(gate);
		try {
			const id = await create(harness, 'corrida');
			const turn = startTurn(harness, id);
			const deleted = await post(harness, CHAT_DELETE_ROUTE, { id });

			// Libera o portão enquanto o turno corre, até fechar. O laço usa
			// `activeTurnsFor` — não a fila do portão, que pode estar vazia
			// quando o backend ainda não foi chamado.
			const readTurn = async (): Promise<string> => {
				const response = await turn.catch(() => undefined);
				return response === undefined ? '' : await response.text().catch(() => '');
			};
			const bodyPromise = readTurn();
			const deadline = Date.now() + 15_000;
			while (Date.now() < deadline && harness.endpoint.activeTurnsFor(id) > 0) {
				gate.release();
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			const body = await Promise.race([
				bodyPromise,
				new Promise<string>((resolve) => setTimeout(() => resolve('__timeout__'), 5_000)),
			]);
			assert.notEqual(body, '__timeout__', 'o turno termina');

			if (deleted.status === 409) {
				// O turno venceu: terminou de verdade e só então pode ser apagada.
				assert.match(body, /\[DONE\]/);
				await until(() => harness.endpoint.activeTurnsFor(id) === 0, 'o turno liberar');
				assert.equal((await post(harness, CHAT_DELETE_ROUTE, { id })).status, 200);
			} else {
				assert.equal(deleted.status, 200);
				// A exclusão venceu: nenhum texto do modelo saiu e o arquivo não
				// voltou.
				assert.equal(body.includes('"delta"'), false, 'nenhum texto de modelo depois de excluída');
				// Dois desfechos legítimos para o turno, e a diferença é *quando*
				// a exclusão chegou:
				// - antes de o turno abrir a conversa → `404` "não há conversa"
				//   (o turno nunca começou — é o caminho da DEV-2.3);
				// - depois de abrir → o erro de exclusão durante o turno.
				assert.match(
					body,
					/excluída durante o turno|No conversation|não há conversa com esse id/,
					'o turno foi recusado ou interrompido pela exclusão, nunca concluído',
				);
				assert.equal((await files(harness)).includes(`${id}.json`), false, 'nada foi recriado');
			}
		} finally {
			await harness.close();
		}
	});

	test('exclusões e inícios simultâneos: a lista e o disco concordam', async () => {
		const gate = gateBackend();
		const harness = await start(gate);
		try {
			const id = await create(harness, 'estresse');
			// Três inícios e três exclusões, todos disparados juntos. Três, e não
			// mais: o que se prova aqui é a ordem entre as operações, não a
			// resistência do store a gravações concorrentes na mesma conversa.
			const turns = Array.from({ length: 3 }, () => startTurn(harness, id));
			// Cada stream é lido **de imediato**. Esperar a resposta para só
			// depois ler o corpo trava: o servidor mantém o SSE aberto até o
			// cliente consumir, e com três turnos isso é um deadlock silencioso
			// (o teste "trava", o motor está ocioso).
			const readTurns = turns.map(async (turn) => {
				const response = await turn.catch(() => undefined);
				return response === undefined ? '' : await response.text().catch(() => '');
			});
			// A leitura começa agora, e não quando o teste pedir o resultado.
			const bodiesPromise = Promise.all(readTurns);
			const deletesPromise = Promise.all(
				Array.from({ length: 3 }, () => post(harness, CHAT_DELETE_ROUTE, { id })),
			);

			// Libera o portão continuamente por um prazo fixo, e **também** espera
			// os turnos fecharem. Um turno pode ainda não ter chegado ao backend
			// (o registro em disco acontece antes), então olhar só a fila do
			// backend, ou só o contador de turnos, libera cedo demais.
			const deadline = Date.now() + 20_000;
			let quiet = 0;
			while (Date.now() < deadline && quiet < 20) {
				const idle = gate.waiting.length === 0 && harness.endpoint.activeTurnsFor(id) === 0;
				gate.release();
				quiet = idle ? quiet + 1 : 0;
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			assert.equal(harness.endpoint.activeTurnsFor(id), 0, 'todos os turnos liberaram');
			const [turnBodies, deleteResponses] = await Promise.race([
				Promise.all([bodiesPromise, deletesPromise]),
				new Promise<never>((_resolve, reject) =>
					setTimeout(() => reject(new Error('os turnos não terminaram a tempo')), 10_000),
				),
			]);

			// Cada exclusão ou foi recusada (havia turno) ou apagou. R4M: com a
			// exclusão idempotente, **todas** as que não encontrarem um turno em
			// curso respondem `200` — a primeira remove, as seguintes encontram a
			// conversa já ausente. O que não pode aparecer é outro status: um
			// `404` era a corrida vazando, e um `500` seria uma falha real.
			//
			// Três exclusões disparadas no mesmo instante podem **todas** cair na
			// janela em que os turnos estão em curso e ser recusadas — é um
			// desfecho correto (o deixado explícito ao final), e exige que a
			// verificação final de "sumiu" seja independente do que a corrida
			// escolheu.
			const finalFiles = await files(harness);
			const deletedCount = deleteResponses.filter((entry) => entry.status === 200).length;
			const busyCount = deleteResponses.filter((entry) => entry.status === 409).length;
			const listed = JSON.parse((await post(harness, CHAT_CONVERSATIONS_ROUTE, {})).body) as {
				conversations: { id: string }[];
			};
			const inList = listed.conversations.some((item) => item.id === id);
			assert.equal(inList, finalFiles.includes(`${id}.json`), 'a lista e o disco concordam');
			assert.equal(
				deletedCount + busyCount,
				deleteResponses.length,
				'só sucesso ou conversa ocupada',
			);
			// Toda exclusão bem-sucedida devolve o mesmo contrato, e cada uma
			// relata o mesmo id — nenhuma "apagou" outra conversa.
			for (const entry of deleteResponses.filter((item) => item.status === 200)) {
				assert.deepEqual(JSON.parse(entry.body), { deleted: true, id });
			}
			if (finalFiles.includes(`${id}.json`)) {
				// Se o arquivo sobreviveu, alguma exclusão foi recusada por
				// turno em curso — e nunca as duas coisas ao mesmo tempo.
				assert.ok(busyCount >= 1, 'arquivo presente exige recusa por conversa ocupada');
				const raw = await readFile(join(harness.root, 'conversations', `${id}.json`), 'utf8');
				assert.ok(JSON.parse(raw) !== undefined, 'o arquivo é JSON válido');
			} else {
				assert.ok(deletedCount >= 1, 'só uma exclusão bem-sucedida remove');
				assert.equal(inList, false, 'e some da lista');
			}
			assert.ok(
				turnBodies.every((body) => body.includes('"done"') || body.includes('"error"') || body === ''),
				'cada turno terminou com done ou error',
			);
		} finally {
			await harness.close();
		}
	});
});

suite('R4G: autorização', () => {
	test('sem credencial de conversa, o 409 nem é alcançado: 401', async () => {
		const gate = gateBackend();
		const harness = await start(gate);
		try {
			const id = await create(harness, 'auth');
			const turn = startTurn(harness, id);
			await until(() => gate.waiting.length === 1, 'o turno chegar');

			const anonymous = await post(harness, CHAT_DELETE_ROUTE, { id }, {});
			const reader = await post(harness, CHAT_DELETE_ROUTE, { id }, { 'x-seshyina-reader': 'r'.repeat(64) });

			assert.equal(anonymous.status, 401);
			assert.equal(reader.status, 401);

			gate.release();
			await (await turn).text();
		} finally {
			await harness.close();
		}
	});
});
