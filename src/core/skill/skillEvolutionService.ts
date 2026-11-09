/**
 * The controlled evolution service: the only writer of a live skill.
 *
 * ## The rule this file exists to enforce
 *
 * A skill changes because a person said so, in two separate acts:
 *
 *   propose → (validate) → approve → activate
 *
 * Neither half implies the other. `approve` records a decision and changes
 * nothing that the agent can see; `activate` writes the skill and refuses to
 * run until a proposal is in `approved` state with a decision attached. There
 * is no path here that reaches the live file from a pending proposal, and no
 * path that activates without a name and a reason on the decision.
 *
 * That is also why approval does not carry forward. A decision names one
 * proposal id; a different proposal has to be approved on its own, and
 * `activateProposal` checks the id it was handed rather than the id it would
 * like.
 *
 * ## What this does not do
 *
 * It does not run the proposed instructions, does not judge whether they are
 * better, and does not talk to a model. `validateEvolutionProposal` checks
 * structure and safety; whether a change actually improved anything is reported
 * as `effectivenessAutomaticallyProven: false`, because that is the truth and
 * inventing a number here would be the one way this whole mechanism could lie.
 */
import { ValidationError } from '../errors';
import type { SkillEntry, SkillService } from './types';
import {
	createEvolutionProposal,
	diffSkillContent,
	identifyImprovementOpportunities,
	nextPatchVersion,
	validateEvolutionProposal,
	type CreateEvolutionProposalInput,
	type EvolvedRunSummary,
	type ImprovementOpportunity,
	type ImprovementCriterion,
	type OpportunityScanInput,
	type OpportunityScanResult,
	type ProposalStatus,
	type ProposalValidation,
	type ProposedSkillContent,
	type SkillContentDiff,
	type SkillEvolutionProposal,
} from './skillEvolution';
import type { SkillEvolutionStore, SkillVersion } from './skillEvolutionStore';

/** Why a decision was recorded. Carried so the history is readable later. */
export interface ProposalDecision {
	readonly decidedBy: string;
	readonly reason: string;
}

/** Result of any evolution operation. */
export interface EvolutionResult {
	readonly ok: boolean;
	readonly error?: string;
	/** Findings from validation, when validation ran. */
	readonly validation?: ProposalValidation;
}

/** Result of an operation that returns something. */
export interface EvolutionProposalResult extends EvolutionResult {
	readonly proposal?: SkillEvolutionProposal;
}

export interface EvolutionProposalListResult extends EvolutionResult {
	readonly proposals: readonly SkillEvolutionProposal[];
}

export interface EvolutionVersionListResult extends EvolutionResult {
	readonly versions: readonly SkillVersion[];
}

export interface EvolutionDiffResult extends EvolutionResult {
	readonly diff?: SkillContentDiff;
}

export interface EvolutionActivationResult extends EvolutionResult {
	readonly skill?: SkillEntry;
	readonly version?: SkillVersion;
}

/** What the user should check before deciding. */
export interface EvolutionProposalDraft {
	readonly opportunity: ImprovementOpportunity;
	readonly proposed: ProposedSkillContent;
	readonly proposedVersion?: string;
	readonly expectedBenefits: readonly string[];
	readonly risks: readonly string[];
	readonly validationCriteria: readonly ImprovementCriterion[];
}

/** Options for creating the service. */
export interface SkillEvolutionServiceOptions {
	readonly skillService: SkillService;
	readonly store: SkillEvolutionStore;
	/** Injected so tests are not at the mercy of the clock. */
	readonly now?: () => string;
	/** Injected so ids are reproducible in tests. */
	readonly generateId?: () => string;
	/**
	 * The name recorded as the decider when the caller does not supply one.
	 *
	 * A default rather than a requirement, but it is written into every
	 * decision record: an activation with no author in the history is one nobody
	 * can audit later.
	 */
	readonly defaultDecider?: string;
}

/** The public surface of the evolution service. */
export interface SkillEvolutionService {
	/** Looks through the history and returns what looks improvable. */
	identifyOpportunities(input: OpportunityScanInput): Promise<OpportunityScanResult>;
	/** Turns one opportunity into a stored, pending proposal. */
	createProposal(draft: EvolutionProposalDraft): Promise<EvolutionProposalResult>;
	/** Every proposal, optionally narrowed to one status. */
	listProposals(status?: ProposalStatus): Promise<EvolutionProposalListResult>;
	/** One proposal. */
	getProposal(proposalId: string): Promise<EvolutionProposalResult>;
	/** Checks a stored proposal against the structural and safety rules. */
	validateProposal(proposalId: string): Promise<EvolutionResult>;
	/** What is live against what is proposed, field by field. */
	compareProposal(proposalId: string): Promise<EvolutionDiffResult>;
	/** Records a yes. Changes nothing that is live. */
	approveProposal(proposalId: string, decision: ProposalDecision): Promise<EvolutionProposalResult>;
	/** Records a no. Changes nothing that is live. */
	rejectProposal(proposalId: string, decision: ProposalDecision): Promise<EvolutionProposalResult>;
	/**
	 * Writes an approved proposal to the live skill.
	 *
	 * Refuses a proposal that is not `approved`, and refuses one whose recorded
	 * decision is missing. Both refusals are the mechanism; everything else in
	 * this file is bookkeeping.
	 */
	activateProposal(proposalId: string): Promise<EvolutionActivationResult>;
	/** A skill's archived versions, oldest first. */
	listVersions(skillId: string): Promise<EvolutionVersionListResult>;
	/** Puts a previously archived version back, and records the proposal as reverted. */
	rollbackToVersion(skillId: string, versionId: string, reason: string): Promise<EvolutionActivationResult>;
}

/** Builds a `CreateEvolutionProposalInput` from a caller-supplied draft. */
async function readCurrent(
	skillService: SkillService,
	skillId: string | undefined,
): Promise<{ version: string; instructions: string }> {
	if (skillId === undefined) {
		return { version: '', instructions: '' };
	}
	const skill = await skillService.getSkill(skillId);
	return { version: skill?.version ?? '', instructions: skill?.instructions ?? '' };
}

/** Projects a live skill into the content shape a proposal speaks in. */
function toProposedContent(skill: SkillEntry): ProposedSkillContent {
	return {
		title: skill.title,
		description: skill.description,
		instructions: skill.instructions,
		tags: skill.tags,
		requiredTools: skill.requiredTools,
		riskLevel: skill.riskLevel,
		constraints: skill.constraints ?? [],
	};
}

/** A version id that is unique within a skill without needing the clock twice. */
function makeVersionId(now: string, index: number): string {
	return `v-${now.replace(/[^0-9]/g, '')}-${index}`;
}

export function createSkillEvolutionService(options: SkillEvolutionServiceOptions): SkillEvolutionService {
	const { skillService, store } = options;
	const now = options.now ?? (() => new Date().toISOString());
	const decider = options.defaultDecider ?? 'the user';

	/** The one place a live skill is written for evolution. Archives first. */
	async function writeLive(
		proposal: SkillEvolutionProposal,
		content: ProposedSkillContent,
		version: string,
		reason: SkillVersion['reason'],
	): Promise<EvolutionActivationResult> {
		if (proposal.createsNewSkill) {
			if (proposal.skillId === undefined) {
				return { ok: false, error: 'a proposal for a new skill must name the skill it creates' };
			}
			// A new skill goes through the ordinary path, validation and all, so
			// the same field rules apply to a proposal as to a direct write.
			const created = await skillService.createSkill({ id: proposal.skillId, ...content, version });
			if (!created.ok || created.skill === undefined) {
				return { ok: false, error: created.error ?? 'the skill could not be created' };
			}
			const archived = await store.archiveVersion({
				versionId: makeVersionId(now(), 1),
				skillId: proposal.skillId,
				version,
				content,
				archivedAt: now(),
				reason,
				proposalId: proposal.id,
			});
			return { ok: true, skill: created.skill, version: archived };
		}

		const skillId = proposal.skillId;
		if (skillId === undefined) {
			return { ok: false, error: 'the proposal does not name a skill' };
		}

		// Archive what is live *before* overwriting it. If the write below fails,
		// rollback still has somewhere to go back to — which is the whole reason
		// the archive precedes the overwrite rather than following it.
		const live = await skillService.getSkill(skillId);
		if (live === undefined) {
			return { ok: false, error: `skill "${skillId}" no longer exists` };
		}
		const existingVersions = await store.listVersions(skillId);
		await store.archiveVersion({
			versionId: makeVersionId(now(), existingVersions.length + 1),
			skillId,
			version: live.version,
			content: toProposedContent(live),
			archivedAt: now(),
			reason,
			proposalId: proposal.id,
		});

		const updated = await skillService.updateSkill({
			id: skillId,
			title: content.title,
			description: content.description,
			instructions: content.instructions,
			version,
			tags: content.tags,
			requiredTools: content.requiredTools,
			riskLevel: content.riskLevel,
			constraints: content.constraints,
		});
		if (!updated.ok || updated.skill === undefined) {
			return { ok: false, error: updated.error ?? 'the skill could not be updated' };
		}

		const archived = await store.getLatestVersion(skillId);
		return { ok: true, skill: updated.skill, ...(archived !== undefined ? { version: archived } : {}) };
	}

	return {
		async identifyOpportunities(input) {
			try {
				const skills = await skillService.listSkills();
				const existing = skills.ok ? skills.skills : [];
				// Fingerprints of proposals still on the desk, so a rescan of the
				// same history does not re-raise a question already asked.
				const known = await store.listOpenFingerprints();
				return identifyImprovementOpportunities({
					...input,
					knownFingerprints: [...known, ...(input.knownFingerprints ?? [])],
					existingSkills:
						input.existingSkills ?? existing.map((skill) => ({ id: skill.id, instructions: skill.instructions })),
				});
			} catch (error) {
				return {
					ok: false,
					opportunities: [],
					runsConsidered: 0,
					error: error instanceof Error ? error.message : String(error),
				};
			}
		},

		async createProposal(draft) {
			try {
				const current = await readCurrent(skillService, draft.opportunity.skillId);
				const proposalId = options.generateId?.() ?? `skill-prop-${now()}`;

				const buildInput: CreateEvolutionProposalInput = {
					opportunity: draft.opportunity,
					currentVersion: current.version,
					currentInstructions: current.instructions,
					proposed: draft.proposed,
					proposedVersion: draft.proposedVersion ?? nextPatchVersion(current.version),
					expectedBenefits: draft.expectedBenefits,
					risks: draft.risks,
					validationCriteria: draft.validationCriteria,
					now: now(),
					generateId: () => proposalId,
				};
				const proposal = createEvolutionProposal(buildInput);

				// Validated before it is stored, not before it is approved. A
				// proposal that cannot pass should never reach the user's desk as
				// something to approve — the point of the queue is that everything
				// in it is worth reading.
				const validation = validateEvolutionProposal(proposal);
				if (!validation.ok) {
					return {
						ok: false,
						error: 'the proposal did not pass validation and was not stored',
						validation,
					};
				}

				const stored = await store.saveProposal(proposal);
				return { ok: true, proposal: stored, validation };
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		},

		async listProposals(status) {
			try {
				const all = await store.listProposals();
				const filtered = status === undefined ? all : all.filter((p) => p.status === status);
				return { ok: true, proposals: filtered };
			} catch (error) {
				return {
					ok: false,
					proposals: [],
					error: error instanceof Error ? error.message : String(error),
				};
			}
		},

		async getProposal(proposalId) {
			try {
				const proposal = await store.getProposal(proposalId);
				if (proposal === undefined) {
					return { ok: false, error: `no proposal with id "${proposalId}"` };
				}
				return { ok: true, proposal };
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		},

		async validateProposal(proposalId) {
			try {
				const proposal = await store.getProposal(proposalId);
				if (proposal === undefined) {
					return { ok: false, error: `no proposal with id "${proposalId}"` };
				}
				const validation = validateEvolutionProposal(proposal);
				return {
					ok: validation.ok,
					error: validation.ok ? undefined : 'the proposal does not pass validation',
					validation,
				};
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		},

		async compareProposal(proposalId) {
			try {
				const proposal = await store.getProposal(proposalId);
				if (proposal === undefined) {
					return { ok: false, error: `no proposal with id "${proposalId}"` };
				}
				const live =
					proposal.skillId === undefined
						? undefined
						: await skillService.getSkill(proposal.skillId);
				return {
					ok: true,
					diff: diffSkillContent(
						live === undefined ? undefined : toProposedContent(live),
						proposal.proposed,
					),
				};
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		},

		async approveProposal(proposalId, decision) {
			try {
				const proposal = await store.getProposal(proposalId);
				if (proposal === undefined) {
					return { ok: false, error: `no proposal with id "${proposalId}"` };
				}
				if (proposal.status !== 'pending') {
					return {
						ok: false,
						error: `only a pending proposal can be approved; this one is "${proposal.status}"`,
					};
				}
				assertDecision(decision);
				const updated = await store.updateProposal({
					...proposal,
					status: 'approved',
					decision: { ...decision, decidedAt: now() },
				});
				return { ok: true, proposal: updated };
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		},

		async rejectProposal(proposalId, decision) {
			try {
				const proposal = await store.getProposal(proposalId);
				if (proposal === undefined) {
					return { ok: false, error: `no proposal with id "${proposalId}"` };
				}
				if (proposal.status !== 'pending') {
					return {
						ok: false,
						error: `only a pending proposal can be rejected; this one is "${proposal.status}"`,
					};
				}
				assertDecision(decision);
				const updated = await store.updateProposal({
					...proposal,
					status: 'rejected',
					decision: { ...decision, decidedAt: now() },
				});
				return { ok: true, proposal: updated };
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		},

		async activateProposal(proposalId) {
			try {
				const proposal = await store.getProposal(proposalId);
				if (proposal === undefined) {
					return { ok: false, error: `no proposal with id "${proposalId}"` };
				}
				// The two refusals that matter. A pending proposal has never been
				// seen by a person, and a decision without a name is nobody's
				// decision; either way the live file is not touched.
				if (proposal.status !== 'approved') {
					return {
						ok: false,
						error: `proposal "${proposalId}" is "${proposal.status}"; only an approved proposal can be activated`,
					};
				}
				if (proposal.decision === undefined) {
					return {
						ok: false,
						error: `proposal "${proposalId}" was approved without a recorded decision`,
					};
				}
				const validation = validateEvolutionProposal(proposal);
				if (!validation.ok) {
					return {
						ok: false,
						error: 'the proposal no longer passes validation',
						validation,
					};
				}

				const result = await writeLive(
					proposal,
					proposal.proposed,
					proposal.proposedVersion,
					'activation',
				);
				if (!result.ok) {
					return result;
				}
				await store.updateProposal({ ...proposal, status: 'activated' });
				return result;
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		},

		async listVersions(skillId) {
			try {
				const versions = await store.listVersions(skillId);
				return { ok: true, versions };
			} catch (error) {
				return { ok: false, versions: [], error: error instanceof Error ? error.message : String(error) };
			}
		},

		async rollbackToVersion(skillId, versionId, reason) {
			try {
				if (typeof reason !== 'string' || reason.trim().length === 0) {
					return { ok: false, error: 'a rollback needs a reason' };
				}
				const versions = await store.listVersions(skillId);
				const target = versions.find((version) => version.versionId === versionId);
				if (target === undefined) {
					return {
						ok: false,
						error: `no version "${versionId}" for skill "${skillId}"`,
					};
				}
				// Rolling back to what is already live would archive a duplicate of
				// the current content and then write the same content over it.
				const live = await skillService.getSkill(skillId);
				if (live !== undefined && live.instructions === target.content.instructions) {
					return {
						ok: false,
						error: `version "${versionId}" is already the live content`,
					};
				}

				const existing = versions.length + 1;
				await store.archiveVersion({
					versionId: makeVersionId(now(), existing),
					skillId,
					version: live?.version ?? target.version,
					content:
						live === undefined
							? target.content
							: {
									title: live.title,
									description: live.description,
									instructions: live.instructions,
									tags: live.tags,
									requiredTools: live.requiredTools,
									riskLevel: live.riskLevel,
									constraints: live.constraints ?? [],
								},
					archivedAt: now(),
					reason: 'rollback',
				});

				const restored = await skillService.updateSkill({
					id: skillId,
					title: target.content.title,
					description: target.content.description,
					instructions: target.content.instructions,
					version: target.version,
					tags: target.content.tags,
					requiredTools: target.content.requiredTools,
					riskLevel: target.content.riskLevel,
					constraints: target.content.constraints,
				});
				if (!restored.ok || restored.skill === undefined) {
					return { ok: false, error: restored.error ?? 'the skill could not be restored' };
				}

				// Any proposal that claims to be the live content is now describing
				// something that is not live, so it is recorded as reverted rather
				// than left claiming to be in force.
				for (const proposal of await store.listProposals()) {
					if (proposal.skillId === skillId && proposal.status === 'activated') {
						await store.updateProposal({
							...proposal,
							status: 'reverted',
							decision: {
								decidedBy: decider,
								reason: `rolled back to ${target.versionId}: ${reason}`,
								decidedAt: now(),
							},
						});
					}
				}

				const archived = await store.getLatestVersion(skillId);
				return {
					ok: true,
					skill: restored.skill,
					...(archived !== undefined ? { version: archived } : {}),
				};
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
	};
}

/** A decision needs an author and a reason, or it is not a decision. */
function assertDecision(decision: ProposalDecision): void {
	if (typeof decision?.decidedBy !== 'string' || decision.decidedBy.trim().length === 0) {
		throw new ValidationError('a decision needs a non-empty decidedBy');
	}
	if (typeof decision.reason !== 'string' || decision.reason.trim().length === 0) {
		throw new ValidationError('a decision needs a non-empty reason');
	}
}

/** Re-exported so a caller can describe a run without importing two modules. */
export type { EvolvedRunSummary, ImprovementOpportunity, SkillEvolutionProposal, ProposalStatus };
