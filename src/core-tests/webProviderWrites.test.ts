/**
 * As escrituras de provider da interface web.
 *
 * ## O que se prova
 *
 * 1. **Adicionar** grava o provedor e a chave vai para o `SecretStore` — e
 *    não para o estado, nem para a resposta;
 * 2. **A chave nunca volta**: nenhuma resposta, nenhum erro a contém;
 * 3. **Editar** exige um id existente; um id desconhecido é `404`;
 * 4. **Habilitar, papel e remover** são as operações reais do Core, com as
 *    recusas dele (rebaixar o roteador em uso continua `400`);
 * 5. **Testar** é a chamada real ao endpoint: um servidor que responde dá a
 *    lista dele, um que não responde dá erro — e nada fica gravado quando
 *    não responde;
 * 6. **Sem Core**, nada é aceito.
 */
import * as assert from 'assert';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assembleCore, type AssembledCore } from '../app/assemble';
import { ProviderWrites } from '../web/providerWrites';
import type { FetchLike } from '../core/providers/openaiCompatible';
import { ConsoleLogSink } from '../adapters/local/consoleLogSink';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

/** Um endpoint OpenAI-compatible falso, injetado no Core. */
function fakeEndpoint(models: readonly string[], options: { readonly reachable?: boolean } = {}): FetchLike {
	return async (url) => {
		if (options.reachable === false) {
			// O que o Node lanca quando o endereco nao escuta: e o caso real.
			throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' });
		}
		if (url.endsWith('/models')) {
			return {
				ok: true,
				status: 200,
				text: async () => JSON.stringify({ object: 'list', data: models.map((id) => ({ id })) }),
			};
		}
		return { ok: false, status: 404, text: async () => 'not found' };
	};
}

const SECRET = 'sk-nao-deve-aparecer-em-lugar-nenhum';

suite('Web: as escrituras de provider', () => {
	let root: string;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-writes-'));
	});

	teardown(async () => {
		await removeFixtureTree(root);
	});

	function core(models: readonly string[] = [], options: { readonly reachable?: boolean } = {}): AssembledCore {
		return assembleCore({
			rootPath: root,
			logSink: new ConsoleLogSink({ out: () => undefined, err: () => undefined }),
			// O Core ja aceita um `fetch` no construtor da sessao; e o mesmo
			// ponto que os testes do desktop usam. Nenhuma porta e aberta.
			fetchImpl: fakeEndpoint(models, options),
		});
	}

	test('adicionar grava o provedor e a chave vai para o SecretStore', async () => {
		const assembled = core();
		const api = new ProviderWrites(assembled);

		const reply = await api.save({
			name: 'Provedor de teste',
			baseUrl: 'http://127.0.0.1:9/v1',
			apiKey: SECRET,
		});

		assert.strictEqual(reply.status, 200);
		const summary = reply.body as { id: string; name: string; hasApiKeyRef: boolean };
		assert.strictEqual(summary.name, 'Provedor de teste');
		assert.strictEqual(summary.hasApiKeyRef, true, 'só o fato de existir');

		// A chave não está na resposta, no estado, e está no cofre.
		assert.ok(!JSON.stringify(reply.body).includes(SECRET), 'a resposta não pode conter a chave');
		const state = await readFile(join(root, 'state.json'), 'utf8');
		assert.ok(!state.includes(SECRET), 'o estado não pode conter a chave');
		const secrets = await readFile(join(root, 'secrets.json'), 'utf8');
		assert.ok(secrets.includes(SECRET), 'a chave tem de estar no SecretStore');
	});

	test('editar sem o id cria outro provedor; com o id edita o mesmo', async () => {
		const assembled = core();
		const api = new ProviderWrites(assembled);

		const created = (await api.save({ name: 'A', baseUrl: 'http://127.0.0.1:9/v1' })).body as { id: string };
		const edited = await api.save({ id: created.id, name: 'A renomeado', baseUrl: 'http://127.0.0.1:9/v1' });

		assert.strictEqual(edited.status, 200);
		assert.strictEqual((edited.body as { id: string }).id, created.id);
		const list = assembled.chat.listProviders();
		assert.strictEqual(list.length, 1, 'editar não pode duplicar');
		assert.strictEqual(list[0].name, 'A renomeado');
	});

	test('editar um provedor que não existe é 404', async () => {
		const api = new ProviderWrites(core());
		const reply = await api.save({ id: 'fantasma', name: 'X', baseUrl: 'http://127.0.0.1:9/v1' });
		assert.strictEqual(reply.status, 404);
	});

	test('um corpo inválido é 400, com a mensagem do parser', async () => {
		const api = new ProviderWrites(core());
		const reply = await api.save({ name: 'sem endereço' });
		assert.strictEqual(reply.status, 400);
		assert.ok(String((reply.body as { error: string }).error).length > 0);
	});

	test('habilitar e desabilitar usa a operação real do Core', async () => {
		const assembled = core();
		const api = new ProviderWrites(assembled);
		const created = (await api.save({ name: 'P', baseUrl: 'http://127.0.0.1:9/v1' })).body as { id: string };

		const off = await api.setEnabled({ providerId: created.id, enabled: false });
		assert.strictEqual(off.status, 200);
		assert.strictEqual((off.body as { status: string }).status, 'disabled');

		const on = await api.setEnabled({ providerId: created.id, enabled: true });
		assert.strictEqual((on.body as { status: string }).status, 'configured');
	});

	test('o papel de roteador é recusado quando o modo externo o usa', async () => {
		const assembled = core();
		const api = new ProviderWrites(assembled);
		const created = (await api.save({ name: 'P', baseUrl: 'http://127.0.0.1:9/v1' })).body as { id: string };
		await assembled.chat.changeRouterConfig({ mode: 'external', externalRouterProviderId: created.id });
		await api.setRole({ providerId: created.id, role: 'router' });

		const demote = await api.setRole({ providerId: created.id, role: 'provider' });
		assert.strictEqual(demote.status, 400, 'o Core recusa, e a API repassa');
		assert.ok(String((demote.body as { error: string }).error).includes('modo'));
	});

	test('remover apaga o provedor e a chave', async () => {
		const assembled = core();
		const api = new ProviderWrites(assembled);
		const created = (await api.save({ name: 'P', baseUrl: 'http://127.0.0.1:9/v1', apiKey: SECRET })).body as {
			id: string;
		};

		const removed = await api.remove({ providerId: created.id });
		assert.strictEqual(removed.status, 200);
		assert.strictEqual(assembled.chat.listProviders().length, 0);
		const secrets = await readFile(join(root, 'secrets.json'), 'utf8');
		assert.ok(!secrets.includes(SECRET), 'a chave vai com o provedor');
	});

	test('remover um provedor que não existe é 404', async () => {
		const api = new ProviderWrites(core());
		const reply = await api.remove({ providerId: 'fantasma' });
		assert.strictEqual(reply.status, 404);
	});

	test('testar uma conexão: responde com os modelos, ou falha sem gravar', async () => {
		// Um endpoint que responde.
		const assembled = core(['modelo-a', 'modelo-b']);
		const api = new ProviderWrites(assembled);

		const ok = await api.test({ baseUrl: 'http://127.0.0.1:9/v1', apiKey: SECRET });
		assert.strictEqual(ok.status, 200);
		const result = ok.body as { ok: boolean; modelCount: number; models: string[] };
		assert.strictEqual(result.ok, true);
		assert.strictEqual(result.modelCount, 2);
		assert.deepStrictEqual([...result.models], ['modelo-a', 'modelo-b']);
		assert.ok(!JSON.stringify(result).includes(SECRET), 'o teste não devolve a chave');
		assert.strictEqual(assembled.chat.listProviders().length, 0, 'um teste não deixa provedor para trás');

		// Um endpoint que não responde.
		const failingApi = new ProviderWrites(core([], { reachable: false }));
		const failing = await failingApi.test({ baseUrl: 'http://127.0.0.1:9/v1', apiKey: SECRET });
		const failure = failing.body as { ok: boolean; error?: string };
		assert.strictEqual(failure.ok, false);
		assert.ok((failure.error ?? '').length > 0, 'a falha tem uma mensagem');

		// Um provedor já gravado, testado com a chave que está no cofre.
		const storedCore = core(['m1']);
		const storedApi = new ProviderWrites(storedCore);
		const created = (
			await storedApi.save({ name: 'P', baseUrl: 'http://127.0.0.1:9/v1', apiKey: SECRET })
		).body as { id: string };
		const stored = await storedApi.test({ providerId: created.id });
		const storedResult = stored.body as { ok: boolean; modelCount: number };
		assert.strictEqual(storedResult.ok, true);
		assert.strictEqual(storedResult.modelCount, 1);
		assert.strictEqual(storedCore.chat.listProviders().length, 1, 'testar um gravado não remove');
	});

	test('a chave nunca aparece num erro', async () => {
		const api = new ProviderWrites(core());
		const reply = await api.test({ baseUrl: 'http://127.0.0.1:9/v1', apiKey: SECRET });
		assert.ok(!JSON.stringify(reply.body).includes(SECRET));
	});

	test('sem Core, nenhuma escrita é aceita', async () => {
		const api = new ProviderWrites(undefined);
		const calls = [
			api.save({ baseUrl: 'http://127.0.0.1:9/v1' }),
			api.setEnabled({ providerId: 'p', enabled: true }),
			api.setRole({ providerId: 'p', role: 'router' }),
			api.remove({ providerId: 'p' }),
			api.test({ baseUrl: 'http://127.0.0.1:9/v1' }),
		];
		for (const reply of await Promise.all(calls)) {
			assert.strictEqual(reply.status, 404);
		}
	});
});
