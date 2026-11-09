/**
 * O parser da configuração do roteador, usado pela ponte do preload.
 *
 * ## O que este parser recusa
 *
 * Um modo fora do vocabulário, um interruptor que não é booleano, um id que
 * não é texto. A janela é a parte menos confiável do app — é a única que
 * corre com conteúdo vindo de fora — e um valor que ela não entendeu não pode
 * virar um estado de roteamento.
 *
 * ## O que ele nunca carrega
 *
 * Nenhuma chave, nenhum cabeçalho. A configuração do roteador é um
 * interruptor, um modo e um **id** de provedor; o segredo do provedor continua
 * no `SecretStore`, do outro lado da ponte.
 */
import type { RouterConfigView } from './contract';

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function parseRouterConfigView(value: unknown): RouterConfigView | undefined {
	if (!isObject(value)) {
		return undefined;
	}
	const mode = value.mode;
	if (mode !== 'native' && mode !== 'external' && mode !== 'direct') {
		return undefined;
	}
	if (typeof value.enabled !== 'boolean') {
		return undefined;
	}
	const externalRouterProviderId = text(value.externalRouterProviderId);
	const directProviderId = text(value.directProviderId);
	// DEV-8.13: `source` diz de onde a decisão veio (`local`, `service`) e
	// `unavailable` significa "não há uma configuração real para mostrar".
	// Descartá-lo aqui fez a janela perder a procedência e, com ela, a
	// possibilidade de editar — o defeito medido no executável.
	const source =
		value.source === 'local' || value.source === 'service' || value.source === 'unavailable'
			? value.source
			: undefined;
	const reason = text(value.reason);
	return {
		mode,
		enabled: value.enabled,
		...(externalRouterProviderId !== undefined ? { externalRouterProviderId } : {}),
		...(directProviderId !== undefined ? { directProviderId } : {}),
		updatedAt: text(value.updatedAt) ?? new Date(0).toISOString(),
		configured: value.configured === true,
		...(source !== undefined ? { source } : {}),
		...(reason !== undefined ? { reason } : {}),
		...(text(value.unreadable) !== undefined ? { unreadable: text(value.unreadable) as string } : {}),
		...(value.recoveredFromBackup === true ? { recoveredFromBackup: true } : {}),
	};
}
