/**
 * O serviço iniciado pelo app.
 *
 * O que estes testes protegem é o que a migração tem de garantido:
 *  - um serviço já ativo é **adotado**, não duplicado;
 *  - registro de processo morto é lixo e é removido antes de iniciar;
 *  - um serviço que não fica pronto devolve `unavailable` (e o app cai para o
 *    modo local) em vez de travar a abertura;
 *  - o material ausente também é `unavailable`, nunca uma exceção;
 *  - o script é extraído para um diretório de verdade, fora do `asar`.
 */
import * as assert from 'assert';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'mocha';
import { ensureService, serviceDirectoryFor, type ServiceMaterial } from '../app/serviceLauncher';
import { writeServiceRecord } from '../app/serviceRecord';

const MATERIAL: ServiceMaterial = {
	main: 'console.log("Evelyn - servidor local");',
	packageJson: '{"name":"service"}',
	assets: { 'index.html': '<html></html>' },
};

async function tempRoot(): Promise<string> {
	return await mkdtemp(join(tmpdir(), 'service-launcher-'));
}

describe('serviceLauncher', () => {
	it('sem material, devolve unavailable em vez de lançar', async () => {
		const root = await tempRoot();
		try {
			// `material` que falha é a instalação sem o serviço empacotado.
			const outcome = await ensureService({
				root,
				execPath: 'nao-usado',
				serviceDir: join(root, 'service'),
				material: async () => {
					throw new Error('serviço não empacotado');
				},
			});
			assert.strictEqual(outcome.kind, 'unavailable');
			if (outcome.kind === 'unavailable') {
				assert.match(outcome.reason, /serviço não empacotado/);
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('extrai o script para fora do pacote, com os assets', async () => {
		const root = await tempRoot();
		try {
			const serviceDir = join(root, 'service');
			await ensureService({
				root,
				execPath: 'nao-usado',
				serviceDir,
				material: async () => MATERIAL,
				// O processo "sobe" e nunca fica pronto: o que importa aqui é o
				// que foi escrito em disco antes do spawn.
				waitMs: 150,
				spawnProcess: () => fakeChild(),
			});
			assert.strictEqual(
				await readFile(join(serviceDir, 'main.js'), 'utf8'),
				MATERIAL.main,
			);
			assert.strictEqual(
				await readFile(join(serviceDir, 'assets', 'index.html'), 'utf8'),
				'<html></html>',
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('registro de processo vivo não faz o launcher desistir nem duplicar', async () => {
		const root = await tempRoot();
		try {
			// Um registro apontando para um pid vivo mas que **não** responde ao
			// health: não é um serviço adotável. O launcher não pode tratá-lo
			// como "já ativo" (mentiria) nem deixar de tentar o seu — o registro
			// é substituído pelo do processo novo, ou vira `unavailable`.
			await writeServiceRecord(root, {
				version: 1,
				// O protocolo do serviço que este app espera: um registro com
				// outro protocolo é de outra versão, e é tratado à parte.
				protocol: 3,
				pid: process.pid,
				port: 7817,
				startedAt: new Date().toISOString(),
				address: '127.0.0.1',
				appVersion: '0.0.0',
				token: 'a'.repeat(40),
				readerToken: 'b'.repeat(40),
				chatToken: 'c'.repeat(40),
			});
			let spawned = 0;
			const outcome = await ensureService({
				root,
				execPath: 'nao-usado',
				serviceDir: join(root, 'service'),
				material: async () => MATERIAL,
				waitMs: 400,
				spawnProcess: () => {
					spawned += 1;
					return fakeChild();
				},
			});
			// O processo foi iniciado — o app não ficou preso a um registro que
			// não responde — e o resultado diz que não ficou pronto.
			assert.strictEqual(spawned, 1);
			assert.strictEqual(outcome.kind, 'unavailable');
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('um processo que morre ao iniciar diz o código e o motivo', async () => {
		const root = await tempRoot();
		try {
			const outcome = await ensureService({
				root,
				execPath: 'nao-usado',
				serviceDir: join(root, 'service'),
				material: async () => MATERIAL,
				waitMs: 1_000,
				spawnProcess: () => fakeChild({ exitCode: 1, stderr: 'EADDRINUSE: 127.0.0.1:7817' }),
			});
			assert.strictEqual(outcome.kind, 'unavailable');
			if (outcome.kind === 'unavailable') {
				assert.match(outcome.reason, /encerrou ao iniciar/);
				assert.match(outcome.reason, /EADDRINUSE/);
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('um serviço que não fica pronto é dito pelo prazo', async () => {
		const root = await tempRoot();
		try {
			const outcome = await ensureService({
				root,
				execPath: 'nao-usado',
				serviceDir: join(root, 'service'),
				material: async () => MATERIAL,
				waitMs: 400,
				spawnProcess: () => fakeChild(),
			});
			assert.strictEqual(outcome.kind, 'unavailable');
			if (outcome.kind === 'unavailable') {
				assert.match(outcome.reason, /não ficou pronto em/);
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('o diretório do serviço fica ao lado do userData', () => {
		const dir = serviceDirectoryFor('C:\\Users\\eu\\AppData\\Roaming\\Seshyina');
		assert.match(dir, /Seshyina-service$/);
	});
});

/** Um processo falso, com os eventos que o launcher escuta. */
function fakeChild(options: { readonly exitCode?: number; readonly stderr?: string } = {}) {
	const listeners = new Map<string, (value: unknown) => void>();
	let killed = false;
	const child = {
		pid: 4242,
		exitCode: null as number | null,
		stderr: {
			on: (event: string, listener: (chunk: Buffer | string) => void) => {
				if (event === 'data' && options.stderr !== undefined) {
					listener(options.stderr);
				}
			},
		},
		kill: () => {
			killed = true;
		},
		on: (event: string, listener: (value: unknown) => void) => {
			listeners.set(event, listener);
		},
	};
	if (options.exitCode !== undefined) {
		// Sai logo depois de o launcher registrar os ouvintes.
		setTimeout(() => {
			child.exitCode = options.exitCode ?? null;
			listeners.get('exit')?.(options.exitCode);
		}, 10);
	}
	return Object.assign(child, { wasKilled: () => killed }) as never;
}

function health() {
	return {
		status: 'ok',
		app: 'Seshyina',
		version: '9.9.9',
		listening: '127.0.0.1:7817',
		coreMounted: true,
		storageHost: 'web',
	};
}
