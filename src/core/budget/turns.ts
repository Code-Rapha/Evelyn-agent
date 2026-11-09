/**
 * Consumo por conversa, por turno e o que foi previsto para o próximo turno.
 *
 * ## Por que um recorte e não uma segunda história
 *
 * O ledger já grava cada execução com `turnId`, `conversationId` e cada
 * tentativa com modelo e custo. Este módulo só **agrupa** essas execuções;
 * não guarda número à parte e não escreve. Recalcular a partir das execuções é
 * o que garante que "esta conversa gastou X" e "o período gastou Y" contem a
 * mesma coisa.
 *
 * ## Registrado e previsto, lado a lado e nunca fundidos
 *
 * `recorded` é o que o ledger gravou. `forecast` é uma previsão do próximo
 * turno, feita a partir de preço do catálogo e de uma estimativa de tokens.
 * Os dois tipos são diferentes de propósito (`FORE CASTED` vs `ESTIMATE`), e
 * nenhum consumidor consegue somá-los sem escolher fazê-lo.
 *
 * ## O que um recorte não sabe
 *
 * `estimated` no custo registrado é o preço do catálogo aplicado ao que o
 * provedor publicou — o mesmo sentido da 5A. Se uma execução do turno não pôde
 * ser precificada, o turno inteiro é `unknown` com os motivos, e a tela diz
 * isso em vez de mostrar um subtotal com cara de total.
 */
import type { ExecutionRecord } from '../storage/types/consumption';
import { aggregateUsage, type UsageTotal } from './aggregate';
import type { CallForecast } from './forecast';

/** O consumo de um turno. */
export interface TurnUsage extends UsageTotal {
	readonly turnId: string;
	/** Execuções (rodadas) do turno; hoje sempre 1, mas o tipo não promete. */
	readonly executions: number;
	readonly firstStartedAt: string;
	readonly lastStartedAt?: string;
	/** Provedor/modelo que responderam no turno, em ordem de aparição. */
	readonly providerIds: readonly string[];
	readonly modelIds: readonly string[];
}

/** O consumo de uma conversa, com seus turnos. */
export interface ConversationUsage {
	readonly conversationId: string;
	readonly total: UsageTotal;
	/** Do turno mais antigo para o mais recente. */
	readonly turns: readonly TurnUsage[];
}

/** O que a UI mostra sobre uma conversa. */
export interface ConversationUsageView extends ConversationUsage {
	/** A previsão do próximo turno, quando houver como fazê-la. */
	readonly forecast?: CallForecast;
}

/**
 * Agrupa execuções por turno e por conversa.
 *
 * Execuções sem `turnId` — gravadas antes de o host passar um, ou por um host
 * sem turnos — ficam de fora dos recortes de turno, mas **entram** no total da
 * conversa: omiti-las faria o total da conversa não fechar com o do período.
 */
export function usageByConversation(
	conversationId: string,
	executions: readonly ExecutionRecord[],
): ConversationUsage {
	const turns = new Map<string, ExecutionRecord[]>();
	for (const execution of executions) {
		if (execution.turnId === undefined) {
			continue;
		}
		const existing = turns.get(execution.turnId);
		if (existing === undefined) {
			turns.set(execution.turnId, [execution]);
		} else {
			existing.push(execution);
		}
	}

	const turnUsage: TurnUsage[] = [...turns.entries()].map(([turnId, group]) => {
		const ordered = [...group].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
		const providers: string[] = [];
		const models: string[] = [];
		for (const execution of ordered) {
			if (execution.providerId !== undefined && !providers.includes(execution.providerId)) {
				providers.push(execution.providerId);
			}
			if (execution.modelId !== undefined && !models.includes(execution.modelId)) {
				models.push(execution.modelId);
			}
		}
		return {
			turnId,
			...aggregateUsage(ordered).total,
			executions: ordered.length,
			firstStartedAt: ordered[0]?.startedAt ?? '',
			...(ordered[ordered.length - 1] !== undefined
				? { lastStartedAt: ordered[ordered.length - 1]?.startedAt }
				: {}),
			providerIds: providers,
			modelIds: models,
		};
	});
	turnUsage.sort((a, b) => a.firstStartedAt.localeCompare(b.firstStartedAt));

	return {
		conversationId,
		// Todas as execuções da conversa, inclusive as que não têm turno.
		total: aggregateUsage(executions).total,
		turns: turnUsage,
	};
}

/**
 * Consumo por conversa, mais recente primeiro.
 *
 * Só execuções com `conversationId` entram: o ledger não consegue inventar a
 * conversa de uma execução, e uma execução sem ela continua no total do
 * período.
 */
export function usageByChat(
	executions: readonly ExecutionRecord[],
): readonly ConversationUsage[] {
	const groups = new Map<string, ExecutionRecord[]>();
	for (const execution of executions) {
		const conversationId = execution.conversationId;
		if (conversationId === undefined) {
			continue;
		}
		const existing = groups.get(conversationId);
		if (existing === undefined) {
			groups.set(conversationId, [execution]);
		} else {
			existing.push(execution);
		}
	}
	return [...groups.entries()]
		.map(([conversationId, group]) => usageByConversation(conversationId, group))
		.sort(
			(a, b) =>
				(b.turns[b.turns.length - 1]?.lastStartedAt ?? '').localeCompare(
					a.turns[a.turns.length - 1]?.lastStartedAt ?? '',
				) ||
				a.conversationId.localeCompare(b.conversationId),
		);
}
