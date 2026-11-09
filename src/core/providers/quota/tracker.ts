/**
 * Acompanhamento de cota por escopo, com expiração de janela.
 *
 * ## O que este tipo guarda
 *
 * Só fatos datados: "nesta credencial/modelo, às T, a API disse que resta 0 e
 * que a janela reinicia em R". Nada aqui tenta adivinhar o limite que o
 * provedor não informou.
 *
 * ## Esgotado é temporário por construção
 *
 * Um modelo (ou credencial) marcado como esgotado volta a ser elegível quando
 * a janela termina — pelo `resetAt` que a própria API informou, pelo
 * `Retry-After` de um `429`, ou pela janela que o limite declara. Sem nenhuma
 * dessas informações, ele **não** é marcado como esgotado: um erro sem prazo
 * não autoriza bloquear um modelo indefinidamente.
 *
 * ## A memória é curta e não é persistida
 *
 * Isto descreve o "agora" de uma sessão. Reabrir o app não deve fazer o roteador
 * acreditar que uma cota ainda está vazia; o `429` que acontecer de novo
 * reafirma o fato em milissegundos. Por isso o estado vive em memória, e o
 * persistido (no ledger e no catálogo) é outra coisas.
 */
import type { QuotaState, QuotaWindow } from './headers';
import { windowMs } from './headers';

/** Onde a cota se aplica. Campos ausentes = o escopo não é conhecido. */
export interface QuotaScopeKey {
	readonly providerId: string;
	readonly modelId?: string;
	/** Identidade da credencial, quando o provedor limita por chave. Nunca a chave. */
	readonly credentialId?: string;
}

/** Uma chave de estado já normalizada: o escopo menos os campos ausentes. */
export interface QuotaScope {
	readonly providerId: string;
	readonly modelId?: string;
	readonly credentialId?: string;
}

function scopeOf(scope: QuotaScopeKey): QuotaScope {
	return {
		providerId: scope.providerId,
		...(scope.modelId !== undefined ? { modelId: scope.modelId } : {}),
		...(scope.credentialId !== undefined ? { credentialId: scope.credentialId } : {}),
	};
}

/** Um esgotamento, com o instante em que deixa de valer. */
export interface QuotaExhaustion {
	readonly key: string;
	/** O escopo exato, como foi registrado. */
	readonly scope: QuotaScope;
	/** `undefined` = esgotado sem prazo informado; **não** é consultado como bloqueio. */
	readonly untilMs?: number;
	readonly reason: 'retry-after' | 'reset' | 'window';
	/** O que a fonte dizia, para diagnóstico. */
	readonly state?: QuotaState;
}

/** O resultado da consulta, para o roteador. */
export interface QuotaCheck {
	readonly allowed: boolean;
	/** Milissegundos até voltar a ser elegível. Só presente quando esgotado. */
	readonly retryAfterMs?: number;
	readonly reason?: QuotaExhaustion['reason'];
}

export interface QuotaTrackerOptions {
	/** Injetado em testes. */
	readonly now?: () => number;
	/** Janela padrão quando a fonte não diz. Ausente = sem janela padrão. */
	readonly defaultWindow?: QuotaWindow;
}

function keyOf(scope: QuotaScopeKey): string {
	return JSON.stringify([scope.providerId, scope.modelId ?? '', scope.credentialId ?? '']);
}

/**
 * O rastreador.
 *
 * `record` recebe o que a API disse; `check` responde ao roteador. Nunca lança.
 */
export interface QuotaTracker {
	/** Registra o que uma resposta informou sobre uma credencial/modelo. */
	record(scope: QuotaScopeKey, state: QuotaState | undefined, options?: {
		/** Verdadeiro quando a resposta foi um `429`: esgotado agora, com ou sem prazo. */
		readonly exhausted?: boolean;
	}): void;
	/** Se o escopo pode ser chamado agora. Esgotado sem prazo informado é permitido. */
	check(scope: QuotaScopeKey): QuotaCheck;
	/** O esgotamento vigente, para diagnóstico. */
	current(scope: QuotaScopeKey): QuotaExhaustion | undefined;
	/** Todos os esgotamentos vigentes, com escopo. */
	snapshot(): readonly QuotaExhaustion[];
	/** Esquece um escopo (ou todos). */
	clear(scope?: QuotaScopeKey): void;
}

export function createQuotaTracker(options: QuotaTrackerOptions = {}): QuotaTracker {
	const now = options.now ?? (() => Date.now());
	const exhausted = new Map<string, QuotaExhaustion>();

	const untilFrom = (state: QuotaState | undefined): { untilMs?: number; reason?: QuotaExhaustion['reason'] } => {
		if (state?.retryAfterMs !== undefined && state.retryAfterMs > 0) {
			return { untilMs: now() + state.retryAfterMs, reason: 'retry-after' };
		}
		if (state?.resetAt !== undefined) {
			const at = Date.parse(state.resetAt);
			if (!Number.isNaN(at) && at > now()) {
				return { untilMs: at, reason: 'reset' };
			}
		}
		const span = windowMs(state?.limit?.window ?? options.defaultWindow);
		if (span !== undefined) {
			return { untilMs: now() + span, reason: 'window' };
		}
		return {};
	};

	const record: QuotaTracker['record'] = (scope, state, recordOptions = {}) => {
		const key = keyOf(scope);
		const remaining = state?.remaining?.value;
		const empty = remaining !== undefined && remaining <= 0;
		if (!recordOptions.exhausted && !empty) {
			// Uma resposta normal que ainda tem saldo não é esgotamento; se havia
			// um, ele acabou.
			exhausted.delete(key);
			return;
		}
		const { untilMs, reason } = untilFrom(state);
		if (untilMs === undefined && !recordOptions.exhausted) {
			exhausted.delete(key);
			return;
		}
		const exhaustion: QuotaExhaustion = {
			key,
			scope: scopeOf(scope),
			...(untilMs !== undefined ? { untilMs } : {}),
			reason: reason ?? 'retry-after',
			...(state !== undefined ? { state } : {}),
		};
		const previous = exhausted.get(key);
		// Um esgotamento sem prazo novo não encurta um que já tem prazo.
		if (previous?.untilMs !== undefined && untilMs === undefined) {
			return;
		}
		exhausted.set(key, exhaustion);
	};

	const current: QuotaTracker['current'] = (scope) => {
		const key = keyOf(scope);
		const entry = exhausted.get(key);
		if (entry === undefined) {
			return undefined;
		}
		if (entry.untilMs !== undefined && entry.untilMs <= now()) {
			// A janela virou: o fato expirou junto com ela.
			exhausted.delete(key);
			return undefined;
		}
		return entry;
	};

	const check: QuotaTracker['check'] = (scope) => {
		const entry = current(scope);
		if (entry === undefined || entry.untilMs === undefined) {
			// Sem esgotamento, ou sem prazo: um erro sem janela não bloqueia.
			return { allowed: true };
		}
		return {
			allowed: false,
			retryAfterMs: Math.max(0, entry.untilMs - now()),
			reason: entry.reason,
		};
	};

	return {
		record,
		check,
		current,
		snapshot(): readonly QuotaExhaustion[] {
			const live: QuotaExhaustion[] = [];
			for (const entry of [...exhausted.values()]) {
				// Só os que ainda valem e que têm prazo: um esgotamento sem janela
				// informada não é um fato sobre o "agora".
				if (entry.untilMs !== undefined && current(entry.scope) !== undefined) {
					live.push(entry);
				}
			}
			return live;
		},
		clear(scope?: QuotaScopeKey): void {
			if (scope === undefined) {
				exhausted.clear();
				return;
			}
			exhausted.delete(keyOf(scope));
		},
	};
}
