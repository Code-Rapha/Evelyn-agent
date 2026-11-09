/**
 * R4M: exclusão de conversa idempotente.
 *
 * ## O defeito que esta fase corrige
 *
 * Duas exclusões concorrentes da mesma conversa davam `200` e `404` ao acaso:
 * a segunda encontrava o arquivo já removido e virava "não há conversa com
 * esse id". O resultado dependia de qual requisição chegou primeiro — não de
 * um dado do usuário.
 *
 * ## O contrato agora
 *
 * - `200 { deleted: true, id }` quando a remoção acontece **e** quando a
 *   conversa já não está lá (exclusão concorrente, anterior ou inexistente);
 * - `409 conversation_busy` quando há turno em curso — inalterado;
 * - `500` quando a lista **não pôde ser confirmada**: um erro de leitura não
 *   vira "já não existia";
 * - erro de remoção sobe como falha, nunca como sucesso.
 *
 * O risco de transformar erro em sucesso estava em `false`, que o store usava
 * para dizer tanto "não está na lista" quanto "não consegui ler". Por isso o
 * teste de I/O remove o diretório **entre** duas instâncias: a primeira já
 * sabe que a conversa existe (lista confirmada), a segunda não.
 */
import * as assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileDataStore } from '../adapters/local/fileDataStore';
import { assembleCore, type AssembledCore } from '../app/assemble';
import { ConsoleLogSink } from '../adapters/local/consoleLogSink';
import { StorageError } from '../core/errors';
import {
	CHAT_CONVERSATIONS_ROUTE,
	CHAT_CREATE_ROUTE,
	CHAT_DELETE_ROUTE,
	CHAT_TOKEN_HEADER,
	startWebServer,
	type RunningWebServer,
} from '../web/server';
import { WebChatEndpoint } from '../web/chatEndpoint';
import type { FetchLike } from '../core/providers/openaiCompatible';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const BASE_URL = 'http://127.0.0.1:12232/v1';
const CHAT_TOKEN = 'c'.repeat(64);
const READER_TOKEN = 'r'.repeat(64);

const roots: string[] = [];

async function makeRoot(prefix = 'evelyn-r4m-'): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	roots.push(root);
	return root;
}

teardown(async () => {
	for (const root of roots.splice(0)) {
		await removeFixtureTree(root).catch(() => undefined);
	}
});

/** Um backend que responde na hora: a exclusão e o turno não dependem dele. */
const instantBackend: FetchLike = async (url) => {
	if (url.endsWith('/models')) {
		return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'modelo-a' }] }) };
	}
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

interface Harness {
	readonly root: string;
	readonly core: AssembledCore;
	readonly server: RunningWebServer;
	readonly base: string;
	close(): Promise<void>;
}

async function start(): Promise<Harness> {
	const root = await makeRoot();
	const core = assembleCore({
		rootPath: root,
		logScope: 'test',
		logSink: new ConsoleLogSink({ out: () => undefined, err: () => undefined }),
		fetchImpl: instantBackend,
	});
	await core.chat.saveProvider({ id: 'local', name: 'Local', baseUrl: BASE_URL });
	await core.chat.listModels('local').catch(() => undefined);
	const endpoint = new WebChatEndpoint({ session: core.chat });
	const server = await startWebServer({
		version: 'test',
		assetsDir: join(process.cwd(), 'dist', 'web', 'assets'),
		core,
		readerToken: READER_TOKEN,
		chatToken: CHAT_TOKEN,
		chat: endpoint,
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
	assert.equal(created.status, 201, created.body);
	return (JSON.parse(created.body) as { conversation: { id: string } }).conversation.id;
}

async function listIds(harness: Harness): Promise<string[]> {
	const listed = await post(harness, CHAT_CONVERSATIONS_ROUTE, {});
	const body = JSON.parse(listed.body) as { conversations: { id: string }[] };
	return body.conversations.map((item) => item.id);
}

async function conversationFiles(root: string): Promise<string[]> {
	return await readdir(join(root, 'conversations')).catch(() => []);
}

suite('R4M: o store diz qual ausência encontrou', () => {
	test('a primeira exclusão remove; as seguintes encontram `absent`', async () => {
		const root = await makeRoot();
		const store = new FileDataStore({ rootPath: root });
		const conversation = await store.createConversation({ title: 'Uma vez' });
		await store.listConversations();

		assert.equal(await store.deleteConversation(conversation.id), 'deleted');
		assert.equal(await store.deleteConversation(conversation.id), 'absent');
		assert.equal(await store.deleteConversation(conversation.id), 'absent');
	});

	test('um id que nunca existiu é também `absent`, não um erro', async () => {
		const root = await makeRoot();
		const store = new FileDataStore({ rootPath: root });
		await store.listConversations();

		assert.equal(await store.deleteConversation('cnv_fantasma'), 'absent');
	});

	test('instalação nova (sem diretório) é `absent` confirmado', async () => {
		const root = await makeRoot();
		const store = new FileDataStore({ rootPath: root });

		// Nem `conversations/` existe ainda: a leitura deu `ENOENT`, que é uma
		// lista vazia **confirmada**.
		assert.equal(await store.deleteConversation('cnv_1'), 'absent');
	});

	test('duas exclusões simultâneas: exatamente um `deleted`, o resto `absent`', async () => {
		const root = await makeRoot();
		const store = new FileDataStore({ rootPath: root });
		const conversation = await store.createConversation({ title: 'Corrida' });
		await store.listConversations();

		const outcomes = await Promise.all(
			Array.from({ length: 6 }, () => store.deleteConversation(conversation.id)),
		);

		assert.equal(outcomes.filter((outcome) => outcome === 'deleted').length, 1);
		assert.equal(outcomes.filter((outcome) => outcome === 'absent').length, 5);
	});

	test('erro de remoção sobe como StorageError — nunca `deleted`', async () => {
		const root = await makeRoot();
		const store = new FileDataStore({ rootPath: root });
		const conversation = await store.createConversation({ title: 'Bloqueada' });
		await store.listConversations();

		// Troca o arquivo por um **diretório** no mesmo caminho: `rm` com
		// `force` não apaga diretório (`EPERM`/`EISDIR`, conforme a
		// plataforma), então a remoção falha de verdade — e o erro tem de
		// subir, não virar `deleted`.
		const path = join(root, 'conversations', `${conversation.id}.json`);
		await rm(path, { force: true });
		await mkdir(path);

		await assert.rejects(
			async () => await store.deleteConversation(conversation.id),
			(error: unknown) => {
				assert.equal(error instanceof StorageError, true);
				return true;
			},
		);

		// E o que estava no lugar não foi "apagado com sucesso": a entrada
		// continua lá, o que prova que nenhum `deleted` foi inventado.
		assert.deepEqual(await readdir(join(root, 'conversations')), [`${conversation.id}.json`]);
	});

	test('se a lista não pôde ser lida, a ausência é `unknown`, não `absent`', async () => {
		const dir = await makeRoot();
		// O diretório de conversas existe como **arquivo**: `readdir` falha
		// com `ENOTDIR` — um erro de leitura real, não uma lista vazia.
		await writeFile(join(dir, 'conversations'), 'não é um diretório', 'utf8');
		const store = new FileDataStore({ rootPath: dir });

		// A listagem propaga o erro (é falha de leitura, não ausência).
		await assert.rejects(async () => await store.listConversations());

		// E a exclusão **não** o transforma em sucesso: "não há conversa" é
		// exatamente a conclusão que este estado não permite tirar.
		assert.equal(await store.deleteConversation('cnv_1'), 'unknown');
	});

	test('a listagem vazia confirmada continua permitindo excluir com sucesso', async () => {
		// Contraprova da marca acima: um diretório que existe e está vazio é
		// uma lista vazia de verdade — `absent`, não `unknown`.
		const dir = await makeRoot();
		await mkdir(join(dir, 'conversations'));
		const store = new FileDataStore({ rootPath: dir });

		assert.deepEqual(await store.listConversations(), []);
		assert.equal(await store.deleteConversation('cnv_1'), 'absent');
	});
});

suite('R4M: a rota de exclusão é idempotente', () => {
	test('duas exclusões simultâneas dão 200 nas duas, com o mesmo corpo', async () => {
		const harness = await start();
		try {
			const id = await create(harness, 'simultâneas');

			const answers = await Promise.all([
				post(harness, CHAT_DELETE_ROUTE, { id }),
				post(harness, CHAT_DELETE_ROUTE, { id }),
			]);

			for (const answer of answers) {
				assert.equal(answer.status, 200, answer.body);
				assert.deepEqual(JSON.parse(answer.body), { deleted: true, id });
			}
			assert.equal((await listIds(harness)).includes(id), false);
			assert.equal((await conversationFiles(harness.root)).includes(`${id}.json`), false);
		} finally {
			await harness.close();
		}
	});

	test('seis exclusões concorrentes: todas 200, e a conversa some uma vez', async () => {
		const harness = await start();
		try {
			const other = await create(harness, 'fica');
			const id = await create(harness, 'muitas');

			const answers = await Promise.all(
				Array.from({ length: 6 }, () => post(harness, CHAT_DELETE_ROUTE, { id })),
			);

			assert.equal(
				answers.every((answer) => answer.status === 200),
				true,
				answers.map((answer) => answer.status).join(','),
			);
			const ids = await listIds(harness);
			assert.deepEqual(ids, [other], 'só a outra sobra, e intacta');
			const files = await conversationFiles(harness.root);
			assert.deepEqual(
				files.filter((name) => name.endsWith('.json')),
				[`${other}.json`],
			);
		} finally {
			await harness.close();
		}
	});

	test('exclusão repetida depois de já ausente: 200', async () => {
		const harness = await start();
		try {
			const id = await create(harness, 'repetida');
			assert.equal((await post(harness, CHAT_DELETE_ROUTE, { id })).status, 200);
			assert.equal((await post(harness, CHAT_DELETE_ROUTE, { id })).status, 200);
			assert.equal((await post(harness, CHAT_DELETE_ROUTE, { id })).status, 200);
		} finally {
			await harness.close();
		}
	});

	test('id inexistente desde o início: 200 (a ausência é o estado pedido)', async () => {
		const harness = await start();
		try {
			const answer = await post(harness, CHAT_DELETE_ROUTE, { id: 'cnv_que_nunca_existiu' });
			assert.equal(answer.status, 200);
			assert.deepEqual(JSON.parse(answer.body), { deleted: true, id: 'cnv_que_nunca_existiu' });
		} finally {
			await harness.close();
		}
	});

	test('excluir uma conversa não apaga as vizinhas nem muda o histórico', async () => {
		const harness = await start();
		try {
			const keep = await create(harness, 'com histórico');
			await post(harness, '/api/chat/turn', {
				conversationId: keep,
				providerId: 'local',
				model: 'local/modelo-a',
				text: 'guardar isto',
			});
			const gone = await create(harness, 'sai');
			const withHistory = JSON.parse(
				(await post(harness, '/api/chat/conversation', { id: keep })).body,
			) as { messages: readonly unknown[] };

			await Promise.all([
				post(harness, CHAT_DELETE_ROUTE, { id: gone }),
				post(harness, CHAT_DELETE_ROUTE, { id: gone }),
			]);
			await post(harness, CHAT_DELETE_ROUTE, { id: 'cnv_inexistente' });

			const after = JSON.parse(
				(await post(harness, '/api/chat/conversation', { id: keep })).body,
			) as { messages: readonly unknown[] };
			assert.deepEqual(after.messages, withHistory.messages);
			assert.equal(withHistory.messages.length > 0, true);
		} finally {
			await harness.close();
		}
	});
});

suite('R4M: autorização, validação e persistem consistência', () => {
	test('sem credencial e com o leitor: 401, e a conversa fica', async () => {
		const harness = await start();
		try {
			const id = await create(harness, 'intocada');

			assert.equal((await post(harness, CHAT_DELETE_ROUTE, { id }, {})).status, 401);
			assert.equal(
				(await post(harness, CHAT_DELETE_ROUTE, { id }, { 'x-seshyina-reader': READER_TOKEN })).status,
				401,
			);
			assert.deepEqual(await listIds(harness), [id]);
		} finally {
			await harness.close();
		}
	});

	test('id inválido continua 400, e nada é excluído', async () => {
		const harness = await start();
		try {
			const id = await create(harness, 'protegida');
			for (const body of [{}, { id: '' }, { id: 'x'.repeat(500) }, { id: 42 }, { id, extra: 1 }]) {
				const answer = await post(harness, CHAT_DELETE_ROUTE, body);
				assert.equal(answer.status, 400, JSON.stringify(body).slice(0, 40));
			}
			assert.deepEqual(await listIds(harness), [id]);
		} finally {
			await harness.close();
		}
	});

	test('a rota responde 500 quando a ausência não pôde ser confirmada', async () => {
		// A rota precisa **não** virar 200 em cima de um `unknown`. O store
		// real é trocado por um que responde exatamente isso: assim o contrato
		// da rota é verificado sem depender de como o sistema de arquivos falha
		// nesta máquina (o caminho de I/O real está coberto no store, acima).
		const root = await makeRoot();
		const core = assembleCore({
			rootPath: root,
			logScope: 'test',
			logSink: new ConsoleLogSink({ out: () => undefined, err: () => undefined }),
			fetchImpl: instantBackend,
		});
		core.chat.deleteConversation = async () => 'unknown';
		const endpoint = new WebChatEndpoint({ session: core.chat });
		const server = await startWebServer({
			version: 'test',
			assetsDir: join(process.cwd(), 'dist', 'web', 'assets'),
			core,
			chatToken: CHAT_TOKEN,
			chat: endpoint,
			port: 0,
		});
		try {
			const response = await fetch(`http://127.0.0.1:${server.port}${CHAT_DELETE_ROUTE}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', [CHAT_TOKEN_HEADER]: CHAT_TOKEN },
				body: JSON.stringify({ id: 'cnv_1' }),
			});
			const body = await response.text();

			assert.equal(response.status, 500, body);
			assert.equal(body.includes('"deleted"'), false, 'nenhum sucesso falso');
			// E o caminho do arquivo não vaza na mensagem.
			assert.equal(body.includes(root), false);
			assert.equal(body.includes('conversations'), false);
		} finally {
			await server.close();
			core.chat.dispose();
		}
	});

	test('a listagem e o disco concordam depois das exclusões concorrentes', async () => {
		const harness = await start();
		try {
			const keepOne = await create(harness, 'um');
			const keepTwo = await create(harness, 'dois');
			const doomed = await create(harness, 'condenada');

			await Promise.all(
				Array.from({ length: 4 }, () => post(harness, CHAT_DELETE_ROUTE, { id: doomed })),
			);

			const listed = (await listIds(harness)).sort();
			const onDisk = (await conversationFiles(harness.root))
				.filter((name) => name.endsWith('.json'))
				.map((name) => name.slice(0, -'.json'.length))
				.sort();
			assert.deepEqual(listed, onDisk, 'lista e disco contam a mesma história');
			assert.deepEqual(listed, [keepOne, keepTwo].sort());
			// E os arquivos sobreviventes são JSON válidos.
			for (const name of await conversationFiles(harness.root)) {
				if (name.endsWith('.json')) {
					const raw = await readFile(join(harness.root, 'conversations', name), 'utf8');
					assert.ok(JSON.parse(raw) !== undefined);
				}
			}
		} finally {
			await harness.close();
		}
	});
});
