/**
 * A regra de atualização do registro do provedor, independente do disco.
 *
 * ## O que ela decide
 *
 * Dado o que está gravado e o que uma listagem nova trouxe, quais registros
 * mudam. É a parte que precisa ser testada com exatidão: TTL por tipo, modelo
 * que sumiu, preço que venceu, falha que preserva e marca como `stale`.
 *
 * ## Três decisões que o usuário sente
 *
 * 1. **Um modelo que some não é apagado.** Ele deixa de ser `listed`, ganha
 *    `missingSince`, e o preço/acesso antigo permanece datado. O ledger aponta
 *    para ele; apagar o registro tornaria um gasto passado inexplicável.
 * 2. **Uma falha nunca apaga nada.** A listagem anterior continua servida,
 *    com `stale: true` no que depende dela, e o `DiscoveryOutcome` diz que a
 *    verificação falhou. Falha não é "o provedor está vazio".
 * 3. **Preço e acesso têm validade própria.** Um preço vencido continua
 *    exibido, marcado como antigo; um `free` vencido não sustenta "usar só
 *    gratuitos" — a 5D não transforma evidência velha em permissão.
 */
import type {
	DiscoveredModel,
	DiscoveryOutcome,
	DiscoverySource,
	DiscoveryTtl,
} from './types/providerModels';
import type { ModelCapabilities, ModelLimits } from './types/modelCatalog';

/** O preço publicado que a listagem trouxe, na forma do catálogo. */
export interface ListingPricing {
	readonly currency: string;
	readonly unit: 'per_1k_tokens' | 'per_1m_tokens';
	readonly input?: number;
	readonly output?: number;
}

export interface ListingEntry {
	readonly modelId: string;
	readonly contextTokens?: number;
	readonly maxOutputTokens?: number;
	readonly capabilities?: ModelCapabilities;
	readonly created?: string;
	readonly pricing?: ListingPricing;
}

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

/**
 * `free` só com evidência suficiente: **ambos** os preços publicados, e os
 * dois iguais a zero. Um lado zero com o outro desconhecido não prova nada.
 */
export function inferPublishedAccess(pricing: ListingPricing | undefined): {
	readonly access: 'free' | 'unknown';
	readonly evidence?: string;
} {
	if (pricing === undefined) {
		return { access: 'unknown' };
	}
	if (pricing.input === 0 && pricing.output === 0) {
		return {
			access: 'free',
			evidence: `published price: input 0 and output 0 ${pricing.currency} per ${pricing.unit}`,
		};
	}
	if (pricing.input === undefined && pricing.output === undefined) {
		return { access: 'unknown' };
	}
	return { access: 'unknown' };
}

export interface ApplyListingInput {
	readonly providerId: string;
	readonly existing: readonly DiscoveredModel[];
	readonly listing: readonly ListingEntry[];
	readonly fetchedAtMs: number;
	readonly ttl: DiscoveryTtl;
	readonly nowMs: number;
}

/** Aplica uma listagem bem-sucedida. Função pura: devolve o próximo estado. */
export function applyListing(input: ApplyListingInput): {
	readonly models: readonly DiscoveredModel[];
	readonly outcome: DiscoveryOutcome;
} {
	const byKey = new Map<string, DiscoveredModel>();
	for (const model of input.existing) {
		byKey.set(model.modelId, model);
	}
	const listedAt = iso(input.fetchedAtMs);
	const updatedAt = iso(input.nowMs);
	const seen = new Set<string>();
	let added = 0;

	for (const entry of input.listing) {
		if (seen.has(entry.modelId)) {
			// A listagem repetida é o mesmo modelo; a primeira entrada vale.
			continue;
		}
		seen.add(entry.modelId);
		const existing = byKey.get(entry.modelId);
		if (existing === undefined) {
			added += 1;
		}
		const pricing =
			entry.pricing !== undefined
				? {
						pricing: {
							currency: entry.pricing.currency,
							unit: entry.pricing.unit,
							...(entry.pricing.input !== undefined ? { input: entry.pricing.input } : {}),
							...(entry.pricing.output !== undefined ? { output: entry.pricing.output } : {}),
							source: 'provider' as const,
						},
						source: 'provider' as const,
						verifiedAt: listedAt,
						expiresAt: iso(input.fetchedAtMs + input.ttl.pricingMs),
						stale: false,
					}
				: existing?.pricing;
		const inferred = inferPublishedAccess(entry.pricing);
		const access =
			entry.pricing !== undefined
				? {
						access: inferred.access,
						source: 'provider' as const,
						verifiedAt: listedAt,
						expiresAt: iso(input.fetchedAtMs + input.ttl.pricingMs),
						...(inferred.evidence !== undefined ? { evidence: inferred.evidence } : {}),
						stale: false,
					}
				: existing?.access;
		// Os limites e as capacidades têm validade própria: mudam em outro
		// ritmo que o preço, e um deles pode faltar sem que o outro falte.
		const limitsValue: ModelLimits | undefined =
			entry.contextTokens !== undefined || entry.maxOutputTokens !== undefined
				? {
						...(entry.contextTokens !== undefined ? { contextTokens: entry.contextTokens } : {}),
						...(entry.maxOutputTokens !== undefined
							? { maxOutputTokens: entry.maxOutputTokens }
							: {}),
					}
				: undefined;
		const limits =
			limitsValue !== undefined
				? {
						limits: limitsValue,
						source: 'provider' as const,
						verifiedAt: listedAt,
						expiresAt: iso(input.fetchedAtMs + input.ttl.pricingMs),
						stale: false,
					}
				: existing?.limits;
		const capabilities =
			entry.capabilities !== undefined
				? {
						capabilities: entry.capabilities,
						source: 'provider' as const,
						verifiedAt: listedAt,
						expiresAt: iso(input.fetchedAtMs + input.ttl.pricingMs),
						stale: false,
					}
				: existing?.capabilities;
		byKey.set(entry.modelId, {
			...existing,
			providerId: input.providerId,
			modelId: entry.modelId,
			listed: true,
			listedAt,
			...(existing?.accessConfirmedAt !== undefined
				? { accessConfirmedAt: existing.accessConfirmedAt }
				: {}),
			...(entry.contextTokens !== undefined
				? { contextTokens: entry.contextTokens }
				: existing?.contextTokens !== undefined
					? { contextTokens: existing.contextTokens }
					: {}),
			...(entry.maxOutputTokens !== undefined
				? { maxOutputTokens: entry.maxOutputTokens }
				: existing?.maxOutputTokens !== undefined
					? { maxOutputTokens: existing.maxOutputTokens }
					: {}),
			...(entry.created !== undefined ? { created: entry.created } : existing?.created !== undefined ? { created: existing.created } : {}),
			...(pricing !== undefined ? { pricing } : {}),
			...(access !== undefined ? { access } : {}),
			...(limits !== undefined ? { limits } : {}),
			...(capabilities !== undefined ? { capabilities } : {}),
			updatedAt,
		});
	}

	// Os que não vieram: continuam gravados, deixam de ser listados.
	let removed = 0;
	for (const [modelId, model] of byKey) {
		if (seen.has(modelId)) {
			continue;
		}
		if (model.listed) {
			removed += 1;
		}
		byKey.set(modelId, {
			...model,
			listed: false,
			missingSince: model.listed ? listedAt : model.missingSince ?? listedAt,
			// O preço e o acesso antigos permanecem, mas como evidência de antes
			// da data em que o modelo cessou de ser listado.
			...(model.pricing !== undefined ? { pricing: { ...model.pricing, stale: true } } : {}),
			...(model.access !== undefined ? { access: { ...model.access, stale: true } } : {}),
			updatedAt,
		});
	}

	return {
		models: [...byKey.values()],
		outcome: {
			providerId: input.providerId,
			status: 'ok',
			models: seen.size,
			added,
			removed,
			fetchedAt: listedAt,
			stale: false,
		},
	};
}

/**
 * O resultado de uma listagem que falhou.
 *
 * Nada muda, exceto a marca de desatualizado no que herdou da listagem, e o
 * relatório diz que a verificação falhou e por quê. O erro vai como texto
 * curto: mensagens de provider não carregam credencial, mas ainda assim é
 * truncado.
 */
export function applyFailure(input: {
	readonly providerId: string;
	readonly existing: readonly DiscoveredModel[];
	readonly error: unknown;
	readonly nowMs: number;
}): { readonly models: readonly DiscoveredModel[]; readonly outcome: DiscoveryOutcome } {
	const updatedAt = iso(input.nowMs);
	const models = input.existing.map((model) =>
		model.listed
			? {
					...model,
					updatedAt,
					...(model.pricing !== undefined ? { pricing: { ...model.pricing, stale: true } } : {}),
					...(model.access !== undefined ? { access: { ...model.access, stale: true } } : {}),
				}
			: model,
	);
	const listed = models.filter((model) => model.listed);
	const fetchedAt = listed.reduce<string | undefined>(
		(earliest, model) =>
			model.listedAt !== undefined && (earliest === undefined || model.listedAt < earliest)
				? model.listedAt
				: earliest,
		undefined,
	);
	const message =
		input.error instanceof Error ? input.error.message : String(input.error);
	return {
		models,
		outcome: {
			providerId: input.providerId,
			status: 'failed',
			models: listed.length,
			added: 0,
			removed: 0,
			...(fetchedAt !== undefined ? { fetchedAt } : {}),
			// Sem nenhum registro anterior não há o que servir: a cópia vazia não
			// é uma resposta antiga, é a ausência de uma.
			stale: listed.length > 0,
			error: message.slice(0, 300),
		},
	};
}

/** Quão fresca está uma data, dado o TTL. */
export function freshness(expiresAt: string, nowMs: number): 'fresh' | 'stale' | 'expired' {
	const at = Date.parse(expiresAt);
	if (Number.isNaN(at)) {
		return 'expired';
	}
	if (at > nowMs) {
		return 'fresh';
	}
	// Até sete dias vencidos ainda é evidência exibível, como "desatualizada".
	return at + 7 * 86_400_000 > nowMs ? 'stale' : 'expired';
}

/** O acesso que a 5D pode usar para *filtrar*: só evidência ainda fresca. */
export function usableAccess(
	model: DiscoveredModel,
	nowMs: number,
): { readonly access: 'free' | 'paid' | 'unknown'; readonly source: DiscoverySource } {
	if (model.access === undefined) {
		return { access: 'unknown', source: 'unknown' };
	}
	const state = freshness(model.access.expiresAt, nowMs);
	if (state !== 'fresh') {
		// Evidência vencida não sustenta "só gratuitos": vira desconhecido aqui,
		// embora continue exibível como histórico.
		return { access: 'unknown', source: 'unknown' };
	}
	return { access: model.access.access, source: model.access.source };
}
