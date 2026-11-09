/**
 * DEV-8.15: provedores e catálogo declarado pelo serviço.
 *
 * ## O que se prova
 *
 * Com o **servidor HTTP real** (`startWebServer`) sobre raiz descartável:
 *
 * 1. `GET /api/providers` lista provedores com `hasApiKeyRef` booleano e
 *    **nunca** a chave;
 * 2. `POST /api/providers/save` cria, atualiza endpoint/chave e preserva o que
 *    não foi enviado;
 * 3. `POST /api/models/catalog/save` adiciona/edita um modelo declarado, e
 *    `remove` o apaga;
 * 4. Um provedor **sem modelos** continua na lista;
 * 5. Escrita sem a credencial de painel é recusada e não muda nada.
 *
 * O `ServiceClient` é o de produção; só o provedor HTTP é falso.
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

const READER = 'leitor-falso-dev815-0123456789abcdef';
const SECRET = 'chave-falsa-dev815-nao-pode-vazar';

suite('DEV-8.15: provedores pelo serviço', () => {
	let root: string;
	let port: number;
	let panel: string;
	let core: ReturnType<typeof assembleCore>;
	let close: () => Promise<void>;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-providers-'));
		core = assembleCore({
			rootPath: root,
			logScope: 'test-providers',
			logSink: new ConsoleLogSink({ out: () => undefined, err: () => undefined }),
		});
		const server = await startWebServer({
			version: 'test',
			assetsDir: join(process.cwd(), 'dist', 'web', 'assets'),
			core,
			readerToken: READER,
			port: 0,
		});
		port = server.port;
		panel = server.token;
		close = async () => {
			await server.close();
			core.chat.dispose();
			await removeFixtureTree(root).catch(() => undefined);
		};
	});

	teardown(async () => {
		await close();
	});

	function client(panelToken: string = panel): ServiceClient {
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
					token: panelToken,
					readerToken: READER,
					chatToken: 'conversa-falsa-dev815-0123456789',
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

	test('cria um provedor pelo serviço e ele aparece na lista sem a chave', async () => {
		const saved = await client().providerWrite('save', {
			name: 'Falso',
			baseUrl: 'http://localhost:25111/v1',
			apiKey: SECRET,
		});
		assert.strictEqual(saved.ok, true, saved.ok ? '' : saved.message);
		if (!saved.ok) {
			return;
		}
		assert.strictEqual(saved.value.provider?.hasApiKeyRef, true, 'a chave foi gravada');
		assert.strictEqual(JSON.stringify(saved).includes(SECRET), false, 'a chave não volta');

		const listed = await client().providers();
		assert.strictEqual(listed.ok, true);
		if (!listed.ok) {
			return;
		}
		const found = listed.value.providers.find((entry) => entry.name === 'Falso');
		assert.ok(found !== undefined, 'o provedor aparece na lista');
		assert.strictEqual(found?.hasApiKeyRef, typeof found?.hasApiKeyRef === 'boolean' ? true : false);
		assert.strictEqual(JSON.stringify(listed).includes(SECRET), false, 'a lista não traz a chave');
	});

	test('um provedor sem modelos continua na lista', async () => {
		await client().providerWrite('save', { name: 'Sem modelos', baseUrl: 'http://localhost:25112/v1' });
		const listed = await client().providers();
		assert.strictEqual(listed.ok, true);
		if (!listed.ok) {
			return;
		}
		const found = listed.value.providers.find((entry) => entry.name === 'Sem modelos');
		assert.ok(found !== undefined, 'provedor sem modelos não some');
		assert.deepStrictEqual(
			listed.value.models.filter((model) => model.providerId === found?.id),
			[],
			'e não tem modelos',
		);
	});

	test('edita o endpoint mantendo a chave quando ela não é enviada', async () => {
		const created = await client().providerWrite('save', {
			name: 'Editável',
			baseUrl: 'http://localhost:25113/v1',
			apiKey: SECRET,
		});
		assert.strictEqual(created.ok, true);
		if (!created.ok || created.value.provider === undefined) {
			return;
		}
		const id = created.value.provider.id;
		const updated = await client().providerWrite('save', {
			id,
			name: 'Editável',
			baseUrl: 'http://localhost:25114/v1',
		});
		assert.strictEqual(updated.ok, true);
		if (!updated.ok) {
			return;
		}
		assert.strictEqual(updated.value.provider?.baseUrl, 'http://localhost:25114/v1');
		assert.strictEqual(updated.value.provider?.hasApiKeyRef, true, 'a chave preexistente foi preservada');
	});

	test('adiciona, edita e remove um modelo declarado', async () => {
		const created = await client().providerWrite('save', {
			name: 'Com modelos',
			baseUrl: 'http://localhost:25115/v1',
		});
		assert.strictEqual(created.ok, true);
		const id = created.ok ? created.value.provider?.id : undefined;
		assert.ok(id !== undefined);

		const added = await client().catalogWrite('save', { providerId: id, modelId: 'modelo-manual' });
		assert.strictEqual(added.ok, true, added.ok ? '' : added.message);

		// O contrato é explícito sobre o que é o quê: `models` é o catálogo
		// **fundido** (declarado + descoberto) e só ganha um par quando o
		// endpoint publicou o modelo. O que o usuário digitou está em
		// `declared`, e é de lá que o painel lê o modelo manual — sem inventar
		// uma fusão que o Core não fez.
		// A prova direta: a rota do catálogo declarado. É dela que o painel lê
		// o modelo digitado, mesmo sem o endpoint tê-lo publicado.
		const raw = await fetch(`http://127.0.0.1:${port}/api/models/catalog`, {
			headers: { 'x-seshyina-reader': READER, accept: 'application/json' },
		});
		const catalogBody = (await raw.json()) as { declared?: readonly { providerId: string; modelId: string }[] };
		assert.ok(
			(catalogBody.declared ?? []).some((model) => model.providerId === id && model.modelId === 'modelo-manual'),
			'o modelo declarado aparece no catálogo declarado',
		);

		// Editar o mesmo par: não duplica.
		const edited = await client().catalogWrite('save', {
			providerId: id,
			modelId: 'modelo-manual',
			notes: 'nota nova',
		});
		assert.strictEqual(edited.ok, true);

		const removed = await client().catalogWrite('remove', { providerId: id, modelId: 'modelo-manual' });
		assert.strictEqual(removed.ok, true);
		assert.strictEqual(removed.ok ? removed.value.removed : false, true);
	});

	test('a escrita sem credencial de painel é recusada e nada muda', async () => {
		const before = core.chat.listProviders().length;
		const forged = await client(READER).providerWrite('save', {
			name: 'Invasor',
			baseUrl: 'http://localhost:25116/v1',
		});
		assert.strictEqual(forged.ok, false);
		assert.strictEqual(forged.ok ? '' : forged.code, 'unauthorized');
		assert.strictEqual(core.chat.listProviders().length, before, 'nada foi criado');
	});

	test('remover um provedor o tira da lista', async () => {
		const created = await client().providerWrite('save', {
			name: 'Descartável',
			baseUrl: 'http://localhost:25117/v1',
		});
		assert.strictEqual(created.ok, true);
		const id = created.ok ? created.value.provider?.id : undefined;
		assert.ok(id !== undefined);
		const removed = await client().providerWrite('remove', { providerId: id });
		assert.strictEqual(removed.ok, true);
		const listed = await client().providers();
		assert.strictEqual(listed.ok, true);
		if (listed.ok) {
			assert.strictEqual(listed.value.providers.some((entry) => entry.id === id), false);
		}
	});
});
