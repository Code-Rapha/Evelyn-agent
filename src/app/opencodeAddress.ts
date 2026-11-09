/**
 * Onde a Evelyn aceita falar com um servidor OpenCode — e por quê.
 *
 * ## A regra, dita uma vez
 *
 * - **`http://` só em loopback** (`127.0.0.1`, `::1`, `localhost` e os nomes
 *   de loopback padrão). Em loopback não há rede no caminho, e é exatamente o
 *   caso documentado do `opencode serve`.
 * - **`https://` para qualquer destino público** — não há como garantir
 *   confidencialidade numa rede sem TLS, e a senha vai num cabeçalho Basic.
 * - **Nunca** endereço que não seja `http`/`https` (`file:`, `ftp:`,
 *   `javascript:`, `data:`), nem URL com usuário/senha embutidos.
 * - **Nunca** IP privado, link-local, CGNAT, loopback por `https` remoto
 *   ambíguo, ou nome que resolva para eles — com TLS ou sem. "Privado" aqui é
 *   o caso em que a requisição sairia para a rede interna em nome de quem
 *   pediu: é a definição de SSRF, e um app local não tem motivo para isso.
 *
 * A validação é feita **duas vezes**: no texto da URL (antes de conectar) e
 * no IP **resolvido** (DNS rebinding). O `fetch` do Node não permite fixar o
 * IP da conexão, então a segunda checagem acontece imediatamente antes de a
 * requisição sair, e o redirecionamento é recusado — o destino não pode mudar
 * no meio.
 */

/** O resultado de validar um endereço. */
export type AddressVerdict =
	| { readonly ok: true; readonly url: URL; readonly loopback: boolean }
	| { readonly ok: false; readonly reason: string };

/** Um IP em forma canônica, ou `undefined` quando o texto não é IP. */
export function parseIpv4(value: string): number[] | undefined {
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

/** O IPv4 é loopback (127.0.0.0/8)? */
export function isLoopbackIpv4(octets: readonly number[]): boolean {
	return octets[0] === 127;
}

/**
 * O IPv4 é privado ou "não público" — a lista que um SSRF explora.
 *
 * Inclui redes privadas (10/8, 172.16/12, 192.168/16), link-local
 * (169.254/16, onde vive o metadata de nuvem), CGNAT (100.64/10), "esta rede"
 * (0/8), multicast, reservado e broadcast. Loopback **não** está aqui: ele é
 * tratado à parte, porque é o único que o app aceita sem TLS.
 */
export function isNonPublicIpv4(octets: readonly number[]): boolean {
	const [a, b] = octets;
	if (a === 0) {
		return true;
	}
	if (a === 10) {
		return true;
	}
	if (a === 172 && b >= 16 && b <= 31) {
		return true;
	}
	if (a === 192 && b === 168) {
		return true;
	}
	if (a === 169 && b === 254) {
		return true;
	}
	if (a === 100 && b >= 64 && b <= 127) {
		return true;
	}
	if (a >= 224) {
		return true;
	}
	return false;
}

/**
 * O IPv6 é loopback (`::1`)?
 *
 * Aceita também a forma mapeada `::ffff:127.x.x.x`, que é o IPv4 embrulhado.
 */
export function isLoopbackIpv6(value: string): boolean {
	const normalized = value.toLowerCase().replace(/^\[|\]$/g, '');
	if (normalized === '::1') {
		return true;
	}
	const mapped = normalized.match(/^::ffff:(127(?:\.\d{1,3}){3})$/);
	return mapped !== null && isLoopbackIpv4(parseIpv4(mapped[1]) ?? []);
}

/**
 * O IPv6 é não público (link-local `fe80::/10`, ULA `fc00::/7`, embrulhado
 * IPv4 privado, multicast)?
 */
export function isNonPublicIpv6(value: string): boolean {
	const normalized = value.toLowerCase().replace(/^\[|\]$/g, '');
	const mapped = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
	if (mapped !== null) {
		// IPv4 embrulhado num IPv6: vale a regra do IPv4.
		const octets = parseIpv4(mapped[1]);
		return octets === undefined ? true : isNonPublicIpv4(octets);
	}
	if (normalized.startsWith('fe80') || normalized.startsWith('fec0')) {
		return true;
	}
	if (/^f[cd][0-9a-f]{2}/.test(normalized)) {
		return true;
	}
	if (normalized.startsWith('ff')) {
		return true;
	}
	return false;
}

/** Os nomes que só podem ser loopback por definição. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Valida o texto do endereço.
 *
 * Não resolve DNS: um nome público passa aqui e é checado de novo no IP
 * resolvido, antes da conexão.
 */
export function validateOpencodeBaseUrl(raw: string): AddressVerdict {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		return { ok: false, reason: 'o endereço não é uma URL válida' };
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return { ok: false, reason: `o protocolo "${url.protocol}" não é aceito; use http ou https` };
	}
	if (url.username.length > 0 || url.password.length > 0) {
		return {
			ok: false,
			reason: 'o endereço não pode levar usuário e senha embutidos; a autenticação tem o campo dela',
		};
	}
	const host = url.hostname.toLowerCase();
	const isLoopbackName = LOOPBACK_HOSTS.has(host);
	const octets = parseIpv4(host);
	const isLoopbackAddress =
		(octets !== undefined && isLoopbackIpv4(octets)) || isLoopbackIpv6(host);
	const loopback = isLoopbackName || isLoopbackAddress;

	if (url.protocol === 'http:' && !loopback) {
		return {
			ok: false,
			reason:
				'HTTP só é aceito em loopback (127.0.0.1 ou localhost); para um destino remoto use HTTPS',
		};
	}
	if (loopback && url.protocol === 'https:') {
		// HTTPS para loopback é possível (um proxy local com TLS), mas o app
		// não tem como validar esse certificado — e aceitar seria pior.
		return { ok: false, reason: 'para loopback use http://, como o `opencode serve` documenta' };
	}
	if (octets !== undefined && isNonPublicIpv4(octets)) {
		return { ok: false, reason: 'endereços de rede privada não são aceitos' };
	}
	if (octets === undefined && isNonPublicIpv6(host)) {
		return { ok: false, reason: 'endereços IPv6 privados ou link-local não são aceitos' };
	}
	return { ok: true, url, loopback };
}

/**
 * Valida o IP **resolvido** antes da conexão.
 *
 * É a segunda metade da defesa: um nome público que resolve para `127.0.0.1`
 * ou para a rede interna passaria na checagem de texto e é recusado aqui.
 */
export function validateResolvedIp(
	address: string,
	loopbackExpected: boolean,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
	const octets = parseIpv4(address);
	const loopbackIpv4 = octets !== undefined && isLoopbackIpv4(octets);
	const loopbackIpv6 = isLoopbackIpv6(address);
	if (address === 'localhost' || LOOPBACK_HOSTS.has(address.toLowerCase()) || loopbackIpv4 || loopbackIpv6) {
		return loopbackExpected
			? { ok: true }
			: {
					ok: false,
					reason: 'o nome do endereço resolve para loopback; isso não é um destino remoto válido',
				};
	}
	if (octets !== undefined && isNonPublicIpv4(octets)) {
		return { ok: false, reason: 'o endereço resolve para a rede privada; acesso negado' };
	}
	if (octets === undefined && isNonPublicIpv6(address)) {
		return { ok: false, reason: 'o endereço resolve para um IP privado ou link-local; acesso negado' };
	}
	return { ok: true };
}

/** O cabeçalho de autenticação do OpenCode: Basic, usuário `opencode`. */
export function basicAuthHeader(password: string): string {
	return `Basic ${Buffer.from(`opencode:${password}`, 'utf8').toString('base64')}`;
}
