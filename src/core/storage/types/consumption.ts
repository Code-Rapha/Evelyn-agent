/**
 * Consumo persistente: o que uma execução gastou, de onde veio cada número e
 * quanto custou segundo o catálogo.
 *
 * ## Por que um registro próprio
 *
 * O catálogo (`ModelCatalogEntry`) guarda uma janela curta de medições por
 * `(provedor, modelo)`, boa para latência e para escolher modelo. Ela não serve
 * para contabilização: não tem identidade de execução, não guarda tentativas
 * fracassadas, não guarda preço aplicado e some quando a janela gira. Somar tudo
 * a partir dela seria reconstruir, a cada leitura, o que já foi sabido no momento
 * da varredura - e reconstruir com o preço de hoje um consumo de ontem.
 *
 * Por isso este módulo define um registro **append-only**, separado do catálogo
 * e gravado no mesmo armazenamento local, sem um segundo banco.
 *
 * ## Vocabulário
 *
 * - **Execução lógica** (`ExecutionRecord`) — uma rodada do roteador ou um turno
 *   local. É a unidade que se soma para "quanto este turno custou". Um turno
 *   roteado que teve duas tentativas é **uma** execução com duas tentativas.
 * - **Tentativa** (`AttemptRecord`) — uma chamada a um modelo. Retries e
 *   fallbacks são tentativas distintas dentro da mesma execução. O consumo de
 *   uma tentativa pertence a ela e **nunca** se soma duas vezes na execução: a
 *   execução guarda o vínculo (`attemptIds`), e o total é derivado lendo as
 *   tentativas, não duplicado.
 *
 * ## Real e estimado são campos separados, não uma taxa de confiança
 *
 * `reported` é o que o provedor disse. `estimated` é o que foi calculado aqui.
 * Não há um terceiro estado "mais ou menos real": um número ou foi publicado
 * pelo servidor, ou foi deduzido, ou não existe. A qualquer corpo do registro
 * isso se aplica:
 *
 * - tokens: `reportedTokens` (do provedor) ou `estimatedTokens` (nosso), nunca
 *   os dois no mesmo campo;
 * - custo: `cost.status === 'estimated'` com `basis` dizendo sobre o que foi
 *   calculado, ou `cost.status === 'unknown'` com o motivo.
 *
 * ## "Desconhecido" não é zero
 *
 * Um preço ausente, um token não informado, uma tarifa de cache não publicada
 * nunca viram `0`. O custo fica `unknown` com `reasons` preenchido, e a parte
 * que *era* conhecida continua exposta (`inputAmount`), porque omitir o que se
 * sabe só porque não se sabe tudo tornaria o registro inútil para diagnosticar.
 *
 * ## O que nunca entra aqui
 *
 * Prompts, respostas, trechos de conversa, chaves de API e qualquer conteúdo
 * privado. O registro carrega ids, nomes de modelo, números e carimbos de tempo.
 * Um proveniente carrega `requestId`/`turnId`, não o texto que os acompanha.
 * `assertNoSecretFields` recusa um campo de nome suspeito na escrita, e um teste
 * percorre o arquivo em disco para provar que nada de conteúdo vazou.
 */

import type { CostUnit } from './modelCatalog';

/**
 * Unidade de preço, a mesma do catálogo da Etapa 4C.
 *
 * A unidade é uma só no produto: um registro de consumo não pode discordar do
 * catálogo sobre o que `per_1k_tokens` significa.
 */

/** Como a execução ou a tentativa terminou. */
export type ExecutionStatus = 'success' | 'failure' | 'cancelled' | 'timeout';

/**
 * Números de token, com a origem explícita.
 *
 * `input` é o total de tokens de entrada **incluindo** os servidos em cache
 * quando o provedor informa os dois, porque é assim que as APIs cobram o total
 * e separam o desconto por entrada cacheada. `cachedInput` é sempre um
 * subconjunto de `input`, nunca uma parcela a mais.
 */
export interface TokenCounts {
	readonly input?: number;
	readonly output?: number;
	/**
	 * Tokens de entrada servidos do cache do provedor.
	 *
	 * Só existe quando o provedor publicou esse número separadamente. Quando não
	 * publicou, o campo fica ausente: pressupor "sem cache" ou "todo o input em
	 * cache" mudaria o custo, e um dos dois estaria errado.
	 */
	readonly cachedInput?: number;
}

/** De onde vieram os tokens de uma tentativa. */
export type TokenSource = 'provider' | 'estimate';

/** Custo de uma parte da tentativa, ou a explicação de por que não há. */
export interface CostPart {
	/** A moeda do catálogo no momento do cálculo. */
	readonly currency: string;
	/** A unidade do catálogo no momento do cálculo. */
	readonly unit: CostUnit;
	/** Valor exato antes do arredondamento, na unidade acima. */
	readonly amount: number;
	/** Preço publicado que originou o valor, por token. */
	readonly rate?: number;
}

/**
 * O custo de uma tentativa, com a base do cálculo.
 *
 * `status`:
 *
 * - `estimated` — todos os componentes do custo foram calculados e o total é a
 *   soma exata deles. Continua sendo uma **estimativa**: é o preço do catálogo
 *   aplicado ao que o provedor reportou, não a fatura.
 * - `unknown` — falta algo (preço, token, tarifa de cache), e `reasons` diz o
 *   quê. As partes que existem continuam em `parts`.
 */
export type AttemptCost =
	| {
			readonly status: 'estimated';
			readonly currency: string;
			readonly unit: CostUnit;
			readonly parts: readonly CostPart[];
			/** Soma das partes, na unidade do catálogo. */
			readonly total: number;
	  }
	| {
			readonly status: 'unknown';
			readonly currency?: string;
			readonly unit?: CostUnit;
			readonly parts: readonly CostPart[];
			/**
			 * Soma das partes conhecidas, quando há alguma. **Não** é o custo: é
			 * parcial por definição, e `status` diz isso. Ausente quando nenhuma
			 * tentativa tinha preço a aplicar.
			 */
			readonly total?: number;
			readonly reasons: readonly string[];
	  };

/**
 * Uma tentativa registrada: uma chamada a um modelo.
 *
 * `attemptId` é único dentro da execução e derivado dela
 * (`${executionId}#${sequence}`), para que reprocessar o mesmo evento produza o
 * mesmo id e a escrita vire uma atualização idempotente em vez de uma duplicata.
 */
export interface AttemptRecord {
	readonly attemptId: string;
	/** A execução lógica à qual pertence. */
	readonly executionId: string;
	readonly providerId: string;
	/** O id exato do modelo, como o provedor o publica. */
	readonly modelId: string;
	/** 1-based, na ordem em que as tentativas correram. */
	readonly sequence: number;
	/** Verdadeiro quando é mais uma tentativa do mesmo modelo. */
	readonly retry: boolean;
	/** Verdadeiro quando a tentativa existe porque a anterior falhou. */
	readonly fallback: boolean;
	readonly status: ExecutionStatus;
	/** ISO-8601, quando a tentativa começou. */
	readonly startedAt: string;
	/** ISO-8601, quando foi gravada. */
	readonly recordedAt: string;
	/** Tokens que o provedor publicou. Ausente quando não publicou. */
	readonly reportedTokens?: TokenCounts;
	/** Tokens deduzidos localmente. Ausente quando nada foi deduzido. */
	readonly estimatedTokens?: TokenCounts;
	/** Qual bloco usar para custo. Ausente quando não há token nenhum. */
	readonly tokenSource?: TokenSource;
	/** Preço aplicado, com as tarifas que o cálculo de fato usou. */
	readonly pricing?: {
		readonly currency: string;
		readonly unit: CostUnit;
		readonly input?: number;
		readonly output?: number;
		readonly cachedInput?: number;
	};
	/** O custo, ou a explicação de por que não há. Sempre presente. */
	readonly cost: AttemptCost;
	/** Classe do erro, quando a tentativa não deu certo. */
	readonly errorClass?: string;
	/** O motivo do aborto, quando um timer a cortou. */
	readonly abortCause?: string;
	/** Status HTTP, quando existiu. */
	readonly httpStatus?: number;
}

/**
 * O que uma execução produziu, agregado.
 *
 * Os totais são **derivados** das tentativas ao ler. Ficam gravados para que
 * uma consulta não precise varrer as tentativas, mas não são a fonte da
 * verdade: `attemptIds` aponta para elas, e cada id aparece uma vez.
 */
export interface ExecutionTotals {
	readonly attempts: number;
	readonly tokens?: TokenCounts;
	readonly tokenSource?: TokenSource;
	readonly cost: AttemptCost;
}

/**
 * Uma execução lógica e as tentativas que ela produziu.
 *
 * `status` é o da execução inteira. Uma execução com uma tentativa
 * `timeout` seguida de uma `success` é `success`: o que importa é como a rodada
 * terminou, e as tentativas contam o caminho.
 */
export interface ExecutionRecord {
	readonly executionId: string;
	/** Rótulo da origem: `routing` para uma rota, `turn` para um turno local. */
	readonly kind: 'routing' | 'turn';
	/** Id do turno que a originou, quando houver. */
	readonly turnId?: string;
	/** Id da rota, quando houver. Distinto do turno: um turno pode rotear várias vezes. */
	readonly routeId?: string;
	/**
	 * A conversa que originou o turno, quando o host a conhece.
	 *
	 * O ledger guarda a execução, que pertence a uma rota e não a um chat. Sem
	 * este campo, "quanto esta conversa gastou" só poderia ser respondido
	 * mantendo um segundo total à parte — que é o que a 5B evitou. Opcional
	 * porque um host sem conversas (o roteador sozinho) não tem como saber.
	 */
	readonly conversationId?: string;
	/** Provedor e modelo que **responderam**, quando um respondeu. */
	readonly providerId?: string;
	readonly modelId?: string;
	readonly status: ExecutionStatus;
	readonly startedAt: string;
	readonly finishedAt: string;
	readonly attemptIds: readonly string[];
	readonly totals: ExecutionTotals;
}

/** O que o chamador entrega para registrar uma execução. */
export interface RecordExecutionInput {
	readonly executionId: string;
	readonly kind: 'routing' | 'turn';
	readonly turnId?: string;
	readonly routeId?: string;
	readonly conversationId?: string;
	readonly providerId?: string;
	readonly modelId?: string;
	readonly status: ExecutionStatus;
	readonly startedAt: string;
	readonly finishedAt: string;
}

/** O que o chamador entrega para registrar uma tentativa. */
export interface RecordAttemptInput {
	readonly executionId: string;
	readonly sequence: number;
	readonly providerId: string;
	readonly modelId: string;
	readonly retry: boolean;
	readonly fallback: boolean;
	readonly status: ExecutionStatus;
	readonly startedAt: string;
	readonly reportedTokens?: TokenCounts;
	readonly estimatedTokens?: TokenCounts;
	readonly errorClass?: string;
	readonly abortCause?: string;
	readonly httpStatus?: number;
	/**
	 * O preço lido do catálogo **no momento da tentativa**.
	 *
	 * Passado pelo chamador em vez de lido pelo armazenamento por dois motivos:
	 * o preço tem de ser o de quando a chamada aconteceu, não o de quando a
	 * escrita chega; e o armazenamento continua sem depender do formato do
	 * catálogo para calcular. O cálculo em si é puro e vive em
	 * `computeAttemptCost`, para que a regra seja testável sem disco.
	 */
	readonly pricing?: {
		readonly currency: string;
		readonly unit: CostUnit;
		readonly input?: number;
		readonly output?: number;
		readonly cachedInput?: number;
	};
}

/** Filtros da consulta. Todos opcionais; ausente = todos. */
export interface ConsumptionQuery {
	readonly executionId?: string;
	readonly turnId?: string;
	readonly conversationId?: string;
	readonly providerId?: string;
	readonly modelId?: string;
	/** Inclusive, ISO-8601. Comparação lexicográfica é válida para ISO-8601 em UTC. */
	readonly since?: string;
	/** Exclusive, ISO-8601. */
	readonly until?: string;
	/** Teto de resultados, do mais recente para o mais antigo. Ausente = todos. */
	readonly limit?: number;
}

/** Uma execução com as tentativas carregadas e os totais recalculados. */
export interface ExecutionLedgerEntry {
	readonly execution: ExecutionRecord;
	readonly attempts: readonly AttemptRecord[];
	/** Recalculado a partir das tentativas; igual ao gravado quando ele está íntegro. */
	readonly totals: ExecutionTotals;
}

/**
 * A porta de contabilização.
 *
 * Pequena de propósito: registrar execução, registrar tentativa, consultar.
 * Sem orçamento, sem limite, sem bloqueio — esses decidem *sobre* estes dados e
 * pertencem a outra etapa.
 *
 * Idempotência é parte do contrato, não do chamador: registrar duas vezes a
 * mesma `executionId` ou o mesmo `attemptId` não duplica nada. A segunda escrita
 * substitui a anterior, o que torna seguro reprocessar um evento depois de uma
 * queda sem saber se a primeira escrita chegou.
 */
export interface ConsumptionLedgerPort {
	/** Registra ou atualiza uma execução. Devolve o que ficou gravado. */
	recordExecution(input: RecordExecutionInput): Promise<ExecutionRecord>;
	/**
	 * Registra ou atualiza uma tentativa.
	 *
	 * A execução correspondente precisa existir antes: uma tentativa órfã não
	 * teria a que ser somada, e criar a execução aqui inventaria um começo e um
	 * fim que ninguém mediu.
	 */
	recordAttempt(input: RecordAttemptInput): Promise<AttemptRecord>;
	/** Consulta execuções, da mais recente para a mais antiga. */
	listConsumption(query?: ConsumptionQuery): Promise<readonly ExecutionRecord[]>;
	/** Uma execução com as tentativas e os totais recalculados. */
	getExecution(executionId: string): Promise<ExecutionLedgerEntry | undefined>;
	/** Todas as tentativas de uma execução, em ordem de `sequence`. */
	listAttempts(executionId: string): Promise<readonly AttemptRecord[]>;
}

/** O id de uma tentativa, derivado da execução e da ordem. */
export function attemptIdFor(executionId: string, sequence: number): string {
	return `${executionId}#${sequence}`;
}

/** Multiplicador do preço até a unidade de contagem usada no cálculo. */
const UNITS_PER_TOKEN: Readonly<Record<CostUnit, number>> = {
	per_1k_tokens: 1_000,
	per_1m_tokens: 1_000_000,
};

/** Soma de dois valores que podem não existir. Ausente só quando os dois são. */
export function addTokens(a: TokenCounts | undefined, b: TokenCounts | undefined): TokenCounts | undefined {
	if (a === undefined) {
		return b;
	}
	if (b === undefined) {
		return a;
	}
	const sum = (x: number | undefined, y: number | undefined): number | undefined =>
		x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0);
	const input = sum(a.input, b.input);
	const output = sum(a.output, b.output);
	// Tokens em cache só são somados quando **os dois** lados os informaram:
	// somar um lado que não os publicou como zero subestimaria o cache e
	// reintroduziria o "desconhecido vira número" que este módulo evita.
	const cachedInput =
		a.cachedInput !== undefined && b.cachedInput !== undefined ? a.cachedInput + b.cachedInput : undefined;
	return {
		...(input !== undefined ? { input } : {}),
		...(output !== undefined ? { output } : {}),
		...(cachedInput !== undefined ? { cachedInput } : {}),
	};
}

/**
 * Soma exata de dois números decimais pequenos.
 *
 * `0.1 + 0.2` em ponto flutuante dá `0.30000000000000004`, e uma soma de
 * centenas de custos em USD acumula esse desvio até o total não fechar com a
 * fatura. A soma é feita em escala inteira na precisão decimal do produto
 * (`tokens × preço`), que é o ponto onde o erro nasce, e o resultado é
 * arredondado uma única vez ao final de cada soma.
 *
 * Escala de 12 casas é folgada: um preço por milhão tem no máximo 6 casas
 * decimais úteis em qualquer provedor real, e um token multiplicado por ele
 * fica com 6. O arredondamento aqui é o mesmo que `(a + b)` daria se a memória
 * fosse decimal.
 */
const SCALE = 1e12;

function addExact(a: number, b: number): number {
	return (Math.round(a * SCALE) + Math.round(b * SCALE)) / SCALE;
}

/**
 * Calcula o custo de uma tentativa.
 *
 * ## A conta
 *
 * Com `tokens` na unidade do catálogo:
 *
 * - entrada normal: `(input - cachedInput) × preço de entrada`
 * - entrada em cache: `cachedInput × preço de cache`
 * - saída: `output × preço de saída`
 *
 * A subtração do cache é o ponto crítico: o total de entrada já **inclui** os
 * tokens servidos do cache (é assim que as APIs informam), então cobrar todos
 * pelo preço cheio contaria o cache duas vezes. Quando o provedor publica
 * `cachedInput` mas não publica preço de cache, o custo fica `unknown` — cobrar
 * esses tokens pelo preço cheio inflaria a conta, e inventar um desconto a
 * reduziria sem base.
 *
 * ## Quando o custo fica desconhecido
 *
 * - sem preço no catálogo (ou sem a tarifa da parte que consumiu tokens);
 * - sem o token desse lado;
 * - tarifa de cache ausente quando há tokens em cache;
 * - `cachedInput > input`, que não faz sentido e é tratado como dado inválido.
 *
 * Em todos os casos a parte conhecida é devolvida em `parts`, porque saber "a
 * saída custou X" continua útil numa execução cuja entrada é desconhecida.
 */
export function computeAttemptCost(
	tokens: TokenCounts | undefined,
	pricing: RecordAttemptInput['pricing'] | undefined,
): AttemptCost {
	const parts: CostPart[] = [];
	const reasons: string[] = [];
	if (pricing === undefined) {
		return { status: 'unknown', parts, reasons: ['no price was recorded for this model'] };
	}
	const { currency, unit } = pricing;
	const divisor = UNITS_PER_TOKEN[unit];

	const addPart = (amount: number, rate: number): void => {
		parts.push({ currency, unit, amount, rate: rate / divisor });
	};
	const input = tokens?.input;
	const output = tokens?.output;
	const cached = tokens?.cachedInput;

	if (cached !== undefined && input !== undefined && cached > input) {
		// Um cache maior que a entrada é um dado inconsistente, não um custo.
		reasons.push('cached input exceeds total input');
	}

	let normalInput: number | undefined;
	let cachedAmount: number | undefined;

	if (input !== undefined) {
		if (cached === undefined) {
			// Sem cache publicado: todos os tokens de entrada pelo preço cheio.
			if (pricing.input !== undefined) {
				normalInput = input * (pricing.input / divisor);
				addPart(normalInput, pricing.input);
			} else {
				reasons.push('input price is unknown');
			}
		} else {
			// O provedor publicou o cache separadamente, então o total de
			// entrada **inclui** esses tokens. Cobrar todos pelo preço cheio os
			// contaria duas vezes; ratear é a única leitura correta.
			const normal = input - cached;
			if (normal > 0) {
				if (pricing.input !== undefined) {
					normalInput = normal * (pricing.input / divisor);
					addPart(normalInput, pricing.input);
				} else {
					reasons.push('input price is unknown');
				}
			}
			if (cached > 0) {
				if (pricing.cachedInput !== undefined) {
					cachedAmount = cached * (pricing.cachedInput / divisor);
					addPart(cachedAmount, pricing.cachedInput);
				} else {
					reasons.push('cached input price is unknown');
				}
			}
		}
	}

	if (output !== undefined) {
		if (pricing.output !== undefined) {
			addPart(output * (pricing.output / divisor), pricing.output);
		} else {
			reasons.push('output price is unknown');
		}
	}

	if (input === undefined && output === undefined) {
		reasons.push('no token counts were reported');
	}

	if (reasons.length > 0) {
		return {
			status: 'unknown',
			...(parts.length > 0 ? { currency, unit } : {}),
			parts,
			reasons,
		};
	}

	const total = parts.reduce((sum, part) => addExact(sum, part.amount), 0);
	return { status: 'estimated', currency, unit, parts, total };
}

/**
 * Soma de custos de tentativas numa execução.
 *
 * Uma execução é `estimated` só quando **todas** as suas tentativas com consumo
 * têm custo conhecido; qualquer desconhecida torna o total desconhecido, com a
 * lista do que faltou. Somar só as conhecidas apresentaria um subtotal como se
 * fosse o total.
 *
 * Moedas diferentes não são somadas: misturar `USD` e `BRL` exige uma cotação
 * que ninguém declarou, e um total convertido por conta própria é um número
 * inventado com cara de fato.
 */
export function combineCosts(costs: readonly AttemptCost[]): AttemptCost {
	const withParts = costs.filter((cost) => cost.parts.length > 0);
	if (withParts.length === 0) {
		// Uma tentativa que gastou tokens mas cujo preço é desconhecido não tem
		// partes — e ainda assim explica o total. A razão dela é preservada
		// em vez de ser trocada por "ninguém reportou tokens", que seria falso.
		const reasons = [...new Set(costs.flatMap((cost) => (cost.status === 'unknown' ? cost.reasons : [])))];
		return {
			status: 'unknown',
			parts: [],
			reasons:
				reasons.length > 0
					? reasons
					: costs.length === 0
						? ['no attempts were recorded']
						: ['no attempt reported token usage'],
		};
	}
	const currencies = new Set(
		withParts.map((cost) => cost.parts[0]?.currency ?? ''),
	);
	const units = new Set(withParts.map((cost) => cost.parts[0]?.unit ?? 'per_1k_tokens'));
	const parts: { currency: string; unit: CostUnit; amount: number }[] = [];
	for (const cost of withParts) {
		for (const part of cost.parts) {
			const existing = parts.find((p) => p.currency === part.currency && p.unit === part.unit);
			if (existing === undefined) {
				parts.push({ ...part });
			} else {
				// `parts` is mutable only during this local sum; the object
				// returned is the only one that escapes.
				existing.amount = addExact(existing.amount, part.amount);
			}
		}
	}
	// A known cost is the only kind that can be summed. An unknown one leaves
	// its parts for diagnosis but makes the total unknown: a subtotal shown as
	// if it were the total is exactly what this module refuses to do.
	const known = withParts.every((cost) => cost.status === 'estimated');
	const unknownReasons = costs
		.filter((cost) => cost.status === 'unknown')
		.flatMap((cost) => (cost.status === 'unknown' ? cost.reasons : []));
	const reasons: string[] = [...new Set(unknownReasons)];
	// Uma tentativa que não gastou nada não tem custo a somar; ela não é uma
	// razão para o total ser desconhecido, nem é creditada aqui.
	const priced = withParts.filter((cost) => cost.status === 'estimated');
	const unpriced = costs.filter((cost) => cost.status === 'unknown');
	const spent = unpriced.some((cost) => cost.reasons.length === 0);
	if (currencies.size > 1) {
		reasons.push('attempts were priced in more than one currency');
	}
	if (units.size > 1) {
		reasons.push('attempts were priced in more than one unit');
	}
	const first = priced[0];
	if (reasons.length > 0 || spent || first === undefined) {
		if (first !== undefined) {
			const total = priced
				.flatMap((cost) => cost.parts)
				.reduce((sum, part) => addExact(sum, part.amount), 0);
			return { status: 'unknown', currency: first.parts[0]?.currency ?? '', unit: first.parts[0]?.unit ?? 'per_1k_tokens', parts, total, reasons };
		}
		return { status: 'unknown', parts, reasons };
	}
	return {
		status: 'estimated',
		currency: first.parts[0]?.currency ?? '',
		unit: first.parts[0]?.unit ?? 'per_1k_tokens',
		parts,
		total: parts.reduce((sum, part) => addExact(sum, part.amount), 0),
	};
}

/**
 * Resolve, para uma tentativa, o que ela usa como token e como preço.
 *
 * Uma função só, chamada pela escrita do armazenamento e disponível ao
 * chamador, para que a tentativa gravada seja **exatamente** a que foi
 * calculada. Duas implementações da mesma regra divergem no dia em que uma
 * delas ganha um caso novo, e o registro então descreveria um custo que ele
 * mesmo não teria produzido.
 *
 * Regras, todas derivadas de "real e estimado não se misturam":
 *
 * - `reportedTokens` só é aceito quando o provedor publicou **entrada e
 *   saída**. Meia leitura não é uma leitura: cobrar a saída informada e a
 *   entrada deduzida é uma estimativa, não um fato.
 * - `estimatedTokens` é usado apenas quando não há leitura completa publicada.
 *   Quando há, a dedução não substitui nem completa a leitura.
 * - `tokenSource` e `cost` são derivados, nunca aceitos prontos do chamador.
 *
 * A diferença entre os dois preços é que `reportedTokens` já **inclui** o cache
 * no total de entrada, como as APIs informam.
 */
export function resolveAttemptAccounting(input: {
	readonly reportedTokens?: TokenCounts;
	readonly estimatedTokens?: TokenCounts;
	readonly pricing?: RecordAttemptInput['pricing'];
}): {
	readonly reportedTokens?: TokenCounts;
	readonly estimatedTokens?: TokenCounts;
	readonly tokenSource?: TokenSource;
	readonly pricing?: RecordAttemptInput['pricing'];
	readonly cost: AttemptCost;
} {
	const reported = isComplete(input.reportedTokens) ? input.reportedTokens : undefined;
	const estimated = reported === undefined ? input.estimatedTokens : undefined;
	const tokenSource: TokenSource | undefined =
		reported !== undefined ? 'provider' : estimated !== undefined ? 'estimate' : undefined;
	const tokens = reported ?? estimated;
	return {
		...(reported !== undefined ? { reportedTokens: reported } : {}),
		...(estimated !== undefined ? { estimatedTokens: estimated } : {}),
		...(tokenSource !== undefined ? { tokenSource } : {}),
		...(input.pricing !== undefined
			? {
					pricing: {
						currency: input.pricing.currency,
						unit: input.pricing.unit,
						...(input.pricing.input !== undefined ? { input: input.pricing.input } : {}),
						...(input.pricing.output !== undefined ? { output: input.pricing.output } : {}),
						...(input.pricing.cachedInput !== undefined ? { cachedInput: input.pricing.cachedInput } : {}),
					},
				}
			: {}),
		cost: computeAttemptCost(tokens, input.pricing),
	};
}

/** Se uma leitura traz as duas metades que o custo precisa. */
function isComplete(tokens: TokenCounts | undefined): tokens is TokenCounts {
	return tokens !== undefined && tokens.input !== undefined && tokens.output !== undefined;
}

/** Totais de uma execução, recalculados a partir das tentativas. */
export function summarizeExecution(attempts: readonly AttemptRecord[]): ExecutionTotals {
	const ordered = [...attempts].sort((a, b) => a.sequence - b.sequence);
	let tokens: TokenCounts | undefined;
	let source: TokenSource | undefined;
	for (const attempt of ordered) {
		// Só os números contam para o total, cada tentativa uma vez. O campo
		// `tokenSource` diz como lê-los, e fica `estimate` quando alguma
		// tentativa contada foi deduzida aqui: o total então não é integralmente
		// o que o provedor publicou, e dizer `provider` seria falso.
		const counts = attempt.reportedTokens ?? attempt.estimatedTokens;
		tokens = addTokens(tokens, counts);
		if (counts !== undefined) {
			const attemptSource = attempt.tokenSource ?? 'estimate';
			source = source === undefined || source === attemptSource ? attemptSource : 'estimate';
		}
	}
	return {
		attempts: ordered.length,
		...(tokens !== undefined ? { tokens } : {}),
		...(source !== undefined ? { tokenSource: source } : {}),
		cost: combineCosts(ordered.map((attempt) => attempt.cost)),
	};
}
