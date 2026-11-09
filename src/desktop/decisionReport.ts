/**
 * O relatório de uma decisão de roteamento.
 *
 * ## O que é
 *
 * Um registro por execução: qual modelo foi escolhido e por quê, o que foi
 * descartado, de onde veio o preço e os metadados que influenciaram a
 * escolha, que restrições de orçamento e cota existiam, quais fallbacks
 * aconteceram e como a rodada terminou.
 *
 * ## O que ele não é
 *
 * Não é o log de rede, nem a transcrição, nem o histórico do ledger. Não
 * contém:
 *
 * - **chaves de API** — o provedor nunca as entrega ao host, e o relatório é
 *   montado a partir de decisões, não de requisições;
 * - **cabeçalhos de resposta** — no máximo o que a API disse sobre a cota, e
 *   apenas o número e a data;
 * - **conteúdo de conversa** — nem a pergunta, nem a resposta, nem um
 *   resumo delas. O relatório diz *qual* modelo respondeu, não *o que* ele
 *   disse.
 *
 * A regra é testável: serializar o relatório não pode conter uma chave, um
 * cabeçalho de autorização nem o texto de um turno.
 */
import type { ModelAccessPolicy } from '../core/catalog/policy';
import type { ModelAccess } from '../core/storage/types/modelCatalog';
import type { RouterMode } from '../core/providers/routing/config';
import type { TaskClassificationExplanation } from './taskDiscovery';

/** A procedência de um número que influenciou a decisão. */
export interface ReportProvenance {
	/** De onde veio: `manual` (o usuário), `provider` (o provedor), `account`. */
	readonly source: string;
	/** Quando foi verificado, quando isso é conhecido. */
	readonly verifiedAt?: string;
	/** Até quando vale, quando isso é conhecido. */
	readonly expiresAt?: string;
	/** O dado é antigo e continua exibível, mas não é atual. */
	readonly stale?: boolean;
	/** O valor não pode ser usado agora (vencido ou de uma atualização que falhou). */
	readonly unusable?: boolean;
	readonly unusableReason?: string;
}

/** O preço que valia no momento da decisão. */
export interface ReportPrice {
	readonly currency: string;
	readonly unit: 'per_1k_tokens' | 'per_1m_tokens';
	readonly input?: number;
	readonly output?: number;
	/** De que lado o preço veio. */
	readonly side: 'user' | 'discovered';
	readonly provenance?: ReportProvenance;
}

/** Os limites que valiam no momento da decisão. */
export interface ReportLimits {
	readonly contextTokens?: number;
	readonly maxOutputTokens?: number;
	readonly provenance?: ReportProvenance;
}
/**
 * As decisões do roteador, e o que é conhecido sobre elas.
 *
 * No modo `native`, a Evelyn escolheu: isso é conhecido. Num modo de alvo
 * único, quem escolheu foi o outro lado, e o modelo que respondeu só é
 * conhecido se o servidor disse. A distinção é explícita para que o relatório
 * não afirme uma decisão que a Evelyn não tomou.
 */
export interface ReportRouting {
	readonly mode: RouterMode;
	/** O provedor chamado. */
	readonly providerId: string;
	/** O modelo pedido. */
	readonly requestedModel: string;
	/**
	 * O modelo que respondeu, quando o servidor publicou.
	 *
	 * Ausente = o servidor não disse. Nunca significa "o modelo pedido
	 * respondeu".
	 */
	readonly respondedModel?: string;
	/** Quem escolheu o modelo que respondeu. */
	readonly decidedBy: 'seshyina' | 'external-router' | 'provider';
}

/** O modelo escolhido, com o que o motivou. */
export interface ReportChosen {
	readonly providerId: string;
	readonly modelId: string;
	/** Por que foi escolhido, em palavras. */
	readonly reason: string;
	/** A classificação de acesso que o catálogo (ou a descoberta) dá. */
	readonly access: ModelAccess;
	readonly price?: ReportPrice;
	readonly limits?: ReportLimits;
	/** As capacidades que o seletor usou para pontuar. */
	readonly capabilities?: {
		readonly toolCalling?: boolean;
		readonly structuredOutput?: boolean;
		readonly reasoning?: boolean;
	};
	/** A procedência dos metadados que entraram na escolha. */
	readonly metadataSources?: Readonly<Record<string, string>>;
}

/** Um modelo que foi considerado e não escolhido. */
export interface ReportAlternative {
	readonly providerId: string;
	readonly modelId: string;
	/** Por que foi descartado, em palavras. */
	readonly reason: string;
	/** Ele era candidato, mas outro venceu. */
	readonly discarded: boolean;
}

/**
 * Um termo da pontuação de um candidato.
 *
 * A soma dos termos é o score, e os termos são os que o algoritmo realmente
 * usou. Um critério que não participou não aparece.
 */
export interface ReportScoreComponent {
	readonly id: string;
	readonly label: string;
	readonly points: number;
	readonly detail: string;
}

/**
 * Uma restrição que eliminou um candidato, separada da pontuação.
 *
 * Um modelo pago sem autorização não é "um modelo com score muito negativo":
 * ele foi excluído, e a diferença importa.
 */
export interface ReportSelectionConstraint {
	readonly id: 'paid_not_allowed' | 'negative_score' | 'policy_excluded';
	readonly label: string;
	readonly detail: string;
}

/**
 * O que faltou ou venceu, e o que isso custou à decisão.
 *
 * O score não fica errado quando um limite é desconhecido — ele fica menos
 * informado. É aqui que a diferença fica registrada.
 */
export interface ReportConfidence {
	readonly id:
		| 'no_catalog_entry'
		| 'capabilities_unknown'
		| 'context_unknown'
		| 'no_observations'
		| 'metadata_stale';
	readonly label: string;
	readonly detail: string;
}

/** A avaliação de um candidato: score, termos, restrições e confiança. */
export interface ReportCandidateEvaluation {
	readonly providerId: string;
	readonly modelId: string;
	/** A pontuação final. Ausente = o candidato nunca foi pontuado. */
	readonly score?: number;
	/** Os termos que produziram a pontuação. */
	readonly components: readonly ReportScoreComponent[];
	/** O que o eliminou, se algo o eliminou. */
	readonly constraints: readonly ReportSelectionConstraint[];
	/** O que faltou ou venceu. */
	readonly confidence: readonly ReportConfidence[];
	/** O motivo, em palavras, como o seletor o escreveu. */
	readonly reason: string;
	/** Ele foi escolhido? */
	readonly chosen: boolean;
}

/** A restrição de orçamento que o candidato encontrou. */
export interface ReportBudgetConstraint {	readonly limitId: string;
	readonly scope: 'global' | 'provider' | 'policy' | 'model';
	/** A política a que o limite se restringe, quando se restringe. */
	readonly policy?: ModelAccessPolicy;
	readonly currency: string;
	readonly amount: number;
	readonly window: 'day' | 'month';
	readonly spent?: number;
	/** O limite bloqueou a chamada. */
	readonly blocked: boolean;
}

/** A restrição de cota que o candidato encontrou. */
export interface ReportQuotaConstraint {
	readonly providerId: string;
	readonly modelId?: string;
	/** O que a cota limitava, quando a fonte disse. */
	readonly kind?: 'requests' | 'tokens';
	/** De quem é a cota, quando a fonte disse. */
	readonly scope?: 'api-key' | 'provider' | 'model' | 'account';
	readonly remaining?: number;
	readonly limit?: number;
	readonly resetAt?: string;
	/** A janela tinha terminado e o modelo foi pulado. */
	readonly exhausted: boolean;
	/** A origem do número, sempre presente. */
	readonly source: string;
}

/** Uma tentativa, do ponto de vista do relatório. */
export interface ReportAttempt {
	readonly sequence: number;
	readonly providerId: string;
	readonly modelId: string;
	readonly outcome: 'success' | 'failure' | 'skipped' | 'cancelled';
	readonly errorClass?: string;
	readonly httpStatus?: number;
	readonly retryAfterMs?: number;
	/** A tentativa foi um fallback de uma anterior que falhou. */
	readonly fallback: boolean;
	/** A tentativa repetiu a mesma. */
	readonly retry: boolean;
	/**
	 * A latência medida, quando o motor a mediu.
	 *
	 * Vem do mesmo lugar de sempre — o motor de rota — e não é recalculada
	 * aqui. Ausente é "não medido", nunca zero.
	 */
	readonly ttfbMs?: number;
	readonly firstVisibleEventMs?: number;
	readonly headersMs?: number;
	readonly totalMs?: number;
	/** Os tokens que o provedor publicou, quando publicou. */
	readonly usage?: {
		readonly promptTokens?: number;
		readonly completionTokens?: number;
		readonly totalTokens?: number;
	};
	/**
	 * O custo da tentativa, quando o ledger o mediu.
	 *
	 * `estimated` é o preço do catálogo aplicado aos tokens medidos: é uma
	 * estimativa, e a tela diz que é. `unknown` é "não deu para saber". O
	 * estado vem do ledger, e o relatório não o recalcula.
	 */
	readonly cost?: {
		readonly status: 'estimated' | 'unknown';
		readonly currency?: string;
		readonly total?: number;
		readonly reasons: readonly string[];
	};
}

/** O relatório de uma execução. */
export interface RoutingDecisionReport {
	readonly turnId: string;
	/**
	 * O identificador da execução.
	 *
	 * É o id da entrada do log, e é atribuído quando a entrada é gravada — o
	 * log é quem possui a identidade da execução. Comparar duas execuções é
	 * compará-las por este id.
	 */
	readonly executionId?: string;
	readonly conversationId: string;
	readonly startedAt: string;
	readonly strategy: string;
	/**
	 * A classificação da tarefa e as regras que a produziram.
	 *
	 * A explicação vem das tabelas fixas do classificador: o domínio, as
	 * palavras-chave que dispararam, a evidência da complexidade, o motivo de
	 * cada capacidade exigida e a base da confiança. **Não** vem a mensagem —
	 * o texto do usuário não entra nem aqui nem no histórico.
	 */
	readonly task?: TaskClassificationExplanation;
	/** A política de acesso que valia. */
	readonly policy: ModelAccessPolicy;
	/** A política restringiu os candidatos? */
	readonly policyApplied: boolean;
	/** De que lado o preço, os limites e as capacidades valiam. */
	readonly sources: {
		readonly price: 'user' | 'discovered';
		readonly limits: 'user' | 'discovered';
		readonly capabilities: 'user' | 'discovered';
	};
	readonly chosen?: ReportChosen;
	/**
	 * Quem decidiu o modelo, e o que é conhecido sobre isso.
	 *
	 * No modo `native` a Evelyn escolheu. Nos modos de alvo único, quem
	 * escolheu foi o outro lado — e o modelo que respondeu só é conhecido se
	 * o servidor disse.
	 */
	readonly routing?: ReportRouting;
	readonly alternatives: readonly ReportAlternative[];
	/**
	 * A avaliação de cada candidato: score, termos, restrições e confiança.
	 *
	 * É o que permite ler *por que* um modelo venceu, e não apenas que ele
	 * venceu. Um candidato que nunca foi pontuado aparece com o score
	 * ausente — nunca com zero.
	 */
	readonly evaluations: readonly ReportCandidateEvaluation[];
	readonly budget: readonly ReportBudgetConstraint[];
	readonly quotas: readonly ReportQuotaConstraint[];
	readonly attempts: readonly ReportAttempt[];
	/**
	 * O custo de cada tentativa, como o ledger o mediu.
	 *
	 * Indexado pelo par `providerId:modelId`: é o ledger que sabe o custo, e o
	 * relatório apenas o carrega. Um custo `estimated` é uma estimativa — o
	 * preço do catálogo aplicado aos tokens medidos — e um `unknown` é "não
	 * deu para saber". O relatório não recalcula nenhum dos dois.
	 */
	readonly costs?: ReadonlyMap<
		string,
		{
			readonly status: 'estimated' | 'unknown';
			readonly currency?: string;
			readonly total?: number;
			readonly reasons: readonly string[];
		}
	>;
	readonly result: 'success' | 'failed' | 'cancelled' | 'exhausted' | 'refused';
	/** O modelo que respondeu, quando algum respondeu. */
	readonly finalModel?: { readonly providerId: string; readonly modelId: string };
	/** A frase que explica o desfecho, em palavras. */
	readonly summary: string;
	/**
	 * Os candidatos que a política removeu, antes da pontuação.
	 *
	 * Eles não têm score - nunca foram pontuados - e a razão é a política,
	 * não o algoritmo. A distinção importa: "o modelo teve um score baixo" e
	 * "o modelo nunca chegou a ser avaliado" são coisas diferentes, e só a
	 * segunda é uma exclusão estrutural.
	 */
	readonly policyExcluded: readonly ReportAlternative[];
}

/**
 * O relatório como a janela o lê.
 *
 * A forma é a mesma, com uma diferença: os campos de texto são limitedos ao
 * que a tela precisa mostrar. A checagem de sigilo é feita na montagem
 * (`assertNoSecrets`), não aqui — a ponte só repassa o que o Core já
 * builders.
 */
export type RoutingDecisionReportView = RoutingDecisionReport;

/**
 * A checagem de sigilo do relatório.
 *
 * Ela existe porque a forgets de um relatório é um relatório com a chave da
 * API dentro, e ninguém nota olhando a tela. Um teste que serialize o
 * relatório e procure por padrões de segredo é o que pega isso.
 */
export function assertNoSecrets(report: RoutingDecisionReport): void {
	const raw = JSON.stringify(report);
	const forbidden: readonly { readonly pattern: RegExp; readonly what: string }[] = [
		{ pattern: /sk-[A-Za-z0-9_-]{8,}/, what: 'a key in the report' },
		{ pattern: /bearer\s+\S/i, what: 'an authorization header in the report' },
		{ pattern: /"authorization"\s*:/i, what: 'an authorization header in the report' },
		{ pattern: /"api[_-]?key"\s*:/i, what: 'an api key field in the report' },
		{ pattern: /"set-cookie"\s*:/i, what: 'a cookie header in the report' },
	];
	for (const { pattern, what } of forbidden) {
		if (pattern.test(raw)) {
			throw new Error(`The decision report carries ${what}`);
		}
	}
}
