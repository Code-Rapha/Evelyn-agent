/**
 * As ações do OpenCode na interface web.
 *
 * ## O que chega, o que fica
 *
 * No modo manual a senha chega no corpo do `POST`, vai para o gerenciador e
 * **não volta**: as respostas são o `OpencodeState` e o catálogo validado,
 * que não têm campo de senha por construção. Nada aqui a grava, a loga ou a
 * repete numa mensagem de erro.
 *
 * ## O que a página **não** pode mandar
 *
 * Nenhum comando, nenhum caminho, nenhum binário e **nenhum endereço para a
 * descoberta**: o corpo do modo manual aceita só endereço e senha, e o do
 * catálogo não aceita nada. O processo nasce com argumentos fixos e a
 * descoberta usa a base que o gerenciador validou.
 *
 * ## Por que `starting` é devolvido antes de esperar
 *
 * Subir um processo leva segundos. O `POST` espera o resultado — o health tem
 * prazo e limite de tentativas —, mas a interface recebe `starting` em
 * `GET /api/opencode/status` enquanto isso, para não parecer travada.
 */
import type { ApiReply } from './api';
import type { OpencodeActionResult, OpencodeManager } from '../app/opencodeManager';
import type { OpencodeCatalogService } from '../app/opencodeCatalogService';

/** O que a página manda conectar. */
interface ManualInput {
	readonly baseUrl: string;
	readonly password: string;
}

/** Lê o corpo do modo manual: só endereço e senha. */
function parseManualInput(value: unknown): ManualInput {
	if (typeof value !== 'object' || value === null) {
		throw new Error('informe o endereço e a senha do servidor');
	}
	const input = value as Record<string, unknown>;
	const baseUrl = typeof input['baseUrl'] === 'string' ? input['baseUrl'].trim() : '';
	const password = typeof input['password'] === 'string' ? input['password'] : '';
	if (baseUrl.length === 0) {
		throw new Error('informe o endereço do servidor OpenCode');
	}
	// Só campos conhecidos: um `command`, um `binary` ou um `shell` no corpo
	// é recusado, e não ignorado.
	for (const key of Object.keys(input)) {
		if (key !== 'baseUrl' && key !== 'password') {
			throw new Error(`o campo "${key}" não é aceito nesta conexão`);
		}
	}
	if (password.length === 0) {
		throw new Error('informe a senha do servidor OpenCode (o OPENCODE_SERVER_PASSWORD dele)');
	}
	return { baseUrl, password };
}

/** A resposta de uma ação, a partir do desfecho do gerenciador. */
function reply(result: OpencodeActionResult): ApiReply {
	// `200` quando chegou ao estado pedido; `409` quando o servidor disse não.
	// O estado vai nos dois casos — é ele que a página mostra.
	return { status: result.done ? 200 : 409, body: { state: result.state } };
}

/**
 * As ações: conectar (automático e manual), desconectar, verificar e atualizar
 * o catálogo.
 *
 * Cada método devolve `ApiReply` e nunca lança um erro cru: um corpo inválido
 * é `400` com a razão; uma falha do servidor é um estado, não um `500`.
 */
export class OpencodeWrites {
	constructor(
		private readonly manager: OpencodeManager | undefined,
		private readonly catalog?: OpencodeCatalogService,
	) {}

	/** O estado atual, sem rede e sem subir processo, e o catálogo gravado. */
	async status(): Promise<ApiReply> {
		if (this.manager === undefined) {
			return { status: 404, body: { error: 'o gerenciador do OpenCode não existe neste host' } };
		}
		const [state, catalog] = await Promise.all([
			this.manager.status(),
			this.catalog?.state() ?? Promise.resolve({ state: 'never' as const }),
		]);
		return { status: 200, body: { state, catalog } };
	}

	/**
	 * O modo automático. Corpo nenhum: a porta sai do sistema e a senha é
	 * gerada aqui — aceitar uma porta ou uma senha da página seria o mesmo que
	 * deixar a página escolher como o processo nasce.
	 */
	async connectManaged(body: unknown): Promise<ApiReply> {
		if (this.manager === undefined) {
			return { status: 404, body: { error: 'o gerenciador do OpenCode não existe neste host' } };
		}
		if (body !== undefined && body !== null && typeof body === 'object' && Object.keys(body).length > 0) {
			return { status: 400, body: { error: 'o modo automático não aceita parâmetros' } };
		}
		return reply(await this.manager.connectManaged());
	}

	/** O modo manual: endereço e senha de um servidor que o usuário já subiu. */
	async connectManual(body: unknown): Promise<ApiReply> {
		if (this.manager === undefined) {
			return { status: 404, body: { error: 'o gerenciador do OpenCode não existe neste host' } };
		}
		let input: ManualInput;
		try {
			input = parseManualInput(body);
		} catch (error) {
			return { status: 400, body: { error: error instanceof Error ? error.message : String(error) } };
		}
		return reply(await this.manager.connectManual(input));
	}

	/** Desconecta; encerra só o processo que a Evelyn iniciou. */
	async disconnect(): Promise<ApiReply> {
		if (this.manager === undefined) {
			return { status: 404, body: { error: 'o gerenciador do OpenCode não existe neste host' } };
		}
		return reply(await this.manager.disconnect());
	}

	/** Consulta o health do que está conectado. */
	async check(): Promise<ApiReply> {
		if (this.manager === undefined) {
			return { status: 404, body: { error: 'o gerenciador do OpenCode não existe neste host' } };
		}
		return reply(await this.manager.check());
	}

	/**
	 * Atualiza o catálogo de modelos.
	 *
	 * Não aceita corpo: a única coisa que a página escolhe é **quando**
	 * perguntar. O endereço é o da conexão viva; a rota é a do serviço.
	 */
	async refreshCatalog(body: unknown): Promise<ApiReply> {
		if (this.catalog === undefined) {
			return { status: 404, body: { error: 'a descoberta do catálogo OpenCode não existe neste host' } };
		}
		if (body !== undefined && body !== null && typeof body === 'object' && Object.keys(body).length > 0) {
			return { status: 400, body: { error: 'a atualização do catálogo não aceita parâmetros' } };
		}
		const result = await this.catalog.refresh();
		return { status: result.done ? 200 : 409, body: { state: result.state } };
	}
}

/** As ações que a página pode chamar, por caminho. */
export const OPENCODE_WRITE_METHODS = {
	'/api/opencode/connect-managed': 'connectManaged',
	'/api/opencode/connect-manual': 'connectManual',
	'/api/opencode/disconnect': 'disconnect',
	'/api/opencode/check': 'check',
	'/api/opencode/catalog/refresh': 'refreshCatalog',
} as const satisfies Readonly<Record<string, keyof OpencodeWrites>>;

/** O estado, por `GET`. */
export const OPENCODE_STATUS_ROUTE = '/api/opencode/status';
