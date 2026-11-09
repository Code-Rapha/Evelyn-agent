/**
 * O teste que decide se o modo automático nasce ou não: o shim que o npm
 * gera é lido, não executado.
 *
 * ## O que se prova
 *
 * 1. O shim que o `npm i -g opencode-ai` cria é **desmontado** para o `.exe`
 *    que ele chama — e é esse `.exe` que a Seshyina usa (`spawn` sem shell);
 * 2. Um shim com pipe, redirecionamento, `&` ou um segundo comando é
 *    **recusado**: a CLI aparece como não encontrada, e nada é executado;
 * 3. Sem `PATH` e sem o shim, `undefined`;
 * 4. `SESHYINA_OPENCODE_BIN` apontando um `.exe` funciona; apontando outra
 *    coisa, não.
 *
 * Os arquivos são fixtures temporários: nenhum `opencode` é executado aqui.
 */
import * as assert from 'assert';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findOpencodeBinary, resolveCmdShim } from '../app/opencodeProcess';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

/** O shim que o npm gera, linha por linha. */
const NPM_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe"   %*
`;

suite('OpenCode: achar a CLI sem shell', () => {
	let root: string;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-cli-'));
	});

	teardown(async () => {
		await removeFixtureTree(root);
	});

	/** Um `.exe` vazio — o que importa é existir. */
	async function fakeExe(relative: string): Promise<string> {
		const full = join(root, relative);
		await mkdir(join(full, '..'), { recursive: true });
		await writeFile(full, '', 'utf8');
		await chmod(full, 0o755).catch(() => undefined);
		return full;
	}

	test('sem PATH e sem binário, não há CLI', () => {
		assert.strictEqual(findOpencodeBinary({}), undefined);
	});

	test('o shim do npm vira o .exe que ele chama', async () => {
		const exe = await fakeExe(join('npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'));
		const shim = join(root, 'npm', 'opencode.cmd');
		await writeFile(shim, NPM_SHIM, 'utf8');

		const resolved = resolveCmdShim(shim);
		if (process.platform === 'win32') {
			assert.strictEqual(resolved, exe);
		}
		// E o `findOpencodeBinary` o prefere a um `opencode` sem extensão.
		const found = findOpencodeBinary({ PATH: join(root, 'npm') });
		if (process.platform === 'win32') {
			assert.strictEqual(found, exe, 'sem shell, o .cmd não pode ser o escolhido');
		}
	});

	test('um shim com pipe ou um segundo comando é recusado', async () => {
		await fakeExe(join('assets', 'opencode.exe'));
		const withPipe = join(root, 'assets', 'com-pipe.cmd');
		await writeFile(withPipe, `"C:\\assets\\opencode.exe" %* | more\n`, 'utf8');
		assert.strictEqual(resolveCmdShim(withPipe), undefined);

		const secondCommand = join(root, 'assets', 'com-comando.cmd');
		await writeFile(
			secondCommand,
			`"%dp0%\\opencode.exe" %*\r\npowershell -c "malicioso"\r\n`,
			'utf8',
		);
		assert.strictEqual(resolveCmdShim(secondCommand), undefined);

		const redirect = join(root, 'assets', 'com-redirect.cmd');
		await writeFile(redirect, `"%dp0%\\opencode.exe" %* > "%TEMP%\\saida"\n`, 'utf8');
		assert.strictEqual(resolveCmdShim(redirect), undefined);
	});

	test('um shim que aponta um .exe inexistente é recusado', async () => {
		const shim = join(root, 'vazio', 'opencode.cmd');
		await mkdir(join(root, 'vazio'), { recursive: true });
		await writeFile(shim, NPM_SHIM, 'utf8');
		assert.strictEqual(resolveCmdShim(shim), undefined);
	});

	test('SESHYINA_OPENCODE_BIN aceita um .exe e recusa outra coisa', async () => {
		const exe = await fakeExe(join('custom', 'opencode.exe'));
		assert.strictEqual(findOpencodeBinary({ SESHYINA_OPENCODE_BIN: exe, PATH: '' }), exe);

		const shim = join(root, 'custom', 'outro.cmd');
		await writeFile(shim, '@echo off\n', 'utf8');
		assert.strictEqual(findOpencodeBinary({ SESHYINA_OPENCODE_BIN: shim, PATH: '' }), undefined);
		assert.strictEqual(findOpencodeBinary({ SESHYINA_OPENCODE_BIN: join(root, 'nada.exe') }), undefined);
	});
});
