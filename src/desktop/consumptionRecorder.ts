/**
 * A ponte entre as tentativas do roteador e o registro de consumo.
 *
 * ## Por que uma segunda porta, e não a mesma
 *
 * `createCatalogMetricsPort` (Etapa 4A) grava `ModelObservation`: latência
 * medida, só para quem respondeu, para o seletor pontuar. Este módulo grava
 * consumo: **toda** tentativa, com status, tokens e custo, para contabilização.
 * Fundir as duas obrigaria uma das duas a aceitar o quê da outra (observar
 * falha como latência, ou perder a tentativa que não respondeu), e a primeira é
 * exatamente o que a 4A decidiu não fazer.
 *
 * ## Como não duplicar
 *
 * A 4A já tem o ponto de passagem de cada tentativa: `wrapMetrics` decora a
 * porta construída pela sessão. Este módulo se encaixa ali, chamando a porta
 * interna primeiro e registrando depois, com três garantias:
 *
 * 1. **Uma execução por rodada lógica.** A rodada é o `requestId` do motor: uma
 *    chamada a `streamChat`, com todos os seus retries e fallbacks. A execução
 *    é registrada na primeira tentativa que chegar, com `status` provisório, e
 *    finalizada na última. Duas tentativas nunca viram duas execuções.
 * 2. **Uma tentativa por `(rodada, sequência)`.** O armazenamento deriva o id
 *    da tentativa dessa chave e faz upsert, então uma tentativa reentregue
 *    (retry interno do chamador, reenvio após falha de escrita) atualiza a
 *    mesma linha em vez de somar de novo.
 * 3. **Só a tentativa paga.** Um `skipped` (breaker aberto) nunca chegou ao
 *    provedor: não há consumo a registrar, e registrá-lo como "zero token"
 *    esconderia que nada foi cobrado.
 *
 * ## Quando a rodada termina
 *
 * O motor publica cada tentativa enquanto a rota termina, e a última é a que
 * carrega o resultado. Mas o desfecho da **rodada** é do chamador: uma rodada
 * cuja última tentativa foi `cancelled` por `user-stop`, seguida de um turno
 * abandonado, não é sucesso. Por isso a porta devolve `settleRequest`, que o
 * chamador usa quando sabe como o turno terminou, e `settled()`, que garante
 * que toda escrita iniciada já chegou ao disco.
 *
 * ## Falha de escrita não derruba a conversa
 *
 * Toda escrita é tratada e reportada por `onFailure`; nada aqui rejeita para o
 * motor. Um registro de custo perdido é uma perda, e a resposta do modelo já
 * foi entregue — inverter essa ordem por causa de contabilidade seria trocar o
 * principal pelo acessório.
 */
import type {
	AttemptRecord,
	ConsumptionLedgerPort,
	ExecutionRecord,
	ExecutionStatus,
	TokenCounts,
} from '../core/storage/types/consumption';
import { attemptIdFor, resolveAttemptAccounting } from '../core/storage/types/consumption';
import type { ModelPricing } from '../core/storage/types/modelCatalog';
import type { RouteAttempt, RoutingMetricsPort } from '../core/providers/routing/types';
import { attemptStatus } from '../core/providers/routing/types';

/** O que o gravador precisa do armazenamento. Estreito para um teste passar um stub. */
export type ConsumptionWriter = Pick<ConsumptionLedgerPort, 'recordExecution' | 'recordAttempt'>;

/** O preço de um modelo, como o catálogo o guarda hoje. */
export type PricingLookup = (
	providerId: string,
	modelId: string,
) => ModelPricing | undefined | Promise<ModelPricing | undefined>;

export interface ConsumptionRecorderOptions {
	readonly ledger: ConsumptionWriter;
	/**
	 * Lê o preço **no momento da tentativa**.
	 *
	 * Assíncrono porque o preço vem do mesmo armazenamento, e ler só no fim da
	 * rodada aplicaria o preço de amanhã a uma chamada de hoje.
	 */
	readonly pricing?: PricingLookup;
	/**
	 * A conversa do turno em curso, se houver.
	 *
	 * Lida no momento da tentativa, e não fixada na criação do gravador: o
	 * mesmo gravador serve a sessão inteira, e uma conversa trocada entre
	 * turnos não pode fazer o segundo turno ser contado na primeira.
	 */
	readonly conversationId?: () => string | undefined;
	/**
	 * O turno do host, quando o motor não o conhece.
	 *
	 * O motor identifica a rodada por `routeId`; um host que tem turnos
	 * próprios (o desktop tem) passa o dele aqui, e a execução fica ligada ao
	 * turno que a UI anunciou. Ausente: o `routeId` continua sendo a resposta.
	 */
	readonly turnId?: () => string | undefined;
	/** Chamado quando uma escrita falha. Deve ser barato e não lançar. */
	readonly onFailure?: (error: unknown, context: { readonly phase: 'execution' | 'attempt' }) => void;
	readonly now?: () => number;
}

/**
 * O identificador lógico da execução para uma tentativa.
 *
 * `routeId` quando o host o fornece: é o que liga uma rodada ao turno que a
 * pediu. Sem ele, o `requestId` do motor já é único por chamada — e é a
 * identidade certa, porque duas chamadas de `streamChat` no mesmo turno (ida e
 * volta de ferramenta) são duas execuções, não uma.
 */
export function executionIdFor(attempt: RouteAttempt): string {
	return attempt.routeId !== undefined
		? `${attempt.routeId}:${attempt.requestId}`
		: attempt.requestId;
}

/** Uma execução só é registrada para tentativas que chegaram ao provedor. */
function billsUsage(attempt: RouteAttempt): boolean {
	return attempt.outcome !== 'skipped';
}

/** Tokens da tentativa, separados por origem. */
export function attemptTokenInputs(attempt: RouteAttempt): {
	readonly reportedTokens?: TokenCounts;
} {
	const usage = attempt.usage;
	if (usage?.promptTokens === undefined || usage.completionTokens === undefined) {
		return {};
	}
	// `cachedInputTokens` é subconjunto de `promptTokens` e só entra quando o
	// provedor o publicou. `totalTokens` e `reasoningTokens` não entram no
	// custo: o primeiro é redundante com input + output, e o segundo já está
	// dentro de `completionTokens`.
	return {
		reportedTokens: {
			input: usage.promptTokens,
			output: usage.completionTokens,
			...(usage.cachedInputTokens !== undefined ? { cachedInput: usage.cachedInputTokens } : {}),
		},
	};
}

/** O preço, reduzido ao que o armazenamento valida. */
export function pricingInput(pricing: ModelPricing | undefined): {
	readonly currency: string;
	readonly unit: ModelPricing['unit'];
	readonly input?: number;
	readonly output?: number;
	readonly cachedInput?: number;
} | undefined {
	if (pricing === undefined) {
		return undefined;
	}
	const only = (value: number | undefined): number | undefined =>
		typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
	return {
		currency: pricing.currency,
		unit: pricing.unit,
		...(only(pricing.input) !== undefined ? { input: only(pricing.input) } : {}),
		...(only(pricing.output) !== undefined ? { output: only(pricing.output) } : {}),
		...(only(pricing.cachedInput) !== undefined ? { cachedInput: only(pricing.cachedInput) } : {}),
	};
}

/** O status da rodada inteira, a partir do das tentativas. */
export function executionStatusFrom(attempts: readonly Pick<RouteAttempt, 'outcome'>[]): ExecutionStatus {
	if (attempts.some((attempt) => attempt.outcome === 'success')) {
		return 'success';
	}
	if (attempts.some((attempt) => attempt.outcome === 'failure')) {
		return 'failure';
	}
	if (attempts.some((attempt) => attempt.outcome === 'cancelled')) {
		return 'cancelled';
	}
	// Só tentativas puladas: nada rodou.
	return 'cancelled';
}

/** Estado de uma rodada em andamento. */
interface Round {
	readonly executionId: string;
	readonly turnId?: string;
	readonly routeId?: string;
	/** A conversa que originou o turno, quando o host a conhece. */
	readonly conversationId?: string;
	readonly startedAtMs: number;
	readonly attempts: Map<number, RouteAttempt>;
	/** O modelo que respondeu, uma vez que um responda. */
	providerId?: string;
	modelId?: string;
	finished: boolean;
}

/**
 * A porta de consumo, pronta para `wrapMetrics`.
 *
 * Além de `recordAttempt` (que é o que o motor chama), expõe:
 *
 * - `settleRequest(requestId, status?)` — fecha a rodada com o desfecho que o
 *   chamador conhece, quando ele conhece algo além das tentativas;
 * - `settled()` — espera as escritas em voo;
 * - `pendingErrors()` — o que falhou até aqui, para o host expor num log.
 */
export interface ConsumptionRecorder {
	readonly recordAttempt: (attempt: RouteAttempt) => Promise<void>;
	settleRequest(requestId: string, status?: ExecutionStatus): Promise<void>;
	settled(): Promise<void>;
	readonly failures: readonly unknown[];
}

export function createConsumptionRecorder(options: ConsumptionRecorderOptions): ConsumptionRecorder {
	const now = options.now ?? Date.now;
	const rounds = new Map<string, Round>();
	const failures: unknown[] = [];
	const pending = new Set<Promise<void>>();

	const report = (error: unknown, phase: 'execution' | 'attempt'): void => {
		failures.push(error);
		try {
			options.onFailure?.(error, { phase });
		} catch {
			// Um observador que lança ao reportar uma falha não vira a falha.
		}
	};

	const iso = (ms: number): string => new Date(ms).toISOString();

	const track = (work: Promise<void>): Promise<void> => {
		pending.add(work);
		void work.then(
			() => pending.delete(work),
			() => pending.delete(work),
		);
		return work;
	};

	const ensureExecution = async (attempt: RouteAttempt): Promise<Round> => {
		const executionId = executionIdFor(attempt);
		const existing = rounds.get(executionId);
		if (existing !== undefined) {
			return existing;
		}
		const round: Round = {
			executionId,
			...(() => {
				const turnId = attempt.routeId ?? options.turnId?.();
				return turnId !== undefined ? { turnId } : {};
			})(),
			...(attempt.routeId !== undefined ? { routeId: attempt.routeId } : {}),
			...(() => {
				const conversationId = options.conversationId?.();
				return conversationId !== undefined ? { conversationId } : {};
			}),
			startedAtMs: attempt.startedAtMs,
			attempts: new Map(),
			finished: false,
		};
		rounds.set(executionId, round);
		return round;
	};

	const writeExecution = async (round: Round, status: ExecutionStatus): Promise<ExecutionRecord | undefined> => {
		try {
			return await options.ledger.recordExecution({
				executionId: round.executionId,
				kind: 'routing',
				...(round.turnId !== undefined ? { turnId: round.turnId } : {}),
				...(round.routeId !== undefined ? { routeId: round.routeId } : {}),
				...(round.conversationId !== undefined ? { conversationId: round.conversationId } : {}),
				...(round.providerId !== undefined ? { providerId: round.providerId } : {}),
				...(round.modelId !== undefined ? { modelId: round.modelId } : {}),
				status,
				startedAt: iso(round.startedAtMs),
				finishedAt: iso(now()),
			});
		} catch (error) {
			report(error, 'execution');
			return undefined;
		}
	};

	const recordAttempt = (attempt: RouteAttempt): Promise<void> => {
		if (!billsUsage(attempt)) {
			return Promise.resolve();
		}
		const work = (async (): Promise<void> => {
			const round = await ensureExecution(attempt);
			round.attempts.set(attempt.sequence, attempt);
			if (attempt.outcome === 'success') {
				round.providerId = attempt.providerId;
				round.modelId = attempt.modelId;
			}
			const status = attemptStatus(attempt);
			// A execução é escrita antes da tentativa porque o armazenamento
			// recusa uma tentativa órfã; e reescrevê-la a cada tentativa é o que
			// mantém seus totais corretos para quem consultar no meio da rodada.
			const execution = await writeExecution(round, status === 'success' ? 'success' : status);
			if (execution === undefined) {
				// Sem a execução, a tentativa não pode ser gravada. Já foi
				// reportado; não há segunda mensagem a inventar.
				return;
			}
			let pricing: ModelPricing | undefined;
			try {
				pricing = options.pricing === undefined
					? undefined
					: await options.pricing(attempt.providerId, attempt.modelId);
			} catch (error) {
				report(error, 'attempt');
			}
			// Sem tokens não há consumo nem preço a aplicar: gravar a tarifa de um
			// modelo numa tentativa que não gastou nada sugeriria um custo zero
			// calculado, quando o correto é não haver o que calcular.
			const tokens = attemptTokenInputs(attempt);
			const price = tokens.reportedTokens === undefined ? undefined : pricingInput(pricing);
			const accounting = resolveAttemptAccounting({
				...tokens,
				...(price !== undefined ? { pricing: price } : {}),
			});
			try {
				await options.ledger.recordAttempt({
					executionId: round.executionId,
					sequence: attempt.sequence,
					providerId: attempt.providerId,
					modelId: attempt.modelId,
					retry: attempt.retry,
					fallback: attempt.fallback,
					status,
					startedAt: iso(attempt.startedAtMs),
					...(accounting.reportedTokens !== undefined ? { reportedTokens: accounting.reportedTokens } : {}),
					...(accounting.estimatedTokens !== undefined ? { estimatedTokens: accounting.estimatedTokens } : {}),
					...(accounting.pricing !== undefined ? { pricing: accounting.pricing } : {}),
					...(attempt.errorClass !== undefined ? { errorClass: attempt.errorClass } : {}),
					...(attempt.abortCause !== undefined ? { abortCause: attempt.abortCause } : {}),
					...(attempt.httpStatus !== undefined ? { httpStatus: attempt.httpStatus } : {}),
				});
			} catch (error) {
				report(error, 'attempt');
			}
		})();
		return track(work);
		return track(work);
	};

	return {
		recordAttempt,
		async settleRequest(requestId: string, status?: ExecutionStatus): Promise<void> {
			// Encontra as rodadas que terminam neste requestId: com `routeId`, o id
			// é composto, então o sufixo é o que liga os dois.
			const matching = [...rounds.values()].filter(
				(round) =>
					round.executionId === requestId || round.executionId.endsWith(`:${requestId}`),
			);
			for (const round of matching) {
				if (round.finished) {
					continue;
				}
				round.finished = true;
				const finalStatus = status ?? executionStatusFrom([...round.attempts.values()]);
				await track(writeExecution(round, finalStatus).then(() => undefined));
			}
			// tentativa chegou: `settleRequest` corre depois do evento terminal,
			// e a sessão pode já ter liberado o slot. Registrar de novo com a
			// A conversa é conhecida aqui mesmo quando não era quando a
			// tentativa chegou: `settleRequest` corre depois do evento terminal,
			// e a sessão pode já ter liberado o slot. Registrar de novo com a
			// conversa é uma atualização idempotente da mesma execução.
			// que impede o recorte por conversa de perder o turno já fechado.
			const conversationId = options.conversationId?.();
			for (const round of matching) {
				if (conversationId === undefined || round.conversationId !== undefined) {
					continue;
				}
				const finalStatus = status ?? executionStatusFrom([...round.attempts.values()]);
				const relabelled: Round = { ...round, conversationId };
				await track(writeExecution(relabelled, finalStatus).then(() => undefined));
			}
		},
		async settled(): Promise<void> {
			while (pending.size > 0) {
				await Promise.all([...pending]);
			}
		},
		get failures(): readonly unknown[] {
			return [...failures];
		},
	};
}

/**
 * Mapa de preços a partir do catálogo.
 *
 * Só devolve um preço com moeda válida; um registro sem moeda não é um preço, e
 * o custo fica desconhecido em vez de assumir uma.
 */
export function catalogPricingLookup(
	read: (providerId: string, modelId: string) => Promise<ModelPricing | undefined>,
): PricingLookup {
	return async (providerId, modelId) => {
		const pricing = await read(providerId, modelId);
		if (pricing === undefined || typeof pricing.currency !== 'string' || pricing.currency.trim() === '') {
			return undefined;
		}
		return pricing;
	};
}

/** A tentativa gravada, para diagnóstico sem passar pelo disco. */
export function describeRecordedAttempt(record: AttemptRecord): string {
	const tokens =
		record.reportedTokens ?? record.estimatedTokens;
	const parts = [record.attemptId, `${record.providerId}/${record.modelId}`, record.status];
	if (record.tokenSource !== undefined) {
		parts.push(record.tokenSource);
	}
	if (tokens !== undefined) {
		parts.push(`${tokens.input ?? '?'}->${tokens.output ?? '?'}`);
	}
	parts.push(record.cost.status);
	return parts.join(' ');
}

