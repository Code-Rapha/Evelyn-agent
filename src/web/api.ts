/**
 * Os endpoints de **leitura** da interface web.
 *
 * ## O que eles são
 *
 * A tradução de uma `GET /api/...` para uma chamada de leitura da fachada
 * (`ChatSession`) — nada além disso. Sem escrita, sem chat, sem SSE, sem
 * Combos: esta fase é a fundação da interface.
 *
 * ## O que eles garantem
 *
 * - **só leitura**: uma rota aqui é `async` e devolve dados; um `POST` não
 *   chega nem perto delas (o `server` recusa antes);
 * - **só o que o Core sabe**: as listas vêm do `ChatSession`; o que não
 *   existe responde `null` ou `[]`, nunca um valor inventado;
 * - **sem segredos**: as visões (`ProviderSummary`, `MergedModelView`) já
 *   não carregam chave nem referência de chave, e nada aqui as contorna.
 *
 * ## A área que ainda não tem endpoint
 *
 * `GET /api/capabilities` diz **o que esta API faz hoje**. É o que permite à
 * página marcar "pendente" onde não há dado, em vez de fingir que há.
 */
import type { AssembledCore } from '../app/assemble';
import type { OpencodeManager } from '../app/opencodeManager';
import type { OpencodeCatalogService } from '../app/opencodeCatalogService';
import { RoutingSettings } from './routingSettings';
import { buildGallery, categoryLabel } from './integrations';

/** O nome e o endereço de cada área da interface. */
export const API_CAPABILITIES = {
	/** Dados reais, prontos nesta fase. */
	ready: ['overview', 'providers', 'models', 'model-discovery', 'routing-config', 'usage'],
	/** Ainda sem endpoint: a página diz que está pendente. */
	pending: ['combos', 'routing-history', 'policies-write', 'chat'],
} as const;

/** O resultado de uma rota: status e corpo, prontos para o servidor. */
export interface ApiReply {
	readonly status: number;
	readonly body: unknown;
}

/** `200` com o corpo. */
function ok(body: unknown): ApiReply {
	return { status: 200, body };
}

/** `404` para um recurso nomeado que não existe. */
function notFound(reason: string): ApiReply {
	return { status: 404, body: { error: reason } };
}

/**
 * O que a interface pode pedir do Core.
 *
 * Cada método é uma **leitura** da fachada. O tipo `AssembledCore` vem do
 * app, para que esta camada não conheça Electron nem o host.
 */
export class WebApi {
	constructor(
		private readonly core: AssembledCore | undefined,
		/**
		 * O gerenciador do OpenCode, quando este host pode ter um.
		 *
		 * A galeria pergunta a ele o estado real da conexão — é o que faz a
		 * entrada do OpenCode dizer "conectado" só quando o health respondeu,
		 * e não porque o catálogo tem uma linha para ele.
		 */
		private readonly opencode?: OpencodeManager,
		private readonly opencodeCatalog?: OpencodeCatalogService,
	) {}

	/** A lista de recursos que esta API responde. */
	capabilities(): ApiReply {
		return ok({
			ready: API_CAPABILITIES.ready,
			pending: API_CAPABILITIES.pending,
			/**
			 * As escrituras que existem: provider e descoberta de modelos.
			 * Combos, política e chat continuam sem.
			 */
			writes: ['providers', 'model-discovery'],
		});
	}

	/** A visão geral: contagens e estado, tudo derivado das listas reais. */
	async overview(): Promise<ApiReply> {
		if (this.core === undefined) {
			return notFound('o Core não está montado neste host');
		}
		const providers = this.core.chat.listProviders();
		const router = await this.core.chat.readRouterConfig();
		// O catálogo é a fonte do total de modelos — contados, não estimados.
		const catalog = await this.core.chat.listMergedCatalog();
		return ok({
			providers: {
				total: providers.length,
				enabled: providers.filter((provider) => provider.status !== 'disabled').length,
				routers: providers.filter((provider) => provider.role === 'router').length,
			},
			models: { total: catalog.models.length },
			router,
		});
	}

	/**
	 * Os endpoints de provider: a lista e as conexões, com o que se sabe de
	 * cada uma.
	 *
	 * `models` é o catálogo **fundido** — declarado e descoberto, cada lado
	 * marcado com a sua origem. É o mesmo shape que a janela do desktop usa.
	 */
	async providers(): Promise<ApiReply> {
		if (this.core === undefined) {
			return notFound('o Core não está montado neste host');
		}
		const providers = this.core.chat.listProviders();
		const catalog = await this.core.chat.listMergedCatalog();
		const quotas = await this.core.chat.listDiscoveredQuotas();
		return ok({
			providers,
			policy: catalog.policy,
			models: catalog.models,
			quotas,
		});
	}

	/** O que se sabe de cada modelo: preço, acesso, limites, capacidades. */
	async models(): Promise<ApiReply> {
		if (this.core === undefined) {
			return notFound('o Core não está montado neste host');
		}
		const catalog = await this.core.chat.listMergedCatalog();
		const declared = await this.core.chat.listModelCatalog();
		const available = await this.core.chat.listAvailableModels();
		return ok({
			policy: catalog.policy,
			models: catalog.models,
			declared,
			available,
		});
	}

	/**
	 * O catálogo de modelos, com os três lados explícitos.
	 *
	 * `models` é o fundido — o que vale hoje —, `discovered` o que os
	 * endpoints publicaram e `declared` o que o usuário gravou. A página
	 * distingue os três porque eles não são a mesma coisa.
	 */
	async catalog(): Promise<ApiReply> {
		if (this.core === undefined) {
			return notFound('o Core não está montado neste host');
		}
		const [merged, discovered, declared] = await Promise.all([
			this.core.chat.listMergedCatalog(),
			this.core.chat.listDiscoveredModels(),
			this.core.chat.listModelCatalog(),
		]);
		return ok({
			policy: merged.policy,
			models: merged.models,
			discovered,
			declared,
		});
	}

	/**
	 * A galeria: o catálogo de integrações com o estado de cada uma.
	 *
	 * `providers` é o que o Core realmente tem; `gallery` é o catálogo mais o
	 * estado derivado dele. Nenhuma entrada do catálogo vira conexão por estar
	 * listada.
	 */
	async integrations(): Promise<ApiReply> {
		if (this.core === undefined) {
			return notFound('o Core não está montado neste host');
		}
		const providers = this.core.chat.listProviders();
		// O OpenCode não é um provedor deste Core: o estado dele vem do
		// gerenciador, que é quem de fato sabe se o health respondeu.
		const opencode = this.opencode === undefined ? undefined : await this.opencode.status();
		// O catálogo do OpenCode também não é o do Core: é uma leitura
		// separada, guardada em arquivo próprio, para um modelo dele nunca
		// aparecer como selecionável no catálogo de provedores.
		const opencodeCatalog =
			this.opencodeCatalog === undefined ? undefined : await this.opencodeCatalog.state();
		return ok({
			providers,
			...(opencode !== undefined ? { opencode } : {}),
			...(opencodeCatalog !== undefined ? { opencodeCatalog } : {}),
			gallery: buildGallery(providers).map((entry) => ({
				id: entry.integration.id,
				name: entry.integration.name,
				description: entry.integration.description,
				category: entry.integration.category,
				categoryLabel: categoryLabel(entry.integration.category),
				connection: entry.integration.connection,
				support: entry.integration.support,
				state: entry.state,
				...(entry.integration.baseUrl !== undefined ? { baseUrl: entry.integration.baseUrl } : {}),
				requires: entry.integration.requires,
				...(entry.integration.limitation !== undefined ? { limitation: entry.integration.limitation } : {}),
				...(entry.integration.instructions !== undefined ? { instructions: entry.integration.instructions } : {}),
				...(entry.integration.managedServer === true ? { managedServer: true } : {}),
				...(entry.provider !== undefined ? { providerId: entry.provider.id } : {}),
			})),
		});
	}

	/**
	 * A configuração do roteador, como está gravada, e os destinos possíveis.
	 *
	 * A leitura e a escrita usam a mesma forma de resposta
	 * (`RoutingSettings`), para a página não ter dois formatos para a mesma
	 * coisa.
	 */
	async routing(): Promise<ApiReply> {
		if (this.core === undefined) {
			return notFound('o Core não está montado neste host');
		}
		return await new RoutingSettings(this.core).read();
	}

	/** O consumo do período: limites, orçamento e avisos. */
	async usage(): Promise<ApiReply> {
		if (this.core === undefined) {
			return notFound('o Core não está montado neste host');
		}
		const [limits, month, day, alerts] = await Promise.all([
			this.core.chat.listSpendingLimits(),
			this.core.chat.readBudget('month'),
			this.core.chat.readBudget('day'),
			this.core.chat.listBudgetAlerts(),
		]);
		return ok({ limits, month, day, alerts });
	}

	/** A política de acesso e os projetos, para a página de configurações. */
	async settings(): Promise<ApiReply> {
		if (this.core === undefined) {
			return notFound('o Core não está montado neste host');
		}
		const policy = await this.core.chat.loadAccessPolicy();
		const projects = await this.core.chat.listProjects();
		return ok({ policy, projects });
	}
}
