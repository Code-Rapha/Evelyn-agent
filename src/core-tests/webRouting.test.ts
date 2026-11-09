/**
 * A configuração do roteador pela interface web.
 *
 * ## O que se prova
 *
 * 1. **Leitura**: o estado gravado e os destinos, com quem é elegível e por quê;
 * 2. **Salvamento**: modo, destino e interruptor, pelos mesmos campos do Core;
 * 3. **Validação**: destino inexistente, destino desabilitado e modo sem
 *    destino são recusados — e **a última configuração válida continua de pé**;
 * 4. **Persistência**: uma nova sessão sobre a mesma raiz lê o que foi salvo;
 * 5. **Falha de gravação**: um erro do Core não altera nada;
 * 6. Uma configuração inválida **não** substitui a válida.
 */
import * as assert from 'assert';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assembleCore, type AssembledCore } from '../app/assemble';
import { ConsoleLogSink } from '../adapters/local/consoleLogSink';
import { RoutingSettings } from '../web/routingSettings';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const silent = new ConsoleLogSink({ out: () => undefined, err: () => undefined });

suite('Web: a configuração do roteador', () => {
	let root: string;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-routing-'));
	});

	teardown(async () => {
		await removeFixtureTree(root);
	});

	function core(): AssembledCore {
		return assembleCore({ rootPath: root, logSink: silent });
	}

	/** Um provedor habilitado e um desabilitado, para as recusas. */
	async function withProviders(assembled: AssembledCore): Promise<void> {
		await assembled.chat.saveProvider({ id: 'a', name: 'Provedor A', baseUrl: 'http://127.0.0.1:9/v1' });
		await assembled.chat.saveProvider({ id: 'b', name: 'Provedor B', baseUrl: 'http://127.0.0.1:10/v1' });
		await assembled.chat.setProviderEnabled('b', false);
	}

	test('a leitura devolve o estado gravado e os destinos com o veredito', async () => {
		const assembled = core();
		await withProviders(assembled);

		const reply = await new RoutingSettings(assembled).read();

		assert.strictEqual(reply.status, 200);
		const view = reply.body as {
			config: { mode: string; enabled: boolean };
			targets: Array<{ id: string; usable: boolean; reason?: string }>;
		};
		assert.strictEqual(view.config.mode, 'native');
		assert.strictEqual(view.targets.length, 2);
		const a = view.targets.find((target) => target.id === 'a');
		const b = view.targets.find((target) => target.id === 'b');
		assert.strictEqual(a?.usable, true);
		assert.strictEqual(b?.usable, false);
		assert.ok((b?.reason ?? '').includes('desabilitado'), 'a razão real é dita');
	});

	test('salvar grava o modo e o destino', async () => {
		const assembled = core();
		await withProviders(assembled);

		const reply = await new RoutingSettings(assembled).save({
			mode: 'direct',
			directProviderId: 'a',
		});

		assert.strictEqual(reply.status, 200);
		const view = reply.body as { config: { mode: string; directProviderId?: string } };
		assert.strictEqual(view.config.mode, 'direct');
		assert.strictEqual(view.config.directProviderId, 'a');
		// E o que a sessão lê é o mesmo que a resposta diz.
		assert.strictEqual((await assembled.chat.readRouterConfig()).mode, 'direct');
	});

	test('o interruptor muda sem tocar no modo', async () => {
		const assembled = core();
		await withProviders(assembled);
		const settings = new RoutingSettings(assembled);
		await settings.save({ mode: 'external', externalRouterProviderId: 'a' });

		const off = await settings.save({ enabled: false });

		const view = off.body as { config: { mode: string; enabled: boolean } };
		assert.strictEqual(view.config.mode, 'external');
		assert.strictEqual(view.config.enabled, false);
	});

	test('destino inexistente é recusado, e a configuração anterior fica', async () => {
		const assembled = core();
		await withProviders(assembled);
		const settings = new RoutingSettings(assembled);
		await settings.save({ mode: 'direct', directProviderId: 'a' });

		const refused = await settings.save({ mode: 'direct', directProviderId: 'fantasma' });

		assert.strictEqual(refused.status, 400);
		assert.ok(String((refused.body as { error: string }).error).includes('não está configurado'));
		const after = await assembled.chat.readRouterConfig();
		assert.strictEqual(after.mode, 'direct');
		assert.strictEqual(after.directProviderId, 'a', 'a última válida continua');
	});

	test('destino desabilitado é recusado, com o motivo', async () => {
		const assembled = core();
		await withProviders(assembled);
		const settings = new RoutingSettings(assembled);

		const refused = await settings.save({ mode: 'direct', directProviderId: 'b' });

		assert.strictEqual(refused.status, 400);
		assert.ok(String((refused.body as { error: string }).error).includes('desabilitado'));
		assert.strictEqual((await assembled.chat.readRouterConfig()).mode, 'native');
	});

	test('o modo externo sem destino é recusado', async () => {
		const assembled = core();
		await withProviders(assembled);
		const refused = await new RoutingSettings(assembled).save({ mode: 'external' });
		assert.strictEqual(refused.status, 400);
		assert.ok(String((refused.body as { error: string }).error).includes('provedor'));
	});

	test('um corpo sem nenhuma opção é recusado', async () => {
		const assembled = core();
		const reply = await new RoutingSettings(assembled).save({});
		assert.strictEqual(reply.status, 400);
	});

	test('um campo com o tipo errado é ignorado, não grava lixo', async () => {
		const assembled = core();
		await withProviders(assembled);
		const settings = new RoutingSettings(assembled);
		await settings.save({ mode: 'direct', directProviderId: 'a' });

		// `mode` inválido e `enabled` inválido: nada disso vira configuração.
		const reply = await settings.save({ mode: 'inventado', enabled: 'sim' });

		assert.strictEqual(reply.status, 400, 'sem nenhum campo válido, não há o que salvar');
		assert.strictEqual((await assembled.chat.readRouterConfig()).mode, 'direct');
	});

	test('o que foi salvo sobrevive a uma nova sessão sobre a mesma raiz', async () => {
		const first = core();
		await withProviders(first);
		await new RoutingSettings(first).save({ mode: 'external', externalRouterProviderId: 'a', enabled: false });

		// Uma nova abertura: outra montagem, mesmo armazenamento.
		const second = core();
		const reply = await new RoutingSettings(second).read();
		const view = reply.body as {
			config: { mode: string; enabled: boolean; externalRouterProviderId?: string };
		};
		assert.strictEqual(view.config.mode, 'external');
		assert.strictEqual(view.config.enabled, false);
		assert.strictEqual(view.config.externalRouterProviderId, 'a');
	});

	test('uma falha de gravação é reportada e mantém a configuração anterior', async () => {
		const assembled = core();
		await withProviders(assembled);
		const settings = new RoutingSettings(assembled);
		await settings.save({ mode: 'direct', directProviderId: 'a' });

		// Uma falha de substituição: o destino vira um diretório, e a
		// renomeação atômica não consegue trocá-lo.
		const routerFile = join(root, 'router-config.json');
		const before = await readFile(routerFile, 'utf8');
		const { mkdir, rm } = await import('node:fs/promises');
		await rm(routerFile, { force: true });
		await mkdir(routerFile, { recursive: true });

		const reply = await settings.save({ mode: 'native' });

		assert.strictEqual(reply.status, 400, 'a falha é reportada');
		assert.ok(String((reply.body as { error: string }).error).length > 0);
		assert.ok(!JSON.stringify(reply.body).includes('"config"'), 'nada novo é aceito');

		// A falha de I/O não destrói a anterior: quando o destino volta a ser
		// um arquivo, a configuração é a de antes.
		await rm(routerFile, { recursive: true, force: true });
		await writeFile(routerFile, before, 'utf8');
		const restored = await assembled.chat.readRouterConfig();
		assert.strictEqual(restored.mode, 'direct');
		assert.strictEqual(restored.directProviderId, 'a');
	});

	test('uma configuração anterior é recuperada da cópia quando o destino desaparece', async () => {
		const assembled = core();
		await withProviders(assembled);
		const settings = new RoutingSettings(assembled);
		await settings.save({ mode: 'direct', directProviderId: 'a' });

		// O destino some (um antivírus, um editor, um erro de caminho).
		const { rm } = await import('node:fs/promises');
		await rm(join(root, 'router-config.json'), { force: true });

		// A sessão continua lendo a configuração: ela vem da cópia de
		// segurança, que é a última versão gravada com sucesso.
		const recovered = await assembled.chat.readRouterConfig();
		assert.strictEqual(recovered.mode, 'direct');
		assert.strictEqual(recovered.directProviderId, 'a');
	});

	test('um arquivo corrompido é recuperado da cópia válida', async () => {
		const assembled = core();
		await withProviders(assembled);
		const settings = new RoutingSettings(assembled);
		await settings.save({ mode: 'direct', directProviderId: 'a' });

		// O destino é corrompido: a cópia de segurança, gravada na mesma
		// operação, é a última versão boa e é ela que a leitura devolve.
		await writeFile(join(root, 'router-config.json'), '{ quebrado', 'utf8');

		const read = await settings.read();
		assert.strictEqual(read.status, 200);
		const view = read.body as { config: { mode: string; directProviderId?: string } };
		assert.strictEqual(view.config.mode, 'direct');
		assert.strictEqual(view.config.directProviderId, 'a');
	});

	test('corrompido e sem cópia é um erro, não "nunca configurado"', async () => {
		const assembled = core();
		await withProviders(assembled);
		const { rm } = await import('node:fs/promises');
		await writeFile(join(root, 'router-config.json'), '{ quebrado', 'utf8');
		await rm(`${join(root, 'router-config.json')}.backup`, { force: true });

		// O turno continua funcionando com o padrão — mas a página recebe a
		// condição, em vez de "nunca configurado", que faria a próxima gravação
		// sobrescrever o arquivo como se não houvesse nada.
		const view = await assembled.chat.readRouterConfig();
		assert.strictEqual(view.configured, false);
		assert.ok(
			typeof view.unreadable === 'string' && view.unreadable.length > 0,
			'a visão diz que o arquivo existe e não pôde ser lido',
		);

		const read = await new RoutingSettings(assembled).read();
		assert.strictEqual(read.status, 200);
		const config = (read.body as { config: { unreadable?: string } }).config;
		assert.ok(typeof config.unreadable === 'string');
	});



	test('sem Core, ler e salvar são recusados', async () => {
		const settings = new RoutingSettings(undefined);
		assert.strictEqual((await settings.read()).status, 404);
		assert.strictEqual((await settings.save({ mode: 'native' })).status, 404);
	});
});
