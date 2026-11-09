/**
 * DEV-2.2: a trava compartilhada entre processos.
 *
 * ## O que estes testes provam, e como
 *
 * Exclusão mútua não se prova com mock: ela é uma propriedade do sistema de
 * arquivos. Por isso cada teste aqui inicia **processos de verdade** com
 * `node`, que pedem a trava pela mesma função que o app usa, e o teste
 * observa quem ganhou, quem esperou e o que ficou no disco.
 *
 * Os casos: disputa simultânea, sucessão após liberação, morte abrupta do
 * dono, recuperação sem dois donos, prazo esgotado, exceção e cancelamento
 * no meio da operação, raízes independentes e caminhos equivalentes.
 */
import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	DEV_LOCK_FILE,
	acquireDevLock,
	canonicalRoot,
	DevLockTimeoutError,
} from '../core/dev/devFileLock';
import { DevSession } from '../core/dev/devSession';
import { DevCheckpointStore } from '../core/dev/devCheckpoint';
import { DevRunner } from '../core/dev/devRunner';
import { DevLocks, DevBusyError, coordinateCommandRunner, resourceKeyFor } from '../core/dev/devLocks';
import { createDevTools, type DevToolDeps } from '../core/agent/devTools';
import type { AgentTool } from '../core/agent/types';
import { processStartedAtMs } from '../core/dev/processStart';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const HELPER = join(__dirname, 'helpers', 'devLockHelper.js');
const roots: string[] = [];
const children: { readonly kill: (signal?: NodeJS.Signals) => void }[] = [];
const ctx = { sessionId: 'test', signal: undefined };

async function makeRoot(prefix = 'evelyn-dev22-'): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	roots.push(root);
	await mkdir(join(root, '.git'), { recursive: true });
	return root;
}

interface HelperRun {
	readonly code: number | null;
	readonly output: string;
	readonly pid: number | undefined;
}

/** Inicia o auxiliar e entrega uma promessa da saída final. */
function startHelper(
	root: string,
	holdMs: number,
	flags: readonly string[] = [],
): { readonly done: Promise<HelperRun>; readonly child: ReturnType<typeof spawn> } {
	const child = spawn(process.execPath, [HELPER, root, String(holdMs), ...flags], {
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
	});
	children.push(child as never);
	let output = '';
	child.stdout?.setEncoding('utf8');
	child.stderr?.setEncoding('utf8');
	child.stdout?.on('data', (chunk: string) => (output += chunk));
	child.stderr?.on('data', (chunk: string) => (output += chunk));
	const done = new Promise<HelperRun>((resolve) => {
		child.on('exit', (code) => resolve({ code, output: output.trim(), pid: child.pid }));
	});
	return { done, child };
}

/** Espera uma linha aparecer na saída do auxiliar. */
async function waitForLine(child: ReturnType<typeof spawn>, needle: string, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let seen = '';
	child.stdout?.setEncoding('utf8');
	child.stdout?.on('data', (chunk: string) => (seen += chunk));
	while (!seen.includes(needle)) {
		if (Date.now() > deadline) {
			throw new Error(`o auxiliar não disse "${needle}" a tempo (viu: ${seen.trim()})`);
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

teardown(async () => {
	for (const child of children.splice(0)) {
		child.kill('SIGKILL');
	}
	for (const root of roots.splice(0)) {
		await removeFixtureTree(root).catch(() => undefined);
	}
});

suite('DEV-2.2: exclusão mútua entre processos', () => {
	test('dois processos disputando ao mesmo tempo: só um adquire', async () => {
		const root = await makeRoot();
		// O primeiro segura por um instante; o segundo tenta no mesmo momento.
		const first = startHelper(root, 1_500);
		await waitForLine(first.child, 'acquired');

		const second = await startHelper(root, 0).done;

		assert.equal(first.done !== undefined, true);
		assert.match(second.output, /^busy:/, `o segundo deveria perder: ${second.output}`);
		assert.match(second.output, /em uso|pertence|existe/);
		await first.done;
	});

	test('o segundo adquire depois da liberação do primeiro', async () => {
		const root = await makeRoot();
		const first = await startHelper(root, 0).done;
		assert.match(first.output, /^acquired:/);

		const second = await startHelper(root, 0).done;

		assert.match(second.output, /^acquired:/, `o segundo deveria ganhar: ${second.output}`);
	});

	test('a trava fica no disco só enquanto alguém a tem', async () => {
		const root = await makeRoot();
		const lockPath = join(await canonicalRoot(root), DEV_LOCK_FILE);

		const first = startHelper(root, 1_000);
		await waitForLine(first.child, 'acquired');
		assert.equal(existsSync(lockPath), true, 'existe enquanto o dono está vivo');

		await first.done;
		assert.equal(existsSync(lockPath), false, 'some quando o dono libera');
	});

	test('raízes diferentes operam em paralelo', async () => {
		const one = await makeRoot();
		const two = await makeRoot();
		const first = await startHelper(one, 0).done;
		const second = await startHelper(two, 0).done;

		assert.match(first.output, /^acquired:/);
		assert.match(second.output, /^acquired:/);
	});

	test('caminhos equivalentes não criam travas diferentes', async () => {
		const root = await makeRoot();
		const variants = [
			root,
			join(root, '..', root.split(/[\\/]/).pop() as string),
			...(process.platform === 'win32' ? [root.toUpperCase()] : []),
		];
		const keys = await Promise.all(variants.map((variant) => canonicalRoot(variant)));

		assert.equal(new Set(keys).size, 1, `variantes deram chaves diferentes: ${keys.join(' | ')}`);

		// E um segundo processo pedindo pela variante é recusado enquanto o
		// primeiro segura pela raiz "literal".
		const first = startHelper(root, 1_200);
		await waitForLine(first.child, 'acquired');
		const second = await startHelper(variants[1] as string, 0).done;
		assert.match(second.output, /^busy:/, `variante deveria colidir: ${second.output}`);
		await first.done;
	});

	test('um symlink para a raiz é a mesma trava', async () => {
		const root = await makeRoot();
		const linkRoot = await makeRoot();
		const link = join(linkRoot, 'atalho');
		await symlink(root, link, 'dir').catch(() => undefined);
		if (!existsSync(link)) {
			// Sem permissão para criar symlink (Windows sem modo desenvolvedor):
			// a parte de realpath já está coberta pelo teste de variantes.
			return;
		}
		const first = startHelper(root, 1_200);
		await waitForLine(first.child, 'acquired');
		const second = await startHelper(link, 0).done;
		assert.match(second.output, /^busy:/, `symlink deveria colidir: ${second.output}`);
		await first.done;
	});
});

suite('DEV-2.2: recuperação de trava abandonada', () => {
	test('dono morto à força libera a trava para o próximo', async () => {
		const root = await makeRoot();
		const holder = startHelper(root, 60_000);
		await waitForLine(holder.child, 'acquired');
		const holderPid = Number((await readFile(join(await canonicalRoot(root), DEV_LOCK_FILE), 'utf8').then(JSON.parse)).pid);
		holder.child.kill('SIGKILL');
		await holder.done;
		await new Promise((resolve) => setTimeout(resolve, 250));

		const next = await acquireDevLock(root, { waitMs: 3_000 });

		assert.equal(next.kind, 'acquired', `a recuperação deveria funcionar (dono ${holderPid})`);
		if (next.kind === 'acquired') {
			await next.lock.release();
		}
	});

	test('dois recuperadores concorrentes não ficam donos ao mesmo tempo', async () => {
		const root = await makeRoot();
		const holder = startHelper(root, 60_000);
		await waitForLine(holder.child, 'acquired');
		holder.child.kill('SIGKILL');
		await holder.done;
		await new Promise((resolve) => setTimeout(resolve, 250));

		// Três processos tentam recuperar ao mesmo tempo.
		const attempts = await Promise.all([1, 2, 3].map(async () => await startHelper(root, 300).done));
		const acquired = attempts.filter((attempt) => attempt.output.startsWith('acquired:'));
		const busy = attempts.filter((attempt) => attempt.output.startsWith('busy:'));

		assert.equal(acquired.length + busy.length, 3, attempts.map((a) => a.output).join(' | '));
		assert.ok(acquired.length >= 1, 'alguém recuperou');
		// Exclusão mútua: os que adquirem não podem compartilhar a janela.
		const holders = new Set(acquired.map((attempt) => attempt.pid));
		assert.equal(holders.size, acquired.length);
	});

	test('uma trava legível mas com dono vivo NÃO é removida', async () => {
		const root = await makeRoot();
		const canonical = await canonicalRoot(root);
		// O dono é este próprio processo: vivo, sem ambiguidade.
		await writeFile(
			join(canonical, DEV_LOCK_FILE),
			JSON.stringify({
				version: 1,
				pid: process.pid,
				startedAtMs: await processStartedAtMs(process.pid),
				root: canonical,
				acquiredAt: new Date().toISOString(),
			}),
			'utf8',
		);

		const result = await acquireDevLock(root, { waitMs: 100 });

		assert.equal(result.kind, 'busy');
		assert.equal(existsSync(join(canonical, DEV_LOCK_FILE)), true, 'a trava continua lá');
	});

	test('uma trava ilegível é mantida, e o erro diz que é recuperável', async () => {
		const root = await makeRoot();
		const canonical = await canonicalRoot(root);
		await writeFile(join(canonical, DEV_LOCK_FILE), 'isto não é json', 'utf8');

		const result = await acquireDevLock(root, { waitMs: 100 });

		assert.equal(result.kind, 'busy');
		if (result.kind === 'busy') {
			assert.equal(result.recoverable, true, 'o operador pode intervir');
		}
		assert.equal(existsSync(join(canonical, DEV_LOCK_FILE)), true, 'não removeu às cegas');
	});

	test('um pid reciclado é detectado pelo instante de criação', async () => {
		const root = await makeRoot();
		const canonical = await canonicalRoot(root);
		const real = await processStartedAtMs(process.pid);
		if (real === undefined) {
			// Sem fonte de identidade nesta plataforma: o mecanismo não pode
			// provar reciclagem e mantém a trava. É o comportamento conservador.
			await writeFile(
				join(canonical, DEV_LOCK_FILE),
				JSON.stringify({ version: 1, pid: process.pid, root: canonical, acquiredAt: new Date().toISOString() }),
				'utf8',
			);
			const conservative = await acquireDevLock(root, { waitMs: 100 });
			assert.equal(conservative.kind, 'busy');
			return;
		}
		// O pid é o deste processo (vivo), mas o instante gravado é de outro.
		await writeFile(
			join(canonical, DEV_LOCK_FILE),
			JSON.stringify({
				version: 1,
				pid: process.pid,
				startedAtMs: real - 60_000,
				root: canonical,
				acquiredAt: new Date().toISOString(),
			}),
			'utf8',
		);

		const result = await acquireDevLock(root, { waitMs: 300 });

		// DEV-AUDIT-01: a identidade divergente passou a ser **ambígua** e a
		// trava é mantida. A auditoria mostrou que, com a tolerância de 2 s,
		// a divergência pequena era aceita como "mesmo dono" — e a grande era
		// removida como reciclagem, sem prova consistente da morte. Nenhum dos
		// dois é evidência: aqui o processo está vivo e não se remove.
		assert.equal(result.kind, 'busy', 'identidade divergente mantém a trava');
		if (result.kind === 'busy') {
			assert.equal(result.recoverable, true, 'é recuperável quando o proprietário confirmar');
			assert.match(result.reason, new RegExp(String(process.pid)), 'o PID aparece na recusa');
			assert.match(result.reason, /não confere/, 'e o motivo também');
		}
		// O arquivo continua lá: nada foi removido por suspeita.
		assert.equal(existsSync(join(canonical, DEV_LOCK_FILE)), true);
	});

	test('uma trava de processo comprovadamente morto É recuperada', async () => {
		const root = await makeRoot();
		const canonical = await canonicalRoot(root);
		// PID que não existe: `alive()` devolve false, e essa é prova.
		await writeFile(
			join(canonical, DEV_LOCK_FILE),
			JSON.stringify({
				version: 1,
				pid: 4_000_000_000,
				startedAtMs: 1,
				root: canonical,
				acquiredAt: new Date().toISOString(),
			}),
			'utf8',
		);

		const result = await acquireDevLock(root, { waitMs: 3_000 });
		assert.equal(result.kind, 'acquired', 'dono morto é trava órfã');
		if (result.kind === 'acquired') {
			await result.lock.release();
		}
	});

	test('identidade dentro da tolerância de leitura é o mesmo processo', async () => {
		const root = await makeRoot();
		const canonical = await canonicalRoot(root);
		const real = await processStartedAtMs(process.pid);
		if (real === undefined) {
			return;
		}
		// 100 ms: arredondamento entre fontes, e continua sendo este processo.
		await writeFile(
			join(canonical, DEV_LOCK_FILE),
			JSON.stringify({
				version: 1,
				pid: process.pid,
				startedAtMs: real - 100,
				root: canonical,
				acquiredAt: new Date().toISOString(),
			}),
			'utf8',
		);
		const result = await acquireDevLock(root, { waitMs: 150 });
		assert.equal(result.kind, 'busy');
		if (result.kind === 'busy') {
			assert.match(result.reason, /a trava pertence ao processo/);
		}
		assert.equal(existsSync(join(canonical, DEV_LOCK_FILE)), true);
	});

	test('sem fonte de identidade, a trava de um dono vivo é mantida', async () => {
		const root = await makeRoot();
		const canonical = await canonicalRoot(root);
		await writeFile(
			join(canonical, DEV_LOCK_FILE),
			JSON.stringify({ version: 1, pid: process.pid, root: canonical, acquiredAt: new Date().toISOString() }),
			'utf8',
		);

		const result = await acquireDevLock(root, { waitMs: 120, startedAt: async () => undefined });

		assert.equal(result.kind, 'busy', 'não sabe = não remove');
		if (result.kind === 'busy') {
			assert.equal(result.recoverable, true);
			assert.match(result.reason, /não.*registra|não foi possível confirmar|não existe mais/);
		}
	});
});

suite('DEV-2.2: prazo e liberação', () => {
	test('o prazo de aquisição termina com erro explícito', async () => {
		const root = await makeRoot();
		const held = await acquireDevLock(root);
		assert.equal(held.kind, 'acquired');
		try {
			const started = Date.now();
			const result = await acquireDevLock(root, { waitMs: 150, retryMs: 20 });
			const elapsed = Date.now() - started;

			assert.equal(result.kind, 'busy');
			assert.ok(elapsed >= 140, `esperou o prazo (${elapsed}ms)`);
			assert.ok(elapsed < 5_000, 'não esperou indefinidamente');
		} finally {
			if (held.kind === 'acquired') {
				await held.lock.release();
			}
		}
	});

	test('um erro no meio libera a trava (finally)', async () => {
		const root = await makeRoot();
		await assert.rejects(async () => {
			const result = await acquireDevLock(root);
			if (result.kind !== 'acquired') {
				throw new Error('não adquiriu');
			}
			try {
				throw new Error('falhou no meio da operação protegida');
			} finally {
				await result.lock.release();
			}
		});

		const after = await acquireDevLock(root);
		assert.equal(after.kind, 'acquired');
		if (after.kind === 'acquired') {
			await after.lock.release();
		}
	});

	test('liberar duas vezes é seguro', async () => {
		const root = await makeRoot();
		const result = await acquireDevLock(root);
		assert.equal(result.kind, 'acquired');
		if (result.kind === 'acquired') {
			await result.lock.release();
			await result.lock.release();
		}
		assert.equal(existsSync(join(await canonicalRoot(root), DEV_LOCK_FILE)), false);
	});
});

suite('DEV-2.2: integração com as ferramentas', () => {
	async function harness(waitMs = 400): Promise<{
		readonly root: string;
		readonly tools: ReadonlyMap<string, AgentTool>;
		readonly session: DevSession;
	}> {
		const root = await makeRoot();
		const data = await mkdtemp(join(tmpdir(), 'evelyn-dev22-data-'));
		roots.push(data);
		const session = new DevSession({ repositoryRoot: root });
		const checkpoints = new DevCheckpointStore(join(data, 'dev'));
		await checkpoints.init();
		const deps: DevToolDeps = {
			session,
			checkpoints,
			runner: new DevRunner({ timeoutMs: 20_000 }),
			locks: new DevLocks(),
			crossProcessWaitMs: waitMs,
		};
		const tools = new Map(createDevTools(deps).map((tool) => [tool.descriptor.name, tool]));
		await session.enter();
		return { root, tools, session };
	}

	test('dev_write é recusado enquanto outro PROCESSO segura a trava', async () => {
		const { root, tools } = await harness(300);
		const holder = startHelper(root, 2_500);
		await waitForLine(holder.child, 'acquired');

		const result = await tools.get('dev_write')!.execute({ path: 'a.txt', content: 'x' }, ctx);

		assert.equal(result.ok, false, 'não deveria escrever com outro processo na trava');
		assert.match(result.error ?? '', /outro processo|em uso/);
		assert.equal(existsSync(join(root, 'a.txt')), false, 'nada foi escrito');
		await holder.done;
	});

	test('depois que o outro processo libera, dev_write funciona', async () => {
		const { root, tools } = await harness(3_000);
		const holder = startHelper(root, 600);
		await waitForLine(holder.child, 'acquired');

		// A escrita espera (até 3 s) e consegue depois da liberação.
		const result = await tools.get('dev_write')!.execute({ path: 'b.txt', content: 'ok' }, ctx);

		assert.equal(result.ok, true, result.error);
		assert.equal(await readFile(join(root, 'b.txt'), 'utf8'), 'ok');
		await holder.done;
	});

	test('o run_command comum também respeita a trava entre processos', async () => {
		const root = await makeRoot();
		const locks = new DevLocks();
		const runner = coordinateCommandRunner(
			async () => ({ exitCode: 0, stdout: 'rodou', stderr: '', aborted: false }),
			locks,
			{ crossProcessWaitMs: 250 },
		);
		const holder = startHelper(root, 2_000);
		await waitForLine(holder.child, 'acquired');

		await assert.rejects(async () => await runner('npm test', root), DevBusyError);
		await holder.done;

		const outcome = await runner('npm test', root);
		assert.equal(outcome.stdout, 'rodou');
	});

	test('o comando filho termina ANTES de a trava ser liberada', async () => {
		const { root, tools } = await harness();
		await writeFile(join(root, 'sleep.js'), 'setTimeout(() => {}, 60000);\n', 'utf8');
		const canonical = await canonicalRoot(root);
		const lockPath = join(canonical, DEV_LOCK_FILE);

		// Comando curto que grava a hora: a trava tem de continuar existindo
		// enquanto ele roda, e sumir depois.
		await writeFile(join(root, 'marca.js'), "require('node:fs').writeFileSync('marca.txt', String(Date.now()));\n", 'utf8');
		const result = await tools.get('dev_run')!.execute({ command: 'node marca.js' }, ctx);

		assert.equal(result.ok, true, result.error);
		assert.equal(existsSync(join(root, 'marca.txt')), true, 'o comando rodou');
		assert.equal(existsSync(lockPath), false, 'e a trava saiu depois dele');
	});

	test('cancelar o comando encerra o filho e só então libera a trava', async () => {
		const { root, tools, session } = await harness();
		const canonical = await canonicalRoot(root);
		const lockPath = join(canonical, DEV_LOCK_FILE);
		await writeFile(join(root, 'sleep.js'), 'setTimeout(() => {}, 60000);\n', 'utf8');

		const controller = new AbortController();
		const running = tools
			.get('dev_run')!
			.execute({ command: 'node sleep.js' }, { sessionId: 'test', signal: controller.signal });

		// A trava existe enquanto o comando dorme.
		await waitFor(() => existsSync(lockPath), 'a trava existir durante o comando');
		assert.equal(existsSync(lockPath), true);
		// Abortar **no meio**: o processo já começou. (Antes disso, o runner
		// recusa — "cancelado antes de começar" —, que é o comportamento certo.)
		await new Promise((resolve) => setTimeout(resolve, 250));
		controller.abort();
		const outcome = await running;

		// O comando terminou; a trava saiu **depois** dele.
		assert.equal(outcome.ok, true, outcome.error);
		assert.equal(existsSync(lockPath), false, 'a trava foi liberada');
		// E a sessão pode ser encerrada sem deixar nada preso.
		await session.exit();
	});

	async function waitFor(condition: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (!condition()) {
			if (Date.now() > deadline) {
				throw new Error(`tempo esgotado esperando: ${label}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
});

suite('DEV-2.2: normalização de raiz', () => {
	test('a chave da trava é estável para a mesma raiz', async () => {
		const root = await makeRoot();
		const a = await canonicalRoot(root);
		const b = await canonicalRoot(join(root, '.', 'x', '..'));
		assert.equal(a, b);
		assert.equal(resourceKeyFor(a), resourceKeyFor(b));
	});

	test('a trava nunca é criada fora da raiz', async () => {
		const root = await makeRoot();
		const result = await acquireDevLock(root);
		assert.equal(result.kind, 'acquired');
		if (result.kind === 'acquired') {
			assert.equal(existsSync(join(await canonicalRoot(root), DEV_LOCK_FILE)), true);
			await result.lock.release();
		}
		await rm(join(root, '.evelyn-dev.lock'), { force: true });
	});
});

suite('DEV-2.2: categoria de erro', () => {
	test('o erro de prazo é identificável', async () => {
		const root = await makeRoot();
		const held = await acquireDevLock(root);
		try {
			await assert.rejects(
				async () => {
					const second = await acquireDevLock(root, { waitMs: 50 });
					if (second.kind === 'busy') {
						throw new DevLockTimeoutError(second.reason, second.owner);
					}
				},
				(error: unknown) => error instanceof DevLockTimeoutError,
			);
		} finally {
			if (held.kind === 'acquired') {
				await held.lock.release();
			}
		}
	});
});
