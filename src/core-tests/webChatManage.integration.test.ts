/**
 * R4F: renomear e excluir contra o serviço real.
 *
 * Processo, socket, descoberta, `chatToken` e `FileDataStore` reais. O modelo
 * não é exercitado aqui (nenhum provedor externo configurado na máquina) —
 * criar, renomear, listar e excluir não dependem dele.
 */
import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ServiceChatClient } from '../desktop/serviceChat';
import { probeService } from '../app/discoverService';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const SERVICE_ENTRY = join(process.cwd(), 'dist', 'web', 'main.js');
const SEED_ENTRY = join(__dirname, 'helpers', 'seedConversations.js');

const children: ReturnType<typeof spawn>[] = [];
const roots: string[] = [];

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'evelyn-r4f-real-'));
	roots.push(root);
	return root;
}

async function seedProvider(root: string): Promise<void> {
	assert.ok(existsSync(SEED_ENTRY), 'faltou `npm run compile-tests`');
	const child = spawn(process.execPath, [SEED_ENTRY, root, JSON.stringify([])], {
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	children.push(child);
	const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
	assert.equal(code, 0);
}

async function startService(root: string): Promise<ReturnType<typeof spawn>> {
	assert.ok(existsSync(SERVICE_ENTRY), 'faltou `npm run web:build`');
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

suite('R4F: renomear e excluir no serviço real', () => {
	test('renomeia e a listagem real mostra o título novo', async () => {
		const root = await makeRoot();
		await seedProvider(root);
		await startService(root);
		try {
			const client = new ServiceChatClient({ root });
			const created = await client.createConversation({ providerId: 'seed', title: 'antigo' });
			assert.equal(created.ok, true);
			if (!created.ok) {
				return;
			}

			const renamed = await client.renameConversation(created.conversation.id, 'título novo');
			assert.equal(renamed.ok, true);

			const listed = await client.listConversations();
			assert.equal(listed.ok, true);
			if (listed.ok) {
				const item = listed.conversations.find((entry) => entry.id === created.conversation.id);
				assert.equal(item?.title, 'título novo');
			}

			// Persistido: abrir de novo traz o título novo.
			const opened = await client.openConversation(created.conversation.id);
			assert.equal(opened.ok, true);
			if (opened.ok) {
				assert.equal(opened.conversation.conversation.title, 'título novo');
			}
		} finally {
			await stopService(root);
		}
	});

	test('exclui, some da lista, não abre mais e o arquivo sai do disco', async () => {
		const root = await makeRoot();
		await seedProvider(root);
		await startService(root);
		try {
			const client = new ServiceChatClient({ root });
			const keep = await client.createConversation({ providerId: 'seed', title: 'fica' });
			const gone = await client.createConversation({ providerId: 'seed', title: 'sai' });
			assert.equal(keep.ok && gone.ok, true);
			if (!keep.ok || !gone.ok) {
				return;
			}

			const deleted = await client.deleteConversation(gone.conversation.id);
			assert.equal(deleted.ok, true);

			const listed = await client.listConversations();
			if (listed.ok) {
				const ids = listed.conversations.map((item) => item.id);
				assert.ok(ids.includes(keep.conversation.id));
				assert.equal(ids.includes(gone.conversation.id), false);
			}

			const opened = await client.openConversation(gone.conversation.id);
			assert.equal(opened.ok, false);
			if (!opened.ok) {
				assert.equal(opened.code, 'rejected');
			}

			const files = await readdir(join(root, 'conversations'));
			assert.equal(files.includes(`${gone.conversation.id}.json`), false);
			assert.ok(files.includes(`${keep.conversation.id}.json`), 'a outra continua lá');
		} finally {
			await stopService(root);
		}
	});

	test('excluir de novo pelo cliente é idempotente: sucesso nas duas (R4M)', async () => {
		const root = await makeRoot();
		await seedProvider(root);
		await startService(root);
		try {
			const client = new ServiceChatClient({ root });
			const created = await client.createConversation({ providerId: 'seed' });
			assert.equal(created.ok, true);
			if (!created.ok) {
				return;
			}

			assert.equal((await client.deleteConversation(created.conversation.id)).ok, true);
			// R4M: a segunda exclusão é idempotente — o serviço responde `200`
			// e o cliente a recebe como sucesso. Antes era `404`/`rejected`, e
			// duas exclusões simultâneas davam resultados diferentes conforme a
			// corrida.
			const again = await client.deleteConversation(created.conversation.id);
			assert.equal(again.ok, true);
			// E excluir um id que nunca existiu também é sucesso.
			assert.equal((await client.deleteConversation('cnv_nunca_existiu')).ok, true);
		} finally {
			await stopService(root);
		}
	});

	test('sem serviço, renomear e excluir dizem "inactive"', async () => {
		const root = await makeRoot();
		const client = new ServiceChatClient({ root });

		const renamed = await client.renameConversation('cnv_x', 'y');
		const deleted = await client.deleteConversation('cnv_x');

		assert.equal(renamed.ok, false);
		assert.equal(deleted.ok, false);
		if (!renamed.ok && !deleted.ok) {
			assert.equal(renamed.code, 'inactive');
			assert.equal(deleted.code, 'inactive');
		}
	});
});
