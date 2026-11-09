/**
 * R4F: o cliente de renomear e excluir.
 *
 * ## O que se testa
 *
 * A tradução de status em motivo e a distinção entre "não houve conexão"
 * (`inactive`, nada aconteceu) e "a conexão caiu depois do envio"
 * (`unknown`, pode ter acontecido). Para excluir, essa diferença decide se a
 * interface pode tentar de novo.
 */
import * as assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as crypto from 'node:crypto';

import { ServiceChatClient } from '../desktop/serviceChat';
import { writeServiceRecord, PROTOCOL_VERSION } from '../app/serviceRecord';

const SUMMARY = {
	id: 'cnv_1',
	title: 'novo',
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-02T00:00:00.000Z',
	messageCount: 2,
};

/** Um cliente com registro válido e `fetch` injetado (o health responde como o serviço). */
async function clientWith(fetchImpl: typeof fetch): Promise<ServiceChatClient> {
	const root = await mkdtemp(join(tmpdir(), 'evelyn-r4f-client-'));
	const record = {
		version: 1 as const,
		protocol: PROTOCOL_VERSION,
		pid: process.pid,
		port: 7998,
		startedAt: new Date().toISOString(),
		appVersion: '0.0.1',
		token: crypto.randomBytes(32).toString('hex'),
		readerToken: crypto.randomBytes(32).toString('hex'),
		chatToken: crypto.randomBytes(32).toString('hex'),
		address: '127.0.0.1' as const,
	};
	await writeServiceRecord(root, record);
	const withHealth = (async (input: string | URL, init?: RequestInit) => {
		if (String(input).endsWith('/api/health')) {
			return new Response(
				JSON.stringify({
					status: 'ok',
					app: 'Evelyn',
					version: '0.0.1',
					listening: `${record.address}:${record.port}`,
					coreMounted: true,
					storageHost: 'web',
					pid: record.pid,
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			);
		}
		return await fetchImpl(input as never, init);
	}) as typeof fetch;
	return new ServiceChatClient({ root, fetch: withHealth });
}

suite('R4F: renomear pelo cliente', () => {
	test('200 devolve a conversa com o título novo', async () => {
		const client = await clientWith((async () =>
			new Response(JSON.stringify({ conversation: SUMMARY }), { status: 200 })) as typeof fetch);

		const renamed = await client.renameConversation('cnv_1', 'novo');

		assert.equal(renamed.ok, true);
		if (renamed.ok) {
			assert.equal(renamed.conversation.title, 'novo');
		}
	});

	test('404 diz que a conversa não existe', async () => {
		const client = await clientWith((async () =>
			new Response(JSON.stringify({ error: { message: 'não há conversa com esse id' } }), {
				status: 404,
			})) as typeof fetch);

		const renamed = await client.renameConversation('cnv_x', 'y');

		assert.equal(renamed.ok, false);
		if (!renamed.ok) {
			assert.equal(renamed.code, 'rejected');
		}
	});

	test('falha de rede é "unknown", mas renomear é idempotente', async () => {
		const client = await clientWith((async () => {
			throw new TypeError('ECONNRESET');
		}) as typeof fetch);

		const renamed = await client.renameConversation('cnv_1', 'y');

		assert.equal(renamed.ok, false);
		if (!renamed.ok) {
			assert.equal(renamed.code, 'unknown');
			assert.match(renamed.message, /recarregue a lista/);
		}
	});
});

suite('R4F: excluir pelo cliente', () => {
	test('200 é sucesso', async () => {
		const client = await clientWith((async () =>
			new Response(JSON.stringify({ deleted: true, id: 'cnv_1' }), { status: 200 })) as typeof fetch);

		const deleted = await client.deleteConversation('cnv_1');

		assert.equal(deleted.ok, true);
	});

	test('404 é "rejected" (já não existe)', async () => {
		const client = await clientWith((async () =>
			new Response(JSON.stringify({ error: { message: 'não há conversa com esse id' } }), {
				status: 404,
			})) as typeof fetch);

		const deleted = await client.deleteConversation('cnv_1');

		assert.equal(deleted.ok, false);
		if (!deleted.ok) {
			assert.equal(deleted.code, 'rejected');
		}
	});

	test('falha de rede é "unknown": pode ter sido excluída', async () => {
		const client = await clientWith((async () => {
			throw new TypeError('ECONNRESET');
		}) as typeof fetch);

		const deleted = await client.deleteConversation('cnv_1');

		assert.equal(deleted.ok, false);
		if (!deleted.ok) {
			assert.equal(deleted.code, 'unknown');
			assert.match(deleted.message, /não é possível saber/);
			assert.match(deleted.message, /Recarregue a lista/);
		}
	});

	test('sem serviço é "inactive" e nada é enviado', async () => {
		let called = false;
		const root = await mkdtemp(join(tmpdir(), 'evelyn-r4f-noservice-'));
		const client = new ServiceChatClient({
			root,
			fetch: (async () => {
				called = true;
				return new Response('{}');
			}) as typeof fetch,
		});

		const deleted = await client.deleteConversation('cnv_1');

		assert.equal(deleted.ok, false);
		if (!deleted.ok) {
			assert.equal(deleted.code, 'inactive');
		}
		assert.equal(called, false);
	});
});
