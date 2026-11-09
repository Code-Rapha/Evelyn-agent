/**
 * Cotas e limites de uso: o que cada fonte realmente informa.
 *
 * ## Seis origens, nunca fundidas
 *
 * O enunciado da etapa pede que seis coisas diferentes nunca sejam
 * apresentadas como a mesma:
 *
 * 1. `published` — limite oficial publicado pelo provedor (documentação).
 * 2. `account`   — limite que a API informou para esta conta/chave.
 * 3. `usage`     — o que a própria Evelyn contabilizou.
 * 4. `estimate`  — dedução local a partir de `usage` e de um limite conhecido.
 * 5. `observed`  — limite visto em teste (um `429` real).
 * 6. `unknown`   — nada disso.
 *
 * O tipo abaixo torna impossível *apresentar* uma estimativa como oficial: cada
 * número carrega a origem de que veio, e quem lê escolhe o que mostrar. O
 * módulo nunca converte uma origem na outra.
 *
 * ## Escopo só quando conhecido
 *
 * Não se presume que todo limite seja por chave, por modelo ou por minuto.
 * Um cabeçalho `x-ratelimit-*` do endpoint de chat fala daquela requisição; o
 * escopo (`api-key`, `provider`, `model`) só é registrado quando a fonte o diz.
 *
 * ## Só formatos documentados
 *
 * Os cabeçalhos lidos são os que aparecem em respostas reais de serviços
 * compatíveis: `retry-after`, `x-ratelimit-limit/remaining/reset` e as
 * variantes por token (`x-ratelimit-limit-tokens`, …), além das versões
 * prefixadas por nome de recurso (`x-ratelimit-limit-requests`). Qualquer
 * outro cabeçalho é ignorado.
 */

/** Uma medida de cota e de onde ela veio. */
export interface QuotaMeasure {
	readonly value: number;
	readonly source: QuotaSource;
}

export type QuotaSource = 'published' | 'account' | 'usage' | 'estimate' | 'observed' | 'unknown';

/** O que a cota limita. Ausente = o cabeçalho não diz. */
export type QuotaScope = 'api-key' | 'provider' | 'model' | 'account';

/** A janela de uma cota, quando a fonte a declara. */
export type QuotaWindow = 'minute' | 'hour' | 'day' | 'month' | 'second';

/** Um limite com a sua janela, só quando ambos são conhecidos. */
export interface QuotaLimit {
	readonly limit: QuotaMeasure;
	readonly window?: QuotaWindow;
	readonly resetAt?: string;
	readonly scope?: QuotaScope;
	/** O que é contado: requisições ou tokens. */
	readonly kind: 'requests' | 'tokens' | 'unknown';
	/** Quando o cabeçalho não deixa claro o que conta (tokens de entrada/saída). */
	readonly direction?: 'input' | 'output' | 'total';
}

/** O que se conhece de uma cota num instante. */
export interface QuotaState {
	readonly limit?: QuotaLimit;
	readonly remaining?: QuotaMeasure;
	/** Quando a janela reinicia, quando informado (ISO-8601). */
	readonly resetAt?: string;
	/** `Retry-After` em milissegundos, quando informado. */
	readonly retryAfterMs?: number;
	/** Origem do conjunto; cada medida ainda carrega a sua. */
	readonly source: QuotaSource;
}

const UNITS_MS: Readonly<Record<string, number>> = {
	per_second: 1_000,
	second: 1_000,
	per_minute: 60_000,
	minute: 60_000,
	per_hour: 3_600_000,
	hour: 3_600_000,
	per_day: 86_400_000,
	day: 86_400_000,
	per_month: 30 * 86_400_000,
	month: 30 * 86_400_000,
};

function headerValue(headers: Readonly<Record<string, string>>, name: string): string | undefined {
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === name) {
			return value;
		}
	}
	return undefined;
}

function integerHeader(headers: Readonly<Record<string, string>>, name: string): number | undefined {
	const raw = headerValue(headers, name);
	if (raw === undefined) {
		return undefined;
	}
	const trimmed = raw.trim();
	if (!/^\d+(?:\.\d+)?$/.test(trimmed)) {
		return undefined;
	}
	const value = Number(trimmed);
	return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Lê `Retry-After`, nos dois formatos do protocolo: segundos ou data HTTP.
 *
 * `now` é injetado para que a data absoluta seja medida no relógio do host. Um
 * valor que não é nenhum dos dois é ausente: inventar um atraso faria o
 * roteador esperar por um número que ninguém publicou.
 */
export function parseRetryAfter(raw: string | undefined, now: number): number | undefined {
	if (raw === undefined) {
		return undefined;
	}
	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		return undefined;
	}
	if (/^\d+$/.test(trimmed)) {
		// `0` é legítimo: "pode tentar já". Não é o mesmo que ausente.
		return Number(trimmed) * 1_000;
	}
	const at = Date.parse(trimmed);
	if (Number.isNaN(at)) {
		return undefined;
	}
	return Math.max(0, at - now);
}

/** Uma janela declarada no cabeçalho (`per-minute`, `minute`, …), quando dita. */
function readWindow(headers: Readonly<Record<string, string>>): QuotaWindow | undefined {
	const raw = headerValue(headers, 'x-ratelimit-window') ?? headerValue(headers, 'x-ratelimit-window-type');
	if (raw === undefined) {
		return undefined;
	}
	const key = raw.trim().toLowerCase();
	switch (key) {
		case 'second':
		case 'per_second':
			return 'second';
		case 'minute':
		case 'per_minute':
			return 'minute';
		case 'hour':
		case 'per_hour':
			return 'hour';
		case 'day':
		case 'per_day':
			return 'day';
		case 'month':
		case 'per_month':
			return 'month';
		default:
			return undefined;
	}
}

function readReset(
	headers: Readonly<Record<string, string>>,
	now: number,
): { readonly resetAt?: string; readonly retryAfterMs?: number } {
	const raw = headerValue(headers, 'x-ratelimit-reset');
	if (raw === undefined) {
		return {};
	}
	const trimmed = raw.trim();
	// Formato documentado: segundos até o reset (alguns servidores usam epoch).
	const seconds = Number(trimmed);
	if (!Number.isFinite(seconds) || seconds < 0) {
		return {};
	}
	const epoch = seconds > 1e9 ? seconds : now / 1_000 + seconds;
	const at = new Date(epoch * 1_000);
	if (Number.isNaN(at.getTime())) {
		return {};
	}
	return { resetAt: at.toISOString(), retryAfterMs: Math.max(0, at.getTime() - now) };
}

/**
 * Lê a cota informada nos cabeçalhos de uma resposta do provedor.
 *
 * Origem `account`: é o que a API disse sobre esta credencial naquele momento.
 * Um cabeçalho ausente não vira "sem limite" — fica ausente.
 */
export function readQuotaHeaders(
	headers: Readonly<Record<string, string>>,
	now: number,
): QuotaState | undefined {
	const requestsLimit = integerHeader(headers, 'x-ratelimit-limit-requests');
	const requestsRemaining = integerHeader(headers, 'x-ratelimit-remaining-requests');
	const tokensLimit =
		integerHeader(headers, 'x-ratelimit-limit-tokens') ?? integerHeader(headers, 'x-ratelimit-limit');
	const tokensRemaining =
		integerHeader(headers, 'x-ratelimit-remaining-tokens') ?? integerHeader(headers, 'x-ratelimit-remaining');
	const retryAfter = parseRetryAfter(headerValue(headers, 'retry-after'), now);
	const reset = readReset(headers, now);
	const window = readWindow(headers);

	if (
		requestsLimit === undefined &&
		requestsRemaining === undefined &&
		tokensLimit === undefined &&
		tokensRemaining === undefined &&
		retryAfter === undefined &&
		reset.resetAt === undefined
	) {
		return undefined;
	}

	// O limite principal é o de requisições quando ambos existem: é o que o
	// roteador usa para decidir "tentar outra vez agora" contra "esperar".
	const limitValue = requestsLimit ?? tokensLimit;
	const remainingValue = requestsRemaining ?? tokensRemaining;
	const kind: QuotaLimit['kind'] =
		requestsLimit !== undefined || requestsRemaining !== undefined
			? 'requests'
			: tokensLimit !== undefined || tokensRemaining !== undefined
				? 'tokens'
				: 'unknown';

	return {
		source: 'account',
		...(limitValue !== undefined
			? {
					limit: {
						limit: { value: limitValue, source: 'account' },
						kind,
						...(window !== undefined ? { window } : {}),
						...(reset.resetAt !== undefined ? { resetAt: reset.resetAt } : {}),
					},
				}
			: {}),
		...(remainingValue !== undefined
			? { remaining: { value: remainingValue, source: 'account' } }
			: {}),
		...(reset.resetAt !== undefined ? { resetAt: reset.resetAt } : {}),
		...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}),
	};
}

/** A duração de uma janela, quando conhecida. `undefined` para `month` genérico. */
export function windowMs(window: QuotaWindow | undefined): number | undefined {
	return window === undefined ? undefined : UNITS_MS[`per_${window}`];
}
