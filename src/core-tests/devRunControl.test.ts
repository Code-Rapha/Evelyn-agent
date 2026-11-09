/**
 * DEV-9.1 — execução **controlada** do `dev_run`.
 *
 * O nome é deliberado: nada aqui prova isolamento. Prova que existe
 * aprovação por comando, limite de prazo e saída, encerramento de processos
 * filhos, motivo de encerramento correto e diário redigido. O processo
 * continua com as permissões do usuário — e é por isso que o arquivo também
 * fixa essa frase no código do produto.
 *
 * Cada caso roda contra o `DevRunner` real, num diretório temporário.
 */
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { DevRunner } from '../core/dev/devRunner';
import { InMemoryDevAudit, redactCommand } from '../core/dev/devAudit';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const roots: string[] = [];

async function makeRepo(scripts: Record<string, string> = {}): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'evelyn-d91-'));
	roots.push(root);
	execFileSync('git', ['init', '-q'], { cwd: root });
	await writeFile(
		join(root, 'package.json'),
		JSON.stringify({ name: 'fixture', version: '1.0.0', scripts }, null, 2),
		'utf8',
	);
	return root;
}

teardown(async () => {
	for (const root of roots.splice(0)) {
		await removeFixtureTree(root).catch(() => undefined);
	}
});

// ── 1. Aprovação ────────────────────────────────────────────────────────

test('sem aprovação não há execução: a recusa acontece antes do processo', async () => {
	const root = await makeRepo({ ok: 'node -e 0' });
	await writeFile(join(root, 'marca.txt'), 'antes', 'utf8');
	const seen: string[] = [];
	const runner = new DevRunner();
	await assert.rejects(
		async () =>
			await runner.run('node marca.js', root, undefined, {
				approve: async (request) => {
					seen.push(request.command);
					return 'refused';
				},
			}),
		/recusada/,
	);
	assert.deepEqual(seen, ['node marca.js'], 'a aprovação viu o comando exato');
	assert.equal(existsSync(join(root, 'marca.js')), false, 'o processo nunca rodou');
});

test('a aprovação mostra comando, diretório e escopo', async () => {
	const root = await makeRepo({ 'check-types': 'node noop.js' });
	await writeFile(join(root, 'noop.js'), 'process.exit(0);\n', 'utf8');
	let shown: { command: string; cwd: string; scope: string } | undefined;
	const runner = new DevRunner();
	await runner.run('npm run check-types', root, undefined, {
		approve: async (request) => {
			shown = request;
			return 'approved';
		},
	});
	assert.ok(shown !== undefined);
	assert.equal(shown.command, 'npm run check-types');
	assert.equal(shown.cwd.toLowerCase(), root.toLowerCase());
	assert.match(shown.scope, /check-types/);
	assert.match(shown.scope, /pode rodar qualquer código/, 'o escopo não promete mais do que garante');
});

test('cancelar antes de começar impede a execução', async () => {
	const root = await makeRepo();
	await writeFile(join(root, 'marca.js'), "require('node:fs').writeFileSync('rodou.txt','x');\n", 'utf8');
	const runner = new DevRunner();
	await assert.rejects(
		async () =>
			await runner.run('node marca.js', root, undefined, { approve: async () => 'cancelled' }),
		/cancelada/,
	);
	assert.equal(existsSync(join(root, 'rodou.txt')), false);
});

test('uma aprovação vale para um comando: o outro pergunta de novo', async () => {
	const root = await makeRepo({ 'check-types': 'node noop.js', lint: 'node noop.js' });
	await writeFile(join(root, 'noop.js'), 'process.exit(0);\n', 'utf8');
	const asked: string[] = [];
	const runner = new DevRunner();
	const approve = async (request: { command: string }) => {
		asked.push(request.command);
		return 'approved' as const;
	};
	await runner.run('npm run check-types', root, undefined, { approve });
	await runner.run('npm run lint', root, undefined, { approve });
	assert.deepEqual(asked, ['npm run check-types', 'npm run lint'], 'dois comandos, duas perguntas');
});

// ── 2. Validação ────────────────────────────────────────────────────────

test('comandos destrutivos e fora da lista são recusados antes de qualquer aprovação', async () => {
	const root = await makeRepo();
	const runner = new DevRunner();
	let asked = false;
	for (const command of [
		'rm -rf .',
		'del /f /s /q *',
		'format c:',
		'shutdown /s',
		'taskkill /f /im node.exe',
		'powershell -Command Remove-Item -Recurse C:\\',
		'npm publish',
		'npm uninstall x',
		'git reset --hard',
		'git clean -fdx',
		'curl https://exemplo.com',
		'runas /user:admin cmd',
	]) {
		await assert.rejects(
			async () =>
				await runner.run(command, root, undefined, {
					approve: async () => {
						asked = true;
						return 'approved';
					},
				}),
			(error: unknown) => {
				assert.match(String((error as Error).message), /não é|recusad|permitid/i, command);
				return true;
			},
			command,
		);
	}
	assert.equal(asked, false, 'nem chegou a perguntar');
});

test('caminho absoluto e travessia são recusados', async () => {
	const root = await makeRepo();
	const runner = new DevRunner();
	for (const command of ['node C:\\Windows\\win.ini', 'node ../../../fora.js', 'node /etc/passwd']) {
		await assert.rejects(async () => await runner.run(command, root), Error, command);
	}
});

test('o comando com encadeamento é recusado pelo interpretador de forma', async () => {
	const root = await makeRepo();
	await writeFile(join(root, 'noop.js'), 'process.exit(0);\n', 'utf8');
	const runner = new DevRunner();
	for (const command of ['node noop.js && echo x', 'node noop.js; echo x', 'node noop.js | cat', 'node noop.js > out.txt']) {
		await assert.rejects(async () => await runner.run(command, root), Error, command);
	}
});

// ── 3. Limites ──────────────────────────────────────────────────────────

test('o prazo encerra o processo e o motivo é "timeout"', async () => {
	const root = await makeRepo();
	await writeFile(join(root, 'slow.js'), 'setTimeout(() => {}, 60000);\n', 'utf8');
	const runner = new DevRunner({ timeoutMs: 800, killGraceMs: 2_000 });
	const outcome = await runner.run('node slow.js', root);
	assert.equal(outcome.aborted, true);
	assert.equal(outcome.exitCode, -1);
	assert.equal(outcome.termination, 'timeout', 'a interface precisa distinguir prazo de cancelamento');
});

test('o cancelamento encerra o processo e o motivo é "cancelled"', async () => {
	const root = await makeRepo();
	await writeFile(join(root, 'slow.js'), 'setTimeout(() => {}, 60000);\n', 'utf8');
	const controller = new AbortController();
	const runner = new DevRunner({ killGraceMs: 2_000 });
	const running = runner.run('node slow.js', root, controller.signal);
	await new Promise((resolve) => setTimeout(resolve, 500));
	controller.abort();
	const outcome = await running;
	assert.equal(outcome.termination, 'cancelled');
	assert.equal(outcome.aborted, true);
});

test('o prazo pedido não passa do teto máximo', async () => {
	const root = await makeRepo();
	await writeFile(join(root, 'noop.js'), 'process.exit(0);\n', 'utf8');
	let seenTimeout = 0;
	const runner = new DevRunner();
	await runner.run('node noop.js', root, undefined, {
		timeoutMs: 365 * 24 * 60 * 60_000,
		approve: async (request) => {
			seenTimeout = request.timeoutMs;
			return 'approved';
		},
	});
	assert.equal(seenTimeout, 60 * 60_000, 'um pedido de um ano é cortado em uma hora');
});

test('a saída acima do limite é truncada e marcada', async () => {
	const root = await makeRepo();
	await writeFile(join(root, 'barulho.js'), "process.stdout.write('x'.repeat(200000));\n", 'utf8');
	const runner = new DevRunner({ outputLimitBytes: 1_000 });
	const outcome = await runner.run('node barulho.js', root);
	assert.equal(outcome.truncated, true);
	assert.ok(Buffer.byteLength(outcome.stdout, 'utf8') <= 1_000, `saída ficou em ${outcome.stdout.length}`);
});

test('um processo filho do comando também é encerrado', async () => {
	const root = await makeRepo();
	// O filho escreve o próprio pid e dorme; o pai morre pelo prazo.
	await writeFile(
		join(root, 'pai.js'),
		[
			"const { spawn } = require('node:child_process');",
			"const fs = require('node:fs');",
			"const filho = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' });",
			"fs.writeFileSync('filho.pid', String(filho.pid));",
			'setTimeout(() => {}, 60000);',
		].join('\n'),
		'utf8',
	);
	const runner = new DevRunner({ timeoutMs: 1_500, killGraceMs: 3_000 });
	await runner.run('node pai.js', root);
	const pid = Number(await readFile(join(root, 'filho.pid'), 'utf8'));
	// `taskkill /T` alcança a árvore; o filho não pode continuar vivo.
	await new Promise((resolve) => setTimeout(resolve, 1_000));
	const alive = (() => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	})();
	assert.equal(alive, false, `o processo filho ${pid} continua vivo`);
});

test('falha ao iniciar o binário produz erro, não um sucesso falso', async () => {
	const root = await makeRepo();
	const runner = new DevRunner({ path: 'C:\\diretorio-que-nao-existe' });
	await assert.rejects(async () => await runner.run('npm test', root), /PATH|caminho/i);
});

// ── 4. Auditoria ────────────────────────────────────────────────────────

test('o diário registra comando, diretório, decisão, duração, saída e motivo', async () => {
	const root = await makeRepo();
	await writeFile(join(root, 'noop.js'), 'process.exit(3);\n', 'utf8');
	const audit = new InMemoryDevAudit();
	const runner = new DevRunner({ audit });
	await runner.run('node noop.js', root, undefined, { approve: async () => 'approved' });
	const [entry] = await audit.list();
	assert.ok(entry !== undefined);
	assert.equal(entry.command, 'node noop.js');
	assert.equal(entry.cwd.toLowerCase(), root.toLowerCase());
	assert.equal(entry.approval, 'approved');
	assert.equal(entry.exitCode, 3);
	assert.equal(entry.termination, 'exited');
	assert.ok(entry.durationMs >= 0);
	assert.ok(Number.isFinite(Date.parse(entry.startedAt)));
	assert.equal(entry.truncated, false);
});

test('uma recusa entra no diário, sem execução', async () => {
	const root = await makeRepo();
	const audit = new InMemoryDevAudit();
	const runner = new DevRunner({ audit });
	await assert.rejects(async () =>
		runner.run('node noop.js', root, undefined, { approve: async () => 'refused' }),
	);
	const [entry] = await audit.list();
	assert.ok(entry !== undefined);
	assert.equal(entry.approval, 'refused');
	assert.equal(entry.exitCode, null);
	assert.equal(entry.durationMs, 0);
});

test('o diário não guarda a saída, só o tamanho', async () => {
	const root = await makeRepo();
	await writeFile(join(root, 'segredo.js'), "process.stdout.write('TOKEN=super-secreto-123');\n", 'utf8');
	const audit = new InMemoryDevAudit();
	const runner = new DevRunner({ audit });
	await runner.run('node segredo.js', root);
	const serialized = JSON.stringify(await audit.list());
	assert.ok(!serialized.includes('super-secreto-123'), 'o conteúdo impresso não vai para o diário');
});

test('a redação esconde segredos reconhecíveis no comando', () => {
	for (const [input, mustHide] of [
		['node x.js --token=abc123', 'abc123'],
		['node x.js --password hunter2', 'hunter2'],
		['node x.js token=segredo', 'segredo'],
		['node x.js sk-live-abcdefghijklmnop', 'sk-live-abcdefghijklmnop'],
		['node x.js ghp_abcdefghijklmnopqrstuvwxyz0123', 'ghp_abcdefghijklmnopqrstuvwxyz0123'],
		['node x.js AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE'],
	] as const) {
		const redacted = redactCommand(input);
		assert.ok(!redacted.includes(mustHide), `${input} → ${redacted}`);
	}
	assert.equal(redactCommand('node noop.js'), 'node noop.js', 'um comando comum fica intacto');
});
