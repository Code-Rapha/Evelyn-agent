/**
 * The preload bridge.
 *
 * Runs in an isolated world, before the page loads, with access to Electron's
 * `ipcRenderer` — and nothing else the page has.
 *
 * What it deliberately does **not** do:
 *
 * - It does not forward `ipcRenderer`. Handing the page the raw object would give
 *   it every channel main has, now and after any future change. Instead it
 *   exposes one frozen method per capability, so widening the app's reach is a
 *   code change someone has to write on purpose.
 * - It does not return Electron objects, promises or errors across the bridge.
 *   Only plain JSON crosses, because anything else keeps a live reference into
 *   main that the page could keep using after it should have expired.
 * - It does not hold conversation state. Each listener gets the event directly;
 *   the preload keeps no memory of what was said.
 *
 * The API key is the one secret that crosses *in*. It is validated as a string,
 * forwarded, and handed straight to main's `SecretStore`. The preload never
 * stores it, never logs it, and never sends it back.
 *
 * `contextBridge.exposeInMainWorld` deep-copies the object into the page's
 * world, so page code gets a plain object and not this closure.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
	BRIDGE_KEY,
	CHAT_EVENT_CHANNEL,
	CONVERSATION_CHANNEL,
	CORE_STATUS_CHANNEL,
	PROJECT_CHANNEL,
	PROVIDER_CHANNEL,
	MODEL_CHANNEL,
	OPEN_SETTINGS_CHANNEL,
	SEND_MESSAGE_CHANNEL,
	PERMISSION_DECISION_CHANNEL,
	STOP_CHANNEL,
	WINDOW_CHANNEL,
	WINDOW_STATE_CHANNEL,
	parseChatStreamEvent,
	parseAvailableModels,
	parseCoordinate,
	parseResizeDirection,
	parseWindowState,
	parseConversationId,
	parseConversationListItem,
	parseConversationListItems,
	parseConversationTitle,
	parseConversationView,
	parseCoreStatus,
	parseCreateConversationInput,
	parseProjectListItem,
	parseProjectListItems,
	parseCreateProjectInput,
	parseProviderId,
	parseProviderSummaries,
	parseProviderSummary,
	parseSaveProviderInput,
	parseSendMessageAck,
	parsePermissionAnswer,
	parseSendMessageInput,
	parseSystemPrompt,
	type ChatStreamEvent,
	type CreateConversationInput,
	type ProjectListItem,
	type SaveProviderInput,
	type SeshyinaBridge,
	type ResizeDirection,
	type WindowState,
	type SendMessageInput,
	type PermissionAnswer,
} from './contract';

/**
 * Errors do not survive `invoke` — they arrive as a mangled string. Rewrapping
 * keeps the renderer from having to care: it catches either way.
 */
function rethrow(error: unknown): never {
	throw new Error(error instanceof Error ? error.message : String(error));
}

const bridge: SeshyinaBridge = Object.freeze({
	async getCoreStatus() {
		try {
			return parseCoreStatus(await ipcRenderer.invoke(CORE_STATUS_CHANNEL));
		} catch (error) {
			rethrow(error);
		}
	},

	async listProviders() {
		try {
			return parseProviderSummaries(await ipcRenderer.invoke(PROVIDER_CHANNEL, 'list'));
		} catch (error) {
			rethrow(error);
		}
	},

	async listProjects() {
		try {
			return parseProjectListItems(await ipcRenderer.invoke(PROJECT_CHANNEL, 'list'));
		} catch (error) {
			rethrow(error);
		}
	},

	async createProject(input: { name: string; rootPath: string }) {
		try {
			return parseProjectListItem(
				await ipcRenderer.invoke(
					PROJECT_CHANNEL,
					'create',
					parseCreateProjectInput(input),
				),
			);
		} catch (error) {
			rethrow(error);
		}
	},

	async saveProvider(input: SaveProviderInput) {
		try {
			return parseProviderSummary(
				await ipcRenderer.invoke(PROVIDER_CHANNEL, 'save', parseSaveProviderInput(input)),
			);
		} catch (error) {
			rethrow(error);
		}
	},

	async removeProvider(providerId: string) {
		try {
			const removed: unknown = await ipcRenderer.invoke(
				PROVIDER_CHANNEL,
				'remove',
				parseProviderId(providerId),
			);
			return removed === true;
		} catch (error) {
			rethrow(error);
		}
	},

	async listModels(providerId: string) {
		try {
			const models: unknown = await ipcRenderer.invoke(
				PROVIDER_CHANNEL,
				'models',
				parseProviderId(providerId),
			);
			if (!Array.isArray(models) || !models.every((model) => typeof model === 'string')) {
				throw new Error('The provider returned an unusable model list');
			}
			// Copied, so the array handed out is not the live one from IPC.
			return [...(models as string[])];
		} catch (error) {
			rethrow(error);
		}
	},

	async openSettings() {
		try {
			return (await ipcRenderer.invoke(OPEN_SETTINGS_CHANNEL)) === true;
		} catch (error) {
			rethrow(error);
		}
	},

	async listAvailableModels() {
		try {
			return parseAvailableModels(await ipcRenderer.invoke(MODEL_CHANNEL, 'available'));
		} catch (error) {
			rethrow(error);
		}
	},

	async createConversation(input: CreateConversationInput) {
		try {
			return parseConversationView(
				await ipcRenderer.invoke(
					CONVERSATION_CHANNEL,
					'create',
					parseCreateConversationInput(input),
				),
			);
		} catch (error) {
			rethrow(error);
		}
	},

	async listConversations(providerId: string) {
		try {
			return parseConversationListItems(
				await ipcRenderer.invoke(
					CONVERSATION_CHANNEL,
					'list',
					parseProviderId(providerId),
				),
			);
		} catch (error) {
			rethrow(error);
		}
	},

	async openConversation(conversationId: string) {
		try {
			return parseConversationView(
				await ipcRenderer.invoke(
					CONVERSATION_CHANNEL,
					'open',
					parseConversationId(conversationId),
				),
			);
		} catch (error) {
			rethrow(error);
		}
	},

	async renameConversation(conversationId: string, title: string) {
		try {
			return parseConversationListItem(
				await ipcRenderer.invoke(
					CONVERSATION_CHANNEL,
					'rename',
					{ id: parseConversationId(conversationId), title: parseConversationTitle(title) },
				),
			);
		} catch (error) {
			rethrow(error);
		}
	},

	async setSystemPrompt(conversationId: string, content: string) {
		try {
			return parseConversationListItem(
				await ipcRenderer.invoke(
					CONVERSATION_CHANNEL,
					'system-prompt',
					{ id: parseConversationId(conversationId), content: parseSystemPrompt(content) },
				),
			);
		} catch (error) {
			rethrow(error);
		}
	},

	async deleteConversation(conversationId: string) {
		try {
			const removed: unknown = await ipcRenderer.invoke(
				CONVERSATION_CHANNEL,
				'delete',
				parseConversationId(conversationId),
			);
			return removed === true;
		} catch (error) {
			rethrow(error);
		}
	},

	async sendMessage(input: SendMessageInput) {
		try {
			return parseSendMessageAck(
				await ipcRenderer.invoke(SEND_MESSAGE_CHANNEL, parseSendMessageInput(input)),
			);
		} catch (error) {
			rethrow(error);
		}
	},

	async answerPermission(answer: PermissionAnswer) {
		try {
			// Validated before it crosses. The renderer is the untrusted side of
			// this boundary, so a decision only counts as a decision once the main
			// process has narrowed it — and a malformed one never reaches the
			// broker, which would otherwise have to defend itself.
			return (await ipcRenderer.invoke(
				PERMISSION_DECISION_CHANNEL,
				parsePermissionAnswer(answer),
			)) === true;
		} catch (error) {
			rethrow(error);
		}
	},

	async stop() {
		try {
			return (await ipcRenderer.invoke(STOP_CHANNEL)) === true;
		} catch (error) {
			rethrow(error);
		}
	},

	async minimizeWindow() {
		try {
			return (await ipcRenderer.invoke(WINDOW_CHANNEL, 'minimize')) === true;
		} catch (error) {
			rethrow(error);
		}
	},

	async toggleMaximizeWindow() {
		try {
			const result: unknown = await ipcRenderer.invoke(WINDOW_CHANNEL, 'toggle-maximize');
			return parseWindowState(result);
		} catch (error) {
			rethrow(error);
		}
	},

	async closeWindow() {
		try {
			return (await ipcRenderer.invoke(WINDOW_CHANNEL, 'close')) === true;
		} catch (error) {
			rethrow(error);
		}
	},

	async startWindowResize(direction: ResizeDirection) {
		try {
			return (
				(await ipcRenderer.invoke(
					WINDOW_CHANNEL,
					'resize-start',
					parseResizeDirection(direction),
				)) === true
			);
		} catch (error) {
			rethrow(error);
		}
	},

	async moveWindowResize(x: number, y: number) {
		try {
			return (
				(await ipcRenderer.invoke(
					WINDOW_CHANNEL,
					'resize-move',
					{ x: parseCoordinate(x), y: parseCoordinate(y) },
				)) === true
			);
		} catch (error) {
			rethrow(error);
		}
	},

	async endWindowResize() {
		try {
			return (await ipcRenderer.invoke(WINDOW_CHANNEL, 'resize-end')) === true;
		} catch (error) {
			rethrow(error);
		}
	},

	onWindowState(listener: (state: WindowState) => void) {
		const handler = (_event: IpcRendererEvent, payload: unknown): void => {
			try {
				listener(parseWindowState(payload));
			} catch {
				// Dropped rather than thrown from inside Electron's emitter, for
				// the same reason as the chat events above: nothing out here would
				// catch it, and the only consequence is a button showing the wrong
				// glyph until the next maximise.
			}
		};
		ipcRenderer.on(WINDOW_STATE_CHANNEL, handler);

		let removed = false;
		return () => {
			if (removed) {
				return;
			}
			removed = true;
			ipcRenderer.removeListener(WINDOW_STATE_CHANNEL, handler);
		};
	},

	onChatEvent(listener: (event: ChatStreamEvent) => void) {
		// `ipcRenderer.on` passes the event object first; it is dropped so the
		// renderer sees only the payload.
		const handler = (_event: IpcRendererEvent, payload: unknown): void => {
			try {
				listener(parseChatStreamEvent(payload));
			} catch {
				// An event that does not parse is dropped rather than thrown from
				// inside Electron's emitter, where nothing would catch it. The
				// turn's own terminal event still arrives and clears the UI.
			}
		};
		ipcRenderer.on(CHAT_EVENT_CHANNEL, handler);

		let removed = false;
		return () => {
			if (removed) {
				return;
			}
			removed = true;
			ipcRenderer.removeListener(CHAT_EVENT_CHANNEL, handler);
		};
	},
});

contextBridge.exposeInMainWorld(BRIDGE_KEY, bridge);