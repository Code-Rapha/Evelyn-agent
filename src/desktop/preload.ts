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
	BUDGET_CHANNEL,
	DISCOVERY_CHANNEL,
	ACCESS_POLICY_CHANNEL,
	CHAT_EVENT_CHANNEL,
	CONVERSATION_CHANNEL,
	MODEL_GUIDANCE_CHANNEL,
	CORE_STATUS_CHANNEL,
	SERVICE_STATUS_CHANNEL,
	SERVICE_CATALOG_CHANNEL,
	SERVICE_SEND_CHANNEL,
	SERVICE_STOP_CHANNEL,
	SERVICE_PERMISSION_CHANNEL,
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
	type DevOwnerPromptView,
	type DevOwnerPromptAnswerView,
	PROJECT_CHANNEL,
	PROVIDER_CHANNEL,
	MODEL_CHANNEL,
	MODEL_CATALOG_CHANNEL,
	OPEN_SETTINGS_CHANNEL,
	SEND_MESSAGE_CHANNEL,
	SKILL_EVOLUTION_CHANNEL,
	PERMISSION_DECISION_CHANNEL,
	ROUTER_STATE_CHANNEL,
	STOP_CHANNEL,
	WINDOW_CHANNEL,
	WINDOW_STATE_CHANNEL,
	parseChatStreamEvent,
	parseAvailableModels,
	parseCoordinate,
	parseResizeDirection,
	parseBudgetAlertViews,
	parseBudgetReportView,
	parseBudgetWindow,
	parseForecastRequestView,
	parseForecastView,
	parseSaveSpendingLimitViewInput,
	parseSpendingLimitId,
	parseSpendingLimitViews,
	parseWindowState,
	parseConversationId,
	parseConversationListItem,
	parseModelGuidance,
	parseGuidanceEntries,
	parseConversationListItems,
	parseConversationTitle,
	parseConversationView,
	parseModelCatalogEntryView,
	parseModelCatalogEntryViews,
	parseSaveModelCatalogInput,
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
	parseSkillScanView,
	parseSkillProposalView,
	parseSkillProposalViews,
	parseSkillProposalId,
	parseSkillProposalStatus,
	parseSkillContentDiffView,
	parseSkillEvolutionResultView,
	parseSkillVersionViews,
	parseSkillSummaryViews,
	parseAutoSkillStatusView,
	parseSaveSkillImprovementInput,
	parseDecisionReason,
	type SpendingLimitView,
	parseRollbackTarget,
	type BudgetAlertView,
	type BudgetReportView,
	type CallForecastView,
	type ForecastRequestView,
	type SaveSpendingLimitViewInput,
	type ChatStreamEvent,
	type CreateConversationInput,
	type ProjectListItem,
	type ModelCatalogEntryView,
	type ModelCatalogKey,
	type SaveModelCatalogInput,
	type SaveProviderInput,
	type SeshyinaBridge,
	type ResizeDirection,
	type RouterConfigView,
	type TurnRouting,
	type WindowState,
	type SendMessageInput,
	type PermissionAnswer,
	type SkillProposalStatus,
	type SaveSkillImprovementInput,
	type ServiceCatalogReply,
	type ServiceConversationsReply,
	type ServiceConversationReply,
	type ServiceCreateConversationReply,
	type ServiceRenameConversationReply,
	type ServiceDeleteConversationReply,
	type ServiceTurnStatesReply,
	type ServiceLinkStatus,
	type ServicePanelReply,
	type ServiceControlReply,
	type ServiceControlState,
	type UiBootStateView,
} from './contract';
import {
	parseDiscoveredModelViews,
	parseDiscoveredQuotaViews,
} from './discoveryParsers';
import {
	parseAccessPolicyView,
	parseMergedCatalog,
} from './catalogFusionParsers';
import { parseRoutingDecisionReports } from './decisionReportParsers';
import { parseRouterConfigView } from './routerConfigParsers';
import { parseExecutionComparison, parseExecutionHistory } from './executionHistoryParsers';
import { parseDevActionResult, parseDevPanelState, parseDevRunHistoryEntry } from './devView';
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

	/**
	 * O estado do serviço local independente.
	 *
	 * Leitura pura: quando não há serviço, volta `inactive` com o motivo.
	 * Nunca traz credencial — o processo principal devolve só o status.
	 */
	async getServiceStatus() {		try {
			return (await ipcRenderer.invoke(SERVICE_STATUS_CHANNEL)) as ServiceLinkStatus;
		} catch (error) {
			rethrow(error);
		}
	},

	/** DEV-4: o estado de abertura da janela (conversa e aviso). */
	async getUiBootState() {
		try {
			return (await ipcRenderer.invoke(UI_SESSION_CHANNEL, 'boot')) as UiBootStateView;
		} catch (error) {
			rethrow(error);
		}
	},

	/** DEV-4: grava a conversa aberta e se há geração em curso. */
	async setUiSession(input: { readonly conversationId?: string; readonly generating?: boolean }) {
		try {
			await ipcRenderer.invoke(UI_SESSION_CHANNEL, 'set', input);
		} catch (error) {
			rethrow(error);
		}
	},

	/** R4R: abre o painel do serviço no navegador; o main monta o endereço. */
	async openServicePanel() {
		try {
			return (await ipcRenderer.invoke(SERVICE_PANEL_CHANNEL)) as ServicePanelReply;
		} catch (error) {
			rethrow(error);
		}
	},

	/** O estado do serviço, sem agir sobre ele. */
	async readServiceControl() {
		try {
			return (await ipcRenderer.invoke(SERVICE_CONTROL_CHANNEL, 'read')) as ServiceControlState;
		} catch (error) {
			rethrow(error);
		}
	},

	/** Liga ou desliga o serviço, esperando o health (ligar) ou a saída (desligar). */
	async setServiceRunning(on: boolean) {
		try {
			return (await ipcRenderer.invoke(SERVICE_CONTROL_CHANNEL, on ? 'on' : 'off')) as ServiceControlReply;
		} catch (error) {
			rethrow(error);
		}
	},

	/**
	 * Encerra o serviço e reabre o app em **modo local**.
	 *
	 * É o que faz o modo DEV existir: ele só trabalha quando o Core é deste
	 * processo. Resolve quando o pedido foi aceito — o app reinicia em seguida.
	 */
	async restartInLocalMode() {
		try {
			return (await ipcRenderer.invoke(SERVICE_CONTROL_CHANNEL, 'restart-local')) as
				| { readonly ok: true }
				| { readonly ok: false; readonly message: string };
		} catch (error) {
			rethrow(error);
		}
	},

	/**
	 * O catálogo do serviço local, ou o motivo de não haver.
	 *
	 * Diferente de `listModels`: este não consulta o Core deste processo, e
	 * por isso funciona informando o que o serviço tem (ou que ele não está
	 * ativo) sem depender de o Core local estar montado.
	 */
	async getServiceCatalog() {
		try {
			return (await ipcRenderer.invoke(SERVICE_CATALOG_CHANNEL)) as ServiceCatalogReply;
		} catch (error) {
			rethrow(error);
		}
	},

	/**
	 * Envia uma mensagem pelo serviço (R4C).
	 *
	 * Os eventos chegam pelo `onChatEvent` de sempre: o modo conectado usa o
	 * mesmo vocabulário do modo local.
	 */
	async sendToService(input: {
		readonly conversationId: string;
		readonly providerId: string;
		readonly model: string;
		readonly text: string;
		readonly routing?: TurnRouting;
	}) {
		try {
			return (await ipcRenderer.invoke(SERVICE_SEND_CHANNEL, input)) as {
				readonly accepted: boolean;
				readonly turnId?: string;
				readonly error?: string;
			};
		} catch (error) {
			rethrow(error);
		}
	},

	/** Cancela um turno do serviço iniciado por este app. */
	async stopServiceTurn(turnId: string) {
		try {
			return (await ipcRenderer.invoke(SERVICE_STOP_CHANNEL, { turnId })) as { readonly stopped: boolean };
		} catch (error) {
			rethrow(error);
		}
	},

	/** Responde a permissão de um turno do serviço. */
	async answerServicePermission(input: {
		readonly turnId: string;
		readonly id: string;
		readonly decision: 'allow' | 'deny';
	}) {
		try {
			return (await ipcRenderer.invoke(SERVICE_PERMISSION_CHANNEL, input)) as {
				readonly answered: boolean;
			};
		} catch (error) {
			rethrow(error);
		}
	},

	/** As conversas do serviço (R4D). */
	async listServiceConversations() {
		try {
			return (await ipcRenderer.invoke(SERVICE_CONVERSATIONS_CHANNEL)) as ServiceConversationsReply;
		} catch (error) {
			rethrow(error);
		}
	},

	/** Uma conversa e o histórico do serviço (R4D). */
	async openServiceConversation(conversationId: string) {
		try {
			return (await ipcRenderer.invoke(SERVICE_CONVERSATION_CHANNEL, {
				conversationId,
			})) as ServiceConversationReply;
		} catch (error) {
			rethrow(error);
		}
	},

	/** Cria uma conversa no serviço (R4E). */
	async createServiceConversation(input: { readonly providerId: string; readonly title?: string }) {
		try {
			return (await ipcRenderer.invoke(SERVICE_CREATE_CHANNEL, input)) as ServiceCreateConversationReply;
		} catch (error) {
			rethrow(error);
		}
	},

	/** Renomeia uma conversa do serviço (R4F). */
	async renameServiceConversation(conversationId: string, title: string) {
		try {
			return (await ipcRenderer.invoke(SERVICE_RENAME_CHANNEL, {
				conversationId,
				title,
			})) as ServiceRenameConversationReply;
		} catch (error) {
			rethrow(error);
		}
	},

	/** Exclui uma conversa do serviço (R4F). */
	async deleteServiceConversation(conversationId: string) {
		try {
			return (await ipcRenderer.invoke(SERVICE_DELETE_CHANNEL, {
				conversationId,
			})) as ServiceDeleteConversationReply;
		} catch (error) {
			rethrow(error);
		}
	},

	/** O estado dos turnos de uma conversa (R4H). */
	async listServiceTurnStates(conversationId: string) {
		try {
			return (await ipcRenderer.invoke(SERVICE_TURNS_CHANNEL, {
				conversationId,
			})) as ServiceTurnStatesReply;
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

	async setProviderRole(providerId: string, role: 'router' | 'provider') {
		try {
			return parseProviderSummary(
				await ipcRenderer.invoke(PROVIDER_CHANNEL, 'role', {
					providerId: parseProviderId(providerId),
					role,
				}),
			);
		} catch (error) {
			rethrow(error);
		}
	},

	async setProviderEnabled(providerId: string, enabled: boolean) {
		try {
			return parseProviderSummary(
				await ipcRenderer.invoke(PROVIDER_CHANNEL, 'enabled', {
					providerId: parseProviderId(providerId),
					enabled,
				}),
			);
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

	async listModelCatalog(providerId?: string) {
		try {
			return parseModelCatalogEntryViews(
				await ipcRenderer.invoke(MODEL_CATALOG_CHANNEL, 'list', providerId),
			);
		} catch (error) {
			rethrow(error);
		}
	},

	async getModelCatalogEntry(key: ModelCatalogKey) {
		try {
			const raw = await ipcRenderer.invoke(MODEL_CATALOG_CHANNEL, 'get', key);
			// A miss is an ordinary answer, not a failure: the settings window asks
			// for a model it may never have described, and an error there would
			// look like a broken store rather than an empty record.
			return raw === undefined || raw === null
				? undefined
				: parseModelCatalogEntryView(raw);
		} catch (error) {
			rethrow(error);
		}
	},

	async saveModelCatalogEntry(input: SaveModelCatalogInput) {
		try {
			return parseModelCatalogEntryView(
				await ipcRenderer.invoke(
					MODEL_CATALOG_CHANNEL,
					'save',
					parseSaveModelCatalogInput(input),
				),
			);
		} catch (error) {
			rethrow(error);
		}
	},

	async removeModelCatalogEntry(key: ModelCatalogKey) {
		try {
			return (await ipcRenderer.invoke(MODEL_CATALOG_CHANNEL, 'remove', key)) === true;
		} catch (error) {
			rethrow(error);
		}
	},

	async listSpendingLimits() {
		try {
			return parseSpendingLimitViews(await ipcRenderer.invoke(BUDGET_CHANNEL, 'limits'));
		} catch (error) {
			rethrow(error);
		}
	},

	async saveSpendingLimit(input: SaveSpendingLimitViewInput) {
		try {
			// Re-narrowed instead of trusting the echo: the renderer gets the
			// same validated view the list would have returned.
			const saved = parseSpendingLimitViews([
				await ipcRenderer.invoke(BUDGET_CHANNEL, 'save', parseSaveSpendingLimitViewInput(input)),
			]);
			const [limit] = saved;
			if (limit === undefined) {
				throw new Error('O limite salvo não pôde ser lido de volta.');
			}
			return limit;
		} catch (error) {
			rethrow(error);
		}
	},

	async removeSpendingLimit(limitId: string) {
		try {
			return (await ipcRenderer.invoke(BUDGET_CHANNEL, 'remove', parseSpendingLimitId(limitId))) === true;
		} catch (error) {
			rethrow(error);
		}
	},

	async readBudget(window: 'day' | 'month' = 'month') {
		try {
			return parseBudgetReportView(
				await ipcRenderer.invoke(BUDGET_CHANNEL, 'report', parseBudgetWindow(window)),
			);
		} catch (error) {
			rethrow(error);
		}
	},

	async forecastCall(input: ForecastRequestView) {
		try {
			return parseForecastView(
				await ipcRenderer.invoke(BUDGET_CHANNEL, 'forecast', parseForecastRequestView(input)),
			);
		} catch (error) {
			rethrow(error);
		}
	},

	async listBudgetAlerts() {
		try {
			return parseBudgetAlertViews(await ipcRenderer.invoke(BUDGET_CHANNEL, 'alerts'));
		} catch (error) {
			rethrow(error);
		}
	},

	async listDiscoveredModels(providerId?: string) {
		try {
			return parseDiscoveredModelViews(await ipcRenderer.invoke(DISCOVERY_CHANNEL, 'models', providerId));
		} catch (error) {
			rethrow(error);
		}
	},

	async discoverModels(providerId?: string) {
		try {
			// DEV-8.15: no conectado o main fala com o serviço; no local, com o
			// Core do processo. O canal é o mesmo.
			const answer = (await ipcRenderer.invoke(DISCOVERY_CHANNEL, 'discover', providerId)) as {
				readonly models?: unknown;
				readonly failed?: unknown;
			};
			const models = Array.isArray(answer?.models)
				? answer.models.filter((entry): entry is string => typeof entry === 'string')
				: [];
			const failed = Array.isArray(answer?.failed)
				? answer.failed.filter(
						(entry): entry is { providerId: string; reason: string } =>
							typeof entry === 'object' &&
							entry !== null &&
							typeof (entry as { providerId?: unknown }).providerId === 'string' &&
							typeof (entry as { reason?: unknown }).reason === 'string',
					)
				: [];
			const reply: {
				readonly models: readonly string[];
				readonly failed?: readonly { readonly providerId: string; readonly reason: string }[];
			} = { models, ...(failed.length > 0 ? { failed } : {}) };
			return reply;
		} catch (error) {
			rethrow(error);
		}
	},

	async listDiscoveredQuotas(providerId?: string) {
		try {
			return parseDiscoveredQuotaViews(await ipcRenderer.invoke(DISCOVERY_CHANNEL, 'quotas', providerId));
		} catch (error) {
			rethrow(error);
		}
	},

	async listUsableModels(options: { readonly onlyFree?: boolean } = {}) {
		try {
			return parseDiscoveredModelViews(
				await ipcRenderer.invoke(DISCOVERY_CHANNEL, 'usable', options.onlyFree === true),
			);
		} catch (error) {
			rethrow(error);
		}
	},

	async getAccessPolicy() {
		try {
			const view = parseAccessPolicyView(await ipcRenderer.invoke(ACCESS_POLICY_CHANNEL, 'get'));
			if (view === undefined) {
				throw new Error('The Core returned no access policy');
			}
			return view;
		} catch (error) {
			rethrow(error);
		}
	},

	async setAccessPolicy(input: Parameters<SeshyinaBridge['setAccessPolicy']>[0]) {
		try {
			const view = parseAccessPolicyView(await ipcRenderer.invoke(ACCESS_POLICY_CHANNEL, 'set', input));
			if (view === undefined) {
				throw new Error('The Core returned no access policy');
			}
			return view;
		} catch (error) {
			rethrow(error);
		}
	},

	async listMergedCatalog(providerId?: string) {
		try {
			const merged = parseMergedCatalog(
				await ipcRenderer.invoke(ACCESS_POLICY_CHANNEL, 'catalog', providerId),
			);
			if (merged === undefined) {
				throw new Error('The Core returned no merged catalog');
			}
			return merged;
		} catch (error) {
			rethrow(error);
		}
	},

	async listDecisionReports(limit?: number) {
		try {
			return parseRoutingDecisionReports(
				await ipcRenderer.invoke(ACCESS_POLICY_CHANNEL, 'reports', limit),
			);
		} catch (error) {
			rethrow(error);
		}
	},

	async getRouterConfig() {
		try {
			const view = parseRouterConfigView(
				await ipcRenderer.invoke(ACCESS_POLICY_CHANNEL, 'router'),
			);
			if (view === undefined) {
				throw new Error('The Core returned no router configuration');
			}
			return view;
		} catch (error) {
			rethrow(error);
		}
	},

	async setRouterConfig(input: Parameters<SeshyinaBridge['setRouterConfig']>[0]) {
		try {
			const view = parseRouterConfigView(
				await ipcRenderer.invoke(ACCESS_POLICY_CHANNEL, 'router-set', {
					mode: input.mode,
					enabled: input.enabled,
					externalRouterProviderId: input.externalRouterProviderId,
					directProviderId: input.directProviderId,
				}),
			);
			if (view === undefined) {
				throw new Error('The Core returned no router configuration');
			}
			return view;
		} catch (error) {
			rethrow(error);
		}
	},

	onRouterState(listener: (config: RouterConfigView) => void) {
		const handler = (_event: IpcRendererEvent, payload: unknown): void => {
			try {
				const view = parseRouterConfigView(payload);
				if (view !== undefined) {
					listener(view);
				}
			} catch {
				// Dropped rather than thrown from inside Electron's emitter: the
				// window that cannot read the notice keeps the state it had,
				// and the next write brings it back.
			}
		};
		ipcRenderer.on(ROUTER_STATE_CHANNEL, handler);

		let removed = false;
		return () => {
			if (removed) {
				return;
			}
			removed = true;
			ipcRenderer.removeListener(ROUTER_STATE_CHANNEL, handler);
		};
	},

	onServiceState(listener: (state: ServiceControlState) => void) {
		const handler = (_event: IpcRendererEvent, payload: unknown): void => {
			// A forma é validada aqui, não assumida: quem envia é o processo
			// principal, mas um aviso malformado não pode derrubar a janela.
			if (typeof payload !== 'object' || payload === null) {
				return;
			}
			const state = (payload as { readonly state?: unknown }).state;
			if (
				state !== 'active' &&
				state !== 'inactive' &&
				state !== 'starting' &&
				state !== 'stopping' &&
				state !== 'error'
			) {
				return;
			}
			listener(payload as ServiceControlState);
		};
		ipcRenderer.on(SERVICE_STATE_CHANNEL, handler);

		let removed = false;
		return () => {
			if (removed) {
				return;
			}
			removed = true;
			ipcRenderer.removeListener(SERVICE_STATE_CHANNEL, handler);
		};
	},

	async listExecutionHistory(limit?: number) {
		try {
			return parseExecutionHistory(
				await ipcRenderer.invoke(ACCESS_POLICY_CHANNEL, 'history', limit),
			);
		} catch (error) {
			rethrow(error);
		}
	},

	async compareExecutions(first: string, second: string) {
		try {
			const comparison = parseExecutionComparison(
				await ipcRenderer.invoke(ACCESS_POLICY_CHANNEL, 'compare', { ids: [first, second] }),
			);
			if (comparison === undefined) {
				throw new Error('The Core returned no comparison');
			}
			return comparison;
		} catch (error) {
			rethrow(error);
		}
	},

	async scanSkillHistory() {
		try {
			return parseSkillScanView(await ipcRenderer.invoke(SKILL_EVOLUTION_CHANNEL, 'scan'));
		} catch (error) {
			rethrow(error);
		}
	},

	async listSkills() {
		try {
			return parseSkillSummaryViews(
				await ipcRenderer.invoke(SKILL_EVOLUTION_CHANNEL, 'skills'),
			);
		} catch (error) {
			rethrow(error);
		}
	},

	async autoSkillStatus() {
		try {
			return parseAutoSkillStatusView(
				await ipcRenderer.invoke(SKILL_EVOLUTION_CHANNEL, 'auto-status'),
			);
		} catch (error) {
			rethrow(error);
		}
	},

	async setAutoSkillsEnabled(enabled: boolean) {
		try {
			return parseAutoSkillStatusView(
				await ipcRenderer.invoke(SKILL_EVOLUTION_CHANNEL, 'auto-set', enabled),
			);
		} catch (error) {
			rethrow(error);
		}
	},

	async proposeSkillImprovement(input: SaveSkillImprovementInput) {
		try {
			return parseSkillProposalView(
				await ipcRenderer.invoke(
					SKILL_EVOLUTION_CHANNEL,
					'propose',
					parseSaveSkillImprovementInput(input),
				),
			);
		} catch (error) {
			rethrow(error);
		}
	},

	async listSkillEvolutionProposals(status?: SkillProposalStatus) {
		try {
			return parseSkillProposalViews(
				await ipcRenderer.invoke(
					SKILL_EVOLUTION_CHANNEL,
					'list',
					status === undefined ? undefined : parseSkillProposalStatus(status),
				),
			);
		} catch (error) {
			rethrow(error);
		}
	},

	async getSkillEvolutionProposal(proposalId: string) {
		try {
			return parseSkillProposalView(
				await ipcRenderer.invoke(
					SKILL_EVOLUTION_CHANNEL,
					'get',
					parseSkillProposalId(proposalId),
				),
			);
		} catch (error) {
			rethrow(error);
		}
	},

	async compareSkillEvolutionProposal(proposalId: string) {
		try {
			return parseSkillContentDiffView(
				await ipcRenderer.invoke(
					SKILL_EVOLUTION_CHANNEL,
					'compare',
					parseSkillProposalId(proposalId),
				),
			);
		} catch (error) {
			rethrow(error);
		}
	},

	async approveSkillEvolutionProposal(proposalId: string, reason: string) {
		try {
			return parseSkillProposalView(
				await ipcRenderer.invoke(SKILL_EVOLUTION_CHANNEL, 'approve', {
					proposalId: parseSkillProposalId(proposalId),
					reason: parseDecisionReason(reason),
				}),
			);
		} catch (error) {
			rethrow(error);
		}
	},

	async rejectSkillEvolutionProposal(proposalId: string, reason: string) {
		try {
			return parseSkillProposalView(
				await ipcRenderer.invoke(SKILL_EVOLUTION_CHANNEL, 'reject', {
					proposalId: parseSkillProposalId(proposalId),
					reason: parseDecisionReason(reason),
				}),
			);
		} catch (error) {
			rethrow(error);
		}
	},

	async activateSkillEvolutionProposal(proposalId: string) {
		try {
			return parseSkillEvolutionResultView(
				await ipcRenderer.invoke(
					SKILL_EVOLUTION_CHANNEL,
					'activate',
					parseSkillProposalId(proposalId),
				),
			);
		} catch (error) {
			rethrow(error);
		}
	},

	async listSkillVersions(skillId: string) {
		try {
			return parseSkillVersionViews(
				await ipcRenderer.invoke(SKILL_EVOLUTION_CHANNEL, 'versions', parseProviderId(skillId)),
			);
		} catch (error) {
			rethrow(error);
		}
	},

	async rollbackSkillVersion(skillId: string, versionId: string, reason: string) {
		try {
			return parseSkillEvolutionResultView(
				await ipcRenderer.invoke(SKILL_EVOLUTION_CHANNEL, 'rollback', {
					...parseRollbackTarget({ skillId, versionId }),
					reason: parseDecisionReason(reason),
				}),
			);
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

	async listConversations() {
		try {
			return parseConversationListItems(
				await ipcRenderer.invoke(CONVERSATION_CHANNEL, 'list'),
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

	async pinConversation(conversationId: string, pinned: boolean) {
		try {
			return parseConversationListItem(
				await ipcRenderer.invoke(CONVERSATION_CHANNEL, 'pin', {
					id: parseConversationId(conversationId),
					pinned,
				}),
			);
		} catch (error) {
			rethrow(error);
		}
	},

	async resetConversation(conversationId: string) {
		try {
			return parseConversationListItem(
				await ipcRenderer.invoke(CONVERSATION_CHANNEL, 'reset', parseConversationId(conversationId)),
			);
		} catch (error) {
			rethrow(error);
		}
	},

	async recordModelGuidance(conversationId: string, text: string) {
		try {
			return parseModelGuidance(
				await ipcRenderer.invoke(MODEL_GUIDANCE_CHANNEL, {
					id: parseConversationId(conversationId),
					text: typeof text === 'string' ? text : '',
				}),
			);
		} catch (error) {
			rethrow(error);
		}
	},

	async readModelGuidance() {
		try {
			return parseGuidanceEntries(
				await ipcRenderer.invoke(MODEL_GUIDANCE_CHANNEL, 'read', {}),
			);
		} catch (error) {
			rethrow(error);
		}
	},

	async deleteConversation(conversationId: string) {		try {
			const removed: unknown = await ipcRenderer.invoke(
				CONVERSATION_CHANNEL,
				'delete',
				parseConversationId(conversationId),
			);
			// R4M: `absent` também é sucesso — a conversa já não está lá (outra
			// exclusão venceu). Um desfecho não confirmado (`unknown`) chega
			// como erro do canal principal, e por isso nunca é "sucesso" aqui.
			return removed === true ? 'deleted' : 'absent';
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
	/** DEV-6: o estado do painel. O payload é reduzido antes de chegar à página. */
	async getDevState() {
		try {
			return parseDevPanelState(await ipcRenderer.invoke(DEV_CHANNEL, 'state'));
		} catch (error) {
			rethrow(error);
		}
	},

	/** DEV-9.1: o histórico das execuções do `dev_run`, mais recente primeiro. */
	async getDevRunHistory() {
		try {
			const reply = (await ipcRenderer.invoke(DEV_CHANNEL, 'history')) as { readonly entries?: unknown };
			const entries = Array.isArray(reply?.entries) ? reply.entries : [];
			return entries.flatMap((entry) => {
				const parsed = parseDevRunHistoryEntry(entry);
				return parsed === undefined ? [] : [parsed];
			});
		} catch (error) {
			rethrow(error);
		}
	},

	/** DEV-6: ativação - sem argumento. Quem confirma é o `main`, não esta ponte. */
	async activateDev() {
		try {
			return parseDevPanelState(await ipcRenderer.invoke(DEV_CHANNEL, 'activate'));
		} catch (error) {
			rethrow(error);
		}
	},

	/** DEV-6: encerramento — sem argumento. */
	async deactivateDev() {
		try {
			return parseDevPanelState(await ipcRenderer.invoke(DEV_CHANNEL, 'deactivate'));
		} catch (error) {
			rethrow(error);
		}
	},

	/** Bloqueia agora, **mantendo** o desbloqueio persistente para depois. */
	async lockDev() {
		try {
			return parseDevPanelState(await ipcRenderer.invoke(DEV_CHANNEL, 'lock'));
		} catch (error) {
			rethrow(error);
		}
	},

	/** Revoga a autorização persistente: o próximo desbloqueio pede a senha. */
	async revokeDevUnlock() {
		try {
			return parseDevPanelState(await ipcRenderer.invoke(DEV_CHANNEL, 'revoke'));
		} catch (error) {
			rethrow(error);
		}
	},

	/** DEV-6: aplica a operação de id conhecido (validado no `main`). */
	async applyDevOperation(operationId: string) {
		try {
			return parseDevActionResult(await ipcRenderer.invoke(DEV_CHANNEL, 'apply', { operationId }));
		} catch (error) {
			rethrow(error);
		}
	},

	/** DEV-6: restaura pelo checkpoint (o `main` decide se pode). */
	async restoreDevCheckpoint(checkpointId?: string) {
		try {
			const payload = checkpointId === undefined ? {} : { checkpointId };
			return parseDevActionResult(await ipcRenderer.invoke(DEV_CHANNEL, 'restore', payload));
		} catch (error) {
			rethrow(error);
		}
	},

	/** DEV-6: o host avisa que mudou; a página relê o estado. */
	onDevChange(listener: () => void) {
		const handler = (): void => {
			try {
				listener();
			} catch {
				// Um ouvinte que falha não pode derrubar o emissor do Electron.
			}
		};
		ipcRenderer.on(DEV_EVENT_CHANNEL, handler);
		let removed = false;
		return () => {
			if (removed) {
				return;
			}
			removed = true;
			ipcRenderer.removeListener(DEV_EVENT_CHANNEL, handler);
		};
	},
	/** DEV-7: configurar a autorização local (a senha é pedida pelo `main`). */
	async configureDevAuthorization() {
		try {
			return parseDevPanelState(await ipcRenderer.invoke(DEV_CHANNEL, 'configure'));
		} catch (error) {
			rethrow(error);
		}
	},

	/** DEV-7: a recuperação (apaga a credencial; a página confirma antes). */
	async recoverDevAuthorization() {
		try {
			return parseDevPanelState(await ipcRenderer.invoke(DEV_CHANNEL, 'recover'));
		} catch (error) {
			rethrow(error);
		}
	},

	/**
	 * DEV-7: o pedido de autorização que o host abriu.
	 *
	 * Só o desafio chega. A página desenha, devolve a resposta por
	 * `answerDevOwnerPrompt` e não guarda nada além do id.
	 */
	onDevOwnerPrompt(listener: (prompt: DevOwnerPromptView) => void) {
		const handler = (_event: IpcRendererEvent, payload: unknown): void => {
			try {
				if (typeof payload !== 'object' || payload === null) {
					return;
				}
				const value = payload as Record<string, unknown>;
				const kind = value['kind'];
				if (
					typeof value['id'] !== 'string' ||
					// DEV-9.1: `run-command` é a pergunta de aprovação do
					// `dev_run`. Sem ele na lista, o evento chegava e era
					// descartado aqui — a pergunta ficava invisível até expirar.
					(kind !== 'authorize' && kind !== 'configure' && kind !== 'recover' && kind !== 'run-command') ||
					typeof value['title'] !== 'string' ||
					typeof value['detail'] !== 'string' ||
					typeof value['expiresAt'] !== 'string'
				) {
					return;
				}
				listener({
					id: value['id'],
					kind,
					title: value['title'],
					detail: value['detail'],
					...(typeof value['minLength'] === 'number' ? { minLength: value['minLength'] } : {}),
					// O que faz a caixa "lembrar neste dispositivo" aparecer. Sem
					// repassar este campo, o host pedia a opção e a página nunca a
					// desenhava — medido no pacote.
					...(value['canRemember'] === true ? { canRemember: true } : {}),
					expiresAt: value['expiresAt'],
				});
			} catch {
				// Um ouvinte que falha não pode derrubar o emissor do Electron.
			}
		};
		ipcRenderer.on(DEV_OWNER_PROMPT_CHANNEL, handler);
		let removed = false;
		return () => {
			if (removed) {
				return;
			}
			removed = true;
			ipcRenderer.removeListener(DEV_OWNER_PROMPT_CHANNEL, handler);
		};
	},

	/**
	 * DEV-10: a pergunta aberta, para quem chegar depois do evento.
	 *
	 * A janela criada para a pergunta pode estar montando quando o evento
	 * sai; consultar ao montar evita depender da ordem entre os dois.
	 */
	async pendingDevOwnerPrompt() {
		try {
			return (await ipcRenderer.invoke(DEV_OWNER_PENDING_CHANNEL)) as DevOwnerPromptView | null;
		} catch (error) {
			rethrow(error);
		}
	},

	/** DEV-7: responde ao pedido aberto. */
	async answerDevOwnerPrompt(answer: DevOwnerPromptAnswerView) {
		try {
			return (await ipcRenderer.invoke(DEV_OWNER_ANSWER_CHANNEL, answer)) as {
				readonly accepted: boolean;
				readonly reason?: string;
			};
		} catch (error) {
			rethrow(error);
		}
	},
});

contextBridge.exposeInMainWorld(BRIDGE_KEY, bridge);
