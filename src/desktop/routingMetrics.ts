/**
 * The routing metrics port the desktop host wires into a session.
 *
 * ## One port, two vocabularies, no third store
 *
 * The engine speaks in *attempts*: one record per try, with its outcome class,
 * its budgets, its retry/fallback flags and whatever timing and usage the
 * provider exposed. The catalog speaks in *observations*: a bounded window of
 * measured requests per `(provider, model)`, which is what the selector and the
 * settings form read.
 *
 * This module is the bridge and nothing more. It does not keep a second list of
 * measurements, does not aggregate, and does not own a file. The aggregated
 * per-model numbers stay the store's (`recordModelObservation`); the per-attempt
 * detail stays the engine's (`RouteAttempt`). Writing attempt records into the
 * catalog would flatten two different things into one, and reading an
 * observation back out as if it were an attempt would lose the outcome.
 *
 * ## What is written, and what is deliberately not
 *
 * An observation is written only for an attempt that **succeeded**. A failure, a
 * timeout, a cancellation or a skipped candidate measured something other than a
 * model answering — the breaker, the budget, the user — and folding those
 * durations into the median would drag a model's latency towards a speed it
 * never reached. (An immediate `503` is the clearest case: it is fast, and it is
 * not the model being fast.)
 *
 * Those attempts are still counted exactly once each, with their error class and
 * their budgets, in the per-attempt record the engine publishes. Reliability is
 * read from there and from the orchestration log; the catalog stays a record of
 * how long an answer took.
 *
 * ## Absent stays absent
 *
 * Every field is copied only when it was measured. There is no `?? 0` anywhere:
 * a request whose headers never landed has no `firstByteMs`, and a provider that
 * reported no `usage` has none either. `headersMs` is stored as
 * `ModelObservation.firstByteMs` because they are the same instant — the
 * response object appearing — and the stored field's name is historical.
 *
 * ## A write failure is never a turn failure
 *
 * The engine already swallows a port that throws, and this port swallows its own
 * failures as well. Missing measurements must not turn a delivered answer into
 * an error, and `onFailure` exists so the loss is at least visible in a log.
 *
 * ## The window closes with the route, not with the answer
 *
 * The engine publishes the attempt while the route is ending, so the write outlives
 * the stream the consumer is reading. `settled()` is what lets the session wait
 * for it in its own `finally`: by the time a turn is over, every measurement it
 * produced has either landed or been reported as lost. It never rejects, because
 * a measurement nobody could store is not an error to hand to a caller.
 */
import type {
	ModelCatalogKey,
	ModelCatalogPort,
	ModelObservation,
} from '../core/storage/types/modelCatalog';
import type { RouteAttempt, RoutingMetricsPort } from '../core/providers/routing/types';

/** The observation shape `recordModelObservation` accepts. */
export type ObservationInput = Omit<ModelObservation, 'at'> & { readonly at?: string };

/** What the port writes into, and where a write failure is reported. */
export interface CatalogMetricsPortOptions {
	/**
	 * The existing catalog. Narrowed to the one method this port calls, so a
	 * test can pass a stub without implementing the whole `ModelCatalogPort`.
	 */
	readonly catalog: Pick<ModelCatalogPort, 'recordModelObservation'>;
	/** Called when a write fails. Must not throw; the port guards the call. */
	readonly onFailure?: (error: unknown) => void;
}

/**
 * The one attempt-to-observation rule, as a pure function.
 *
 * Exported so the rule can be asserted without a store, which is where the
 * "failures are not latency" decision is easiest to keep honest.
 */
export function toModelObservation(attempt: RouteAttempt): ObservationInput | undefined {
	if (attempt.outcome !== 'success') {
		return undefined;
	}
	const observation: ObservationInput = {
		...(attempt.headersMs !== undefined ? { firstByteMs: attempt.headersMs } : {}),
		...(attempt.totalMs !== undefined ? { totalMs: attempt.totalMs } : {}),
		...(attempt.usage !== undefined ? { usage: attempt.usage } : {}),
	};
	// A record carrying nothing is not a measurement, and appending it would
	// inflate the observation count the selector scores. It should not happen —
	// a success always measures a total — but the guard is what makes that a
	// property of this function rather than of the engine's arithmetic.
	if (
		observation.firstByteMs === undefined &&
		observation.totalMs === undefined &&
		observation.usage === undefined
	) {
		return undefined;
	}
	return observation;
}

/**
 * Builds the port a `ChatSession` hands to its routed providers.
 *
 * One instance per session, so the same object serves every turn. The catalog
 * behind it is the store, so the observations outlive the session by
 * construction rather than by anything this module does.
 *
 * The returned object is the ordinary `RoutingMetricsPort` the engine knows,
 * plus `settled()`, which the session awaits once a turn is over. That one extra
 * method is the difference between "the write was started" and "the measurement
 * is stored", and it is why the session does not have to sleep, poll or hope.
 */
export type CatalogMetricsPort = RoutingMetricsPort & {
	/** Resolves once every write started so far has finished or failed. */
	settled(): Promise<void>;
};

export function createCatalogMetricsPort(options: CatalogMetricsPortOptions): CatalogMetricsPort {
	// Every write is tracked, so the session can wait for all of them at the end
	// of a turn without knowing which attempts produced one.
	const pending = new Set<Promise<void>>();

	const write = async (attempt: RouteAttempt): Promise<void> => {
		try {
			const observation = toModelObservation(attempt);
			if (observation === undefined) {
				return;
			}
			const key: ModelCatalogKey = {
				providerId: attempt.providerId,
				modelId: attempt.modelId,
			};
			await options.catalog.recordModelObservation(key, observation);
		} catch (error) {
			// Deliberately swallowed. The engine would catch a throw from here
			// anyway; doing it locally means the failure is reported once,
			// with a caller that knows what it was writing.
			try {
				options.onFailure?.(error);
			} catch {
				// An observer that throws while reporting a failure must not
				// become the failure.
			}
		}
	};

	return {
		recordAttempt(attempt: RouteAttempt): Promise<void> {
			const writePromise = write(attempt);
			pending.add(writePromise);
			// Removed on completion so a long session does not accumulate every
			// promise it has ever made.
			void writePromise.then(
				() => pending.delete(writePromise),
				() => pending.delete(writePromise),
			);
			return writePromise;
		},
		async settled(): Promise<void> {
			// A write started by a previous pass is awaited here; a write that
			// fails is already turned into a report inside `write`, so awaiting
			// it cannot reject.
			while (pending.size > 0) {
				await Promise.all([...pending]);
			}
		},
	};
}
