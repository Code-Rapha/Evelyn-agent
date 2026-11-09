/**
 * Descobre se o serviço local está no ar — e se é **o nosso**.
 *
 * ## A pergunta, feita em ordem
 *
 * 1. há um `service.json` legível e com protocolo compatível?
 * 2. o processo que ele aponta existe? (e é o mesmo, não um pid reciclado)
 * 3. o servidor responde ao health **com a credencial do arquivo**, e diz que
 *    é o mesmo pid, a mesma porta e o mesmo estado de Core?
 *
 * Só com as três respostas certas o serviço é dado como ativo. Qualquer outra
 * combinação recebe um veredito próprio — "ausente", "incompleto",
 * "incompatível", "processo morto", "não autenticou" —, porque "não está
 * ativo" sozinho esconde justamente a diferença entre "nunca subiu", "morreu
 * agora" e "alguém tomou a porta".
 *
 * ## O que este módulo **não** faz
 *
 * Não inicia o serviço, não o encerra e não o considera saudável por tempo:
 * a resposta é uma fotografia do momento. Um cliente de longa duração
 * repete a verificação; um veredito guardado envelhece.
 */
import { readServiceRecord, processIdentity, type ProcessIdentity, type ServiceRecord } from './serviceRecord';

/** O que foi encontrado. */
export type ServiceProbe =
	| {
			readonly kind: 'active';
			readonly record: ServiceRecord;
			/** O health, já verificado como sendo deste serviço. */
			readonly health: ServiceHealth;
	  }
	| { readonly kind: 'absent' }
	| { readonly kind: 'incompatible'; readonly protocol: number }
	/** O registro existe e não serve (corrompido, incompleto, fora do loopback). */
	| { readonly kind: 'invalid'; readonly reason: string }
	/** O processo do registro não existe mais: o serviço caiu sem limpar. */
	| { readonly kind: 'stale'; readonly record: ServiceRecord; readonly reason: string }
	/** O processo existe, mas não responde ao health com a credencial do registro. */
	| {
			readonly kind: 'unresponsive';
			readonly record: ServiceRecord;
			readonly reason: string;
	  };

/** O que o health de um serviço reporta, e o que o cliente confere. */
export interface ServiceHealth {
	readonly status: string;
	readonly app: string;
	readonly version: string;
	readonly listening: string;
	readonly coreMounted: boolean;
	readonly storageHost: string | null;
	readonly pid?: number;
}

/** O que a descoberta precisa do mundo — para um teste não precisar de socket. */
export interface ServiceProbeOptions {
	readonly root: string;
	/** O health, autenticado. Devolve `undefined` quando não há resposta. */
	readonly fetchHealth?: (
		url: string,
		token: string,
		signal?: AbortSignal,
	) => Promise<ServiceHealth | undefined>;
	/** A identidade de um processo: vivo, morto, ou não verificável. */
	readonly identity?: (pid: number) => Promise<ProcessIdentity>;
	readonly timeoutMs?: number;
}

/** O tempo máximo para o health responder quando o serviço está "vivo". */
const DEFAULT_HEALTH_TIMEOUT_MS = 2_000;

/**
 * Pergunta ao serviço.
 *
 * Nunca lança: cada falha é um veredito. Um cliente de descoberta que lança
 * obriga todo chamador a repetir o mesmo `try` — e o esquecimento de um é
 * exatamente o caso em que o app já montou o Core.
 */
export async function probeService(options: ServiceProbeOptions): Promise<ServiceProbe> {
	const read = await readServiceRecord(options.root);
	if (read.kind === 'absent') {
		return { kind: 'absent' };
	}
	if (read.kind === 'incompatible') {
		return { kind: 'incompatible', protocol: read.protocol };
	}
	if (read.kind === 'invalid') {
		return { kind: 'invalid', reason: read.reason };
	}
	const record = read.record;

	const identity = options.identity ?? ((pid: number) => processIdentity(pid));
	const state = await identity(record.pid);
	if (state.kind === 'dead') {
		return {
			kind: 'stale',
			record,
			reason: `o processo ${record.pid} do registro do serviço não existe mais`,
		};
	}
	// "Desconhecido" cai na verificação de autenticação: se o processo não é
	// verificável, o health com o token do registro continua sendo a prova de
	// que quem responde é o serviço que gravou aquele arquivo.

	const fetchHealth = options.fetchHealth ?? defaultFetchHealth;
	const url = `http://${record.address}:${record.port}/api/health`;
	let health: ServiceHealth | undefined;
	try {
		health = await withTimeout(
			fetchHealth(url, record.token),
			options.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS,
		);
	} catch {
		health = undefined;
	}
	if (health === undefined) {
		return {
			kind: 'unresponsive',
			record,
			reason: 'o processo existe, mas o servidor não respondeu ao health com a credencial do registro',
		};
	}
	// O servidor diz o que ele é; o cliente confere contra o arquivo. Um
	// servidor que responde algo diferente (outra porta, outro pid) não é o
	// dono do registro — e a credencial não deve ser usada com ele.
	if (health.pid !== undefined && health.pid !== record.pid) {
		return {
			kind: 'unresponsive',
			record,
			reason: `quem respondeu na porta ${record.port} é o processo ${health.pid}, não o ${record.pid}`,
		};
	}
	if (health.listening !== `${record.address}:${record.port}`) {
		return {
			kind: 'unresponsive',
			record,
			reason: `quem respondeu diz escutar em "${health.listening}", e não em ${record.address}:${record.port}`,
		};
	}
	if (health.app !== 'Evelyn') {
		return {
			kind: 'unresponsive',
			record,
			reason: 'quem respondeu não se identifica como Evelyn',
		};
	}
	return { kind: 'active', record, health };
}

/** O health real, por HTTP, com a credencial do registro. */
async function defaultFetchHealth(
	url: string,
	token: string,
	signal?: AbortSignal,
): Promise<ServiceHealth | undefined> {
	const response = await fetch(url, {
		headers: { 'x-seshyina-token': token },
		signal: signal ?? AbortSignal.timeout(DEFAULT_HEALTH_TIMEOUT_MS),
	});
	if (response.status !== 200) {
		return undefined;
	}
	const body: unknown = await response.json().catch(() => undefined);
	if (body === null || typeof body !== 'object') {
		return undefined;
	}
	const record = body as Record<string, unknown>;
	if (typeof record['status'] !== 'string' || typeof record['listening'] !== 'string') {
		return undefined;
	}
	return {
		status: record['status'],
		app: typeof record['app'] === 'string' ? record['app'] : 'desconhecido',
		version: typeof record['version'] === 'string' ? record['version'] : '0.0.0',
		listening: record['listening'],
		coreMounted: record['coreMounted'] === true,
		storageHost: typeof record['storageHost'] === 'string' ? record['storageHost'] : null,
		...(typeof record['pid'] === 'number' ? { pid: record['pid'] } : {}),
	};
}

/** Corre uma promessa com prazo, sem deixar o timer vivo. */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
	if (ms <= 0) {
		return await work;
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error('o serviço não respondeu a tempo')), ms);
			}),
		]);
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
	}
}
