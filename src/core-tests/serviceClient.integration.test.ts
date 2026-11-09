/**
 * R4A: o cliente do desktop contra o serviço de verdade.
 *
 * ## O que só este teste pode provar
 *
 * - o cliente atravessa a descoberta real (registro, pid, health autenticado)
 *   e lê o catálogo do serviço com a credencial de leitura;
 * - **o cliente não monta um Core**: depois de conectar, a raiz continua com
 *   um único dono — o processo do serviço;
 * - um serviço que encerra no meio é reportado como ausente, e não como um
 *   resultado antigo;
 * - o Electron real abre com o serviço ativo e não inicia um Core próprio.
 */
import * as assert from 'assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ServiceClient } from '../desktop/serviceClient';
import { readServiceRecord, STORAGE_LOCK_FILE_NAME } from './helpers/serviceFiles';
import { probeService } from '../app/discoverService';
import { ApiKeyStore, API_KEYS_FILE } from '../core/security/apiKeys';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const SERVICE_ENTRY = join(process.cwd(), 'dist', 'web', 'main.js');
const ELECTRON = join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe');
const DESKTOP_MAIN = join(process.cwd(), 'dist', 'desktop', 'main.js');

const children: ChildProcess[] = [];
const roots: string[] = [];

async function startService(root: string): Promise<ChildProcess> {
	assert.ok(
		existsSync(SERVICE_ENTRY),
		'o bundle dist/web/main.js não existe: rode `npm run web:build`',
	);
	const child = spawn(process.execPath, [SERVICE_ENTRY, '--root', root, '--port', '0'], {
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	children.push(child);
	const deadline = Date.now() + 25_000;
	for (;;) {
		if ((await probeService({ root })).kind === 'active') {
			return child;
		}
		if (Date.now() > deadline) {
			throw new Error('o serviço não ficou ativo a tempo');
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

async function runCli(root: string, ...args: string[]): Promise<number | null> {
	const child = spawn(process.execPath, [SERVICE_ENTRY, '--root', root, ...args], {
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	children.push(child);
	return await new Promise((resolve) => child.on('exit', (code) => resolve(code)));
}

async function waitExit(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null) {
		return;
	}
	await new Promise<void>((resolve) => {
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			resolve();
		}, 20_000);
		child.on('exit', () => {
			clearTimeout(timer);
			resolve();
		});
	});
}

teardown(async () => {
	for (const child of children.splice(0)) {
		if (child.exitCode === null) {
			child.kill('SIGKILL');
		}
	}
	for (const root of roots.splice(0)) {
		await removeFixtureTree(root).catch(() => undefined);
	}
});

suite('R4A: cliente real contra o serviço real', () => {
	test('sem serviço, o cliente diz "inactive" e não monta nada', async () => {
		const root = await mkdtemp(join(tmpdir(), 'evelyn-r4a-empty-'));
		roots.push(root);
		const client = new ServiceClient({ root });

		const status = await client.status();
		const catalog = await client.catalog();

		assert.equal(status.state, 'inactive');
		assert.equal(status.reason, 'inactive');
		assert.equal(catalog.ok, false);
		// Nada foi criado na raiz: o cliente não monta Core nem escreve.
		assert.equal(existsSync(join(root, STORAGE_LOCK_FILE_NAME)), false);
		assert.deepEqual(await readServiceRecord(root), { kind: 'absent' });
	});

	test('com serviço, o estado e o catálogo vêm dele', async () => {
		const root = await mkdtemp(join(tmpdir(), 'evelyn-r4a-active-'));
		roots.push(root);
		// Uma chave de cliente faz o serviço subir `/v1` também — o catálogo
		// vem do Core dele, não de um Core do teste.
		const keys = new ApiKeyStore({ filePath: join(root, API_KEYS_FILE) });
		await keys.create({ name: 'r4a' });
		const service = await startService(root);
		try {
			const client = new ServiceClient({ root });

			const status = await client.status();
			assert.equal(status.state, 'active');
			assert.equal(status.pid, service.pid);
			assert.equal(typeof status.port, 'number');
			assert.match(status.detail, /conectado/);

			const catalog = await client.catalog();
			assert.equal(catalog.ok, true);
			if (catalog.ok) {
				// O serviço não tem modelos descobertos (nenhum provedor real
				// configurado): a lista vem vazia **com** a política, e não é
				// um erro.
				assert.ok(Array.isArray(catalog.value.models));
				assert.equal(typeof catalog.value.policy.policy, 'string');
			}

			// A prova central: o cliente não montou um Core concorrente.
			const owner = await readServiceRecord(root);
			assert.equal(owner.kind, 'ok');
			if (owner.kind === 'ok') {
				assert.equal(owner.record.pid, service.pid, 'o lock continua do serviço');
			}
		} finally {
			await runCli(root, '--stop');
			await waitExit(service);
		}
	});

	test('a credencial de leitura que chega ao cliente não é a do painel', async () => {
		const root = await mkdtemp(join(tmpdir(), 'evelyn-r4a-creds-'));
		roots.push(root);
		const service = await startService(root);
		try {
			const owner = await readServiceRecord(root);
			assert.equal(owner.kind, 'ok');
			if (owner.kind !== 'ok') {
				return;
			}
			const reader = owner.record['readerToken'];
			const panel = owner.record['token'];
			assert.equal(typeof reader, 'string');
			assert.equal(typeof panel, 'string');
			assert.notEqual(reader, panel, 'o registro publica duas credenciais diferentes');

			// E o leitor não encerra o serviço.
			const shutdown = await fetch(`http://127.0.0.1:${owner.record['port']}/api/service/shutdown`, {
				method: 'POST',
				headers: { 'x-seshyina-reader': reader as string },
			});
			await shutdown.text();
			assert.equal(shutdown.status, 401);
			assert.equal((await probeService({ root })).kind, 'active');
		} finally {
			await runCli(root, '--stop');
			await waitExit(service);
		}
	});

	test('um serviço que encerra no meio é reportado como ausente', async () => {
		const root = await mkdtemp(join(tmpdir(), 'evelyn-r4a-gone-'));
		roots.push(root);
		const service = await startService(root);
		const client = new ServiceClient({ root });
		assert.equal((await client.status()).state, 'active');

		await runCli(root, '--stop');
		await waitExit(service);

		const after = await client.status();
		assert.equal(after.state, 'inactive');
		assert.ok(after.reason === 'inactive' || after.reason === 'unreachable');
		// O caminho de erro não carrega credencial nem caminho da raiz.
		assert.equal(after.detail.includes(root), false);
	});

	test('o Electron real abre com o serviço ativo sem montar Core', async function () {
		if (!existsSync(ELECTRON) || !existsSync(DESKTOP_MAIN)) {
			this.pending('faltou o build do desktop ou o binário do Electron');
			return;
		}
		const root = await mkdtemp(join(tmpdir(), 'evelyn-r4a-electron-'));
		roots.push(root);
		const service = await startService(root);
		try {
			const electron = spawn(ELECTRON, [DESKTOP_MAIN, '--root', root], {
				stdio: ['ignore', 'pipe', 'pipe'],
				env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
			});
			children.push(electron);
			let stdout = '';
			let stderr = '';
			electron.stdout?.setEncoding('utf8');
			electron.stderr?.setEncoding('utf8');
			electron.stdout?.on('data', (chunk: string) => (stdout += chunk));
			electron.stderr?.on('data', (chunk: string) => (stderr += chunk));

			const timedOut = await new Promise<boolean>((resolve) => {
				let killed = false;
				const timer = setTimeout(() => {
					killed = true;
					electron.kill('SIGKILL');
				}, 12_000);
				electron.on('exit', () => {
					clearTimeout(timer);
					resolve(killed);
				});
			});

			// R4B: em vez de sair com código 1, o app passa a ficar aberto
			// conectado ao serviço — e continua sem montar Core.
			assert.equal(timedOut, true, 'o app permanece aberto em modo conectado');
			assert.match(stderr, /connected to the local service/);
			assert.equal(stdout.includes('desktop starting'), false, 'não montou um Core próprio');

			// E o serviço continua no ar, dono da raiz.
			const probe = await probeService({ root });
			assert.equal(probe.kind, 'active');
		} finally {
			await runCli(root, '--stop');
			await waitExit(service);
		}
	});
});
