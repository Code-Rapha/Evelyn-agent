/**
 * R3: o serviço local como processo de verdade, sem Electron.
 *
 * ## O que este arquivo faz e o que ele NÃO faz
 *
 * Ele executa `dist/web/main.js` como processo filho, com uma raiz temporária,
 * e conversa com ele por HTTP — `/api/health`, `/v1/models`,
 * `/v1/chat/completions` — e pela CLI (`--status`, `--stop`).
 *
 * **Não há mock de servidor**: o processo é o mesmo binário que o usuário
 * roda. O único substituto é o provedor externo, que não existe nesta máquina
 * em teste; por isso os testes de conversa verificam a **recusa correta** para
 * um modelo fora do catálogo, e não uma resposta de modelo.
 *
 * ## Pré-requisito
 *
 * `npm run web:build` precisa ter rodado (o teste usa `dist/web/main.js`). Se
 * o bundle não existir, o suite falha dizendo isso — não passa em silêncio.
 */
import * as assert from 'assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { probeService } from '../app/discoverService';
import { readServiceRecord, STORAGE_LOCK_FILE_NAME } from './helpers/serviceFiles';
import { ApiKeyStore, API_KEYS_FILE } from '../core/security/apiKeys';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const ENTRY = join(process.cwd(), 'dist', 'web', 'main.js');
const roots: string[] = [];
const children: ChildProcess[] = [];

interface Service {
	readonly root: string;
	readonly child: ChildProcess;
	readonly port: number;
	readonly token: string;
	/** Mata o processo sem deixá-lo limpar (simula kill -9 / queda). */
	kill(): void;
	/** Pede o encerramento e espera sair. */
	stop(): Promise<void>;
}

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'evelyn-r3-'));
	roots.push(root);
	return root;
}

/** Sobe o serviço e espera o registro aparecer. */
async function startService(root: string): Promise<Service> {
	assert.ok(existsSync(ENTRY), 'o bundle dist/web/main.js não existe: rode `npm run web:build` antes');
	const child = spawn(process.execPath, [ENTRY, '--root', root, '--port', '0'], {
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	children.push(child);
	let stdout = '';
	child.stdout?.setEncoding('utf8');
	child.stderr?.setEncoding('utf8');
	child.stdout?.on('data', (chunk: string) => (stdout += chunk));

	const deadline = Date.now() + 25_000;
	for (;;) {
		const probe = await probeService({ root });
		if (probe.kind === 'active') {
			return {
				root,
				child,
				port: probe.record.port,
				token: probe.record.token,
				kill() {
					child.kill('SIGKILL');
				},
				async stop() {
					const stopped = await runCli(root, '--stop');
					assert.equal(stopped.code, 0, `--stop falhou: ${stopped.stdout}`);
					await waitExit(child);
				},
			};
		}
		if (Date.now() > deadline) {
			throw new Error(`o serviço não ficou ativo a tempo. stdout=${stdout}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

/** Roda a CLI do serviço contra uma raiz. */
async function runCli(
	root: string,
	...args: string[]
): Promise<{ readonly code: number | null; readonly stdout: string }> {
	const child = spawn(process.execPath, [ENTRY, '--root', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
	children.push(child);
	let stdout = '';
	child.stdout?.setEncoding('utf8');
	child.stdout?.on('data', (chunk: string) => (stdout += chunk));
	child.stderr?.setEncoding('utf8');
	const code = await new Promise<number | null>((resolve) => {
		child.on('exit', (exitCode) => resolve(exitCode));
	});
	return { code, stdout };
}

async function waitExit(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null) {
		return;
	}
	await new Promise<void>((resolve) => {
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			resolve();
		}, 15_000);
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

suite('R3: serviço local real, sem Electron', () => {
	test('sobe, publica o registro e responde ao health autenticado', async () => {
		const root = await makeRoot();
		const service = await startService(root);
		try {
			const probe = await probeService({ root });
			assert.equal(probe.kind, 'active');
			if (probe.kind !== 'active') {
				return;
			}
			assert.equal(probe.health.coreMounted, true, 'o serviço montou o Core');
			assert.equal(probe.health.storageHost, 'web');
			assert.equal(probe.record.pid, service.child.pid);

			// Sem a credencial, o health é 401: a porta aberta não é identidade.
			const anonymous = await fetch(`http://127.0.0.1:${service.port}/api/health`);
			assert.equal(anonymous.status, 401);
			await anonymous.text();
		} finally {
			await service.stop();
		}
	});

	test('o registro do serviço não contém chave de provedor nem caminho', async () => {
		const root = await makeRoot();
		const service = await startService(root);
		try {
			const read = await readServiceRecord(root);
			assert.equal(read.kind, 'ok');
			if (read.kind !== 'ok') {
				return;
			}
			const serialized = JSON.stringify(read.record);
			assert.equal(serialized.includes(root), false, 'o registro não carga o caminho da raiz');
			assert.equal(serialized.includes('sk-'), false);
			assert.deepEqual(Object.keys(read.record).sort(), [
				'address',
				'appVersion',
				'chatToken',
				'pid',
				'port',
				'protocol',
				'readerToken',
				'startedAt',
				'token',
				'version',
			]);
			// R4A/R4C: as três credenciais são diferentes — o leitor não
			// carrega o poder de escrita do painel, nem o de conversa.
			assert.notEqual(read.record['readerToken'], read.record['token']);
			assert.notEqual(read.record['chatToken'], read.record['token']);
			assert.notEqual(read.record['chatToken'], read.record['readerToken']);
		} finally {
			await service.stop();
		}
	});

	test('/v1 responde com chave e recusa sem ela', async () => {
		const root = await makeRoot();
		// A superfície `/v1` só sobe com chave de cliente configurada.
		const keys = new ApiKeyStore({ filePath: join(root, API_KEYS_FILE) });
		const created = await keys.create({ name: 'r3' });
		const service = await startService(root);
		try {
			const base = `http://127.0.0.1:${service.port}`;
			const withKey = await fetch(`${base}/v1/models`, {
				headers: { authorization: `Bearer ${created.secret}` },
			});
			assert.equal(withKey.status, 200);
			const body = (await withKey.json()) as { object: string };
			assert.equal(body.object, 'list');

			const withoutKey = await fetch(`${base}/v1/models`);
			assert.equal(withoutKey.status, 401);
			await withoutKey.text();

			// Um modelo que não está no catálogo é recusado, e não inventado.
			const chat = await fetch(`${base}/v1/chat/completions`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: `Bearer ${created.secret}` },
				body: JSON.stringify({
					model: 'nenhum/modelo',
					messages: [{ role: 'user', content: 'oi' }],
				}),
			});
			assert.equal(chat.status, 404);
			const error = (await chat.json()) as { error: { code: string } };
			assert.equal(error.error.code, 'no_candidate');
		} finally {
			await service.stop();
		}
	});

	test('duas instâncias na mesma raiz: a segunda não monta o Core nem toma o lock', async () => {
		const root = await makeRoot();
		const first = await startService(root);
		try {
			const bundle = spawn(process.execPath, [ENTRY, '--root', root, '--port', '0'], {
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			children.push(bundle);
			let stdout = '';
			bundle.stdout?.setEncoding('utf8');
			bundle.stdout?.on('data', (chunk: string) => (stdout += chunk));

			const deadline = Date.now() + 20_000;
			while (!stdout.includes('ATENCAO') && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}

			assert.match(stdout, /ATENCAO/, 'a segunda instância diz por que não montou');
			assert.match(stdout, /serviço local da Evelyn está no ar/, 'a recusa nomeia o serviço como dono');
			assert.match(stdout, /sem montar o Core/);

			// E o primeiro continua sendo o dono.
			const probe = await probeService({ root });
			assert.equal(probe.kind, 'active');
			if (probe.kind === 'active') {
				assert.equal(probe.record.pid, first.child.pid);
			}
			bundle.kill('SIGKILL');
			await waitExit(bundle);
		} finally {
			await first.stop();
		}
	});

	test('encerrar libera o lock e o registro, e outro pode entrar', async () => {
		const root = await makeRoot();
		const service = await startService(root);
		await service.stop();

		assert.equal(existsSync(join(root, 'service.json')), false, 'o registro sai ao encerrar');
		assert.equal(existsSync(join(root, STORAGE_LOCK_FILE_NAME)), false, 'o lock é liberado');
		assert.equal((await probeService({ root })).kind, 'absent');

		// Outro processo consegue montar a mesma raiz.
		const again = await startService(root);
		await again.stop();
	});

	test('lock órfão depois de encerramento abrupto é recuperado', async () => {
		const root = await makeRoot();
		const service = await startService(root);
		service.kill();
		await waitExit(service.child);

		// O processo morreu sem limpar: registro e lock ficaram.
		const orphaned = await probeService({ root });
		assert.ok(
			orphaned.kind === 'stale' || orphaned.kind === 'absent',
			`um registro de processo morto não é "ativo" (recebido: ${orphaned.kind})`,
		);

		// A próxima instância recupera a raiz — sem intervenção manual.
		const recovered = await startService(root);
		try {
			const probe = await probeService({ root });
			assert.equal(probe.kind, 'active');
			if (probe.kind === 'active') {
				assert.equal(probe.record.pid, recovered.child.pid);
			}
		} finally {
			await recovered.stop();
		}
	});

	test('--status reflete o estado real', async () => {
		const root = await makeRoot();
		const stopped = await runCli(root, '--status');
		assert.equal(stopped.code, 1);
		assert.match(stopped.stdout, /serviço parado/);

		const service = await startService(root);
		try {
			const active = await runCli(root, '--status');
			assert.equal(active.code, 0);
			assert.match(active.stdout, /serviço ativo/);
			// A linha não carrega a credencial.
			const probe = await probeService({ root });
			if (probe.kind === 'active') {
				assert.equal(active.stdout.includes(probe.record.token), false);
			}
		} finally {
			await service.stop();
		}
	});

	test('--stop encerra e a segunda vez não há nada a encerrar', async () => {
		const root = await makeRoot();
		const service = await startService(root);

		const first = await runCli(root, '--stop');
		assert.equal(first.code, 0);
		await waitExit(service.child);

		const second = await runCli(root, '--stop');
		assert.equal(second.code, 0);
		assert.match(second.stdout, /nada a encerrar/);
	});

	test('o serviço sobrevive ao encerramento de quem só consultou o status', async () => {
		// Equivalente ao "Electron fecha e o serviço continua": consultar o
		// estado é uma conexão curta, e ela não encerra nada.
		const root = await makeRoot();
		const service = await startService(root);
		try {
			await runCli(root, '--status');
			await runCli(root, '--status');

			const probe = await probeService({ root });
			assert.equal(probe.kind, 'active');
			const health = await fetch(`http://127.0.0.1:${service.port}/api/health`, {
				headers: { 'x-seshyina-token': service.token },
			});
			assert.equal(health.status, 200);
			await health.text();
		} finally {
			await service.stop();
		}
	});
});
