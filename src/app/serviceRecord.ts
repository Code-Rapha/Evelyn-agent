/**
 * O registro de que o serviço local está no ar.
 *
 * ## Por que não basta "a porta respondeu"
 *
 * Qualquer processo pode escutar em `127.0.0.1:7817`. Um cliente que trata
 * "houve resposta HTTP" como "é o serviço da Evelyn" entrega o token a quem
 * chegou primeiro — inclusive a um processo que se levantou na mesma porta
 * depois de um crash.
 *
 * A identificação aqui tem três partes, e todas precisam concordar:
 *
 * 1. **O arquivo** — `service.json` na raiz, escrito pelo serviço ao subir,
 *    com `0600`. Ele diz pid, porta, início, versão do protocolo e a
 *    **credencial de painel** daquele processo;
 * 2. **O processo** — o pid do arquivo existe **e** é o mesmo processo que
 *    gravou: o `startedAt` do sistema operacional vem de um token de
 *    identidade derivado dele, e não de um arquivo que qualquer um copia;
 * 3. **O servidor** — `GET /api/health` com a credencial do arquivo. Só quem
 *    tem aquele token responde `200` **e** reporta o mesmo pid e a mesma
 *    porta.
 *
 * ## O que NUNCA vai para o arquivo
 *
 * Chaves de provedor, cookies de sessão do navegador, endereços de provedor.
 * A credencial que vai é a do **painel** — um token efêmero daquele processo,
 * necessário para o Electron verificar o health; ela deixa de valer quando o
 * serviço reinicia, porque o token nasce com o processo.
 *
 * ## Por que a credencial fica num arquivo e não em argumento
 *
 * Argumentos de processo são visíveis para qualquer usuário da máquina (no
 * Linux, `/proc/<pid>/cmdline`; no Windows, a listagem de processos). Um
 * arquivo `0600` na pasta do usuário não é.
 *
 * ## Versão de protocolo
 *
 * `PROTOCOL_VERSION` muda quando a forma do arquivo ou o contrato do health
 * mudam de um jeito que um cliente antigo não entende. O cliente compara e
 * recusa uma versão diferente em vez de "tentar mesmo assim".
 */
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { writeFileAtomic } from '../adapters/local/writeFileAtomic';

/** O nome do arquivo, dentro da raiz de dados. */
export const SERVICE_FILE = 'service.json';

/** O dono lê e escreve; mais ninguém. */
const OWNER_ONLY = 0o600;

/**
 * A versão do contrato de descoberta.
 *
 * 1: `service.json` com `pid`, `port`, `startedAt`, `token`, `protocol`.
 * 2: acrescenta `readerToken` — a credencial que só lê.
 * 3: acrescenta `chatToken` — a credencial que executa turnos (R4C). Um cliente da versão
 *    1 que encontre este arquivo não sabe que o token do painel é poderoso
 *    demais para o uso dele; recusar por versão é o caminho seguro, e é o
 *    que o campo faz.
 */
export const PROTOCOL_VERSION = 3;

/** O que o serviço grava ao subir. */
export interface ServiceRecord {
	readonly version: 1;
	/** A versão do contrato, para o cliente recusar o que não entende. */
	readonly protocol: number;
	/** O processo dono do Core e da raiz. */
	readonly pid: number;
	/** A porta de `127.0.0.1` em que ele escuta. */
	readonly port: number;
	/** Quando ele começou (ISO), para a mensagem de recusa. */
	readonly startedAt: string;
	/** A versão do produto, para o health e para o usuário. */
	readonly appVersion: string;
	/**
	 * A credencial de painel daquele processo.
	 *
	 * Efêmera: muda a cada arranque. Serve para verificar que quem respondeu
	 * é este serviço e para administrá-lo (encerrar). Ela autoriza
	 * **escrita**: um cliente que só precisa ler usa `readerToken`.
	 */
	readonly token: string;
	/**
	 * A credencial de **leitura** daquele processo.
	 *
	 * Vale em `/api/health` e nas rotas de leitura do painel — e em nada
	 * mais. Existe para que um cliente que só consulta estado e catálogo não
	 * precise carregar o token que também escreve provedores e encerra o
	 * serviço.
	 */
	readonly readerToken: string;
	/**
	 * A credencial de **conversa** (R4C).
	 *
	 * Executa turnos: envia a mensagem, recebe os eventos e responde
	 * permissões. Não administra: não escreve provedor, não encerra o serviço
	 * e não lê configuração. Vale só em `/api/chat/*`.
	 */
	readonly chatToken: string;
	/** O endereço, sempre loopback. */
	readonly address: string;
}

/** O que a leitura encontrou. */
export type ServiceRecordRead =
	| { readonly kind: 'absent' }
	| { readonly kind: 'ok'; readonly record: ServiceRecord }
	/** O arquivo existe e não é legível/compatível. */
	| { readonly kind: 'invalid'; readonly reason: string }
	/** Versão de protocolo diferente da deste cliente. */
	| { readonly kind: 'incompatible'; readonly protocol: number };

/** O caminho do arquivo de estado. */
export function serviceRecordPath(root: string): string {
	return join(root, SERVICE_FILE);
}

/** Grava o registro. Atômico, dono-apenas. */
export async function writeServiceRecord(root: string, record: ServiceRecord): Promise<void> {
	await writeFileAtomic(serviceRecordPath(root), `${JSON.stringify(record, null, 2)}\n`, {
		mode: OWNER_ONLY,
	});
}

/**
 * Apaga o registro, **só** se ele ainda for deste processo.
 *
 * Evita que um serviço que está encerrando apague o registro de um sucessor
 * que já subiu — o mesmo cuidado que o lock tem com o handle.
 */
export async function removeServiceRecord(root: string, pid: number): Promise<boolean> {
	const read = await readServiceRecord(root);
	if (read.kind !== 'ok' || read.record.pid !== pid) {
		return false;
	}
	await rm(serviceRecordPath(root), { force: true });
	return true;
}

/**
 * Apaga um registro que **não é confiável** (ilegível).
 *
 * Separado de `removeServiceRecord` porque não há pid a conferir: o arquivo
 * nem diz de quem é. Quem chama só faz isso depois de tomar a raiz, então o
 * arquivo não pode ser de um serviço vivo — se fosse, ele teria o lock.
 */
export async function clearInvalidServiceRecord(root: string): Promise<boolean> {
	const read = await readServiceRecord(root);
	if (read.kind !== 'invalid') {
		return false;
	}
	await rm(serviceRecordPath(root), { force: true });
	return true;
}

/** Lê o registro, sem falar com o servidor. */
export async function readServiceRecord(root: string): Promise<ServiceRecordRead> {
	let raw: string;
	try {
		raw = await readFile(serviceRecordPath(root), 'utf8');
	} catch (error) {
		const code = (error as { readonly code?: unknown }).code;
		return code === 'ENOENT' ? { kind: 'absent' } : { kind: 'invalid', reason: 'não foi possível ler o registro do serviço' };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { kind: 'invalid', reason: 'o registro do serviço não é JSON válido' };
	}
	if (parsed === null || typeof parsed !== 'object') {
		return { kind: 'invalid', reason: 'o registro do serviço não é um objeto' };
	}
	const record = parsed as Record<string, unknown>;
	if (record['version'] !== 1) {
		return { kind: 'invalid', reason: 'versão de arquivo desconhecida' };
	}
	const protocol = record['protocol'];
	if (typeof protocol !== 'number') {
		return { kind: 'invalid', reason: 'o registro não diz a versão do protocolo' };
	}
	if (protocol !== PROTOCOL_VERSION) {
		return { kind: 'incompatible', protocol };
	}
	const pid = record['pid'];
	const port = record['port'];
	const startedAt = record['startedAt'];
	const token = record['token'];
	const readerToken = record['readerToken'];
	const chatToken = record['chatToken'];
	const appVersion = record['appVersion'];
	const address = record['address'];
	if (
		typeof pid !== 'number' ||
		!Number.isInteger(pid) ||
		pid <= 0 ||
		typeof port !== 'number' ||
		!Number.isInteger(port) ||
		port <= 0 ||
		port > 65_535 ||
		typeof startedAt !== 'string' ||
		typeof token !== 'string' ||
		token.length < 32 ||
		typeof readerToken !== 'string' ||
		readerToken.length < 32 ||
		typeof chatToken !== 'string' ||
		chatToken.length < 32 ||
		typeof appVersion !== 'string' ||
		typeof address !== 'string'
	) {
		return { kind: 'invalid', reason: 'o registro do serviço está incompleto' };
	}
	// As duas credenciais não podem ser a mesma: se forem, "só leitura" não é
	// uma restrição, é um nome.
	if (readerToken === token) {
		return { kind: 'invalid', reason: 'o registro usa a mesma credencial para painel e leitura' };
	}
	// Três credenciais de poderes diferentes; repetir uma delas seria dar o
	// poder da mais forte a quem deveria ter a mais fraca.
	if (chatToken === token || chatToken === readerToken) {
		return { kind: 'invalid', reason: 'o registro repete uma credencial entre painel, leitura e conversa' };
	}
	// Um registro que aponta para fora do loopback é recusado mesmo que o
	// resto esteja certo: o serviço nunca escuta em outra interface.
	if (address !== '127.0.0.1') {
		return { kind: 'invalid', reason: `o registro aponta para "${address}", que não é o loopback` };
	}
	return {
		kind: 'ok',
		record: { version: 1, protocol, pid, port, startedAt, token, readerToken, chatToken, appVersion, address },
	};
}

/**
 * O processo com este pid ainda é **aquele** processo?
 *
 * O pid sozinho não basta: o sistema os reaproveita, e um pid reciclado faria
 * um cliente enviar a credencial a um estranho. A identidade vem do sistema
 * operacional — o momento de criação do processo — e é comparada com o
 * `startedAt` gravado pelo serviço com tolerância, porque o registro é
 * escrito alguns milissegundos depois do arranque.
 *
 * Onde a API não deixa ler a criação do processo (Linux sem `/proc`, por
 * exemplo), a resposta é "não sei" — e o chamador trata "não sei" como
 * **inseguro**, não como "vivo".
 */
export type ProcessIdentity =
	| { readonly kind: 'alive'; readonly startedAtMs?: number }
	| { readonly kind: 'dead' }
	| { readonly kind: 'unknown' };

/** A tolerância entre o arranque real e o `startedAt` do registro. */
export const IDENTITY_TOLERANCE_MS = 10 * 60_000;

/**
 * Lê a identidade de um processo, pelo sistema.
 *
 * O `startedAt` é aproximado e usado só como *indício*: o serviço grava o
 * registro segundos depois de subir, então comparar com uma tolerância de
 * minutos separa "mesmo processo" de "pid reciclado", que aparece horas ou
 * dias depois.
 */
export async function processIdentity(
	pid: number,
	options: { readonly getProcessStartMs?: (pid: number) => Promise<number | undefined> } = {},
): Promise<ProcessIdentity> {
	if (!Number.isInteger(pid) || pid <= 0) {
		return { kind: 'dead' };
	}
	let alive: boolean;
	try {
		process.kill(pid, 0);
		alive = true;
	} catch (error) {
		const code = (error as { readonly code?: unknown }).code;
		if (code === 'ESRCH') {
			return { kind: 'dead' };
		}
		// EPERM: existe, e é de outro usuário. Não é o nosso serviço, e não
		// temos permissão para chamá-lo — "desconhecido" é a resposta certa.
		return { kind: 'unknown' };
	}
	if (!alive) {
		return { kind: 'dead' };
	}
	if (options.getProcessStartMs === undefined) {
		return { kind: 'alive' };
	}
	try {
		const startedAtMs = await options.getProcessStartMs(pid);
		return startedAtMs === undefined ? { kind: 'alive' } : { kind: 'alive', startedAtMs };
	} catch {
		return { kind: 'alive' };
	}
}
