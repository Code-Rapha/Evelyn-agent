/**
 * R4E: criar conversa contra o serviço real.
 *
 * O processo, o socket, a descoberta, o `chatToken` e o `FileDataStore` são
 * reais. O que não é: o modelo (nenhum provedor externo configurado nesta
 * máquina), e por isso o teste de "enviar a primeira mensagem" usa o que o
 * serviço consegue provar sem modelo — a criação e a listagem.
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
const SEED_ENTRY = join(__dirname, 'helpers', 'seedConversations.js');

const children: ReturnType<typeof spawn>[] = [];
const roots: string[] = [];

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'evelyn-r4e-real-'));
	roots.push(root);
	return root;
}

/**
 * Cria um provedor na raiz, com o Core de um processo separado.
 *
 * O serviço precisa conhecer o provedor para aceitar a criação; o semeador da
 * R4D já faz isso e cria conversas — aqui só o provedor interessa, então ele é
 * usado com uma conversa descartável e o provedor fica.
 */
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

suite('R4E: criar conversa no serviço real', () => {
	test('cria pelo serviço e a conversa aparece na listagem real', async () => {
		const root = await makeRoot();
		await seedProvider(root);
		await startService(root);
		try {
			const client = new ServiceChatClient({ root });

			const created = await client.createConversation({ providerId: 'seed', title: 'criada pelo cliente' });

			assert.equal(created.ok, true);
			if (!created.ok) {
				return;
			}
			assert.equal(created.conversation.title, 'criada pelo cliente');
			assert.equal(created.conversation.messageCount >= 0, true);

			const listed = await client.listConversations();
			assert.equal(listed.ok, true);
			if (listed.ok) {
				assert.ok(
					listed.conversations.some((item) => item.id === created.conversation.id),
					'a conversa criada está na lista do serviço',
				);
			}

			const opened = await client.openConversation(created.conversation.id);
			assert.equal(opened.ok, true);
			if (opened.ok) {
				assert.deepEqual(opened.conversation.messages, [], 'a conversa nova não tem mensagem');
			}

			// Nenhuma credencial na resposta.
			assert.equal(JSON.stringify(created).includes('chatToken'), false);
			assert.equal(JSON.stringify(created).includes(root), false);
		} finally {
			await stopService(root);
		}
	});

	test('um provedor que o serviço não conhece é recusado', async () => {
		const root = await makeRoot();
		await startService(root);
		try {
			const client = new ServiceChatClient({ root });
			const created = await client.createConversation({ providerId: 'nao-existe' });

			assert.equal(created.ok, false);
			if (!created.ok) {
				assert.equal(created.code, 'invalid-response');
				assert.match(created.message, /não foi possível criar/);
			}
		} finally {
			await stopService(root);
		}
	});

	test('sem serviço, criar diz "inactive" e nada é criado', async () => {
		const root = await makeRoot();
		const client = new ServiceChatClient({ root });

		const created = await client.createConversation({ providerId: 'seed' });

		assert.equal(created.ok, false);
		if (!created.ok) {
			assert.equal(created.code, 'inactive');
		}
	});
});
