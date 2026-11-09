/**
 * R4K: a recuperação do registro de turnos pelas rotas e pelo serviço.
 *
 * ## O que é real
 *
 * O servidor HTTP, a autenticação (painel, leitura e conversa), o
 * `TurnRecordStore`, o `WebChatEndpoint`, o motor de conversa com backend
 * determinístico e o `turns.json` no disco. Nada de store falso.
 *
 * ## O que estes testes fixam
 *
 * - o diagnóstico distingue "nenhum turno" de "diagnóstico indisponível";
 * - o chat abre e funciona mesmo com o registro corrompido;
 * - um turno novo **não** começa sobre o registro corrompido;
 * - a recuperação destrutiva exige a credencial do painel;
 * - o arquivo original fica byte a byte intacto até a recuperação explícita;
 * - depois da recuperação, o serviço volta a registrar turnos.
 *
 * A inicialização de um processo separado (`host/web`) é exercitada em
 * `turnCrashOfficial.integration.test.ts`-style no fim deste arquivo, com o
 * mesmo binário `dist/web/main.js` que o serviço usa.
 */
import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assembleCore, type AssembledCore } from '../app/assemble';
import { ConsoleLogSink } from '../adapters/local/consoleLogSink';
import {
	CHAT_CONVERSATION_ROUTE,
	CHAT_CONVERSATIONS_ROUTE,
	CHAT_CREATE_ROUTE,
	CHAT_TOKEN_HEADER,
	CHAT_TURN_ROUTE,
	CHAT_TURN_STATE_ROUTE,
	TOKEN_HEADER,
	TURNS_BACKUP_ROUTE,
	TURNS_DIAGNOSTIC_ROUTE,
	TURNS_RESET_ROUTE,
	startWebServer,
	type RunningWebServer,
} from '../web/server';
import { WebChatEndpoint } from '../web/chatEndpoint';
import { TurnRecordStore, TURNS_FILE } from '../core/storage/turnRecords';
import type { FetchLike, FetchResponseLike } from '../core/providers/openaiCompatible';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const BASE_URL = 'http://127.0.0.1:12244/v1';
const CHAT_TOKEN = 'c'.repeat(64);
const READER_TOKEN = 'r'.repeat(64);

/** Um backend que responde na hora, para o chat funcionar sem espera. */
function instantBackend(): FetchLike {
	return async (url) => {
		if (url.endsWith('/models')) {
			return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'modelo-a' }] }) };
		}
		const response: FetchResponseLike = {
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
		return response;
	};
}

interface Harness {
	readonly root: string;
	readonly core: AssembledCore;
	readonly endpoint: WebChatEndpoint;
	readonly turns: TurnRecordStore;
	readonly server: RunningWebServer;
	readonly base: string;
	/** O token do painel, como o navegador o usa. */
	readonly panel: string;
	/** A conversa criada no harness, para os testes de chat. */
	conversationId(): Promise<string>;
	close(): Promise<void>;
}

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

async function until(condition: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error(`tempo esgotado esperando: ${label}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function start(): Promise<Harness> {
	const root = await mkdtemp(join(tmpdir(), 'evelyn-r4k-web-'));
	const core = assembleCore({
		rootPath: root,
		logScope: 'test',
		logSink: new ConsoleLogSink({ out: () => undefined, err: () => undefined }),
		fetchImpl: instantBackend(),
	});
	await core.chat.saveProvider({ id: 'local', name: 'Local', baseUrl: BASE_URL });
	await core.chat.listModels('local').catch(() => undefined);
	const turns = new TurnRecordStore({ root });
	const endpoint = new WebChatEndpoint({ session: core.chat, turns });
	const server = await startWebServer({
		version: 'test',
		assetsDir: join(process.cwd(), 'dist', 'web', 'assets'),
		core,
		readerToken: READER_TOKEN,
		chatToken: CHAT_TOKEN,
		chat: endpoint,
		turns,
		port: 0,
	});
	let cached: string | undefined;
	const base = `http://127.0.0.1:${server.port}`;
	const harness: Harness = {
		root,
		core,
		endpoint,
		turns,
		server,
		base,
		panel: server.token,
		async conversationId() {
			if (cached !== undefined) {
				return cached;
			}
			const created = await fetch(`${base}${CHAT_CREATE_ROUTE}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', [CHAT_TOKEN_HEADER]: CHAT_TOKEN },
				body: JSON.stringify({ providerId: 'local', title: 'recuperação' }),
			});
			assert.equal(created.status, 201, await created.clone().text());
			const body = (await created.json()) as { conversation: { id: string } };
			cached = body.conversation.id;
			return cached;
		},
		async close() {
			await server.close();
			core.chat.dispose();
			await removeFixtureTree(root).catch(() => undefined);
		},
	};
	return harness;
}

/** O `turns.json` corrompido do teste — truncado no meio de um registro. */
const CORRUPTED = '{"version":1,"turns":[{"turnId":"svc-turn-1","conversationId":"cnv_1",';

async function corrupt(root: string): Promise<void> {
	await writeFile(join(root, TURNS_FILE), CORRUPTED, 'utf8');
}

async function get(
	harness: Harness,
	path: string,
	headers: Record<string, string>,
): Promise<{ readonly status: number; readonly body: string }> {
	const response = await fetch(`${harness.base}${path}`, { headers });
	return { status: response.status, body: await response.text() };
}

async function post(
	harness: Harness,
	path: string,
	headers: Record<string, string>,
	body?: unknown,
): Promise<{ readonly status: number; readonly body: string }> {
	const response = await fetch(`${harness.base}${path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		...(body !== undefined ? { body: JSON.stringify(body) } : {}),
	});
	return { status: response.status, body: await response.text() };
}

teardown(async () => {
	// Cada teste fecha o seu harness.
});

suite('R4K: o diagnóstico quando o registro está corrompido', () => {
	test('o painel recebe `turns_corrupt`, com motivo de classe e sem caminho', async () => {
		const harness = await start();
		try {
			await corrupt(harness.root);

			const answer = await get(harness, TURNS_DIAGNOSTIC_ROUTE, { [TOKEN_HEADER]: harness.panel });

			assert.equal(answer.status, 503);
			const body = JSON.parse(answer.body) as {
				readonly error: { readonly code: string };
				readonly reason: string;
				readonly recoverable: boolean;
			};
			assert.equal(body.error.code, 'turns_corrupt');
			assert.equal(body.recoverable, true);
			assert.equal(typeof body.reason, 'string');
			assert.equal(body.reason.includes(harness.root), false, 'sem caminho');
			assert.equal(answer.body.includes(harness.root), false, 'sem caminho em lugar nenhum');
			assert.equal(answer.body.includes('svc-turn-1'), false, 'sem conteúdo do arquivo');
		} finally {
			await harness.close();
		}
	});

	test('o token de leitura também recebe o diagnóstico (ele lê)', async () => {
		const harness = await start();
		try {
			await corrupt(harness.root);

			const answer = await get(harness, TURNS_DIAGNOSTIC_ROUTE, { 'x-seshyina-reader': READER_TOKEN });

			assert.equal(answer.status, 503);
			assert.equal((JSON.parse(answer.body) as { error: { code: string } }).error.code, 'turns_corrupt');
		} finally {
			await harness.close();
		}
	});

	test('um registro válido com zero turnos é `200` com lista vazia — não é indisponível', async () => {
		const harness = await start();
		try {
			// Um turno que começa e é reiniciado deixa o arquivo válido.
			await harness.turns.reset();

			const answer = await get(harness, TURNS_DIAGNOSTIC_ROUTE, { [TOKEN_HEADER]: harness.panel });

			assert.equal(answer.status, 200);
			const body = JSON.parse(answer.body) as { readonly turns: readonly unknown[] };
			assert.deepEqual(body.turns, []);
			assert.equal('unavailable' in body, false);
		} finally {
			await harness.close();
		}
	});

	test('a instalação nova (arquivo ausente) é uma lista vazia, não um erro', async () => {
		const harness = await start();
		try {
			const answer = await get(harness, TURNS_DIAGNOSTIC_ROUTE, { [TOKEN_HEADER]: harness.panel });

			assert.equal(answer.status, 200);
			assert.deepEqual((JSON.parse(answer.body) as { turns: unknown[] }).turns, []);
		} finally {
			await harness.close();
		}
	});
});

suite('R4K: o chat com o registro corrompido', () => {
	test('a conversa abre e o estado dos turnos é "indisponível", não "vazio"', async () => {
		const harness = await start();
		try {
			const id = await harness.conversationId();
			await corrupt(harness.root);

			const answer = await post(
				harness,
				CHAT_TURN_STATE_ROUTE,
				{ [CHAT_TOKEN_HEADER]: CHAT_TOKEN },
				{ id },
			);

			assert.equal(answer.status, 200);
			const body = JSON.parse(answer.body) as {
				readonly turns: readonly unknown[];
				readonly unavailable?: boolean;
				readonly reason?: string;
			};
			// A lista vem vazia, mas **não** sozinha: `unavailable` diz que
			// não se sabe, e a interface não afirmará "não houve interrupção".
			assert.deepEqual(body.turns, []);
			assert.equal(body.unavailable, true);
			assert.equal(typeof body.reason, 'string');
			assert.equal(answer.body.includes(harness.root), false);
		} finally {
			await harness.close();
		}
	});

	test('a lista de conversas continua funcionando', async () => {
		const harness = await start();
		try {
			const id = await harness.conversationId();
			await corrupt(harness.root);

			const answer = await post(harness, CHAT_CONVERSATIONS_ROUTE, { [CHAT_TOKEN_HEADER]: CHAT_TOKEN }, {});
			assert.equal(answer.status, 200, answer.body);
			const body = JSON.parse(answer.body) as { conversations: { id: string }[] };
			assert.equal(
				body.conversations.some((conversation) => conversation.id === id),
				true,
			);
		} finally {
			await harness.close();
		}
	});

	test('um turno novo é recusado com `turns_corrupt`, e o arquivo não é tocado', async () => {
		const harness = await start();
		try {
			const id = await harness.conversationId();
			await corrupt(harness.root);
			const before = await readFile(join(harness.root, TURNS_FILE));

			const answer = await post(
				harness,
				CHAT_TURN_ROUTE,
				{ [CHAT_TOKEN_HEADER]: CHAT_TOKEN },
				{ conversationId: id, providerId: 'local', model: 'local/modelo-a', text: 'oi' },
			);

			assert.equal(answer.status, 503);
			assert.equal((JSON.parse(answer.body) as { error: { code: string } }).error.code, 'turns_corrupt');
			assert.deepEqual(await readFile(join(harness.root, TURNS_FILE)), before);
			// E o turno não rodou: nenhum está ativo.
			assert.equal(harness.endpoint.activeTurnsFor(id), 0);
		} finally {
			await harness.close();
		}
	});

	test('depois da recuperação, o chat volta a funcionar de ponta a ponta', async () => {
		const harness = await start();
		try {
			const id = await harness.conversationId();
			await corrupt(harness.root);

			await post(harness, TURNS_BACKUP_ROUTE, { [TOKEN_HEADER]: harness.panel });
			const reset = await post(harness, TURNS_RESET_ROUTE, { [TOKEN_HEADER]: harness.panel });
			assert.equal(reset.status, 200, reset.body);

			const turn = await post(
				harness,
				CHAT_TURN_ROUTE,
				{ [CHAT_TOKEN_HEADER]: CHAT_TOKEN },
				{ conversationId: id, providerId: 'local', model: 'local/modelo-a', text: 'oi' },
			);
			assert.equal(turn.status, 200);
			await turn.body;
			// O `finish` do registro roda depois do stream fechar (`void`),
			// então o fechamento pode chegar alguns ms depois da resposta.
			await until(
				() => harness.endpoint.activeTurnsFor(id) === 0,
				'o turno sair da lista de ativos',
			);
			await untilAsync(async () => {
				const state = await post(harness, CHAT_TURN_STATE_ROUTE, { [CHAT_TOKEN_HEADER]: CHAT_TOKEN }, { id });
				const body = JSON.parse(state.body) as { turns: { status: string }[]; unavailable?: boolean };
				return body.unavailable !== true && body.turns[0]?.status === 'completed';
			}, 'o registro fechar como completed');

			const state = await post(
				harness,
				CHAT_TURN_STATE_ROUTE,
				{ [CHAT_TOKEN_HEADER]: CHAT_TOKEN },
				{ id },
			);
			const body = JSON.parse(state.body) as { turns: { status: string }[]; unavailable?: boolean };
			assert.equal(body.unavailable, undefined);
			assert.equal(body.turns[0]?.status, 'completed');
		} finally {
			await harness.close();
		}
	});
});

suite('R4K: a autorização da recuperação', () => {
	test('a credencial de leitura não faz a cópia', async () => {
		const harness = await start();
		try {
			await corrupt(harness.root);

			const answer = await post(harness, TURNS_BACKUP_ROUTE, { 'x-seshyina-reader': READER_TOKEN });

			assert.equal(answer.status, 401);
			assert.equal(
				(await readdir(harness.root)).some((name) => name.includes('.bak')),
				false,
				'nada foi copiado',
			);
		} finally {
			await harness.close();
		}
	});

	test('a credencial de leitura não reinicializa', async () => {
		const harness = await start();
		try {
			await corrupt(harness.root);

			const answer = await post(harness, TURNS_RESET_ROUTE, { 'x-seshyina-reader': READER_TOKEN });

			assert.equal(answer.status, 401);
			assert.equal(await readFile(join(harness.root, TURNS_FILE), 'utf8'), CORRUPTED);
		} finally {
			await harness.close();
		}
	});

	test('a credencial de conversa não reinicializa', async () => {
		const harness = await start();
		try {
			await corrupt(harness.root);

			const answer = await post(harness, TURNS_RESET_ROUTE, { [CHAT_TOKEN_HEADER]: CHAT_TOKEN });

			assert.equal(answer.status, 401);
			assert.equal(await readFile(join(harness.root, TURNS_FILE), 'utf8'), CORRUPTED);
		} finally {
			await harness.close();
		}
	});

	test('sem credencial nenhuma, a recuperação é recusada', async () => {
		const harness = await start();
		try {
			await corrupt(harness.root);

			const answer = await post(harness, TURNS_RESET_ROUTE, {});

			assert.equal(answer.status, 401);
			assert.equal(await readFile(join(harness.root, TURNS_FILE), 'utf8'), CORRUPTED);
		} finally {
			await harness.close();
		}
	});

	test('GET na rota de recuperação não executa nada', async () => {
		const harness = await start();
		try {
			await corrupt(harness.root);

			const answer = await get(harness, TURNS_RESET_ROUTE, { [TOKEN_HEADER]: harness.panel });

			assert.equal(answer.status, 405);
			assert.equal(await readFile(join(harness.root, TURNS_FILE), 'utf8'), CORRUPTED);
		} finally {
			await harness.close();
		}
	});
});

suite('R4K: o fluxo de recuperação pelo painel', () => {
	test('copiar e depois reinicializar: a cópia guarda o original, o registro fica vazio', async () => {
		const harness = await start();
		try {
			await corrupt(harness.root);

			const backup = await post(harness, TURNS_BACKUP_ROUTE, { [TOKEN_HEADER]: harness.panel });
			assert.equal(backup.status, 201, backup.body);
			const backed = JSON.parse(backup.body) as { readonly backup: string; readonly bytes: number };
			assert.equal(backed.backup, `${TURNS_FILE}.bak`);
			assert.equal(backed.bytes, Buffer.byteLength(CORRUPTED, 'utf8'));
			assert.equal(backup.body.includes(harness.root), false, 'sem caminho');

			// O original ainda está lá, intacto — copiar não é destrutivo.
			assert.equal(await readFile(join(harness.root, TURNS_FILE), 'utf8'), CORRUPTED);

			const reset = await post(harness, TURNS_RESET_ROUTE, { [TOKEN_HEADER]: harness.panel });
			assert.equal(reset.status, 200, reset.body);
			assert.deepEqual(JSON.parse(reset.body), { reset: true });

			// A cópia sobreviveu à reinicialização, byte a byte.
			assert.equal(await readFile(join(harness.root, `${TURNS_FILE}.bak`), 'utf8'), CORRUPTED);

			// E o diagnóstico volta.
			const after = await get(harness, TURNS_DIAGNOSTIC_ROUTE, { [TOKEN_HEADER]: harness.panel });
			assert.equal(after.status, 200);
			assert.deepEqual((JSON.parse(after.body) as { turns: unknown[] }).turns, []);
		} finally {
			await harness.close();
		}
	});

	test('duas cópias não se sobrescrevem pela rota', async () => {
		const harness = await start();
		try {
			await corrupt(harness.root);

			const first = await post(harness, TURNS_BACKUP_ROUTE, { [TOKEN_HEADER]: harness.panel });
			const second = await post(harness, TURNS_BACKUP_ROUTE, { [TOKEN_HEADER]: harness.panel });

			assert.equal(first.status, 201);
			assert.equal(second.status, 201);
			assert.equal((JSON.parse(first.body) as { backup: string }).backup, `${TURNS_FILE}.bak`);
			assert.equal((JSON.parse(second.body) as { backup: string }).backup, `${TURNS_FILE}.bak.2`);
		} finally {
			await harness.close();
		}
	});

	test('reinicializar um registro válido é recusado sem tocar nele', async () => {
		const harness = await start();
		try {
			await harness.turns.start({ turnId: 'svc-turn-1', conversationId: 'cnv_1' });
			const before = await readFile(join(harness.root, TURNS_FILE));

			const answer = await post(harness, TURNS_RESET_ROUTE, { [TOKEN_HEADER]: harness.panel });

			assert.equal(answer.status, 409);
			assert.deepEqual(await readFile(join(harness.root, TURNS_FILE)), before);
		} finally {
			await harness.close();
		}
	});

	test('copiar um registro válido é recusado (não há o que preservar)', async () => {
		const harness = await start();
		try {
			await harness.turns.start({ turnId: 'svc-turn-1', conversationId: 'cnv_1' });

			const answer = await post(harness, TURNS_BACKUP_ROUTE, { [TOKEN_HEADER]: harness.panel });

			assert.equal(answer.status, 409);
			assert.equal(
				(await readdir(harness.root)).some((name) => name.includes('.bak')),
				false,
			);
		} finally {
			await harness.close();
		}
	});

	test('a recuperação não toca no histórico das conversas', async () => {
		const harness = await start();
		try {
			const id = await harness.conversationId();
			const historyBefore = await post(
				harness,
				CHAT_CONVERSATION_ROUTE,
				{ [CHAT_TOKEN_HEADER]: CHAT_TOKEN },
				{ id },
			);
			assert.equal(historyBefore.status, 200, historyBefore.body);
			await corrupt(harness.root);

			await post(harness, TURNS_BACKUP_ROUTE, { [TOKEN_HEADER]: harness.panel });
			await post(harness, TURNS_RESET_ROUTE, { [TOKEN_HEADER]: harness.panel });

			const historyAfter = await post(
				harness,
				CHAT_CONVERSATION_ROUTE,
				{ [CHAT_TOKEN_HEADER]: CHAT_TOKEN },
				{ id },
			);
			// O arquivo de turnos é outro: a conversa abre igual, antes e depois.
			assert.equal(historyAfter.status, 200);
			assert.deepEqual(JSON.parse(historyAfter.body), JSON.parse(historyBefore.body));
		} finally {
			await harness.close();
		}
	});
});

suite('R4K: a inicialização com o registro corrompido', () => {
	// O `dist/web/main.js` é o binário que sobe o serviço. Um processo real,
	// com a raiz corrompida, prova o que um teste em processo não prova: o
	// serviço **sobe** mesmo sem poder recuperar o registro, e responde.
	const MAIN = join(process.cwd(), 'dist', 'web', 'main.js');

	test('o serviço sobe, avisa no log e responde 503 no diagnóstico', async () => {
		const root = await mkdtemp(join(tmpdir(), 'evelyn-r4k-boot-'));
		await writeFile(join(root, TURNS_FILE), CORRUPTED, 'utf8');
		let output = '';
		const child = spawn(process.execPath, [MAIN, '--root', root, '--port', '0'], {
			env: { ...process.env, SESHYINA_TEST_LOG: '1' },
			windowsHide: true,
		});
		child.stdout.on('data', (chunk: Buffer) => {
			output += chunk.toString('utf8');
		});
		child.stderr.on('data', (chunk: Buffer) => {
			output += chunk.toString('utf8');
		});
		try {
			// O serviço imprime a URL com o token quando está escutando.
			const deadline = Date.now() + 20_000;
			let url: string | undefined;
			while (url === undefined) {
				if (child.exitCode !== null) {
					assert.fail(`o serviço saiu com ${child.exitCode}: ${output}`);
				}
				if (Date.now() > deadline) {
					assert.fail(`o serviço não subiu: ${output}`);
				}
				const match = /(http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]+)/.exec(output);
				url = match?.[1];
				if (url === undefined) {
					await new Promise((resolve) => setTimeout(resolve, 50));
				}
			}

			const parsed = new URL(url);
			const token = parsed.searchParams.get('t') ?? '';
			const base = `http://127.0.0.1:${parsed.port}`;
			const answer = await fetch(`${base}${TURNS_DIAGNOSTIC_ROUTE}`, { headers: { [TOKEN_HEADER]: token } });

			assert.equal(answer.status, 503, await answer.clone().text());
			const body = (await answer.json()) as { error: { code: string }; recoverable: boolean };
			assert.equal(body.error.code, 'turns_corrupt');
			assert.equal(body.recoverable, true);
			// O arquivo continua intacto: a inicialização não o sobrescreveu.
			assert.equal(await readFile(join(root, TURNS_FILE), 'utf8'), CORRUPTED);
			// E o log diz o que aconteceu — a linha do aviso, não o
			// cabeçalho do serviço (que naturalmente mostra a raiz).
			const warning = output
				.split(/\r?\n/)
				.find((line) => line.includes('registro de turnos está corrompido'));
			assert.notEqual(warning, undefined, `o log não avisou: ${output}`);
			assert.equal(warning?.includes(root), false, 'o aviso não vaza o caminho');
			assert.equal(warning?.includes(CORRUPTED), false, 'o aviso não vaza o conteúdo');
		} finally {
			child.kill();
			await new Promise<void>((resolve) => {
				if (child.exitCode !== null) {
					resolve();
					return;
				}
				child.once('exit', () => resolve());
			});
			await removeFixtureTree(root).catch(() => undefined);
		}
	});
});
