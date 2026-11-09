/**
 * O lado Electron do teste do IPC do painel DEV (DEV-6).
 *
 * Roda **dentro** do `electron.exe`, com o `main.ts` real (build de `dist/`),
 * e faz pedidos IPC a partir de páginas **reais**:
 *
 * - uma página local (`file://`, `src/core-tests/helpers/devPanelPage.html`)
 *   numa janela comum — a de configurações;
 * - uma página em `data:` — outra janela, para provar que a origem `data:` é
 *   recusada mesmo quando o preload está lá.
 *
 * Não abre a janela principal do app (isso exige o Core montado com uma raiz
 * de dados): o ponto do teste é a **fronteira IPC** — origem, ação e argumento
 * — e a ausência de vazamento.
 *
 * Imprime `RESULT <json>` e sai. Nenhum arquivo do usuário é tocado: a raiz é
 * temporária e descartada pelo teste que o chama.
 *
 * Compilado para `out/core-tests/helpers/dev6IpcProbe.js`, com o mesmo
 * `require` de `electron` (não resolvido pelo tsconfig dos testes) dos outros
 * helpers.
 */
const { app, BrowserWindow } = require('electron');
const { mkdtemp } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

interface Report {
	readonly error?: string;
	readonly errorStack?: string;
	readonly fromFile?: unknown;
	readonly activate?: unknown;
	readonly badId?: unknown;
	readonly fromData?: unknown;
	/** DEV-7: os métodos da ponte e a ausência de `ipcRenderer` cru. */
	readonly methods?: unknown;
	/** DEV-7: `configureDevAuthorization` sem argumento. */
	readonly configure?: unknown;
	readonly filePayload?: string;
}

function report(payload: Report): void {
	const out = process.argv.find((a: string) => a.startsWith('--e2e-report='))?.slice('--e2e-report='.length);
	if (out !== undefined) {
		require('node:fs').mkdirSync(path.dirname(out), { recursive: true });
		require('node:fs').writeFileSync(out, `RESULT ${JSON.stringify(payload)}\n`);
	}
	// A execução termina por `process.exit`: um teste que espera o processo
	// sair não fica pendurado na janela.
	setTimeout(() => process.exit(0), 100).unref();
}

/**
 * Executa um pedido pela ponte, na página, e devolve o desfecho.
 *
 * `action` é `state`, `activate`, `apply` (com payload) ou `restore-bad` (id
 * fora do formato) — todos são tentativas que o `main` tem de decidir.
 *
 * DEV-7 acrescenta `configure`: pedir para configurar **com** a senha no
 * payload. O `main` tem de recusar o campo a mais antes de qualquer coisa —
 * a senha nunca é argumento de ação.
 */
async function ask(
	window: ProbeWindow,
	action: string,
	payload?: string,
): Promise<unknown> {
	const script = `(async () => {
		const bridge = window.seshyina;
		if (bridge === undefined) return { missing: true };
		try {
			const action = ${JSON.stringify(action)};
			const payload = ${JSON.stringify(payload ?? null)};
			if (action === 'state') return { ok: true, value: await bridge.getDevState() };
			if (action === 'activate') return { ok: true, value: await bridge.activateDev() };
			if (action === 'apply') return { ok: true, value: await bridge.applyDevOperation(payload) };
			if (action === 'restore-bad') return { ok: true, value: await bridge.restoreDevCheckpoint('../../etc') };
			if (action === 'bridge-methods') {
				return { ok: true, value: {
					hasConfigure: typeof bridge.configureDevAuthorization === 'function',
					hasRecover: typeof bridge.recoverDevAuthorization === 'function',
					hasPrompt: typeof bridge.onDevOwnerPrompt === 'function',
					hasAnswer: typeof bridge.answerDevOwnerPrompt === 'function',
					rawIpc: 'ipcRenderer' in bridge || 'send' in bridge || 'invoke' in bridge,
				} };
			}
			return { unsupported: true };
		} catch (error) {
			return { ok: false, error: String(error && error.message ? error.message : error) };
		}
	})()`;
	return window.webContents.executeJavaScript(script);
}

/**
 * Uma ação `configure` **com** a senha no payload, chamando o canal direto
 * pelo preload não é possível (ele não expõe `ipcRenderer`). O que se faz é
 * tentar o método público — que não aceita senha — e confirmar que ele não
 * envia nenhuma. A rejeição do campo a mais é provada em
 * `devOwnerCredential.test.ts`, no `parseDevRequest`.
 */
async function configureWithPassword(window: ProbeWindow): Promise<unknown> {
	const script = `(async () => {
		const bridge = window.seshyina;
		try {
			if (typeof bridge.configureDevAuthorization !== 'function') return { missing: true };
			await bridge.configureDevAuthorization();
			return { ok: true };
		} catch (error) {
			return { ok: false, error: String(error && error.message ? error.message : error) };
		}
	})()`;
	return window.webContents.executeJavaScript(script);
}

/** O mínimo de `BrowserWindow` que o teste usa (sem os tipos do Electron no tsconfig). */
interface ProbeWindow {
	readonly webContents: { executeJavaScript(script: string): Promise<unknown> };
	loadURL(url: string): Promise<void>;
}

async function loadWindow(url: string, preload: string): Promise<ProbeWindow> {
	const window = new BrowserWindow({
		show: false,
		webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
	}) as unknown as ProbeWindow;
	await window.loadURL(url);
	return window;
}

/**
 * O HTML da página de teste, servido por `file://` a partir de um arquivo
 * temporário.
 *
 * Um arquivo de verdade, e não `data:`: é a origem `file://` que o app usa em
 * produção, e é ela que o teste precisa exercitar. O arquivo é escrito numa
 * pasta descartável, para não depender de copiar assets para `out/`.
 */
async function writeLocalPage(): Promise<string> {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'evelyn-dev6-page-'));
	const file = path.join(dir, 'painel.html');
	await require('node:fs/promises').writeFile(
		file,
		'<!doctype html><meta charset="utf-8"><title>painel DEV</title><p>página local</p>',
		'utf8',
	);
	return file;
}

app.whenReady().then(async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'evelyn-dev6-e2e-'));
	const dist = path.join(process.cwd(), 'dist', 'desktop');
	// O app precisa rodar para o `main.ts` registrar os handlers. Ele recusa
	// montar o Core sem uma raiz real; `--root` aponta para uma descartável.
	process.argv.push('--root', root);
	try {
		require(path.join(dist, 'main.js'));
	} catch (error) {
		report({ error: `o main não carregou: ${error instanceof Error ? error.message : String(error)}` });
		return;
	}
	// Espera o handler existir: o `main` registra ao montar.
	await new Promise((resolve) => setTimeout(resolve, 1500));

	const local = await loadWindow(`file:///${(await writeLocalPage()).replace(/\\/g, '/')}`, path.join(dist, 'preload.js'));
	const fromFile = await ask(local, 'state');
	const activate = await ask(local, 'activate');
	const badId = await ask(local, 'restore-bad');
	const methods = await ask(local, 'bridge-methods');
	const configure = await configureWithPassword(local);

	const dataWindow = await loadWindow('data:text/html,<title>d</title>', path.join(dist, 'preload.js'));
	const fromData = await ask(dataWindow, 'state');

	report({
		fromFile,
		activate,
		badId,
		fromData,
		methods,
		configure,
		// O JSON inteiro que chegou à página, para o teste procurar token.
		filePayload: JSON.stringify(fromFile),
	});
}).catch((error: unknown) => report({ error: String(error), errorStack: error instanceof Error ? error.stack : undefined }));
