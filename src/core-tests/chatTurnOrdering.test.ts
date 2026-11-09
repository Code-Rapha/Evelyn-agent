/**
 * R4O: a mensagem do usuário está no histórico antes da confirmação.
 *
 * ## A garantia que estes testes fixam
 *
 * Quando o serviço responde `200` e emite o SSE `started`, a mensagem do
 * usuário **já está gravada** no arquivo da conversa. Um `SIGKILL` logo em
 * seguida não a apaga — e nenhum modelo foi chamado antes disso.
 *
 * ## O defeito que a fase corrige
 *
 * Antes, o `started` saía com a mensagem ainda em memória: ela entrava numa
 * fila do store que começava depois de uma listagem de diretório. Matar o
 * processo naquele instante (o que a suíte fazia com frequência) perdia o
 * texto de forma definitiva.
 *
 * ## Falhas parciais
 *
 * Histórico e `turns.json` são arquivos diferentes e **não** são
 * transacionais entre si. A ordem escolhida é histórico → registro, e os
 * testes de falha injetada mostram o que fica em cada caso:
 *
 * - histórico falha → nada é confirmado, nenhum turno registrado;
 * - `turns.json` falha depois → nada é confirmado, o turno fica `failed`
 *   (nunca `running`) e a mensagem **permanece** no histórico;
 * - nova tentativa depois → a mensagem não é duplicada.
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
import { TURNS_FILE, TurnRecordStore } from '../core/storage/turnRecords';
import { failingWritePort } from '../adapters/local/writePort';
import { writeFileAtomic } from '../adapters/local/writeFileAtomic';
import type { WritePort } from '../adapters/local/writePort';
import type { FetchLike, FetchResponseLike } from '../core/providers/openaiCompatible';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const BASE_URL = 'http://127.0.0.1:12235/v1';
const CHAT_TOKEN = 'c'.repeat(64);
const MESSAGE = 'esta resposta nunca chega';

interface Gate {
	readonly fetchImpl: FetchLike;
	/** Quantas chamadas ao modelo aconteceram até agora. */
	readonly calls: { value: number };
	/** Libera **todos** os portões abertos (e os que abrirem depois). */
	release(): void;
	/**
	 * Libera quando o turno chegar ao backend.
	 *
	 * O turno só chama o modelo **depois** de gravar a mensagem e o registro;
	 * um `release()` sem esperar não teria a quem liberar, e o corpo nunca
	 * chegaria. `count` é o número de chamadas que se quer alcançar — num
	 * teste com dois turnos, o segundo espera a segunda chamada.
	 */
	releaseWhenCalled(count: number): Promise<void>;
}

function gateBackend(): Gate {
	const waiting: (() => void)[] = [];
	const calls = { value: 0 };
	const fetchImpl: FetchLike = async (url) => {
		if (url.endsWith('/models')) {
			return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'modelo-a' }] }) };
		}
		calls.value += 1;
		let release: (() => void) | undefined;
		// O portão é resolvido **antes** de entrar na fila: quitar um portão
		// que o turno ainda não abriu deixaria o `release()` sem efeito, e o
		// teste esperaria um corpo que ninguém libera.
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		waiting.push(() => release?.());
		const response: FetchResponseLike = {
			ok: true,
			status: 200,
			body: {
				[Symbol.asyncIterator]: async function* () {
					await gate;
					yield `data: ${JSON.stringify({ choices: [{ delta: { content: 'pronto' } }] })}\n\n`;
					yield 'data: [DONE]\n\n';
				},
			},
			text: async () => '',
		};
		return response;
	};
	return {
		fetchImpl,
		calls,
		release() {
			for (const resolve of waiting.splice(0)) {
				resolve();
			}
		},
		async releaseWhenCalled(count: number) {
			const deadline = Date.now() + 5_000;
			while (calls.value < count) {
				if (Date.now() > deadline) {
					throw new Error(`o modelo não foi chamado (${calls.value} de ${count})`);
				}
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			for (const resolve of waiting.splice(0)) {
				resolve();
			}
		},
	};
}

interface Harness {
	readonly root: string;
	readonly core: AssembledCore;
	readonly turns: TurnRecordStore;
	readonly endpoint: WebChatEndpoint;
	readonly server: RunningWebServer;
	readonly base: string;
	readonly gate: Gate;
	close(): Promise<void>;
}

async function start(
	gate: Gate = gateBackend(),
	options: { readonly writeFile?: WritePort } = {},
): Promise<Harness> {
	const root = await mkdtemp(join(tmpdir(), 'evelyn-r4o-'));
	const core = assembleCore({
		rootPath: root,
		logScope: 'test',
		logSink: new ConsoleLogSink({ out: () => undefined, err: () => undefined }),
		fetchImpl: gate.fetchImpl,
		...(options.writeFile !== undefined ? { writeFile: options.writeFile } : {}),
	});
	await core.chat.saveProvider({ id: 'local', name: 'Local', baseUrl: BASE_URL });
	await core.chat.listModels('local').catch(() => undefined);
	const turns = new TurnRecordStore({
		root,
		...(options.writeFile !== undefined ? { writeFile: options.writeFile } : {}),
	});
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
		gate,
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
	// O corpo de um evento SSE fica aberto até o turno terminar (ou até o
	// prazo do turno, 60 s): ler `text()` num teste que não libera o modelo
	// o manteria vivo além do `timeout` do mocha. A recusa tem corpo JSON
	// curto, e é ela que estes testes leem.
	return { status: response.status, body: await response.json().then(
		(value) => JSON.stringify(value),
		() => '',
	) };
}

async function create(harness: Harness, title: string): Promise<string> {
	const created = await post(harness, CHAT_CREATE_ROUTE, { providerId: 'local', title });
	assert.equal(created.status, 201, created.body);
	return (JSON.parse(created.body) as { conversation: { id: string } }).conversation.id;
}

/** Lê o histórico **do disco** (não de um cache em memória). */
async function onDisk(harness: Harness, conversationId: string): Promise<{
	readonly messages: readonly { readonly role: string; readonly content: string }[];
}> {
	const raw = await readFile(join(harness.root, 'conversations', `${conversationId}.json`), 'utf8');
	return JSON.parse(raw) as { messages: readonly { readonly role: string; readonly content: string }[] };
}

function userMessages(stored: Awaited<ReturnType<typeof onDisk>>): string[] {
	return stored.messages.filter((message) => message.role === 'user').map((message) => message.content);
}

/** Inicia o turno sem esperar o corpo: devolve a resposta para leitura do SSE. */
function startTurn(
	harness: Harness,
	conversationId: string,
	text = MESSAGE,
	extra: Record<string, unknown> = {},
): Promise<Response> {
	return fetch(`${harness.base}${CHAT_TURN_ROUTE}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', [CHAT_TOKEN_HEADER]: CHAT_TOKEN },
		body: JSON.stringify({ conversationId, providerId: 'local', model: 'local/modelo-a', text, ...extra }),
	});
}

teardown(async () => {
	// Cada teste fecha o seu harness.
});

suite('R4O: histórico confirmado antes do turno', () => {
	test('a mensagem está no disco no instante do 200 e do SSE `started`', async () => {
		const harness = await start();
		try {
			const id = await create(harness, 'ordem');

			const response = await startTurn(harness, id);
			assert.equal(response.status, 200);

			// Antes de o `started` ser lido, o arquivo já tem a mensagem: a
			// resposta só foi escrita depois da gravação no store.
			const stored = await onDisk(harness, id);
			assert.deepEqual(userMessages(stored), [MESSAGE]);

			const bodyPromise = response.text();
			await harness.gate.releaseWhenCalled(1);
			const body = await bodyPromise;
			assert.match(body, /"type":"started"/);
			// E depois do stream, continua tendo uma só.
			assert.deepEqual(userMessages(await onDisk(harness, id)), [MESSAGE]);
		} finally {
			await harness.close();
		}
	});

	test('o modelo é chamado só depois de a mensagem estar no disco', async () => {
		const harness = await start();
		try {
			const id = await create(harness, 'ordem do modelo');

			const turn = startTurn(harness, id);
			// O backend só é chamado quando o turno executa; na primeira vez
			// que aparece, o texto já tem de estar no histórico.
			const deadline = Date.now() + 5_000;
			while (harness.gate.calls.value === 0) {
				if (Date.now() > deadline) {
					assert.fail('o modelo nunca foi chamado');
				}
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			assert.deepEqual(userMessages(await onDisk(harness, id)), [MESSAGE]);

			await harness.gate.releaseWhenCalled(1);
			await (await turn).text();
		} finally {
			await harness.close();
		}
	});

	test('falha ao gravar o histórico: não há confirmação, nem turno, nem chamada ao modelo', async () => {
		// A falha vem pela **porta de gravação** do histórico (R4Q): nenhum
		// mecanismo de teste mora no store. A armadilha mira só o arquivo da
		// conversa criada, e só a partir do turno — a criação passa.
		let armed = false;
		let target: string | undefined;
		const harness = await start(undefined, {
			writeFile: async (path, contents) => {
				if (armed && target !== undefined && path.endsWith(`${target}.json`)) {
					armed = false;
					throw new Error('disco recusou a gravação (teste)');
				}
				await writeFileAtomic(path, contents);
			},
		});
		try {
			const id = await create(harness, 'histórico falha');
			target = id;
			armed = true;

			const answer = await post(harness, CHAT_TURN_ROUTE, {
				conversationId: id,
				providerId: 'local',
				model: 'local/modelo-a',
				text: MESSAGE,
			});

			assert.equal(answer.status, 500, answer.body);
			assert.equal((JSON.parse(answer.body) as { error: { code: string } }).error.code, 'message_not_persisted');
			assert.equal(answer.body.includes('"started"'), false, 'nenhum turno confirmado');
			// Nada foi escrito: nem a mensagem, nem o registro do turno.
			assert.deepEqual(userMessages(await onDisk(harness, id)), []);
			await assert.rejects(async () => await readFile(join(harness.root, TURNS_FILE), 'utf8'));
			// E o modelo nunca foi chamado.
			assert.equal(harness.gate.calls.value, 0);
			// A conversa continua utilizável: uma nova tentativa funciona.
			const retry = await startTurn(harness, id);
			assert.equal(retry.status, 200);
			assert.deepEqual(userMessages(await onDisk(harness, id)), [MESSAGE]);
			const retryBody = retry.text();
			await harness.gate.releaseWhenCalled(1);
			const retryText = await retryBody;
			assert.match(retryText, /"type":"started"/);
		} finally {
			await harness.close();
		}
	});

	test('falha ao gravar `turns.json` depois da mensagem: sem confirmação e sem `running`', async () => {
		// A porta do **registro** é injetada e falha uma vez: a mensagem é
		// gravada, o registro do turno não. A armadilha só arma depois da
		// conversa criada, para não atingir uma escrita anterior.
		let armed = false;
		const harness = await start(gateBackend(), {
			writeFile: async (path, contents) => {
				if (armed && path.endsWith(TURNS_FILE)) {
					armed = false;
					throw new Error('disco recusou a gravação do registro (teste)');
				}
				await writeFileAtomic(path, contents);
			},
		});
		try {
			const id = await create(harness, 'registro falha');
			armed = true;

			const answer = await post(harness, CHAT_TURN_ROUTE, {
				conversationId: id,
				providerId: 'local',
				model: 'local/modelo-a',
				text: MESSAGE,
			});

			assert.equal(answer.status, 503, answer.body);
			assert.equal((JSON.parse(answer.body) as { error: { code: string } }).error.code, 'turn_not_recorded');
			assert.equal(answer.body.includes('"started"'), false, 'nenhum turno confirmado');
			assert.equal(harness.gate.calls.value, 0, 'o modelo não foi chamado');

			// A mensagem persistida **permanece**: não se desfaz uma escrita
			// concluída só para fingir atomicidade.
			assert.deepEqual(userMessages(await onDisk(harness, id)), [MESSAGE]);

			// E nenhum `running` ficou no registro: um turno recusado não vira
			// "interrompido" na próxima inicialização.
			const state = await harness.turns.list();
			assert.equal(state.kind, 'valid');
			if (state.kind === 'valid') {
				assert.equal(
					state.turns.some((turn) => turn.status === 'running'),
					false,
					'nenhum turno em curso num pedido recusado',
				);
			}

			// R4Q: a nova tentativa é um **novo envio sem chave**. A mensagem
			// anterior — gravada antes de o registro falhar — permanece, e a
			// nova grava de novo: duas intenções, duas mensagens. Antes da
			// R4Q isto era "sem mensagem duplicada", porque a guarda por
			// conteúdo confundia retry com repetição intencional.
			const retry = await startTurn(harness, id);
			assert.equal(retry.status, 200);
			const retryBody = retry.text();

			const stored = await onDisk(harness, id);
			assert.deepEqual(userMessages(stored), [MESSAGE, MESSAGE], 'duas intenções, duas mensagens');
			// Um turno registrado: o da tentativa que venceu.
			const after = await harness.turns.forConversation(id);
			assert.equal(after.length, 1);
			await harness.gate.releaseWhenCalled(1);
			await retryBody;
		} finally {
			await harness.close();
		}
	});

	test('a mesma chave grava uma vez; sem chave, o mesmo texto é uma intenção nova (R4Q)', async () => {
		const harness = await start();
		try {
			const id = await create(harness, 'idempotência');

			// Mesma chave, simultâneas: uma grava, a outra devolve a existente.
			const withKey = await Promise.all([
				harness.core.chat.persistUserMessage(id, MESSAGE, 'req-1'),
				harness.core.chat.persistUserMessage(id, MESSAGE, 'req-1'),
			]);
			assert.equal(
				withKey.filter((result) => result.persisted).length,
				1,
				'uma gravação para uma chave',
			);
			assert.deepEqual(userMessages(await onDisk(harness, id)), [MESSAGE]);

			// Sem chave, o mesmo texto duas vezes é duas intenções: grava duas.
			const withoutKey = await Promise.all([
				harness.core.chat.persistUserMessage(id, MESSAGE),
				harness.core.chat.persistUserMessage(id, MESSAGE),
			]);
			assert.equal(withoutKey.filter((result) => result.persisted).length, 2);
			assert.deepEqual(userMessages(await onDisk(harness, id)), [MESSAGE, MESSAGE, MESSAGE]);

			// Chave diferente, mesmo texto: também é uma intenção nova.
			const otherKey = await harness.core.chat.persistUserMessage(id, MESSAGE, 'req-2');
			assert.equal(otherKey.persisted, true);
			assert.deepEqual(userMessages(await onDisk(harness, id)), [MESSAGE, MESSAGE, MESSAGE, MESSAGE]);
		} finally {
			await harness.close();
		}
	});

	test('a mesma pergunta repetida de propósito grava de novo (R4Q)', async () => {
		const harness = await start();
		try {
			const id = await create(harness, 'repetida de propósito');

			const first = await startTurn(harness, id);
			const firstBody = first.text();
			await harness.gate.releaseWhenCalled(1);
			await firstBody;
			// Espera o turno liberar a conversa.
			const deadline = Date.now() + 5_000;
			for (;;) {
				const second = await startTurn(harness, id);
				if (second.status === 200) {
					const secondBody = second.text();
					await harness.gate.releaseWhenCalled(2);
					await secondBody;
					break;
				}
				if (Date.now() > deadline) {
					assert.fail(`a conversa não liberou: ${second.status}`);
				}
				await new Promise((resolve) => setTimeout(resolve, 10));
			}

			// A primeira pergunta foi seguida de uma resposta: repetir o texto
			// é uma pergunta nova, não uma retomada.
			const messages = userMessages(await onDisk(harness, id));
			assert.deepEqual(messages, [MESSAGE, MESSAGE]);
		} finally {
			await harness.close();
		}
	});

	test('a exclusão durante a preparação continua recusada com 409', async () => {
		const harness = await start();
		try {
			const id = await create(harness, 'excluir durante');

			const turn = startTurn(harness, id);
			// A exclusão precisa chegar **com o turno já aceito**: enviar as
			// duas requisições "no mesmo instante" deixava o deletar vencer a
			// corrida (20 de 20 vezes, medido) e o `200` era o desfecho certo —
			// o teste passava só pela sorte do escalonamento. Aceitar o turno
			// primeiro é o cenário que este teste descreve.
			const accepted = await turn;
			assert.equal(accepted.status, 200);
			const acceptedBody = accepted.text();

			const deleted = await post(harness, CHAT_DELETE_ROUTE, { id });
			assert.equal(deleted.status, 409);
			assert.equal((JSON.parse(deleted.body) as { error: { code: string } }).error.code, 'conversation_busy');

			await harness.gate.releaseWhenCalled(1);
			await acceptedBody;
			// A conversa e a mensagem continuam lá.
			assert.deepEqual(userMessages(await onDisk(harness, id)), [MESSAGE]);
		} finally {
			await harness.close();
		}
	});

	test('desconectar durante a preparação não duplica a mensagem nem deixa `running` órfão', async () => {
		const harness = await start();
		try {
			const id = await create(harness, 'desconexão');

			// O cliente abandona a resposta **durante** a preparação (gravação
			// do histórico e do registro). O que importa é o estado final: a
			// mensagem gravada no máximo uma vez, e nenhum turno que a
			// recuperação não consiga fechar.
			const controller = new AbortController();
			const turn = fetch(`${harness.base}${CHAT_TURN_ROUTE}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', [CHAT_TOKEN_HEADER]: CHAT_TOKEN },
				body: JSON.stringify({ conversationId: id, providerId: 'local', model: 'local/modelo-a', text: MESSAGE }),
				signal: controller.signal,
			}).catch(() => undefined);
			controller.abort();
			void turn;

			// O servidor termina de aceitar (ou recusa) o pedido; a partir
			// daqui nada mais escreve nessa conversa por este turno.
			await new Promise((resolve) => setTimeout(resolve, 200));

			const recordedBefore = await harness.turns.list();
			const hadRunningBefore =
				recordedBefore.kind === 'valid' &&
				recordedBefore.turns.some((record) => record.status === 'running');

			// A recuperação fecha qualquer `running` como interrompido — e o
			// faz exatamente uma vez, se havia um.
			const recovered = await new TurnRecordStore({ root: harness.root }).recover();
			assert.equal(
				recovered.interrupted,
				hadRunningBefore ? 1 : 0,
				'interrompidos = os que estavam `running`',
			);
			const afterRecovery = await new TurnRecordStore({ root: harness.root }).forConversation(id);
			assert.equal(
				afterRecovery.some((turn) => turn.status === 'running'),
				false,
				'nenhum turno em curso depois da recuperação',
			);

			const stored = await onDisk(harness, id);
			const count = userMessages(stored).filter((message) => message === MESSAGE).length;
			assert.ok(count <= 1, `mensagem gravada ${count} vezes`);

			// A retomada funciona e não repete o texto já gravado.
			const callsBefore = harness.gate.calls.value;
			const retry = await startTurn(harness, id);
			assert.equal(retry.status, 200, 'a conversa voltou a aceitar turno');
			const retryBody = retry.text();
			const after = await onDisk(harness, id);
			assert.deepEqual(
				userMessages(after).filter((message) => message === MESSAGE).length,
				1,
				'a retomada não duplica a mensagem da tentativa abandonada',
			);
			await harness.gate.releaseWhenCalled(callsBefore + 1);
			await retryBody;
		} finally {
			await harness.close();
		}
	});
});

suite('R4Q: finalização do turno', () => {
	test('o estado terminal é gravado antes de a reserva ser liberada', async () => {
		const harness = await start();
		try {
			const id = await create(harness, 'finalização');

			const turn = await startTurn(harness, id);
			assert.equal(turn.status, 200);
			const bodyPromise = turn.text();
			await harness.gate.releaseWhenCalled(1);
			await bodyPromise;

			// Quando a reserva já não existe, o registro tem de estar fechado:
			// quem aceita um novo turno logo depois não pode ler `running`.
			const deadline = Date.now() + 5_000;
			while (harness.endpoint.activeTurnsFor(id) > 0) {
				if (Date.now() > deadline) {
					assert.fail('a reserva não foi liberada');
				}
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			const recorded = await harness.turns.forConversation(id);
			assert.equal(recorded.length, 1);
			assert.notEqual(recorded[0]?.status, 'running', 'o turno já está terminal');
			assert.equal(recorded[0]?.status, 'completed');
		} finally {
			await harness.close();
		}
	});

	test('um turno que falha não é reclassificado como `interrupted` ao encerrar', async () => {
		// Turno com erro do backend; o registro fecha `failed` **antes** da
		// reserva ser liberada. Uma queda logo depois encontra `failed`.
		const harness = await start({
			fetchImpl: async () => {
				throw Object.assign(new Error('o provedor falhou'), { errorClass: 'unavailable', httpStatus: 503 });
			},
			calls: { value: 0 },
			release() {},
			async releaseWhenCalled() {},
		});
		try {
			const id = await create(harness, 'falha final');

			const turn = await startTurn(harness, id);
			assert.equal(turn.status, 200);
			await turn.text();

			const deadline = Date.now() + 5_000;
			while (harness.endpoint.activeTurnsFor(id) > 0) {
				if (Date.now() > deadline) {
					assert.fail('a reserva não foi liberada');
				}
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			const recorded = await harness.turns.forConversation(id);
			assert.equal(recorded[0]?.status, 'failed', 'terminal e correto antes de liberar');

			// A recuperação não tem o que reclassificar.
			const recovered = await new TurnRecordStore({ root: harness.root }).recover();
			assert.equal(recovered.interrupted, 0);
		} finally {
			await harness.close();
		}
	});
});

suite('R4Q: compatibilidade com históricos anteriores', () => {
	test('uma conversa sem `requestId` continua legível e pode receber turno', async () => {
		const harness = await start();
		try {
			const id = await create(harness, 'antiga');
			// Reescreve o arquivo no formato anterior à R4Q: mensagens sem
			// `requestId`.
			const path = join(harness.root, 'conversations', `${id}.json`);
			const raw = JSON.parse(await readFile(path, 'utf8')) as {
				messages: readonly unknown[];
			};
			const legacy = {
				version: 1,
				id,
				providerId: 'local',
				title: 'antiga',
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				messages: [
					{ id: 'm1', seq: 0, role: 'user', content: 'mensagem antiga', createdAt: new Date().toISOString() },
					{ id: 'm2', seq: 1, role: 'assistant', content: 'resposta antiga', createdAt: new Date().toISOString() },
				],
			};
			await writeFileAtomic(path, `${JSON.stringify(legacy, null, 2)}\n`);
			void raw;

			const opened = await harness.core.chat.openConversation(id);
			assert.equal(opened.messages.length, 2);
			assert.equal(opened.messages[0]?.content, 'mensagem antiga');

			// E recebe um turno novo, que grava a chave.
			const turn = await startTurn(harness, id, 'nova pergunta');
			assert.equal(turn.status, 200);
			const bodyPromise = turn.text();
			await harness.gate.releaseWhenCalled(1);
			await bodyPromise;

			const stored = JSON.parse(await readFile(path, 'utf8')) as {
				messages: readonly { readonly role: string; readonly content: string; readonly requestId?: string }[];
			};
			assert.deepEqual(
				stored.messages.map((message) => message.content),
				['mensagem antiga', 'resposta antiga', 'nova pergunta', 'pronto'],
			);
		} finally {
			await harness.close();
		}
	});
});
