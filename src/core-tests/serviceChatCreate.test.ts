/**
 * R4E: o cliente de criação e o resultado desconhecido.
 *
 * ## O que se testa aqui
 *
 * O **cliente**, com um `fetch` injetado: a tradução de status em motivo, a
 * distinção entre "recusado" e "não sei se foi criado", e o parser estrito da
 * resposta.
 *
 * A distinção é o ponto da fase: uma falha de rede **depois** do envio não é
 * "não criada". O serviço pode ter gravado, e tentar de novo criaria uma
 * duplicata — nenhum teste aqui permite que o cliente diga "não criada" nesse
 * caso.
 */
import * as assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ServiceChatClient } from '../desktop/serviceChat';
import { writeServiceRecord, PROTOCOL_VERSION } from '../app/serviceRecord';
import * as crypto from 'node:crypto';

const RECORD = {
	version: 1 as const,
	protocol: PROTOCOL_VERSION,
	pid: process.pid,
	port: 7999,
	startedAt: new Date().toISOString(),
	appVersion: '0.0.1',
	token: 'p'.repeat(64),
	readerToken: 'r'.repeat(64),
	chatToken: 'c'.repeat(64),
	address: '127.0.0.1' as const,
};

const CREATED = {
	id: 'cnv_nova',
	title: 'nova',
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
	messageCount: 0,
};

/** Um cliente sobre um registro válido, com `fetch` injetado. */
async function clientWith(fetchImpl: typeof fetch): Promise<ServiceChatClient> {
	const root = await mkdtemp(join(tmpdir(), 'evelyn-r4e-client-'));
	const record = {
		...RECORD,
		// O pid precisa existir para a descoberta aceitar o registro; o
		// processo do teste é o mais próximo.
		pid: process.pid,
		port: 7999,
		token: crypto.randomBytes(32).toString('hex'),
		readerToken: crypto.randomBytes(32).toString('hex'),
		chatToken: crypto.randomBytes(32).toString('hex'),
	};
	await writeServiceRecord(root, record);
	// A descoberta chama `/api/health` antes de qualquer requisição de
	// conversa. O `fetch` do teste responde a ele como o serviço responderia —
	// com o **pid do registro** e a porta dele, que é o que a descoberta
	// confere. Sem isso, todo caso cairia em `inactive`.
	const withHealth = (async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith('/api/health')) {
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

suite('R4E: o cliente de criação', () => {
	test('201 é sucesso, com a conversa do contrato', async () => {
		const client = await clientWith((async () =>
			new Response(JSON.stringify({ conversation: CREATED }), { status: 201 })) as typeof fetch);

		const created = await client.createConversation({ providerId: 'local', title: 'nova' });

		assert.equal(created.ok, true);
		if (created.ok) {
			assert.equal(created.conversation.id, 'cnv_nova');
		}
	});

	test('400 é recusado com a mensagem do serviço', async () => {
		const client = await clientWith((async () =>
			new Response(JSON.stringify({ error: { message: 'não foi possível criar' } }), {
				status: 400,
			})) as typeof fetch);

		const created = await client.createConversation({ providerId: 'local' });

		assert.equal(created.ok, false);
		if (!created.ok) {
			assert.equal(created.code, 'invalid-response');
			assert.match(created.message, /não foi possível criar/);
		}
	});

	test('uma falha de rede é "unknown", nunca "não criada"', async () => {
		const client = await clientWith((async () => {
			throw Object.assign(new Error('ECONNRESET'), { name: 'TypeError' });
		}) as typeof fetch);

		const created = await client.createConversation({ providerId: 'local' });

		assert.equal(created.ok, false);
		if (!created.ok) {
			assert.equal(created.code, 'unknown', 'o pedido pode ter sido aplicado');
			assert.match(created.message, /não é possível saber/);
			assert.match(created.message, /Recarregue a lista/);
		}
	});

	test('uma resposta fora do contrato é "unknown", não sucesso', async () => {
		const client = await clientWith((async () =>
			new Response(JSON.stringify({ conversation: { title: 'sem id' } }), { status: 201 })) as typeof fetch);

		const created = await client.createConversation({ providerId: 'local' });

		assert.equal(created.ok, false);
		if (!created.ok) {
			assert.equal(created.code, 'unknown');
		}
	});

	test('401 é credencial recusada', async () => {
		const client = await clientWith((async () => new Response('', { status: 401 })) as typeof fetch);

		const created = await client.createConversation({ providerId: 'local' });

		assert.equal(created.ok, false);
		if (!created.ok) {
			assert.equal(created.code, 'unauthorized');
		}
	});

	test('sem serviço é "inactive", e nada é enviado', async () => {
		let called = false;
		const root = await mkdtemp(join(tmpdir(), 'evelyn-r4e-noservice-'));
		const client = new ServiceChatClient({
			root,
			fetch: (async () => {
				called = true;
				return new Response('{}');
			}) as typeof fetch,
		});

		const created = await client.createConversation({ providerId: 'local' });

		assert.equal(created.ok, false);
		if (!created.ok) {
			assert.equal(created.code, 'inactive');
		}
		assert.equal(called, false, 'sem descoberta válida, nenhuma requisição sai');
	});
});
