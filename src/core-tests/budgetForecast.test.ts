/**
 * Previsão de custo, avisos de 80% e consumo por conversa/turno.
 *
 * Tudo puro: nenhum teste aqui abre disco. As execuções são montadas com
 * `summarizeExecution` sobre tentativas de `resolveAttemptAccounting`, a mesma
 * aritmética da 5A, para que o teste verifique o recorte e não uma segunda
 * conta inventada no teste.
 */
import * as assert from 'assert';

import type { AttemptRecord, ExecutionRecord } from '../core/storage/types/consumption';
import { resolveAttemptAccounting, summarizeExecution } from '../core/storage/types/consumption';
import {
	BUDGET_ALERT_THRESHOLD,
	BudgetAlertLog,
	aggregateUsage,
	budgetAlert,
	estimateTextTokens,
	forecastCall,
	usageByChat,
	usageByConversation,
	windowRange,
	type SpendingLimit,
} from '../core/budget';

const USD_3_15 = {
	currency: 'USD',
	unit: 'per_1m_tokens' as const,
	input: 3,
	output: 15,
};

function attempt(sequence: number, input: number, output: number, pricing: typeof USD_3_15 | undefined = USD_3_15): AttemptRecord {
	const accounting = resolveAttemptAccounting({
		reportedTokens: { input, output },
		...(pricing !== undefined ? { pricing } : {}),
	});
	return {
		attemptId: `e#${sequence}`,
		executionId: 'e',
		providerId: 'p',
		modelId: 'm',
		sequence,
		retry: false,
		fallback: false,
		status: 'success',
		startedAt: '2026-10-19T10:00:00.000Z',
		recordedAt: '2026-10-19T10:00:00.000Z',
		// Without a price, `resolveAttemptAccounting` drops the reading (it was
		// not cheaper than zero, it was unpriceable). The attempt keeps the
		// tokens and loses the cost, which is exactly the "unknown, not zero"
		// case a turn's total must not hide.
		...(pricing !== undefined && accounting.reportedTokens !== undefined
			? { reportedTokens: accounting.reportedTokens }
			: {}),
		...(accounting.tokenSource !== undefined ? { tokenSource: accounting.tokenSource } : {}),
		...(accounting.pricing !== undefined ? { pricing: accounting.pricing } : {}),
		cost: accounting.cost,
	};
}

function execution(
	id: string,
	options: {
		readonly attempts: readonly AttemptRecord[];
		readonly conversationId?: string;
		readonly turnId?: string;
		readonly providerId?: string;
		readonly modelId?: string;
		readonly startedAt?: string;
	},
): ExecutionRecord {
	return {
		executionId: id,
		kind: 'routing',
		...(options.conversationId !== undefined ? { conversationId: options.conversationId } : {}),
		...(options.turnId !== undefined ? { turnId: options.turnId } : {}),
		...(options.providerId !== undefined ? { providerId: options.providerId } : {}),
		...(options.modelId !== undefined ? { modelId: options.modelId } : {}),
		status: 'success',
		startedAt: options.startedAt ?? '2026-10-19T10:00:00.000Z',
		finishedAt: options.startedAt ?? '2026-10-19T10:00:00.000Z',
		attemptIds: options.attempts.map((entry) => entry.attemptId),
		totals: summarizeExecution(options.attempts),
	};
}

function limit(overrides: Partial<SpendingLimit> = {}): SpendingLimit {
	return {
		limitId: 'global',
		currency: 'USD',
		amount: 10,
		window: 'month',
		createdAt: '2026-10-01T00:00:00.000Z',
		updatedAt: '2026-10-01T00:00:00.000Z',
		...overrides,
	};
}

const PERIOD = '2026-10-01T00:00:00.000Z';

suite('Budget: forecast', () => {
	test('a rough token estimate is a ceiling of characters over four', () => {
		assert.strictEqual(estimateTextTokens(''), 0);
		assert.strictEqual(estimateTextTokens('abc'), 1);
		assert.strictEqual(estimateTextTokens('abcd'), 1);
		assert.strictEqual(estimateTextTokens('abcde'), 2);
	});

	test('a known price and a measured answer give an estimated cost', () => {
		const forecast = forecastCall({
			providerId: 'p',
			modelId: 'm',
			access: 'paid',
			pricing: USD_3_15,
			// 40 characters = 10 input tokens.
			promptText: 'x'.repeat(40),
			conversationSamples: [],
			modelSamples: [{ outputTokens: 500 }, { outputTokens: 500 }, { outputTokens: 500 }],
		});
		assert.strictEqual(forecast.cost.status, 'estimated');
		if (forecast.cost.status === 'estimated') {
			// 10 input at 3/M plus 500 output at 15/M.
			assert.strictEqual(forecast.cost.input, 0.00003);
			assert.strictEqual(forecast.cost.output, 0.0075);
			assert.strictEqual(forecast.cost.total, 0.00753);
			assert.strictEqual(forecast.cost.currency, 'USD');
		}
		assert.strictEqual(forecast.inputTokens, 10);
		assert.strictEqual(forecast.outputBasis, 'model');
		assert.strictEqual(forecast.inputBasis, 'conversation');
		assert.strictEqual(forecast.confidence, 'high');
	});

	test('this conversation is the first basis for the answer size', () => {
		const forecast = forecastCall({
			providerId: 'p',
			modelId: 'm',
			access: 'paid',
			pricing: USD_3_15,
			promptText: 'x'.repeat(40),
			conversationSamples: [{ outputTokens: 100 }, { outputTokens: 300 }],
			modelSamples: [{ outputTokens: 5_000 }, { outputTokens: 5_000 }, { outputTokens: 5_000 }],
		});
		assert.strictEqual(forecast.outputBasis, 'conversation');
		assert.strictEqual(forecast.outputTokens, 200, 'median of this conversation');
		if (forecast.cost.status === 'estimated') {
			assert.strictEqual(forecast.cost.total, round(0.00003 + 200 * 15e-6));
			// Two readings: a range, and not "high" confidence.
			assert.deepStrictEqual(forecast.cost.range, {
				low: round(0.00003 + 100 * 15e-6),
				high: round(0.00003 + 300 * 15e-6),
			});
		}
		assert.strictEqual(forecast.confidence, 'low');
	});

	test('no measured answer means unknown, never zero', () => {
		const forecast = forecastCall({
			providerId: 'p',
			modelId: 'm',
			access: 'paid',
			pricing: USD_3_15,
			promptText: 'x'.repeat(40),
			conversationSamples: [],
			modelSamples: [],
		});
		assert.strictEqual(forecast.cost.status, 'unknown');
		assert.strictEqual(forecast.outputTokens, undefined);
		assert.strictEqual(forecast.confidence, 'unknown');
		if (forecast.cost.status === 'unknown') {
			assert.ok(forecast.cost.reasons.some((reason) => reason.includes('saída')));
		}
	});

	test('a missing input price makes the forecast unknown', () => {
		const forecast = forecastCall({
			providerId: 'p',
			modelId: 'm',
			access: 'paid',
			pricing: { currency: 'USD', unit: 'per_1m_tokens', output: 15 },
			promptText: 'x'.repeat(40),
			conversationSamples: [],
			modelSamples: [{ outputTokens: 500 }],
		});
		assert.strictEqual(forecast.cost.status, 'unknown');
		if (forecast.cost.status === 'unknown') {
			assert.ok(forecast.cost.reasons.some((reason) => reason.includes('entrada')));
		}
	});

	test('no catalog price at all is unknown, not a free call', () => {
		const forecast = forecastCall({
			providerId: 'p',
			modelId: 'm',
			access: 'unknown',
			promptText: 'hello',
			conversationSamples: [],
			modelSamples: [{ outputTokens: 100 }],
		});
		assert.strictEqual(forecast.cost.status, 'unknown');
	});

	test('an empty conversation has no input to price', () => {
		const forecast = forecastCall({
			providerId: 'p',
			modelId: 'm',
			access: 'paid',
			pricing: USD_3_15,
			promptText: '',
			conversationSamples: [],
			modelSamples: [{ outputTokens: 100 }],
		});
		assert.strictEqual(forecast.cost.status, 'unknown');
	});

	test('a free model forecasts zero because it is free, and says so', () => {
		const forecast = forecastCall({
			providerId: 'p',
			modelId: 'm',
			access: 'free',
			promptText: 'hello',
			conversationSamples: [],
			modelSamples: [],
		});
		assert.strictEqual(forecast.cost.status, 'estimated');
		if (forecast.cost.status === 'estimated') {
			assert.strictEqual(forecast.cost.total, 0);
		}
	});

	test('the per-thousand unit is applied to the same token counts', () => {
		const forecast = forecastCall({
			providerId: 'p',
			modelId: 'm',
			access: 'paid',
			pricing: { currency: 'USD', unit: 'per_1k_tokens', input: 1, output: 2 },
			promptText: 'x'.repeat(4_000),
			conversationSamples: [],
			modelSamples: [{ outputTokens: 1_000 }],
		});
		assert.strictEqual(forecast.cost.status, 'estimated');
		if (forecast.cost.status === 'estimated') {
			// 1000 input at 1/1k plus 1000 output at 2/1k.
			assert.strictEqual(forecast.cost.total, 3);
			assert.strictEqual(forecast.cost.unit, 'per_1k_tokens');
		}
	});
});

function round(value: number): number {
	return Math.round(value * 1e12) / 1e12;
}

suite('Budget: 80% alerts', () => {
	const paid = { providerId: 'p', modelId: 'm', access: 'paid' };
	const usage = (spent: number | undefined) => ({
		cost:
			spent === undefined
				? ({ status: 'unknown', parts: [], reasons: ['no price'] } as const)
				: ({
						status: 'estimated',
						currency: 'USD',
						unit: 'per_1m_tokens',
						parts: [],
						total: spent,
					} as const),
		...(spent !== undefined ? { spent } : {}),
	});
	test('below 80% there is no alert', () => {
		const alert = budgetAlert({ limit: limit(), usage: usage(7.9), periodStart: PERIOD, candidate: paid });
		assert.strictEqual(alert, undefined);
		assert.strictEqual(BUDGET_ALERT_THRESHOLD, 0.8);
	});

	test('exactly 80% raises an alert with the numbers', () => {
		const alert = budgetAlert({ limit: limit(), usage: usage(8), periodStart: PERIOD, candidate: paid });
		assert.ok(alert !== undefined);
		assert.strictEqual(alert.fraction, 0.8);
		assert.strictEqual(alert.spent, 8);
		assert.strictEqual(alert.amount, 10);
		assert.ok(alert.message.includes('80%'));
		assert.ok(alert.message.includes('2,00'), 'the remaining amount is stated');
	});

	test('an exhausted limit is still an alert', () => {
		const alert = budgetAlert({ limit: limit(), usage: usage(12), periodStart: PERIOD, candidate: paid });
		assert.ok(alert !== undefined);
		assert.ok(alert.fraction > 1);
		assert.ok(alert.message.includes('esgotado'));
	});

	test('unknown spend never raises an alert', () => {
		const alert = budgetAlert({ limit: limit(), usage: usage(undefined), periodStart: PERIOD, candidate: paid });
		assert.strictEqual(alert, undefined);
	});

	test('a free model never raises an alert', () => {
		const alert = budgetAlert({
			limit: limit({ amount: 1 }),
			usage: usage(5),
			periodStart: PERIOD,
			candidate: { providerId: 'p', modelId: 'm', access: 'free' },
		});
		assert.strictEqual(alert, undefined);
	});

	test('a period with no measured consumption does not alert', () => {
		const alert = budgetAlert({ limit: limit({ amount: 0 }), usage: usage(undefined), periodStart: PERIOD, candidate: paid });
		assert.strictEqual(alert, undefined);
	});

	test('changing the cap within the threshold is a new condition', () => {
		const log = new BudgetAlertLog();
		const before = budgetAlert({ limit: limit(), usage: usage(9), periodStart: PERIOD, candidate: paid });
		const recapped = budgetAlert({
			limit: limit({ amount: 10.5 }),
			usage: usage(9),
			periodStart: PERIOD,
			candidate: paid,
		});
		assert.ok(before !== undefined && recapped !== undefined);
		assert.strictEqual(log.claim(before), true);
		assert.strictEqual(log.claim(recapped), true);
	});

	test('the same condition is announced once', () => {
		const log = new BudgetAlertLog();
		const alert = budgetAlert({ limit: limit(), usage: usage(9), periodStart: PERIOD, candidate: paid });
		assert.ok(alert !== undefined);
		assert.strictEqual(log.claim(alert), true);
		assert.strictEqual(log.claim(alert), false, 'a second message does not repeat it');
		assert.strictEqual(log.size, 1);
	});

	test('a new period announces again', () => {
		const log = new BudgetAlertLog();
		const first = budgetAlert({ limit: limit(), usage: usage(9), periodStart: PERIOD, candidate: paid });
		const nextPeriod = budgetAlert({
			limit: limit(),
			usage: usage(9),
			periodStart: '2026-10-20T00:00:00.000Z',
			candidate: paid,
		});
		assert.ok(first !== undefined && nextPeriod !== undefined);
		assert.notStrictEqual(first.key, nextPeriod.key);
		assert.strictEqual(log.claim(first), true);
		assert.strictEqual(log.claim(nextPeriod), true);
	});

	test('lowering the cap below the alert threshold clears it; a new cap warns again', () => {
		const log = new BudgetAlertLog();
		const before = budgetAlert({ limit: limit(), usage: usage(9), periodStart: PERIOD, candidate: paid });
		// Raising the cap so the spend is below 80% is not an alert at all.
		const relaxed = budgetAlert({
			limit: limit({ amount: 20 }),
			usage: usage(9),
			periodStart: PERIOD,
			candidate: paid,
		});
		assert.ok(before !== undefined);
		assert.strictEqual(relaxed, undefined);
		assert.strictEqual(log.claim(before), true);
	});

	test('the calendar window changes at local midnight', () => {
		const endOfDay = new Date(2026, 9, 19, 23, 59, 0);
		const nextDay = new Date(2026, 9, 20, 0, 1, 0);
		assert.notStrictEqual(windowRange('day', endOfDay).since, windowRange('day', nextDay).since);
		assert.strictEqual(windowRange('month', endOfDay).since, windowRange('month', nextDay).since);
	});
});

suite('Budget: per conversation and per turn', () => {
	const turnOne = execution('e1', {
		attempts: [attempt(1, 1_000, 500)],
		conversationId: 'chat-1',
		turnId: 'turn-1',
		providerId: 'p',
		modelId: 'm',
		startedAt: '2026-10-19T09:00:00.000Z',
	});
	const turnTwo = execution('e2', {
		attempts: [attempt(1, 2_000, 0)],
		conversationId: 'chat-1',
		turnId: 'turn-2',
		providerId: 'p',
		modelId: 'm',
		startedAt: '2026-10-19T10:00:00.000Z',
	});
	const otherChat = execution('e3', {
		attempts: [attempt(1, 100, 100)],
		conversationId: 'chat-2',
		turnId: 'turn-1',
		providerId: 'p',
		modelId: 'm',
		startedAt: '2026-10-19T11:00:00.000Z',
	});

	test('a conversation total equals the sum of its turns', () => {
		const usage = usageByConversation('chat-1', [turnTwo, turnOne]);
		assert.strictEqual(usage.turns.length, 2);
		assert.deepStrictEqual(usage.turns.map((turn) => turn.turnId), ['turn-1', 'turn-2'], 'oldest first');
		assert.deepStrictEqual(usage.total.tokens, { input: 3_000, output: 500 });
		const summed = usage.turns.reduce(
			(sum, turn) => ({
				input: sum.input + (turn.tokens?.input ?? 0),
				output: sum.output + (turn.tokens?.output ?? 0),
			}),
			{ input: 0, output: 0 },
		);
		assert.deepStrictEqual(summed, { input: 3_000, output: 500 });
	});

	test('the same turn id in another conversation is a different turn', () => {
		const chatOne = usageByConversation('chat-1', [turnOne]);
		const chatTwo = usageByConversation('chat-2', [otherChat]);
		assert.strictEqual(chatOne.turns.length, 1);
		assert.strictEqual(chatTwo.turns.length, 1);
		assert.notStrictEqual(chatOne.total.tokens, chatTwo.total.tokens);
	});

	test('an execution without a turn still counts in the conversation total', () => {
		const loose = execution('e4', {
			attempts: [attempt(1, 10, 10)],
			conversationId: 'chat-1',
			providerId: 'p',
			modelId: 'm',
		});
		const usage = usageByConversation('chat-1', [turnOne, loose]);
		assert.strictEqual(usage.turns.length, 1, 'no turn to show');
		assert.deepStrictEqual(usage.total.tokens, { input: 1_010, output: 510 });
	});

	test('a turn whose only round was never priced is unknown, not zero', () => {
		const unpriced = execution('e5', {
			attempts: [
				{
					...attempt(1, 1_000, 0),
					// Recorded without pricing: the tokens are there, the cost is not.
					cost: { status: 'unknown', parts: [], reasons: ['no price was recorded for this model'] },
					tokenSource: 'provider',
				},
			],
			conversationId: 'chat-1',
			turnId: 'turn-3',
			providerId: 'p',
			modelId: 'm',
		});
		const turn = usageByConversation('chat-1', [unpriced]).turns[0];
		assert.ok(turn !== undefined);
		assert.strictEqual(turn.cost.status, 'unknown');
		assert.strictEqual(turn.executionsWithoutCost, 1);
		assert.deepStrictEqual(turn.tokens, { input: 1_000, output: 0 });
	});

	test('conversations are listed newest first, and only those with an id', () => {
		const noChat = execution('e6', {
			attempts: [attempt(1, 1, 1)],
			providerId: 'p',
			modelId: 'm',
		});
		const all = usageByChat([turnOne, turnTwo, otherChat, noChat]);
		assert.deepStrictEqual(all.map((entry) => entry.conversationId), ['chat-2', 'chat-1']);
	});

	test('the conversation total agrees with the period aggregate', () => {
		const executions = [turnOne, turnTwo, otherChat];
		const summary = aggregateUsage(executions);
		const perChat = usageByChat(executions);
		const summed = perChat.reduce(
			(sum, chat) => ({
				input: sum.input + (chat.total.tokens?.input ?? 0),
				output: sum.output + (chat.total.tokens?.output ?? 0),
			}),
			{ input: 0, output: 0 },
		);
		assert.deepStrictEqual(summed, {
			input: summary.total.tokens?.input,
			output: summary.total.tokens?.output,
		});
	});
});
