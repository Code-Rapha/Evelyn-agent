/**
 * Comparação entre duas execuções.
 *
 * ## Três respostas, não duas
 *
 * - **aceita** — as condições são as mesmas: é um experimento controlado, e
 *   a diferença entre as duas execuções pode ser lida como diferença de
 *   resultado;
 * - **limitada** — há o que comparar, mas as condições **não** são as mesmas.
 *   A comparação é feita, e o relatório diz exatamente o que difere e qual
 *   métrica deixa de ser comparável por causa disso. Duas execuções sob
 *   políticas diferentes não são um experimento: elas responderam a perguntas
 *   diferentes;
 * - **recusada** — não há o que comparar: uma das execuções não existe mais,
 *   ou nenhuma das duas produziu tentativa alguma.
 *
 * ## O que nunca é feito
 *
 * Nenhuma verificação de compatibilidade é removida para caber mais
 * comparações. O que muda é a **forma** da resposta: uma incompatibilidade
 * vira uma limitação declarada, com a métrica que ela afeta — não um número
 * posto lado a lado como se as execuções fossem equivalentes.
 *
 * ## Métrica a métrica
 *
 * Cada métrica diz se é comparável e por que não é, e traz o valor de cada
 * lado **com a sua natureza**: medida, publicada, estimada, desconhecida ou
 * indisponível. Um zero onde não houve medição é uma mentira sobre as duas
 * execuções ao mesmo tempo.
 */
import type { RoutingDecisionReport } from './decisionReport';
import type { TaskClassificationExplanation } from './taskDiscovery';

/** Uma execução, como o histórico a guarda. */
export interface HistoryExecution {
	readonly executionId: string;
	readonly timestamp: string;
	readonly conversationId: string;
	readonly report: RoutingDecisionReport;
}

/**
 * O resultado antigo, mantido como nome para quem só quer o veredito.
 *
 * A comparação agora é `accepted` / `limited` / `refused`, e não mais
 * "comparable" ou não: quase sempre há algo a comparar, e o que muda são as
 * condições. `isComparable` diz se a comparação pode ser lida como um
 * experimento controlado.
 */
export type ReportComparison = ComparisonOutcome;
export type ComparisonRefusal = Extract<ComparisonOutcome, { status: 'refused' }>;

/** A natureza de um valor. Nunca implícita. */
export type ValueKind =
	| 'measured'
	| 'published'
	| 'estimated'
	| 'declared'
	| 'unknown'
	| 'unavailable';

/** Um valor, com a sua natureza. */
export interface ClassifiedValue {
	readonly text: string;
	readonly kind: ValueKind;
}

/** Uma métrica, e se ela pode ser comparada. */
export interface ComparisonMetric {
	readonly id: 'model' | 'score' | 'result' | 'latency' | 'tokens' | 'cost';
	readonly label: string;
	/** As duas execuçõesmlung as condições para esta métrica. */
	readonly comparable: boolean;
	/** Por que a métrica não é comparável, quando não é. */
	readonly limit?: string;
	readonly a?: ClassifiedValue;
	readonly b?: ClassifiedValue;
	/** A diferença observada, quando ambas têm valor. */
	readonly difference?: string;
}

/** O lado de uma execução, na comparação. */
export interface ComparisonSide {
	readonly executionId: string;
	readonly timestamp: string;
	readonly model?: { readonly providerId: string; readonly modelId: string };
	readonly score?: number;
	readonly result: string;
	readonly policy: string;
	readonly sources: { readonly price: string; readonly limits: string; readonly capabilities: string };
	/** A classificação da tarefa, pelas suas características estruturais. */
	readonly task?: {
		readonly domain: string;
		readonly complexity: string;
		readonly capabilities: readonly string[];
		readonly needsTools: boolean;
		readonly confidence: number;
	};
	readonly components: readonly {
		readonly id: string;
		readonly label: string;
		readonly points: number;
	}[];
	readonly constraints: readonly { readonly id: string; readonly label: string }[];
	readonly confidence: readonly { readonly id: string; readonly label: string }[];
	/** A latência medida, em milissegundos. Ausente = não medida. */
	readonly latencyMs?: number;
	/** Os tokens publicados pelo provedor. Ausente = não publicados. */
	readonly tokens?: number;
	/** O custo, como o ledger o mediu. Ausente = não registrado. */
	readonly costText?: string;
}

/** O que difere entre as duas execuções, e o que isso afeta. */
export interface ComparisonContextDifference {
	readonly what: string;
	readonly a: string;
	readonly b: string;
	/** As métricas que esta diferença afeta. */
	readonly affects: readonly ComparisonMetric['id'][];
}

/** O resultado da comparação. */
export type ComparisonOutcome =
	| {
			readonly status: 'accepted';
			/** Por que a comparação foi aceita. */
			readonly reason: string;
			readonly a: ComparisonSide;
			readonly b: ComparisonSide;
			readonly metrics: readonly ComparisonMetric[];
			readonly differences: readonly string[];
			/** As condições que não são as mesmas, quando há alguma. */
			readonly context: readonly ComparisonContextDifference[];
	  }
	| {
			readonly status: 'limited';
			/** Por que a comparação foi limitada. */
			readonly reason: string;
			readonly a: ComparisonSide;
			readonly b: ComparisonSide;
			readonly metrics: readonly ComparisonMetric[];
			readonly differences: readonly string[];
			readonly context: readonly ComparisonContextDifference[];
			/** O que a limitação impede de se concluir. */
			readonly limits: readonly string[];
	  }
	| {
			readonly status: 'refused';
			readonly reason: 'no_data' | 'unknown_execution';
			readonly detail: string;
	  };

/**
 * Compara duas execuções.
 *
 * A recusa é rara de propósito: quase sempre há algo a comparar, e o que
 * muda entre as execuções é a **condição**, não o dado. O relatório diz qual.
 */
export function compareExecutions(
	a: HistoryExecution | undefined,
	b: HistoryExecution | undefined,
): ComparisonOutcome {
	if (a === undefined || b === undefined) {
		return {
			status: 'refused',
			reason: 'unknown_execution',
			detail: 'uma das execuções não está no histórico',
		};
	}
	const sideA = sideOf(a);
	const sideB = sideOf(b);
	if (sideA === undefined || sideB === undefined) {
		return {
			status: 'refused',
			reason: 'no_data',
			detail: 'nenhuma das execuções produziu uma tentativa comparável',
		};
	}
	const context = contextDifferences(sideA, sideB, a.report, b.report);
	const metrics = metricsOf(sideA, sideB, context);
	const differences = differencesOf(sideA, sideB);

	// As condições são as mesmas? Então é um experimento controlado.
	if (context.length === 0) {
		return {
			status: 'accepted',
			reason:
				'as duas execuções usaram a mesma política, os mesmos provedores, as mesmas origens de metadados e a mesma classificação de tarefa',
			a: sideA,
			b: sideB,
			metrics,
			differences,
			context,
		};
	}

	// Condições diferentes: a comparação é feita, e o que ela não prova é
	// dito.
	const limits = context.map(
		(difference) =>
			`${difference.what}: ${difference.a} contra ${difference.b} — afeta ${difference.affects.join(', ')}`,
	);
	return {
		status: 'limited',
		reason:
			'as execuções rodaram sob condições diferentes, então a diferença entre elas não é atribuível ao modelo',
		a: sideA,
		b: sideB,
		metrics,
		differences,
		context,
		limits,
	};
}

/** O que difere nas condições, e o que cada diferença afeta. */
function contextDifferences(
	a: ComparisonSide,
	b: ComparisonSide,
	reportA: RoutingDecisionReport,
	reportB: RoutingDecisionReport,
): ComparisonContextDifference[] {
	const differences: ComparisonContextDifference[] = [];
	if (a.policy !== b.policy) {
		differences.push({
			what: 'política de acesso',
			a: a.policy,
			b: b.policy,
			affects: ['model', 'score'],
		});
	}
	const providersA = providersOf(reportA);
	const providersB = providersOf(reportB);
	if (providersA.size > 0 && providersB.size > 0 && !sameProviders(providersA, providersB)) {
		differences.push({
			what: 'provedor',
			a: [...providersA].join(', '),
			b: [...providersB].join(', '),
			// Latência de servidores diferentes não se compara.
			affects: ['latency'],
		});
	}
	if (
		reportA.sources.price !== reportB.sources.price ||
		reportA.sources.limits !== reportB.sources.limits ||
		reportA.sources.capabilities !== reportB.sources.capabilities
	) {
		differences.push({
			what: 'origem dos metadados',
			a: `${reportA.sources.price}/${reportA.sources.limits}/${reportA.sources.capabilities}`,
			b: `${reportB.sources.price}/${reportB.sources.limits}/${reportB.sources.capabilities}`,
			affects: ['score'],
		});
	}
	const taskA = a.task;
	const taskB = b.task;
	if (taskA !== undefined && taskB !== undefined) {
		if (taskA.domain !== taskB.domain || taskA.complexity !== taskB.complexity) {
			differences.push({
				what: 'classificação da tarefa',
				a: `${taskA.domain}/${taskA.complexity}`,
				b: `${taskB.domain}/${taskB.complexity}`,
				affects: ['score', 'model'],
			});
		}
	}
	return differences;
}

/** As métricas, uma a uma, com a sua comparabilidade. */
function metricsOf(
	a: ComparisonSide,
	b: ComparisonSide,
	context: readonly ComparisonContextDifference[],
): readonly ComparisonMetric[] {
	const limited = (id: ComparisonMetric['id']): string | undefined =>
		context.find((difference) => difference.affects.includes(id))?.what;

	const model: ComparisonMetric = {
		id: 'model',
		label: 'Modelo escolhido',
		comparable: limited('model') === undefined,
		...(limited('model') !== undefined ? { limit: `${limited('model')} diferente` } : {}),		...(a.model !== undefined
			? { a: { text: `${a.model.providerId}/${a.model.modelId}`, kind: 'published' } }
			: { a: { text: 'nenhum', kind: 'unavailable' } }),
		...(b.model !== undefined
			? { b: { text: `${b.model.providerId}/${b.model.modelId}`, kind: 'published' } }
			: { b: { text: 'nenhum', kind: 'unavailable' } }),
		...(a.model !== undefined && b.model !== undefined && a.model.modelId !== b.model.modelId
			? { difference: `modelo ${a.model.modelId} contra ${b.model.modelId}` }
			: {}),
	};

	const score: ComparisonMetric = {
		id: 'score',
		label: 'Pontuação',
		comparable: limited('score') === undefined,
		...(limited('score') !== undefined ? { limit: `${limited('score')} diferente` } : {}),
		...(a.score !== undefined
			? { a: { text: String(a.score), kind: 'measured' } }
			: { a: { text: 'não pontuada', kind: 'unavailable' } }),
		...(b.score !== undefined
			? { b: { text: String(b.score), kind: 'measured' } }
			: { b: { text: 'não pontuada', kind: 'unavailable' } }),
		...(a.score !== undefined && b.score !== undefined && a.score !== b.score
			? { difference: `${a.score} contra ${b.score}` }
			: {}),
	};

	const result: ComparisonMetric = {
		id: 'result',
		label: 'Resultado',
		comparable: true,
		a: { text: a.result, kind: 'measured' },
		b: { text: b.result, kind: 'measured' },
		...(a.result !== b.result ? { difference: `${a.result} contra ${b.result}` } : {}),
	};

	const latency: ComparisonMetric = {
		id: 'latency',
		label: 'Latência',
		comparable: limited('latency') === undefined,
		...(limited('latency') !== undefined ? { limit: `${limited('latency')} diferente` } : {}),
		a: latencyOf(a),
		b: latencyOf(b),
		...(a.latencyMs !== undefined && b.latencyMs !== undefined && a.latencyMs !== b.latencyMs
			? { difference: `${a.latencyMs}ms contra ${b.latencyMs}ms` }
			: {}),
	};

	const tokens: ComparisonMetric = {
		id: 'tokens',
		label: 'Tokens',
		comparable: true,
		a: tokensOf(a),
		b: tokensOf(b),
		...(a.tokens !== undefined && b.tokens !== undefined && a.tokens !== b.tokens
			? { difference: `${a.tokens} contra ${b.tokens}` }
			: {}),
	};

	const cost: ComparisonMetric = {
		id: 'cost',
		label: 'Custo',
		comparable: true,
		a: costOf(a),
		b: costOf(b),
		...(a.costText !== undefined && b.costText !== undefined && a.costText !== b.costText
			? { difference: `${a.costText} contra ${b.costText}` }
			: {}),
	};

	return [model, score, result, latency, tokens, cost];
}

/** As diferenças observadas entre as duas execuções. */
function differencesOf(a: ComparisonSide, b: ComparisonSide): readonly string[] {
	const differences: string[] = [];
	if (a.model?.modelId !== b.model?.modelId) {
		differences.push(
			`modelo escolhido: ${a.model?.modelId ?? 'nenhum'} contra ${b.model?.modelId ?? 'nenhum'}`,
		);
	}
	if (a.score !== undefined && b.score !== undefined && a.score !== b.score) {
		differences.push(`pontuação: ${a.score} contra ${b.score}`);
	}
	if (a.result !== b.result) {
		differences.push(`resultado: ${a.result} contra ${b.result}`);
	}
	return differences;
}

/** Os provedores que a execução tocou. */
function providersOf(report: RoutingDecisionReport): Set<string> {
	const providers = new Set<string>();
	for (const attempt of report.attempts) {
		providers.add(attempt.providerId);
	}
	if (report.chosen !== undefined) {
		providers.add(report.chosen.providerId);
	}
	return providers;
}

function sameProviders(a: Set<string>, b: Set<string>): boolean {
	if (a.size !== b.size) {
		return false;
	}
	for (const provider of a) {
		if (!b.has(provider)) {
			return false;
		}
	}
	return true;
}

/**
 * A comparação é um experimento controlado?
 *
 * Só quando as condições são as mesmas. Uma comparação **limitada** tem dados
 * e diferenças, mas as condições não eram as mesmas — e a diferença entre as
 * execuções não é atribuível ao modelo.
 */
export function isComparable(outcome: ComparisonOutcome): boolean {
	return outcome.status === 'accepted';
}

/** O lado de uma execução, com o que se pode comparar. */
function sideOf(execution: HistoryExecution): ComparisonSide | undefined {
	const report = execution.report;
	const evaluation = report.evaluations.find((entry) => entry.chosen);
	const attempt = report.attempts.find((entry) => entry.outcome === 'success') ?? report.attempts[0];
	if (attempt === undefined) {
		return undefined;
	}
	const usage = attempt.usage;
	const cost = attempt.cost;
	const task = taskOf(report);
	return {
		executionId: execution.executionId,
		timestamp: execution.timestamp,
		...(report.chosen !== undefined
			? { model: { providerId: report.chosen.providerId, modelId: report.chosen.modelId } }
			: {}),
		...(evaluation?.score !== undefined ? { score: evaluation.score } : {}),
		result: report.result,
		policy: report.policy,
		sources: {
			price: report.sources.price,
			limits: report.sources.limits,
			capabilities: report.sources.capabilities,
		},
		...(task !== undefined ? { task } : {}),
		components: (evaluation?.components ?? []).map((component) => ({
			id: component.id,
			label: component.label,
			points: component.points,
		})),
		constraints: (evaluation?.constraints ?? []).map((constraint) => ({
			id: constraint.id,
			label: constraint.label,
		})),
		confidence: (evaluation?.confidence ?? []).map((item) => ({
			id: item.id,
			label: item.label,
		})),
		// Guardados para as métricas, que precisam do valor cru.
		...(attempt.totalMs !== undefined ? { latencyMs: attempt.totalMs } : {}),
		...(usage?.totalTokens !== undefined ? { tokens: usage.totalTokens } : {}),
		...(cost !== undefined
			? {
					costText:
						cost.status === 'estimated'
							? `estimado ${cost.total ?? '?'} ${cost.currency ?? ''}`.trim()
							: 'desconhecido',
				}
			: {}),
	};
}

/** A classificação da tarefa, pelas suas características estruturais. */
function taskOf(report: RoutingDecisionReport): ComparisonSide['task'] | undefined {
	const task: TaskClassificationExplanation | undefined = report.task;
	if (task === undefined) {
		return undefined;
	}
	return {
		domain: task.domain.detected,
		complexity: task.complexity.detected,
		capabilities: task.capabilities.map((capability) => capability.capability),
		needsTools: task.tools.needed,
		confidence: task.confidence.value,
	};
}

/** A latência, com a sua natureza. */
function latencyOf(side: ComparisonSide): ClassifiedValue {
	return side.latencyMs !== undefined
		? { text: `${side.latencyMs}ms`, kind: 'measured' }
		: { text: 'não medida', kind: 'unavailable' };
}

/** Os tokens, com a sua natureza. */
function tokensOf(side: ComparisonSide): ClassifiedValue {
	return side.tokens !== undefined
		? { text: String(side.tokens), kind: 'published' }
		: { text: 'não publicados', kind: 'unavailable' };
}

/** O custo, com a sua natureza. */
function costOf(side: ComparisonSide): ClassifiedValue {
	return side.costText !== undefined
		? { text: side.costText, kind: 'estimated' }
		: { text: 'não registrado', kind: 'unavailable' };
}
