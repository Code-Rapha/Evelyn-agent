/**
 * Parsers da fusão e da política, usados pela ponte do preload.
 *
 * Mesma regra dos outros parsers desta janela: uma linha malformada é
 * descartada, nunca "consertada". Consertar um preço — preenchendo a moeda,
 * escolhendo uma unidade — seria inventar um número que o provedor não
 * publicou, e a tela o mostraria como se fosse um dado.
 *
 * A distinção que mais importa aqui: **campo ausente continua ausente**. Um
 * preço sem `input` não vira `0`, e um lado sem preço não vira "grátis".
 */
import type { AccessPolicyView, MergedModelView, MergedPriceView, PolicyStatusView } from './catalogFusion';
import { parseDiscoveredModelView } from './discoveryParsers';
import type { DiscoveredModelView } from './discoveryView';

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function string(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function number(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function unit(value: unknown): 'per_1k_tokens' | 'per_1m_tokens' | undefined {
	return value === 'per_1k_tokens' || value === 'per_1m_tokens' ? value : undefined;
}

function side(value: unknown): 'user' | 'discovered' | undefined {
	return value === 'user' || value === 'discovered' ? value : undefined;
}

function policy(value: unknown): AccessPolicyView['policy'] | undefined {
	return value === 'any' || value === 'free_only' || value === 'free_preferred' ? value : undefined;
}

function amounts(value: unknown): { currency: string; unit: 'per_1k_tokens' | 'per_1m_tokens'; input?: number; output?: number; cachedInput?: number } | undefined {
	if (!isObject(value)) {
		return undefined;
	}
	const currency = string(value.currency);
	const priceUnit = unit(value.unit);
	if (currency === undefined || currency.length === 0 || priceUnit === undefined) {
		// Sem moeda ou sem unidade, o número não significa preço. A linha é
		// descartada em vez de exibida como "0".
		return undefined;
	}
	const input = number(value.input);
	const output = number(value.output);
	const cachedInput = number(value.cachedInput);
	return {
		currency,
		unit: priceUnit,
		...(input !== undefined ? { input } : {}),
		...(output !== undefined ? { output } : {}),
		...(cachedInput !== undefined ? { cachedInput } : {}),
	};
}

export function parseMergedPriceView(value: unknown): MergedPriceView | undefined {
	if (!isObject(value)) {
		return undefined;
	}
	const userAmounts = amounts(value.user);
	const discoveredAmounts = amounts(value.discovered);
	if (value.user !== undefined && userAmounts === undefined) {
		return undefined;
	}
	if (value.discovered !== undefined && discoveredAmounts === undefined) {
		return undefined;
	}
	const discovered = isObject(value.discovered) && discoveredAmounts !== undefined
		? {
				...discoveredAmounts,
				source: string(value.discovered.source) ?? 'unknown',
				verifiedAt: string(value.discovered.verifiedAt) ?? '',
				expiresAt: string(value.discovered.expiresAt) ?? '',
				stale: value.discovered.stale === true,
				usable: value.discovered.usable === true,
				...(string(value.discovered.unusableReason) !== undefined
					? { unusableReason: string(value.discovered.unusableReason) }
					: {}),
			}
		: undefined;
	const effectiveAmounts = amounts(value.effective);
	const effectiveSide = isObject(value.effective) ? side(value.effective.side) : undefined;
	return {
		...(userAmounts !== undefined
			? {
					user: {
						...userAmounts,
						...(isObject(value.user) && string(value.user.updatedAt) !== undefined
							? { updatedAt: string(value.user.updatedAt) }
							: {}),
					},
				}
			: {}),
		...(discovered !== undefined ? { discovered } : {}),
		comparable: value.comparable === true,
		...(string(value.incompatibleReason) !== undefined
			? { incompatibleReason: string(value.incompatibleReason) }
			: {}),
		...(side(value.selected) !== undefined ? { selected: side(value.selected) } : {}),
		fellBack: value.fellBack === true,
		...(effectiveAmounts !== undefined && effectiveSide !== undefined && isObject(value.effective)
			? {
					effective: {
						...effectiveAmounts,
						side: effectiveSide,
						origin: string(value.effective.origin) ?? 'unknown',
						reason: string(value.effective.reason) ?? '',
					},
				}
			: {}),
	};
}

export function parsePolicyStatusView(value: unknown): PolicyStatusView | undefined {
	if (!isObject(value)) {
		return undefined;
	}
	const current = policy(value.policy);
	if (current === undefined) {
		return undefined;
	}
	const reason =
		value.reason === 'free_not_confirmed' ||
		value.reason === 'free_evidence_expired' ||
		value.reason === 'paid'
			? value.reason
			: undefined;
	return {
		policy: current,
		eligible: value.eligible === true,
		...(reason !== undefined ? { reason } : {}),
		...(string(value.evidenceSource) !== undefined ? { evidenceSource: string(value.evidenceSource) } : {}),
	};
}

export function parseMergedModelView(value: unknown): MergedModelView | undefined {
	const base: DiscoveredModelView | undefined = parseDiscoveredModelView(value);
	if (base === undefined || !isObject(value)) {
		return undefined;
	}
	const status = parsePolicyStatusView(value.policyStatus);
	if (status === undefined) {
		return undefined;
	}
	const price = value.price === undefined ? undefined : parseMergedPriceView(value.price);
	if (value.price !== undefined && price === undefined) {
		// Uma linha com preço ilegível não é exibida sem preço: isso a faria
		// parecer "sem preço conhecido" quando na verdade há um número que a
		// ponte não conseguiu interpretar. A linha inteira é descartada.
		return undefined;
	}
	const declared = value.declaredAccess;
	return {
		...base,
		...(declared === 'free' || declared === 'paid' || declared === 'unknown'
			? { declaredAccess: declared }
			: {}),
		...(price !== undefined ? { price } : {}),
		policyStatus: status,
	};
}

export function parseAccessPolicyView(value: unknown): AccessPolicyView | undefined {
	if (!isObject(value)) {
		return undefined;
	}
	const current = policy(value.policy);
	const source = side(value.priceSource);
	const limitsSource = side(value.limitsSource);
	const capabilitiesSource = side(value.capabilitiesSource);
	if (current === undefined || source === undefined) {
		return undefined;
	}
	return {
		policy: current,
		priceSource: source,
		limitsSource: limitsSource ?? 'user',
		capabilitiesSource: capabilitiesSource ?? 'user',
		updatedAt: string(value.updatedAt) ?? new Date(0).toISOString(),
		changedBy: value.changedBy === 'phrase' ? 'phrase' : 'user',
		hint: string(value.hint) ?? 'Evelyn, use somente os modelos gratuitos',
	};
}

export function parseMergedCatalog(value: unknown): {
	readonly policy: AccessPolicyView;
	readonly models: readonly MergedModelView[];
} | undefined {
	if (!isObject(value)) {
		return undefined;
	}
	const current = parseAccessPolicyView(value.policy);
	if (current === undefined) {
		return undefined;
	}
	const models: MergedModelView[] = [];
	if (Array.isArray(value.models)) {
		for (const item of value.models) {
			const view = parseMergedModelView(item);
			if (view !== undefined) {
				models.push(view);
			}
		}
	}
	return { policy: current, models };
}
