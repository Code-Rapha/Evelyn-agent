/**
 * Experimentation engine: controlled cycles of hypothesis, execution and evaluation.
 *
 * Pure, host-free, no network. All state transitions are explicit. No hidden
 * runtime, no new storage. Integrates with existing FileDataStore for logging.
 */

import type { TaskClassification } from './taskDiscovery';
import type { OrchestrationStrategy } from './orchestrator';
import type { SelectableModel } from './modelSelector';

export type { TaskClassification } from './taskDiscovery';

/** Unique identifier for an experiment. */
export type ExperimentId = string & { readonly __brand: unique symbol };

/** Unique identifier for an experiment session (groups related experiments). */
export type ExperimentSessionId = string & { readonly __brand: unique symbol };

/** Types of evidence that can be recorded. */
export type EvidenceType =
	| 'model-output'
	| 'tool-result'
	| 'file-content'
	| 'metric'
	| 'observation'
	| 'error';

/** A single piece of evidence collected during an experiment. */
export interface Evidence {
	readonly id: string;
	readonly type: EvidenceType;
	readonly description: string;
	/** Raw data (JSON-serializable). Never includes secrets. */
	readonly data: unknown;
	readonly timestamp: string;
	/** Which experiment step produced this evidence. */
	readonly step: number;
}

/** Criteria that define success for an experiment. Defined BEFORE execution. */
export interface SuccessCriterion {
	readonly id: string;
	/** Human-readable description of what success looks like. */
	readonly description: string;
	/** Type of check to perform. */
	readonly kind: 'exact-match' | 'contains' | 'regex' | 'threshold' | 'custom';
	/** Expected value or pattern. Meaning depends on `kind`. */
	readonly expected: unknown;
	/** For threshold checks: 'gte' | 'lte' | 'gt' | 'lt'. */
	readonly operator?: 'gte' | 'lte' | 'gt' | 'lt';
	/** Weight in final evaluation (0..1). Sum should be 1. */
	readonly weight: number;
}

/** Budget limits for an experiment session. */
export interface ExperimentBudget {
	/** Max experiments in this session. */
	readonly maxExperiments: number;
	/** Max attempts per experiment. */
	readonly maxAttemptsPerExperiment: number;
	/** Max model calls across all experiments. */
	readonly maxModelCalls: number;
	/** Max estimated tokens (when available). */
	readonly maxTokens?: number;
	/** Max wall-clock duration in milliseconds. */
	readonly maxDurationMs: number;
	/** Max tool invocations. */
	readonly maxToolCalls: number;
	/** Max files that may be read/written. */
	readonly maxFilesTouched: number;
}

/** Current consumption against the budget. */
export interface BudgetConsumption {
	readonly experimentsStarted: number;
	readonly attemptsMade: number;
	readonly modelCalls: number;
	readonly tokensUsed: number | 'unknown';
	readonly durationMs: number;
	readonly toolCalls: number;
	readonly filesTouched: number;
}

/** Result of evaluating an experiment against its criteria. */
export type ExperimentVerdict = 'passed' | 'failed' | 'inconclusive';

/** Evaluation of a single criterion. */
export interface CriterionEvaluation {
	readonly criterionId: string;
	readonly passed: boolean;
	readonly actualValue: unknown;
	readonly reason: string;
}

/** Full evaluation result. */
export interface ExperimentEvaluation {
	readonly verdict: ExperimentVerdict;
	readonly criterionEvaluations: readonly CriterionEvaluation[];
	readonly overallScore: number; // 0..1 weighted sum
	readonly summary: string;
}

/** Actions that require explicit authorization before execution. */
export type RestrictedAction =
	| 'write-file'
	| 'execute-command'
	| 'delete-file'
	| 'network-request'
	| 'use-paid-model'
	| 'switch-provider'
	| 'exceed-budget';

/** Authorization decision. */
export interface AuthorizationRequest {
	readonly id: string;
	readonly action: RestrictedAction;
	readonly description: string;
	/** Additional context for the decision. */
	readonly context: Record<string, unknown>;
	readonly timestamp: string;
}

/** Result of an authorization request. */
export type AuthorizationDecision = 'granted' | 'denied' | 'deferred';

/** State of an experiment. */
export type ExperimentState =
	| 'defined'          // Objective, hypothesis, criteria defined
	| 'authorizing'      // Waiting for restricted action approval
	| 'executing'        // Running the experiment
	| 'evaluating'       // Checking criteria against evidence
	| 'completed'        // Finished with a verdict
	| 'interrupted'      // Stopped by budget, error, or user
	| 'abandoned';       // Explicitly abandoned

/** A single experiment within a session. */
export interface Experiment {
	readonly id: ExperimentId;
	readonly sessionId: ExperimentSessionId;
	readonly state: ExperimentState;
	/** The problem being investigated. */
	readonly objective: string;
	/** What we believe to be true and want to test. */
	readonly hypothesis: string;
	/** Information needed but not yet available. */
	readonly informationGaps: readonly string[];
	/** The approach to test the hypothesis. */
	readonly approach: string;
	/** Alternative approach if the first fails. */
	readonly alternative?: string;
	/** Success criteria defined BEFORE execution. */
	readonly criteria: readonly SuccessCriterion[];
	/** Models to use (provider:model). */
	readonly models: readonly string[];
	/** Orchestration strategy for this experiment. */
	readonly strategy: OrchestrationStrategy;
	/** Budget for this experiment (subset of session budget). */
	readonly budget: ExperimentBudget;
	/** Evidence collected so far. */
	readonly evidence: readonly Evidence[];
	/** Evaluation result (when completed). */
	readonly evaluation?: ExperimentEvaluation;
	/** Current budget consumption. */
	readonly consumption: BudgetConsumption;
	/** Pending authorization requests. */
	readonly pendingAuthorizations: readonly AuthorizationRequest[];
	/** Timestamps for lifecycle. */
	readonly createdAt: string;
	readonly startedAt?: string;
	readonly completedAt?: string;
	/** Step counter for evidence correlation. */
	readonly currentStep: number;
}

/** An experiment session groups related experiments toward a common goal. */
export interface ExperimentSession {
	readonly id: ExperimentSessionId;
	readonly task: TaskClassification;
	/** High-level goal for this session. */
	readonly goal: string;
	readonly experiments: readonly Experiment[];
	readonly budget: ExperimentBudget;
	readonly consumption: BudgetConsumption;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly status: 'active' | 'completed' | 'interrupted' | 'exhausted';
}

/** Input for creating a new experiment. */
export interface CreateExperimentInput {
	readonly sessionId: ExperimentSessionId;
	readonly objective: string;
	readonly hypothesis: string;
	readonly informationGaps: readonly string[];
	readonly approach: string;
	readonly alternative?: string;
	readonly criteria: readonly SuccessCriterion[];
	readonly models: readonly string[];
	readonly strategy: OrchestrationStrategy;
	readonly budget: ExperimentBudget;
}

/** Result of attempting a state transition. */
export type TransitionResult =
	| { readonly ok: true; readonly experiment: Experiment }
	| { readonly ok: false; readonly reason: string; readonly experiment: Experiment };

/** Checks if a budget would be exceeded by an action. */
export function checkBudget(
	consumption: BudgetConsumption,
	budget: ExperimentBudget,
	action: { modelCalls?: number; toolCalls?: number; filesTouched?: number; tokens?: number; durationMs?: number }
): { readonly allowed: boolean; readonly reason?: string } {
	if (consumption.experimentsStarted >= budget.maxExperiments) {
		return { allowed: false, reason: `Max experiments (${budget.maxExperiments}) reached` };
	}
	if (consumption.attemptsMade >= budget.maxAttemptsPerExperiment) {
		return { allowed: false, reason: `Max attempts per experiment (${budget.maxAttemptsPerExperiment}) reached` };
	}
	if (consumption.modelCalls + (action.modelCalls ?? 0) > budget.maxModelCalls) {
		return { allowed: false, reason: `Max model calls (${budget.maxModelCalls}) would be exceeded` };
	}
	if (budget.maxTokens !== undefined &&
		consumption.tokensUsed !== 'unknown' &&
		typeof consumption.tokensUsed === 'number' &&
		consumption.tokensUsed + (action.tokens ?? 0) > budget.maxTokens) {
		return { allowed: false, reason: `Max tokens (${budget.maxTokens}) would be exceeded` };
	}
	if (consumption.durationMs + (action.durationMs ?? 0) > budget.maxDurationMs) {
		return { allowed: false, reason: `Max duration (${budget.maxDurationMs}ms) would be exceeded` };
	}
	if (consumption.toolCalls + (action.toolCalls ?? 0) > budget.maxToolCalls) {
		return { allowed: false, reason: `Max tool calls (${budget.maxToolCalls}) would be exceeded` };
	}
	if (consumption.filesTouched + (action.filesTouched ?? 0) > budget.maxFilesTouched) {
		return { allowed: false, reason: `Max files touched (${budget.maxFilesTouched}) would be exceeded` };
	}
	return { allowed: true };
}

/** Records consumption after an action completes. */
export function recordConsumption(
	consumption: BudgetConsumption,
	action: { modelCalls?: number; toolCalls?: number; filesTouched?: number; tokens?: number; durationMs?: number }
): BudgetConsumption {
	return {
		experimentsStarted: consumption.experimentsStarted,
		attemptsMade: consumption.attemptsMade + (action.modelCalls ? 1 : 0), // Simplified: each model call = attempt
		modelCalls: consumption.modelCalls + (action.modelCalls ?? 0),
		tokensUsed: consumption.tokensUsed === 'unknown' || action.tokens === undefined
			? 'unknown'
			: (typeof consumption.tokensUsed === 'number' ? consumption.tokensUsed : 0) + action.tokens,
		durationMs: consumption.durationMs + (action.durationMs ?? 0),
		toolCalls: consumption.toolCalls + (action.toolCalls ?? 0),
		filesTouched: consumption.filesTouched + (action.filesTouched ?? 0),
	};
}

/** Creates a new experiment with initial state. */
export function createExperiment(input: CreateExperimentInput, now: string): Experiment {
	const initialConsumption: BudgetConsumption = {
		experimentsStarted: 0,
		attemptsMade: 0,
		modelCalls: 0,
		tokensUsed: 'unknown',
		durationMs: 0,
		toolCalls: 0,
		filesTouched: 0,
	};

	return {
		id: `exp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` as ExperimentId,
		sessionId: input.sessionId,
		state: 'defined',
		objective: input.objective,
		hypothesis: input.hypothesis,
		informationGaps: input.informationGaps,
		approach: input.approach,
		alternative: input.alternative,
		criteria: input.criteria,
		models: input.models,
		strategy: input.strategy,
		budget: input.budget,
		evidence: [],
		consumption: initialConsumption,
		pendingAuthorizations: [],
		createdAt: now,
		currentStep: 0,
	};
}

/** Creates a new experiment session. */
export function createExperimentSession(
	task: TaskClassification,
	goal: string,
	budget: ExperimentBudget,
	now: string
): ExperimentSession {
	const initialConsumption: BudgetConsumption = {
		experimentsStarted: 0,
		attemptsMade: 0,
		modelCalls: 0,
		tokensUsed: 'unknown',
		durationMs: 0,
		toolCalls: 0,
		filesTouched: 0,
	};

	return {
		id: `exp-session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` as ExperimentSessionId,
		task,
		goal,
		experiments: [],
		budget,
		consumption: initialConsumption,
		createdAt: now,
		updatedAt: now,
		status: 'active',
	};
}

/** Validates that criteria are well-formed before execution. */
export function validateCriteria(criteria: readonly SuccessCriterion[]): { readonly valid: boolean; readonly errors: readonly string[] } {
	const errors: string[] = [];
	let totalWeight = 0;

	for (const c of criteria) {
		if (c.weight < 0 || c.weight > 1) {
			errors.push(`Criterion ${c.id}: weight must be between 0 and 1`);
		}
		totalWeight += c.weight;
		if (c.kind === 'threshold' && c.operator === undefined) {
			errors.push(`Criterion ${c.id}: threshold kind requires an operator`);
		}
		if (c.kind === 'custom') {
			errors.push(`Criterion ${c.id}: custom kind not supported in this version`);
		}
	}

	if (Math.abs(totalWeight - 1) > 0.001 && criteria.length > 0) {
		errors.push(`Criteria weights must sum to 1 (got ${totalWeight.toFixed(3)})`);
	}

	return { valid: errors.length === 0, errors };
}

/** Transitions experiment state. Pure function - returns new experiment. */
export function transitionExperiment(
	experiment: Experiment,
	newState: ExperimentState,
	now: string,
	options?: { evidence?: Evidence; evaluation?: ExperimentEvaluation }
): TransitionResult {
	// Valid state transitions
	const validTransitions: Record<ExperimentState, readonly ExperimentState[]> = {
		defined: ['authorizing', 'executing', 'abandoned'],
		authorizing: ['executing', 'interrupted', 'abandoned'],
		executing: ['evaluating', 'interrupted', 'abandoned'],
		evaluating: ['completed', 'interrupted', 'abandoned'],
		completed: [],
		interrupted: ['abandoned'],
		abandoned: [],
	};

	if (!validTransitions[experiment.state].includes(newState)) {
		return {
			ok: false,
			reason: `Invalid state transition: ${experiment.state} -> ${newState}`,
			experiment,
		};
	}

	const updated: Experiment = {
		...experiment,
		state: newState,
		...(newState === 'executing' && experiment.startedAt === undefined ? { startedAt: now } : {}),
		...(newState === 'completed' || newState === 'interrupted' || newState === 'abandoned'
			? { completedAt: now }
			: {}),
		...(options?.evidence ? { evidence: [...experiment.evidence, options.evidence] } : {}),
		...(options?.evaluation ? { evaluation: options.evaluation } : {}),
		...(newState === 'executing' ? { currentStep: experiment.currentStep + 1 } : {}),
	};

	return { ok: true, experiment: updated };
}

/** Adds evidence to an experiment. */
export function addEvidence(
	experiment: Experiment,
	evidence: Omit<Evidence, 'id' | 'timestamp'>,
	now: string
): Experiment {
	return {
		...experiment,
		evidence: [
			...experiment.evidence,
			{
				...evidence,
				id: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
				timestamp: now,
			},
		],
	};
}

/** Adds a pending authorization request. */
export function requestAuthorization(
	experiment: Experiment,
	request: Omit<AuthorizationRequest, 'id' | 'timestamp'>,
	now: string
): Experiment {
	return {
		...experiment,
		state: 'authorizing',
		pendingAuthorizations: [
			...experiment.pendingAuthorizations,
			{
				...request,
				id: `auth-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
				timestamp: now,
			},
		],
	};
}

/** Resolves an authorization request. */
export function resolveAuthorization(
	experiment: Experiment,
	authorizationId: string,
	decision: AuthorizationDecision,
	now: string
): TransitionResult {
	const request = experiment.pendingAuthorizations.find((a) => a.id === authorizationId);
	if (!request) {
		return {
			ok: false,
			reason: `Authorization request ${authorizationId} not found`,
			experiment,
		};
	}

	if (decision === 'denied') {
		return transitionExperiment(experiment, 'interrupted', now);
	}

	if (decision === 'granted') {
		const remaining = experiment.pendingAuthorizations.filter((a) => a.id !== authorizationId);
		const updatedExperiment = { ...experiment, pendingAuthorizations: remaining };
		if (remaining.length === 0) {
			return transitionExperiment(updatedExperiment, 'executing', now);
		}
		return { ok: true, experiment: updatedExperiment };
	}

	// deferred - keep in authorizing state
	return { ok: true, experiment };
}

/** Evaluates an experiment against its criteria. */
export function evaluateExperiment(
	experiment: Experiment,
	getEvidenceData: (evidenceId: string) => unknown
): ExperimentEvaluation {
	if (experiment.criteria.length === 0) {
		return {
			verdict: 'inconclusive',
			criterionEvaluations: [],
			overallScore: 0,
			summary: 'No success criteria defined',
		};
	}

	const evaluations: CriterionEvaluation[] = [];
	let totalWeight = 0;
	let weightedScore = 0;

	for (const criterion of experiment.criteria) {
		// Find relevant evidence for this criterion (by step, or latest if not specified)
		// The criterion doesn't specify which evidence, so we use the latest evidence
		const relevantEvidence = experiment.evidence[experiment.evidence.length - 1];

		const actualValue = relevantEvidence ? getEvidenceData(relevantEvidence.id) : undefined;
		let passed = false;
		let reason = 'No relevant evidence found';

		if (relevantEvidence && actualValue !== undefined) {
			switch (criterion.kind) {
				case 'exact-match':
					passed = JSON.stringify(actualValue) === JSON.stringify(criterion.expected);
					reason = passed ? 'Exact match' : `Expected ${JSON.stringify(criterion.expected)}, got ${JSON.stringify(actualValue)}`;
					break;
				case 'contains':
					passed = String(actualValue).includes(String(criterion.expected));
					reason = passed ? 'Contains expected value' : `Expected to contain ${String(criterion.expected)}, got ${String(actualValue)}`;
					break;
				case 'regex':
					passed = new RegExp(String(criterion.expected)).test(String(actualValue));
					reason = passed ? 'Regex match' : `Regex ${String(criterion.expected)} did not match ${String(actualValue)}`;
					break;
				case 'threshold':
					if (typeof actualValue === 'number' && typeof criterion.expected === 'number') {
						switch (criterion.operator) {
							case 'gte': passed = actualValue >= criterion.expected; break;
							case 'lte': passed = actualValue <= criterion.expected; break;
							case 'gt': passed = actualValue > criterion.expected; break;
							case 'lt': passed = actualValue < criterion.expected; break;
						}
						reason = passed
							? `Threshold ${criterion.operator} ${criterion.expected} met (value: ${actualValue})`
							: `Threshold ${criterion.operator} ${criterion.expected} not met (value: ${actualValue})`;
					} else {
						reason = 'Threshold check requires numeric values';
					}
					break;
			}
		}

		evaluations.push({ criterionId: criterion.id, passed, actualValue, reason });
		totalWeight += criterion.weight;
		if (passed) weightedScore += criterion.weight;
	}

	const overallScore = totalWeight > 0 ? weightedScore / totalWeight : 0;
	let verdict: ExperimentVerdict;
	if (overallScore >= 0.8) verdict = 'passed';
	else if (overallScore <= 0.3) verdict = 'failed';
	else verdict = 'inconclusive';

	const summary = evaluations.map((e) => `${e.criterionId}: ${e.passed ? 'PASS' : 'FAIL'} - ${e.reason}`).join('; ');

	return { verdict, criterionEvaluations: evaluations, overallScore, summary };
}

/** Checks if two experiments are equivalent (same hypothesis + approach). */
export function areExperimentsEquivalent(a: Experiment, b: Experiment): boolean {
	return a.hypothesis === b.hypothesis && a.approach === b.approach;
}

/** Determines if a session can continue or must stop. */
export function checkSessionStatus(session: ExperimentSession): ExperimentSession['status'] {
	if (session.status !== 'active') return session.status;

	// Check if budget exhausted
	if (session.consumption.experimentsStarted >= session.budget.maxExperiments) return 'exhausted';
	if (session.consumption.modelCalls >= session.budget.maxModelCalls) return 'exhausted';
	if (session.budget.maxTokens !== undefined &&
		session.consumption.tokensUsed !== 'unknown' &&
		typeof session.consumption.tokensUsed === 'number' &&
		session.consumption.tokensUsed >= session.budget.maxTokens) return 'exhausted';
	if (session.consumption.durationMs >= session.budget.maxDurationMs) return 'exhausted';
	if (session.consumption.toolCalls >= session.budget.maxToolCalls) return 'exhausted';
	if (session.consumption.filesTouched >= session.budget.maxFilesTouched) return 'exhausted';

	return 'active';
}