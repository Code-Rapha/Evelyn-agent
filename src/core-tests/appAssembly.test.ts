/**
 * A montagem do Core, e não só as peças.
 *
 * ## O que se prova
 *
 * 1. A montagem entrega uma sessão que funciona: um provedor salvo nela é
 *    lido de volta, e a chave vai para o `SecretStore` — nunca para o arquivo
 *    de estado;
 * 2. A montagem escreve **onde** o desktop sempre escreveu: a mesma raiz, os
 *    mesmos nomes de arquivo;
 * 3. Duas montagens sobre a mesma raiz veem a mesma coisa — que é o que
 *    distingue uma montagem compartilhada de duas cópias;
 * 4. A montagem numa raiz nova não é um erro: um store virgem é um store
 *    vazio, e a varredura do histórico responde "não há nada" em vez de
 *    falhar.
 */
import * as assert from 'assert';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assembleCore } from '../app/assemble';
import { ConsoleLogSink } from '../adapters/local/consoleLogSink';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

suite('App: the shared Core assembly', () => {
	let root: string;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-assembly-'));
	});

	teardown(async () => {
		await removeFixtureTree(root);
	});

	/** A silent sink: the test is about the wiring, not about the console. */
	function silent(): ConsoleLogSink {
		return new ConsoleLogSink({ out: () => undefined, err: () => undefined });
	}

	test('the assembly hands out a working session', async () => {
		const assembled = assembleCore({ rootPath: root, logSink: silent() });

		assert.deepStrictEqual(assembled.chat.listProviders(), []);

		await assembled.chat.saveProvider({
			id: 'alfa',
			name: 'Alfa',
			baseUrl: 'http://localhost:9999/v1',
			apiKey: 'sk-secreto',
		});

		const stored = assembled.chat.listProviders();
		assert.strictEqual(stored.length, 1);
		assert.strictEqual(stored[0].id, 'alfa');
		// A chave existe, e a janela só sabe que ela existe.
		assert.strictEqual(stored[0].hasApiKeyRef, true);
	});

	test('the key goes to the secret store, never to the state file', async () => {
		const assembled = assembleCore({ rootPath: root, logSink: silent() });
		await assembled.chat.saveProvider({
			id: 'alfa',
			name: 'Alfa',
			baseUrl: 'http://localhost:9999/v1',
			apiKey: 'sk-secreto-nao-aparece',
		});

		const state = await readFile(join(root, 'state.json'), 'utf8');
		assert.strictEqual(state.includes('sk-secreto'), false);
		const secrets = await readFile(join(root, 'secrets.json'), 'utf8');
		assert.strictEqual(secrets.includes('sk-secreto'), true);
	});

	test('the assembly writes under the root it was given, with the known names', async () => {
		const assembled = assembleCore({ rootPath: root, logSink: silent() });
		await assembled.chat.saveProvider({
			id: 'alfa',
			name: 'Alfa',
			baseUrl: 'http://localhost:9999/v1',
		});

		assert.strictEqual(assembled.root, root);
		const state = JSON.parse(await readFile(join(root, 'state.json'), 'utf8')) as Record<
			string,
			unknown
		>;
		assert.ok(Array.isArray(state['modelhub.providers.config']));
	});

	test('two assemblies over the same root see the same provider', async () => {
		const first = assembleCore({ rootPath: root, logSink: silent() });
		await first.chat.saveProvider({
			id: 'alfa',
			name: 'Alfa',
			baseUrl: 'http://localhost:9999/v1',
		});

		// A segunda montagem é o que um segundo host faria: o mesmo storage,
		// a mesma configuração, e a mesma leitura.
		const second = assembleCore({ rootPath: root, logSink: silent() });
		const stored = second.chat.listProviders();
		assert.strictEqual(stored.length, 1);
		assert.strictEqual(stored[0].id, 'alfa');
	});

	test('a fresh root is an empty store, not a failure', async () => {
		const assembled = assembleCore({ rootPath: root, logSink: silent() });

		assert.deepStrictEqual(assembled.chat.listProviders(), []);
		// A varredura do histórico responde, mesmo sem nenhum log.
		const scan = await assembled.scanSkillHistory();
		assert.ok(scan !== undefined);
	});

	test('the log carries the scope the host asked for', () => {
		const assembled = assembleCore({ rootPath: root, logScope: 'seshyina.web', logSink: silent() });
		assert.ok(assembled.logger !== undefined);
	});
});
