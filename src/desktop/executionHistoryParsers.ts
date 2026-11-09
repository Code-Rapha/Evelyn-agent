/**
 * Os parsers do histórico de execuções e da comparação.
 *
 * Mesma regra dos outros parsers: uma linha malformada é descartada, e a
 * recusa de uma comparação é uma resposta — não uma falha.
 */
import type {
	ComparisonContextDifference,
	ComparisonMetric,
	ComparisonOutcome,
	ComparisonSide,
	HistoryExecution,
	ValueKind,
} from './compareExecutions';
import { parseRoutingDecisionReport } from './decisionReportParsers';

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function number(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function parseHistoryExecution(value: unknown): HistoryExecution | undefined {
	if (!isObject(value)) {
		return undefined;
	}
	const executionId = text(value.executionId);
	const timestamp = text(value.timestamp);
	const conversationId = text(value.conversationId);
	const report = parseRoutingDecisionReport(value.report);
	if (
		executionId === undefined ||
		timestamp === undefined ||
		conversationId === undefined ||
		report === undefined
	) {
		return undefined;
	}
	return { executionId, timestamp, conversationId, report };
}

export function parseExecutionHistory(value: unknown): readonly HistoryExecution[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const history: HistoryExecution[] = [];
	for (const item of value) {
		const execution = parseHistoryExecution(item);
		if (execution !== undefined) {
			history.push(execution);
		}
	}
	return history;
}

const VALUE_KINDS: readonly ValueKind[] = [
	'measured',
	'published',
	'estimated',
	'declared',
	'unknown',
	'unavailable',
];

const METRIC_IDS: readonly ComparisonMetric['id'][] = [
	'model',
	'score',
	'result',
	'latency',
	'tokens',
	'cost',
];

function parseValue(value: unknown): { text: string; kind: ValueKind } | undefined {
	if (!isObject(value)) {
		return undefined;
	}
	const label = text(value.text);
	const kind = VALUE_KINDS.find((candidate) => candidate === value.kind);
	if (label === undefined || kind === undefined) {
		return undefined;
	}
	return { text: label, kind };
}

function parseMetric(value: unknown): ComparisonMetric | undefined {
	if (!isObject(value)) {
		return undefined;
	}
	const id = METRIC_IDS.find((candidate) => candidate === value.id);
	const label = text(value.label);
	if (id === undefined || label === undefined) {
		return undefined;
	}
	const a = parseValue(value.a);
	const b = parseValue(value.b);
	const limit = text(value.limit);
	const difference = text(value.difference);
	return {
		id,
		label,
		comparable: value.comparable === true,
		...(limit !== undefined ? { limit } : {}),
		...(a !== undefined ? { a } : {}),
		...(b !== undefined ? { b } : {}),
		...(difference !== undefined ? { difference } : {}),
	};
}

function parseContextDifference(value: unknown): ComparisonContextDifference | undefined {
	if (!isObject(value)) {
		return undefined;
	}
	const what = text(value.what);
	const a = text(value.a);
	const b = text(value.b);
	if (what === undefined || a === undefined || b === undefined) {
		return undefined;
	}
	const affects = Array.isArray(value.affects)
		? value.affects.filter(
				(item): item is ComparisonMetric['id'] =>
					typeof item === 'string' && (METRIC_IDS as readonly string[]).includes(item),
			)
		: [];
	return { what, a, b, affects };
}

function parseSide(value: unknown): ComparisonSide | undefined {
	if (!isObject(value)) {
		return undefined;
	}
	const executionId = text(value.executionId);
	const timestamp = text(value.timestamp);
	const result = text(value.result);
	const policy = text(value.policy);
	if (
		executionId === undefined ||
		timestamp === undefined ||
		result === undefined ||
		policy === undefined
	) {
		return undefined;
	}
	const model = isObject(value.model)
		? (() => {
				const providerId = text(value.model.providerId);
				const modelId = text(value.model.modelId);
				return providerId !== undefined && modelId !== undefined
					? { providerId, modelId }
					: undefined;
			})()
		: undefined;
	const sources = isObject(value.sources)
		? {
				price: text(value.sources.price) ?? 'unknown',
				limits: text(value.sources.limits) ?? 'unknown',
				capabilities: text(value.sources.capabilities) ?? 'unknown',
			}
		: undefined;
	if (sources === undefined) {
		return undefined;
	}
	const task = isObject(value.task)
		? (() => {
				const domain = text(value.task.domain);
				const complexity = text(value.task.complexity);
				if (domain === undefined || complexity === undefined) {
					return undefined;
				}
				const capabilities = Array.isArray(value.task.capabilities)
					? value.task.capabilities.filter((item): item is string => typeof item === 'string')
					: [];
				const confidence = number(value.task.confidence);
				return {
					domain,
					complexity,
					capabilities,
					needsTools: value.task.needsTools === true,
					confidence: confidence ?? 0,
				};
			})()
		: undefined;
	const score = number(value.score);
	const latencyMs = number(value.latencyMs);
	const tokens = number(value.tokens);
	const costText = text(value.costText);
	const components: { id: string; label: string; points: number }[] = [];
	for (const item of parseNamedList(value.components, true)) {
		if (item.points !== undefined) {
			components.push({ id: item.id, label: item.label, points: item.points });
		}
	}
	return {
		executionId,
		timestamp,
		...(model !== undefined ? { model } : {}),
		...(score !== undefined ? { score } : {}),
		result,
		policy,
		sources,
		...(task !== undefined ? { task } : {}),
		components,
		constraints: parseNamedList(value.constraints, false),
		confidence: parseNamedList(value.confidence, false),
		...(latencyMs !== undefined ? { latencyMs } : {}),
		...(tokens !== undefined ? { tokens } : {}),
		...(costText !== undefined ? { costText } : {}),
	};
}

function parseNamedList(
	value: unknown,
	withPoints: boolean,
): readonly { readonly id: string; readonly label: string; readonly points?: number }[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const list: { id: string; label: string; points?: number }[] = [];
	for (const item of value) {
		if (!isObject(item)) {
			continue;
		}
		const id = text(item.id);
		const label = text(item.label);
		if (id === undefined || label === undefined) {
			continue;
		}
		const points = number(item.points);
		if (withPoints) {
			if (points === undefined) {
				continue;
			}
			list.push({ id, label, points });
			continue;
		}
		list.push({ id, label });
	}
	return list;
}

/**
 * A comparação, ou a recusa.
 *
 * Uma recusa é uma resposta legítima: duas execuções sem tentativa nenhuma não
 * têm o que comparar, e a tela precisa saber disso.
 */
export function parseExecutionComparison(value: unknown): ComparisonOutcome | undefined {
	if (!isObject(value)) {
		return undefined;
	}
	const status = value.status;
	if (status === 'refused') {
		const reason = value.reason;
		if (reason !== 'no_data' && reason !== 'unknown_execution') {
			return undefined;
		}
		const detail = text(value.detail);
		if (detail === undefined) {
			return undefined;
		}
		return { status: 'refused', reason, detail };
	}
	if (status !== 'accepted' && status !== 'limited') {
		return undefined;
	}
	const a = parseSide(value.a);
	const b = parseSide(value.b);
	if (a === undefined || b === undefined) {
		return undefined;
	}
	const reason = text(value.reason);
	if (reason === undefined) {
		return undefined;
	}
	const metrics = Array.isArray(value.metrics)
		? value.metrics.flatMap((metric) => {
				const parsed = parseMetric(metric);
				return parsed === undefined ? [] : [parsed];
			})
		: [];
	const differences = Array.isArray(value.differences)
		? value.differences.filter((item): item is string => typeof item === 'string')
		: [];
	const context = Array.isArray(value.context)
		? value.context.flatMap((item) => {
				const parsed = parseContextDifference(item);
				return parsed === undefined ? [] : [parsed];
			})
		: [];
	if (status === 'accepted') {
		return { status, reason, a, b, metrics, differences, context };
	}
	const limits = Array.isArray(value.limits)
		? value.limits.filter((item): item is string => typeof item === 'string')
		: [];
	return { status, reason, a, b, metrics, differences, context, limits };
}
