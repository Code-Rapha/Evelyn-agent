/**
 * The error the routing engine surfaces when it, not a provider, decided the
 * attempt was over.
 *
 * Providers already say why they failed, in their own types and messages. The
 * engine adds two things a consumer cannot reconstruct from prose: the closed
 * `ErrorClass` used by the policy, and — when a timer cut the attempt — the
 * `RoutingAbortCause` that names the budget. Both are optional-on-failure data,
 * never zeroed placeholders.
 */
import type { BudgetBlockedCandidate, ErrorClass, RouteAttempt, RoutingAbortCause } from './types';

export interface RoutingFailureOptions {
	readonly errorClass: ErrorClass;
	readonly abortCause?: RoutingAbortCause;
	/** The provider error, when there was one. */
	readonly cause?: unknown;
}

/**
 * One failed attempt, surfaced as the route's terminal error.
 *
 * `message` is deliberately the provider's own text when available: the UI
 * already knows how to display it, and replacing it with a generic "route
 * failed" would hide the one sentence that tells the user what to fix.
 */
export class RoutingFailure extends Error {
	readonly errorClass: ErrorClass;
	readonly abortCause?: RoutingAbortCause;

	constructor(message: string, options: RoutingFailureOptions) {
		super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
		this.name = 'RoutingFailure';
		this.errorClass = options.errorClass;
		if (options.abortCause !== undefined) {
			this.abortCause = options.abortCause;
		}
	}
}

/**
 * Tudo o que falta para um `RoutingFailure` de orçamento.
 *
 * Existe para que o terminal diga o que aconteceu — limite atingido — e não o
 * genérico "nenhum candidato respondeu", que faria o usuário procurar o
 * problema no provedor.
 */
export interface RouteExhaustedOptions extends RoutingFailureOptions {
	readonly attempts: readonly RouteAttempt[];
	readonly budgetBlocked?: readonly BudgetBlockedCandidate[];
}

/**
 * Every candidate was tried and none succeeded.
 *
 * Carries the attempt records so a caller can log an honest sequence instead of
 * the single class of the last failure. The records contain no credentials and
 * no message content.
 */
export class RouteExhaustedError extends RoutingFailure {
	readonly attempts: readonly RouteAttempt[];
	/**
	 * Candidates a budget vetoed, in order, with the reason the host gave.
	 *
	 * Kept apart from `attempts` because they were never called: folding them
	 * in would make "tried and failed" and "was not allowed to spend"
	 * indistinguishable to anything that reads the outcome.
	 */
	readonly budgetBlocked: readonly BudgetBlockedCandidate[];

	constructor(message: string, options: RouteExhaustedOptions) {
		super(message, options);
		this.name = 'RouteExhaustedError';
		this.attempts = options.attempts;
		this.budgetBlocked = options.budgetBlocked ?? [];
	}
}

/** Reads the routing cause from anything that carries one, safely. */
export function routingAbortCauseOf(error: unknown): RoutingAbortCause | undefined {
	if (typeof error !== 'object' || error === null) {
		return undefined;
	}
	const cause = (error as { readonly abortCause?: unknown }).abortCause;
	switch (cause) {
		case 'first-token':
		case 'idle':
		case 'total-time':
		case 'deadline':
		case 'user-stop':
			return cause;
		default:
			return undefined;
	}
}

/** Whether an error came from the routing engine rather than a provider. */
export function isRoutingFailure(error: unknown): error is RoutingFailure {
	return error instanceof RoutingFailure;
}
