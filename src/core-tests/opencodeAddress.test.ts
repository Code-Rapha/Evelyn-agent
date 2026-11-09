/**
 * Onde a Seshyina aceita falar com um servidor OpenCode — e por quê.
 *
 * ## O que se prova
 *
 * 1. **HTTP só em loopback**: o caso documentado do `opencode serve`;
 * 2. **HTTPS para o resto**; um destino remoto em HTTP é recusado;
 * 3. **Nada de esquema estranho** (`file:`, `ftp:`, `javascript:`) nem de
 *    credencial embutida na URL;
 * 4. **Rede privada recusada**: 10/8, 172.16/12, 192.168/16, link-local,
 *    CGNAT — e o nome que **resolve** para elas;
 * 5. **DNS rebinding**: um nome público que resolve para loopback é recusado
 *    quando o destino deveria ser remoto, e aceito quando é o próprio
 *    loopback.
 *
 * O módulo é puro: nada aqui abre socket.
 */
import * as assert from 'assert';

import {
	basicAuthHeader,
	isNonPublicIpv4,
	isNonPublicIpv6,
	parseIpv4,
	validateOpencodeBaseUrl,
	validateResolvedIp,
} from '../app/opencodeAddress';

suite('OpenCode: onde o app aceita conectar', () => {
	test('http em loopback é aceito, e é o único http', () => {
		for (const url of ['http://127.0.0.1:4096', 'http://localhost:4096', 'http://[::1]:4096']) {
			const verdict = validateOpencodeBaseUrl(url);
			assert.strictEqual(verdict.ok, true, url);
			if (verdict.ok) {
				assert.strictEqual(verdict.loopback, true, url);
			}
		}
	});

	test('http remoto é recusado', () => {
		const verdict = validateOpencodeBaseUrl('http://exemplo.com:4096');
		assert.strictEqual(verdict.ok, false);
		if (!verdict.ok) {
			assert.ok(/loopback/.test(verdict.reason));
		}
	});

	test('https remoto é aceito', () => {
		const verdict = validateOpencodeBaseUrl('https://opencode.exemplo.com');
		assert.strictEqual(verdict.ok, true);
		if (verdict.ok) {
			assert.strictEqual(verdict.loopback, false);
		}
	});

	test('https em loopback é recusado: o certificado não é validável', () => {
		const verdict = validateOpencodeBaseUrl('https://127.0.0.1:4096');
		assert.strictEqual(verdict.ok, false);
	});

	test('esquemas que não são http/https são recusados', () => {
		for (const url of ['file:///etc/passwd', 'ftp://exemplo.com', 'javascript:alert(1)', 'data:text/plain,x']) {
			const verdict = validateOpencodeBaseUrl(url);
			assert.strictEqual(verdict.ok, false, url);
		}
	});

	test('usuário e senha embutidos na URL são recusados', () => {
		const verdict = validateOpencodeBaseUrl('http://opencode:senha@127.0.0.1:4096');
		assert.strictEqual(verdict.ok, false);
		if (!verdict.ok) {
			assert.ok(/usuário e senha/.test(verdict.reason));
		}
	});

	test('texto que não é URL é recusado', () => {
		assert.strictEqual(validateOpencodeBaseUrl('nao e url').ok, false);
		assert.strictEqual(validateOpencodeBaseUrl('').ok, false);
	});

	test('as redes que um SSRF explora são reconhecidas', () => {
		for (const address of ['10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255']) {
			const octets = parseIpv4(address);
			assert.ok(octets !== undefined);
			assert.strictEqual(isNonPublicIpv4(octets ?? []), true, address);
		}
		assert.strictEqual(isNonPublicIpv4(parseIpv4('8.8.8.8') ?? []), false);
		assert.strictEqual(isNonPublicIpv4(parseIpv4('127.0.0.1') ?? []), false, 'loopback é tratado à parte');
	});

	test('endereço de rede privada em https também é recusado', () => {
		for (const url of ['https://10.0.0.1', 'https://192.168.0.10', 'https://169.254.169.254', 'https://172.20.0.1']) {
			const verdict = validateOpencodeBaseUrl(url);
			assert.strictEqual(verdict.ok, false, url);
		}
	});

	test('IPv6 link-local e ULA são reconhecidos', () => {
		assert.strictEqual(isNonPublicIpv6('fe80::1'), true);
		assert.strictEqual(isNonPublicIpv6('fd00::1'), true);
		assert.strictEqual(isNonPublicIpv6('fc00::1'), true);
		assert.strictEqual(isNonPublicIpv6('::ffff:10.0.0.1'), true);
		assert.strictEqual(isNonPublicIpv6('::1'), false);
	});

	test('o IP resolvido tem de ser do tipo que o texto prometeu', () => {
		// Um nome público que resolve para a rede interna: recusa.
		assert.strictEqual(validateResolvedIp('192.168.1.5', false).ok, false);
		assert.strictEqual(validateResolvedIp('10.1.2.3', false).ok, false);
		assert.strictEqual(validateResolvedIp('169.254.169.254', false).ok, false);
		// Um nome público que resolve para loopback — o DNS rebinding clássico.
		assert.strictEqual(validateResolvedIp('127.0.0.1', false).ok, false);
		assert.strictEqual(validateResolvedIp('::1', false).ok, false);
		// Um nome público que resolve para um IP público: aceita.
		assert.strictEqual(validateResolvedIp('93.184.216.34', false).ok, true);
		// Loopback esperado: o loopback é aceito, e a rede interna não.
		assert.strictEqual(validateResolvedIp('127.0.0.1', true).ok, true);
		assert.strictEqual(validateResolvedIp('192.168.1.5', true).ok, false);
	});

	test('o cabeçalho é Basic com o usuário documentado', () => {
		const header = basicAuthHeader('segredo');
		assert.ok(header.startsWith('Basic '));
		const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
		assert.strictEqual(decoded, 'opencode:segredo');
	});
});
