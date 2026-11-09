/**
 * Previsão de custo de uma chamada, antes de ela acontecer.
 *
 * ## O que uma previsão é, e o que não é
 *
 * É o preço do catálogo aplicado a uma **estimativa** de tokens: entrada que
 * esta conversa já vem enviando, saída que este modelo costuma publicar. Não é
 * a fatura, não é o que será registrado depois, e não confirma nada. O
 * `source` de cada metade diz de onde ela veio, e o resultado carrega
 * `confidence` para que ninguém o apresente como medição.
 *
 * ## Desconhecido nunca é zero
 *
 * Toda previsão é `unknown` quando falta um dos dois preços, quando a entrada
 * é desconhecida (a conversa tem menos de uma resposta do modelo), quando não
 * há nenhuma leitura de saída para aquele modelo, ou quando a conversa não
 * contém texto do usuário ou do sistema para medir. Um "0,00" ali seria lido
 * como "vai sair de graça" e é exatamente o erro que a 5A proibiu.
 *
 * ## Tokens: uma aproximação declarada, não um tokenizer
 *
 * A contagem usa a mesma regra do `estimateTextTokens` do Core: um token a
 * cada quatro caracteres, arredondado para cima. É uma aproximação para
 * ordens de grandeza, não um tokenizer — e por isso a previsão nunca é
 * tratada como custo confirmado, nem pelo orçamento nem pela tela.
 *
 * ## Puro e sem host
 *
 * Recebe texto e números já lidos; não abre conversa, catálogo nem ledger.
 */
import type { CostUnit } from '../storage/types/modelCatalog';

/** Tokens de entrada estimados a partir do texto que a chamada carrega. */
export const CHARS_PER_TOKEN = 4;

/**
 * Quantos caracteres do texto entram na previsão.
 *
 * Um limite existe porque a mensagem anterior de uma conversa longa é cara de
 * contar em toda previsão e, ainda assim, a previsão já é uma aproximação: o
 * excedente é contado, não descartado em silêncio - `truncated` diz que o
 * número é um piso.
 */
export const FORECAST_TEXT_CHAR_LIMIT = 4_000_000;

/** Estimativa grosseira de tokens de um texto. Nunca um tokenizer. */
export function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** De onde veio uma metade da estimativa. */
export type ForecastBasis =
	/** Mediana do que este modelo publicou na própria conversa. */
	| 'conversation'
	/** Mediana do que este modelo publicou em outras conversas. */
	| 'model'
	/** Nada medido: a metade é desconhecida. */
	| 'none';

/** Um extremo da faixa quando há mais de uma leitura. */
export interface ForecastRange {
	readonly low: number;
	readonly high: number;
}

/** O custo previsto, na unidade do catálogo. */
export type ForecastCost =
	| {
			readonly status: 'estimated';
			readonly currency: string;
			readonly unit: CostUnit;
			readonly input: number;
			readonly output: number;
			readonly total: number;
			/** Faixa observada na mesma unidade; ausente com uma única leitura. */
			readonly range?: ForecastRange;
	  }
	| {
			readonly status: 'unknown';
			readonly reasons: readonly string[];
	  };

/** A previsão inteira. `confidence` nunca é uma medida de acerto. */
export interface CallForecast {
	readonly providerId: string;
	readonly modelId: string;
	readonly access: 'free' | 'paid' | 'unknown';
	/** `estimated` é sempre uma previsão; `unknown` não tem número. */
	readonly cost: ForecastCost;
	readonly inputTokens: number;
	/**
	 * Tokens de saída estimados a partir do que o modelo publicou. Ausente
	 * quando nada foi medido — e então o custo é `unknown`, nunca zero.
	 */
	readonly outputTokens?: number;
	readonly inputBasis: ForecastBasis;
	readonly outputBasis: ForecastBasis;
	/** Quantas leituras de saída sustentam a estimativa. */
	readonly samples: number;
	/** `high` quando as duas metades foram medidas e a faixa é estreita. */
	readonly confidence: 'high' | 'low' | 'unknown';
	/** Tokens de entrada são um piso: o texto excedeu o limite contado. */
	readonly truncated: boolean;
}

/** O preço que a previsão pode usar, só o que o catálogo publicou. */
export interface ForecastPricing {
	readonly currency: string;
	readonly unit: CostUnit;
	readonly input?: number;
	readonly output?: number;
}

/** Uma leitura de saída, na medida em que a previsão a usa. */
export interface ForecastSample {
	readonly inputTokens?: number;
	readonly outputTokens?: number;
}

export interface ForecastInput {
	readonly providerId: string;
	readonly modelId: string;
	readonly access: 'free' | 'paid' | 'unknown';
	readonly pricing?: ForecastPricing;
	/**
	 * O que a chamada enviará: mensagens do usuário e do sistema.
	 *
	 * As respostas anteriores do modelo ficam de fora de propósito: elas são
	 * o que a próxima chamada encolhe, não engorda, e contá-las dobraria a
	 * previsão de uma conversa normal.
	 */
	readonly promptText: string;
	/** Leituras deste modelo **nesta** conversa, mais recentes primeiro. */
	readonly conversationSamples: readonly ForecastSample[];
	/** Leituras deste modelo em qualquer conversa. */
	readonly modelSamples: readonly ForecastSample[];
}

const CHARS_PER_UNIT: Readonly<Record<CostUnit, number>> = {
	per_1k_tokens: 1_000,
	per_1m_tokens: 1_000_000,
};

function median(values: readonly number[]): number | undefined {
	const sorted = [...values].sort((a, b) => a - b);
	if (sorted.length === 0) {
		return undefined;
	}
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1
		? sorted[middle]
		: (sorted[middle - 1] + sorted[middle]) / 2;
}

function observed(samples: readonly ForecastSample[]): readonly number[] {
	return samples
		.map((sample) => sample.outputTokens)
		.filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

interface ResolvedBasis {
	readonly tokens: number | undefined;
	readonly basis: ForecastBasis;
	readonly samples: number;
	readonly low?: number;
	readonly high?: number;
}

/**
 * A metade de saída: esta conversa primeiro, o modelo depois.
 *
 * A conversa é a melhor evidência disponível — é a mesma tarefa, o mesmo
 * prompt, o mesmo servidor — mas uma conversa nova não tem nenhuma. Cair para
 * a mediana do modelo é o que permite prever na primeira mensagem sem inventar
 * um número.
 */
function resolveOutput(
	conversation: readonly ForecastSample[],
	model: readonly ForecastSample[],
): ResolvedBasis {
	const local = observed(conversation);
	if (local.length > 0) {
		return {
			tokens: median(local),
			basis: 'conversation',
			samples: local.length,
			low: Math.min(...local),
			high: Math.max(...local),
		};
	}
	const global = observed(model);
	if (global.length > 0) {
		return {
			tokens: median(global),
			basis: 'model',
			samples: global.length,
			low: Math.min(...global),
			high: Math.max(...global),
		};
	}
	return { tokens: undefined, basis: 'none', samples: 0 };
}

/** Arredonda como `combineCosts`, para não exibir 0,30000000000000004. */
function round(value: number): number {
	return Math.round(value * 1e12) / 1e12;
}

/** A previsão de uma chamada. */
export function forecastCall(input: ForecastInput): CallForecast {
	const truncated = input.promptText.length > FORECAST_TEXT_CHAR_LIMIT;
	const counted = truncated ? input.promptText.slice(0, FORECAST_TEXT_CHAR_LIMIT) : input.promptText;
	const inputTokens = estimateTextTokens(counted);
	const output = resolveOutput(input.conversationSamples, input.modelSamples);
	const base = {
		providerId: input.providerId,
		modelId: input.modelId,
		access: input.access,
		inputTokens,
		outputTokens: output.tokens,
		inputBasis: 'conversation' as const,
		outputBasis: output.basis,
		samples: output.samples,
		truncated,
	};

	const reasons: string[] = [];
	if (input.access === 'free') {
		// Gratuito não tem custo a prever: o número certo é zero porque não há
		// cobrança, e isso é um fato do catálogo, não uma falta de dado.
		return {
			...base,
			cost: {
				status: 'estimated',
				currency: input.pricing?.currency ?? '',
				unit: input.pricing?.unit ?? 'per_1m_tokens',
				input: 0,
				output: 0,
				total: 0,
			},
			confidence: 'high',
		};
	}

	const pricing = input.pricing;
	if (pricing === undefined) {
		reasons.push('o preço deste modelo não está no catálogo');
	}
	if (pricing?.input === undefined) {
		reasons.push('o preço de entrada não está no catálogo');
	}
	if (pricing?.output === undefined) {
		reasons.push('o preço de saída não está no catálogo');
	}
	if (inputTokens === 0) {
		reasons.push('não há texto na conversa para estimar a entrada');
	}
	if (output.tokens === undefined) {
		reasons.push('nenhuma resposta deste modelo foi medida, então a saída não pode ser estimada');
	}
	if (reasons.length > 0 || pricing === undefined || output.tokens === undefined) {
		return {
			...base,
			cost: { status: 'unknown', reasons },
			confidence: 'unknown',
		};
	}

	const perUnit = CHARS_PER_UNIT[pricing.unit];
	const inputCost = inputTokens * ((pricing.input as number) / perUnit);
	const outputCost = output.tokens * ((pricing.output as number) / perUnit);
	const cost: ForecastCost = {
		status: 'estimated',
		currency: pricing.currency,
		unit: pricing.unit,
		input: round(inputCost),
		output: round(outputCost),
		total: round(inputCost + outputCost),
		...(output.low !== undefined && output.high !== undefined && output.low !== output.high
			? {
					range: {
						low: round(inputCost + output.low * ((pricing.output as number) / perUnit)),
						high: round(inputCost + output.high * ((pricing.output as number) / perUnit)),
					},
				}
			: {}),
	};
	// "Alta" aqui quer dizer "as duas metades foram medidas": três ou mais
	// leituras de saída deste modelo. É uma medida de quão sustentada é a
	// estimativa, não de quão perto ela chegará da fatura.
	return {
		...base,
		cost,
		confidence: output.samples >= 3 ? 'high' : 'low',
	};
}
