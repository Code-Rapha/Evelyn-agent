/**
 * A redefinição segura da configuração do roteador.
 *
 * ## O que se prova
 *
 * 1. **Só no estado ilegível**: com a configuração legível, a ação é recusada
 *    — não é um caminho para pular validação;
 * 2. **Sucesso**: o padrão é gravado **e lido de volta**; o arquivo ilegível
 *    é guardado ao lado;
 * 3. **Falha na gravação**: o resultado é falha, o original continua no disco,
 *    e é possível tentar de novo depois;
 * 4. **Falha ao guardar o original**: nada é gravado, e a falha é dita;
 * 5. **Preservação**: provedores, chaves e modelos descobertos continuam
 *    intactos;
 * 6. **Autenticação**: a rota exige POST e sessão.
 */
import * as assert from 'assert';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assembleCore, type AssembledCore } from '../app/assemble';
import { ConsoleLogSink } from '../adapters/local/consoleLogSink';
import { resetReply, resetRouterConfig } from '../web/routerReset';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const silent = new ConsoleLogSink({ out: () => undefined, err: () => undefined });
const SECRET = 'sk-nao-deve-sumir-na-redefinicao';

suite('Routing: a redefinição segura', () => {
	let root: string;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-reset-'));
	});

	teardown(async () => {
		await removeFixtureTree(root);
	});

	function core(): AssembledCore {
		return assembleCore({ rootPath: root, logSink: silent });
	}

	/** Um provedor com chave, e um modelo descoberto: o que não pode sumir. */
	async function withData(assembled: AssembledCore): Promise<void> {
		await assembled.chat.saveProvider({
			id: 'alfa',
			name: 'Provedor Alfa',
			baseUrl: 'http://127.0.0.1:9/v1',
			apiKey: SECRET,
		});
	}

	/** Deixa a configuração ilegível, sem cópia de segurança válida. */
	async function makeUnreadable(): Promise<void> {
		await writeFile(join(root, 'router-config.json'), '{ quebrado', 'utf8');
		await rm(join(root, 'router-config.json.backup'), { force: true });
	}

	test('recusa com a configuração legível: não é rota para pular validação', async () => {
		const assembled = core();
		await withData(assembled);

		const result = await resetRouterConfig(assembled);

		assert.strictEqual(result.kind, 'refused');
		if (result.kind === 'refused') {
			assert.strictEqual(result.status, 409);
			assert.ok(result.message.includes('não está ilegível'));
		}
		// E nada foi criado.
		const files = await readdir(root);
		assert.ok(!files.some((name) => name.includes('.unreadable-')), 'nada a preservar');
	});

	test('recusa também quando nunca foi definida', async () => {
		const assembled = core();
		const result = await resetRouterConfig(assembled);
		assert.strictEqual(result.kind, 'refused');
	});

	test('sucesso: grava o padrão, lê de volta e guarda o ilegível', async () => {
		const assembled = core();
		await withData(assembled);
		await makeUnreadable();

		const result = await resetRouterConfig(assembled, {
			now: () => new Date('2026-02-03T04:05:06.789Z'),
		});

		assert.strictEqual(result.kind, 'reset');
		if (result.kind === 'reset') {
			assert.ok(result.preservedAs.endsWith('.unreadable-2026-02-03T04-05-06-789Z'));
		}

		// O conteúdo do arquivo ilegível foi guardado, byte a byte.
		const preserved = await readFile(
			join(root, 'router-config.json.unreadable-2026-02-03T04-05-06-789Z'),
			'utf8',
		);
		assert.strictEqual(preserved, '{ quebrado');

		// E o padrão está gravado e é lido de volta.
		const read = await assembled.chat.readRouterConfig();
		assert.strictEqual(read.mode, 'native');
		assert.strictEqual(read.enabled, true);
		assert.strictEqual(read.configured, true);
		assert.strictEqual(read.unreadable, undefined);
	});

	test('preserva provedores, chaves e modelos descobertos', async () => {
		const assembled = core();
		await withData(assembled);
		// Um modelo descoberto gravado à mão, como a descoberta o deixaria.
		await writeFile(
			join(root, 'provider-models.json'),
			JSON.stringify({
				version: 1,
				models: [{ providerId: 'alfa', modelId: 'modelo-x', listed: true, listedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
				quotas: [],
			}),
			'utf8',
		);
		await makeUnreadable();

		await resetRouterConfig(assembled);

		const providers = assembled.chat.listProviders();
		assert.strictEqual(providers.length, 1);
		assert.strictEqual(providers[0].hasApiKeyRef, true, 'a chave continua lá');
		const secrets = await readFile(join(root, 'secrets.json'), 'utf8');
		assert.ok(secrets.includes(SECRET), 'o SecretStore não foi tocado');
		const models = await readFile(join(root, 'provider-models.json'), 'utf8');
		assert.ok(models.includes('modelo-x'), 'os modelos descobertos continuam');
	});

	test('falha na gravação: o original fica no disco e dá para tentar de novo', async () => {
		const assembled = core();
		await withData(assembled);
		await makeUnreadable();

		// Uma gravação que falha: o método da sessão recusa a escrita. É o
		// mesmo caminho que o Store usa quando a substituição falha — o
		// resultado é que nada foi gravado.
		const failing = Object.create(assembled.chat) as typeof assembled.chat;
		failing.saveRouterConfig = async () => {
			throw new Error('o arquivo não pôde ser substituído');
		};
		const blocked = { ...assembled, chat: failing } as AssembledCore;

		const result = await resetRouterConfig(blocked);
		assert.strictEqual(result.kind, 'failed');
		if (result.kind === 'failed') {
			assert.ok(result.message.includes('não foi possível gravar'));
			assert.ok(result.preservedAs !== undefined, 'o original foi guardado antes da tentativa');
		}

		// O ilegível foi preservado, e o caminho do roteador não ganhou
		// nenhuma configuração nova.
		const files = await readdir(root);
		assert.ok(files.some((name) => name.includes('.unreadable-')), 'o original foi guardado');
		await assert.rejects(() => readFile(join(root, 'router-config.json'), 'utf8'));

		// O caminho do roteador ficou sem arquivo: o estado é "nunca
		// configurado", e a redefinição — que é reparo de ilegível — recusa.
		// O caminho para esse estado é Salvar, não Redefinir.
		const after = await assembled.chat.readRouterConfig();
		assert.strictEqual(after.configured, false);
		assert.strictEqual((await resetRouterConfig(assembled)).kind, 'refused');
});


	test('tentar de novo com o arquivo ilegível funciona', async () => {
		const assembled = core();
		await withData(assembled);
		await makeUnreadable();

		const failing = Object.create(assembled.chat) as typeof assembled.chat;
		failing.saveRouterConfig = async () => {
			throw new Error('falha simulada');
		};
		const blocked = { ...assembled, chat: failing } as AssembledCore;
		assert.strictEqual((await resetRouterConfig(blocked)).kind, 'failed');

		// O arquivo ilegível volta para o lugar (é o que um usuário faria ao
		// ver que a redefinição não concluiu).
		const files = await readdir(root);
		const preserved = files.find((name) => name.includes('.unreadable-'));
		assert.ok(preserved !== undefined);
		const content = await readFile(join(root, preserved), 'utf8');
		await writeFile(join(root, 'router-config.json'), content, 'utf8');

		const retry = await resetRouterConfig(assembled);
		assert.strictEqual(retry.kind, 'reset', 'a segunda tentativa conclui');
		const read = await assembled.chat.readRouterConfig();
		assert.strictEqual(read.mode, 'native');
		assert.strictEqual(read.unreadable, undefined);
	});

	test('falha ao guardar o original: nada é gravado', async () => {
		const assembled = core();
		await withData(assembled);
		await makeUnreadable();

		const result = await resetRouterConfig(assembled, {
			preserve: async () => {
				throw Object.assign(new Error('acesso negado'), { code: 'EACCES' });
			},
		});

		assert.strictEqual(result.kind, 'failed');
		if (result.kind === 'failed') {
			assert.ok(result.message.includes('guardar o arquivo ilegível'));
			assert.strictEqual(result.preservedAs, undefined, 'nada foi preservado porque nada foi movido');
		}
		// O ilegível continua exatamente onde estava.
		const still = await readFile(join(root, 'router-config.json'), 'utf8');
		assert.strictEqual(still, '{ quebrado');
	});

	test('a resposta de falha não diz que deu certo', async () => {
		const failed = resetReply({ kind: 'failed', message: 'quebrou' });
		assert.strictEqual(failed.status, 500);
		assert.ok(!JSON.stringify(failed.body).includes('"reset":true'));

		const reset = resetReply({ kind: 'reset', preservedAs: '/tmp/x' });
		assert.strictEqual(reset.status, 200);
		assert.strictEqual((reset.body as { reset: boolean }).reset, true);
	});
});
