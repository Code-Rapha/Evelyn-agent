/**
 * A configuração do roteador pela interface: modo, destino, papel do
 * endpoint, persistência e a proteção das chaves.
 *
 * ## O que se prova
 *
 * 1. Trocar de modo grava e recarrega o estado real;
 * 2. Escolher o destino grava o id certo — e um destino desabilitado ou
 *    inexistente é **recusado**, com o motivo;
 * 3. Promover um endpoint a roteador e rebaixá-lo de volta funciona, e o
 *    rebaixamento recusa quando o modo ativo está usando aquele endpoint;
 * 4. O papel sobrevive a uma edição do provedor;
 * 5. Nenhuma chave de API passa pelo caminho, nem no arquivo, nem na resposta.
 */
import * as assert from 'assert';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProviderConfigService } from '../core/providers/config';
import { LoggingService } from '../core/logging';
import type { FetchLike, FetchResponseLike } from '../core/providers/openaiCompatible';
import { ConsoleLogSink } from '../adapters/local/consoleLogSink';
import { FileDataStore } from '../adapters/local/fileDataStore';
import { FileSecretStore } from '../adapters/local/fileSecretStore';
import { FileStateStore } from '../adapters/local/fileStateStore';
import { ChatSession } from '../desktop/chatSession';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const ROUTER_ID = 'roteador';
const DIRECT_ID = 'direto';

function jsonResponse(body: unknown): FetchResponseLike {
	return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

suite('Router settings: the mode and the destination', () => {
	let root: string;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-router-settings-'));
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

	async function ready(): Promise<ChatSession> {
		const chat = session();
		await chat.saveProvider({ id: ROUTER_ID, name: 'Roteador', baseUrl: 'http://localhost:20128/v1' });
		await chat.saveProvider({ id: DIRECT_ID, name: 'Direto', baseUrl: 'http://localhost:20202/v1' });
		return chat;
	}

	test('changing the mode persists and is read back', async () => {
		const chat = await ready();
		const saved = await chat.changeRouterConfig({ mode: 'external', externalRouterProviderId: ROUTER_ID });
		assert.strictEqual(saved.mode, 'external');
		assert.strictEqual(saved.externalRouterProviderId, ROUTER_ID);
		const read = await chat.readRouterConfig();
		assert.strictEqual(read.mode, 'external');
		assert.strictEqual(read.configured, true);
	});

	test('the native mode needs no destination', async () => {
		const chat = await ready();
		const saved = await chat.changeRouterConfig({ mode: 'native' });
		assert.strictEqual(saved.mode, 'native');
		assert.strictEqual(saved.externalRouterProviderId, undefined);
	});

	test('the external mode without a router is refused', async () => {
		const chat = await ready();
		await assert.rejects(
			() => chat.changeRouterConfig({ mode: 'external' }),
			/provedor/i,
		);
		// E o estado anterior continua de pé.
		assert.strictEqual((await chat.readRouterConfig()).mode, 'native');
	});

	test('a destination that does not exist is refused', async () => {
		const chat = await ready();
		await assert.rejects(
			() => chat.changeRouterConfig({ mode: 'external', externalRouterProviderId: 'fantasma' }),
			/não está configurado/i,
		);
		assert.strictEqual((await chat.readRouterConfig()).mode, 'native');
	});

	test('a disabled destination is refused, with the reason', async () => {
		const chat = await ready();
		// Desabilitar o endpoint é uma operação da interface, e é por ela que
		// um destino desabilitado aparece.
		await chat.setProviderEnabled(ROUTER_ID, false);
		await assert.rejects(
			() => chat.changeRouterConfig({ mode: 'external', externalRouterProviderId: ROUTER_ID }),
			/desabilitado/i,
		);
		assert.strictEqual((await chat.readRouterConfig()).mode, 'native');
	});

	test('a connection can be enabled and disabled', async () => {
		const chat = await ready();
		const off = await chat.setProviderEnabled(ROUTER_ID, false);
		assert.strictEqual(off.status, 'disabled');
		const providers = await chat.listProviders();
		assert.strictEqual(providers.find((entry) => entry.id === ROUTER_ID)?.status, 'disabled');
		const on = await chat.setProviderEnabled(ROUTER_ID, true);
		assert.strictEqual(on.status, 'configured');
	});

	test('the switch still works when the destination was disabled', async () => {
		const chat = await ready();
		await chat.changeRouterConfig({ mode: 'external', externalRouterProviderId: ROUTER_ID });
		await chat.setProviderEnabled(ROUTER_ID, false);
		// O interruptor do painel principal muda só o `enabled`: ele não pode
		// ser impedido pelo endpoint que o modo herdado apontava.
		const after = await chat.changeRouterConfig({ enabled: false });
		assert.strictEqual(after.enabled, false);
		assert.strictEqual(after.mode, 'external');
		assert.strictEqual(after.externalRouterProviderId, ROUTER_ID);
	});

	test('choosing a disabled destination again is still refused', async () => {
		const chat = await ready();
		await chat.setProviderEnabled(ROUTER_ID, false);
		await assert.rejects(
			() => chat.changeRouterConfig({ mode: 'external', externalRouterProviderId: ROUTER_ID }),
			/desabilitado/i,
		);
	});

	test('enabling an endpoint that does not exist is refused', async () => {
		const chat = await ready();
		await assert.rejects(() => chat.setProviderEnabled('fantasma', false), /não há provedor/i);
	});

	test('the switch and the mode live together in one record', async () => {
		const chat = await ready();
		await chat.changeRouterConfig({ mode: 'direct', directProviderId: DIRECT_ID, enabled: false });
		const read = await chat.readRouterConfig();
		assert.strictEqual(read.mode, 'direct');
		assert.strictEqual(read.enabled, false);
		assert.strictEqual(read.directProviderId, DIRECT_ID);
	});
});

suite('Router settings: the role of an endpoint', () => {
	let root: string;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-router-role-'));
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

	async function ready(): Promise<ChatSession> {
		const chat = session();
		await chat.saveProvider({ id: ROUTER_ID, name: 'Roteador', baseUrl: 'http://localhost:20128/v1' });
		return chat;
	}

	test('an endpoint starts as a provider', async () => {
		const chat = await ready();
		const providers = await chat.listProviders();
		assert.strictEqual(providers.find((entry) => entry.id === ROUTER_ID)?.role, undefined);
	});

	test('promoting an endpoint makes it a router', async () => {
		const chat = await ready();
		const summary = await chat.setProviderRole(ROUTER_ID, 'router');
		assert.strictEqual(summary.role, 'router');
		const providers = await chat.listProviders();
		assert.strictEqual(providers.find((entry) => entry.id === ROUTER_ID)?.role, 'router');
	});

	test('demoting it back works when the mode does not use it', async () => {
		const chat = await ready();
		await chat.setProviderRole(ROUTER_ID, 'router');
		const summary = await chat.setProviderRole(ROUTER_ID, 'provider');
		assert.strictEqual(summary.role, undefined, 'voltar a provedor é voltar ao padrão');
	});

	test('demoting the endpoint the external mode uses is refused, with the reason', async () => {
		const chat = await ready();
		await chat.setProviderRole(ROUTER_ID, 'router');
		await chat.changeRouterConfig({ mode: 'external', externalRouterProviderId: ROUTER_ID });
		await assert.rejects(
			() => chat.setProviderRole(ROUTER_ID, 'provider'),
			/modo.*externo|usando/i,
		);
		// E o papel continua de roteador.
		const providers = await chat.listProviders();
		assert.strictEqual(providers.find((entry) => entry.id === ROUTER_ID)?.role, 'router');
	});

	test('promoting an endpoint that does not exist is refused', async () => {
		const chat = await ready();
		await assert.rejects(() => chat.setProviderRole('fantasma', 'router'), /não há provedor/i);
	});

	test('the role survives an edit of the provider', async () => {
		const chat = await ready();
		await chat.setProviderRole(ROUTER_ID, 'router');
		await chat.saveProvider({
			id: ROUTER_ID,
			name: 'Roteador renomeado',
			baseUrl: 'http://localhost:20128/v1',
			role: 'router',
		});
		const providers = await chat.listProviders();
		const entry = providers.find((candidate) => candidate.id === ROUTER_ID);
		assert.strictEqual(entry?.role, 'router');
		assert.strictEqual(entry?.name, 'Roteador renomeado');
	});
});

suite('Router settings: the keys stay out of sight', () => {
	let root: string;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-router-keys-'));
	});

	teardown(async () => {
		await removeFixtureTree(root);
	});

	test('the provider summary says whether a key exists, and never its value', async () => {
		const fetchImpl: FetchLike = async (url) =>
			url.endsWith('/models') ? jsonResponse({ data: [] }) : jsonResponse({});
		const chat = new ChatSession({
			config: new ProviderConfigService(new FileStateStore({ filePath: join(root, 'state.json') })),
			secrets: new FileSecretStore({ filePath: join(root, 'secrets.json') }),
			history: new FileDataStore({ rootPath: join(root, 'data') }),
			logger: new LoggingService(new ConsoleLogSink({ out: () => undefined, err: () => undefined })),
			fetchImpl,
		});
		await chat.saveProvider({
			id: 'com-chave',
			name: 'Com chave',
			baseUrl: 'http://localhost:3030/v1',
			apiKey: 'sk-secreto-nao-aparece',
		});
		const providers = await chat.listProviders();
		const summary = providers.find((entry) => entry.id === 'com-chave');
		assert.strictEqual(summary?.hasApiKeyRef, true, 'a janela sabe que existe uma');
		const raw = JSON.stringify(summary);
		assert.strictEqual(raw.includes('sk-secreto'), false, 'mas nunca o valor');
		assert.strictEqual(raw.includes('apiKeyRef'), false);
	});

	test('the state file holds the reference, not the key', async () => {
		const fetchImpl: FetchLike = async (url) =>
			url.endsWith('/models') ? jsonResponse({ data: [] }) : jsonResponse({});
		const chat = new ChatSession({
			config: new ProviderConfigService(new FileStateStore({ filePath: join(root, 'state.json') })),
			secrets: new FileSecretStore({ filePath: join(root, 'secrets.json') }),
			history: new FileDataStore({ rootPath: join(root, 'data') }),
			logger: new LoggingService(new ConsoleLogSink({ out: () => undefined, err: () => undefined })),
			fetchImpl,
		});
		await chat.saveProvider({
			id: 'com-chave',
			name: 'Com chave',
			baseUrl: 'http://localhost:3030/v1',
			apiKey: 'sk-secreto-nao-aparece',
		});
		const state = await readFile(join(root, 'state.json'), 'utf8');
		assert.strictEqual(state.includes('sk-secreto'), false, 'a chave não vai para o estado');
	});

	test('promoting a role does not touch the key', async () => {
		const fetchImpl: FetchLike = async (url) =>
			url.endsWith('/models') ? jsonResponse({ data: [] }) : jsonResponse({});
		const chat = new ChatSession({
			config: new ProviderConfigService(new FileStateStore({ filePath: join(root, 'state.json') })),
			secrets: new FileSecretStore({ filePath: join(root, 'secrets.json') }),
			history: new FileDataStore({ rootPath: join(root, 'data') }),
			logger: new LoggingService(new ConsoleLogSink({ out: () => undefined, err: () => undefined })),
			fetchImpl,
		});
		await chat.saveProvider({
			id: 'com-chave',
			name: 'Com chave',
			baseUrl: 'http://localhost:3030/v1',
			apiKey: 'sk-secreto-nao-aparece',
		});
		const summary = await chat.setProviderRole('com-chave', 'router');
		assert.strictEqual(summary.hasApiKeyRef, true, 'a chave continua lá');
		assert.strictEqual(JSON.stringify(summary).includes('sk-secreto'), false);
	});
});
