/**
 * O diálogo em que a Evelyn registra as próprias preferências de modelo.
 *
 * ## Por que um arquivo próprio
 *
 * As preferências moram num **chat**, porque é ali que a Evelyn fala com
 * liberdade sobre cada modelo — para que serve, o que ela mediu, o que custa.
 * Mas a decisão de qualidade acontece no motor, sem conversa e a cada turno:
 * ler o próprio chat toda vez misturaria o que ela escreveu com o que o
 * usuário disse, e o resultado seria um motor que obedece a promessa.
 *
 * Então o chat é a fonte, e o motor lê o **resultado** dela: a última resposta
 * da Evelyn naquele diálogo, interpretada por este módulo. O diálogo inteiro
 * continua no histórico, editável, e a próxima resposta dela substitui a
 * anterior como referência.
 *
 * ## Por que texto e não um estado opaco
 *
 * O arquivo é JSON legível, estável e sem dependência de socket ou processo.
 * Ele pode ser apagado sem quebrar nada: sem arquivo, o motor volta a decidir
 * pelas regras de sempre. É o mesmo princípio do catálogo — o que não foi dito
 * não é inventado.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Uma preferência declarada sobre um modelo.
 *
 * Todos os campos além do nome são opcionais e **nunca** preenchidos por
 * inferência: um preço ausente não é zero, e uma capacidade ausente não é
 * "não tem". O motor só usa o que a Evelyn escreveu.
 */
export interface ModelGuidanceEntry {
	/** O modelo, como o provedor o chama. Casa por igualdade exata. */
	readonly model: string;
	/** O provedor, quando a Evelyn o nomeou. Ausente casa em qualquer provedor. */
	readonly providerId?: string;
	/** `true` quando ela disser que o modelo serve para tarefas com ferramentas. */
	readonly tools?: boolean;
	/** `true` quando ela disser que ele raciocina bem. */
	readonly reasoning?: boolean;
	/** `true` quando ela disser que ele aguenta contexto longo. */
	readonly longContext?: boolean;
	/** 0..1, mais alto = melhor custo-benefício, como ela o classificou. */
	readonly value?: number;
	/** Em que situações ela disse que ele serve. Texto livre, curto. */
	readonly useFor?: string;
}

/** Uma frase em que a Evelyn explicou uma preferência. É o que fica no registro. */
export interface ModelGuidanceRow {
	readonly model: string;
	readonly providerId?: string;
	readonly fields: readonly (readonly [string, string])[];
	readonly line: string;
}

export interface ModelGuidance {
	readonly conversationId: string;
	readonly updatedAt: string;
	/** Entradas legíveis, uma por modelo. */
	readonly entries: readonly ModelGuidanceEntry[];
	/** As frases de onde cada entrada saiu — para a tela poder mostrar a fonte. */
	readonly rows: readonly ModelGuidanceRow[];
	/** O que foi recusado, e por quê. Vazio quando tudo foi aceito. */
	readonly rejected: readonly { readonly line: string; readonly reason: string }[];
}

export interface ModelGuidanceStore {
	read(): Promise<ModelGuidance | undefined>;
	write(dialogue: {
		readonly conversationId: string;
		readonly text: string;
		readonly now: () => string;
	}): Promise<ModelGuidance>;
	clear(): Promise<void>;
}

/**
 * O caminho do arquivo.
 *
 * Fica ao lado de `router-config.json`, na raiz do store — o mesmo lugar das
 * outras decisões globais, para quem já sabe onde procurar não aprender um
 * segundo endereço.
 */
export const MODEL_GUIDANCE_FILE = 'model-guidance.json';

export function createModelGuidanceStore(root: string): ModelGuidanceStore {
	const path = join(root, MODEL_GUIDANCE_FILE);
	return {
		async read(): Promise<ModelGuidance | undefined> {
			let raw: string;
			try {
				raw = await readFile(path, 'utf8');
			} catch {
				// Sem arquivo é o estado normal antes da primeira resposta. Não é
				// erro e não deve aparecer como um no log do turno.
				return undefined;
			}
			return parseGuidance(raw);
		},
		async write(input): Promise<ModelGuidance> {
			const guidance = interpretModelGuidance(input.text);
			const record: ModelGuidance = {
				conversationId: input.conversationId,
				updatedAt: input.now(),
				entries: guidance.entries,
				rows: guidance.rows,
				rejected: guidance.rejected,
			};
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
			return record;
		},
		async clear(): Promise<void> {
			await rm(path, { force: true });
		},
	};
}

/**
 * Lê o que já foi gravado.
 *
 * Um arquivo ilegível é tratado como ausência, e não como erro que derruba o
 * turno: a decisão de modelo é um refinamento, e um refinamento quebrado não
 * pode impedir a conversa de acontecer.
 */
function parseGuidance(raw: string): ModelGuidance | undefined {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return undefined;
	}
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.conversationId !== 'string' || typeof candidate.updatedAt !== 'string') {
		return undefined;
	}
	const entries: ModelGuidanceEntry[] = [];
	for (const entry of Array.isArray(candidate.entries) ? candidate.entries : []) {
		if (typeof entry !== 'object' || entry === null) {continue;}
		const item = entry as Record<string, unknown>;
		if (typeof item.model !== 'string' || item.model.length === 0) {continue;}
		entries.push({
			model: item.model,
			...(typeof item.providerId === 'string' && item.providerId.length > 0
				? { providerId: item.providerId }
				: {}),
			...(typeof item.tools === 'boolean' ? { tools: item.tools } : {}),
			...(typeof item.reasoning === 'boolean' ? { reasoning: item.reasoning } : {}),
			...(typeof item.longContext === 'boolean' ? { longContext: item.longContext } : {}),
			...(typeof item.value === 'number' && item.value >= 0 && item.value <= 1 ? { value: item.value } : {}),
			...(typeof item.useFor === 'string' && item.useFor.length > 0 ? { useFor: item.useFor } : {}),
		});
	}
	return {
		conversationId: candidate.conversationId,
		updatedAt: candidate.updatedAt,
		entries,
		rows: [],
		rejected: [],
	};
}

/**
 * A forma que a Evelyn precisa usar, mostrada a ela no diálogo.
 *
 * Uma linha por modelo, campos `chave: valor`. É simples o bastante para ela
 * escrever sem ser lembrada de uma gramática, e rígido o bastante para o motor
 * não precisar de um modelo para interpretá-la — que seria o próprio problema
 * que estas preferências existem para resolver.
 */
export const GUIDANCE_FORMAT = [
	'Uma linha por modelo, exatamente neste formato:',
	'- <modelo> | tools: sim/nao | reasoning: sim/nao | contexto-longo: sim/nao | valor: 0.0-1.0 | uso: <uma frase>',
	'',
	'Regras:',
	'- O nome do modelo é o mesmo que aparece na lista de modelos.',
	'- Um campo que você não sabe fica de fora; "?" também serve. Não invente.',
	'- `valor` é custo-benefício, de 0 (caro e fraco) a 1 (barato e forte).',
	'- Só use nomes de modelos que existem na lista. Inventar um nome o deixa sem efeito.',
].join('\n');

const FIELD_NAMES = {
	tools: 'tools',
	reasoning: 'reasoning',
	'contexto-longo': 'longContext',
	longContext: 'longContext',
	valor: 'value',
	value: 'value',
	uso: 'useFor',
	useFor: 'useFor',
} as const;

type FieldName = (typeof FIELD_NAMES)[keyof typeof FIELD_NAMES];

/**
 * Interpreta a resposta da Evelyn.
 *
 * Aceita apenas o formato declarado, e diz o que recusou em vez de adivinhar.
 * Uma linha fora do formato é uma linha que não vira preferência — e isso fica
 * registrado, para que a resposta dela poder ser corrigida em vez de
 * silenciosamente ignorada.
 */
export function interpretModelGuidance(text: string): {
	readonly entries: readonly ModelGuidanceEntry[];
	readonly rows: readonly ModelGuidanceRow[];
	readonly rejected: readonly { readonly line: string; readonly reason: string }[];
} {
	const entries: ModelGuidanceEntry[] = [];
	const rows: ModelGuidanceRow[] = [];
	const rejected: { line: string; reason: string }[] = [];
	const byModel = new Map<string, number>();

	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		// Cerca de código, cabeçalho e linha vazia não são preferências.
		if (line.length === 0 || line.startsWith('```') || line.startsWith('#')) {continue;}
		// Uma linha que não tem separador não tem campos — e uma frase de
		// conversa não deve ser lida como uma preferência vazia.
		if (!line.includes('|')) {continue;}
		const bullet = line.startsWith('- ') || line.startsWith('* ') ? line.slice(2).trim() : line;
		const [modelPart, ...fieldParts] = bullet.split('|');
		const model = (modelPart ?? '').replace(/^`|`$/g, '').trim();
		if (model.length === 0 || model.length > 200) {
			rejected.push({ line, reason: 'nome do modelo ausente ou longo demais' });
			continue;
		}
		const fields: [FieldName, string][] = [];
		let unusable = false;
		for (const part of fieldParts) {
			const at = part.indexOf(':');
			if (at < 0) {
				unusable = true;
				continue;
			}
			const key = part.slice(0, at).trim().toLowerCase();
			const value = part.slice(at + 1).trim().replace(/^`|`$/g, '');
			const field = (FIELD_NAMES as Record<string, FieldName | undefined>)[key];
			// Campo desconhecido é ignorado sem invalidar a linha: a Evelyn pode
			// acrescentar uma coluna explicativa sem perder a linha inteira.
			if (field !== undefined && value.length > 0 && value !== '?') {
				fields.push([field, value]);
			}
		}
		if (unusable && fields.length === 0) {
			rejected.push({ line, reason: 'nenhum campo legível' });
			continue;
		}

		const entry: { -readonly [K in keyof ModelGuidanceEntry]: ModelGuidanceEntry[K] } = { model };
		for (const [field, value] of fields) {
			switch (field) {
				case 'tools':
				case 'reasoning':
				case 'longContext': {
					const parsed = parseBoolean(value);
					if (parsed !== undefined) {entry[field] = parsed;}
					break;
				}
				case 'value': {
					const parsed = Number.parseFloat(value.replace(',', '.'));
					if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) {entry.value = parsed;}
					break;
				}
				case 'useFor':
					entry.useFor = value.slice(0, 280);
					break;
			}
		}

		if (Object.keys(entry).length === 1) {
			rejected.push({ line, reason: 'nenhum campo reconhecido (tools, reasoning, contexto-longo, valor, uso)' });
			continue;
		}

		// Um modelo repetido: a última linha dele vence, e a anterior é
		// registrada como substituída em vez de somar campos conflitantes.
		const previous = byModel.get(model);
		if (previous !== undefined) {
			entries[previous] = entry as ModelGuidanceEntry;
			rows[previous] = { model, fields, line };
		} else {
			byModel.set(model, entries.length);
			entries.push(entry as ModelGuidanceEntry);
			rows.push({ model, fields, line });
		}
	}

	return { entries, rows, rejected };
}

function parseBoolean(value: string): boolean | undefined {
	const normalized = value.trim().toLowerCase();
	if (['sim', 's', 'true', 'yes', 'y', '1'].includes(normalized)) {return true;}
	if (['nao', 'não', 'n', 'false', 'no', '0'].includes(normalized)) {return false;}
	return undefined;
}

/**
 * A entrada de um modelo, quando a Evelyn falou dele.
 *
 * O casamento é pelo nome exato que ela escreveu e que o provedor publicou. Um
 * nome com provedor explícito só casa naquele provedor; um nome sem provedor
 * casa no primeiro que o servir — porque foi assim que ela o nomeou.
 */
export function guidanceFor(
	guidance: ModelGuidance | undefined,
	candidate: { readonly providerId: string; readonly modelId: string },
): ModelGuidanceEntry | undefined {
	if (guidance === undefined) {return undefined;}
	return (
		guidance.entries.find(
			(entry) =>
				entry.model === candidate.modelId &&
				(entry.providerId === undefined || entry.providerId === candidate.providerId),
		) ?? undefined
	);
}
