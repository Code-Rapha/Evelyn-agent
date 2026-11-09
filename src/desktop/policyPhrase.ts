/**
 * A frase do usuário vira política de acesso, ou não vira nada.
 *
 * ## Onde ela é lida
 *
 * Na mensagem que o usuário acabou de mandar, antes de escolher o modelo. Só
 * ali: uma frase antiga no histórico não muda mais nada, e uma pergunta
 * ("posso usar só os gratuitos?") não é uma ordem — `parsePolicyPhrase` recusa
 * as duas.
 *
 * ## O que acontece quando a frase casa
 *
 * 1. A política é gravada (`access-policy.json`) com `changedBy: 'phrase'`;
 * 2. o usuário recebe um aviso dizendo **o que** foi aplicado e **onde** —
 *    nesta sessão, para todas as próximas mensagens;
 * 3. o turno que trouxe a frase já roda sob a política nova.
 *
 * Se gravar falhar, a política **não** vale só em memória: o usuário foi
 * notificado de que ela seria aplicada, e aplicá-la sem persistir faria a
 * escolha desaparecer no próximo start sem explicação. O aviso passa a dizer
 * que a política não pôde ser salva, e o turno segue como estava.
 */
import {
	describePolicyApplication,
	parsePolicyPhrase,
	type ModelAccessPolicyRecord,
} from '../core/catalog/policy';
import type { ChatStreamEvent } from './contract';

export interface PolicyPhraseStore {
	readAccessPolicy(): Promise<ModelAccessPolicyRecord | undefined>;
	saveAccessPolicy(record: ModelAccessPolicyRecord): Promise<ModelAccessPolicyRecord>;
}

export interface PolicyPhraseOutcome {
	/** O registro aplicado, quando a frase mudou alguma coisa e ela foi salva. */
	readonly applied?: ModelAccessPolicyRecord;
	/** O que dizer ao usuário, quando a frase casou. */
	readonly notice?: string;
	/** O que dizer quando a gravação falhou. */
	readonly failure?: string;
}

/**
 * Lê a frase e, quando ela pede uma política diferente da atual, aplica.
 *
 * Uma frase que pede a política que já está em vigor não grava nada e ainda
 * assim notifica: o usuário precisa saber que o pedido foi entendido, e não
 * que foi ignorado por ser redundante.
 */
export async function applyPolicyPhrase(input: {
	readonly text: string;
	readonly store: PolicyPhraseStore;
	readonly now: () => Date;
	readonly current?: ModelAccessPolicyRecord;
}): Promise<PolicyPhraseOutcome> {
	const parsed = parsePolicyPhrase(input.text);
	if (parsed === undefined) {
		return {};
	}
	if (input.current?.policy === parsed.policy) {
		return {
			notice: `A política já estava em vigor: ${describePolicyApplication(input.current.policy)}`,
		};
	}
	const record: ModelAccessPolicyRecord = {
		policy: parsed.policy,
		priceSource: input.current?.priceSource ?? 'user',
		limitsSource: input.current?.limitsSource ?? 'user',
		capabilitiesSource: input.current?.capabilitiesSource ?? 'user',
		updatedAt: input.now().toISOString(),
		changedBy: 'phrase',
	};
	try {
		const saved = await input.store.saveAccessPolicy(record);
		return { applied: saved, notice: describePolicyApplication(saved.policy) };
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return {
			failure: `Entendi "${parsed.matched}", mas não consegui salvar a política (${reason}). Nada foi alterado nesta sessão.`,
		};
	}
}

/**
 * O aviso como evento de chat.
 *
 * Usa o `Notice` que a UI já desenha: não há canal novo, e uma política
 * aplicada é exatamente o tipo de informação que precisa sobreviver à rolagem.
 */
export function policyNoticeEvent(turnId: string, message: string): ChatStreamEvent {
	return { type: 'notice', turnId, message };
}
