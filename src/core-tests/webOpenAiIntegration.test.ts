/**
 * R2: a superfície `/v1` sobre o motor de rota **real**.
 *
 * ## O que este arquivo cobre, que os outros não
 *
 * Os outros testes injetam um `ChatProvider`. Este monta o caminho completo:
 * `assembleCore` → `ChatSession` → `buildOpenAiEndpoint` → `ApiChatRuntime` →
 * `RoutedChatProvider` → `runRoute` → `OpenAICompatibleProvider`, com a
 * descoberta de modelos gravada no `FileDataStore`. O único substituto é o
 * transporte (`fetch`), porque um teste não deve abrir conexão para fora da
 * máquina.
 *
 * É aqui que se prova o que o enunciado pede: "reutilize o catálogo real e o
 * pipeline de roteamento existente; não duplique o motor".
 */
import * as assert from 'assert';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assembleCore } from '../app/assemble';
import { ConsoleLogSink } from '../adapters/local/consoleLogSink';
import { ApiKeyStore, API_KEYS_FILE } from '../core/security/apiKeys';
import { buildOpenAiEndpoint } from '../web/openaiEndpoint';
import { ChatSession } from '../desktop/chatSession';
import { ProviderConfigService } from '../core/providers/config';
import { FileStateStore } from '../adapters/local/fileStateStore';
import { FileSecretStore } from '../adapters/local/fileSecretStore';
import { FileDataStore } from '../adapters/local/fileDataStore';
import { chatCompletionsReply, listModelsReply, type OpenAiApiOptions } from '../web/openaiApi';
import type { FetchLike, FetchResponseLike } from '../core/providers/openaiCompatible';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const BASE_URL = 'http://127.0.0.1:12121/v1';

function sseResponse(chunks: readonly string[]): FetchResponseLike {
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

function delta(text: string): string {
	return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
}

/**
 * Um servidor OpenAI-compatible: `/models` lista um modelo, e
 * `/chat/completions` responde com o texto pedido.
 */
function fakeOpenAi(options: {
	readonly models?: readonly string[];
	readonly answer?: (body: Record<string, unknown>) => string;
	readonly calls?: { url: string; body?: string }[];
}): FetchLike {
	const calls = options.calls;
	return async (url, init) => {
		calls?.push({ url, ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
		if (url.endsWith('/models')) {
			return {
				ok: true,
				status: 200,
				text: async () => JSON.stringify({ data: (options.models ?? ['modelo-a']).map((id) => ({ id })) }),
			};
		}
		const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
		const last = (body['messages'] as readonly { content: string }[] | undefined)?.at(-1)?.content ?? '';
		const text = options.answer !== undefined ? options.answer(body) : `resposta a: ${last}`;
		return sseResponse([delta(text), 'data: [DONE]\n\n']);
	};
}

async function mount(options: {
	readonly fetch?: FetchLike;
	readonly models?: readonly string[];
} = {}): Promise<{
	root: string;
	core: ReturnType<typeof assembleCore>;
	endpoint: OpenAiApiOptions;
	key: string;
	cleanup(): Promise<void>;
}> {
	const root = await mkdtemp(join(tmpdir(), 'evelyn-v1-real-'));
	const core = assembleCore({
		rootPath: root,
		logScope: 'test',
		logSink: new ConsoleLogSink({ out: () => undefined, err: () => undefined }),
		fetchImpl: options.fetch ?? fakeOpenAi({ models: options.models }),
	});
	// Um provedor configurado e um catálogo descoberto, como um host faria.
	await core.chat.saveProvider({
		id: 'local',
		name: 'Local',
		baseUrl: BASE_URL,
	});
	await core.chat.listModels('local').catch(() => undefined);
	// A descoberta é gravada pela própria sessão ao listar.
	await core.chat.listUsableModels().catch(() => undefined);

	const keys = new ApiKeyStore({ filePath: join(root, API_KEYS_FILE) });
	const created = await keys.create({ name: 'teste' });
	const built = buildOpenAiEndpoint({ core, chat: core.chat });
	return {
		root,
		core,
		key: created.secret,
		endpoint: {
			runtime: built.runtime,
			listModels: built.listModels,
		},
		async cleanup() {
			core.chat.dispose();
			await removeFixtureTree(root).catch(() => undefined);
		},
	};
}

/** A lista de modelos do Core, pronta antes do teste. */
async function discovered(core: ReturnType<typeof assembleCore>, providerId: string): Promise<string[]> {
	await core.chat.listModels(providerId).catch(() => undefined);
	await core.chat.listUsableModels().catch(() => undefined);
	const models = await core.chat.listUsableModels();
	return models.map((model) => `${model.providerId}/${model.modelId}`);
}

suite('R2: o motor real por trás de /v1', () => {
	test('o motor de rota da sessão é o que a API usa, sem cópia própria', async () => {
		const root = await mkdtemp(join(tmpdir(), 'evelyn-v1-noroute-'));
		const core = assembleCore({
			rootPath: root,
			logScope: 'test',
			logSink: new ConsoleLogSink({ out: () => undefined, err: () => undefined }),
		});
		try {
			const access = core.chat.routingAccess();
			assert.ok(access !== undefined, 'a montagem padrão liga o motor');
			assert.ok(buildOpenAiEndpoint({ core, chat: core.chat }).runtime !== undefined);
		} finally {
			core.chat.dispose();
			await removeFixtureTree(root).catch(() => undefined);
		}
	});

	test('uma sessão sem motor de rota recusa a montagem da API', async () => {
		const root = await mkdtemp(join(tmpdir(), 'evelyn-v1-bare-'));
		const core = assembleCore({
			rootPath: root,
			logScope: 'test',
			logSink: new ConsoleLogSink({ out: () => undefined, err: () => undefined }),
		});
		try {
			// Uma segunda sessão sobre a mesma raiz, **sem** `routing`: é o host
			// que não ligou o motor. A API não inventa um motor para ela.
			const bare = new ChatSession({
				config: new ProviderConfigService(new FileStateStore({ filePath: join(root, 'state.json') })),
				secrets: new FileSecretStore({ filePath: join(root, 'secrets.json') }),
				history: new FileDataStore({ rootPath: root }),
				logger: core.logger,
			});
			try {
				assert.equal(bare.routingAccess(), undefined);
				assert.throws(
					() => buildOpenAiEndpoint({ core, chat: bare }),
					/motor de rota/,
				);
			} finally {
				bare.dispose();
			}
		} finally {
			core.chat.dispose();
			await removeFixtureTree(root).catch(() => undefined);
		}
	});

	test('o catálogo real do Core é o que /v1/models devolve', async () => {
		const mounted = await mount({ models: ['modelo-a', 'modelo-b'] });
		try {
			const ids = await discovered(mounted.core, 'local');
			assert.deepEqual(ids.sort(), ['local/modelo-a', 'local/modelo-b']);

			const reply = await listModelsReply(mounted.endpoint);

			assert.equal(reply.status, 200);
			const body = reply.body as { data: readonly { id: string; owned_by: string }[] };
			assert.deepEqual(body.data.map((model) => model.id).sort(), ids.sort());
			assert.ok(body.data.every((model) => model.owned_by === 'Local'));
			// Nenhum segredo na lista.
			assert.equal(JSON.stringify(reply.body).includes('sk-'), false);
		} finally {
			await mounted.cleanup();
		}
	});

	test('uma conversa passa pelo roteador real e volta no formato OpenAI', async () => {
		const mounted = await mount();
		try {
			const reply = await chatCompletionsReply({
				options: mounted.endpoint,
				body: {
					model: 'local/modelo-a',
					messages: [{ role: 'user', content: 'pergunta real' }],
				},
				signal: new AbortController().signal,
			});

			assert.equal(reply.status, 200);
			const body = reply.body as {
				object: string;
				model: string;
				choices: readonly { message: { content: string } }[];
			};
			assert.equal(body.object, 'chat.completion');
			assert.equal(body.choices[0]?.message.content, 'resposta a: pergunta real');
		} finally {
			await mounted.cleanup();
		}
	});

	test('o consumo do turno entra no ledger do Core, com o id da API', async () => {
		const mounted = await mount();
		try {
			const before = (await mounted.core.history.listConsumption({})).length;
			const reply = await chatCompletionsReply({
				options: mounted.endpoint,
				body: { model: 'local/modelo-a', messages: [{ role: 'user', content: 'x' }] },
				signal: new AbortController().signal,
			});
			assert.equal(reply.status, 200);

			const after = await mounted.core.history.listConsumption({});
			assert.equal(after.length, before + 1);
			const record = after[after.length - 1];
			assert.match(record?.conversationId ?? '', /^api_/);
			assert.equal(record?.providerId, 'local');
			assert.equal(record?.modelId, 'modelo-a');
		} finally {
			await mounted.cleanup();
		}
	});

	test('um modelo fora do catálogo real é recusado sem chamar o provedor', async () => {
		const calls: { url: string }[] = [];
		const mounted = await mount({ fetch: fakeOpenAi({ calls }) });
		try {
			await discovered(mounted.core, 'local');
			const callsBefore = calls.filter((call) => !call.url.endsWith('/models')).length;

			const reply = await chatCompletionsReply({
				options: mounted.endpoint,
				body: { model: 'local/inexistente', messages: [{ role: 'user', content: 'x' }] },
				signal: new AbortController().signal,
			});

			assert.equal(reply.status, 404);
			const callsAfter = calls.filter((call) => !call.url.endsWith('/models')).length;
			assert.equal(callsAfter, callsBefore, 'nenhuma chamada de chat saiu para um modelo recusado');
		} finally {
			await mounted.cleanup();
		}
	});

	test('o stream chega ao cliente pela rota real, com o texto inteiro', async () => {
		const mounted = await mount();
		try {
			const reply = await chatCompletionsReply({
				options: mounted.endpoint,
				body: {
					model: 'local/modelo-a',
					messages: [{ role: 'user', content: 'stream real' }],
					stream: true,
				},
				signal: new AbortController().signal,
			});
			assert.equal(reply.status, 200);
			assert.ok(reply.stream !== undefined);

			let text = '';
			for await (const event of reply.stream) {
				if (event.type === 'delta') {
					text += event.text;
				}
			}

			assert.equal(text, 'resposta a: stream real');
		} finally {
			await mounted.cleanup();
		}
	});

	test('o cliente manda o histórico inteiro, sem estado no servidor', async () => {
		// A API OpenAI é sem estado: duas chamadas independentes com o mesmo
		// histórico produzem o mesmo texto, e nada é lembrado entre elas.
		const mounted = await mount();
		try {
			const body = {
				model: 'local/modelo-a',
				messages: [
					{ role: 'system', content: 'seja breve' },
					{ role: 'user', content: 'primeira' },
					{ role: 'assistant', content: 'resposta' },
					{ role: 'user', content: 'segunda' },
				],
			};
			const first = await chatCompletionsReply({
				options: mounted.endpoint,
				body,
				signal: new AbortController().signal,
			});
			const second = await chatCompletionsReply({
				options: mounted.endpoint,
				body,
				signal: new AbortController().signal,
			});

			const textOf = (reply: typeof first): string =>
				(reply.body as { choices: readonly { message: { content: string } }[] }).choices[0]?.message.content ??
				'';
			assert.equal(textOf(first), 'resposta a: segunda');
			assert.equal(textOf(second), 'resposta a: segunda');
		} finally {
			await mounted.cleanup();
		}
	});
});
