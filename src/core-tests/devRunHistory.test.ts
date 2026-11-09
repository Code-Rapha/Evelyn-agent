/**
 * DEV-9.1 — o histórico das execuções do `dev_run`.
 *
 * Três camadas, cada uma com o que ela pode garantir:
 *
 * 1. **parser** (`parseDevRunHistoryEntry`): uma linha sem forma é descartada
 *    em vez de renderizar `undefined`;
 * 2. **registro** (`FileDevAudit`): grava sem saída do comando e sobrevive a
 *    uma linha truncada;
 * 3. **pedido** (`parseDevRequest`): `history` é leitura pura, sem argumento.
 */
import * as assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { FileDevAudit, InMemoryDevAudit, redactCommand } from '../core/dev/devAudit';
import type { DevAuditRecord } from '../core/dev/devAudit';
import { parseDevRunHistoryEntry } from '../desktop/devView';
import { parseDevRequest } from '../desktop/devControl';

const ENTRY: DevAuditRecord = {
	id: 'run-1-abc',
	command: 'npm run check-types',
	cwd: 'C:\\repo',
	startedAt: '2026-11-05T10:00:00.000Z',
	finishedAt: '2026-11-05T10:00:12.000Z',
	approval: 'approved',
	durationMs: 12_000,
	exitCode: 0,
	termination: 'exited',
	outputBytes: { stdout: 120, stderr: 0 },
	truncated: false,
};

test('uma linha válida do diário é lida inteira', () => {
	const view = parseDevRunHistoryEntry(ENTRY);
	assert.ok(view !== undefined);
	assert.equal(view.command, 'npm run check-types');
	assert.equal(view.cwd, 'C:\\repo');
	assert.equal(view.durationMs, 12_000);
	assert.equal(view.exitCode, 0);
	assert.equal(view.termination, 'exited');
	assert.equal(view.approval, 'approved');
	assert.equal(view.truncated, false);
});

test('uma linha sem forma é descartada, não quebra a lista', () => {
	for (const bad of [
		null,
		undefined,
		[],
		{ command: 'x' },
		{ ...ENTRY, termination: 'inventado' },
		{ ...ENTRY, approval: 'talvez' },
		{ ...ENTRY, durationMs: 'muitos' },
	]) {
		assert.equal(parseDevRunHistoryEntry(bad), undefined, JSON.stringify(bad));
	}
});

test('exitCode nulo é preservado (o processo não chegou a rodar)', () => {
	const view = parseDevRunHistoryEntry({ ...ENTRY, exitCode: null, termination: 'failed' });
	assert.ok(view !== undefined);
	assert.equal(view.exitCode, null);
});

test('o registro em arquivo grava, relê e não guarda saída', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'evelyn-history-'));
	const file = join(dir, 'runs.jsonl');
	const audit = new FileDevAudit(file);
	await audit.record({ ...ENTRY, command: 'node noop.js' });
	const raw = await readFile(file, 'utf8');
	// O que se garante é que não há conteúdo de saída: só os **tamanhos**.
	const parsed = JSON.parse(raw.trim()) as Record<string, unknown>;
	const keys = Object.keys(parsed);
	assert.ok(!keys.includes('stdout'), 'nenhum campo com a saída');
	assert.ok(!keys.includes('stderr'), 'nenhum campo com a saída');
	assert.deepEqual(parsed['outputBytes'], { stdout: 120, stderr: 0 }, 'só tamanhos');
	assert.ok(raw.includes('node noop.js'));

	const listed = await audit.list();
	assert.equal(listed.length, 1);
	assert.equal(listed[0]?.command, 'node noop.js');
});

test('uma linha truncada no arquivo é ignorada e o resto continua legível', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'evelyn-history-'));
	const file = join(dir, 'runs.jsonl');
	await writeFile(
		file,
		`${JSON.stringify(ENTRY)}\n{"id":"run-2","command":"meio`, // queda no meio da escrita
		'utf8',
	);
	const listed = await new FileDevAudit(file).list();
	assert.equal(listed.length, 1, 'a linha boa sobrevive à linha ruim');
	assert.equal(listed[0]?.command, 'npm run check-types');
});

test('o histórico é mais recente primeiro e respeita o limite', async () => {
	const audit = new InMemoryDevAudit();
	for (let index = 0; index < 5; index += 1) {
		await audit.record({ ...ENTRY, id: `run-${index}`, command: `comando ${index}` });
	}
	const listed = await audit.list(2);
	assert.equal(listed.length, 2);
	assert.equal(listed[0]?.command, 'comando 4', 'o último gravado vem primeiro');
});

test('o comando do diário já sai redigido', async () => {
	const audit = new InMemoryDevAudit();
	await audit.record({ ...ENTRY, command: redactCommand('node x.js --token=segredo123') });
	const [entry] = await audit.list();
	assert.ok(entry !== undefined);
	assert.ok(!entry.command.includes('segredo123'));
});

test('`history` é leitura pura: aceita sem argumento e recusa com argumento', () => {
	assert.deepEqual(parseDevRequest('history', undefined), { action: 'history' });
	assert.throws(() => parseDevRequest('history', { extra: 1 }));
});
