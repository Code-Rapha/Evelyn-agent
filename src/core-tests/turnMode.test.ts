/**
 * DEV-8.9: o seletor de modo do chat e a integração com o turno.
 *
 * ## O que se prova
 *
 * 1. O padrão é **automático**, e um valor guardado desconhecido volta ao
 *    padrão em vez de virar um modo que ninguém executa;
 * 2. No modo automático o turno **não** fixa o modelo do seletor: quem escolhe
 *    é o motor nativo, e o evento `started` diz o que ele escolheu;
 * 3. O modo direto usa o par do usuário, sem substituição pelo roteador;
 * 4. O roteador externo usa o destino configurado e **falha claramente**
 *    quando ele não existe;
 * 5. Alternar o modo **não** reescreve `router-config.json`;
 * 6. O modo escolhido persiste (armazenamento da janela) e não vaza para a
 *    configuração global;
 * 7. Recusas de configuração não carregam chave;
 * 8. Um cliente antigo (sem `routing`) continua com o comportamento de antes.
 *
 * ## O que é simulado
 *
 * O servidor HTTP dos provedores (`fetchImpl`): não há rede nem chave real.
 * O `ChatSession`, o catálogo, o roteamento, a persistência e o relatório são
 * os de produção.
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
import { CircuitBreaker } from '../core/providers/routing/breaker';
import type { RoutePolicy } from '../core/providers/routing/types';
import type { ChatStreamEvent, RouterConfigView, TurnRouting } from '../desktop/contract';
import { parseSendMessageInput } from '../desktop/contract';
import {
	autoModeAvailable,
	effectiveTurnMode,
	isTurnMode,
	modelSelectionEnabled,
	readStoredTurnMode,
	turnRoutingPayload,
	writeStoredTurnMode,
	TURN_MODE_STORAGE_KEY,
} from '../desktop/turnMode';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const DIRECT_ID = 'provedor-direto';
const EXTERNAL_ID = 'roteador-externo';
const SECRET = 'chave-que-nao-pode-vazar';

function policy(): RoutePolicy {
	return {
		retries: 0,
		retryBackoffMs: 1,
		maxRetryBackoffMs: 5,
		timeouts: { ttfbMs: 0, idleMs: 0, totalMs: 0 },
		fallbackOn: ['rate_limit', 'timeout'],
		breaker: { failureThreshold: 5, windowMs: 60_000, openMs: 30_000, halfOpenProbes: 1 },
	};
}

function jsonResponse(body: unknown): FetchResponseLike {
	return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

/** Um servidor falso que registra o destino de cada chamada. */
function recordingServer(calls: { url: string; body: string }[], answerModel = 'respondido') {
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
						model: answerModel,
						choices: [{ index: 0, delta: { content: 'olá' }, finish_reason: null }],
					})}\n\n`;
					yield 'data: [DONE]\n\n';
				},
			},
		};
	};
}

/** Um armazenamento de janela em memória, com o mínimo que a página usa. */
function memoryStorage(initial?: string): Storage {
	const items = new Map<string, string>();
	if (initial !== undefined) {
		items.set(TURN_MODE_STORAGE_KEY, initial);
	}
	return {
		get length() {
			return items.size;
		},
		clear: () => items.clear(),
		getItem: (key: string) => items.get(key) ?? null,
		key: (index: number) => [...items.keys()][index] ?? null,
		removeItem: (key: string) => void items.delete(key),
		setItem: (key: string, value: string) => void items.set(key, value),
	} as Storage;
}

function configView(overrides: Partial<RouterConfigView> = {}): RouterConfigView {
	return {
		mode: 'native',
		enabled: true,
		updatedAt: new Date(0).toISOString(),
		configured: true,
		...overrides,
	};
}

suite('DEV-8.9: regras do modo do chat', () => {
	test('o padrão é automático, e um valor desconhecido volta ao padrão', () => {
		assert.strictEqual(readStoredTurnMode(undefined), 'auto');
		assert.strictEqual(readStoredTurnMode(memoryStorage()), 'auto');
		assert.strictEqual(readStoredTurnMode(memoryStorage('inventado')), 'auto');
		assert.strictEqual(readStoredTurnMode(memoryStorage('direct')), 'direct');
		assert.strictEqual(isTurnMode('external'), true);
		assert.strictEqual(isTurnMode('nativo'), false);
	});

	test('o modo persiste no armazenamento da janela, e não na configuração global', () => {
		const storage = memoryStorage();
		writeStoredTurnMode(storage, 'external');
		assert.strictEqual(storage.getItem(TURN_MODE_STORAGE_KEY), 'external');
		assert.strictEqual(readStoredTurnMode(storage), 'external');
	});

	test('armazenamento indisponível não impede o chat', () => {
		const broken = {
			getItem: () => {
				throw new Error('negado');
			},
			setItem: () => {
				throw new Error('negado');
			},
		} as unknown as Storage;
		assert.strictEqual(readStoredTurnMode(broken), 'auto');
		assert.doesNotThrow(() => writeStoredTurnMode(broken, 'direct'));
	});

	test('automático só é obedecível com o roteador ligado no modo nativo', () => {
		assert.strictEqual(autoModeAvailable(configView()), true);
		assert.strictEqual(autoModeAvailable(configView({ enabled: false })), false);
		assert.strictEqual(autoModeAvailable(configView({ mode: 'external' })), false);
		assert.strictEqual(autoModeAvailable(undefined), false);
		assert.strictEqual(effectiveTurnMode('auto', configView()), 'auto');
		assert.strictEqual(
			effectiveTurnMode('auto', configView({ mode: 'external' })),
			'external',
			'a configuração aponta para o roteador externo e vence',
		);
		assert.strictEqual(effectiveTurnMode('auto', configView({ mode: 'direct' })), 'direct');
		assert.strictEqual(effectiveTurnMode('direct', configView()), 'direct', 'a escolha direta vale');
	});

	test('no automático o seletor de modelo fica sem efeito', () => {
		assert.strictEqual(modelSelectionEnabled('auto', configView()), false);
		assert.strictEqual(modelSelectionEnabled('direct', configView()), true);
		assert.strictEqual(modelSelectionEnabled('external', configView()), true);
	});

	test('o envio do automático não finge escolha do usuário', () => {
		assert.deepStrictEqual(turnRoutingPayload('auto', { providerId: DIRECT_ID, model: 'alfa' }), {
			routing: 'auto',
		});
		assert.deepStrictEqual(turnRoutingPayload('direct', { providerId: DIRECT_ID, model: 'alfa' }), {
			routing: 'direct',
			providerId: DIRECT_ID,
			model: 'alfa',
		});
		assert.deepStrictEqual(turnRoutingPayload('external', { providerId: DIRECT_ID, model: 'alfa' }), {
			routing: 'external',
			model: 'alfa',
		});
	});

	test('o contrato aceita o automático sem par e preserva o cliente antigo', () => {
		const automatic = parseSendMessageInput({
			providerId: '',
			conversationId: 'c1',
			model: '',
			messages: [{ role: 'user', content: 'oi' }],
			routing: 'auto',
		});
		assert.strictEqual(automatic.routing, 'auto');
		assert.strictEqual(automatic.providerId, '');
		assert.strictEqual(automatic.model, '');

		// Sem `routing`, o par continua obrigatório: nada muda para quem já existia.
		assert.throws(
			() =>
				parseSendMessageInput({
					providerId: '',
					conversationId: 'c1',
					model: '',
					messages: [],
				}),
			/providerId must be a non-empty string/,
		);
		const legacy = parseSendMessageInput({
			providerId: DIRECT_ID,
			conversationId: 'c1',
			model: 'alfa',
			messages: [],
		});
		assert.strictEqual(legacy.routing, undefined);
	});

	test('um modo desconhecido não atravessa o contrato', () => {
		const parsed = parseSendMessageInput({
			providerId: DIRECT_ID,
			conversationId: 'c1',
			model: 'alfa',
			messages: [],
			routing: 'criativo',
		});
		assert.strictEqual(parsed.routing, undefined);
	});
});

suite('DEV-8.9: o modo no turno real', () => {
	let root: string;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-turnmode-'));
	});

	teardown(async () => {
		await removeFixtureTree(root);
	});

	function session(fetchImpl: FetchLike): ChatSession {
		return new ChatSession({
			config: new ProviderConfigService(new FileStateStore({ filePath: join(root, 'state.json') })),
			secrets: new FileSecretStore({ filePath: join(root, 'secrets.json') }),
			history: new FileDataStore({ rootPath: join(root, 'data') }),
			logger: new LoggingService(new ConsoleLogSink({ out: () => undefined, err: () => undefined })),
			fetchImpl,
			routing: {
				policy: policy(),
				breaker: new CircuitBreaker(() => policy().breaker, () => Date.now()),
				sleep: async () => true,
			},
		});
	}

	async function ready(calls: { url: string; body: string }[]): Promise<ChatSession> {
		const chat = session(recordingServer(calls) as unknown as FetchLike);
		await chat.saveProvider({
			id: DIRECT_ID,
			name: 'Direto',
			baseUrl: 'http://localhost:20202/v1',
			apiKey: SECRET,
		});
		await chat.saveProvider({
			id: EXTERNAL_ID,
			name: 'Roteador',
			baseUrl: 'http://localhost:20128/v1',
			apiKey: SECRET,
		});
		return chat;
	}

	async function send(
		chat: ChatSession,
		input: {
			readonly mode?: TurnRouting;
			readonly providerId?: string;
			readonly model?: string;
			readonly strategy?: 'manual' | 'fallback';
		},
	): Promise<{
		readonly events: ChatStreamEvent[];
		readonly errors: string[];
		readonly started: Extract<ChatStreamEvent, { type: 'started' }> | undefined;
	}> {
		const conversation = await chat.createConversation({ providerId: DIRECT_ID });
		const events: ChatStreamEvent[] = [];
		const ack = await chat.sendMessage(
			{
				conversationId: conversation.summary.id,
				providerId: input.providerId ?? '',
				model: input.model ?? '',
				messages: [{ role: 'user', content: 'olá' }],
				strategy: input.strategy ?? 'manual',
				...(input.mode !== undefined ? { routing: input.mode } : {}),
			},
			(event) => events.push(event),
		);
		await chat.waitForTurn(ack.turnId);
		return {
			events,
			errors: events
				.filter((event): event is Extract<ChatStreamEvent, { type: 'error' }> => event.type === 'error')
				.map((event) => event.message),
			started: events.find(
				(event): event is Extract<ChatStreamEvent, { type: 'started' }> => event.type === 'started',
			),
		};
	}

	const chatCalls = (
		calls: { readonly url: string; readonly body: string }[],
	) => calls.filter((call) => call.url.includes('/chat/completions'));

	test('automático: o motor escolhe, mesmo com a estratégia manual e sem par', async () => {
		const calls: { url: string; body: string }[] = [];
		const chat = await ready(calls);
		// `routing: 'auto'` sem `providerId`/`model`: o contrato aceita, e quem
		// escolhe é a seleção.
		const result = await send(chat, { mode: 'auto', strategy: 'manual' });
		assert.deepStrictEqual(result.errors, [], `erros do turno: ${result.errors.join(' | ')}`);
		const sent = chatCalls(calls);
		assert.strictEqual(
			sent.length,
			1,
			`uma requisição, ao modelo escolhido pelo motor; eventos=${JSON.stringify(result.events.map((e) => e.type))} erros=${result.errors.join(' | ')}`,
		);
		const body = JSON.parse(sent[0]?.body ?? '{}') as { model?: string };
		assert.ok(
			body.model === 'alfa' || body.model === 'beta',
			`o modelo enviado é um dos candidatos do catálogo: ${String(body.model)}`,
		);
		assert.strictEqual(result.started?.routing?.mode, 'auto', 'o modo anunciado é o automático');
	});

	test('direto: usa o par do usuário, e o roteador não o substitui', async () => {
		const calls: { url: string; body: string }[] = [];
		const chat = await ready(calls);
		await chat.saveRouterConfig({
			enabled: true,
			mode: 'external',
			externalRouterProviderId: EXTERNAL_ID,
			updatedAt: new Date().toISOString(),
		});
		// A configuração aponta para o roteador externo; o modo direto a ignora.
		const result = await send(chat, { mode: 'direct', providerId: DIRECT_ID, model: 'beta' });
		assert.deepStrictEqual(result.errors, []);
		const sent = chatCalls(calls);
		assert.strictEqual(sent.length, 1);
		assert.ok(sent[0]?.url.includes('20202'), 'a chamada foi ao provedor do usuário');
		const body = JSON.parse(sent[0]?.body ?? '{}') as { model?: string };
		assert.strictEqual(body.model, 'beta', 'o modelo é o que o usuário escolheu');
		assert.strictEqual(result.started?.routing?.mode, 'direct');
		assert.strictEqual(result.started?.routing?.providerId, DIRECT_ID);
	});

	test('externo: vai ao destino configurado e diz que quem decidiu foi ele', async () => {
		const calls: { url: string; body: string }[] = [];
		const chat = await ready(calls);
		await chat.saveRouterConfig({
			enabled: true,
			mode: 'external',
			externalRouterProviderId: EXTERNAL_ID,
			updatedAt: new Date().toISOString(),
		});
		const result = await send(chat, { mode: 'external', providerId: DIRECT_ID, model: 'alfa' });
		assert.deepStrictEqual(result.errors, []);
		const sent = chatCalls(calls);
		assert.strictEqual(sent.length, 1);
		assert.ok(sent[0]?.url.includes('20128'), 'a chamada foi ao roteador externo');
		const history = await chat.listExecutionHistory();
		assert.strictEqual(history[0]?.report.routing?.decidedBy, 'external-router');
		assert.strictEqual(result.started?.routing?.mode, 'external');
	});

	test('externo sem configuração falha com motivo claro e não envia nada', async () => {
		const calls: { url: string; body: string }[] = [];
		const chat = await ready(calls);
		const result = await send(chat, { mode: 'external', providerId: DIRECT_ID, model: 'alfa' });
		assert.strictEqual(result.errors.length, 1);
		assert.match(result.errors[0] ?? '', /roteador externo não está configurado/);
		assert.strictEqual(chatCalls(calls).length, 0, 'nenhuma requisição saiu');
	});

	test('direto com provedor ausente é recusado, sem cair para outro', async () => {
		const calls: { url: string; body: string }[] = [];
		const chat = await ready(calls);
		const result = await send(chat, { mode: 'direct', providerId: 'sumiu', model: 'alfa' });
		assert.strictEqual(result.errors.length, 1);
		assert.match(result.errors[0] ?? '', /não está configurado/);
		assert.strictEqual(chatCalls(calls).length, 0);
	});

	test('a recusa não carrega a chave do provedor', async () => {
		const calls: { url: string; body: string }[] = [];
		const chat = await ready(calls);
		await chat.saveProvider({
			id: 'desligado',
			name: 'Desligado',
			baseUrl: 'http://localhost:20303/v1',
			apiKey: SECRET,
		});
		await chat.setProviderEnabled('desligado', false);
		const result = await send(chat, { mode: 'direct', providerId: 'desligado', model: 'alfa' });
		const shown = result.errors.join('\n');
		assert.match(shown, /desabilitado/);
		assert.strictEqual(shown.includes(SECRET), false, 'a recusa não expõe a chave');
		assert.strictEqual(JSON.stringify(result.events).includes(SECRET), false, 'nenhum evento expõe a chave');
	});

	test('trocar de modo não reescreve a configuração global do roteador', async () => {
		const calls: { url: string; body: string }[] = [];
		const chat = await ready(calls);
		const saved = await chat.saveRouterConfig({
			enabled: true,
			mode: 'native',
			updatedAt: new Date(0).toISOString(),
		});
		const file = await readFile(join(root, 'data', 'router-config.json'), 'utf8');
		const before = JSON.parse(file) as { mode: string; enabled: boolean; externalRouterProviderId?: string };

		// O seletor da página só muda o estado da janela; o do Core é lido, não
		// escrito. Aqui: usar os três modos em turnos e conferir o arquivo.
		await send(chat, { mode: 'direct', providerId: DIRECT_ID, model: 'alfa' });
		await send(chat, { mode: 'auto', providerId: DIRECT_ID, model: 'alfa' });
		await send(chat, { mode: 'external', providerId: DIRECT_ID, model: 'alfa' });

		const after = JSON.parse(await readFile(join(root, 'data', 'router-config.json'), 'utf8')) as {
			mode: string;
			enabled: boolean;
		};
		assert.deepStrictEqual(
			{ mode: after.mode, enabled: after.enabled },
			{ mode: before.mode, enabled: before.enabled },
		);
		assert.strictEqual(saved.mode, 'native');
	});

	test('automático com o roteador desligado não sai, e o motivo diz como ligar', async () => {
		const calls: { url: string; body: string }[] = [];
		const chat = await ready(calls);
		await chat.saveRouterConfig({
			enabled: false,
			mode: 'native',
			updatedAt: new Date().toISOString(),
		});
		const result = await send(chat, { mode: 'auto' });
		assert.strictEqual(result.errors.length, 1);
		assert.match(result.errors[0] ?? '', /roteador está desligado/);
		assert.strictEqual(chatCalls(calls).length, 0);
	});

	test('um cliente antigo, sem modo, mantém o comportamento de antes', async () => {
		const calls: { url: string; body: string }[] = [];
		const chat = await ready(calls);
		const result = await send(chat, { providerId: DIRECT_ID, model: 'alfa' });
		assert.deepStrictEqual(result.errors, []);
		const sent = chatCalls(calls);
		assert.strictEqual(sent.length, 1);
		const body = JSON.parse(sent[0]?.body ?? '{}') as { model?: string };
		assert.strictEqual(body.model, 'alfa', 'o modelo enviado é o que o cliente pediu');
		assert.strictEqual(result.started?.routing, undefined, 'sem modo, nada é anunciado');
	});
});
