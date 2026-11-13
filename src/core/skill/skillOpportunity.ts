/**
 * Skill opportunity service: detects reusable procedures from conversation
 * and proposes them as new skills or improvements to existing ones.
 *
 * Design principles:
 * - Analyzes a bounded window of recent turns
 * - Returns structured proposals; it never writes a skill itself
 * - A caller may file a proposal for review, or — through the automatic
 *   learner's gates — record an `auto` decision and activate it
 * - Avoids duplicates by checking existing skills
 * - Token-efficient: simple heuristics, no extra model calls
 */
import type {
	SkillOpportunityInput,
	SkillOpportunityResult,
	SkillProposal,
	SkillOpportunityService,
	ConversationTurn,
	SkillEntry,
} from './types';
import { skillToolId } from './toolIds';

/** Default limits to keep analysis fast and token-cheap. */
const DEFAULT_MAX_TURNS = 10;
const DEFAULT_MAX_PROPOSALS = 3;
const MIN_STEPS_FOR_PROCEDURE = 2;

/** Simple stop-words for tokenization. */
const STOP_WORDS = new Set([
	'a', 'o', 'as', 'os', 'um', 'uma', 'uns', 'umas',
	'de', 'do', 'da', 'dos', 'das', 'em', 'no', 'na', 'nos', 'nas',
	'por', 'para', 'com', 'sem', 'sob', 'sobre', 'entre',
	'e', 'ou', 'mas', 'que', 'se', 'como', 'quando', 'onde',
	'this', 'that', 'the', 'and', 'or', 'but', 'in', 'on', 'at',
	'to', 'for', 'of', 'with', 'by', 'from', 'as', 'is', 'was',
]);

/**
 * Extracts meaningful tokens from text.
 */
function extractTokens(text: string): Set<string> {
	const normalized = text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	const tokens = normalized
		.split(' ')
		.filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
	return new Set(tokens);
}

/**
 * Identifies tool sequences from turns.
 * A sequence is the tool calls made by the assistant between user messages.
 * We track multiple sequences across the conversation to find recurring patterns.
 */
function extractToolSequences(turns: readonly ConversationTurn[]): string[][] {
	const sequences: string[][] = [];
	let currentSequence: string[] = [];

	for (const turn of turns) {
		if (turn.role === 'assistant' && turn.toolCalls && turn.toolCalls.length > 0) {
			for (const call of turn.toolCalls) {
				currentSequence.push(call.name);
			}
		} else if (turn.role === 'user' && currentSequence.length > 0) {
			// User message after tool calls ends the sequence
			sequences.push([...currentSequence]);
			currentSequence = [];
		}
	}
	if (currentSequence.length > 0) {
		sequences.push(currentSequence);
	}
	return sequences;
}

/** A recurring sequence, with how many times it was seen. */
interface RecurringSequence {
	readonly sequence: readonly string[];
	readonly observations: number;
}

/**
 * Finds recurring tool sequences (appearing 2+ times).
 *
 * The count travels with the sequence rather than being discarded: it is the
 * only evidence the caller has, and the confidence of the resulting proposal is
 * derived from it.
 */
function findRecurringSequences(sequences: string[][]): readonly RecurringSequence[] {
	const counts = new Map<string, number>();
	const firstSeen = new Map<string, string[]>();

	for (const seq of sequences) {
		const key = seq.join(' → ');
		counts.set(key, (counts.get(key) ?? 0) + 1);
		if (!firstSeen.has(key)) {
			firstSeen.set(key, seq);
		}
	}

	const recurring: RecurringSequence[] = [];
	for (const [key, count] of counts) {
		const seen = firstSeen.get(key);
		if (count >= 2 && seen !== undefined) {
			recurring.push({ sequence: seen, observations: count });
		}
	}
	return recurring;
}

/**
 * Extracts user intent patterns from user messages.
 */
// Map of canonical intent forms to their variations
const imperativeMap: Record<string, string[]> = {
	'criar': ['crie', 'criar', 'create', 'make'],
	'fazer': ['faça', 'fazer', 'make', 'do'],
	'executar': ['execute', 'executar', 'run'],
	'configurar': ['configure', 'configurar', 'config'],
	'implementar': ['implemente', 'implementar', 'implement'],
	'analisar': ['analise', 'analisar', 'analyze', 'analyse'],
	'revisar': ['revise', 'revisar', 'review'],
	'testar': ['teste', 'testar', 'test'],
	'construir': ['build', 'construir'],
	'implantar': ['deploy', 'implantar'],
};

// Build reverse map for quick lookup
const tokenToCanonical = new Map<string, string>();
for (const [canonical, variations] of Object.entries(imperativeMap)) {
	for (const v of variations) {
		tokenToCanonical.set(v, canonical);
	}
}

/** Resolves a token to its canonical intent, if it is one. */
function canonicalToken(token: string): string | undefined {
	return tokenToCanonical.get(token);
}

function extractUserIntents(turns: readonly ConversationTurn[]): Map<string, number> {
	const intents = new Map<string, number>();

	for (const turn of turns) {
		if (turn.role !== 'user') {continue;}

		const tokens = extractTokens(turn.content);

		for (const token of tokens) {
			const canonical = canonicalToken(token);
			if (canonical) {
				intents.set(canonical, (intents.get(canonical) ?? 0) + 1);
			}
		}
	}
	return intents;
}

/**
 * Confidence from the evidence, rather than a number chosen by feel.
 *
 * The two previous values — 0.7 for a sequence, 0.6 for an intent — were
 * constants: a pattern seen twice and one seen nine times carried the same
 * confidence, and the field could not be used to rank anything.
 *
 * The curve is bounded and monotonic, and it never reaches 1: a heuristic over
 * a short transcript is not proof, and a number that says otherwise invites the
 * caller to skip the review this whole service exists to require.
 *
 * The anchors are the contract, not a formula that happens to pass through
 * them. An earlier version rescaled `1 - 1/n` onto the band and, because the
 * denominator was the value at n=2, every observation count from two upwards
 * came out at the ceiling: the field that was meant to rank proposals was a
 * constant 0.85. Interpolating between the anchors below is what the comment
 * always claimed, and a test now asserts the two ends and one point between.
 *
 * - 2 observations (the minimum to be proposed at all) → 0.5
 * - 3 → 0.6
 * - 5 → 0.7
 * - 9 or more → 0.85
 */
const CONFIDENCE_FLOOR = 0.5;
const CONFIDENCE_CEILING = 0.85;

/** `[observations, confidence]`, ascending, with the floor and the ceiling. */
const CONFIDENCE_ANCHORS: readonly (readonly [number, number])[] = [
	[2, CONFIDENCE_FLOOR],
	[3, 0.6],
	[5, 0.7],
	[9, CONFIDENCE_CEILING],
];

function confidenceFrom(observations: number): number {
	if (!Number.isFinite(observations) || observations <= CONFIDENCE_ANCHORS[0]![0]) {
		return CONFIDENCE_FLOOR;
	}
	for (let index = 1; index < CONFIDENCE_ANCHORS.length; index++) {
		const previous = CONFIDENCE_ANCHORS[index - 1]!;
		const current = CONFIDENCE_ANCHORS[index]!;
		if (observations <= current[0]) {
			const span = current[0] - previous[0];
			const ratio = span === 0 ? 1 : (observations - previous[0]) / span;
			const value = previous[1] + (current[1] - previous[1]) * ratio;
			return Math.round(value * 100) / 100;
		}
	}
	return CONFIDENCE_CEILING;
}

/**
 * Generates a slug from text.
 */
function slugify(text: string): string {
	return text
		.toLowerCase()
		.trim()
		.replace(/[^\w\s-]/g, '')
		.replace(/[\s_-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 80);
}

/**
 * Checks if a proposal duplicates an existing skill.
 */
function isDuplicate(
	proposal: SkillProposal,
	existingSkills: readonly SkillEntry[],
): boolean {
	for (const skill of existingSkills) {
		if (skill.id === proposal.id) {return true;}
		if (skill.title.toLowerCase() === proposal.title.toLowerCase()) {return true;}
		// Tag overlap > 50%
		const commonTags = proposal.tags.filter((t) => skill.tags.includes(t));
		if (commonTags.length > 0 && commonTags.length / proposal.tags.length > 0.5) {
			return true;
		}
	}
	return false;
}

/**
 * Infers required tools from a tool sequence.
 *
 * The sequence holds call names as the transcript recorded them (`read_file`);
 * the proposal has to name skill ids (`fs.read`). The bridge lives in
 * `toolIds`, which the analyzer's catalog uses too, so the two cannot drift.
 */
function inferToolsFromSequence(sequence: string[]): string[] {
	return [...new Set(sequence.map(skillToolId))];
}

/**
 * Generates a skill proposal from a recurring tool sequence.
 */
function proposeFromSequence(
	sequence: string[],
	observations: number,
	turns: readonly ConversationTurn[],
	availableTools: readonly string[],
	existingSkills: readonly SkillEntry[],
): SkillProposal | null {
	const inferredTools = inferToolsFromSequence(sequence);
	// Only keep tools that are actually available
	const validTools = inferredTools.filter((t) => availableTools.includes(t));
	if (validTools.length === 0) {return null;}

	// Build a name from the sequence
	const nameParts = sequence.map((s) => s.replace(/_/g, '-')).slice(0, 3);
	const id = slugify(nameParts.join('-'));
	const title = nameParts
		.map((s) => s.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()))
		.join(' → ');

	// Check for existing skill improvement
	let improvesSkillId: string | undefined;
	for (const skill of existingSkills) {
		const skillTools = new Set(skill.requiredTools);
		const overlap = validTools.filter((t) => skillTools.has(t)).length;
		if (overlap > 0 && overlap / validTools.length >= 0.5) {
			improvesSkillId = skill.id;
			break;
		}
	}

	const objective = `Automatizar a sequência: ${sequence.join(' → ')}`;
	const justification =
		'Esta sequência de ferramentas apareceu múltiplas vezes na conversa recente, sugerindo um procedimento reutilizável.';

	const proposal: SkillProposal = {
		id,
		title,
		objective,
		justification,
		instructions: `# ${title}\n\n## Objetivo\n${objective}\n\n## Passos\n${sequence.map((s, i) => `${i + 1}. Execute \`${s}\``).join('\n')}\n\n## Ferramentas necessárias\n${validTools.map((t) => `- ${t}`).join('\n')}`,
		tags: ['automatizado', 'sequencia'],
		requiredTools: validTools,
		riskLevel: validTools.some((t) => t.includes('write') || t.includes('modify') || t.includes('delete') || t.includes('execute'))
			? 'moderate'
			: 'safe',
		constraints: [
			'Geração automática baseada em padrão observado',
			'Requer validação humana antes do uso em produção',
		],
		confidence: confidenceFrom(observations),
		observations,
		improvesSkillId,
	};

	if (isDuplicate(proposal, existingSkills)) {return null;}
	return proposal;
}

/**
 * Generates a skill proposal from user intent patterns.
 */
function proposeFromIntent(
	intent: string,
	observations: number,
	turns: readonly ConversationTurn[],
	availableTools: readonly string[],
	existingSkills: readonly SkillEntry[],
): SkillProposal | null {
	const id = slugify(intent);
	const relevantTurns = turns.filter((t) =>
		t.role === 'user' && [...extractTokens(t.content)].some((token) => canonicalToken(token) === intent),
	);

	// Extract tools used after this intent
	const toolsAfter: string[] = [];
	for (let i = 0; i < relevantTurns.length; i++) {
		const turnIdx = turns.indexOf(relevantTurns[i]);
		for (let j = turnIdx + 1; j < turns.length; j++) {
			const turn = turns[j];
			if (turn.role === 'assistant' && turn.toolCalls && turn.toolCalls.length > 0) {
				for (const call of turn.toolCalls) {
					toolsAfter.push(call.name);
				}
			}
		}
	}

	const toolCounts = new Map<string, number>();
	for (const t of toolsAfter) {toolCounts.set(t, (toolCounts.get(t) ?? 0) + 1);}
	const commonTools = [...toolCounts.entries()]
		.filter(([, c]) => c >= 2)
		.map(([t]) => t);

	// The raw names collected above are tool-call names; the proposal speaks in
	// skill tool IDs, so map them the same way the sequence path does.
	const validTools = inferToolsFromSequence(commonTools).filter((t) => availableTools.includes(t));
	if (validTools.length === 0) {return null;}

	let improvesSkillId: string | undefined;
	for (const skill of existingSkills) {
		const skillTools = new Set(skill.requiredTools);
		const overlap = validTools.filter((t) => skillTools.has(t)).length;
		if (overlap > 0 && overlap / validTools.length >= 0.5) {
			improvesSkillId = skill.id;
			break;
		}
	}

	const title = intent
		.split('-')
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(' ');
	const objective = `Procedimento para "${intent}" baseado em solicitações do usuário`;
	const justification = `O usuário solicitou "${intent}" múltiplas vezes com padrões similares de ferramentas.`;

	const proposal: SkillProposal = {
		id,
		title,
		objective,
		justification,
		instructions: `# ${title}\n\n## Objetivo\n${objective}\n\n## Passos sugeridos\n${validTools.map((t, i) => `${i + 1}. Execute \`${t}\``).join('\n')}\n\n## Ferramentas necessárias\n${validTools.map((t) => `- ${t}`).join('\n')}`,
		tags: ['procedimento', 'usuario'],
		requiredTools: validTools,
		riskLevel: validTools.some((t) => t.includes('write') || t.includes('modify') || t.includes('delete') || t.includes('execute'))
			? 'moderate'
			: 'safe',
		constraints: [
			'Baseado em padrão de solicitações do usuário',
			'Requer revisão e validação antes do uso',
		],
		confidence: confidenceFrom(observations),
		observations,
		improvesSkillId,
	};

	if (isDuplicate(proposal, existingSkills)) {return null;}
	return proposal;
}

/**
 * Creates a skill opportunity service.
 */
export function createSkillOpportunityService(): SkillOpportunityService {
	return {
		async analyze(input: SkillOpportunityInput): Promise<SkillOpportunityResult> {
			try {
				const limit = input.maxTurns ?? DEFAULT_MAX_TURNS;
				const maxTurns = Math.min(input.recentTurns.length, limit);
				const recentTurns = input.recentTurns.slice(-maxTurns);
				const availableTools = new Set(input.availableTools ?? []);
				const existingSkillIds = new Set(input.existingSkillIds ?? []);
				// The skills as the caller knows them, when it knows more than the
				// ids. `existingSkillIds` alone can only suppress a proposal whose
				// id matches exactly; a skill with a different id but the same
				// title, or more than half the same tags, is the same skill and
				// was proposed again on every scan.
				const existingSkills: readonly SkillEntry[] = input.existingSkills ?? [];

				const proposals: SkillProposal[] = [];

				// 1. Look for recurring tool sequences
				const sequences = extractToolSequences(recentTurns);
				const recurring = findRecurringSequences(sequences);

				for (const seen of recurring) {
					const proposal = proposeFromSequence(
						[...seen.sequence],
						seen.observations,
						recentTurns,
						[...availableTools],
						existingSkills,
					);
					if (proposal && !existingSkillIds.has(proposal.id)) {
						proposals.push(proposal);
					}
				}

				// 2. Look for recurring user intents
				const intents = extractUserIntents(recentTurns);
				const frequentIntents = [...intents.entries()]
					.filter(([, count]) => count >= 2)
					.sort(([, a], [, b]) => b - a)
					.slice(0, 3);

				for (const [intent, observations] of frequentIntents) {
					const proposal = proposeFromIntent(
						intent,
						observations,
						recentTurns,
						[...availableTools],
						existingSkills,
					);
					if (proposal && !existingSkillIds.has(proposal.id)) {
						// Check against already generated proposals
						if (!proposals.some((p) => p.id === proposal.id)) {
							proposals.push(proposal);
						}
					}
				}

				// Sort by confidence and limit
				proposals.sort((a, b) => b.confidence - a.confidence);
				const limited = proposals.slice(0, input.maxProposals ?? DEFAULT_MAX_PROPOSALS);

				return { ok: true, proposals: limited };
			} catch (error) {
				return {
					ok: false,
					proposals: [],
					error: error instanceof Error ? error.message : String(error),
				};
			}
		},
	};
}