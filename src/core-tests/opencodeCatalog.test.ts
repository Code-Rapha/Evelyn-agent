/**
 * O catálogo do OpenCode: o que se lê de `/api/model` e o que se recusa.
 *
 * ## O que se prova
 *
 * 1. **Formato válido**: múltiplos provedores e modelos, com o par
 *    `providerID`/`id` preservado exatamente como o servidor publicou;
 * 2. **Provedores conectados e desconectados**, agrupados com as contagens;
 * 3. **Formato inesperado** (sem `data`, item sem `id`) é recusado com o
 *    motivo — não interpretado "por analogia";
 * 4. **Campo de credencial** em qualquer profundidade derruba a leitura
 *    inteira, e o motivo **nomeia o campo**, nunca o valor;
 * 5. **Nada de preço, limite, capacidade ou disponibilidade gratuita** é
 *    copiado: o modelo guardado só tem identificação e o status do servidor;
 * 6. **Ids com barras** continuam distintos por provedor.
 */
import * as assert from 'assert';

import {
	buildProviders,
	catalogKey,
	findSensitiveField,
	parseOpencodeCatalog,
} from '../app/opencodeCatalog';

/** Um corpo no formato observado em `/api/model` (1.18.34). */
function validBody(): string {
	return JSON.stringify({
		location: { directory: 'G:\\projeto' },
		data: [
			{
				id: 'recursive/flint-v1.0:free',
				providerID: 'openrouter',
				name: 'Flint',
				family: 'flint',
				status: 'active',
				enabled: true,
				cost: [{ input: 0, output: 0 }],
				limit: { context: 128000, output: 8192 },
				capabilities: { tools: true, input: ['text'] },
			},
			{ id: 'claude-sonnet', providerID: 'openrouter', name: 'Claude Sonnet', status: 'deprecated' },
			{ id: 'big-pickle', providerID: 'opencode', status: 'active' },
			{ id: 'glm-5', providerID: 'river', name: 'GLM 5' },
		],
	});
}

suite('OpenCode: o catálogo que se lê', () => {
	test('um corpo válido é lido com o par provedor/modelo preservado', () => {
		const parsed = parseOpencodeCatalog(validBody());
		assert.strictEqual(parsed.ok, true);
		if (!parsed.ok) {
			return;
		}
		assert.strictEqual(parsed.models.length, 4);
		const first = parsed.models[0];
		assert.strictEqual(first.providerId, 'openrouter');
		assert.strictEqual(first.modelId, 'recursive/flint-v1.0:free', 'o id com barras é preservado');
		assert.strictEqual(first.name, 'Flint');
		assert.strictEqual(first.family, 'flint');
		assert.strictEqual(first.status, 'active');
		assert.strictEqual(first.enabled, true);

		const deprecated = parsed.models.find((model) => model.modelId === 'claude-sonnet');
		assert.strictEqual(deprecated?.status, 'deprecated');
		const unknown = parsed.models.find((model) => model.modelId === 'glm-5');
		assert.strictEqual(unknown?.status, 'unknown', 'sem status não é inventado "active"');
		assert.strictEqual(unknown?.enabled, undefined, 'sem enabled não é inventado');
	});

	test('preço, limite e capacidade não são copiados', () => {
		const parsed = parseOpencodeCatalog(validBody());
		assert.strictEqual(parsed.ok, true);
		if (!parsed.ok) {
			return;
		}
		const text = JSON.stringify(parsed.models);
		for (const forbidden of ['cost', 'limit', 'context', 'capabilities', 'price', 'pricing', 'tools']) {
			assert.ok(!text.includes(forbidden), `o catálogo guardado não pode ter "${forbidden}"`);
		}
		// E os campos que ele tem são só os conhecidos.
		const keys = new Set(parsed.models.flatMap((model) => Object.keys(model)));
		assert.deepStrictEqual(
			[...keys].sort(),
			['enabled', 'family', 'modelId', 'name', 'providerId', 'status'],
		);
	});

	test('ids iguais em provedores diferentes continuam distintos', () => {
		const parsed = parseOpencodeCatalog(
			JSON.stringify({
				data: [
					{ id: 'modelo', providerID: 'a' },
					{ id: 'modelo', providerID: 'b' },
				],
			}),
		);
		assert.strictEqual(parsed.ok, true);
		if (!parsed.ok) {
			return;
		}
		assert.strictEqual(parsed.models.length, 2);
		assert.notStrictEqual(catalogKey('a', 'modelo'), catalogKey('b', 'modelo'));
	});

	test('o mesmo par repetido não é duplicado', () => {
		const parsed = parseOpencodeCatalog(
			JSON.stringify({
				data: [
					{ id: 'x', providerID: 'a', name: 'X' },
					{ id: 'x', providerID: 'a', name: 'X de novo' },
				],
			}),
		);
		assert.strictEqual(parsed.ok, true);
		if (!parsed.ok) {
			return;
		}
		assert.strictEqual(parsed.models.length, 1);
	});

	test('providers: conectados e desconectados, com as contagens', () => {
		const parsed = parseOpencodeCatalog(validBody());
		assert.ok(parsed.ok);
		if (!parsed.ok) {
			return;
		}
		const providers = buildProviders(parsed.models, new Set(['openrouter']));
		const byId = new Map(providers.map((provider) => [provider.id, provider]));
		assert.strictEqual(byId.get('openrouter')?.connected, true);
		assert.strictEqual(byId.get('openrouter')?.modelCount, 2);
		assert.strictEqual(byId.get('opencode')?.connected, false);
		assert.strictEqual(byId.get('river')?.connected, false);
		assert.deepStrictEqual(
			providers.map((provider) => provider.id),
			['opencode', 'openrouter', 'river'],
			'ordenados por id, de forma estável',
		);
	});

	test('sem evidência de credencial, todos os provedores são desconectados', () => {
		const parsed = parseOpencodeCatalog(validBody());
		assert.ok(parsed.ok);
		if (!parsed.ok) {
			return;
		}
		const providers = buildProviders(parsed.models, new Set());
		assert.ok(providers.every((provider) => provider.connected === false));
	});

	test('formato inesperado é recusado, cada caso com o seu motivo', () => {
		const cases: ReadonlyArray<readonly [string, string]> = [
			['não é JSON', 'not-json'],
			['[]', 'unexpected-format'],
			['{}', 'unexpected-format'],
			['{"data":"nada"}', 'unexpected-format'],
			['{"providers":[]}', 'unexpected-format'],
			['{"data":[]}', 'no-providers'],
			['{"data":[{"id":"sem-provedor"}]}', 'unexpected-format'],
			['{"data":[{"providerID":"a"}]}', 'unexpected-format'],
			['{"data":["texto"]}', 'unexpected-format'],
		];
		for (const [body, code] of cases) {
			const parsed = parseOpencodeCatalog(body);
			assert.strictEqual(parsed.ok, false, body);
			if (!parsed.ok) {
				assert.strictEqual(parsed.rejection.code, code, body);
				assert.ok(parsed.rejection.reason.length > 0, 'o motivo é dito');
			}
		}
	});

	test('um campo de credencial derruba a leitura, e o motivo só nomeia o campo', () => {
		const body = JSON.stringify({
			data: [{ id: 'x', providerID: 'a', request: { headers: { authorization: 'Bearer segredo-que-nao-pode-sair' } } }],
		});
		const parsed = parseOpencodeCatalog(body);
		assert.strictEqual(parsed.ok, false);
		if (!parsed.ok) {
			assert.strictEqual(parsed.rejection.code, 'sensitive-field');
			assert.ok(parsed.rejection.reason.includes('authorization'));
			assert.ok(!parsed.rejection.reason.includes('segredo-que-nao-pode-sair'), 'o valor nunca aparece');
		}

		for (const field of ['apiKey', 'api_key', 'token', 'secret', 'password', 'privateKey', 'accessKey']) {
			const nested = JSON.stringify({ data: [{ id: 'x', providerID: 'a', meta: { [field]: 'valor' } }] });
			const nestedParsed = parseOpencodeCatalog(nested);
			assert.strictEqual(nestedParsed.ok, false, field);
			if (!nestedParsed.ok) {
				assert.strictEqual(nestedParsed.rejection.code, 'sensitive-field', field);
			}
		}
	});

	test('findSensitiveField olha nomes, em profundidade, e não valores', () => {
		assert.strictEqual(findSensitiveField({ a: { b: [{ c: 'token' }] } }), undefined, 'um valor"token" não é campo');
		assert.strictEqual(findSensitiveField({ a: { b: [{ token: 'x' }] } }), 'token');
	});

	test('um catálogo acima do teto é recusado', () => {
		const data = Array.from({ length: 20_001 }, (_, index) => ({ id: `m${index}`, providerID: 'p' }));
		const parsed = parseOpencodeCatalog(JSON.stringify({ data }));
		assert.strictEqual(parsed.ok, false);
		if (!parsed.ok) {
			assert.strictEqual(parsed.rejection.code, 'too-many');
		}
	});
});
