/**
 * R4B: o Electron conectado ao serviço independente.
 *
 * ## O que só este teste prova
 *
 * Que o app **continua aberto** com o serviço ativo, sem montar um segundo
 * Core, e que o modo local segue funcionando sem serviço. Tudo isso com
 * `electron.exe` e o serviço de verdade, em raízes temporárias.
 *
 * ## Como a asserção é feita
 *
 * Em vez de olhar pixels, o teste observa:
 *
 * - o log do processo: `connected to the local service` (conectado) versus
 *   `desktop starting` (montou Core) — são mutuamente exclusivos;
 * - o lock da raiz: continua com o pid do **serviço** no modo conectado, e
 *   com o pid do **Electron** no modo local;
 * - o tempo de vida: conectado e local **não** saem sozinhos; a recusa por
 *   outro app sai com código 1.
 */
import * as assert from 'assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { probeService } from '../app/discoverService';
import {
	missingReadyHint,
	parseReady,
	READY_ENV,
	type ReadySignal,
} from '../desktop/testReadiness';
import { readServiceRecord } from './helpers/serviceFiles';
import { ApiKeyStore, API_KEYS_FILE } from '../core/security/apiKeys';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const SERVICE_ENTRY = join(process.cwd(), 'dist', 'web', 'main.js');
const ELECTRON = join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe');
const DESKTOP_MAIN = join(process.cwd(), 'dist', 'desktop', 'main.js');

const children: ChildProcess[] = [];
const roots: string[] = [];

interface ElectronRun {
	readonly exitCode: number | null;
	readonly timedOut: boolean;
	readonly stdout: string;
	readonly stderr: string;
	/** O sinal de prontidão emitido pelo app (R4L), quando veio. */
	readonly ready: ReadySignal | undefined;
	/** Quanto tempo o app ficou vivo **depois** do sinal de prontidão. */
	readonly aliveAfterReadyMs: number | undefined;
}

/** Quanto tempo o app precisa continuar aberto depois de sinalizar. */
const SURVIVAL_MS = 3_000;

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'evelyn-r4b-'));
	roots.push(root);
	return root;
}

async function startService(root: string): Promise<ChildProcess> {
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

async function stopService(root: string): Promise<void> {
	const child = spawn(process.execPath, [SERVICE_ENTRY, '--root', root, '--stop'], {
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	children.push(child);
	await new Promise((resolve) => child.on('exit', resolve));
}

/** Abre o Electron contra a raiz; espera sair ou o timeout encerrar. */
/**
 * Abre o Electron contra a raiz e espera.
 *
 * ## O que conta no prazo (R4L)
 *
 * O app emite um **sinal de prontidão** (ver `testReadiness.ts`) quando o
 * modo de arranque está decidido e concluído — logo depois de conectar, ou
 * depois de montar e semear o Core local. O teste espera esse sinal e, a
 * partir dele, mede quanto tempo o app **continua aberto**.
 *
 * Antes, o prazo era uma espera fixa de 12 s que começava em "qualquer
 * sinal de arranque": dois desses em sequência passavam de 24 s e estouravam
 * o limite da suíte. O sinal não substitui a prova de sobrevivência — ele a
 * **ancora** no instante certo. Um app que saísse logo depois do sinal
 * continua falhando, e um que nunca sinalizasse falha com diagnóstico.
 *
 * O sinal só existe com `SESHYINA_TEST_READY=1`, que este harness passa. O
 * app sem a variável não escreve nada — é o modo de produção.
 */
async function runElectron(
	root: string,
	options: { readonly survivalMs?: number; readonly readyTimeoutMs?: number } = {},
): Promise<ElectronRun> {
	const survivalMs = options.survivalMs ?? SURVIVAL_MS;
	// O prazo para o sinal tem de sobrar para o `timeout` do mocha: 12 s de
	// cadeia de inicialização é o dobro do que o arranque levou no pior caso
	// observado (~1 s), e falha com uma mensagem clara quando estoura.
	const readyTimeoutMs = options.readyTimeoutMs ?? 12_000;
	const child = spawn(ELECTRON, [DESKTOP_MAIN, '--root', root], {
		stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', [READY_ENV]: '1' },
	});
	children.push(child);
	let stdout = '';
	let stderr = '';
	child.stdout?.setEncoding('utf8');
	child.stderr?.setEncoding('utf8');
	child.stdout?.on('data', (chunk: string) => {
		stdout += chunk;
	});
	child.stderr?.on('data', (chunk: string) => {
		stderr += chunk;
	});

	return await new Promise<ElectronRun>((resolve) => {
		let timedOut = false;
		let ready: ReadySignal | undefined;
		let readyAt: number | undefined;
		let survivalTimer: ReturnType<typeof setTimeout> | undefined;
		const signalMissed = (): Error =>
			new Error(missingReadyHint('connected', `${stdout}\n${stderr}`));
		/**
		 * O sinal apareceu: começa a janela de sobrevivência.
		 *
		 * A leitura acontece sobre a saída acumulada, não sobre o pedaço
		 * atual: um pedaço pode partir a linha ao meio.
		 */
		const onOutput = (): void => {
			if (ready !== undefined) {
				return;
			}
			const found = parseReady(`${stdout}\n${stderr}`);
			if (found === undefined) {
				return;
			}
			ready = found;
			readyAt = Date.now();
			survivalTimer = setTimeout(() => {
				timedOut = true;
				child.kill('SIGKILL');
			}, survivalMs);
		};
		child.stdout?.on('data', onOutput);
		child.stderr?.on('data', onOutput);
		// A falta do sinal falha **aqui**, com diagnóstico: um app que não
		// diz nada não pode segurar o teste, e um teste que espere e passe
		// sem prova estaria lendo nada.
		const readyTimer = setTimeout(() => {
			if (ready === undefined) {
				child.kill('SIGKILL');
			}
		}, readyTimeoutMs);
		child.on('exit', (code) => {
			clearTimeout(readyTimer);
			if (survivalTimer !== undefined) {
				clearTimeout(survivalTimer);
			}
			// Sem sinal, o teste não sabe o que aconteceu: o erro vai junto do
			// resultado, e as asserções falham em vez de serem puladas.
			if (ready === undefined) {
				const missed = signalMissed();
				stderr += `\n[mocha] ${missed.message}`;
			}
			resolve({
				exitCode: code,
				timedOut,
				stdout,
				stderr,
				ready,
				aliveAfterReadyMs: readyAt === undefined ? undefined : Date.now() - readyAt,
			});
		});
	});
}

/**
 * Abre o Electron **sem** a variável de teste e o mata depois de `afterMs`.
 *
 * Prova o modo de produção: nenhuma instrumentação, e o app que não sinaliza
 * nada precisa morrer pelo prazo do teste e não pelo seu próprio. É a única
 * forma de verificar a ausência do sinal sem esperar o prazo de sobrevivência.
 */
async function runElectronWithoutSignal(root: string, afterMs: number): Promise<ElectronRun> {
	const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' };
	delete env[READY_ENV];
	const child = spawn(ELECTRON, [DESKTOP_MAIN, '--root', root], {
		stdio: ['ignore', 'pipe', 'pipe'],
		env,
	});
	children.push(child);
	let stdout = '';
	let stderr = '';
	child.stdout?.setEncoding('utf8');
	child.stderr?.setEncoding('utf8');
	child.stdout?.on('data', (chunk: string) => {
		stdout += chunk;
	});
	child.stderr?.on('data', (chunk: string) => {
		stderr += chunk;
	});
	return await new Promise<ElectronRun>((resolve) => {
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill('SIGKILL');
		}, afterMs);
		child.on('exit', (code) => {
			clearTimeout(timer);
			resolve({
				exitCode: code,
				timedOut,
				stdout,
				stderr,
				ready: parseReady(`${stdout}\n${stderr}`),
				aliveAfterReadyMs: undefined,
			});
		});
	});
}

async function lockOwner(root: string): Promise<{ readonly pid: number; readonly host: string } | undefined> {	try {
		const raw = await readFile(join(root, 'storage.lock'), 'utf8');
		const parsed = JSON.parse(raw) as { readonly pid?: unknown; readonly host?: unknown };
		if (typeof parsed.pid !== 'number' || typeof parsed.host !== 'string') {
			return undefined;
		}
		return { pid: parsed.pid, host: parsed.host };
	} catch {
		return undefined;
	}
}

/**
 * Exige um run que sinalizou prontidão e continuou vivo depois.
 *
 * Falha com a saída do processo quando o sinal não veio ou o prazo foi
 * curto: o teste nunca passa por um run sem prova de conexão.
 */
function expectReady(run: ElectronRun, mode: ReadySignal['mode']): ReadySignal {
	assert.ok(
		run.ready !== undefined,
		missingReadyHint(mode, `${run.stdout}\n${run.stderr}`),
	);
	assert.equal(run.ready?.mode, mode, `${mode} esperado, veio ${String(run.ready?.mode)}`);
	return run.ready as ReadySignal;
}

function requireBuild(this: Mocha.Context): boolean {
	if (!existsSync(ELECTRON) || !existsSync(DESKTOP_MAIN) || !existsSync(SERVICE_ENTRY)) {
		this.pending('faltou build (desktop:build / web:build) ou o binário do Electron');
		return false;
	}
	return true;
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

suite('R4B: Electron conectado ao serviço', () => {
	test('com serviço ativo: continua aberto, sem montar Core e sem tomar o lock', async function () {
		if (!requireBuild.call(this)) {
			return;
		}
		const root = await makeRoot();
		const service = await startService(root);
		try {
			// O sinal de prontidão diz que o app conectou **e** o pid do
			// serviço com quem conectou; a janela de sobrevivência diz que ele
			// não saiu logo depois. As duas coisas juntas são a prova de que
			// estava aberto — sem espera fixa de 12 s.
			const run = await runElectron(root);

			const ready = expectReady(run, 'connected');
			assert.equal(ready.service, service.pid, 'conectou ao serviço desta raiz');
			assert.equal(run.timedOut, true, 'o app permanece aberto no modo conectado');
			assert.match(run.stderr, /connected to the local service/);
			// A prova de que não montou Core: o arranque do modo local não
			// aparece, e o lock continua com o serviço.
			assert.equal(run.stdout.includes('desktop starting'), false);
			assert.equal(run.stdout.includes('Seeding default provider'), false);

			const owner = await lockOwner(root);
			assert.ok(owner !== undefined);
			assert.equal(owner?.pid, service.pid, 'o lock continua do serviço');
			assert.equal(owner?.host, 'web');
			// E o serviço está intacto.
			assert.equal((await probeService({ root })).kind, 'active');
		} finally {
			await stopService(root);
		}
	});

	test('sem serviço: o modo local monta o Core e fica aberto', async function () {
		if (!requireBuild.call(this)) {
			return;
		}
		const root = await makeRoot();

		const run = await runElectron(root);

		expectReady(run, 'local');
		assert.equal(run.timedOut, true, 'sem serviço, o app abre normalmente');
		assert.match(run.stdout, /desktop starting/);
		// R4S: nada é semeado — uma instalação nova não ganha provedor.
		assert.equal(run.stdout.includes('Seeding default provider'), false);
		assert.equal(run.stderr.includes('connected to the local service'), false);

		// O lock é do Electron, e não de um serviço.
		const owner = await lockOwner(root);
		assert.ok(owner !== undefined);
		assert.equal(owner?.host, 'desktop');
		assert.equal((await probeService({ root })).kind, 'absent');
	});

	test('serviço reiniciado entre uma abertura e outra: o app continua conectando', async function () {
		if (!requireBuild.call(this)) {
			return;
		}
		const root = await makeRoot();
		const first = await startService(root);
		const firstPid = first.pid;
		const connected = await runElectron(root);
		expectReady(connected, 'connected');
		await stopService(root);

		// O serviço sobe de novo: pid e token novos, mesma raiz.
		const second = await startService(root);
		assert.notEqual(second.pid, firstPid, 'é outro processo');
		// A nova abertura conecta ao **segundo** serviço: é o `service=` do
		// sinal, e não o texto do log, que prova qual dos dois respondeu.
		const again = await runElectron(root);
		const againReady = expectReady(again, 'connected');

		assert.equal(again.timedOut, true);
		assert.equal(againReady.service, second.pid, 'conectou ao serviço novo');
		assert.notEqual(againReady.service, firstPid, 'não ficou no serviço antigo');
		assert.match(again.stderr, /connected to the local service/);
		assert.equal(again.stdout.includes('desktop starting'), false);
		// O registro foi atualizado para o novo processo.
		const record = await readServiceRecord(root);
		assert.equal(record.kind, 'ok');
		if (record.kind === 'ok') {
			assert.equal(record.record['pid'], second.pid);
		}
		await stopService(root);
	});

	test('registro de um serviço morto: o app não fica conectado a fantasma', async function () {
		if (!requireBuild.call(this)) {
			return;
		}
		const root = await makeRoot();
		const service = await startService(root);
		// Mata sem limpar: `service.json` e `storage.lock` ficam apontando
		// para um processo que não existe.
		service.kill('SIGKILL');
		await new Promise((resolve) => setTimeout(resolve, 800));

		const probe = await probeService({ root });
		assert.ok(probe.kind === 'stale' || probe.kind === 'absent');

		const run = await runElectron(root);

		// O serviço não é validado — então o app não diz "conectado", e o
		// sinal o confirma: o modo é o local, não o conectado.
		assert.equal(run.stderr.includes('connected to the local service'), false);
		const ready = expectReady(run, 'local');
		assert.equal(ready.service, undefined, 'não aponta serviço nenhum');
		// E recupera o lock órfão, abrindo em modo local.
		assert.equal(run.timedOut, true);
		assert.match(run.stdout, /desktop starting/);
	});

	test('o registro do serviço nunca entrega o token do painel ao app', async function () {
		if (!requireBuild.call(this)) {
			return;
		}
		const root = await makeRoot();
		const keys = new ApiKeyStore({ filePath: join(root, API_KEYS_FILE) });
		await keys.create({ name: 'r4b' });
		await startService(root);
		try {
			const record = await readServiceRecord(root);
			assert.equal(record.kind, 'ok');
			if (record.kind !== 'ok') {
				return;
			}
			const panelToken = record.record['token'];
			assert.equal(typeof panelToken, 'string');

			const run = await runElectron(root);

			// A conexão também foi validada aqui: o app abriu conectado.
			expectReady(run, 'connected');
			// Nem na saída do processo, nem em mensagem de erro.
			assert.equal(run.stdout.includes(panelToken as string), false, 'token do painel no stdout');
			assert.equal(run.stderr.includes(panelToken as string), false, 'token do painel no stderr');

			// O app usa o leitor; o health aceita o leitor e não o promove.
			const reader = record.record['readerToken'] as string;
			const health = await fetch(`http://127.0.0.1:${record.record['port']}/api/health`, {
				headers: { 'x-seshyina-reader': reader },
			});
			await health.text();
			assert.equal(health.status, 200);
		} finally {
			await stopService(root);
			await rm(join(root, API_KEYS_FILE), { force: true }).catch(() => undefined);
		}
	});

	/**
	 * R4L: o sinal de prontidão não é ativado fora do ambiente de teste.
	 *
	 * Mesma raiz, mesmo serviço, mesmo binário — só o ambiente muda. Sem a
	 * variável, a linha não aparece e o app se comporta exatamente como em
	 * produção. A sobrevivência é curta porque o que se prova aqui é a
	 * **ausência** do sinal.
	 */
	test('sem SESHYINA_TEST_READY o app não sinaliza nada', async function () {
		if (!requireBuild.call(this)) {
			return;
		}
		const root = await makeRoot();
		await startService(root);
		try {
			const run = await runElectronWithoutSignal(root, SURVIVAL_MS);

			assert.equal(run.ready, undefined, 'nenhum sinal sem a variável de teste');
			assert.equal(
				`${run.stdout}\n${run.stderr}`.includes('[evelyn-test]'),
				false,
				'nada de teste vaza para a saída normal',
			);
			// E o app continua conectando normalmente — só não avisa.
			assert.match(run.stderr, /connected to the local service/);
			assert.equal(run.timedOut, true);
		} finally {
			await stopService(root);
		}
	});

	/**
	 * R4L: a falta do sinal é falha explícita, não silêncio.
	 *
	 * Um `expectReady` sobre um run sem sinal precisa falhar com a
	 * orientação e a saída observada — é o que impede o teste de passar
	 * lendo nada.
	 */
	test('a falta do sinal produz uma falha diagnóstica', async function () {
		if (!requireBuild.call(this)) {
			return;
		}
		const fakeRun: ElectronRun = {
			exitCode: 0,
			timedOut: false,
			stdout: '',
			stderr: '[evelyn] Evelyn desktop connected to the local service',
			ready: undefined,
			aliveAfterReadyMs: undefined,
		};
		assert.throws(
			() => expectReady(fakeRun, 'connected'),
			(error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				assert.match(message, /não emitiu o sinal de prontidão/);
				assert.match(message, /SESHYINA_TEST_READY=1/);
				assert.equal(message.includes('connected to the local service'), true, 'mostra a saída');
				return true;
			},
		);
	});
});
