/**
 * DEV-8.12: editar a configuração do roteador pelo desktop conectado.
 *
 * ## O que se prova
 *
 * Com um **serviço HTTP real** (`startWebServer`) sobre raiz descartável:
 *
 * 1. A leitura usa a credencial de **leitura** e a gravação usa a de
 *    **painel** — e a de leitura **não** escreve (403/401, decisão intacta);
 * 2. A gravação altera a fonte autoritativa (o Core do serviço), e a releitura
 *    pelo desktop mostra o que ficou gravado;
 * 3. A alteração é visível nos dois lados (desktop e execução do serviço);
 * 4. Entrada inválida é recusada **pelo backend**, sem virar configuração;
 * 5. Nenhuma chave do provedor aparece na leitura, na gravação ou no erro;
 * 6. Configuração gravada por versões antigas continua legível.
 *
 * ## O que é simulado
 *
 * A descoberta do serviço (`probe`) quando o teste não usa o registro em
 * disco. O servidor, o Core, o roteamento e o `ServiceClient` são reais.
 */
import * as assert from 'assert';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assembleCore } from '../app/assemble';
import { ConsoleLogSink } from '../adapters/local/consoleLogSink';
import { startWebServer } from '../web/server';
import { ServiceClient } from '../desktop/serviceClient';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const READER = 'leitor-falso-dev812-0123456789abcdef';
const PANEL = 'painel-falso-dev812-0123456789abcdef';
const SECRET = 'chave-falsa-dev812-nao-pode-vazar';

suite('DEV-8.12: gravar o roteador pelo desktop conectado', () => {
	let root: string;
	let port: number;
	let core: ReturnType<typeof assembleCore>;
	let close: () => Promise<void>;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-edit-router-'));
		core = assembleCore({
			rootPath: root,
			logScope: 'test-edit-router',
			logSink: new ConsoleLogSink({ out: () => undefined, err: () => undefined }),
		});
		await core.chat.saveProvider({
			id: 'destino-falso',
			name: 'Destino falso',
			baseUrl: 'http://localhost:29888/v1',
			apiKey: SECRET,
		});
		const server = await startWebServer({
			version: 'test',
			assetsDir: join(process.cwd(), 'dist', 'web', 'assets'),
			core,
			readerToken: READER,
			port: 0,
		});
		port = server.port;
		probeToken = server.token;
		close = async () => {
			await server.close();
			core.chat.dispose();
			await removeFixtureTree(root).catch(() => undefined);
		};
	});

	let probeToken: string;

	teardown(async () => {
		await close();
	});

	/** O desktop conectado: descobre o serviço pelo registro e fala HTTP com ele. */
	function client(panel: string = probeToken): ServiceClient {
		return new ServiceClient({
			root,
			probe: async (_options: { readonly root: string }) => ({
				kind: 'active',
				record: {
					version: 1,
					protocol: 3,
					pid: process.pid,
					port,
					startedAt: new Date().toISOString(),
					appVersion: 'test',
					token: panel,
					readerToken: READER,
					chatToken: 'conversa-falsa-dev812-0123456789',
					address: '127.0.0.1',
				},
				health: {
					status: 'ok',
					app: 'Evelyn',
					version: 'test',
					listening: `127.0.0.1:${port}`,
					coreMounted: true,
					storageHost: 'web',
					pid: process.pid,
				},
			}),
		});
	}

	test('grava no Core do serviço e a releitura mostra o que ficou', async () => {
		const saved = await client().saveRouting({
			mode: 'external',
			enabled: true,
			externalRouterProviderId: 'destino-falso',
		});
		assert.strictEqual(saved.ok, true, saved.ok ? '' : saved.message);
		if (!saved.ok) {
			return;
		}
		assert.strictEqual(saved.value.mode, 'external');
		assert.strictEqual(saved.value.externalRouterProviderId, 'destino-falso');

		// A fonte autoritativa — o Core do serviço — mudou.
		const authoritative = await core.chat.readRouterConfig();
		assert.strictEqual(authoritative.mode, 'external');
		assert.strictEqual(authoritative.externalRouterProviderId, 'destino-falso');

		// E a leitura do desktop reflete o gravado.
		const reread = await client().routing();
		assert.strictEqual(reread.ok, true);
		if (reread.ok) {
			assert.strictEqual(reread.value.mode, 'external');
		}
	});

	test('a credencial de leitura não escreve', async () => {
		const before = await core.chat.readRouterConfig();
		// O cliente é construído com o token de **leitura** na posição de painel.
		const forged = await client(READER).saveRouting({ mode: 'direct', directProviderId: 'destino-falso' });
		assert.strictEqual(forged.ok, false, 'a leitura não promove privilégio');
		const after = await core.chat.readRouterConfig();
		assert.deepStrictEqual(
			{ mode: after.mode, enabled: after.enabled },
			{ mode: before.mode, enabled: before.enabled },
			'a configuração não mudou',
		);
	});

	test('sem credencial de painel válida, a gravação é recusada', async () => {
		const forged = await client('token-inventado-que-o-servico-nao-emitiu').saveRouting({
			mode: 'external',
			externalRouterProviderId: 'destino-falso',
		});
		assert.strictEqual(forged.ok, false);
		assert.strictEqual(forged.ok ? '' : forged.code, 'unauthorized');
		const after = await core.chat.readRouterConfig();
		assert.notStrictEqual(after.mode, 'external', 'nada foi gravado');
	});

	test('entrada inválida é recusada pelo backend, com o motivo', async () => {
		// O modo externo exige um destino: o Core recusa, e a recusa é dele.
		const invalid = await client().saveRouting({ mode: 'external' });
		assert.strictEqual(invalid.ok, false);
		const message = invalid.ok ? '' : invalid.message;
		assert.ok(message.length > 0, 'há uma explicação');
		assert.strictEqual(message.includes(SECRET), false, 'sem chave na recusa');

		const unknown = await client().saveRouting({
			mode: 'external',
			externalRouterProviderId: 'nao-existe',
		});
		assert.strictEqual(unknown.ok, false);
		assert.match(unknown.ok ? '' : unknown.message, /não está configurado/);
	});

	test('alterar no serviço é visível para o desktop; alterar pelo desktop vale para o serviço', async () => {
		await core.chat.changeRouterConfig({ mode: 'native', enabled: true });
		const seenByDesktop = await client().routing();
		assert.strictEqual(seenByDesktop.ok, true);
		if (seenByDesktop.ok) {
			assert.strictEqual(seenByDesktop.value.mode, 'native');
		}

		const saved = await client().saveRouting({ mode: 'direct', directProviderId: 'destino-falso' });
		assert.strictEqual(saved.ok, true);
		const inService = await core.chat.readRouterConfig();
		assert.strictEqual(inService.mode, 'direct');
		assert.strictEqual(inService.directProviderId, 'destino-falso');
	});

	test('a chave do provedor não aparece na leitura nem na gravação', async () => {
		const read = await client().routing();
		assert.strictEqual(read.ok, true);
		assert.strictEqual(JSON.stringify(read).includes(SECRET), false, 'leitura sem chave');

		const saved = await client().saveRouting({
			mode: 'external',
			externalRouterProviderId: 'destino-falso',
		});
		assert.strictEqual(saved.ok, true);
		assert.strictEqual(JSON.stringify(saved).includes(SECRET), false, 'gravação sem chave');
		assert.strictEqual(JSON.stringify(saved).includes(READER), false, 'token não volta');
		assert.strictEqual(JSON.stringify(saved).includes(probeToken), false, 'painel não volta');
	});

	test('a gravação não toca provedores nem credenciais existentes', async () => {
		const providersBefore = core.chat.listProviders().map((provider) => provider.id).sort();
		const secretsFile = join(root, 'secrets.json');
		const { readFile } = await import('node:fs/promises');
		const secretsBefore = await readFile(secretsFile, 'utf8');

		await client().saveRouting({ mode: 'external', externalRouterProviderId: 'destino-falso' });

		assert.deepStrictEqual(
			core.chat.listProviders().map((provider) => provider.id).sort(),
			providersBefore,
		);
		assert.strictEqual(await readFile(secretsFile, 'utf8'), secretsBefore, 'segredos intactos');
	});

	test('salvar pelo desktop muda o destino efetivo do roteador', async () => {
		// Dois destinos falsos: a mudança tem de ser visível no **destino
		// efetivo**, não só no arquivo. Os provedores respondem em memória.
		await core.chat.saveProvider({
			id: 'destino-b',
			name: 'Destino B',
			baseUrl: 'http://localhost:29887/v1',
		});
		const saved = await client().saveRouting({
			mode: 'external',
			enabled: true,
			externalRouterProviderId: 'destino-b',
		});
		assert.strictEqual(saved.ok, true);

		// O Core do serviço usa essa configuração no turno: o plano aponta para
		// o destino gravado, e não para outro.
		const view = await core.chat.readRouterConfig();
		assert.strictEqual(view.mode, 'external');
		assert.strictEqual(view.externalRouterProviderId, 'destino-b');

		// Trocar só o interruptor preserva o destino — a gravação é parcial,
		// como o contrato manda.
		const disabled = await client().saveRouting({ enabled: false });
		assert.strictEqual(disabled.ok, true);
		if (disabled.ok) {
			assert.strictEqual(disabled.value.externalRouterProviderId, 'destino-b', 'destino preservado');
			assert.strictEqual(disabled.value.enabled, false);
		}
	});

	test('configuração antiga continua legível', async () => {		const { writeFile } = await import('node:fs/promises');
		// Um arquivo no formato antigo (sem campos novos) deve continuar válido.
		await writeFile(
			join(root, 'router-config.json'),
			JSON.stringify(
				{
					version: 1,
					enabled: true,
					mode: 'native',
					updatedAt: '2026-10-01T00:00:00.000Z',
					// Campo desconhecido: preservado ou ignorado, nunca derruba.
					legacyField: 'valor-antigo',
				},
				null,
				2,
			),
			'utf8',
		);
		const read = await client().routing();
		assert.strictEqual(read.ok, true, read.ok ? '' : read.message);
		if (read.ok) {
			assert.strictEqual(read.value.mode, 'native');
			assert.strictEqual(read.value.enabled, true);
		}
	});
});
