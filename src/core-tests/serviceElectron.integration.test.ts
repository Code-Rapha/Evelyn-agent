/**
 * R3: o Electron de verdade contra o serviço de verdade.
 *
 * ## Por que este teste existe separado
 *
 * O resto da suíte roda em mocha e nunca abre uma janela. Este precisa do
 * binário do Electron e do bundle do desktop, então é o único jeito de provar
 * a afirmação central do R3 — "o Electron não monta um segundo Core quando o
 * serviço detém a raiz" — sem fingir que a testou.
 *
 * ## O que ele executa
 *
 * 1. sobe o serviço real numa raiz temporária (`--root`, para nunca tocar a
 *    instalação do usuário);
 * 2. abre `electron.exe dist/desktop/main.js --root <a mesma raiz>`;
 * 3. espera o Electron sair e confere: código 1, mensagem do serviço, **sem**
 *    "desktop starting" no log (ou seja: não montou o Core);
 * 4. confere que o serviço continua ativo e que o lock ainda é dele;
 * 5. encerra o serviço e confere que o lock e o registro saíram;
 * 6. reabre o Electron **sem** serviço e confere que ele monta o Core e fica
 *    aberto (timeout curto, e ele é encerrado pelo teste).
 *
 * ## Quando é pulado, e por quê
 *
 * Sem `node_modules/electron/dist/electron.exe` ou sem `dist/desktop/main.js`
 * (build não rodado), o teste é marcado como **pendente** com o motivo — não
 * como aprovado. Um teste que "passa" sem executar é pior que um ausente.
 */
import * as assert from 'assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { probeService } from '../app/discoverService';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const ELECTRON = join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe');
const DESKTOP_MAIN = join(process.cwd(), 'dist', 'desktop', 'main.js');
const SERVICE_ENTRY = join(process.cwd(), 'dist', 'web', 'main.js');

const children: ChildProcess[] = [];
const roots: string[] = [];

interface Run {
	readonly exitCode: number | null;
	readonly timedOut: boolean;
	readonly stdout: string;
	readonly stderr: string;
}

/** Abre o Electron contra uma raiz e espera sair (ou o timeout matar). */
async function runElectron(root: string, timeoutMs: number): Promise<Run> {
	const child = spawn(ELECTRON, [DESKTOP_MAIN, '--root', root], {
		stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
	});
	children.push(child);
	let stdout = '';
	let stderr = '';
	child.stdout?.setEncoding('utf8');
	child.stderr?.setEncoding('utf8');
	child.stdout?.on('data', (chunk: string) => (stdout += chunk));
	child.stderr?.on('data', (chunk: string) => (stderr += chunk));

	return await new Promise<Run>((resolve) => {
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill('SIGKILL');
		}, timeoutMs);
		child.on('exit', (code) => {
			clearTimeout(timer);
			resolve({ exitCode: code, timedOut, stdout, stderr });
		});
	});
}

/** Sobe o serviço e espera ficar ativo. */
async function startService(root: string): Promise<ChildProcess> {
	const child = spawn(process.execPath, [SERVICE_ENTRY, '--root', root, '--port', '0'], {
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	children.push(child);
	const deadline = Date.now() + 25_000;
	for (;;) {
		if ((await probeService({ root })).kind === 'active') {
			return child;
		}
		if (Date.now() > deadline) {
			throw new Error('o serviço não ficou ativo a tempo');
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

/** Roda a CLI do serviço. */
async function runCli(root: string, ...args: string[]): Promise<number | null> {
	const child = spawn(process.execPath, [SERVICE_ENTRY, '--root', root, ...args], {
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	children.push(child);
	return await new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
}

/** Espera um processo sair de verdade. */
async function waitExit(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null) {
		return;
	}
	await new Promise<void>((resolve) => {
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			resolve();
		}, 20_000);
		child.on('exit', () => {
			clearTimeout(timer);
			resolve();
		});
	});
}

teardown(async () => {
	for (const child of children.splice(0)) {
		if (child.exitCode === null) {
			child.kill('SIGKILL');
		}
	}
	for (const root of roots.splice(0)) {
		await removeFixtureTree(root).catch(() => undefined);
	}
});

suite('R3: Electron com o serviço ativo', () => {
	test('não monta outro Core, diz por quê e deixa o serviço dono da raiz', async function () {
		if (!existsSync(ELECTRON) || !existsSync(DESKTOP_MAIN) || !existsSync(SERVICE_ENTRY)) {
			this.pending('faltou o build (desktop:build / web:build) ou o binário do Electron');
			return;
		}
		const root = await mkdtemp(join(tmpdir(), 'evelyn-r3-electron-'));
		roots.push(root);
		const service = await startService(root);
		try {
			const run = await runElectron(root, 15_000);

			// R4B mudou este comportamento de propósito: antes, o app saía com
			// código 1 quando o serviço detinha a raiz. Agora ele **permanece
			// aberto** em modo conectado, sem montar Core. O que continua
			// valendo é a parte central: um Core só, o do serviço.
			assert.equal(run.timedOut, true, 'o app permanece aberto em modo conectado');
			assert.match(run.stderr, /connected to the local service/);
			// A prova de que não montou: o arranque do desktop não aparece.
			assert.equal(
				run.stdout.includes('desktop starting'),
				false,
				'o Electron não iniciou o Core concorrente',
			);
			assert.equal(run.stdout.includes('Seeding default provider'), false);

			// O serviço continua vivo e ainda é o dono.
			const probe = await probeService({ root });
			assert.equal(probe.kind, 'active');
			if (probe.kind === 'active') {
				assert.equal(probe.record.pid, service.pid);
			}
		} finally {
			await runCli(root, '--stop');
			await waitExit(service);
		}
	});

	test('encerrar o serviço libera o lock e o registro', async function () {
		if (!existsSync(SERVICE_ENTRY)) {
			this.pending('faltou `npm run web:build`');
			return;
		}
		const root = await mkdtemp(join(tmpdir(), 'evelyn-r3-lock-'));
		roots.push(root);
		const service = await startService(root);
		assert.equal(existsSync(join(root, 'storage.lock')), true);
		assert.equal(existsSync(join(root, 'service.json')), true);

		assert.equal(await runCli(root, '--stop'), 0);
		await waitExit(service);

		assert.equal(existsSync(join(root, 'storage.lock')), false, 'o lock é liberado');
		assert.equal(existsSync(join(root, 'service.json')), false, 'o registro sai');
		assert.equal((await probeService({ root })).kind, 'absent');
	});

	test('sem serviço, o Electron monta o Core e continua aberto', async function () {
		if (!existsSync(ELECTRON) || !existsSync(DESKTOP_MAIN)) {
			this.pending('faltou o build do desktop ou o binário do Electron');
			return;
		}
		const root = await mkdtemp(join(tmpdir(), 'evelyn-r3-standalone-'));
		roots.push(root);

		// O timeout curto o encerra: o que se afirma é que ele **não** saiu
		// sozinho com uma recusa, e que montou o Core.
		const run = await runElectron(root, 15_000);

		assert.equal(run.timedOut, true, 'sem serviço, o app abre e fica aberto');
		assert.match(run.stdout, /desktop starting/, 'montou o Core próprio');
		assert.equal(run.stderr.includes('serviço local da Evelyn está no ar'), false);

		// E, como dono, ele deixou a raiz travada enquanto esteve aberto.
		assert.equal(existsSync(join(root, 'storage.lock')), true);
	});
});
