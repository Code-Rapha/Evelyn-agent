/**
 * The learning pipeline: from recorded runs to a reviewable reading.
 *
 * Runs under plain mocha via `npm run test:core`. No Electron, no network, no
 * model call, and every path under a temporary directory removed in `teardown`.
 *
 * The suite is organised around the claims this stage makes rather than around
 * its functions, and two of those claims get their own groups because they are
 * the ones that would be silently wrong:
 *
 * - **An unverified run is not a failure.** The load-bearing test is
 *   `three unverified runs propose nothing`: `evaluateExperiment` marks a
 *   criterion failed when there is no evidence for it, which is correct for a
 *   verdict and catastrophic for learning. Three such runs, counted as failures,
 *   would rewrite a skill nobody ever tested.
 * - **A model is not declared better.** The scan refuses to compare on one
 *   sample, and the model summary counts unverified runs without scoring them.
 */
import * as assert from 'assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileDataStore } from '../adapters/local/fileDataStore';
import {
	adaptExperimentRun,
	adaptOrchestrationRun,
	buildProposalDraft,
	readLearningHistory,
	scanForSkillImprovements,
	summarizeModelObservations,
	MIN_VERIFIED_CRITERIA,
	type ExperimentRunSource,
	type LearningHistorySource,
	type RunObservation,
} from '../desktop/learningPipeline';
import {
	createExperiment,
	createExperimentSession,
	addEvidence,
	type Experiment,
	type ExperimentBudget,
	type ExperimentSession,
	type SuccessCriterion,
} from '../desktop/experiment';
import {
	createDetailedEvaluation,
	type DetailedEvaluation,
} from '../desktop/evaluation';
import type { EvidenceLink } from '../desktop/evaluation';
import {
	createExperimentLog,
	type ExperimentLog,
} from '../desktop/experimentLog';
import { createEvaluationLog, type EvaluationLog } from '../desktop/evaluationLog';
import { createOrchestrationLog, type OrchestrationLogEntry } from '../desktop/orchestrationLog';
import { createFileSkillService } from '../core/skill/fileSkillService';
import { FileStorageService } from '../adapters/local/fileStorageService';
import type { SkillService } from '../core/skill/types';
import type { TaskClassification } from '../desktop/taskDiscovery';
import type { SelectableModel } from '../desktop/modelSelector';
import { MIN_SAMPLES_TO_PROPOSE } from '../core/skill/skillEvolution';

const NOW = '2024-07-01T10:00:00.000Z';

const BUDGET: ExperimentBudget = {
	maxExperiments: 5,
	maxAttemptsPerExperiment: 3,
	maxModelCalls: 20,
	maxTokens: 100_000,
	maxDurationMs: 300_000,
	maxToolCalls: 10,
	maxFilesTouched: 20,
};

/** Two criteria that a string output can be checked against. */
const CRITERIA: readonly SuccessCriterion[] = [
	{ id: 'criterio-presente', description: 'A saída menciona a função', kind: 'contains', expected: 'function', weight: 0.5 },
	{ id: 'criterio-classe', description: 'A saída menciona a classe', kind: 'contains', expected: 'class', weight: 0.5 },
];

const TASK: TaskClassification = {
	primaryGoal: 'Gerar uma função',
	domain: 'coding',
	complexity: 'simple',
	needsTools: false,
	requiredCapabilities: ['code-generation'],
	missingInformation: [],
	confidence: 0.8,
	rationale: 'teste',
};

/** A session carrying one experiment. */
function makeSession(): ExperimentSession {
	return createExperimentSession(TASK, 'Melhorar a geração de funções', BUDGET, NOW);
}

/** An experiment with evidence and a verdict, as the log would hold it. */
function makeExperiment(
	session: ExperimentSession,
	options: { readonly evidence?: string; readonly state?: Experiment['state'] } = {},
): Experiment {
	const experiment = createExperiment(
		{
			sessionId: session.id,
			objective: 'Criar uma função de validação',
			hypothesis: 'Pedir a classe primeiro evita retrabalho',
			informationGaps: [],
			approach: 'declarar-classe-depois-funcao',
			criteria: CRITERIA,
			models: ['9router:space-bunny-alpha'],
			strategy: 'manual',
			budget: BUDGET,
		},
		NOW,
	);
	const withEvidence =
		options.evidence === undefined
			? experiment
			: addEvidence(experiment, {
					type: 'model-output',
					description: 'Resposta do modelo',
					data: options.evidence,
					step: 1,
				}, NOW);

	return options.state === undefined ? withEvidence : { ...withEvidence, state: options.state };
}

/** The evaluation the layer would produce for an experiment. */
function evaluate(experiment: Experiment, output: string): DetailedEvaluation {
	return createDetailedEvaluation(experiment, () => output);
}

/**
 * An experiment that both fails its criteria and has evidence saying so.
 *
 * `state: 'completed'` matters and is not decoration: the adapter refuses to
 * learn from an experiment that was only ever defined, which is the whole point
 * of the guard — a fixture that forgot it would be testing nothing.
 */
function failingRun(session: ExperimentSession): Experiment {
	return {
		...makeExperiment(session, { evidence: 'aqui está o resultado' }),
		state: 'completed',
		evaluation: {
			verdict: 'failed',
			criterionEvaluations: CRITERIA.map((criterion) => ({
				criterionId: criterion.id,
				passed: false,
				actualValue: 'aqui está o resultado',
				reason: `não contém "${String(criterion.expected)}"`,
			})),
			overallScore: 0,
			summary: 'nenhum critério atendido',
		},
	};
}

/** An experiment that passes both criteria with evidence. */
function passingRun(session: ExperimentSession): Experiment {
	const withEvidence = makeExperiment(session, { evidence: 'function f(){} class C {}' });
	return {
		...withEvidence,
		state: 'completed',
		evaluation: {
			verdict: 'passed',
			criterionEvaluations: CRITERIA.map((criterion) => ({
				criterionId: criterion.id,
				passed: true,
				actualValue: 'function f(){} class C {}',
				reason: 'atendido',
			})),
			overallScore: 1,
			summary: 'tudo atendido',
		},
	};
}

/** An orchestration entry as the log holds it. */
function makeOrchestrationEntry(
	overrides: Partial<OrchestrationLogEntry> = {},
): OrchestrationLogEntry {
	return {
		id: 'log-1',
		timestamp: NOW,
		conversationId: 'conv-1',
		task: TASK,
		strategy: 'manual',
		primaryModel: '9router:space-bunny-alpha',
		attempts: [],
		result: 'success',
		finalModel: '9router:space-bunny-alpha',
		summary: 'strategy=manual; result=success',
		...overrides,
	};
}

/** A model the selector would have returned as unknown: served, but undescribed. */
function unknownModel(providerId: string, modelId: string): SelectableModel {
	return {
		providerId,
		modelId,
		providerName: providerId,
		available: true,
		catalog: {
			providerId,
			modelId,
			access: 'unknown',
			observations: [],
			createdAt: NOW,
			updatedAt: NOW,
		},
	};
}

suite('Learning pipeline', () => {
	let root: string;
	let store: FileDataStore;
	let experimentLog: ExperimentLog;
	let evaluationLog: EvaluationLog;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-pipeline-'));
		store = new FileDataStore({ rootPath: root });
		experimentLog = createExperimentLog(store);
		evaluationLog = createEvaluationLog(store);
	});

	teardown(async () => {
		await rm(root, { recursive: true, force: true });
	});

	// ── adapting an experiment ───────────────────────────────────────────────

	suite('adapting a recorded experiment', () => {
		test('a verified failure keeps only the criteria that were actually checked', () => {
			const session = makeSession();
			const experiment = failingRun(session);
			const detailed = evaluate(experiment, 'aqui está o resultado');

			const observation = adaptExperimentRun({ session, experiment, evaluation: detailed })!;

			assert.strictEqual(observation.verdict, 'failed');
			assert.strictEqual(observation.insufficientReason, undefined);
			assert.strictEqual(observation.verifiedCriteria, CRITERIA.length);
			assert.deepStrictEqual([...observation.verifiedFailures], ['criterio-presente', 'criterio-classe']);
			assert.strictEqual(observation.domain, 'coding');
			assert.strictEqual(observation.source, 'experiment');
			assert.strictEqual(observation.refId, experiment.id);
		});

		test('a criterion with no evidence is unverifiable, not a failure', () => {
			const session = makeSession();
			const experiment = failingRun(session);
			// An evaluation where only one criterion was ever linked to evidence.
			const partial: DetailedEvaluation = {
				...evaluate(experiment, 'aqui está o resultado'),
				evidenceLinks: [
					{
						evidenceId: 'ev-1',
						criterionId: 'criterio-presente',
						role: 'contradicting',
						reason: 'não contém',
						classificationConfidence: 0.7,
					},
				],
				unverifiableCriteria: ['criterio-classe'],
			};

			const observation = adaptExperimentRun({ session, experiment, evaluation: partial })!;

			assert.deepStrictEqual(
				[...observation.verifiedFailures],
				['criterio-presente'],
				'a criterion nobody checked must not be counted as a failure',
			);
			assert.deepStrictEqual([...observation.unverifiableCriteria], ['criterio-classe']);
			assert.strictEqual(observation.verifiedCriteria, 1);
		});

		test('an experiment that was never executed yields no observation at all', () => {
			const session = makeSession();

			assert.strictEqual(adaptExperimentRun({ session, experiment: makeExperiment(session) }), undefined);
			assert.strictEqual(
				adaptExperimentRun({ session, experiment: makeExperiment(session, { state: 'authorizing' }) }),
				undefined,
			);
		});

		test('a run carrying a verdict but no evidence is inconclusive, not a failure', () => {
			const session = makeSession();
			// The exact shape this guard exists for: `evaluateExperiment` marks a
			// criterion failed when no evidence covers it, so an experiment that was
			// never really checked still comes out with verdict `failed`. Counted as
			// evidence of a broken skill, three of these would rewrite a skill nobody
			// ever tested.
			const unverified: Experiment = {
				...failingRun(session),
				// The evidence removed; the verdict stays as the layer left it.
				evidence: [],
			};
			assert.strictEqual(
				unverified.evaluation?.verdict,
				'failed',
				'the fixture must still look like a failure before adaptation, or it tests nothing',
			);

			const observation = adaptExperimentRun({ session, experiment: unverified })!;

			assert.strictEqual(observation.verdict, 'inconclusive');
			assert.ok(observation.insufficientReason !== undefined);
			assert.match(observation.insufficientReason!, /nenhum critério foi verificado/);
			assert.strictEqual(observation.verifiedCriteria, 0);
			assert.deepStrictEqual([...observation.failedCriteria], []);
		});

		test('a run whose own evaluation recorded a real check counts as verified', () => {
			const session = makeSession();
			// No detailed evaluation, but the experiment has evidence and a
			// criterion evaluation carrying a value — the evaluation layer's own
			// record that a check ran.
			const observation = adaptExperimentRun({ session, experiment: failingRun(session) })!;

			assert.strictEqual(observation.verdict, 'failed');
			assert.strictEqual(observation.insufficientReason, undefined);
			assert.strictEqual(observation.verifiedCriteria, CRITERIA.length);
		});

		test('a run with neither an evaluation nor evidence verifies nothing', () => {
			const session = makeSession();
			const bare: Experiment = { ...failingRun(session), evidence: [], evaluation: undefined };

			const observation = adaptExperimentRun({ session, experiment: bare })!;

			assert.strictEqual(observation.verdict, 'inconclusive');
			assert.strictEqual(observation.verifiedCriteria, 0);
		});

		test('an experiment with no criteria says so rather than being counted as a failure', () => {
			const session = makeSession();
			const experiment = {
				...makeExperiment(session, { evidence: 'saída' }),
				state: 'completed' as const,
				criteria: [],
				evaluation: {
					verdict: 'inconclusive' as const,
					criterionEvaluations: [],
					overallScore: 0,
					summary: 'sem critérios',
				},
			};

			const observation = adaptExperimentRun({ session, experiment })!;

			assert.strictEqual(observation.verdict, 'inconclusive');
			assert.match(observation.insufficientReason!, /não definiu critérios/);
		});

		test('conflicting evidence makes the run inconclusive rather than a failure', () => {
			const session = makeSession();
			const experiment = failingRun(session);
			const detailed: DetailedEvaluation = {
				...evaluate(experiment, 'aqui está o resultado'),
				hasConflictingEvidence: true,
			};

			const observation = adaptExperimentRun({ session, experiment, evaluation: detailed })!;

			assert.strictEqual(observation.verdict, 'inconclusive');
			assert.match(observation.insufficientReason!, /se contradizem/);
		});

		test('a run carries the skill it was performed with, when the caller knows it', () => {
			const session = makeSession();
			const experiment = failingRun(session);
			const observation = adaptExperimentRun({
				session,
				experiment,
				evaluation: evaluate(experiment, 'aqui está o resultado'),
				skillIds: ['revisao-de-codigo', 'validadores'],
			})!;

			// Sorted, so the same set of skills always names the same one — an
			// unstable attribution would split a failure across two skills and hide
			// the pattern.
			assert.strictEqual(observation.skillId, 'revisao-de-codigo');
		});

		test('an unknown skill is recorded as unknown, not invented', () => {
			const session = makeSession();
			const experiment = failingRun(session);
			const observation = adaptExperimentRun({
				session,
				experiment,
				evaluation: evaluate(experiment, 'aqui está o resultado'),
			})!;

			assert.strictEqual(observation.skillId, '');
		});

		test('the model and its provider come from the experiment', () => {
			const session = makeSession();
			const experiment = failingRun(session);
			const observation = adaptExperimentRun({
				session,
				experiment,
				evaluation: evaluate(experiment, 'aqui está o resultado'),
			})!;

			assert.strictEqual(observation.providerId, '9router');
			assert.strictEqual(observation.modelId, 'space-bunny-alpha');
		});

		test('a duration recorded by the run is measured, with its provenance', () => {
			const session = makeSession();
			const experiment = {
				...failingRun(session),
				consumption: { ...failingRun(session).consumption, durationMs: 4_200 },
			};

			const observation = adaptExperimentRun({
				session,
				experiment,
				evaluation: evaluate(experiment, 'aqui está o resultado'),
			})!;

			assert.strictEqual(observation.durationMs?.kind, 'measured');
			assert.strictEqual(observation.durationMs?.value, 4_200);
			assert.ok(observation.durationMs?.note !== undefined);
		});

		test('an absent duration is unknown, never zero', () => {
			const session = makeSession();
			const experiment = failingRun(session);
			const observation = adaptExperimentRun({
				session,
				experiment,
				evaluation: evaluate(experiment, 'aqui está o resultado'),
			})!;

			assert.strictEqual(observation.durationMs?.kind, 'unknown');
			assert.strictEqual(observation.durationMs?.value, undefined);
			assert.match(observation.durationMs!.note, /não registrou duração/);
		});

		test('a zero token count is treated as an absent measurement, not free usage', () => {
			const session = makeSession();
			const experiment = {
				...failingRun(session),
				consumption: { ...failingRun(session).consumption, tokensUsed: 0 },
			};

			const observation = adaptExperimentRun({
				session,
				experiment,
				evaluation: evaluate(experiment, 'aqui está o resultado'),
			})!;

			assert.strictEqual(observation.tokensUsed?.kind, 'unknown');
			assert.match(observation.tokensUsed!.note, /ausência de medição/);
		});

		test('an unknown token count stays unknown with its reason', () => {
			const session = makeSession();
			const experiment = failingRun(session);
			const observation = adaptExperimentRun({
				session,
				experiment,
				evaluation: evaluate(experiment, 'aqui está o resultado'),
			})!;

			assert.strictEqual(observation.tokensUsed?.kind, 'unknown');
			assert.match(observation.tokensUsed!.note, /não reportou contagem/);
		});

		test('the verdict confidence comes from the evaluation layer, with its rationale', () => {
			const session = makeSession();
			const experiment = failingRun(session);
			const detailed = evaluate(experiment, 'aqui está o resultado');

			const observation = adaptExperimentRun({ session, experiment, evaluation: detailed })!;

			assert.strictEqual(observation.verdictConfidence?.kind, 'measured');
			assert.ok(observation.verdictConfidence?.note !== undefined);
			assert.ok(observation.verdictConfidence!.note!.includes(detailed.confidenceRationale));
		});

		test('without an evaluation there is no confidence to report', () => {
			const session = makeSession();
			const experiment = failingRun(session);
			const observation = adaptExperimentRun({ session, experiment })!;

			assert.strictEqual(observation.verdictConfidence?.kind, 'unknown');
			assert.strictEqual(observation.verdictConfidence?.value, undefined);
		});

		test('the minimum for counting a run is one verified criterion', () => {
			assert.strictEqual(MIN_VERIFIED_CRITERIA, 1);
		});
	});

	// ── the load-bearing guarantee ───────────────────────────────────────────

	suite('an unverified run is never counted as a failure', () => {
		test('three unverified runs propose nothing', async () => {
			// Exactly the trap this stage exists to avoid: an experiment carrying a
			// `failed` verdict with no evidence behind it. Counted as failures, three
			// of these would be enough to propose rewriting a skill that nobody ever
			// tested.
			const session = makeSession();
			const experiments = Array.from({ length: 3 }, (_, index) => ({
				...failingRun(session),
				id: `exp-${index}` as Experiment['id'],
				// The evidence removed; the verdict stays as the layer left it.
				evidence: [],
			}));
			assert.strictEqual(
				experiments.every((experiment) => experiment.evaluation?.verdict === 'failed'),
				true,
				'the fixtures must still look like failures before adaptation',
			);

			const scan = await scanForSkillImprovements({
				experimentLog: {
					listSessions: async () => [{ ...session, experiments }],
					listExperiments: async () => experiments,
				},
			});

			assert.strictEqual(scan.ok, true);
			assert.strictEqual(scan.runsRead, 3);
			assert.strictEqual(scan.usableRuns, 0);
			assert.strictEqual(scan.unverifiedRuns, 3);
			assert.deepStrictEqual(
				scan.opportunities.filter((opportunity) => opportunity.kind === 'recurring-failure'),
				[],
				'an unverified failure must never become a recurring-failure finding',
			);
		});

		test('the same history with evidence does produce a finding', async () => {
			const session = makeSession();
			const experiments = [
				failingRun(session),
				{ ...failingRun(session), id: 'exp-2' as Experiment['id'] },
				{ ...failingRun(session), id: 'exp-3' as Experiment['id'] },
			];
			const detailed = evaluate(experiments[0]!, 'aqui está o resultado');

			const scan = await scanForSkillImprovements({
				experimentLog: {
					listSessions: async () => [{ ...session, experiments }],
					listExperiments: async () => experiments,
				},
				evaluationLog: { getLatestEvaluation: async () => detailed },
			});

			assert.strictEqual(scan.usableRuns, MIN_SAMPLES_TO_PROPOSE);
			assert.ok(
				scan.opportunities.some((opportunity) => opportunity.kind === 'recurring-failure'),
				'with evidence behind them, the same failures must be reportable',
			);
		});
	});

	// ── adapting an orchestration entry ──────────────────────────────────────

	suite('adapting an orchestration entry', () => {
		test('a turn that streamed without error is never "passed"', () => {
			const observation = adaptOrchestrationRun(makeOrchestrationEntry({ result: 'success' }));

			assert.strictEqual(
				observation.verdict,
				'inconclusive',
				'a turn that answered is not a task that was verified correct',
			);
			assert.strictEqual(observation.verifiedCriteria, 0);
			assert.ok(observation.insufficientReason !== undefined);
			assert.match(observation.insufficientReason!, /não verifica nenhum critério/);
		});

		test('a failed turn is also not a confirmed failure of the approach', () => {
			const observation = adaptOrchestrationRun(
				makeOrchestrationEntry({ result: 'failed', attempts: [] }),
			);

			assert.strictEqual(observation.verdict, 'inconclusive');
			assert.strictEqual(observation.failedCriteria.length, 0);
		});

		test('the model is taken from the turn, and the duration is honestly absent', () => {
			const observation = adaptOrchestrationRun(
				makeOrchestrationEntry({ finalModel: '9router:space-bunny-alpha', primaryModel: undefined }),
			);

			assert.strictEqual(observation.providerId, '9router');
			assert.strictEqual(observation.modelId, 'space-bunny-alpha');
			assert.strictEqual(observation.durationMs?.kind, 'unknown');
			assert.match(observation.durationMs!.note, /sem duração/);
		});

		test('a model string without a provider is not split into a fake pair', () => {
			const observation = adaptOrchestrationRun(
				makeOrchestrationEntry({ finalModel: undefined, primaryModel: 'so-o-modelo' }),
			);

			assert.strictEqual(observation.providerId, undefined);
			assert.strictEqual(observation.modelId, undefined);
		});

		test('retries are counted from the attempts, when there were any', () => {
			const observation = adaptOrchestrationRun(
				makeOrchestrationEntry({
					attempts: [
						{
							attempt: 1,
							model: unknownModel('p', 'm'),
							recoverable: true,
							timestamp: NOW,
						},
						{
							attempt: 2,
							model: unknownModel('p', 'm2'),
							recoverable: true,
							timestamp: NOW,
						},
					],
				}),
			);

			assert.strictEqual(observation.retries, 1);
			assert.strictEqual(observation.modelCalls?.kind, 'measured');
			assert.strictEqual(observation.modelCalls?.value, 2);
		});
	});

	// ── reading the history ──────────────────────────────────────────────────

	suite('reading the history', () => {
		/** An experiment log built from sessions, without touching disk. */
		function experimentLogOf(sessions: readonly ExperimentSession[]): Pick<ExperimentLog, 'listSessions' | 'listExperiments'> {
			return {
				listSessions: async () => sessions,
				listExperiments: async (sessionId: string) =>
					sessions.find((session) => session.id === sessionId)?.experiments ?? [],
			};
		}

		test('an empty history reads as empty, not as an error', async () => {
			const result = await readLearningHistory({});

			assert.deepStrictEqual([...result.runs], []);
			assert.deepStrictEqual([...result.errors], []);
			assert.deepStrictEqual([...result.skipped], []);
		});

		test('a log that cannot be read is reported, not thrown', async () => {
			const result = await readLearningHistory({
				experimentLog: {
					listSessions: async () => {
						throw new Error('disco cheio');
					},
					listExperiments: async () => [],
				},
			});

			assert.deepStrictEqual([...result.runs], []);
			assert.strictEqual(result.errors.length, 1);
			assert.match(result.errors[0]!, /disco cheio/);
		});

		test('one unreadable session does not lose the others', async () => {
			const good = makeSession();
			const withRuns: ExperimentSession = { ...good, experiments: [failingRun(good)] };

			const result = await readLearningHistory({
				experimentLog: {
					listSessions: async () => [good, { ...good, id: 'exp-session-quebrado' as ExperimentSession['id'] }],
					listExperiments: async (sessionId) => {
						if (sessionId === 'exp-session-quebrado') {
							throw new Error('sessão corrompida');
						}
						return sessionId === good.id ? withRuns.experiments : [];
					},
				},
			});

			assert.strictEqual(result.errors.length, 1);
			assert.match(result.errors[0]!, /sessão corrompida/);
		});

		test('an experiment never executed is skipped with its reason', async () => {
			const session = makeSession();
			const notRun: ExperimentSession = { ...session, experiments: [makeExperiment(session)] };

			const result = await readLearningHistory({ experimentLog: experimentLogOf([notRun]) });

			assert.deepStrictEqual([...result.runs], []);
			assert.strictEqual(result.skipped.length, 1);
			assert.match(result.skipped[0]!.reason, /nunca foi executado/);
		});

		test('orchestration entries join the experiments in one reading', async () => {
			const session = makeSession();
			const experiments = [failingRun(session)];
			const orchestrationLog = createOrchestrationLog(store);
			await orchestrationLog.append({
				conversationId: 'conv-1',
				task: TASK,
				strategy: 'manual',
				primaryModel: '9router:space-bunny-alpha',
				attempts: [],
				result: 'success',
				finalModel: '9router:space-bunny-alpha',
				summary: 'ok',
			});

			const result = await readLearningHistory({
				experimentLog: experimentLogOf([{ ...session, experiments }]),
				orchestrationLog,
			});

			assert.strictEqual(result.runs.length, 2);
			assert.deepStrictEqual(
				result.runs.map((run) => run.source).sort(),
				['conversation', 'experiment'],
			);
		});

		test('the skills a conversation ran with are attached when the caller recorded them', async () => {
			const session = makeSession();
			const entry = makeOrchestrationEntry();

			const result = await readLearningHistory(
				{
					orchestrationLog: { list: async () => [entry] },
				},
				{ skillsByConversation: new Map([['conv-1', ['skill-de-revisao']]]) },
			);

			assert.strictEqual(result.runs[0]!.skillId, 'skill-de-revisao');
		});

		test('an orchestration log that cannot be read is reported', async () => {
			const result = await readLearningHistory({
				orchestrationLog: {
					list: async () => {
						throw new Error('log truncado');
					},
				},
			});

			assert.strictEqual(result.errors.length, 1);
			assert.match(result.errors[0]!, /log de orquestração/);
		});
	});

	// ── scanning ────────────────────────────────────────────────────────────

	suite('scanning for improvements', () => {
		/** A log holding `count` verified failures of the same criterion. */
		function failingHistory(count: number): LearningHistorySource {
			const session = makeSession();
			const experiments = Array.from({ length: count }, (_, index) => ({
				...failingRun(session),
				id: `exp-${index}` as Experiment['id'],
			}));
			const detailed = evaluate(experiments[0]!, 'aqui está o resultado');
			return {
				experimentLog: {
					listSessions: async () => [{ ...session, experiments }],
					listExperiments: async () => experiments,
				},
				evaluationLog: { getLatestEvaluation: async () => detailed },
			};
		}

		test('an empty history says so instead of finding nothing mysteriously', async () => {
			const scan = await scanForSkillImprovements({});

			assert.strictEqual(scan.ok, true);
			assert.strictEqual(scan.runsRead, 0);
			assert.deepStrictEqual([...scan.opportunities], []);
			assert.match(scan.summary, /Nenhuma execução registrada/);
		});

		test('enough verified failures produce a finding with its runs named', async () => {
			const scan = await scanForSkillImprovements(failingHistory(MIN_SAMPLES_TO_PROPOSE));

			const finding = scan.opportunities.find((o) => o.kind === 'recurring-failure');
			assert.ok(finding);
			assert.strictEqual(finding.sampleSize, MIN_SAMPLES_TO_PROPOSE);
			assert.strictEqual(finding.supportingRuns.length, MIN_SAMPLES_TO_PROPOSE);
			assert.ok(finding.untestedCases.length > 0);
		});

		test('a scan of the same history twice does not re-raise the same question', async () => {
			const source = failingHistory(MIN_SAMPLES_TO_PROPOSE);
			const first = await scanForSkillImprovements(source);
			assert.ok(first.opportunities.length > 0);

			const second = await scanForSkillImprovements(source, {
				knownFingerprints: first.opportunities.map((o) => o.fingerprint),
			});

			assert.deepStrictEqual(
				second.opportunities.map((o) => o.fingerprint),
				[],
				'a fingerprint already on the user\'s desk must not come back',
			);
		});

		test('failures in unrelated domains are not aggregated into one finding', async () => {
			const session = makeSession();
			// Two runs per domain: below the threshold on every side. A finding here
			// could only have come from summing unrelated failures, which would claim
			// a single problem in three places that never affected each other.
			const perDomain = MIN_SAMPLES_TO_PROPOSE - 1;
			const experiments = ['coding', 'database', 'writing'].flatMap((domain) =>
				Array.from({ length: perDomain }, (_, index) => ({
					...failingRun(session),
					id: `exp-${domain}-${index}` as Experiment['id'],
				})),
			);
			const detailed = evaluate(experiments[0]!, 'aqui está o resultado');

			const domainSessions: ExperimentSession[] = ['coding', 'database', 'writing'].map((domain) => ({
				...session,
				id: `exp-session-${domain}` as ExperimentSession['id'],
				task: { ...TASK, domain: domain as TaskClassification['domain'] },
				experiments: experiments.filter((experiment) =>
					experiment.id.startsWith(`exp-${domain}-`),
				),
			}));

			const scan = await scanForSkillImprovements({
				experimentLog: {
					listSessions: async () => domainSessions,
					listExperiments: async (sessionId) =>
						domainSessions.find((s) => s.id === sessionId)?.experiments ?? [],
				},
				evaluationLog: { getLatestEvaluation: async () => detailed },
			});

			assert.deepStrictEqual(
				scan.opportunities.filter((o) => o.kind === 'recurring-failure'),
				[],
				'unrelated domains must not be summed into one finding',
			);
		});

		test('the summary reports how many runs were not counted and why that matters', async () => {
			const session = makeSession();
			const verified = Array.from({ length: 3 }, (_, index) => ({
				...failingRun(session),
				id: `exp-${index}` as Experiment['id'],
			}));
			const detailed = evaluate(verified[0]!, 'aqui está o resultado');

			const scan = await scanForSkillImprovements({
				experimentLog: {
					listSessions: async () => [{ ...session, experiments: verified }],
					listExperiments: async () => verified,
				},
				evaluationLog: { getLatestEvaluation: async () => detailed },
				orchestrationLog: {
					list: async () => [makeOrchestrationEntry()],
				},
			});

			assert.strictEqual(scan.runsRead, 4);
			assert.strictEqual(scan.usableRuns, 3);
			assert.strictEqual(scan.unverifiedRuns, 1);
			assert.match(scan.summary, /sem evidência suficiente/);
		});

		test('a read error is reported in the result without hiding the findings that were read', async () => {
			const session = makeSession();
			const experiments = Array.from({ length: 3 }, (_, index) => ({
				...failingRun(session),
				id: `exp-${index}` as Experiment['id'],
			}));
			const detailed = evaluate(experiments[0]!, 'aqui está o resultado');

			const scan = await scanForSkillImprovements({
				experimentLog: {
					listSessions: async () => [{ ...session, experiments }],
					listExperiments: async () => {
						throw new Error('leitura falhou');
					},
				},
				evaluationLog: { getLatestEvaluation: async () => detailed },
			});

			assert.strictEqual(scan.ok, true);
			assert.strictEqual(scan.errors.length, 1);
			assert.strictEqual(scan.runsRead, 0);
		});

		test('a detector that throws is reported as a failure, not swallowed', async () => {
			const scan = await scanForSkillImprovements(
				{ experimentLog: { listSessions: async () => [], listExperiments: async () => [] } },
				{
					identify: () => {
						throw new Error('detector quebrado');
					},
				},
			);

			assert.strictEqual(scan.ok, false);
			assert.match(scan.error!, /detector quebrado/);
		});

		test('a detector that reports a failure is passed through', async () => {
			const scan = await scanForSkillImprovements(
				{ experimentLog: { listSessions: async () => [], listExperiments: async () => [] } },
				{
					identify: () => ({
						ok: false,
						opportunities: [],
						runsConsidered: 0,
						error: 'catálogo ausente',
					}),
				},
			);

			assert.strictEqual(scan.ok, false);
			assert.ok(scan.errors.some((message) => message.includes('catálogo ausente')));
		});

		test('the detectors receive only the usable runs', async () => {
			const session = makeSession();
			const verified = Array.from({ length: 3 }, (_, index) => ({
				...failingRun(session),
				id: `exp-${index}` as Experiment['id'],
			}));
			const detailed = evaluate(verified[0]!, 'aqui está o resultado');
			let seen = 0;

			await scanForSkillImprovements(
				{
					experimentLog: {
						listSessions: async () => [{ ...session, experiments: verified }],
						listExperiments: async () => verified,
					},
					evaluationLog: { getLatestEvaluation: async () => detailed },
					orchestrationLog: { list: async () => [makeOrchestrationEntry()] },
				},
				{
					identify: (input) => {
						seen = input.runs.length;
						return { ok: true, opportunities: [], runsConsidered: input.runs.length };
					},
				},
			);

			assert.strictEqual(seen, 3, 'the unverified orchestration entry must not reach the detectors');
		});
	});

	// ── models ──────────────────────────────────────────────────────────────

	suite('model observations', () => {
		/** A run observation for one model. */
		function modelRun(
			key: string,
			overrides: Partial<RunObservation> = {},
		): RunObservation {
			const [providerId = '', modelId = ''] = key.split(':');
			return {
				verdict: 'failed',
				source: 'experiment',
				refId: `ref-${key}`,
				domain: 'coding',
				skillId: '',
				failedCriteria: ['c1'],
				wastedSteps: 0,
				retries: 0,
				verifiedFailures: ['c1'],
				unverifiableCriteria: [],
				verifiedCriteria: MIN_SAMPLES_TO_PROPOSE,
				totalCriteria: MIN_SAMPLES_TO_PROPOSE,
				providerId,
				modelId,
				...overrides,
			};
		}

		test('one model with many unverified runs cannot be compared to anything', () => {
			const observations = summarizeModelObservations(
				Array.from({ length: 10 }, (_, index) =>
					modelRun('9router:space-bunny-alpha', {
						verdict: 'inconclusive',
						verifiedCriteria: 0,
						verifiedFailures: [],
						insufficientReason: 'sem evidência',
					}),
				),
			);

			assert.strictEqual(observations.length, 1);
			assert.strictEqual(observations[0]!.runs, 10);
			assert.strictEqual(observations[0]!.verifiedFailures, 0);
			assert.strictEqual(observations[0]!.unverifiedRuns, 10);
			assert.strictEqual(observations[0]!.canCompare, false);
			assert.match(observations[0]!.caveat, /nenhuma execução deste modelo foi verificada/);
		});

		test('only one model with verified runs is a record, not a comparison', () => {
			const observations = summarizeModelObservations([
				modelRun('9router:space-bunny-alpha'),
				modelRun('9router:space-bunny-alpha', { refId: 'ref-2' }),
			]);

			assert.strictEqual(observations[0]!.canCompare, false);
			assert.match(observations[0]!.caveat, /só um modelo tem execuções verificadas/);
		});

		test('two models with verified runs can be compared, and the caveat still says what is missing', () => {
			const observations = summarizeModelObservations([
				modelRun('9router:space-bunny-alpha'),
				modelRun('9router:space-bunny-alpha', { refId: 'ref-2' }),
				modelRun('outro:modelo-b'),
				modelRun('outro:modelo-b', { refId: 'ref-3' }),
			]);

			assert.ok(observations.every((observation) => observation.canCompare));
			for (const observation of observations) {
				assert.match(observation.caveat, /velocidade não é qualidade/);
			}
		});

		test('a single verified run per model is still too few', () => {
			const observations = summarizeModelObservations([
				modelRun('a:um'),
				modelRun('b:dois'),
			]);

			assert.ok(observations.every((observation) => !observation.canCompare));
			assert.match(observations[0]!.caveat, /amostra insuficiente para comparar/);
		});

		test('a fast model with no verified run is not called better than a slow one that is', () => {
			const observations = summarizeModelObservations([
				// Fast, but nothing was ever checked.
				modelRun('rapido:modelo', {
					verdict: 'inconclusive',
					verifiedCriteria: 0,
					verifiedFailures: [],
					insufficientReason: 'sem evidência',
					durationMs: { kind: 'measured', value: 400, note: 'cronômetro' },
				}),
				// Slower, and repeatedly verified.
				modelRun('lento:modelo', { durationMs: { kind: 'measured', value: 9_000, note: 'cronômetro' } }),
				modelRun('lento:modelo', { refId: 'ref-2', durationMs: { kind: 'measured', value: 9_500, note: 'cronômetro' } }),
			]);

			const fast = observations.find((o) => o.key === 'rapido:modelo')!;
			const slow = observations.find((o) => o.key === 'lento:modelo')!;

			assert.strictEqual(fast.canCompare, false);
			assert.strictEqual(fast.verifiedFailures, 0);
			assert.strictEqual(fast.unverifiedRuns, 1);
			assert.strictEqual(slow.verifiedFailures, 2);
			// The summary carries no score at all, so there is nothing to rank by.
			assert.strictEqual(
				Object.keys(observations[0]!).some((key) => /score|rating|rank|quality/i.test(key)),
				false,
			);
		});

		test('an absent duration is reported as unknown rather than zero', () => {
			const observations = summarizeModelObservations([modelRun('a:um')]);

			assert.strictEqual(observations[0]!.medianDurationMs.kind, 'unknown');
			assert.strictEqual(observations[0]!.medianDurationMs.value, undefined);
			assert.match(observations[0]!.medianDurationMs.note, /nenhuma execução verificada registrou duração/);
		});

		test('a measured duration is summarised as a median, labelled as derived', () => {
			const observations = summarizeModelObservations([
				modelRun('a:um', { durationMs: { kind: 'measured', value: 1_000, note: 'x' } }),
				modelRun('a:um', { refId: 'r2', durationMs: { kind: 'measured', value: 2_000, note: 'x' } }),
				modelRun('a:um', { refId: 'r3', durationMs: { kind: 'measured', value: 6_000, note: 'x' } }),
			]);

			assert.strictEqual(observations[0]!.medianDurationMs.kind, 'derived');
			assert.strictEqual(observations[0]!.medianDurationMs.value, 2_000);
			assert.match(observations[0]!.medianDurationMs.note, /mediana de 3 medições/);
		});

		test('an even number of measurements averages the middle two', () => {
			const observations = summarizeModelObservations([
				modelRun('a:um', { durationMs: { kind: 'measured', value: 1_000, note: 'x' } }),
				modelRun('a:um', { refId: 'r2', durationMs: { kind: 'measured', value: 3_000, note: 'x' } }),
			]);

			assert.strictEqual(observations[0]!.medianDurationMs.value, 2_000);
		});

		test('a run with no identifiable model is left out rather than filed under a blank key', () => {
			const observations = summarizeModelObservations([
				modelRun('a:um'),
				{ ...modelRun('a:um'), providerId: undefined, modelId: undefined },
			]);

			assert.strictEqual(observations.length, 1);
			assert.strictEqual(observations[0]!.key, 'a:um');
		});
	});

	// ── the draft handed to the review queue ─────────────────────────────────

	suite('proposal drafts', () => {
		test('a draft carries the evidence, the risks and how to judge the change', () => {
			const draft = buildProposalDraft(
				{
					kind: 'recurring-failure',
					problem: 'O critério X falhou',
					title: 'Falha recorrente',
					domains: ['coding'],
				},
				{
					title: 'Validação',
					description: 'Valida entradas',
					instructions: '1. Leia\n2. Valide',
					tags: [],
					requiredTools: ['fs.read'],
					riskLevel: 'moderate',
					constraints: [],
				},
			);

			assert.strictEqual(draft.proposed.instructions, '1. Leia\n2. Valide');
			assert.ok(draft.expectedBenefits.length > 0);
			assert.ok(draft.risks.length > 0);
			assert.strictEqual(draft.validationCriteria.length, 2);
			assert.ok(
				draft.validationCriteria.some((criterion) => criterion.id === 'vc-no-regression'),
				'a draft must say how to notice a regression, not only a gain',
			);
		});

		test('a draft for an unscoped finding says the evidence covers no domain', () => {
			const draft = buildProposalDraft(
				{ kind: 'recurring-failure', problem: 'p', title: 't', domains: [] },
				{
					title: 't',
					description: 'd',
					instructions: '1. algo',
					tags: [],
					requiredTools: [],
					riskLevel: 'safe',
					constraints: [],
				},
			);

			assert.match(draft.expectedBenefits[0]!, /domínio não especificado/);
			assert.match(draft.validationCriteria[0]!.observableAs, /desconhecido/);
		});
	});

	// ── end to end, through the real logs ───────────────────────────────────

	suite('end to end through the real logs', () => {
		/** A skill store over the same temporary root. */
		let storage: FileStorageService;
		let skillService: SkillService;

		setup(async () => {
			storage = new FileStorageService({ rootPath: join(root, 'storage') });
			await storage.initialize();
			skillService = createFileSkillService(storage);
		});

		test('a scan reads what the experiment log actually wrote', async () => {
			const session = createExperimentSession(TASK, 'Melhorar a geração', BUDGET, NOW);
			const experiments = Array.from({ length: 3 }, (_, index) => ({
				...failingRun(session),
				id: `exp-${index}` as Experiment['id'],
			}));

			// Written through the real log, then read back through the real log.
			await experimentLog.append({
				sessionId: session.id,
				experimentId: undefined,
				type: 'session-start',
				payload: session,
			});
			for (const experiment of experiments) {
				await experimentLog.append({
					sessionId: session.id,
					experimentId: experiment.id,
					type: 'experiment-start',
					payload: experiment,
				});
				await experimentLog.append({
					sessionId: session.id,
					experimentId: experiment.id,
					type: 'evaluation',
					payload: experiment.evaluation,
				});
			}

			const existing = await skillService.listSkills();
			const scan = await scanForSkillImprovements(
				{ experimentLog, evaluationLog },
				{
					existingSkills: existing.ok
						? existing.skills.map((skill) => ({ id: skill.id, instructions: skill.instructions }))
						: [],
				},
			);

			assert.strictEqual(scan.ok, true);
			assert.strictEqual(scan.runsRead, 3);
			assert.strictEqual(scan.usableRuns, 3);
			assert.ok(scan.opportunities.some((opportunity) => opportunity.kind === 'recurring-failure'));
		});

		test('a scan over a store with no logs at all reports an empty history', async () => {
			const scan = await scanForSkillImprovements({ experimentLog, evaluationLog });

			assert.strictEqual(scan.ok, true);
			assert.strictEqual(scan.runsRead, 0);
			assert.match(scan.summary, /Nenhuma execução registrada/);
		});

		test('a corrupt log file degrades to empty rather than failing the scan', async () => {
			const { writeFile } = await import('node:fs/promises');
			await writeFile(join(root, 'experimentLog.json'), '{ nao é json', 'utf8');

			const scan = await scanForSkillImprovements({ experimentLog, evaluationLog });

			assert.strictEqual(scan.ok, true);
			assert.strictEqual(scan.runsRead, 0);
		});

		test('nothing in the scan writes to the skill store', async () => {
			await skillService.createSkill({
				id: 'revisao',
				title: 'Revisão',
				description: 'Revisa código',
				instructions: '# Revisão\n\n1. Leia os arquivos.\n2. Relate.',
			});
			const before = await skillService.listSkills();

			await scanForSkillImprovements({ experimentLog, evaluationLog });

			const after = await skillService.listSkills();
			assert.deepStrictEqual(
				after.skills.map((skill) => `${skill.id}@${skill.version}`),
				before.skills.map((skill) => `${skill.id}@${skill.version}`),
				'analysing the history must not change any skill',
			);
		});

		test('no API key or transcript text reaches a run observation', async () => {
			const session = makeSession();
			const experiment = failingRun(session);
			const observation = adaptExperimentRun({
				session,
				experiment,
				evaluation: evaluate(experiment, 'aqui está o resultado'),
			})!;

			const serialized = JSON.stringify(observation);
			// Field names, not the words: "tokens" legitimately appears in the note
			// explaining that no token count was reported, and a regex broad enough
			// to catch that would be testing the wrong thing.
			assert.doesNotMatch(serialized, /"(?:apiKey|api_key|secret|password|accessToken)"/i);
			// The evidence *value* is not copied either: only which criteria were
			// checked and what they returned as pass/fail.
			assert.doesNotMatch(serialized, /aqui está o resultado/);
		});

		test('the raw evidence content never travels into a scan result', async () => {
			const session = makeSession();
			const secretish = 'sk-nao-leva-uma-chave-para-o-log';
			const experiment = makeExperiment(session, { evidence: secretish });
			const failed: Experiment = {
				...experiment,
				state: 'completed',
				evaluation: {
					verdict: 'failed',
					criterionEvaluations: CRITERIA.map((criterion) => ({
						criterionId: criterion.id,
						passed: false,
						actualValue: secretish,
						reason: 'x',
					})),
					overallScore: 0,
					summary: 'x',
				},
			};

			const observation = adaptExperimentRun({ session, experiment: failed })!;

			assert.doesNotMatch(JSON.stringify(observation), /sk-nao-leva/);
			// What survives is the shape of the finding, not the content that
			// produced it: which criteria were checked, and that they failed.
			assert.deepStrictEqual([...observation.verifiedFailures], [
				'criterio-presente',
				'criterio-classe',
			]);
		});
	});
});
