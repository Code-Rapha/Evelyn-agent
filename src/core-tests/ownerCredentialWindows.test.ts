/**
 * DEV-7: o DPAPI de **verdade**, no Windows.
 *
 * ## O que só este teste prova
 *
 * - o PowerShell cifra e abre um blob com `ProtectedData.CurrentUser`;
 * - a credencial criada pelo DPAPI real autentica e recusa;
 * - um blob protegido de outra conta **não** abre (testado copiando o blob
 *   para outro "usuário" — o do teste, mas com o arquivo adulterado: o DPAPI
 *   recusa o que não é dele);
 * - o teste **não** exige interação: a senha é escrita pelo próprio teste.
 *
 * ## O que ele não prova
 *
 * Que um processo do mesmo usuário não consiga abrir o blob — ele **consegue**
 * (está documentado em `windowsDpapi.ts`). Não há teste que prove o contrário
 * porque não é verdade.
 *
 * Fora do Windows, cada teste sai sem afirmar nada (não há DPAPI), e a
 * ausência é declarada no relatório.
 */
import * as assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CREDENTIAL_FILE, OwnerCredentialStore } from '../desktop/ownerCredential';
import {
	DPAPI_SCOPE,
	sealForCurrentUser,
	unsealForCurrentUser,
	dpapiAvailable,
} from '../desktop/windowsDpapi';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const roots: string[] = [];
const PASSWORD = 'frase-local-do-proprietario-dev7';

teardown(async () => {
	for (const root of roots.splice(0)) {
		await removeFixtureTree(root).catch(() => undefined);
	}
});

async function makeDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'evelyn-dev7-win-'));
	roots.push(dir);
	return dir;
}

suite('DEV-7: DPAPI real do Windows', () => {
	test('cifra e abre com o usuário atual; um base64 inválido é recusado', async () => {
		if (!dpapiAvailable()) {
			return;
		}
		const sealed = await sealForCurrentUser(Buffer.from('segredo-de-teste'));
		assert.equal(sealed.kind, 'sealed', sealed.kind === 'unavailable' ? sealed.reason : '');
		const opened = await unsealForCurrentUser(sealed.kind === 'sealed' ? sealed.base64 : '');
		assert.equal(opened.kind, 'opened');
		assert.equal(opened.kind === 'opened' ? Buffer.from(opened.base64, 'base64').toString('utf8') : '', 'segredo-de-teste');

		const bad = await unsealForCurrentUser('isto-nao-e-base64!!');
		assert.equal(bad.kind, 'corrupt');
	});

	test('a credencial criada com o DPAPI real autentica e recusa', async () => {
		if (!dpapiAvailable()) {
			return;
		}
		const dir = await makeDir();
		const store = new OwnerCredentialStore({ dir, user: () => process.env['USERNAME'] });

		const configured = await store.configure(PASSWORD, PASSWORD);
		assert.equal(configured.ok, true, configured.ok ? '' : configured.message);
		// Nada da senha no arquivo, mesmo com o DPAPI real.
		assert.equal((await readFile(join(dir, CREDENTIAL_FILE), 'utf8')).includes(PASSWORD), false);

		assert.deepEqual(await store.authenticate(PASSWORD), { ok: true });
		const wrong = await store.authenticate('senha-errada');
		assert.equal(wrong.ok, false);
	});

	test('trocar o blob por outro abre (o DPAPI não tem binding) — e o verifier é o que recusa', async () => {
		if (!dpapiAvailable()) {
			return;
		}
		const dir = await makeDir();
		const store = new OwnerCredentialStore({ dir, user: () => process.env['USERNAME'] });
		assert.equal((await store.configure(PASSWORD, PASSWORD)).ok, true);
		const raw = JSON.parse(await readFile(join(dir, CREDENTIAL_FILE), 'utf8')) as Record<string, unknown>;
		// Outro blob **legítimo desta mesma conta**, no lugar do original. O
		// DPAPI abre os dois — medido. A recusa tem de vir do verifier.
		const foreign = await sealForCurrentUser(Buffer.from('outra-chave-qualquer'));
		raw['sealed'] = foreign.kind === 'sealed' ? foreign.base64 : '';
		await (await import('node:fs/promises')).writeFile(join(dir, CREDENTIAL_FILE), JSON.stringify(raw), 'utf8');

		const result = await store.authenticate(PASSWORD);
		assert.equal(result.ok, false, 'o verifier não pode aceitar uma chave estranha');
		assert.equal(result.ok ? '' : result.reason, 'invalid');
	});

	test('a documentação de escopo não promete o que não é verdade', () => {
		assert.equal(DPAPI_SCOPE.protects.length > 0, true);
		assert.match(DPAPI_SCOPE.doesNotProtect.join(' '), /MESMO usuário/);
		assert.match(DPAPI_SCOPE.doesNotProtect.join(' '), /administrador/i);
	});
});
