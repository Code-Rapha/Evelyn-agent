/**
 * A suíte tem três alvos, e a divisão cobre **toda** a suíte.
 *
 * ## Por que dividir
 *
 * `test:core` roda tudo em ~4 minutos, e a maior parte é espera de processo:
 * os que abrem Electron e os que sobem o serviço. Para o ciclo de
 * desenvolvimento, 4 minutos para saber se uma função pura está certa é caro
 * demais — e a espera torna a suíte sensível à carga da máquina.
 *
 * Três alvos, por **natureza** e não por tempo:
 *
 * | alvo | o que roda | por que |
 * | --- | --- | --- |
 * | `test:unit` | lógica, com fakes | rápido, sem processo |
 * | `test:process` | spawn de node, serviço real | precisa de `web:build` |
 * | `test:electron` | janela real | precisa de `desktop:build`, ~2 min |
 * | `test:core` | tudo | o que tem de passar antes de publicar |
 *
 * ## O que este teste garante
 *
 * Que a soma dos três **é** a suíte: nenhum arquivo fica de fora (a primeira
 * versão deixava três `.integration` sem dono) e nenhum roda em dois alvos.
 * Se alguém acrescentar um teste de processo e esquecer de pô-lo no alvo, a
 * conta aqui falha.
 */
import * as assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = join(__dirname, '..', '..');
const outDir = join(root, 'out', 'core-tests');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
	readonly scripts: Record<string, string>;
};

/** Os nomes de arquivo citados explicitamente em um script. */
function namedFiles(script: string): string[] {
	return [...script.matchAll(/out\/core-tests\/([\w.-]+\.test\.js)/g)].map((match) => match[1] as string);
}

/** Os arquivos que um script `--ignore` remove. */
function ignoredFiles(script: string): string[] {
	const matches = [...script.matchAll(/--ignore\s+\\?"out\/core-tests\/([\w.-]+\.test\.js)\\?"/g)];
	return matches.map((match) => match[1] as string);
}

/**
 * O `unit` exclui os arquivos de `process`/`electron` — por `--ignore`
 * explícito, um por arquivo. O glob `**\/*.integration.test.js` **não** entra
 * na lista: três integrações sem processo (`connectedProviders`,
 * `editRouterConfig`, `sharedRouterConfig`) rodam no `unit`, e o glob as
 * tiraria de todos os alvos.
 */
function unitExcludes(script: string): string[] {
	return ignoredFiles(script);
}

test('os três alvos existem e cada um chama mocha', () => {
	for (const name of ['test:unit', 'test:process', 'test:electron', 'test:core']) {
		const script = pkg.scripts[name];
		assert.ok(script !== undefined, `${name} não existe`);
		assert.match(script as string, /mocha/, `${name} não roda mocha`);
	}
});

test('process e electron não compartilham nenhum arquivo', () => {
	const electron = namedFiles(pkg.scripts['test:electron'] ?? '');
	const processFiles = namedFiles(pkg.scripts['test:process'] ?? '');
	const both = electron.filter((file) => processFiles.includes(file));
	assert.deepEqual(both, [], 'um teste não pode estar em dois alvos');
	assert.ok(electron.length >= 5, 'o alvo electron tem os testes de janela');
	assert.ok(processFiles.length >= 5, 'o alvo process tem os testes de processo');
});

test('unit não roda o que process ou electron já rodam', () => {
	const electron = namedFiles(pkg.scripts['test:electron'] ?? '');
	const processFiles = namedFiles(pkg.scripts['test:process'] ?? '');
	const ignored = ignoredFiles(pkg.scripts['test:unit'] ?? '');
	const leaked = [...electron, ...processFiles].filter((file) => !ignored.includes(file));
	assert.deepEqual(leaked, [], 'o unit tem de excluir o que os outros alvos rodam');
});

test('a soma dos três alvos cobre toda a suíte', () => {
	// Só quando a suíte foi compilada (o `pretest:core` faz isso).
	let all: string[];
	try {
		all = readdirSync(outDir).filter((name) => name.endsWith('.test.js'));
	} catch {
		return;
	}
	if (all.length === 0) {
		return;
	}
	const electron = namedFiles(pkg.scripts['test:electron'] ?? '');
	const processFiles = namedFiles(pkg.scripts['test:process'] ?? '');
	const ignored = ignoredFiles(pkg.scripts['test:unit'] ?? '');
	// O `unit` roda o glob inteiro, menos o que ele exclui. Um arquivo é
	// coberto se está no `electron`, no `process` ou **não** está excluído do
	// `unit` (o glob o pega).
	const unitRuns = (name: string): boolean => !ignored.includes(name) && !electron.includes(name) && !processFiles.includes(name);
	const unowned = all.filter((name) => !electron.includes(name) && !processFiles.includes(name) && !unitRuns(name));
	assert.deepEqual(unowned, [], 'todo arquivo da suíte pertence a um alvo');
});
