/**
 * DEV-4: integração do modo DEV com o host.
 *
 * ## O que é real e o que é simulado
 *
 * - **Real:** o sistema de arquivos (sessão, checkpoints, operações), o
 *   `DevRunner` (processos) e o fluxo `applyChange` inteiro.
 * - **Simulado:** o `ElectronApplyHost` — recarga e reinício. Reiniciar o
 *   Electron de verdade encerraria a suíte. O host simulado registra
 *   `reloadWindow`/`restartApplication` e pode falhar de propósito; é o
 *   contrato que o `main.ts` implementa com `webContents.reload` e
 *   `app.relaunch`, e cada caminho de falha é exercitado aqui.
 */
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { UiSessionStore, SESSION_FILE, toBootState } from '../core/dev/uiSession';
import { parseSessionPatch, assertBootStateSafe, SessionMessageError } from '../core/dev/sessionMessages';
import { decideBoot } from '../core/dev/bootState';
import { createElectronApplyTarget, ApplyHostError, type ElectronApplyHost } from '../core/dev/electronApply';
import { applyChange } from '../core/dev/devApply';
import { DevCheckpointStore } from '../core/dev/devCheckpoint';
import { DevOperationStore, advance, startOperation } from '../core/dev/devOperation';
import { DevRunner } from '../core/dev/devRunner';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const roots: string[] = [];

async function makeDir(prefix = 'evelyn-dev4-'): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	roots.push(dir);
	return dir;
}

async function makeRepo(): Promise<string> {
	const repo = await makeDir('evelyn-dev4-repo-');
	execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
	await mkdir(join(repo, 'src', 'desktop', 'renderer'), { recursive: true });
	await writeFile(join(repo, 'src', 'desktop', 'renderer', 'index.css'), ':root { --accent: #3b82f6; }\n', 'utf8');
	return repo;
}

teardown(async () => {
	for (const root of roots.splice(0)) {
		await removeFixtureTree(root).catch(() => undefined);
	}
});

/** O host do Electron, simulado: registra o que foi pedido. */
function fakeHost(options: { readonly reloadFails?: boolean; readonly windowAlive?: boolean } = {}): ElectronApplyHost & {
	readonly calls: string[];
} {
	const calls: string[] = [];
	let alive = options.windowAlive ?? true;
	return {
		calls,
		isWindowAlive: () => alive,
		isWindowReady: () => alive,
		async reloadWindow(timeoutMs) {
			calls.push(`reload:${timeoutMs}`);
			if (options.reloadFails === true) {
				throw new Error('a página não terminou de carregar');
			}
		},
		async restartApplication() {
			calls.push('restart');
			// Num reinício real o processo morre aqui; na simulação, a janela
			// "some" para que a sondagem não veja a versão antiga.
			alive = false;
		},
	};
}

suite('DEV-4: sessão de interface', () => {
	test('começa vazia e grava a conversa aberta', async () => {
		const dir = await makeDir();
		const store = new UiSessionStore(dir);

		assert.deepEqual(await store.read(), {});
		const saved = await store.patch({ lastConversationId: 'cnv-1' });

		assert.equal(saved.lastConversationId, 'cnv-1');
		const reopened = new UiSessionStore(dir);
		assert.equal((await reopened.read()).lastConversationId, 'cnv-1');
	});

	test('preserva `wasGenerating` ao trocar de conversa (merge, não substituição)', async () => {
		const dir = await makeDir();
		const store = new UiSessionStore(dir);
		await store.patch({ wasGenerating: true });

		await store.patch({ lastConversationId: 'cnv-2' });

		const state = await store.read();
		assert.equal(state.wasGenerating, true);
		assert.equal(state.lastConversationId, 'cnv-2');
	});

	test('um arquivo ilegível é "nada sabido", não erro', async () => {
		const dir = await makeDir();
		await writeFile(join(dir, SESSION_FILE), '{ quebrado', 'utf8');

		assert.deepEqual(await new UiSessionStore(dir).read(), {});
	});

	test('não guarda conteúdo de mensagem nem segredo', async () => {
		const dir = await makeDir();
		const store = new UiSessionStore(dir);
		await store.patch({ lastConversationId: 'cnv-3', wasGenerating: true });

		const raw = await readFile(join(dir, SESSION_FILE), 'utf8');

		assert.equal(/token|secret|password|conteúdo/i.test(raw), false);
		assert.equal(raw.includes('cnv-3'), true);
	});
});

suite('DEV-4: validação das mensagens do renderer', () => {
	test('aceita conversa e geração', () => {
		assert.deepEqual(parseSessionPatch({ conversationId: 'cnv-1' }), { lastConversationId: 'cnv-1' });
		assert.deepEqual(parseSessionPatch({ generating: true }), { wasGenerating: true });
	});

	test('recusa caminho, conteúdo e campos desconhecidos', () => {
		for (const payload of [
			{ root: 'C:\\Windows' },
			{ conversationId: 'cnv-1', content: 'segredo' },
			{ conversationId: 'cnv-1', path: '../../etc' },
		]) {
			assert.throws(() => parseSessionPatch(payload), SessionMessageError, JSON.stringify(payload));
		}
	});

	test('recusa tipos e tamanhos inválidos', () => {
		for (const payload of [
			{ conversationId: '' },
			{ conversationId: 'x'.repeat(201) },
			{ conversationId: 42 },
			{ generating: 'sim' },
			{},
			null,
			'texto',
		]) {
			assert.throws(() => parseSessionPatch(payload), SessionMessageError, JSON.stringify(payload));
		}
	});

	test('o boot state nunca carrega caminho, token ou conteúdo', () => {
		assert.doesNotThrow(() => assertBootStateSafe({ conversationId: 'cnv-1', message: 'oi', canRetry: true }));
		for (const payload of [
			{ root: '/tmp' },
			{ conversationId: 'cnv-1', token: 'x' },
			// Uma credencial de verdade tem tamanho de credencial; `sk-123` é
			// um texto curto qualquer e não é tratado como segredo.
			{ message: 'a chave é sk-abcdefghijklmnop' },
			{ message: 'Bearer abcdefghijklmnop' },
		]) {
			assert.throws(() => assertBootStateSafe(payload as never), SessionMessageError, JSON.stringify(payload));
		}
	});

	test('a projeção para a janela leva só conversa e aviso', () => {
		const boot = toBootState({ conversationId: 'cnv-1', message: 'aviso', action: 'retry-turn' });

		assert.deepEqual(boot, { conversationId: 'cnv-1', message: 'aviso', canRetry: true });
	});
});

suite('DEV-4: decisão de abertura', () => {
	const pending = advance(
		startOperation({ conversationId: 'cnv-dev', strategy: 'restart-app', files: ['src/core/x.ts'] }),
		'written',
	);

	test('a operação pendente tem prioridade sobre a última aberta', () => {
		const decision = decideBoot({
			operation: pending,
			session: { lastConversationId: 'cnv-outra' },
			knownConversationIds: ['cnv-dev', 'cnv-outra'],
		});

		assert.equal(decision.conversationId, 'cnv-dev');
		assert.equal(decision.source, 'operation');
		assert.match(decision.message ?? '', /escrita mas não verificada/);
	});

	test('sem operação, reabre a última conversa', () => {
		const decision = decideBoot({ session: { lastConversationId: 'cnv-ultima' } });

		assert.equal(decision.conversationId, 'cnv-ultima');
		assert.equal(decision.source, 'last');
	});

	test('um id salvo que não existe cai para o comportamento padrão', () => {
		const decision = decideBoot({
			session: { lastConversationId: 'cnv-apagada' },
			knownConversationIds: ['cnv-1', 'cnv-2'],
		});

		assert.equal(decision.conversationId, undefined);
		assert.equal(decision.source, 'default');
	});

	test('o aviso de geração interrompida sobrevive à conversa inexistente', () => {
		const decision = decideBoot({
			session: { lastConversationId: 'cnv-apagada', wasGenerating: true },
			knownConversationIds: ['cnv-1'],
		});

		assert.equal(decision.conversationId, undefined);
		assert.match(decision.message ?? '', /interrompida/);
		assert.equal(decision.action, 'retry-turn');
	});

	test('sem nada guardado, nada é decidido (primeira da lista)', () => {
		const decision = decideBoot({ session: {} });

		assert.equal(decision.conversationId, undefined);
		assert.equal(decision.source, 'default');
	});

	test('uma operação concluída não sequestra a abertura', () => {
		const done = advance(pending, 'done');
		const decision = decideBoot({ operation: done, session: { lastConversationId: 'cnv-ultima' } });

		assert.equal(decision.conversationId, 'cnv-ultima');
		assert.equal(decision.source, 'last');
		assert.equal(decision.message, undefined);
	});
});

suite('DEV-4: abertura após recarga real da janela', () => {
	test('a conversa selecionada sobrevive à recarga (gravada antes, lida depois)', async () => {
		const dir = await makeDir();
		const store = new UiSessionStore(dir);
		// A janela estava nesta conversa e o usuário pediu uma mudança de estilo.
		await store.patch({ lastConversationId: 'cnv-estilo' });

		// "Recarga": a página some e o main lê o estado para a nova instância.
		const decision = decideBoot({
			session: await new UiSessionStore(dir).read(),
			knownConversationIds: ['cnv-estilo', 'cnv-outra'],
		});

		assert.equal(decision.conversationId, 'cnv-estilo');
		assert.equal(decision.source, 'last');
	});
});

suite('DEV-4: ApplyTarget do host', () => {
	test('recarga traz a janela de volta e a sondagem confirma', async () => {
		const repo = await makeRepo();
		const host = fakeHost();
		const target = createElectronApplyTarget({
			host,
			repositoryRoot: repo,
			runner: new DevRunner({ timeoutMs: 5_000 }),
		});

		await target.reloadUi();
		const probe = await target.probe();

		assert.deepEqual(host.calls, ['reload:15000']);
		assert.equal(probe.ok, true);
	});

	test('uma recarga que falha vira erro explícito, não sucesso', async () => {
		const repo = await makeRepo();
		const target = createElectronApplyTarget({
			host: fakeHost({ reloadFails: true }),
			repositoryRoot: repo,
			runner: new DevRunner({ timeoutMs: 5_000 }),
		});

		await assert.rejects(async () => await target.reloadUi(), ApplyHostError);
	});

	test('sem janela, recarregar é recusado', async () => {
		const repo = await makeRepo();
		const target = createElectronApplyTarget({
			host: fakeHost({ windowAlive: false }),
			repositoryRoot: repo,
			runner: new DevRunner({ timeoutMs: 5_000 }),
		});

		await assert.rejects(async () => await target.reloadUi(), /não há janela/);
		assert.equal((await target.probe()).ok, false);
	});

	test('o reinício é pedido uma vez só, mesmo que o fluxo chame de novo', async () => {
		const repo = await makeRepo();
		const host = fakeHost();
		const target = createElectronApplyTarget({
			host,
			repositoryRoot: repo,
			runner: new DevRunner({ timeoutMs: 5_000 }),
		});

		await target.restartApp({ controlled: false });
		await target.restartApp({ controlled: false });

		assert.deepEqual(host.calls, ['restart'], 'nunca dois reinícios para a mesma operação');
		assert.equal(target.restarted(), true);
	});

	test('as verificações rodam pelo runner do DEV (allowlist), não por um shell', async () => {
		const repo = await makeRepo();
		await writeFile(join(repo, 'package.json'), '{}', 'utf8');
		const target = createElectronApplyTarget({
			host: fakeHost(),
			repositoryRoot: repo,
			runner: new DevRunner({ timeoutMs: 20_000 }),
		});

		const ok = await target.runCheck('git status');
		// Um comando fora da allowlist é falha de verificação.
		const refused = await target.runCheck('powershell -c dir');

		assert.equal(ok.exitCode, 0);
		assert.equal(refused.exitCode, 1);
		assert.match(refused.summary, /não está na lista/);
	});
});

suite('DEV-4: fluxo completo com o host', () => {
	async function harness(options: { readonly reloadFails?: boolean; readonly probeOk?: boolean } = {}) {
		const repo = await makeRepo();
		const data = await makeDir('evelyn-dev4-data-');
		const checkpoints = new DevCheckpointStore(join(data, 'dev'));
		await checkpoints.init();
		const operations = new DevOperationStore(join(data, 'dev'));
		const session = new UiSessionStore(join(data, 'dev'));
		const host = fakeHost({ ...(options.reloadFails !== undefined ? { reloadFails: options.reloadFails } : {}) });
		const target = createElectronApplyTarget({
			host,
			repositoryRoot: repo,
			runner: new DevRunner({ timeoutMs: 20_000 }),
			...(options.probeOk === false
				? { probeWindow: async () => ({ ok: false, detail: 'a página voltou em branco' }) }
				: {}),
		});
		const request = (writes: readonly { path: string; content: string }[], files: readonly string[]) => ({
			conversationId: 'cnv-pedido',
			files,
			writes,
			root: repo,
			operations,
			checkpoints,
			async writeFile(path: string, content: string) {
				await mkdir(join(repo, path, '..'), { recursive: true });
				await writeFile(join(repo, path), content, 'utf8');
			},
		});
		return { repo, data, hang: { checkpoints, operations, session, host, target, request } };
	}

	test('mudança visual é aplicada e confirmada pela sondagem', async () => {
		const { hang } = await harness();
		const outcome = await applyChange(
			hang.request([{ path: 'src/desktop/renderer/index.css', content: ':root { --accent: #ff0080; }\n' }], [
				'src/desktop/renderer/index.css',
			]),
			hang.target,
		);

		assert.equal(outcome.kind, 'done');
		assert.deepEqual(hang.host.calls, ['reload:15000']);
	});

	test('pondo a conversa na sessão antes, a janela reabre na mesma conversa', async () => {
		const { hang } = await harness();
		await hang.session.patch({ lastConversationId: 'cnv-pedido' });
		await applyChange(
			hang.request([{ path: 'src/desktop/renderer/index.css', content: ':root{}\n' }], ['src/desktop/renderer/index.css']),
			hang.target,
		);

		const operation = await hang.operations.read();
		const decision = decideBoot({
			...(operation !== undefined ? { operation } : {}),
			session: await hang.session.read(),
			knownConversationIds: ['cnv-pedido'],
		});

		assert.equal(decision.conversationId, 'cnv-pedido');
	});

	test('falha na recarga preserva o checkpoint e desfaz', async () => {
		const { hang, repo } = await harness({ reloadFails: true });
		const original = await readFile(join(repo, 'src/desktop/renderer/index.css'), 'utf8');

		const outcome = await applyChange(
			hang.request([{ path: 'src/desktop/renderer/index.css', content: 'quebrado\n' }], ['src/desktop/renderer/index.css']),
			hang.target,
		);

		assert.equal(outcome.kind, 'rolled-back');
		assert.equal(await readFile(join(repo, 'src/desktop/renderer/index.css'), 'utf8'), original);
	});

	test('sondagem negativa após aplicar desfaz, nunca "concluído"', async () => {
		const { hang } = await harness({ probeOk: false });
		const outcome = await applyChange(
			hang.request([{ path: 'src/desktop/renderer/index.css', content: 'x\n' }], ['src/desktop/renderer/index.css']),
			hang.target,
		);

		assert.equal(outcome.kind, 'rolled-back');
		assert.match(outcome.kind === 'rolled-back' ? outcome.reason : '', /em branco/);
	});

	test('operação pendente é recuperada na abertura seguinte', async () => {
		const { hang } = await harness();
		// Um fluxo que morreu depois de escrever: grava a etapa e "reabre".
		let operation = startOperation({ conversationId: 'cnv-pedido', strategy: 'restart-app', files: ['a.ts'] });
		operation = advance(operation, 'written');
		await hang.operations.write(operation);

		// A abertura lê o registro do disco (outra instância, como no reinício).
		const decision = decideBoot({
			operation: await hang.operations.read(),
			session: {},
		});

		assert.equal(decision.conversationId, 'cnv-pedido');
		assert.equal(decision.source, 'operation');
		assert.match(decision.message ?? '', /não verificada/);
	});
});

suite('DEV-4: geração interrompida', () => {
	test('marcar antes e ler depois produz o aviso, sem repetir nada', async () => {
		const dir = await makeDir();
		const store = new UiSessionStore(dir);
		// Antes da recarga: havia um turno em andamento.
		await store.markGenerating(true);

		// Depois: a janela lê o estado.
		const decision = decideBoot({ session: await new UiSessionStore(dir).read() });

		assert.equal(decision.action, 'retry-turn');
		assert.match(decision.message ?? '', /não.*repetida/);
	});

	test('a janela limpa a marca ao abrir, para o aviso não se repetir', async () => {
		const dir = await makeDir();
		const store = new UiSessionStore(dir);
		await store.markGenerating(true);
		// Depois de mostrar o aviso, o renderer diz "não estou gerando".
		await store.patch({ wasGenerating: false });

		assert.equal(decideBoot({ session: await store.read() }).message, undefined);
	});
});
