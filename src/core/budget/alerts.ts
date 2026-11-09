/**
 * Avisos de orçamento: quando um limite chega a 80%.
 *
 * ## O que um aviso é
 *
 * Um fato sobre um limite num período: "este limite, nesta janela, já gastou
 * 80% ou mais do seu teto, e do saldo restante um modelo pago custa mais do
 * que sobra". Ele não bloqueia nada — o bloqueio é da 5B e continua sendo
 * decidido por `evaluateBudget` sobre o gasto **registrado** — e não estima
 * nem desconta o futuro.
 *
 * ## Por que não repetir a cada mensagem
 *
 * O aviso é endereçado por `(limite, início do período, moeda, teto)`. Enquanto
 * nada disso mudar, a mesma condição continua verdadeira e um segundo aviso
 * não informa nada novo: só faz ruído. Editar o teto, virar o dia/mês ou mudar
 * a moeda cria um endereço novo, e o aviso volta a ser permitido.
 *
 * ## Por que nunca avisa com custo desconhecido
 *
 * Um período cujo gasto não pôde ser precificado tem 0%? Tem 100%? Ninguém
 * sabe. Dizer "80% gasto" ali seria inventar o numerador; a 5B já registra a
 * incerteza como `unknown`, e o aviso fica calado.
 *
 * ## Por que não avisa de modelo gratuito
 *
 * A 5B não bloqueia gratuito, porque ele não gasta. Avisar sobre um saldo que
 * um modelo gratuito não consome seria um alarme falso.
 */
import type { BudgetUsage, LimitScope, SpendingLimit, SpendingLimitScope } from './policy';
import { scopeOf } from './policy';

/** A partir de que fração do teto um aviso é gerado. */
export const BUDGET_ALERT_THRESHOLD = 0.8;

/** Um aviso, com os números que o justificam. */
export interface BudgetAlert {
	readonly limitId: string;
	readonly scope: LimitScope;
	readonly providerId?: string;
	readonly modelId?: string;
	readonly window: 'day' | 'month';
	/** Início do período que o aviso descreve. */
	readonly periodStart: string;
	readonly currency: string;
	readonly amount: number;
	readonly spent: number;
	/** Fração gasta, entre 0 e 1 ou mais. */
	readonly fraction: number;
	readonly key: string;
	readonly message: string;
}

export interface BudgetAlertInput {
	readonly limit: SpendingLimit;
	readonly usage: BudgetUsage;
	readonly periodStart: string;
	/** O modelo que o usuário está tentando usar, para a mensagem. */
	readonly candidate: { readonly providerId: string; readonly modelId: string; readonly access?: string };
}

function formatAmount(amount: number): string {
	return amount.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

function percent(fraction: number): string {
	return `${Math.round(fraction * 100)}%`;
}

/** A chave estável: o que precisa mudar para o aviso voltar a valer. */
export function alertKey(limit: SpendingLimit, periodStart: string): string {
	return `${limit.limitId}\u0000${periodStart}\u0000${limit.currency}\u0000${limit.amount}`;
}

/** Rótulos do escopo, para a mensagem e para os lugares que a repetem. */
export function scopeLabel(limit: SpendingLimitScope): string {
	const scope = scopeOf(limit);
	if (scope === 'global') {
		return 'geral';
	}
	return scope === 'provider'
		? `do provedor ${limit.providerId ?? ''}`
		: `do modelo ${limit.providerId ?? ''}/${limit.modelId ?? ''}`;
}

/**
 * O aviso de 80%, quando houver.
 *
 * `undefined` quando o limite não chegou a 80%, quando o gasto é desconhecido
 * ou quando o modelo não é pago — os três casos em que um aviso inventaria
 * informação.
 */
export function budgetAlert(input: BudgetAlertInput): BudgetAlert | undefined {
	const { limit, usage, periodStart, candidate } = input;
	if (candidate.access !== 'paid') {
		return undefined;
	}
	if (usage.spent === undefined || limit.amount <= 0) {
		return undefined;
	}
	const fraction = usage.spent / limit.amount;
	if (fraction < BUDGET_ALERT_THRESHOLD) {
		return undefined;
	}
	const scope = scopeOf(limit);
	const where =
		scope === 'global'
			? 'geral'
			: scope === 'provider'
				? `do provedor ${limit.providerId ?? ''}`
				: `do modelo ${limit.providerId ?? ''}/${limit.modelId ?? ''}`;
	const window = limit.window === 'day' ? 'diário' : 'mensal';
	const blocked = usage.spent >= limit.amount;
	return {
		limitId: limit.limitId,
		scope,
		...(limit.providerId !== undefined ? { providerId: limit.providerId } : {}),
		...(limit.modelId !== undefined ? { modelId: limit.modelId } : {}),
		window: limit.window,
		periodStart,
		currency: limit.currency,
		amount: limit.amount,
		spent: usage.spent,
		fraction,
		key: alertKey(limit, periodStart),
		message: blocked
			? `Orçamento ${window} ${where} esgotado: ${formatAmount(usage.spent)} de ${formatAmount(limit.amount)} ${limit.currency} (${percent(fraction)}). Modelos pagos serão bloqueados.`
			: `Orçamento ${window} ${where} em ${percent(fraction)}: ${formatAmount(usage.spent)} de ${formatAmount(limit.amount)} ${limit.currency}. O restante é ${formatAmount(Math.max(0, limit.amount - usage.spent))} ${limit.currency}.`,
	};
}

/**
 * Quais avisos ainda não foram dados nesta sessão.
 *
 * Uma chave já vista é a mesma condição: não é anunciada de novo até mudar o
 * período, o limite ou a moeda. O conjunto vive na sessão de propósito — um
 * aviso é sobre o agora enquanto o usuário está trabalhando, e persistir
 * "já avisei" faria um app reaberto ficar em silêncio sobre um orçamento que
 * ele nunca mostrou.
 */
export class BudgetAlertLog {
	private readonly seen = new Set<string>();

	/** Verdadeiro quando este aviso é a primeira vez desta condição. */
	claim(alert: BudgetAlert): boolean {
		if (this.seen.has(alert.key)) {
			return false;
		}
		this.seen.add(alert.key);
		return true;
	}

	/** Se esta condição já foi anunciada. */
	has(alert: BudgetAlert): boolean {
		return this.seen.has(alert.key);
	}

	/** Quantas condições distintas já foram anunciadas. */
	get size(): number {
		return this.seen.size;
	}
}
