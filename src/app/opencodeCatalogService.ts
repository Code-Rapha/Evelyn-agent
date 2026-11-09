/**
 * A descoberta do catálogo do OpenCode: uma pergunta, uma resposta, um
 * registro.
 *
 * ## A ordem, e por que ela não é negociável
 *
 * 1. **Existe conexão?** Sem uma conexão viva do gerenciador da 4C, nada é
 *    perguntado. A descoberta não abre conexão própria nem aceita endereço.
 * 2. **O health responde?** A rota é a mesma da 4C, com a mesma senha. Um
 *    "não" (auth, rede, prazo) encerra a tentativa antes de qualquer leitura
 *    de catálogo — e a falha **não** apaga o último válido.
 * 3. **`GET /api/model`.** Uma única rota, montada sobre a base que o
 *    gerenciador validou. `401`/`403` viram `auth`.
 * 4. **Validação do corpo** (`parseOpencodeCatalog`): formato diferente, item
 *    sem `id`/`providerID`, ou **qualquer campo com aparência de credencial**
 *    encerram com erro explícito. Não há "tentar outra rota".
 *
 * Nunca se consulta `/provider` nem `/config/providers` — o módulo só conhece
 * as duas URLs que monta, literalmente.
 *
 * ## O que fica guardado
 *
 * O que a validação aceitou, e a data. Nada de preço, limite, capacidade ou
 * corpo cru. Uma falha deixa o arquivo como está; o estado em memória passa a
 * dizer que ele está **desatualizado**, com o motivo.
 */
import {
	buildProviders,
	catalogKey,
	parseOpencodeCatalog,
	type OpencodeCatalog,
	type OpencodeCatalogModel,
	type OpencodeCatalogProvider,
} from './opencodeCatalog';
import { matchConnectedProviders, type ProviderCredentialReport } from './opencodeCredentials';
import type { OpencodeManager } from './opencodeManager';

/** A rota do catálogo, na versão instalada do servidor. */
export const OPENCODE_CATALOG_PATH = '/api/model';

/** A rota do health — a mesma da 4C. */
export const OPENCODE_HEALTH_PATH = '/global/health';

/** Prazo da leitura do catálogo: ela é maior que o health. */
export const CATALOG_TIMEOUT_MS = 15_000;

/** Teto do corpo do catálogo lido. */
export const CATALOG_MAX_BYTES = 8 * 1024 * 1024;

/** A leitura HTTP injetável — nenhum teste abre socket por causa dela. */
export interface CatalogTransport {
	/** Faz o `GET`, com a autorização montada pelo chamador. */
	readonly get: (input: {
		readonly url: string;
		readonly authorization: string;
		readonly timeoutMs: number;
		readonly maxBytes: number;
	}) => Promise<{ readonly status: number; readonly body: string }>;
}

/** O registro em disco. */
export interface CatalogStore {
	read(): Promise<
		| { readonly kind: 'present'; readonly catalog: OpencodeCatalog }
		| { readonly kind: 'absent' }
		| { readonly kind: 'corrupt'; readonly reason: string }
	>;
	write(
		catalog: OpencodeCatalog,
	): Promise<{ readonly kind: 'written' } | { readonly kind: 'failed'; readonly message: string }>;
}

/** As dependências da descoberta. */
export interface OpencodeCatalogOptions {
	/** O gerenciador da 4C: a única fonte de "há conexão". */
	readonly manager: OpencodeManager;
	readonly transport: CatalogTransport;
	/** Onde o catálogo é gravado. Ausente = só em memória. */
	readonly store?: CatalogStore;
	/**
	 * Quais provedores têm credencial.
	 *
	 * Ausente = não se pergunta. Presente e devolvendo `undefined` = o CLI não
	 * respondeu, e a página diz que a conexão não pôde ser confirmada.
	 */
	readonly readCredentials?: () => Promise<ProviderCredentialReport | undefined>;
	readonly now?: () => Date;
	readonly log?: (message: string, data?: Record<string, unknown>) => void;
}

/** Por que uma descoberta não produziu catálogo agora. */
export type CatalogFailureCode =
	| 'not-connected'
	| 'auth-invalid'
	| 'unavailable'
	| 'timeout'
	| 'unexpected-format'
	| 'sensitive-field'
	| 'not-json'
	| 'too-many'
	| 'no-providers'
	| 'write-failed';

/** O estado da descoberta, como a página vê. */
export type OpencodeCatalogState =
	| { readonly state: 'never' }
	| {
			readonly state: 'ok';
			readonly catalog: OpencodeCatalog;
			/** Sempre `false` aqui: é o estado de uma leitura que acabou bem. */
			readonly stale: false;
			/** `true` quando os provedores conectados não puderam ser confirmados. */
			readonly connectionsUnknown: boolean;
	  }
	| {
			readonly state: 'stale';
			readonly catalog: OpencodeCatalog;
			readonly stale: true;
			readonly reason: string;
			readonly code: CatalogFailureCode;
			readonly failedAt: string;
			readonly connectionsUnknown: boolean;
	  }
	| { readonly state: 'failed'; readonly reason: string; readonly code: CatalogFailureCode; readonly failedAt: string };

/** O que uma tentativa responde. */
export interface CatalogRefreshResult {
	readonly done: boolean;
	readonly state: OpencodeCatalogState;
}

export class OpencodeCatalogService {
	private current: OpencodeCatalogState | undefined;
	private loading: Promise<CatalogRefreshResult> | undefined;

	constructor(private readonly options: OpencodeCatalogOptions) {}

	private get now(): Date {
		return (this.options.now ?? (() => new Date()))();
	}

	/**
	 * O estado atual, sem rede.
	 *
	 * Na primeira pergunta, o arquivo é lido uma vez. Um arquivo válido não é
	 * "atual": ele é o que sobrou da execução anterior, e a página diz isso
	 * pela data — só uma descoberta de agora o marca como atual.
	 */
	async state(): Promise<OpencodeCatalogState> {
		if (this.current !== undefined) {
			return this.current;
		}
		if (this.options.store === undefined) {
			this.current = { state: 'never' };
			return this.current;
		}
		const read = await this.options.store.read();
		if (read.kind === 'present') {
			this.current = {
				state: 'ok',
				catalog: read.catalog,
				stale: false,
				connectionsUnknown: false,
			};
			return this.current;
		}
		if (read.kind === 'corrupt') {
			this.current = {
				state: 'failed',
				code: 'unexpected-format',
				reason: read.reason,
				failedAt: this.now.toISOString(),
			};
			return this.current;
		}
		this.current = { state: 'never' };
		return this.current;
	}

	/**
	 * Pergunta ao servidor e grava o que validou.
	 *
	 * Duas chamadas simultâneas compartilham a mesma tentativa: uma interface
	 * com dois cliques não deve disparar duas leituras.
	 */
	async refresh(): Promise<CatalogRefreshResult> {
		if (this.loading !== undefined) {
			return await this.loading;
		}
		this.loading = this.refreshOnce().finally(() => {
			this.loading = undefined;
		});
		return await this.loading;
	}

	private async refreshOnce(): Promise<CatalogRefreshResult> {
		const before = await this.state();
		const connection = this.options.manager.connection();
		if (connection === undefined) {
			return this.fail(
				'not-connected',
				'não há conexão com um servidor OpenCode; conecte antes de atualizar o catálogo',
				before,
			);
		}
		const authorization = basicAuth(connection.password);
		const base = connection.baseUrl.replace(/\/+$/, '');

		// 1. O health: a mesma verificação da 4C, antes de qualquer leitura.
		const health = await this.transportCall(`${base}${OPENCODE_HEALTH_PATH}`, authorization);
		if (health.kind === 'timeout') {
			return this.fail('timeout', 'o servidor não respondeu ao health a tempo', before);
		}
		if (health.kind === 'unavailable') {
			return this.fail('unavailable', 'o servidor não respondeu ao health', before);
		}
		if (health.status === 401 || health.status === 403) {
			return this.fail('auth-invalid', 'o servidor recusou a autenticação; a conexão não está válida', before);
		}
		if (health.status < 200 || health.status >= 300) {
			return this.fail('unavailable', `o servidor respondeu ${health.status} ao health`, before);
		}

		// 2. O catálogo — a rota única.
		const answer = await this.transportCall(`${base}${OPENCODE_CATALOG_PATH}`, authorization);
		if (answer.kind === 'timeout') {
			return this.fail('timeout', 'a leitura do catálogo demorou demais', before);
		}
		if (answer.kind === 'unavailable') {
			return this.fail('unavailable', 'a leitura do catálogo falhou', before);
		}
		if (answer.status === 401 || answer.status === 403) {
			return this.fail('auth-invalid', 'o servidor recusou a autenticação ao ler o catálogo', before);
		}
		if (answer.status < 200 || answer.status >= 300) {
			return this.fail('unavailable', `o servidor respondeu ${answer.status} ao catálogo`, before);
		}

		const parsed = parseOpencodeCatalog(answer.body);
		if (!parsed.ok) {
			return this.fail(parsed.rejection.code, parsed.rejection.reason, before);
		}

		// 3. Quem tem credencial — quando o CLI responde.
		let report: ProviderCredentialReport | undefined;
		if (this.options.readCredentials !== undefined) {
			try {
				report = await this.options.readCredentials();
			} catch {
				// O CLI não respondeu: o catálogo continua, sem afirmar conexão.
			}
		}
		const providers = resolveProviders(parsed.models, report);
		const connectionsUnknown = report === undefined;

		const catalog: OpencodeCatalog = {
			version: 1,
			discoveredAt: this.now.toISOString(),
			providers,
			models: parsed.models,
		};

		if (this.options.store !== undefined) {
			const written = await this.options.store.write(catalog);
			if (written.kind === 'failed') {
				// O catálogo recém-lido não foi gravado; o anterior continua.
				return this.fail('write-failed', written.message, before);
			}
		}

		this.current = { state: 'ok', catalog, stale: false, connectionsUnknown };
		return { done: true, state: this.current };
	}

	/** O transporte, sem exceções: tudo vira uma categoria. */
	private async transportCall(
		url: string,
		authorization: string,
	): Promise<
		| { readonly kind: 'answer'; readonly status: number; readonly body: string }
		| { readonly kind: 'timeout' }
		| { readonly kind: 'unavailable' }
	> {
		try {
			const answer = await this.options.transport.get({
				url,
				authorization,
				timeoutMs: CATALOG_TIMEOUT_MS,
				maxBytes: CATALOG_MAX_BYTES,
			});
			return { kind: 'answer', status: answer.status, body: answer.body };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (/não respondeu a tempo|timed?\s?out|ETIMEDOUT|Timeout/i.test(message)) {
				return { kind: 'timeout' };
			}
			return { kind: 'unavailable' };
		}
	}

	/**
	 * Registra a falha sem apagar o que havia.
	 *
	 * `before` é o estado lido **no início** da tentativa: uma falha depois de
	 * o manager perder a conexão continua sendo sobre o catálogo que existe.
	 */
	private fail(code: CatalogFailureCode, reason: string, before?: OpencodeCatalogState): Promise<CatalogRefreshResult> {
		const failedAt = this.now.toISOString();
		// O motivo vai para o log — nunca o corpo, nunca um cabeçalho.
		this.options.log?.('OpenCode catalog refresh failed', { code });
		return this.finishFailure({ code, reason, failedAt }, before);
	}

	private async finishFailure(
		failure: { readonly code: CatalogFailureCode; readonly reason: string; readonly failedAt: string },
		before?: OpencodeCatalogState,
	): Promise<CatalogRefreshResult> {
		const previous = before ?? (await this.state());
		const { code, reason, failedAt } = failure;
		if (previous.state === 'ok' || previous.state === 'stale') {
			this.current = {
				state: 'stale',
				catalog: previous.catalog,
				stale: true,
				reason,
				code,
				failedAt,
				connectionsUnknown: previous.connectionsUnknown,
			};
			return { done: false, state: this.current };
		}
		this.current = { state: 'failed', reason, code, failedAt };
		return { done: false, state: this.current };
	}
}

/** O cabeçalho Basic do servidor. */
function basicAuth(password: string): string {
	return `Basic ${Buffer.from(`opencode:${password}`, 'utf8').toString('base64')}`;
}

/**
 * Alinha os provedores do catálogo com a evidência de credencial.
 *
 * O casamento (id, ou as formas do nome que o CLI imprime) mora em
 * `matchConnectedProviders`: aqui só se preenche os nomes conhecidos.
 */
function resolveProviders(
	models: readonly OpencodeCatalogModel[],
	report: ProviderCredentialReport | undefined,
): readonly OpencodeCatalogProvider[] {
	if (report === undefined) {
		return buildProviders(models, new Set());
	}
	const ids = [...new Set(models.map((model) => model.providerId))];
	const resolved = matchConnectedProviders(ids, report);
	return buildProviders(models, resolved, report.names);
}

/** A chave de um modelo — reexportada para a página e para o teste. */
export { catalogKey };

/** Usado só para o tipo do catálogo casar com o da página. */
export type { OpencodeCatalogModel };
