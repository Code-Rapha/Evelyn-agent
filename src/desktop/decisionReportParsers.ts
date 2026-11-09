/**
 * O parser do relatório de decisão, usado pela ponte do preload.
 *
 * ## A regra que importa
 *
 * O relatório chega do Core e é lido por um processo diferente. Uma linha
 * malformada é **descartada**, como nos outros parsers desta janela.
 *
 * E há uma regra a mais: um relatório que trouxesse um campo de segredo é
 * **recusado inteiro**. A checagem de sigilo mora no Core
 * (`assertNoSecrets`), onde o relatório é montado; aqui a ponte repassa
 * apenas o que ela reconhece, e um campo desconhecido nunca é repassado.
 */
import type {
	ReportAttempt,
	ReportBudgetConstraint,
	ReportCandidateEvaluation,
	ReportConfidence,
	ReportQuotaConstraint,
	ReportSelectionConstraint,
	RoutingDecisionReportView,
} from './decisionReport';

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function number(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function side(value: unknown): 'user' | 'discovered' | undefined {
	return value === 'user' || value === 'discovered' ? value : undefined;
}

function policy(value: unknown): 'any' | 'free_only' | 'free_preferred' | undefined {
	return value === 'any' || value === 'free_only' || value === 'free_preferred' ? value : undefined;
}

function access(value: unknown): 'free' | 'paid' | 'unknown' | undefined {
	return value === 'free' || value === 'paid' || value === 'unknown' ? value : undefined;
}

function limitScope(value: unknown): 'global' | 'provider' | 'policy' | 'model' | undefined {
	return value === 'global' || value === 'provider' || value === 'policy' || value === 'model'
		? value
		: undefined;
}

export function parseRoutingDecisionReport(value: unknown): RoutingDecisionReportView | undefined {
	if (!isObject(value)) {
		return undefined;
	}
	const turnId = text(value.turnId);
	const conversationId = text(value.conversationId);
	const startedAt = text(value.startedAt);
	const strategy = text(value.strategy);
	const currentPolicy = policy(value.policy);
	if (
		turnId === undefined ||
		conversationId === undefined ||
		startedAt === undefined ||
		strategy === undefined ||
		currentPolicy === undefined
	) {
		return undefined;
	}
	const sources = isObject(value.sources) ? value.sources : undefined;
	const price = side(sources?.['price']);
	const limits = side(sources?.['limits']);
	const capabilities = side(sources?.['capabilities']);
	if (price === undefined || limits === undefined || capabilities === undefined) {
		return undefined;
	}
	const result = value.result;
	if (
		result !== 'success' &&
		result !== 'failed' &&
		result !== 'cancelled' &&
		result !== 'exhausted' &&
		result !== 'refused'
	) {
		return undefined;
	}

	const alternatives = Array.isArray(value.alternatives)
		? value.alternatives.flatMap((entry) => {
				if (!isObject(entry)) {
					return [];
				}
				const providerId = text(entry.providerId);
				const modelId = text(entry.modelId);
				const reason = text(entry.reason);
				if (providerId === undefined || modelId === undefined || reason === undefined) {
					return [];
				}
				return [
					{
						providerId,
						modelId,
						reason,
						discarded: entry.discarded === true,
					},
				];
			})
		: [];

	const attempts: ReportAttempt[] = Array.isArray(value.attempts)
		? value.attempts.flatMap((entry) => {
				if (!isObject(entry)) {
					return [];
				}
				const sequence = number(entry.sequence);
				const providerId = text(entry.providerId);
				const modelId = text(entry.modelId);
				const outcome = entry.outcome;
				if (
					sequence === undefined ||
					providerId === undefined ||
					modelId === undefined ||
					(outcome !== 'success' &&
						outcome !== 'failure' &&
						outcome !== 'skipped' &&
						outcome !== 'cancelled')
				) {
					return [];
				}
				const errorClass = text(entry.errorClass);
				const httpStatus = number(entry.httpStatus);
				const retryAfterMs = number(entry.retryAfterMs);
				const attempt: ReportAttempt = {
					sequence,
					providerId,
					modelId,
					outcome,
					fallback: entry.fallback === true,
					retry: entry.retry === true,
				};
				return [
					{
						...attempt,
						...(errorClass !== undefined ? { errorClass } : {}),
						...(httpStatus !== undefined ? { httpStatus } : {}),
						...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
					},
				];
			})
		: [];

	const budget: ReportBudgetConstraint[] = Array.isArray(value.budget)
		? value.budget.flatMap((entry) => {
				if (!isObject(entry)) {
					return [];
				}
				const limitId = text(entry.limitId);
				const scope = limitScope(entry.scope);
				const currency = text(entry.currency);
				const amount = number(entry.amount);
				const window = entry.window;
				if (
					limitId === undefined ||
					scope === undefined ||
					currency === undefined ||
					amount === undefined ||
					(window !== 'day' && window !== 'month')
				) {
					return [];
				}
				const limitPolicy = policy(entry.policy);
				const spent = number(entry.spent);
				const constraint: ReportBudgetConstraint = {
					limitId,
					scope,
					currency,
					amount,
					window,
					blocked: entry.blocked === true,
				};
				return [
					{
						...constraint,
						...(limitPolicy !== undefined ? { policy: limitPolicy } : {}),
						...(spent !== undefined ? { spent } : {}),
					},
				];
			})
		: [];

	const quotas: ReportQuotaConstraint[] = Array.isArray(value.quotas)
		? value.quotas.flatMap((entry) => {
				if (!isObject(entry)) {
					return [];
				}
				const providerId = text(entry.providerId);
				const source = text(entry.source);
				if (providerId === undefined || source === undefined) {
					return [];
				}
				const modelId = text(entry.modelId);
				const remaining = number(entry.remaining);
				const limit = number(entry.limit);
				const resetAt = text(entry.resetAt);
				const constraint: ReportQuotaConstraint = {
					providerId,
					exhausted: entry.exhausted === true,
					source,
				};
				return [
					{
						...constraint,
						...(modelId !== undefined ? { modelId } : {}),
						...(remaining !== undefined ? { remaining } : {}),
						...(limit !== undefined ? { limit } : {}),
						...(resetAt !== undefined ? { resetAt } : {}),
					},
				];
			})
		: [];

	const chosen = isObject(value.chosen)
		? (() => {
				const providerId = text(value.chosen.providerId);
				const modelId = text(value.chosen.modelId);
				const reason = text(value.chosen.reason);
				const modelAccess = access(value.chosen.access);
				if (
					providerId === undefined ||
					modelId === undefined ||
					reason === undefined ||
					modelAccess === undefined
				) {
					return undefined;
				}
				return {
					providerId,
					modelId,
					reason,
					access: modelAccess,
				};
			})()
		: undefined;

	const finalModel = isObject(value.finalModel)
		? (() => {
				const providerId = text(value.finalModel.providerId);
				const modelId = text(value.finalModel.modelId);
				return providerId !== undefined && modelId !== undefined
					? { providerId, modelId }
					: undefined;
			})()
		: undefined;

	const evaluations: ReportCandidateEvaluation[] = Array.isArray(value.evaluations)
		? value.evaluations.flatMap((entry) => {
				if (!isObject(entry)) {
					return [];
				}
				const providerId = text(entry.providerId);
				const modelId = text(entry.modelId);
				const reason = text(entry.reason);
				if (providerId === undefined || modelId === undefined || reason === undefined) {
					return [];
				}
				const score = number(entry.score);
				const components = Array.isArray(entry.components)
					? entry.components.flatMap((component) => {
							if (!isObject(component)) {
								return [];
							}
							const id = text(component.id);
							const label = text(component.label);
							const points = number(component.points);
							const detail = text(component.detail);
							if (
								id === undefined ||
								label === undefined ||
								points === undefined ||
								detail === undefined
							) {
								return [];
							}
							return [{ id, label, points, detail }];
						})
					: [];
				const constraints = Array.isArray(entry.constraints)
					? entry.constraints.flatMap((constraint) => {
							if (!isObject(constraint)) {
								return [];
							}
							const id = constraint.id;
							const label = text(constraint.label);
							const detail = text(constraint.detail);
							if (
								(id !== 'paid_not_allowed' &&
									id !== 'negative_score' &&
									id !== 'policy_excluded') ||
								label === undefined ||
								detail === undefined
							) {
								return [];
							}
							const typedConstraint: ReportSelectionConstraint = { id, label, detail };
							return [typedConstraint];
						})
					: [];
				const confidence = Array.isArray(entry.confidence)
					? entry.confidence.flatMap((item) => {
							if (!isObject(item)) {
								return [];
							}
							const id = item.id;
							const label = text(item.label);
							const detail = text(item.detail);
							if (
								(id !== 'no_catalog_entry' &&
									id !== 'capabilities_unknown' &&
									id !== 'context_unknown' &&
									id !== 'no_observations' &&
									id !== 'metadata_stale') ||
								label === undefined ||
								detail === undefined
							) {
								return [];
							}
							const confidence: ReportConfidence = { id, label, detail };
							return [confidence];
						})
					: [];
				return [
					{
						providerId,
						modelId,
						...(score !== undefined ? { score } : {}),
						components,
						constraints,
						confidence,
						reason,
						chosen: entry.chosen === true,
					},
				];
			})
		: [];

	const policyExcluded = Array.isArray(value.policyExcluded)
		? value.policyExcluded.flatMap((entry) => {
				if (!isObject(entry)) {
					return [];
				}
				const providerId = text(entry.providerId);
				const modelId = text(entry.modelId);
				const reason = text(entry.reason);
				if (providerId === undefined || modelId === undefined || reason === undefined) {
					return [];
				}
				return [{ providerId, modelId, reason, discarded: true }];
			})
		: [];

	return {
		turnId,
		conversationId,
		startedAt,
		strategy,
		policy: currentPolicy,
		policyApplied: value.policyApplied === true,
		sources: { price, limits, capabilities },
		...(chosen !== undefined ? { chosen } : {}),
		alternatives,
		evaluations,
		policyExcluded,
		budget,
		quotas,
		attempts,
		result,
		...(finalModel !== undefined ? { finalModel } : {}),
		summary: text(value.summary) ?? '',
	};
}

export function parseRoutingDecisionReports(value: unknown): readonly RoutingDecisionReportView[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const reports: RoutingDecisionReportView[] = [];
	for (const item of value) {
		const report = parseRoutingDecisionReport(item);
		if (report !== undefined) {
			reports.push(report);
		}
	}
	return reports;
}
