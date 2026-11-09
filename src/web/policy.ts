/**
 * As regras do servidor local, sem socket.
 *
 * ## Por que elas moram aqui
 *
 * O servidor é um socket; as *decisões* dele — esta requisição pode entrar,
 * esta origem pode ler, este arquivo pode sair — são funções de texto para
 * texto. Separadas, elas podem ser testadas uma a uma, sem abrir porta e sem
 * janela de tempo; e o `server.ts` fica com o que só ele sabe fazer.
 *
 * ## O modelo de ameaça, dito uma vez
 *
 * O servidor escuta em `127.0.0.1`: ninguém de outra máquina o alcança. O
 * risco que resta é **o navegador desta máquina** — qualquer site aberto num
 * outro tab fala com `127.0.0.1`, e:
 *
 * - **DNS rebinding**: um domínio do atacante passa a resolver para
 *   `127.0.0.1`. Ele não controla o header `Host`, então ele chega como o
 *   domínio dele — e um `Host` que não seja `127.0.0.1`/`localhost` com a
 *   porta certa é recusado;
 * - **CSRF**: um site dispara uma requisição simples (`no-cors`) para o
 *   servidor. Ela chega com `Origin` de outro site — e um `Origin` que não
 *   seja do próprio servidor é recusado;
 * - **leitura por terceiros**: mesmo com `Origin` correto, a resposta leva a
 *   **proibição** de ser lida de fora (CSP + nenhum header de CORS), e o
 *   token de sessão impede que um script de fora "só chame" a API.
 *
 * O token **não** substitui as duas primeiras regras: ele protege o que as
 * regras deixam passar, e as regras protegem o que o token custa a proteger
 * (um token vazado num link continua inútil vindo de outra origem).
 */

/** A porta onde o servidor local escuta, quando ninguém diz outra. */
export const DEFAULT_WEB_PORT = 7817;

/** O endereço onde ele escuta. Nunca `0.0.0.0`. */
export const LOOPBACK_ADDRESS = '127.0.0.1';

/**
 * A Content-Security-Policy da página.
 *
 * `default-src 'none'` porque a página não carrega nada além do próprio
 * script e da própria folha: sem fonte remota, sem `data:` em script, sem
 * `eval`. `connect-src 'self'` permite o `fetch` para a própria API, que é a
 * única conversa que a página precisa ter.
 */
export const CONTENT_SECURITY_POLICY =
	"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/**
 * Headers que toda resposta leva.
 *
 * `X-Content-Type-Options` impede o navegador de "adivinhar" um tipo e
 * executar um `.txt` como script. `Referrer-Policy: no-referrer` impede o
 * token — que vai na URL na primeira visita — de vazar num clique para fora.
 * `Cross-Origin-Resource-Policy: same-origin` impede que outro site
 * incorpore ou leia o que o servidor devolve, mesmo que as outras regras
 * falhem.
 */
export const BASE_HEADERS: Readonly<Record<string, string>> = {
	'Content-Security-Policy': CONTENT_SECURITY_POLICY,
	'X-Content-Type-Options': 'nosniff',
	'Referrer-Policy': 'no-referrer',
	'Cross-Origin-Resource-Policy': 'same-origin',
	'X-Frame-Options': 'DENY',
	'Cache-Control': 'no-store',
};

/** O `Host` que a requisição declara. */
export interface RequestIdentity {
	/** O header `Host`, como veio — pode ser ausente. */
	readonly hostHeader: string | undefined;
	/** O header `Origin`, quando a requisição é de um navegador. */
	readonly originHeader: string | undefined;
}

/** O resultado de avaliar quem está falando. */
export type AccessVerdict =
	| { readonly ok: true }
	/** Não é o host: `403`. */
	| { readonly ok: false; readonly status: 403; readonly reason: string };

/** Os hosts aceitos, com a porta que o servidor está usando. */
export function allowedHosts(port: number): readonly string[] {
	return [`127.0.0.1:${port}`, `localhost:${port}`];
}

/**
 * O `Host` é o deste servidor?
 *
 * A porta é parte da resposta: um `Host` sem porta (ou com outra) é outro
 * servidor, e não este. Um domínio que resiolve para `127.0.0.1` chega com
 * o próprio nome no `Host` e é recusado aqui.
 */
export function isAllowedHost(hostHeader: string | undefined, port: number): boolean {
	if (hostHeader === undefined) {
		return false;
	}
	const normalized = hostHeader.trim().toLowerCase();
	return allowedHosts(port).includes(normalized);
}

/**
 * A `Origin` é do próprio servidor?
 *
 * Ausente é aceito: um cliente que não é navegador (curl, um teste) não
 * manda `Origin`, e essa requisição não carrega o risco de CSRF — não há um
 * site por trás dela. Presente, tem de ser exatamente a nossa.
 */
export function isAllowedOrigin(originHeader: string | undefined, port: number): boolean {
	if (originHeader === undefined) {
		return true;
	}
	const normalized = originHeader.trim().toLowerCase();
	return allowedHosts(port)
		.map((host) => `http://${host}`)
		.includes(normalized);
}

/** Avalia o `Host` e a `Origin` juntos. */
export function evaluateRequest(identity: RequestIdentity, port: number): AccessVerdict {
	if (!isAllowedHost(identity.hostHeader, port)) {
		return {
			ok: false,
			status: 403,
			reason: `Host nao permitido: ${identity.hostHeader ?? '(ausente)'}`,
		};
	}
	if (!isAllowedOrigin(identity.originHeader, port)) {
		return {
			ok: false,
			status: 403,
			reason: `Origin nao permitida: ${identity.originHeader ?? '(ausente)'}`,
		};
	}
	return { ok: true };
}

/**
 * O token apresentado bate com o esperado?
 *
 * Comparação em tempo constante: um `===` para no primeiro byte diferente,
 * e o tempo de resposta diz quantos bytes acertaram. É um risco pequeno numa
 * rede local, e custa uma linha não tê-lo.
 */
export function isTokenValid(presented: string | undefined, expected: string): boolean {
	if (presented === undefined || expected.length === 0) {
		return false;
	}
	if (presented.length !== expected.length) {
		return false;
	}
	let difference = 0;
	for (let index = 0; index < presented.length; index += 1) {
		difference |= presented.charCodeAt(index) ^ expected.charCodeAt(index);
	}
	return difference === 0;
}

/**
 * O caminho pedido, resolvido para um arquivo permitido.
 *
 * `undefined` significa "não sirvo isso" — e a resposta é a mesma para
 * "não existe" e para "tentei sair da pasta", de propósito: distinguir os
 * dois ensina o atacante. A resolução é feita sobre os segmentos, não sobre a
 * string: `..`, `%2e%2e`, barras invertidas e caminhos absolutos não têm como
 * escapar por acidente de normalização.
 */
export function resolveStaticPath(requestPath: string): string | undefined {
	// Só http(s) vira caminho; qualquer outra coisa é lixo.
	let decoded: string;
	try {
		decoded = decodeURIComponent(requestPath);
	} catch {
		// `%` solto: não é um caminho, é um erro do cliente.
		return undefined;
	}
	// A barra invertida é separador no Windows: trocada por `/` antes de
	// qualquer coisa, senão `..\\..\\` passaria como um segmento só.
	const normalized = decoded.replace(/\\/g, '/');
	if (normalized.startsWith('/') === false) {
		return undefined;
	}
	if (normalized.length === 0 || normalized === '/') {
		return 'index.html';
	}
	const segments = normalized.split('/').filter((segment) => segment.length > 0);
	if (segments.some((segment) => segment === '..' || segment === '.' || segment.includes(':'))) {
		return undefined;
	}
	// A raiz da página é o `index.html`; o resto é servido como veio.
	const candidate = segments.join('/');
	return candidate.length === 0 ? 'index.html' : candidate;
}

/** O tipo de conteúdo de um arquivo permitido. */
export function contentTypeFor(fileName: string): string | undefined {
	if (fileName.endsWith('.html')) {
		return 'text/html; charset=utf-8';
	}
	if (fileName.endsWith('.css')) {
		return 'text/css; charset=utf-8';
	}
	if (fileName.endsWith('.js')) {
		return 'text/javascript; charset=utf-8';
	}
	if (fileName.endsWith('.svg')) {
		return 'image/svg+xml';
	}
	if (fileName.endsWith('.json')) {
		return 'application/json; charset=utf-8';
	}
	return undefined;
}

/** Extensões que o servidor entrega. Nenhuma outra. */
export const ALLOWED_EXTENSIONS: readonly string[] = ['.html', '.css', '.js', '.svg', '.json'];
