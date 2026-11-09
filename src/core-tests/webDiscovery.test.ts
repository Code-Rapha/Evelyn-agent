/**
 * A descoberta de modelos pela interface web.
 *
 * ## O que se prova
 *
 * 1. Descobrir grava o que o endpoint publicou, e o catálogo lê de volta;
 * 2. Recarregar (uma nova sessão sobre a mesma raiz) continua vendo;
 * 3. **Uma falha não apaga** a lista anterior: os modelos continuam lá,
 *    marcados conforme o registro, e o erro aparece;
 * 4. Um provedor desabilitado é recusado com o motivo, sem perguntar;
 * 5. Um provedor que não existe é `404`;
 * 6. O catálogo diz o que é publicado, o que é declarado e o que é o fundido,
 *    sem inventar preço, acesso nem disponibilidade;
 * 7. Sem Core, nada acontece.
 */
import * as assert from 'assert';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assembleCore, type AssembledCore } from '../app/assemble';
import type { FetchLike } from '../core/providers/openaiCompatible';
import { ConsoleLogSink } from '../adapters/local/consoleLogSink';
import { DiscoveryWrites } from '../web/modelDiscovery';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const silent = new ConsoleLogSink({ out: () => undefined, err: () => undefined });

/** Um endpoint OpenAI-compatible de mentira, servido por `fetch`. */
function endpoint(models: readonly string[], reachable = true): FetchLike {
	return async (url) => {
		if (!reachable) {
			throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' });
		}
		if (url.endsWith('/models')) {
			return {
				ok: true,
				status: 200,
				text: async () =>
					JSON.stringify({
						object: 'list',
						data: models.map((id) => ({ id, object: 'model' })),
					}),
			};
		}
		return { ok: false, status: 404, text: async () => 'not found' };
	};
}

suite('Web: a descoberta de modelos', () => {
	let root: string;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-discovery-'));
	});

	teardown(async () => {
		await removeFixtureTree(root);
	});

	/** Uma montagem sobre a raiz do teste, com o endpoint dado. */
	function core(fetchImpl: FetchLike): AssembledCore {
		return assembleCore({ rootPath: root, logSink: silent, fetchImpl });
	}

	/** Um provedor gravado, pronto para ser descoberto. */
	async function withProvider(assembled: AssembledCore, id = 'p'): Promise<string> {
		const saved = await assembled.chat.saveProvider({
			id,
			name: 'Provedor de teste',
			baseUrl: 'http://127.0.0.1:9/v1',
		});
		return saved.id;
	}

	test('uma descoberta que acabou de funcionar não é reportada como `stale` (R4S)', async () => {
		// O corte de `stale` é o relógio antes de perguntar; `listedAt` é
		// gravado no mesmo milissegundo. Sem folga, o resultado era `stale`
		// com a lista **recém-gravada** — dizendo "não respondeu agora" sobre
		// um endpoint que acabou de responder.
		const assembled = core(endpoint(['alfa', 'beta']));
		const providerId = await withProvider(assembled);

		const reply = await new DiscoveryWrites(assembled).discover({ providerId });

		const body = reply.body as { outcomes: Array<{ status: string; error?: string }> };
		assert.strictEqual(body.outcomes[0].status, 'ok');
		assert.strictEqual(body.outcomes[0].error, undefined);
	});

	test('descobrir grava o que o endpoint publicou', async () => {
		const assembled = core(endpoint(['alfa', 'beta']));
		const providerId = await withProvider(assembled);

		const reply = await new DiscoveryWrites(assembled).discover({ providerId });

		assert.strictEqual(reply.status, 200);
		const body = reply.body as {
			outcomes: Array<{ status: string; modelCount: number }>;
			discovered: number;
		};
		assert.strictEqual(body.outcomes[0].status, 'ok');
		assert.strictEqual(body.outcomes[0].modelCount, 2);
		assert.strictEqual(body.discovered, 2);

		// E a leitura do catálogo devolve os modelos, com a origem.
		const catalog = await new DiscoveryWrites(assembled).catalog();
		assert.strictEqual(catalog.status, 200);
		const data = catalog.body as {
			models: Array<{ modelId: string; providerId: string }>;
			discovered: Array<{ modelId: string }>;
		};
		assert.deepStrictEqual(
			data.models.map((model) => model.modelId).sort(),
			['alfa', 'beta'],
		);
		assert.strictEqual(data.discovered.length, 2);
	});

	test('o resultado sobrevive a uma nova sessão sobre a mesma raiz', async () => {
		const first = core(endpoint(['alfa']));
		const providerId = await withProvider(first);
		await new DiscoveryWrites(first).discover({ providerId });

		// Uma nova abertura: outra montagem, mesmo armazenamento.
		const second = core(endpoint(['alfa']));
		const catalog = await new DiscoveryWrites(second).catalog();
		const data = catalog.body as { models: Array<{ modelId: string }> };
		assert.deepStrictEqual(
			data.models.map((model) => model.modelId),
			['alfa'],
			'o que foi descoberto está gravado, não só em memória',
		);
	});

	test('uma falha não apaga a lista anterior', async () => {
		// Primeiro, com o endpoint respondendo.
		const working = core(endpoint(['alfa', 'beta']));
		const providerId = await withProvider(working);
		await new DiscoveryWrites(working).discover({ providerId });

		// Agora o mesmo provedor, com o endpoint fora do ar.
		const failing = core(endpoint([], false));
		const reply = await new DiscoveryWrites(failing).discover({ providerId });

		assert.strictEqual(reply.status, 200);
		const body = reply.body as { outcomes: Array<{ status: string; error?: string }> };
		assert.notStrictEqual(body.outcomes[0].status, 'ok', 'a falha é dita');
		assert.ok((body.outcomes[0].error ?? '').length > 0, 'com o motivo');

		// E os modelos continuam lá.
		const catalog = await new DiscoveryWrites(failing).catalog();
		const data = catalog.body as { models: Array<{ modelId: string }> };
		assert.deepStrictEqual(
			data.models.map((model) => model.modelId).sort(),
			['alfa', 'beta'],
			'a lista anterior não pode desaparecer por uma falha',
		);
	});

	test('um provedor desabilitado é recusado, sem perguntar', async () => {
		let asked = false;
		const counting: FetchLike = async (url) => {
			asked = true;
			return endpoint(['x'])(url);
		};
		const assembled = core(counting);
		const providerId = await withProvider(assembled);
		await assembled.chat.setProviderEnabled(providerId, false);

		const reply = await new DiscoveryWrites(assembled).discover({ providerId });

		assert.strictEqual(reply.status, 400);
		assert.ok(String((reply.body as { error: string }).error).includes('desabilitado'));
		assert.strictEqual(asked, false, 'um desabilitado não é perguntado');
	});

	test('um provedor que não existe é 404', async () => {
		const assembled = core(endpoint(['x']));
		const reply = await new DiscoveryWrites(assembled).discover({ providerId: 'fantasma' });
		assert.strictEqual(reply.status, 404);
	});

	test('sem provedor, descobre todos os habilitados', async () => {
		const assembled = core(endpoint(['um', 'dois']));
		await withProvider(assembled, 'a');
		await withProvider(assembled, 'b');

		const reply = await new DiscoveryWrites(assembled).discover({});

		const body = reply.body as { outcomes: Array<{ providerId: string }> };
		assert.deepStrictEqual(
			body.outcomes.map((outcome) => outcome.providerId).sort(),
			['a', 'b'],
		);
	});

	test('o catálogo não inventa preço, acesso nem disponibilidade', async () => {
		const assembled = core(endpoint(['alfa']));
		const providerId = await withProvider(assembled);
		await new DiscoveryWrites(assembled).discover({ providerId });

		const catalog = await new DiscoveryWrites(assembled).catalog();
		const data = catalog.body as {
			models: Array<{ price?: unknown; access?: unknown; declaredAccess?: unknown; policyStatus: unknown }>;
		};
		const model = data.models[0];
		// O endpoint não publicou preço: o modelo não ganha um.
		assert.strictEqual(model.price, undefined);
		// E a política do Core é dita, não inventada.
		assert.ok(model.policyStatus !== undefined);
	});

	test('sem Core, nada é descoberto nem lido', async () => {
		const api = new DiscoveryWrites(undefined);
		assert.strictEqual((await api.discover({})).status, 404);
		assert.strictEqual((await api.catalog()).status, 404);
	});
});
