/**
 * A model, as everything the catalog knows about it reads at once.
 *
 * ## Why a view rather than the entry itself
 *
 * A `ModelCatalogEntry` is a *file*: absent fields, a free-text capability list,
 * prices in whatever unit the user typed them in. A consumer that compares
 * models (a picker, a cost display, a future budget) should not have to
 * re-derive the same three rules every time:
 *
 * 1. absent is not zero;
 * 2. absent is not `false`;
 * 3. a price in `per_1k_tokens` and one in `per_1m_tokens` are not numbers
 *    that can be compared without saying so.
 *
 * `describeModel` states those once. It never fills a gap: a model with no
 * price comes back `known: false`, and a capability nobody stated comes back
 * `unknown`, not `false`.
 *
 * ## Identity
 *
 * The view is addressed by `(providerId, modelId)`. Two providers serving the
 * same `gpt-4o` are two different models with two different prices, and there
 * is deliberately no lookup that takes a model id alone.
 *
 * ## What this is not
 *
 * No recommendation, no ranking, no turn cost estimate, no spending decision.
 * The paid-access check stays where it is (`isPaidBlocked`, from `access`), and
 * nothing here can relax it: a price is evidence, never a permission.
 */
import type {
	CostUnit,
	ModelAccess,
	ModelCapabilities,
	ModelCatalogEntry,
	ModelCatalogKey,
	ModelLimits,
	ModelPricing,
	ModelMetadataSource,
	PriceSource,
} from '../../storage/types/modelCatalog';
import { isDescribed } from '../../storage/types/modelCatalog';

/** One price amount and where it came from. */
export interface KnownPrice {
	/** The amount per `unit`, exactly as stored. Never a per-token pre-division. */
	readonly amount: number;
	readonly source: PriceSource;
}

/**
 * The price of one direction of tokens.
 *
 * Three states, all first-class:
 *
 * - `unknown` — no amount and no evidence it is free;
 * - `free` — an amount of exactly zero, which *is* evidence;
 * - `known` — a positive amount.
 *
 * A missing amount is `unknown`. It is never `free`, and never `0`.
 */
export type PriceState =
	| { readonly state: 'unknown' }
	| { readonly state: 'free'; readonly source: PriceSource }
	| { readonly state: 'known'; readonly price: KnownPrice };

/** Everything known about what a model costs. */
export interface ModelCostView {
	/**
	 * Whether the sources agree the model costs nothing at all.
	 *
	 * True only when both input and output are known to be free. One free side
	 * says nothing about the other, so a model with a free input and an unknown
	 * output is *not* free.
	 */
	readonly free: boolean;
	/** Whether any amount is known. A partially priced model is `known: true` and still not free. */
	readonly known: boolean;
	/** The currency and denominator the amounts below share, when any amount is known. */
	readonly currency?: string;
	readonly unit?: CostUnit;
	readonly input: PriceState;
	readonly output: PriceState;
	/** When the provider bills cache-served input differently. Absent = not differentiated. */
	readonly cachedInput?: KnownPrice;
}

/**
 * One declared capability, with its three states spelled out.
 *
 * `unknown` is not the same as `unsupported`: the first says the source was
 * silent, the second says it said no. A picker that needs tools treats them
 * very differently — one may be tried, the other should not be chosen.
 */
export type TriState = 'supported' | 'unsupported' | 'unknown';

/** What the view says about the model's capabilities and limits. */
export interface ModelCapabilityView {
	/** Total input+output window, when stated. Absent = unknown, never zero. */
	readonly contextTokens?: number;
	/** The response budget, when stated separately. Never copied from `contextTokens`. */
	readonly maxOutputTokens?: number;
	readonly toolCalling: TriState;
	readonly structuredOutput: TriState;
	readonly reasoning: TriState;
	/** Modalities the model is known to accept, in the declared order given. */
	readonly inputs: Readonly<Partial<Record<string, TriState>>>;
	/** Modalities the model is known to produce. */
	readonly outputs: Readonly<Partial<Record<string, TriState>>>;
}

/** The full readable view of one model. */
export interface ModelMetadataView {
	readonly providerId: string;
	readonly modelId: string;
	/** The existing access classification, passed through untouched. */
	readonly access: ModelAccess;
	readonly cost: ModelCostView;
	readonly capabilities: ModelCapabilityView;
	/** Where the limits and capabilities came from. */
	readonly source: ModelMetadataSource;
	/** When that source was last read, when recorded. */
	readonly sourceUpdatedAt?: string;
	/** The user's task categories. Absent = unclassified; `[]` = classified as nothing. */
	readonly categories?: readonly string[];
	/** Whether *anything* is known beyond the model's identity. */
	readonly described: boolean;
}

const UNKNOWN: PriceState = { state: 'unknown' };

/**
 * Reads one direction of the price.
 *
 * Zero is the only amount that means free. A negative or non-finite amount is
 * refused at write time, and would here be read as unknown rather than as a
 * strange negative price.
 */
function priceState(amount: number | undefined, source: PriceSource): PriceState {
	if (amount === undefined || !Number.isFinite(amount) || amount < 0) {
		return UNKNOWN;
	}
	return amount === 0
		? { state: 'free', source }
		: { state: 'known', price: { amount, source } };
}

function costView(pricing: ModelPricing | undefined): ModelCostView {
	if (pricing === undefined) {
		// No pricing block at all: nothing is known, and nothing is free.
		return { free: false, known: false, input: UNKNOWN, output: UNKNOWN };
	}
	const source: PriceSource = pricing.source ?? 'unknown';
	const input = priceState(pricing.input, source);
	const output = priceState(pricing.output, source);
	const known = input.state !== 'unknown' || output.state !== 'unknown';
	return {
		free: input.state === 'free' && output.state === 'free',
		known,
		...(known ? { currency: pricing.currency, unit: pricing.unit } : {}),
		input,
		output,
		...(pricing.cachedInput !== undefined && Number.isFinite(pricing.cachedInput) && pricing.cachedInput >= 0
			? { cachedInput: { amount: pricing.cachedInput, source } }
			: {}),
	};
}

function triState(value: boolean | undefined): TriState {
	if (value === undefined) {
		return 'unknown';
	}
	return value ? 'supported' : 'unsupported';
}

function modalityView<K extends string>(
	values: Partial<Record<K, boolean>> | undefined,
): Readonly<Partial<Record<K, TriState>>> {
	if (values === undefined) {
		return {} as Readonly<Partial<Record<K, TriState>>>;
	}
	const next: Partial<Record<K, TriState>> = {};
	for (const [label, value] of Object.entries(values) as [K, boolean | undefined][]) {
		if (value !== undefined) {
			next[label] = triState(value);
		}
	}
	return next;
}

/**
 * Context and output limits, kept apart.
 *
 * A context window is prompt *plus* answer, so it is an upper bound on the
 * answer, never the answer's budget. A model that states only a context window
 * therefore has `maxOutputTokens` unknown — the view never substitutes one for
 * the other, because a request built on that substitution would be sized for a
 * reply the endpoint then refuses.
 */
function limitsView(limits: ModelLimits | undefined): Pick<ModelCapabilityView, 'contextTokens' | 'maxOutputTokens'> {
	if (limits === undefined) {
		return {};
	}
	return {
		...(limits.contextTokens !== undefined ? { contextTokens: limits.contextTokens } : {}),
		...(limits.maxOutputTokens !== undefined ? { maxOutputTokens: limits.maxOutputTokens } : {}),
	};
}

function capabilitiesView(
	model: ModelCapabilities | undefined,
	limits: ModelLimits | undefined,
): ModelCapabilityView {
	return {
		...limitsView(limits),
		toolCalling: triState(model?.toolCalling),
		structuredOutput: triState(model?.structuredOutput),
		reasoning: triState(model?.reasoning),
		inputs: modalityView(model?.inputs),
		outputs: modalityView(model?.outputs),
	};
}

/**
 * Describes one catalog entry.
 *
 * Pure: given the same entry, the same view. It never reads the store, the
 * network or the clock.
 */
export function describeModel(entry: ModelCatalogEntry): ModelMetadataView {
	const cost = costView(entry.pricing);
	const capabilities = capabilitiesView(entry.model, entry.limits);
	return {
		providerId: entry.providerId,
		modelId: entry.modelId,
		access: entry.access,
		cost,
		capabilities,
		source: entry.metadata?.source ?? 'unknown',
		...(entry.metadata?.updatedAt !== undefined ? { sourceUpdatedAt: entry.metadata.updatedAt } : {}),
		...(entry.capabilities !== undefined ? { categories: [...entry.capabilities] } : {}),
		// One rule for both views: `isDescribed` is what decides whether an
		// entry says anything about a model, so the view cannot disagree with it.
		described: isDescribed(entry),
	};
}

/** Reads the metadata of one model, or `undefined` when nothing is recorded for it. */
export async function describeModelById(
	catalog: { getModelCatalogEntry(key: ModelCatalogKey): Promise<ModelCatalogEntry | undefined> },
	key: ModelCatalogKey,
): Promise<ModelMetadataView | undefined> {
	const entry = await catalog.getModelCatalogEntry(key);
	return entry === undefined ? undefined : describeModel(entry);
}

/**
 * Describes every recorded model, keyed by its `(providerId, modelId)` pair.
 *
 * A map rather than a list so a caller matching against available models does
 * not rebuild the same lookup — and so a model id shared by two providers stays
 * two entries instead of one that the last writer wins.
 */
export function describeModels(entries: readonly ModelCatalogEntry[]): ReadonlyMap<string, ModelMetadataView> {
	const views = new Map<string, ModelMetadataView>();
	for (const entry of entries) {
		views.set(modelMetadataKey(entry), describeModel(entry));
	}
	return views;
}

/**
 * The map key for a model pair.
 *
 * `JSON.stringify` of the two strings, for the same reason the store values its
 * catalog by that: neither a provider id nor a model id is guaranteed to avoid
 * any delimiter one might pick.
 */
export function modelMetadataKey(key: ModelCatalogKey): string {
	return JSON.stringify([key.providerId, key.modelId]);
}
