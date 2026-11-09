/**
 * Monta o relatório de decisão a partir do que a sessão sabe.
 *
 * ## Por que um módulo à parte
 *
 * Montar o relatório é junção de informação de quatro lugares: o plano da
 * seleção, as tentativas da rota, as decisões do portão de orçamento e as
 * janelas de cota. Separar a junção da sessão deixa a montagem testável sem
 * uma sessão, e deixa a sessão responsible apenas por *reunir* as peças.
 *
 * ## O que nunca entra
 *
 * Nem a pergunta, nem a resposta, nem um resumo delas. Nem a chave, nem um
 * cabeçalho. O relatório diz qual modelo respondeu e por quê; o que ele disse
 * é do turno, e o turno tem a sua própria história.
 */
import type { RouteAttempt } from '../core/providers/routing/types';
import type { SpendingLimit } from '../core/budget/policy';
import type { ModelAccessPolicy } from '../core/catalog/policy';
import type { ModelCatalogEntry, ModelAccess } from '../core/storage/types/modelCatalog';
import type { SelectionReason } from './modelSelector';
import type {
	ReportAlternative,
	ReportAttempt,
	ReportBudgetConstraint,
	ReportCandidateEvaluation,
	ReportChosen,
	ReportPrice,
	ReportProvenance,
	ReportQuotaConstraint,
	RoutingDecisionReport,
} from './decisionReport';
import type { TaskClassificationExplanation } from './taskDiscovery';
import type { RouterMode } from '../core/providers/routing/config';

/** O que a sessão sabe sobre um candidato, para o relatório. */
export interface ReportCandidate {
	readonly providerId: string;
	readonly modelId: string;
	/** A classificação de acesso que o catálogo ou a descoberta dão. */
	readonly access: ModelAccess;
	/** O preço em vigor, com a procedência. */
	readonly price?: ReportPrice;
	/** Os limites em vigor, com a procedência. */
	readonly limits?: {
		readonly contextTokens?: number;
		readonly maxOutputTokens?: number;
		readonly provenance?: ReportProvenance;
	};
	/** As capacidades que o seletor usou. */
	readonly capabilities?: {
		readonly toolCalling?: boolean;
		readonly structuredOutput?: boolean;
		readonly reasoning?: boolean;
	};
}

/** Uma decisão do portão de orçamento, como o portão a contou. */
export interface BudgetObservation {
	readonly candidate: { readonly providerId: string; readonly modelId: string };
	readonly applicable: readonly SpendingLimit[];
	readonly decision: { readonly allowed: boolean; readonly message?: string };
}

/** Uma janela de cota que estava aberta. */
export interface QuotaObservation {
	readonly providerId: string;
	readonly modelId?: string;
	readonly kind?: 'requests' | 'tokens';
	readonly scope?: 'api-key' | 'provider' | 'model' | 'account';
	readonly remaining?: number;
	readonly limit?: number;
	readonly resetAt?: string;
	readonly source: string;
}

export interface BuildDecisionReportInput {
	readonly turnId: string;
	readonly conversationId: string;
	readonly startedAt: string;
	readonly strategy: string;
	/** A explicação da classificação, quando o classificador a produziu. */
	readonly task?: TaskClassificationExplanation;
	readonly policy: ModelAccessPolicy;
	/** A política restringiu os candidatos? */
	readonly policyApplied: boolean;
	readonly sources: {
		readonly price: 'user' | 'discovered';
		readonly limits: 'user' | 'discovered';
		readonly capabilities: 'user' | 'discovered';
	};
	/** O escolhido, quando houve um. */
	readonly chosen?: ReportCandidate & { readonly reason: string };
	/** Os motivos que o seletor deu para cada candidato. */
	readonly reasons: readonly SelectionReason[];
	/**
	 * Quem decidiu o modelo, e o que é conhecido sobre isso.
	 *
	 * No modo `native` a Evelyn escolheu. Nos modos de alvo único, quem
	 * escolheu foi o outro lado.
	 */
	readonly routing?: {
		readonly mode: RouterMode;
		readonly providerId: string;
		readonly requestedModel: string;
		readonly respondedModel?: string;
		readonly decidedBy: 'seshyina' | 'external-router' | 'provider';
	};
	/** Os candidatos que a política removeu, antes da pontuação. */
	readonly policyExcluded?: readonly {
		readonly providerId: string;
		readonly modelId: string;
		readonly reason: string;
	}[];
	/** Os candidatos conhecidos, com o que se sabe deles. */
	readonly candidates: readonly ReportCandidate[];
	readonly budget: readonly BudgetObservation[];
	readonly quotas: readonly QuotaObservation[];
	readonly attempts: readonly RouteAttempt[];
	/**
	 * O custo de cada tentativa, como o ledger o mediu.
	 *
	 * O ledger é quem sabe o custo; o relatório o carrega sem recalcular.
	 */
	readonly costs?: ReadonlyMap<
		string,
		{
			readonly status: 'estimated' | 'unknown';
			readonly currency?: string;
			readonly total?: number;
			readonly reasons: readonly string[];
		}
	>;
	readonly result: RoutingDecisionReport['result'];
	readonly finalModel?: { readonly providerId: string; readonly modelId: string };
	readonly summary: string;
}

/** Monta o relatório. */
export function buildDecisionReport(input: BuildDecisionReportInput): RoutingDecisionReport {
	const chosenKey =
		input.chosen === undefined
			? input.reasons.find((reason) => reason.chosen)?.modelId === undefined
				? undefined
				: `${input.reasons.find((reason) => reason.chosen)?.providerId}:${input.reasons.find((reason) => reason.chosen)?.modelId}`
			: `${input.chosen.providerId}:${input.chosen.modelId}`;

	// O escolhido vem da entrada quando o chamador o resolveu; quando não,
	// ele é quem o seletor marcou como escolhido. As duas formas dizem a
	// mesma coisa, e a segunda é a que a tela recebe.
	const chosenCandidate =
		input.chosen ??
		input.candidates.find(
			(candidate) => `${candidate.providerId}:${candidate.modelId}` === chosenKey,
		);
	const chosenReason =
		input.chosen?.reason ??
		input.reasons.find((reason) => `${reason.providerId}:${reason.modelId}` === chosenKey)?.reason;

	const alternatives: ReportAlternative[] = [];
	for (const reason of input.reasons) {
		const key = `${reason.providerId}:${reason.modelId}`;
		if (key === chosenKey) {
			continue;
		}
		alternatives.push({
			providerId: reason.providerId,
			modelId: reason.modelId,
			reason: reason.reason,
			discarded: true,
		});
	}
	// Um candidato que o seletor nem chegou a pontuar - porque a política o
	// removeu antes - também é uma alternativa descartada, e a tela precisa
	// saber que ele existiu.
	for (const candidate of input.candidates) {
		const key = `${candidate.providerId}:${candidate.modelId}`;
		if (key === chosenKey) {
			continue;
		}
		if (alternatives.some((alternative) => `${alternative.providerId}:${alternative.modelId}` === key)) {
			continue;
		}
		alternatives.push({
			providerId: candidate.providerId,
			modelId: candidate.modelId,
			reason: 'considerado e não escolhido',
			discarded: true,
		});
	}

	const budget: ReportBudgetConstraint[] = [];
	for (const observation of input.budget) {
		for (const limit of observation.applicable) {
			budget.push({
				limitId: limit.limitId,
				scope: scopeLabel(limit),
				...(limit.policy !== undefined ? { policy: limit.policy } : {}),
				currency: limit.currency,
				amount: limit.amount,
				window: limit.window,
				blocked: !observation.decision.allowed,
			});
		}
	}

	const quotas: ReportQuotaConstraint[] = input.quotas.map((quota) => ({
		providerId: quota.providerId,
		...(quota.modelId !== undefined ? { modelId: quota.modelId } : {}),
		...(quota.kind !== undefined ? { kind: quota.kind } : {}),
		...(quota.scope !== undefined ? { scope: quota.scope } : {}),
		...(quota.remaining !== undefined ? { remaining: quota.remaining } : {}),
		...(quota.limit !== undefined ? { limit: quota.limit } : {}),
		...(quota.resetAt !== undefined ? { resetAt: quota.resetAt } : {}),
		exhausted: false,
		source: quota.source,
	}));

	const attempts: ReportAttempt[] = input.attempts.map((attempt) => {
		const usage = attempt.usage;
		const cost = input.costs?.get(`${attempt.providerId}:${attempt.modelId}`);
		return {
			sequence: attempt.sequence,
			providerId: attempt.providerId,
			modelId: attempt.modelId,
			outcome: attempt.outcome,
			...(attempt.errorClass !== undefined ? { errorClass: attempt.errorClass } : {}),
			...(attempt.httpStatus !== undefined ? { httpStatus: attempt.httpStatus } : {}),
			...(attempt.retryAfterMs !== undefined ? { retryAfterMs: attempt.retryAfterMs } : {}),
			fallback: attempt.fallback,
			retry: attempt.retry,
			...(attempt.ttfbMs !== undefined ? { ttfbMs: attempt.ttfbMs } : {}),
			...(attempt.firstVisibleEventMs !== undefined
				? { firstVisibleEventMs: attempt.firstVisibleEventMs }
				: {}),
			...(attempt.headersMs !== undefined ? { headersMs: attempt.headersMs } : {}),
			...(attempt.totalMs !== undefined ? { totalMs: attempt.totalMs } : {}),
			...(usage !== undefined
				? {
						usage: {
							...(usage.promptTokens !== undefined
								? { promptTokens: usage.promptTokens }
								: {}),
							...(usage.completionTokens !== undefined
								? { completionTokens: usage.completionTokens }
								: {}),
							...(usage.totalTokens !== undefined
								? { totalTokens: usage.totalTokens }
								: {}),
						},
					}
				: {}),
			...(cost !== undefined
				? {
						cost: {
							status: cost.status,
							...(cost.currency !== undefined ? { currency: cost.currency } : {}),
							...(cost.total !== undefined ? { total: cost.total } : {}),
							reasons: cost.reasons,
						},
					}
				: {}),
		};
	});

	// Uma cota esgotada aparece como tal: a tentativa que foi pulada por
	// `rate_limit` é a prova de que a janela estava fechada.
	for (const attempt of attempts) {
		if (attempt.errorClass !== 'rate_limit') {
			continue;
		}
		const index = quotas.findIndex(
			(quota) => quota.providerId === attempt.providerId && quota.modelId === attempt.modelId,
		);
		if (index >= 0) {
			quotas[index] = { ...quotas[index]!, exhausted: true };
		} else {
			quotas.push({
				providerId: attempt.providerId,
				modelId: attempt.modelId,
				exhausted: true,
				source: 'observed',
			});
		}
	}

	const chosen: ReportChosen | undefined =
		chosenCandidate === undefined || chosenReason === undefined
			? undefined
			: {
					providerId: chosenCandidate.providerId,
					modelId: chosenCandidate.modelId,
					reason: chosenReason,
					access: chosenCandidate.access,
					...(chosenCandidate.price !== undefined ? { price: chosenCandidate.price } : {}),
					...(chosenCandidate.limits !== undefined ? { limits: chosenCandidate.limits } : {}),
					...(chosenCandidate.capabilities !== undefined
						? { capabilities: chosenCandidate.capabilities }
						: {}),
				};

	const evaluations: ReportCandidateEvaluation[] = [
		...input.reasons.map((reason) => {
			const key = `${reason.providerId}:${reason.modelId}`;
			return {
				providerId: reason.providerId,
				modelId: reason.modelId,
				...(reason.score !== undefined ? { score: reason.score } : {}),
				components: (reason.components ?? []).map((component) => ({
					id: component.id,
					label: component.label,
					points: component.points,
					detail: component.detail,
				})),
				constraints: (reason.constraints ?? []).map((constraint) => ({
					id: constraint.id,
					label: constraint.label,
					detail: constraint.detail,
				})),
				confidence: (reason.confidence ?? []).map((item) => ({
					id: item.id,
					label: item.label,
					detail: item.detail,
				})),
				reason: reason.reason,
				chosen: key === chosenKey,
			};
		}),
		// Os que a política removeu: sem score, porque nunca foram
		// pontuados, e com a restrição que os removeu.
		...(input.policyExcluded ?? []).map((excluded) => ({
			providerId: excluded.providerId,
			modelId: excluded.modelId,
			components: [],
			constraints: [
				{
					id: 'policy_excluded' as const,
					label: 'Removed by the access policy',
					detail: excluded.reason,
				},
			],
			confidence: [],
			reason: excluded.reason,
			chosen: false,
		})),
	];

	return {
		turnId: input.turnId,
		conversationId: input.conversationId,
		startedAt: input.startedAt,
		strategy: input.strategy,
		...(input.task !== undefined ? { task: input.task } : {}),
		policy: input.policy,
		policyApplied: input.policyApplied,
		sources: input.sources,
		...(chosen !== undefined ? { chosen } : {}),
		...(input.routing !== undefined ? { routing: input.routing } : {}),
		alternatives,
		evaluations,
		policyExcluded: (input.policyExcluded ?? []).map((excluded) => ({
			providerId: excluded.providerId,
			modelId: excluded.modelId,
			reason: excluded.reason,
			discarded: true,
		})),
		budget,
		quotas,
		attempts,
		...(input.costs !== undefined ? { costs: input.costs } : {}),
		result: input.result,
		...(input.finalModel !== undefined ? { finalModel: input.finalModel } : {}),
		summary: input.summary,
	};
}

/** O rótulo do escopo de um limite, com a mesma precedência do Core. */
function scopeLabel(limit: SpendingLimit): 'global' | 'provider' | 'policy' | 'model' {
	if (limit.modelId !== undefined) {
		return 'model';
	}
	if (limit.providerId !== undefined) {
		return 'provider';
	}
	if (limit.policy !== undefined) {
		return 'policy';
	}
	return 'global';
}

/** O acesso de um registro do catálogo, para o relatório. */
export function accessOf(entry: ModelCatalogEntry | undefined): ModelAccess {
	return entry?.access ?? 'unknown';
}
