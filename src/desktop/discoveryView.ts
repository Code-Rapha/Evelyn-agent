/**
 * O catálogo descoberto, como a UI e o log o leem.
 *
 * ## Cada linha diz de onde veio cada fato
 *
 * `access` e `pricing` vêm com `source` (provedor, conta, manual) e
 * `verifiedAt`; `freshness` diz se ainda valem. A cota tem uma entrada por
 * origem — oficial, da conta, uso local, estimativa, observada — e nunca uma
 * soma entre elas. É essa separação que impede a tela de chamar uma estimativa
 * local de "limite oficial".
 *
 * ## Listado não é acessível
 *
 * `listed` diz que o `/models` publicou o modelo. `accessConfirmedAt` diz que
 * uma chamada real respondeu. O tipo tem os dois campos porque são fatos
 * diferentes e a tela precisa poder mostrá-los assim.
 */
import type { CostUnit } from '../core/storage/types/modelCatalog';
import type {
	DiscoveredModel,
	DiscoveredQuotaRecord,
	DiscoveryOutcome,
} from '../core/storage/types/providerModels';
import type { QuotaSource } from '../core/providers/quota/headers';

export interface DiscoveredPricingView {
	readonly currency: string;
	readonly unit: CostUnit;
	readonly input?: number;
	readonly output?: number;
	readonly cachedInput?: number;
	readonly source: string;
	readonly verifiedAt: string;
	readonly expiresAt: string;
	readonly stale: boolean;
}

export interface DiscoveredAccessView {
	readonly access: 'free' | 'paid' | 'unknown';
	readonly source: string;
	readonly verifiedAt: string;
	readonly expiresAt: string;
	readonly evidence?: string;
	/** `false` quando o dado venceu: continua exibível, não é evidência. */
	readonly usable: boolean;
}

export interface DiscoveredModelView {
	readonly providerId: string;
	readonly modelId: string;
	/** O `/models` publicou este modelo na última listagem. */
	readonly listed: boolean;
	readonly listedAt?: string;
	/** Uma chamada real respondeu: esta conta pode usá-lo. */
	readonly accessConfirmedAt?: string;
	/** Saiu da listagem em (o histórico de uso permanece). */
	readonly missingSince?: string;
	readonly contextTokens?: number;
	readonly created?: string;
	readonly pricing?: DiscoveredPricingView;
	readonly access?: DiscoveredAccessView;
	readonly updatedAt: string;
}

/** Uma medida de cota e a origem que a disse — a origem nunca é inferida. */
export interface QuotaMeasureView {
	readonly source: QuotaSource;
	/** O limite, quando a fonte o informou. */
	readonly value?: number;
	/**
	 * O que ainda resta, quando a fonte o informou.
	 *
	 * Ausente = a fonte não disse. Um `0` aqui é "acabou", que é diferente
	 * de "não se sabe" — e o painel do roteador precisa da diferença para
	 * dizer que uma cota está esgotada.
	 */
	readonly remaining?: number;
	readonly resetAt?: string;
	readonly retryAfterMs?: number;
	readonly verifiedAt: string;
}

export interface DiscoveredQuotaView {
	readonly providerId: string;
	readonly modelId?: string;
	/** O que a API informou para esta conta, quando informou. */
	readonly account?: QuotaMeasureView;
	/** O que a Evelyn contou no período do limite. */
	readonly usage?: DiscoveredQuotaRecord['usage'];
	readonly updatedAt: string;
}

/** O relatório de uma atualização, para a UI e o log. */
export interface DiscoveryReportView extends DiscoveryOutcome {}

export function toDiscoveredModelView(model: DiscoveredModel, nowMs: number): DiscoveredModelView {
	const access = model.access;
	const pricing = model.pricing;
	return {
		providerId: model.providerId,
		modelId: model.modelId,
		listed: model.listed,
		...(model.listedAt !== undefined ? { listedAt: model.listedAt } : {}),
		...(model.accessConfirmedAt !== undefined ? { accessConfirmedAt: model.accessConfirmedAt } : {}),
		...(model.missingSince !== undefined ? { missingSince: model.missingSince } : {}),
		...(model.contextTokens !== undefined ? { contextTokens: model.contextTokens } : {}),
		...(model.created !== undefined ? { created: model.created } : {}),
		...(pricing !== undefined
			? {
					pricing: {
						currency: pricing.pricing.currency,
						unit: pricing.pricing.unit,
						...(pricing.pricing.input !== undefined ? { input: pricing.pricing.input } : {}),
						...(pricing.pricing.output !== undefined ? { output: pricing.pricing.output } : {}),
						...(pricing.pricing.cachedInput !== undefined
							? { cachedInput: pricing.pricing.cachedInput }
							: {}),
						source: pricing.source,
						verifiedAt: pricing.verifiedAt,
						expiresAt: pricing.expiresAt,
						stale: pricing.stale || Date.parse(pricing.expiresAt) <= nowMs,
					},
				}
			: {}),
		...(access !== undefined
			? {
					access: {
						access: access.access,
						source: access.source,
						verifiedAt: access.verifiedAt,
						expiresAt: access.expiresAt,
						...(access.evidence !== undefined ? { evidence: access.evidence } : {}),
						// `stale` explícito e validade contam os dois: uma cópia
						// marcada como antiga por uma falha não é evidência nova.
						usable: !access.stale && Date.parse(access.expiresAt) > nowMs,
					},
				}
			: {}),
		updatedAt: model.updatedAt,
	};
}

export function toQuotaView(record: DiscoveredQuotaRecord): DiscoveredQuotaView {
	const account = record.account;
	return {
		providerId: record.providerId,
		...(record.modelId !== undefined ? { modelId: record.modelId } : {}),
		...(account !== undefined
			? {
					account: {
						source: account.source,
						...(account.limit !== undefined ? { value: account.limit } : {}),
						...(account.remaining !== undefined ? { remaining: account.remaining } : {}),
						...(account.resetAt !== undefined ? { resetAt: account.resetAt } : {}),
						...(account.retryAfterMs !== undefined ? { retryAfterMs: account.retryAfterMs } : {}),
						verifiedAt: account.verifiedAt,
					},
				}
			: {}),
		...(record.usage !== undefined ? { usage: record.usage } : {}),
		updatedAt: record.updatedAt,
	};
}
