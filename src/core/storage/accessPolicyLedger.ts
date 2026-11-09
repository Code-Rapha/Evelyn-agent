/**
 * Onde a política de acesso e a escolha da fonte de preço são guardadas.
 *
 * ## Por que um arquivo só para isso
 *
 * `models.json` guarda o que o usuário **declarou sobre um modelo** — preço,
 * limites, notas —, e a fusão desta etapa nunca o reescreve. Este arquivo
 * guarda **duas decisões de seleção** que valem para a sessão inteira:
 *
 * - qual política de acesso se aplica (`any`, `free_only`, `free_preferred`);
 * - de que lado o preço vale (`user` ou `discovered`).
 *
 * Separá-las é o que torna "voltar ao meu preço" uma linha: o preço declarado
 * continua intacto em `models.json`, e trocar `priceSource` de volta é tudo o
 * que é preciso. Se a escolha vivesse dentro do registro do modelo, voltar
 * atrás dependeria de lembrar o valor anterior — que é exatamente o dado que
 * uma sobrescrita silenciosa teria apagado.
 *
 * ## Leitura tolerante
 *
 * Arquivo ausente é o padrão (`any` + preço do usuário). Um valor inválido cai
 * no padrão **do seu campo**, não no de outro: uma política desconhecida não
 * desfaz a escolha de preço, e vice-versa.
 */
import type {
	ModelAccessPolicy,
	ModelAccessPolicyRecord,
} from '../catalog/policy';

export const POLICY_FILE_VERSION = 1;

const DEFAULT_SOURCE: ModelAccessPolicyRecord = {
	policy: 'any',
	priceSource: 'user',
	limitsSource: 'user',
	capabilitiesSource: 'user',
	updatedAt: new Date(0).toISOString(),
	changedBy: 'user',
};

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPolicy(value: unknown): value is ModelAccessPolicy {
	return value === 'any' || value === 'free_only' || value === 'free_preferred';
}

/**
 * Lê o registro da política.
 *
 * Sem arquivo (`undefined`/vazio) devolve `undefined`: a sessão distingue
 * "nunca configurado" de "configurado como o padrão", porque a primeira
 * ocasião em que o usuário liga `free_only` e liga de novo não deve aparecer
 * como "voltou ao padrão por conta própria".
 */
export function parseAccessPolicy(raw: string | undefined): ModelAccessPolicyRecord | undefined {
	if (raw === undefined || raw.trim().length === 0) {
		return undefined;
	}
	let payload: unknown;
	try {
		payload = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!isObject(payload)) {
		return undefined;
	}
	const policy = isPolicy(payload['policy']) ? payload['policy'] : DEFAULT_SOURCE.policy;
	const side = (value: unknown): 'user' | 'discovered' =>
		value === 'discovered' ? 'discovered' : DEFAULT_SOURCE.priceSource;
	const priceSource = side(payload['priceSource']);
	const limitsSource = side(payload['limitsSource']);
	const capabilitiesSource = side(payload['capabilitiesSource']);
	const updatedAt =
		typeof payload['updatedAt'] === 'string' && !Number.isNaN(Date.parse(payload['updatedAt']))
			? payload['updatedAt']
			: DEFAULT_SOURCE.updatedAt;
	const changedBy = payload['changedBy'] === 'phrase' ? 'phrase' : 'user';
	return { policy, priceSource, limitsSource, capabilitiesSource, updatedAt, changedBy };
}

/** A forma gravada. Sem segredo: três palavras e uma data. */
export function serializeAccessPolicy(record: ModelAccessPolicyRecord): string {
	return `${JSON.stringify(
		{
			version: POLICY_FILE_VERSION,
			policy: record.policy,
			priceSource: record.priceSource,
			limitsSource: record.limitsSource,
			capabilitiesSource: record.capabilitiesSource,
			updatedAt: record.updatedAt,
			changedBy: record.changedBy,
		},
		null,
		2,
	)}\n`;
}
