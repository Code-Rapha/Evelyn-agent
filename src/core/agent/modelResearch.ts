/**
 * A pesquisa que completa o catálogo — e o que ela **não** pode afirmar.
 *
 * ## Como a pesquisa funciona
 *
 * Não há ferramenta de busca no agente, e a escolha foi usar o provedor que já
 * está configurado: a ferramenta faz **um** pedido de texto ao modelo da
 * conversa, com instruções para que ele cite a fonte de cada fato. Nada é
 * gravado por isso. O que sai daqui é uma **proposta**, com a confiança de
 * cada campo explicitada.
 *
 * ## Por que a proposta não é o catálogo
 *
 * Três níveis, e o nível é o dado mais importante da resposta:
 *
 * - `provider` — o próprio provedor publicou (endpoint `/models`). É o único
 *   lado que não passa por julgamento: o catálogo já o registra sozinho.
 * - `secondary` — encontrado em documentação ou benchmark. **Foi lido de
 *   algum lugar**, e a fonte vai junto. Mesmo assim não é o provedor falando.
 * - `estimated` — inferido de um modelo parecido ou de uma convenção de nome.
 *   Vale como pista, nunca como fato.
 *
 * O que não tem fonte fica `unknown` e **não** é gravado. É essa a diferença
 * entre "o modelo é bom em código" e "o modelo se chama alguma-coisa-coder".
 *
 * ## O que a recomendação faz com isso
 *
 * A recomendação continua sendo a do roteador. O que muda é que ela passa a ver
 * os campos pesquisados — com a mesma marca de origem que a tela mostra. Uma
 * capacidade que só existe como `estimated` não pontua como uma confirmada:
 * seria dar ao palpite o peso de um fato.
 */
import type { ModelCapabilities, ModelLimits, ModelPricing } from '../storage/types/modelCatalog';

/**
 * Quão firme é uma informação, na ordem em que o catálogo confia nela.
 *
 * O nome é o mesmo de `ModelMetadataSource` para o `provider` e o `manual`;
 * `estimated` existe aqui e **não** lá: uma estimativa não é uma origem do
 * catálogo, é o que a pesquisa reconheceu como não havendo fonte.
 */
export type EvidenceLevel = 'provider' | 'secondary' | 'estimated' | 'unknown';

/** Uma fonte, do jeito que ela foi citada. */
export interface ResearchSource {
	/** A URL, quando a pesquisa citou uma. */
	readonly url?: string;
	/** O que a fonte é: documentação, benchmark, blog do fabricante… */
	readonly kind: 'documentation' | 'benchmark' | 'provider-page' | 'other';
	/** O trecho em que o fato se apoia, curto e literal. */
	readonly quote?: string;
	/** Quando foi consultada. */
	readonly consultedAt: string;
}

/** Um campo pesquisado, com o nível e a fonte que o sustentam. */
export interface ResearchedField<T> {
	readonly value: T;
	readonly level: EvidenceLevel;
	/** Ausente quando o nível é `unknown` — desconhecido não tem fonte. */
	readonly source?: ResearchSource;
}

/**
 * A proposta de enriquecimento de um modelo.
 *
 * Cada grupo é independente: uma pesquisa pode confirmar a janela de contexto e
 * não dizer nada sobre preço. Grupos ausentes são grupos que ninguém encontrou,
 * e não grupos vazios.
 */
export interface ModelResearchProposal {
	readonly providerId: string;
	readonly modelId: string;
	/** A consulta que foi feita, para a proposta poder ser reproduzida. */
	readonly query: string;
	readonly researchedAt: string;
	readonly limits?: {
		readonly contextTokens?: ResearchedField<number>;
		readonly maxOutputTokens?: ResearchedField<number>;
	};
	readonly capabilities?: {
		readonly toolCalling?: ResearchedField<boolean>;
		readonly structuredOutput?: ResearchedField<boolean>;
		readonly reasoning?: ResearchedField<boolean>;
		readonly inputs?: Readonly<Partial<Record<string, ResearchedField<boolean>>>>;
		readonly outputs?: Readonly<Partial<Record<string, ResearchedField<boolean>>>>;
	};
	readonly pricing?: {
		readonly currency?: ResearchedField<string>;
		readonly unit?: ResearchedField<'per_1k_tokens' | 'per_1m_tokens'>;
		readonly input?: ResearchedField<number>;
		readonly output?: ResearchedField<number>;
	};
	readonly access?: ResearchedField<'free' | 'paid' | 'unknown'>;
	/** Texto livre: condições de uso, restrições, limites de taxa. */
	readonly notes?: ResearchedField<string>;
	/** O que a pesquisa **não** encontrou, e por isso ficou desconhecido. */
	readonly unknown: readonly string[];
}

/**
 * O formulário que o modelo preenche ao pesquisar.
 *
 * Rígido de propósito: cada linha é um fato, com o nível e a fonte na própria
 * linha. Uma resposta em prosa obrigaria outro modelo a interpretá-la, e a
 * interpretação é justamente onde um palpite vira "fato".
 */
export const RESEARCH_FORMAT = `Responda com UMA linha por fato, no formato:
campo | nivel | valor | fonte | trecho

- campo: um de context, max-output, tools, structured-output, reasoning, input-<modalidade>, output-<modalidade>, price-input, price-output, price-unit, price-currency, access, notes
- nivel: provider (a própria página/documentação oficial do provedor) | secondary (benchmark, artigo, terceiro) | estimated (inferência sua, sem fonte)
- valor: o número ou sim/nao ou o texto, curto
- fonte: a URL, ou "sem-fonte" quando não houver
- trecho: uma frase literal (máx. 160 caracteres) que sustente o valor

Regras:
- Não invente URL. Se não viu a fonte, use nivel "estimated" e fonte "sem-fonte".
- Um campo que você não encontrou não é linha: ele fica desconhecido.
- Nunca converta nome de modelo em capacidade: "coder" no nome não prova código.`;

/** Um fato lido do formulário. */
export interface ResearchFact {
	readonly field: string;
	readonly level: EvidenceLevel;
	readonly value: string;
	readonly source?: ResearchSource;
}

/** O que saiu de uma resposta, e o que foi recusado. */
export interface ParsedResearch {
	readonly facts: readonly ResearchFact[];
	readonly rejected: readonly { readonly line: string; readonly reason: string }[];
}

function levelOf(text: string): EvidenceLevel | undefined {
	switch (text.trim().toLowerCase()) {
		case 'provider':
			return 'provider';
		case 'secondary':
		case 'secundaria':
		case 'secundária':
			return 'secondary';
		case 'estimated':
		case 'estimado':
			return 'estimated';
		case 'unknown':
		case 'desconhecido':
			return 'unknown';
		default:
			return undefined;
	}
}

function kindOf(url: string): ResearchSource['kind'] {
	const lower = url.toLowerCase();
	if (/hangfire|ollama|lmarena|artificialanalysis|benchmark|leaderboard/.test(lower)) {
		return 'benchmark';
	}
	if (/docs?\.|documentation|readme|github\.com/.test(lower)) {
		return 'documentation';
	}
	if (/\.(com|ai|io|org)\/?$/.test(lower) && !/\//.test(lower.replace(/^https?:\/\//, ''))) {
		return 'provider-page';
	}
	return 'other';
}

/**
 * Interpreta a resposta da pesquisa.
 *
 * Aceita apenas o formato declarado. Uma linha sem fonte que se diz `provider`
 * ou `secondary` é **rebaixada** para `estimated`: dizer "está na doc oficial"
 * sem URL é uma afirmação que ninguém pode conferir, e não pode herdar o peso
 * de um documento.
 */
export function parseResearch(text: string, consultedAt: string): ParsedResearch {
	const facts: ResearchFact[] = [];
	const rejected: { line: string; reason: string }[] = [];

	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (line.length === 0 || line.startsWith('```') || line.startsWith('#')) {
			continue;
		}
		// Uma linha de conversa não tem os separadores do formulário.
		if (!line.includes('|')) {
			continue;
		}
		const parts = line.split('|').map((part) => part.trim());
		if (parts.length < 3) {
			rejected.push({ line, reason: 'linha sem os campos minimos (campo | nivel | valor)' });
			continue;
		}
		const bullet = parts[0].replace(/^[-*]\s*/, '').trim();
		const level = levelOf(parts[1] ?? '');
		if (level === undefined) {
			rejected.push({ line, reason: `nivel desconhecido: "${parts[1] ?? ''}"` });
			continue;
		}
		if (bullet.length === 0) {
			rejected.push({ line, reason: 'campo vazio' });
			continue;
		}
		const value = (parts[2] ?? '').trim();
		if (value.length === 0 || value === '?') {
			// Nada a aprender: o campo continua desconhecido, sem virar fato.
			continue;
		}
		const rawSource = (parts[3] ?? '').trim();
		const quote = (parts[4] ?? '').trim().slice(0, 160);
		const hasSource = rawSource.length > 0 && rawSource.toLowerCase() !== 'sem-fonte' && /^https?:\/\//i.test(rawSource);

		let effective: EvidenceLevel = level;
		if (!hasSource && (level === 'provider' || level === 'secondary')) {
			// A afirmação não pode ser conferida: o nível que resta é o de
			// estimativa, e a proposta vai dizer isso ao usuário.
			effective = 'estimated';
		}
		if (level === 'unknown') {
			continue;
		}
		facts.push({
			field: bullet,
			level: effective,
			value,
			...(hasSource
				? {
						source: {
							url: rawSource,
							kind: kindOf(rawSource),
							...(quote.length > 0 ? { quote } : {}),
							consultedAt,
						},
					}
				: {}),
		});
	}

	return { facts, rejected };
}

function number(value: string): number | undefined {
	const cleaned = value.replace(/[_\s]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.');
	const parsed = Number.parseFloat(cleaned);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function bool(value: string): boolean | undefined {
	switch (value.trim().toLowerCase()) {
		case 'sim':
		case 's':
		case 'yes':
		case 'true':
		case '1':
		case 'suportado':
			return true;
		case 'nao':
		case 'não':
		case 'no':
		case 'false':
		case '0':
		case 'nao-suportado':
			return false;
		default:
			return undefined;
	}
}

/**
 * Monta a proposta a partir dos fatos aceitos.
 *
 * Um campo que aparece mais de uma vez fica com o **nível mais forte**; entre
 * dois do mesmo nível, o primeiro. Não é arbitrário: uma documentação oficial
 * sobre um benchmark sobre uma estimativa, e o usuário tem a fonte para julgar.
 */
export function proposeResearch(input: {
	readonly providerId: string;
	readonly modelId: string;
	readonly query: string;
	readonly researchedAt: string;
	readonly parsed: ParsedResearch;
}): ModelResearchProposal {
	/** O valor de um campo, escolhendo o nível mais forte. */
	const pick = <T>(
		field: string,
		convert: (value: string) => T | undefined,
	): ResearchedField<T> | undefined => {
		const rank: Record<EvidenceLevel, number> = { provider: 3, secondary: 2, estimated: 1, unknown: 0 };
		let best: { field: ResearchedField<T>; rank: number } | undefined;
		for (const fact of input.parsed.facts) {
			if (fact.field !== field) {
				continue;
			}
			const value = convert(fact.value);
			if (value === undefined) {
				continue;
			}
			const candidate: ResearchedField<T> = {
				value,
				level: fact.level,
				...(fact.source !== undefined ? { source: fact.source } : {}),
			};
			if (best === undefined || rank[fact.level] > best.rank) {
				best = { field: candidate, rank: rank[fact.level] };
			}
		}
		return best?.field;
	};

	const limits = {
		...(pick('context', number) !== undefined ? { contextTokens: pick('context', number) } : {}),
		...(pick('max-output', number) !== undefined ? { maxOutputTokens: pick('max-output', number) } : {}),
	};
	const capabilities = {
		...(pick('tools', bool) !== undefined ? { toolCalling: pick('tools', bool) } : {}),
		...(pick('structured-output', bool) !== undefined
			? { structuredOutput: pick('structured-output', bool) }
			: {}),
		...(pick('reasoning', bool) !== undefined ? { reasoning: pick('reasoning', bool) } : {}),
	};
	const pricing = {
		...(pick('price-currency', (value) => (value.length <= 8 ? value.toUpperCase() : undefined)) !== undefined
			? { currency: pick('price-currency', (value) => (value.length <= 8 ? value.toUpperCase() : undefined)) }
			: {}),
		...(pick('price-unit', (value): 'per_1k_tokens' | 'per_1m_tokens' | undefined => {
			const normalized = value.toLowerCase().replace(/[\s_]/g, '');
			if (normalized.includes('1m') || normalized.includes('milhao') || normalized.includes('million')) {
				return 'per_1m_tokens';
			}
			if (normalized.includes('1k') || normalized.includes('mil') || normalized.includes('thousand')) {
				return 'per_1k_tokens';
			}
			return undefined;
		}) !== undefined
			? {
					unit: pick('price-unit', (value): 'per_1k_tokens' | 'per_1m_tokens' | undefined => {
						const normalized = value.toLowerCase().replace(/[\s_]/g, '');
						if (normalized.includes('1m') || normalized.includes('milhao') || normalized.includes('million')) {
							return 'per_1m_tokens';
						}
						if (normalized.includes('1k') || normalized.includes('mil') || normalized.includes('thousand')) {
							return 'per_1k_tokens';
						}
						return undefined;
					}),
				}
			: {}),
		...(pick('price-input', number) !== undefined ? { input: pick('price-input', number) } : {}),
		...(pick('price-output', number) !== undefined ? { output: pick('price-output', number) } : {}),
	};
	const access = pick('access', (value) => {
		const normalized = value.trim().toLowerCase();
		if (normalized === 'free' || normalized === 'gratuito') {return 'free' as const;}
		if (normalized === 'paid' || normalized === 'pago') {return 'paid' as const;}
		return undefined;
	});
	const notes = pick('notes', (value) => (value.length > 0 ? value.slice(0, 400) : undefined));

	const has = Object.values(limits).some((entry) => entry !== undefined);
	const hasCapabilities = Object.values(capabilities).some((entry) => entry !== undefined);
	const hasPricing = Object.values(pricing).some((entry) => entry !== undefined);

	// O que a pesquisa não encontrou: dito explicitamente, para o usuário ver a
	// lacuna em vez de supor que o silêncio é "não tem".
	const unknown: string[] = [];
	if (!has) {unknown.push('limits');}
	if (!hasCapabilities) {unknown.push('capabilities');}
	if (!hasPricing) {unknown.push('pricing');}
	if (access === undefined) {unknown.push('access');}

	return {
		providerId: input.providerId,
		modelId: input.modelId,
		query: input.query,
		researchedAt: input.researchedAt,
		...(has ? { limits } : {}),
		...(hasCapabilities ? { capabilities } : {}),
		...(hasPricing ? { pricing } : {}),
		...(access !== undefined ? { access } : {}),
		...(notes !== undefined ? { notes } : {}),
		unknown,
	};
}

/**
 * O que a proposta muda no catálogo, e só o que ela pode mudar.
 *
 * Só entra no catálogo o que for **confirmado pelo usuário**. Uma informação
 * `estimated` nunca é gravada como capacidade: a instrução do pedido é que o
 * usuário confirme o que viu, e confirmar um palpite não o transforma em fato.
 *
 * O nível efetivo gravado é `secondary` quando havia fonte secundária e
 * `provider` quando o fato veio da página do provedor; o catálogo já sabe
 * distinguir os dois de `manual` (o que a pessoa digitou).
 */
export function confirmedResearch(
	proposal: ModelResearchProposal,
	confirmedFields: readonly string[] | 'all',
): {
	readonly limits?: ModelLimits;
	readonly model?: ModelCapabilities;
	readonly pricing?: ModelPricing;
	readonly access?: 'free' | 'paid' | 'unknown';
	readonly notes?: string;
	readonly applied: readonly string[];
	readonly skipped: readonly { readonly field: string; readonly reason: string }[];
} {
	const wanted = (field: string): boolean =>
		confirmedFields === 'all' ? true : confirmedFields.includes(field);
	const applied: string[] = [];
	const skipped: { field: string; reason: string }[] = [];

	const limits: { contextTokens?: number; maxOutputTokens?: number } = {};
	for (const [field, key] of [
		['context', 'contextTokens'],
		['max-output', 'maxOutputTokens'],
	] as const) {
		const entry = key === 'contextTokens' ? proposal.limits?.contextTokens : proposal.limits?.maxOutputTokens;
		if (entry === undefined || !wanted(field)) {continue;}
		if (entry.level === 'estimated') {
			skipped.push({ field, reason: 'estimativa não é gravada como capacidade confirmada' });
			continue;
		}
		limits[key] = entry.value;
		applied.push(field);
	}

	const model: {
		toolCalling?: boolean;
		structuredOutput?: boolean;
		reasoning?: boolean;
	} = {};
	for (const [field, key] of [
		['tools', 'toolCalling'],
		['structured-output', 'structuredOutput'],
		['reasoning', 'reasoning'],
	] as const) {
		const entry = proposal.capabilities?.[key];
		if (entry === undefined || !wanted(field)) {continue;}
		if (entry.level === 'estimated') {
			skipped.push({ field, reason: 'estimativa não é gravada como capacidade confirmada' });
			continue;
		}
		model[key] = entry.value;
		applied.push(field);
	}

	let pricing: ModelPricing | undefined;
	const currency = proposal.pricing?.currency;
	const unit = proposal.pricing?.unit;
	const priceInput = proposal.pricing?.input;
	const priceOutput = proposal.pricing?.output;
	const priceFields = [
		['price-currency', currency],
		['price-unit', unit],
		['price-input', priceInput],
		['price-output', priceOutput],
	] as const;
	const usable = (entry: { readonly level: EvidenceLevel } | undefined): boolean =>
		entry !== undefined && entry.level !== 'estimated';
	if (currency !== undefined && unit !== undefined && usable(currency) && usable(unit)) {
		if (wanted('price-currency') || wanted('price-unit') || wanted('price-input') || wanted('price-output')) {
			pricing = {
				currency: currency.value,
				unit: unit.value,
				...(priceInput !== undefined && usable(priceInput) && wanted('price-input')
					? { input: priceInput.value }
					: {}),
				...(priceOutput !== undefined && usable(priceOutput) && wanted('price-output')
					? { output: priceOutput.value }
					: {}),
			};
			for (const [field, entry] of priceFields) {
				if (entry === undefined) {continue;}
				if (!wanted(field)) {continue;}
				if (!usable(entry)) {
					skipped.push({ field, reason: 'estimativa não é gravada como preço confirmado' });
					continue;
				}
				applied.push(field);
			}
		}
	} else if (priceFields.some(([, entry]) => entry !== undefined)) {
		skipped.push({
			field: 'pricing',
			reason: 'preço exige moeda e unidade com fonte; sem isso continua desconhecido',
		});
	}

	const access =
		proposal.access !== undefined && proposal.access.level !== 'estimated' && wanted('access')
			? proposal.access.value
			: undefined;
	if (access !== undefined) {
		applied.push('access');
	}
	const notes =
		proposal.notes !== undefined && wanted('notes' ) ? proposal.notes.value : undefined;
	if (notes !== undefined) {
		applied.push('notes');
	}

	return {
		...(Object.keys(limits).length > 0 ? { limits } : {}),
		...(Object.keys(model).length > 0 ? { model } : {}),
		...(pricing !== undefined ? { pricing } : {}),
		...(access !== undefined ? { access } : {}),
		...(notes !== undefined ? { notes } : {}),
		applied,
		skipped,
	};
}

/** As fontes distintas da proposta, para a tela listar uma vez cada. */
export function sourcesOf(proposal: ModelResearchProposal): readonly ResearchSource[] {
	const all: ResearchSource[] = [];
	const push = (entry?: { readonly source?: ResearchSource }): void => {
		if (entry?.source !== undefined && !all.some((item) => item.url === entry.source?.url)) {
			all.push(entry.source);
		}
	};
	push(proposal.limits?.contextTokens);
	push(proposal.limits?.maxOutputTokens);
	push(proposal.capabilities?.toolCalling);
	push(proposal.capabilities?.structuredOutput);
	push(proposal.capabilities?.reasoning);
	push(proposal.pricing?.currency);
	push(proposal.pricing?.unit);
	push(proposal.pricing?.input);
	push(proposal.pricing?.output);
	push(proposal.access);
	push(proposal.notes);
	return all;
}
