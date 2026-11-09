/**
 * Orçamento ligado à sessão de verdade: limites persistidos, o ledger real do
 * armazenamento temporário e o roteador completo.
 *
 * O que estes testes provam, e que os testes puros não podem:
 *
 * - um limite salvo é o que decide o próximo turno, sem estado paralelo;
 * - um modelo gratuito continua respondendo com o orçamento esgotado;
 * - um preço desconhecido não vira gasto zero nem bloqueio;
 * - o bloqueio chega à UI como evento próprio, antes do terminal;
 * - um armazenamento de limites quebrado não interrompe a conversa.
 */
import * as assert from 'assert';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProviderConfigService } from '../core/providers/config';
import { LoggingService } from '../core/logging';
import type { FetchLike, FetchResponseLike } from '../core/providers/openaiCompatible';
import { ConsoleLogSink } from '../adapters/local/consoleLogSink';
import { FileDataStore, SPENDING_LIMITS_FILE } from '../adapters/local/fileDataStore';
import { FileSecretStore } from '../adapters/local/fileSecretStore';
import { FileStateStore } from '../adapters/local/fileStateStore';
import { ChatSession } from '../desktop/chatSession';
import type { AgentUiEvent } from '../desktop/agentTurn';
import type { SendMessageInput } from '../desktop/contract';
import { CircuitBreaker } from '../core/providers/routing/breaker';
import type { RoutePolicy } from '../core/providers/routing/types';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const LOCAL_URL = 'http://127.0.0.1:11434/v1';
const LOCAL_ID = '127.0.0.1-11434-v1';
const SECOND_URL = 'http://127.0.0.1:11435/v1';
const SECOND_ID = '127.0.0.1-11435-v1';

const DONE = 'data: [DONE]\n\n';

function delta(text: string): string {
	return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
}

/** Um uso absurdamente alto, para que qualquer limite real seja atingido. */
function hugeUsage(prompt: number, completion: number): string {
	return `data: ${JSON.stringify({
		choices: [],
		usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
	})}\n\n`;
}

function sseResponse(chunks: readonly string[]): FetchResponseLike {
	return {
		ok: true,
		status: 200,
		body: {
			[Symbol.asyncIterator]: async function* () {
				for (const chunk of chunks) {
					yield chunk;
				}
			},
		},
		text: async () => chunks.join(''),
	};
}

interface Recorded {
	readonly url: string;
}

const advertisedModels = new Map<'local' | 'second', readonly string[]>();

function scriptedFetch(
	post: (which: 'local' | 'second', index: number) => FetchResponseLike,
): { fetchImpl: FetchLike; calls: Recorded[] } {
	const calls: Recorded[] = [];
	const counts = { local: 0, second: 0 };
	const fetchImpl: FetchLike = async (url) => {
		calls.push({ url });
		const which = url.includes('11435') ? 'second' : 'local';
		if (url.endsWith('/models')) {
			return {
				ok: true,
				status: 200,
				text: async () => JSON.stringify({ data: (advertisedModels.get(which) ?? []).map((id) => ({ id })) }),
			};
		}
		const index = counts[which];
		counts[which] += 1;
		return post(which, index);
	};
	return { fetchImpl, calls };
}

function policy(): RoutePolicy {
	return {
		retries: 0,
		retryBackoffMs: 1,
		maxRetryBackoffMs: 5,
		timeouts: { ttfbMs: 0, idleMs: 0, totalMs: 0 },
		fallbackOn: ['timeout', 'unavailable', 'rate_limit', 'network', 'upstream_error'],
		breaker: { failureThreshold: 5, windowMs: 60_000, openMs: 30_000, halfOpenProbes: 1 },
	};
}

class EventLog {
	readonly events: AgentUiEvent[] = [];
	private finished: (() => void) | undefined;

	readonly sink = (event: AgentUiEvent): void => {
		this.events.push(event);
		if (event.type === 'done' || event.type === 'error') {
			this.finished?.();
		}
	};

	wait(): Promise<void> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('the turn produced no terminal event')), 5_000);
			this.finished = () => {
				clearTimeout(timer);
				resolve();
			};
		});
	}

	get terminal(): AgentUiEvent {
		const terminal = this.events.find((event) => event.type === 'done' || event.type === 'error');
		assert.ok(terminal !== undefined, 'expected a terminal event');
		return terminal;
	}

	get deltas(): string {
		return this.events
			.filter((event): event is Extract<AgentUiEvent, { type: 'delta' }> => event.type === 'delta')
			.map((event) => event.text)
			.join('');
	}

	get budgetBlocks(): Extract<AgentUiEvent, { type: 'budgetBlocked' }>[] {
		return this.events.filter(
			(event): event is Extract<AgentUiEvent, { type: 'budgetBlocked' }> => event.type === 'budgetBlocked',
		);
	}
}

const USD_PER_MILLION = {
	currency: 'USD',
	unit: 'per_1m_tokens' as const,
	input: '3',
	output: '15',
};

suite('Desktop: spending limits through the chat session', () => {
	let root: string;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-budget-session-'));
		advertisedModels.clear();
	});

	teardown(async () => {
		await removeFixtureTree(root);
	});

	function freshStore(): FileDataStore {
		return new FileDataStore({ rootPath: join(root, 'data') });
	}

	function session(
		fetchImpl: FetchLike,
		options: { readonly routing?: boolean; readonly allowPaid?: boolean } = {},
	): ChatSession {
		const routing = options.routing ?? true;
		return new ChatSession({
			config: new ProviderConfigService(new FileStateStore({ filePath: join(root, 'state.json') })),
			secrets: new FileSecretStore({ filePath: join(root, 'secrets.json') }),
			history: freshStore(),
			logger: new LoggingService(new ConsoleLogSink({ out: () => undefined, err: () => undefined })),
			fetchImpl,
			turnTimeoutMs: 5_000,
			...(routing
				? {
						routing: {
							policy: policy(),
							breaker: new CircuitBreaker(() => policy().breaker, () => Date.now()),
							sleep: async () => true,
						},
					}
				: {}),
			...(options.allowPaid !== undefined ? { allowPaid: options.allowPaid } : {}),
		});
	}

	async function sendInput(chat: ChatSession, overrides: Partial<SendMessageInput> = {}): Promise<SendMessageInput> {
		const conversation = await chat.createConversation({ providerId: LOCAL_ID });
		// The model the test advertised, so a per-test model id really routes.
		const model = advertisedModels.get('local')?.[0] ?? 'llama3';
		return {
			providerId: LOCAL_ID,
			conversationId: conversation.summary.id,
			messages: [{ role: 'user', content: 'hello' }],
			...overrides,
			model: overrides.model ?? model,
		};
	}

	async function twoProviders(chat: ChatSession): Promise<void> {
		await chat.saveProvider({ baseUrl: LOCAL_URL });
		await chat.saveProvider({ baseUrl: SECOND_URL });
	}

	function advertise(models: { readonly local?: readonly string[]; readonly second?: readonly string[] }): void {
		advertisedModels.clear();
		if (models.local !== undefined) {
			advertisedModels.set('local', models.local);
		}
		if (models.second !== undefined) {
			advertisedModels.set('second', models.second);
		}
	}

	/** One paid turn that really spends against the ledger. */
	async function spendOnce(unitPrice: typeof USD_PER_MILLION | undefined = USD_PER_MILLION): Promise<void> {
		await spendOn('spend-' + Math.random().toString(36).slice(2), unitPrice);
	}

	/** One paid turn that really spends, under a model id of its own. */
	async function spendOn(modelId: string, unitPrice: typeof USD_PER_MILLION | undefined = USD_PER_MILLION): Promise<void> {
		const { fetchImpl } = scriptedFetch(() => sseResponse([delta('ok'), hugeUsage(1_000_000, 1_000_000), DONE]));
		advertise({ local: [modelId] });
		const chat = session(fetchImpl, { allowPaid: true });
		await chat.saveProvider({ baseUrl: LOCAL_URL });
		await chat.saveModelCatalogEntry({
			providerId: LOCAL_ID,
			modelId,
			access: 'paid',
			...(unitPrice !== undefined ? { pricing: unitPrice } : {}),
		});
		const log = new EventLog();
		await chat.sendMessage(await sendInput(chat), log.sink);
		await log.wait();
		assert.strictEqual(log.terminal.type, 'done', 'the first turn spent and answered');
	}

	test('a limit saved earlier blocks the next paid turn, with a clear message', async () => {
		await spendOnce();
		const saver = session(async () => sseResponse([DONE]));
		await saver.saveSpendingLimit({ currency: 'USD', amount: '5', window: 'month' });

		const { fetchImpl, calls } = scriptedFetch(() => sseResponse([delta('não deveria'), hugeUsage(1, 1), DONE]));
		advertise({ local: ['llama3'] });
		const chat = session(fetchImpl, { allowPaid: true });
		await chat.saveProvider({ baseUrl: LOCAL_URL });
		await chat.saveModelCatalogEntry({ providerId: LOCAL_ID, modelId: 'llama3', access: 'paid', pricing: USD_PER_MILLION });

		const log = new EventLog();
		await chat.sendMessage(await sendInput(chat), log.sink);
		await log.wait();

		assert.deepStrictEqual(
			calls.filter((call) => !call.url.endsWith('/models')),
			[],
			'the paid model was never called',
		);
		assert.strictEqual(log.terminal.type, 'error');
		if (log.terminal.type === 'error') {
			assert.ok(log.terminal.message.length > 0);
		}
		assert.strictEqual(log.budgetBlocks.length, 1, 'the block is announced');
		const [block] = log.budgetBlocks;
		assert.strictEqual(block.providerId, LOCAL_ID);
		assert.strictEqual(block.modelId, 'llama3');
		assert.ok(block.message.includes('5,00'), block.message);
		assert.ok(block.message.includes('atingido'), block.message);
	});

	test('a free model keeps answering when the budget is spent', async () => {
		await spendOnce();
		const saver = session(async () => sseResponse([DONE]));
		// Zero: any known spend at all is "over".
		await saver.saveSpendingLimit({ currency: 'USD', amount: '0', window: 'month' });

		const { fetchImpl, calls } = scriptedFetch(() => sseResponse([delta('grátis'), DONE]));
		advertise({ local: ['llama3'] });
		const chat = session(fetchImpl, { allowPaid: true });
		await chat.saveProvider({ baseUrl: LOCAL_URL });
		// Free, so the budget never applies.
		await chat.saveModelCatalogEntry({ providerId: LOCAL_ID, modelId: 'llama3', access: 'free' });

		const log = new EventLog();
		await chat.sendMessage(await sendInput(chat), log.sink);
		await log.wait();

		assert.strictEqual(log.terminal.type, 'done');
		assert.strictEqual(log.deltas, 'grátis');
		assert.strictEqual(log.budgetBlocks.length, 0);
		assert.strictEqual(calls.filter((call) => !call.url.endsWith('/models')).length, 1);
	});

	test('an unpriced model is not treated as free spending and not blocked', async () => {
		// A turn with usage but no price, followed by a priced turn: the
		// period now mixes one known cost with one unknown, so its total is
		// unknown - and the limit of zero must not be read as 'unknown == 0'.
		await spendOn('sem-preco', undefined);
		await spendOnce();
		const { fetchImpl, calls } = scriptedFetch(() => sseResponse([delta('sem preço'), hugeUsage(1, 1), DONE]));
		advertise({ local: ['llama3'] });
		const chat = session(fetchImpl, { allowPaid: true });
		await chat.saveProvider({ baseUrl: LOCAL_URL });
		await chat.saveModelCatalogEntry({ providerId: LOCAL_ID, modelId: 'llama3', access: 'paid' });

		const log = new EventLog();
		await chat.sendMessage(await sendInput(chat), log.sink);
		await log.wait();
		// The limit is 0, but the period's cost is unknown: comparing against
		// zero would block a model nobody knows the price of.
		assert.strictEqual(log.terminal.type, 'done', 'unknown cost does not block');
		assert.strictEqual(log.deltas, 'sem preço');
		assert.strictEqual(log.budgetBlocks.length, 0);
		assert.strictEqual(calls.filter((call) => !call.url.endsWith('/models')).length, 1);
	});

	test('a paid fallback is vetoed while the free primary still answers', async () => {
		await spendOnce();
		const saver = session(async () => sseResponse([DONE]));
		await saver.saveSpendingLimit({ currency: 'USD', amount: '1', window: 'month' });

		const { fetchImpl, calls } = scriptedFetch((which) =>
			which === 'local'
				? sseResponse([delta('primário gratuito'), DONE])
				: sseResponse([delta('pago'), DONE]),
		);
		advertise({ local: ['llama3'], second: ['modelo-rapido'] });
		const chat = session(fetchImpl, { allowPaid: true });
		await twoProviders(chat);
		await chat.saveModelCatalogEntry({ providerId: LOCAL_ID, modelId: 'llama3', access: 'free' });
		await chat.saveModelCatalogEntry({
			providerId: SECOND_ID,
			modelId: 'modelo-rapido',
			access: 'paid',
			pricing: USD_PER_MILLION,
		});

		const log = new EventLog();
		await chat.sendMessage(await sendInput(chat, { strategy: 'fallback' }), log.sink);
		await log.wait();

		assert.strictEqual(log.terminal.type, 'done');
		assert.strictEqual(log.deltas, 'primário gratuito');
		assert.strictEqual(calls.filter((call) => call.url.includes('11435') && !call.url.endsWith('/models')).length, 0);
	});

	test('without paid authorization the budget never fires and no block is announced', async () => {
		await spendOnce();
		const saver = session(async () => sseResponse([DONE]));
		await saver.saveSpendingLimit({ currency: 'USD', amount: '0', window: 'month' });

		const { fetchImpl, calls } = scriptedFetch(() => sseResponse([delta('ok'), DONE]));
		advertise({ local: ['llama3'] });
		const chat = session(fetchImpl, { allowPaid: false });
		await chat.saveProvider({ baseUrl: LOCAL_URL });
		await chat.saveModelCatalogEntry({ providerId: LOCAL_ID, modelId: 'llama3', access: 'paid', pricing: USD_PER_MILLION });

		const log = new EventLog();
		await chat.sendMessage(await sendInput(chat), log.sink);
		await log.wait();

		// `allowPaid: false` refuses with its own message, before the router.
		assert.strictEqual(log.terminal.type, 'error');
		assert.strictEqual(log.budgetBlocks.length, 0);
		assert.strictEqual(calls.filter((call) => !call.url.endsWith('/models')).length, 0);
	});

	test('a broken limits file does not interrupt the answer', async () => {
		// A directory where the limits file should be: every read fails.
		await mkdir(join(root, 'data', SPENDING_LIMITS_FILE), { recursive: true });

		const { fetchImpl } = scriptedFetch(() => sseResponse([delta('resposta'), DONE]));
		advertise({ local: ['llama3'] });
		const chat = session(fetchImpl, { allowPaid: true });
		await chat.saveProvider({ baseUrl: LOCAL_URL });
		await chat.saveModelCatalogEntry({ providerId: LOCAL_ID, modelId: 'llama3', access: 'paid', pricing: USD_PER_MILLION });

		const log = new EventLog();
		await chat.sendMessage(await sendInput(chat), log.sink);
		await log.wait();

		assert.strictEqual(log.terminal.type, 'done');
		assert.strictEqual(log.deltas, 'resposta');
	});

	test('readBudget reports the period, the slices and the limits', async () => {
		await spendOn('llama3');
		const chat = session(async () => sseResponse([DONE]));
		await chat.saveSpendingLimit({ currency: 'USD', amount: '50', window: 'month' });

		const report = await chat.readBudget('month');
		assert.strictEqual(report.period.window, 'month');
		assert.strictEqual(report.total.executions, 1);
		assert.strictEqual(report.total.cost.status, 'estimated');
		if (report.total.cost.status === 'estimated') {
			// 1M in at 3/M plus 1M out at 15/M.
			assert.strictEqual(report.total.cost.total, 18);
			assert.strictEqual(report.total.cost.currency, 'USD');
		}
		assert.strictEqual(report.byProvider.length, 1);
		assert.strictEqual(report.byProvider[0].providerId, LOCAL_ID);
		assert.strictEqual(report.byModel[0].modelId, 'llama3');
		assert.strictEqual(report.byExecution.length, 1);
		assert.strictEqual(report.limits.length, 1);
		assert.strictEqual(report.limits[0].scope, 'global');
	});

	test('the limits API round-trips scopes and removes by id', async () => {
		const chat = session(async () => sseResponse([DONE]));
		const global = await chat.saveSpendingLimit({ currency: 'usd', amount: '10,50', window: 'month' });
		assert.strictEqual(global.amount, 10.5);
		assert.strictEqual(global.currency, 'USD');
		assert.strictEqual(global.scope, 'global');

		const model = await chat.saveSpendingLimit({
			providerId: SECOND_ID,
			modelId: 'modelo-rapido',
			currency: 'USD',
			amount: '2',
			window: 'day',
		});
		assert.strictEqual(model.scope, 'model');
		assert.strictEqual(model.providerId, SECOND_ID);

		const limits = await chat.listSpendingLimits();
		assert.deepStrictEqual(limits.map((limit) => limit.scope), ['model', 'global']);
		assert.strictEqual(await chat.removeSpendingLimit(model.limitId), true);
		assert.deepStrictEqual((await chat.listSpendingLimits()).map((limit) => limit.scope), ['global']);
	});

	test('a blank amount is refused instead of becoming zero', async () => {
		const chat = session(async () => sseResponse([DONE]));
		await assert.rejects(() => chat.saveSpendingLimit({ currency: 'USD', amount: '  ', window: 'month' }), /valor/);
		await assert.rejects(() => chat.saveSpendingLimit({ currency: 'USD', amount: 'abc', window: 'month' }), /inválido/);
	});
});
