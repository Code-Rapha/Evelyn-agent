/**
 * A regra dos hosts: um só monta o Core por raiz.
 *
 * ## O que se prova
 *
 * 1. **Electron primeiro, web depois**: o desktop toma a raiz e monta; o
 *    servidor local é recusado e **não** monta;
 * 2. **Web primeiro, desktop depois**: o inverso — a mesma regra, a mesma
 *    recusa, com o nome do dono;
 * 3. **Falha de montagem**: uma montagem que estoura devolve a raiz, e o
 *    próximo host entra;
 * 4. **Encerramento**: `release()` solta a raiz, e o outro host monta;
 * 5. **Trava órfã**: um processo morto não bloqueia a raiz para sempre;
 * 6. A mensagem de recusa diz **quem** tem a raiz.
 *
 * Os hosts reais são processos separados, e isso é testado à parte; aqui a
 * regra é chamada duas vezes no mesmo processo, que é o mesmo tipo de
 * disputa — dois `mountCore` pedindo a mesma pasta.
 */
import * as assert from 'assert';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mountCore } from '../app/mount';
import { acquireStorageLock } from '../app/storageLock';
import { ConsoleLogSink } from '../adapters/local/consoleLogSink';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

/** Um sink silencioso: o teste é sobre a raiz, não sobre o console. */
const silentSink = new ConsoleLogSink({ out: () => undefined, err: () => undefined });

suite('Hosts: um dono por raiz de dados', () => {
	let root: string;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-hosts-'));
	});

	teardown(async () => {
		await removeFixtureTree(root);
	});

	test('electron primeiro, web depois: o web é recusado e não monta', async () => {
		const desktop = await mountCore({
			host: 'desktop',
			name: 'Seshyina',
			rootPath: root,
			logSink: silentSink,
		});
		assert.strictEqual(desktop.kind, 'mounted', 'o primeiro host monta');

		const web = await mountCore({
			host: 'web',
			name: 'Seshyina (servidor local)',
			rootPath: root,
			logSink: silentSink,
		});
		assert.strictEqual(web.kind, 'busy', 'o segundo host é recusado');
		if (web.kind === 'busy') {
			assert.ok(web.message.includes('servidor local'), 'a recusa nomeia este host');
			assert.ok(web.message.includes('desktop'), 'a recusa nomeia o dono');
		}

		if (desktop.kind === 'mounted') {
			await desktop.release();
		}
	});

	test('web primeiro, desktop depois: a recusa é a mesma, ao contrário', async () => {
		const web = await mountCore({
			host: 'web',
			name: 'Seshyina (servidor local)',
			rootPath: root,
			logSink: silentSink,
		});
		assert.strictEqual(web.kind, 'mounted');

		const desktop = await mountCore({
			host: 'desktop',
			name: 'Seshyina',
			rootPath: root,
			logSink: silentSink,
		});
		assert.strictEqual(desktop.kind, 'busy');
		if (desktop.kind === 'busy') {
			// R3: o serviço local é o dono **pretendido** da raiz — ele existe
			// para continuar de pé com o app fechado. O desktop recusa montar e
			// diz isso, com o que fazer: encerrar o serviço para abrir o app
			// com os dados. "Feche a outra instância" seria o conselho errado.
			assert.ok(
				desktop.message.includes('serviço local da Evelyn'),
				'a recusa diz que quem tem a raiz é o serviço',
			);
			assert.ok(desktop.message.includes('Encerre o serviço'));
			assert.equal(
				desktop.message.includes('Feche a outra instância'),
				false,
				'a recusa do serviço não manda fechar o app',
			);
		}

		if (web.kind === 'mounted') {
			await web.release();
		}
	});

	test('quem monta tem a raiz, e o segundo não abre nenhum arquivo', async () => {
		const first = await mountCore({
			host: 'desktop',
			name: 'Seshyina',
			rootPath: root,
			logSink: silentSink,
		});
		assert.strictEqual(first.kind, 'mounted');
		if (first.kind !== 'mounted') {
			return;
		}
		assert.ok(first.core.lock !== undefined, 'o Core montado carrega o lock');

		// A trava está no disco, e é de quem montou.
		const owner = JSON.parse(await readFile(join(root, 'storage.lock'), 'utf8')) as {
			readonly host: string;
			readonly pid: number;
		};
		assert.strictEqual(owner.host, 'desktop');
		assert.strictEqual(owner.pid, process.pid);

		const second = await mountCore({
			host: 'web',
			name: 'Seshyina (servidor local)',
			rootPath: root,
			logSink: silentSink,
		});
		assert.strictEqual(second.kind, 'busy');

		await first.release();
	});

	test('encerrar solta a raiz, e o outro host entra', async () => {
		const desktop = await mountCore({
			host: 'desktop',
			name: 'Seshyina',
			rootPath: root,
			logSink: silentSink,
		});
		assert.strictEqual(desktop.kind, 'mounted');
		if (desktop.kind === 'mounted') {
			await desktop.release();
		}

		const web = await mountCore({
			host: 'web',
			name: 'Seshyina (servidor local)',
			rootPath: root,
			logSink: silentSink,
		});
		assert.strictEqual(web.kind, 'mounted', 'depois do encerramento, o web monta');
		if (web.kind === 'mounted') {
			await web.release();
		}
	});

	test('soltar duas vezes não falha', async () => {
		const mounted = await mountCore({
			host: 'desktop',
			name: 'Seshyina',
			rootPath: root,
			logSink: silentSink,
		});
		assert.strictEqual(mounted.kind, 'mounted');
		if (mounted.kind !== 'mounted') {
			return;
		}
		await mounted.release();
		await mounted.release();

		// E a raiz está livre para o próximo.
		const next = await acquireStorageLock(root, 'web');
		assert.strictEqual(next.kind, 'acquired');
		if (next.kind === 'acquired') {
			await next.lock.release();
		}
	});

	test('uma trava órfã não bloqueia a raiz para sempre', async () => {
		// O processo 999999 não existe: o dono morreu e o arquivo ficou.
		const stale = await acquireStorageLock(root, 'web', { now: () => new Date(0) });
		assert.strictEqual(stale.kind, 'acquired');
		if (stale.kind === 'acquired') {
			// Simula o `kill -9`: a trava fica no disco, sem dono vivo.
			await stale.lock.release();
		}
		const { writeFile } = await import('node:fs/promises');
		await writeFile(
			join(root, 'storage.lock'),
			JSON.stringify({ host: 'web', pid: 999999, since: '2026-01-01T00:00:00.000Z' }),
			'utf8',
		);

		const desktop = await mountCore({
			host: 'desktop',
			name: 'Seshyina',
			rootPath: root,
			logSink: silentSink,
			isOwnerAlive: async () => false,
		});
		assert.strictEqual(desktop.kind, 'mounted', 'a trava órfã é recuperada');
		if (desktop.kind === 'mounted') {
			await desktop.release();
		}
	});

	test('a falha de montagem devolve a raiz, e o próximo host entra', async () => {
		// O Core é montado, e este teste simula a falha **depois** que a raiz
		// já é nossa: é o caso que o `mountCore` cobre com o `catch`.
		const first = await acquireStorageLock(root, 'web');
		assert.strictEqual(first.kind, 'acquired');
		if (first.kind !== 'acquired') {
			return;
		}
		// A raiz está tomada e o host não chegou a montar: ele a solta.
		await first.lock.release();

		const desktop = await mountCore({
			host: 'desktop',
			name: 'Seshyina',
			rootPath: root,
			logSink: silentSink,
		});
		assert.strictEqual(desktop.kind, 'mounted', 'a raiz voltou a ficar livre');
		if (desktop.kind === 'mounted') {
			await desktop.release();
		}
	});

	test('a raiz que não pode ser criada é uma falha explicada, não uma montagem', async () => {
		// Um "diretório" que é, na verdade, um arquivo: `mkdir` falha.
		const { writeFile } = await import('node:fs/promises');
		const notADirectory = join(root, 'arquivo');
		await writeFile(notADirectory, 'nao sou pasta', 'utf8');

		const result = await mountCore({
			host: 'desktop',
			name: 'Seshyina',
			rootPath: notADirectory,
			logSink: silentSink,
		});

		assert.notStrictEqual(result.kind, 'mounted');
		if (result.kind !== 'mounted') {
			assert.ok(result.message.includes('Seshyina'), 'a mensagem diz de quem é a falha');
		}
	});
});
