/**
 * R4K: integridade e recuperação segura de `turns.json`.
 *
 * ## O que estes testes fixam
 *
 * - os quatro estados do arquivo são **distintos**: ausente, válido,
 *   corrompido e erro de I/O — e nenhum deles vira silenciosamente lista vazia;
 * - nenhuma escrita parte de um arquivo corrompido: os bytes originais ficam
 *   intactos, byte a byte;
 * - a cópia de segurança nunca sobrescreve uma cópia anterior;
 * - `reset` só se aplica a arquivo corrompido (ou ausente), nunca a um válido;
 * - a recuperação corre na mesma fila de `start`/`finish`;
 * - nada é inventado: depois do reset o registro está vazio, não "recuperado".
 *
 * Unitário: o store em disco, sem servidor nem modelo. Os testes de rota e de
 * chat ao vivo estão em `turnsRecovery.test.ts`.
 */
import * as assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TurnRecordCorruptError, TurnRecordStore, TURNS_FILE } from '../core/storage/turnRecords';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const roots: string[] = [];

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'evelyn-r4k-'));
	roots.push(root);
	return root;
}

function storeFor(root: string, now?: () => Date): TurnRecordStore {
	return new TurnRecordStore({ root, ...(now !== undefined ? { now } : {}) });
}

async function readRaw(root: string): Promise<Buffer> {
	return await readFile(join(root, TURNS_FILE));
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

/** Um registro válido, para servir de base. */
function validFile(turns: readonly unknown[] = []): string {
	return JSON.stringify({ version: 1, turns }, null, 2);
}

const ONE_TURN = {
	turnId: 'svc-turn-1',
	conversationId: 'cnv_1',
	status: 'completed',
	startedAt: '2026-01-01T00:00:00.000Z',
	finishedAt: '2026-01-01T00:00:05.000Z',
};

teardown(async () => {
	for (const root of roots.splice(0)) {
		await removeFixtureTree(root).catch(() => undefined);
	}
});

suite('R4K: estados do arquivo de turnos', () => {
	test('instalação nova: ausente, sem criar arquivo só para ler', async () => {
		const root = await makeRoot();
		const store = storeFor(root);

		const state = await store.list();

		assert.equal(state.kind, 'absent');
		assert.equal(await exists(join(root, TURNS_FILE)), false);
	});

	test('a leitura repetida também não cria o arquivo', async () => {
		const root = await makeRoot();

		await storeFor(root).list();
		await storeFor(root).forConversation('cnv_1');
		await storeFor(root).query({ status: 'all', limit: 10, offset: 0 });

		assert.equal(await exists(join(root, TURNS_FILE)), false);
	});

	test('arquivo vazio é corrompido, não ausente', async () => {
		const root = await makeRoot();
		await writeFile(join(root, TURNS_FILE), '', 'utf8');

		const state = await storeFor(root).list();

		// A diferença importa: quem criou o arquivo com conteúdo vazio perdeu
		// uma gravação; tratar como instalação nova apagaria a pista.
		assert.equal(state.kind, 'corrupt');
		if (state.kind === 'corrupt') {
			assert.match(state.reason, /vazio/);
		}
	});

	test('só espaços também é corrompido', async () => {
		const root = await makeRoot();
		await writeFile(join(root, TURNS_FILE), '  \n\t\n', 'utf8');

		assert.equal((await storeFor(root).list()).kind, 'corrupt');
	});

	test('JSON truncado é corrompido', async () => {
		const root = await makeRoot();
		const full = validFile([ONE_TURN]);
		await writeFile(join(root, TURNS_FILE), full.slice(0, full.length - 12), 'utf8');

		const state = await storeFor(root).list();

		assert.equal(state.kind, 'corrupt');
		if (state.kind === 'corrupt') {
			assert.match(state.reason, /não é JSON válido/);
		}
	});

	test('JSON sintaticamente inválido é corrompido', async () => {
		const root = await makeRoot();
		await writeFile(join(root, TURNS_FILE), '{ version: 1, turns: [] }', 'utf8');

		assert.equal((await storeFor(root).list()).kind, 'corrupt');
	});

	test('estrutura incompatível é corrompida, em todas as formas', async () => {
		const cases: readonly (readonly [string, string])[] = [
			['array no lugar do objeto', '[]'],
			['nullable', 'null'],
			['número solto', '42'],
			['string solta', '"registro"'],
			['sem version', JSON.stringify({ turns: [] })],
			['version desconhecida', JSON.stringify({ version: 2, turns: [] })],
			['version como string', JSON.stringify({ version: '1', turns: [] })],
			['turns não é lista', JSON.stringify({ version: 1, turns: {} })],
			['turns ausente', JSON.stringify({ version: 1 })],
		];
		for (const [label, body] of cases) {
			const root = await makeRoot();
			await writeFile(join(root, TURNS_FILE), body, 'utf8');

			const state = await storeFor(root).list();

			assert.equal(state.kind, 'corrupt', label);
		}
	});

	test('registro individual inválido é descartado; o arquivo continua válido', async () => {
		const root = await makeRoot();
		await writeFile(
			join(root, TURNS_FILE),
			validFile([
				ONE_TURN,
				{ turnId: '', conversationId: 'cnv_1', status: 'running', startedAt: '2026-01-01T00:00:00.000Z' },
				{ turnId: 'x', conversationId: 'cnv_1', status: 'inventado', startedAt: '2026-01-01T00:00:00.000Z' },
				{ turnId: 'y', conversationId: 'cnv_1', status: 'running', startedAt: 'não é data' },
				'nem objeto',
			]),
			'utf8',
		);

		const state = await storeFor(root).list();

		assert.equal(state.kind, 'valid');
		if (state.kind !== 'valid') {
			return;
		}
		assert.deepEqual(
			state.turns.map((turn) => turn.turnId),
			['svc-turn-1'],
		);
		assert.equal(state.unreadable.length, 4);
	});

	test('erro de I/O não é corrompido e não é ausente: sobe', async () => {
		const root = await makeRoot();
		// Um diretório com o nome do arquivo: `readFile` falha com `EISDIR`,
		// que não é `ENOENT`. É a forma portátil de provocar erro de leitura
		// sem depender de permissão (que no Windows e como administrador nem
		// sempre falha).
		await mkdir(join(root, TURNS_FILE));

		await assert.rejects(
			async () => await storeFor(root).list(),
			(error: NodeJS.ErrnoException) => {
				assert.notEqual(error.code, 'ENOENT');
				assert.equal(error instanceof TurnRecordCorruptError, false, 'I/O não é corrupção');
				return true;
			},
		);
	});
});

suite('R4K: o arquivo corrompido é preservado', () => {
	test('nenhuma escrita parte de um arquivo corrompido', async () => {
		const root = await makeRoot();
		const original = '{"version":1,"turns":[{"turnId":"svc-turn-1",';
		await writeFile(join(root, TURNS_FILE), original, 'utf8');
		const before = await readRaw(root);

		await assert.rejects(
			async () => await storeFor(root).start({ turnId: 'svc-turn-2', conversationId: 'cnv_2' }),
			TurnRecordCorruptError,
		);

		assert.deepEqual(await readRaw(root), before, 'o arquivo ficou byte a byte igual');
	});

	test('finish também recusa, e nada é gravado', async () => {
		const root = await makeRoot();
		await writeFile(join(root, TURNS_FILE), 'truncado', 'utf8');
		const before = await readRaw(root);

		await assert.rejects(
			async () =>
				await storeFor(root).finish({ turnId: 'svc-turn-1', status: 'completed' }),
			TurnRecordCorruptError,
		);

		assert.deepEqual(await readRaw(root), before);
	});

	test('recover (R4H) recusa em vez de reescrever', async () => {
		const root = await makeRoot();
		await writeFile(join(root, TURNS_FILE), '{"version":1,"turns":[', 'utf8');
		const before = await readRaw(root);

		await assert.rejects(
			async () => await storeFor(root).recover(),
			TurnRecordCorruptError,
		);

		assert.deepEqual(await readRaw(root), before);
	});

	test('retain (R4I) recusa em vez de reescrever', async () => {
		const root = await makeRoot();
		await writeFile(join(root, TURNS_FILE), 'corrompido', 'utf8');
		const before = await readRaw(root);

		await assert.rejects(
			async () => await storeFor(root).retain(),
			TurnRecordCorruptError,
		);

		assert.deepEqual(await readRaw(root), before);
	});

	test('as leituras também recusam, com o motivo de classe e sem caminho', async () => {
		const root = await makeRoot();
		await writeFile(join(root, TURNS_FILE), 'não é json', 'utf8');
		const store = storeFor(root);

		for (const read of [
			async () => await store.forConversation('cnv_1'),
			async () => await store.query({ status: 'all', limit: 10, offset: 0 }),
		]) {
			await assert.rejects(read, (error: unknown) => {
				assert.equal(error instanceof TurnRecordCorruptError, true);
				const corrupt = error as TurnRecordCorruptError;
				assert.equal(corrupt.code, 'turns_corrupt');
				assert.equal(corrupt.reason.includes(root), false, 'motivo sem caminho');
				assert.equal(corrupt.message.includes(root), false, 'mensagem sem caminho');
				return true;
			});
		}
	});

	test('uma escrita recusada não deixa a fila quebrada', async () => {
		const root = await makeRoot();
		await writeFile(join(root, TURNS_FILE), 'corrompido', 'utf8');
		const store = storeFor(root);

		await assert.rejects(async () => await store.start({ turnId: 'a', conversationId: 'c' }), TurnRecordCorruptError);

		// O operador repara o arquivo; a próxima operação na mesma instância
		// precisa funcionar. A fila não pode ter ficado rejeitada.
		await writeFile(join(root, TURNS_FILE), validFile(), 'utf8');
		await store.start({ turnId: 'svc-turn-9', conversationId: 'cnv_9' });

		const state = await store.list();
		assert.equal(state.kind, 'valid');
		if (state.kind === 'valid') {
			assert.deepEqual(
				state.turns.map((turn) => turn.turnId),
				['svc-turn-9'],
			);
		}
	});

	test('a cópia é feita sem sobrescrever as anteriores', async () => {
		const root = await makeRoot();
		const corrupted = '{"version":1,"turns":[{"turnId":"svc-turn-1"';
		await writeFile(join(root, TURNS_FILE), corrupted, 'utf8');

		const first = await storeFor(root).backup();
		assert.equal(first.file, `${TURNS_FILE}.bak`);
		assert.equal(first.bytes, Buffer.byteLength(corrupted, 'utf8'));

		// Segunda cópia: o `.bak` já existe e não pode ser tocado.
		const second = await storeFor(root).backup();
		assert.equal(second.file, `${TURNS_FILE}.bak.2`);

		// A cópia é byte a byte, e a primeira continua igual.
		const firstBytes = await readFile(join(root, `${TURNS_FILE}.bak`));
		const secondBytes = await readFile(join(root, `${TURNS_FILE}.bak.2`));
		assert.deepEqual(firstBytes, Buffer.from(corrupted, 'utf8'));
		assert.deepEqual(secondBytes, Buffer.from(corrupted, 'utf8'));

		// E o original continua onde estava.
		assert.deepEqual(await readRaw(root), Buffer.from(corrupted, 'utf8'));
	});

	test('a cópia não apaga um arquivo homônimo que já existia', async () => {
		const root = await makeRoot();
		await writeFile(join(root, TURNS_FILE), 'corrompido', 'utf8');
		await writeFile(join(root, `${TURNS_FILE}.bak`), 'cópia antiga', 'utf8');

		const result = await storeFor(root).backup();

		assert.equal(result.file, `${TURNS_FILE}.bak.2`);
		assert.equal(await readFile(join(root, `${TURNS_FILE}.bak`), 'utf8'), 'cópia antiga');
	});

	test('não há cópia de um arquivo ausente nem de um válido', async () => {
		const absent = await makeRoot();
		await assert.rejects(async () => await storeFor(absent).backup());
		assert.equal(await exists(join(absent, `${TURNS_FILE}.bak`)), false);

		const valid = await makeRoot();
		await writeFile(join(valid, TURNS_FILE), validFile([ONE_TURN]), 'utf8');
		await assert.rejects(async () => await storeFor(valid).backup());
		assert.equal(await exists(join(valid, `${TURNS_FILE}.bak`)), false);
	});

	test('as rotas do diagnóstico nunca recebem caminho', async () => {
		// `backup()` devolve o **nome**, relativo à raiz.
		const root = await makeRoot();
		await writeFile(join(root, TURNS_FILE), 'x', 'utf8');

		const result = await storeFor(root).backup();

		assert.equal(result.file.includes('/'), false);
		assert.equal(result.file.includes('\\'), false);
		assert.equal(result.file.includes(root), false);
	});
});

suite('R4K: a reinicialização explícita', () => {
	test('reset grava um registro vazio e válido', async () => {
		const root = await makeRoot();
		await writeFile(join(root, TURNS_FILE), '{"version":1,"turns":[', 'utf8');

		const result = await storeFor(root).reset();

		assert.deepEqual(result, { reset: true });
		const raw = JSON.parse(await readFile(join(root, TURNS_FILE), 'utf8')) as {
			readonly version: number;
			readonly turns: readonly unknown[];
		};
		assert.equal(raw.version, 1);
		assert.deepEqual(raw.turns, []);

		// Nada é inventado: o registro novo está vazio.
		const state = await storeFor(root).list();
		assert.equal(state.kind, 'valid');
		if (state.kind === 'valid') {
			assert.deepEqual(state.turns, []);
		}
	});

	test('depois do reset, o store volta a aceitar turnos — na mesma instância', async () => {
		const root = await makeRoot();
		await writeFile(join(root, TURNS_FILE), 'corrompido', 'utf8');
		const store = storeFor(root);

		await store.reset();
		await store.start({ turnId: 'svc-turn-1', conversationId: 'cnv_1' });
		await store.finish({ turnId: 'svc-turn-1', status: 'completed' });

		const turns = await store.forConversation('cnv_1');
		assert.equal(turns.length, 1);
		assert.equal(turns[0]?.status, 'completed');
	});

	test('reset recusa um registro válido', async () => {
		const root = await makeRoot();
		await writeFile(join(root, TURNS_FILE), validFile([ONE_TURN]), 'utf8');
		const before = await readRaw(root);

		await assert.rejects(async () => await storeFor(root).reset());

		assert.deepEqual(await readRaw(root), before, 'o registro bom não foi tocado');
	});

	test('reset em arquivo ausente cria o vazio (equivale ao que não existe)', async () => {
		const root = await makeRoot();

		await storeFor(root).reset();

		assert.equal(await exists(join(root, TURNS_FILE)), true);
		assert.equal((await storeFor(root).list()).kind, 'valid');
	});

	test('a cópia sobrevive ao reset: a evidência fica, o registro novo não a apaga', async () => {
		const root = await makeRoot();
		const corrupted = '{"version":1,"turns":[{"turnId":"svc-turn-1","conversationId":"cnv_1"';
		await writeFile(join(root, TURNS_FILE), corrupted, 'utf8');

		await storeFor(root).backup();
		await storeFor(root).reset();

		const backup = await readFile(join(root, `${TURNS_FILE}.bak`), 'utf8');
		assert.equal(backup, corrupted);
	});

	test('a escrita da reinicialização é atômica (nenhum `.tmp` sobra)', async () => {
		const root = await makeRoot();
		await writeFile(join(root, TURNS_FILE), 'corrompido', 'utf8');

		await storeFor(root).reset();

		const files = await readdir(root);
		assert.deepEqual(
			files.filter((name) => name.endsWith('.tmp')),
			[],
		);
		assert.equal(files.includes(TURNS_FILE), true);
	});
});

suite('R4K: concorrência entre recuperação e turnos', () => {
	test('um start simultâneo ao reset espera a vez e o resultado é coerente', async () => {
		const root = await makeRoot();
		await writeFile(join(root, TURNS_FILE), 'corrompido', 'utf8');
		const store = storeFor(root);

		// Disparados juntos, na mesma instância: a fila decide a ordem. O
		// `start` pode ser recusado (se chegar antes do reset) ou entrar
		// depois — o que não pode é os dois escreverem ao mesmo tempo e o
		// arquivo terminar sem o turno que disse ter começado.
		const resetting = store.reset();
		const starting = store.start({ turnId: 'svc-turn-1', conversationId: 'cnv_1' }).then(
			() => 'started' as const,
			(error: unknown) => {
				assert.equal(error instanceof TurnRecordCorruptError, true);
				return 'refused' as const;
			},
		);
		const [resetResult, startResult] = await Promise.all([resetting, starting]);

		assert.deepEqual(resetResult, { reset: true });
		const state = await storeFor(root).list();
		assert.equal(state.kind, 'valid');
		if (state.kind !== 'valid') {
			return;
		}
		// A ordem real é: `reset` foi enfileirado primeiro (a chamada é
		// síncrona até `enqueue`), então o `start` entra depois e encontra
		// um registro vazio e válido. A prova de coerência é o arquivo
		// conter exatamente o turno que o `start` disse ter começado.
		assert.equal(startResult, 'started');
		assert.deepEqual(
			state.turns.map((turn) => turn.turnId),
			['svc-turn-1'],
		);
	});

	test('reset e finish concorrentes não deixam o arquivo nem vazio nem ilegível por acaso', async () => {
		const root = await makeRoot();
		const store = storeFor(root);
		// Começa válido, com um `running`; então o operador corrompe o arquivo
		// por fora (uma edição à mão) e manda reset enquanto o turno termina.
		await store.start({ turnId: 'svc-turn-1', conversationId: 'cnv_1' });
		await writeFile(join(root, TURNS_FILE), 'corrompido', 'utf8');

		const outcomes = await Promise.allSettled([
			store.reset(),
			store.finish({ turnId: 'svc-turn-1', status: 'completed' }),
		]);

		assert.equal(outcomes[0]?.status, 'fulfilled');
		// O `finish` corre depois do reset e não encontra o turno: `false`,
		// sem inventar um registro.
		const finish = outcomes[1];
		assert.equal(finish?.status, 'fulfilled');
		if (finish?.status === 'fulfilled') {
			assert.equal(finish.value, false);
		}
		const state = await storeFor(root).list();
		assert.equal(state.kind, 'valid');
	});

	test('muitas escritas concorrentes sobre um arquivo corrompido deixam os bytes intactos', async () => {
		const root = await makeRoot();
		const corrupted = '{"version":1,"turns":[{"turnId":"svc-turn-1",';
		await writeFile(join(root, TURNS_FILE), corrupted, 'utf8');
		const store = storeFor(root);

		const attempts = await Promise.allSettled(
			Array.from({ length: 8 }, (_, index) =>
				index % 2 === 0
					? store.start({ turnId: `svc-turn-${index}`, conversationId: 'cnv_1' })
					: store.finish({ turnId: `svc-turn-${index}`, status: 'failed' }),
			),
		);

		assert.equal(
			attempts.every((outcome) => outcome.status === 'rejected'),
			true,
		);
		assert.equal(await readFile(join(root, TURNS_FILE), 'utf8'), corrupted);
	});

	test('duas cópias simultâneas não escolhem o mesmo nome', async () => {
		const root = await makeRoot();
		await writeFile(join(root, TURNS_FILE), 'corrompido', 'utf8');
		const store = storeFor(root);

		const results = await Promise.all([store.backup(), store.backup(), store.backup()]);

		assert.deepEqual(
			results.map((result) => result.file).sort(),
			[`${TURNS_FILE}.bak`, `${TURNS_FILE}.bak.2`, `${TURNS_FILE}.bak.3`].sort(),
		);
	});

	test('uma falha de escrita no rename não perde a escrita seguinte nem o arquivo', async () => {
		// `writeFileAtomic` escreve num temporário e só então **renomeia**.
		// Renomear para o nome de um diretório existente falha
		// (`EEXIST`/`EPERM`/`EISDIR`, conforme a plataforma) — é a mesma
		// classe de falha de um destino bloqueado, sem depender de
		// permissão nem de disco cheio.
		//
		// Aqui o destino é um **diretório** temporário trocado no lugar do
		// arquivo no meio do caminho: a escrita falha depois de o temporário
		// ter sido escrito, e precisa:
		//  - rejeitar (o chamador sabe que não gravou);
		//  - deixar a fila utilizável para a próxima escrita.
		const root = await makeRoot();
		const store = storeFor(root);
		await store.start({ turnId: 'svc-turn-1', conversationId: 'cnv_1' });
		const good = await readFile(join(root, TURNS_FILE), 'utf8');

		// Substitui o arquivo por um diretório: o rename passa a falhar.
		const blocked = join(root, `${TURNS_FILE}.blocked`);
		await rename(join(root, TURNS_FILE), blocked);
		await mkdir(join(root, TURNS_FILE));

		await assert.rejects(async () =>
			await store.start({ turnId: 'svc-turn-2', conversationId: 'cnv_1' }),
		);

		// Nada foi gravado sobre o bloqueio, e o arquivo bom está intacto.
		assert.equal((await readdir(join(root, TURNS_FILE))).length, 0);
		assert.equal(await readFile(blocked, 'utf8'), good);

		// O operador remove o bloqueio; a **mesma** instância volta a gravar.
		await rm(join(root, TURNS_FILE), { recursive: true, force: true });
		await rename(blocked, join(root, TURNS_FILE));

		await store.start({ turnId: 'svc-turn-2', conversationId: 'cnv_1' });
		const state = await storeFor(root).list();
		assert.equal(state.kind, 'valid');
		if (state.kind === 'valid') {
			assert.equal(
				state.turns.some((turn) => turn.turnId === 'svc-turn-2'),
				true,
			);
		}
	});
});

suite('R4K: o registro válido mantém a R4H e a R4I', () => {
	test('recover continua marcando `running` como `interrupted`', async () => {
		const root = await makeRoot();
		const store = storeFor(root);
		await store.start({ turnId: 'svc-turn-1', conversationId: 'cnv_1' });

		const report = await storeFor(root).recover();

		assert.equal(report.interrupted, 1);
		assert.equal(report.turns[0]?.status, 'interrupted');
		assert.equal(report.turns[0]?.reason?.includes('encerrado antes'), true);
	});

	test('recover em arquivo ausente não cria arquivo', async () => {
		const root = await makeRoot();

		const report = await storeFor(root).recover();

		assert.equal(report.interrupted, 0);
		assert.equal(await exists(join(root, TURNS_FILE)), false);
	});

	test('os registros individuais descartados são ditos no relatório de recover', async () => {
		const root = await makeRoot();
		await writeFile(
			join(root, TURNS_FILE),
			validFile([ONE_TURN, { turnId: 'quebrado' }]),
			'utf8',
		);

		const report = await storeFor(root).recover();

		assert.equal(report.unreadable.length, 1);
	});

	test('retain continua aplicando o teto de quantidade', async () => {
		const root = await makeRoot();
		const many = Array.from({ length: 600 }, (_, index) => ({
			turnId: `svc-turn-${String(index).padStart(3, '0')}`,
			conversationId: 'cnv_1',
			status: 'completed',
			startedAt: new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString(),
			finishedAt: new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString(),
		}));
		await writeFile(join(root, TURNS_FILE), validFile(many), 'utf8');

		// A data de "agora" é próxima do registro: o corte por idade (R4I)
		// não deve ser o responsável pela remoção neste teste.
		const result = await storeFor(root).retain(new Date(Date.UTC(2026, 0, 2)));

		assert.equal(result.removedByCount > 0, true);
		const state = await storeFor(root).list();
		if (state.kind === 'valid') {
			assert.equal(state.turns.length <= 500, true);
		}
	});
});
