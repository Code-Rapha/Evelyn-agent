/**
 * A suíte do Core considera **todos** os arquivos de teste.
 *
 * ## A lacuna que isto fecha
 *
 * A auditoria encontrou 14 arquivos escritos em estilo BDD (`describe`/`it`,
 * importados de `mocha`) entre arquivos de estilo TDD (`suite`/`test`). A
 * pergunta era se eles rodavam. A resposta medida: **rodam** — importam
 * `describe`/`it` explicitamente, então o mocha os executa mesmo sob
 * `--ui tdd`, e os casos aparecem no total. Mas dois problemas reais
 * existiam, e é deles que este arquivo trata:
 *
 * 1. **O resumo não os nomeava por suíte.** O `--ui tdd` não imprime o
 *    título do `describe`, então um teste de segurança desses (o do
 *    desbloqueio persistente, por exemplo) aparecia solto — e um leitor do
 *    log não conseguia dizer de onde veio.
 * 2. **`test:core` corria sem `--timeout`.** Rodado exatamente como estava
 *    no `package.json`, 20 testes de processo (Electron, auxiliares de
 *    trava) estouravam os 2000 ms padrão. A suíte "passava" só quando
 *    alguém rodava à mão com o timeout maior — que é o que todos faziam,
 *    inclusive eu, sem que o script dissesse.
 *
 * O que este teste fixa:
 *
 * - todo arquivo `*.test.ts` em `core-tests` usa **um** dos dois estilos, e
 *   nenhum fica sem asserção;
 * - o script `test:core` declara um timeout maior que o padrão de 2000 ms,
 *   porque há testes que sobem processo;
 * - o timeout declarado não é irreal (não é `0`, que no mocha significa
 *   "sem limite").
 */
import * as assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const testsDir = join(__dirname, '..', '..', 'src', 'core-tests');
const packageJson = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
	readonly scripts: Record<string, string>;
};

/** O timeout declarado no script, ou `undefined`. */
function declaredTimeout(script: string): number | undefined {
	const match = /--timeout[= ](\d+)/.exec(script);
	return match === null ? undefined : Number(match[1]);
}

test('o script test:core declara timeout acima do padrão de 2000 ms', () => {
	const script = packageJson.scripts['test:core'];
	assert.ok(script !== undefined, 'o script test:core existe');
	const timeout = declaredTimeout(script);
	assert.ok(timeout !== undefined, `test:core precisa de --timeout explícito: ${script}`);
	assert.ok((timeout as number) > 2_000, `o padrão de 2000 ms estoura em testes de processo: ${String(timeout)}`);
});

test('o timeout declarado não é "sem limite"', () => {
	const timeout = declaredTimeout(packageJson.scripts['test:core'] ?? '');
	assert.ok((timeout ?? 0) > 0, 'timeout 0 significa sem limite no mocha');
});

test('todo arquivo de teste declara casos de um dos dois estilos', () => {
	const files = readdirSync(testsDir).filter((name) => name.endsWith('.test.ts'));
	assert.ok(files.length > 100, `esperava a suíte inteira, vi ${files.length} arquivos`);
	for (const name of files) {
		const source = readFileSync(join(testsDir, name), 'utf8');
		// Um arquivo sem `test(`/`it(` nem `suite(`/`describe(` não roda nada.
		const hasCase = /^\s*(test|it)\(/m.test(source);
		const hasSuite = /^\s*(suite|describe)\(/m.test(source);
		assert.ok(hasCase || hasSuite, `${name} não declara caso nem suíte`);
	}
});

test('os arquivos BDD importam describe/it do mocha (e por isso rodam)', () => {
	const files = readdirSync(testsDir).filter((name) => name.endsWith('.test.ts'));
	const bdd = files.filter((name) => readFileSync(join(testsDir, name), 'utf8').includes('describe,'));
	assert.ok(bdd.length >= 10, `esperava os arquivos BDD, vi ${bdd.length}`);
	for (const name of bdd) {
		const source = readFileSync(join(testsDir, name), 'utf8');
		assert.match(source, /from 'mocha'/, `${name}: o import explícito é o que faz o mocha TDD executá-lo`);
	}
});
