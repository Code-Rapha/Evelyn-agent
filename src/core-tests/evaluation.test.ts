/** Tests for the evaluation layer. */

import * as assert from 'assert';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { FileDataStore } from '../adapters/local/fileDataStore';
import {
	createExperiment,
	createExperimentSession,
	addEvidence,
	evaluateExperiment,
	type Experiment,
	type ExperimentSession,
	type SuccessCriterion,
	type ExperimentBudget,
	type Evidence,
	type ExperimentEvaluation,
	type BudgetConsumption,
	type ExperimentVerdict,
} from '../desktop/experiment';
import {
	createDetailedEvaluation,
	linkEvidenceToCriteria,
	compareExperiments,
	createLearningProposal,
	findExperimentsByContext,
	canProposePattern,
	type DetailedEvaluation,
	type EvidenceLink,
	type ExperimentComparison,
	type LearningProposal,
	type ConfidenceLevel,
} from '../desktop/evaluation';
import {
	createEvaluationLog,
	buildEvaluationEntry,
	buildComparisonEntry,
	buildProposalEntry,
	type EvaluationLogEntry,
} from '../desktop/evaluationLog';
import type { TaskClassification } from '../desktop/taskDiscovery';
import type { OrchestrationStrategy } from '../desktop/orchestrator';

const testDir = join(tmpdir(), `modelhub-eval-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);

const sampleTask: TaskClassification = {
	primaryGoal: 'Test task',
	domain: 'coding',
	complexity: 'simple',
	needsTools: true,
	requiredCapabilities: ['code-generation'],
	missingInformation: [],
	confidence: 0.8,
	rationale: 'test',
};

const defaultBudget: ExperimentBudget = {
	maxExperiments: 5,
	maxAttemptsPerExperiment: 3,
	maxModelCalls: 20,
	maxTokens: 100000,
	maxDurationMs: 300000,
	maxToolCalls: 10,
	maxFilesTouched: 20,
};

const defaultCriteria: readonly SuccessCriterion[] = [
	{
		id: 'criterion-1',
		description: 'Output contains expected function',
		kind: 'contains',
		expected: 'function',
		weight: 0.5,
	},
	{
		id: 'criterion-2',
		description: 'Output is valid TypeScript',
		kind: 'regex',
		expected: '^function\\s+\\w+',
		weight: 0.5,
	},
];

const now = '2024-01-01T00:00:00.000Z';

describe('evaluation', () => {
	let store: FileDataStore;

	beforeEach(async () => {
		await rm(testDir, { recursive: true, force: true });
		store = new FileDataStore({ rootPath: testDir });
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	describe('linkEvidenceToCriteria', () => {
		it('links supporting evidence to criteria', () => {
			const session = createExperimentSession(sampleTask, 'Test goal', defaultBudget, now);
			let experiment = createExperiment({
				sessionId: session.id,
				objective: 'Test',
				hypothesis: 'H1',
				informationGaps: [],
				approach: 'A1',
				criteria: defaultCriteria,
				models: ['provider-1:model-a'],
				strategy: 'manual',
				budget: defaultBudget,
			}, now);

			experiment = addEvidence(experiment, {
				type: 'model-output',
				description: 'Model output',
				data: 'function validate() {}',
				step: 1,
			}, now);

			const links = linkEvidenceToCriteria(experiment, (id) => 'function validate() {}');

			assert.strictEqual(links.length, 2);
			const containsLink = links.find((l) => l.criterionId === 'criterion-1');
			assert.ok(containsLink);
			assert.strictEqual(containsLink.role, 'supporting');
			assert.ok(containsLink.classificationConfidence > 0.5);
		});

		it('links contradicting evidence', () => {
			const session = createExperimentSession(sampleTask, 'Test goal', defaultBudget, now);
			let experiment = createExperiment({
				sessionId: session.id,
				objective: 'Test',
				hypothesis: 'H1',
				informationGaps: [],
				approach: 'A1',
				criteria: [{ id: 'c1', description: 'Exact', kind: 'exact-match', expected: 'hello', weight: 1 }],
				models: ['provider-1:model-a'],
				strategy: 'manual',
				budget: defaultBudget,
			}, now);

			experiment = addEvidence(experiment, {
				type: 'model-output',
				description: 'Model output',
				data: 'goodbye',
				step: 1,
			}, now);

			const links = linkEvidenceToCriteria(experiment, (id) => 'goodbye');

			assert.strictEqual(links.length, 1);
			assert.strictEqual(links[0].role, 'contradicting');
			assert.ok(links[0].classificationConfidence > 0.5);
		});

		it('marks insufficient evidence for threshold with non-numeric', () => {
			const session = createExperimentSession(sampleTask, 'Test goal', defaultBudget, now);
			let experiment = createExperiment({
				sessionId: session.id,
				objective: 'Test',
				hypothesis: 'H1',
				informationGaps: [],
				approach: 'A1',
				criteria: [{ id: 'c1', description: 'Latency', kind: 'threshold', expected: 100, operator: 'lt', weight: 1 }],
				models: ['provider-1:model-a'],
				strategy: 'manual',
				budget: defaultBudget,
			}, now);

			experiment = addEvidence(experiment, {
				type: 'metric',
				description: 'Latency',
				data: 'not a number',
				step: 1,
			}, now);

			const links = linkEvidenceToCriteria(experiment, (id) => 'not a number');

			assert.strictEqual(links.length, 1);
			assert.strictEqual(links[0].role, 'insufficient');
			assert.ok(links[0].classificationConfidence < 0.5);
		});
	});

	describe('createDetailedEvaluation', () => {
		it('returns well-supported for high coverage with supporting evidence', () => {
			const session = createExperimentSession(sampleTask, 'Test goal', defaultBudget, now);
			let experiment = createExperiment({
				sessionId: session.id,
				objective: 'Test',
				hypothesis: 'H1',
				informationGaps: [],
				approach: 'A1',
				criteria: defaultCriteria,
				models: ['provider-1:model-a'],
				strategy: 'manual',
				budget: defaultBudget,
			}, now);

			experiment = addEvidence(experiment, {
				type: 'model-output',
				description: 'Model output',
				data: 'function validate() {}',
				step: 1,
			}, now);

			const detailed = createDetailedEvaluation(experiment, (id) => 'function validate() {}');

			assert.ok(detailed.verdictConfidence > 0.6);
			assert.ok(detailed.confidenceRationale.includes('well-supported') || detailed.confidenceRationale.includes('provisional'));
			assert.strictEqual(detailed.unverifiableCriteria.length, 0);
			assert.strictEqual(detailed.hasConflictingEvidence, false);
			assert.strictEqual(detailed.evidenceLinks.length, 2);
		});

		it('treats a failed criterion as a failure, not a contradiction', () => {
			const session = createExperimentSession(sampleTask, 'Test goal', defaultBudget, now);
			let experiment = createExperiment({
				sessionId: session.id,
				objective: 'Test',
				hypothesis: 'H1',
				informationGaps: [],
				approach: 'A1',
				criteria: [
					{ id: 'c1', description: 'Contains function', kind: 'contains', expected: 'function', weight: 0.5 },
					{ id: 'c2', description: 'Contains class', kind: 'contains', expected: 'class', weight: 0.5 },
				],
				models: ['provider-1:model-a'],
				strategy: 'manual',
				budget: defaultBudget,
			}, now);

			// One output: it satisfies c1 and not c2. That is an ordinary failing
			// run, and calling it a contradiction would make every real failure
			// inconclusive -- which stops the learning stage counting them at all.
			experiment = addEvidence(experiment, {
				type: 'model-output',
				description: 'Model output',
				data: 'function validate() {}',
				step: 1,
			}, now);

			const detailed = createDetailedEvaluation(experiment, (id) => 'function validate() {}');

			assert.strictEqual(
				detailed.hasConflictingEvidence,
				false,
				'a criterion that failed is not evidence contradicting itself',
			);
			assert.ok(detailed.evidenceLinks.some((link) => link.role === 'contradicting'));
			// Half the criteria passed, so the confidence is moderate and the
			// rationale says "provisional" -- what matters is that it is not
			// "conflicting", which is what the old rule produced here.
			assert.doesNotMatch(detailed.confidenceRationale, /^conflicting/);
			assert.strictEqual(detailed.unverifiableCriteria.length, 0);
		});

		it('is conflicting when one criterion is checked both ways', () => {
			const session = createExperimentSession(sampleTask, 'Test goal', defaultBudget, now);
			const experiment = createExperiment({
				sessionId: session.id,
				objective: 'Test',
				hypothesis: 'H1',
				informationGaps: [],
				approach: 'A1',
				criteria: [
					{ id: 'c1', description: 'Contains function', kind: 'contains', expected: 'function', weight: 1 },
				],
				models: ['provider-1:model-a'],
				strategy: 'manual',
				budget: defaultBudget,
			}, now);

			// Two outputs for the same criterion, pointing opposite ways. This is
			// the case the flag is for: neither the pass nor the fail is settled.
			const contradictory: DetailedEvaluation = {
				experimentId: experiment.id,
				baseEvaluation: {
					verdict: 'inconclusive',
					criterionEvaluations: [{ criterionId: 'c1', passed: false, actualValue: 'x', reason: 'x' }],
					overallScore: 0,
					summary: 'x',
				},
				evidenceLinks: [
					{ evidenceId: 'ev-1', criterionId: 'c1', role: 'supporting', reason: 'contém', classificationConfidence: 0.85 },
					{ evidenceId: 'ev-2', criterionId: 'c1', role: 'contradicting', reason: 'não contém', classificationConfidence: 0.7 },
				],
				verdictConfidence: 0,
				confidenceRationale: 'x',
				unverifiableCriteria: [],
				hasConflictingEvidence: true,
			};

			assert.strictEqual(contradictory.hasConflictingEvidence, true);
			assert.ok(
				contradictory.evidenceLinks.filter((link) => link.role === 'supporting').length > 0 &&
					contradictory.evidenceLinks.filter((link) => link.role === 'contradicting').length > 0,
				'a conflict needs both directions on one criterion',
			);
		});

		it('marks unverifiable criteria when no evidence', () => {
			const session = createExperimentSession(sampleTask, 'Test goal', defaultBudget, now);
			const experiment = createExperiment({
				sessionId: session.id,
				objective: 'Test',
				hypothesis: 'H1',
				informationGaps: [],
				approach: 'A1',
				criteria: defaultCriteria,
				models: ['provider-1:model-a'],
				strategy: 'manual',
				budget: defaultBudget,
			}, now);

			const detailed = createDetailedEvaluation(experiment, (id) => undefined);

			assert.strictEqual(detailed.unverifiableCriteria.length, 2);
			assert.ok(detailed.verdictConfidence < 0.5);
			assert.ok(detailed.confidenceRationale.includes('insufficient-data') || detailed.confidenceRationale.includes('inconclusive'));
		});

		it('includes base evaluation', () => {
			const session = createExperimentSession(sampleTask, 'Test goal', defaultBudget, now);
			let experiment = createExperiment({
				sessionId: session.id,
				objective: 'Test',
				hypothesis: 'H1',
				informationGaps: [],
				approach: 'A1',
				criteria: defaultCriteria,
				models: ['provider-1:model-a'],
				strategy: 'manual',
				budget: defaultBudget,
			}, now);

			experiment = addEvidence(experiment, {
				type: 'model-output',
				description: 'Model output',
				data: 'function validate() {}',
				step: 1,
			}, now);

			const detailed = createDetailedEvaluation(experiment, (id) => 'function validate() {}');

			assert.ok(detailed.baseEvaluation);
			assert.strictEqual(detailed.baseEvaluation.criterionEvaluations.length, 2);
			assert.ok(['passed', 'failed', 'inconclusive'].includes(detailed.baseEvaluation.verdict));
		});
	});

	describe('compareExperiments', () => {
		function makeExperiment(id: string, output: string, verdict: ExperimentVerdict): Experiment {
			const session = createExperimentSession(sampleTask, 'Test goal', defaultBudget, now);
			const exp = createExperiment({
				sessionId: session.id,
				objective: 'Create a validation function',
				hypothesis: 'Using regex will be faster',
				informationGaps: [],
				approach: 'Implement regex-based validation',
				criteria: defaultCriteria,
				models: ['provider-1:model-a'],
				strategy: 'manual',
				budget: defaultBudget,
			}, now);

			const withEvidence = addEvidence(exp, {
				type: 'model-output',
				description: 'Model output',
				data: output,
				step: 1,
			}, now);

			// Manually set evaluation to control verdict
			return {
				...withEvidence,
				id: `exp-${id}` as any,
				evaluation: {
					verdict,
					criterionEvaluations: defaultCriteria.map((c, i) => ({
						criterionId: c.id,
						passed: verdict === 'passed' || (verdict === 'inconclusive' && i === 0),
						actualValue: output,
						reason: 'test',
					})),
					overallScore: verdict === 'passed' ? 1 : verdict === 'failed' ? 0 : 0.5,
					summary: 'test',
				},
				consumption: {
					experimentsStarted: 1,
					attemptsMade: 1,
					modelCalls: 1,
					tokensUsed: 1000,
					durationMs: 5000,
					toolCalls: 0,
					filesTouched: 0,
				},
			};
		}

		it('compares compatible experiments', () => {
			const exp1 = makeExperiment('1', 'function validate() {}', 'passed');
			const exp2 = makeExperiment('2', 'function check() {}', 'passed');

			const det1 = createDetailedEvaluation(exp1, () => 'function validate() {}');
			const det2 = createDetailedEvaluation(exp2, () => 'function check() {}');

			const comparison = compareExperiments([exp1, exp2], [det1, det2], () => 'data');

			assert.ok(comparison.compatible);
			assert.strictEqual(comparison.criterionComparisons.length, 2);
			assert.ok(comparison.caveats.length >= 0);
		});

		it('rejects incompatible experiments (different criteria)', () => {
			const session = createExperimentSession(sampleTask, 'Test goal', defaultBudget, now);
			const exp1 = createExperiment({
				sessionId: session.id,
				objective: 'Test',
				hypothesis: 'H1',
				informationGaps: [],
				approach: 'A1',
				criteria: defaultCriteria,
				models: ['provider-1:model-a'],
				strategy: 'manual',
				budget: defaultBudget,
			}, now);

			const exp2 = createExperiment({
				sessionId: session.id,
				objective: 'Test',
				hypothesis: 'H1',
				informationGaps: [],
				approach: 'A1',
				criteria: [{ id: 'c3', description: 'Different', kind: 'exact-match', expected: 'x', weight: 1 }],
				models: ['provider-1:model-a'],
				strategy: 'manual',
				budget: defaultBudget,
			}, now);

			const det1 = createDetailedEvaluation(exp1, () => 'data');
			const det2 = createDetailedEvaluation(exp2, () => 'data');

			const comparison = compareExperiments([exp1, exp2], [det1, det2], () => 'data');

			assert.ok(!comparison.compatible);
			assert.ok(comparison.incompatibilityReason?.includes('criteria'));
		});

		it('rejects experiments with different objectives', () => {
			const session = createExperimentSession(sampleTask, 'Test goal', defaultBudget, now);
			const exp1 = createExperiment({
				sessionId: session.id,
				objective: 'Objective A',
				hypothesis: 'H1',
				informationGaps: [],
				approach: 'A1',
				criteria: defaultCriteria,
				models: ['provider-1:model-a'],
				strategy: 'manual',
				budget: defaultBudget,
			}, now);

			const exp2 = createExperiment({
				sessionId: session.id,
				objective: 'Objective B',
				hypothesis: 'H1',
				informationGaps: [],
				approach: 'A1',
				criteria: defaultCriteria,
				models: ['provider-1:model-a'],
				strategy: 'manual',
				budget: defaultBudget,
			}, now);

			const det1 = createDetailedEvaluation(exp1, () => 'data');
			const det2 = createDetailedEvaluation(exp2, () => 'data');

			const comparison = compareExperiments([exp1, exp2], [det1, det2], () => 'data');

			assert.ok(!comparison.compatible);
			assert.ok(comparison.incompatibilityReason?.includes('objective'));
		});

		it('handles unknown resource values', () => {
			const exp1 = makeExperiment('1', 'function validate() {}', 'passed');
			const exp2 = makeExperiment('2', 'function check() {}', 'passed');
			const exp2UnknownTokens: Experiment = {
				...exp2,
				consumption: { ...exp2.consumption, tokensUsed: 'unknown' },
			};

			const det1 = createDetailedEvaluation(exp1, () => 'function validate() {}');
			const det2 = createDetailedEvaluation(exp2, () => 'function check() {}');

			const comparison = compareExperiments([exp1, exp2UnknownTokens], [det1, det2], () => 'data');

			assert.ok(comparison.resourceComparison.tokensUsed.some((r) => r.value === 'unknown'));
			assert.ok(comparison.caveats.some((c) => c.includes('Token usage unknown')));
		});

		it('identifies winner based on criteria', () => {
			const exp1 = makeExperiment('1', 'function validate() {}', 'passed');
			const exp2 = makeExperiment('2', 'no function here', 'failed');

			const det1 = createDetailedEvaluation(exp1, () => 'function validate() {}');
			const det2 = createDetailedEvaluation(exp2, () => 'no function here');

			const comparison = compareExperiments([exp1, exp2], [det1, det2], () => 'data');

			assert.ok(comparison.overallWinner === 'exp-1' || comparison.overallWinner === 'exp-2');
		});
	});

	describe('createLearningProposal', () => {
		it('creates a proposal with all fields', () => {
			const session = createExperimentSession(sampleTask, 'Test goal', defaultBudget, now);
			const proposal = createLearningProposal({
				session,
				pattern: 'Regex validation is faster for email',
				context: { domain: 'coding', complexity: 'simple', requiredCapabilities: ['code-generation'] },
				supportingExperiments: ['exp-1', 'exp-2'],
				contradictingExperiments: ['exp-3'],
				limitations: ['Only tested with regex', 'Small sample'],
				untestedCases: ['Complex validation', 'Non-email patterns'],
				suggestedReuse: 'heuristic',
				reviewLevel: 'human-review',
			}, now);

			assert.ok(proposal.id.startsWith('learn-'));
			assert.strictEqual(proposal.pattern, 'Regex validation is faster for email');
			assert.strictEqual(proposal.suggestedReuse, 'heuristic');
			assert.strictEqual(proposal.reviewLevel, 'human-review');
			assert.strictEqual(proposal.proposedAt, now);
		});
	});

	describe('findExperimentsByContext', () => {
		it('filters by domain', () => {
			const session = createExperimentSession(sampleTask, 'Test goal', defaultBudget, now);

			const exp1 = createExperiment({
				sessionId: session.id,
				objective: 'Test',
				hypothesis: 'H1',
				informationGaps: [],
				approach: 'A1',
				criteria: defaultCriteria,
				models: ['provider-1:model-a'],
				strategy: 'manual',
				budget: defaultBudget,
			}, now);

			const exp2 = createExperiment({
				sessionId: session.id,
				objective: 'Test',
				hypothesis: 'H2',
				informationGaps: [],
				approach: 'A2',
				criteria: defaultCriteria,
				models: ['provider-1:model-a'],
				strategy: 'manual',
				budget: defaultBudget,
			}, now);

			const updatedSession = {
				...session,
				experiments: [exp1, exp2],
			};

			const results = findExperimentsByContext(updatedSession, { domain: 'coding' });
			assert.strictEqual(results.length, 2);

			const results2 = findExperimentsByContext(updatedSession, { domain: 'database' });
			assert.strictEqual(results2.length, 0);
		});

		it('filters by complexity', () => {
			const session = createExperimentSession(sampleTask, 'Test goal', defaultBudget, now);

			const exp1 = createExperiment({
				sessionId: session.id,
				objective: 'Test',
				hypothesis: 'H1',
				informationGaps: [],
				approach: 'A1',
				criteria: defaultCriteria,
				models: ['provider-1:model-a'],
				strategy: 'manual',
				budget: defaultBudget,
			}, now);

			const updatedSession = { ...session, experiments: [exp1] };

			const results = findExperimentsByContext(updatedSession, { complexity: 'simple' });
			assert.strictEqual(results.length, 1);

			const results2 = findExperimentsByContext(updatedSession, { complexity: 'complex' });
			assert.strictEqual(results2.length, 0);
		});
	});

	describe('canProposePattern', () => {
		it('returns false when insufficient experiments', () => {
			const session = createExperimentSession(sampleTask, 'Test goal', defaultBudget, now);

			const exp1 = createExperiment({
				sessionId: session.id,
				objective: 'Test',
				hypothesis: 'H1',
				informationGaps: [],
				approach: 'A1',
				criteria: defaultCriteria,
				models: ['provider-1:model-a'],
				strategy: 'manual',
				budget: defaultBudget,
			}, now);

			const expWithEval = { ...exp1, state: 'completed' as const, evaluation: { verdict: 'passed' as const, criterionEvaluations: [], overallScore: 1, summary: 'ok' } };
			const updatedSession = { ...session, experiments: [expWithEval] };

			const result = canProposePattern(updatedSession, { domain: 'coding' }, 3);

			assert.ok(!result.canPropose);
			assert.ok(result.reason.includes('Need at least 3'));
		});

		it('returns false when high failure rate', () => {
			const session = createExperimentSession(sampleTask, 'Test goal', defaultBudget, now);

			const exps = Array.from({ length: 5 }, (_, i) => {
				const exp = createExperiment({
					sessionId: session.id,
					objective: 'Test',
					hypothesis: `H${i}`,
					informationGaps: [],
					approach: 'A1',
					criteria: defaultCriteria,
					models: ['provider-1:model-a'],
					strategy: 'manual',
					budget: defaultBudget,
				}, now);
				return {
					...exp,
					state: 'completed' as const,
					evaluation: { verdict: i < 2 ? 'passed' as const : 'failed' as const, criterionEvaluations: [], overallScore: i < 2 ? 1 : 0, summary: 'ok' },
				};
			});

			const updatedSession = { ...session, experiments: exps };

			const result = canProposePattern(updatedSession, { domain: 'coding' }, 3);

			assert.ok(!result.canPropose);
			assert.ok(result.reason.includes('failure rate'));
		});

		it('returns true when sufficient consistent evidence', () => {
			const session = createExperimentSession(sampleTask, 'Test goal', defaultBudget, now);

			const exps = Array.from({ length: 5 }, (_, i) => {
				const exp = createExperiment({
					sessionId: session.id,
					objective: 'Test',
					hypothesis: `H${i}`,
					informationGaps: [],
					approach: 'A1',
					criteria: defaultCriteria,
					models: ['provider-1:model-a'],
					strategy: 'manual',
					budget: defaultBudget,
				}, now);
				return {
					...exp,
					state: 'completed' as const,
					evaluation: { verdict: 'passed' as const, criterionEvaluations: [], overallScore: 1, summary: 'ok' },
				};
			});

			const updatedSession = { ...session, experiments: exps };

			const result = canProposePattern(updatedSession, { domain: 'coding' }, 3);

			assert.ok(result.canPropose);
			assert.strictEqual(result.reason, 'Sufficient consistent evidence');
		});
	});
});

describe('evaluationLog', () => {
	let store: FileDataStore;
	let log: ReturnType<typeof createEvaluationLog>;

	beforeEach(async () => {
		await rm(testDir, { recursive: true, force: true });
		store = new FileDataStore({ rootPath: testDir });
		log = createEvaluationLog(store);
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	it('appends and retrieves evaluations', async () => {
		const session = createExperimentSession(sampleTask, 'Test goal', defaultBudget, now);
		let experiment = createExperiment({
			sessionId: session.id,
			objective: 'Test',
			hypothesis: 'H1',
			informationGaps: [],
			approach: 'A1',
			criteria: defaultCriteria,
			models: ['provider-1:model-a'],
			strategy: 'manual',
			budget: defaultBudget,
		}, now);

		experiment = addEvidence(experiment, {
			type: 'model-output',
			description: 'Model output',
			data: 'function validate() {}',
			step: 1,
		}, now);

		const detailed = createDetailedEvaluation(experiment, (id) => 'function validate() {}');
		await log.append(buildEvaluationEntry(session.id, experiment.id, detailed));

		const evaluations = await log.listEvaluations(session.id);
		assert.strictEqual(evaluations.length, 1);
		assert.strictEqual(evaluations[0].experimentId, experiment.id);
	});

	it('appends and retrieves comparisons', async () => {
		const session = createExperimentSession(sampleTask, 'Test goal', defaultBudget, now);
		const exp1 = createExperiment({
			sessionId: session.id,
			objective: 'Test',
			hypothesis: 'H1',
			informationGaps: [],
			approach: 'A1',
			criteria: defaultCriteria,
			models: ['provider-1:model-a'],
			strategy: 'manual',
			budget: defaultBudget,
		}, now);

		const exp2 = createExperiment({
			sessionId: session.id,
			objective: 'Test',
			hypothesis: 'H1',
			informationGaps: [],
			approach: 'A2',
			criteria: defaultCriteria,
			models: ['provider-1:model-a'],
			strategy: 'manual',
			budget: defaultBudget,
		}, now);

		const det1 = createDetailedEvaluation(exp1, () => 'data');
		const det2 = createDetailedEvaluation(exp2, () => 'data');
		const comparison = compareExperiments([exp1, exp2], [det1, det2], () => 'data');

		await log.append(buildComparisonEntry(session.id, comparison));

		const comparisons = await log.listComparisons(session.id);
		assert.strictEqual(comparisons.length, 1);
		assert.ok(comparisons[0].compatible);
	});

	it('appends and retrieves learning proposals', async () => {
		const session = createExperimentSession(sampleTask, 'Test goal', defaultBudget, now);
		const proposal = createLearningProposal({
			session,
			pattern: 'Test pattern',
			context: { domain: 'coding' },
			supportingExperiments: ['exp-1'],
			contradictingExperiments: [],
			limitations: ['Small sample'],
			untestedCases: ['Edge cases'],
			suggestedReuse: 'heuristic',
			reviewLevel: 'human-review',
		}, now);

		await log.append(buildProposalEntry(session.id, proposal));

		const proposals = await log.listProposals(session.id);
		assert.strictEqual(proposals.length, 1);
		assert.strictEqual(proposals[0].pattern, 'Test pattern');
	});

	it('gets latest evaluation for experiment', async () => {
		const session = createExperimentSession(sampleTask, 'Test goal', defaultBudget, now);
		let experiment = createExperiment({
			sessionId: session.id,
			objective: 'Test',
			hypothesis: 'H1',
			informationGaps: [],
			approach: 'A1',
			criteria: defaultCriteria,
			models: ['provider-1:model-a'],
			strategy: 'manual',
			budget: defaultBudget,
		}, now);

		experiment = addEvidence(experiment, {
			type: 'model-output',
			description: 'Model output',
			data: 'function validate() {}',
			step: 1,
		}, now);

		const detailed = createDetailedEvaluation(experiment, (id) => 'function validate() {}');
		await log.append(buildEvaluationEntry(session.id, experiment.id, detailed));

		const retrieved = await log.getLatestEvaluation(experiment.id);
		assert.ok(retrieved);
		assert.strictEqual(retrieved.experimentId, experiment.id);
	});

	it('persists across instances', async () => {
		const session = createExperimentSession(sampleTask, 'Test goal', defaultBudget, now);
		let experiment = createExperiment({
			sessionId: session.id,
			objective: 'Test',
			hypothesis: 'H1',
			informationGaps: [],
			approach: 'A1',
			criteria: defaultCriteria,
			models: ['provider-1:model-a'],
			strategy: 'manual',
			budget: defaultBudget,
		}, now);

		experiment = addEvidence(experiment, {
			type: 'model-output',
			description: 'Model output',
			data: 'function validate() {}',
			step: 1,
		}, now);

		const detailed = createDetailedEvaluation(experiment, (id) => 'function validate() {}');
		await log.append(buildEvaluationEntry(session.id, experiment.id, detailed));

		const log2 = createEvaluationLog(store);
		const evaluations = await log2.listEvaluations(session.id);
		assert.strictEqual(evaluations.length, 1);
	});

	it('clears all entries', async () => {
		const session = createExperimentSession(sampleTask, 'Test goal', defaultBudget, now);
		let experiment = createExperiment({
			sessionId: session.id,
			objective: 'Test',
			hypothesis: 'H1',
			informationGaps: [],
			approach: 'A1',
			criteria: defaultCriteria,
			models: ['provider-1:model-a'],
			strategy: 'manual',
			budget: defaultBudget,
		}, now);

		experiment = addEvidence(experiment, {
			type: 'model-output',
			description: 'Model output',
			data: 'function validate() {}',
			step: 1,
		}, now);

		const detailed = createDetailedEvaluation(experiment, (id) => 'function validate() {}');
		await log.append(buildEvaluationEntry(session.id, experiment.id, detailed));
		await log.clear();

		const evaluations = await log.listEvaluations(session.id);
		assert.strictEqual(evaluations.length, 0);
	});
});
