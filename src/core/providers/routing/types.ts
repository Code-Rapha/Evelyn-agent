/**
 * Vocabulary shared by the routing mechanisms.
 *
 * This folder holds no transport, storage or host code. The engine that will
 * consume these types reasons about providers, errors and attempts only, so
 * the same rules can serve the Electron app, the extension host and a
 * standalone router without a second copy of the provider configuration.
 *
 * The streaming engine and `RoutedChatProvider` in this folder consume these
 * contracts; nothing here imports a host, a transport or a store.
 */
import type { ChatProvider, TokenUsage } from '../chat/types';

/**
 * Why a route attempt ended.
 *
 * The set is deliberately closed and provider-agnostic. A new provider that
 * fails in a new way must be mapped onto one of these, not given a class of
 * its own: `fallbackOn` is a user-facing policy, and a policy that grows a
 * branch per vendor is a policy nobody can reason about.
 *
 * `breaker_open`, `no_candidate` and `budget_exhausted` are produced by the
 * router itself, not by a provider. They exist here so an attempt record never
 * needs a second vocabulary.
 *
 * `budget_exhausted` means the host's spending limit blocked a paid candidate
 * before it was called. It is not a provider failure and must never mark the
 * model as unhealthy: a budget says "not now", not "this model is broken".
 */
export type ErrorClass =
	| 'timeout'
	| 'unavailable'
	| 'rate_limit'
	| 'upstream_error'
	| 'network'
	| 'auth'
	| 'bad_request'
	| 'context_length'
	| 'cancelled'
	| 'breaker_open'
	| 'budget_exhausted'
	| 'no_candidate'
	| 'model_not_found'
	| 'internal';

/**
 * Why an attempt was aborted, when the caller knows.
 *
 * Structurally compatible with the desktop's `AbortCause` for the three values
 * the host knows (`first-token`, `total-time`, `user-stop`). The two extra
 * values are routing-only: `idle` is the gap between events mid-stream, and
 * `deadline` is the global route budget expiring. They are kept separate rather
 * than collapsed into `total-time` because an idle stall and a slow overall
 * attempt are different diagnoses, and the metrics should not lie about which
 * one happened.
 */
export type RoutingAbortCause =
	| 'first-token'
	| 'idle'
	| 'total-time'
	| 'deadline'
	| 'user-stop';

/** The clock every mechanism here reads. Injected so tests are exact. */
export type RoutingClock = () => number;

/** One model the engine may try. The pair is the identity. */
export interface RouteCandidate {
	readonly providerId: string;
	readonly modelId: string;
}

/**
 * A candidate plus the live provider that serves it.
 *
 * The pair alone identifies the model; the provider instance is what makes an
 * attempt possible. Keeping them together means the engine never needs a
 * registry or a resolver, and a test can pass a fake without a host.
 */
export interface RouteTarget extends RouteCandidate {
	readonly provider: ChatProvider;
}

/**
 * Waits between attempts.
 *
 * Returns `false` when the wait was cut short by the caller's signal. Injected
 * so tests can assert the backoff schedule without sleeping.
 */
export type RouteSleep = (ms: number, signal?: AbortSignal) => Promise<boolean>;


/** How an attempt ended, as recorded for later analysis. */
export type RouteAttemptOutcome = 'success' | 'failure' | 'cancelled' | 'skipped';

/**
 * How an attempt ended, in the vocabulary the consumption ledger stores.
 *
 * `timeout` is split out from `failure` because a budget that fired is not the
 * model failing: it says the attempt was cut, and a cost record that called it
 * a failure would put an infrastructure decision into a model's error history.
 * `skipped` maps to `cancelled`: it never ran, so there is nothing it could
 * have failed at.
 */
export type AttemptStatus = 'success' | 'failure' | 'cancelled' | 'timeout';

/** One route candidate that the budget gate vetoed before it ran. */
export interface BudgetBlockedCandidate extends RouteCandidate {
	readonly sequence: number;
	readonly message: string;
}

/**
 * Classifies an attempt record for accounting.
 *
 * A failed attempt whose error is a timeout **class** or whose abort was a
 * timer (`first-token`, `idle`, `total-time`) or the route deadline
 * (`deadline`) is a `timeout`. A user stop is a `cancelled`, never a timeout,
 * even though it reaches the engine as the same kind of abort: calling it a
 * timeout would blame the model for the user's click.
 */
export function attemptStatus(attempt: {
	readonly outcome: RouteAttemptOutcome;
	readonly errorClass?: ErrorClass;
	readonly abortCause?: RoutingAbortCause;
}): AttemptStatus {
	switch (attempt.outcome) {
		case 'success':
			return 'success';
		case 'skipped':
			return 'cancelled';
		case 'cancelled':
			return attempt.abortCause === 'user-stop' || attempt.abortCause === undefined
				? 'cancelled'
				: 'timeout';
		case 'failure':
			if (attempt.errorClass === 'timeout') {
				return 'timeout';
			}
			return attempt.abortCause !== undefined && attempt.abortCause !== 'user-stop'
				? 'timeout'
				: 'failure';
	}
}

/**
 * One attempt, in the shape the metrics port receives.
 *
 * Absent is absent: a request that never produced headers has no `headersMs`,
 * and a cancelled stream has no `totalMs`. Writing `0` for either would make an
 * unmeasured attempt indistinguishable from an instantaneous one.
 *
 * No field can carry a secret: provider credentials never enter this object,
 * and neither do prompts or message content. `usage` is a token count the
 * provider published, not anything derived from the conversation.
 */
export interface RouteAttempt {
	readonly requestId: string;
	readonly routeId?: string;
	readonly providerId: string;
	readonly modelId: string;
	/** 1-based order within the request. */
	readonly sequence: number;
	readonly startedAtMs: number;
	/** True when this is another try of the same candidate, not a new one. */
	readonly retry: boolean;
	/** True when this candidate was reached because a previous one failed. */
	readonly fallback: boolean;
	/**
	 * From the attempt starting to its first event, of any kind.
	 *
	 * "Of any kind" is the caveat: a `Usage` event that carries no answer still
	 * stops this clock. `firstVisibleEventMs` is the later, stricter measure and
	 * the one to read as "it started answering".
	 */
	readonly ttfbMs?: number;
	/**
	 * From the attempt starting to its first visible event.
	 *
	 * Visible means a `TextDelta`, a `ReasoningDelta` or a `ToolCallDelta` —
	 * something the user would see. Absent when the attempt never produced one,
	 * which is the only honest reading of "it never started answering".
	 */
	readonly firstVisibleEventMs?: number;
	/**
	 * From sending the request to the HTTP response existing, when the provider
	 * measured it.
	 *
	 * Never derived from `ttfbMs`: collapsing the two is how a slow connection
	 * gets reported as a slow model. A proxy that answers `200` in 40ms and then
	 * thinks for twelve seconds has a 40ms header time and a twelve-second
	 * `firstVisibleEventMs`, and neither is the other.
	 */
	readonly headersMs?: number;
	/**
	 * From the attempt starting to it ending.
	 *
	 * Absent for a cancelled attempt and for a skipped candidate, where nothing
	 * ran to measure. A timer-cut attempt still carries it: the attempt did
	 * end, at the moment the budget fired.
	 */
	readonly totalMs?: number;
	/** What the provider reported the attempt cost, when it reported anything. */
	readonly usage?: TokenUsage;
	readonly outcome: RouteAttemptOutcome;
	readonly errorClass?: ErrorClass;
	/** The budget that cut the attempt, when a timer did. */
	readonly abortCause?: RoutingAbortCause;
	readonly httpStatus?: number;
	readonly retryAfterMs?: number;
	/**
	 * Why a candidate was vetoed before it ran, in words for the user.
	 *
	 * Only present with `errorClass: 'budget_exhausted'`. The router does not
	 * format a budget: the host knows the limit, the currency and the amount
	 * spent, and this field is where it says so once instead of the renderer
	 * guessing from an error class.
	 */
	readonly budgetMessage?: string;
}

/**
 * What the host sees just before a candidate is called.
 *
 * Optional and observational: the engine does not depend on anyone listening.
 * It exists so the desktop can keep emitting `modelSelected` / `fallbackAttempted`
 * when the engine, rather than the outer loop, owns the fallback decision.
 */
export interface RouteAttemptStart {
	readonly requestId: string;
	readonly routeId?: string;
	readonly providerId: string;
	readonly modelId: string;
	/** 1-based order across the whole route, retries included. */
	readonly sequence: number;
	/** True when this candidate was reached because a previous one failed. */
	readonly isFallback: boolean;
	/** True when this is another try of the same candidate, not a new one. */
	readonly isRetry: boolean;
	readonly previousError?: Error;
}

/** Observer for hosts that render routing decisions. */
export interface RoutingObserver {
	onAttemptStart?(info: RouteAttemptStart): void;
}


/**
 * Where attempt records go.
 *
 * A port rather than a store: the desktop can append to its JSON log, the
 * standalone router can write SQLite, and the engine stays free of both.
 * Implementations must not throw into the engine — a metrics failure must not
 * fail a request that already succeeded.
 */
export interface RoutingMetricsPort {
	recordAttempt(attempt: RouteAttempt): void | Promise<void>;
}

/**
 * Asks the host whether a paid candidate may be called.
 *
 * ## Why the answer is asynchronous
 *
 * The amount spent is read from the ledger, and the ledger is on disk. A
 * synchronous callback would force the host to keep a second running total in
 * memory, and that copy is exactly what drifts from the file it is meant to
 * bound.
 *
 * ## Why it cannot fail the route
 *
 * Implementations must not throw: the engine guards the call anyway, and a
 * throw is read as **"do not block"**. A budget is a guard rail, not the
 * answer - a store that cannot be read must not turn a working model into an
 * outage, and it must not silently spend either. The `unknown` decision exists
 * for the honest middle: the limit could not be checked, said so, and the
 * attempt proceeds with the fact recorded.
 */
export interface BudgetGate {
	check(target: RouteCandidate): BudgetDecision | Promise<BudgetDecision>;
}

/** What the router learns about a candidate from its budget gate. */
export type BudgetDecision =
	| { readonly allowed: true }
	/**
	 * Blocked before running. `message` is shown to the user as-is; `alert` is
	 * the host's 80% notice at the same moment, when there is one. It is
	 * optional and opaque to the router: a router that does not know about
	 * alerts simply ignores it.
	 */
	| { readonly allowed: false; readonly message: string; readonly alert?: unknown };

/**
 * Whether a candidate's rate limit is exhausted, and until when.
 *
 * A quota is a window, not a health verdict: `allowed: false` means "not now",
 * and the engine records a `skipped` attempt with `rate_limit` and the
 * remaining time. It never touches the breaker, and it is never permanent - a
 * host that does not know a window reports `allowed: true`.
 */
export interface QuotaGate {
	check(candidate: RouteCandidate): {
		readonly allowed: boolean;
		/** Milliseconds until the window reopens. `0` when unknown. */
		readonly retryAfterMs?: number;
	};
}

/**
 * Per-attempt budgets, in milliseconds. *
 * Three phases, because they answer different questions: `ttfbMs` is "did the
 * server start answering", `idleMs` is "did it stall mid-answer", and
 * `totalMs` is the ceiling for the whole attempt. The streaming engine owns
 * them per candidate; the caller keeps the outer turn budget.
 */
export interface RouteTimeouts {
	readonly ttfbMs: number;
	readonly idleMs: number;
	readonly totalMs: number;
}

/**
 * The breaker's configuration.
 *
 * `halfOpenProbes` is the literal `1` on purpose: the engine admits exactly
 * one probe after the open window, and a configurable count would describe a
 * concurrency behaviour the state machine does not implement.
 */
export interface BreakerConfig {
	readonly failureThreshold: number;
	readonly windowMs: number;
	readonly openMs: number;
	readonly halfOpenProbes: 1;
}

export type BreakerState = 'closed' | 'open' | 'half-open';

/** Whether an attempt may run, and what to say if it may not. */
export interface BreakerCheck {
	readonly allowed: boolean;
	readonly state: BreakerState;
	/** Milliseconds until the breaker would admit a probe. `0` when allowed. */
	readonly retryAfterMs: number;
}

/** A read-only view, for diagnostics and tests. Never consumes a probe. */
export interface BreakerSnapshot {
	readonly state: BreakerState;
	readonly failures: number;
	readonly openUntil: number;
	readonly retryAfterMs: number;
	readonly lastErrorClass: ErrorClass | null;
}

/**
 * Everything the streaming engine needs that is not a candidate list.
 *
 * The candidate list itself is produced by the existing selector from the
 * catalogue, so a route never has to enumerate models by hand.
 */
export interface RoutePolicy {
	/** Retries per candidate, after the first attempt. */
	readonly retries: number;
	readonly retryBackoffMs: number;
	/**
	 * Ceiling for one backoff wait.
	 *
	 * Exponential backoff without a cap turns a handful of retries into a
	 * multi-minute silence, which is indistinguishable from a hang. The cap is
	 * explicit rather than derived so the schedule is a policy, not a surprise.
	 */
	readonly maxRetryBackoffMs: number;
	readonly timeouts: RouteTimeouts;
	/** Classes that justify moving to the next candidate. */
	readonly fallbackOn: readonly ErrorClass[];
	/**
	 * Whole-route budget, across every candidate and every backoff wait.
	 *
	 * Optional: a host that already owns a turn-level deadline may leave it
	 * unset. When set, expiry stops the route even if candidates remain.
	 */
	readonly deadlineMs?: number;
	readonly breaker: BreakerConfig;
}
