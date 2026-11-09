/**
 * A configuração do roteador no fluxo real das requisições.
 *
 * ## O que se prova
 *
 * 1. **`native`** — o roteamento de sempre: seleção, fallback e métricas;
 * 2. **`external`** — a chamada vai para o provedor marcado como roteador, e
 *    a Seshyina **não** simula a escolha dele: o relatório diz quem decidiu e
 *    o que é desconhecido;
 * 3. **`direct`** — a chamada vai para o provedor direto, sem a seleção de
 *    modelos da Seshyina;
 * 4. **`enabled: false`** — nenhuma requisição nova sai, e a recusa diz
 *    como resolver, sem virar `direct` por baixo;
 * 5. **As políticas continuam valendo** em todos os modos: política de
 *    acesso, `allowPaid`, orçamento e cotas;
 * 6. **Um provedor ausente, desabilitado ou sem endereço** recusa, com o
 *    motivo, e não cai para outro modo.
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
import { resolveRouterPlan, singleTargetPlan } from '../desktop/routerPlan';
import { DEFAULT_ROUTER_CONFIG, type RouterConfig } from '../core/providers/routing/config';
import type { ChatStreamEvent } from '../desktop/contract';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const ROUTER_ID = 'roteador';
const DIRECT_ID = 'direto';

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

/** Um servidor falso que registra o que recebeu. */
function recordingServer(calls: { url: string; body: string }[], model = 'resposta') {
	return (url: string, init?: { body?: string }): FetchResponseLike => {
		calls.push({ url, body: init?.body ?? '' });
		if (url.endsWith('/models')) {
			return jsonResponse({ data: [{ id: 'alfa' }, { id: 'beta' }] });
		}
		return {
			ok: true,
			status: 200,
			headers: {
				get: (name: string) => (name.toLowerCase() === 'x-ratelimit-remaining-requests' ? '5' : null),
				entries: () => new Map([['x-ratelimit-remaining-requests', '5']]).entries(),
			},
			text: async () => 'data: [DONE]\n\n',
			body: {
				[Symbol.asyncIterator]: async function* () {
					yield `data: ${JSON.stringify({
						id: 'c',
						object: 'chat.completion.chunk',
						model,
						choices: [{ index: 0, delta: { content: 'olá' }, finish_reason: null }],
					})}\n\n`;
					yield 'data: [DONE]\n\n';
				},
			},
		};
	};
}

suite('Router mode: the plan', () => {
	const lookup = (providerId: string) =>
		providerId === ROUTER_ID
			? { exists: true as const, enabled: true, baseUrl: 'http://localhost:20128/v1' }
			: { exists: false as const };

	test('the native mode is the native mode', () => {
		const plan = resolveRouterPlan({
			config: DEFAULT_ROUTER_CONFIG,
			requestedModel: 'alfa',
			lookup,
		});
		assert.strictEqual(plan.kind, 'native');
	});

	test('the external mode points at the configured router', () => {
		const config: RouterConfig = {
			...DEFAULT_ROUTER_CONFIG,
			mode: 'external',
			externalRouterProviderId: ROUTER_ID,
		};
		const plan = resolveRouterPlan({ config, requestedModel: 'alfa', lookup });
		assert.strictEqual(plan.kind, 'single');
		if (plan.kind !== 'single') {
			return;
		}
		assert.strictEqual(plan.providerId, ROUTER_ID);
		assert.strictEqual(plan.modelId, 'alfa');
	});

	test('a disabled router refuses every turn, and does not become direct', () => {
		const config: RouterConfig = {
			...DEFAULT_ROUTER_CONFIG,
			enabled: false,
			mode: 'external',
			externalRouterProviderId: ROUTER_ID,
		};
		const plan = resolveRouterPlan({ config, requestedModel: 'alfa', lookup });
		assert.strictEqual(plan.kind, 'refused');
		if (plan.kind !== 'refused') {
			return;
		}
		assert.ok(plan.message.includes('desligado'));
		assert.ok(plan.message.includes('direto'), 'a recusa diz como resolver');
	});

	test('a missing provider refuses, with the reason', () => {
		const config: RouterConfig = {
			...DEFAULT_ROUTER_CONFIG,
			mode: 'external',
			externalRouterProviderId: 'fantasma',
		};
		const plan = resolveRouterPlan({ config, requestedModel: 'alfa', lookup });
		assert.strictEqual(plan.kind, 'refused');
		if (plan.kind !== 'refused') {
			return;
		}
		assert.ok(plan.message.includes('fantasma'));
		assert.ok(plan.message.includes('não está configurado'));
	});

	test('a disabled provider refuses, with the reason', () => {
		const plan = resolveRouterPlan({
			config: {
				...DEFAULT_ROUTER_CONFIG,
				mode: 'external',
				externalRouterProviderId: ROUTER_ID,
			},
			requestedModel: 'alfa',
			lookup: () => ({ exists: true, enabled: false, baseUrl: 'http://x/v1' }),
		});
		assert.strictEqual(plan.kind, 'refused');
		if (plan.kind !== 'refused') {
			return;
		}
		assert.ok(plan.message.includes('desabilitado'));
	});

	test('a provider without an address refuses, with the reason', () => {
		const plan = resolveRouterPlan({
			config: {
				...DEFAULT_ROUTER_CONFIG,
				mode: 'external',
				externalRouterProviderId: ROUTER_ID,
			},
			requestedModel: 'alfa',
			lookup: () => ({ exists: true, enabled: true, baseUrl: '  ' }),
		});
		assert.strictEqual(plan.kind, 'refused');
		if (plan.kind !== 'refused') {
			return;
		}
		assert.ok(plan.message.includes('endereço'));
	});

	test('a single-target plan has no score, because nothing was compared', () => {
		const plan = singleTargetPlan({
			kind: 'single',
			providerId: ROUTER_ID,
			modelId: 'alfa',
			mode: 'external',
		});
		assert.strictEqual(plan.reasons[0]?.score, undefined, 'nada foi pontuado');
		assert.ok(plan.reasons[0]?.reason.includes('roteador externo'));
		assert.strictEqual(plan.candidates.length, 0, 'e não há alternativa');
	});
});

suite('Router mode: through the session', () => {
	let root: string;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-router-6b-'));
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
		await chat.saveProvider({ id: ROUTER_ID, name: 'Roteador', baseUrl: 'http://localhost:20128/v1' });
		await chat.saveProvider({ id: DIRECT_ID, name: 'Direto', baseUrl: 'http://localhost:20202/v1' });
		return chat;
	}

	async function send(
		chat: ChatSession,
		options: { readonly model: string; readonly strategy?: 'manual' | 'fallback' },
	): Promise<{ readonly events: ChatStreamEvent[]; readonly errors: string[] }> {
		const conversation = await chat.createConversation({ providerId: ROUTER_ID });
		const events: ChatStreamEvent[] = [];
		const ack = await chat.sendMessage(
			{
				conversationId: conversation.summary.id,
				providerId: ROUTER_ID,
				model: options.model,
				messages: [{ role: 'user', content: 'olá' }],
				strategy: options.strategy ?? 'manual',
			},
			(event) => events.push(event),
		);
		await chat.waitForTurn(ack.turnId);
		return {
			events,
			errors: events
				.filter((event): event is Extract<ChatStreamEvent, { type: 'error' }> => event.type === 'error')
				.map((event) => event.message),
		};
	}

	test('the native mode keeps the Seshyina routing, with its own selection', async () => {
		const calls: { url: string; body: string }[] = [];
		const chat = await ready(calls);
		const result = await send(chat, { model: 'alfa', strategy: 'fallback' });
		assert.deepStrictEqual(result.errors, []);
		// A chamada foi para o provedor escolhido na interface.
		const chatCalls = calls.filter((call) => call.url.includes('/chat/completions'));
		assert.strictEqual(chatCalls.length, 1);
		assert.ok(chatCalls[0]?.url.includes('20128'));
	});

	test('the external mode calls the router, and the report says who decided', async () => {
		const calls: { url: string; body: string }[] = [];
		const chat = await ready(calls);
		await chat.saveRouterConfig({
			enabled: true,
			mode: 'external',
			externalRouterProviderId: ROUTER_ID,
			updatedAt: new Date().toISOString(),
		});
		const result = await send(chat, { model: 'alfa' });
		assert.deepStrictEqual(result.errors, []);
		const chatCalls = calls.filter((call) => call.url.includes('/chat/completions'));
		assert.strictEqual(chatCalls.length, 1);
		assert.ok(chatCalls[0]?.url.includes('20128'), 'a chamada foi para o roteador');

		const history = await chat.listExecutionHistory();
		const report = history[0]?.report;
		assert.ok(report !== undefined, 'a decisão foi registrada');
		assert.strictEqual(report.routing?.mode, 'external');
		assert.strictEqual(report.routing?.decidedBy, 'external-router');
		assert.strictEqual(report.routing?.providerId, ROUTER_ID);
		assert.strictEqual(report.routing?.requestedModel, 'alfa');
		// A Seshyina não escolheu: o candidato não tem pontuação.
		const evaluation = report.evaluations.find((entry) => entry.modelId === 'alfa');
		assert.strictEqual(evaluation?.score, undefined, 'nada foi pontuado num alvo único');
	});

	test('the external mode records the model the server said answered', async () => {
		const calls: { url: string; body: string }[] = [];
		const chat = session(recordingServer(calls, 'escolhido-pelo-roteador') as unknown as FetchLike);
		await chat.saveProvider({ id: ROUTER_ID, name: 'Roteador', baseUrl: 'http://localhost:20128/v1' });
		await chat.saveRouterConfig({
			enabled: true,
			mode: 'external',
			externalRouterProviderId: ROUTER_ID,
			updatedAt: new Date().toISOString(),
		});
		await send(chat, { model: 'alfa' });
		const history = await chat.listExecutionHistory();
		const report = history[0]?.report;
		assert.strictEqual(report?.routing?.requestedModel, 'alfa', 'o pedido é conhecido');
		assert.strictEqual(
			report?.routing?.respondedModel,
			'escolhido-pelo-roteador',
			'quem respondeu é o que o servidor disse',
		);
	});

	test('the direct mode calls the direct provider, without the selection', async () => {
		const calls: { url: string; body: string }[] = [];
		const chat = await ready(calls);
		await chat.saveRouterConfig({
			enabled: true,
			mode: 'direct',
			directProviderId: DIRECT_ID,
			updatedAt: new Date().toISOString(),
		});
		const result = await send(chat, { model: 'alfa' });
		assert.deepStrictEqual(result.errors, []);
		const chatCalls = calls.filter((call) => call.url.includes('/chat/completions'));
		assert.strictEqual(chatCalls.length, 1);
		assert.ok(chatCalls[0]?.url.includes('20202'), 'a chamada foi para o provedor direto');
		const history = await chat.listExecutionHistory();
		assert.strictEqual(history[0]?.report.routing?.decidedBy, 'provider');
		assert.strictEqual(history[0]?.report.routing?.providerId, DIRECT_ID);
	});

	test('a disabled router sends nothing, and says why', async () => {
		const calls: { url: string; body: string }[] = [];
		const chat = await ready(calls);
		await chat.saveRouterConfig({
			enabled: false,
			mode: 'external',
			externalRouterProviderId: ROUTER_ID,
			updatedAt: new Date().toISOString(),
		});
		const result = await send(chat, { model: 'alfa' });
		assert.strictEqual(result.errors.length, 1);
		assert.ok(result.errors[0]?.includes('desligado'));
		assert.strictEqual(
			calls.filter((call) => call.url.includes('/chat/completions')).length,
			0,
			'nenhuma requisição saiu',
		);
	});

	test('a missing provider refuses the turn, with no fallback to another mode', async () => {
		const calls: { url: string; body: string }[] = [];
		const chat = await ready(calls);
		await chat.saveRouterConfig({
			enabled: true,
			mode: 'external',
			externalRouterProviderId: 'fantasma',
			updatedAt: new Date().toISOString(),
		});
		const result = await send(chat, { model: 'alfa' });
		assert.strictEqual(result.errors.length, 1);
		assert.ok(result.errors[0]?.includes('fantasma'));
		assert.strictEqual(
			calls.filter((call) => call.url.includes('/chat/completions')).length,
			0,
			'nenhuma requisição saiu — e nenhuma went to another provider',
		);
	});

	test('the access policy still refuses a paid model in the external mode', async () => {
		const calls: { url: string; body: string }[] = [];
		const chat = await ready(calls);
		await chat.saveModelCatalogEntry({
			providerId: ROUTER_ID,
			modelId: 'alfa',
			access: 'paid',
		});
		await chat.saveRouterConfig({
			enabled: true,
			mode: 'external',
			externalRouterProviderId: ROUTER_ID,
			updatedAt: new Date().toISOString(),
		});
		const result = await send(chat, { model: 'alfa' });
		assert.strictEqual(result.errors.length, 1);
		assert.ok(result.errors[0]?.includes('pago'));
		assert.strictEqual(
			calls.filter((call) => call.url.includes('/chat/completions')).length,
			0,
			'o modelo pago não foi chamado',
		);
	});

	test('free_only still refuses a model without confirmed free access', async () => {
		const calls: { url: string; body: string }[] = [];
		const chat = await ready(calls);
		await chat.saveAccessPolicy({ policy: 'free_only' });
		await chat.saveRouterConfig({
			enabled: true,
			mode: 'external',
			externalRouterProviderId: ROUTER_ID,
			updatedAt: new Date().toISOString(),
		});
		const result = await send(chat, { model: 'alfa' });
		assert.strictEqual(result.errors.length, 1);
		assert.ok(result.errors[0]?.includes('gratuit'));
		assert.strictEqual(
			calls.filter((call) => call.url.includes('/chat/completions')).length,
			0,
		);
	});

	test('the budget gate still runs in the external mode', async () => {
		const calls: { url: string; body: string }[] = [];
		const chat = await ready(calls);
		await chat.saveModelCatalogEntry({
			providerId: ROUTER_ID,
			modelId: 'alfa',
			access: 'paid',
			pricing: { currency: 'USD', unit: 'per_1m_tokens', input: '3', output: '15' },
		});
		// Um limite de zero: nada pode ser gasto.
		await chat.saveSpendingLimit({ currency: 'USD', amount: '0', window: 'month' });
		await chat.saveRouterConfig({
			enabled: true,
			mode: 'external',
			externalRouterProviderId: ROUTER_ID,
			updatedAt: new Date().toISOString(),
		});
		const result = await send(chat, { model: 'alfa' });
		assert.strictEqual(result.errors.length, 1);
		assert.strictEqual(
			calls.filter((call) => call.url.includes('/chat/completions')).length,
			0,
			'o limite de orçamento impediu a chamada',
		);
	});
});
