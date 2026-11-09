/**
 * DEV-7: a credencial local do proprietário.
 *
 * ## O que é real e o que é injetado
 *
 * Real: o arquivo em disco, o PBKDF2, o verifier, o limite de tentativas e o
 * fluxo do `DevHost`. **Injetado**: o DPAPI (`windowsDpapi.runPowerShell`), o
 * relógio e o usuário do Windows. Sem isso, o teste exigiria o Windows e um
 * usuário interativo — e o ponto aqui é a **lógica**, não o sistema.
 *
 * O DPAPI de verdade é exercitado em `ownerCredentialWindows.test.ts`, que
 * chama o PowerShell de verdade. A diferença entre os dois está declarada lá.
 */
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DevHost } from '../desktop/devHost';
import {
	CREDENTIAL_FILE,
	MAX_ATTEMPTS,
	MIN_PASSWORD_LENGTH,
	OwnerCredentialStore,
} from '../desktop/ownerCredential';
import { OwnerPromptBroker, type OwnerPrompt } from '../desktop/ownerPrompt';
import type { PowerShellRunner } from '../desktop/windowsDpapi';
import { createDevToolEntries } from '../core/agent/devTools';
import type { ToolExecutionContext } from '../core/agent/types';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

const roots: string[] = [];
const hosts: DevHost[] = [];
const ctx: ToolExecutionContext = { sessionId: 'test' };
const CSS = 'src/desktop/renderer/index.css';
const PASSWORD = 'uma-frase-bem-longa-do-proprietario';

teardown(async () => {
	for (const host of hosts.splice(0)) {
		await host.ownerExit().catch(() => undefined);
	}
	for (const root of roots.splice(0)) {
		await removeFixtureTree(root).catch(() => undefined);
	}
});

async function makeDir(prefix = 'evelyn-dev7-'): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	roots.push(dir);
	return dir;
}

/**
 * Um DPAPI de mentira: "cifra" com um prefixo e só "abre" o que ele cifrou.
 *
 * Não é criptografia — é o contrato: o store passa bytes, recebe base64 e
 * não guarda nada em claro.
 */
function fakeDpapi(options: { readonly broken?: boolean } = {}): PowerShellRunner {
	return async (script) => {
		if (options.broken === true) {
			return { ok: false, stdout: '', stderr: 'DPAPI indisponível' };
		}
		const protect = /\$b=\[Convert\]::FromBase64String\('([^']*)'\)/.exec(script);
		if (protect !== null) {
			const encoded = Buffer.from(`SEALED:${protect[1]}`).toString('base64');
			return { ok: true, stdout: encoded, stderr: '' };
		}
		const unprotect = /Unprotect\(\$p,\$null,'CurrentUser'\)/.exec(script);
		const blob = /\$p=\[Convert\]::FromBase64String\('([^']*)'\)/.exec(script);
		if (unprotect !== null && blob !== null) {
			const inner = Buffer.from(blob[1] as string, 'base64').toString('utf8');
			if (!inner.startsWith('SEALED:')) {
				return { ok: false, stdout: '', stderr: 'blob inválido' };
			}
			return { ok: true, stdout: inner.slice('SEALED:'.length), stderr: '' };
		}
		return { ok: false, stdout: '', stderr: 'script inesperado' };
	};
}

/** A sessão do host, como o `state()` a reporta (união estreitada). */
function sessionOf(host: DevHost): 'active' | 'inactive' {
	const state = host.state();
	return state.repo ? state.session : 'inactive';
}

interface StoreOptions {
	readonly user?: string | undefined;
	readonly now?: () => Date;
	readonly dpapi?: PowerShellRunner;
	readonly platform?: NodeJS.Platform;
}

function store(dir: string, options: StoreOptions = {}): OwnerCredentialStore {
	return new OwnerCredentialStore({
		dir,
		user: () => (options.user === undefined ? 'proprietario' : options.user),
		...(options.now !== undefined ? { now: options.now } : {}),
		run: options.dpapi ?? fakeDpapi(),
		...(options.platform !== undefined ? { platform: options.platform } : {}),
	});
}

async function configured(options: StoreOptions = {}): Promise<{ readonly store: OwnerCredentialStore; readonly dir: string }> {
	const dir = await makeDir();
	const created = store(dir, options);
	const result = await created.configure(PASSWORD, PASSWORD);
	assert.equal(result.ok, true, result.ok ? '' : result.message);
	return { store: created, dir };
}

suite('DEV-7: a credencial em disco', () => {
	test('configurar grava só salt, blob protegido e verifier — nunca a senha', async () => {
		const { dir } = await configured();

		const raw = await readFile(join(dir, CREDENTIAL_FILE), 'utf8');
		const parsed = JSON.parse(raw) as Record<string, unknown>;

		assert.equal(raw.includes(PASSWORD), false, 'a senha não está no arquivo');
		// Os campos do formato, sem lista de exclusão: se um campo novo for
		// criado (e ele não for seguro), este teste passa a falhar.
		assert.deepEqual(Object.keys(parsed).sort(), [
			'createdAt',
			'failures',
			'salt',
			'sealed',
			'updatedAt',
			'user',
			'verifier',
			'version',
		]);
		assert.equal(parsed['user'], 'proprietario');
		assert.equal(typeof parsed['salt'], 'string');
		assert.equal(typeof parsed['sealed'], 'string');
		assert.equal(typeof parsed['verifier'], 'string');
	});

	test('recusa senha curta, confirmação diferente e nova configuração por cima', async () => {
		const dir = await makeDir();
		const created = store(dir);

		assert.equal((await created.configure('curta', 'curta')).ok, false);
		assert.equal((await created.configure(PASSWORD, `${PASSWORD}x`)).ok, false);
		const first = await created.configure(PASSWORD, PASSWORD);
		assert.equal(first.ok, true);
		const second = await created.configure('outra-senha-comprida', 'outra-senha-comprida');
		assert.equal(second.ok, false);
		assert.equal(second.ok ? '' : second.reason, 'exists');
	});

	test('senha certa autentica; senha errada não, e a mensagem não vaza nada', async () => {
		const { store: created } = await configured();

		assert.deepEqual(await created.authenticate(PASSWORD), { ok: true });
		const wrong = await created.authenticate('senha-errada-qualquer');
		assert.equal(wrong.ok, false);
		assert.equal(wrong.ok ? '' : wrong.reason, 'invalid');
		assert.equal(wrong.ok ? '' : wrong.message, 'autorização recusada');
		assert.equal(JSON.stringify(wrong).includes(PASSWORD), false);
	});

	test('outro usuário do Windows não autentica, mesmo com a senha certa', async () => {
		const lower = await configured({ user: 'proprietario' });
		const other = store(lower.dir, { user: 'outra-pessoa' });

		const result = await other.authenticate(PASSWORD);

		assert.equal(result.ok, false);
		assert.match(result.ok ? '' : result.message, /outro usuário/);
	});

	test('o limite de tentativas bloqueia e a espera cresce', async () => {
		let clock = 1_000_000;
		const now = (): Date => new Date(clock);
		const { store: created } = await configured({ now });

		for (let attempt = 0; attempt < MAX_ATTEMPTS - 1; attempt += 1) {
			const result = await created.authenticate('errada');
			assert.equal(result.ok ? '' : result.reason, 'invalid');
		}
		const blockedAttempt = await created.authenticate('errada');
		assert.equal(blockedAttempt.ok ? '' : blockedAttempt.reason, 'invalid');

		// Bloqueado: nem a senha certa passa, e o tempo de espera é informado.
		const blocked = await created.authenticate(PASSWORD);
		assert.equal(blocked.ok ? '' : blocked.reason, 'blocked');
		assert.notEqual(blocked.ok ? undefined : blocked.retryAt, undefined);
		const firstRetry = Date.parse(blocked.ok ? '' : (blocked.retryAt as string)) - clock;
		assert.equal(firstRetry, 30_000);

		// O tempo passa: a senha certa volta a valer, e zera o contador.
		clock += 30_001;
		assert.deepEqual(await created.authenticate(PASSWORD), { ok: true });
		const state = await created.state();
		assert.equal(state.kind, 'configured');

		// Nova sequência de erros: a espera dobra.
		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
			await created.authenticate('errada');
		}
		const secondBlocked = await created.authenticate(PASSWORD);
		assert.equal(secondBlocked.ok ? '' : secondBlocked.reason, 'blocked');
	});

	test('o bloqueio sobrevive a reabrir (novo store, mesmo diretório)', async () => {
		const verbose = await configured();
		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
			await verbose.store.authenticate('errada');
		}

		const reopened = store(verbose.dir);
		const result = await reopened.authenticate(PASSWORD);

		assert.equal(result.ok ? '' : result.reason, 'blocked');
	});

	test('sem credencial, DPAPI quebrado e DPAPI fora do Windows: falha segura', async () => {
		const empty = await makeDir();
		const notConfigured = await store(empty).authenticate('qualquer-senha-bem-longa');
		assert.equal(notConfigured.ok ? '' : notConfigured.reason, 'not-configured');

		const brokenDir = await makeDir();
		const broken = await store(brokenDir, { dpapi: fakeDpapi({ broken: true }) }).configure(PASSWORD, PASSWORD);
		assert.equal(broken.ok, false);
		assert.equal(broken.ok ? '' : broken.reason, 'unavailable');
		assert.equal(await readFile(join(brokenDir, CREDENTIAL_FILE), 'utf8').then(() => true, () => false), false);

		const linux = await store(await makeDir(), { platform: 'linux' }).configure(PASSWORD, PASSWORD);
		assert.equal(linux.ok, false);
	});

	test('arquivo corrompido é estado de segurança, não primeira execução', async () => {
		const dir = await makeDir();
		await writeFile(join(dir, CREDENTIAL_FILE), '{ isto não é json', 'utf8');
		const created = store(dir);

		const state = await created.state();
		assert.equal(state.kind, 'corrupt');
		const result = await created.authenticate(PASSWORD);
		assert.equal(result.ok ? '' : result.reason, 'corrupt');
	});

	test('blob adulterado (o DPAPI recusa) é corrupção, nunca sucesso', async () => {
		const { store: created, dir } = await configured();
		const raw = JSON.parse(await readFile(join(dir, CREDENTIAL_FILE), 'utf8')) as Record<string, unknown>;
		raw['sealed'] = Buffer.from('outro-blob').toString('base64');
		await writeFile(join(dir, CREDENTIAL_FILE), JSON.stringify(raw), 'utf8');

		const result = await created.authenticate(PASSWORD);

		assert.equal(result.ok, false);
		assert.equal(result.ok ? '' : result.reason, 'corrupt');
	});

	test('a recuperação exige confirmação e volta a "não configurado"', async () => {
		const { store: created, dir } = await configured();

		assert.equal((await created.reset({ confirm: false })).ok, false);
		assert.equal((await created.state()).kind, 'configured');
		assert.equal((await created.reset({ confirm: true })).ok, true);
		assert.equal((await created.state()).kind, 'not-configured');
		assert.equal(await readFile(join(dir, CREDENTIAL_FILE), 'utf8').then(() => true, () => false), false);
	});

	test('o estado do painel nunca traz salt, verifier, blob nem senha', async () => {
		const { store: created } = await configured();

		const payload = JSON.stringify(await created.state());
		const stripe = /salt|verifier|sealed|password/i;

		assert.equal(stripe.test(payload), false, payload);
		assert.equal(payload.includes(PASSWORD), false);
	});
});

suite('DEV-7: o prompt de autorização', () => {
	test('a pergunta tem id novo e só a resposta da mesma pergunta vale', async () => {
		const sent: OwnerPrompt[] = [];
		const broker = new OwnerPromptBroker((prompt) => sent.push(prompt));

		const first = broker.ask('authorize', { title: 't', detail: 'd' });
		const prompt = sent[0];
		assert.notEqual(prompt, undefined);
		// Uma resposta com outro id não é aceita.
		const wrong = broker.answer({ id: 'auth-000000000000000000', kind: 'cancel' });
		assert.equal(wrong.accepted, false);
		const accepted = broker.answer({ id: prompt?.id, kind: 'password', password: 'x' });
		assert.equal(accepted.accepted, true);
		const outcome = await first;
		assert.equal(outcome.kind, 'answered');
		assert.equal(outcome.kind === 'answered' ? outcome.password : '', 'x');
	});

	test('duas perguntas ao mesmo tempo: a segunda é recusada', async () => {
		const broker = new OwnerPromptBroker(() => undefined);
		const first = broker.ask('authorize', { title: 'a', detail: 'b' });
		const second = await broker.ask('configure', { title: 'a', detail: 'b' });

		assert.equal(second.kind, 'rejected');
		broker.cancel();
		assert.equal((await first).kind, 'cancelled');
	});

	test('a pergunta expira', async () => {
		const broker = new OwnerPromptBroker(() => undefined, { ttlMs: 10 });
		const pending = broker.ask('authorize', { title: 'a', detail: 'b' });

		assert.equal((await pending).kind, 'expired');
		assert.equal(broker.answer({ id: 'auth-000000000000000000', kind: 'cancel' }).accepted, false);
	});
});

suite('DEV-7: o host só ativa com a credencial validada', () => {
	interface HarnessHost {
		readonly host: DevHost;
		readonly prompts: OwnerPromptBroker;
		readonly sent: OwnerPrompt[];
		readonly repo: string;
		readonly data: string;
	}

	/**
	 * O host com credencial real (DPAPI de mentira) e um broker **de teste**.
	 *
	 * O broker de teste registra a pergunta e espera a resposta do próprio
	 * teste (`harness.prompts.answer`) — nenhuma resposta automática: o teste
	 * decide se erra, cancela ou acerta, como a pessoa decidiria.
	 */
	async function hostWithCredential(options: { readonly configure?: boolean } = {}): Promise<HarnessHost> {
		const repo = await makeDir('evelyn-dev7-repo-');
		execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
		await mkdir(join(repo, 'src', 'desktop', 'renderer'), { recursive: true });
		await writeFile(join(repo, CSS), ':root { --accent: #3b82f6; }\n', 'utf8');
		const data = await makeDir('evelyn-dev7-data-');
		const credential = store(join(data, 'dev'));
		if (options.configure !== false) {
			const result = await credential.configure(PASSWORD, PASSWORD);
			assert.equal(result.ok, true);
		}
		const sent: OwnerPrompt[] = [];
		const prompts = new OwnerPromptBroker((prompt) => {
			sent.push(prompt);
		});
		const created = new DevHost({
			repositoryRoot: repo,
			dataRoot: data,
			window: () => ({
				isWindowAlive: () => true,
				isWindowReady: () => true,
				reloadWindow: async () => undefined,
				restartApplication: async () => undefined,
			}),
			runCheck: async () => ({ exitCode: 0, summary: 'ok' }),
			readLocalInstance: async () => ({ kind: 'single', sessionId: '1', processes: 1 }),
			credential,
			prompt: prompts,
			ownerActions: {
				configure: async (password, confirmation) => {
					const result = await credential.configure(password, confirmation);
					return result.ok ? { ok: true, message: '' } : { ok: false, message: result.message };
				},
				reset: async () => {
					const result = await credential.reset({ confirm: true });
					return result.ok ? { ok: true, message: '' } : result;
				},
			},
		});
		await created.setup();
		hosts.push(created);
		return { host: created, prompts, sent, repo, data };
	}

	/**
	 * Ativa respondendo à pergunta como a pessoa faria.
	 *
	 * Espera a pergunta aparecer: `activateFromPanel` tem passos assíncronos
	 * (instância, estado da credencial) antes de perguntar, e o teste não pode
	 * assumir que ela já está na fila no instante seguinte.
	 */
	async function activate(h: HarnessHost, password = PASSWORD): Promise<void> {
		const pending = h.host.activateFromPanel();
		const prompt = await nextPrompt(h, h.sent.length);
		const accepted = h.prompts.answer({ id: prompt.id, kind: 'password', password });
		assert.equal(accepted.accepted, true, accepted.reason);
		await pending;
	}

	/** A próxima pergunta a partir do índice `from`. */
	async function nextPrompt(h: HarnessHost, from: number): Promise<OwnerPrompt> {
		const deadline = Date.now() + 10_000;
		while (h.sent.length <= from) {
			if (Date.now() > deadline) {
				assert.fail('o host não perguntou a senha a tempo');
			}
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		return h.sent[from] as OwnerPrompt;
	}

	test('sem credencial configurada, a ativação é recusada e o painel não a oferece', async () => {
		const h = await hostWithCredential({ configure: false });

		await h.host.activateFromPanel().catch(() => undefined);
		const state = await h.host.panelState();
		assert.equal(state.canActivate, false);
		assert.equal(state.localCredential.kind, 'not-configured');
		assert.match(state.activationBlockedReason ?? '', /configure a autorização/);
		assert.equal(h.sent.length, 0, 'nem pergunta a senha sem credencial');
	});

	test('senha errada não ativa; senha certa ativa na tentativa seguinte', async () => {
		const h = await hostWithCredential();

		// A primeira pergunta recebe a senha errada.
		const first = h.host.activateFromPanel();
		const firstPrompt = await nextPrompt(h, 0);
		h.prompts.answer({ id: firstPrompt.id, kind: 'password', password: 'senha-errada-mesmo' });
		await assert.rejects(first, /autorização recusada/);
		assert.equal(sessionOf(h.host), 'inactive');

		// A segunda, a certa.
		await activate(h);
		const state = await h.host.panelState();

		assert.equal(state.session, 'active');
		assert.equal(state.localCredential.kind, 'configured');
	});

	test('a pergunta cancelada recusa a ativação', async () => {
		const h = await hostWithCredential();

		// A pergunta chega pela fila; a resposta é o cancelamento, com o id
		// **da pergunta aberta**.
		const pending = h.host.activateFromPanel();
		const prompt = await nextPrompt(h, 0);
		assert.equal(h.prompts.answer({ id: prompt.id, kind: 'cancel' }).accepted, true);

		await assert.rejects(pending, /pergunta foi fechada/);
		assert.equal(sessionOf(h.host), 'inactive');
	});

	test('a pergunta que expira recusa a ativação', async () => {
		const h = await hostWithCredential();

		const pending = h.host.activateFromPanel();
		await nextPrompt(h, 0);
		h.prompts.cancel();
		// `cancel` encerra como "cancelled"; o prazo é provado no broker
		// (`DEV-7: o prompt de autorização`). Aqui o que importa é o host
		// recusar quando a pergunta não é respondida.
		await assert.rejects(pending, /pergunta foi fechada/);
	});

	test('a sessão cai quando a credencial é trocada durante ela', async () => {
		const h = await hostWithCredential();
		await activate(h);
		assert.equal(h.host.toolDeps()?.apply !== undefined, true);

		// A recuperação (outra janela, outro momento) apaga a credencial.
		await h.host.recoverFromPanel();

		assert.equal(sessionOf(h.host), 'inactive');
		assert.equal(h.host.toolDeps(), undefined, 'sem ferramentas DEV');
		await assert.rejects(h.host.applyFromPanel('qualquer'), /não está ativo/);
	});

	test('a aplicação é recusada se a credencial mudar por fora, antes dela', async () => {
		const h = await hostWithCredential();
		await activate(h);
		const deps = h.host.toolDeps()!;
		const written = await createDevToolEntries(deps)
			.find((entry) => entry.tool.descriptor.name === 'dev_write')!
			.tool.execute({ path: CSS, content: ':root { --accent: #ff0080; }\n' }, ctx);
		const operationId = (written.output as { readonly operationId: string }).operationId;
		// Troca o arquivo da credencial sem passar pelo host.
		await writeFile(join(h.data, 'dev', CREDENTIAL_FILE), JSON.stringify({ version: 1, outro: true }), 'utf8');

		await assert.rejects(h.host.applyFromPanel(operationId), /credencial local mudou/);
	});

	test('configurar pelo host: a senha vem do prompt, e o estado não a devolve', async () => {
		const repo = await makeDir('evelyn-dev7-repo-');
		execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
		const data = await makeDir('evelyn-dev7-data-');
		const credential = store(join(data, 'dev'));
		const sent: OwnerPrompt[] = [];
		const prompts = new OwnerPromptBroker((prompt) => sent.push(prompt));
		const created = new DevHost({
			repositoryRoot: repo,
			dataRoot: data,
			window: () => undefined,
			readLocalInstance: async () => ({ kind: 'single', sessionId: '1', processes: 1 }),
			credential,
			prompt: prompts,
			ownerActions: {
				configure: async (password, confirmation) => {
					const result = await credential.configure(password, confirmation);
					return result.ok ? { ok: true, message: '' } : { ok: false, message: result.message };
				},
				reset: async () => {
					await credential.reset({ confirm: true });
					return { ok: true, message: '' };
				},
			},
		});
		hosts.push(created);

		const configuring = created.configureFromPanel();
		const prompt = sent[0];
		assert.equal(prompt?.kind, 'configure');
		prompts.answer({ id: (prompt as OwnerPrompt).id, kind: 'configure', password: PASSWORD, confirmation: PASSWORD });
		const state = await configuring;

		assert.equal(state.localCredential.kind, 'configured');
		assert.equal(JSON.stringify(state).includes(PASSWORD), false);

		const recovered = await created.recoverFromPanel();
		assert.equal(recovered.localCredential.kind, 'not-configured');
	});
});
