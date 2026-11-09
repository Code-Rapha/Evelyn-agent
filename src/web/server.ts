/**
 * O servidor HTTP local, mínimo.
 *
 * ## O que ele é
 *
 * Um socket em `127.0.0.1` que serve os arquivos da interface e um único
 * endpoint de leitura, o health. Nada mais: sem escrita, sem provedores, sem
 * chat, sem SSE, sem Combos. É a fase que prova que a porta certa escuta, que
 * o navegador errado não entra e que o arquivo errado não sai.
 *
 * ## As camadas, nesta ordem
 *
 * 1. **Sessão** — a requisição traz o token? Pelo header, pela URL do primeiro
 *    acesso ou pelo cookie. Os arquivos da página abrem a sessão; a API exige
 *    um dos três em toda requisição;
 * 2. **Host e Origin** — quem fala é este servidor? Recusa `403`;
 * 3. **Rota** — só `GET`/`HEAD`; só `/api/health` e os arquivos permitidos;
 * 4. **Estáticos** — o caminho é resolvido por segmento e o arquivo é lido de
 *    dentro da pasta pública, nunca fora dela.
 *
 * As regras puras estão em `policy.ts` e `health.ts`, testáveis sem porta.
 *
 * ## Sem dependência
 *
 * `node:http`, `node:fs/promises`, `node:crypto`, `node:path`. O servidor não
 * importa `electron` e não sabe que existe um.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';

import type { AssembledCore } from '../app/assemble';
import type { OpencodeManager } from '../app/opencodeManager';
import type { OpencodeCatalogService } from '../app/opencodeCatalogService';
import type { OpencodeChatController } from './opencodeChat';
import {
	ALLOWED_EXTENSIONS,
	BASE_HEADERS,
	CONTENT_SECURITY_POLICY,
	DEFAULT_WEB_PORT,
	LOOPBACK_ADDRESS,
	contentTypeFor,
	evaluateRequest,
	isTokenValid,
	resolveStaticPath,
} from './policy';
import { buildHealth, jsonHeaders } from './health';
import { WebApi } from './api';
import { ProviderWrites } from './providerWrites';
import { DiscoveryWrites } from './modelDiscovery';
import { RoutingSettings } from './routingSettings';
import { CatalogWrites } from './catalogWrites';import { resetReply, resetRouterConfig } from './routerReset';
import { OpencodeWrites } from './opencodeWrites';
import type { WebChatEndpoint } from './chatEndpoint';
import type { TurnRecordStatus, TurnRecordStore } from '../core/storage/turnRecords';
import { TurnRecordCorruptError } from '../core/storage/turnRecords';
import type { ApiChatEvent, ApiChatRuntime } from './apiChat';
import {
	chunkBody,
	chatCompletionsReply,
	listModelsReply,
	openStream,
	readApiBody,
	writeJson,
	writeJsonError,
	type ApiModelEntry,
} from './openaiApi';

/**
 * A tabela de rotas de leitura.
 *
 * Explícita, e não derivada do nome: um caminho novo só existe se estiver
 * aqui, e cada um aponta para um método de leitura de `WebApi`. Não há rota
 * de escrita, e não há como uma ser adicionada sem que este mapa mude.
 */
export const API_ROUTES: Readonly<Record<string, keyof WebApi>> = {
	'/api/capabilities': 'capabilities',
	'/api/overview': 'overview',
	'/api/providers': 'providers',
	'/api/models': 'models',
	'/api/models/catalog': 'catalog',
	'/api/integrations': 'integrations',
	'/api/routing': 'routing',
	'/api/usage': 'usage',
	'/api/settings': 'settings',
};

/**
 * As escrituras de provider — as únicas operações que gravam nesta fase.
 *
 * Todas exigem sessão, Host e Origin, como as leituras; e todas são métodos
 * que já existiam no Core. A tabela é explícita pelo mesmo motivo da de
 * leitura: um caminho novo só existe se estiver aqui.
 */
export const PROVIDER_ROUTES: Readonly<Record<string, keyof ProviderWrites>> = {
	'/api/providers/save': 'save',
	'/api/providers/enabled': 'setEnabled',
	'/api/providers/role': 'setRole',
	'/api/providers/remove': 'remove',
	'/api/providers/test': 'test',
};

/**
 * As escrituras de descoberta: perguntar aos provedores e reler o catálogo.
 *
 * `discover` grava no registro de descoberta — é por isso que é POST. O
 * `catalog` vem por GET, na tabela de leitura, e conta como leitura: só
 * devolve o que já foi gravado.
 */
export const DISCOVERY_ROUTES: Readonly<Record<string, 'discover'>> = {
	'/api/models/discover': 'discover',
};

/**
 * A escrita do **catálogo declarado** (DEV-8.15): adicionar/editar e remover
 * modelos que o usuário digita. Só POST; a leitura é `GET /api/models/catalog`.
 */
export const CATALOG_WRITE_ROUTES: Readonly<Record<string, 'save' | 'remove'>> = {
	'/api/models/catalog/save': 'save',
	'/api/models/catalog/remove': 'remove',
};

/**
 * A escrita do roteador: uma rota, um verbo, o mesmo `changeRouterConfig` do
 * desktop. Só POST — ler a configuração é `GET /api/routing`.
 */
export const ROUTING_ROUTES: Readonly<Record<string, 'save'>> = {
	'/api/routing/save': 'save',
};

/**
 * A redefinição do roteador.
 *
 * Rota própria, com POST: é o **reparo** do arquivo ilegível, e não um
 * caminho paralelo para salvar. A resposta 409 do `save` continua valendo.
 */
export const ROUTER_RESET_ROUTE = '/api/routing/reset';

/**
 * O pedido de encerramento do serviço.
 *
 * `POST`, com a credencial do painel (a mesma do `service.json`). Não é uma
 * rota de cliente: uma chave de `/v1` não encerra o serviço do usuário.
 */
export const SERVICE_SHUTDOWN_ROUTE = '/api/service/shutdown';

/**
 * As ações do OpenCode. `status` é `GET`, na tabela própria; as demais são
 * `POST` e gravam ou iniciam processo — por isso exigem sessão como as outras
 * escrituras.
 */
export const OPENCODE_WRITE_ROUTES: Readonly<Record<string, keyof OpencodeWrites>> = {
	'/api/opencode/connect-managed': 'connectManaged',
	'/api/opencode/connect-manual': 'connectManual',
	'/api/opencode/disconnect': 'disconnect',
	'/api/opencode/check': 'check',
	'/api/opencode/catalog/refresh': 'refreshCatalog',
};

/**
 * A conversa com o OpenCode: começar/soltar um turno, parar, escolher modelo.
 *
 * Todas são escritas de estado (a conversa em memória e o turno no servidor).
 * A **leitura** das conversas é `GET /api/opencode/chat`.
 */
export const OPENCODE_CHAT_ROUTES: Readonly<Record<string, 'send' | 'stop' | 'selectModel' | 'discard'>> = {
	'/api/opencode/chat/send': 'send',
	'/api/opencode/chat/stop': 'stop',
	'/api/opencode/chat/model': 'selectModel',
	'/api/opencode/chat/discard': 'discard',
};

/** A leitura das conversas abertas. */
export const OPENCODE_CHAT_ROUTE = '/api/opencode/chat';

/** O estado do OpenCode, só leitura. */
export const OPENCODE_STATUS_ROUTE = '/api/opencode/status';

/** O que o servidor precisa para subir. */
export interface WebServerOptions {
	/** A versão do app, para o health. */
	readonly version: string;
	/** A pasta com os arquivos estáticos da interface. */
	readonly assetsDir: string;
	/** A montagem do Core, quando ela existir. Na Fase 1, `undefined`. */
	readonly core?: AssembledCore;
	/** O host dono da raiz, quando há um (`desktop`, `web`, …). */
	readonly storageHost?: string;
	/** A porta. `0` pede uma livre — e é o que os testes usam. */
	readonly port?: number;
	/** O nome que o health reporta. */
	readonly appName?: string;
	/**
	 * O gerenciador do servidor OpenCode, quando este host pode ter um.
	 *
	 * Só o host dono da raiz o instancia; sem ele, as rotas do OpenCode
	 * respondem `404` em vez de fingir um estado.
	 */
	readonly opencode?: OpencodeManager;
	/** A descoberta do catálogo do OpenCode (Fase 4D), quando o host a tem. */
	readonly opencodeCatalog?: OpencodeCatalogService;
	/**
	 * O registro de turnos, para a tela de diagnóstico (R4J).
	 *
	 * O mesmo store que o endpoint de conversa usa — recuperado e retido na
	 * inicialização. Ausente em host que não tem turnos: a rota responde `404`
	 * em vez de inventar uma lista vazia.
	 */
	readonly turns?: TurnRecordStore;
	/** As conversas do OpenCode (Fase 4E), quando o host as tem. */
	readonly opencodeChat?: OpencodeChatController;
	/**
	 * A superfície compatível com a API OpenAI (R2), quando este host a tem.
	 *
	 * Separada das demais rotas porque a credencial é outra: `/v1` aceita
	 * apenas `Authorization: Bearer` de uma chave de **cliente** (R1), e
	 * nunca a sessão do painel.
	 */
	readonly openai?: OpenAiEndpoint;
	/**
	 * O que fazer quando **este** processo é pedido a encerrar.
	 *
	 * Só o serviço que é dono da raiz o informa. A rota é autenticada com a
	 * credencial do painel — a mesma que o `service.json` guarda —, porque é
	 * o único segredo que prova "quem pede é o dono desta instalação".
	 *
	 * Existe porque no Windows não há sinal tratável: `process.kill(pid,
	 * 'SIGTERM')` termina à força, sem o `close` do host rodar, e o lock
	 * ficaria para trás. Um pedido HTTP deixa o processo limpar antes de sair.
	 */
	readonly requestShutdown?: () => void;
	/**
	 * A credencial de **leitura** — só o `desktop-host` a usa.
	 *
	 * Ausente: nenhum cliente de leitura é aceito (o comportamento anterior).
	 * Presente: vale em `/api/health` e nas rotas da tabela `API_ROUTES`, e
	 * em nada mais. É um segredo separado do token do painel de propósito: o
	 * token do painel autoriza escritas e encerramento, e um cliente que só
	 * precisa ler não deve poder fazer o resto.
	 */
	readonly readerToken?: string;
	/**
	 * A credencial de **conversa** (R4C).
	 *
	 * Vale só em `/api/chat/*`: executar um turno e responder a permissão
	 * dele. Ausente = nenhum cliente de conversa é aceito.
	 */
	readonly chatToken?: string;
	/**
	 * O que oferta os turnos (R4C). Ausente = `/api/chat` não existe.
	 */
	readonly chat?: WebChatEndpoint;
	readonly now?: () => number;
}

/** O que a rota `/v1` precisa, já montado pelo host. */
export interface OpenAiEndpoint {
	/** Verifica a chave apresentada e devolve o que ela pode fazer. */
	readonly authenticate: (
		presented: string | undefined,
	) => Promise<{ readonly keyId: string; readonly scopes: readonly string[] } | undefined>;
	/** O cliente de chat, por requisição. */
	readonly runtime: ApiChatRuntime;
	/** O catálogo real. */
	readonly listModels: () => Promise<readonly ApiModelEntry[]>;
}

/** O servidor no ar. */
export interface RunningWebServer {
	readonly port: number;
	/** O endereço em que o socket está de fato escutando. */
	readonly address: string;
	/** O token de sessão, para o dono abrir o navegador no primeiro acesso. */
	readonly token: string;
	/**
	 * O token de leitura, quando o host o oferece.
	 *
	 * Separado de `token` porque autoriza menos. Ausente = o host não aceita
	 * cliente de leitura.
	 */
	readonly readerToken?: string;
	/** A URL de entrada: a raiz, com o token na query uma única vez. */
	readonly entryUrl: string;
	close(): Promise<void>;
}

/** O token na URL não sobrevive à primeira visita: a página o tira da barra. */
export const TOKEN_QUERY_PARAMETER = 't';

/** O header em que a página apresenta a sessão depois do primeiro acesso. */
export const TOKEN_HEADER = 'x-seshyina-token';

/**
 * O header da credencial de **leitura**.
 *
 * Separado do cabeçalho da sessão do painel de propósito: trocar um pelo
 * outro, por engano, passaria despercebido — e o cliente de leitura teria a
 * credencial que escreve.
 */
export const READER_TOKEN_HEADER = 'x-seshyina-reader';

/**
 * O header da credencial de **conversa** (R4C).
 *
 * Terceiro header, terceiro poder. Ela executa turnos e responde a permissão
 * do próprio turno; não lê configuração, não escreve e não encerra. Um
 * header separado é o que impede que a ampliação acidental de `readerToken`
 * dê conversa a quem só precisava de catálogo.
 */
export const CHAT_TOKEN_HEADER = 'x-seshyina-chat';

/** As rotas da conversa. */
export const CHAT_TURN_ROUTE = '/api/chat/turn';
export const CHAT_CANCEL_ROUTE = '/api/chat/cancel';
export const CHAT_ANSWER_ROUTE = '/api/chat/answer';
/** R4D: o histórico conversa a conversa. */
export const CHAT_CONVERSATIONS_ROUTE = '/api/chat/conversations';
export const CHAT_CONVERSATION_ROUTE = '/api/chat/conversation';
/** R4E: criar uma conversa. */
export const CHAT_CREATE_ROUTE = '/api/chat/create';
/** R4F: renomear e excluir. */
export const CHAT_RENAME_ROUTE = '/api/chat/rename';
export const CHAT_DELETE_ROUTE = '/api/chat/delete';
/** R4H: o estado dos turnos de uma conversa. */
export const CHAT_TURN_STATE_ROUTE = '/api/chat/turn-state';

/** R4J: a consulta do diagnóstico de turnos. */
export const TURNS_DIAGNOSTIC_ROUTE = '/api/turns';

/** R4K: a recuperação de um registro corrompido. */
export const TURNS_BACKUP_ROUTE = '/api/turns/recover/backup';
export const TURNS_RESET_ROUTE = '/api/turns/recover/reset';

/** O teto de itens por página do diagnóstico. */
const MAX_DIAGNOSTIC_LIMIT = 200;
/** O padrão, quando o cliente não pede. */
const DEFAULT_DIAGNOSTIC_LIMIT = 50;

/** Os estados aceitos no filtro, mais `all`. */
const DIAGNOSTIC_STATUSES: readonly (TurnRecordStatus | 'all')[] = [
	'all',
	'running',
	'completed',
	'failed',
	'cancelled',
	'interrupted',
];

/** O comprimento máximo de um id de conversa aceito na rota de detalhe. */
const MAX_CONVERSATION_ID_CHARS = 200;
/** O comprimento máximo de um título aceito na criação. */
const MAX_TITLE_CHARS = 200;

/**
 * Campos que a criação de conversa pelo serviço **não** aceita.
 *
 * - `projectId`: escolhe o diretório das ferramentas neste processo;
 * - `systemPrompt`: instrução privada do dono dos dados;
 * - `id` / `path`: o id nasce no store, e caminho não existe nesta API.
 */
const REFUSED_CREATE_FIELDS = ['projectId', 'systemPrompt', 'id', 'path'] as const;

/**
 * O teto de texto de um turno (R4C).
 *
 * O mesmo porte do teto de corpo de `/v1`; declarado aqui porque o corpo de
 * um turno pode chegar como JSON de 1 MiB e o texto ainda precisa de um
 * limite próprio, legível na mensagem de erro.
 */
const MAX_CHAT_TEXT_CHARS = 200_000;

/**
 * Lê `Authorization: Bearer <chave>`.
 *
 * Só este header. Uma chave de cliente na URL, na query ou em cookie fica no
 * histórico do cliente e em logs de proxy, e o servidor não controla nenhum
 * dos dois — então essa forma não existe aqui. O esquema é comparado sem
 * diferenciar maiúsculas, como a RFC 7235 exige.
 */
export function bearerFrom(header: string | undefined): string | undefined {
	if (typeof header !== 'string') {
		return undefined;
	}
	const match = /^\s*Bearer\s+(\S+)\s*$/i.exec(header);
	return match === null ? undefined : match[1];
}

/** O corpo é JSON? `/v1` recusa um `text/plain` que finge ser JSON. */
export function isJsonContentType(header: string | string[] | undefined): boolean {
	const value = Array.isArray(header) ? header[0] : header;
	if (typeof value !== 'string') {
		return false;
	}
	return /^application\/(?:[\w.+-]*\+)?json\b/i.test(value.trim());
}

/**
 * O cookie com a sessão.
 *
 * Existe porque o navegador pede a folha e o script sozinho, sem header
 * nenhum. `HttpOnly` para o script não poder lê-lo, `SameSite=Strict` para
 * não acompanhar uma navegação vinda de outro site.
 */
export const TOKEN_COOKIE = 'seshyina_session';

/**
 * Um token novo: 32 bytes aleatórios, em hex.
 *
 * `randomBytes` da crypto do Node, e não `Math.random`: este valor é a
 * diferença entre "só o dono do processo abre a interface" e "qualquer
 * página aberta consegue".
 */
export function createSessionToken(): string {
	return randomBytes(32).toString('hex');
}

/** Compara dois tokens sem sair no primeiro byte diferente. */
export function tokensMatch(presented: string | undefined, expected: string): boolean {	if (presented === undefined || expected.length === 0) {
		return false;
	}
	const left = Buffer.from(presented, 'utf8');
	const right = Buffer.from(expected, 'utf8');
	if (left.length !== right.length) {
		return false;
	}
	return timingSafeEqual(left, right);
}

/**
 * O header do cookie de sessão.
 *
 * Vai em toda resposta, inclusive nas recusas: quem abriu a página pelo
 * `/?t=` recebe o cookie junto com ela, e as requisições seguintes do
 * navegador (folha, script, API) são autenticadas por ele.
 */
function sessionCookieHeader(token: string): Record<string, string> {
	return { 'Set-Cookie': `${TOKEN_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/` };
}

/** Onde o token pode vir: header, a URL do primeiro acesso, ou o cookie. */
function tokenFrom(request: IncomingMessage, url: URL): string | undefined {
	const header = request.headers[TOKEN_HEADER];
	if (typeof header === 'string' && header.length > 0) {
		return header;
	}
	// A credencial de leitura vem no próprio header, nunca na query nem em
	// cookie. Ela é conferida depois contra o token de leitura; se não bater,
	// a requisição não tem sessão — não há queda para o cookie do painel, ou
	// um pedido com as duas credenciais misturadas passaria.
	const reader = request.headers[READER_TOKEN_HEADER];
	if (typeof reader === 'string' && reader.length > 0) {
		return reader;
	}
	// O de conversa (R4C), pelo mesmo motivo: no header, nunca na URL.
	const chat = request.headers[CHAT_TOKEN_HEADER];
	if (typeof chat === 'string' && chat.length > 0) {
		return chat;
	}
	const fromQuery = url.searchParams.get(TOKEN_QUERY_PARAMETER);
	if (fromQuery !== null && fromQuery.length > 0) {
		return fromQuery;
	}
	return cookieValue(request.headers.cookie, TOKEN_COOKIE);
}

/** O valor de um cookie do header `Cookie`. */
function cookieValue(header: string | undefined, name: string): string | undefined {
	if (header === undefined) {
		return undefined;
	}
	for (const part of header.split(';')) {
		const separator = part.indexOf('=');
		if (separator < 0) {
			continue;
		}
		if (part.slice(0, separator).trim() === name) {
			const value = part.slice(separator + 1).trim();
			return value.length > 0 ? value : undefined;
		}
	}
	return undefined;
}

/** Uma resposta sem corpo útil: o status é a mensagem. */
/**
 * Lê o corpo de um POST como JSON.
 *
 * Com teto de tamanho: um corpo sem limite numa API local é uma forma fácil
 * de o processo ficar sem memória. O teto é generoso para o que a interface
 * envia — alguns campos de texto — e pequeno para tudo o mais.
 */
async function readJsonBody(
	request: IncomingMessage,
): Promise<{ readonly kind: 'ok'; readonly value: unknown } | { readonly kind: 'invalid'; readonly reason: string }> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
		size += buffer.length;
		if (size > MAX_BODY_BYTES) {
			return { kind: 'invalid', reason: 'corpo grande demais' };
		}
		chunks.push(buffer);
	}
	if (size === 0) {
		return { kind: 'invalid', reason: 'corpo vazio' };
	}
	try {
		return { kind: 'ok', value: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
	} catch {
		return { kind: 'invalid', reason: 'corpo não é JSON' };
	}
}

/** O teto do corpo de um POST. */
const MAX_BODY_BYTES = 64 * 1024;

function refuse(response: ServerResponse, status: number, token: string | undefined): void {
	response.writeHead(status, {
		...BASE_HEADERS,
		...(token !== undefined ? sessionCookieHeader(token) : {}),
		'Content-Type': 'text/plain; charset=utf-8',
		'Content-Length': '0',
	});
	response.end();
}

function sendJson(
	response: ServerResponse,
	status: number,
	body: unknown,
	token: string,
): void {
	const payload = `${JSON.stringify(body)}\n`;
	response.writeHead(status, {
		...BASE_HEADERS,
		...sessionCookieHeader(token),
		...jsonHeaders(),
		'Content-Length': String(Buffer.byteLength(payload, 'utf8')),
	});
	response.end(payload);
}

/**
 * Lê um arquivo de dentro da pasta pública.
 *
 * A pasta é resolvida primeiro e o caminho dela é comparado ao resolvido: se
 * um symlink apontar para fora, o arquivo real não começa com a pasta real e
 * a leitura é recusada. A checagem de segmento em `resolveStaticPath` já
 * barra `..`; esta barra o que só aparece depois de resolver o link.
 */
async function readStatic(
	assetsDir: string,
	relative: string,
): Promise<{ readonly body: Buffer; readonly type: string } | undefined> {
	const extension = extname(relative).toLowerCase();
	if (!ALLOWED_EXTENSIONS.includes(extension)) {
		return undefined;
	}
	const type = contentTypeFor(relative);
	if (type === undefined) {
		return undefined;
	}
	const base = normalize(assetsDir);
	const full = normalize(join(base, relative));
	if (full !== base && !full.startsWith(`${base}${sep}`)) {
		return undefined;
	}
	try {
		const info = await stat(full);
		if (!info.isFile()) {
			return undefined;
		}
		const body = await readFile(full);
		return { body, type };
	} catch {
		// Ausente e ilegível são a mesma resposta: não há arquivo.
		return undefined;
	}
}

/** Serve um arquivo, com os headers fixos e um ETag barato. */
function sendFile(
	response: ServerResponse,
	body: Buffer,
	type: string,
	headOnly: boolean,
	token: string,
): void {
	const etag = `"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`;
	response.writeHead(200, {
		...BASE_HEADERS,
		...sessionCookieHeader(token),
		'Content-Type': type,
		'Content-Length': String(body.length),
		ETag: etag,
	});
	if (headOnly) {
		response.end();
		return;
	}
	response.end(body);
}

/**
 * O servidor, montado mas não escutando.
 *
 * Separado de `startWebServer` porque quem escuta é uma decisão do host — e
 * porque um teste quer a função de requisição sem abrir porta.
 */
export function createWebServer(options: WebServerOptions): {
	readonly server: Server;
	readonly token: string;
	/** A porta em que o socket está de fato, depois de `listen`. */
	readonly actualPort: () => number;
} {
	const token = createSessionToken();
	/**
	 * O token de leitura, gerado por este processo.
	 *
	 * Um valor vazio quando o host não oferece leitura: `tokensMatch` nunca
	 * aceita um token vazio, então "não oferece" e "não aceita nada" são a
	 * mesma coisa, sem um caminho alternativo para esquecer de checar.
	 */
	const readerToken = options.readerToken ?? '';
	/** O token de conversa (R4C). Vazio = nenhum cliente de conversa. */
	const chatToken = options.chatToken ?? '';
	const startedAt = (options.now ?? Date.now)();

	const server = createServer((request, response) => {
		void handle(request, response).catch(() => {
			// Qualquer coisa que escape das regras é um 500 sem detalhe: a
			// mensagem de erro de um servidor local conta caminhos.
			if (!response.headersSent) {
				refuse(response, 500, undefined);
			} else {
				response.destroy();
			}
		});
	});

	async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const method = request.method ?? 'GET';
		const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
		// A superfície OpenAI tem regras de verbo próprias (`/v1/models` é GET,
		// `/v1/chat/completions` é POST) e responde `405` no formato JSON dela,
		// não no 405 vazio do painel. Por isso é resolvida antes da tabela.
		if (pathname === '/v1' || pathname.startsWith('/v1/')) {
			await handleOpenAi(request, response, pathname, method);
			return;
		}
		// Um caminho é de escrita ou de leitura, nunca os dois. No de escrita,
		// só POST; no de leitura, só GET/HEAD. O 405 diz o que aquela rota
		// aceita — e POST num caminho de leitura continua recusado.
		const writesHere =
			PROVIDER_ROUTES[pathname] !== undefined ||
			DISCOVERY_ROUTES[pathname] !== undefined ||
			CATALOG_WRITE_ROUTES[pathname] !== undefined ||
			ROUTING_ROUTES[pathname] !== undefined ||
			OPENCODE_WRITE_ROUTES[pathname] !== undefined ||
			OPENCODE_CHAT_ROUTES[pathname] !== undefined ||
			pathname === ROUTER_RESET_ROUTE ||
			pathname === SERVICE_SHUTDOWN_ROUTE ||
			// R4C: as rotas de conversa são POST.
			pathname === CHAT_TURN_ROUTE ||
			pathname === CHAT_CANCEL_ROUTE ||
			pathname === CHAT_ANSWER_ROUTE ||
			pathname === CHAT_CONVERSATIONS_ROUTE ||
			pathname === CHAT_CONVERSATION_ROUTE ||
			pathname === CHAT_CREATE_ROUTE ||
			pathname === CHAT_RENAME_ROUTE ||
			pathname === CHAT_DELETE_ROUTE ||
			pathname === CHAT_TURN_STATE_ROUTE ||
			// R4K: a recuperação do registro de turnos. Estão aqui para o
			// guarda de verbo deixá-las chegar à rota (que confere a
			// credencial de painel por si).
			pathname === TURNS_BACKUP_ROUTE ||
			pathname === TURNS_RESET_ROUTE;
		const allowed = writesHere ? method === 'POST' : method === 'GET' || method === 'HEAD';
		if (!allowed) {
			response.setHeader('Allow', writesHere ? 'POST' : 'GET, HEAD');
			refuse(response, 405, token);
			return;
		}

		// A porta em uso, lida do socket e não das opções: `listen(0)` escolhe
		// uma depois, e o Host de quem conecta traz a porta real.
		const activePort = actualPort();
		const url = new URL(request.url ?? '/', `http://127.0.0.1:${activePort}`);

		// 1. Quem fala: o Host e a Origin são deste servidor?
		const verdict = evaluateRequest(
			{
				hostHeader: request.headers.host,
				originHeader: request.headers.origin,
			},
			activePort,
		);
		if (!verdict.ok) {
			refuse(response, verdict.status, token);
			return;
		}

		const presented = tokenFrom(request, url);
		/**
		 * A credencial apresentada é a do painel?
		 *
		 * O valor é o do painel **e** veio por um dos caminhos da sessão:
		 * header, query do primeiro acesso ou cookie. O header de leitura não
		 * é um deles — o token de leitura colocado em `x-seshyina-token` não
		 * vira sessão do dono. (Trocar o valor de header é a promoção de
		 * privilégio mais fácil de escrever sem perceber.)
		 */
		const isPanel =
			tokensMatch(presented, token) &&
			request.headers[READER_TOKEN_HEADER] !== presented &&
			request.headers[CHAT_TOKEN_HEADER] !== presented;
		/**
		 * A credencial é a de **leitura**?
		 *
		 * Só pelo header de leitura. Ela nunca vale em escrita, nunca vale em
		 * `/v1` e nunca vale em `/api/service/shutdown`.
		 */
		const isReader =
			request.headers[READER_TOKEN_HEADER] === presented && tokensMatch(presented, readerToken);
	/**
	 * A credencial é a de **conversa**?
	 *
	 * Só pelo header dela, e só nas rotas `/api/chat/*`. Não lê o painel,
	 * não escreve, não encerra: executar um turno é tudo o que ela pode.
	 */
	const isChat =
		request.headers[CHAT_TOKEN_HEADER] === presented && tokensMatch(presented, chatToken);

		// 2. A API: a sessão é exigida sempre, por qualquer um dos três

		// O encerramento pedido: só com a credencial do painel, e só quando o
		// host oferece (é o serviço que é dono da raiz).
		if (url.pathname === SERVICE_SHUTDOWN_ROUTE) {
			if (options.requestShutdown === undefined) {
				writeJsonError(response, 404, 'no_candidate', 'este host não oferece encerramento por API');
				return;
			}
			if (method !== 'POST') {
				response.setHeader('Allow', 'POST');
				refuse(response, 405, token);
				return;
			}
			// Só o painel encerra: o token de leitura não vale aqui.
			if (!isPanel) {
				refuse(response, 401, token);
				return;
			}
			// Responde **antes** de encerrar: o cliente precisa saber que o
			// pedido foi aceito, e não ver a conexão morrer sem explicação.
			sendJson(response, 202, { stopping: true, pid: process.pid }, token);
			options.requestShutdown();
			return;
		}

		// A redefinição: o reparo explícito do arquivo ilegível.
		if (url.pathname === ROUTER_RESET_ROUTE) {			if (!tokensMatch(presented, token)) {
				refuse(response, 401, token);
				return;
			}
			if (options.core === undefined) {
				sendJson(response, 404, { error: 'o Core não está montado neste host' }, token);
				return;
			}
			const result = await resetRouterConfig(options.core);
			sendJson(response, resetReply(result).status, resetReply(result).body, token);
			return;
		}

		// A escrita do roteador.
		const routing = ROUTING_ROUTES[url.pathname];
		if (routing !== undefined) {
			if (!tokensMatch(presented, token)) {
				refuse(response, 401, token);
				return;
			}
			const body = await readJsonBody(request);
			if (body.kind === 'invalid') {
				sendJson(response, 400, { error: body.reason }, token);
				return;
			}
			const reply = await new RoutingSettings(options.core)[routing](body.value);
			sendJson(response, reply.status, reply.body, token);
			return;
		}

		// A escrita do catálogo declarado (DEV-8.15).
		const catalogWrite = CATALOG_WRITE_ROUTES[url.pathname];
		if (catalogWrite !== undefined) {
			if (!tokensMatch(presented, token)) {
				refuse(response, 401, token);
				return;
			}
			const body = await readJsonBody(request);
			if (body.kind === 'invalid') {
				sendJson(response, 400, { error: body.reason }, token);
				return;
			}
			const reply = await new CatalogWrites(options.core)[catalogWrite](body.value);
			sendJson(response, reply.status, reply.body, token);
			return;
		}

		// As escrituras de descoberta.
		const discovery = DISCOVERY_ROUTES[url.pathname];
		if (discovery !== undefined) {
			if (method !== 'POST') {
				response.setHeader('Allow', 'POST');
				refuse(response, 405, token);
				return;
			}
			if (!tokensMatch(presented, token)) {
				refuse(response, 401, token);
				return;
			}
			const body = await readJsonBody(request);
			if (body.kind === 'invalid') {
				sendJson(response, 400, { error: body.reason }, token);
				return;
			}
			const reply = await new DiscoveryWrites(options.core)[discovery](body.value);
			sendJson(response, reply.status, reply.body, token);
			return;
		}

		// As escrituras de provider. Só por POST: um GET nelas seria uma
		// operação que acontece quando um link é pré-carregado.
		const write = PROVIDER_ROUTES[url.pathname];
		if (write !== undefined) {
			if (method !== 'POST') {
				response.setHeader('Allow', 'POST');
				refuse(response, 405, token);
				return;
			}
			if (!tokensMatch(presented, token)) {
				refuse(response, 401, token);
				return;
			}
			const body = await readJsonBody(request);
			if (body.kind === 'invalid') {
				sendJson(response, 400, { error: body.reason }, token);
				return;
			}
			const reply = await new ProviderWrites(options.core)[write](body.value);
			sendJson(response, reply.status, reply.body, token);
			return;
		}

		// A conversa com o OpenCode. Só por POST, e sempre com sessão.
		const chatRoute = OPENCODE_CHAT_ROUTES[url.pathname];
		if (chatRoute !== undefined) {
			if (!tokensMatch(presented, token)) {
				refuse(response, 401, token);
				return;
			}
			const read = await readJsonBody(request);
			if (read.kind === 'invalid') {
				sendJson(response, 400, { error: read.reason }, token);
				return;
			}
			if (options.opencodeChat === undefined) {
				sendJson(response, 404, { error: 'a conversa com o OpenCode não existe neste host' }, token);
				return;
			}
			const answer = await options.opencodeChat[chatRoute](read.value);
			// O envio responde um stream (SSE); o resto, JSON.
			const streamed = (answer as { readonly stream?: ReadableStream<Uint8Array> }).stream;
			if (streamed !== undefined) {
				response.writeHead(200, {
					...BASE_HEADERS,
					'Content-Type': 'text/event-stream; charset=utf-8',
					...sessionCookieHeader(token),
				});
				const reader = streamed.getReader();
				response.on('close', () => {
					void reader.cancel().catch(() => undefined);
				});
				void (async () => {
					for (;;) {
						const { done, value } = await reader.read();
						if (done) {
							break;
						}
						if (!response.write(Buffer.from(value))) {
							await new Promise((resolve) => response.once('drain', resolve));
						}
					}
					response.end();
				})().catch(() => response.destroy());
				return;
			}
			sendJson(response, answer.status, answer.body, token);
			return;
		}

		// Uma conversa aberta: só leitura. O id vem no caminho; nada mais.
		const conversationMatch = url.pathname.startsWith(`${OPENCODE_CHAT_ROUTE}/`)
			? /^\/api\/opencode\/chat\/([A-Za-z0-9_-]{1,80})$/.exec(url.pathname)
			: null;
		if (conversationMatch !== null) {
			if (!tokensMatch(presented, token)) {
				refuse(response, 401, token);
				return;
			}
			if (options.opencodeChat === undefined) {
				sendJson(response, 404, { error: 'a conversa com o OpenCode não existe neste host' }, token);
				return;
			}
			const found = await options.opencodeChat.get(conversationMatch[1]);
			sendJson(response, found.status, found.body, token);
			return;
		}

		// As conversas abertas: só leitura.
		if (url.pathname === OPENCODE_CHAT_ROUTE) {
			if (!tokensMatch(presented, token)) {
				refuse(response, 401, token);
				return;
			}
			if (options.opencodeChat === undefined) {
				sendJson(response, 404, { error: 'a conversa com o OpenCode não existe neste host' }, token);
				return;
			}
			const listed = await options.opencodeChat.list();
			sendJson(response, listed.status, listed.body, token);
			return;
		}

		// As ações do OpenCode. `status` é leitura e vem por GET, adiante; o
		// resto inicia processo ou grava, e por isso é POST.
		const opencodeWrite = OPENCODE_WRITE_ROUTES[url.pathname];
		if (opencodeWrite !== undefined) {
			if (!tokensMatch(presented, token)) {
				refuse(response, 401, token);
				return;
			}
			let body: unknown;
			// As ações sem parâmetro aceitam o POST vazio: o caminho é o
			// pedido, e o corpo só existe quando há o que dizer. Com corpo, ele
			// é lido e **validado** também — um parâmetro recusado tem de ser
			// recusado, e não descartado em silêncio.
			const hasBody = !('content-length' in request.headers && request.headers['content-length'] === '0');
			if (opencodeWrite !== 'disconnect' && opencodeWrite !== 'check' && hasBody) {
				const read = await readJsonBody(request);
				if (read.kind === 'invalid') {
					sendJson(response, 400, { error: read.reason }, token);
					return;
				}
				body = read.value;
			}
			const answer = await new OpencodeWrites(options.opencode, options.opencodeCatalog)[opencodeWrite](body);
			sendJson(response, answer.status, answer.body, token);
			return;
		}

		// O estado do OpenCode: só leitura, e nunca sobe processo nem fala
		// com o servidor.
		if (url.pathname === OPENCODE_STATUS_ROUTE) {
			if (!tokensMatch(presented, token)) {
				refuse(response, 401, token);
				return;
			}
			const answer = await new OpencodeWrites(options.opencode, options.opencodeCatalog).status();
			sendJson(response, answer.status, answer.body, token);
			return;
		}

		// 2. A API: a sessão é exigida sempre, por qualquer um dos três
		// caminhos.
		if (url.pathname === '/api/health') {
			// Saúde é leitura: o painel e o token de leitura valem.
			if (!isPanel && !isReader) {
				refuse(response, 401, token);
				return;
			}
			sendJson(
				response,
				200,
				buildHealth({
					app: options.appName ?? 'Evelyn',
					version: options.version,
					port: activePort,
					startedAt,
					coreMounted: options.core !== undefined,
					storageHost: options.storageHost ?? null,
					pid: process.pid,
					...(options.now !== undefined ? { now: options.now } : {}),
				}),
				token,
			);
			return;
		}
		// 2b. A conversa do Desktop conectado (R4C).
		//
		// Vem antes do bloco `/api/` porque a credencial é outra: `chatToken`,
		// e não a sessão do painel nem o leitor. Uma rota de conversa
		// respondida com o leitor seria uma ampliação de privilégio.
		if (
			url.pathname === CHAT_TURN_ROUTE ||
			url.pathname === CHAT_CANCEL_ROUTE ||
			url.pathname === CHAT_ANSWER_ROUTE ||
			url.pathname === CHAT_CONVERSATIONS_ROUTE ||
			url.pathname === CHAT_CONVERSATION_ROUTE ||
			url.pathname === CHAT_CREATE_ROUTE ||
			url.pathname === CHAT_RENAME_ROUTE ||
			url.pathname === CHAT_DELETE_ROUTE ||
			url.pathname === CHAT_TURN_STATE_ROUTE
		) {
			await handleChat(request, response, url.pathname, method, isChat);
			return;
		}

		// R4K: a recuperação do registro corrompido. **Só o painel** — o
		// `readerToken` lê; ele não destrói nem reinicializa nada.
		if (url.pathname === TURNS_BACKUP_ROUTE || url.pathname === TURNS_RESET_ROUTE) {
			if (method !== 'POST') {
				response.setHeader('Allow', 'POST');
				refuse(response, 405, token);
				return;
			}
			if (!isPanel) {
				refuse(response, 401, token);
				return;
			}
			const store = options.turns;
			if (store === undefined) {
				writeJsonError(response, 404, 'no_candidate', 'este host não tem registro de turnos');
				return;
			}
			const backup = url.pathname === TURNS_BACKUP_ROUTE;
			try {
				if (backup) {
					const result = await store.backup();
					sendJson(response, 201, { backup: result.file, bytes: result.bytes }, token);
					return;
				}
				sendJson(response, 200, await store.reset(), token);
				return;
			} catch (error) {
				// Recusar é o resultado normal de uma operação que não se
				// aplica (registro válido, nada a copiar): `409`, com a razão
				// de **classe**. O que vier do sistema de arquivos não sai: a
				// mensagem do Node carrega o caminho absoluto.
				const corrupt = error instanceof TurnRecordCorruptError;
				writeJson(response, 409, {
					error: {
						message: corrupt
							? error.message
							: 'a recuperação não se aplica a este registro',
						type: corrupt ? 'turns_corrupt' : 'conflict',
						code: corrupt ? 'turns_corrupt' : 'conflict',
					},
					...(corrupt ? { reason: error.reason } : {}),
				});
				return;
			}
		}

		// R4J: o diagnóstico de turnos. GET com filtros na query; leitura pura,
		// do registro persistido.
		if (url.pathname === TURNS_DIAGNOSTIC_ROUTE) {
			if (!isPanel && !isReader) {
				refuse(response, 401, token);
				return;
			}
			await handleTurnDiagnostic(response, url);
			return;
		}

		if (url.pathname.startsWith('/api/')) {
			// A API existe: o caminho é resolvido na tabela de rotas. A sessão
			// é exigida em todas — a página e o script abrem a sessão, a API
			// só a usa.
			const route = API_ROUTES[url.pathname];
			if (route === undefined) {
				refuse(response, 404, token);
				return;
			}
			// ## Quem lê
			//
			// O painel lê tudo. O token de leitura lê **apenas** as rotas da
			// tabela `API_ROUTES` — que é, por construção, só leitura: cada
			// entrada aponta para um método de leitura de `WebApi` e o verbo
			// desta tabela é GET/HEAD. Nenhuma escrita mora aqui; as escritas
			// têm tabelas próprias, adiante, e continuam exigindo o painel.
			if (!isPanel && !isReader) {
				refuse(response, 401, token);
				return;
			}
			const reply = await new WebApi(options.core, options.opencode, options.opencodeCatalog)[route]();
			sendJson(response, reply.status, reply.body, token);
			return;
		}

		// 3. Os estáticos. A página e os sub-recursos que ela pede sozinha
		// (`script`, `link`) abrem a sessão: é a URL `/?t=` que a traz, e o
		// cookie que ela recebe é o que mantém as requisições seguintes.
		const relative = resolveStaticPath(url.pathname);
		if (relative === undefined) {
			refuse(response, 404, token);
			return;
		}
		const file = await readStatic(options.assetsDir, relative);
		if (file === undefined) {
			refuse(response, 404, token);
			return;
		}
		if (!tokensMatch(presented, token)) {
			refuse(response, 401, token);
			return;
		}
		sendFile(response, file.body, file.type, method === 'HEAD', token);
	}

	/**
	 * As rotas de conversa.
	 *
	 * ## O que ela valida, e nessa ordem
	 *
	 * 1. o serviço oferece conversa (`options.chat`)?
	 * 2. a credencial é a de conversa?
	 * 3. o método é o da rota?
	 * 4. o corpo tem o contrato (`conversationId`, `providerId`, `model`, `text`)?
	 *
	 * A ordem importa: uma rota que responde "422" antes de autenticar conta a
	 * um cliente sem credencial o que existe do outro lado.
	 */
	async function handleChat(
		request: IncomingMessage,
		response: ServerResponse,
		pathname: string,
		method: string,
		isChat: boolean,
	): Promise<void> {
		const endpoint = options.chat;
		if (endpoint === undefined) {
			writeJsonError(response, 404, 'no_candidate', 'este host não oferece conversa');
			return;
		}
		if (!isChat) {
			writeJsonError(response, 401, 'auth', 'credencial de conversa ausente ou inválida');
			return;
		}
		if (method !== 'POST') {
			response.setHeader('Allow', 'POST');
			writeJsonError(response, 405, 'bad_request', 'esta rota só aceita POST');
			return;
		}
		const body = await readApiBody(request);
		if (body.kind === 'invalid') {
			writeJsonError(response, 400, 'bad_request', body.reason);
			return;
		}
		const input = (body.value ?? {}) as Record<string, unknown>;

		// R4D: o histórico. Leitura pura, com a mesma credencial de conversa —
		// quem conversa precisa ver o que já foi conversado.
		if (pathname === CHAT_TURN_STATE_ROUTE) {
			const id = input['id'];
			if (typeof id !== 'string' || id.length === 0 || id.length > MAX_CONVERSATION_ID_CHARS) {
				writeJsonError(
					response,
					400,
					'bad_request',
					`informe o id da conversa (até ${MAX_CONVERSATION_ID_CHARS} caracteres)`,
				);
				return;
			}
			// R4H: só o ciclo de vida — id, estado e datas. O conteúdo da
			// resposta está no histórico, e o motivo é texto de classe.
			const states = await endpoint.turnStates(id);
			if (states.status === 'unavailable') {
				// R4K: o registro não pode ser lido. Isso **não** é "não há
				// turnos" — é o diagnóstico indisponível, e a interface precisa
				// saber a diferença para não afirmar ausência de interrupções.
				writeJson(
					response,
					200,
					{ turns: [], unavailable: true, reason: states.reason },
				);
				return;
			}
			writeJson(response, 200, { turns: states.turns });
			return;
		}

		if (pathname === CHAT_RENAME_ROUTE) {
			if (!acceptsOnly(input, ['id', 'title'])) {
				writeJsonError(response, 400, 'bad_request', 'a renomeação aceita somente "id" e "title"');
				return;
			}
			const id = input['id'];
			const title = input['title'];
			if (typeof id !== 'string' || id.length === 0 || id.length > MAX_CONVERSATION_ID_CHARS) {
				writeJsonError(
					response,
					400,
					'bad_request',
					`informe o id da conversa (até ${MAX_CONVERSATION_ID_CHARS} caracteres)`,
				);
				return;
			}
			if (typeof title !== 'string' || title.length > MAX_TITLE_CHARS) {
				writeJsonError(response, 400, 'bad_request', `o título vai até ${MAX_TITLE_CHARS} caracteres`);
				return;
			}
			const renamed = await endpoint.renameConversation(id, title);
			if (renamed.kind === 'missing') {
				writeJsonError(response, 404, 'no_candidate', 'não há conversa com esse id');
				return;
			}
			if (renamed.kind === 'invalid') {
				writeJsonError(response, 400, 'bad_request', renamed.message);
				return;
			}
			writeJson(response, 200, { conversation: renamed.conversation });
			return;
		}

		if (pathname === CHAT_DELETE_ROUTE) {
			if (!acceptsOnly(input, ['id'])) {
				writeJsonError(response, 400, 'bad_request', 'a exclusão aceita somente "id"');
				return;
			}
			const id = input['id'];
			if (typeof id !== 'string' || id.length === 0 || id.length > MAX_CONVERSATION_ID_CHARS) {
				writeJsonError(
					response,
					400,
					'bad_request',
					`informe o id da conversa (até ${MAX_CONVERSATION_ID_CHARS} caracteres)`,
				);
				return;
			}
			const deleted = await endpoint.deleteConversation(id);
			if (deleted === 'busy') {
				// R4G: há um turno em curso nesta conversa. `409` porque o
				// pedido é válido e o estado atual o impede — e `409` não é
				// retentável automaticamente, o que é o certo: a interface
				// espera o turno acabar e pergunta de novo.
				writeJson(
					response,
					409,
					{
						error: {
							message: 'a conversa não pode ser excluída enquanto uma resposta está sendo gerada',
							type: 'conversation_busy',
							code: 'conversation_busy',
						},
					},
				);
				return;
			}
			if (deleted === 'unknown') {
				// R4M: o store não conseguiu confirmar a lista. "Não existe" e
				// "não sei" são coisas diferentes: dizer que a conversa não
				// existe aqui poderia esconder um erro de leitura atrás de um
				// sucesso, e o cliente nunca saberia que algo deu errado.
				writeJsonError(
					response,
					500,
					'internal',
					'não foi possível confirmar a exclusão da conversa; nada foi removido',
				);
				return;
			}
			// `deleted` e `already-absent` são o mesmo desfecho para o cliente
			// (R4M): a exclusão é idempotente. A conversa não está mais lá —
			// porque esta requisição a removeu ou porque outra, concorrente ou
			// anterior, já o fez. O contrato de sucesso não muda: `200` com o
			// id. Antes, a segunda exclusão recebia `404` e a corrida entre
			// duas simultâneas dava `200` e `404` ao acaso.
			writeJson(response, 200, { deleted: true, id });
			return;
		}

		if (pathname === CHAT_CREATE_ROUTE) {
			// Campos internos recusados **explicitamente**: um cliente que os
			// manda está tentando escolher o diretório das ferramentas ou
			// escrever instrução privada. Ignorar em silêncio faria a criação
			// "funcionar" sem o efeito que ele esperava.
			for (const field of REFUSED_CREATE_FIELDS) {
				if (field in input) {
					writeJsonError(
						response,
						400,
						'bad_request',
						`o campo "${field}" não é aceito na criação de conversa`,
					);
					return;
				}
			}
			const providerId = input['providerId'];
			const title = input['title'];
			if (
				typeof providerId !== 'string' ||
				providerId.length === 0 ||
				providerId.length > MAX_CONVERSATION_ID_CHARS
			) {
				writeJsonError(
					response,
					400,
					'bad_request',
					`informe o providerId (até ${MAX_CONVERSATION_ID_CHARS} caracteres)`,
				);
				return;
			}
			if (title !== undefined && (typeof title !== 'string' || title.length > MAX_TITLE_CHARS)) {
				writeJsonError(response, 400, 'bad_request', `o título vai até ${MAX_TITLE_CHARS} caracteres`);
				return;
			}
			const created = await endpoint.createConversation({
				providerId,
				...(typeof title === 'string' ? { title } : {}),
			});
			if (created.kind === 'refused') {
				writeJsonError(response, 400, 'bad_request', created.message);
				return;
			}
			writeJson(response, 201, { conversation: created.conversation });
			return;
		}

		if (pathname === CHAT_CONVERSATIONS_ROUTE) {
			const conversations = await endpoint.listConversations();
			writeJson(response, 200, { conversations });
			return;
		}

		if (pathname === CHAT_CONVERSATION_ROUTE) {
			const id = input['id'];
			if (
				typeof id !== 'string' ||
				id.length === 0 ||
				id.length > MAX_CONVERSATION_ID_CHARS
			) {
				writeJsonError(
					response,
					400,
					'bad_request',
					`informe o id da conversa (até ${MAX_CONVERSATION_ID_CHARS} caracteres)`,
				);
				return;
			}
			const detail = await endpoint.openConversation(id);
			if (detail === undefined) {
				writeJsonError(response, 404, 'no_candidate', 'não há conversa com esse id');
				return;
			}
			writeJson(response, 200, detail);
			return;
		}

		if (pathname === CHAT_TURN_ROUTE) {
			const conversationId = input['conversationId'];
			const providerId = input['providerId'];
			const model = input['model'];
			const text = input['text'];
			const requestId = input['requestId'];
			// DEV-8.10: o modo do chat. Ausente (cliente antigo) mantém a
			// exigência do par; no automático o par não é escolha do cliente.
			const rawRouting = input['routing'];
			const routing =
				rawRouting === 'auto' || rawRouting === 'direct' || rawRouting === 'external'
					? rawRouting
					: undefined;
			const requiresProvider = routing === undefined || routing === 'direct';
			const requiresModel = routing === undefined || routing !== 'auto';
			if (
				typeof conversationId !== 'string' || conversationId.length === 0 ||
				typeof text !== 'string' || text.trim().length === 0 ||
				(requiresProvider && (typeof providerId !== 'string' || providerId.length === 0)) ||
				(requiresModel && (typeof model !== 'string' || model.length === 0)) ||
				(providerId !== undefined && typeof providerId !== 'string') ||
				(model !== undefined && typeof model !== 'string')
			) {
				writeJsonError(response, 400, 'bad_request', 'informe conversationId, providerId, model e text');
				return;
			}
			// R4Q: a chave de idempotência é opcional. Presente, precisa ser
			// texto curto; ausente, o envio é uma intenção nova.
			if (requestId !== undefined && (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 200)) {
				writeJsonError(response, 400, 'bad_request', 'requestId precisa ser um texto de 1 a 200 caracteres');
				return;
			}
			if (text.length > MAX_CHAT_TEXT_CHARS) {
				writeJsonError(response, 413, 'bad_request', `o texto passa de ${MAX_CHAT_TEXT_CHARS} caracteres`);
				return;
			}
			const started = await endpoint.start({
				conversationId,
				providerId: typeof providerId === 'string' ? providerId : '',
				model: typeof model === 'string' ? model : '',
				text,
				...(requestId !== undefined ? { requestId } : {}),
				...(routing !== undefined ? { routing } : {}),
			});
			if (started.kind === 'refused') {
				// R4K: a recusa por registro corrompido tem código próprio — o
				// chat usa isso para dizer "diagnóstico indisponível" em vez de
				// um erro genérico. `ApiErrorCode` é o vocabulário do `/v1`;
				// este código é do painel, então vai pela forma crua.
				if (started.code !== undefined) {
					writeJson(response, started.status, {
						error: {
							message: started.message,
							type: started.code,
							code: started.code,
						},
					});
					return;
				}
				writeJsonError(response, started.status, 'no_candidate', started.message);
				return;
			}
			await writeTurnStream(response, started.turnId, started.events, endpoint);
			return;
		}

		if (pathname === CHAT_CANCEL_ROUTE) {
			const turnId = input['turnId'];
			if (typeof turnId !== 'string' || turnId.length === 0) {
				writeJsonError(response, 400, 'bad_request', 'informe turnId');
				return;
			}
			const cancelled = endpoint.cancel(turnId);
			writeJson(response, 200, { cancelled, turnId });
			return;
		}

		const turnId = input['turnId'];
		const id = input['id'];
		const decision = input['decision'];
		if (
			typeof turnId !== 'string' || turnId.length === 0 ||
			typeof id !== 'string' || id.length === 0 ||
			(decision !== 'allow' && decision !== 'deny')
		) {
			writeJsonError(response, 400, 'bad_request', 'informe turnId, id e decision (allow|deny)');
			return;
		}
		const answered = endpoint.answer(turnId, { id, decision });
		writeJson(response, 200, { answered, turnId });
	}

	/** Escreve um turno em SSE: um evento por `data:`, e `[DONE]` no fim. */
	async function writeTurnStream(
		response: ServerResponse,
		turnId: string,
		events: AsyncIterable<{ readonly type: string; readonly turnId: string }>,
		endpoint: WebChatEndpoint,
	): Promise<void> {
		const stream = openStream(response);
		response.on('close', () => {
			// O cliente foi embora: este turno é **dele**, então cancelar é o
			// certo. Nenhum outro turno é tocado — o serviço cancela por id.
			endpoint.cancel(turnId);
		});
		try {
			for await (const event of events) {
				stream.write(event);
			}
		} catch (error) {
			stream.write({
				type: 'error',
				turnId,
				message: error instanceof Error ? error.message : 'o turno falhou',
			});
		} finally {
			// O consumidor pode ter ido embora: o `close` do stream é idempotente.
			stream.writeRaw('data: [DONE]\n\n');
			stream.close();
		}
	}

/**
 * Lê uma data ISO-8601 de um parâmetro.
 *
 * Ausente = sem filtro. Presente e ilegível = `invalid`, nunca "sem filtro":
 * um filtro que o servidor descarta em silêncio mostra dados que o usuário
 * não pediu.
 */
function readDate(
	value: string | null,
): { readonly value?: number } | 'invalid' {
	if (value === null || value.length === 0) {
		return {};
	}
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? { value: parsed } : 'invalid';
}

/** Lê um inteiro de um parâmetro, dentro dos limites; ausente = padrão. */
function readInteger(
	value: string | null,
	fallback: number,
	min: number,
	max: number,
): { readonly value: number } | 'invalid' {
	if (value === null || value.length === 0) {
		return { value: fallback };
	}
	// `Number` aceita "1e3" e " 7 ": o `Number.isInteger` sozinho aprovaria o
	// primeiro, que não é o que um parâmetro de paginação deve aceitar.
	if (!/^\d+$/.test(value)) {
		return 'invalid';
	}
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? { value: parsed } : 'invalid';
}

/**
 * O corpo só tem as chaves permitidas?
 *
 * Usado nas rotas de renomear/excluir: um `path` ou `projectId` a mais não
 * deve ser ignorado em silêncio — o cliente está tentando escolher algo que a
 * rota não oferece, e a recusa diz isso.
 */
function acceptsOnly(input: Record<string, unknown>, allowed: readonly string[]): boolean {
	return Object.keys(input).every((key) => allowed.includes(key));
}

	/**
	 * A consulta do diagnóstico de turnos (R4J).
	 *
	 * ## O que ela valida, e por quê
	 *
	 * Cada parâmetro é recusado com `400` quando não é o que diz ser — em vez
	 * de cair para o padrão em silêncio. Uma data mal digitada que virasse
	 * "sem filtro" mostraria um conjunto que o usuário não pediu, e ele não
	 * teria como saber.
	 *
	 * ## O que ela devolve
	 *
	 * A página e o total que casa com o filtro, para a interface saber se há
	 * mais. Só os campos do registro: sem prompt, resposta, mensagem, token ou
	 * caminho. É a projeção do store, e não uma leitura do arquivo.
	 */
	async function handleTurnDiagnostic(response: ServerResponse, url: URL): Promise<void> {
		const store = options.turns;
		if (store === undefined) {
			writeJsonError(response, 404, 'no_candidate', 'este host não tem registro de turnos');
			return;
		}
		const query = url.searchParams;

		const rawStatus = query.get('status') ?? 'all';
		if (!DIAGNOSTIC_STATUSES.includes(rawStatus as TurnRecordStatus | 'all')) {
			writeJsonError(
				response,
				400,
				'bad_request',
				`status deve ser um de: ${DIAGNOSTIC_STATUSES.join(', ')}`,
			);
			return;
		}

		const since = readDate(query.get('since'));
		if (since === 'invalid') {
			writeJsonError(response, 400, 'bad_request', 'since precisa ser uma data ISO-8601 válida');
			return;
		}
		const until = readDate(query.get('until'));
		if (until === 'invalid') {
			writeJsonError(response, 400, 'bad_request', 'until precisa ser uma data ISO-8601 válida');
			return;
		}
		if (since.value !== undefined && until.value !== undefined && since.value > until.value) {
			writeJsonError(response, 400, 'bad_request', 'since não pode ser depois de until');
			return;
		}

		const limit = readInteger(query.get('limit'), DEFAULT_DIAGNOSTIC_LIMIT, 1, MAX_DIAGNOSTIC_LIMIT);
		if (limit === 'invalid') {
			writeJsonError(
				response,
				400,
				'bad_request',
				`limit precisa ser um inteiro entre 1 e ${MAX_DIAGNOSTIC_LIMIT}`,
			);
			return;
		}
		const offset = readInteger(query.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
		if (offset === 'invalid') {
			writeJsonError(response, 400, 'bad_request', 'offset precisa ser um inteiro não negativo');
			return;
		}

		let result;
		try {
			result = await store.query({
				status: rawStatus as TurnRecordStatus | 'all',
				...(since.value !== undefined ? { since: since.value } : {}),
				...(until.value !== undefined ? { until: until.value } : {}),
				limit: limit.value,
				offset: offset.value,
			});
		} catch (error) {
			// R4K: corrupção e falha de I/O são **coisas diferentes**, e o
			// cliente precisa da diferença para decidir o que oferecer.
			if (error instanceof TurnRecordCorruptError) {
				writeJson(
					response,
					503,
					{
						error: {
							message: 'o diagnóstico está indisponível: o registro de turnos está corrompido',
							type: 'turns_corrupt',
							code: 'turns_corrupt',
						},
						// O motivo é **classe**, sem caminho e sem conteúdo: o
						// suficiente para o operador decidir, não o bastante para
						// contar onde os dados moram.
						reason: error.reason,
						recoverable: true,
					},
				);
				return;
			}
			// O motivo da falha de I/O não sai: o caminho do arquivo está nele.
			writeJsonError(response, 503, 'internal', 'não foi possível ler o registro de turnos');
			return;
		}

		sendJson(
			response,
			200,
			{
				// Só os campos do ciclo. A conversa é um id; não se abre nada.
				turns: result.turns.map((turn) => ({
					turnId: turn.turnId,
					conversationId: turn.conversationId,
					status: turn.status,
					startedAt: turn.startedAt,
					...(turn.finishedAt !== undefined ? { finishedAt: turn.finishedAt } : {}),
					...(turn.reason !== undefined ? { reason: turn.reason } : {}),
				})),
				total: result.total,
				limit: limit.value,
				offset: offset.value,
			},
			token,
		);
	}

	/**
	 * A superfície compatível com OpenAI.
	 *
	 * ## Quem pode falar
	 *
	 * Só `Authorization: Bearer <chave de cliente>`. A chave **nunca** é
	 * aceita na URL, na query nem em cookie: uma chave em URL vai parar no
	 * histórico do cliente e em logs de proxy, e este servidor não pode
	 * impedir nenhum dos dois. Ausente, inválida ou sem o escopo `client` →
	 * `401` JSON.
	 *
	 * ## O que não muda
	 *
	 * A regra de Host/Origin continua valendo antes de tudo: mesmo com uma
	 * chave válida, uma requisição com `Origin` de outro site é recusada.
	 */
	async function handleOpenAi(
		request: IncomingMessage,
		response: ServerResponse,
		pathname: string,
		method: string,
	): Promise<void> {
		const endpoint = options.openai;
		if (endpoint === undefined) {
			writeJsonError(response, 404, 'no_candidate', 'a API compatível com OpenAI não está habilitada neste host');
			return;
		}
		// As mesmas regras de origem do painel: um POST de outra página aberta
		// no navegador não fala com o modelo por ter roubado uma chave.
		const verdict = evaluateRequest(
			{ hostHeader: request.headers.host, originHeader: request.headers.origin },
			actualPort(),
		);
		if (!verdict.ok) {
			writeJsonError(response, 403, 'auth', 'origem não permitida');
			return;
		}

		const bearer = bearerFrom(request.headers.authorization);
		let identity: { readonly keyId: string; readonly scopes: readonly string[] } | undefined;
		try {
			identity = bearer === undefined ? undefined : await endpoint.authenticate(bearer);
		} catch {
			// O registro de chaves não pôde ser lido (arquivo corrompido ou
			// sem permissão). Recusar é o lado seguro — e é dito como 503, para
			// o operador distinguir "chave errada" de "serviço quebrado".
			writeJsonError(response, 503, 'internal', 'as credenciais da API não estão disponíveis');
			return;
		}
		if (identity === undefined || !identity.scopes.includes('client')) {
			writeJsonError(response, 401, 'auth', 'chave de API ausente, inválida ou sem permissão de cliente');
			return;
		}

		if (pathname === '/v1/models') {
			if (method !== 'GET') {
				response.setHeader('Allow', 'GET');
				writeJsonError(response, 405, 'bad_request', 'este caminho só aceita GET');
				return;
			}
			const reply = await listModelsReply({
				runtime: endpoint.runtime,
				listModels: endpoint.listModels,
			});
			writeJson(response, reply.status, reply.body);
			return;
		}

		if (pathname === '/v1/chat/completions') {
			if (method !== 'POST') {
				response.setHeader('Allow', 'POST');
				writeJsonError(response, 405, 'bad_request', 'este caminho só aceita POST');
				return;
			}
			if (!isJsonContentType(request.headers['content-type'])) {
				writeJsonError(response, 415, 'bad_request', 'envie o corpo como application/json');
				return;
			}
			const body = await readApiBody(request);
			if (body.kind === 'invalid') {
				writeJsonError(response, 400, 'bad_request', body.reason);
				return;
			}
			// O cliente que fecha a conexão cancela **esta** requisição.
			const controller = new AbortController();
			response.on('close', () => {
				if (!response.writableEnded) {
					controller.abort(new Error('o cliente fechou a conexão'));
				}
			});
			const reply = await chatCompletionsReply({
				options: { runtime: endpoint.runtime, listModels: endpoint.listModels },
				body: body.value,
				signal: controller.signal,
			});
			if (reply.stream === undefined) {
				writeJson(response, reply.status, reply.body);
				return;
			}
			await streamReply(response, reply.stream, controller);
			return;
		}

		writeJsonError(response, 404, 'no_candidate', `não há rota "${pathname}" nesta API`);
	}

	/**
	 * Escreve o stream no socket.
	 *
	 * `[DONE]` é o último `data:` de todo stream bem-sucedido, e vem depois do
	 * fragmento com `finish_reason`. Um erro no meio vira um evento `error`
	 * seguido de `[DONE]`: o cliente que já recebeu texto precisa de um
	 * término explícito, e cortar o socket sem aviso deixa o cliente
	 * esperando.
	 */
	async function streamReply(
		response: ServerResponse,
		events: AsyncIterable<ApiChatEvent>,
		controller: AbortController,
	): Promise<void> {
		const stream = openStream(response);
		response.on('close', () => controller.abort(new Error('o cliente fechou a conexão')));
		let id = `chatcmpl_${randomUUID()}`;
		let model = '';
		let sentAny = false;
		try {
			for await (const event of events) {
				if (event.type === 'error') {
					stream.write(
						chunkBody({
							id,
							model: model.length > 0 ? model : 'unknown',
							delta: { content: '' },
							finishReason: 'stop',
						}),
					);
					stream.write({
						error: { message: event.message, type: 'api_error', code: event.code },
					});
					break;
				}
				if (event.type === 'done') {
					id = event.completion.id;
					model = event.completion.model;
					if (event.completion.reasoning !== undefined && !sentAny) {
						stream.write(
							chunkBody({
								id,
								model,
								delta: { role: 'assistant', content: '' },
							}),
						);
					}
					stream.write(
						chunkBody({
							id,
							model,
							delta: { content: '' },
							finishReason: 'stop',
							...(event.completion.usage !== undefined ? { usage: event.completion.usage } : {}),
						}),
					);
					break;
				}
				if (event.type === 'delta') {
					if (!sentAny) {
						sentAny = true;
						stream.write(chunkBody({ id, model: model.length > 0 ? model : 'stream', delta: { role: 'assistant', content: '' } }));
					}
					stream.write(
						chunkBody({ id, model: model.length > 0 ? model : 'stream', delta: { content: event.text } }),
					);
					continue;
				}
				if (event.type === 'reasoning') {
					stream.write(
						chunkBody({
							id,
							model: model.length > 0 ? model : 'stream',
							delta: { reasoning_content: event.text },
						}),
					);
				}
				// `usage` chega antes do `done` e vai no último fragmento, como
				// os clientes OpenAI esperam.
			}
		} catch {
			// Uma falha ao escrever no socket é o cliente indo embora: não há
			// para quem reportar.
		} finally {
			stream.writeRaw('data: [DONE]\n\n');
			stream.close();
		}
	}

	/**
	 * A porta em que o socket está de fato.
	 *
	 * Antes de escutar não há porta, e nenhuma requisição chega; depois,
	 * `address()` é a fonte da verdade.
	 */
	function actualPort(): number {
		const address = server.address();
		if (address !== null && typeof address === 'object') {
			return address.port;
		}
		return options.port ?? DEFAULT_WEB_PORT;
	}

	return { server, token, actualPort };
}

/**
 * Sobe o servidor em `127.0.0.1`.
 *
 * `listen(port, LOOPBACK_ADDRESS)` — e não `listen(port)`: o segundo escuta em
 * todas as interfaces, o que colocaria a interface na rede.
 */
export async function startWebServer(options: WebServerOptions): Promise<RunningWebServer> {
	const { server, token } = createWebServer(options);	const requested = options.port ?? DEFAULT_WEB_PORT;

	await new Promise<void>((resolve, reject) => {
		const onError = (error: Error): void => {
			server.off('listening', onListening);
			reject(error);
		};
		const onListening = (): void => {
			server.off('error', onError);
			resolve();
		};
		server.once('error', onError);
		server.once('listening', onListening);
		server.listen(requested, LOOPBACK_ADDRESS);
	});

	const address = server.address();
	if (address === null || typeof address === 'string') {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		throw new Error('the web server did not report a TCP address');
	}

	return {
		port: address.port,
		address: address.address,
		token,
		...(options.readerToken !== undefined && options.readerToken.length > 0
			? { readerToken: options.readerToken }
			: {}),
		entryUrl: `http://127.0.0.1:${address.port}/?${TOKEN_QUERY_PARAMETER}=${token}`,
		async close(): Promise<void> {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

/** Reexportado para o host não precisar saber de onde vem. */
export { CONTENT_SECURITY_POLICY, isTokenValid };
