/**
 * A única requisição que a Evelyn faz ao OpenCode: o health.
 *
 * ## O que ela tem de garantido
 *
 * - **`/global/health`**, sempre — quem monta o caminho é o gerenciador, a
 *   partir da base que ele mesmo validou;
 * - **sem redirecionamento**: uma resposta `3xx` é tratada como status, com o
 *   corpo vazio, em vez de o cliente seguir para outro destino com a senha no
 *   cabeçalho;
 * - **com prazo**: um servidor que aceita a conexão e não responde não deixa a
 *   interface esperando para sempre;
 * - **corpo mínimo**: do JSON de resposta só se lê `healthy` e `version`.
 *   Qualquer outro campo — e o OpenCode pode acrescentar muitos — é ignorado
 *   e não é guardado em lugar nenhum.
 *
 * O cabeçalho Basic é o do OpenCode (`opencode:<senha>`), como a
 * documentação do servidor descreve.
 *
 * ## Por que o transporte mora aqui
 *
 * O transporte (`getJson`) é exposto para outras leituras do mesmo servidor
 * (o catálogo de modelos, na Fase 4D) usarem **as mesmas** regras: prazo, sem
 * redirecionamento, sem keep-alive. O caminho continua sendo decidido por
 * quem chama, a partir da base que o gerenciador validou.
 */
import { Agent, request } from 'node:http';
import { request as httpsRequest } from 'node:https';

export interface HealthRequestOptions {
	/** A URL completa, incluindo `/global/health`. */
	readonly url: string;
	/** O cabeçalho `Authorization`, quando há senha. */
	readonly authorization?: string;
	/** O prazo da requisição inteira. */
	readonly timeoutMs?: number;
}

/** O que o health respondeu. */
export interface HealthAnswer {
	/** O status HTTP. */
	readonly status: number;
	/** A versão que o servidor declarou, quando ele declarou. */
	readonly version?: string;
}

/** O prazo padrão de uma requisição de saúde. */
export const HEALTH_TIMEOUT_MS = 3_000;

/** O teto do corpo que se lê do health — ele diz "healthy" e a versão. */
const MAX_HEALTH_BODY_BYTES = 16 * 1024;

/** Uma resposta LID E PELO TRANSPORTE: status e corpo cru. */
export interface RawAnswer {
	readonly status: number;
	/** O corpo lido (até o teto pedido), sem interpretação. */
	readonly body: string;
}

/** O usuário do Basic auth, como o servidor do OpenCode documenta. */
const BASIC_USER = 'opencode';

/**
 * Consulta o health e devolve o status e a versão.
 *
 * Um erro de rede (recusa de conexão, DNS, prazo) **rejeita** — quem chama
 * sabe distinguir "respondeu 500" de "não respondeu".
 */
export async function requestOpencodeHealth(options: HealthRequestOptions): Promise<HealthAnswer> {
	const answer = await getJson({
		url: options.url,
		...(options.authorization !== undefined ? { authorization: options.authorization } : {}),
		...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
		maxBytes: MAX_HEALTH_BODY_BYTES,
	});
	return { status: answer.status, ...readVersion(answer.body) };
}

/** O que o transporte precisa. */
export interface GetJsonOptions {
	/** A URL completa. */
	readonly url: string;
	/** O cabeçalho `Authorization`, quando há senha. */
	readonly authorization?: string;
	readonly timeoutMs?: number;
	/** Teto do corpo lido; o resto é descartado. */
	readonly maxBytes: number;
}

/**
 * Um `GET` JSON ao servidor, com as mesmas regras do health.
 *
 * - **não segue redirecionamento**: devolve o `3xx` como status;
 * - **prazo total**: derruba a conexão quando vence;
 * - **sem keep-alive**: cada leitura é uma conexão própria;
 * - **teto de corpo**: um servidor que devolve infinito não consome memória.
 *
 * O chamador não informa cabeçalho de autenticação: ele vem do parâmetro
 * `authorization`, que só o gerenciador monta (`basicAuthHeader`).
 */
export function getJson(options: GetJsonOptions): Promise<RawAnswer> {
	let url: URL;
	try {
		url = new URL(options.url);
	} catch {
		return Promise.reject(new Error('o endereço do servidor não é válido'));
	}
	const secure = url.protocol === 'https:';
	const timeoutMs = options.timeoutMs ?? HEALTH_TIMEOUT_MS;

	return new Promise<RawAnswer>((resolve, reject) => {
		// Sem keep-alive: cada verificação é uma conexão própria, e uma
		// conexão ociosa pendurada manteria um socket aberto no processo que
		// só queria saber se o servidor responde.
		const agent = new Agent({ keepAlive: false });
		const requestFn = secure ? httpsRequest : request;
		const headers: Record<string, string> = { accept: 'application/json' };
		if (options.authorization !== undefined && options.authorization.length > 0) {
			headers['authorization'] = options.authorization;
		}
		const req = requestFn(
			{
				protocol: url.protocol,
				hostname: url.hostname.replace(/^\[|\]$/g, ''),
				port: url.port.length > 0 ? Number(url.port) : secure ? 443 : 80,
				path: `${url.pathname}${url.search}`,
				method: 'GET',
				headers,
				agent,
				timeout: timeoutMs,
			},
			(response) => {
				const status = response.statusCode ?? 0;
				const chunks: Buffer[] = [];
				let size = 0;
				response.on('data', (chunk: Buffer) => {
					size += chunk.length;
					if (size <= options.maxBytes) {
						chunks.push(chunk);
					}
				});
				response.on('end', () => {
					agent.destroy();
					resolve({ status, body: Buffer.concat(chunks).toString('utf8') });
				});
				response.on('error', (error) => {
					agent.destroy();
					reject(error);
				});
			},
		);
		req.on('timeout', () => {
			req.destroy(new Error('o servidor não respondeu a tempo'));
		});
		req.on('error', (error) => {
			agent.destroy();
			reject(error);
		});
		req.end();
	});
}

/** O cabeçalho de autenticação do servidor: Basic com o usuário documentado. */
export function serverAuthorization(password: string): string {
	return `Basic ${Buffer.from(`${BASIC_USER}:${password}`, 'utf8').toString('base64')}`;
}
/** A versão de um corpo de health, sem guardar mais nada dele. */
function readVersion(body: string): { readonly version?: string } {
	try {
		const parsed = JSON.parse(body) as Record<string, unknown>;
		const version = parsed['version'];
		return typeof version === 'string' && version.length > 0 && version.length <= 64 ? { version } : {};
	} catch {
		return {};
	}
}
