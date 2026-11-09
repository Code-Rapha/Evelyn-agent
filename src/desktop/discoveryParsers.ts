/**
 * Parsers for the discovery views, shared by the preload bridge.
 *
 * Same rule as the budget parsers: a malformed row is dropped rather than
 * repaired, because a repaired row would be a claim the provider never made.
 * A missing list is an empty list - "nothing discovered" is a normal state.
 */
import type { DiscoveredModelView, DiscoveredQuotaView } from './discoveryView';

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function string(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function number(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optional<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
	return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

export function parseDiscoveredModelView(value: unknown): DiscoveredModelView | undefined {
	if (!isObject(value)) {
		return undefined;
	}
	const providerId = string(value.providerId);
	const modelId = string(value.modelId);
	const updatedAt = string(value.updatedAt);
	if (providerId === undefined || modelId === undefined || updatedAt === undefined) {
		return undefined;
	}
	const pricing = isObject(value.pricing)
		? {
				currency: string(value.pricing.currency) ?? '',
				unit: optional(value.pricing.unit, ['per_1k_tokens', 'per_1m_tokens'] as const) ?? 'per_1m_tokens',
				...(number(value.pricing.input) !== undefined ? { input: number(value.pricing.input) } : {}),
				...(number(value.pricing.output) !== undefined ? { output: number(value.pricing.output) } : {}),
				...(number(value.pricing.cachedInput) !== undefined
					? { cachedInput: number(value.pricing.cachedInput) }
					: {}),
				source: string(value.pricing.source) ?? 'unknown',
				verifiedAt: string(value.pricing.verifiedAt) ?? '',
				expiresAt: string(value.pricing.expiresAt) ?? '',
				stale: value.pricing.stale === true,
			}
		: undefined;
	const access = isObject(value.access)
		? {
				access: optional(value.access.access, ['free', 'paid', 'unknown'] as const) ?? 'unknown',
				source: string(value.access.source) ?? 'unknown',
				verifiedAt: string(value.access.verifiedAt) ?? '',
				expiresAt: string(value.access.expiresAt) ?? '',
				...(string(value.access.evidence) !== undefined ? { evidence: string(value.access.evidence) } : {}),
				usable: value.access.usable === true,
			}
		: undefined;
	return {
		providerId,
		modelId,
		listed: value.listed === true,
		...(string(value.listedAt) !== undefined ? { listedAt: string(value.listedAt) } : {}),
		...(string(value.accessConfirmedAt) !== undefined
			? { accessConfirmedAt: string(value.accessConfirmedAt) }
			: {}),
		...(string(value.missingSince) !== undefined ? { missingSince: string(value.missingSince) } : {}),
		...(number(value.contextTokens) !== undefined ? { contextTokens: number(value.contextTokens) } : {}),
		...(string(value.created) !== undefined ? { created: string(value.created) } : {}),
		...(pricing !== undefined ? { pricing } : {}),
		...(access !== undefined ? { access } : {}),
		updatedAt,
	};
}

export function parseDiscoveredModelViews(value: unknown): readonly DiscoveredModelView[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const views: DiscoveredModelView[] = [];
	for (const item of value) {
		const view = parseDiscoveredModelView(item);
		if (view !== undefined) {
			views.push(view);
		}
	}
	return views;
}

export function parseDiscoveredQuotaView(value: unknown): DiscoveredQuotaView | undefined {
	if (!isObject(value)) {
		return undefined;
	}
	const providerId = string(value.providerId);
	const updatedAt = string(value.updatedAt);
	if (providerId === undefined || updatedAt === undefined) {
		return undefined;
	}
	const account = isObject(value.account)
		? {
				source:
					optional(value.account.source, [
						'published',
						'account',
						'usage',
						'estimate',
						'observed',
						'unknown',
					] as const) ?? 'unknown',
				...(number(value.account.value) !== undefined ? { value: number(value.account.value) } : {}),
				...(number(value.account.remaining) !== undefined
					? { remaining: number(value.account.remaining) }
					: {}),
				...(string(value.account.resetAt) !== undefined ? { resetAt: string(value.account.resetAt) } : {}),
				...(number(value.account.retryAfterMs) !== undefined
					? { retryAfterMs: number(value.account.retryAfterMs) }
					: {}),
				verifiedAt: string(value.account.verifiedAt) ?? '',
			}
		: undefined;
	const usage = isObject(value.usage)
		? {
				requests: number(value.usage.requests) ?? 0,
				inputTokens: number(value.usage.inputTokens) ?? 0,
				outputTokens: number(value.usage.outputTokens) ?? 0,
				since: string(value.usage.since) ?? '',
			}
		: undefined;
	return {
		providerId,
		...(string(value.modelId) !== undefined ? { modelId: string(value.modelId) } : {}),
		...(account !== undefined ? { account } : {}),
		...(usage !== undefined ? { usage } : {}),
		updatedAt,
	};
}

export function parseDiscoveredQuotaViews(value: unknown): readonly DiscoveredQuotaView[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const views: DiscoveredQuotaView[] = [];
	for (const item of value) {
		const view = parseDiscoveredQuotaView(item);
		if (view !== undefined) {
			views.push(view);
		}
	}
	return views;
}
