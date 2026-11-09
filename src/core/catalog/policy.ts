/**
 * A política de acesso a modelos: o que pode ser chamado, e em que ordem.
 *
 * ## As três políticas
 *
 * - `any` — o comportamento de sempre. Permissões e orçamentos decidem.
 * - `free_only` — só o que tem **acesso gratuito confirmado**. Pago e
 *   desconhecido ficam de fora, inclusive como fallback. Se não sobrar nada, a
 *   resposta é "não há", não uma chamada paga "só desta vez".
 * - `free_preferred` — gratuito primeiro, o resto atrás, sob as mesmas regras
 *   de permissão (`allowPaid`, orçamento, cota).
 *
 * ## Gratuito exige prova, preço zero não basta
 *
 * A frase "use somente os modelos gratuitos" é uma afirmação sobre a **conta**
 * do usuário, não sobre a tabela de preços. Um modelo listado a US$ 0 pode
 * estar fora do plano contratado, e outro pode ser gratuito por uma cota que
 * não é dele. Por isso a elegibilidade gratuita olha só para uma classificação
 * de acesso confirmada, com fonte e validade:
 *
 * - a descoberta registrou `free` (evidência do provedor: ambos os preços
 *   publicados zerados) e a evidência não venceu; **ou**
 * - o usuário declarou `free` no catálogo para aquele modelo.
 *
 * Um preço zero sozinho, sem `access === 'free'`, não classifica nada.
 *
 * ## A política não substitui as outras regras
 *
 * `allowPaid: false`, os limites de orçamento (5B) e a cota da janela (5D)
 * continuam valendo por cima. `free_preferred` nunca "autoriza" um pago que a
 * sessão não autorizou: ela só ordena o que já era permitido.
 */

/** O que a política diz sobre a seleção. Persistida, tipada e legível. */
export type ModelAccessPolicy = 'any' | 'free_only' | 'free_preferred';

export const MODEL_ACCESS_POLICIES: readonly ModelAccessPolicy[] = ['any', 'free_only', 'free_preferred'];

/** Onde uma política se aplica. Hoje a sessão inteira; o tipo já diz isso. */
export interface ModelAccessPolicyRecord {
	readonly policy: ModelAccessPolicy;
	/**
	 * De que lado o preço vale: o do usuário (padrão) ou o do provedor.
	 *
	 * A escolha é por **grupo de metadado**, e não um interruptor geral: preço,
	 * limites e capacidades mudam em ritmos diferentes, e um usuário que quer o
	 * preço do provedor não está necessariamente dizendo o mesmo sobre a
	 * janela de contexto. Cada grupo tem a sua escolha, e cada uma é
	 * reversível porque o valor declarado continua intacto.
	 */
	readonly priceSource: 'user' | 'discovered';
	/** De que lado os limites valem: o declarado ou o publicado. */
	readonly limitsSource: 'user' | 'discovered';
	/** De que lado as capacidades valem: as declaradas ou as publicadas. */
	readonly capabilitiesSource: 'user' | 'discovered';
	/** Quando o usuário mudou a política. */
	readonly updatedAt: string;
	/**
	 * O que disparou a mudança. `phrase` é a frase dita no chat; `ui` é o
	 * controle da janela. A UI informa o que foi aplicado a partir daqui.
	 */
	readonly changedBy: 'user' | 'phrase';
}

/** O padrão, o mesmo de antes desta etapa: tudo sob as regras já existentes. */
export const DEFAULT_ACCESS_POLICY: ModelAccessPolicyRecord = {
	policy: 'any',
	priceSource: 'user',
	limitsSource: 'user',
	capabilitiesSource: 'user',
	updatedAt: new Date(0).toISOString(),
	changedBy: 'user',
};

export function isModelAccessPolicy(value: unknown): value is ModelAccessPolicy {
	return value === 'any' || value === 'free_only' || value === 'free_preferred';
}

/**
 * A prova de acesso gratuito que a política aceita.
 *
 * Duas fontes, e as duas são declarações explícitas: o provedor publicou zero
 * nos dois sentidos, ou o usuário classificou o modelo como gratuito. Nenhuma
 * é um preço inferido.
 */
export interface FreeEvidence {
	/** Classificação de acesso, de uma fonte que fala por esta conta. */
	readonly access: 'free' | 'paid' | 'unknown';
	/** De onde veio: `provider`/`account` (descoberta) ou `manual` (catálogo). */
	readonly source: 'provider' | 'account' | 'manual' | 'unknown';
	/** A evidência ainda vale agora. Ausente = não há prazo informado e vale. */
	readonly usable?: boolean;
}

/** O que a política precisa saber sobre um modelo, e nada mais. */
export interface PolicyCandidate {
	readonly providerId: string;
	readonly modelId: string;
	/** A prova de gratuidade, quando existe. */
	readonly freeEvidence?: FreeEvidence;
}

export type PolicyVerdict =
	| { readonly eligible: true }
	| { readonly eligible: false; readonly reason: PolicyExclusionReason };

export type PolicyExclusionReason =
	/** A política é `free_only` e não há classificação de gratuito. */
	| 'free_not_confirmed'
	/** Havia classificação de gratuito, mas a evidência venceu. */
	| 'free_evidence_expired'
	/** O modelo está classificado como pago. */
	| 'paid';

/**
 * Se um modelo pode ser chamado sob a política.
 *
 * Só `free_only` exclui. `any` e `free_preferred` deixam passar tudo: a
 * preferência é ordem, não filtro, e aplicá-la como filtro seria a mesma
 * proibição com outro nome.
 */
export function evaluatePolicy(candidate: PolicyCandidate, policy: ModelAccessPolicy): PolicyVerdict {
	if (policy !== 'free_only') {
		return { eligible: true };
	}
	const evidence = candidate.freeEvidence;
	if (evidence === undefined) {
		return { eligible: false, reason: 'free_not_confirmed' };
	}
	if (evidence.access === 'paid') {
		return { eligible: false, reason: 'paid' };
	}
	if (evidence.access !== 'free') {
		return { eligible: false, reason: 'free_not_confirmed' };
	}
	if (evidence.usable === false) {
		return { eligible: false, reason: 'free_evidence_expired' };
	}
	// Só provedor, conta ou o próprio usuário classificam. `unknown` como fonte
	// de um `free` seria uma classificação sem autor.
	if (evidence.source !== 'provider' && evidence.source !== 'account' && evidence.source !== 'manual') {
		return { eligible: false, reason: 'free_not_confirmed' };
	}
	return { eligible: true };
}

/**
 * Ordena candidatos segundo a política, sem remover os inelegíveis de `any`
 * e `free_preferred`.
 *
 * A ordem é estável: dentro de cada grupo a posição de entrada é mantida, para
 * que o desempate continue sendo do seletor de tarefa e não desta função.
 */
export function orderByPolicy<T extends PolicyCandidate>(
	candidates: readonly T[],
	policy: ModelAccessPolicy,
): readonly T[] {
	if (policy === 'free_only') {
		return candidates.filter((candidate) => evaluatePolicy(candidate, policy).eligible);
	}
	if (policy !== 'free_preferred') {
		return [...candidates];
	}
	const free: T[] = [];
	const other: T[] = [];
	for (const candidate of candidates) {
		if (evaluatePolicy(candidate, policy).eligible && isConfirmedFree(candidate)) {
			free.push(candidate);
		} else {
			other.push(candidate);
		}
	}
	return [...free, ...other];
}

function isConfirmedFree(candidate: PolicyCandidate): boolean {
	const evidence = candidate.freeEvidence;
	return evidence !== undefined && evaluatePolicy(candidate, 'free_only').eligible;
}

/**
 * A frase do usuário vira política, ou nada.
 *
 * Reconhece "use somente os modelos gratuitos" e variantes próximas em
 * português ("só modelos grátis", "use apenas os gratuitos"). Não reconhece
 * negação ("não use só os gratuitos") nem pergunta ("posso usar só os
 * gratuitos?"): aplicar uma política por causa de uma pergunta seria tomar
 * uma decisão que ninguém pediu.
 */
export function parsePolicyPhrase(text: string): {
	readonly policy: ModelAccessPolicy;
	/** O trecho que casou, para a sessão citar o que aplicou. */
	readonly matched: string;
} | undefined {
	const normalized = text
		.toLowerCase()
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
	if (normalized.length === 0) {
		return undefined;
	}
	// Uma pergunta não é uma ordem.
	if (normalized.endsWith('?') || /\b(posso|poderia|daria|devo|sera que)\b/.test(normalized)) {
		return undefined;
	}
	// Uma negação inverte o sentido da frase inteira.
	if (/\b(?:nao|not|don't|dont)\s+(?:use|usar|utilize|usar\s+so)\b/.test(normalized) || /\bnao\s+quero\b/.test(normalized)) {
		return undefined;
	}
	const freeWord = '(?:gratuitos?|gratis|free)';
	const onlyWord = '(?:somente|so|apenas|exclusivamente|unicamente|only|just)';
	const onlyPattern = new RegExp(
		`\\b${onlyWord}\\b[^.]{0,40}\\b${freeWord}\\b|\\b${freeWord}\\b[^.]{0,40}\\b${onlyWord}\\b`,
	);
	if (onlyPattern.test(normalized)) {
		return { policy: 'free_only', matched: 'somente modelos gratuitos' };
	}
	const preferPattern = new RegExp(
		`\\b(?:prefira|preferir|prefere|priorize|priorizar|de preferencia)\\b[^.]{0,40}\\b${freeWord}\\b`,
	);
	if (preferPattern.test(normalized)) {
		return { policy: 'free_preferred', matched: 'preferir modelos gratuitos' };
	}
	return undefined;
}

/** A explicação que a sessão mostra ao aplicar uma política. */
export function describePolicyApplication(policy: ModelAccessPolicy): string {
	switch (policy) {
		case 'free_only':
			return 'Política aplicada: use somente modelos gratuitos. Só modelos com acesso gratuito confirmado serão chamados; se nenhum estiver disponível, nada será chamado.';
		case 'free_preferred':
			return 'Política aplicada: prefira modelos gratuitos. Modelos gratuitos confirmados vêm primeiro; os demais seguem as permissões e o orçamento existentes.';
		case 'any':
			return 'Política aplicada: nenhum filtro de acesso. Permissões e orçamento continuam valendo.';
	}
}

/** A mensagem de recusa quando `free_only` não encontra nada elegível. */
export function describeNoEligibleModel(missing: {
	readonly total: number;
	readonly expired: number;
}): string {
	if (missing.total === 0) {
		return 'Nenhum modelo foi descoberto. A política "somente gratuitos" não pode ser cumprida, então nenhuma chamada foi feita.';
	}
	const expired = missing.expired > 0 ? ` (${missing.expired} com evidência de gratuito vencida)` : '';
	return `A política "somente gratuitos" está ativa e nenhum dos ${missing.total} modelos disponíveis tem acesso gratuito confirmado${expired}. Nenhuma chamada foi feita; modelos pagos ou de acesso desconhecido não são uma alternativa nesta política.`;
}
