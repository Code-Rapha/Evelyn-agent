/**
 * Model orchestration policy.
 *
 * A pure function, host-free and UI-free: given what the server actually
 * offers (never invented metadata — the caller only passes what
 * `listAvailableModels` returned) and what has already failed this send,
 * it chooses the next eligible model.
 *
 * Two rules govern it:
 *
 * - Rotation never leaves the provider. The configured provider may be paid
 *   or long-documented; silently moving to another provider's model is a
 *   fallback the user never authorized.
 * - It suggests; it does not switch. The caller decides what the answer
 *   means — this module only orders the candidates.
 */

/** A model the server offered, exactly as `listAvailableModels` reports it. */
export interface EligibleModel {
	readonly providerId: string;
	readonly model: string;
}

export interface PickNextModelInput {
	/** The full list the server returned — real data, in server order. */
	readonly available: readonly EligibleModel[];
	/** Rotation candidates come from this provider only. */
	readonly providerId: string;
	/** The model the failed turn used, if any. */
	readonly current?: string;
	/**
	 * Models already tried and failed in this same send, oldest first.
	 * Skipped so a retry never loops back to a model that just failed.
	 */
	readonly failed?: readonly string[];
}

/**
 * The next model to try, or `undefined` when the provider has none left.
 *
 * Order: the server's own order (first in the list is the provider's own
 * preferred default), minus what already failed, minus the model that just
 * failed if it appears twice. There is no second ordering heuristic: any
 * "capability match" here would be invented, because the catalog entry the
 * UI keeps is user-declared, not server-declared.
 */
export function pickNextModel(input: PickNextModelInput): EligibleModel | undefined {
	const failed = new Set(input.failed ?? []);
	const candidates = input.available.filter(
		(entry) =>
			entry.providerId === input.providerId &&
			entry.model !== input.current &&
			!failed.has(entry.model),
	);
	return candidates[0];
}
