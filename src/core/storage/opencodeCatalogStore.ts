/**
 * O catálogo de modelos do OpenCode, em disco.
 *
 * ## O que é guardado
 *
 * Só o que a leitura validada aceitou: provedor, id, nome, família, status e
 * o fato de o servidor o aceitar. **Nada de preço, limite, capacidade,
 * credencial ou corpo cru** — o tipo não tem campo para isso, e a leitura
 * recusa um arquivo que traga campo de credencial.
 *
 * ## Por que um arquivo próprio
 *
 * O catálogo do Core (`provider-models.json`, `state.json`) é dos provedores
 * OpenAI-compatible, e o motor de rota o lê. O OpenCode é um **backend
 * externo** que o motor ainda não sabe acionar: misturá-lo ali faria um
 * modelo aparecer como selecionável para uma execução que não existe. Um
 * arquivo separado garante que os dois catálogos não se toquem.
 *
 * ## Falhar não apaga
 *
 * `write` só substitui o arquivo com o que foi validado. Uma leitura
 * (`read`) que encontra um arquivo inválido diz `corrupt` — quem usa mantém o
 * que tem em memória, se tiver, e diz que está desatualizado.
 */
import { readFile, rm } from 'node:fs/promises';
import { writeFileAtomic } from '../../adapters/local/writeFileAtomic';
import type { OpencodeCatalog, OpencodeCatalogModel, OpencodeCatalogProvider } from '../../app/opencodeCatalog';

export const OPENCODE_CATALOG_FILE = 'opencode-catalog.json';

/** A leitura do arquivo. */
export type OpencodeCatalogRead =
	| { readonly kind: 'present'; readonly catalog: OpencodeCatalog }
	| { readonly kind: 'absent' }
	| { readonly kind: 'corrupt'; readonly reason: string };

/** A escrita. */
export type OpencodeCatalogWrite =
	| { readonly kind: 'written' }
	| { readonly kind: 'failed'; readonly message: string };

const SENSITIVE_FIELD = /(api[_-]?key|apikey|secret|token|password|passwd|credential|bearer|private[_-]?key|access[_-]?key|authorization)/i;

/** Lê um catálogo gravado; `undefined` quando a forma não é a conhecida. */
export function parseStoredCatalog(raw: string): OpencodeCatalog | undefined {
	let payload: unknown;
	try {
		payload = JSON.parse(raw.replace(/^\uFEFF/, ''));
	} catch {
		throw new Error('o catálogo do OpenCode não é JSON válido');
	}
	if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
		throw new Error('o catálogo do OpenCode não é um objeto');
	}
	const record = payload as Record<string, unknown>;
	if (record['version'] !== 1) {
		throw new Error('o catálogo do OpenCode tem uma versão desconhecida');
	}
	if (typeof record['discoveredAt'] !== 'string' || Number.isNaN(Date.parse(record['discoveredAt']))) {
		throw new Error('o catálogo do OpenCode não tem data de descoberta');
	}
	const providers = record['providers'];
	const models = record['models'];
	if (!Array.isArray(providers) || !Array.isArray(models)) {
		throw new Error('o catálogo do OpenCode não tem provedores e modelos');
	}
	// Um campo de credencial gravado por engano derruba a leitura inteira.
	const deep = findSensitive(payload, 0);
	if (deep !== undefined) {
		throw new Error(`o catálogo do OpenCode tem um campo de credencial ("${deep}")`);
	}
	return {
		version: 1,
		discoveredAt: record['discoveredAt'],
		...(typeof record['serverVersion'] === 'string' ? { serverVersion: record['serverVersion'] } : {}),
		providers: providers.filter(isProvider).slice(0, 5_000),
		models: models.filter(isModel).slice(0, 20_000),
	};
}

function findSensitive(value: unknown, depth: number): string | undefined {
	if (depth > 6 || value === null || typeof value !== 'object') {
		return undefined;
	}
	if (Array.isArray(value)) {
		for (const item of value.slice(0, 20)) {
			const found = findSensitive(item, depth + 1);
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
		const found = findSensitive(child, depth + 1);
		if (found !== undefined) {
			return found;
		}
	}
	return undefined;
}

function isProvider(value: unknown): value is OpencodeCatalogProvider {
	if (value === null || typeof value !== 'object') {
		return false;
	}
	const record = value as Record<string, unknown>;
	return (
		typeof record['id'] === 'string' &&
		typeof record['modelCount'] === 'number' &&
		typeof record['connected'] === 'boolean'
	);
}

function isModel(value: unknown): value is OpencodeCatalogModel {
	if (value === null || typeof value !== 'object') {
		return false;
	}
	const record = value as Record<string, unknown>;
	return typeof record['providerId'] === 'string' && typeof record['modelId'] === 'string';
}

/** A forma gravada. */
export function serializeCatalog(catalog: OpencodeCatalog): string {
	return `${JSON.stringify(catalog, null, 2)}\n`;
}

/** Lê e grava o catálogo. */
export class OpencodeCatalogStore {
	constructor(private readonly filePath: string) {}

	async read(): Promise<OpencodeCatalogRead> {
		let raw: string;
		try {
			raw = await readFile(this.filePath, 'utf8');
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message.includes('ENOENT')) {
				return { kind: 'absent' };
			}
			return { kind: 'corrupt', reason: `o catálogo do OpenCode não pôde ser lido (${message})` };
		}
		try {
			const catalog = parseStoredCatalog(raw);
			if (catalog === undefined) {
				return { kind: 'corrupt', reason: 'o catálogo do OpenCode não é válido' };
			}
			return { kind: 'present', catalog };
		} catch (error) {
			return {
				kind: 'corrupt',
				reason: error instanceof Error ? error.message : 'o catálogo do OpenCode não é válido',
			};
		}
	}

	async write(catalog: OpencodeCatalog): Promise<OpencodeCatalogWrite> {
		const serialized = serializeCatalog(catalog);
		try {
			await writeFileAtomic(this.filePath, serialized);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { kind: 'failed', message: `o catálogo do OpenCode não pôde ser gravado (${message})` };
		}
		// Gravar não é acreditar: lê de volta e compara.
		try {
			const written = await readFile(this.filePath, 'utf8');
			if (written !== serialized) {
				return { kind: 'failed', message: 'o catálogo do OpenCode não corresponde ao que foi gravado' };
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { kind: 'failed', message: `o catálogo do OpenCode não pôde ser lido de volta (${message})` };
		}
		return { kind: 'written' };
	}

	async clear(): Promise<void> {
		await rm(this.filePath, { force: true });
	}
}
