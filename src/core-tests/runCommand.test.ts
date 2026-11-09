/**
 * DEV-10 — dois defeitos medidos enquanto a agente trabalhava no próprio
 * código.
 *
 * Diferente dos outros testes destas ferramentas, aqui os processos são
 * **reais**: o defeito do `run_command` só existia na execução de verdade, e
 * um runner falso (como o dos testes de `createRunCommandTool`) nunca o veria.
 */
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRunCommandTool, defaultCommandRunner, splitCommandLine } from '../core/agent/mvpTools';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const roots: string[] = [];

teardown(async () => {
	for (const root of roots.splice(0)) {
		await removeFixtureTree(root).catch(() => undefined);
	}
});

async function makeRepo(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'evelyn-dev10-'));
	roots.push(root);
	execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
	return root;
}

suite('DEV-10: `run_command` executa uma linha de comando, não um nome de programa', () => {
	// O defeito: `spawn(command, { shell: false })` procurava um programa com o
	// nome inteiro — `spawn node --version ENOENT`. Só o binário puro rodava, e
	// a agente concluiu (com razão) que a ferramenta não aceitava argumentos.
	test('a linha é dividida em programa e argumentos', () => {
		assert.deepEqual(splitCommandLine('node --version'), { file: 'node', args: ['--version'] });
		assert.deepEqual(splitCommandLine('git status'), { file: 'git', args: ['status'] });
		assert.deepEqual(splitCommandLine('  node   -e   x  '), { file: 'node', args: ['-e', 'x'] });
		assert.deepEqual(splitCommandLine('node'), { file: 'node', args: [] });
	});

	test('aspas mantêm um argumento com espaço inteiro', () => {
		assert.deepEqual(splitCommandLine('git -C "meu diretório" status'), {
			file: 'git',
			args: ['-C', 'meu diretório', 'status'],
		});
		assert.deepEqual(splitCommandLine("git -C 'meu diretório' status"), {
			file: 'git',
			args: ['-C', 'meu diretório', 'status'],
		});
	});

	test('uma linha vazia é recusada', () => {
		assert.throws(() => splitCommandLine('   '), /vazi|empty/i);
	});

	// Execução real: é o caso que estava quebrado.
	test('`git status` roda de verdade e devolve a saída', async () => {
		const root = await makeRepo();
		const outcome = await defaultCommandRunner('git status', root);
		assert.equal(outcome.exitCode, 0);
		assert.match(outcome.stdout, /branch|Branch/i);
	});

	test('argumentos chegam ao programa (os espaços não viram parte do nome)', async () => {
		const root = await makeRepo();
		// `node --version` é curto e não depende do repositório.
		const outcome = await defaultCommandRunner('node --version', root);
		assert.equal(outcome.exitCode, 0);
		assert.match(outcome.stdout, /^v\d+\./);
	});

	test('um programa que não existe falha com mensagem clara, não ENOENT cru', async () => {
		const root = await makeRepo();
		await assert.rejects(
			async () => await defaultCommandRunner('programa-que-nao-existe-abc --x', root),
			/nao|não|PATH/i,
		);
	});
});

suite('DEV-10: com o DEV ativo, `run_command` não escreve no repositório', () => {
	// O caso medido: a agente editou um arquivo com um script por `run_command`,
	// contornando o `dev_write`. Sem checkpoint, sem operação no diário, e o
	// `reload-ui` não teve o que aplicar.
	test('sessão ativa: recusa com o caminho correto na mensagem', async () => {
		let executou = false;
		const tool = createRunCommandTool(
			async () => {
				executou = true;
				return { exitCode: 0, stdout: '', stderr: '', aborted: false };
			},
			{ devSession: { isActive: () => true } },
		);
		const root = await makeRepo();
		const context = {
			workingDirectory: root,
			signal: undefined,
		} as unknown as Parameters<typeof tool.execute>[1];

		const result = await tool.execute({ command: 'node --version' }, context);

		assert.equal(result.ok, false);
		assert.equal(executou, false, 'nada foi executado');
		assert.match(result.ok ? '' : (result.error ?? ''), /checkpoint/);
		assert.match(result.ok ? '' : (result.error ?? ''), /dev_edit/);
	});

	test('sessão inativa: executa normalmente', async () => {
		let executou = false;
		const tool = createRunCommandTool(
			async () => {
				executou = true;
				return { exitCode: 0, stdout: 'ok', stderr: '', aborted: false };
			},
			{ devSession: { isActive: () => false } },
		);
		const root = await makeRepo();
		const context = {
			workingDirectory: root,
			signal: undefined,
		} as unknown as Parameters<typeof tool.execute>[1];

		const result = await tool.execute({ command: 'node --version' }, context);

		assert.equal(result.ok, true);
		assert.equal(executou, true);
	});
});

