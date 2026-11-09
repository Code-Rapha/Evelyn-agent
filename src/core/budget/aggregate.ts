/**
 * Agregação de consumo num período.
 *
 * ## O que é agregado
 *
 * Execuções já filtradas pelo armazenamento (`ConsumptionQuery.since/until`)
 * são somadas por provedor, por modelo e por execução. A regra de soma não é
 * reimplementada aqui em cima de números soltos: cada execução chega com o
 * `ExecutionTotals.cost` que `summarizeExecution`/`combineCosts` produziu, e a
 * soma agregada segue a mesma regra de custo daquela etapa — **qualquer parte
 * desconhecida torna o total desconhecido**. Um subtotal apresentado como se
 * fosse o total é exatamente o erro que este módulo existe para não repetir.
 *
 * ## O que "só com dados confiáveis" significa
 *
 * - Custo agregado só é `estimated` quando **todas** as execuções contadas
 *   têm custo conhecido, na mesma moeda e na mesma unidade.
 * - Um preço desconhecido nunca vira zero: a execução entra em
 *   `executionsWithoutCost` e o motivo aparece em `costReasons`.
 * - Tokens agregados são somados por origem. Se qualquer execução contada foi
 *   deduzida localmente, `tokenSource` do agregado é `estimate`.
 *
 * ## Puro e sem host
 *
 * Não lê disco nem relógio. O período é aplicado pela consulta que produziu as
 * execuções; aqui só se decide como somá-las.
 */
import type {
	AttemptCost,
	ExecutionRecord,
	TokenCounts,
	TokenSource,
} from '../storage/types/consumption';
import { addTokens, combineCosts } from '../storage/types/consumption';
import type { CostUnit } from '../storage/types/modelCatalog';

/** Quanto uma execução consumiu, do ponto de vista de quem lê o relatório. */
export interface UsageTotal {
	/** Execuções contadas. */
	readonly executions: number;
	/** Tentativas contadas (todas as tentativas das execuções). */
	readonly attempts: number;
	readonly tokens?: TokenCounts;
	readonly tokenSource?: TokenSource;
	readonly cost: AttemptCost;
	/**
	 * Execuções cujo consumo não pôde ser precificado. Não é uma lista de
	 * falhas: é a razão pela qual o total acima é `unknown`.
	 */
	readonly executionsWithoutCost: number;
	readonly costReasons: readonly string[];
}

/** Um recorte do período: por provedor, por modelo, ou uma execução. */
export interface UsageSlice extends UsageTotal {
	/** O que identifica o recorte. */
	readonly providerId: string;
	readonly modelId?: string;
	/** A conversa que originou a execução, no recorte por execução. */
	readonly executionId?: string;
	readonly conversationId?: string;
	/** O turno da execução, no recorte por execução. */
	readonly turnId?: string;
	readonly firstStartedAt?: string;
	readonly lastStartedAt?: string;
}

/** O consumo de um período, em todos os recortes. */
export interface UsageSummary {
	/** Avaliado: `since` inclusive, `until` exclusivo. ISO-8601. */
	readonly since?: string;
	readonly until?: string;
	readonly total: UsageTotal;
	readonly byProvider: readonly UsageSlice[];
	readonly byModel: readonly UsageSlice[];
	readonly byExecution: readonly UsageSlice[];
}

/** Identidade de um recorte, para agrupar. */
interface SliceScope {
	readonly providerId: string;
	readonly modelId?: string;
	readonly executionId?: string;
}

interface SliceSeed extends SliceScope {
	readonly executions: ExecutionRecord[];
}

function sliceKey(seed: SliceScope): string {
	return `${seed.providerId}\u0000${seed.modelId ?? ''}\u0000${seed.executionId ?? ''}`;
}

function addTo(map: Map<string, SliceSeed>, seed: SliceScope, execution: ExecutionRecord): void {
	const key = sliceKey(seed);
	const existing = map.get(key);
	if (existing === undefined) {
		map.set(key, { ...seed, executions: [execution] });
	} else {
		existing.executions.push(execution);
	}
}

/**
 * Soma execuções num `UsageTotal`.
 *
 * `cost` é o custo combinado das execuções, e o motivo do desconhecido vem de
 * `cost.reasons`: a mesma lista que `combineCosts` produz, para que o relatório
 * e o registro contem a mesma história.
 */
export function summarizeUsage(executions: readonly ExecutionRecord[]): UsageTotal {
	let tokens: TokenCounts | undefined;
	let source: TokenSource | undefined;
	let attempts = 0;
	let executionsWithoutCost = 0;

	for (const execution of executions) {
		const totals = execution.totals;
		attempts += totals.attempts;
		tokens = addTokens(tokens, totals.tokens);
		if (totals.tokens !== undefined) {
			const executionSource = totals.tokenSource ?? 'estimate';
			source = source === undefined || source === executionSource ? executionSource : 'estimate';
		}
		if (totals.cost.status === 'unknown') {
			executionsWithoutCost += 1;
		}
	}

	const cost = combineCosts(executions.map((execution) => execution.totals.cost));
	return {
		executions: executions.length,
		attempts,
		...(tokens !== undefined ? { tokens } : {}),
		...(source !== undefined ? { tokenSource: source } : {}),
		cost,
		executionsWithoutCost,
		costReasons: cost.status === 'unknown' ? [...cost.reasons] : [],
	};
}

function toSlice(seed: SliceSeed): UsageSlice {
	const starts = seed.executions
		.map((execution) => execution.startedAt)
		.filter((value) => !Number.isNaN(Date.parse(value)))
		.sort((a, b) => a.localeCompare(b));
	return {
		providerId: seed.providerId,
		...(seed.modelId !== undefined ? { modelId: seed.modelId } : {}),
		...(seed.executionId !== undefined ? { executionId: seed.executionId } : {}),
		...(seed.executions[0]?.conversationId !== undefined
			? { conversationId: seed.executions[0].conversationId }
			: {}),
		...(seed.executions[0]?.turnId !== undefined ? { turnId: seed.executions[0].turnId } : {}),
		...(starts.length > 0 ? { firstStartedAt: starts[0] } : {}),
		...(starts.length > 0 ? { lastStartedAt: starts[starts.length - 1] } : {}),
		...summarizeUsage(seed.executions),
	};
}

/** Maior valor conhecido primeiro; desconhecido por último. */
function byCost(a: UsageSlice, b: UsageSlice): number {
	const aTotal = a.cost.status === 'estimated' ? a.cost.total : -1;
	const bTotal = b.cost.status === 'estimated' ? b.cost.total : -1;
	if (aTotal !== bTotal) {
		return bTotal - aTotal;
	}
	return a.providerId.localeCompare(b.providerId) || (a.modelId ?? '').localeCompare(b.modelId ?? '');
}

/**
 * Agrega execuções por período, provedor, modelo e execução.
 *
 * Uma execução sem provedor/modelo (não deveria acontecer numa rota, mas o
 * arquivo é lido com tolerância) não é descartada: ela continua no total e
 * aparece nos recortes com o id vazio, porque omitir consumo é pior do que
 * mostrá-lo sem rótulo.
 */
export function aggregateUsage(
	executions: readonly ExecutionRecord[],
	range: { readonly since?: string; readonly until?: string } = {},
): UsageSummary {
	const ordered = [...executions].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
	const providers = new Map<string, SliceSeed>();
	const models = new Map<string, SliceSeed>();
	const byExecution = new Map<string, SliceSeed>();

	for (const execution of ordered) {
		const providerId = execution.providerId ?? '';
		const modelId = execution.modelId;
		addTo(providers, { providerId }, execution);
		if (modelId !== undefined) {
			addTo(models, { providerId, modelId }, execution);
		}
		addTo(byExecution, { providerId, ...(modelId !== undefined ? { modelId } : {}), executionId: execution.executionId }, execution);
	}

	return {
		...(range.since !== undefined ? { since: range.since } : {}),
		...(range.until !== undefined ? { until: range.until } : {}),
		total: summarizeUsage(ordered),
		byProvider: [...providers.values()].map(toSlice).sort(byCost),
		byModel: [...models.values()].map(toSlice).sort(byCost),
		byExecution: [...byExecution.values()].map(toSlice).sort((a, b) => b.lastStartedAt?.localeCompare(a.lastStartedAt ?? '') ?? 0),
	};
}

/** Início e fim de uma janela de calendário local, em ISO-8601 UTC. */
export type UsageWindow = 'day' | 'month';

/**
 * O intervalo de uma janela, terminando em `now`.
 *
 * Dia e mês são **de calendário local** (o usuário pensa no seu mês, não no
 * de UTC) e convertidos de uma vez para ISO. Calcular o limite em UTC somaria
 * ou subtrairia horas do mês do usuário, e um orçamento mensal que vira à
 * meia-noite errada é um limite que ninguém entende.
 */
export function windowRange(window: UsageWindow, now: Date): { readonly since: string; readonly until: string } {
	const until = new Date(now.getTime());
	const start = new Date(now.getTime());
	if (window === 'month') {
		start.setDate(1);
	}
	start.setHours(0, 0, 0, 0);
	return { since: start.toISOString(), until: until.toISOString() };
}

