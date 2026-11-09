/**
 * R4F: renomear e excluir conversas pelo serviço.
 *
 * ## O que é real
 *
 * Motor, `FileDataStore`, rotas, autenticação e serialização. As conversas são
 * criadas e apagadas de verdade no disco.
 *
 * ## O que não é real
 *
 * O modelo (`fetchImpl` determinístico do `assembleCore`), como em R4C–R4E.
 */
import * as assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assembleCore, type AssembledCore } from '../app/assemble';
import { ConsoleLogSink } from '../adapters/local/consoleLogSink';
import {
	CHAT_CONVERSATIONS_ROUTE,
	CHAT_CONVERSATION_ROUTE,
	CHAT_CREATE_ROUTE,
	CHAT_DELETE_ROUTE,
	CHAT_RENAME_ROUTE,
	CHAT_TOKEN_HEADER,
	CHAT_TURN_ROUTE,
	startWebServer,
	type RunningWebServer,
} from '../web/server';
import { WebChatEndpoint } from '../web/chatEndpoint';
import type { FetchLike, FetchResponseLike } from '../core/providers/openaiCompatible';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const BASE_URL = 'http://127.0.0.1:12229/v1';
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

/** Um backend que **segura** a resposta até o teste liberar (para o turno em curso). */
function gatedBackend(): { readonly fetchImpl: FetchLike; readonly pending: (() => void)[] } {
	const pending: (() => void)[] = [];
	const fetchImpl: FetchLike = async (url) => {
		if (url.endsWith('/models')) {
			return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'modelo-a' }] }) };
		}
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
			pending.push(resolve);
		});
		void release;
		return {
			ok: true,
			status: 200,
			body: {
				[Symbol.asyncIterator]: async function* () {
					await gate;
					yield* [
						`data: ${JSON.stringify({ choices: [{ delta: { content: 'depois' } }] })}\n\n`,
						'data: [DONE]\n\n',
					];
				},
			},
			text: async () => '',
		};
	};
	return { fetchImpl, pending };
}

interface Harness {
	readonly root: string;
	readonly core: AssembledCore;
	readonly base: string;
	readonly server: RunningWebServer;
	close(): Promise<void>;
}

async function start(fetchImpl: FetchLike = async () => sseText('ok')): Promise<Harness> {
	const root = await mkdtemp(join(tmpdir(), 'evelyn-r4f-'));
	const core = assembleCore({
		rootPath: root,
		logScope: 'test',
		logSink: new ConsoleLogSink({ out: () => undefined, err: () => undefined }),
		fetchImpl,
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

async function create(harness: Harness, title: string): Promise<string> {
	const created = await post(harness, CHAT_CREATE_ROUTE, { providerId: 'local', title });
	assert.equal(created.status, 201);
	return (JSON.parse(created.body) as { conversation: { id: string } }).conversation.id;
}

async function listIds(harness: Harness): Promise<string[]> {
	const listed = await post(harness, CHAT_CONVERSATIONS_ROUTE, {});
	return (JSON.parse(listed.body) as { conversations: { id: string }[] }).conversations.map((item) => item.id);
}

teardown(async () => {
	// Cada teste fecha o seu harness.
});

suite('R4F: renomear', () => {
	test('renomeia e a lista mostra o título novo', async () => {
		const harness = await start();
		try {
			const id = await create(harness, 'antigo');
			const renamed = await post(harness, CHAT_RENAME_ROUTE, { id, title: 'novo título' });

			assert.equal(renamed.status, 200);
			const parsed = JSON.parse(renamed.body) as { conversation: { id: string; title: string } };
			assert.equal(parsed.conversation.id, id);
			assert.equal(parsed.conversation.title, 'novo título');

			const opened = JSON.parse((await post(harness, CHAT_CONVERSATION_ROUTE, { id })).body) as {
				conversation: { title: string };
			};
			assert.equal(opened.conversation.title, 'novo título', 'persistido, não só na resposta');
		} finally {
			await harness.close();
		}
	});

	test('a resposta não traz campos internos nem credencial', async () => {
		const harness = await start();
		try {
			const id = await create(harness, 'x');
			const renamed = await post(harness, CHAT_RENAME_ROUTE, { id, title: 'y' });
			const parsed = JSON.parse(renamed.body) as { conversation: Record<string, unknown> };

			assert.deepEqual(Object.keys(parsed.conversation).sort(), [
				'createdAt',
				'id',
				'messageCount',
				'title',
				'updatedAt',
			]);
			assert.equal(renamed.body.includes(CHAT_TOKEN), false);
			assert.equal(renamed.body.includes(harness.root), false);
		} finally {
			await harness.close();
		}
	});

	test('renomear não afeta as outras conversas', async () => {
		const harness = await start();
		try {
			const one = await create(harness, 'um');
			const two = await create(harness, 'dois');
			await post(harness, CHAT_RENAME_ROUTE, { id: one, title: 'um renomeado' });

			const other = JSON.parse((await post(harness, CHAT_CONVERSATION_ROUTE, { id: two })).body) as {
				conversation: { title: string };
			};
			assert.equal(other.conversation.title, 'dois');
		} finally {
			await harness.close();
		}
	});

	test('id inexistente é 404; título vazio ou imenso é 400', async () => {
		const harness = await start();
		try {
			const id = await create(harness, 'x');
			const cases: { readonly body: unknown; readonly status: number }[] = [
				{ body: { id: 'cnv_nao_existe', title: 'y' }, status: 404 },
				{ body: { id, title: '' }, status: 400 },
				{ body: { id, title: '   ' }, status: 400 },
				{ body: { id, title: 't'.repeat(500) }, status: 400 },
				{ body: { id: '', title: 'y' }, status: 400 },
				{ body: { title: 'y' }, status: 400 },
				{ body: { id, title: 42 }, status: 400 },
				{ body: { id, title: 'y', projectId: 'p' }, status: 400 },
				{ body: { id, title: 'y', path: 'C:\\x' }, status: 400 },
			];
			for (const testCase of cases) {
				const answer = await post(harness, CHAT_RENAME_ROUTE, testCase.body);
				assert.equal(answer.status, testCase.status, JSON.stringify(testCase.body).slice(0, 60));
			}
		} finally {
			await harness.close();
		}
	});
});

suite('R4F: excluir', () => {
	test('exclui, some da lista e não abre mais', async () => {
		const harness = await start();
		try {
			const keep = await create(harness, 'fica');
			const gone = await create(harness, 'sai');
			const deleted = await post(harness, CHAT_DELETE_ROUTE, { id: gone });

			assert.equal(deleted.status, 200);
			const ids = await listIds(harness);
			assert.ok(ids.includes(keep));
			assert.equal(ids.includes(gone), false);

			const opened = await post(harness, CHAT_CONVERSATION_ROUTE, { id: gone });
			assert.equal(opened.status, 404);

			// O arquivo realmente saiu do disco.
			const files = await readdir(join(harness.root, 'conversations'));
			assert.equal(files.includes(`${gone}.json`), false);
		} finally {
			await harness.close();
		}
	});

	test('excluir não toca no histórico das outras', async () => {
		const harness = await start();
		try {
			const keep = await create(harness, 'com histórico');
			await post(harness, CHAT_TURN_ROUTE, {
				conversationId: keep,
				providerId: 'local',
				model: 'local/modelo-a',
				text: 'guardar isto',
			});
			const before = JSON.parse((await post(harness, CHAT_CONVERSATION_ROUTE, { id: keep })).body) as {
				messages: readonly unknown[];
			};

			const other = await create(harness, 'descartável');
			await post(harness, CHAT_DELETE_ROUTE, { id: other });

			const after = JSON.parse((await post(harness, CHAT_CONVERSATION_ROUTE, { id: keep })).body) as {
				messages: readonly unknown[];
			};
			assert.deepEqual(after.messages, before.messages);
			assert.ok(after.messages.length > 0);
		} finally {
			await harness.close();
		}
	});

	test('excluir a mesma conversa duas vezes: 200 nas duas (idempotente)', async () => {
		const harness = await start();
		try {
			const id = await create(harness, 'duas vezes');

			const first = await post(harness, CHAT_DELETE_ROUTE, { id });
			const second = await post(harness, CHAT_DELETE_ROUTE, { id });

			// R4M: a segunda exclusão é idempotente. Antes era `404` — e duas
			// exclusões simultâneas davam `200` e `404` ao acaso. O contrato de
			// sucesso não muda: `200` com `{ deleted: true, id }`.
			assert.equal(first.status, 200);
			assert.equal(second.status, 200);
			assert.deepEqual(JSON.parse(first.body), { deleted: true, id });
			assert.deepEqual(JSON.parse(second.body), { deleted: true, id });
			// E não recriou nada.
			assert.equal((await listIds(harness)).includes(id), false);
			const files = await readdir(join(harness.root, 'conversations')).catch(() => [] as string[]);
			assert.equal(files.includes(`${id}.json`), false);
		} finally {
			await harness.close();
		}
	});

	test('excluir uma conversa que nunca existiu também é 200 (ausência é o estado pedido)', async () => {
		const harness = await start();
		try {
			const answer = await post(harness, CHAT_DELETE_ROUTE, { id: 'cnv_nunca_existiu' });

			// A decisão da R4M: "já não há essa conversa" é exatamente o que a
			// exclusão queria — negar com `404` só porque uma exclusão anterior
			// (ou inexistente) venceu faria o resultado depender da corrida.
			assert.equal(answer.status, 200);
			assert.deepEqual(JSON.parse(answer.body), { deleted: true, id: 'cnv_nunca_existiu' });
		} finally {
			await harness.close();
		}
	});

	test('id inválido e campos extras são 400', async () => {
		const harness = await start();
		try {
			const id = await create(harness, 'protegida');
			const cases = [{}, { id: '' }, { id: 'x'.repeat(500) }, { id: 42 }, { id, path: 'C:\\windows' }];
			for (const body of cases) {
				const answer = await post(harness, CHAT_DELETE_ROUTE, body);
				assert.equal(answer.status, 400, JSON.stringify(body).slice(0, 50));
			}
			// A conversa continua lá.
			assert.ok((await listIds(harness)).includes(id));
		} finally {
			await harness.close();
		}
	});
});

suite('R4F: credenciais', () => {
	test('sem credencial, renomear e excluir dão 401 e nada muda', async () => {
		const harness = await start();
		try {
			const id = await create(harness, 'intocada');

			for (const path of [CHAT_RENAME_ROUTE, CHAT_DELETE_ROUTE]) {
				const body = path === CHAT_RENAME_ROUTE ? { id, title: 'outro' } : { id };
				const anonymous = await post(harness, path, body, {});
				const reader = await post(harness, path, body, { 'x-seshyina-reader': READER_TOKEN });

				assert.equal(anonymous.status, 401, `${path} sem credencial`);
				assert.equal(reader.status, 401, `${path} com o leitor`);
			}

			const opened = JSON.parse((await post(harness, CHAT_CONVERSATION_ROUTE, { id })).body) as {
				conversation: { title: string };
			};
			assert.equal(opened.conversation.title, 'intocada');
		} finally {
			await harness.close();
		}
	});
});

suite('R4F/R4G: exclusão durante um turno', () => {
	test('é recusada com 409, e a conversa continua até o turno terminar', async () => {
		// R4G mudou esta política de propósito: na R4F a exclusão passava e o
		// turno falhava no meio. Agora a exclusão é **recusada** enquanto o
		// turno está em curso, e o turno segue normalmente até o fim — que é o
		// que o usuário espera ao ver "não pode excluir enquanto gera".
		const backend = gatedBackend();
		const harness = await start(backend.fetchImpl);
		try {
			const id = await create(harness, 'em curso');

			const turn = fetch(`${harness.base}${CHAT_TURN_ROUTE}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', [CHAT_TOKEN_HEADER]: CHAT_TOKEN },
				body: JSON.stringify({
					conversationId: id,
					providerId: 'local',
					model: 'local/modelo-a',
					text: 'pergunta em curso',
				}),
			});
			const deadline = Date.now() + 10_000;
			while (backend.pending.length === 0) {
				if (Date.now() > deadline) {
					throw new Error('o turno não chegou ao backend');
				}
				await new Promise((resolve) => setTimeout(resolve, 5));
			}

			// A exclusão é recusada, e a conversa fica intocada.
			const deleted = await post(harness, CHAT_DELETE_ROUTE, { id });
			assert.equal(deleted.status, 409);
			const parsed = JSON.parse(deleted.body) as { error: { code: string } };
			assert.equal(parsed.error.code, 'conversation_busy');

			// O turno termina normalmente: recusar a exclusão não o interrompe.
			backend.pending[0]?.();
			const response = await turn;
			const body = await response.text();
			assert.equal(response.status, 200);
			assert.match(body, /\[DONE\]/);
			assert.ok(!body.includes('"error"'), 'o turno não falhou');

			// Depois do fim, a exclusão passa.
			const after = await post(harness, CHAT_DELETE_ROUTE, { id });
			assert.equal(after.status, 200);
			const files = await readdir(join(harness.root, 'conversations'));
			assert.equal(files.includes(`${id}.json`), false);
			assert.equal((await listIds(harness)).includes(id), false);
		} finally {
			await harness.close();
		}
	});
});
