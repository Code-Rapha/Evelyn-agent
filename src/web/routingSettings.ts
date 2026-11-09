/**
 * A configuração do roteador pela interface web.
 *
 * ## O que é configurável — e só isso
 *
 * As quatro opções que o Core já tem e já obedece:
 *
 * - **ligado/desligado** (\`enabled\`);
 * - **modo**: \`native\`, \`external\` ou \`direct\`;
 * - **destino do modo externo** (um id de provedor);
 * - **destino do modo direto** (um id de provedor).
 *
 * Não há estratégia, peso, ordem de fallback ou timeout aqui: o motor de
 * rota não tem esses campos na configuração, e inventá-los seria uma segunda
 * forma de rotear.
 *
 * ## A validação é a do Core
 *
 * \`changeRouterConfig\` valida o destino (existe? está habilitado?) e recusa
 * com o motivo. Quando recusa, **nada é gravado**: a última configuração
 * válida continua de pé. Esta camada não repete a regra — ela a invoca e
 * repassa a recusa como \`400\`.
 *
 * ## O que a página precisa saber para oferecer opções reais
 *
 * Quais provedores podem ser destino agora, e por que um deles não pode. Um
 * provedor desabilitado ou ausente é dito, em vez de aparecer numa lista
 * onde a escolha falharia no salvar.
 */
import { toDisplayMessage } from '../desktop/contract';
import { canSaveRouterConfig, routerConfigStatus } from '../desktop/routerConfigStatus';
import type { RouterConfigView } from '../desktop/contract';
import type { AssembledCore } from '../app/assemble';
import type { ApiReply } from './api';

/** Um provedor oferecido como destino, com o veredito. */
export interface RouterTarget {
	readonly id: string;
	readonly name: string;
	readonly baseUrl: string;
	readonly role: 'router' | 'provider';
	/** Pode ser escolhido como destino agora. */
	readonly usable: boolean;
	/** Por que não pode, quando não pode. */
	readonly reason?: string;
}

/** O que a página de Routing recebe. */
export interface RoutingView {
	readonly config: RouterConfigView;
	readonly targets: readonly RouterTarget[];
	/** `normal`, `recovered`, `unreadable` ou `unset`. */
	readonly status: string;
}

/** A configuração do roteador, com a leitura e a escrita. */
export class RoutingSettings {
	constructor(private readonly core: AssembledCore | undefined) {}

	/** O estado gravado, mais os destinos possíveis. */
	async read(): Promise<ApiReply> {
		if (this.core === undefined) {
			return { status: 404, body: { error: 'o Core não está montado neste host' } };
		}
		const core = this.core;
		const config = await core.chat.readRouterConfig();
		return { status: 200, body: viewOf(config, core) };
	}

	/**
	 * Grava o que a página enviou.
	 *
	 * Só os quatro campos são lidos do corpo; qualquer outra coisa é ignorada
	 * (e não vira configuração). Um corpo sem nenhum deles é recusado: salvar
	 * "nada" não é salvar.
	 */
	async save(body: unknown): Promise<ApiReply> {
		if (this.core === undefined) {
			return { status: 404, body: { error: 'o Core não está montado neste host' } };
		}
		const core = this.core;
		// O arquivo existe e não pode ser lido: o formulário da página está
		// preenchido com o padrão, e salvar por cima apagaria a configuração
		// que ainda pode ser recuperada. A recusa é do servidor, não só do
		// botão — um cliente não pode contornar a tela.
		const current = await core.chat.readRouterConfig();
		if (!canSaveRouterConfig(routerConfigStatus(current))) {
			return {
				status: 409,
				body: {
					error:
						'a configuração do roteador não pôde ser lida e não há cópia de segurança válida; ' +
						'repare o arquivo do roteador antes de salvar',
				},
			};
		}
		const input = readInput(body);
		if (input === 'invalid') {
			return { status: 400, body: { error: 'esperado { mode, enabled, externalRouterProviderId, directProviderId }' } };
		}
		if (Object.keys(input).length === 0) {
			return { status: 400, body: { error: 'nada para salvar: informe ao menos uma opção' } };
		}

		try {
			const saved = await core.chat.changeRouterConfig(input);
			// A resposta é o que ficou **gravado**, não o que foi pedido.
			return { status: 200, body: viewOf(saved, core) };
		} catch (error) {
			// A recusa do Core é a explicação, e o estado anterior continua.
			return { status: 400, body: { error: toDisplayMessage(error, 'não foi possível salvar o roteador') } };
		}
	}
}

/** A resposta da leitura e da escrita, com o estado derivado uma vez. */
function viewOf(config: RouterConfigView, core: AssembledCore): RoutingView & { readonly status: string } {
	return { config, targets: targetsOf(core), status: routerConfigStatus(config) };
}

/**
 * Os provedores que podem ser destino, com o motivo de cada recusa.
 *
 * A regra é a que \`changeRouterConfig\` aplica: existe **e** está habilitado.
 * Nada além disso é filtrado aqui — um provedor que existe e está habilitado é
 * oferecido, mesmo que o modo em uso não seja dele.
 */
function targetsOf(core: AssembledCore): readonly RouterTarget[] {
	return core.chat.listProviders().map((provider) => {
		const usable = provider.status !== 'disabled';
		return {
			id: provider.id,
			name: provider.name,
			baseUrl: provider.baseUrl,
			role: provider.role === 'router' ? 'router' : 'provider',
			usable,
			...(usable ? {} : { reason: 'o provedor está desabilitado; habilite-o em Providers para usá-lo como destino' }),
		};
	});
}

const MODES = new Set(['native', 'external', 'direct']);

/**
 * Lê o corpo: só os quatro campos conhecidos, e só com os tipos certos.
 *
 * Um campo com o tipo errado é **ignorado**, como no preload do desktop: a
 * página pode ter enviado `mode: ""` a partir de um `<select>` vazio, e isso
 * não é um modo — é a ausência de um.
 */
function readInput(
	body: unknown,
): { readonly mode?: 'native' | 'external' | 'direct'; readonly enabled?: boolean; readonly externalRouterProviderId?: string; readonly directProviderId?: string } | 'invalid' {
	if (typeof body !== 'object' || body === null || Array.isArray(body)) {
		return 'invalid';
	}
	const value = body as Record<string, unknown>;
	const mode = value['mode'];
	const enabled = value['enabled'];
	const external = value['externalRouterProviderId'];
	const direct = value['directProviderId'];
	return {
		...(typeof mode === 'string' && MODES.has(mode) ? { mode: mode as 'native' | 'external' | 'direct' } : {}),
		...(typeof enabled === 'boolean' ? { enabled } : {}),
		...(typeof external === 'string' && external.length > 0 ? { externalRouterProviderId: external } : {}),
		...(typeof direct === 'string' && direct.length > 0 ? { directProviderId: direct } : {}),
	};
}
