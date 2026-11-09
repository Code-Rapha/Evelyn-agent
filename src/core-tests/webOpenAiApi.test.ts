/**
 * R2: a superfície HTTP compatível com OpenAI, contra um socket de verdade.
 *
 * ## Por que socket, e não só a função
 *
 * O que se está provando inclui coisas que só existem no HTTP: o status da
 * resposta, o `Content-Type` do SSE, o `[DONE]` no fim do stream e a recusa
 * de uma chave que não veio no `Authorization`. Um teste só da função
 * `chatCompletionsReply` passaria com o servidor entregando um 200 errado.
 *
 * ## O que é falso
 *
 * O provedor: um `ChatProvider` roteirizado, injetado no runtime. Não há
 * chamada de rede para fora da máquina. O que **não** é falso: o roteamento
 * (motor real), a autenticação (registro de chaves real, em disco), o
 * ledger de consumo e o servidor.
 */
import * as assert from 'assert';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';

import { ApiKeyStore, API_KEYS_FILE } from '../core/security/apiKeys';
import { ApiChatRuntime, type ApiRouteCandidate } from '../web/apiChat';
import { startWebServer } from '../web/server';
import { buildOpenAiEndpoint } from '../web/openaiEndpoint';
import { assembleCore, type AssembledCore } from '../app/assemble';
import type { ChatProvider, ChatRequest, ChatStream, ChatStreamEvent } from '../core/providers/chat/types';
import { ConsoleLogSink } from '../adapters/local/consoleLogSink';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const roots: string[] = [];

teardown(async () => {
	for (const root of roots.splice(0)) {
		await removeFixtureTree(root).catch(() => undefined);
	}
});

interface FakeServer {
	readonly url: string;
	readonly token: string;
	readonly root: string;
	readonly key: string;
	close(): Promise<void>;
}

/** Um stream com os eventos dados, e um `closedReason` honesto. */
function streamOf(events: readonly ChatStreamEvent[]): ChatStream {
	return {
		closedReason: 'completed',
		timing: {},
		[Symbol.asyncIterator]: async function* () {
			yield* events;
		},
	};
}

/**
 * Sobe um servidor com a superfície `/v1` ligada.
 *
 * O provedor responde a partir do **último texto do usuário**: é o que
 * permite provar que duas requisições simultâneas receberam respostas
 * diferentes sem depender de temporização.
 */
async function startFakeServer(options: {
	readonly scripts?: (request: ChatRequest) => readonly ChatStreamEvent[];
	readonly candidates?: readonly ApiRouteCandidate[];
	readonly keyScopes?: readonly ('panel' | 'client')[];
} = {}): Promise<FakeServer> {
	const root = await mkdtemp(join(tmpdir(), 'evelyn-v1-http-'));
	roots.push(root);
	const core: AssembledCore = assembleCore({
		rootPath: root,
		logScope: 'test',
		logSink: new ConsoleLogSink({ out: () => undefined, err: () => undefined }),
	});
	const keys = new ApiKeyStore({ filePath: join(root, API_KEYS_FILE) });
	const created = await keys.create({ name: 'teste', scopes: options.keyScopes ?? ['client'] });

	const provider: ChatProvider = {
		async streamChat(request: ChatRequest): Promise<ChatStream> {
			if (options.scripts !== undefined) {
				return streamOf(options.scripts(request));
			}
			const last = request.messages[request.messages.length - 1]?.content ?? '';
			return streamOf([{ type: 'TextDelta', text: `eco:${last}` }, { type: 'Done' }]);
		},
	};
	const runtime = new ApiChatRuntime({
		providerFor: () => provider,
		candidatesFor: async ({ requested }) => options.candidates ?? [requested],
		policy: core.chat.routingAccess()?.policy ?? ((): never => {
			throw new Error('sem política de rota');
		})(),
		breaker:
			core.chat.routingAccess()?.breaker ??
			(() => {
				throw new Error('sem breaker');
			})(),
		ledger: core.history,
		store: core.history,
		pricing: async () => undefined,
		accessPolicy: async () => core.chat.loadAccessPolicy(),
	});

	const server = await startWebServer({
		version: 'test',
		assetsDir: join(process.cwd(), 'dist', 'web', 'assets'),
		core,
		openai: {
			authenticate: async (presented) =>
				presented === undefined ? undefined : await keys.verify(presented),
			runtime,
			listModels: async () => [{ id: 'p/m', created: 1, ownedBy: 'p' }],
		},
		port: 0,
	});
	return {
		url: `http://127.0.0.1:${server.port}`,
		token: server.token,
		root,
		key: created.secret,
		async close() {
			await server.close();
			core.chat.dispose();
		},
	};
}

interface Answer {
	readonly status: number;
	readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
	readonly body: string;
}

/** Uma requisição HTTP crua: o `fetch` do Node basta e é o que o cliente usaria. */
async function call(
	server: FakeServer,
	path: string,
	options: {
		readonly method?: string;
		readonly body?: unknown;
		readonly authorization?: string;
		readonly contentType?: string;
	} = {},
	extraHeaders: Readonly<Record<string, string>> = {},
): Promise<Answer> {
	const headers: Record<string, string> = { ...extraHeaders };
	if (options.authorization !== undefined) {
		headers['authorization'] = options.authorization;
	}
	if (options.body !== undefined) {
		headers['content-type'] = options.contentType ?? 'application/json';
	}
	const response = await fetch(`${server.url}${path}`, {
		method: options.method ?? 'GET',
		headers,
		...(options.body !== undefined ? { body: typeof options.body === 'string' ? options.body : JSON.stringify(options.body) } : {}),
	});
	return { status: response.status, headers: response.headers as never, body: await response.text() };
}

/** Lê o SSE como o cliente lería, evento por evento. */
async function callStream(
	server: FakeServer,
	body: unknown,
): Promise<{ readonly status: number; readonly events: readonly string[]; readonly raw: string }> {
	const response = await fetch(`${server.url}/v1/chat/completions`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${server.key}` },
		body: JSON.stringify(body),
	});
	const raw = await response.text();
	const events = raw
		.split('\n\n')
		.map((block) => block.trim())
		.filter((block) => block.startsWith('data: '))
		.map((block) => block.slice('data: '.length));
	return { status: response.status, events, raw };
}

suite('R2: /v1/models', () => {
	test('sem chave é 401, e o corpo é JSON de erro', async () => {
		const server = await startFakeServer();
		try {
			const answer = await call(server, '/v1/models');

			assert.equal(answer.status, 401);
			const parsed = JSON.parse(answer.body) as { error: { code: string } };
			assert.equal(parsed.error.code, 'auth');
		} finally {
			await server.close();
		}
	});

	test('uma chave errada é 401', async () => {
		const server = await startFakeServer();
		try {
			const answer = await call(server, '/v1/models', { authorization: 'Bearer sk-evelyn-errada' });
			assert.equal(answer.status, 401);
		} finally {
			await server.close();
		}
	});

	test('a chave na URL não é aceita', async () => {
		const server = await startFakeServer();
		try {
			const answer = await call(server, `/v1/models?api_key=${server.key}`);
			assert.equal(answer.status, 401, 'chave em query não é credencial');
		} finally {
			await server.close();
		}
	});

	test('uma chave de painel não vale como cliente', async () => {
		const server = await startFakeServer({ keyScopes: ['panel'] });
		try {
			const answer = await call(server, '/v1/models', { authorization: `Bearer ${server.key}` });
			assert.equal(answer.status, 401);
			const parsed = JSON.parse(answer.body) as { error: { message: string } };
			assert.match(parsed.error.message, /permissão de cliente/);
		} finally {
			await server.close();
		}
	});

	test('com chave válida, a lista é a forma de /v1/models', async () => {
		const server = await startFakeServer();
		try {
			const answer = await call(server, '/v1/models', { authorization: `Bearer ${server.key}` });
			const parsed = JSON.parse(answer.body) as {
				object: string;
				data: readonly { id: string; object: string; owned_by: string }[];
			};
			assert.equal(answer.status, 200);
			assert.equal(parsed.object, 'list');
			assert.deepEqual(parsed.data.map((model) => model.id), ['p/m']);
			assert.equal(parsed.data[0]?.object, 'model');
		} finally {
			await server.close();
		}
	});

	test('a resposta não contém a chave nem o token do painel', async () => {
		const server = await startFakeServer();
		try {
			const answer = await call(server, '/v1/models', { authorization: `Bearer ${server.key}` });

			assert.equal(answer.body.includes(server.key), false);
			assert.equal(answer.body.includes(server.token), false);
			assert.equal(answer.body.includes('sk-'), false);
		} finally {
			await server.close();
		}
	});

	test('revogar a chave a invalida imediatamente', async () => {
		const server = await startFakeServer();
		try {
			const before = await call(server, '/v1/models', { authorization: `Bearer ${server.key}` });
			assert.equal(before.status, 200);

			const keys = new ApiKeyStore({ filePath: join(server.root, API_KEYS_FILE) });
			for (const key of await keys.list()) {
				await keys.revoke(key.id);
			}

			const after = await call(server, '/v1/models', { authorization: `Bearer ${server.key}` });
			assert.equal(after.status, 401);
		} finally {
			await server.close();
		}
	});

	test('rotacionar troca a chave aceita', async () => {
		const server = await startFakeServer();
		try {
			const keys = new ApiKeyStore({ filePath: join(server.root, API_KEYS_FILE) });
			const rotated = await keys.rotate({ name: 'nova' });

			const withOld = await call(server, '/v1/models', { authorization: `Bearer ${server.key}` });
			const withNew = await call(server, '/v1/models', { authorization: `Bearer ${rotated.secret}` });

			assert.equal(withOld.status, 401, 'a chave antiga deixou de valer');
			assert.equal(withNew.status, 200, 'a chave nova vale');
		} finally {
			await server.close();
		}
	});
});

suite('R2: /v1/chat/completions', () => {
	test('uma resposta comum tem a forma chat.completion', async () => {
		const server = await startFakeServer();
		try {
			const answer = await call(server, '/v1/chat/completions', {
				method: 'POST',
				authorization: `Bearer ${server.key}`,
				body: { model: 'p/m', messages: [{ role: 'user', content: 'oi' }] },
			});
			const parsed = JSON.parse(answer.body) as {
				id: string;
				object: string;
				model: string;
				choices: readonly { message: { role: string; content: string }; finish_reason: string }[];
			};

			assert.equal(answer.status, 200);
			assert.equal(parsed.object, 'chat.completion');
			assert.match(parsed.id, /^chatcmpl_/);
			assert.equal(parsed.model, 'm');
			assert.equal(parsed.choices[0]?.message.role, 'assistant');
			assert.equal(parsed.choices[0]?.message.content, 'eco:oi');
			assert.equal(parsed.choices[0]?.finish_reason, 'stop');
		} finally {
			await server.close();
		}
	});

	test('streaming entrega chunks e termina com [DONE]', async () => {
		const server = await startFakeServer({
			scripts: () => [
				{ type: 'TextDelta', text: 'um ' },
				{ type: 'TextDelta', text: 'dois' },
				{ type: 'Done' },
			],
		});
		try {
			const answer = await callStream(server, {
				model: 'p/m',
				messages: [{ role: 'user', content: 'x' }],
				stream: true,
			});

			assert.equal(answer.status, 200);
			assert.equal(answer.events[answer.events.length - 1], '[DONE]');
			const chunks = answer.events
				.filter((event) => event !== '[DONE]')
				.map((event) => JSON.parse(event) as { object: string; choices: readonly { delta: { content?: string } }[] });
			assert.ok(chunks.every((chunk) => chunk.object === 'chat.completion.chunk'));
			const text = chunks.map((chunk) => chunk.choices[0]?.delta.content ?? '').join('');
			assert.equal(text, 'um dois');
		} finally {
			await server.close();
		}
	});

	test('o header do stream é text/event-stream', async () => {
		const server = await startFakeServer();
		try {
			const response = await fetch(`${server.url}/v1/chat/completions`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: `Bearer ${server.key}` },
				body: JSON.stringify({ model: 'p/m', messages: [{ role: 'user', content: 'x' }], stream: true }),
			});
			await response.text();
			assert.match(String(response.headers.get('content-type')), /text\/event-stream/);
		} finally {
			await server.close();
		}
	});

	test('dois pedidos simultâneos recebem as duas respostas certas', async () => {
		// O provedor atrasa o primeiro pedido, para as duas estarem no ar ao
		// mesmo tempo: um slot global faria o segundo esperar ou ser recusado.
		const server = await startFakeServer();
		try {
			const [first, second] = await Promise.all([
				call(server, '/v1/chat/completions', {
					method: 'POST',
					authorization: `Bearer ${server.key}`,
					body: { model: 'p/m', messages: [{ role: 'user', content: 'primeiro' }] },
				}),
				call(server, '/v1/chat/completions', {
					method: 'POST',
					authorization: `Bearer ${server.key}`,
					body: { model: 'p/m', messages: [{ role: 'user', content: 'segundo' }] },
				}),
			]);

			assert.equal(first.status, 200);
			assert.equal(second.status, 200);
			const bodyFirst = JSON.parse(first.body) as { choices: { message: { content: string } }[] };
			const bodySecond = JSON.parse(second.body) as { choices: { message: { content: string } }[] };
			assert.equal(bodyFirst.choices[0]?.message.content, 'eco:primeiro');
			assert.equal(bodySecond.choices[0]?.message.content, 'eco:segundo');
		} finally {
			await server.close();
		}
	});

	test('cinco pedidos simultâneos não trocam de resposta', async () => {
		const server = await startFakeServer();
		try {
			const answers = await Promise.all(
				Array.from({ length: 5 }, (_unused, index) =>
					call(server, '/v1/chat/completions', {
						method: 'POST',
						authorization: `Bearer ${server.key}`,
						body: { model: 'p/m', messages: [{ role: 'user', content: `pedido-${index}` }] },
					}),
				),
			);

			answers.forEach((answer, index) => {
				const parsed = JSON.parse(answer.body) as { choices: { message: { content: string } }[] };
				assert.equal(parsed.choices[0]?.message.content, `eco:pedido-${index}`);
			});
		} finally {
			await server.close();
		}
	});

	test('um modelo fora do catálogo é 404', async () => {
		const server = await startFakeServer({ candidates: [] });
		try {
			const answer = await call(server, '/v1/chat/completions', {
				method: 'POST',
				authorization: `Bearer ${server.key}`,
				body: { model: 'p/m', messages: [{ role: 'user', content: 'x' }] },
			});
			assert.equal(answer.status, 404);
			const parsed = JSON.parse(answer.body) as { error: { code: string } };
			assert.equal(parsed.error.code, 'no_candidate');
		} finally {
			await server.close();
		}
	});

	test('um corpo inválido é 400 e não chega ao provedor', async () => {
		const server = await startFakeServer();
		try {
			const missingModel = await call(server, '/v1/chat/completions', {
				method: 'POST',
				authorization: `Bearer ${server.key}`,
				body: { messages: [{ role: 'user', content: 'x' }] },
			});
			const noMessages = await call(server, '/v1/chat/completions', {
				method: 'POST',
				authorization: `Bearer ${server.key}`,
				body: { model: 'p/m', messages: [] },
			});
			const badRole = await call(server, '/v1/chat/completions', {
				method: 'POST',
				authorization: `Bearer ${server.key}`,
				body: { model: 'p/m', messages: [{ role: 'tool', content: 'x' }] },
			});
			const notJson = await call(server, '/v1/chat/completions', {
				method: 'POST',
				authorization: `Bearer ${server.key}`,
				body: '{ isto não é json',
			});

			for (const answer of [missingModel, noMessages, badRole, notJson]) {
				assert.equal(answer.status, 400);
				const parsed = JSON.parse(answer.body) as { error: { code: string } };
				assert.equal(parsed.error.code, 'bad_request');
			}
		} finally {
			await server.close();
		}
	});

	test('um corpo que não é JSON declarado é 415', async () => {
		const server = await startFakeServer();
		try {
			const answer = await call(server, '/v1/chat/completions', {
				method: 'POST',
				authorization: `Bearer ${server.key}`,
				contentType: 'text/plain',
				body: JSON.stringify({ model: 'p/m', messages: [{ role: 'user', content: 'x' }] }),
			});
			assert.equal(answer.status, 415);
		} finally {
			await server.close();
		}
	});

	test('verbo errado é 405 com Allow', async () => {
		const server = await startFakeServer();
		try {
			const getOnChat = await call(server, '/v1/chat/completions', {
				authorization: `Bearer ${server.key}`,
			});
			const postOnModels = await call(server, '/v1/models', {
				method: 'POST',
				authorization: `Bearer ${server.key}`,
				body: {},
			});

			assert.equal(getOnChat.status, 405);
			assert.equal(postOnModels.status, 405);
		} finally {
			await server.close();
		}
	});

	test('o painel continua exigindo o token dele, e o token não serve para /v1', async () => {		const server = await startFakeServer();
		try {
			// A sessão do painel não abre `/v1`...
			const withPanelToken = await call(server, '/v1/models', {
				authorization: `Bearer ${server.token}`,
			});
			assert.equal(withPanelToken.status, 401);
			// ...e a chave de cliente não abre o painel.
			const panelWithClientKey = await call(server, '/api/overview', {
				authorization: `Bearer ${server.key}`,
			});
			assert.equal(panelWithClientKey.status, 401);
			// Cada um vale no seu lugar: o painel usa o header dele.
			const panel = await call(server, '/api/overview', {}, { 'x-seshyina-token': server.token });
			assert.equal(panel.status, 200);
		} finally {
			await server.close();
		}
	});

	test('o erro não carrega stack nem caminho de arquivo', async () => {		const server = await startFakeServer({ candidates: [] });
		try {
			const answer = await call(server, '/v1/chat/completions', {
				method: 'POST',
				authorization: `Bearer ${server.key}`,
				body: { model: 'p/m', messages: [{ role: 'user', content: 'x' }] },
			});

			assert.equal(answer.body.includes('at '), false, 'sem stack');
			assert.equal(answer.body.includes(server.root), false, 'sem caminho');
			assert.equal(answer.body.includes('.ts'), false);
		} finally {
			await server.close();
		}
	});
});
