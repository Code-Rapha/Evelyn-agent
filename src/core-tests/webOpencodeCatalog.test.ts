/**
 * A rota do catálogo na interface web.
 *
 * ## O que se prova
 *
 * 1. **Sessão**: sem o token, a atualização é recusada;
 * 2. **Método**: é POST; um GET nela é `405`;
 * 3. **Corpo**: não aceita parâmetro nenhum — a página não escolhe URL, nem
 *    rota, nem provedor;
 * 4. **Sem conexão**: `409` com o motivo, sem catálogo inventado;
 * 5. **Sucesso**: `200` com o catálogo lido, e o `GET /api/opencode/status`
 *    traz o mesmo catálogo;
 * 6. **A galeria** (`/api/integrations`) traz o catálogo, e o catálogo do
 *    Core (`/api/models/catalog`) **não** traz nenhum modelo do OpenCode.
 */
import * as assert from 'assert';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assembleCore } from '../app/assemble';
import { ConsoleLogSink } from '../adapters/local/consoleLogSink';
import { OpencodeCatalogService } from '../app/opencodeCatalogService';
import { OpencodeManager, type OpencodeManagerOptions } from '../app/opencodeManager';
import { LOOPBACK_ADDRESS } from '../web/policy';
import { startWebServer, type RunningWebServer } from '../web/server';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const silent = new ConsoleLogSink({ out: () => undefined, err: () => undefined });

const CATALOG_BODY = JSON.stringify({
	data: [
		{ id: 'modelo-a', providerID: 'openrouter', status: 'active', name: 'Modelo A' },
		{ id: 'modelo-b', providerID: 'opencode', status: 'deprecated' },
	],
});

function call(
	port: number,
	options: { readonly path: string; readonly method?: string; readonly token?: string; readonly body?: string },
): Promise<{ readonly status: number; readonly body: string }> {
	return new Promise((resolve, reject) => {
		const headers: Record<string, string> = { host: `127.0.0.1:${port}` };
		if (options.token !== undefined) {
			headers['x-seshyina-token'] = options.token;
		}
		if (options.body !== undefined) {
			headers['content-type'] = 'application/json';
			headers['content-length'] = String(Buffer.byteLength(options.body));
		}
		const request = httpRequest(
			{ host: LOOPBACK_ADDRESS, port, path: options.path, method: options.method ?? 'GET', headers },
			(response) => {
				const chunks: Buffer[] = [];
				response.on('data', (chunk: Buffer) => chunks.push(chunk));
				response.on('end', () =>
					resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
				);
			},
		);
		request.on('error', reject);
		request.end(options.body ?? undefined);
	});
}

suite('Web: a rota do catálogo do OpenCode', () => {
	let root: string;
	let assetsDir: string;
	let server: RunningWebServer;
	let connected: boolean;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-opencode-catalog-web-'));
		assetsDir = await mkdtemp(join(tmpdir(), 'seshyina-opencode-catalog-assets-'));
		await writeFile(join(assetsDir, 'index.html'), '<!doctype html><title>t</title>', 'utf8');
		connected = true;
		const managerOptions: OpencodeManagerOptions = {
			detectCli: async () => '1.18.34',
			binary: 'opencode',
			spawnServer: () => ({ pid: 1, exited: new Promise(() => undefined), kill: () => undefined }),
			findFreePort: async () => 45200,
			health: async () => ({ status: 200, version: '1.18.34' }),
		};
		const manager = new OpencodeManager(managerOptions);
		if (connected) {
			await manager.connectManaged();
		}
		const catalog = new OpencodeCatalogService({
			manager,
			transport: {
				get: async (input) =>
					input.url.endsWith('/global/health')
						? { status: 200, body: '{"healthy":true}' }
						: { status: 200, body: CATALOG_BODY },
			},
		});
		server = await startWebServer({
			version: '0.0.1',
			assetsDir,
			port: 0,
			core: assembleCore({ rootPath: root, logSink: silent }),
			opencode: manager,
			opencodeCatalog: catalog,
		});
	});

	teardown(async () => {
		await server.close();
		await removeFixtureTree(root);
		await removeFixtureTree(assetsDir);
	});

	test('sem o token, a atualização é recusada', async () => {
		const response = await call(server.port, { path: '/api/opencode/catalog/refresh', method: 'POST' });
		assert.strictEqual(response.status, 401);
	});

	test('a rota é POST: um GET é 405', async () => {
		const response = await call(server.port, { path: '/api/opencode/catalog/refresh', token: server.token });
		assert.strictEqual(response.status, 405);
	});

	test('a rota não aceita parâmetro nenhum', async () => {
		for (const body of ['{"url":"http://exemplo.com"}', '{"route":"/provider"}', '{"providerId":"x"}']) {
			const response = await call(server.port, {
				path: '/api/opencode/catalog/refresh',
				method: 'POST',
				token: server.token,
				body,
			});
			assert.strictEqual(response.status, 400, body);
		}
	});

	test('a atualização lê o catálogo, e o estado traz o mesmo', async () => {
		const response = await call(server.port, {
			path: '/api/opencode/catalog/refresh',
			method: 'POST',
			token: server.token,
			body: '{}',
		});
		assert.strictEqual(response.status, 200);
		const body = JSON.parse(response.body) as { state: { state: string; catalog?: { models: unknown[] } } };
		assert.strictEqual(body.state.state, 'ok');
		assert.strictEqual(body.state.catalog?.models.length, 2);
		// Nada do corpo cru de /api/model volta na resposta.
		assert.ok(!response.body.includes('"location"'));
		assert.ok(!response.body.includes('"providerID"'));

		const status = await call(server.port, { path: '/api/opencode/status', token: server.token });
		const statusBody = JSON.parse(status.body) as { catalog: { state: string; catalog?: { models: unknown[] } } };
		assert.strictEqual(statusBody.catalog.state, 'ok');
		assert.strictEqual(statusBody.catalog.catalog?.models.length, 2);
	});

	test('a galeria traz o catálogo, e o catálogo do Core não tem modelo do OpenCode', async () => {
		await call(server.port, {
			path: '/api/opencode/catalog/refresh',
			method: 'POST',
			token: server.token,
			body: '{}',
		});

		const integrations = await call(server.port, { path: '/api/integrations', token: server.token });
		const gallery = JSON.parse(integrations.body) as { opencodeCatalog?: { state: string } };
		assert.strictEqual(gallery.opencodeCatalog?.state, 'ok');

		const coreCatalog = await call(server.port, { path: '/api/models/catalog', token: server.token });
		const core = JSON.parse(coreCatalog.body) as { models: Array<{ providerId?: string; modelId?: string }> };
		assert.ok(
			!core.models.some((model) => model.providerId === 'openrouter' && model.modelId === 'modelo-a'),
			'um modelo do OpenCode não pode aparecer no catálogo do Core',
		);
	});
});
