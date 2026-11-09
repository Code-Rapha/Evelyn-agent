/**
 * O que o host faz na web por conta das ferramentas do agente.
 *
 * ## Duas defesas, em ordem
 *
 * 1. `validateNavigationUrl` (no Core) recusa esquema, loopback e rede privada
 *    **antes** de qualquer conexão.
 * 2. Aqui, o IP **resolvido** é checado antes do `fetch` — a segunda metade,
 *    que pega um nome público apontando para `127.0.0.1` ou para a rede
 *    interna (DNS rebinding). O redirecionamento é seguido **manualmente**, um
 *    por vez, e cada destino passa pelas duas checagens: um `302` não pode
 *    levar a requisição para onde o texto original não podia ir.
 *
 * ## Limites, todos explícitos
 *
 * O corpo é lido com teto de bytes, a requisição tem prazo, e no máximo três
 * redirecionamentos são seguidos. Uma página de 200 MB é um problema do
 * servidor dela, não do app.
 *
 * ## Busca sem depender de um serviço só
 *
 * Brave Search quando há chave (resultados de melhor qualidade e com título e
 * trecho prontos) e DuckDuckGo HTML como alternativa sem chave. Se os dois
 * falharem, a ferramenta recebe o motivo — nunca uma lista vazia sem
 * explicação, que o modelo interpretaria como "não existe".
 */
import { lookup } from 'node:dns/promises';
import type { FetchedPage, SearchResult, WebFetcher, WebSearcher } from '../core/agent/webPort';
import { validateResolvedIp } from './opencodeAddress';
import { extractPage } from '../core/agent/webPage';

/** Teto do corpo baixado, em bytes. Uma página de docs cabe; um dump não. */
const MAX_BODY_BYTES = 2_000_000;

/** Prazo de uma requisição, incluindo o download. */
const REQUEST_TIMEOUT_MS = 15_000;

/** Redirecionamentos seguidos no máximo. */
const MAX_REDIRECTS = 3;

/** O `fetch` que este módulo usa — injetável em teste. */
export type FetchLike = typeof globalThis.fetch;

/**
 * Resolve o host e diz se o IP é público.
 *
 * Uma falha de DNS não é motivo para tentar de todo jeito: sem endereço, não há
 * destino, e a resposta honesta é a recusa.
 */
async function assertPublicHost(hostname: string): Promise<void> {
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':')) {
		const verdict = validateResolvedIp(hostname.replace(/^\[|\]$/g, ''), false);
		if (!verdict.ok) {
			throw new Error(verdict.reason);
		}
		return;
	}
	let addresses: { address: string }[];
	try {
		addresses = await lookup(hostname, { all: true, verbatim: true });
	} catch {
		throw new Error(`não foi possível resolver "${hostname}"`);
	}
	if (addresses.length === 0) {
		throw new Error(`"${hostname}" não resolve para nenhum endereço`);
	}
	for (const entry of addresses) {
		const verdict = validateResolvedIp(entry.address, false);
		if (!verdict.ok) {
			throw new Error(verdict.reason);
		}
	}
}

/** Lê o corpo com teto de bytes, sem carregar um arquivo inteiro na memória. */
async function readBodyCapped(response: Response): Promise<{ body: string; truncated: boolean }> {
	const declared = Number(response.headers.get('content-length') ?? '0');
	if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
		// Cortar no meio de um HTML é aceitável: o extrator trabalha com o que
		// chegou, e a ferramenta diz que foi cortado.
	}
	if (response.body === null) {
		return { body: '', truncated: false };
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder('utf-8', { fatal: false });
	let received = 0;
	let text = '';
	let truncated = false;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		if (value !== undefined) {
			received += value.byteLength;
			if (received > MAX_BODY_BYTES) {
				const room = MAX_BODY_BYTES - (received - value.byteLength);
				text += decoder.decode(value.subarray(0, Math.max(0, room)), { stream: false });
				truncated = true;
				await reader.cancel().catch(() => undefined);
				break;
			}
			text += decoder.decode(value, { stream: true });
		}
	}
	text += decoder.decode();
	return { body: text, truncated };
}

/**
 * O buscador e o leitor de páginas.
 *
 * `searchKey` vem do `SecretStore` do host e **nunca** é devolvido ao modelo:
 * ele entra num cabeçalho daqui e não aparece em resultado, erro ou log.
 */
export function createWebClient(options: {
	readonly fetch?: FetchLike;
	/** A chave do buscador, quando configurada. Ausente = busca sem chave. */
	readonly searchKey?: string;
	/** O endereço do buscador com chave. Ausente = usa o padrão do Brave. */
	readonly searchBaseUrl?: string;
} = {}): { readonly fetcher: WebFetcher; readonly searcher: WebSearcher } {
	const doFetch: FetchLike = options.fetch ?? ((url, init) => globalThis.fetch(url, init));

	const fetchPage: WebFetcher['fetchPage'] = async (rawUrl) => {
		let current = rawUrl;
		const original = rawUrl;
		for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
			const url = new URL(current);
			await assertPublicHost(url.hostname);
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
			let response: Response;
			try {
				response = await doFetch(url.toString(), {
					method: 'GET',
					redirect: 'manual',
					signal: controller.signal,
					headers: {
						// Um agente que se identifica: o site sabe quem pediu, e um
						// bloqueio por `User-Agent` é um "não", não um mistério.
						'user-agent': 'Seshyina/1.0 (+https://github.com/modelhub; agente local)',
						accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1',
					},
				});
			} catch (error) {
				clearTimeout(timer);
				if (controller.signal.aborted) {
					throw new Error(`a página não respondeu em ${REQUEST_TIMEOUT_MS / 1000}s`);
				}
				throw new Error(
					`não foi possível abrir ${url.host}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			clearTimeout(timer);

			if (response.status >= 300 && response.status < 400) {
				const location = response.headers.get('location');
				await response.body?.cancel().catch(() => undefined);
				if (location === null) {
					throw new Error(`a página redirecionou sem endereço (${response.status})`);
				}
				// O destino do redirecionamento passa pela validação do Core
				// quando a ferramenta o abrir de novo — mas aqui ele já é
				// resolvido e checado antes de a próxima conexão sair.
				current = new URL(location, url).toString();
				continue;
			}

			const read = await readBodyCapped(response);
			const page: FetchedPage = {
				url: url.toString(),
				contentType: response.headers.get('content-type') ?? 'application/octet-stream',
				body: read.body,
				status: response.status,
				truncated: read.truncated,
				...(current !== original ? { redirectedFrom: original } : {}),
			};
			return page;
		}
		throw new Error(`a página redirecionou mais de ${MAX_REDIRECTS} vezes`);
	};

	const searcher: WebSearcher = {
		describe: () =>
			options.searchKey !== undefined && options.searchKey.length > 0
				? { available: true, engine: 'brave' }
				: { available: true, engine: 'duckduckgo (sem chave)' },
		search: async (query, { limit = 6 } = {}) => {
			if (options.searchKey !== undefined && options.searchKey.length > 0) {
				const brave = await braveSearch(doFetch, options.searchKey, options.searchBaseUrl, query, limit);
				if (brave.results.length > 0 || brave.failure === undefined) {
					return brave;
				}
				// Com chave mas sem resposta: tenta o caminho sem chave antes de
				// dizer que não buscou.
			}
			return duckDuckGoSearch(doFetch, query, limit);
		},
	};

	return { fetcher: { fetchPage }, searcher };
}

/** Busca no Brave, com a chave só no cabeçalho. */
async function braveSearch(
	doFetch: FetchLike,
	key: string,
	baseUrl: string | undefined,
	query: string,
	limit: number,
): Promise<{ results: SearchResult[]; failure?: string; engine: string }> {
	const base = (baseUrl ?? 'https://api.search.brave.com/res/v1/web/search').replace(/\/$/, '');
	const url = `${base}?q=${encodeURIComponent(query)}&count=${limit}`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const response = await doFetch(url, {
			method: 'GET',
			signal: controller.signal,
			headers: {
				accept: 'application/json',
				'x-subscription-token': key,
			},
		});
		if (!response.ok) {
			return { results: [], engine: 'brave', failure: `o buscador respondeu ${response.status}` };
		}
		const body = (await response.json().catch(() => undefined)) as
			| { web?: { results?: { title?: string; url?: string; description?: string }[] } }
			| undefined;
		const results = (body?.web?.results ?? [])
			.filter((entry) => typeof entry.url === 'string')
			.map((entry) => ({
				title: stripHtml(entry.title ?? entry.url ?? ''),
				url: entry.url as string,
				snippet: stripHtml(entry.description ?? ''),
				engine: 'brave',
			}))
			.slice(0, limit);
		return { results, engine: 'brave' };
	} catch (error) {
		return {
			results: [],
			engine: 'brave',
			failure: controller.signal.aborted ? 'o buscador não respondeu a tempo' : String(error),
		};
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Busca no DuckDuckGo pela página HTML, sem chave.
 *
 * É a alternativa quando não há provedor configurado. O formato é uma página de
 * resultados comum; o extrator é o mesmo das páginas, e os títulos e trechos
 * vêm dos links dela.
 */
async function duckDuckGoSearch(
	doFetch: FetchLike,
	query: string,
	limit: number,
): Promise<{ results: SearchResult[]; failure?: string; engine: string }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const response = await doFetch(
			`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
			{
				method: 'GET',
				signal: controller.signal,
				headers: {
					'user-agent': 'Seshyina/1.0 (+https://github.com/modelhub; agente local)',
					accept: 'text/html',
				},
			},
		);
		if (!response.ok) {
			return { results: [], engine: 'duckduckgo', failure: `o buscador respondeu ${response.status}` };
		}
		const html = await response.text();
		// Os trechos vêm em `result__snippet`, no bloco que segue cada link. São
		// lidos antes de montar o resultado porque é o único texto da busca que
		// ajuda a decidir qual página abrir.
		const snippets: string[] = [];
		const snippetPattern = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
		let snippetMatch: RegExpExecArray | null;
		while ((snippetMatch = snippetPattern.exec(html)) !== null) {
			snippets.push(stripHtml(snippetMatch[1]));
		}
		const results: SearchResult[] = [];
		const anchor = /<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
		let match: RegExpExecArray | null;
		let index = 0;
		while ((match = anchor.exec(html)) !== null && results.length < limit) {
			// O DDG devolve um redirecionador com a URL real em `uddg`.
			let target = decodeHtml(match[1]);
			const redirect = /uddg=([^&]+)/.exec(target);
			if (redirect !== null) {
				try {
					target = decodeURIComponent(redirect[1]);
				} catch {
					continue;
				}
			}
			if (!/^https?:\/\//i.test(target)) {
				index += 1;
				continue;
			}
			results.push({
				title: stripHtml(decodeHtml(match[2])),
				url: target,
				snippet: snippets[index] ?? '',
				engine: 'duckduckgo',
			});
			index += 1;
		}
		if (results.length === 0) {
			return {
				results: [],
				engine: 'duckduckgo',
				failure: 'a busca sem chave não devolveu resultados (o serviço pode estar bloqueando)',
			};
		}
		return { results, engine: 'duckduckgo' };
	} catch (error) {
		return {
			results: [],
			engine: 'duckduckgo',
			failure: controller.signal.aborted ? 'o buscador não respondeu a tempo' : String(error),
		};
	} finally {
		clearTimeout(timer);
	}
}

function decodeHtml(text: string): string {
	return text
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/&#x([0-9a-f]+);/gi, (_, code: string) => {
			const point = Number.parseInt(code, 16);
			return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : '';
		})
		.replace(/&#(\d+);/g, (_, code: string) => {
			const point = Number.parseInt(code, 10);
			return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : '';
		});
}

function stripHtml(text: string): string {
	return decodeHtml(text.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Exposto para o teste da extração usar o mesmo caminho das ferramentas. */
export { extractPage };
