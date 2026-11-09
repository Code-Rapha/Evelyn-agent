/**
 * O portão de orçamento da sessão.
 *
 * ## O que ele lê, e quando
 *
 * Nada é mantido em memória além do resultado do turno em curso. Para cada
 * candidato, no momento de chamá-lo, o portão lê:
 *
 * - os limites (`SpendingLimitsPort`),
 * - o consumo do período de cada limite, pelo ledger (`ConsumptionQuery.since`),
 * - o acesso e o preço do modelo, pelo catálogo.
 *
 * Um total mantido à parte divergiria do ledger no primeiro dia em que uma
 * escrita falhasse — e o gasto é justamente o número que precisa continuar
 * sendo o mesmo que a tela mostra.
 *
 * ## Contagem por tentativa, não por execução
 *
 * O ledger guarda o provedor/modelo que **respondeu** em cada execução. Um
 * limite de modelo precisa contar também a tentativa que chamou aquele modelo
 * e consumiu tokens antes de falhar. Por isso o portão relê as tentativas de
 * cada execução do período e recalcula o custo com `summarizeExecution`, que é
 * a mesma aritmética da Etapa 5A — inclusive para "preço desconhecido nunca é
 * zero".
 *
 * ## Falha ao contabilizar não interrompe a conversa
 *
 * Qualquer erro aqui vira `allowed: true` com um aviso no log, pela mesma
 * regra da 5A: um registro que não pôde ser lido é uma perda de informação, e
 * transformar essa perda num turno recusado trocaria o principal pelo
 * acessório. O caso "há limite, mas não há custo conhecido" é decidido pelo
 * Core (`evaluateBudget` → `unknown`), que também permite e fica registrado.
 */
import type { BudgetDecision as RouterBudgetDecision, BudgetGate } from '../core/providers/routing/types';
import type {
	AttemptCost,
	AttemptRecord,
	ConsumptionLedgerPort,
	ExecutionRecord,
} from '../core/storage/types/consumption';
import { summarizeExecution } from '../core/storage/types/consumption';
import type { ModelCatalogPort, ModelPricing } from '../core/storage/types/modelCatalog';
import type { SpendingLimitsPort } from '../core/budget/limitsPort';
import {
	aggregateUsage,
	appliesTo,
	budgetAlert,
	evaluateBudget,
	forecastCall,
	LIMIT_SCOPE_PRECEDENCE,
	scopeOf,
	windowRange,
	type BudgetAlert,
	type BudgetUsage,
	type BudgetDecision as CoreBudgetDecision,
	type CallForecast,
	type ForecastSample,
	type SpendingLimit,
} from '../core/budget';
import type { ModelAccessPolicy } from '../core/catalog/policy';

/** O que o portão precisa do armazenamento, e nada além. */
export interface BudgetStore
	extends Pick<SpendingLimitsPort, 'listSpendingLimits'>,
		Pick<ConsumptionLedgerPort, 'listConsumption' | 'listAttempts'>,
		Pick<ModelCatalogPort, 'getModelCatalogEntry'> {}

export interface BudgetGateOptions {
	readonly store: BudgetStore;
	/**
	 * Autorização de gasto da sessão. Sem ela o portão não bloqueia: a decisão
	 * de não usar pago já acontece antes, na seleção e na checagem manual, e
	 * bloquear de novo aqui produziria uma mensagem falsa ("o orçamento
	 * bloqueou") para um modelo que nunca chegou a ser candidato.
	 */
	readonly allowPaid: boolean;
	/**
	 * O preço em vigor de um modelo, quando o host tem uma escolha a fazer.
	 *
	 * Ausente, o portão usa o preço do catálogo — o que a Evelyn guardou.
	 * Presente, o número vem de onde o host decidir, e o portão não decide
	 * sozinho: a previsão e o orçamento têm que usar o mesmo preço, ou a
	 * tela anunciaria um custo diferente do que seria cobrado.
	 */
	readonly pricing?: (
		candidate: { readonly providerId: string; readonly modelId: string },
	) => Promise<ModelPricing | undefined>;
	/**
	 * A política de acesso em vigor.
	 *
	 * É o que decide se um limite restrito a `free_only` se aplica a esta
	 * chamada. Ausente, os limites restritos por política não se aplicam — e
	 * os gerais, que são a maioria, continuam valendo como antes.
	 */
	readonly policy?: () => Promise<ModelAccessPolicy>;
	/**
	 * Observa cada decisão de orçamento.
	 *
	 * É o que permite ao relatório de decisão dizer **quais** limites foram
	 * considerados e o que cada um respondeu — e não só que "o orçamento
	 * bloqueou". Não pode lançar: uma falha de relatório não pode virar uma
	 * falha de turno.
	 */
	readonly onDecision?: (input: {
		readonly candidate: { readonly providerId: string; readonly modelId: string };
		readonly applicable: readonly SpendingLimit[];
		readonly decision: RouterBudgetDecision;
	}) => void;
	/** Injetado em testes; o padrão é o relógio do sistema. */
	readonly now?: () => Date;
	/** Chamado quando uma leitura falha. Não pode lançar. */
	readonly onFailure?: (
		error: unknown,
		context: { readonly phase: 'limits' | 'usage' | 'catalog' },
	) => void;
}

/**
 * O portão mais o que a sessão precisa para começar cada turno do zero.
 */
export interface SessionBudgetGate extends BudgetGate {
	/** Descarta o que foi lido no turno anterior. */
	reset(): void;
	/**
	 * A previsão do próximo turno, se houver como fazê-la.
	 *
	 * Nunca escreve, nunca bloqueia e nunca lança: é informação para a tela e
	 * para os avisos. `undefined` quando o modelo não pode ser lido do catálogo.
	 */
	preview(
		candidate: { readonly providerId: string; readonly modelId: string },
		promptText: string,
		conversationId?: string,
	): Promise<CallForecast | undefined>;
	/**
	 * Avisa quando um limite aplicável cruzou 80%.
	 *
	 * Consulta o mesmo gasto que `check` consulta, então um aviso e um bloqueio
	 * nunca discordam sobre o número. Um aviso não impede a chamada: quem
	 * bloqueia continua sendo `check`.
	 */
	alert(
		candidate: { readonly providerId: string; readonly modelId: string },
		conversationId?: string,
	): Promise<BudgetAlert | undefined>;
}

/**
 * Soma o consumo de um período, contado pelas tentativas de um provedor ou
 * modelo.
 *
 * Só contam tentativas que pertencem ao recorte pedido. Uma execução em que
 * nenhuma tentativa pertence não entra: ela foi precificada para outros
 * modelos, e somá-la aqui cobraria o recorte errado.
 */
export function usageFor(
	executions: readonly ExecutionRecord[],
	attemptsOf: (executionId: string) => readonly AttemptRecord[],
	scope: { readonly providerId?: string; readonly modelId?: string },
): BudgetUsage {
	const relevant: ExecutionRecord[] = [];
	for (const execution of executions) {
		const owned = attemptsOf(execution.executionId).filter(
			(attempt) =>
				(scope.providerId === undefined || attempt.providerId === scope.providerId) &&
				(scope.modelId === undefined || attempt.modelId === scope.modelId),
		);
		if (owned.length === 0) {
			continue;
		}
		relevant.push({ ...execution, totals: summarizeExecution(owned) });
	}
	const cost = aggregateUsage(relevant).total.cost;
	return { cost, ...(cost.status === 'estimated' ? { spent: cost.total } : {}) };
}

/** Não há custo conhecido na moeda do limite ⇒ "não medido", nunca zero. */
function spendIn(cost: AttemptCost, currency: string): number | undefined {
	if (cost.status !== 'estimated' || cost.currency.toUpperCase() !== currency.toUpperCase()) {
		return undefined;
	}
	return cost.total;
}

/** A mensagem que a UI mostra quando um limite vetou uma tentativa. */
export function budgetMessage(limit: SpendingLimit, decision: Extract<CoreBudgetDecision, { kind: 'blocked' }>): string {
	const scope = scopeOf(limit);
	const where =
		scope === 'global'
			? 'geral'
			: scope === 'provider'
				? `do provedor ${limit.providerId ?? ''}`
				: `do modelo ${limit.providerId ?? ''}/${limit.modelId ?? ''}`;
	const window = limit.window === 'day' ? 'diário' : 'mensal';
	const format = (value: number): string =>
		value.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
	return (
		`Limite de orçamento ${window} ${where} atingido: ` +
		`${format(decision.spent)} de ${format(decision.amount)} ${limit.currency}. ` +
		'O modelo pago não foi chamado. Ajuste o limite nos ajustes para continuar.'
	);
}

/** O gate que a `ChatSession` entrega ao provedor roteado. */
export function createBudgetGate(options: BudgetGateOptions): SessionBudgetGate {
	const now = options.now ?? (() => new Date());

	const cachedUsage = new Map<string, BudgetUsage>();

	/**
	 * Entrega a decisão ao observador, sem nunca deixar o observador
	 * decidir: um relatório que falha é um relatório perdido, e um relatório
	 * perdido não pode virar uma chamada bloqueada.
	 */
	const observe = (
		candidate: { readonly providerId: string; readonly modelId: string },
		applicable: readonly SpendingLimit[],
		decision: RouterBudgetDecision,
	): void => {
		if (options.onDecision === undefined) {
			return;
		}
		try {
			options.onDecision({ candidate, applicable, decision });
		} catch {
			// Observar não pode falhar a decisão.
		}
	};

	const report = (error: unknown, phase: 'limits' | 'usage' | 'catalog'): void => {
		// Uma leitura falha não pode envenenar o resto do turno: o próximo
		// candidato tenta de novo, e a falha continua visível no log.
		cachedUsage.clear();
		try {
			options.onFailure?.(error, { phase });
		} catch {
			// Um observador que lança ao reportar uma falha não vira a falha.
		}
	};

	/**
	 * Os limites, lidos a cada decisão.
	 *
	 * Não são guardados em memória: editar um limite precisa valer no turno
	 * seguinte, e a lista é minúscula — reescrevê-la custa menos que servir um
	 * teto antigo. O gasto do período continua com cache, porque é relido a
	 * cada tentativa do mesmo turno.
	 */
	const readLimits = async (): Promise<readonly SpendingLimit[] | undefined> => {
		try {
			return await options.store.listSpendingLimits();
		} catch (error) {
			report(error, 'limits');
			return undefined;
		}
	};

	const usageOf = async (limit: SpendingLimit): Promise<BudgetUsage | undefined> => {
		const range = windowRange(limit.window, now());
		const key = `${limit.limitId}\u0000${range.since}`;
		const cached = cachedUsage.get(key);
		if (cached !== undefined) {
			return cached;
		}
		try {
			const executions = await options.store.listConsumption({
				since: range.since,
				until: range.until,
			});
			const attempts = new Map<string, readonly AttemptRecord[]>();
			for (const execution of executions) {
				attempts.set(execution.executionId, await options.store.listAttempts(execution.executionId));
			}
			const usage = usageFor(executions, (id) => attempts.get(id) ?? [], limit);
			const spent = spendIn(usage.cost, limit.currency);
			const resolved: BudgetUsage =
				spent !== undefined ? { cost: usage.cost, spent } : { cost: usage.cost };
			cachedUsage.set(key, resolved);
			return resolved;
		} catch (error) {
			report(error, 'usage');
			return undefined;
		}
	};

	return {
		reset(): void {
			cachedUsage.clear();
		},

		async check(candidate): Promise<RouterBudgetDecision> {
			if (!options.allowPaid) {
				return { allowed: true };
			}
			const limits = await readLimits();
			if (limits === undefined || limits.length === 0) {
				return { allowed: true };
			}
			// A política em vigor decide quais limites restritos se aplicam.
			// Sem host que a informe, nenhum limite restrito se aplica, e os
			// gerais - a maioria - continuam valendo como antes.
			let policy: ModelAccessPolicy | undefined;
			if (options.policy !== undefined) {
				try {
					policy = await options.policy();
				} catch (error) {
					report(error, 'limits');
				}
			}
			const applicable = limits.filter((limit) => appliesTo(limit, { ...candidate, policy }));
			if (applicable.length === 0) {
				return { allowed: true };
			}

			let access: 'free' | 'paid' | 'unknown' = 'unknown';
			try {
				const entry = await options.store.getModelCatalogEntry(candidate);
				access = entry?.access ?? 'unknown';
			} catch (error) {
				// Sem catálogo o modelo é desconhecido, e desconhecido não é prova
				// de cobrança — a mesma leitura que o seletor faz.
				report(error, 'catalog');
				return { allowed: true };
			}
			// Gratuito nunca passa por limite de orçamento. Desconhecido também
			// não: não se sabe que custa, e bloquear seria tratar "não sei" como
			// "gasta".
			if (access !== 'paid') {
				return { allowed: true };
			}

			// Do escopo mais específico para o mais amplo, para que a mensagem
			// do primeiro bloqueio seja a que melhor explica a decisão.
			const ordered = [...applicable].sort(
				(a, b) => scopeRank(a) - scopeRank(b),
			);
			for (const limit of ordered) {
				const usage = await usageOf(limit);
				if (usage === undefined) {
					continue;
				}
				const decision = evaluateBudget({
					limit,
					candidate: { ...candidate, access, policy },
					usage,
					allowPaid: true,
				});
				if (decision.kind === 'blocked') {
					// The same numbers a `budgetBlocked` event needs, so the
					// host does not recompute the fraction from the message.
					const blocked: RouterBudgetDecision = {
						allowed: false,
						message: budgetMessage(limit, decision),
						alert: budgetAlert({
							limit,
							usage,
							periodStart: windowRange(limit.window, now()).since,
							candidate: { ...candidate, access },
						}),
					};
					observe(candidate, applicable, blocked);
					return blocked;
				}
			}
			observe(candidate, applicable, { allowed: true });
			return { allowed: true };
		},

		/**
		 * A previsão do próximo turno.
		 *
		 * Lê o preço do catálogo e as saídas que o ledger já registrou para este
		 * modelo — nesta conversa e nas outras. Nenhuma das duas leituras pode
		 * derrubar o turno: uma falha vira `undefined` e a tela mostra "sem
		 * previsão", que é diferente de "custa zero".
		 */
		async preview(candidate, promptText, conversationId) {
			return previewFor(candidate, promptText, conversationId, undefined);
		},

		/**
		 * O aviso de 80%, se algum limite aplicável chegou lá.
		 *
		 * Não bloqueia e não chama `check`: um aviso perto do teto e uma
		 * chamada que ainda cabe são fatos diferentes, e misturá-los faria a
		 * UI anunciar um veto que não houve.
		 */
		async alert(candidate) {
			const limits = await readLimits();
			if (limits === undefined || limits.length === 0) {
				return undefined;
			}
			// A classificação do modelo só importa quando há um modelo; um aviso
			// sobre um limite de escopo fala do gasto do período, que só existe
			// porque algum modelo pago o produziu.
			let access: 'free' | 'paid' | 'unknown' = 'paid';
			if (candidate.providerId.length > 0 && candidate.modelId.length > 0) {
				try {
					access = (await options.store.getModelCatalogEntry(candidate))?.access ?? 'unknown';
				} catch (error) {
					report(error, 'catalog');
					return undefined;
				}
			}
			if (access !== 'paid') {
				return undefined;
			}
			const applicable = limits
				.filter(
					(limit) =>
						(limit.providerId === undefined || limit.providerId === candidate.providerId) &&
						(limit.modelId === undefined || limit.modelId === candidate.modelId),
				)
				.sort((a, b) => scopeRank(a) - scopeRank(b));
			for (const limit of applicable) {
				const usage = await usageOf(limit);
				if (usage === undefined) {
					continue;
				}
				const alert = budgetAlert({
					limit,
					usage,
					periodStart: windowRange(limit.window, now()).since,
					candidate: { ...candidate, access },
				});
				if (alert !== undefined) {
					return alert;
				}
			}
			return undefined;
		},
	};

	/**
	 * A previsão de uma chamada, lendo só o necessário.
	 *
	 * As amostras vêm do ledger, não de um contador em memória: `listAttempts`
	 * devolve o que cada tentativa publicou, e a mediana dessas leituras é o
	 * que sustenta a estimativa de saída. Ausentes quando nada foi medido — e a
	 * previsão então é desconhecida, nunca zero.
	 */
	async function previewFor(
		candidate: { readonly providerId: string; readonly modelId: string },
		promptText: string,
		conversationId: string | undefined,
		prefetched: Awaited<ReturnType<BudgetStore['getModelCatalogEntry']>> | undefined,
	): Promise<CallForecast | undefined> {
		let entry = prefetched;
		if (entry === undefined) {
			try {
				entry = await options.store.getModelCatalogEntry(candidate);
			} catch (error) {
				report(error, 'catalog');
				return undefined;
			}
		}
		let modelSamples: readonly ForecastSample[] = [];
		let conversationSamples: readonly ForecastSample[] = [];
		// O preço em vigor. O host pode ter uma escolha a fazer (o do
		// usuário ou o do provedor); sem host, vale o do catálogo.
		let pricing: ModelPricing | undefined = entry?.pricing;
		if (options.pricing !== undefined) {
			try {
				pricing = await options.pricing(candidate);
			} catch (error) {
				report(error, 'catalog');
				pricing = entry?.pricing;
			}
		}
		try {
			const executions = await options.store.listConsumption(
				conversationId !== undefined ? { conversationId } : {},
			);
			const scoped = conversationId !== undefined
				? executions
				: executions.slice(0, CONVERSATION_LOOKBACK);
			for (const execution of scoped) {
				// Uma conversa explícita só contribui para a previsão daquela
				// conversa; sem ela, o histórico recente do modelo serve de
				// referência para todas, mas nunca como amostra desta conversa.
				const inConversation =
					conversationId !== undefined && execution.conversationId === conversationId;
				const attempts = await options.store.listAttempts(execution.executionId);
				for (const attempt of attempts) {
					if (attempt.providerId !== candidate.providerId || attempt.modelId !== candidate.modelId) {
						continue;
					}
					const sample = sampleOf(attempt);
					if (sample === undefined) {
						continue;
					}
					if (modelSamples.length < MAX_SAMPLES) {
						modelSamples = [...modelSamples, sample];
					}
					if (inConversation) {
						conversationSamples = [...conversationSamples, sample];
					}
				}
			}
		} catch (error) {
			report(error, 'usage');
			// Uma falha ao ler o histórico não muda o que já foi lido: o
			// resultado será "saída desconhecida" quando nada chegou, que é a
			// resposta honesta.
		}
		return forecastCall({
			providerId: candidate.providerId,
			modelId: candidate.modelId,
			access: entry?.access ?? 'unknown',
			...(pricing !== undefined
				? {
						pricing: {
							currency: pricing.currency,
							unit: pricing.unit,
							...(pricing.input !== undefined ? { input: pricing.input } : {}),
							...(pricing.output !== undefined ? { output: pricing.output } : {}),
						},
					}
				: {}),
			promptText,
			conversationSamples,
			modelSamples,
		});
	}
}

/** Leitura de saída mais recente de uma tentativa, para a previsão. */
function sampleOf(attempt: AttemptRecord): ForecastSample | undefined {
	const tokens = attempt.reportedTokens ?? attempt.estimatedTokens;
	if (tokens?.output === undefined) {
		return undefined;
	}
	return {
		...(tokens.input !== undefined ? { inputTokens: tokens.input } : {}),
		outputTokens: tokens.output,
	};
}

/** Quantas saídas medidas sustentam a previsão do modelo. */
const MAX_SAMPLES = 20;

/** Quantas execuções recentes olhar quando a conversa não é conhecida. */
const CONVERSATION_LOOKBACK = 200;

function scopeRank(limit: SpendingLimit): number {
	// A precedência é do Core: `model > provider > policy > global`. Aqui
	// ela serve só para ordenar qual bloqueio explica melhor a decisão — todos
	// os limites aplicáveis são avaliados, e basta um bloquear para bloquear.
	return LIMIT_SCOPE_PRECEDENCE.indexOf(scopeOf(limit));
}
