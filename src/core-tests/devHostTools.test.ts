/**
 * DEV-5: o host do modo DEV (`src/desktop/devHost.ts`).
 *
 * ## O que é real e o que é simulado
 *
 * Real: o repositório (um `git init` num diretório temporário), os
 * checkpoints, o store de operação, o `DevRunner` (processos de verdade) e a
 * trava entre processos. Simulados: a **janela** do Electron (uma porta que
 * conta `reload`/`restart`) e o **resultado** das verificações (`runCheck`
 * injetado) — porque `npm run test:core` não pode rodar dentro de
 * `npm run test:core`. A lista de verificações continua vindo de
 * `REQUIRED_CHECKS`; só o resultado é injetado.
 *
 * A execução **no Electron de verdade** fica em `devHost.electron.test.ts`,
 * que só roda com `EVELYN_ELECTRON_E2E=1`.
 */
import * as assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * O host mora em `src/desktop`, que o `tsconfig.json` **exclui** do build de
 * testes (o desktop é compilado por `tsconfig.desktop.json` e empacotado, não
 * testado pelo mocha). Um teste dentro de `src/desktop-tests` nunca compilaria
 * para `out/`; por isso este arquivo fica em `core-tests` e alcança o host pelo
 * caminho que existe em tempo de compilação do projeto inteiro — o mesmo usado
 * por `check-types`. O `devHost` não importa Electron: é isso que permite
 * testá-lo fora dele.
 */
import { DevHost, type DevHostWindow } from '../desktop/devHost';
import { DEV_LOCK_FILE } from '../core/dev/devFileLock';
import { createDevToolEntries, type DevToolDeps } from '../core/agent/devTools';
import { DEV_APPLY } from '../core/agent/devApplyTool';
import type { ToolExecutionContext } from '../core/agent/types';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const roots: string[] = [];
const hosts: DevHost[] = [];
const ctx: ToolExecutionContext = { sessionId: 'test' };
const CSS = 'src/desktop/renderer/index.css';
const NEW_CSS = ':root { --accent: #ff0080; }\n';

teardown(async () => {
	// Encerra cada host: um teste que termina com a sessão ativa manteria a
	// trava entre processos (e o `FileHandle`) até o processo sair.
	for (const host of hosts.splice(0)) {
		await host.ownerExit().catch(() => undefined);
	}
	for (const root of roots.splice(0)) {
		await removeFixtureTree(root).catch(() => undefined);
	}
});

async function makeRepo(): Promise<{ readonly repo: string; readonly data: string }> {
	const repo = await mkdtemp(join(tmpdir(), 'evelyn-host5-'));
	roots.push(repo);
	execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
	await mkdir(join(repo, 'src', 'desktop', 'renderer'), { recursive: true });
	await writeFile(join(repo, CSS), ':root { --accent: #3b82f6; }\n', 'utf8');
	const data = await mkdtemp(join(tmpdir(), 'evelyn-host5-data-'));
	roots.push(data);
	return { repo, data };
}

/** A janela do host, com o que foi pedido registrado. */
function fakeWindow(): DevHostWindow & { readonly calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		isWindowAlive: () => true,
		isWindowReady: () => true,
		reloadWindow: async () => {
			calls.push('reload');
		},
		restartApplication: async () => {
			calls.push('restart');
		},
	};
}

interface Harness {
	readonly host: DevHost;
	readonly repo: string;
	readonly data: string;
	readonly window: DevHostWindow & { readonly calls: string[] };
	readonly checks: string[];
	readonly seen: (DevToolDeps | undefined)[];
}

async function host(): Promise<Harness> {
	const { repo, data } = await makeRepo();
	const window = fakeWindow();
	const checks: string[] = [];
	const seen: (DevToolDeps | undefined)[] = [];
	const created = new DevHost({
		repositoryRoot: repo,
		dataRoot: data,
		window: () => window,
		// Só o **resultado** é injetado; a lista vem de `REQUIRED_CHECKS`.
		runCheck: async (command: string) => {
			checks.push(command);
			return { exitCode: 0, summary: 'ok' };
		},
	});
	await created.setup();
	created.attach({ setDevTools: (dev) => seen.push(dev) });
	// DEV-6: `ownerRequest` exige a concessão do host. Estes testes exercitam o
	// host **sem** a confirmação de instância (injetada por um teste de DV-6);
	// a concessão é feita aqui pelo próprio host, na fronteira.
	await created.grantFromHost('teste');
	hosts.push(created);
	return { host: created, repo, data, window, checks, seen };
}

/** As ferramentas que o chat receberia agora, por nome. */
function toolsNow(h: Harness): ReadonlyMap<string, ReturnType<typeof createDevToolEntries>[number]['tool']> {
	const deps = h.host.toolDeps();
	if (deps === undefined) {
		return new Map();
	}
	return new Map(createDevToolEntries(deps).map((entry) => [entry.tool.descriptor.name, entry.tool]));
}

async function write(h: Harness, path: string, content: string): Promise<string> {
	const result = await toolsNow(h).get('dev_write')!.execute({ path, content }, ctx);
	assert.equal(result.ok, true, result.error);
	return (result.output as { readonly operationId: string }).operationId;
}

suite('DEV-5 host: montagem e autorização', () => {
	test('sem `.git`, o modo DEV fica indisponível — e não inventa uma raiz', async () => {
		const data = await mkdtemp(join(tmpdir(), 'evelyn-host5-data-'));
		roots.push(data);
		const notRepo = await mkdtemp(join(tmpdir(), 'evelyn-host5-norepo-'));
		roots.push(notRepo);
		const created = new DevHost({ repositoryRoot: notRepo, dataRoot: data, window: () => undefined });

		const state = await created.setup();

		assert.equal(state.repo, false);
		assert.match((state as { readonly reason: string }).reason, /não há \.git/);
		assert.equal(created.toolDeps(), undefined, 'sem repositório, o chat não recebe `dev=`');
	});

	test('montar não é autorizar: no início não há sessão ativa', async () => {
		const h = await host();

		const state = h.host.state();
		assert.equal(state.repo, true);
		// A raiz é a canônica (realpath, minúsculas no Windows); o diretório
		// temporário devolve a grafia com maiúsculas — a comparação é por isso.
		assert.equal(state.repo ? state.root.toLowerCase() : '', h.repo.toLowerCase());
		assert.equal(state.repo ? state.session : '', 'inactive');
		assert.equal(h.host.toolDeps(), undefined, 'sem `ownerRequest`, nenhuma ferramenta DEV');
		assert.equal(toolsNow(h).size, 0, 'e nenhuma chega ao stack do agente');
	});

	test('o proprietário autoriza; as ferramentas — inclusive o gatilho — existem', async () => {
		const h = await host();

		const state = await h.host.ownerRequest();

		assert.equal(state.repo && state.session, 'active');
		assert.deepEqual([...toolsNow(h).keys()], [
			'dev_read',
			'dev_write',
			'dev_edit',
			'dev_run',
			'dev_checkpoint',
			'dev_restore',
			DEV_APPLY,
		]);
	});

	test('encerrar retira as ferramentas do chat — o gatilho deixa de existir', async () => {
		const h = await host();
		await h.host.ownerRequest();

		await h.host.ownerExit();

		assert.deepEqual(h.seen.map((dev) => (dev === undefined ? 'sem-dev' : 'com-dev')), [
			'sem-dev',
			'com-dev',
			'sem-dev',
		]);
		assert.equal(toolsNow(h).has(DEV_APPLY), false);
	});

	test('a trava do repositório é tomada ao abrir e solta ao encerrar', async () => {
		const h = await host();
		await h.host.ownerRequest();
		const lockFile = join(h.repo, DEV_LOCK_FILE);
		assert.equal(await readFile(lockFile, 'utf8').then(() => true, () => false), true);

		await h.host.ownerExit();

		assert.equal(await readFile(lockFile, 'utf8').then(() => true, () => false), false, 'a trava foi solta');
	});

	test('sem a concessão do host, `ownerRequest` é recusado (DEV-6)', async () => {
		const { repo, data } = await (async () => {
			const r = await mkdtemp(join(tmpdir(), 'evelyn-host5-'));
			roots.push(r);
			execFileSync('git', ['init', '-q'], { cwd: r, stdio: 'ignore' });
			const d = await mkdtemp(join(tmpdir(), 'evelyn-host5-data-'));
			roots.push(d);
			return { repo: r, data: d };
		})();
		const created = new DevHost({ repositoryRoot: repo, dataRoot: data, window: () => fakeWindow() });
		await created.setup();

		await assert.rejects(created.ownerRequest(), /autorização do host não foi concedida/);
	});

	test('um segundo host não abre a sessão enquanto o primeiro a tem', async () => {
		const h = await host();
		await h.host.ownerRequest();
		// Outra `DevSession` no mesmo processo: a trava é da primeira, e a
		// segunda recebe a mesma recusa que outro processo receberia. (O
		// empréstimo reentrante é só para a sessão dona.)
		const other = new DevHost({ repositoryRoot: h.repo, dataRoot: h.data, window: () => undefined });
		await other.setup();
		await other.grantFromHost('outra');

		await assert.rejects(other.ownerRequest(), /em uso|outra sessão/);
		const state = other.state();
		assert.equal(state.repo ? state.session : 'sem-repo', 'inactive');
		assert.equal(toolsNow(h).has(DEV_APPLY), true, 'o primeiro continua autorizado');
		await h.host.ownerExit();
	});

	test('a trava órfã ainda é apresentada, e barra a reativação até o dono soltá-la (DEV-8.4)', async () => {
		const h = await host();
		await h.host.ownerRequest();
		// O app "saiu sem soltar": o arquivo de estado e a trava continuam.
		// Outro processo, com o mesmo espaço de dados, reconhece que havia
		// sessão — mas não abre sozinho nem a reabre por cima da trava.
		const next = new DevHost({ repositoryRoot: h.repo, dataRoot: h.data, window: () => fakeWindow() });
		hosts.push(next);
		await next.setup();
		const state = await next.panelState();

		assert.equal(state.session, 'inactive', 'não abre sozinho');
		assert.equal(state.authorization, 'pending-restore', 'apresenta a sessão anterior');
		assert.equal(state.canActivate, false, 'a trava de outro dono barra a reativação');

		await h.host.ownerExit();
		assert.equal(await readFile(join(h.repo, DEV_LOCK_FILE), 'utf8').then(() => true, () => false), false);
	});

	test('token órfão sem trava é histórico: não bloqueia a reativação (DEV-8.4)', async () => {
		const h = await host();
		await h.host.ownerRequest();
		await h.host.ownerExit();
		// Medido no pacote: depois de um encerramento que não rodou, o
		// `host-state.json` fica com o token de uma sessão que acabou (sem
		// processo e sem trava). O painel dizia `pending-restore` e o botão de
		// ativar ficava desabilitado — reiniciar nunca liberava a autorização.
		await writeFile(
			join(h.data, 'dev', 'host-state.json'),
			JSON.stringify({ root: h.repo, sessionId: '3', lockToken: 'token-de-sessao-que-acabou', savedAt: new Date().toISOString() }),
			'utf8',
		);
		const next = new DevHost({ repositoryRoot: h.repo, dataRoot: h.data, window: () => fakeWindow() });
		hosts.push(next);
		await next.setup();
		const state = await next.panelState();

		assert.equal(state.session, 'inactive');
		assert.equal(state.authorization, 'none', 'nada a restaurar');
		// Este harness não configura a credencial local; o motivo que sobra é
		// esse — nunca o antigo "havia uma sessão antes de reiniciar".
		assert.equal(
			state.activationBlockedReason?.includes('antes de reiniciar') ?? false,
			false,
			'nenhuma pendência de restauração bloqueia a nova autorização',
		);
		assert.equal(state.message, undefined, 'a tela não anuncia uma sessão anterior');
		assert.equal(
			await readFile(join(h.data, 'dev', 'host-state.json'), 'utf8').then(() => true, () => false),
			false,
			'o estado que já não descreve sessão foi descartado',
		);
	});

	test('um estado de raiz diferente não é desta raiz (DEV-8.4)', async () => {
		const h = await host();
		await mkdir(join(h.data, 'dev'), { recursive: true });
		await writeFile(
			join(h.data, 'dev', 'host-state.json'),
			JSON.stringify({ root: join(h.repo, 'outra'), sessionId: '3', lockToken: 'x', savedAt: new Date().toISOString() }),
			'utf8',
		);
		const next = new DevHost({ repositoryRoot: h.repo, dataRoot: h.data, window: () => fakeWindow() });
		hosts.push(next);
		await next.setup();
		const state = await next.panelState();

		assert.equal(state.authorization, 'none');
	});

	test('a trava entre processos também barra outro processo de verdade', async () => {
		const h = await host();
		await h.host.ownerRequest();
		// Um processo Node separado tenta a mesma trava: é a situação de duas
		// instâncias do app. Não é um host simulado — é outro binário.
		const helper = join(__dirname, 'helpers', 'devLockHelper.js');
		const run = spawnSync(process.execPath, [helper, h.repo, '0'], { encoding: 'utf8', timeout: 30_000 });
		const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
		assert.match(output, /busy/, `o processo separado devia recusar: ${output}`);
		await h.host.ownerExit();
	});

	test('entrada dupla é idempotente: o token da sessão não muda', async () => {
		const h = await host();
		await h.host.ownerRequest();
		const first = h.host.toolDeps()!.session.sessionToken();

		await h.host.ownerRequest();

		assert.equal(h.host.toolDeps()!.session.sessionToken(), first);
	});

	test('saída e nova entrada: a preparação da sessão anterior não sobrevive', async () => {
		const h = await host();
		await h.host.ownerRequest();
		const operationId = await write(h, CSS, NEW_CSS);
		await h.host.ownerExit();
		// A sessão nova é a mesma raiz, outra autorização — exige nova
		// concessão do host (DEV-6), como a interface faz.
		await h.host.grantFromHost('teste');
		await h.host.ownerRequest();

		const result = await toolsNow(h).get(DEV_APPLY)!.execute({ operationId, confirm: true }, ctx);

		assert.equal(result.ok, false);
		assert.match(result.error ?? '', /não há operação/);
		assert.deepEqual(h.window.calls, [], 'nada foi recarregado');
	});

	test('um id de outra sessão no diário é barrado pelo token', async () => {
		const h = await host();
		await h.host.ownerRequest();
		await write(h, CSS, NEW_CSS);
		await h.host.ownerExit();
		await h.host.grantFromHost('teste');
		await h.host.ownerRequest();
		const deps = h.host.toolDeps()!;
		const journal = deps.journal!;
		// Uma preparação com o token de **outra** autorização, na raiz certa:
		// tudo confere, menos de quem é a sessão.
		const foreign = journal.start({
			root: deps.session.root(),
			files: [CSS],
			sessionToken: 'token-de-outra-sessao',
		});
		journal.note({ operationId: foreign.operationId, path: CSS, content: NEW_CSS });

		const result = await toolsNow(h).get(DEV_APPLY)!.execute({ operationId: foreign.operationId, confirm: true }, ctx);

		assert.equal(result.ok, false);
		assert.match(result.error ?? '', /sessão DEV anterior/);
		assert.deepEqual(h.window.calls, []);
	});
});

suite('DEV-5 host: aplicação pelo gatilho real', () => {
	test('o fluxo completo aplica pelo alvo do host e confirma', async () => {
		const h = await host();
		await h.host.ownerRequest();
		const operationId = await write(h, CSS, NEW_CSS);

		const result = await toolsNow(h).get(DEV_APPLY)!.execute({ operationId, confirm: true }, ctx);

		assert.equal(result.ok, true, result.error);
		assert.deepEqual(h.window.calls, ['reload'], 'CSS: só a janela recarrega');
		assert.deepEqual(h.checks, [], 'CSS sozinho não exige verificação');
		assert.equal(await readFile(join(h.repo, CSS), 'utf8'), NEW_CSS);
	});

	test('HTML exige a verificação da política antes de recarregar', async () => {
		const h = await host();
		await h.host.ownerRequest();
		const operationId = await write(h, 'src/desktop/renderer/index.html', '<!doctype html><title>x</title>\n');

		const result = await toolsNow(h).get(DEV_APPLY)!.execute({ operationId, confirm: true }, ctx);

		assert.equal(result.ok, true, result.error);
		assert.deepEqual(h.checks, ['npm run check-types'], 'a verificação da política, não uma escolhida');
		assert.deepEqual(h.window.calls, ['reload']);
	});

	test('a escrita do fluxo respeita a política de caminhos protegidos', async () => {
		const h = await host();
		await h.host.ownerRequest();
		const apply = h.host.toolDeps()!.apply!;

		await assert.rejects(apply.writeFile('.env', 'TOKEN=x'), /proteg/i);
		await assert.rejects(apply.writeFile('../fora.txt', 'x'), /fora|dentro|escopo|workspace/i);
	});

	test('o alvo é criado por aplicação: a memória de "já reiniciei" não passa de uma para outra', async () => {
		const h = await host();
		await h.host.ownerRequest();
		type RestartAware = { readonly restarted?: () => boolean };
		const first = h.host.toolDeps()!.apply!.createTarget() as RestartAware & {
			restartApp(input: { readonly controlled: boolean }): Promise<void>;
		};
		await first.restartApp({ controlled: false });
		const second = h.host.toolDeps()!.apply!.createTarget() as RestartAware;

		assert.equal(first.restarted?.(), true);
		assert.equal(second.restarted?.(), false, 'um alvo novo não carrega o reinício da operação anterior');
	});
});
