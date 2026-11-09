/**
 * R4I: a ordem recuperação → retenção, com o host de verdade.
 *
 * A diferença só aparece num caso concreto: um `running` **antigo** no
 * arquivo. Se a retenção rodasse primeiro, ele não seria terminal (não tem
 * `finishedAt`), então sobreviveria — e depois viraria `interrupted`, sem
 * nunca ser candidato ao corte por idade. Rodando a recuperação primeiro, ele
 * vira terminal com `finishedAt` de **agora**, e aí a idade não o alcança.
 *
 * O teste que prova a ordem é o **oposto**: um `running` que já deveria ter
 * sido interrompido deve aparecer como `interrupted` **e** continuar no
 * arquivo (a idade dele é agora). Se a retenção viesse antes e usasse a data
 * de início, ele poderia sumir.
 *
 * Processo real, raiz temporária, `dist/web/main.js`.
 */
import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { probeService } from '../app/discoverService';
import { TURNS_FILE, type TurnRecord } from '../core/storage/turnRecords';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const SERVICE_ENTRY = join(process.cwd(), 'dist', 'web', 'main.js');
const DAY = 24 * 60 * 60 * 1000;

const children: ReturnType<typeof spawn>[] = [];
const roots: string[] = [];

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'evelyn-r4i-host-'));
	roots.push(root);
	return root;
}

async function seed(root: string, turns: readonly TurnRecord[]): Promise<void> {
	await writeFile(join(root, TURNS_FILE), JSON.stringify({ version: 1, turns }, null, 2), 'utf8');
}

async function startService(root: string): Promise<{ child: ReturnType<typeof spawn>; port: number; token: string }> {
	assert.ok(existsSync(SERVICE_ENTRY), 'faltou `npm run web:build`');
	const child = spawn(process.execPath, [SERVICE_ENTRY, '--root', root, '--port', '0'], {
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	children.push(child);
	const deadline = Date.now() + 25_000;
	for (;;) {
		const probe = await probeService({ root });
		if (probe.kind === 'active') {
			return { child, port: probe.record.port, token: probe.record.chatToken };
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

async function turnsOnDisk(root: string): Promise<TurnRecord[]> {
	const parsed = JSON.parse(await readFile(join(root, TURNS_FILE), 'utf8')) as { turns: TurnRecord[] };
	return parsed.turns;
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

suite('R4I: o host aplica recuperação e retenção na ordem certa', () => {
	test('um `running` antigo vira `interrupted` e a idade não o alcança', async () => {
		const root = await makeRoot();
		const longAgo = new Date(Date.now() - 90 * DAY).toISOString();
		// Iniciado há 90 dias e nunca fechado: uma queda de três meses atrás.
		await seed(root, [
			{
				turnId: 'svc-turn-antigo',
				conversationId: 'cnv_1',
				status: 'running',
				startedAt: longAgo,
			},
		]);

		await startService(root);
		try {
			const turns = await turnsOnDisk(root);
			const recovered = turns.find((turn) => turn.turnId === 'svc-turn-antigo');
			// Recuperado — e presente: se a retenção tivesse olhado a data de
			// início antes da recuperação, ele poderia ter sido descartado.
			assert.ok(recovered !== undefined, 'o turno continua no registro');
			assert.equal(recovered?.status, 'interrupted');
			assert.match(recovered?.reason ?? '', /encerrado antes de o turno terminar/);
			// A idade dele passou a ser de agora, então não sai por idade.
			const finished = Date.parse(recovered?.finishedAt ?? '');
			assert.ok(Number.isFinite(finished));
			assert.ok(Date.now() - finished < DAY, 'finishedAt é de agora');
		} finally {
			await stopService(root);
		}
	});

	test('os terminais antigos saem e os recentes ficam, na inicialização', async () => {
		const root = await makeRoot();
		const now = Date.now();
		const old = Array.from({ length: 5 }, (_unused, index): TurnRecord => ({
			turnId: `old-${index}`,
			conversationId: 'cnv_1',
			status: 'completed',
			startedAt: new Date(now - (60 + index) * DAY).toISOString(),
			finishedAt: new Date(now - (60 + index) * DAY).toISOString(),
		}));
		const recent = Array.from({ length: 3 }, (_unused, index): TurnRecord => ({
			turnId: `new-${index}`,
			conversationId: 'cnv_1',
			status: 'completed',
			startedAt: new Date(now - index * DAY).toISOString(),
			finishedAt: new Date(now - index * DAY).toISOString(),
		}));
		const noDate: TurnRecord = {
			turnId: 'sem-data',
			conversationId: 'cnv_1',
			status: 'failed',
			startedAt: new Date(now - 400 * DAY).toISOString(),
		};
		await seed(root, [...old, ...recent, noDate]);

		await startService(root);
		try {
			const ids = (await turnsOnDisk(root)).map((turn) => turn.turnId).sort();

			assert.deepEqual(ids, ['new-0', 'new-1', 'new-2', 'sem-data'].sort(), 'os antigos saíram; o sem data ficou');
		} finally {
			await stopService(root);
		}
	});

	test('o serviço sobe mesmo quando o registro não pode ser limpo', async () => {
		// Um `turns.json` que é um diretório: a escrita da limpeza falha, e o
		// serviço precisa continuar de pé — a retenção é manutenção.
		const root = await makeRoot();
		const { mkdir } = await import('node:fs/promises');
		await mkdir(join(root, TURNS_FILE), { recursive: true });

		const service = await startService(root);
		try {
			const health = await fetch(`http://127.0.0.1:${service.port}/api/health`, {
				headers: { 'x-seshyina-reader': 'x' },
			});
			await health.text();
			// Sem credencial válida o health é 401 — o que importa é que o
			// servidor está no ar e responde.
			assert.ok(health.status === 401 || health.status === 200);
			assert.equal((await probeService({ root })).kind, 'active');
		} finally {
			await stopService(root);
		}
	});
});
