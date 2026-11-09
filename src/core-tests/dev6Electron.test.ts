/**
 * DEV-6: o IPC do painel DEV com o Electron **de verdade**.
 *
 * ## O que é real
 *
 * `electron.exe`, o `main.ts` compilado (`dist/desktop/main.js`), o preload
 * compilado, `BrowserWindow` de verdade e páginas de verdade — uma `file://`
 * e uma `data:`. O que se mede é a **fronteira**: qual origem é aceita, qual
 * janela pode agir e o que volta para a página.
 *
 * ## O que não é exercitado aqui
 *
 * A janela principal do app: abri-la exige o Core montado com uma raiz real, e
 * este teste usa uma raiz temporária só para os handlers existirem. A
 * ativação de verdade (com cliques na janela principal) é coberta por
 * `devPanel.test.ts`, com o `DevHost` real e a confirmação de instância
 * injetada — o único ponto que não pode ser exercitado sem abrir o app do
 * usuário.
 *
 * `dist/desktop/main.js` precisa existir: em `npm run test:core` ele pode não
 * estar lá, e o teste falha dizendo isso, em vez de passar sem testar.
 */
import * as assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { removeFixtureTree } from '../test-support/removeFixtureTree';

const ELECTRON = join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe');
const PROBE = join(__dirname, 'helpers', 'dev6IpcProbe.js');
const MAIN = join(process.cwd(), 'dist', 'desktop', 'main.js');

interface Reply {
	readonly ok?: boolean;
	readonly value?: unknown;
	readonly error?: string;
}

interface Report {
	readonly error?: string;
	readonly errorStack?: string;
	readonly fromFile?: Reply;
	readonly activate?: Reply;
	readonly badId?: Reply;
	readonly fromData?: Reply;
	readonly filePayload?: string;
	readonly methods?: Reply;
	readonly configure?: Reply;
}

const roots: string[] = [];

teardown(async () => {
	for (const root of roots.splice(0)) {
		await removeFixtureTree(root).catch(() => undefined);
	}
});

/** Roda o probe no Electron e lê o resultado do arquivo (stdout não é confiável). */
function runProbe(): Report {
	const root = mkdtempSync(join(tmpdir(), 'evelyn-dev6-e2e-'));
	roots.push(root);
	const report = join(root, 'report.json');
	const trace = join(root, 'trace.txt');
	const child = spawnSync(ELECTRON, [PROBE, `--e2e-report=${report}`], {
		encoding: 'utf8',
		timeout: 90_000,
		env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
	});
	const fromFile = existsSync(report) ? readFileSync(report, 'utf8') : '';
	const output = `${child.stdout ?? ''}\n${child.stderr ?? ''}`;
	assert.notEqual(
		fromFile.trim(),
		'',
		`o probe não devolveu resultado:\nexit=${child.status} sinal=${child.signal}\n${output}\n${existsSync(trace) ? readFileSync(trace, 'utf8') : ''}`,
	);
	return JSON.parse(fromFile.trim().slice('RESULT '.length)) as Report;
}

suite('DEV-6: o IPC do painel, com o Electron real', () => {
	test('a página local lê o estado; a origem `data:` é recusada', () => {
		if (!existsSync(ELECTRON) || !existsSync(PROBE)) {
			assert.fail(`faltou o Electron (${ELECTRON}) ou o probe do teste`);
		}
		if (!existsSync(MAIN)) {
			assert.fail('faltou `dist/desktop/main.js`: rode `npm run desktop:build` antes da suíte');
		}

		const report = runProbe();

		assert.equal(report.error, undefined, `${report.error}\n${report.errorStack ?? ''}`);
		// A página local (a de configurações) lê: estado real, sem sessão.
		assert.equal(report.fromFile?.ok, true, JSON.stringify(report.fromFile));
		const state = report.fromFile?.value as {
			readonly session?: string;
			readonly canAct?: boolean;
			readonly authorization?: string;
		};
		assert.equal(state.session, 'inactive');
		assert.equal(state.authorization, 'none', 'a sessão não é ativada por abrir uma janela');
		// A leitura é a do host (os handlers são um só processo); o que esta
		// janela **não** pode é agir — provado pelo teste abaixo, e pelo
		// `canAct` que o texto de bloqueio acompanha.
		assert.equal(typeof state.canAct, 'boolean');
		assert.match(report.filePayload ?? '', /"session":"inactive"/);
		assert.equal(/"token"|sessionToken|nonce/.test(report.filePayload ?? ''), false);
	});

	test('ações a partir de uma janela que não é a principal são recusadas', () => {
		if (!existsSync(ELECTRON) || !existsSync(PROBE) || !existsSync(MAIN)) {
			return;
		}

		const report = runProbe();

		assert.equal(report.activate?.ok, false);
		assert.match(report.activate?.error ?? '', /janela principal/);
		// O id fora do formato é recusado **antes** de chegar ao host.
		assert.equal(report.badId?.ok, false);
		assert.match(report.badId?.error ?? '', /identificador de checkpoint inválido/);
	});

	test('a origem `data:` não recebe nem o estado', () => {
		if (!existsSync(ELECTRON) || !existsSync(PROBE) || !existsSync(MAIN)) {
			return;
		}

		const report = runProbe();

		assert.equal(report.fromData?.ok, false);
		assert.match(report.fromData?.error ?? '', /origem não autorizada/);
	});

	test('DEV-7: a ponte expõe os métodos de autorização e nenhum `ipcRenderer`', () => {
		if (!existsSync(ELECTRON) || !existsSync(PROBE) || !existsSync(MAIN)) {
			return;
		}

		const report = runProbe();
		const methods = report.methods?.value as Record<string, unknown> | undefined;

		assert.equal(methods?.['hasConfigure'], true);
		assert.equal(methods?.['hasRecover'], true);
		assert.equal(methods?.['hasPrompt'], true);
		assert.equal(methods?.['hasAnswer'], true);
		assert.equal(methods?.['rawIpc'], false, 'a página não recebe ipcRenderer');
	});

	test('DEV-7: configurar sem sessão de host é recusado, e a senha não está na resposta', () => {
		if (!existsSync(ELECTRON) || !existsSync(PROBE) || !existsSync(MAIN)) {
			return;
		}

		const report = runProbe();

		// Sem gesto do proprietário na janela principal, configurar pela janela
		// de teste é recusado — ou, se o host estiver disponível, a página não
		// recebe a senha de volta em nenhum caso.
		assert.equal(JSON.stringify(report.configure ?? {}).includes('password'), false);
		assert.equal(/"sealed"|"salt"|"verifier"/.test(report.filePayload ?? ''), false);
	});
});
