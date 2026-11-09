/**
 * O que um provedor publica no próprio endpoint, quando publica.
 *
 * ## Por que um módulo puro
 *
 * O formato de `GET /models` do dialeto OpenAI traz, além de `id`, campos que
 * alguns servidores acrescentam: preço por token, janela de contexto, data de
 * criação. Nenhum deles é obrigatório, e servidores diferentes usam nomes
 * diferentes para a mesma ideia. Este módulo extrai **só o que está explícito**
 * e devolve `undefined` para todo o resto — nunca um valor por omissão, nunca
 * uma moeda suposta, nunca um preço zero por falta de preço.
 *
 * ## Sem inventar campos
 *
 * Só são lidos caminhos que já apareceram em respostas reais de servidores
 * compatíveis:
 *
 * - `pricing` / `cost` / `billing` no próprio modelo, com `input`/`prompt` e
 *   `output`/`completion` (número por token, ou `{ per_million: n }`);
 * - `context_length` / `context_window` na raiz do modelo, ou dentro de
 *   `limits`;
 * - `created` (epoch em segundos) para a data em que o modelo entrou no
 *   catálogo do provedor.
 *
 * Qualquer outro formato é ignorado. Um preço que o servidor não publica é
 * `unknown`, e a 5D não tem como transformá-lo em `free`.
 */
import type { CostUnit } from '../../storage/types/modelCatalog';
import type {
	InputModality,
	ModelCapabilities,
	OutputModality,
} from '../../storage/types/modelCatalog';

/** O preço que o próprio endpoint publicou, na unidade em que o publicou. */
export interface PublishedPrice {
	readonly currency: string;
	readonly unit: CostUnit;
	readonly input?: number;
	readonly output?: number;
}

/** O que um registro de `/models` acrescenta à identidade do modelo. */
export interface PublishedModelFields {
	/** Preço publicado pelo próprio provedor, quando ele usa um formato reconhecido. */
	readonly pricing?: PublishedPrice;
	/** Janela de contexto publicada, quando publicada. */
	readonly contextTokens?: number;
	/** Limite de saída publicado, quando publicado. */
	readonly maxOutputTokens?: number;
	/** Capacidades publicadas, quando o provedor publica uma lista. */
	readonly capabilities?: ModelCapabilities;
	/** Quando o modelo entrou no catálogo do provedor (ISO-8601), quando publicado. */
	readonly created?: string;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Um número finito e não negativo. Qualquer outra coisa é ausente. */
function amount(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
		return value;
	}
	// Alguns servidores serializam preço como texto. Convertê-lo é seguro
	// porque o campo é declaradamente um valor; um texto que não é número
	// continua sendo ausente.
	if (typeof value === 'string' && value.trim().length > 0) {
		const parsed = Number(value);
		return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
	}
	return undefined;
}

/**
 * Uma direção de preço, em qualquer um dos dois formatos reconhecidos:
 * número por token, ou `{ per_million }` / `{ per_1k }` explícitos.
 *
 * Per token é a forma mais comum no dialeto OpenAI ("cost per 1 token"), e por
 * isso o número bruto vira `per_token` — representado aqui como
 * `per_1m_tokens` dividido por um milhão, para reutilizar `CostUnit` sem
 * inventar uma terceira unidade no catálogo.
 */
interface Direction {
	readonly value: number;
	readonly perTokens: number;
}

function readDirection(value: unknown): Direction | undefined {
	const direct = amount(value);
	if (direct !== undefined) {
		// Número bruto: preço por token, como no dialeto.
		return { value: direct, perTokens: 1 };
	}
	const object = asObject(value);
	if (object === undefined) {
		return undefined;
	}
	const perMillion = amount(object['per_million'] ?? object['per_million_tokens'] ?? object['perMillion']);
	if (perMillion !== undefined) {
		return { value: perMillion, perTokens: 1_000_000 };
	}
	const perThousand = amount(object['per_1k'] ?? object['per_1k_tokens'] ?? object['perThousand']);
	if (perThousand !== undefined) {
		return { value: perThousand, perTokens: 1_000 };
	}
	// `{ amount, per }` é o formato que um proxy local costuma usar; só é
	// lido quando `per` é exatamente uma das duas unidades conhecidas.
	const nested = amount(object['amount'] ?? object['value']);
	const per = object['per'];
	if (nested !== undefined) {
		if (per === '1m' || per === 'per_1m_tokens' || per === 1_000_000) {
			return { value: nested, perTokens: 1_000_000 };
		}
		if (per === '1k' || per === 'per_1k_tokens' || per === 1_000) {
			return { value: nested, perTokens: 1_000 };
		}
	}
	return undefined;
}

function firstDirection(candidate: Record<string, unknown>, keys: readonly string[]): Direction | undefined {
	for (const key of keys) {
		const direction = readDirection(candidate[key]);
		if (direction !== undefined) {
			return direction;
		}
	}
	return undefined;
}

/**
 * Lê o bloco de preço do modelo, se houver um.
 *
 * Moeda é obrigatória: sem ela, "3" não é preço de nada. Os números são
 * convertidos para a forma que `ModelPricing` guarda (`per_1m_tokens`) sem
 * perder o valor: um preço por token de 0.000003 vira 3 por milhão.
 */
function readPublishedPricing(entry: Record<string, unknown>): PublishedPrice | undefined {
	const block = asObject(entry['pricing']) ?? asObject(entry['cost']) ?? asObject(entry['billing']);
	if (block === undefined) {
		return undefined;
	}
	const currency = block['currency'] ?? block['currency_code'];
	if (typeof currency !== 'string' || currency.trim().length === 0) {
		return undefined;
	}
	const input = firstDirection(block, ['input', 'prompt', 'input_tokens', 'prompt_tokens']);
	const output = firstDirection(block, ['output', 'completion', 'output_tokens', 'completion_tokens']);
	if (input === undefined && output === undefined) {
		return undefined;
	}
	// Uma direção por token e outra por milhão no mesmo bloco é ambígua: não há
	// como somá-las sem escolher uma leitura para a outra. O bloco é ignorado.
	if (input !== undefined && output !== undefined && input.perTokens !== output.perTokens) {
		return undefined;
	}
	const perTokens = (input ?? output)?.perTokens ?? 1;
	const scale = perTokens === 1_000_000 ? 1 : 1_000_000 / perTokens;
	const at = (direction: Direction | undefined): number | undefined =>
		direction === undefined ? undefined : Math.round(direction.value * scale * 1e12) / 1e12;
	return {
		currency: currency.trim().toUpperCase(),
		// Sempre normalizado para a unidade do catálogo: um milhão de tokens.
		unit: 'per_1m_tokens',
		...(input !== undefined ? { input: at(input) } : {}),
		...(output !== undefined ? { output: at(output) } : {}),
	};
}

/** A janela de contexto, do primeiro lugar explícito que a publica. */
function readContextTokens(entry: Record<string, unknown>): number | undefined {
	const limits = asObject(entry['limits']);
	const candidates = [
		entry['context_length'],
		entry['context_window'],
		entry['context_window_tokens'],
		entry['max_context_length'],
		limits?.['context_tokens'],
		limits?.['context_length'],
	];
	for (const candidate of candidates) {
		const value = amount(candidate);
		if (value !== undefined && Number.isInteger(value)) {
			return value;
		}
	}
	return undefined;
}

/**
 * O limite de saída, do primeiro lugar explícito que o publica.
 *
 * Separate da janela de contexto, como sempre: a janela é prompt *mais*
 * resposta, e usá-la como orçamento da resposta é o tipo de troca que produz
 * um pedido dimensionado para uma resposta que o endpoint recusa.
 */
function readMaxOutputTokens(entry: Record<string, unknown>): number | undefined {
	const limits = asObject(entry['limits']);
	const candidates = [
		entry['max_output_tokens'],
		entry['max_completion_tokens'],
		limits?.['max_output_tokens'],
		limits?.['max_completion_tokens'],
	];
	for (const candidate of candidates) {
		const value = amount(candidate);
		if (value !== undefined && Number.isInteger(value)) {
			return value;
		}
	}
	return undefined;
}

/** Uma lista de nomes, quando o campo é uma lista de textos. */
function stringList(value: unknown): readonly string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	return value.filter((item): item is string => typeof item === 'string');
}

/** As modalidades que o projeto conhece. */
const INPUT_MODALITIES: readonly InputModality[] = ['text', 'image', 'audio', 'video', 'file'];
const OUTPUT_MODALITIES: readonly OutputModality[] = ['text', 'image', 'audio'];

/**
 * As capacidades, a partir das listas que o provedor publica.
 *
 * ## Três fontes, nenhuma delas o nome do modelo
 *
 * - `supported_parameters` — a lista de parâmetros que o modelo aceita.
 *   `tools` e `tool_choice` significam ferramenta; `structured_outputs` e
 *   `response_format` significam saída estruturada; `reasoning` significa
 *   raciocínio. É uma enumeração: o que não está na lista não é suportado.
 * - `capabilities` — a lista de capacidades que o provedor declara
 *   (`tool_use`, `vision`, `reasoning`, …).
 * - `architecture.input_modalities` / `output_modalities` — as modalidades.
 *
 * Quando a lista **não** é publicada, nada é afirmado: o campo fica ausente,
 * que é "ninguém sabe", e não `false`.
 */
function readCapabilities(entry: Record<string, unknown>): ModelCapabilities | undefined {
	const parameters = stringList(entry['supported_parameters']);
	const declared = stringList(entry['capabilities']);
	const architecture = asObject(entry['architecture']);
	const inputModalities = stringList(architecture?.['input_modalities']);
	const outputModalities = stringList(architecture?.['output_modalities']);

	const result: {
		toolCalling?: boolean;
		structuredOutput?: boolean;
		reasoning?: boolean;
		inputs?: Partial<Record<InputModality, boolean>>;
		outputs?: Partial<Record<OutputModality, boolean>>;
	} = {};

	if (parameters !== undefined) {
		const names = new Set(parameters.map((name) => name.toLowerCase()));
		result.toolCalling = names.has('tools') || names.has('tool_choice');
		result.structuredOutput =
			names.has('structured_outputs') || names.has('response_format') || names.has('json_schema');
		result.reasoning = names.has('reasoning') || names.has('include_reasoning');
	}

	if (declared !== undefined) {
		const names = new Set(declared.map((name) => name.toLowerCase()));
		result.toolCalling = names.has('tool_use') || names.has('tools') || names.has('function_calling');
		result.structuredOutput = names.has('structured_output') || names.has('structured_outputs');
		result.reasoning = names.has('reasoning');
	}

	if (inputModalities !== undefined) {
		const inputs: Partial<Record<InputModality, boolean>> = {};
		for (const modality of INPUT_MODALITIES) {
			inputs[modality] = inputModalities.some((name) => name.toLowerCase() === modality);
		}
		result.inputs = inputs;
	}
	if (outputModalities !== undefined) {
		const outputs: Partial<Record<OutputModality, boolean>> = {};
		for (const modality of OUTPUT_MODALITIES) {
			outputs[modality] = outputModalities.some((name) => name.toLowerCase() === modality);
		}
		result.outputs = outputs;
	}

	return Object.keys(result).length === 0 ? undefined : result;
}

/** `created`, em epoch de segundos, quando presente e plausível. */
function readCreated(entry: Record<string, unknown>): string | undefined {
	const created = amount(entry['created'] ?? entry['created_at']);
	if (created === undefined) {
		return undefined;
	}
	// Epoch em milissegundos existe em algum servidor; distinguir pelo tamanho.
	const ms = created > 1e12 ? created : created * 1_000;
	const date = new Date(ms);
	if (Number.isNaN(date.getTime())) {
		return undefined;
	}
	return date.toISOString();
}

/**
 * Lê um registro de `data[]`.
 *
 * Devolve `{}` quando o registro não publica nada além de `id`: isso não é
 * falha, é a forma normal de um serviço compatível.
 */
export function readPublishedModelFields(entry: unknown): PublishedModelFields {
	const record = asObject(entry);
	if (record === undefined) {
		return {};
	}
	const pricing = readPublishedPricing(record);
	const contextTokens = readContextTokens(record);
	const maxOutputTokens = readMaxOutputTokens(record);
	const capabilities = readCapabilities(record);
	const created = readCreated(record);
	return {
		...(pricing !== undefined ? { pricing } : {}),
		...(contextTokens !== undefined ? { contextTokens } : {}),
		...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
		...(capabilities !== undefined ? { capabilities } : {}),
		...(created !== undefined ? { created } : {}),
	};
}
