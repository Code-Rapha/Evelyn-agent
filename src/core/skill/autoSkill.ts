/**
 * The gate in front of automatic skill creation.
 *
 * ## What "automatic" is allowed to mean
 *
 * The user asked Evelyn to learn without being asked and without a click. That
 * is a real change: a skill is not a memory, it is an instruction the agent
 * follows. So the automatic path is narrower than the manual one, on purpose:
 *
 * - **Only a new skill.** Improving an existing skill changes instructions the
 *   user already relies on; that stays a decision a person records.
 * - **Only read-only tools.** A procedure built from reads can be repeated
 *   without touching the project. A write, a command or a deletion is not
 *   learned automatically, no matter how often it repeats.
 * - **Enough evidence.** Confidence is derived from the number of observations,
 *   and the floor is the point where a pattern has been seen three times.
 * - **Never `safe`.** A skill's risk level does not change the risk of the
 *   tools it names, but `safe` is also the value that skips the permission
 *   question in other paths. An automatically created skill is written as
 *   `moderate` at minimum, so nothing about it claims to need no attention.
 * - **A cap.** `maxAutoSkills` bounds how many skills this path can create in
 *   total, recorded in the audit file rather than inferred.
 *
 * Everything here is pure. The service that reads the transcript, files the
 * proposal and activates it lives in `autoSkillService.ts`; this file only
 * decides, so the decision can be tested without a disk or a clock.
 */
import type {
	ImprovementCriterion,
	ImprovementOpportunity,
	OpportunityStrength,
	ProposedSkillContent,
} from './skillEvolution';
import type { EvolutionProposalDraft } from './skillEvolutionService';
import type { SkillEntry, SkillProposal } from './types';

/**
 * The tool IDs an automatically learned skill may name.
 *
 * These are the read-only tools: filesystem reads and listings, skill and
 * memory reads, model catalog reads, and web reads. The names are the skill
 * vocabulary (`fs.read`), which is what a proposal speaks; a tool whose two
 * names differ is bridged by `toolIds.ts`.
 *
 * `web_search`, `open_webpage` and `browse_web` are network reads, not project
 * writes. They are allowed because repeating a research procedure is exactly
 * the kind of thing worth learning, and the tools themselves still carry their
 * own risk level when they run.
 */
export const READ_ONLY_TOOL_IDS: readonly string[] = [
	'fs.read',
	'fs.list',
	'fs.glob',
	'fs.grep',
	'skill.read',
	'skill.list',
	'memory.read',
	'memory.list',
	'list_models',
	'model_details',
	'recommend_model',
	'web_search',
	'open_webpage',
	'browse_web',
];

/** How the automatic learner is configured. */
export interface AutoSkillSettings {
	/** The switch in the skills panel. Off means this path writes nothing. */
	readonly enabled: boolean;
	/**
	 * The confidence a proposal needs before it may be activated automatically.
	 *
	 * `0.6` is the third observation on the analyzer's curve. Two observations
	 * are enough to *suggest* a skill; they are not enough to make one live
	 * without anyone looking.
	 */
	readonly minConfidence: number;
	/** How many skills this path may create in total. */
	readonly maxAutoSkills: number;
	/** The tools an automatically learned skill may name. */
	readonly allowedTools: readonly string[];
}

/** The defaults, and the values a missing or damaged config falls back to. */
export const DEFAULT_AUTO_SKILL_SETTINGS: AutoSkillSettings = {
	// The user asked for this path to be on. It stays visible and reversible in
	// the skills panel, and every skill it creates is recorded with `auto`.
	enabled: true,
	minConfidence: 0.6,
	maxAutoSkills: 10,
	allowedTools: READ_ONLY_TOOL_IDS,
};

/** What the gate needs to know beyond the proposal itself. */
export interface AutoSkillGateContext {
	/** How many skills this path has already created, from the audit file. */
	readonly autoSkillsCreated: number;
	/**
	 * The skills that exist now.
	 *
	 * The analyzer already suppresses duplicates, but the gate checks again:
	 * the analyzer and the gate are separate steps, and a skill created by the
	 * previous turn is exactly the case a stale analysis could miss.
	 */
	readonly existingSkills?: readonly SkillEntry[];
}

/** The gate's answer, with a reason a person can read when it says no. */
export interface AutoSkillDecision {
	readonly eligible: boolean;
	readonly reason?: string;
}

/**
 * Whether one proposal may be filed and activated without a person's click.
 *
 * The order matters for the reason the user sees: "it is off" is more useful
 * than "confidence is low" when the switch is what stopped it.
 */
export function evaluateAutoSkill(
	proposal: SkillProposal,
	settings: AutoSkillSettings,
	context: AutoSkillGateContext,
): AutoSkillDecision {
	if (!settings.enabled) {
		return { eligible: false, reason: 'o aprendizado automático está desligado' };
	}
	if (proposal.improvesSkillId !== undefined) {
		return {
			eligible: false,
			reason: `a proposta mudaria a skill existente "${proposal.improvesSkillId}"; melhorias continuam exigindo a sua decisão`,
		};
	}
	if (proposal.id.trim().length === 0) {
		return { eligible: false, reason: 'a proposta não tem um id utilizável como nome de arquivo' };
	}
	if (context.existingSkills?.some((skill) => skill.id === proposal.id) === true) {
		return { eligible: false, reason: `a skill "${proposal.id}" já existe` };
	}
	if (!(proposal.confidence >= settings.minConfidence)) {
		return {
			eligible: false,
			reason: `a confiança ${proposal.confidence} está abaixo do mínimo ${settings.minConfidence}`,
		};
	}
	if (proposal.requiredTools.length === 0) {
		return { eligible: false, reason: 'a proposta não nomeia nenhuma ferramenta' };
	}
	const outside = proposal.requiredTools.filter((tool) => !settings.allowedTools.includes(tool));
	if (outside.length > 0) {
		return {
			eligible: false,
			reason: `a proposta precisa de ${outside.join(', ')}, fora do conjunto somente-leitura`,
		};
	}
	if (context.autoSkillsCreated >= settings.maxAutoSkills) {
		return {
			eligible: false,
			reason: `o teto de ${settings.maxAutoSkills} skills aprendidas automaticamente foi atingido`,
		};
	}
	return { eligible: true };
}

/** Where the evidence for one automatic proposal came from. */
export interface AutoSkillDraftContext {
	/** The conversation the pattern was observed in, for the audit trail. */
	readonly conversationId: string;
}

/**
 * The strength of an observation, in the vocabulary the proposal uses.
 *
 * Copied from the analyzer's curve rather than invented here: two observations
 * are an observation, three a hypothesis, five a sustained pattern. The gate
 * already refuses below three, so an automatically filed proposal is at least
 * a hypothesis and says so.
 */
function strengthFor(observations: number): OpportunityStrength {
	if (observations >= 5) {
		return 'sustained-pattern';
	}
	if (observations >= 3) {
		return 'hypothesis';
	}
	return 'observation';
}

/** Keeps a generated text inside the validator's field limit. */
function clamp(value: string, limit: number): string {
	return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

/**
 * Turns one eligible proposal into the draft the evolution service files.
 *
 * The proposed content is the analyzer's, with three deliberate changes:
 *
 * - `riskLevel` is raised to `moderate` when it was `safe`;
 * - the tags gain `auto`, so a learned skill is identifiable in the list;
 * - the constraints gain a sentence saying it was learned automatically, so
 *   the file does not claim a human validation that did not happen.
 *
 * The instructions themselves are not rewritten. They are built by the
 * analyzer from tool names and the canonical intent, not from raw conversation
 * text, which is why this path does not turn a page the model read into an
 * instruction.
 */
export function toAutoSkillDraft(
	proposal: SkillProposal,
	context: AutoSkillDraftContext,
): EvolutionProposalDraft {
	const observations = proposal.observations ?? 2;
	const riskLevel = proposal.riskLevel === 'safe' ? 'moderate' : proposal.riskLevel;
	const tags = [...new Set([...proposal.tags, 'auto'])];
	const constraints = [
		...(proposal.constraints ?? []),
		'Criada automaticamente a partir de um padrão observado; o histórico registra a decisão como "auto".',
	];

	const opportunity: ImprovementOpportunity = {
		// The fingerprint is scoped to this path so it cannot collide with an
		// opportunity the manual scan files for the same words.
		fingerprint: `auto-skill:${proposal.id}`,
		kind: 'reusable-procedure',
		// No `skillId`: this proposal creates a skill rather than changing one.
		title: clamp(proposal.title, 200),
		problem: clamp(proposal.justification, 2_000),
		strength: strengthFor(observations),
		sampleSize: observations,
		// The run id names its source first: `createEvolutionProposal` reads
		// `conversation` from this prefix to fill `evidence.sources`.
		supportingRuns: [`conversation-${context.conversationId}`],
		domains: ['conversation'],
		untestedCases: [
			'outros tipos de tarefa; a proposta nasceu de uma conversa, não de uma execução avaliada',
			'casos em que a sequência aparece uma única vez',
		],
		generalizesBeyondSample: false,
		weight: proposal.confidence,
	};

	const proposed: ProposedSkillContent = {
		title: clamp(proposal.title, 200),
		description: clamp(proposal.objective, 500),
		instructions: proposal.instructions,
		tags,
		requiredTools: [...proposal.requiredTools],
		riskLevel,
		constraints,
	};

	const validationCriteria: readonly ImprovementCriterion[] = [
		{
			id: 'loads',
			description: 'A skill aparece na lista e pode ser carregada num turno.',
			observableAs:
				'Ela aparece em Skills disponíveis e é citada no selo do turno quando é relevante.',
		},
	];

	return {
		opportunity,
		proposed,
		createsNewSkill: true,
		newSkillId: proposal.id,
		expectedBenefits: [
			'Repetir o procedimento sem redescobrir a sequência de ferramentas.',
		],
		risks: [
			'Aprendida de um padrão de conversa, não de uma execução avaliada; pode não se aplicar a outros casos.',
			'Se o padrão era incidental, a skill acrescenta ruído ao contexto.',
		],
		validationCriteria,
	};
}
