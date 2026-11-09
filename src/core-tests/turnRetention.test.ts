/**
 * R4I: retenção de `turns.json`.
 *
 * ## O que estes testes fixam
 *
 * - idade **e** quantidade, aplicadas juntas;
 * - `running` nunca sai — nem para respeitar o teto;
 * - data ausente ou inválida é tratada com conservadorismo (fica);
 * - a ordem é total e determinística;
 * - a limpeza convive com `start`/`finish` concorrentes sem perder nenhum;
 * - uma falha de escrita preserva o arquivo anterior.
 *
 * Unitário: o store em disco, sem servidor nem modelo.
 */
import * as assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	applyRetention,
	TURN_RETENTION_DAYS,
	TurnRecordStore,
	TURNS_FILE,
	type TurnRecord,
} from '../core/storage/turnRecords';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const roots: string[] = [];
const NOW = new Date('2026-06-01T12:00:00.000Z');

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'evelyn-r4i-'));
	roots.push(root);
	return root;
}

/** Um terminal, com `finishedAt` deslocado em dias a partir de NOW. */
function terminal(id: string, daysAgo: number, status: TurnRecord['status'] = 'completed'): TurnRecord {
	const finished = new Date(NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
	return {
		turnId: id,
		conversationId: 'cnv_1',
		status,
		startedAt: finished,
		finishedAt: finished,
	};
}

function running(id: string): TurnRecord {
	return { turnId: id, conversationId: 'cnv_1', status: 'running', startedAt: NOW.toISOString() };
}

async function seed(root: string, turns: readonly TurnRecord[]): Promise<void> {
	await writeFile(join(root, TURNS_FILE), JSON.stringify({ version: 1, turns }, null, 2), 'utf8');
}

async function rawTurns(root: string): Promise<TurnRecord[]> {
	const parsed = JSON.parse(await readFile(join(root, TURNS_FILE), 'utf8')) as { turns: TurnRecord[] };
	return parsed.turns;
}

teardown(async () => {
	for (const root of roots.splice(0)) {
		await removeFixtureTree(root).catch(() => undefined);
	}
});

suite('R4I: a regra de retenção', () => {
	test('terminais com mais de 30 dias saem; os recentes ficam', () => {
		const turns = [
			terminal('velho', TURN_RETENTION_DAYS + 1),
			terminal('limite', TURN_RETENTION_DAYS),
			terminal('novo', 1),
		];

		const result = applyRetention(turns, NOW);

		assert.deepEqual(result.turns.map((turn) => turn.turnId).sort(), ['limite', 'novo']);
		assert.equal(result.removedByAge, 1);
		assert.equal(result.removedByCount, 0);
	});

	test('um terminal exatamente no limite de idade fica', () => {
		// A regra é "mais de 30 dias", não "30 dias ou mais": o limite é
		// inclusivo do lado que mantém, e isso precisa ser previsível.
		const result = applyRetention([terminal('limite', TURN_RETENTION_DAYS)], NOW);
		assert.equal(result.turns.length, 1);
	});

	test('o teto de 500 mantém os mais recentes', () => {
		// `index` maior = `daysAgo` maior = mais antigo. Os 20 mais antigos
		// (índices 500..519) saem; os 500 mais novos ficam.
		const turns = Array.from({ length: 520 }, (_unused, index) => terminal(`t-${String(index).padStart(4, '0')}`, index / 100));

		const result = applyRetention(turns, NOW);

		assert.equal(result.turns.length, 500);
		assert.equal(result.removedByCount, 20);
		const ids = new Set(result.turns.map((turn) => turn.turnId));
		for (let index = 0; index < 500; index += 1) {
			assert.equal(ids.has(`t-${String(index).padStart(4, '0')}`), true, `t-${index} deveria ficar`);
		}
		for (let index = 500; index < 520; index += 1) {
			assert.equal(ids.has(`t-${String(index).padStart(4, '0')}`), false, `t-${index} deveria sair`);
		}
	});

	test('idade e quantidade valem juntas', () => {
		// 300 antigos (saem por idade) + 520 recentes (20 saem por quantidade).
		const old = Array.from({ length: 300 }, (_unused, index) => terminal(`old-${index}`, 40 + index));
		const recent = Array.from({ length: 520 }, (_unused, index) => terminal(`new-${String(index).padStart(3, '0')}`, index / 100));

		const result = applyRetention([...old, ...recent], NOW);

		assert.equal(result.removedByAge, 300);
		assert.equal(result.removedByCount, 20);
		assert.equal(result.turns.length, 500);
		assert.equal(result.turns.every((turn) => turn.turnId.startsWith('new-')), true);
	});

	test('`running` nunca é removido — nem para respeitar o teto', () => {
		const runs = Array.from({ length: 600 }, (_unused, index) => running(`run-${index}`));
		const terminals = Array.from({ length: 510 }, (_unused, index) => terminal(`t-${index}`, index / 100));

		const result = applyRetention([...runs, ...terminals], NOW);

		assert.equal(result.turns.filter((turn) => turn.status === 'running').length, 600);
		assert.equal(result.turns.filter((turn) => turn.status !== 'running').length, 500);
		// O arquivo fica maior que o previsto, de propósito.
		assert.equal(result.turns.length, 1100);
	});

	test('um `running` muito antigo continua', () => {
		// Não tem `finishedAt`, então a idade não se aplica.
		const old: TurnRecord = {
			turnId: 'velho-em-curso',
			conversationId: 'cnv_1',
			status: 'running',
			startedAt: new Date(NOW.getTime() - 400 * 24 * 60 * 60 * 1000).toISOString(),
		};
		const result = applyRetention([old], NOW);
		assert.equal(result.turns.length, 1);
		assert.equal(result.removedByAge, 0);
	});

	test('terminal sem data de fim, ou com data inválida, é preservado', () => {
		const noDate: TurnRecord = {
			turnId: 'sem-data',
			conversationId: 'cnv_1',
			status: 'failed',
			startedAt: new Date(NOW.getTime() - 400 * 24 * 60 * 60 * 1000).toISOString(),
		};
		const badDate: TurnRecord = {
			turnId: 'data-ruim',
			conversationId: 'cnv_1',
			status: 'cancelled',
			startedAt: NOW.toISOString(),
			finishedAt: 'não é uma data',
		};

		const result = applyRetention([noDate, badDate], NOW);

		assert.deepEqual(result.turns.map((turn) => turn.turnId).sort(), ['data-ruim', 'sem-data']);
		assert.equal(result.removedByAge, 0);
	});

	test('a ordem é total: datas iguais desempatam por id', () => {
		// 510 terminais com a mesma data: os 500 mantidos precisam ser sempre os
		// mesmos, senão "os mais recentes" seria uma afirmação sem critério.
		const same = Array.from({ length: 510 }, (_unused, index) => ({
			...terminal('x', 1),
			turnId: `dup-${String(index).padStart(3, '0')}`,
		}));

		const first = applyRetention(same, NOW).turns.map((turn) => turn.turnId).sort();
		const second = applyRetention([...same].reverse(), NOW).turns.map((turn) => turn.turnId).sort();

		// O **conjunto** mantido é o mesmo, qualquer que seja a ordem de entrada:
		// é isso que o desempate por id garante. A ordem no arquivo segue a de
		// entrada, e não é o que "os mais recentes" promete.
		assert.deepEqual(first, second);
		assert.equal(first.length, 500);
		// Os 10 descartados são sempre os de maior id (o desempate é crescente).
		assert.equal(first.includes('dup-000'), true);
		assert.equal(first.includes('dup-509'), false);
	});
});

suite('R4I: a retenção no store', () => {
	test('aplica idade e quantidade e grava o resultado', async () => {
		const root = await makeRoot();
		await seed(root, [
			terminal('velho', 45),
			terminal('recente', 2),
			{ ...running('em-curso') },
		]);

		const result = await new TurnRecordStore({ root }).retain(NOW);
		const written = await rawTurns(root);

		assert.equal(result.removedByAge, 1);
		assert.deepEqual(written.map((turn) => turn.turnId).sort(), ['em-curso', 'recente']);
	});

	test('sem nada a remover, o arquivo não é reescrito', async () => {
		const root = await makeRoot();
		await seed(root, [terminal('recente', 1)]);
		const before = await readFile(join(root, TURNS_FILE), 'utf8');

		const result = await new TurnRecordStore({ root }).retain(NOW);

		assert.equal(result.removedByAge + result.removedByCount, 0);
		assert.equal(await readFile(join(root, TURNS_FILE), 'utf8'), before);
	});

	test('a limpeza concorrente com `start` e `finish` não perde nenhum', async () => {
		const root = await makeRoot();
		// 200 antigos, para a limpeza ter trabalho de verdade.
		await seed(
			root,
			Array.from({ length: 200 }, (_unused, index) => terminal(`old-${index}`, 60 + index)),
		);
		const store = new TurnRecordStore({ root, now: () => NOW });

		// Limpeza, inícios e desfechos, todos disparados juntos.
		await Promise.all([
			store.retain(NOW),
			store.start({ turnId: 'novo-1', conversationId: 'cnv_a' }),
			store.start({ turnId: 'novo-2', conversationId: 'cnv_b' }),
			store.finish({ turnId: 'old-0', status: 'completed' }),
		]);
		await store.finish({ turnId: 'novo-1', status: 'completed' });

		const written = await rawTurns(root);
		const ids = new Set(written.map((turn) => turn.turnId));
		// Os turnos novos existem e o que foi iniciado sobreviveu.
		assert.equal(ids.has('novo-1'), true, 'o turno iniciado durante a limpeza sobreviveu');
		assert.equal(ids.has('novo-2'), true);
		// Os antigos saíram por idade.
		assert.equal(ids.has('old-0'), false);
		// E o registro continua válido.
		assert.equal(written.length, 2);
	});

	test('uma falha de escrita preserva o arquivo anterior', async () => {
		const root = await makeRoot();
		await seed(root, [terminal('velho', 45), terminal('recente', 1)]);
		const before = await readFile(join(root, TURNS_FILE), 'utf8');

		// O diretório vira somente-leitura (no Windows o teste é pulado: o modo
		// POSIX não se aplica da mesma forma).
		if (process.platform === 'win32') {
			// No Windows, a falha é provocada por um destino que é diretório —
			// `rename` sobre um diretório falha, e o temp é removido.
			const store = new TurnRecordStore({ root: join(root, TURNS_FILE, 'impossivel') });
			await assert.rejects(() => store.start({ turnId: 'x', conversationId: 'cnv' }));
			assert.equal(await readFile(join(root, TURNS_FILE), 'utf8'), before, 'o arquivo bom continua');
			return;
		}

		await chmod(root, 0o500);
		try {
			await assert.rejects(() => new TurnRecordStore({ root }).retain(NOW));
		} finally {
			await chmod(root, 0o700);
		}
		assert.equal(await readFile(join(root, TURNS_FILE), 'utf8'), before, 'o arquivo bom continua');
	});

	test('a retenção não toca em nenhum outro arquivo da raiz', async () => {
		const root = await makeRoot();
		await seed(root, [terminal('velho', 45)]);
		// Um arquivo que parece histórico, só para provar que ele não é tocado.
		const conversationPath = join(root, 'conversations');
		await import('node:fs/promises').then((fs) => fs.mkdir(conversationPath, { recursive: true }));
		await writeFile(join(conversationPath, 'cnv_1.json'), '{"histórico":"intocado"}', 'utf8');

		await new TurnRecordStore({ root }).retain(NOW);

		assert.equal(await readFile(join(conversationPath, 'cnv_1.json'), 'utf8'), '{"histórico":"intocado"}');
	});
});
