/**
 * R4S: resquícios de provedor removido, e modelos no modo conectado.
 *
 * ## Os dois defeitos que esta fase corrige
 *
 * 1. **Resquício:** remover um provedor apagava a configuração e a chave, mas
 *    os modelos descobertos e as quotas dele ficavam em `provider-models.json`
 *    — e reapareciam como dados de um provedor que não existe.
 * 2. **Modelos vazios no modo conectado:** o app sem Core devolvia `[]` para
 *    a lista de modelos; quem conhece os modelos é o serviço.
 */
import * as assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileDataStore } from '../adapters/local/fileDataStore';
import { ConsoleLogSink } from '../adapters/local/consoleLogSink';
import { assembleCore } from '../app/assemble';
import { ServiceClient } from '../desktop/serviceClient';
import { ServiceChatClient } from '../desktop/serviceChat';
import type { ServiceRecord } from '../app/serviceRecord';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const roots: string[] = [];

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'evelyn-r4s-'));
	roots.push(root);
	return root;
}

teardown(async () => {
	for (const root of roots.splice(0)) {
		await removeFixtureTree(root).catch(() => undefined);
	}
});

/** Um registro de serviço sintético, como o app o lê do disco. */
function fakeRecord(overrides: Partial<ServiceRecord> = {}): ServiceRecord {
	return {
		version: 1,
		protocol: 3,
		pid: 1,
		port: 1,
		startedAt: new Date().toISOString(),
		appVersion: '0.0.0',
		address: '127.0.0.1',
		token: 't'.repeat(64),
		readerToken: 'r'.repeat(64),
		chatToken: 'c'.repeat(64),
		...overrides,
	};
}

/** Um cliente de serviço com descoberta injetada — nenhum socket aberto. */
function clientFor(root: string, record: ServiceRecord | undefined): ServiceClient {
	return new ServiceClient({
		root,
		probe: async () => (record === undefined ? { kind: 'absent' } : { kind: 'active', record, health: {} as never }),
	});
}

suite('R4S: resquícios de um provedor removido', () => {
	test('remover o provedor apaga os modelos descobertos dele', async () => {
		const root = await makeRoot();
		const store = new FileDataStore({ rootPath: root });
		await store.applyModelListing({
			providerId: 'keeper',
			models: [{ modelId: 'bom' }],
			fetchedAt: new Date().toISOString(),
		});
		await store.applyModelListing({
			providerId: 'velho',
			models: [{ modelId: 'caro' }],
			fetchedAt: new Date().toISOString(),
		});

		assert.equal(await store.forgetProvider('velho'), true);

		assert.deepEqual(
			(await store.listDiscoveredModels()).map((entry) => `${entry.providerId}:${entry.modelId}`),
			['keeper:bom'],
			'só o provedor que ficou continua',
		);
	});

	test('esquecer um provedor sem registros é um no-op', async () => {
		const root = await makeRoot();
		const store = new FileDataStore({ rootPath: root });

		assert.equal(await store.forgetProvider('nunca-existiu'), false);
		assert.deepEqual(await store.listDiscoveredModels(), []);
	});

	test('a remoção pelo Core limpa o resquício (caminho real)', async () => {
		const root = await makeRoot();
		const core = assembleCore({
			rootPath: root,
			logScope: 'test',
			logSink: new ConsoleLogSink({ out: () => undefined, err: () => undefined }),
		});
		await core.chat.saveProvider({ id: 'efemero', name: 'Efêmero', baseUrl: 'http://127.0.0.1:1/v1' });
		await core.history.applyModelListing({
			providerId: 'efemero',
			models: [{ modelId: 'm1' }],
			fetchedAt: new Date().toISOString(),
		});
		assert.equal((await core.history.listDiscoveredModels('efemero')).length, 1);

		assert.equal(await core.chat.removeProvider('efemero'), true);

		assert.deepEqual(
			await core.history.listDiscoveredModels('efemero'),
			[],
			'nenhum modelo sobra para o provedor removido',
		);
		core.chat.dispose();
	});
});

suite('R4S: modelos no modo conectado', () => {
	test('o cliente pergunta ao serviço e devolve o que ele publica', async () => {
		const root = await makeRoot();
		const seen: { url?: string; reader?: string } = {};
		const client = new ServiceChatClient({
			root,
			service: clientFor(root, fakeRecord()),
			fetch: (async (url: string, init?: RequestInit) => {
				seen.url = String(url);
				seen.reader = (init?.headers as Record<string, string> | undefined)?.['x-seshyina-reader'];
				return new Response(
					JSON.stringify({
						available: [
							{ providerId: 'river', providerName: 'River', model: 'deepseek-ai/DeepSeek-V4.1-Flash' },
							{ providerId: 'river', providerName: 'River', model: 'Qwen/Qwen3.8-27B-FP8' },
						],
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}) as never,
		});

		const result = await client.listAvailableModels();

		assert.equal(result.ok, true);
		if (result.ok) {
			assert.deepEqual(
				result.models.map((entry) => entry.model),
				['deepseek-ai/DeepSeek-V4.1-Flash', 'Qwen/Qwen3.8-27B-FP8'],
			);
		}
		assert.equal(seen.url, 'http://127.0.0.1:1/api/models');
		// A credencial é a de **leitura**.
		assert.equal(seen.reader, 'r'.repeat(64));
	});

	test('sem serviço, diz que não há — não devolve lista vazia como sucesso', async () => {
		const root = await makeRoot();
		const client = new ServiceChatClient({
			root,
			service: clientFor(root, undefined),
			fetch: (async () => {
				throw new Error('não deveria ser chamado');
			}) as never,
		});

		const result = await client.listAvailableModels();

		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.code, 'inactive');
		}
	});

	test('resposta fora do contrato é recusada', async () => {
		const root = await makeRoot();
		const client = new ServiceChatClient({
			root,
			service: clientFor(root, fakeRecord()),
			fetch: (async () =>
				new Response(JSON.stringify({ available: 'nada' }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				})) as never,
		});

		const result = await client.listAvailableModels();

		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.code, 'invalid-response');
		}
	});
});
