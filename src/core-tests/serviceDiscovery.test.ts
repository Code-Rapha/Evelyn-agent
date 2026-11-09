/**
 * R3: a descoberta do serviço local.
 *
 * ## O que estes testes fixam
 *
 * A regra é: **porta aberta não é identidade**. Cada teste abaixo é um jeito
 * de um cliente ingênuo ser enganado, e todos precisam terminar em recusa:
 *
 * - arquivo ausente → `absent`;
 * - protocolo diferente → `incompatible`;
 * - arquivo corrompido → `invalid`;
 * - processo morto (serviço caiu sem limpar) → `stale`;
 * - health sem resposta → `unresponsive`;
 * - **quem responde não é quem gravou** (outro pid, outra porta, outro app) →
 *   `unresponsive`, sem usar a credencial para mais nada.
 *
 * O `fetchHealth` e a identidade de processo são injetados: o alvo aqui é a
 * **regra de decisão**, testável sem socket. A integração com processos de
 * verdade está em `serviceLifecycle.integration.test.ts`.
 */
import * as assert from 'assert';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { probeService } from '../app/discoverService';
import {
	PROTOCOL_VERSION,
	readServiceRecord,
	removeServiceRecord,
	writeServiceRecord,
	type ServiceRecord,
} from '../app/serviceRecord';
import { describeProbe, stopService } from '../app/serviceLifecycle';

const roots: string[] = [];

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'evelyn-service-'));
	roots.push(root);
	return root;
}

teardown(async () => {
	for (const root of roots.splice(0)) {
		await rm(root, { recursive: true, force: true }).catch(() => undefined);
	}
});

function record(overrides: Partial<ServiceRecord> = {}): ServiceRecord {
	return {
		version: 1,
		protocol: PROTOCOL_VERSION,
		pid: 4242,
		port: 7817,
		startedAt: '2026-01-01T00:00:00.000Z',
		appVersion: '0.0.1',
		token: 'a'.repeat(64),
		readerToken: 'b'.repeat(64),
		chatToken: 'c'.repeat(64),
		address: '127.0.0.1',
		...overrides,
	};
}

/** Um health como o serviço o publica. */
function health(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
	return {
		status: 'ok',
		app: 'Evelyn',
		version: '0.0.1',
		listening: '127.0.0.1:7817',
		coreMounted: true,
		storageHost: 'web',
		pid: 4242,
		...overrides,
	};
}

const alive = async (): Promise<{ readonly kind: 'alive' }> => ({ kind: 'alive' });

suite('R3: descoberta do serviço', () => {
	test('sem registro, o serviço está ausente', async () => {
		const root = await makeRoot();

		const probe = await probeService({ root });

		assert.equal(probe.kind, 'absent');
	});

	test('o registro é gravado restrito ao dono e contém o token', async () => {
		const root = await makeRoot();
		await writeServiceRecord(root, record());

		const read = await readServiceRecord(root);
		assert.equal(read.kind, 'ok');
		if (read.kind === 'ok') {
			assert.equal(read.record.pid, 4242);
			assert.equal(read.record.port, 7817);
		}
		if (process.platform !== 'win32') {
			const info = await stat(join(root, 'service.json'));
			assert.equal(info.mode & 0o777, 0o600);
		}
	});

	test('serviço ativo: arquivo, processo e health concordam', async () => {
		const root = await makeRoot();
		await writeServiceRecord(root, record());

		const probe = await probeService({
			root,
			identity: alive,
			fetchHealth: async (url, token) => {
				assert.equal(url, 'http://127.0.0.1:7817/api/health');
				assert.equal(token, record().token, 'o health é chamado com a credencial do registro');
				return health() as never;
			},
		});

		assert.equal(probe.kind, 'active');
		if (probe.kind === 'active') {
			assert.equal(probe.record.pid, 4242);
			assert.equal(probe.health.coreMounted, true);
		}
	});

	test('um protocolo diferente é incompatível, e não "ativo"', async () => {
		const root = await makeRoot();
		await writeServiceRecord(root, record({ protocol: 99 }));

		const probe = await probeService({ root, identity: alive });

		assert.equal(probe.kind, 'incompatible');
		if (probe.kind === 'incompatible') {
			assert.equal(probe.protocol, 99);
		}
	});

	test('um registro ilegível é recusado, sem tentar o health', async () => {
		const root = await makeRoot();
		await writeFile(join(root, 'service.json'), '{ lixo', 'utf8');
		let asked = false;

		const probe = await probeService({
			root,
			identity: alive,
			fetchHealth: async () => {
				asked = true;
				return health() as never;
			},
		});

		assert.equal(probe.kind, 'invalid');
		assert.equal(asked, false, 'não se fala com a rede a partir de um registro ilegível');
	});

	test('um registro com endereço fora do loopback é recusado', async () => {
		const root = await makeRoot();
		// `writeServiceRecord` aceita o que lhe dão; a **leitura** é que recusa.
		await writeServiceRecord(root, record({ address: '0.0.0.0' }));

		const probe = await probeService({ root, identity: alive });

		assert.equal(probe.kind, 'invalid');
	});

	test('processo morto é "stale", não "ativo"', async () => {
		const root = await makeRoot();
		await writeServiceRecord(root, record());
		let asked = false;

		const probe = await probeService({
			root,
			identity: async () => ({ kind: 'dead' as const }),
			fetchHealth: async () => {
				asked = true;
				return health() as never;
			},
		});

		assert.equal(probe.kind, 'stale');
		assert.equal(asked, false);
	});

	test('sem health não há serviço, mesmo com processo vivo', async () => {
		const root = await makeRoot();
		await writeServiceRecord(root, record());

		const probe = await probeService({
			root,
			identity: alive,
			fetchHealth: async () => undefined,
		});

		assert.equal(probe.kind, 'unresponsive');
	});

	test('quem responde com outro pid não é o serviço', async () => {
		const root = await makeRoot();
		await writeServiceRecord(root, record());

		const probe = await probeService({
			root,
			identity: alive,
			fetchHealth: async () => health({ pid: 9999 }) as never,
		});

		assert.equal(probe.kind, 'unresponsive');
		if (probe.kind === 'unresponsive') {
			assert.match(probe.reason, /9999/);
		}
	});

	test('quem responde em outra porta não é o serviço', async () => {
		const root = await makeRoot();
		await writeServiceRecord(root, record());

		const probe = await probeService({
			root,
			identity: alive,
			fetchHealth: async () => health({ listening: '127.0.0.1:5000' }) as never,
		});

		assert.equal(probe.kind, 'unresponsive');
	});

	test('quem responde e não é Evelyn não é o serviço', async () => {
		const root = await makeRoot();
		await writeServiceRecord(root, record());

		const probe = await probeService({
			root,
			identity: alive,
			fetchHealth: async () => health({ app: 'outro' }) as never,
		});

		assert.equal(probe.kind, 'unresponsive');
	});

	test('o health que demora demais é "unresponsive", não uma espera sem fim', async () => {
		const root = await makeRoot();
		await writeServiceRecord(root, record());

		const probe = await probeService({
			root,
			identity: alive,
			timeoutMs: 30,
			fetchHealth: () => new Promise(() => undefined),
		});

		assert.equal(probe.kind, 'unresponsive');
	});

	test('remover o registro só funciona para o pid dono', async () => {
		const root = await makeRoot();
		await writeServiceRecord(root, record());

		assert.equal(await removeServiceRecord(root, 9999), false);
		assert.equal((await readServiceRecord(root)).kind, 'ok');
		assert.equal(await removeServiceRecord(root, 4242), true);
		assert.equal((await readServiceRecord(root)).kind, 'absent');
	});
});

suite('R3: encerrar o serviço', () => {
	test('não encerra quando não há registro', async () => {
		const root = await makeRoot();
		const result = await stopService({ root, signal: () => assert.fail('não deveria sinalizar') });
		assert.equal(result.kind, 'not-running');
	});

	test('não encerra um processo morto (registro obsoleto)', async () => {
		const root = await makeRoot();
		await writeServiceRecord(root, record());

		const result = await stopService({
			root,
			identity: async () => ({ kind: 'dead' as const }),
			signal: () => assert.fail('não deveria sinalizar um processo morto'),
		});

		assert.equal(result.kind, 'not-running');
	});

	test('não encerra quem não provou ser o serviço', async () => {
		const root = await makeRoot();
		await writeServiceRecord(root, record());

		const result = await stopService({
			root,
			identity: alive,
			fetchHealth: async () => health({ pid: 9999 }) as never,
			signal: () => assert.fail('não deveria sinalizar um impostor'),
		});

		assert.equal(result.kind, 'refused');
	});

	test('não encerra um serviço de protocolo incompatível', async () => {
		const root = await makeRoot();
		await writeServiceRecord(root, record({ protocol: 99 }));

		const result = await stopService({
			root,
			identity: alive,
			signal: () => assert.fail('não deveria sinalizar outro protocolo'),
		});

		assert.equal(result.kind, 'refused');
	});

	test('encerra só depois de confirmar que é o serviço', async () => {
		const root = await makeRoot();
		await writeServiceRecord(root, record());
		const signalled: number[] = [];

		const result = await stopService({
			root,
			identity: alive,
			fetchHealth: async () => health() as never,
			signal: (pid) => signalled.push(pid),
		});

		assert.equal(result.kind, 'stopped');
		assert.deepEqual(signalled, [4242]);
	});

	test('as mensagens não carregam a credencial nem o caminho', async () => {
		const root = await makeRoot();
		await writeServiceRecord(root, record());
		const probe = await probeService({
			root,
			identity: alive,
			fetchHealth: async () => health() as never,
		});
		const line = describeProbe(probe);

		assert.equal(line.includes(record().token), false);
		assert.equal(line.includes(root), false);
		assert.match(line, /serviço ativo/);
	});
});
