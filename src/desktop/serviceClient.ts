/**
 * O cliente HTTP do desktop para o serviço local.
 *
 * ## O que ele é nesta fase
 *
 * A **fundação**: detectar o serviço, autenticar com a credencial de leitura
 * e consultar o que já existe sem endpoint novo — saúde e catálogo de
 * modelos (`/api/overview`, `/api/models`, `/api/models/catalog`).
 *
 * Ele **não** substitui o `ChatSession`. Conversa, ferramentas, permissões,
 * streaming e cancelamento continuam no Core do próprio app. O objetivo aqui
 * é que o desktop consiga *ver* o serviço quando ele está no ar, com um
 * caminho tipado e testado para as próximas fases ampliarem.
 *
 * ## Onde ele se apoia
 *
 * Toda a confiança vem de `probeService` (R3), que já exige: `service.json`
 * válido, protocolo compatível, processo vivo e `/api/health` respondendo
 * **com a credencial do registro**, dizendo o mesmo pid e a mesma porta. O
 * cliente não repete essa lógica — repetir seria ter duas respostas para "é o
 * serviço?" e uma delas esquecida.
 *
 * ## A credencial
 *
 * Só a de **leitura** (`readerToken`). O token do painel autoriza escrita e
 * encerramento; um cliente que consulta catálogo não deve carregá-lo. As
 * requisições usam o header `x-seshyina-reader` — nunca a query, nunca o
 * cookie, nunca `Authorization` (que é do `/v1`).
 *
 * Nada aqui loga, serializa ou devolve a credencial: os erros carregam um
 * **código** e uma mensagem escrita para ser lida, e a interface só vê
 * `ServiceLinkStatus`.
 *
 * ## Quando o serviço não está lá
 *
 * O resultado é `inactive`, com o motivo. Não é um erro: é o estado normal de
 * quem abre o app sem o serviço, e o chamador deve seguir com o Core próprio.
 * O cliente **nunca** inicia o serviço — isso pertence a uma fase operacional.
 */
import { probeService, type ServiceProbe } from '../app/discoverService';
import type { ServiceRecord } from '../app/serviceRecord';
import type { ProviderSummary } from './contract';
import { parseAutoSkillStatusView, type AutoSkillStatusView } from './contract';

/** O header da credencial de leitura. */
export const READER_HEADER = 'x-seshyina-reader';

/** Por que uma consulta falhou. */
export type ServiceClientFailureCode =
	/** O serviço não está ativo. Estado normal, não erro. */
	| 'inactive'
	/** O serviço respondeu `401`/`403`: a credencial não serve. */
	| 'unauthorized'
	/** Não respondeu a tempo. */
	| 'timeout'
	/** Não foi possível conectar (caiu no meio, porta fechou). */
	| 'unreachable'
	/** Respondeu, mas o corpo não é o que o contrato promete. */
	| 'invalid-response'
	/** Respondeu um erro do servidor. */
	| 'server-error';

/**
 * O resultado de uma consulta ao serviço.
 *
 * O sucesso **não** carrega o registro do serviço. Ele contém as duas
 * credenciais, e quem consome este resultado o serializa (para um log, para a
 * interface, para uma resposta IPC). Devolver o registro "por conveniência"
 * foi exatamente como uma credencial chegou ao corpo do catálogo durante o
 * desenvolvimento desta fase.
 */
export type ServiceQuery<T> =
	| { readonly ok: true; readonly value: T }
	| {
			readonly ok: false;
			readonly code: ServiceClientFailureCode;
			/** Mensagem em português, escrita para a interface. Sem segredo. */
			readonly message: string;
	  };

/** O estado do serviço, como a interface deve mostrá-lo. */
export interface ServiceLinkStatus {
	/** `active` = conectado e consultado; `inactive` = não há serviço. */
	readonly state: 'active' | 'inactive';
	/** Por que não está ativo, quando não está. */
	readonly reason?: ServiceClientFailureCode;
	/** Uma linha para a interface, sem credencial e sem caminho de dados. */
	readonly detail: string;
	/** A porta e o pid, para depuração — não são segredo. */
	readonly port?: number;
	readonly pid?: number;
	readonly version?: string;
}

/** O catálogo, no mesmo formato que o painel expõe. */
export interface ServiceCatalog {
	/** O catálogo fundido: declarado + descoberto, com a procedência de cada lado. */
	readonly models: readonly ServiceModel[];
	readonly policy: ServiceAccessPolicy;
}

/** Uma política de acesso, como o painel a publica. */
export interface ServiceAccessPolicy {
	readonly policy: string;
	readonly priceSource: string;
	readonly limitsSource: string;
	readonly capabilitiesSource: string;
	readonly updatedAt: string;
	readonly changedBy: string;
	readonly hint: string;
}

/**
 * Um modelo, como o painel o publica.
 *
 * Deliberadamente permissivo: o cliente **não** revalida cada campo do
 * catálogo (seria uma segunda cópia da regra), mas exige a identidade —
 * `providerId` e `modelId` —, sem a qual o modelo não pode ser pedido a
 * ninguém. O resto é repassado como veio, para a interface desenhar.
 */
export interface ServiceModel {
	readonly providerId: string;
	readonly modelId: string;
	readonly listed?: boolean;
	readonly [key: string]: unknown;
}

/** O que o cliente precisa do mundo — injetável nos testes. */
export interface ServiceClientOptions {
	/** A raiz de dados onde o `service.json` mora. */
	readonly root: string;
	/** O `fetch` a usar. Padrão: o global. */
	readonly fetch?: typeof fetch;
	/** O prazo de uma consulta. Padrão: 5s. */
	readonly timeoutMs?: number;
	/** A descoberta, injetável para o teste não precisar de socket. */
	readonly probe?: (options: { readonly root: string }) => Promise<ServiceProbe>;
}

/** O prazo padrão de uma consulta ao serviço. */
export const DEFAULT_QUERY_TIMEOUT_MS = 5_000;

/**
 * O cliente.
 *
 * Uma instância por host é o suficiente: ela não guarda conexão nem estado
 * entre chamadas — só o que precisa para falar com o serviço.
 */
export class ServiceClient {
	constructor(private readonly options: ServiceClientOptions) {}

	/**
	 * Conecta: descobre o serviço e confirma que ele responde à credencial de
	 * leitura.
	 *
	 * A confirmação é o próprio `/api/overview` — uma chamada de leitura que
	 * devolve algo curto. Se ele falhar por credencial, o serviço existe mas
	 * não nos aceita; se falhar por rede, existe e caiu no meio.
	 */
	/**
	 * O registro do serviço, quando ele está ativo (R4S).
	 *
	 * É a única parte que os clientes de conversa precisam da descoberta: o
	 * endereço e as credenciais. Público para um cliente com descoberta
	 * injetada (teste, host com outro transporte) usar o **mesmo** caminho.
	 */
	async record(): Promise<ServiceRecord | undefined> {
		const probe = await (this.options.probe ?? probeService)({ root: this.options.root });
		return probe.kind === 'active' ? probe.record : undefined;
	}

	async connect(): Promise<
		| {
				readonly ok: true;
				/** O que o agente pode saber do serviço: nada de credencial. */
				readonly service: ServiceIdentity;
				readonly overview: ServiceOverview;
		  }
		| { readonly ok: false; readonly code: ServiceClientFailureCode; readonly message: string }
	> {
		const probe = await (this.options.probe ?? probeService)({ root: this.options.root });
		if (probe.kind !== 'active') {
			return { ok: false, code: 'inactive', message: inactiveDetail(probe) };
		}
		const overview = await this.query<ServiceOverview>(probe.record, '/api/overview', parseOverview);
		if (!overview.ok) {
			return { ok: false, code: overview.code, message: overview.message };
		}
		return { ok: true, service: identityOf(probe.record), overview: overview.value };
	}

	/**
	 * O estado, para a interface exibir.
	 *
	 * Nunca lança: o desktop precisa desenhar a tela mesmo quando o serviço
	 * está no meio de um encerramento.
	 */
	async status(): Promise<ServiceLinkStatus> {
		const connected = await this.connect();
		if (!connected.ok) {
			return {
				state: 'inactive',
				reason: connected.code,
				detail: connected.message,
			};
		}
		return {
			state: 'active',
			detail: 'conectado ao serviço local',
			port: connected.service.port,
			pid: connected.service.pid,
			version: connected.service.appVersion,
		};
	}

	/**
	 * Os provedores **do serviço**, com o catálogo fundido (DEV-8.15).
	 *
	 * Usa `GET /api/providers`, que já existia (leitura autenticada). O
	 * `ProviderSummary` publicado não traz chave: o segredo continua no
	 * `SecretStore` do serviço, e `hasApiKeyRef` é só um booleano.
	 */
	async providers(): Promise<ServiceQuery<ServiceProviders>> {
		const probe = await (this.options.probe ?? probeService)({ root: this.options.root });
		if (probe.kind !== 'active') {
			return { ok: false, code: 'inactive', message: inactiveDetail(probe) };
		}
		return await this.query<ServiceProviders>(probe.record, '/api/providers', parseProviders);
	}

	/**
	 * Cria, atualiza ou remove um provedor **no serviço**.
	 *
	 * Escrita: usa a credencial de **painel**, como a gravação do roteador.
	 * `apiKey` vazia apaga a chave; omitida, mantém a existente — o mesmo
	 * contrato do Core, sem uma segunda regra aqui.
	 */
	async providerWrite(
		action: 'save' | 'remove' | 'enabled' | 'role',
		body: Record<string, unknown>,
	): Promise<ServiceQuery<ServiceProviderWriteResult>> {
		const path =
			action === 'save'
				? '/api/providers/save'
				: action === 'remove'
					? '/api/providers/remove'
					: action === 'role'
						? '/api/providers/role'
						: '/api/providers/enabled';
		return await this.write<ServiceProviderWriteResult>(path, body, parseProviderWrite);
	}

	/**
	 * Uma escrita autenticada no serviço.
	 *
	 * Separada da leitura de propósito: o token é o de **painel**, e o corpo
	 * só atravessa se o serviço responder `2xx` com o contrato esperado.
	 */
	private async write<T>(
		path: string,
		body: Record<string, unknown>,
		parse: (value: unknown) => T | undefined,
	): Promise<ServiceQuery<T>> {
		const probe = await (this.options.probe ?? probeService)({ root: this.options.root });
		if (probe.kind !== 'active') {
			return { ok: false, code: 'inactive', message: inactiveDetail(probe) };
		}
		const doFetch = this.options.fetch ?? globalThis.fetch;
		let response: Response;
		try {
			response = await doFetch(`http://${probe.record.address}:${probe.record.port}${path}`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					accept: 'application/json',
					[PANEL_HEADER]: probe.record.token,
				},
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS),
			});
		} catch (error) {
			const name = (error as { readonly name?: unknown }).name;
			if (name === 'TimeoutError' || name === 'AbortError') {
				return { ok: false, code: 'timeout', message: 'o serviço local não respondeu a tempo' };
			}
			return { ok: false, code: 'unreachable', message: 'não foi possível conectar ao serviço local' };
		}
		let answer: unknown;
		try {
			answer = await response.json();
		} catch {
			if (response.status === 401 || response.status === 403) {
				return {
					ok: false,
					code: 'unauthorized',
					message:
						'o serviço local recusou a credencial de administração; ele pode ter sido reiniciado — tente de novo',
				};
			}
			return { ok: false, code: 'invalid-response', message: 'o serviço local respondeu um corpo que não é JSON' };
		}
		if (!response.ok) {
			return {
				ok: false,
				code: response.status === 401 || response.status === 403 ? 'unauthorized' : 'invalid-response',
				message: refusalMessage(answer, response.status),
			};
		}
		const parsed = parse(answer);
		if (parsed === undefined) {
			return { ok: false, code: 'invalid-response', message: 'o serviço local respondeu um corpo fora do contrato' };
		}
		return { ok: true, value: parsed };
	}

	/** Grava ou remove um **modelo declarado** no serviço (DEV-8.15). */
	async catalogWrite(
		action: 'save' | 'remove',
		body: Record<string, unknown>,
	): Promise<ServiceQuery<{ readonly removed?: boolean }>> {
		const path = action === 'save' ? '/api/models/catalog/save' : '/api/models/catalog/remove';
		return await this.write<{ readonly removed?: boolean }>(path, body, (value) =>
			isRecord(value) ? { ...(value['removed'] === true ? { removed: true } : {}) } : undefined,
		);
	}

	/**
	 * O estado do aprendizado automático **no serviço**.
	 *
	 * No modo conectado o Core é o do serviço: é ele que aprende, e é o arquivo
	 * dele que diz se o caminho está ligado. A janela não monta um Core e não
	 * lê esse arquivo por conta própria — a leitura atravessa a rota, com a
	 * credencial de leitura do registro.
	 */
	async autoSkillStatus(): Promise<ServiceQuery<AutoSkillStatusView>> {
		const probe = await (this.options.probe ?? probeService)({ root: this.options.root });
		if (probe.kind !== 'active') {
			return { ok: false, code: 'inactive', message: inactiveDetail(probe) };
		}
		return await this.query<AutoSkillStatusView>(
			probe.record,
			'/api/skills/auto',
			parseAutoSkillStatus,
		);
	}

	/**
	 * Liga ou desliga o aprendizado automático **no serviço**.
	 *
	 * Escrita: credencial de **painel**, como a gravação do roteador. A resposta
	 * é o estado que ficou gravado, não o que foi pedido — e as skills já
	 * aprendidas continuam vivas.
	 */
	async setAutoSkillsEnabled(enabled: boolean): Promise<ServiceQuery<AutoSkillStatusView>> {
		return await this.write<AutoSkillStatusView>(
			'/api/skills/auto/set',
			{ enabled },
			parseAutoSkillStatus,
		);
	}

	/** Pede ao serviço que descubra modelos de um provedor (`/models`). */
	async discoverModels(providerId: string): Promise<
		ServiceQuery<{
			readonly models: readonly string[];
			readonly failed?: readonly { readonly providerId: string; readonly reason: string }[];
		}>
	> {
		return await this.write(
			'/api/models/discover',
			{ providerId },
			(value) => {
				if (!isRecord(value)) {
					return undefined;
				}
				const models = Array.isArray(value['models'])
					? value['models'].filter((entry): entry is string => typeof entry === 'string')
					: [];
				// O serviço publica `outcomes` (um por provedor, com `status` e
				// `error`). "failed" é o caso em que o endpoint não respondeu e
				// não há lista anterior — a interface precisa disso.
				const outcomes = Array.isArray(value['outcomes']) ? value['outcomes'] : [];
				const failed = outcomes
					.filter(
						(entry): entry is { providerId: string; error: string } =>
							isRecord(entry) &&
							entry['status'] === 'failed' &&
							typeof entry['providerId'] === 'string',
					)
					.map((entry) => ({
						providerId: entry.providerId,
						reason:
							typeof entry['error'] === 'string' && entry['error'].length > 0
								? entry['error']
								: 'o endpoint não respondeu',
					}));
				return { models, ...(failed.length > 0 ? { failed } : {}) };
			},
		);
	}

	/** O catálogo declarado do serviço (`GET /api/models/catalog`). */
	async declaredCatalog(): Promise<ServiceQuery<{
		readonly declared: readonly unknown[];
		readonly models: readonly unknown[];
		readonly policy?: unknown;
	}>> {
		const probe = await (this.options.probe ?? probeService)({ root: this.options.root });
		if (probe.kind !== 'active') {
			return { ok: false, code: 'inactive', message: inactiveDetail(probe) };
		}
		return await this.query(
			probe.record,
			'/api/models/catalog',
			(value): { declared: readonly unknown[]; models: readonly unknown[]; policy?: unknown } | undefined =>
				isRecord(value) && Array.isArray(value['declared'])
					? {
							declared: value['declared'],
							models: Array.isArray(value['models']) ? value['models'] : [],
							...(value['policy'] !== undefined ? { policy: value['policy'] } : {}),
						}
					: undefined,
		);
	}

	/** O catálogo de modelos do serviço. */
	async catalog(): Promise<ServiceQuery<ServiceCatalog>> {
		const probe = await (this.options.probe ?? probeService)({ root: this.options.root });
		if (probe.kind !== 'active') {
			return { ok: false, code: 'inactive', message: inactiveDetail(probe) };
		}
		// `/api/models` já devolve `models` e `policy` juntos: é o endpoint
		// existente que cobre esta necessidade, e por isso nenhum novo.
		return await this.query<ServiceCatalog>(probe.record, '/api/models', parseCatalog);
	}

	/**
	 * A configuração efetiva do roteador **do serviço** (DEV-8.11).
	 *
	 * O desktop conectado não tem Core: quem executa o turno é o serviço, e é a
	 * configuração dele que vale. Esta leitura usa o endpoint existente
	 * (`GET /api/routing`, autenticado com o token de **leitura** do registro),
	 * e devolve só a decisão — modo, interruptor, ids dos destinos. As chaves
	 * nunca estiveram nesse corpo, e `targets` (com nomes e URLs) é descartado
	 * aqui de propósito: a interface do desktop precisa do modo, não do catálogo
	 * de destinos.
	 */
	async routing(): Promise<ServiceQuery<ServiceRouting>> {
		const probe = await (this.options.probe ?? probeService)({ root: this.options.root });
		if (probe.kind !== 'active') {
			return { ok: false, code: 'inactive', message: inactiveDetail(probe) };
		}
		return await this.query<ServiceRouting>(probe.record, '/api/routing', parseRouting);
	}

	/**
	 * Grava a configuração do roteador **no serviço** (DEV-8.12).
	 *
	 * ## Autorização
	 *
	 * Leitura usa `readerToken`; **escrita não**. A escrita apresentada aqui é
	 * o token de **painel** no header de sessão — o mesmo mecanismo
	 * administrativo que o painel no navegador usa. O servidor recusa o token
	 * de leitura em escrita (`isPanel` exige que o valor não venha pelos
	 * headers de leitura/conversa), de modo que usar este caminho não promove
	 * privilégio nenhum que o registro já não carregue.
	 *
	 * O corpo traz só a decisão (modo, interruptor, ids de destino). A
	 * validação é do Core do serviço (`changeRouterConfig`), e a resposta é o
	 * que ficou **gravado** — não o que foi pedido.
	 */
	async saveRouting(input: {
		readonly mode?: 'native' | 'external' | 'direct';
		readonly enabled?: boolean;
		readonly externalRouterProviderId?: string;
		readonly directProviderId?: string;
	}): Promise<ServiceQuery<ServiceRouting>> {
		const probe = await (this.options.probe ?? probeService)({ root: this.options.root });
		if (probe.kind !== 'active') {
			return { ok: false, code: 'inactive', message: inactiveDetail(probe) };
		}
		const doFetch = this.options.fetch ?? globalThis.fetch;
		const url = `http://${probe.record.address}:${probe.record.port}/api/routing/save`;
		let response: Response;
		try {
			response = await doFetch(url, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					accept: 'application/json',
					[PANEL_HEADER]: probe.record.token,
				},
				body: JSON.stringify(input),
				signal: AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS),
			});
		} catch (error) {
			const name = (error as { readonly name?: unknown }).name;
			if (name === 'TimeoutError' || name === 'AbortError') {
				return { ok: false, code: 'timeout', message: 'o serviço local não respondeu a tempo' };
			}
			return {
				ok: false,
				code: 'unreachable',
				message: 'não foi possível conectar ao serviço local',
			};
		}
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			// Uma recusa de credencial vem com corpo vazio e `text/plain`: o
			// status é o que importa, e tratá-la como "JSON inválido" diria à
			// pessoa que o serviço respondeu algo que ele não respondeu.
			if (response.status === 401 || response.status === 403) {
				return {
					ok: false,
					code: 'unauthorized',
					message:
						'o serviço local recusou a credencial de administração; ' +
						'ele pode ter sido reiniciado — tente de novo',
				};
			}
			return {
				ok: false,
				code: 'invalid-response',
				message: 'o serviço local respondeu um corpo que não é JSON',
			};
		}
		if (!response.ok) {
			// A recusa é do serviço e já vem em português, sem chave: o corpo é
			// `{ error: '…' }` na escrita e `{ error: { message } }` quando a
			// credencial é recusada. O texto é levado como está — é o motivo.
			return {
				ok: false,
				code: response.status === 401 || response.status === 403 ? 'unauthorized' : 'invalid-response',
				message: refusalMessage(body, response.status),
			};
		}
		const parsed = parseRouting(body);
		if (parsed === undefined) {
			return {
				ok: false,
				code: 'invalid-response',
				message: 'o serviço local respondeu um corpo fora do contrato',
			};
		}
		return { ok: true, value: parsed };
	}

	/**
	 * Uma requisição de leitura autenticada.
	 *
	 * Traduz cada falha em um código e uma mensagem. A mensagem nunca inclui
	 * a credencial, o caminho da raiz, ou o corpo cru de uma resposta que não
	 * seja do contrato.
	 */
	private async query<T>(
		record: ServiceRecord,
		path: string,
		parse: (body: unknown) => T | undefined,
	): Promise<ServiceQuery<T>> {
		const doFetch = this.options.fetch ?? globalThis.fetch;
		const url = `http://${record.address}:${record.port}${path}`;
		let response: Response;
		try {
			response = await doFetch(url, {
				method: 'GET',
				headers: { [READER_HEADER]: record.readerToken, accept: 'application/json' },
				signal: AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS),
			});
		} catch (error) {
			const name = (error as { readonly name?: unknown }).name;
			if (name === 'TimeoutError' || name === 'AbortError') {
				return { ok: false, code: 'timeout', message: 'o serviço local não respondeu a tempo' };
			}
			return {
				ok: false,
				code: 'unreachable',
				message: 'não foi possível conectar ao serviço local',
			};
		}

		if (response.status === 401 || response.status === 403) {
			// A credencial de leitura não foi aceita. Pode ser um serviço que
			// reiniciou entre a descoberta e a consulta (o token muda a cada
			// arranque), e a próxima descoberta resolverá.
			await discard(response);
			return {
				ok: false,
				code: 'unauthorized',
				message:
					'o serviço local recusou a credencial de leitura; ' +
					'ele pode ter sido reiniciado — tente de novo',
			};
		}
		if (response.status >= 500) {
			await discard(response);
			return {
				ok: false,
				code: 'server-error',
				message: `o serviço local respondeu com erro (${response.status})`,
			};
		}
		if (response.status === 404) {
			await discard(response);
			return {
				ok: false,
				code: 'invalid-response',
				message: 'o serviço local não tem o recurso consultado',
			};
		}
		if (!response.ok) {
			await discard(response);
			return {
				ok: false,
				code: 'invalid-response',
				message: `o serviço local respondeu um status inesperado (${response.status})`,
			};
		}

		let body: unknown;
		try {
			body = await response.json();
		} catch {
			return {
				ok: false,
				code: 'invalid-response',
				message: 'o serviço local respondeu um corpo que não é JSON',
			};
		}
		const parsed = parse(body);
		if (parsed === undefined) {
			return {
				ok: false,
				code: 'invalid-response',
				message: 'o serviço local respondeu um corpo fora do contrato',
			};
		}
		return { ok: true, value: parsed };
	}
}

/** O resumo do serviço, como `/api/overview` o devolve. */
export interface ServiceOverview {
	readonly providers: { readonly total: number; readonly enabled: number; readonly routers: number };
	readonly models: { readonly total: number };
	readonly router: {
		readonly mode: string;
		readonly enabled: boolean;
		readonly configured: boolean;
	};
}

/**
 * A identidade do serviço, sem credencial.
 *
 * É tudo o que um consumidor (interface, log, IPC) pode conhecer do serviço.
 * O `ServiceRecord` inteiro — que tem os dois tokens — nunca sai do módulo.
 */
export interface ServiceIdentity {
	readonly pid: number;
	readonly port: number;
	readonly startedAt: string;
	readonly appVersion: string;
}

/** A identidade pública de um registro. */
function identityOf(record: ServiceRecord): ServiceIdentity {
	return {
		pid: record.pid,
		port: record.port,
		startedAt: record.startedAt,
		appVersion: record.appVersion,
	};
}

/** Uma linha para o estado, a partir do veredito da descoberta. */
export function inactiveDetail(probe: ServiceProbe): string {
	switch (probe.kind) {
		case 'absent':
			return 'o serviço local não está ativo';		case 'incompatible':
			return `o serviço local fala um protocolo diferente (${probe.protocol})`;
		case 'invalid':
			return `o registro do serviço local não é confiável: ${probe.reason}`;
		case 'stale':
			return `o serviço local foi encerrado sem limpeza: ${probe.reason}`;
		case 'unresponsive':
			return `o serviço local não respondeu: ${probe.reason}`;
		case 'active':
			return 'conectado ao serviço local';
	}
}

/** Lê o corpo do `/api/overview`, exigindo o que o cliente usa. */
function parseOverview(body: unknown): ServiceOverview | undefined {
	if (body === null || typeof body !== 'object') {
		return undefined;
	}
	const record = body as Record<string, unknown>;
	const providers = record['providers'];
	const models = record['models'];
	const router = record['router'];
	if (
		!isRecord(providers) ||
		typeof providers['total'] !== 'number' ||
		typeof providers['enabled'] !== 'number' ||
		typeof providers['routers'] !== 'number' ||
		!isRecord(models) ||
		typeof models['total'] !== 'number' ||
		!isRecord(router) ||
		typeof router['mode'] !== 'string' ||
		typeof router['enabled'] !== 'boolean' ||
		typeof router['configured'] !== 'boolean'
	) {
		return undefined;
	}
	return {
		providers: {
			total: providers['total'],
			enabled: providers['enabled'],
			routers: providers['routers'],
		},
		models: { total: models['total'] },
		router: {
			mode: router['mode'],
			enabled: router['enabled'],
			configured: router['configured'],
		},
	};
}

/** Lê o corpo do `/api/models`, exigindo identidade de cada modelo. */
function parseCatalog(body: unknown): ServiceCatalog | undefined {
	if (!isRecord(body) || !Array.isArray(body['models']) || !isRecord(body['policy'])) {
		return undefined;
	}
	const models: ServiceModel[] = [];
	for (const entry of body['models']) {
		if (!isRecord(entry) || typeof entry['providerId'] !== 'string' || typeof entry['modelId'] !== 'string') {
			// Um modelo sem identidade não pode ser pedido: é melhor recusar o
			// corpo inteiro do que entregar à interface uma lista em que parte
			// das linhas não funciona.
			return undefined;
		}
		models.push(entry as unknown as ServiceModel);
	}
	const policy = body['policy'];
	if (
		typeof policy['policy'] !== 'string' ||
		typeof policy['priceSource'] !== 'string' ||
		typeof policy['limitsSource'] !== 'string' ||
		typeof policy['capabilitiesSource'] !== 'string' ||
		typeof policy['updatedAt'] !== 'string' ||
		typeof policy['changedBy'] !== 'string' ||
		typeof policy['hint'] !== 'string'
	) {
		return undefined;
	}
	return { models, policy: policy as unknown as ServiceAccessPolicy };
}

/** Os provedores do serviço, como `GET /api/providers` os devolve. */
export interface ServiceProviders {
	readonly providers: readonly ProviderSummary[];
	/**
	 * O catálogo **fundido** (declarado + descoberto), por modelo. É a única
	 * lista por modelo do serviço; cada entrada diz de que provedor é.
	 */
	readonly models: readonly { readonly providerId: string; readonly modelId: string; readonly [key: string]: unknown }[];
}

/** O que devolveram uma escrita de provedor: o resumo gravado. */
export interface ServiceProviderWriteResult {
	readonly provider?: ProviderSummary;
	readonly removed?: boolean;
	readonly id?: string;
}

function parseProviders(body: unknown): ServiceProviders | undefined {
	if (!isRecord(body) || !Array.isArray(body['providers'])) {
		return undefined;
	}
	const providers: ProviderSummary[] = [];
	for (const entry of body['providers']) {
		// `hasApiKeyRef` é booleano, nunca a chave: um corpo que trouxesse o
		// segredo seria recusado aqui em vez de seguir para a interface.
		if (
			!isRecord(entry) ||
			typeof entry['id'] !== 'string' ||
			typeof entry['name'] !== 'string' ||
			typeof entry['baseUrl'] !== 'string' ||
			typeof entry['status'] !== 'string' ||
			typeof entry['hasApiKeyRef'] !== 'boolean' ||
			!Array.isArray(entry['models'])
		) {
			return undefined;
		}
		providers.push(entry as unknown as ProviderSummary);
	}
	const models = Array.isArray(body['models'])
		? body['models'].filter(
				(entry): entry is { readonly providerId: string; readonly modelId: string; readonly [key: string]: unknown } =>
					isRecord(entry) && typeof entry['providerId'] === 'string' && typeof entry['modelId'] === 'string',
			)
		: [];
	return { providers, models };
}

function parseProviderWrite(body: unknown): ServiceProviderWriteResult | undefined {
	if (!isRecord(body)) {
		return undefined;
	}
	if (body['removed'] === true) {
		return { removed: true };
	}
	// `save` e `enabled` devolvem o resumo **direto** (`ProviderSummary`);
	// `remove` devolve `{ removed: true }`. O parser aceita as duas formas e é
	// estrito quanto a `hasApiKeyRef`: se vier uma chave no lugar do booleano,
	// o corpo é recusado em vez de seguir para a interface.
	if (typeof body['id'] === 'string' && typeof body['name'] === 'string') {
		if (typeof body['hasApiKeyRef'] !== 'boolean') {
			return undefined;
		}
		return { provider: body as unknown as ProviderSummary };
	}
	return undefined;
}

/** A configuração efetiva do roteador do serviço (DEV-8.11). Sem segredo. */export interface ServiceRouting {
	readonly mode: 'native' | 'external' | 'direct';
	readonly enabled: boolean;
	readonly externalRouterProviderId?: string;
	readonly directProviderId?: string;
	readonly updatedAt: string;
	readonly configured: boolean;
	/** O serviço leu o arquivo e não conseguiu: a interface diz isso. */
	readonly unreadable?: string;
}

/** O header de sessão do painel — o mesmo que o navegador usa. */
const PANEL_HEADER = 'x-seshyina-token';

/**
 * A mensagem de uma recusa de escrita, sem credencial.
 *
 * O serviço responde `{ error: 'texto' }` na escrita e
 * `{ error: { message: 'texto' } }` quando a credencial é recusada. Um corpo
 * fora disso não vira texto: a mensagem é genérica e cita o status.
 */
function refusalMessage(body: unknown, status: number): string {
	if (isRecord(body)) {
		const error = body['error'];
		if (typeof error === 'string' && error.length > 0) {
			return error;
		}
		if (isRecord(error) && typeof error['message'] === 'string' && error['message'].length > 0) {
			return error['message'];
		}
	}
	return `o serviço local recusou a gravação (${status})`;
}

/**
 * O estado do aprendizado automático, validado pelo parser da ponte.
 *
 * `parseAutoSkillStatusView` lança quando o corpo não é o contrato; aqui a
 * falha vira `undefined`, que é o que `query`/`write` traduzem em
 * `invalid-response` — a mesma resposta para qualquer corpo fora do contrato.
 */
function parseAutoSkillStatus(body: unknown): AutoSkillStatusView | undefined {
	try {
		return parseAutoSkillStatusView(body);
	} catch {
		return undefined;
	}
}

function parseRouting(body: unknown): ServiceRouting | undefined {
	// O corpo real é `{ config, targets, status }`. Só o `config` atravessa:
	// `targets` traz nomes/URLs que a página do serviço mostra, e nada disso
	// é necessário para o seletor do chat.
	const config = isRecord(body) && isRecord(body['config']) ? body['config'] : undefined;
	if (config === undefined) {
		return undefined;
	}
	const mode = config['mode'];
	if (mode !== 'native' && mode !== 'external' && mode !== 'direct') {
		return undefined;
	}
	if (typeof config['enabled'] !== 'boolean') {
		return undefined;
	}
	if (typeof config['updatedAt'] !== 'string' || typeof config['configured'] !== 'boolean') {
		return undefined;
	}
	const external = config['externalRouterProviderId'];
	const direct = config['directProviderId'];
	const unreadable = config['unreadable'];
	return {
		mode,
		enabled: config['enabled'],
		updatedAt: config['updatedAt'],
		configured: config['configured'],
		...(typeof external === 'string' && external.length > 0 ? { externalRouterProviderId: external } : {}),
		...(typeof direct === 'string' && direct.length > 0 ? { directProviderId: direct } : {}),
		...(typeof unreadable === 'string' && unreadable.length > 0 ? { unreadable } : {}),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Consome e descarta o corpo, para o socket não ficar preso. */
async function discard(response: Response): Promise<void> {
	await response.text().catch(() => undefined);
}
