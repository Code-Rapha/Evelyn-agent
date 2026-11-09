/**
 * As rotas do OpenCode na interface web.
 *
 * ## O que se prova
 *
 * 1. **Sessão**: sem o token, nada — nem o estado, nem uma ação;
 * 2. **Método**: o estado é `GET`; as ações são `POST` e um `GET` nelas é
 *    `405` — uma ação nunca acontece num pré-carregamento de link;
 * 3. **Corpo**: no modo manual só entram `baseUrl` e `password`. Um `command`,
 *    um `binary` ou um `shell` no corpo é recusado — a página não tem terminal;
 * 4. **A senha nunca volta**: nem na resposta, nem no erro;
 * 5. **Sem gerenciador**: as rotas respondem `404`, não um estado inventado.
 *
 * O gerenciador é real; o processo e a rede dele, não: o que entra por aqui é
 * o mesmo caminho que a página usa, com as gambiarras já existentes no
 * repositório.
 */
import * as assert from 'assert';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OpencodeManager, type OpencodeManagerOptions } from '../app/opencodeManager';
import { LOOPBACK_ADDRESS } from '../web/policy';
import { startWebServer, type RunningWebServer } from '../web/server';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const PASSWORD = 'a-senha-que-nao-pode-sair-daqui';

/** Uma requisição HTTP com o token, e o corpo cru. */
function call(
	port: number,
	options: {
		readonly path: string;
		readonly method?: string;
		readonly token?: string;
		readonly body?: string;
	},
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
			{
				host: LOOPBACK_ADDRESS,
				port,
				path: options.path,
				method: options.method ?? 'GET',
				headers,
			},
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

suite('Web: as rotas do OpenCode', () => {
	let root: string;
	let assetsDir: string;
	let server: RunningWebServer;
	/** O que o health "responde", por status. */
	let healthStatus: number;
	const stopped: string[] = [];

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-opencode-web-'));
		assetsDir = await mkdtemp(join(tmpdir(), 'seshyina-opencode-assets-'));
		await writeFile(join(assetsDir, 'index.html'), '<!doctype html><title>t</title>', 'utf8');
		healthStatus = 200;
		const options: OpencodeManagerOptions = {
			detectCli: async () => '1.18.34',
			spawnServer: (input) => ({
				pid: 1,
				exited: new Promise(() => undefined),
				kill: () => stopped.push(String(input.port)),
			}),
			binary: 'opencode',
			findFreePort: async () => 45100,
			health: async () => ({ status: healthStatus }),
		};
		const opencode = new OpencodeManager(options);
		server = await startWebServer({
			version: '0.0.1',
			assetsDir,
			port: 0,
			opencode,
		});
	});

	teardown(async () => {
		await server.close();
		await removeFixtureTree(root);
		await removeFixtureTree(assetsDir);
	});

	test('sem o token, o estado e as ações são recusados', async () => {
		const status = await call(server.port, { path: '/api/opencode/status' });
		assert.strictEqual(status.status, 401);
		const connect = await call(server.port, { path: '/api/opencode/connect-managed', method: 'POST', body: '{}' });
		assert.strictEqual(connect.status, 401);
	});

	test('o estado começa "desconectado" — sem CLI inventada e sem conexão', async () => {
		const response = await call(server.port, { path: '/api/opencode/status', token: server.token });
		assert.strictEqual(response.status, 200);
		const body = JSON.parse(response.body) as { state: { state: string } };
		assert.strictEqual(body.state.state, 'not-configured');
	});

	test('um GET numa ação é 405: ação não acontece por pré-carregamento', async () => {
		for (const path of ['/api/opencode/connect-managed', '/api/opencode/connect-manual', '/api/opencode/disconnect']) {
			const response = await call(server.port, { path, token: server.token });
			assert.strictEqual(response.status, 405, path);
		}
	});

	test('o modo automático conecta, e a senha gerada não aparece em nada', async () => {
		const response = await call(server.port, {
			path: '/api/opencode/connect-managed',
			method: 'POST',
			token: server.token,
			body: '{}',
		});
		assert.strictEqual(response.status, 200);
		const body = JSON.parse(response.body) as { state: { state: string; mode?: string } };
		assert.strictEqual(body.state.state, 'connected');
		assert.strictEqual(body.state.mode, 'managed');
		assert.ok(!/password|senha|Basic /i.test(response.body), 'a resposta não tem senha');

		// Desconectar encerra o processo que nós iniciamos.
		const disconnected = await call(server.port, {
			path: '/api/opencode/disconnect',
			method: 'POST',
			token: server.token,
		});
		assert.strictEqual(disconnected.status, 200);
		assert.deepStrictEqual(stopped, ['45100']);
	});

	test('o modo automático não aceita parâmetros da página', async () => {
		const response = await call(server.port, {
			path: '/api/opencode/connect-managed',
			method: 'POST',
			token: server.token,
			body: JSON.stringify({ port: 80 }),
		});
		assert.strictEqual(response.status, 400);
	});

	test('o modo manual aceita endereço e senha, e a senha não volta', async () => {
		const response = await call(server.port, {
			path: '/api/opencode/connect-manual',
			method: 'POST',
			token: server.token,
			body: JSON.stringify({ baseUrl: 'http://127.0.0.1:51000', password: PASSWORD }),
		});
		assert.strictEqual(response.status, 200);
		assert.ok(!response.body.includes(PASSWORD), 'a senha nunca volta na resposta');
	});

	test('a página não pode mandar comando, binário ou shell', async () => {
		for (const extra of [{ command: 'calc' }, { binary: 'cmd.exe' }, { shell: true }]) {
			const response = await call(server.port, {
				path: '/api/opencode/connect-manual',
				method: 'POST',
				token: server.token,
				body: JSON.stringify({ baseUrl: 'http://127.0.0.1:51000', password: PASSWORD, ...extra }),
			});
			assert.strictEqual(response.status, 400, JSON.stringify(extra));
			assert.ok(!response.body.includes(PASSWORD));
		}
	});

	test('endereço HTTP remoto é recusado pela rota', async () => {
		const response = await call(server.port, {
			path: '/api/opencode/connect-manual',
			method: 'POST',
			token: server.token,
			body: JSON.stringify({ baseUrl: 'http://exemplo.com', password: PASSWORD }),
		});
		const body = JSON.parse(response.body) as { state: { state: string; reason?: string } };
		assert.strictEqual(body.state.state, 'unavailable');
		assert.ok(/loopback|HTTPS/.test(body.state.reason ?? ''));
	});

	test('senha errada aparece como autenticação inválida', async () => {
		healthStatus = 401;
		const response = await call(server.port, {
			path: '/api/opencode/connect-manual',
			method: 'POST',
			token: server.token,
			body: JSON.stringify({ baseUrl: 'http://127.0.0.1:51001', password: PASSWORD }),
		});
		assert.strictEqual(response.status, 409);
		const body = JSON.parse(response.body) as { state: { state: string } };
		assert.strictEqual(body.state.state, 'auth-invalid');
		assert.ok(!response.body.includes(PASSWORD));
	});

	test('sem gerenciador, as rotas respondem 404', async () => {
		const noManager = await startWebServer({ version: '0.0.1', assetsDir, port: 0 });
		try {
			const status = await call(noManager.port, { path: '/api/opencode/status', token: noManager.token });
			assert.strictEqual(status.status, 404);
			const connect = await call(noManager.port, {
				path: '/api/opencode/connect-managed',
				method: 'POST',
				token: noManager.token,
				body: '{}',
			});
			assert.strictEqual(connect.status, 404);
		} finally {
			await noManager.close();
		}
	});
	test('a área OpenCode atualiza o catálogo e mostra data, contagens e o erro recuperável', () => {
		const script = readFileSync(join(__dirname, '..', '..', 'src', 'web', 'assets', 'index.js'), 'utf8');
		// A ação existe e chama a rota certa.
		assert.ok(script.includes("'opencode-refresh-catalog': '/api/opencode/catalog/refresh'"));
		// Os fatos que a fase pede.
		for (const label of ['última descoberta', 'provedores', 'modelos', 'com credencial']) {
			assert.ok(script.includes(`fact('${label}'`), `o bloco mostra "${label}"`);
		}
		// Os estados do catálogo, incluindo o desatualizado que preserva o
		// resultado anterior.
		assert.ok(script.includes("tag('nunca atualizado'"));
		assert.ok(script.includes("tag('atualizado'"));
		assert.ok(script.includes("tag('desatualizado'"));
		assert.ok(script.includes('Os resultados abaixo são de'));
		// A ressalva de execução: o catálogo não é selecionável.
		assert.ok(script.includes('não podem ser escolhidos para conversas'));
	});
});

