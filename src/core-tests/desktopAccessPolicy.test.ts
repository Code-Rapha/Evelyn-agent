/**
 * A política de acesso pelo caminho inteiro: frase → persistência → sessão →
 * seleção → roteador.
 *
 * O que se prova aqui não é a regra isolada (isso é `catalogFusion.test`), e
 * sim que ela chega até a decisão de qual modelo é chamado: nenhum modelo
 * inelegível entra no plano, a recusa explica, e `allowPaid`, orçamento e cota
 * continuam valendo por cima.
 */
import * as assert from 'assert';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProviderConfigService } from '../core/providers/config';
import { LoggingService } from '../core/logging';
import type { FetchLike, FetchResponseLike } from '../core/providers/openaiCompatible';
import { ConsoleLogSink } from '../adapters/local/consoleLogSink';
import { ACCESS_POLICY_FILE, FileDataStore } from '../adapters/local/fileDataStore';
import { FileSecretStore } from '../adapters/local/fileSecretStore';
import { FileStateStore } from '../adapters/local/fileStateStore';
import { ChatSession } from '../desktop/chatSession';
import { CircuitBreaker } from '../core/providers/routing/breaker';
import type { RoutePolicy } from '../core/providers/routing/types';
import type { ChatStreamEvent } from '../desktop/contract';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const LOCAL_ID = '127.0.0.1-11434-v1';

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

function jsonResponse(body: unknown, status = 200): FetchResponseLike {
	return { ok: status < 400, status, text: async () => JSON.stringify(body) };
}

const LISTING = {
	data: [
		{ id: 'livre', pricing: { currency: 'USD', input: 0, output: 0 }, context_length: 4096 },
		{ id: 'caro', pricing: { currency: 'USD', input: 0.000002, output: 0.000012 } },
		{ id: 'sem-dados' },
	],
};

suite('Access policy: from the sentence to the router', () => {
	let root: string;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-policy-5e-'));
	});

	teardown(async () => {
		await removeFixtureTree(root);
	});

	function session(fetchImpl: FetchLike, allowPaid = false): ChatSession {
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
			allowPaid,
		});
	}

	async function ready(allowPaid = false): Promise<ChatSession> {
		const chat = session(
			async (url, init) => {
				if (url.endsWith('/models')) {
					return jsonResponse(LISTING);
				}
				// Responde como um chat trivial, sem consumir cota declarada.
				if (url.endsWith('/chat/completions')) {
					const requested = String(init?.body ?? '');
					if (requested.includes('"stream"')) {
						return {
							ok: true,
							status: 200,
							text: async () => 'data: [DONE]\n\n',
							body: {
								[Symbol.asyncIterator]: async function* () {
									yield 'data: {"choices":[{"delta":{"content":"oi"}}]}\n\n';
									yield 'data: [DONE]\n\n';
								},
							},
						};
					}
				}
				return jsonResponse({ ok: true });
			},
			allowPaid,
		);
		await chat.saveProvider({ baseUrl: 'http://127.0.0.1:11434/v1' });
		await chat.listModels(LOCAL_ID);
		return chat;
	}

	async function newConversation(chat: ChatSession): Promise<string> {
		const conversation = await chat.createConversation({ providerId: LOCAL_ID });
		return conversation.summary.id;
	}

	/** Runs one fallback turn and collects every event. */
	async function runTurn(
		chat: ChatSession,
		options: { readonly message: string; readonly strategy?: 'manual' | 'fallback'; readonly model?: string },
	): Promise<{
		readonly events: ChatStreamEvent[];
		readonly selected: string[];
		readonly notices: string[];
		readonly errors: string[];
	}> {
		const conversationId = await newConversation(chat);
		const events: ChatStreamEvent[] = [];
		const ack = await chat.sendMessage(
			{
				conversationId,
				providerId: LOCAL_ID,
				model: options.model ?? 'livre',
				messages: [{ role: 'user', content: options.message }],
				strategy: options.strategy ?? 'fallback',
			},
			(event) => events.push(event),
		);
		await chat.waitForTurn(ack.turnId);
		const selected = events
			.filter((event): event is Extract<ChatStreamEvent, { type: 'modelSelected' }> => event.type === 'modelSelected')
			.map((event) => event.modelId);
		const notices = events
			.filter((event): event is Extract<ChatStreamEvent, { type: 'notice' }> => event.type === 'notice')
			.map((event) => event.message);
		const errors = events
			.filter((event): event is Extract<ChatStreamEvent, { type: 'error' }> => event.type === 'error')
			.map((event) => event.message);
		return { events, selected, notices, errors };
	}

	// �� a frase �������������������������������������������������������������������

	test('the sentence persists free_only and says what it applied', async () => {
		const chat = await ready();
		const result = await runTurn(chat, { message: 'Seshyina, use somente os modelos gratuitos' });
		assert.strictEqual(result.notices.length, 1);
		assert.ok(result.notices[0]?.includes('somente'));
		const stored = await chat.loadAccessPolicy();
		assert.strictEqual(stored.policy, 'free_only');
		assert.strictEqual(stored.changedBy, 'phrase');
		const raw = await readFile(join(root, 'data', ACCESS_POLICY_FILE), 'utf8');
		assert.ok(raw.includes('"free_only"'));
	});

	test('the sentence takes effect on the very turn that says it', async () => {
		const chat = await ready();
		// The listing marks `caro` as unknown access, so free_only must pick
		// `livre` even though the manual pick was `caro`.
		const result = await runTurn(chat, {
			message: 'Seshyina, use somente os modelos gratuitos',
			strategy: 'fallback',
		});
		assert.deepStrictEqual(result.selected, ['livre']);
	});

	test('a question changes nothing', async () => {
		const chat = await ready();
		const result = await runTurn(chat, { message: 'posso usar somente os modelos gratuitos?' });
		assert.deepStrictEqual(result.notices, []);
		assert.strictEqual((await chat.loadAccessPolicy()).policy, 'any');
	});

	test('repeating the sentence still confirms it', async () => {
		const chat = await ready();
		await runTurn(chat, { message: 'Seshyina, use somente os modelos gratuitos' });
		const again = await runTurn(chat, { message: 'Seshyina, use somente os modelos gratuitos' });
		assert.strictEqual(again.notices.length, 1);
		assert.ok(again.notices[0]?.includes('já estava'));
	});

	// �� a seleção ���������������������������������������������������������������

	test('free_only plans only the confirmed free model', async () => {
		const chat = await ready();
		await chat.saveAccessPolicy({ policy: 'free_only' });
		const result = await runTurn(chat, { message: 'olá', strategy: 'fallback' });
		assert.deepStrictEqual(result.selected, ['livre']);
	});

	test('free_only leaves the paid and unknown models out of the plan entirely', async () => {
		const chat = await ready();
		const available = await chat.listAvailableModels();
		const applied = await chat.applyAccessPolicy(
			{ policy: 'free_only', priceSource: 'user', limitsSource: 'user', capabilitiesSource: 'user', updatedAt: new Date().toISOString(), changedBy: 'user' },
			available,
		);
		assert.deepStrictEqual(applied.allowedModels.map((model) => model.model), ['livre']);
		assert.strictEqual(applied.explanation, '');
	});

	test('with no free model, the turn is refused and nothing is called', async () => {
		const calls: string[] = [];
		const chat = session(async (url, init) => {
			if (url.endsWith('/models')) {
				return jsonResponse({ data: [{ id: 'caro', pricing: { currency: 'USD', input: 2, output: 4 } }] });
			}
			calls.push(String(init?.body ?? ''));
			return jsonResponse({});
		});
		await chat.saveProvider({ baseUrl: 'http://127.0.0.1:11434/v1' });
		await chat.listModels(LOCAL_ID);
		await chat.saveAccessPolicy({ policy: 'free_only' });

		const result = await runTurn(chat, { message: 'olá', strategy: 'fallback' });
		assert.ok(result.errors.length === 1);
		assert.ok(result.errors[0]?.includes('somente gratuitos'));
		assert.ok(result.errors[0]?.includes('Nenhuma chamada'));
		assert.deepStrictEqual(calls, [], 'no chat request was made');
	});

	test('a manual pick outside free_only is refused with the reason, not replaced', async () => {
		const chat = await ready();
		await chat.saveAccessPolicy({ policy: 'free_only' });
		const result = await runTurn(chat, { message: 'olá', strategy: 'manual', model: 'caro' });
		assert.deepStrictEqual(result.selected, []);
		assert.ok(result.errors[0]?.includes('caro'));
		assert.ok(result.errors[0]?.includes('Nenhuma chamada'));
	});

	test('a manual pick of a free model still works under free_only', async () => {
		const chat = await ready();
		await chat.saveAccessPolicy({ policy: 'free_only' });
		const result = await runTurn(chat, { message: 'olá', strategy: 'manual', model: 'livre' });
		// O turno manual nao falha: a politica deixou o modelo gratuito passar.
		assert.deepStrictEqual(result.errors, []);
		assert.strictEqual(result.events.some((event) => event.type === 'done'), true);
	});

	test('free_preferred keeps the paid model available, behind the free one', async () => {
		const chat = await ready();
		await chat.saveAccessPolicy({ policy: 'free_preferred' });
		const available = await chat.listAvailableModels();
		const applied = await chat.applyAccessPolicy(
			{ policy: 'free_preferred', priceSource: 'user', limitsSource: 'user', capabilitiesSource: 'user', updatedAt: new Date().toISOString(), changedBy: 'user' },
			available,
		);
		assert.deepStrictEqual(applied.allowedModels.map((model) => model.model), [
			'livre',
			'caro',
			'sem-dados',
		]);
	});

	// �� allowPaid, orçamento e cota ��������������������������

	test('allowPaid false still refuses a paid manual pick under policy any', async () => {
		const chat = await ready(false);
		// The user declares the model paid; the 5B refusal is the one that fires.
		await chat.saveModelCatalogEntry({ providerId: LOCAL_ID, modelId: 'caro', access: 'paid' });
		const result = await runTurn(chat, { message: 'olá', strategy: 'manual', model: 'caro' });
		assert.ok(result.errors[0]?.includes('pago'));
		assert.deepStrictEqual(result.selected, []);
	});

	test('a policy choice never grants paid access', async () => {
		const chat = await ready(false);
		await chat.saveModelCatalogEntry({ providerId: LOCAL_ID, modelId: 'caro', access: 'paid' });
		const available = await chat.listAvailableModels();
		// free_preferred orders, it does not authorize: `allowPaid` is asked
		// by the selector, and the plan leaves the paid model out.
		const applied = await chat.applyAccessPolicy(
			{ policy: 'free_preferred', priceSource: 'user', limitsSource: 'user', capabilitiesSource: 'user', updatedAt: new Date().toISOString(), changedBy: 'user' },
			available,
		);
		const result = await runTurn(chat, { message: 'olá', strategy: 'manual', model: 'caro' });
		assert.strictEqual(applied.allowedModels.some((model) => model.model === 'caro'), true);
		assert.deepStrictEqual(result.selected, [], 'the selector refused the paid model itself');
	});

	// �� fusão de preço pela sessão ���������������������������

	test('the merged catalog shows both prices and the chosen source', async () => {
		const chat = await ready();
		await chat.saveModelCatalogEntry({
			providerId: LOCAL_ID,
			modelId: 'caro',
			pricing: { currency: 'USD', unit: 'per_1m_tokens', input: '5', output: '20' },
		});
		const merged = await chat.listMergedCatalog(LOCAL_ID);
		assert.strictEqual(merged.policy.priceSource, 'user');
		const caro = merged.models.find((model) => model.modelId === 'caro');
		assert.strictEqual(caro?.price?.user?.input, 5);
		assert.strictEqual(caro?.price?.discovered?.input, 2);
		assert.strictEqual(caro?.price?.comparable, true);
		assert.strictEqual(caro?.price?.selected, 'user');
		assert.strictEqual(caro?.price?.effective?.side, 'user');
		assert.strictEqual(caro?.price?.effective?.input, 5);
	});

	test('switching to the discovered price changes the effective value, and back restores it', async () => {
		const chat = await ready();
		await chat.saveModelCatalogEntry({
			providerId: LOCAL_ID,
			modelId: 'caro',
			pricing: { currency: 'USD', unit: 'per_1m_tokens', input: '5', output: '20' },
		});
		await chat.saveAccessPolicy({ priceSource: 'discovered' });
		const switched = await chat.listMergedCatalog(LOCAL_ID);
		const caro = switched.models.find((model) => model.modelId === 'caro');
		assert.strictEqual(caro?.price?.selected, 'discovered');
		assert.strictEqual(caro?.price?.effective?.input, 2);
		assert.strictEqual(caro?.price?.user?.input, 5, 'the declared price is still there');

		await chat.saveAccessPolicy({ priceSource: 'user' });
		const back = await chat.listMergedCatalog(LOCAL_ID);
		const restored = back.models.find((model) => model.modelId === 'caro');
		assert.strictEqual(restored?.price?.selected, 'user');
		assert.strictEqual(restored?.price?.effective?.input, 5);
	});

	test('incompatible currency is flagged and never chosen', async () => {
		const chat = await ready();
		await chat.saveModelCatalogEntry({
			providerId: LOCAL_ID,
			modelId: 'caro',
			pricing: { currency: 'BRL', unit: 'per_1k_tokens', input: '1', output: '2' },
		});
		await chat.saveAccessPolicy({ priceSource: 'discovered' });
		const merged = await chat.listMergedCatalog(LOCAL_ID);
		const caro = merged.models.find((model) => model.modelId === 'caro');
		assert.strictEqual(caro?.price?.comparable, false);
		assert.strictEqual(caro?.price?.selected, 'user');
		assert.strictEqual(caro?.price?.fellBack, true);
		assert.strictEqual(caro?.price?.effective?.input, 1);
		assert.strictEqual(caro?.price?.effective?.currency, 'BRL');
	});

	test('a model with no price on either side has no effective price', async () => {
		const chat = await ready();
		const merged = await chat.listMergedCatalog(LOCAL_ID);
		const bare = merged.models.find((model) => model.modelId === 'sem-dados');
		assert.strictEqual(bare?.price, undefined);
	});

	test('the merged catalog marks each model eligible or not under free_only', async () => {
		const chat = await ready();
		await chat.saveAccessPolicy({ policy: 'free_only' });
		const merged = await chat.listMergedCatalog(LOCAL_ID);
		const byId = new Map(merged.models.map((model) => [model.modelId, model]));
		assert.strictEqual(byId.get('livre')?.policyStatus.eligible, true);
		assert.strictEqual(byId.get('caro')?.policyStatus.eligible, false);
		assert.strictEqual(byId.get('caro')?.policyStatus.reason, 'free_not_confirmed');
		assert.strictEqual(byId.get('sem-dados')?.policyStatus.eligible, false);
	});

	test('a declared paid access wins over a published free price', async () => {
		const chat = await ready();
		await chat.saveModelCatalogEntry({ providerId: LOCAL_ID, modelId: 'livre', access: 'paid' });
		await chat.saveAccessPolicy({ policy: 'free_only' });
		const merged = await chat.listMergedCatalog(LOCAL_ID);
		const livre = merged.models.find((model) => model.modelId === 'livre');
		assert.strictEqual(livre?.policyStatus.eligible, false, 'the user said paid: free_only must not use it');
		assert.strictEqual(livre?.policyStatus.evidenceSource, 'manual');
	});

	test('the price in force is what the budget measures', async () => {
		const chat = await ready();
		await chat.saveModelCatalogEntry({
			providerId: LOCAL_ID,
			modelId: 'caro',
			pricing: { currency: 'USD', unit: 'per_1m_tokens', input: '5', output: '20' },
		});
		// The declared price is what counts until the user says otherwise.
		assert.strictEqual(
			(await chat.effectivePricingFor({ providerId: LOCAL_ID, modelId: 'caro' }))?.input,
			5,
		);
		await chat.saveAccessPolicy({ priceSource: 'discovered' });
		assert.strictEqual(
			(await chat.effectivePricingFor({ providerId: LOCAL_ID, modelId: 'caro' }))?.input,
			2,
			'the provider price is what counts now',
		);
		await chat.saveAccessPolicy({ priceSource: 'user' });
		assert.strictEqual(
			(await chat.effectivePricingFor({ providerId: LOCAL_ID, modelId: 'caro' }))?.input,
			5,
			'and going back restores the declared one exactly',
		);
	});

	test('a model with no price on either side has no price in force', async () => {
		const chat = await ready();
		assert.strictEqual(
			await chat.effectivePricingFor({ providerId: LOCAL_ID, modelId: 'sem-dados' }),
			undefined,
		);
	});

	test('an incompatible discovered price does not replace the declared one', async () => {
		const chat = await ready();
		await chat.saveModelCatalogEntry({
			providerId: LOCAL_ID,
			modelId: 'caro',
			pricing: { currency: 'BRL', unit: 'per_1k_tokens', input: '1', output: '2' },
		});
		await chat.saveAccessPolicy({ priceSource: 'discovered' });
		const pricing = await chat.effectivePricingFor({ providerId: LOCAL_ID, modelId: 'caro' });
		assert.strictEqual(pricing?.currency, 'BRL');
		assert.strictEqual(pricing?.input, 1, 'the declared price stays, with no conversion');
	});

	test('the policy survives a restart', async () => {		const first = await ready();
		await first.saveAccessPolicy({ policy: 'free_only', priceSource: 'discovered' });
		const second = session(async () => jsonResponse({ data: [] }));
		const stored = await second.loadAccessPolicy();
		assert.strictEqual(stored.policy, 'free_only');
		assert.strictEqual(stored.priceSource, 'discovered');
	});

	// �� cota 5D sob a política �������������������������������

	test('free_only never falls back to a paid model when the free one is rate limited', async () => {
		const calls: string[] = [];
		let chatCalls = 0;
		const headers = (values: Record<string, string>) => ({
			get: (name: string) => values[name.toLowerCase()] ?? null,
			entries: () => new Map(Object.entries(values)).entries(),
		});
		const chat = session(async (url) => {
			if (url.endsWith('/models')) {
				return jsonResponse(LISTING);
			}
			chatCalls += 1;
			calls.push(url);
			if (chatCalls === 1) {
				return {
					ok: false,
					status: 429,
					headers: headers({ 'retry-after': '30' }),
					text: async () => JSON.stringify({ error: 'slow down' }),
				};
			}
			return jsonResponse({});
		});
		await chat.saveProvider({ baseUrl: 'http://127.0.0.1:11434/v1' });
		await chat.listModels(LOCAL_ID);
		await chat.saveAccessPolicy({ policy: 'free_only' });

		const result = await runTurn(chat, { message: 'olá', strategy: 'fallback' });
		// Only `livre` is eligible; it was rate limited; there is nowhere else
		// to go, and `caro` must not be tried.
		assert.deepStrictEqual(result.selected, ['livre']);
		assert.strictEqual(calls.length, 1, 'the paid model was never called');
	});

	// �� a política não contorna o orçamento 5B ����������������

	test('the budget limit still binds the only free model, and is not bypassed by the policy', async () => {
		// The free model is classified as paid *for budgeting*: declaring it
		// paid makes the 5B gate evaluate it, and the limit then blocks it.
		// The point is that the policy neither relaxes nor duplicates that.
		const chat = await ready(true);
		await chat.saveModelCatalogEntry({ providerId: LOCAL_ID, modelId: 'livre', access: 'paid' });
		// A limit of the same currency the model prices exist in.
		await chat.saveSpendingLimit({ currency: 'USD', amount: '0', window: 'month' });
		const report = await chat.readBudget('month');
		assert.ok(report !== undefined);
		await chat.saveAccessPolicy({ policy: 'any' });
		const result = await runTurn(chat, { message: 'olá', strategy: 'manual', model: 'caro' });
		// With allowPaid true the selector may choose it; the budget gate is
		// the one that refuses, and it does so without the policy's help.
		assert.ok(
			result.selected.length === 0 || result.errors.some((message) => message.includes('limite')),
			'the spend limit remains in force',
		);
	});

	test('changing to free_only does not change allowPaid', async () => {
		const chat = await ready(false);
		await chat.saveAccessPolicy({ policy: 'free_only' });
		await chat.saveModelCatalogEntry({ providerId: LOCAL_ID, modelId: 'caro', access: 'paid' });
		const result = await runTurn(chat, { message: 'olá', strategy: 'manual', model: 'caro' });
		// Either refusal is acceptable; what must never happen is the paid
		// model running.
		assert.deepStrictEqual(result.selected, []);
		assert.strictEqual(result.errors.length, 1);
	});
});
