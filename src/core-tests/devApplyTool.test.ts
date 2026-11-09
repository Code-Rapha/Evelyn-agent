/**
 * DEV-5: o gatilho `dev_apply`.
 *
 * ## O que é real
 *
 * Arquivos, checkpoints, operações e o fluxo `applyChange` inteiro rodam no
 * disco. O `DevRunner` roda processos de verdade (git). O único simulado é o
 * alvo do host (reload/restart), porque reiniciar o Electron encerraria a
 * suíte — e é exatamente o contrato que `electronApply` implementa.
 */
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DevSession } from '../core/dev/devSession';
import { DevCheckpointStore } from '../core/dev/devCheckpoint';
import { DevOperationStore } from '../core/dev/devOperation';
import { DevRunner } from '../core/dev/devRunner';
import { DevLocks } from '../core/dev/devLocks';
import { PreparedChangeJournal } from '../core/dev/preparedChange';
import type { ApplyTarget } from '../core/dev/devApply';
import { createDevTools, createDevToolEntries, type DevToolDeps } from '../core/agent/devTools';
import { createDevApplyTool, DEV_APPLY, type DevApplyDeps } from '../core/agent/devApplyTool';
import { createMvpAgentStack } from '../core/agent/composition';
import type { AgentTool, ToolExecutionContext } from '../core/agent/types';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const roots: string[] = [];
const ctx: ToolExecutionContext = { sessionId: 'test' };

async function makeRepo(): Promise<string> {
	const repo = await mkdtemp(join(tmpdir(), 'evelyn-dev5-'));
	roots.push(repo);
	execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
	await mkdir(join(repo, 'src', 'desktop', 'renderer'), { recursive: true });
	await writeFile(join(repo, 'src', 'desktop', 'renderer', 'index.css'), ':root { --accent: #3b82f6; }\n', 'utf8');
	return repo;
}

async function makeData(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'evelyn-dev5-data-'));
	roots.push(dir);
	return dir;
}

teardown(async () => {
	for (const root of roots.splice(0)) {
		await removeFixtureTree(root).catch(() => undefined);
	}
});

/**
 * O alvo do host simulado.
 *
 * `runCheck` devolve o que foi pedido — por omissão, sucesso. Em produção o
 * `ElectronApplyTarget` roda os comandos de verdade; aqui, o que se quer
 * provar é **qual** verificação foi exigida e em que ordem o host é acionado.
 * O `restart` nunca reinicia nada: registra a chamada e finge que voltou.
 */
function fakeTarget(
	options: { readonly reloadFails?: boolean; readonly probeOk?: boolean; readonly checkFails?: boolean } = {},
): ApplyTarget & {
	readonly calls: string[];
} {
	const calls: string[] = [];
	return {
		calls,
		async runCheck(command) {
			calls.push(`check:${command}`);
			return options.checkFails === true
				? { exitCode: 1, summary: 'a verificação falhou' }
				: { exitCode: 0, summary: 'ok' };
		},
		async reloadUi() {
			calls.push('reload');
			if (options.reloadFails === true) {
				throw new Error('a janela não voltou');
			}
		},
		async restartApp({ controlled }) {
			calls.push(`restart:${controlled ? 'controlled' : 'normal'}`);
		},
		async probe() {
			return options.probeOk === false
				? { ok: false, detail: 'a página voltou em branco' }
				: { ok: true, detail: 'a janela respondeu' };
		},
	};
}

interface Harness {
	readonly repo: string;
	readonly session: DevSession;
	readonly journal: PreparedChangeJournal;
	readonly tools: ReadonlyMap<string, AgentTool>;
	readonly deps: DevToolDeps;
	readonly target: ApplyTarget & { readonly calls: string[] };
	readonly operations: DevOperationStore;
	readonly checkpoints: DevCheckpointStore;
	/** Quantos alvos de host a ferramenta criou (um por aplicação). */
	readonly targets: () => number;
}

async function harness(
	options: {
		readonly reloadFails?: boolean;
		readonly probeOk?: boolean;
		readonly checkFails?: boolean;
		readonly withApply?: boolean;
		readonly enter?: boolean;
	} = {},
): Promise<Harness> {
	const repo = await makeRepo();
	const data = await makeData();
	const session = new DevSession({ repositoryRoot: repo });
	const journal = new PreparedChangeJournal();
	const checkpoints = new DevCheckpointStore(join(data, 'dev'));
	await checkpoints.init();
	const operations = new DevOperationStore(join(data, 'dev'));
	const target = fakeTarget({
		...(options.reloadFails !== undefined ? { reloadFails: options.reloadFails } : {}),
		...(options.probeOk !== undefined ? { probeOk: options.probeOk } : {}),
		...(options.checkFails !== undefined ? { checkFails: options.checkFails } : {}),
	});
	const runner = new DevRunner({ timeoutMs: 20_000 });
	const locks = new DevLocks();
	let targets = 0;

	const applyDeps: DevApplyDeps = {
		session,
		journal,
		operations,
		checkpoints,
		// O alvo é por aplicação; o teste conta as criações para provar que
		// nenhuma operação herda a memória de "já reiniciei" da anterior.
		createTarget() {
			targets += 1;
			return target;
		},
		async writeFile(path, content) {
			await mkdir(join(repo, path, '..'), { recursive: true });
			await writeFile(join(repo, path), content, 'utf8');
		},
	};
	const deps: DevToolDeps = {
		session,
		checkpoints,
		runner,
		locks,
		journal,
		...(options.withApply === false ? {} : { apply: applyDeps }),
	};
	const tools = new Map(createDevTools(deps).map((tool) => [tool.descriptor.name, tool]));
	if (options.enter !== false) {
		await session.enter();
	}
	return {
		repo,
		session,
		journal,
		tools,
		deps,
		target,
		operations,
		checkpoints,
		targets: () => targets,
	};
}

/** Prepara uma mudança de CSS pelo `dev_write` e devolve o id. */
async function prepareCss(harness: Harness, content = ':root { --accent: #ff0080; }\n'): Promise<string> {
	const result = await harness.tools.get('dev_write')!.execute(
		{ path: 'src/desktop/renderer/index.css', content },
		ctx,
	);
	assert.equal(result.ok, true, result.error);
	const operationId = (result.output as { readonly operationId?: string }).operationId;
	assert.equal(typeof operationId, 'string', 'dev_write devolve o id da operação');
	return operationId as string;
}

suite('DEV-5: a ferramenta existe só com sessão e alvo', () => {
	test('sem alvo do host, `dev_apply` não é registrada', async () => {
		const h = await harness({ withApply: false });

		assert.equal(h.tools.has(DEV_APPLY), false, 'sem como aplicar, a ferramenta não existe');
		// As demais continuam.
		assert.equal(h.tools.has('dev_write'), true);
	});

	test('com sessão e alvo, ela é registrada e entra no stack do agente', async () => {
		const h = await harness();

		assert.equal(h.tools.has(DEV_APPLY), true);
		const stack = createMvpAgentStack({ extraTools: createDevToolEntries(h.deps) });
		try {
			assert.equal(stack.registry.names().includes(DEV_APPLY), true);
		} finally {
			stack.dispose();
		}
	});

	test('a ferramenta é `dangerous`: pede confirmação no gateway', async () => {
		const h = await harness();
		const spec = createDevToolEntries(h.deps).find((entry) => entry.spec.name === DEV_APPLY);

		assert.equal(spec?.spec.riskLevel, 'dangerous');
		assert.equal(h.tools.get(DEV_APPLY)?.descriptor.riskLevel, 'dangerous');
	});
});

suite('DEV-5: autorização no momento de aplicar', () => {
	test('recusa quando a sessão DEV não está ativa', async () => {
		const h = await harness({ enter: false });
		// Prepara a operação "por fora" — o diário tem algo, mas a sessão não.
		h.journal.start({ root: await makeRepo(), files: [], sessionToken: 'sem-sessao' });

		const result = await h.tools.get(DEV_APPLY)!.execute({}, ctx);

		assert.equal(result.ok, false);
		assert.match(result.error ?? '', /modo DEV não está ativo/);
	});

	test('recusa depois de a sessão ser encerrada, mesmo com o diário preenchido', async () => {
		const h = await harness();
		const operationId = await prepareCss(h);
		await h.session.exit();

		const result = await h.tools.get(DEV_APPLY)!.execute({ operationId }, ctx);

		assert.equal(result.ok, false);
		assert.match(result.error ?? '', /modo DEV não está ativo/);
	});

	test('registrar a ferramenta não é autorização: sem `enter`, não aplica', async () => {
		const repo = await makeRepo();
		const data = await makeData();
		const session = new DevSession({ repositoryRoot: repo });
		const journal = new PreparedChangeJournal();
		const checkpoints = new DevCheckpointStore(join(data, 'dev'));
		await checkpoints.init();
		const operations = new DevOperationStore(join(data, 'dev'));
		// O diário aponta para a raiz correta, mas não há sessão.
		journal.start({ root: repo, files: ['a.css'], sessionToken: 'nunca-autorizado' });
		const tool = createDevApplyTool({
			session,
			journal,
			operations,
			checkpoints,
			createTarget: () => fakeTarget(),
			writeFile: async () => undefined,
		});

		const result = await tool.execute({}, ctx);

		assert.equal(result.ok, false);
	});

	test('operação preparada numa sessão anterior não atravessa um novo `enter`', async () => {
		const h = await harness();
		const operationId = await prepareCss(h);
		// O proprietário sai e entra de novo: a autorização anterior acabou.
		await h.session.exit();
		await h.session.enter();

		const result = await h.tools.get(DEV_APPLY)!.execute({ operationId, confirm: true }, ctx);

		assert.equal(result.ok, false);
		assert.match(result.error ?? '', /sessão DEV anterior/);
		assert.equal(h.target.calls.length, 0, 'nada foi aplicado');
	});

	test('o token da sessão nunca aparece no resultado entregue ao modelo', async () => {
		const h = await harness();
		const operationId = await prepareCss(h);
		const token = h.session.sessionToken();

		const result = await h.tools.get(DEV_APPLY)!.execute({ operationId, confirm: true }, ctx);

		assert.equal(result.ok, true, result.error);
		assert.equal(JSON.stringify(result).includes(token), false, 'nem no sucesso o token vaza');
	});
});

suite('DEV-5: operação inválida, de outra raiz ou já aplicada', () => {
	test('operação inexistente é recusada', async () => {
		const h = await harness();

		const result = await h.tools.get(DEV_APPLY)!.execute({ operationId: 'devop-nao-existe', confirm: true }, ctx);

		assert.equal(result.ok, false);
		assert.match(result.error ?? '', /não há operação/);
		assert.equal(h.target.calls.length, 0, 'nada foi aplicado');
	});

	test('sem operação preparada, o gatilho recusa em vez de inventar', async () => {
		const h = await harness();

		const result = await h.tools.get(DEV_APPLY)!.execute({}, ctx);

		assert.equal(result.ok, false);
		assert.match(result.error ?? '', /não há operação preparada/);
	});

	test('operação de outra raiz é recusada', async () => {
		const h = await harness();
		// O diário recebe uma operação cuja raiz é OUTRA.
		const other = await makeRepo();
		const foreign = h.journal.start({
			root: other,
			files: ['x.css'],
			sessionToken: h.session.sessionToken(),
		});
		h.journal.note({ operationId: foreign.operationId, path: 'x.css', content: 'x' });

		const result = await h.tools.get(DEV_APPLY)!.execute({ operationId: foreign.operationId, confirm: true }, ctx);

		assert.equal(result.ok, false);
		assert.match(result.error ?? '', /outro repositório/);
		assert.equal(h.target.calls.length, 0);
	});

	test('um id que já foi aplicado não é reaplicado', async () => {
		const h = await harness();
		const operationId = await prepareCss(h);

		const first = await h.tools.get(DEV_APPLY)!.execute({ operationId, confirm: true }, ctx);
		assert.equal(first.ok, true, first.error);
		const callsAfterFirst = [...h.target.calls];

		const second = await h.tools.get(DEV_APPLY)!.execute({ operationId, confirm: true }, ctx);

		assert.equal(second.ok, false);
		assert.match(second.error ?? '', /não há operação/);
		assert.deepEqual(h.target.calls, callsAfterFirst, 'nenhuma recarga extra');
	});

	test('operação concluída no store não é aplicada de novo', async () => {
		const h = await harness();
		const operationId = await prepareCss(h);
		// A **mesma** operação (mesmo nonce), já concluída no store.
		const nonce = h.journal.get(operationId)!.nonce;
		await h.operations.write({
			version: 1,
			nonce,
			stage: 'done',
			strategy: 'hot',
			files: ['src/desktop/renderer/index.css'],
			checks: [],
			results: [],
			startedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		});

		const result = await h.tools.get(DEV_APPLY)!.execute({ operationId, confirm: true }, ctx);

		assert.equal(result.ok, false);
		assert.match(result.error ?? '', /já foi aplicada/);
		assert.equal(h.target.calls.length, 0, 'nada foi recarregado');
	});

	test('um registro de outra operação no store não conta como aplicação desta', async () => {
		const h = await harness();
		const operationId = await prepareCss(h);
		const expectedNonce = h.journal.get(operationId)!.nonce;
		// A operação que está no store é OUTRA (outro nonce), concluída.
		await h.operations.write({
			version: 1,
			nonce: 'outra-operacao',
			stage: 'done',
			strategy: 'hot',
			files: ['a.css'],
			checks: [],
			results: [],
			startedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		});

		const result = await h.tools.get(DEV_APPLY)!.execute({ operationId, confirm: true }, ctx);

		// Não é "já aplicada": esta operação nunca foi aplicada, e aplica.
		assert.equal(result.ok, true, result.error);
		const operation = await h.operations.read();
		assert.equal(operation?.nonce, expectedNonce);
		assert.equal(operation?.stage, 'done');
	});
});

suite('DEV-5: aplicação completa', () => {
	test('checkpoint, verificação, recarga e confirmação', async () => {
		const h = await harness();
		const operationId = await prepareCss(h);

		const result = await h.tools.get(DEV_APPLY)!.execute({ operationId, confirm: true }, ctx);

		assert.equal(result.ok, true, result.error);
		assert.deepEqual(h.target.calls, ['reload'], 'estilo: só a janela recarrega');
		assert.equal(
			await readFile(join(h.repo, 'src/desktop/renderer/index.css'), 'utf8'),
			':root { --accent: #ff0080; }\n',
		);
		const operation = await h.operations.read();
		assert.equal(operation?.stage, 'done');
	});

	test('mudança de Core exige reinício, não recarga', async () => {
		const h = await harness();
		const written = await h.tools.get('dev_write')!.execute(
			{ path: 'src/core/storage/x.ts', content: 'export const x = 1;\n' },
			ctx,
		);
		assert.equal(written.ok, true, written.error);
		const operationId = (written.output as { readonly operationId: string }).operationId;

		const result = await h.tools.get(DEV_APPLY)!.execute({ operationId, confirm: true }, ctx);

		// A estratégia vem da política, não do agente: Core → reinício normal,
		// com as duas verificações exigidas, e nenhuma recarga de janela.
		assert.equal(result.ok, true, result.error);
		assert.deepEqual(h.target.calls, ['check:npm run check-types', 'check:npm run test:core', 'restart:normal']);
	});

	test('mudança em arquivo crítico exige reinício controlado', async () => {
		const h = await harness();
		const written = await h.tools.get('dev_write')!.execute(
			{ path: 'src/core/dev/devApply.ts', content: '// mudado\n' },
			ctx,
		);
		assert.equal(written.ok, true, written.error);
		const operationId = (written.output as { readonly operationId: string }).operationId;

		const result = await h.tools.get(DEV_APPLY)!.execute({ operationId, confirm: true }, ctx);

		assert.equal(result.ok, true, result.error);
		assert.deepEqual(h.target.calls, [
			'check:npm run check-types',
			'check:npm run test:core',
			'check:npm run lint',
			'check:npm run web:build',
			'check:npm run desktop:build',
			'restart:controlled',
		]);
	});

	test('verificação que falha antes de aplicar: nada é recarregado', async () => {
		const h = await harness({ checkFails: true });
		// HTML é `reload-ui`, que exige `npm run check-types` antes.
		const written = await h.tools.get('dev_write')!.execute(
			{ path: 'src/desktop/renderer/index.html', content: '<!doctype html><title>x</title>\n' },
			ctx,
		);
		assert.equal(written.ok, true, written.error);
		const operationId = (written.output as { readonly operationId: string }).operationId;

		const result = await h.tools.get(DEV_APPLY)!.execute({ operationId, confirm: true }, ctx);

		assert.equal(result.ok, false);
		assert.match(result.error ?? '', /não aplicada/);
		assert.deepEqual(h.target.calls, ['check:npm run check-types'], 'parou na verificação; não recarregou');
		const operation = await h.operations.read();
		assert.equal(operation?.stage, 'verification-failed');
	});

	test('a operação é consumida: o diário não guarda o que já foi aplicado', async () => {
		const h = await harness();
		const operationId = await prepareCss(h);

		await h.tools.get(DEV_APPLY)!.execute({ operationId, confirm: true }, ctx);

		assert.equal(h.journal.get(operationId), undefined);
	});
});

suite('DEV-5: falhas', () => {
	test('falha na recarga desfaz e preserva o checkpoint', async () => {
		const h = await harness({ reloadFails: true });
		const operationId = await prepareCss(h);
		const original = await readFile(join(h.repo, 'src/desktop/renderer/index.css'), 'utf8');

		const result = await h.tools.get(DEV_APPLY)!.execute({ operationId, confirm: true }, ctx);

		assert.equal(result.ok, false);
		assert.match(result.error ?? '', /desfeita/);
		assert.equal(await readFile(join(h.repo, 'src/desktop/renderer/index.css'), 'utf8'), original);
	});

	test('verificação final negativa desfaz, nunca sucesso', async () => {
		const h = await harness({ probeOk: false });
		const operationId = await prepareCss(h);

		const result = await h.tools.get(DEV_APPLY)!.execute({ operationId, confirm: true }, ctx);

		assert.equal(result.ok, false);
		assert.match(result.error ?? '', /desfeita/);
	});

	test('conflito externo durante a restauração não sobrescreve o arquivo', async () => {
		const h = await harness({ probeOk: false });
		const operationId = await prepareCss(h);
		// Alguém mexe no arquivo depois da escrita do DEV e antes do desfazer.
		const path = join(h.repo, 'src/desktop/renderer/index.css');
		const probeTarget: ApplyTarget = {
			...h.target,
			async probe() {
				await writeFile(path, 'alterado por fora\n', 'utf8');
				return { ok: false, detail: 'a página voltou em branco' };
			},
		};
		const tool = createDevApplyTool({
			session: h.session,
			journal: h.journal,
			operations: h.operations,
			checkpoints: h.checkpoints,
			createTarget: () => probeTarget,
			writeFile: async (p, c) => {
				await mkdir(join(h.repo, p, '..'), { recursive: true });
				await writeFile(join(h.repo, p), c, 'utf8');
			},
		});

		const result = await tool.execute({ operationId, confirm: true }, ctx);

		assert.equal(result.ok, false);
		assert.equal(await readFile(path, 'utf8'), 'alterado por fora\n', 'a alteração externa foi preservada');
	});
});

suite('DEV-5: concorrência e dupla aplicação', () => {
	test('duas chamadas concorrentes: uma aplica, a outra é recusada', async () => {
		const h = await harness();
		const operationId = await prepareCss(h);

		const tool = h.tools.get(DEV_APPLY)!;
		const [first, second] = await Promise.all([
			tool.execute({ operationId, confirm: true }, ctx),
			tool.execute({ operationId, confirm: true }, ctx),
		]);

		const okCount = [first, second].filter((result) => result.ok).length;
		assert.equal(okCount, 1, 'exatamente uma aplicação');
		const refused = [first, second].find((result) => !result.ok);
		assert.match(refused?.error ?? '', /já está sendo aplicada|não há operação/);
		assert.deepEqual(h.target.calls, ['reload'], 'uma recarga, não duas');
	});

	test('falhas e recusas liberam a trava da operação', async () => {
		const h = await harness({ reloadFails: true });
		const operationId = await prepareCss(h);

		await h.tools.get(DEV_APPLY)!.execute({ operationId, confirm: true }, ctx);

		// A operação foi desfeita e consumida; o registro não fica preso.
		const second = await h.tools.get(DEV_APPLY)!.execute({ operationId, confirm: true }, ctx);
		assert.equal(second.ok, false);
		assert.match(second.error ?? '', /não há operação/);
	});

	test('a trava do repositório volta livre depois da aplicação', async () => {
		const h = await harness();
		const operationId = await prepareCss(h);
		await h.tools.get(DEV_APPLY)!.execute({ operationId, confirm: true }, ctx);

		assert.equal(h.deps.locks.isHeld(String(h.repo).toLowerCase()), false);
	});
});

suite('DEV-5: usuário comum não alcança o gatilho', () => {
	test('sem sessão DEV, nenhuma ferramenta dev_* responde', async () => {
		const h = await harness({ enter: false });

		for (const name of ['dev_read', 'dev_write', 'dev_run', DEV_APPLY]) {
			const tool = h.tools.get(name);
			if (tool === undefined) {
				continue;
			}
			const result = await tool.execute({ path: 'x.css', content: 'x' }, ctx);
			assert.equal(result.ok, false, name);
			assert.match(result.error ?? '', /modo DEV não está ativo|não há operação/, name);
		}
	});

	test('o gatilho não cria sessão nem lê raiz de argumento', async () => {
		const h = await harness();
		const source = await readFile(join(process.cwd(), 'src', 'core', 'agent', 'devApplyTool.ts'), 'utf8');

		assert.equal(/\.enter\(|new DevSession/.test(source), false, 'o gatilho não abre sessão');
		assert.equal(/input\.root|payload\.root/.test(source), false, 'a raiz nunca vem do argumento');
	});
});

suite('DEV-AUDIT-03: a aplicação exige confirmação explícita', () => {
	test('sem `confirm`, nada é aplicado e a operação continua disponível', async () => {
		const h = await harness();
		const operationId = await prepareCss(h);

		const refused = await h.tools.get(DEV_APPLY)!.execute({ operationId }, ctx);

		assert.equal(refused.ok, false);
		assert.match(refused.error ?? '', /confirmação explícita/);
		assert.equal(h.target.calls.length, 0, 'o alvo não foi acionado');
		// O ponto da correção: a operação **não** foi consumida. Uma segunda
		// tentativa, confirmada, ainda aplica.
		const confirmed = await h.tools.get(DEV_APPLY)!.execute({ operationId, confirm: true }, ctx);
		assert.equal(confirmed.ok, true, confirmed.error);
	});

	test('sem `confirm` e sem operação, a mensagem fala da operação (mais útil)', async () => {
		const h = await harness();

		const result = await h.tools.get(DEV_APPLY)!.execute({}, ctx);

		assert.equal(result.ok, false);
		assert.match(result.error ?? '', /não há operação preparada/);
	});

	test('`confirm` com valor diferente de `true` não basta', async () => {
		const h = await harness();
		const operationId = await prepareCss(h);

		for (const confirm of ['true', 1, 'sim', null]) {
			const result = await h.tools.get(DEV_APPLY)!.execute({ operationId, confirm }, ctx);
			assert.equal(result.ok, false, String(confirm));
			assert.match(result.error ?? '', /confirmação explícita/);
		}
		assert.equal(h.target.calls.length, 0);
	});

	test('a recusa por falta de confirmação vem depois das checagens de operação', async () => {
		const h = await harness();
		const operationId = await prepareCss(h);
		await h.session.exit();

		const result = await h.tools.get(DEV_APPLY)!.execute({ operationId }, ctx);

		// Sessão inativa é o motivo mais forte: a mensagem diz isso, não a
		// confirmação.
		assert.match(result.error ?? '', /modo DEV não está ativo/);
	});
});
