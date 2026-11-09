/**
 * Liga a sessão do Core à superfície `/v1`.
 *
 * ## O que este arquivo liga, e o que ele não faz
 *
 * Ele lê do `ChatSession` o que a API precisa — catálogo, política de acesso,
 * política de rota, breaker, preço efetivo — e constrói o `ApiChatRuntime`
 * uma vez. O runtime é sem estado entre requisições: cada `execute` cria os
 * próprios candidatos, gate de orçamento, gravador de consumo e stream.
 *
 * Nada de roteamento é decidido aqui: os candidatos vêm da mesma seleção que
 * o app usa (`listUsableModels`, já filtrado por política, cota e listagem), e
 * o motor decide fallback e retry.
 *
 * ## Candidatos
 *
 * O modelo pedido pelo cliente é `providerId/modelId`. Ele vai primeiro,
 * quando está no catálogo utilizável. Os demais modelos utilizáveis do mesmo
 * provedor vêm depois, como fallback, na ordem da seleção.
 *
 * Isso não é uma segunda política: é a lista que o app já produz, reordenada
 * para pôr o pedido do cliente à frente. Um modelo que a política de acesso
 * excluiu **não** entra em fallback — pedi-lo é um `404` com o motivo, como
 * no app.
 */
import { join } from 'node:path';

import { ApiKeyStore, API_KEYS_FILE, type CredentialIdentity } from '../core/security/apiKeys';
import type { AssembledCore } from '../app/assemble';
import type { ChatSession } from '../desktop/chatSession';
import { ApiChatRuntime, type ApiRouteCandidate } from './apiChat';
import type { ApiModelEntry } from './openaiApi';

/** O endpoint pronto para o servidor. */
export interface BuiltOpenAiEndpoint {
	readonly keys: ApiKeyStore;
	readonly runtime: ApiChatRuntime;
	readonly listModels: () => Promise<readonly ApiModelEntry[]>;
	readonly authenticate: (presented: string | undefined) => Promise<CredentialIdentity | undefined>;
}

/** O que a montagem precisa. */
export interface OpenAiEndpointOptions {
	readonly core: AssembledCore;
	/** Onde o arquivo de chaves fica; padrão: a raiz do Core. */
	readonly root?: string;
}

/**
 * Monta o endpoint a partir do Core e da sessão.
 *
 * A chave mora na raiz de dados, ao lado de `state.json` e `secrets.json` —
 * nunca dentro de um deles, porque o ciclo de vida é outro: apagar a
 * configuração de provedores não deve revogar os clientes, e revogar um
 * cliente não deve tocar em provedor nenhum.
 */
export function buildOpenAiEndpoint(input: {
	readonly core: AssembledCore;
	readonly chat: ChatSession;
	readonly root?: string;
	readonly onFailure?: (error: unknown, context: { readonly phase: string }) => void;
}): BuiltOpenAiEndpoint {
	const root = input.root ?? input.core.root;
	const keys = new ApiKeyStore({ filePath: join(root, API_KEYS_FILE) });
	const chat = input.chat;
	const access = chat.routingAccess();
	if (access === undefined) {
		throw new Error('a API de clientes exige o motor de rota ligado na sessão');
	}

	const runtime = new ApiChatRuntime({
		providerFor: (providerId) => chat.buildProviderForApi(providerId),
		candidatesFor: async ({ requested }) => candidatesFor(chat, requested),
		policy: access.policy,
		breaker: access.breaker,
		ledger: input.core.history,
		store: input.core.history,
		pricing: async (candidate) => chat.effectivePricingFor(candidate),
		accessPolicy: async () => chat.loadAccessPolicy(),
		...(input.onFailure !== undefined ? { onFailure: input.onFailure } : {}),
	});

	return {
		keys,
		runtime,
		listModels: async () => modelsFor(chat),
		authenticate: async (presented) => {
			if (presented === undefined) {
				return undefined;
			}
			const identity = await keys.verify(presented);
			if (identity === undefined) {
				return undefined;
			}
			// O uso é registrado depois de a chave provar que presta, e nunca
			// bloqueia a requisição.
			void keys.touch(identity.keyId);
			return identity;
		},
	};
}

/**
 * Os candidatos de um pedido: o pedido primeiro, depois os fallbacks.
 *
 * `listUsableModels` já aplica a política de acesso, a listagem e a cota. O
 * que sai daqui é uma **reordenação** dessa lista, não um segundo filtro.
 */
async function candidatesFor(chat: ChatSession, requested: ApiRouteCandidate): Promise<ApiRouteCandidate[]> {
	const usable = await chat.listUsableModels();
	const matches = (candidate: ApiRouteCandidate): boolean =>
		candidate.providerId === requested.providerId && candidate.modelId === requested.modelId;
	const exact = usable.find(matches);
	if (exact === undefined) {
		// O modelo pedido não está utilizável (não listado, cota esgotada, ou
		// fora da política). Pedi-lo é um erro do cliente, não um motivo para
		// responder com outro modelo que ele não pediu.
		return [];
	}
	return [
		{ providerId: exact.providerId, modelId: exact.modelId },
		...usable
			.filter((model) => !matches(model))
			.map((model) => ({ providerId: model.providerId, modelId: model.modelId })),
	];
}

/** O catálogo real, como `/v1/models` o publica. */
async function modelsFor(chat: ChatSession): Promise<readonly ApiModelEntry[]> {
	const usable = await chat.listUsableModels();
	const ownedBy = new Map(chat.listProviders().map((provider) => [provider.id, provider.name]));
	return usable.map((model) => ({
		// O id é o par `providerId/modelId`, como o cliente o devolve no pedido.
		id: `${model.providerId}/${model.modelId}`,
		created: Math.floor(Date.parse(model.listedAt ?? model.created ?? '') / 1000) || 0,
		ownedBy: ownedBy.get(model.providerId) ?? model.providerId,
	}));
}
