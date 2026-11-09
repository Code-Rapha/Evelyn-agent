/**
 * The renderer: provider setup, conversations and the chat.
 *
 * Plain DOM, no framework. The state is small — selected provider, selected
 * model, selected conversation, the transcript, and whether a turn is running —
 * and a framework would add more code than it removes at this size.
 *
 * The renderer has no Node and no Electron. Everything it knows about the Core
 * arrives through the preload bridge, and when that bridge is missing it says so
 * instead of failing silently, which is what keeps the page usable when opened
 * in a plain browser.
 *
 * Three rules shape the rest:
 *
 * - Text goes in as `textContent`, never `innerHTML`. Every value arrives from
 *   another process, and text is the only way to put it on screen without giving
 *   it a chance to become markup.
 * - The turn id decides what a stream event may touch. A delta from a turn the
 *   user already stopped is ignored rather than appended to whatever is on
 *   screen now.
 * - Switching conversations is refused while a turn is running. The alternative
 *   is a delta landing in a transcript the user has already left.
 */
import { renderMarkdown, type MarkdownNode } from './markdown';
import {
	MODEL_GUIDANCE_DIALOGUE_PROMPT,
	readBridge,
	toDisplayMessage,
	type ChatRole,
	type CoreStatus,
	type ChatStreamEvent,
	type AvailableModel,
	type ConversationListItem,
	type ConversationView,
	type PermissionPrompt,
	type ProjectListItem,
	type BudgetAlertView,
	type BudgetReportView,
	type CallForecastView,
	type BudgetUsageView,
	type ConversationUsageView,
	type SpendingLimitView,
	type ModelCatalogEntryView,
	type ProviderSummary,
	type ResizeDirection,
	type SeshyinaBridge,
	type OrchestrationStrategy,
	type AccessPolicyView,
	type MergedModelView,
	type DiscoveredQuotaView,
	type RoutingDecisionReportView,
	type RouterConfigView,
	type ServiceControlState,
	type TurnRouting,
	type HistoryExecutionView,
	type SkillProposalStatus,
	type SkillProposalView,
	type SkillScanView,
} from '../contract';
import type { DevRunHistoryView } from '../devView';
import type { DevPanelState } from '../../core/dev/devPanel';
import type { DevOwnerPromptAnswerView } from '../contract';
import {
	describeAccessLine,
	describeComparison,
	describeDecisionReport,
	describeDeclaredPrice,
	describeDiscoveredPrice,
	describeEffectivePrice,
	describeFusedField,
	describeIncompatibility,
	describePolicy,
	describePolicyExclusion,
	describePriceAmounts,
	describePriceFallback,
	describeQuota,
	describeQuotaSource,
	describeTaskExplanation,
} from './describePolicy';
import { pickNextModel } from '../modelOrchestrator';
import { chooseProviderFor, type ModelChoice } from '../panelSelection';
import {
	autoModeAvailable,
	describeTurnMode,
	effectiveTurnMode,
	manualModelChoiceVisible,
	modelSelectionEnabled,
	readStoredTurnMode,
	turnRoutingPayload,
	writeStoredTurnMode,
	type TurnMode,
} from '../turnMode';

/**
 * A message as the UI holds it while the turn is running.
 *
 * `tool` and `toolError` are display-only roles: both are real stored `tool`
 * messages, but the UI shows a failure differently from a success, and losing
 * that distinction would make a denied or failed tool look like a success.
 */
interface UiMessage {
	role: ChatRole | 'error' | 'toolError';
	content: string;
	/** The tool's name, for a `tool` bubble's label. */
	toolName?: string;
	/**
	 * The call this bubble belongs to. Matched against `toolResult.callId` so
	 * two calls of the same tool in one round land on their own bubbles instead
	 * of both collapsing onto the last one named.
	 */
	toolCallId?: string;
}

function byId<T extends HTMLElement>(id: string): T {
	const element = document.getElementById(id);
	if (element === null) {
		throw new Error(`The page is missing #${id}`);
	}
	return element as T;
}

/** The state a re-render reads. Kept in one place so no update is half-applied. */
interface State {
	bridge: SeshyinaBridge | undefined;
	/**
	 * Onde os dados estão (R4B): `local`, `connected` ou `unavailable`.
	 *
	 * Lido de `getCoreStatus`. `connected` significa que o serviço local é o
	 * dono — e que a conversa ainda não está disponível por ele.
	 */
	coreMode: CoreStatus['mode'];
	/** O turno do serviço em curso (R4C); `undefined` quando não há. */
	remoteTurnId: string | undefined;
	/**
	 * A geração da listagem e da abertura de conversa (R4E).
	 *
	 * Cada pedido anota o número ao sair e o confere ao voltar. Uma resposta
	 * que chega depois de outra (ou depois de o usuário ter clicado em outra
	 * conversa) é descartada — sem isso, a lista lenta substituiria a nova, e
	 * um histórico antigo apareceria sob a conversa selecionada.
	 */
	listGeneration: number;
	openGeneration: number;
	/** A conversa está sendo criada no serviço agora. */
	creatingConversation: boolean;
	/** The configured providers. Kept for the settings window and the labels. */
	providers: readonly ProviderSummary[];
	/**
	 * Every model from every enabled provider, each tagged with its provider.
	 *
	 * Cross-provider on purpose: the sidebar picks a model, not a provider, and
	 * the provider follows from the choice rather than being made first.
	 */
	availableModels: readonly AvailableModel[];
	selectedProviderId: string;
	selectedModel: string;
	conversations: readonly ConversationListItem[];
	projects: readonly ProjectListItem[];
	/** The project new conversations are bound to, and the tools' workspace. */
	selectedProjectId: string;
	selectedConversationId: string;
	/** The transcript on screen, minus the streaming bubble. */
	messages: UiMessage[];
	/** The turn currently streaming, if any. */
	activeTurnId: string | undefined;
	/**
	 * The permission request waiting for an answer, if any.
	 *
	 * Kept in the state rather than read back out of the card: the answer
	 * needs the prompt's id, and the card only holds what is displayed.
	 */
	openPermission: PermissionPrompt | undefined;
	/** Whether a provider has been chosen, so the panel folds only on the change. */
	hadProvider: boolean;
	/** Whether a project has been chosen, so the panel folds only on the change. */
	hadProject: boolean;
	/**
	 * The provider form describes a new provider rather than the selected one.
	 *
	 * Its own flag rather than a derived value: the form has to be able to sit
	 * blank while a provider is still selected, which is exactly the state that
	 * made "Add provider" look broken.
	 */
	providerDraft: boolean;
	/**
	 * The reasoning text of the turn in flight.
	 *
	 * Separate from `messages` because it is never part of the transcript: a
	 * reasoning model thinks for a while before its first visible token, and
	 * without somewhere to put that, a healthy turn renders as an empty screen.
	 */
	reasoning: string;
	/**
	 * What the user has recorded about each model.
	 *
	 * Read-only as far as this stage is concerned: the catalog is described and
	 * edited, and nothing here consults it to choose a model.
	 */
	modelCatalog: readonly ModelCatalogEntryView[];
	/** O consumo do período e os limites, como a aba Orçamento os lê. */
	budgetReport: BudgetReportView | undefined;
	/** A janela que a aba pede: o dia ou o mês corrente. */
	budgetWindow: 'day' | 'month';
	/**
	 * Which catalog record the form is showing, or `CATALOG_NEW` for a model that
	 * has not been described yet.
	 *
	 * An index, for the reason `renderModelList` gives: a provider id is derived
	 * from a base URL and a model id is whatever a server called it, so neither
	 * can be trusted to avoid any delimiter. The list is in hand right here, so
	 * an index identifies an entry exactly.
	 */
	catalogSelection: string;
	/** The catalog form is describing a model rather than editing a record. */
	catalogDraft: boolean;
	/** A política de acesso e a fusão, como o Core as devolveu. */
	accessPolicy: AccessPolicyView | undefined;
	mergedModels: readonly MergedModelView[];
	/** As cotas que a API informou, cada uma com a sua origem. */
	quotas: readonly DiscoveredQuotaView[];
	/** As últimas decisões de roteamento, sem conteúdo de conversa. */
	decisionReports: readonly RoutingDecisionReportView[];
	/** O histórico de execuções, com o id e a data de cada uma. */
	executionHistory: readonly HistoryExecutionView[];
	/** As execuções marcadas para comparação. */
	comparedExecutions: readonly string[];
	/** A configuração do roteador, como o Core a devolveu. */
	routerConfig: RouterConfigView | undefined;
	/**
	 * O estado do serviço local, como o controle o mostra.
	 *
	 * `undefined` = ainda não lido. O render não inventa "desligado" antes da
	 * primeira leitura: mostra "…" e desabilita, como o roteador faz.
	 */
	serviceControl: ServiceControlState | undefined;
	/** The last turn ended in error, so "Tentar novamente" is offered. */
	lastTurnFailed: boolean;
	/** Current orchestration strategy. */
	orchestrationStrategy: OrchestrationStrategy;
	/**
	 * Como este chat escolhe quem responde (DEV-8.9).
	 *
	 * - `auto` — o roteador nativo escolhe pela política e pelo catálogo;
	 * - `direct` — o par provedor + modelo do seletor, sem substituição;
	 * - `external` — o roteador externo configurado.
	 *
	 * É uma escolha **de execução do chat**: não grava nada em
	 * `router-config.json`, que continua sendo a configuração global.
	 */
	turnMode: TurnMode;
	/** Tratar a próxima mensagem como tarefa de várias etapas (DEV-9.1). */
	taskMode: boolean;
	/**
	 * O modo e o par **efetivos** do último turno, vindos do evento `started`.
	 *
	 * É a diferença entre "o que eu pedi" e "o que respondeu": no automático
	 * só o Core sabe quais foram, e a página mostra o que ele disse.
	 */
	lastTurnRouting:
		| {
				readonly mode: TurnRouting;
				readonly providerId?: string;
				readonly model?: string;
		  }
		| undefined;
}

/** The catalog selection meaning "a model that has not been described yet". */
const CATALOG_NEW = '__new__';

const state: State = {
	bridge: undefined,
	coreMode: 'local',
	/**
	 * O turno do serviço em curso (R4C), quando em modo conectado.
	 *
	 * Separado de `activeTurnId`: aquele é do turno local, cujo evento o
	 * serviço não emite. Este é o id que o botão de parar cancela.
	 */
	remoteTurnId: undefined,
	listGeneration: 0,
	openGeneration: 0,
	creatingConversation: false,
	providers: [],
	selectedProviderId: '',
	availableModels: [],
	selectedModel: '',
	conversations: [],
	projects: [],
	selectedProjectId: '',
	selectedConversationId: '',
	messages: [],
	activeTurnId: undefined,
	openPermission: undefined,
	hadProvider: false,
	hadProject: false,
	providerDraft: false,
	reasoning: '',
	modelCatalog: [],
	catalogSelection: CATALOG_NEW,
	catalogDraft: true,
	accessPolicy: undefined,
	mergedModels: [],
	quotas: [],
	decisionReports: [],
	executionHistory: [],
	comparedExecutions: [],
	routerConfig: undefined,
	serviceControl: undefined,
	/** Set when the last turn ended in error - shows the retry button. */
	lastTurnFailed: false,
	budgetReport: undefined,
	budgetWindow: 'month',
	orchestrationStrategy: 'manual',
	// DEV-8.9: automático é o padrão pedido; `routerConfig` decide se ele pode
	// valer (roteador desligado ou apontando para outro destino prevalece).
	turnMode: 'auto',
	lastTurnRouting: undefined,
	/**
	 * Tratar a próxima mensagem como tarefa (DEV-9.1, item 3).
	 *
	 * Estado da janela, não do turno: o botão liga e desliga, e o valor viaja
	 * com o `send`. Não é persistido — uma tarefa é uma decisão por envio, e
	 * lembrar isso entre sessões faria todo turno futuro ter os limites
	 * largos sem ninguém ter pedido.
	 */
	taskMode: false,
};

/**
 * O par (provedor, modelo) da escolha atual (R4S).
 *
 * A regra mora em `panelSelection.ts`, para ser testada sem a janela.
 */
function selectedAvailable(): ModelChoice | undefined {
	return chooseProviderFor(state.availableModels, state.selectedProviderId, state.selectedModel);
}

// ── small view helpers ──────────────────────────────────────────────────────

function setHidden(element: HTMLElement, hidden: boolean): void {
	element.hidden = hidden;
}

function showError(element: HTMLElement, message: string): void {
	element.textContent = message;
	setHidden(element, false);
}

function clearError(element: HTMLElement): void {
	element.textContent = '';
	setHidden(element, true);
}

/** Reports an error the user can act on, without losing what they typed. */
function report(error: unknown, element: HTMLElement, fallback: string): void {
	// R4B: em modo conectado, a falha de um canal que exige o Core local não é
	// um erro de rede nem de permissão — é o limite desta fase. Dizer a causa
	// evita mandar o usuário procurar um problema que não existe.
	if (state.coreMode !== 'local') {
		showError(
			element,
			state.coreMode === 'connected'
				? 'Esta função ainda não está disponível no modo conectado: o serviço local é o dono ' +
						'dos dados. Encerre o serviço para usar o modo local.'
				: 'Não há dados disponíveis: não foi encontrado um Core local nem um serviço ativo.',
		);
		return;
	}
	showError(element, toDisplayMessage(error, fallback));
}

function currentProvider(): ProviderSummary | undefined {
	return state.providers.find((provider) => provider.id === state.selectedProviderId);
}

function currentConversation(): ConversationListItem | undefined {
	return state.conversations.find((item) => item.id === state.selectedConversationId);
}

/** True when the composer has everything it needs to send. */
function canSend(): boolean {
	if (state.bridge === undefined || state.activeTurnId !== undefined) {
		return false;
	}
	if (state.coreMode === 'connected') {
		// DEV-8.10: o serviço executa o turno (Core dele), com os mesmos modos
		// do chat local. Exige apenas conversa e um destino possível.
		if (state.selectedConversationId.length === 0) {
			return false;
		}
		return state.turnMode === 'auto'
			? state.availableModels.length > 0
			: state.selectedModel.length > 0;
	}
	return (
		state.bridge !== undefined &&
		// R4B: em modo conectado o serviço é o dono dos dados e a conversa
		// ainda não é oferecida por ele. Enviar aqui mandaria a mensagem a
		// um Core que não existe — e o texto se perderia.
		state.coreMode === 'local' &&
		state.activeTurnId === undefined &&
		state.selectedConversationId.length > 0 &&
		state.selectedModel.length > 0
	);
}

/**
 * Envia pelo serviço (R4C).
 *
 * O modelo é `providerId/modelId` — o id que o catálogo do serviço publica.
 * A conversa é identificada pelo id persistido no serviço; quando ainda não
 * há conversa, ela é criada **no serviço**? Não: esta fase não migrou a
 * criação de conversas, então exige-se uma conversa aberta. A ausência é
 * dita, não escondida.
 */
async function sendThroughService(
	bridge: SeshyinaBridge,
	text: string,
	input: HTMLTextAreaElement,
): Promise<void> {
	const errorHost = byId('chat-error');
	if (state.selectedConversationId.length === 0) {
		showError(
			errorHost,
			'O modo conectado ainda não cria conversas: abra uma conversa existente no modo local ' +
				'(encerre o serviço), ou aguarde a fase que migra as conversas.',
		);
		return;
	}
	// DEV-8.10: o modo vale aqui como no chat local. No automático não há par
	// escolhido — quem decide é o motor do serviço.
	const mode = state.turnMode;
	const automatic = mode === 'auto';
	// R4S: o par vem da escolha, não de um recorte do nome do modelo.
	const choice = selectedAvailable();
	if (!automatic && (state.selectedModel.length === 0 || choice === undefined)) {
		showError(errorHost, 'Escolha um modelo antes de enviar.');
		return;
	}
	const routing = turnRoutingPayload(mode, choice);
	// DEV-8.14: o modo do chat é escolha de execução; a configuração do
	// roteador é global. Com o roteador em `external`, "automático" executa o
	// externo — e o externo **precisa** de um modelo pedido. A regra olha o
	// modo **efetivo**, não o pedido: antes, `auto` ia sem modelo e o turno era
	// recusado ("precisa de um modelo") mesmo havendo um escolhido na tela.
	const executaExterno = effectiveTurnMode(mode, state.routerConfig) === 'external';
	const finalRouting =
		executaExterno && routing.model === undefined
			? { ...routing, model: choice?.model ?? state.selectedModel }
			: routing;
	// O modo enviado acompanha o que vai ser executado: com a config em
	// `external`, mandar `auto` faria o serviço procurar seleção nativa.
	const enviado = executaExterno ? { ...finalRouting, routing: 'external' as const } : finalRouting;
	if (executaExterno && (enviado.model ?? '').length === 0) {
		showError(errorHost, 'O roteador externo precisa de um modelo: escolha um modelo antes de enviar.');
		return;
	}

	clearError(errorHost);
	state.messages.push({ role: 'user', content: text });
	input.value = '';
	autoGrow(input);
	state.reasoning = '';
	state.lastTurnFailed = false;
	render();

	const result = await bridge.sendToService({
		conversationId: state.selectedConversationId,
		// DEV-8.10: o mesmo modo do chat local. No automático o par vai vazio —
		// quem escolhe é o motor do serviço, e mandar o modelo do seletor
		// seria apresentá-lo como escolha do usuário.
		providerId: enviado.providerId ?? '',
		model: enviado.model ?? '',
		text,
		routing: enviado.routing,
	});
	if (!result.accepted) {
		// A mensagem pode ter sido gravada no serviço antes de a conexão cair:
		// a resposta é "não sabemos", não "não enviado". O histórico do
		// serviço é recarregado para mostrar o que de fato ficou — sem
		// reenviar nada, que duplicaria a pergunta.
		state.lastTurnFailed = true;
		showError(
			errorHost,
			result.error === undefined
				? 'o serviço local recusou o turno'
				: `${result.error} — recarregue a conversa para ver se a mensagem foi registrada.`,
		);
		await openServiceConversation(bridge, state.selectedConversationId);
		render();
		return;
	}
	// O turno remoto é o que o botão de parar deve cancelar.
	state.remoteTurnId = result.turnId;
	// DEV-4: a partir daqui há uma geração em curso. Se a janela recarregar
	// (para aplicar uma mudança), a próxima abertura sabe que ela foi
	// interrompida — e diz isso, sem repetir a chamada.
	void bridge.setUiSession({ generating: true }).catch(() => undefined);
	render();
}

/** True while a turn is streaming, which blocks conversation switching. */
/**
 * True while a turn is streaming, which blocks switching.
 *
 * R4G: o turno **remoto** conta. Antes o modo conectado só marcava
 * `activeTurnId` na chegada do primeiro evento; entre o pedido aceito e esse
 * evento, a exclusão ficava habilitada — exatamente a janela que o serviço
 * recusa. Agora `remoteTurnId` basta.
 */
function isBusy(): boolean {
	return state.activeTurnId !== undefined || state.remoteTurnId !== undefined;
}

// ── rendering ───────────────────────────────────────────────────────────────

function renderProviderList(): void {
	const select = byId<HTMLSelectElement>('provider-select');
	// Locked while a turn streams: switching providers mid-turn zeroes the
	// models and transcript while the old turn's events keep arriving, and
	// they would land on whatever conversation the new provider opens.
	select.disabled = isBusy();
	select.textContent = '';

	if (state.providers.length === 0) {
		const option = document.createElement('option');
		option.value = '';
		option.textContent = 'no provider yet';
		select.append(option);
	} else {
		for (const provider of state.providers) {
			const option = document.createElement('option');
			option.value = provider.id;
			// The key is never readable from here, only whether one exists.
			const key = provider.hasApiKeyRef ? ' · key stored' : '';
			option.textContent = `${provider.name} (${provider.status})${key}`;
			select.append(option);
		}
	}
	select.value = state.selectedProviderId;
}

function renderProviderForm(): void {
	const provider = currentProvider();
	const key = byId<HTMLInputElement>('provider-api-key');
	const drafting = state.providerDraft;

	// A draft is blank. Filling it from the selected provider is what made "Add
	// provider" look like it did nothing: the panel opened with the *existing*
	// provider's URL and name still in the fields, so there was nothing to type
	// over and nothing said a new one was being described.
	byId<HTMLInputElement>('provider-base-url').value = drafting ? '' : (provider?.baseUrl ?? '');
	byId<HTMLInputElement>('provider-name').value = drafting ? '' : (provider?.name ?? '');
	// Never pre-filled: the renderer cannot read a key, and a masked placeholder
	// that looks like one would suggest it can.
	key.value = '';
	key.placeholder = drafting
		? 'not stored yet'
		: provider?.hasApiKeyRef
			? 'a key is stored — blank keeps it'
			: 'no key stored yet';

	// Locked while a turn streams, for the same reason as the select: saving
	// or removing the provider under a running turn would swap the endpoint
	// its events are arriving from. Nothing to remove while drafting a new one.
	byId<HTMLButtonElement>('provider-remove').disabled =
		drafting || provider === undefined || isBusy();
	byId<HTMLButtonElement>('provider-save').disabled = isBusy();
	// Only offered while drafting: outside a draft it would discard the selected
	// provider's form for no reason, since the select already switches between
	// them.
	byId<HTMLButtonElement>('provider-cancel').hidden = !drafting;
	byId<HTMLButtonElement>('provider-add').disabled = drafting || isBusy();

	// The collapsed summary has to name the provider, or a collapsed panel would
	// hide which one is in use.
	const current = byId('provider-current');
	current.textContent =
		provider === undefined
			? 'none configured'
			: `${provider.name}${provider.hasApiKeyRef ? ' · key stored' : ''}`;


	// The panel opens itself while there is nothing configured — that is when
	// it has to be used — and folds away once the first provider appears, which
	// is what gives the conversation list the room.
	//
	// After that it is left alone on purpose: `render` runs on every stream
	// delta, and forcing `open` here would collapse the form under the user's
	// fingers while they were typing in it.
	const panel = byId<HTMLDetailsElement>('provider-panel');
	if (state.hadProvider !== (provider !== undefined)) {
		state.hadProvider = provider !== undefined;
		panel.open = provider === undefined;
	}
}

/**
 * The model picker, drawn from every provider at once.
 *
 * Each option is valued by its index rather than by an encoded
 * `providerId model` pair. `state.availableModels` is right here and is the
 * same list these options were built from, so an index identifies an entry
 * exactly. A joined string would need a delimiter that neither side can be
 * trusted to avoid: a provider id is derived from a base URL, and a model
 * name is whatever the server chose to call it.
 *
 * The provider name is in the label because the pair has to be readable, not
 * just recoverable: two providers can both serve `gpt-4o`, and without the
 * label the user cannot tell which entry would answer.
 */
function renderModelList(): void {
	const select = byId<HTMLSelectElement>('model-select');
	// Caminho C: o formulário de escolha manual só existe no modo em que a
	// pessoa escolhe. No modo agente ele sai da tela inteiro, e o lugar da
	// escolha passa a ser o diálogo fixo de preferências — que é o único que a
	// Evelyn lê.
	const manual = manualModelChoiceVisible(state.turnMode);
	setHidden(byId('model-manual'), !manual);
	setHidden(byId('model-agent'), manual);
	if (!manual) {
		void renderGuidanceSummary();
	}
	// (`model-refresh` is deliberately not touched here: `loadModels` owns its
	// disabled state while a request is in flight, and a render during that
	// window would re-enable it for a second click.)
	select.disabled = isBusy() || !modelSelectionEnabled(state.turnMode, state.routerConfig);
	select.textContent = '';

	if (state.availableModels.length === 0) {
		const option = document.createElement('option');
		option.value = '';
		option.textContent = 'no models loaded';
		select.append(option);
	} else {
		state.availableModels.forEach((entry, index) => {
			const option = document.createElement('option');
			option.value = String(index);
			option.textContent = `${entry.model} · ${entry.providerName}`;
			select.append(option);
		});
	}
	select.value = String(
		state.availableModels.findIndex(
			(entry) =>
				entry.model === state.selectedModel &&
				entry.providerId === state.selectedProviderId,
		),
	);

	// The collapsed summary names the model, so the choice is readable without
	// opening the panel. With the provider too, since the label is what makes
	// two same-named models tellable apart. No modo agente não há escolha a
	// nomear: o resumo diz quem decide, em vez de mostrar o último par usado.
	const current = byId<HTMLElement>('model-current');
	const chosen = state.availableModels.find(
		(entry) =>
			entry.model === state.selectedModel && entry.providerId === state.selectedProviderId,
	);
	current.textContent = manual
		? chosen === undefined
			? 'none'
			: chosen.providerName
		: 'decide sozinha';
}

/**
 * O que está em vigor, no modo agente.
 *
 * Lido do registro a cada desenho — o mesmo arquivo que o motor consulta — em
 * vez de um texto fixo: uma tela que promete "a Evelyn lê suas preferências"
 * e não mostra nenhuma é uma promessa que ninguém pode conferir.
 */
let guidanceSummaryRequest = 0;
async function renderGuidanceSummary(): Promise<void> {
	const bridge = state.bridge;
	const note = byId('model-agent-note');
	if (bridge === undefined) {
		return;
	}
	guidanceSummaryRequest += 1;
	const request = guidanceSummaryRequest;
	let entries: Awaited<ReturnType<SeshyinaBridge['readModelGuidance']>>;
	try {
		entries = await bridge.readModelGuidance();
	} catch {
		// Uma leitura que falhou não pode apagar o que está escrito na tela.
		return;
	}
	// Respostas fora de ordem: só a requisição mais recente desenha.
	if (request !== guidanceSummaryRequest) {
		return;
	}
	if (entries.length === 0) {
		note.textContent =
			'A Evelyn escolhe o modelo em cada turno. Nenhuma preferência registrada ainda — abra o diálogo e peça a lista.';
		return;
	}
	const lines = entries
		.slice(0, 5)
		.map((entry) => `${entry.model}${entry.value !== undefined ? ` (valor ${entry.value.toFixed(1)})` : ''}`);
	const rest = entries.length > 5 ? ` e mais ${entries.length - 5}` : '';
	note.textContent = `Em vigor: ${lines.join(', ')}${rest}. A Evelyn usa isso para escolher o modelo.`;
}

function renderStrategySelect(): void {
	const select = byId<HTMLSelectElement>('strategy-select');
	if (select === null) {return;}
	select.value = state.orchestrationStrategy;
	select.disabled = isBusy();
}

/**
 * O seletor de modo (DEV-8.9).
 *
 * O modo escolhido é sempre o que está no controle — não o efetivo. Quando a
 * configuração do roteador torna o automático impossível (desligado, ou em
 * `external`/`direct`), a nota diz qual modo vale de fato, em vez de mexer no
 * controle por baixo da pessoa.
 */
function renderTurnModeSelect(): void {
	const select = byId<HTMLSelectElement>('turn-mode-select');
	const note = byId<HTMLElement>('turn-mode-note');
	const configure = byId<HTMLButtonElement>('turn-mode-configure');
	if (select === null) {
		return;
	}
	select.value = state.turnMode;
	select.disabled = isBusy();

	const auto = select.options.namedItem('auto');
	if (auto !== null) {
		auto.disabled = !autoModeAvailable(state.routerConfig) && state.routerConfig !== undefined;
	}

	const effective = effectiveTurnMode(state.turnMode, state.routerConfig);
	const reasons: string[] = [describeTurnMode(state.turnMode, state.routerConfig)];
	if (state.routerConfig?.source === 'service') {
		// DEV-8.11: a fonte é o Core do serviço — a mesma decisão que executa
		// o turno no modo conectado. Mostrar de onde veio evita a divergência
		// silenciosa entre o que a tela diz e o que o backend faz.
		reasons.push('Configuração lida do serviço local (fonte que executa o turno).');
	}
	if (state.routerConfig?.source === 'unavailable') {
		reasons.push(
			state.routerConfig.reason ??
				'Sem Core nem serviço ativo: a configuração do roteador não pôde ser lida.',
		);
	}
	if (state.coreMode === 'connected' && state.routerConfig?.source !== 'service') {
		reasons.push(
			'Não foi possível ler a configuração do serviço; o envio será tentado com o motor dele e o resultado aparecerá no turno.',
		);
	}
	if (state.turnMode === 'external' && !(state.routerConfig?.mode === 'external') && state.coreMode !== 'connected') {
		reasons.push(
			'Não há roteador externo configurado: o envio será recusado com o motivo até você escolher o destino.',
		);
	}
	if (effective !== state.turnMode) {
		reasons.push(`A configuração atual executa no modo "${effective}".`);
	}
	if (state.turnMode !== 'auto') {
		reasons.push('A seleção manual de modelo vale neste modo.');
	}
	note.textContent = reasons.join(' ');
	note.hidden = false;
	configure.hidden = !(
		state.turnMode === 'external' &&
		!(state.routerConfig?.mode === 'external') &&
		state.coreMode !== 'connected'
	);}

/**
 * A execução do último turno, como o Core a relatou.
 *
 * No automático, o provedor e o modelo **efetivos** são os que o evento
 * `started` trouxe — o que o motor escolheu, não o que estava no seletor.
 * Sem esse dado, a linha diz que ainda não há resposta; não inventa.
 */
function renderLastTurnRouting(): void {
	const host = byId<HTMLElement>('model-current');
	if (host === null) {
		return;
	}
	const last = state.lastTurnRouting;
	if (last === undefined) {
		const chosen = state.availableModels.find(
			(entry) => entry.model === state.selectedModel && entry.providerId === state.selectedProviderId,
		);
		host.textContent =
			effectiveTurnMode(state.turnMode, state.routerConfig) === 'auto'
				? 'automático'
				: chosen === undefined
					? 'none'
					: chosen.providerName;
		return;
	}
	const pair =
		last.providerId !== undefined && last.model !== undefined
			? `${last.providerId} · ${last.model}`
			: last.model !== undefined
				? last.model
				: 'escolha do provedor registrada pelo Core';
	host.textContent = `${last.mode}: ${pair}`;
}

function renderProjectPanel(): void {
	const select = byId<HTMLSelectElement>('project-select');
	select.textContent = '';

	if (state.projects.length === 0) {
		const option = document.createElement('option');
		option.value = '';
		option.textContent = 'no project yet';
		select.append(option);
	} else {
		for (const project of state.projects) {
			const option = document.createElement('option');
			option.value = project.id;
			option.textContent = `${project.name} — ${project.rootPath}`;
			select.append(option);
		}
	}
	select.value = state.selectedProjectId;

	const selected = state.projects.find((project) => project.id === state.selectedProjectId);
	byId('project-current').textContent =
		selected === undefined ? 'none — tools have no workspace' : selected.name;
	byId<HTMLInputElement>('project-root').value = selected?.rootPath ?? '';
	byId<HTMLInputElement>('project-name').value = selected?.name ?? '';

	// Open while there is nothing configured, and fold once a project exists, on
	// the same reasoning as the provider panel.
	const panel = byId<HTMLDetailsElement>('project-panel');
	if (state.hadProject !== (selected !== undefined)) {
		state.hadProject = selected !== undefined;
		panel.open = selected === undefined;
	}
}

// ── model catalog ───────────────────────────────────────────────────────────

/**
 * The catalog form.
 *
 * Split by provenance, in the layout as well as in the data: what the user
 * declared is editable, and what real runs measured is a line of text under the
 * form that cannot be typed into. A field that looks editable gets edited, and an
 * edited measurement is a fabricated one.
 *
 * A blank field means unknown, and the form says so on each one rather than
 * showing `0` — which would be a different claim entirely.
 */
function renderCatalogPanel(): void {
	const select = byId<HTMLSelectElement>('catalog-select');
	select.textContent = '';

	const draft = document.createElement('option');
	draft.value = CATALOG_NEW;
	draft.textContent =
		state.modelCatalog.length === 0 ? '＋ describe a model' : '＋ describe another model';
	select.append(draft);

	state.modelCatalog.forEach((entry, index) => {
		const option = document.createElement('option');
		option.value = String(index);
		option.textContent = `${entry.modelId} · ${entry.providerId}`;
		select.append(option);
	});
	select.value = state.catalogSelection;

	const selected = selectedCatalogEntry();

	// The identity fields are read-only while a record is being edited: the
	// record is found by its pair, so a changed pair would silently become a
	// second record instead of a rename.
	byId<HTMLInputElement>('catalog-provider').readOnly = !state.catalogDraft;
	byId<HTMLInputElement>('catalog-model').readOnly = !state.catalogDraft;
	byId<HTMLInputElement>('catalog-provider').value = state.catalogDraft ? '' : (selected?.providerId ?? '');
	byId<HTMLInputElement>('catalog-model').value = state.catalogDraft ? '' : (selected?.modelId ?? '');

	byId<HTMLInputElement>('catalog-capabilities').value = selected?.capabilities ?? '';
	byId<HTMLInputElement>('catalog-currency').value = selected?.pricing?.currency ?? '';
	byId<HTMLSelectElement>('catalog-unit').value = selected?.pricing?.unit ?? 'per_1k_tokens';
	byId<HTMLInputElement>('catalog-price-input').value = selected?.pricing?.input ?? '';
	byId<HTMLInputElement>('catalog-price-output').value = selected?.pricing?.output ?? '';
	byId<HTMLSelectElement>('catalog-access').value = selected?.access ?? 'unknown';
	// The capability matrix is three-state. The form shows two, and the third
	// - "nobody knows" - is the absence of a tick, which is what an unticked
	// box means. A tick that is not in the catalog is not shown as unticked
	// with a meaning: it stays unknown.
	const declaredModel = selected?.model;
	byId<HTMLInputElement>('catalog-tool-calling').checked = declaredModel?.toolCalling === true;
	byId<HTMLInputElement>('catalog-structured-output').checked =
		declaredModel?.structuredOutput === true;
	byId<HTMLInputElement>('catalog-reasoning').checked = declaredModel?.reasoning === true;
	byId<HTMLInputElement>('catalog-context').value = selected?.limits?.contextTokens ?? '';
	byId<HTMLInputElement>('catalog-max-output').value = selected?.limits?.maxOutputTokens ?? '';
	byId<HTMLTextAreaElement>('catalog-notes').value = selected?.notes ?? '';

	byId<HTMLButtonElement>('catalog-clear').disabled = selected === undefined;
	byId('catalog-current').textContent = describeCatalogEntry(selected);

	renderCatalogObserved(selected);
}

/** The observations, in words. Never a number the UI made up. */
function renderCatalogObserved(entry: ModelCatalogEntryView | undefined): void {
	const line = byId('catalog-observed');
	if (entry === undefined || entry.observations === 0) {
		line.textContent = 'No real runs measured yet.';
		return;
	}
	const parts: string[] = [`${entry.observations} run${entry.observations === 1 ? '' : 's'} measured`];
	// Absent readings stay absent. A model whose runs all aborted has no
	// latency, and printing `0 ms` would say it answered instantly.
	if (entry.medianFirstByteMs !== undefined) {
		parts.push(`first byte ${formatMs(entry.medianFirstByteMs)}`);
	}
	if (entry.medianTotalMs !== undefined) {
		parts.push(`total ${formatMs(entry.medianTotalMs)}`);
	}
	line.textContent = `${parts.join(' · ')} (median).`;
}

function formatMs(value: number): string {
	return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`;
}

/**
 * One line describing what is known, for the collapsed summary.
 *
 * Says "not described" rather than nothing, so a collapsed panel does not look
 * like the same thing as one that has never been filled in.
 */
function describeCatalogEntry(entry: ModelCatalogEntryView | undefined): string {
	if (entry === undefined) {
		return 'none described';
	}
	const known: string[] = [];
	if (entry.pricing !== undefined) {
		known.push(`${entry.pricing.currency} ${entry.pricing.unit.replace('per_', 'per ')}`);
	}
	if (entry.access !== 'unknown') {
		known.push(entry.access);
	}
	if (entry.observations > 0) {
		known.push(`${entry.observations} measured`);
	}
	return known.length === 0 ? 'nothing recorded yet' : known.join(' · ');
}

function selectedCatalogEntry(): ModelCatalogEntryView | undefined {
	if (state.catalogSelection === CATALOG_NEW) {
		return undefined;
	}
	return state.modelCatalog[Number(state.catalogSelection)];
}

/**
 * The ledger's window on screen. Kept here so a refresh after a save reads the
 * same period the user is looking at, rather than silently resetting to month.
 */
function currentBudgetWindow(): 'day' | 'month' {
	return state.budgetWindow;
}

/** Reads the aggregated consumption and the limits that bound it. */
async function refreshBudget(): Promise<void> {
	const bridge = state.bridge;
	if (bridge === undefined) {
		return;
	}
	try {
		state.budgetReport = await bridge.readBudget(currentBudgetWindow());
		clearError(byId('budget-error'));
	} catch (error) {
		state.budgetReport = undefined;
		report(error, byId('budget-error'), 'Não foi possível ler o consumo.');
	}
	await refreshAccessPolicy();
	render();
}

/**
 * Reads the policy and the merged catalog.
 *
 * Kept apart from the budget read so a discovery file that cannot be read does
 * not blank the consumption numbers: they answer different questions and one
 * failing must not hide the other.
 */
async function refreshAccessPolicy(): Promise<void> {
	const bridge = state.bridge;
	if (bridge === undefined) {
		return;
	}
	try {
		const merged = await bridge.listMergedCatalog();
		state.accessPolicy = merged.policy;
		state.mergedModels = merged.models;
		clearError(byId('access-policy-error'));
	} catch (error) {
		report(error, byId('access-policy-error'), 'Não foi possível ler a política de acesso.');
	}
	try {
		state.quotas = await bridge.listDiscoveredQuotas();
	} catch (error) {
		// A cota é um extra: a política e a fusão já foram lidas.
		state.quotas = [];
	}
	try {
		state.decisionReports = await bridge.listDecisionReports(10);
	} catch (error) {
		// O relatório é um extra: a política e a fusão já foram lidas.
		state.decisionReports = [];
	}
	try {
		state.executionHistory = await bridge.listExecutionHistory(10);
	} catch (error) {
		// O histórico é um extra: a política e a fusão já foram lidas.
		state.executionHistory = [];
	}
	try {
		state.routerConfig = await bridge.getRouterConfig();
	} catch (error) {
		// A configuração do roteador é um extra: o resto da tela já está certo.
		state.routerConfig = undefined;
	}
	// A primeira leitura chega depois do desenho inicial. Sem este redesenho,
	// a barra do roteador ficava em "Carregando…" — com a configuração já lida
	// e nenhum motivo para o usuário saber disso. O `render()` acima e este
	// fecham a corrida: um mostra enquanto não se sabe, o outro quando se sabe.
	//
	// O estado do serviço é lido no mesmo ponto, e pelo mesmo motivo: o controle
	// não pode começar dizendo "desligado" enquanto o serviço está no ar.
	await refreshServiceControl();
	render();
}

/**
 * O painel do roteador.
 *
 * ## O que ele mostra, e por que nesta ordem
 *
 * 1. **Ligado ou desligado** — a primeira pergunta de quem olha um
 *    roteador;
 * 2. **O modo** — quem decide o modelo: a Evelyn, o roteador externo ou o
 *    provedor direto;
 * 3. **O destino** — para onde a requisição vai;
 * 4. **A última decisão** — o que aconteceu, e o motivo;
 * 5. **O monitoramento** — consumo, custo conhecido e cotas, em uma linha.
 *
 * ## O que ele não faz
 *
 * Não inventa um destino que não está configurado, e não atribui à Evelyn
 * uma decisão que o roteador externo tomou. Quando o servidor não diz qual
 * modelo respondeu, a linha diz que não se sabe.
 */

/**
 * Liga ou desliga o roteador.
 *
 * O interruptor grava a mudança e **recarrega o estado real**: o que o painel
 * mostra depois é o que o Core devolveu, e não o que o botão pressupôs. Se a
 * gravação for recusada — um modo que aponta para um provedor inexistente — o
 * painel volta ao estado anterior e a recusa aparece.
 */
async function toggleRouter(): Promise<void> {
	const bridge = state.bridge;
	const config = state.routerConfig;
	if (bridge === undefined || config === undefined) {
		return;
	}
	clearError(byId('router-error'));
	try {
		state.routerConfig = await bridge.setRouterConfig({ enabled: !config.enabled });
	} catch (error) {
		report(error, byId('router-error'), 'Não foi possível mudar o roteador.');
	}
	await refreshRouterState();
	render();
}

/** Recarrega a configuração do roteador e os dados de que o painel depende. */
/**
 * Relê o estado do roteador e **redesenha**.
 *
 * O redesenho é o ponto: quem chama espera um estado novo na tela. Sem ele, o
 * painel ficava em "Carregando…" até um clique do usuário — a leitura
 * terminava, o estado mudava, e nada repintava o interruptor. Medido no
 * executável: `getRouterConfig` respondia com `native/enabled` e a tela seguia
 * mostrando "Lendo o estado do roteador…".
 */
async function refreshRouterState(): Promise<void> {
	const bridge = state.bridge;
	if (bridge === undefined) {
		return;
	}
	try {
		state.routerConfig = await bridge.getRouterConfig();
	} catch (error) {
		state.routerConfig = undefined;
	}
	render();
}

/**
 * Preenche os controles da seção do roteador.
 *
 * Os provedores vêm da lista real — um id que não existe não pode ser
 * escolhido, e um provedor desabilitado aparece, mas não como escolha de
 * um destino que não vai atender.
 *
 * O modo vem dos cartões, e não de um menu: a escolha entre *quem decide* só
 * se faz lendo a frase inteira, e a frase inteira está no cartão.
 */
function renderRouterSettings(): void {
	const config = state.routerConfig;
	const externalSelect = byId<HTMLSelectElement>('router-external-select');
	const directSelect = byId<HTMLSelectElement>('router-direct-select');
	const enabled = byId<HTMLInputElement>('router-enabled');
	const note = byId('router-note');
	const current = byId('router-current');
	const destinations = byId('router-destinations');

	const fill = (select: HTMLSelectElement, selected: string | undefined): void => {
		select.textContent = '';
		const blank = document.createElement('option');
		blank.value = '';
		blank.textContent = 'escolha um endpoint';
		select.append(blank);
		for (const provider of state.providers) {
			const option = document.createElement('option');
			option.value = provider.id;
			option.textContent =
				provider.status === 'disabled'
					? `${provider.name} (desabilitado)`
					: provider.name;
			select.append(option);
		}
		select.value = selected ?? '';
	};

	if (config === undefined) {
		// Ainda não se sabe o que está gravado: o formulário fica fechado,
		// em vez de oferecer uma escolha que talvez nem seja a de hoje.
		setRouterMode('native');
		fill(externalSelect, undefined);
		fill(directSelect, undefined);
		enabled.checked = true;
		enabled.disabled = true;
		for (const card of document.querySelectorAll<HTMLInputElement>('input[name="router-mode"]')) {
			card.disabled = true;
		}
		destinations.dataset.mode = 'native';
		current.textContent = 'carregando…';
		note.textContent = 'Lendo a configuração gravada do roteador…';
		return;
	}

	// DEV-8.12: a edição vale quando há uma fonte autoritativa para gravar — o
	// Core local ou o serviço conectado. Sem fonte, editar seria um formulário
	// que não grava em lugar nenhum.
	const editable = routerEditingEnabled(config);
	enabled.disabled = !editable;
	for (const card of document.querySelectorAll<HTMLInputElement>('input[name="router-mode"]')) {
		card.disabled = !editable;
	}
	if (!editable) {
		destinations.dataset.mode = 'native';
		current.textContent = 'indisponível';
		note.textContent =
			config.source === 'unavailable'
				? config.reason ??
					'Sem Core nem serviço ativo: a configuração do roteador não pode ser lida nem gravada agora.'
				: 'A configuração do roteador não pôde ser lida; editar poderia sobrescrever uma decisão que existe.';
		return;
	}
	// Com uma escolha pendente, o formulário continua como o usuário o
	// deixou: redesenhar a tela por outro motivo não é motivo para
	// descartar o que ele escolheu.
	if (!routerFormDirty) {
		setRouterMode(config.mode);
		fill(externalSelect, config.externalRouterProviderId);
		fill(directSelect, config.directProviderId);
		enabled.checked = config.enabled;
	} else {
		fill(externalSelect, externalSelect.value);
		fill(directSelect, directSelect.value);
	}
	current.textContent = routerSummary(config);

	applyRouterModeToForm(selectedRouterMode());
}

/**
 * A configuração pode ser editada agora? (DEV-8.12)
 *
 * Só quando há uma fonte autoritativa identificada: o Core local ou o serviço
 * conectado. `undefined` é "ainda carregando"; `unavailable` é "não há para
 * onde gravar" — e nos dois casos editar seria um formulário que não salva.
 */
function routerEditingEnabled(config: RouterConfigView | undefined): boolean {
	if (config === undefined) {
		return false;
	}
	return config.source === 'local' || config.source === 'service';
}

/**
 * O resumo da seção: o que está gravado, ou o que está por ser gravado.
 *
 * Com uma escolha pendente, o resumo diz "não salvo" — um resumo que
 * continuasse mostrando o modo gravado ao lado de um cartão diferente
 * seria uma contradição na tela, e não uma informação.
 */
function routerSummary(config: RouterConfigView): string {
	if (routerFormDirty) {
		return `${describeRouterMode(selectedRouterMode())} · não salvo`;
	}
	// DEV-8.14: um arquivo ilegível **não** é "nunca configurado". Sem isto o
	// painel mostrava "padrão (Nativo)" e "Roteador ligado" para uma
	// configuração que ninguém conseguiu ler — indistinguível de ausente e
	// afirmando um estado que pode ser falso.
	if (config.unreadable !== undefined) {
		return 'configuração ilegível · reparo necessário';
	}
	return config.configured
		? `${describeRouterMode(config.mode)} · ${config.enabled ? 'ligado' : 'desligado'}`
		: `nunca configurado · padrão (${describeRouterMode(config.mode)})`;
}

/**
 * O formulário tem uma escolha que ainda não foi gravada.
 *
 * O painel é redesenhado por muitos motivos — uma resposta chegou, uma
 * lista mudou — e nenhum deles é motivo para descartar o que o usuário
 * escolheu. Só o Salvar (com sucesso) e o Recarregar fecham a pendência.
 */
let routerFormDirty = false;

/**
 * Marca o cartão do modo como escolhido.
 *
 * O estado do formulário é o do cartão, não o do Core: o usuário escolhe
 * primeiro, e o Core é avisado no Salvar.
 */
function setRouterMode(mode: RouterConfigView['mode']): void {
	for (const card of document.querySelectorAll<HTMLInputElement>('input[name="router-mode"]')) {
		card.checked = card.value === mode;
	}
}

/**
 * O que o modo muda no formulário.
 *
 * Só o destino do modo em uso aparece; o outro fica escondido, porque não é
 * uma escolha possível agora. E a nota explica o modo com as palavras do
 * cartão, para quem não leu o cartão.
 */
function applyRouterModeToForm(mode: RouterConfigView['mode']): void {
	const externalSelect = byId<HTMLSelectElement>('router-external-select');
	const directSelect = byId<HTMLSelectElement>('router-direct-select');
	const note = byId('router-note');
	const destinations = byId('router-destinations');
	destinations.dataset.mode = mode;

	switch (mode) {
		case 'native':
			note.textContent =
				'A Evelyn escolhe o modelo entre os provedores disponíveis e pode aplicar o fallback quando um modelo falha.';
			externalSelect.disabled = true;
			directSelect.disabled = true;
			break;
		case 'external':
			note.textContent =
				'A requisição vai para o roteador externo, que escolhe o modelo internamente. A Evelyn mede, registra e reporta — mas não decide, e não vê as decisões internas.';
			externalSelect.disabled = false;
			directSelect.disabled = true;
			break;
		case 'direct':
			note.textContent =
				'A requisição vai direto ao provedor escolhido, sem a seleção de modelos da Evelyn.';
			externalSelect.disabled = true;
			directSelect.disabled = false;
			break;
	}
}

/**
 * O modo escolhido no formulário.
 *
 * Vem do cartão marcado. O `native` é o padrão quando nada está marcado:
 * é o único modo que não precisa de um destino, e por isso o único que
 * pode ser assumido sem inventar nada.
 */
function selectedRouterMode(): RouterConfigView['mode'] {
	const checked = document.querySelector<HTMLInputElement>('input[name="router-mode"]:checked');
	const value = checked?.value;
	return value === 'external' || value === 'direct' ? value : 'native';
}

/**
 * Grava o formulário do roteador e recarrega o estado real.
 *
 * Tudo vai em **uma** gravação: o modo, o destino e o interruptor. Um erro
 * deixa o formulário como o usuário deixou — com a mensagem ao lado — e o
 * estado **aplicado** intacto, porque a gravação não aconteceu.
 */
async function saveRouterSettings(): Promise<void> {
	const bridge = state.bridge;
	if (bridge === undefined) {
		return;
	}
	clearError(byId('router-error'));
	const mode = selectedRouterMode();
	const external = byId<HTMLSelectElement>('router-external-select').value;
	const direct = byId<HTMLSelectElement>('router-direct-select').value;
	try {
		state.routerConfig = await bridge.setRouterConfig({
			mode,
			enabled: byId<HTMLInputElement>('router-enabled').checked,
			...(mode === 'external' && external.length > 0 ? { externalRouterProviderId: external } : {}),
			...(mode === 'direct' && direct.length > 0 ? { directProviderId: direct } : {}),
		});
	} catch (error) {
		// A gravação não aconteceu: o formulário continua como o usuário
		// deixou — para ele corrigir a escolha — e o estado aplicado segue
		// intacto. Só o botão Recarregar descarta a escolha pendente.
		report(error, byId('router-error'), 'Não foi possível salvar o roteador.');
		return;
	}
	// O que o Core aceitou é o que o formulário passa a mostrar.
	routerFormDirty = false;
	// Recarrega o estado real: o formulário passa a mostrar o que o Core
	// aceitou, e não o que foi pedido.
	await refreshRouterState();
	// DEV-8.12: no conectado a lista de destinos vem do catálogo do serviço;
	// recarregá-la pelo caminho local traria uma lista vazia.
	await refreshProviders();
	render();
}

/** Descarta o que está no formulário e volta ao estado gravado. */
async function reloadRouterSettings(): Promise<void> {
	// A tentativa que falhou deixou uma mensagem; recarregar é descartá-la
	// junto com a escolha pendente.
	clearError(byId('router-error'));
	routerFormDirty = false;
	await refreshRouterState();
	render();
}

/**
 * O painel de conexões.
 *
 * ## O que cada cartão mostra
 *
 * O nome e o endereço, o estado, o papel, os modelos que o endpoint publica,
 * o que se sabe do preço e do acesso de cada um, a cota e a latência — cada
 * uma **com a sua origem** — e o estado da chave.
 *
 * ## O que ele nunca mostra
 *
 * A chave. Nunca, nem em parte: o que se sabe é se existe uma, e nada mais.
 */
function renderConnections(): void {
	const host = byId('provider-connections');
	const summary = byId('provider-connections-current');
	host.textContent = '';
	const providers = state.providers;
	if (summary !== null) {
		const routers = providers.filter((provider) => provider.role === 'router').length;
		summary.textContent =
			providers.length === 0
				? 'nenhuma'
				: `${providers.length} · ${routers} roteador${routers === 1 ? '' : 'es'}`;
	}
	if (providers.length === 0) {
		const empty = document.createElement('p');
		empty.className = 'muted small';
		empty.textContent = 'Nenhuma conexão configurada.';
		host.append(empty);
		return;
	}
	for (const provider of providers) {
		host.append(connectionBlock(provider));
	}
}

/** O cartão de uma conexão. */
function connectionBlock(provider: ProviderSummary): HTMLElement {
	const card = document.createElement('article');
	card.className = 'connection-card';
	const disabled = provider.status === 'disabled';
	const isRouter = provider.role === 'router';
	card.dataset['role'] = isRouter ? 'router' : 'provider';
	card.dataset['state'] = disabled ? 'disabled' : 'enabled';

	// A cabeça: quem é, em que estado, e o que se pode fazer com ele.
	const head = document.createElement('header');
	head.className = 'connection-head';

	const title = document.createElement('div');
	title.className = 'connection-title';
	const name = document.createElement('span');
	name.className = 'connection-name';
	name.textContent = provider.name;
	title.append(name);
	title.append(
		tag('tag-role', isRouter ? 'Roteador' : 'Provedor', 'data-role', isRouter ? 'router' : 'provider'),
	);
	title.append(
		tag(
			'tag-state',
			disabled ? 'desabilitado' : 'habilitado',
			'data-state',
			disabled ? 'disabled' : 'enabled',
		),
	);
	head.append(title);

	const actions = document.createElement('div');
	actions.className = 'connection-actions';
	const promote = document.createElement('button');
	promote.type = 'button';
	promote.className = 'secondary subtle';
	promote.textContent = isRouter ? 'Classificar como provedor' : 'Promover a roteador';
	promote.addEventListener('click', () => {
		void changeProviderRole(provider.id, isRouter ? 'provider' : 'router');
	});
	actions.append(promote);
	const enable = document.createElement('button');
	enable.type = 'button';
	enable.className = 'secondary subtle';
	enable.textContent = disabled ? 'Habilitar' : 'Desabilitar';
	enable.addEventListener('click', () => {
		void changeProviderEnabled(provider.id, disabled);
	});
	actions.append(enable);
	// DEV-8.15: descobrir modelos pelo `/models` do endpoint e remover, no
	// mesmo cartão que já mostra os modelos — sem uma segunda tela.
	const discover = document.createElement('button');
	discover.type = 'button';
	discover.className = 'secondary subtle';
	discover.textContent = 'Descobrir modelos';
	discover.addEventListener('click', () => {
		void discoverProviderModels(provider.id);
	});
	actions.append(discover);
	const remove = document.createElement('button');
	remove.type = 'button';
	remove.className = 'secondary subtle';
	remove.textContent = 'Remover';
	remove.addEventListener('click', () => {
		void removeProviderFromList(provider);
	});
	actions.append(remove);
	head.append(actions);
	card.append(head);

	// Onde ele está.
	const endpoint = document.createElement('p');
	endpoint.className = 'connection-endpoint';
	endpoint.textContent = provider.baseUrl;
	card.append(endpoint);

	// Os fatos da conexão: chave, cota e latência, cada uma com a origem.
	const facts = document.createElement('div');
	facts.className = 'connection-facts';
	const quota = state.quotas.find((entry) => entry.providerId === provider.id);
	facts.append(
		fact('chave', provider.hasApiKeyRef ? 'configurada' : 'ausente', undefined, undefined),
	);
	facts.append(quotaFact(quota));
	facts.append(latencyFact(lastLatencyFor(provider.id)));
	card.append(facts);

	// Os modelos que o endpoint publica.
	const models = state.mergedModels.filter((model) => model.providerId === provider.id);
	const modelsRow = document.createElement('div');
	modelsRow.className = 'connection-models';
	const modelsLabel = document.createElement('span');
	modelsLabel.className = 'fact-label';
	modelsLabel.textContent = 'modelos';
	modelsRow.append(modelsLabel);
	if (models.length === 0) {
		const none = document.createElement('span');
		none.className = 'muted small';
		none.textContent = 'nenhum descoberto';
		modelsRow.append(none);
	} else {
		for (const model of models) {
			const chip = document.createElement('span');
			chip.className = 'model-chip';
			chip.textContent = model.modelId;
			modelsRow.append(chip);
		}
	}
	card.append(modelsRow);

	// E o que se sabe de cada um deles.
	if (models.length > 0) {
		const list = document.createElement('ul');
		list.className = 'connection-model-list';
		for (const model of models) {
			const item = document.createElement('li');
			item.className = 'connection-model';
			const modelName = document.createElement('span');
			modelName.className = 'connection-model-name';
			modelName.textContent = model.modelId;
			item.append(modelName);

			const known = modelFacts(model);
			const modelFactsRow = document.createElement('div');
			modelFactsRow.className = 'connection-model-facts';
			modelFactsRow.append(fact('preço', known.price.value, known.price.origin));
			modelFactsRow.append(fact('acesso', known.access.value, known.access.origin, known.access.note));
			item.append(modelFactsRow);
			list.append(item);
		}
		card.append(list);
	}

	return card;
}

/**
 * Um rótulo pequeno: o papel, o estado, a origem.
 *
 * O atributo é o que dá o desenho — o papel e o estado são dois eixos
 * diferentes, e a origem tem pesos diferentes conforme quem falou.
 */
function tag(className: string, text: string, attribute?: string, value?: string): HTMLElement {
	const element = document.createElement('span');
	element.className = `tag ${className}`;
	element.textContent = text;
	if (attribute !== undefined && value !== undefined) {
		element.setAttribute(attribute, value);
	}
	return element;
}

/**
 * De onde veio um valor.
 *
 * A palavra nomeia a origem — o que o app declarou, o que o provedor
 * publicou, o que foi medido — e o *peso* diz o quanto se pode confiar
 * nisso: o nosso, o de fora, uma estimativa, ou nada.
 */
interface Origin {
	readonly label: string;
	readonly kind: 'ours' | 'theirs' | 'estimate' | 'unknown';
}

/** Um fato: o que é, o valor, a origem, e a ressalva. */
function fact(label: string, value: string, origin?: Origin, note?: string): HTMLElement {
	const element = document.createElement('div');
	element.className = 'fact';

	const labelElement = document.createElement('span');
	labelElement.className = 'fact-label';
	labelElement.textContent = label;
	element.append(labelElement);

	const valueElement = document.createElement('span');
	valueElement.className = origin?.kind === 'unknown' ? 'fact-value unknown' : 'fact-value';
	valueElement.textContent = value;
	element.append(valueElement);

	if (origin !== undefined) {
		const originElement = document.createElement('span');
		originElement.className = 'tag tag-origin';
		originElement.setAttribute('data-origin', origin.kind);
		originElement.textContent = origin.label;
		element.append(originElement);
	}

	if (note !== undefined && note.length > 0) {
		const noteElement = document.createElement('span');
		noteElement.className = 'fact-note';
		noteElement.textContent = note;
		element.append(noteElement);
	}

	return element;
}

/**
 * O que se sabe de um modelo: preço e acesso, com a origem de cada um.
 *
 * O preço vem do catálogo fundido: o que vale (e de quem é), o declarado e o
 * publicado, nessa ordem. Quando nenhum dos três existe, a resposta é
 * "desconhecido" — nenhum valor é inventado.
 */
function modelFacts(model: MergedModelView): {
	readonly price: { readonly value: string; readonly origin: Origin };
	readonly access: { readonly value: string; readonly origin: Origin; readonly note?: string };
} {
	const price = model.price;
	let priceValue: string;
	let priceOrigin: Origin;
	if (price?.effective !== undefined) {
		priceValue = describePriceAmounts(price.effective);
		priceOrigin =
			price.effective.side === 'user'
				? { label: 'declarado', kind: 'ours' }
				: { label: 'do provedor', kind: 'theirs' };
	} else if (price?.user !== undefined) {
		priceValue = describePriceAmounts(price.user);
		priceOrigin = { label: 'declarado', kind: 'ours' };
	} else if (price?.discovered !== undefined) {
		priceValue = describePriceAmounts(price.discovered);
		priceOrigin = { label: 'publicado', kind: 'theirs' };
	} else {
		priceValue = 'desconhecido';
		priceOrigin = { label: 'desconhecido', kind: 'unknown' };
	}

	const access = model.access;
	let accessValue: string;
	let accessOrigin: Origin;
	if (access !== undefined) {
		accessValue = access.access;
		accessOrigin = originForSource(access.source);
	} else if (model.declaredAccess !== undefined && model.declaredAccess !== 'unknown') {
		accessValue = model.declaredAccess;
		accessOrigin = { label: 'declarado', kind: 'ours' };
	} else {
		accessValue = 'desconhecido';
		accessOrigin = { label: 'desconhecido', kind: 'unknown' };
	}

	const notes: string[] = [];
	if (!model.listed) {
		notes.push('fora da listagem');
	}
	if (!model.policyStatus.eligible) {
		notes.push(`não elegível pela política: ${describePolicyExclusion(model.policyStatus)}`);
	}

	return {
		price: { value: priceValue, origin: priceOrigin },
		access: {
			value: accessValue,
			origin: accessOrigin,
			...(notes.length > 0 ? { note: notes.join(' · ') } : {}),
		},
	};
}

/** A origem de uma classificação de acesso. */
function originForSource(source: string): Origin {
	switch (source) {
		case 'manual':
			return { label: 'declarado', kind: 'ours' };
		case 'account':
			return { label: 'da conta', kind: 'theirs' };
		case 'provider':
			return { label: 'do provedor', kind: 'theirs' };
		default:
			return { label: source, kind: 'theirs' };
	}
}

/** A origem de uma cota, e o que ela significa. */
function quotaOrigin(source: string): Origin {
	switch (source) {
		case 'published':
			return { label: 'publicado', kind: 'theirs' };
		case 'account':
			return { label: 'da conta', kind: 'theirs' };
		case 'usage':
			return { label: 'contado', kind: 'ours' };
		case 'estimate':
			return { label: 'estimado', kind: 'estimate' };
		case 'observed':
			return { label: 'observado', kind: 'theirs' };
		default:
			return { label: 'origem desconhecida', kind: 'unknown' };
	}
}

/** A cota de um provedor, com a origem e o que se sabe. */
function quotaFact(quota: DiscoveredQuotaView | undefined): HTMLElement {
	const account = quota?.account;
	if (account === undefined) {
		return fact('cota', 'desconhecida', { label: 'desconhecida', kind: 'unknown' });
	}
	const value =
		account.remaining !== undefined ? `restante ${account.remaining}` : 'restante desconhecido';
	return fact('cota', value, quotaOrigin(account.source), describeQuotaSource(account.source));
}

/**
 * A última latência medida de um provedor.
 *
 * Vem das tentativas do histórico — o que o motor de rota mediu de verdade. Não
 * há média nem estimativa: a última medição, ou "não medida".
 */
function latencyFact(
	latency: { readonly totalMs: number; readonly modelId: string } | undefined,
): HTMLElement {
	if (latency === undefined) {
		return fact('latência', 'não medida', { label: 'não medida', kind: 'unknown' });
	}
	return fact('latência', `${latency.totalMs} ms`, { label: 'medida', kind: 'ours' }, `em ${latency.modelId}`);
}
/**
 * A última latência medida para um provedor.
 *
 * Vem das tentativas do histórico — o que o motor de rota mediu de verdade. Não
 * há média nem estimativa: a última medição, ou "não medida".
 */
function lastLatencyFor(
	providerId: string,
): { readonly totalMs: number; readonly modelId: string } | undefined {
	for (const execution of state.executionHistory) {
		for (const attempt of execution.report.attempts) {
			if (attempt.providerId === providerId && attempt.totalMs !== undefined) {
				return { totalMs: attempt.totalMs, modelId: attempt.modelId };
			}
		}
	}
	return undefined;
}

/**
 * Promove um endpoint a roteador, ou o reclassifica como provedor.
 *
 * A recusa do Core vem com a explicação — tipicamente, o modo externo está
 * usando aquele endpoint — e a lista de conexões é recarregada para refletir o
 * que foi aceito.
 */
async function changeProviderRole(
	providerId: string,
	role: 'router' | 'provider',
): Promise<void> {
	const bridge = state.bridge;
	if (bridge === undefined) {
		return;
	}
	clearError(byId('provider-error'));
	try {
		await bridge.setProviderRole(providerId, role);
	} catch (error) {
		report(error, byId('provider-error'), 'Não foi possível mudar o papel da conexão.');
	}
	await refreshProviders();
	await refreshRouterState();
	render();
}

/**
 * Habilita ou desabilita uma conexão.
 *
 * Desabilitar impede que a requisição saia para aquele endpoint, e faz o Core
 * recusar um destino desabilitado com o motivo.
 */
async function changeProviderEnabled(providerId: string, enabled: boolean): Promise<void> {
	const bridge = state.bridge;
	if (bridge === undefined) {
		return;
	}
	clearError(byId('provider-error'));
	try {
		await bridge.setProviderEnabled(providerId, enabled);
	} catch (error) {
		report(error, byId('provider-error'), 'Não foi possível mudar o estado da conexão.');
	}
	await refreshProviders();
	await refreshRouterState();
	render();
}

/**
 * Confirma a remoção de um provedor (DEV-8.15).
 *
 * Um diálogo da própria página, como `confirmDelete`: no Electron o
 * `window.confirm` nativo é bloqueado e devolveria `false` sem perguntar. O
 * nome vai como `textContent` — é texto do usuário.
 */
function confirmProviderRemoval(name: string): Promise<boolean> {
	return new Promise((resolve) => {
		const dialog = document.createElement('div');
		dialog.className = 'panel';
		dialog.setAttribute('role', 'dialog');
		dialog.setAttribute('aria-label', 'Remover provedor');
		dialog.id = 'provider-remove-dialog';
		const text = document.createElement('p');
		text.className = 'small';
		text.textContent = `Remover o provedor "${name}"? A configuração e a chave dele são apagadas.`;
		const row = document.createElement('div');
		row.className = 'row end';
		const cancel = document.createElement('button');
		cancel.type = 'button';
		cancel.className = 'secondary';
		cancel.textContent = 'Cancelar';
		const accept = document.createElement('button');
		accept.type = 'button';
		accept.className = 'danger';
		accept.textContent = 'Remover';
		accept.id = 'provider-remove-ok';
		row.append(cancel, accept);
		dialog.append(text, row);
		let settled = false;
		const close = (value: boolean): void => {
			if (settled) {
				return;
			}
			settled = true;
			dialog.remove();
			resolve(value);
		};
		cancel.addEventListener('click', () => close(false));
		accept.addEventListener('click', () => close(true));
		const host = byId('provider-error').parentElement ?? document.body;
		host.append(dialog);
		cancel.focus();
	});
}

/**
 * Pede ao endpoint os modelos e recarrega o painel (DEV-8.15).
 *
 * Funciona nos dois modos: o canal é o mesmo, e o `main` escolhe o Core local
 * ou o serviço. A lista não é apagada — a descoberta só registra o que veio.
 */
async function discoverProviderModels(providerId: string): Promise<void> {
	const bridge = state.bridge;
	if (bridge === undefined) {
		return;
	}
	clearError(byId('provider-error'));
	try {
		const resultado = await bridge.discoverModels(providerId);
		const falha = resultado.failed?.[0];
		if (falha !== undefined) {
			// DEV-8.17: a descoberta pode falhar sem que o provedor tenha
			// perdido nada. Dizer o motivo é o que separa "o endpoint não
			// respondeu" de "o endpoint não tem modelos".
			report(
				new Error(falha.reason),
				byId('provider-error'),
				'Não foi possível descobrir os modelos: o endpoint não respondeu.',
			);
		}
	} catch (error) {
		report(error, byId('provider-error'), 'Não foi possível descobrir os modelos do endpoint.');
	}
	await refreshProviders();
	await refreshAccessPolicy();
	render();
}

/**
 * Remove um provedor, com confirmação e recusa de uso ativo (DEV-8.15).
 *
 * A confirmação é da própria página, como as outras ações destrutivas: no
 * Electron o `window.confirm` nativo é bloqueado e devolveria `false` sem
 * perguntar. Um provedor que é **destino do roteador** ou está em uso por uma
 * conversa aberta não é removido: a remoção deixaria o modo apontando para
 * algo inexistente em silêncio.
 */
async function removeProviderFromList(provider: ProviderSummary): Promise<void> {
	const bridge = state.bridge;
	if (bridge === undefined) {
		return;
	}
	const router = state.routerConfig;
	const emUsoPeloRoteador =
		router !== undefined &&
		((router.mode === 'external' && router.externalRouterProviderId === provider.id) ||
			(router.mode === 'direct' && router.directProviderId === provider.id));
	const emUsoPorConversa = state.conversations.some(
		(conversation) => (conversation as { providerId?: string }).providerId === provider.id,
	);
	const motivo = emUsoPeloRoteador
		? 'Ele é o destino configurado do roteador. Escolha outro destino antes de removê-lo.'
		: emUsoPorConversa
			? 'Há uma conversa aberta neste provedor. Troque o provedor da conversa antes de removê-lo.'
			: undefined;
	if (motivo !== undefined) {
		report(new Error(motivo), byId('provider-error'), 'O provedor não foi removido.');
		return;
	}
	const confirmed = await confirmProviderRemoval(provider.name);
	if (!confirmed) {
		return;
	}
	clearError(byId('provider-error'));
	try {
		await bridge.removeProvider(provider.id);
	} catch (error) {
		report(error, byId('provider-error'), 'Não foi possível remover o provedor.');
	}
	await refreshProviders();
	await refreshRouterState();
	render();
}

function renderRouterPanel(): void {
	const config = state.routerConfig;
	const switchButton = byId<HTMLButtonElement>('router-switch');
	const mode = byId('router-mode');
	const destination = byId('router-destination');

	if (config === undefined) {
		switchButton.disabled = true;
		byId('router-switch-label').textContent = 'Carregando…';
		mode.textContent = '—';
		mode.removeAttribute('data-mode');
		destination.textContent = 'destino: desconhecido';
		byId('router-last').textContent = 'Lendo o estado do roteador…';
		byId('router-monitor').textContent = '';
		return;
	}

	// DEV-8.11: sem Core nem serviço não existe configuração *real*. Desenhar
	// o padrão como se fosse a decisão vigente foi o defeito que a interface
	// tinha no modo conectado; agora ela diz que não sabe, e por quê.
	if (config.source === 'unavailable') {
		switchButton.disabled = true;
		switchButton.setAttribute('aria-pressed', 'false');
		byId('router-switch-label').textContent = 'Roteador indisponível';
		mode.textContent = 'desconhecido';
		mode.removeAttribute('data-mode');
		destination.textContent = 'destino: desconhecido';
		byId('router-last').textContent =
			config.reason ?? 'Não há Core local nem serviço ativo para informar a configuração do roteador.';
		byId('router-monitor').textContent = '';
		return;
	}

	// DEV-8.14: o arquivo existe e não pôde ser lido. O modo e o interruptor
	// exibidos seriam os do **padrão**, não os gravados — afirmar "ligado" ali
	// é inventar um estado. A interface diz o que sabe e aponta o reparo.
	if (config.unreadable !== undefined) {
		switchButton.disabled = true;
		switchButton.setAttribute('aria-pressed', 'false');
		byId('router-switch-label').textContent = 'Roteador ilegível';
		mode.textContent = 'ilegível';
		mode.removeAttribute('data-mode');
		destination.textContent = 'destino: desconhecido';
		byId('router-last').textContent =
			'O arquivo do roteador existe, mas não pôde ser lido. Repare a configuração na janela de configurações.';
		byId('router-monitor').textContent = '';
		return;
	}

	switchButton.disabled = false;
	switchButton.setAttribute('aria-pressed', String(config.enabled));
	byId('router-switch-label').textContent = config.enabled ? 'Roteador ligado' : 'Roteador desligado';
	mode.textContent = describeRouterMode(config.mode);
	// O modo carrega o seu próprio desenho: o que se lê primeiro é *quem
	// decide*, e cada modo tem uma cara.
	mode.setAttribute('data-mode', config.mode);

	// O destino: o provedor que o modo aponta. No modo nativo, não há um
	// destino único — a Evelyn escolhe entre os provedores disponíveis.
	const target = routerTargetOf(config);
	destination.textContent =
		target === undefined
			? config.mode === 'native'
				? 'destino: a Evelyn escolhe entre os provedores'
				: 'destino: nenhum provedor escolhido'
			: `destino: ${target.name}`;

	const last = byId('router-last');
	const monitor = byId('router-monitor');
	const history = state.executionHistory[0];
	if (history === undefined) {
		last.textContent = 'Nenhuma requisição registrada ainda.';
	} else {
		last.textContent = describeLastDecision(history);
	}
	monitor.textContent = describeRouterMonitoring();
}

/** O nome do modo, com a diferença que importa. */
function describeRouterMode(mode: RouterConfigView['mode']): string {
	switch (mode) {
		case 'native':
			return 'Nativo';
		case 'external':
			return 'Externo';
		case 'direct':
			return 'Direto';
	}
}

/**
 * O provedor que o modo aponta, com o nome que o usuário lhe deu.
 *
 * `undefined` quando o modo não aponta nenhum — e a linha diz isso, em vez
 * de mostrar o provedor selecionado na interface, que seria outro destino.
 */
function routerTargetOf(config: RouterConfigView): { readonly id: string; readonly name: string } | undefined {
	const id = config.mode === 'external' ? config.externalRouterProviderId : config.directProviderId;
	if (id === undefined || id.length === 0) {
		return undefined;
	}
	const provider = state.providers.find((entry) => entry.id === id);
	return { id, name: provider?.name ?? id };
}

/**
 * A última decisão, em uma linha.
 *
 * No modo externo, quem escolheu o modelo é o roteador — e a linha diz isso.
 * Quando o servidor não publicou o modelo que respondeu, a linha diz que não
 * se sabe, em vez de afirmar que o modelo pedido respondeu.
 */
function describeLastDecision(execution: HistoryExecutionView): string {
	const report = execution.report;
	const parts: string[] = [];
	parts.push(`última requisição: ${report.result}`);
	const routing = report.routing;
	if (routing !== undefined) {
		const who =
			routing.decidedBy === 'external-router'
				? 'o roteador externo escolheu'
				: routing.decidedBy === 'provider'
					? 'o provedor atendeu'
					: 'a Evelyn escolheu';
		parts.push(who);
		if (routing.respondedModel !== undefined) {
			parts.push(
				routing.respondedModel === routing.requestedModel
					? `modelo ${routing.respondedModel}`
					: `pediu ${routing.requestedModel}, respondeu ${routing.respondedModel}`,
			);
		} else {
			parts.push(`pediu ${routing.requestedModel} (quem respondeu: desconhecido)`);
		}
	} else if (report.chosen !== undefined) {
		parts.push(`modelo ${report.chosen.modelId}`);
		parts.push(report.chosen.reason);
	}
	return parts.join(' · ');
}

/**
 * O monitoramento, em uma linha.
 *
 * Só o que muda o resultado de um turno: o consumo, o custo **conhecido** e a
 * situação das cotas. O que não é medido é dito como não medido — um "0"
 * onde houve medição é um número, e um "0" onde não houve é uma mentira.
 */
function describeRouterMonitoring(): string {
	const parts: string[] = [];
	const report = state.budgetReport;
	if (report !== undefined) {
		parts.push(`consumo: ${describeBudgetUsageShort(report)}`);
		parts.push(`custo: ${describeCost(report.total.cost)}`);
	} else {
		parts.push('consumo: desconhecido');
	}
	const quotas = state.quotas;
	if (quotas.length === 0) {
		parts.push('cotas: nenhuma informada');
	} else {
		const exhausted = quotas.filter((quota) => quota.account?.remaining === 0).length;
		const known = `${quotas.length} ${quotas.length === 1 ? 'conhecida' : 'conhecidas'}`;
		parts.push(
			exhausted > 0
				? `cotas: ${exhausted} de ${known} esgotada${exhausted === 1 ? '' : 's'}`
				: `cotas: ${known}`,
		);
	}
	return parts.join(' · ');
}

/** Applies one switch of the policy, then re-reads the merged view. */
async function saveAccessPolicyChange(input: {
	readonly policy?: 'any' | 'free_only' | 'free_preferred';
	readonly priceSource?: 'user' | 'discovered';
	readonly limitsSource?: 'user' | 'discovered';
	readonly capabilitiesSource?: 'user' | 'discovered';
}): Promise<void> {
	const bridge = state.bridge;
	if (bridge === undefined) {
		return;
	}
	try {
		state.accessPolicy = await bridge.setAccessPolicy(input);
		clearError(byId('access-policy-error'));
	} catch (error) {
		report(error, byId('access-policy-error'), 'Não foi possível salvar a política.');
	}
	await refreshAccessPolicy();
	render();
}

/** Money, exactly as far as the estimate goes; never rounded to hide a reason. */
function formatMoney(amount: number, currency: string): string {
	return `${amount.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 6 })} ${currency}`;
}

function describeCost(cost: BudgetReportView['total']['cost']): string {
	if (cost.status === 'estimated') {
		return formatMoney(cost.total, cost.currency);
	}
	const reasons = cost.reasons.length > 0 ? `: ${cost.reasons.join('; ')}` : '';
	return `desconhecido (estimativa não aplicável${reasons})`;
}

function describeBudgetUsage(usage: BudgetUsageView): string {
	const tokens = usage.tokens;
	const tokenText =
		tokens !== undefined
			? ` · ${(tokens.input ?? 0).toLocaleString('pt-BR')} in / ${(tokens.output ?? 0).toLocaleString('pt-BR')} out`
			: '';
	const source = usage.executions === 1 ? 'execução' : 'execuções';
	return `${usage.executions} ${source} · ${usage.attempts} tentativas${tokenText} · ${describeCost(usage.cost)}`;
}

/**
 * O consumo, na forma curta da linha do painel.
 *
 * O mesmo número que o painel de orçamento mostra, sem o detalhe das
 * tentativas: aqui o que importa é o tamanho, não a composição.
 */
function describeBudgetUsageShort(report: BudgetReportView): string {
	const usage = report.total;
	const tokens = usage.tokens;
	const tokenText =
		tokens !== undefined
			? ` · ${(tokens.input ?? 0).toLocaleString('pt-BR')} in / ${(tokens.output ?? 0).toLocaleString('pt-BR')} out`
			: '';
	return `${usage.executions} exec · ${usage.attempts} tent${tokenText}`;
}

const SCOPE_LABEL: Readonly<Record<SpendingLimitView['scope'], string>> = {
	global: 'geral',
	provider: 'provedor',
	policy: 'política',
	model: 'modelo',
};

/**
 * Como a previsão é escrita.
 *
 * O rótulo "previsto" nunca some: um número sem ele pareceria o que o ledger
 * registrou. `unknown` vira uma frase com os motivos, nunca "0".
 */
function describeForecast(forecast: CallForecastView): string {
	if (forecast.cost.status === 'estimated') {
		const parts = [`previsto ${formatMoney(forecast.cost.total, forecast.cost.currency)}`];
		const range = forecast.cost.range;
		if (range !== undefined) {
			parts.push(`faixa ${formatMoney(range.low, forecast.cost.currency)}–${formatMoney(range.high, forecast.cost.currency)}`);
		}
		if (forecast.outputTokens !== undefined) {
			const basis =
				forecast.outputBasis === 'conversation'
					? 'desta conversa'
					: forecast.outputBasis === 'model'
						? 'do modelo'
						: '';
			parts.push(`saída ≈ ${forecast.outputTokens.toLocaleString('pt-BR')} tokens ${basis}`.trim());
		}
		parts.push(
			forecast.confidence === 'high'
				? 'baseado em medições'
				: 'poucas medições',
		);
		if (forecast.truncated) {
			parts.push('entrada subestimada');
		}
		return parts.join(' · ');
	}
	const reasons = forecast.cost.reasons.length > 0 ? ` (${forecast.cost.reasons.join('; ')})` : '';
	return `sem previsão${reasons}`;
}

function renderBudgetAlerts(alerts: readonly BudgetAlertView[]): void {
	const list = byId('budget-alerts');
	list.textContent = '';
	if (alerts.length === 0) {
		setHidden(list, true);
		return;
	}
	setHidden(list, false);
	for (const alert of alerts) {
		const item = document.createElement('li');
		item.className = alert.fraction >= 1 ? 'error' : 'warning';
		item.textContent = alert.message;
		list.append(item);
	}
}

function renderBudgetConversations(conversations: readonly ConversationUsageView[]): void {
	const host = byId('budget-conversations');
	host.textContent = '';
	if (conversations.length === 0) {
		const empty = document.createElement('p');
		empty.className = 'muted small';
		empty.textContent = 'Nenhuma conversa com consumo neste período.';
		host.append(empty);
		return;
	}
	for (const conversation of conversations) {
		const block = document.createElement('div');
		block.className = 'budget-conversation';
		const heading = document.createElement('p');
		heading.className = 'small';
		const title = conversation.title ?? conversation.conversationId;
		heading.textContent = `${title} — registrado: ${describeCost(conversation.cost)}`;
		block.append(heading);
		if (conversation.forecast !== undefined) {
			const forecast = document.createElement('p');
			forecast.className = 'muted small';
			forecast.textContent = describeForecast(conversation.forecast);
			block.append(forecast);
		}
		const turns = document.createElement('ul');
		turns.className = 'muted small';
		// Os últimos turnos bastam para a leitura: um histórico longo vira
		// uma parede de números, e o total da conversa já está acima.
		for (const turn of conversation.turns.slice(-5)) {
			const item = document.createElement('li');
			const model = turn.modelIds[0] !== undefined ? `${turn.providerIds[0] ?? '?'}/${turn.modelIds[0]}` : '?';
			item.textContent = `${turn.turnId} · ${model} · ${describeBudgetUsage(turn)}`;
			turns.append(item);
		}
		block.append(turns);
		host.append(block);
	}
}

/**
 * A política de acesso e a fusão de preços, em texto.
 *
 * As duas colunas nunca se somam: "o seu preço" e "o do provedor" ficam como
 * estão, cada uma com a sua origem. Quando não são comparáveis, o motivo é
 * dito; quando o preço descoberto venceu, ele aparece marcado, não escondido.
 */
function renderAccessPolicyPanel(): void {
	const policySelect = byId<HTMLSelectElement>('access-policy-mode');
	const priceSelect = byId<HTMLSelectElement>('access-policy-price');
	const status = byId('access-policy-status');
	const host = byId('merged-catalog');
	host.textContent = '';

	const policy = state.accessPolicy;
	if (policy === undefined) {
		status.textContent = 'Política ainda não lida.';
		return;
	}
	policySelect.value = policy.policy;
	priceSelect.value = policy.priceSource;
	byId<HTMLSelectElement>('access-policy-limits').value = policy.limitsSource;
	byId<HTMLSelectElement>('access-policy-capabilities').value = policy.capabilitiesSource;
	status.textContent = `${describePolicy(policy)} · preço: ${priceSelect.selectedOptions[0]?.textContent ?? policy.priceSource}`;

	if (state.mergedModels.length === 0) {
		const empty = document.createElement('p');
		empty.className = 'muted small';
		empty.textContent =
			'Nenhum modelo descoberto ainda. Abra os provedores e liste os modelos para ver preços e acesso.';
		host.append(empty);
		return;
	}

	for (const model of state.mergedModels) {
		const block = document.createElement('div');
		block.className = 'budget-conversation';

		const heading = document.createElement('p');
		heading.className = 'small';
		heading.textContent = `${model.providerId}/${model.modelId}${describeAccessLine(model)}`;
		block.append(heading);

		const price = model.price;
		if (price !== undefined) {
			const userLine = document.createElement('p');
			userLine.className = 'muted small';
			userLine.textContent = describeDeclaredPrice(price);
			block.append(userLine);

			const discoveredLine = document.createElement('p');
			discoveredLine.className = 'muted small';
			discoveredLine.textContent = describeDiscoveredPrice(price);
			block.append(discoveredLine);

			const incompatible = describeIncompatibility(price);
			if (incompatible !== undefined) {
				const line = document.createElement('p');
				line.className = 'warning small';
				line.textContent = incompatible;
				block.append(line);
			}
			const fellBack = describePriceFallback(price);
			if (fellBack !== undefined) {
				const line = document.createElement('p');
				line.className = 'warning small';
				line.textContent = fellBack;
				block.append(line);
			}

			const effective = document.createElement('p');
			effective.className = 'small';
			effective.textContent = describeEffectivePrice(price);
			block.append(effective);
		} else {
			const unknown = document.createElement('p');
			unknown.className = 'muted small';
			unknown.textContent = 'Preço: nenhum dos dois lados informou. Desconhecido, nunca zero.';
			block.append(unknown);
		}

		host.append(block);
	}

	renderQuotas(host);
	renderFusedMetadata(host);
}

/**
 * Os limites e as capacidades fundidos, com os dois lados à vista.
 *
 * O conflito é mostrado, não resolvido: a tela diz que os dois discordam e
 * deixa a escolha com o usuário. Um valor que ninguém informou aparece como
 * "desconhecido", nunca como zero.
 */
function renderFusedMetadata(host: HTMLElement): void {
	for (const model of state.mergedModels) {
		const limits = model.limits;
		const capabilities = model.capabilities;
		if (limits === undefined && capabilities === undefined) {
			continue;
		}
		const block = document.createElement('div');
		block.className = 'budget-conversation';

		const heading = document.createElement('p');
		heading.className = 'small';
		heading.textContent = `Metadados de ${model.providerId}/${model.modelId}`;
		block.append(heading);

		if (limits?.contextTokens !== undefined) {
			const line = document.createElement('p');
			line.className = 'muted small';
			line.textContent = `Janela de contexto: ${describeFusedField(limits.contextTokens)}`;
			block.append(line);
		}
		if (limits?.maxOutputTokens !== undefined) {
			const line = document.createElement('p');
			line.className = 'muted small';
			line.textContent = `Limite de saída: ${describeFusedField(limits.maxOutputTokens)}`;
			block.append(line);
		}
		if (capabilities !== undefined) {
			for (const [name, field] of [
				['Ferramentas', capabilities.toolCalling],
				['Saída estruturada', capabilities.structuredOutput],
				['Raciocínio', capabilities.reasoning],
			] as const) {
				if (field === undefined) {
					continue;
				}
				const line = document.createElement('p');
				line.className = 'muted small';
				line.textContent = `${name}: ${describeFusedField(field)}`;
				block.append(line);
			}
			for (const [modality, field] of Object.entries(capabilities.inputs)) {
				const line = document.createElement('p');
				line.className = 'muted small';
				line.textContent = `Entrada ${modality}: ${describeFusedField(field)}`;
				block.append(line);
			}
			for (const [modality, field] of Object.entries(capabilities.outputs)) {
				const line = document.createElement('p');
				line.className = 'muted small';
				line.textContent = `Saída ${modality}: ${describeFusedField(field)}`;
				block.append(line);
			}
		}

		host.append(block);
	}
}

/**
 * As últimas decisões de roteamento, sem conteúdo de conversa.
 *
 * O relatório diz qual modelo respondeu e por quê; o que ele disse é do turno,
 * e o turno tem a sua própria história.
 *
 * Cada execução é um item que abre o relatório completo — a decomposição do
 * score, as restrições e o que faltou — e duas execuções podem ser marcadas
 * para comparação.
 */
function renderDecisionReports(host: HTMLElement): void {
	const history = state.executionHistory;
	if (history.length === 0) {
		const empty = document.createElement('p');
		empty.className = 'muted small';
		empty.textContent = 'Nenhuma decisão de roteamento registrada ainda.';
		host.append(empty);
		return;
	}
	for (const execution of history.slice(0, 10)) {
		const block = document.createElement('div');
		block.className = 'budget-conversation';

		const heading = document.createElement('p');
		heading.className = 'small';
		heading.textContent = `${execution.timestamp} · ${execution.report.result} · ${execution.report.chosen?.modelId ?? 'sem modelo'}`;
		block.append(heading);

		const summary = document.createElement('p');
		summary.className = 'muted small';
		summary.textContent = describeExecutionSummary(execution);
		block.append(summary);

		const actions = document.createElement('div');
		actions.className = 'row';

		const open = document.createElement('button');
		open.type = 'button';
		open.className = 'subtle';
		open.textContent = 'Abrir relatório';
		open.addEventListener('click', () => void openExecutionReport(execution.executionId));
		actions.append(open);

		const compare = document.createElement('button');
		compare.type = 'button';
		compare.className = 'subtle';
		const selected = state.comparedExecutions.includes(execution.executionId);
		compare.textContent = selected ? 'Remover da comparação' : 'Comparar';
		compare.addEventListener('click', () => void toggleCompared(execution.executionId));
		actions.append(compare);

		block.append(actions);
		host.append(block);
	}
	if (state.comparedExecutions.length === 2) {
		const button = document.createElement('button');
		button.type = 'button';
		button.textContent = 'Comparar as duas execuções marcadas';
		button.addEventListener('click', () => void showComparison());
		host.append(button);
	}
}

/** A linha de cabeçalho de uma execução, com o que há de comparável. */
function describeExecutionSummary(execution: HistoryExecutionView): string {
	const report = execution.report;
	const evaluation = report.evaluations.find((entry) => entry.chosen);
	const parts: string[] = [
		`política ${report.policy}`,
		`preço ${report.sources.price}`,
		`limites ${report.sources.limits}`,
	];
	if (evaluation?.score !== undefined) {
		parts.push(`pontuação ${evaluation.score}`);
	}
	const attempt = report.attempts.find((entry) => entry.outcome === 'success') ?? report.attempts[0];
	if (attempt?.totalMs !== undefined) {
		parts.push(`${attempt.totalMs}ms`);
	} else {
		parts.push('latência não medida');
	}
	if (attempt?.usage?.totalTokens !== undefined) {
		parts.push(`${attempt.usage.totalTokens} tokens`);
	} else {
		parts.push('tokens não publicados');
	}
	return parts.join(' · ');
}

/** Abre o relatório completo de uma execução, no mesmo lugar. */
async function openExecutionReport(executionId: string): Promise<void> {
	const bridge = state.bridge;
	const host = byId('decision-report-detail');
	if (bridge === undefined) {
		return;
	}
	host.textContent = '';
	try {
		const history = await bridge.listExecutionHistory(50);
		const execution = history.find((entry) => entry.executionId === executionId);
		if (execution === undefined) {
			const missing = document.createElement('p');
			missing.className = 'muted small';
			missing.textContent = 'Essa execução não está mais no histórico.';
			host.append(missing);
			return;
		}
		for (const line of describeDecisionReport(execution.report)) {
			const element = document.createElement('p');
			element.className = 'muted small';
			element.textContent = line;
			host.append(element);
		}
		// A classificação da tarefa, explicada: o domínio e as palavras-chave
		// que o indicaram, a evidência da complexidade e a base da confiança.
		if (execution.report.task !== undefined) {
			const heading = document.createElement('p');
			heading.className = 'small';
			heading.textContent = 'Como a tarefa foi classificada';
			host.append(heading);
			for (const line of describeTaskExplanation(execution.report.task)) {
				const element = document.createElement('p');
				element.className = 'muted small';
				element.textContent = line;
				host.append(element);
			}
		}
		for (const evaluation of execution.report.evaluations) {
			const title = document.createElement('p');
			title.className = 'small';
			title.textContent = `${evaluation.providerId}/${evaluation.modelId}${
				evaluation.score !== undefined ? ` · score ${evaluation.score}` : ' · não pontuado'
			}${evaluation.chosen ? ' · escolhido' : ''}`;
			host.append(title);
			for (const component of evaluation.components) {
				const line = document.createElement('p');
				line.className = 'muted small';
				line.textContent = `  ${component.points >= 0 ? '+' : ''}${component.points} ${component.label} — ${component.detail}`;
				host.append(line);
			}
			for (const constraint of evaluation.constraints) {
				const line = document.createElement('p');
				line.className = 'warning small';
				line.textContent = `  Restrição: ${constraint.label} — ${constraint.detail}`;
				host.append(line);
			}
			for (const item of evaluation.confidence) {
				const line = document.createElement('p');
				line.className = 'muted small';
				line.textContent = `  Confiança: ${item.label} — ${item.detail}`;
				host.append(line);
			}
		}
		clearError(byId('decision-report-error'));
	} catch (error) {
		report(error, byId('decision-report-error'), 'Não foi possível abrir o relatório.');
	}
}

/** Marca ou desmarca uma execução para comparação. */
async function toggleCompared(executionId: string): Promise<void> {
	const selected = state.comparedExecutions.includes(executionId);
	state.comparedExecutions = selected
		? state.comparedExecutions.filter((id) => id !== executionId)
		: [...state.comparedExecutions, executionId].slice(-2);
	render();
}

/** Compara as duas execuções marcadas. */
async function showComparison(): Promise<void> {
	const bridge = state.bridge;
	const host = byId('decision-comparison');
	if (bridge === undefined || state.comparedExecutions.length !== 2) {
		return;
	}
	host.textContent = '';
	try {
		const comparison = await bridge.compareExecutions(
			state.comparedExecutions[0] as string,
			state.comparedExecutions[1] as string,
		);
		for (const line of describeComparison(comparison)) {
			const element = document.createElement('p');
			element.className = comparison.status === 'accepted' ? 'muted small' : 'warning small';
			element.textContent = line;
			host.append(element);
		}
		clearError(byId('decision-report-error'));
	} catch (error) {
		report(error, byId('decision-report-error'), 'Não foi possível comparar as execuções.');
	}
}

/**
 * As cotas conhecidas, cada uma com a origem que a disse.
 *
 * A origem é o ponto: um limite publicado pelo provedor, um número que a API
 * informou para a conta, uma estimativa local e o uso que a Evelyn contou
 * são quatro fatos diferentes, e a tela nunca os mistura nem chama a
 * estimativa de limite oficial.
 */
function renderQuotas(host: HTMLElement): void {
	const quotas = state.quotas;
	if (quotas.length === 0) {
		const empty = document.createElement('p');
		empty.className = 'muted small';
		empty.textContent = 'Nenhuma cota informada pela API até agora.';
		host.append(empty);
		return;
	}
	for (const quota of quotas) {
		const block = document.createElement('div');
		block.className = 'budget-conversation';

		const heading = document.createElement('p');
		heading.className = 'small';
		const scope = quota.modelId === undefined ? quota.providerId : `${quota.providerId}/${quota.modelId}`;
		heading.textContent = `Cota de ${scope}`;
		block.append(heading);

		for (const line of describeQuota(quota)) {
			const element = document.createElement('p');
			element.className = 'muted small';
			element.textContent = line;
			block.append(element);
		}

		host.append(block);
	}
}

function renderBudgetPanel(): void {	const report = state.budgetReport;
	const total = byId('budget-total');
	const slices = byId('budget-slices');
	const list = byId('budget-limits');
	const current = byId('budget-current');
	list.textContent = '';

	if (report === undefined) {
		total.textContent = 'Consumo ainda não lido.';
		slices.textContent = '';
		current.textContent = '';
		renderBudgetAlerts([]);
		renderBudgetConversations([]);
		return;
	}

	total.textContent = `Total no período: ${describeBudgetUsage(report.total)}`;
	if (report.total.executionsWithoutCost > 0) {
		// Named explicitly: a total that is unknown because of one unpriced
		// model is a different fact from a total of zero.
		total.textContent += ` · ${report.total.executionsWithoutCost} sem custo conhecido`;
	}
	const topModels = report.byModel.slice(0, 3).map((slice) => {
		const label = `${slice.providerId}/${slice.modelId ?? '?'}`;
		return `${label}: ${describeCost(slice.cost)}`;
	});
	slices.textContent =
		report.byModel.length === 0 ? 'Nenhum consumo neste período.' : `Por modelo — ${topModels.join(' · ')}`;
	const window = report.period.window === 'day' ? 'hoje' : 'mês corrente';
	current.textContent = `${window} · ${report.limits.length} limite(s)`;
	renderBudgetAlerts(report.alerts);
	renderBudgetConversations(report.byConversation);

	if (report.limits.length === 0) {
		const empty = document.createElement('li');
		empty.className = 'muted';
		empty.textContent = 'Nenhum limite: modelos pagos seguem o switch de acesso pago.';
		list.append(empty);
		return;
	}
	for (const limit of report.limits) {
		const item = document.createElement('li');
		const where =
			limit.scope === 'global'
				? 'geral'
				: limit.scope === 'provider'
					? limit.providerId
					: `${limit.providerId}/${limit.modelId}`;
		const windowLabel = limit.window === 'day' ? 'diário' : 'mensal';
		const text = `${formatMoney(limit.amount, limit.currency)} ${windowLabel} — ${SCOPE_LABEL[limit.scope]} ${where}`;
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'secondary subtle small';
		button.dataset.limit = limit.limitId;
		button.textContent = 'Remover';
		item.append(`${text} `, button);
		list.append(item);
	}
}

/**
 * Saves the limit form.
 *
 * The amount is refused when blank rather than turned into zero: the Core
 * keeps a real `0` as "spend nothing", and a blank box that became zero would
 * silently stop every paid call.
 */
async function saveSpendingLimit(event: Event): Promise<void> {
	event.preventDefault();
	const bridge = state.bridge;
	if (bridge === undefined) {
		return;
	}
	const amount = byId<HTMLInputElement>('budget-amount').value.trim();
	const currency = byId<HTMLInputElement>('budget-currency').value.trim();
	if (amount.length === 0 || currency.length === 0) {
		showError(byId('budget-error'), 'Informe a moeda e o valor do limite.');
		return;
	}
	clearError(byId('budget-error'));
	try {
		const providerId = byId<HTMLInputElement>('budget-provider').value.trim();
		const modelId = byId<HTMLInputElement>('budget-model').value.trim();
		await bridge.saveSpendingLimit({
			...(providerId.length > 0 ? { providerId } : {}),
			...(modelId.length > 0 ? { modelId } : {}),
			currency,
			amount,
			window: byId<HTMLSelectElement>('budget-limit-window').value === 'day' ? 'day' : 'month',
		});
		byId<HTMLInputElement>('budget-amount').value = '';
		await refreshBudget();
	} catch (error) {
		report(error, byId('budget-error'), 'Não foi possível salvar o limite.');
	}
}

async function removeSpendingLimit(limitId: string): Promise<void> {
	const bridge = state.bridge;
	if (bridge === undefined) {
		return;
	}
	clearError(byId('budget-error'));
	try {
		await bridge.removeSpendingLimit(limitId);
		await refreshBudget();
	} catch (error) {
		report(error, byId('budget-error'), 'Não foi possível remover o limite.');
	}
}

/** Loads what is recorded about every model. */
async function refreshModelCatalog(): Promise<void> {	const bridge = state.bridge;
	if (bridge === undefined) {
		return;
	}
	try {
		state.modelCatalog = await bridge.listModelCatalog();
		// A selection that pointed at a record the store no longer has would
		// leave the form describing something that is not there.
		if (selectedCatalogEntry() === undefined && state.modelCatalog.length > 0) {
			state.catalogSelection = '0';
			state.catalogDraft = false;
		}
		clearError(byId('catalog-error'));
	} catch (error) {
		state.modelCatalog = [];
		report(error, byId('catalog-error'), 'Could not read the model catalog.');
	}
	render();
}

async function saveCatalogEntry(event: Event): Promise<void> {
	event.preventDefault();
	const bridge = state.bridge;
	if (bridge === undefined) {
		return;
	}

	const providerId = byId<HTMLInputElement>('catalog-provider').value.trim();
	const modelId = byId<HTMLInputElement>('catalog-model').value.trim();
	if (providerId.length === 0 || modelId.length === 0) {
		showError(byId('catalog-error'), 'A model needs both a provider and a model id.');
		return;
	}

	const currency = byId<HTMLInputElement>('catalog-currency').value.trim();
	const priceInput = byId<HTMLInputElement>('catalog-price-input').value.trim();
	const priceOutput = byId<HTMLInputElement>('catalog-price-output').value.trim();
	// A price with no currency cannot be stored, so it is cleared rather than
	// saved as half a price. The two numbers alone would read as free.
	const pricing =
		currency.length === 0
			? null
			: {
					currency,
					unit: byId<HTMLSelectElement>('catalog-unit').value as 'per_1k_tokens' | 'per_1m_tokens',
					// Empty boxes are sent as absent, and the Core reads absent as
					// unknown. Sending `''` would be a number-less field to parse.
					...(priceInput.length > 0 ? { input: priceInput } : {}),
					...(priceOutput.length > 0 ? { output: priceOutput } : {}),
				};

	const context = byId<HTMLInputElement>('catalog-context').value.trim();
	const maxOutput = byId<HTMLInputElement>('catalog-max-output').value.trim();
	const limits =
		context.length === 0 && maxOutput.length === 0
			? null
			: {
					...(context.length > 0 ? { contextTokens: context } : {}),
					...(maxOutput.length > 0 ? { maxOutputTokens: maxOutput } : {}),
				};

	const notes = byId<HTMLTextAreaElement>('catalog-notes').value.trim();

	// A matriz de capacidades: marcada é `true`, desmarcada é desconhecida.
	// Um "não" declarado exigiria um terceiro estado na caixa, e a caixa não
	// tem um: por isso o formulário **não** afirma "não tem" — ele devolve
	// `null`, que o catálogo lê como "volte a desconhecido".
	const capabilitiesPatch = {
		toolCalling: byId<HTMLInputElement>('catalog-tool-calling').checked ? true : null,
		structuredOutput: byId<HTMLInputElement>('catalog-structured-output').checked
			? true
			: null,
		reasoning: byId<HTMLInputElement>('catalog-reasoning').checked ? true : null,
	};

	clearError(byId('catalog-error'));
	try {
		const saved = await bridge.saveModelCatalogEntry({
			providerId,
			modelId,
			capabilities: byId<HTMLInputElement>('catalog-capabilities').value,
			pricing,
			access: byId<HTMLSelectElement>('catalog-access').value as 'free' | 'paid' | 'unknown',
			limits,
			model: capabilitiesPatch,
			// Blank means "put it back to unknown", which is why this is a
			// deliberate null rather than an omitted field.
			notes: notes.length === 0 ? null : notes,
		});
		// Land on the record that was just written, so the form and the list
		// agree and the summary names something real.
		state.catalogDraft = false;
		state.catalogSelection = String(
			state.modelCatalog.findIndex(
				(entry) => entry.providerId === saved.providerId && entry.modelId === saved.modelId,
			),
		);
		await refreshModelCatalog();
	} catch (error) {
		report(error, byId('catalog-error'), 'Could not save this model.');
	}
}

async function clearCatalogEntry(): Promise<void> {
	const bridge = state.bridge;
	const entry = selectedCatalogEntry();
	if (bridge === undefined || entry === undefined) {
		return;
	}
	clearError(byId('catalog-error'));
	try {
		await bridge.removeModelCatalogEntry({
			providerId: entry.providerId,
			modelId: entry.modelId,
		});
		// Back to the draft form: the record is gone, and leaving the form
		// pointing at it would offer to save a model that no longer exists.
		state.catalogDraft = true;
		state.catalogSelection = CATALOG_NEW;
		await refreshModelCatalog();
	} catch (error) {
		report(error, byId('catalog-error'), 'Could not forget this model.');
	}
}

function renderConversationList(): void {
	const list = byId('conversation-list');
	list.textContent = '';

	for (const item of state.conversations) {
		const row = document.createElement('li');
		row.className = 'conversation-row';
		if (item.pinned === true) {
			row.classList.add('pinned');
		}

		const button = document.createElement('button');
		button.type = 'button';
		button.className =
			item.id === state.selectedConversationId ? 'conversation selected' : 'conversation';
		button.dataset.conversationId = item.id;
		button.disabled = isBusy();
		// O nome é a linha inteira: a contagem de mensagens ocupava uma segunda
		// linha em cada entrada e era isso que fazia a lista parecer poluída.
		// Ela continua na cabeça da conversa aberta, onde é lida de fato.
		button.textContent = item.title;
		row.append(button);

		// A lixeira é a única outra coisa na linha. Numa conversa permanente
		// (o diálogo de preferências) ela não existe: o que não pode ser feito
		// não é oferecido desabilitado.
		if (item.pinned !== true) {
			const remove = document.createElement('button');
			remove.type = 'button';
			remove.className = 'conversation-delete';
			remove.dataset.deleteConversationId = item.id;
			remove.setAttribute('aria-label', `Apagar "${item.title}"`);
			remove.title = 'Apagar conversa';
			remove.textContent = '×';
			remove.disabled = isBusy();
			row.append(remove);
		} else {
			const mark = document.createElement('span');
			mark.className = 'conversation-pinned';
			mark.title = 'Conversa permanente — não pode ser apagada';
			mark.textContent = '•';
			row.append(mark);
		}

		list.append(row);
	}

	setHidden(byId('conversation-empty'), state.conversations.length > 0);
	byId<HTMLButtonElement>('conversation-new').disabled =
		// R4E: no modo conectado a criação é do serviço; o botão depende de um
		// modelo escolhido (o provedor vem dele) e de não haver criação em
		// curso nem turno rodando.
		(state.coreMode === 'connected'
			? state.selectedModel.length === 0 || state.creatingConversation || isBusy()
			: state.selectedProviderId.length === 0 || isBusy());
}

function renderConversationHeader(): void {
	const item = currentConversation();
	const title = byId<HTMLInputElement>('conversation-title');

	title.value = item?.title ?? '';
	// Readable while nothing is open or while a turn runs (a rename would
	// write over the list the turn is using); editable otherwise. It was
	// unconditionally read-only, which made renaming unreachable entirely —
	// Enter and blur both saw an unchanged title and returned.
	title.readOnly = item === undefined || isBusy();
	byId<HTMLButtonElement>('conversation-rename').disabled = item === undefined || isBusy();
	byId<HTMLButtonElement>('conversation-delete').disabled = item === undefined || isBusy();

	byId('conversation-meta').textContent =
		item === undefined ? '' : `${item.messageCount} messages · ${item.updatedAt.slice(0, 19).replace('T', ' ')}`;
}

/** Draws the whole transcript. Cheap, and it cannot drift out of sync. */
/**
 * O Markdown de uma resposta, com um cache de um item por mensagem.
 *
 * Cada delta redesenha a conversa inteira. Sem cache, uma resposta de trinta
 * parágrafos teria o Markdown reanalisado a cada token, para todas as
 * mensagens anteriores também. O cache é por **conteúdo** (não por posição),
 * então ele não serve resultado velho: o texto mudou, ele refaz.
 *
 * Guarda até duas entradas — a mensagem que está chegando e a última que
 * fechou — porque é esse o par que se alterna enquanto o turno roda.
 */
const markdownCache = new Map<string, MarkdownNode[]>();

function markdownFor(content: string): Node[] {
	const cached = markdownCache.get(content);
	if (cached !== undefined) {
		// Reuso de nodos: o balão novo precisa de cópias, senão o mesmo nodo
		// seria movido de um balão antigo para outro (o DOM move, não copia).
		return cached.map((node) => node.cloneNode(true) as unknown as Node);
	}
	const rendered = renderMarkdown(document, content);
	markdownCache.set(content, rendered.map((node) => node.cloneNode(true)));
	if (markdownCache.size > 2) {
		const oldest = markdownCache.keys().next().value;
		if (oldest !== undefined) {
			markdownCache.delete(oldest);
		}
	}
	return rendered as unknown as Node[];
}

function renderMessages(): void {
	const container = byId('messages');
	container.textContent = '';

	if (state.messages.length === 0) {
		const empty = document.createElement('p');
		empty.className = 'empty';
		empty.textContent =
			state.selectedConversationId.length === 0
				? 'Pick or create a conversation, then say something.'
				: 'This conversation is empty. Say something to start.';
		container.append(empty);
		return;
	}

	for (const [index, message] of state.messages.entries()) {
		const wrapper = document.createElement('div');
		const isLast = index === state.messages.length - 1;
		wrapper.className = `message ${message.role}`;
		if (isLast && message.role === 'assistant' && isBusy()) {
			wrapper.classList.add('streaming');
		}

		const role = document.createElement('span');
		role.className = 'role';
		role.textContent =
			message.role === 'user'
				? 'You'
				: message.role === 'system'
					? 'System'
					: message.role === 'tool'
						? `Tool · ${message.toolName ?? 'result'}`
						: message.role === 'toolError'
							? `Tool failed · ${message.toolName ?? 'result'}`
							: message.role === 'error'
								? 'Error'
								: 'Assistant';

		const bubble = document.createElement('div');
		bubble.className = 'bubble';
		if (message.role === 'assistant') {
			// Markdown só para o que o modelo escreveu. A mensagem do usuário
			// continua literal: o que a pessoa digitou não deve ganhar
			// formatação, e o resultado de ferramenta é saída de máquina.
			//
			// O renderizador devolve **nodos**, nunca HTML — ver
			// `markdown.ts`. Ainda assim ele roda a cada render, e um texto
			// grande com uma tabela refaz o parse a cada delta; o cache guarda
			// o resultado por conteúdo, que é estável enquanto o delta não
			// chega.
			const rendered = markdownFor(message.content);
			if (rendered.length === 0) {
				bubble.textContent = message.content;
			} else {
				bubble.append(...rendered);
			}
		} else {
			bubble.textContent = message.content;
		}

		wrapper.append(role, bubble);
		container.append(wrapper);
	}

	container.scrollTop = container.scrollHeight;
}

/**
 * O botão "Tarefa" (DEV-9.1, item 3).
 *
 * Só existe no modo local: é ele que monta o turno aqui. No modo conectado o
 * turno roda no serviço, que ainda não recebe `task` — oferecer o botão ali
 * seria prometer um limite maior que não chega a quem executa.
 */
function renderTaskToggle(): void {
	const toggle = byId<HTMLButtonElement>('task-toggle');
	const local = state.coreMode !== 'connected';
	toggle.hidden = !local;
	if (!local) {
		return;
	}
	toggle.setAttribute('aria-pressed', String(state.taskMode));
	toggle.disabled = isBusy();
	toggle.textContent = state.taskMode ? 'Tarefa: ligada' : 'Tarefa';
	toggle.classList.toggle('accent', state.taskMode);
}

function renderComposerState(): void {
	const send = byId<HTMLButtonElement>('send');
	const stop = byId<HTMLButtonElement>('stop');
	const retry = byId<HTMLButtonElement>('retry');
	const input = byId<HTMLTextAreaElement>('input');
	const busy = isBusy();

	send.disabled = !canSend();
	send.textContent = busy ? 'Sending…' : 'Send';
	// A greyed Send with no explanation is the single most confusing state this
	// window has: `canSend` depends on four things, two of which are chosen
	// elsewhere in the sidebar, and nothing on screen says which one is missing.
	// As a tooltip it is invisible on a disabled button, so the reason also goes
	// on the button's accessible name and is drawn under the composer.
	const reason = sendBlockedReason();
	send.title = reason ?? '';
	setHidden(byId<HTMLElement>('send-hint'), reason === null);
	if (reason !== null) {
		byId<HTMLElement>('send-hint').textContent = reason;
	}
	setHidden(stop, !busy);
	// Retry only after a failed turn, and never while one is running: re-running
	// over a live answer would interleave two turns into one transcript.
	setHidden(retry, !(state.lastTurnFailed && !busy));
	// Disabled with no conversation open, so the box cannot accept a message
	// that has nowhere to go.
	input.disabled = state.selectedConversationId.length === 0;
}

/** Why Send is disabled, or `null` when it is not. */
function sendBlockedReason(): string | null {
	if (state.bridge === undefined) {
		return 'The app is still starting.';
	}
	if (state.activeTurnId !== undefined) {
		return 'This turn is still running.';
	}
	// R4S: no modo conectado há modelos e provedor, mas não uma lista **local**
	// de provedores — os dois `[]` abaixo só valem com Core local.
	if (state.coreMode !== 'connected' && state.providers.length === 0) {
		return 'Add a provider first.';
	}
	// DEV-8.9: no automático, a lista de modelos é a que o motor pode escolher —
	// sem nenhuma, não há o que escolher. Mas um modelo **selecionado** não é
	// mais exigido: quem escolhe é o motor.
	// DEV-8.10: o mesmo vale no modo conectado, onde o serviço executa o turno.
	const automatic = effectiveTurnMode(state.turnMode, state.routerConfig) === 'auto';
	if (state.availableModels.length === 0) {
		return automatic
			? 'Nenhum modelo disponível: o modo automático precisa de ao menos um provedor alcançável.'
			: 'No models available. Check that a provider is reachable, then press Refresh.';
	}
	if (!automatic && state.selectedModel.length === 0) {
		return 'Pick a model.';
	}
	if (!automatic && state.selectedProviderId.length === 0) {
		return 'Pick a provider.';
	}
	if (state.selectedConversationId.length === 0) {
		return 'Open or create a conversation first.';
	}
	return null;
}

/**
 * The thinking indicator.
 *
 * Shown only while the model is reasoning and has *not* started answering. Once
 * the first text delta creates the assistant's message, the indicator is gone:
 * the streaming caret in that bubble already says the answer is arriving, and a
 * "thinking" line next to a half-written answer would claim the opposite.
 *
 * `state.reasoning` is still accumulated by the events but nothing renders it
 * now — it is the signal that the model is thinking at all, and on a reasoning
 * model there is a long pause before any other event arrives.
 */
function renderThinking(): void {
	const panel = byId<HTMLElement>('thinking');
	const busy = isBusy();
	const last = state.messages[state.messages.length - 1];
	const answering = last !== undefined && last.role === 'assistant';

	setHidden(panel, !(busy && state.reasoning.length > 0 && !answering));
}

function renderSystemPrompt(prompt: string): void {
	const field = byId<HTMLTextAreaElement>('system-prompt');
	field.value = prompt;
	const enabled = state.selectedConversationId.length > 0 && !isBusy();
	field.disabled = !enabled;
	byId<HTMLButtonElement>('system-save').disabled = !enabled;
	byId<HTMLButtonElement>('system-clear').disabled = !enabled;
}

function render(): void {
	renderProviderList();
	renderProviderForm();
	renderProjectPanel();
	renderTurnModeSelect();
	renderModelList();
	renderLastTurnRouting();
	renderStrategySelect();
	renderCatalogPanel();
	renderConversationList();
	renderConversationHeader();
	renderMessages();
	renderThinking();
	renderComposerState();
	renderTaskToggle();
	renderSystemPrompt(byId<HTMLTextAreaElement>('system-prompt').value);
	renderBudgetPanel();
	renderAccessPolicyPanel();
	renderRouterPanel();
	renderRouterSettings();
	renderServiceControl();
	renderConnections();
	renderDecisionReports(byId('decision-reports'));
}

// ── core status ─────────────────────────────────────────────────────────────

async function loadCoreStatus(): Promise<void> {
	const bridge = state.bridge;
	if (bridge === undefined) {
		return;
	}
	try {
		const status = await bridge.getCoreStatus();
		state.coreMode = status.mode;
		byId('app-name').textContent = status.appName;
		byId('version').textContent = `v${status.version}`;
		byId('data-directory').textContent = status.dataDirectory || '—';
		const dot = byId('status-dot');
		const label = byId('status-label');
		dot.classList.remove('ok', 'failed');
		if (status.mode === 'connected') {
			// R4B: os dados são do serviço; este app só lê o que ele expõe.
			// Dizer só "Core running" seria mentira — não há Core aqui.
			dot.classList.add('ok');
			label.textContent = 'Conectado ao serviço';
			byId('agent-badge').hidden = true;
			clearError(byId('core-error'));
		} else if (status.mode === 'unavailable') {
			dot.classList.add('failed');
			label.textContent = 'Sem dados';
			byId('agent-badge').hidden = true;
			showCoreNote(
				'Não há Core nem serviço local ativo. O aplicativo está aberto sem os dados',
			);
		} else {
			dot.classList.add('ok');
			label.textContent = 'Core running';
			byId('agent-badge').hidden = false;
			clearError(byId('core-error'));
		}
	} catch (error) {
		byId('status-dot').classList.remove('ok');
		byId('status-dot').classList.add('failed');
		byId('status-label').textContent = 'Core unavailable';
		report(error, byId('core-error'), 'Could not read the Core status.');
	}
	// O modo acabou de mudar, e há painéis que dependem dele. O da janela de
	// configurações é o DEV: é ele que decide se oferece "reabrir em modo
	// local". Sem este desenho, a leitura chegava depois do primeiro render e
	// o bloco nunca aparecia — medido no pacote.
	render();
}

/** A nota do estado do Core, sem confundir com erro de rede. */
function showCoreNote(message: string): void {
	const host = byId('core-error');
	host.hidden = false;
	host.textContent = message;
}

/**
 * O estado do serviço local, mostrado junto do Core (R4B).
 *
 * Diz `connected`/`disconnected`/`error` e, quando conectado, quantos
 * provedores e modelos o serviço conhece. Não há credencial nenhuma aqui: o
 * processo principal devolve só o estado.
 */
async function loadServiceStatus(): Promise<void> {
	const bridge = state.bridge;
	if (bridge === undefined) {
		return;
	}
	try {
		const status = await bridge.getServiceStatus();
		const dot = byId('status-dot');
		if (status.state === 'active') {
			dot.classList.remove('failed');
			dot.classList.add('ok');
			byId('status-label').textContent = 'Conectado ao serviço';
			byId('agent-badge').hidden = true;
			clearError(byId('core-error'));
			return;
		}
		if (state.coreMode === 'local') {
			// Em modo local o serviço não precisa estar no ar: o comentário
			// do Core já está desenhado, e sobrescrevê-lo confundiria.
			return;
		}
		dot.classList.remove('ok');
		dot.classList.add('failed');
		byId('status-label').textContent =
			status.reason === 'unauthorized' || status.reason === 'timeout' || status.reason === 'unreachable'
				? 'Serviço inacessível'
				: 'Serviço desconectado';
		showCoreNote(status.detail);
	} catch (error) {
		report(error, byId('core-error'), 'Could not read the local service status.');
	}
}

// ── providers ───────────────────────────────────────────────────────────────

async function refreshProviders(): Promise<void> {
	const bridge = state.bridge;
	if (bridge === undefined) {
		return;
	}
	// DEV-8.12: no modo conectado não há Core local e a lista de provedores vem
	// vazia. O painel do roteador precisa de destinos mesmo assim, e o serviço
	// publica os provedores que **servem modelos** pelo catálogo (id e nome,
	// nunca chave). É o que preenche os selects de destino.
	if (state.coreMode !== 'local') {
		await refreshServiceProviders();
		return;
	}
	try {
		state.providers = await bridge.listProviders();
		// Keep the selection if it survived; otherwise take the first, so a
		// configured app lands on something usable without a click.
		if (!state.providers.some((provider) => provider.id === state.selectedProviderId)) {
			state.selectedProviderId = state.providers[0]?.id ?? '';
			// The model list is global now, so it is not discarded here; the
			// selection is, because it named a provider that no longer exists.
			state.selectedModel = '';
			// A different provider means different conversations.
			state.conversations = [];
			state.selectedConversationId = '';
			state.messages = [];
		}
	} catch (error) {
		report(error, byId('provider-error'), 'Could not list providers.');
		return;
	}
	await refreshConversations();
}

/**
 * Os provedores no modo conectado (DEV-8.15).
 *
 * Vêm de `listProviders`, que o `main` passou a ler do **serviço**
 * (`GET /api/providers`). Antes eram derivados do catálogo, e um provedor sem
 * modelos — recém-cadastrado — desaparecia do painel. A lista do serviço
 * inclui todos, e é a mesma que a página do serviço mostra.
 */
async function refreshServiceProviders(): Promise<void> {
	const bridge = state.bridge;
	if (bridge === undefined) {
		return;
	}
	try {
		const providers = await bridge.listProviders();
		state.providers = [...providers].sort((a, b) => a.name.localeCompare(b.name));
		// O catálogo alimenta a lista de modelos de cada provedor e o seletor.
		await refreshAccessPolicy();
	} catch (error) {
		report(error, byId('router-error'), 'Não foi possível listar os provedores do serviço.');
	}
}

/** Loads the conversation list for the selected provider. */
async function refreshConversations(): Promise<void> {	const bridge = state.bridge;
	if (bridge === undefined) {
		state.conversations = [];
		render();
		return;
	}
	// R4D: em modo conectado a lista vem do serviço, que é o dono dos dados.
	// Não há provedor selecionado neste processo — a condição abaixo é do modo
	// local, onde a conversa pertence a um provedor configurado aqui.
	if (state.coreMode === 'connected') {
		await refreshServiceConversations(bridge);
		return;
	}
	if (state.selectedProviderId.length === 0) {
		state.conversations = [];
		render();
		return;
	}
	try {
		state.conversations = await bridge.listConversations();
		clearError(byId('conversation-error'));
	} catch (error) {
		state.conversations = [];
		report(error, byId('conversation-error'), 'Could not list conversations.');
	}
	// `refreshProviders` hands rendering to this function rather than doing it
	// itself, so this has to redraw on *every* path. Without it the provider
	// list never appeared after a save, because the success path fell through
	// without painting — the bug a real run caught and a type check could not.
	render();
}

/**
 * A lista de conversas do serviço (R4D).
 *
 * Mostra o que o serviço tem. Uma lista vazia é desenhada como vazia — nunca
 * preenchida com exemplo. Um erro diz o motivo, e a lista fica vazia em vez
 * de manter a anterior, que já não corresponde ao que o serviço tem.
 */
async function refreshServiceConversations(bridge: SeshyinaBridge): Promise<void> {
	// A geração sobe **antes** do pedido: a resposta desta chamada só vale se
	// nenhuma outra começou depois dela.
	state.listGeneration += 1;
	const generation = state.listGeneration;
	try {
		const listed = await bridge.listServiceConversations();
		if (generation !== state.listGeneration) {
			// Chegou atrasada: uma listagem mais nova já está a caminho (ou já
			// chegou). Aplicá-la reintroduziria o estado antigo.
			return;
		}
		if (!listed.ok) {
			state.conversations = [];
			showError(
				byId('conversation-error'),
				listed.code === 'inactive'
					? 'O serviço local não está ativo: não há conversas para mostrar.'
					: `Não foi possível listar as conversas: ${listed.message}`,
			);
		} else {
			// O formato que o sidebar desenha é o mesmo do modo local; o serviço
			// não publica `providerId`, e a interface não usa o campo na lista.
			//
			// Trocar só a lista: a conversa selecionada e o histórico na tela
			// continuam os mesmos. Atualizar a barra lateral não é reabrir.
			state.conversations = listed.conversations.map((conversation) => ({
				id: conversation.id,
				title: conversation.title,
				providerId: '',
				createdAt: conversation.createdAt,
				updatedAt: conversation.updatedAt,
				messageCount: conversation.messageCount,
			}));
			clearError(byId('conversation-error'));
		}
	} catch (error) {
		if (generation !== state.listGeneration) {
			return;
		}
		state.conversations = [];
		report(error, byId('conversation-error'), 'Não foi possível listar as conversas do serviço.');
	}
	render();
}

async function saveProvider(event: Event): Promise<void> {
	event.preventDefault();
	const bridge = state.bridge;
	if (bridge === undefined || isBusy()) {
		return;
	}

	const baseUrl = byId<HTMLInputElement>('provider-base-url').value.trim();
	const name = byId<HTMLInputElement>('provider-name').value.trim();
	const key = byId<HTMLInputElement>('provider-api-key').value;
	const previousId = state.selectedProviderId;
	const previousUrl = currentProvider()?.baseUrl;

	clearError(byId('provider-error'));

	try {
		// An untouched key field is omitted entirely, which the session reads as
		// "leave the stored key alone" rather than "replace it with blank".
		const saved = await bridge.saveProvider({
			baseUrl,
			...(name.length > 0 ? { name } : {}),
			...(key.length > 0 ? { apiKey: key } : {}),
		});
		if (saved.id !== previousId) {
			// The id derives from the URL, so a changed URL produced a
			// *different* provider. The conversation list and the transcript on
			// screen belong to the previous one — carrying them over left Send
			// pairing the new endpoint with the old conversation.
			state.selectedModel = '';
			state.conversations = [];
			state.selectedConversationId = '';
			state.messages = [];
		} else if (previousUrl !== undefined && previousUrl !== saved.baseUrl) {
			// Same provider, edited endpoint: whatever models it offered came
			// from the old URL, and the list is not rebuilt until the refresh.
			state.selectedModel = '';
		}
		state.selectedProviderId = saved.id;
		// The draft described a provider that now exists, so the form belongs to
		// the saved one again.
		state.providerDraft = false;
		await refreshProviders();
		// Fetch the model list here instead of waiting for a click on `Models`.
		// Nothing else repopulates it, and Send is disabled while `selectedModel`
		// is empty — so saving a provider left the app in a state where the only
		// way forward was a button in a panel the user had just closed, with no
		// indication that Send was greyed for that reason.
		await loadModels();
	} catch (error) {
		report(error, byId('provider-error'), 'Could not save the provider.');
	}
}

/**
 * Fetches every model from every enabled provider.
 *
 * No longer takes a provider: the sidebar picks a model and the provider comes
 * with it, so the list is global by construction. A provider that is down is
 * skipped inside `ChatSession`, so an empty result here means every provider
 * failed or none is configured — which are different problems and are reported
 * differently below.
 */
async function loadModels(): Promise<void> {
	const bridge = state.bridge;
	if (bridge === undefined || isBusy()) {
		return;
	}
	// R4S: no modo conectado os provedores são os do **serviço**, e o app não
	// recebe a lista deles (`PROVIDER_CHANNEL.list` devolve `[]` sem Core
	// local). Exigir um provedor local aqui fazia a lista de modelos nunca ser
	// pedida — a tela ficava vazia mesmo com o serviço oferecendo modelos.
	if (state.coreMode !== 'connected' && state.providers.length === 0) {
		return;
	}
	// One load at a time. This list costs one request per provider, so anything
	// that triggers it while a load is already in flight waits for that one
	// rather than starting a second identical round of HTTP calls.
	if (modelsLoading !== undefined) {
		await modelsLoading;
		return;
	}
	const button = byId<HTMLButtonElement>('model-refresh');
	button.disabled = true;
	clearError(byId('model-error'));

	modelsLoading = (async () => {
		const previous = state.selectedModel;
		try {
			const models = await bridge.listAvailableModels();
			state.availableModels = models;
			// The previous selection survives only if that exact model is still
			// offered. Comparing the name alone would silently move the
			// conversation onto a different provider's model of the same name.
			const stillThere = models.find(
				(entry) => entry.model === previous && entry.providerId === state.selectedProviderId,
			);
			if (stillThere !== undefined) {
				state.selectedModel = previous;
			} else {
				const first = models[0];
				// Preselected because sending with nothing selected only produces a
				// server-side error about a missing model name.
				state.selectedModel = first?.model ?? '';
				// The provider follows the model: conversations belong to a
				// provider, so choosing a model from another one has to move the
				// list with it or the transcript on screen would belong to an
				// endpoint that cannot see it.
				state.selectedProviderId = first?.providerId ?? state.selectedProviderId;
			}
			if (models.length === 0) {
				showError(
					byId('model-error'),
					'No models yet. Check that a provider is reachable, then press Refresh.',
				);
			}
		} catch (error) {
			state.availableModels = [];
			state.selectedModel = '';
			report(error, byId('model-error'), 'Could not load the model list.');
		} finally {
			button.disabled = false;
			render();
		}
	})();

	try {
		await modelsLoading;
	} finally {
		modelsLoading = undefined;
	}
}

async function removeProvider(): Promise<void> {
	const bridge = state.bridge;
	const provider = currentProvider();
	if (bridge === undefined || provider === undefined || isBusy()) {
		return;
	}
	clearError(byId('provider-error'));

	try {
		await bridge.removeProvider(provider.id);
		state.selectedProviderId = '';
		state.selectedModel = '';
		state.providerDraft = false;
		state.conversations = [];
		state.selectedConversationId = '';
		state.messages = [];
		await refreshProviders();
	} catch (error) {
		report(error, byId('provider-error'), 'Could not remove the provider.');
	}
}

// ── projects ───────────────────────────────────────────────────────────────

/** Loads the projects that give the tools a workspace. */
async function refreshProjects(): Promise<void> {
	const bridge = state.bridge;
	if (bridge === undefined) {
		return;
	}
	try {
		state.projects = await bridge.listProjects();
		if (!state.projects.some((project) => project.id === state.selectedProjectId)) {
			state.selectedProjectId = state.projects[0]?.id ?? '';
		}
		clearError(byId('project-error'));
	} catch (error) {
		state.projects = [];
		report(error, byId('project-error'), 'Could not list projects.');
	}
	// Redraw on every path. Forgetting this is what left the picker reading
	// "no project yet" after a successful save — the Core had the project, the
	// list just never repainted, and a conversation was then created with no
	// workspace because nothing was selected.
	render();
}

async function saveProject(event: Event): Promise<void> {
	event.preventDefault();
	const bridge = state.bridge;
	if (bridge === undefined) {
		return;
	}

	const rootPath = byId<HTMLInputElement>('project-root').value.trim();
	const name = byId<HTMLInputElement>('project-name').value.trim();
	if (rootPath.length === 0) {
		showError(byId('project-error'), 'A project needs a folder.');
		return;
	}
	clearError(byId('project-error'));

	try {
		const created = await bridge.createProject({
			rootPath,
			// A blank name falls back to the folder name in the session, so the
			// picker is never full of "New project".
			...(name.length > 0 ? { name } : {}),
		});
		state.selectedProjectId = created.id;
		await refreshProjects();
	} catch (error) {
		report(error, byId('project-error'), 'Could not save the project.');
	}
}

// ── conversations ───────────────────────────────────────────────────────────

async function newConversation(): Promise<void> {
	const bridge = state.bridge;
	if (bridge === undefined) {
		return;
	}
	if (state.coreMode === 'connected') {
		await newServiceConversation(bridge);
		return;
	}
	if (state.selectedProviderId.length === 0) {
		return;
	}
	clearError(byId('conversation-error'));

	try {
		const created = await bridge.createConversation({
			providerId: state.selectedProviderId,
			// Bound to the selected project, so the tools get a workspace to
			// confine themselves to. Absent when none is chosen, and the
			// filesystem tools then refuse rather than running anywhere.
			...(state.selectedProjectId.length > 0 ? { projectId: state.selectedProjectId } : {}),
		});
		await refreshConversations();
		await openConversation(created.summary.id);
	} catch (error) {
		report(error, byId('conversation-error'), 'Could not create the conversation.');
	}
}

/**
 * Cria uma conversa no serviço (R4E).
 *
 * ## O que é dito, e quando
 *
 * O botão fica desabilitado enquanto o pedido está em curso, e **nada** é dito
 * de sucesso antes da resposta. Uma falha de conexão depois do envio não é
 * "não criada": o serviço pode tê-la gravado. Nesse caso a interface diz que
 * não sabe e recarrega a lista — recarregar mostra a verdade, e tentar de novo
 * sozinha criaria duplicata.
 */
async function newServiceConversation(bridge: SeshyinaBridge): Promise<void> {
	if (state.creatingConversation) {
		return;
	}
	if (state.selectedModel.length === 0) {
		showError(
			byId('conversation-error'),
			'Escolha um modelo antes de criar uma conversa: o serviço precisa saber a qual provedor ela pertence.',
		);
		return;
	}
	// R4S: o provedor é o do par escolhido, não um recorte do nome do modelo.
	const choice = selectedAvailable();
	if (choice === undefined) {
		showError(byId('conversation-error'), 'O modelo escolhido não diz a qual provedor pertence.');
		return;
	}
	const providerId = choice.providerId;

	state.creatingConversation = true;
	clearError(byId('conversation-error'));
	render();
	try {
		const created = await bridge.createServiceConversation({ providerId });
		if (!created.ok) {
			// `unknown`: o pedido pode ter sido aplicado. Dito como tal, e a
			// lista é recarregada para mostrar o que o serviço de fato tem.
			showError(
				byId('conversation-error'),
				created.code === 'unknown'
					? created.message
					: `Não foi possível criar a conversa: ${created.message}`,
			);
			if (created.code === 'unknown') {
				await refreshServiceConversations(bridge);
			}
			return;
		}
		// A lista é recarregada **antes** de abrir: a conversa precisa existir
		// na barra lateral, e a contagem vem do que o serviço gravou.
		await refreshServiceConversations(bridge);
		await openServiceConversation(bridge, created.conversation.id);
	} catch (error) {
		showError(
			byId('conversation-error'),
			`A conexão falhou ao criar a conversa: ${error instanceof Error ? error.message : String(error)}. ` +
				'Não é possível saber se ela foi criada; recarregue a lista antes de tentar de novo.',
		);
		await refreshServiceConversations(bridge);
	} finally {
		state.creatingConversation = false;
		render();
	}
}

/** Loads a conversation's transcript into the view. */
/**
 * Abre o diálogo fixo de preferências de modelo.
 *
 * A conversa é procurada pela marca `pinned` — não por um título, que a pessoa
 * pode mudar. Se não houver nenhuma, é criada aqui, com o prompt de sistema que
 * diz à Evelyn o que ela precisa escrever e em que formato, e já nasce marcada.
 * A marcação é idempotente, então reabrir não duplica nada.
 */
/**
 * Acha (ou cria) o diálogo fixo de preferências no modo conectado.
 *
 * O histórico é do serviço, e um diálogo criado só na janela seria um id que o
 * serviço não conhece — daí a mesma conversa ser procurada lá.
 */
async function openServiceGuidanceDialogue(bridge: SeshyinaBridge): Promise<void> {
	if (state.selectedProviderId.length === 0) {
		showError(byId('chat-error'), 'Escolha um modelo antes de abrir o diálogo de preferências.');
		return;
	}
	const found = await bridge.listServiceConversations();
	if (!found.ok) {
		showError(byId('chat-error'), found.message);
		return;
	}
	const existing = found.conversations.find((item) => item.pinned === true);
	if (existing !== undefined) {
		await openServiceConversation(bridge, existing.id);
		return;
	}
	const created = await bridge.createServiceConversation({
		providerId: state.selectedProviderId,
		title: 'Preferências de modelo',
	});
	if (!created.ok) {
		showError(byId('chat-error'), created.message);
		return;
	}
	const pinned = await bridge.pinConversation(created.conversation.id, true);
	if (pinned.pinned !== true) {
		showError(byId('chat-error'), 'o serviço não confirmou a conversa permanente');
		return;
	}
	await refreshServiceConversations(bridge);
	await openServiceConversation(bridge, created.conversation.id);
}

async function openGuidanceDialogue(): Promise<void> {
	const bridge = state.bridge;
	if (bridge === undefined) {
		return;
	}
	if (state.coreMode === 'connected') {
		await openServiceGuidanceDialogue(bridge);
		return;
	}
	if (isBusy()) {
		return;
	}
	const existing = state.conversations.find((entry) => entry.pinned === true);
	if (existing !== undefined) {
		await openConversation(existing.id);
		return;
	}
	if (state.selectedProviderId.length === 0) {
		showError(byId('chat-error'), 'Escolha um provedor antes de abrir o diálogo de preferências.');
		return;
	}
	try {
		const created = await bridge.createConversation({
			providerId: state.selectedProviderId,
			title: 'Preferências de modelo',
			...(state.selectedProjectId.length > 0 ? { projectId: state.selectedProjectId } : {}),
			systemPrompt: MODEL_GUIDANCE_DIALOGUE_PROMPT,
		});
		await bridge.pinConversation(created.summary.id, true);
		await refreshConversations();
		await openConversation(created.summary.id);
	} catch (error) {
		report(error, byId('conversation-error'), 'Could not open the model guidance dialogue.');
	}
}

/**
 * O diálogo fixo, depois que um turno nele terminou.
 *
 * A resposta da Evelyn é interpretada e o resultado é gravado para o motor ler
 * no próximo turno. Chamado em `done` e não a cada delta: só o texto inteiro
 * tem a lista completa, e gravar no meio de uma linha gravaria uma preferência
 * pela metade.
 */
async function absorbGuidanceReply(conversationId: string | undefined): Promise<void> {
	const bridge = state.bridge;
	if (bridge === undefined || conversationId === undefined) {
		return;
	}
	const item = state.conversations.find((entry) => entry.id === conversationId);
	if (item === undefined) {
		// `done` costuma chegar antes do `refreshConversations` disparado no
		// mesmo evento: nesse instante a conversa recém-criada ainda pode não
		// estar na lista, e sem esta recarga a resposta nunca seria absorvida.
		try {
			await refreshConversations();
		} catch {
			// A lista é a fonte; se falhar, as duas checagens abaixo decidem.
		}
	}
	let pinned = (item ?? state.conversations.find((entry) => entry.id === conversationId))?.pinned === true;
	if (pinned === false) {
		// A lista pode ter vindo de antes da marcação. O resumo da conversa
		// responde de fato; uma recusa do Core (id inexistente) não é motivo
		// para gravar.
		try {
			const opened = await bridge.openConversation(conversationId);
			pinned = opened.summary.pinned === true;
		} catch {
			return;
		}
	}
	if (!pinned) {
		return;
	}
	const reply = [...state.messages].reverse().find((message) => message.role === 'assistant');
	if (reply === undefined || reply.content.trim().length === 0) {
		return;
	}
	try {
		const recorded = await bridge.recordModelGuidance(conversationId, reply.content);
		const accepted = recorded?.entries.length ?? 0;
		const rejected = recorded?.rejected.length ?? 0;
		byId('model-agent-note').textContent =
			rejected > 0
				? `${accepted} preferência(s) em vigor; ${rejected} linha(s) não seguiram o formato e ficaram de fora.`
				: accepted > 0
					? `${accepted} preferência(s) em vigor — a Evelyn as usa para escolher o modelo.`
					: 'A resposta não trouxe nenhuma preferência no formato pedido; o motor segue as regras do catálogo.';
		render();
	} catch (error) {
		// Uma preferência que não foi gravada não pode interromper a conversa;
		// ela só não vale no próximo turno.
		report(error, byId('conversation-error'), 'Could not record the model guidance.');
	}
}

async function openConversation(conversationId: string): Promise<void> {
	const bridge = state.bridge;
	if (bridge === undefined) {
		return;
	}
	// R4D: em modo conectado o histórico vem do serviço, que é o dono dos
	// dados. O id é o mesmo que a R4C usa para enviar turnos.
	if (state.coreMode === 'connected') {
		await openServiceConversation(bridge, conversationId);
		return;
	}
	// Declared outside the try so the prompt can be applied after it succeeds;
	// declaring it inside would put it out of reach on the success path.
	let opened: ConversationView | undefined;
	try {
		opened = await bridge.openConversation(conversationId);
		state.selectedConversationId = opened.summary.id;
		rememberConversation(bridge, opened.summary.id);
		// The transcript is rebuilt from the Core's copy, never from what the UI
		// happened to be holding — that is what keeps a reload honest.
		state.messages = opened.messages.map((message) => ({
			role: message.role,
			content: message.content,
		}));
		clearError(byId('chat-error'));
		clearError(byId('conversation-error'));
	} catch (error) {
		report(error, byId('conversation-error'), 'Could not open that conversation.');
		return;
	}
	renderSystemPrompt(opened.systemPrompt);
	// Modo local: o prompt vem do Core deste processo, então o aviso do modo
	// conectado não se aplica.
	clearSystemPromptNotice();
	render();
}

/**
 * Abre uma conversa do serviço (R4D).
 *
 * O `selectedConversationId` é o mesmo campo do modo local — é o que o envio
 * da R4C usa. Assim, abrir pelo serviço e enviar mantêm a mesma identidade por
 * construção, e não por duas variáveis que precisariam concordar.
 *
 * O histórico é o que o serviço publicou: `user`/`assistant`. A instrução de
 * sistema e as mensagens de ferramenta ficam no serviço — o Desktop conectado
 * não as vê, e é isso que este caminho desenha.
 */
/**
 * Diz, na conversa, que um turno foi interrompido (R4H).
 *
 * Distinto de `error`: uma falha comum é do turno (o modelo recusou, o
 * provedor caiu); uma interrupção é do **serviço** — ele foi encerrado antes
 * de a resposta terminar. A mensagem não promete que a resposta será
 * retomada, porque ela não será.
 *
 * Uma consulta que falha não inventa nada: sem os estados, nenhuma nota é
 * desenhada.
 */
async function appendInterruptedNotice(bridge: SeshyinaBridge, conversationId: string): Promise<void> {
	const states = await bridge.listServiceTurnStates(conversationId).catch(() => undefined);
	if (states === undefined || !states.ok) {
		return;
	}
	const interrupted = states.turns.filter((turn) => turn.status === 'interrupted');
	if (interrupted.length === 0) {
		return;
	}
	const at = interrupted[0]?.finishedAt;
	state.messages.push({
		role: 'error',
		content:
			`Uma resposta desta conversa foi interrompida porque o serviço local foi encerrado antes de ` +
			`terminar${at === undefined ? '' : ` (${at.slice(0, 19).replace('T', ' ')}`}${at === undefined ? '' : ')'}. ` +
			'O que já havia sido gravado está acima; o restante não foi gerado e não será retomado.',
	});
}

async function openServiceConversation(bridge: SeshyinaBridge, conversationId: string): Promise<void> {
	clearError(byId('conversation-error'));
	// A seleção é aplicada **durante** o pedido, para a interface já mostrar
	// qual conversa está abrindo; a guarda garante que a resposta de uma
	// abertura antiga não sobrescreva a mais recente.
	state.openGeneration += 1;
	const generation = state.openGeneration;
	try {
		const opened = await bridge.openServiceConversation(conversationId);
		if (generation !== state.openGeneration) {
			// O usuário abriu outra conversa enquanto esta carregava. A
			// resposta atrasada não pode trocar a seleção nem o histórico.
			return;
		}
		if (!opened.ok) {
			// A conversa não existe mais (ou nunca existiu): diz, e não deixa a
			// anterior na tela como se fosse esta.
			state.messages = [];
			render();
			showError(
				byId('conversation-error'),
				opened.code === 'rejected'
					? 'Essa conversa não existe no serviço local.'
					: `Não foi possível abrir a conversa: ${opened.message}`,
			);
			return;
		}
		state.selectedConversationId = opened.conversation.id;
		rememberConversation(bridge, opened.conversation.id);
		state.messages = opened.messages.map((message) => ({
			role: message.role,
			content: message.content,
		}));
		// R4H: um turno que ficou interrompido por queda do serviço é dito na
		// conversa — como nota, e não como resposta concluída. A resposta
		// parcial, se alguma foi gravada, está nas mensagens acima; o que a
		// nota diz é que ela não chegou ao fim.
		await appendInterruptedNotice(bridge, opened.conversation.id);
		clearError(byId('chat-error'));
		// O serviço não publica o prompt de sistema (é instrução privada). O
		// campo fica vazio e **diz** por quê, em vez de parecer que a conversa
		// não tem instrução.
		renderSystemPrompt('');
		showSystemPromptNotice(
			'No modo conectado o prompt de sistema não é exibido: ele fica no serviço, ' +
				'que não o publica ao aplicativo. A conversa continua usando o prompt gravado lá.',
		);
		render();
	} catch (error) {
		if (generation !== state.openGeneration) {
			return;
		}
		state.messages = [];
		render();
		report(error, byId('conversation-error'), 'Não foi possível abrir a conversa do serviço.');
	}
}

/**
 * Diz o que o modo conectado **não** mostra do prompt de sistema (R4E).
 *
 * O campo vazio sozinho não distingue "não há instrução" de "não é publicado".
 */
function showSystemPromptNotice(message: string): void {
	const host = byId('system-prompt-note');
	host.textContent = message;
	setHidden(host, false);
}

/** Some com o aviso do prompt, quando o modo local volta a desenhá-lo. */
function clearSystemPromptNotice(): void {
	const host = byId('system-prompt-note');
	host.textContent = '';
	setHidden(host, true);
}

async function renameConversation(): Promise<void> {
	const bridge = state.bridge;
	const item = currentConversation();
	if (bridge === undefined || item === undefined) {
		return;
	}

	const title = byId<HTMLInputElement>('conversation-title').value.trim();
	if (title.length === 0 || title === item.title) {
		// Nothing to do; leaving the box read-only avoids a pointless write.
		renderConversationHeader();
		return;
	}
	clearError(byId('conversation-error'));

	// R4F: em modo conectado, o título é gravado pelo serviço.
	if (state.coreMode === 'connected') {
		try {
			const renamed = await bridge.renameServiceConversation(item.id, title);
			if (!renamed.ok) {
				showError(
					byId('conversation-error'),
					renamed.code === 'rejected'
						? 'Essa conversa não existe mais no serviço.'
						: `Não foi possível renomear: ${renamed.message}`,
				);
				// A seleção e o histórico ficam: renomear não é abrir de novo.
				renderConversationHeader();
				return;
			}
			// A lista é recarregada **sem** reabrir a conversa: o título novo
			// aparece na barra lateral e o histórico na tela continua o mesmo.
			await refreshServiceConversations(bridge);
			return;
		} catch (error) {
			report(error, byId('conversation-error'), 'Não foi possível renomear a conversa do serviço.');
			renderConversationHeader();
			return;
		}
	}

	try {
		await bridge.renameConversation(item.id, title);
		await refreshConversations();
	} catch (error) {
		report(error, byId('conversation-error'), 'Could not rename the conversation.');
		renderConversationHeader();
	}
}

async function saveSystemPrompt(): Promise<void> {
	const bridge = state.bridge;
	if (bridge === undefined || state.selectedConversationId.length === 0) {
		return;
	}
	clearError(byId('system-error'));

	try {
		const content = byId<HTMLTextAreaElement>('system-prompt').value;
		await bridge.setSystemPrompt(state.selectedConversationId, content);
		// Reopened so the transcript shows exactly what was stored, including
		// the case where an empty box removed the prompt.
		await openConversation(state.selectedConversationId);
		await refreshConversations();
	} catch (error) {
		report(error, byId('system-error'), 'Could not save the system prompt.');
	}
}

async function deleteConversation(conversationId?: string): Promise<void> {
	const bridge = state.bridge;
	if (bridge === undefined) {
		return;
	}
	// A linha da lista pede a exclusão de si mesma; o botão do painel de
	// configurações exclui a conversa aberta. As duas passam pelo mesmo
	// caminho de confirmação.
	const item =
		conversationId === undefined
			? currentConversation()
			: state.conversations.find((entry) => entry.id === conversationId);
	if (item === undefined) {
		return;
	}
	// Uma conversa permanente não tem confirmação a oferecer: o que não pode
	// acontecer não é perguntado.
	if (item.pinned === true) {
		showError(byId('conversation-error'), 'Esta conversa é permanente e não pode ser apagada.');
		return;
	}
	// R4F: confirma **antes** de qualquer escrita, nos dois modos. Uma
	// conversa é histórico; apagá-la sem perguntar não tem desfazer.
	const confirmed = await confirmDelete(item.title);
	if (!confirmed) {
		return;
	}
	clearError(byId('conversation-error'));

	// R4F: em modo conectado a exclusão é do serviço. Diferente do modo local,
	// **não** abre outra conversa em seguida: a seleção some e a tela fica
	// vazia com a lista ao lado, que é o que o usuário pediu.
	if (state.coreMode === 'connected') {
		await deleteServiceConversation(bridge, item);
		return;
	}

	try {
		await bridge.deleteConversation(item.id);
		if (state.selectedConversationId === item.id) {
			state.selectedConversationId = '';
			state.messages = [];
		}
		await refreshConversations();
		// Open whatever is left, so the chat pane is never stranded empty with
		// no selection.
		const next = state.conversations[0];
		if (next !== undefined) {
			await openConversation(next.id);
		} else {
			render();
		}
	} catch (error) {
		report(error, byId('conversation-error'), 'Could not delete the conversation.');
	}
}

/**
 * Pede confirmação para excluir uma conversa (R4F).
 *
 * Um diálogo da própria página, e não `window.confirm`: no Electron o nativo
 * é bloqueado e a chamada volta `false` sem perguntar — a exclusão pareceria
 * cancelada por mágica.
 *
 * O título vai como `textContent`: é texto do usuário e não pode virar
 * markup.
 */
function confirmDelete(title: string): Promise<boolean> {
	return new Promise((resolve) => {
		const dialog = document.createElement('div');
		dialog.className = 'panel';
		dialog.setAttribute('role', 'dialog');
		dialog.setAttribute('aria-label', 'Excluir conversa');

		const text = document.createElement('p');
		text.textContent = `Excluir a conversa "${title}"? O histórico dela será apagado e não pode ser recuperado.`;

		const row = document.createElement('div');
		row.className = 'row end';
		const cancel = document.createElement('button');
		cancel.type = 'button';
		cancel.className = 'secondary';
		cancel.textContent = 'Cancelar';
		const confirm = document.createElement('button');
		confirm.type = 'button';
		confirm.className = 'danger';
		confirm.textContent = 'Excluir';
		row.append(cancel, confirm);
		dialog.append(text, row);

		let settled = false;
		const close = (value: boolean): void => {
			if (settled) {
				return;
			}
			settled = true;
			dialog.remove();
			resolve(value);
		};
		cancel.addEventListener('click', () => close(false));
		confirm.addEventListener('click', () => close(true));

		const host = byId('conversation-error').parentElement ?? document.body;
		host.append(dialog);
		// O foco vai para "Cancelar": o Enter não apaga por engano.
		cancel.focus();
	});
}

/**
 * Exclui uma conversa do serviço (R4F).
 *
 * ## O que acontece com a seleção
 *
 * Se a conversa excluída era a selecionada, a seleção e o histórico são
 * limpos **antes** de a lista ser recarregada. Limpar primeiro é o que impede
 * o desenho seguinte de mostrar a conversa que já não existe — e a geração de
 * abertura avança, para uma abertura atrasada dela não voltar depois.
 *
 * ## Turno em andamento
 *
 * O modo conectado desabilita o botão enquanto um turno roda (a lista desenha
 * `disabled` com `isBusy()`), então a exclusão durante um turno do **próprio**
 * app não acontece pela interface. Se o serviço recusar mesmo assim, o erro é
 * dito e a conversa continua.
 */
async function deleteServiceConversation(
	bridge: SeshyinaBridge,
	item: { readonly id: string; readonly title: string },
): Promise<void> {
	try {
		const deleted = await bridge.deleteServiceConversation(item.id);
		if (!deleted.ok) {
			// R4G: `busy` mesmo com a interface achando que pode — o serviço é
			// a autoridade. Seleção e histórico continuam como estavam.
			showError(
				byId('conversation-error'),
				deleted.code === 'busy'
					? 'Esta conversa não pode ser excluída enquanto a resposta está sendo gerada. ' +
						'Espere o turno terminar (ou pare-o) e tente de novo.'
					: deleted.code === 'rejected'
						? 'Essa conversa já não existe no serviço.'
						: deleted.code === 'unknown'
							? deleted.message
							: `Não foi possível excluir: ${deleted.message}`,
			);
			if (deleted.code === 'unknown') {
				// Pode ter sido excluída: a lista mostra a verdade.
				await refreshServiceConversations(bridge);
			}
			return;
		}
		if (state.selectedConversationId === item.id) {
			// Avança a geração de abertura: uma resposta atrasada dela não pode
			// trazer de volta a conversa que deixou de existir.
			state.openGeneration += 1;
			state.selectedConversationId = '';
			state.messages = [];
			state.remoteTurnId = undefined;
			state.activeTurnId = undefined;
			renderSystemPrompt('');
			clearSystemPromptNotice();
		}
		await refreshServiceConversations(bridge);
		render();
	} catch (error) {
		report(error, byId('conversation-error'), 'Não foi possível excluir a conversa do serviço.');
	}
}

// ── permission prompt ──────────────────────────────────────────────────────

/**
 * Fills the card with an open request and shows it.
 *
 * Everything is written as `textContent`: the arguments and the workspace path
 * are tool output, and they must never be given a chance to become markup.
 *
 * The card lives outside `#messages`, so the full redraw of the transcript
 * never touches it — it is shown here and closed by `hidePermission`, and no
 * `render()` in between can wipe it.
 */
function showPermission(prompt: PermissionPrompt): void {
	state.openPermission = prompt;

	byId('permission-tool').textContent = prompt.toolName;
	byId('permission-risk').textContent = prompt.riskLevel;
	byId('permission-action').textContent = prompt.action;
	byId('permission-detail').textContent = prompt.description;

	const list = byId('permission-args');
	list.textContent = '';
	for (const entry of prompt.arguments) {
		const name = document.createElement('dt');
		name.textContent = entry.name;
		const value = document.createElement('dd');
		value.textContent = entry.value;
		list.append(name, value);
	}

	// A conversation with no project runs in no directory, and saying that is
	// better than leaving a label with nothing after it.
	const workspace = byId('permission-workspace');
	workspace.textContent = prompt.workspace ?? '';
	setHidden(workspace, prompt.workspace === undefined);

	// The border follows the risk, which is what the decision turns on.
	const card = byId('permission');
	card.className = `permission risk-${prompt.riskLevel}`;
	setHidden(card, false);

	// Focus lands on Deny: an alertdialog that puts "Allow once" under the
	// next Enter press is a dialog that approves by accident.
	byId<HTMLButtonElement>('permission-deny').focus();
}

/**
 * Closes the card belonging to a settled request.
 *
 * Idempotent, and only for the request named: a resolution that arrives after
 * another prompt has opened must not take the new one off the screen. Called
 * from two places on purpose — from the resolution, and from the click — so
 * either path alone is enough to close it.
 */
function hidePermission(id: string): void {
	if (state.openPermission !== undefined && state.openPermission.id !== id) {
		return;
	}
	state.openPermission = undefined;
	byId('permission-args').textContent = '';
	byId('permission-workspace').textContent = '';
	setHidden(byId('permission'), true);
}

/**
 * Sends the user's decision for the open request.
 *
 * The card is closed whether main accepted the answer or refused it: a `false`
 * means the request is already settled (a timeout, a stop, a second click) and
 * nothing further will arrive for it, so leaving the card up would be a dialog
 * nobody can answer.
 */
async function answerPermission(decision: 'allow' | 'deny'): Promise<void> {
	const bridge = state.bridge;
	const prompt = state.openPermission;
	if (bridge === undefined || prompt === undefined) {
		return;
	}

	try {
		await bridge.answerPermission({ id: prompt.id, decision });
	} catch (error) {
		// The card stays open: the request is still waiting, and the user can
		// try again rather than losing a decision that never left this page.
		report(error, byId('chat-error'), 'Could not answer the permission request.');
		return;
	}
	hidePermission(prompt.id);
}

// ── chat ────────────────────────────────────────────────────────────────────

async function send(): Promise<void> {
	const bridge = state.bridge;
	const provider = currentProvider();
	const input = byId<HTMLTextAreaElement>('input');
	if (bridge === undefined) {
		return;
	}
	if (state.coreMode === 'connected') {
		// R4C: em modo conectado a mensagem vai ao **serviço**, que executa o
		// turno no motor dele. Os eventos chegam pelo mesmo `onChatEvent` do
		// modo local, então a conversa na tela é a mesma.
		const serviceText = input.value.trim();
		if (serviceText.length === 0) {
			return;
		}
		await sendThroughService(bridge, serviceText, input);
		return;
	}
	// DEV-8.9: no automático, nenhum provedor precisa estar selecionado — quem
	// escolhe é o motor. Nos demais modos, a escolha explícita continua
	// exigida, e a ausência dela é dita.
	const mode = effectiveTurnMode(state.turnMode, state.routerConfig);
	const automatic = mode === 'auto';
	if ((!automatic && provider === undefined) || !canSend()) {
		return;
	}

	const text = input.value.trim();
	if (text.length === 0) {
		return;
	}

	clearError(byId('chat-error'));

	// The history is NOT sent from here. The Core reads the persisted transcript
	// and appends the user's message itself, so the renderer passing its own
	// copy would be a second source of truth for what the model was told — and
	// the two would disagree as soon as a turn stored tool results.
	//
	// What the user typed still goes on screen now, so the send feels immediate
	// while the turn is only being accepted.
	state.messages.push({ role: 'user', content: text });
	input.value = '';
	// Shrunk back too, or the HUD keeps the height of the message just sent.
	autoGrow(input);
	// Stale reasoning from a finished turn would otherwise stay on screen and be
	// read as the thinking behind this new question.
	state.reasoning = '';
	// A fresh send supersedes the failed turn the retry button was for.
	state.lastTurnFailed = false;
	render();

	try {
		const choice =
			selectedAvailable() ??
			(provider !== undefined && state.selectedModel.length > 0
				? { providerId: provider.id, model: state.selectedModel }
				: undefined);
		const routing = turnRoutingPayload(mode, choice);
		// DEV-8.14: mesma regra do caminho conectado — com a config em
		// `external`, o turno executa o externo e precisa de um modelo pedido.
		const executaExterno = effectiveTurnMode(mode, state.routerConfig) === 'external';
		const finalRouting =
			executaExterno && routing.model === undefined
				? { ...routing, model: choice?.model ?? state.selectedModel }
				: routing;
		const enviado = executaExterno ? { ...finalRouting, routing: 'external' as const } : finalRouting;
		const ack = await bridge.sendMessage({
			providerId: enviado.providerId ?? '',
			conversationId: state.selectedConversationId,
			model: enviado.model ?? '',
			messages: [{ role: 'user', content: text }],
			strategy: state.orchestrationStrategy,
			routing: enviado.routing,
			// DEV-9.1 (item 3): a tarefa vale para **este** envio. O motor
			// sobe o teto de rounds e mede o tempo por progresso.
			...(state.taskMode ? { task: true } : {}),
		});
		// Only now is the turn really running: `sendMessage` resolves on accept,
		// not on an answer. Marking it busy earlier would strand the composer if
		// the request was refused.
		state.activeTurnId = ack.turnId;
		render();
	} catch (error) {
		// Nothing will arrive on this turn, so the user's message is left alone
		// and no empty bubble is left looking like an answer.
		state.activeTurnId = undefined;
		report(error, byId('chat-error'), 'Could not send the message.');
		render();
	}
}

async function stop(): Promise<void> {
	const bridge = state.bridge;
	if (bridge === undefined) {
		return;
	}
	// R4E: no modo conectado o turno a cancelar é o do serviço, e só o que
	// **este** app iniciou — o `remoteTurnId` é a chave.
	if (state.coreMode === 'connected') {
		const turnId = state.remoteTurnId;
		if (turnId === undefined) {
			return;
		}
		try {
			const stopped = await bridge.stopServiceTurn(turnId);
			if (!stopped.stopped) {
				showError(byId('chat-error'), 'O turno já não está em curso no serviço.');
			}
		} catch (error) {
			report(error, byId('chat-error'), 'Não foi possível cancelar o turno no serviço.');
		}
		// O turno cancelado pode ter gravado a pergunta: a contagem da lista
		// muda mesmo que a resposta não venha.
		await refreshConversations();
		return;
	}
	try {
		await bridge.stop();
	} catch (error) {
		report(error, byId('chat-error'), 'Could not stop the turn.');
	}
}

/**
 * Re-runs the last failed turn.
 *
 * The user's message is already in the persisted transcript — it survived the
 * failed turn on purpose — so the retry sends `messages: []` and nothing is
 * duplicated. The same provider and model the turn failed on are used again:
 * switching models automatically is the user's call, and the error bubble
 * already names the alternatives.
 */
async function retryTurn(): Promise<void> {
	const bridge = state.bridge;
	if (bridge === undefined || isBusy()) {
		return;
	}
	const mode = effectiveTurnMode(state.turnMode, state.routerConfig);
	// DEV-8.9: no automático não há par escolhido a exigir; nos demais, sim.
	if (mode !== 'auto' && state.selectedProviderId.length === 0) {
		return;
	}
	state.lastTurnFailed = false;
	clearError(byId('chat-error'));
	try {
		const mode = effectiveTurnMode(state.turnMode, state.routerConfig);
		const routing = turnRoutingPayload(mode, selectedAvailable());
		const finalRouting =
			mode === 'external' && routing.model === undefined
				? { ...routing, model: state.selectedModel }
				: routing;
		const ack = await bridge.sendMessage({
			providerId: finalRouting.providerId ?? '',
			conversationId: state.selectedConversationId,
			model: finalRouting.model ?? '',
			messages: [],
			strategy: state.orchestrationStrategy,
			routing: finalRouting.routing,
		});
		state.activeTurnId = ack.turnId;
		render();
	} catch (error) {
		state.lastTurnFailed = true;
		report(error, byId('chat-error'), 'Could not retry the turn.');
		render();
	}
}

/**
 * Folds one stream event into the transcript.
 *
 * Events for another turn are dropped: the user stopped and started again, and
 * the old turn's remaining deltas belong to a message nobody is watching.
 */
function onChatEvent(event: ChatStreamEvent): void {
	// R4C: o turno remoto tem o próprio id. Ele é aceito pelo `remoteTurnId`
	// quando é o do serviço; os eventos de turno local continuam pelo
	// `activeTurnId`. Um evento de outro turno (de outro cliente, ou de um
	// turno já encerrado) é descartado.
	const isRemote = state.remoteTurnId !== undefined && event.turnId === state.remoteTurnId;
	if (!isRemote && state.activeTurnId !== undefined && event.turnId !== state.activeTurnId) {
		return;
	}
	if (isRemote && state.activeTurnId === undefined) {
		// O turno remoto precisa de um "turno ativo" para a interface desenhar
		// o streaming e para o botão de parar: ele é o turno em curso da tela.
		state.activeTurnId = state.remoteTurnId;
	}

	switch (event.type) {
		case 'started':
			// The turn has been accepted; anything left from a previous one is no
			// longer about this turn.
			state.reasoning = '';
			state.lastTurnFailed = false;
			// DEV-8.9: o par efetivo do turno, quando o Core o informa. No modo
			// automático é o que o motor escolheu; num evento antigo o campo
			// não vem, e a linha mantém o que havia.
			if (event.routing !== undefined) {
				state.lastTurnRouting = event.routing;
				render();
			}
			return;
		case 'modelSelected': {
			// Show which model was selected for this turn
			const label = `${event.providerId}:${event.modelId}`;
			const note = event.isFallback
				? `Fallback: agora usando ${label} (${event.reason})`
				: `Modelo selecionado: ${label} (${event.reason})`;
			state.messages.push({ role: 'error', content: note });
			render();
			return;
		}
		case 'fallbackAttempted': {
			const label = `${event.providerId}:${event.modelId}`;
			const note = `Tentativa ${event.attempt}: tentando ${label} após erro: ${event.previousError}`;
			state.messages.push({ role: 'error', content: note });
			render();
			return;
		}
		case 'budgetBlocked': {
			// Não é falha do modelo: é um limite que o usuário definiu. A
			// mensagem já nomeia o limite e o gasto, então ela vai para a
			// transcrição como está — reconstruí-la aqui permitiria que as duas
			// telas discordassem sobre por que a chamada não aconteceu.
			const detail =
				event.message.trim().length > 0
					? event.message
					: `Um limite de orçamento bloqueou ${event.providerId}:${event.modelId}.`;
			state.messages.push({
				role: 'error',
				content: `Orçamento: ${detail}`,
			});
			render();
			return;
		}
		case 'notice': {
			// Uma política aplicada, por exemplo. Não é erro nem resposta: é
			// o que o usuário precisa ler para saber o que passou a valer.
			state.messages.push({ role: 'error', content: event.message });
			render();
			return;
		}
		case 'reasoning':
			// Accumulated separately from the transcript and never pushed as a
			// message: it is the model's scratchpad, not an answer, and the next
			// turn replays the transcript back to the model.
			state.reasoning += event.text;
			render();
			return;
		case 'permissionRequested':
			showPermission(event.prompt);
			return;
		case 'permissionResolved':
			// Closed here too, so a decision settles the card whether the button
			// was pressed here or the turn was stopped from the header. The card
			// is hidden on both paths and only the transcript records what
			// happened — a card that lingered after its resolution would read as a
			// request still waiting.
			hidePermission(event.id);
			if (event.decision === 'allow') {
				// Uma permissão que ninguém concedeu precisa dizer **por quê**:
				// sem isso, ver `dev_read` passar sozinho parece uma falha de
				// segurança. A fonte distingue a concessão da tarefa da leitura
				// automática.
				const why =
					event.source === 'automatic'
						? ' (leitura — não precisou de autorização)'
						: event.source === 'grant' && event.scope !== undefined
							? ` (já autorizado nesta tarefa: ${event.scope})`
							: '';
				state.messages.push({
					role: 'tool',
					content: `you allowed ${event.toolName}${why}`,
				});
			} else {
				state.messages.push({
					role: 'tool',
					content:
						event.source === 'cancelled'
							? `${event.toolName} was cancelled before it ran`
							: `you denied ${event.toolName}`,
				});
			}
			render();
			return;
		case 'delta': {
			// The assistant bubble is created here rather than before the turn,
			// because a turn that calls a tool produces tool bubbles first, and a
			// pre-created placeholder would sit above them looking like the model
			// had spoken before it had.
			const last = state.messages[state.messages.length - 1];
			if (last !== undefined && last.role === 'assistant') {
				last.content += event.text;
			} else {
				state.messages.push({ role: 'assistant', content: event.text });
			}
			render();
			return;
		}
		case 'toolCall':
			// Shown as its own bubble rather than a note in the header: the user
			// asked a question and the model went off to read a file, and that
			// step is part of the answer they are waiting for.
			state.messages.push({
				role: 'tool',
				toolName: event.call.name,
				toolCallId: event.call.id,
				content: event.call.malformed
					? `could not parse the arguments: ${event.call.rawArguments}`
					: `calling ${event.call.name}(${event.call.rawArguments})`,
			});
			render();
			return;

		case 'toolRetry': {
			// A ferramenta falhou de um jeito passageiro e vai de novo. O
			// balão da chamada **não** vira erro: o desfecho ainda não existe.
			// Ele passa a dizer "aguardando", que é a diferença que a pessoa
			// precisa ver — sem isso, a espera parece travamento ou falha.
			const pending = state.messages.findLast(
				(message) => message.role === 'tool' && message.toolCallId === event.callId,
			);
			const note = `retrying ${event.name} (${event.attempt}/${event.of}): ${event.reason}`;
			if (pending !== undefined) {
				pending.content = `${note}\n${pending.content}`;
			} else {
				state.messages.push({ role: 'tool', content: note, toolCallId: event.callId });
			}
			render();
			return;
		}

		case 'toolResult': {
			// The "calling" bubble is replaced by the result rather than joined
			// by one, so a long tool output cannot leave a stale pending line
			// above the answer. Matched by call id: two calls of the same tool
			// in one round would otherwise both find the newest bubble by name
			// and leave the other reading "calling…" forever.
			const pending = state.messages.findLast(
				(message) => message.role === 'tool' && message.toolCallId === event.callId,
			);
			if (pending !== undefined) {
				pending.role = event.ok ? 'tool' : 'toolError';
				pending.content = event.output.length > 0 ? event.output : '(no output)';
			} else {
				// A result with no matching call: the call bubble was never seen,
				// which should not happen, but dropping the result would hide
				// what the tool actually did.
				state.messages.push({
					role: event.ok ? 'tool' : 'toolError',
					toolName: event.name,
					content: event.output.length > 0 ? event.output : '(no output)',
				});
			}
			render();
			return;
		}

		case 'done': {
			const last = state.messages[state.messages.length - 1];
			if (last === undefined && event.content.length > 0) {
				// Nothing accumulated on screen — deltas never arrived — so the
				// turn's own copy is the only one there is.
				state.messages.push({ role: 'assistant', content: event.content });
			}
			// When a bubble already exists it is left alone: `event.content`
			// spans *every* round of the turn, and overwriting the last bubble
			// with it reprinted the earlier rounds' text inside the final one.
			state.activeTurnId = undefined;
			// R4C: o turno remoto acabou; eventos tardios dele não valem mais.
			state.remoteTurnId = undefined;
			// DEV-4: não há mais geração em curso; a próxima abertura não deve
			// avisar que houve interrupção.
			void state.bridge?.setUiSession({ generating: false }).catch(() => undefined);
			state.reasoning = '';
			render();
			// An aborted turn is a normal outcome, so it is reported as a note
			// rather than as an error the user has to dismiss.
			if (event.reason === 'aborted') {
				showError(byId('chat-error'), 'Stopped.');
			}
			// The list carries a message count, and a turn just changed it.
			void refreshConversations();
			// No diálogo fixo, a resposta é o registro de preferências que o
			// motor consulta: ela é absorvida quando o turno inteiro chegou.
			void absorbGuidanceReply(state.selectedConversationId);
			// O turno acabou: o painel do roteador tem que refletir a
			// requisição que acabou de acontecer — o resultado, o modelo que
			// respondeu e o consumo. Sem isto, a linha continuaria mostrando a
			// decisão anterior como se fosse a última.
			void refreshBudget();
			return;
		}
		case 'error': {
			const last = state.messages[state.messages.length - 1];
			if (last !== undefined && last.role === 'assistant' && last.content.length === 0) {
				// Nothing was said, so there is no empty bubble to keep.
				state.messages.pop();
			}
			// Suggest the next eligible model of the same provider — a suggestion
			// only, never an automatic switch. The list is real server data.
			let errorContent = event.message.length > 0 ? event.message : 'The turn failed.';
			const next = pickNextModel({
				available: state.availableModels,
				providerId: state.selectedProviderId,
				current: state.selectedModel,
			});
			if (state.selectedModel.length > 0 && next !== undefined) {
				errorContent += ` Alternativa elegível do mesmo provedor: "${next.model}".`;
			}
			state.messages.push({
				role: 'error',
				content: errorContent,
			});
			state.activeTurnId = undefined;
			state.reasoning = '';
			state.lastTurnFailed = true;
			// R4C/R4E: o turno remoto terminou em erro. A identidade dele não
			// serve mais para cancelar nem para aceitar mais um evento.
			state.remoteTurnId = undefined;
			void state.bridge?.setUiSession({ generating: false }).catch(() => undefined);
			// A turn can die with its permission dialog open. The card would
			// outlive the turn and read as a request still waiting for an
			// answer that can no longer arrive.
			if (state.openPermission !== undefined) {
				hidePermission(state.openPermission.id);
			}
			render();
			// The turn changed the transcript even though it failed, so the
			// list's message count is stale — same as on `done`.
			void refreshConversations();
			return;
		}
	}
}

// ── wiring ──────────────────────────────────────────────────────────────────

function bindEvents(bridge: SeshyinaBridge): void {
	byId('provider-form').addEventListener('submit', (event) => void saveProvider(event));
	byId<HTMLButtonElement>('provider-models').addEventListener('click', () => void loadModels());
	byId<HTMLButtonElement>('model-refresh').addEventListener('click', () => void loadModels());

	// Starts describing a new provider.
	//
	// Unfolds the panel, blanks the form and focuses the base URL. The blanking
	// is the whole point: the form is refilled from the selected provider on
	// every render, so without the draft flag it reopened showing the existing
	// provider's URL and name and there was nothing to overwrite.
	byId<HTMLButtonElement>('provider-add').addEventListener('click', () => {
		state.providerDraft = true;
		const panel = byId<HTMLDetailsElement>('provider-panel');
		panel.open = true;
		render();
		byId<HTMLInputElement>('provider-base-url').focus();
	});

	// Abandons the draft and goes back to the selected provider's own form.
	byId<HTMLButtonElement>('provider-cancel').addEventListener('click', () => {
		state.providerDraft = false;
		render();
	});
	byId<HTMLButtonElement>('provider-remove').addEventListener('click', () => void removeProvider());

	byId('project-form').addEventListener('submit', (event) => void saveProject(event));

	byId('catalog-form').addEventListener('submit', (event) => void saveCatalogEntry(event));
byId<HTMLSelectElement>('access-policy-mode').addEventListener('change', (event) => {
	void saveAccessPolicyChange({ policy: (event.currentTarget as HTMLSelectElement).value as 'any' | 'free_only' | 'free_preferred' });
});
byId<HTMLSelectElement>('access-policy-price').addEventListener('change', (event) => {
	void saveAccessPolicyChange({ priceSource: (event.currentTarget as HTMLSelectElement).value as 'user' | 'discovered' });
});
byId<HTMLSelectElement>('access-policy-limits').addEventListener('change', (event) => {
	void saveAccessPolicyChange({ limitsSource: (event.currentTarget as HTMLSelectElement).value as 'user' | 'discovered' });
});
byId<HTMLSelectElement>('access-policy-capabilities').addEventListener('change', (event) => {
	void saveAccessPolicyChange({ capabilitiesSource: (event.currentTarget as HTMLSelectElement).value as 'user' | 'discovered' });
});
	byId<HTMLButtonElement>('catalog-clear').addEventListener('click', () => void clearCatalogEntry());
	byId<HTMLSelectElement>('catalog-select').addEventListener('change', (event) => {
		const value = (event.target as HTMLSelectElement).value;
		// The selection is a marker, not data: the record it points at is read
		// back out of `state.modelCatalog` on every render, so the form is never
		// filled from a value that was itself typed somewhere else.
		state.catalogSelection = value;
		state.catalogDraft = value === CATALOG_NEW;
		clearError(byId('catalog-error'));
		render();
	});

	byId('budget-form').addEventListener('submit', (event) => void saveSpendingLimit(event));
	byId<HTMLSelectElement>('budget-window').addEventListener('change', (event) => {
		state.budgetWindow = (event.target as HTMLSelectElement).value === 'day' ? 'day' : 'month';
		void refreshBudget();
	});
	// Delegated: the limits are re-rendered on every read, so per-button
	// listeners would have to be reattached each time and would leak the old
	// ones. The id travels in `data-limit`.
	byId('budget-limits').addEventListener('click', (event) => {
		const target = event.target as HTMLElement | null;
		const limitId = target?.dataset?.limit;
		if (target?.tagName === 'BUTTON' && typeof limitId === 'string' && limitId.length > 0) {
			void removeSpendingLimit(limitId);
		}
	});
	byId<HTMLSelectElement>('project-select').addEventListener('change', (event) => {
		// Only affects conversations created from now on: an existing
		// conversation's workspace is fixed, because changing it mid-conversation
		// would silently move what the tools may touch under a transcript that
		// already recorded results from the old directory.
		state.selectedProjectId = (event.target as HTMLSelectElement).value;
		render();
	});

	byId<HTMLButtonElement>('conversation-new').addEventListener('click', () => void newConversation());
	byId<HTMLButtonElement>('conversation-rename').addEventListener('click', () => void renameConversation());
	byId<HTMLButtonElement>('conversation-delete').addEventListener('click', () => void deleteConversation());	byId<HTMLButtonElement>('system-save').addEventListener('click', () => void saveSystemPrompt());
	byId<HTMLButtonElement>('system-clear').addEventListener('click', () => {
		byId<HTMLTextAreaElement>('system-prompt').value = '';
		void saveSystemPrompt();
	});

	// One delegated listener for the list: the buttons are rebuilt on every
	// render, so binding each one would have to be redone every time. A linha
	// tem duas ações e o listener distingue pelo atributo: a lixeira apaga, o
	// resto abre.
	byId('conversation-list').addEventListener('click', (event) => {
		const element = event.target as HTMLElement | null;
		if (isBusy()) {
			return;
		}
		const removeId = element?.closest<HTMLElement>('[data-delete-conversation-id]')?.dataset
			.deleteConversationId;
		if (removeId !== undefined) {
			void deleteConversation(removeId);
			return;
		}
		const openId = element?.closest<HTMLElement>('[data-conversation-id]')?.dataset.conversationId;
		if (openId !== undefined) {
			void openConversation(openId);
		}
	});

	byId<HTMLButtonElement>('model-agent-open').addEventListener('click', () => void openGuidanceDialogue());

	byId<HTMLButtonElement>('send').addEventListener('click', () => void send());
	// DEV-9.1 (item 3): liga/desliga o modo tarefa. Estado da janela; o valor
	// viaja no próximo `send` e não sobrevive ao fechamento do app.
	byId<HTMLButtonElement>('task-toggle').addEventListener('click', () => {
		if (isBusy()) {
			return;
		}
		state.taskMode = !state.taskMode;
		renderTaskToggle();
	});
	byId<HTMLButtonElement>('stop').addEventListener('click', () => void stop());
	byId<HTMLButtonElement>('retry').addEventListener('click', () => void retryTurn());

	// The answers. Bound once, here: the card is never rebuilt — only
	// filled by `showPermission` and cleared by `hidePermission` — so these
	// listeners survive every render.
	byId<HTMLButtonElement>('permission-allow').addEventListener('click', () =>
		void answerPermission('allow'),
	);
	byId<HTMLButtonElement>('permission-deny').addEventListener('click', () =>
		void answerPermission('deny'),
	);

	// Closing or cancelling is a refusal, never a dismissal. Both paths send
	// `deny` through `answerPermission` — the same route as the Deny button —
	// so a dialog the user swept away still releases the tool: silence must
	// not read as consent, and a prompt left hanging would block the turn on
	// an answer nobody can see anymore. Guarded on `openPermission` so Escape
	// while the card is closed leaves the rest of the page (a focused input,
	// a select) alone.
	byId<HTMLButtonElement>('permission-close').addEventListener('click', () =>
		void answerPermission('deny'),
	);
	document.addEventListener('keydown', (event) => {
		if (event.key === 'Escape' && state.openPermission !== undefined) {
			event.preventDefault();
			void answerPermission('deny');
		}
	});

	byId<HTMLSelectElement>('provider-select').addEventListener('change', (event) => {
		// Belt for the disabled select: a switch mid-turn would zero the state
		// the running turn's events are being folded into.
		if (isBusy()) {
			return;
		}
		state.selectedProviderId = (event.target as HTMLSelectElement).value;
		// Switching provider abandons a draft: the form was describing a new one,
		// and it now describes whichever was picked.
		state.providerDraft = false;
		// The conversation stays open, for the same reason the model picker does
		// not clear it: a conversation is a transcript and the provider is a
		// per-turn choice. Only the model selection is dropped, because it named
		// a provider that is no longer the selected one.
		state.selectedModel = '';
		clearError(byId('provider-error'));
		render();
		void loadModels();
	});

	byId<HTMLSelectElement>('model-select').addEventListener('change', (event) => {
		if (isBusy()) {
			return;
		}
		// The option value is an index into `availableModels`, so the provider
		// comes back with the choice rather than having to be matched afterwards.
		const index = Number.parseInt((event.target as HTMLSelectElement).value, 10);
		const entry = Number.isNaN(index) ? undefined : state.availableModels[index];
		if (entry === undefined) {
			return;
		}
		state.selectedModel = entry.model;

		// The provider follows the model, because `sendMessage` names the
		// provider per turn and the selected one has to be the one that serves
		// the selected model.
		state.selectedProviderId = entry.providerId;

		// Nothing else changes. The conversation stays open and the transcript
		// stays on screen: it used to be cleared and reopened here, on the
		// grounds that a conversation belongs to one provider, and that read as
		// the app discarding the conversation whenever the model changed. A
		// conversation is a transcript and the provider is a per-turn choice, so
		// carrying on with a different provider's model is the normal case.
		render();
	});

	byId<HTMLSelectElement>('turn-mode-select').addEventListener('change', (event) => {
		if (isBusy()) {
			render(); // Reverte o desenho: um turno em curso não troca de modo.
			return;
		}
		const value = (event.target as HTMLSelectElement).value;
		if (value !== 'auto' && value !== 'direct' && value !== 'external') {
			render();
			return;
		}
		state.turnMode = value;
		// A escolha é do chat, não da configuração global: só esta janela a
		// guarda, e `router-config.json` não é tocado.
		writeStoredTurnMode(window.localStorage, value);
		render();
	});

	byId<HTMLButtonElement>('turn-mode-configure').addEventListener('click', () => {
		const bridge = state.bridge;
		if (bridge !== undefined) {
			void bridge.openSettings();
		}
	});

	byId<HTMLSelectElement>('strategy-select').addEventListener('change', (event) => {
		if (isBusy()) {
			render(); // Revert the visual change
			return;
		}
		const value = (event.target as HTMLSelectElement).value;
		if (value === 'manual' || value === 'fallback') {
			state.orchestrationStrategy = value;
		}
	});

	const title = byId<HTMLInputElement>('conversation-title');
	title.addEventListener('keydown', (event) => {
		if (event.key === 'Enter') {
			event.preventDefault();
			title.blur();
			void renameConversation();
		}
	});
	// Clicking away is the other way a rename is committed.
	title.addEventListener('blur', () => void renameConversation());

	const input = byId<HTMLTextAreaElement>('input');
	input.addEventListener('keydown', (event) => {
		const keyboard = event as KeyboardEvent;
		// Enter sends; Shift+Enter is a newline. Anything else is left alone so
		// shortcuts and IME composition keep working.
		if (keyboard.key === 'Enter' && !keyboard.shiftKey && !keyboard.isComposing) {
			keyboard.preventDefault();
			void send();
		}
	});
	// Grows with what is typed, up to the `max-height` in the stylesheet. Without
	// this the box is one row tall and a long message scrolls inside itself.
	input.addEventListener('input', () => autoGrow(input));

	// Esc closes the drawer. The permission dialog has its own Esc handling, and
	// it is inside the transcript rather than the drawer, so the two do not
	// collide — but the drawer check keeps Esc from closing both at once.
	document.addEventListener('keydown', (event) => {
		if (event.key === 'Escape' && !byId<HTMLElement>('settings').hidden) {
			event.preventDefault();
			closeSettings();
		}
	});

	bindEdgeHandle();
	bindWindowControls(bridge);
	bindDrawerClose(bridge);
	bindResizeHandles(bridge);
	bindSettingsMenu(bridge);
	bindRouterControls();

	bridge.onChatEvent(onChatEvent);
}

/**
 * Wires the title bar's three buttons.
 *
 * These exist because `frame: false` removed the OS ones. The drag itself needs
 * no code — `-webkit-app-region: drag` on the title bar does it — but the
 * buttons cannot be, since a drag region swallows clicks in everything nested
 * inside it, which is why each carries `no-drag` in the stylesheet.
 *
 * The title bar here belongs to whichever window loaded this page, so the three
 * buttons always act on that window. Only the drawer's own × is different, and
 * that is handled in `bindDrawerClose`.
 */
function bindWindowControls(bridge: SeshyinaBridge): void {
	byId<HTMLButtonElement>('window-minimize').addEventListener('click', () => {
		void bridge.minimizeWindow();
	});

	byId<HTMLButtonElement>('window-maximize').addEventListener('click', () => {
		void bridge.toggleMaximizeWindow();
	});

	byId<HTMLButtonElement>('window-close').addEventListener('click', () => {
		void bridge.closeWindow();
	});

	// The glyph follows the window, not the click: a restore triggered by the OS
	// rather than by the button has to update it too, and only main knows.
	bridge.onWindowState((state) => {
		document.body.dataset.maximized = String(state.maximized);
		const button = byId<HTMLButtonElement>('window-maximize');
		button.setAttribute('aria-label', state.maximized ? 'Restore' : 'Maximise');
	});

	// The router configuration is shared by two windows, and either of them can
	// write it. The notice carries the state that was recorded, so both windows
	// show the same truth — and the switch in the main window stops acting on
	// a copy that is already old.
	bridge.onRouterState((config) => {
		state.routerConfig = config;
		renderRouterPanel();
		renderRouterSettings();
	});
	// O estado do serviço chega por evento porque muda fora desta janela: no
	// arranque (auto-start), por outra janela, ou quando o processo morre. Sem
	// ele, a tela ficava em "desligado" com o serviço no ar — medido no pacote.
	bridge.onServiceState((serviceState) => {
		state.serviceControl = serviceState;
		renderServiceControl();
	});
}

/**
 * Wires the drawer's own ×, which means different things in the two windows.
 *
 * In the chat window it closes the drawer. In the settings window the drawer
 * *is* the window, so closing it would hide every panel and leave a window with
 * nothing in it but a title bar — it has to close the window instead.
 */
function bindDrawerClose(bridge: SeshyinaBridge): void {
	byId<HTMLButtonElement>('settings-close').addEventListener('click', () => {
		if (document.body.dataset.window === 'settings') {
			void bridge.closeWindow();
			return;
		}
		closeSettings();
	});
}

/**
 * Which window this is, from the URL main loaded it with.
 *
 * Read here and written to `<body>` because the stylesheet is what acts on it:
 * one document, two layouts, and the panels that differ are hidden by CSS
 * rather than by a second copy of the markup the renderer would then have to
 * look ids up in twice.
 *
 * Defaults to `chat` when the parameter is absent, so opening the page outside
 * the desktop app still renders something usable rather than an empty document.
 */
function windowRole(): 'chat' | 'settings' {
	return new URLSearchParams(window.location.search).get('window') === 'settings'
		? 'settings'
		: 'chat';
}

/** Wires the menu button that opens the settings window. */
function bindSettingsMenu(bridge: SeshyinaBridge): void {
	byId<HTMLButtonElement>('open-settings').addEventListener('click', () => {
		// False here would mean a new window was created, which is the normal
		// path; only a throw would be a problem, and the bridge rewraps that.
		void bridge.openSettings();
	});
	// O botão do painel leva à **seção** do roteador, e não a outra janela:
	// o usuário está na janela principal e quer o ajuste, não uma navegação.
	byId<HTMLButtonElement>('router-configure').addEventListener('click', () => {
		void bridge.openSettings();
	});
	// R4R: o painel completo no navegador. Só existe quando o serviço está no
	// ar — é ele que serve o painel, e é o registro dele que dá porta e
	// credencial. Sem serviço, o botão diz isso em vez de abrir uma página de
	// erro (o próprio app já é o painel no modo local).
	byId<HTMLButtonElement>('router-open-panel').addEventListener('click', () => {
		void openServicePanel(bridge);
	});
	// O controle manual do serviço: ligar espera o health, desligar usa o
	// encerramento seguro. Os dois atualizam o estado antes de terminar.
	byId<HTMLButtonElement>('service-start').addEventListener('click', () => void toggleService(true));
	byId<HTMLButtonElement>('service-stop').addEventListener('click', () => void toggleService(false));
}

/**
 * O controle manual do serviço local.
 *
 * O estado vem do processo principal, que é quem sabe se o serviço responde —
 * a tela não adivinha por `service.json`, porque um arquivo com pid vivo e sem
 * health não é um serviço utilizável.
 *
 * Durante a operação o estado é o da **operação** (`starting`/`stopping`): o
 * botão desabilita e o texto diz que está acontecendo, em vez de mostrar
 * "ativo" antes de o health responder ou "desligado" antes da saída.
 */
function renderServiceControl(): void {
	const control: ServiceControlState | undefined = state.serviceControl;
	const label = byId('service-state');
	const detail = byId('service-detail');
	const start = byId<HTMLButtonElement>('service-start');
	const stop = byId<HTMLButtonElement>('service-stop');
	if (control === undefined) {
		label.textContent = '…';
		label.removeAttribute('data-state');
		detail.textContent = '';
		start.disabled = true;
		stop.disabled = true;
		return;
	}

	const busy = control.state === 'starting' || control.state === 'stopping';
	label.setAttribute('data-state', control.state);
	start.disabled = busy || control.state === 'active';
	stop.disabled = busy || control.state !== 'active';
	// Uma troca de estado bem-sucedida não pode conviver com o erro de uma
	// tentativa anterior. A falha é desenhada aqui mesmo, no ramo de erro, para
	// não depender da ordem entre este desenho e quem gravou a mensagem.
	if (control.state === 'active') {
		clearError(byId('router-error'));
	}

	switch (control.state) {
		case 'active':
			label.textContent = 'ativo';
			detail.textContent = `processo ${control.pid} em 127.0.0.1:${control.port}${
				control.version !== undefined ? ` · versão ${control.version}` : ''
			}`;
			return;
		case 'starting':
			label.textContent = 'iniciando…';
			detail.textContent = 'aguardando o serviço responder ao health check';
			return;
		case 'stopping':
			label.textContent = 'desligando…';
			detail.textContent = 'pedindo o encerramento seguro e aguardando a saída';
			return;
		case 'error':
			label.textContent = 'erro';
			detail.textContent = control.message;
			// O motivo completo também no bloco de erro, que é o lugar onde ele
			// fica visível sem precisar ler o texto de apoio.
			showError(byId('router-error'), control.message);
			return;
		case 'inactive':
			label.textContent = 'desligado';
			detail.textContent =
				'O painel no navegador precisa do serviço. Clique em "Ativar serviço" — ou feche e abra a Evelyn, que o inicia sozinha.';
			return;
	}
}

/** Lê o estado do serviço sem agir nele. */
async function refreshServiceControl(): Promise<void> {
	const bridge = state.bridge;
	if (bridge === undefined) {
		return;
	}
	try {
		state.serviceControl = await bridge.readServiceControl();
	} catch {
		// Uma leitura que falhou não apaga o que está escrito na tela.
		return;
	}
	render();
}

/** Liga ou desliga o serviço, mostrando o estado da operação enquanto ela dura. */
async function toggleService(on: boolean): Promise<void> {
	const bridge = state.bridge;
	if (bridge === undefined) {
		return;
	}
	state.serviceControl = { state: on ? 'starting' : 'stopping' };
	render();
	try {
		const reply = await bridge.setServiceRunning(on);
		state.serviceControl = reply.state;
		if (!reply.ok) {
			showError(byId('router-error'), reply.message);
		} else {
			clearError(byId('router-error'));
		}
	} catch (error) {
		state.serviceControl = {
			state: 'error',
			message: error instanceof Error ? error.message : String(error),
		};
	}
	// Relê de quem de fato sabe: o processo que respondeu pode ter mudado por
	// outra via (o serviço caiu sozinho, outra janela desligou), e o estado
	// mostrado tem de ser o do serviço — não o que este controle achou que faria.
	await refreshServiceControlQuietly();
	render();
	if (state.serviceControl?.state === 'error') {
		showError(byId('router-error'), state.serviceControl.message);
	}
}

/**
 * Relê o estado do serviço **sem** redesenhar.
 *
 * Usado por `toggleService`, que redesenha uma vez depois; um `render()` a mais
 * no meio de uma operação curta faria a tela piscar o estado antigo.
 */
async function refreshServiceControlQuietly(): Promise<void> {
	const bridge = state.bridge;
	if (bridge === undefined) {
		return;
	}
	try {
		const fresh = await bridge.readServiceControl();
		// O motivo de uma falha é a informação mais útil da tela: se o processo
		// agora responde `inactive` porque o serviço morreu, o erro continua
		// visível em vez de ser trocado por "desligado" sem explicação.
		state.serviceControl =
			fresh.state === 'inactive' && state.serviceControl?.state === 'error'
				? state.serviceControl
				: fresh;
	} catch {
		// Mantém o que está na tela.
	}
}

/**
 * O clique em "Abrir no navegador", com o serviço desligado.
 *
 * A recusa diz o que fazer — ativar o serviço ali mesmo — em vez de mandar o
 * usuário procurar a causa.
 */
async function openServicePanel(bridge: SeshyinaBridge): Promise<void> {
	const button = byId<HTMLButtonElement>('router-open-panel');
	button.disabled = true;
	try {
		const reply = await bridge.openServicePanel();
		if (!reply.ok) {
			report(
				new Error(reply.message),
				byId('router-error'),
				reply.code === 'inactive'
					? 'O serviço local está desligado. Ative-o acima em "Ativar serviço" — ou feche e abra a Evelyn, que o inicia sozinho.'
					: 'Não foi possível abrir o painel no navegador.',
			);
		}
	} catch (error) {
		report(error, byId('router-error'), 'Não foi possível abrir o painel no navegador.');
	} finally {
		button.disabled = false;
	}
}

/**
 * Wires the router controls.
 *
 * Cada controle grava a mudança e **recarrega o estado real** antes de
 * desenhar: o painel mostra o que o Core devolveu, nunca o que o botão
 * pressupôs. Um controle que parece funcionar e não muda o estado real é
 * pior do que um controle que não existe.
 */
function bindRouterControls(): void {
	byId<HTMLButtonElement>('router-switch').addEventListener('click', () => {
		if (!routerEditingEnabled(state.routerConfig)) {
			return;
		}
		void toggleRouter();
	});
	byId<HTMLButtonElement>('router-save').addEventListener('click', () => {
		if (!routerEditingEnabled(state.routerConfig)) {
			report(
				new Error(
					state.routerConfig?.reason ??
						'a configuração do roteador não pode ser gravada agora',
				),
				byId('router-error'),
				'Nada foi salvo.',
			);
			return;
		}
		void saveRouterSettings();
	});
	byId<HTMLButtonElement>('router-reload').addEventListener('click', () => {
		void reloadRouterSettings();
	});
	// Escolher o modo muda o formulário, não o Core: o destino que aparece é
	// o do modo escolhido, e nada é gravado antes do Salvar.
	for (const card of document.querySelectorAll<HTMLInputElement>('input[name="router-mode"]')) {
		card.addEventListener('change', () => {
			clearError(byId('router-error'));
			routerFormDirty = true;
			applyRouterModeToForm(selectedRouterMode());
			const config = state.routerConfig;
			if (config !== undefined) {
				byId('router-current').textContent = routerSummary(config);
			}
		});
	}
	// O destino e o interruptor também são escolhas pendentes.
	for (const select of [
		byId<HTMLSelectElement>('router-external-select'),
		byId<HTMLSelectElement>('router-direct-select'),
	]) {
		select.addEventListener('change', () => {
			routerFormDirty = true;
			const config = state.routerConfig;
			if (config !== undefined) {
				byId('router-current').textContent = routerSummary(config);
			}
		});
	}
	byId<HTMLInputElement>('router-enabled').addEventListener('change', () => {
		routerFormDirty = true;
		const config = state.routerConfig;
		if (config !== undefined) {
			byId('router-current').textContent = routerSummary(config);
		}
	});
}

/**
 * Wires the eight resize strips to main's geometry.
 *
 * The pointer is captured on `mousedown` so the drag keeps tracking after it
 * leaves the strip — a 6px target would otherwise end the drag the moment the
 * pointer moved, which is one pixel after it started. Every move is then
 * forwarded to main, which owns the bounds and applies them against a snapshot
 * taken once at the start.
 *
 * `mousemove` on the document rather than on the handle, for the same reason.
 * The `mouseup` is registered once, globally, so a release anywhere ends the
 * drag: a drag ended by the pointer leaving the window, or by the button never
 * arriving, would otherwise leave main resizing on every later move.
 */
function bindResizeHandles(bridge: SeshyinaBridge): void {
	let dragging: ResizeDirection | undefined;

	for (const handle of document.querySelectorAll<HTMLElement>('.resize-handle')) {
		handle.addEventListener('mousedown', (event) => {
			const direction = handle.dataset['dir'] as ResizeDirection | undefined;
			if (direction === undefined || event.button !== 0) {
				return;
			}
			event.preventDefault();
			dragging = direction;
			void bridge.startWindowResize(direction);
		});
	}

	document.addEventListener('mousemove', (event) => {
		if (dragging === undefined) {
			return;
		}
		// Screen coordinates, not page ones: main's window is positioned on the
		// desktop, so it has to be told where the pointer is in that space.
		void bridge.moveWindowResize(event.screenX, event.screenY);
	});

	document.addEventListener('mouseup', () => {
		if (dragging === undefined) {
			return;
		}
		dragging = undefined;
		void bridge.endWindowResize();
	});
}

/**
 * True when the drawer was opened deliberately and should stay open.
 *
 * A peeked drawer closes itself when the pointer leaves; a pinned one waits to
 * be closed. Without this distinction, moving the pointer away from a menu the
 * user opened by accident would leave it covering the conversation they moved
 * to read, and clicking one open deliberately would have it vanish under the
 * same gesture.
 */
let isSettingsPinned = false;

/** Pending close of a peeked drawer, cancelled if the pointer gets there first. */
let peekCloseTimer: number | undefined;

/**
 * The model list load in flight, if any.
 *
 * Kept out of `state` because it is not something a render reads: it exists so
 * `loadModels` can make a second caller wait rather than start a second round of
 * per-provider HTTP requests.
 */
let modelsLoading: Promise<void> | undefined;

/**
 * Wires the left edge to the drawer.
 *
 * Two ways in. Hovering the edge peeks the drawer; clicking or activating it
 * with the keyboard pins it. Hover alone would be unreachable by keyboard and
 * inert on touch, which is why the handle is a real `<button>` and hover is an
 * addition over that rather than the mechanism.
 *
 * Enter and Space on a button fire `click`, so one handler covers pointer and
 * keyboard together — and there is deliberately no `focus` handler: focusing the
 * handle fires before the click, so opening on focus would flip the drawer
 * twice and leave it shut on a single activation.
 */
function bindEdgeHandle(): void {
	const handle = byId<HTMLButtonElement>('settings-toggle');
	const drawer = byId<HTMLElement>('settings');

	const peek = (open: boolean): void => {
		if (isSettingsPinned) {
			return;
		}
		window.clearTimeout(peekCloseTimer);
		if (open) {
			setSettingsOpen(true, { moveFocus: false });
			return;
		}
		// Deferred, because crossing from the 20px handle into the drawer fires
		// `mouseleave` on the handle on the way — with an immediate close the
		// drawer would shut in the gap and the pointer would arrive at a
		// slide-out, which reads as the menu being broken.
		peekCloseTimer = window.setTimeout(() => {
			if (!isSettingsPinned) {
				setSettingsOpen(false, { moveFocus: false });
			}
		}, 140);
	};

	handle.addEventListener('mouseenter', () => peek(true));
	handle.addEventListener('mouseleave', () => peek(false));
	drawer.addEventListener('mouseenter', () => peek(true));
	drawer.addEventListener('mouseleave', () => peek(false));

	handle.addEventListener('click', () => {
		const open = !isSettingsPinned;
		isSettingsPinned = open;
		setSettingsOpen(open);
	});

	byId<HTMLElement>('settings-scrim').addEventListener('click', closeSettings);
}

/** Closes the drawer and unpins it, however it was opened. */
function closeSettings(): void {
	isSettingsPinned = false;
	window.clearTimeout(peekCloseTimer);
	setSettingsOpen(false);
}

/**
 * Opens or closes the settings drawer.
 *
 * `hidden` rather than a class, because the stylesheet slides the drawer out
 * from `[hidden]` and the slide needs the attribute to flip.
 *
 * `moveFocus` is opt-out because a hover-opened menu must not steal it: the
 * pointer can brush the edge while the user is halfway through a sentence, and
 * yanking focus into the drawer would dump the rest of it into the wrong field.
 */
function setSettingsOpen(open: boolean, options: { moveFocus?: boolean } = {}): void {
	const drawer = byId<HTMLElement>('settings');
	const scrim = byId<HTMLElement>('settings-scrim');
	const handle = byId<HTMLButtonElement>('settings-toggle');

	drawer.hidden = !open;
	setHidden(scrim, !open);
	handle.setAttribute('aria-expanded', String(open));

	// DEV-8.3: o painel DEV é lido **quando o drawer abre**. Medido no pacote:
	// depois de um turno que escreveu, abrir o drawer mostrava "Ativo" e o
	// cartão da operação oculto, porque a seção tinha sido desenhada antes da
	// escrita e nada a redesenhava. Outras seções não dependem de estado vivo.
	if (open && state.bridge !== undefined) {
		void refreshDevPanel(state.bridge, { quiet: true });
	}

	if (options.moveFocus === false) {
		return;
	}
	if (open) {
		byId<HTMLButtonElement>('settings-close').focus();
	} else {
		handle.focus();
	}
}

/**
 * Shows one settings section and hides the rest.
 *
 * `hidden` rather than a class, so the sections are gone from the accessibility
 * tree and the tab order rather than merely invisible. The `hidden` attribute
 * needs the matching `.panel[hidden] { display: none }` in the stylesheet, since
 * an author `display: flex` beats the browser's own rule for the attribute.
 *
 * The section names are read off the markup rather than hardcoded here, so
 * adding a section is one panel plus one nav button and nothing else.
 */
function setActiveSection(name: string): void {
	for (const panel of document.querySelectorAll<HTMLElement>('.panel[data-section]')) {
		panel.hidden = panel.dataset['section'] !== name;
	}
	for (const item of document.querySelectorAll<HTMLElement>('.settings-nav-item')) {
		item.setAttribute('aria-pressed', String(item.dataset['section'] === name));
	}
	// DEV-8: o painel DEV é lido **ao abrir**. Antes, a leitura acontecia só
	// no `main()`, quando o drawer da janela principal ainda estava fechado —
	// abrir a seção mostrava "carregando…" e botões ocultos com o estado já
	// conhecido. A seção é a única que depende de estado do host para desenhar.
	if (name === 'dev' && state.bridge !== undefined) {
		// DEV-8.3: a leitura acontece **ao abrir** a seção. Medido no pacote: o
		// painel mostrou "Ativo" e a operação ficou em `written`, mas o cartão
		// da operação continuava oculto — a seção tinha sido desenhada antes da
		// escrita existir e nada a redesenhou.
		void refreshDevPanel(state.bridge, { quiet: true });
	}
}

/** Wires the settings section list. Only meaningful in the settings window. */
function bindSettingsNav(): void {
	for (const item of document.querySelectorAll<HTMLElement>('.settings-nav-item')) {
		item.addEventListener('click', () => {
			const name = item.dataset['section'];
			if (name !== undefined) {
				setActiveSection(name);
			}
		});
	}
	// Starts on whichever section the markup marks as pressed, so the first
	// section is chosen in the markup rather than duplicated here.
	const initial = document.querySelector<HTMLElement>('.settings-nav-item[aria-pressed="true"]');
	setActiveSection(initial?.dataset['section'] ?? 'providers');
}

/** Sizes a textarea to its content, up to the stylesheet's `max-height`. */
function autoGrow(textarea: HTMLTextAreaElement): void {
	textarea.style.height = 'auto';
	textarea.style.height = `${textarea.scrollHeight}px`;
}

// ── skill evolution: the review queue ─────────────────────────────────────────

/**
 * The skill review queue.
 *
 * Built to be read before it is acted on. Every card shows what was observed,
 * how many runs stand behind it, what was never tested and — for a proposal
 * whose evidence is thin — says so in the card rather than in a tooltip nobody
 * opens.
 *
 * Three rules the buttons below are built around:
 *
 * - Approve and activate are separate. Approving records agreement and changes
 *   nothing that is live; the Activate button only exists once the proposal is
 *   `approved`, and it is what writes the skill.
 * - Every decision asks for a reason, because the reason is what the history
 *   keeps and what a later rollback is judged against.
 * - Nothing here claims the change was tested. The card states the evidence and
 *   stops; the Core reports effectiveness as unproven and this UI does not
 *   dress that up.
 */

/** How a proposal's evidence strength reads in the UI. */
const STRENGTH_LABEL: Record<SkillProposalView['strength'], string> = {
	observation: 'Observação única — sem confirmação',
	hypothesis: 'Hipótese — poucas execuções',
	'sustained-pattern': 'Padrão sustentado no escopo testado',
};

const STATUS_LABEL: Record<SkillProposalStatus, string> = {
	pending: 'Aguardando decisão',
	approved: 'Aprovada — ainda não aplicada',
	rejected: 'Rejeitada',
	activated: 'Ativa',
	reverted: 'Revertida',
};

/** Builds a labelled list, or nothing when there is nothing to list. */
function bulletList(items: readonly string[], emptyText: string): HTMLElement {
	const list = document.createElement('ul');
	list.className = 'muted small';
	if (items.length === 0) {
		const item = document.createElement('li');
		item.textContent = emptyText;
		list.append(item);
		return list;
	}
	for (const text of items) {
		const item = document.createElement('li');
		item.textContent = text;
		list.append(item);
	}
	return list;
}

/** The current and proposed instructions, side by side. */
function contentComparison(proposal: SkillProposalView): HTMLElement {
	const wrap = document.createElement('div');
	wrap.className = 'stack';

	const current = document.createElement('details');
	const currentSummary = document.createElement('summary');
	currentSummary.textContent =
		proposal.currentInstructions.length > 0
			? `Versão atual (${proposal.currentVersion || 'sem versão'})`
			: 'Versão atual: a skill ainda não existe';
	current.append(currentSummary);
	const currentBody = document.createElement('pre');
	currentBody.className = 'small';
	currentBody.textContent =
		proposal.currentInstructions.length > 0
			? proposal.currentInstructions
			: '(nenhuma)';
	current.append(currentBody);
	wrap.append(current);

	const proposed = document.createElement('details');
	// Open by default: the change is the reason this panel exists, and making the
	// user click twice to see it is how a proposal gets approved unread.
	const proposedSummary = document.createElement('summary');
	proposedSummary.textContent = `Proposta (${proposal.proposedVersion})`;
	proposed.append(proposedSummary);
	proposed.open = true;
	const proposedBody = document.createElement('pre');
	proposedBody.className = 'small';
	proposedBody.textContent = proposal.proposed.instructions;
	proposed.append(proposedBody);
	wrap.append(proposed);

	return wrap;
}

/** One proposal card, with its evidence and its two decision buttons. */
function proposalCard(
	proposal: SkillProposalView,
	decide: (proposal: SkillProposalView, action: 'approve' | 'reject' | 'activate') => void,
	showVersions: (proposal: SkillProposalView) => void,
): HTMLElement {
	const card = document.createElement('article');
	card.className = 'panel';
	card.dataset['proposalId'] = proposal.id;

	const title = document.createElement('h3');
	title.textContent = proposal.createsNewSkill
		? `Nova skill: ${proposal.proposed.title}`
		: `${proposal.proposed.title} (${proposal.currentVersion} → ${proposal.proposedVersion})`;
	card.append(title);

	const badge = document.createElement('p');
	badge.className = 'muted small';
	badge.textContent = `${STATUS_LABEL[proposal.status]} · ${STRENGTH_LABEL[proposal.strength]}`;
	card.append(badge);

	const problem = document.createElement('p');
	problem.textContent = proposal.problem;
	card.append(problem);

	const rationale = document.createElement('p');
	rationale.className = 'muted small';
	rationale.textContent = proposal.rationale;
	card.append(rationale);

	// The evidence, stated as a count and where it came from. A proposal that
	// cannot name its runs is not reviewable, so the ids are shown rather than
	// summarised away.
	const evidence = document.createElement('p');
	evidence.className = 'muted small';
	evidence.textContent =
		`Evidência: ${proposal.evidence.sampleSize} execução(ões) · ` +
		`domínios: ${proposal.evidence.domains.join(', ') || 'não especificados'} · ` +
		`execuções: ${proposal.evidence.supportingRuns.join(', ') || 'nenhuma'}`;
	card.append(evidence);

	card.append(contentComparison(proposal));

	const benefits = document.createElement('h4');
	benefits.textContent = 'Benefícios esperados';
	card.append(benefits);
	card.append(bulletList(proposal.expectedBenefits, 'nenhum benefício declarado'));

	const risks = document.createElement('h4');
	risks.textContent = 'Riscos e limitações';
	card.append(risks);
	card.append(
		bulletList(
			[...proposal.risks, ...proposal.untestedCases],
			'nenhum risco declarado',
		),
	);

	const criteria = document.createElement('h4');
	criteria.textContent = 'Como validar a melhoria';
	card.append(criteria);
	card.append(
		bulletList(
			proposal.validationCriteria.map(
				(criterion) => `${criterion.description} — observável como: ${criterion.observableAs}`,
			),
			'nenhum critério definido',
		),
	);

	// Stated plainly rather than left for the user to infer: there is no
	// automated test of whether better instructions produced a better result.
	const unproven = document.createElement('p');
	unproven.className = 'muted small';
	unproven.textContent =
		'A eficácia desta mudança não foi comprovada automaticamente. Só o uso real pode mostrar se ela ajudou.';
	card.append(unproven);

	if (proposal.decision !== undefined) {
		const decision = document.createElement('p');
		decision.className = 'muted small';
		decision.textContent =
			`Decisão de ${proposal.decision.decidedBy} em ${proposal.decision.decidedAt}: ${proposal.decision.reason}`;
		card.append(decision);
	}

	const actions = document.createElement('div');
	actions.className = 'row';

	const reasonInput = document.createElement('input');
	reasonInput.type = 'text';
	reasonInput.placeholder = 'motivo da decisão';
	reasonInput.autocomplete = 'off';
	reasonInput.setAttribute('aria-label', 'Motivo da decisão');
	actions.append(reasonInput);

	const reason = (): string => reasonInput.value.trim();

	if (proposal.status === 'pending') {
		const approve = document.createElement('button');
		approve.type = 'button';
		approve.textContent = 'Aprovar';
		approve.addEventListener('click', () => decide(proposal, 'approve'));
		actions.append(approve);

		const reject = document.createElement('button');
		reject.type = 'button';
		reject.className = 'danger subtle';
		reject.textContent = 'Rejeitar';
		reject.addEventListener('click', () => decide(proposal, 'reject'));
		actions.append(reject);
	}

	if (proposal.status === 'approved') {
		const activate = document.createElement('button');
		activate.type = 'button';
		activate.textContent = 'Ativar na skill';
		// Only ever present once a decision is recorded: the Core would refuse
		// otherwise, and a button that cannot work is worse than no button.
		activate.addEventListener('click', () => decide(proposal, 'activate'));
		actions.append(activate);
	}

	if (proposal.status === 'activated' && proposal.skillId !== undefined) {
		const versions = document.createElement('button');
		versions.type = 'button';
		versions.className = 'secondary';
		versions.textContent = 'Versões e rollback';
		versions.addEventListener('click', () => showVersions(proposal));
		actions.append(versions);
	}

	card.append(actions);
	return card;
}

/**
 * Asks for a reason through the window's own prompt.
 *
 * Not `window.prompt`: that is blocked in Electron's renderer and silently
 * returns null, which here would look like a cancelled decision rather than a
 * missing one.
 */
function askForReason(message: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		const input = document.createElement('input');
		input.type = 'text';
		input.placeholder = 'motivo';
		input.autocomplete = 'off';
		const form = document.createElement('form');
		const dialog = document.createElement('div');
		dialog.className = 'panel';
		dialog.setAttribute('role', 'dialog');
		dialog.setAttribute('aria-label', message);
		const text = document.createElement('p');
		text.textContent = message;
		form.append(input);
		const row = document.createElement('div');
		row.className = 'row';
		const confirm = document.createElement('button');
		confirm.type = 'submit';
		confirm.textContent = 'Confirmar';
		const cancel = document.createElement('button');
		cancel.type = 'button';
		cancel.className = 'secondary';
		cancel.textContent = 'Cancelar';
		row.append(confirm, cancel);
		form.append(row);
		dialog.append(text, form);

		let settled = false;
		const close = (value: string | undefined): void => {
			if (settled) {
				return;
			}
			settled = true;
			dialog.remove();
			resolve(value);
		};

		form.addEventListener('submit', (event) => {
			event.preventDefault();
			const value = input.value.trim();
			// A decision with no reason is not one anybody can audit later, so an
			// empty box keeps the dialog open rather than recording a blank.
			if (value.length === 0) {
				input.focus();
				return;
			}
			close(value);
		});
		cancel.addEventListener('click', () => close(undefined));

		const host = byId('skills-list');
		host.append(dialog);
		input.focus();
	});
}

/** Reads the filter, or `undefined` for "everything". */
function selectedStatus(): SkillProposalStatus | undefined {
	const value = byId<HTMLSelectElement>('skills-filter').value;
	return value.length === 0 ? undefined : (value as SkillProposalStatus);
}

function showSkillsError(message: string | undefined): void {
	const error = byId('skills-error');
	if (message === undefined) {
		error.hidden = true;
		error.textContent = '';
		return;
	}
	error.hidden = false;
	error.textContent = message;
}

/** Lists the archived versions of a skill and offers a rollback. */
async function showSkillVersions(
	bridge: SeshyinaBridge,
	proposal: SkillProposalView,
): Promise<void> {
	const skillId = proposal.skillId;
	if (skillId === undefined) {
		return;
	}
	const list = byId('skills-list');
	let versions;
	try {
		versions = await bridge.listSkillVersions(skillId);
	} catch (error) {
		showSkillsError(error instanceof Error ? error.message : String(error));
		return;
	}

	const panel = document.createElement('div');
	panel.className = 'panel';
	const heading = document.createElement('h3');
	heading.textContent = `Versões de ${skillId}`;
	panel.append(heading);

	if (versions.length === 0) {
		panel.append(bulletList([], 'nenhuma versão anterior arquivada'));
	}

	for (const version of versions) {
		const row = document.createElement('div');
		row.className = 'row';
		const label = document.createElement('span');
		label.className = 'muted small';
		label.textContent = `${version.version} · ${version.reason} · ${version.archivedAt}`;
		row.append(label);

		const rollback = document.createElement('button');
		rollback.type = 'button';
		rollback.className = 'danger subtle';
		rollback.textContent = 'Reverter para esta versão';
		rollback.addEventListener('click', async () => {
			const reason = await askForReason(
				`Reverter "${skillId}" para a versão ${version.version}? A versão atual será arquivada antes, então nada é perdido.`,
			);
			if (reason === undefined) {
				return;
			}
			try {
				const result = await bridge.rollbackSkillVersion(skillId, version.versionId, reason);
				if (!result.ok) {
					showSkillsError(result.error ?? 'a reversão não foi feita');
					return;
				}
				showSkillsError(undefined);
				await refreshSkillProposals(bridge);
			} catch (error) {
				showSkillsError(error instanceof Error ? error.message : String(error));
			}
		});
		row.append(rollback);
		panel.append(row);
	}

	list.prepend(panel);
}

/** Applies one decision and reloads the queue. */
async function decideProposal(
	bridge: SeshyinaBridge,
	proposal: SkillProposalView,
	action: 'approve' | 'reject' | 'activate',
): Promise<void> {
	try {
		if (action === 'activate') {
			// No reason asked: activation is not a judgement, it is the execution of
			// one already recorded on the approval.
			const result = await bridge.activateSkillEvolutionProposal(proposal.id);
			if (!result.ok) {
				showSkillsError(result.error ?? 'a proposta não foi ativada');
				return;
			}
		} else {
			const question =
				action === 'approve'
					? `Aprovar a mudança em "${proposal.proposed.title}"? A skill ativa só muda depois de "Ativar".`
					: `Rejeitar a proposta de "${proposal.proposed.title}"? Ela fica no histórico com o motivo.`;
			const reason = await askForReason(question);
			if (reason === undefined) {
				return;
			}
			if (action === 'approve') {
				await bridge.approveSkillEvolutionProposal(proposal.id, reason);
			} else {
				await bridge.rejectSkillEvolutionProposal(proposal.id, reason);
			}
		}
		showSkillsError(undefined);
		await refreshSkillProposals(bridge);
	} catch (error) {
		showSkillsError(error instanceof Error ? error.message : String(error));
	}
}

/**
 * Runs the analysis and shows what came back.
 *
 * Reads the history; writes nothing. The proposals it found are shown below with
 * their evidence and their untested cases, and filing one is a further, separate
 * act — so "Analisar histórico" can never be the click that changed a skill.
 */
async function runSkillScan(bridge: SeshyinaBridge): Promise<void> {
	const host = byId('skills-scan-result');
	const button = byId<HTMLButtonElement>('skills-scan');
	button.disabled = true;
	button.textContent = 'Analisando…';

	try {
		const scan = await bridge.scanSkillHistory();
		renderSkillScan(host, scan);
	} catch (error) {
		showSkillsError(error instanceof Error ? error.message : String(error));
	} finally {
		button.disabled = false;
		button.textContent = 'Analisar histórico';
	}
}

/** Draws one scan: the counts, the findings, and the model observations. */
function renderSkillScan(host: HTMLElement, scan: SkillScanView): void {
	host.replaceChildren();
	host.hidden = false;

	const headline = document.createElement('p');
	headline.textContent = scan.summary;
	host.append(headline);

	if (scan.errors.length > 0) {
		const problems = document.createElement('p');
		problems.className = 'error small';
		problems.textContent = `Histórico não lido: ${scan.errors.join('; ')}`;
		host.append(problems);
	}

	if (scan.skipped.length > 0) {
		const skipped = document.createElement('details');
		const summary = document.createElement('summary');
		summary.textContent = `${scan.skipped.length} execução(ões) sem evidência suficiente`;
		skipped.append(summary);
		skipped.append(
			bulletList(
				scan.skipped.map((entry) => `${entry.refId}: ${entry.reason}`),
				'nenhuma',
			),
		);
		host.append(skipped);
	}

	if (scan.opportunities.length === 0) {
		const none = document.createElement('p');
		none.className = 'muted small';
		none.textContent =
			scan.runsRead === 0
				? 'Ainda não há execuções registradas para analisar.'
				: 'A análise não encontrou evidência suficiente para propor melhoria.';
		host.append(none);
	} else {
		const found = document.createElement('h4');
		found.textContent = 'Oportunidades encontradas';
		host.append(found);
		for (const opportunity of scan.opportunities) {
			const item = document.createElement('div');
			item.className = 'panel';
			const title = document.createElement('p');
			title.textContent = `${opportunity.title} — ${STRENGTH_LABEL[opportunity.strength]}`;
			item.append(title);
			const problem = document.createElement('p');
			problem.className = 'muted small';
			problem.textContent = opportunity.problem;
			item.append(problem);
			const evidence = document.createElement('p');
			evidence.className = 'muted small';
			evidence.textContent =
				`${opportunity.sampleSize} execução(ões) · domínios: ${opportunity.domains.join(', ') || 'não especificados'} · ` +
				`execuções: ${opportunity.supportingRuns.join(', ') || 'nenhuma'}`;
			item.append(evidence);
			item.append(
				bulletList(opportunity.untestedCases, 'nenhum caso não testado declarado'),
			);
			if (!opportunity.generalizesBeyondSample) {
				// Said on the finding itself, not only on the proposal: this is the
				// line that stops a three-run pattern from reading as a rule.
				const scope = document.createElement('p');
				scope.className = 'muted small';
				scope.textContent = 'Este padrão não foi confirmado além das execuções citadas.';
				item.append(scope);
			}
			host.append(item);
		}
	}

	if (scan.modelObservations.length > 0) {
		const models = document.createElement('details');
		const summary = document.createElement('summary');
		summary.textContent = 'O que foi observado sobre cada modelo';
		models.append(summary);
		for (const observation of scan.modelObservations) {
			const item = document.createElement('div');
			item.className = 'panel';
			const title = document.createElement('p');
			title.textContent = observation.key;
			item.append(title);

			const duration = observation.medianDurationMs.value;
			const counts = document.createElement('p');
			counts.className = 'muted small';
			counts.textContent =
				`${observation.runs} execução(ões) · ${observation.verifiedPasses} verificada(s) com êxito · ` +
				`${observation.verifiedFailures} verificada(s) com falha · ${observation.unverifiedRuns} sem verificação`;
			item.append(counts);

			const timing = document.createElement('p');
			timing.className = 'muted small';
			timing.textContent =
				duration === undefined
					? `Duração: desconhecida — ${observation.medianDurationMs.note}`
					: `Duração mediana: ${duration.toFixed(0)} ms (${observation.medianDurationMs.note})`;
			item.append(timing);

			const tokens = document.createElement('p');
			tokens.className = 'muted small';
			tokens.textContent =
				observation.tokensUsed.value === undefined
					? `Consumo de tokens: desconhecido — ${observation.tokensUsed.note}`
					: `Consumo de tokens: ${observation.tokensUsed.value} (${observation.tokensUsed.note})`;
			item.append(tokens);

			const caveat = document.createElement('p');
			caveat.className = observation.canCompare ? 'muted small' : 'muted small';
			caveat.textContent = observation.caveat;
			item.append(caveat);

			models.append(item);
		}
		const note = document.createElement('p');
		note.className = 'muted small';
		note.textContent =
			'Nada aqui declara um modelo melhor que outro. Responder mais rápido não é ' +
			'qualidade, e uma resposta convincente não é evidência de que a tarefa foi cumprida.';
		models.append(note);
		host.append(models);
	}
}

/** Reads the queue and renders it. */
async function refreshSkillProposals(bridge: SeshyinaBridge): Promise<void> {
	const list = byId('skills-list');
	const status = selectedStatus();

	let proposals: readonly SkillProposalView[];
	try {
		proposals = await bridge.listSkillEvolutionProposals(status);
	} catch (error) {
		showSkillsError(error instanceof Error ? error.message : String(error));
		return;
	}
	showSkillsError(undefined);

	// Cleared rather than appended to: a reload must not leave a card the user
	// already decided on sitting above the current one.
	list.replaceChildren();

	const pending = proposals.filter((proposal) => proposal.status === 'pending').length;
	byId('skills-count').textContent =
		pending > 0 ? `${pending} aguardando decisão` : `${proposals.length} proposta(s)`;

	byId('skills-empty').hidden = proposals.length > 0;
	if (proposals.length === 0) {
		return;
	}

	for (const proposal of proposals) {
		list.append(
			proposalCard(
				proposal,
				(target, action) => {
					void decideProposal(bridge, target, action);
				},
				(target) => {
					void showSkillVersions(bridge, target);
				},
			),
		);
	}
}

/** Wires the skills panel. Only meaningful in the settings window. */
function bindSkillEvolution(bridge: SeshyinaBridge): void {	byId('skills-filter').addEventListener('change', () => {
		void refreshSkillProposals(bridge);
	});
	byId('skills-refresh').addEventListener('click', () => {
		void refreshSkillProposals(bridge);
	});
	byId('skills-scan').addEventListener('click', () => {
		void runSkillScan(bridge);
	});
}

/**
 * O painel do modo DEV (DEV-6).
 *
 * ## O que esta página decide, e o que não
 *
 * Decide **texto**: o que mostrar do estado que o host mandou, e como
 * perguntar antes de uma ação destrutiva. Não decide permissão: `canActivate`,
 * `canApply` e `canRestore` vêm do host; o `main` recusa de novo, e o Core
 * recusa uma terceira vez (etapa e id). Se esta página estiver errada, nada
 * de errado acontece além de mostrar um botão que devolve erro.
 *
 * ## Confirmação
 *
 * Aplicar e restaurar pedem confirmação: aplicar pode reiniciar o aplicativo,
 * e restaurar **sobrescreve arquivos**. A restauração só é oferecida para
 * checkpoints que o host marcou como restauráveis — o que já verifica que
 * ninguém mudou o arquivo por fora.
 */

/**
 * Confirmação de uma ação do painel DEV (DEV-8.3).
 *
 * Um diálogo da própria página, como `confirmDelete`: no Electron `window.confirm`
 * é bloqueado e devolve `false` sem perguntar — medido no app empacotado: o
 * botão "Aplicar" não fazia nada, e a operação ficava em `written` sem que a
 * pessoa visse um erro. O texto de pergunta vai como `textContent`.
 */
function confirmDevAction(question: string): Promise<boolean> {
	return new Promise((resolve) => {
		const dialog = document.createElement('div');
		dialog.className = 'panel';
		dialog.setAttribute('role', 'dialog');
		dialog.setAttribute('aria-label', 'Confirmar ação do modo DEV');
		const text = document.createElement('p');
		text.textContent = question;
		text.id = 'dev-confirm-question';
		const row = document.createElement('div');
		row.className = 'row end';
		const cancel = document.createElement('button');
		cancel.type = 'button';
		cancel.className = 'secondary';
		cancel.textContent = 'Cancelar';
		const accept = document.createElement('button');
		accept.type = 'button';
		accept.className = 'danger';
		accept.textContent = 'Confirmar';
		accept.id = 'dev-confirm-ok';
		row.append(cancel, accept);
		dialog.append(text, row);
		let settled = false;
		const close = (value: boolean): void => {
			if (settled) {
				return;
			}
			settled = true;
			dialog.remove();
			resolve(value);
		};
		cancel.addEventListener('click', () => close(false));
		accept.addEventListener('click', () => close(true));
		const host = byId('dev-error').parentElement ?? document.body;
		host.append(dialog);
		cancel.focus();
	});
}

function bindDevPanel(bridge: SeshyinaBridge): void {
	const run = async (action: () => Promise<unknown>): Promise<void> => {
		try {
			hide(byId('dev-error'));
			await action();
		} catch (error) {
			showDevError(error);
		}
		await refreshDevPanel(bridge);
	};

	byId('dev-refresh').addEventListener('click', () => {
		void run(async () => undefined);
	});
	byId('dev-activate').addEventListener('click', () => {
		void run(() => bridge.activateDev());
	});
	byId('dev-deactivate').addEventListener('click', async () => {
		// Encerrar retira a autorização e as ferramentas da agente na hora: é
		// irreversível sem uma nova ativação, e por isso é confirmado.
		if (!(await confirmDevAction('Encerrar o modo DEV? A autorização e as ferramentas da Evelyn são retiradas agora.'))) {
			return;
		}
		void run(() => bridge.deactivateDev());
	});
	byId('dev-restart-local').addEventListener('click', async () => {
		const error = byId('dev-restart-error');
		hide(error);
		const button = byId<HTMLButtonElement>('dev-restart-local');
		button.disabled = true;
		try {
			const reply = await bridge.restartInLocalMode();
			if (!reply.ok) {
				button.disabled = false;
				showError(error, reply.message);
			}
			// Aceito: o app encerra o serviço e reinicia. Se demorar, o botão
			// fica desabilitado de propósito — um segundo clique pediria o
			// fechamento de um serviço que já está saindo.
		} catch (reason) {
			button.disabled = false;
			showError(error, reason instanceof Error ? reason.message : String(reason));
		}
	});
	byId('dev-lock').addEventListener('click', () => {		// Bloquear não apaga a lembrança: não há motivo para confirmar, e a
		// ação é reversível (o próximo desbloqueio não pede senha).
		void run(() => bridge.lockDev());
	});
	byId('dev-revoke-unlock').addEventListener('click', async () => {
		if (
			!(
				await confirmDevAction(
					'Revogar o desbloqueio deste dispositivo? A lembrança é apagada e qualquer cópia dela deixa de valer. A senha volta a ser pedida na próxima ativação.',
				)
			)
		) {
			return;
		}
		void run(() => bridge.revokeDevUnlock());
	});
	byId('dev-apply').addEventListener('click', async () => {
		const id = byId('dev-apply').dataset['operation'];
		if (id === undefined) {
			return;
		}
		const restart = byId('dev-apply').dataset['restart'] === 'true';
		// A estratégia mais pesada é explicada antes: "reiniciar" não é o mesmo
		// que "recarregar", e a pessoa precisa saber o que vai acontecer.
		const question = restart
			? 'Aplicar esta alteração? Ela exige reiniciar o aplicativo para valer. A conversa continua onde está.'
			: 'Aplicar esta alteração? A Evelyn cria os checkpoints, roda as verificações e confirma o resultado.';
		if (!(await confirmDevAction(question))) {
			return;
		}
		void run(() => bridge.applyDevOperation(id));
	});
	byId('dev-history-refresh').addEventListener('click', () => {
		// Só o histórico: recarregar o painel inteiro piscaria a sessão e os
		// botões por causa de uma lista.
		void renderDevHistory(bridge);
	});
	byId('dev-restore-all').addEventListener('click', async () => {
		if (!(await confirmDevAction('Restaurar os arquivos da última aplicação? Os arquivos alterados por ela voltam ao estado anterior.'))) {
			return;
		}
		void run(() => bridge.restoreDevCheckpoint());
	});
	// DEV-7: configurar a autorização. A senha não é pedida aqui: o `main`
	// abre a pergunta (`onDevOwnerPrompt`) e esta página só a desenha.
	byId('dev-configure').addEventListener('click', () => {
		void run(() => bridge.configureDevAuthorization());
	});
	byId('dev-recover').addEventListener('click', () => {
		// Recuperar apaga a credencial: sem ela, o modo DEV não ativa até ser
		// configurado de novo. É irreversível sem uma nova senha.
		if (
			!window.confirm(
				'Recuperar a credencial local? Ela será apagada e você precisará configurar uma senha nova. ' +
					'Se o modo DEV estiver ativo, ele será encerrado.',
			)
		) {
			return;
		}
		void run(() => bridge.recoverDevAuthorization());
	});

	bridge.onDevOwnerPrompt((prompt) => {
		const box = byId('dev-owner-prompt');
		box.hidden = false;
		box.dataset['id'] = prompt.id;
		box.dataset['kind'] = prompt.kind;
		byId('dev-owner-title').textContent = prompt.title;
		byId('dev-owner-detail').textContent = prompt.detail;
		// DEV-9.1: a pergunta de comando mostra os fatos e **esconde** o campo
		// de senha — não há credencial a digitar, e um campo vazio sugeriria
		// que existe.
		const isCommand = prompt.kind === 'run-command';
		const facts = byId('dev-command-facts');
		facts.hidden = !isCommand;
		byId('dev-owner-password-wrap').hidden = isCommand;
		if (isCommand) {
			const detail = prompt.detail;
			const pick = (label: string): string => {
				const match = new RegExp(`^${label}:\\s*(.+)$`, 'm').exec(detail);
				return match?.[1]?.trim() ?? '—';
			};
			byId('dev-command-text').textContent = pick('Comando');
			byId('dev-command-cwd').textContent = pick('Diretório');
			byId('dev-command-scope').textContent = pick('Escopo');
		}
		byId('dev-owner-confirmation-wrap').hidden = prompt.kind !== 'configure';
		// A caixa de lembrança só existe quando o host oferece o desbloqueio —
		// e só no pedido de autorização, nunca ao configurar/trocar a senha.
		const rememberWrap = byId('dev-owner-remember-wrap');
		const canRemember = prompt.kind === 'authorize' && prompt.canRemember === true;
		rememberWrap.hidden = !canRemember;
		byId<HTMLInputElement>('dev-owner-remember').checked = false;
		byId<HTMLInputElement>('dev-owner-password').value = '';
		byId<HTMLInputElement>('dev-owner-confirmation').value = '';
		byId('dev-owner-submit').textContent =
			prompt.kind === 'configure' ? 'Configurar' : prompt.kind === 'run-command' ? 'Executar' : 'Autorizar';
		// Foco: o campo de senha quando há um; no cartão de comando, o botão de
		// executar (não há campo para focar, e um Enter teria de cair nele).
		if (isCommand) {
			byId<HTMLButtonElement>('dev-owner-submit').focus();
		} else {
			byId<HTMLInputElement>('dev-owner-password').focus();
		}
	});

	const answerPrompt = async (answer: DevOwnerPromptAnswerView): Promise<void> => {
		hide(byId('dev-owner-prompt'));
		// O campo é limpo antes de a resposta sair: o valor não fica na página.
		byId<HTMLInputElement>('dev-owner-password').value = '';
		byId<HTMLInputElement>('dev-owner-confirmation').value = '';
		const result = await bridge.answerDevOwnerPrompt(answer);
		if (!result.accepted) {
			showDevError(new Error(result.reason ?? 'a resposta não foi aceita'));
		}
		await refreshDevPanel(bridge, { quiet: true });
	};

	byId('dev-owner-submit').addEventListener('click', () => {
		const box = byId('dev-owner-prompt');
		const id = box.dataset['id'];
		if (id === undefined) {
			return;
		}
		// A aprovação de comando não tem senha: o id basta, e o host só a
		// aceita se a pergunta aberta for mesmo `run-command`.
		if (box.dataset['kind'] === 'run-command') {
			void answerPrompt({ id, kind: 'approve' });
			return;
		}
		const password = byId<HTMLInputElement>('dev-owner-password').value;
		if (password.length === 0) {
			showDevError(new Error('digite a senha local do proprietário'));
			return;
		}
		if (box.dataset['kind'] === 'configure') {
			const confirmation = byId<HTMLInputElement>('dev-owner-confirmation').value;
			void answerPrompt({ id, kind: 'configure', password, confirmation });
			return;
		}
		// A marca só viaja quando a caixa estava visível: uma página adulterada
		// não faz o app gravar um recibo que a pessoa não viu a opção.
		const remember =
			!byId('dev-owner-remember-wrap').hidden &&
			byId<HTMLInputElement>('dev-owner-remember').checked;
		void answerPrompt(
			remember ? { id, kind: 'password', password, remember: true } : { id, kind: 'password', password },
		);
	});
	byId('dev-owner-cancel').addEventListener('click', () => {
		const box = byId('dev-owner-prompt');
		const id = box.dataset['id'];
		byId<HTMLInputElement>('dev-owner-password').value = '';
		byId<HTMLInputElement>('dev-owner-confirmation').value = '';
		if (id !== undefined) {
			void answerPrompt({ id, kind: 'cancel' });
		}
	});
	// Enter envia, Escape cancela, como num formulário de senha comum.
	byId<HTMLInputElement>('dev-owner-password').addEventListener('keydown', (event) => {
		if (event.key === 'Enter') {
			event.preventDefault();
			byId('dev-owner-submit').click();
		}
		if (event.key === 'Escape') {
			event.preventDefault();
			byId('dev-owner-cancel').click();
		}
	});
	byId<HTMLInputElement>('dev-owner-confirmation').addEventListener('keydown', (event) => {
		if (event.key === 'Enter') {
			event.preventDefault();
			byId('dev-owner-submit').click();
		}
	});
	byId<HTMLButtonElement>('dev-owner-submit').addEventListener('keydown', (event) => {
		// No cartão de comando não há campo de senha: o Enter recai aqui.
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			byId('dev-owner-submit').click();
		}
		if (event.key === 'Escape') {
			event.preventDefault();
			byId('dev-owner-cancel').click();
		}
	});
	bridge.onDevChange(() => {
		void refreshDevPanel(bridge, { quiet: true });
	});
}

/**
 * Esconde os controles que só fazem sentido com um estado DEV conhecido.
 *
 * Chamado quando a leitura do estado falha: nenhum deles pode agir, e deixá-los
 * à mostra (ou pior, deixar só o "Atualizar") oferece botões que não levam a
 * lugar nenhum. A saída desse caso é o bloco de modo conectado, não estes.
 */
function hideDevSessionControls(): void {
	for (const id of [
		'dev-session',
		'dev-unavailable',
		'dev-activate',
		'dev-deactivate',
		'dev-configure',
		'dev-recover',
		'dev-activation-note',
		'dev-operation',
		'dev-persistent',
		'dev-credential-note',
	]) {
		byId(id).hidden = true;
	}
}

/**
 * Mostra o bloco "indisponível em modo conectado" — decidindo **agora**.
 *
 * Pergunta o modo ao Core em vez de confiar em `state.coreMode`: o estado do
 * DEV e o modo do Core são lidos por caminhos independentes, e o painel é
 * desenhado antes de o modo chegar. Ler aqui fecha a corrida.
 */
async function applyLocalOnlyVisibility(): Promise<void> {
	const bridge = state.bridge;
	const block = byId('dev-local-only');
	if (bridge === undefined) {
		block.hidden = true;
		return;
	}
	try {
		const status = await bridge.getCoreStatus();
		state.coreMode = status.mode;
		block.hidden = status.mode !== 'connected';
	} catch {
		block.hidden = true;
	}
}

/** Lê e desenha o estado do painel. */
async function refreshDevPanel(bridge: SeshyinaBridge, options: { readonly quiet?: boolean } = {}): Promise<void> {
	let devState;
	try {
		devState = await bridge.getDevState();
	} catch (error) {
		// Uma janela que não consegue perguntar diz isso — não mostra um estado
		// inventado de "inativo".
		byId('dev-session-badge').textContent = 'indisponível';
		// No modo conectado o host **não tem** DEV para consultar: a chamada
		// falha com "não está montado", e é justamente o caso em que a saída
		// para o modo local precisa aparecer. Antes este `return` a escondia
		// para sempre — o bloco existia no HTML e nunca era revelado.
		await applyLocalOnlyVisibility();
		// Todo botão que depende do estado DEV começa oculto no HTML, e só o
		// ramo de sucesso os mostra. Sem esta limpeza, a janela conectada
		// exibia "Atualizar" ao lado de três botões invisíveis — e Atualizar só
		// republicava o mesmo erro, sem caminho de saída.
		hideDevSessionControls();
		if (options.quiet !== true) {
			showDevError(error);
		}
		return;
	}

	const unavailable = byId('dev-unavailable');
	const session = byId('dev-session');
	const activate = byId<HTMLButtonElement>('dev-activate');
	const deactivate = byId<HTMLButtonElement>('dev-deactivate');
	const note = byId('dev-activation-note');

	if (!devState.repo.available) {
		unavailable.hidden = false;
		session.hidden = true;
		activate.hidden = true;
		deactivate.hidden = true;
		note.hidden = true;
		byId('dev-session-badge').textContent = 'indisponível';
		byId('dev-unavailable-reason').textContent = devState.repo.reason;
		// O modo conectado é a recusa mais comum — e a única com saída em um
		// clique. O bloco aparece **só** ali: nas outras recusas não há serviço
		// para encerrar, e um botão que só reabre não resolveria nada.
		//
		// A decisão não pode depender da ordem das leituras: o modo do Core e o
		// estado do DEV chegam por caminhos diferentes, e este desenho rodava
		// antes de o modo ser conhecido. Perguntar agora — na hora de desenhar —
		// fecha a corrida em vez de torcer para a ordem se manter.
		await applyLocalOnlyVisibility();
	} else {
		byId('dev-local-only').hidden = true;
		unavailable.hidden = true;
		session.hidden = false;
		byId('dev-root').textContent = devState.repo.root;
		byId('dev-session-badge').textContent = devState.session === 'active' ? 'ativo' : 'inativo';
		const active = devState.session === 'active';
		byId('dev-session-state').textContent = active ? 'Ativo' : 'Inativo';
		byId('dev-authorization').textContent = authorizationLabel(devState.authorization, active);
		byId('dev-started').textContent = devState.startedAt === undefined ? '—' : formatWhen(devState.startedAt);
		activate.hidden = active;
		deactivate.hidden = !active;
		activate.disabled = !devState.canActivate || !devState.canAct;
		// Esta janela não é a do host (é a de configurações): mostrar o botão de
		// ativar seria oferecer uma ação que o `main` recusa.
		if (!devState.canAct) {
			activate.hidden = true;
			deactivate.hidden = true;
		}
		if (!active && devState.activationBlockedReason !== undefined) {
			note.hidden = false;
			note.textContent = devState.activationBlockedReason;
		} else if (!devState.canActivate && !active) {
			note.hidden = false;
			note.textContent = 'o modo DEV não pode ser ativado agora';
		} else {
			note.hidden = true;
		}
	}

	if (devState.message !== undefined) {
		byId('dev-message').hidden = false;
		byId('dev-message').textContent = devState.message;
	} else {
		hide(byId('dev-message'));
	}

	renderCredential(devState);
	renderDevPersistent(devState);
	renderDevOperation(devState);
	renderDevCheckpoints(devState);
		void renderDevHistory(bridge);
}

/**
 * O histórico das execuções do `dev_run` (DEV-9.1).
 *
 * Cada linha mostra o que o diário guarda — comando, diretório, quando,
 * decisão, duração, código e motivo — e **nunca a saída**, porque o diário
 * não a guarda: um teste imprime o que quiser, e um arquivo que dura mais que
 * o turno não pode carregar isso.
 *
 * Tudo vai por `textContent`: o comando vem do que foi digitado e pode conter
 * qualquer caractere.
 */
async function renderDevHistory(bridge: SeshyinaBridge): Promise<void> {
	const list = byId('dev-history');
	const empty = byId('dev-history-empty');
	const error = byId('dev-history-error');
	list.replaceChildren();
	hide(error);
	let entries: readonly DevRunHistoryView[];
	try {
		entries = await bridge.getDevRunHistory();
	} catch (reason) {
		// O histórico é observação: uma falha ao lê-lo não pode parecer que o
		// DEV está quebrado. A lista fica vazia e o erro fica visível.
		empty.hidden = true;
		showError(error, reason instanceof Error ? reason.message : String(reason));
		return;
	}
	empty.hidden = entries.length > 0;
	for (const entry of entries) {
		const item = document.createElement('li');
		item.className = 'router-fact';

		const command = document.createElement('code');
		command.className = 'router-fact-value small';
		command.textContent = entry.command;

		const facts: string[] = [
			`${formatWhen(entry.startedAt)} · ${formatDuration(entry.durationMs)}`,
			describeTermination(entry),
			describeApproval(entry.approval),
		];
		if (entry.truncated) {
			facts.push('saída truncada');
		}
		if (entry.reason !== undefined && entry.reason.length > 0) {
			facts.push(entry.reason);
		}

		const detail = document.createElement('p');
		detail.className = 'router-fact-value muted small';
		detail.textContent = facts.join(' · ');

		const where = document.createElement('p');
		where.className = 'router-fact-value muted small';
		where.textContent = entry.cwd;

		item.append(command, detail, where);
		list.append(item);
	}
}

/** Como a execução terminou, em uma frase. */
function describeTermination(entry: DevRunHistoryView): string {
	switch (entry.termination) {
		case 'exited':
			return entry.exitCode === 0 ? 'concluído' : `saiu com código ${String(entry.exitCode)}`;
		case 'timeout':
			return 'encerrado por prazo';
		case 'cancelled':
			return 'cancelado';
		case 'killed':
			return 'processo encerrado à força';
		case 'failed':
			return 'não chegou a executar';
	}
}

/** A decisão que autorizou (ou recusou) a execução. */
function describeApproval(approval: DevRunHistoryView['approval']): string {
	switch (approval) {
		case 'approved':
			return 'aprovado';
		case 'refused':
			return 'recusado';
		case 'cancelled':
			return 'cancelado antes de começar';
		case 'not-required':
			return 'sem pergunta';
	}
}

/** Uma duração curta: `820ms`, `3,2s`, `1min 5s`. */
function formatDuration(ms: number): string {
	if (ms < 1_000) {
		return `${Math.round(ms)}ms`;
	}
	if (ms < 60_000) {
		return `${(ms / 1_000).toFixed(1).replace('.', ',')}s`;
	}
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.round((ms % 60_000) / 1_000);
	return `${minutes}min ${seconds}s`;
}

/** O desbloqueio persistente, quando esta instalação o oferece.
 *
 * Sem `devState.persistent`, o bloco fica escondido: um host que não liga o
 * recurso não mostra um botão que não faz nada — e a interface dos usuários
 * comuns fica exatamente como era.
 */
function renderDevPersistent(devState: DevPanelState): void {
	const block = byId('dev-persistent');
	const persistent = devState.persistent;
	const state = byId('dev-persistent-state');
	const detail = byId('dev-persistent-detail');
	const lock = byId<HTMLButtonElement>('dev-lock');
	const revoke = byId<HTMLButtonElement>('dev-revoke-unlock');

	if (persistent === undefined || !persistent.available) {
		block.hidden = true;
		return;
	}
	block.hidden = false;
	// As duas ações mudam o estado do host: a janela de configurações não as
	// oferece, pelo mesmo motivo do ativar (o `main` recusaria).
	const canAct = devState.canAct;
	lock.hidden = !canAct;
	revoke.hidden = !canAct;
	lock.disabled = !canAct || devState.session !== 'active';
	revoke.disabled = !canAct || !persistent.remembered;

	if (persistent.remembered) {
		state.setAttribute('data-state', persistent.unlocked ? 'active' : 'inactive');
		state.textContent = persistent.unlocked ? 'desbloqueado' : 'lembrado';
		detail.textContent =
			persistent.since !== undefined
				? `Lembrado em ${formatWhen(persistent.since)}. O próximo desbloqueio não pede a senha.`
				: 'O próximo desbloqueio não pede a senha.';
		return;
	}
	if (persistent.problem !== undefined) {
		// Um recibo que existe e não vale precisa dizer por quê: "revogado" e
		// "ilegível" levam a ações diferentes.
		state.setAttribute('data-state', 'error');
		state.textContent = 'precisa de senha';
		detail.textContent = persistent.problem;
		return;
	}
	state.setAttribute('data-state', 'inactive');
	state.textContent = 'não lembrado';
	detail.textContent =
		'Ao ativar com a senha, este dispositivo pode lembrar a autorização (a senha não é guardada).';
}

/**
 * O estado da credencial local (DEV-7) e o que a pessoa pode fazer.
 *
 * `canAct` é o que separa a janela do host das outras: só ela oferece
 * configurar/recuperar, e o `main` recusa de qualquer forma.
 */
function renderCredential(devState: DevPanelState): void {
	const credential = devState.localCredential;
	const configure = byId<HTMLButtonElement>('dev-configure');
	const recover = byId<HTMLButtonElement>('dev-recover');
	const note = byId('dev-credential-note');

	byId('dev-credential').textContent = credentialLabel(credential);
	const canConfigure = devState.canAct && devState.credentialActions.canConfigure;
	configure.hidden = !(canConfigure && credential.kind === 'not-configured');
	recover.hidden = !(canConfigure && (credential.kind === 'corrupt' || credential.kind === 'invalidated'));

	if (credential.kind === 'blocked') {
		note.hidden = false;
		note.textContent = `Tentativas demais. Tente de novo depois de ${formatWhen(credential.until)}.`;
	} else if (credential.kind === 'corrupt' || credential.kind === 'invalidated') {
		note.hidden = false;
		note.textContent =
			credential.kind === 'corrupt'
				? 'A credencial não pôde ser lida. A recuperação apaga o arquivo; depois configure uma senha nova.'
				: credential.message;
	} else if (credential.kind === 'unavailable') {
		note.hidden = false;
		note.textContent = credential.reason;
	} else if (credential.kind === 'not-configured') {
		note.hidden = false;
		note.textContent = 'Sem credencial local, o modo DEV não ativa pela interface.';
	} else {
		hide(note);
	}
}

function credentialLabel(credential: DevPanelState['localCredential']): string {
	switch (credential.kind) {
		case 'not-configured':
			return 'Não configurada';
		case 'configured':
			return `Configurada para ${credential.user} em ${formatWhen(credential.configuredAt)}`;
		case 'invalidated':
			return 'Invalidada — a sessão foi encerrada';
		case 'blocked':
			return `Bloqueada por tentativas demais (${credential.failures})`;
		case 'corrupt':
			return 'Ilegível';
		case 'unavailable':
			return 'Indisponível';
	}
}

function authorizationLabel(authorization: DevPanelState['authorization'], active: boolean): string {
	switch (authorization) {
		case 'active':
			return 'Concedida nesta execução — some ao encerrar ou reiniciar.';
		case 'pending-restore':
			return 'Não concedida. Havia uma sessão antes de reiniciar; confirme na janela principal para reabrir.';
		case 'none':
			return 'Não concedida.';
		case 'unavailable':
			return `Não disponível${active ? '' : '.'}`;
	}
}

/** A operação: o que o host registrou, sem acrescentar nada. */
function renderDevOperation(devState: DevPanelState): void {
	const operation = devState.operation;
	const box = byId('dev-operation');
	const empty = byId('dev-operation-empty');
	if (operation === undefined) {
		box.hidden = true;
		empty.hidden = false;
		return;
	}
	box.hidden = false;
	empty.hidden = true;
	byId('dev-op-id').textContent = operation.id;
	byId('dev-op-stage').textContent = operation.stageLabel;
	byId('dev-op-strategy').textContent = strategyLabel(operation.strategy);
	byId('dev-op-updated').textContent = formatWhen(operation.updatedAt);
	fillList(byId('dev-op-files'), operation.files, 'Nenhum arquivo identificado.');

	const checksWrap = byId('dev-op-checks-wrap');
	if (operation.checks.length === 0) {
		hide(checksWrap);
	} else {
		checksWrap.hidden = false;
		fillList(
			byId('dev-op-checks'),
			operation.checks.map((check) => `${check.name} — ${check.result ?? 'não executada'}`),
		);
	}
	const resultsWrap = byId('dev-op-results-wrap');
	if (operation.results.length === 0) {
		hide(resultsWrap);
	} else {
		resultsWrap.hidden = false;
		fillList(byId('dev-op-results'), operation.results);
	}

	const apply = byId<HTMLButtonElement>('dev-apply');
	const applyNote = byId('dev-apply-note');
	const canApply = operation.canApply && operation.canAct;
	apply.hidden = !canApply;
	apply.disabled = !canApply;
	apply.dataset['operation'] = operation.id;
	apply.dataset['restart'] = String(operation.requiresControlledRestart);
	if (!operation.canApply && operation.applyBlockedReason !== undefined) {
		applyNote.hidden = false;
		applyNote.textContent = operation.applyBlockedReason;
	} else if (operation.requiresControlledRestart) {
		applyNote.hidden = false;
		applyNote.textContent = 'Esta alteração exige reinício controlado; será pedida confirmação.';
	} else {
		hide(applyNote);
	}
}

/** Os checkpoints, com o que o Core permitir. */
function renderDevCheckpoints(devState: DevPanelState): void {
	const list = byId('dev-checkpoints');
	const trigger = byId<HTMLButtonElement>('dev-restore-all');
	list.replaceChildren();
	const checkpoints = devState.checkpoints;
	byId('dev-checkpoints-empty').hidden = checkpoints.length > 0;
	// A restauração em bloco é da **última aplicação** (o que o Core sabe
	// desfazer de uma vez). Com a sessão inativa, o Core não restaura: o botão
	// só aparece quando há sessão.
	trigger.hidden = checkpoints.length === 0 || devState.session !== 'active' || !devState.canAct;
	for (const checkpoint of checkpoints) {
		const item = document.createElement('li');
		item.className = 'router-fact';
		const label = document.createElement('span');
		label.className = 'router-fact-label';
		label.textContent = `Checkpoint ${checkpoint.id}`;
		const when = document.createElement('p');
		when.className = 'router-fact-value muted small';
		when.textContent = `${formatWhen(checkpoint.createdAt)} · ${checkpoint.files.join(', ') || 'sem arquivos'}`;
		item.append(label, when);
		if (checkpoint.canRestore && devState.canAct) {
			const button = document.createElement('button');
			button.type = 'button';
			button.textContent = 'Restaurar estes arquivos';
			button.addEventListener('click', async () => {
				if (!(await confirmDevAction('Restaurar os arquivos deste checkpoint ao estado anterior? Eles serão sobrescritos.'))) {
					return;
				}
				void restoreCheckpoint(checkpoint.id);
			});
			item.append(button);
		} else if (checkpoint.blockedReason !== undefined) {
			const blocked = document.createElement('p');
			blocked.className = 'muted small';
			// O Core recusou a restauração automática: o texto diz qual arquivo
			// e por quê, em vez de um botão que falharia.
			blocked.textContent = `Não pode ser restaurado automaticamente — ${checkpoint.blockedReason}`;
			item.append(blocked);
		}
		list.append(item);
	}
}

async function restoreCheckpoint(checkpointId: string): Promise<void> {
	const bridge = state.bridge;
	if (bridge === undefined) {
		return;
	}
	try {
		hide(byId('dev-error'));
		const result = await bridge.restoreDevCheckpoint(checkpointId);
		await refreshDevPanel(bridge);
		// O desfecho real vai para a mesma linha de aviso — inclusive quando
		// parte dos arquivos foi recusada por conflito.
		byId('dev-message').hidden = false;
		byId('dev-message').textContent =
			result.blocked !== undefined && result.blocked.length > 0
				? `${result.detail}: ${result.blocked.join('; ')}`
				: result.detail;
	} catch (error) {
		showDevError(error);
		await refreshDevPanel(bridge);
	}
}

function fillList(list: HTMLElement, items: readonly string[], emptyText?: string): void {
	list.replaceChildren();
	if (items.length === 0 && emptyText !== undefined) {
		const item = document.createElement('li');
		item.className = 'muted small';
		item.textContent = emptyText;
		list.append(item);
		return;
	}
	for (const text of items) {
		const item = document.createElement('li');
		item.textContent = text;
		list.append(item);
	}
}

function strategyLabel(strategy: NonNullable<DevPanelState['operation']>['strategy']): string {
	switch (strategy) {
		case 'hot':
			return 'recarregar o estilo (sem reiniciar)';
		case 'reload-ui':
			return 'recarregar a janela';
		case 'restart-app':
			return 'reiniciar o aplicativo';
		case 'restart-controlled':
			return 'reinício controlado (exige confirmação)';
	}
}

function showDevError(error: unknown): void {
	const host = byId('dev-error');
	host.hidden = false;
	host.textContent = error instanceof Error ? error.message : String(error);
}

function hide(element: HTMLElement): void {
	element.hidden = true;
}

/** Uma data em hora local curta; vazio quando não há. */
function formatWhen(iso: string): string {
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

async function main(): Promise<void> {
	// Set before anything renders: the stylesheet keys the whole layout off it,
	// and a first paint in the wrong layout would flash the chat into the
	// settings window.
	const role = windowRole();
	document.body.dataset.window = role;

	state.bridge = readBridge(window);
	if (state.bridge === undefined) {
		byId('status-dot').classList.add('failed');
		byId('status-label').textContent = 'Bridge unavailable';
		showError(
			byId('core-error'),
			'The preload bridge is not available, so this page is running outside the desktop app.',
		);
		return;
	}

	bindEvents(state.bridge);
	// DEV-8.9: o modo é escolha desta janela. Lido antes do primeiro desenho,
	// para o seletor e o compositor já abrirem no modo em que a pessoa deixou.
	state.turnMode = readStoredTurnMode(window.localStorage);
	render();
	// Projects first: a new conversation binds to the selected one, so the
	// picker has to be populated before anything else runs.
	await refreshProjects();
	await Promise.all([loadCoreStatus(), refreshProviders()]);
	// R4B: o modo do Core já foi lido; o estado do serviço é consultado
	// depois para que a interface decida o que mostrar — e para que uma falha
	// de conexão apareça com o motivo, em vez de "carregando" para sempre.
	await loadServiceStatus();

	// R4D: no modo conectado, o histórico é o do serviço — e é a única lista
	// que existe, já que este processo não tem Core. Carrega antes de escolher
	// a primeira conversa, para o app abrir com uma conversa real na tela (ou
	// com a lista vazia, se não houver nenhuma).
	if (state.coreMode === 'connected') {
		await refreshServiceConversations(state.bridge);
	}

	if (document.body.dataset.window === 'settings') {
		// Only one section is ever on screen, so the nav decides what the body
		// shows before anything else reads it.
		bindSettingsNav();
		// O modo do Core é lido **aqui** também: é esta janela que desenha o
		// painel DEV, e a decisão "o DEV existe neste processo?" depende do
		// modo. Sem a leitura, `state.coreMode` ficava indefinido e o bloco de
		// "indisponível em modo conectado" nunca aparecia — medido no pacote.
		await loadCoreStatus();
		// DEV-8: os listeners do painel DEV antes das leituras. O
		// `bindSettingsNav` acima já abriu a seção inicial e pode pedir a leitura
		// da seção DEV; sem os listeners, a página desenharia sem eles.
		bindDevPanel(state.bridge);
		// The model panel is `.only-chat`, so this window never renders it — and
		// the list costs one request per provider. Loading it here meant the
		// settings window asked every endpoint for a list it then threw away,
		// which is one round of HTTP per provider every time it was opened.
		await openFirstConversation(state.bridge);
		// The catalog is local, so unlike the model list this costs no request
		// per provider and is read straight from disk.
		await refreshModelCatalog();
		// The budget reads the ledger, which is local too. Loaded with the
		// catalog so the Orçamento section is populated before it is shown.
		await refreshBudget();
		// Proposals likewise live on disk. Bound before the first read so the
		// filter is live the moment the section appears.
		bindSkillEvolution(state.bridge);
		await refreshSkillProposals(state.bridge);
		return;
	}

	// Restored from `state.json` on boot, and `selectedModel` starts empty, so
	// without this the app opens with Send greyed out on the provider the user
	// left configured last.
	await loadModels();

	// O painel do roteador: o estado do roteador, a última decisão e o
	// monitoramento. Tudo é leitura local — o arquivo de configuração, o
	// ledger e o histórico —, então nada disto custa uma requisição a um
	// provedor.
	await refreshBudget();

	// Land on something usable: the newest conversation of the selected
	// provider, so reopening the app shows the work in progress.
	await openFirstConversation(state.bridge);

	// DEV-8: o painel DEV na **janela principal** — é ela que pode agir
	// (configurar, ativar, aplicar, restaurar). Os listeners existem desde a
	// abertura; a leitura acontece quando a seção DEV é aberta no drawer.
	bindDevPanel(state.bridge);
	await refreshDevPanel(state.bridge, { quiet: true });
}

/**
 * Opens the most recent conversation of the selected provider.
 *
 * Shared by both windows because the settings one needs it too: the system
 * prompt belongs to a conversation, so the window that edits it has to know
 * which conversation is current.
 */
async function openFirstConversation(bridge?: SeshyinaBridge): Promise<void> {
	// DEV-4: a janela pergunta antes de desenhar qual conversa abrir. Sem isto,
	// uma recarga ou reinício para aplicar uma mudança devolveria a pessoa à
	// primeira da lista, e a mudança que ela pediu pareceria perdida.
	const boot = bridge === undefined ? undefined : await bridge.getUiBootState().catch(() => undefined);
	const wanted =
		boot?.conversationId === undefined
			? undefined
			: state.conversations.find((item) => item.id === boot.conversationId);
	const target = wanted ?? state.conversations[0];
	if (target !== undefined) {
		await openConversation(target.id);
	}
	if (boot?.message !== undefined && boot.message.length > 0) {
		// O aviso vive acima do histórico e não é uma mensagem da conversa: se
		// fosse, ficaria gravado e apareceria de novo a cada abertura.
		showResumeNotice(boot.message, boot.canRetry === true);
		// Mostrado uma vez: a marca é limpa para o aviso não se repetir.
		void bridge?.setUiSession({ generating: false }).catch(() => undefined);
	}
}

/**
 * Grava qual conversa está aberta (DEV-4).
 *
 * É o que faz uma recarga ou reinício — para aplicar uma mudança do modo DEV —
 * voltar para a mesma conversa. A falha não interrompe a tela: a gravação é
 * memória de navegação, não conteúdo.
 */
function rememberConversation(bridge: SeshyinaBridge, conversationId: string): void {
	void bridge.setUiSession({ conversationId }).catch(() => undefined);
}

/** O aviso de retomada, desenhado à parte das mensagens (DEV-4). */
function showResumeNotice(message: string, canRetry: boolean): void {
	const host = byId('core-error');
	host.hidden = false;
	host.textContent = canRetry ? `${message} (use “Enviar” de novo para retomar se quiser)` : message;
}

void main();
