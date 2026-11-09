/**
 * O catálogo de modelos do OpenCode: o que se lê de `/api/model`, e o que se
 * recusa.
 *
 * ## Por que `/api/model` e não `/api/provider`
 *
 * Na versão instalada (1.18.34), `/api/provider` lista **provedores** com o
 * bloco técnico `api` e `request` — nada de `models`, e nenhum campo
 * `connected`. A lista de modelos vive em `/api/model`, como itens planos com
 * `providerID` e `id`. É a rota verificada na Fase 4B, sem campo com aparência
 * de credencial, protegida pela mesma senha (401 sem ela).
 *
 * O módulo **não** presume esse formato em outra versão: se a forma mudar —
 * ou se aparecer um campo de credencial — a descoberta para com um erro dito,
 * em vez de "tentar outra rota".
 *
 * ## O que não se inventa
 *
 * O OpenCode publica preço, limite e capacidades. Nada disso é copiado para a
 * Evelyn: ela não os usa, não os verifica e não tem como garantir a mesma
 * semântica (o custo do OpenCode pode ser de assinatura, e o preço de um
 * backend externo não é o preço que o app mede). O que se guarda de cada
 * modelo é o que o app precisa para **listar e identificar**: provedor, id,
 * nome, família, status e se o servidor o aceita.
 *
 * ## O id composto
 *
 * O id que o OpenCode publica pode repetir entre provedores
 * (`openrouter/recursive/flint-v1.0:free` tem barras). Por isso a chave é
 * sempre `${providerID}/${id}` — o par, não o id solto.
 */

/** O estado de um modelo no catálogo do OpenCode. */
export type OpencodeModelStatus = 'active' | 'deprecated' | 'unknown';

/** Um modelo, como se lê de `/api/model`. */
export interface OpencodeCatalogModel {
	/** O provedor, exatamente como o servidor publicou. */
	readonly providerId: string;
	/** O id, exatamente como o servidor publicou. */
	readonly modelId: string;
	readonly name?: string;
	readonly family?: string;
	/** `active`, `deprecated`, ou desconhecido — o que o servidor disse. */
	readonly status: OpencodeModelStatus;
	/** O servidor disse que este modelo está habilitado. Ausente = não disse. */
	readonly enabled?: boolean;
}

/** Um provedor, como aparece no catálogo. */
export interface OpencodeCatalogProvider {
	readonly id: string;
	readonly name?: string;
	/** Quantos modelos o servidor publicou para ele. */
	readonly modelCount: number;
	/**
	 * O servidor se declara conectado para ele?
	 *
	 * `true` só quando existe evidência: o CLI do OpenCode lista uma
	 * credencial para este provedor. `false` é o resto. O app não abre o
	 * arquivo de credenciais do OpenCode: quem responde é o CLI.
	 */
	readonly connected: boolean;
}

/** O catálogo que o app guarda. */
export interface OpencodeCatalog {
	readonly version: 1;
	/** Quando a leitura que produziu isto aconteceu (ISO-8601). */
	readonly discoveredAt: string;
	readonly providers: readonly OpencodeCatalogProvider[];
	readonly models: readonly OpencodeCatalogModel[];
}

/** Por que uma leitura não serve. */
export interface CatalogRejection {
	/** Uma frase para a interface — sem corpo cru, sem credencial. */
	readonly reason: string;
	/** O código curto, para o teste e para a página distinguirem os casos. */
	readonly code:
		| 'not-json'
		| 'unexpected-format'
		| 'sensitive-field'
		| 'too-many'
		| 'no-providers';
}

/** O resultado de ler o corpo de `/api/model`. */
export type CatalogParse =
	| { readonly ok: true; readonly models: readonly OpencodeCatalogModel[] }
	| { readonly ok: false; readonly rejection: CatalogRejection };

/** Teto de modelos aceitos numa leitura. */
export const MAX_CATALOG_MODELS = 20_000;

/**
 * Um nome de campo que não deveria existir numa lista de modelos.
 *
 * É intencionalmente largo: o custo de recusar um catálogo por um campo de
 * nome esquisito é baixo (a descoberta para e diz por quê), e o custo de
 * aceitar uma chave é o que a fase inteira tenta impedir.
 */
const SENSITIVE_FIELD = /(api[_-]?key|apikey|secret|token|password|passwd|credential|bearer|private[_-]?key|access[_-]?key|authorization)/i;

/**
 * Procura, em qualquer profundidade razoável, um campo com nome de
 * credencial. Só os **nomes** são olhados; nenhum valor é lido.
 */
export function findSensitiveField(value: unknown, depth = 0): string | undefined {
	if (depth > 6 || value === null || typeof value !== 'object') {
		return undefined;
	}
	if (Array.isArray(value)) {
		for (const item of value.slice(0, 50)) {
			const found = findSensitiveField(item, depth + 1);
			if (found !== undefined) {
				return found;
			}
		}
		return undefined;
	}
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		if (SENSITIVE_FIELD.test(key)) {
			return key;
		}
		const found = findSensitiveField(child, depth + 1);
		if (found !== undefined) {
			return found;
		}
	}
	return undefined;
}

/** A chave de um modelo: o par, nunca o id solto. */
export function catalogKey(providerId: string, modelId: string): string {
	return `${providerId}/${modelId}`;
}

function nonEmpty(value: unknown, max: number): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 && trimmed.length <= max ? trimmed : undefined;
}

/**
 * Lê o corpo de `/api/model`.
 *
 * Aceita exatamente o formato observado: um objeto com `data: [...]`, cada
 * item com `id` (string) e `providerID` (string). Qualquer outra forma é
 * recusada com o motivo — nunca interpretada "por analogia".
 */
export function parseOpencodeCatalog(body: string): CatalogParse {
	let payload: unknown;
	try {
		payload = JSON.parse(body);
	} catch {
		return { ok: false, rejection: { code: 'not-json', reason: 'a resposta do servidor não é JSON' } };
	}
	if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
		return {
			ok: false,
			rejection: { code: 'unexpected-format', reason: 'a resposta do servidor não é um objeto com "data"' },
		};
	}
	const data = (payload as Record<string, unknown>)['data'];
	if (!Array.isArray(data)) {
		return {
			ok: false,
			rejection: {
				code: 'unexpected-format',
				reason: 'a resposta do servidor não tem a lista "data" de modelos — este formato não é o conhecido',
			},
		};
	}
	// Um campo de credencial em **qualquer** posição derruba a leitura inteira:
	// um formato que traga chave não é o que o app aceita.
	const sensitive = findSensitiveField(payload);
	if (sensitive !== undefined) {
		return {
			ok: false,
			rejection: {
				code: 'sensitive-field',
				reason: `a resposta do servidor traz um campo de credencial ("${sensitive}"); o catálogo não foi lido`,
			},
		};
	}
	if (data.length > MAX_CATALOG_MODELS) {
		return {
			ok: false,
			rejection: {
				code: 'too-many',
				reason: `o servidor publicou ${data.length} modelos, acima do teto de ${MAX_CATALOG_MODELS}`,
			},
		};
	}
	if (data.length === 0) {
		return { ok: false, rejection: { code: 'no-providers', reason: 'o servidor não publicou nenhum modelo' } };
	}

	const models: OpencodeCatalogModel[] = [];
	const seen = new Set<string>();
	for (const item of data) {
		if (item === null || typeof item !== 'object') {
			return {
				ok: false,
				rejection: { code: 'unexpected-format', reason: 'a lista do servidor tem um item que não é um modelo' },
			};
		}
		const record = item as Record<string, unknown>;
		const providerId = nonEmpty(record['providerID'], 200);
		const modelId = nonEmpty(record['id'], 400);
		if (providerId === undefined || modelId === undefined) {
			return {
				ok: false,
				rejection: {
					code: 'unexpected-format',
					reason: 'a lista do servidor tem um modelo sem "providerID" ou sem "id"',
				},
			};
		}
		const key = catalogKey(providerId, modelId);
		if (seen.has(key)) {
			// O servidor repetiu o par: não se duplica.
			continue;
		}
		seen.add(key);
		const name = nonEmpty(record['name'], 300);
		const family = nonEmpty(record['family'], 200);
		const status = record['status'] === 'active' ? 'active' : record['status'] === 'deprecated' ? 'deprecated' : 'unknown';
		const enabled = typeof record['enabled'] === 'boolean' ? record['enabled'] : undefined;
		models.push({
			providerId,
			modelId,
			...(name !== undefined ? { name } : {}),
			...(family !== undefined ? { family } : {}),
			status,
			...(enabled !== undefined ? { enabled } : {}),
		});
	}
	return { ok: true, models };
}

/**
 * Agrupa modelos por provedor.
 *
 * `connectedIds` vem de fora — de quem tem evidência. Sem evidência, o
 * provedor é `connected: false`, e a página diz isso em vez de supor.
 */
export function buildProviders(
	models: readonly OpencodeCatalogModel[],
	connectedIds: ReadonlySet<string>,
	names: ReadonlyMap<string, string> = new Map(),
): readonly OpencodeCatalogProvider[] {
	const counts = new Map<string, number>();
	for (const model of models) {
		counts.set(model.providerId, (counts.get(model.providerId) ?? 0) + 1);
	}
	return [...counts.entries()]
		.map(([id, modelCount]) => ({
			id,
			...(names.get(id) !== undefined ? { name: names.get(id) } : {}),
			modelCount,
			connected: connectedIds.has(id),
		}))
		.sort((a, b) => a.id.localeCompare(b.id));
}
