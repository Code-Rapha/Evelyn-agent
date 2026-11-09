/**
 * The model catalog: what the user knows about each model, and what real runs
 * have measured.
 *
 * ## What this is for
 *
 * Evelyn will eventually recommend and choose models. It cannot do that from
 * a model id, so this is where the evidence lives: prices the user read off a
 * price page, capabilities the user declared, and latency measured on real
 * requests.
 *
 * ## What it deliberately is not
 *
 * A model id is not evidence. Nothing here is ever derived from one — a name
 * containing `free` says nothing about whether access is free, and a name
 * containing a year or a size says nothing about capability. Every field is
 * either declared by the user or observed by a real run, and a field with
 * neither stays absent. "Unknown" is a first-class value throughout, because a
 * guess that looks like data is worse than an empty field: it gets recommended
 * with.
 *
 * ## Declared and observed are separate fields, not a flag
 *
 * The split is structural rather than declared: a declared field can only be
 * written by `saveModelCatalogEntry`, an observation only by
 * `recordModelObservation`, and no call can do both. A `source: 'manual'` tag
 * would have been the alternative, and it would have been one forgotten
 * argument away from a measured latency wearing a user's declaration.
 *
 * ## Identity is the pair, never the model id
 *
 * Records are keyed by `(providerId, modelId)`. Two providers can both serve
 * `gpt-4o`, and keying on the model id alone would have one provider's price
 * page silently become the other's.
 *
 * ## Secrets
 *
 * No field here is a credential, and none is derived from one. `assertNoSecretFields`
 * runs on every write, and the record type has nowhere to put a key even if a
 * caller passed one.
 */
import type { TokenUsage } from '../../providers/chat/types';

/**
 * What access to a model costs the user.
 *
 * `unknown` is the default and is what a model that has never been classified
 * carries. It is deliberately a value rather than an absent field: the UI has to
 * say "not known" and a missing key would have it say nothing, or worse, guess.
 */
export type ModelAccess = 'free' | 'paid' | 'unknown';

/**
 * What a price is quoted per.
 *
 * Explicit, because "$0.0015" is meaningless without it — the same number is
 * a thousandth of a cent per token and a dollar and a half per million. Every
 * price carries one, so no consumer has to know the house convention.
 */
export type CostUnit = 'per_1k_tokens' | 'per_1m_tokens';

/**
 * Where a price came from.
 *
 * Recorded per price rather than per record because two facts in one record can
 * come from different places: the user may have copied the input price off a
 * page and typed the output one from a bill. `unknown` is the honest default for
 * a price nobody can attribute, and it is never treated as better or worse than
 * a named source here — that judgement belongs to whatever consumes it.
 */
export type PriceSource = 'manual' | 'provider' | 'unknown';

/**
 * A declared price.
 *
 * `input` and `output` are independently optional: providers publish them
 * separately and a user who has read only one of them must not have to invent
 * the other. Either being absent means that half of the cost is unknown, which
 * is different from the price being zero.
 *
 * ## Cached input
 *
 * Some providers bill prompt tokens they served from a cache at a different
 * rate. `cachedInput` is that rate, and it rides in this same block rather than
 * as a separate price so that there is exactly one currency and one unit for
 * the whole model: comparing a cached rate quoted per million against an input
 * rate quoted per thousand is the kind of arithmetic that produces a wrong
 * answer that looks right. When the provider does not differentiate, the field
 * is simply absent — never copied from `input`.
 *
 * ## Unit and precision
 *
 * The amount is a plain `number` per `unit` tokens. Prices are stored as the
 * value the user typed, not as a pre-divided per-token rate: dividing at write
 * time would round a price like `$0.0015 / 1k` to whatever the nearest double
 * is, and every later total would carry that error. Consumers that need a
 * per-token figure convert once, from this value, and label it as derived.
 */
export interface ModelPricing {
	/** Currency the amounts are in, e.g. `USD`. Never converted. */
	readonly currency: string;
	/** The denominator every amount here shares. */
	readonly unit: CostUnit;
	/** Cost per `unit` of input tokens. Absent = unknown. */
	readonly input?: number;
	/** Cost per `unit` of output tokens. Absent = unknown. */
	readonly output?: number;
	/** Cost per `unit` of input tokens served from the provider's cache. Absent = not differentiated. */
	readonly cachedInput?: number;
	/** Where the amounts came from. Absent = unknown. Never inferred. */
	readonly source?: PriceSource;
}

/**
 * Declared limits.
 *
 * A limit nobody has stated is absent, not zero. A zero context window would
 * read as "this model accepts nothing", which is a different and much stronger
 * claim than "we do not know".
 */
export interface ModelLimits {
	/** Total tokens the model accepts, prompt and answer together. */
	readonly contextTokens?: number;
	/** Tokens the model will produce in one answer. */
	readonly maxOutputTokens?: number;
}

/**
 * What a model can take as input.
 *
 * Deliberately not "vision: true": a model that reads images, one that reads
 * audio and one that reads both are different tools, and a single boolean would
 * have the picker recommend a speech model for a screenshot.
 */
export type InputModality = 'text' | 'image' | 'audio' | 'video' | 'file';

/**
 * What a model can produce.
 *
 * `text` is listed like any other rather than assumed: an embedding model takes
 * text and answers with a vector, and treating "it read my prompt" as "it can
 * write an answer" is exactly the guess that breaks a chat turn.
 */
export type OutputModality = 'text' | 'image' | 'audio';

/**
 * The capabilities a model is *known* to have, and to lack.
 *
 * ## Three states, not two
 *
 * For every field: `true` (declared or documented), `false` (the source says
 * it does not), and absent (nobody knows). The third is the default, and it is
 * not `false` — a model nobody has described is not "known to lack tools", it
 * is simply undescribed, and the difference decides whether the picker excludes
 * it or merely cannot favour it.
 *
 * Nothing here is derived from a model id. A name containing `vision`, `free`
 * or `4o` says nothing: those are conventions some vendors follow and others
 * do not, and a guess that reads like data ends up being routed on.
 *
 * When written from a source that does not mention a capability, the field is
 * left as it was (`mergeModelMetadata`), never cleared: a provider's endpoint
 * listing less than a page the user read is not the provider saying "no".
 */
export interface ModelCapabilities {
	readonly toolCalling?: boolean;
	readonly structuredOutput?: boolean;
	readonly reasoning?: boolean;
	/** Whether the model can take each kind of input, when the source says so. */
	readonly inputs?: Partial<Record<InputModality, boolean>>;
	readonly outputs?: Partial<Record<OutputModality, boolean>>;
}

/**
 * Where the limits and capabilities came from, and when.
 *
 * Kept beside the values rather than per capability, because a capability
 * matrix is almost always read from one place at one time; a price is the one
 * that commonly arrives from a second place, so it carries its own `source`.
 *
 * `stale` and `expiresAt` say whether the values in force are still current.
 * A fused entry inherits them from the side that won: a value that came from
 * an expired verification is *old*, and a decision made on it is less
 * informed — which the report has to be able to say.
 */
export interface ModelMetadataOrigin {
	readonly source: ModelMetadataSource;
	/** ISO-8601 timestamp of when the source was last read. Absent = not recorded. */
	readonly updatedAt?: string;
	/** The verification expired: the values are old. */
	readonly stale?: boolean;
	/** ISO-8601, when the verification stopped being current. */
	readonly expiresAt?: string;
}

/** Where limits and capabilities came from. Never a guess, so there is no `inferred`. */
export type ModelMetadataSource = 'manual' | 'provider' | 'unknown';

/** One measured request. Every number here is optional and nothing is inferred. */
export interface ModelObservation {
	/** ISO-8601 timestamp of when the request ended. */
	readonly at: string;
	/** Time to the first byte. `StreamTiming.firstByteMs`. */
	readonly firstByteMs?: number;
	/** Time to the end of the stream. `StreamTiming.totalMs`. */
	readonly totalMs?: number;
	/** What the provider reported the request cost. */
	readonly usage?: TokenUsage;
}

/**
 * One model as the catalog holds it.
 *
 * `access` has a default of `unknown`; everything else is absent until someone
 * says or measures it.
 */
export interface ModelCatalogEntry {
	readonly providerId: string;
	readonly modelId: string;
	/**
	 * Task categories the user says this model handles.
	 *
	 * Free text, not an enum. An enum would be a claim about what kinds of task
	 * exist, made before anyone has looked at what the user needs; a list the
	 * user types is a claim about their own use.
	 *
	 * Absent = not classified. `[]` = classified, and the model is good for
	 * nothing on the list. The difference matters, so it is preserved.
	 */
	readonly capabilities?: readonly string[];
	/** Absent when no price is known. */
	readonly pricing?: ModelPricing;
	readonly access: ModelAccess;
	/** Absent when no limits are known. */
	readonly limits?: ModelLimits;
	/**
	 * What the model is known to accept, produce and do.
	 *
	 * Separate from `capabilities` above, which is the user's free-text list of
	 * *task categories* ("code", "long documents"). This one is structural
	 * modality and feature support, with three states per field; keeping them
	 * apart means a typed category can never be mistaken for a boolean fact.
	 */
	readonly model?: ModelCapabilities;
	/** Where `limits` and `model` came from. Absent = unknown. */
	readonly metadata?: ModelMetadataOrigin;
	readonly notes?: string;
	/**
	 * What real requests measured, oldest first.
	 *
	 * Bounded by the store: see `MODEL_OBSERVATION_LIMIT`. A window rather than
	 * a running total, so the median is exact and a model that has been idle for
	 * a month does not carry an average of its own busy week.
	 */
	readonly observations: readonly ModelObservation[];
	readonly createdAt: string;
	readonly updatedAt: string;
}

/**
 * The identity of a catalog record.
 *
 * A pair and not a string id, so no delimiter can be mis-split and two providers
 * offering the same model stay separate.
 */
export interface ModelCatalogKey {
	readonly providerId: string;
	readonly modelId: string;
}

/**
 * A declared update to one record.
 *
 * Three states per field, which is why this is not a partial `ModelCatalogEntry`:
 *
 * - **omitted** — leave whatever is stored alone
 * - **`null`** — clear it back to unknown
 * - **a value** — set it
 *
 * Without the middle state "unknown" would be unreachable: omitting a field on
 * a record that already has one could mean either, and the field the user was
 * trying to clear would be impossible to clear.
 *
 * `pricing` and `limits` are replaced whole rather than merged. Merging would
 * make "I only know the input price" mean two different things depending on what
 * was there before.
 *
 * `model` is the exception: it is **merged field by field**, because it exists
 * precisely to accumulate facts from different sources, one at a time. A
 * provider listing that mentions tool support but not vision must not clear a
 * vision flag the user read elsewhere. To clear it, send the field as `null`
 * inside `model`, or clear the whole thing with `model: null`.
 */
export interface SaveModelCatalogInput {
	readonly providerId: string;
	readonly modelId: string;
	readonly capabilities?: readonly string[] | null;
	readonly pricing?: ModelPricing | null;
	readonly access?: ModelAccess;
	readonly limits?: ModelLimits | null;
	/** Merged, not replaced. `null` clears it. */
	readonly model?: ModelCapabilitiesPatch | null;
	/** Absent leaves it alone; `null` clears the origin. */
	readonly metadata?: Omit<ModelMetadataOrigin, 'updatedAt'> & {
		readonly updatedAt?: string;
	} | null;
	readonly notes?: string | null;
}

/**
 * A partial capability update.
 *
 * Each field is three-state, like `SaveModelCatalogInput` at the record level:
 * omitted leaves it, `null` clears it to unknown, a value sets it. The nested
 * modality maps follow the same rule one level down, so a source can update
 * `image` without having to restate `audio`.
 */
export interface ModelCapabilitiesPatch {
	readonly toolCalling?: boolean | null;
	readonly structuredOutput?: boolean | null;
	readonly reasoning?: boolean | null;
	readonly inputs?: Partial<Record<InputModality, boolean | null>>;
	readonly outputs?: Partial<Record<OutputModality, boolean | null>>;
}

/** What the catalog can do, and what it can never do to anything else. */
export interface ModelCatalogPort {
	/**
	 * Every record, optionally narrowed to one provider.
	 *
	 * A missing file reads as an empty catalog, so a first run is not a failure.
	 */
	listModelCatalog(filter?: {
		readonly providerId?: string;
	}): Promise<readonly ModelCatalogEntry[]>;
	/** One record, or `undefined` when it has never been described. */
	getModelCatalogEntry(key: ModelCatalogKey): Promise<ModelCatalogEntry | undefined>;
	/**
	 * Creates the record, or updates the declared fields of an existing one.
	 *
	 * Upsert rather than create-or-fail: the same model is described again as
	 * the user learns more about it, and a second record for the same pair would
	 * make every later read depend on which one happened to be first in the file.
	 * Observations are never touched here.
	 */
	saveModelCatalogEntry(input: SaveModelCatalogInput): Promise<ModelCatalogEntry>;
	/**
	 * Forgets one record's declared metadata.
	 *
	 * Returns false when there was nothing there. The provider's connection
	 * configuration and its stored key are in different files and are not
	 * reachable from here — deleting a note about a model must not un-configure
	 * it.
	 */
	removeModelCatalogEntry(key: ModelCatalogKey): Promise<boolean>;
	/**
	 * Appends one measurement to a record, creating it if it does not exist.
	 *
	 * Creating on demand is what lets a run record a latency for a model nobody
	 * has bothered to describe, which is how an observation ends up next to no
	 * declaration — the honest state for a model the user has only used.
	 */
	recordModelObservation(
		key: ModelCatalogKey,
		observation: Omit<ModelObservation, 'at'> & { readonly at?: string },
	): Promise<ModelCatalogEntry>;
	/**
	 * Folds a bundle of metadata from one source into one record.
	 *
	 * The single entry point for anything that is not a hand-entered field: a
	 * local metadata file today, a fetched catalogue tomorrow. It goes through
	 * the same store and the same merge rules, so there is one answer to "can a
	 * source overwrite what the user typed" (`mergeModelMetadata`), and no
	 * second writer that could disagree with it.
	 *
	 * Never touches observations, `access` or `notes`: those are not metadata a
	 * source may set. A model the record does not exist for is created, exactly
	 * as an observation would create it.
	 */
	applyModelMetadata(
		key: ModelCatalogKey,
		metadata: ModelMetadataInput,
	): Promise<ModelCatalogEntry>;
}

/**
 * What a metadata source says about one model.
 *
 * A bundle rather than a flat argument list because it is what a provider
 * interface returns: one object per model, describing it as completely as that
 * source can. Every field is optional, and an absent field means "this source
 * says nothing", never "this source says no".
 */
export interface ModelMetadataInput {
	/** ISO-8601 timestamp of when the source was read. Defaults to the write time. */
	readonly updatedAt?: string;
	readonly pricing?: ModelPricing;
	readonly limits?: ModelLimits;
	readonly model?: ModelCapabilitiesPatch;
	/**
	 * Where this bundle came from. Required: an unattributed bundle is exactly
	 * the kind of fact that later cannot be told apart from a guess.
	 */
	readonly source: Exclude<ModelMetadataSource, 'unknown'>;
}

/**
 * How many observations a record keeps.
 *
 * Bounded because the alternative grows forever: every chat turn would append
 * one, and a file that grows for the life of the install is a file that has to
 * be loaded in full on every read. Twenty is enough for a median to stop
 * moving, and old enough samples falling out of the window is the honest
 * behaviour — they were measured under conditions that no longer hold.
 */
export const MODEL_OBSERVATION_LIMIT = 20;

/** A record with no observations at all. */
export function hasObservations(entry: ModelCatalogEntry): boolean {
	return entry.observations.length > 0;
}

/**
 * Whether anything is known about a model at all.
 *
 * False means the record exists but says nothing, which the UI has to state
 * rather than render as a blank row that looks like a loading failure.
 */
export function isDescribed(entry: ModelCatalogEntry): boolean {
	return (
		entry.capabilities !== undefined ||
		entry.pricing !== undefined ||
		entry.access !== 'unknown' ||
		entry.limits !== undefined ||
		entry.model !== undefined ||
		entry.metadata !== undefined ||
		entry.notes !== undefined ||
		// An entry is only ever created with an observation or a description,
		// so an empty one is a draft somebody wrote and abandoned. It is not a
		// description, and it must not make the model look known.
		entry.observations.length > 0
	);
}

/**
 * Folds a patch into the stored capabilities without losing what is there.
 *
 * Three-state at every level: omitted keeps, `null` clears, a value sets. The
 * modality maps are merged entry by entry for the same reason the top level is
 * — a source that knows about images says nothing about audio.
 *
 * A patch that changes nothing returns `undefined`, so the caller can leave the
 * field absent instead of writing an empty object that looks like a statement.
 */
export function mergeModelCapabilities(
	current: ModelCapabilities | undefined,
	patch: ModelCapabilitiesPatch,
): ModelCapabilities | undefined {
	const next: {
		toolCalling?: boolean;
		structuredOutput?: boolean;
		reasoning?: boolean;
		inputs?: Partial<Record<InputModality, boolean>>;
		outputs?: Partial<Record<OutputModality, boolean>>;
	} = {
		...(current?.toolCalling !== undefined ? { toolCalling: current.toolCalling } : {}),
		...(current?.structuredOutput !== undefined ? { structuredOutput: current.structuredOutput } : {}),
		...(current?.reasoning !== undefined ? { reasoning: current.reasoning } : {}),
	};

	const flags: (keyof Pick<ModelCapabilities, 'toolCalling' | 'structuredOutput' | 'reasoning'>)[] = [
		'toolCalling',
		'structuredOutput',
		'reasoning',
	];
	for (const flag of flags) {
		const value = patch[flag];
		if (value === null) {
			delete next[flag];
		} else if (value !== undefined) {
			next[flag] = value;
		}
	}

	const inputs = mergeModalities<InputModality>(current?.inputs, patch.inputs);
	if (inputs !== undefined) {
		next.inputs = inputs;
	}
	const outputs = mergeModalities<OutputModality>(current?.outputs, patch.outputs);
	if (outputs !== undefined) {
		next.outputs = outputs;
	}

	return Object.keys(next).length === 0 ? undefined : next;
}

/** One modality map, merged. Shared by inputs and outputs; the key domain differs only in type. */
function mergeModalities<K extends string>(
	current: Partial<Record<K, boolean>> | undefined,
	patch: Partial<Record<K, boolean | null>> | undefined,
): Partial<Record<K, boolean>> | undefined {
	if (patch === undefined) {
		return current;
	}
	const next: Partial<Record<K, boolean>> = { ...current };
	for (const [label, value] of Object.entries(patch) as [K, boolean | null | undefined][]) {
		if (value === null) {
			delete next[label];
		} else if (value !== undefined) {
			next[label] = value;
		}
	}
	return Object.keys(next).length === 0 ? undefined : next;
}
