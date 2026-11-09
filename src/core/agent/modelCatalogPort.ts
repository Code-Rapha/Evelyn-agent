/**
 * O contrato do catálogo de modelos que o agente consulta.
 *
 * ## Por que só o contrato mora no Core
 *
 * O Core não pode conhecer o host: `desktopBoundary.test.ts` recusa qualquer
 * import de `core/` para `desktop/`, e a regra é boa — é ela que impede a
 * lógica do Core de depender de uma janela. Mas **também** é no Core que mora
 * a forma dos dados que uma ferramenta devolve ao modelo.
 *
 * A saída: o Core declara **o que** perguntar (`ModelDirectory` e `ModelRecord`),
 * o desktop declara **como** responder — a fusão do catálogo é dele. A
 * ferramenta encontra o adaptador no host, do mesmo jeito que o runtime
 * encontra as ferramentas: pelo contrato, não pela implementação.
 *
 * Nada aqui lê disco, chama rede ou conhece provedor. São tipos e um erro com
 * nome, para o host saber o que deve servir.
 */
import type { ModelAccess, ModelCapabilities, ModelLimits } from '../storage/types/modelCatalog';

/**
 * Um modelo no formato **neutro** do catálogo.
 *
 * Campos ausentes são ausentes de propósito: um preço que ninguém declarou não
 * é zero, e uma capacidade que ninguém viu não é "não tem". A ferramenta
 * devolve o que existe e diz, em `unknown`, o que não existe.
 */
export interface ModelRecord {
	readonly modelId: string;
	/**
	 * O id do provedor — a mesma chave que o catálogo usa.
	 *
	 * Separado do nome de exibição porque a recomendação casa este registro com
	 * o catálogo fundido, e o fundido é indexado por id. Um nome de exibição que
	 * não é o id fazia um resultado vazio parecer "nada foi gravado".
	 */
	readonly providerId: string;
	readonly providerName: string;
	/** Se o provedor publica o modelo agora. Ausente quando não se sabe. */
	readonly available?: boolean;
	readonly access?: ModelAccess;
	readonly capabilities?: ModelCapabilities;
	readonly limits?: ModelLimits;
	readonly pricing?: {
		readonly currency: string;
		readonly unit: string;
		/** O número fica texto, como no catálogo: `""` seria ambíguo como zero. */
		readonly input?: string;
		readonly output?: string;
		/** `stale` é um preço conhecido, mas não atual. */
		readonly state?: 'exact' | 'stale' | 'unknown';
	};
	/** Observações de execuções reais, quando existem. */
	readonly observations?: number;
	readonly medianTotalMs?: number;
	/** Por que o modelo não é elegível agora, quando houver motivo. */
	readonly policyReason?: string;
}

/** Uma preferência de modelo registrada pela Evelyn, como a recomendação a lê. */
export interface ModelGuidancePreference {
	readonly model: string;
	readonly providerId?: string;
	readonly tools?: boolean;
	readonly reasoning?: boolean;
	readonly longContext?: boolean;
	readonly value?: number;
	readonly useFor?: string;
}

export interface DiscoveryRefreshResult {
	readonly providers: readonly {
		readonly providerId: string;
		readonly ok: boolean;
		/** Quantos modelos o provedor publicou desta vez, quando respondeu. */
		readonly models?: number;
		readonly message?: string;
	}[];
}

/** O que as ferramentas do catálogo precisam do host — e nada além disso. */
export interface ModelDirectory {
	/**
	 * Todos os modelos, opcionalmente de um provedor.
	 *
	 * Devolve a lista **completa** (disponíveis e indisponíveis), porque "o que
	 * existe no catálogo" e "o que o provedor está publicando agora" são
	 * perguntas diferentes e a ferramenta diz qual das duas está respondendo.
	 */
	list(options?: { readonly providerId?: string }): Promise<readonly ModelRecord[]>;
	/** Atualiza a descoberta de um provedor (ou de todos) e diz o que mudou. */
	refreshDiscovery(providerId?: string): Promise<DiscoveryRefreshResult>;
	/** As preferências que a Evelyn registrou para a recomendação. */
	guidance(): Promise<readonly ModelGuidancePreference[]>;
	/** O que o usuário pode gastar, para a recomendação não sugerir o proibido. */
	allowPaid(): Promise<boolean>;
}

/**
 * O adaptador escolhido por provedor, para servidores sem o `ModelDirectory`.
 *
 * Um `Record` e não um `Map` porque a ferramenta é do Core e não deve depender
 * de um tipo do desktop; as chaves são as do provedor como o modelo as nomeia.
 */
export type ModelCatalogPorts = Readonly<
	Record<string, (input: unknown) => Promise<unknown>>
>;

/** Falha ao perguntar ao host. A ferramenta a devolve como erro, nunca lança. */
export class ModelCatalogUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ModelCatalogUnavailableError';
	}
}
