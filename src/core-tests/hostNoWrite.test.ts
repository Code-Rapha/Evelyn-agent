import * as assert from 'assert';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mountCore } from '../app/mount';
import { ConsoleLogSink } from '../adapters/local/consoleLogSink';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

suite('Hosts: nenhuma escrita sem a raiz', () => {
	test('um host recusado nao cria nem toca em arquivo de dados', async () => {
		const root = await mkdtemp(join(tmpdir(), 'seshyina-nored-'));
		try {
			const sink = new ConsoleLogSink({ out: () => undefined, err: () => undefined });
			// Primeiro host: monta normalmente.
			const desktop = await mountCore({
				host: 'desktop',
				name: 'Seshyina',
				rootPath: root,
				logSink: sink,
			});
			assert.strictEqual(desktop.kind, 'mounted');

			// Um arquivo de dados com conteudo: o host recusado nao pode mudar.
			await writeFile(join(root, 'state.json'), '{"conteudo":"intacto"}', 'utf8');

			const web = await mountCore({
				host: 'web',
				name: 'Seshyina (servidor local)',
				rootPath: root,
				logSink: sink,
			});
			assert.strictEqual(web.kind, 'busy');

			const { readFile } = await import('node:fs/promises');
			const state = await readFile(join(root, 'state.json'), 'utf8');
			assert.strictEqual(state, '{"conteudo":"intacto"}');

			if (desktop.kind === 'mounted') {
				await desktop.release();
			}
		} finally {
			await removeFixtureTree(root);
		}
	});

	test('o Core montado e a raiz travada sao o mesmo lugar', async () => {
		const root = await mkdtemp(join(tmpdir(), 'seshyina-sameroot-'));
		try {
			const mounted = await mountCore({
				host: 'web',
				name: 'Seshyina (servidor local)',
				rootPath: root,
				logSink: new ConsoleLogSink({ out: () => undefined, err: () => undefined }),
			});
			assert.strictEqual(mounted.kind, 'mounted');
			if (mounted.kind !== 'mounted') {
				return;
			}
			assert.strictEqual(mounted.core.root, root);
			// O lock esta no disco, na raiz montada.
			const { readFile } = await import('node:fs/promises');
			const owner = JSON.parse(await readFile(join(root, 'storage.lock'), 'utf8')) as {
				readonly host: string;
			};
			assert.strictEqual(owner.host, 'web');
			await mounted.release();
		} finally {
			await removeFixtureTree(root);
		}
	});
});
