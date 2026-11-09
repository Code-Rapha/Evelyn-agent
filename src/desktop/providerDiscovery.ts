/**
 * A atualização do registro do provedor a partir do que a sessão já sabe.
 *
 * ## Por que aqui, e não no Core
 *
 * O Core não conhece config de provider, sessão nem relógio de turno; o
 * adapter não conhece `/models` nem `Retry-After`. Esta é a costura: pega a
 * resposta do provedor (lista de `ModelInfo` ou um `ProviderError` com
 * `retryAfterMs`), decide o que ela muda e grava pela porta
 * `ProviderModelCatalogPort`. Toda a regra de "o que muda" é pura e vive em
 * `core/storage/providerModelsRules`; aqui só há I/O e ordem.
 *
 * ## Uma falha de descoberta nunca interrompe uma conversa
 *
 * Todo método desta classe devolve um resultado e nunca rejeita por causa da
 * descoberta. Se gravar falhar, o log recebe; o turno que disparou a
 * atualização segue com o que já tem. É a mesma regra das métricas da 4A.
 *
 * ## O que é "confirmado para a conta"
 *
 * Um `/models` bem-sucedido prova que o endpoint responde com esta credencial.
 * Ele **não** prova que cada modelo listado pode ser usado: servidores
 * anunciam modelos que a chave não alcança. Só uma chamada real, que terminou
 * com resposta, confirma o acesso — e é isso que `confirmUse` grava.
 */
import type { ProviderModelCatalogPort, DiscoveryOutcome } from '../core/storage/types/providerModels';
import type { ModelInfo } from '../core/providers/types';
import type { ModelCapabilities } from '../core/storage/types/modelCatalog';
import { readQuotaHeaders } from '../core/providers/quota/headers';
import type { QuotaState } from '../core/providers/quota/headers';
import type { QuotaTracker } from '../core/providers/quota/tracker';

/** O que o atualizador precisa do armazenamento, e nada além. */
export type DiscoveryStore = Pick<
	ProviderModelCatalogPort,
	'applyModelListing' | 'confirmAccess' | 'recordQuota' | 'getDiscoveredModel'
>;

export interface ProviderDiscoveryOptions {
	readonly store: DiscoveryStore;
	/** Injetado em testes. */
	readonly now?: () => Date;
	/** Recebe as falhas. Nunca pode lançar (é chamado dentro de um try). */
	readonly onFailure?: (error: unknown, context: { readonly phase: 'listing' | 'access' | 'quota' }) => void;
	/**
	 * O rastreador de esgotamento, quando o host quer que um `429` desta
	 * sessão impeça uma nova tentativa dentro da janela.
	 */
	readonly quotas?: QuotaTracker;
}

export interface ProviderDiscovery {
	/**
	 * Registra uma listagem bem-sucedida para um provedor.
	 *
	 * `fetchedAt` é quando o `/models` respondeu. A lista entra como está: os
	 * ids exatos, sem renomear nem descartar.
	 */
	recordListing(
		providerId: string,
		models: readonly ModelInfo[],
		options?: { readonly fetchedAt?: Date; readonly quotaHeaders?: Readonly<Record<string, string>> },
	): Promise<DiscoveryOutcome>;
	/** Registra que a listagem falhou, preservando o que havia. */
	recordListingFailure(providerId: string, error: unknown): Promise<DiscoveryOutcome | undefined>;
	/** Uma chamada real respondeu: o acesso deste modelo está confirmado. */
	confirmUse(providerId: string, modelId: string, at?: Date): Promise<void>;
	/**
	 * Registra o `429` observado e inicia a janela de espera.
	 *
	 * Chamado pelo adaptador do `ChatProvider`, que é quem vê a resposta HTTP.
	 * É o mesmo caminho de `recordChatResponse`, com o provedor e o modelo já
	 * resolvidos.
	 */
	recordRateLimit(input: {
		readonly providerId: string;
		readonly modelId: string;
		readonly retryAfterMs?: number;
		readonly headers?: Readonly<Record<string, string>>;
	}): Promise<void>;
	/**
	 * Registra o que uma resposta de chat informou sobre cota.
	 *
	 * `status` 429 marca esgotamento; os cabeçalhos, quando presentes, trazem o
	 * restante e o reinício. Um `429` sem prazo informado **não** marca o modelo
	 * como esgotado na sessão: sem janela, um bloqueio seria permanente.
	 */
	recordChatResponse(input: {
		readonly providerId: string;
		readonly modelId: string;
		readonly status: number;
		readonly headers: Readonly<Record<string, string>>;
		readonly retryAfterMs?: number;
	}): Promise<void>;
}

	const listingEntries = (
		models: readonly ModelInfo[],
	): readonly {
		readonly modelId: string;
		readonly contextTokens?: number;
		readonly maxOutputTokens?: number;
		readonly capabilities?: ModelCapabilities;
		readonly created?: string;
		readonly pricing?: {
			readonly currency: string;
			readonly unit: 'per_1k_tokens' | 'per_1m_tokens';
			readonly input?: number;
			readonly output?: number;
		};
	}[] =>
		// Só os campos que a 5D usa entram no arquivo: um nome de exibição ou
		// uma capacidade que o servidor publicou não são fatos sobre preço ou
		// acesso, e guardá-los sugeriria que foram verificados.
		models.map((model) => ({
			modelId: model.id,
			...(model.contextWindow !== undefined ? { contextTokens: model.contextWindow } : {}),
			...(model.maxOutputTokens !== undefined ? { maxOutputTokens: model.maxOutputTokens } : {}),
			...(model.modelCapabilities !== undefined ? { capabilities: model.modelCapabilities } : {}),
			...(model.created !== undefined ? { created: model.created } : {}),
			...(model.pricing !== undefined ? { pricing: model.pricing } : {}),
		}));

export function createProviderDiscovery(options: ProviderDiscoveryOptions): ProviderDiscovery {
	const now = options.now ?? (() => new Date());
	const report = (error: unknown, phase: 'listing' | 'access' | 'quota'): void => {
		try {
			options.onFailure?.(error, { phase });
		} catch {
			// Um observador que lança ao reportar uma falha não vira a falha.
		}
	};

	const denied = (error: unknown, phase: 'listing' | 'access' | 'quota'): undefined => {
		report(error, phase);
		return undefined;
	};

	const recordQuotaFromHeaders = async (
		providerId: string,
		headers: Readonly<Record<string, string>> | undefined,
		modelId?: string,
	): Promise<void> => {
		if (headers === undefined || Object.keys(headers).length === 0) {
			return;
		}
		try {
			const state = readQuotaHeaders(headers, now().getTime());
			if (state === undefined) {
				return;
			}
			await options.store.recordQuota({
				providerId,
				...(modelId !== undefined ? { modelId } : {}),
				account: {
					source: state.source,
					...(state.limit !== undefined ? { limit: state.limit.limit.value } : {}),
					...(state.remaining !== undefined ? { remaining: state.remaining.value } : {}),
					...(state.resetAt !== undefined ? { resetAt: state.resetAt } : {}),
					...(state.retryAfterMs !== undefined ? { retryAfterMs: state.retryAfterMs } : {}),
					verifiedAt: now().toISOString(),
				},
				updatedAt: now().toISOString(),
			});
		} catch (error) {
			denied(error, 'quota');
		}
	};
	const recordListing: ProviderDiscovery['recordListing'] = async (providerId, models, listingOptions = {}) => {
		const fetchedAt = (listingOptions.fetchedAt ?? now()).toISOString();
		try {
			const outcome = await options.store.applyModelListing({
				providerId,
				models: listingEntries(models),
				fetchedAt,
			});
			// Os cabeçalhos do próprio `/models` também dizem a cota da conta,
			// quando o servidor os envia.
			await recordQuotaFromHeaders(providerId, listingOptions.quotaHeaders);
			return outcome;
		} catch (error) {
			report(error, 'listing');
			// A listagem não pôde ser gravada: o estado anterior fica como
			// estava, e o relatório diz que nada foi atualizado.
			return {
				providerId,
				status: 'failed',
				models: models.length,
				added: 0,
				removed: 0,
				stale: false,
				error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
			};
		}
	};

	const recordListingFailure: ProviderDiscovery['recordListingFailure'] = async (providerId, error) => {
		try {
			return await failListing(options.store, providerId, error);
		} catch (failure) {
			return denied(failure, 'listing');
		}
	};

	const confirmUse: ProviderDiscovery['confirmUse'] = async (providerId, modelId, at = now()) => {
		try {
			await options.store.confirmAccess({ providerId, modelId }, at.toISOString());
		} catch (error) {
			denied(error, 'access');
		}
	};

	const recordChatResponse: ProviderDiscovery['recordChatResponse'] = async (input) => {
		const at = now();
		const state: QuotaState | undefined = readQuotaHeaders(input.headers, at.getTime());
		const retryAfterMs = state?.retryAfterMs ?? input.retryAfterMs;
		if (input.status !== 429 && state === undefined) {
			// Uma resposta normal não precisa de registro de cota além do saldo
			// que os cabeçalhos já disseram.
			return;
		}
		try {
			if (state !== undefined || retryAfterMs !== undefined) {
				await options.store.recordQuota({
					providerId: input.providerId,
					modelId: input.modelId,
					account: {
						source: state?.source ?? 'observed',
						...(state?.limit !== undefined ? { limit: state.limit.limit.value } : {}),
						...(state?.remaining !== undefined ? { remaining: state.remaining.value } : {}),
						...(state?.resetAt !== undefined ? { resetAt: state.resetAt } : {}),
						...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
						verifiedAt: at.toISOString(),
					},
					updatedAt: at.toISOString(),
				});
			}
			if (input.status === 429 && options.quotas !== undefined) {
				// Só com prazo: sem `Retry-After` nem `reset`, não há janela para
				// respeitar, e o rastreador não bloqueia.
				const quotaState: QuotaState = {
					source: state?.source ?? 'observed',
					...(state?.limit !== undefined ? { limit: state.limit } : {}),
					...(state?.remaining !== undefined ? { remaining: state.remaining } : {}),
					...(state?.resetAt !== undefined ? { resetAt: state.resetAt } : {}),
					...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
				};
				options.quotas.record(
					{ providerId: input.providerId, modelId: input.modelId },
					quotaState,
					{ exhausted: true },
				);
			}
		} catch (error) {
			denied(error, 'quota');
		}
	};

	const recordRateLimit: ProviderDiscovery['recordRateLimit'] = async (input) => {
		await recordChatResponse({
			providerId: input.providerId,
			modelId: input.modelId,
			status: 429,
			headers: input.headers ?? {},
			...(input.retryAfterMs !== undefined ? { retryAfterMs: input.retryAfterMs } : {}),
		});
	};

	return { recordListing, recordListingFailure, confirmUse, recordRateLimit, recordChatResponse };
}

/** Delega a falha ao adapter, quando ele a expõe. */
async function failListing(
	store: DiscoveryStore,
	providerId: string,
	error: unknown,
): Promise<DiscoveryOutcome | undefined> {
	const withFailure = store as DiscoveryStore & {
		failModelListing?: (id: string, cause: unknown) => Promise<DiscoveryOutcome>;
	};
	return withFailure.failModelListing === undefined
		? undefined
		: withFailure.failModelListing(providerId, error);
}
