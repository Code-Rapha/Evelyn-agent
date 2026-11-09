/**
 * DEV-8.11: fonte única da configuração do roteador, **ponta a ponta**.
 *
 * ## O que se prova
 *
 * Sobe um **serviço HTTP de verdade** (`startWebServer`) sobre uma raiz
 * descartável, com o Core montado e o token de leitura configurado. A partir
 * daí:
 *
 * 1. O desktop conectado lê `GET /api/routing` pelo `ServiceClient` — o mesmo
 *    caminho que o app usa no modo conectado — e recebe a decisão do Core do
 *    serviço;
 * 2. Alterar a configuração **no serviço** muda o que o desktop lê, sem
 *    reiniciar nada;
 * 3. Os três modos do chat obedecem a configuração compartilhada,
 *    executando pelo `WebChatEndpoint` do serviço;
 * 4. A resposta não carrega a chave do provedor nem o token de leitura.
 *
 * ## O que é simulado
 *
 * O `fetchImpl` dos **provedores** (um servidor falso que registra destino e
 * devolve SSE). Nenhuma rede externa, nenhuma chave real: a chave do provedor
 * nasce aqui, para provar que não vaza.
 */
import * as assert from 'assert';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assembleCore } from '../app/assemble';
import { ConsoleLogSink } from '../adapters/local/consoleLogSink';
import type { FetchLike, FetchResponseLike } from '../core/providers/openaiCompatible';
import { startWebServer } from '../web/server';
import { WebChatEndpoint } from '../web/chatEndpoint';
import type { ServiceProbe } from '../app/discoverService';
import { ServiceClient } from '../desktop/serviceClient';
import { effectiveTurnMode } from '../desktop/turnMode';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const READER = 'leitor-de-teste-falso-1234567890abcdef';
const DIRECT_ID = 'provedor-falso';
const EXTERNAL_ID = 'roteador-falso';
const SECRET = 'chave-falsa-que-nao-pode-vazar';

function jsonResponse(body: unknown): FetchResponseLike {
	return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

function fakeProviders(calls: { url: string; body: string }[]) {
	return (url: string, init?: { body?: string }): FetchResponseLike => {
		calls.push({ url, body: init?.body ?? '' });
		if (url.endsWith('/models')) {
			return jsonResponse({ data: [{ id: 'alfa' }, { id: 'beta' }] });
		}
		return {
			ok: true,
			status: 200,
			text: async () => 'data: [DONE]\n\n',
			body: {
				[Symbol.asyncIterator]: async function* () {
					yield `data: ${JSON.stringify({
						id: 'c',
						object: 'chat.completion.chunk',
						model: 'modelo-do-servidor-falso',
						choices: [{ index: 0, delta: { content: 'resposta' }, finish_reason: null }],
					})}\n\n`;
					yield 'data: [DONE]\n\n';
				},
			},
		};
	};
}

suite('DEV-8.11: roteador compartilhado entre desktop e serviço', () => {
	let root: string;
	let calls: { url: string; body: string }[];
	let close: () => Promise<void>;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-shared-router-'));
		calls = [];
		const core = assembleCore({
			rootPath: root,
			logScope: 'test-shared-router',
			logSink: new ConsoleLogSink({ out: () => undefined, err: () => undefined }),
			fetchImpl: fakeProviders(calls) as unknown as FetchLike,
		});
		await core.chat.saveProvider({
			id: DIRECT_ID,
			name: 'Provedor falso',
			baseUrl: 'http://localhost:29999/v1',
			apiKey: SECRET,
		});
		await core.chat.saveProvider({
			id: EXTERNAL_ID,
			name: 'Roteador falso',
			baseUrl: 'http://localhost:29998/v1',
			apiKey: SECRET,
		});
		const endpoint = new WebChatEndpoint({ session: core.chat });
		const server = await startWebServer({
			version: 'test',
			assetsDir: join(process.cwd(), 'dist', 'web', 'assets'),
			core,
			readerToken: READER,
			port: 0,
		});
		close = async () => {
			await server.close();
			core.chat.dispose();
			await removeFixtureTree(root).catch(() => undefined);
		};
		// O desktop só conhece o serviço pelo registro; o teste o injeta.
		probe = {
			kind: 'active',
			record: {
				version: 1,
				protocol: 3,
				pid: process.pid,
				port: server.port,
				startedAt: new Date().toISOString(),
				appVersion: 'test',
				token: 'painel-de-teste-ignorado-0123456789',
				readerToken: READER,
				chatToken: 'conversa-de-teste-ignorada-0123456789',
				address: '127.0.0.1',
			},
			health: { ok: true, pid: process.pid, protocol: 3 },
		} as unknown as ServiceProbe;
		heldCore = core;
	});

	let probe: ServiceProbe;
	let heldCore: ReturnType<typeof assembleCore>;

	teardown(async () => {
		await close();
	});

	function desktopClient(): ServiceClient {
		return new ServiceClient({ root, probe: async () => probe });
	}

	test('o desktop lê a decisão do serviço pela API existente', async () => {
		await heldCore.chat.saveRouterConfig({
			enabled: true,
			mode: 'external',
			externalRouterProviderId: EXTERNAL_ID,
			updatedAt: new Date().toISOString(),
		});
		const queried = await desktopClient().routing();
		assert.strictEqual(queried.ok, true, queried.ok ? '' : queried.message);
		if (!queried.ok) {
			return;
		}
		assert.strictEqual(queried.value.mode, 'external');
		assert.strictEqual(queried.value.externalRouterProviderId, EXTERNAL_ID);
		assert.strictEqual(queried.value.configured, true);
		assert.strictEqual(JSON.stringify(queried).includes(SECRET), false, 'sem chave na leitura');
	});

	test('alterar a configuração no serviço muda o que o desktop vê', async () => {
		await heldCore.chat.saveRouterConfig({
			enabled: true,
			mode: 'external',
			externalRouterProviderId: EXTERNAL_ID,
			updatedAt: new Date().toISOString(),
		});
		const first = await desktopClient().routing();
		assert.strictEqual(first.ok, true);
		await heldCore.chat.saveRouterConfig({
			enabled: true,
			mode: 'native',
			updatedAt: new Date().toISOString(),
		});
		const second = await desktopClient().routing();
		assert.strictEqual(second.ok, true);
		if (first.ok && second.ok) {
			assert.strictEqual(first.value.mode, 'external', 'antes: externo');
			assert.strictEqual(second.value.mode, 'native', 'depois: nativo — sem reiniciar');
			// O modo efetivo do chat segue a decisão compartilhada.
			const view = {
				mode: second.value.mode,
				enabled: second.value.enabled,
				updatedAt: second.value.updatedAt,
				configured: second.value.configured,
				source: 'service' as const,
			};
			assert.strictEqual(effectiveTurnMode('auto', view), 'auto');
			assert.strictEqual(
				effectiveTurnMode('auto', {
					...view,
					mode: first.value.mode,
					externalRouterProviderId: EXTERNAL_ID,
				}),
				'external',
			);
		}
	});

	test('o serviço executa os três modos com a configuração compartilhada', async () => {
		await heldCore.chat.saveRouterConfig({
			enabled: true,
			mode: 'native',
			updatedAt: new Date().toISOString(),
		});
		const conversation = await heldCore.chat.createConversation({ providerId: DIRECT_ID });
		const endpoint = new WebChatEndpoint({ session: heldCore.chat });

		// Automático: o motor do serviço escolhe.
		const automatic = await endpoint.start({
			conversationId: conversation.summary.id,
			providerId: '',
			model: '',
			text: 'automático',
			routing: 'auto',
		});
		assert.strictEqual(automatic.kind, 'started');
		if (automatic.kind === 'started') {
			for await (const _event of automatic.events) {
				// Consome.
			}
		}
		const automaticCalls = calls.filter((call) => call.url.includes('/chat/completions'));
		assert.strictEqual(automaticCalls.length, 1, 'uma requisição, ao modelo escolhido');
		assert.ok(automaticCalls[0]?.url.includes('29999'), 'foi ao provedor do catálogo');

		// Externo: a configuração compartilhada aponta o destino.
		await heldCore.chat.saveRouterConfig({
			enabled: true,
			mode: 'external',
			externalRouterProviderId: EXTERNAL_ID,
			updatedAt: new Date().toISOString(),
		});
		const second = await heldCore.chat.createConversation({ providerId: DIRECT_ID });
		const external = await endpoint.start({
			conversationId: second.summary.id,
			providerId: DIRECT_ID,
			model: 'alfa',
			text: 'externo',
			routing: 'external',
		});
		assert.strictEqual(external.kind, 'started');
		if (external.kind === 'started') {
			for await (const _event of external.events) {
				// Consome.
			}
		}
		const afterExternal = calls.filter((call) => call.url.includes('/chat/completions'));
		assert.ok(afterExternal.at(-1)?.url.includes('29998'), 'a chamada foi ao roteador configurado');

		// Direto: o par do usuário, mesmo com o roteador externo configurado.
		const third = await heldCore.chat.createConversation({ providerId: DIRECT_ID });
		const direct = await endpoint.start({
			conversationId: third.summary.id,
			providerId: DIRECT_ID,
			model: 'beta',
			text: 'direto',
			routing: 'direct',
		});
		assert.strictEqual(direct.kind, 'started');
		if (direct.kind === 'started') {
			for await (const _event of direct.events) {
				// Consome.
			}
		}
		const last = calls.filter((call) => call.url.includes('/chat/completions')).at(-1);
		assert.ok(last?.url.includes('29999'), 'a chamada foi ao provedor do usuário');
		assert.strictEqual((JSON.parse(last?.body ?? '{}') as { model?: string }).model, 'beta');

		// E a configuração global não foi tocada pelo turno direto.
		const after = await desktopClient().routing();
		assert.strictEqual(after.ok, true);
		if (after.ok) {
			assert.strictEqual(after.value.mode, 'external', 'o modo direto não muda a configuração');
			assert.strictEqual(after.value.externalRouterProviderId, EXTERNAL_ID);
		}
	});

	test('a API de configuração não devolve a chave do provedor', async () => {
		const response = await fetch(`http://127.0.0.1:${probe.kind === 'active' ? probe.record.port : 0}/api/routing`, {
			headers: { 'x-seshyina-reader': READER, accept: 'application/json' },
		});
		assert.strictEqual(response.status, 200);
		const body = await response.text();
		assert.strictEqual(body.includes(SECRET), false, 'nenhuma chave no corpo');
		assert.strictEqual(body.includes(READER), false, 'o token não volta');
	});
});
