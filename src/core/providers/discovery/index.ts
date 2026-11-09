/**
 * Model discovery: a short-lived, in-memory cache over `GET /models`.
 *
 * ## What it is, and what it is not
 *
 * This is a *view* of what each endpoint currently advertises. It is not the
 * catalog: nothing here is written to disk, and nothing here says what a model
 * costs, which capabilities it has, how large its context is or whether it
 * accepts images. A discovery answer is a list of ids and nothing else, so it
 * cannot become an opinion about a model by accident.
 *
 * The catalog keeps what the user declared and what real runs measured. Mixing
 * a transient HTTP response into it would make a server's momentary list look
 * like a permanent fact — a model pulled for maintenance would keep a stale
 * price recorded against it, and a re-added model would inherit the old one.
 *
 * ## Why a cache at all
 *
 * Every turn asks for available models, and every provider list in the settings
 * window asks again. Without a cache each turn pays one HTTP round trip per
 * provider — usually to a local server that may not even be running — before it
 * can choose a model. With it, the first turn pays and the next ones do not.
 *
 * ## The rules that matter
 *
 * - **Keyed by endpoint.** The key is built by the caller from the provider id
 *   and the endpoint it points at, so two providers on the same server get
 *   separate entries and editing a base URL cannot serve the old answer under
 *   the new one.
 * - **One request per key at a time.** Concurrent callers share the discovery
 *   already in flight instead of each opening a socket.
 * - **A stale answer is better than none, within bounds.** If a refresh fails
 *   and an earlier answer is still within `staleIfErrorMs`, that answer is
 *   served and the result says it is stale. Past the bound, the failure is
 *   reported.
 * - **One provider's failure is its own.** Nothing here may empty another
 *   provider's cache.
 * - **No credentials anywhere.** The key never enters this module: the provider
 *   adds it to the request, and what is cached is the list of ids.
 *
 * ## Cancellation is per caller, but the request is shared
 *
 * A shared request cannot be aborted by whichever caller loses interest first:
 * the others still want the answer. Each caller waits on the shared promise
 * through its own signal, so a caller that walks away gets a prompt rejection
 * while the one request keeps going for everybody else. A shared discovery no
 * caller is waiting for any more is aborted, so it cannot outlive its purpose.
 */
import { ProviderError } from '../../errors';

/** What discovery needs from a provider. `OpenAICompatibleProvider` satisfies it. */
export interface ModelListSource {
	/**
	 * Identifies both the provider and the endpoint its models come from.
	 *
	 * Built outside this module because only the caller knows the configuration
	 * the ids belong to. It must never contain a credential.
	 */
	readonly discoveryKey: string;
	listModels(options?: {
		readonly signal?: AbortSignal;
	}): Promise<readonly { readonly id: string }[]>;
}

export interface ModelDiscoveryOptions {
	/**
	 * How long an answer is served without asking again. Default 60 seconds.
	 *
	 * Short on purpose: a model list changes rarely, and a minute is long
	 * enough to cover the burst of turns and settings lists that follow each
	 * other, short enough that a model the user just pulled shows up. `0`
	 * disables reuse entirely.
	 */
	readonly ttlMs?: number;
	/**
	 * How far past expiry an answer may still be served *after a failed
	 * refresh*, and never further. Default 15 minutes.
	 *
	 * The failure is always reported to the caller next to the stale answer;
	 * this never hides it, it only makes the list still usable. Past this
	 * bound the cache is no longer evidence of anything.
	 */
	readonly staleIfErrorMs?: number;
	/**
	 * How many providers may be refreshed at once. Default 3.
	 *
	 * Providers are independent, so waiting for them one at a time makes the
	 * slowest one set the cost of the list. Firing every one at once is the
	 * other extreme: on a list that mixes a local server and several remote
	 * endpoints, it opens a burst of sockets and lets one dead host compete
	 * for connections with the ones that work.
	 */
	readonly concurrency?: number;
	/** Injected in tests so expiry is asserted without sleeping. */
	readonly now?: () => number;
}

/** One provider's current answer. */
export interface DiscoveryResult {
	/** The cache key the answer belongs to. */
	readonly key: string;
	/** The model ids exactly as the endpoint reported them, in its order. */
	readonly models: readonly string[];
	/** When the answer actually arrived from the provider. */
	readonly fetchedAtMs: number;
	/** Served from an expired entry because the refresh failed. */
	readonly stale: boolean;
}

/** A provider whose discovery failed and had nothing usable to fall back on. */
export interface DiscoveryFailure {
	readonly key: string;
	readonly error: unknown;
}

export const DEFAULT_DISCOVERY_TTL_MS = 60_000;
export const DEFAULT_DISCOVERY_STALE_IF_ERROR_MS = 15 * 60_000;
export const DEFAULT_DISCOVERY_CONCURRENCY = 3;

export interface ModelDiscovery {
	/** One source, from cache or from the provider. Rejects only when nothing can be served. */
	query(source: ModelListSource, options?: { readonly signal?: AbortSignal }): Promise<DiscoveryResult>;
	/** Many keys at once, bounded and independent; failures are carried per key. */
	queryMany(
		keys: readonly string[],
		sources: ReadonlyMap<string, ModelListSource>,
		options?: { readonly signal?: AbortSignal },
	): Promise<readonly (DiscoveryResult | DiscoveryFailure)[]>;
	/**
	 * Forgets what is cached for one key, or for all of them.
	 *
	 * A discovery already in flight is aborted as well, so a refresh asked for
	 * right after an edit cannot be answered by a request started before it.
	 * Callers waiting on it see a cancellation — that is what "forget this"
	 * means for them — and the next query starts a fresh request.
	 */
	invalidate(key?: string): void;
	/** Test and status seam: the keys currently cached, with when they arrived. */
	snapshot(): readonly { readonly key: string; readonly fetchedAtMs: number }[];
	/** Resolves once no discovery is in flight. Never rejects. */
	settled(): Promise<void>;
}

/** Marks the abort of a request cancelled because it was forgotten. */
export class DiscoveryInvalidatedError extends ProviderError {
	constructor(key: string) {
		super(`Model discovery for "${key}" was invalidated`, {
			details: { key, invalidated: true },
		});
		this.name = 'DiscoveryInvalidatedError';
	}
}

/** Marks the abort of a request cancelled because nobody is waiting for it. */
export class DiscoveryAbandonedError extends ProviderError {
	constructor(key: string) {
		super(`Model discovery for "${key}" was abandoned by every caller`, {
			details: { key, abandoned: true },
		});
		this.name = 'DiscoveryAbandonedError';
	}
}

function abortError(signal: AbortSignal): Error {
	const reason: unknown = signal.reason;
	if (reason instanceof Error) {
		return reason;
	}
	const error = new Error('The model discovery was cancelled');
	error.name = 'AbortError';
	return error;
}

interface Entry {
	readonly models: readonly string[];
	readonly fetchedAtMs: number;
}

interface Flight {
	/** Settles for everyone waiting on the request, never for one caller alone. */
	readonly promise: Promise<readonly string[]>;
	/** Aborts the request. Used when it has no callers left or was forgotten. */
	readonly abort: (reason: Error) => void;
	readonly settled: Promise<void>;
	/** How many callers are still waiting. */
	waiters: number;
	/**
	 * Set while the flight was forgotten, so the aborted request is reported
	 * as an invalidation rather than as the provider failing.
	 */
	forgottenWith: Error | undefined;
}

export function createModelDiscovery(options: ModelDiscoveryOptions = {}): ModelDiscovery {
	const ttlMs = Math.max(0, options.ttlMs ?? DEFAULT_DISCOVERY_TTL_MS);
	const staleIfErrorMs = Math.max(0, options.staleIfErrorMs ?? DEFAULT_DISCOVERY_STALE_IF_ERROR_MS);
	const concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_DISCOVERY_CONCURRENCY));
	const now = options.now ?? (() => Date.now());

	const cache = new Map<string, Entry>();
	const flights = new Map<string, Flight>();

	const startFlight = (key: string, source: ModelListSource): Flight => {
		const controller = new AbortController();
		let resolveSettled: () => void = () => undefined;
		const settled = new Promise<void>((resolve) => {
			resolveSettled = resolve;
		});

		const promise = (async (): Promise<readonly string[]> => {
			const models = await source.listModels({ signal: controller.signal });
			// Exact ids, in the order the server gave them. Nothing is renamed,
			// normalized or de-duplicated into a different identifier.
			return models.map((model) => model.id);
		})();
		// The shared promise has usually no single owner: a flight can be
		// aborted after its last waiter left, and `settled` above observes the
		// outcome without collecting it. This marks it handled, so an abort
		// never surfaces as an unhandled rejection; the `waitFor` handlers
		// below are what decide each caller's fate.
		void promise.catch(() => undefined);
		void promise.then(
			() => resolveSettled(),
			() => resolveSettled(),
		);

		const flight: Flight = {
			promise,
			abort: (reason) => {
				if (controller.signal.aborted) {
					return;
				}
				// `AbortController.abort` runs every listener synchronously, so a
				// source whose listener throws would make `invalidate` throw at
				// its caller. A cancelled request is a normal outcome here; it is
				// never the caller's problem.
				try {
					controller.abort(reason);
				} catch {
					// The request is stopped regardless of what a listener did.
				}
			},
			settled,
			waiters: 0,
			forgottenWith: undefined,
		};
		return flight;
	};

	/**
	 * Waits on a shared request, or rejects as soon as this caller's own signal
	 * fires. The shared request is aborted only when it has no callers left,
	 * or when it was forgotten.
	 */
	const waitFor = (key: string, flight: Flight, signal: AbortSignal | undefined): Promise<readonly string[]> =>
		new Promise<readonly string[]>((resolve, reject) => {
			let done = false;
			flight.waiters += 1;
			const finish = (settle: () => void): void => {
				if (done) {
					return;
				}
				done = true;
				flight.waiters -= 1;
				if (signal !== undefined) {
					signal.removeEventListener('abort', onAbort);
				}
				settle();
				if (flight.waiters === 0 && flights.get(key) === flight) {
					// Nobody wants this answer any more.
					flight.abort(new DiscoveryAbandonedError(key));
				}
			};
			const onAbort = (): void => {
				finish(() => reject(abortError(signal as AbortSignal)));
			};

			if (signal !== undefined) {
				if (signal.aborted) {
					onAbort();
					return;
				}
				signal.addEventListener('abort', onAbort, { once: true });
			}
			flight.promise.then(
				(value) => finish(() => resolve(value)),
				(error: unknown) => finish(() => reject(flight.forgottenWith ?? error)),
			);
		});

	const query = async (
		source: ModelListSource,
		options: { readonly signal?: AbortSignal } = {},
	): Promise<DiscoveryResult> => {
		const signal = options.signal;
		if (signal?.aborted === true) {
			throw abortError(signal);
		}
		const key = source.discoveryKey;
		if (typeof key !== 'string' || key.length === 0) {
			throw new ProviderError('A model source without a discovery key cannot be cached', {
				details: {},
			});
		}

		const cached = cache.get(key);
		if (cached !== undefined && now() - cached.fetchedAtMs < ttlMs) {
			return { key, models: cached.models, fetchedAtMs: cached.fetchedAtMs, stale: false };
		}

		let flight = flights.get(key);
		if (flight === undefined) {
			flight = startFlight(key, source);
			flights.set(key, flight);
			const own = flight;
			void own.settled.then(() => {
				if (flights.get(key) === own) {
					flights.delete(key);
				}
			});
		}

		try {
			const models = await waitFor(key, flight, signal);
			const fetchedAtMs = now();
			cache.set(key, { models, fetchedAtMs });
			return { key, models, fetchedAtMs, stale: false };
		} catch (error) {
			if (signal !== undefined && signal.aborted) {
				throw signal.reason instanceof Error ? signal.reason : abortError(signal);
			}
			if (
				cached !== undefined &&
				staleIfErrorMs > 0 &&
				now() - cached.fetchedAtMs <= ttlMs + staleIfErrorMs
			) {
				return { key, models: cached.models, fetchedAtMs: cached.fetchedAtMs, stale: true };
			}
			throw error;
		}
	};

	const queryMany: ModelDiscovery['queryMany'] = async (keys, sources, queryOptions = {}) => {
		// A caller that cancels wants nothing, not a short list: the answer
		// would be indistinguishable from "these endpoints advertise nothing".
		// So its own signal wins over per-key isolation.
		const signal = queryOptions.signal;
		const results: (DiscoveryResult | DiscoveryFailure)[] = new Array(keys.length);
		let next = 0;
		const work = async (): Promise<void> => {
			while (next < keys.length) {
				if (signal?.aborted === true) {
					return;
				}
				const index = next;
				next += 1;
				const key = keys[index] as string;
				const source = sources.get(key);
				if (source === undefined) {
					results[index] = {
						key,
						error: new ProviderError(`No model source is registered for "${key}"`, {
							details: { key },
						}),
					};
					continue;
				}
				try {
					results[index] = await query(source, queryOptions);
				} catch (error) {
					// Per key, on purpose: one dead endpoint must not erase the
					// others' answers or fail the call that contains them.
					results[index] = { key, error };
				}
			}
		};
		await Promise.all(Array.from({ length: Math.min(concurrency, keys.length) }, work));
		if (signal?.aborted === true) {
			throw abortError(signal);
		}
		return results;
	};

	const invalidate = (key?: string): void => {
		if (key === undefined) {
			cache.clear();
			for (const pending of [...flights.values()]) {
				const reason = new DiscoveryInvalidatedError('*');
				pending.forgottenWith = reason;
				pending.abort(reason);
			}
			return;
		}
		cache.delete(key);
		const flight = flights.get(key);
		if (flight !== undefined) {
			const reason = new DiscoveryInvalidatedError(key);
			// The request itself is no longer wanted: it was started before the
			// configuration changed, so its answer belongs to the old one. The
			// waiters already attached learn it was forgotten rather than that
			// the endpoint failed.
			flight.forgottenWith = reason;
			flight.abort(reason);
		}
	};

	const settleAll = (): readonly Promise<void>[] => [...flights.values()].map((flight) => flight.settled);

	const settled = async (): Promise<void> => {
		// A flight that ends while this loop is running is awaited in the next
		// pass, so "settled" means the map is empty rather than "was empty once".
		while (flights.size > 0) {
			await Promise.all(settleAll());
		}
	};

	const snapshot = (): readonly { readonly key: string; readonly fetchedAtMs: number }[] =>
		[...cache].map(([key, entry]) => ({ key, fetchedAtMs: entry.fetchedAtMs }));

	return { query, queryMany, invalidate, snapshot, settled };
}
