/**
 * Limites de consumo locais e a decisão de gastar.
 *
 * ## O que um limite é
 *
 * Um teto em uma moeda para uma janela (`day` ou `month`), aplicável ao
 * consumo inteiro (escopo global) ou a um provedor/modelo. Ele nunca é um saldo
 * mantido à parte: o gasto é sempre **consultado** no registro de consumo no
 * momento da decisão, para que apagar o ledger não vire "orçamento livre" e
 * para que não exista um segundo número que possa divergir do primeiro.
 *
 * ## As três respostas
 *
 * - `allow` — o gasto cabe no limite.
 * - `unknown` — não há como saber: o consumo do período não foi precificado
 *   (preço ausente, ou alguma execução sem custo conhecido). **Não bloqueia.**
 *   Bloquear por falta de dado transformaria um preço que o usuário não
 *   cadastrou em um bloqueio permanente do app; deixar passar registra a
 *   verdade: não sabemos, e o limite não foi aplicado.
 * - `blocked` — o consumo conhecido do período já atingiu o teto.
 *
 * ## Modelo gratuito nunca é bloqueado por engano
 *
 * A decisão de bloquear só é tomada para um modelo **pago** (`access: 'paid'`).
 * Gratuito não consome orçamento, e desconhecido não é evidência de cobrança —
 * a mesma regra que a seleção de modelos já usa. Além disso, o bloqueio só
 * existe quando há `allowPaid: true`: sem essa autorização, a decisão de não
 * usar pago já foi tomada antes, e este módulo não tem nada a acrescentar.
 *
 * ## Limites não são uma fatura
 *
 * Um consumo `estimated` é o preço do catálogo aplicado aos tokens que o
 * provedor publicou. O limite compara dois números dessa mesma espécie; ele não
 * promete que a cobrança real será igual.
 */
import type { AttemptCost } from '../storage/types/consumption';
import type { ModelAccess } from '../storage/types/modelCatalog';
import type { ModelAccessPolicy } from '../catalog/policy';

/**
 * Onde um limite vale. Ausente = global.
 *
 * ## O escopo de política
 *
 * `policy` restringe o limite a uma política de acesso. Um limite sem `policy`
 * vale para todas — é o limite geral, e é o que existia antes desta etapa.
 *
 * A chave do escopo inclui a política, para que salvar um limite de
 * `free_only` **não** substitua o limite geral: são tetos diferentes, para
 * Situações diferentes, e um teto que substitui o outro faria o usuário
 * acreditar que tinha dois tetos quando tem um.
 */
export interface SpendingLimitScope {
	readonly providerId?: string;
	readonly modelId?: string;
	/** A política de acesso a que o limite se restringe. Ausente = todas. */
	readonly policy?: ModelAccessPolicy;
}

/**
 * Um limite persistido.
 *
 * Um limite por escopo: salvar o mesmo escopo substitui o anterior em vez de
 * criar um segundo teto para a mesma coisa.
 */
export interface SpendingLimit extends SpendingLimitScope {
	readonly limitId: string;
	/** Código da moeda, como no catálogo. Nunca convertida. */
	readonly currency: string;
	/** Teto do período. Zero é um limite válido: nada pode ser gasto. */
	readonly amount: number;
	readonly window: 'day' | 'month';
	readonly createdAt: string;
	readonly updatedAt: string;
}

/** O que o chamador entrega para criar ou trocar um limite. */
export interface SaveSpendingLimitInput extends SpendingLimitScope {
	readonly limitId?: string;
	readonly currency: string;
	readonly amount: number;
	readonly window: 'day' | 'month';
}

/** O gasto conhecido de um período, em uma moeda. */
export interface BudgetUsage {
	/** `estimated` somente quando todo o consumo contado foi precificado. */
	readonly cost: AttemptCost;
	/**
	 * Gasto conhecido na moeda do limite, quando há como medi-lo. Ausente
	 * quando o período não tem consumo precificado naquela moeda.
	 */
	readonly spent?: number;
}

/** O que o host sabe sobre o modelo antes de decidir. */
export interface BudgetCandidate {
	readonly providerId: string;
	readonly modelId: string;
	/** Como o catálogo classifica o acesso. Ausente = desconhecido. */
	readonly access?: ModelAccess;
	/**
	 * A política de acesso em vigor.
	 *
	 * É o que decide se um limite restrito a `free_only` se aplica. Ausente =
	 * nenhuma política específica, e os limites restritos não se aplicam.
	 */
	readonly policy?: ModelAccessPolicy;
}

/** A decisão, com o motivo em forma legível para a UI. */
export type BudgetDecision =
	| { readonly kind: 'allow'; readonly reason: string }
	| { readonly kind: 'unknown'; readonly reason: string; readonly limitId?: string }
	| {
			readonly kind: 'blocked';
			readonly limitId: string;
			readonly scope: LimitScope;
			readonly currency: string;
			readonly amount: number;
			readonly spent: number;
			readonly window: 'day' | 'month';
			readonly reason: string;
	  };

/** Um limite pronto para avaliar: o gasto do seu período, já medido. */
export interface BudgetEvaluationInput {
	readonly limit: SpendingLimit;
	readonly candidate: BudgetCandidate;
	readonly usage: BudgetUsage;
	readonly allowPaid: boolean;
}

/** O escopo de um limite, como rótulo. */
export function scopeOf(limit: SpendingLimitScope): LimitScope {
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

/** Os escopos possíveis, do mais específico ao mais amplo. */
export type LimitScope = 'model' | 'provider' | 'policy' | 'global';

/**
 * A precedência entre escopos, do mais específico ao mais amplo.
 *
 * Um limite mais específico é o que explica melhor a decisão, e é o que a
 * tela mostra. Mas a precedência **não** é permissão: todos os limites
 * aplicáveis são avaliados, e basta um bloquear para bloquear.
 */
export const LIMIT_SCOPE_PRECEDENCE: readonly LimitScope[] = ['model', 'provider', 'policy', 'global'];

/**
 * Se um limite se aplica a um modelo.
 *
 * `candidate.policy` é a política **em vigor** no momento da decisão. Um
 * limite com `policy` só vale quando ela coincide com a em vigor; um limite
 * sem `policy` vale sempre.
 */
export function appliesTo(
	limit: SpendingLimitScope,
	candidate: { readonly providerId: string; readonly modelId: string; readonly policy?: ModelAccessPolicy },
): boolean {
	if (limit.providerId !== undefined && limit.providerId !== candidate.providerId) {
		return false;
	}
	if (limit.modelId !== undefined && limit.modelId !== candidate.modelId) {
		return false;
	}
	if (limit.policy !== undefined && limit.policy !== candidate.policy) {
		return false;
	}
	return true;
}

/** O `limitId` estável de um escopo, para que salvar de novo substitua. */
export function scopeIdFor(scope: SpendingLimitScope): string {
	const policy = scope.policy === undefined ? '' : `:${scope.policy}`;
	if (scope.modelId !== undefined) {
		return `model:${scope.providerId ?? ''}:${scope.modelId}${policy}`;
	}
	if (scope.providerId !== undefined) {
		return `provider:${scope.providerId}${policy}`;
	}
	if (scope.policy !== undefined) {
		return `policy:${scope.policy}`;
	}
	return 'global';
}

const WINDOW_LABEL: Readonly<Record<SpendingLimit['window'], string>> = {
	day: 'do dia',
	month: 'do mês',
};

function formatAmount(amount: number): string {
	return amount.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

/**
 * Se um modelo pode ser chamado sob os limites.
 *
 * `usage.spent` ausente é "não medido", e não medido nunca vira bloqueio.
 */
export function evaluateBudget(input: BudgetEvaluationInput): BudgetDecision {
	const { limit, candidate, usage, allowPaid } = input;
	// Sem autorização de gasto, a resposta a "pode usar pago?" já foi dada em
	// outro lugar; bloquear aqui de novo produziria uma mensagem falsa (o
	// bloqueio não foi o orçamento) e impediria a decisão de `allowPaid` de
	// ser a única.
	if (!allowPaid) {
		return { kind: 'allow', reason: 'paid usage is not authorized; the budget does not decide it' };
	}
	// Só pago é limitado. Gratuito não gasta; desconhecido não é prova de gasto.
	if (candidate.access !== 'paid') {
		return { kind: 'allow', reason: 'the model is not declared as paid' };
	}
	const label = `${candidate.providerId}/${candidate.modelId}`;
	if (usage.spent === undefined) {
		return {
			kind: 'unknown',
			reason:
				`o consumo do período não tem custo conhecido em ${limit.currency}, então o limite de ` +
				`${formatAmount(limit.amount)} ${limit.currency} ${WINDOW_LABEL[limit.window]} não pôde ser verificado ` +
				'e não foi aplicado',
			limitId: limit.limitId,
		};
	}
	if (usage.spent >= limit.amount) {
		return {
			kind: 'blocked',
			limitId: limit.limitId,
			scope: scopeOf(limit),
			currency: limit.currency,
			amount: limit.amount,
			spent: usage.spent,
			window: limit.window,
			reason:
				`o limite ${WINDOW_LABEL[limit.window]} de ${formatAmount(limit.amount)} ${limit.currency} ` +
				`foi atingido (gasto estimado ${formatAmount(usage.spent)} ${limit.currency}); ` +
				`${label} não foi chamado`,
		};
	}
	return { kind: 'allow', reason: 'within the budget' };
}

/**
 * O limite mais restritivo que um modelo encontra, dados vários limites.
 *
 * Um bloqueio vence um desconhecido, que vence um permitido: se qualquer limite
 * aplicável diz "não", a resposta é não. Entre vários bloqueios, o de escopo
 * mais específico é o que explica melhor a decisão.
 */
export function evaluateBudgets(
	limits: readonly SpendingLimit[],
	candidate: BudgetCandidate,
	evaluate: (limit: SpendingLimit) => BudgetUsage,
	allowPaid: boolean,
): BudgetDecision {
	const applicable = limits
		.filter((limit) => appliesTo(limit, candidate))
		.sort(
			(a, b) => LIMIT_SCOPE_PRECEDENCE.indexOf(scopeOf(a)) - LIMIT_SCOPE_PRECEDENCE.indexOf(scopeOf(b)),
		);
	let unknown: BudgetDecision | undefined;
	for (const limit of applicable) {
		const decision = evaluateBudget({ limit, candidate, usage: evaluate(limit), allowPaid });
		if (decision.kind === 'blocked') {
			return decision;
		}
		if (decision.kind === 'unknown' && unknown === undefined) {
			unknown = decision;
		}
	}
	return unknown ?? { kind: 'allow', reason: applicable.length === 0 ? 'no limit applies' : 'within the budget' };
}
