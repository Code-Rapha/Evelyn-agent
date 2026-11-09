/**
 * Previsão, avisos e visibilidade por conversa/turno pela sessão real.
 *
 * O `ChatSession` é o de verdade, com `fetch` roteirizado e armazenamento em
 * diretório temporário: o que se verifica é a ligação — catálogo, ledger e
 * orçamento lidos do mesmo lugar que o turno escreveu — e não uma segunda
 * implementação da regra.
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
import type { AgentUiEvent } from '../desktop/agentTurn';
import type { SendMessageInput } from '../desktop/contract';
import { CircuitBreaker } from '../core/providers/routing/breaker';
import type { RoutePolicy } from '../core/providers/routing/types';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const LOCAL_ID = '127.0.0.1-11434-v1';
const LOCAL_URL = 'http://127.0.0.1:11434/v1';
const SECOND_URL = 'http://127.0.0.1:11435/v1';

const DONE = 'data: [DONE]\n\n';
const USD = { currency: 'USD', unit: 'per_1m_tokens' as const, input: '3', output: '15' };

function delta(text: string): string {
	return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
}

function usageChunk(prompt: number, completion: number): string {
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

const advertised = new Map<'local' | 'second', readonly string[]>();

function scriptedFetch(
	post: (which: 'local' | 'second', index: number) => FetchResponseLike,
): { fetchImpl: FetchLike; requests: number } {
	let requests = 0;
	const counts = { local: 0, second: 0 };
	const fetchImpl: FetchLike = async (url) => {
		const which = url.includes('11435') ? 'second' : 'local';
		if (url.endsWith('/models')) {
			return {
				ok: true,
				status: 200,
				text: async () => JSON.stringify({ data: (advertised.get(which) ?? []).map((id) => ({ id })) }),
			};
		}
		requests += 1;
		const index = counts[which];
		counts[which] += 1;
		return post(which, index);
	};
	return {
		fetchImpl,
		get requests() {
			return requests;
		},
	};
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
}

suite('Desktop: forecast, alerts and per-chat visibility', () => {
	let root: string;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-forecast-session-'));
		advertised.clear();
	});

	teardown(async () => {
		await removeFixtureTree(root);
	});

	function store(): FileDataStore {
		return new FileDataStore({ rootPath: join(root, 'data') });
	}

	function session(fetchImpl: FetchLike, allowPaid = false): ChatSession {
		return new ChatSession({
			config: new ProviderConfigService(new FileStateStore({ filePath: join(root, 'state.json') })),
			secrets: new FileSecretStore({ filePath: join(root, 'secrets.json') }),
			history: store(),
			logger: new LoggingService(new ConsoleLogSink({ out: () => undefined, err: () => undefined })),
			fetchImpl,
			turnTimeoutMs: 5_000,
			routing: {
				policy: policy(),
				breaker: new CircuitBreaker(() => policy().breaker, () => Date.now()),
				sleep: async () => true,
			},
			allowPaid,
		});
	}

	async function send(
		chat: ChatSession,
		model: string,
		overrides: Partial<SendMessageInput> = {},
	): Promise<EventLog> {
		const conversation = await chat.createConversation({ providerId: LOCAL_ID });
		const log = new EventLog();
		const ack = await chat.sendMessage(
			{
				providerId: LOCAL_ID,
				conversationId: conversation.summary.id,
				model,
				messages: [{ role: 'user', content: 'hello there' }],
				...overrides,
			},
			log.sink,
		);
		await log.wait();
		// O turno é aceito antes de terminar; a contabilização fecha depois do
		// evento terminal, e é o que quem lê o ledger precisa esperar.
		await chat.waitForTurn(ack.turnId);
		return log;
	}

	async function paidSession(options: {
		readonly output: number;
		/** `undefined` means "no price in the catalog"; the default is the USD price. */
		readonly price?: typeof USD | undefined;
		readonly priced?: boolean;
	}): Promise<ChatSession> {
		advertised.set('local', ['llama3']);
		const { fetchImpl } = scriptedFetch(() =>
			sseResponse([delta('resposta'), usageChunk(1_000, options.output), DONE]),
		);
		const chat = session(fetchImpl, true);
		await chat.saveProvider({ baseUrl: LOCAL_URL });
		const priced = options.priced ?? true;
		await chat.saveModelCatalogEntry({
			providerId: LOCAL_ID,
			modelId: 'llama3',
			access: 'paid',
			...(priced ? { pricing: options.price ?? USD } : {}),
		});
		return chat;
	}

	test('a forecast is unknown before anything was measured', async () => {
		const chat = await paidSession({ output: 500 });
		const forecast = await chat.forecastCall({
			providerId: LOCAL_ID,
			modelId: 'llama3',
			promptText: 'hello there',
		});
		assert.strictEqual(forecast.cost.status, 'unknown');
		assert.strictEqual(forecast.outputTokens, undefined);
		if (forecast.cost.status === 'unknown') {
			assert.ok(forecast.cost.reasons.length > 0);
		}
	});

	test('after a measured turn the forecast is estimated, not the recorded cost', async () => {
		const chat = await paidSession({ output: 500 });
		const log = await send(chat, 'llama3');
		assert.strictEqual(log.terminal.type, 'done');

		const forecast = await chat.forecastCall({
			providerId: LOCAL_ID,
			modelId: 'llama3',
			// 40 characters: 10 input tokens.
			promptText: 'x'.repeat(40),
		});
		assert.strictEqual(forecast.cost.status, 'estimated');
		if (forecast.cost.status === 'estimated') {
			// 10 input at 3/M plus 500 output at 15/M — the measured output.
			assert.strictEqual(forecast.cost.total, 0.00753);
			assert.strictEqual(forecast.cost.currency, 'USD');
		}
		assert.strictEqual(forecast.outputTokens, 500);
		assert.strictEqual(forecast.outputBasis, 'model');
		assert.strictEqual(forecast.confidence, 'low', 'one reading is not high confidence');
	});

	test('the forecast is unknown when the model has no price, even with usage', async () => {
		const chat = await paidSession({ output: 500, priced: false });
		await send(chat, 'llama3');
		const forecast = await chat.forecastCall({ providerId: LOCAL_ID, modelId: 'llama3', promptText: 'hi' });
		assert.strictEqual(forecast.cost.status, 'unknown');
	});

	test('the conversation total and its turns come from the ledger', async () => {
		const chat = await paidSession({ output: 500 });
		const conversation = await chat.createConversation({ providerId: LOCAL_ID });
		const send = (content: string) =>
			chat.sendMessage(
				{
					providerId: LOCAL_ID,
					conversationId: conversation.summary.id,
					model: 'llama3',
					messages: [{ role: 'user', content }],
				},
				new EventLog().sink,
			);
		const first = await send('one');
		await chat.waitForTurn(first.turnId);
		const second = await send('two');
		await chat.waitForTurn(second.turnId);
		const report = await chat.readBudget('month');
		const usage = report.byConversation.find((entry) => entry.conversationId === conversation.summary.id);
		assert.ok(usage !== undefined, 'the conversation is listed');
		assert.strictEqual(usage.turns.length, 2);
		assert.strictEqual(usage.executions, 2);
		assert.deepStrictEqual(usage.tokens, { input: 2_000, output: 1_000 });
		assert.strictEqual(usage.cost.status, 'estimated');
		if (usage.cost.status === 'estimated') {
			assert.strictEqual(usage.cost.total, round(2_000 * 3e-6 + 1_000 * 15e-6));
		}
		// Several messages in one conversation do not become several executions.
		assert.strictEqual(report.byExecution.length, 2);
	});

	test('turns are recorded under the conversation that sent them', async () => {
		const chat = await paidSession({ output: 100 });
		const a = await chat.createConversation({ providerId: LOCAL_ID });
		const b = await chat.createConversation({ providerId: LOCAL_ID });
		for (const conversation of [a, b]) {
			const ack = await chat.sendMessage(
				{
					providerId: LOCAL_ID,
					conversationId: conversation.summary.id,
					model: 'llama3',
					messages: [{ role: 'user', content: 'hi' }],
				},
				new EventLog().sink,
			);
			await chat.waitForTurn(ack.turnId);
		}
		const executions = await store().listConsumption({});
		assert.deepStrictEqual(
			executions.map((entry) => entry.conversationId).sort(),
			[a.summary.id, b.summary.id].sort(),
		);
	});


	test('80% of a limit is reported, and the same condition is not repeated', async () => {
		const chat = await paidSession({ output: 500 });
		// 1000 in + 500 out at 3/15 per million = 0.0105.
		const ratio = 0.0105 / 0.8;
		await chat.saveSpendingLimit({ currency: 'USD', amount: String(ratio), window: 'month' });
		const first = await send(chat, 'llama3');
		assert.strictEqual(first.terminal.type, 'done');

		const alerts = await chat.listBudgetAlerts();
		const [alert] = alerts;
		assert.ok(alert !== undefined);
		assert.ok(alert.fraction >= 0.8, `fraction ${alert.fraction}`);
		assert.ok(alert.message.includes('%'));

		// Asking again is still the same condition: one alert, not a growing
		// list of duplicates.
		const repeated = await chat.listBudgetAlerts();
		assert.strictEqual(repeated.length, 1);
		assert.strictEqual(repeated[0].limitId, alert.limitId);
	});

	test('below 80% there is no alert, and an exhausted limit is at 100% or more', async () => {
		const chat = await paidSession({ output: 500 });
		await chat.saveSpendingLimit({ currency: 'USD', amount: '100', window: 'month' });
		await send(chat, 'llama3');
		assert.deepStrictEqual(await chat.listBudgetAlerts(), []);
	});

	test('changing the limit moves the alert with it', async () => {
		const chat = await paidSession({ output: 500 });
		const ratio = 0.0105 / 0.8;
		await chat.saveSpendingLimit({ currency: 'USD', amount: String(ratio), window: 'month' });
		await send(chat, 'llama3');
		const before = await chat.listBudgetAlerts();
		assert.strictEqual(before.length, 1);

		// A tighter cap leaves the same spend above 80%, so the alert is now
		// a larger fraction — the condition changed with the limit.
		await chat.saveSpendingLimit({ currency: 'USD', amount: String(ratio / 2), window: 'month' });
		const after = await chat.listBudgetAlerts();
		assert.strictEqual(after.length, 1);
		assert.ok(after[0] !== undefined && before[0] !== undefined);
		assert.ok(after[0].fraction > before[0].fraction);
	});

	test('a free model produces no alert even with a zero budget', async () => {
		advertised.set('local', ['llama3']);
		const { fetchImpl } = scriptedFetch(() => sseResponse([delta('grátis'), DONE]));
		const chat = session(fetchImpl, true);
		await chat.saveProvider({ baseUrl: LOCAL_URL });
		await chat.saveModelCatalogEntry({ providerId: LOCAL_ID, modelId: 'llama3', access: 'free' });
		await chat.saveSpendingLimit({ currency: 'USD', amount: '0', window: 'month' });
		const log = await send(chat, 'llama3');
		assert.strictEqual(log.terminal.type, 'done');
		assert.deepStrictEqual(await chat.listBudgetAlerts(), []);
	});

	test('the 5B block still holds: a spent budget refuses the paid call', async () => {
		const chat = await paidSession({ output: 500 });
		await chat.saveSpendingLimit({ currency: 'USD', amount: '0.001', window: 'month' });
		await send(chat, 'llama3');

		const { fetchImpl, requests } = scriptedFetch(() => sseResponse([delta('não'), DONE]));
		const blocked = new ChatSession({
			config: new ProviderConfigService(new FileStateStore({ filePath: join(root, 'state.json') })),
			secrets: new FileSecretStore({ filePath: join(root, 'secrets.json') }),
			history: store(),
			logger: new LoggingService(new ConsoleLogSink({ out: () => undefined, err: () => undefined })),
			fetchImpl,
			turnTimeoutMs: 5_000,
			routing: {
				policy: policy(),
				breaker: new CircuitBreaker(() => policy().breaker, () => Date.now()),
				sleep: async () => true,
			},
			allowPaid: true,
		});
		await blocked.saveProvider({ baseUrl: LOCAL_URL });
		await blocked.saveModelCatalogEntry({ providerId: LOCAL_ID, modelId: 'llama3', access: 'paid', pricing: USD });
		const log = await send(blocked, 'llama3');
		assert.strictEqual(log.terminal.type, 'error');
		assert.strictEqual(requests, 0, 'the paid model was never called');
		assert.ok(
			log.events.some((event) => event.type === 'budgetBlocked'),
			'the block is still announced',
		);
	});

	test('forecast and alerts work without routing configured', async () => {
		advertised.set('local', ['llama3']);
		const { fetchImpl } = scriptedFetch(() => sseResponse([delta('ok'), usageChunk(100, 50), DONE]));
		const chat = new ChatSession({
			config: new ProviderConfigService(new FileStateStore({ filePath: join(root, 'state.json') })),
			secrets: new FileSecretStore({ filePath: join(root, 'secrets.json') }),
			history: store(),
			logger: new LoggingService(new ConsoleLogSink({ out: () => undefined, err: () => undefined })),
			fetchImpl,
		});
		await chat.saveProvider({ baseUrl: LOCAL_URL });
		await chat.saveModelCatalogEntry({ providerId: LOCAL_ID, modelId: 'llama3', access: 'paid', pricing: USD });
		const forecast = await chat.forecastCall({ providerId: LOCAL_ID, modelId: 'llama3', promptText: 'hi' });
		assert.strictEqual(forecast.cost.status, 'unknown', 'no measured output yet');
		assert.deepStrictEqual(await chat.listBudgetAlerts(), []);
	});

	test('a forecast for an unknown model is unknown, not an error', async () => {
		const chat = await paidSession({ output: 1 });
		const forecast = await chat.forecastCall({ providerId: LOCAL_ID, modelId: 'does-not-exist', promptText: 'x' });
		assert.strictEqual(forecast.cost.status, 'unknown');
	});
});

function round(value: number): number {
	return Math.round(value * 1e12) / 1e12;
}
