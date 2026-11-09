/**
 * O contrato das ferramentas web: o Core descreve, o host executa.
 *
 * ## Por que porta, e não implementação
 *
 * O Core não pode falar com a rede por conta própria: baixar uma página é I/O
 * arbitrário com destino escolhido por um modelo, e é o host que tem o `fetch`,
 * o DNS e a validação de endereço (SSRF) já escritos. Aqui ficam só os tipos e
 * a regra de segurança que se aplica a **qualquer** implementação.
 *
 * ## A regra que não pode variar
 *
 * `validateNavigationUrl` é a checagem de texto, antes de qualquer conexão:
 * `file:`, `data:`, `javascript:`, usuário/senha embutidos, loopback e rede
 * privada são recusados. A checagem do **IP resolvido** continua sendo do host
 * — está em `app/opencodeAddress.ts` e vale para o `fetch` dele.
 *
 * Uma implementação de teste que ignore esta função provaria as ferramentas e
 * não a defesa; por isso a ferramenta chama a função **antes** de pedir ao host.
 */

/** O que o host devolve depois de buscar uma URL. */
export interface FetchedPage {
	/** A URL final, depois dos redirecionamentos permitidos. */
	readonly url: string;
	/** O `content-type` devolvido. */
	readonly contentType: string;
	/** O corpo, já limitado em bytes pelo host. */
	readonly body: string;
	/** Status HTTP, para o modelo saber que 404 não é conteúdo. */
	readonly status: number;
	/** Foi cortado por tamanho? */
	readonly truncated: boolean;
	/** A URL foi redirecionada? O modelo precisa saber de onde veio. */
	readonly redirectedFrom?: string;
}

/** A porta que o host implementa. Toda chamada vem depois de `validateNavigationUrl`. */
export interface WebFetcher {
	/**
	 * Busca **uma** página. Sem redirecionamento para outro host, sem corpo
	 * além do limite, sem paralelismo: a política vive aqui, não no chamador.
	 */
	fetchPage(url: string): Promise<FetchedPage>;
}

/** Um resultado de busca, já normalizado e sem HTML. */
export interface SearchResult {
	readonly title: string;
	readonly url: string;
	/** O trecho que o buscador destacou. */
	readonly snippet: string;
	/** De onde veio: o buscador usado. */
	readonly engine: string;
}

/** A porta de busca. Sem chave configurada, o host diz por que não pode. */
export interface WebSearcher {
	search(query: string, options?: { readonly limit?: number }): Promise<{
		readonly results: readonly SearchResult[];
		/** Quando a busca falhou, o motivo — nunca uma lista vazia sem explicação. */
		readonly failure?: string;
		/** O buscador que respondeu. */
		readonly engine?: string;
	}>;
	/** Se há como buscar agora, e por qual buscador. */
	describe(): { readonly available: boolean; readonly engine?: string; readonly reason?: string };
}

/** O que a ferramenta web recebe do host. */
export interface WebPorts {
	readonly fetcher: WebFetcher;
	readonly searcher: WebSearcher;
}

/* ── a regra de segurança ───────────────────────────────────────────────── */

/** Os nomes que só podem ser loopback por definição. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0', '[::]']);

function parseIpv4(value: string): number[] | undefined {
	const parts = value.split('.');
	if (parts.length !== 4) {
		return undefined;
	}
	const octets = parts.map((part) => Number(part));
	if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
		return undefined;
	}
	return octets;
}

/**
 * O IPv4 é privado, link-local, CGNAT, multicast ou "esta rede"?
 *
 * Loopback fica de fora de propósito: quem decide sobre ele é a função de
 * navegação, com uma regra própria e explícita.
 */
export function isNonPublicIpv4(octets: readonly number[]): boolean {
	const [a, b] = octets;
	return (
		a === 0 ||
		a === 10 ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 169 && b === 254) ||
		(a === 100 && b >= 64 && b <= 127) ||
		a >= 224
	);
}

function isLoopbackIpv4(octets: readonly number[]): boolean {
	return octets[0] === 127;
}

function isLoopbackIpv6(value: string): boolean {
	const normalized = value.toLowerCase().replace(/^\[|\]$/g, '');
	if (normalized === '::1' || normalized === '::') {
		return true;
	}
	const mapped = /^::ffff:(127(?:\.\d{1,3}){3})$/.exec(normalized);
	return mapped !== null && isLoopbackIpv4(parseIpv4(mapped[1]) ?? []);
}

function isNonPublicIpv6(value: string): boolean {
	const normalized = value.toLowerCase().replace(/^\[|\]$/g, '');
	const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(normalized);
	if (mapped !== null) {
		const octets = parseIpv4(mapped[1]);
		return octets === undefined ? true : isNonPublicIpv4(octets);
	}
	return (
		normalized.startsWith('fe80') ||
		normalized.startsWith('fec0') ||
		/^f[cd][0-9a-f]{2}/.test(normalized) ||
		normalized.startsWith('ff')
	);
}

/** O veredito da navegação, com o motivo quando recusa. */
export type NavigationVerdict =
	| { readonly ok: true; readonly url: URL }
	| { readonly ok: false; readonly reason: string };

/** Esquemas que jamais viram navegação. `file:` lê o disco local. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * A única porta de entrada da navegação.
 *
 * Recusa, em ordem: URL inválida; esquema que não é http(s) — o que exclui
 * `file:`, `data:`, `javascript:`, `ftp:`; usuário/senha embutidos (que
 * chegariam ao servidor como credencial); loopback e nomes equivalentes; IP
 * privado/link-local/CGNAT/multicast.
 *
 * O que não pode ser feito aqui é a checagem do IP **resolvido**: um nome
 * público pode apontar para a rede interna. O host faz essa segunda metade
 * antes de conectar, e o redirecionamento é desfeito se mudar de host.
 */
export function validateNavigationUrl(raw: string): NavigationVerdict {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		return { ok: false, reason: 'o endereço não é uma URL válida' };
	}
	if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
		return {
			ok: false,
			reason: `o protocolo "${url.protocol}" não é aceito; use http ou https`,
		};
	}
	if (url.username.length > 0 || url.password.length > 0) {
		return { ok: false, reason: 'a URL não pode conter usuário e senha embutidos' };
	}
	const host = url.hostname.toLowerCase();
	const octets = parseIpv4(host);
	const loopback =
		LOOPBACK_HOSTS.has(host) ||
		(octets !== undefined && isLoopbackIpv4(octets)) ||
		isLoopbackIpv6(host);
	if (loopback) {
		return {
			ok: false,
			reason: 'endereços locais não são acessíveis pela web: a ferramenta só abre páginas da internet',
		};
	}
	if (octets !== undefined && isNonPublicIpv4(octets)) {
		return { ok: false, reason: 'endereços de rede privada não são acessíveis pela web' };
	}
	if (octets === undefined && isNonPublicIpv6(host)) {
		return { ok: false, reason: 'endereços IPv6 privados ou link-local não são acessíveis' };
	}
	if (url.protocol === 'http:') {
		return { ok: true, url };
	}
	return { ok: true, url };
}
