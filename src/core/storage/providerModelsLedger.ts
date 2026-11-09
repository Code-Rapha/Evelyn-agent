/**
 * Leitura tolerante do registro do provedor.
 *
 * Mesma política do catálogo e do ledger: um arquivo ausente é "nada
 * descoberto", não um erro; um registro danificado perde aquele registro; um
 * arquivo que existe mas não abre lança, porque gravá-lo por cima apagaria a
 * descoberta de todo mundo.
 *
 * Nunca se inventa número nem data: um preço sem moeda é descartado (não vira
 * zero), uma data inválida é descartada (não vira "agora"), e um `remaining`
 * negativo é descartado.
 */
import type { ModelAccess, ModelCapabilities, ModelLimits, ModelPricing, PriceSource } from './types/modelCatalog';
import type { QuotaSource } from '../providers/quota/headers';
import type {
	DiscoveredAccess,
	DiscoveredCapabilities,
	DiscoveredLimits,
	DiscoveredModel,
	DiscoveredPricing,
	DiscoveredQuota,
	DiscoveredQuotaRecord,
	DiscoverySource,
} from './types/providerModels';

function asObject(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function timestamp(value: unknown): string | undefined {
	return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

function amount(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
	return typeof value === 'boolean' ? value : undefined;
}

function isSource(value: unknown): value is DiscoverySource {
	return value === 'provider' || value === 'account' || value === 'manual' || value === 'unknown';
}

function isQuotaSource(value: unknown): value is QuotaSource {
	return (
		value === 'published' ||
		value === 'account' ||
		value === 'usage' ||
		value === 'estimate' ||
		value === 'observed' ||
		value === 'unknown'
	);
}

function isAccess(value: unknown): value is ModelAccess {
	return value === 'free' || value === 'paid' || value === 'unknown';
}

function isPriceSource(value: unknown): value is PriceSource {
	return value === 'manual' || value === 'provider' || value === 'unknown';
}

function readPricing(value: unknown): ModelPricing | undefined {
	const candidate = asObject(value);
	const currency = text(candidate?.['currency']);
	const unit = candidate?.['unit'];
	if (currency === undefined || (unit !== 'per_1k_tokens' && unit !== 'per_1m_tokens')) {
		return undefined;
	}
	const input = amount(candidate?.['input']);
	const output = amount(candidate?.['output']);
	const cachedInput = amount(candidate?.['cachedInput']);
	const source = candidate?.['source'];
	return {
		currency,
		unit,
		...(input !== undefined ? { input } : {}),
		...(output !== undefined ? { output } : {}),
		...(cachedInput !== undefined ? { cachedInput } : {}),
		...(isPriceSource(source) ? { source } : {}),
	};
}

function readDiscoveredPricing(value: unknown): DiscoveredPricing | undefined {
	const candidate = asObject(value);
	const pricing = readPricing(candidate?.['pricing']);
	const source = candidate?.['source'];
	const verifiedAt = timestamp(candidate?.['verifiedAt']);
	const expiresAt = timestamp(candidate?.['expiresAt']);
	const stale = bool(candidate?.['stale']);
	if (pricing === undefined || !isSource(source) || verifiedAt === undefined || expiresAt === undefined) {
		return undefined;
	}
	return { pricing, source, verifiedAt, expiresAt, stale: stale ?? false };
}

function readDiscoveredAccess(value: unknown): DiscoveredAccess | undefined {
	const candidate = asObject(value);
	const access = candidate?.['access'];
	const source = candidate?.['source'];
	const verifiedAt = timestamp(candidate?.['verifiedAt']);
	const expiresAt = timestamp(candidate?.['expiresAt']);
	if (!isAccess(access) || !isSource(source) || verifiedAt === undefined || expiresAt === undefined) {
		return undefined;
	}
	const evidence = text(candidate?.['evidence']);
	const stale = bool(candidate?.['stale']);
	// `unknown` como fato não tem conteúdo: sem evidência, não é um fato.
	if (access === 'unknown') {
		return undefined;
	}
	return {
		access,
		source,
		verifiedAt,
		expiresAt,
		...(evidence !== undefined ? { evidence } : {}),
		stale: stale ?? false,
	};
}

/** Um limite: número inteiro e não negativo, ou ausente. */
function limitNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function readModelLimits(value: unknown): ModelLimits | undefined {
	const candidate = asObject(value);
	if (candidate === undefined) {
		return undefined;
	}
	const contextTokens = limitNumber(candidate['contextTokens']);
	const maxOutputTokens = limitNumber(candidate['maxOutputTokens']);
	if (contextTokens === undefined && maxOutputTokens === undefined) {
		return undefined;
	}
	return {
		...(contextTokens !== undefined ? { contextTokens } : {}),
		...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
	};
}

function readCapabilities(value: unknown): ModelCapabilities | undefined {
	const candidate = asObject(value);
	if (candidate === undefined) {
		return undefined;
	}
	const toolCalling = bool(candidate['toolCalling']);
	const structuredOutput = bool(candidate['structuredOutput']);
	const reasoning = bool(candidate['reasoning']);
	const inputs = readModalityMap(candidate['inputs']);
	const outputs = readModalityMap(candidate['outputs']);
	if (
		toolCalling === undefined &&
		structuredOutput === undefined &&
		reasoning === undefined &&
		inputs === undefined &&
		outputs === undefined
	) {
		return undefined;
	}
	return {
		...(toolCalling !== undefined ? { toolCalling } : {}),
		...(structuredOutput !== undefined ? { structuredOutput } : {}),
		...(reasoning !== undefined ? { reasoning } : {}),
		...(inputs !== undefined ? { inputs } : {}),
		...(outputs !== undefined ? { outputs } : {}),
	};
}

/** Um mapa de modalidade: só as chaves conhecidas e os valores booleanos. */
function readModalityMap(
	value: unknown,
): Partial<Record<string, boolean>> | undefined {
	const candidate = asObject(value);
	if (candidate === undefined) {
		return undefined;
	}
	const result: Record<string, boolean> = {};
	for (const [key, entry] of Object.entries(candidate)) {
		const flag = bool(entry);
		if (flag !== undefined) {
			result[key] = flag;
		}
	}
	return Object.keys(result).length === 0 ? undefined : result;
}

function readDiscoveredLimits(value: unknown): DiscoveredLimits | undefined {
	const candidate = asObject(value);
	if (candidate === undefined) {
		return undefined;
	}
	const limits = readModelLimits(candidate['limits']);
	const source = candidate?.['source'];
	const verifiedAt = timestamp(candidate?.['verifiedAt']);
	const expiresAt = timestamp(candidate?.['expiresAt']);
	if (limits === undefined || !isSource(source) || verifiedAt === undefined || expiresAt === undefined) {
		return undefined;
	}
	return { limits, source, verifiedAt, expiresAt, stale: bool(candidate?.['stale']) ?? false };
}

function readDiscoveredCapabilities(value: unknown): DiscoveredCapabilities | undefined {
	const candidate = asObject(value);
	if (candidate === undefined) {
		return undefined;
	}
	const capabilities = readCapabilities(candidate?.['capabilities']);
	const source = candidate?.['source'];
	const verifiedAt = timestamp(candidate?.['verifiedAt']);
	const expiresAt = timestamp(candidate?.['expiresAt']);
	if (
		capabilities === undefined ||
		!isSource(source) ||
		verifiedAt === undefined ||
		expiresAt === undefined
	) {
		return undefined;
	}
	return {
		capabilities,
		source,
		verifiedAt,
		expiresAt,
		stale: bool(candidate?.['stale']) ?? false,
	};
}

/** Um modelo descoberto, ou `undefined` quando a identidade não existe. */
export function readDiscoveredModel(value: unknown): DiscoveredModel | undefined {
	const candidate = asObject(value);
	if (candidate === undefined) {
		return undefined;
	}
	const providerId = text(candidate['providerId']);
	const modelId = text(candidate['modelId']);
	const updatedAt = timestamp(candidate['updatedAt']);
	if (providerId === undefined || modelId === undefined || updatedAt === undefined) {
		return undefined;
	}
	const listedAt = timestamp(candidate['listedAt']);
	const accessConfirmedAt = timestamp(candidate['accessConfirmedAt']);
	const missingSince = timestamp(candidate['missingSince']);
	const contextTokens = amount(candidate['contextTokens']);
	const maxOutputTokens = limitNumber(candidate['maxOutputTokens']);
	const created = timestamp(candidate['created']);
	const pricing = readDiscoveredPricing(candidate['pricing']);
	const access = readDiscoveredAccess(candidate['access']);
	const capabilities = readDiscoveredCapabilities(candidate['capabilities']);
	// Um modelo "listado" sem data da listagem seria uma afirmação sem
	// procedência; o campo `listed` só é verdadeiro com a data que o sustenta.
	const listed = candidate['listed'] === true && listedAt !== undefined;
	return {
		providerId,
		modelId,
		listed,
		...(listed && listedAt !== undefined ? { listedAt } : {}),
		...(accessConfirmedAt !== undefined ? { accessConfirmedAt } : {}),
		...(missingSince !== undefined ? { missingSince } : {}),
		...(contextTokens !== undefined ? { contextTokens } : {}),
		...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
		...(created !== undefined ? { created } : {}),
		...(pricing !== undefined ? { pricing } : {}),
		...(access !== undefined ? { access } : {}),
		...(capabilities !== undefined ? { capabilities } : {}),
		updatedAt,
	};
}

function readQuota(value: unknown): DiscoveredQuota | undefined {
	const candidate = asObject(value);
	const source = candidate?.['source'];
	const verifiedAt = timestamp(candidate?.['verifiedAt']);
	if (!isQuotaSource(source) || verifiedAt === undefined) {
		return undefined;
	}
	const limit = amount(candidate?.['limit']);
	const remaining = amount(candidate?.['remaining']);
	const resetAt = timestamp(candidate?.['resetAt']);
	const retryAfterMs = amount(candidate?.['retryAfterMs']);
	const kind =
		candidate?.['kind'] === 'requests' || candidate?.['kind'] === 'tokens'
			? candidate['kind']
			: undefined;
	const scope =
		candidate?.['scope'] === 'api-key' ||
		candidate?.['scope'] === 'provider' ||
		candidate?.['scope'] === 'model' ||
		candidate?.['scope'] === 'account'
			? candidate['scope']
			: undefined;
	const window =
		candidate?.['window'] === 'minute' ||
		candidate?.['window'] === 'hour' ||
		candidate?.['window'] === 'day' ||
		candidate?.['window'] === 'month' ||
		candidate?.['window'] === 'second'
			? candidate['window']
			: undefined;
	return {
		source,
		...(limit !== undefined ? { limit } : {}),
		...(remaining !== undefined ? { remaining } : {}),
		...(resetAt !== undefined ? { resetAt } : {}),
		...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
		...(kind !== undefined ? { kind } : {}),
		...(scope !== undefined ? { scope } : {}),
		...(window !== undefined ? { window } : {}),
		verifiedAt,
	};
}

export function readQuotaRecord(value: unknown): DiscoveredQuotaRecord | undefined {
	const candidate = asObject(value);
	const providerId = text(candidate?.['providerId']);
	const updatedAt = timestamp(candidate?.['updatedAt']);
	if (candidate === undefined || providerId === undefined || updatedAt === undefined) {
		return undefined;
	}
	const modelId = text(candidate['modelId']);
	const account = readQuota(candidate['account']);
	const usage = asObject(candidate['usage']);
	const usageRequests = amount(usage?.['requests']);
	const usageInput = amount(usage?.['inputTokens']);
	const usageOutput = amount(usage?.['outputTokens']);
	const usageSince = timestamp(usage?.['since']);
	return {
		providerId,
		...(modelId !== undefined ? { modelId } : {}),
		...(account !== undefined ? { account } : {}),
		...(usageRequests !== undefined &&
		usageInput !== undefined &&
		usageOutput !== undefined &&
		usageSince !== undefined
			? {
					usage: {
						requests: usageRequests,
						inputTokens: usageInput,
						outputTokens: usageOutput,
						since: usageSince,
					},
				}
			: {}),
		updatedAt,
	};
}

/** Abre o arquivo inteiro. JSON inválido lê como "nada descoberto". */
export function parseProviderModels(raw: string): {
	readonly models: readonly DiscoveredModel[];
	readonly quotas: readonly DiscoveredQuotaRecord[];
} {
	let payload: unknown;
	try {
		payload = JSON.parse(raw);
	} catch {
		return { models: [], quotas: [] };
	}
	const root = asObject(payload);
	if (root === undefined) {
		return { models: [], quotas: [] };
	}
	const models: DiscoveredModel[] = [];
	const seen = new Set<string>();
	if (Array.isArray(root['models'])) {
		for (const entry of root['models']) {
			const model = readDiscoveredModel(entry);
			if (model === undefined) {
				continue;
			}
			const key = JSON.stringify([model.providerId, model.modelId]);
			if (!seen.has(key)) {
				seen.add(key);
				models.push(model);
			}
		}
	}
	const quotas: DiscoveredQuotaRecord[] = [];
	const quotaSeen = new Set<string>();
	if (Array.isArray(root['quotas'])) {
		for (const entry of root['quotas']) {
			const quota = readQuotaRecord(entry);
			if (quota === undefined) {
				continue;
			}
			const key = JSON.stringify([quota.providerId, quota.modelId ?? '']);
			if (!quotaSeen.has(key)) {
				quotaSeen.add(key);
				quotas.push(quota);
			}
		}
	}
	return { models, quotas };
}
