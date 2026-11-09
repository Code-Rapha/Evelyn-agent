/**
 * R4E: criar conversas pelo serviço.
 *
 * ## O que é real
 *
 * O serviço (`assembleCore` + `ChatSession.createConversation`), o
 * `FileDataStore` no disco, as rotas, a autenticação e a serialização. A
 * conversa é criada pelo **mesmo** método do modo local.
 *
 * ## O que não é real
 *
 * O provedor de modelo (`fetchImpl` determinístico), como em R4C/R4D. Só os
 * testes que enviam um turno chegam a falar com ele.
 */
import * as assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assembleCore, type AssembledCore } from '../app/assemble';
import { ConsoleLogSink } from '../adapters/local/consoleLogSink';
import {
	CHAT_CREATE_ROUTE,
	CHAT_CONVERSATIONS_ROUTE,
	CHAT_CONVERSATION_ROUTE,
	CHAT_TOKEN_HEADER,
	CHAT_TURN_ROUTE,
	startWebServer,
	type RunningWebServer,
} from '../web/server';
import { WebChatEndpoint } from '../web/chatEndpoint';
import type { FetchLike, FetchResponseLike } from '../core/providers/openaiCompatible';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const BASE_URL = 'http://127.0.0.1:12227/v1';
const CHAT_TOKEN = 'c'.repeat(64);
const READER_TOKEN = 'r'.repeat(64);

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

function testBackend(): FetchLike {
	return async (url) => {
		if (url.endsWith('/models')) {
			return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'modelo-a' }] }) };
		}
		return sseText('resposta');
	};
}

interface Harness {
	readonly root: string;
	readonly core: AssembledCore;
	readonly server: RunningWebServer;
	readonly base: string;
	close(): Promise<void>;
}

async function start(): Promise<Harness> {
	const root = await mkdtemp(join(tmpdir(), 'evelyn-r4e-'));
	const core = assembleCore({
		rootPath: root,
		logScope: 'test',
		logSink: new ConsoleLogSink({ out: () => undefined, err: () => undefined }),
		fetchImpl: testBackend(),
	});
	await core.chat.saveProvider({ id: 'local', name: 'Local', baseUrl: BASE_URL });
	await core.chat.listModels('local').catch(() => undefined);
	const server = await startWebServer({
		version: 'test',
		assetsDir: join(process.cwd(), 'dist', 'web', 'assets'),
		core,
		readerToken: READER_TOKEN,
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

teardown(async () => {
	// Cada teste fecha o seu harness.
});

suite('R4E: criar uma conversa', () => {
	test('cria, devolve 201 e a conversa aparece na listagem real', async () => {
		const harness = await start();
		try {
			const created = await post(harness, CHAT_CREATE_ROUTE, {
				providerId: 'local',
				title: 'nova conversa',
			});

			assert.equal(created.status, 201);
			const parsed = JSON.parse(created.body) as {
				conversation: { id: string; title: string; messageCount: number; createdAt: string };
			};
			assert.equal(parsed.conversation.title, 'nova conversa');
			assert.equal(typeof parsed.conversation.id, 'string');
			assert.ok(parsed.conversation.id.length > 0);

			const listed = await post(harness, CHAT_CONVERSATIONS_ROUTE, {});
			const listBody = JSON.parse(listed.body) as { conversations: { id: string }[] };
			assert.ok(
				listBody.conversations.some((item) => item.id === parsed.conversation.id),
				'a conversa criada está na lista',
			);
		} finally {
			await harness.close();
		}
	});

	test('o arquivo da conversa existe no disco (persistido pelo Core)', async () => {
		const harness = await start();
		try {
			const created = JSON.parse(
				(await post(harness, CHAT_CREATE_ROUTE, { providerId: 'local' })).body,
			) as { conversation: { id: string } };

			const files = await readdir(join(harness.root, 'conversations'));
			assert.ok(files.includes(`${created.conversation.id}.json`));
		} finally {
			await harness.close();
		}
	});

	test('sem título, o Core aplica o padrão dele', async () => {
		const harness = await start();
		try {
			const created = JSON.parse(
				(await post(harness, CHAT_CREATE_ROUTE, { providerId: 'local' })).body,
			) as { conversation: { title: string } };

			// O padrão é do Core, não desta rota: só se afirma que veio um.
			assert.ok(created.conversation.title.length > 0);
		} finally {
			await harness.close();
		}
	});

	test('criar, enviar uma mensagem e reabrir: o histórico está lá', async () => {
		const harness = await start();
		try {
			const created = JSON.parse(
				(await post(harness, CHAT_CREATE_ROUTE, { providerId: 'local', title: 'fluxo' })).body,
			) as { conversation: { id: string } };
			const id = created.conversation.id;

			const turn = await post(harness, CHAT_TURN_ROUTE, {
				conversationId: id,
				providerId: 'local',
				model: 'local/modelo-a',
				text: 'primeira mensagem',
			});
			assert.equal(turn.status, 200);
			assert.ok(turn.body.includes('[DONE]') || turn.body.includes('data: '));

			const opened = JSON.parse((await post(harness, CHAT_CONVERSATION_ROUTE, { id })).body) as {
				messages: readonly { role: string; content: string }[];
				conversation: { messageCount: number };
			};

			assert.ok(opened.messages.some((message) => message.content === 'primeira mensagem'));
			assert.ok(opened.messages.some((message) => message.role === 'assistant'));
			// A contagem que o serviço publica é a que ele gravou.
			assert.ok(opened.conversation.messageCount >= opened.messages.length);
		} finally {
			await harness.close();
		}
	});

	test('duas criações concorrentes: identificadores distintos e ambas na lista', async () => {
		const harness = await start();
		try {
			const [first, second] = await Promise.all([
				post(harness, CHAT_CREATE_ROUTE, { providerId: 'local', title: 'a' }),
				post(harness, CHAT_CREATE_ROUTE, { providerId: 'local', title: 'b' }),
			]);
			assert.equal(first.status, 201);
			assert.equal(second.status, 201);

			const idOne = (JSON.parse(first.body) as { conversation: { id: string } }).conversation.id;
			const idTwo = (JSON.parse(second.body) as { conversation: { id: string } }).conversation.id;
			assert.notEqual(idOne, idTwo);

			const listed = JSON.parse((await post(harness, CHAT_CONVERSATIONS_ROUTE, {})).body) as {
				conversations: { id: string }[];
			};
			const ids = listed.conversations.map((item) => item.id);
			assert.ok(ids.includes(idOne));
			assert.ok(ids.includes(idTwo));
			assert.equal(ids.filter((id) => id === idOne).length, 1, 'nenhuma duplicata');
		} finally {
			await harness.close();
		}
	});

	test('um provedor desconhecido é 400, sem publicar a mensagem interna', async () => {
		const harness = await start();
		try {
			const answer = await post(harness, CHAT_CREATE_ROUTE, { providerId: 'nao-existe' });

			assert.equal(answer.status, 400);
			assert.equal(answer.body.includes('No provider named'), false, 'mensagem interna do Core');
			assert.equal(answer.body.includes(harness.root), false);
		} finally {
			await harness.close();
		}
	});

	test('campos internos são recusados explicitamente', async () => {
		const harness = await start();
		try {
			for (const field of ['projectId', 'systemPrompt', 'id', 'path']) {
				const answer = await post(harness, CHAT_CREATE_ROUTE, {
					providerId: 'local',
					[field]: 'valor',
				});
				assert.equal(answer.status, 400, `"${field}" não pode ser aceito`);
				assert.match(answer.body, new RegExp(field));
			}
		} finally {
			await harness.close();
		}
	});

	test('providerId vazio, ausente ou grande demais é 400; título grande é 400', async () => {
		const harness = await start();
		try {
			const cases = [
				{ providerId: '' },
				{},
				{ providerId: 'x'.repeat(500) },
				{ providerId: 'local', title: 't'.repeat(500) },
				{ providerId: 'local', title: 42 },
			];
			for (const body of cases) {
				const answer = await post(harness, CHAT_CREATE_ROUTE, body);
				assert.equal(answer.status, 400, JSON.stringify(body).slice(0, 40));
			}
		} finally {
			await harness.close();
		}
	});

	test('sem credencial é 401; o readerToken não cria', async () => {
		const harness = await start();
		try {
			const anonymous = await post(harness, CHAT_CREATE_ROUTE, { providerId: 'local' }, {});
			const reader = await post(
				harness,
				CHAT_CREATE_ROUTE,
				{ providerId: 'local' },
				{ 'x-seshyina-reader': READER_TOKEN },
			);

			assert.equal(anonymous.status, 401);
			assert.equal(reader.status, 401);
			// E nada foi criado.
			const listed = JSON.parse((await post(harness, CHAT_CONVERSATIONS_ROUTE, {})).body) as {
				conversations: unknown[];
			};
			assert.equal(listed.conversations.length, 0);
		} finally {
			await harness.close();
		}
	});

	test('a resposta não traz credencial, caminho nem configuração privada', async () => {
		const harness = await start();
		try {
			const created = await post(harness, CHAT_CREATE_ROUTE, { providerId: 'local' });
			const parsed = JSON.parse(created.body) as { conversation: Record<string, unknown> };

			assert.deepEqual(Object.keys(parsed.conversation).sort(), [
				'createdAt',
				'id',
				'messageCount',
				'title',
				'updatedAt',
			]);
			assert.equal(created.body.includes(CHAT_TOKEN), false);
			assert.equal(created.body.includes(harness.root), false);
			assert.equal(created.body.includes('providerId'), false);
		} finally {
			await harness.close();
		}
	});
});
