/**
 * The automatic learner: from a turn's transcript to a live skill.
 *
 * ## The whole path, and where each gate sits
 *
 *   transcript → analyzer → gate (`autoSkill.ts`) → proposal → approval → activation
 *
 * The analyzer and the gate are separate on purpose. The analyzer answers "is
 * there a pattern worth naming?"; the gate answers "may this particular pattern
 * become a skill without a person looking?" The second is narrower, and it is
 * the one that is allowed to say no.
 *
 * Approval and activation are the *same* two calls the manual path makes. This
 * service does not write a skill directly, does not skip validation, and does
 * not invent a third status. It records a decision with `decidedBy: 'auto'`
 * and then asks the evolution service to activate it, so the version history
 * and the audit trail both say a machine carried it on the user's behalf.
 *
 * ## What it will never do
 *
 * - Improve an existing skill. That changes instructions the user relies on;
 *   it stays a decision a person records.
 * - Learn a procedure that names a write, a command or a deletion. The gate's
 *   allowlist is read-only.
 * - Create a skill whose risk level is `safe`. The draft raises it to
 *   `moderate`, because `safe` is the value that skips a permission question
 *   elsewhere.
 * - Exceed `maxAutoSkills`. The count comes from the audit file, not from a
 *   number in memory that a restart would reset.
 *
 * ## Failure is reported, not thrown
 *
 * Every step returns a result object. A turn that cannot learn something must
 * still finish and answer; the caller gets `skipped` with a reason it can show,
 * and the turn's own outcome is untouched.
 */
import { skillToolIds } from './toolIds';
import { createSkillOpportunityService } from './skillOpportunity';
import type { SkillEvolutionService } from './skillEvolutionService';
import type { AutoSkillStore, AutoSkillRecord } from './autoSkillStore';
import {
	evaluateAutoSkill,
	toAutoSkillDraft,
	type AutoSkillSettings,
} from './autoSkill';
import type { ConversationTurn, SkillEntry, SkillService } from './types';

/** What the skills panel shows about this path. */
export interface AutoSkillStatus {
	readonly settings: AutoSkillSettings;
	readonly learned: readonly AutoSkillRecord[];
}

/** One skill that became live during a turn, for the turn's badge. */
export interface LearnedSkillNotice {
	readonly id: string;
	readonly title: string;
	readonly confidence: number;
	readonly proposalId: string;
}

/** Why one proposal was not learned. Shown, not swallowed. */
export interface AutoSkillSkip {
	readonly id: string;
	readonly reason: string;
}

/** What the learner needs from a finished turn. */
export interface AutoSkillLearnInput {
	/** The conversation the turn belongs to, for the audit trail. */
	readonly conversationId: string;
	/** The transcript as stored, including the turn that just finished. */
	readonly turns: readonly ConversationTurn[];
	/**
	 * The tool IDs registered for the turn, in the registry's vocabulary.
	 *
	 * These are descriptor ids (`read_file`); the analyzer speaks skill ids
	 * (`fs.read`), so the service bridges them with `skillToolIds` rather than
	 * asking every caller to remember the difference.
	 */
	readonly availableToolIds: readonly string[];
}

/** The outcome of one attempt to learn from a turn. */
export interface AutoSkillLearnResult {
	readonly learned: readonly LearnedSkillNotice[];
	readonly skipped: readonly AutoSkillSkip[];
	/** Set when the analysis itself could not run; `learned` is empty then. */
	readonly error?: string;
}

/** The service's surface. */
export interface AutoSkillService {
	/** The settings in force and every skill this path created. */
	status(): Promise<AutoSkillStatus>;
	/** Flips the switch. Off means `learn` writes nothing. */
	setEnabled(enabled: boolean): Promise<AutoSkillStatus>;
	/** Reads a transcript, applies the gate, and activates what it accepts. */
	learn(input: AutoSkillLearnInput): Promise<AutoSkillLearnResult>;
}

/** Options for creating the service. */
export interface AutoSkillServiceOptions {
	readonly skillService: SkillService;
	readonly evolution: SkillEvolutionService;
	readonly store: AutoSkillStore;
	/** Injected so tests are not at the mercy of the clock. */
	readonly now?: () => string;
}

/**
 * Creates the automatic learner.
 *
 * The analyzer is built here rather than injected: it is a pure function of the
 * transcript, and a caller that could swap it could also swap the vocabulary it
 * speaks. Tests exercise the real one.
 */
export function createAutoSkillService(options: AutoSkillServiceOptions): AutoSkillService {
	const { skillService, evolution, store } = options;
	const now = options.now ?? (() => new Date().toISOString());
	const analyzer = createSkillOpportunityService();

	async function status(): Promise<AutoSkillStatus> {
		const state = await store.load();
		return { settings: state.settings, learned: state.learned };
	}

	return {
		status,

		async setEnabled(enabled) {
			const settings = await store.setEnabled(enabled);
			const state = await store.load();
			return { settings, learned: state.learned };
		},

		async learn(input) {
			const state = await store.load();
			// Off is off: not "analyse and skip", because the analysis reads the
			// transcript and that is work the user asked not to happen.
			if (!state.settings.enabled) {
				return { learned: [], skipped: [] };
			}

			const listed = await skillService.listSkills();
			if (!listed.ok) {
				return {
					learned: [],
					skipped: [],
					error: listed.error ?? 'as skills existentes não puderam ser lidas',
				};
			}
			// Mutable copy: a skill created earlier in this same batch has to
			// count as existing for the next proposal, or two proposals from one
			// transcript could both create the same id.
			const existing: SkillEntry[] = [...listed.skills];

			const analysis = await analyzer.analyze({
				recentTurns: input.turns,
				existingSkills: existing,
				existingSkillIds: existing.map((skill) => skill.id),
				availableTools: [...skillToolIds(input.availableToolIds)],
			});
			if (!analysis.ok) {
				return {
					learned: [],
					skipped: [],
					error: analysis.error ?? 'a conversa não pôde ser analisada',
				};
			}

			const learned: LearnedSkillNotice[] = [];
			const skipped: AutoSkillSkip[] = [];
			let created = state.learned.length;

			for (const proposal of analysis.proposals) {
				const decision = evaluateAutoSkill(proposal, state.settings, {
					autoSkillsCreated: created,
					existingSkills: existing,
				});
				if (!decision.eligible) {
					skipped.push({
						id: proposal.id,
						reason: decision.reason ?? 'a proposta não passou nas regras do aprendizado automático',
					});
					continue;
				}

				const draft = toAutoSkillDraft(proposal, { conversationId: input.conversationId });
				const filed = await evolution.createProposal(draft);
				if (!filed.ok || filed.proposal === undefined) {
					skipped.push({
						id: proposal.id,
						reason: filed.error ?? 'a proposta não pôde ser registrada',
					});
					continue;
				}

				const proposalId = filed.proposal.id;
				const observations = proposal.observations ?? 0;
				const approved = await evolution.approveProposal(proposalId, {
					decidedBy: 'auto',
					reason:
						`procedimento somente-leitura observado ${observations} ` +
						`${observations === 1 ? 'vez' : 'vezes'}; ` +
						'aprendizado automático ligado pelo usuário',
				});
				if (!approved.ok) {
					skipped.push({
						id: proposal.id,
						reason: approved.error ?? 'a proposta não pôde ser aprovada',
					});
					continue;
				}

				const activated = await evolution.activateProposal(proposalId);
				if (!activated.ok) {
					skipped.push({
						id: proposal.id,
						reason: activated.error ?? 'a skill não pôde ser ativada',
					});
					continue;
				}

				const record: AutoSkillRecord = {
					skillId: proposal.id,
					proposalId,
					title: proposal.title,
					conversationId: input.conversationId,
					observations,
					confidence: proposal.confidence,
					learnedAt: now(),
					tools: [...proposal.requiredTools],
				};
				await store.recordLearned(record);

				learned.push({
					id: proposal.id,
					title: proposal.title,
					confidence: proposal.confidence,
					proposalId,
				});
				created += 1;
				if (activated.skill !== undefined) {
					existing.push(activated.skill);
				}
			}

			return { learned, skipped };
		},
	};
}
