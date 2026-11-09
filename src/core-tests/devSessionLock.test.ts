/**
 * DEV — regressão: o `run_command` comum dentro de uma sessão DEV ativa.
 *
 * ## O defeito reproduzido
 *
 * O host toma a trava do repositório **por sessão** (`claimSessionLock`). As
 * ferramentas DEV pedem a trava por `acquireDevLockForSession`, que sabe
 * emprestar. O `run_command` comum, decorado por `coordinateCommandRunner`,
 * chamava `acquireDevLock` cru — sem o registro de empréstimo — e era recusado
 * com "o repositório está em uso por outro processo (a trava pertence ao
 * processo <o próprio PID>)".
 *
 * A mensagem era verdadeira sobre o arquivo e falsa sobre a causa: não havia
 * outro processo, e a trava não era órfã. Apagar o arquivo teria sido pior.
 *
 * ## O que estes testes protegem
 *
 * - O comando **roda** quando a sessão DEV deste processo é a dona.
 * - Qualquer outro caso continua coordenado: outro dono recusa, o prazo vale,
 *   e a trava só é liberada de verdade quando o último empréstimo sai.
 * - Nada de "remover trava válida": a trava da sessão continua no disco
 *   enquanto ela existe.
 */
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	DEV_LOCK_FILE,
	acquireDevLock,
	acquireDevLockForRoot,
	claimSessionLock,
	releaseSessionLock,
} from '../core/dev/devFileLock';
import { DevBusyError, DevLocks, coordinateCommandRunner, resourceKeyFor } from '../core/dev/devLocks';
import { processStartedAtMs } from '../core/dev/processStart';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const roots: string[] = [];

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'evelyn-devsession-'));
	roots.push(root);
	// `.git` faz o diretório ser um repositório para quem sobe procurando a raiz.
	await mkdir(join(root, '.git'), { recursive: true });
	return root;
}

/** Um runner que executa de verdade, para provar que o comando correu. */
function realRunner(root: string) {
	return async (command: string) => {
		const out = execFileSync(process.platform === 'win32' ? 'cmd.exe' : 'sh', [
			process.platform === 'win32' ? '/c' : '-c',
			command,
		], { cwd: root, encoding: 'utf8' });
		return { exitCode: 0, stdout: out, stderr: '', aborted: false };
	};
}

teardown(async () => {
	for (const root of roots.splice(0)) {
		await removeFixtureTree(root).catch(() => undefined);
	}
});

suite('DEV: o run_command dentro da sessão dona', () => {
	test('reprodução: a sessão DEV dona da raiz não impede o run_command', async () => {
		const root = await makeRoot();
		const session = { nome: 'sessão-dev' };
		await claimSessionLock(root, session, { token: 'tok-repro' });

		const runner = coordinateCommandRunner(realRunner(root), new DevLocks(), {
			crossProcessWaitMs: 300,
		});

		// Antes da correção isto lançava `DevBusyError` dizendo "em uso por
		// outro processo", citando o pid deste mesmo processo.
		const outcome = await runner('echo rodou', root);
		assert.equal(outcome.exitCode, 0);
		assert.match(outcome.stdout, /rodou/);

		// A trava da sessão continua no lugar: o comando não a removeu.
		assert.equal(existsSync(join(root, DEV_LOCK_FILE)), true, 'a trava da sessão é preservada');

		await releaseSessionLock(root, session);
		assert.equal(existsSync(join(root, DEV_LOCK_FILE)), false, 'e só sai quando a sessão sai');
	});

	test('duas operações simultâneas na sessão dona se serializam, sem recusa', async () => {
		const root = await makeRoot();
		const session = { nome: 'sessão-2' };
		await claimSessionLock(root, session, { token: 'tok-2' });

		let running = 0;
		let maxRunning = 0;
		const runner = coordinateCommandRunner(
			async () => {
				running += 1;
				maxRunning = Math.max(maxRunning, running);
				await new Promise((resolve) => setTimeout(resolve, 60));
				running -= 1;
				return { exitCode: 0, stdout: '', stderr: '', aborted: false };
			},
			new DevLocks(),
			{ waitMs: 5_000, crossProcessWaitMs: 5_000 },
		);

		// Disparadas juntas, como um `run_command` e um `dev_run` de uma tarefa.
		const results = await Promise.all([
			runner('a', root),
			runner('b', root),
			runner('c', root),
		]);

		assert.deepEqual(results.map((result) => result.exitCode), [0, 0, 0]);
		assert.equal(maxRunning, 1, 'nunca duas operações ao mesmo tempo no mesmo repositório');

		await releaseSessionLock(root, session);
	});

	test('o empréstimo é contado: a sessão saindo no meio NÃO solta a trava em uso', async () => {
		const root = await makeRoot();
		const session = { nome: 'sessão-3' };
		await claimSessionLock(root, session, { token: 'tok-3' });

		const loan = await acquireDevLockForRoot(root);
		assert.equal(loan.kind, 'acquired');

		// A sessão sai **com um empréstimo ativo**: a trava não pode virar livre
		// para outro processo enquanto a operação dele ainda escreve.
		await releaseSessionLock(root, session);
		assert.equal(existsSync(join(root, DEV_LOCK_FILE)), true, 'a trava segue no disco');

		// Outro dono continua recusado enquanto o empréstimo existe.
		const other = await acquireDevLock(root, { waitMs: 0 });
		assert.equal(other.kind, 'busy');

		if (loan.kind === 'acquired') {
			await loan.lock.release();
		}
		// Só agora a trava some — o último empréstimo era o que faltava.
		assert.equal(existsSync(join(root, DEV_LOCK_FILE)), false);
	});

	test('sem sessão dona, o decorador continua recusando outra trava viva', async () => {
		const root = await makeRoot();
		// Uma trava tomada sem sessão: não há dono de quem emprestar.
		const held = await acquireDevLock(root);
		assert.equal(held.kind, 'acquired');

		let ran = false;
		const runner = coordinateCommandRunner(
			async () => {
				ran = true;
				return { exitCode: 0, stdout: '', stderr: '', aborted: false };
			},
			new DevLocks(),
			{ crossProcessWaitMs: 120 },
		);

		await assert.rejects(async () => runner('npm test', root), DevBusyError);
		assert.equal(ran, false, 'o comando não rodou sem a trava');

		if (held.kind === 'acquired') {
			await held.lock.release();
		}
		const after = await runner('npm test', root);
		assert.equal(after.exitCode, 0);
		assert.equal(ran, true, 'e roda depois que ela é liberada');
	});

	test('a recusa nomeia o processo dono, e a trava viva NÃO é apagada', async () => {
		const root = await makeRoot();
		// Um dono **de verdade** e vivo: o próprio processo deste teste, com a
		// identidade que o arquivo exige (pid + instante de criação). Um PID
		// inventado seria órfão — e aí a recuperação é o comportamento correto,
		// não a recusa.
		const startedAtMs = await processStartedAtMs(process.pid);
		await writeFile(
			join(root, DEV_LOCK_FILE),
			JSON.stringify({
				version: 1,
				pid: process.pid,
				startedAtMs,
				root,
				acquiredAt: new Date().toISOString(),
			}),
			'utf8',
		);

		let ran = false;
		const runner = coordinateCommandRunner(
			async () => {
				ran = true;
				return { exitCode: 0, stdout: '', stderr: '', aborted: false };
			},
			new DevLocks(),
			{ crossProcessWaitMs: 80 },
		);

		await assert.rejects(
			async () => runner('npm test', root),
			(error: unknown) => {
				assert.ok(error instanceof DevBusyError);
				assert.match(error.message, new RegExp(String(process.pid)), 'o PID do dono aparece');
				return true;
			},
		);
		assert.equal(ran, false);
		// E o arquivo **não** foi removido: o dono está vivo.
		assert.equal(existsSync(join(root, DEV_LOCK_FILE)), true, 'trava de dono vivo nunca é apagada');
	});

	test('uma trava de processo morto É recuperada — nunca fica presa para sempre', async () => {
		const root = await makeRoot();
		// Um dono que comprovadamente não existe: PID altíssimo, sem identidade
		// legível de processo. É a "trava órfã" legítima.
		await writeFile(
			join(root, DEV_LOCK_FILE),
			JSON.stringify({
				version: 1,
				pid: 4_000_000_000,
				root,
				acquiredAt: new Date().toISOString(),
			}),
			'utf8',
		);

		const runner = coordinateCommandRunner(
			async () => ({ exitCode: 0, stdout: 'rodou', stderr: '', aborted: false }),
			new DevLocks(),
			{ crossProcessWaitMs: 500 },
		);
		const outcome = await runner('npm test', root);
		assert.equal(outcome.stdout, 'rodou', 'a trava órfã foi recuperada e o comando correu');
	});

	test('a trava liberada pelo último uso deixa o repositório livre de verdade', async () => {
		const root = await makeRoot();
		const session = { nome: 'sessão-4' };
		await claimSessionLock(root, session, { token: 'tok-4' });

		const runner = coordinateCommandRunner(realRunner(root), new DevLocks(), {
			crossProcessWaitMs: 300,
		});
		await runner('echo um', root);
		await runner('echo dois', root);

		await releaseSessionLock(root, session);
		const free = await acquireDevLock(root);
		assert.equal(free.kind, 'acquired');
		if (free.kind === 'acquired') {
			await free.lock.release();
		}
	});

	test('uma falha no meio do comando devolve o erro e libera a trava', async () => {
		const root = await makeRoot();
		const session = { nome: 'sessão-5' };
		await claimSessionLock(root, session, { token: 'tok-5' });

		const runner = coordinateCommandRunner(
			async () => {
				throw new Error('o comando explodiu');
			},
			new DevLocks(),
			{ crossProcessWaitMs: 300 },
		);

		await assert.rejects(async () => runner('npm test', root), /explodiu/);
		// O empréstimo voltou: uma segunda execução não encontra a raiz
		// ocupada por um uso que já terminou.
		const again = coordinateCommandRunner(
			async () => ({ exitCode: 0, stdout: 'ok', stderr: '', aborted: false }),
			new DevLocks(),
			{ crossProcessWaitMs: 300 },
		);
		const outcome = await again('npm test', root);
		assert.equal(outcome.stdout, 'ok');

		await releaseSessionLock(root, session);
	});

	test('duas raízes diferentes não se bloqueiam', async () => {
		const a = await makeRoot();
		const b = await makeRoot();
		const sessionA = { nome: 'sessão-a' };
		await claimSessionLock(a, sessionA, { token: 'tok-a' });

		const runner = coordinateCommandRunner(realRunner(b), new DevLocks(), {
			crossProcessWaitMs: 300,
		});
		// A raiz `b` não é da sessão de `a`: a trava dela é livre.
		const outcome = await runner('echo outra', b);
		assert.match(outcome.stdout, /outra/);

		await releaseSessionLock(a, sessionA);
	});

	test('a trava emprestada continua sendo do mesmo dono (não troca de identidade)', async () => {
		const root = await makeRoot();
		const session = { nome: 'sessão-6' };
		const held = await claimSessionLock(root, session, { token: 'tok-6' });
		const before = await readFile(join(root, DEV_LOCK_FILE), 'utf8');

		const loan = await acquireDevLockForRoot(root);
		assert.equal(loan.kind, 'acquired');
		if (loan.kind === 'acquired') {
			assert.equal(loan.lock.owner.token, 'tok-6', 'o empréstimo herda a identidade da sessão');
			await loan.lock.release();
		}
		const after = await readFile(join(root, DEV_LOCK_FILE), 'utf8');
		assert.equal(after, before, 'o arquivo não é reescrito por um empréstimo');
		assert.equal(held.owner.token, 'tok-6');

		await releaseSessionLock(root, session);
	});

	test('a chave da trava local normaliza caixa e separador final', () => {
		// `resourceKeyFor` só tira a barra final e baixa a caixa no Windows: o
		// separador interno não é convertido, e dois caminhos com separadores
		// diferentes seguem sendo chaves diferentes. É o suficiente porque o
		// `cwd` vem do mesmo resolvedor nas duas visões — registrado aqui para
		// que a expectativa não seja mais generosa que o código.
		assert.equal(resourceKeyFor('G:\\Repo\\'), resourceKeyFor('g:\\repo'));
		assert.equal(resourceKeyFor('G:\\Repo\\'), 'g:\\repo');
	});
});
