/**
 * Parsing tolerant of the consumption ledger file.
 *
 * Mesma política do catálogo (`parseModels`): um arquivo danificado custa o
 * histórico, não a inicialização; e um registro com um campo opcional inválido
 * perde **aquele campo**, não o registro.
 *
 * O que nunca é tolerado é a identidade: um registro sem `executionId` ou uma
 * tentativa sem `attemptId`/`executionId` não pode ser endereçado, e um
 * endereço inventado duplicaria consumo na próxima escrita. Esses são
 * descartados.
 *
 * Nenhum número é inventado na leitura: `cachedInput` inválido é descartado (o
 * custo fica desconhecido em vez de "cache zero"), um custo com `total` inválido
 * é relido a partir das partes, e um custo sem partes conhecidas volta a ser
 * `unknown`.
 */
import type {
	AttemptCost,
	AttemptRecord,
	CostPart,
	ExecutionRecord,
	ExecutionStatus,
	ExecutionTotals,
	TokenCounts,
	TokenSource,
} from './types/consumption';
import { summarizeExecution } from './types/consumption';
import type { CostUnit } from './types/modelCatalog';

function asObject(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Whole, non-negative. Fractional tokens are a value that means nothing. */
function count(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** Zero or more, finite. A negative price is refused at write time and dropped here. */
function amount(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Non-blank string. */
function text(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function timestamp(value: unknown): string | undefined {
	return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

function isStatus(value: unknown): value is ExecutionStatus {
	return value === 'success' || value === 'failure' || value === 'cancelled' || value === 'timeout';
}

function isUnit(value: unknown): value is CostUnit {
	return value === 'per_1k_tokens' || value === 'per_1m_tokens';
}

function isSource(value: unknown): value is TokenSource {
	return value === 'provider' || value === 'estimate';
}

/** Uma leitura de tokens com pelo menos um número; vazia é ausente. */
export function readTokenCounts(value: unknown): TokenCounts | undefined {
	const candidate = asObject(value);
	if (candidate === undefined) {
		return undefined;
	}
	const input = count(candidate['input']);
	const output = count(candidate['output']);
	const cachedInput = count(candidate['cachedInput']);
	if (input === undefined && output === undefined && cachedInput === undefined) {
		return undefined;
	}
	return {
		...(input !== undefined ? { input } : {}),
		...(output !== undefined ? { output } : {}),
		...(cachedInput !== undefined ? { cachedInput } : {}),
	};
}

function readPart(value: unknown): CostPart | undefined {
	const candidate = asObject(value);
	if (candidate === undefined) {
		return undefined;
	}
	const currency = text(candidate['currency']);
	const unit = candidate['unit'];
	const value0 = amount(candidate['amount']);
	if (currency === undefined || !isUnit(unit) || value0 === undefined) {
		return undefined;
	}
	const rate = amount(candidate['rate']);
	return { currency, unit, amount: value0, ...(rate !== undefined ? { rate } : {}) };
}

/**
 * Reads a cost, preferring the parts.
 *
 * `total` is not trusted on its own: a hand-edited total that disagrees with
 * its parts would be the number a budget would later be built from, and the
 * parts are the only thing that can be re-derived. With no parts left there is
 * nothing to stand on, and the cost is `unknown` whatever the file said.
 */
export function readCost(value: unknown): AttemptCost {
	const candidate = asObject(value) ?? {};
	const parts = Array.isArray(candidate['parts'])
		? candidate['parts'].map(readPart).filter((part): part is CostPart => part !== undefined)
		: [];
	const rawReasons = candidate['reasons'];
	const reasons = Array.isArray(rawReasons)
		? rawReasons.filter((reason): reason is string => typeof reason === 'string' && reason.length > 0)
		: [];
	const first = parts[0];
	if (candidate['status'] === 'estimated' && reasons.length === 0 && first !== undefined) {
		return {
			status: 'estimated',
			currency: first.currency,
			unit: first.unit,
			parts,
			total: parts.reduce((sum, part) => sum + part.amount, 0),
		};
	}
	if (parts.length === 0 && reasons.length > 0) {
		// Uma tentativa sem valor a aplicar tem a razão e nada mais. Ela não é
		// "danificada": foi gravada assim porque nada havia para calcular.
		return { status: 'unknown', parts: [], reasons };
	}
	if (first === undefined) {
		return {
			status: 'unknown',
			parts: [],
			reasons: reasons.length > 0 ? reasons : ['the stored cost had no usable amount'],
		};
	}
	return {
		status: 'unknown',
		currency: first.currency,
		unit: first.unit,
		parts,
		reasons: reasons.length > 0 ? reasons : ['the stored cost was incomplete'],
	};
}

/**
 * Narrows one stored attempt. Identity or nothing.
 */
export function readAttemptRecord(value: unknown): AttemptRecord | undefined {
	const candidate = asObject(value);
	if (candidate === undefined) {
		return undefined;
	}
	const attemptId = text(candidate['attemptId']);
	const executionId = text(candidate['executionId']);
	const providerId = text(candidate['providerId']);
	const modelId = text(candidate['modelId']);
	const sequence = count(candidate['sequence']);
	const status = candidate['status'];
	const startedAt = timestamp(candidate['startedAt']);
	const recordedAt = timestamp(candidate['recordedAt']);
	if (
		attemptId === undefined ||
		executionId === undefined ||
		providerId === undefined ||
		modelId === undefined ||
		sequence === undefined ||
		sequence < 1 ||
		!isStatus(status) ||
		startedAt === undefined ||
		recordedAt === undefined
	) {
		return undefined;
	}
	const reportedTokens = readTokenCounts(candidate['reportedTokens']);
	const estimatedTokens = readTokenCounts(candidate['estimatedTokens']);
	const tokenSource = isSource(candidate['tokenSource'])
		? candidate['tokenSource']
		: reportedTokens !== undefined
			? 'provider'
			: estimatedTokens !== undefined
				? 'estimate'
				: undefined;
	const pricingCandidate = asObject(candidate['pricing']);
	const pricingCurrency = text(pricingCandidate?.['currency']);
	const pricingUnit = pricingCandidate?.['unit'];
	const pricing =
		pricingCurrency !== undefined && isUnit(pricingUnit)
			? {
					currency: pricingCurrency,
					unit: pricingUnit,
					...(amount(pricingCandidate?.['input']) !== undefined
						? { input: amount(pricingCandidate?.['input']) }
						: {}),
					...(amount(pricingCandidate?.['output']) !== undefined
						? { output: amount(pricingCandidate?.['output']) }
						: {}),
					...(amount(pricingCandidate?.['cachedInput']) !== undefined
						? { cachedInput: amount(pricingCandidate?.['cachedInput']) }
						: {}),
				}
			: undefined;
	const httpStatus = count(candidate['httpStatus']);
	return {
		attemptId,
		executionId,
		providerId,
		modelId,
		sequence,
		retry: candidate['retry'] === true,
		fallback: candidate['fallback'] === true,
		status,
		startedAt,
		recordedAt,
		...(reportedTokens !== undefined ? { reportedTokens } : {}),
		...(estimatedTokens !== undefined ? { estimatedTokens } : {}),
		...(tokenSource !== undefined ? { tokenSource } : {}),
		...(pricing !== undefined ? { pricing } : {}),
		cost: readCost(candidate['cost']),
		...(text(candidate['errorClass']) !== undefined ? { errorClass: text(candidate['errorClass']) } : {}),
		...(text(candidate['abortCause']) !== undefined ? { abortCause: text(candidate['abortCause']) } : {}),
		...(httpStatus !== undefined ? { httpStatus } : {}),
	};
}

/** Totais gravados, lidos de forma tolerante; `summarizeExecution` é o que vale. */
export function readTotals(value: unknown): ExecutionTotals | undefined {
	const candidate = asObject(value);
	if (candidate === undefined) {
		return undefined;
	}
	const attempts = count(candidate['attempts']);
	if (attempts === undefined) {
		return undefined;
	}
	const tokens = readTokenCounts(candidate['tokens']);
	const source = isSource(candidate['tokenSource']) ? candidate['tokenSource'] : undefined;
	return {
		attempts,
		...(tokens !== undefined ? { tokens } : {}),
		...(source !== undefined ? { tokenSource: source } : {}),
		cost: readCost(candidate['cost']),
	};
}

/**
 * Recomputes the totals of one execution from the attempts the ledger holds.
 *
 * `summarizeExecution` is the single arithmetic for a set of attempts; this
 * function only decides **which** attempts belong to the execution. It counts
 * attempts that name this execution even when the stored `attemptIds` list has
 * not caught up with them (a write interrupted between the attempt and the
 * execution, or a hand-edited list), because the attempt own `executionId` is
 * the record of ownership. An id list pointing at an attempt owned by another
 * execution is ignored: crediting it here would move consumption from one turn
 * to another.
 */
export function summarizeStoredExecution(
	execution: ExecutionRecord,
	attempts: ReadonlyMap<string, AttemptRecord>,
): ExecutionTotals {
	const owned = [...attempts.values()].filter(
		(attempt) => attempt.executionId === execution.executionId,
	);
	return summarizeExecution(owned);
}

const EMPTY_TOTALS: ExecutionTotals = {
	attempts: 0,
	cost: { status: 'unknown', parts: [], reasons: ['no attempts were recorded'] },
};

/** Narrows one stored execution. Identity or nothing. */
export function readExecutionRecord(value: unknown): ExecutionRecord | undefined {
	const candidate = asObject(value);
	if (candidate === undefined) {
		return undefined;
	}
	const executionId = text(candidate['executionId']);
	const kind = candidate['kind'];
	const status = candidate['status'];
	const startedAt = timestamp(candidate['startedAt']);
	const finishedAt = timestamp(candidate['finishedAt']);
	if (
		executionId === undefined ||
		(kind !== 'routing' && kind !== 'turn') ||
		!isStatus(status) ||
		startedAt === undefined ||
		finishedAt === undefined
	) {
		return undefined;
	}
	const rawIds = candidate['attemptIds'];
	const attemptIds = Array.isArray(rawIds)
		? [...new Set(rawIds.filter((id): id is string => typeof id === 'string' && id.length > 0))]
		: [];
	const turnId = text(candidate['turnId']);
	const routeId = text(candidate['routeId']);
	const conversationId = text(candidate['conversationId']);
	const providerId = text(candidate['providerId']);
	const modelId = text(candidate['modelId']);
	return {
		executionId,
		kind,
		...(turnId !== undefined ? { turnId } : {}),
		...(routeId !== undefined ? { routeId } : {}),
		...(conversationId !== undefined ? { conversationId } : {}),
		...(providerId !== undefined ? { providerId } : {}),
		...(modelId !== undefined ? { modelId } : {}),
		status,
		startedAt,
		finishedAt,
		attemptIds,
		totals: readTotals(candidate['totals']) ?? EMPTY_TOTALS,
	};
}

/** What a well-formed ledger file holds. */
export interface ParsedConsumptionLedger {
	readonly executions: ReadonlyMap<string, ExecutionRecord>;
	readonly attempts: ReadonlyMap<string, AttemptRecord>;
}

/**
 * Reads the ledger, degrading a damaged file to an empty ledger.
 *
 * Duplicates keep the first: two records for one id mean a hand-edited or
 * half-merged file, and position is not evidence of which is right.
 * Attempts whose execution the file no longer holds are kept on read and
 * ignored by summaries — they are still facts, just orphaned, and deleting
 * them would silently rewrite the history.
 */
export function parseConsumptionLedger(raw: string): ParsedConsumptionLedger {
	const executions = new Map<string, ExecutionRecord>();
	const attempts = new Map<string, AttemptRecord>();
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { executions, attempts };
	}
	const root = asObject(parsed);
	if (root === undefined) {
		return { executions, attempts };
	}
	const executionList = root['executions'];
	if (Array.isArray(executionList)) {
		for (const value of executionList) {
			const record = readExecutionRecord(value);
			if (record !== undefined && !executions.has(record.executionId)) {
				executions.set(record.executionId, record);
			}
		}
	}
	const attemptList = root['attempts'];
	if (Array.isArray(attemptList)) {
		for (const value of attemptList) {
			const record = readAttemptRecord(value);
			if (record !== undefined && !attempts.has(record.attemptId)) {
				attempts.set(record.attemptId, record);
			}
		}
	}
	return { executions, attempts };
}

/** Tokens of one attempt, for the aggregate. */
export function attemptTokens(attempt: AttemptRecord): TokenCounts | undefined {
	return attempt.reportedTokens ?? attempt.estimatedTokens;
}

/** Recálculo dos totais de uma execução: delega à regra única, em `summarizeStoredExecution`. */
export function totalsFor(
	execution: ExecutionRecord,
	attempts: ReadonlyMap<string, AttemptRecord>,
): ExecutionTotals {
	return summarizeStoredExecution(execution, attempts);
}
