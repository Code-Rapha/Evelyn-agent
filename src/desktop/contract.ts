/**
 * The contract between the Electron main process, the preload bridge and the
 * renderer.
 *
 * This module is the only thing all three share, so it imports **nothing** — no
 * `electron`, no Node, no DOM. That is deliberate: the renderer runs in a
 * sandboxed context with no Node, and the preload runs before the page does. A
 * shared file that reached for a runtime module would break one of them.
 *
 * Everything crossing the bridge is plain JSON, and it is treated as untrusted
 * on arrival: the `parse*` functions narrow an unknown value instead of casting
 * it, so a malformed or hostile payload becomes an error the UI can show rather
 * than an object with holes in it.
 *
 * ## How streaming crosses the bridge
 *
 * A `ChatStream` is an async iterator, and an IPC `invoke` is one round trip
 * that resolves once. They cannot be the same thing, so a turn is split in two:
 *
 * - `sendMessage()` returns as soon as the request is *accepted* — the renderer
 *   uses it to switch to its loading state, and nothing else.
 * - The answer arrives as events on `seshyina:chat-event`, pushed from main as
 *   the stream produces them.
 *
 * Every event carries the `turnId` it belongs to. Without it, a late delta from
 * an abandoned turn lands in the message the user is currently watching, which
 * is the one bug that makes a chat look haunted.
 */

/** Asks the main process for the Core's status. */
export const CORE_STATUS_CHANNEL = 'seshyina:core-status';
/** Lists, configures and selects providers and models. */
export const PROVIDER_CHANNEL = 'seshyina:provider';
/** Lists and creates projects, which give the tools a workspace. */
export const PROJECT_CHANNEL = 'seshyina:project';
/** Creates, lists, renames, reads and deletes conversations. */
export const CONVERSATION_CHANNEL = 'seshyina:conversation';
/** Accepts a chat turn. Resolves when the request is accepted, not answered. */
export const SEND_MESSAGE_CHANNEL = 'seshyina:send-message';
/** Asks the renderer to answer an open permission request. */
export const PERMISSION_DECISION_CHANNEL = 'seshyina:permission-decision';
/** Aborts the turn in flight. */
export const STOP_CHANNEL = 'seshyina:stop';
/** Pushed from main as a stream produces output. */
export const CHAT_EVENT_CHANNEL = 'seshyina:chat-event';

/**
 * Window controls, for a window with no native frame.
 *
 * `frame: false` is the price of a transparent window on Windows, and it takes
 * the title bar and the resize borders with it. Everything the frame used to do
 * has to be rebuilt on top of this channel: the three buttons, and the drag
 * that resizes an edge. Moving the window itself needs no channel at all —
 * `-webkit-app-region: drag` handles it inside Chromium — so this carries only
 * what CSS cannot express.
 */
export const WINDOW_CHANNEL = 'seshyina:window';

/**
 * Model discovery across every provider.
 *
 * Separate from `PROVIDER_CHANNEL` because this is not a provider action: it
 * asks about all of them at once and answers with models, not with providers.
 * Folding it in would have put a second shape of answer on a channel whose
 * handler already returns provider summaries.
 */
export const MODEL_CHANNEL = 'seshyina:model';

/** Opening the settings window. A separate channel because it has no payload. */
export const OPEN_SETTINGS_CHANNEL = 'seshyina:open-settings';

/** Main pushing window state the renderer cannot observe for itself. */
export const WINDOW_STATE_CHANNEL = 'seshyina:window-state';

/**
 * Which edge or corner a resize drag started on.
 *
 * Eight values because that is how many hit targets there are: four edges and
 * four corners. `n`, `s`, `e` and `w` move one boundary; the two-letter forms
 * move two at once, which is the difference between dragging the right edge and
 * dragging the bottom-right corner.
 *
 * Named compass-wise rather than after the CSS `resize` keywords, because these
 * describe the *window's* geometry rather than a box in the page.
 */
export type ResizeDirection = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** Shown in the window title bar. */
export const APP_NAME = 'Seshyina';

/** What the renderer is allowed to know about the running Core. */
export interface CoreStatus {
	readonly appName: string;
	/** Injected at build time from the root package.json. */
	readonly version: string;
	/** Electron's own version, so a bug report can name it. */
	readonly electronVersion: string;
	readonly platform: NodeJS.Platform | string;
	/** Ids of the Core services that were registered, in registration order. */
	readonly services: readonly string[];
	readonly providerCount: number;
	/** Where local data will live. A path, not a handle: nothing is opened. */
	readonly dataDirectory: string;
}

/**
 * A provider as the renderer sees it.
 *
 * Deliberately carries no `apiKeyRef` and no key material: the renderer
 * configures a provider by sending a key *in* (once) and never reads one back.
 * Only the reference lives in the Core, beside the value in the SecretStore.
 */
export interface ProviderSummary {
	readonly id: string;
	readonly name: string;
	readonly baseUrl: string;
	readonly status: 'unconfigured' | 'configured' | 'available' | 'error' | 'disabled';
	/** Whether a key reference exists. Never the key itself. */
	readonly hasApiKeyRef: boolean;
	readonly models: readonly string[];
}

/**
 * One selectable model, with the provider that offers it.
 *
 * The provider travels with the model because the list is drawn from every
 * provider at once: two of them can both serve `gpt-4o`, and the name alone
 * would not say which endpoint would answer. Carrying the pair means the choice
 * the user makes already names its provider, and the renderer never has to
 * reconstruct that pairing from a list it also has to keep in step.
 */
export interface AvailableModel {
	readonly providerId: string;
	readonly providerName: string;
	readonly model: string;
}

/** What the renderer may change about a provider. */
export interface SaveProviderInput {
	/** Omit to create; the id is derived from `baseUrl` when absent. */
	readonly id?: string;
	readonly name?: string;
	readonly baseUrl: string;
	/**
	 * The key itself, sent once and handed straight to the `SecretStore`.
	 *
	 * `''` clears a stored key rather than storing an empty one, so "remove my
	 * key" is expressible without a second endpoint.
	 */
	readonly apiKey?: string;
}

/**
 * The roles a transcript carries.
 *
 * `system` is the first message of a conversation and stays at the head: it is
 * what the user typed into the system prompt box, it is persisted with the rest,
 * and it is replayed on every subsequent turn.
 */
export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

/** One message as the renderer receives it. */
export interface ConversationMessageView {
	readonly role: ChatRole;
	readonly content: string;
}

/** A conversation with its transcript, for opening one. */
export interface ConversationView {
	readonly summary: ConversationListItem;
	readonly messages: readonly ConversationMessageView[];
	/** The current system prompt, or `''` when the conversation has none. */
	readonly systemPrompt: string;
}

/** A project as the sidebar lists it. */
export interface ProjectListItem {
	readonly id: string;
	readonly name: string;
	readonly rootPath: string;
}

/** What the renderer may set when creating a conversation. */
export interface CreateConversationInput {
	readonly providerId: string;
	/**
	 * The project whose directory the tools may touch.
	 *
	 * Optional, and the absence is meaningful: without it the filesystem tools
	 * refuse to run, because a tool with no workspace has no directory to
	 * confine itself to. That is safer than defaulting to somewhere arbitrary.
	 */
	readonly projectId?: string;
	readonly title?: string;
	readonly systemPrompt?: string;
}

/** A conversation as the sidebar lists it. */
export interface ConversationListItem {
	readonly id: string;
	readonly title: string;
	/** The provider this conversation talks to. */
	readonly providerId: string;
	/** The project whose directory the tools may touch, when bound to one. */
	readonly projectId?: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly messageCount: number;
}

/** What the renderer sends to start a turn. */
export interface SendMessageInput {
	readonly providerId: string;
	/**
	 * Which conversation the turn belongs to.
	 *
	 * Required rather than inferred: with several conversations open, "the last
	 * one used" would be a guess, and a turn landing in the wrong transcript is
	 * worse than a rejected send.
	 */
	readonly conversationId: string;
	readonly model: string;
	/** The transcript so far, oldest first. */
	readonly messages: readonly { readonly role: ChatRole; readonly content: string }[];
}

/** Acknowledges that a turn was accepted. Carries no answer. */
export interface SendMessageAck {
	readonly turnId: string;
	readonly accepted: true;
}

/** What the UI is told about a tool the model asked for. */
export interface ToolCallSummary {
	readonly id: string;
	readonly name: string;
	/** Raw JSON as the model sent it. Not parsed: malformed is a real case. */
	readonly rawArguments: string;
	/** True when the arguments were not a JSON object, so the tool never ran. */
	readonly malformed: boolean;
}

/** A permission request as the dialog sees it. */
export interface PermissionPrompt {
	readonly id: string;
	readonly toolName: string;
	/** One line describing what would happen, for the dialog's heading. */
	readonly action: string;
	readonly description: string;
	/** The tool's own risk, from the Core's taxonomy. */
	readonly riskLevel: 'safe' | 'moderate' | 'dangerous';
	/**
	 * The arguments, already redacted by the Core's `redactArguments`.
	 *
	 * Sent as an array of strings because the renderer has no Node and cannot
	 * pretty-print an object: the dialog formats it for the user.
	 */
	readonly arguments: readonly { readonly name: string; readonly value: string }[];
	/** The project directory the action would run in, when there is one. */
	readonly workspace?: string;
	/** The turn this belongs to, so a stale dialog can be ignored. */
	readonly turnId: string;
}

/** What the renderer sends back for an open request. */
export interface PermissionAnswer {
	readonly id: string;
	readonly decision: 'allow' | 'deny';
}

/**
 * One step of a turn, pushed from main to renderer.
 *
 * This is the agent's event vocabulary, not a chat-only one: the tool events and
 * the permission events are what a turn that uses tools produces.
 *
 * `turnId` is on every event, including `error`, so a failure can be attributed
 * to the turn it belongs to and a stale one can be ignored.
 */
export type ChatStreamEvent =
	| { readonly type: 'started'; readonly turnId: string }
	| { readonly type: 'delta'; readonly turnId: string; readonly text: string }
	/**
	 * The model's thinking phase, carried alongside `delta`.
	 *
	 * Separate so the renderer can show it as provisional: it must not join
	 * `delta`, because the answer is persisted and the reasoning is not.
	 */
	| { readonly type: 'reasoning'; readonly turnId: string; readonly text: string }
	| {
			readonly type: 'toolCall';
			readonly turnId: string;
			readonly call: ToolCallSummary;
			/** True when the turn is blocked on a permission decision. */
			readonly awaitingPermission: boolean;
	  }
	| {
			readonly type: 'toolResult';
			readonly turnId: string;
			readonly callId: string;
			readonly name: string;
			readonly ok: boolean;
			/** Exactly what the model was told, including any `ERROR:` prefix. */
			readonly output: string;
	  }
	| {
			/** A tool needs the user's answer before it may run. */
			readonly type: 'permissionRequested';
			readonly turnId: string;
			readonly prompt: PermissionPrompt;
	  }
	| {
			/** The answer, and what it meant. Always resolves an open request. */
			readonly type: 'permissionResolved';
			readonly turnId: string;
			readonly id: string;
			readonly toolName: string;
			readonly decision: 'allow' | 'deny';
			/** Why the answer was what it was: the user, or a cancellation. */
			readonly source: 'user' | 'cancelled';
	  }
	| {
			readonly type: 'done';
			readonly turnId: string;
			/** The full text, so the renderer need not trust its own accumulation. */
			readonly content: string;
			/** Why the turn ended: `answered`, `maxTurns`, `aborted`, `error`. */
			readonly reason: string;
			/** How many tools ran. `0` means the model answered directly. */
			readonly toolCalls: number;
	  }
	| { readonly type: 'error'; readonly turnId: string; readonly message: string };

/** Removes an event subscription. Safe to call more than once. */
export type Unsubscribe = () => void;

/**
 * The API exposed on `window.seshyina` by the preload.
 *
 * Frozen and explicit rather than a forwarded `ipcRenderer`, so the renderer
 * can only do what is listed here. Adding a capability means adding a method
 * here on purpose — it can never happen by accident.
 */
export interface SeshyinaBridge {
	/** Core status. Rejects if main is unreachable or the reply is unusable. */
	getCoreStatus(): Promise<CoreStatus>;

	// Providers.
	listProviders(): Promise<readonly ProviderSummary[]>;

	// Projects. A project is a directory the tools may work in.
	listProjects(): Promise<readonly ProjectListItem[]>;
	/** Creates a project. The directory is not created; it must already exist. */
	createProject(input: { readonly name?: string; readonly rootPath: string }): Promise<ProjectListItem>;
	/** Creates or updates one provider. Resolves with the saved summary. */
	saveProvider(input: SaveProviderInput): Promise<ProviderSummary>;
	/** Removes a provider, and the key behind its reference. */
	removeProvider(providerId: string): Promise<boolean>;
	/**
	 * Asks the provider for its models.
	 *
	 * Rejects with a readable message when the endpoint is unreachable, which is
	 * a normal state for a provider the user has just typed a URL for.
	 */
	listModels(providerId: string): Promise<readonly string[]>;
	/**
	 * Every model offered by every enabled provider, each tagged with the
	 * provider that serves it.
	 *
	 * A provider that cannot be reached is left out rather than failing the whole
	 * call: a local server that is not running yet is an ordinary state, and one
	 * of them must not empty the list for all the others.
	 */
	listAvailableModels(): Promise<readonly AvailableModel[]>;

	/**
	 * Opens the settings window, or focuses it if it is already open.
	 *
	 * Returns whether a window was there to focus. False means one was created —
	 * which is a normal outcome, not a failure, and is why this is a boolean
	 * rather than an error the caller has to handle.
	 */
	openSettings(): Promise<boolean>;

	// Chat.
	/**
	 * Creates a conversation. Rejects when the provider is unknown, rather than
	 * creating a conversation that can never be used.
	 */
	createConversation(input: CreateConversationInput): Promise<ConversationView>;
	/** Conversations for a provider, newest activity first. */
	/**
	 * Every conversation, most recently active first.
	 *
	 * Not scoped to a provider: `sendMessage` names its own provider per turn,
	 * so a conversation can be continued with any provider's model. Scoping the
	 * list to one made changing model appear to lose the conversation.
	 */
	listConversations(): Promise<readonly ConversationListItem[]>;
	/** One conversation with its transcript. Rejects when the id is unknown. */
	openConversation(conversationId: string): Promise<ConversationView>;
	renameConversation(conversationId: string, title: string): Promise<ConversationListItem>;
	/** Sets or clears the system prompt. An empty string removes it. */
	setSystemPrompt(conversationId: string, content: string): Promise<ConversationListItem>;
	deleteConversation(conversationId: string): Promise<boolean>;

	// Turns.
	/** Accepts a turn. Resolves when accepted; the answer arrives as events. */
	sendMessage(input: SendMessageInput): Promise<SendMessageAck>;
	/**
	 * Answers an open permission request.
	 *
	 * A request that is not open is refused rather than ignored, so a
	 * double-click on Allow cannot resolve something already decided.
	 */
	answerPermission(answer: PermissionAnswer): Promise<boolean>;
	/** Aborts the turn in flight. Resolves false when nothing was running. */
	stop(): Promise<boolean>;
	/** Subscribes to turn events. Returns an unsubscribe. */
	onChatEvent(listener: (event: ChatStreamEvent) => void): Unsubscribe;

	// ── window ────────────────────────────────────────────────────────────────

	/** Minimises the window. */
	minimizeWindow(): Promise<boolean>;
	/**
	 * Maximises, or restores from maximised.
	 *
	 * Resolves with the state the window ended in, so the button's glyph is
	 * never a guess about what the window is doing.
	 */
	toggleMaximizeWindow(): Promise<WindowState>;
	/** Closes the window. */
	closeWindow(): Promise<boolean>;
	/**
	 * Begins a resize drag on one edge or corner.
	 *
	 * The bounds and the pointer position are captured here, once, rather than
	 * on every move: each subsequent `resizeWindow` is then a delta applied to
	 * that snapshot, so a slow drag and a fast one land in the same place.
	 */
	startWindowResize(direction: ResizeDirection): Promise<boolean>;
	/** Extends the drag in progress to the pointer's current screen position. */
	moveWindowResize(x: number, y: number): Promise<boolean>;
	/** Ends the drag. Safe to call when no drag is in progress. */
	endWindowResize(): Promise<boolean>;
	/** Subscribes to maximize/restore changes. Returns an unsubscribe. */
	onWindowState(listener: (state: WindowState) => void): Unsubscribe;
}

/**
 * What the window itself is doing.
 *
 * The renderer needs this for the maximize button's glyph, and it cannot work
 * it out: a frameless window has no OS title bar to read, and the button knows
 * only what it last asked for.
 */
export interface WindowState {
	readonly maximized: boolean;
}

/** The global the preload installs. Named to avoid clashing with page globals. */
export const BRIDGE_KEY = 'seshyina';

/** Thrown when a bridge payload cannot be trusted. */
export class BridgePayloadError extends Error {
	constructor(reason: string) {
		super(`The bridge payload is unusable: ${reason}`);
		this.name = 'BridgePayloadError';
	}
}

// ── inbound: main validating what the renderer sent ─────────────────────────

/**
 * Narrows what the renderer sent into a `SaveProviderInput`.
 *
 * The API key is checked for being a string and nothing more — never inspected,
 * logged or echoed. Naming the offending *field* is enough to debug, and the
 * value must not travel through any message.
 */
export function parseSaveProviderInput(value: unknown): SaveProviderInput {
	if (!isObject(value)) {
		throw new BridgePayloadError(`saveProvider expects an object, received ${describe(value)}`);
	}
	const { id, name, baseUrl, apiKey } = value;

	if (typeof baseUrl !== 'string' || baseUrl.trim().length === 0) {
		throw new BridgePayloadError('baseUrl must be a non-empty string');
	}
	if (id !== undefined && (typeof id !== 'string' || id.length === 0)) {
		throw new BridgePayloadError('id must be a non-empty string when present');
	}
	if (name !== undefined && typeof name !== 'string') {
		throw new BridgePayloadError('name must be a string when present');
	}
	if (apiKey !== undefined && typeof apiKey !== 'string') {
		throw new BridgePayloadError('apiKey must be a string when present');
	}

	return {
		baseUrl: baseUrl.trim(),
		...(id !== undefined ? { id } : {}),
		...(name !== undefined && name.length > 0 ? { name } : {}),
		...(apiKey !== undefined ? { apiKey } : {}),
	};
}

/** Narrows what the renderer sent into a `SendMessageInput`. */
export function parseSendMessageInput(value: unknown): SendMessageInput {
	if (!isObject(value)) {
		throw new BridgePayloadError(`sendMessage expects an object, received ${describe(value)}`);
	}
	const { providerId, conversationId, model, messages } = value;

	if (typeof providerId !== 'string' || providerId.length === 0) {
		throw new BridgePayloadError('providerId must be a non-empty string');
	}
	// Required, not inferred: with several conversations, guessing which one is
	// meant would put the turn in the wrong transcript.
	if (typeof conversationId !== 'string' || conversationId.length === 0) {
		throw new BridgePayloadError('conversationId must be a non-empty string');
	}
	if (typeof model !== 'string' || model.length === 0) {
		throw new BridgePayloadError('model must be a non-empty string');
	}
	if (!Array.isArray(messages)) {
		throw new BridgePayloadError('messages must be an array');
	}

	const allowed = new Set<string>(['system', 'user', 'assistant', 'tool']);
	const parsed: { role: ChatRole; content: string }[] = [];
	for (const entry of messages) {
		if (!isObject(entry)) {
			throw new BridgePayloadError('each message must be an object');
		}
		if (typeof entry.role !== 'string' || !allowed.has(entry.role)) {
			throw new BridgePayloadError(
				`message role must be one of system, user, assistant, tool — received ${JSON.stringify(entry.role)}`,
			);
		}
		if (typeof entry.content !== 'string') {
			throw new BridgePayloadError('message content must be a string');
		}
		parsed.push({ role: entry.role as ChatRole, content: entry.content });
	}
	if (parsed.length === 0) {
		throw new BridgePayloadError('messages must not be empty');
	}

	return { providerId, conversationId, model, messages: parsed };
}

/**
 * Narrows the model list main assembled from every provider.
 *
 * Each entry is checked on its own, and a malformed one is dropped rather than
 * failing the list: these come from third-party `/models` responses, and one
 * provider returning something odd must not cost the user every model the
 * others offer.
 */
export function parseAvailableModels(value: unknown): readonly AvailableModel[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const models: AvailableModel[] = [];
	for (const entry of value) {
		if (
			isObject(entry) &&
			typeof entry.providerId === 'string' &&
			entry.providerId.length > 0 &&
			typeof entry.providerName === 'string' &&
			typeof entry.model === 'string' &&
			entry.model.length > 0
		) {
			models.push({
				providerId: entry.providerId,
				providerName: entry.providerName,
				model: entry.model,
			});
		}
	}
	return models;
}

/** Narrows a provider id the renderer sent. */
export function parseProviderId(value: unknown): string {
	if (typeof value !== 'string' || value.length === 0) {
		throw new BridgePayloadError('providerId must be a non-empty string');
	}
	return value;
}

/**
 * Narrows a resize direction the renderer sent.
 *
 * Checked against the eight literal values rather than accepted as any string.
 * These arrive from a `<div>` in the page and are handed straight to the
 * geometry code, where an unexpected value would fall through every edge case
 * and silently resize nothing — or, worse, be read as truthy somewhere and
 * resize the wrong boundary.
 */
export function parseResizeDirection(value: unknown): ResizeDirection {
	if (typeof value !== 'string' || !RESIZE_DIRECTIONS.includes(value as ResizeDirection)) {
		throw new BridgePayloadError(
			`direction must be one of ${RESIZE_DIRECTIONS.join(', ')}`,
		);
	}
	return value as ResizeDirection;
}

const RESIZE_DIRECTIONS: readonly ResizeDirection[] = [
	'n',
	's',
	'e',
	'w',
	'ne',
	'nw',
	'se',
	'sw',
];

/**
 * Narrows a screen coordinate from a resize drag.
 *
 * Only finite numbers pass. `NaN` reaching the geometry below would make every
 * bound `NaN`, and `setBounds` with a `NaN` leaves the window with no usable
 * size — the one failure in this file with no way back.
 */
export function parseCoordinate(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw new BridgePayloadError('a resize coordinate must be a finite number');
	}
	return value;
}

/** Narrows the window state main pushed to the renderer. */
export function parseWindowState(value: unknown): WindowState {
	if (!isObject(value) || typeof value.maximized !== 'boolean') {
		throw new BridgePayloadError('window state needs a boolean maximized flag');
	}
	return { maximized: value.maximized };
}

/** Narrows what the renderer sent into a `CreateConversationInput`. */
export function parseCreateConversationInput(value: unknown): CreateConversationInput {
	if (!isObject(value)) {
		throw new BridgePayloadError(
			`createConversation expects an object, received ${describe(value)}`,
		);
	}
	const { providerId, projectId, title, systemPrompt } = value;

	if (typeof providerId !== 'string' || providerId.length === 0) {
		throw new BridgePayloadError('providerId must be a non-empty string');
	}
	// `projectId` must be read here. It was added to `CreateConversationInput`
	// after this parser was written, and a parser that does not destructure a
	// field drops it silently — the conversation was created with no workspace and
	// every filesystem tool refused with "needs a workspace", while the type said
	// the field was optional and nothing complained.
	if (projectId !== undefined && (typeof projectId !== 'string' || projectId.length === 0)) {
		throw new BridgePayloadError('projectId must be a non-empty string when present');
	}
	if (title !== undefined && typeof title !== 'string') {
		throw new BridgePayloadError('title must be a string when present');
	}
	if (systemPrompt !== undefined && typeof systemPrompt !== 'string') {
		throw new BridgePayloadError('systemPrompt must be a string when present');
	}

	return {
		providerId,
		...(projectId !== undefined ? { projectId } : {}),
		...(title !== undefined && title.trim().length > 0 ? { title } : {}),
		...(systemPrompt !== undefined ? { systemPrompt } : {}),
	};
}

/** Narrows a project the renderer sent. */
export function parseCreateProjectInput(value: unknown): {
	readonly name?: string;
	readonly rootPath: string;
} {
	if (!isObject(value)) {
		throw new BridgePayloadError(`createProject expects an object, received ${describe(value)}`);
	}
	const { name, rootPath } = value;
	// A blank name is omitted rather than rejected: the session derives one from
	// the folder, and a user who typed only a path should not have to invent a
	// label as well.
	if (name !== undefined && typeof name !== 'string') {
		throw new BridgePayloadError('name must be a string when present');
	}
	if (typeof rootPath !== 'string' || rootPath.trim().length === 0) {
		throw new BridgePayloadError('a project needs a non-empty rootPath');
	}
	return {
		rootPath: rootPath.trim(),
		...(typeof name === 'string' && name.trim().length > 0 ? { name: name.trim() } : {}),
	};
}

/** Narrows an unknown value into a `ProjectListItem`. */
export function parseProjectListItem(value: unknown): ProjectListItem {
	if (!isObject(value)) {
		throw new BridgePayloadError(`expected a project, received ${describe(value)}`);
	}
	const { id, name, rootPath } = value;
	if (typeof id !== 'string' || id.length === 0) {
		throw new BridgePayloadError('project id must be a non-empty string');
	}
	if (typeof name !== 'string' || name.length === 0) {
		throw new BridgePayloadError('project name must be a non-empty string');
	}
	if (typeof rootPath !== 'string' || rootPath.length === 0) {
		throw new BridgePayloadError('project rootPath must be a non-empty string');
	}
	return { id, name, rootPath };
}

/** Narrows an unknown value into a list of `ProjectListItem`. */
export function parseProjectListItems(value: unknown): readonly ProjectListItem[] {
	if (!Array.isArray(value)) {
		throw new BridgePayloadError(`expected an array, received ${describe(value)}`);
	}
	return value.map(parseProjectListItem);
}

/** Narrows what the renderer sent in answer to a permission request. */
export function parsePermissionAnswer(value: unknown): PermissionAnswer {
	if (!isObject(value)) {
		throw new BridgePayloadError(
			`a permission answer must be an object, received ${describe(value)}`,
		);
	}
	const { id, decision } = value;
	if (typeof id !== 'string' || id.length === 0) {
		throw new BridgePayloadError('a permission answer needs a non-empty id');
	}
	// No third option, matching the Core's `PermissionDecision`: anything the
	// renderer invents is refused rather than guessed at.
	if (decision !== 'allow' && decision !== 'deny') {
		throw new BridgePayloadError(`decision must be allow or deny, received ${JSON.stringify(decision)}`);
	}
	return { id, decision };
}

/** Narrows a conversation id the renderer sent. */
export function parseConversationId(value: unknown): string {
	if (typeof value !== 'string' || value.length === 0) {
		throw new BridgePayloadError('conversationId must be a non-empty string');
	}
	return value;
}

/** Narrows a conversation title the renderer sent. Empty is rejected. */
export function parseConversationTitle(value: unknown): string {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new BridgePayloadError('a conversation title must be a non-empty string');
	}
	return value;
}

/**
 * Narrows a system prompt the renderer sent.
 *
 * Unlike a title, an empty string is allowed and meaningful: it clears the
 * prompt. Refusing it here would leave the user unable to remove one.
 */
export function parseSystemPrompt(value: unknown): string {
	if (typeof value !== 'string') {
		throw new BridgePayloadError('a system prompt must be a string');
	}
	return value;
}

// ── outbound: preload and renderer validating what main sent ────────────────

/** Narrows an unknown value into a `CoreStatus`. */
export function parseCoreStatus(value: unknown): CoreStatus {
	if (!isObject(value)) {
		throw new BridgePayloadError(`expected an object, received ${describe(value)}`);
	}
	const { appName, version, electronVersion, platform, services, providerCount, dataDirectory } = value;

	if (typeof appName !== 'string' || appName.length === 0) {
		throw new BridgePayloadError('appName must be a non-empty string');
	}
	if (typeof version !== 'string' || version.length === 0) {
		throw new BridgePayloadError('version must be a non-empty string');
	}
	if (typeof electronVersion !== 'string' || electronVersion.length === 0) {
		throw new BridgePayloadError('electronVersion must be a non-empty string');
	}
	if (typeof platform !== 'string' || platform.length === 0) {
		throw new BridgePayloadError('platform must be a non-empty string');
	}
	if (!Array.isArray(services) || !services.every((id) => typeof id === 'string')) {
		throw new BridgePayloadError('services must be an array of strings');
	}
	if (typeof providerCount !== 'number' || !Number.isFinite(providerCount) || providerCount < 0) {
		throw new BridgePayloadError('providerCount must be a non-negative number');
	}
	if (typeof dataDirectory !== 'string' || dataDirectory.length === 0) {
		throw new BridgePayloadError('dataDirectory must be a non-empty string');
	}

	return {
		appName,
		version,
		electronVersion,
		platform,
		// Copied, so a later mutation of the source array cannot change what
		// the caller already validated.
		services: [...(services as string[])],
		providerCount,
		dataDirectory,
	};
}

/** Narrows an unknown value into a `ProviderSummary`. */
export function parseProviderSummary(value: unknown): ProviderSummary {
	if (!isObject(value)) {
		throw new BridgePayloadError(`expected a provider object, received ${describe(value)}`);
	}
	const { id, name, baseUrl, status, hasApiKeyRef, models } = value;

	if (typeof id !== 'string' || id.length === 0) {
		throw new BridgePayloadError('provider id must be a non-empty string');
	}
	if (typeof name !== 'string' || name.length === 0) {
		throw new BridgePayloadError('provider name must be a non-empty string');
	}
	if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
		throw new BridgePayloadError('provider baseUrl must be a non-empty string');
	}
	if (
		status !== 'unconfigured' &&
		status !== 'configured' &&
		status !== 'available' &&
		status !== 'error' &&
		status !== 'disabled'
	) {
		throw new BridgePayloadError(`unknown provider status ${JSON.stringify(status)}`);
	}
	if (typeof hasApiKeyRef !== 'boolean') {
		throw new BridgePayloadError('hasApiKeyRef must be a boolean');
	}
	if (!Array.isArray(models) || !models.every((model) => typeof model === 'string')) {
		throw new BridgePayloadError('provider models must be an array of strings');
	}

	return {
		id,
		name,
		baseUrl,
		status,
		hasApiKeyRef,
		// Copied for the same reason as `services` above.
		models: [...(models as string[])],
	};
}

/** Narrows an unknown value into a list of `ProviderSummary`. */
export function parseProviderSummaries(value: unknown): readonly ProviderSummary[] {
	if (!Array.isArray(value)) {
		throw new BridgePayloadError(`expected an array, received ${describe(value)}`);
	}
	return value.map(parseProviderSummary);
}

/** Narrows an unknown value into a `ConversationListItem`. */
export function parseConversationListItem(value: unknown): ConversationListItem {
	if (!isObject(value)) {
		throw new BridgePayloadError(`expected a conversation, received ${describe(value)}`);
	}
	const { id, title, providerId, projectId, createdAt, updatedAt, messageCount } = value;

	if (typeof id !== 'string' || id.length === 0) {
		throw new BridgePayloadError('conversation id must be a non-empty string');
	}
	if (typeof title !== 'string' || title.length === 0) {
		throw new BridgePayloadError('conversation title must be a non-empty string');
	}
	if (typeof providerId !== 'string' || providerId.length === 0) {
		throw new BridgePayloadError('conversation providerId must be a non-empty string');
	}
	if (typeof createdAt !== 'string' || createdAt.length === 0) {
		throw new BridgePayloadError('conversation createdAt must be a non-empty string');
	}
	if (typeof updatedAt !== 'string' || updatedAt.length === 0) {
		throw new BridgePayloadError('conversation updatedAt must be a non-empty string');
	}
	if (typeof messageCount !== 'number' || !Number.isFinite(messageCount) || messageCount < 0) {
		throw new BridgePayloadError('conversation messageCount must be a non-negative number');
	}

	return {
		id,
		title,
		providerId,
		...(typeof projectId === 'string' && projectId.length > 0 ? { projectId } : {}),
		createdAt,
		updatedAt,
		messageCount,
	};
}

/** Narrows an unknown value into a list of `ConversationListItem`. */
export function parseConversationListItems(value: unknown): readonly ConversationListItem[] {
	if (!Array.isArray(value)) {
		throw new BridgePayloadError(`expected an array, received ${describe(value)}`);
	}
	return value.map(parseConversationListItem);
}

/** Narrows an unknown value into a `ConversationView`. */
export function parseConversationView(value: unknown): ConversationView {
	if (!isObject(value)) {
		throw new BridgePayloadError(`expected a conversation view, received ${describe(value)}`);
	}
	const { summary, messages, systemPrompt } = value;

	if (typeof systemPrompt !== 'string') {
		throw new BridgePayloadError('systemPrompt must be a string');
	}
	if (!Array.isArray(messages)) {
		throw new BridgePayloadError('messages must be an array');
	}

	const allowed = new Set<string>(['system', 'user', 'assistant', 'tool']);
	const parsed: ConversationMessageView[] = [];
	for (const entry of messages) {
		if (!isObject(entry)) {
			throw new BridgePayloadError('each message must be an object');
		}
		if (typeof entry.role !== 'string' || !allowed.has(entry.role)) {
			throw new BridgePayloadError(
				`message role must be one of system, user, assistant, tool — received ${JSON.stringify(entry.role)}`,
			);
		}
		if (typeof entry.content !== 'string') {
			throw new BridgePayloadError('message content must be a string');
		}
		parsed.push({ role: entry.role as ChatRole, content: entry.content });
	}

	return {
		summary: parseConversationListItem(summary),
		// Copied, for the same reason as `services` in `parseCoreStatus`.
		messages: parsed,
		systemPrompt,
	};
}

/** Narrows an unknown value into a `PermissionPrompt`. */
export function parsePermissionPrompt(value: unknown): PermissionPrompt {
	if (!isObject(value)) {
		throw new BridgePayloadError(`expected a permission prompt, received ${describe(value)}`);
	}
	const { id, toolName, action, description, riskLevel, arguments: args, workspace, turnId } = value;

	if (typeof id !== 'string' || id.length === 0) {
		throw new BridgePayloadError('a permission prompt needs a non-empty id');
	}
	if (typeof toolName !== 'string' || toolName.length === 0) {
		throw new BridgePayloadError('a permission prompt needs a non-empty toolName');
	}
	if (typeof action !== 'string' || action.length === 0) {
		throw new BridgePayloadError('a permission prompt needs a non-empty action');
	}
	if (typeof description !== 'string') {
		throw new BridgePayloadError('a permission prompt needs string description');
	}
	if (riskLevel !== 'safe' && riskLevel !== 'moderate' && riskLevel !== 'dangerous') {
		throw new BridgePayloadError(`unknown riskLevel ${JSON.stringify(riskLevel)}`);
	}
	if (typeof turnId !== 'string' || turnId.length === 0) {
		throw new BridgePayloadError('a permission prompt needs a non-empty turnId');
	}
	if (!Array.isArray(args)) {
		throw new BridgePayloadError('a permission prompt needs an arguments array');
	}
	for (const entry of args) {
		if (
			!isObject(entry) ||
			typeof entry.name !== 'string' ||
			typeof entry.value !== 'string'
		) {
			throw new BridgePayloadError('each permission argument needs string name and value');
		}
	}
	if (workspace !== undefined && typeof workspace !== 'string') {
		throw new BridgePayloadError('a permission workspace must be a string when present');
	}

	return {
		id,
		toolName,
		action,
		description,
		riskLevel,
		// Copied, so a later mutation cannot change what was validated.
		arguments: args.map((entry) => ({ name: (entry as { name: string }).name, value: (entry as { value: string }).value })),
		...(workspace !== undefined ? { workspace } : {}),
		turnId,
	};
}

/** Narrows an unknown value into a `SendMessageAck`. */
export function parseSendMessageAck(value: unknown): SendMessageAck {
	if (!isObject(value)) {
		throw new BridgePayloadError(`expected an ack object, received ${describe(value)}`);
	}
	const { turnId, accepted } = value;
	if (typeof turnId !== 'string' || turnId.length === 0) {
		throw new BridgePayloadError('turnId must be a non-empty string');
	}
	if (accepted !== true) {
		throw new BridgePayloadError('accepted must be true');
	}
	return { turnId, accepted };
}

/**
 * Narrows an unknown value into a `ChatStreamEvent`.
 *
 * The event types are closed and each carries its own fields. A payload that
 * does not fit is refused rather than partially accepted, so the renderer never
 * renders an event it does not understand.
 */
export function parseChatStreamEvent(value: unknown): ChatStreamEvent {
	if (!isObject(value)) {
		throw new BridgePayloadError(`expected an event object, received ${describe(value)}`);
	}
	const { type, turnId } = value;

	if (typeof turnId !== 'string' || turnId.length === 0) {
		throw new BridgePayloadError('every chat event needs a non-empty turnId');
	}

	switch (type) {
		case 'started':
			return { type, turnId };
		case 'delta':
			if (typeof value.text !== 'string') {
				throw new BridgePayloadError('a delta event needs string text');
			}
			return { type, turnId, text: value.text };
		case 'reasoning':
			if (typeof value.text !== 'string') {
				throw new BridgePayloadError('a reasoning event needs string text');
			}
			return { type, turnId, text: value.text };
		case 'toolCall': {
			if (!isObject(value.call)) {
				throw new BridgePayloadError('a toolCall event needs a call object');
			}
			const { id, name, rawArguments, malformed } = value.call;
			if (typeof id !== 'string' || id.length === 0) {
				throw new BridgePayloadError('a tool call needs a non-empty id');
			}
			if (typeof name !== 'string' || name.length === 0) {
				throw new BridgePayloadError('a tool call needs a non-empty name');
			}
			if (typeof rawArguments !== 'string') {
				throw new BridgePayloadError('a tool call needs string rawArguments');
			}
			if (typeof malformed !== 'boolean') {
				throw new BridgePayloadError('a tool call needs a boolean malformed flag');
			}
			if (typeof value.awaitingPermission !== 'boolean') {
				throw new BridgePayloadError('a toolCall event needs a boolean awaitingPermission');
			}
			return { type, turnId, call: { id, name, rawArguments, malformed }, awaitingPermission: value.awaitingPermission };
		}
		case 'toolResult': {
			if (typeof value.callId !== 'string' || value.callId.length === 0) {
				throw new BridgePayloadError('a toolResult event needs a non-empty callId');
			}
			if (typeof value.name !== 'string' || value.name.length === 0) {
				throw new BridgePayloadError('a toolResult event needs a non-empty name');
			}
			if (typeof value.ok !== 'boolean') {
				throw new BridgePayloadError('a toolResult event needs a boolean ok flag');
			}
			if (typeof value.output !== 'string') {
				throw new BridgePayloadError('a toolResult event needs string output');
			}
			return {
				type,
				turnId,
				callId: value.callId,
				name: value.name,
				ok: value.ok,
				output: value.output,
			};
		}
		case 'permissionRequested': {
			if (typeof value.prompt !== 'object' || value.prompt === null) {
				throw new BridgePayloadError('a permissionRequested event needs a prompt object');
			}
			return { type, turnId, prompt: parsePermissionPrompt(value.prompt) };
		}
		case 'permissionResolved': {
			if (typeof value.id !== 'string' || value.id.length === 0) {
				throw new BridgePayloadError('a permissionResolved event needs a non-empty id');
			}
			if (typeof value.toolName !== 'string' || value.toolName.length === 0) {
				throw new BridgePayloadError('a permissionResolved event needs a non-empty toolName');
			}
			if (value.decision !== 'allow' && value.decision !== 'deny') {
				throw new BridgePayloadError('a permissionResolved event needs allow or deny');
			}
			if (value.source !== 'user' && value.source !== 'cancelled') {
				throw new BridgePayloadError('a permissionResolved event needs user or cancelled');
			}
			return {
				type,
				turnId,
				id: value.id,
				toolName: value.toolName,
				decision: value.decision,
				source: value.source,
			};
		}
		case 'done':
			if (typeof value.content !== 'string') {
				throw new BridgePayloadError('a done event needs string content');
			}
			if (typeof value.reason !== 'string' || value.reason.length === 0) {
				throw new BridgePayloadError('a done event needs a non-empty reason');
			}
			if (typeof value.toolCalls !== 'number' || !Number.isFinite(value.toolCalls) || value.toolCalls < 0) {
				throw new BridgePayloadError('a done event needs a non-negative toolCalls count');
			}
			return {
				type,
				turnId,
				content: value.content,
				reason: value.reason,
				toolCalls: value.toolCalls,
			};
		case 'error':
			// The string is what matters, not its length: an error event dropped
			// for carrying `''` is a terminal event the renderer never sees, and
			// the turn it belongs to stays "running" on screen forever. The
			// renderer shows a placeholder when there is no text to show.
			if (typeof value.message !== 'string') {
				throw new BridgePayloadError('an error event needs a message');
			}
			return { type, turnId, message: value.message };
		default:
			throw new BridgePayloadError(`unknown chat event type ${JSON.stringify(type)}`);
	}
}

// ── bridge access and error presentation ───────────────────────────────────

/**
 * Reads the bridge off the renderer's global, or `undefined` when it is absent.
 *
 * The renderer must work when opened outside Electron — a plain browser, or a
 * test harness — so it never assumes the preload ran.
 */
export function readBridge(scope: unknown): SeshyinaBridge | undefined {
	if (typeof scope !== 'object' || scope === null) {
		return undefined;
	}
	const candidate = (scope as Record<string, unknown>)[BRIDGE_KEY];
	if (
		typeof candidate !== 'object' ||
		candidate === null ||
		typeof (candidate as { getCoreStatus?: unknown }).getCoreStatus !== 'function' ||
		typeof (candidate as { sendMessage?: unknown }).sendMessage !== 'function'
	) {
		return undefined;
	}
	return candidate as SeshyinaBridge;
}

/**
 * Turns anything thrown into a message safe to show a user.
 *
 * `invoke` mangles errors crossing the bridge, so the raw value can arrive as
 * the string `"Error: some message"` or as a bare object. Anything without a
 * usable message becomes the caller's fallback rather than `[object Object]`.
 */
export function toDisplayMessage(error: unknown, fallback: string): string {
	if (error instanceof Error && error.message.length > 0) {
		return stripIpcNoise(error.message).trim() || fallback;
	}
	if (typeof error === 'string' && error.length > 0) {
		return stripIpcNoise(error).trim() || fallback;
	}
	return fallback;
}

/**
 * Removes the layers Electron adds when an error crosses `invoke`.
 *
 * The mangled form nests two: the outer wrapper names the channel, and the inner
 * `Error:` belongs to the error that was rethrown in main. Both are noise the
 * user does not act on — "could not reach the host" is the part worth reading.
 * Done as repeated single-step replacements because the layers can appear in
 * either order depending on how the error was thrown.
 */
function stripIpcNoise(message: string): string {
	let current = message;
	for (let pass = 0; pass < 3; pass += 1) {
		const next = current
			.replace(/^Error invoking remote method '[^']*':\s*/, '')
			.replace(/^Error:\s*/, '');
		if (next === current) {
			return current;
		}
		current = next;
	}
	return current;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
	if (value === null) {
		return 'null';
	}
	return Array.isArray(value) ? 'an array' : typeof value;
}