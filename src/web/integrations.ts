/**
 * A galeria de provedores e integrações.
 *
 * ## O que é — e o que não é
 *
 * É um **catálogo estático de metadados**: o que cada integração é, como ela
 * se conecta, se o app suporta aquele método hoje, e quais dependências
 * externas existem. Não é uma conexão: nada aqui prova que um endpoint
 * responde, e nenhum item entra em `state.json` por estar listado.
 *
 * Isso responde a armadilha pedida: **metadado não é autenticação**. Um cartão
 * só vira "conectado" quando existe um provedor real em `state.json` cujo
 * endereço a galeria reconhece — e mesmo então, "conectado" é o que o Core
 * diz, não o que o catálogo afirma.
 *
 * ## A regra de honestidade
 *
 * Cada integração declara o método de conexão **que o app suporta de fato**:
 *
 * - `api-key`: o formulário existente grava a chave no `SecretStore` e o app
 *   fala HTTP com o endpoint. É o único método que o app executa sozinho.
 * - `cli-or-oauth`: depende de uma ferramenta externa (um CLI, um login
 *   OAuth) que o app **não** executa. A integração aparece como experimental
 *   ou indisponível, com o motivo, e a instrução do que fazer — nunca com um
 *   botão que finge conectar.
 * - `manual`: exige edição de configuração fora do app; aparece como
 *   indisponível com o motivo.
 *
 * ## O que a galeria não inventa
 *
 * Endereços, fluxos e nomes de modelos. Quando o endereço de uma integração
 * é conhecido e estável, ele vem preenchido no formulário para o usuário não
 * digitar; quando não é, o campo fica vazio e a instrução diz que o usuário
 * precisa informar o seu.
 */
import type { ProviderSummary } from '../desktop/contract';

/** Como uma integração pode ser conectada **por este app**. */
export type ConnectionKind = 'api-key' | 'cli-or-oauth' | 'manual';

/** A situação do suporte do app para a integração. */
export type SupportStatus = 'supported' | 'experimental' | 'unavailable';

/** A categoria da galeria. */
export type IntegrationCategory = 'official' | 'free-via-tools' | 'experimental';

/** Uma entrada da galeria. */
export interface Integration {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	/** A categoria, na ordem em que a galeria as mostra. */
	readonly category: IntegrationCategory;
	/** Como o app conecta — e só isso. */
	readonly connection: ConnectionKind;
	/** Se o app suporta o método hoje. */
	readonly support: SupportStatus;
	/**
	 * O endereço base, quando ele é conhecido e estável.
	 *
	 * Ausente = o usuário informa o seu. **Nunca** um endereço inventado.
	 */
	readonly baseUrl?: string;
	/** O que o usuário precisa ter em mãos. */
	readonly requires: readonly string[];
	/** A limitação conhecida, dita sem rodeios. */
	readonly limitation?: string;
	/** O que fazer quando o app não executa a conexão. */
	readonly instructions?: string;
	/**
	 * A integração tem um gerenciador de servidor próprio.
	 *
	 * O OpenCode não é um provedor compatível com OpenAI: o app fala com um
	 * servidor dele por rotas próprias (`/api/opencode/*`). A marca diz à
	 * página qual fluxo abrir, em vez de mandá-la ao formulário de chave.
	 */
	readonly managedServer?: boolean;
}

/**
 * O catálogo inicial.
 *
 * Só entram integrações cujo método o app **executa** (chave de API em
 * endpoint compatível com OpenAI) ou que precisam estar visíveis como não
 * suportadas — porque o usuário as procura e precisa saber por quê.
 *
 * As de chave são oficiais quando o provedor publica um endpoint compatível, e
 * experimentais quando o endereço é do usuário (um proxy local, por exemplo).
 */
export const INTEGRATIONS: readonly Integration[] = [
	{
		id: 'openai',
		name: 'OpenAI',
		description: 'Modelos da OpenAI pela API oficial, com chave de projeto.',
		category: 'official',
		connection: 'api-key',
		support: 'supported',
		baseUrl: 'https://api.openai.com/v1',
		requires: ['uma chave de API da OpenAI'],
	},
	{
		id: 'openrouter',
		name: 'OpenRouter',
		description: 'Um só endpoint para vários provedores, com modelos gratuitos listados pelo próprio serviço.',
		category: 'official',
		connection: 'api-key',
		support: 'supported',
		baseUrl: 'https://openrouter.ai/api/v1',
		requires: ['uma chave de API do OpenRouter'],
		limitation: 'Os modelos gratuitos dependem da conta e mudam com o tempo; a lista vem do serviço, não daqui.',
	},
	{
		id: 'groq',
		name: 'Groq',
		description: 'Inferência rápida em modelos abertos hospedados pela Groq.',
		category: 'official',
		connection: 'api-key',
		support: 'supported',
		baseUrl: 'https://api.groq.com/openai/v1',
		requires: ['uma chave de API da Groq'],
	},
	{
		id: 'opencode',
		name: 'OpenCode',
		description: 'Conversa pelo servidor do OpenCode, usando a conta que o CLI dele já tem.',
		category: 'free-via-tools',
		connection: 'cli-or-oauth',
		support: 'experimental',
		managedServer: true,
		requires: ['o CLI do OpenCode instalado', 'a conta autenticada no CLI do OpenCode'],
		limitation:
			'Nesta etapa o app inicia e verifica o servidor e lê o catálogo de modelos dele. Nenhuma conversa é enviada e nenhuma sessão é aberta; o login na conta é feito no CLI, fora do app.',
		instructions:
			'Instale e autentique o CLI do OpenCode fora do app. Depois escolha "automático" (o app inicia o servidor com senha própria) ou informe o endereço e a senha de um servidor que você mesmo iniciou.',
	},
	{
		id: 'kiro',
		name: 'Kiro',
		description: 'Assistente com acesso a modelos pela assinatura, autenticado na conta Kiro.',
		category: 'free-via-tools',
		connection: 'cli-or-oauth',
		support: 'unavailable',
		requires: ['conta Kiro', 'o cliente Kiro instalado'],
		limitation:
			'O acesso é pela sessão autenticada do cliente Kiro, não por chave de API. O app não executa esse login nem fala com ele.',
		instructions:
			'Não há método suportado hoje. Se quiser usar os modelos por outro caminho, cadastre um endpoint compatível com OpenAI em “Adicionar provedor personalizado”.',
	},
	{
		id: 'local-openai-compatible',
		name: 'Servidor local (OpenAI-compatible)',
		description: 'Qualquer servidor que fale a API OpenAI no seu computador ou na sua rede.',
		category: 'experimental',
		connection: 'api-key',
		support: 'supported',
		requires: ['o endereço do servidor', 'a chave dele, se exigir'],
		limitation:
			'O app não descobre o endereço: você informa. A chave é opcional — servidores locais costumam não pedir.',
	},
	{
		id: 'custom',
		name: 'Outro provedor compatível com OpenAI',
		description: 'Qualquer serviço que publique a API OpenAI e aceite uma chave.',
		category: 'experimental',
		connection: 'api-key',
		support: 'supported',
		requires: ['o endereço base', 'a chave de API'],
		limitation: 'A descoberta de modelos depende do que o serviço publicar; preços e cotas só se ele os informar.',
	},
];

/** O nome da categoria, como a galeria a mostra. */
export function categoryLabel(category: IntegrationCategory): string {
	switch (category) {
		case 'official':
			return 'Oficiais';
		case 'free-via-tools':
			return 'Gratuitas via ferramentas externas';
		case 'experimental':
			return 'Experimentais e personalizados';
	}
}

/**
 * A situação de uma integração **frente às conexões reais**.
 *
 * `connected` só é dito quando um provedor configurado aponta para o mesmo
 * endereço da integração. As demais situações vêm do próprio catálogo — e
 * "disponível para conectar" não é uma promessa de que o serviço responde:
 * é o app dizendo que tem como tentar.
 */
export type IntegrationState = 'connected' | 'available' | 'needs-auth' | 'unavailable' | 'experimental';

/** Normaliza um endereço para comparar dois, sem depender de barra final. */
function normalizeUrl(value: string): string {
	return value.trim().replace(/\/+$/, '').toLowerCase();
}

/** A situação da integração, dada a lista de provedores reais. */
export function integrationState(
	integration: Integration,
	providers: readonly ProviderSummary[],
): { readonly state: IntegrationState; readonly provider?: ProviderSummary } {
	if (integration.baseUrl !== undefined) {
		const url = normalizeUrl(integration.baseUrl);
		const provider = providers.find((entry) => normalizeUrl(entry.baseUrl) === url);
		if (provider !== undefined) {
			return { state: 'connected', provider };
		}
	}
	if (integration.support === 'unavailable') {
		return { state: 'needs-auth' };
	}
	// Experimental é a categoria; o suporte pode ser completo e mesmo assim a
	// integração é experimental — o endereço e o suporte são do usuário.
	if (integration.support === 'experimental' || integration.category === 'experimental') {
		return { state: 'experimental' };
	}
	return { state: 'available' };
}

/** A galeria inteira, com o estado de cada integração. */
export function buildGallery(providers: readonly ProviderSummary[]): readonly {
	readonly integration: Integration;
	readonly state: IntegrationState;
	readonly provider?: ProviderSummary;
}[] {
	return INTEGRATIONS.map((integration) => ({ integration, ...integrationState(integration, providers) }));
}
