/**
 * The streaming route engine.
 *
 * One request, an ordered list of candidates, and the policy that decides when
 * to wait, when to move on and when to stop. It consumes the same
 * `ChatProvider` / `ChatStream` contracts the host already uses, so a route can
 * be dropped into the existing chat flow without a transport of its own.
 *
 * The safety rule that shapes everything here is **commit before flush**:
 *
 * - Before a visible event (`TextDelta`, `ReasoningDelta`, `ToolCallDelta`), a
 *   failed attempt is invisible. Its buffered events are discarded and another
 *   candidate may be tried.
 * - After a visible event, the consumer has already seen part of an answer.
 *   Retrying would duplicate or contradict it, so the failure is surfaced as
 *   the stream's single terminal `Error` and nothing else is tried.
 * - A tool call is visible. Falling back after one would leave a tool call id
 *   and its arguments attached to a model that never produced them, and the
 *   next round would replay an incoherent transcript.
 *
 * Cancellation is not a failure. A caller abort stops the route with no
 * terminal event and `closedReason: 'aborted'`; a timer owned by this engine
 * stops one attempt, and the resulting `RoutingFailure` names the budget in
 * `abortCause`.
 */
import { ProviderError } from '../../errors';
import type {
	ChatProvider,
	ChatRequest,
	ChatStream,
	ChatStreamEvent,
	StreamTiming,
	TokenUsage,
} from '../chat/types';
import { CircuitBreaker } from './breaker';
import { classifyError, isRetryableErrorClass } from './errors';
import { RouteExhaustedError, RoutingFailure } from './failure';
import type {
	BudgetBlockedCandidate,
	BudgetDecision,
	BudgetGate,
	ErrorClass,
	QuotaGate,
	RouteAttempt,
	RouteAttemptOutcome,
	RouteAttemptStart,
	RoutePolicy,
	RouteSleep,
	RouteTarget,
	RoutingAbortCause,
	RoutingClock,
	RoutingMetricsPort,
	RoutingObserver,
} from './types';

/** Everything one route needs. */
export interface RouteRunInput {
	readonly request: ChatRequest;
	readonly targets: readonly RouteTarget[];
	readonly policy: RoutePolicy;
	readonly breaker: CircuitBreaker;
	readonly signal?: AbortSignal;
	readonly metrics?: RoutingMetricsPort;
	readonly observer?: RoutingObserver;
	readonly clock?: RoutingClock;
	readonly sleep?: RouteSleep;
	/**
	 * Vetoes a candidate before it is called, when the host's budget says so.
	 *
	 * Optional and host-supplied. The engine never decides what a budget is;
	 * it only records that the host refused, keeps the reason, and moves on to
	 * the next candidate — exactly like the breaker does for an open circuit.
	 * A gate that throws is read as "allowed".
	 */
	readonly budget?: BudgetGate;
	/**
	 * Says whether a candidate's rate limit is exhausted right now.
	 *
	 * Distinct from the breaker and from the budget: a quota is a window, not
	 * health and not money. A skipped candidate is recorded as `rate_limit`
	 * with its remaining time and must not make the model look broken. Optional;
	 * a host without quotas passes nothing and the engine behaves as before.
	 */
	readonly quotas?: QuotaGate;
	readonly requestId: string;
	readonly routeId?: string;
	/**
	 * Called once, at the first visible event of the winning candidate.
	 *
	 * The provider uses it to pin the model for later rounds of the same turn:
	 * after a tool call, the transcript belongs to that model, and switching
	 * models mid-turn would silently reinterpret it.
	 */
	onCommitted?(target: RouteTarget): void;
	/** Called once per attempt record, before the metrics port. */
	onAttempt?(attempt: RouteAttempt): void;
}

/** A route, ready to be consumed. */
export function runRoute(input: RouteRunInput): ChatStream {
	return new RoutedStream(input);
}

/** The visible events that make a candidate the winner. */
function isVisible(event: ChatStreamEvent): boolean {
	return (
		event.type === 'TextDelta' ||
		event.type === 'ReasoningDelta' ||
		event.type === 'ToolCallDelta'
	);
}

interface ActiveAttempt {
	readonly target: RouteTarget;
	readonly sequence: number;
	readonly startedAtMs: number;
	readonly controller: AbortController;
	/** True when this is another try of the same candidate, not a new one. */
	readonly retry: boolean;
	/** True when this candidate was reached because a previous one failed. */
	readonly fallback: boolean;
	abortCause?: RoutingAbortCause;
	ttfbMs?: number;
	headersMs?: number;
	firstVisibleEventMs?: number;
	usage?: TokenUsage;
	/** The provider error, kept only to read structured details such as status. */
	lastError?: unknown;
	recorded: boolean;
}

type AttemptResult =
	| { readonly kind: 'success' }
	| {
			readonly kind: 'failure';
			readonly error: Error;
			readonly errorClass: ErrorClass;
			readonly committed: boolean;
			readonly abortCause?: RoutingAbortCause;
	  }
	| { readonly kind: 'cancelled'; readonly abortCause?: RoutingAbortCause };

class RoutedStream implements ChatStream {
	private reason: ChatStream['closedReason'] = 'completed';
	private timingValue: StreamTiming = {};
	private terminalEmitted = false;
	private deadlineExpired = false;
	private active: ActiveAttempt | undefined;
	private readonly attempts: RouteAttempt[] = [];
	private readonly input: RouteRunInput;
	private readonly now: RoutingClock;
	private readonly sleep: RouteSleep;
	private routeController: AbortController | undefined;

	constructor(input: RouteRunInput) {
		this.input = input;
		this.now = input.clock ?? Date.now;
		this.sleep = input.sleep ?? defaultSleep;
	}

	get closedReason(): ChatStream['closedReason'] {
		return this.reason;
	}

	get timing(): StreamTiming {
		return this.timingValue;
	}

	/** The decision-level records, in order. Cheap to keep; used for exhaustion. */
	get recordedAttempts(): readonly RouteAttempt[] {
		return this.attempts;
	}

	async *[Symbol.asyncIterator](): AsyncGenerator<ChatStreamEvent, void, void> {
		const callerSignal = this.input.signal;
		if (callerSignal?.aborted === true) {
			this.reason = 'aborted';
			return;
		}

		const routeController = new AbortController();
		this.routeController = routeController;
		let callerAborted = false;
		const onCallerAbort = (): void => {
			callerAborted = true;
			if (!routeController.signal.aborted) {
				routeController.abort(normalizeAbortCause(callerSignal?.reason));
			}
		};
		callerSignal?.addEventListener('abort', onCallerAbort, { once: true });

		const deadlineMs = this.input.policy.deadlineMs;
		const deadlineTimer =
			deadlineMs !== undefined && deadlineMs > 0
				? setTimeout(() => {
						this.deadlineExpired = true;
						if (!routeController.signal.aborted) {
							routeController.abort('deadline');
						}
						this.abortActive('deadline');
					}, deadlineMs)
				: undefined;

		try {
			yield* this.run(callerAborted ? () => true : () => false, routeController, deadlineTimer !== undefined);
		} finally {
			if (deadlineTimer !== undefined) {
				clearTimeout(deadlineTimer);
			}
			callerSignal?.removeEventListener('abort', onCallerAbort);
			if (this.active !== undefined && !this.active.recorded) {
				// The consumer closed the stream early. That is a normal outcome,
				// not a provider fault, so it is recorded as cancelled and never
				// counts against the breaker.
				const active = this.active;
				await this.publish(active, 'cancelled', 'cancelled', active.abortCause);
			}
			this.active = undefined;
			if (!this.terminalEmitted && this.reason === 'completed') {
				this.reason = 'closed';
			}
		}
	}

	private async *run(
		callerAborted: () => boolean,
		routeController: AbortController,
		hasDeadline: boolean,
	): AsyncGenerator<ChatStreamEvent, void, void> {
		const targets = this.input.targets;
		if (targets.length === 0) {
			this.reason = 'failed';
			this.terminalEmitted = true;
			yield {
				type: 'Error',
				error: new RouteExhaustedError('No route candidate was available', {
					errorClass: 'no_candidate',
					attempts: [],
				}),
			};
			return;
		}

		let targetIndex = 0;
		let sequence = 0;
		let lastError: Error | undefined;
		let lastClass: ErrorClass | undefined;
		const budgetBlocked: BudgetBlockedCandidate[] = [];

		while (targetIndex < targets.length) {
			if (callerAborted()) {
				this.reason = 'aborted';
				return;
			}
			if (this.deadlineExpired) {
				break;
			}

			const target = targets[targetIndex];
			// The quota is asked first: a candidate the API just said is
			// exhausted for a known window should neither consume a breaker
			// probe nor be shown as "the circuit is open".
			const quotaRetryAfterMs = this.quotaVeto(target);
			if (quotaRetryAfterMs !== undefined) {
				sequence += 1;
				await this.publishRecord({
					requestId: this.input.requestId,
					...(this.input.routeId !== undefined ? { routeId: this.input.routeId } : {}),
					providerId: target.providerId,
					modelId: target.modelId,
					sequence,
					startedAtMs: this.now(),
					retry: false,
					fallback: targetIndex > 0,
					outcome: 'skipped',
					errorClass: 'rate_limit',
					retryAfterMs: quotaRetryAfterMs,
				});
				lastError = new Error(
					`The rate limit for ${target.providerId}/${target.modelId} is exhausted for ${quotaRetryAfterMs}ms more`,
				);
				lastClass = 'rate_limit';
				targetIndex += 1;
				continue;
			}

			// The budget is asked before the breaker: a candidate nobody is
			// allowed to pay for should not consume a breaker probe, and the
			// reason the user sees must be "the limit", not "the circuit".
			const veto = await this.budgetVeto(target);
			if (veto !== undefined) {
				sequence += 1;
				budgetBlocked.push({ providerId: target.providerId, modelId: target.modelId, sequence, message: veto });
				await this.publishRecord({
					requestId: this.input.requestId,
					...(this.input.routeId !== undefined ? { routeId: this.input.routeId } : {}),
					providerId: target.providerId,
					modelId: target.modelId,
					sequence,
					startedAtMs: this.now(),
					retry: false,
					fallback: targetIndex > 0,
					outcome: 'skipped',
					errorClass: 'budget_exhausted',
					budgetMessage: veto,
				});
				lastError = new Error(veto);
				lastClass = 'budget_exhausted';
				targetIndex += 1;
				continue;
			}

			const key = CircuitBreaker.key(target.providerId, target.modelId);
			const check = this.input.breaker.check(key);
			if (!check.allowed) {
				sequence += 1;
				const now = this.now();
				const record: RouteAttempt = {
					requestId: this.input.requestId,
					...(this.input.routeId !== undefined ? { routeId: this.input.routeId } : {}),
					providerId: target.providerId,
					modelId: target.modelId,
					sequence,
					startedAtMs: now,
					retry: false,
					fallback: targetIndex > 0,
					outcome: 'skipped',
					errorClass: 'breaker_open',
					retryAfterMs: check.retryAfterMs,
				};
				await this.publishRecord(record);
				lastError = new Error(
					`The circuit for ${target.providerId}/${target.modelId} is open for ${check.retryAfterMs}ms`,
				);
				lastClass = 'breaker_open';
				targetIndex += 1;
				continue;
			}

			let retry = 0;
			let stopped = false;
			while (!stopped) {
				if (callerAborted()) {
					this.reason = 'aborted';
					return;
				}
				if (this.deadlineExpired) {
					break;
				}

				sequence += 1;
				const active: ActiveAttempt = {
					target,
					sequence,
					startedAtMs: this.now(),
					controller: new AbortController(),
					retry: retry > 0,
					fallback: targetIndex > 0,
					recorded: false,
				};
				this.active = active;
				this.notifyStart(active, targetIndex > 0, retry > 0, lastError);

				const result = yield* this.attempt(active, routeController);
				this.active = undefined;

				if (result.kind === 'success') {
					this.input.breaker.recordSuccess(key);
					this.terminalEmitted = true;
					await this.publish(active, 'success');
					return;
				}

				if (result.kind === 'cancelled') {
					await this.publish(active, 'cancelled', 'cancelled', result.abortCause);
					this.reason = 'aborted';
					return;
				}

				this.input.breaker.recordFailure(key, result.errorClass);
				await this.publish(active, 'failure', result.errorClass, result.abortCause);
				lastError = result.error;
				lastClass = result.errorClass;

				// After visible content there is nothing safe to retry: the
				// consumer has part of an answer that a second attempt would
				// duplicate or contradict.
				if (result.committed) {
					this.reason = 'failed';
					this.terminalEmitted = true;
					yield { type: 'Error', error: result.error };
					return;
				}

				if (callerAborted()) {
					this.reason = 'aborted';
					return;
				}

				if (this.deadlineExpired) {
					stopped = true;
					break;
				}

				if (retry < this.input.policy.retries && isRetryableErrorClass(result.errorClass)) {
					const delay = this.backoff(retry);
					retry += 1;
					if (delay > 0) {
						const waited = await this.sleep(delay, routeController.signal);
						if (!waited) {
							if (callerAborted()) {
								this.reason = 'aborted';
								return;
							}
							stopped = true;
							break;
						}
					}
					continue;
				}

				stopped = true;
			}

			if (callerAborted()) {
				this.reason = 'aborted';
				return;
			}

			if (this.deadlineExpired) {
				break;
			}

			if (lastClass !== undefined && this.input.policy.fallbackOn.includes(lastClass)) {
				targetIndex += 1;
				continue;
			}

			this.reason = 'failed';
			this.terminalEmitted = true;
			yield {
				type: 'Error',
				error: lastError ?? new Error('The route attempt failed'),
			};
			return;
		}

		this.reason = 'failed';
		this.terminalEmitted = true;
		if (this.deadlineExpired && hasDeadline) {
			yield {
				type: 'Error',
				error: new RoutingFailure(this.timeoutMessage('deadline'), {
					errorClass: 'timeout',
					abortCause: 'deadline',
					...(lastError !== undefined ? { cause: lastError } : {}),
				}),
			};
			return;
		}

		yield {
			type: 'Error',
			error: new RouteExhaustedError(
				lastError !== undefined
					? `No route candidate succeeded: ${lastError.message}`
					: 'No route candidate succeeded',
				{
					errorClass: lastClass ?? 'no_candidate',
					attempts: this.attempts,
					...(budgetBlocked.length > 0 ? { budgetBlocked } : {}),
					...(lastError !== undefined ? { cause: lastError } : {}),
				},
			),
		};
	}

	/**
	 * Asks the host's budget gate about one candidate.
	 *
	 * Returns the message to record when the host vetoed it, and `undefined`
	 * when it may run. Every failure path here means "may run": a gate that
	 * throws, answers with something malformed, or is not there at all must
	 * not stop a request the host did not refuse. The gate's own `unknown`
	 * decision (a cost that could not be checked) arrives here as allowed, so
	 * the router never has to know what a limit is.
	 */
	private async budgetVeto(target: RouteTarget): Promise<string | undefined> {
		const gate = this.input.budget;
		if (gate === undefined) {
			return undefined;
		}
		let decision: BudgetDecision;
		try {
			decision = await gate.check({ providerId: target.providerId, modelId: target.modelId });
		} catch {
			return undefined;
		}
		if (typeof decision !== 'object' || decision === null || !('allowed' in decision)) {
			return undefined;
		}
		return decision.allowed === false
			? decision.message.trim().length > 0
				? decision.message
				: `The spending limit blocked ${target.providerId}/${target.modelId}`
			: undefined;
	}

	/**
	 * Asks the host's quota tracker whether this candidate is exhausted now.
	 *
	 * Returns the time it stays unavailable when the host knows a window, and
	 * nothing when the host has no tracker or the candidate may run. A quota is
	 * not a model failure: the caller records it as `skipped`/`rate_limit` and
	 * leaves the breaker alone.
	 */
	private quotaVeto(target: RouteTarget): number | undefined {
		const tracker = this.input.quotas;
		if (tracker === undefined) {
			return undefined;
		}
		let check: { readonly allowed: boolean; readonly retryAfterMs?: number };
		try {
			check = tracker.check({ providerId: target.providerId, modelId: target.modelId });
		} catch {
			// A tracker that throws must not stop a request the host did not refuse.
			return undefined;
		}
		if (check.allowed) {
			return undefined;
		}
		return check.retryAfterMs ?? 0;
	}

	private async *attempt(
		active: ActiveAttempt,
		routeController: AbortController,
	): AsyncGenerator<ChatStreamEvent, AttemptResult, void> {
		const { target, controller } = active;
		const policy = this.input.policy;
		const buffer: ChatStreamEvent[] = [];
		let committed = false;
		let firstEvent = true;
		let terminalSeen = false;
		let stream: ChatStream | undefined;
		let iterator: AsyncIterator<ChatStreamEvent> | undefined;
		let ttfbTimer: ReturnType<typeof setTimeout> | undefined;
		let idleTimer: ReturnType<typeof setTimeout> | undefined;
		let totalTimer: ReturnType<typeof setTimeout> | undefined;

		const clear = (timer: ReturnType<typeof setTimeout> | undefined): void => {
			if (timer !== undefined) {
				clearTimeout(timer);
			}
		};
		const arm = (ms: number, cause: RoutingAbortCause): ReturnType<typeof setTimeout> =>
			setTimeout(() => this.abortActive(cause, active), ms);

		const onRouteAbort = (): void => {
			if (controller.signal.aborted) {
				return;
			}
			if (active.abortCause === undefined) {
				if (routeController.signal.reason === 'deadline') {
					active.abortCause = 'deadline';
				} else {
					active.abortCause = normalizeAbortCause(this.input.signal?.reason);
				}
			}
			controller.abort(active.abortCause);
		};
		routeController.signal.addEventListener('abort', onRouteAbort, { once: true });
		if (routeController.signal.aborted) {
			onRouteAbort();
		}

		try {
			if (policy.timeouts.ttfbMs > 0) {
				ttfbTimer = arm(policy.timeouts.ttfbMs, 'first-token');
			}
			if (policy.timeouts.totalMs > 0) {
				totalTimer = arm(policy.timeouts.totalMs, 'total-time');
			}

			const request: ChatRequest = { ...this.input.request, model: target.modelId };
			const connecting = target.provider.streamChat(request, {
				signal: controller.signal,
			});
			try {
				stream = await raceWithSignal(connecting, controller.signal);
			} catch (error) {
				void connecting.then(closeLateStream, () => undefined);
				if (active.abortCause !== undefined) {
					return this.abortResult(active, false, undefined);
				}
				return this.failureResult(error, active, false, undefined);
			}

			// The provider measured this when the response object appeared. Read
			// before the abort check below so an attempt cut short after headers
			// still records the connection time it really took.
			active.headersMs = stream.timing.headersMs;

			if (active.abortCause !== undefined) {
				closeStream(stream);
				return this.abortResult(active, false, stream);
			}

			iterator = stream[Symbol.asyncIterator]();
			while (true) {
				let next: IteratorResult<ChatStreamEvent>;
				try {
					next = await nextWithSignal(iterator, controller.signal);
				} catch (error) {
					if (active.abortCause !== undefined) {
						closeIterator(iterator);
						return this.abortResult(active, committed, stream);
					}
					if (this.input.signal?.aborted === true) {
						closeIterator(iterator);
						return { kind: 'cancelled' };
					}
					return this.failureResult(error, active, committed, stream);
				}

				if (active.abortCause !== undefined) {
					closeIterator(iterator);
					return this.abortResult(active, committed, stream);
				}

				if (next.done === true) {
					if (stream.closedReason === 'aborted' && this.input.signal?.aborted === true) {
						return { kind: 'cancelled' };
					}
					return this.failureResult(
						new Error('The provider stream ended without a terminal event'),
						active,
						committed,
						stream,
						'internal',
					);
				}

				const event = next.value;
				if (firstEvent) {
					firstEvent = false;
					active.ttfbMs = Math.max(0, this.now() - active.startedAtMs);
					clear(ttfbTimer);
					if (policy.timeouts.idleMs > 0) {
						idleTimer = arm(policy.timeouts.idleMs, 'idle');
					}
				} else if (policy.timeouts.idleMs > 0) {
					clear(idleTimer);
					idleTimer = arm(policy.timeouts.idleMs, 'idle');
				}

				if (isVisible(event)) {
					// The first thing the user would see. Measured once, at the
					// first one, whichever kind it is.
					if (active.firstVisibleEventMs === undefined) {
						active.firstVisibleEventMs = Math.max(0, this.now() - active.startedAtMs);
					}
					if (!committed) {
						committed = true;
						this.input.onCommitted?.(target);
						for (const buffered of buffer) {
							yield buffered;
						}
						buffer.length = 0;
					}
					yield event;
					continue;
				}

				if (event.type === 'Usage') {
					// Kept even when the attempt goes on to fail: the provider did
					// report it, and a report is a measurement rather than a guess.
					active.usage = event.usage;
					if (committed) {
						yield event;
					} else {
						buffer.push(event);
					}
					continue;
				}

				if (event.type === 'Done') {
					if (!committed) {
						for (const buffered of buffer) {
							yield buffered;
						}
						buffer.length = 0;
					}
					this.timingValue = stream.timing;
					this.reason = 'completed';
					terminalSeen = true;
					yield event;
					return { kind: 'success' };
				}

				// An `Error` event. Before commit it is the attempt's failure and
				// its buffer is dropped; after commit it is the consumer's final
				// word and the route stops.
				if (event.type !== 'Error') {
					// Visible, Usage and Done are all handled above; anything
					// else is a contract the engine does not know yet and is
					// safer ignored than forwarded to a consumer that may throw.
					continue;
				}
				this.timingValue = committed ? stream.timing : this.timingValue;
				if (committed) {
					// The consumer already saw content. This is the one terminal
					// event the route will emit; the outer loop emits it below so
					// there is exactly one place that writes a terminal.
					this.reason = 'failed';
					terminalSeen = true;
					active.lastError = event.error;
					return {
						kind: 'failure',
						error: event.error,
						errorClass: classifyError(event.error),
						committed: true,
					};
				}
				return this.failureResult(event.error, active, false, stream);
			}
		} finally {
			clear(ttfbTimer);
			clear(idleTimer);
			clear(totalTimer);
			routeController.signal.removeEventListener('abort', onRouteAbort);
			if (!terminalSeen) {
				if (iterator !== undefined) {
					closeIterator(iterator);
				} else if (stream !== undefined) {
					closeStream(stream);
				}
			}
		}
	}

	private failureResult(
		error: unknown,
		active: ActiveAttempt,
		committed: boolean,
		stream: ChatStream | undefined,
		overrideClass?: ErrorClass,
	): AttemptResult {
		if (committed && stream !== undefined) {
			this.timingValue = stream.timing;
		}
		active.lastError = error;
		const abortCause = active.abortCause;
		if (abortCause === 'user-stop') {
			return { kind: 'cancelled', abortCause };
		}
		const errorClass =
			abortCause !== undefined
				? 'timeout'
				: overrideClass ?? classifyError(error, abortCause !== undefined ? { abortCause } : {});
		const cause = error instanceof Error ? error : new Error(String(error));
		const surfaced: Error =
			abortCause !== undefined
				? new RoutingFailure(this.timeoutMessage(abortCause), {
						errorClass,
						abortCause,
						cause,
					})
				: cause;
		return {
			kind: 'failure',
			error: surfaced,
			errorClass,
			committed,
			...(abortCause !== undefined ? { abortCause } : {}),
		};
	}

	private abortResult(
		active: ActiveAttempt,
		committed: boolean,
		stream: ChatStream | undefined,
	): AttemptResult {
		if (committed && stream !== undefined) {
			this.timingValue = stream.timing;
		}
		if (this.input.signal?.aborted === true) {
			return { kind: 'cancelled', ...(active.abortCause !== undefined ? { abortCause: active.abortCause } : {}) };
		}
		const cause = active.abortCause ?? 'deadline';
		return this.failureResult(
			new Error(this.timeoutMessage(cause)),
			active,
			committed,
			stream,
			'timeout',
		);
	}

	/** Aborts the attempt that is currently running, if any. */
	private abortActive(cause: RoutingAbortCause, only?: ActiveAttempt): void {
		const active = this.active;
		if (active === undefined || (only !== undefined && active !== only)) {
			return;
		}
		if (active.abortCause === undefined) {
			active.abortCause = cause;
		}
		if (!active.controller.signal.aborted) {
			active.controller.abort(active.abortCause);
		}
	}

	private notifyStart(
		active: ActiveAttempt,
		isFallback: boolean,
		isRetry: boolean,
		previousError: Error | undefined,
	): void {
		if (this.input.observer?.onAttemptStart === undefined) {
			return;
		}
		const info: RouteAttemptStart = {
			requestId: this.input.requestId,
			...(this.input.routeId !== undefined ? { routeId: this.input.routeId } : {}),
			providerId: active.target.providerId,
			modelId: active.target.modelId,
			sequence: active.sequence,
			isFallback,
			isRetry,
			...(previousError !== undefined ? { previousError } : {}),
		};
		try {
			this.input.observer.onAttemptStart(info);
		} catch {
			// A renderer observer must never fail the route it is watching.
		}
	}

	private async publish(
		active: ActiveAttempt,
		outcome: RouteAttemptOutcome,
		errorClass?: ErrorClass,
		abortCause?: RoutingAbortCause,
	): Promise<void> {
		if (active.recorded) {
			return;
		}
		active.recorded = true;
		const details = providerDetails(active);
		const record: RouteAttempt = {
			requestId: this.input.requestId,
			...(this.input.routeId !== undefined ? { routeId: this.input.routeId } : {}),
			providerId: active.target.providerId,
			modelId: active.target.modelId,
			sequence: active.sequence,
			startedAtMs: active.startedAtMs,
			retry: active.retry,
			fallback: active.fallback,
			...(active.ttfbMs !== undefined ? { ttfbMs: Math.round(active.ttfbMs) } : {}),
			...(active.firstVisibleEventMs !== undefined
				? { firstVisibleEventMs: Math.round(active.firstVisibleEventMs) }
				: {}),
			...(active.headersMs !== undefined
				? { headersMs: Math.max(0, Math.round(active.headersMs)) }
				: {}),
			...(outcome !== 'cancelled' && outcome !== 'skipped'
				? { totalMs: Math.max(0, Math.round(this.now() - active.startedAtMs)) }
				: {}),
			...(active.usage !== undefined ? { usage: active.usage } : {}),
			outcome,
			...(errorClass !== undefined ? { errorClass } : {}),
			...(abortCause !== undefined ? { abortCause } : {}),
			...details,
		};
		await this.publishRecord(record);
	}

	private async publishRecord(record: RouteAttempt): Promise<void> {
		this.attempts.push(record);
		try {
			this.input.onAttempt?.(record);
		} catch {
			// Same rule as the observer: host bookkeeping must not fail a route.
		}
		try {
			await this.input.metrics?.recordAttempt(record);
		} catch {
			// A metrics failure must not fail a request that already succeeded.
		}
	}

	private backoff(retry: number): number {
		const base = this.input.policy.retryBackoffMs;
		if (base <= 0) {
			return 0;
		}
		return Math.min(
			this.input.policy.maxRetryBackoffMs,
			base * 2 ** Math.max(0, retry),
		);
	}

	private timeoutMessage(cause: RoutingAbortCause): string {
		const timeouts = this.input.policy.timeouts;
		switch (cause) {
			case 'first-token':
				return `The model did not produce data within ${timeouts.ttfbMs}ms`;
			case 'idle':
				return `The model stopped sending data for ${timeouts.idleMs}ms`;
			case 'total-time':
				return `The attempt exceeded ${timeouts.totalMs}ms`;
			case 'deadline':
				return `The route exceeded its ${this.input.policy.deadlineMs ?? 0}ms deadline`;
			case 'user-stop':
				return 'The request was cancelled';
		}
	}
}

/**
 * Reads the optional HTTP status a provider exposed.
 *
 * Never derived from a message: a status is structured data, and guessing one
 * from prose is how a 429 gets recorded as an authentication failure.
 */
function providerDetails(active: ActiveAttempt): {
	readonly httpStatus?: number;
	readonly retryAfterMs?: number;
} {
	const error = active.lastError;
	if (!(error instanceof ProviderError)) {
		return {};
	}
	const status = error.details?.status;
	const retryAfter = error.details?.retryAfterMs;
	return {
		...(typeof status === 'number' && Number.isInteger(status) ? { httpStatus: status } : {}),
		...(typeof retryAfter === 'number' && Number.isFinite(retryAfter)
			? { retryAfterMs: Math.max(0, retryAfter) }
			: {}),
	};
}

function normalizeAbortCause(reason: unknown): RoutingAbortCause {
	switch (reason) {
		case 'first-token':
		case 'idle':
		case 'total-time':
		case 'deadline':
		case 'user-stop':
			return reason;
		default:
			return 'user-stop';
	}
}

function abortError(): Error {
	const error = new Error('The route attempt was aborted');
	error.name = 'AbortError';
	return error;
}

/** Races a promise against a signal, because a fake provider may ignore it. */
function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		return Promise.reject(abortError());
	}
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const onAbort = (): void => {
			if (settled) {
				return;
			}
			settled = true;
			reject(abortError());
		};
		signal.addEventListener('abort', onAbort, { once: true });
		promise.then(
			(value) => {
				if (settled) {
					return;
				}
				settled = true;
				signal.removeEventListener('abort', onAbort);
				resolve(value);
			},
			(error: unknown) => {
				if (settled) {
					return;
				}
				settled = true;
				signal.removeEventListener('abort', onAbort);
				reject(error);
			},
		);
	});
}

/** The same race for an async iterator step. */
function nextWithSignal<T>(
	iterator: AsyncIterator<T>,
	signal: AbortSignal,
): Promise<IteratorResult<T>> {
	if (signal.aborted) {
		return Promise.reject(abortError());
	}
	return new Promise<IteratorResult<T>>((resolve, reject) => {
		let settled = false;
		const onAbort = (): void => {
			if (settled) {
				return;
			}
			settled = true;
			reject(abortError());
		};
		signal.addEventListener('abort', onAbort, { once: true });
		iterator.next().then(
			(value) => {
				if (settled) {
					return;
				}
				settled = true;
				signal.removeEventListener('abort', onAbort);
				resolve(value);
			},
			(error: unknown) => {
				if (settled) {
					return;
				}
				settled = true;
				signal.removeEventListener('abort', onAbort);
				reject(error);
			},
		);
	});
}

function closeIterator(iterator: AsyncIterator<ChatStreamEvent>): void {
	try {
		const result = iterator.return?.(undefined);
		if (result !== undefined) {
			void result.catch(() => undefined);
		}
	} catch {
		// Closing is best effort; the signal already told the producer to stop.
	}
}

function closeStream(stream: ChatStream): void {
	try {
		closeIterator(stream[Symbol.asyncIterator]());
	} catch {
		// A provider with a broken iterator is not worth a second failure.
	}
}

function closeLateStream(stream: ChatStream): void {
	closeStream(stream);
}

/**
 * Waits, returning false when the signal aborted the wait.
 *
 * A resolved `false` is not an error: the caller decides whether that was the
 * user or the route deadline, and each has a different terminal outcome.
 */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<boolean> {
	if (signal?.aborted === true) {
		return Promise.resolve(false);
	}
	if (ms <= 0) {
		return Promise.resolve(true);
	}
	return new Promise<boolean>((resolve) => {
		let settled = false;
		const finish = (value: boolean): void => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener('abort', onAbort);
			resolve(value);
		};
		const onAbort = (): void => finish(false);
		const timer = setTimeout(() => finish(true), ms);
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}
