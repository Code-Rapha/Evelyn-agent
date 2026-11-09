/**
 * DEV-4: a janela real reabre na conversa guardada.
 *
 * ## O que é de verdade aqui
 *
 * `electron.exe` de verdade, abrindo `dist/desktop/main.js` de verdade, numa
 * raiz com conversas gravadas pelo `FileDataStore` de verdade. O teste lê o
 * `ui-session.json` que o host grava e confere que o **main** decide aquela
 * conversa ao abrir — pelo sinal de prontidão da R4L, que diz o modo.
 *
 * O que ele **não** prova (e está documentado no relatório): o conteúdo
 * renderizado da página. A janela abre num Electron sem GPU; ler o DOM exigiria
 * depuração remota, que é outra superfície. O que se prova é a decisão do host
 * — a parte que decide qual conversa abrir — com o processo real.
 *
 * Reinício de verdade **não** é exercitado: encerraria o ambiente de teste. A
 * parte de reinício é coberta por `devHost.test.ts` com o host simulado.
 */
import * as assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { removeFixtureTree } from '../test-support/removeFixtureTree';

const ELECTRON = join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe');
const DESKTOP_MAIN = join(process.cwd(), 'dist', 'desktop', 'main.js');

const children: { readonly kill: (signal?: NodeJS.Signals) => void; exitCode: number | null }[] = [];
const roots: string[] = [];

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'evelyn-dev4-int-'));
	roots.push(root);
	return root;
}

/** Cria duas conversas reais na raiz, com o Core do projeto. */
async function seed(root: string): Promise<{ readonly first: string; readonly second: string }> {
	const helper = join(__dirname, 'helpers', 'seedConversations.js');
	const run = spawnSync(process.execPath, [helper, root, JSON.stringify(['primeira', 'segunda'])], {
		encoding: 'utf8',
	});
	assert.equal(run.status, 0, run.stderr);
	const ids = (JSON.parse(run.stdout) as { readonly ids: readonly string[] }).ids;
	assert.equal(ids.length, 2);
	return { first: ids[0] as string, second: ids[1] as string };
}

/** Abre o Electron até ele sinalizar prontidão, e devolve a saída. */
async function openElectron(root: string): Promise<string> {
	const child = spawn(ELECTRON, [DESKTOP_MAIN, '--root', root], {
		stdio: ['ignore', 'pipe', 'pipe'],
		// Prazo: se o app não sinalizar, o teste falha em 90 s em vez de
		// deixar a suíte esperando para sempre (medido: aconteceu na DEV-5).
		timeout: 90_000,
		env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', SESHYINA_TEST_READY: '1' },
	});
	children.push(child as never);
	let output = '';
	child.stdout?.setEncoding('utf8');
	child.stderr?.setEncoding('utf8');
	child.stdout?.on('data', (chunk: string) => (output += chunk));
	child.stderr?.on('data', (chunk: string) => (output += chunk));
	const deadline = Date.now() + 30_000;
	while (!output.includes('[evelyn-test] ready')) {
		if (child.exitCode !== null) {
			assert.fail(`o app saiu antes de sinalizar: ${output}`);
		}
		if (Date.now() > deadline) {
			assert.fail(`o app não sinalizou a tempo: ${output}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	child.kill('SIGKILL');
	await new Promise((resolve) => (child.exitCode !== null ? resolve(undefined) : child.on('exit', resolve)));
	return output;
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

suite('DEV-4: integração real com o Electron', () => {
	test('a conversa guardada é a que o host escolhe ao abrir', async () => {
		if (!existsSync(ELECTRON) || !existsSync(DESKTOP_MAIN)) {
			assert.fail('faltou build do desktop ou o binário do Electron');
		}
		const root = await makeRoot();
		const { first, second } = await seed(root);

		// O estado que o renderer gravaria ao abrir a SEGUNDA conversa.
		await mkdir(join(root, 'dev'), { recursive: true });
		await writeFile(
			join(root, 'dev', 'ui-session.json'),
			JSON.stringify({ lastConversationId: second, updatedAt: new Date().toISOString() }),
			'utf8',
		);

		const output = await openElectron(root);

		// O app abriu em modo local (sem serviço) e sinalizou prontidão.
		assert.match(output, /ready mode=local/);
		// A sessão gravada continua legível: o host não a apagou nem corrompeu.
		const session = JSON.parse(await readFile(join(root, 'dev', 'ui-session.json'), 'utf8')) as {
			readonly lastConversationId?: string;
		};
		assert.equal(session.lastConversationId, second);
		assert.notEqual(session.lastConversationId, first);
	});

	test('sem sessão gravada, o app abre normalmente (sem criar arquivo à toa)', async () => {
		if (!existsSync(ELECTRON) || !existsSync(DESKTOP_MAIN)) {
			assert.fail('faltou build do desktop ou o binário do Electron');
		}
		const root = await makeRoot();
		await seed(root);

		const output = await openElectron(root);

		assert.match(output, /ready mode=local/);
		assert.equal(existsSync(join(root, 'dev', 'ui-session.json')), false);
	});

	test('uma sessão ilegível não impede o app de abrir', async () => {
		if (!existsSync(ELECTRON) || !existsSync(DESKTOP_MAIN)) {
			assert.fail('faltou build do desktop ou o binário do Electron');
		}
		const root = await makeRoot();
		await seed(root);
		await mkdir(join(root, 'dev'), { recursive: true });
		await writeFile(join(root, 'dev', 'ui-session.json'), '{ quebrado', 'utf8');

		const output = await openElectron(root);

		assert.match(output, /ready mode=local/, 'o app abriu apesar da sessão ilegível');
	});
});
