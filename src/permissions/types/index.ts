/**
 * Permission/policy boundary (Phase 1: types only — the full engine is NOT
 * implemented yet).
 *
 * The permission system is independent of the selected AI model/provider:
 * it classifies *actions* by risk and decides whether the agent runtime may
 * execute them. The agent is architecturally required to consult this
 * boundary before running any tool.
 */

export type PermissionLevel = 'automatic' | 'ask' | 'deny';

export type RiskLevel = 'safe' | 'moderate' | 'dangerous';

/**
 * Default policy mapping risk → level. A future PermissionService will let
 * users override this per tool/category via configuration.
 */
export const DEFAULT_PERMISSION_LEVEL_BY_RISK: Readonly<Record<RiskLevel, PermissionLevel>> = {
	safe: 'automatic',
	moderate: 'ask',
	dangerous: 'deny',
};

export interface PermissionRequest {
	/** Tool that wants to run, e.g. `fs.read` or `terminal.execute`. */
	readonly toolId: string;
	/** Concrete action within the tool, e.g. `read` or `executeCommand`. */
	readonly action: string;
	readonly riskLevel: RiskLevel;
	/** Human-readable summary shown when the user must confirm. */
	readonly summary: string;
	readonly details?: Readonly<Record<string, unknown>>;
}

export interface PermissionDecision {
	readonly outcome: 'granted' | 'denied';
	readonly level: PermissionLevel;
	readonly reason?: string;
}

export interface PermissionService {
	evaluate(request: PermissionRequest): Promise<PermissionDecision>;
}
