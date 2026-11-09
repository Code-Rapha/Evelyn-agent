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
 * The one exception to importing nothing below is `import type` for the model's
 * `CostUnit` and `ModelAccess`. It is erased at compile time and adds no bytes
 * to either bundle, and it is worth the narrow exception because the alternative
 * is restating the same two unions here — where the renderer, the preload and
 * the Core would then be free to drift apart, and a drift there would show up as
 * a price in the wrong unit.
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

/**
 * A consulta ao serviço local independente (R4A).
 *
 * Uma leitura: estado e catálogo. Não substitui canal nenhum e não depende de
 * o Core local estar montado — é justamente o canal que informa o que o
 * serviço tem, quando ele está no ar.
 */
export const SERVICE_STATUS_CHANNEL = 'seshyina:service-status';
export const SERVICE_CATALOG_CHANNEL = 'seshyina:service-catalog';
/** R4C: a conversa pelo serviço. */
export const SERVICE_SEND_CHANNEL = 'seshyina:service-send';
export const SERVICE_STOP_CHANNEL = 'seshyina:service-stop';
export const SERVICE_PERMISSION_CHANNEL = 'seshyina:service-permission';
/** R4D: o histórico do serviço. */
export const SERVICE_CONVERSATIONS_CHANNEL = 'seshyina:service-conversations';
export const SERVICE_CONVERSATION_CHANNEL = 'seshyina:service-conversation';
/** R4E: criar uma conversa no serviço. */
export const SERVICE_CREATE_CHANNEL = 'seshyina:service-create';
/** R4F: renomear e excluir. */
export const SERVICE_RENAME_CHANNEL = 'seshyina:service-rename';
export const SERVICE_DELETE_CHANNEL = 'seshyina:service-delete';
/** R4H: o estado dos turnos de uma conversa. */
export const SERVICE_TURNS_CHANNEL = 'seshyina:service-turns';
/** R4R: abrir o painel do serviço no navegador do usuário. */
export const SERVICE_PANEL_CHANNEL = 'seshyina:service-panel';
/** DEV-4: o estado da sessão de interface (conversa a abrir, aviso de retomada). */
export const UI_SESSION_CHANNEL = 'seshyina:ui-session';
/**
 * DEV-6: o painel do modo DEV.
 *
 * Uma entrada para leitura e ações (`seshyina:dev`), como `window`/`ui-session`:
 * o primeiro argumento é a ação, e o parser do `main` decide se ela existe.
 * Canais separados por "quem aplica a mudança" seriam mais superfície do que
 * a mesma fronteira validada.
 */
export const DEV_CHANNEL = 'seshyina:dev';
/**
 * DEV-6: o host avisa que o estado DEV mudou.
 *
 * Só isto: uma linha do tipo `refresh`. Nenhum dado vai no evento — a página
 * relê o estado pelo canal principal. Um evento não é autoridade.
 */
export const DEV_EVENT_CHANNEL = 'seshyina:dev-event';
/**
 * DEV-7: o host pede a senha de autorização local.
 *
 * O `main` manda o desafio (id, tipo e texto) só para a janela do host; a
 * página devolve a resposta por `seshyina:dev-owner-answer`. A senha **não**
 * volta pelo evento nem é guardada pela página.
 */
export const DEV_OWNER_PROMPT_CHANNEL = 'seshyina:dev-owner-prompt';
/** DEV-7: a resposta à pergunta de autorização. */
export const DEV_OWNER_ANSWER_CHANNEL = 'seshyina:dev-owner-answer';
/**
 * DEV-10: a pergunta aberta agora, lida por quem chega depois do evento.
 *
 * A janela criada **para** a pergunta pode estar montando quando o evento
 * sai, e um ouvinte inscrito depois não recebe o que já passou.
 */
export const DEV_OWNER_PENDING_CHANNEL = 'seshyina:dev-owner-pending';

/**
 * O que a janela recebe ao abrir, depois de uma recarga ou reinício (DEV-4).
 *
 * Só conversa e aviso. Nenhum caminho, token ou conteúdo de arquivo chega ao
 * renderer por aqui — ver `core/dev/sessionMessages.ts`.
 */
export interface UiBootStateView {
	readonly conversationId?: string;
	readonly message?: string;
	readonly canRetry?: boolean;
}

/** O estado do serviço, como o renderer o vê. Espelha o cliente do main. */
export interface ServiceLinkStatus {
	readonly state: 'active' | 'inactive';
	readonly reason?: string;
	readonly detail: string;
	readonly port?: number;
	readonly pid?: number;
	readonly version?: string;
}

/** O catálogo do serviço, ou o motivo de não haver. */
export type ServiceCatalogReply =
	| { readonly ok: true; readonly catalog: unknown }
	| { readonly ok: false; readonly code: string; readonly message: string };

/**
 * O que aconteceu ao pedir para abrir o painel no navegador (R4R).
 *
 * `opened` traz o endereço usado (sem a credencial: a URL é montada uma vez,
 * no processo principal, e o renderer não precisa dela). Recusa dita o motivo
 * em vez de abrir uma página de erro.
 */
export type ServicePanelReply =
	| { readonly ok: true }
	| { readonly ok: false; readonly code: 'inactive' | 'invalid' | 'failed'; readonly message: string };

/** O canal do controle manual do serviço: ativar, desligar, reler o estado. */
export const SERVICE_CONTROL_CHANNEL = 'seshyina:service-control';
/**
 * O estado do serviço **empurrado** para as janelas quando muda.
 *
 * O mesmo padrão do roteador: quem muda o estado (o controle nesta janela, a
 * inicialização no arranque, o serviço caindo sozinho) avisa, e todas as
 * janelas redesenham. Sem isto, a tela mostraria "desligado" depois de ativar
 * por outro caminho — o defeito medido no pacote.
 */
export const SERVICE_STATE_CHANNEL = 'seshyina:service-state';

/**
 * O estado do serviço, como a tela o mostra.
 *
 * `iniciando` e `desligando` são estados **da operação**, não do processo: a
 * janela não deve dizer "desligado" enquanto o pedido ainda está em curso nem
 * "ativo" antes do health responder.
 */
export type ServiceControlState =
	| { readonly state: 'active'; readonly pid: number; readonly port: number; readonly version?: string }
	| { readonly state: 'inactive' }
	| { readonly state: 'starting' }
	| { readonly state: 'stopping' }
	| { readonly state: 'error'; readonly message: string };

/** O que o controle devolve depois de uma operação. */
export type ServiceControlReply =
	| { readonly ok: true; readonly state: ServiceControlState }
	| { readonly ok: false; readonly state: ServiceControlState; readonly message: string };

/** Uma conversa do serviço (R4D). Espelha o que o serviço publica. */
export interface ServiceConversationItem {
	readonly id: string;
	readonly title: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly messageCount: number;
	/** Permanente: é o diálogo de preferências e não tem lixeira. */
	readonly pinned?: boolean;
}

/** As conversas do serviço, ou por que não vieram. */
export type ServiceConversationsReply =
	| { readonly ok: true; readonly conversations: readonly ServiceConversationItem[] }
	| { readonly ok: false; readonly code: string; readonly message: string };

/** Uma conversa aberta do serviço. */
export type ServiceConversationReply =
	| {
			readonly ok: true;
			readonly conversation: ServiceConversationItem;
			readonly messages: readonly { readonly role: 'user' | 'assistant'; readonly content: string }[];
	  }
	| { readonly ok: false; readonly code: string; readonly message: string };

/** O resultado de criar uma conversa no serviço (R4E). */
export type ServiceCreateConversationReply =
	| { readonly ok: true; readonly conversation: ServiceConversationItem }
	| { readonly ok: false; readonly code: string; readonly message: string };

/** O resultado de renomear uma conversa no serviço (R4F). */
export type ServiceRenameConversationReply =
	| { readonly ok: true; readonly conversation: ServiceConversationItem }
	| { readonly ok: false; readonly code: string; readonly message: string };

/** O resultado de excluir uma conversa no serviço (R4F). */
export type ServiceDeleteConversationReply =
	| { readonly ok: true }
	| { readonly ok: false; readonly code: string; readonly message: string };

/** Um turno, como a interface o vê (R4H). */
export interface ServiceTurnState {
	readonly turnId: string;
	readonly status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
	readonly startedAt: string;
	readonly finishedAt?: string;
	readonly reason?: string;
}

/** Os turnos de uma conversa (R4H). */
export type ServiceTurnStatesReply =
	| { readonly ok: true; readonly turns: readonly ServiceTurnState[] }
	| { readonly ok: false; readonly code: string; readonly message: string };
/** Lists, configures and selects providers and models. */
export const PROVIDER_CHANNEL = 'seshyina:provider';
/** Lists and creates projects, which give the tools a workspace. */
export const PROJECT_CHANNEL = 'seshyina:project';
/** Creates, lists, renames, reads and deletes conversations. */
export const CONVERSATION_CHANNEL = 'seshyina:conversation';
/**
 * Grava as preferências de modelo a partir do diálogo fixo.
 *
 * Canal próprio porque não é uma ação sobre a conversa — é a leitura da
 * resposta dela que o motor consulta. Separar também permite fechar este
 * caminho sem tocar no CRUD de conversas.
 */
export const MODEL_GUIDANCE_CHANNEL = 'seshyina:model-guidance';
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

/**
 * The model catalog: what the user knows about a model, and what runs measured.
 *
 * A separate channel from `MODEL_CHANNEL` because that one answers "which
 * models can I talk to right now" — a question about the providers, answered by
 * asking them. This one answers "what do I know about this model", which no
 * provider can answer and which must survive the provider going away.
 */
export const MODEL_CATALOG_CHANNEL = 'seshyina:model-catalog';

/**
 * Orçamentos: os limites locais e o consumo que eles limitam.
 *
 * Canal próprio porque não é catálogo nem ledger: o catálogo diz quanto custa
 * *um* modelo e o ledger registra o que aconteceu; este canal responde "quanto
 * já gastei neste período e quanto ainda posso gastar". As respostas também
 * são diferentes — um resumo agregado não cabe na lista de execuções.
 */
export const BUDGET_CHANNEL = 'seshyina:budget';

/**
 * Descoberta de modelos, preços e cotas dos provedores.
 *
 * Canal próprio porque as respostas não são nem catálogo nem orçamento: cada
 * linha diz *de onde* um fato veio (provedor, conta, observação local) e
 * *quando* foi verificado. É essa procedência que impede a tela de apresentar
 * uma estimativa local como limite oficial.
 */
export const DISCOVERY_CHANNEL = 'seshyina:discovery';

/**
 * Política de acesso a modelos e fonte de preço.
 *
 * Canal próprio porque é uma decisão, não uma leitura: `get` devolve o que está
 * gravado, `set` grava, e `catalog` devolve a fusão que depende das duas. Manter
 * a política fora do catálogo é o que permite trocá-la (e voltar atrás) sem
 * tocar em um único preço declarado.
 */
export const ACCESS_POLICY_CHANNEL = 'seshyina:access-policy';

/**
 * Controlled skill evolution: proposals, approvals, activation and rollback.
 *
 * Its own channel because every action here changes or reviews *knowledge*, not
 * configuration: a proposal that reaches the live skill file is a change to what
 * the agent believes about how to work, and it is the one channel where the Core
 * refuses to act without a recorded human decision. Kept separate from
 * `MODEL_CATALOG_CHANNEL` so a future catalog action cannot inherit its rules by
 * being added to the same switch.
 */
export const SKILL_EVOLUTION_CHANNEL = 'seshyina:skill-evolution';

/** Opening the settings window. A separate channel because it has no payload. */
export const OPEN_SETTINGS_CHANNEL = 'seshyina:open-settings';

/** Main pushing window state the renderer cannot observe for itself. */
export const WINDOW_STATE_CHANNEL = 'seshyina:window-state';

/**
 * Main telling every window that the router configuration changed.
 *
 * Duas janelas escrevem no mesmo arquivo: o painel principal tem o
 * interruptor, e a janela de configurações tem o formulário. Sem este aviso,
 * a janela que não escreveu continuaria mostrando um estado que já não é o
 * gravado — e o interruptor passaria a agir sobre uma cópia velha.
 *
 * O aviso leva o estado novo: quem recebe não precisa adivinhar nem reler.
 */
export const ROUTER_STATE_CHANNEL = 'seshyina:router-state';

// Erased at compile time; see the note at the top of this file. Imported here
// rather than redeclared so the bridge and the Core cannot disagree about what
// a cost unit or an access level is.
import type { CostUnit, ModelAccess } from '../core/storage/types/modelCatalog';
import type { ConversationDeleteOutcome } from '../core/storage/types/dataStore';
import type {
	DiscoveredModelView,
	DiscoveredQuotaView,
} from './discoveryView';
import type { AccessPolicyView, MergedModelView } from './catalogFusion';
import type { DevPanelState } from '../core/dev/devPanel';
import type { DevRunHistoryView } from './devView';
import type { RoutingDecisionReportView } from './decisionReport';
import type {
	ComparisonOutcome,
	ComparisonRefusal,
	ComparisonSide,
	HistoryExecution,
	ReportComparison,
} from './compareExecutions';

/** Uma execução do histórico, como a janela a lê. */
export type HistoryExecutionView = HistoryExecution;

/** A comparação de duas execuções, ou a recusa com o motivo. */
export type ExecutionComparisonView = ComparisonOutcome;

export type {
	AccessPolicyView,
	DiscoveredModelView,
	DiscoveredQuotaView,
	MergedModelView,
	RoutingDecisionReportView,
	ComparisonSide,
};

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
export const APP_NAME = 'Evelyn';

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
	/**
	 * Onde o estado da Evelyn vive agora (R4B).
	 *
	 * - `local`: este processo montou o Core e é o dono dos dados;
	 * - `connected`: o serviço local é o dono; este app só lê o que ele expõe;
	 * - `unavailable`: não há Core nem serviço — o app está aberto e sem dados.
	 *
	 * Nunca `connected` sem a descoberta e o health autenticado terem passado.
	 */
	readonly mode: 'local' | 'connected' | 'unavailable';
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
	/**
	 * O papel do endpoint: um **roteador** (que escolhe o modelo internamente)
	 * ou um **provedor** (que atende o modelo pedido).
	 *
	 * Ausente = `provider`: era a única coisa que se podia ter antes do papel
	 * existir, e é o que um registro antigo significa.
	 */
	readonly role?: 'router' | 'provider';
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

/**
 * A declared price, as the settings window edits it.
 *
 * Flattened into three form fields rather than reusing the Core's nested shape,
 * because it is filled in by hand: `input` and `output` are two text boxes
 * either way, and a blank box has to mean unknown rather than zero.
 */
export interface ModelPricingView {
	readonly currency: string;
	readonly unit: CostUnit;
	/** Blank or absent = unknown. Never inferred from the other field. */
	readonly input?: string;
	readonly output?: string;
}

/** Declared limits. Absent numbers are unknown, not zero. */
export interface ModelLimitsView {
	readonly contextTokens?: string;
	readonly maxOutputTokens?: string;
}

/**
 * The declared capability matrix, three-state per field.
 *
 * Absent is "nobody knows". A `false` is the user saying the model does not
 * have it. The difference decides whether the picker excludes the model or
 * merely cannot favour it.
 */
export interface ModelCapabilityView {
	readonly toolCalling?: boolean;
	readonly structuredOutput?: boolean;
	readonly reasoning?: boolean;
}

/** What the catalog knows about one model, split so the UI can label each part. */
export interface ModelCatalogEntryView {
	readonly providerId: string;
	readonly modelId: string;
	/** Comma-separated categories, blank when not classified. */
	readonly capabilities: string;
	/**
	 * The declared capability matrix, three-state per field.
	 *
	 * Absent means the user never said anything about it — not that the model
	 * lacks it. A `false` is the user saying the model does not have it.
	 */
	readonly model?: ModelCapabilityView;
	readonly pricing?: ModelPricingView;
	readonly access: ModelAccess;
	readonly limits?: ModelLimitsView;
	readonly notes?: string;
	/** How many real runs have been measured. 0 means nothing observed yet. */
	readonly observations: number;
	/** Median time to first byte, when at least one run reported one. */
	readonly medianFirstByteMs?: number;
	/** Median total time, when at least one run reported one. */
	readonly medianTotalMs?: number;
	readonly updatedAt: string;
}

/**
 * What the renderer may change about a model.
 *
 * Absent means "leave it alone". An empty `capabilities` string is a real value
 * — the user classified the model as good for nothing — and is sent as `[]`,
 * while blank text fields are sent as `null` to put a value back to unknown.
 */
export interface SaveModelCatalogInput {
	readonly providerId: string;
	readonly modelId: string;
	readonly capabilities?: string;
	readonly pricing?: ModelPricingView | null;
	readonly access?: ModelAccess;
	readonly limits?: ModelLimitsView | null;
	/**
	 * A matriz de capacidades, no formato de patch.
	 *
	 * Três estados por campo: `true` (tem), `false` (não tem) e ausente
	 * (ninguém sabe). `null` limpa o campo para desconhecido. É o lado
	 * **declarado** das capacidades, ao lado do que o provedor publica — e é
	 * o que permite ver um conflito entre os dois.
	 */
	readonly model?: ModelCapabilitiesPatchView | null;
	readonly notes?: string | null;
}

/**
 * O patch de capacidades, como o renderer o envia.
 *
 * Só os três campos booleanos: as modalidades são enumerações do provedor, e
 * uma modalidade escrita à mão é uma afirmação que ninguém verificou.
 */
export interface ModelCapabilitiesPatchView {
	readonly toolCalling?: boolean | null;
	readonly structuredOutput?: boolean | null;
	readonly reasoning?: boolean | null;
}
/** Names one model in the catalog, by the pair that identifies it. */
export interface ModelCatalogKey {
	readonly providerId: string;
	readonly modelId: string;
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
	/**
	 * What this endpoint is: a **router** or a plain **provider**.
	 *
	 * Omitted keeps whatever the endpoint already was. It is never the key —
	 * the key has its own field and its own store.
	 */
	readonly role?: 'router' | 'provider';
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
	/**
	 * Permanente: a conversa não tem lixeira.
	 *
	 * Ausente é o caso comum. A interface usa a marca para não desenhar o
	 * botão de apagar — e o store recusa a exclusão de qualquer forma.
	 */
	readonly pinned?: boolean;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly messageCount: number;
}

export type OrchestrationStrategy = 'manual' | 'fallback';

/**
 * Como o turno escolhe quem responde (DEV-8.9).
 *
 * - `auto` — o roteador nativo da Evelyn escolhe provedor e modelo pela
 *   política, pelo catálogo, pelos limites e pelo fallback. `providerId` e
 *   `model` são ignorados quando presentes, porque a escolha não é do usuário;
 * - `direct` — o usuário escolheu o par provedor + modelo; nada o substitui;
 * - `external` — a requisição vai ao roteador externo configurado
 *   (`externalRouterProviderId`), e quem escolhe o modelo é ele.
 *
 * Ausente significa o comportamento de antes da DEV-8.9: o par enviado pela
 * interface, com a configuração do roteador valendo por cima. É assim que um
 * cliente antigo continua funcionando.
 */
export type TurnRouting = 'auto' | 'direct' | 'external';

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
	/** Orchestration strategy for this turn. Defaults to 'manual'. */
	readonly strategy?: OrchestrationStrategy;
	/**
	 * Quem escolhe o provedor e o modelo neste turno (DEV-8.9).
	 *
	 * Ausente = decisão da configuração do roteador sobre o par enviado, como
	 * antes. Ver `TurnRouting`.
	 */
	readonly routing?: TurnRouting;
	/**
	 * Este turno é uma **tarefa** de várias etapas, e não uma pergunta.
	 *
	 * Muda três coisas, e todas na direção de não interromper trabalho no meio:
	 * o teto de rounds do motor sobe, o teto de tempo do turno é medido por
	 * **progresso** em vez de relógio, e a autorização de escrita no escopo DEV
	 * vale para a tarefa inteira. Ausente = turno comum, com os limites de
	 * sempre.
	 */
	readonly task?: boolean;
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
	| {
			readonly type: 'started';
			readonly turnId: string;
			/**
			 * Como este turno escolheu quem responde (DEV-8.9).
			 *
			 * Ausente em clientes e turnos anteriores à DEV-8.9. Presente, diz
			 * o modo que o turno obedeceu e o par **efetivo** — no modo
			 * automático é o que o motor escolheu; nos demais, o destino.
			 */
			readonly routing?: {
				readonly mode: TurnRouting;
				readonly providerId?: string;
				readonly model?: string;
			};
	  }
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
			/**
			 * Uma ferramenta falhou de um jeito passageiro e vai tentar de novo.
			 *
			 * Distinto de `toolResult` com `ok: false`, que é o desfecho: este
			 * é uma **espera**, e a interface a mostra como tal.
			 */
			readonly type: 'toolRetry';
			readonly turnId: string;
			readonly callId: string;
			readonly name: string;
			readonly attempt: number;
			readonly of: number;
			readonly reason: string;
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
			/**
			 * Why the answer was what it was.
			 *
			 * `user` é uma escolha; `cancelled` é a negação que ninguém
			 * escolheu (tempo, parada); `automatic` e `grant` são os dois
			 * casos em que o DEV não perguntou — leitura, e escrita já
			 * autorizada nesta tarefa. A interface distingue os quatro para
			 * não mostrar uma permissão que ninguém concedeu.
			 */
			readonly source: 'user' | 'cancelled' | 'automatic' | 'grant';
			/** O escopo que autorizou, quando `source` é `automatic` ou `grant`. */
			readonly scope?: string;
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
	| {
			/** Skills loaded for this turn, if any. Emitted after 'started'. */
			readonly type: 'skillsLoaded';
			readonly turnId: string;
			/** IDs of skills that were loaded and injected into the context. */
			readonly skillIds: readonly string[];
			/** Whether any explicitly requested skills were not found. */
			readonly missing?: readonly string[];
	  }
	| {
			readonly type: 'error';
			readonly turnId: string;
			readonly message: string;
			/**
			 * Why the turn was aborted, when it was aborted rather than failed.
			 *
			 * The orchestrator reads this instead of the message. Absent means a
			 * genuine failure — the model said no, or the network broke — and is
			 * classified on its own merits.
			 */
			readonly abortCause?: AbortCause;
	  }
	| {
		/** The orchestration selected a model for this turn. */
		readonly type: 'modelSelected';
		readonly turnId: string;
		readonly providerId: string;
		readonly modelId: string;
		readonly strategy: OrchestrationStrategy;
		readonly reason: string;
		readonly isFallback: boolean;
	  }
	| {
		/**
		 * Something the user should know that is not a failure and not the
		 * answer: a policy applied from a sentence, a model list that could not
		 * be refreshed. Drawn as a quiet line, kept in the transcript.
		 */
		readonly type: 'notice';
		readonly turnId: string;
		readonly message: string;
	  }
	| {
		/** A fallback attempt is starting (after a recoverable error on a previous model). */
		readonly type: 'fallbackAttempted';
		readonly turnId: string;
		readonly attempt: number;
		readonly providerId: string;
		readonly modelId: string;
		readonly previousError: string;
	  }
	| {
		/**
		 * Um candidato pago não foi chamado porque um limite de orçamento o
		 * vetou.
		 *
		 * Distinto de `fallbackAttempted`: o modelo não falhou e não foi
		 * tentado. `message` já vem pronta para o usuário, com o limite, o
		 * gasto e a moeda — o renderer não precisa reconstruí-la.
		 */
		readonly type: 'budgetBlocked';
		readonly turnId: string;
		readonly providerId: string;
		readonly modelId: string;
		/** 1-based order of the skipped attempt within the route. */
		readonly attempt: number;
		readonly message: string;
	  };

/**
 * Why a turn was aborted, as data rather than as prose.
 *
 * This exists because the *message* is for a person and the *decision* is for
 * the orchestrator. Recovering "was this a timeout?" by searching a Portuguese
 * sentence for the English word "timeout" is the bug this field was added to fix:
 * it silently returned false for every real timeout, so the fallback path never
 * ran. The message can be reworded, translated or re-punctuated without anyone
 * noticing that fallback broke with it.
 *
 * - `first-token` — the model accepted the request and produced no output within
 *   the stall budget.
 * - `total-time` — the whole turn, tool rounds included, exceeded the budget.
 * - `user-stop` — the user pressed Stop. Never recoverable: they meant it.
 */
export type AbortCause = 'first-token' | 'total-time' | 'user-stop';

/** Removes an event subscription. Safe to call more than once. */
export type Unsubscribe = () => void;

// ── skill evolution views ────────────────────────────────────────────────────

/** Where a proposal sits. Mirrors the Core's status vocabulary. */
export type SkillProposalStatus = 'pending' | 'approved' | 'rejected' | 'activated' | 'reverted';

/**
 * How well supported a proposal is.
 *
 * Carried across the bridge so the UI can *label* the claim rather than repeat
 * it: a user deciding on a `hypothesis` is being asked to decide something
 * weaker than one deciding on a `sustained-pattern`, and the difference is the
 * whole reason the field exists.
 */
export type SkillOpportunityStrength = 'observation' | 'hypothesis' | 'sustained-pattern';

/** One check the improvement should pass before it is judged a success. */
export interface SkillValidationCriterionView {
	readonly id: string;
	readonly description: string;
	/** How the user would notice. Not an automated result. */
	readonly observableAs: string;
}

/**
 * What the renderer sends to turn an opportunity into a proposal.
 *
 * The full proposed content, not a patch. A patch would need the current skill
 * to be interpreted by the renderer, and a proposal nobody can read side by side
 * with what it replaces is a proposal that gets approved unread.
 */
export interface SaveSkillImprovementInput {
	/** The fingerprint the scan reported. Binds the proposal to that finding. */
	readonly fingerprint: string;
	/** The skill to improve. Omitted to propose a new one. */
	readonly skillId?: string;
	readonly title: string;
	readonly description: string;
	readonly instructions: string;
	readonly proposedVersion?: string;
	readonly tags: readonly string[];
	readonly requiredTools: readonly string[];
	readonly riskLevel: 'safe' | 'moderate' | 'dangerous';
	readonly constraints: readonly string[];
	readonly expectedBenefits: readonly string[];
	readonly risks: readonly string[];
	readonly validationCriteria: readonly SkillValidationCriterionView[];
}

/** What the proposal would make the skill say. */
export interface ProposedSkillContentView {
	readonly title: string;
	readonly description: string;
	readonly instructions: string;
	readonly tags: readonly string[];
	readonly requiredTools: readonly string[];
	readonly riskLevel: 'safe' | 'moderate' | 'dangerous';
	readonly constraints: readonly string[];
}

/** A proposal as the review queue renders it. */
export interface SkillProposalView {
	readonly id: string;
	readonly status: SkillProposalStatus;
	/** Absent when the proposal asks for a brand new skill. */
	readonly skillId?: string;
	readonly createsNewSkill: boolean;
	readonly problem: string;
	readonly currentVersion: string;
	/**
	 * What the live skill says today.
	 *
	 * Carried in the view rather than fetched on demand so the current and the
	 * proposed content can be read side by side — a proposal the user has to
	 * click twice to compare is a proposal that gets approved unread. Empty for
	 * a proposal that creates a new skill, which has no current content.
	 */
	readonly currentInstructions: string;
	readonly proposedVersion: string;
	readonly proposed: ProposedSkillContentView;
	readonly rationale: string;
	readonly evidence: {
		readonly sampleSize: number;
		readonly supportingRuns: readonly string[];
		readonly domains: readonly string[];
	};
	readonly expectedBenefits: readonly string[];
	readonly risks: readonly string[];
	readonly untestedCases: readonly string[];
	readonly validationCriteria: readonly SkillValidationCriterionView[];
	readonly strength: SkillOpportunityStrength;
	readonly createdAt: string;
	/** Absent until a person decides. Its absence is why approve is required. */
	readonly decision?: {
		readonly decidedBy: string;
		readonly reason: string;
		readonly decidedAt: string;
	};
}

/** What is live against what is proposed. */
export interface SkillContentDiffView {
	readonly fieldsChanged: readonly string[];
	readonly instructionsChanged: boolean;
	readonly currentLength: number;
	readonly proposedLength: number;
	/** Removed lines as `- …`, added as `+ …`. Capped by the Core. */
	readonly instructionsDiff: readonly string[];
	readonly identical: boolean;
}

/** An archived revision. */
export interface SkillVersionView {
	readonly versionId: string;
	readonly skillId: string;
	readonly version: string;
	readonly content: ProposedSkillContentView;
	readonly archivedAt: string;
	readonly reason: 'initial' | 'activation' | 'rollback';
	readonly proposalId?: string;
}

/** The outcome of an activation or a rollback. */
export interface SkillEvolutionResultView {
	readonly ok: boolean;
	/** Why it did not happen, when it did not. */
	readonly error?: string;
	readonly skillId?: string;
	readonly version?: string;
	readonly instructionsLength?: number;
}

/**
 * A configuração do roteador, como a janela a lê.
 *
 * `configured` diz se o usuário **chegou a escolher** alguma coisa. Sem ele, o
 * app está no padrão — e o painel mostra "padrão", não "você escolheu isto".
 * A diferença importa: uma escolha que o app tomou por conta própria não é
 * uma escolha do usuário.
 */
export interface RouterConfigView {
	readonly mode: 'native' | 'external' | 'direct';
	readonly enabled: boolean;
	/** O provedor que age como roteador externo, quando o modo é `external`. */
	readonly externalRouterProviderId?: string;
	/** O provedor chamado diretamente, quando o modo é `direct`. */
	readonly directProviderId?: string;
	readonly updatedAt: string;
	readonly configured: boolean;
	/**
	 * De quem é a configuração que esta visão representa (DEV-8.11).
	 *
	 * - `local` — o Core deste processo (modo local);
	 * - `service` — o Core do **serviço** local, consultado por HTTP
	 *   autenticado; é ele que executa o turno no modo conectado;
	 * - `unavailable` — não há Core nem serviço: `reason` diz por quê. Nesta
	 *   situação os outros campos são neutros e **não** representam uma
	 *   configuração real — a interface precisa dizer isso, não desenhá-los
	 *   como se fossem a decisão vigente.
	 */
	readonly source?: 'local' | 'service' | 'unavailable';
	/** Por que não há configuração, quando `source` é `unavailable`. */
	readonly reason?: string;
	/**
	 * O arquivo do roteador existe e não pôde ser lido.
	 *
	 * Ausente = não há problema. Presente = a página diz que há uma
	 * configuração que não pode ser lida, em vez de "nunca configurado".
	 */
	readonly unreadable?: string;
	/**
	 * A configuração veio da cópia de segurança.
	 *
	 * Verdadeiro só quando a leitura usou a cópia **validada** — o arquivo
	 * principal estava ausente ou inválido. Ausente = leitura normal.
	 */
	readonly recoveredFromBackup?: boolean;
}

/** O que a janela envia para mudar o roteador. Ausente = não muda. */
export interface SetRouterConfigInput {
	readonly mode?: 'native' | 'external' | 'direct';
	readonly enabled?: boolean;
	readonly externalRouterProviderId?: string;
	readonly directProviderId?: string;
}

/** O pedido de autorização local, como a página o recebe (DEV-7). */
export interface DevOwnerPromptView {
	readonly id: string;
	readonly kind: 'authorize' | 'configure' | 'recover' | 'run-command';
	readonly title: string;
	readonly detail: string;
	/** Mínimo de caracteres, ao configurar. */
	readonly minLength?: number;
	/**
	 * A pergunta deve oferecer "lembrar neste dispositivo"?
	 *
	 * Verdadeiro só quando o host **oferece** o desbloqueio persistente. A
	 * caixa não aparece para quem não o tem, e a resposta sem a marca não grava
	 * nada.
	 */
	readonly canRemember?: boolean;
	readonly expiresAt: string;
}
/** A resposta ao pedido. A senha só existe aqui, uma vez. */
export type DevOwnerPromptAnswerView =
	| { readonly id: string; readonly kind: 'cancel' }
	| {
			readonly id: string;
			readonly kind: 'password';
			readonly password: string;
			/** Marcou "lembrar neste dispositivo". */
			readonly remember?: boolean;
	  }
	| { readonly id: string; readonly kind: 'configure'; readonly password: string; readonly confirmation: string }
	/**
	 * A aprovação de um comando do `dev_run` (DEV-9.1).
	 *
	 * Sem senha: a pergunta é de leitura — o comando, o diretório e o escopo
	 * já estão na tela. O host aceita esta forma **só** para a pergunta
	 * `run-command`.
	 */
	| { readonly id: string; readonly kind: 'approve' };

/** O resultado de uma ação do painel (aplicar/restaurar), para a página. */export interface DevActionResult {
	/** `done`, `rolled-back`, ... quando aplicou; `ok` nas restaurações. */
	readonly outcome: string;
	/** O texto que o Core produziu — sem conteúdo de arquivo. */
	readonly detail: string;
	/** Arquivos que não foram sobrescritos (restauração). */
	readonly blocked?: readonly string[];
}

/**
 * O API exposed on `window.seshyina` by the preload.
 *
 * Frozen and explicit rather than a forwarded `ipcRenderer`, so the renderer
 * can only do what is listed here. Adding a capability means adding a method
 * here on purpose — it can never happen by accident.
 */
export interface SeshyinaBridge {
	/** Core status. Rejects if main is unreachable or the reply is unusable. */
	getCoreStatus(): Promise<CoreStatus>;
	/**
	 * O estado do serviço local independente (R4A).
	 *
	 * Leitura. Não depende do Core local: quando não há serviço, resolve
	 * `{ state: 'inactive', reason }` em vez de rejeitar — ausência é estado
	 * normal, não erro.
	 */
	getServiceStatus(): Promise<ServiceLinkStatus>;
	/**
	 * O estado de abertura da janela (DEV-4).
	 *
	 * Diz qual conversa abrir (a da operação pendente, ou a última aberta), e o
	 * aviso de geração interrompida. Lido uma vez, ao montar a página.
	 */
	getUiBootState(): Promise<UiBootStateView>;
	/**
	 * Grava qual conversa está aberta e se há um turno em andamento.
	 *
	 * É o que faz a recarga/reinício voltar ao mesmo lugar. Só esses dois
	 * campos são aceitos; qualquer outro recusa a mensagem inteira.
	 */
	setUiSession(input: { readonly conversationId?: string; readonly generating?: boolean }): Promise<void>;
	/**
	 * O estado da área do modo DEV (DEV-6).
	 *
	 * Leitura: repositório, sessão, autorização (sem token), operação e
	 * checkpoints. A página nunca recebe caminho absoluto nem token.
	 */
	getDevState(): Promise<DevPanelState>;
	/**
	 * O histórico das execuções do `dev_run`, mais recente primeiro (DEV-9.1).
	 *
	 * Lido do diário que o host grava: comando, diretório, quando, decisão,
	 * duração, código de saída e motivo. Nunca a saída do comando.
	 */
	getDevRunHistory(): Promise<readonly DevRunHistoryView[]>;
	/**
	 * Ativa o modo DEV.
	 *
	 * A confirmação é a **do host**, nesta janela: o `main` valida que a
	 * chamada veio da janela principal e passa por `DevHost.ownerRequest()`.
	 * Nenhum argumento é aceito.
	 */
	activateDev(): Promise<DevPanelState>;
	/** Encerra o modo DEV: invalida a sessão e retira as ferramentas do agente. */
	deactivateDev(): Promise<DevPanelState>;
	/**
	 * Bloqueia o DEV agora, mantendo o desbloqueio persistente.
	 *
	 * Diferente de `deactivateDev`, que só encerra a sessão: aqui a intenção é
	 * "pare por agora, sem pedir a senha de novo depois".
	 */
	lockDev(): Promise<DevPanelState>;
	/**
	 * Revoga a autorização persistente.
	 *
	 * Encerra a sessão, apaga o recibo e invalida qualquer cópia restaurada. O
	 * próximo desbloqueio pede a senha.
	 */
	revokeDevUnlock(): Promise<DevPanelState>;
	/** Aplica a operação preparada de id conhecido. Só com sessão ativa. */
	applyDevOperation(operationId: string): Promise<DevActionResult>;
	/** Restaura pelo checkpoint, com confirmação explícita na página. */
	restoreDevCheckpoint(checkpointId?: string): Promise<DevActionResult>;
	/** Avisos de mudança: a página relê o estado; o evento não carrega dado. */
	onDevChange(listener: () => void): () => void;
	/**
	 * Configurar a autorização local (DEV-7).
	 *
	 * Sem argumento: a senha é pedida pelo `main`, num prompt do host. A página
	 * nunca recebe a senha de volta nem a envia fora da resposta do prompt.
	 */
	configureDevAuthorization(): Promise<DevPanelState>;
	/** A recuperação: apaga a credencial local; exige confirmação na página. */
	recoverDevAuthorization(): Promise<DevPanelState>;
	/** O prompt de autorização que o host abriu, se houver. */
	onDevOwnerPrompt(listener: (prompt: DevOwnerPromptView) => void): () => void;
	/**
	 * A pergunta aberta agora, ou `null`.
	 *
	 * Existe porque uma janela criada **para** a pergunta pode estar montando
	 * quando o evento sai: sem esta leitura, o evento chega antes do ouvinte
	 * e a pergunta só aparecia ao expirar. Quem desenha consulta isto ao
	 * montar.
	 */
	pendingDevOwnerPrompt(): Promise<DevOwnerPromptView | null>;
	/** Responde ao prompt aberto (a única forma de a senha sair do formulário). */
	answerDevOwnerPrompt(answer: DevOwnerPromptAnswerView): Promise<{ readonly accepted: boolean; readonly reason?: string }>;
	/**
	 * Abre o painel do serviço local no navegador (R4R).
	 *
	 * Só quando o serviço está ativo: o registro dele tem a porta e a
	 * credencial de painel. Sem serviço, recusa em vez de abrir uma página de
	 * erro — em modo local o app **é** o painel.
	 */
	openServicePanel(): Promise<ServicePanelReply>;
	/**
	 * O estado do serviço, sem agir.
	 *
	 * É a leitura que a tela faz ao abrir e depois de cada operação — separada
	 * do ativar/desligar para que a janela possa mostrar o estado antes de
	 * qualquer clique.
	 */
	readServiceControl(): Promise<ServiceControlState>;
	/**
	 * Liga ou desliga o serviço, esperando o desfecho.
	 *
	 * `on` inicia quando não há serviço e **não** duplica um que já exista;
	 * `off` usa o encerramento seguro, que solta a trava e apaga o registro.
	 */
	setServiceRunning(on: boolean): Promise<ServiceControlReply>;
	/**
	 * Encerra o serviço e reabre o app em modo local.
	 *
	 * O modo DEV só existe quando o Core é deste processo; no modo conectado
	 * o Core é do serviço. Este pedido troca de dono da raiz pelo caminho
	 * seguro (encerramento autenticado) e reinicia.
	 */
	restartInLocalMode(): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }>;
	/**
	 * Avisa quando o estado do serviço muda.
	 *
	 * Chega também para mudanças que esta janela não pediu: o serviço iniciado
	 * no arranque, um encerramento feito em outra janela, o processo que morreu.
	 */
	onServiceState(listener: (state: ServiceControlState) => void): () => void;
	/**
	 * O catálogo do serviço local, ou por que ele não veio.
	 *
	 * `ok: false` carrega um código e uma mensagem; nunca uma lista vazia no
	 * lugar de "não há serviço".
	 */
	getServiceCatalog(): Promise<ServiceCatalogReply>;
	/**
	 * Envia uma mensagem ao serviço (R4C).
	 *
	 * Os eventos do turno chegam pelo canal `onChatEvent` já existente, com o
	 * mesmo formato do modo local. Resolve `accepted: false` com o motivo
	 * quando o serviço recusa — não rejeita.
	 */
	sendToService(input: {
		readonly conversationId: string;
		/**
		 * Como o turno escolhe quem responde (DEV-8.10).
		 *
		 * O mesmo vocabulário do chat local. Ausente = comportamento anterior:
		 * o par `providerId`/`model` é obrigatório e é usado como está.
		 */
		readonly providerId: string;
		readonly model: string;
		readonly text: string;
		readonly routing?: TurnRouting;
	}): Promise<{ readonly accepted: boolean; readonly turnId?: string; readonly error?: string }>;
	/** Cancela **um** turno do serviço iniciado por este app. */
	stopServiceTurn(turnId: string): Promise<{ readonly stopped: boolean }>;
	/** Responde a permissão de um turno do serviço. */
	answerServicePermission(input: {
		readonly turnId: string;
		readonly id: string;
		readonly decision: 'allow' | 'deny';
	}): Promise<{ readonly answered: boolean }>;
	/**
	 * As conversas do serviço (R4D).
	 *
	 * `ok: false` traz o motivo; `ok: true` com lista vazia é "não há
	 * conversas", que é um fato diferente.
	 */
	listServiceConversations(): Promise<ServiceConversationsReply>;
	/** Uma conversa e o histórico do serviço, ou por que não abriu. */
	openServiceConversation(conversationId: string): Promise<ServiceConversationReply>;
	/**
	 * Cria uma conversa no serviço (R4E).
	 *
	 * `code: 'unknown'` quando a conexão caiu antes da resposta: a conversa
	 * **pode** ter sido criada, e a interface não pode afirmar nem negar nem
	 * tentar de novo sozinha.
	 */
	createServiceConversation(input: {
		readonly providerId: string;
		readonly title?: string;
	}): Promise<ServiceCreateConversationReply>;
	/** Renomeia uma conversa do serviço (R4F). */
	renameServiceConversation(
		conversationId: string,
		title: string,
	): Promise<ServiceRenameConversationReply>;
	/** Exclui uma conversa do serviço (R4F). */
	deleteServiceConversation(conversationId: string): Promise<ServiceDeleteConversationReply>;
	/**
	 * O estado dos turnos de uma conversa (R4H).
	 *
	 * Só o ciclo de vida; nunca o conteúdo. É o que permite dizer que uma
	 * resposta foi interrompida por uma queda do serviço.
	 */
	listServiceTurnStates(conversationId: string): Promise<ServiceTurnStatesReply>;
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
	 * Promotes an endpoint to a router, or reclassifies it as a provider.
	 *
	 * Only the **role** changes: the key, the address and the enabled state
	 * are untouched. The call is refused when the change would leave the
	 * active mode pointing at something that is no longer a router.
	 */
	setProviderRole(
		providerId: string,
		role: 'router' | 'provider',
	): Promise<ProviderSummary>;
	/**
	 * Enables or disables a connection.
	 *
	 * Only the **state** changes: the address, the role and the key stay as
	 * they are. A disabled endpoint is refused as a destination, with the
	 * reason.
	 */
	setProviderEnabled(providerId: string, enabled: boolean): Promise<ProviderSummary>;
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

	// Model catalog.
	/**
	 * What is known about each model, optionally narrowed to one provider.
	 *
	 * Empty means nothing has been recorded yet, which is not the same as every
	 * model being unknown: the list is of records, and a model with no record is
	 * simply absent from it.
	 */
	listModelCatalog(providerId?: string): Promise<readonly ModelCatalogEntryView[]>;
	/** One record, by the pair that identifies the model. */
	getModelCatalogEntry(key: ModelCatalogKey): Promise<ModelCatalogEntryView | undefined>;
	/** Creates the record, or edits what is declared about an existing one. */
	saveModelCatalogEntry(input: SaveModelCatalogInput): Promise<ModelCatalogEntryView>;
	/**
	 * Forgets one record.
	 *
	 * Returns whether there was one. This touches metadata only: the provider
	 * stays configured and its stored key is untouched, so removing a price
	 * cannot lock the user out of a model they are still using.
	 */
	removeModelCatalogEntry(key: ModelCatalogKey): Promise<boolean>;

	// Budget. Local spending limits and what the ledger says was spent.
	/** Every limit, most specific first. */
	listSpendingLimits(): Promise<readonly SpendingLimitView[]>;
	/** Creates or replaces the limit of one scope. Rejects invalid input. */
	saveSpendingLimit(input: SaveSpendingLimitViewInput): Promise<SpendingLimitView>;
	/** Returns whether a limit was there to remove. */
	removeSpendingLimit(limitId: string): Promise<boolean>;
	/**
	 * What the ledger spent in a window, aggregated.
	 *
	 * The window is the calendar day or month containing `now` (the caller's
	 * clock at the moment of the read), in local time. A cost that cannot be
	 * known is reported as `unknown` with its reasons, never as zero.
	 */
	readBudget(window?: 'day' | 'month'): Promise<BudgetReportView>;
	/**
	 * Previsão do próximo turno para um modelo.
	 *
	 * `unknown` quando falta preço ou histórico de saída — e nesse caso a tela
	 * deve dizer "sem previsão", nunca "custo zero".
	 */
	forecastCall(input: ForecastRequestView): Promise<CallForecastView>;
	/**
	 * Avisos de 80% ativos no período corrente.
	 *
	 * Vazio quando nenhum limite chegou lá, quando o gasto é desconhecido ou
	 * quando não há modelo pago configurado.
	 */
	listBudgetAlerts(): Promise<readonly BudgetAlertView[]>;

	// Provider discovery. What each provider published, and its quotas.
	/** Models a provider published, with the source and validity of each fact. */
	listDiscoveredModels(providerId?: string): Promise<readonly DiscoveredModelView[]>;
	/**
	 * Pergunta ao `/models` do provedor **agora** e registra o que veio
	 * (DEV-8.15). Devolve os ids publicados; não apaga o que já existia.
	 */
	discoverModels(providerId?: string): Promise<{
		readonly models: readonly string[];
		/** Por provedor, quando o `/models` não respondeu (DEV-8.17). */
		readonly failed?: readonly { readonly providerId: string; readonly reason: string }[];
	}>;	/** Rate limits the API reported, each entry carrying its own source. */
	listDiscoveredQuotas(providerId?: string): Promise<readonly DiscoveredQuotaView[]>;
	/** Models callable now, optionally only those with confirmed free access. */
	listUsableModels(options?: { readonly onlyFree?: boolean }): Promise<readonly DiscoveredModelView[]>;

	// Access policy and catalog fusion.
	/** The stored policy and price-source choice. */
	getAccessPolicy(): Promise<AccessPolicyView>;
	/** Changes either switch as a whole; the declared prices are untouched. */
	setAccessPolicy(input: {
		readonly policy?: 'any' | 'free_only' | 'free_preferred';
		readonly priceSource?: 'user' | 'discovered';
		readonly limitsSource?: 'user' | 'discovered';
		readonly capabilitiesSource?: 'user' | 'discovered';
	}): Promise<AccessPolicyView>;
	/** The declared and discovered values side by side, plus the policy verdict. */
	listMergedCatalog(providerId?: string): Promise<{
		readonly policy: AccessPolicyView;
		readonly models: readonly MergedModelView[];
	}>;

	// Router.
	/** The router configuration, as the panel reads it. */
	getRouterConfig(): Promise<RouterConfigView>;
	/** Changes the router configuration. Only what is present changes. */
	setRouterConfig(input: SetRouterConfigInput): Promise<RouterConfigView>;
	/** The routing decisions, newest first, without any conversation content. */
	listDecisionReports(limit?: number): Promise<readonly RoutingDecisionReportView[]>;
	/** The execution history, with the id and date of each execution. */
	listExecutionHistory(limit?: number): Promise<readonly HistoryExecutionView[]>;
	/** Compares two executions, or refuses and says why. */
	compareExecutions(first: string, second: string): Promise<ExecutionComparisonView>;

	/**
	 * Opens the settings window, or focuses it if it is already open.
	 *
	 * Returns whether a window was there to focus. False means one was created —
	 * which is a normal outcome, not a failure, and is why this is a boolean
	 * rather than an error the caller has to handle.
	 */
	openSettings(): Promise<boolean>;

	// Skill evolution.
	/**
	 * Reads the history and reports what looks improvable.
	 *
	 * Changes nothing. It does not file a proposal and does not touch a skill —
	 * it produces a reading of the evidence and returns it, so "analisar" and
	 * "alterar" cannot be the same click.
	 */
	scanSkillHistory(): Promise<SkillScanView>;
	/**
	 * Turns one opportunity the scan found into a stored proposal.
	 *
	 * Separate from the scan because the proposed content is the user's to write
	 * or to ask for: the scan reports a problem, and this records a proposed
	 * answer to it. The proposal arrives `pending` and still needs approval and
	 * activation before anything live changes.
	 */
	proposeSkillImprovement(input: SaveSkillImprovementInput): Promise<SkillProposalView>;
	/**
	 * Proposals awaiting a decision, newest first.
	 *
	 * `status` narrows the list; absent means every proposal. The renderer asks
	 * for `'pending'` to build the review queue and reads the rest for the history.
	 */
	listSkillEvolutionProposals(status?: SkillProposalStatus): Promise<readonly SkillProposalView[]>;
	/** One proposal, with its evidence, rationale and validation criteria. */
	getSkillEvolutionProposal(proposalId: string): Promise<SkillProposalView>;
	/** What is live against what is proposed, field by field. */
	compareSkillEvolutionProposal(proposalId: string): Promise<SkillContentDiffView>;
	/**
	 * Records a yes.
	 *
	 * Changes nothing that is live: activation is a separate call, so a
	 * mis-click on approve cannot rewrite a skill.
	 */
	approveSkillEvolutionProposal(proposalId: string, reason: string): Promise<SkillProposalView>;
	/** Records a no, with the reason kept in the history. */
	rejectSkillEvolutionProposal(proposalId: string, reason: string): Promise<SkillProposalView>;
	/**
	 * Writes an approved proposal to the live skill.
	 *
	 * Rejects unless the proposal is `approved` with a decision recorded, and
	 * archives the current content first so a rollback always has somewhere to go.
	 */
	activateSkillEvolutionProposal(proposalId: string): Promise<SkillEvolutionResultView>;
	/** A skill's archived versions, oldest first. */
	listSkillVersions(skillId: string): Promise<readonly SkillVersionView[]>;
	/** Puts an archived version back. Needs a reason, which is recorded. */
	rollbackSkillVersion(skillId: string, versionId: string, reason: string): Promise<SkillEvolutionResultView>;

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
	/**
	 * Deletes a conversation (R4M).
	 *
	 * Idempotent: `absent` means a concurrent or previous delete already
	 * removed it — the state the caller wanted. `unknown` means the list could
	 * not be confirmed, and callers must treat it as a failure rather than as
	 * "it was already gone".
	 */
	deleteConversation(conversationId: string): Promise<ConversationDeleteOutcome>;
	/**
	 * Marca ou desmarca a conversa como permanente.
	 *
	 * Uma conversa permanente não aparece com lixeira e o store recusa
	 * excluí-la — é onde vive o diálogo de preferências de modelo.
	 */
	pinConversation(conversationId: string, pinned: boolean): Promise<ConversationListItem>;
	/**
	 * O que está gravado hoje como preferência de modelo.
	 *
	 * `undefined` quando nada foi registrado. É o texto que o motor consulta a
	 * cada turno — a tela o mostra para que ninguém precise adivinhar de onde
	 * veio a escolha.
	 */
	readModelGuidance(): Promise<readonly ModelGuidanceEntryView[]>;
	/**
	 * Grava as preferências de modelo a partir do texto que a Evelyn escreveu.
	 *
	 * Resolve `undefined` quando não há onde gravar. O texto é interpretado no
	 * processo principal: a janela não decide o que o motor vai ler.
	 */
	recordModelGuidance(conversationId: string, text: string): Promise<ModelGuidanceView | undefined>;

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
	/**
	 * Subscribes to router configuration changes. Returns an unsubscribe.
	 *
	 * The listener receives the state that was **accepted and recorded**: a
	 * change that was refused never reaches here, because nothing was
	 * recorded.
	 */
	onRouterState(listener: (config: RouterConfigView) => void): Unsubscribe;
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
	const { providerId, conversationId, model, messages, strategy, routing } = value;
	const parsedRouting =
		routing === 'auto' || routing === 'direct' || routing === 'external' ? routing : undefined;

	// DEV-8.9/8.13: no automático quem escolhe o par é o motor e no externo o
	// provedor vem da configuração do roteador — a interface manda vazio nos
	// dois. O modelo continua obrigatório no externo (é o modelo pedido ao
	// roteador). Para um cliente antigo, sem `routing`, o par segue exigido.
	const needsProvider = parsedRouting === undefined || parsedRouting === 'direct';
	const needsModel = parsedRouting === undefined || parsedRouting !== 'auto';

	if (needsProvider && (typeof providerId !== 'string' || providerId.length === 0)) {
		throw new BridgePayloadError('providerId must be a non-empty string');
	}
	// Required, not inferred: with several conversations, guessing which one is
	// meant would put the turn in the wrong transcript.
	if (typeof conversationId !== 'string' || conversationId.length === 0) {
		throw new BridgePayloadError('conversationId must be a non-empty string');
	}
	if (needsModel && (typeof model !== 'string' || model.length === 0)) {
		throw new BridgePayloadError('model must be a non-empty string');
	}
	if (providerId !== undefined && typeof providerId !== 'string') {
		throw new BridgePayloadError('providerId must be a string when present');
	}
	if (model !== undefined && typeof model !== 'string') {
		throw new BridgePayloadError('model must be a string when present');
	}
	if (!Array.isArray(messages)) {
		throw new BridgePayloadError('messages must be an array');
	}

	// `messages: []` is accepted: it means "run the turn again on the
	// persisted transcript without appending a new user message". The renderer
	// uses this for an explicit "Tentar novamente" after a failure, preserving
	// what the user typed.

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

	const parsedStrategy = strategy === 'fallback' ? 'fallback' : 'manual';

	return {
		providerId: typeof providerId === 'string' ? providerId : '',
		conversationId,
		model: typeof model === 'string' ? model : '',
		messages: parsed,
		strategy: parsedStrategy,
		...(parsedRouting !== undefined ? { routing: parsedRouting } : {}),
		// Só `true` liga a tarefa. Um valor de outro tipo é ignorado em vez de
		// recusado: é um campo de comportamento, e recusar o envio inteiro por
		// causa dele custaria a mensagem por um detalhe que tem padrão seguro.
		...(value.task === true ? { task: true } : {}),
	};
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

// ── model catalog ───────────────────────────────────────────────────────────

/** Narrows the pair that identifies one model in the catalog. */
export function parseModelCatalogKey(value: unknown): ModelCatalogKey {
	if (!isObject(value)) {
		throw new BridgePayloadError(`expected a model identity, received ${describe(value)}`);
	}
	const { providerId, modelId } = value;
	if (typeof providerId !== 'string' || providerId.length === 0) {
		throw new BridgePayloadError('a model identity needs a non-empty providerId');
	}
	if (typeof modelId !== 'string' || modelId.length === 0) {
		throw new BridgePayloadError('a model identity needs a non-empty modelId');
	}
	return { providerId, modelId };
}

/**
 * Narrows what the renderer sent as a catalog edit.
 *
 * The empty string is meaningful in two different fields and both meanings are
 * preserved rather than normalized away, because they are different requests:
 * an empty `capabilities` is the user saying the model is good for nothing,
 * while a blank price box is the user saying the price is unknown. Collapsing
 * either one to "field omitted" would make a form that the user filled in
 * correctly do nothing.
 */
export function parseSaveModelCatalogInput(value: unknown): SaveModelCatalogInput {
	if (!isObject(value)) {
		throw new BridgePayloadError(`expected a model catalog entry, received ${describe(value)}`);
	}
	const { providerId, modelId, capabilities, pricing, access, limits, model, notes } = value;

	if (typeof providerId !== 'string' || providerId.length === 0) {
		throw new BridgePayloadError('providerId must be a non-empty string');
	}
	if (typeof modelId !== 'string' || modelId.length === 0) {
		throw new BridgePayloadError('modelId must be a non-empty string');
	}
	if (capabilities !== undefined && typeof capabilities !== 'string') {
		throw new BridgePayloadError('capabilities must be a string when present');
	}
	if (access !== undefined && !isModelAccess(access)) {
		throw new BridgePayloadError(`access must be free, paid or unknown — received ${describe(access)}`);
	}
	if (notes !== undefined && notes !== null && typeof notes !== 'string') {
		throw new BridgePayloadError('notes must be a string or null when present');
	}

	return {
		providerId,
		modelId,
		...(capabilities !== undefined ? { capabilities } : {}),
		...(pricing !== undefined
			? { pricing: pricing === null ? null : parseModelPricingView(pricing) }
			: {}),
		...(access !== undefined ? { access } : {}),
		...(limits !== undefined
			? { limits: limits === null ? null : parseModelLimitsView(limits) }
			: {}),
		...(model !== undefined
			? { model: model === null ? null : parseModelCapabilitiesPatchView(model) }
			: {}),
		...(notes !== undefined ? { notes } : {}),
	};
}

/**
 * Lê o patch de capacidades.
 *
 * Cada campo é três estados: `true`, `false` ou ausente. Um valor que não é
 * um dos três recusa a entrada inteira, em vez de virar "desconhecido" — um
 * campo que a ponte não entendeu não pode ser gravado como se fosse uma
 * afirmação do usuário.
 */
function parseModelCapabilitiesPatchView(value: unknown): ModelCapabilitiesPatchView {
	if (!isObject(value)) {
		throw new BridgePayloadError(`expected a capability patch, received ${describe(value)}`);
	}
	const read = (name: string): boolean | null | undefined => {
		const raw = value[name];
		if (raw === undefined) {
			return undefined;
		}
		if (raw === null || typeof raw === 'boolean') {
			return raw;
		}
		throw new BridgePayloadError(`${name} must be a boolean or null — received ${describe(raw)}`);
	};
	const toolCalling = read('toolCalling');
	const structuredOutput = read('structuredOutput');
	const reasoning = read('reasoning');
	return {
		...(toolCalling !== undefined ? { toolCalling } : {}),
		...(structuredOutput !== undefined ? { structuredOutput } : {}),
		...(reasoning !== undefined ? { reasoning } : {}),
	};
}

function parseModelPricingView(value: unknown): ModelPricingView {
	if (!isObject(value)) {
		throw new BridgePayloadError(`expected a price, received ${describe(value)}`);
	}
	const { currency, unit, input, output } = value;
	if (typeof currency !== 'string' || currency.trim().length === 0) {
		throw new BridgePayloadError('a price needs a currency');
	}
	if (!isCostUnit(unit)) {
		throw new BridgePayloadError(`price unit must be per_1k_tokens or per_1m_tokens — received ${describe(unit)}`);
	}
	// The numbers stay strings. The form is text, and converting here would mean
	// the bridge decided what `""` means; a blank box is "unknown" and a `0` is
	// a real free price, and only the Core can tell them apart once it is a
	// number.
	if (input !== undefined && typeof input !== 'string') {
		throw new BridgePayloadError('price input must be a string when present');
	}
	if (output !== undefined && typeof output !== 'string') {
		throw new BridgePayloadError('price output must be a string when present');
	}
	return {
		currency: currency.trim(),
		unit,
		...(input !== undefined ? { input } : {}),
		...(output !== undefined ? { output } : {}),
	};
}

function parseModelLimitsView(value: unknown): ModelLimitsView {
	if (!isObject(value)) {
		throw new BridgePayloadError(`expected limits, received ${describe(value)}`);
	}
	const { contextTokens, maxOutputTokens } = value;
	if (contextTokens !== undefined && typeof contextTokens !== 'string') {
		throw new BridgePayloadError('contextTokens must be a string when present');
	}
	if (maxOutputTokens !== undefined && typeof maxOutputTokens !== 'string') {
		throw new BridgePayloadError('maxOutputTokens must be a string when present');
	}
	return {
		...(contextTokens !== undefined ? { contextTokens } : {}),
		...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
	};
}

// ── budget ─────────────────────────────────────────────────────────────────

/**
 * Um limite, como o renderer vê.
 *
 * `currency`, `amount` e `window` são os mesmos valores do Core; apenas os
 * campos de escopo viram `undefined`/ausentes quando o limite é global.
 */
export interface SpendingLimitView {
	readonly limitId: string;
	/** Blank when the limit is global. */
	readonly providerId: string;
	/** Blank when the limit covers a whole provider, or everything. */
	readonly modelId: string;
	readonly currency: string;
	readonly amount: number;
	readonly window: 'day' | 'month';
	readonly scope: 'global' | 'provider' | 'policy' | 'model';
	/** A política a que o limite se restringe. Vazio = vale para todas. */
	readonly policy: 'any' | 'free_only' | 'free_preferred';
	readonly createdAt: string;
	readonly updatedAt: string;
}

/** O que o renderer envia para criar ou trocar um limite. */
export interface SaveSpendingLimitViewInput {
	readonly providerId?: string;
	readonly modelId?: string;
	/**
	 * A política a que o limite se restringe.
	 *
	 * Ausente ou `any` = vale para todas. Com `free_only`, o limite só se
	 * aplica quando essa política está em vigor.
	 */
	readonly policy?: 'any' | 'free_only' | 'free_preferred';
	readonly currency: string;
	/** Text of the amount box. Blank means "clear", and is refused. */
	readonly amount: string;
	readonly window: 'day' | 'month';
}

/**
 * O consumo de um período, agregado.
 *
 * `cost` é um custo de catálogo calculado sobre os tokens que os provedores
 * publicaram — uma estimativa, nunca a fatura. `unknown` quando alguma
 * execução do período não pôde ser precificada; `reasons` diz por quê.
 *
 * As partes internas do custo (`parts`) não atravessam: o renderer mostra um
 * total ou o motivo de não haver um, e uma parte por tentativa seria um detalhe
 * que nenhuma tela desta etapa desenha.
 */
export interface BudgetUsageView {
	readonly executions: number;
	readonly attempts: number;
	readonly tokens?: { readonly input?: number; readonly output?: number };
	readonly cost:
		| {
				readonly status: 'estimated';
				readonly currency: string;
				readonly total: number;
		  }
		| {
				readonly status: 'unknown';
				readonly reasons: readonly string[];
		  };
	readonly executionsWithoutCost: number;
}

/** Um recorte do período. */
export interface BudgetSliceView extends BudgetUsageView {
	readonly providerId: string;
	readonly modelId?: string;
	readonly executionId?: string;
	readonly conversationId?: string;
	readonly turnId?: string;
}

/** O consumo de um turno, como a tela o lista. */
export interface TurnUsageView extends BudgetUsageView {
	readonly turnId: string;
	readonly firstStartedAt: string;
	readonly lastStartedAt?: string;
	readonly providerIds: readonly string[];
	readonly modelIds: readonly string[];
}

/**
 * O consumo de uma conversa, registrado e — quando há como — previsto.
 *
 * `recorded` é o que o ledger gravou; `forecast` é a previsão do próximo
 * turno. São campos separados porque são coisas diferentes: um é estimativa
 * de catálogo sobre números publicados, o outro é uma suposição sobre o
 * futuro. Nenhuma soma os junta.
 */
export interface ConversationUsageView extends BudgetUsageView {
	readonly conversationId: string;
	/** Título da conversa, quando ela ainda existe. */
	readonly title?: string;
	readonly turns: readonly TurnUsageView[];
	readonly forecast?: CallForecastView;
}

/** Um dos lados da faixa prevista. */
export interface ForecastRangeView {
	readonly low: number;
	readonly high: number;
}

/**
 * A previsão de uma chamada.
 *
 * `status: 'estimated'` é sempre uma previsão: preço do catálogo sobre uma
 * contagem aproximada de tokens. `unknown` carrega os motivos e **nunca** um
 * total zero — um zero ali diria "vai sair de graça".
 */
export interface CallForecastView {
	readonly providerId: string;
	readonly modelId: string;
	readonly access: 'free' | 'paid' | 'unknown';
	readonly cost:
		| {
				readonly status: 'estimated';
				readonly currency: string;
				readonly unit: 'per_1k_tokens' | 'per_1m_tokens';
				readonly input: number;
				readonly output: number;
				readonly total: number;
				readonly range?: ForecastRangeView;
		  }
		| {
				readonly status: 'unknown';
				readonly reasons: readonly string[];
		  };
	readonly inputTokens: number;
	readonly outputTokens?: number;
	readonly inputBasis: 'conversation' | 'model' | 'none';
	readonly outputBasis: 'conversation' | 'model' | 'none';
	readonly samples: number;
	readonly confidence: 'high' | 'low' | 'unknown';
	readonly truncated: boolean;
}

/** O aviso de 80% de um limite. */
export interface BudgetAlertView {
	readonly limitId: string;
	readonly scope: 'global' | 'provider' | 'policy' | 'model';
	readonly window: 'day' | 'month';
	readonly currency: string;
	readonly amount: number;
	readonly spent: number;
	/** Fração gasta, de 0 a 1 ou mais. */
	readonly fraction: number;
	readonly message: string;
}

/** O que o renderer pede para prever: modelo, texto do turno e conversa. */
export interface ForecastRequestView {
	readonly providerId: string;
	readonly modelId: string;
	readonly promptText: string;
	readonly conversationId?: string;
}

/** A resposta de `readBudget`. */
export interface BudgetReportView {
	readonly period: { readonly since: string; readonly until: string; readonly window: 'day' | 'month' };
	readonly total: BudgetUsageView;
	readonly byProvider: readonly BudgetSliceView[];
	readonly byModel: readonly BudgetSliceView[];
	readonly byExecution: readonly BudgetSliceView[];
	/** Conversas com consumo no período, mais recente primeiro. */
	readonly byConversation: readonly ConversationUsageView[];
	readonly limits: readonly SpendingLimitView[];
	/** Avisos de 80% ativos neste período, um por condição. */
	readonly alerts: readonly BudgetAlertView[];
}

// ── model catalog (parser) ─────────────────────────────────────────────────

/** Narrows one catalog record the main process sent. */
export function parseModelCatalogEntryView(value: unknown): ModelCatalogEntryView {
	if (!isObject(value)) {
		throw new BridgePayloadError(`expected a catalog entry, received ${describe(value)}`);
	}
	const {
		providerId,
		modelId,
		capabilities,
		pricing,
		access,
		limits,
		model,
		notes,
		observations,
		medianFirstByteMs,
		medianTotalMs,
		updatedAt,
	} = value;

	if (typeof providerId !== 'string' || providerId.length === 0) {
		throw new BridgePayloadError('a catalog entry needs a non-empty providerId');
	}
	if (typeof modelId !== 'string' || modelId.length === 0) {
		throw new BridgePayloadError('a catalog entry needs a non-empty modelId');
	}
	if (typeof capabilities !== 'string') {
		throw new BridgePayloadError('catalog capabilities must be a string');
	}
	if (!isModelAccess(access)) {
		throw new BridgePayloadError(`unknown access ${JSON.stringify(access)}`);
	}
	if (typeof observations !== 'number' || !Number.isFinite(observations) || observations < 0) {
		throw new BridgePayloadError('observations must be a non-negative count');
	}
	if (typeof updatedAt !== 'string' || updatedAt.length === 0) {
		throw new BridgePayloadError('a catalog entry needs a non-empty updatedAt');
	}
	// Narrowed once, in a function, so the return below carries the checked type.
	// A loop over a tuple array does not narrow the destructured names it was
	// handed, and the whole point of checking is that the value is a number here.
	const firstByte = optionalNonNegativeNumber(medianFirstByteMs, 'medianFirstByteMs');
	const total = optionalNonNegativeNumber(medianTotalMs, 'medianTotalMs');

	return {
		providerId,
		modelId,
		capabilities,
		...(pricing !== undefined ? { pricing: parseModelPricingView(pricing) } : {}),
		access,
		...(limits !== undefined ? { limits: parseModelLimitsView(limits) } : {}),
		...(model !== undefined ? { model: parseModelCapabilityView(model) } : {}),
		...(typeof notes === 'string' ? { notes } : {}),
		observations,
		...(firstByte !== undefined ? { medianFirstByteMs: firstByte } : {}),
		...(total !== undefined ? { medianTotalMs: total } : {}),
		updatedAt,
	};
}

/**
 * A matriz de capacidades declarada, três estados por campo.
 *
 * Um campo ausente continua ausente: "ninguém sabe" e "não tem" são
 * afirmações diferentes, e a que o seletor usa é a segunda.
 */
function parseModelCapabilityView(value: unknown): ModelCapabilityView {
	if (!isObject(value)) {
		throw new BridgePayloadError(`expected a capability matrix, received ${describe(value)}`);
	}
	const read = (name: string): boolean | undefined => {
		const raw = value[name];
		if (raw === undefined) {
			return undefined;
		}
		if (typeof raw !== 'boolean') {
			throw new BridgePayloadError(`${name} must be a boolean when present`);
		}
		return raw;
	};
	const toolCalling = read('toolCalling');
	const structuredOutput = read('structuredOutput');
	const reasoning = read('reasoning');
	return {
		...(toolCalling !== undefined ? { toolCalling } : {}),
		...(structuredOutput !== undefined ? { structuredOutput } : {}),
		...(reasoning !== undefined ? { reasoning } : {}),
	};
}

function isNonNegativeNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function optionalNonNegativeNumber(value: unknown, field: string): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!isNonNegativeNumber(value)) {
		throw new BridgePayloadError(`${field} must be a non-negative number when present`);
	}
	return value;
}

/**
 * Narrows a list of catalog records.
 *
 * Individual entries are dropped rather than failing the list, for the reason
 * `parseAvailableModels` drops a malformed model: the point of the call is to
 * draw a list, and one unreadable record must not cost the user the rest.
 */
export function parseModelCatalogEntryViews(value: unknown): readonly ModelCatalogEntryView[] {
	if (!Array.isArray(value)) {
		throw new BridgePayloadError(`expected an array, received ${describe(value)}`);
	}
	const entries: ModelCatalogEntryView[] = [];
	for (const item of value) {
		try {
			entries.push(parseModelCatalogEntryView(item));
		} catch {
			continue;
		}
	}
	return entries;
}

function isModelAccess(value: unknown): value is ModelAccess {
	return value === 'free' || value === 'paid' || value === 'unknown';
}

function isCostUnit(value: unknown): value is CostUnit {
	return value === 'per_1k_tokens' || value === 'per_1m_tokens';
}

// ── budget ────────────────────────────────────────────────────────────────

/** A window the renderer may ask for. Anything else is refused. */
export function parseBudgetWindow(value: unknown): 'day' | 'month' {
	if (value === undefined || value === null || value === 'month') {
		return 'month';
	}
	if (value === 'day') {
		return 'day';
	}
	throw new BridgePayloadError(`budget window must be day or month - received ${describe(value)}`);
}

/** Narrows what the renderer sent as a limit edit. */
export function parseSaveSpendingLimitViewInput(value: unknown): SaveSpendingLimitViewInput {
	if (!isObject(value)) {
		throw new BridgePayloadError(`expected a spending limit, received ${describe(value)}`);
	}
	const { providerId, modelId, policy, currency, amount, window } = value;
	if (providerId !== undefined && (typeof providerId !== 'string' || providerId.length === 0)) {
		throw new BridgePayloadError('providerId must be a non-empty string when present');
	}
	if (modelId !== undefined && (typeof modelId !== 'string' || modelId.length === 0)) {
		throw new BridgePayloadError('modelId must be a non-empty string when present');
	}
	if (
		policy !== undefined &&
		policy !== 'any' &&
		policy !== 'free_only' &&
		policy !== 'free_preferred'
	) {
		throw new BridgePayloadError('a spending limit policy must be any, free_only or free_preferred');
	}
	if (typeof currency !== 'string' || currency.trim().length === 0) {
		throw new BridgePayloadError('a spending limit needs a currency');
	}
	// Kept as text, like the price boxes: the bridge does not decide what `''`
	// means. A blank amount is refused by the Core with its own message; a `0`
	// is a real limit.
	if (typeof amount !== 'string') {
		throw new BridgePayloadError('a spending limit amount must be a string');
	}
	if (window !== 'day' && window !== 'month') {
		throw new BridgePayloadError('a spending limit window must be day or month');
	}
	return {
		...(providerId !== undefined && providerId.length > 0 ? { providerId } : {}),
		...(modelId !== undefined && modelId.length > 0 ? { modelId } : {}),
		...(policy !== undefined ? { policy } : {}),
		currency: currency.trim(),
		amount,
		window,
	};
}

/** Narrows a limit id the renderer sent. */
export function parseSpendingLimitId(value: unknown): string {
	if (typeof value !== 'string' || value.length === 0) {
		throw new BridgePayloadError(`expected a spending limit id, received ${describe(value)}`);
	}
	return value;
}

function parseBudgetUsageView(value: unknown): BudgetUsageView {
	if (!isObject(value)) {
		throw new BridgePayloadError(`expected budget usage, received ${describe(value)}`);
	}
	const { executions, attempts, tokens, cost, executionsWithoutCost } = value;
	if (typeof executions !== 'number' || !Number.isInteger(executions) || executions < 0) {
		throw new BridgePayloadError('budget usage needs a non-negative executions count');
	}
	if (typeof attempts !== 'number' || !Number.isInteger(attempts) || attempts < 0) {
		throw new BridgePayloadError('budget usage needs a non-negative attempts count');
	}
	if (
		typeof executionsWithoutCost !== 'number' ||
		!Number.isInteger(executionsWithoutCost) ||
		executionsWithoutCost < 0
	) {
		throw new BridgePayloadError('budget usage needs a non-negative executionsWithoutCost');
	}
	let tokenView: BudgetUsageView['tokens'];
	if (tokens !== undefined) {
		if (!isObject(tokens)) {
			throw new BridgePayloadError('budget tokens must be an object when present');
		}
		const input = tokens.input;
		const output = tokens.output;
		if (input !== undefined && (typeof input !== 'number' || !Number.isFinite(input) || input < 0)) {
			throw new BridgePayloadError('budget token input must be a non-negative number');
		}
		if (output !== undefined && (typeof output !== 'number' || !Number.isFinite(output) || output < 0)) {
			throw new BridgePayloadError('budget token output must be a non-negative number');
		}
		tokenView = {
			...(input !== undefined ? { input } : {}),
			...(output !== undefined ? { output } : {}),
		};
	}
	if (!isObject(cost)) {
		throw new BridgePayloadError('budget usage needs a cost object');
	}
	let costView: BudgetUsageView['cost'];
	if (cost.status === 'estimated') {
		if (typeof cost.total !== 'number' || !Number.isFinite(cost.total) || cost.total < 0) {
			throw new BridgePayloadError('an estimated cost needs a non-negative total');
		}
		if (typeof cost.currency !== 'string' || cost.currency.length === 0) {
			throw new BridgePayloadError('an estimated cost needs a currency');
		}
		costView = { status: 'estimated', currency: cost.currency, total: cost.total };
	} else if (cost.status === 'unknown') {
		const reasons = Array.isArray(cost.reasons)
			? cost.reasons.filter((reason): reason is string => typeof reason === 'string')
			: [];
		costView = { status: 'unknown', reasons };
	} else {
		throw new BridgePayloadError(`a budget cost must be estimated or unknown - received ${describe(cost.status)}`);
	}
	return {
		executions,
		attempts,
		...(tokenView !== undefined ? { tokens: tokenView } : {}),
		cost: costView,
		executionsWithoutCost,
	};
}

function parseBudgetSliceView(value: unknown): BudgetSliceView {
	if (!isObject(value)) {
		throw new BridgePayloadError(`expected a budget slice, received ${describe(value)}`);
	}
	if (typeof value.providerId !== 'string') {
		throw new BridgePayloadError('a budget slice needs a providerId');
	}
	return {
		providerId: value.providerId,
		...(typeof value.modelId === 'string' ? { modelId: value.modelId } : {}),
		...(typeof value.executionId === 'string' ? { executionId: value.executionId } : {}),
		...(typeof value.conversationId === 'string' ? { conversationId: value.conversationId } : {}),
		...(typeof value.turnId === 'string' ? { turnId: value.turnId } : {}),
		...parseBudgetUsageView(value),
	};
}

export function parseForecastView(value: unknown): CallForecastView {
	if (!isObject(value)) {
		throw new BridgePayloadError(`expected a forecast, received ${describe(value)}`);
	}
	if (typeof value.providerId !== 'string' || typeof value.modelId !== 'string') {
		throw new BridgePayloadError('a forecast needs string providerId and modelId');
	}
	if (value.access !== 'free' && value.access !== 'paid' && value.access !== 'unknown') {
		throw new BridgePayloadError('a forecast needs an access of free, paid or unknown');
	}
	if (typeof value.inputTokens !== 'number' || !Number.isFinite(value.inputTokens) || value.inputTokens < 0) {
		throw new BridgePayloadError('a forecast needs a non-negative inputTokens');
	}
	if (
		value.outputTokens !== undefined &&
		(typeof value.outputTokens !== 'number' || !Number.isFinite(value.outputTokens) || value.outputTokens < 0)
	) {
		throw new BridgePayloadError('a forecast outputTokens must be a non-negative number');
	}
	if (!isObject(value.cost)) {
		throw new BridgePayloadError('a forecast needs a cost object');
	}
	let cost: CallForecastView['cost'];
	if (value.cost.status === 'estimated') {
		const amounts = ['input', 'output', 'total'] as const;
		for (const field of amounts) {
			const amount = value.cost[field];
			if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
				throw new BridgePayloadError(`an estimated forecast needs a non-negative ${field}`);
			}
		}
		if (!isCostUnit(value.cost.unit)) {
			throw new BridgePayloadError('an estimated forecast needs a cost unit');
		}
		if (typeof value.cost.currency !== 'string') {
			throw new BridgePayloadError('an estimated forecast needs a currency');
		}
		const range = value.cost.range;
		let rangeView: ForecastRangeView | undefined;
		if (range !== undefined) {
			if (
				!isObject(range) ||
				typeof range.low !== 'number' ||
				typeof range.high !== 'number' ||
				!Number.isFinite(range.low) ||
				!Number.isFinite(range.high)
			) {
				throw new BridgePayloadError('a forecast range needs finite low and high');
			}
			rangeView = { low: range.low, high: range.high };
		}
		cost = {
			status: 'estimated',
			currency: value.cost.currency,
			unit: value.cost.unit,
			input: value.cost.input as number,
			output: value.cost.output as number,
			total: value.cost.total as number,
			...(rangeView !== undefined ? { range: rangeView } : {}),
		};
	} else if (value.cost.status === 'unknown') {
		const reasons = Array.isArray(value.cost.reasons)
			? value.cost.reasons.filter((reason): reason is string => typeof reason === 'string')
			: [];
		cost = { status: 'unknown', reasons };
	} else {
		throw new BridgePayloadError(`a forecast cost must be estimated or unknown - received ${describe(value.cost.status)}`);
	}
	const basis = (raw: unknown): 'conversation' | 'model' | 'none' => {
		if (raw === 'conversation' || raw === 'model' || raw === 'none') {
			return raw;
		}
		throw new BridgePayloadError('a forecast basis must be conversation, model or none');
	};
	if (value.confidence !== 'high' && value.confidence !== 'low' && value.confidence !== 'unknown') {
		throw new BridgePayloadError('a forecast confidence must be high, low or unknown');
	}
	if (typeof value.samples !== 'number' || !Number.isInteger(value.samples) || value.samples < 0) {
		throw new BridgePayloadError('a forecast needs a non-negative samples count');
	}
	if (typeof value.truncated !== 'boolean') {
		throw new BridgePayloadError('a forecast needs a boolean truncated flag');
	}
	return {
		providerId: value.providerId,
		modelId: value.modelId,
		access: value.access,
		cost,
		inputTokens: value.inputTokens,
		...(typeof value.outputTokens === 'number' ? { outputTokens: value.outputTokens } : {}),
		inputBasis: basis(value.inputBasis),
		outputBasis: basis(value.outputBasis),
		samples: value.samples,
		confidence: value.confidence,
		truncated: value.truncated,
	};
}

function parseTurnUsageView(value: unknown): TurnUsageView {
	if (!isObject(value) || typeof value.turnId !== 'string' || typeof value.firstStartedAt !== 'string') {
		throw new BridgePayloadError('a turn usage needs a turnId and firstStartedAt');
	}
	const strings = (raw: unknown): readonly string[] =>
		Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === 'string') : [];
	return {
		turnId: value.turnId,
		firstStartedAt: value.firstStartedAt,
		...(typeof value.lastStartedAt === 'string' ? { lastStartedAt: value.lastStartedAt } : {}),
		providerIds: strings(value.providerIds),
		modelIds: strings(value.modelIds),
		...parseBudgetUsageView(value),
	};
}

function parseConversationUsageView(value: unknown): ConversationUsageView {
	if (!isObject(value) || typeof value.conversationId !== 'string') {
		throw new BridgePayloadError('a conversation usage needs a conversationId');
	}
	if (!Array.isArray(value.turns)) {
		throw new BridgePayloadError('a conversation usage needs a turns array');
	}
	return {
		conversationId: value.conversationId,
		...(typeof value.title === 'string' ? { title: value.title } : {}),
		turns: value.turns.map(parseTurnUsageView),
		...(value.forecast !== undefined ? { forecast: parseForecastView(value.forecast) } : {}),
		...parseBudgetUsageView(value),
	};
}

function parseAlertView(value: unknown): BudgetAlertView {
	if (!isObject(value)) {
		throw new BridgePayloadError(`expected a budget alert, received ${describe(value)}`);
	}
	if (typeof value.limitId !== 'string' || typeof value.message !== 'string') {
		throw new BridgePayloadError('a budget alert needs a limitId and a message');
	}
	if (value.scope !== 'global' && value.scope !== 'provider' && value.scope !== 'model') {
		throw new BridgePayloadError('a budget alert needs a scope');
	}
	if (value.window !== 'day' && value.window !== 'month') {
		throw new BridgePayloadError('a budget alert needs a window');
	}
	if (
		typeof value.amount !== 'number' ||
		typeof value.spent !== 'number' ||
		typeof value.fraction !== 'number' ||
		typeof value.currency !== 'string'
	) {
		throw new BridgePayloadError('a budget alert needs amount, spent, fraction and currency');
	}
	return {
		limitId: value.limitId,
		scope: value.scope,
		window: value.window,
		currency: value.currency,
		amount: value.amount,
		spent: value.spent,
		fraction: value.fraction,
		message: value.message,
	};
}

/** Narrows the alert list the main process sent. */
export function parseBudgetAlertViews(value: unknown): readonly BudgetAlertView[] {
	if (!Array.isArray(value)) {
		throw new BridgePayloadError(`expected an array, received ${describe(value)}`);
	}
	const alerts: BudgetAlertView[] = [];
	for (const item of value) {
		try {
			alerts.push(parseAlertView(item));
		} catch {
			continue;
		}
	}
	return alerts;
}

/** Narrows what the renderer asked to forecast. */
export function parseForecastRequestView(value: unknown): ForecastRequestView {
	if (!isObject(value)) {
		throw new BridgePayloadError(`expected a forecast request, received ${describe(value)}`);
	}
	const { providerId, modelId, promptText, conversationId } = value;
	if (typeof providerId !== 'string' || providerId.length === 0) {
		throw new BridgePayloadError('a forecast request needs a non-empty providerId');
	}
	if (typeof modelId !== 'string' || modelId.length === 0) {
		throw new BridgePayloadError('a forecast request needs a non-empty modelId');
	}
	if (typeof promptText !== 'string') {
		throw new BridgePayloadError('a forecast request needs string promptText');
	}
	if (conversationId !== undefined && (typeof conversationId !== 'string' || conversationId.length === 0)) {
		throw new BridgePayloadError('conversationId must be a non-empty string when present');
	}
	return {
		providerId,
		modelId,
		promptText,
		...(conversationId !== undefined ? { conversationId } : {}),
	};
}

function parseSpendingLimitView(value: unknown): SpendingLimitView {
	if (!isObject(value)) {
		throw new BridgePayloadError(`expected a spending limit, received ${describe(value)}`);
	}
	const { limitId, providerId, modelId, currency, amount, window, scope, policy, createdAt, updatedAt } = value;
	if (typeof limitId !== 'string' || limitId.length === 0) {
		throw new BridgePayloadError('a spending limit needs a non-empty limitId');
	}
	if (typeof providerId !== 'string' || typeof modelId !== 'string') {
		throw new BridgePayloadError('a spending limit needs string providerId and modelId scopes');
	}
	if (typeof currency !== 'string' || currency.length === 0) {
		throw new BridgePayloadError('a spending limit needs a currency');
	}
	if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
		throw new BridgePayloadError('a spending limit needs a non-negative amount');
	}
	if (window !== 'day' && window !== 'month') {
		throw new BridgePayloadError('a spending limit window must be day or month');
	}
	if (scope !== 'global' && scope !== 'provider' && scope !== 'policy' && scope !== 'model') {
		throw new BridgePayloadError('a spending limit needs a global, provider, policy or model scope');
	}
	if (policy !== undefined && policy !== 'any' && policy !== 'free_only' && policy !== 'free_preferred') {
		throw new BridgePayloadError('a spending limit policy must be any, free_only or free_preferred');
	}
	if (typeof createdAt !== 'string' || typeof updatedAt !== 'string') {
		throw new BridgePayloadError('a spending limit needs string timestamps');
	}
	return {
		limitId,
		providerId,
		modelId,
		currency,
		amount,
		window,
		scope,
		policy: policy ?? 'any',
		createdAt,
		updatedAt,
	};
}

/** Narrows the limit list the main process sent. */
export function parseSpendingLimitViews(value: unknown): readonly SpendingLimitView[] {
	if (!Array.isArray(value)) {
		throw new BridgePayloadError(`expected an array, received ${describe(value)}`);
	}
	const limits: SpendingLimitView[] = [];
	for (const item of value) {
		try {
			limits.push(parseSpendingLimitView(item));
		} catch {
			continue;
		}
	}
	return limits;
}

/** Narrows the budget report the main process sent. */
export function parseBudgetReportView(value: unknown): BudgetReportView {
	if (!isObject(value)) {
		throw new BridgePayloadError(`expected a budget report, received ${describe(value)}`);
	}
	const { period, total, byProvider, byModel, byExecution, limits } = value;
	if (!isObject(period)) {
		throw new BridgePayloadError('a budget report needs a period');
	}
	if (typeof period.since !== 'string' || typeof period.until !== 'string') {
		throw new BridgePayloadError('a budget period needs since and until');
	}
	if (period.window !== 'day' && period.window !== 'month') {
		throw new BridgePayloadError('a budget period needs a day or month window');
	}
	const listOf = (items: unknown, field: string): readonly BudgetSliceView[] => {
		if (!Array.isArray(items)) {
			throw new BridgePayloadError(`a budget report needs a ${field} array`);
		}
		return items.map(parseBudgetSliceView);
	};
	return {
		period: { since: period.since, until: period.until, window: period.window },
		total: parseBudgetUsageView(total),
		byProvider: listOf(byProvider, 'byProvider'),
		byModel: listOf(byModel, 'byModel'),
		byExecution: listOf(byExecution, 'byExecution'),
		// Older reports and reports from a host without conversations simply
		// have no conversations to show; an empty list is the honest reading.
		byConversation: Array.isArray(value.byConversation)
			? value.byConversation.map(parseConversationUsageView)
			: [],
		limits: parseSpendingLimitViews(limits),
		alerts: Array.isArray(value.alerts) ? parseBudgetAlertViews(value.alerts) : [],
	};
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
	// R4B: o modo do Core. Opcional para não quebrar um payload antigo de
	// teste/versão; ausente = `local`, que era o único modo antes.
	const mode = value['mode'] ?? 'local';
	if (mode !== 'local' && mode !== 'connected' && mode !== 'unavailable') {
		throw new BridgePayloadError('mode must be local, connected or unavailable');
	}

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
	// R4B: o caminho de dados é exigido só no modo local. Nos outros, vazio é
	// a resposta correta: o app não conhece (nem precisa conhecer) a pasta que
	// outro processo usa. Exigir um caminho aqui empurraria o app para
	// adivinhar ou para receber o do serviço — nenhum dos dois é necessário.
	if (mode === 'local' && (typeof dataDirectory !== 'string' || dataDirectory.length === 0)) {
		throw new BridgePayloadError('dataDirectory must be a non-empty string');
	}
	if (mode !== 'local' && typeof dataDirectory !== 'string') {
		throw new BridgePayloadError('dataDirectory must be a string');
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
		dataDirectory: dataDirectory as string,
		mode,
	};
}

/** Narrows an unknown value into a `ProviderSummary`. */
export function parseProviderSummary(value: unknown): ProviderSummary {
	if (!isObject(value)) {
		throw new BridgePayloadError(`expected a provider object, received ${describe(value)}`);
	}
	const { id, name, baseUrl, status, hasApiKeyRef, models, role } = value;

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
	// O papel é opcional e tem um vocabulário curto. Um valor fora dele é
	// recusado: ele mudaria a forma de falar com o endpoint, e adivinhar é
	// pior do que recusar.
	if (role !== undefined && role !== 'router' && role !== 'provider') {
		throw new BridgePayloadError(`unknown provider role ${JSON.stringify(role)}`);
	}

	return {
		id,
		name,
		baseUrl,
		status,
		hasApiKeyRef,
		// Copied for the same reason as `services` above.
		models: [...(models as string[])],
		...(role !== undefined ? { role } : {}),
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
	const { id, title, providerId, projectId, createdAt, updatedAt, messageCount } = value;	if (typeof id !== 'string' || id.length === 0) {
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
		// Só `true` atravessa. Um valor de outro tipo vindo de um Core antigo ou
		// adulterado não pode marcar uma conversa como permanente.
		...(value.pinned === true ? { pinned: true } : {}),
		createdAt,
		updatedAt,
		messageCount,
	};
}

/** A narrowing read of what the guidance dialogue produced. */
export interface ModelGuidanceView {
	readonly conversationId: string;
	readonly updatedAt: string;
	readonly entries: readonly {
		readonly model: string;
		readonly tools?: boolean;
		readonly reasoning?: boolean;
		readonly longContext?: boolean;
		readonly value?: number;
		readonly useFor?: string;
	}[];
	/** As linhas que não seguiram o formato, com o motivo. */
	readonly rejected: readonly { readonly line: string; readonly reason: string }[];
}

/**
 * Narrows the reply of the main process into a `ModelGuidanceView`.
 *
 * `undefined` when the session has no store to write to — a legitimate answer,
 * not an error: it means the guidance simply was not recorded.
 */
export function parseModelGuidance(value: unknown): ModelGuidanceView | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (!isObject(value)) {
		throw new BridgePayloadError(`expected the model guidance, received ${describe(value)}`);
	}
	const { conversationId, updatedAt, entries, rejected } = value;
	if (typeof conversationId !== 'string' || typeof updatedAt !== 'string') {
		throw new BridgePayloadError('the model guidance needs a conversation id and a date');
	}
	const parsedEntries = (Array.isArray(entries) ? entries : []).flatMap((entry) => {
		if (!isObject(entry) || typeof entry.model !== 'string' || entry.model.length === 0) {
			return [];
		}
		return [
			{
				model: entry.model,
				...(typeof entry.tools === 'boolean' ? { tools: entry.tools } : {}),
				...(typeof entry.reasoning === 'boolean' ? { reasoning: entry.reasoning } : {}),
				...(typeof entry.longContext === 'boolean' ? { longContext: entry.longContext } : {}),
				...(typeof entry.value === 'number' && entry.value >= 0 && entry.value <= 1
					? { value: entry.value }
					: {}),
				...(typeof entry.useFor === 'string' && entry.useFor.length > 0
					? { useFor: entry.useFor }
					: {}),
			},
		];
	});
	return {
		conversationId,
		updatedAt,
		entries: parsedEntries,
		rejected: (Array.isArray(rejected) ? rejected : []).flatMap((entry) =>
			isObject(entry) && typeof entry.line === 'string' && typeof entry.reason === 'string'
				? [{ line: entry.line, reason: entry.reason }]
				: [],
		),
	};
}

/**
 * O prompt do diálogo onde a Evelyn registra as preferências de modelo.
 *
 * Fica no contrato porque **dois hosts** criam o diálogo — a janela local e o
 * serviço — e os dois precisam mandar exatamente o mesmo formato. Duas cópias
 * divergiriam no primeiro ajuste, e o motor leria um formato que ninguém pediu.
 *
 * O formato vai junto de propósito: a leitura da resposta é por regra, e uma
 * resposta em prosa só viraria preferência se outro modelo a interpretasse —
 * o que reintroduziria a escolha que essas preferências existem para tirar da
 * mesa.
 */
export const MODEL_GUIDANCE_DIALOGUE_PROMPT = [
	'Você é a Evelyn. Este diálogo é o registro permanente das suas preferências de modelo.',
	'Aqui você lista os modelos que existem hoje, para que serve cada um, e o seu',
	'custo-benefício — custo comparado ao que ele entrega. A decisão de qual modelo',
	'responde cada turno do app é sua, e é este texto que ela consulta.',
	'',
	'Antes de responder, leia o catálogo dos modelos disponíveis (nome, preço e',
	'capacidades, quando houver). Não invente qualidade, preço nem capacidade de um',
	'modelo: o que você não sabe, fica de fora.',
	'',
	'Responda com a lista no formato abaixo, e depois, se quiser, um parágrafo curto',
	'de por quê — o parágrafo não entra na decisão, só a lista.',
	'',
	'Uma linha por modelo, exatamente neste formato:',
	'- <modelo> | tools: sim/nao | reasoning: sim/nao | contexto-longo: sim/nao | valor: 0.0-1.0 | uso: <uma frase>',
	'',
	'Regras:',
	'- O nome do modelo é o mesmo que aparece na lista de modelos.',
	'- Um campo que você não sabe fica de fora; "?" também serve. Não invente.',
	'- `valor` é custo-benefício, de 0 (caro e fraco) a 1 (barato e forte).',
	'- Só use nomes de modelos que existem na lista. Inventar um nome o deixa sem efeito.',
].join('\n');

/**
 * The field-by-field narrowing of one guidance entry list.
 *
 * Shared by the reply of a turn and by the list in the bridge signature so the
 * two cannot disagree about what a valid entry is.
 */
export type ModelGuidanceEntryView = ModelGuidanceView['entries'][number];

/** Narrows one guidance entry list, dropping what it cannot read. */

export function parseGuidanceEntries(value: unknown): ModelGuidanceView['entries'] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.flatMap((entry) => {
		if (!isObject(entry) || typeof entry.model !== 'string' || entry.model.length === 0) {
			return [];
		}
		return [
			{
				model: entry.model,
				...(typeof entry.tools === 'boolean' ? { tools: entry.tools } : {}),
				...(typeof entry.reasoning === 'boolean' ? { reasoning: entry.reasoning } : {}),
				...(typeof entry.longContext === 'boolean' ? { longContext: entry.longContext } : {}),
				...(typeof entry.value === 'number' && entry.value >= 0 && entry.value <= 1
					? { value: entry.value }
					: {}),
				...(typeof entry.useFor === 'string' && entry.useFor.length > 0
					? { useFor: entry.useFor }
					: {}),
			},
		];
	});
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

/**
 * O `routing` de um evento `started` (DEV-8.9).
 *
 * Só os três valores conhecidos atravessam. Um modo desconhecido é descartado
 * em vez de virar uma afirmação inventada sobre quem decidiu o turno.
 */
function parseStartedRouting(value: Record<string, unknown>): {
	readonly mode: TurnRouting;
	readonly providerId?: string;
	readonly model?: string;
} | undefined {
	const mode = value['mode'];
	if (mode !== 'auto' && mode !== 'direct' && mode !== 'external') {
		return undefined;
	}
	const providerId = value['providerId'];
	const model = value['model'];
	return {
		mode,
		...(typeof providerId === 'string' && providerId.length > 0 ? { providerId } : {}),
		...(typeof model === 'string' && model.length > 0 ? { model } : {}),
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
			return {
				type,
				turnId,
				...(isObject(value.routing) ? { routing: parseStartedRouting(value.routing) } : {}),
			};
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
			// Checked against the three literals rather than passed through. This is
			// the field the orchestrator decides on, so an invented value must not
			// become a fourth kind of abort that nothing downstream knows about.
			if (value.abortCause !== undefined && !isAbortCause(value.abortCause)) {
				throw new BridgePayloadError(
					`unknown abortCause ${JSON.stringify(value.abortCause)}`,
				);
			}
			return {
				type,
				turnId,
				message: value.message,
				...(value.abortCause !== undefined ? { abortCause: value.abortCause } : {}),
			};
		case 'skillsLoaded': {
			if (!Array.isArray(value.skillIds)) {
				throw new BridgePayloadError('a skillsLoaded event needs a skillIds array');
			}
			for (const id of value.skillIds) {
				if (typeof id !== 'string' || id.length === 0) {
					throw new BridgePayloadError('each skill ID must be a non-empty string');
				}
			}
			const missing = Array.isArray(value.missing)
				? value.missing.filter((m): m is string => typeof m === 'string' && m.length > 0)
				: undefined;
			return {
				type,
				turnId,
				skillIds: value.skillIds as string[],
				...(missing !== undefined && missing.length > 0 ? { missing } : {}),
			};
		}
		case 'budgetBlocked': {
			if (typeof value.providerId !== 'string' || value.providerId.length === 0) {
				throw new BridgePayloadError('a budgetBlocked event needs a non-empty providerId');
			}
			if (typeof value.modelId !== 'string' || value.modelId.length === 0) {
				throw new BridgePayloadError('a budgetBlocked event needs a non-empty modelId');
			}
			if (
				typeof value.attempt !== 'number' ||
				!Number.isInteger(value.attempt) ||
				value.attempt < 1
			) {
				throw new BridgePayloadError('a budgetBlocked event needs a positive attempt number');
			}
			// Not dropped for being empty: a block the renderer never sees is a
			// paid model that silently did not run. The renderer has a fallback.
			if (typeof value.message !== 'string') {
				throw new BridgePayloadError('a budgetBlocked event needs a message');
			}
			return {
				type,
				turnId,
				providerId: value.providerId,
				modelId: value.modelId,
				attempt: value.attempt,
				message: value.message,
			};
		}
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

// ── skill evolution: narrowing what crosses the bridge ───────────────────────

/**
 * Narrows what main sent as a proposal.
 *
 * The skill *content* is inside this payload, and it is written by whatever
 * produced the proposal — in practice, a model. So it is narrowed, not cast: an
 * unexpected shape becomes an error the UI can show rather than a proposal card
 * with holes in it that somebody then approves.
 */
export function parseSkillProposalView(value: unknown): SkillProposalView {
	if (!isObject(value)) {
		throw new BridgePayloadError(`expected a skill proposal, received ${describe(value)}`);
	}
	const {
		id, status, skillId, createsNewSkill, problem, currentVersion, currentInstructions,
		proposedVersion, proposed, rationale, evidence,
		expectedBenefits, risks, untestedCases, validationCriteria,
		strength, createdAt, decision,
	} = value;

	if (typeof id !== 'string' || id.length === 0) {
		throw new BridgePayloadError('a skill proposal needs a non-empty id');
	}
	if (!isSkillProposalStatus(status)) {
		throw new BridgePayloadError(`unknown proposal status ${describe(status)}`);
	}
	if (typeof createsNewSkill !== 'boolean') {
		throw new BridgePayloadError('createsNewSkill must be a boolean');
	}
	if (typeof problem !== 'string' || typeof rationale !== 'string') {
		throw new BridgePayloadError('problem and rationale must be strings');
	}
	if (typeof currentInstructions !== 'string') {
		throw new BridgePayloadError('currentInstructions must be a string');
	}
	if (typeof currentVersion !== 'string' || typeof proposedVersion !== 'string') {
		throw new BridgePayloadError('currentVersion and proposedVersion must be strings');
	}
	if (typeof createdAt !== 'string' || createdAt.length === 0) {
		throw new BridgePayloadError('a skill proposal needs a non-empty createdAt');
	}
	if (!isSkillOpportunityStrength(strength)) {
		throw new BridgePayloadError(`unknown strength ${describe(strength)}`);
	}

	return {
		id,
		status,
		...(typeof skillId === 'string' && skillId.length > 0 ? { skillId } : {}),
		createsNewSkill,
		problem,
		currentVersion,
		currentInstructions,
		proposedVersion,
		proposed: parseProposedSkillContentView(proposed),
		rationale,
		evidence: parseProposalEvidenceView(evidence),
		expectedBenefits: parseStringArray(expectedBenefits, 'expectedBenefits'),
		risks: parseStringArray(risks, 'risks'),
		untestedCases: parseStringArray(untestedCases, 'untestedCases'),
		validationCriteria: parseValidationCriteria(validationCriteria),
		strength,
		createdAt,
		...(decision === undefined ? {} : { decision: parseProposalDecisionView(decision) }),
	};
}

/** Narrows a list of proposals, dropping the unreadable ones. */
export function parseSkillProposalViews(value: unknown): readonly SkillProposalView[] {
	if (!Array.isArray(value)) {
		throw new BridgePayloadError(`expected an array, received ${describe(value)}`);
	}
	const proposals: SkillProposalView[] = [];
	for (const entry of value) {
		try {
			proposals.push(parseSkillProposalView(entry));
		} catch {
			// One malformed proposal must not empty the review queue: the remaining
			// ones are still decisions the user is owed a chance to make.
			continue;
		}
	}
	return proposals;
}

function parseProposedSkillContentView(value: unknown): ProposedSkillContentView {
	if (!isObject(value)) {
		throw new BridgePayloadError(`expected proposed skill content, received ${describe(value)}`);
	}
	const { title, description, instructions, tags, requiredTools, riskLevel, constraints } = value;
	if (typeof title !== 'string' || typeof description !== 'string' || typeof instructions !== 'string') {
		throw new BridgePayloadError('proposed content needs string title, description and instructions');
	}
	if (riskLevel !== 'safe' && riskLevel !== 'moderate' && riskLevel !== 'dangerous') {
		throw new BridgePayloadError(`unknown proposed riskLevel ${describe(riskLevel)}`);
	}
	return {
		title,
		description,
		instructions,
		tags: parseStringArray(tags, 'tags'),
		requiredTools: parseStringArray(requiredTools, 'requiredTools'),
		riskLevel,
		constraints: parseStringArray(constraints, 'constraints'),
	};
}

function parseProposalEvidenceView(value: unknown): SkillProposalView['evidence'] {
	if (!isObject(value)) {
		throw new BridgePayloadError('proposal evidence must be an object');
	}
	const { sampleSize, supportingRuns, domains } = value;
	if (typeof sampleSize !== 'number' || !Number.isFinite(sampleSize) || sampleSize < 0) {
		throw new BridgePayloadError('evidence sampleSize must be a non-negative number');
	}
	return {
		sampleSize,
		supportingRuns: parseStringArray(supportingRuns, 'supportingRuns'),
		domains: parseStringArray(domains, 'domains'),
	};
}

function parseProposalDecisionView(value: unknown): NonNullable<SkillProposalView['decision']> {
	if (!isObject(value)) {
		throw new BridgePayloadError('a proposal decision must be an object');
	}
	const { decidedBy, reason, decidedAt } = value;
	if (typeof decidedBy !== 'string' || decidedBy.length === 0) {
		throw new BridgePayloadError('a decision needs a non-empty decidedBy');
	}
	if (typeof reason !== 'string' || typeof decidedAt !== 'string') {
		throw new BridgePayloadError('a decision needs string reason and decidedAt');
	}
	return { decidedBy, reason, decidedAt };
}

function parseValidationCriteria(value: unknown): readonly SkillValidationCriterionView[] {
	if (!Array.isArray(value)) {
		throw new BridgePayloadError('validationCriteria must be an array');
	}
	return value.map((entry) => {
		if (!isObject(entry)) {
			throw new BridgePayloadError('each validation criterion must be an object');
		}
		const { id, description, observableAs } = entry;
		if (typeof id !== 'string' || typeof description !== 'string' || typeof observableAs !== 'string') {
			throw new BridgePayloadError('a validation criterion needs id, description and observableAs');
		}
		return { id, description, observableAs };
	});
}

/** Narrows what main sent as a content diff. */
export function parseSkillContentDiffView(value: unknown): SkillContentDiffView {
	if (!isObject(value)) {
		throw new BridgePayloadError(`expected a skill content diff, received ${describe(value)}`);
	}
	const { fieldsChanged, instructionsChanged, currentLength, proposedLength, instructionsDiff, identical } = value;
	if (typeof instructionsChanged !== 'boolean' || typeof identical !== 'boolean') {
		throw new BridgePayloadError('a diff needs boolean instructionsChanged and identical');
	}
	if (typeof currentLength !== 'number' || typeof proposedLength !== 'number') {
		throw new BridgePayloadError('a diff needs numeric lengths');
	}
	return {
		fieldsChanged: parseStringArray(fieldsChanged, 'fieldsChanged'),
		instructionsChanged,
		currentLength,
		proposedLength,
		instructionsDiff: parseStringArray(instructionsDiff, 'instructionsDiff'),
		identical,
	};
}

/** Narrows what main sent as a list of archived versions. */
export function parseSkillVersionViews(value: unknown): readonly SkillVersionView[] {
	if (!Array.isArray(value)) {
		throw new BridgePayloadError(`expected an array, received ${describe(value)}`);
	}
	return value.map((entry) => {
		if (!isObject(entry)) {
			throw new BridgePayloadError('each version must be an object');
		}
		const { versionId, skillId, version, content, archivedAt, reason, proposalId } = entry;
		if (typeof versionId !== 'string' || typeof skillId !== 'string' || typeof version !== 'string') {
			throw new BridgePayloadError('a version needs versionId, skillId and version');
		}
		if (typeof archivedAt !== 'string' || archivedAt.length === 0) {
			throw new BridgePayloadError('a version needs a non-empty archivedAt');
		}
		if (reason !== 'initial' && reason !== 'activation' && reason !== 'rollback') {
			throw new BridgePayloadError(`unknown version reason ${describe(reason)}`);
		}
		return {
			versionId,
			skillId,
			version,
			content: parseProposedSkillContentView(content),
			archivedAt,
			reason,
			...(typeof proposalId === 'string' ? { proposalId } : {}),
		};
	});
}

/** Narrows what main sent as an activation or rollback outcome. */
export function parseSkillEvolutionResultView(value: unknown): SkillEvolutionResultView {
	if (!isObject(value)) {
		throw new BridgePayloadError(`expected a skill evolution result, received ${describe(value)}`);
	}
	const { ok, error, skillId, version, instructionsLength } = value;
	if (typeof ok !== 'boolean') {
		throw new BridgePayloadError('a skill evolution result needs a boolean ok');
	}
	return {
		ok,
		...(typeof error === 'string' ? { error } : {}),
		...(typeof skillId === 'string' ? { skillId } : {}),
		...(typeof version === 'string' ? { version } : {}),
		...(typeof instructionsLength === 'number' ? { instructionsLength } : {}),
	};
}

/** Where a measurement came from. Never "estimated by feel". */
export type MeasurementKind = 'measured' | 'derived' | 'unknown';

/** One quantity with its provenance. An absent value is `unknown`, never `0`. */
export interface MeasurementView {
	readonly kind: MeasurementKind;
	readonly value?: number;
	/** Where it came from. Always present, so `unknown` always says why. */
	readonly note: string;
}

/** What one improvable thing in the history looks like. */
export interface SkillOpportunityView {
	readonly fingerprint: string;
	readonly kind: string;
	readonly skillId?: string;
	readonly title: string;
	readonly problem: string;
	readonly strength: SkillOpportunityStrength;
	readonly sampleSize: number;
	readonly supportingRuns: readonly string[];
	readonly domains: readonly string[];
	readonly untestedCases: readonly string[];
	readonly generalizesBeyondSample: boolean;
}

/** What was observed about one model. Carries no score and names no winner. */
export interface ModelObservationView {
	readonly providerId: string;
	readonly modelId: string;
	readonly key: string;
	readonly runs: number;
	readonly verifiedPasses: number;
	readonly verifiedFailures: number;
	/** Runs that verified nothing. Counted, never scored. */
	readonly unverifiedRuns: number;
	readonly medianDurationMs: MeasurementView;
	readonly tokensUsed: MeasurementView;
	readonly hasMeasurements: boolean;
	/** False whenever the sample cannot support a comparison. */
	readonly canCompare: boolean;
	/** What this record does and does not support saying. */
	readonly caveat: string;
}

/** The outcome of reading the history. */
export interface SkillScanView {
	readonly ok: boolean;
	readonly runsRead: number;
	/** Runs that can be counted as evidence. */
	readonly usableRuns: number;
	/** Runs read but not counted, because nothing was verified. */
	readonly unverifiedRuns: number;
	readonly skipped: readonly { readonly refId: string; readonly reason: string }[];
	readonly errors: readonly string[];
	readonly opportunities: readonly SkillOpportunityView[];
	readonly modelObservations: readonly ModelObservationView[];
	/** One line saying what the scan did and did not find. */
	readonly summary: string;
	readonly error?: string;
}

/** Narrows what main sent as a scan result. */
export /**
 * Narrows a count that must be a non-negative finite number.
 *
 * A named function rather than an inline check, because a loop over a tuple array
 * does not narrow the destructured names it was handed — and the whole point of
 * checking is that the value is a number where the type says so.
 */
function requireNonNegativeNumber(value: unknown, field: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
		throw new BridgePayloadError(`${field} must be a non-negative number`);
	}
	return value;
}

/** Narrows what main sent as a scan result. */
export function parseSkillScanView(value: unknown): SkillScanView {
	if (!isObject(value)) {
		throw new BridgePayloadError(`expected a skill scan result, received ${describe(value)}`);
	}
	const {
		ok, runsRead, usableRuns, unverifiedRuns,
		skipped, errors, opportunities, modelObservations, summary, error,
	} = value;

	if (typeof ok !== 'boolean') {
		throw new BridgePayloadError('a scan result needs a boolean ok');
	}
	const read = requireNonNegativeNumber(runsRead, 'runsRead');
	const usable = requireNonNegativeNumber(usableRuns, 'usableRuns');
	const unverified = requireNonNegativeNumber(unverifiedRuns, 'unverifiedRuns');
	if (typeof summary !== 'string') {
		throw new BridgePayloadError('a scan result needs a string summary');
	}

	return {
		ok,
		runsRead: read,
		usableRuns: usable,
		unverifiedRuns: unverified,
		skipped: parseSkippedRuns(skipped),
		errors: parseStringArray(errors, 'errors'),
		opportunities: parseSkillOpportunityViews(opportunities),
		modelObservations: parseModelObservationViews(modelObservations),
		summary,
		...(typeof error === 'string' ? { error } : {}),
	};
}

function parseSkippedRuns(value: unknown): readonly { refId: string; reason: string }[] {
	if (!Array.isArray(value)) {
		throw new BridgePayloadError('skipped must be an array');
	}
	return value.map((entry) => {
		if (!isObject(entry)) {
			throw new BridgePayloadError('each skipped run must be an object');
		}
		const { refId, reason } = entry;
		if (typeof refId !== 'string' || typeof reason !== 'string') {
			throw new BridgePayloadError('a skipped run needs refId and reason');
		}
		return { refId, reason };
	});
}

function parseSkillOpportunityViews(value: unknown): readonly SkillOpportunityView[] {
	if (!Array.isArray(value)) {
		throw new BridgePayloadError('opportunities must be an array');
	}
	return value.map((entry) => {
		if (!isObject(entry)) {
			throw new BridgePayloadError('each opportunity must be an object');
		}
		const {
			fingerprint, kind, skillId, title, problem, strength,
			sampleSize, supportingRuns, domains, untestedCases, generalizesBeyondSample,
		} = entry;
		if (typeof fingerprint !== 'string' || typeof kind !== 'string' || typeof title !== 'string') {
			throw new BridgePayloadError('an opportunity needs fingerprint, kind and title');
		}
		if (typeof problem !== 'string') {
			throw new BridgePayloadError('an opportunity needs a problem statement');
		}
		if (!isSkillOpportunityStrength(strength)) {
			throw new BridgePayloadError(`unknown strength ${describe(strength)}`);
		}
		if (typeof sampleSize !== 'number' || !Number.isFinite(sampleSize) || sampleSize < 0) {
			throw new BridgePayloadError('sampleSize must be a non-negative number');
		}
		if (typeof generalizesBeyondSample !== 'boolean') {
			throw new BridgePayloadError('generalizesBeyondSample must be a boolean');
		}
		return {
			fingerprint,
			kind,
			...(typeof skillId === 'string' && skillId.length > 0 ? { skillId } : {}),
			title,
			problem,
			strength,
			sampleSize,
			supportingRuns: requireStringArray(supportingRuns, 'supportingRuns'),
			domains: requireStringArray(domains, 'domains'),
			untestedCases: parseStringArray(untestedCases, 'untestedCases'),
			generalizesBeyondSample,
		};
	});
}

function parseModelObservationViews(value: unknown): readonly ModelObservationView[] {
	if (!Array.isArray(value)) {
		throw new BridgePayloadError('modelObservations must be an array');
	}
	return value.map((entry) => {
		if (!isObject(entry)) {
			throw new BridgePayloadError('each model observation must be an object');
		}
		const {
			providerId, modelId, key, runs,
			verifiedPasses, verifiedFailures, unverifiedRuns,
			medianDurationMs, tokensUsed, hasMeasurements, canCompare, caveat,
		} = entry;
		if (typeof providerId !== 'string' || typeof modelId !== 'string' || typeof key !== 'string') {
			throw new BridgePayloadError('a model observation needs providerId, modelId and key');
		}
		const totalRuns = requireNonNegativeNumber(runs, 'runs');
		const passes = requireNonNegativeNumber(verifiedPasses, 'verifiedPasses');
		const failures = requireNonNegativeNumber(verifiedFailures, 'verifiedFailures');
		const unverified = requireNonNegativeNumber(unverifiedRuns, 'unverifiedRuns');
		if (typeof hasMeasurements !== 'boolean' || typeof canCompare !== 'boolean') {
			throw new BridgePayloadError('a model observation needs boolean hasMeasurements and canCompare');
		}
		if (typeof caveat !== 'string' || caveat.length === 0) {
			// Required, not optional: an observation without a stated limitation is
			// the thing this shape exists to prevent.
			throw new BridgePayloadError('a model observation must carry a caveat');
		}
		return {
			providerId,
			modelId,
			key,
			runs: totalRuns,
			verifiedPasses: passes,
			verifiedFailures: failures,
			unverifiedRuns: unverified,
			medianDurationMs: parseMeasurementView(medianDurationMs, 'medianDurationMs'),
			tokensUsed: parseMeasurementView(tokensUsed, 'tokensUsed'),
			hasMeasurements,
			canCompare,
			caveat,
		};
	});
}

/** Narrows a measurement, requiring the note that explains an absence. */
function parseMeasurementView(value: unknown, field: string): MeasurementView {
	if (!isObject(value)) {
		throw new BridgePayloadError(`${field} must be an object`);
	}
	const { kind, value: amount, note } = value;
	if (kind !== 'measured' && kind !== 'derived' && kind !== 'unknown') {
		throw new BridgePayloadError(`${field} has an unknown kind ${describe(kind)}`);
	}
	if (typeof note !== 'string' || note.length === 0) {
		throw new BridgePayloadError(`${field} needs a note saying where it came from`);
	}
	if (amount !== undefined && (typeof amount !== 'number' || !Number.isFinite(amount))) {
		throw new BridgePayloadError(`${field} value must be a finite number when present`);
	}
	return {
		kind,
		...(amount !== undefined ? { value: amount } : {}),
		note,
	};
}

/** Narrows a proposal status the renderer sent. */
export function parseSkillProposalStatus(value: unknown): SkillProposalStatus {
	if (!isSkillProposalStatus(value)) {
		throw new BridgePayloadError(`unknown proposal status ${JSON.stringify(value)}`);
	}
	return value;
}

/**
 * Narrows what the renderer sent to file a proposal.
 *
 * Narrowed here because this payload becomes a stored proposal that a person
 * will later approve — so a malformed field has to be a refusal at the boundary
 * rather than a hole in a record somebody reads as a decision.
 */
export function parseSaveSkillImprovementInput(value: unknown): SaveSkillImprovementInput {
	if (!isObject(value)) {
		throw new BridgePayloadError(`expected a skill improvement, received ${describe(value)}`);
	}
	const {
		fingerprint, skillId, title, description, instructions, proposedVersion,
		tags, requiredTools, riskLevel, constraints,
		expectedBenefits, risks, validationCriteria,
	} = value;

	if (typeof fingerprint !== 'string' || fingerprint.length === 0) {
		throw new BridgePayloadError('an improvement needs a non-empty fingerprint');
	}
	if (typeof title !== 'string' || typeof description !== 'string') {
		throw new BridgePayloadError('an improvement needs a title and a description');
	}
	// Checked here as well as in the Core, so an empty proposal never reaches
	// storage to be found invalid later by whoever opens the queue.
	if (typeof instructions !== 'string' || instructions.trim().length === 0) {
		throw new BridgePayloadError('an improvement needs non-empty instructions');
	}
	if (riskLevel !== 'safe' && riskLevel !== 'moderate' && riskLevel !== 'dangerous') {
		throw new BridgePayloadError(`unknown riskLevel ${describe(riskLevel)}`);
	}
	if (proposedVersion !== undefined && typeof proposedVersion !== 'string') {
		throw new BridgePayloadError('proposedVersion must be a string when present');
	}
	if (skillId !== undefined && (typeof skillId !== 'string' || skillId.length === 0)) {
		throw new BridgePayloadError('skillId must be a non-empty string when present');
	}

	return {
		fingerprint,
		...(typeof skillId === 'string' ? { skillId } : {}),
		title,
		description,
		instructions,
		...(typeof proposedVersion === 'string' ? { proposedVersion } : {}),
		tags: parseStringArray(tags, 'tags'),
		requiredTools: parseStringArray(requiredTools, 'requiredTools'),
		riskLevel,
		constraints: parseStringArray(constraints, 'constraints'),
		expectedBenefits: parseStringArray(expectedBenefits, 'expectedBenefits'),
		risks: parseStringArray(risks, 'risks'),
		validationCriteria: parseValidationCriteria(validationCriteria),
	};
}

/** Narrows a proposal id the renderer sent. */
export function parseSkillProposalId(value: unknown): string {
	if (typeof value !== 'string' || value.length === 0) {
		throw new BridgePayloadError('a proposal id must be a non-empty string');
	}
	return value;
}

/**
 * Narrows the reason a renderer sent with an approval, a rejection or a rollback.
 *
 * Required and non-blank, because a decision with no stated reason is not one
 * anybody can audit later — and these decisions end up changing the live skill.
 */
export function parseDecisionReason(value: unknown): string {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new BridgePayloadError('a decision needs a non-empty reason');
	}
	return value.trim();
}

/** Narrows the identity a rollback names: which skill, which version. */
export function parseRollbackTarget(value: unknown): { skillId: string; versionId: string } {
	if (!isObject(value)) {
		throw new BridgePayloadError(`expected a rollback target, received ${describe(value)}`);
	}
	const { skillId, versionId } = value;
	if (typeof skillId !== 'string' || skillId.length === 0) {
		throw new BridgePayloadError('a rollback needs a non-empty skillId');
	}
	if (typeof versionId !== 'string' || versionId.length === 0) {
		throw new BridgePayloadError('a rollback needs a non-empty versionId');
	}
	return { skillId, versionId };
}

function parseStringArray(value: unknown, field: string): readonly string[] {
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
		throw new BridgePayloadError(`${field} must be an array of strings`);
	}
	// Copied, so a later mutation of what main sent cannot change a value the
	// renderer already validated.
	return [...(value as string[])];
}

/**
 * Like `parseStringArray`, but the field has to be there.
 *
 * For the evidence a claim rests on. An opportunity whose `supportingRuns` is
 * absent is a claim nobody can check, and defaulting it to `[]` would turn a
 * malformed payload into a proposal card that looks traceable and is not. The
 * fields where absence genuinely means "none" — a skill with no tags — keep the
 * lenient version.
 */
function requireStringArray(value: unknown, field: string): readonly string[] {
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
		throw new BridgePayloadError(`${field} must be an array of strings`);
	}
	return [...(value as string[])];
}

function isSkillProposalStatus(value: unknown): value is SkillProposalStatus {
	return (
		value === 'pending' ||
		value === 'approved' ||
		value === 'rejected' ||
		value === 'activated' ||
		value === 'reverted'
	);
}

function isSkillOpportunityStrength(value: unknown): value is SkillOpportunityStrength {
	return value === 'observation' || value === 'hypothesis' || value === 'sustained-pattern';
}

function isAbortCause(value: unknown): value is AbortCause {
	return value === 'first-token' || value === 'total-time' || value === 'user-stop';
}
