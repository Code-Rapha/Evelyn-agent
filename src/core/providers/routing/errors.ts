/**
 * Error classification for routing.
 *
 * One question: given whatever a provider threw, which of the closed set of
 * routing classes is it? The answer decides retry, fallback and whether the
 * breaker counts the failure, so it is read from structured data first and
 * from prose only when there is nothing else.
 *
 * Order matters and is the safety property:
 *
 * 1. A caller-supplied abort cause outranks everything. A stop the user asked
 *    for is a decision, not a provider fault, and must never be retried.
 * 2. A real abort signal is `cancelled` even when its message says "timeout".
 * 3. `ProviderError` carries a status and a cause; both are more specific
 *    than its message.
 * 4. Only then does the message get a say, because mid-stream failures arrive
 *    as plain `Error`s from the SSE parser.
 */
import { ProviderError } from '../../errors';
import { isAbortError } from '../chat/sseStream';
import type { ErrorClass, RoutingAbortCause } from './types';

export interface ClassifyErrorOptions {
	/**
	 * The cause the owner of the abort controller knows.
	 *
	 * The stream itself cannot know it: an aborted fetch and an aborted stream
	 * look identical from the inside, and only the code that armed the timer
	 * can say whether it was a budget or a person.
	 */
	readonly abortCause?: RoutingAbortCause;
}

/** Transport codes that mean the request never reached a usable endpoint. */
const NETWORK_CODES: ReadonlySet<string> = new Set([
	'ECONNREFUSED',
	'ECONNRESET',
	'ENOTFOUND',
	'EAI_AGAIN',
	'EHOSTUNREACH',
	'ENETUNREACH',
	'ECONNABORTED',
	'EPIPE',
	'UND_ERR_SOCKET',
	'UND_ERR_CLOSED',
]);

/** Transport codes that mean a deadline expired. */
const TIMEOUT_CODES: ReadonlySet<string> = new Set([
	'ETIMEDOUT',
	'ESOCKETTIMEDOUT',
	'UND_ERR_CONNECT_TIMEOUT',
	'UND_ERR_HEADERS_TIMEOUT',
	'UND_ERR_BODY_TIMEOUT',
]);

/** Codes that mean somebody aborted on purpose. */
const ABORT_CODES: ReadonlySet<string> = new Set(['ABORT_ERR', 'UND_ERR_ABORTED']);

/**
 * Best-effort class for an HTTP status.
 *
 * Exported because the engine also sees statuses it did not get from a
 * `ProviderError` (a non-streaming response, a probe), and the table must not
 * exist twice.
 */
export function classifyHttpStatus(status: number, message = ''): ErrorClass {
	if (status === 401 || status === 403) {
		return 'auth';
	}
	if (status === 408 || status === 504) {
		return 'timeout';
	}
	if (status === 429) {
		return 'rate_limit';
	}
	if (status === 404) {
		return 'model_not_found';
	}
	if (status === 400 || status === 422) {
		return looksLikeContextLength(message) ? 'context_length' : 'bad_request';
	}
	if (status === 409 || status === 413) {
		return 'bad_request';
	}
	if (status === 503) {
		return 'unavailable';
	}
	if (status >= 500) {
		return 'upstream_error';
	}
	// A 2xx here would be a caller bug, and a 3xx is not something the
	// OpenAI-compatible wire produces. Neither is retryable.
	return 'internal';
}

/**
 * Maps anything a provider threw onto the routing vocabulary.
 *
 * Never throws. A value it cannot understand is `internal`, which is not
 * retryable and is still recorded.
 */
export function classifyError(error: unknown, options: ClassifyErrorOptions = {}): ErrorClass {
	const abortCause = options.abortCause;
	if (abortCause === 'user-stop') {
		return 'cancelled';
	}
	if (
		abortCause === 'first-token' ||
		abortCause === 'idle' ||
		abortCause === 'total-time' ||
		abortCause === 'deadline'
	) {
		return 'timeout';
	}

	if (isAbortError(error)) {
		return 'cancelled';
	}

	if (error instanceof ProviderError) {
		const status = statusOf(error);
		if (status !== undefined) {
			return classifyHttpStatus(status, error.message);
		}
		// The `/models` probe reports its own timeout this way: the cause is an
		// abort, but the abort was a budget, not a decision.
		if (error.details?.abandoned === true) {
			return 'timeout';
		}
		const transport = transportClass(error);
		if (transport !== undefined) {
			return transport;
		}
		return classFromMessage(error.message) ?? 'internal';
	}

	const transport = transportClass(error);
	if (transport !== undefined) {
		return transport;
	}

	if (error instanceof Error) {
		return classFromMessage(error.message) ?? 'internal';
	}

	return 'internal';
}

/**
 * Whether the same candidate is worth another attempt.
 *
 * Configuration problems are excluded on purpose: retrying a bad key or a
 * context that will never fit only spends the user's budget to fail again.
 * Whether a *different* candidate may be tried is a policy question, answered
 * by `RoutePolicy.fallbackOn`, not here.
 */
export function isRetryableErrorClass(errorClass: ErrorClass): boolean {
	return (
		errorClass === 'timeout' ||
		errorClass === 'unavailable' ||
		errorClass === 'rate_limit' ||
		errorClass === 'network' ||
		errorClass === 'upstream_error'
	);
}

/**
 * Whether the breaker must ignore this class.
 *
 * A cancelled request was not the endpoint's fault, a malformed request will
 * fail the same way forever, and a context-length rejection says something
 * about the prompt rather than the model's health. Counting any of them would
 * open the circuit because of the caller. `breaker_open`, `no_candidate` and
 * `budget_exhausted` are produced by the router itself and describe no
 * endpoint at all: a spent budget is not the model failing, and probing it
 * harder would not change that.
 */
export function isBreakerIgnored(errorClass: ErrorClass): boolean {
	return (
		errorClass === 'cancelled' ||
		errorClass === 'bad_request' ||
		errorClass === 'context_length' ||
		errorClass === 'breaker_open' ||
		errorClass === 'budget_exhausted' ||
		errorClass === 'no_candidate'
	);
}

function statusOf(error: ProviderError): number | undefined {
	const value = error.details?.status;
	return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

/**
 * Follows `cause` (and `AggregateError.errors`) for a transport signal.
 *
 * Undici nests the useful code two or three levels down: `fetch failed` wraps
 * an `AggregateError`, whose members carry `ECONNREFUSED` or `ENOTFOUND`.
 * Depth is bounded because a malformed chain may be cyclic.
 */
function transportClass(error: unknown, depth = 0): ErrorClass | undefined {
	if (depth > 4 || error === null || error === undefined) {
		return undefined;
	}
	if (isAbortError(error)) {
		return 'cancelled';
	}
	if (typeof error !== 'object') {
		return undefined;
	}

	const code = (error as { readonly code?: unknown }).code;
	if (typeof code === 'string') {
		const normalized = code.toUpperCase();
		if (ABORT_CODES.has(normalized)) {
			return 'cancelled';
		}
		if (TIMEOUT_CODES.has(normalized)) {
			return 'timeout';
		}
		if (NETWORK_CODES.has(normalized)) {
			return 'network';
		}
	}

	if (error instanceof AggregateError) {
		for (const nested of error.errors) {
			const signal = transportClass(nested, depth + 1);
			if (signal !== undefined) {
				return signal;
			}
		}
	}

	return transportClass((error as { readonly cause?: unknown }).cause, depth + 1);
}

/** Message fallback, for plain errors that escaped the structured paths. */
function classFromMessage(message: string): ErrorClass | undefined {
	const text = message.toLowerCase();

	if (looksLikeContextLength(text)) {
		return 'context_length';
	}
	if (
		text.includes('authentication failed') ||
		text.includes('invalid api key') ||
		text.includes('unauthorized') ||
		text.includes('forbidden') ||
		text.includes('http 401') ||
		text.includes('http 403')
	) {
		return 'auth';
	}
	if (
		text.includes('rate limit') ||
		text.includes('too many requests') ||
		text.includes('http 429')
	) {
		return 'rate_limit';
	}
	if (text.includes('model not found') || text.includes('no such model') || text.includes('http 404')) {
		return 'model_not_found';
	}
	if (
		text.includes('timeout') ||
		text.includes('timed out') ||
		text.includes('deadline exceeded')
	) {
		return 'timeout';
	}
	if (
		text.includes('service unavailable') ||
		text.includes('temporarily unavailable') ||
		text.includes('overloaded') ||
		text.includes('http 503')
	) {
		return 'unavailable';
	}
	if (
		text.includes('fetch failed') ||
		text.includes('network') ||
		text.includes('socket hang up') ||
		text.includes('other side closed') ||
		text === 'terminated'
	) {
		return 'network';
	}
	if (text.includes('upstream') || text.includes('bad gateway') || text.includes('http 500') || text.includes('http 502')) {
		return 'upstream_error';
	}
	if (text.includes('aborted') || text.includes('cancelled') || text.includes('canceled')) {
		return 'cancelled';
	}
	return undefined;
}

function looksLikeContextLength(message: string): boolean {
	const text = message.toLowerCase();
	return (
		text.includes('context length') ||
		text.includes('context window') ||
		text.includes('maximum context') ||
		text.includes('too many tokens') ||
		text.includes('prompt is too long') ||
		text.includes('exceeds the model')
	);
}
