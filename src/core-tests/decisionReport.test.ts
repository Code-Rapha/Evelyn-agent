/**
 * O relatório de decisão: o que ele diz, e o que ele não pode dizer.
 *
 * A segunda parte é a importante: um relatório que carrega a chave da API
 * é um relatório que vaza, e ninguém nota olhando a tela. A checagem é
 * sobre o texto serializado, não sobre o tipo.
 */
import * as assert from 'assert';

import { buildDecisionReport, type BuildDecisionReportInput } from '../desktop/buildDecisionReport';
import { assertNoSecrets, type RoutingDecisionReport } from '../desktop/decisionReport';
import { parseRoutingDecisionReport, parseRoutingDecisionReports } from '../desktop/decisionReportParsers';

const T0 = '2026-10-20T12:00:00.000Z';

function report(overrides: Partial<BuildDecisionReportInput> = {}): RoutingDecisionReport {
	return buildDecisionReport({
		turnId: 'turn-1',
		conversationId: 'c1',
		startedAt: T0,
		strategy: 'fallback',
		policy: 'any',
		policyApplied: false,
		sources: { price: 'user', limits: 'user', capabilities: 'user' },
		reasons: [
			{
				providerId: 'p',
				modelId: 'chosen',
				chosen: true,
				reason: 'Match: tools',
				capabilities: [],
				supportsTools: true,
				supportsStreaming: true,
				access: 'free',
			},
			{
				providerId: 'p',
				modelId: 'discarded',
				chosen: false,
				reason: 'Low score (-100): paid model not allowed',
				capabilities: [],
				supportsTools: false,
				supportsStreaming: true,
				access: 'paid',
			},
		],
		candidates: [
			{
				providerId: 'p',
				modelId: 'chosen',
				access: 'free',
				price: {
					currency: 'USD',
					unit: 'per_1m_tokens',
					input: 3,
					output: 15,
					side: 'user',
					provenance: { source: 'manual' },
				},
				limits: {
					contextTokens: 8192,
					provenance: { source: 'provider', verifiedAt: T0 },
				},
				capabilities: { toolCalling: true },
			},
		],
		budget: [],
		quotas: [],
		attempts: [],
		result: 'success',
		finalModel: { providerId: 'p', modelId: 'chosen' },
		summary: 'Respondeu p/chosen.',
		...overrides,
	});
}

suite('Decision report: what it says', () => {
	test('the chosen model, its reason and its access are there', () => {
		const built = report();
		assert.strictEqual(built.chosen?.providerId, 'p');
		assert.strictEqual(built.chosen?.modelId, 'chosen');
		assert.strictEqual(built.chosen?.reason, 'Match: tools');
		assert.strictEqual(built.chosen?.access, 'free');
	});

	test('the price comes with its side and its provenance', () => {
		const built = report();
		assert.strictEqual(built.chosen?.price?.currency, 'USD');
		assert.strictEqual(built.chosen?.price?.side, 'user');
		assert.strictEqual(built.chosen?.price?.provenance?.source, 'manual');
	});

	test('the limits come with their provenance', () => {
		const built = report();
		assert.strictEqual(built.chosen?.limits?.contextTokens, 8192);
		assert.strictEqual(built.chosen?.limits?.provenance?.source, 'provider');
	});

	test('the discarded alternatives are listed with their reason', () => {
		const built = report();
		assert.strictEqual(built.alternatives.length, 1);
		assert.strictEqual(built.alternatives[0]?.modelId, 'discarded');
		assert.ok(built.alternatives[0]?.reason.includes('paid'));
	});

	test('the policy and its sources are recorded', () => {
		const built = report({
			policy: 'free_only',
			policyApplied: true,
			sources: { price: 'discovered', limits: 'discovered', capabilities: 'user' },
		});
		assert.strictEqual(built.policy, 'free_only');
		assert.strictEqual(built.policyApplied, true);
		assert.strictEqual(built.sources.price, 'discovered');
	});

	test('the budget constraints say which limit and whether it blocked', () => {
		const built = report({
			budget: [
				{
					candidate: { providerId: 'p', modelId: 'chosen' },
					applicable: [
						{
							limitId: 'global',
							currency: 'USD',
							amount: 10,
							window: 'month',
							createdAt: T0,
							updatedAt: T0,
						},
					],
					decision: { allowed: false },
				},
			],
		});
		assert.strictEqual(built.budget.length, 1);
		assert.strictEqual(built.budget[0]?.scope, 'global');
		assert.strictEqual(built.budget[0]?.blocked, true);
		assert.strictEqual(built.budget[0]?.amount, 10);
	});

	test('a quota that skipped a candidate shows as exhausted', () => {
		const built = report({
			attempts: [
				{
					requestId: 'r1',
					providerId: 'p',
					modelId: 'other',
					sequence: 1,
					startedAtMs: 0,
					retry: false,
					fallback: false,
					outcome: 'skipped',
					errorClass: 'rate_limit',
				},
			],
		});
		assert.strictEqual(built.quotas.length, 1);
		assert.strictEqual(built.quotas[0]?.exhausted, true);
		assert.strictEqual(built.quotas[0]?.source, 'observed');
	});

	test('the final result and the final model are there', () => {
		const built = report();
		assert.strictEqual(built.result, 'success');
		assert.strictEqual(built.finalModel?.modelId, 'chosen');
	});
});

suite('Decision report: what it must never say', () => {
	test('a report with no secret passes the check', () => {
		assert.doesNotThrow(() => assertNoSecrets(report()));
	});

	test('a report carrying a key is refused', () => {
		const leaky = {
			...report(),
			summary: 'usou sk-abcdefghijklmnop para chamar',
		};
		assert.throws(() => assertNoSecrets(leaky), /key/i);
	});

	test('a report carrying an authorization header is refused', () => {
		const leaky = { ...report(), summary: 'Bearer abcdefghijkl' };
		assert.throws(() => assertNoSecrets(leaky), /authorization/i);
	});

	test('the report carries no conversation content', () => {
		const built = report({
			summary: 'Respondeu p/chosen.',
		});
		const raw = JSON.stringify(built);
		assert.strictEqual(raw.includes('messages'), false);
		assert.strictEqual(raw.includes('content'), false);
		assert.strictEqual(raw.includes('prompt'), false);
	});
});

suite('Decision report: the bridge', () => {
	test('a well-formed report round-trips', () => {
		const built = report();
		const parsed = parseRoutingDecisionReport(JSON.parse(JSON.stringify(built)));
		assert.strictEqual(parsed?.turnId, 'turn-1');
		assert.strictEqual(parsed?.chosen?.modelId, 'chosen');
		assert.strictEqual(parsed?.alternatives.length, 1);
	});

	test('a report without a policy is dropped', () => {
		assert.strictEqual(parseRoutingDecisionReport({ turnId: 't' }), undefined);
	});

	test('a report with an unknown policy is dropped', () => {
		assert.strictEqual(
			parseRoutingDecisionReport({
				turnId: 't',
				conversationId: 'c',
				startedAt: T0,
				strategy: 'fallback',
				policy: 'cheap',
				sources: { price: 'user', limits: 'user', capabilities: 'user' },
				result: 'success',
			}),
			undefined,
		);
	});

	test('a malformed attempt is dropped, the rest survives', () => {
		const parsed = parseRoutingDecisionReport({
			turnId: 't',
			conversationId: 'c',
			startedAt: T0,
			strategy: 'fallback',
			policy: 'any',
			sources: { price: 'user', limits: 'user', capabilities: 'user' },
			result: 'success',
			attempts: [{ sequence: 'one' }, { sequence: 2, providerId: 'p', modelId: 'm', outcome: 'success' }],
		});
		assert.strictEqual(parsed?.attempts.length, 1);
		assert.strictEqual(parsed?.attempts[0]?.sequence, 2);
	});

	test('a list of reports keeps only the readable ones', () => {
		const parsed = parseRoutingDecisionReports([report(), { nope: true }, report()]);
		assert.strictEqual(parsed.length, 2);
	});

	test('a non-list is an empty list, not a failure', () => {
		assert.deepStrictEqual(parseRoutingDecisionReports('nope'), []);
	});
});
