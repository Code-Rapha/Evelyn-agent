/**
 * DEV-AUDIT-02: o bloqueio de sandbox é uma decisão registrada, não um
 * esquecimento.
 *
 * A investigação (ver `docs/dev-sandbox-limitations.md`) mostrou que neste
 * Windows não há mecanismo de confinamento disponível sem privilégio de
 * administrador: AppContainer exige criação de perfil elevada e teve estado
 * inconsistente; token restrito não pode ser lançado; Job Object não restringe
 * arquivo (foi medido: o `node` leu `C:\Windows\win.ini` e escreveu no perfil
 * do usuário).
 *
 * O que este arquivo protege:
 *
 * 1. O `DevRunner` continua executando com o token do usuário — e o código
 *    **diz** isso. Uma mudança que passe a afirmar isolamento sem implementá-lo
 *    falha aqui.
 * 2. A recusa de caminhos fora do checkout (DEV-AUDIT-01) continua valendo: é
 *    a proteção real que existe.
 * 3. Nenhum "modo sandbox" aparece nas opções enquanto não houver
 *    implementação — um nome que promete o que não entrega.
 */
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { assertArgumentsInsideRepository, DevRunner, DevCommandRefusedError } from '../core/dev/devRunner';

const runnerSource = readFileSync(join(__dirname, '..', '..', 'src', 'core', 'dev', 'devRunner.ts'), 'utf8');
const docsPath = join(__dirname, '..', '..', 'docs', 'dev-sandbox-limitations.md');

test('o runner documenta que executa com o token do usuário, sem sandbox', () => {
	assert.match(runnerSource, /token do usuário|token do usuário|Não é sandbox|não é sandbox/);
	assert.match(runnerSource, /Job Object|AppContainer/);
});

test('o runner não oferece opção de "sandbox" que não existe', () => {
	// Um campo com esse nome seria um contrato mentiroso: nada o implementaria.
	assert.ok(!/readonly\s+(sandbox|isolation|confine)\??\s*:/i.test(runnerSource));
});

test('a decisão está documentada no repositório', () => {
	const docs = readFileSync(docsPath, 'utf8');
	assert.match(docs, /Resultado: bloqueado/);
	assert.match(docs, /Job Object.*não|não.*ACL/s);
});

test('Job Object sozinho não é apresentado como sandbox', () => {
	// A regra do pedido, virada em teste: nenhuma menção a Job Object como
	// garantia de isolamento de arquivo.
	const mention = /Job Object[^.]*sandbox/i.exec(runnerSource);
	assert.equal(mention, null);
});

test('a recusa de caminho fora do checkout continua ativa', () => {
	assert.throws(
		() => assertArgumentsInsideRepository(['node', 'x.js', 'C:\\Windows\\win.ini'], 'C:\\repo'),
		DevCommandRefusedError,
	);
});

test('o runner instancia sem exigir nenhum recurso elevado', () => {
	// Construtor sem side effects: nenhuma chamada a AppContainer/Job ao criar.
	const runner = new DevRunner();
	assert.equal(runner.isRunning(), false);
});
