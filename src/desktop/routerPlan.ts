/**
 * O que a configuração do roteador resolve, para um turno.
 *
 * ## Os três desfechos
 *
 * - **`native`** — o motor da Evelyn escolhe: o plano da seleção, o
 *   fallback entre modelos, as métricas. É o modo de sempre;
 * - **`single`** — a chamada vai para **um** provedor, com **um** modelo
 *   pedido. O roteador externo (ou a conexão direta) decide o que fazer com
 *   esse pedido; a Evelyn não simula essa decisão;
 * - **`refused`** — a configuração não pode ser obedecida, e a recusa diz
 *   **por quê**.
 *
 * ## O que `single` não é
 *
 * Não é "o modo direto com outro nome". A diferença é quem decide: em `single`
 * quem escolhe o modelo é o outro lado, e o relatório diz isso. E o motor de
 * rota continua no caminho — com um alvo só — de modo que o orçamento, a
 * cota, o breaker e as métricas sigam valendo exatamente como antes.
 *
 * ## A recusa é explícita
 *
 * Um provedor que não existe, está desabilitado ou não tem endereço
 * utilizável **não** vira "tente outro" nem "volte para o modo nativo". O
 * app diz o que está errado e para. Um modo escolhido pelo usuário que falha
 * silenciosamente para outro é pior do que um modo que falha.
 */
import type { RouterConfig, RouterMode } from '../core/providers/routing/config';
import { providerIdForMode } from '../core/providers/routing/config';
import type { SelectableModel, SelectionReason } from './modelSelector';

/** O plano de um turno, depois de resolver a configuração. */
export type RouterPlan =
	| { readonly kind: 'native' }
	| {
			/**
			 * Um alvo só: o provedor chamado e o modelo pedido.
			 *
			 * O modelo pedido é o que a Evelyn manda. Quem **respondeu** pode
			 * ser outro, e isso é dito à parte — ver `respondedModel`.
			 */
			readonly kind: 'single';
			readonly providerId: string;
			readonly modelId: string;
			readonly mode: RouterMode;
	  }
	| { readonly kind: 'refused'; readonly message: string };

/** O que o host sabe sobre o provedor escolhido. */
export interface RouterProviderLookup {
	/** A configuração do provedor, quando ele existe. */
	(providerId: string):
		| { readonly exists: true; readonly enabled: boolean; readonly baseUrl: string }
		| { readonly exists: false };
}

/** O que a consulta devolve para um provedor, sem repetir a união acima. */
export type RouterProviderLookupResult = ReturnType<RouterProviderLookup>;

/**
 * Resolve a configuração em um plano de turno.
 *
 * O interruptor vem **primeiro**: desligado, nenhum turno começa, e a recusa
 * diz como ligar. Isso é deliberado — desligar o roteador não é "usar o modo
 * direto", e tratar como se fosse seria decidir pelo usuário.
 */
export function resolveRouterPlan(input: {
	readonly config: RouterConfig;
	/** O modelo que o usuário escolheu na interface. */
	readonly requestedModel: string;
	readonly lookup: RouterProviderLookup;
}): RouterPlan {
	if (!input.config.enabled) {
		return {
			kind: 'refused',
			message:
				'O roteador está desligado, então nenhuma requisição foi enviada. Ligue o roteador nas configurações, ou escolha o modo direto com um provedor definido.',
		};
	}
	if (input.config.mode === 'native') {
		return { kind: 'native' };
	}
	const providerId = providerIdForMode(input.config);
	if (providerId === undefined) {
		// A leitura já repara um modo sem provedor; chegar aqui significa que
		// a configuração foi montada em memória, e ela está incompleta.
		return {
			kind: 'refused',
			message: `O modo "${input.config.mode}" não tem nenhum provedor definido. Escolha um provedor nas configurações.`,
		};
	}
	const provider = input.lookup(providerId);
	if (!provider.exists) {
		return {
			kind: 'refused',
			message: `O provedor "${providerId}" do modo "${input.config.mode}" não está configurado. Cadastre-o, ou escolha outro modo.`,
		};
	}
	if (!provider.enabled) {
		return {
			kind: 'refused',
			message: `O provedor "${providerId}" do modo "${input.config.mode}" está desabilitado. Habilite-o, ou escolha outro modo.`,
		};
	}
	if (provider.baseUrl.trim().length === 0) {
		return {
			kind: 'refused',
			message: `O provedor "${providerId}" do modo "${input.config.mode}" não tem um endereço utilizável. Corrija o endereço, ou escolha outro modo.`,
		};
	}
	if (input.requestedModel.trim().length === 0) {
		return {
			kind: 'refused',
			message: `O modo "${input.config.mode}" precisa de um modelo: escolha um modelo antes de enviar.`,
		};
	}
	return {
		kind: 'single',
		providerId,
		modelId: input.requestedModel.trim(),
		mode: input.config.mode,
	};
}

/**
 * O modo do turno escolhido pelo usuário no chat (DEV-8.9).
 *
 * - `auto` — o roteador nativo da Evelyn escolhe;
 * - `direct` — o par provedor + modelo do usuário, sem substituição;
 * - `external` — o roteador externo configurado, que escolhe o modelo.
 *
 * `undefined` = nenhum modo foi escolhido (cliente antigo): a configuração do
 * roteador decide sobre o par enviado, como antes da DEV-8.9.
 */
export type TurnMode = 'auto' | 'direct' | 'external';

/**
 * Traduz o modo escolhido + o que veio no turno em um plano.
 *
 * É uma camada **fina** sobre `resolveRouterPlan`: não reimplementa a
 * validação do destino, só decide **qual** configuração e **qual** modelo o
 * modo usa. Assim os três modos do chat passam pelo mesmo motor de rota, com
 * o mesmo orçamento, cota, breaker e fallback.
 *
 * ## As decisões, e por quê
 *
 * - `auto` **só** vale com o roteador ligado no modo `native`. Com a
 *   configuração apontando para um roteador externo ou para um destino
 *   direto, "automático" não é uma escolha que o app possa obedecer: o
 *   usuário configurou um destino explícito, e o turno segue a configuração.
 *   Inventar uma seleção local ali seria trocar o destino por conta própria;
 * - `direct` usa o par do usuário e **não** passa pelo modo da configuração:
 *   é o que "sem passar pela seleção automática" significa. Mas o
 *   interruptor continua valendo — desligado, nenhum turno sai;
 * - `external` exige o roteador externo configurado. Sem ele, a recusa diz
 *   isso e manda abrir as configurações; nada é enviado a outro destino.
 */
export function resolveTurnModePlan(input: {
	readonly mode: TurnMode;
	readonly config: RouterConfig;
	readonly requestedProviderId: string;
	readonly requestedModel: string;
	readonly lookup: RouterProviderLookup;
}): RouterPlan {
	// O interruptor é do usuário e nenhum modo o ignora: desligar o roteador
	// é "não quero nada saindo agora", não uma preferência de destino.
	if (!input.config.enabled) {
		return resolveRouterPlan({
			config: input.config,
			requestedModel: input.requestedModel,
			lookup: input.lookup,
		});
	}

	switch (input.mode) {
		case 'auto':
			return input.config.mode === 'native'
				? { kind: 'native' }
				: // O destino configurado vence: ver o comentário acima. A
					// consulta ao destino é a de `resolveRouterPlan`, com o
					// mesmo modelo pedido (para o relatório dizer o que foi pedido).
					resolveRouterPlan({
						config: input.config,
						requestedModel: input.requestedModel,
						lookup: input.lookup,
					});
		case 'direct': {
			const providerId = input.requestedProviderId.trim();
			const modelId = input.requestedModel.trim();
			if (providerId.length === 0 || modelId.length === 0) {
				return {
					kind: 'refused',
					message:
						'O modo provedor direto precisa de um provedor e de um modelo: escolha os dois antes de enviar.',
				};
			}
			const provider = input.lookup(providerId);
			if (!provider.exists) {
				return {
					kind: 'refused',
					message: `O provedor "${providerId}" não está configurado. Cadastre-o, ou escolha outro provedor.`,
				};
			}
			if (!provider.enabled) {
				return {
					kind: 'refused',
					message: `O provedor "${providerId}" está desabilitado. Habilite-o, ou escolha outro provedor.`,
				};
			}
			if (provider.baseUrl.trim().length === 0) {
				return {
					kind: 'refused',
					message: `O provedor "${providerId}" não tem um endereço utilizável. Corrija o endereço nas configurações.`,
				};
			}
			return { kind: 'single', providerId, modelId, mode: 'direct' };
		}
		case 'external': {
			if (input.config.mode !== 'external' || input.config.externalRouterProviderId === undefined) {
				return {
					kind: 'refused',
					message:
						'O roteador externo não está configurado. Escolha o destino no painel do roteador, ou use outro modo.',
				};
			}
			return resolveRouterPlan({
				config: input.config,
				requestedModel: input.requestedModel,
				lookup: input.lookup,
			});
		}
	}
}

/**
 * O plano de um turno com **um** alvo.
 *
 * ## O que ele não é
 *
 * Não é o resultado de uma seleção. A Evelyn **não** escolheu o modelo:
 * ela mandou o que o usuário pediu para o provedor configurado, e quem decide
 * é o outro lado. Por isso o motivo diz isso, e o candidato **não tem
 * pontuação** — uma pontuação aqui seria a falsa afirmação de que a Evelyn
 * comparou candidatos.
 *
 * ## Por que continua sendo um plano
 *
 * Porque o motor de rota precisa de um alvo, e porque o relatório precisa
 * saber quem foi chamado. O resto — orçamento, cota, breaker, métricas — vem
 * do mesmo caminho de sempre.
 */
export function singleTargetPlan(plan: Extract<RouterPlan, { kind: 'single' }>): {
	readonly primary: SelectableModel;
	readonly candidates: readonly SelectableModel[];
	readonly reasons: readonly SelectionReason[];
} {
	const model: SelectableModel = {
		providerId: plan.providerId,
		modelId: plan.modelId,
		providerName: plan.providerId,
		catalog: undefined,
		available: true,
	};
	const reason =
		plan.mode === 'external'
			? 'modelo pedido ao roteador externo; quem escolhe o modelo é ele'
			: 'modelo pedido ao provedor direto; a Evelyn não escolheu';
	return {
		primary: model,
		candidates: [],
		reasons: [
			{
				providerId: plan.providerId,
				modelId: plan.modelId,
				chosen: true,
				reason,
				capabilities: [],
				supportsTools: false,
				supportsStreaming: true,
				access: 'unknown',
				constraints: [],
				confidence: [],
			},
		],
	};
}
