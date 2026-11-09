/**
 * Leitura tolerante do arquivo de limites de consumo.
 *
 * Mesma política dos outros arquivos: um registro danificado custa aquele
 * registro, não todos. O que nunca é tolerado é a identidade — um limite sem
 * id derivável do escopo não pode ser editado nem removido, e é descartado.
 *
 * Nunca se inventa número: um valor negativo, não finito ou uma janela
 * desconhecida descartam o limite. Um valor `0` é mantido: "nada pode ser
 * gasto" é um limite válido e forte.
 */
import type { SpendingLimit } from './policy';
import { scopeIdFor } from './policy';

function asObject(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function timestamp(value: unknown): string | undefined {
	return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

function amount(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Um limite gravado, ou `undefined` quando algum campo essencial falta. */
export function readSpendingLimit(value: unknown): SpendingLimit | undefined {
	const candidate = asObject(value);
	if (candidate === undefined) {
		return undefined;
	}
	const currency = text(candidate['currency']);
	const amountValue = amount(candidate['amount']);
	const window = candidate['window'];
	const createdAt = timestamp(candidate['createdAt']);
	const updatedAt = timestamp(candidate['updatedAt']);
	const providerId = text(candidate['providerId']);
	const modelId = text(candidate['modelId']);
	const policy = candidate['policy'];
	const policyName: 'any' | 'free_only' | 'free_preferred' | undefined =
		policy === 'any' || policy === 'free_only' || policy === 'free_preferred' ? policy : undefined;
	if (
		currency === undefined ||
		amountValue === undefined ||
		(window !== 'day' && window !== 'month') ||
		createdAt === undefined ||
		updatedAt === undefined
	) {
		return undefined;
	}
	// A política restritiva é um campo que o arquivo pode ter sido editado
	// para fora do vocabulário: um limite com uma política desconhecida não
	// pode ser avaliado, e é descartado como um registro danificado.
	if (
		policy !== undefined &&
		policyName === undefined
	) {
		return undefined;
	}
	// Um modelo sem provedor não tem escopo: o par é a identidade do modelo, e
	// um recorte só por modelo confundiria dois provedores que o publicam.
	if (modelId !== undefined && providerId === undefined) {
		return undefined;
	}
	const scope = {
		...(providerId !== undefined ? { providerId } : {}),
		...(modelId !== undefined ? { modelId } : {}),
		...(policyName !== undefined ? { policy: policyName } : {}),
	};
	// O id é derivado do escopo. Um id gravado que discorda dele é um arquivo
	// editado à mão; aceitá-lo criaria um limite que "salvar o mesmo escopo"
	// nunca alcançaria.
	return {
		limitId: scopeIdFor(scope),
		...scope,
		currency,
		amount: amountValue,
		window,
		createdAt,
		updatedAt,
	};
}

/** Abre o arquivo inteiro. Devolve `undefined` quando o JSON nem é um objeto. */
export function parseSpendingLimits(raw: string): readonly SpendingLimit[] {
	let payload: unknown;
	try {
		payload = JSON.parse(raw);
	} catch {
		return [];
	}
	const root = asObject(payload);
	if (root === undefined) {
		return [];
	}
	const list = root['limits'];
	if (!Array.isArray(list)) {
		return [];
	}
	const seen = new Map<string, SpendingLimit>();
	for (const entry of list) {
		const limit = readSpendingLimit(entry);
		// O primeiro registro de um escopo vence: dois tetos para a mesma coisa
		// são um arquivo inconsistente, e o último lido não é mais verdadeiro
		// que o primeiro.
		if (limit !== undefined && !seen.has(limit.limitId)) {
			seen.set(limit.limitId, limit);
		}
	}
	return [...seen.values()];
}
