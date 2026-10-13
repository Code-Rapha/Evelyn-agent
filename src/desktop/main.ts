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

import { LoggingService } from '../core/logging';
import { ProviderConfigService } from '../core/providers/config';
import { ConsoleLogSink } from '../adapters/local/consoleLogSink';
import { FileSecretStore } from '../adapters/local/fileSecretStore';
import { FileStateStore } from '../adapters/local/fileStateStore';
import { FileDataStore, defaultDataStoreRoot } from '../adapters/local/fileDataStore';
import { ChatSession } from './chatSession';
import {
	APP_NAME,
	CHAT_EVENT_CHANNEL,
	CONVERSATION_CHANNEL,
	CORE_STATUS_CHANNEL,
	MODEL_CHANNEL,
	OPEN_SETTINGS_CHANNEL,
	PROJECT_CHANNEL,
	PROVIDER_CHANNEL,
	SEND_MESSAGE_CHANNEL,
	PERMISSION_DECISION_CHANNEL,
	STOP_CHANNEL,
	WINDOW_CHANNEL,
	WINDOW_STATE_CHANNEL,
	parseCoordinate,
	parseResizeDirection,
	type ResizeDirection,
	parseConversationId,
	parseConversationTitle,
	parseCoreStatus,
	parseCreateConversationInput,
	parseCreateProjectInput,
	parsePermissionAnswer,
	parseProviderId,
	parseSaveProviderInput,
	parseSendMessageInput,
	parseSystemPrompt,
	type ChatStreamEvent,
	type CoreStatus,
} from './contract';
import type { AgentUiEvent } from './agentTurn';

/**
 * Replaced at build time with the root package.json version. Declared here
 * because the global does not exist at runtime unless esbuild substitutes it.
 */
declare const __APP_VERSION__: string;

/** Where the desktop keeps everything. One root, three files. */
function dataRoot(): string {
	return defaultDataStoreRoot();
}

/**
 * The Core, assembled for this host.
 *
 * Config and secrets are the same local adapters the extension tests use, and
 * the transcript goes to the same `FileDataStore`, so a provider configured here
 * survives a restart and so does the conversation.
 */
class DesktopCore {
	private readonly logger: LoggingService;
	// Not private: `registerIpc` below is a module-level function that wires this
	// session to IPC, and a private field would force every call through an
	// accessor that exists only to work around that.
	readonly chat: ChatSession;
	private readonly root: string;

	constructor() {
		this.root = dataRoot();
		// Console-backed because a desktop run is also a terminal run: the log is
		// readable while developing, and `LoggingService` still redacts.
		this.logger = new LoggingService(new ConsoleLogSink(), { scope: 'seshyina.desktop' });
		this.chat = new ChatSession({
			config: new ProviderConfigService(
				new FileStateStore({ filePath: join(this.root, 'state.json') }),
			),
			secrets: new FileSecretStore({ filePath: join(this.root, 'secrets.json') }),
			history: new FileDataStore({ rootPath: this.root }),
			logger: this.logger,
		});
	}

	/** The payload the renderer is allowed to see. */
	status(electronVersion: string): CoreStatus {
		return parseCoreStatus({
			appName: APP_NAME,
			version: __APP_VERSION__,
			electronVersion,
			platform: process.platform,
			services: ['logging', 'provider-config', 'chat-session'],
			providerCount: this.chat.providerCount,
			dataDirectory: this.root,
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

	/**
	 * Sends an event to the window, if one is still open.
	 *
	 * A closed window is not an error: the turn is still running in the Core and
	 * its result is still persisted, so there is nothing to repair — only nobody
	 * left to tell.
	 */
	emit(event: AgentUiEvent | ChatStreamEvent): void {
		for (const window of BrowserWindow.getAllWindows()) {
			if (!window.isDestroyed()) {
				window.webContents.send(CHAT_EVENT_CHANNEL, event);
			}
		}
	}

	/** A single line to the terminal. Routing through the Core keeps redaction. */
	log(message: string): void {
		this.logger.info(message);
	}

	dispose(): void {
		this.chat.stop();
	}
}

const core = new DesktopCore();
let mainWindow: BrowserWindow | undefined;

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
function registerIpc(): void {
	ipcMain.handle(CORE_STATUS_CHANNEL, () => core.status(process.versions.electron));

	ipcMain.handle(PROVIDER_CHANNEL, async (_event, action: unknown, payload: unknown) => {
		switch (action) {
			case 'list':
				return core.chat.listProviders();
			case 'save':
				return core.chat.saveProvider(parseSaveProviderInput(payload));
			case 'remove':
				return core.chat.removeProvider(parseProviderId(payload));
			case 'models':
				return core.chat.listModels(parseProviderId(payload));
			default:
				throw new Error(`Unknown provider action ${JSON.stringify(action)}`);
		}
	});

	ipcMain.handle(MODEL_CHANNEL, async (_event, action: unknown, _payload: unknown) => {
		switch (action) {
			case 'available':
				return core.chat.listAvailableModels();
			default:
				throw new Error(`Unknown model action ${JSON.stringify(action)}`);
		}
	});

	ipcMain.handle(PROJECT_CHANNEL, async (_event, action: unknown, payload: unknown) => {
		switch (action) {
			case 'list':
				return core.chat.listProjects();
			case 'create':
				return core.chat.createProject(parseCreateProjectInput(payload));
			default:
				throw new Error(`Unknown project action ${JSON.stringify(action)}`);
		}
	});

	ipcMain.handle(CONVERSATION_CHANNEL, async (_event, action: unknown, payload: unknown) => {
		switch (action) {
			case 'create':
				return core.chat.createConversation(parseCreateConversationInput(payload));
			case 'list':
				return core.chat.listConversations(parseProviderId(payload));
			case 'open':
				return core.chat.openConversation(parseConversationId(payload));
			case 'rename':
				return core.chat.renameConversation(
					parseConversationId(asObject(payload).id),
					parseConversationTitle(asObject(payload).title),
				);
			case 'system-prompt':
				return core.chat.setSystemPrompt(
					parseConversationId(asObject(payload).id),
					parseSystemPrompt(asObject(payload).content),
				);
			case 'delete':
				return core.chat.deleteConversation(parseConversationId(payload));
			default:
				throw new Error(`Unknown conversation action ${JSON.stringify(action)}`);
		}
	});

	ipcMain.handle(SEND_MESSAGE_CHANNEL, async (_event, payload: unknown) =>
		core.chat.sendMessage(parseSendMessageInput(payload), (event) => core.emit(event)),
	);

	ipcMain.handle(PERMISSION_DECISION_CHANNEL, (_event, payload: unknown) =>
		// Narrowed first. Whatever the renderer claims, the broker only ever sees
		// a well-formed `{ id, decision }`, and an unknown id resolves nothing —
		// which is the answer a stale dialog needs.
		core.chat.answerPermission(parsePermissionAnswer(payload)),
	);

	ipcMain.handle(STOP_CHANNEL, () => core.chat.stop());

	// A dialog outliving its window would leave a tool blocked forever on an
	// answer nobody can give. Closing is therefore a denial: `cancelAll` settles
	// each open request as `deny`, the runtime reads that as a normal denied tool
	// result, and the model can carry on without it.
	app.on('before-quit', () => core.chat.denyOpenPermissions('the app is closing'));
	core.onWindowClosed(() => core.chat.denyOpenPermissions('the window was closed'));
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
 * focuses the window that is already open.
 */
let settingsWindow: BrowserWindow | undefined;

function createSettingsWindow(): BrowserWindow {
	const existing = settingsWindow;
	if (existing !== undefined && !existing.isDestroyed()) {
		existing.focus();
		return existing;
	}

	const window = new BrowserWindow({
		title: `${APP_NAME} settings`,
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
	 */
	window.once('ready-to-show', () => {
		window.maximize();
		window.show();
	});
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
	return window;
}

async function main(): Promise<void> {
	core.log(`${APP_NAME} desktop starting`);
	// Before the window exists: the menu is drawn as part of it, and creating
	// first would mean one frame with the bar the app does not want.
	removeMenuBar();
	registerIpc();
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
		createSettingsWindow();
		return true;
	});
}

app.whenReady().then(main, (error: unknown) => {
	// A failure before the window exists leaves nothing to show, so this is the
	// one place that reports to the terminal and exits.
	console.error('[seshyina] the desktop app could not start', error);
	app.exit(1);
});

app.on('window-all-closed', () => {
	// Everywhere except macOS, closing the last window quits.
	if (process.platform !== 'darwin') {
		app.quit();
	}
});

app.on('will-quit', () => {
	core.dispose();
});