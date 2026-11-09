/**
 * Leitura e escrita do arquivo de configuração do roteador.
 *
 * ## Mesma política da política de acesso
 *
 * Um arquivo ausente é "nunca configurado" (`undefined`), e não o padrão: a
 * distinção importa porque o app precisa dizer "você nunca escolheu um
 * roteador" em vez de "você escolheu o roteador nativo".
 *
 * Um valor inválido cai no padrão **do seu campo**, não no de outro: um `mode`
 * desconhecido não desfaz o interruptor, e um interruptor que não é booleano
 * não vira `mode`.
 *
 * ## O reparo de coerência
 *
 * Um modo aponta para um provedor. Se o id apontado não está gravado, o
 * estado não pode ser obedecido — não há para onde mandar a requisição. A
 * leitura **repara**: o modo volta para `native`, que é o comportamento de
 * sempre. Um arquivo editado à mão não pode impedir o app de abrir.
 *
 * ## Nenhum segredo
 *
 * O arquivo guarda um interruptor, um modo e um **id** de provedor. Nada mais.
 * A chave de API continua no `SecretStore`, e não passa por aqui.
 */
import {
	DEFAULT_ROUTER_CONFIG,
	isRouterMode,
	providerIdForMode,
	validateRouterConfig,
	type RouterConfig,
} from '../providers/routing/config';

export const ROUTER_CONFIG_FILE_VERSION = 1;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Um identificador não vazio, ou `undefined`. */
function identifier(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Lê a configuração do roteador.
 *
 * Sem arquivo (`undefined`/vazio) devolve `undefined`: nunca configurado.
 * Um arquivo ilegível ou fora do formato devolve `undefined` também — ele não
 * é uma escolha, é um estrago, e o app abre com o padrão.
 */
export function parseRouterConfig(raw: string | undefined): RouterConfig | undefined {
	if (raw === undefined || raw.trim().length === 0) {
		return undefined;
	}
	let payload: unknown;
	try {
		// Um editor do Windows pode gravar um BOM no começo do arquivo, e o
		// `JSON.parse` não o tolera. Sem esta tolerância, uma configuração
		// válida seria lida como ausente — e o app voltaria ao padrão sem
		// dizer por quê.
		payload = JSON.parse(raw.replace(/^\uFEFF/, ''));
	} catch {
		return undefined;
	}
	if (!isObject(payload)) {
		return undefined;
	}
	const enabled = typeof payload['enabled'] === 'boolean' ? payload['enabled'] : DEFAULT_ROUTER_CONFIG.enabled;
	const mode = isRouterMode(payload['mode']) ? payload['mode'] : DEFAULT_ROUTER_CONFIG.mode;
	const externalRouterProviderId = identifier(payload['externalRouterProviderId']);
	const directProviderId = identifier(payload['directProviderId']);
	const updatedAt =
		typeof payload['updatedAt'] === 'string' && !Number.isNaN(Date.parse(payload['updatedAt']))
			? payload['updatedAt']
			: DEFAULT_ROUTER_CONFIG.updatedAt;

	// O reparo de coerência: o modo só sobrevive se o provedor que ele aponta
	// estiver gravado. Sem isso, o app abriria com um estado que não pode
	// obedecer.
	let effectiveMode: RouterConfig['mode'] = mode;
	if (mode === 'external' && externalRouterProviderId === undefined) {
		effectiveMode = 'native';
	}
	if (mode === 'direct' && directProviderId === undefined) {
		effectiveMode = 'native';
	}

	return {
		enabled,
		mode: effectiveMode,
		...(effectiveMode === 'external' && externalRouterProviderId !== undefined
			? { externalRouterProviderId }
			: {}),
		...(effectiveMode === 'direct' && directProviderId !== undefined ? { directProviderId } : {}),
		updatedAt,
	};
}

/**
 * A forma gravada.
 *
 * Só o que a decisão contém: o interruptor, o modo, o id que o modo aponta e a
 * data. O id do modo que não está em vigor **não** é gravado — ele descreveria
 * uma decisão que ninguém tomou.
 */
export function serializeRouterConfig(config: RouterConfig): string {
	const validated = validateRouterConfig(config);
	const id = providerIdForMode(validated);
	return `${JSON.stringify(
		{
			version: ROUTER_CONFIG_FILE_VERSION,
			enabled: validated.enabled,
			mode: validated.mode,
			...(validated.mode === 'external' && id !== undefined
				? { externalRouterProviderId: id }
				: {}),
			...(validated.mode === 'direct' && id !== undefined ? { directProviderId: id } : {}),
			updatedAt: validated.updatedAt,
		},
		null,
		2,
	)}\n`;
}
