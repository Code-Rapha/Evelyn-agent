/**
 * R4D: o cliente do Desktop contra o serviço real.
 *
 * ## Por que processo de verdade
 *
 * O que se prova é que o cliente conectado lê o histórico que o **serviço**
 * gravou, com a credencial que o **registro** publicou — descoberta, socket,
 * `chatToken`, `FileDataStore`. Nenhuma parte disso é simulada aqui.
 *
 * O que não é exercitado: uma resposta de modelo. Para criar conversas de
 * teste, o arquivo é escrito pelo próprio Core num processo auxiliar (o modo
 * `--seed` abaixo não existe: as conversas são criadas pelo `ChatSession` de
 * um processo Node com a raiz, antes de o serviço subir).
 */
import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ServiceChatClient } from '../desktop/serviceChat';
import { probeService } from '../app/discoverService';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const SERVICE_ENTRY = join(process.cwd(), 'dist', 'web', 'main.js');
/**
 * O semeador, ao lado deste arquivo **compilado** (`out/core-tests/…`), não
 * em `dist/`: é o `tsc -p . --outDir out` que o compila.
 */
const SEED_ENTRY = join(__dirname, 'helpers', 'seedConversations.js');

const children: ReturnType<typeof spawn>[] = [];
const roots: string[] = [];

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'evelyn-r4d-real-'));
	roots.push(root);
	return root;
}

/** Cria conversas na raiz com o Core de um processo separado. */
async function seed(root: string, titles: readonly string[]): Promise<string[]> {
	assert.ok(existsSync(SEED_ENTRY), 'faltou compilar os testes (`npm run compile-tests`)');
	const child = spawn(process.execPath, [SEED_ENTRY, root, JSON.stringify(titles)], {
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	children.push(child);
	let out = '';
	child.stdout.setEncoding('utf8');
	child.stdout.on('data', (chunk: string) => (out += chunk));
	let err = '';
	child.stderr.setEncoding('utf8');
	child.stderr.on('data', (chunk: string) => (err += chunk));
	const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
	assert.equal(code, 0, `o semeador falhou: ${err}`);
	return (JSON.parse(out) as { ids: string[] }).ids;
}

async function startService(root: string): Promise<ReturnType<typeof spawn>> {
	assert.ok(
		existsSync(SERVICE_ENTRY),
		'o bundle dist/web/main.js não existe: rode `npm run web:build`',
	);
	const child = spawn(process.execPath, [SERVICE_ENTRY, '--root', root, '--port', '0'], {
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	children.push(child);
	const deadline = Date.now() + 25_000;
	for (;;) {
		if ((await probeService({ root })).kind === 'active') {
			return child;
		}
		if (Date.now() > deadline) {
			throw new Error('o serviço não ficou ativo a tempo');
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

async function stopService(root: string): Promise<void> {
	const child = spawn(process.execPath, [SERVICE_ENTRY, '--root', root, '--stop'], {
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	children.push(child);
	await new Promise((resolve) => child.on('exit', resolve));
}

teardown(async () => {
	for (const child of children.splice(0)) {
		if (child.exitCode === null) {
			child.kill('SIGKILL');
		}
	}
	for (const root of roots.splice(0)) {
		await removeFixtureTree(root).catch(() => undefined);
	}
});

suite('R4D: histórico contra o serviço real', () => {
	test('lista e abre as conversas que o serviço tem no disco', async () => {
		// Sem o build não há o que executar: o teste falha dizendo isso, em vez
		// de passar sem exercitar nada.
		assert.ok(existsSync(SERVICE_ENTRY), 'faltou `npm run web:build`');
		assert.ok(existsSync(SEED_ENTRY), 'faltou `npm run compile-tests`');
		const root = await makeRoot();
		const ids = await seed(root, ['primeira', 'segunda']);
		const service = await startService(root);
		try {
			const client = new ServiceChatClient({ root });

			const listed = await client.listConversations();
			assert.equal(listed.ok, true);
			if (!listed.ok) {
				return;
			}
			assert.deepEqual(listed.conversations.map((item) => item.id).sort(), [...ids].sort());

			const opened = await client.openConversation(ids[0] as string);
			assert.equal(opened.ok, true);
			if (!opened.ok) {
				return;
			}
			assert.equal(opened.conversation.conversation.id, ids[0]);
			assert.equal(opened.conversation.conversation.title, 'primeira');

			// Nenhuma credencial volta ao cliente.
			assert.equal(JSON.stringify(opened).includes('chatToken'), false);
			assert.equal(JSON.stringify(listed).includes('readerToken'), false);
		} finally {
			await stopService(root);
			void service;
		}
	});

	test('um id inexistente é "rejected" (404 do serviço)', async () => {
		assert.ok(existsSync(SERVICE_ENTRY), 'faltou `npm run web:build`');
		const root = await makeRoot();
		await startService(root);
		try {
			const client = new ServiceChatClient({ root });
			const opened = await client.openConversation('cnv_que_nao_existe');

			assert.equal(opened.ok, false);
			if (!opened.ok) {
				assert.equal(opened.code, 'rejected');
				assert.match(opened.message, /não há conversa/);
			}
		} finally {
			await stopService(root);
		}
	});

	test('depois do serviço encerrar, o cliente diz "inactive"', async () => {
		assert.ok(existsSync(SERVICE_ENTRY), 'faltou `npm run web:build`');
		const root = await makeRoot();
		const service = await startService(root);
		const client = new ServiceChatClient({ root });
		assert.equal((await client.listConversations()).ok, true);

		await stopService(root);
		await new Promise<void>((resolve) => {
			if (service.exitCode !== null) {
				resolve();
				return;
			}
			service.on('exit', () => resolve());
		});

		const after = await client.listConversations();
		assert.equal(after.ok, false);
		if (!after.ok) {
			assert.equal(after.code, 'inactive');
		}
	});
});
