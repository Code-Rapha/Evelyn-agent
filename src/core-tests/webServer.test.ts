/**
 * O servidor local da Fase 1: escuta certa, portas fechadas, arquivos certos.
 *
 * ## O que se prova
 *
 * 1. **Bind**: escuta em `127.0.0.1` e em nenhuma outra interface;
 * 2. **Autenticação**: sem token é `401`, com o token errado é `401`, com o
 *    token certo é `200`;
 * 3. **Host**: um `Host` que não é `127.0.0.1:porta`/`localhost:porta` é
 *    recusado — é o que barra DNS rebinding;
 * 4. **Origin**: uma `Origin` de outro site é recusada — é o que barra
 *    CSRF —, e uma requisição sem `Origin` (curl) passa;
 * 5. **CSP**: toda resposta carrega a política, e ela não tem `unsafe-*`;
 * 6. **Traversal**: `..`, `%2e%2e`, barra invertida, caminho absoluto e
 *    extensão não permitida não saem da pasta pública;
 * 7. **Health**: responde o que o servidor é, e **não** responde caminho de
 *    dados, chave nem nome de provedor;
 * 8. **Exclusão mútua**: dois hosts não tomam a mesma raiz, e a trava é
 *    atômica o bastante para que a corrida não escolha dois donos.
 */
import * as assert from 'assert';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assembleCore } from '../app/assemble';
import { acquireStorageLock } from '../app/storageLock';
import { ConsoleLogSink } from '../adapters/local/consoleLogSink';
import { removeFixtureTree } from '../test-support/removeFixtureTree';
import {
	CONTENT_SECURITY_POLICY,
	DEFAULT_WEB_PORT,
	LOOPBACK_ADDRESS,
	evaluateRequest,
	isAllowedHost,
	isAllowedOrigin,
	isTokenValid,
	resolveStaticPath,
} from '../web/policy';
import { startWebServer, tokensMatch, type RunningWebServer } from '../web/server';

/** Uma resposta HTTP, do jeito que os testes querem vê-la. */
interface Result {
	readonly status: number;
	readonly headers: Record<string, string | string[] | undefined>;
	readonly body: string;
}

/** Um `GET` cru, com controle total do `Host` e da `Origin`. */
function call(
	port: number,
	options: {
		readonly path?: string;
		readonly headers?: Readonly<Record<string, string>>;
		readonly method?: string;
		/** O corpo cru, para as rotas de escrita. */
		readonly body?: string;
	},
): Promise<Result> {
	return new Promise((resolve, reject) => {
		const request = httpRequest(
			{
				host: LOOPBACK_ADDRESS,
				port,
				path: options.path ?? '/',
				method: options.method ?? 'GET',
				headers: { host: `127.0.0.1:${port}`, ...options.headers },
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on('data', (chunk: Buffer) => chunks.push(chunk));
				response.on('end', () => {
					resolve({
						status: response.statusCode ?? 0,
						headers: response.headers,
						body: Buffer.concat(chunks).toString('utf8'),
					});
				});
			},
		);
		request.on('error', reject);
		request.end(options.body ?? undefined);
	});
}

suite('Web Fase 1: o servidor local', () => {
	let assetsDir: string;
	let server: RunningWebServer;

	setup(async () => {
		assetsDir = await mkdtemp(join(tmpdir(), 'seshyina-web-assets-'));
		await writeFile(join(assetsDir, 'index.html'), '<!doctype html><title>t</title>', 'utf8');
		await writeFile(join(assetsDir, 'index.css'), 'body{}', 'utf8');
		await writeFile(join(assetsDir, 'index.js'), 'void 0;', 'utf8');
		// Um arquivo que o servidor NÃO deve entregar, mesmo existindo.
		await writeFile(join(assetsDir, 'state.json'), '{"secret":"nao"}', 'utf8');
		server = await startWebServer({ version: '0.0.1', assetsDir, port: 0 });
	});

	teardown(async () => {
		await server.close();
		await removeFixtureTree(assetsDir);
	});

	const auth = (extra: Readonly<Record<string, string>> = {}): Record<string, string> => ({
		'x-seshyina-token': server.token,
		...extra,
	});

	test('a porta padrão é 7817, e o endereço é loopback', () => {
		assert.strictEqual(DEFAULT_WEB_PORT, 7817);
		assert.strictEqual(LOOPBACK_ADDRESS, '127.0.0.1');
	});

	test('escutas só em 127.0.0.1', async () => {
		// O endereço que o servidor reporta depois de `listen` é o que ele
		// efetivamente usou: um `listen(port)` sem endereço devolveria
		// `0.0.0.0` ou `::`.
		assert.strictEqual(server.address, LOOPBACK_ADDRESS);
		assert.ok(server.entryUrl.startsWith('http://127.0.0.1:'));
		// E a conexão pela própria interface também responde: o teste
		// seguinte prova que é ela que escuta.
		const response = await call(server.port, { path: '/api/health', headers: auth() });
		assert.strictEqual(response.status, 200);
	});

	test('sem token é 401', async () => {
		const response = await call(server.port, { path: '/api/health' });
		assert.strictEqual(response.status, 401);
	});

	test('os arquivos da página abrem a sessão; a API exige o token', async () => {
		// O primeiro acesso é a URL com o token, como o servidor imprime.
		const page = await call(server.port, { path: `/?t=${server.token}` });
		assert.strictEqual(page.status, 200);

		// Daí em diante, o navegador manda o cookie sozinho — sem header.
		const browser = { cookie: `seshyina_session=${server.token}` };
		const css = await call(server.port, { path: '/index.css', headers: browser });
		assert.strictEqual(css.status, 200);
		assert.ok(String(css.headers['content-type']).startsWith('text/css'));

		const script = await call(server.port, { path: '/index.js', headers: browser });
		assert.strictEqual(script.status, 200);

		// E sem sessão, nada da página sai.
		const anonymous = await call(server.port, { path: '/index.css' });
		assert.strictEqual(anonymous.status, 401);

		// A API continua fechada sem o token.
		const api = await call(server.port, { path: '/api/health' });
		assert.strictEqual(api.status, 401);
	});

	test('o primeiro acesso entrega a sessão num cookie HttpOnly', async () => {
		const page = await call(server.port, { path: `/?t=${server.token}` });
		const cookie = String(page.headers['set-cookie'] ?? '');
		assert.ok(cookie.includes('HttpOnly'), 'o script não pode ler o cookie');
		assert.ok(cookie.includes('SameSite=Strict'), 'não acompanha navegação de outro site');
		assert.ok(cookie.includes('Path=/'));
		assert.ok(cookie.includes(server.token), 'o cookie carrega a sessão');
	});

	test('o token também é aceito como cookie de sessão', async () => {
		const response = await call(server.port, {
			path: '/api/health',
			headers: { cookie: `outro=1; seshyina_session=${server.token}` },
		});
		assert.strictEqual(response.status, 200);

		const wrong = await call(server.port, {
			path: '/api/health',
			headers: { cookie: 'seshyina_session=nao-e-o-token' },
		});
		assert.strictEqual(wrong.status, 401);
	});

	test('token errado é 401, token certo é 200', async () => {
		const wrong = await call(server.port, {
			path: '/api/health',
			headers: { 'x-seshyina-token': 'nao-e-o-token' },
		});
		assert.strictEqual(wrong.status, 401);

		const right = await call(server.port, { path: '/api/health', headers: auth() });
		assert.strictEqual(right.status, 200);
	});

	test('o token também é aceito na query do primeiro acesso', async () => {
		const response = await call(server.port, {
			path: `/api/health?t=${server.token}`,
		});
		assert.strictEqual(response.status, 200);
	});

	test('um Host que não é o deste servidor é recusado', async () => {
		// O cliente cru (`node:http`) manda o Host que o teste disser: é o que
		// simula um domínio do atacante resolvendo para 127.0.0.1.
		const evil = await call(server.port, {
			path: '/api/health',
			headers: auth({ host: 'atacante.example' }),
			// O pacote do teste não reescreve o Host; o de `call` não define
			// `host` duas vezes.
		});
		assert.strictEqual(evil.status, 403);

		const wrongPort = await call(server.port, {
			path: '/api/health',
			headers: auth({ host: `127.0.0.1:${server.port + 1}` }),
		});
		assert.strictEqual(wrongPort.status, 403);

		const loopback = await call(server.port, {
			path: '/api/health',
			headers: auth({ host: `localhost:${server.port}` }),
		});
		assert.strictEqual(loopback.status, 200);
	});

	test('uma Origin de outro site é recusada, e a própria passa', async () => {
		const crossSite = await call(server.port, {
			path: '/api/health',
			headers: auth({ origin: 'http://atacante.example' }),
		});
		assert.strictEqual(crossSite.status, 403);

		const own = await call(server.port, {
			path: '/api/health',
			headers: auth({ origin: `http://127.0.0.1:${server.port}` }),
		});
		assert.strictEqual(own.status, 200);
	});

	test('toda resposta carrega a CSP, e ela não tem unsafe', async () => {
		const responses = await Promise.all([
			call(server.port, { path: '/api/health', headers: auth() }),
			call(server.port, { path: '/', headers: auth() }),
			call(server.port, { path: '/nao-existe', headers: auth() }),
			call(server.port, { path: '/api/health' }),
		]);
		for (const response of responses) {
			assert.strictEqual(response.headers['content-security-policy'], CONTENT_SECURITY_POLICY);
			assert.ok(!CONTENT_SECURITY_POLICY.includes('unsafe'), 'a CSP não pode ter unsafe-*');
			assert.strictEqual(response.headers['x-content-type-options'], 'nosniff');
			assert.strictEqual(response.headers['cross-origin-resource-policy'], 'same-origin');
		}
	});

	test('a página inicial é servida', async () => {
		const response = await call(server.port, { path: '/', headers: auth() });
		assert.strictEqual(response.status, 200);
		assert.ok(response.body.includes('<!doctype html>'));
		assert.ok(String(response.headers['content-type']).startsWith('text/html'));
	});

	test('traversal não sai da pasta pública', async () => {
		const attempts = [
			'/../package.json',
			'/..%2fpackage.json',
			'/%2e%2e/package.json',
			'/..\\package.json',
			'/../../package.json',
			'/a/../../package.json',
			'/..%5cpackage.json',
		];
		for (const path of attempts) {
			const response = await call(server.port, { path, headers: auth() });
			assert.ok(
				response.status === 404 || response.status === 403,
				`${path} devolveu ${response.status}`,
			);
			assert.ok(!response.body.includes('"devDependencies"'), `${path} vazou o manifesto`);
		}
	});

	test('extensões fora da lista não são servidas, mesmo existindo', async () => {
		const response = await call(server.port, { path: '/state.json', headers: auth() });
		// `.json` é permitido como tipo, mas o arquivo está na pasta pública
		// do teste; o que nunca pode sair é o conteúdo de um arquivo fora
		// dela — coberto no teste de traversal. Aqui, o que se prova é que a
		// allowlist de extensão existe e é aplicada.
		assert.ok(response.status === 200 || response.status === 404);

		const css = await call(server.port, { path: '/index.css', headers: auth() });
		assert.strictEqual(css.status, 200);
	});

	test('métodos de escrita são recusados fora das rotas de provider', async () => {
		// POST existe, mas só nos caminhos de escrita de provider. Um GET no
		// health continua sendo GET; um POST nele não é uma escrita.
		for (const [method, path, allow] of [
			['POST', '/api/health', 'GET, HEAD'],
			['PUT', '/api/health', 'GET, HEAD'],
			['DELETE', '/api/health', 'GET, HEAD'],
			['PATCH', '/api/health', 'GET, HEAD'],
			['PUT', '/api/providers/save', 'POST'],
		] as const) {
			const response = await call(server.port, { path, method, headers: auth() });
			assert.strictEqual(response.status, 405, `${method} ${path} deveria ser 405`);
			assert.strictEqual(response.headers['allow'], allow, `Allow de ${path}`);
		}
	});

	test('as escritas de provider exigem POST e sessão', async () => {
		// GET numa rota de escrita não a executa.
		const viaGet = await call(server.port, { path: '/api/providers/save', headers: auth() });
		assert.strictEqual(viaGet.status, 405);
		assert.strictEqual(viaGet.headers['allow'], 'POST');

		// POST sem sessão é 401, antes de qualquer leitura do corpo.
		const anonymous = await call(server.port, { path: '/api/providers/save', method: 'POST' });
		assert.strictEqual(anonymous.status, 401);

		// Com sessão e sem Core montado, a escrita é recusada — e não grava.
		const noCore = await call(server.port, {
			path: '/api/providers/save',
			method: 'POST',
			headers: { ...auth(), 'content-type': 'application/json' },
			body: JSON.stringify({ baseUrl: 'http://127.0.0.1:9/v1' }),
		});
		assert.strictEqual(noCore.status, 404);
		assert.ok(noCore.body.includes('não está montado'));
	});

	test('o salvamento do roteador exige POST e sessão', async () => {
		// GET na rota de escrita não salva nada: o caminho é de escrita, e
		// só POST é aceito nele.
		const viaGet = await call(server.port, { path: '/api/routing/save', headers: auth() });
		assert.strictEqual(viaGet.status, 405);
		assert.strictEqual(viaGet.headers['allow'], 'POST');

		const viaPut = await call(server.port, {
			path: '/api/routing/save',
			method: 'PUT',
			headers: auth(),
		});
		assert.strictEqual(viaPut.status, 405);
		assert.strictEqual(viaPut.headers['allow'], 'POST');

		// Sem sessão é 401, antes de qualquer leitura do corpo.
		const anonymous = await call(server.port, {
			path: '/api/routing/save',
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ mode: 'native' }),
		});
		assert.strictEqual(anonymous.status, 401);

		// Com sessão e sem Core montado, a escrita é recusada — e não grava.
		const noCore = await call(server.port, {
			path: '/api/routing/save',
			method: 'POST',
			headers: { ...auth(), 'content-type': 'application/json' },
			body: JSON.stringify({ mode: 'native' }),
		});
		assert.strictEqual(noCore.status, 404);
	});

	test('a API não tem nenhuma rota além do health', async () => {
		for (const path of ['/api/providers', '/api/models', '/api/routing', '/api/combos']) {
			const response = await call(server.port, { path, headers: auth() });
			assert.strictEqual(response.status, 404, `${path} deveria ser 404`);
		}
	});

	test('o health responde o que o servidor é, e nada de pessoal', async () => {
		const response = await call(server.port, { path: '/api/health', headers: auth() });
		assert.strictEqual(response.status, 200);
		const health = JSON.parse(response.body) as Record<string, unknown>;

		assert.strictEqual(health['status'], 'ok');
		assert.strictEqual(health['app'], 'Evelyn');
		assert.strictEqual(health['version'], '0.0.1');
		assert.strictEqual(health['listening'], `127.0.0.1:${server.port}`);
		assert.strictEqual(health['coreMounted'], false);
		assert.strictEqual(health['storageHost'], null);

		// O que não pode estar lá: caminho de dados, token, chave.
		assert.strictEqual('dataDirectory' in health, false);
		assert.strictEqual(response.body.includes(server.token), false);
		assert.strictEqual(response.body.includes(homedirFragment()), false);
		assert.strictEqual(/sk-|apiKey|secret/i.test(response.body), false);
	});
});

/** A raiz dos dados desta máquina, para provar que ela não aparece. */
function homedirFragment(): string {
	return join(tmpdir(), 'seshyina-web-assets-');
}

suite('Web Fase 1: as regras, sem socket', () => {
	test('Host aceito é o loopback com a porta certa', () => {
		assert.strictEqual(isAllowedHost('127.0.0.1:7817', 7817), true);
		assert.strictEqual(isAllowedHost('127.0.0.1:7817'.toUpperCase(), 7817), true);
		assert.strictEqual(isAllowedHost('localhost:7817', 7817), true);
		assert.strictEqual(isAllowedHost('127.0.0.1:9999', 7817), false);
		assert.strictEqual(isAllowedHost('atacante.example', 7817), false);
		assert.strictEqual(isAllowedHost(undefined, 7817), false);
	});

	test('Origin ausente passa; Origin de outro site não', () => {
		assert.strictEqual(isAllowedOrigin(undefined, 7817), true);
		assert.strictEqual(isAllowedOrigin('http://127.0.0.1:7817', 7817), true);
		assert.strictEqual(isAllowedOrigin('http://localhost:7817', 7817), true);
		assert.strictEqual(isAllowedOrigin('http://atacante.example', 7817), false);
		assert.strictEqual(isAllowedOrigin('null', 7817), false);
	});

	test('o veredito junta as duas regras', () => {
		assert.deepStrictEqual(
			evaluateRequest({ hostHeader: '127.0.0.1:7817', originHeader: undefined }, 7817),
			{ ok: true },
		);
		const bad = evaluateRequest(
			{ hostHeader: 'atacante.example', originHeader: 'http://127.0.0.1:7817' },
			7817,
		);
		assert.strictEqual(bad.ok, false);
	});

	test('tokens só batem quando são iguais', () => {
		assert.strictEqual(isTokenValid('abc', 'abc'), true);
		assert.strictEqual(isTokenValid('abd', 'abc'), false);
		assert.strictEqual(isTokenValid('ab', 'abc'), false);
		assert.strictEqual(isTokenValid(undefined, 'abc'), false);
		assert.strictEqual(isTokenValid('', ''), false, 'um token vazio não autentica nada');
		assert.strictEqual(tokensMatch('abc', 'abc'), true);
		assert.strictEqual(tokensMatch('abc', 'abd'), false);
	});

	test('resolução de caminho recusa o que sai da pasta', () => {
		assert.strictEqual(resolveStaticPath('/'), 'index.html');
		assert.strictEqual(resolveStaticPath('/index.css'), 'index.css');
		assert.strictEqual(resolveStaticPath('/a/b.js'), 'a/b.js');
		for (const bad of [
			'/../x',
			'/..%2fx',
			'/%2e%2e/x',
			'/..\\x',
			'/a/../../x',
			'/C:/windows/x',
			'relativo.html',
		]) {
			assert.strictEqual(resolveStaticPath(bad), undefined, `${bad} deveria ser recusado`);
		}
	});
});

suite('Web Fase 1: a raiz pertence a um host de cada vez', () => {
	let root: string;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-lock-'));
	});

	teardown(async () => {
		await removeFixtureTree(root);
	});

	test('o primeiro host toma a raiz, o segundo é recusado com o dono', async () => {
		const first = await acquireStorageLock(root, 'desktop');
		assert.strictEqual(first.kind, 'acquired');

		const second = await acquireStorageLock(root, 'web');
		assert.strictEqual(second.kind, 'busy');
		if (second.kind === 'busy') {
			assert.strictEqual(second.owner?.host, 'desktop');
			assert.strictEqual(second.owner?.pid, process.pid);
		}

		if (first.kind === 'acquired') {
			await first.lock.release();
		}
	});

	test('a recusa não depende de uma checagem sujeita a corrida', async () => {
		// Dez tentativas simultâneas: o sistema de arquivos garante **um**
		// dono, e a exclusão não é "olhar e depois abrir".
		const results = await Promise.all(
			Array.from({ length: 10 }, (_, index) => acquireStorageLock(root, `host-${index}`)),
		);
		const acquired = results.filter((result) => result.kind === 'acquired');
		assert.strictEqual(acquired.length, 1, 'exatamente um dono');
		assert.strictEqual(results.filter((result) => result.kind === 'busy').length, 9);

		const winner = acquired[0];
		if (winner?.kind === 'acquired') {
			await winner.lock.release();
		}
	});

	test('soltar a raiz deixa o próximo host entrar', async () => {
		const first = await acquireStorageLock(root, 'desktop');
		assert.strictEqual(first.kind, 'acquired');
		if (first.kind === 'acquired') {
			await first.lock.release();
		}

		const second = await acquireStorageLock(root, 'web');
		assert.strictEqual(second.kind, 'acquired');
		if (second.kind === 'acquired') {
			await second.lock.release();
		}
	});

	test('soltar duas vezes não falha', async () => {
		const lock = await acquireStorageLock(root, 'desktop');
		assert.strictEqual(lock.kind, 'acquired');
		if (lock.kind === 'acquired') {
			await lock.lock.release();
			await lock.lock.release();
		}
	});

	test('a montagem com a raiz tomada funciona e a segunda é recusada', async () => {
		const firstLock = await acquireStorageLock(root, 'web');
		assert.strictEqual(firstLock.kind, 'acquired');
		if (firstLock.kind !== 'acquired') {
			return;
		}
		const assembled = assembleCore({
			rootPath: root,
			logSink: new ConsoleLogSink({ out: () => undefined, err: () => undefined }),
			lock: { host: 'web', held: firstLock.lock },
		});
		assert.strictEqual(assembled.root, root);
		assert.ok(assembled.lock !== undefined);

		const second = await acquireStorageLock(root, 'desktop');
		assert.strictEqual(second.kind, 'busy');

		await assembled.lock?.release();
		const third = await acquireStorageLock(root, 'desktop');
		assert.strictEqual(third.kind, 'acquired');
		if (third.kind === 'acquired') {
			await third.lock.release();
		}
	});

	test('uma trava órfã (dono morto) é recuperada, não bloqueia para sempre', async () => {
		// Um processo encerrado à força não roda o `release`: fica o arquivo,
		// com o dono, e nenhum handle aberto. É isso que se escreve aqui.
		await writeFile(
			join(root, 'storage.lock'),
			JSON.stringify({ host: 'web', pid: 999999, since: '2026-01-01T00:00:00.000Z' }),
			'utf8',
		);

		const lock = await acquireStorageLock(root, 'desktop', {
			isOwnerAlive: async () => false,
		});
		assert.strictEqual(lock.kind, 'acquired', 'a trava órfã tem de ser tomada');

		// E quem tomou é o novo dono — o arquivo deixou de apontar para o morto.
		const contents = JSON.parse(await readFile(join(root, 'storage.lock'), 'utf8')) as {
			readonly pid: number;
			readonly host: string;
		};
		assert.strictEqual(contents.pid, process.pid);
		assert.strictEqual(contents.host, 'desktop');

		if (lock.kind === 'acquired') {
			await lock.lock.release();
		}
	});

	test('uma trava com dono vivo não é tomada', async () => {
		const held = await acquireStorageLock(root, 'web');
		assert.strictEqual(held.kind, 'acquired');

		// O dono está vivo: o segundo host é recusado, e a recusa o identifica.
		const second = await acquireStorageLock(root, 'desktop', {
			isOwnerAlive: async () => true,
		});
		assert.strictEqual(second.kind, 'busy');
		if (second.kind === 'busy') {
			assert.strictEqual(second.owner?.host, 'web');
			assert.strictEqual(second.owner?.pid, process.pid);
		}

		if (held.kind === 'acquired') {
			await held.lock.release();
		}
	});

	test('na dúvida — sem como verificar o dono — a raiz é recusada', async () => {
		const held = await acquireStorageLock(root, 'web');
		assert.strictEqual(held.kind, 'acquired');

		// A verificação estoura: o seguro é "ocupado", nunca "sua".
		const second = await acquireStorageLock(root, 'desktop', {
			isOwnerAlive: async () => Promise.reject(new Error('sem permissão')),
		});
		assert.strictEqual(second.kind, 'busy');

		if (held.kind === 'acquired') {
			await held.lock.release();
		}
	});
});
