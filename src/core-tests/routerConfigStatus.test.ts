/**
 * A transparência do estado da configuração do roteador.
 *
 * ## O que se prova
 *
 * 1. A regra deriva quatro estados de fatos do Core, e nada mais;
 * 2. **normal**: arquivo lido;
 * 3. **recovered**: cópia de segurança usada;
 * 4. **unreadable**: arquivo existe e não pôde ser lido, e o que vale é o
 *    padrão — a página diz isso;
 * 5. **unset**: nunca configurado;
 * 6. O servidor **recusa** salvar no estado ilegível, mesmo que a tela
 *    deixasse passar;
 * 7. Nos outros três, salvar continua funcionando.
 */
import * as assert from 'assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assembleCore, type AssembledCore } from '../app/assemble';
import { ConsoleLogSink } from '../adapters/local/consoleLogSink';
import { canSaveRouterConfig, routerConfigStatus, type RouterConfigView } from '../desktop/routerConfigStatus';
import { RoutingSettings } from '../web/routingSettings';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const silent = new ConsoleLogSink({ out: () => undefined, err: () => undefined });

/** Uma visão mínima, para a regra pura. */
function view(overrides: Partial<RouterConfigView> = {}): RouterConfigView {
	return {
		mode: 'native',
		enabled: true,
		updatedAt: '2026-01-01T00:00:00.000Z',
		configured: true,
		...overrides,
	};
}

suite('Routing: a regra do estado', () => {
	test('normal: há configuração e nada de errado', () => {
		assert.strictEqual(routerConfigStatus(view()), 'normal');
	});

	test('recovered: a cópia de segurança foi usada', () => {
		assert.strictEqual(routerConfigStatus(view({ recoveredFromBackup: true })), 'recovered');
	});

	test('unreadable vence tudo: há arquivo, não há leitura', () => {
		assert.strictEqual(
			routerConfigStatus(view({ unreadable: 'o arquivo não pôde ser lido', recoveredFromBackup: true })),
			'unreadable',
			'um arquivo ilegível é o pior estado, mesmo que haja cópia',
		);
	});

	test('unset: nunca configurado', () => {
		assert.strictEqual(routerConfigStatus(view({ configured: false })), 'unset');
	});

	test('salvar é recusado no estado ilegível, e permitido nos outros', () => {
		assert.strictEqual(canSaveRouterConfig('unreadable'), false);
		assert.strictEqual(canSaveRouterConfig('normal'), true);
		assert.strictEqual(canSaveRouterConfig('recovered'), true);
		assert.strictEqual(canSaveRouterConfig('unset'), true);
	});
});

suite('Routing: os estados reais, pelo Core', () => {
	let root: string;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-status-'));
	});

	teardown(async () => {
		await removeFixtureTree(root);
	});

	function core(): AssembledCore {
		return assembleCore({ rootPath: root, logSink: silent });
	}

	async function provider(assembled: AssembledCore): Promise<void> {
		await assembled.chat.saveProvider({ id: 'a', name: 'Provedor A', baseUrl: 'http://127.0.0.1:9/v1' });
	}

	test('nunca configurado: unset, e salvar funciona', async () => {
		const assembled = core();
		await provider(assembled);
		const settings = new RoutingSettings(assembled);

		const read = await settings.read();
		assert.strictEqual(read.status, 200);
		assert.strictEqual((read.body as { status: string }).status, 'unset');

		const saved = await settings.save({ mode: 'direct', directProviderId: 'a' });
		assert.strictEqual(saved.status, 200);
	});

	test('normal: depois de salvar, o estado é normal', async () => {
		const assembled = core();
		await provider(assembled);
		const settings = new RoutingSettings(assembled);
		await settings.save({ mode: 'direct', directProviderId: 'a' });

		const read = await settings.read();
		const body = read.body as { status: string; config: { recoveredFromBackup?: boolean } };
		assert.strictEqual(body.status, 'normal');
		assert.strictEqual(body.config.recoveredFromBackup, undefined);
	});

	test('recuperado: o destino corrompido volta pela cópia, e o estado diz isso', async () => {
		const assembled = core();
		await provider(assembled);
		await new RoutingSettings(assembled).save({ mode: 'direct', directProviderId: 'a' });

		// Corrompe o destino: a leitura usa a cópia.
		await writeFile(join(root, 'router-config.json'), '{ quebrado', 'utf8');

		const read = await new RoutingSettings(core()).read();
		const body = read.body as { status: string; config: { recoveredFromBackup?: boolean } };
		assert.strictEqual(body.status, 'recovered');
		assert.strictEqual(body.config.recoveredFromBackup, true);
	});

	test('ilegível sem cópia: o estado é dito, e salvar é recusado', async () => {
		const assembled = core();
		await provider(assembled);
		await new RoutingSettings(assembled).save({ mode: 'direct', directProviderId: 'a' });

		// Corrompe o destino e remove a cópia.
		await writeFile(join(root, 'router-config.json'), '{ quebrado', 'utf8');
		await rm(join(root, 'router-config.json.backup'), { force: true });

		const settings = new RoutingSettings(core());
		const read = await settings.read();
		const body = read.body as { status: string; config: { unreadable?: string; configured: boolean } };
		assert.strictEqual(body.status, 'unreadable');
		assert.ok(typeof body.config.unreadable === 'string');
		assert.strictEqual(body.config.configured, false, 'não é uma escolha');

		// E a escrita é recusada: o formulário estaria com o padrão.
		const refused = await settings.save({ mode: 'native' });
		assert.strictEqual(refused.status, 409);
		assert.ok(String((refused.body as { error: string }).error).includes('repare'));

		// O arquivo ilegível continua lá: a recusa não o apagou.
		const stillThere = await import('node:fs/promises').then((fs) =>
			fs.readFile(join(root, 'router-config.json'), 'utf8'),
		);
		assert.strictEqual(stillThere, '{ quebrado');
	});
});
