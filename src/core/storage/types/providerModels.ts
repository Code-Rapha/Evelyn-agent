/**
 * O que o provedor disse sobre seus modelos, e quando.
 *
 * ## Por que um registro separado do catálogo
 *
 * O catálogo (`models.json`) é o que **o usuário declarou** e o que as
 * execuções mediram; é poucas linhas, editadas à mão, e nunca é reescrito por
 * uma resposta HTTP. Este registro é o que **o provedor publicou**: muda
 * sozinho, é verificado por TTL, e uma resposta vazia de um servidor fora do ar
 * não pode apagar a declaração do usuário nem o histórico de uso.
 *
 * Manter os dois separados é o que permite responder, sem ambiguidade:
 *
 * - "este modelo está listado?" — aqui;
 * - "esta conta consegue usá-lo?" — `accessConfirmedAt` aqui, depois de um
 *   teste real;
 * - "quanto custa?" — a declaração do usuário manda; a do provedor é
 *   evidência datada, com validade.
 *
 * ## Descontinuado não é apagado
 *
 * Um modelo que some da listagem sai de `listed` e ganha `missingSince`, mas o
 * registro fica: o ledger aponta para o modelo pelo id, e uma execução antiga
 * precisa continuar legível. Apagar apagaria a explicação de um gasto passado.
 *
 * ## Nada de segredo
 *
 * Só ids, números, datas e URLs. Nenhuma credencial, nenhum cabeçalho de
 * autorização: o registro é gravado em disco em texto.
 */
import type { ModelAccess, ModelCapabilities, ModelLimits, ModelPricing } from './modelCatalog';
import type { QuotaSource } from '../../providers/quota/headers';

/** De onde um fato veio. */
export type DiscoverySource = 'provider' | 'account' | 'manual' | 'unknown';

/** Quão fresco um fato ainda é considerado. */
export type Freshness = 'fresh' | 'stale' | 'expired';

/** Um preço descoberto, com a prova de onde veio e até quando vale. */
export interface DiscoveredPricing {
	readonly pricing: ModelPricing;
	readonly source: DiscoverySource;
	/** ISO-8601, quando o provedor respondeu. */
	readonly verifiedAt: string;
	/** ISO-8601, depois disso o valor é evidência antiga. */
	readonly expiresAt: string;
	/** Verdadeiro quando uma atualização falhou e este é o valor anterior. */
	readonly stale: boolean;
}

/** O acesso descoberto: só `free` com evidência; `paid` e `unknown` também são fatos. */
export interface DiscoveredAccess {
	readonly access: ModelAccess;
	readonly source: DiscoverySource;
	readonly verifiedAt: string;
	readonly expiresAt: string;
	/** O que sustenta o `free`: ambos os preços publicados zerados. */
	readonly evidence?: string;
	readonly stale: boolean;
}

/**
 * Os limites publicados, com a procedência e a validade.
 *
 * Separate do preço: a janela de contexto e o limite de saída mudam em outro
 * ritmo, e uma das duas pode faltar sem que a outra falte. `stale` marca a
 * cópia que veio de uma atualização que falhou.
 */
export interface DiscoveredLimits {
	readonly limits: ModelLimits;
	readonly source: DiscoverySource;
	readonly verifiedAt: string;
	readonly expiresAt: string;
	readonly stale: boolean;
}

/**
 * As capacidades publicadas, com a procedência e a validade.
 *
 * A lista do provedor é uma enumeração: o que não está nela é `false`. Mas
 * uma lista **ausente** não vira `false` — continua sendo "ninguém sabe", e
 * o campo `enumerated` diz qual dos dois é o caso.
 */
export interface DiscoveredCapabilities {
	readonly capabilities: ModelCapabilities;
	readonly source: DiscoverySource;
	readonly verifiedAt: string;
	readonly expiresAt: string;
	readonly stale: boolean;
}

/** O que uma listagem do provedor disse sobre um modelo. */
export interface DiscoveredModel {
	readonly providerId: string;
	/** O id exato que o provedor publica. */
	readonly modelId: string;
	/** Estava na última listagem bem-sucedida. */
	readonly listed: boolean;
	/** Quando a listagem que o trouxe aconteceu (ISO-8601). */
	readonly listedAt?: string;
	/**
	 * Quando uma chamada real confirmou que esta conta pode usá-lo.
	 *
	 * Ausente = listado mas não confirmado. Um modelo listado não é prova de
	 * acesso: um servidor pode anunciar modelos que a chave não alcança.
	 */
	readonly accessConfirmedAt?: string;
	/** Ausente = nunca esteve listado e agora não está. */
	readonly missingSince?: string;
	/** Janela de contexto publicada, quando publicada. */
	readonly contextTokens?: number;
	/** Limite de saída publicado, quando publicado. */
	readonly maxOutputTokens?: number;
	/** Os limites publicados, com a procedência e a validade. */
	readonly limits?: DiscoveredLimits;
	/** Capacidades publicadas, quando o provedor publica uma lista. */
	readonly capabilities?: DiscoveredCapabilities;
	/** Data de criação no catálogo do provedor, quando publicada. */
	readonly created?: string;
	/** Preço publicado, com validade. */
	readonly pricing?: DiscoveredPricing;
	/** Acesso, com validade. `unknown` só é gravado quando há evidência de `unknown`. */
	readonly access?: DiscoveredAccess;
	readonly updatedAt: string;
}

/** O que se sabe de uma cota, por origem. Cada campo carrega a sua. */
export interface DiscoveredQuota {
	readonly source: QuotaSource;
	/** Limite e restante, quando a API informou. */
	readonly limit?: number;
	readonly remaining?: number;
	readonly resetAt?: string;
	readonly retryAfterMs?: number;
	/**
	 * O que a cota limita, quando a fonte diz: requisições ou tokens.
	 *
	 * Ausente = a fonte não disse, e a tela não inventa.
	 */
	readonly kind?: 'requests' | 'tokens';
	/**
	 * De quem é o limite, quando a fonte diz: a chave, o provedor, o modelo
	 * ou a conta.
	 *
	 * Ausente = a fonte não disse. Uma cota sem escopo conhecido é exibida
	 * como "de escopo desconhecido", nunca como "por chave".
	 */
	readonly scope?: 'api-key' | 'provider' | 'model' | 'account';
	/** A janela, quando a fonte declara. */
	readonly window?: 'minute' | 'hour' | 'day' | 'month' | 'second';
	readonly verifiedAt: string;
}

/** Um registro de cota, por provedor (e modelo, quando o escopo é do modelo). */
export interface DiscoveredQuotaRecord {
	readonly providerId: string;
	readonly modelId?: string;
	/** Cada entrada fala por si: não se misturam origens num só número. */
	readonly account?: DiscoveredQuota;
	/** O que a Evelyn contou no período do limite. */
	readonly usage?: {
		readonly requests: number;
		readonly inputTokens: number;
		readonly outputTokens: number;
		readonly since: string;
	};
	readonly updatedAt: string;
}

/** Um relatório de atualização, para a UI e para o log. */
export interface DiscoveryOutcome {
	readonly providerId: string;
	/** `ok` = listagem nova; `failed` = nada mudou e o anterior foi marcado. */
	readonly status: 'ok' | 'failed';
	readonly models: number;
	readonly added: number;
	readonly removed: number;
	/** Quando a listagem aconteceu (a antiga, em caso de falha). */
	readonly fetchedAt?: string;
	/** A cópia servida é anterior ao TTL porque a atualização falhou. */
	readonly stale: boolean;
	readonly error?: string;
}

/** O TTL de cada tipo de informação. Mudam em ritmos diferentes. */
export interface DiscoveryTtl {
	/** Listagem de modelos: muda com deploys do provedor. */
	readonly modelsMs: number;
	/** Preço: muda raramente, e um preço velho é melhor que nenhum. */
	readonly pricingMs: number;
	/** Acesso confirmado: um teste real; vale enquanto a chave não mudar. */
	readonly accessMs: number;
}

export const DEFAULT_DISCOVERY_TTL: DiscoveryTtl = {
	modelsMs: 10 * 60_000,
	pricingMs: 24 * 60 * 60_000,
	accessMs: 7 * 24 * 60 * 60_000,
};

/** A porta que o host grava e lê. */
export interface ProviderModelCatalogPort {
	listDiscoveredModels(providerId?: string): Promise<readonly DiscoveredModel[]>;
	getDiscoveredModel(key: {
		readonly providerId: string;
		readonly modelId: string;
	}): Promise<DiscoveredModel | undefined>;
	/** Aplica o resultado de uma listagem; idempotente. */
	applyModelListing(input: {
		readonly providerId: string;
		readonly models: readonly {
			readonly modelId: string;
			readonly contextTokens?: number;
			readonly maxOutputTokens?: number;
			readonly capabilities?: ModelCapabilities;
			readonly created?: string;
			readonly pricing?: ModelPricing;
		}[];
		readonly fetchedAt: string;
	}): Promise<DiscoveryOutcome>;
	/** Marca que uma chamada real confirmou o acesso desta conta. */
	confirmAccess(key: { readonly providerId: string; readonly modelId: string }, at: string): Promise<void>;
	/** Registra o que uma resposta da API disse sobre a cota. */
	recordQuota(record: DiscoveredQuotaRecord): Promise<void>;
	listQuotas(providerId?: string): Promise<readonly DiscoveredQuotaRecord[]>;
}
