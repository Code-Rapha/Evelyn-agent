/**
 * DEV-2.3: `write_file` na trava compartilhada entre processos.
 *
 * ## O que se prova, e como
 *
 * `write_file` roda no workspace do projeto da conversa, que pode ser a raiz
 * do repositório da Evelyn, uma subpasta dele — ou nenhum repositório. Estes
 * testes usam **processos reais** para a exclusão mútua (um mock não prova
 * nada sobre o sistema de arquivos) e arquivos reais para o resto.
 *
 * O caso "fora de repositório" não é decoração: é o uso normal do agente num
 * diretório qualquer, e continua sem trava, sem espera e sem erro.
 */
import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMvpAgentStack } from '../core/agent/composition';
import { acquireDevLock, canonicalRoot, DEV_LOCK_FILE } from '../core/dev/devFileLock';
import { DevSession } from '../core/dev/devSession';
import { DevCheckpointStore } from '../core/dev/devCheckpoint';
import { DevRunner } from '../core/dev/devRunner';
import { DevLocks } from '../core/dev/devLocks';
import { createDevTools, type DevToolDeps } from '../core/agent/devTools';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const HELPER = join(__dirname, 'helpers', 'devLockHelper.js');
const roots: string[] = [];
const children: ReturnType<typeof spawn>[] = [];

async function makeRoot(prefix = 'evelyn-dev23-'): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	roots.push(root);
	return root;
}

async function makeRepo(): Promise<string> {
	const root = await makeRoot('evelyn-dev23-repo-');
	// `git init` de verdade: o teste de "detalhe dentro do repositório" depende
	// de o Git reconhecer a raiz.
	const child = spawn('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
	await new Promise((resolve) => child.on('exit', resolve));
	return root;
}

function startHelper(root: string, holdMs: number): { readonly child: ReturnType<typeof spawn>; readonly done: Promise<string> } {
	const child = spawn(process.execPath, [HELPER, root, String(holdMs)], {
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
	});
	children.push(child);
	let output = '';
	child.stdout?.setEncoding('utf8');
	child.stderr?.setEncoding('utf8');
	child.stdout?.on('data', (chunk: string) => (output += chunk));
	child.stderr?.on('data', (chunk: string) => (output += chunk));
	const done = new Promise<string>((resolve) => child.on('exit', () => resolve(output.trim())));
	return { child, done };
}

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

/** O `write_file` do stack real, com workspace no diretório dado. */
function writeFileTool(waitMs: number) {
	const stack = createMvpAgentStack({ crossProcessWaitMs: waitMs });
	const tool = stack.registry.get('write_file');
	assert.notEqual(tool, undefined);
	return { tool: tool as NonNullable<typeof tool>, dispose: stack.dispose };
}

/** O `dev_write`, com a sessão no repositório dado. */
async function devWriteTool(repo: string, waitMs = 300) {
	const data = await makeRoot('evelyn-dev23-data-');
	const session = new DevSession({ repositoryRoot: repo });
	const checkpoints = new DevCheckpointStore(join(data, 'dev'));
	await checkpoints.init();
	const deps: DevToolDeps = {
		session,
		checkpoints,
		runner: new DevRunner({ timeoutMs: 5_000 }),
		locks: new DevLocks(),
		crossProcessWaitMs: waitMs,
	};
	const tools = new Map(createDevTools(deps).map((tool) => [tool.descriptor.name, tool]));
	await session.enter();
	return { tool: tools.get('dev_write') as NonNullable<ReturnType<typeof tools.get>>, session };
}

teardown(async () => {
	for (const child of children.splice(0)) {
		child.kill('SIGKILL');
	}
	for (const root of roots.splice(0)) {
		await removeFixtureTree(root).catch(() => undefined);
	}
});

suite('DEV-2.3: write_file na trava do repositório', () => {
	test('escreve normalmente quando ninguém está com a trava', async () => {
		const repo = await makeRepo();
		const { tool, dispose } = writeFileTool(1_000);
		try {
			const result = await tool.execute(
				{ path: 'nota.txt', content: 'olá\n' },
				{ sessionId: 'test', workingDirectory: repo },
			);

			assert.equal(result.ok, true, result.error);
			assert.equal(await readFile(join(repo, 'nota.txt'), 'utf8'), 'olá\n');
			// E a trava saiu com a escrita.
			assert.equal(existsSync(join(await canonicalRoot(repo), DEV_LOCK_FILE)), false);
		} finally {
			dispose();
		}
	});

	test('é RECUSADO enquanto outro PROCESSO mantém a trava', async () => {
		const repo = await makeRepo();
		const { tool, dispose } = writeFileTool(250);
		const holder = startHelper(repo, 2_500);
		try {
			await waitForLine(holder.child, 'acquired');

			const result = await tool.execute(
				{ path: 'bloqueado.txt', content: 'x' },
				{ sessionId: 'test', workingDirectory: repo },
			);

			assert.equal(result.ok, false, 'não deveria escrever com outro processo na trava');
			assert.match(result.error ?? '', /em uso|outro/);
			assert.equal(existsSync(join(repo, 'bloqueado.txt')), false, 'nada foi escrito');
		} finally {
			await holder.done;
			dispose();
		}
	});

	test('escreve depois que o outro processo libera', async () => {
		const repo = await makeRepo();
		const { tool, dispose } = writeFileTool(3_000);
		const holder = startHelper(repo, 500);
		try {
			await waitForLine(holder.child, 'acquired');

			const result = await tool.execute(
				{ path: 'depois.txt', content: 'ok' },
				{ sessionId: 'test', workingDirectory: repo },
			);

			assert.equal(result.ok, true, result.error);
			assert.equal(await readFile(join(repo, 'depois.txt'), 'utf8'), 'ok');
		} finally {
			await holder.done;
			dispose();
		}
	});

	test('um workspace DENTRO do repositório usa a mesma trava da raiz', async () => {
		const repo = await makeRepo();
		const sub = join(repo, 'src', 'inner');
		await mkdir(sub, { recursive: true });
		// O outro processo trava a RAIZ do repositório.
		const holder = startHelper(repo, 2_500);
		const { tool, dispose } = writeFileTool(250);
		try {
			await waitForLine(holder.child, 'acquired');

			const result = await tool.execute({ path: 'a.ts', content: 'x' }, { sessionId: 'test', workingDirectory: sub });

			assert.equal(result.ok, false, 'a subpasta pertence à mesma raiz e deveria colidir');
			assert.equal(existsSync(join(sub, 'a.ts')), false);
		} finally {
			await holder.done;
			dispose();
		}
	});

	test('um caminho alternativo (com `..`) usa a mesma trava', async () => {
		const repo = await makeRepo();
		const decoy = await makeRoot();
		const holder = startHelper(repo, 2_500);
		const { tool, dispose } = writeFileTool(250);
		try {
			await waitForLine(holder.child, 'acquired');

			// O workspace é escrito com um caminho que sobe e volta — dentro.
			const oddWorkspace = join(repo, '..', repo.split(/[\\/]/).pop() as string);
			const result = await tool.execute({ path: 'b.txt', content: 'x' }, { sessionId: 'test', workingDirectory: oddWorkspace });

			assert.equal(result.ok, false);
			assert.equal(existsSync(join(repo, 'b.txt')), false);
		} finally {
			await holder.done;
			dispose();
			void decoy;
		}
	});

	test('dois processos não escrevem ao mesmo tempo pelas ferramentas', async () => {
		const repo = await makeRepo();
		// Este processo pega a trava sem espera — é o "outro escritor".
		const mine = await acquireDevLock(repo);
		assert.equal(mine.kind, 'acquired');
		const { tool, dispose } = writeFileTool(200);
		try {
			const result = await tool.execute({ path: 'z.txt', content: 'z' }, { sessionId: 'test', workingDirectory: repo });
			assert.equal(result.ok, false);
			assert.equal(existsSync(join(repo, 'z.txt')), false);
		} finally {
			if (mine.kind === 'acquired') {
				await mine.lock.release();
			}
			dispose();
		}
	});

	test('dev_write é recusado enquanto write_file mantém a trava', async () => {
		const repo = await makeRepo();
		const { tool: common, dispose } = writeFileTool(1_000);
		const dev = await devWriteTool(repo, 250);

		// `write_file` mantém a trava durante a escrita: para observar a janela,
		// segura-se a trava como o `write_file` faria e chama-se o DEV no meio.
		const held = await acquireDevLock(repo);
		try {
			assert.equal(held.kind, 'acquired');
			const result = await dev.tool.execute({ path: 'dev.txt', content: 'x' }, { sessionId: 'test' });
			assert.equal(result.ok, false, 'o DEV deveria ser recusado com a trava tomada');
			assert.match(result.error ?? '', /outro processo|em uso/);
			assert.equal(existsSync(join(repo, 'dev.txt')), false);
		} finally {
			if (held.kind === 'acquired') {
				await held.lock.release();
			}
			await dev.session.exit();
			dispose();
			void common;
		}
	});

	test('depois de write_file terminar, dev_write passa', async () => {
		const repo = await makeRepo();
		const { tool: common, dispose } = writeFileTool(1_000);
		const dev = await devWriteTool(repo, 1_000);
		try {
			await common.execute({ path: 'um.txt', content: '1' }, { sessionId: 'test', workingDirectory: repo });
			const result = await dev.tool.execute({ path: 'dois.txt', content: '2' }, { sessionId: 'test' });

			assert.equal(result.ok, true, result.error);
			assert.equal(await readFile(join(repo, 'dois.txt'), 'utf8'), '2');
		} finally {
			await dev.session.exit();
			dispose();
		}
	});
});

suite('DEV-2.3: liberação e falhas', () => {
	test('uma falha de escrita libera a trava', async () => {
		const repo = await makeRepo();
		const { tool, dispose } = writeFileTool(500);
		try {
			// O destino é um diretório: `writeFile` falha com `EISDIR`.
			await mkdir(join(repo, 'pasta'));
			const failed = await tool.execute({ path: 'pasta', content: 'x' }, { sessionId: 'test', workingDirectory: repo });
			assert.equal(failed.ok, false);

			// E a próxima escrita funciona: a trava não ficou presa.
			const after = await tool.execute({ path: 'ok.txt', content: 'ok' }, { sessionId: 'test', workingDirectory: repo });
			assert.equal(after.ok, true, after.error);
			assert.equal(existsSync(join(await canonicalRoot(repo), DEV_LOCK_FILE)), false);
		} finally {
			dispose();
		}
	});

	test('o prazo esgotado não deixa trava residual', async () => {
		const repo = await makeRepo();
		const holder = startHelper(repo, 2_000);
		const { tool, dispose } = writeFileTool(150);
		try {
			await waitForLine(holder.child, 'acquired');
			const result = await tool.execute({ path: 'x.txt', content: 'x' }, { sessionId: 'test', workingDirectory: repo });
			assert.equal(result.ok, false);
		} finally {
			await holder.done;
			dispose();
		}
		// Quem nunca adquiriu não libera a de outro, e a do holder sumiu com ele.
		assert.equal(existsSync(join(await canonicalRoot(repo), DEV_LOCK_FILE)), false);
		const free = await acquireDevLock(repo);
		assert.equal(free.kind, 'acquired');
		if (free.kind === 'acquired') {
			await free.lock.release();
		}
	});

	test('a ferramenta não informa sucesso antes de a escrita terminar', async () => {
		const repo = await makeRepo();
		const { tool, dispose } = writeFileTool(1_000);
		try {
			const result = await tool.execute({ path: 'conteudo.txt', content: 'final' }, { sessionId: 'test', workingDirectory: repo });

			assert.equal(result.ok, true);
			// O arquivo está completo no disco no instante do retorno.
			assert.equal(await readFile(join(repo, 'conteudo.txt'), 'utf8'), 'final');
			// E a trava já foi liberada nesse ponto.
			assert.equal(existsSync(join(await canonicalRoot(repo), DEV_LOCK_FILE)), false);
		} finally {
			dispose();
		}
	});
});

suite('DEV-2.3: fora de um repositório Git', () => {
	test('escrita em workspace que não é repositório continua funcionando, sem trava', async () => {
		const plain = await makeRoot('evelyn-dev23-plain-');
		const { tool, dispose } = writeFileTool(50);
		try {
			const result = await tool.execute(
				{ path: 'arquivo.txt', content: 'sem git' },
				{ sessionId: 'test', workingDirectory: plain },
			);

			assert.equal(result.ok, true, result.error);
			assert.equal(await readFile(join(plain, 'arquivo.txt'), 'utf8'), 'sem git');
			// Nenhuma trava foi criada no diretório.
			assert.equal(existsSync(join(plain, DEV_LOCK_FILE)), false);
		} finally {
			dispose();
		}
	});

	test('o workspace fora do Git não espera o prazo da trava', async () => {
		const plain = await makeRoot('evelyn-dev23-plain-');
		const { tool, dispose } = writeFileTool(30_000);
		try {
			const started = Date.now();
			const result = await tool.execute({ path: 'rapido.txt', content: 'x' }, { sessionId: 'test', workingDirectory: plain });
			const elapsed = Date.now() - started;

			assert.equal(result.ok, true, result.error);
			// Sem repositório não há trava a esperar: a escrita é imediata.
			assert.ok(elapsed < 2_000, `levou ${elapsed}ms`);
		} finally {
			dispose();
		}
	});

	test('a validação de caminho do Workspace continua valendo', async () => {
		const repo = await makeRepo();
		const { tool, dispose } = writeFileTool(500);
		try {
			const escape = await tool.execute({ path: '../fora.txt', content: 'x' }, { sessionId: 'test', workingDirectory: repo });
			assert.equal(escape.ok, false);
			// Nada foi criado ao lado do repositório.
			assert.equal(await readFile(join(repo, '..', 'fora.txt'), 'utf8').catch(() => undefined), undefined);
		} finally {
			dispose();
		}
	});
});

suite('DEV-2.3: escrita com conteúdo inválido', () => {
	test('conteúdo vazio é recusado como antes (argString)', async () => {
		const repo = await makeRepo();
		const { tool, dispose } = writeFileTool(500);
		try {
			const result = await tool.execute(
				{ path: 'vazio.txt', content: '' },
				{ sessionId: 'test', workingDirectory: repo },
			);
			assert.equal(result.ok, false);
		} finally {
			dispose();
		}
	});

	test('workspace ausente continua sendo erro claro', async () => {
		const { tool, dispose } = writeFileTool(500);
		try {
			const result = await tool.execute({ path: 'x.txt', content: 'x' }, { sessionId: 'test' });
			assert.equal(result.ok, false);
			assert.match(result.error ?? '', /workspace/);
		} finally {
			dispose();
		}
	});
});
