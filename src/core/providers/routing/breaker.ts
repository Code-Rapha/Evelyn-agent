/**
 * Circuit breaker per `provider/model`.
 *
 * The state machine is the one the standalone router already uses: a failure
 * threshold inside a sliding window opens the circuit, an open circuit waits,
 * then admits exactly one probe; success closes it and failure reopens it.
 *
 * Two properties are worth stating because they are easy to lose:
 *
 * - **The clock is injected.** Every transition reads `now`, never `Date.now`,
 *   so a test can assert an exact `retryAfterMs` without sleeping.
 * - **A breaker is a guard, not a scheduler.** `check` only answers whether an
 *   attempt may start. The caller must record exactly one outcome for every
 *   allowed attempt; an unrecorded half-open probe stays in flight and keeps
 *   the circuit closed to everyone else. The streaming engine owns that
 *   pairing.
 *
 * State is intentionally in memory. A restart forgetting which endpoint was
 * failing is the honest behaviour: the next request measures it again.
 */
import type {
	BreakerCheck,
	BreakerConfig,
	BreakerSnapshot,
	BreakerState,
	ErrorClass,
	RoutingClock,
} from './types';
import { isBreakerIgnored } from './errors';

interface Entry {
	state: BreakerState;
	/** Timestamps of counted failures, oldest first. */
	failures: number[];
	openUntil: number;
	probeInFlight: boolean;
	lastErrorClass: ErrorClass | null;
}

export class CircuitBreaker {
	private readonly entries = new Map<string, Entry>();
	private readonly getConfig: () => BreakerConfig;
	private readonly now: RoutingClock;

	constructor(getConfig: () => BreakerConfig, now: RoutingClock = Date.now) {
		this.getConfig = getConfig;
		this.now = now;
	}

	/**
	 * The key for a candidate.
	 *
	 * Provider and model are joined with NUL rather than `/` because model ids
	 * routinely contain slashes (`meta-llama/Llama-3`) and a delimiter that can
	 * appear inside a part would merge two candidates' health.
	 */
	static key(providerId: string, modelId: string): string {
		return `${providerId}\u0000${modelId}`;
	}

	/**
	 * Whether an attempt may start now.
	 *
	 * Read-only for a closed circuit. For an open one whose window elapsed,
	 * this consumes the single half-open probe; a second caller is refused
	 * until the first records an outcome.
	 */
	check(key: string): BreakerCheck {
		const config = this.getConfig();
		const entry = this.ensure(key);
		const current = this.now();

		if (entry.state === 'open') {
			if (current < entry.openUntil) {
				return {
					allowed: false,
					state: 'open',
					retryAfterMs: Math.max(0, entry.openUntil - current),
				};
			}
			entry.state = 'half-open';
			entry.probeInFlight = false;
		}

		if (entry.state === 'half-open') {
			if (entry.probeInFlight) {
				return { allowed: false, state: 'half-open', retryAfterMs: 0 };
			}
			entry.probeInFlight = true;
			return { allowed: true, state: 'half-open', retryAfterMs: 0 };
		}

		// Keep the window pruned even when no new failure arrives, so a stale
		// entry cannot count yesterday's failures against today's request.
		entry.failures = entry.failures.filter((at) => current - at <= config.windowMs);
		return { allowed: true, state: 'closed', retryAfterMs: 0 };
	}

	/** Records a successful attempt and closes the circuit. */
	recordSuccess(key: string): void {
		const entry = this.ensure(key);
		entry.state = 'closed';
		entry.failures = [];
		entry.openUntil = 0;
		entry.probeInFlight = false;
		entry.lastErrorClass = null;
	}

	/**
	 * Records a failed attempt.
	 *
	 * Cancellations and caller mistakes are ignored: the endpoint did not
	 * fail, so its health must not change. An authentication failure opens
	 * immediately — retrying a rejected key can never succeed, and the open
	 * window is what stops the app from hammering it.
	 */
	recordFailure(key: string, errorClass: ErrorClass): void {
		if (isBreakerIgnored(errorClass)) {
			return;
		}

		const config = this.getConfig();
		const entry = this.ensure(key);
		const current = this.now();

		entry.lastErrorClass = errorClass;

		if (errorClass === 'auth' || entry.state === 'half-open') {
			this.open(entry, current, config);
			return;
		}

		entry.failures = entry.failures.filter((at) => current - at <= config.windowMs);
		entry.failures.push(current);

		if (entry.failures.length >= config.failureThreshold) {
			this.open(entry, current, config);
		}
	}

	/**
	 * A view for diagnostics.
	 *
	 * Does not mutate: reporting an elapsed open window as `half-open` must not
	 * consume the probe, or a status refresh would starve the next request.
	 */
	snapshot(key: string): BreakerSnapshot {
		const config = this.getConfig();
		const entry = this.entries.get(key);
		const current = this.now();

		if (entry === undefined) {
			return {
				state: 'closed',
				failures: 0,
				openUntil: 0,
				retryAfterMs: 0,
				lastErrorClass: null,
			};
		}

		const failures = entry.failures.filter((at) => current - at <= config.windowMs).length;

		if (entry.state === 'open' && current >= entry.openUntil) {
			return {
				state: 'half-open',
				failures,
				openUntil: entry.openUntil,
				retryAfterMs: 0,
				lastErrorClass: entry.lastErrorClass,
			};
		}

		return {
			state: entry.state,
			failures,
			openUntil: entry.openUntil,
			retryAfterMs: entry.state === 'open' ? Math.max(0, entry.openUntil - current) : 0,
			lastErrorClass: entry.lastErrorClass,
		};
	}

	/** Forgets one candidate, or every candidate when no key is given. */
	reset(key?: string): void {
		if (key !== undefined) {
			this.entries.delete(key);
			return;
		}
		this.entries.clear();
	}

	private ensure(key: string): Entry {
		const existing = this.entries.get(key);
		if (existing !== undefined) {
			return existing;
		}
		const created: Entry = {
			state: 'closed',
			failures: [],
			openUntil: 0,
			probeInFlight: false,
			lastErrorClass: null,
		};
		this.entries.set(key, created);
		return created;
	}

	private open(entry: Entry, current: number, config: BreakerConfig): void {
		entry.state = 'open';
		entry.openUntil = current + config.openMs;
		entry.probeInFlight = false;
	}
}
