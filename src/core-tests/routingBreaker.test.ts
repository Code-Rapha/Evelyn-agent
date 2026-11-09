/**
 * Routing, stage 1: the circuit breaker.
 *
 * Every test moves an injected clock, so the asserted windows are exact. The
 * properties under test are the ones a wrong breaker would quietly violate:
 *
 * - it opens only after the threshold inside the window;
 * - it admits exactly one probe after the open window, not a burst;
 * - a success closes it, a failure during the probe reopens it;
 * - cancellations and caller mistakes never count;
 * - two models are two circuits, even when their ids contain a slash.
 */
import * as assert from 'assert';

import { CircuitBreaker, type BreakerConfig } from '../core/providers/routing';

const CONFIG: BreakerConfig = {
	failureThreshold: 3,
	windowMs: 30_000,
	openMs: 5_000,
	halfOpenProbes: 1,
};

const KEY = CircuitBreaker.key('provider-a', 'model-x');

function clock(start = 1_000): { readonly now: () => number; advance: (ms: number) => void } {
	let value = start;
	return {
		now: () => value,
		advance: (ms) => {
			value += ms;
		},
	};
}

function openCircuit(breaker: CircuitBreaker): void {
	breaker.recordFailure(KEY, 'timeout');
	breaker.recordFailure(KEY, 'timeout');
	breaker.recordFailure(KEY, 'timeout');
}

suite('Routing: circuit breaker', () => {
	test('a closed circuit allows an attempt', () => {
		const breaker = new CircuitBreaker(() => CONFIG, clock().now);
		assert.deepStrictEqual(breaker.check(KEY), {
			allowed: true,
			state: 'closed',
			retryAfterMs: 0,
		});
	});

	test('opens only at the threshold', () => {
		const breaker = new CircuitBreaker(() => CONFIG, clock().now);

		breaker.recordFailure(KEY, 'timeout');
		breaker.recordFailure(KEY, 'timeout');
		assert.strictEqual(breaker.check(KEY).allowed, true, 'two failures are below the threshold');

		breaker.recordFailure(KEY, 'timeout');
		const denied = breaker.check(KEY);
		assert.strictEqual(denied.allowed, false);
		assert.strictEqual(denied.state, 'open');
	});

	test('reports the remaining open window', () => {
		const time = clock();
		const breaker = new CircuitBreaker(() => CONFIG, time.now);
		openCircuit(breaker);

		time.advance(1_200);
		assert.deepStrictEqual(breaker.check(KEY), {
			allowed: false,
			state: 'open',
			retryAfterMs: 3_800,
		});
	});

	test('forgets failures that fell out of the window', () => {
		const time = clock();
		const breaker = new CircuitBreaker(() => CONFIG, time.now);

		breaker.recordFailure(KEY, 'timeout');
		breaker.recordFailure(KEY, 'timeout');

		time.advance(30_001);
		breaker.recordFailure(KEY, 'timeout');

		assert.strictEqual(breaker.check(KEY).allowed, true, 'only one failure is still inside the window');
		assert.strictEqual(breaker.snapshot(KEY).failures, 1);
	});

	test('an authentication failure opens immediately', () => {
		const breaker = new CircuitBreaker(() => CONFIG, clock().now);

		breaker.recordFailure(KEY, 'auth');

		const denied = breaker.check(KEY);
		assert.strictEqual(denied.allowed, false);
		assert.strictEqual(breaker.snapshot(KEY).lastErrorClass, 'auth');
	});

	test('cancellations and caller mistakes never count', () => {
		const breaker = new CircuitBreaker(() => CONFIG, clock().now);

		const ignored = ['cancelled', 'bad_request', 'context_length', 'breaker_open', 'no_candidate'] as const;
		for (const errorClass of ignored) {
			for (let index = 0; index < 10; index += 1) {
				breaker.recordFailure(KEY, errorClass);
			}
		}

		assert.strictEqual(breaker.check(KEY).allowed, true);
		assert.deepStrictEqual(breaker.snapshot(KEY), {
			state: 'closed',
			failures: 0,
			openUntil: 0,
			retryAfterMs: 0,
			lastErrorClass: null,
		});
	});

	test('admits exactly one probe after the open window', () => {
		const time = clock();
		const breaker = new CircuitBreaker(() => CONFIG, time.now);
		openCircuit(breaker);

		time.advance(5_000);

		const probe = breaker.check(KEY);
		assert.deepStrictEqual(probe, { allowed: true, state: 'half-open', retryAfterMs: 0 });

		const second = breaker.check(KEY);
		assert.deepStrictEqual(second, { allowed: false, state: 'half-open', retryAfterMs: 0 });
	});

	test('a successful probe closes the circuit', () => {
		const time = clock();
		const breaker = new CircuitBreaker(() => CONFIG, time.now);
		openCircuit(breaker);

		time.advance(5_000);
		assert.strictEqual(breaker.check(KEY).allowed, true);
		breaker.recordSuccess(KEY);

		assert.strictEqual(breaker.check(KEY).allowed, true);
		assert.deepStrictEqual(breaker.snapshot(KEY), {
			state: 'closed',
			failures: 0,
			openUntil: 0,
			retryAfterMs: 0,
			lastErrorClass: null,
		});
	});

	test('a failed probe reopens for another full window', () => {
		const time = clock();
		const breaker = new CircuitBreaker(() => CONFIG, time.now);
		openCircuit(breaker);

		time.advance(5_000);
		assert.strictEqual(breaker.check(KEY).allowed, true);
		breaker.recordFailure(KEY, 'timeout');

		const reopened = breaker.check(KEY);
		assert.strictEqual(reopened.allowed, false);
		assert.strictEqual(reopened.retryAfterMs, 5_000);

		time.advance(4_999);
		assert.strictEqual(breaker.check(KEY).retryAfterMs, 1);

		time.advance(1);
		assert.strictEqual(breaker.check(KEY).state, 'half-open');
	});

	test('a snapshot never consumes the probe', () => {
		const time = clock();
		const breaker = new CircuitBreaker(() => CONFIG, time.now);
		openCircuit(breaker);

		time.advance(5_000);

		assert.strictEqual(breaker.snapshot(KEY).state, 'half-open', 'the view reports the elapsed window');
		assert.strictEqual(breaker.snapshot(KEY).state, 'half-open', 'reading twice changes nothing');

		assert.strictEqual(breaker.check(KEY).allowed, true, 'the probe is still available');
		assert.strictEqual(breaker.check(KEY).allowed, false, 'and only once');
	});

	test('each provider/model is its own circuit', () => {
		const breaker = new CircuitBreaker(() => CONFIG, clock().now);
		const other = CircuitBreaker.key('provider-a', 'model-y');

		openCircuit(breaker);

		assert.strictEqual(breaker.check(KEY).allowed, false);
		assert.strictEqual(breaker.check(other).allowed, true);
	});

	test('the key cannot be forged by a slash in a model id', () => {
		assert.notStrictEqual(
			CircuitBreaker.key('a/b', 'c'),
			CircuitBreaker.key('a', 'b/c'),
			'two different candidates must not share health',
		);
	});

	test('reset forgets one circuit or all of them', () => {
		const breaker = new CircuitBreaker(() => CONFIG, clock().now);
		const other = CircuitBreaker.key('provider-b', 'model-z');

		openCircuit(breaker);
		breaker.recordFailure(other, 'auth');

		breaker.reset(KEY);
		assert.strictEqual(breaker.check(KEY).allowed, true);
		assert.strictEqual(breaker.check(other).allowed, false, 'reset(key) leaves the others alone');

		breaker.reset();
		assert.strictEqual(breaker.check(other).allowed, true);
	});
});
