/**
 * A `ChatProvider` that routes one request across several candidates.
 *
 * The provider is deliberately per turn, not per session. Once a candidate
 * produces visible content, `pinned` remembers it: the agent runtime calls
 * `streamChat` again after a tool round, and that second call must go to the
 * same model. A transcript produced by one model and continued by another is
 * not a fallback — it is a different conversation wearing the first one's
 * history.
 *
 * Retries on a pinned round are still allowed when they happen before the first
 * visible event: re-asking the same model is safe, while asking a different one
 * after a tool has run is not.
 */
import type { ChatProvider, ChatRequest, ChatStream } from '../chat/types';
import { CircuitBreaker } from './breaker';
import { runRoute } from './engine';
import type {
	BudgetGate,
	QuotaGate,
	RouteAttempt,
	RoutePolicy,
	RouteSleep,
	RouteTarget,
	RoutingClock,
	RoutingMetricsPort,
	RoutingObserver,
} from './types';

export interface RoutedChatProviderOptions {
	/** Ordered candidates. The first is the primary. */
	readonly targets: readonly RouteTarget[];
	readonly policy: RoutePolicy;
	readonly breaker: CircuitBreaker;
	readonly metrics?: RoutingMetricsPort;
	readonly observer?: RoutingObserver;
	readonly clock?: RoutingClock;
	readonly sleep?: RouteSleep;
	readonly routeId?: string;
	/** Vetoes a paid candidate before it is called. See `BudgetGate`. */
	readonly budget?: BudgetGate;
	/** A candidate whose rate limit is exhausted for a known window. See `QuotaGate`. */
	readonly quotas?: QuotaGate;
	/** Injected in tests so request ids are predictable. */
	readonly generateRequestId?: () => string;
}

export class RoutedChatProvider implements ChatProvider {
	private readonly options: RoutedChatProviderOptions;
	private readonly clock: RoutingClock;
	private readonly attemptsSoFar: RouteAttempt[] = [];
	private pinnedTargetValue: RouteTarget | undefined;
	private requestCounter = 0;

	constructor(options: RoutedChatProviderOptions) {
		this.options = options;
		this.clock = options.clock ?? Date.now;
	}

	/** The candidate that produced visible content, once one has. */
	get pinnedTarget(): RouteTarget | undefined {
		return this.pinnedTargetValue;
	}

	/** Every attempt this provider has run, across rounds. */
	get attempts(): readonly RouteAttempt[] {
		return this.attemptsSoFar;
	}

	async streamChat(
		request: ChatRequest,
		options: { readonly signal?: AbortSignal } = {},
	): Promise<ChatStream> {
		// After a tool round, only the model that produced the transcript may
		// continue it. The engine still applies retries to that one candidate,
		// but sees a list of one, so it cannot switch models.
		const targets =
			this.pinnedTargetValue !== undefined ? [this.pinnedTargetValue] : this.options.targets;

		return runRoute({
			request,
			targets,
			policy: this.options.policy,
			breaker: this.options.breaker,
			requestId: this.nextRequestId(),
			...(options.signal !== undefined ? { signal: options.signal } : {}),
			...(this.options.metrics !== undefined ? { metrics: this.options.metrics } : {}),
			...(this.options.observer !== undefined ? { observer: this.options.observer } : {}),
			clock: this.options.clock ?? this.clock,
			...(this.options.sleep !== undefined ? { sleep: this.options.sleep } : {}),
			...(this.options.routeId !== undefined ? { routeId: this.options.routeId } : {}),
			...(this.options.budget !== undefined ? { budget: this.options.budget } : {}),
			...(this.options.quotas !== undefined ? { quotas: this.options.quotas } : {}),
			onCommitted: (target) => {
				this.pinnedTargetValue = target;
			},
			onAttempt: (attempt) => {
				this.attemptsSoFar.push(attempt);
			},
		});
	}

	private nextRequestId(): string {
		if (this.options.generateRequestId !== undefined) {
			return this.options.generateRequestId();
		}
		this.requestCounter += 1;
		return `route-${this.clock()}-${this.requestCounter}`;
	}
}
