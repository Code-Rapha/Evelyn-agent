/**
 * A fusão do catálogo com a descoberta, como a janela a lê.
 *
 * ## Quatro fatos, nunca fundidos num só
 *
 * 1. **O que o usuário declarou** — preço, acesso e classificação de `models.json`.
 * 2. **O que o provedor publicou** — preço com origem, data de verificação e
 *    validade, de `provider-models.json`.
 * 3. **De que lado o preço vale** — a escolha explícita e, quando ela não pôde
 *    ser honrada, o motivo.
 * 4. **O que pode ser chamado** — a política em vigor e o veredito para este
 *    modelo.
 *
 * O preço "efetivo" só aparece quando há um preço. Quando não há, o campo fica
 * ausente: a UI mostra "desconhecido", nunca `0`.
 *
 * ## Por que este módulo não recalcula nada
 *
 * A comparação e o veredito vêm de `core/catalog` — as mesmas funções que a
 * sessão usa no turno. Uma segunda implementação aqui seria a que diverge
 * primeiro da que decide de verdade.
 */
import type { ModelAccess, ModelCapabilities, ModelLimits, ModelPricing } from '../core/storage/types/modelCatalog';
import type { DiscoveredModel } from '../core/storage/types/providerModels';
import type { ModelAccessPolicyRecord, PolicyExclusionReason } from '../core/catalog/policy';
import {
	comparePrices,
	discoveredPriceState,
	type DeclaredPrice,
	type PriceSide,
} from '../core/catalog/merge';
import {
	fuseCapabilities,
	fuseLimits,
	fieldUsable,
	type FusedField,
} from '../core/catalog/metadata';
import type { DiscoveredModelView } from './discoveryView';
import { toDiscoveredModelView } from './discoveryView';

/** Um preço, só com números que existem. */
export interface PriceAmountsView {
	readonly currency: string;
	readonly unit: ModelPricing['unit'];
	readonly input?: number;
	readonly output?: number;
	readonly cachedInput?: number;
}

export interface MergedPriceView {
	/** O preço declarado pelo usuário, com a data em que foi salvo. */
	readonly user?: PriceAmountsView & { readonly updatedAt?: string };
	/** O preço publicado pelo provedor, com procedência e validade. */
	readonly discovered?: PriceAmountsView & {
		readonly source: string;
		readonly verifiedAt: string;
		readonly expiresAt: string;
		/** Vencido ou marcado por uma falha de atualização. */
		readonly stale: boolean;
		/** Pode ser escolhido agora. */
		readonly usable: boolean;
		readonly unusableReason?: string;
	};
	/** Moeda e unidade idênticas nos dois lados. Sem isso, não há comparação. */
	readonly comparable: boolean;
	readonly incompatibleReason?: string;
	/** O lado que vale agora. */
	readonly selected?: PriceSide;
	/** A escolha caiu para o declarado: a UI diz por quê, nunca troca calada. */
	readonly fellBack: boolean;
	/** O preço que vale, com a origem que o sustenta. */
	readonly effective?: PriceAmountsView & {
		readonly side: PriceSide;
		readonly origin: string;
		readonly reason: string;
	};
}

/** Por que um modelo pode, ou não, ser chamado sob a política em vigor. */
export interface PolicyStatusView {
	readonly policy: ModelAccessPolicyRecord['policy'];
	readonly eligible: boolean;
	readonly reason?: PolicyExclusionReason;
	/** De onde veio a classificação de acesso: `manual`, `provider`, `account`. */
	readonly evidenceSource?: string;
}

/**
 * Um campo fundido, como a tela o lê.
 *
 * Os dois lados ficam à vista, o conflito é dito, e o lado em vigor é
 * explícito. Um valor ausente é ausente: não há `0` onde ninguém informou, e
 * não há `false` onde ninguém disse.
 */
export interface FusedFieldView<T> {
	/** O valor declarado pelo usuário. Ausente = não declarado. */
	readonly user?: T;
	/** O valor publicado pelo provedor, com a procedência e a validade. */
	readonly discovered?: {
		readonly value: T;
		readonly source: string;
		readonly verifiedAt: string;
		readonly expiresAt: string;
		readonly stale: boolean;
		readonly usable: boolean;
		readonly unusableReason?: string;
	};
	/** Os dois lados existem e discordam. */
	readonly conflict: boolean;
	/** De que lado o valor em vigor vem. */
	readonly selected: 'user' | 'discovered';
	/** O valor em vigor. Ausente = ninguém sabe. */
	readonly effective?: T;
	/** A escolha caiu para o outro lado; nunca é troca silenciosa. */
	readonly fellBack: boolean;
	/** Por que o lado escolhido não pôde ser usado, quando não pôde. */
	readonly unusableReason?: string;
}

/** Os limites fundidos, um campo por vez. */
export interface MergedLimitsView {
	readonly contextTokens?: FusedFieldView<number>;
	readonly maxOutputTokens?: FusedFieldView<number>;
}

/** As capacidades fundidas, um campo por vez. */
export interface MergedCapabilitiesView {
	readonly toolCalling?: FusedFieldView<boolean>;
	readonly structuredOutput?: FusedFieldView<boolean>;
	readonly reasoning?: FusedFieldView<boolean>;
	readonly inputs: Readonly<Partial<Record<string, FusedFieldView<boolean>>>>;
	readonly outputs: Readonly<Partial<Record<string, FusedFieldView<boolean>>>>;
}

/** O que a UI precisa saber sobre a política para desenhar o controle. */
export interface AccessPolicyView {
	readonly policy: ModelAccessPolicyRecord['policy'];
	readonly priceSource: PriceSide;
	readonly limitsSource: PriceSide;
	readonly capabilitiesSource: PriceSide;
	readonly updatedAt: string;
	readonly changedBy: ModelAccessPolicyRecord['changedBy'];
	/** A frase pronta que liga o modo, para a UI citar. */
	readonly hint: string;
}

export interface MergedModelView extends DiscoveredModelView {
	/** O acesso que o usuário declarou, quando ele declarou algum. */
	readonly declaredAccess?: ModelAccess;
	readonly price?: MergedPriceView;
	/** Os limites fundidos: janela de contexto e limite de saída. */
	readonly limits?: MergedLimitsView;
	/** As capacidades fundidas. */
	readonly capabilities?: MergedCapabilitiesView;
	readonly policyStatus: PolicyStatusView;
}

function amounts(pricing: ModelPricing): PriceAmountsView {
	return {
		currency: pricing.currency,
		unit: pricing.unit,
		...(pricing.input !== undefined ? { input: pricing.input } : {}),
		...(pricing.output !== undefined ? { output: pricing.output } : {}),
		...(pricing.cachedInput !== undefined ? { cachedInput: pricing.cachedInput } : {}),
	};
}

/** A comparação dos preços, com o lado em vigor e o motivo. */
export function mergePriceView(input: {
	readonly user?: { readonly pricing: ModelPricing; readonly updatedAt?: string };
	readonly discovered?: DiscoveredModel['pricing'];
	readonly chosen: PriceSide;
	readonly nowMs: number;
}): MergedPriceView | undefined {
	const discoveredOffer: DeclaredPrice | undefined =
		input.discovered === undefined
			? undefined
			: { pricing: input.discovered.pricing, updatedAt: input.discovered.verifiedAt };
	if (input.user === undefined && input.discovered === undefined) {
		return undefined;
	}
	const computed = comparePrices({
		...(input.user !== undefined
			? { user: { pricing: input.user.pricing, ...(input.user.updatedAt !== undefined ? { updatedAt: input.user.updatedAt } : {}) } }
			: {}),
		...(input.discovered !== undefined && discoveredOffer !== undefined
			? {
					discovered: {
						pricing: input.discovered.pricing,
						source: input.discovered.source,
						verifiedAt: input.discovered.verifiedAt,
						expiresAt: input.discovered.expiresAt,
						stale: input.discovered.stale,
					},
				}
			: {}),
		chosen: input.chosen,
		nowMs: input.nowMs,
	});
	const state =
		input.discovered === undefined
			? undefined
			: discoveredPriceState(
					{
						pricing: input.discovered.pricing,
						source: input.discovered.source,
						verifiedAt: input.discovered.verifiedAt,
						expiresAt: input.discovered.expiresAt,
						stale: input.discovered.stale,
					},
					input.nowMs,
				);
	return {
		...(input.user !== undefined
			? {
					user: {
						...amounts(input.user.pricing),
						...(input.user.updatedAt !== undefined ? { updatedAt: input.user.updatedAt } : {}),
					},
				}
			: {}),
		...(input.discovered !== undefined && state !== undefined
			? {
					discovered: {
						...amounts(input.discovered.pricing),
						source: input.discovered.source,
						verifiedAt: input.discovered.verifiedAt,
						expiresAt: input.discovered.expiresAt,
						stale: input.discovered.stale || state.expired,
						usable: state.usable,
						...(state.reason !== undefined ? { unusableReason: state.reason } : {}),
					},
				}
			: {}),
		comparable: computed.comparison.comparable,
		...(computed.comparison.incompatibleReason !== undefined
			? { incompatibleReason: computed.comparison.incompatibleReason }
			: {}),
		...(computed.comparison.selected !== undefined ? { selected: computed.comparison.selected } : {}),
		fellBack: computed.comparison.fellBack,
		...(computed.effective !== undefined
			? {
					effective: {
						...amounts(computed.effective.pricing),
						side: computed.effective.side,
						origin: computed.effective.origin,
						reason: computed.effective.reason,
					},
				}
			: {}),
	};
}

/** Monta a linha do modelo, com os fatos separados. */
export function toMergedModelView(input: {
	readonly model: DiscoveredModel;
	readonly declared?: { readonly pricing?: ModelPricing; readonly access: ModelAccess; readonly updatedAt?: string; readonly limits?: ModelLimits; readonly model?: ModelCapabilities };
	readonly chosen: PriceSide;
	readonly policy: ModelAccessPolicyRecord;
	readonly policyStatus: PolicyStatusView;
	readonly nowMs: number;
	readonly limitsSource: PriceSide;
	readonly capabilitiesSource: PriceSide;
}): MergedModelView {
	const base = toDiscoveredModelView(input.model, input.nowMs);
	const price = mergePriceView({
		...(input.declared?.pricing !== undefined
			? {
					user: {
						pricing: input.declared.pricing,
						...(input.declared.updatedAt !== undefined ? { updatedAt: input.declared.updatedAt } : {}),
					},
				}
			: {}),
		...(input.model.pricing !== undefined ? { discovered: input.model.pricing } : {}),
		chosen: input.chosen,
		nowMs: input.nowMs,
	});
	const limits = fuseLimits({
		...(input.declared?.limits !== undefined ? { user: input.declared.limits } : {}),
		...(input.model.limits !== undefined
			? {
					discovered: {
						value: input.model.limits.limits,
						source: input.model.limits.source,
						verifiedAt: input.model.limits.verifiedAt,
						expiresAt: input.model.limits.expiresAt,
						stale: input.model.limits.stale,
					},
				}
			: {}),
		chosen: input.limitsSource,
		nowMs: input.nowMs,
	});
	const capabilities = fuseCapabilities({
		...(input.declared?.model !== undefined ? { user: input.declared.model } : {}),
		...(input.model.capabilities !== undefined
			? {
					discovered: {
						value: input.model.capabilities.capabilities,
						source: input.model.capabilities.source,
						verifiedAt: input.model.capabilities.verifiedAt,
						expiresAt: input.model.capabilities.expiresAt,
						stale: input.model.capabilities.stale,
					},
				}
			: {}),
		chosen: input.capabilitiesSource,
		nowMs: input.nowMs,
	});
	return {
		...base,
		...(input.declared !== undefined ? { declaredAccess: input.declared.access } : {}),
		...(price !== undefined ? { price } : {}),
		...(limits.contextTokens !== undefined || limits.maxOutputTokens !== undefined
			? {
					limits: {
						...(limits.contextTokens !== undefined
							? { contextTokens: toFusedFieldView(limits.contextTokens) }
							: {}),
						...(limits.maxOutputTokens !== undefined
							? { maxOutputTokens: toFusedFieldView(limits.maxOutputTokens) }
							: {}),
					},
				}
			: {}),
		...(capabilities.toolCalling !== undefined ||
		capabilities.structuredOutput !== undefined ||
		capabilities.reasoning !== undefined ||
		Object.keys(capabilities.inputs).length > 0 ||
		Object.keys(capabilities.outputs).length > 0
			? {
					capabilities: {
						...(capabilities.toolCalling !== undefined
							? { toolCalling: toFusedFieldView(capabilities.toolCalling) }
							: {}),
						...(capabilities.structuredOutput !== undefined
							? { structuredOutput: toFusedFieldView(capabilities.structuredOutput) }
							: {}),
						...(capabilities.reasoning !== undefined
							? { reasoning: toFusedFieldView(capabilities.reasoning) }
							: {}),
						inputs: mapFusedFields(capabilities.inputs),
						outputs: mapFusedFields(capabilities.outputs),
					},
				}
			: {}),
		policyStatus: input.policyStatus,
	};
}

/** Converte um campo fundido do núcleo para a forma da tela. */
export function toFusedFieldView<T>(field: FusedField<T>): FusedFieldView<T> {
	const discovered = field.discovered;
	const usable = fieldUsable(discovered, Date.now());
	return {
		...(field.user !== undefined ? { user: field.user } : {}),
		...(discovered !== undefined
			? {
					discovered: {
						value: discovered.value,
						source: discovered.source,
						verifiedAt: discovered.verifiedAt,
						expiresAt: discovered.expiresAt,
						stale: discovered.stale,
						usable: usable.usable,
						...(usable.reason !== undefined ? { unusableReason: usable.reason } : {}),
					},
				}
			: {}),
		conflict: field.conflict,
		selected: field.selected,
		...(field.effective !== undefined ? { effective: field.effective } : {}),
		fellBack: field.fellBack,
		...(field.unusableReason !== undefined ? { unusableReason: field.unusableReason } : {}),
	};
}

function mapFusedFields(
	fields: Readonly<Record<string, FusedField<boolean>>>,
): Readonly<Record<string, FusedFieldView<boolean>>> {
	const result: Record<string, FusedFieldView<boolean>> = {};
	for (const [key, field] of Object.entries(fields)) {
		result[key] = toFusedFieldView(field);
	}
	return result;
}
