/**
 * DEV-3: aplicação segura das mudanças e continuidade da conversa.
 *
 * ## O que estes testes garantem
 *
 * Cada um exercita um arquivo real, um checkpoint real e um resultado real do
 * fluxo — não um mock de "applyChange devolveu done". A reinicialização é
 * simulada pelo alvo injetado (`restartApp`), que é justamente o contrato do
 * host: o núcleo **pede** o reinício, nunca o executa.
 */
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	coversStrategy,
	normalizeRepoPath,
	planApply,
	type ApplyStrategy,
} from '../core/dev/applyPolicy';
import {
	advance,
	DevOperationStore,
	isUnfinished,
	startOperation,
	type DevOperation,
} from '../core/dev/devOperation';
import { decideResume, missingChecks, REQUIRED_CHECKS } from '../core/dev/devContinuity';
import { DevCheckpointStore } from '../core/dev/devCheckpoint';
import { applyChange, applyPrepared, ApplyStateError, type ApplyTarget } from '../core/dev/devApply';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const roots: string[] = [];

async function makeRepo(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'evelyn-dev3-'));
	roots.push(root);
	execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
	await mkdir(join(root, 'src', 'desktop', 'renderer'), { recursive: true });
	await writeFile(join(root, 'src', 'desktop', 'renderer', 'index.css'), ':root { --accent: #3b82f6; }\n', 'utf8');
	return root;
}

async function makeData(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'evelyn-dev3-data-'));
	roots.push(root);
	return root;
}

teardown(async () => {
	for (const root of roots.splice(0)) {
		await removeFixtureTree(root).catch(() => undefined);
	}
});

/** Um alvo que registra os pedidos, sem recarregar nada de verdade. */
function fakeTarget(options: {
	readonly checkResult?: (command: string) => { readonly exitCode: number; readonly summary: string };
	readonly probe?: { readonly ok: boolean; readonly detail: string };
	readonly reloadFails?: boolean;
} = {}): ApplyTarget & { readonly calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		async runCheck(command) {
			calls.push(`check:${command}`);
			return options.checkResult?.(command) ?? { exitCode: 0, summary: 'ok' };
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
			calls.push('probe');
			return options.probe ?? { ok: true, detail: 'a nova versão respondeu' };
		},
	};
}

interface Harness {
	readonly repo: string;
	readonly operations: DevOperationStore;
	readonly checkpoints: DevCheckpointStore;
	request(files: readonly string[], writes?: readonly { readonly path: string; readonly content: string }[]): Parameters<typeof applyChange>[0];
}

async function harness(): Promise<Harness> {
	const repo = await makeRepo();
	const data = await makeData();
	const checkpoints = new DevCheckpointStore(join(data, 'dev'));
	await checkpoints.init();
	const operations = new DevOperationStore(join(data, 'dev'));
	return {
		repo,
		operations,
		checkpoints,
		request(files, writes) {
			const list = writes ?? [{ path: files[0] as string, content: 'novo conteúdo\n' }];
			return {
				conversationId: 'cnv-1',
				files,
				writes: list,
				root: repo,
				operations,
				checkpoints,
				async writeFile(path, content) {
					await mkdir(join(repo, path, '..'), { recursive: true });
					await writeFile(join(repo, path), content, 'utf8');
				},
			};
		},
	};
}

suite('DEV-3: política de aplicação', () => {
	const cases: readonly (readonly [readonly string[], ApplyStrategy])[] = [
		[['src/desktop/renderer/index.css'], 'hot'],
		[['src/desktop/renderer/index.ts'], 'reload-ui'],
		[['src/desktop/renderer/index.html'], 'reload-ui'],
		[['src/core/storage/turnRecords.ts'], 'restart-app'],
		[['src/adapters/local/fileDataStore.ts'], 'restart-app'],
		[['src/desktop/main.ts'], 'restart-controlled'],
		[['src/core/dev/devFileLock.ts'], 'restart-controlled'],
		[['src/core/permissions/gateway.ts'], 'restart-controlled'],
	];
	for (const [files, expected] of cases) {
		test(`${files.join(', ')} → ${expected}`, () => {
			assert.equal(planApply(files).strategy, expected);
		});
	}

	test('um arquivo crítico puxa a mudança inteira para o reinício controlado', () => {
		const plan = planApply(['src/desktop/renderer/index.css', 'src/core/permissions/gateway.ts']);

		assert.equal(plan.strategy, 'restart-controlled');
		assert.deepEqual(plan.decisive, ['src/core/permissions/gateway.ts']);
	});

	test('um arquivo de Core puxa para reinício do app', () => {
		assert.equal(planApply(['src/desktop/renderer/index.ts', 'src/core/dev/devRunner.ts']).strategy, 'restart-controlled');
		assert.equal(planApply(['src/desktop/renderer/index.ts', 'src/core/storage/turnRecords.ts']).strategy, 'restart-app');
	});

	test('sem arquivos não há aplicação', () => {
		const plan = planApply([]);
		assert.equal(plan.strategy, 'restart-controlled');
		assert.equal(plan.extraChecks.length > 0, true);
	});

	test('caminhos com barra do Windows são normalizados', () => {
		assert.equal(normalizeRepoPath('.\\src\\desktop\\renderer\\index.css'), 'src/desktop/renderer/index.css');
		assert.equal(planApply(['src\\desktop\\renderer\\index.css']).strategy, 'hot');
	});

	test('a explicação ao proprietário diz o que vai acontecer', () => {
		assert.match(planApply(['src/desktop/renderer/index.css']).explanation, /na hora/);
		assert.match(planApply(['src/core/storage/turnRecords.ts']).explanation, /reiniciado/);
		assert.match(planApply(['src/desktop/main.ts']).explanation, /controlada/);
	});

	test('a cobertura de estratégia é ordenada', () => {
		assert.equal(coversStrategy('reload-ui', 'hot'), true);
		assert.equal(coversStrategy('hot', 'reload-ui'), false);
		assert.equal(coversStrategy('restart-controlled', 'restart-app'), true);
	});
});

suite('DEV-3: alteração visual sem reiniciar', () => {
	test('CSS aplica com recarga da janela, sem reiniciar e sem verificação extra', async () => {
		const h = await harness();
		const target = fakeTarget();

		const outcome = await applyChange(
			h.request(['src/desktop/renderer/index.css'], [
				{ path: 'src/desktop/renderer/index.css', content: ':root { --accent: #ff0080; }\n' },
			]),
			target,
		);

		assert.equal(outcome.kind, 'done');
		assert.deepEqual(target.calls, ['reload', 'probe']);
		assert.equal(
			await readFile(join(h.repo, 'src/desktop/renderer/index.css'), 'utf8'),
			':root { --accent: #ff0080; }\n',
		);
	});

	test('a operação sai concluída e ninguém pede reinício', async () => {
		const h = await harness();
		const target = fakeTarget();

		const outcome = await applyChange(h.request(['src/desktop/renderer/index.css']), target);

		assert.equal(outcome.operation.strategy, 'hot');
		assert.equal(outcome.operation.stage, 'done');
		assert.equal(target.calls.some((call) => call.startsWith('restart')), false);
	});
});

suite('DEV-3: recarga da interface preserva a conversa', () => {
	test('a operação guarda a conversa e a reabertura aponta para ela', async () => {
		const h = await harness();
		const target = fakeTarget();

		const outcome = await applyChange(h.request(['src/desktop/renderer/index.ts']), target);
		assert.equal(outcome.kind, 'done');

		// DEV-4: só a operação **pendente** tem precedência. Concluída, quem
		// manda é a última conversa em que o usuário estava — reabrir na
		// conversa da mudança antiga seria pular a pessoa para trás.
		const notice = decideResume({ operation: outcome.operation, restored: { lastConversationId: 'outra' } });
		assert.equal(notice.conversationId, 'outra');

		// Enquanto está a meio caminho, a conversa da operação é a que abre.
		const pending = advance(outcome.operation, 'applying');
		assert.equal(decideResume({ operation: pending, restored: { lastConversationId: 'outra' } }).conversationId, 'cnv-1');
	});

	test('sem operação pendente, volta a última conversa aberta', () => {
		const notice = decideResume({ restored: { lastConversationId: 'cnv-antiga' } });

		assert.equal(notice.conversationId, 'cnv-antiga');
		assert.equal(notice.message, undefined);
	});

	test('sem nada guardado, o comportamento antigo (primeira da lista) continua', () => {
		const notice = decideResume({});

		assert.equal(notice.conversationId, undefined);
		assert.equal(notice.message, undefined);
	});
});

suite('DEV-3: reinicialização com estado persistido', () => {
	test('a operação sobrevive a um "reinício" (novo store, mesmo diretório)', async () => {
		const repo = await makeRepo();
		const data = await makeData();
		const checkpoints = new DevCheckpointStore(join(data, 'dev'));
		await checkpoints.init();
		const operations = new DevOperationStore(join(data, 'dev'));
		const target = fakeTarget();

		const outcome = await applyChange(
			{
				conversationId: 'cnv-1',
				files: ['src/core/storage/turnRecords.ts'],
				writes: [{ path: 'src/core/storage/turnRecords.ts', content: '// alterado\n' }],
				root: repo,
				operations,
				checkpoints,
				async writeFile(path, content) {
					await mkdir(join(repo, 'src', 'core', 'storage'), { recursive: true });
					await writeFile(join(repo, path), content, 'utf8');
				},
			},
			target,
		);
		assert.equal(outcome.kind, 'done', outcome.kind === 'done' ? '' : String((outcome as { reason?: string }).reason));

		// "Reinício": **outra instância** do store, lendo do mesmo disco.
		const reopened = new DevOperationStore(join(data, 'dev'));
		const read = await reopened.read();

		assert.notEqual(read, undefined);
		assert.equal(read?.conversationId, 'cnv-1');
		assert.equal(read?.strategy, 'restart-app');
		assert.equal(read?.stage, 'done');
	});

	test('o registro é gravado fora do repositório (não é alcançável por dev_write)', async () => {
		const h = await harness();
		await h.operations.write(startOperation({ strategy: 'hot', files: ['a.css'] }));
		const inRepo = existsSync(join(h.repo, 'operation.json'));

		assert.equal(inRepo, false, 'o registro não fica no repositório');
		assert.notEqual(await h.operations.read(), undefined);
	});

	test('um registro ilegível não impede abrir: é "não há operação"', async () => {
		const corruptDir = await makeData();
		const corrupt = new DevOperationStore(corruptDir);
		await mkdir(corruptDir, { recursive: true });
		await writeFile(join(corruptDir, 'operation.json'), '{ isto não é json', 'utf8');

		assert.equal(await corrupt.read(), undefined);
	});

	test('interrupção no meio: a etapa registrada diz onde parou', async () => {
		const storeRoot = await makeData();
		const store = new DevOperationStore(storeRoot);
		let operation = startOperation({ conversationId: 'cnv-9', strategy: 'restart-app', files: ['src/core/x.ts'] });
		operation = advance(operation, 'checkpointed', { checkpointId: 'ck-1' });
		await store.write(operation);
		operation = advance(operation, 'written');
		await store.write(operation);

		// O processo "morre" aqui: nada de verified, applying, done.
		const read = await store.read();

		assert.equal(read?.stage, 'written');
		assert.equal(isUnfinished(read), true);
		const notice = decideResume({ operation: read });
		assert.match(notice.message ?? '', /escrita mas não verificada/);
		assert.equal(notice.conversationId, 'cnv-9');
	});

	test('interrupção durante a aplicação: o aviso não oferece reaplicar', async () => {
		// DEV-5: em `applying`, a recarga ou reinício **pode** já ter
		// acontecido. Reaplicar seria uma segunda reinicialização para a mesma
		// operação — o que o fluxo não pode fazer.
		const storeRoot = await makeData();
		const store = new DevOperationStore(storeRoot);
		const operation = advance(
			startOperation({ strategy: 'restart-app', files: ['src/core/x.ts'] }),
			'applying',
		);
		await store.write(operation);

		const notice = decideResume({ operation: await store.read() });

		assert.match(notice.message ?? '', /não\*\* vou reaplicar/);
		assert.equal(/reaplicar ou desfazer/.test(notice.message ?? ''), false);
		assert.equal(notice.action, undefined, 'nada é retomado automaticamente');
	});
});

suite('DEV-5: applyPrepared adota a operação preparada', () => {
	/** Um pedido com a operação já registrada (o que o `dev_write` deixa). */
	async function prepared(h: Harness, operation: DevOperation, writes: readonly { readonly path: string; readonly content: string }[]) {
		return {
			operation,
			writes,
			root: h.repo,
			operations: h.operations,
			checkpoints: h.checkpoints,
			writeFile: async (path: string, content: string) => {
				await mkdir(join(h.repo, path, '..'), { recursive: true });
				await writeFile(join(h.repo, path), content, 'utf8');
			},
		};
	}

	test('o fluxo grava as etapas no store, com o mesmo nonce da preparação', async () => {
		const h = await harness();
		const operation: DevOperation = {
			...startOperation({ strategy: 'hot', files: ['src/desktop/renderer/index.css'] }),
			nonce: 'nonce-da-preparacao',
		};
		const target = fakeTarget();

		const outcome = await applyPrepared(
			await prepared(h, operation, [
				{ path: 'src/desktop/renderer/index.css', content: ':root { --accent: #ff0080; }\n' },
			]),
			target,
		);

		assert.equal(outcome.kind, 'done');
		const stored = await h.operations.read();
		assert.equal(stored?.stage, 'done');
		assert.equal(stored?.nonce, 'nonce-da-preparacao', 'o id da operação não muda no caminho');
		assert.deepEqual(target.calls, ['reload', 'probe']);
	});

	test('operação sem escritas é recusada, nunca "done" sem escrever', async () => {
		const h = await harness();
		const operation: DevOperation = {
			...startOperation({ strategy: 'hot', files: ['src/desktop/renderer/index.css'] }),
			nonce: 'nonce',
		};
		const target = fakeTarget();

		await assert.rejects(applyPrepared(await prepared(h, operation, []), target), ApplyStateError);
		assert.deepEqual(target.calls, [], 'nada foi recarregado');
	});

	test('operação já concluída não é adotada de novo', async () => {
		const h = await harness();
		const done = advance(
			{ ...startOperation({ strategy: 'hot', files: ['src/desktop/renderer/index.css'] }), nonce: 'n' },
			'done',
		);
		const target = fakeTarget();

		await assert.rejects(
			applyPrepared(await prepared(h, done, [{ path: 'src/desktop/renderer/index.css', content: 'x' }]), target),
			ApplyStateError,
		);
		assert.deepEqual(target.calls, []);
	});
});

suite('DEV-3: falha após o checkpoint e recuperação', () => {
	test('falha na verificação não aplica, e o checkpoint devolve o arquivo original', async () => {
		const h = await harness();
		const original = await readFile(join(h.repo, 'src/desktop/renderer/index.css'), 'utf8');
		const target = fakeTarget({ checkResult: () => ({ exitCode: 1, summary: '3 testes falharam' }) });

		const outcome = await applyChange(
			h.request(['src/desktop/renderer/index.ts'], [
				{ path: 'src/desktop/renderer/index.css', content: 'quebrado\n' },
			]),
			target,
		);

		assert.equal(outcome.kind, 'verification-failed');
		assert.match(outcome.operation.results.join(' '), /falhou/);
		// Nada foi recarregado nem reiniciado.
		assert.equal(target.calls.some((call) => call === 'reload' || call.startsWith('restart')), false);

		// O checkpoint devolve o original.
		const restored = await h.checkpoints.restoreAll(h.repo, 'dev-apply', { force: true });
		assert.equal(restored.restored.includes('src/desktop/renderer/index.css'), true);
		assert.equal(await readFile(join(h.repo, 'src/desktop/renderer/index.css'), 'utf8'), original);
	});

	test('falha ao conferir a nova versão desfaz e NÃO é sucesso', async () => {
		const h = await harness();
		const original = await readFile(join(h.repo, 'src/desktop/renderer/index.css'), 'utf8');
		const target = fakeTarget({ probe: { ok: false, detail: 'a janela abriu em branco' } });

		const outcome = await applyChange(
			h.request(['src/desktop/renderer/index.css'], [
				{ path: 'src/desktop/renderer/index.css', content: 'visual novo\n' },
			]),
			target,
		);

		assert.equal(outcome.kind, 'rolled-back');
		assert.match(outcome.kind === 'rolled-back' ? outcome.reason : '', /em branco/);
		assert.equal(await readFile(join(h.repo, 'src/desktop/renderer/index.css'), 'utf8'), original);
	});

	test('se o próprio desfazer falhar, o diagnóstico é preservado e não vira sucesso', async () => {
		const h = await harness();
		// Um store de checkpoint que **falha** ao restaurar: é a condição que
		// precisa ser dita, não escondida atrás de "concluído".
		const failing = Object.create(h.checkpoints) as DevCheckpointStore;
		(failing as unknown as { restoreAll: () => Promise<never> }).restoreAll = async () => {
			throw new Error('o checkpoint não pôde ser lido');
		};
		const target = fakeTarget({ probe: { ok: false, detail: 'quebrou' } });

		const outcome = await applyChange(
			{
				...h.request(['src/desktop/renderer/index.css'], [
					{ path: 'src/desktop/renderer/index.css', content: 'x\n' },
				]),
				checkpoints: failing,
			},
			target,
		);

		assert.equal(outcome.kind, 'rollback-failed');
		const stage = outcome.operation.stage;
		assert.notEqual(stage, 'done');
		assert.match(outcome.operation.results.join(' '), /desfazer falhou/);
	});

	test('uma falha de escrita para antes da verificação e mantém o checkpoint', async () => {
		const h = await harness();
		const target = fakeTarget();

		const outcome = await applyChange(
			{
				...h.request(['src/desktop/renderer/index.css']),
				async writeFile() {
					throw new Error('disco recusou');
				},
			},
			target,
		);

		assert.equal(outcome.kind, 'verification-failed');
		assert.match(outcome.operation.results.join(' '), /escrita falhou/);
		assert.equal(target.calls.includes('probe'), false);
	});
});

suite('DEV-3: alteração crítica exige reinício controlado', () => {
	test('um arquivo de permissões pede reinício controlado e roda todas as verificações', async () => {
		const h = await harness();
		const target = fakeTarget();

		const outcome = await applyChange(
			h.request(['src/core/permissions/gateway.ts'], [
				{ path: 'src/core/permissions/gateway.ts', content: '// alterado\n' },
			]),
			target,
		);

		assert.equal(outcome.kind, 'done');
		assert.equal(outcome.operation.strategy, 'restart-controlled');
		assert.equal(target.calls.includes('restart:controlled'), true);
		for (const check of REQUIRED_CHECKS['restart-controlled']) {
			assert.equal(target.calls.includes(`check:${check}`), true, `faltou ${check}`);
		}
	});

	test('uma verificação obrigatória ausente impede "verificado"', async () => {
		// Simula um plano que não listou tudo: a operação não pode avançar.
		const operation: DevOperation = {
			...startOperation({ strategy: 'restart-app', files: ['src/core/x.ts'] }),
			stage: 'written',
			results: ['npm run check-types: ok'],
		};

		const missing = missingChecks(operation);

		assert.deepEqual(missing, ['npm run test:core']);
	});

	test('hot e reload-ui não exigem verificações pesadas', () => {
		assert.deepEqual(REQUIRED_CHECKS.hot, []);
		assert.deepEqual(REQUIRED_CHECKS['reload-ui'], ['npm run check-types']);
	});
});

suite('DEV-3: turno em andamento ao reiniciar', () => {
	test('avisa que a geração foi interrompida e não é retomada sozinha', () => {
		const notice = decideResume({ restored: { lastConversationId: 'cnv-2', wasGenerating: true } });

		assert.equal(notice.conversationId, 'cnv-2');
		assert.equal(notice.action, 'retry-turn');
		assert.match(notice.message ?? '', /interrompida/);
		assert.match(notice.message ?? '', /nenhuma chamada ao modelo nem ferramenta foi repetida/);
	});

	test('sem geração em curso, não há aviso nem botão de retomar', () => {
		const notice = decideResume({ restored: { lastConversationId: 'cnv-2', wasGenerating: false } });

		assert.equal(notice.action, undefined);
		assert.equal(notice.message, undefined);
	});

	test('a mensagem de operação pendente e a de geração interrompida convivem', () => {
		const operation = advance(
			startOperation({ conversationId: 'cnv-3', strategy: 'restart-app', files: ['src/core/x.ts'] }),
			'applying',
		);

		const notice = decideResume({ operation, restored: { wasGenerating: true } });

		assert.match(notice.message ?? '', /aplicação de/);
		assert.match(notice.message ?? '', /interrompida/);
	});
});

suite('DEV-3: sem mensagens duplicadas nem estado inconsistente', () => {
	test('a conversa é reaberta pela id e o histórico vem do store, não do texto do aviso', () => {
		const notice = decideResume({
			operation: advance(startOperation({ conversationId: 'cnv-4', strategy: 'hot', files: ['a.css'] }), 'done'),
			restored: { lastConversationId: 'cnv-4' },
		});

		// Uma operação concluída não é pendente: sem mensagem, sem aviso.
		assert.equal(notice.message, undefined);
		assert.equal(notice.conversationId, 'cnv-4');
		assert.equal(notice.pendingOperation, undefined);
	});

	test('uma operação concluída não deixa aviso pendente', () => {
		const done = advance(startOperation({ strategy: 'hot', files: ['a.css'] }), 'done');

		assert.equal(isUnfinished(done), false);
		assert.equal(decideResume({ operation: done }).message, undefined);
	});

	test('o registro não carrega conteúdo de arquivo nem mensagem do usuário', async () => {
		const dir = await makeData();
		const store = new DevOperationStore(dir);
		const operation = advance(
			startOperation({ conversationId: 'cnv-5', strategy: 'hot', files: ['a.css'] }),
			'done',
			{ result: 'aplicado: ok' },
		);
		await store.write(operation);

		const raw = await readFile(join(dir, 'operation.json'), 'utf8');

		assert.equal(raw.includes('--accent'), false, 'sem conteúdo de arquivo');
		assert.equal(raw.includes('mensagem'), false);
	});
});

suite('DEV-3: modo DEV continua exclusivo do proprietário', () => {
	test('nenhuma parte deste fluxo ativa a sessão DEV', async () => {
		const h = await harness();
		const target = fakeTarget();

		await applyChange(h.request(['src/desktop/renderer/index.css']), target);

		// O fluxo recebe as escritas já autorizadas; ele não tem — nem importa —
		// `DevSession.enter`.
		const source = await readFile(join(process.cwd(), 'src', 'core', 'dev', 'devApply.ts'), 'utf8');
		assert.equal(/\.enter\(|DevSession\b/.test(source), false, 'o fluxo não ativa a sessão');
	});

	test('o registro da operação não guarda token nem credencial', async () => {
		const dir = await makeData();
		const store = new DevOperationStore(dir);
		await store.write(
			advance(startOperation({ conversationId: 'cnv-6', strategy: 'hot', files: ['a.css'] }), 'verified'),
		);
		const raw = await readFile(join(dir, 'operation.json'), 'utf8');

		assert.equal(/token|secret|password|credential/i.test(raw), false);
	});
});
