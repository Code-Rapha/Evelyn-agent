/**
 * A configuração do roteador: para onde a requisição vai, e se ela vai.
 *
 * ## Os três modos
 *
 * - **`native`** — o motor da própria Evelyn escolhe o modelo: o plano da
 *   seleção, o orçamento, as cotas e o breaker. É o modo de sempre, e o
 *   padrão;
 * - **`external`** — um endpoint compatível com a API OpenAI (o 9Router, ou
 *   outro) decide qual modelo responde. A Evelyn continua sendo quem
 *   mede, registra e reporta, mas não é quem escolhe o modelo;
 * - **`direct`** — a chamada vai direto a um provedor, sem roteador no meio.
 *
 * ## O interruptor
 *
 * `enabled` é separado do modo de propósito: desligar o roteador não é
 * "usar o modo direto". Um é o interruptor, o outro é **para onde**.
 *
 * ## O que este arquivo não decide
 *
 * Quem escolhe o modelo em cada modo, e o que acontece com a política de
 * acesso, o orçamento e as cotas — isso é do runtime, e a 6B vai ligar os dois.
 * Aqui mora apenas a **decisão persistida** e as regras para lê-la e gravá-la
 * sem quebrar: um arquivo ausente ou inválido não pode impedir o app de
 * abrir.
 *
 * ## Nenhum segredo
 *
 * A configuração guarda *identificadores* de provedor, nunca chaves. A chave
 * continua no `SecretStore`, e o provedor é resolvido por id.
 */
import { ValidationError } from '../../errors';

/**
 * Para onde a requisição vai.
 *
 * `native` é o padrão porque é o que o app já fazia: o motor próprio.
 */
export type RouterMode = 'native' | 'external' | 'direct';

export const ROUTER_MODES: readonly RouterMode[] = ['native', 'external', 'direct'];

/** O papel de um endpoint: um roteador (que escolhe o modelo), um provedor de modelos, ou um buscador da web. */
export type ProviderRole = 'router' | 'provider' | 'search';

/**
 * A configuração do roteador, como fica gravada.
 *
 * `externalRouterProviderId` e `directProviderId` só são exigidos no modo
 * correspondente; nos outros, são ausentes. Um arquivo com o id sobrando é
 * lido sem ele — o campo que não é do modo não pertence à decisão.
 */
export interface RouterConfig {
	/** O roteador está ligado? */
	readonly enabled: boolean;
	/** Para onde a requisição vai. */
	readonly mode: RouterMode;
	/**
	 * O provedor que age como roteador externo, quando `mode` é `external`.
	 *
	 * É o **id** do provedor, nunca a base URL e nunca a chave: a base URL
	 * muda, o id não.
	 */
	readonly externalRouterProviderId?: string;
	/**
	 * O provedor chamado diretamente, quando `mode` é `direct`.
	 */
	readonly directProviderId?: string;
	/** Quando a configuração foi gravada pela última vez. */
	readonly updatedAt: string;
}

/**
 * O padrão.
 *
 * `enabled: true` com `mode: 'native'` é **exatamente** o comportamento de
 * antes desta etapa: o motor próprio, sempre ligado. Um app recém-instalado
 * (ou com o arquivo ausente) continua fazendo o que fazia.
 */
export const DEFAULT_ROUTER_CONFIG: RouterConfig = {
	enabled: true,
	mode: 'native',
	updatedAt: new Date(0).toISOString(),
};

/** O modo é um dos três? */
export function isRouterMode(value: unknown): value is RouterMode {
	return value === 'native' || value === 'external' || value === 'direct';
}

/**
 * O papel é um dos três?
 *
 * `search` é o buscador da web: tem chave e endereço como qualquer provedor,
 * mas **não** é um modelo. O roteador não pode escolhê-lo para responder um
 * turno, e é por isso que ele é um papel separado em vez de um provedor com
 * uma marca qualquer.
 */
export function isProviderRole(value: unknown): value is ProviderRole {
	return value === 'router' || value === 'provider' || value === 'search';
}

/**
 * O papel de um provedor, com o padrão dos dados antigos.
 *
 * Um registro gravado antes de o papel existir é um **provedor**: era a única
 * coisa que se podia ter. A ausência é lida como tal, e não como um papel
 * indefinido.
 */
export function providerRoleOf(role: ProviderRole | undefined): ProviderRole {
	if (role === 'router' || role === 'search') {
		return role;
	}
	return 'provider';
}

/**
 * O provedor que o modo aponta.
 *
 * `undefined` quando o modo não usa um provedor — `native` escolhe sozinho —
 * ou quando o id apontado não está gravado.
 */
export function providerIdForMode(config: RouterConfig): string | undefined {
	switch (config.mode) {
		case 'external':
			return config.externalRouterProviderId;
		case 'direct':
			return config.directProviderId;
		case 'native':
			return undefined;
	}
}

/**
 * A configuração pode ser obedecida?
 *
 * Um modo que aponta para um provedor sem id é um estado que o app não pode
 * cumprir: não há para onde mandar a requisição. A leitura tolera isso
 * (volta ao padrão), e a gravação recusa (não grava um estado impossível).
 */
export function isRouterConfigUsable(config: RouterConfig): boolean {
	if (config.mode === 'native') {
		return true;
	}
	const id = providerIdForMode(config);
	return id !== undefined && id.trim().length > 0;
}

/**
 * Valida uma configuração antes de gravá-la.
 *
 * Recusa o que não pode ser obedecido, e normaliza o resto: um id sem
 * espaços é trimmed, e o id que não pertence ao modo é descartado — ele
 * descreve uma decisão que o modo atual não tomou.
 */
export function validateRouterConfig(config: RouterConfig): RouterConfig {
	if (typeof config.enabled !== 'boolean') {
		throw new ValidationError('A router configuration requires a boolean "enabled"', {
			details: { field: 'enabled', received: config.enabled },
		});
	}
	if (!isRouterMode(config.mode)) {
		throw new ValidationError(
			`A router configuration requires a mode of ${ROUTER_MODES.join(', ')}`,
			{ details: { field: 'mode', received: config.mode } },
		);
	}
	const external = normalizeId(config.externalRouterProviderId);
	const direct = normalizeId(config.directProviderId);
	if (config.mode === 'external' && external === undefined) {
		throw new ValidationError(
			'The "external" router mode requires the provider that acts as the router',
			{ details: { field: 'externalRouterProviderId', mode: config.mode } },
		);
	}
	if (config.mode === 'direct' && direct === undefined) {
		throw new ValidationError(
			'The "direct" router mode requires the provider to call',
			{ details: { field: 'directProviderId', mode: config.mode } },
		);
	}
	return {
		enabled: config.enabled,
		mode: config.mode,
		...(config.mode === 'external' && external !== undefined
			? { externalRouterProviderId: external }
			: {}),
		...(config.mode === 'direct' && direct !== undefined ? { directProviderId: direct } : {}),
		updatedAt:
			typeof config.updatedAt === 'string' && !Number.isNaN(Date.parse(config.updatedAt))
				? config.updatedAt
				: new Date(0).toISOString(),
	};
}

/** Um identificador não vazio, ou `undefined`. */
function normalizeId(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}
