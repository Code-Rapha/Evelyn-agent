/**
 * R4J: a consulta do diagnóstico de turnos.
 *
 * ## O que é real
 *
 * O servidor, a autenticação, o `TurnRecordStore` e o `turns.json` no disco.
 * Os registros são gravados pelo próprio store antes de serem consultados.
 *
 * ## O que este arquivo recusa a fazer
 *
 * Semear um `turns.json` à mão com conteúdo inventado: os turnos são criados
 * com `start`/`finish`, como o serviço os cria.
 */
import * as assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assembleCore } from '../app/assemble';
import { ConsoleLogSink } from '../adapters/local/consoleLogSink';
import { startWebServer, TURNS_DIAGNOSTIC_ROUTE, type RunningWebServer } from '../web/server';
import { TurnRecordStore, TURNS_FILE, type TurnRecordStatus } from '../core/storage/turnRecords';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

interface Harness {
	readonly root: string;
	readonly turns: TurnRecordStore;
	readonly server: RunningWebServer;
	readonly base: string;
	close(): Promise<void>;
}

async function start(): Promise<Harness> {
	const root = await mkdtemp(join(tmpdir(), 'evelyn-r4j-'));
	const core = assembleCore({
		rootPath: root,
		logScope: 'test',
		logSink: new ConsoleLogSink({ out: () => undefined, err: () => undefined }),
	});
	const turns = new TurnRecordStore({ root });
	const server = await startWebServer({
		version: 'test',
		assetsDir: join(process.cwd(), 'dist', 'web', 'assets'),
		core,
		readerToken: 'r'.repeat(64),
		chatToken: 'c'.repeat(64),
		turns,
		port: 0,
	});
	return {
		root,
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

/** Grava um turno com um desfecho, como o serviço faria. */
async function seedTurn(
	harness: Harness,
	input: {
		readonly turnId: string;
		readonly conversationId?: string;
		readonly status: 'completed' | 'failed' | 'cancelled' | 'running';
		readonly daysAgo?: number;
		readonly reason?: string;
	},
): Promise<void> {
	// O `start` grava com o relógio real; para datar turnos no passado, o
	// registro é escrito direto pelo store com um relógio injetado.
	const at = new Date(NOW - (input.daysAgo ?? 0) * DAY);
	const dated = new TurnRecordStore({ root: harness.root, now: () => at });
	await dated.start({ turnId: input.turnId, conversationId: input.conversationId ?? 'cnv_1' });
	if (input.status !== 'running') {
		await dated.finish({
			turnId: input.turnId,
			status: input.status,
			...(input.reason !== undefined ? { reason: input.reason } : {}),
		});
	}
}

/** GET autenticado com o token de leitura. */
async function query(
	harness: Harness,
	queryString = '',
	headers: Record<string, string> = { 'x-seshyina-reader': 'r'.repeat(64) },
): Promise<{ readonly status: number; readonly body: string }> {
	const response = await fetch(`${harness.base}${TURNS_DIAGNOSTIC_ROUTE}${queryString}`, { headers });
	return { status: response.status, body: await response.text() };
}

interface Page {
	readonly turns: readonly {
		readonly turnId: string;
		readonly conversationId: string;
		readonly status: string;
		readonly startedAt: string;
		readonly finishedAt?: string;
		readonly reason?: string;
	}[];
	readonly total: number;
	readonly limit: number;
	readonly offset: number;
}

async function page(harness: Harness, queryString = ''): Promise<Page> {
	const answer = await query(harness, queryString);
	assert.equal(answer.status, 200, answer.body);
	return JSON.parse(answer.body) as Page;
}

teardown(async () => {
	// Cada teste fecha o seu harness.
});

suite('R4J: a consulta de turnos', () => {
	test('lista os turnos de todos os estados, do mais recente para o mais antigo', async () => {
		const harness = await start();
		try {
			await seedTurn(harness, { turnId: 't-velho', status: 'completed', daysAgo: 3 });
			await seedTurn(harness, { turnId: 't-novo', status: 'failed', reason: 'o turno falhou' });
			await seedTurn(harness, { turnId: 't-meio', status: 'cancelled', daysAgo: 1 });
			await seedTurn(harness, { turnId: 't-em-curso', status: 'running' });

			const result = await page(harness);

			assert.equal(result.total, 4);
			// Ordem: início decrescente; os dois "agora" desempatam por id.
			const ids = result.turns.map((turn) => turn.turnId);
			assert.deepEqual(ids, ['t-em-curso', 't-novo', 't-meio', 't-velho']);
			// Os campos do ciclo, e nada mais.
			assert.deepEqual(Object.keys(result.turns.find((turn) => turn.turnId === 't-novo') ?? {}).sort(), [
				'conversationId',
				'finishedAt',
				'reason',
				'startedAt',
				'status',
				'turnId',
			]);
		} finally {
			await harness.close();
		}
	});

	test('filtra por estado', async () => {
		const harness = await start();
		try {
			await seedTurn(harness, { turnId: 'a', status: 'completed' });
			await seedTurn(harness, { turnId: 'b', status: 'failed' });
			await seedTurn(harness, { turnId: 'c', status: 'failed' });
			// Um `interrupted` só nasce da recuperação: é o caminho real.
			await seedTurn(harness, { turnId: 'd', status: 'running' });
			await harness.turns.recover();

			const failed = await page(harness, '?status=failed');
			const all = await page(harness, '?status=all');
			const interrupted = await page(harness, '?status=interrupted');

			assert.deepEqual(failed.turns.map((turn) => turn.turnId).sort(), ['b', 'c']);
			assert.equal(failed.total, 2);
			assert.equal(all.total, 4);
			assert.deepEqual(interrupted.turns.map((turn) => turn.turnId), ['d']);
			assert.equal(interrupted.total, 1);
		} finally {
			await harness.close();
		}
	});

	test('filtra por intervalo de datas, inclusive', async () => {
		const harness = await start();
		try {
			await seedTurn(harness, { turnId: 'antigo', status: 'completed', daysAgo: 10 });
			await seedTurn(harness, { turnId: 'recente', status: 'completed', daysAgo: 2 });

			const since = new Date(NOW - 5 * DAY).toISOString();
			const recentOnly = await page(harness, `?since=${encodeURIComponent(since)}`);

			assert.deepEqual(recentOnly.turns.map((turn) => turn.turnId), ['recente']);

			const until = new Date(NOW - 5 * DAY).toISOString();
			const oldOnly = await page(harness, `?until=${encodeURIComponent(until)}`);
			assert.deepEqual(oldOnly.turns.map((turn) => turn.turnId), ['antigo']);
		} finally {
			await harness.close();
		}
	});

	test('pagina, e o total é o do filtro inteiro', async () => {
		const harness = await start();
		try {
			for (let index = 0; index < 12; index += 1) {
				await seedTurn(harness, { turnId: `t-${String(index).padStart(2, '0')}`, status: 'completed', daysAgo: index });
			}

			const first = await page(harness, '?limit=5&offset=0');
			const second = await page(harness, '?limit=5&offset=5');
			const third = await page(harness, '?limit=5&offset=10');

			assert.equal(first.total, 12);
			assert.equal(first.turns.length, 5);
			assert.equal(second.turns.length, 5);
			assert.equal(third.turns.length, 2);
			// Nenhum repetido, nenhum pulado.
			const seen = [...first.turns, ...second.turns, ...third.turns].map((turn) => turn.turnId);
			assert.equal(new Set(seen).size, 12);
			// E a ordem se mantém entre páginas (mais recente primeiro).
			assert.equal(first.turns[0]?.turnId, 't-00');
			assert.equal(third.turns[1]?.turnId, 't-11');
		} finally {
			await harness.close();
		}
	});

	test('parâmetros inválidos são 400, nunca um filtro descartado em silêncio', async () => {
		const harness = await start();
		try {
			const cases = [
				'?status=inventado',
				'?since=ontem',
				'?until=2026-13-45',
				'?limit=0',
				'?limit=201',
				'?limit=abc',
				'?limit=1e3',
				'?offset=-1',
				'?offset=1.5',
				`?since=${encodeURIComponent(new Date(NOW).toISOString())}&until=${encodeURIComponent(new Date(NOW - DAY).toISOString())}`,
			];
			for (const queryString of cases) {
				const answer = await query(harness, queryString);
				assert.equal(answer.status, 400, `${queryString} deveria ser 400`);
				const parsed = JSON.parse(answer.body) as { error: { message: string } };
				assert.ok(parsed.error.message.length > 0);
			}
		} finally {
			await harness.close();
		}
	});

	test('o limite máximo é aceito; acima dele, recusado', async () => {
		const harness = await start();
		try {
			assert.equal((await query(harness, '?limit=200')).status, 200);
			assert.equal((await query(harness, '?limit=201')).status, 400);
		} finally {
			await harness.close();
		}
	});

	test('sem credencial ou com a de conversa é 401; leitor e painel leem', async () => {
		const harness = await start();
		try {
			await seedTurn(harness, { turnId: 'a', status: 'completed' });

			const anonymous = await query(harness, '', {});
			const asChat = await query(harness, '', { 'x-seshyina-chat': 'c'.repeat(64) });
			const asReader = await query(harness, '', { 'x-seshyina-reader': 'r'.repeat(64) });
			const asPanel = await query(harness, '', { 'x-seshyina-token': harness.server.token });

			assert.equal(anonymous.status, 401);
			assert.equal(asChat.status, 401, 'a credencial de conversa não lê o diagnóstico');
			assert.equal(asReader.status, 200);
			assert.equal(asPanel.status, 200);
		} finally {
			await harness.close();
		}
	});

	test('a resposta não expõe conteúdo, token nem caminho', async () => {
		const harness = await start();
		try {
			await seedTurn(harness, { turnId: 'segredo', status: 'failed', reason: 'o turno falhou' });

			const answer = await query(harness);

			assert.equal(answer.body.includes(harness.root), false, 'caminho não');
			assert.equal(answer.body.includes('r'.repeat(64)), false, 'token não');
			assert.equal(answer.body.includes('c'.repeat(64)), false);
			// Não há campo de mensagem: o objeto só tem o ciclo.
			const parsed = JSON.parse(answer.body) as Page;
			const keys = Object.keys(parsed.turns[0] ?? {});
			assert.equal(keys.includes('messages'), false);
			assert.equal(keys.includes('prompt'), false);
			assert.equal(keys.includes('content'), false);
		} finally {
			await harness.close();
		}
	});

	test('consultar não altera o registro nem cria outro arquivo', async () => {
		const harness = await start();
		try {
			await seedTurn(harness, { turnId: 'a', status: 'completed' });
			await seedTurn(harness, { turnId: 'b', status: 'running' });
			const before = await readFile(join(harness.root, TURNS_FILE), 'utf8');
			const beforeStamp = (await stat(join(harness.root, TURNS_FILE))).mtimeMs;

			await page(harness, '?status=all');
			await page(harness, '?status=running');
			await page(harness, '?limit=1&offset=1');

			assert.equal(await readFile(join(harness.root, TURNS_FILE), 'utf8'), before, 'o arquivo é o mesmo');
			assert.equal((await stat(join(harness.root, TURNS_FILE))).mtimeMs, beforeStamp, 'nem reescrito');
		} finally {
			await harness.close();
		}
	});

	test('registro vazio responde lista vazia, com total 0', async () => {
		const harness = await start();
		try {
			const result = await page(harness);
			assert.deepEqual(result.turns, []);
			assert.equal(result.total, 0);
		} finally {
			await harness.close();
		}
	});

	test('um registro ilegível vira 503 com mensagem própria, sem o caminho', async () => {
		const harness = await start();
		try {
			// `turns.json` como diretório: a leitura falha de um jeito que não é
			// "ENOENT", e o servidor precisa dizer isso sem expor o caminho.
			const { mkdir } = await import('node:fs/promises');
			await mkdir(join(harness.root, TURNS_FILE), { recursive: true });

			const answer = await query(harness);

			assert.equal(answer.status, 503);
			assert.equal(answer.body.includes(harness.root), false);
			const parsed = JSON.parse(answer.body) as { error: { message: string } };
			assert.match(parsed.error.message, /registro de turnos/);
		} finally {
			await harness.close();
		}
	});
});
