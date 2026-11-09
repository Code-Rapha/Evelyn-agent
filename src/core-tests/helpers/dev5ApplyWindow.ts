/**
 * O lado Electron do teste da DEV-5 (`dev5Electron.test.ts`).
 *
 * Roda **dentro** do `electron.exe`: cria uma `BrowserWindow` de verdade,
 * monta o `ElectronApplyHost` sobre ela e executa o fluxo de aplicação da
 * DEV-3/5 (checkpoint → escrita → `ApplyTarget` → conferência). Imprime
 * `RESULT <json>` e sai.
 *
 * ## O que é real e o que é substituído
 *
 * Real: a janela, o carregamento, o `did-finish-load`, o `reload` do
 * `webContents`, os arquivos, os checkpoints e o `DevOperationStore`.
 * Substituídos: os comandos de verificação (`runCheck` devolve `ok`; rodar
 * `check-types`/`test:core` dentro de um teste não diz nada sobre este
 * fluxo) e o **reinício** (`restartApplication` só registra: `app.relaunch`
 * mataria o processo de teste, e o pedido proíbe).
 *
 * `--close-before-reload` fecha a janela antes da aplicação, para provar que
 * sem janela não há sucesso — o fluxo desfaz pelo checkpoint.
 */

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DevSession } from '../../core/dev/devSession';
import { DevCheckpointStore } from '../../core/dev/devCheckpoint';
import { DevOperationStore, type DevOperation } from '../../core/dev/devOperation';
import { DevRunner } from '../../core/dev/devRunner';
import { PreparedChangeJournal } from '../../core/dev/preparedChange';
import { createElectronApplyTarget, type ElectronApplyHost } from '../../core/dev/electronApply';
import { applyPrepared, type ApplyOutcome } from '../../core/dev/devApply';

// `electron` não é resolvível pelo tsconfig dos testes (que falaria de um
// módulo de outro runtime); dentro do processo, o módulo é o do host.
const electron = require('electron') as any;

const CSS = 'src/desktop/renderer/index.css';
const ORIGINAL = ':root { --accent: #3b82f6; }\n';
const CHANGED = ':root { --accent: #ff0080; }\n';
const PAGE = 'data:text/html,<title>evelyn dev5</title><p>janela real</p>';

interface Report {
	readonly ok?: boolean;
	readonly error?: string;
	readonly errorStack?: string;
	readonly outcome?: string;
	readonly reloads?: number;
	readonly restarts?: number;
	readonly probes?: readonly { readonly ok: boolean; readonly detail: string }[];
	readonly survived?: boolean;
	readonly written?: string;
	/** O repositório do teste, dentro da raiz descartável. */
	readonly repo?: string;
	readonly reason?: string;
	readonly note?: string;
}

/**
 * Rastro de diagnóstico: cada etapa é escrita em `--e2e-trace=`.
 *
 * Existe porque, sem `--enable-logging`, o Electron no Windows pode não
 * entregar o stdout a um processo pai que não é um terminal — e o teste
 * precisava saber **onde** parou, não só que parou.
 */
	// A raiz do teste chega pela linha de comando (o script do Electron não
	// tem `__dirname` do mocha): `--e2e-root`. O `trace` e o `report` gravam
	// nela; se ela não existir, cada etapa cria.
	function trace(message: string): void {
	const path = process.argv.slice(1).find((arg) => arg.startsWith('--e2e-trace='))?.slice('--e2e-trace='.length);
	if (path === undefined) {
		return;
	}
	require('node:fs').mkdirSync(require('node:path').dirname(path), { recursive: true });
	require('node:fs').appendFileSync(path, `${new Date().toISOString()} ${message}\n`);
}

function report(payload: Report): void {
	reportFile(payload);
	// `app.quit()` depois de a janela já ter fechado não faz nada, mas o
	// `process.exit` garante que o processo do teste termine.
	setTimeout(() => process.exit(0), 100).unref();
}

/** Só o arquivo: é o que sobrevive ao processo sair. */
function reportFile(payload: Report): void {
	const line = `RESULT ${JSON.stringify(payload)}\n`;
	const out = process.argv.slice(1).find((arg) => arg.startsWith('--e2e-report='))?.slice('--e2e-report='.length);
	if (out !== undefined) {
		require('node:fs').mkdirSync(require('node:path').dirname(out), { recursive: true });
		require('node:fs').writeFileSync(out, line);
	}
	process.stdout.write(line);
	electron.app.quit();
}

async function main(): Promise<void> {
	trace('main: começou');
	const args = process.argv.slice(1);
	const rootArg = args.find((arg) => arg.startsWith('--e2e-root='));
	const root = rootArg?.slice('--e2e-root='.length);
	const closeBeforeReload = args.includes('--close-before-reload');
	if (root === undefined) {
		report({ error: 'faltou --e2e-root' });
		return;
	}
	const repo = await mkdtemp(join(tmpdir(), 'evelyn-dev5-e2e-repo-'));
	trace(`repo: ${repo}`);
	execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
	await mkdir(join(repo, 'src', 'desktop', 'renderer'), { recursive: true });
	await writeFile(join(repo, CSS), ORIGINAL, 'utf8');

	const window = new electron.BrowserWindow({
		show: false,
		webPreferences: { nodeIntegration: false, contextIsolation: true },
	});
	trace('janela criada');
	// `isLoading()` pode continuar `true` por um instante **depois** de
	// `did-finish-load` (medido): esperar "não estar carregando" trava para
	// sempre. A espera é pelo evento, com prazo.
	await new Promise<void>((resolve) => {
		if (!window.webContents.isLoading()) {
			resolve();
			return;
		}
		const timer = setTimeout(resolve, 10_000);
		window.webContents.once('did-finish-load', () => {
			clearTimeout(timer);
			resolve();
		});
		window.loadURL(PAGE).catch(() => resolve());
	});
	await new Promise((resolve) => setTimeout(resolve, 250));
	trace(`janela carregada (loading=${window.webContents.isLoading()})`);

	let reloads = 0;
	let restarts = 0;
	const probes: { readonly ok: boolean; readonly detail: string }[] = [];
	// A mesma porta que o `main.ts` implementa sobre o `mainWindow`.
	const host: ElectronApplyHost = {
		isWindowAlive: () => !window.isDestroyed(),
		isWindowReady: () => !window.isDestroyed() && !window.webContents.isLoading(),
		reloadWindow: (timeoutMs: number) =>
			new Promise<void>((resolve, reject) => {
				reloads += 1;
				// Alguém recarregar em processo **não** tem URL para refazer
				// recarregando: o `reload()` parte do documento vazio. O
				// `main.ts` carrega arquivo, então lá `reload()` basta; aqui a
				// recarga é `loadURL` da mesma página, que é o que "recarregar a
				// interface" significa para o alvo.
				const onLoad = (): void => {
					clearTimeout(timer);
					// `did-finish-load` chega antes de `isLoading()` virar
					// `false` (medido); a conferência logo depois veria a janela
					// "carregando" e desfaria sem motivo.
					setTimeout(resolve, 250);
				};
				const timer = setTimeout(() => {
					window.webContents.removeListener('did-finish-load', onLoad);
					reject(new Error(`a janela não recarregou em ${timeoutMs} ms`));
				}, timeoutMs);
				window.webContents.once('did-finish-load', onLoad);
				void window.loadURL(PAGE);
			}),
		restartApplication: async () => {
			restarts += 1;
		},
	};

	const target = createElectronApplyTarget({
		host,
		repositoryRoot: repo,
		runner: new DevRunner({ timeoutMs: 30_000 }),
		runCheck: async () => ({ exitCode: 0, summary: 'ok (teste)' }),
		probeWindow: async () => {
			let probe: { readonly ok: boolean; readonly detail: string };
			if (window.isDestroyed()) {
				probe = { ok: false, detail: 'a janela principal não existe mais' };
			} else if (window.webContents.isLoading()) {
				probe = { ok: false, detail: 'a janela ainda está carregando' };
			} else {
				const title = (await window.webContents.executeJavaScript('document.title')) as string;
				probe = { ok: title === 'evelyn dev5', detail: `a página respondeu: "${title}"` };
			}
			probes.push(probe);
			return probe;
		},
	});

	const session = new DevSession({ repositoryRoot: repo });
	await session.enter();
	const data = await mkdtemp(join(tmpdir(), 'evelyn-dev5-e2e-data-'));
	const checkpoints = new DevCheckpointStore(join(data, 'dev'));
	await checkpoints.init();
	const operations = new DevOperationStore(join(data, 'dev'));
	const journal = new PreparedChangeJournal();
	const started = journal.start({ root: session.root(), files: [CSS], sessionToken: session.sessionToken() });
	journal.note({ operationId: started.operationId, path: CSS, content: CHANGED });
	// O lance do `start` é vazio por desenho: o atualizado vem do `get`.
	const change = journal.get(started.operationId);
	if (change === undefined) {
		throw new Error('o diário perdeu a operação recém-preparada');
	}
	const prepared: DevOperation = {
		version: 1,
		nonce: change.nonce,
		stage: 'planned',
		strategy: 'hot',
		files: [CSS],
		checks: [],
		results: [],
		startedAt: change.createdAt,
		updatedAt: change.createdAt,
	};

	if (closeBeforeReload) {
		// A janela é perdida **durante** a aplicação: o alvo confere que ela
		// existe, começa a recarga e aí a janela é destruída — como num app em
		// que a pessoa fecha a janela enquanto a mudança é aplicada. O que se
		// mede logo em seguida é a recusa do alvo e o estado do disco.
		//
		// Fechar a janela encerra o Electron; por isso a medição e o relatório
		// acontecem **dentro** da recusa, antes de qualquer outra coisa.
		const closing: ElectronApplyHost = {
			...host,
			reloadWindow: async () => {
				// `destroy()` encerraria o processo **sincronamente** (medido), e
				// a recusa não chegaria a terminar. A janela é "fechada" de
				// forma observável — escondida e marcada — para que a recusa, a
				// medição e o relatório aconteçam.
				window.hide();
				const atRefusal = await readFile(join(repo, CSS), 'utf8').catch(() => '(ilegível)');
				trace(`recusa; disco neste instante: ${JSON.stringify(atRefusal)}`);
				reportFile({ ok: false, outcome: 'janela-fechada', repo, written: atRefusal });
				throw new Error('a janela não recarregou: ela foi fechada durante a aplicação');
			},
		};
		const closingTarget = createElectronApplyTarget({
			host: closing,
			repositoryRoot: repo,
			runner: new DevRunner({ timeoutMs: 30_000 }),
			runCheck: async () => ({ exitCode: 0, summary: 'ok (teste)' }),
			reloadTimeoutMs: 2_000,
		});
		let outcome: ApplyOutcome;
		let written: string;
		try {
			outcome = await applyPrepared(
				{
					operation: prepared,
					writes: change.writes,
					root: session.root(),
					operations,
					checkpoints,
					writeFile: async (relative: string, content: string) => {
						await writeFile(join(repo, relative), content, 'utf8');
					},
				},
				closingTarget,
			);
			written = await readFile(join(repo, CSS), 'utf8');
		} catch (error) {
			reportFile({
				ok: false,
				outcome: 'error',
				repo,
				error: error instanceof Error ? error.message : String(error),
			});
			return;
		}
		trace(`fluxo com janela fechada: ${outcome.kind}; arquivo: ${JSON.stringify(written)}`);
		reportFile({
			ok: false,
			outcome: outcome.kind,
			reloads,
			restarts,
			survived: false,
			written,
			repo,
			...(outcome.kind === 'done' ? {} : { reason: outcome.reason }),
		});
		return;
	}

	trace('fluxo: começou');
	const outcome = await applyPrepared(
		{
			operation: prepared,
			writes: change.writes,
			root: session.root(),
			operations,
			checkpoints,
			writeFile: async (relative: string, content: string) => {
				await writeFile(join(repo, relative), content, 'utf8');
			},
		},
		target,
	);

	const written = await readFile(join(repo, CSS), 'utf8');
	const ok = outcome.kind === 'done' && written === CHANGED;
	trace(`fluxo: ${outcome.kind}; arquivo final: ${JSON.stringify(written)}`);
	report({
		// "Sucesso" exige as duas coisas: o fluxo **e** o arquivo mudado.
		// O teste não deve aceitar um `done` que não escreveu nada.
		ok,
		outcome: outcome.kind,
		reloads,
		restarts,
		probes,
		survived: !window.isDestroyed(),
		written,
		repo,
		...(outcome.kind === 'done' ? {} : { reason: outcome.reason }),
	});
}

electron.app.whenReady().then(
	() =>
		main().catch((error: unknown) => {
			report({
				error: error instanceof Error ? error.message : String(error),
				...(error instanceof Error && error.stack !== undefined ? { errorStack: error.stack } : {}),
			});
		}),
	(error: unknown) => report({ error: String(error) }),
);
