/**
 * R4H: o registro durável de turnos.
 *
 * ## O que estes testes fixam
 *
 * - as transições reais e **a ausência das que não existem** (um terminal não
 *   volta a `running`, um `finish` tardio não reescreve o desfecho);
 * - a recuperação só toca `running` — nunca converte `completed`, `failed`
 *   ou `cancelled`;
 * - um registro inválido é descartado sem levar os sadios junto;
 * - o arquivo não guarda conteúdo nem segredo;
 * - escritas simultâneas não perdem uma à outra.
 *
 * Unitário: o store em disco, sem servidor nem modelo.
 */
import * as assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TurnRecordStore, TURNS_FILE } from '../core/storage/turnRecords';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const roots: string[] = [];

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'evelyn-r4h-'));
	roots.push(root);
	return root;
}

function storeFor(root: string, now?: () => Date): TurnRecordStore {
	return new TurnRecordStore({ root, ...(now !== undefined ? { now } : {}) });
}

async function readRaw(root: string): Promise<unknown> {
	return JSON.parse(await readFile(join(root, TURNS_FILE), 'utf8')) as unknown;
}

teardown(async () => {
	for (const root of roots.splice(0)) {
		await removeFixtureTree(root).catch(() => undefined);
	}
});

suite('R4H: o registro de turnos', () => {
	test('um turno começa em `running` e termina com o desfecho dado', async () => {
		const root = await makeRoot();
		const store = storeFor(root);

		await store.start({ turnId: 'svc-turn-1', conversationId: 'cnv_1' });
		const running = await store.forConversation('cnv_1');
		assert.equal(running.length, 1);
		assert.equal(running[0]?.status, 'running');
		assert.equal(running[0]?.finishedAt, undefined);

		assert.equal(await store.finish({ turnId: 'svc-turn-1', status: 'completed' }), true);
		const done = await store.forConversation('cnv_1');
		assert.equal(done[0]?.status, 'completed');
		assert.equal(typeof done[0]?.finishedAt, 'string');
	});

	test('um estado terminal não é reescrito por um segundo desfecho', async () => {
		// O cenário real: uma promessa que resolve depois de o timeout já ter
		// fechado o turno. O primeiro desfecho vence.
		const root = await makeRoot();
		const store = storeFor(root);

		await store.start({ turnId: 'svc-turn-1', conversationId: 'cnv_1' });
		await store.finish({ turnId: 'svc-turn-1', status: 'failed', reason: 'timeout' });
		await store.finish({ turnId: 'svc-turn-1', status: 'completed' });

		const turns = await store.forConversation('cnv_1');
		assert.equal(turns[0]?.status, 'failed');
		assert.equal(turns[0]?.reason, 'timeout');
	});

	test('fechar um turno que não existe devolve `false` e não cria registro', async () => {
		const root = await makeRoot();
		const store = storeFor(root);

		assert.equal(await store.finish({ turnId: 'svc-turn-9', status: 'completed' }), false);
		assert.deepEqual(await store.forConversation('cnv_x'), []);
	});

	test('o arquivo não guarda conteúdo, token nem caminho', async () => {
		const root = await makeRoot();
		const store = storeFor(root);

		await store.start({ turnId: 'svc-turn-1', conversationId: 'cnv_1' });
		await store.finish({ turnId: 'svc-turn-1', status: 'completed' });

		const raw = await readFile(join(root, TURNS_FILE), 'utf8');
		assert.equal(raw.includes(root), false, 'caminho não');
		assert.equal(/sk-|token|apiKey/i.test(raw), false, 'segredo não');
		const parsed = await readRaw(root);
		const turns = (parsed as { turns: readonly Record<string, unknown>[] }).turns;
		assert.deepEqual(Object.keys(turns[0] ?? {}).sort(), [
			'conversationId',
			'finishedAt',
			'startedAt',
			'status',
			'turnId',
		]);
	});

	test('escritas simultâneas não perdem turnos', async () => {
		const root = await makeRoot();
		const store = storeFor(root);

		await Promise.all(
			Array.from({ length: 8 }, (_unused, index) =>
				store.start({ turnId: `svc-turn-${index}`, conversationId: `cnv_${index % 2}` }),
			),
		);

		const reloaded = storeFor(root);
		const all = [
			...(await reloaded.forConversation('cnv_0')),
			...(await reloaded.forConversation('cnv_1')),
		];
		assert.equal(all.length, 8);
	});

	test('um registro inválido é descartado e os sadios sobrevivem', async () => {
		const root = await makeRoot();
		await writeFile(
			join(root, TURNS_FILE),
			JSON.stringify({
				version: 1,
				turns: [
					{ turnId: 'svc-turn-1', conversationId: 'cnv_1', status: 'completed', startedAt: '2026-01-01T00:00:00.000Z' },
					{ turnId: '', conversationId: 'cnv_1', status: 'running', startedAt: '2026-01-01T00:00:00.000Z' },
					{ turnId: 'svc-turn-3', conversationId: 'cnv_1', status: 'inventado', startedAt: '2026-01-01T00:00:00.000Z' },
				],
			}),
			'utf8',
		);

		const listed = await storeFor(root).list();

		// R4K: os registros sadios sobrevivem, e o estado continua válido —
		// um item corrompido não é motivo para declarar o arquivo inteiro
		// inutilizável.
		assert.equal(listed.kind, 'valid');
		if (listed.kind !== 'valid') {
			return;
		}
		assert.equal(listed.turns.length, 1);
		assert.equal(listed.turns[0]?.turnId, 'svc-turn-1');
		assert.equal(listed.unreadable.length, 2);
	});

	test('um arquivo inteiro ilegível é `corrupt`, e não uma lista vazia (R4K)', async () => {
		const root = await makeRoot();
		await writeFile(join(root, TURNS_FILE), '{ isto não é json', 'utf8');

		const listed = await storeFor(root).list();

		// A diferença que a R4K introduz: antes, um JSON inválido virava
		// `[]`, e a próxima escrita apagava o arquivo.
		assert.equal(listed.kind, 'corrupt');
		if (listed.kind === 'corrupt') {
			assert.match(listed.reason, /não é JSON válido/);
			assert.equal(listed.reason.includes(root), false, 'sem caminho no motivo');
		}
	});
});

suite('R4H: recuperação', () => {
	test('um `running` vira `interrupted`, com motivo e data de fim', async () => {
		const root = await makeRoot();
		const store = storeFor(root);
		await store.start({ turnId: 'svc-turn-1', conversationId: 'cnv_1' });

		// Um processo novo sobre o mesmo arquivo: é o que acontece no reinício.
		const recovered = await storeFor(root).recover();

		assert.equal(recovered.interrupted, 1);
		assert.equal(recovered.turns[0]?.status, 'interrupted');
		assert.match(recovered.turns[0]?.reason ?? '', /encerrado antes de o turno terminar/);
		assert.equal(typeof recovered.turns[0]?.finishedAt, 'string');

		const turns = await storeFor(root).forConversation('cnv_1');
		assert.equal(turns[0]?.status, 'interrupted', 'gravado no disco, não só na memória');
	});

	test('`completed`, `failed` e `cancelled` não são tocados', async () => {
		const root = await makeRoot();
		const store = storeFor(root);
		for (const [index, status] of (['completed', 'failed', 'cancelled'] as const).entries()) {
			const turnId = `svc-turn-${index}`;
			await store.start({ turnId, conversationId: 'cnv_1' });
			await store.finish({ turnId, status, ...(status === 'failed' ? { reason: 'o turno falhou' } : {}) });
		}

		const recovered = await storeFor(root).recover();

		assert.equal(recovered.interrupted, 0, 'nenhum terminal virou interrompido');
		const turns = await storeFor(root).forConversation('cnv_1');
		const byId = new Map(turns.map((turn) => [turn.turnId, turn]));
		assert.equal(byId.get('svc-turn-0')?.status, 'completed');
		assert.equal(byId.get('svc-turn-1')?.status, 'failed');
		assert.equal(byId.get('svc-turn-2')?.status, 'cancelled');
	});

	test('turnos de várias conversas são recuperados, cada um na sua', async () => {
		const root = await makeRoot();
		const store = storeFor(root);
		await store.start({ turnId: 'svc-turn-1', conversationId: 'cnv_a' });
		await store.start({ turnId: 'svc-turn-2', conversationId: 'cnv_b' });
		await store.start({ turnId: 'svc-turn-3', conversationId: 'cnv_a' });
		await store.finish({ turnId: 'svc-turn-3', status: 'completed' });

		const recovered = await storeFor(root).recover();
		const fresh = storeFor(root);

		assert.equal(recovered.interrupted, 2);
		assert.equal((await fresh.forConversation('cnv_a')).filter((turn) => turn.status === 'interrupted').length, 1);
		assert.equal((await fresh.forConversation('cnv_b')).length, 1);
		assert.equal((await fresh.forConversation('cnv_b'))[0]?.status, 'interrupted');
		assert.equal((await fresh.forConversation('cnv_a')).find((turn) => turn.turnId === 'svc-turn-3')?.status, 'completed');
	});

	test('recuperar duas vezes não muda nada na segunda', async () => {
		const root = await makeRoot();
		const store = storeFor(root);
		await store.start({ turnId: 'svc-turn-1', conversationId: 'cnv_1' });

		const first = await storeFor(root).recover();
		const second = await storeFor(root).recover();

		assert.equal(first.interrupted, 1);
		assert.equal(second.interrupted, 0, 'já não há `running`');
	});

	test('sem arquivo, a recuperação é um no-op', async () => {
		const root = await makeRoot();
		const recovered = await storeFor(root).recover();

		assert.equal(recovered.interrupted, 0);
		assert.equal((await readdir(root)).includes(TURNS_FILE), false, 'não cria arquivo só para ler');
	});

	test('o arquivo sobrevive a uma gravação interrompida (temp ao lado)', async () => {
		// Uma gravação que morreu no meio deixa um `.tmp` e o destino antigo.
		// O destino precisa continuar válido — é o que `writeFileAtomic`
		// garante, e o que a recuperação depende.
		const root = await makeRoot();
		const store = storeFor(root);
		await store.start({ turnId: 'svc-turn-1', conversationId: 'cnv_1' });
		await writeFile(join(root, `${TURNS_FILE}.123.1.tmp`), '{ parcial', 'utf8');

		const listed = await storeFor(root).list();

		// O `.tmp` órfão não é lido: só o destino conta.
		assert.equal(listed.kind, 'valid');
		if (listed.kind !== 'valid') {
			return;
		}
		assert.equal(listed.turns.length, 1);
		assert.equal(listed.turns[0]?.status, 'running');
	});
});
