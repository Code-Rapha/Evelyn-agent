/**
 * R4Q: a porta de gravação e a ausência de mecanismos de falha nos stores.
 *
 * ## O que estes testes fixam
 *
 * - a injeção de falha mora **na porta**, não no store: `FileDataStore` e
 *   `TurnRecordStore` não têm nenhum método que altere a gravação;
 * - o objeto exposto pelo Core (`history`) também não;
 * - a porta injetada falha de forma **determinística** e limitada ao que o
 *   teste pediu — sem armadilha pendente que atinja a escrita seguinte;
 * - sem porta, a gravação é a de produção (`writeFileAtomic`).
 */
import * as assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assembleCore } from '../app/assemble';
import { ConsoleLogSink } from '../adapters/local/consoleLogSink';
import { FileDataStore } from '../adapters/local/fileDataStore';
import { failingWritePort } from '../adapters/local/writePort';
import { writeFileAtomic } from '../adapters/local/writeFileAtomic';
import { TurnRecordStore } from '../core/storage/turnRecords';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const roots: string[] = [];

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'evelyn-r4q-port-'));
	roots.push(root);
	return root;
}

teardown(async () => {
	for (const root of roots.splice(0)) {
		await removeFixtureTree(root).catch(() => undefined);
	}
});

suite('R4Q: a porta de gravação', () => {
	test('os stores não expõem nenhum método de injeção de falha', async () => {
		const root = await makeRoot();
		const store = new FileDataStore({ rootPath: root });
		const turns = new TurnRecordStore({ root });

		for (const subject of [store, turns]) {
			const names = Object.getOwnPropertyNames(subject);
			const injectors = names.filter((name) => /arm|fail|inject|fault/i.test(name));
			assert.deepEqual(injectors, [], `${subject.constructor.name} não tem injetor de falha`);
		}
		assert.equal(
			(store as unknown as Record<string, unknown>)['armWriteFailure'],
			undefined,
			'FileDataStore.armWriteFailure não existe',
		);
		assert.equal(
			(turns as unknown as Record<string, unknown>)['armWriteFailure'],
			undefined,
			'TurnRecordStore.armWriteFailure não existe',
		);
	});

	test('o Core montado também não expõe injetor no histórico', async () => {
		const root = await makeRoot();
		const core = assembleCore({
			rootPath: root,
			logScope: 'test',
			logSink: new ConsoleLogSink({ out: () => undefined, err: () => undefined }),
		});

		const names = Object.getOwnPropertyNames(core.history);
		assert.deepEqual(
			names.filter((name) => /arm|fail|inject|fault/i.test(name)),
			[],
		);
		core.chat.dispose();
	});

	test('a porta injetada falha uma vez e não atinge a escrita seguinte', async () => {
		const root = await makeRoot();
		// A armadilha é armada **depois** da criação: a criação é uma escrita
		// legítima que deve passar.
		let armed = false;
		const store = new FileDataStore({
			rootPath: root,
			writeFile: async (path, contents) => {
				if (armed) {
					armed = false;
					throw new Error('falha de gravação injetada');
				}
				await writeFileAtomic(path, contents);
			},
		});
		const conversation = await store.createConversation({ title: 'porta' });
		armed = true;

		await assert.rejects(async () => await store.appendMessage(conversation.id, { role: 'user', content: 'a' }));
		assert.equal(armed, false, 'a armadilha foi consumida');

		await store.appendMessage(conversation.id, { role: 'user', content: 'b' });
		const record = await store.getConversation(conversation.id);
		assert.deepEqual(
			record?.messages.map((message) => message.content),
			['b'],
			'a escrita seguinte passou',
		);
	});

	test('a porta pode mirar só um arquivo', async () => {
		const root = await makeRoot();
		const writeFile = failingWritePort(writeFileAtomic, [
			{ when: (path) => path.endsWith('turns.json'), times: 2 },
		]);
		const store = new FileDataStore({ rootPath: root, writeFile: writeFile.port });
		const conversation = await store.createConversation({ title: 'isolada' });

		// Só o registro de turnos falharia; o histórico não é atingido.
		await store.appendMessage(conversation.id, { role: 'user', content: 'ok' });
		assert.equal(writeFile.remaining(), 2, 'a armadilha de turns.json segue intacta');
		assert.deepEqual(
			(await store.getConversation(conversation.id))?.messages.map((message) => message.content),
			['ok'],
		);
	});

	test('sem porta injetada, a gravação é a de produção', async () => {
		const root = await makeRoot();
		const store = new FileDataStore({ rootPath: root });
		const conversation = await store.createConversation({ title: 'produção' });

		// O arquivo existe no disco, no formato de sempre.
		const raw = JSON.parse(await readFile(join(root, 'conversations', `${conversation.id}.json`), 'utf8')) as {
			readonly id: string;
		};
		assert.equal(raw.id, conversation.id);
	});

	test('o TurnRecordStore usa a porta injetada para turns.json', async () => {
		const root = await makeRoot();
		const writeFile = failingWritePort(writeFileAtomic, [{ when: (path) => path.endsWith('turns.json') }]);
		const turns = new TurnRecordStore({ root, writeFile: writeFile.port });

		await assert.rejects(async () =>
			await turns.start({ turnId: 'svc-turn-1', conversationId: 'cnv_1' }),
		);
		assert.equal(writeFile.remaining(), 0);

		// E a escrita seguinte, sem armadilha, grava de verdade.
		await turns.start({ turnId: 'svc-turn-2', conversationId: 'cnv_1' });
		const state = await turns.list();
		assert.equal(state.kind, 'valid');
		if (state.kind === 'valid') {
			assert.deepEqual(
				state.turns.map((turn) => turn.turnId),
				['svc-turn-2'],
			);
		}
	});
});
