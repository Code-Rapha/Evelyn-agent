/**
 * Electron main process.
 *
 * A *host*, exactly like `host/vscode/` is one for the extension. It owns the
 * window and the OS integration; it does not own product logic. The Core and
 * the local adapters are imported unchanged, and nothing under `core/` imports
 * anything from here — the dependency only points inward.
 *
 * What it does in this stage, and nothing more:
 *
 * - stands up the Core services a local chat needs (logging, config, secrets,
 *   local history)
 * - creates one window with a locked-down `webPreferences`
 * - answers the provider and status channels
 * - relays chat stream events to the renderer as they are produced
 *
 * No tools, no permissions, no agent. Those arrive later.
 *
 * The conversation logic itself lives in `chatSession.ts`, which imports no
 * Electron — so it can be tested under plain mocha. This file is the wiring
 * between it and IPC, and deliberately holds no decisions.
 */
import { readFile, rm, writeFile } from 'node:fs/promises';
import {
	app,
	BrowserWindow,
	Menu,
	ipcMain,
	screen,
	shell,
	type IpcMainInvokeEvent,
	type Rectangle,
} from 'electron';
import { join } from 'node:path';

import type { ModelAccessPolicyRecord } from '../core/catalog/policy';
import type { AccessPolicyView } from './catalogFusion';
import type { MergedModelView } from './catalogFusion';
import { createSkillEvolutionService } from '../core/skill/skillEvolutionService';
import { scanForSkillImprovements } from './learningPipeline';
import { ChatSession } from './chatSession';
import { DevHost, type DevHostWindow } from './devHost';
import { parseDevRequest, parseOwnerPromptAnswer } from './devControl';
import { readLocalInstance } from './localInstance';
import { OwnerCredentialStore } from './ownerCredential';
import { OwnerPromptBroker, type OwnerPrompt } from './ownerPrompt';
import { currentWindowsUser } from './windowsDpapi';
import type { DevPanelState } from '../core/dev/devPanel';
import type { AssembledCore } from '../app/assemble';
import { mountCore, type MountResult } from '../app/mount';
import { probeService } from '../app/discoverService';
import { peekRecord } from '../app/serviceLifecycle';
import { createPersistentUnlockStore } from './devPersistentUnlock';
import {
	ensureService,
	serviceDirectoryFor,
	shutdownService,
	type ServiceMaterial,
	type ServiceStartOutcome,
} from '../app/serviceLauncher';
import { panelUrlFor } from './panelLink';
import { UiSessionStore, toBootState } from '../core/dev/uiSession';
import { parseSessionPatch, assertBootStateSafe } from '../core/dev/sessionMessages';
import { DevOperationStore } from '../core/dev/devOperation';
import { decideBoot } from '../core/dev/bootState';
import { ServiceClient } from './serviceClient';
import { readyEnabled, readyLine, type ReadyMode } from './testReadiness';
import { deleteForDesktop } from './conversationDelete';
import { ServiceChatClient } from './serviceChat';
import { defaultDataStoreRoot } from '../adapters/local/fileDataStore';
import { settingsWindowAction } from './settingsWindowPolicy';
import {
	APP_NAME,
	CHAT_EVENT_CHANNEL,
	BUDGET_CHANNEL,
	DISCOVERY_CHANNEL,
	ACCESS_POLICY_CHANNEL,
	CONVERSATION_CHANNEL,
	CORE_STATUS_CHANNEL,
	MODEL_GUIDANCE_CHANNEL,
	SERVICE_CATALOG_CHANNEL,
	SERVICE_STATUS_CHANNEL,
	SERVICE_CONVERSATIONS_CHANNEL,
	SERVICE_CONVERSATION_CHANNEL,
	SERVICE_CREATE_CHANNEL,
	SERVICE_RENAME_CHANNEL,
	SERVICE_DELETE_CHANNEL,
	SERVICE_TURNS_CHANNEL,
	SERVICE_PANEL_CHANNEL,
	SERVICE_CONTROL_CHANNEL,
	SERVICE_STATE_CHANNEL,
	UI_SESSION_CHANNEL,
	DEV_CHANNEL,
	DEV_EVENT_CHANNEL,
	DEV_OWNER_PROMPT_CHANNEL,
	DEV_OWNER_PENDING_CHANNEL,
	DEV_OWNER_ANSWER_CHANNEL,
	MODEL_CHANNEL,
	MODEL_CATALOG_CHANNEL,
	OPEN_SETTINGS_CHANNEL,
	PROJECT_CHANNEL,
	PROVIDER_CHANNEL,
	ROUTER_STATE_CHANNEL,
	SEND_MESSAGE_CHANNEL,
	PERMISSION_DECISION_CHANNEL,
	SKILL_EVOLUTION_CHANNEL,
	STOP_CHANNEL,
	WINDOW_CHANNEL,
	WINDOW_STATE_CHANNEL,
	parseCoordinate,
	parseResizeDirection,
	type ResizeDirection,
	type RouterConfigView,
	type ProviderSummary,
	parseConversationId,
	parseConversationTitle,
	parseCoreStatus,
	parseCreateConversationInput,
	parseCreateProjectInput,
	parsePermissionAnswer,
	parseModelCatalogKey,
	parseSaveModelCatalogInput,
	parseBudgetWindow,
	parseForecastRequestView,
	parseSaveSpendingLimitViewInput,
	parseSpendingLimitId,
	parseProviderId,
	parseSendMessageInput,
	parseSaveProviderInput,
	parseSystemPrompt,
	parseDecisionReason,
	parseRollbackTarget,
	parseSaveSkillImprovementInput,
	parseSkillProposalId,
	parseSkillProposalStatus,
	type ChatStreamEvent,
	type CoreStatus,
	type ServiceControlReply,
	type ServiceControlState,
} from './contract';
import type { AgentUiEvent } from './agentTurn';

/**
 * Replaced at build time with the root package.json version. Declared here
 * because the global does not exist at runtime unless esbuild substitutes it.
 */
declare const __APP_VERSION__: string;

/**
 * The Core, assembled for this host.
 *
 * The assembly itself lives in `src/app/assemble.ts`, because it is not the
 * desktop's: a second host needs the same pieces, and two copies of an
 * assembly drift apart silently. What is left here is what is *this host's*:
 * the window, the events it receives, and the status it reports.
 *
 * The root is taken through `mountCore`, the same rule the web host uses: a
 * host that cannot take the data directory does not mount the Core at all.
 */
class DesktopCore {
	private readonly mounted: Extract<MountResult, { kind: 'mounted' }> | undefined;

	// Not private: `registerIpc` below is a module-level function that wires this
	// session to IPC, and a private field would force every call through an
	// accessor that exists only to work around that.
	readonly chat: ChatSession | undefined;
	readonly skillEvolution: ReturnType<typeof createSkillEvolutionService> | undefined;
	/**
	 * The histories the scan reads.
	 *
	 * Same `FileDataStore` as the transcript and the same logs the
	 * experimentation layer already writes, so "analisar o histórico" reads what
	 * was actually recorded rather than a copy kept for the analysis.
	 */
	readonly learningHistory: AssembledCore['learningHistory'] | undefined;

	/** Why the root could not be taken. Absent when it was. */
	readonly refusal: string | undefined;
	/**
	 * Por que a raiz não foi tomada (R4B).
	 *
	 * `mounted` quando foi. `busy` quando outro host a tem — o caso do
	 * serviço local. `failed` quando o sistema de arquivos recusou (permissão,
	 * disco). A mensagem não é suficiente para distinguir os dois últimos, e
	 * a diferença decide se o app abre a janela ou sai.
	 */
	readonly refusalKind: MountResult['kind'];

	/**
	 * Takes the root and mounts the Core — or records why it did not.
	 *
	 * `rootPath` existe para dois casos honestos: um teste que precisa de uma
	 * pasta descartável (senão ele mexeria na instalação real do usuário) e um
	 * usuário com a raiz em outro volume. Ausente = a raiz padrão, de sempre.
	 */
	static async create(options: { readonly rootPath?: string } = {}): Promise<DesktopCore> {
		const mount = await mountCore({
			host: DESKTOP_HOST_NAME,
			name: APP_NAME,
			...(options.rootPath !== undefined ? { rootPath: options.rootPath } : {}),
		});
		return new DesktopCore(mount);
	}

	private constructor(mount: MountResult) {
		this.mounted = mount.kind === 'mounted' ? mount : undefined;
		this.refusal = mount.kind === 'mounted' ? undefined : mount.message;
		this.refusalKind = mount.kind;
		this.chat = this.mounted?.core.chat;
		this.skillEvolution = this.mounted?.core.skillEvolution;
		this.learningHistory = this.mounted?.core.learningHistory;
	}

	/**
	 * Reads the history and reports what looks improvable.
	 *
	 * Returns the reading rather than acting on it.
	 */
	async scanSkillHistory(): Promise<unknown> {
		if (this.mounted === undefined) {
			throw new Error('the data directory is not available');
		}
		return this.mounted.core.scanSkillHistory();
	}

	/** The payload the renderer is allowed to see. */
	status(electronVersion: string): CoreStatus {
		return parseCoreStatus({
			appName: APP_NAME,
			version: __APP_VERSION__,
			electronVersion,
			platform: process.platform,
			services: ['logging', 'provider-config', 'chat-session'],
			providerCount: this.chat?.providerCount ?? 0,
			dataDirectory: this.mounted?.core.root ?? '',
			// Este objeto só existe quando há Core montado: é o modo local.
			// Os outros modos são montados em `main`, sem um `DesktopCore`.
			mode: this.mounted === undefined ? 'unavailable' : 'local',
		});
	}

	/**
	 * Registers a listener for the window going away.
	 *
	 * Used to deny open permission requests: a dialog nobody can see must not
	 * keep a tool blocked.
	 */
	onWindowClosed(listener: () => void): void {
		windowClosedListeners.push(listener);
	}

	/** A single line to the terminal. Routing through the Core keeps redaction. */
	log(message: string): void {
		// Sem Core montado (modo conectado ou sem dados) não há logger do
		// Core; o terminal continua sendo o lugar de dizer o que aconteceu,
		// com o mesmo prefixo, para a mensagem não desaparecer justamente no
		// modo em que o usuário mais precisa saber onde os dados estão.
		if (this.mounted === undefined) {
			console.error(`[${APP_NAME.toLowerCase()}] ${message}`);
			return;
		}
		this.mounted.core.logger.info(message);
	}

	/**
	 * Stops the Core and **releases the root**.
	 *
	 * Called once, on `will-quit`. Soltar a raiz aqui é o que permite o outro
	 * host começar sem esperar o processo anterior sumir — e é o par do
	 * `mountCore`: quem toma, solta.
	 */
	dispose(): void {
		this.chat?.stop();
		void this.mounted?.release();
	}
}

/**
 * O Core deste host, montado em `main` — nunca no import.
 *
 * Tomar a raiz é assíncrono, e um desktop que a perdeu não deve abrir janela
 * nenhuma: a montagem acontece antes de `createWindow`, e o módulo fica sem
 * Core até lá.
 */
let core: DesktopCore | undefined;
/**
 * O host do modo DEV (DEV-5), montado depois da janela.
 *
 * Fica no módulo porque `ownerRequest`/`ownerExit` serão chamados pelo canal
 * de controle da DEV-6 (e, hoje, pelo processo principal). `undefined` antes
 * de `main` montar — e nos modos sem Core local.
 */
let devHost: DevHost | undefined;
/**
 * DEV-7: o broker do prompt de autorização (há no máximo uma pergunta aberta).
 *
 * Fica no módulo porque o handler IPC da resposta precisa dele; `undefined`
 * nos modos em que o host não monta.
 */
let ownerPrompts: OwnerPromptBroker | undefined;
/**
 * O cliente do serviço local, criado na primeira consulta.
 *
 * Não guarda conexão: cada `status`/`catalog` redescobre o serviço, então um
 * reinício dele no meio da sessão não deixa credencial velha em uso.
 */
let serviceLink: ServiceClient | undefined;
/**
 * O modo da janela quando não há Core local (R4B).
 *
 * `undefined` = ainda não decidido (app em modo local normal). Atribuído uma
 * vez, em `main`, depois da descoberta.
 */
let remoteMode: 'connected' | 'unavailable' | undefined;
/** O que a interface mostra do serviço, nos modos sem Core local. */
let remoteStatus: ServiceStatusForWindow | undefined;
/**
 * Por que o serviço não subiu nesta abertura.
 *
 * Fica vazio quando ele subiu, ou quando nem foi tentado. Serve para a tela
 * dizer "o painel no navegador precisa do serviço" **sabendo** que a tentativa
 * falhou e por quê — em vez de deixar o usuário concluir que o botão está
 * quebrado.
 */
let serviceStartFailure: string | undefined;

/**
 * O estado que a janela mostra nos modos sem Core local.
 *
 * Só campos públicos: nenhuma credencial, nenhum caminho de dados do outro
 * processo.
 */
interface ServiceStatusForWindow {
	readonly state: 'connected' | 'disconnected' | 'error';
	readonly detail: string;
	readonly reason?: string;
	readonly port?: number;
	readonly pid?: number;
	readonly version?: string;
	readonly providers?: number;
	readonly models?: number;
	readonly router?: {
		readonly mode: string;
		readonly enabled: boolean;
		readonly configured: boolean;
	};
}
/** O nome deste host na trava de dados. */
const DESKTOP_HOST_NAME = 'desktop';

/**
 * O sinal de prontidão para os testes de integração (R4L).
 *
 * Escreve **uma** linha no stderr **somente** quando `SESHYINA_TEST_READY=1`
 * — ver `testReadiness.ts`. Chamado depois de o modo de arranque estar
 * decidido e concluído, nunca antes: um sinal adiantado faria o teste achar
 * que a conexão aconteceu quando ela ainda estava em curso.
 *
 * Sem a variável, não escreve nada e não muda nenhuma saída do app.
 */
function signalReady(mode: ReadyMode, service?: number): void {
	if (!readyEnabled()) {
		return;
	}
	const line = readyLine({
		mode,
		pid: process.pid,
		...(service !== undefined ? { service } : {}),
	});
	if (line !== undefined) {
		console.error(line);
	}
}

/**
 * O arquivo de ícone, ao lado do bundle.
 *
 * O `esbuild.desktop.js` o copia de `icons/` para `dist/desktop/`; o
 * empacotador leva a pasta inteira. Um único nome, num único lugar, para as
 * duas janelas não divergirem.
 */
const APP_ICON = 'evelyn_app_icon.ico';

let mainWindow: BrowserWindow | undefined;

/**
 * Sends an event to every window, if one is still open.
 *
 * A closed window is not an error: the turn is still running in the Core and
 * its result is still persisted, so there is nothing to repair — only nobody
 * left to tell.
 */
function emitToWindows(event: AgentUiEvent | ChatStreamEvent): void {
	for (const window of BrowserWindow.getAllWindows()) {
		if (!window.isDestroyed()) {
			window.webContents.send(CHAT_EVENT_CHANNEL, event);
		}
	}
}


/**
 * Listeners for the window going away.
 *
 * Module-level because the window is created outside the Core: the Core needs to
 * be told so it can deny open permission requests, and the window is what
 * disappears.
 */
const windowClosedListeners: (() => void)[] = [];

/**
 * One window, configured to be as locked down as the task allows.
 *
 * The four settings that matter, and why:
 *
 * - `contextIsolation: true` — the preload and the page get separate JS
 *   worlds, so page code cannot reach the bridge's internals.
 * - `nodeIntegration: false` — no `require` in the page. Nothing the renderer
 *   needs Node for, because the bridge does that work in main.
 * - `sandbox: true` — the renderer is OS-sandboxed even if a bug slips past.
 * - `webSecurity` left on (the default) — no relaxed same-origin rules.
 *
 * `nodeIntegrationInWorker` stays off for the same reason; it follows
 * `nodeIntegration`.
 */

function createWindow(): BrowserWindow {
	const window = new BrowserWindow({
		title: APP_NAME,
		// O ícone da barra de tarefas. Resolvido por `__dirname` porque o
		// `esbuild.desktop.js` o copia para junto do bundle — inclusive dentro
		// do `asar` do pacote, onde o caminho da raiz não existiria.
		icon: join(__dirname, APP_ICON),
		width: 1100,
		height: 760,
		minWidth: 720,
		minHeight: 520,
		show: false,
		// Frameless, because transparent and native frame do not coexist on
		// Windows: `transparent: true` strips the frame, and the frame is what
		// carries the title bar and the resize borders. The window therefore has
		// to supply its own, which is what `registerWindowControls` and the
		// renderer's `.titlebar` and `.resize-handle` elements are for.
		//
		// The cost of this trade, stated once: everything the OS frame did is now
		// rebuilt by hand, so right-click on the title bar no longer restores a
		// window, and snapping to a screen edge is the maximise button only. What
		// the frame cannot do at all — a window that is see-through and has
		// rounded corners you control — is what this buys.
		frame: false,
		// The window itself is see-through, so the desktop shows behind it and the
		// stylesheet's translucent greens tint whatever is there. Needs an alpha in
		// `backgroundColor` too: left opaque, the window would paint one flat
		// colour before the renderer runs and look solid for the first frames.
		transparent: true,
		backgroundColor: '#00000000',
		webPreferences: {
			preload: join(__dirname, 'preload.js'),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});

	// Painting an empty window first avoids the white flash before the renderer
	// has drawn anything.
	window.once('ready-to-show', () => window.show());
	pushWindowState(window);

	// External links open in the user's browser; the app window never navigates
	// away from the bundled page.
	window.webContents.setWindowOpenHandler(({ url }) => {
		if (url.startsWith('https://')) {
			void shell.openExternal(url);
		}
		return { action: 'deny' };
	});
	window.webContents.on('will-navigate', (event, url) => {
		if (url !== window.webContents.getURL()) {
			event.preventDefault();
		}
	});

	// A prompt belongs to a turn, and the turn belongs to this window. When the
	// window goes away the prompt goes with it, so closing is a denial — the tool
	// is refused rather than left blocked on an answer nobody can give.
	window.on('closed', () => {
		// Cleared here rather than left pointing at a destroyed window: every
		// IPC handler resolves its window through this, and a stale reference
		// turns a late click into `Object has been destroyed`.
		if (mainWindow === window) {
			mainWindow = undefined;
		}
		for (const listener of windowClosedListeners) {
			listener();
		}
	});

	void window.loadFile(join(__dirname, 'renderer', 'index.html'));
	return window;
}

/**
 * The IPC surface.
 *
 * One channel per concern rather than one channel with a string verb, except for
 * providers where the four actions share a shape. Every handler validates what
 * arrived through the shared `parse*` before touching the Core, so a hostile
 * payload is rejected at the boundary rather than deep inside the session.
 */
/**
 * Narrows the `{ proposalId, reason }` an approve or reject carries.
 *
 * Narrowed in main rather than trusted from the renderer: this payload decides
 * whether a future change to the agent's knowledge is allowed, and the id it
 * names has to be the one the user was actually looking at.
 */
function readDecisionPayload(payload: unknown): { proposalId: string; reason: string } {
	if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
		throw new Error('a proposal decision must be an object');
	}
	const record = payload as Record<string, unknown>;
	return {
		proposalId: parseSkillProposalId(record.proposalId),
		reason: parseDecisionReason(record.reason),
	};
}

/** Narrows the `{ skillId, versionId, reason }` a rollback carries. */
function readRollbackPayload(payload: unknown): { skillId: string; versionId: string; reason: string } {
	if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
		throw new Error('a rollback must be an object');
	}
	const record = payload as Record<string, unknown>;
	return {
		...parseRollbackTarget(record),
		reason: parseDecisionReason(record.reason),
	};
}

/** The view shape the renderer parses; one place so `get` and `set` agree. */
function toAccessPolicyView(record: ModelAccessPolicyRecord): AccessPolicyView {
	return {
		policy: record.policy,
		priceSource: record.priceSource,
		limitsSource: record.limitsSource,
		capabilitiesSource: record.capabilitiesSource,
		updatedAt: record.updatedAt,
		changedBy: record.changedBy,
		hint: 'Evelyn, use somente os modelos gratuitos',
	};
}

/**
 * Tells every window that the router configuration changed.
 *
 * Both windows write the same file: the main window has the switch, and the
 * settings window has the form. Without this the window that did not write
 * would keep showing a state that is no longer the recorded one — and the
 * switch would act on a stale copy.
 */
function broadcastRouterState(config: RouterConfigView): void {
	for (const window of BrowserWindow.getAllWindows()) {
		if (!window.isDestroyed()) {
			window.webContents.send(ROUTER_STATE_CHANNEL, config);
		}
	}
}

/**
 * The Core as the rest of the process sees it.
 *
 * `main` only registers IPC after it has taken the data directory, so at that
 * point there is a Core. `registerIpc` narrows it once, and every handler
 * inside works with a value that is not optional — instead of a non-null
 * assertion on each of forty calls.
 */
function requireCore(core: DesktopCore | undefined): DesktopCore {
	if (core === undefined) {
		throw new Error('the data directory is not available');
	}
	return core;
}

function requireChat(core: DesktopCore | undefined): ChatSession {
	const session = requireCore(core).chat;
	if (session === undefined) {
		throw new Error('the data directory is not available');
	}
	return session;
}

function requireEvolution(core: DesktopCore | undefined): ReturnType<typeof createSkillEvolutionService> {
	const evolution = requireCore(core).skillEvolution;
	if (evolution === undefined) {
		throw new Error('the data directory is not available');
	}
	return evolution;
}

/** The histories the learning scan reads, once the root is ours. */
function requireLearningHistory(core: DesktopCore): AssembledCore['learningHistory'] {
	if (core.learningHistory === undefined) {
		throw new Error('the data directory is not available');
	}
	return core.learningHistory;
}

/**
 * Os canais de **leitura** do serviço local.
 *
 * Uma instância por processo, com a raiz que este app está usando. Cada
 * consulta volta a descobrir o serviço, para um reinício do serviço no meio da
 * sessão não deixar o app falando com uma credencial que já não vale.
 *
 * O que chega à interface é só o `ServiceLinkStatus`/`ServiceCatalog`: o
 * cliente não devolve, e estes handlers não repassam, nenhuma credencial.
 */
/** Os turnos remotos em curso, iniciados por este app. */
const remoteTurns = new Map<string, { cancel(): Promise<void>; readonly done: Promise<void> }>();
/** O cliente de conversa do serviço, criado uma vez. */
let serviceChatLink: ServiceChatClient | undefined;

/** O cliente de conversa do serviço. */
function serviceChat(): ServiceChatClient {
	serviceChatLink ??= new ServiceChatClient({ root: rootArgument() ?? defaultDataStoreRoot() });
	return serviceChatLink;
}
function registerServiceIpc(): void {
	ipcMain.handle(SERVICE_STATUS_CHANNEL, async () => {
		// Em modo local, a interface mostra o estado do serviço (que é o que
		// ela consulta). Nos modos sem Core, o estado é o do próprio app —
		// `connected`/`disconnected`/`error` — atualizado por uma nova
		// consulta, para uma perda de conexão aparecer.
		if (remoteMode === undefined) {
			return await serviceClient().status();
		}
		const fresh = await serviceClient().status();
		if (fresh.state === 'active') {
			// R4S: um estado bom **sempre** recupera o modo. Antes, só
			// `connected` voltava a ser `connected`, e uma consulta que
			// falhasse uma vez (serviço ocupado no arranque, IPC atrasado)
			// deixava o app dizendo "Serviço desconectado" para sempre, mesmo
			// com o serviço respondendo.
			remoteMode = 'connected';
			remoteStatus = {
				...remoteStatus,
				state: 'connected',
				detail: fresh.detail,
				port: fresh.port,
				pid: fresh.pid,
				version: fresh.version,
			};
		} else if (fresh.state === 'inactive' && remoteMode === 'connected') {
			// O serviço caiu depois da conexão: o app continua aberto e diz
			// isso. Não monta Core e não inicia nada.
			remoteMode = 'unavailable';
			remoteStatus = {
				state: fresh.reason === 'inactive' ? 'disconnected' : 'error',
				detail: fresh.detail,
				...(fresh.reason !== undefined ? { reason: fresh.reason } : {}),
			};
		}
		return remoteStatus;
	});
	ipcMain.handle(SERVICE_CONTROL_CHANNEL, async (_event, action: unknown) => {
		const root = rootArgument() ?? defaultDataStoreRoot();
		// "Abrir em modo local para usar o DEV": encerra o serviço e reinicia.
		// Só existe quando este processo está conectado — no local ele já é
		// local, e o botão não é oferecido.
		if (action === 'restart-local') {
			if (remoteMode !== 'connected') {
				return { ok: false, message: 'o app já está em modo local' };
			}
			const result = await restartLocalForDev(root);
			return result.ok
				? { ok: true }
				: { ok: false, message: result.message ?? 'não foi possível reiniciar em modo local' };
		}
		if (action === 'read') {
			return await readServiceControl(root);
		}
		if (action !== 'on' && action !== 'off') {
			throw new Error(`Unknown service control action ${JSON.stringify(action)}`);
		}
		return await setServiceRunning(root, action === 'on');
	});
	ipcMain.handle(SERVICE_PANEL_CHANNEL, async () => {
		// R4R: o endereço é montado aqui, a partir do **registro** do serviço —
		// a única fonte com a porta e a credencial de painel. O renderer recebe
		// só o desfecho; nunca a URL com o token.
		const root = rootArgument() ?? defaultDataStoreRoot();
		const record = await peekRecord(root);
		const plan = panelUrlFor(record);
		if (!plan.ok) {
			// O motivo do start responde "por que não há serviço": sem ele, a
			// tela diria só "não está ativo" a quem acabou de ver o app tentar
			// iniciá-lo — e o mesmo texto para "não configurado" e para
			// "iniciou e morreu" esconde a diferença que decide o que fazer.
			return {
				ok: false,
				code: plan.code,
				message:
					serviceStartFailure !== undefined
						? `${plan.message}. ${serviceStartFailure}`
						: plan.message,
			};
		}
		try {
			await shell.openExternal(plan.url);
			return { ok: true };
		} catch (error) {
			return {
				ok: false,
				code: 'failed',
				message: `não foi possível abrir o navegador: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	});
	ipcMain.handle(UI_SESSION_CHANNEL, async (_event, action: unknown, payload: unknown) => {
		// DEV-4: o estado da sessão de interface — a conversa aberta e se há
		// geração em curso. Só esses dois campos; caminho, conteúdo e token são
		// recusados pela validação do Core, não aceitos e ignorados.
		const dir = join(rootArgument() ?? defaultDataStoreRoot(), 'dev');
		const store = new UiSessionStore(dir);
		if (action === 'boot') {
			const [operation, session] = await Promise.all([new DevOperationStore(dir).read(), store.read()]);
			const decision = decideBoot({
				...(operation !== undefined ? { operation } : {}),
				session,
			});
			const boot = toBootState(decision);
			// A checagem falha em vez de mandar para a página algo que não devia.
			return assertBootStateSafe(boot);
		}
		if (action === 'set') {
			const patch = parseSessionPatch(payload);
			await store.patch(patch);
			return undefined;
		}
		throw new Error('ação desconhecida na sessão da interface');
	});
	ipcMain.handle(DEV_CHANNEL, async (event, action: unknown, payload: unknown) => {
		// DEV-6: o painel do modo DEV.
		//
		// Duas decisões, nesta ordem: **de onde veio** e **o que pediu**.
		//
		// 1. Origem. Só a janela principal — a do chat — pode ativar, encerrar,
		//    aplicar e restaurar. A janela de configurações é outro processo do
		//    Electron e tem a leitura; as ações dela são recusadas aqui, não na
		//    página. E a URL tem de ser a página local do app: nada de `data:`,
		//    `devtools`, `blob:` — um contexto que o preload habilitou não pode
		//    virar o painel do modo DEV.
		// 2. Argumento. `parseDevRequest` recusa ação desconhecida, campo a
		//    mais e id fora do formato. Caminho e comando nem têm campo.
		const senderWindow = BrowserWindow.fromWebContents(event.sender);
		const host = devHost;
		if (host === undefined) {
			throw new Error('o modo DEV não está montado neste host');
		}
		const request = parseDevRequest(action, payload);
		const origin = event.senderFrame?.url ?? '';
		const isLocalPage = origin.startsWith('file://') || origin.startsWith('http://localhost:');
		const inMain = senderWindow !== null && mainWindow !== undefined && senderWindow === mainWindow;
		// O painel DEV **mora** na janela de configurações (`.only-settings`): é
		// ela que desenha os botões. Restringir as ações à janela do chat deixava
		// o painel visível e todo botão recusado — medido no pacote, onde o
		// prompt de senha nunca abria.
		//
		// A janela de configurações **do app** é identificada pela própria URL
		// (`?window=settings`), não só por ser `file://`: uma página local
		// qualquer não vira painel DEV só por estar na lista de janelas.
		//
		// As ações que **mudam o repositório** (`apply`, `restore`) continuam só
		// na janela principal: são as que aplicam a operação preparada, e essa
		// não é uma tela de configuração.
		const inSettings =
			senderWindow !== null &&
			settingsWindow !== undefined &&
			senderWindow === settingsWindow &&
			origin.includes('window=settings');
		const readOnly = request.action === 'state' || request.action === 'refresh' || request.action === 'history';
		const repositoryAction = request.action === 'apply' || request.action === 'restore';
		if (!isLocalPage) {
			throw new Error('origem não autorizada para o painel DEV');
		}
		// Ler o estado é permitido a qualquer página local (é informação do
		// host, sem segredo); **agir** não. A regra de agir é a que mudou: a
		// janela de configurações do app também age, porque é ela que desenha o
		// painel. Qualquer outra janela continua recusada.
		if (!readOnly && !(inMain || inSettings)) {
			throw new Error(
				repositoryAction
					? 'aplicar e restaurar só podem ser pedidos pela janela principal'
					: 'ações do modo DEV só podem ser pedidas pela janela principal',
			);
		}
		if (repositoryAction && !inMain) {
			throw new Error('aplicar e restaurar só podem ser pedidos pela janela principal');
		}
		switch (request.action) {
			case 'history':
				// DEV-9.1: leitura do diário. Sem segredo (o registro não
				// guarda saída nem credencial), e por isso vale para qualquer
				// janela local — a mesma regra de `state`.
				return { entries: await host.runHistory(50) };
			case 'state':
			case 'refresh':
				// DEV-8: a janela de configurações **é** onde o painel DEV mora,
				// e é local e do host. Antes ela recebia `inspectionState`
				// (`canAct: false`), o que a deixava sem configurar e sem ativar
				// — medido no app real. Agora lê o estado do host. O que segue
				// separado é o poder: `activate/configure/recover` só valem da
				// janela principal (ver `if (!readOnly && !isMainWindow)`).
				return await host.panelState();
			case 'activate':
				return notifyDevChange(await host.activateFromPanel());
			case 'deactivate':
				return notifyDevChange(await host.deactivateFromPanel());
			case 'lock':
				return notifyDevChange(await host.lockFromPanel());
			case 'revoke':
				return notifyDevChange(await host.revokeFromPanel());
			case 'configure':
				return notifyDevChange(await host.configureFromPanel());
			case 'recover':
				return notifyDevChange(await host.recoverFromPanel());
			case 'apply': {
				const result = await host.applyFromPanel(request.operationId);
				notifyDevChange(await host.panelState());
				return { outcome: result.outcome, detail: result.detail };
			}
			case 'restore': {
				const result = await host.restoreFromPanel(
					request.checkpointId !== undefined ? { checkpointId: request.checkpointId } : {},
				);
				notifyDevChange(await host.panelState());
				return { outcome: 'restored', detail: result.detail, blocked: result.blocked };
			}
		}
	});
	ipcMain.handle(DEV_OWNER_ANSWER_CHANNEL, (event, payload: unknown) => {
		// DEV-7: a resposta ao pedido de senha.
		//
		// Mesma fronteira da DEV-6: página local e uma das janelas **do app** —
		// a do chat ou a de configurações. O diálogo é desenhado onde a seção
		// DEV vive (configurações), e a resposta precisa poder vir dali; uma
		// janela que não é do app (outra página local, um `data:`) continua
		// recusada.
		//
		// O `parseOwnerPromptAnswer` confere o formato; o broker confere o id
		// contra a pergunta **aberta** e devolve só "aceito". Nada da senha
		// aparece na resposta, em log ou em estado.
		const senderWindow = BrowserWindow.fromWebContents(event.sender);
		const origin = event.senderFrame?.url ?? '';
		const isLocalPage = origin.startsWith('file://') || origin.startsWith('http://localhost:');
		const isAppWindow =
			senderWindow !== null &&
			((mainWindow !== undefined && senderWindow === mainWindow) ||
				(settingsWindow !== undefined && senderWindow === settingsWindow));
		const broker = ownerPrompts;
		if (!isLocalPage) {
			throw new Error('origem não autorizada para a autorização DEV');
		}
		if (!isAppWindow) {
			throw new Error('a autorização do modo DEV só pode ser respondida numa janela do aplicativo');
		}
		if (broker === undefined) {
			throw new Error('não há pedido de autorização neste host');
		}
		const answer = parseOwnerPromptAnswer(payload);
		return broker.answer(answer);
	});
	ipcMain.handle(SERVICE_CATALOG_CHANNEL, async () => {
		const result = await serviceClient().catalog();
		if (!result.ok) {
			// `undefined` em vez de uma lista vazia: "não há serviço" e "o
			// serviço não tem modelos" são fatos diferentes, e a interface
			// precisa dizer o primeiro.
			return { ok: false, code: result.code, message: result.message };
		}
		return { ok: true, catalog: result.value };
	});
	/*
	 * A conversa pelo serviço (R4C).
	 *
	 * O desktop envia o turno, recebe os eventos e os encaminha ao renderer
	 * pelo canal existente (`CHAT_EVENT_CHANNEL`), com o mesmo vocabulário do
	 * modo local. É o transporte: o turno roda no motor do serviço.
	 */
	ipcMain.handle(
		'seshyina:service-send',
		async (
			event,
			payload: unknown,
		): Promise<{ readonly accepted: boolean; readonly turnId?: string; readonly error?: string }> => {
			const input = payload as {
				readonly conversationId?: unknown;
				readonly providerId?: unknown;
				readonly model?: unknown;
				readonly text?: unknown;
				readonly routing?: unknown;
			};
			// DEV-8.10: o modo do chat vale também aqui. No automático o par é
			// dispensado — quem escolhe é o motor do serviço; nos demais, e sem
			// modo (cliente antigo), o par continua obrigatório.
			const routing =
				input.routing === 'auto' || input.routing === 'direct' || input.routing === 'external'
					? input.routing
					: undefined;
			const requiresProvider = routing === undefined || routing === 'direct';
			const requiresModel = routing === undefined || routing !== 'auto';
			if (
				typeof input.conversationId !== 'string' ||
				input.conversationId.length === 0 ||
				typeof input.text !== 'string' ||
				(requiresProvider &&
					(typeof input.providerId !== 'string' || input.providerId.length === 0)) ||
				(requiresModel && (typeof input.model !== 'string' || input.model.length === 0)) ||
				(input.providerId !== undefined && typeof input.providerId !== 'string') ||
				(input.model !== undefined && typeof input.model !== 'string')
			) {
				return { accepted: false, error: 'informe conversationId, providerId, model e text' };
			}
			const sender = event.sender;
			const client = serviceChat();
			const result = await client.run({
				conversationId: input.conversationId,
				providerId: typeof input.providerId === 'string' ? input.providerId : '',
				model: typeof input.model === 'string' ? input.model : '',
				text: input.text,
				...(routing !== undefined ? { routing } : {}),
				onEvent: (serviceEvent) => {
					if (sender.isDestroyed()) {
						return;
					}
					// O renderer já conhece este vocabulário do modo local.
					sender.send(CHAT_EVENT_CHANNEL, serviceEvent);
				},
			});
			if (!result.ok) {
				return { accepted: false, error: result.message };
			}
			remoteTurns.set(result.turn.turnId, result.turn);
			void result.turn.done.finally(() => remoteTurns.delete(result.turn.turnId));
			return { accepted: true, turnId: result.turn.turnId };
		},
	);

	ipcMain.handle('seshyina:service-stop', async (_event, payload: unknown) => {
		const turnId = (payload as { readonly turnId?: unknown } | null)?.turnId;
		if (typeof turnId !== 'string') {
			return { stopped: false };
		}
		const turn = remoteTurns.get(turnId);
		if (turn === undefined) {
			// Só o turno iniciado por este app é cancelado. Um id de outro
			// cliente não está aqui, e o serviço também o recusaria.
			return { stopped: false };
		}
		await turn.cancel();
		remoteTurns.delete(turnId);
		return { stopped: true };
	});

	ipcMain.handle(SERVICE_TURNS_CHANNEL, async (_event, payload: unknown) => {
		const id = (payload as { readonly conversationId?: unknown } | null)?.conversationId;
		if (typeof id !== 'string' || id.length === 0) {
			return { ok: false, code: 'rejected', message: 'informe a conversa' };
		}
		const states = await serviceChat().turnStates(id);
		if (!states.ok) {
			return { ok: false, code: states.code, message: states.message };
		}
		// Só o ciclo de vida chega à interface: nada de conteúdo.
		return {
			ok: true,
			turns: states.turns.map((turn) => ({
				turnId: turn.turnId,
				status: turn.status,
				startedAt: turn.startedAt,
				...(turn.finishedAt !== undefined ? { finishedAt: turn.finishedAt } : {}),
				...(turn.reason !== undefined ? { reason: turn.reason } : {}),
			})),
		};
	});

	ipcMain.handle(SERVICE_RENAME_CHANNEL, async (_event, payload: unknown) => {
		const input = payload as { readonly conversationId?: unknown; readonly title?: unknown } | null;
		if (typeof input?.conversationId !== 'string' || typeof input.title !== 'string') {
			return { ok: false, code: 'rejected', message: 'informe a conversa e o título' };
		}
		const renamed = await serviceChat().renameConversation(input.conversationId, input.title);
		if (!renamed.ok) {
			return { ok: false, code: renamed.code, message: renamed.message };
		}
		return { ok: true, conversation: renamed.conversation };
	});

	ipcMain.handle(SERVICE_DELETE_CHANNEL, async (_event, payload: unknown) => {
		const id = (payload as { readonly conversationId?: unknown } | null)?.conversationId;
		if (typeof id !== 'string' || id.length === 0) {
			return { ok: false, code: 'rejected', message: 'informe a conversa' };
		}
		const deleted = await serviceChat().deleteConversation(id);
		return deleted.ok ? { ok: true } : { ok: false, code: deleted.code, message: deleted.message };
	});

	ipcMain.handle(SERVICE_CREATE_CHANNEL, async (_event, payload: unknown) => {
		const input = payload as
			| { readonly providerId?: unknown; readonly title?: unknown }
			| null;
		// O ícone "nova" manda `providerId` vazio quando nada está escolhido; a
		// mensagem aqui é a que o usuário lê.
		if (typeof input?.providerId !== 'string' || input.providerId.length === 0) {
			return {
				ok: false,
				code: 'rejected',
				message: 'escolha um provedor antes de criar uma conversa',
			};
		}
		const created = await serviceChat().createConversation({
			providerId: input.providerId,
			...(typeof input.title === 'string' ? { title: input.title } : {}),
		});
		if (!created.ok) {
			return { ok: false, code: created.code, message: created.message };
		}
		return { ok: true, conversation: created.conversation };
	});

	ipcMain.handle(SERVICE_CONVERSATIONS_CHANNEL, async () => {
		const listed = await serviceChat().listConversations();
		if (!listed.ok) {
			return { ok: false, code: listed.code, message: listed.message };
		}
		return { ok: true, conversations: listed.conversations };
	});

	ipcMain.handle(SERVICE_CONVERSATION_CHANNEL, async (_event, payload: unknown) => {
		const id = (payload as { readonly conversationId?: unknown } | null)?.conversationId;
		if (typeof id !== 'string' || id.length === 0) {
			return { ok: false, code: 'rejected', message: 'informe o id da conversa' };
		}
		const opened = await serviceChat().openConversation(id);
		if (!opened.ok) {
			return { ok: false, code: opened.code, message: opened.message };
		}
		return {
			ok: true,
			conversation: opened.conversation.conversation,
			messages: opened.conversation.messages,
		};
	});

	ipcMain.handle('seshyina:service-permission', async (_event, payload: unknown) => {
		const input = payload as
			| { readonly turnId?: unknown; readonly id?: unknown; readonly decision?: unknown }
			| null;
		if (
			typeof input?.turnId !== 'string' ||
			typeof input.id !== 'string' ||
			(input.decision !== 'allow' && input.decision !== 'deny')
		) {
			return { answered: false };
		}
		return await serviceChat().answer({
			turnId: input.turnId,
			answer: { id: input.id, decision: input.decision },
		});
	});
}

/** O cliente do serviço para a raiz deste processo. */
function serviceClient(): ServiceClient {
	if (serviceLink === undefined) {
		serviceLink = new ServiceClient({
			root: rootArgument() ?? defaultDataStoreRoot(),
		});
	}
	return serviceLink;
}

/**
 * O status de modo conectado, quando o serviço está ativo e validado.
 *
 * `undefined` significa "não é deste modo": ou não há serviço, ou ele não
 * respondeu à credencial de leitura. Nesse caso o chamador decide entre o
 * modo sem dados e a recusa explicada.
 *
 * A validação é a mesma do R4A: `ServiceClient.connect()` passa pela
 * descoberta (registro + pid vivo + health autenticado) antes de ler
 * qualquer coisa. Porta aberta não basta.
 */
async function connectedStatus(rootPath: string | undefined): Promise<ServiceStatusForWindow | undefined> {
	try {
		const client = new ServiceClient({ root: rootPath ?? defaultDataStoreRoot() });
		const connected = await client.connect();
		if (!connected.ok) {
			return undefined;
		}
		return {
			state: 'connected',
			detail: `conectado ao serviço local (processo ${connected.service.pid})`,
			port: connected.service.port,
			pid: connected.service.pid,
			version: connected.service.appVersion,
			providers: connected.overview.providers.total,
			models: connected.overview.models.total,
			router: {
				mode: connected.overview.router.mode,
				enabled: connected.overview.router.enabled,
				configured: connected.overview.router.configured,
			},
		};
	} catch {
		return undefined;
	}
}

/**
 * O status de "aberto sem dados".
 *
 * Devolve sempre um estado: o chamador já decidiu que a raiz **não** está
 * tomada por outro app desktop. Se o serviço existir e tiver falhado, o
 * motivo é dele; se não existir, é "não há serviço".
 */
async function unavailableStatus(
	refusal: string | undefined,
	rootPath: string | undefined,
): Promise<ServiceStatusForWindow> {
	try {
		const client = new ServiceClient({ root: rootPath ?? defaultDataStoreRoot() });
		const status = await client.status();
		return {
			state:
				status.reason === undefined || status.reason === 'inactive' ? 'disconnected' : 'error',
			detail: status.detail,
			...(status.reason !== undefined ? { reason: status.reason } : {}),
		};
	} catch {
		return {
			state: 'error',
			detail: refusal ?? 'não foi possível consultar o serviço local',
		};
	}
}

/**
 * Abre a janela em modo conectado (ou sem dados).
 *
 * O que **não** é registrado: `registerIpc()`. Ele exige um Core montado, e
 * registrá-lo aqui seria a porta para um segundo Core. Em vez disso, os
 * canais que dependem do Core são respondidos com a mensagem de que esta
 * função precisa do modo local; os canais de serviço, a janela e as
 * configurações continuam.
 */
/**
 * Reinicia o app **em modo local**, para o modo DEV existir.
 *
 * O DEV só trabalha quando o Core é deste processo — e no modo conectado o
 * Core é do serviço. Desligar o serviço e reabrir é a única forma de trocar de
 * dono da raiz, e é o que este pedido faz, na ordem segura:
 *
 * 1. encerra pelo mecanismo existente (`/api/service/shutdown`), que solta a
 *    trava e apaga o registro — nada é morto à força;
 * 2. espera o registro sumir, para o app não reabrir encontrando um fantasma;
 * 3. marca esta abertura como "não iniciar o serviço" e reinicia.
 *
 * A marca é um arquivo de sessão (não ambiente): um `app.relaunch` herda o
 * ambiente desta execução, e usar variável de ambiente deixaria o "modo local"
 * ligado para sempre, inclusive na próxima vez que a pessoa abrisse o app.
 */
async function restartLocalForDev(root: string): Promise<{ readonly ok: boolean; readonly message?: string }> {
	const stopped = await shutdownService(root);
	if (!stopped.stopped) {
		return {
			ok: false,
			message: stopped.reason ?? 'não foi possível encerrar o serviço para abrir em modo local',
		};
	}
	try {
		await writeFile(localSessionMarker(), new Date().toISOString(), 'utf8');
	} catch (error) {
		return {
			ok: false,
			message: `o serviço foi encerrado, mas não foi possível registrar a próxima abertura: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}
	// Um instante para o registro desaparecer antes de a próxima execução
	// procurar serviço; o `shutdownService` já esperou, isto é a margem.
	await new Promise((resolve) => setTimeout(resolve, 400));
	app.relaunch();
	app.quit();
	return { ok: true };
}

/**
 * O arquivo que diz "esta é uma abertura local pedida pela pessoa".
 *
 * Lido e apagado no arranque: vale **uma** vez. Se o app cair antes de abrir,
 * a próxima tentativa continua local — que é o estado que a pessoa pediu.
 */
function localSessionMarker(): string {
	return join(app.getPath('userData'), 'next-start-local.json');
}

/** Consome a marca local. Consumir apaga: ela não sobrevive a esta abertura. */
async function consumeLocalMarker(): Promise<boolean> {
	const marker = localSessionMarker();
	try {
		const raw = await readFile(marker, 'utf8');
		await rm(marker, { force: true });
		return raw.trim().length > 0;
	} catch {
		return false;
	}
}

function openConnectedWindow(): void {
	removeMenuBar();
	registerUnavailableIpc();
	registerServiceIpc();
	registerWindowControls();
	mainWindow = createWindow();

	app.on('activate', () => {
		if (mainWindow === undefined || mainWindow.isDestroyed()) {
			mainWindow = createWindow();
		}
	});

	ipcMain.handle(OPEN_SETTINGS_CHANNEL, () => {
		presentSettingsWindow();
		return true;
	});
}

/**
 * Os canais de leitura do **estado do Core**, nos modos sem Core local.
 *
 * `getCoreStatus` responde o modo (`connected`/`unavailable`) em vez de
 * rejeitar: é o que a interface usa para dizer onde os dados estão. O objeto
 * segue a mesma forma do modo local, sem caminho de dados do serviço — o app
 * não conhece nem precisa conhecer o caminho usado por outro processo.
 */
function registerUnavailableIpc(): void {
	ipcMain.handle(CORE_STATUS_CHANNEL, (): CoreStatus => {
		const status = remoteStatus;
		return parseCoreStatus({
			appName: APP_NAME,
			version: __APP_VERSION__,
			electronVersion: process.versions.electron,
			platform: process.platform,
			services: [],
			providerCount: status?.providers ?? 0,
			dataDirectory: '',
			mode: remoteMode ?? 'unavailable',
		});
	});
	// Os canais de **leitura** que precisam do Core local respondem "não há
	// dados" em vez de lançar: a página consulta esses ao abrir, e um `throw`
	// por consulta enche o terminal de "Error occurred in handler" sem que
	// exista erro real — a ausência de Core é o estado esperado, e a
	// interface já sabe desenhar uma lista vazia.
	//
	// As **ações** continuam lançando: ali o usuário pediu algo, e precisa
	// saber que não aconteceu.
	for (const [channel, actions] of Object.entries(READ_ACTIONS)) {
		ipcMain.handle(channel, (_event, action: unknown, payload: unknown) => {
			const give = typeof action === 'string' ? actions[action] : undefined;
			if (give !== undefined) {
				// Uma leitura pode ser assíncrona (o roteador vem do serviço):
				// devolver a promessa é o que o `ipcMain.handle` já espera.
				return give();
			}
			// DEV-8.12: a gravação do roteador é a **única** ação do painel de
			// roteamento que vale sem Core local — porque a fonte dela é o
			// serviço, e a gravação vai para lá com a credencial de painel. As
			// demais ações continuam exigindo o Core deste processo.
			if (channel === ACCESS_POLICY_CHANNEL && action === 'router-set') {
				return setServiceRouterConfig(payload);
			}
			// DEV-8.15: as escritas de provedor também valem no conectado — o
			// destino é o serviço, com a credencial de painel dele. Nenhuma
			// dessas ações toca no Core local (não existe aqui).
			if (
				channel === PROVIDER_CHANNEL &&
				(action === 'save' || action === 'remove' || action === 'enabled' || action === 'role')
			) {
				return writeServiceProvider(action, payload);
			}
			// DEV-8.15: o catálogo declarado e a descoberta também são do
			// serviço no conectado.
			if (
				channel === MODEL_CATALOG_CHANNEL &&
				(action === 'save' || action === 'remove')
			) {
				return writeServiceCatalog(action, payload);
			}
			if (channel === DISCOVERY_CHANNEL && action === 'discover') {
				return discoverServiceModels(payload);
			}
			throw new Error(MODE_LOCAL_REQUIRED);
		});
	}
	for (const channel of ACTION_ONLY_CHANNELS) {
		ipcMain.handle(channel, () => {
			throw new Error(MODE_LOCAL_REQUIRED);
		});
	}
}

/** A mensagem única para uma operação que exige o modo local. */
const MODE_LOCAL_REQUIRED =
	'esta função precisa do modo local: o serviço local cuida dos dados, ' +
	'e a conversa, as ferramentas e as configurações ainda não são oferecidas por ele';

/**
 * As leituras que exigem Core, por ação, e o que responder sem ele.
 *
 * Cada valor é uma função porque as listas precisam ser **novas** a cada
 * chamada: devolver o mesmo array deixaria a interface mutá-lo de um lado e
 * ver a mudança do outro.
 */
const READ_ACTIONS: Readonly<Record<string, Readonly<Record<string, () => unknown>>>> = {
	[PROVIDER_CHANNEL]: {
		// DEV-8.15: no conectado, os provedores são os do **serviço** — a
		// fonte autoritativa. Antes aqui era `() => []`, e a interface mostrava
		// "nenhuma conexão" com provedores configurados do outro lado.
		list: () => serviceProviders(),
	},
	[MODEL_CHANNEL]: {
		// R4S: os modelos vêm do **serviço**. Aqui havia `() => []`, e o modo
		// conectado oferecia nenhum modelo mesmo com provedores configurados —
		// quem fala com os provedores é o serviço, e é ele que tem a lista.
		// Falha vira `[]` com o motivo no log: a interface já sabe desenhar
		// lista vazia, e o erro de um provedor não pode derrubar o canal.
		available: async () => {
			const result = await serviceChat().listAvailableModels();
			if (!result.ok) {
				console.warn(`[evelyn] não foi possível listar os modelos do serviço: ${result.message}`);
				return [];
			}
			return result.models;
		},
	},
	[MODEL_CATALOG_CHANNEL]: {
		// DEV-8.15: os modelos **declarados** moram no serviço. O painel de
		// Providers mostra modelos por provedor, inclusive os sem descoberta.
		list: () => serviceDeclaredModels(),
		get: (key?: unknown) => serviceDeclaredModel(key),
	},
	[DISCOVERY_CHANNEL]: {
		models: () => [],
		quotas: () => [],
		usable: () => [],
	},
	[BUDGET_CHANNEL]: {
		limits: () => [],
		alerts: () => [],
		// A página pede o relatório do período ao abrir. Sem Core, o número é
		// desconhecido — e é isso que a interface mostra.
		report: () => EMPTY_BUDGET_REPORT,
	},
	[ACCESS_POLICY_CHANNEL]: {
		// A interface lê a política ao abrir; `undefined` é recusado pelo
		// preload, então a resposta é a política padrão — que é a verdade:
		// sem Core, nenhuma política foi configurada aqui.
		get: () => DEFAULT_EMPTY_ACCESS_POLICY,
		router: () => serviceRouterView(),
		// DEV-8.15: o catálogo fundido é do serviço; é o que o painel de
		// Providers usa para listar os modelos de cada provedor.
		catalog: () => serviceMergedCatalog(),
		reports: () => [],
		history: () => [],
	},
	[SKILL_EVOLUTION_CHANNEL]: {
		versions: () => [],
	},
	[PROJECT_CHANNEL]: {
		list: () => [],
	},
	[MODEL_GUIDANCE_CHANNEL]: {
		// Sem Core, nada foi registrado — e é isso que a tela mostra.
		read: () => [],
	},
	[CONVERSATION_CHANNEL]: {
		list: () => [],
	},
};

/** A política de acesso vazia, no formato que o preload valida. */
/**
 * A política de acesso vazia, no formato que **a janela** lê (DEV-8.15).
 *
 * Separada de `DEFAULT_EMPTY_ACCESS_POLICY` (o formato do Core): a view tem o
 * `hint` que a tela mostra, e converter um no outro só para ler seria uma
 * conversão a mais para o mesmo dado.
 */
function DEFAULT_EMPTY_ACCESS_POLICY_VIEW(): AccessPolicyView {
	return {
		policy: 'any',
		priceSource: 'user',
		limitsSource: 'user',
		capabilitiesSource: 'user',
		updatedAt: new Date(0).toISOString(),
		changedBy: 'user',
		hint: 'nenhuma política gravada',
	};
}

const DEFAULT_EMPTY_ACCESS_POLICY = {
	policy: 'any',
	priceSource: 'user',
	limitsSource: 'user',
	capabilitiesSource: 'user',
	updatedAt: new Date(0).toISOString(),
	changedBy: 'user',
};

/**
 * O relatório de orçamento sem Core.
 *
 * Não é um zero: um custo zero seria uma afirmação de que nada foi gasto.
 * É `unknown` com o motivo, que é exatamente o que o Core faz quando não há
 * leitura — "sem Core" é um caso da mesma regra.
 */
const EMPTY_BUDGET_REPORT = {
	period: {
		since: new Date(0).toISOString(),
		until: new Date(0).toISOString(),
		window: 'month' as const,
	},
	total: {
		executions: 0,
		attempts: 0,
		cost: { status: 'unknown' as const, reasons: ['o Core não está neste processo'] },
		executionsWithoutCost: 0,
	},
	byProvider: [],
	byModel: [],
	byExecution: [],
	byConversation: [],
	limits: [],
	alerts: [],
};

/**
 * A configuração do roteador sem Core.
 *
 * `configured: false` diz a verdade — este processo não leu configuração
 * nenhuma. A do serviço está lá; ela é uma fase seguinte.
 */
const EMPTY_ROUTER_VIEW = {
	mode: 'native' as const,
	enabled: true,
	updatedAt: new Date(0).toISOString(),
	configured: false,
};

/**
 * O catálogo **fundido** do serviço (DEV-8.15), no formato que a janela lê.
 *
 * `GET /api/models/catalog` devolve `models` (fundido) e `policy`, que é o
 * mesmo par que `listMergedCatalog` entrega no modo local. A política vem do
 * serviço; se a leitura falhar, a política padrão é devolvida com a lista vazia
 * e o motivo vai para o log.
 */
async function serviceMergedCatalog(providerId?: unknown): Promise<{
	readonly policy: AccessPolicyView;
	readonly models: readonly MergedModelView[];
}> {
	const queried = await serviceClient().declaredCatalog();
	if (!queried.ok) {
		console.warn(`[evelyn] não foi possível ler o catálogo do serviço: ${queried.message}`);
		return { policy: DEFAULT_EMPTY_ACCESS_POLICY_VIEW(), models: [] };
	}
	const body = queried.value as unknown as {
		readonly models?: readonly MergedModelView[];
		readonly policy?: AccessPolicyView;
		readonly declared?: readonly { providerId?: string; modelId?: string; updatedAt?: string }[];
	};
	const fundido = Array.isArray(body.models) ? body.models : [];
	const declarados = Array.isArray((body as { declared?: unknown }).declared)
		? (body as { declared: readonly { providerId?: string; modelId?: string; updatedAt?: string }[] }).declared
		: [];
	// DEV-8.15: o fundido do Core só inclui um modelo que o endpoint publicou.
	// Um modelo digitado à mão — e um provedor recém-cadastrado, sem descoberta
	// — não apareceriam. A entrada declarada entra como o que ela é: o modelo
	// que o usuário gravou, sem preço, acesso ou limite inventados.
	const vistos = new Set(fundido.map((entry) => `${entry.providerId}:${entry.modelId}`));
	const extras: MergedModelView[] = [];
	for (const entry of declarados) {
		if (typeof entry.providerId !== 'string' || typeof entry.modelId !== 'string') {
			continue;
		}
		const key = `${entry.providerId}:${entry.modelId}`;
		if (vistos.has(key)) {
			continue;
		}
		vistos.add(key);
		extras.push({
			providerId: entry.providerId,
			modelId: entry.modelId,
			// `listed: false` é a verdade: o `/models` do endpoint nunca publicou
			// este modelo — quem o informou foi o usuário. O resto fica ausente e
			// a interface desenha "desconhecido"; nada é inventado.
			listed: false,
			updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : new Date(0).toISOString(),
			policyStatus: { policy: 'any', eligible: true },
		} as unknown as MergedModelView);
	}
	const models = [...fundido, ...extras].filter(
		(entry) =>
			typeof (entry as { providerId?: unknown }).providerId === 'string' &&
			(typeof providerId !== 'string' || (entry as { providerId: string }).providerId === providerId),
	);
	return {
		policy: body.policy ?? DEFAULT_EMPTY_ACCESS_POLICY_VIEW(),
		models,
	};
}

/**
 * Os provedores do **serviço**, para a interface (DEV-8.15).
 *
 * Falha vira uma lista vazia no canal de leitura (a interface desenha vazio) e
 * o motivo vai para o log — o mesmo critério de `models.available`. A chave
 * nunca esteve nesse corpo: `hasApiKeyRef` é um booleano.
 */
async function serviceProviders(): Promise<readonly ProviderSummary[]> {
	const queried = await serviceClient().providers();
	if (!queried.ok) {
		console.warn(`[evelyn] não foi possível listar os provedores do serviço: ${queried.message}`);
		return [];
	}
	return queried.value.providers;
}

/**
 * Uma escrita de provedor no serviço (DEV-8.15).
 *
 * O corpo é saneado aqui como no handler local — só campos conhecidos
 * atravessam —, e a gravação usa a credencial de painel do registro. A
 * resposta é o resumo que o serviço gravou, nunca a chave.
 */
async function writeServiceProvider(
	action: 'save' | 'remove' | 'enabled' | 'role',
	payload: unknown,
): Promise<ProviderSummary | boolean> {
	// `remove` chega como **string** (o id, como no handler local); os demais
	// como objeto. O contrato da ponte é a fonte disso, não uma suposição.
	if (action === 'remove') {
		const providerId = typeof payload === 'string' ? payload : '';
		if (providerId.length === 0) {
			throw new Error('providerId must be a non-empty string');
		}
		const result = await serviceClient().providerWrite('remove', { providerId });
		if (!result.ok) {
			throw new Error(result.message);
		}
		return result.value.removed === true;
	}
	if (typeof payload !== 'object' || payload === null) {
		throw new Error('provider write requires an object');
	}
	const input = payload as Record<string, unknown>;
	if (action === 'role') {
		const providerId = typeof input['providerId'] === 'string' ? input['providerId'] : '';
		const role = input['role'];
		if (providerId.length === 0 || (role !== 'router' && role !== 'provider')) {
			throw new Error('esperado { providerId, role }');
		}
		const result = await serviceClient().providerWrite('role', { providerId, role });
		if (!result.ok) {
			throw new Error(result.message);
		}
		if (result.value.provider === undefined) {
			throw new Error('o serviço não devolveu o provedor gravado');
		}
		return result.value.provider;
	}
	if (action === 'enabled') {
		const providerId = typeof input['providerId'] === 'string' ? input['providerId'] : '';
		if (providerId.length === 0 || typeof input['enabled'] !== 'boolean') {
			throw new Error('esperado { providerId, enabled }');
		}
		const result = await serviceClient().providerWrite('enabled', {
			providerId,
			enabled: input['enabled'],
		});
		if (!result.ok) {
			throw new Error(result.message);
		}
		if (result.value.provider === undefined) {
			throw new Error('o serviço não devolveu o provedor gravado');
		}
		return result.value.provider;
	}
	const body: Record<string, unknown> = {};
	for (const key of ['id', 'name', 'baseUrl', 'apiKey'] as const) {
		if (typeof input[key] === 'string') {
			body[key] = input[key];
		}
	}
	if (typeof body['baseUrl'] !== 'string' || (body['baseUrl'] as string).trim().length === 0) {
		throw new Error('baseUrl must be a non-empty string');
	}
	const result = await serviceClient().providerWrite('save', body);
	if (!result.ok) {
		throw new Error(result.message);
	}
	if (result.value.provider === undefined) {
		throw new Error('o serviço não devolveu o provedor gravado');
	}
	return result.value.provider;
}

/**
 * Grava a configuração do roteador no **serviço** (DEV-8.12).
 *
 * O desktop conectado é uma interface de gerenciamento: a fonte continua
 * sendo o Core do serviço. O caminho é o endpoint existente
 * (`POST /api/routing/save`), com a credencial de **painel** do registro — a
 * de leitura não serve para escrita e o servidor recusa se ela for usada.
 *
 * O corpo é saneado aqui como no handler local: só os quatro campos
 * conhecidos atravessam. Depois de gravar, a decisão é **relida** do serviço:
 * a resposta ao renderer é o que ficou gravado, não o que foi pedido.
 */
async function setServiceRouterConfig(payload: unknown): Promise<RouterConfigView> {
	if (typeof payload !== 'object' || payload === null) {
		throw new Error('router-set requires an object');
	}
	const input = payload as {
		mode?: unknown;
		enabled?: unknown;
		externalRouterProviderId?: unknown;
		directProviderId?: unknown;
	};
	const saved = await serviceClient().saveRouting({
		...(input.mode === 'native' || input.mode === 'external' || input.mode === 'direct'
			? { mode: input.mode }
			: {}),
		...(typeof input.enabled === 'boolean' ? { enabled: input.enabled } : {}),
		...(typeof input.externalRouterProviderId === 'string'
			? { externalRouterProviderId: input.externalRouterProviderId }
			: {}),
		...(typeof input.directProviderId === 'string'
			? { directProviderId: input.directProviderId }
			: {}),
	});
	if (!saved.ok) {
		// A gravação não aconteceu. O erro sobe com o motivo do serviço — é o
		// que a interface mostra ao lado do formulário.
		throw new Error(saved.message);
	}
 	const view = await serviceRouterView();
	broadcastRouterState(view);
	return view;
}

/**
 * Os modelos **declarados** no serviço (DEV-8.15).
 *
 * Lidos de `GET /api/models/catalog`, que já existia: o painel usa a mesma
 * lista que a página do serviço mostra.
 */
async function serviceDeclaredModels(): Promise<readonly unknown[]> {
	const queried = await serviceClient().declaredCatalog();
	if (!queried.ok) {
		console.warn(`[evelyn] não foi possível ler o catálogo do serviço: ${queried.message}`);
		return [];
	}
	const body = queried.value.declared;
	return Array.isArray(body) ? body : [];
}

/** Um modelo declarado, pelo par provedor + modelo. */
async function serviceDeclaredModel(key: unknown): Promise<unknown> {
	if (typeof key !== 'object' || key === null) {
		return undefined;
	}
	const { providerId, modelId } = key as { providerId?: unknown; modelId?: unknown };
	if (typeof providerId !== 'string' || typeof modelId !== 'string') {
		return undefined;
	}
	const declared = await serviceDeclaredModels();
	return (declared as { providerId?: string; modelId?: string }[]).find(
		(entry) => entry.providerId === providerId && entry.modelId === modelId,
	);
}

/**
 * Grava ou remove um modelo declarado **no serviço** (DEV-8.15).
 *
 * Só `providerId`, `modelId` e os campos do catálogo atravessam; o serviço
 * valida com o parser do Core e devolve o que ficou gravado.
 */
async function writeServiceCatalog(
	action: 'save' | 'remove',
	payload: unknown,
): Promise<unknown> {
	if (typeof payload !== 'object' || payload === null) {
		throw new Error('model catalog write requires an object');
	}
	const input = payload as Record<string, unknown>;
	const body: Record<string, unknown> = {};
	if (action === 'remove') {
		for (const key of ['providerId', 'modelId'] as const) {
			if (typeof input[key] === 'string') {
				body[key] = input[key];
			}
		}
	} else {
		// Só os campos do contrato do catálogo; nada de objetos arbitrários.
		for (const key of [
			'providerId',
			'modelId',
			'model',
			'notes',
			'access',
		] as const) {
			if (typeof input[key] === 'string') {
				body[key] = input[key];
			}
		}
		for (const key of ['capabilities', 'pricing', 'limits'] as const) {
			if (input[key] !== undefined) {
				body[key] = input[key];
			}
		}
	}
	const result = await serviceClient().catalogWrite(action, body);
	if (!result.ok) {
		throw new Error(result.message);
	}
	return action === 'remove' ? result.value.removed === true : await serviceDeclaredModel(body);
}

/** Pede ao serviço que descubra modelos pelo `/models` do provedor. */
async function discoverServiceModels(payload: unknown): Promise<unknown> {
	const providerId =
		typeof payload === 'string'
			? payload
			: typeof payload === 'object' && payload !== null && typeof (payload as { providerId?: unknown }).providerId === 'string'
				? (payload as { providerId: string }).providerId
				: '';
	if (providerId.length === 0) {
		throw new Error('informe o provedor para descobrir modelos');
	}
	const result = await serviceClient().discoverModels(providerId);
	if (!result.ok) {
		throw new Error(result.message);
	}
	// O serviço publica `outcomes`; o cliente já os resume em `failed`. O
	// canal devolve o mesmo formato que o Core local, para a página ter uma
	// regra só.
	return {
		models: [...result.value.models],
		...(result.value.failed !== undefined ? { failed: result.value.failed } : {}),
	};
}

/**
 * A configuração do roteador **do serviço**, para o modo conectado (DEV-8.11).
 *
 * O desktop conectado não monta Core: quem executa o turno é o serviço, e a
 * decisão que vale é a dele. Antes, aqui havia uma constante neutra
 * (`EMPTY_ROUTER_VIEW`) apresentada como se fosse a configuração real — a
 * interface mostrava "nativo/ligado" enquanto o serviço podia estar em
 * `external`. Agora a decisão vem de `GET /api/routing`, pelo cliente que já
 * usa o token de **leitura** do registro do serviço.
 *
 * - Sem serviço ativo: `source: 'unavailable'` com o motivo. Nunca um estado
 *   que pareça configurado;
 * - Serviço ativo mas leitura falhou: idem, com a mensagem do cliente (que
 *   não carrega credencial nem caminho);
 * - `targets` do serviço (nomes e URLs de destino) fica de fora: o seletor do
 *   chat precisa do modo, não do catálogo de destinos.
 */
async function serviceRouterView(): Promise<RouterConfigView> {
	const queried = await serviceClient().routing();
	if (!queried.ok) {
		return {
			...EMPTY_ROUTER_VIEW,
			source: 'unavailable',
			reason: queried.message,
		};
	}
	const config = queried.value;
	return {
		mode: config.mode,
		enabled: config.enabled,
		updatedAt: config.updatedAt,
		configured: config.configured,
		source: 'service',
		...(config.externalRouterProviderId !== undefined
			? { externalRouterProviderId: config.externalRouterProviderId }
			: {}),
		...(config.directProviderId !== undefined ? { directProviderId: config.directProviderId } : {}),
		...(config.unreadable !== undefined ? { unreadable: config.unreadable } : {}),
	};
}

/**
 * Os canais que exigem o Core e que **agem**, sem ação de leitura.
 *
 * É a razão pela qual o modo conectado ainda não faz uma conversa: cada um
 * precisa de um endpoint no serviço, e isso é a fase seguinte.
 */
const ACTION_ONLY_CHANNELS = [
	SEND_MESSAGE_CHANNEL,
	PERMISSION_DECISION_CHANNEL,
	STOP_CHANNEL,
] as const;


/** Registers a listener for a window going away. */
function registerWindowClosed(listener: () => void): void {
	windowClosedListeners.push(listener);
}

 	function registerIpc(): void {
		const desktop = requireCore(core);
		const chat = requireChat(core);
		const evolution = requireEvolution(core);

		ipcMain.handle(CORE_STATUS_CHANNEL, () => desktop.status(process.versions.electron));
	ipcMain.handle(PROVIDER_CHANNEL, async (_event, action: unknown, payload: unknown) => {
		switch (action) {
			case 'list':
				return chat.listProviders();
			case 'save':
				return chat.saveProvider(parseSaveProviderInput(payload));
			case 'remove':
				return chat.removeProvider(parseProviderId(payload));
			case 'role': {
				if (typeof payload !== 'object' || payload === null) {
					throw new Error('the provider role needs a provider id and a role');
				}
				const input = payload as { providerId?: unknown; role?: unknown };
				if (typeof input.providerId !== 'string' || input.providerId.length === 0) {
					throw new Error('the provider role needs a provider id');
				}
				if (input.role !== 'router' && input.role !== 'provider') {
					throw new Error('the provider role must be router or provider');
				}
				return chat.setProviderRole(input.providerId, input.role);
			}
			case 'enabled': {
				if (typeof payload !== 'object' || payload === null) {
					throw new Error('the provider state needs a provider id and a flag');
				}
				const input = payload as { providerId?: unknown; enabled?: unknown };
				if (typeof input.providerId !== 'string' || input.providerId.length === 0) {
					throw new Error('the provider state needs a provider id');
				}
				if (typeof input.enabled !== 'boolean') {
					throw new Error('the provider state needs a boolean');
				}
				return chat.setProviderEnabled(input.providerId, input.enabled);
			}
			case 'models':
				return chat.listModels(parseProviderId(payload));
			default:
				throw new Error(`Unknown provider action ${JSON.stringify(action)}`);
		}
	});

	ipcMain.handle(MODEL_CHANNEL, async (_event, action: unknown, _payload: unknown) => {
		switch (action) {
			case 'available':
				return chat.listAvailableModels();
			default:
				throw new Error(`Unknown model action ${JSON.stringify(action)}`);
		}
	});

	ipcMain.handle(MODEL_CATALOG_CHANNEL, async (_event, action: unknown, payload: unknown) => {
		switch (action) {
			case 'list':
				// An absent or blank providerId means "every provider", which is
				// what the settings window wants; the session reads the empty string
				// as the same thing.
				return chat.listModelCatalog(
					typeof payload === 'string' && payload.length > 0 ? payload : undefined,
				);
			case 'get':
				return chat.getModelCatalogEntry(parseModelCatalogKey(payload));
			case 'save':
				return chat.saveModelCatalogEntry(parseSaveModelCatalogInput(payload));
			case 'remove':
				return chat.removeModelCatalogEntry(parseModelCatalogKey(payload));
			default:
				throw new Error(`Unknown model catalog action ${JSON.stringify(action)}`);
		}
	});

	ipcMain.handle(DISCOVERY_CHANNEL, async (_event, action: unknown, payload: unknown) => {
		switch (action) {
			case 'models':
				return chat.listDiscoveredModels(
					typeof payload === 'string' && payload.length > 0 ? payload : undefined,
				);
			case 'quotas':
				return chat.listDiscoveredQuotas(
					typeof payload === 'string' && payload.length > 0 ? payload : undefined,
				);
			case 'usable':
				return chat.listUsableModels({ onlyFree: payload === true });
			case 'discover':
				// DEV-8.15: pergunta ao `/models` do provedor e grava o que veio.
				return await chat.discoverModels(
					typeof payload === 'string' && payload.length > 0 ? payload : undefined,
				);
			default:
				throw new Error(`Unknown discovery action ${JSON.stringify(action)}`);
		}
	});

	ipcMain.handle(ACCESS_POLICY_CHANNEL, async (_event, action: unknown, payload: unknown) => {
		switch (action) {
			case 'get':
				return toAccessPolicyView(await chat.loadAccessPolicy());
			case 'set':
				if (typeof payload !== 'object' || payload === null) {
					throw new Error('setAccessPolicy requires an object');
				}
				return toAccessPolicyView(await chat.saveAccessPolicy(payload as Parameters<typeof chat.saveAccessPolicy>[0]));
			case 'catalog':
				return chat.listMergedCatalog(typeof payload === 'string' && payload.length > 0 ? payload : undefined);
			case 'reports':
				return chat.listDecisionReports(typeof payload === 'number' ? payload : 20);
			case 'router':
				// A leitura não leva payload: o que se quer saber é o estado
				// gravado, e nada mais.
				return chat.readRouterConfig();
			case 'router-set': {
				if (typeof payload !== 'object' || payload === null) {
					throw new Error('router-set requires an object');
				}
				const input = payload as {
					mode?: unknown;
					enabled?: unknown;
					externalRouterProviderId?: unknown;
					directProviderId?: unknown;
				};
				const saved = await chat.changeRouterConfig({
					...(input.mode === 'native' || input.mode === 'external' || input.mode === 'direct'
						? { mode: input.mode }
						: {}),
					...(typeof input.enabled === 'boolean' ? { enabled: input.enabled } : {}),
					...(typeof input.externalRouterProviderId === 'string'
						? { externalRouterProviderId: input.externalRouterProviderId }
						: {}),
					...(typeof input.directProviderId === 'string'
						? { directProviderId: input.directProviderId }
						: {}),
				});
				// O aviso vai para as duas janelas, e só depois de a gravação:
				// quem receber mostra o estado que está gravado, e uma mudança
				// recusada não chega a ninguém.
				broadcastRouterState(saved);
				return saved;
			}
			case 'history':
				return chat.listExecutionHistory(typeof payload === 'number' ? payload : 20);
			case 'compare': {
				if (typeof payload !== 'object' || payload === null || !Array.isArray((payload as { ids?: unknown }).ids)) {
					throw new Error('compare requires two execution ids');
				}
				const ids = (payload as { ids: unknown[] }).ids;
				const [first, second] = ids;
				if (typeof first !== 'string' || typeof second !== 'string') {
					throw new Error('compare requires two execution ids');
				}
				return chat.compareExecutions(first, second);
			}
			default:
				throw new Error(`Unknown access policy action ${JSON.stringify(action)}`);
		}
	});

	ipcMain.handle(BUDGET_CHANNEL, async (_event, action: unknown, payload: unknown) => {
		switch (action) {
			case 'limits':
				return chat.listSpendingLimits();
			case 'save':
				return chat.saveSpendingLimit(parseSaveSpendingLimitViewInput(payload));
			case 'remove':
				return chat.removeSpendingLimit(parseSpendingLimitId(payload));
			case 'report':
				return chat.readBudget(parseBudgetWindow(payload));
			case 'forecast':
				return chat.forecastCall(parseForecastRequestView(payload));
			case 'alerts':
				return chat.listBudgetAlerts();
			default:
				throw new Error(`Unknown budget action ${JSON.stringify(action)}`);
		}
	});

	/**
	 * Skill evolution.
	 *
	 * Every action here is a decision about what the agent knows, and every one
	 * is a separate call on purpose. `approve` records a decision and changes
	 * nothing live; `activate` is the only verb that writes a skill, and it
	 * refuses a proposal the user never approved. Keeping them apart is what
	 * stops a single mis-click from rewriting a skill, and it is why there is no
	 * combined "approve and activate" verb to reach for later.
	 */
	ipcMain.handle(SKILL_EVOLUTION_CHANNEL, async (_event, action: unknown, payload: unknown) => {
		switch (action) {
			case 'scan':
				// Reads and reports. Nothing is stored, no skill is touched, and no
				// proposal is filed here — filing is the next verb, on purpose.
				return desktop.scanSkillHistory();
			case 'propose': {
				const input = parseSaveSkillImprovementInput(payload);
				const scan = await scanForSkillImprovements(requireLearningHistory(desktop));
				const opportunity =
					scan.ok
						? scan.opportunities.find((found) => found.fingerprint === input.fingerprint)
						: undefined;
				if (opportunity === undefined) {
					// A proposal has to be anchored to something the scan actually
					// found. Without that link the stored record would claim evidence
					// nobody can check.
					throw new Error(
						`no scanned opportunity has fingerprint "${input.fingerprint}"; run the analysis again`,
					);
				}
				const created = await evolution.createProposal({
					opportunity,
					proposed: {
						title: input.title,
						description: input.description,
						instructions: input.instructions,
						tags: input.tags,
						requiredTools: input.requiredTools,
						riskLevel: input.riskLevel,
						constraints: input.constraints,
					},
					...(input.proposedVersion !== undefined ? { proposedVersion: input.proposedVersion } : {}),
					expectedBenefits: input.expectedBenefits,
					risks: input.risks,
					validationCriteria: input.validationCriteria,
				});
				if (!created.ok || created.proposal === undefined) {
					throw new Error(created.error ?? 'a proposta não pôde ser registrada');
				}
				return created.proposal;
			}
			case 'list': {
				const status = payload === undefined ? undefined : parseSkillProposalStatus(payload);
				const result = await evolution.listProposals(status);
				if (!result.ok) {
					throw new Error(result.error ?? 'the proposals could not be read');
				}
				return result.proposals;
			}
			case 'get': {
				const result = await evolution.getProposal(parseSkillProposalId(payload));
				if (!result.ok || result.proposal === undefined) {
					throw new Error(result.error ?? 'the proposal could not be read');
				}
				return result.proposal;
			}
			case 'compare': {
				const result = await evolution.compareProposal(parseSkillProposalId(payload));
				if (!result.ok || result.diff === undefined) {
					throw new Error(result.error ?? 'the proposal could not be compared');
				}
				return result.diff;
			}
			case 'approve': {
				const { proposalId, reason } = readDecisionPayload(payload);
				const result = await evolution.approveProposal(proposalId, {
					decidedBy: 'the user',
					reason,
				});
				if (!result.ok || result.proposal === undefined) {
					throw new Error(result.error ?? 'the proposal could not be approved');
				}
				return result.proposal;
			}
			case 'reject': {
				const { proposalId, reason } = readDecisionPayload(payload);
				const result = await evolution.rejectProposal(proposalId, {
					decidedBy: 'the user',
					reason,
				});
				if (!result.ok || result.proposal === undefined) {
					throw new Error(result.error ?? 'the proposal could not be rejected');
				}
				return result.proposal;
			}
			case 'activate': {
				const result = await evolution.activateProposal(parseSkillProposalId(payload));
				// A refusal is a normal outcome here, not a crash: the UI shows the
				// reason ("still pending your approval") beside the button rather
				// than as a dead dialog with an error nobody asked for.
				return {
					ok: result.ok,
					...(result.error !== undefined ? { error: result.error } : {}),
					...(result.skill !== undefined
						? {
								skillId: result.skill.id,
								version: result.skill.version,
								instructionsLength: result.skill.instructions.length,
							}
						: {}),
				};
			}
			case 'versions': {
				const result = await evolution.listVersions(parseProviderId(payload));
				if (!result.ok) {
					throw new Error(result.error ?? 'the versions could not be read');
				}
				return result.versions;
			}
			case 'rollback': {
				const { skillId, versionId, reason } = readRollbackPayload(payload);
				const result = await evolution.rollbackToVersion(skillId, versionId, reason);
				return {
					ok: result.ok,
					...(result.error !== undefined ? { error: result.error } : {}),
					...(result.skill !== undefined
						? {
								skillId: result.skill.id,
								version: result.skill.version,
								instructionsLength: result.skill.instructions.length,
							}
						: {}),
				};
			}
			default:
				throw new Error(`Unknown skill evolution action ${JSON.stringify(action)}`);
		}
	});


	ipcMain.handle(PROJECT_CHANNEL, async (_event, action: unknown, payload: unknown) => {
		switch (action) {
			case 'list':
				return chat.listProjects();
			case 'create':
				return chat.createProject(parseCreateProjectInput(payload));
			default:
				throw new Error(`Unknown project action ${JSON.stringify(action)}`);
		}
	});

	ipcMain.handle(CONVERSATION_CHANNEL, async (_event, action: unknown, payload: unknown) => {
		switch (action) {
			case 'create':
				return chat.createConversation(parseCreateConversationInput(payload));
			case 'list':
				// No provider filter: a conversation is a transcript, and the
				// provider is chosen per turn. Filtering here is what made
				// switching models swap the conversation list.
				return chat.listConversations();
			case 'open':
				return chat.openConversation(parseConversationId(payload));
			case 'rename':
				return chat.renameConversation(
					parseConversationId(asObject(payload).id),
					parseConversationTitle(asObject(payload).title),
				);
			case 'system-prompt':
				return chat.setSystemPrompt(
					parseConversationId(asObject(payload).id),
					parseSystemPrompt(asObject(payload).content),
				);
			case 'delete':
				// R4M: `absent` é sucesso (já não havia nada a excluir — o
				// estado que o pedido queria); `unknown` é falha, e a interface
				// mostra o erro em vez de sumir com a conversa da lista.
				return (await deleteForDesktop(chat, parseConversationId(payload))).deleted;
			case 'pin': {
				const input = asObject(payload);
				if (typeof input.pinned !== 'boolean') {
					throw new Error('a marcação de permanente precisa de um booleano');
				}
				return chat.setConversationPinned(
					parseConversationId(input.id),
					input.pinned,
				);
			}
			case 'reset':
				// Limpa as mensagens e mantém a conversa. Vale para a permanente:
				// ela não pode ser apagada, mas precisa poder ser reiniciada.
				return chat.resetConversation(parseConversationId(payload));
			default:
				throw new Error(`Unknown conversation action ${JSON.stringify(action)}`);
		}
	});

	/**
	 * Grava as preferências de modelo escritas no diálogo fixo.
	 *
	 * O texto é interpretado aqui, e não na janela: o que o motor ao lado lê é
	 * o que este processo decidiu, e a janela não ganha um caminho para escrever
	 * qualquer coisa no arquivo que decide a seleção.
	 */
	ipcMain.handle(MODEL_GUIDANCE_CHANNEL, async (_event, payload: unknown) => {
		// Duas formas no mesmo canal: `'read'` sem corpo devolve a lista em
		// vigor; qualquer outra coisa é uma gravação.
		if (payload === 'read') {
			const recorded = await chat.readRecordedModelGuidance();
			return recorded?.entries ?? [];
		}
		const input = asObject(payload);
		const conversationId = parseConversationId(input.id);
		const text = typeof input.text === 'string' ? input.text : '';
		return chat.recordModelGuidance(conversationId, text);
	});

	ipcMain.handle(SEND_MESSAGE_CHANNEL, async (_event, payload: unknown) =>
		chat.sendMessage(parseSendMessageInput(payload), (event) => emitToWindows(event)),
	);

	ipcMain.handle(PERMISSION_DECISION_CHANNEL, (_event, payload: unknown) =>
		// Narrowed first. Whatever the renderer claims, the broker only ever sees
		// a well-formed `{ id, decision }`, and an unknown id resolves nothing —
		// which is the answer a stale dialog needs.
		chat.answerPermission(parsePermissionAnswer(payload)),
	);

	ipcMain.handle(STOP_CHANNEL, () => chat.stop());

	// A dialog outliving its window would leave a tool blocked forever on an
	// answer nobody can give. Closing is therefore a denial: `cancelAll` settles
	// each open request as `deny`, the runtime reads that as a normal denied tool
	// result, and the model can carry on without it.
	app.on('before-quit', () => chat.denyOpenPermissions('the app is closing'));
	registerWindowClosed(() => chat.denyOpenPermissions('the window was closed'));
	}

/**
 * A resize drag in progress.
 *
 * The window's bounds and the pointer's position are captured once, on
 * `resize-start`, and every subsequent move is a delta from that same snapshot.
 * Re-reading `getBounds()` on each move instead would compound the clamping: a
 * drag past the minimum size would ratchet narrower with every frame it spent
 * outside the limit, and the window would never come back.
 */
interface ResizeDrag {
	readonly direction: ResizeDirection;
	readonly origin: Rectangle;
	readonly pointer: { readonly x: number; readonly y: number };
}

/** The drag in progress, if any. Module state: there is only ever one window. */
let activeResize: ResizeDrag | undefined;

/**
 * Applies one pointer position to the drag in progress.
 *
 * Each direction moves the window's leading boundaries. A west or north edge
 * moves the *origin* as well as the size, because growing that way extends the
 * window leftwards and upwards rather than only making it bigger.
 *
 * The minimum size is enforced on both axes independently of the direction, so a
 * north-west drag that runs out of height first keeps its width rather than
 * snapping the whole window to a square.
 */
function applyResize(window: BrowserWindow, x: number, y: number): void {
	const drag = activeResize;
	if (drag === undefined || window.isMaximized() || window.isMinimized()) {
		return;
	}

	const { origin } = drag;
	const dx = x - drag.pointer.x;
	const dy = y - drag.pointer.y;
	const minWidth = window.getMinimumSize()[0];
	const minHeight = window.getMinimumSize()[1];
	const direction = drag.direction;

	let left = origin.x;
	let top = origin.y;
	let width = origin.width;
	let height = origin.height;

	if (direction.includes('e')) {
		width = Math.max(minWidth, origin.width + dx);
	} else if (direction.includes('w')) {
		// Growing west means the left edge moves left, so the width grows by the
		// same amount while the origin moves against it. `minWidth` clamps the
		// width, and the origin is then pulled back so the two cannot disagree.
		width = Math.max(minWidth, origin.width - dx);
		left = origin.x + (origin.width - width);
	}

	if (direction.includes('s')) {
		height = Math.max(minHeight, origin.height + dy);
	} else if (direction.includes('n')) {
		height = Math.max(minHeight, origin.height - dy);
		top = origin.y + (origin.height - height);
	}

	window.setBounds({ x: left, y: top, width, height });
}

/**
 * The window controls and the resize drag.
 *
 * Registered once, against the single window this app has. Every action is
 * guarded against a missing window: a click can outlive the window it was aimed
 * at, and an IPC handler that dereferences `null` fails the turn it belongs to.
 */
function registerWindowControls(): void {
	/*
	 * The window a message came from, or null.
	 *
	 * `BrowserWindow.fromWebContents(event.sender)`, never the module-level
	 * `mainWindow`. There are two windows now, and resolving to the chat one
	 * meant the settings window's own controls acted on the wrong window: its
	 * close button closed the chat window and left itself open. Deriving the
	 * window from the sender is also what makes a handler correct by
	 * construction rather than by knowing which window happens to be focused.
	 */
	const sender = (event: IpcMainInvokeEvent): BrowserWindow | null => {
		// `null`, not `undefined`, when the contents have no window.
		const window = BrowserWindow.fromWebContents(event.sender);
		return window !== null && !window.isDestroyed() ? window : null;
	};

	ipcMain.handle(WINDOW_CHANNEL, (event, action: unknown, payload: unknown) => {
		const window = sender(event);
		if (window === null) {
			return action === 'toggle-maximize' ? { maximized: false } : false;
		}

		switch (action) {
			case 'minimize':
				window.minimize();
				return true;
			case 'toggle-maximize': {
				// A maximised window cannot be resized, and the renderer needs to
				// know it is maximised so it can stop sending moves at all.
				if (window.isMaximized()) {
					window.unmaximize();
				} else {
					window.maximize();
				}
				return { maximized: window.isMaximized() };
			}
			case 'close':
				window.close();
				return true;
			case 'resize-start': {
				const direction = parseResizeDirection(payload);
				// Refused while maximised: the bounds are the screen's, and
				// resizing from them would drag the window off the display instead
				// of resizing anything.
				if (window.isMaximized() || window.isMinimized()) {
					activeResize = undefined;
					return false;
				}
				const point = screen.getCursorScreenPoint();
				activeResize = {
					direction,
					origin: window.getBounds(),
					pointer: { x: point.x, y: point.y },
				};
				return true;
			}
			case 'resize-move': {
				if (activeResize === undefined || !isPoint(payload)) {
					return false;
				}
				applyResize(window, parseCoordinate(payload.x), parseCoordinate(payload.y));
				return true;
			}
			case 'resize-end':
				activeResize = undefined;
				return true;
			default:
				throw new Error(`Unknown window action ${JSON.stringify(action)}`);
		}
	});

	}

/**
 * Pushes a window's maximize state to its own renderer.
 *
 * Bound per window rather than to `app`, which has no maximize events, and to
 * the window's own `webContents` rather than to a global one — a handler shared
 * between the two windows would tell the settings window that the chat window
 * had been maximized.
 *
 * The renderer cannot work this out alone: it has no frame to read, and its
 * button knows only what it last asked for. Both directions are pushed, so a
 * restore triggered by the OS rather than by the button updates the glyph too.
 */
function pushWindowState(window: BrowserWindow): void {
	const send = (): void => {
		// The webContents check is separate from the window's: they are torn down
		// in that order, so a window can still answer `isDestroyed()` with false
		// while its contents are already gone.
		if (window.isDestroyed() || window.webContents.isDestroyed()) {
			return;
		}
		window.webContents.send(WINDOW_STATE_CHANNEL, { maximized: window.isMaximized() });
	};
	window.on('maximize', send);
	window.on('unmaximize', send);
	// And once the page is up. The settings window maximises itself before it is
	// shown, so that `maximize` fires before the renderer has subscribed and the
	// glyph would otherwise be drawn from its un-maximised default until the user
	// happened to restore and maximise again.
	window.webContents.on('did-finish-load', send);
}

/** Narrows the `{ x, y }` the renderer sent for a resize move. */
function isPoint(value: unknown): value is { x: unknown; y: unknown } {
	return typeof value === 'object' && value !== null;
}

/**
 * Reads a payload that carries two fields.
 *
 * `rename` and `system-prompt` send `{ id, … }`, and each field is validated on
 * its own below. Reading the object first keeps the handler from reaching into
 * a payload that is not even an object.
 */
function asObject(value: unknown): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error('This action expects an object payload');
	}
	return value as Record<string, unknown>;
}

/**
 * Removes the default menu bar.
 *
 * Electron installs a `File / Edit / View / Window` menu on Windows unless an
 * application says otherwise, and most of it acts on a menu the app does not
 * have: there are no documents to open or save, and `View`'s toggles belong to
 * a developer tools window that this app never opens. It also costs vertical
 * space the conversation wants.
 *
 * Passing `null` removes it outright rather than hiding it. `autoHideMenuBar`
 * would leave the entries reachable behind a hidden strip, and the same menu
 * would come back on Alt — an app with one window and one transcript has
 * nothing to offer there.
 *
 * A side effect worth naming: with no menu, Ctrl+C / Ctrl+V stop arriving as
 * Edit-menu commands. They are handled by Chromium itself here, so they still
 * work — but the app's own key bindings, which the renderer owns, are unaffected
 * either way.
 */
function removeMenuBar(): void {
	Menu.setApplicationMenu(null);
}

/**
 * The settings window.
 *
 * A second window loading the *same* renderer bundle rather than a second page
 * of its own. The settings form and the main window share the provider
 * validation, the key handling and the conversation calls; a separate bundle
 * would mean either duplicating that or splitting it across two entry points
 * that then have to be kept in step. The page reads the window's role from its
 * URL and renders one layout or the other.
 *
 * Single-instance: a settings window is a form, and two of them editing one
 * provider config would be two answers to one question. A second request
 * reuses the window that is already open — bringing it back if it was
 * minimised, and raising it if something else was in front.
 */
let settingsWindow: BrowserWindow | undefined;

/**
 * Brings the settings window to the user, creating it when it is not there.
 *
 * The reuse is the whole point: the window is created hidden and shown when
 * the page is ready, so a request that arrives later finds a window that may
 * be minimised, hidden, or behind another window. `focus()` alone does
 * nothing for the first two, and the click on "Configurar" would look like
 * it had been ignored.
 *
 * The decision itself is in `settingsWindowPolicy`, where it can be tested
 * without a window — or without Electron at all.
 */
/**
 * Avisa as janelas que o estado DEV mudou (DEV-6).
 *
 * Só o sinal: a página relê pelo canal principal. Nenhum dado é empurrado por
 * evento, e um evento perdido só faz a página atualizar no próximo clique.
 */
function notifyDevChange(state: DevPanelState): DevPanelState {
	for (const window of BrowserWindow.getAllWindows()) {
		if (!window.isDestroyed()) {
			window.webContents.send(DEV_EVENT_CHANNEL, 'refresh');
		}
	}
	return state;
}

function presentSettingsWindow(): void {
	const existing = settingsWindow;
	const action = settingsWindowAction({
		exists: existing !== undefined,
		destroyed: existing?.isDestroyed() ?? false,
		minimized: existing?.isMinimized() ?? false,
		visible: existing?.isVisible() ?? false,
	});
	if (action === 'create') {
		createSettingsWindow();
		return;
	}
	if (existing === undefined || existing.isDestroyed()) {
		return;
	}
	if (action === 'restore') {
		existing.restore();
	}
	if (action === 'show') {
		existing.show();
	}
	existing.focus();
	// `focus()` asks the window to come forward; `moveTop()` puts it above the
	// windows that are not ours, which is what "the user asked for it" means
	// when the settings window is behind another application.
	existing.moveTop();
}

function createSettingsWindow(): BrowserWindow {
	const existing = settingsWindow;
	if (existing !== undefined && !existing.isDestroyed()) {
		presentSettingsWindow();
		return existing;
	}

	const window = new BrowserWindow({
		title: `${APP_NAME} settings`,
		icon: join(__dirname, APP_ICON),
		// The restore size, not the opening size — the window opens maximised
		// below. Four panels of real forms do not fit a fixed height, and
		// guessing one left the system prompt below the fold; letting the OS
		// decide gives the content the whole work area on any screen.
		width: 760,
		height: 900,
		minWidth: 480,
		minHeight: 400,
		show: false,
		// Frameless for the same reason the main window is: the settings page is
		// the same bundle, and a second window with a frame and a title bar would
		// not match the first.
		frame: false,
		transparent: true,
		backgroundColor: '#00000000',
		webPreferences: {
			preload: join(__dirname, 'preload.js'),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});

	/*
	 * Maximised before it is shown, not after.
	 *
	 * Showing first and maximising second would put the window on screen at its
	 * restore size and then snap it to full, which is a visible jump. Maximising
	 * while it is still hidden means the first frame the user ever sees is
	 * already the final layout.
	 *
	 * `pushWindowState` is registered below, so this also drives the title bar's
	 * own restore glyph — the button is drawn before the first paint.
	 *
	 * The window is shown on `ready-to-show` — the first painted frame — and
	 * also if the page never gets there: a load that fails, or a renderer
	 * that never paints, would leave the window hidden for good, and a
	 * click on "Configurar" would look like it had been ignored. A blank
	 * window is a better answer than no window at all.
	 */
	let revealed = false;
	const reveal = (): void => {
		if (revealed || window.isDestroyed()) {
			return;
		}
		revealed = true;
		if (!window.isMaximized()) {
			window.maximize();
		}
		window.show();
	};
	window.once('ready-to-show', reveal);
	window.webContents.once('did-fail-load', reveal);
	// Each window watches its own state: a shared handler would tell this window
	// that the *other* one had been maximized.
	pushWindowState(window);
	// Cleared on close so the next request builds a fresh one rather than
	// focusing a destroyed window.
	window.on('closed', () => {
		settingsWindow = undefined;
	});

	void window.loadFile(join(__dirname, 'renderer', 'index.html'), {
		// The page's only branch, and the one place the two layouts are told
		// apart. A query parameter rather than a global: it survives a reload,
		// which a value injected at construction would not.
		search: 'window=settings',
	});
	// Remembered, or the single-instance check above never sees it: every
	// request would build another window, and two forms editing one provider
	// config would be two answers to one question.
	settingsWindow = window;
	return window;
}

/**
 * O material do serviço, lido do pacote.
 *
 * No pacote, `resources/service/` tem o `main.js` e os assets ao lado do
 * `app.asar` — fora dele, porque um script dentro de um arquivo empacotado não
 * pode ser passado ao Node. Fora do pacote (execução a partir do repositório)
 * não há esse diretório, e o serviço não é iniciado: o modo local responde.
 */
async function loadServiceMaterial(): Promise<ServiceMaterial | undefined> {
	if (!app.isPackaged) {
		// Rodando de `dist/desktop` (desenvolvimento, testes de integração): o
		// serviço **não** é iniciado aqui.
		//
		// Duas razões. Primeira: quem roda a partir do repositório costuma querer
		// controlar sozinho se há serviço — e um auto-start escondido tomaria a
		// raiz que o teste acabou de preparar. Segunda: o `dist/web` pode ser de
		// uma compilação anterior à do desktop, e servir um serviço desatualizado
		// é pior que não servir. O pacote é o alvo; fora dele, o modo local é a
		// resposta.
		return undefined;
	}
	const from = join(process.resourcesPath, 'service');
	try {
		const main = await readFile(join(from, 'main.js'), 'utf8');
		const manifest = await readFile(join(from, 'package.json'), 'utf8');
		const assets: Record<string, string> = {};
		for (const name of ['index.html', 'index.css', 'index.js']) {
			try {
				assets[name] = await readFile(join(from, 'assets', name), 'utf8');
			} catch {
				// Ver acima: o painel precisa do HTML, a API não.
			}
		}
		return { main, packageJson: manifest, assets };
	} catch {
		return undefined;
	}
}

/**
 * Tenta deixar o serviço pronto para esta raiz — e nunca derruba o app.
 *
 * Devolve `unavailable` com o motivo em vez de lançar: a falha do serviço é um
 * estado normal (porta ocupada, antivírus, instalação incompleta), e o modo
 * local continua funcionando com os dados do usuário.
 */
async function tryStartService(root: string): Promise<ServiceStartOutcome> {
	// Um teste que precisa do **modo local** desliga o auto-start por ambiente.
	// Sem isso não há como exercitar o DEV no pacote empacotado: o serviço sobe
	// antes, toma a raiz, e o DEV — que só existe no modo local — nunca monta.
	if (process.env['EVELYN_NO_SERVICE'] === '1') {
		return { kind: 'unavailable', reason: 'inicialização do serviço desligada neste ambiente' };
	}
	const material = await loadServiceMaterial();
	if (material === undefined) {
		return {
			kind: 'unavailable',
			reason: 'o serviço local não foi encontrado nesta instalação; usando o modo local',
		};
	}
	try {
		return await ensureService({
			root,
			// O próprio executável: com `ELECTRON_RUN_AS_NODE=1` ele roda o
			// script como Node, sem abrir janela.
			execPath: process.execPath,
			serviceDir: serviceDirectoryFor(app.getPath('userData')),
			material: async () => material,
		});
	} catch (error) {
		return {
			kind: 'unavailable',
			reason: `o serviço local não iniciou: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/**
 * O estado atual do serviço, sem iniciar nem encerrar nada.
 *
 * `active` só depois do health autenticado — um processo vivo que não responde
 * não é um serviço utilizável, e chamá-lo de ativo faria o botão abrir uma
 * página que não existe.
 */
async function readServiceControl(root: string): Promise<ServiceControlState> {
	try {
		const probe = await probeService({ root });
		if (probe.kind === 'active') {
			return {
				state: 'active',
				pid: probe.record.pid,
				port: probe.record.port,
				...(probe.health.version !== undefined ? { version: probe.health.version } : {}),
			};
		}
		// Sem serviço **e com motivo de falha no arranque**: o estado é `error`,
		// não `inactive`. Um "desligado" aqui mandaria o usuário clicar em
		// "Ativar serviço" sem saber que a porta está ocupada — e o texto de
		// apoio ainda sugeriria reabrir o app, que é o que já falhou.
		if (serviceStartFailure !== undefined) {
			return { state: 'error', message: serviceStartFailure };
		}
		return { state: 'inactive' };
	} catch (error) {
		return {
			state: 'error',
			message: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Liga ou desliga o serviço pelo controle da janela.
 *
 * Ligar nunca duplica: `ensureService` adota o que já responde e só inicia
 * quando não há serviço utilizável. Desligar usa o encerramento seguro — o
 * pedido HTTP autenticado, que solta a trava e apaga o registro; nada é morto
 * à força, e um serviço que não prova ser o nosso é recusado.
 */
/**
 * Avisa todas as janelas do estado atual do serviço.
 *
 * Chamado no fim de cada operação do controle (e depois da inicialização
 * automática). O estado é **lido**, não deduzido: quem responde é o serviço, e
 * um aviso que dissesse "ativo" sem health seria o mesmo defeito de antes.
 */
async function broadcastServiceState(root: string): Promise<ServiceControlState> {
	const state = await readServiceControl(root);
	for (const window of BrowserWindow.getAllWindows()) {
		if (!window.isDestroyed()) {
			window.webContents.send(SERVICE_STATE_CHANNEL, state);
		}
	}
	return state;
}

async function setServiceRunning(root: string, on: boolean): Promise<ServiceControlReply> {
	if (!on) {
		const stopped = await shutdownService(root);
		const state = await broadcastServiceState(root);
		if (!stopped.stopped) {
			return {
				ok: false,
				state,
				message: stopped.reason ?? 'o serviço não pôde ser encerrado',
			};
		}
		// Desligar o serviço devolve o app ao modo local na próxima abertura.
		// Aqui só o estado muda: a janela aberta continua como está.
		remoteMode = undefined;
		remoteStatus = undefined;
		serviceStartFailure = undefined;
		return { ok: true, state };
	}

	const outcome = await tryStartService(root);
	if (outcome.kind === 'connected') {
		remoteMode = 'connected';
		remoteStatus = {
			state: 'connected',
			detail: `serviço local no ar (processo ${outcome.pid})`,
			port: outcome.port,
			pid: outcome.pid,
			...(outcome.version !== undefined ? { version: outcome.version } : {}),
		};
		serviceStartFailure = undefined;
		const state = await broadcastServiceState(root);
		return { ok: true, state };
	}
	serviceStartFailure = outcome.reason;
	const failed: ServiceControlState = { state: 'error', message: outcome.reason };
	for (const window of BrowserWindow.getAllWindows()) {
		if (!window.isDestroyed()) {
			window.webContents.send(SERVICE_STATE_CHANNEL, failed);
		}
	}
	return { ok: false, state: failed, message: outcome.reason };
}

/**
 * O desbloqueio persistente está habilitado nesta instalação?
 *
 * A variável é **do processo**: precisa existir antes de o app abrir, e nada
 * vindo do renderer, do projeto ou da rede a define. Sem ela, o recurso não
 * existe na interface e nenhum recibo é gravado — o comportamento é o de antes.
 *
 * O valor `0` (e vazio) desliga: um ambiente que herdou a variável de outro
 * contexto não liga o recurso por acidente.
 */
function persistentUnlockEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env['EVELYN_DEV_PERSISTENT_UNLOCK'];
	return value === '1' || value?.toLowerCase() === 'true';
}

async function main(): Promise<void> {
	// `--root <pasta>` aponta para outra raiz; sem ele, a padrão de sempre.
	const rootOverride = rootArgument();
	const dataRoot = rootOverride ?? defaultDataStoreRoot();

	// A marca de "abrir em modo local" (pedida pelo botão do DEV) é consumida
	// **antes** de decidir o modo: quem a escreveu quer este processo local, e
	// subir o serviço primeiro tomaria a raiz e desfaria o pedido.
	const forcedLocal = await consumeLocalMarker();

	// ── o serviço primeiro ────────────────────────────────────────────────
	//
	// O modo conectado existe quando o **serviço** é dono da raiz. Por isso ele
	// é tentado antes de qualquer montagem local: montar aqui primeiro tomaria a
	// raiz, e o serviço — que chega depois — seria recusado como segundo dono.
	//
	// A tentativa é **best effort** e tem prazo. Qualquer falha (não ficou
	// pronto, encerrou, prazo estourado) devolve `unavailable` com o motivo, e
	// o app segue para o modo local exatamente como sempre fez. Nenhum arquivo
	// de dados é tocado por esta etapa: o serviço só lê o registro que ele
	// mesmo grava.
	const service = forcedLocal
		? ({ kind: 'unavailable', reason: 'abertura em modo local pedida pelo painel do modo DEV' } as const)
		: await tryStartService(dataRoot);
	if (service.kind === 'connected') {
		const desktop = await DesktopCore.create(
			rootOverride !== undefined ? { rootPath: rootOverride } : {},
		);
		core = desktop;
		// O serviço já é o dono da raiz. Este processo não monta Core, não toma
		// o lock: é cliente do serviço que acabou de ser iniciado.
		remoteMode = 'connected';
		remoteStatus = {
			state: 'connected',
			detail: `serviço local no ar (processo ${service.pid})`,
			port: service.port,
			pid: service.pid,
			...(service.version !== undefined ? { version: service.version } : {}),
		};
		desktop.log(`${APP_NAME} desktop connected to the local service`);
		openConnectedWindow();
		signalReady('connected', service.pid);
		// A janela abre mostrando "…" até a primeira leitura; este aviso garante
		// que o controle já aparece "ativo" mesmo sem clique nenhum.
		void broadcastServiceState(dataRoot);
		runE2EIfAsked(desktop, dataRoot);
		return;
	}
	// Sem serviço: ou porque falhou, ou porque não há como iniciá-lo (execução
	// a partir do repositório com `electron dist/desktop/main.js`). Nos dois
	// casos o motivo é guardado para aparecer na tela se o modo local também
	// não montar.
	if (service.kind === 'unavailable') {
		serviceStartFailure = service.reason;
	}

	// A raiz **primeiro**, pela mesma regra do host web. Se outro host a tem,
	// este não monta o Core, não abre janela e sai com a explicação — sem
	// tocar em nenhum arquivo de dados.
	//
	// `--root <pasta>` aponta para outra raiz; sem ele, a padrão de sempre.
	const desktop = await DesktopCore.create(
		rootOverride !== undefined ? { rootPath: rootOverride } : {},
	);
	core = desktop;
	if (desktop.chat === undefined) {
		/**
		 * Por que o Core não montou.
		 *
		 * `mounted` = não é o caso (o Core montou). `busy` = outro host tem a
		 * raiz. A mensagem sozinha não distingue "o serviço tem a raiz" de
		 * "outro app tem a raiz", e essa diferença decide entre abrir a janela
		 * e sair com a explicação.
		 */
		const refusalKind = desktop.refusalKind;
		/** O modo conectado tem Core de outro dono: o serviço. */
		if (refusalKind === 'busy') {
			const joined = await connectedStatus(rootOverride);
			if (joined !== undefined) {
				// O serviço é o dono dos dados. Este app abre e opera em modo
				// conectado: não monta Core, não toma o lock, e só lê o que o
				// serviço expõe. Nada é iniciado aqui.
				remoteMode = 'connected';
				remoteStatus = joined;
				desktop.log(`${APP_NAME} desktop connected to the local service`);
				openConnectedWindow();
				// R4L: depois de conectado **e** de a janela existir.
				signalReady('connected', joined.pid);
				runE2EIfAsked(desktop, rootOverride ?? defaultDataStoreRoot());
				return;
			}
		}
		/**
		 * Nem Core próprio, nem serviço utilizável: abre sem dados, e diz por
		 * quê. Só quando a raiz **não** foi tomada por outro app desktop — se
		 * foi, a recusa atual continua sendo a resposta certa, e o app sai.
		 */
		if (refusalKind !== 'failed') {
			const unavailable = await unavailableStatus(desktop.refusal, rootOverride);
			if (unavailable !== undefined) {
				remoteMode = 'unavailable';
				remoteStatus = unavailable;
				desktop.log(`${APP_NAME} desktop starting without data: ${unavailable.detail}`);
				openConnectedWindow();
				signalReady('unavailable');
				runE2EIfAsked(desktop, rootOverride ?? defaultDataStoreRoot());
				return;
			}
		}
		refuseToStart(await explainRefusal(desktop.refusal, rootOverride));
		return;
	}
	desktop.log(`${APP_NAME} desktop starting`);
	// R4S: não há mais provedor semeado. O `9router` criava em toda instalação
	// um provedor que não responde; o usuário configura os seus. O ponto de
	// chamada fica porque o contrato do host prevê "garanta os padrões".
	await desktop.chat.seedDefaultProviders();
	// Before the window exists: the menu is drawn as part of it, and creating
	// first would mean one frame with the bar the app does not want.
	removeMenuBar();
	registerIpc();
	registerServiceIpc();
	registerWindowControls();
	mainWindow = createWindow();

	app.on('activate', () => {
		// macOS: clicking the dock icon with no window open reopens one.
		// Counts only the chat window, so a settings window left open does not
		// stop the main one from coming back.
		if (mainWindow === undefined || mainWindow.isDestroyed()) {
			mainWindow = createWindow();
		}
	});

	ipcMain.handle(OPEN_SETTINGS_CHANNEL, () => {
		presentSettingsWindow();
		return true;
	});
	/**
	 * Leva a pergunta de autorização até a janela que sabe desenhá-la (DEV-10).
	 *
	 * O diálogo mora na seção DEV, que só existe na janela de configurações
	 * (`.only-settings`). Entregar o evento à janela do chat fazia a pergunta
	 * pousar num bloco oculto: o host ficava esperando a resposta até o prazo
	 * de 120 s, e a ação seguinte respondia "há uma ação DEV em andamento".
	 *
	 * Se a janela ainda está carregando, o evento sai no `did-finish-load` —
	 * mandar antes disso o renderer não tem ouvinte e a mensagem se perde.
	 * A seção é trocada para DEV do lado da página, que é onde o `hidden` da
	 * seção pode ser desfeito.
	 */
	const deliverOwnerPrompt = (prompt: OwnerPrompt): void => {
		presentSettingsWindow();
		const target = settingsWindow;
		if (target === undefined || target.isDestroyed()) {
			return;
		}
		const send = (): void => {
			if (target.isDestroyed()) {
				return;
			}
			target.webContents.send(DEV_OWNER_PROMPT_CHANNEL, prompt);
		};
		// A pergunta também fica **legível**: a janela pode estar montando
		// quando o evento sai, e um ouvinte inscrito depois não recebe o que
		// já passou. A página consulta `pendingDevOwnerPrompt()` ao montar.
		// O evento continua indo — uma janela já montada desenha na hora.
		if (target.webContents.isLoading()) {
			target.webContents.once('did-finish-load', send);
		} else {
			send();
		}
	};
	// DEV-10: a pergunta aberta, para a janela que chegar depois do evento.
	// Só o que já ia no evento: id, tipo e texto — nunca senha.
	ipcMain.handle(DEV_OWNER_PENDING_CHANNEL, (event) => {
		const senderWindow = BrowserWindow.fromWebContents(event.sender);
		// Só a janela de configurações desenha o diálogo; responder a outra
		// página entregaria o texto a quem não o mostra.
		if (settingsWindow === undefined || senderWindow !== settingsWindow) {
			return null;
		}
		return ownerPrompts?.open ?? null;
	});
	// DEV-5: o host do modo DEV, montado depois da janela — o alvo precisa
	// dela. `setup()` só verifica a raiz; a sessão **não** abre aqui: isso
	// exige `ownerRequest()`, e a interface (DEV-6/DEV-7) só chega a ele com a
	// credencial local validada.
	const devData = rootArgument() ?? defaultDataStoreRoot();
	// DEV-7: a credencial local do proprietário. O usuário vem do ambiente do
	// **processo** (nunca do renderer); o DPAPI protege a chave derivada para
	// esta conta do Windows.
	const credential = new OwnerCredentialStore({
		dir: join(devData, 'dev'),
		user: () => currentWindowsUser(),
	});
	// O prompt vai para a janela que **contém** o diálogo: ele mora na seção
	// DEV, que é `.only-settings`. Enviá-lo à janela principal (a do chat)
	// entregava o evento a uma página onde o diálogo está escondido, e a
	// pergunta nunca aparecia — medido no pacote: o evento chegava, e o
	// `#dev-owner-prompt` continuava `hidden`.
	//
	// A janela de configurações não responde a senha (`main` recusa a resposta
	// de qualquer janela que não seja a principal), então o diálogo é desenhado
	// lá e a resposta viaja com o id que o host emitiu.
	const prompts = new OwnerPromptBroker((prompt) => {
		// DEV-10: a pergunta mora na janela de **configurações** (`.only-settings`).
		// Mandá-la para a janela do chat a entregava a uma página onde a seção
		// inteira está oculta: o evento chegava, nada aparecia, e a ação
		// esperava os 120 s de validade com o host ocupado. Medido no pacote.
		//
		// Por isso a pergunta **traz** a janela: cria e foca a de configurações
		// quando não há uma. É o que a pessoa faria para responder, e sem isso
		// a ação DEV pedida não tem como terminar.
		deliverOwnerPrompt(prompt);
		// A entrega é assíncrona: a janela pode estar carregando. Devolver
		// `true` aqui diz "há destino", não "já desenhou" — a página responde
		// pelo `answerDevOwnerPrompt`, e o prazo continua valendo.
		return true;
	});
	ownerPrompts = prompts;
	devHost = new DevHost({
		// A raiz vem do ambiente do processo. `MODELHUB_DEV_ROOT` aponta para
		// o checkout; sem ela, o diretório de trabalho — que é o repositório
		// quando o app roda em desenvolvimento. O app instalado não tem `.git`,
		// e então `setup()` responde `repo: false` e o chat fica sem `dev`.
		repositoryRoot: process.env.MODELHUB_DEV_ROOT ?? process.cwd(),
		dataRoot: devData,
		window: () => windowPortFor(mainWindow),
		log: (message: string) => desktop.log(`dev: ${message}`),
		// A confirmação de instância (DEV-6): só a interface ativa, e só com
		// uma instância do app. Em teste, o host não recebe isto e a ativação
		// pela interface fica indisponível.
		readLocalInstance,
		// DEV-7: sem credencial e sem prompt, não há ativação pela interface.
		credential,
		prompt: prompts,
		ownerActions: {
			configure: async (password, confirmation) => {
				const result = await credential.configure(password, confirmation);
				return result.ok ? { ok: true, message: '' } : { ok: false, message: result.message };
			},
			reset: async () => {
				// A recuperação só roda daqui: a página pediu com confirmação
				// explícita, nesta janela, e o `main` não aceita o pedido de
				// outro lugar.
				const result = await credential.reset({ confirm: true });
				return result.ok ? { ok: true, message: '' } : result;
			},
		},
		/**
		 * O desbloqueio persistente neste dispositivo.
		 *
		 * Lido do ambiente **do processo**: a variável precisa existir quando o
		 * app é iniciado, e nenhum caminho do renderer pode ligá-la. Isso é o
		 * "não disponível aos usuários comuns": sem a variável, o host não
		 * oferece o recurso e nada é gravado em disco.
		 */
		...(persistentUnlockEnabled()
			? {
					persistentUnlock: createPersistentUnlockStore({
						devDir: join(devData, 'dev'),
					}),
				}
			: {}),
	});
	const devState = await devHost.setup();
	// Com o desbloqueio persistente ligado, a sessão volta sozinha ao abrir —
	// **se** o recibo ainda valer para a credencial de agora. Um recibo de outra
	// senha, revogado ou ilegível faz `resumeFromPersistent` devolver
	// `undefined`, e nada acontece: a tela pede a senha.
	//
	// Antes do `attach`: é ele que publica as ferramentas para o chat a partir
	// do estado da sessão. Retomar depois deixaria a sessão ativa e o agente sem
	// as ferramentas DEV.
	if (devState.repo && persistentUnlockEnabled()) {
		const resumed = await devHost.resumeFromPersistent().catch(() => undefined);
		if (resumed !== undefined) {
			desktop.log('dev: reaberto pelo desbloqueio persistente deste dispositivo');
		}
	}
	devHost.attach(desktop.chat);
	desktop.log(
		devState.repo
			? `dev: repositório ${devState.root} (sessão ${devState.session})`
			: `dev: indisponível — ${devState.reason}`,
	);
	// R4L: o modo local está pronto depois de semear o provedor padrão e de a
	// janela existir — o mais tarde possível, para o sinal não mentir.
	signalReady('local');

	/*
	 * DEV-8.2: o roteiro do teste ponta a ponta, quando **o ambiente o pede**.
	 *
	 * O pacote roda só o `app.asar`: não há como apontá-lo para um script, e um
	 * teste que não abre o binário de verdade não testa o binário de verdade.
	 * Este ponto carrega o módulo indicado em `EVELYN_E2E_SCRIPT` **depois** de
	 * o Core e o painel existirem e entrega só o que o app já tem: a janela
	 * principal e o host.
	 *
	 * É um teste de desenvolvimento: só existe quando `EVELYN_E2E_SCRIPT` está
	 * definido, e o roteiro que ele carrega não tem nada além do que a página
	 * já tem — sem token, sem sessão, sem atalho para a senha.
	 */
	const e2eScript = process.env['EVELYN_E2E_SCRIPT'];
	if (typeof e2eScript === 'string' && e2eScript.length > 0) {
		launchE2EScript(e2eScript, desktop, devHost, devData);
	}
}

/**
 * Carrega o roteiro de teste ponta a ponta, quando o ambiente o pede.
 *
 * Extraído porque o app agora tem **três** saídas de abertura (conectado
 * adotado, conectado iniciado por este app, sem dados) e o roteiro precisa
 * alcançar todas: antes ele vivia só no fim do modo local, e o caminho que
 * esta migração criou era justamente o que nenhum teste via.
 *
 * Só existe quando `EVELYN_E2E_SCRIPT` está definido, e o roteiro não recebe
 * nada além do que a página já tem — sem token, sem sessão, sem atalho para a
 * senha.
 */
/**
 * Roda o roteiro E2E, se o ambiente o pediu, e não faz mais nada.
 *
 * Chamado em cada caminho de abertura: o roteiro precisa ver o app no estado
 * em que ele de fato abriu — conectado, sem dados ou local.
 */
function runE2EIfAsked(desktop: DesktopCore, dataRoot: string): void {
	const script = process.env['EVELYN_E2E_SCRIPT'];
	if (typeof script === 'string' && script.length > 0) {
		launchE2EScript(script, desktop, undefined, dataRoot);
	}
}

function launchE2EScript(
	script: string,
	desktop: DesktopCore,
	host: unknown,
	dataRoot: string,
): void {
	try {
		desktop.log(`e2e: carregando roteiro de ${script}`);
		const loaded: unknown = require(script);
		const candidate = loaded as
			| (((context: unknown) => Promise<void>) & { readonly default?: (context: unknown) => Promise<void> })
			| { readonly default?: (context: unknown) => Promise<void> }
			| undefined;
		const runner =
			typeof candidate === 'function'
				? candidate
				: typeof candidate?.default === 'function'
					? candidate.default
					: undefined;
		if (typeof runner !== 'function') {
			desktop.log('e2e: o roteiro não exporta uma função');
			return;
		}
		void (runner as (context: unknown) => Promise<void>)({
			BrowserWindow,
			host,
			mainWindow,
			report:
				process.env['EVELYN_E2E_REPORT'] ??
				process.argv.find((arg) => arg.startsWith('--e2e-report='))?.slice('--e2e-report='.length),
			dataRoot: process.env['EVELYN_E2E_DATA_ROOT'] ?? dataRoot,
			password: process.env['EVELYN_E2E_PASSWORD'],
			scratch: process.env['EVELYN_E2E_SCRATCH'],
			phase: process.env['EVELYN_E2E_PHASE'],
		}).catch((error: unknown) => {
			desktop.log(`e2e: roteiro falhou: ${String(error)}`);
		});
	} catch (error) {
		desktop.log(`e2e: não foi possível carregar o roteiro: ${String(error)}`);
	}
}

/**
 * O `mainWindow`, no formato que o `DevHost` entende (DEV-5).
 *
 * A janela é resolvida **na hora**: pode ter sido criada depois do host, ou
 * ter sido fechada. Devolver `undefined` faz o adaptador recusar a aplicação
 * em vez de "não fazer nada".
 */
function windowPortFor(window: BrowserWindow | undefined): DevHostWindow | undefined {
	if (window === undefined || window.isDestroyed()) {
		return undefined;
	}
	/**
	 * A janela terminou de carregar e o estado assentou (DEV-8.3).
	 *
	 * `did-finish-load` chega antes de `isLoading()` virar `false`; a
	 * conferência do fluxo roda no instante seguinte e via "ainda carregando".
	 * Aqui o "pronto" só vale depois de dois quadros consecutivos sem carga.
	 */
	// DEV-8.3: só fica `false` no intervalo entre `did-finish-load` e a carga
	// assentar; fora de uma recarga, a janela existente já é "pronta".
	let settledReady = !window.webContents.isLoading();
	const settle = (done: () => void): void => {
		settledReady = false;
		setTimeout(() => {
			settledReady = !window.isDestroyed() && !window.webContents.isLoading();
			done();
		}, 120);
	};
	return {
		isWindowAlive: () => !window.isDestroyed(),
		// DEV-8.3: `isLoading()`/`did-finish-load` são `true` por alguns quadros
		// **depois** de a página estar pronta para receber JavaScript (medido na
		// DEV-5 e de novo aqui). A conferência do fluxo perguntava "a janela
		// voltou?" nesse intervalo, recebia `false` e desfazia pelo checkpoint
		// com a operação já aplicada — `rolled-back` com a recarga confirmada.
		// "Pronta" é "existe e não está carregando há um instante": exigir dois
		// quadros sem carga evita o falso negativo.
		isWindowReady: () => !window.isDestroyed() && !window.webContents.isLoading() && settledReady,
		reloadWindow: (timeoutMs: number) =>
			new Promise<void>((resolve, reject) => {
				const onLoad = (): void => {
					clearTimeout(timer);
					// Espera o carregamento assentar antes de dizer "voltou":
					// quem confere logo depois (o `probe` do fluxo) não pode ver
					// `isLoading()` ainda verdadeiro.
					settle(() => resolve());
				};
				const timer = setTimeout(() => {
					window.webContents.removeListener('did-finish-load', onLoad);
					reject(new Error(`a janela não terminou de recarregar em ${timeoutMs} ms`));
				}, timeoutMs);
				window.webContents.once('did-finish-load', onLoad);
				// DEV-8.3: no pacote a página é `file://…/app.asar/…`, e a recarga
				// reutilizava a folha de estilo em cache — o fluxo dizia "aplicado",
				// e o DOM continuava com o CSS anterior (medido). A recarga que
				// aplica uma mudança **tem** de buscar de novo: desabilita o cache
				// só nesta recarga e o restaura em seguida.
				window.webContents.session.clearCache().catch(() => undefined);
				window.webContents.reloadIgnoringCache();
			}),
		// Uma vez por fluxo: o `electronApply` guarda "já pedi" e o
		// `applyPrepared` não aplica de novo. Este é o único `relaunch`.
		restartApplication: async () => {
			app.relaunch();
			app.quit();
		},
	};
}

/**
 * Explica uma recusa de montagem, distinguindo "o serviço está no ar" de
 * "outra instância do app está aberta".
 *
 * A recusa do lock já diz o suficiente; o que falta é a **confirmação de que
 * o serviço está vivo e ativo**, e não um registro obsoleto. Sem ela, o
 * usuário leria "encerre o serviço" sobre um serviço que já morreu.
 */
async function explainRefusal(
	refusal: string | undefined,
	rootPath: string | undefined,
): Promise<string> {
	const base = refusal ?? 'the data directory is not available';
	try {
		const probe = await probeService({ root: rootPath ?? defaultDataStoreRoot() });
		if (probe.kind === 'active') {
			return (
				`${base}\n\nO serviço local está ativo (processo ${probe.record.pid}, ` +
				`porta ${probe.record.port}, desde ${probe.record.startedAt}). ` +
				'Para abrir o aplicativo com os dados, encerre o serviço antes ' +
				'(`node dist/web/main.js --stop`).'
			);
		}
		if (probe.kind === 'incompatible') {
			return `${base}\n\nO serviço local está no ar com um protocolo diferente (${probe.protocol}).`;
		}
		if (probe.kind === 'stale') {
			return `${base}\n\nO registro do serviço local está obsoleto: ${probe.reason}. ` +
				'A raiz será liberada na próxima abertura.';
		}
	} catch {
		// A explicação extra é um bônus: se a descoberta falhar, a recusa
		// original continua sendo verdadeira e suficiente.
	}
	return base;
}

/**
 * O `--root <pasta>` da linha de comando, quando veio.
 *
 * O Electron entrega os argumentos depois do executável e depois do script,
 * e inclui flags próprias (`--inspect`, `--remote-debugging-port`). A busca
 * procura o par exato e ignora o resto em vez de supor posições.
 */
function rootArgument(): string | undefined {
	const argv = process.argv.slice(1);
	// DEV-8.2: duas formas. A primeira é a documentada (`--root <pasta>`); a
	// segunda (`--root=<pasta>`) é a que sobrevive ao empacotador do Windows,
	// que transforma o par em um único argumento. Medido: com só a forma em
	// par, `--root=C:\X` era recebido e **ignorado**, e o app caía na raiz
	// padrão sem avisar.
	const index = argv.indexOf('--root');
	if (index >= 0) {
		const value = argv[index + 1];
		if (value !== undefined && !value.startsWith('--')) {
			return value;
		}
	}
	const inline = argv.find((arg) => arg.startsWith('--root='));
	if (inline !== undefined) {
		const value = inline.slice('--root='.length).trim();
		return value.length > 0 ? value : undefined;
	}
	return undefined;
}

/**
 * Closes the app with a readable reason, before any window exists.
 *
 * Used when the data directory belongs to another host: there is nothing this
 * process can do with it, and starting anyway would be the two-writers race
 * the lock exists to prevent.
 */
function refuseToStart(reason: string): void {
	console.error(`[evelyn] ${reason}`);
	signalReady('refused');
	app.exit(1);
}

/**
 * O Windows agrupa janelas pelo `AppUserModelId`.
 *
 * Sem ele, o processo é agrupado como `electron.exe` e a barra de tarefas
 * desenha o **ícone do Electron**, mesmo com `icon:` na `BrowserWindow` —
 * porque numa janela sem moldura (`frame: false`) o ícone da tarefa vem do
 * grupo do processo, não do da janela. Definir um id próprio é o que faz o
 * Windows usar o ícone que o app declara.
 *
 * Só no Windows: nas outras plataformas a chamada não tem efeito.
 */
if (process.platform === 'win32') {
	app.setAppUserModelId('ai.modelhub.evelyn');
}

app.whenReady().then(main, (error: unknown) => {
	// A failure before the window exists leaves nothing to show, so this is the
	// one place that reports to the terminal and exits.
	console.error('[evelyn] the desktop app could not start', error);
	app.exit(1);
});

app.on('window-all-closed', () => {
	// Everywhere except macOS, closing the last window quits.
	if (process.platform !== 'darwin') {
		app.quit();
	}
});

app.on('will-quit', () => {
	void core?.dispose();
});
