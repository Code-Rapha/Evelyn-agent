/**
 * O protocolo entre a Evelyn e o serviço de sandbox do modo DEV.
 *
 * ## Por que um contrato separado
 *
 * O serviço roda como `LocalSystem`. Ele **não pode** aceitar comandos livres:
 * se aceitasse, instalá-lo seria dar a qualquer processo que chegasse ao pipe
 * um shell de administrador. Por isso o protocolo tem **uma** operação —
 * executar uma ferramenta DEV permitida num repositório autorizado — e a
 * allowlist de comandos é a mesma da DEV-2 (validada nos dois lados: o cliente
 * recusa antes de enviar, o serviço recusa de novo antes de executar).
 *
 * ## Autenticação
 *
 * Há dois cadeados, e os dois são necessários:
 *
 * 1. **ACL do pipe** — só o SID do usuário instalador abre `\\.\pipe\…`.
 * 2. **HMAC-SHA256 por mensagem** — com uma chave de 32 bytes gerada na
 *    instalação e guardada num arquivo cujo ACL é só do instalador
 *    (`SYSTEM` + aquele usuário). Sem a chave, quem tiver o pipe (por engano
 *    de ACL, por exemplo) ainda não consegue falar com o serviço.
 *
 * O HMAC cobre `seq | timestamp | corpo`, e o serviço recusa:
 * - `seq` fora de ordem ou repetido (replay);
 * - `timestamp` fora de ±60 s (replay de uma mensagem capturada);
 * - assinatura inválida (outro processo, outro usuário).
 *
 * ## O que o serviço confere antes de executar
 *
 * Tudo o que o `DevRunner` confere, e mais três coisas que só ele pode fazer:
 * o repositório está na lista de **raízes autorizadas** (gravada na
 * instalação), o comando passa a allowlist, e os argumentos não apontam para
 * fora do checkout. Nenhum desses é opcional.
 */

/** A única operação que o serviço aceita. */
export interface SandboxRequest {
	readonly op: 'run';
	/** A raiz autorizada, comparada com a lista da instalação. */
	readonly root: string;
	/** O comando, já validado pela allowlist do cliente. */
	readonly command: string;
	/** Prazo em ms. O serviço impõe o seu próprio teto, além deste. */
	readonly timeoutMs: number;
}

/** O desfecho de uma execução. */
export interface SandboxReply {
	readonly ok: boolean;
	/** Saída padrão, já limitada. */
	readonly stdout: string;
	readonly stderr: string;
	/** `null` quando o processo não chegou a iniciar. */
	readonly exitCode: number | null;
	readonly durationMs: number;
	/** `true` quando o prazo ou o cancelamento encerrou o processo. */
	readonly aborted: boolean;
	/** `true` quando a saída passou do teto e foi cortada. */
	readonly truncated: boolean;
	/** Presente quando `ok` é falso: a recusa do serviço, em texto. */
	readonly error?: string;
}

/** O envelope assinado que vai pelo pipe. */
export interface SandboxEnvelope {
	/** Identificador do protocolo; o serviço recusa outro. */
	readonly version: 1;
	readonly seq: number;
	/** ISO-8601 do cliente; o serviço aplica a janela. */
	readonly sentAt: string;
	/** O pedido serializado. */
	readonly payload: SandboxRequest;
	/** HMAC-SHA256 em base64 de `version|seq|sentAt|payload`. */
	readonly signature: string;
}

/** O que uma recusa do serviço pode dizer (o cliente mostra ao usuário). */
export type SandboxRefusal =
	| 'protocolo-desconhecido'
	| 'assinatura-invalida'
	| 'fora-da-janela'
	| 'sequencia-fora-de-ordem'
	| 'raiz-nao-autorizada'
	| 'comando-nao-permitido'
	| 'argumento-fora-do-repositorio'
	| 'sandbox-indisponivel';

/** A janela de tolerância do timestamp, em ms. */
export const CLOCK_SKEW_MS = 60_000;

/** O teto de saída que o serviço aplica por conta própria. */
export const SANDBOX_OUTPUT_LIMIT_BYTES = 256 * 1024;

/**
 * O teto de tempo que o serviço aplica, independentemente do pedido.
 *
 * O cliente pede até 10 min (o mesmo do `DevRunner`); o serviço não aceita
 * mais que isso, mesmo que o cliente insista — um pedido com `timeoutMs:
 * 86400000` não pode segurar um processo do sistema por um dia.
 */
export const SANDBOX_MAX_TIMEOUT_MS = 10 * 60_000;

/** O nome base do pipe. O sufixo é o hash do usuário instalador. */
export const SANDBOX_PIPE_PREFIX = 'evelyn-dev-sandbox-';

/** O nome do serviço no gerenciador. */
export const SANDBOX_SERVICE_NAME = 'evelyn-devsandbox';

/** O perfil de AppContainer que o serviço cria uma vez. */
export const SANDBOX_PROFILE_NAME = 'EvelynDevSandbox';

/** Valida o corpo de um pedido recebido do pipe. */
export function parseSandboxRequest(value: unknown): SandboxRequest {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error('pedido inválido');
	}
	const record = value as Record<string, unknown>;
	if (record['op'] !== 'run') {
		throw new Error('operação desconhecida');
	}
	const root = record['root'];
	const command = record['command'];
	const timeoutMs = record['timeoutMs'];
	if (typeof root !== 'string' || root.trim().length === 0 || !isAbsolutePath(root)) {
		throw new Error('raiz inválida');
	}
	if (typeof command !== 'string' || command.trim().length === 0 || command.length > 2_000) {
		throw new Error('comando inválido');
	}
	if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		throw new Error('prazo inválido');
	}
	return {
		op: 'run',
		root,
		command,
		timeoutMs: Math.min(Math.floor(timeoutMs), SANDBOX_MAX_TIMEOUT_MS),
	};
}

/** Um caminho absoluto no Windows (`C:\…` ou `\\servidor\…`). */
function isAbsolutePath(path: string): boolean {
	return /^[a-z]:[\\/]/i.test(path) || path.startsWith('\\\\');
}
