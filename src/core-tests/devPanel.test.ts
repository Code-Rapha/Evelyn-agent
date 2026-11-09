/**
 * DEV-6: o painel do modo DEV — validação, identidade e fluxo.
 *
 * ## Real vs. simulado, declarado
 *
 * Real: repositório (git), checkpoints, `DevOperationStore`, `DevRunner`,
 * trava entre processos, `DevSession`, `DevHost`, `applyPrepared` e a
 * restauração pelo Core.
 *
 * Simulado, e só isto:
 * - a **confirmação de instância** (`readLocalInstance` injetado) — a consulta
 *   ao Windows é testada com o sistema de verdade, e não reinicia nada;
 * - a **janela** do Electron (um port que conta recarga) e o resultado de
 *   `runCheck`;
 * - o IPC do `main`: `parseDevRequest` é a mesma função que o handler usa.
 *
 * O teste do IPC **real** (origem, janela principal, preload) está em
 * `dev6Electron.test.ts`, com `electron.exe`.
 */
import * as assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DevHost, type DevHostWindow } from '../desktop/devHost';
import { activationVerdict, countSameExecutable, readLocalInstance, type LocalInstance } from '../desktop/localInstance';
import { MAX_ID_LENGTH, parseDevRequest } from '../desktop/devControl';
import { parseDevPanelState } from '../desktop/devView';
import { OwnerCredentialStore } from '../desktop/ownerCredential';
import { OwnerPromptBroker, type OwnerPrompt } from '../desktop/ownerPrompt';
import type { PowerShellRunner } from '../desktop/windowsDpapi';
import { DEV_LOCK_FILE, forgetSessionLock, readLockOwnerFile } from '../core/dev/devFileLock';
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
	for (const host of hosts.splice(0)) {
		await host.ownerExit().catch(() => undefined);
	}
	for (const root of roots.splice(0)) {
		await removeFixtureTree(root).catch(() => undefined);
	}
});

async function makeRepo(): Promise<{ readonly repo: string; readonly data: string }> {
	const repo = await mkdtemp(join(tmpdir(), 'evelyn-dev6-'));
	roots.push(repo);
	execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
	await mkdir(join(repo, 'src', 'desktop', 'renderer'), { recursive: true });
	await writeFile(join(repo, CSS), ':root { --accent: #3b82f6; }\n', 'utf8');
	const data = await mkdtemp(join(tmpdir(), 'evelyn-dev6-data-'));
	roots.push(data);
	return { repo, data };
}

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

const SINGLE: LocalInstance = { kind: 'single', sessionId: '1', processes: 1 };

interface Harness {
	readonly host: DevHost;
	readonly repo: string;
	readonly data: string;
	readonly window: DevHostWindow & { readonly calls: string[] };
	readonly seen: (DevToolDeps | undefined)[];
	readonly prompts: OwnerPromptBroker;
	readonly sent: OwnerPrompt[];
	readonly password: string;
}

const PASSWORD = 'frase-do-proprietario-dev7';

/** Um DPAPI de mentira, o mesmo contrato de `devOwnerCredential.test.ts`. */
const fakeDpapi: PowerShellRunner = async (script) => {
	const protect = /\$b=\[Convert\]::FromBase64String\('([^']*)'\)/.exec(script);
	if (protect !== null) {
		return { ok: true, stdout: Buffer.from(`SEALED:${protect[1]}`).toString('base64'), stderr: '' };
	}
	const blob = /\$p=\[Convert\]::FromBase64String\('([^']*)'\)/.exec(script);
	if (blob !== null) {
		const inner = Buffer.from(blob[1] as string, 'base64').toString('utf8');
		return inner.startsWith('SEALED:')
			? { ok: true, stdout: inner.slice('SEALED:'.length), stderr: '' }
			: { ok: false, stdout: '', stderr: 'blob inválido' };
	}
	return { ok: false, stdout: '', stderr: 'script inesperado' };
};

async function host(
	options: {
		readonly instance?: LocalInstance | 'none' | (() => Promise<LocalInstance>);
		readonly repo?: string;
		readonly data?: string;
		/** Credencial configurada? Padrão: sim (o cenário normal). */
		readonly withCredential?: boolean;
		/** O resultado das verificações (padrão: sucesso). */
		readonly runCheck?: (command: string) => Promise<{ readonly exitCode: number; readonly summary: string }>;
	} = {},
): Promise<Harness> {
	const made =
		options.repo !== undefined && options.data !== undefined
			? { repo: options.repo, data: options.data }
			: await makeRepo();
	const window = fakeWindow();
	const seen: (DevToolDeps | undefined)[] = [];
	const instance = options.instance ?? SINGLE;
	const credential = new OwnerCredentialStore({
		dir: join(made.data, 'dev'),
		user: () => 'proprietario',
		run: fakeDpapi,
	});
	if (options.withCredential !== false) {
		// Se a credencial já existe (o app "reiniciou"), ela é **reutilizada**:
		// configurar de novo é recusado por desenho — trocar exige recuperação.
		const existing = await credential.state();
		if (existing.kind === 'not-configured') {
			const configured = await credential.configure(PASSWORD, PASSWORD);
			assert.equal(configured.ok, true);
		}
	}
	const sent: OwnerPrompt[] = [];
	const prompts = new OwnerPromptBroker((prompt) => {
		sent.push(prompt);
		return true;
	});
	const created = new DevHost({
		repositoryRoot: made.repo,
		dataRoot: made.data,
		window: () => window,
		runCheck: options.runCheck ?? (async () => ({ exitCode: 0, summary: 'ok' })),
		credential,
		prompt: prompts,
		...(instance === 'none'
			? {}
			: {
					readLocalInstance: typeof instance === 'function' ? instance : async () => instance,
				}),
	});
	await created.setup();
	created.attach({ setDevTools: (dev) => seen.push(dev) });
	hosts.push(created);
	return { host: created, repo: made.repo, data: made.data, window, seen, prompts, sent, password: PASSWORD };
}

function toolsNow(h: Harness): ReadonlyMap<string, ReturnType<typeof createDevToolEntries>[number]['tool']> {
	const deps = h.host.toolDeps();
	return deps === undefined
		? new Map()
		: new Map(createDevToolEntries(deps).map((entry) => [entry.tool.descriptor.name, entry.tool]));
}

/**
 * Ativa como a interface faz desde a DEV-7: a pergunta do host e a senha.
 *
 * Antes da DEV-7 estes testes chamavam `activateFromPanel()` direto; agora o
 * fluxo exige a credencial local, e é isso que a interface faz. O DPAPI aqui é
 * o de mentira de `devOwnerCredential.test.ts`; o real é provado
 * separadamente.
 */
async function activateHost(h: Harness): Promise<void> {
	const from = h.sent.length;
	const pending = h.host.activateFromPanel();
	const deadline = Date.now() + 10_000;
	while (h.sent.length === from) {
		if (Date.now() > deadline) {
			// Nenhuma pergunta: a ativação recusou antes (instância, credencial).
			// O erro real vem do `pending`.
			await pending;
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	const prompt = h.sent[from] as OwnerPrompt;
	h.prompts.answer({ id: prompt.id, kind: 'password', password: h.password });
	await pending;
}

async function write(h: Harness, path: string, content: string): Promise<string> {
	const result = await toolsNow(h).get('dev_write')!.execute({ path, content }, ctx);
	assert.equal(result.ok, true, result.error);
	return (result.output as { readonly operationId: string }).operationId;
}

/** A sessão do host, como o `state()` a reporta (união estreitada). */
function sessionOf(host: DevHost): 'active' | 'inactive' {
	const state = host.state();
	return state.repo ? state.session : 'inactive';
}

function sessionOfState(state: Awaited<ReturnType<DevHost['setup']>>): 'active' | 'inactive' {
	return state.repo ? state.session : 'inactive';
}

/** As ferramentas DEV (as mesmas que o chat receberia), garantidas. */
function usedDeps(host: DevHost): DevToolDeps {
	const deps = host.toolDeps();
	assert.notEqual(deps, undefined, 'o host devia estar ativo');
	return deps as DevToolDeps;
}

suite('DEV-6: ativação e encerramento pela interface', () => {
	test('sem confirmação de instância, a ativação pela interface está indisponível', async () => {
		const h = await host({ instance: 'none' });

		const state = await h.host.panelState();

		assert.equal(state.session, 'inactive');
		assert.equal(state.authorization, 'none');
		await assert.rejects(h.host.activateFromPanel(), /não confirma a instância local/);
		assert.equal(sessionOf(h.host), 'inactive');
	});

	test('duas instâncias recusam a ativação, com o motivo', async () => {
		const h = await host({ instance: { kind: 'ambiguous', processes: 2 } });

		await assert.rejects(h.host.activateFromPanel(), /2 instâncias/);
		assert.equal(sessionOf(h.host), 'inactive');
	});

	test('instância não confirmada (unknown) recusa a ativação', async () => {
		const h = await host({ instance: { kind: 'unknown', reason: 'consulta falhou' } });

		await assert.rejects(h.host.activateFromPanel(), /não foi possível confirmar a instância/);
	});

	test('uma instância: a ativação abre a sessão e as ferramentas DEV aparecem', async () => {
		const h = await host();
		await activateHost(h);
		const state = await h.host.panelState();

		assert.equal(state.session, 'active');
		assert.equal(state.authorization, 'active');
		assert.equal(state.repo.available && state.repo.root.length > 0, true);
		assert.equal(toolsNow(h).has(DEV_APPLY), true);
		assert.notEqual(h.seen.at(-1), undefined, 'o chat recebeu o `dev=`');
	});

	test('o encerramento retira as ferramentas na hora e invalida a preparação', async () => {
		const h = await host();
		await activateHost(h);
		const operationId = await write(h, CSS, NEW_CSS);

		const state = await h.host.deactivateFromPanel();

		assert.equal(state.session, 'inactive');
		assert.equal(state.authorization, 'none');
		assert.equal(toolsNow(h).size, 0, 'nenhuma ferramenta DEV no stack');
		assert.equal(h.seen.at(-1), undefined, 'o chat recebeu `undefined`');

		// A operação preparada com o token anterior não pode ser aplicada.
		await activateHost(h);
		await assert.rejects(h.host.applyFromPanel(operationId), /não há operação preparada/);
		assert.deepEqual(h.window.calls, [], 'nada foi recarregado');
	});

	test('sem repositório, o estado diz por quê e nada pode ser ativado', async () => {
		const notRepo = await mkdtemp(join(tmpdir(), 'evelyn-dev6-norepo-'));
		roots.push(notRepo);
		const data = await mkdtemp(join(tmpdir(), 'evelyn-dev6-data-'));
		roots.push(data);
		const created = new DevHost({ repositoryRoot: notRepo, dataRoot: data, window: () => undefined });
		hosts.push(created);

		const state = await created.panelState();

		assert.equal(state.repo.available, false);
		assert.match(state.repo.available ? '' : state.repo.reason, /não há \.git/);
		assert.equal(state.canActivate, false);
		assert.deepEqual(state.checkpoints, [], 'nenhum checkpoint inventado');
		assert.equal(state.operation, undefined, 'nenhuma operação inventada');
	});
});

suite('DEV-6: operação no painel', () => {
	test('operação preparada aparece com arquivos, estratégia e pode aplicar', async () => {
		const h = await host();
		await activateHost(h);
		const operationId = await write(h, CSS, NEW_CSS);

		const state = await h.host.panelState();

		assert.equal(state.operation?.id, operationId);
		assert.equal(state.operation?.stage, 'written');
		assert.equal(state.operation?.stageLabel, 'Escrita, aguardando verificação');
		assert.equal(state.operation?.strategy, 'hot');
		assert.deepEqual(state.operation?.files, [CSS]);
		assert.equal(state.operation?.canApply, true);
		assert.equal(state.operation?.requiresControlledRestart, false);
		assert.equal(state.checkpoints.length > 0, true, 'o checkpoint da escrita aparece');
		assert.equal(state.checkpoints[0]?.canRestore, true);
	});

	test('aplicar pelo painel: o resultado real aparece e a operação fica concluída', async () => {
		const h = await host();
		await activateHost(h);
		const operationId = await write(h, CSS, NEW_CSS);

		const result = await h.host.applyFromPanel(operationId);

		assert.equal(result.outcome, 'done');
		assert.deepEqual(h.window.calls, ['reload']);
		const state = await h.host.panelState();
		assert.equal(state.operation?.stage, 'done');
		assert.equal(state.operation?.canApply, false, 'concluída não se aplica de novo');
	});

	test('aplicar exige o id conhecido: id inventado e argumento estranho são recusados', async () => {
		const h = await host();
		await activateHost(h);
		await write(h, CSS, NEW_CSS);

		await assert.rejects(h.host.applyFromPanel('devop-nao-existe'), /não há operação preparada/);
		await assert.rejects(h.host.applyFromPanel(42), /identificador de operação inválido/);
		await assert.rejects(h.host.applyFromPanel('../etc/passwd'), /não há operação preparada/);
		await assert.rejects(h.host.applyFromPanel('x'.repeat(500)), /identificador de operação inválido/);
		assert.deepEqual(h.window.calls, []);
	});

	test('sem sessão ativa, aplicar pelo painel é recusado', async () => {
		const h = await host();

		await assert.rejects(h.host.applyFromPanel('qualquer'), /não está ativo/);
	});

	test('falha na aplicação: o painel mostra a etapa falha e o checkpoint para desfazer', async () => {
		const h = await host({ runCheck: async () => ({ exitCode: 1, summary: 'a verificação falhou' }) });
		await activateHost(h);
		const deps = usedDeps(h.host);
		const written = await createDevToolEntries(deps)
			.find((entry) => entry.tool.descriptor.name === 'dev_write')!
			.tool.execute({ path: 'src/desktop/renderer/index.html', content: '<!doctype html>\n' }, ctx);
		const operationId = (written.output as { readonly operationId: string }).operationId;

		const result = await h.host.applyFromPanel(operationId);

		assert.equal(result.outcome, 'refused');
		const state = await h.host.panelState();
		assert.equal(state.operation?.stage, 'verification-failed');
		assert.equal(state.operation?.stageLabel, 'Falhou na verificação');
		assert.equal(state.operation?.canApply, false);
		assert.equal(state.operation?.canRestore, true, 'o checkpoint está lá para desfazer');
	});
});

suite('DEV-6: checkpoints e restauração', () => {
	test('conflito externo é recusado e nomeado; nada é sobrescrito', async () => {
		const h = await host();
		await activateHost(h);
		await write(h, CSS, NEW_CSS);
		// Alguém mexe por fora depois da escrita do DEV.
		await writeFile(join(h.repo, CSS), 'alterado por fora\n', 'utf8');

		const state = await h.host.panelState();
		const checkpoint = state.operation?.checkpoints[0];
		assert.equal(checkpoint?.canRestore, false, 'o painel já diz que não pode');
		assert.match(checkpoint?.blockedReason ?? '', /mudou depois da operação/);

		const result = await h.host.restoreFromPanel({ checkpointId: checkpoint?.id });
		assert.deepEqual(result.restored, []);
		assert.equal(result.blocked.length, 1);
		assert.equal(await readFile(join(h.repo, CSS), 'utf8'), 'alterado por fora\n', 'nada foi sobrescrito');
	});

	test('sem conflito, restaurar pelo checkpoint devolve o original', async () => {
		const h = await host();
		await activateHost(h);
		await write(h, CSS, NEW_CSS);
		const state = await h.host.panelState();
		const checkpoint = state.operation?.checkpoints[0];
		assert.equal(checkpoint?.canRestore, true);

		const result = await h.host.restoreFromPanel({ checkpointId: checkpoint?.id });

		assert.deepEqual(result.restored, [CSS]);
		assert.equal(await readFile(join(h.repo, CSS), 'utf8'), ':root { --accent: #3b82f6; }\n');
	});

	test('checkpoint de id desconhecido é recusado', async () => {
		const h = await host();
		await activateHost(h);

		await assert.rejects(h.host.restoreFromPanel({ checkpointId: 'ck-nao-existe' }), /não há checkpoint/);
	});

	test('restaurar sem sessão ativa é recusado', async () => {
		const h = await host();

		await assert.rejects(h.host.restoreFromPanel({}), /não está ativo/);
	});
});

suite('DEV-6: reinício e continuidade', () => {
	/**
	 * "O processo anterior morreu": na vida real, o SO fecha os handles e o
	 * arquivo da trava fica. Aqui o handle é fechado **sem** apagar o arquivo,
	 * pelo mesmo método de infraestrutura da DEV-6, e o host daquele processo
	 * é descartado (nenhuma `ownerExit`: um app que cai não desfaz nada).
	 */
	async function simulateProcessDeath(host: DevHost, repo: string): Promise<void> {
		const token = (host as unknown as { readonly lock?: { readonly token: string } }).lock?.token;
		assert.equal(typeof token, 'string', 'o host ativo deixou uma trava com token');
		await forgetSessionLock(repo);
	}

	test('depois de reiniciar: nada é reativado, e o estado apresenta a sessão anterior', async () => {
		// O primeiro host é o harness completo (credencial + prompt). O "app
		// morto" deixa o arquivo da trava e o estado do host em disco.
		const first = await host();
		await activateHost(first);
		await simulateProcessDeath(first.host, first.repo);

		// O processo novo: a **mesma** credencial (ela sobrevive ao reinício,
		// é DPAPI em disco) e um prompt novo. Como na DEV-7, o reinício **não**
		// reabre: a sessão fica inativa até a senha de novo.
		const made = { repo: first.repo, data: first.data };
		const second = await host({ repo: made.repo, data: made.data });
		const initial = await second.host.setup();

		assert.equal(sessionOfState(initial), 'inactive', 'nunca reativa sozinho');
		const state = await second.host.panelState();
		assert.equal(state.session, 'inactive');
		assert.equal(state.localCredential.kind, 'configured', 'a credencial sobrevive ao reinício');
		assert.equal(state.authorization, 'pending-restore');
		assert.match(state.message ?? '', /não foi restaurada/);

		// O dono confirma com a senha: a trava órfã deixa de barrar.
		await activateHost(second);
		assert.equal(sessionOf(second.host), 'active');
	});

	test('uma operação interrompida continua legível depois de reiniciar, sem autorização', async () => {
		const first = await host();
		await activateHost(first);
		const deps = usedDeps(first.host);
		const written = await createDevToolEntries(deps)
			.find((entry) => entry.tool.descriptor.name === 'dev_write')!
			.tool.execute({ path: CSS, content: NEW_CSS }, ctx);
		const operationId = (written.output as { readonly operationId: string }).operationId;

		const second = await host({ repo: first.repo, data: first.data, withCredential: false });
		const state = await second.host.panelState();

		assert.equal(state.session, 'inactive');
		assert.equal(state.operation?.stage, 'written', 'a operação está em disco');
		assert.equal(state.operation?.canApply, false, 'sem preparação viva, não se aplica pelo painel');
		assert.equal(state.checkpoints.length > 0, true, 'os checkpoints continuam lá');
		await assert.rejects(second.host.applyFromPanel(operationId), /não está ativo/);
	});
});

suite('DEV-6: validação do IPC', () => {
	test('ação desconhecida é recusada', () => {
		assert.throws(() => parseDevRequest('rm -rf', undefined), /desconhecida/);
		assert.throws(() => parseDevRequest(42, undefined), /desconhecida/);
		assert.throws(() => parseDevRequest('__proto__', {}), /desconhecida/);
	});

	test('caminho ou comando em qualquer campo é recusado', () => {
		assert.throws(() => parseDevRequest('apply', { operationId: 'x', root: 'C:\\' }), /campos não previstos/);
		assert.throws(() => parseDevRequest('activate', { command: 'npm run build' }), /não aceita argumentos/);
		assert.throws(() => parseDevRequest('apply', { path: '/etc/passwd' }), /campos não previstos|inválido/);
	});

	test('id com barra, ponto-ponto ou longo demais é recusado', () => {
		for (const bad of ['../../etc', 'a/b', 'a\\b', '', 'x'.repeat(MAX_ID_LENGTH + 1), 'id com espaço']) {
			assert.throws(() => parseDevRequest('apply', { operationId: bad }), /inválido/, JSON.stringify(bad));
		}
	});

	test('o pedido válido passa, sem inventar campo', () => {
		assert.deepEqual(parseDevRequest('state', undefined), { action: 'state' });
		assert.deepEqual(parseDevRequest('apply', { operationId: 'devop-abc_123' }), {
			action: 'apply',
			operationId: 'devop-abc_123',
		});
		assert.deepEqual(parseDevRequest('restore', {}), { action: 'restore' });
		assert.throws(() => parseDevRequest('apply', undefined), /exige/);
	});

	test('a página não recebe token nem caminho absoluto', async () => {
		const h = await host();
		await activateHost(h);
		const operationId = await write(h, CSS, NEW_CSS);

		const payload = JSON.stringify(await h.host.panelState());
		const token = h.host.toolDeps()!.session.sessionToken();

		assert.equal(payload.includes(token), false, 'nem o token da sessão');
		assert.equal(payload.includes(h.repo.replace(/\\/g, '')), false, 'nem a raiz em forma bruta');
		assert.equal(payload.includes('C:'), false, 'nenhum caminho absoluto');
		assert.equal(JSON.parse(payload).operation.id, operationId);
	});

	test('o view recusa um payload malformado em vez de renderizar `undefined`', () => {
		assert.throws(() => parseDevPanelState({ repo: { available: true } }), /inválido/);
		assert.throws(
			() =>
				parseDevPanelState({
					repo: { available: false, reason: 'x' },
					session: 'inactive',
					authorization: 'none',
					checkpoints: [],
					operation: { stage: 'inventada', strategy: 'hot' },
				}),
			/etapa ou estratégia desconhecida/,
		);
	});
});

suite('DEV-6: a instância, com o sistema de verdade', () => {
	test('a consulta ao Windows responde, e o veredito é conservador', async () => {
		if (process.platform !== 'win32') {
			return;
		}
		// DEV-8.1: o identificador é o **executável**, não o nome. No mocha
		// (node.exe) o processo que pergunta aparece na consulta. Se houver
		// outro `node.exe` vivo (o próprio terminal que roda a suíte), o veredito
		// honesto é `ambiguous`; com um só, `single`. O teste confere os dois
		// lados com a contagem real, em vez de pressupor a máquina vazia.
		const own = await countSameExecutable({ execPath: process.execPath });
		const instance = await readLocalInstance({ execPath: process.execPath });
		if (own > 1) {
			assert.equal(instance.kind, 'ambiguous');
			assert.equal(activationVerdict(instance).allowed, false);
		} else {
			assert.equal(instance.kind, 'single');
			assert.equal(activationVerdict(instance).allowed, true);
		}
	});

	test('a contagem é por executável, não por nome nem pelo próprio PowerShell', async () => {
		if (process.platform !== 'win32') {
			return;
		}
		// Um executável que não existe conta zero. O `powershell.exe` que roda a
		// consulta **não** entra na conta (antes entrava: `2 !== 1` com um mocha
		// só, e "3 instâncias" com um app Electron só).
		assert.equal(await countSameExecutable({ execPath: join(tmpdir(), 'nao-existe-xyz.exe') }), 0);
		const own = await countSameExecutable({ execPath: process.execPath });
		assert.equal(own >= 1, true, `o próprio processo deveria aparecer (contou ${own})`);
	});
	test('o processo separado vê a trava ocupada (o mecanismo que recusa outro app)', async () => {
		const h = await host();
		await activateHost(h);
		const lock = await readLockOwnerFile(h.repo);
		assert.equal(lock.kind, 'held');
		assert.equal(lock.kind === 'held' && typeof lock.token === 'string', true);
		const helper = join(__dirname, 'helpers', 'devLockHelper.js');
		const run = spawnSync(process.execPath, [helper, h.repo, '0'], { encoding: 'utf8', timeout: 30_000 });
		assert.match(`${run.stdout ?? ''}${run.stderr ?? ''}`, /busy/);
		assert.equal(await readFile(join(h.repo, DEV_LOCK_FILE), 'utf8').then(() => true, () => false), true);
	});

	test('o veredito de instância é conservador', () => {
		assert.deepEqual(activationVerdict({ kind: 'single', sessionId: '3', processes: 1 }), {
			allowed: true,
			sessionId: '3',
		});
		assert.equal(activationVerdict({ kind: 'ambiguous', processes: 3 }).allowed, false);
		assert.equal(activationVerdict({ kind: 'unknown', reason: 'x' }).allowed, false);
	});
});
