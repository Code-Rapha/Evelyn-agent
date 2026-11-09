/**
 * Orchestration strategies: how the agent chooses and retries models.
 *
 * Two strategies in this stage:
 * - Manual: uses the user's explicit model choice, no automatic fallback.
 * - Fallback: tries the primary model, then falls back through candidates on recoverable errors.
 *
 * Pure, host-free, no network. The caller provides the task, available models, catalog,
 * and the error that occurred (if any).
 */

import type { TaskClassification } from './taskDiscovery';
import type { AvailableModel, AbortCause } from './contract';
import type { ModelCatalogEntry } from '../core/storage/types/modelCatalog';
import type { SelectableModel } from './modelSelector';
import { selectModels, isRecoverableError } from './modelSelector';
import type { ModelGuidanceEntry } from './modelGuidance';

export type OrchestrationStrategy = 'manual' | 'fallback';

export interface OrchestrationInput {
	readonly strategy: OrchestrationStrategy;
	readonly task: TaskClassification;
	readonly availableModels: readonly AvailableModel[];
	readonly catalog: readonly ModelCatalogEntry[];
	readonly manualChoice?: string;
	readonly maxAttempts?: number;
	readonly allowPaid?: boolean;
	/** O que a Evelyn escreveu sobre os modelos, no diálogo de preferências. */
	readonly guidance?: readonly ModelGuidanceEntry[];
}

export interface OrchestrationAttempt {
	readonly attempt: number;
	readonly model: SelectableModel;
	readonly error?: Error;
	readonly recoverable: boolean;
	readonly timestamp: string;
}

export interface OrchestrationResult {
	/** The model that was (or would be) used for the successful attempt. */
	readonly model: SelectableModel | undefined;
	/** All attempts made, in order. */
	readonly attempts: readonly OrchestrationAttempt[];
	/** Whether the orchestration exhausted its attempts without success. */
	readonly exhausted: boolean;
	/** The strategy that was applied. */
	readonly strategy: OrchestrationStrategy;
	/** Human-readable summary for logging. */
	readonly summary: string;
}

/**
 * Runs the orchestration for a single send.
 *
 * This is a pure function that *plans* the attempts. The actual execution
 * (calling the model, handling the stream) is done by the caller (chatSession).
 * The caller should call this once to get the plan, then execute attempts
 * and feed back errors to `continueOrchestration`.
 */
export function createOrchestrationPlan(input: OrchestrationInput): {
	readonly primary: SelectableModel | undefined;
	readonly candidates: readonly SelectableModel[];
	readonly reasons: readonly import('./modelSelector').SelectionReason[];
} {
	const { primary, fallbacks, reasons } = selectModels({
		task: input.task,
		availableModels: input.availableModels,
		catalog: input.catalog,
		manualChoice: input.manualChoice,
		maxCandidates: (input.maxAttempts ?? 3) - 1,
		allowPaid: input.allowPaid,
		...(input.guidance !== undefined ? { guidance: input.guidance } : {}),
	});
	return { primary, candidates: fallbacks, reasons };
}

/**
 * Continues the orchestration after an attempt failed.
 *
 * Returns the next model to try, or undefined if the orchestration should stop.
 * Also returns whether the error was recoverable (for logging).
 */
export function continueOrchestration(
	plan: { readonly primary: SelectableModel | undefined; readonly candidates: readonly SelectableModel[] },
	attempts: readonly OrchestrationAttempt[],
	error: Error,
	maxAttempts: number,
	strategy: OrchestrationStrategy,
	/**
	 * Why the attempt failed, when a timer or the user ended it.
	 *
	 * Read here rather than inferred from `error.message`, for the same reason
	 * `shouldFallback` reads it: the message is prose in one language and the
	 * recoverable markers are in another, so matching one against the other
	 * answers `false` for every real timeout.
	 */
	options: { readonly abortCause?: AbortCause } = {},
): { readonly nextModel: SelectableModel | undefined; readonly recoverable: boolean; readonly reason: string } {
	const lastAttempt = attempts[attempts.length - 1];

	// Manual strategy never falls back automatically
	if (strategy === 'manual') {
		return { nextModel: undefined, recoverable: false, reason: 'Manual strategy: no automatic fallback' };
	}

	// The user pressed Stop. Retrying elsewhere would override a decision they
	// just made, and it is checked first for that reason.
	if (options.abortCause === 'user-stop') {
		return { nextModel: undefined, recoverable: false, reason: 'O usuário interrompeu o turno' };
	}

	// A timer is recoverable in its own right. Checked before the message, because
	// the message is exactly the thing that failed to carry the fact.
	if (options.abortCause === 'first-token' || options.abortCause === 'total-time') {
		if (lastAttempt !== undefined && lastAttempt.recoverable && attempts.length < maxAttempts) {
			const triedModels = new Set(attempts.map((a) => `${a.model.providerId}:${a.model.modelId}`));
			const nextCandidate = plan.candidates.find(
				(c) => !triedModels.has(`${c.providerId}:${c.modelId}`),
			);
			if (nextCandidate !== undefined) {
				const because =
					options.abortCause === 'first-token'
						? 'Timeout esperando o primeiro token'
						: 'Tempo total do turno excedido';
				return {
					nextModel: nextCandidate,
					recoverable: true,
					reason: `${because} — trying next candidate`,
				};
			}
		}
	}

	const recoverable = isRecoverableError(error);

	// Non-recoverable error: stop
	if (!recoverable) {
		return { nextModel: undefined, recoverable: false, reason: `Non-recoverable error: ${error.message}` };
	}

	// Max attempts reached
	if (attempts.length >= maxAttempts) {
		return { nextModel: undefined, recoverable: true, reason: `Max attempts (${maxAttempts}) reached` };
	}

	// Check if the failed attempt already executed tools (has side effects)
	// The caller should indicate this via the attempt record, but we can't know here.
	// For safety, we don't retry if the error message suggests partial execution.
	//
	// A heuristic over the message, and the authoritative check is the
	// `hadToolCalls` flag `shouldFallback` was given upstream. Kept because a
	// standalone caller can still reach here, and refusing too often is the safe
	// direction to be wrong in.
	if (error.message.includes('tool') || error.message.includes('partial')) {
		return { nextModel: undefined, recoverable: true, reason: 'Possible side effects from tool execution — not retrying' };
	}

	// Get the next candidate
	const triedModels = new Set(attempts.map((a) => `${a.model.providerId}:${a.model.modelId}`));
	const nextCandidate = plan.candidates.find((c) => !triedModels.has(`${c.providerId}:${c.modelId}`));

	if (nextCandidate === undefined) {
		return { nextModel: undefined, recoverable: true, reason: 'No more fallback candidates' };
	}

	return { nextModel: nextCandidate, recoverable: true, reason: 'Recoverable error — trying next candidate' };
}

/**
 * Builds a summary of the orchestration for logging.
 */
export function summarizeOrchestration(result: OrchestrationResult): string {
	const parts: string[] = [];
	parts.push(`strategy=${result.strategy}`);
	if (result.model !== undefined) {
		parts.push(`model=${result.model.providerId}:${result.model.modelId}`);
	} else {
		parts.push('model=none');
	}
	parts.push(`attempts=${result.attempts.length}`);
	if (result.exhausted) parts.push('exhausted');
	else parts.push('result=success');
	const errors = result.attempts.filter((a) => a.error !== undefined);
	if (errors.length > 0) {
		parts.push(`errors=${errors.map((e) => e.error?.message.slice(0, 50)).join('; ')}`);
	}
	return parts.join('; ');
}