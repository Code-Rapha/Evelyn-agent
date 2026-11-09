/**
 * Routing, stage 1: error classification.
 *
 * The claims under test, in the order they would hurt if wrong:
 *
 * 1. **A user's stop is never retried.** It outranks every status and every
 *    message, because retrying would override a decision.
 * 2. **A budget that ran out is a timeout**, even when the transport reports
 *    the abort itself.
 * 3. **Structured data beats prose**: status and cause decide before the
 *    message does.
 * 4. **Configuration problems are not retryable**, and neither are
 *    cancellations — retrying either spends budget to fail the same way.
 */
import * as assert from 'assert';

import { ProviderError } from '../core/errors';
import {
	classifyError,
	classifyHttpStatus,
	isBreakerIgnored,
	isRetryableErrorClass,
} from '../core/providers/routing';

suite('Routing: error classification', () => {
	test('maps the HTTP statuses a provider actually returns', () => {
		const cases: ReadonlyArray<readonly [number, string]> = [
			[401, 'auth'],
			[403, 'auth'],
			[408, 'timeout'],
			[504, 'timeout'],
			[429, 'rate_limit'],
			[404, 'model_not_found'],
			[503, 'unavailable'],
			[500, 'upstream_error'],
			[502, 'upstream_error'],
		];

		for (const [status, expected] of cases) {
			const error = new ProviderError(`request failed with HTTP ${status}`, {
				details: { providerId: 'p', status },
			});
			assert.strictEqual(classifyError(error), expected, `HTTP ${status}`);
		}
	});

	test('400 is context_length only when the message says so', () => {
		assert.strictEqual(
			classifyError(
				new ProviderError('This model maximum context length is 8192 tokens', {
					details: { status: 400 },
				}),
			),
			'context_length',
		);
		assert.strictEqual(
			classifyError(new ProviderError('invalid tool schema', { details: { status: 400 } })),
			'bad_request',
		);
		assert.strictEqual(
			classifyError(new ProviderError('unprocessable', { details: { status: 422 } })),
			'bad_request',
		);
	});

	test('a probe that gave up on its own budget is a timeout, not a cancel', () => {
		// The `/models` timeout wraps an abort: the cause says "aborted", but
		// the owner of the controller knows the abort was a deadline.
		const error = new ProviderError('The model endpoint did not respond within 5000ms', {
			cause: Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }),
			details: { providerId: 'p', abandoned: true },
		});
		assert.strictEqual(classifyError(error), 'timeout');
	});

	test('follows the cause chain to a transport code', () => {
		const refused = new ProviderError('Could not reach the chat endpoint', {
			cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
			details: { providerId: 'p' },
		});
		assert.strictEqual(classifyError(refused), 'network');

		const notFound = new ProviderError('Could not reach the chat endpoint', {
			cause: new TypeError('fetch failed', {
				cause: new AggregateError(
					[Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })],
					'connect',
				),
			}),
			details: { providerId: 'p' },
		});
		assert.strictEqual(classifyError(notFound), 'network');
	});

	test('classifies transport timeouts as timeout', () => {
		const error = new ProviderError('fetch failed', {
			cause: Object.assign(new Error('headers timeout'), {
				code: 'UND_ERR_HEADERS_TIMEOUT',
			}),
		});
		assert.strictEqual(classifyError(error), 'timeout');
	});

	test('a bare abort is cancelled, never timeout', () => {
		const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
		assert.strictEqual(classifyError(abort), 'cancelled');

		const coded = Object.assign(new Error('aborted'), { code: 'ABORT_ERR' });
		assert.strictEqual(classifyError(coded), 'cancelled');

		const undici = Object.assign(new Error('aborted'), { code: 'UND_ERR_ABORTED' });
		assert.strictEqual(classifyError(undici), 'cancelled');
	});

	test('a user stop outranks a provider failure', () => {
		const error = new ProviderError('returned HTTP 500', { details: { status: 500 } });
		assert.strictEqual(classifyError(error, { abortCause: 'user-stop' }), 'cancelled');
	});

	test('a configured budget that ran out is a timeout, whatever the message', () => {
		assert.strictEqual(classifyError(new Error('whatever'), { abortCause: 'first-token' }), 'timeout');
		assert.strictEqual(classifyError(new Error('whatever'), { abortCause: 'total-time' }), 'timeout');
	});

	test('falls back to the message for failures that arrive mid-stream', () => {
		const cases: ReadonlyArray<readonly [string, string]> = [
			['fetch failed', 'network'],
			['other side closed', 'network'],
			['terminated', 'network'],
			['The service is overloaded', 'unavailable'],
			['rate limit exceeded', 'rate_limit'],
			['unauthorized', 'auth'],
			['maximum context length exceeded', 'context_length'],
			['model not found', 'model_not_found'],
			['request timeout', 'timeout'],
			['The response body is not a readable stream', 'internal'],
		];

		for (const [message, expected] of cases) {
			assert.strictEqual(classifyError(new Error(message)), expected, message);
		}
	});

	test('never throws on values that are not errors', () => {
		assert.strictEqual(classifyError(undefined), 'internal');
		assert.strictEqual(classifyError(null), 'internal');
		assert.strictEqual(classifyError('boom'), 'internal');
		assert.strictEqual(classifyError({ status: 500 }), 'internal');
	});

	test('classifyHttpStatus is the single status table', () => {
		assert.strictEqual(classifyHttpStatus(401), 'auth');
		assert.strictEqual(classifyHttpStatus(503), 'unavailable');
		assert.strictEqual(classifyHttpStatus(504), 'timeout');
		assert.strictEqual(classifyHttpStatus(400, 'context length exceeded'), 'context_length');
	});
});

suite('Routing: classification policy', () => {
	test('retries only transient classes on the same candidate', () => {
		const retryable = ['timeout', 'unavailable', 'rate_limit', 'network', 'upstream_error'] as const;
		for (const errorClass of retryable) {
			assert.strictEqual(isRetryableErrorClass(errorClass), true, errorClass);
		}

		const permanent = [
			'auth',
			'bad_request',
			'context_length',
			'cancelled',
			'breaker_open',
			'no_candidate',
			'model_not_found',
			'internal',
		] as const;
		for (const errorClass of permanent) {
			assert.strictEqual(isRetryableErrorClass(errorClass), false, errorClass);
		}
	});

	test('the breaker ignores what the caller caused and what the router produced', () => {
		const ignored = ['cancelled', 'bad_request', 'context_length', 'breaker_open', 'no_candidate'] as const;
		for (const errorClass of ignored) {
			assert.strictEqual(isBreakerIgnored(errorClass), true, errorClass);
		}

		const counted = ['auth', 'timeout', 'network', 'upstream_error', 'rate_limit', 'model_not_found'] as const;
		for (const errorClass of counted) {
			assert.strictEqual(isBreakerIgnored(errorClass), false, errorClass);
		}
	});
});
