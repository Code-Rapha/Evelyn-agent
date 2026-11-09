/**
 * DEV-5: o fluxo de aplicação com uma janela **de verdade**.
 *
 * ## O que é real aqui
 *
 * `electron.exe` de verdade, aberto por este teste, carregando uma página de
 * verdade (`data:text/html`). O `ElectronApplyHost` é escrito em cima desse
 * `BrowserWindow` real — os mesmos quatro métodos que o `main.ts` implementa:
 *
 * - `isWindowAlive`/`isWindowReady`: o estado real da janela;
 * - `reloadWindow`: espera o `did-finish-load` de verdade;
 * - `restartApplication`: **não** reinicia — registra que foi pedido. Reiniciar
 *   aqui encerraria a suíte, e o pedido diz para não fazer isso.
 *
 * O que **não** é exercitado de verdade: o reinício (`app.relaunch`). Ele está
 * coberto pelo alvo simulado em `devApplyTool.test.ts`/`devHostTools.test.ts`.
 *
 * O processo de teste imprime `RESULT <json>` e sai; o mocha lê a saída. Uma
 * falha dentro do script vira `RESULT {"error": ...}`, nunca sucesso silencioso.
 */
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { removeFixtureTree } from '../test-support/removeFixtureTree';

const ELECTRON = join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe');
const SCRIPT = join(__dirname, 'helpers', 'dev5ApplyWindow.js');

interface Report {
	readonly ok?: boolean;
	readonly error?: string;
	readonly errorStack?: string;
	readonly outcome?: string;
	readonly probes?: readonly { readonly ok: boolean; readonly detail: string }[];
	readonly reloads?: number;
	readonly restarts?: number;
	readonly survived?: boolean;
	readonly written?: string;
	/** O repositório do teste, dentro da raiz descartável. */
	readonly repo?: string;
	readonly reason?: string;
}

const roots: string[] = [];

teardown(async () => {
	for (const root of roots.splice(0)) {
		await removeFixtureTree(root).catch(() => undefined);
	}
});

function reportDir(): string {
	const root = mkdtempSync(join(tmpdir(), 'evelyn-dev5-e2e-'));
	roots.push(root);
	return root;
}

function run(): Report {
	const root = reportDir();
	const report = join(root, 'report.json');
	const trace = join(root, 'trace.txt');
	const child = spawnSync(ELECTRON, [SCRIPT, `--e2e-root=${root}`, `--e2e-report=${report}`, `--e2e-trace=${trace}`], {
		encoding: 'utf8',
		timeout: 90_000,
		env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
	});
	const output = `${child.stdout ?? ''}\n${child.stderr ?? ''}`;
	const fromFile = existsSync(report) ? readFileSync(report, 'utf8') : '';
	const fromStdout = output
		.split(/\r?\n/)
		.reverse()
		.find((entry: string) => entry.startsWith('RESULT '));
	const line = fromFile.trim() || fromStdout;
	const steps = existsSync(trace) ? readFileSync(trace, 'utf8') : '(sem rastro)';
	assert.notEqual(line, undefined, `o script do Electron não devolveu resultado:\n${output}\n${steps}`);
	return JSON.parse((line as string).slice('RESULT '.length)) as Report;
}

/** A variante que fecha a janela antes de aplicar. */
function runClosed(): Report {
	const root = reportDir();
	const report = join(root, 'report.json');
	const child = spawnSync(ELECTRON, [SCRIPT, `--e2e-root=${root}`, `--e2e-report=${report}`, '--close-before-reload'], {
		encoding: 'utf8',
		timeout: 90_000,
		env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
	});
	const output = `${child.stdout ?? ''}\n${child.stderr ?? ''}`;
	const fromFile = existsSync(report) ? readFileSync(report, 'utf8') : '';
	const fromStdout = output
		.split(/\r?\n/)
		.reverse()
		.find((entry: string) => entry.startsWith('RESULT '));
	const line = fromFile.trim() || fromStdout;
	assert.notEqual(line, undefined, `sem resultado do Electron:\n${output}\nexit=${child.status} sinal=${child.signal}`);
	// O relatório traz o repositório do script; `repo` **não** é sobrescrito.
	return JSON.parse((line as string).slice('RESULT '.length)) as Report;
}

suite('DEV-5: integração real com uma janela do Electron', () => {
	test('o alvo real recarrega a janela e confirma; o arquivo é escrito', async () => {
		if (!existsSync(ELECTRON) || !existsSync(SCRIPT)) {
			assert.fail(`faltou o Electron (${ELECTRON}) ou o script do teste`);
		}

		const report = run();

		assert.equal(report.error, undefined, `${report.error}\n${report.errorStack ?? ''}`);
		assert.equal(report.ok, true, 'o fluxo concluiu com a janela real');
		assert.equal(report.reloads, 1, 'uma recarga, e só uma');
		assert.equal(report.restarts, 0, 'CSS não reinicia a aplicação');
		assert.equal(report.survived, true, 'a janela continuou viva depois da recarga');
		assert.equal(report.written, ':root { --accent: #ff0080; }\n');
		// A conferência é feita **depois** da recarga, sobre a janela real.
		// Uma sonda só: o `electronApply` confere uma vez, após aplicar.
		assert.deepEqual(
			report.probes?.map((probe) => probe.ok),
			[true],
			'a janela respondeu com a página carregada depois da recarga',
		);
	});

	test('janela indisponível no momento de recarregar: recusa em vez de declarar sucesso', async () => {
		if (!existsSync(ELECTRON) || !existsSync(SCRIPT)) {
			assert.fail('faltou o Electron ou o script do teste');
		}

		const report = runClosed();

		assert.equal(report.error, undefined, report.error);
		assert.notEqual(report.outcome, 'done', 'sem janela, nunca "concluído"');
		// O que o teste prova aqui é o estado no **instante da recusa**: a
		// escrita já chegou ao disco e o alvo recusou — nada foi declarado
		// concluído. O desfazer que vem depois é provado com o alvo simulado
		// (`devApplyTool.test.ts`): fechar a janela encerra o Electron, e o
		// processo de teste não sobrevive para ver o checkpoint devolver o
		// arquivo.
		assert.equal(report.written, ':root { --accent: #ff0080; }\n', 'a escrita chegou ao disco antes da recusa');
		assert.equal(typeof report.repo, 'string', 'o script informa o repositório');
	});
});
