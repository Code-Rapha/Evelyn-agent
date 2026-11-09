/**
 * Fusão do preço declarado pelo usuário com o preço publicado pelo provedor.
 *
 * ## As três regras
 *
 * 1. **Nada é substituído sozinho.** O resultado diz qual lado está em vigor
 *    (`selected`) e qual lado está à vista (`offered`). Trocar de lado é uma
 *    decisão do usuário, gravada, e o valor declarado nunca é reescrito: voltar
 *    atrás é só apontar `selected` de novo para `user`.
 * 2. **Ausente não é zero.** Preço sem valor é `unknown`, e `unknown` nunca
 *    entra como `0` em lugar nenhum.
 * 3. **Moedas e unidades não se misturam.** Um preço em `USD per_1m_tokens` e
 *    outro em `EUR per_1k_tokens` não têm como ser comparados sem uma conversão
 *    que ninguém autorizou. Nesse caso a fusão recusa (`comparable: false`) e
 *    cada lado permanece exibível, sozinho.
 *
 * ## Por que aqui, e não no adapter
 *
 * É aritmética sobre dois valores datados. Nenhum I/O, nenhum relógio próprio:
 * `nowMs` entra como argumento, então um teste pode perguntar "o que o usuário
 * via em 23 de outubro às 10h" e receber exatamente aquilo.
 */
import type { ModelPricing, PriceSource } from '../storage/types/modelCatalog';

/** De que lado o preço em vigor está. */
export type PriceSide = 'user' | 'discovered';

/** O preço declarado, como o catálogo o guarda. */
export interface DeclaredPrice {
	readonly pricing: ModelPricing;
	/** Quando o usuário salvou este valor, se o catálogo sabe. */
	readonly updatedAt?: string;
}

/** O preço publicado, com a procedência que a descoberta registrou. */
export interface DiscoveredPriceOffer {
	readonly pricing: ModelPricing;
	readonly source: PriceSource | 'account';
	readonly verifiedAt: string;
	readonly expiresAt: string;
	readonly stale: boolean;
}

/** O preço que vale para o cálculo, com a origem que o sustenta. */
export interface EffectivePrice {
	readonly side: PriceSide;
	readonly pricing: ModelPricing;
	readonly origin: PriceSource | 'account';
	/** O que o usuário vê ao lado, e por quê. */
	readonly reason: string;
}

/** Como cada lado é exibido, inclusive quando não pode ser comparado. */
export interface PriceComparison {
	readonly user?: DeclaredPrice;
	readonly discovered?: DiscoveredPriceOffer;
	/** Mesma moeda e mesma unidade: os dois números podem ser lidos juntos. */
	readonly comparable: boolean;
	/** Por que não é comparável, quando não é. Vazio quando é. */
	readonly incompatibleReason?: string;
	/** O lado escolhido pelo usuário, quando ele escolheu e é possível. */
	readonly selected?: PriceSide;
	/** `selected` caiu para o lado declarado porque o escolhido não serve mais. */
	readonly fellBack: boolean;
}

const SIDE_NAMES: Readonly<Record<PriceSide, string>> = {
	user: 'o seu preço',
	discovered: 'o preço do provedor',
};

function isEmptyPrice(pricing: ModelPricing): boolean {
	return pricing.input === undefined && pricing.output === undefined && pricing.cachedInput === undefined;
}

/**
 * Se dois preços podem ser lidos juntos.
 *
 * A moeda é comparada sem diferença de caixa (`usd` e `USD` são a mesma), e a
 * unidade tem de ser idêntica: um valor por milhão não é o mesmo número que um
 * valor por mil. Não há conversão; converter seria inventar uma taxa de câmbio
 * e uma regra que o usuário não pediu.
 */
export function pricesComparable(
	user: ModelPricing,
	discovered: ModelPricing,
): { readonly comparable: boolean; readonly reason?: string } {
	if (user.currency.trim().toUpperCase() !== discovered.currency.trim().toUpperCase()) {
		return {
			comparable: false,
			reason: `moedas distintas (${user.currency} e ${discovered.currency}); não há conversão`,
		};
	}
	if (user.unit !== discovered.unit) {
		return {
			comparable: false,
			reason: `unidades distintas (${user.unit} e ${discovered.unit}); não há conversão`,
		};
	}
	return { comparable: true };
}

/**
 * Se o preço descoberto pode ser oferecido agora.
 *
 * Um preço vencido continua exibível — é o que o provedor publicou na última
 * vez que respondeu —, mas escolhê-lo **agora** seria usar evidência velha como
 * se fosse atual. `selectable` separa as duas coisas.
 */
export function discoveredPriceState(
	offer: DiscoveredPriceOffer,
	nowMs: number,
): { readonly usable: boolean; readonly expired: boolean; readonly reason?: string } {
	const expiresAt = Date.parse(offer.expiresAt);
	const expired = Number.isNaN(expiresAt) || expiresAt <= nowMs;
	if (offer.stale) {
		return { usable: false, expired, reason: 'a última atualização do provedor falhou' };
	}
	if (expired) {
		return { usable: false, expired, reason: 'a verificação venceu' };
	}
	if (isEmptyPrice(offer.pricing)) {
		return { usable: false, expired, reason: 'o provedor não publicou valor' };
	}
	return { usable: true, expired };
}

/**
 * Compara os dois lados e diz qual vale.
 *
 * `chosen` é o que o usuário pediu. Ele nunca é honrado às cegas:
 *
 * - pedir o lado declarado sempre funciona (é o padrão e é o que ele digitou);
 * - pedir o descoberto exige que ele exista, esteja fresco e seja comparável
 *   com o declarado — caso contrário, o declarado vale e `fellBack` diz por quê;
 * - sem escolha, vale o declarado. Nada troca de lado sozinho.
 */
export function comparePrices(input: {
	readonly user?: DeclaredPrice;
	readonly discovered?: DiscoveredPriceOffer;
	readonly chosen?: PriceSide;
	readonly nowMs: number;
}): {
	readonly comparison: PriceComparison;
	readonly effective?: EffectivePrice;
} {
	const { user, discovered, chosen, nowMs } = input;
	const discoveryState = discovered === undefined ? undefined : discoveredPriceState(discovered, nowMs);

	let comparable = false;
	let incompatibleReason: string | undefined;
	if (user !== undefined && discovered !== undefined) {
		const check = pricesComparable(user.pricing, discovered.pricing);
		comparable = check.comparable;
		incompatibleReason = check.reason;
	}

	const comparison = (
		side: PriceSide | undefined,
		fellBack: boolean,
	): PriceComparison => ({
		...(user !== undefined ? { user } : {}),
		...(discovered !== undefined ? { discovered } : {}),
		comparable,
		...(incompatibleReason !== undefined ? { incompatibleReason } : {}),
		...(side !== undefined ? { selected: side } : {}),
		fellBack,
	});

	// O declarado é o padrão. Sem ele, só o descoberto pode valer, e só se
	// puder ser usado agora.
	if (user === undefined) {
		if (discovered !== undefined && discoveryState?.usable === true) {
			return {
				comparison: comparison('discovered', false),
				effective: {
					side: 'discovered',
					pricing: discovered.pricing,
					origin: discovered.source,
					reason: 'não há preço declarado; vale o preço publicado pelo provedor',
				},
			};
		}
		return { comparison: comparison(undefined, false) };
	}

	// A escolha gravada é diferente de "sem escolha", e o teste de frescor roda
	// nos dois casos: um preço descoberto vencido não vale nem quando o usuário
	// o escolheu ontem. `chosen` é repassado como está.
	if (chosen === 'discovered') {
		if (discovered === undefined || discoveryState?.usable !== true || !comparable) {
			return userEffective(comparison('user', true), user);
		}
		return {
			comparison: comparison('discovered', false),
			effective: {
				side: 'discovered',
				pricing: discovered.pricing,
				origin: discovered.source,
				reason: 'você escolheu usar o preço do provedor; o seu continua guardado',
			},
		};
	}

	return userEffective(comparison('user', false), user);
}

/** O declarado vale, com a origem que ele já carrega. */
function userEffective(
	comparison: PriceComparison,
	user: DeclaredPrice,
): { readonly comparison: PriceComparison; readonly effective: EffectivePrice } {
	return {
		comparison,
		effective: {
			side: 'user',
			pricing: user.pricing,
			origin: user.pricing.source ?? 'manual',
			reason: `vale ${SIDE_NAMES.user}`,
		},
	};
}

/**
 * O preço efetivo para o orçamento e para a previsão.
 *
 * Um único ponto de entrada para quem calcula custo: recebe o declarado, o
 * descoberto e a escolha, e devolve o que vale — ou nada. Nada aqui devolve `0`
 * no lugar de um preço ausente.
 */
export function effectivePricing(input: {
	readonly user?: DeclaredPrice;
	readonly discovered?: DiscoveredPriceOffer;
	readonly chosen?: PriceSide;
	readonly nowMs: number;
}): ModelPricing | undefined {
	return comparePrices(input).effective?.pricing;
}
