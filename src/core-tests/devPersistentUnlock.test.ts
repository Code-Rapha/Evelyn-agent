/**
 * O desbloqueio persistente do DEV.
 *
 * O risco desta funcionalidade não é ela não funcionar — é ela funcionar
 * **demais**: aceitar um recibo de outra senha, sobreviver a uma revogação, ou
 * transformar um arquivo adulterado em autorização. Cada teste abaixo ataca um
 * desses casos.
 *
 * O DPAPI é substituído por uma cifra trivial injetada: o que se testa aqui é
 * a **política** (o que vale, o que não vale), não a criptografia do Windows —
 * essa é coberta por `windowsDpapi` e pela prova no executável.
 */
import * as assert from 'assert';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'mocha';
import {
	PERSISTENT_FILE,
	REVOCATION_FILE,
	createPersistentUnlockStore,
} from '../desktop/devPersistentUnlock';
import type { PowerShellRunner } from '../desktop/windowsDpapi';

/**
 * Um "DPAPI" de teste: prefixo/sufixo fixos e base64 no meio.
 *
 * Recusa o que não tiver a marca, como o DPAPI recusa um blob truncado — é o
 * comportamento que o teste de adulteração precisa.
 */
const FAKE_SEAL = 'SEALED:';
const runner = (corrupt = false): PowerShellRunner => async (script) => {
	if (script.includes('Protect(')) {
		const match = /FromBase64String\('([^']+)'\)/.exec(script);
		const plain = Buffer.from(match?.[1] ?? '', 'base64').toString('base64');
		return { ok: true, stdout: Buffer.from(`${FAKE_SEAL}${plain}`).toString('base64'), stderr: '' };
	}
	if (corrupt) {
		return { ok: false, stdout: '', stderr: 'CryptographicException' };
	}
	const match = /FromBase64String\('([^']+)'\)/.exec(script);
	const inner = Buffer.from(match?.[1] ?? '', 'base64').toString('utf8');
	if (!inner.startsWith(FAKE_SEAL)) {
		return { ok: false, stdout: '', stderr: 'CryptographicException' };
	}
	return {
		ok: true,
		stdout: Buffer.from(inner.slice(FAKE_SEAL.length), 'base64').toString('base64'),
		stderr: '',
	};
};

async function store(options: { readonly corrupt?: boolean } = {}) {
	const dir = await mkdtemp(join(tmpdir(), 'unlock-'));
	const created = createPersistentUnlockStore({
		devDir: dir,
		platform: 'win32',
		run: runner(options.corrupt),
	});
	return { dir, store: created };
}

describe('devPersistentUnlock', () => {
	it('sem arquivo, o estado é "none" — não "inválido"', async () => {
		const { dir, store: s } = await store();
		try {
			assert.deepStrictEqual(await s.state(), { kind: 'none' });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('lembra e devolve o mesmo verifier, sem guardar senha', async () => {
		const { dir, store: s } = await store();
		try {
			const saved = await s.remember({
				verifier: 'verifier-abc',
				sessionId: 'sessao-1',
				grantedAt: '2026-11-04T12:00:00.000Z',
			});
			assert.strictEqual(saved.ok, true);
			const state = await s.state();
			assert.strictEqual(state.kind, 'valid');
			if (state.kind === 'valid') {
				assert.strictEqual(state.receipt.verifier, 'verifier-abc');
				assert.strictEqual(state.receipt.sessionId, 'sessao-1');
			}
			// O arquivo em disco é o blob selado, nunca o recibo em claro.
			const raw = await readFile(join(dir, PERSISTENT_FILE), 'utf8');
			assert.ok(!raw.includes('verifier-abc'), 'o verifier não pode aparecer em claro');
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('bloqueio manual (forget) apaga o recibo: a próxima vez pede senha', async () => {
		const { dir, store: s } = await store();
		try {
			await s.remember({ verifier: 'v', grantedAt: '2026-11-04T12:00:00.000Z' });
			await s.forget();
			assert.deepStrictEqual(await s.state(), { kind: 'none' });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('revogar apaga o recibo E invalida uma cópia restaurada', async () => {
		const { dir, store: s } = await store();
		try {
			await s.remember({ verifier: 'v', grantedAt: '2026-11-04T12:00:00.000Z' });
			const copy = await readFile(join(dir, PERSISTENT_FILE), 'utf8');
			await s.revoke();

			// Cenário real: alguém restaura o arquivo de um backup. A cópia é
			// cifrada, o DPAPI a abre — e ela continua **inválida**.
			await writeFile(join(dir, PERSISTENT_FILE), copy, 'utf8');
			const state = await s.state();
			assert.strictEqual(state.kind, 'invalid');
			if (state.kind === 'invalid') {
				assert.match(state.reason, /revogado/);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('um arquivo que o DPAPI recusa é "invalid", nunca "valid"', async () => {
		const { dir, store: s } = await store();
		try {
			await s.remember({ verifier: 'v', grantedAt: '2026-11-04T12:00:00.000Z' });
			// Truncar o blob no meio é o dano mais comum (cópia interrompida).
			const raw = await readFile(join(dir, PERSISTENT_FILE), 'utf8');
			await writeFile(join(dir, PERSISTENT_FILE), raw.slice(0, Math.max(1, raw.length / 2)), 'utf8');
			const state = await s.state();
			assert.notStrictEqual(state.kind, 'valid');
			assert.strictEqual(state.kind, 'invalid');
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('um blob legível com formato errado também é "invalid"', async () => {
		const { dir } = await store();
		try {
			// "Cifrado" por um DPAPI que não recusa, mas o conteúdo não é um recibo.
			const bogus = Buffer.from(`${FAKE_SEAL}${Buffer.from('{"nada":"aqui"}').toString('base64')}`).toString('base64');
			await writeFile(join(dir, PERSISTENT_FILE), bogus, 'utf8');
			const state = await createPersistentUnlockStore({
				devDir: dir,
				platform: 'win32',
				run: runner(),
			}).state();
			assert.strictEqual(state.kind, 'invalid');
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('fora do Windows, o recurso é "unavailable" e nada é gravado', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'unlock-'));
		try {
			const s = createPersistentUnlockStore({ devDir: dir, platform: 'linux' });
			assert.strictEqual((await s.state()).kind, 'unavailable');
			const saved = await s.remember({ verifier: 'v', grantedAt: '2026-11-04T12:00:00.000Z' });
			assert.strictEqual(saved.ok, false);
			await assert.rejects(() => readFile(join(dir, PERSISTENT_FILE), 'utf8'));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('o contador de revogação começa em zero e sobe a cada revogação', async () => {
		const { dir, store: s } = await store();
		try {
			assert.strictEqual(await s.epoch(), 0);
			await s.revoke();
			assert.strictEqual(await s.epoch(), 1);
			await s.revoke();
			assert.strictEqual(await s.epoch(), 2);
			const raw = JSON.parse(await readFile(join(dir, REVOCATION_FILE), 'utf8'));
			assert.strictEqual(raw.epoch, 2);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('um contador ilegível não ressuscita recibos antigos', async () => {
		const { dir, store: s } = await store();
		try {
			await s.remember({ verifier: 'v', grantedAt: '2026-11-04T12:00:00.000Z' });
			// Contador corrompido: ler como zero faria o recibo (epoch 0) voltar
			// a valer — e apagar/corromper o arquivo é o ataque mais barato.
			await writeFile(join(dir, REVOCATION_FILE), 'nao-e-json', 'utf8');
			const state = await s.state();
			assert.strictEqual(state.kind, 'invalid');
			if (state.kind === 'invalid') {
				assert.match(state.reason, /ilegível/);
				assert.match(state.reason, /autentique de novo/);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('um contador com o formato errado também invalida', async () => {
		const { dir, store: s } = await store();
		try {
			await s.remember({ verifier: 'v', grantedAt: '2026-11-04T12:00:00.000Z' });
			await writeFile(join(dir, REVOCATION_FILE), '{"epoch":"zero"}', 'utf8');
			assert.strictEqual((await s.state()).kind, 'invalid');
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
