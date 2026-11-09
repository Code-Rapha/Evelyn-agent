/**
 * First concrete provider: any server that speaks the OpenAI `/models` and
 * chat-completions dialect.
 *
 * Design notes:
 *
 * - `fetch` is injected. This module never reaches for the global, so tests
 *   drive it with a fake and no test touches the network.
 * - The API key is resolved from the `SecretStore` at call time using the
 *   descriptor's `apiKeyRef`. The key is optional: servers such as a local
 *   runtime expose `/models` without authentication, and then no `Authorization`
 *   header is sent at all.
 * - No error message, error `details` field or log line ever contains the key.
 *   `ProviderError` messages are built from status codes and endpoint paths only.
 *
 * This module imports neither `vscode` nor any other project module except the
 * error taxonomy and the secret port, keeping it unit-testable in isolation.
 */
import { ProviderError, ValidationError } from '../../errors';
import type { SecretStore } from '../secrets';
import type {
	ModelInfo,
	Provider,
	ProviderCapability,
	ProviderDescriptor,
	ProviderStatus,
} from '../types';
import { AbortedChatStream, SseChatStream, isAbortError, buildChatRequestBody } from '../chat/sseStream';
import type {
	ChatProvider,
	ChatRequest,
	ChatStream,
	ChatStreamEvent,
} from '../chat/types';
import { readPublishedModelFields } from '../discovery/published';
import { parseRetryAfter } from '../quota/headers';

/**
 * The subset of a `ReadableStream` this provider relies on when streaming.
 * Kept structural so tests can drive it with a plain async generator.
 */
export interface ByteStreamLike {
	readonly [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array | string>;
}

/** The response shape this provider needs. */
export interface FetchResponseLike {
	readonly ok: boolean;
	readonly status: number;
	/** Present on streamed responses; absent on a plain one. */
	readonly body?: ByteStreamLike | null;
	/**
	 * Response headers, when the caller's `fetch` exposes them.
	 *
	 * Read for the rate-limit headers and `Retry-After`; a fake that omits it is
	 * treated as "the provider said nothing", which is the honest reading.
	 */
	readonly headers?: HeadersLike;
	text(): Promise<string>;
}

/** The header surface this provider reads. `Headers` and a plain object both fit. */
export interface HeadersLike {
	get(name: string): string | null;
	/** Enumerates the header names; used when `get` is unavailable. */
	forEach?(callback: (value: string, name: string) => void): void;
	/** Iterable form, as `Headers` implements it. */
	entries?(): IterableIterator<[string, string]>;
}

/**
 * The headers that say something about a limit or a window.
 *
 * A response carries many headers, and some of them are credentials in
 * disguise (`set-cookie`, `proxy-authorization`). Only the ones that describe
 * the rate limit are kept, so a header that travels inside an error - and an
 * error is logged - can never carry a secret.
 */
export function quotaHeadersOf(headers: Readonly<Record<string, string>>): Record<string, string> | undefined {
	const kept: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		const lower = name.toLowerCase();
		if (lower === 'retry-after' || lower.startsWith('x-ratelimit-')) {
			kept[lower] = value;
		}
	}
	return Object.keys(kept).length === 0 ? undefined : kept;
}

/**
 * Copies the headers a response exposed into a plain record.
 *
 * Lower-cased keys: HTTP header names are case-insensitive, and every reader
 * downstream compares them that way. A response without a header surface
 * yields `{}` rather than an error - it simply provided no information.
 */
export function readResponseHeaders(response: FetchResponseLike): Record<string, string> {
	const source = response.headers;
	if (source === undefined || source === null) {
		return {};
	}
	const result: Record<string, string> = {};
	try {
		if (typeof source.entries === 'function') {
			for (const [name, value] of source.entries()) {
				result[name.toLowerCase()] = value;
			}
			return result;
		}
		if (typeof source.forEach === 'function') {
			source.forEach((value, name) => {
				result[name.toLowerCase()] = value;
			});
			return result;
		}
	} catch {
		// A header surface that throws on enumeration told us nothing usable.
		return {};
	}
	return result;
}

/** The subset of `fetch` this provider relies on. */
export type FetchLike = (
	input: string,
	init?: {
		method?: string;
		headers?: Record<string, string>;
		body?: string;
		signal?: AbortSignal;
		stream?: boolean;
	},
) => Promise<FetchResponseLike>;

export interface OpenAICompatibleProviderOptions {
	/** Stable provider id, e.g. `local-llm`. Also namespaces the secret ref. */
	readonly id: string;
	readonly name: string;
	/** API root, e.g. `https://api.openai.com/v1`. Required. */
	readonly baseUrl: string;
	/**
	 * Reference to the API key inside the `SecretStore`. When omitted, the
	 * provider sends no authorization header.
	 */
	readonly apiKeyRef?: string;
	readonly enabled?: boolean;
	readonly capabilities?: readonly ProviderCapability[];
	/** Injected for tests; defaults to the global `fetch`. */
	readonly fetch?: FetchLike;
	/**
	 * How long `GET /models` may take before it is given up on.
	 *
	 * Its own budget rather than the turn's, because discovery runs outside any
	 * turn — from the settings window's model picker and from
	 * `listAvailableModels`, which asks every provider in turn. Five seconds is
	 * comfortably longer than a healthy `/models` on a slow connection and short
	 * enough that one silent endpoint cannot hold the whole list. Set it to `0` to
	 * disable the bound, which is only sensible with an external signal.
	 *
	 * Injected in tests so a timeout can be asserted without waiting for it.
	 */
	readonly modelsTimeoutMs?: number;
	/**
	 * Injected for tests; defaults to `Date.now`.
	 *
	 * Exists so the latency measurements can be asserted without a test waiting
	 * on real timings. It reads the wall clock and never the time spent between
	 * two events inside one response, so it cannot be made to look slow.
	 */
	readonly now?: () => number;
	/** Required only when `apiKeyRef` is set. */
	readonly secrets?: SecretStore;
}

interface ModelsResponseShape {
	readonly data?: unknown;
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/**
 * How long `GET /models` may take before it is abandoned.
 *
 * Short enough that one silent endpoint cannot hold up a list of providers, long
 * enough that a healthy server on a slow connection is not cut off. A model list
 * is a cache of ids; waiting longer than this for it buys nothing.
 */
const DEFAULT_MODELS_TIMEOUT_MS = 5_000;

/** Trims trailing slashes so `${baseUrl}/models` never doubles the separator. */
function normalizeBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim();
	if (trimmed.length === 0) {
		throw new ValidationError('baseUrl is required for an OpenAI-compatible provider');
	}
	return trimmed.replace(/\/+$/, '');
}

/**
 * Whether a `/models` failure means the request was *given up on* rather than
 * that the provider *failed*.
 *
 * Two ways, and the caller needs to tell them apart: our own budget ran out
 * (flagged in the error's `details`), or the caller's signal fired (a bare
 * abort). Neither is evidence about the provider — it neither refused nor
 * misbehaved — so neither may mark it broken.
 *
 * Read from the error rather than recomputed at the call site, because the two
 * facts were known where the failure happened and would be indistinguishable
 * afterwards.
 */
function isAbandonedRequest(error: unknown): boolean {
	if (isAbortError(error)) {
		return true;
	}
	if (error instanceof ProviderError) {
		const details = (error as { details?: { abandoned?: unknown } }).details;
		return details?.abandoned === true;
	}
	return false;
}

export class OpenAICompatibleProvider implements Provider, ChatProvider {
	private readonly baseUrl: string;
	private readonly fetchImpl: FetchLike;
	/** The clock behind `timing`. Injected for tests; see the option. */
	private readonly now: () => number;
	/** The `/models` budget. See the option. */
	private readonly modelsTimeoutMs: number;
	private readonly secrets: SecretStore | undefined;
	private readonly apiKeyRef: string | undefined;
	/**
	 * The immutable half of the descriptor. `status` and `models` are supplied
	 * by the getter, so they are deliberately absent here.
	 */
	private readonly base: Omit<ProviderDescriptor, 'status' | 'models'>;

	/**
	 * Reactive status: `configured` until a call succeeds (`available`) or
	 * fails (`error`); `unconfigured` while an expected key is missing.
	 */
	private status: ProviderStatus;
	private models: readonly ModelInfo[];
	/** Headers of the last successful `/models`, for the rate-limit record. */
	private modelsHeaders: Readonly<Record<string, string>> = {};
	/**
	 * Whether calls are allowed at all.
	 *
	 * The flag arrives from persisted configuration and decides it: a disabled
	 * provider refuses every method before it reads a secret or opens a socket.
	 */
	private readonly enabled: boolean;

	/**
	 * Built on read so callers always observe the current status and model
	 * list, and never a stale snapshot taken at construction.
	 */
	get descriptor(): ProviderDescriptor {
		return { ...this.base, status: this.status, models: this.models };
	}

	constructor(options: OpenAICompatibleProviderOptions) {
		this.baseUrl = normalizeBaseUrl(options.baseUrl);

		const injected = options.fetch;
		this.fetchImpl = injected ?? ((input, init) => fetch(input, init));
		this.now = options.now ?? Date.now;
		this.modelsTimeoutMs = options.modelsTimeoutMs ?? DEFAULT_MODELS_TIMEOUT_MS;

		this.secrets = options.secrets;
		this.apiKeyRef = options.apiKeyRef;
		this.enabled = options.enabled ?? true;

		this.status = !this.enabled
			? 'disabled'
			: options.apiKeyRef === undefined
				? 'configured'
				: 'unconfigured';
		this.models = [];

		this.base = {
			id: options.id,
			name: options.name,
			type: 'custom-openai-compatible',
			configuration: {
				baseUrl: this.baseUrl,
				...(options.apiKeyRef !== undefined ? { apiKeyRef: options.apiKeyRef } : {}),
				...(options.enabled !== undefined ? { enabled: options.enabled } : {}),
			},
			capabilities: options.capabilities ?? ['chat'],
		};
	}

	/**
	 * Refuses every call while the provider is disabled.
	 *
	 * The guard sits ahead of `buildHeaders` and `fetchImpl` because these two
	 * methods are the only places in the product that touch the network — so
	 * one check covers model discovery, chat, and every host that reaches
	 * either (extension refresh, desktop "load models", the agent's turn).
	 */
	private requireEnabled(): void {
		if (!this.enabled) {
			throw new ProviderError(`Provider "${this.base.id}" is disabled`, {
				details: { providerId: this.base.id },
			});
		}
	}

	/**
	 * `GET {baseUrl}/models`, mapped to `ModelInfo[]`.
	 *
	 * The response only carries an `id` per model, so the display name is the
	 * id: inventing a friendlier name would misreport what the server called it.
	 *
	 * `options.signal` lets a caller abandon the request. Without one this call
	 * had no bound at all beyond the socket's own, which meant an endpoint that
	 * accepted the connection and then said nothing held the caller for as long
	 * as the platform was willing to wait — and `listAvailableModels` asks every
	 * provider in turn, so one such endpoint froze the whole list.
	 */
	async listModels(
		options: { readonly signal?: AbortSignal } = {},
	): Promise<readonly ModelInfo[]> {
		this.requireEnabled();
		const endpoint = `${this.baseUrl}/models`;

		let models: ModelInfo[];
		let headers: Readonly<Record<string, string>> = {};
		try {
			const requestHeaders = await this.buildHeaders();
			const result = await this.requestModels(endpoint, requestHeaders, options.signal);
			models = result.models;
			headers = result.headers;
		} catch (error) {
			// Every failure mode (auth, HTTP, malformed payload, transport)
			// lands here. The error is rethrown unchanged; only the status moves.
			//
			// Except the two ways the request was *abandoned*: a timeout of our own
			// and the caller's cancellation. Neither is a fact about the provider —
			// it neither refused nor failed — and recording either as `error` would
			// make the next listing inherit a broken verdict from a request somebody
			// gave up on.
			if (!isAbandonedRequest(error)) {
				this.status = 'error';
				this.models = [];
			}
			throw error;
		}

		this.models = models;
		this.modelsHeaders = headers;
		this.status = 'available';
		return models;
	}

	/**
	 * Performs the request and maps the response, without touching status.
	 *
	 * Bounded by `modelsTimeoutMs` on its own, rather than relying on the caller's
	 * signal: model discovery is called from paths that have no turn to abort
	 * (`listAvailableModels`, the settings window's model picker), and a bound
	 * that only exists while somebody is holding a turn is not a bound.
	 *
	 * The external signal is chained in rather than replaced, so a caller that
	 * *does* abandon the request still does — and an abort from either side is
	 * reported as an abort, not as a timeout. That distinction is what keeps a
	 * cancelled discovery from looking like a slow provider.
	 */
	private async requestModels(
		endpoint: string,
		headers: Record<string, string>,
		signal?: AbortSignal,
	): Promise<{ readonly models: ModelInfo[]; readonly headers: Readonly<Record<string, string>> }> {
		const controller = new AbortController();
		// One timer that both records *why* it fired and aborts. Two timers would
		// race: by the time the rejection surfaced, both paths had aborted the same
		// controller and the two would be indistinguishable.
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, this.modelsTimeoutMs);
		const onExternalAbort = (): void => controller.abort();
		if (signal !== undefined) {
			if (signal.aborted) {
				controller.abort();
			} else {
				signal.addEventListener('abort', onExternalAbort, { once: true });
			}
		}

		let response: Awaited<ReturnType<FetchLike>>;
		try {
			response = await this.fetchImpl(endpoint, {
				method: 'GET',
				headers,
				signal: controller.signal,
			});
		} catch (cause) {
			// A timeout here is this module's own budget running out, which is a
			// different fact from the caller's signal firing. Only the first is
			// worth calling a timeout; the second is the caller's decision and is
			// rethrown as-is so it stays an abort upstream.
			if (timedOut && isAbortError(cause)) {
				throw new ProviderError(
					`The model endpoint ${endpoint} did not respond within ${this.modelsTimeoutMs}ms`,
					{
						cause,
						details: {
							providerId: this.base.id,
							endpoint,
							timeoutMs: this.modelsTimeoutMs,
							abandoned: true,
						},
					},
				);
			}
			if (isAbortError(cause)) {
				// The caller abandoned it. Rethrown unwrapped, because an abort is
				// not a provider failure and must not read as one.
				throw cause;
			}
			throw new ProviderError(
				`Could not reach the model endpoint at ${endpoint}`,
				{ cause, details: { providerId: this.base.id, endpoint } },
			);
		} finally {
			clearTimeout(timer);
			if (signal !== undefined) {
				signal.removeEventListener('abort', onExternalAbort);
			}
		}

		if (response.status === 401 || response.status === 403) {
			throw new ProviderError(
				`Authentication failed at ${endpoint} (HTTP ${response.status}). Check the API key for this provider.`,
				{ details: { providerId: this.base.id, status: response.status } },
			);
		}

		if (!response.ok) {
			throw new ProviderError(
				`The model endpoint ${endpoint} returned HTTP ${response.status}`,
				{ details: { providerId: this.base.id, status: response.status } },
			);
		}

		return {
			models: this.parseModels(await response.text(), endpoint),
			headers: readResponseHeaders(response),
		};
	}

	/**
	 * Builds the request headers. The authorization header is added only when a
	 * key reference resolves to a non-empty value; the key itself is never
	 * copied anywhere else.
	 */
	private async buildHeaders(): Promise<Record<string, string>> {
		const headers: Record<string, string> = { accept: 'application/json' };

		const ref = this.apiKeyRef;
		if (ref === undefined) {
			return headers;
		}
		if (this.secrets === undefined) {
			throw new ProviderError(
				`Provider "${this.base.id}" declares an API key reference but no secret store was provided`,
				{ details: { providerId: this.base.id } },
			);
		}

		let key: string | undefined;
		try {
			key = await this.secrets.get(ref);
		} catch (cause) {
			throw new ProviderError(
				`Could not read the stored API key for provider "${this.base.id}"`,
				{ cause, details: { providerId: this.base.id } },
			);
		}

		if (key !== undefined && key.trim().length > 0) {
			headers.authorization = `Bearer ${key}`;
			// A key reference with a stored key moves the provider out of
			// `unconfigured` before the first call is ever attempted.
			this.status = 'configured';
		}
		return headers;
	}

	/**
	 * Starts a streamed chat completion.
	 *
	 * The returned stream is lazy about the socket but eager about the
	 * handshake: HTTP failures, auth failures and a malformed response body are
	 * rejected here, before the caller receives a stream. Once iterating, a
	 * mid-stream failure surfaces as a final `Error` event rather than a throw,
	 * because the consumer has already rendered partial output by then.
	 *
	 * Aborting via `options.signal` ends the stream with `closedReason`
	 * `'aborted'` and is not an error.
	 */
	async streamChat(
		request: ChatRequest,
		options: { readonly signal?: AbortSignal } = {},
	): Promise<ChatStream> {
		this.requireEnabled();
		const endpoint = `${this.baseUrl}/chat/completions`;
		const headers = {
			...(await this.buildHeaders()),
			'content-type': 'application/json',
			accept: 'text/event-stream',
		};

		let response: Awaited<ReturnType<FetchLike>>;
		// Timed from here, around the fetch itself. This is the part a stream
		// cannot measure for itself: it does not exist until the response object
		// does, so a stream timing from its own construction would report the
		// generation and call it the whole request.
		const requestedAt = this.now();
		try {
			response = await this.fetchImpl(endpoint, {
				method: 'POST',
				headers,
				body: JSON.stringify(buildChatRequestBody(request)),
				stream: true,
				...(options.signal !== undefined ? { signal: options.signal } : {}),
			});
		} catch (cause) {
			if (isAbortError(cause)) {
				return new AbortedChatStream();
			}
			throw new ProviderError(
				`Could not reach the chat endpoint at ${endpoint}`,
				{ cause, details: { providerId: this.base.id, endpoint } },
			);
		}

		if (response.status === 401 || response.status === 403) {
			throw new ProviderError(
				`Authentication failed at ${endpoint} (HTTP ${response.status}). Check the API key for this provider.`,
				{ details: { providerId: this.base.id, status: response.status } },
			);
		}
		if (!response.ok) {
			// A rate-limit answer carries the one fact the caller can act on:
			// when to try again. It is read from the header, or from the body's
			// `Retry-After`, and attached as `retryAfterMs` — never guessed.
			const rateLimited = response.status === 429 || response.status === 503;
			const retryAfterMs = rateLimited ? await this.readRetryAfter(response) : undefined;
			// The quota headers ride along on the error, so the host can record
			// what the account had left. Only the rate-limit ones: the error may
			// be logged, and a credential must never end up in a log line.
			const quotaHeaders = rateLimited ? quotaHeadersOf(readResponseHeaders(response)) : undefined;
			throw new ProviderError(
				`The chat endpoint ${endpoint} returned HTTP ${response.status}`,
				{
					details: {
						providerId: this.base.id,
						status: response.status,
						...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
						...(quotaHeaders !== undefined ? { quotaHeaders } : {}),
					},
				},
			);
		}
		if (response.body === undefined || response.body === null) {
			throw new ProviderError(
				`The chat endpoint ${endpoint} returned no stream body`,
				{ details: { providerId: this.base.id } },
			);
		}

		this.status = 'available';
		return new SseChatStream(response.body, options.signal, {
			requestedAt,
			now: this.now,
			headers: readResponseHeaders(response),
		});
	}

	/**
	 * How long to wait before retrying, from a rate-limit response.
	 *
	 * The header is authoritative when present. Some proxies only put it in the
	 * body (`{"error":{"retry_after":…}}` or `{"Retry-After":…}`); that is read
	 * as a fallback. A body that cannot be parsed yields `undefined`: an
	 * invented wait would make the router sleep for a number nobody published,
	 * and any number in a read error is better than none.
	 */
	private async readRetryAfter(response: FetchResponseLike): Promise<number | undefined> {
		const headers = readResponseHeaders(response);
		const fromHeader = parseRetryAfter(headers['retry-after'], this.now());
		if (fromHeader !== undefined) {
			return fromHeader;
		}
		let body: string;
		try {
			body = await response.text();
		} catch {
			return undefined;
		}
		if (body.trim().length === 0) {
			return undefined;
		}
		let payload: unknown;
		try {
			payload = JSON.parse(body);
		} catch {
			return undefined;
		}
		const asRecord = (value: unknown): Record<string, unknown> | undefined =>
			typeof value === 'object' && value !== null && !Array.isArray(value)
				? (value as Record<string, unknown>)
				: undefined;
		const root = asRecord(payload);
		const error = asRecord(root?.['error']);
		const candidate =
			error?.['retry_after'] ??
			error?.['retryAfter'] ??
			root?.['retry_after'] ??
			root?.['Retry-After'];
		if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) {
			return candidate * 1_000;
		}
		return typeof candidate === 'string' ? parseRetryAfter(candidate, this.now()) : undefined;
	}

	/** The headers of the last `/models` response, lower-cased. */
	get lastResponseHeaders(): Readonly<Record<string, string>> {
		return this.modelsHeaders;
	}

	/** Parses `{ data: [{ id }] }`, rejecting anything else. */	private parseModels(body: string, endpoint: string): ModelInfo[] {
		const providerId = this.base.id;
		let payload: unknown;
		try {
			payload = JSON.parse(body);
		} catch (cause) {
			throw new ProviderError(
				`The model endpoint ${endpoint} returned a response that is not valid JSON`,
				{ cause, details: { providerId } },
			);
		}

		const data = (payload as ModelsResponseShape | null)?.data;
		if (!Array.isArray(data)) {
			throw new ProviderError(
				`The model endpoint ${endpoint} returned JSON without a "data" array`,
				{ details: { providerId } },
			);
		}

		const models: ModelInfo[] = [];
		for (const entry of data) {
			const id = (entry as { id?: unknown } | null)?.id;
			if (typeof id !== 'string' || id.length === 0) {
				throw new ProviderError(
					`The model endpoint ${endpoint} returned a model entry without a usable "id"`,
					{ details: { providerId } },
				);
			}
			const published = readPublishedModelFields(entry);
			models.push({
				id,
				name: id,
				...(published.contextTokens !== undefined ? { contextWindow: published.contextTokens } : {}),
				...(published.maxOutputTokens !== undefined
					? { maxOutputTokens: published.maxOutputTokens }
					: {}),
				...(published.capabilities !== undefined
					? { modelCapabilities: published.capabilities }
					: {}),
				...(published.pricing !== undefined ? { pricing: published.pricing } : {}),
				...(published.created !== undefined ? { created: published.created } : {}),
			});
		}
		return models;
	}
}

export { DEFAULT_BASE_URL };