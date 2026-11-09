/**
 * The routing metrics port, on its own.
 *
 * What this file pins: the mapping from an attempt to a catalog observation,
 * the rule that only an answered attempt becomes a latency, and the promise
 * that no metrics failure reaches the turn it was describing.
 */
import * as assert from 'assert';
import { describe, it } from 'mocha';

import type {
	ModelCatalogEntry,
	ModelCatalogKey,
	ModelCatalogPort,
} from '../core/storage/types/modelCatalog';
import type { RouteAttempt } from '../core/providers/routing/types';
import {
	createCatalogMetricsPort,
	toModelObservation,
	type ObservationInput,
} from '../desktop/routingMetrics';

/** One attempt as the engine publishes it, with the fields a test cares about. */
function attempt(overrides: Partial<RouteAttempt> = {}): RouteAttempt {
	return {
		requestId: 'route-1',
		providerId: 'atria',
		modelId: 'model-a',
		sequence: 1,
		startedAtMs: 1_000,
		retry: false,
		fallback: false,
		outcome: 'success',
		...overrides,
	};
}

interface Write {
	readonly key: ModelCatalogKey;
	readonly observation: ObservationInput;
}

/** A catalog that records what it was asked to store, or fails on demand. */
function stubCatalog(writes: Write[], failure?: Error): Pick<ModelCatalogPort, 'recordModelObservation'> {
	return {
		async recordModelObservation(key, observation): Promise<ModelCatalogEntry> {
			if (failure !== undefined) {
				throw failure;
			}
			writes.push({ key, observation });
			// The port never reads the returned entry; a stub does not have to
			// build one.
			return undefined as unknown as ModelCatalogEntry;
		},
	};
}

/** The fields an observation may carry. Anything else would be a leak. */
const OBSERVATION_FIELDS = new Set(['at', 'firstByteMs', 'totalMs', 'usage']);
const USAGE_FIELDS = new Set(['promptTokens', 'completionTokens', 'totalTokens', 'reasoningTokens']);

describe('routingMetrics', () => {
	describe('toModelObservation', () => {
		it('records what a successful attempt measured', () => {
			const observation = toModelObservation(
				attempt({
					headersMs: 40,
					totalMs: 12_040,
					firstVisibleEventMs: 900,
					usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
				}),
			);

			assert.deepStrictEqual(observation, {
				// `headersMs` lands in the field the catalog already stores; they
				// are the same instant and the stored name is historical.
				firstByteMs: 40,
				totalMs: 12_040,
				usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
			});
		});

		it('does not confuse the connection time with the first visible event', () => {
			// The specific error `headersMs` exists to prevent: a proxy that
			// answers in 40ms and then thinks for twelve seconds. The stored
			// first-byte reading is the 40, and nothing here is the 12_000.
			const observation = toModelObservation(
				attempt({ headersMs: 40, firstVisibleEventMs: 12_000, totalMs: 12_100 }),
			);
			assert.strictEqual(observation?.firstByteMs, 40);
			assert.strictEqual(observation?.totalMs, 12_100);
			assert.strictEqual(observation?.usage, undefined);
		});

		it('leaves an unmeasured reading absent rather than zero', () => {
			// No headers landed, so there is no first-byte time. A `0` would
			// read as an instant connection.
			const observation = toModelObservation(attempt({ totalMs: 500 }));
			assert.ok(observation !== undefined);
			assert.strictEqual('firstByteMs' in observation, false);
			assert.strictEqual('usage' in observation, false);
			assert.strictEqual(observation.totalMs, 500);
		});

		it('does not carry usage the provider never reported', () => {
			const observation = toModelObservation(attempt({ headersMs: 5, totalMs: 100 }));
			assert.strictEqual(observation?.usage, undefined);
		});

		it('carries a zero the provider really measured', () => {
			// Absent and zero are different things, and a real zero survives.
			const observation = toModelObservation(attempt({ headersMs: 0, totalMs: 0 }));
			assert.strictEqual(observation?.firstByteMs, 0);
			assert.strictEqual(observation?.totalMs, 0);
		});

		it('writes nothing for a failed attempt', () => {
			const observation = toModelObservation(
				attempt({ outcome: 'failure', errorClass: 'unavailable', httpStatus: 503, totalMs: 120 }),
			);
			assert.strictEqual(observation, undefined);
		});

		it('writes nothing for a timeout, even though it measured a total', () => {
			// The engine records the elapsed budget on a timer-cut attempt. That
			// is not the model's latency, and folding it in would make a model
			// that never answered look fast.
			const observation = toModelObservation(
				attempt({ outcome: 'failure', errorClass: 'timeout', abortCause: 'first-token', ttfbMs: 60_000, totalMs: 60_000 }),
			);
			assert.strictEqual(observation, undefined);
		});

		it('writes nothing for a cancellation', () => {
			const observation = toModelObservation(
				attempt({ outcome: 'cancelled', abortCause: 'user-stop' }),
			);
			assert.strictEqual(observation, undefined);
		});

		it('writes nothing for a candidate the breaker skipped', () => {
			const observation = toModelObservation(
				attempt({ outcome: 'skipped', errorClass: 'breaker_open', retryAfterMs: 1_000 }),
			);
			assert.strictEqual(observation, undefined);
		});

		it('writes nothing when a success measured nothing at all', () => {
			// Defensive: an empty record is not a measurement, and appending one
			// would inflate the observation count the selector scores.
			assert.strictEqual(toModelObservation(attempt({})), undefined);
		});
	});

	describe('createCatalogMetricsPort', () => {
		it('writes one observation per successful attempt, keyed by the pair', async () => {
			const writes: Write[] = [];
			const port = createCatalogMetricsPort({ catalog: stubCatalog(writes) });

			await port.recordAttempt(attempt({ headersMs: 30, totalMs: 3_030 }));

			assert.strictEqual(writes.length, 1);
			assert.deepStrictEqual(writes[0].key, { providerId: 'atria', modelId: 'model-a' });
			assert.deepStrictEqual(writes[0].observation, { firstByteMs: 30, totalMs: 3_030 });
		});

		it('writes exactly one record for a mixed sequence of attempts', async () => {
			// Four attempts, one of which answered. Only the answered one is a
			// latency; the other three are counted where they belong — in the
			// per-attempt records the engine publishes.
			const writes: Write[] = [];
			const port = createCatalogMetricsPort({ catalog: stubCatalog(writes) });

			await Promise.all([
				port.recordAttempt(attempt({ sequence: 1, outcome: 'failure', errorClass: 'unavailable' })),
				port.recordAttempt(attempt({ sequence: 2, outcome: 'failure', errorClass: 'timeout' })),
				port.recordAttempt(attempt({ sequence: 3, outcome: 'cancelled' })),
				port.recordAttempt(attempt({ sequence: 4, headersMs: 10, totalMs: 1_010 })),
			]);

			assert.strictEqual(writes.length, 1, 'only the answered attempt is a latency');
			assert.deepStrictEqual(writes[0].observation, { firstByteMs: 10, totalMs: 1_010 });
		});

		it('lets the store stamp the time rather than inventing one', async () => {
			const writes: Write[] = [];
			const port = createCatalogMetricsPort({ catalog: stubCatalog(writes) });
			await port.recordAttempt(attempt({ totalMs: 10 }));
			assert.strictEqual('at' in (writes[0].observation as object), false);
		});

		it('carries no field beyond the measurement itself', async () => {
			// The attempt names a provider and a model; it does not name a
			// prompt, a key or a header. The observation must not either.
			const writes: Write[] = [];
			const port = createCatalogMetricsPort({ catalog: stubCatalog(writes) });
			await port.recordAttempt(
				attempt({
					headersMs: 1,
					totalMs: 2,
					usage: { totalTokens: 3 },
					firstVisibleEventMs: 1,
					httpStatus: 200,
					retry: true,
					fallback: true,
				}),
			);

			const observation = writes[0].observation as Record<string, unknown>;
			for (const field of Object.keys(observation)) {
				assert.ok(OBSERVATION_FIELDS.has(field), `unexpected field ${field}`);
			}
			for (const field of Object.keys(observation.usage as Record<string, unknown>)) {
				assert.ok(USAGE_FIELDS.has(field), `unexpected usage field ${field}`);
			}
			assert.strictEqual('httpStatus' in observation, false);
		});

		it('does not let a failing catalog reach the caller', async () => {
			const failures: unknown[] = [];
			const port = createCatalogMetricsPort({
				catalog: stubCatalog([], new Error('the disk is full')),
				onFailure: (error) => failures.push(error),
			});

			await assert.doesNotReject(async () => port.recordAttempt(attempt({ totalMs: 1 })));
			assert.strictEqual(failures.length, 1);
			assert.match(String((failures[0] as Error).message), /disk is full/);
		});

		it('does not let a failing observer become the failure', async () => {
			const port = createCatalogMetricsPort({
				catalog: stubCatalog([], new Error('nope')),
				onFailure: () => {
					throw new Error('the reporter is broken too');
				},
			});

			await assert.doesNotReject(async () => port.recordAttempt(attempt({ totalMs: 1 })));
		});

		it('resolves without a catalog write when there is nothing to record', async () => {
			const writes: Write[] = [];
			const port = createCatalogMetricsPort({ catalog: stubCatalog(writes) });
			await port.recordAttempt(attempt({ outcome: 'failure', errorClass: 'network' }));
			assert.strictEqual(writes.length, 0);
		});

		it('settles only once the write has landed', async () => {
			// The session waits on this at the end of a turn, so it has to mean
			// "stored", not "started". A catalog that answers late makes the
			// difference visible.
			const writes: Write[] = [];
			let release: (() => void) | undefined;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const port = createCatalogMetricsPort({
				catalog: {
					async recordModelObservation(key, observation): Promise<ModelCatalogEntry> {
						await gate;
						writes.push({ key, observation });
						return undefined as unknown as ModelCatalogEntry;
					},
				},
			});

			void port.recordAttempt(attempt({ totalMs: 5 }));
			let settled = false;
			const waiting = port.settled().then(() => {
				settled = true;
			});
			await new Promise((resolve) => setTimeout(resolve, 5));
			assert.strictEqual(settled, false, 'not settled while the write is in flight');
			assert.strictEqual(writes.length, 0);

			release?.();
			await waiting;
			assert.strictEqual(settled, true);
			assert.strictEqual(writes.length, 1);
		});

		it('settles after a lost write too, so a wait never hangs', async () => {
			const port = createCatalogMetricsPort({ catalog: stubCatalog([], new Error('gone')) });
			void port.recordAttempt(attempt({ totalMs: 5 }));
			await assert.doesNotReject(async () => port.settled());
		});
	});
});
