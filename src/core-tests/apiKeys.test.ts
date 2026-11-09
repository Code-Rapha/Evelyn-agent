/**
 * R1: as credenciais de cliente da API local.
 *
 * O que estes testes fixam, e por quê:
 *
 * - a chave completa **não** existe no arquivo — só o hash;
 * - revogar apaga a entrada, e a chave revogada deixa de valer;
 * - rotacionar troca tudo numa escrita atômica;
 * - um arquivo corrompido recusa chaves em vez de aceitar qualquer uma;
 * - escopos `panel` e `client` são diferentes, e uma chave sem `client`
 *   não vale para `/v1`.
 */
import * as assert from 'assert';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ApiKeyStore, ApiKeyStoreError, API_KEYS_FILE, hashApiKey } from '../core/security/apiKeys';

const roots: string[] = [];

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'evelyn-apikeys-'));
	roots.push(root);
	return root;
}

function storeFor(root: string, options: { readonly now?: () => Date } = {}): ApiKeyStore {
	return new ApiKeyStore({
		filePath: join(root, API_KEYS_FILE),
		...(options.now !== undefined ? { now: options.now } : {}),
	});
}

teardown(async () => {
	for (const root of roots.splice(0)) {
		await rm(root, { recursive: true, force: true }).catch(() => undefined);
	}
});

suite('R1: chaves de cliente', () => {
	test('a chave completa aparece uma vez e nunca é gravada', async () => {
		const root = await makeRoot();
		const store = storeFor(root);

		const created = await store.create({ name: 'opencode' });

		assert.match(created.secret, /^sk-evelyn-[0-9a-f]{64}$/);
		assert.strictEqual(created.key.name, 'opencode');
		// O resumo é o reconhecível, não o segredo.
		assert.ok(created.key.prefix.startsWith('sk-evelyn-'));
		assert.ok(created.secret.startsWith(created.key.prefix));
		assert.ok(!('secret' in created.key));

		const raw = await readFile(join(root, API_KEYS_FILE), 'utf8');
		assert.strictEqual(raw.includes(created.secret), false, 'o arquivo não pode conter a chave');
		assert.ok(raw.includes(hashApiKey(created.secret)), 'o arquivo guarda o hash');
	});

	test('o arquivo nasce restrito ao dono', async function () {
		if (process.platform === 'win32') {
			// No Windows o modo POSIX é aplicado como a ACL do usuário; o modo
			// numérico não é legível da mesma forma. A asserção é do Unix.
			this.skip();
		}
		const { stat } = await import('node:fs/promises');
		const root = await makeRoot();
		await storeFor(root).create({ name: 'a' });

		const info = await stat(join(root, API_KEYS_FILE));

		assert.strictEqual(info.mode & 0o777, 0o600);
	});

	test('uma chave criada verifica, e o id é o mesmo da listagem', async () => {
		const store = storeFor(await makeRoot());
		const created = await store.create({ name: 'a' });

		const identity = await store.verify(created.secret);

		assert.ok(identity !== undefined);
		assert.strictEqual(identity.keyId, created.key.id);
		assert.deepStrictEqual(identity.scopes, ['client']);
		assert.deepStrictEqual((await store.list()).map((key) => key.id), [created.key.id]);
	});

	test('uma chave que nunca existiu não verifica', async () => {
		const store = storeFor(await makeRoot());
		assert.strictEqual(await store.verify('sk-evelyn-deadbeef'), undefined);
		assert.strictEqual(await store.verify(''), undefined);
	});

	test('revogar apaga a entrada e a chave deixa de valer', async () => {
		const store = storeFor(await makeRoot());
		const created = await store.create({ name: 'a' });

		assert.strictEqual(await store.revoke(created.key.id), true);
		assert.strictEqual(await store.verify(created.secret), undefined);
		assert.deepStrictEqual(await store.list(), []);
		// Revogar de novo não é um erro: o resultado é o mesmo.
		assert.strictEqual(await store.revoke(created.key.id), false);
	});

	test('revogar uma chave deixa as outras intactas', async () => {
		const store = storeFor(await makeRoot());
		const first = await store.create({ name: 'a' });
		const second = await store.create({ name: 'b' });

		await store.revoke(first.key.id);

		assert.strictEqual(await store.verify(first.secret), undefined);
		assert.ok((await store.verify(second.secret)) !== undefined);
	});

	test('rotacionar invalida todas as anteriores numa só escrita', async () => {
		const root = await makeRoot();
		const store = storeFor(root);
		const first = await store.create({ name: 'a' });
		const second = await store.create({ name: 'b' });

		const rotated = await store.rotate({ name: 'depois' });

		assert.strictEqual(await store.verify(first.secret), undefined);
		assert.strictEqual(await store.verify(second.secret), undefined);
		assert.ok((await store.verify(rotated.secret)) !== undefined);
		const raw = JSON.parse(await readFile(join(root, API_KEYS_FILE), 'utf8')) as {
			readonly keys: readonly unknown[];
		};
		assert.strictEqual(raw.keys.length, 1, 'o arquivo tem exatamente a chave nova');
	});

	test('uma chave sobrevive a um novo store sobre o mesmo arquivo', async () => {
		const root = await makeRoot();
		const created = await storeFor(root).create({ name: 'a' });

		const reloaded = storeFor(root);

		assert.ok((await reloaded.verify(created.secret)) !== undefined);
		assert.deepStrictEqual((await reloaded.list()).map((key) => key.id), [created.key.id]);
	});

	test('um arquivo ausente é "nenhuma chave", não um erro', async () => {
		const empty = await makeRoot();
		assert.deepStrictEqual(await storeFor(empty).list(), []);
		assert.strictEqual(existsSync(join(empty, API_KEYS_FILE)), false);
	});

	test('um arquivo corrompido recusa chaves em vez de aceitar qualquer uma', async () => {
		const root = await makeRoot();
		await writeFile(join(root, API_KEYS_FILE), '{ não é json', 'utf8');

		const store = storeFor(root);

		await assert.rejects(() => store.list(), ApiKeyStoreError);
		await assert.rejects(() => store.verify('sk-evelyn-x'), ApiKeyStoreError);
	});

	test('um arquivo com hash malformado é recusado', async () => {
		const root = await makeRoot();
		await writeFile(
			join(root, API_KEYS_FILE),
			JSON.stringify({
				version: 1,
				keys: [{ id: 'k', name: 'n', scopes: ['client'], hash: 'não-hex', createdAt: 'x' }],
			}),
			'utf8',
		);

		await assert.rejects(() => storeFor(root).list(), ApiKeyStoreError);
	});

	test('escopos: uma chave só de painel não vale como cliente', async () => {
		const store = storeFor(await makeRoot());
		const created = await store.create({ name: 'painel', scopes: ['panel'] });

		const identity = await store.verify(created.secret);

		assert.deepStrictEqual(identity?.scopes, ['panel']);
		assert.ok(identity !== undefined && !identity.scopes.includes('client'));
	});

	test('escopos desconhecidos são descartados, e nenhum escopo é um erro', async () => {
		const store = storeFor(await makeRoot());
		// Escopos vêm da API de gestão, que pode receber lixo: o registro
		// descarta o que não conhece em vez de guardar um escopo inventado.
		const unknown = ['client', 'superuser', 'client'] as unknown as readonly never[];
		const created = await store.create({ name: 'a', scopes: unknown });
		assert.deepStrictEqual(created.key.scopes, ['client']);

		await assert.rejects(async () =>
			store.create({ name: 'b', scopes: ['superuser'] as unknown as readonly never[] }),
		);
	});

	test('uma chave precisa de nome', async () => {
		const store = storeFor(await makeRoot());
		await assert.rejects(() => store.create({ name: '   ' }));
	});

	test('escritas concorrentes não perdem nenhuma chave', async () => {
		const root = await makeRoot();
		const store = storeFor(root);

		const created = await Promise.all(
			Array.from({ length: 8 }, (_unused, index) => store.create({ name: `k${index}` })),
		);

		const reloaded = storeFor(root);
		assert.strictEqual((await reloaded.list()).length, 8);
		for (const key of created) {
			assert.ok((await reloaded.verify(key.secret)) !== undefined, `a chave ${key.key.name} sobreviveu`);
		}
	});

	test('o carimbo de uso é gravado, e não reinicia a cada chamada', async () => {
		let nowMs = Date.parse('2026-01-01T00:00:00.000Z');
		const root = await makeRoot();
		const store = new ApiKeyStore({
			filePath: join(root, API_KEYS_FILE),
			now: () => new Date(nowMs),
		});
		const created = await store.create({ name: 'a' });

		nowMs += 5_000;
		await store.touch(created.key.id);
		const firstTouch = (await store.list())[0]?.lastUsedAt;
		assert.strictEqual(firstTouch, '2026-01-01T00:00:05.000Z');

		// Dentro do minuto, nada é reescrito.
		nowMs += 1_000;
		await store.touch(created.key.id);
		assert.strictEqual((await store.list())[0]?.lastUsedAt, firstTouch);

		// Depois do minuto, o carimbo anda.
		nowMs += 61_000;
		await store.touch(created.key.id);
		assert.strictEqual((await store.list())[0]?.lastUsedAt, '2026-01-01T00:01:07.000Z');
	});

	test('um arquivo legível não contém nome de header nem chave de provedor', async () => {
		const root = await makeRoot();
		const store = storeFor(root);
		await store.create({ name: 'a' });
		const raw = await readFile(join(root, API_KEYS_FILE), 'utf8');
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		// A forma é fechada: versão + chaves. Um campo a mais seria um lugar
		// para um segredo entrar sem ninguém notar.
		assert.deepStrictEqual(Object.keys(parsed).sort(), ['keys', 'version']);
	});
});
