/**
 * R4D: listagem e abertura do histórico pelo serviço.
 *
 * ## O que é real
 *
 * O serviço (`assembleCore` + `ChatSession` + `WebChatEndpoint`), o
 * `FileDataStore` no disco, as rotas HTTP, a autenticação e a serialização. As
 * conversas são criadas **de verdade** pelo Core e gravadas em arquivo.
 *
 * ## O que não é real
 *
 * O provedor de modelo: o `fetchImpl` determinístico do `assembleCore`, usado
 * nos testes de turno. Só o teste de continuidade chega a falar com ele.
 */
import * as assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assembleCore, type AssembledCore } from '../app/assemble';
import { ConsoleLogSink } from '../adapters/local/consoleLogSink';
import {
	CHAT_TOKEN_HEADER,
	CHAT_CONVERSATION_ROUTE,
	CHAT_CONVERSATIONS_ROUTE,
	CHAT_TURN_ROUTE,
	startWebServer,
	type RunningWebServer,
} from '../web/server';
import { WebChatEndpoint } from '../web/chatEndpoint';
import type { FetchLike, FetchResponseLike } from '../core/providers/openaiCompatible';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const BASE_URL = 'http://127.0.0.1:12225/v1';
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
		return sseText('resposta do modelo');
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
	const root = await mkdtemp(join(tmpdir(), 'evelyn-r4d-'));
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

/** Cria uma conversa real no Core. */
async function conversation(harness: Harness, title: string): Promise<string> {
	const created = await harness.core.chat.createConversation({ providerId: 'local', title });
	return created.summary.id;
}

/** POST autenticado com a credencial de conversa. */
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

suite('R4D: listagem de conversas', () => {
	test('lista as conversas persistidas, com id, título e datas', async () => {
		const harness = await start();
		try {
			const first = await conversation(harness, 'primeira');
			const second = await conversation(harness, 'segunda');

			const answer = await post(harness, CHAT_CONVERSATIONS_ROUTE, {});

			assert.equal(answer.status, 200);
			const parsed = JSON.parse(answer.body) as {
				conversations: readonly { id: string; title: string; createdAt: string; updatedAt: string; messageCount: number }[];
			};
			const ids = parsed.conversations.map((item) => item.id);
			assert.ok(ids.includes(first));
			assert.ok(ids.includes(second));
			for (const item of parsed.conversations) {
				assert.equal(typeof item.title, 'string');
				assert.equal(typeof item.createdAt, 'string');
				assert.equal(typeof item.updatedAt, 'string');
				assert.equal(typeof item.messageCount, 'number');
			}
		} finally {
			await harness.close();
		}
	});

	test('sem conversas, a lista é vazia — e não um erro', async () => {
		const harness = await start();
		try {
			const answer = await post(harness, CHAT_CONVERSATIONS_ROUTE, {});

			assert.equal(answer.status, 200);
			const parsed = JSON.parse(answer.body) as { conversations: unknown[] };
			assert.deepEqual(parsed.conversations, []);
		} finally {
			await harness.close();
		}
	});

	test('a lista não publica projectId nem providerId', async () => {
		const harness = await start();
		try {
			await conversation(harness, 'uma');
			const answer = await post(harness, CHAT_CONVERSATIONS_ROUTE, {});
			const parsed = JSON.parse(answer.body) as { conversations: readonly Record<string, unknown>[] };

			for (const item of parsed.conversations) {
				assert.deepEqual(Object.keys(item).sort(), [
					'createdAt',
					'id',
					'messageCount',
					'title',
					'updatedAt',
				]);
			}
			assert.equal(answer.body.includes('providerId'), false);
			assert.equal(answer.body.includes('projectId'), false);
			assert.equal(answer.body.includes(CHAT_TOKEN), false);
		} finally {
			await harness.close();
		}
	});

	test('listar não altera nenhum arquivo', async () => {
		const harness = await start();
		try {
			const id = await conversation(harness, 'intocada');
			const dir = join(harness.root, 'conversations');
			const before = await readFile(join(dir, `${id}.json`), 'utf8');
			const beforeFiles = (await readdir(dir)).sort();

			await post(harness, CHAT_CONVERSATIONS_ROUTE, {});
			await post(harness, CHAT_CONVERSATION_ROUTE, { id });

			const after = await readFile(join(dir, `${id}.json`), 'utf8');
			assert.equal(after, before, 'listar e abrir não reescrevem o histórico');
			assert.deepEqual((await readdir(dir)).sort(), beforeFiles, 'nenhum arquivo novo');
		} finally {
			await harness.close();
		}
	});
});

suite('R4D: abrir uma conversa', () => {
	test('devolve o histórico da conversa certa', async () => {
		const harness = await start();
		try {
			const id = await conversation(harness, 'com histórico');
			await harness.core.chat.sendMessage(
				{ providerId: 'local', conversationId: id, model: 'local/modelo-a', messages: [{ role: 'user', content: 'olá' }] },
				() => undefined,
			).catch(() => undefined);
			await harness.core.chat.waitForTurn('turn-1').catch(() => undefined);

			const answer = await post(harness, CHAT_CONVERSATION_ROUTE, { id });

			assert.equal(answer.status, 200);
			const parsed = JSON.parse(answer.body) as {
				conversation: { id: string; title: string };
				messages: readonly { role: string; content: string }[];
			};
			assert.equal(parsed.conversation.id, id);
			assert.equal(parsed.conversation.title, 'com histórico');
			assert.ok(parsed.messages.length > 0);
			assert.ok(parsed.messages.some((message) => message.content === 'olá'));
		} finally {
			await harness.close();
		}
	});

	test('o histórico não traz mensagens de sistema nem de ferramenta', async () => {
		const harness = await start();
		try {
			const created = await harness.core.chat.createConversation({ providerId: 'local', title: 'prompt' });
			await harness.core.chat.setSystemPrompt(created.summary.id, 'SEGREDO DA INSTRUÇÃO');
			const answer = await post(harness, CHAT_CONVERSATION_ROUTE, { id: created.summary.id });
			const parsed = JSON.parse(answer.body) as {
				messages: readonly { role: string }[];
				systemPrompt?: unknown;
			};

			assert.equal(answer.status, 200);
			// A instrução de sistema não é publicada.
			assert.equal(answer.body.includes('SEGREDO DA INSTRUÇÃO'), false);
			assert.equal('systemPrompt' in parsed, false);
			assert.ok(parsed.messages.every((message) => message.role === 'user' || message.role === 'assistant'));
		} finally {
			await harness.close();
		}
	});

	test('um id inexistente é 404', async () => {
		const harness = await start();
		try {
			const answer = await post(harness, CHAT_CONVERSATION_ROUTE, { id: 'cnv_nao_existe' });

			assert.equal(answer.status, 404);
			const parsed = JSON.parse(answer.body) as { error: { code: string } };
			assert.equal(parsed.error.code, 'no_candidate');
			assert.equal(answer.body.includes(harness.root), false);
		} finally {
			await harness.close();
		}
	});

	test('um id vazio ou grande demais é 400', async () => {
		const harness = await start();
		try {
			const empty = await post(harness, CHAT_CONVERSATION_ROUTE, { id: '' });
			const big = await post(harness, CHAT_CONVERSATION_ROUTE, { id: 'x'.repeat(500) });
			const missing = await post(harness, CHAT_CONVERSATION_ROUTE, {});

			for (const answer of [empty, big, missing]) {
				assert.equal(answer.status, 400);
			}
		} finally {
			await harness.close();
		}
	});

	test('abrir uma conversa não devolve mensagens de outra', async () => {
		const harness = await start();
		try {
			const one = await conversation(harness, 'um');
			const two = await conversation(harness, 'dois');
			await harness.core.chat.sendMessage(
				{ providerId: 'local', conversationId: one, model: 'local/modelo-a', messages: [{ role: 'user', content: 'só na primeira' }] },
				() => undefined,
			).catch(() => undefined);
			await harness.core.chat.waitForTurn('turn-1').catch(() => undefined);

			const answer = await post(harness, CHAT_CONVERSATION_ROUTE, { id: two });
			const parsed = JSON.parse(answer.body) as { messages: readonly { content: string }[] };

			assert.equal(answer.status, 200);
			assert.equal(answer.body.includes('só na primeira'), false);
			assert.equal(parsed.messages.length, 0, 'a segunda conversa não tem mensagem');
		} finally {
			await harness.close();
		}
	});
});

suite('R4D: credenciais do histórico', () => {
	test('sem credencial é 401 nas duas rotas', async () => {
		const harness = await start();
		try {
			for (const path of [CHAT_CONVERSATIONS_ROUTE, CHAT_CONVERSATION_ROUTE]) {
				const answer = await post(harness, path, {}, {});
				assert.equal(answer.status, 401, `${path} não pode abrir sem credencial`);
			}
		} finally {
			await harness.close();
		}
	});

	test('o readerToken não lê o histórico', async () => {
		const harness = await start();
		try {
			const id = await conversation(harness, 'privada');
			for (const path of [CHAT_CONVERSATIONS_ROUTE, CHAT_CONVERSATION_ROUTE]) {
				const answer = await post(harness, path, { id }, { 'x-seshyina-reader': READER_TOKEN });
				assert.equal(answer.status, 401, `${path} não é do leitor`);
			}
		} finally {
			await harness.close();
		}
	});

	test('o token do painel não lê o histórico pela rota de conversa', async () => {
		const harness = await start();
		try {
			const id = await conversation(harness, 'painel');
			const answer = await post(
				harness,
				CHAT_CONVERSATION_ROUTE,
				{ id },
				{ 'x-seshyina-token': harness.server.token },
			);

			// O painel tem as rotas dele; a de conversa exige a de conversa.
			assert.equal(answer.status, 401);
		} finally {
			await harness.close();
		}
	});
});

suite('R4D: continuidade com a R4C', () => {
	test('abrir, enviar um turno e reabrir: o histórico cresceu', async () => {
		const harness = await start();
		try {
			const id = await conversation(harness, 'continuidade');

			const before = JSON.parse((await post(harness, CHAT_CONVERSATION_ROUTE, { id })).body) as {
				messages: readonly unknown[];
			};

			// O turno da R4C, pela mesma rota e a mesma identidade.
			const turn = await fetch(`${harness.base}${CHAT_TURN_ROUTE}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', [CHAT_TOKEN_HEADER]: CHAT_TOKEN },
				body: JSON.stringify({
					conversationId: id,
					providerId: 'local',
					model: 'local/modelo-a',
					text: 'nova pergunta',
				}),
			});
			assert.equal(turn.status, 200);
			await turn.text();

			const after = JSON.parse((await post(harness, CHAT_CONVERSATION_ROUTE, { id })).body) as {
				messages: readonly { role: string; content: string }[];
			};

			assert.ok(after.messages.length > before.messages.length, 'o histórico cresceu');
			assert.ok(after.messages.some((message) => message.content === 'nova pergunta'));
			assert.ok(after.messages.some((message) => message.role === 'assistant'));
		} finally {
			await harness.close();
		}
	});

	test('a conversa enviada é a que foi aberta: nenhum estado cruzado', async () => {
		const harness = await start();
		try {
			const one = await conversation(harness, 'a');
			const two = await conversation(harness, 'b');

			const reply = await fetch(`${harness.base}${CHAT_TURN_ROUTE}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', [CHAT_TOKEN_HEADER]: CHAT_TOKEN },
				body: JSON.stringify({
					conversationId: two,
					providerId: 'local',
					model: 'local/modelo-a',
					text: 'vai para a segunda',
				}),
			});
			await reply.text();

			const oneOpened = JSON.parse((await post(harness, CHAT_CONVERSATION_ROUTE, { id: one })).body) as {
				messages: readonly unknown[];
			};
			const twoOpened = JSON.parse((await post(harness, CHAT_CONVERSATION_ROUTE, { id: two })).body) as {
				messages: readonly unknown[];
			};

			assert.equal(oneOpened.messages.length, 0, 'a primeira continua vazia');
			assert.ok(twoOpened.messages.length > 0);
		} finally {
			await harness.close();
		}
	});
});
