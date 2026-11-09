/** Tests for the experimentation engine. */

import * as assert from 'assert';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { FileDataStore } from '../adapters/local/fileDataStore';
import {
	createExperiment,
	createExperimentSession,
	transitionExperiment,
	addEvidence,
	requestAuthorization,
	resolveAuthorization,
	evaluateExperiment,
	checkBudget,
	recordConsumption,
	validateCriteria,
	checkSessionStatus,
	areExperimentsEquivalent,
	type Experiment,
	type ExperimentSession,
	type SuccessCriterion,
	type ExperimentBudget,
	type Evidence,
	type ExperimentEvaluation,
	type BudgetConsumption,
} from '../desktop/experiment';
import {
	createExperimentLog,
	buildSessionStartEntry,
	buildExperimentStartEntry,
	buildEvidenceEntry,
	buildEvaluationEntry,
	buildSessionEndEntry,
	type ExperimentLogEntry,
} from '../desktop/experimentLog';
import type { TaskClassification } from '../desktop/taskDiscovery';
import type { OrchestrationStrategy } from '../desktop/orchestrator';

const testDir = join(tmpdir(), `modelhub-exp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);

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

describe('experiment', () => {
	let store: FileDataStore;
	let log: ReturnType<typeof createExperimentLog>;

	beforeEach(async () => {
		await rm(testDir, { recursive: true, force: true });
		store = new FileDataStore({ rootPath: testDir });
		log = createExperimentLog(store);
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	describe('createExperimentSession', () => {
		it('creates a session with initial state', () => {
			const session = createExperimentSession(sampleTask, 'Test goal', defaultBudget, now);
			assert.ok(session.id.startsWith('exp-session-'));
			assert.strictEqual(session.task, sampleTask);
			assert.strictEqual(session.goal, 'Test goal');
			assert.strictEqual(session.experiments.length, 0);
			assert.strictEqual(session.budget, defaultBudget);
			assert.strictEqual(session.status, 'active');
			assert.strictEqual(session.createdAt, now);
			assert.strictEqual(session.updatedAt, now);
		});
	});

	describe('createExperiment', () => {
		it('creates an experiment in defined state', () => {
			const session = createExperimentSession(sampleTask, 'Test goal', defaultBudget, now);
			const experiment = createExperiment({
				sessionId: session.id,
				objective: 'Create a validation function',
				hypothesis: 'Using regex will be faster than manual parsing',
				informationGaps: ['performance characteristics'],
				approach: 'Implement regex-based validation',
				alternative: 'Implement manual parsing',
				criteria: defaultCriteria,
				models: ['provider-1:model-a'],
				strategy: 'manual',
				budget: defaultBudget,
			}, now);

			assert.ok(experiment.id.startsWith('exp-'));
			assert.strictEqual(experiment.sessionId, session.id);
			assert.strictEqual(experiment.state, 'defined');
			assert.strictEqual(experiment.objective, 'Create a validation function');
			assert.strictEqual(experiment.hypothesis, 'Using regex will be faster than manual parsing');
			assert.strictEqual(experiment.approach, 'Implement regex-based validation');
			assert.strictEqual(experiment.alternative, 'Implement manual parsing');
			assert.strictEqual(experiment.criteria.length, 2);
			assert.strictEqual(experiment.strategy, 'manual');
			assert.strictEqual(experiment.evidence.length, 0);
			assert.strictEqual(experiment.currentStep, 0);
		});
	});

	describe('validateCriteria', () => {
		it('accepts valid criteria', () => {
			const result = validateCriteria(defaultCriteria);
			assert.ok(result.valid);
			assert.strictEqual(result.errors.length, 0);
		});

		it('rejects invalid weights', () => {
			const badCriteria: readonly SuccessCriterion[] = [
				{ ...defaultCriteria[0], weight: 1.5 },
			];
			const result = validateCriteria(badCriteria);
			assert.ok(!result.valid);
			assert.ok(result.errors.some((e) => e.includes('weight must be between 0 and 1')));
		});

		it('rejects threshold without operator', () => {
			const badCriteria: readonly SuccessCriterion[] = [
				{ id: 'c1', description: 'test', kind: 'threshold', expected: 5, weight: 1 },
			];
			const result = validateCriteria(badCriteria);
			assert.ok(!result.valid);
			assert.ok(result.errors.some((e) => e.includes('threshold kind requires an operator')));
		});

		it('rejects weights not summing to 1', () => {
			const badCriteria: readonly SuccessCriterion[] = [
				{ id: 'c1', description: 'test', kind: 'exact-match', expected: 'a', weight: 0.3 },
				{ id: 'c2', description: 'test', kind: 'exact-match', expected: 'b', weight: 0.3 },
			];
			const result = validateCriteria(badCriteria);
			assert.ok(!result.valid);
			assert.ok(result.errors.some((e) => e.includes('weights must sum to 1')));
		});

		it('rejects custom kind', () => {
			const badCriteria: readonly SuccessCriterion[] = [
				{ id: 'c1', description: 'test', kind: 'custom', expected: 'a', weight: 1 },
			];
			const result = validateCriteria(badCriteria);
			assert.ok(!result.valid);
			assert.ok(result.errors.some((e) => e.includes('custom kind not supported')));
		});
	});

	describe('transitionExperiment', () => {
		let experiment: Experiment;

		beforeEach(() => {
			const session = createExperimentSession(sampleTask, 'Test goal', defaultBudget, now);
			experiment = createExperiment({
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
		});

		it('allows valid transitions', () => {
			const result = transitionExperiment(experiment, 'executing', now);
			assert.ok(result.ok);
			assert.strictEqual(result.experiment.state, 'executing');
			assert.ok(result.experiment.startedAt !== undefined);
		});

		it('rejects invalid transitions', () => {
			const result = transitionExperiment(experiment, 'completed', now);
			assert.ok(!result.ok);
			assert.ok(result.reason.includes('Invalid state transition'));
		});

		it('transitions through full lifecycle', () => {
			let result = transitionExperiment(experiment, 'executing', now);
			assert.ok(result.ok);
			result = transitionExperiment(result.experiment, 'evaluating', now);
			assert.ok(result.ok);
			const evalResult: ExperimentEvaluation = {
				verdict: 'passed',
				criterionEvaluations: [],
				overallScore: 1,
				summary: 'All passed',
			};
			result = transitionExperiment(result.experiment, 'completed', now, { evaluation: evalResult });
			assert.ok(result.ok);
			assert.strictEqual(result.experiment.state, 'completed');
			assert.ok(result.experiment.evaluation !== undefined);
		});

		it('prevents transitions from terminal states', () => {
			let exp = experiment;
			exp = transitionExperiment(exp, 'executing', now).experiment;
			exp = transitionExperiment(exp, 'evaluating', now).experiment;
			exp = transitionExperiment(exp, 'completed', now).experiment;

			const result = transitionExperiment(exp, 'executing', now);
			assert.ok(!result.ok);
		});
	});

	describe('addEvidence', () => {
		it('adds evidence with metadata', () => {
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

			const evidence: Omit<Evidence, 'id' | 'timestamp'> = {
				type: 'model-output',
				description: 'Model returned function',
				data: { output: 'function validate() {}' },
				step: 1,
			};

			const updated = addEvidence(experiment, evidence, now);
			assert.strictEqual(updated.evidence.length, 1);
			assert.ok(updated.evidence[0].id.startsWith('ev-'));
			assert.strictEqual(updated.evidence[0].step, 1);
			assert.strictEqual(updated.evidence[0].type, 'model-output');
		});
	});

	describe('requestAuthorization and resolveAuthorization', () => {
		it('requests authorization and transitions to authorizing', () => {
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

			experiment = requestAuthorization(experiment, {
				action: 'write-file',
				description: 'Write test file',
				context: { path: '/tmp/test.ts' },
			}, now);

			assert.strictEqual(experiment.state, 'authorizing');
			assert.strictEqual(experiment.pendingAuthorizations.length, 1);
			assert.strictEqual(experiment.pendingAuthorizations[0].action, 'write-file');
		});

		it('grants authorization and transitions to executing', () => {
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

			experiment = requestAuthorization(experiment, {
				action: 'write-file',
				description: 'Write test file',
				context: {},
			}, now);

			const authId = experiment.pendingAuthorizations[0].id;
			const result = resolveAuthorization(experiment, authId, 'granted', now);
			assert.ok(result.ok);
			assert.strictEqual(result.experiment.state, 'executing');
			assert.strictEqual(result.experiment.pendingAuthorizations.length, 0);
		});

		it('denies authorization and interrupts experiment', () => {
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

			experiment = requestAuthorization(experiment, {
				action: 'write-file',
				description: 'Write test file',
				context: {},
			}, now);

			const authId = experiment.pendingAuthorizations[0].id;
			const result = resolveAuthorization(experiment, authId, 'denied', now);
			assert.ok(result.ok);
			assert.strictEqual(result.experiment.state, 'interrupted');
		});
	});

	describe('evaluateExperiment', () => {
		it('returns inconclusive when no criteria', () => {
			const session = createExperimentSession(sampleTask, 'Test goal', defaultBudget, now);
			const experiment = createExperiment({
				sessionId: session.id,
				objective: 'Test',
				hypothesis: 'H1',
				informationGaps: [],
				approach: 'A1',
				criteria: [],
				models: ['provider-1:model-a'],
				strategy: 'manual',
				budget: defaultBudget,
			}, now);

			const evaluation = evaluateExperiment(experiment, () => undefined);
			assert.strictEqual(evaluation.verdict, 'inconclusive');
			assert.strictEqual(evaluation.overallScore, 0);
		});

		it('evaluates exact-match criteria', () => {
			const session = createExperimentSession(sampleTask, 'Test goal', defaultBudget, now);
			const criteria: readonly SuccessCriterion[] = [
				{ id: 'c1', description: 'Exact output', kind: 'exact-match', expected: 'hello', weight: 1 },
			];
			const experiment = createExperiment({
				sessionId: session.id,
				objective: 'Test',
				hypothesis: 'H1',
				informationGaps: [],
				approach: 'A1',
				criteria,
				models: ['provider-1:model-a'],
				strategy: 'manual',
				budget: defaultBudget,
			}, now);

			const expWithEvidence = addEvidence(experiment, {
				type: 'model-output',
				description: 'Model output',
				data: { output: 'hello' },
				step: 1,
			}, now);

			// getEvidenceData should return the actual value to compare against the criterion
			const evaluation = evaluateExperiment(expWithEvidence, (id) => 'hello');
			assert.strictEqual(evaluation.verdict, 'passed');
			assert.ok(evaluation.criterionEvaluations[0].passed);
		});

		it('evaluates contains criteria', () => {
			const session = createExperimentSession(sampleTask, 'Test goal', defaultBudget, now);
			const criteria: readonly SuccessCriterion[] = [
				{ id: 'c1', description: 'Contains function', kind: 'contains', expected: 'function', weight: 1 },
			];
			const experiment = createExperiment({
				sessionId: session.id,
				objective: 'Test',
				hypothesis: 'H1',
				informationGaps: [],
				approach: 'A1',
				criteria,
				models: ['provider-1:model-a'],
				strategy: 'manual',
				budget: defaultBudget,
			}, now);

			const expWithEvidence = addEvidence(experiment, {
				type: 'model-output',
				description: 'Model output',
				data: { output: 'function validate() {}' },
				step: 1,
			}, now);

			// getEvidenceData should return the actual value to compare against the criterion
			const evaluation = evaluateExperiment(expWithEvidence, (id) => 'function validate() {}');
			assert.ok(evaluation.criterionEvaluations[0].passed);
		});

		it('evaluates threshold criteria', () => {
			const session = createExperimentSession(sampleTask, 'Test goal', defaultBudget, now);
			const criteria: readonly SuccessCriterion[] = [
				{ id: 'c1', description: 'Latency under 100ms', kind: 'threshold', expected: 100, operator: 'lt', weight: 1 },
			];
			const experiment = createExperiment({
				sessionId: session.id,
				objective: 'Test',
				hypothesis: 'H1',
				informationGaps: [],
				approach: 'A1',
				criteria,
				models: ['provider-1:model-a'],
				strategy: 'manual',
				budget: defaultBudget,
			}, now);

			const expWithEvidence = addEvidence(experiment, {
				type: 'metric',
				description: 'Latency measurement',
				data: { latencyMs: 50 },
				step: 1,
			}, now);

			// getEvidenceData should return the actual value to compare against the criterion
			const evaluation = evaluateExperiment(expWithEvidence, (id) => 50);
			assert.ok(evaluation.criterionEvaluations[0].passed);
		});

		it('calculates weighted overall score', () => {
			const session = createExperimentSession(sampleTask, 'Test goal', defaultBudget, now);
			const criteria: readonly SuccessCriterion[] = [
				{ id: 'c1', description: 'Pass', kind: 'exact-match', expected: 'a', weight: 0.8 },
				{ id: 'c2', description: 'Fail', kind: 'exact-match', expected: 'b', weight: 0.2 },
			];
			const experiment = createExperiment({
				sessionId: session.id,
				objective: 'Test',
				hypothesis: 'H1',
				informationGaps: [],
				approach: 'A1',
				criteria,
				models: ['provider-1:model-a'],
				strategy: 'manual',
				budget: defaultBudget,
			}, now);

			const expWithEvidence = addEvidence(experiment, {
				type: 'model-output',
				description: 'Model output',
				data: { output: 'a' },
				step: 1,
			}, now);

			// getEvidenceData should return the actual value to compare against the criterion
			const evaluation = evaluateExperiment(expWithEvidence, (id) => 'a');
			assert.ok(evaluation.overallScore > 0.7 && evaluation.overallScore < 0.9);
		});
	});

	describe('checkBudget and recordConsumption', () => {
		it('allows actions within budget', () => {
			const consumption: BudgetConsumption = {
				experimentsStarted: 0,
				attemptsMade: 0,
				modelCalls: 5,
				tokensUsed: 1000,
				durationMs: 5000,
				toolCalls: 2,
				filesTouched: 3,
			};

			const result = checkBudget(consumption, defaultBudget, { modelCalls: 1, durationMs: 1000 });
			assert.ok(result.allowed);
		});

		it('blocks when model calls exceeded', () => {
			const consumption: BudgetConsumption = {
				experimentsStarted: 0,
				attemptsMade: 0,
				modelCalls: 20,
				tokensUsed: 1000,
				durationMs: 5000,
				toolCalls: 2,
				filesTouched: 3,
			};

			const result = checkBudget(consumption, defaultBudget, { modelCalls: 1 });
			assert.ok(!result.allowed);
			assert.ok(result.reason?.includes('Max model calls'));
		});

		it('blocks when duration exceeded', () => {
			const consumption: BudgetConsumption = {
				experimentsStarted: 0,
				attemptsMade: 0,
				modelCalls: 5,
				tokensUsed: 1000,
				durationMs: 299000,
				toolCalls: 2,
				filesTouched: 3,
			};

			const result = checkBudget(consumption, defaultBudget, { durationMs: 2000 });
			assert.ok(!result.allowed);
			assert.ok(result.reason?.includes('Max duration'));
		});

		it('records consumption correctly', () => {
			const consumption: BudgetConsumption = {
				experimentsStarted: 1,
				attemptsMade: 0,
				modelCalls: 5,
				tokensUsed: 1000,
				durationMs: 5000,
				toolCalls: 2,
				filesTouched: 3,
			};

			const updated = recordConsumption(consumption, { modelCalls: 1, tokens: 500, durationMs: 1000, toolCalls: 1 });
			assert.strictEqual(updated.modelCalls, 6);
			assert.strictEqual(updated.tokensUsed, 1500);
			assert.strictEqual(updated.durationMs, 6000);
			assert.strictEqual(updated.toolCalls, 3);
		});

		it('handles unknown tokens', () => {
			const consumption: BudgetConsumption = {
				experimentsStarted: 0,
				attemptsMade: 0,
				modelCalls: 0,
				tokensUsed: 'unknown',
				durationMs: 0,
				toolCalls: 0,
				filesTouched: 0,
			};

			const updated = recordConsumption(consumption, { tokens: 500 });
			assert.strictEqual(updated.tokensUsed, 'unknown');
		});
	});

	describe('checkSessionStatus', () => {
		it('returns active when within budget', () => {
			const session = createExperimentSession(sampleTask, 'Test goal', defaultBudget, now);
			assert.strictEqual(checkSessionStatus(session), 'active');
		});

		it('returns exhausted when max experiments reached', () => {
			const session = createExperimentSession(sampleTask, 'Test goal', defaultBudget, now);
			const exhaustedSession: ExperimentSession = {
				...session,
				consumption: { ...session.consumption, experimentsStarted: 5 },
			};
			assert.strictEqual(checkSessionStatus(exhaustedSession), 'exhausted');
		});

		it('returns exhausted when max model calls reached', () => {
			const session = createExperimentSession(sampleTask, 'Test goal', defaultBudget, now);
			const exhaustedSession: ExperimentSession = {
				...session,
				consumption: { ...session.consumption, modelCalls: 20 },
			};
			assert.strictEqual(checkSessionStatus(exhaustedSession), 'exhausted');
		});
	});

	describe('areExperimentsEquivalent', () => {
		it('returns true for same hypothesis and approach', () => {
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
				objective: 'Test 2',
				hypothesis: 'H1',
				informationGaps: [],
				approach: 'A1',
				criteria: defaultCriteria,
				models: ['provider-1:model-b'],
				strategy: 'fallback',
				budget: defaultBudget,
			}, now);

			assert.ok(areExperimentsEquivalent(exp1, exp2));
		});

		it('returns false for different hypothesis', () => {
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
				approach: 'A1',
				criteria: defaultCriteria,
				models: ['provider-1:model-a'],
				strategy: 'manual',
				budget: defaultBudget,
			}, now);

			assert.ok(!areExperimentsEquivalent(exp1, exp2));
		});

		it('returns false for different approach', () => {
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

			assert.ok(!areExperimentsEquivalent(exp1, exp2));
		});
	});
});

describe('experimentLog', () => {
	let store: FileDataStore;
	let log: ReturnType<typeof createExperimentLog>;

	beforeEach(async () => {
		await rm(testDir, { recursive: true, force: true });
		store = new FileDataStore({ rootPath: testDir });
		log = createExperimentLog(store);
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	it('appends and reconstructs sessions', async () => {
		const session = createExperimentSession(sampleTask, 'Test goal', defaultBudget, now);
		await log.append(buildSessionStartEntry(session));

		const sessions = await log.listSessions();
		assert.strictEqual(sessions.length, 1);
		assert.strictEqual(sessions[0].id, session.id);
		assert.strictEqual(sessions[0].goal, 'Test goal');
	});

	it('appends experiments to session', async () => {
		const session = createExperimentSession(sampleTask, 'Test goal', defaultBudget, now);
		await log.append(buildSessionStartEntry(session));

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
		await log.append(buildExperimentStartEntry(experiment));

		const sessions = await log.listSessions();
		assert.strictEqual(sessions[0].experiments.length, 1);
		assert.strictEqual(sessions[0].experiments[0].id, experiment.id);
	});

	it('appends evidence to experiment', async () => {
		const session = createExperimentSession(sampleTask, 'Test goal', defaultBudget, now);
		await log.append(buildSessionStartEntry(session));

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
		await log.append(buildExperimentStartEntry(experiment));

		const evidence: Evidence = {
			id: 'ev-1',
			type: 'model-output',
			description: 'Test output',
			data: { output: 'test' },
			timestamp: now,
			step: 1,
		};
		await log.append(buildEvidenceEntry(experiment, evidence));

		const sessions = await log.listSessions();
		assert.strictEqual(sessions[0].experiments[0].evidence.length, 1);
	});

	it('appends evaluation to experiment', async () => {
		const session = createExperimentSession(sampleTask, 'Test goal', defaultBudget, now);
		await log.append(buildSessionStartEntry(session));

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
		await log.append(buildExperimentStartEntry(experiment));

		const evaluation: ExperimentEvaluation = {
			verdict: 'passed',
			criterionEvaluations: [],
			overallScore: 1,
			summary: 'All good',
		};
		await log.append(buildEvaluationEntry(experiment, evaluation));

		const sessions = await log.listSessions();
		assert.ok(sessions[0].experiments[0].evaluation !== undefined);
		assert.strictEqual(sessions[0].experiments[0].evaluation?.verdict, 'passed');
	});

	it('appends session end with status', async () => {
		const session = createExperimentSession(sampleTask, 'Test goal', defaultBudget, now);
		await log.append(buildSessionStartEntry(session));

		const consumption = {
			experimentsStarted: 1,
			attemptsMade: 2,
			modelCalls: 3,
			tokensUsed: 5000,
			durationMs: 10000,
			toolCalls: 1,
			filesTouched: 2,
		};
		await log.append(buildSessionEndEntry(session, 'completed', consumption));

		const sessions = await log.listSessions();
		assert.strictEqual(sessions[0].status, 'completed');
		assert.strictEqual(sessions[0].consumption.modelCalls, 3);
	});

	it('persists across instances', async () => {
		const session = createExperimentSession(sampleTask, 'Test goal', defaultBudget, now);
		await log.append(buildSessionStartEntry(session));

		const log2 = createExperimentLog(store);
		const sessions = await log2.listSessions();
		assert.strictEqual(sessions.length, 1);
	});

	it('clears all entries', async () => {
		const session = createExperimentSession(sampleTask, 'Test goal', defaultBudget, now);
		await log.append(buildSessionStartEntry(session));
		await log.clear();
		const sessions = await log.listSessions();
		assert.strictEqual(sessions.length, 0);
	});

	it('bounds entries to MAX_ENTRIES', async () => {
		for (let i = 0; i < 50; i++) {
			const session = createExperimentSession(sampleTask, `Goal ${i}`, defaultBudget, now);
			await log.append(buildSessionStartEntry(session));
		}
		const sessions = await log.listSessions();
		assert.strictEqual(sessions.length, 50);
	});
});