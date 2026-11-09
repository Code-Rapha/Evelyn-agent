/**
 * Evaluation layer: evidence-based assessment, approach comparison,
 * confidence representation, and learning proposals.
 *
 * Pure, host-free, no network. Builds on experiment.ts types and functions.
 * No new runtime or storage. Reuses existing FileDataStore via evaluationLog.ts.
 */

import type {
	Experiment,
	ExperimentSession,
	ExperimentEvaluation,
	Evidence,
	SuccessCriterion,
	ExperimentBudget,
	BudgetConsumption,
	ExperimentVerdict,
	CriterionEvaluation,
} from './experiment';
import { evaluateExperiment } from './experiment';

import type { SelectableModel } from './modelSelector';
import type { OrchestrationStrategy } from './orchestrator';

/** Evidence classified by its relationship to a criterion. */
export type EvidenceRole =
	| 'supporting'      // Favors the criterion being met
	| 'contradicting'   // Suggests the criterion is not met
	| 'insufficient'    // Related but doesn't clearly support or contradict
	| 'unrelated';      // Not relevant to this criterion

/** A single evidence-to-criterion link with its classification. */
export interface EvidenceLink {
	readonly evidenceId: string;
	readonly criterionId: string;
	readonly role: EvidenceRole;
	readonly reason: string;
	/** Confidence in this classification (0..1). Based on evaluator judgment, not statistical. */
	readonly classificationConfidence: number;
}

/** Extended evaluation with evidence links and confidence. */
export interface DetailedEvaluation {
	readonly experimentId: string;
	readonly baseEvaluation: ExperimentEvaluation;
	/** Evidence linked to each criterion. */
	readonly evidenceLinks: readonly EvidenceLink[];
	/** Overall confidence in the verdict (0..1). Low when evidence is thin or conflicting. */
	readonly verdictConfidence: number;
	/** Explanation of confidence level. */
	readonly confidenceRationale: string;
	/** Criteria that could not be verified due to missing evidence. */
	readonly unverifiableCriteria: readonly string[];
	/** Whether evidence conflicts across criteria. */
	readonly hasConflictingEvidence: boolean;
}

/** Confidence classification for a conclusion. */
export type ConfidenceLevel =
	| 'well-supported'       // Multiple independent supporting evidences, no contradictions
	| 'provisional'          // Some support, but limited evidence or minor gaps
	| 'inconclusive'         // Insufficient evidence to decide
	| 'conflicting'          // Evidence points in different directions
	| 'insufficient-data';   // No relevant evidence at all

/** Result of comparing two or more experiments. */
export interface ExperimentComparison {
	readonly experimentIds: readonly string[];
	readonly compatible: boolean;
	readonly incompatibilityReason?: string;
	/** Per-criterion comparison (only for compatible experiments). */
	readonly criterionComparisons: readonly CriterionComparison[];
	/** Overall assessment. */
	readonly overallWinner?: string; // experimentId, or undefined if no clear winner
	readonly winnerReason: string;
	/** Resource comparison when available. */
	readonly resourceComparison: ResourceComparison;
	/** Caveats and limitations. */
	readonly caveats: readonly string[];
}

/** Comparison for a single criterion across experiments. */
export interface CriterionComparison {
	readonly criterionId: string;
	readonly description: string;
	readonly results: readonly ExperimentCriterionResult[];
	readonly winner?: string; // experimentId
	readonly winnerReason: string;
}

/** An experiment's result for a single criterion. */
export interface ExperimentCriterionResult {
	readonly experimentId: string;
	readonly passed: boolean;
	readonly actualValue: unknown;
	readonly evidenceQuality: 'direct' | 'indirect' | 'missing';
	readonly evidenceCount: number;
}

/** Resource consumption comparison. */
export interface ResourceComparison {
	readonly modelCalls: readonly ExperimentResource[];
	readonly tokensUsed: readonly ExperimentResource[];
	readonly durationMs: readonly ExperimentResource[];
	readonly toolCalls: readonly ExperimentResource[];
	readonly filesTouched: readonly ExperimentResource[];
}

/** Resource usage for one experiment. */
export interface ExperimentResource {
	readonly experimentId: string;
	readonly value: number | 'unknown';
}

/** A pattern observed across experiments that may be reusable. */
export interface LearningProposal {
	readonly id: string;
	readonly pattern: string;
	/** Context where the pattern was observed (task domain, complexity, capabilities). */
	readonly context: {
		readonly domain?: string;
		readonly complexity?: string;
		readonly requiredCapabilities?: readonly string[];
		readonly strategy?: OrchestrationStrategy;
	};
	/** Supporting and contradicting experiments. */
	readonly supportingExperiments: readonly string[];
	readonly contradictingExperiments: readonly string[];
	/** Explicit limitations. */
	readonly limitations: readonly string[];
	/** Cases not yet tested. */
	readonly untestedCases: readonly string[];
	/** Suggested reusability: skill, heuristic, model preference, etc. */
	readonly suggestedReuse: 'skill' | 'heuristic' | 'model-preference' | 'approach-template';
	/** Review level needed before acting on this proposal. */
	readonly reviewLevel: 'automated-check' | 'human-review' | 'expert-review';
	/** Timestamp when proposed. */
	readonly proposedAt: string;
}

/** Input for generating a learning proposal. */
export interface LearningProposalInput {
	readonly session: ExperimentSession;
	readonly pattern: string;
	readonly context: LearningProposal['context'];
	readonly supportingExperiments: readonly string[];
	readonly contradictingExperiments: readonly string[];
	readonly limitations: readonly string[];
	readonly untestedCases: readonly string[];
	readonly suggestedReuse: LearningProposal['suggestedReuse'];
	readonly reviewLevel: LearningProposal['reviewLevel'];
}

/** Extended evidence with explicit criterion associations. */
export interface ExtendedEvidence extends Evidence {
	/** Which criteria this evidence addresses (by criterion ID). */
	readonly addressesCriteria: readonly string[];
	/** Whether this evidence was manually linked or auto-associated. */
	readonly linkType: 'manual' | 'auto';
}

/** Associates evidence with criteria based on content matching and explicit links. */
export function linkEvidenceToCriteria(
	experiment: Experiment,
	getEvidenceData: (evidenceId: string) => unknown
): readonly EvidenceLink[] {
	const links: EvidenceLink[] = [];

	for (const criterion of experiment.criteria) {
		for (const evidence of experiment.evidence) {
			const data = getEvidenceData(evidence.id);
			const { role, reason, classificationConfidence } = classifyEvidenceRole(
				criterion,
				evidence,
				data
			);

			// Only create links for non-unrelated evidence, or all if explicitly addressed
			const addressesCriteria = isExtendedEvidence(evidence)
				? evidence.addressesCriteria
				: [];
			const explicitlyAddresses = addressesCriteria.includes(criterion.id);

			if (role !== 'unrelated' || explicitlyAddresses) {
				links.push({
					evidenceId: evidence.id,
					criterionId: criterion.id,
					role: explicitlyAddresses && role === 'unrelated' ? 'insufficient' : role,
					reason,
					classificationConfidence,
				});
			}
		}
	}

	return links;
}

/** Classifies how a piece of evidence relates to a criterion. */
function classifyEvidenceRole(
	criterion: SuccessCriterion,
	evidence: Evidence,
	data: unknown
): { role: EvidenceRole; reason: string; classificationConfidence: number } {
	if (data === undefined) {
		return {
			role: 'insufficient',
			reason: 'Evidence data unavailable',
			classificationConfidence: 0,
		};
	}

	const dataStr = String(data);
	const expectedStr = String(criterion.expected);

	switch (criterion.kind) {
		case 'exact-match': {
			const matches = JSON.stringify(data) === JSON.stringify(criterion.expected);
			if (matches) {
				return {
					role: 'supporting',
					reason: 'Exact match to expected value',
					classificationConfidence: 0.9,
				};
			}
			// Check if it's a clear contradiction (different value of same type)
			if (typeof data === typeof criterion.expected && data !== criterion.expected) {
				return {
					role: 'contradicting',
					reason: `Value differs from expected: got ${dataStr}`,
					classificationConfidence: 0.8,
				};
			}
			return {
				role: 'insufficient',
				reason: 'Value type differs from expected',
				classificationConfidence: 0.3,
			};
		}

		case 'contains': {
			const contains = dataStr.includes(expectedStr);
			if (contains) {
				return {
					role: 'supporting',
					reason: `Contains expected substring: ${expectedStr}`,
					classificationConfidence: 0.85,
				};
			}
			return {
				role: 'contradicting',
				reason: `Does not contain expected substring: ${expectedStr}`,
				classificationConfidence: 0.7,
			};
		}

		case 'regex': {
			const matches = new RegExp(expectedStr).test(dataStr);
			if (matches) {
				return {
					role: 'supporting',
					reason: `Matches regex pattern: ${expectedStr}`,
					classificationConfidence: 0.85,
				};
			}
			return {
				role: 'contradicting',
				reason: `Does not match regex pattern: ${expectedStr}`,
				classificationConfidence: 0.7,
			};
		}

		case 'threshold': {
			if (typeof data === 'number' && typeof criterion.expected === 'number' && criterion.operator) {
				let meets = false;
				switch (criterion.operator) {
					case 'gte': meets = data >= criterion.expected; break;
					case 'lte': meets = data <= criterion.expected; break;
					case 'gt': meets = data > criterion.expected; break;
					case 'lt': meets = data < criterion.expected; break;
				}
				if (meets) {
					return {
						role: 'supporting',
						reason: `Threshold ${criterion.operator} ${criterion.expected} met (value: ${data})`,
						classificationConfidence: 0.9,
					};
				}
				return {
					role: 'contradicting',
					reason: `Threshold ${criterion.operator} ${criterion.expected} not met (value: ${data})`,
					classificationConfidence: 0.8,
				};
			}
			return {
				role: 'insufficient',
				reason: 'Threshold check requires numeric values',
				classificationConfidence: 0.2,
			};
		}

		default:
			return {
				role: 'insufficient',
				reason: 'Custom criterion kind not supported for auto-classification',
				classificationConfidence: 0.1,
			};
	}
}

/** Type guard for extended evidence. */
function isExtendedEvidence(evidence: Evidence): evidence is ExtendedEvidence {
	return 'addressesCriteria' in evidence;
}

/** Creates a detailed evaluation with evidence links and confidence. */
export function createDetailedEvaluation(
	experiment: Experiment,
	getEvidenceData: (evidenceId: string) => unknown
): DetailedEvaluation {
	const baseEvaluation = evaluateExperiment(experiment, getEvidenceData);
	const evidenceLinks = linkEvidenceToCriteria(experiment, getEvidenceData);

	// Determine unverifiable criteria
	const criteriaWithLinks = new Set(evidenceLinks.map((l) => l.criterionId));
	const unverifiableCriteria = experiment.criteria
		.filter((c) => !criteriaWithLinks.has(c.id))
		.map((c) => c.id);

	// Conflicting evidence means one criterion was checked and pointed both ways.
	//
	// A single contradicting link is not a conflict — it is a check that failed,
	// which is the ordinary case for a failing experiment. Treating "some
	// evidence disagreed" as "the evidence disagrees with itself" would make
	// every genuine failure inconclusive, and a learning stage that refuses to
	// count real failures cannot learn anything from them.
	const criterionRoles = new Map<string, Set<EvidenceRole>>();
	for (const link of evidenceLinks) {
		const roles = criterionRoles.get(link.criterionId) ?? new Set<EvidenceRole>();
		roles.add(link.role);
		criterionRoles.set(link.criterionId, roles);
	}
	const hasConflictingEvidence = [...criterionRoles.values()].some(
		(roles) => roles.has('supporting') && roles.has('contradicting'),
	);

	// Calculate verdict confidence
	const { verdictConfidence, confidenceRationale } = calculateVerdictConfidence(
		baseEvaluation,
		evidenceLinks,
		unverifiableCriteria.length,
		hasConflictingEvidence,
		experiment.criteria.length
	);

	return {
		experimentId: experiment.id,
		baseEvaluation,
		evidenceLinks,
		verdictConfidence,
		confidenceRationale,
		unverifiableCriteria,
		hasConflictingEvidence,
	};
}

/** Calculates confidence in the verdict based on evidence quality. */
function calculateVerdictConfidence(
	baseEval: ExperimentEvaluation,
	links: readonly EvidenceLink[],
	unverifiableCount: number,
	hasConflicts: boolean,
	totalCriteria: number
): { verdictConfidence: number; confidenceRationale: string } {
	if (totalCriteria === 0) {
		return { verdictConfidence: 0, confidenceRationale: 'No criteria defined' };
	}

	const criteriaWithEvidence = totalCriteria - unverifiableCount;
	const coverage = criteriaWithEvidence / totalCriteria;

	// Base confidence from criterion pass rate and evidence coverage
	let confidence = baseEval.overallScore * coverage;

	// Penalize for conflicts
	if (hasConflicts) {
		confidence *= 0.6;
	}

	// Penalize for low classification confidence in links
	const avgLinkConfidence = links.length > 0
		? links.reduce((sum, l) => sum + l.classificationConfidence, 0) / links.length
		: 0;
	confidence *= (0.5 + 0.5 * avgLinkConfidence);

	// Determine level
	let level: ConfidenceLevel;
	let rationale: string;

	if (hasConflicts) {
		level = 'conflicting';
		rationale = 'Evidence contradicts itself across criteria';
	} else if (coverage < 0.5) {
		level = 'insufficient-data';
		rationale = `Only ${Math.round(coverage * 100)}% of criteria have evidence`;
	} else if (confidence >= 0.8 && coverage >= 0.9) {
		level = 'well-supported';
		rationale = 'High coverage with consistent supporting evidence';
	} else if (confidence >= 0.5) {
		level = 'provisional';
		rationale = 'Some support but limited evidence or gaps remain';
	} else {
		level = 'inconclusive';
		rationale = 'Insufficient evidence to reach a conclusion';
	}

	return { verdictConfidence: Math.max(0, Math.min(1, confidence)), confidenceRationale: `${level}: ${rationale}` };
}

/** Compares experiments that share the same objective and compatible criteria. */
export function compareExperiments(
	experiments: readonly Experiment[],
	detailedEvaluations: readonly DetailedEvaluation[],
	getEvidenceData: (evidenceId: string) => unknown
): ExperimentComparison {
	if (experiments.length < 2) {
		return {
			experimentIds: experiments.map((e) => e.id),
			compatible: false,
			incompatibilityReason: 'Need at least 2 experiments to compare',
			criterionComparisons: [],
			winnerReason: 'Insufficient experiments',
			resourceComparison: emptyResourceComparison(experiments.map((e) => e.id)),
			caveats: ['Cannot compare with fewer than 2 experiments'],
		};
	}

	// Check compatibility: same objective and criteria structure
	const first = experiments[0];
	const compatible = experiments.every((e) =>
		e.objective === first.objective &&
		e.criteria.length === first.criteria.length &&
		e.criteria.every((c, i) => c.id === first.criteria[i].id && c.kind === first.criteria[i].kind)
	);

	if (!compatible) {
		return {
			experimentIds: experiments.map((e) => e.id),
			compatible: false,
			incompatibilityReason: 'Experiments have different objectives or criteria structure',
			criterionComparisons: [],
			winnerReason: 'Experiments are not comparable',
			resourceComparison: buildResourceComparison(experiments),
			caveats: ['Different objectives or criteria prevent meaningful comparison'],
		};
	}

	// Compare each criterion
	const criterionComparisons: CriterionComparison[] = [];
	for (let i = 0; i < first.criteria.length; i++) {
		const criterion = first.criteria[i];
		const results: ExperimentCriterionResult[] = [];

		for (const exp of experiments) {
			const detEval = detailedEvaluations.find((d) => d.experimentId === exp.id);
			const criterionEval = detEval?.baseEvaluation.criterionEvaluations.find(
				(ce) => ce.criterionId === criterion.id
			);
			const relevantLinks = detEval?.evidenceLinks.filter((l) => l.criterionId === criterion.id) ?? [];

			results.push({
				experimentId: exp.id,
				passed: criterionEval?.passed ?? false,
				actualValue: criterionEval?.actualValue ?? undefined,
				evidenceQuality: relevantLinks.length > 0
					? relevantLinks.some((l) => l.role === 'supporting')
						? 'direct'
						: 'indirect'
					: 'missing',
				evidenceCount: relevantLinks.length,
			});
		}

		// Determine winner for this criterion
		const passed = results.filter((r) => r.passed);
		let winner: string | undefined;
		let winnerReason: string;

		if (passed.length === 1) {
			winner = passed[0].experimentId;
			winnerReason = 'Only experiment to satisfy this criterion';
		} else if (passed.length > 1) {
			// Prefer one with more direct evidence
			const withDirect = passed.filter((r) => r.evidenceQuality === 'direct');
			if (withDirect.length === 1) {
				winner = withDirect[0].experimentId;
				winnerReason = 'Satisfies criterion with direct evidence';
			} else {
				winnerReason = 'Multiple experiments satisfy; no clear winner';
			}
		} else {
			winnerReason = 'No experiment satisfies this criterion';
		}

		criterionComparisons.push({
			criterionId: criterion.id,
			description: criterion.description,
			results,
			winner,
			winnerReason,
		});
	}

	// Overall winner: experiment that wins most criteria with direct evidence
	const winnerScores = new Map<string, number>();
	for (const cc of criterionComparisons) {
		if (cc.winner) {
			const winnerResult = cc.results.find((r) => r.experimentId === cc.winner);
			const weight = winnerResult?.evidenceQuality === 'direct' ? 1.5 : 1;
			winnerScores.set(cc.winner, (winnerScores.get(cc.winner) ?? 0) + weight);
		}
	}

	let overallWinner: string | undefined;
	let maxScore = 0;
	for (const [expId, score] of winnerScores) {
		if (score > maxScore) {
			maxScore = score;
			overallWinner = expId;
		}
	}

	const winnerReason = overallWinner
		? `Won ${maxScore} weighted criteria`
		: 'No clear winner across criteria';

	// Build caveats
	const caveats: string[] = [];
	if (experiments.some((e) => e.consumption.tokensUsed === 'unknown')) {
		caveats.push('Token usage unknown for some experiments — resource comparison incomplete');
	}
	if (experiments.some((e) => e.consumption.durationMs === 0)) {
		caveats.push('Duration not recorded for some experiments');
	}
	if (criterionComparisons.some((cc) => cc.results.some((r) => r.evidenceQuality === 'missing'))) {
		caveats.push('Some criteria lack evidence in one or more experiments');
	}
	if (detailedEvaluations.some((d) => d.hasConflictingEvidence)) {
		caveats.push('Conflicting evidence present in some experiments');
	}
	if (maxScore < 2) {
		caveats.push('Weak differentiation — winner not strongly supported');
	}

	return {
		experimentIds: experiments.map((e) => e.id),
		compatible: true,
		criterionComparisons,
		overallWinner,
		winnerReason,
		resourceComparison: buildResourceComparison(experiments),
		caveats,
	};
}

function emptyResourceComparison(ids: readonly string[]): ResourceComparison {
	return {
		modelCalls: ids.map((id) => ({ experimentId: id, value: 0 })),
		tokensUsed: ids.map((id) => ({ experimentId: id, value: 'unknown' })),
		durationMs: ids.map((id) => ({ experimentId: id, value: 0 })),
		toolCalls: ids.map((id) => ({ experimentId: id, value: 0 })),
		filesTouched: ids.map((id) => ({ experimentId: id, value: 0 })),
	};
}

function buildResourceComparison(experiments: readonly Experiment[]): ResourceComparison {
	const ids = experiments.map((e) => e.id);
	return {
		modelCalls: experiments.map((e) => ({ experimentId: e.id, value: e.consumption.modelCalls })),
		tokensUsed: experiments.map((e) => ({ experimentId: e.id, value: e.consumption.tokensUsed })),
		durationMs: experiments.map((e) => ({ experimentId: e.id, value: e.consumption.durationMs })),
		toolCalls: experiments.map((e) => ({ experimentId: e.id, value: e.consumption.toolCalls })),
		filesTouched: experiments.map((e) => ({ experimentId: e.id, value: e.consumption.filesTouched })),
	};
}

/** Generates a learning proposal from a session's experiments. */
export function createLearningProposal(input: LearningProposalInput, now: string): LearningProposal {
	return {
		id: `learn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		pattern: input.pattern,
		context: input.context,
		supportingExperiments: input.supportingExperiments,
		contradictingExperiments: input.contradictingExperiments,
		limitations: input.limitations,
		untestedCases: input.untestedCases,
		suggestedReuse: input.suggestedReuse,
		reviewLevel: input.reviewLevel,
		proposedAt: now,
	};
}

/** Queries the session for experiments that match a pattern context. */
export function findExperimentsByContext(
	session: ExperimentSession,
	context: LearningProposal['context']
): readonly Experiment[] {
	const task = session.task;
	return session.experiments.filter((exp) => {
		if (context.domain && task.domain !== context.domain) return false;
		if (context.complexity && task.complexity !== context.complexity) return false;
		if (context.requiredCapabilities) {
			const hasAll = context.requiredCapabilities.every((rc) =>
				task.requiredCapabilities.includes(rc)
			);
			if (!hasAll) return false;
		}
		if (context.strategy && exp.strategy !== context.strategy) return false;
		return true;
	});
}

/** Checks if there's enough evidence to propose a pattern (minimum supporting experiments). */
export function canProposePattern(
	session: ExperimentSession,
	context: LearningProposal['context'],
	minSupporting: number = 3
): { canPropose: boolean; reason: string; matchingExperiments: readonly Experiment[] } {
	const matching = findExperimentsByContext(session, context);
	const completed = matching.filter((e) => e.state === 'completed' && e.evaluation);

	if (completed.length < minSupporting) {
		return {
			canPropose: false,
			reason: `Need at least ${minSupporting} completed experiments in context (found ${completed.length})`,
			matchingExperiments: completed,
		};
	}

	// Check for contradictions
	const passed = completed.filter((e) => e.evaluation?.verdict === 'passed');
	const failed = completed.filter((e) => e.evaluation?.verdict === 'failed');

	if (failed.length > 0 && passed.length / completed.length < 0.7) {
		return {
			canPropose: false,
			reason: `High failure rate (${failed.length}/${completed.length}) — pattern not reliable`,
			matchingExperiments: completed,
		};
	}

	return { canPropose: true, reason: 'Sufficient consistent evidence', matchingExperiments: completed };
}

