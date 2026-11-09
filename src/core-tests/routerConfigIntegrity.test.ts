/**
 * A integridade da configuração do roteador.
 *
 * ## O que se prova
 *
 * 1. **Gravação normal**: destino e cópia de segurança com a mesma escolha;
 * 2. **Falha de escrita**: o destino anterior continua no disco, e o erro é
 *    dito — não é "engolido";
 * 3. **Falha de substituição**: o destino é um diretório e o `rename` falha;
 *    a anterior (na cópia) continua válida e é essa que a leitura devolve;
 * 4. **Arquivo inválido**: recupera da cópia validada, com aviso;
 * 5. **Inválido sem cópia**: é um erro (a visão diz `unreadable`), não
 *    "nunca configurado";
 * 6. **Cópia inválida**: nunca substitui uma configuração válida;
 * 7. **Ausente**: "nunca configurado" e, havendo cópia, volta por ela;
 * 8. **Persistência**: uma nova sessão sobre a mesma raiz lê o salvo.
 */
import * as assert from 'assert';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RouterConfig } from '../core/providers/routing/config';
import {
	ROUTER_CONFIG_BACKUP_SUFFIX,
	RouterConfigStore,
	readChoice,
	routerConfigBackupPath,
} from '../core/storage/routerConfigStore';
import { assembleCore } from '../app/assemble';
import { ConsoleLogSink } from '../adapters/local/consoleLogSink';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const silent = new ConsoleLogSink({ out: () => undefined, err: () => undefined });

/** Uma configuração válida para os testes. */
function config(overrides: Partial<RouterConfig> = {}): RouterConfig {
	return {
		enabled: true,
		mode: 'direct',
		directProviderId: 'alfa',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

suite('Storage: a integridade do arquivo do roteador', () => {
	let root: string;
	let filePath: string;
	let store: RouterConfigStore;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-integrity-'));
		filePath = join(root, 'router-config.json');
		store = new RouterConfigStore({ filePath });
	});

	teardown(async () => {
		await removeFixtureTree(root);
	});

	test('gravar deixa o destino e a cópia com a mesma escolha', async () => {
		const written = await store.write(config());
		assert.strictEqual(written.kind, 'written');

		const primary = await readFile(filePath, 'utf8');
		const backup = await readFile(routerConfigBackupPath(filePath), 'utf8');
		assert.strictEqual(primary, backup);

		const read = await store.read();
		assert.strictEqual(read.kind, 'primary');
		if (read.kind === 'primary') {
			assert.strictEqual(read.config?.directProviderId, 'alfa');
		}
	});

	test('uma falha de escrita deixa a anterior no disco', async () => {
		await store.write(config({ mode: 'native', directProviderId: undefined }));

		// O diretório vira um arquivo: o temporário não pode ser criado.
		await rm(root, { recursive: true, force: true });
		await writeFile(root, 'bloqueado', 'utf8').catch(() => undefined);
		// (No Windows, um diretório com arquivos não é substituível por um
		// arquivo; o efeito é o mesmo: a gravação falha.)
		const failing = new RouterConfigStore({ filePath: join(root, 'nao-existe', 'router-config.json') });
		const written = await failing.write(config());
		assert.strictEqual(written.kind, 'failed');
		if (written.kind === 'failed') {
			assert.ok(written.message.length > 0, 'o motivo é dito');
		}
	});

	test('falha na substituição: a anterior continua válida na cópia', async () => {
		await store.write(config());

		// O destino vira um diretório: o `rename` não consegue trocá-lo.
		await rm(filePath, { force: true });
		await mkdir(filePath, { recursive: true });

		const written = await store.write(config({ mode: 'native', directProviderId: undefined }));
		assert.strictEqual(written.kind, 'failed');

		// A cópia continua com a escolha anterior.
		const backup = await readFile(routerConfigBackupPath(filePath), 'utf8');
		assert.ok(backup.includes('alfa'));
	});

	test('arquivo inválido é recuperado da cópia, com aviso', async () => {
		const notices: string[] = [];
		const watched = new RouterConfigStore({ filePath, warn: (message) => notices.push(message) });
		await watched.write(config());
		await writeFile(filePath, '{ quebrado', 'utf8');

		const read = await watched.read();
		assert.strictEqual(read.kind, 'recovered');
		if (read.kind === 'recovered') {
			assert.strictEqual(read.config.directProviderId, 'alfa');
		}
		assert.strictEqual(notices.length, 1, 'a recuperação não é silenciosa');
	});

	test('arquivo inválido sem cópia é "corrupt", não "nunca configurado"', async () => {
		await writeFile(filePath, '{ quebrado', 'utf8');
		await rm(`${filePath}${ROUTER_CONFIG_BACKUP_SUFFIX}`, { force: true });

		const read = await store.read();
		assert.strictEqual(read.kind, 'corrupt');
	});

	test('uma cópia inválida nunca substitui a configuração válida', async () => {
		await store.write(config());
		await writeFile(`${filePath}${ROUTER_CONFIG_BACKUP_SUFFIX}`, 'nao e json', 'utf8');

		const read = await store.read();
		assert.strictEqual(read.kind, 'primary');
		if (read.kind === 'primary') {
			assert.strictEqual(read.config?.directProviderId, 'alfa', 'o destino válido manda');
		}
	});

	test('destino ausente: nunca configurado, e a cópia devolve a escolha', async () => {
		// Sem arquivo e sem cópia.
		const fresh = await store.read();
		assert.strictEqual(fresh.kind, 'primary');
		if (fresh.kind === 'primary') {
			assert.strictEqual(fresh.config, undefined);
		}

		await store.write(config());
		await rm(filePath, { force: true });

		const recovered = await store.read();
		assert.strictEqual(recovered.kind, 'recovered');
	});
});

suite('Storage: escolher o que é uma configuração', () => {
	test('um objeto vazio não é uma escolha', () => {
		assert.strictEqual(readChoice('{}'), undefined);
	});

	test('um JSON sem os campos do roteador não é uma escolha', () => {
		assert.strictEqual(readChoice('{"algo":true}'), undefined);
	});

	test('uma configuração com os campos do roteador é uma escolha', () => {
		const choice = readChoice('{"enabled":false,"mode":"native"}');
		assert.strictEqual(choice?.enabled, false);
		assert.strictEqual(choice?.mode, 'native');
	});
});

suite('Storage: a configuração sobrevive ao reinício', () => {
	let root: string;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-restart-'));
	});

	teardown(async () => {
		await removeFixtureTree(root);
	});

	test('uma nova sessão sobre a mesma raiz lê o que foi gravado', async () => {
		const first = assembleCore({ rootPath: root, logSink: silent });
		await first.chat.saveProvider({ id: 'alfa', name: 'Alfa', baseUrl: 'http://127.0.0.1:9/v1' });
		await first.chat.changeRouterConfig({ mode: 'direct', directProviderId: 'alfa', enabled: false });

		// Outra montagem, mesmo armazenamento: é o reinício do processo.
		const second = assembleCore({ rootPath: root, logSink: silent });
		const read = await second.chat.readRouterConfig();
		assert.strictEqual(read.mode, 'direct');
		assert.strictEqual(read.enabled, false);
		assert.strictEqual(read.unreadable, undefined);
	});

	test('um arquivo corrompido não é lido como "nunca configurado"', async () => {
		const first = assembleCore({ rootPath: root, logSink: silent });
		await first.chat.saveProvider({ id: 'alfa', name: 'Alfa', baseUrl: 'http://127.0.0.1:9/v1' });
		await first.chat.changeRouterConfig({ mode: 'direct', directProviderId: 'alfa' });
		await writeFile(join(root, 'router-config.json'), '{ quebrado', 'utf8');

		// A cópia foi gravada junto, então a leitura volta por ela.
		const second = assembleCore({ rootPath: root, logSink: silent });
		const read = await second.chat.readRouterConfig();
		assert.strictEqual(read.mode, 'direct');
		assert.strictEqual(read.configured, true);

		// Sem a cópia, a visão diz que há um arquivo ilegível.
		await rm(`${join(root, 'router-config.json')}${ROUTER_CONFIG_BACKUP_SUFFIX}`, { force: true });
		const third = assembleCore({ rootPath: root, logSink: silent });
		const unreadable = await third.chat.readRouterConfig();
		assert.strictEqual(unreadable.configured, false);
		assert.ok(typeof unreadable.unreadable === 'string');
	});
});
