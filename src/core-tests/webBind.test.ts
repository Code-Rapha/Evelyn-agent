/**
 * O servidor local, contra o processo de verdade.
 *
 * ## O que este arquivo prova e o `webServer.test.ts` não prova
 *
 * Que o bind é em loopback **na máquina**, e não só na intenção: aqui o
 * servidor sobe com `startWebServer`, e uma conexão vinda de uma interface
 * que não é o loopback (o IPv4 da rede local, que existe como `0.0.0.0`)
 * não alcança o socket. Se o servidor tivesse escutado em todas as
 * interfaces, ela alcançaria.
 */
import * as assert from 'assert';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LOOPBACK_ADDRESS } from '../web/policy';
import { startWebServer } from '../web/server';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

/** Um `GET` com o `Host` que o servidor aceita, para o health. */
function health(port: number, token: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const request = httpRequest(
			{
				host: LOOPBACK_ADDRESS,
				port,
				path: '/api/health',
				headers: { host: `127.0.0.1:${port}`, 'x-seshyina-token': token },
			},
			(response) => {
				response.resume();
				response.on('end', () => resolve(response.statusCode ?? 0));
			},
		);
		request.on('error', reject);
		request.end();
	});
}

suite('Web Fase 1: o socket de verdade', () => {
	let assetsDir: string;

	setup(async () => {
		assetsDir = await mkdtemp(join(tmpdir(), 'seshyina-web-bind-'));
		await writeFile(join(assetsDir, 'index.html'), '<!doctype html>', 'utf8');
	});

	teardown(async () => {
		await removeFixtureTree(assetsDir);
	});

	test('o endereço reportado é o loopback, nunca todas as interfaces', async () => {
		const server = await startWebServer({ version: '0.0.1', assetsDir, port: 0 });
		try {
			assert.strictEqual(server.address, LOOPBACK_ADDRESS);
			assert.strictEqual(await health(server.port, server.token), 200);
		} finally {
			await server.close();
		}
	});

	test('uma conexão por um IP de rede local não alcança o socket', async () => {
		const external = networkInterfaceAddress();
		if (external === undefined) {
			// Uma máquina sem rede: não há o que tentar, e o teste não pode
			// inventar um IP para "passar".
			return;
		}
		const server = await startWebServer({ version: '0.0.1', assetsDir, port: 0 });
		try {
			const reached = await new Promise<boolean>((resolve) => {
				const request = connect({ host: external, port: server.port, timeout: 1500 });
				request.once('connect', () => {
					request.destroy();
					resolve(true);
				});
				request.once('error', () => resolve(false));
				request.once('timeout', () => {
					request.destroy();
					resolve(false);
				});
			});
			assert.strictEqual(reached, false, `conectou por ${external}`);
		} finally {
			await server.close();
		}
	});
});

/** Um endereço IPv4 da rede local da máquina, quando há um. */
function networkInterfaceAddress(): string | undefined {
	const interfaces = networkInterfaces();
	for (const entries of Object.values(interfaces)) {
		for (const entry of entries ?? []) {
			if (entry.family === 'IPv4' && entry.internal === false) {
				return entry.address;
			}
		}
	}
	return undefined;
}
