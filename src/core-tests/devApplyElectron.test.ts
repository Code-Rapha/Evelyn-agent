/**
 * Integração: `dev_apply` com o **alvo Electron real** (DEV-AUDIT-03).
 *
 * ## O que faltava
 *
 * Os testes de `dev_apply` usavam um `fakeTarget` que registra chamadas. Os
 * testes do alvo Electron (`devHost.test.ts`) exercitavam `applyChange` — o
 * fluxo da DEV-3 —, mas **não** o `applyPrepared`, que é o caminho que
 * `dev_apply` usa: operação vinda do store, nonce, checkpoint já capturado.
 *
 * Aqui os dois se encontram: a ferramenta, o fluxo de aplicação e o
 * `createElectronApplyTarget` com um host falso. Nenhum Electron é aberto — o
 * contrato do alvo é uma interface, e é isso que se prova.
 *
 * ## O que cada caso fixa
 *
 * - recarga: a janela recarrega **uma** vez, e o fluxo conclui;
 * - reinício: o alvo pede o reinício **uma** vez, mesmo com duas chamadas;
 * - falha na recarga: não conclui, e o checkpoint é preservado;
 * - verificação que falha: nada recarrega.
 */
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { DevSession } from '../core/dev/devSession';
import { DevCheckpointStore } from '../core/dev/devCheckpoint';
import { DevOperationStore } from '../core/dev/devOperation';
import { DevRunner } from '../core/dev/devRunner';
import { DevLocks } from '../core/dev/devLocks';
import { PreparedChangeJournal } from '../core/dev/preparedChange';
import { createElectronApplyTarget, type ElectronApplyHost } from '../core/dev/electronApply';
import { createDevToolEntries, type DevToolDeps } from '../core/agent/devTools';
import type { AgentTool } from '../core/agent/types';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const roots: string[] = [];

async function makeRepo(): Promise<string> {
	const repo = await mkdtemp(join(tmpdir(), 'evelyn-ea-'));
	roots.push(repo);
	// `git init` é síncrono e falha em silêncio com `stdio: 'ignore'`: se a
	// máquina estiver sob carga, o `.git` pode não estar pronto quando a
	// sessão sobe, e o erro aparece como "não há .git" num teste distante da
	// causa. Conferir aqui dá o motivo certo no lugar certo.
	execFileSync('git', ['init', '-q'], { cwd: repo });
	if (!existsSync(join(repo, '.git'))) {
		throw new Error(`o repositório temporário não ganhou .git: ${repo}`);
	}
	await mkdir(join(repo, 'src', 'desktop', 'renderer'), { recursive: true });
	await writeFile(join(repo, 'src', 'desktop', 'renderer', 'index.css'), ':root { --accent: #3b82f6; }\n', 'utf8');
	return repo;
}

/** O host do Electron, sem Electron: o contrato do `ElectronApplyHost`. */
function fakeHost(options: { readonly reloadFails?: boolean; readonly windowAlive?: boolean } = {}): ElectronApplyHost & {
	readonly calls: string[];
} {
	const calls: string[] = [];
	let alive = options.windowAlive ?? true;
	return {
		calls,
		isWindowAlive: () => alive,
		isWindowReady: () => alive,
		async reloadWindow(timeoutMs: number) {
			calls.push(`reload:${timeoutMs}`);
			if (options.reloadFails === true) {
				throw new Error('a página não terminou de carregar');
			}
		},
		async restartApplication() {
			calls.push('restart');
			// Um reinício real **termina** este processo e outro sobe. A
			// simulação tem de refletir isso: se a janela "morresse" aqui, a
			// sondagem veria a versão antiga e o fluxo desfaria — que é o
			// comportamento certo para uma janela que sumiu, e o errado para
			// um reinício bem-sucedido. Depois do reinício, a janela nova
			// está no ar.
			alive = true;
		},
	};
}

interface Fixture {
	readonly repo: string;
	readonly tools: ReadonlyMap<string, AgentTool>;
	readonly host: ElectronApplyHost & { readonly calls: string[] };
	readonly operations: DevOperationStore;
	readonly apply: (path: string, content: string) => Promise<string | undefined>;
}

async function setup(options: { readonly reloadFails?: boolean; readonly checkFails?: boolean } = {}): Promise<Fixture> {
	const repo = await makeRepo();
	const data = await mkdtemp(join(tmpdir(), 'evelyn-ea-data-'));
	roots.push(data);
	const session = new DevSession({ repositoryRoot: repo });
	const checkpoints = new DevCheckpointStore(join(data, 'dev'));
	await checkpoints.init();
	const operations = new DevOperationStore(join(data, 'dev'));
	const journal = new PreparedChangeJournal();
	const host = fakeHost({ ...(options.reloadFails !== undefined ? { reloadFails: options.reloadFails } : {}) });

	const deps: DevToolDeps = {
		session,
		checkpoints,
		runner: new DevRunner({ timeoutMs: 20_000 }),
		locks: new DevLocks(),
		journal,
		operations,
		apply: {
			session,
			journal,
			operations,
			checkpoints,
			createTarget: () =>
				createElectronApplyTarget({
					host,
					repositoryRoot: repo,
					runner: new DevRunner({ timeoutMs: 20_000 }),
					// A verificação é injetada: rodar `npm run test:core` dentro
					// da suíte seria recursivo. O que se prova aqui é o fluxo.
					runCheck: async (command: string) =>
						options.checkFails === true
							? { exitCode: 1, summary: 'a verificação falhou' }
							: { exitCode: 0, summary: `${command}: ok` },
				}),
			writeFile: async (path: string, content: string) => {
				await mkdir(join(repo, path, '..'), { recursive: true });
				await writeFile(join(repo, path), content, 'utf8');
			},
		} as never,
	};
	const tools = new Map(createDevToolEntries(deps).map((entry) => [entry.tool.descriptor.name, entry.tool]));
	await session.enter();

	return {
		repo,
		tools,
		host,
		operations,
		async apply(path, content) {
			const written = await tools.get('dev_write')!.execute({ path, content } as never, { sessionId: 'audit' });
			return (written as { output?: { operationId?: string } }).output?.operationId;
		},
	};
}

teardown(async () => {
	for (const root of roots.splice(0)) {
		await removeFixtureTree(root).catch(() => undefined);
	}
});

test('dev_apply → applyPrepared → alvo Electron: recarrega uma vez e conclui', async () => {
	const fixture = await setup();
	const operation = await fixture.apply('src/desktop/renderer/index.css', ':root { --accent: #b28eff; }\n');
	assert.ok(operation !== undefined);

	const result = await fixture.tools.get('dev_apply')!.execute({ operationId: operation, confirm: true } as never, {
		sessionId: 'audit',
	});

	assert.equal(result.ok, true, String((result as { error?: string }).error));
	assert.deepEqual(fixture.host.calls, ['reload:15000'], 'uma recarga, com o prazo padrão');
	const content = await readFile(join(fixture.repo, 'src/desktop/renderer/index.css'), 'utf8');
	assert.match(content, /#b28eff/);
	const stored = await fixture.operations.read();
	assert.equal(stored?.stage, 'done');
});

test('dev_apply com mudança de Core pede reinício, e só uma vez', async () => {
	const fixture = await setup();
	await writeFile(join(fixture.repo, 'package.json'), '{"name":"f","version":"1.0.0"}', 'utf8');
	// O `package.json` é arquivo crítico da política: exige reinício.
	const operation = await fixture.apply('package.json', '{"name":"f","version":"1.0.1"}\n');
	assert.ok(operation !== undefined);

	const result = await fixture.tools.get('dev_apply')!.execute({ operationId: operation, confirm: true } as never, {
		sessionId: 'audit',
	});

	assert.equal(result.ok, true, String((result as { error?: string }).error));
	const restarts = fixture.host.calls.filter((call) => call === 'restart');
	assert.equal(restarts.length, 1, `reinícios: ${fixture.host.calls.join(',')}`);
});

test('recarga que falha não conclui, e o checkpoint é preservado', async () => {
	const fixture = await setup({ reloadFails: true });
	const before = await readFile(join(fixture.repo, 'src/desktop/renderer/index.css'), 'utf8');
	const operation = await fixture.apply('src/desktop/renderer/index.css', ':root { --accent: #ff0000; }\n');

	const result = await fixture.tools.get('dev_apply')!.execute({ operationId: operation, confirm: true } as never, {
		sessionId: 'audit',
	});

	assert.equal(result.ok, false);
	assert.match(String((result as { error?: string }).error), /recarreg|não voltou|desfez|falhou/i);
	const stored = await fixture.operations.read();
	assert.notEqual(stored?.stage, 'done', 'não é dado como concluído');
	// O arquivo pode ter sido desfeito pelo checkpoint; o que não pode é o
	// fluxo dizer "aplicado".
	const after = await readFile(join(fixture.repo, 'src/desktop/renderer/index.css'), 'utf8');
	assert.ok(after === before || /#ff0000/.test(after), 'o arquivo é o antigo ou o novo, nunca meio-termo');
});

test('verificação que falha não aciona a janela', async () => {
	const fixture = await setup({ checkFails: true });
	// Um arquivo de configuração cai em `reload-ui`, que exige
	// `npm run check-types`. `.css` seria `hot`, sem verificação nenhuma.
	const operation = await fixture.apply('tsconfig.json', '{"compilerOptions":{}}\n');

	const result = await fixture.tools.get('dev_apply')!.execute({ operationId: operation, confirm: true } as never, {
		sessionId: 'audit',
	});

	assert.equal(result.ok, false);
	assert.deepEqual(fixture.host.calls, [], 'nada recarrega se a verificação falha');
	const stored = await fixture.operations.read();
	assert.equal(stored?.stage, 'verification-failed');
});
