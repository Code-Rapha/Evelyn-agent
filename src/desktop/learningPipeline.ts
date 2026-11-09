/**
 * The learning pipeline: from what actually happened to a reviewable proposal.
 *
 * ## Why this file exists
 *
 * Etapa 13 built the evolution machinery — detectors, proposals, validation,
 * approval, activation, rollback — and left one thing unwired. The detectors take
 * `EvolvedRunSummary`, and nothing in the running app produced one: the
 * experimentation layer writes `Experiment` and `DetailedEvaluation`, the
 * orchestration log writes `OrchestrationLogEntry`, and between them and a
 * summary sat a gap. This file is the gap, closed.
 *
 * It lives in `desktop/` rather than `core/` on purpose, and not by accident of
 * layering: `skillEvolution.ts` lives in the Core, and the Core may not import
 * from here. The adapter is also the only place that knows about both logs, so
 * putting it anywhere else would mean either a Core import of the host (forbidden
 * and tested) or duplicating the reading of one of them.
 *
 * ## The rule that shapes everything here
 *
 * **A run without evidence is not a failure.** This is the single most important
 * thing the file does, and it is why `adaptExperimentRun` returns a summary the
 * detectors can *ignore* rather than one they can count.
 *
 * `evaluateExperiment` marks a criterion failed when there is no evidence for
 * it, because a criterion that was never checked genuinely did not pass. That is
 * correct for a verdict and wrong for learning: counted as a failure, an
 * unverified criterion becomes evidence that a skill is broken, and three
 * unverified runs would be enough to propose rewriting a skill that nobody ever
 * tested. So a run whose criteria could not be verified comes out
 * `inconclusive`, is excluded from the failure and success detectors, and says
 * why in `insufficientReason`.
 *
 * ## What it does not do
 *
 * It does not call a model. It does not change a skill. It does not decide
 * whether a proposal is good — it builds the draft and hands it to
 * `createProposal`, which validates before it stores. And it records what it did
 * not know as often as what it did, because a summary that silently fills in a
 * gap is worse than one that admits it.
 */
import type { Experiment, ExperimentSession } from './experiment';
import type { DetailedEvaluation } from './evaluation';
import type { OrchestrationLogEntry } from './orchestrationLog';
import type { TaskClassification } from './taskDiscovery';
import type { ExperimentLog } from './experimentLog';
import type { EvaluationLog } from './evaluationLog';
import {
	identifyImprovementOpportunities,
	type EvolvedRunSummary,
	type ImprovementCriterion,
	type ImprovementOpportunity,
	type OpportunityKind,
	type ProposedSkillContent,
} from '../core/skill/skillEvolution';

/** How a measurement in a run summary came to be. Never a fourth option. */
export type MeasurementKind =
	/** Written down by a real run: a clock, a counter, a verdict from evidence. */
	| 'measured'
	/** Derived from measurements by arithmetic. Named so nobody reads it as a fact. */
	| 'derived'
	/** Not known. Explicitly absent rather than zero. */
	| 'unknown';

/**
 * One measured quantity, with its provenance attached.
 *
 * `note` is required rather than optional. A measurement that does not say where
 * it came from is indistinguishable from a number somebody made up, which is the
 * specific confusion this type exists to prevent — so the "I don't know, because
 * …" case is spelled out rather than left as a bare `undefined`.
 */
export interface Measurement {
	readonly kind: MeasurementKind;
	readonly value: number | undefined;
	/** Where it came from, in one line. Always present. */
	readonly note: string;
}

/** Builds a measured value. */
function measured(value: number, note: string): Measurement {
	return { kind: 'measured', value, note };
}

/** Builds a derived value, saying what it was derived from. */
function derived(value: number, note: string): Measurement {
	return { kind: 'derived', value, note };
}

/**
 * The absence of a measurement.
 *
 * A named constant rather than a literal `undefined` at each site, so the reason
 * a number is missing travels with it into the log instead of being lost.
 */
function unknownMeasurement(reason: string): Measurement {
	return { kind: 'unknown', value: undefined, note: reason };
}

/**
 * One run, as the learning pipeline sees it.
 *
 * Extends `EvolvedRunSummary` with the provenance the detectors do not need but a
 * human reading a proposal does: where the verdict came from, what was actually
 * measured, and which criteria were checked at all.
 */
export interface RunObservation extends EvolvedRunSummary {
	/**
	 * The criteria that were genuinely checked and genuinely failed.
	 *
	 * Required rather than optional: both adapters always fill it, and an
	 * observation whose failure list might be absent is one a consumer would
	 * have to guard against before counting it.
	 */
	readonly failedCriteria: readonly string[];
	/** Which skill was in play, when the run recorded one. */
	readonly skillId: string;
	/** Why this run was inconclusive, when it was. */
	readonly insufficientReason?: string;
	/** Criteria that were genuinely checked and genuinely failed. */
	readonly verifiedFailures: readonly string[];
	/** Criteria that were never checked, so never failed. */
	readonly unverifiableCriteria: readonly string[];
	/** How many criteria were actually verified against evidence. */
	readonly verifiedCriteria: number;
	/** Total criteria the experiment declared. */
	readonly totalCriteria: number;
	/** Wall-clock duration, when a run recorded one. */
	readonly durationMs?: Measurement;
	/** Tokens consumed, when a run recorded a count. */
	readonly tokensUsed?: Measurement;
	/** Model calls made. */
	readonly modelCalls?: Measurement;
	/** The model that answered, as `providerId:modelId`. */
	readonly modelId?: string;
	/** Provider that served the model. */
	readonly providerId?: string;
	/** Confidence the evaluation layer reported, 0..1. */
	readonly verdictConfidence?: Measurement;
}

/** What went into adapting one experiment. */
export interface ExperimentRunSource {
	readonly session: ExperimentSession;
	readonly experiment: Experiment;
	/** The detailed evaluation, when one was recorded for this experiment. */
	readonly evaluation?: DetailedEvaluation;
	/**
	 * Skill ids in play for this run.
	 *
	 * Supplied by the caller because the experiment log does not record them: a
	 * turn knows which skills it loaded, and that link is made where the fact
	 * exists rather than inferred here.
	 */
	readonly skillIds?: readonly string[];
	/** The orchestration entry for the same turn, when there is one. */
	readonly orchestration?: OrchestrationLogEntry;
}

/** What came out of reading the history. */
export interface HistoryReadResult {
	readonly runs: readonly RunObservation[];
	/** Runs that were read but cannot be counted as evidence. */
	readonly skipped: readonly { readonly refId: string; readonly reason: string }[];
	/** Histories that could not be read. Reported rather than swallowed. */
	readonly errors: readonly string[];
}

/** The minimum a run needs before it may be counted as evidence. */
export const MIN_VERIFIED_CRITERIA = 1;

/**
 * Whether a run may be counted as evidence at all.
 *
 * A run with no verified criterion is not a failure and not a success — it is a
 * run nobody checked. The reason is returned so the caller can log it rather
 * than drop the run silently, which is what makes "why did nothing happen?"
 * answerable after the fact.
 */
function insufficientReason(observation: {
	readonly verifiedCriteria: number;
	readonly totalCriteria: number;
	readonly hasConflictingEvidence: boolean;
}): string | undefined {
	if (observation.totalCriteria === 0) {
		return 'a execução não definiu critérios de sucesso, então não há nada a verificar';
	}
	if (observation.verifiedCriteria < MIN_VERIFIED_CRITERIA) {
		return (
			`nenhum critério foi verificado contra evidência ` +
			`(0 de ${observation.totalCriteria}); a execução não prova sucesso nem fracasso`
		);
	}
	if (observation.hasConflictingEvidence) {
		return 'as evidências se contradizem, então nem o acerto nem o erro estão estabelecidos';
	}
	return undefined;
}

/** Splits `providerId:modelId`. Returns `undefined` when the string does not have both halves. */
function splitModel(model: string | undefined): { providerId?: string; modelId?: string } {
	if (model === undefined) {
		return {};
	}
	const index = model.indexOf(':');
	if (index <= 0 || index === model.length - 1) {
		return {};
	}
	return { providerId: model.slice(0, index), modelId: model.slice(index + 1) };
}

/** The duration a run recorded, or the honest absence of one. */
function durationOf(experiment: Experiment, orchestration: OrchestrationLogEntry | undefined): Measurement {
	if (experiment.consumption.durationMs > 0) {
		return measured(
			experiment.consumption.durationMs,
			'duração registrada pelo controle de orçamento da execução',
		);
	}
	if (orchestration !== undefined) {
		// The orchestration entry has a timestamp but no elapsed time, and the gap
		// between it and the next turn is not this turn's duration. Saying so is
		// the whole point: an interval between two unrelated events is not a
		// measurement of this one.
		return unknownMeasurement(
			`o registro de orquestração tem apenas um carimbo de tempo (${orchestration.timestamp}), sem duração`,
		);
	}
	return unknownMeasurement('a execução não registrou duração');
}

/** The tokens a run recorded, or the honest absence of a count. */
function tokensOf(experiment: Experiment): Measurement {
	const { tokensUsed } = experiment.consumption;
	if (tokensUsed === 'unknown') {
		return unknownMeasurement('o provedor não reportou contagem de tokens');
	}
	if (tokensUsed === 0) {
		return unknownMeasurement('zero tokens registrados indica ausência de medição, não consumo nulo');
	}
	return measured(tokensUsed, 'tokens contabilizados pelo controle de orçamento');
}

/**
 * Turns one experiment into a run observation.
 *
 * `undefined` when the experiment is too incomplete to say anything — which is
 * the *expected* answer for an experiment that was defined and never run, and
 * not an error.
 */
export function adaptExperimentRun(source: ExperimentRunSource): RunObservation | undefined {
	const { experiment, session, evaluation } = source;

	// Nothing was executed. An experiment in `defined` has no verdict to learn
	// from, and counting it as a failure would invent evidence.
	if (experiment.state === 'defined' || experiment.state === 'authorizing') {
		return undefined;
	}

	const totalCriteria = experiment.criteria.length;
	const base = experiment.evaluation ?? evaluation?.baseEvaluation;

	/**
	 * Which criteria were actually checked against something.
	 *
	 * Two ways a check can be evidenced, and neither of them is "the criterion
	 * exists":
	 *
	 * - the detailed evaluation linked evidence to that criterion, or
	 * - there is no detailed evaluation, but the experiment recorded both
	 *   evidence and a criterion evaluation carrying a concrete value — which is
	 *   the evaluation layer's own record that a check ran.
	 *
	 * The second case is deliberately narrower than "there is an evaluation". An
	 * experiment can carry a verdict with nothing behind it, because
	 * `evaluateExperiment` marks a criterion failed when no evidence covers it —
	 * correct for a verdict, and exactly the thing that must not become evidence
	 * that a skill is broken.
	 */
	const linkedCriteria = new Set(evaluation?.evidenceLinks.map((link) => link.criterionId) ?? []);
	const experimentRecordedACheck = evaluation === undefined && experiment.evidence.length > 0;
	const verifiedCriterionIds = new Set<string>();
	if (base !== undefined) {
		for (const criterion of base.criterionEvaluations) {
			const linked = evaluation !== undefined && linkedCriteria.has(criterion.criterionId);
			const recorded = experimentRecordedACheck && criterion.actualValue !== undefined;
			if (linked || recorded) {
				verifiedCriterionIds.add(criterion.criterionId);
			}
		}
	}

	const unverifiable = evaluation?.unverifiableCriteria ?? [];
	const verifiedFailures =
		base === undefined
			? []
			: base.criterionEvaluations
					.filter((criterion) => !criterion.passed && verifiedCriterionIds.has(criterion.criterionId))
					.map((criterion) => criterion.criterionId);

	const verdict = base?.verdict ?? experiment.evaluation?.verdict ?? 'inconclusive';
	const conflicts = evaluation?.hasConflictingEvidence ?? false;

	const verdictConfidence: Measurement =
		evaluation === undefined
			? unknownMeasurement('sem avaliação detalhada, não há confiança a relatar')
			: measured(
					evaluation.verdictConfidence,
					`confiança reportada pela camada de avaliação (${evaluation.confidenceRationale})`,
				);

	const model = experiment.models[0];
	const { providerId, modelId } = splitModel(model);
	const skillIds = source.skillIds ?? [];

	const summary: RunObservation = {
		// `verdict` here is the *summary's* verdict, not the experiment's: the
		// two differ exactly when evidence was missing, and the detectors must see
		// the corrected one.
		verdict,
		source: 'experiment',
		refId: experiment.id,
		domain: session.task.domain,
		...([...new Set(skillIds)].length > 0 ? { skillId: [...new Set(skillIds)].sort()[0]! } : { skillId: '' }),
		failedCriteria: verifiedFailures,
		wastedSteps: 0,
		retries: experiment.consumption.attemptsMade > 0 ? experiment.consumption.attemptsMade - 1 : 0,
		...(experiment.approach.length > 0 ? { procedureSignature: experiment.approach } : {}),
		at: experiment.completedAt ?? experiment.startedAt ?? experiment.createdAt,

		verifiedFailures,
		unverifiableCriteria: unverifiable,
		verifiedCriteria: verifiedCriterionIds.size,
		totalCriteria,

		durationMs: durationOf(experiment, source.orchestration),
		tokensUsed: tokensOf(experiment),
		modelCalls:
			experiment.consumption.modelCalls > 0
				? measured(experiment.consumption.modelCalls, 'chamadas de modelo contabilizadas')
				: unknownMeasurement('nenhuma chamada de modelo registrada'),
		verdictConfidence,
		...(providerId !== undefined ? { providerId } : {}),
		...(modelId !== undefined ? { modelId } : {}),
	};

	const reason = insufficientReason({
		verifiedCriteria: verifiedCriterionIds.size,
		totalCriteria,
		hasConflictingEvidence: conflicts,
	});

	if (reason !== undefined) {
		return { ...summary, verdict: 'inconclusive', insufficientReason: reason };
	}
	return summary;
}

/**
 * Turns an orchestration entry into a run observation.
 *
 * Weaker evidence than an experiment, and marked as such: an orchestration entry
 * says a turn *ran*, not that its answer was right. It carries no criteria, so it
 * verifies none, and therefore cannot be counted as evidence of success or of
 * failure — only of the fact that a turn happened, which is what the
 * `reusable-procedure` and `repeated-success` detectors should never see it as.
 *
 * It is still worth adapting: `runsConsidered` and the skipped list are how a
 * user learns that their history has turns nobody evaluated.
 */
export function adaptOrchestrationRun(entry: OrchestrationLogEntry): RunObservation {
	const { providerId, modelId } = splitModel(entry.finalModel ?? entry.primaryModel);

	return {
		// Never 'passed'. A turn that streamed without error is not a task that was
		// verified correct, and the difference is the whole reason this mapping is
		// conservative.
		verdict: 'inconclusive',
		source: 'conversation',
		refId: entry.id,
		domain: entry.task.domain,
		skillId: '',
		failedCriteria: [],
		wastedSteps: 0,
		retries: entry.attempts.length > 1 ? entry.attempts.length - 1 : 0,
		...(entry.strategy.length > 0 ? { procedureSignature: `orchestration:${entry.strategy}` } : {}),
		at: entry.timestamp,

		insufficientReason:
			'um registro de orquestração confirma que a execução aconteceu, mas não verifica nenhum critério de sucesso',
		verifiedFailures: [],
		unverifiableCriteria: entry.result === 'success' ? ['nenhum critério foi definido para esta execução'] : [],
		verifiedCriteria: 0,
		totalCriteria: 0,

		durationMs: unknownMeasurement(
			`o registro de orquestração tem apenas um carimbo de tempo (${entry.timestamp}), sem duração`,
		),
		tokensUsed: unknownMeasurement('a orquestração não registra consumo de tokens'),
		modelCalls: entry.attempts.length > 0
			? measured(entry.attempts.length, 'tentativas registradas pelo orquestrador')
			: unknownMeasurement('nenhuma tentativa registrada'),
		verdictConfidence: unknownMeasurement('sem avaliação, não há confiança a relatar'),
		...(providerId !== undefined ? { providerId } : {}),
		...(modelId !== undefined ? { modelId } : {}),
	};
}

/** The logs a scan reads. Narrowed to what the pipeline uses. */
export interface LearningHistorySource {
	readonly experimentLog?: Pick<ExperimentLog, 'listSessions' | 'listExperiments'>;
	readonly evaluationLog?: Pick<EvaluationLog, 'getLatestEvaluation'>;
	readonly orchestrationLog?: {
		list: (filter?: { readonly limit?: number }) => Promise<readonly OrchestrationLogEntry[]>;
	};
}

/** Options for one scan. */
export interface ScanOptions {
	/** Most orchestration entries to read. Defaults to 200. */
	readonly orchestrationLimit?: number;
	/** Skill ids per conversation, when the caller recorded them. */
	readonly skillsByConversation?: ReadonlyMap<string, readonly string[]>;
	/** Most opportunities to return. */
	readonly maxOpportunities?: number;
}

const DEFAULT_ORCHESTRATION_LIMIT = 200;

/**
 * Reads every history the app keeps and adapts it.
 *
 * A history that cannot be read is reported in `errors` rather than throwing:
 * one unreadable log must not take the scan down, and the user needs to be told
 * which part of their evidence base was skipped rather than left to wonder why
 * the analysis came back thin.
 */
export async function readLearningHistory(
	source: LearningHistorySource,
	options: ScanOptions = {},
): Promise<HistoryReadResult> {
	const runs: RunObservation[] = [];
	const skipped: { refId: string; reason: string }[] = [];
	const errors: string[] = [];

	if (source.experimentLog !== undefined) {
		try {
			const sessions = await source.experimentLog.listSessions();
			for (const session of sessions) {
				let experiments: readonly Experiment[];
				try {
					experiments = await source.experimentLog.listExperiments(session.id);
				} catch (error) {
					errors.push(
						`sessão ${session.id}: ${error instanceof Error ? error.message : String(error)}`,
					);
					continue;
				}

				for (const experiment of experiments) {
					let detailed: DetailedEvaluation | undefined;
					if (source.evaluationLog !== undefined) {
						try {
							detailed = await source.evaluationLog.getLatestEvaluation(experiment.id);
						} catch (error) {
							// A missing evaluation is normal — most experiments are not
							// evaluated — so this is counted as a skip, not an error.
							skipped.push({
								refId: experiment.id,
								reason: `avaliação não pôde ser lida: ${error instanceof Error ? error.message : String(error)}`,
							});
						}
					}

					const observation = adaptExperimentRun({
						session,
						experiment,
						...(detailed !== undefined ? { evaluation: detailed } : {}),
						...(options.skillsByConversation !== undefined
							? {
									skillIds: skillsForConversation(options.skillsByConversation, experiment),
								}
							: {}),
					});

					if (observation === undefined) {
						skipped.push({
							refId: experiment.id,
							reason: `experimento no estado "${experiment.state}" nunca foi executado`,
						});
						continue;
					}
					runs.push(observation);
				}
			}
		} catch (error) {
			errors.push(`log de experimentos: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	if (source.orchestrationLog !== undefined) {
		try {
			const entries = await source.orchestrationLog.list({
				limit: options.orchestrationLimit ?? DEFAULT_ORCHESTRATION_LIMIT,
			});
			for (const entry of entries) {
				const observation = adaptOrchestrationRun(entry);
				const skills = options.skillsByConversation?.get(entry.conversationId);
				runs.push(
					skills !== undefined && skills.length > 0
						? { ...observation, skillId: [...new Set(skills)].sort()[0]! }
						: observation,
				);
			}
		} catch (error) {
			errors.push(`log de orquestração: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	return { runs, skipped, errors };
}

/** The skills a conversation ran with, keyed however the caller recorded them. */
function skillsForConversation(
	map: ReadonlyMap<string, readonly string[]>,
	experiment: Experiment,
): readonly string[] {
	// Experiments carry no conversation id. The session goal is the only handle,
	// and a session that ran several conversations is better reported as unknown
	// than attributed to whichever conversation happened to come first.
	const bySession = map.get(experiment.sessionId);
	if (bySession !== undefined) {
		return bySession;
	}
	return map.get(experiment.objective) ?? [];
}

// ── model observations ───────────────────────────────────────────────────────

/** What was observed about one model across the runs that used it. */
export interface ModelObservation {
	readonly providerId: string;
	readonly modelId: string;
	/** `providerId:modelId`, for display. */
	readonly key: string;
	readonly runs: number;
	/** Runs whose criteria were verified and passed. */
	readonly verifiedPasses: number;
	/** Runs whose criteria were verified and failed. */
	readonly verifiedFailures: number;
	/** Runs that verified nothing. Counted, never scored. */
	readonly unverifiedRuns: number;
	/**
	 * Median duration across the runs that were measured.
	 *
	 * Always present, and `unknown` when nothing was measured — never omitted and
	 * never `0`, so "we did not time it" cannot be read as "it was instant".
	 */
	readonly medianDurationMs: Measurement;
	/** Token consumption, `unknown` when no run reported a count. */
	readonly tokensUsed: Measurement;
	/** Whether any measurement at all was recorded. */
	readonly hasMeasurements: boolean;
	/** What this record does and does not support saying. */
	readonly canCompare: boolean;
	readonly caveat: string;
}

/**
 * Summarises what was observed about each model.
 *
 * ## Why this refuses to name a winner
 *
 * Two models can look different in the log for three very different reasons:
 * one was faster, one produced a more convincing-sounding answer, and one was
 * actually verified more often against success criteria. Only the third is
 * evidence of quality.
 *
 * So `canCompare` is false unless at least two models have *verified* runs, and
 * even then the caveat says what is missing. Nothing here ranks, and there is no
 * score to rank by: a run with no verified criteria contributes to
 * `unverifiedRuns` and to nothing else, because counting "it answered" as "it was
 * right" is the exact error this function exists to avoid.
 */
export function summarizeModelObservations(
	runs: readonly RunObservation[],
): readonly ModelObservation[] {
	/**
	 * The accumulator. Separate from `ModelObservation` because the summary's
	 * median and token figure are computed once at the end, from every run for
	 * that model — not accumulated one run at a time.
	 */
	interface Accumulator {
		readonly providerId: string;
		readonly modelId: string;
		readonly key: string;
		runs: number;
		verifiedPasses: number;
		verifiedFailures: number;
		unverifiedRuns: number;
		readonly durations: number[];
		hasMeasurements: boolean;
	}

	const byModel = new Map<string, Accumulator>();

	for (const run of runs) {
		const { providerId, modelId } = run;
		if (providerId === undefined || modelId === undefined) {
			continue;
		}
		const key = `${providerId}:${modelId}`;
		const existing: Accumulator = byModel.get(key) ?? {
			providerId,
			modelId,
			key,
			runs: 0,
			verifiedPasses: 0,
			verifiedFailures: 0,
			unverifiedRuns: 0,
			durations: [],
			hasMeasurements: false,
		};

		// A run counts as verified only when at least one criterion was actually
		// checked *and* nothing disqualified it. `insufficientReason` is the
		// adapter's own verdict on whether the evidence stood up.
		const verified = run.verifiedCriteria > 0 && run.insufficientReason === undefined;
		if (verified && run.durationMs?.kind === 'measured' && run.durationMs.value !== undefined) {
			existing.durations.push(run.durationMs.value);
		}

		existing.runs += 1;
		existing.verifiedPasses += verified && run.verdict === 'passed' ? 1 : 0;
		existing.verifiedFailures += verified && run.verdict === 'failed' ? 1 : 0;
		existing.unverifiedRuns += verified ? 0 : 1;
		existing.hasMeasurements = existing.hasMeasurements || existing.durations.length > 0;
		byModel.set(key, existing);
	}

	const summaries: ModelObservation[] = [...byModel.values()].map((accumulator) => ({
		providerId: accumulator.providerId,
		modelId: accumulator.modelId,
		key: accumulator.key,
		runs: accumulator.runs,
		verifiedPasses: accumulator.verifiedPasses,
		verifiedFailures: accumulator.verifiedFailures,
		unverifiedRuns: accumulator.unverifiedRuns,
		hasMeasurements: accumulator.hasMeasurements,
		medianDurationMs:
			accumulator.durations.length > 0
				? median(accumulator.durations)
				: unknownMeasurement('nenhuma execução verificada registrou duração'),
		tokensUsed: latestKnownTokens(runs, accumulator.key),
		canCompare: false,
		caveat: '',
	}));

	// A comparison needs verified runs on at least two sides. One model with ten
	// verified runs is a record, not a comparison.
	const withVerified = summaries.filter(
		(summary) => summary.verifiedPasses + summary.verifiedFailures > 0,
	);
	const comparable = withVerified.length >= 2;

	return summaries.map((summary) => {
		const verified = summary.verifiedPasses + summary.verifiedFailures;
		if (!comparable) {
			return {
				...summary,
				canCompare: false,
				caveat:
					verified === 0
						? 'nenhuma execução deste modelo foi verificada contra critérios, então nada aqui diz sobre a qualidade dele'
						: 'só um modelo tem execuções verificadas; com uma única amostra não há comparação possível',
			};
		}
		if (verified < 2) {
			return {
				...summary,
				canCompare: false,
				caveat:
					`${verified} execução(ões) verificada(s) é amostra insuficiente para comparar; ` +
					`${summary.unverifiedRuns} outra(s) não verificaram critério nenhum`,
			};
		}
		return {
			...summary,
			canCompare: true,
			caveat:
				'a comparação cobre apenas as execuções cujos critérios foram verificados; ' +
				'velocidade não é qualidade e nenhuma execução aqui prova que um modelo serve melhor a um domínio',
		};
	});
}

/** The median, or the mean of the middle two. */
function median(values: readonly number[]): Measurement {
	if (values.length === 0) {
		return unknownMeasurement('sem valores medidos');
	}
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	const value =
		sorted.length % 2 === 0
			? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
			: (sorted[middle] ?? 0);
	return derived(value, `mediana de ${sorted.length} medições`);
}

/**
 * The most recent token count this model reported.
 *
 * Deliberately not a sum: tokens across runs of different sizes describe no
 * single execution, and a total would read like a per-run cost. When no run
 * reported a count, the absence is reported with the reason from the most recent
 * attempt rather than as a zero.
 */
function latestKnownTokens(runs: readonly RunObservation[], key: string): Measurement {
	const forModel = runs.filter((run) => `${run.providerId ?? ''}:${run.modelId ?? ''}` === key);
	const known = [...forModel]
		.reverse()
		.find((run) => run.tokensUsed?.kind === 'measured' && run.tokensUsed.value !== undefined);
	if (known?.tokensUsed?.value !== undefined) {
		return measured(
			known.tokensUsed.value,
			`contagem relatada pela execução ${known.refId}; execuções não são somadas porque cada uma tem um tamanho diferente`,
		);
	}
	const last = forModel[forModel.length - 1];
	return unknownMeasurement(
		last?.tokensUsed?.note ?? 'nenhuma execução deste modelo reportou contagem de tokens',
	);
}

/** How a scan ended up. Carries the provenance the detectors cannot. */
export interface ScanResult {
	readonly ok: boolean;
	readonly runsRead: number;
	/** Runs that can be counted as evidence. */
	readonly usableRuns: number;
	/** Runs that were read but cannot be counted. */
	readonly unverifiedRuns: number;
	readonly skipped: readonly { readonly refId: string; readonly reason: string }[];
	readonly errors: readonly string[];
	/**
	 * The opportunities the detectors found, in strength order.
	 *
	 * Whole, rather than a hand-picked subset: `createProposal` needs every field
	 * the detector produced, and re-declaring a narrower shape here would mean
	 * rebuilding it field by field at the call site — exactly where a field could
	 * be quietly dropped and a proposal would end up with weaker evidence than
	 * the scan reported.
	 */
	readonly opportunities: readonly ImprovementOpportunity[];
	/** What each model was observed doing. Never a ranking. */
	readonly modelObservations: readonly ModelObservation[];
	/** One line saying what the scan did and did not find. */
	readonly summary: string;
	readonly error?: string;
}

/**
 * Reads the history, runs the detectors, and returns what it found.
 *
 * Pure with respect to storage: it reads and computes, and the caller decides
 * whether to turn any of it into a proposal. That separation is what keeps
 * "analisar" from ever meaning "alterar".
 */
export async function scanForSkillImprovements(
	source: LearningHistorySource,
	options: ScanOptions & {
		/** Fingerprints already filed, so a scan does not re-raise a question asked. */
		readonly knownFingerprints?: readonly string[];
		/** Skills that exist, so ambiguity can be judged against real instructions. */
		readonly existingSkills?: readonly { readonly id: string; readonly instructions: string }[];
		/** Injected so the detectors can be exercised without touching disk. */
		readonly identify?: typeof identifyImprovementOpportunities;
	} = {},
): Promise<ScanResult> {
	try {
		const history = await readLearningHistory(source, options);
		const { runs, skipped, errors } = history;

		// The correction the whole file exists for: an unverified run is kept in
		// the record and removed from the evidence.
		const usable = runs.filter(
			(run) => run.insufficientReason === undefined && run.verifiedCriteria > 0,
		);

		// The default is the real detector; the injection point exists so a test
		// can prove the *pipeline's* filtering without re-asserting the detectors'
		// own behaviour, which `skillEvolution.test.ts` already covers.
		const identify = options.identify ?? identifyImprovementOpportunities;

		const scan = identify({
			runs: usable,
			...(options.knownFingerprints !== undefined
				? { knownFingerprints: options.knownFingerprints }
				: {}),
			...(options.existingSkills !== undefined ? { existingSkills: options.existingSkills } : {}),
			...(options.maxOpportunities !== undefined ? { maxOpportunities: options.maxOpportunities } : {}),
		});

		if (!scan.ok) {
			return {
				ok: false,
				runsRead: runs.length,
				usableRuns: usable.length,
				unverifiedRuns: runs.length - usable.length,
				skipped,
				errors: [...errors, ...(scan.error !== undefined ? [scan.error] : [])],
				opportunities: [],
				modelObservations: [],
				summary: `a análise do histórico falhou: ${scan.error ?? 'motivo desconhecido'}`,
			};
		}

		return {
			ok: true,
			runsRead: runs.length,
			usableRuns: usable.length,
			unverifiedRuns: runs.length - usable.length,
			skipped,
			errors,
			opportunities: scan.opportunities,
			modelObservations: summarizeModelObservations(runs),
			summary: describeScan(runs.length, usable.length, scan.opportunities.length, errors.length),
		};
	} catch (error) {
		return {
			ok: false,
			runsRead: 0,
			usableRuns: 0,
			unverifiedRuns: 0,
			skipped: [],
			errors: [],
			opportunities: [],
			modelObservations: [],
			summary: 'a análise do histórico falhou',
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/** One line the UI can show verbatim. Says what was skipped, not just what was found. */
function describeScan(total: number, usable: number, opportunities: number, errors: number): string {
	if (total === 0) {
		return 'Nenhuma execução registrada ainda. Não há histórico para analisar.';
	}
	const parts = [
		`${usable} de ${total} execuções verificadas contra critérios`,
		`${opportunities} oportunidade(s)`,
	];
	if (total > usable) {
		parts.push(`${total - usable} sem evidência suficiente, portanto não contadas como acerto nem como erro`);
	}
	if (errors > 0) {
		parts.push(`${errors} histórico(s) não puderam ser lidos`);
	}
	return `${parts.join('; ')}.`;
}

// ── from an opportunity to a reviewable proposal ─────────────────────────────

/**
 * Builds the proposed content for an opportunity.
 *
 * Deliberately *not* generated text. This stage does not call a model, and a
 * proposal whose instructions were invented here would arrive at the review queue
 * already looking like work — which is how an unreviewed change gets approved.
 * What this produces is a skeleton with the evidence and the open questions in
 * it, so the human is filling in a structure rather than judging a finished
 * essay.
 *
 * The caller supplies the instructions when it has real ones (a later stage, with
 * the user in the loop); without them this refuses rather than inventing.
 */
export function buildProposalDraft(
	opportunity: Pick<
		ImprovementOpportunity,
		'kind' | 'problem' | 'title' | 'domains'
	>,
	proposed: ProposedSkillContent,
): {
	readonly proposed: ProposedSkillContent;
	readonly expectedBenefits: readonly string[];
	readonly risks: readonly string[];
	readonly validationCriteria: readonly ImprovementCriterion[];
} {
	const expectedBenefits = [
		`Reduzir as falhas do critério observado em ${opportunity.domains.join(', ') || 'domínio não especificado'}`,
		'Tornar o procedimento reutilizável em vez de reconstruído a cada tarefa',
	];
	const risks = [
		`A evidência cobre ${opportunity.domains.length} domínio(s); a mudança pode não valer fora deles`,
		'Instruções mais longas aumentam o contexto de cada turno em que a skill for carregada',
		'O que é ganho aqui pode ser perdido em outro tipo de tarefa, e isso não foi medido',
	];
	const validationCriteria: ImprovementCriterion[] = [
		{
			id: 'vc-evidence',
			description: 'A skill deixa de falhar no critério que motivou a proposta',
			observableAs: `execuções no domínio ${opportunity.domains[0] ?? 'desconhecido'} passam a verificar esse critério como atendido`,
		},
		{
			id: 'vc-no-regression',
			description: 'A skill continua atendendo o que já atendia',
			observableAs: 'nenhuma execução que antes passava passa a falhar depois da ativação',
		},
	];
	return { proposed, expectedBenefits, risks, validationCriteria };
}

/** The task classification an experiment ran under, when one is available. */
export type { TaskClassification };
