/**
 * Descoberta do provedor no núcleo puro: o que `/models` publica, o que os
 * cabeçalhos dizem sobre a cota, e o rastreador de esgotamento.
 *
 * Nenhum teste aqui abre socket: as respostas são objetos, como o
 * `OpenAICompatibleProvider` as recebe.
 */
import * as assert from 'assert';

import { readPublishedModelFields } from '../core/providers/discovery/published';
import {
	parseRetryAfter,
	readQuotaHeaders,
	windowMs,
	createQuotaTracker,
	type QuotaState,
} from '../core/providers/quota';

suite('Discovery: what /models publishes', () => {
	test('an entry with only an id publishes nothing else', () => {
		assert.deepStrictEqual(readPublishedModelFields({ id: 'gpt' }), {});
	});

	test('a per-token price is normalized to the catalog unit', () => {
		const fields = readPublishedModelFields({
			id: 'm',
			pricing: { currency: 'usd', input: 0.000003, output: 0.000015 },
		});
		assert.deepStrictEqual(fields.pricing, {
			currency: 'USD',
			unit: 'per_1m_tokens',
			input: 3,
			output: 15,
		});
	});

	test('a per-million price stays per million', () => {
		const fields = readPublishedModelFields({
			id: 'm',
			pricing: { currency: 'EUR', input: { per_million: 2 }, output: { per_million: 8 } },
		});
		assert.deepStrictEqual(fields.pricing, {
			currency: 'EUR',
			unit: 'per_1m_tokens',
			input: 2,
			output: 8,
		});
	});

	test('a price without a currency is not a price', () => {
		const fields = readPublishedModelFields({ id: 'm', pricing: { input: 3, output: 15 } });
		assert.strictEqual(fields.pricing, undefined, 'no currency, no price - not zero');
	});

	test('two directions in different units are ambiguous and ignored', () => {
		const fields = readPublishedModelFields({
			id: 'm',
			pricing: {
				currency: 'USD',
				input: { per_1k: 1 },
				output: { per_million: 5 },
			},
		});
		assert.strictEqual(fields.pricing, undefined);
	});

	test('context is read from the places providers actually publish it', () => {
		assert.strictEqual(readPublishedModelFields({ id: 'm', context_length: 8192 }).contextTokens, 8192);
		assert.strictEqual(readPublishedModelFields({ id: 'm', context_window: 4096 }).contextTokens, 4096);
		assert.strictEqual(
			readPublishedModelFields({ id: 'm', limits: { context_tokens: 2048 } }).contextTokens,
			2048,
		);
		assert.strictEqual(readPublishedModelFields({ id: 'm', context_length: -1 }).contextTokens, undefined);
	});

	test('a creation date is read as seconds or milliseconds', () => {
		const seconds = readPublishedModelFields({ id: 'm', created: 1_700_000_000 });
		const millis = readPublishedModelFields({ id: 'm', created: 1_700_000_000_000 });
		assert.strictEqual(seconds.created, millis.created);
		assert.ok(seconds.created?.startsWith('2023-11-14'));
	});

	test('a malformed entry publishes nothing rather than throwing', () => {
		assert.deepStrictEqual(readPublishedModelFields(null), {});
		assert.deepStrictEqual(readPublishedModelFields('nope'), {});
		assert.deepStrictEqual(readPublishedModelFields({ id: 'm', pricing: 'cheap' }), {});
	});
});

suite('Quota: headers and Retry-After', () => {
	const now = Date.parse('2026-10-20T12:00:00.000Z');

	test('Retry-After as seconds', () => {
		assert.strictEqual(parseRetryAfter('120', now), 120_000);
		assert.strictEqual(parseRetryAfter('0', now), 0, 'zero is a fact: try now');
	});

	test('Retry-After as an HTTP date', () => {
		assert.strictEqual(
			parseRetryAfter('Tue, 20 Oct 2026 12:01:00 GMT', now),
			60_000,
		);
	});

	test('a past date means no wait, not a negative one', () => {
		assert.strictEqual(parseRetryAfter('Tue, 20 Oct 2026 11:59:00 GMT', now), 0);
	});

	test('garbage is absent, never a guessed number', () => {
		assert.strictEqual(parseRetryAfter('soon', now), undefined);
		assert.strictEqual(parseRetryAfter('', now), undefined);
		assert.strictEqual(parseRetryAfter(undefined, now), undefined);
	});

	test('a response with no quota headers says nothing', () => {
		assert.strictEqual(readQuotaHeaders({ 'content-type': 'application/json' }, now), undefined);
	});

	test('request limits are read with their window and reset', () => {
		const state = readQuotaHeaders(
			{
				'x-ratelimit-limit-requests': '100',
				'x-ratelimit-remaining-requests': '0',
				'x-ratelimit-window': 'minute',
				'x-ratelimit-reset': '30',
			},
			now,
		);
		assert.ok(state !== undefined);
		assert.strictEqual(state.limit?.limit.value, 100);
		assert.strictEqual(state.limit?.kind, 'requests');
		assert.strictEqual(state.limit?.window, 'minute');
		assert.strictEqual(state.remaining?.value, 0);
		assert.strictEqual(state.resetAt, new Date(now + 30_000).toISOString());
		assert.strictEqual(state.source, 'account');
	});

	test('token limits are recognized when that is all the API reports', () => {
		const state = readQuotaHeaders(
			{ 'x-ratelimit-limit-tokens': '5000', 'x-ratelimit-remaining-tokens': '1200' },
			now,
		);
		assert.strictEqual(state?.limit?.kind, 'tokens');
		assert.strictEqual(state?.remaining?.value, 1200);
	});

	test('Retry-After alone is still information', () => {
		const state = readQuotaHeaders({ 'retry-after': '7' }, now);
		assert.strictEqual(state?.retryAfterMs, 7_000);
		assert.strictEqual(state?.source, 'account');
		assert.strictEqual(state?.limit, undefined);
	});

	test('an unparseable remaining count is dropped, not read as zero', () => {
		const state = readQuotaHeaders({ 'x-ratelimit-remaining-requests': 'many' }, now);
		assert.strictEqual(state, undefined);
	});

	test('the scope is never assumed', () => {
		const state = readQuotaHeaders({ 'x-ratelimit-limit-requests': '10' }, now);
		assert.strictEqual(state?.limit?.scope, undefined, 'no header said whose limit this is');
	});
});

suite('Quota: exhaustion tracker', () => {
	const base = Date.parse('2026-10-20T12:00:00.000Z');
	let clock = base;
	const tracker = createQuotaTracker({ now: () => clock });

	setup(() => {
		clock = base;
		tracker.clear();
	});

	const scope = { providerId: 'p', modelId: 'm' };

	test('a fresh tracker allows everything', () => {
		assert.deepStrictEqual(tracker.check(scope), { allowed: true });
	});

	test('remaining zero with a reset is exhausted until the reset', () => {
		const state: QuotaState = {
			source: 'account',
			remaining: { value: 0, source: 'account' },
			resetAt: new Date(base + 60_000).toISOString(),
		};
		tracker.record(scope, state);
		const check = tracker.check(scope);
		assert.strictEqual(check.allowed, false);
		assert.strictEqual(check.retryAfterMs, 60_000);
		assert.strictEqual(check.reason, 'reset');

		clock = base + 60_001;
		assert.strictEqual(tracker.check(scope).allowed, true, 'the window turned: no longer exhausted');
	});

	test('a 429 without any window does not block', () => {
		tracker.record(scope, { source: 'observed' }, { exhausted: true });
		assert.strictEqual(tracker.check(scope).allowed, true, 'no window, no permanent block');
	});

	test('Retry-After starts a window', () => {
		tracker.record(
			scope,
			{ source: 'account', remaining: { value: 0, source: 'account' }, retryAfterMs: 5_000 },
		);
		assert.deepStrictEqual(tracker.check(scope), {
			allowed: false,
			retryAfterMs: 5_000,
			reason: 'retry-after',
		});
	});

	test('remaining above zero clears an earlier exhaustion', () => {
		tracker.record(scope, {
			source: 'account',
			remaining: { value: 0, source: 'account' },
			retryAfterMs: 10_000,
		});
		tracker.record(scope, {
			source: 'account',
			remaining: { value: 5, source: 'account' },
			limit: { limit: { value: 10, source: 'account' }, kind: 'requests' },
		});
		assert.strictEqual(tracker.check(scope).allowed, true);
	});

	test('the window from the declared limit is used when no reset is given', () => {
		tracker.record(scope, {
			source: 'account',
			remaining: { value: 0, source: 'account' },
			limit: { limit: { value: 10, source: 'account' }, kind: 'requests', window: 'minute' },
		});
		assert.strictEqual(tracker.check(scope).retryAfterMs, 60_000);
		assert.strictEqual(windowMs('minute'), 60_000);
	});

	test('scopes are independent, and a model is never blocked by its provider', () => {
		tracker.record({ providerId: 'p', modelId: 'other' }, {
			source: 'account',
			remaining: { value: 0, source: 'account' },
			retryAfterMs: 1_000,
		});
		assert.strictEqual(tracker.check(scope).allowed, true);
	});

	test('a later no-deadline report does not shorten a known window', () => {
		tracker.record(scope, {
			source: 'account',
			remaining: { value: 0, source: 'account' },
			retryAfterMs: 30_000,
		});
		tracker.record(scope, { source: 'observed' }, { exhausted: true });
		assert.strictEqual(tracker.check(scope).retryAfterMs, 30_000);
	});

	test('the snapshot lists only live windows', () => {
		tracker.record(scope, {
			source: 'account',
			remaining: { value: 0, source: 'account' },
			retryAfterMs: 1_000,
		});
		tracker.record({ providerId: 'p', modelId: 'ghost' }, { source: 'observed' }, { exhausted: true });
		assert.strictEqual(tracker.snapshot().length, 1);
		assert.deepStrictEqual(tracker.snapshot()[0]?.scope, scope);
	});
});
