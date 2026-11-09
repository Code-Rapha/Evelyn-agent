/** Teste de regressão da resolução de binário do DEV (Windows). */
import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { DevCommandRefusedError, resolveCommand, validateDevCommand } from '../core/dev/devRunner';

const isWindows = process.platform === 'win32';

/** Um resolvedor falso: só os caminhos listados existem. */
function fakeFs(paths: readonly string[]) {
	const known = new Set(paths.map((entry) => (isWindows ? entry.toLowerCase() : entry)));
	return async (candidate: string): Promise<boolean> =>
		known.has(isWindows ? candidate.toLowerCase() : candidate);
}

const WINDOWS_ONLY = { skip: !isWindows ? 'resolução de .cmd só existe no Windows' : false };

test('o nome sem extensão não funciona sozinho: é o defeito que o resolveCommand corrige', () => {
	// Documenta a causa: o PATH tem `npm.cmd`, não `npm`.
	const argv = validateDevCommand('npm run test');
	assert.equal(argv[0], 'npm', 'a allowlist fala o nome lógico');
});

test('npm resolve para o .cmd do PATH e passa pelo cmd.exe', WINDOWS_ONLY, async () => {
	const nodeDir = 'C:\\Program Files\\nodejs';
	const resolved = await resolveCommand('npm', ['run', 'test'], {
		path: `C:\\Windows;${nodeDir}`,
		pathExt: '.COM;.EXE;.BAT;.CMD',
		fileExists: fakeFs([`${nodeDir}\\npm.cmd`]),
	});
	assert.equal(resolved.viaShell, true);
	assert.match(resolved.file.toLowerCase(), /cmd\.exe$/);
	assert.equal(resolved.args[0], '/d');
	assert.equal(resolved.args[1], '/s');
	assert.equal(resolved.args[2], '/c');
	// A linha inteira entre aspas, com o caminho real, entre aspas internas.
	const line = resolved.args[3];
	assert.ok(line.startsWith('"') && line.endsWith('"'));
	assert.match(line, /"C:\\Program Files\\nodejs\\npm\.cmd"/, 'o caminho com espaço fica inteiro entre aspas');
	assert.match(line, /"run"/);
	assert.match(line, /"test"/);
});

test('um .exe do PATH é executado direto, sem shell no meio', WINDOWS_ONLY, async () => {
	const dir = 'C:\\Program Files\\Git\\cmd';
	const resolved = await resolveCommand('git', ['status'], {
		path: dir,
		pathExt: '.COM;.EXE;.BAT;.CMD',
		fileExists: fakeFs([`${dir}\\git.exe`]),
	});
	assert.equal(resolved.viaShell, false);
	assert.match(resolved.file, /git\.exe$/);
	assert.deepEqual(resolved.args, ['status']);
});

test('o PATHEXT é respeitado na ordem: .EXE antes de .CMD quando ambos existem', WINDOWS_ONLY, async () => {
	const dir = 'C:\\tools';
	const resolved = await resolveCommand('foo', [], {
		path: dir,
		pathExt: '.COM;.EXE;.CMD',
		fileExists: fakeFs([`${dir}\\foo.exe`, `${dir}\\foo.cmd`]),
	});
	assert.match(resolved.file, /foo\.exe$/);
	assert.equal(resolved.viaShell, false);
});

test('um binário ausente é recusado com o motivo, não deixa o spawn falhar', WINDOWS_ONLY, async () => {
	await assert.rejects(
		async () => resolveCommand('npm', [], { path: 'C:\\vazio', pathExt: '.CMD', fileExists: fakeFs([]) }),
		(error: unknown) => {
			assert.ok(error instanceof DevCommandRefusedError);
			assert.match(error.message, /PATH/);
			return true;
		},
	);
});

test('argumento com metacaractere do cmd é recusado (segunda barreira)', WINDOWS_ONLY, async () => {
	const dir = 'C:\\tools';
	for (const bad of ['a%b', 'a!b', 'a^b', 'a"b']) {
		await assert.rejects(
			async () =>
				resolveCommand('npm', ['run', bad], {
					path: dir,
					pathExt: '.CMD',
					fileExists: fakeFs([`${dir}\\npm.cmd`]),
				}),
			DevCommandRefusedError,
			bad,
		);
	}
});

test('um caminho absoluto que existe não é procurado no PATH', () => {
	const absolute = isWindows ? 'C:\\tools\\node.exe' : '/usr/bin/node';
	return resolveCommand(absolute, ['x.js'], {
		path: '',
		fileExists: fakeFs([absolute]),
	}).then((resolved) => {
		assert.equal(resolved.file, absolute);
	});
});
