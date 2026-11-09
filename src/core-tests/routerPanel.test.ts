/**
 * O painel do roteador: o que ele mostra e o que ele grava.
 *
 * ## O que se prova
 *
 * 1. A configuração é lida e devolvida com o formato que a janela entende;
 * 2. O interruptor **persiste** e a leitura seguinte devolve o que foi
 *    gravado — o painel mostra o estado real, não o que o botão pressupôs;
 * 3. Mudar só o interruptor não mexe no modo, e mudar só o modo não mexe no
 *    interruptor;
 * 4. Uma mudança impossível é **recusada** e o estado anterior fica de pé;
 * 5. A janela nunca recebe chave de API — nem pela configuração, nem pelo
 *    resumo de provedores.
 */
import * as assert from 'assert';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProviderConfigService } from '../core/providers/config';
import { LoggingService } from '../core/logging';
import type { FetchLike, FetchResponseLike } from '../core/providers/openaiCompatible';
import { ConsoleLogSink } from '../adapters/local/consoleLogSink';
import { ACCESS_POLICY_FILE, FileDataStore, ROUTER_CONFIG_FILE } from '../adapters/local/fileDataStore';
import { FileSecretStore } from '../adapters/local/fileSecretStore';
import { FileStateStore } from '../adapters/local/fileStateStore';
import { ChatSession } from '../desktop/chatSession';
import { parseRouterConfigView } from '../desktop/routerConfigParsers';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const ROUTER_ID = 'roteador';

function jsonResponse(body: unknown): FetchResponseLike {
	return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

suite('Router panel: the state it shows', () => {
	let root: string;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-router-panel-'));
	});

	teardown(async () => {
		await removeFixtureTree(root);
	});

	function session(): ChatSession {
		const fetchImpl: FetchLike = async (url) =>
			url.endsWith('/models') ? jsonResponse({ data: [{ id: 'alfa' }] }) : jsonResponse({});
		return new ChatSession({
			config: new ProviderConfigService(new FileStateStore({ filePath: join(root, 'state.json') })),
			secrets: new FileSecretStore({ filePath: join(root, 'secrets.json') }),
			history: new FileDataStore({ rootPath: join(root, 'data') }),
			logger: new LoggingService(new ConsoleLogSink({ out: () => undefined, err: () => undefined })),
			fetchImpl,
		});
	}

	test('a fresh install shows the default, and says it was never configured', async () => {
		const view = await session().readRouterConfig();
		assert.strictEqual(view.mode, 'native');
		assert.strictEqual(view.enabled, true);
		assert.strictEqual(view.configured, false, 'o padrão não é uma escolha do usuário');
	});

	test('the switch persists, and the next read returns what was written', async () => {
		const chat = session();
		const saved = await chat.changeRouterConfig({ enabled: false });
		assert.strictEqual(saved.enabled, false);
		assert.strictEqual(saved.configured, true, 'agora é uma escolha');
		const read = await chat.readRouterConfig();
		assert.strictEqual(read.enabled, false, 'o painel mostra o estado real');
	});

	test('the switch does not touch the mode, and the mode does not touch the switch', async () => {
		const chat = session();
		// O destino tem de existir: uma configuração que aponta para um
		// provedor ausente é recusada, e não gravada.
		await chat.saveProvider({ id: 'roteador', name: 'Roteador', baseUrl: 'http://localhost:20128/v1' });
		await chat.changeRouterConfig({
			mode: 'external',
			externalRouterProviderId: 'roteador',
		});
		const afterMode = await chat.changeRouterConfig({ enabled: false });
		assert.strictEqual(afterMode.mode, 'external', 'o modo continua');
		assert.strictEqual(afterMode.enabled, false);
		const afterSwitch = await chat.changeRouterConfig({ mode: 'native' });
		assert.strictEqual(afterSwitch.enabled, false, 'o interruptor continua');
		assert.strictEqual(afterSwitch.mode, 'native');
	});

	test('an impossible change is refused and the previous state stands', async () => {
		const chat = session();
		await chat.saveProvider({ id: 'direto', name: 'Direto', baseUrl: 'http://localhost:20202/v1' });
		await chat.changeRouterConfig({ mode: 'direct', directProviderId: 'direto' });
		await assert.rejects(
			() => chat.changeRouterConfig({ mode: 'external' }),
			/mode|provedor|requires/i,
		);
		const after = await chat.readRouterConfig();
		assert.strictEqual(after.mode, 'direct', 'o estado anterior continua de pé');
	});

	test('the configuration lives in its own file, and holds no key', async () => {
		const chat = session();
		await chat.saveProvider({ id: 'direto', name: 'Direto', baseUrl: 'http://localhost:20202/v1' });
		await chat.changeRouterConfig({ mode: 'direct', directProviderId: 'direto' });
		const raw = await readFile(join(root, 'data', ROUTER_CONFIG_FILE), 'utf8');
		assert.ok(raw.includes('"mode"'));
		assert.strictEqual(/api[_-]?key|authorization|bearer|secret|sk-/i.test(raw), false);
		// E ela não se mistura com a política de acesso.
		const policyRaw = await readFile(join(root, 'data', ACCESS_POLICY_FILE), 'utf8').catch(() => '');
		assert.strictEqual(policyRaw.includes('"mode"'), false);
	});

	test('the window never receives a key through the router configuration', async () => {
		const chat = session();
		const view = await chat.readRouterConfig();
		const raw = JSON.stringify(view);
		assert.strictEqual(/api[_-]?key|authorization|bearer|secret|sk-/i.test(raw), false);
		assert.strictEqual(Object.keys(view).includes('apiKeyRef'), false);
	});
});

suite('Router panel: the parser on the bridge', () => {
	test('a well-formed configuration passes through', () => {
		const parsed = parseRouterConfigView({
			mode: 'external',
			enabled: false,
			externalRouterProviderId: 'roteador',
			updatedAt: '2026-10-20T12:00:00.000Z',
			configured: true,
		});
		assert.deepStrictEqual(parsed, {
			mode: 'external',
			enabled: false,
			externalRouterProviderId: 'roteador',
			updatedAt: '2026-10-20T12:00:00.000Z',
			configured: true,
		});
	});

	test('a mode outside the vocabulary is refused', () => {
		assert.strictEqual(parseRouterConfigView({ mode: 'magic', enabled: true }), undefined);
	});

	test('a switch that is not a boolean is refused', () => {
		assert.strictEqual(parseRouterConfigView({ mode: 'native', enabled: 'sim' }), undefined);
	});

	test('a configuration that is not an object is refused', () => {
		assert.strictEqual(parseRouterConfigView('nada'), undefined);
		assert.strictEqual(parseRouterConfigView(undefined), undefined);
	});

	test('a missing provider id is simply absent', () => {
		const parsed = parseRouterConfigView({ mode: 'native', enabled: true });
		assert.strictEqual(parsed?.externalRouterProviderId, undefined);
		assert.strictEqual(parsed?.directProviderId, undefined);
	});
});
