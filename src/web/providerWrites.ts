/**
 * As escritas de provider da interface web.
 *
 * ## O que entra e o que nunca sai
 *
 * A chave chega no corpo do `POST` e vai **direto** para o `SecretStore`,
 * dentro de `ChatSession.saveProvider` — o único lugar que a lê. Nada nesta
 * camada a guarda, a loga ou a devolve: as respostas são as mesmas visões
 * (`ProviderSummary`) que a janela do desktop usa, e elas carregam só
 * `hasApiKeyRef`.
 *
 * ## A validação é a do contrato
 *
 * `parseSaveProviderInput` e `parseProviderId` são os mesmos parsers que o
 * preload do Electron aplica. Uma segunda validação aqui só criaria duas
 * regras para a mesma coisa.
 *
 * ## Testar a conexão
 *
 * É a mesma chamada que o desktop faz para preencher o seletor de modelos
 * (`listModels`): pergunta ao endpoint pelos modelos publicados. Se responder,
 * a conexão existe e a chave serve; se não, o erro é o do endpoint. Não há
 * simulação: um endpoint fora do ar é um teste que falha.
 */
import { parseProviderId, parseSaveProviderInput, toDisplayMessage } from '../desktop/contract';
import type { AssembledCore } from '../app/assemble';
import type { ApiReply } from './api';

/** O corpo de um pedido de teste, uma vez validado. */
interface TestTarget {
	/** Um provedor já gravado — o teste usa a chave que está no SecretStore. */
	readonly providerId?: string;
	/** Ou um endereço ainda não gravado, com a chave que veio no corpo. */
	readonly baseUrl?: string;
	readonly apiKey?: string;
}

/**
 * O resultado de um teste de conexão.
 *
 * `models` é a resposta real do endpoint, quando ele respondeu; ausente
 * quando falhou. Nunca há uma lista de exemplo.
 */
export interface ConnectionTestResult {
	readonly ok: boolean;
	/** Quantos modelos o endpoint publicou. */
	readonly modelCount?: number;
	/** Os primeiros nomes, para o usuário reconhecer o servidor. */
	readonly models?: readonly string[];
	/** A recusa, quando não respondeu. */
	readonly error?: string;
}

/** Lê o alvo de um teste. */
function parseTestTarget(value: unknown): TestTarget {
	if (typeof value !== 'object' || value === null) {
		throw new Error('o teste de conexão precisa de um providerId ou de um baseUrl');
	}
	const input = value as Record<string, unknown>;
	const providerId = typeof input['providerId'] === 'string' ? input['providerId'] : undefined;
	const baseUrl = typeof input['baseUrl'] === 'string' ? input['baseUrl'] : undefined;
	const apiKey = typeof input['apiKey'] === 'string' ? input['apiKey'] : undefined;
	if (providerId === undefined && (baseUrl === undefined || baseUrl.trim().length === 0)) {
		throw new Error('o teste de conexão precisa de um providerId ou de um baseUrl');
	}
	return {
		...(providerId !== undefined ? { providerId } : {}),
		...(baseUrl !== undefined ? { baseUrl } : {}),
		...(apiKey !== undefined && apiKey.length > 0 ? { apiKey } : {}),
	};
}

/** O id temporário de um endpoint que ainda não foi gravado. */
const UNSAVED_TEST_ID = '__connection-test__';

/**
 * As escritas de provider, atrás da mesma sessão e do mesmo Core.
 *
 * Cada método devolve `ApiReply` e **nunca** lança: uma recusa do Core é um
 * `400` com a mensagem dele, e é isso que a página mostra.
 */
export class ProviderWrites {
	constructor(private readonly core: AssembledCore | undefined) {}

	/** Monta o Core ou explica por que não há. */
	private requireCore(): ApiReply | undefined {
		if (this.core === undefined) {
			return { status: 404, body: { error: 'o Core não está montado neste host' } };
		}
		return undefined;
	}

	/** Cria ou atualiza um provedor. A chave, quando vem, vai para o SecretStore. */
	async save(body: unknown): Promise<ApiReply> {
		const missing = this.requireCore();
		if (missing !== undefined) {
			return missing;
		}
		const core = this.core as AssembledCore;
		let input;
		try {
			input = parseSaveProviderInput(body);
		} catch (error) {
			return { status: 400, body: { error: toDisplayMessage(error, 'campos inválidos') } };
		}

		// Atualizar exige o id: sem ele, a sessão derivaria um do endereço e
		// criaria um segundo provedor em vez de editar o primeiro.
		if (input.id !== undefined) {
			const existing = core.chat.listProviders().find((provider) => provider.id === input.id);
			if (existing === undefined) {
				return { status: 404, body: { error: `não há provedor "${input.id}"` } };
			}
		}

		try {
			const saved = await core.chat.saveProvider(input);
			return { status: 200, body: saved };
		} catch (error) {
			// A mensagem do Core é a explicação; nada nela vem da chave.
			return { status: 400, body: { error: toDisplayMessage(error, 'não foi possível salvar') } };
		}
	}

	/** Liga ou desliga uma conexão. */
	async setEnabled(body: unknown): Promise<ApiReply> {
		const missing = this.requireCore();
		if (missing !== undefined) {
			return missing;
		}
		const core = this.core as AssembledCore;
		const input = readObject(body);
		if (input === undefined || typeof input['providerId'] !== 'string' || typeof input['enabled'] !== 'boolean') {
			return { status: 400, body: { error: 'esperado { providerId, enabled }' } };
		}
		try {
			const summary = await core.chat.setProviderEnabled(input['providerId'], input['enabled']);
			return { status: 200, body: summary };
		} catch (error) {
			return { status: 400, body: { error: toDisplayMessage(error, 'não foi possível mudar o estado') } };
		}
	}

	/** Promove a roteador ou volta a classificar como provedor. */
	async setRole(body: unknown): Promise<ApiReply> {
		const missing = this.requireCore();
		if (missing !== undefined) {
			return missing;
		}
		const core = this.core as AssembledCore;
		const input = readObject(body);
		const role = input?.['role'];
		if (input === undefined || typeof input['providerId'] !== 'string' || (role !== 'router' && role !== 'provider')) {
			return { status: 400, body: { error: 'esperado { providerId, role }' } };
		}
		try {
			const summary = await core.chat.setProviderRole(input['providerId'], role);
			return { status: 200, body: summary };
		} catch (error) {
			return { status: 400, body: { error: toDisplayMessage(error, 'não foi possível mudar o papel') } };
		}
	}

	/** Remove o provedor e a chave por trás dele. */
	async remove(body: unknown): Promise<ApiReply> {
		const missing = this.requireCore();
		if (missing !== undefined) {
			return missing;
		}
		const core = this.core as AssembledCore;
		let providerId: string;
		try {
			providerId = parseProviderId(readObject(body)?.['providerId']);
		} catch (error) {
			return { status: 400, body: { error: toDisplayMessage(error, 'providerId inválido') } };
		}
		try {
			const removed = await core.chat.removeProvider(providerId);
			return removed
				? { status: 200, body: { removed: true } }
				: { status: 404, body: { error: `não há provedor "${providerId}"` } };
		} catch (error) {
			return { status: 400, body: { error: toDisplayMessage(error, 'não foi possível remover') } };
		}
	}

	/**
	 * Testa a conexão de um provedor gravado, ou de um endereço ainda não
	 * gravado.
	 *
	 * Para um endereço novo, a configuração é salva e testada na mesma
	 * chamada — a única forma honesta de testar é pela mesma máquina que vai
	 * falar com ele. Se o teste falhar, o provedor **não** fica gravado: a
	 * remoção desfaz o que a tentativa criou, e a chave vai junto.
	 */
	async test(body: unknown): Promise<ApiReply> {
		const missing = this.requireCore();
		if (missing !== undefined) {
			return missing;
		}
		const core = this.core as AssembledCore;
		let target: TestTarget;
		try {
			target = parseTestTarget(body);
		} catch (error) {
			return { status: 400, body: { error: toDisplayMessage(error, 'pedido inválido') } };
		}

		// Um endpoint já gravado: a chave que está no SecretStore é a que se usa.
		if (target.providerId !== undefined) {
			const provider = core.chat.listProviders().find((entry) => entry.id === target.providerId);
			if (provider === undefined) {
				return { status: 404, body: { error: `não há provedor "${target.providerId}"` } };
			}
			return { status: 200, body: await probe(core, target.providerId) };
		}

		// Um endereço novo: salva, testa, e desfaz se o teste falhar.
		let created;
		try {
			created = await core.chat.saveProvider({
				id: UNSAVED_TEST_ID,
				name: 'teste de conexão',
				baseUrl: (target.baseUrl ?? '').trim(),
				...(target.apiKey !== undefined ? { apiKey: target.apiKey } : {}),
			});
		} catch (error) {
			return { status: 400, body: { error: toDisplayMessage(error, 'não foi possível testar') } };
		}
		const result = await probe(core, created.id);
		// Sempre desfaz: um teste não deixa configuração para trás.
		await core.chat.removeProvider(created.id).catch(() => undefined);
		return { status: 200, body: result };
	}
}

/**
 * Pergunta ao endpoint pelos modelos publicados.
 *
 * `listModels` já trata o caso de a listagem falhar; aqui qualquer erro vira
 * um resultado com `ok: false` e a mensagem do Core — sem inventar modelos.
 */
async function probe(core: AssembledCore, providerId: string): Promise<ConnectionTestResult> {
	try {
		const models = await core.chat.listModels(providerId);
		return {
			ok: true,
			modelCount: models.length,
			models: models.slice(0, 20),
		};
	} catch (error) {
		return { ok: false, error: toDisplayMessage(error, 'o endpoint não respondeu') };
	}
}

/** O corpo, quando é um objeto. */
function readObject(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return undefined;
	}
	return value as Record<string, unknown>;
}
