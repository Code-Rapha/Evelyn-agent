/**
 * DEV-2.1: endurecimento do núcleo DEV.
 *
 * ## O que estes testes exercitam de verdade
 *
 * - **Leitura**: arquivos reais no disco, com 0 byte, exatamente o limite e
 *   acima dele; binário real; caractere multibyte cortado no limite.
 * - **Caminhos protegidos**: nomes reais criados no repositório, com variação
 *   de caixa (que no Windows abre o mesmo arquivo) e tentativas por `..` e
 *   symlink.
 * - **Concorrência**: dois comandos reais no mesmo diretório disputando a
 *   trava, com sucesso, recusa por prazo e liberação após falha.
 * - **Encerramento**: processo real que dorme e é morto; conferência de que o
 *   pid deixou de existir.
 */
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DevSession } from '../core/dev/devSession';
import { DevCheckpointStore } from '../core/dev/devCheckpoint';
import { DevRunner, taskkillExitCodes } from '../core/dev/devRunner';
import {
	DevBusyError,
	DevLocks,
	coordinateCommandRunner,
	resourceKeyFor,
} from '../core/dev/devLocks';
import { classifyPath } from '../core/dev/devPolicy';
import { DEV_READ_LIMIT_BYTES, readDevFile } from '../core/dev/devRead';
import { createDevTools, type DevToolDeps } from '../core/agent/devTools';
import type { AgentTool } from '../core/agent/types';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const roots: string[] = [];
const ctx = { sessionId: 'test', signal: undefined };

async function makeRepo(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'evelyn-dev21-'));
	roots.push(root);
	execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
	return root;
}

async function makeData(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'evelyn-dev21-data-'));
	roots.push(root);
	return root;
}

teardown(async () => {
	for (const root of roots.splice(0)) {
		await removeFixtureTree(root).catch(() => undefined);
	}
});

async function harness(): Promise<{
	readonly repo: string;
	readonly session: DevSession;
	readonly tools: ReadonlyMap<string, AgentTool>;
	readonly deps: DevToolDeps;
}> {
	const repo = await makeRepo();
	const data = await makeData();
	const session = new DevSession({ repositoryRoot: repo });
	const checkpoints = new DevCheckpointStore(join(data, 'dev'));
	await checkpoints.init();
	const deps: DevToolDeps = { session, checkpoints, runner: new DevRunner({ timeoutMs: 20_000 }), locks: new DevLocks() };
	const tools = new Map(createDevTools(deps).map((tool) => [tool.descriptor.name, tool]));
	return { repo, session, tools, deps };
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

suite('DEV-2.1: limite de leitura', () => {
	test('arquivo vazio é lido como vazio, não como erro', async () => {
		const repo = await makeRepo();
		const path = join(repo, 'vazio.txt');
		await writeFile(path, '', 'utf8');

		const read = await readDevFile(path);

		assert.equal(read.ok, true);
		if (read.ok) {
			assert.equal(read.content, '');
			assert.equal(read.truncated, false);
			assert.equal(read.totalBytes, 0);
		}
	});

	test('arquivo exatamente no limite é lido inteiro, sem truncar', async () => {
		const repo = await makeRepo();
		const path = join(repo, 'exato.txt');
		const limit = 1024;
		await writeFile(path, 'a'.repeat(limit), 'utf8');

		const read = await readDevFile(path, { limitBytes: limit });

		assert.equal(read.ok, true);
		if (read.ok) {
			assert.equal(read.content.length, limit);
			assert.equal(read.truncated, false);
		}
	});

	test('um byte acima do limite é RECUSADO, e não vem conteúdo parcial', async () => {
		const repo = await makeRepo();
		const path = join(repo, 'acima.txt');
		const limit = 1024;
		await writeFile(path, 'b'.repeat(limit + 1), 'utf8');

		const read = await readDevFile(path, { limitBytes: limit });

		assert.equal(read.ok, false);
		if (!read.ok) {
			assert.match(read.error, /acima do limite/);
		}
	});

	test('com `partial`, o conteúdo vem e diz que está truncado', async () => {
		const repo = await makeRepo();
		const path = join(repo, 'grande.txt');
		await writeFile(path, 'c'.repeat(5000), 'utf8');

		const read = await readDevFile(path, { limitBytes: 1024, allowTruncation: true });

		assert.equal(read.ok, true);
		if (read.ok) {
			assert.equal(read.truncated, true);
			assert.equal(read.content.length, 1024);
			assert.equal(read.totalBytes, 5000);
		}
	});

	test('corte no meio de um caractere multibyte não devolve lixo', async () => {
		const repo = await makeRepo();
		const path = join(repo, 'acentos.txt');
		// "é" ocupa 2 bytes: um limite ímpar corta no meio dele.
		await writeFile(path, 'aéaéaé', 'utf8');

		const read = await readDevFile(path, { limitBytes: 3, allowTruncation: true });

		assert.equal(read.ok, true);
		if (read.ok) {
			assert.equal(read.content, 'aé');
			assert.equal(read.truncated, true);
		}
	});

	test('arquivo binário é recusado', async () => {
		const repo = await makeRepo();
		const path = join(repo, 'imagem.bin');
		await writeFile(path, Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));

		const read = await readDevFile(path);

		assert.equal(read.ok, false);
		if (!read.ok) {
			assert.match(read.error, /binário/);
		}
	});

	test('UTF-8 inválido (sem truncamento) é recusado', async () => {
		const repo = await makeRepo();
		const path = join(repo, 'invalido.txt');
		await writeFile(path, Buffer.from([0x61, 0xff, 0xfe, 0x62]));

		const read = await readDevFile(path);

		assert.equal(read.ok, false);
	});

	test('um diretório não é lido como arquivo', async () => {
		const repo = await makeRepo();
		await mkdir(join(repo, 'pasta'));

		const read = await readDevFile(join(repo, 'pasta'));

		assert.equal(read.ok, false);
	});

	test('o limite do modo DEV é explícito e finito', () => {
		assert.equal(Number.isInteger(DEV_READ_LIMIT_BYTES), true);
		assert.ok(DEV_READ_LIMIT_BYTES > 0 && DEV_READ_LIMIT_BYTES <= 1024 * 1024);
	});

	test('a ferramenta recusa o arquivo grande e não devolve o conteúdo', async () => {
		const { repo, session, tools } = await harness();
		await writeFile(join(repo, 'enorme.txt'), 'x'.repeat(DEV_READ_LIMIT_BYTES + 10), 'utf8');
		await session.enter();

		const result = await tools.get('dev_read')!.execute({ path: 'enorme.txt' }, ctx);

		assert.equal(result.ok, false);
		assert.equal(result.output, undefined);
	});
});

suite('DEV-2.1: caminhos protegidos', () => {
	test('a política cobre segredos comuns e não bloqueia configuração legítima', () => {
		for (const path of [
			'.env',
			'.env.local',
			'.env.production',
			'service.json',
			'secrets.json',
			'credentials.json',
			'certs/server.pem',
			'certs/private.key',
			'id_rsa',
			'api.secret.json',
		]) {
			assert.equal(classifyPath(path).protected, true, path);
		}
		for (const path of [
			'package.json',
			'tsconfig.json',
			'tsconfig.desktop.json',
			'.env.example',
			'src/env.ts',
			'config/router-config.json',
			'README.md',
		]) {
			assert.equal(classifyPath(path).protected, false, path);
		}
	});

	test('variação de caixa não contorna (Windows não distingue)', () => {
		for (const path of ['SECRETS.JSON', 'Secrets.Json', '.ENV', 'Certs/Server.PEM']) {
			assert.equal(classifyPath(path).protected, true, path);
		}
	});

	test('a ferramenta recusa ler e escrever um caminho protegido', async () => {
		const { repo, session, tools } = await harness();
		await writeFile(join(repo, '.env'), 'API_KEY=segredo\n', 'utf8');
		await writeFile(join(repo, 'Secrets.JSON'), '{"k":"v"}', 'utf8');
		await session.enter();

		for (const path of ['.env', 'Secrets.JSON']) {
			const read = await tools.get('dev_read')!.execute({ path }, ctx);
			assert.equal(read.ok, false, `leitura de ${path}`);
			assert.match(read.error ?? '', /protegido/);
		}
		const write = await tools.get('dev_write')!.execute({ path: '.env', content: 'API_KEY=trocado\n' }, ctx);
		assert.equal(write.ok, false);
		assert.equal(await readFile(join(repo, '.env'), 'utf8'), 'API_KEY=segredo\n');

		// O exemplo não é protegido: o desenvolvimento precisa dele.
		await writeFile(join(repo, '.env.example'), 'API_KEY=\n', 'utf8');
		const example = await tools.get('dev_read')!.execute({ path: '.env.example' }, ctx);
		assert.equal(example.ok, true, example.error);
	});

	test('`..` e symlink não contornam a política', async () => {
		const { repo, session, tools } = await harness();
		const outside = await makeData();
		await writeFile(join(outside, 'secrets.json'), '{"k":"v"}', 'utf8');
		await symlink(outside, join(repo, 'fora'), 'dir').catch(() => undefined);
		await session.enter();

		// `..` até o arquivo proibido do lado de fora: recusado pelo Workspace.
		const parent = await tools.get('dev_read')!.execute({ path: '../secrets.json' }, ctx);
		assert.equal(parent.ok, false);
		// Symlink para fora: recusado pelo Workspace antes da política.
		const viaLink = await tools.get('dev_read')!.execute({ path: 'fora/secrets.json' }, ctx);
		assert.equal(viaLink.ok, false);
		// Mesmo nome protegido dentro: recusado pela política.
		await writeFile(join(repo, 'secrets.json'), '{}', 'utf8');
		const inside = await tools.get('dev_read')!.execute({ path: 'secrets.json' }, ctx);
		assert.equal(inside.ok, false);
		assert.match(inside.error ?? '', /protegido/);
	});
});

suite('DEV-2.1: coordenação', () => {
	test('dois donos do mesmo recurso não correm juntos', async () => {
		const locks = new DevLocks();
		const key = resourceKeyFor('G:\\repo');
		const order: string[] = [];

		const first = await locks.acquire(key);
		const second = locks.acquire(key).then((release) => {
			order.push('segundo');
			release();
		});
		order.push('primeiro');
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.deepEqual(order, ['primeiro'], 'o segundo ainda espera');
		first();
		await second;
		assert.deepEqual(order, ['primeiro', 'segundo']);
	});

	test('raízes diferentes não se bloqueiam', async () => {
		const locks = new DevLocks();
		const a = await locks.acquire(resourceKeyFor('G:\\um'));
		const b = await locks.acquire(resourceKeyFor('G:\\dois'), 50);
		b();
		a();
	});

	test('quem espera além do prazo é recusado — nunca fica preso', async () => {
		const locks = new DevLocks();
		const key = resourceKeyFor('G:\\repo');
		const release = await locks.acquire(key);

		await assert.rejects(async () => await locks.acquire(key, 60), DevBusyError);
		release();
		// Depois da recusa, a trava volta a estar disponível.
		const again = await locks.acquire(key, 60);
		again();
	});

	test('uma falha no dono libera a trava (finally)', async () => {
		const locks = new DevLocks();
		const key = resourceKeyFor('G:\\repo');

		await assert.rejects(async () => {
			const release = await locks.acquire(key);
			try {
				throw new Error('falhou no meio');
			} finally {
				release();
			}
		});
		assert.equal(locks.isHeld(key), false);
		assert.equal(locks.pending(key), 0);
	});

	test('o decorador do run_command comum usa a mesma trava do DEV', async () => {
		const locks = new DevLocks();
		const cwd = 'G:\\repo';
		let ran = false;
		const runner = coordinateCommandRunner(
			async () => {
				ran = true;
				return { exitCode: 0, stdout: '', stderr: '', aborted: false };
			},
			locks,
			{ waitMs: 60 },
		);
		// O DEV está com a trava do repositório: o comando comum espera e é
		// recusado em vez de rodar no meio da escrita.
		const held = await locks.acquire(resourceKeyFor(cwd));
		await assert.rejects(async () => await runner('npm test', cwd), DevBusyError);
		assert.equal(ran, false);
		held();
		const outcome = await runner('npm test', cwd);
		assert.equal(outcome.exitCode, 0);
		assert.equal(ran, true);
	});

	test('dev_write e dev_run no mesmo repositório se sucedem, não se atropelam', async () => {
		const { repo, session, tools } = await harness();
		await writeFile(join(repo, 'package.json'), '{}', 'utf8');
		await session.enter();

		// Dispara escrita e comando juntos: a trava serializa.
		const [written, ran] = await Promise.all([
			tools.get('dev_write')!.execute({ path: 'a.txt', content: 'a' }, ctx),
			tools.get('dev_run')!.execute({ command: 'git status' }, ctx),
		]);

		assert.equal(written.ok, true, written.error);
		assert.equal(ran.ok, true, ran.error);
	});
});

suite('DEV-2.1: encerramento de processo', () => {
	test('o prazo encerra o processo e ele deixa de existir', async () => {
		const repo = await makeRepo();
		await writeFile(join(repo, 'sleep.js'), 'setTimeout(() => {}, 60000);\n', 'utf8');
		const runner = new DevRunner({ timeoutMs: 500, killGraceMs: 4_000 });

		const outcome = await runner.run('node sleep.js', repo);

		assert.equal(outcome.aborted, true);
		assert.equal(outcome.abortWarning, undefined, 'o processo morreu');
	});

	test('o encerramento não depende de o taskkill dar certo sozinho (Windows)', async () => {
		// Em qualquer plataforma: o processo morre, e o registro do código de
		// saída do taskkill é diagnóstico — não o critério.
		const repo = await makeRepo();
		await writeFile(join(repo, 'sleep.js'), 'setTimeout(() => {}, 60000);\n', 'utf8');
		const runner = new DevRunner({ timeoutMs: 400, killGraceMs: 4_000 });

		const outcome = await runner.run('node sleep.js', repo);

		assert.equal(outcome.aborted, true);
		if (process.platform === 'win32') {
			// O taskkill foi de fato tentado: há um código registrado para algum pid.
			assert.ok(taskkillExitCodes.size > 0, 'taskkill foi chamado');
		}
	});

	test('cancelar pelo runner encerra o processo', async () => {
		const repo = await makeRepo();
		await writeFile(join(repo, 'sleep.js'), 'setTimeout(() => {}, 60000);\n', 'utf8');
		const runner = new DevRunner({ timeoutMs: 60_000, killGraceMs: 4_000 });

		const running = runner.run('node sleep.js', repo);
		await new Promise((resolve) => setTimeout(resolve, 200));
		runner.cancelRunning();
		const outcome = await running;

		assert.equal(outcome.aborted, true);
		assert.equal(runner.isRunning(), false);
	});

	test('um processo real fica morto depois do encerramento (pid conferido)', async () => {
		const repo = await makeRepo();
		await writeFile(join(repo, 'sleep.js'), 'setTimeout(() => {}, 60000);\n', 'utf8');
		const runner = new DevRunner({ timeoutMs: 60_000, killGraceMs: 4_000 });

		const running = runner.run('node sleep.js', repo);
		await new Promise((resolve) => setTimeout(resolve, 250));
		// O pid do filho, para conferir a morte dele mesmo.
		const childPid = (runner as unknown as { running?: { pid?: number } }).running?.pid;
		assert.equal(typeof childPid, 'number');
		runner.cancelRunning();
		const outcome = await running;
		await new Promise((resolve) => setTimeout(resolve, 200));

		assert.equal(outcome.aborted, true);
		assert.equal(alive(childPid as number), false, 'o processo filho morreu');
	});
});
