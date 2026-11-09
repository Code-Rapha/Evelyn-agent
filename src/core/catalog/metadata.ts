/**
 * Fusão dos metadados de um modelo: limites e capacidades.
 *
 * ## O que esta etapa acrescenta à fusão do preço
 *
 * O preço (5E) tem uma complicação própria — moeda e unidade — e por isso tem
 * o seu módulo. Limites e capacidades são mais simples: um número de tokens ou
 * um estado de capacidade. Mas as *regras* são as mesmas, e é por isso que
 * esta fusão é genérica: um campo, dois lados, uma escolha.
 *
 * ## As cinco regras
 *
 * 1. **Ausente não é `false`, não é zero, não é ilimitado.** Um campo que
 *    nenhum dos lados informou fica ausente, e a tela diz "desconhecido".
 * 2. **Nada é trocado sozinho.** O lado declarado é o padrão; o lado
 *    descoberto só entra quando o usuário escolheu, e a escolha é
 *    reversível porque o valor declarado continua intacto.
 * 3. **Vencido não é atual.** Um valor descoberto cuja validade acabou pode ser
 *    exibido, com a marca, mas não pode ser escolhido.
 * 4. **Conflito é exibido, não resolvido.** Quando os dois lados discordam, a
 *    tela mostra os dois e a escolha decide. Um conflito nunca é "resolvido"
 *    por quem sabe mais.
 * 5. **Unidades incompatíveis não se fundem.** Para limites, a unidade é o
 *    token e os dois lados falam de tokens do mesmo modelo: comparáveis. Se um
 *    lado viesse em outra unidade, a fusão recusaria em vez de converter.
 *
 * ## Capacidades: quem pode dizer "não"
 *
 * Uma capacidade tem três estados, e o projeto já os tinha: `true` (a fonte
 * diz que tem), `false` (a fonte diz que não tem) e ausente (ninguém sabe).
 * A lista de parâmetros suportados que um provedor publica é uma enumeração
 * completa: o que não está nela não é suportado. Quando o provedor **não**
 * publica a lista, nada é afirmado — nem `true`, nem `false`.
 */
import type {
	InputModality,
	ModelCapabilities,
	ModelCatalogEntry,
	ModelLimits,
	OutputModality,
} from '../storage/types/modelCatalog';

/** De que lado o valor em vigor vem. */
export type MetadataSide = 'user' | 'discovered';

/** Um valor descoberto, com a procedência e a validade. */
export interface DiscoveredValue<T> {
	readonly value: T;
	readonly source: string;
	readonly verifiedAt: string;
	readonly expiresAt: string;
	readonly stale: boolean;
}

/** O que a tela mostra para um campo fundido. */
export interface FusedField<T> {
	/** O valor declarado pelo usuário. Ausente = não declarado. */
	readonly user?: T;
	/** O valor publicado pelo provedor, com a procedência. */
	readonly discovered?: DiscoveredValue<T>;
	/** Os dois lados existem e discordam. */
	readonly conflict: boolean;
	/** De que lado o valor em vigor vem. */
	readonly selected: MetadataSide;
	/** O valor em vigor. Ausente = ninguém sabe. */
	readonly effective?: T;
	/** A escolha caiu para o outro lado; nunca é troca silenciosa. */
	readonly fellBack: boolean;
	/** Por que o lado escolhido não pôde ser usado, quando não pôde. */
	readonly unusableReason?: string;
}

/** O que a fusão precisa saber de um valor descoberto. */
export interface DiscoveredFieldInput<T> {
	readonly value: T;
	readonly source: string;
	readonly verifiedAt: string;
	readonly expiresAt: string;
	readonly stale: boolean;
}

/** Um valor pode ser usado agora? Vencido ou marcado, não. */
export function fieldUsable(
	discovered: { readonly expiresAt: string; readonly stale: boolean } | undefined,
	nowMs: number,
): { readonly usable: boolean; readonly reason?: string } {
	if (discovered === undefined) {
		return { usable: false, reason: 'não publicado' };
	}
	if (discovered.stale) {
		return { usable: false, reason: 'a última atualização do provedor falhou' };
	}
	const at = Date.parse(discovered.expiresAt);
	if (Number.isNaN(at) || at <= nowMs) {
		return { usable: false, reason: 'a verificação venceu' };
	}
	return { usable: true };
}

/** Dois valores são o mesmo? Comparação estrutural, sem converter nada. */
function sameValue<T>(a: T | undefined, b: T | undefined): boolean {
	if (a === undefined || b === undefined) {
		return a === b;
	}
	if (typeof a === 'number' && typeof b === 'number') {
		return a === b;
	}
	if (typeof a === 'boolean' && typeof b === 'boolean') {
		return a === b;
	}
	if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
		return JSON.stringify(a) === JSON.stringify(b);
	}
	return a === b;
}

/**
 * Funde um campo com os seus dois lados.
 *
 * `chosen` é o que o usuário pediu. Ele nunca é honrado às cegas: pedir o lado
 * descoberto exige que ele exista, esteja fresco e seja usável; caso
 * contrário, o declarado vale e `fellBack` diz por quê.
 */
export function fuseField<T>(input: {
	readonly user?: T;
	readonly discovered?: DiscoveredFieldInput<T>;
	readonly chosen: MetadataSide;
	readonly nowMs: number;
}): FusedField<T> {
	const { user, discovered, chosen, nowMs } = input;
	const usable = fieldUsable(discovered, nowMs);
	const conflict = user !== undefined && discovered !== undefined && !sameValue(user, discovered.value);

	const build = (
		selected: MetadataSide,
		effective: T | undefined,
		fellBack: boolean,
		unusableReason?: string,
	): FusedField<T> => ({
		...(user !== undefined ? { user } : {}),
		...(discovered !== undefined
			? {
					discovered: {
						value: discovered.value,
						source: discovered.source,
						verifiedAt: discovered.verifiedAt,
						expiresAt: discovered.expiresAt,
						stale: discovered.stale,
					},
				}
			: {}),
		conflict,
		selected,
		...(effective !== undefined ? { effective } : {}),
		fellBack,
		...(unusableReason !== undefined ? { unusableReason } : {}),
	});

	if (chosen === 'discovered') {
		if (discovered === undefined) {
			return build('user', user, true, 'não publicado');
		}
		if (!usable.usable) {
			return build('user', user, true, usable.reason);
		}
		return build('discovered', discovered.value, false);
	}

	// O lado declarado é o padrão. Quando não há nada declarado, o valor
	// descoberto usable é o que existe — e a escolha registrada como
	// `user` continua sendo a do usuário, que é a do catálogo.
	if (user === undefined && discovered !== undefined && usable.usable) {
		return build('discovered', discovered.value, false);
	}
	return build('user', user, false);
}

/** Os limites fundidos: janela de contexto e limite de saída, um por um. */
export interface FusedLimits {
	readonly contextTokens?: FusedField<number>;
	readonly maxOutputTokens?: FusedField<number>;
	/** A janela de contexto e o limite de saída nunca se misturam. */
	readonly merged: boolean;
}

/**
 * Funde os limites.
 *
 * `contextTokens` e `maxOutputTokens` são campos separados de propósito: a
 * janela é prompt **mais** resposta, e nunca é o orçamento da resposta. Um
 * provedor que publica só a janela deixa o limite de saída desconhecido.
 */
export function fuseLimits(input: {
	readonly user?: ModelLimits;
	readonly discovered?: DiscoveredFieldInput<ModelLimits>;
	readonly chosen: MetadataSide;
	readonly nowMs: number;
}): FusedLimits {
	const fuse = (
		key: 'contextTokens' | 'maxOutputTokens',
	): FusedField<number> | undefined => {
		const userValue = input.user?.[key];
		const discoveredValue = input.discovered?.value[key];
		if (userValue === undefined && discoveredValue === undefined) {
			return undefined;
		}
		return fuseField<number>({
			...(userValue !== undefined ? { user: userValue } : {}),
			...(discoveredValue !== undefined && input.discovered !== undefined
				? {
						discovered: {
							value: discoveredValue,
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
	};
	const contextTokens = fuse('contextTokens');
	const maxOutputTokens = fuse('maxOutputTokens');
	return {
		...(contextTokens !== undefined ? { contextTokens } : {}),
		...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
		merged: false,
	};
}

/** O valor de um campo fundido, ou `undefined` se ninguém sabe. */
export function effectiveLimit(field: FusedField<number> | undefined): number | undefined {
	return field?.effective;
}

/**
 * As capacidades fundidas, campo por campo.
 *
 * Cada campo tem o seu próprio lado declarado e o seu próprio lado
 * descoberto. Uma lista de capacidades publicada pelo provedor cobre
 * `toolCalling`, `structuredOutput` e `reasoning`; as modalidades têm listas
 * próprias, e uma modalidade que nenhuma das listas menciona fica
 * **desconhecida** — não `false`.
 */
export interface FusedCapabilities {
	readonly toolCalling?: FusedField<boolean>;
	readonly structuredOutput?: FusedField<boolean>;
	readonly reasoning?: FusedField<boolean>;
	readonly inputs: Readonly<Partial<Record<InputModality, FusedField<boolean>>>>;
	readonly outputs: Readonly<Partial<Record<OutputModality, FusedField<boolean>>>>;
	/** A lista do provedor é uma enumeração: o que não está nela não é suportado. */
	readonly enumerated: boolean;
}

/** As três capacidades que a lista de parâmetros cobre. */
const BOOLEAN_CAPABILITIES = ['toolCalling', 'structuredOutput', 'reasoning'] as const;
type BooleanCapability = (typeof BOOLEAN_CAPABILITIES)[number];

export function fuseCapabilities(input: {
	readonly user?: ModelCapabilities;
	readonly discovered?: DiscoveredFieldInput<ModelCapabilities>;
	readonly chosen: MetadataSide;
	readonly nowMs: number;
}): FusedCapabilities {
	const fuseBoolean = (key: BooleanCapability): FusedField<boolean> | undefined => {
		const userValue = input.user?.[key];
		const discoveredValue = input.discovered?.value[key];
		if (userValue === undefined && discoveredValue === undefined) {
			return undefined;
		}
		return fuseField<boolean>({
			...(userValue !== undefined ? { user: userValue } : {}),
			...(discoveredValue !== undefined && input.discovered !== undefined
				? {
						discovered: {
							value: discoveredValue,
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
	};

	const fuseModalities = (
		key: 'inputs' | 'outputs',
	): Readonly<
		Partial<Record<InputModality, FusedField<boolean>>> & Partial<Record<OutputModality, FusedField<boolean>>>
	> => {
		const result: Record<string, FusedField<boolean>> = {};
		const userSide: Record<string, boolean | undefined> = input.user?.[key] ?? {};
		const discoveredSide: Record<string, boolean | undefined> = input.discovered?.value[key] ?? {};
		const modalities = new Set<string>([
			...Object.keys(userSide),
			...Object.keys(discoveredSide),
		]);
		for (const modality of modalities) {
			const userValue = userSide[modality];
			const discoveredValue = discoveredSide[modality];
			if (userValue === undefined && discoveredValue === undefined) {
				continue;
			}
			result[modality] = fuseField<boolean>({
				...(userValue !== undefined ? { user: userValue } : {}),
				...(discoveredValue !== undefined && input.discovered !== undefined
					? {
							discovered: {
								value: discoveredValue,
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
		}
		return result;
	};

	return {
		...(() => {
			const toolCalling = fuseBoolean('toolCalling');
			const structuredOutput = fuseBoolean('structuredOutput');
			const reasoning = fuseBoolean('reasoning');
			return {
				...(toolCalling !== undefined ? { toolCalling } : {}),
				...(structuredOutput !== undefined ? { structuredOutput } : {}),
				...(reasoning !== undefined ? { reasoning } : {}),
			};
		})(),
		inputs: fuseModalities('inputs'),
		outputs: fuseModalities('outputs'),
		enumerated: input.discovered !== undefined,
	};
}

/** O tri-estado efetivo de um campo fundido: `true`, `false` ou desconhecido. */
export function effectiveTriState(field: FusedField<boolean> | undefined): boolean | undefined {
	return field?.effective;
}

/**
 * As capacidades efetivas, no formato que o catálogo usa.
 *
 * É isto que o seletor e a tela leem: um campo ausente continua ausente, e um
 * `false` continua sendo "a fonte diz que não".
 */
export function effectiveCapabilities(fused: FusedCapabilities): ModelCapabilities {
	const pick = (field: FusedField<boolean> | undefined): boolean | undefined => field?.effective;
	const inputs: Partial<Record<InputModality, boolean>> = {};
	for (const [modality, field] of Object.entries(fused.inputs) as [
		InputModality,
		FusedField<boolean>,
	][]) {
		const value = pick(field);
		if (value !== undefined) {
			inputs[modality] = value;
		}
	}
	const outputs: Partial<Record<OutputModality, boolean>> = {};
	for (const [modality, field] of Object.entries(fused.outputs) as [
		OutputModality,
		FusedField<boolean>,
	][]) {
		const value = pick(field);
		if (value !== undefined) {
			outputs[modality] = value;
		}
	}
	const toolCalling = pick(fused.toolCalling);
	const structuredOutput = pick(fused.structuredOutput);
	const reasoning = pick(fused.reasoning);
	return {
		...(toolCalling !== undefined ? { toolCalling } : {}),
		...(structuredOutput !== undefined ? { structuredOutput } : {}),
		...(reasoning !== undefined ? { reasoning } : {}),
		...(Object.keys(inputs).length > 0 ? { inputs } : {}),
		...(Object.keys(outputs).length > 0 ? { outputs } : {}),
	};
}

/** Os limites efetivos, no formato que o catálogo usa. */
export function effectiveLimits(fused: FusedLimits): ModelLimits | undefined {
	const contextTokens = effectiveLimit(fused.contextTokens);
	const maxOutputTokens = effectiveLimit(fused.maxOutputTokens);
	if (contextTokens === undefined && maxOutputTokens === undefined) {
		return undefined;
	}
	return {
		...(contextTokens !== undefined ? { contextTokens } : {}),
		...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
	};
}

/**
 * De que lado cada grupo de metadado vale.
 *
 * Três grupos, três escolhas: o preço, os limites e as capacidades mudam em
 * ritmos diferentes, e um usuário que aceita o preço do provedor não está
 * necessariamente dizendo o mesmo sobre a janela de contexto.
 */
export interface MetadataPreferences {
	readonly priceSource: 'user' | 'discovered';
	readonly limitsSource: 'user' | 'discovered';
	readonly capabilitiesSource: 'user' | 'discovered';
}

/** O que o provedor publicou sobre um modelo, para a fusão. */
export interface DiscoveredMetadata {
	readonly limits?: DiscoveredFieldInput<ModelLimits>;
	readonly capabilities?: DiscoveredFieldInput<ModelCapabilities>;
}

/**
 * Funde um registro do catálogo com o que o provedor publicou.
 *
 * Devolve um **novo** registro: o declarado continua intacto no disco, e o
 * que o seletor e a tela leem é o fundido. É o que garante que os limites
 * efetivos usados pelo roteador sejam exatamente os exibidos.
 */
export function fuseCatalogEntry(input: {
	readonly entry: ModelCatalogEntry;
	readonly discovered?: DiscoveredMetadata;
	readonly preferences: MetadataPreferences;
	readonly nowMs: number;
}): ModelCatalogEntry {
	const { entry, discovered, preferences, nowMs } = input;
	const limits = fuseLimits({
		...(entry.limits !== undefined ? { user: entry.limits } : {}),
		...(discovered?.limits !== undefined ? { discovered: discovered.limits } : {}),
		chosen: preferences.limitsSource,
		nowMs,
	});
	const capabilities = fuseCapabilities({
		...(entry.model !== undefined ? { user: entry.model } : {}),
		...(discovered?.capabilities !== undefined ? { discovered: discovered.capabilities } : {}),
		chosen: preferences.capabilitiesSource,
		nowMs,
	});
	const effectiveLimitsValue = effectiveLimits(limits);
	const effectiveCapabilitiesValue = effectiveCapabilities(capabilities);
	// A procedência do que está em vigor. Quando o lado escolhido é o
	// descoberto, a validade vem dele: um valor que venceu é um dado velho, e
	// a decisão feita sobre ele é menos informada.
	const discoveredStale =
		discovered?.limits?.stale === true ||
		discovered?.limits?.expiresAt !== undefined &&
			Date.parse(discovered.limits.expiresAt) <= nowMs ||
		discovered?.capabilities?.stale === true ||
		discovered?.capabilities?.expiresAt !== undefined &&
			Date.parse(discovered.capabilities.expiresAt) <= nowMs;
	const discoveredExpiresAt = [
		discovered?.limits?.expiresAt,
		discovered?.capabilities?.expiresAt,
	]
		.filter((value): value is string => value !== undefined)
		.sort()[0];
	const usedDiscovered =
		(preferences.limitsSource === 'discovered' && limits.contextTokens !== undefined) ||
		(preferences.capabilitiesSource === 'discovered' &&
			(capabilities.toolCalling !== undefined ||
				capabilities.structuredOutput !== undefined ||
				capabilities.reasoning !== undefined));
	const origin = entry.metadata;
	return {
		...entry,
		...(effectiveLimitsValue !== undefined
			? { limits: effectiveLimitsValue }
			: entry.limits !== undefined
				? { limits: entry.limits }
				: {}),
		...(effectiveCapabilitiesValue !== undefined
			? { model: effectiveCapabilitiesValue }
			: entry.model !== undefined
				? { model: entry.model }
				: {}),
		...(origin !== undefined || usedDiscovered
			? {
					metadata: {
						source: usedDiscovered ? 'provider' : (origin?.source ?? 'unknown'),
						...(origin?.updatedAt !== undefined ? { updatedAt: origin.updatedAt } : {}),
						...(usedDiscovered && discoveredStale ? { stale: true } : {}),
						...(usedDiscovered && discoveredExpiresAt !== undefined
							? { expiresAt: discoveredExpiresAt }
							: {}),
					},
				}
			: {}),
	};
}

/** Funde um catálogo inteiro, com o que o provedor publicou de cada modelo. */
export function fuseCatalog(
	entries: readonly ModelCatalogEntry[],
	discovered: ReadonlyMap<string, DiscoveredMetadata>,
	preferences: MetadataPreferences,
	nowMs: number,
): readonly ModelCatalogEntry[] {
	return entries.map((entry) =>
		fuseCatalogEntry({
			entry,
			...(discovered.get(`${entry.providerId}:${entry.modelId}`) !== undefined
				? { discovered: discovered.get(`${entry.providerId}:${entry.modelId}`) as DiscoveredMetadata }
				: {}),
			preferences,
			nowMs,
		}),
	);
}
