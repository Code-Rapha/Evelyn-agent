/**
 * The permission gateway: the single seam between the agent and any decision
 * about whether an action may happen.
 *
 *   AgentRuntime → PermissionGateway → host implementation → allow / deny
 *
 * The Core decides nothing here. It builds a request rich enough for a person
 * to judge, hands it to whatever the host injected, and obeys the answer. A
 * desktop UI later implements `ask()` and shows a dialog; a script implements
 * it with a config file; a test implements it with a literal.
 *
 * Three rules:
 *
 * - A decision is always explicit. There is no default-allow, because a
 *   missing decision must never read as consent.
 * - Secrets never enter a request. Arguments are redacted by key name before
 *   they are surfaced, because a request may be shown on screen and logged.
 * - `riskLevel` is a hint to the implementation, not an automatic verdict.
 *   The Core does not read it to decide; only the injected policy does.
 */
import type { RiskLevel } from '../permissions/types';

/** Keys whose values are stripped before a request is surfaced. */
const SECRET_KEY_PATTERN =
	/(api[-_]?key|apikey|token|secret|password|passwd|authorization|auth|credential|cookie|private[-_]?key|session)/i;

/** Placeholder substituted for a redacted value. */
export const REDACTED = '[redacted]';

/** What the agent wants to do, in terms a person can judge. */
export interface PermissionRequest {
	/** The tool's stable id, e.g. `run_command`. */
	readonly toolId: string;
	/** The name the model used. */
	readonly toolName: string;
	/** One line describing the action, for a button label. */
	readonly action: string;
	/** Why this tool exists, for context above the question. */
	readonly description: string;
	/** Risk as declared by the tool. Advice, not a verdict. */
	readonly riskLevel: RiskLevel;
	/** Arguments with secret-looking values removed. */
	readonly arguments: Readonly<Record<string, unknown>>;
	/** The workspace the action would run in, when there is one. */
	readonly workspace?: string;
	/** The session asking, so a UI can group prompts. */
	readonly sessionId: string;
}

/** An explicit answer. There is no third option. */
export type PermissionDecision =
	| { readonly decision: 'allow'; readonly reason?: string }
	| { readonly decision: 'deny'; readonly reason: string };

/**
 * The port the runtime depends on.
 *
 * `ask` receives the signal so an implementation can abandon a prompt the user
 * walked away from; a UI that ignores it simply waits.
 */
export interface PermissionGateway {
	ask(request: PermissionRequest, options?: { readonly signal?: AbortSignal }): Promise<PermissionDecision>;
}

/** Type guard for a well-formed decision. */
export function isDecision(value: unknown): value is PermissionDecision {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const decision = (value as { decision?: unknown }).decision;
	return decision === 'allow' || decision === 'deny';
}

/**
 * Copies an argument map with secret-looking values replaced.
 *
 * Applied to everything a request carries, because the request may be shown on
 * screen, written to a log, or kept in a history file. Depth is bounded so a
 * deeply nested or cyclic argument cannot make this recurse forever.
 */
export function redactArguments(
	args: unknown,
	maxDepth = 6,
	seen = new WeakSet<object>(),
): Readonly<Record<string, unknown>> {
	if (typeof args !== 'object' || args === null) {
		return {};
	}
	if (seen.has(args)) {
		return { '[circular]': true };
	}
	seen.add(args);
	if (maxDepth <= 0) {
		return { '[truncated]': true };
	}

	const output: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
		if (SECRET_KEY_PATTERN.test(key)) {
			output[key] = REDACTED;
			continue;
		}
		if (Array.isArray(value)) {
			output[key] = value.map((item) =>
				typeof item === 'object' && item !== null
					? redactArguments(item, maxDepth - 1, seen)
					: SECRET_KEY_PATTERN.test(String(item))
						? REDACTED
						: item,
			);
			continue;
		}
		if (typeof value === 'object' && value !== null) {
			output[key] = redactArguments(value, maxDepth - 1, seen);
			continue;
		}
		output[key] = value;
	}
	return output;
}

/**
 * A gateway that asks a callback.
 *
 * This is how a host plugs in: the desktop app passes a function that opens a
 * dialog, a script passes one that reads a config file. The Core never learns
 * what is behind the callback.
 */
export function createCallbackGateway(
	ask: (request: PermissionRequest, options?: { readonly signal?: AbortSignal }) => Promise<PermissionDecision>,
): PermissionGateway {
	return { ask };
}

/**
 * Grants everything.
 *
 * For tests and for trusted single-user scripts. It is never a default: a host
 * has to choose it explicitly, so "no policy configured" cannot silently mean
 * "allow".
 */
export function allowAllGateway(): PermissionGateway {
	return {
		ask: async () => ({ decision: 'allow' }),
	};
}

/** Denies everything. Useful as a lockdown default and in tests. */
export function denyAllGateway(reason = 'denied by policy'): PermissionGateway {
	return {
		ask: async () => ({ decision: 'deny', reason }),
	};
}

/**
 * Answers from the risk mapping already defined in `core/permissions`.
 *
 * `safe` is allowed, `moderate` is delegated to `onAsk`, and `dangerous` is
 * denied. This is a *policy*, not a verdict baked into the Core: a host that
 * wants different rules injects a different gateway.
 */
export function createRiskGateway(options: {
	readonly onAsk: (request: PermissionRequest) => Promise<PermissionDecision>;
	readonly denyDangerous?: boolean;
	readonly denyReason?: string;
}): PermissionGateway {
	const denyDangerous = options.denyDangerous ?? true;
	const denyReason = options.denyReason ?? 'this action is classified as dangerous';

	return {
		ask: async (request, askOptions) => {
			switch (request.riskLevel) {
				case 'safe':
					return { decision: 'allow' };
				case 'dangerous':
					return denyDangerous
						? { decision: 'deny', reason: denyReason }
						: options.onAsk(request);
				case 'moderate':
					return options.onAsk(request);
			}
		},
	};
}
