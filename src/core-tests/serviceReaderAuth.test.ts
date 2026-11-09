/**
 * R4A: a credencial de leitura é só de leitura.
 *
 * ## Por que este arquivo existe
 *
 * O desktop recebe uma credencial para consultar o serviço. Se ela fosse o
 * token do painel, o app (e qualquer arquivo que a guarde, qualquer log, qualquer
 * extensão) poderia **escrever provedores, disparar descoberta, reconfigurar o
 * roteador e encerrar o serviço**. Estes testes fixam que:
 *
 * - o token de leitura lê (`/api/health`, `/api/overview`, `/api/models`,
 *   `/api/models/catalog`);
 * - o token de leitura **não** escreve (todas as rotas de escrita → 401);
 * - o token de leitura **não** encerra o serviço;
 * - o token do painel continua fazendo o que fazia;
 * - nenhuma das rotas de escritura aceita o token de leitura por acidente de
 *   ordem no roteamento.
 *
 * Roda contra o servidor de verdade, com um Core montado numa raiz
 * temporária.
 */
import * as assert from 'assert';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { assembleCore } from '../app/assemble';
import { ConsoleLogSink } from '../adapters/local/consoleLogSink';
import { startWebServer, type RunningWebServer } from '../web/server';
import { READER_HEADER } from '../desktop/serviceClient';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

interface Harness {
	readonly base: string;
	readonly panelToken: string;
	readonly readerToken: string;
	readonly shutdowns: number[];
	close(): Promise<void>;
}

async function start(): Promise<Harness> {
	const root = await mkdtemp(join(tmpdir(), 'evelyn-r4a-auth-'));
	const core = assembleCore({
		rootPath: root,
		logScope: 'test',
		logSink: new ConsoleLogSink({ out: () => undefined, err: () => undefined }),
	});
	const readerToken = randomBytes(32).toString('hex');
	const shutdowns: number[] = [];
	const server: RunningWebServer = await startWebServer({
		version: 'test',
		assetsDir: join(process.cwd(), 'dist', 'web', 'assets'),
		core,
		storageHost: 'web',
		readerToken,
		requestShutdown: () => shutdowns.push(Date.now()),
		port: 0,
	});
	return {
		base: `http://127.0.0.1:${server.port}`,
		panelToken: server.token,
		readerToken,
		shutdowns,
		async close() {
			await server.close();
			core.chat.dispose();
			await removeFixtureTree(root).catch(() => undefined);
		},
	};
}

/** GET/HEAD com o token de leitura. */
async function read(
	harness: Harness,
	path: string,
): Promise<{ readonly status: number; readonly body: string }> {
	const response = await fetch(`${harness.base}${path}`, {
		method: 'GET',
		headers: { [READER_HEADER]: harness.readerToken },
	});
	return { status: response.status, body: await response.text() };
}

/** POST numa rota de escrita, com a credencial indicada. */
async function write(
	harness: Harness,
	path: string,
	credential: { readonly panel: boolean } | { readonly reader: boolean },
): Promise<number> {
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if ('panel' in credential) {
		headers['x-seshyina-token'] = harness.panelToken;
	} else {
		headers[READER_HEADER] = harness.readerToken;
	}
	const response = await fetch(`${harness.base}${path}`, {
		method: 'POST',
		headers,
		body: JSON.stringify({}),
	});
	await response.text();
	return response.status;
}

suite('R4A: a credencial de leitura só lê', () => {
	test('o token de leitura lê saúde, visão geral, modelos e catálogo', async () => {
		const harness = await start();
		try {
			for (const path of ['/api/health', '/api/overview', '/api/models', '/api/models/catalog']) {
				const answer = await read(harness, path);
				assert.equal(answer.status, 200, `${path} deveria responder 200 ao leitor`);
			}
			// E a resposta tem conteúdo real, não um stub.
			const overview = JSON.parse((await read(harness, '/api/overview')).body) as {
				providers: { total: number };
			};
			assert.equal(typeof overview.providers.total, 'number');
		} finally {
			await harness.close();
		}
	});

	test('as rotas de escrita recusam o token de leitura', async () => {
		const harness = await start();
		try {
			// Uma de cada família: provedor, descoberta, roteador, OpenCode.
			const writes = [
				'/api/providers/save',
				'/api/providers/enabled',
				'/api/providers/role',
				'/api/providers/remove',
				'/api/providers/test',
				'/api/models/discover',
				'/api/routing/save',
				'/api/routing/reset',
				'/api/opencode/connect-managed',
				'/api/opencode/catalog/refresh',
			];
			for (const path of writes) {
				const status = await write(harness, path, { reader: true });
				assert.equal(status, 401, `${path} não pode aceitar a credencial de leitura`);
			}
		} finally {
			await harness.close();
		}
	});

	test('o token de leitura não encerra o serviço', async () => {
		const harness = await start();
		try {
			const status = await write(harness, '/api/service/shutdown', { reader: true });

			assert.equal(status, 401);
			assert.equal(harness.shutdowns.length, 0, 'nenhum pedido de encerramento foi aceito');
		} finally {
			await harness.close();
		}
	});

	test('o token do painel continua valendo nas leituras e no encerramento', async () => {
		const harness = await start();
		try {
			const health = await fetch(`${harness.base}/api/health`, {
				headers: { 'x-seshyina-token': harness.panelToken },
			});
			assert.equal(health.status, 200);
			await health.text();

			const shutdown = await fetch(`${harness.base}/api/service/shutdown`, {
				method: 'POST',
				headers: { 'x-seshyina-token': harness.panelToken },
			});
			await shutdown.text();
			assert.equal(shutdown.status, 202);
			assert.equal(harness.shutdowns.length, 1);
		} finally {
			await harness.close();
		}
	});

	test('sem credencial, nada é lido', async () => {
		const harness = await start();
		try {
			for (const path of ['/api/health', '/api/overview', '/api/models']) {
				const response = await fetch(`${harness.base}${path}`);
				await response.text();
				assert.equal(response.status, 401, `${path} não pode abrir sem credencial`);
			}
		} finally {
			await harness.close();
		}
	});

	test('a credencial de leitura não abre a página nem os estáticos', async () => {
		// Ela é para a API do app, não para navegar como o dono da máquina.
		const harness = await start();
		try {
			const page = await fetch(`${harness.base}/`, { headers: { [READER_HEADER]: harness.readerToken } });
			await page.text();

			assert.equal(page.status, 401);
		} finally {
			await harness.close();
		}
	});

	test('a credencial de leitura não vale em /v1', async () => {
		const harness = await start();
		try {
			const models = await fetch(`${harness.base}/v1/models`, {
				headers: { [READER_HEADER]: harness.readerToken },
			});
			await models.text();

			// O serviço pode nem ter `/v1` (sem chave de cliente); o que se
			// afirma é que o leitor não é aceito como cliente.
			assert.ok(models.status === 401 || models.status === 404);
		} finally {
			await harness.close();
		}
	});

	test('as duas credenciais são diferentes', async () => {
		const harness = await start();
		try {
			assert.notEqual(harness.readerToken, harness.panelToken);
			assert.ok(harness.readerToken.length >= 32);
			// O token de leitura não é aceito como painel...
			const asPanel = await fetch(`${harness.base}/api/health`, {
				headers: { 'x-seshyina-token': harness.readerToken },
			});
			await asPanel.text();
			assert.equal(asPanel.status, 401);
		} finally {
			await harness.close();
		}
	});
});
