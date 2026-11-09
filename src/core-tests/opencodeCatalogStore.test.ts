/**
 * O catálogo em disco e a leitura da saída do CLI.
 *
 * ## O que se prova
 *
 * 1. **Gravar e reler** devolve o mesmo catálogo — e o arquivo não tem
 *    preço, limite, capacidade nem credencial;
 * 2. **Um arquivo com campo de credencial** é recusado na leitura (o app não
 *    aceita um catálogo que traga chave, ainda que alguém o tenha gravado);
 * 3. **Um arquivo corrompido** é dito corrompido, e não "ausente" — quem usa
 *    sabe que havia algo e que não serve;
 * 4. **A saída do CLI** é lida pelo bloco de credenciais: nomes de provedor,
 *    nenhum valor, e nada de banner.
 */
import * as assert from 'assert';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { matchConnectedProviders, nameVariants, parseProvidersList } from '../app/opencodeCredentials';
import type { OpencodeCatalog } from '../app/opencodeCatalog';
import { OpencodeCatalogStore, parseStoredCatalog, serializeCatalog } from '../core/storage/opencodeCatalogStore';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const CATALOG: OpencodeCatalog = {
	version: 1,
	discoveredAt: '2026-10-23T12:00:00.000Z',
	providers: [
		{ id: 'openrouter', name: 'OpenRouter', modelCount: 2, connected: true },
		{ id: 'opencode', modelCount: 1, connected: false },
	],
	models: [
		{ providerId: 'openrouter', modelId: 'arcee-ai/trinity-large', name: 'Trinity Large', status: 'active' },
		{ providerId: 'openrouter', modelId: 'claude-sonnet', status: 'deprecated' },
		{ providerId: 'opencode', modelId: 'big-pickle', family: 'pickle', status: 'unknown' },
	],
};

suite('OpenCode: o catálogo em disco', () => {
	let root: string;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-opencode-catalog-'));
	});

	teardown(async () => {
		await removeFixtureTree(root);
	});

	test('grava e relê o mesmo catálogo', async () => {
		const path = join(root, 'opencode-catalog.json');
		const store = new OpencodeCatalogStore(path);

		const written = await store.write(CATALOG);
		assert.strictEqual(written.kind, 'written');

		const read = await store.read();
		assert.strictEqual(read.kind, 'present');
		if (read.kind === 'present') {
			assert.deepStrictEqual(read.catalog, CATALOG);
		}
	});

	test('o arquivo gravado não tem preço, limite, capacidade nem credencial', async () => {
		const path = join(root, 'opencode-catalog.json');
		await new OpencodeCatalogStore(path).write(CATALOG);
		const text = await readFile(path, 'utf8');
		for (const forbidden of ['"cost"', '"limit"', 'context', '"capabilities"', '"key"', 'token', 'secret', 'password']) {
			assert.ok(!text.includes(forbidden), `o catálogo gravado não pode ter ${forbidden}`);
		}
	});

	test('um arquivo com campo de credencial é recusado', () => {
		const text = JSON.stringify({ ...CATALOG, apiKey: 'sk-nao-deve-ser-lido' });
		assert.throws(() => parseStoredCatalog(text), /credencial/);
	});

	test('um arquivo corrompido é dito corrompido, não ausente', async () => {
		const path = join(root, 'opencode-catalog.json');
		await writeFile(path, '{ nao e json', 'utf8');
		const read = await new OpencodeCatalogStore(path).read();
		assert.strictEqual(read.kind, 'corrupt');
	});

	test('um arquivo de outra versão é recusado', () => {
		assert.throws(() => parseStoredCatalog(JSON.stringify({ version: 2 })), /versão/);
	});

	test('a forma gravada é estável', () => {
		const text = serializeCatalog(CATALOG);
		assert.ok(text.endsWith('\n'));
		assert.deepStrictEqual(JSON.parse(text), CATALOG);
	});

	test('a leitura da saída sem id: o nome e o tipo na linha seguinte', () => {
		// É o formato que o CLI instalado imprime: nome numa linha, tipo na
		// seguinte.
		const output = `
█▀▀█ █▀▀█ █▀▀█ █▀▀▄ █▀▀▀ █▀▀█ █▀▀█ █▀▀█
▀▀▀▀ █▀▀▀ █▀▀▀ ▀  ▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀

┌  Credentials ~\\.local\\share\\opencode\\auth.json
│
●  OpenCode api
│
●  OpenRouter api
│
└  2 credentials
`;
		const report = parseProvidersList(output);
		assert.deepStrictEqual([...report.connected].sort(), ['opencode-api', 'openrouter-api']);
		assert.strictEqual(report.names.get('openrouter-api'), 'OpenRouter api');
	});

	test('a forma com id entre parênteses também é lida', () => {
		const output = '┌  Credentials ~/.local/share/opencode/auth.json\n│\n●  OpenCode Zen (opencode)\n│\n●  OpenRouter (openrouter)\n│\n└  2 credentials\n';
		const report = parseProvidersList(output);
		assert.deepStrictEqual([...report.connected].sort(), ['opencode', 'openrouter']);
		assert.strictEqual(report.names.get('openrouter'), 'OpenRouter');
	});

	test('o nome do CLI casa com o id do catálogo: "OpenCode api" -> "opencode"', () => {
		// Os nomes reais que o CLI instalado imprime.
		const report = {
			connected: new Set(['opencode-api', 'openrouter-api']),
			names: new Map([
				['opencode-api', 'OpenCode api'],
				['openrouter-api', 'OpenRouter api'],
			]),
		};
		const matched = matchConnectedProviders(['openrouter', 'opencode', 'vercel', 'river'], report);
		assert.deepStrictEqual([...matched].sort(), ['opencode', 'openrouter']);
		assert.ok(nameVariants('OpenCode api').includes('opencode'));
	});

	test('um nome ambíguo não marca provedor nenhum', () => {
		const report = {
			connected: new Set(['api']),
			names: new Map([['api', 'Api']]),
		};
		const matched = matchConnectedProviders(['api', 'api-pro'], report);
		// "api" casa com "api" exatamente, via id; "Api" em si é ambíguo.
		assert.deepStrictEqual([...matched], ['api']);
	});

	test('zero credenciais não afirma nenhum provedor', () => {
		const output = '┌  Credentials ~/.local/share/opencode/auth.json\n│\n└  No credentials\n';
		const report = parseProvidersList(output);
		assert.strictEqual(report.connected.size, 0);
	});

	test('sem o bloco de credenciais, nada é afirmado', () => {
		const report = parseProvidersList('Warning: algo aconteceu\nOpenCode\n');
		assert.strictEqual(report.connected.size, 0);
	});
});
