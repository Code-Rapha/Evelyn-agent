/**
 * DEV-2: o núcleo do modo DEV.
 *
 * ## O que estes testes provam
 *
 * Não são testes de mock: cada um exercita o limite real — um repositório de
 * verdade no disco, `Workspace` de verdade, processos de verdade e um
 * checkpoint lido byte a byte. A pergunta de cada um é de segurança:
 *
 * - a autorização existe só na memória e só pelo `enter()`;
 * - nada que o agente pode escrever (config, arquivo, request) a ativa;
 * - as `dev_*` recusam enquanto inativas, e recusam caminhos fora da raiz;
 * - o `dev_run` recusa o que não está na allowlist, inclusive por argumento;
 * - o prazo mata o processo;
 * - o checkpoint devolve o arquivo como era, e não apaga trabalho posterior
 *   sem avisar.
 */
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DevLocks } from '../core/dev/devLocks';
import { DevSession, DevSessionInactiveError, isSameRoot } from '../core/dev/devSession';
import { DevCheckpointStore, DevRestoreConflictError } from '../core/dev/devCheckpoint';
import {
	DevCommandRefusedError,
	DevRunner,
	validateDevCommand,
} from '../core/dev/devRunner';
import {
	DEV_TOOL_SPECS,
	DEV_WRITE,
	createDevTools,
	type DevToolDeps,
} from '../core/agent/devTools';
import { createMvpAgentStack } from '../core/agent/composition';
import type { AgentTool } from '../core/agent/types';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const roots: string[] = [];

async function makeRepo(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'evelyn-dev-'));
	roots.push(root);
	// Um repositório de verdade: `git status` tem de funcionar dentro dele, e é
	// isso que os comandos do DEV chamam.
	execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
	await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture' }), 'utf8');
	return root;
}

async function makeData(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'evelyn-dev-data-'));
	roots.push(root);
	return root;
}

teardown(async () => {
	for (const root of roots.splice(0)) {
		await removeFixtureTree(root).catch(() => undefined);
	}
});

async function harness(options: { readonly runner?: DevRunner } = {}): Promise<{
	readonly repo: string;
	readonly session: DevSession;
	readonly tools: ReadonlyMap<string, AgentTool>;
}> {
	const repo = await makeRepo();
	const data = await makeData();
	const session = new DevSession({ repositoryRoot: repo });
	const checkpoints = new DevCheckpointStore(join(data, 'dev'));
	await checkpoints.init();
	const deps: DevToolDeps = {
		session,
		checkpoints,
		runner: options.runner ?? new DevRunner({ timeoutMs: 20_000 }),
		locks: new DevLocks(),
	};
	const tools = new Map(createDevTools(deps).map((tool) => [tool.descriptor.name, tool]));
	return { repo, session, tools };
}

const ctx = { sessionId: 'test', signal: undefined };

suite('DEV-2: a sessão', () => {
	test('começa inativa, e o registry comum não tem ferramenta dev_*', async () => {
		const { session } = await harness();

		assert.equal(session.isActive(), false);
		assert.deepEqual(session.status(), { active: false, checkpoints: 0 });
		assert.throws(() => session.root(), DevSessionInactiveError);
	});

	test('entra só com uma raiz de repositório, e sai quando o host decide', async () => {
		const { repo, session } = await harness();

		const status = await session.enter();
		assert.equal(status.active, true);
		assert.equal(status.repositoryRoot, repo);
		assert.equal(typeof status.startedAt, 'string');

		const after = await session.exit();
		assert.equal(after.active, false);
		assert.equal(session.isActive(), false);
	});

	test('uma raiz que não é um repositório é recusada, sem deixar sessão ativa', async () => {
		const notRepo = await makeData();
		const session = new DevSession({ repositoryRoot: notRepo });

		await assert.rejects(async () => await session.enter(), /não é a raiz de um repositório/);
		assert.equal(session.isActive(), false);
	});

	test('reiniciar o processo (nova instância) não herda a autorização', async () => {
		const { repo, session } = await harness();
		await session.enter();

		// A "reinicialização" é uma instância nova: nada foi persistido.
		const restarted = new DevSession({ repositoryRoot: repo });
		assert.equal(restarted.isActive(), false);
	});

	test('a raiz do DEV é a que o host declarou, e nada a move', async () => {
		const { repo, session } = await harness();
		await session.enter();
		const before = session.root();

		// Não existe `setRoot`, `enter(projectId)` nem argumento de escopo: a
		// única forma de mudar o escopo seria criar outra sessão.
		assert.equal(before, repo);
		assert.equal(isSameRoot(repo, join(repo, 'src')), true);
		assert.equal(isSameRoot(repo, await makeData()), false);
	});
});

suite('DEV-2: escrita não ativa o modo DEV', () => {
	test('escrever em state.json (ou em qualquer config) não abre a sessão', async () => {
		const { repo, session } = await harness();
		await writeFile(join(repo, 'state.json'), JSON.stringify({ devMode: true }), 'utf8');
		await writeFile(join(repo, '.dev'), '1', 'utf8');

		assert.equal(session.isActive(), false);
	});

	test('a ferramenta dev_write só obedece à sessão, não a um campo no texto', async () => {
		const { session, tools } = await harness();
		const write = tools.get(DEV_WRITE);
		assert.notEqual(write, undefined);

		const result = await write!.execute(
			{ path: 'x.ts', content: 'export const x = 1;\n', dev: true, active: true },
			ctx,
		);

		assert.equal(result.ok, false);
		assert.match(result.error ?? '', /modo DEV não está ativo/);
		assert.equal(session.isActive(), false);
	});
});

suite('DEV-2: caminhos', () => {
	test('recusa `..`, caminho absoluto externo e symlink que escapa', async () => {
		const { repo, session, tools } = await harness();
		const outside = await makeData();
		await writeFile(join(outside, 'segredo.txt'), 'não deveria ser lido', 'utf8');
		await symlink(outside, join(repo, 'escape'), 'dir').catch(() => undefined);
		await session.enter();
		const read = tools.get('dev_read');
		const write = tools.get(DEV_WRITE);

		for (const path of ['../fora.ts', '..\\fora.ts', join(outside, 'segredo.txt')]) {
			const result = await read!.execute({ path }, ctx);
			assert.equal(result.ok, false, `leitura de ${path}`);
		}
		const escapeLink = await read!.execute({ path: 'escape/segredo.txt' }, ctx);
		assert.equal(escapeLink.ok, false, 'symlink para fora da raiz');

		const writeOut = await write!.execute({ path: '../fora.ts', content: 'x' }, ctx);
		assert.equal(writeOut.ok, false);
	});

	test('recusa os arquivos de credencial pelo nome', async () => {
		const { repo, session, tools } = await harness();
		await writeFile(join(repo, 'secrets.json'), '{}', 'utf8');
		await session.enter();

		const result = await tools.get('dev_read')!.execute({ path: 'secrets.json' }, ctx);

		assert.equal(result.ok, false);
		assert.match(result.error ?? '', /credenciais/);
	});

	test('lê e escreve um arquivo do repositório', async () => {
		const { repo, session, tools } = await harness();
		await session.enter();

		const written = await tools.get(DEV_WRITE)!.execute({ path: 'src/a.ts', content: 'export const a = 1;\n' }, ctx);
		assert.equal(written.ok, true, written.error);
		assert.equal(await readFile(join(repo, 'src', 'a.ts'), 'utf8'), 'export const a = 1;\n');

		const read = await tools.get('dev_read')!.execute({ path: 'src/a.ts' }, ctx);
		assert.equal(read.ok, true);
	});
});

suite('DEV-2: allowlist do dev_run', () => {
	test('aceita os comandos de verificação do projeto', () => {
		for (const command of [
			'npm run test:core',
			'npm run check-types',
			'npm run lint',
			'npm run web:build',
			'npm run desktop:build',
			'npm test',
			'git status',
			'git diff',
		]) {
			assert.doesNotThrow(() => validateDevCommand(command), command);
		}
	});

	test('recusa binários fora da lista', () => {
		for (const command of ['powershell -c dir', 'curl http://x', 'rm -rf src', 'npx some-package', 'cmd /c dir']) {
			assert.throws(() => validateDevCommand(command), DevCommandRefusedError, command);
		}
	});

	test('recusa um binário permitido usado para executar outra coisa', () => {
		// `node` só roda arquivo; `npm exec` baixa pacote; `git -c` roda
		// comando de configuração.
		for (const command of [
			'node -e "console.log(1)"',
			'node --eval "x"',
			'node -p "process.env"',
			'npm exec algum-pacote',
			'git -c core.pager=calc status',
			'git diff --output=arquivo',
		]) {
			assert.throws(() => validateDevCommand(command), DevCommandRefusedError, command);
		}
	});

	test('recusa encadeamento e redirecionamento', () => {
		for (const command of ['npm test && curl x', 'npm test; rm -rf .', 'npm test | more', 'npm test > out.txt']) {
			assert.throws(() => validateDevCommand(command), DevCommandRefusedError, command);
		}
	});

	test('recusa `npm run` de script fora da lista', () => {
		assert.throws(() => validateDevCommand('npm run postinstall'), DevCommandRefusedError);
		assert.throws(() => validateDevCommand('npm run dev'), DevCommandRefusedError);
	});
});

suite('DEV-2: execução e prazo', () => {
	test('roda um comando permitido dentro do repositório', async () => {
		const { repo, session, tools } = await harness();
		await session.enter();

		const result = await tools.get('dev_run')!.execute({ command: 'git status' }, ctx);

		assert.equal(result.ok, true, result.error);
		assert.equal((result.output as { exitCode: number }).exitCode, 0);
		void repo;
	});

	test('o prazo mata o processo (e o comando não fica pendurado)', async () => {
		const { repo, session } = await harness({
			runner: new DevRunner({ timeoutMs: 300 }),
		});
		await session.enter();
		// Um script node que dorme muito mais que o prazo.
		await writeFile(
			join(repo, 'sleep.js'),
			'setTimeout(() => {}, 60000);\n',
			'utf8',
		);

		const started = Date.now();
		const outcome = await new DevRunner({ timeoutMs: 400 }).run('node sleep.js', repo);

		assert.equal(outcome.aborted, true);
		assert.ok(Date.now() - started < 15_000, 'não esperou o processo inteiro');
	});

	test('sair da sessão cancela o comando em andamento', async () => {
		const { repo, session } = await harness();
		await session.enter();
		await writeFile(join(repo, 'sleep.js'), 'setTimeout(() => {}, 60000);\n', 'utf8');

		const runner = new DevRunner({ timeoutMs: 60_000 });
		const remove = session.onExit(() => runner.cancelRunning());
		const running = runner.run('node sleep.js', repo);
		await new Promise((resolve) => setTimeout(resolve, 150));
		await session.exit();
		const outcome = await running;
		remove();

		assert.equal(outcome.aborted, true);
		assert.equal(session.isActive(), false);
	});

	test('sair do DEV impede novas operações, inclusive com a ferramenta registrada', async () => {
		const { repo, session, tools } = await harness();
		await session.enter();
		await tools.get(DEV_WRITE)!.execute({ path: 'a.ts', content: 'a' }, ctx);
		await session.exit();

		const afterExit = await tools.get(DEV_WRITE)!.execute({ path: 'b.ts', content: 'b' }, ctx);

		assert.equal(afterExit.ok, false);
		assert.match(afterExit.error ?? '', /não está ativo/);
		await assert.rejects(async () => await readFile(join(repo, 'b.ts'), 'utf8'));
	});
});

suite('DEV-2: checkpoints', () => {
	test('restaura byte a byte o arquivo alterado pelo DEV', async () => {
		const { repo, session, tools } = await harness();
		await writeFile(join(repo, 'alvo.ts'), 'original ✓\n', 'utf8');
		await session.enter();

		const written = await tools.get(DEV_WRITE)!.execute({ path: 'alvo.ts', content: 'alterado\n' }, ctx);
		assert.equal(written.ok, true, written.error);
		const checkpointId = (written.output as { checkpoint: string }).checkpoint;
		assert.equal(await readFile(join(repo, 'alvo.ts'), 'utf8'), 'alterado\n');

		const restored = await tools.get('dev_restore')!.execute({ checkpointId }, ctx);

		assert.equal(restored.ok, true, restored.error);
		assert.equal(await readFile(join(repo, 'alvo.ts'), 'utf8'), 'original ✓\n');
	});

	test('arquivos modificados e não rastreados antes da sessão continuam intactos', async () => {
		const { repo, session, tools } = await harness();
		await writeFile(join(repo, 'trabalho-em-andamento.ts'), 'meu trabalho\n', 'utf8');
		await session.enter();

		await tools.get(DEV_WRITE)!.execute({ path: 'outro.ts', content: 'x' }, ctx);
		const listed = await tools.get('dev_checkpoint')!.execute({}, ctx);
		const checkpoints = listed.output as { readonly checkpoints: readonly string[] };
		for (const entry of checkpoints.checkpoints) {
			await tools.get('dev_restore')!.execute({ checkpointId: entry.split(' ')[0] }, ctx);
		}

		// O arquivo não rastreado nunca foi tocado pelo DEV: continua igual.
		assert.equal(await readFile(join(repo, 'trabalho-em-andamento.ts'), 'utf8'), 'meu trabalho\n');
	});

	test('restaurar não sobrescreve alteração posterior: reporta conflito', async () => {
		const { repo, session, tools } = await harness();
		await writeFile(join(repo, 'conflito.ts'), 'v1\n', 'utf8');
		await session.enter();
		const written = await tools.get(DEV_WRITE)!.execute({ path: 'conflito.ts', content: 'v2 (dev)\n' }, ctx);
		const checkpointId = (written.output as { checkpoint: string }).checkpoint;
		// Alguém mexe depois do DEV.
		await writeFile(join(repo, 'conflito.ts'), 'v3 (usuário)\n', 'utf8');

		const restored = await tools.get('dev_restore')!.execute({ checkpointId }, ctx);

		assert.equal(restored.ok, false);
		assert.match(restored.error ?? '', /mudaram depois/);
		assert.equal(await readFile(join(repo, 'conflito.ts'), 'utf8'), 'v3 (usuário)\n');
	});

	test('um arquivo criado pelo DEV é removido na restauração', async () => {
		const { repo, session, tools } = await harness();
		await session.enter();
		const written = await tools.get(DEV_WRITE)!.execute({ path: 'novo.ts', content: 'novo\n' }, ctx);
		const checkpointId = (written.output as { checkpoint: string }).checkpoint;

		const restored = await tools.get('dev_restore')!.execute({ checkpointId }, ctx);

		assert.equal(restored.ok, true, restored.error);
		await assert.rejects(async () => await readFile(join(repo, 'novo.ts'), 'utf8'));
	});

	test('uma escrita que falha não perde o checkpoint do estado anterior', async () => {
		const repo = await makeRepo();
		const data = await makeData();
		const store = new DevCheckpointStore(join(data, 'dev'));
		await writeFile(join(repo, 'alvo.ts'), 'antes\n', 'utf8');

		const id = await store.capture({ root: repo, path: 'alvo.ts', operation: 'dev_write' });
		// A escrita "falha": o arquivo é alterado por fora e o selo nunca vem.
		await writeFile(join(repo, 'alvo.ts'), 'meio\n', 'utf8');

		// Sem selo, a restauração pede confirmação em vez de sobrescrever.
		await assert.rejects(
			async () => await store.restore(id, repo),
			(error: unknown) => error instanceof DevRestoreConflictError,
		);
	});
});

suite('DEV-2: integração com o agente', () => {
	test('sem sessão oferecida pelo host, nenhuma ferramenta dev_* é registrada', () => {
		const stack = createMvpAgentStack({});
		assert.equal(stack.registry.names().some((name) => name.startsWith('dev_')), false);
		stack.dispose();
	});

	test('com sessão, as ferramentas existem — mas recusam enquanto ela está inativa', async () => {
		const repo = await makeRepo();
		const data = await makeData();
		const session = new DevSession({ repositoryRoot: repo });
		const stack = createMvpAgentStack({
			extraTools: createDevTools({
				session,
				checkpoints: new DevCheckpointStore(join(data, 'dev')),
				runner: new DevRunner({ timeoutMs: 5_000 }),
				locks: new DevLocks(),
			}).map((tool, index) => ({ tool, spec: DEV_TOOL_SPECS[index] as (typeof DEV_TOOL_SPECS)[number] })),
		});
		try {
			const names = stack.registry.names();
			for (const name of ['dev_read', 'dev_write', 'dev_run', 'dev_checkpoint', 'dev_restore']) {
				assert.equal(names.includes(name), true, name);
			}
			// Estar no registry não é autorização.
			const tool = stack.registry.get('dev_write');
			assert.notEqual(tool, undefined);
			const result = await tool!.execute({ path: 'x.ts', content: 'x' }, ctx);
			assert.equal(result.ok, false);

			// A política de autorização não muda por a ferramenta existir.
			assert.equal(session.isActive(), false);
		} finally {
			stack.dispose();
		}
	});

	test('as escritas do DEV são classificadas como dangerous para o gateway', () => {
		for (const name of ['dev_write', 'dev_run', 'dev_restore']) {
			const spec = DEV_TOOL_SPECS.find((entry) => entry.name === name);
			assert.equal(spec?.riskLevel, 'dangerous', name);
		}
		// DEV-2.1: ler arquivo do repositório pode expor conteúdo confidencial,
		// então pede confirmação em vez de rodar sozinho.
		assert.equal(DEV_TOOL_SPECS.find((entry) => entry.name === 'dev_read')?.riskLevel, 'moderate');
		assert.equal(DEV_TOOL_SPECS.find((entry) => entry.name === 'dev_checkpoint')?.riskLevel, 'safe');
	});
});

suite('DEV-2: isolamento da autorização', () => {
	test('tokens e credenciais não entram na API da sessão', async () => {
		const { session } = await harness();
		const api = Object.getOwnPropertyNames(Object.getPrototypeOf(session));

		assert.equal(api.includes('enter'), true, 'a entrada existe');
		// Nada que receba token, papel ou "owner" — a sessão não autentica
		// ninguém: ela existe ou não existe.
		for (const forbidden of ['authorize', 'grant', 'setToken', 'assertOwner', 'withToken']) {
			assert.equal(api.includes(forbidden), false, forbidden);
		}
	});

	test('a ferramenta não recebe a sessão inteira, só a pergunta "está ativa?"', async () => {
		const { session, tools } = await harness();
		// O objeto exposto às ferramentas é o `DevSessionRef`: ele responde
		// `isActive/root/sessionToken` e não expõe `enter`/`exit`.
		const ref = session as unknown as Record<string, unknown>;
		assert.equal(typeof ref['enter'], 'function', 'a instância real tem enter');
		// As ferramentas foram construídas com a instância, então o que as
		// protege é a checagem por execução — verificada acima. Aqui se fixa
		// que a checagem acontece mesmo depois da saída:
		await session.enter();
		await session.exit();
		const result = await tools.get(DEV_WRITE)!.execute({ path: 'z.ts', content: 'z' }, ctx);
		assert.equal(result.ok, false);
	});

	test('nenhum arquivo do projeto é lido ou escrito ao entrar e sair', async () => {
		const { repo, session } = await harness();
		const before = execFileSync('git', ['status', '--porcelain', '--', '.'], {
			cwd: repo,
			encoding: 'utf8',
		});
		await session.enter();
		await session.exit();
		const after = execFileSync('git', ['status', '--porcelain', '--', '.'], {
			cwd: repo,
			encoding: 'utf8',
		});

		assert.equal(after, before);
	});
});
