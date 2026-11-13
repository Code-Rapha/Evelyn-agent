/**
 * The automatic learner's status, in the shape the bridge validates.
 *
 * The service keeps its settings grouped — `{ settings, learned }` — because
 * its own callers read them that way. The window's contract is flat: one
 * object, one question, one parser that can refuse a malformed payload. The
 * mapping has to exist somewhere, and the boundary is the honest place: the
 * Core does not learn the window's shape, and the window does not learn the
 * Core's.
 *
 * This module is separate from `main.ts` because `main.ts` imports Electron and
 * cannot be exercised under plain mocha. The mapping is the step that was
 * missing — the service's nested status reached the parser and was refused with
 * "the automatic learning status needs a boolean enabled" — so it is exactly
 * the step worth a test that does not need a window.
 */
import type { AutoSkillStatus } from '../core/skill/autoSkillService';
import type { AutoSkillStatusView } from './contract';

/**
 * Flattens the service's status for the preload.
 *
 * The learned entries are copied field by field rather than spread: a future
 * field on the service's record should reach the window only when someone
 * decides it should, not by accident.
 */
export function toAutoSkillStatusView(status: AutoSkillStatus): AutoSkillStatusView {
	return {
		enabled: status.settings.enabled,
		minConfidence: status.settings.minConfidence,
		maxAutoSkills: status.settings.maxAutoSkills,
		allowedTools: status.settings.allowedTools,
		learned: status.learned.map((entry) => ({
			skillId: entry.skillId,
			proposalId: entry.proposalId,
			title: entry.title,
			conversationId: entry.conversationId,
			observations: entry.observations,
			confidence: entry.confidence,
			learnedAt: entry.learnedAt,
			tools: entry.tools,
		})),
	};
}
