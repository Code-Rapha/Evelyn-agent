/**
 * A escolha de modelo no painel, como função pura (R4S).
 *
 * ## Por que não mora no renderer
 *
 * A regra é pequena e importante: o **provedor** de um modelo vem do par que a
 * lista traz, nunca de um recorte do nome. O renderer roda dentro do Electron
 * e não é testável sem a janela; aqui a regra é a mesma função que ele usa,
 * com teste direto.
 *
 * O defeito que ela corrige: `"deepseek-ai/DeepSeek-V4.1-Flash".split('/')[0]`
 * dava `deepseek-ai` como provedor e o serviço recusava o pedido.
 */
import type { AvailableModel } from './contract';

/** O par (provedor, modelo) que uma escolha representa. */
export interface ModelChoice {
	readonly providerId: string;
	readonly model: string;
}

/**
 * O par da escolha atual.
 *
 * `preferredProviderId` desempata dois modelos de mesmo nome oferecidos por
 * provedores diferentes. Sem ele (ou se não casar), o primeiro da lista serve
 * — a escolha continua sendo um par real, nunca um palpite sobre o nome.
 */
export function chooseProviderFor(
	available: readonly AvailableModel[],
	preferredProviderId: string,
	model: string,
): ModelChoice | undefined {
	if (model.length === 0) {
		return undefined;
	}
	const exact = available.find(
		(candidate) => candidate.model === model && candidate.providerId === preferredProviderId,
	);
	if (exact !== undefined) {
		return { providerId: exact.providerId, model: exact.model };
	}
	const byModel = available.find((candidate) => candidate.model === model);
	return byModel === undefined ? undefined : { providerId: byModel.providerId, model: byModel.model };
}
