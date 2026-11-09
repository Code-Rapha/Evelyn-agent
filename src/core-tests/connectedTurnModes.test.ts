/**
 * DEV-8.10: os três modos no caminho do serviço (modo conectado).
 *
 * ## O que se prova
 *
 * O modo conectado **não** usa o OpenCode: o `WebChatEndpoint` do serviço roda
 * o turno no **Core dele** (`ChatSession.runExternalTurn`). Estes testes
 * exercitam exatamente essa fronteira, com o servidor HTTP dos provedores
 * substituído por um registrador:
 *
 * 1. `auto` — o motor nativo escolhe, sem par fixo do cliente, e o evento
 *    `started` diz o que foi escolhido;
 * 2. `direct` — o par do cliente é o destino, e nada o substitui;
 * 3. `external` — vai ao roteador configurado; sem ele, a recusa é clara e
 *    nenhuma requisição sai;
 * 4. streaming, histórico e cancelamento pelo endpoint continuam funcionando;
 * 5. um cliente antigo (sem `routing`) mantém o par obrigatório;
 * 6. nenhuma recusa carrega a chave.
 *
 * ## O que é simulado
 *
 * Só o `fetchImpl` dos provedores e (no teste da rota) o transporte HTTP.
 * O `ChatSession`, o `WebChatEndpoint`, a política, o catálogo, o roteamento e
 * a persistência são os de produção. Nada aqui prova um modelo **real**.
 */
import * as assert from 'assert';
import { mkdtemp } from 'node:fs/promises';
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
import { WebChatEndpoint, type ChatWireEvent } from '../web/chatEndpoint';
import type { ChatStreamEvent } from '../desktop/contract';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const DIRECT_ID = 'direto-servico';
const EXTERNAL_ID = 'roteador-servico';
const SECRET = 'chave-do-servico-que-nao-pode-vazar';

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

/** Um provedor falso que registra o destino e responde em SSE. */
function recordingServer(calls: { url: string; body: string }[], text = 'resposta do serviço') {
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
						model: 'modelo-que-respondeu',
						choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
					})}\n\n`;
					yield 'data: [DONE]\n\n';
				},
			},
		};
	};
}

suite('DEV-8.10: modos no serviço (modo conectado)', () => {
	let root: string;
	let calls: { url: string; body: string }[];
	let chat: ChatSession;
	let endpoint: WebChatEndpoint;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-connected-modes-'));
		calls = [];
		chat = new ChatSession({
			config: new ProviderConfigService(new FileStateStore({ filePath: join(root, 'state.json') })),
			secrets: new FileSecretStore({ filePath: join(root, 'secrets.json') }),
			history: new FileDataStore({ rootPath: join(root, 'data') }),
			logger: new LoggingService(new ConsoleLogSink({ out: () => undefined, err: () => undefined })),
			fetchImpl: recordingServer(calls) as unknown as FetchLike,
			routing: {
				policy: policy(),
				breaker: new CircuitBreaker(() => policy().breaker, () => Date.now()),
				sleep: async () => true,
			},
		});
		await chat.saveProvider({
			id: DIRECT_ID,
			name: 'Direto do serviço',
			baseUrl: 'http://localhost:21212/v1',
			apiKey: SECRET,
		});
		await chat.saveProvider({
			id: EXTERNAL_ID,
			name: 'Roteador do serviço',
			baseUrl: 'http://localhost:21128/v1',
			apiKey: SECRET,
		});
		endpoint = new WebChatEndpoint({ session: chat });
	});

	teardown(async () => {
		await removeFixtureTree(root);
	});

	const chatCalls = () => calls.filter((call) => call.url.includes('/chat/completions'));

	async function runEndpoint(input: {
		readonly routing?: 'auto' | 'direct' | 'external';
		readonly providerId?: string;
		readonly model?: string;
		readonly stopAfterStarted?: boolean;
	}): Promise<{
		readonly turnId: string | undefined;
		readonly refused: { readonly status: number; readonly message: string } | undefined;
		readonly events: ChatWireEvent[];
	}> {
		const conversation = await chat.createConversation({ providerId: DIRECT_ID });
		const started = await endpoint.start({
			conversationId: conversation.summary.id,
			providerId: input.providerId ?? '',
			model: input.model ?? '',
			text: 'olá do modo conectado',
			...(input.routing !== undefined ? { routing: input.routing } : {}),
		});
		if (started.kind === 'refused') {
			return { turnId: undefined, refused: { status: started.status, message: started.message }, events: [] };
		}
		const events: ChatWireEvent[] = [];
		for await (const event of started.events) {
			events.push(event);
			if (input.stopAfterStarted === true && events.some((entry) => entry.type === 'delta')) {
				await endpoint.cancel(started.turnId);
			}
		}
		return { turnId: started.turnId, refused: undefined, events };
	}

	const routingOf = (
		events: ChatWireEvent[],
	):
		| { readonly mode?: string; readonly providerId?: string; readonly model?: string }
		| undefined => {
		for (const event of events) {
			if (event.type === 'started' && event.routing !== undefined) {
				return event.routing as { readonly mode?: string; readonly providerId?: string };
			}
		}
		return undefined;
	};

	test('automático: o motor do serviço escolhe, sem par fixo do cliente', async () => {
		const result = await runEndpoint({ routing: 'auto' });
		assert.strictEqual(result.refused, undefined, JSON.stringify(result.refused));
		const sent = chatCalls();
		assert.strictEqual(sent.length, 1, 'uma requisição, ao modelo escolhido pelo motor');
		const body = JSON.parse(sent[0]?.body ?? '{}') as { model?: string };
		assert.ok(body.model === 'alfa' || body.model === 'beta', `modelo do catálogo: ${String(body.model)}`);
		assert.strictEqual(routingOf(result.events)?.mode, 'auto', 'o cliente recebe o modo efetivo');
		assert.ok(
			result.events.some((event) => event.type === 'delta'),
			'o texto chega em streaming',
		);
	});

	test('direto: o par do cliente é o destino, mesmo com o roteador em outro modo', async () => {
		await chat.saveRouterConfig({
			enabled: true,
			mode: 'external',
			externalRouterProviderId: EXTERNAL_ID,
			updatedAt: new Date().toISOString(),
		});
		const result = await runEndpoint({ routing: 'direct', providerId: DIRECT_ID, model: 'beta' });
		assert.strictEqual(result.refused, undefined);
		const sent = chatCalls();
		assert.strictEqual(sent.length, 1);
		assert.ok(sent[0]?.url.includes('21212'), 'a chamada foi ao provedor do cliente');
		const body = JSON.parse(sent[0]?.body ?? '{}') as { model?: string };
		assert.strictEqual(body.model, 'beta');
		assert.strictEqual(routingOf(result.events)?.mode, 'direct');
		assert.strictEqual(routingOf(result.events)?.providerId, DIRECT_ID);
	});

	test('externo: vai ao roteador configurado, e o cliente sabe que quem decidiu foi ele', async () => {
		await chat.saveRouterConfig({
			enabled: true,
			mode: 'external',
			externalRouterProviderId: EXTERNAL_ID,
			updatedAt: new Date().toISOString(),
		});
		const result = await runEndpoint({ routing: 'external', providerId: DIRECT_ID, model: 'alfa' });
		assert.strictEqual(result.refused, undefined);
		const sent = chatCalls();
		assert.strictEqual(sent.length, 1);
		assert.ok(sent[0]?.url.includes('21128'), 'a chamada foi ao roteador externo');
		assert.strictEqual(routingOf(result.events)?.mode, 'external');
		const history = await chat.listExecutionHistory();
		assert.strictEqual(history[0]?.report.routing?.decidedBy, 'external-router');
	});

	test('externo sem configuração: falha clara e nenhuma requisição', async () => {
		const result = await runEndpoint({ routing: 'external', providerId: DIRECT_ID, model: 'alfa' });
		assert.strictEqual(chatCalls().length, 0, 'nada foi enviado a outro destino');
		const errors = result.events
			.filter((event) => event.type === 'error')
			.map((event) => String(event.message ?? ''));
		assert.strictEqual(errors.length, 1);
		assert.match(errors[0] ?? '', /roteador externo não está configurado/);
	});

	test('o histórico do serviço registra a pergunta e a resposta', async () => {
		await runEndpoint({ routing: 'direct', providerId: DIRECT_ID, model: 'alfa' });
		const conversations = await endpoint.listConversations();
		const first = conversations[0];
		assert.ok(first !== undefined);
		const opened = await endpoint.openConversation(first.id);
		assert.ok(opened !== undefined);
		const roles = opened.messages.map((message) => message.role);
		assert.deepStrictEqual(roles, ['user', 'assistant']);
		assert.ok(opened.messages[0]?.content.includes('modo conectado'));
	});

	test('cancelar pelo endpoint encerra o turno sem resposta completa', async () => {
		const conversation = await chat.createConversation({ providerId: DIRECT_ID });
		const started = await endpoint.start({
			conversationId: conversation.summary.id,
			providerId: DIRECT_ID,
			model: 'alfa',
			text: 'cancele',
			routing: 'direct',
		});
		assert.strictEqual(started.kind, 'started');
		if (started.kind !== 'started') {
			return;
		}
		const cancelled = await endpoint.cancel(started.turnId);
		assert.strictEqual(cancelled, true, 'o turno em curso foi cancelado');
		// A reserva é liberada no `finally` do turno, quando o stream fecha.
		for await (const _event of started.events) {
			// Consome até o fim para observar o desfecho.
		}
		assert.strictEqual(endpoint.activeTurnsFor(conversation.summary.id), 0, 'a reserva foi liberada');
	});

	test('um cliente antigo (sem routing) mantém o par obrigatório', async () => {
		const conversation = await chat.createConversation({ providerId: DIRECT_ID });
		const refused = await endpoint.start({
			conversationId: conversation.summary.id,
			providerId: '',
			model: '',
			text: 'sem modo',
		});
		// O endpoint em si não valida o par (a rota HTTP valida); o que se
		// prova aqui é o **serviço**: um turno antigo usa o par enviado.
		if (refused.kind === 'started') {
			for await (const _event of refused.events) {
				// Consome o stream.
			}
		}
		const legacy = await runEndpoint({ providerId: DIRECT_ID, model: 'alfa' });
		assert.strictEqual(legacy.refused, undefined);
		const sent = chatCalls();
		assert.strictEqual(sent.length, 1);
		const body = JSON.parse(sent[0]?.body ?? '{}') as { model?: string };
		assert.strictEqual(body.model, 'alfa', 'o par do cliente antigo é o destino');
		assert.strictEqual(routingOf(legacy.events), undefined, 'sem modo, nada é anunciado');
	});

	test('a recusa não carrega a chave do provedor', async () => {
		await chat.saveProvider({
			id: 'desligado-servico',
			name: 'Desligado',
			baseUrl: 'http://localhost:21313/v1',
			apiKey: SECRET,
		});
		await chat.setProviderEnabled('desligado-servico', false);
		const result = await runEndpoint({ routing: 'direct', providerId: 'desligado-servico', model: 'alfa' });
		const shown = JSON.stringify(result.events);
		assert.match(shown, /desabilitado/);
		assert.strictEqual(shown.includes(SECRET), false, 'nenhum evento expõe a chave');
	});
});

suite('DEV-8.10: contrato do chat local permanece compatível', () => {
	test('o evento started do servidor preserva o routing do motor', () => {
		// Garante que o tipo de evento aceito pelo endpoint carrega o campo:
		// sem isso, o cliente conectado voltaria a mostrar "automático" sem
		// dizer quem respondeu.
		const event: ChatStreamEvent = {
			type: 'started',
			turnId: 't1',
			routing: { mode: 'auto', providerId: 'p', model: 'm' },
		};
		assert.strictEqual(event.type, 'started');
		if (event.type === 'started') {
			assert.strictEqual(event.routing?.mode, 'auto');
		}
	});
});
