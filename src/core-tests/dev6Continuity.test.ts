/**
 * DEV-6: a conversa continua aberta com o painel DEV aberto (teste real).
 *
 * Usa o mesmo padrão da integração da DEV-4: `electron.exe` abrindo
 * `dist/desktop/main.js`, conversas criadas com o Core de verdade, e o
 * `ui-session.json` dizendo qual estava aberta. Aqui o ponto extra é o painel
 * DEV: abrir o app **com** painel e estado DEV não pode trocar a conversa.
 *
 * O que não é observado: o DOM. A abordagem (a mesma da DEV-4) é o host: qual
 * conversa ele decide abrir, e se o estado que ele grava continua o mesmo.
 */
import * as assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { removeFixtureTree } from '../test-support/removeFixtureTree';

const ELECTRON = join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe');
const DESKTOP_MAIN = join(process.cwd(), 'dist', 'desktop', 'main.js');

const children: { readonly kill: (signal?: NodeJS.Signals) => void; exitCode: number | null }[] = [];
const roots: string[] = [];

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'evelyn-dev6-int-'));
	roots.push(root);
	return root;
}

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

async function openElectron(root: string): Promise<string> {
	const child = spawn(ELECTRON, [DESKTOP_MAIN, '--root', root], {
		stdio: ['ignore', 'pipe', 'pipe'],
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

suite('DEV-6: o painel não troca a conversa', () => {
	test('com estado DEV em disco, o app abre e mantém a conversa guardada', async () => {
		if (!existsSync(ELECTRON) || !existsSync(DESKTOP_MAIN)) {
			assert.fail('faltou build do desktop ou o binário do Electron');
		}
		const root = await makeRoot();
		const { second } = await seed(root);
		await mkdir(join(root, 'dev'), { recursive: true });
		await writeFile(
			join(root, 'dev', 'ui-session.json'),
			JSON.stringify({ lastConversationId: second, updatedAt: new Date().toISOString() }),
			'utf8',
		);
		// Um estado de host de um processo anterior: a abertura não pode
		// reativar nada nem trocar a conversa por causa dele.
		await writeFile(
			join(root, 'dev', 'host-state.json'),
			JSON.stringify({ root, sessionId: '1', lockToken: 'token-antigo', savedAt: new Date().toISOString() }),
			'utf8',
		);

		const output = await openElectron(root);

		assert.match(output, /ready mode=local/);
		// A sessão DEV **não** foi reaberta por causa do arquivo antigo.
		assert.equal(/modo DEV ativo/.test(output), false, 'a autorização não é restaurada');
		const session = JSON.parse(await readFile(join(root, 'dev', 'ui-session.json'), 'utf8')) as {
			readonly lastConversationId?: string;
		};
		assert.equal(session.lastConversationId, second, 'a conversa continua a mesma');
	});
});
