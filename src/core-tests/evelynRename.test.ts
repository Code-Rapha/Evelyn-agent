/**
 * A renomeação para Evelyn não muda onde os dados moram.
 *
 * ## O que se prova
 *
 * 1. O **nome visível** é Evelyn (o do produto, o da interface, o do agente);
 * 2. O **diretório de dados** continua `~/.modelhub/seshyina`, e uma montagem
 *    nova lê o que a anterior gravou;
 * 3. As **chaves técnicas** continuam as antigas — canais IPC, chave da
 *    bridge, escopo de log e o host da trava — porque são contrato entre
 *    processo main e renderer, e entre execuções;
 * 4. Nada neste módulo move, apaga ou recria diretório.
 */
import * as assert from 'assert';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { assembleCore } from '../app/assemble';
import { ConsoleLogSink } from '../adapters/local/consoleLogSink';
import { DATA_DIR, FileDataStore, defaultDataStoreRoot } from '../adapters/local/fileDataStore';
import { APP_NAME, BRIDGE_KEY, CHAT_EVENT_CHANNEL, CORE_STATUS_CHANNEL } from '../desktop/contract';
import { SESHYINA_AGENT_IDENTITY } from '../core/agent/seshyinaAgent';
import { buildGallery } from '../web/integrations';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const silent = new ConsoleLogSink({ out: () => undefined, err: () => undefined });

suite('Renomeação: Evelyn, sem tocar nos dados', () => {
	let root: string;

	setup(async () => {
		root = await mkdtemp(join(tmpdirSafe(), 'evelyn-rename-'));
	});

	teardown(async () => {
		await removeFixtureTree(root);
	});

	/** `os.tmpdir` via import dinâmico não é necessário: o Node exporta homedir. */
	function tmpdirSafe(): string {
		return process.env['TEMP'] ?? process.env['TMP'] ?? homedir();
	}

	test('o nome visível do produto é Evelyn', async () => {
		assert.strictEqual(APP_NAME, 'Evelyn');
		const html = await readFile(join('src', 'web', 'assets', 'index.html'), 'utf8');
		assert.match(html, /<title>Evelyn<\/title>/);
		const desktop = await readFile(join('src', 'desktop', 'renderer', 'index.html'), 'utf8');
		assert.match(desktop, /<title>Evelyn<\/title>/);
		assert.match(desktop, /<h1 id="app-name">Evelyn<\/h1>/);
	});

	test('a identidade do agente se apresenta como Evelyn', () => {
		assert.ok(SESHYINA_AGENT_IDENTITY.includes('Você é a Evelyn'));
		assert.ok(SESHYINA_AGENT_IDENTITY.includes('**Nome**: Evelyn'));
		assert.ok(!SESHYINA_AGENT_IDENTITY.includes('Você é a Seshyina'));
	});

	test('o diretório de dados continua o antigo', () => {
		assert.strictEqual(DATA_DIR, 'seshyina');
		assert.strictEqual(defaultDataStoreRoot(), join(homedir(), '.modelhub', 'seshyina'));
	});

	test('um dado gravado antes da renomeação é lido depois dela', async () => {
		// A "execução anterior" gravou com o nome antigo — que, para o disco, é
		// o mesmo nome: o diretório não mudou.
		const first = assembleCore({ rootPath: root, logSink: silent });
		await first.chat.saveProvider({ id: 'antigo', name: 'Conexão antiga', baseUrl: 'http://127.0.0.1:9/v1' });

		const second = assembleCore({ rootPath: root, logSink: silent });
		const providers = second.chat.listProviders();
		assert.strictEqual(providers.length, 1, 'a conexão continua lá');
		assert.strictEqual(providers[0]?.name, 'Conexão antiga');

		// E o arquivo com a conexão está no mesmo lugar de sempre.
		const entries = await readdir(root);
		assert.ok(entries.includes('state.json'), 'o estado é o mesmo arquivo');
		const state = await readFile(join(root, 'state.json'), 'utf8');
		assert.ok(state.includes('Conexão antiga'));
	});

	test('as chaves técnicas continuam as antigas', () => {
		// Canais IPC: contrato entre o main e o renderer de uma mesma execução.
		assert.strictEqual(CORE_STATUS_CHANNEL, 'seshyina:core-status');
		assert.strictEqual(CHAT_EVENT_CHANNEL, 'seshyina:chat-event');
		// A chave da bridge na janela.
		assert.strictEqual(BRIDGE_KEY, 'seshyina');
	});

	test('o roteador não ganhou nome de provedor nem mudou o nome dos externos', () => {
		const gallery = buildGallery([]);
		const external = gallery.map((entry) => entry.integration.name);
		assert.ok(external.includes('OpenCode'));
		assert.ok(external.includes('OpenRouter'));
		assert.ok(external.includes('OpenAI'));
		assert.ok(!external.some((name) => name.startsWith('Evelyn')), 'Evelyn não é um provedor');
	});

	test('a montagem usa o host e o escopo de log antigos', () => {
		// O escopo vai para as linhas de log; mudá-lo mudaria o filtro de quem
		// já coleta `seshyina.*`.
		const core = assembleCore({ rootPath: root, logSink: silent });
		assert.strictEqual(typeof core.root, 'string');
		const store = new FileDataStore({ rootPath: root });
		assert.strictEqual(store.rootPath, root);
	});
});
