/**
 * The chat session: providers, model discovery and one streaming turn.
 *
 * Everything here is host-free. It imports the Core, the local adapters and the
 * shared contract — no `electron` — so the whole conversation flow is testable
 * under plain mocha with a fake `fetch` and no window. `main.ts` is left with
 * nothing but IPC wiring.
 *
 * Reused from the Core rather than reinvented:
 *
 * - `OpenAICompatibleProvider` for the connection, including SSE streaming and
 *   the key lookup through the `SecretStore`.
 * - `ProviderConfigService` for persistence, so a configured provider survives a
 *   restart exactly as it does in the extension.
 * - `FileDataStore` for the transcript, so a conversation survives a restart and
 *   is fed back as context on the next turn.
 * - `ConversationRuntime` is deliberately *not* used: it exists to drive tools
 *   through the permission gateway, and this stage implements neither. The
 *   `ChatStream` is consumed directly, which is the same primitive it wraps.
 *
 * ## Secrets
 *
 * A key arrives here from the renderer once, goes straight into the
 * `SecretStore`, and is never returned. What the renderer reads back is a
 * boolean: whether a *reference* exists. No method below returns key material,
 * and no error message carries one.
 */
import { randomUUID } from 'node:crypto';
import { ProviderConfigService, type PersistedProviderConfig } from '../core/providers/config';
import {
	OpenAICompatibleProvider,
	type FetchLike,
} from '../core/providers/openaiCompatible';
import { providerApiKeyRef, type SecretStore } from '../core/providers/secrets';
import { LoggingService } from '../core/logging';
import { basename, resolve } from 'node:path';
import { ConversationRuntime } from '../core/agent/runtime';
import type { ChatProvider, ToolCallRequest } from '../core/providers/chat/types';
import {
	CircuitBreaker,
	RoutedChatProvider,
	type RouteAttempt,
	type RoutePolicy,
	type RouteSleep,
	type RouteTarget,
	type RoutingClock,
	type RoutingMetricsPort,
	type RoutingObserver,
} from '../core/providers/routing';
import { createCatalogMetricsPort } from './routingMetrics';
import { createBudgetGate, type SessionBudgetGate } from './budgetGate';
import { createProviderDiscovery, type ProviderDiscovery } from './providerDiscovery';
import { createObservingProvider } from './observingProvider';
import {
	toDiscoveredModelView,
	toQuotaView,
	type DiscoveredModelView,
	type DiscoveredQuotaView,
} from './discoveryView';
import type { DiscoveredModel } from '../core/storage/types/providerModels';
import type { ModelInfo } from '../core/providers/types';
import {
	DEFAULT_ACCESS_POLICY,
	describeNoEligibleModel,
	evaluatePolicy,
	orderByPolicy,
	type FreeEvidence,
	type ModelAccessPolicy,
	type ModelAccessPolicyRecord,
	type PolicyCandidate,
} from '../core/catalog/policy';
import { comparePrices } from '../core/catalog/merge';
import { fuseCatalog, type DiscoveredMetadata } from '../core/catalog/metadata';
import { applyPolicyPhrase } from './policyPhrase';
import {
	resolveRouterPlan,
	resolveTurnModePlan,
	singleTargetPlan,
	type RouterPlan,
	type RouterProviderLookupResult,
	type TurnMode,
} from './routerPlan';
import {
	DEFAULT_ROUTER_CONFIG,
	type RouterConfig,
	type RouterMode,
} from '../core/providers/routing/config';
import { buildDecisionReport, type BudgetObservation, type QuotaObservation, type ReportCandidate } from './buildDecisionReport';
import {
	compareExecutions,
	type ComparisonOutcome,
	type HistoryExecution,
} from './compareExecutions';
import type { ReportPrice, ReportProvenance, RoutingDecisionReport } from './decisionReport';
import {
	toMergedModelView,
	type AccessPolicyView,
	type MergedModelView,
	type MergedPriceView,
} from './catalogFusion';
import { createQuotaTracker, type QuotaTracker } from '../core/providers/quota';
import {
	aggregateUsage,
	scopeOf,
	usageByChat,
	windowRange,
	type BudgetAlert,
	type CallForecast,
	type ConversationUsage,
	type TurnUsage,
	type UsageSlice,
	type UsageTotal,
} from '../core/budget';
import {
	createConsumptionRecorder,
	type ConsumptionRecorder,
} from './consumptionRecorder';
import type { ExecutionStatus } from '../core/storage/types/consumption';
import { summarizeExecution, type AttemptRecord } from '../core/storage/types/consumption';
import {
	createModelDiscovery,
	type ModelDiscovery,
	type ModelDiscoveryOptions,
	type ModelListSource,
} from '../core/providers/discovery';
import { createMvpAgentStack } from '../core/agent/composition';
import { defaultCommandRunner } from '../core/agent/mvpTools';
import { coordinateCommandRunner } from '../core/dev/devLocks';
import { createDevToolEntries, type DevToolDeps } from '../core/agent/devTools';
import type { ToolRegistry } from '../core/agent/toolRegistry';
import type { MemoryService } from '../core/memory/types';
import type { SkillService, SkillDiscoveryService } from '../core/skill/types';
import { createSkillDiscoveryService } from '../core/skill/skillDiscovery';
import {
	createRiskGateway,
	type PermissionGateway,
	type PermissionRequest,
} from '../core/permissions/gateway';
import { PermissionBroker, type DecisionReport } from './permissionBroker';
import { runAgentTurn, type AgentEventSink } from './agentTurn';
import { addRecorders, type RecordingTool } from './toolRecorder';
import {
	toAppendInputs,
	type ConversationMessage,
	type ConversationRecord,
} from '../core/storage/types/dataStore';
import type {
	ModelCapabilities,
	ModelCatalogEntry,
	ModelCatalogKey as CatalogKey,
	ModelObservation,
	ModelPricing,
} from '../core/storage/types/modelCatalog';
import { FileDataStore } from '../adapters/local/fileDataStore';
import type { ConversationDeleteOutcome } from '../core/storage/types/dataStore';
import { isModelHubError } from '../core/errors';
import {
	parseConversationListItem,
	parseConversationListItems,
	parseConversationView,
	parseModelCatalogEntryView,
	parseProjectListItem,
	parseProviderSummary,
	type AbortCause,
	type ChatStreamEvent,
	type ConversationListItem,
	type ConversationView,
	type CreateConversationInput,
	type ProjectListItem,
	type AvailableModel,
	type ModelCatalogEntryView,
	type ModelCapabilityView,
	type ModelCatalogKey,
	type ModelLimitsView,
	type ModelPricingView,
	type RouterConfigView,
	type SetRouterConfigInput,
	type ProviderSummary,
	type SaveModelCatalogInput,
	type SaveProviderInput,
	type SendMessageAck,
	type SendMessageInput,
	type PermissionAnswer,
	type PermissionPrompt,
	type OrchestrationStrategy,
	type BudgetReportView,
	type BudgetSliceView,
	type BudgetUsageView,
	type SaveSpendingLimitViewInput,
	type SpendingLimitView,
	type BudgetAlertView,
	type CallForecastView,
	type ConversationUsageView,
	type ForecastRequestView,
	type TurnUsageView,
} from './contract';
import { classifyTask, type TaskClassificationExplanation } from './taskDiscovery';
import type { SpendingLimit } from '../core/budget';
import { selectModels, isPaidBlocked, shouldFallback, type SelectableModel, type SelectionReason } from './modelSelector';
import { createOrchestrationPlan, continueOrchestration, type OrchestrationAttempt, type OrchestrationResult } from './orchestrator';
import { createOrchestrationLog, buildLogEntry, type OrchestrationLogEntry } from './orchestrationLog';
import { guidanceFor } from './modelGuidance';
import type { ModelGuidance, ModelGuidanceEntry, ModelGuidanceStore } from './modelGuidance';
import { createModelCatalogTools, type ModelSelectionPort, type ModelResearchPort } from '../core/agent/modelCatalogTools';
import { createWebTools } from '../core/agent/webTools';
import type { WebPorts } from '../core/agent/webPort';
import { createWebClient } from '../app/webClient';
import { researchPrompt, runResearchCycle } from '../app/researchCycle';
import { RESEARCH_FORMAT } from '../core/agent/modelResearch';
import type { ModelDirectory, ModelRecord } from '../core/agent/modelCatalogPort';

/**
 * Longest a single turn may run before the session gives up on it.
 *
 * Set above the route policy's per-attempt `totalMs` (600 s) dividing the
 * ceiling, not the reverse: with the turn at 120 s, an attempt budget of ten
 * minutes could never elapse, and the attempt died on the turn's clock with no
 * way to try the next candidate. The turn is the outer bound; the attempt
 * budgets are the ones that actually trigger.
 */
export const DEFAULT_TURN_TIMEOUT_MS = 660_000;

/**
 * Longest the turn may wait for the model's first output — a reasoning delta,
 * a text delta or a tool call — before it is aborted as a stall. Under the
 * turn timeout: a relay that accepts the request and never streams must be
 * reported while the user is still watching, not at the 120s mark.
 *
 * With routing enabled this number is also the engine's per-attempt `ttfbMs`,
 * so a stalled candidate is retried or abandoned by the router rather than
 * ending the whole turn.
 */
export const DEFAULT_FIRST_TOKEN_TIMEOUT_MS = 60_000;

/**
 * O teto de tempo de uma **tarefa**, e o de inatividade que a encerra.
 *
 * Um turno comum é uma pergunta: se o modelo não responde em 660 s, algo está
 * errado. Uma tarefa é outra coisa — vários comandos, cada um com a duração
 * que tiver. Medir a tarefa pelo relógio fazia o trabalho longo ser cortado no
 * meio, e o que já tinha sido feito era perdido.
 *
 * Por isso, em modo tarefa:
 *
 * - o teto total sobe (é uma rede, não um orçamento);
 * - o que de fato encerra é a **inatividade**: nenhum evento por
 *   `TASK_IDLE_TIMEOUT_MS`. Progresso — inclusive um comando longo que ainda
 *   não escreveu nada — é reconhecido pelo evento de ferramenta em andamento,
 *   que reinicia o relógio.
 */
export const TASK_TURN_TIMEOUT_MS = 4 * 60 * 60_000;
export const TASK_IDLE_TIMEOUT_MS = 10 * 60_000;

/**
 * O teto de rounds de um turno em modo tarefa.
 *
 * O motor conta **retornos ao provedor**. Uma tarefa de DEV consome um por
 * etapa (ler, escrever, rodar, corrigir, rodar de novo), e o teto padrão de 8
 * tratava a metade de uma tarefa normal como "acabou".
 */
export const TASK_MAX_TURNS = 40;

/**
 * The discovery settings a session uses when the host does not override them.
 *
 * `ttlMs` is the one number worth knowing: a model list is asked for once per
 * turn and once per settings refresh, and a minute covers that burst while
 * still noticing a model the user just pulled. `concurrency` bounds the burst
 * of sockets a list of many providers opens; it is not 1 because the sequence
 * this replaces made the slowest endpoint set the cost of the whole list.
 */
export const DEFAULT_MODELS_CACHE: Required<
	Pick<ModelDiscoveryOptions, 'ttlMs' | 'staleIfErrorMs' | 'concurrency'>
> = {
	ttlMs: 60_000,
	staleIfErrorMs: 15 * 60_000,
	concurrency: 3,
};

/**
 * How discovery is configured for one session.
 *
 * A subset of the Core's options so the host documents only what it may
 * change. `ttlMs: 0` means "always ask", which is a legitimate setting for a
 * caller that cares more about freshness than latency.
 */
export interface ChatSessionModelsOptions {
	readonly ttlMs?: number;
	readonly staleIfErrorMs?: number;
	readonly concurrency?: number;
	/**
	 * An extra ceiling on one `GET /models`, under the provider's own.
	 *
	 * The provider already gives up after five seconds. This exists for a host
	 * that wants a tighter bound on a list screen; absent means the provider's
	 * budget is the only one.
	 */
	readonly timeoutMs?: number;
	/** Injected in tests so the TTL is asserted without sleeping. */
	readonly now?: () => number;
}

/**
 * The cache key for a provider's endpoint.
 *
 * Provider *and* endpoint: two providers may point at the same server and must
 * still be separate entries, and a provider whose URL was edited must not be
 * answered from the entry its old URL filled. The key is built from ids and a
 * URL only — never from the secret reference or the key itself.
 */
function discoveryKey(providerId: string, baseUrl: string): string {
	return `${providerId} ${baseUrl.trim().replace(/\/+$/, '')}`;
}

/**
 * A provider as discovery sees it: its models, the key they belong to, and a
 * abort that reaches the HTTP request.
 *
 * `OpenAICompatibleProvider` needs its budget to abort too, and its own timeout
 * already does. This adds the caller's optional ceiling by aborting the signal
 * the provider was handed — the request is cancelled, never left to finish
 * into a cache nobody will read.
 */
function discoverySource(
	key: string,
	provider: Pick<OpenAICompatibleProvider, 'listModels' | 'lastResponseHeaders'>,
	timeoutMs: number | undefined,
	published: Map<string, readonly ModelInfo[]>,
	publishedHeaders: Map<string, Readonly<Record<string, string>>>,
): ModelListSource {
	return {
		discoveryKey: key,
		listModels: async (options) => {
			const external = options?.signal;
			const ask = async (signal: AbortSignal | undefined): Promise<readonly ModelInfo[]> => {
				const models = await provider.listModels(signal !== undefined ? { signal } : {});
				// The discovery cache keeps ids; the published detail (price,
				// context, creation date) is kept beside it for the listing record.
				published.set(key, models);
				// Os cabeçalhos do `/models` também são da conta; guardados junto
				// para a listagem registrar a cota que o servidor informou.
				publishedHeaders.set(key, provider.lastResponseHeaders);
				return models;
			};
			if (timeoutMs === undefined) {
				return ask(external);
			}
			const controller = new AbortController();
			const timer = setTimeout(() => {
				controller.abort(
					new Error(`Model discovery for "${key}" did not answer within ${timeoutMs}ms`),
				);
			}, timeoutMs);
			const onExternal = (): void => controller.abort(external?.reason);
			if (external !== undefined) {
				if (external.aborted) {
					controller.abort(external.reason);
				} else {
					external.addEventListener('abort', onExternal, { once: true });
				}
			}
			try {
				return await ask(controller.signal);
			} finally {
				clearTimeout(timer);
				external?.removeEventListener('abort', onExternal);
			}
		},
	};
}

/**
 * The route policy the desktop host boots with.
 *
 * Exported rather than inlined in `main.ts` so the policy a real boot uses is
 * the value the tests exercise, and the wiring stays a one-line import instead
 * of a second copy kept in step by hand.
 *
 * The budgets are chosen against the turn's own: `ttfbMs` is the existing
 * first-token stall, and per-attempt `totalMs` sits under the turn ceiling so
 * an attempt can be abandoned while the turn still has room to try the next
 * candidate. `idleMs` sits above both, because it is the fallback for the case
 * the other two do not cover: a model that already answered and then pauses.
 * The breaker is the one exception — `ChatSession` creates it once
 * per session, so an endpoint's health survives across turns rather than being
 * forgotten between messages.
 */
export const DEFAULT_ROUTE_POLICY: RoutePolicy = {
	// One retry on the same candidate, then move on. The engine owns this now:
	// the outer loop no longer duplicates the decision when routing is on.
	retries: 1,
	retryBackoffMs: 500,
	maxRetryBackoffMs: 4_000,
	timeouts: {
		ttfbMs: DEFAULT_FIRST_TOKEN_TIMEOUT_MS,
		// Ociosidade generosa de propósito. A 30 s, um modelo que responde
		// rápido e então "pensa" no meio de uma resposta longa era morto e o
		// turno inteiro virava erro — e, como o conteúdo já estava na tela,
		// nenhuma troca de modelo era permitida depois. Três minutos cobrem uma
		// pausa longa sem transformar uma conexão realmente quebrada em espera
		// eterna: o `totalMs` e o `ttfbMs` continuam guardando os dois extremos.
		idleMs: 180_000,
		totalMs: 600_000,
	},
	// Only transient, endpoint-level classes move the route on. A bad request or
	// an auth failure is a configuration problem, and another model would just
	// fail the same way.
	fallbackOn: ['timeout', 'unavailable', 'rate_limit', 'network', 'upstream_error'],
	breaker: { failureThreshold: 5, windowMs: 60_000, openMs: 30_000, halfOpenProbes: 1 },
};

/**
 * Why a turn was force-aborted by a timer.
 *
 * `first-token`: the model accepted the request but produced no output — a
 * stall, and the common shape of an overloaded relay. `total-time`: the whole
 * turn exceeded the turn timeout. Distinct causes get distinct messages; an
 * abort with no cause recorded is the user's own Stop.
 *
 * The vocabulary itself lives in `contract.ts` as `AbortCause`, because the
 * orchestrator receives it and the renderer parses it. This is the turn-local
 * subset: `user-stop` is recognised but never produced here, since this file's
 * timers cannot tell the difference between a timeout and a user stop — the
 * caller does, at the point where it decides whether to retry at all.
 */
type TimerAbortCause = Exclude<AbortCause, 'user-stop'>;

/**
 * Where events go. Main wires this to IPC; tests collect into an array. */
export type ChatEventSink = (event: ChatStreamEvent) => void;

/**
 * How a host opts into the routing engine.
 *
 * The breaker is deliberately injectable and meant to outlive one turn: a
 * session that rebuilt it per turn would forget a failing endpoint between
 * sends, which is the one thing a circuit breaker exists to remember.
 */
export interface ChatSessionRoutingOptions {
	readonly policy: RoutePolicy;
	readonly breaker?: CircuitBreaker;
	readonly metrics?: RoutingMetricsPort;
	/**
	 * Wraps the port the session builds, so a host can observe attempts
	 * *and* keep the catalog writes.
	 *
	 * `metrics` replaces the catalog-backed port outright; this one decorates
	 * it, which is the only way to see every attempt without losing the
	 * observations. Ignored when `metrics` is given.
	 */
	readonly wrapMetrics?: (
		inner: RoutingMetricsPort,
	) => { readonly recordAttempt: (attempt: RouteAttempt) => Promise<void> };
	/** Injected in tests so attempt timestamps are exact. */
	readonly clock?: RoutingClock;
	/** Injected in tests so backoff waits can be asserted without sleeping. */
	readonly sleep?: RouteSleep;
	readonly routeId?: string;
}

export interface ChatSessionOptions {
	readonly config: ProviderConfigService;
	readonly secrets: SecretStore;
	readonly history: FileDataStore;
	readonly logger: LoggingService;
	/** Optional memory service for memory tools. */
	readonly memoryService?: MemoryService;
	/** Optional skill service for skill tools. */
	readonly skillService?: SkillService;
	/**
	 * A sessão do modo DEV (DEV-2), quando o host a oferece.
	 *
	 * Ausente = o modo não existe neste host, e nenhuma ferramenta `dev_*` é
	 * registrada. Presente, as ferramentas são registradas uma vez e cada
	 * execução pergunta `session.isActive()`: sair do DEV bloqueia a próxima
	 * chamada mesmo antes de o registro ser desfeito.
	 */
	readonly dev?: DevToolDeps;
	/**
	 * Routes every attempt through the Core's streaming engine.
	 *
	 * Left unset, the session behaves exactly as before: one provider per
	 * attempt, the outer loop deciding fallback. When set, each attempt is a
	 * route — retries, per-attempt timeouts, the circuit breaker and the
	 * commit-before-flush rule — and the outer loop stops duplicating that
	 * decision. Off by default on purpose: the timeouts and the trust model it
	 * changes are a policy a host should choose, not one it should inherit.
	 */
	readonly routing?: ChatSessionRoutingOptions;
	/**
	 * Whether paid models may be selected automatically.
	 *
	 * Off — the current policy. It is the one switch that represents an explicit
	 * authorization to spend, so it is a session option rather than a per-turn
	 * flag the renderer could set, and it governs every path that can reach a
	 * model: the plan's primary choice, its fallbacks, the manual choice the
	 * selector is handed, and the direct manual send. Naming a paid model is a
	 * preference for it; it is not a budget, and it does not authorize one.
	 */
	readonly allowPaid?: boolean;
	/**
	 * Injected in tests; defaults to the global `fetch`.
	 *
	 * The same seam the Core's own provider tests use. It exists so the whole
	 * conversation flow can be exercised without a socket, which is what let the
	 * flow be split out of `main.ts` and tested at all.
	 */
	readonly fetchImpl?: FetchLike;
	/** Injected in tests to make conversation ids predictable. */
	readonly generateId?: () => string;
	/**
	 * Injected in tests so timestamps are predictable.
	 *
	 * The store takes its own clock for what it writes; this one is only for
	 * deciding list order, which is read back from the store rather than kept
	 * here. Without it, "newest first" could only be tested by sleeping.
	 */
	readonly now?: () => string;
	readonly turnTimeoutMs?: number;
	/**
	 * How long the turn may wait for the model's *first* output — a reasoning
	 * delta, a text delta or a tool call — before it is aborted as a stall.
	 *
	 * Distinct from `turnTimeoutMs`, which bounds the whole turn including tool
	 * rounds: a server that accepts the request and then never streams anything
	 * (a queued model, an overloaded relay) would otherwise hold the user for
	 * the full turn timeout with no word of why. Injected in tests.
	 */
	readonly firstTokenTimeoutMs?: number;
	/**
	 * How `GET /models` answers are reused within one session.
	 *
	 * Absent means the defaults (`ModelsCacheOptions`): a 60-second TTL, a
	 * bounded stale-if-error window whenever an earlier answer is usable, and a
	 * cap on how many providers are refreshed at once. `ttlMs: 0` turns the
	 * cache off, which is what a caller that must always ask the server wants.
	 *
	 * Discovery never writes to the catalog: an answer here is a list of ids,
	 * not a claim about price, tools or context.
	 */
	readonly models?: ChatSessionModelsOptions;
	/**
	 * A política de acesso, injetada só em testes.
	 *
	 * Em produção a sessão lê `access-policy.json` a cada turno, porque o
	 * usuário pode mudá-la pela janela com o app aberto. Este gancho existe
	 * para um teste medir a seleção sob uma política fixa sem gravar disco.
	 */
	readonly accessPolicy?: ModelAccessPolicyRecord;
	/**
	 * Onde a Evelyn grava as preferências de modelo, e de onde o motor as lê.
	 *
	 * Ausente numa sessão montada sem raiz de disco: aí não há onde gravar e a
	 * seleção segue exatamente as regras do catálogo.
	 */
	readonly modelGuidance?: ModelGuidanceStore;
}

/** A `PersistedProviderConfig` as the renderer is allowed to see it. */
function toSummary(config: PersistedProviderConfig): ProviderSummary {
	return parseProviderSummary({
		id: config.id,
		name: config.name,
		baseUrl: config.baseUrl,
		// Persisted config carries no live status, but it does carry `enabled`:
		// a disabled provider is honestly `disabled`, and `configured` is the
		// honest answer for an enabled one that has not answered a call yet —
		// claiming `available` here would be a guess the UI would then repeat.
		status: config.enabled === false ? 'disabled' : 'configured',
		hasApiKeyRef: config.apiKeyRef !== undefined,
		// The role is only written when it is `router`: an absent role and a
		// `provider` role mean the same thing, and writing the redundant one
		// would turn every save into a diff.
		...(config.role === 'router' ? { role: 'router' } : {}),
		// Models live on the live provider instance; the renderer gets them from
		// `listModels`, which actually asks the server.
		models: [],
	});
}

// ── model catalog: Core record to settings-window view ──────────────────────

/**
 * A stored record as the form fills itself in.
 *
 * Three things happen here that the Core deliberately does not do for itself:
 * numbers become strings, a list of capabilities becomes one comma-separated
 * field, and the observations become two medians.
 *
 * The strings matter. The form is text, and a number turned into a string is
 * what lets the empty field mean unknown — a `0` would be indistinguishable from
 * a model that really is free, and would save as one.
 */
/**
 * A matriz de capacidades declarada, no formato da janela.
 *
 * Três estados por campo: `true`, `false` e ausente (ninguém sabe). O
 * ausente continua ausente — é o estado que decide se o seletor exclui o
 * modelo ou só não o prefere.
 */
function toModelCapabilityView(model: ModelCapabilities): ModelCapabilityView {
	return {
		toolCalling: model.toolCalling,
		structuredOutput: model.structuredOutput,
		reasoning: model.reasoning,
	};
}

function toCatalogView(entry: ModelCatalogEntry): ModelCatalogEntryView {	return parseModelCatalogEntryView({
		providerId: entry.providerId,
		modelId: entry.modelId,
		capabilities: entry.capabilities?.join(', ') ?? '',
		...(entry.pricing !== undefined
			? {
					pricing: {
						currency: entry.pricing.currency,
						unit: entry.pricing.unit,
						// Absent rather than '' so the field can be left untouched
						// and a blank one is unambiguously "not known".
						...(entry.pricing.input !== undefined ? { input: String(entry.pricing.input) } : {}),
						...(entry.pricing.output !== undefined ? { output: String(entry.pricing.output) } : {}),
					} satisfies ModelPricingView,
				}
			: {}),
		access: entry.access,
		...(entry.limits !== undefined
			? {
					limits: {
						...(entry.limits.contextTokens !== undefined
							? { contextTokens: String(entry.limits.contextTokens) }
							: {}),
						...(entry.limits.maxOutputTokens !== undefined
							? { maxOutputTokens: String(entry.limits.maxOutputTokens) }
							: {}),
					} satisfies ModelLimitsView,
				}
			: {}),
		...(entry.model !== undefined ? { model: toModelCapabilityView(entry.model) } : {}),
		...(entry.notes !== undefined ? { notes: entry.notes } : {}),
		observations: entry.observations.length,
		...(medianOf(entry.observations, (o) => o.firstByteMs) !== undefined
			? { medianFirstByteMs: medianOf(entry.observations, (o) => o.firstByteMs) }
			: {}),
		...(medianOf(entry.observations, (o) => o.totalMs) !== undefined
			? { medianTotalMs: medianOf(entry.observations, (o) => o.totalMs) }
			: {}),
		updatedAt: entry.updatedAt,
	});
}

/**
 * The median of the readings a set of observations actually reported.
 *
 * Undefined when nothing reported one, rather than zero — a provider that
 * never told us how long it took has not been fast.
 *
 * Observations that did not carry the reading are skipped rather than counted as
 * zero. `firstByteMs` and `totalMs` are both optional precisely because an
 * aborted or unreadable run has neither, and averaging those in as `0` would drag
 * a model that is usually quick down towards a speed nothing has ever seen.
 */
function medianOf(
	observations: readonly ModelObservation[],
	read: (observation: ModelObservation) => number | undefined,
): number | undefined {
	const values = observations
		.map(read)
		.filter((value): value is number => value !== undefined)
		.sort((a, b) => a - b);
	if (values.length === 0) {
		return undefined;
	}
	const middle = Math.floor(values.length / 2);
	// An even count has no single middle reading, so the mean of the two is used.
	// Rounded because a latency is a measurement of a clock, and `1234.5` would
	// look precise to a degree the input never had.
	return values.length % 2 === 1
		? values[middle]
		: Math.round((values[middle - 1] + values[middle]) / 2);
}

/**
 * One line per routing attempt for the orchestration log.
 *
 * Built from the closed `ErrorClass` and the budget, never from the provider's
 * message: a failure's text can quote a prompt, and the log is durable.
 */
function describeRouteAttempt(record: RouteAttempt): string {
	const budget = record.abortCause !== undefined ? ` (${record.abortCause})` : '';
	if (record.errorClass === 'budget_exhausted') {
		return 'route attempt blocked by the spending limit';
	}
	if (record.errorClass !== undefined) {
		return `route attempt failed: ${record.errorClass}${budget}`;
	}
	return `route attempt ${record.outcome}${budget}`;
}

/**
 * Splits the form's comma-separated field.
 *
 * The store trims and folds duplicates; splitting here keeps the choice of
 * separator in one place. Empty input is `[]` rather than omitted: the user
 * filled the box in with nothing, which is them saying the model is good for
 * nothing they listed, and that is different from not having touched the field.
 */
function parseCapabilityList(value: string): readonly string[] {
	return value
		.split(',')
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

/** Um limite do Core, no formato do formulário. */
function toSpendingLimitView(limit: SpendingLimit): SpendingLimitView {
	return {
		limitId: limit.limitId,
		providerId: limit.providerId ?? '',
		modelId: limit.modelId ?? '',
		currency: limit.currency,
		amount: limit.amount,
		window: limit.window,
		scope: scopeOf(limit),
		policy: limit.policy ?? 'any',
		createdAt: limit.createdAt,
		updatedAt: limit.updatedAt,
	};
}

/**
 * O consumo agregado, cruzando o bridge.
 *
 * Só o que a tela desenha atravessa: um total em uma moeda, ou o motivo de
 * não haver um. As partes por tentativa ficam no Core — o relatório por
 * execução já existe em `byExecution`.
 */
function toBudgetUsageView(total: UsageTotal): BudgetUsageView {
	const tokens =
		total.tokens !== undefined
			? {
					...(total.tokens.input !== undefined ? { input: total.tokens.input } : {}),
					...(total.tokens.output !== undefined ? { output: total.tokens.output } : {}),
				}
			: undefined;
	return {
		executions: total.executions,
		attempts: total.attempts,
		...(tokens !== undefined ? { tokens } : {}),
		cost:
			total.cost.status === 'estimated'
				? { status: 'estimated', currency: total.cost.currency, total: total.cost.total }
				: { status: 'unknown', reasons: [...total.cost.reasons] },
		executionsWithoutCost: total.executionsWithoutCost,
	};
}

function toBudgetSliceView(slice: UsageSlice): BudgetSliceView {
	return {
		providerId: slice.providerId,
		...(slice.modelId !== undefined ? { modelId: slice.modelId } : {}),
		...(slice.executionId !== undefined ? { executionId: slice.executionId } : {}),
		...(slice.conversationId !== undefined ? { conversationId: slice.conversationId } : {}),
		...(slice.turnId !== undefined ? { turnId: slice.turnId } : {}),
		...toBudgetUsageView(slice),
	};
}

/** A previsão, como a tela a lê. Nenhum total é arredondado a zero. */
function toForecastView(forecast: CallForecast): CallForecastView {
	return {
		providerId: forecast.providerId,
		modelId: forecast.modelId,
		access: forecast.access,
		cost:
			forecast.cost.status === 'estimated'
				? {
						status: 'estimated',
						currency: forecast.cost.currency,
						unit: forecast.cost.unit,
						input: forecast.cost.input,
						output: forecast.cost.output,
						total: forecast.cost.total,
						...(forecast.cost.range !== undefined
							? { range: { low: forecast.cost.range.low, high: forecast.cost.range.high } }
							: {}),
					}
				: { status: 'unknown', reasons: [...forecast.cost.reasons] },
		inputTokens: forecast.inputTokens,
		...(forecast.outputTokens !== undefined ? { outputTokens: forecast.outputTokens } : {}),
		inputBasis: forecast.inputBasis,
		outputBasis: forecast.outputBasis,
		samples: forecast.samples,
		confidence: forecast.confidence,
		truncated: forecast.truncated,
	};
}

function toAlertView(alert: BudgetAlert): BudgetAlertView {
	return {
		limitId: alert.limitId,
		scope: alert.scope,
		window: alert.window,
		currency: alert.currency,
		amount: alert.amount,
		spent: alert.spent,
		fraction: alert.fraction,
		message: alert.message,
	};
}

function toTurnUsageView(turn: TurnUsage): TurnUsageView {
	return {
		turnId: turn.turnId,
		firstStartedAt: turn.firstStartedAt,
		...(turn.lastStartedAt !== undefined ? { lastStartedAt: turn.lastStartedAt } : {}),
		providerIds: [...turn.providerIds],
		modelIds: [...turn.modelIds],
		...toBudgetUsageView(turn),
	};
}

function toConversationUsageView(
	usage: ConversationUsage,
	title: string | undefined,
	forecast: CallForecast | undefined,
): ConversationUsageView {
	return {
		conversationId: usage.conversationId,
		...(title !== undefined ? { title } : {}),
		turns: usage.turns.map(toTurnUsageView),
		...(forecast !== undefined ? { forecast: toForecastView(forecast) } : {}),
		...toBudgetUsageView(usage.total),
	};
}

/** A price box with no currency is not a price, and saving nothing is the honest answer. */function isBlankPricing(pricing: ModelPricingView): boolean {
	return pricing.currency.trim().length === 0;
}

function toPricing(pricing: ModelPricingView): {
	currency: string;
	unit: ModelPricingView['unit'];
	input?: number;
	output?: number;
} {
	return {
		currency: pricing.currency.trim(),
		unit: pricing.unit,
		...(toOptionalNumber(pricing.input) !== undefined ? { input: toOptionalNumber(pricing.input) } : {}),
		...(toOptionalNumber(pricing.output) !== undefined
			? { output: toOptionalNumber(pricing.output) }
			: {}),
	};
}

function toLimits(limits: ModelLimitsView): {
	contextTokens?: number;
	maxOutputTokens?: number;
} {
	const context = toOptionalNumber(limits.contextTokens);
	const output = toOptionalNumber(limits.maxOutputTokens);
	return {
		...(context !== undefined ? { contextTokens: Math.round(context) } : {}),
		...(output !== undefined ? { maxOutputTokens: Math.round(output) } : {}),
	};
}

/**
 * A number the user typed, or nothing.
 *
 * Blank is nothing rather than zero, and anything unparseable is nothing too:
 * a half-typed `1.` while the field has focus must not fail the save, and the
 * Core re-validates whatever arrives so a real `Infinity` still cannot land.
 */
function toOptionalNumber(value: string | undefined): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return undefined;
	}
	const parsed = Number(trimmed);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export class ChatSession {
	private readonly config: ProviderConfigService;
	private readonly secrets: SecretStore;
	private readonly history: FileDataStore;
	private readonly logger: LoggingService;
	private readonly generateId: () => string;
	private readonly turnTimeoutMs: number;
	private readonly firstTokenTimeoutMs: number;
	private readonly fetchImpl: FetchLike | undefined;
	private readonly clock: () => string;
	private readonly memoryService?: MemoryService;
	private readonly skillService?: SkillService;
	/** A sessão do modo DEV, quando o host a oferece (DEV-2). */
	private dev?: DevToolDeps;
	private readonly skillDiscovery?: SkillDiscoveryService;
	/** Onde a Evelyn registra as preferências de modelo (ver `modelGuidance.ts`). */
	private readonly modelGuidance?: ModelGuidanceStore;
	/**
	 * O histórico recente da conversa em curso.
	 *
	 * Lido uma vez por turno, no ponto em que o turno classifica a tarefa, e
	 * usado também pela ferramenta `recommend_model` — que roda no meio desse
	 * turno e precisa classificar o mesmo pedido do mesmo jeito.
	 */
	private recentUserMessages: readonly { readonly role: string; readonly content: string }[] = [];
	/**
	 * O catálogo fundido do turno em curso.
	 *
	 * A ferramenta de recomendação roda no meio do turno, depois de o motor já
	 * ter lido o catálogo. Ela lê desta cópia em vez de fundir de novo: dois
	 * relógios e duas leituras para o mesmo turno poderiam discordar sobre um
	 * preço vencido ou uma observação recém-gravada.
	 */
	private fusedCatalogSnapshot: readonly ModelCatalogEntry[] = [];
	/** The routing policy, when the host opted in. */
	private readonly routing?: ChatSessionRoutingOptions;
	/** Whether paid models may be selected automatically. False by default. */
	private readonly allowPaid: boolean;
	/** One breaker per session, so an endpoint's health survives a turn. */
	private readonly routingBreaker?: CircuitBreaker;
	/**
	 * The session's short-lived view of what each endpoint advertises.
	 *
	 * One per session, so the turns and the settings lists that follow each
	 * other share the first answer instead of each paying a round trip. It is
	 * memory only: nothing here outlives the session or reaches the catalog.
	 */
	private readonly discovery: ModelDiscovery;
	/**
	 * A cap on `GET /models` that is shorter than the provider's own budget.
	 *
	 * Absent means no extra bound, and the provider's five seconds stands.
	 */
	private readonly discoveryTimeoutMs?: number;
	/**
	 * Where an attempt's real measurements go.
	 *
	 * One port per session. The host may inject one; otherwise the session
	 * builds the catalog-backed one, so a run that really happened is recorded
	 * without the host having to wire anything for it.
	 */
	private readonly routingMetrics?: RoutingMetricsPort;
	/**
	 * The same port, when it is the session's own and can be waited on.
	 *
	 * Kept apart from `routingMetrics` so an injected port needs no extra method
	 * to be valid. Only the catalog-backed one can report that its writes are
	 * done, which is what a test — or a caller checking the catalog right after
	 * a turn — needs.
	 */
	private readonly routingMetricsSettled?: () => Promise<void>;
	/**
	 * Where each attempt's consumption goes.
	 *
	 * Built by the session, next to the catalog port, and never injected: unlike
	 * metrics, which a host may replace to observe, consumption is the record
	 * the product keeps for itself. A host that replaced it would silently stop
	 * the ledger, and the next step's budget would read an empty history.
	 *
	 * It sits in `wrapMetrics` rather than in the catalog port because it needs
	 * the attempt's outcome and usage, which only the engine's own record has.
	 * The catalog port is called first, so a consumed attempt is an observed one
	 * in exactly the cases where 4A says it should be.
	 */
	private readonly consumption?: ConsumptionRecorder;
	/**
	 * A conversa do turno em voo, para o gravador de consumo.
	 *
	 * Mantida no turno e não no gravador porque o gravador vive enquanto a
	 * sessão vive: fixar a conversa nele faria o segundo turno de outra
	 * conversa ser creditado à primeira.
	 */
	private conversationInFlight: string | undefined;
	/**
	 * O turno do consumo em voo.
	 *
	 * O gravador usa `routeId` como id de turno, e nem todo host o fornece: a
	 * sessão do desktop tem o seu próprio `turnId`, e é ele que liga a execução
	 * ao turno que o `sink` anunciou. Sem isso, os turnos de uma conversa não
	 * se agrupam.
	 */
	private turnInFlight: string | undefined;
	private currentTurnId: () => string | undefined = () => this.turnInFlight;
	/**
	 * Os turnos que começaram e ainda não fecharam o consumo.
	 *
	 * Serve para não limpar a conversa do turno seguinte: o `finally` de um
	 * turno pode correr depois que o próximo já se registrou.
	 */
	private readonly pendingTurns = new Map<string, string>();
	/**
	 * The spending-limit gate the routed providers ask before calling a paid
	 * candidate.
	 *
	 * Built with the consumption recorder and reading the same store, so the
	 * amount a limit compares is the amount the ledger just wrote. `undefined`
	 * only when routing is off: the legacy path never reaches the gate, and a
	 * second copy of the budget rule would be a second place to disagree.
	 */
	private readonly budgetGate?: SessionBudgetGate;
	/**
	 * O que os provedores publicaram, atualizado a cada listagem.
	 *
	 * Fora das portas de métricas de propósito: a descoberta não mede um turno,
	 * ela mantém o catálogo do provedor. Falhas nela são logadas e não
	 * interrompem nada.
	 */
	private readonly providerDiscovery: ProviderDiscovery;
	/**
	 * As decisões do portão de orçamento deste turno.
	 *
	 * Vão para o relatório de decisão, para que ele diga **quais** limites
	 * foram considerados. É reescrito a cada turno: a sessão roda um turno por
	 * vez, e o que interessou foi a decisão daquele turno.
	 */
	private readonly budgetObservations: BudgetObservation[] = [];

	/**
	 * A política de acesso, como o turno a pergunta.
	 *
	 * Em produção é sempre a gravação do usuário, lida a cada turno. Injetada
	 * só para os testes medirem a seleção com uma política fixa.
	 */
	private readonly accessPolicyReader?: () => Promise<ModelAccessPolicyRecord>;
	/**
	 * Quotas esgotadas nesta sessão, com a janela que a API informou.
	 *
	 * Em memória: é o "agora" do host, não um fato que sobreviva a reabrir o
	 * app. O que ficou gravado é o que a API disse (`provider-models.json`).
	 */
	private readonly quotaTracker: QuotaTracker;
	/**
	 * A última resposta de `/models` de cada endpoint, com o que o provedor
	 * publicou além do id (preço, janela, data).
	 *
	 * O cache de descoberta guarda só ids por decisão da 4A; estes detalhes são
	 * o que a 5D grava, e vivem só enquanto a resposta que os trouxe é a atual.
	 */
	private readonly publishedHeaders = new Map<string, Readonly<Record<string, string>>>();
	private readonly published = new Map<string, readonly ModelInfo[]>();
	/** Log of orchestration decisions and outcomes. */
	private readonly orchestrationLog: ReturnType<typeof createOrchestrationLog>;

	/** Live provider instances, rebuilt from config when the config changes. */
	private readonly live = new Map<string, OpenAICompatibleProvider>();

	/**
	 * The agent's tools, built once on the first turn.
	 *
	 * One registry for the whole session: the runtime resolves tools by name, so
	 * a fresh registry per turn would be a second, invisible copy of the same
	 * tools — and `ToolRegistry.register` refuses duplicates anyway.
	 */
	private registry: ToolRegistry | undefined;
	private toolDisposer: (() => void) | undefined;
	/** The recorder wrapped around each tool, so results can be captured. */
	private recorders: ReadonlyMap<string, RecordingTool> = new Map();
	private permissionGateway: PermissionGateway | undefined;
	/**
	 * Carries permission requests to the user and their answers back.
	 *
	 * Built lazily with the same `emit` the turn uses, so a request raised inside
	 * the runtime reaches the renderer by the path the events already take.
	 */
	private broker: PermissionBroker | undefined;

	/** The abort controller of the turn in flight, if any. */
	private inFlight: { readonly turnId: string; readonly controller: AbortController } | undefined;
	/**
	 * Cada turno em andamento, desde o pedido até a sua contabilização fechar.
	 *
	 * `sendMessage` resolve quando o turno é aceito, não quando ele termina; o
	 * registro de consumo e o desfecho chegam depois. Esta promessa é o que um
	 * chamador (ou um teste) espera para ler o ledger sem correr contra a
	 * escrita — a diferença entre "o turno está rodando" e "o turno terminou".
	 */
	private readonly turnCompletions = new Map<string, Promise<void>>();
	/**
	 * Os brokers de permissão dos turnos externos (R4C), por `turnId`.
	 *
	 * Separado do broker da sessão de propósito: uma janela e um cliente HTTP
	 * podem estar perguntando ao mesmo tempo, e cada resposta precisa chegar
	 * ao turno que a fez.
	 */
	private readonly externalBrokers = new Map<
		string,
		{ readonly broker: PermissionBroker; readonly answer: (answer: PermissionAnswer) => boolean }
	>();
	private turnCounter = 0;

	constructor(options: ChatSessionOptions) {
		this.config = options.config;
		this.secrets = options.secrets;
		this.history = options.history;
		this.logger = options.logger;
		this.generateId = options.generateId ?? (() => randomUUID());
		this.turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
		this.firstTokenTimeoutMs = options.firstTokenTimeoutMs ?? DEFAULT_FIRST_TOKEN_TIMEOUT_MS;
		this.fetchImpl = options.fetchImpl;
		this.clock = options.now ?? (() => new Date().toISOString());
		this.memoryService = options.memoryService;
		this.skillService = options.skillService;
		this.dev = options.dev;
		this.skillDiscovery = options.skillService !== undefined
			? createSkillDiscoveryService(options.skillService)
			: undefined;
		const routing = options.routing;
		this.routing = routing;
		this.allowPaid = options.allowPaid ?? false;
		this.accessPolicyReader =
			options.accessPolicy === undefined ? undefined : async () => options.accessPolicy as ModelAccessPolicyRecord;
		this.routingBreaker =
			routing !== undefined
				? routing.breaker ??
					new CircuitBreaker(
						() => routing.policy.breaker,
						routing.clock ?? Date.now,
					)
				: undefined;
		const catalogMetrics =
			routing === undefined
				? undefined
				: createCatalogMetricsPort({
						catalog: this.history,
						// Logged rather than thrown: a measurement that could not be
						// stored is a lost measurement, not a failed answer.
						onFailure: (error) =>
							this.logger.warn('Could not record a routing measurement', {
								error: describeError(error),
							}),
					});
		// Consumption is built even when a host injects its own metrics port:
		// replacing the port a host *observes* must not stop the ledger the
		// product keeps. It wraps the catalog port itself, so the observation and
		// the consumption of one attempt are written from the same pass.
		const consumption =
			routing === undefined
				? undefined
				: createConsumptionRecorder({
						ledger: this.history,
						// O preço que precifica a chamada é o preço *em vigor*:
						// o declarado, ou o publicado pelo provedor, conforme a
						// escolha do usuário. A escolha é explícita e reversível,
						// e o valor declarado continua no catálogo intacto.
						pricing: async (providerId, modelId) =>
							this.effectivePricingFor({ providerId, modelId }),
						// Read at each attempt, so a turn on another conversation is
						// counted on that one. The field is assigned before any
						// attempt can run (see `sendMessage`).
						conversationId: () => this.conversationInFlight,
						turnId: this.currentTurnId,
						// Same rule as the observations: a lost cost record is reported
						// and never handed to a turn that already delivered an answer.
						onFailure: (error, context) =>
							this.logger.warn('Could not record model consumption', {
								error: describeError(error),
								phase: context.phase,
							}),
					});
		this.consumption = consumption;
		this.quotaTracker = createQuotaTracker();
		this.providerDiscovery = createProviderDiscovery({
			store: this.history,
			quotas: this.quotaTracker,
			// Discovery that cannot be stored is a lost observation, never a
			// failed turn: reported here, swallowed everywhere else.
			onFailure: (error, context) =>
				this.logger.warn('Could not record provider discovery', {
					error: describeError(error),
					phase: context.phase,
				}),
		});
		this.budgetGate =
			routing === undefined
				? undefined
				: createBudgetGate({
						store: this.history,
						allowPaid: this.allowPaid,
						// A previsão usa o mesmo preço em vigor que o ledger
						// precifica, para que o número da tela seja o número
						// que seria cobrado.
						pricing: async (candidate) => this.effectivePricingFor(candidate),
						// A política em vigor decide quais limites restritos se
						// aplicam a esta chamada.
						policy: async () => (await this.loadAccessPolicy()).policy,
						// As decisões entram no relatório do turno, para que ele
						// diga quais limites foram considerados.
						onDecision: (observation) => {
							this.budgetObservations.push({
								candidate: observation.candidate,
								applicable: observation.applicable,
								decision: { allowed: observation.decision.allowed },
							});
						},
						// A limit that cannot be read is reported, not enforced:
						// the turn it would have blocked is already being served.
						onFailure: (error, context) =>
							this.logger.warn('Could not evaluate the spending limits', {
								error: describeError(error),
								phase: context.phase,
							}),
					});
		const observed =
			routing === undefined
				? undefined
				: routing.metrics ??
					(catalogMetrics !== undefined && routing.wrapMetrics !== undefined
						? routing.wrapMetrics(catalogMetrics)
						: catalogMetrics);
		const observedSettled =
			routing?.metrics === undefined && catalogMetrics !== undefined
				? () => catalogMetrics.settled()
				: undefined;
		// Both writes run per attempt, and both must land before the turn is
		// reported as over. The consumers downstream see one port either way.
		this.routingMetrics =
			consumption === undefined
				? observed
				: {
						recordAttempt: async (attempt: RouteAttempt) => {
							await observed?.recordAttempt(attempt);
							await consumption.recordAttempt(attempt);
						},
					};
		this.routingMetricsSettled =
			observedSettled === undefined && consumption === undefined
				? undefined
				: async () => {
						await observedSettled?.();
						await consumption?.settled();
					};
		this.orchestrationLog = createOrchestrationLog(this.history);
		// Onde a Evelyn registra as próprias preferências. Ausente em sessões
		// montadas em teste sem raiz de disco: aí não há onde gravar, e o motor
		// decide como sempre decidiu.
		this.modelGuidance = options.modelGuidance;

		const models = options.models;
		this.discoveryTimeoutMs = models?.timeoutMs;
		this.discovery = createModelDiscovery({
			ttlMs: models?.ttlMs ?? DEFAULT_MODELS_CACHE.ttlMs,
			staleIfErrorMs: models?.staleIfErrorMs ?? DEFAULT_MODELS_CACHE.staleIfErrorMs,
			concurrency: models?.concurrency ?? DEFAULT_MODELS_CACHE.concurrency,
			...(models?.now !== undefined ? { now: models.now } : {}),
		});
	}

	listProviders(): readonly ProviderSummary[] {
		return this.config.list().map(toSummary);
	}

	/**
	 * Creates or updates a provider.
	 *
	 * The key handling is the point: a non-empty key is stored and referenced, an
	 * empty one deletes whatever was stored, and an omitted one leaves the
	 * existing key alone. That last case is what lets the form save a base URL
	 * without making the user retype the key.
	 */
	async saveProvider(input: SaveProviderInput): Promise<ProviderSummary> {
		const id = input.id ?? deriveProviderId(input.baseUrl);
		const name = input.name ?? defaultName(input.baseUrl);
		const ref = providerApiKeyRef(id);

		if (input.apiKey !== undefined) {
			if (input.apiKey.trim().length === 0) {
				await this.secrets.delete(ref);
			} else {
				await this.secrets.store(ref, input.apiKey);
			}
		}

		const stored: PersistedProviderConfig = {
			id,
			name,
			baseUrl: input.baseUrl,
			apiKeyRef: ref,
			enabled: true,
			// O papel sobrevive a uma edicao: re-salvar o nome de um
			// provedor nao e razao para esquecer que ele e o roteador.
			...(input.role === 'router' ? { role: 'router' } : {}),
			};
		await this.config.save(stored);
		// The cached instance holds the old baseUrl, so it cannot survive an edit.
		this.live.delete(id);
		// Neither can a model list discovered from the old endpoint. The key
		// includes the URL, so saving the same URL again would drop an answer
		// that is still correct; forgetting it as well is cheap and leaves no
		// doubt about which configuration an answer belongs to.
		this.invalidate(id);
		this.invalidateModelCache(id);

		this.logger.info('Provider saved', { providerId: id });
		return toSummary(stored);
	}

	/**
	 * Removes a provider and the key behind its reference.
	 *
	 * The key goes with it on purpose: an orphaned key is unreachable, and this
	 * is the one place that can clean up both halves.
	 */
	async removeProvider(providerId: string): Promise<boolean> {
		const removed = await this.config.remove(providerId);
		if (!removed) {
			return false;
		}
		await this.secrets.delete(providerApiKeyRef(providerId));
		this.live.delete(providerId);
		this.invalidateModelCache(providerId);
		// R4S: some com o que foi descoberto **daquele** provedor. Sem isto,
		// os modelos e as quotas dele ficavam no ledgers e reapareciam como
		// dados de um provedor que já não existe.
		await this.history.forgetProvider(providerId).catch((error: unknown) => {
			// A remoção já aconteceu; a limpeza é consequência. Falhar aqui não
			// pode desfazer o que o usuário pediu — mas é dita.
			this.logger.warn('Could not forget the discovery records of a removed provider', {
				providerId,
				reason: error instanceof Error ? error.message : String(error),
			});
		});
		return true;
	}

	/**
	 * Chamado na inicialização; nada a semear desde a R4S.
	 *
	 * Antes semeava o provedor `9router` (um proxy local em
	 * `localhost:20128`). Na prática isso criava em toda instalação um
	 * provedor que não responde — e, com ele, modelos de exemplo que ficavam
	 * para sempre no catálogo depois que o usuário decidia não usá-lo. Um
	 * provedor agora só existe se o usuário configurar um; quem já tinha o
	 * `9router` o mantém, e quem o removeu permanece sem ele.
	 *
	 * O método fica porque o host o chama na inicialização e o nome diz o que
	 * ele significa ("garanta os padrões"), não o que ele fazia.
	 */
	async seedDefaultProviders(): Promise<void> {
		return;
	}

	/**
	 * Asks the provider for its models.
	 *
	 * Returns just the ids: the renderer needs to fill a `<select>`, and the rest
	 * of `ModelInfo` is unused so far.
	 *
	 * Shares the discovery cache with `listAvailableModels` and with the turns,
	 * so opening the settings window right after a turn does not ask the same
	 * endpoint again. `refreshModels` is what a caller uses when it must know.
	 */
	async listModels(providerId: string): Promise<readonly string[]> {
		try {
			const availability = await this.refreshProviderModels(providerId);
			return availability.map((model) => model.id);
		} catch (error) {
			// The endpoint did not answer. The last listing the provider
			// published is still what it said, and the record says it is stale:
			// serving it keeps the picker usable, and the failure is logged.
			const key = this.keyForProvider(providerId);
			const known = key === undefined ? undefined : this.published.get(key);
			if (known !== undefined) {
				this.logger.warn('Serving the last published model list after a failed refresh', {
					providerId,
					reason: error instanceof Error ? error.message : String(error),
				});
				return known.map((model) => model.id);
			}
			throw error;
		}
	}

	/** The discovery key of a configured provider, when it is still configured. */
	private keyForProvider(providerId: string): string | undefined {
		const config = this.config.get(providerId);
		return config === undefined ? undefined : discoveryKey(providerId, config.baseUrl);
	}

	/**
	 * Asks one provider for its models and records what it published.
	 *
	 * The returned list is the endpoint's answer, enriched with whatever the
	 * provider published (context window, price, creation date). Recording the
	 * listing is best-effort: the caller gets its models even when the
	 * discovery file cannot be written, which is why nothing here rejects on a
	 * storage failure.
	 */
	private async refreshProviderModels(providerId: string): Promise<readonly ModelInfo[]> {
		const provider = this.buildProvider(providerId);
		const config = this.config.get(providerId);
		if (config === undefined) {
			throw new Error(`No provider named "${providerId}" is configured`);
		}
		const key = discoveryKey(providerId, config.baseUrl);
		const source = discoverySource(key, provider, this.discoveryTimeoutMs, this.published, this.publishedHeaders);
		let result: Awaited<ReturnType<ModelDiscovery['query']>>;
		try {
			result = await this.discovery.query(source);
		} catch (error) {
			// Um pedido explícito de releitura não perde a cópia anterior: se o
			// servidor não respondeu, a última listagem continua sendo o que o
			// provedor disse, e o registro dela fica marcado como desatualizado.
			await this.providerDiscovery.recordListingFailure(providerId, error);
			throw error;
		}
		if (!result.stale) {
			await this.providerDiscovery.recordListing(
				providerId,
				this.published.get(key) ?? [],
				{ fetchedAt: new Date(result.fetchedAtMs), quotaHeaders: this.publishedHeaders.get(key) },
			);
		}
		return this.published.get(key) ?? result.models.map((id) => ({ id, name: id }));
	}

	/**
	 * Forgets what is cached for one provider, or for all of them.
	 *
	 * The manual refresh: the next list or turn asks the endpoint again. Also
	 * exported through the session's own `invalidate`, which every provider
	 * edit already calls, so an edited URL cannot serve the old answer.
	 */
	invalidateModelCache(providerId?: string): void {
		if (providerId === undefined) {
			this.discovery.invalidate();
			return;
		}
		const config = this.config.get(providerId);
		// Forget every key that belongs to this provider, including one filled
		// under a previous base URL. The id is the first half of the key and the
		// two are joined by a space no provider id can contain.
		if (config !== undefined) {
			this.discovery.invalidate(discoveryKey(providerId, config.baseUrl));
		}
		for (const { key } of this.discovery.snapshot()) {
			if (key.startsWith(`${providerId} `)) {
				this.discovery.invalidate(key);
			}
		}
	}

	/**
	 * Every model from every enabled provider, tagged with its provider.
	 *
	 * Cached per endpoint for a short time. The first call in a session asks
	 * each provider once; the turns and lists that follow read the same answer
	 * until it expires, so a conversation no longer pays one `/models` round
	 * trip per provider before every message.
	 *
	 * A refresh is bounded, and providers are refreshed independently: they run
	 * at most `concurrency` at a time, because a list that mixes a local server
	 * and several remote endpoints should neither be serialised behind the
	 * slowest one nor open every socket at once.
	 *
	 * A failure is skipped, not thrown. A provider whose server is down is an
	 * ordinary state — the user configures it before starting it — and letting
	 * that one error empty the list would take away the models the working
	 * providers do offer. When an earlier answer exists and is still inside the
	 * stale-if-error window, it is served instead and the failure is logged.
	 *
	 * Order is preserved: providers in configuration order, models in the order
	 * the endpoint reported them, exact ids.
	 *
	 * Disabled providers are skipped without a request: asking one would fail by
	 * design, and the failure would be indistinguishable from a real outage.
	 */
	async listAvailableModels(
		options: { readonly signal?: AbortSignal } = {},
	): Promise<readonly AvailableModel[]> {
		return (await this.listAvailableModelsWithSources(options)).models;
	}

	/**
	 * A lista de modelos, com **quais provedores responderam** (R4S).
	 *
	 * `answered` separa "esta é a lista válida agora" de "é a cópia anterior
	 * porque a atualização falhou". A distinção não existia, e quem a inferia
	 * pelo relógio de `listedAt` marcava como falha um acerto de cache —
	 * dizendo "o endpoint não respondeu" sobre uma lista recentíssima.
	 */
	/**
	 * Pergunta ao `/models` de **um** provedor e devolve o que ele publicou.
	 *
	 * Reusa exatamente a descoberta da listagem normal — mesma fonte, mesmo
	 * registro, mesmo cache — para o botão "Descobrir modelos" do painel. Não
	 * escolhe nada nem apaga o que já existe: só pergunta e registra.
	 *
	 * DEV-8.17: a falha **precisa** chegar a quem pediu. Antes ela era engolida
	 * e a resposta era `{ models: [] }` — indistinguível de "este endpoint não
	 * tem modelos", que é exatamente o que um usuário não pode confundir.
	 * Os modelos já gravados continuam valendo (o Core não os apaga); o que
	 * muda é a resposta dizer que a pergunta falhou e por quê.
	 */
	async discoverModels(providerId?: string): Promise<{
		readonly models: readonly string[];
		/**
		 * Os modelos com o provedor de cada um.
		 *
		 * Separado de `models` para não mudar o que a tela já lê: a lista de ids
		 * continua sendo ids. Quem precisa saber **de quem** é cada modelo — a
		 * ferramenta do agente — lê esta lista.
		 */
		readonly byProvider?: readonly { readonly providerId: string; readonly model: string }[];
		readonly failed?: readonly { readonly providerId: string; readonly reason: string }[];
	}> {
		const withSources = await this.listAvailableModelsWithSources();
		const entries = withSources.models.filter(
			(entry) => providerId === undefined || entry.providerId === providerId,
		);
		const models = entries.map((entry) => entry.model);
		const byProvider = entries.map((entry) => ({ providerId: entry.providerId, model: entry.model }));
		const failed = [...withSources.failed.entries()]
			.filter(([id]) => providerId === undefined || id === providerId)
			.map(([id, reason]) => ({ providerId: id, reason }));
		return { models, byProvider, ...(failed.length > 0 ? { failed } : {}) };
	}

	async listAvailableModelsWithSources(
		options: { readonly signal?: AbortSignal } = {},
	): Promise<{
		readonly models: readonly AvailableModel[];
		readonly answered: ReadonlySet<string>;
		readonly failed: ReadonlyMap<string, string>;
	}> {
		const providers = this.config
			.list()
			// O buscador da web não tem modelos: listá-lo faria o roteador
			// tentar responder um turno com uma API de busca.
			.filter((provider) => provider.enabled && provider.role !== 'search')
			.map((provider) => ({
				config: provider,
				key: discoveryKey(provider.id, provider.baseUrl),
			}));

		const sources = new Map<string, ModelListSource>();
		for (const provider of providers) {
			sources.set(
				provider.key,
				discoverySource(
					provider.key,
					this.resolveProvider(provider.config.id),
					this.discoveryTimeoutMs,
					this.published,
					this.publishedHeaders,
				),
			);
		}

		const results = await this.discovery.queryMany(
			providers.map((provider) => provider.key),
			sources,
			options.signal !== undefined ? { signal: options.signal } : {},
		);

		const available: AvailableModel[] = [];
		const answered = new Set<string>();
		const failed = new Map<string, string>();
		for (const [index, result] of results.entries()) {
			const provider = providers[index];
			if (provider === undefined) {
				continue;
			}
			if ('error' in result) {
				this.logger.warn('Could not list models for a provider', {
					providerId: provider.config.id,
					reason: result.error instanceof Error ? result.error.message : String(result.error),
				});
				// A listagem falhou: o que já estava gravado continua servido,
				// marcado como desatualizado. Nada é apagado.
				failed.set(
					provider.config.id,
					result.error instanceof Error ? result.error.message : String(result.error),
				);
				await this.providerDiscovery.recordListingFailure(provider.config.id, result.error);
				continue;
			}
			if (result.stale) {
				// The list is still usable, but the user should be able to tell
				// that it is not what the server says right now.
				this.logger.warn('Serving a stale model list after a failed refresh', {
					providerId: provider.config.id,
					fetchedAtMs: result.fetchedAtMs,
				});
			} else {
				// Da fonte agora (servidor ou cache ainda válido): é a resposta
				// boa de agora, não uma falha.
				answered.add(provider.config.id);
			}
			for (const model of result.models) {
				available.push({
					providerId: provider.config.id,
					providerName: provider.config.name,
					model,
				});
			}
			// A resposta de `/models` é o que o provedor publica: é daqui que
			// saem preço, contexto e acesso gratuitos publicados, com a data da
			// verificação. Só quando veio do servidor agora: uma cópia antiga do
			// cache não é uma verificação nova.
			if (!result.stale) {
				await this.providerDiscovery.recordListing(
					provider.config.id,
					this.published.get(provider.key) ?? [],
					{ fetchedAt: new Date(result.fetchedAtMs), quotaHeaders: this.publishedHeaders.get(provider.key) },
				);
			}
		}
		return { models: available, answered, failed };
	}

	// ── model catalog ───────────────────────────────────────────────────────
	//
	// A read-and-write surface over `FileDataStore`'s catalog, with no model
	// selection anywhere near it: nothing below chooses, ranks or recommends.
	// Listing what a model costs must not be able to change which one answers.

	async listModelCatalog(providerId?: string): Promise<readonly ModelCatalogEntryView[]> {
		const entries = await this.history.listModelCatalog(
			providerId !== undefined && providerId.length > 0 ? { providerId } : {},
		);
		return entries.map(toCatalogView);
	}

	async getModelCatalogEntry(key: ModelCatalogKey): Promise<ModelCatalogEntryView | undefined> {
		const entry = await this.history.getModelCatalogEntry(key);
		return entry === undefined ? undefined : toCatalogView(entry);
	}

	/**
	 * Creates or edits what is declared about a model.
	 *
	 * The form sends strings and this sends numbers, so the two boundaries are
	 * converted here where both are visible. A blank box becomes `null` — "put
	 * this back to unknown" — and never `0`, which would be a claim the model is
	 * free and accepts no tokens.
	 */
	async saveModelCatalogEntry(input: SaveModelCatalogInput): Promise<ModelCatalogEntryView> {
		const capabilities = input.capabilities;
		const saved = await this.history.saveModelCatalogEntry({
			providerId: input.providerId,
			modelId: input.modelId,
			...(capabilities !== undefined
				? { capabilities: parseCapabilityList(capabilities) }
				: {}),
			...(input.pricing !== undefined
				? {
						pricing:
							input.pricing === null || isBlankPricing(input.pricing)
								? null
								: toPricing(input.pricing),
					}
				: {}),
			...(input.access !== undefined ? { access: input.access } : {}),
			...(input.limits !== undefined
				? { limits: input.limits === null ? null : toLimits(input.limits) }
				: {}),
			...(input.model !== undefined ? { model: input.model } : {}),
			...(input.notes !== undefined
				? { notes: input.notes === null || input.notes.trim().length === 0 ? null : input.notes }
				: {}),
		});
		return toCatalogView(saved);
	}

	async removeModelCatalogEntry(key: ModelCatalogKey): Promise<boolean> {
		// The store writes only its own file, so this cannot reach the provider's
		// configuration or its stored key - see `MODELS_FILE` in the adapter.
		return this.history.removeModelCatalogEntry(key);
	}

	/**
	 * Os limites de orçamento, como a tela os edita.
	 *
	 * Os campos de escopo vão como `''` quando não existem: o formulário tem um
	 * campo de provedor e outro de modelo sempre visíveis, e trocar ausente por
	 * vazio só no bridge faria a mesma tela ler dois formatos.
	 */
	async listSpendingLimits(): Promise<readonly SpendingLimitView[]> {
		const limits = await this.history.listSpendingLimits();
		return limits.map(toSpendingLimitView);
	}

	/**
	 * Cria ou troca o limite de um escopo.
	 *
	 * O valor chega como texto, como no preço do catálogo: uma caixa vazia é
	 * "sem valor" e é recusada, e `0` é um teto real ("não gaste nada"). O
	 * escopo identifica o limite, então salvar de novo atualiza o teto.
	 */
	async saveSpendingLimit(input: SaveSpendingLimitViewInput): Promise<SpendingLimitView> {
		const amount = input.amount.trim();
		if (amount.length === 0) {
			throw new Error('Informe um valor para o limite de orçamento.');
		}
		const parsed = Number(amount.replace(',', '.'));
		if (!Number.isFinite(parsed)) {
			throw new Error(`Valor de limite inválido: ${JSON.stringify(input.amount)}`);
		}
		const saved = await this.history.saveSpendingLimit({
			...(input.providerId !== undefined && input.providerId.trim().length > 0
				? { providerId: input.providerId.trim() }
				: {}),
			...(input.modelId !== undefined && input.modelId.trim().length > 0
				? { modelId: input.modelId.trim() }
				: {}),
			// Um limite sem política vale para todas; um com política vale
			// só quando ela está em vigor. A chave do escopo inclui a
			// política, para que os dois tetos convivam.
			...(input.policy !== undefined && input.policy !== 'any' ? { policy: input.policy } : {}),
			currency: input.currency,
			amount: parsed,
			window: input.window,
		});
		return toSpendingLimitView(saved);
	}

	async removeSpendingLimit(limitId: string): Promise<boolean> {
		return this.history.removeSpendingLimit(limitId);
	}

	/**
	 * O consumed do período corrente, agregado.
	 *
	 * A janela termina "agora": o dia ou o mês que o usuário está vivendo, no
	 * fuso local - não uma janela de 24 h correndo. O consumo vem do ledger
	 * recalculado por tentativa (`usageFor`), então o mesmo número que o limite
	 * compara é o que a tela mostra.
	 */
	async readBudget(window: 'day' | 'month' = 'month'): Promise<BudgetReportView> {
		const range = windowRange(window, new Date());
		const executions = await this.history.listConsumption({ since: range.since, until: range.until });
		const attempts = new Map<string, readonly AttemptRecord[]>();
		for (const execution of executions) {
			attempts.set(execution.executionId, await this.history.listAttempts(execution.executionId));
		}
		// Os totais de cada execução são recalculados só com as tentativas dela:
		// o `totals` gravado é cache e pode estar atrás depois de uma escrita
		// interrompida (o mesmo motivo de `summarizeStoredExecution`).
		const reconciled = executions.map((execution) => ({
			...execution,
			totals: summarizeExecution(attempts.get(execution.executionId) ?? []),
		}));
		const summary = aggregateUsage(reconciled, range);
		const conversations = await this.conversationUsageViews(usageByChat(reconciled));
		return {
			period: { ...range, window },
			total: toBudgetUsageView(summary.total),
			byProvider: summary.byProvider.map(toBudgetSliceView),
			byModel: summary.byModel.map(toBudgetSliceView),
			byExecution: summary.byExecution.map(toBudgetSliceView),
			byConversation: conversations,
			limits: await this.listSpendingLimits(),
			alerts: await this.listBudgetAlerts(),
		};
	}

	/**
	 * As conversas do período, com título e a previsão do próximo turno.
	 *
	 * O título vem do armazenamento; uma conversa apagada continua listada pelo
	 * id, porque o gasto dela aconteceu e escondê-lo faria o total da tela não
	 * fechar com o do período.
	 */
	private async conversationUsageViews(
		usage: readonly ConversationUsage[],
	): Promise<readonly ConversationUsageView[]> {
		const views: ConversationUsageView[] = [];
		for (const entry of usage) {
			let title: string | undefined;
			try {
				title = (await this.history.getConversation(entry.conversationId))?.title;
			} catch (error) {
				this.logger.warn('Could not read a conversation for the budget view', {
					conversationId: entry.conversationId,
					error: describeError(error),
				});
			}
			const lastTurn = entry.turns[entry.turns.length - 1];
			const providerId = lastTurn?.providerIds[lastTurn.providerIds.length - 1];
			const modelId = lastTurn?.modelIds[lastTurn.modelIds.length - 1];
			const forecast =
				this.budgetGate !== undefined && providerId !== undefined && modelId !== undefined
					? await this.budgetGate
							.preview({ providerId, modelId }, '', entry.conversationId)
							.catch(() => undefined)
					: undefined;
			views.push(toConversationUsageView(entry, title, forecast));
		}
		return views;
	}

	/**
	 * A previsão do próximo turno, para o modelo que o turno vai chamar.
	 *
	 * `promptText` é o texto do turno em andamento. Sem `budgetGate` (roteamento
	 * desligado) a previsão continua sendo possível a partir do catálogo e do
	 * ledger: ela não depende de orçamento, só de dados.
	 */
	async forecastCall(input: ForecastRequestView): Promise<CallForecastView> {
		const forecast = await this.computeForecast(input);
		if (forecast === undefined) {
			// Sem catálogo não há preço: a resposta honesta é `unknown`, não um
			// erro que a tela teria de traduzir.
			return toForecastView({
				providerId: input.providerId,
				modelId: input.modelId,
				access: 'unknown',
				cost: { status: 'unknown', reasons: ['não foi possível ler o catálogo'] },
				inputTokens: 0,
				inputBasis: 'none',
				outputBasis: 'none',
				samples: 0,
				confidence: 'unknown',
				truncated: false,
			});
		}
		return toForecastView(forecast);
	}

	private async computeForecast(input: ForecastRequestView): Promise<CallForecast | undefined> {
		if (this.budgetGate !== undefined) {
			return this.budgetGate.preview(
				{ providerId: input.providerId, modelId: input.modelId },
				input.promptText,
				input.conversationId,
			);
		}
		// The gate is the one place that knows how to read prices and samples;
		// without routing the session builds a gate on demand, over the same
		// store, rather than duplicating the reading here.
		const gate = createBudgetGate({
			store: this.history,
			allowPaid: this.allowPaid,
			onFailure: (error, context) =>
				this.logger.warn('Could not forecast a call', {
					error: describeError(error),
					phase: context.phase,
				}),
		});
		return gate.preview(
			{ providerId: input.providerId, modelId: input.modelId },
			input.promptText,
			input.conversationId,
		);
	}

	/**
	 * Os avisos de 80% ativos.
	 *
	 * Percorre os limites e mede o gasto do período de cada um; um limite
	 * esgotado também é um aviso (com a fração acima de 100%), porque "chegou
	 * a 80% e depois passou do teto" não é uma condição que deva sumir.
	 */
	async listBudgetAlerts(): Promise<readonly BudgetAlertView[]> {
		if (this.budgetGate === undefined) {
			return [];
		}
		const alerts: BudgetAlertView[] = [];
		for (const limit of await this.history.listSpendingLimits()) {
			const alert = await this.budgetGate
				.alert({
					providerId: limit.providerId ?? '',
					modelId: limit.modelId ?? '',
				})
				.catch(() => undefined);
			if (alert !== undefined) {
				alerts.push(toAlertView(alert));
			}
		}
		return alerts;
	}

	/**
	 * O que os provedores publicaram, com a origem e a validade de cada fato.
	 *
	 * Nunca inventa: um modelo que nunca respondeu a uma chamada não tem
	 * `accessConfirmedAt`; um que saiu da listagem continua listado no arquivo
	 * com `missingSince`; um preço é exibido mesmo vencido, marcado `stale`.
	 */
	async listDiscoveredModels(providerId?: string): Promise<readonly DiscoveredModelView[]> {
		const nowMs = Date.now();
		const models = await this.history.listDiscoveredModels(providerId);
		return models.map((model) => toDiscoveredModelView(model, nowMs));
	}

	/** As cotas que a API informou, por provedor e modelo. Origem preservada. */
	async listDiscoveredQuotas(providerId?: string): Promise<readonly DiscoveredQuotaView[]> {
		const records = await this.history.listQuotas(providerId);
		return records.map(toQuotaView);
	}

	/**
	 * O catálogo fundido: o que o usuário declarou, o que o provedor publicou e
	 * o que a política permite — lado a lado, nunca somados.
	 *
	 * É a leitura da janela de configuração. Não grava nada, não troca nada de
	 * lado: a fusão é uma *visão*, e o lado em vigor é a escolha gravada.
	 */
	async listMergedCatalog(providerId?: string): Promise<{
		readonly policy: AccessPolicyView;
		readonly models: readonly MergedModelView[];
	}> {
		const record = await this.loadAccessPolicy();
		const nowMs = Date.now();
		const [discovered, catalog] = await Promise.all([
			this.safeListDiscovered(),
			this.safeListModelCatalog(),
		]);
		const declaredByKey = new Map(
			catalog.map((entry) => [`${entry.providerId}:${entry.modelId}`, entry]),
		);
		const evidence = await this.freeEvidenceIndex(nowMs);
		const models: MergedModelView[] = [];
		for (const model of discovered) {
			if (providerId !== undefined && model.providerId !== providerId) {
				continue;
			}
			const key = `${model.providerId}:${model.modelId}`;
			const declared = declaredByKey.get(key);
			const free = evidence.get(key);
			const verdict = evaluatePolicy(
				{
					providerId: model.providerId,
					modelId: model.modelId,
					...(free !== undefined ? { freeEvidence: free } : {}),
				},
				record.policy,
			);
			models.push(
				toMergedModelView({
					model,
					...(declared !== undefined
						? {
								declared: {
									...(declared.pricing !== undefined ? { pricing: declared.pricing } : {}),
									access: declared.access,
									updatedAt: declared.updatedAt,
									...(declared.limits !== undefined ? { limits: declared.limits } : {}),
									...(declared.model !== undefined ? { model: declared.model } : {}),
								},
							}
						: {}),
					chosen: record.priceSource,
					policy: record,
					policyStatus: {
						policy: record.policy,
						eligible: verdict.eligible,
						...(verdict.eligible ? {} : { reason: verdict.reason }),
						...(free !== undefined ? { evidenceSource: free.source } : {}),
					},
					nowMs,
					limitsSource: record.limitsSource,
					capabilitiesSource: record.capabilitiesSource,
				}),
			);
		}
		return {
			policy: {
				policy: record.policy,
				priceSource: record.priceSource,
				limitsSource: record.limitsSource,
				capabilitiesSource: record.capabilitiesSource,
				updatedAt: record.updatedAt,
				changedBy: record.changedBy,
				hint: 'Evelyn, use somente os modelos gratuitos',
			},
			models,
		};
	}

	/**
	 * O catálogo fundido, como o seletor e a tela o veem.
	 *
	 * É a **mesma** fusão que a tela mostra: os limites e as capacidades
	 * efetivos que o roteador usa são os que a interface exibe, porque ambos
	 * saem daqui. O catálogo gravado não é tocado — a fusão é uma vista.
	 */
	async fusedCatalog(): Promise<readonly ModelCatalogEntry[]> {
		const record = await this.loadAccessPolicy();
		const nowMs = Date.now();
		const [discovered, catalog] = await Promise.all([
			this.safeListDiscovered(),
			this.safeListModelCatalog(),
		]);
		const metadata = new Map<string, DiscoveredMetadata>();
		for (const model of discovered) {
			const key = `${model.providerId}:${model.modelId}`;
			const limits = model.limits;
			const capabilities = model.capabilities;
			if (limits === undefined && capabilities === undefined) {
				continue;
			}
			metadata.set(key, {
				...(limits !== undefined
					? {
							limits: {
								value: limits.limits,
								source: limits.source,
								verifiedAt: limits.verifiedAt,
								expiresAt: limits.expiresAt,
								stale: limits.stale,
							},
						}
					: {}),
				...(capabilities !== undefined
					? {
							capabilities: {
								value: capabilities.capabilities,
								source: capabilities.source,
								verifiedAt: capabilities.verifiedAt,
								expiresAt: capabilities.expiresAt,
								stale: capabilities.stale,
							},
						}
					: {}),
			});
		}
		return fuseCatalog(catalog, metadata, {
			priceSource: record.priceSource,
			limitsSource: record.limitsSource,
			capabilitiesSource: record.capabilitiesSource,
		}, nowMs);
	}

	/**
	 * Os relatórios de decisão, do mais recente para o mais antigo.
	 *
	 * Vêm do log de orquestração, que é onde a entrada já vive: o relatório é
	 * uma parte da entrada, não um arquivo à parte. Nenhum deles carrega
	 * conversa, chave ou cabeçalho.
	 */
	async listDecisionReports(limit = 20): Promise<readonly RoutingDecisionReport[]> {
		const entries = await this.orchestrationLog.list({ limit: Math.max(1, limit) });
		return entries
			.map((entry) => entry.decision)
			.filter((decision): decision is RoutingDecisionReport => decision !== undefined);
	}

	/**
	 * O histórico de execuções, com o identificador e a data de cada uma.
	 *
	 * O histórico **é** o log de orquestração, que já é limitado (500
	 * entradas) e reescrito por inteiro a cada uso. Nada é duplicado: a
	 * latência e os tokens que a tela quer já estão na entrada da tentativa,
	 * e a tentativa já está no relatório.
	 */
	async listExecutionHistory(limit = 20): Promise<readonly HistoryExecution[]> {
		const entries = await this.orchestrationLog.list({ limit: Math.max(1, limit) });
		return entries.flatMap((entry) =>
			entry.decision === undefined
				? []
				: [
						{
							executionId: entry.id,
							timestamp: entry.timestamp,
							conversationId: entry.conversationId,
							report: entry.decision,
						},
					],
		);
	}

	/**
	 * Compara duas execuções do histórico.
	 *
	 * A resposta é sempre explícita: **aceita** (as condições eram as
	 * mesmas), **limitada** (há o que comparar, mas as condições diferem — e
	 * o relatório diz como) ou **recusada** (não há o que comparar).
	 */
	async compareExecutions(
		first: string,
		second: string,
	): Promise<ComparisonOutcome> {
		const history = await this.listExecutionHistory(200);
		const a = history.find((execution) => execution.executionId === first);
		const b = history.find((execution) => execution.executionId === second);
		return compareExecutions(a, b);
	}

	/**
	 * Quais modelos podem ser chamados agora, sob as regras do usuário.
	 *
	 * `onlyFree` filtra por acesso gratuito **confirmado e ainda válido**:
	 * gratuito vencido vira desconhecido, e desconhecido não passa. Sem a
	 * opção, o resultado é a listagem atual sem os modelos com a cota
	 * esgotada nesta sessão. Nada aqui bloqueia: é uma leitura.
	 */
	async listUsableModels(options: { readonly onlyFree?: boolean } = {}): Promise<readonly DiscoveredModelView[]> {
		const nowMs = Date.now();
		const all = await this.history.listDiscoveredModels();
		const usable = all.filter((model) => {
			if (!model.listed) {
				return false;
			}
			const check = this.quotaTracker.check({ providerId: model.providerId, modelId: model.modelId });
			if (!check.allowed) {
				return false;
			}
			if (options.onlyFree === true) {
				return this.isConfirmedFree(model, nowMs);
			}
			return true;
		});
		return usable.map((model) => toDiscoveredModelView(model, nowMs));
	}

	// �� política de acesso e a fusão de preço �����������������������������������

	/**
	 * A política em vigor, lida do disco a cada turno.
	 *
	 * Lida a cada turno e não guardada em memória porque o usuário pode mudá-la
	 * pela janela enquanto a sessão está aberta. Um disco ilegível cai no padrão
	 * e é logado: uma política que não pode ser lida não pode ser imposta, e o
	 * padrão (`any`) é o mesmo comportamento de antes desta etapa.
	 */
	async loadAccessPolicy(): Promise<ModelAccessPolicyRecord> {
		if (this.accessPolicyReader !== undefined) {
			return this.accessPolicyReader();
		}
		try {
			return (await this.history.readAccessPolicy()) ?? DEFAULT_ACCESS_POLICY;
		} catch (error) {
			this.logger.warn('Could not read the model access policy; using the default', {
				error: describeError(error),
			});
			return DEFAULT_ACCESS_POLICY;
		}
	}

	/** Grava a política. Chamada pela janela e pela frase do usuário. */
	async saveAccessPolicy(input: {
		readonly policy?: ModelAccessPolicy;
		readonly priceSource?: 'user' | 'discovered';
		readonly limitsSource?: 'user' | 'discovered';
		readonly capabilitiesSource?: 'user' | 'discovered';
		readonly changedBy?: 'user' | 'phrase';
	}): Promise<ModelAccessPolicyRecord> {
		const current = await this.loadAccessPolicy();
		const record: ModelAccessPolicyRecord = {
			policy: input.policy ?? current.policy,
			priceSource: input.priceSource ?? current.priceSource,
			limitsSource: input.limitsSource ?? current.limitsSource,
			capabilitiesSource: input.capabilitiesSource ?? current.capabilitiesSource,
			updatedAt: new Date().toISOString(),
			changedBy: input.changedBy ?? 'user',
		};
		return this.history.saveAccessPolicy(record);
	}

	/**
	 * Aplica a política à lista de modelos disponíveis.
	 *
	 * Devolve os modelos permitidos **e** uma explicação, porque a recusa é uma
	 * das respostas possíveis: com `free_only` e nenhum gratuito confirmado, o
	 * resultado é uma lista vazia e uma frase que diz por que nenhuma chamada
	 * foi feita. Não há substituição silenciosa por um modelo pago.
	 */
	async applyAccessPolicy(
		record: ModelAccessPolicyRecord,
		available: readonly AvailableModel[],
	): Promise<{
		readonly policy: ModelAccessPolicy;
		readonly allowedModels: readonly AvailableModel[];
		readonly excluded: readonly {
			readonly providerId: string;
			readonly modelId: string;
			readonly reason: string;
		}[];
		readonly explanation: string;
	}> {
		if (record.policy === 'any' || available.length === 0) {
			return {
				policy: record.policy,
				allowedModels: [...available],
				excluded: [],
				explanation:
					available.length === 0
						? 'Nenhum modelo foi descoberto nos provedores conectados.'
						: '',
			};
		}
		const nowMs = Date.now();
		const evidence = await this.freeEvidenceIndex(nowMs);
		const candidates: (AvailableModel & PolicyCandidate)[] = available.map((model) => ({
			...model,
			providerId: model.providerId,
			modelId: model.model,
			...(evidence.get(`${model.providerId}:${model.model}`) !== undefined
				? { freeEvidence: evidence.get(`${model.providerId}:${model.model}`) as FreeEvidence }
				: {}),
		}));
		const ordered = orderByPolicy(candidates, record.policy);
		const allowed = new Set(ordered.map((model) => `${model.providerId}:${model.modelId}`));
		const allowedModels = available.filter((model) => allowed.has(`${model.providerId}:${model.model}`));
		// Os que a política removeu entram no relatório: eles não chegaram a
		// ser pontuados, e dizer "não foram avaliados" é diferente de dizer
		// "tiveram um score baixo".
		const excluded = candidates
			.filter((model) => !allowed.has(`${model.providerId}:${model.modelId}`))
			.map((model) => ({
				providerId: model.providerId,
				modelId: model.modelId,
				reason:
					record.policy === 'free_only'
						? 'a política "somente gratuitos" exige acesso gratuito confirmado, e este modelo não tem'
						: 'a política de acesso não permite este modelo',
			}));

		if (record.policy === 'free_only' && allowedModels.length === 0) {
			const expired = candidates.filter(
				(model) =>
					model.freeEvidence?.access === 'free' && model.freeEvidence.usable === false,
			).length;
			return {
				policy: record.policy,
				allowedModels: [],
				excluded,
				explanation: describeNoEligibleModel({ total: candidates.length, expired }),
			};
		}
		if (allowedModels.length === 0) {
			return {
				policy: record.policy,
				allowedModels: [],
				excluded,
				explanation: 'Nenhum modelo elegível encontrado para esta tarefa.',
			};
		}
		return { policy: record.policy, allowedModels, excluded, explanation: '' };
	}

	/**
	 * A prova de gratuidade de cada modelo, fundindo as duas fontes legítimas.
	 *
	 * O usuário classificou o modelo como gratuito no catálogo, ou o provedor
	 * publicou zero nos dois sentidos e a evidência ainda vale. Nenhuma outra
	 * coisa entra: um preço zero isolado não aparece aqui.
	 */
	private async freeEvidenceIndex(nowMs: number): Promise<Map<string, FreeEvidence>> {
		const index = new Map<string, FreeEvidence>();
		// O catálogo é a palavra do usuário; ele vence a do provedor quando o
		// usuário disse explicitamente que o modelo é gratuito.
		for (const entry of await this.safeListModelCatalog()) {
			if (entry.access === 'free' || entry.access === 'paid') {
				index.set(`${entry.providerId}:${entry.modelId}`, {
					access: entry.access,
					source: 'manual',
					usable: true,
				});
			}
		}
		for (const model of await this.safeListDiscovered()) {
			const key = `${model.providerId}:${model.modelId}`;
			// Uma classificação do usuário não é substituída pela do provedor.
			if (index.get(key)?.source === 'manual') {
				continue;
			}
			const access = model.access;
			if (access === undefined) {
				continue;
			}
			index.set(key, {
				access: access.access,
				source: access.source,
				usable: this.isConfirmedFree(model, nowMs),
			});
		}
		return index;
	}

	private async safeListModelCatalog(): Promise<readonly ModelCatalogEntry[]> {
		try {
			return await this.history.listModelCatalog();
		} catch (error) {
			this.logger.warn('Could not read the catalog while applying the access policy', {
				error: describeError(error),
			});
			return [];
		}
	}

	private async safeListDiscovered(): Promise<readonly DiscoveredModel[]> {
		try {
			return await this.history.listDiscoveredModels();
		} catch (error) {
			this.logger.warn('Could not read provider discovery while applying the access policy', {
				error: describeError(error),
			});
			return [];
		}
	}

	/** Um modelo descoberto, ou `undefined` quando a leitura falha. */
	private async safeDiscoveredModel(candidate: {
		readonly providerId: string;
		readonly modelId: string;
	}): Promise<DiscoveredModel | undefined> {
		try {
			return await this.history.getDiscoveredModel(candidate);
		} catch (error) {
			this.logger.warn('Could not read the discovered model while reporting a decision', {
				providerId: candidate.providerId,
				modelId: candidate.modelId,
				error: describeError(error),
			});
			return undefined;
		}
	}

	/** `free` só com evidência fresca, de fonte que fala por esta conta. */
	private isConfirmedFree(model: DiscoveredModel, nowMs: number): boolean {		const access = model.access;
		if (access?.access !== 'free' || access.stale) {
			return false;
		}
		if (Date.parse(access.expiresAt) <= nowMs) {
			return false;
		}
		// Um preço publicado antes da listagem atual continua sendo a
		// evidência; um vencido não. A fonte tem de ser o provedor.
		return access.source === 'provider' || access.source === 'account';
	}

	/**
	 * Espera o turno terminar de ser contabilizado.	 *
	 * `sendMessage` resolve quando o turno é aceito, não quando ele termina:
	 * o evento terminal chega pelo `sink`, e o registro de consumo que fecha o
	 * turno vem logo depois. Quem precisa ler o ledger — a próxima checagem de
	 * orçamento, a previsão, uma tela de consumo — espera por aqui em vez de
	 * dormir e torcer. Um turno desconhecido resolve imediatamente: esperar por
	 * algo que não existe não informa nada.
	 */
	async waitForTurn(turnId: string): Promise<void> {
		await this.turnCompletions.get(turnId);
	}

	/**
	 * Records one measurement against a model.
	 *
	 * The declared, renderer-facing write. A turn's own measurements do not come
	 * through here: when routing is enabled the session's metrics port writes
	 * them straight to the same store, from the engine's attempt records. This
	 * method stays the explicit seam the settings form uses, so the desktop layer
	 * still owns the store rather than the renderer reaching past it.
	 */
	async recordModelObservation(
		key: CatalogKey,
		observation: Omit<ModelObservation, 'at'> & { readonly at?: string },
	): Promise<ModelCatalogEntryView> {
		return toCatalogView(await this.history.recordModelObservation(key, observation));
	}

	/**
	 * Every conversation, most recently active first.
	 *
	 * Not filtered by provider. It used to be, on the assumption that a
	 * conversation is bound to one provider — but a turn names its own provider
	 * (`sendMessage` takes one), so a conversation is a transcript and a provider
	 * is a per-turn choice. Filtering by it made switching models swap the
	 * conversation list, which read as the app throwing the conversation away.
	 *
	 * A conversation still records the provider it was created with, which is
	 * where it came from — not a constraint on what may continue it.
	 *
	 * Sorted here rather than leaving the order to the caller, because a
	 * conversation list whose order depends on directory iteration is a list the
	 * user cannot predict.
	 */
	async listConversations(): Promise<readonly ConversationListItem[]> {
		const summaries = await this.history.listConversations();
		// Read in full rather than reusing the list entry: the list view does not
		// expose the transcript, and the sidebar's message count has to match what
		// opening the conversation would show.
		const records = await Promise.all(
			summaries.map((summary) => this.history.getConversation(summary.id)),
		);
		return records
			.filter((record): record is ConversationRecord => record !== undefined)
			.sort((a, b) =>
				a.updatedAt === b.updatedAt ? a.id.localeCompare(b.id) : a.updatedAt < b.updatedAt ? 1 : -1,
			)
			.map(toConversationListItem);
	}

	/**
	 * Opens one conversation with its transcript.
	 *
	 * Throws when the id is unknown: the renderer asked for a specific
	 * conversation, and quietly returning an empty one would look like the
	 * history had been lost.
	 */
	async openConversation(conversationId: string): Promise<ConversationView> {
		const record = await this.history.getConversation(conversationId);
		if (record === undefined) {
			throw new Error(`No conversation with id "${conversationId}" exists`);
		}
		return toView(record);
	}

	// ── projects ────────────────────────────────────────────────────────────

	/**
	 * Projects, whose directories the tools may work in.
	 *
	 * Sorted by name so the picker is stable across restarts — directory order is
	 * not, and a list whose order changes on its own is one the user cannot find
	 * anything in.
	 */
	async listProjects(): Promise<readonly ProjectListItem[]> {
		const projects = await this.history.listProjects();
		return [...projects]
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((project) =>
				parseProjectListItem({
					id: project.id,
					name: project.name,
					rootPath: project.rootPath,
				}),
			);
	}

	/**
	 * Creates a project.
	 *
	 * The directory is not created: a project is a place the user has already
	 * pointed Evelyn at, and making one would create directories nobody asked
	 * for. The path is resolved so a relative one means the same thing now and
	 * after a restart.
	 */
	async createProject(input: {
		readonly name?: string;
		readonly rootPath: string;
	}): Promise<ProjectListItem> {
		const rootPath = resolve(input.rootPath);
		const project = await this.history.createProject({
			// A blank name falls back to the folder's own name, so the picker is
			// never full of identical entries.
			name:
				input.name !== undefined && input.name.trim().length > 0
					? input.name.trim()
					: basename(rootPath),
			rootPath,
		});
		this.logger.info('Project created', { projectId: project.id });
		return parseProjectListItem({
			id: project.id,
			name: project.name,
			rootPath: project.rootPath,
		});
	}

	// ── conversations ───────────────────────────────────────────────────────

	/**
	 * Creates a conversation for a provider, optionally inside a project.
	 *
	 * The provider must exist: a conversation that can never be used would sit in
	 * the sidebar looking like a bug.
	 *
	 * The project is optional and means something different from the provider: it
	 * is the directory the tools may touch. Before this stage both were the same
	 * field, which meant the tools had no workspace to confine themselves to the
	 * moment a real project existed.
	 */
	async createConversation(input: CreateConversationInput): Promise<ConversationView> {
		// Validates the id, so an unknown provider fails here rather than
		// producing an unusable conversation.
		this.resolveProvider(input.providerId);
		if (input.projectId !== undefined) {
			const project = await this.history.getProject(input.projectId);
			if (project === undefined) {
				throw new Error(`No project named "${input.projectId}" exists`);
			}
		}

		const record = await this.history.createConversation({
			providerId: input.providerId,
			...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
			// The store takes its own clock, so it is told what "now" is. Without
			// this the injected clock would be decorative and the list order a test
			// asserts would come from the real clock instead.
			createdAt: this.clock(),
			...(input.title !== undefined && input.title.trim().length > 0
				? { title: input.title.trim() }
				: {}),
		});
		if (input.systemPrompt !== undefined && input.systemPrompt.trim().length > 0) {
			const withPrompt = await this.history.setSystemPrompt(
				record.id,
				input.systemPrompt,
			);
			return toView(withPrompt);
		}
		return toView(record);
	}

	async renameConversation(conversationId: string, title: string): Promise<ConversationListItem> {
		return toConversationListItem(await this.history.renameConversation(conversationId, title));
	}

	/** Sets or clears the system prompt. Empty removes it. */
	async setSystemPrompt(conversationId: string, content: string): Promise<ConversationListItem> {
		return toConversationListItem(await this.history.setSystemPrompt(conversationId, content));
	}

	/**
	 * Marca ou desmarca a conversa como permanente.
	 *
	 * A regra de "não pode ser excluída" mora no store, que é quem apaga; aqui
	 * só se grava a intenção, para a lista e o diálogo fixo poderem se achar.
	 */
	async setConversationPinned(conversationId: string, pinned: boolean): Promise<ConversationListItem> {
		return toConversationListItem(
			await this.history.setConversationPinned(conversationId, pinned),
		);
	}

	/**
	 * Exclui uma conversa.
	 *
	 * Devolve o desfecho do store **sem convertê-lo em booleano** (R4M):
	 * `absent` e `unknown` precisam chegar distintos a quem responde a
	 * requisição — um é "já não existia", o outro é "não sei".
	 */
	async deleteConversation(conversationId: string): Promise<ConversationDeleteOutcome> {
		return this.history.deleteConversation(conversationId);
	}

	/**
	 * Accepts an agent turn and streams its answer through `sink`.
	 *
	 * Returns as soon as the turn is accepted — it does not wait for the model.
	 * Everything after that arrives as events on the sink, which is what lets the
	 * answer stream token by token across an IPC boundary.
	 *
	 * The conversation is named explicitly by the caller. Nothing is created
	 * implicitly: a turn that landed in a freshly invented conversation because
	 * the renderer forgot to pass an id would be a silent loss of history.
	 *
	 * A second send while a turn is running is refused rather than queued: two
	 * concurrent answers would interleave into one message.
	 */
	async sendMessage(input: SendMessageInput, sink: AgentEventSink): Promise<SendMessageAck> {
		if (this.inFlight !== undefined) {
			throw new Error('A turn is already running. Stop it before sending another.');
		}

		// Reserved before the first `await`: a second send arriving while this
		// one is still resolving its conversation has to see the slot taken.
		// Reserving afterwards let both sends pass the guard above, and the
		// second overwrote `inFlight` — two turns running over one session,
		// with `stop()` reaching only the one still registered.
		this.turnCounter += 1;
		const turnId = `turn-${this.turnCounter}`;
		const controller = new AbortController();
		this.inFlight = { turnId, controller };
		this.conversationInFlight = input.conversationId;
		this.pendingTurns.set(turnId, input.conversationId);
		this.pendingTurns.set(turnId, input.conversationId);
		this.turnInFlight = turnId;

		// Everything after the reservation can still throw — a missing
		// conversation, an unknown provider, a storage failure — and `runTurn`,
		// which owns releasing the slot, is never reached in that case. Without
		// the `finally` the slot stays taken forever, and every later send is
		// refused with "a turn is already running" until the app restarts.
		let handedOff = false;
		try {
			// Checked before anything is written, so a bad id fails the send
			// itself instead of leaving a turn registered that can never start.
			const conversation = await this.history.getConversation(input.conversationId);
			if (conversation === undefined) {
				throw new Error(`No conversation with id "${input.conversationId}" exists`);
			}

			// The provider a conversation was *created* with is a record of where it
			// started, not a claim on it.
			//
			// This used to refuse a send through any other provider, to avoid
			// "mixing transcripts across endpoints". That is what trying the same
			// conversation on a second model looks like from the user's side: the
			// conversation vanishes from the list and a new empty one opens, and
			// the app cannot be used to compare two models on one thread at all.
			//
			// The transcript is a list of plain messages and replays against any
			// OpenAI-compatible endpoint. The one thing worth watching is tool
			// history: a `tool_calls` message naming a tool the new endpoint was
			// never offered would be rejected by that server, which surfaces as a
			// visible error on the turn rather than as a silent mix.
			if (
				conversation.providerId !== undefined &&
				conversation.providerId !== input.providerId
			) {
				this.logger.info('Continuing a conversation under another provider', {
					conversationId: conversation.id,
					createdWith: conversation.providerId,
					answeringWith: input.providerId,
				});
			}

			// The user's message is persisted before the turn starts, so a turn that
			// fails still leaves what they typed in the transcript. Only the last
			// message is new: everything before it is already in the store.
			const latest = input.messages[input.messages.length - 1];
			if (latest !== undefined) {
				await this.appendUser(conversation.id, latest.content);
			}

			// "Evelyn, use somente os modelos gratuitos" muda a política
			// antes de escolher o modelo, para que este turno já rode sob ela.
			if (latest !== undefined) {
				const outcome = await applyPolicyPhrase({
					text: latest.content,
					store: this.history,
					now: () => new Date(),
					current: await this.loadAccessPolicy(),
				});
				if (outcome.notice !== undefined) {
					this.logger.info('Applied an access policy from the user message', {
						policy: outcome.applied?.policy ?? 'unchanged',
					});
					sink({ type: 'notice', turnId, message: outcome.notice });
				}
				if (outcome.failure !== undefined) {
					sink({ type: 'notice', turnId, message: outcome.failure });
				}
			}

			// Choose execution path based on strategy
			const strategy = input.strategy ?? 'manual';
			// O broker e a porta de permissões **deste** turno: o mesmo objeto
			// para o turno e para `answerPermission()`/`stop()` (R4C).
			const broker = this.permissionsBroker(sink);
			const permissions = this.permissionsFor(broker);
			this.broker = broker;
			const running =
				strategy === 'fallback'
					? // Orchestrated path with fallback support
						this.runOrchestratedTurn({
							input,
							conversation: conversation.id,
							turnId,
							controller,
							sink,
							broker,
							permissions,
						})
					: // Manual path (single model, no fallback). The user's pick is a
						// preference for a model; whether spending on it is allowed is a
						// separate question, and `runManualTurn` is where it is asked.
						this.runManualTurn({
							input,
							conversation: conversation.id,
							turnId,
							controller,
							sink,
							userMessage: latest?.content,
							broker,
							permissions,
						});
			const completion = running.then(
				() => undefined,
				() => undefined,
			);
			this.turnCompletions.set(turnId, completion);
			void completion.then(() => this.turnCompletions.delete(turnId));
			handedOff = true;
		} finally {
			// Only when the turn never started. Once `runTurn` has it, its own
			// `release` clears the slot — and clearing it here would let a second
			// turn overlap a running one.
			if (!handedOff) {
				this.releaseSlot(turnId);
			}
		}
		return { turnId, accepted: true };
	}

	/**
	 * As conversas persistidas, no que o cliente conectado pode ver (R4D).
	 *
	 * **Leitura pura**: não escreve, não toca no histórico, não cria índice.
	 * A lista vem do mesmo `listConversations` do modo local, na mesma ordem,
	 * com os mesmos metadados — e sem `projectId` nem `providerId`, que são
	 * organização e configuração do serviço.
	 */
	async listConversationsForClient(): Promise<
		readonly {
			readonly id: string;
			readonly title: string;
			readonly createdAt: string;
			readonly updatedAt: string;
			readonly messageCount: number;
		}[]
	> {
		const items = await this.listConversations();
		return items.map((item) => ({
			id: item.id,
			title: item.title,
			createdAt: item.createdAt,
			updatedAt: item.updatedAt,
			messageCount: item.messageCount,
		}));
	}

	/**
	 * Uma conversa e o histórico que o cliente conectado pode ver (R4D).
	 *
	 * ## O que é omitido, e por quê
	 *
	 * - **`systemPrompt`**: é a instrução privada do usuário. O Core a lê
	 *   para a execução; o cliente não precisa dela para desenhar a conversa,
	 *   e publicá-la entregaria a outro processo uma configuração que ele não
	 *   pediu.
	 * - **mensagens `system` e `tool`**: a de sistema é a mesma instrução; as
	 *   de ferramenta são resultado interno de execução (saída de comando,
	 *   conteúdo de arquivo lido). O cliente desenha `user`/`assistant`.
	 *
	 * `undefined` quando o id não existe — o servidor traduz em `404`.
	 */
	async openConversationForClient(conversationId: string): Promise<
		| {
				readonly conversation: {
					readonly id: string;
					readonly title: string;
					readonly createdAt: string;
					readonly updatedAt: string;
					readonly messageCount: number;
				};
				readonly messages: readonly { readonly role: 'user' | 'assistant'; readonly content: string }[];
		  }
		| undefined
	> {
		const record = await this.history.getConversation(conversationId);
		if (record === undefined) {
			return undefined;
		}
		const summary = toConversationListItem(record);
		return {
			conversation: {
				id: summary.id,
				title: summary.title,
				createdAt: summary.createdAt,
				updatedAt: summary.updatedAt,
				messageCount: summary.messageCount,
			},
			messages: record.messages
				.filter(
					(message): message is typeof message & { role: 'user' | 'assistant' } =>
						message.role === 'user' || message.role === 'assistant',
				)
				.map((message) => ({ role: message.role, content: message.content })),
		};
	}

	/**
	 * Executa **um** turno para um cliente externo (R4C).
	 *
	 * ## Por que não é `sendMessage`
	 *
	 * `sendMessage` reserva o slot único (`inFlight`), recusa o segundo envio
	 * e faz `stop()` alcançar qualquer turno. Isso é certo para uma janela com
	 * um usuário e errado para dois clientes: o segundo pedido seria recusado
	 * e o cancelamento de um pararia os dois.
	 *
	 * Aqui cada chamada recebe o **próprio** `turnId`, `controller`, `sink` e
	 * broker de permissões, e o turno roda com `holdsSlot: false` — nenhum
	 * estado de turno atravessa a fronteira. É o mesmo `runTurn` do caminho
	 * local: o mesmo roteamento, o mesmo laço de ferramentas, o mesmo
	 * orçamento e o mesmo consumo.
	 *
	 * ## Continuidade
	 *
	 * O contexto vem do histórico **persistido** da conversa: o chamador passa
	 * `conversationId` e a pergunta; o turno lê o que está no `FileDataStore`,
	 * exatamente como o caminho local.
	 *
	 * ## O que o chamador precisa resolver antes
	 *
	 * Modelo e provedor. Esta camada não escolhe candidatos: ela executa um
	 * turno sobre a conversa. A seleção continua sendo a do Core, feita por
	 * quem monta o pedido.
	 */
	async runExternalTurn(args: {
		readonly conversationId: string;
		readonly providerId: string;
		readonly model: string;
		readonly text: string;
		readonly turnId: string;
		readonly controller: AbortController;
		readonly sink: AgentEventSink;
		/**
		 * Como o turno escolhe quem responde (DEV-8.10).
		 *
		 * O serviço local roda o **mesmo** motor do chat do desktop: os modos
		 * aqui valem para `auto` (seleção nativa), `direct` (par do cliente) e
		 * `external` (roteador configurado). Ausente = comportamento anterior:
		 * o par é o destino, com a configuração do roteador por cima.
		 */
		readonly routing?: TurnMode;
	}): Promise<void> {
		const conversation = await this.history.getConversation(args.conversationId);
		if (conversation === undefined) {
			throw new Error(`No conversation with id "${args.conversationId}" exists`);
		}
		// R4O/R4Q: a mensagem **já foi** gravada pela rota, antes da
		// confirmação. Gravá-la de novo aqui era a origem da deduplicação por
		// conteúdo; agora o turno executa sobre o que está no histórico.


		const plan = await this.resolveTurnPlan({
			requestedModel: args.model,
			requestedProviderId: args.providerId,
			...(args.routing !== undefined ? { mode: args.routing } : {}),
		});
		if (plan.kind === 'refused') {
			args.sink({ type: 'error', turnId: args.turnId, message: plan.message });
			return;
		}
		const providerId = plan.kind === 'single' ? plan.providerId : args.providerId;
		const modelId = plan.kind === 'single' ? plan.modelId : args.model;

		// DEV-8.10: o modo automático não tem par para checar nem alvo para
		// montar — quem escolhe é o motor, que já aplica `allowPaid` e a
		// política aos candidatos, exatamente como no chat do desktop.
		if (args.routing === 'auto' && plan.kind === 'native') {
			const broker = this.permissionsBroker(args.sink);
			this.externalBrokers.set(args.turnId, { broker, answer: (answer) => broker.answer(answer) });
			try {
				await this.runOrchestratedTurn({
					input: {
						providerId: args.providerId,
						conversationId: conversation.id,
						model: args.model,
						messages: [{ role: 'user', content: args.text }],
						routing: 'auto',
					},
					conversation: conversation.id,
					turnId: args.turnId,
					controller: args.controller,
					sink: args.sink,
					broker,
					permissions: this.permissionsFor(broker),
				});
			} finally {
				this.externalBrokers.delete(args.turnId);
			}
			return;
		}

		const refusal = await this.modelUseRefusal(providerId, modelId);
		if (refusal !== undefined) {
			args.sink({ type: 'error', turnId: args.turnId, message: refusal });
			return;
		}
		const provider: ChatProvider =
			this.routing !== undefined
				? this.buildRoutedProvider([{ providerId, modelId }])
				: this.resolveProvider(providerId);

		// O broker e a porta de permissões **deste** turno: duas conversas
		// concorrentes nunca veem a pergunta uma da outra.
		const broker = this.permissionsBroker(args.sink);
		this.externalBrokers.set(args.turnId, { broker, answer: (answer) => broker.answer(answer) });
		try {
			if (args.routing === 'external' && plan.kind === 'single' && provider instanceof RoutedChatProvider) {
				// DEV-8.10: o relatório é o que diz **quem** decidiu. Sem ele, o
				// cliente conectado não teria como afirmar que quem escolheu foi
				// o roteador externo — e afirmar sem registrar seria inventar.
				await this.runManualRoutedTurn(
					{
						input: {
							providerId,
							conversationId: conversation.id,
							model: modelId,
							messages: [{ role: 'user', content: args.text }],
							routing: 'external',
						},
						conversation: conversation.id,
						turnId: args.turnId,
						controller: args.controller,
						sink: args.sink,
						broker,
						permissions: this.permissionsFor(broker),
					},
					provider,
				);
				await this.reportSingleTargetTurn({
					provider,
					plan,
					conversation: conversation.id,
					turnId: args.turnId,
				});
				return;
			}
			await this.runTurn({
				input: {
					providerId,
					conversationId: conversation.id,
					model: modelId,
					messages: [{ role: 'user', content: args.text }],
					// DEV-8.10: no modo escolhido, o evento `started` diz o modo
					// **e** o par efetivo — inclusive em `direct`/`external`, onde
					// quem decide é o cliente ou o roteador, não a seleção.
					...(args.routing !== undefined ? { routing: args.routing } : {}),
				},
				provider,
				conversation: conversation.id,
				turnId: args.turnId,
				controller: args.controller,
				sink: args.sink,
				userMessage: args.text,
				holdsSlot: false,
				broker,
				permissions: this.permissionsFor(broker),
			});
		} finally {
			this.externalBrokers.delete(args.turnId);
		}
	}

	/**
	 * Responde uma permissão de um turno externo.
	 *
	 * `false` quando não há pergunta aberta daquele turno — o turno terminou,
	 * ou a pergunta expirou. O serviço usa isso para responder ao cliente.
	 */
	answerExternalTurn(turnId: string, answer: PermissionAnswer): boolean {
		const entry = this.externalBrokers.get(turnId);
		if (entry === undefined) {
			return false;
		}
		return entry.answer(answer);
	}

	/** Aborts the turn in flight. False when nothing was running. */
	stop(): boolean {		// Anything the user is being asked about for this turn dies with it. The
		// dialog has to resolve, or the runtime waits on a promise nothing will
		// ever settle and the turn never finishes.
		this.broker?.cancelAll('the turn was stopped');
		if (this.inFlight === undefined) {
			return false;
		}
		this.inFlight.controller.abort();
		return true;
	}

	/** True while a turn is running. */
	get isBusy(): boolean {
		return this.inFlight !== undefined;
	}

	/**
	 * Runs a manual send: one model, chosen by the user, no fallback.
	 *
	 * Split out of `sendMessage` for one reason. Whether the chosen model may be
	 * used *for money* is answered before the turn starts and needs the catalogue,
	 * so it is asynchronous — and a refusal emitted before `sendMessage` has
	 * returned would arrive before the renderer holds the turn id it files events
	 * under. Here the ack always comes first.
	 */
	private async runManualTurn(args: {
		readonly input: SendMessageInput;
		readonly conversation: string;
		readonly turnId: string;
		readonly controller: AbortController;
		readonly sink: AgentEventSink;
		readonly userMessage?: string;
		/** O broker de permissões deste turno (R4C). */
		readonly broker?: PermissionBroker;
		readonly permissions?: PermissionGateway;
	}): Promise<void> {
		// O modo do roteador decide **quem** é chamado. Uma recusa aqui é
		// explícita: nenhuma requisição sai, e o motivo é dito.
		const plan = await this.resolveTurnPlan({
			requestedModel: args.input.model,
			requestedProviderId: args.input.providerId,
			...(args.input.routing !== undefined ? { mode: args.input.routing } : {}),
		});
		if (plan.kind === 'refused') {
			this.logger.warn('Refused a turn because the router configuration says so', {
				reason: plan.message,
			});
			args.sink({ type: 'error', turnId: args.turnId, message: plan.message });
			this.releaseSlot(args.turnId);
			return;
		}
		// No modo `single`, o provedor chamado é o configurado, e não o que a
		// interface tinha selecionado. O modelo pedido é o que o usuário
		// escolheu.
		const providerId = plan.kind === 'single' ? plan.providerId : args.input.providerId;
		const modelId = plan.kind === 'single' ? plan.modelId : args.input.model;

		// DEV-8.9: no modo automático o par acima pode vir vazio — quem escolhe
		// é o motor, e é ele que aplica `allowPaid` aos candidatos. Perguntar
		// por um modelo que não foi pedido não faz sentido.
		if (!(args.input.routing === 'auto' && plan.kind === 'native' && providerId.length === 0)) {
			const refusal = await this.modelUseRefusal(providerId, modelId);
			if (refusal !== undefined) {
				this.logger.warn('Refused a paid model without authorization', {
					providerId,
					modelId,
				});
				args.sink({ type: 'error', turnId: args.turnId, message: refusal });
				// The turn never reached `runTurn`, whose own `release` would have
				// given the slot up. Without this the session stays busy and every
				// later send is refused, which reads as the app being stuck.
				this.releaseSlot(args.turnId);
				return;
			}
		}

		// DEV-8.9: no modo automático não há par a construir — quem escolhe é o
		// motor. Sem isto, o caminho manual montaria um provedor para um alvo
		// vazio e o turno terminaria sem requisição e sem erro, que é a pior
		// forma de falhar: silenciosa.
		if (args.input.routing === 'auto' && plan.kind === 'native') {
			await this.runOrchestratedTurn({
				input: args.input,
				conversation: args.conversation,
				turnId: args.turnId,
				controller: args.controller,
				sink: args.sink,
				...(args.broker !== undefined ? { broker: args.broker } : {}),
				...(args.permissions !== undefined ? { permissions: args.permissions } : {}),
			});
			return;
		}

		const provider: ChatProvider =
			this.routing !== undefined
				? this.buildRoutedProvider([
						{ providerId, modelId },
					])
				: this.resolveProvider(providerId);
		if (this.routing !== undefined && provider instanceof RoutedChatProvider) {
			// One model, one route: the budget gate runs inside the engine, and
			// the block is announced before the terminal event like a fallback
			// turn's. Without this a manual paid turn vetoed by a limit would
			// end on the engine's generic exhaustion message.
			await this.runManualRoutedTurn(args, provider);
			// Nos modos de alvo único, o relatório é o que diz **quem escolheu**
			// o modelo — e o caminho manual é o mais comum, então sem ele a
			// distinção "a Evelyn escolheu" / "o roteador escolheu" ficaria
			// invisível justamente onde mais importa.
			if (plan.kind === 'single') {
				await this.reportSingleTargetTurn({
					provider,
					plan,
					conversation: args.conversation,
					turnId: args.turnId,
				});
			}
			return;
		}
		await this.runTurn({
			input: { ...args.input, providerId, model: modelId },
			provider,
			conversation: args.conversation,
			turnId: args.turnId,
			controller: args.controller,
			sink: args.sink,
			...(args.userMessage !== undefined ? { userMessage: args.userMessage } : {}),
			...(args.broker !== undefined ? { broker: args.broker } : {}),
			...(args.permissions !== undefined ? { permissions: args.permissions } : {}),
		});
	}

	/**
	 * Grava o relatório de um turno de alvo único.
	 *
	 * O caminho manual não grava entrada no log — é como ele sempre foi. Nos
	 * modos de alvo único, porém, sem relatório a decisão fica invisível, e
	 * é a decisão justamente o que o usuário precisa ver: quem escolheu o
	 * modelo, e o que é conhecido sobre isso.
	 */
	private async reportSingleTargetTurn(args: {
		readonly provider: RoutedChatProvider;
		readonly plan: Extract<RouterPlan, { kind: 'single' }>;
		readonly conversation: string;
		readonly turnId: string;
	}): Promise<void> {
		const attempts = args.provider.attempts;
		const winner = attempts.find((attempt) => attempt.outcome === 'success');
		const result: OrchestrationLogEntry['result'] =
			winner !== undefined
				? 'success'
				: attempts.some((attempt) => attempt.outcome === 'cancelled')
					? 'cancelled'
					: 'failed';
		const report = await this.buildTurnReport({
			turnId: args.turnId,
			conversationId: args.conversation,
			startedAt: new Date(attempts[0]?.startedAtMs ?? Date.now()).toISOString(),
			strategy: 'manual',
			policy: await this.loadAccessPolicy(),
			plan: singleTargetPlan(args.plan),
			catalog: await this.safeListModelCatalog(),
			attempts,
			result,
			finalModel: {
				providerId: args.plan.providerId,
				modelId: args.plan.modelId,
			},
			routing: {
				mode: args.plan.mode,
				providerId: args.plan.providerId,
				requestedModel: args.plan.modelId,
				decidedBy: args.plan.mode === 'external' ? 'external-router' : 'provider',
			},
			summary:
				result === 'success'
					? `Respondeu ${args.plan.providerId}/${args.plan.modelId}.`
					: 'Nenhum modelo respondeu.',
		});
		try {
			await this.orchestrationLog.append({
				conversationId: args.conversation,
				task: {
					primaryGoal: '',
					domain: 'unknown',
					complexity: 'unknown',
					needsTools: false,
					requiredCapabilities: [],
					missingInformation: [],
					confidence: 0,
					rationale: 'turno de alvo unico',
				},
				strategy: 'manual',
				primaryModel: `${args.plan.providerId}:${args.plan.modelId}`,
				attempts: attempts.map((attempt) => ({
					attempt: attempt.sequence,
					model: {
						providerId: attempt.providerId,
						modelId: attempt.modelId,
						providerName: attempt.providerId,
						catalog: undefined,
						available: true,
					},
					recoverable: false,
					timestamp: new Date(attempt.startedAtMs).toISOString(),
				})),
				result,
				finalModel: `${args.plan.providerId}:${args.plan.modelId}`,
				summary: report.summary,
				decision: report,
			});
		} catch (error) {
			this.logger.warn('Could not log the single-target decision', {
				turnId: args.turnId,
				reason: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/** The routed half of a manual turn: run it, then close and narrate. */
	private async runManualRoutedTurn(
		args: {
			readonly input: SendMessageInput;
			readonly conversation: string;
			readonly turnId: string;
			readonly controller: AbortController;
			readonly sink: AgentEventSink;
			/** O broker de permissões deste turno (R4C). */
			readonly broker?: PermissionBroker;
			readonly permissions?: PermissionGateway;
		},
		provider: RoutedChatProvider,
	): Promise<void> {
		// `runTurn` announces its terminal event *after* the metrics port has
		// settled, so a block has to be announced from inside the watched sink:
		// by the time a caller outside `runTurn` returns, the renderer has
		// already been told the turn is over, and a block arriving after that
		// would be attached to nothing.
		let announced = false;
		const announce = (): void => {
			if (announced) {
				return;
			}
			announced = true;
			this.announceBudgetBlocks(args.turnId, provider, args.sink);
		};
		await this.runTurn({
			input: args.input,
			provider,
			conversation: args.conversation,
			turnId: args.turnId,
			controller: args.controller,
			sink: (event) => {
				if (event.type === 'done' || event.type === 'error') {
					announce();
				}
				args.sink(event);
			},
			...(args.input.messages[args.input.messages.length - 1] !== undefined
				? { userMessage: args.input.messages[args.input.messages.length - 1].content }
				: {}),
		});
		// The execution closes here: the manual path never had a caller-owned
		// settle, so a manually routed turn would otherwise leave its execution
		// open and the next budget check would read the round as unfinished.
		await this.settleConsumption(provider, args.turnId);
		// The engine may end the stream without a terminal event (a user stop),
		// so anything still unannounced is announced once the turn is over.
		announce();
	}

	/**
	 * Whether a manual model may not be used because it costs money.
	 *
	 * The two things are separate on purpose. Choosing a model states *which* one
	 * the user wants; it does not state a budget for it. A click on a paid model
	 * is therefore a preference, not an authorization, and the session's own
	 * switch is consulted rather than being treated as satisfied by the click
	 * itself.
	 *
	 * Returns the message to show, or `undefined` when the turn may proceed.
	 * Only `paid` blocks: an unclassified model is not evidence of a charge, and
	 * refusing it would make every model the user has not described unusable.
	 */
	/**
	 * Por que este modelo explícito não pode ser usado agora, ou `undefined`.
	 *
	 * Duas perguntas, e a segunda não substitui a primeira:
	 *
	 * 1. o modelo é pago e o uso de pagos não está autorizado (a regra de
	 *    antes desta etapa, inalterada);
	 * 2. a política em vigor é `free_only` e o modelo não tem acesso gratuito
	 *    confirmado — incluindo o caso em que ele seria barato, ou gratuito
	 *    segundo um preço que ninguém classificou.
	 *
	 * `free_only` recusa; não troca o modelo por outro. O usuário pediu um
	 * modelo e a política recusa esse modelo; responder com um terceiro seria
	 * responder outra pergunta.
	 */
	private async modelUseRefusal(providerId: string, modelId: string): Promise<string | undefined> {
		const paid = await this.paidAuthorizationRefusal(providerId, modelId);
		if (paid !== undefined) {
			return paid;
		}
		const policy = await this.loadAccessPolicy();
		if (policy.policy !== 'free_only') {
			return undefined;
		}
		const evidence = (await this.freeEvidenceIndex(Date.now())).get(`${providerId}:${modelId}`);
		const verdict = evaluatePolicy(
			{ providerId, modelId, ...(evidence !== undefined ? { freeEvidence: evidence } : {}) },
			policy.policy,
		);
		if (verdict.eligible) {
			return undefined;
		}
		const why =
			verdict.reason === 'free_evidence_expired'
				? 'a evidência de acesso gratuito venceu'
				: verdict.reason === 'paid'
					? 'ele está classificado como pago'
					: 'não há confirmação de acesso gratuito para ele';
		return `A política "somente gratuitos" está ativa e o modelo ${modelId} não é elegível: ${why}. Nenhuma chamada foi feita.`;
	}

	private async paidAuthorizationRefusal(
		providerId: string,
		modelId: string,
	): Promise<string | undefined> {
		if (this.allowPaid) {
			return undefined;
		}
		let entry: ModelCatalogEntry | undefined;
		try {
			entry = await this.history.getModelCatalogEntry({ providerId, modelId });
		} catch (error) {
			// The catalogue could not be read, so the price is unknown. An
			// unreadable file must not be able to stop every turn; the safe
			// reading of "unknown" is the same one the selector uses.
			this.logger.warn("Could not read the catalogue to check a model's access", {
				providerId,
				modelId,
				error: describeError(error),
			});
			return undefined;
		}
		if (entry?.access !== 'paid') {
			return undefined;
		}
		return `O modelo ${modelId} é pago e o uso de modelos pagos não está autorizado nesta sessão.`;
	}

	/**
	 * Runs one agent turn to completion.
	 *
	 * Private and never awaited by `sendMessage`. Every outcome — answered,
	 * aborted, failed, tool-ran — produces exactly one terminal event, so the
	 * renderer's loading state always clears.
	 *
	 * The loop itself belongs to the Core's `ConversationRuntime`. This method
	 * builds that runtime, hands it the workspace and the persisted history, and
	 * translates its `AgentEvent`s into UI events. The `ChatStream` is not
	 * touched here: consuming it directly would bypass the permission gateway and
	 * make the tools unreachable, which is exactly what the runtime exists to
	 * prevent.
	 */
	private async runTurn(args: {
		readonly input: SendMessageInput;
		readonly provider: ChatProvider;
		readonly conversation: string;
		readonly turnId: string;
		readonly controller: AbortController;
		readonly sink: AgentEventSink;
		readonly userMessage?: string;
		/**
		 * Whether this turn owns the session slot outright.
		 *
		 * True for a plain send; false for one attempt inside an orchestration,
		 * where the outer loop holds the slot for every attempt. The distinction is
		 * what keeps `stop()` able to reach a fallback attempt that is currently
		 * generating — releasing the slot between attempts would leave the second
		 * attempt with nothing registered to abort.
		 */
		readonly holdsSlot?: boolean;
		/**
		 * O broker de permissões **deste** turno (R4C).
		 *
		 * Injetado pelo chamador que inicia o turno. Antes era `this.broker`,
		 * um só por sessão — incompatível com dois turnos ao mesmo tempo.
		 */
		readonly broker?: PermissionBroker;
		/** A porta de permissões que pergunta a **este** broker. */
		readonly permissions?: PermissionGateway;
	}): Promise<void> {
		const { input, provider, conversation, turnId, controller, sink, userMessage } = args;
		const holdsSlot = args.holdsSlot ?? true;
		const broker = args.broker;
		const permissions = args.permissions ?? this.permissions();

		// Set by whichever timer fires first, and read by `terminal`: an abort
		// with a cause is reported as that failure, not as a user stop.
		let abortCause: TimerAbortCause | undefined;
		let sawFirstToken = false;
		/**
		 * The first-token stall is the engine's budget when routing is on.
		 *
		 * Two timers measuring the same gap would abort at whichever fired
		 * first, and the engine's per-attempt budget — the one that can retry a
		 * candidate and fall back without losing the turn — would never get to
		 * decide. The turn-level total stays: it bounds the whole turn,
		 * including tool rounds the engine never sees.
		 */
		const stall =
			this.routing === undefined
				? setTimeout(() => {
						if (!sawFirstToken) {
							this.logger.warn('Turn stalled before the first token', { turnId });
							abortCause = 'first-token';
						}
						broker?.cancelAll(
							abortCause === 'first-token' ? 'the model never answered' : 'the turn timed out',
						);
						// The reason travels with the abort so the routing engine
						// can tell a budget apart from a person pressing Stop.
						if (abortCause !== undefined) {
							controller.abort(abortCause);
						} else {
							controller.abort();
						}
					}, this.firstTokenTimeoutMs)
				: undefined;
		/**
		 * Em modo tarefa, o teto de tempo mede **inatividade**, não relógio.
		 *
		 * Um comando que roda cinco minutos é progresso, não travamento; o que
		 * não é progresso é passar dez minutos sem nenhum evento. O relógio é
		 * reiniciado por qualquer evento da tarefa, inclusive os de ferramenta.
		 */
		const isTask = input.task === true;
		const turnLimit = isTask ? Math.max(this.turnTimeoutMs, TASK_TURN_TIMEOUT_MS) : this.turnTimeoutMs;
		const idleLimit = isTask ? TASK_IDLE_TIMEOUT_MS : turnLimit;
		let idleTimer: ReturnType<typeof setTimeout> | undefined;
		const armIdle = (): void => {
			if (isTask) {
				clearTimeout(idleTimer);
				idleTimer = setTimeout(() => {
					if (abortCause === undefined) {
						abortCause = 'total-time';
					}
					broker?.cancelAll('a tarefa ficou sem progresso por muito tempo');
					controller.abort(abortCause);
				}, idleLimit);
			}
		};
		const timeout = setTimeout(() => {
			// A timed-out turn must also settle any dialog it left open. The
			// runtime is parked on that answer, and aborting the controller
			// alone never reaches it — `permissions()` documents that the Core's
			// risk gateway does not forward the signal to `onAsk`. Without this
			// the turn (and `isBusy`) waits for the broker's own 120s timer.
			if (abortCause === undefined) {
				abortCause = 'total-time';
			}
			broker?.cancelAll(isTask ? 'a tarefa excedeu o limite de tempo' : 'the turn timed out');
			controller.abort(abortCause);
		}, turnLimit);
		armIdle();

		// The turn's own events, with the stall bookkeeping folded in. The first
		// output of any kind cancels the stall timer; a terminal event after a
		// forced abort is rewritten from a meaningless "stopped" into the failure
		// that actually happened.
		const watched: AgentEventSink = (event) => {
			// Todo evento é progresso: uma nova tentativa, um resultado, uma
			// ferramenta começando. Em modo tarefa isso reinicia o relógio de
			// inatividade — é o que distingue "trabalhando" de "parado".
			armIdle();
			if (event.type === 'delta' || event.type === 'reasoning' || event.type === 'toolCall') {
				if (!sawFirstToken) {
					sawFirstToken = true;
					clearTimeout(stall);
				}
			}
			if (abortCause !== undefined) {
				if (event.type === 'done' && event.reason === 'aborted') {
					sink({ type: 'error', turnId, message: this.abortMessage(abortCause), abortCause });
					return;
				}
				if (event.type === 'error' && /abort|cancel/i.test(event.message)) {
					sink({ type: 'error', turnId, message: this.abortMessage(abortCause), abortCause });
					return;
				}
			}
			sink(event);
		};

		/**
		 * Always clears both timers, on every exit from this turn.
		 *
		 * A `finally` rather than a statement on the happy path, because there are
		 * at least four ways out of a turn — success, an error from the runtime, a
		 * throw while building the runtime, and a provider that throws before the
		 * stream exists — and only one of them was covered before. A leaked 60s
		 * stall timer keeps the event loop alive and, worse, fires against a turn
		 * that already finished: it calls `broker.cancelAll` and aborts a controller
		 * that a *later* turn may have been handed.
		 *
		 * `release` is still called explicitly before the terminal event, so the
		 * slot is free by the time anything reacts to `done`. This `finally` is the
		 * backstop for the paths that never got there.
		 */
		const clearTimers = (): void => {
			clearTimeout(timeout);
			clearTimeout(stall);
			clearTimeout(idleTimer);
		};

		try {
			// Tools are registered once per session and reused; the recorder
			// wrappers are also reused, so a turn cannot double-wrap a tool.
			const tools = await this.tools();
			const recorders = this.recorders;

			// The workspace is the conversation's project root. Without it the
			// filesystem tools refuse to run, which is the intended refusal: an
			// unbound tool has no directory to confine itself to.
			const workingDirectory = await this.workspaceFor(conversation);

			// O broker já vem por turno (R4C). Nada de cancelar o de outro
			// turno: este turno tem o seu, com o sink dele.

			const runtime = new ConversationRuntime({
				provider,
				tools,
				permissions,
				// O teto de rounds é de **tarefa** quando há tarefa: uma etapa
				// consome um round, e o padrão de 8 tratava metade de um trabalho
				// normal como o fim dele (medido: a interface recebia
				// `reason: 'maxTurns'` no meio de uma sequência de edições).
				...(input.task === true ? { maxTurns: TASK_MAX_TURNS } : {}),
				// The runtime names its permission requests after this turn, so a
				// prompt is announced under the id the renderer is already
				// watching. Left to the runtime it would always say `turn-1`.
				sessionId: turnId,
				...(workingDirectory !== undefined ? { workingDirectory } : {}),
			});

			const record = await this.requireConversation(conversation);

			// The turn's slot is released *before* its terminal event is emitted,
			// not in a `finally` after. A sink that reacts to `done` by sending
			// the next message — or a test that awaits `done` and immediately
			// checks `isBusy` — would otherwise still see the turn registered and
			// be refused, which reads as "the app got stuck".
			//
			// The slot itself is only given up when this turn owns it outright. An
			// attempt inside an orchestration does not: the orchestration holds it
			// for the whole loop, so releasing it between attempts would leave the
			// fallback attempt unstoppable — `stop()` would find nothing registered
			// and answer `false` while a model was still generating.
			const release = (): void => {
				clearTimers();
				if (holdsSlot) {
					this.releaseSlot(turnId);
				}
			};

			await runAgentTurn(
				{
					runtime,
					model: input.model,
					tools,
					permissions,
					recorders,
					// Called just before the terminal event, so the slot is free by
					// the time anyone observes the turn as finished.
					release,
					persistToolResult: (output, toolCallId) =>
						this.appendToolResult(conversation, output, toolCallId),
					persistAssistant: (content, toolCalls) =>
						this.appendAssistant(conversation, content, toolCalls),
					skillDiscovery: this.skillDiscovery,
					userMessage,
					...(input.routing !== undefined
						? {
								routing: {
									mode: input.routing,
									...(input.providerId.length > 0 ? { providerId: input.providerId } : {}),
									...(input.model.length > 0 ? { model: input.model } : {}),
								},
							}
						: {}),
				},
				record,
				turnId,
				watched,
				{ signal: controller.signal },
			);
			// Covers a turn that ended without a terminal event, which should not
			// happen but must not strand the session either.
			release();
		} catch (error) {
			// Persistence failed, or the runtime could not be built. Either way
			// the renderer needs one terminal event, and it must not carry a key.
			clearTimers();
			// A dialog opened by this turn would outlive it otherwise, and the
			// card would keep reading as a request still waiting for an answer.
			broker?.cancelAll('the turn failed');
			if (holdsSlot) {
				this.releaseSlot(turnId);
			}
			this.logger.error('Agent turn failed', { turnId, error });
			// An abort the timers caused reads as its failure, not as a bare
			// "operation was aborted".
			if (abortCause !== undefined && /abort|cancel/i.test(describeError(error))) {
				sink({ type: 'error', turnId, message: this.abortMessage(abortCause), abortCause });
				return;
			}
			// A failure the timers did not cause carries no abort reason, and must
			// carry none: an absent `abortCause` is what tells the orchestrator this
			// was a real failure to classify rather than a budget that ran out.
			sink({ type: 'error', turnId, message: describeError(error) });
		} finally {
			// The backstop. `release()` already ran on the paths that got there;
			// this covers the throw that happened before it could — building the
			// runtime, resolving the conversation, or a provider that threw before
			// the stream existed. A stall timer left armed would fire against
			// whichever turn came next and cancel its permissions.
			clearTimers();
			// The route publishes its attempt while the stream is ending, so the
			// measurement's write can still be in flight when the terminal event
			// is emitted. Waiting here is what makes "the turn is over" and "the
			// catalog reflects it" the same moment. `settled` never rejects.
			if (this.routingMetricsSettled !== undefined) {
				await this.routingMetricsSettled();
			}
		}
	}

	/** The user-facing line for a forced abort, per cause. */
	private abortMessage(cause: TimerAbortCause): string {
		if (cause === 'first-token') {
			return `O modelo não começou a responder em ${Math.round(this.firstTokenTimeoutMs / 1000)}s. Deve estar sobrecarregado ou indisponível — tente novamente ou escolha outro modelo.`;
		}
		return `O turno excedeu ${Math.round(this.turnTimeoutMs / 1000)}s no total. Tente novamente ou escolha outro modelo.`;
	}

	/**
	 * Runs a single turn and returns the terminal event.
	 *
	 * This wraps `runTurn` in a promise that resolves when the sink receives
	 * a 'done' or 'error' event. Used by the orchestration loop to know when
	 * a turn completes and whether it succeeded.
	 *
	 * `abortCause` travels out rather than being re-derived from the message.
	 * The orchestration decision "is this worth retrying elsewhere" is a decision
	 * about *why* the turn ended, and the message is the part that gets reworded.
	 */
	private async runTurnWithResult(args: {
		readonly input: SendMessageInput;
		readonly provider: ChatProvider;
		readonly conversation: string;
		readonly turnId: string;
		readonly controller: AbortController;
		readonly modelId: string;
		readonly providerId: string;
		readonly holdsSlot?: boolean;
		/** O broker de permissões deste turno (R4C). */
		readonly broker?: PermissionBroker;
		readonly permissions?: PermissionGateway;
		/**
		 * Where the attempt's non-terminal events go.
		 *
		 * Without this the whole fallback path was silent: the attempt's deltas and
		 * tool events were consumed here to decide what to do next and never
		 * reached the window, and the terminal event was consumed too — so an
		 * orchestrated turn produced no answer and no error, and the UI waited on a
		 * turn that had already finished. The orchestration narrates the outcome
		 * itself, at the end, so the terminal event is the only thing withheld.
		 */
		readonly onEvent?: AgentEventSink;
	}): Promise<{
		readonly terminalEvent: ChatStreamEvent;
		readonly hadToolCalls: boolean;
		readonly abortCause?: AbortCause;
	}> {
		return new Promise((resolve) => {
			const settle = (result: {
				readonly terminalEvent: ChatStreamEvent;
				readonly hadToolCalls: boolean;
				readonly abortCause?: AbortCause;
			}): void => {
				// The turn's own `finally` is where the measurements land, and it
				// runs after the terminal event. Resolving here would hand the
				// caller a turn that is not finished with its metrics yet.
				const finished = this.routingMetricsSettled;
				if (finished === undefined) {
					resolve(result);
					return;
				}
				void finished().then(() => resolve(result), () => resolve(result));
			};
			const watched: AgentEventSink = (event) => {
				if (event.type === 'done' || event.type === 'error') {
					settle({
						terminalEvent: event,
						// Also read from an aborted turn: a tool call that happened
						// before a timeout still happened, and its side effects are
						// exactly why a retry would be unsafe.
						hadToolCalls: sawToolCalls || (event.type === 'done' && event.toolCalls > 0),
						...(event.type === 'error' && event.abortCause !== undefined
							? { abortCause: event.abortCause }
							: {}),
					});
					return;
				}
				if (event.type === 'toolCall') {
					sawToolCalls = true;
				}
				args.onEvent?.(event);
			};
			let sawToolCalls = false;
			void this.runTurn({
				input: args.input,
				provider: args.provider,
				conversation: args.conversation,
				turnId: args.turnId,
				controller: args.controller,
				sink: watched,
				userMessage: args.input.messages[args.input.messages.length - 1]?.content,
				...(args.holdsSlot !== undefined ? { holdsSlot: args.holdsSlot } : {}),
				...(args.broker !== undefined ? { broker: args.broker } : {}),
				...(args.permissions !== undefined ? { permissions: args.permissions } : {}),
			});
		});
	}

	/**
	 * Lê as preferências de modelo que a Evelyn registrou.
	 *
	 * Devolve `undefined` quando não há store, quando não há arquivo ou quando
	 * o arquivo não se lê — nos três casos a seleção segue como antes, porque
	 * uma preferência que não pôde ser lida é uma preferência que não existe.
	 * O erro vai para o log; a conversa não é interrompida por ele.
	 */
	private async readModelGuidance(): Promise<ModelGuidance | undefined> {
		const store = this.modelGuidance;
		if (store === undefined) {
			return undefined;
		}
		try {
			return await store.read();
		} catch (error) {
			this.logger.warn('Could not read the model guidance dialogue', {
				error: describeError(error),
			});
			return undefined;
		}
	}

	/**
	 * Registra no disco o que a Evelyn escreveu sobre os modelos.
	 *
	 * Chamado pelo host depois de um turno no diálogo fixo. Interpreta a
	 * resposta como o formato declarado e grava o resultado — inclusive o que
	 * foi recusado, para que a resposta errada possa ser corrigida em vez de
	 * ficar silenciosamente sem efeito.
	 */
	async recordModelGuidance(
		conversationId: string,
		text: string,
	): Promise<ModelGuidance | undefined> {
		const store = this.modelGuidance;
		if (store === undefined) {
			return undefined;
		}
		return store.write({ conversationId, text, now: this.clock });
	}

	/** O que está gravado hoje, para a tela mostrar a origem da decisão. */
	async readRecordedModelGuidance(): Promise<ModelGuidance | undefined> {
		return this.readModelGuidance();
	}

	/**
	 * Gets the recent history for task classification (last 5 user/assistant messages).
	 */
	private async getRecentHistory(conversationId: string): Promise<readonly { role: string; content: string }[]> {
		const view = await this.history.getConversation(conversationId);
		if (view === undefined) {return [];}
		// The view has messages in ConversationMessageView format
		const recent = view.messages.slice(-5);
		return recent.map((m) => ({ role: m.role, content: m.content }));
	}

	/**
	 * Runs the orchestrated turn with fallback support.
	 *
	 * This is the main entry point for orchestrated sends. It:
	 * 1. Classifies the task
	 * 2. Selects models (respecting manual choice)
	 * 3. Runs attempts in order until success, non-recoverable error, or exhaustion
	 * 4. Logs the orchestration outcome
	 */
	private async runOrchestratedTurn(args: {
		readonly input: SendMessageInput;
		readonly conversation: string;
		readonly turnId: string;
		readonly controller: AbortController;
		readonly sink: AgentEventSink;
		/** O broker de permissões deste turno (R4C). */
		readonly broker?: PermissionBroker;
		readonly permissions?: PermissionGateway;
	}): Promise<void> {
		const { input, conversation, turnId, sink } = args;
		const strategy = input.strategy ?? 'manual';
		// DEV-8.9: no modo automático, a seleção precisa de uma alternativa para
		// que o fallback exista; nos demais, valem as tentativas da estratégia.
		const maxAttempts = input.routing === 'auto' ? Math.max(2, strategy === 'fallback' ? 3 : 1) : strategy === 'fallback' ? 3 : 1;

		// 1. Get available models and catalog
		//
		// The turn's own signal, so a stop while the list is being discovered
		// does not leave the turn waiting for a `/models` that nobody wants.
		// Failures are still per provider: a dead endpoint costs its own entry,
		// not the turn.
		const availableModels = await this.listAvailableModels({ signal: args.controller.signal });
		// The whole catalog, not only the current provider's slice. Candidates
		// are drawn from every provider the server offers, so a model on a
		// second provider would otherwise be scored with no metadata at all -
		// and its declared price and access would never be consulted, which is
		// what let a paid model be picked as if it were unknown.
		// O catálogo fundido: os limites e as capacidades efetivos que o
		// seletor usa são os mesmos que a tela mostra. O catálogo gravado não
		// é tocado — a fusão é uma vista, e o que o seletor lê é o que a
		// interface exibe.
		const catalog = await this.fusedCatalog();
		// A recomendação do agente lê esta mesma cópia: o turno e a ferramenta
		// não podem discordar sobre preço, limite ou observação no mesmo turno.
		this.fusedCatalogSnapshot = catalog;

		// A política de acesso entra antes da seleção, não depois: o plano
		// rotulado só pode conter modelos que a política permite, senão o
		// roteador receberia um pago como fallback de um turno "somente
		// gratuitos". `allowPaid` e o orçamento continuam valendo por cima.
		const accessPolicy = await this.loadAccessPolicy();
		const policy = await this.applyAccessPolicy(accessPolicy, availableModels);
		if (policy.allowedModels.length === 0) {
			sink({ type: 'error', turnId, message: policy.explanation });
			this.releaseSlot(turnId);
			return;
		}
		const availableForPlan = policy.allowedModels;
		// Os candidatos que a política removeu, para o relatório dizer que
		// eles nunca foram pontuados.
		const policyExcluded = policy.excluded;

		// 2. Classify the task (use user's latest message + recent history)
		const userMessage = input.messages[input.messages.length - 1]?.content ?? '';
		const recentHistory = await this.getRecentHistory(conversation);
		// O mesmo histórico que a ferramenta de recomendação consulta no meio do
		// turno: senão o turno e a recomendação classificariam o mesmo pedido de
		// dois jeitos, e seria o da ferramenta que a pessoa veria.
		this.recentUserMessages = recentHistory;
		const task = classifyTask(userMessage, recentHistory);

		// 2b. O que a Evelyn escreveu sobre os modelos, no diálogo de
		// preferências. Lido neste turno e não guardado entre eles: uma
		// resposta nova no diálogo vale a partir do turno seguinte, sem
		// reiniciar o app. Um erro de leitura não derruba o turno — ele só
		// volta a decidir pelas regras do catálogo.
		const guidance = await this.readModelGuidance();

		// 3. The plan.
		//
		// No modo `native`, é o plano da seleção — o de sempre. Nos modos de
		// alvo único, a Evelyn **não** escolhe o modelo: ela manda o que o
		// usuário pediu para o provedor configurado, e quem decide de verdade é
		// o outro lado. O motor de rota continua no caminho, com um alvo só, de
		// modo que orçamento, cota, breaker e métricas sigam valendo.
		const routerPlan = await this.resolveTurnPlan({
			requestedModel: input.model,
			requestedProviderId: input.providerId,
			...(input.routing !== undefined ? { mode: input.routing } : {}),
		});
		if (routerPlan.kind === 'refused') {
			this.logger.warn('Refused a turn because the router configuration says so', {
				reason: routerPlan.message,
			});
			sink({ type: 'error', turnId, message: routerPlan.message });
			this.releaseSlot(turnId);
			return;
		}
		const single = routerPlan.kind === 'single' ? routerPlan : undefined;
		// DEV-8.9: no modo automático, quem escolhe é o motor — a estratégia do
		// turno (`manual`) não pode fixar o par que o usuário não escolheu.
		// Nos demais modos (e sem modo escolhido), nada muda.
		const choosesAutomatically = input.routing === 'auto' && single === undefined;
		const plan =
			single !== undefined
				? singleTargetPlan(single)
				: createOrchestrationPlan({
						strategy,
						task,
						availableModels: availableForPlan,
						catalog,
						manualChoice: !choosesAutomatically && strategy === 'manual' ? `${input.providerId}:${input.model}` : undefined,
						maxAttempts,
						// The session's own policy, false unless a host authorized spending.
						// Passed rather than hard-coded here so the one switch governs both
						// the primary choice and every fallback candidate.
						allowPaid: this.allowPaid,
						...(guidance !== undefined && guidance.entries.length > 0
							? { guidance: guidance.entries }
							: {}),
					});

		if (plan.primary === undefined) {
			sink({ type: 'error', turnId, message: 'Nenhum modelo elegível encontrado para esta tarefa.' });
			this.releaseSlot(turnId);
			return;
		}

		// 4. Run attempts
		const attempts: OrchestrationAttempt[] = [];
		let currentModel = plan.primary;
		let attemptNumber = 0;
		let finalResult: OrchestrationLogEntry['result'] = 'failed';
		let finalModel: typeof currentModel = currentModel;
		// O relatório de decisão. Vazio quando o turno não chegou a rodar.
		let decisionReport: RoutingDecisionReport | undefined;

		// Everything from here to the end of the loop is wrapped so the slot is
		// given up on *every* exit, including a throw from the log append or from
		// an attempt. Without it a throw would leave the session permanently
		// "busy" and every later send refused — the exact failure the slot's own
		// `finally` in `sendMessage` was written to prevent.
		try {
		if (this.routing !== undefined) {
			// One attempt, one route. The engine retries, times out and moves
			// between candidates; the outer loop must not do it a second time.
			//
			// No modo de alvo único, o `input` é corrigido: o provedor chamado
			// é o configurado, e não o que a interface tinha selecionado. Sem
			// isso, o corpo da requisição carregaria o modelo do provedor
			// errado.
			this.respondedModels.clear();
			const routed = await this.runRoutedTurn({
				input:
					single !== undefined
						? { ...input, providerId: single.providerId, model: single.modelId }
						: input,
				conversation,
				turnId,
				controller: args.controller,
				sink,
				...(args.broker !== undefined ? { broker: args.broker } : {}),
				...(args.permissions !== undefined ? { permissions: args.permissions } : {}),
				strategy,
				plan,
				catalog,
				policy: accessPolicy,
				taskExplanation: task.explanation,
				policyExcluded,
				...(single !== undefined
					? {
							routing: {
								mode: single.mode,
								providerId: single.providerId,
								requestedModel: single.modelId,
								decidedBy:
									single.mode === 'external'
										? ('external-router' as const)
										: ('provider' as const),
							},
						}
					: {}),
			});
			attempts.push(...routed.attempts);
			finalResult = routed.result;
			finalModel = routed.model;
			decisionReport = routed.report;
			return;
		}

		/**
		 * Live only while the user has not stopped the turn.
		 *
		 * Each attempt gets its own controller because the turn's own timeout
		 * aborts the controller it was given, and an aborted controller stays
		 * aborted: reusing it would start attempt two on a signal that is already
		 * dead, which fails immediately and looks like "fallback never works"
		 * rather than like the bug it is.
		 *
		 * `turnAborted` is the user's own Stop, which must reach every later
		 * attempt too — that is why the user's signal is chained into each fresh
		 * controller rather than being replaced by it.
		 */
		let turnAborted = args.controller.signal.aborted;

		while (currentModel !== undefined && attemptNumber < maxAttempts) {
			attemptNumber++;
			const provider = this.buildProvider(currentModel.providerId);
			const controller = new AbortController();
			if (turnAborted) {
				controller.abort();
			} else {
				args.controller.signal.addEventListener('abort', () => controller.abort(), { once: true });
			}

			// Emit modelSelected event
			const isFallback = attemptNumber > 1;
			sink({
				type: 'modelSelected',
				turnId,
				providerId: currentModel.providerId,
				modelId: currentModel.modelId,
				strategy,
				reason: plan.reasons.find((r) => r.modelId === currentModel.modelId && r.providerId === currentModel.providerId)?.reason ?? 'Selected by orchestration',
				isFallback,
			});

			if (isFallback && attempts.length > 0) {
				const prevError = attempts[attempts.length - 1].error?.message ?? 'unknown error';
				sink({
					type: 'fallbackAttempted',
					turnId,
					attempt: attemptNumber,
					providerId: currentModel.providerId,
					modelId: currentModel.modelId,
					previousError: prevError,
				});
			}

			// Run the turn.
			//
			// `holdsSlot: false`: the slot belongs to this loop for the whole
			// orchestration. An attempt that released it would leave the next
			// attempt with nothing registered, and `stop()` would answer `false`
			// while a model was still generating.
			const result = await this.runTurnWithResult({
				input,
				provider,
				conversation,
				turnId,
				controller,
				modelId: currentModel.modelId,
				providerId: currentModel.providerId,
				holdsSlot: false,
				...(args.broker !== undefined ? { broker: args.broker } : {}),
				...(args.permissions !== undefined ? { permissions: args.permissions } : {}),
				// The attempt narrates itself; the outcome is narrated here, once,
				// at the end. Two terminal events would leave the renderer unsure
				// which one settled the turn.
				onEvent: sink,
			});
			// The turn is over as an answer, but its consumption is still in
			// flight. Waiting here means the next turn - and the budget check
			// that guards it - reads what this one spent.
			if (this.consumption !== undefined) {
				await this.consumption.settled();
			}

			let recoverable = false;
			if (result.terminalEvent.type === 'done') {
				// Success!
				attempts.push({
					attempt: attemptNumber,
					model: currentModel,
					timestamp: this.clock(),
					recoverable: false,
				});
				finalResult = 'success';
				finalModel = currentModel;
				break;
			}

			// Error - check if recoverable and should fallback.
			//
			// One decision, in `shouldFallback`, rather than four `if`s here. The
			// reason is that the order of those checks *is* the safety property: a
			// user stop outranks everything, and a turn that already ran a tool
			// outranks every claim about how innocent the failure looked.
			const errorMessage =
				result.terminalEvent.type === 'error' ? result.terminalEvent.message : 'Unknown error';
			const error = new Error(errorMessage);
			// A timeout the user caused by pressing Stop is a stop, not a fault.
			// Read from the signal rather than guessed, so a turn aborted by a timer
			// and a turn aborted by a person stay distinguishable downstream.
			const abortCause: AbortCause | undefined = args.controller.signal.aborted
				? 'user-stop'
				: result.abortCause;
			recoverable = shouldFallback({
				error,
				...(abortCause !== undefined ? { abortCause } : {}),
				timeoutConfigured: this.turnTimeoutMs > 0 || this.firstTokenTimeoutMs > 0,
				hadToolCalls: result.hadToolCalls,
			});
			attempts.push({
				attempt: attemptNumber,
				model: currentModel,
				error,
				recoverable,
				timestamp: this.clock(),
			});

			if (strategy === 'manual') {
				finalResult = 'failed';
				finalModel = currentModel;
				break; // Manual strategy never falls back
			}

			if (!recoverable) {
				finalResult = 'failed';
				finalModel = currentModel;
				break; // Not safe to retry: a user stop, a tool that already ran, or a
				// failure that is not a fault of this particular model.
			}

			// Get next candidate.
			//
			// Given the structured abort cause rather than the message, for the same
			// reason `shouldFallback` does: `continueOrchestration` asks "is this
			// recoverable" again, and answering that by substring would re-introduce
			// the bug one layer down.
			const continuation = continueOrchestration(
				{ primary: plan.primary, candidates: plan.candidates },
				attempts,
				error,
				maxAttempts,
				strategy,
				abortCause !== undefined ? { abortCause } : {},
			);

			if (continuation.nextModel === undefined) {
				finalResult = 'exhausted';
				finalModel = currentModel;
				break;
			}

			currentModel = continuation.nextModel;
			}
		} finally {
			// 5. Log the orchestration, then give the slot up.
			//
			// Logging inside the `finally` so a failed log cannot take the slot with
			// it: a session stuck "busy" refuses every later send, which is a far
			// worse outcome than a missing log entry.
			try {
				await this.orchestrationLog.append(
					buildLogEntry(
						conversation,
						task,
						strategy,
						plan.primary,
						attempts,
						finalModel,
						finalResult,
						decisionReport,
					),
				);
			} catch (error) {
				this.logger.warn('Could not log the orchestration outcome', {
					turnId,
					reason: error instanceof Error ? error.message : String(error),
				});
			}
			this.releaseSlot(turnId);

			// Exactly one terminal event, emitted here because every attempt's own
			// was withheld for the decision. Without this the window shows a turn
			// that never ends — no answer, no error, just a spinner left on.
			if (finalResult === 'success') {
				sink({ type: 'done', turnId, content: '', reason: 'answered', toolCalls: 0 });
			} else if (finalResult === 'cancelled') {
				// A stop is a stop, not an error: the renderer clears its
				// loading state the same way, without a failure card.
				sink({ type: 'done', turnId, content: '', reason: 'aborted', toolCalls: 0 });
			} else {
				const last = attempts[attempts.length - 1];
				sink({
					type: 'error',
					turnId,
					message:
						last?.error?.message ??
						(finalResult === 'exhausted'
							? 'Nenhum modelo elegível respondeu a esta tarefa.'
							: 'A tarefa não pôde ser concluída.'),
				});
			}
		}
	}

	/**
	 * Gives up the session slot for a turn that is over.
	 *
	 * Guarded on the id so a turn can never release a *later* turn's slot — which
	 * is the failure a bare `this.inFlight = undefined` would cause whenever two
	 * turns ever overlapped.
	 */
	private releaseSlot(turnId: string): void {
		if (this.inFlight?.turnId === turnId) {
			this.inFlight = undefined;
		}
	}

	/**
	 * Forgets the conversation of a finished turn, once its consumption closed.
	 *
	 * Separate from `releaseSlot` on purpose: the slot is released when a turn
	 * ends, but the consumption records arrive in the runtime's `finally` and
	 * still need to know which conversation they belong to. Clearing it with
	 * the slot recorded the turn without a conversation whenever there was no
	 * next attempt.
	 */
	private forgetConversation(turnId: string): void {
		this.pendingTurns.delete(turnId);
		// Restored to what the still-running turn belongs to, rather than
		// cleared: the `finally` of one turn can run after the next one has
		// already started, and clearing there would strip the next turn of its
		// conversation and its id.
		const stillRunning = [...this.pendingTurns.entries()];
		const current = stillRunning[stillRunning.length - 1];
		this.conversationInFlight = current?.[1];
		this.turnInFlight = current?.[0];
	}

	/**
	 * The workspace tools run in: the conversation's project root.
	 *
	 * Returns `undefined` for a conversation with no project, which is not an
	 * error — the read-only tools still work against the model, and the
	 * filesystem ones refuse with a message the model can report.
	 */
	private async workspaceFor(conversationId: string): Promise<string | undefined> {
		const record = await this.requireConversation(conversationId);
		if (record.projectId === undefined) {
			return undefined;
		}
		const project = await this.history.getProject(record.projectId);
		if (project === undefined) {
			// The project was deleted but the conversation outlived it. Running
			// with no workspace is the safe reading of that.
			return undefined;
		}
		return project.rootPath;
	}

	/** The conversation, or a clear error. Used before a turn starts. */
	private async requireConversation(conversationId: string): Promise<ConversationRecord> {
		const record = await this.history.getConversation(conversationId);
		if (record === undefined) {
			throw new Error(`No conversation with id "${conversationId}" exists`);
		}
		return record;
	}

	/**
	 * O catálogo para as ferramentas do agente.
	 *
	 * Passa pela **mesma** fusão que a tela mostra (`listMergedCatalog`), e não
	 * por uma segunda leitura dos arquivos: se as duas divergissem, a Evelyn
	 * recomendaria um modelo com capacidades ou preço que a janela não exibe.
	 *
	 * O que sai daqui é metadado. Esta sessão é quem tem o `SecretStore`, e por
	 * isso a tradução **nomeia** os campos: um objeto copiado por espalhamento
	 * levaria junto o que um dia for acrescentado ao modelo fundido.
	 */
	private catalogDirectory(): ModelDirectory {
		return {
			list: async (options) => {
				// A listagem ao vivo **primeiro**, e não por último: é ela que
				// grava o que o provedor publicou, e sem isso o catálogo fundido
				// de uma instalação nova volta vazio mesmo tendo um modelo ao
				// alcance. Um provedor que não responde não impede os outros.
				const live = await this.listAvailableModels().catch(() => [] as readonly AvailableModel[]);
				const { models } = await this.listMergedCatalog(options?.providerId);
				const known = new Set(models.map((entry) => `${entry.providerId}:${entry.modelId}`));
				// Um modelo publicado agora e ainda não descrito entra como "só o
				// nome": é a verdade sobre ele, e a ferramenta o lista em
				// `unknown` em vez de inventar capacidades.
				const extras: ModelRecord[] = live
					.filter((entry) => !known.has(`${entry.providerId}:${entry.model}`))
					.filter((entry) => options?.providerId === undefined || entry.providerId === options.providerId)
					.map((entry) => ({
						providerId: entry.providerId,
						providerName: entry.providerName,
						modelId: entry.model,
						available: true,
					}));
				return [
					...models.map((entry) => ({
						providerId: entry.providerId,
						providerName: entry.providerId,
						modelId: entry.modelId,
						// `missingSince` é o fato que separa "o provedor não publica
						// mais" de "nunca soube": um modelo some da listagem e o
						// histórico continua lá.
						available: entry.missingSince === undefined && entry.listed,
						...(entry.declaredAccess !== undefined ? { access: entry.declaredAccess } : {}),
						...(entry.capabilities !== undefined && entry.capabilities.toolCalling?.effective !== undefined ||
						entry.capabilities?.reasoning?.effective !== undefined ||
						entry.capabilities?.structuredOutput?.effective !== undefined
							? {
									capabilities: {
										...(entry.capabilities?.toolCalling?.effective !== undefined
											? { toolCalling: entry.capabilities.toolCalling.effective }
											: {}),
										...(entry.capabilities?.structuredOutput?.effective !== undefined
											? { structuredOutput: entry.capabilities.structuredOutput.effective }
											: {}),
										...(entry.capabilities?.reasoning?.effective !== undefined
											? { reasoning: entry.capabilities.reasoning.effective }
											: {}),
									},
								}
							: {}),
						...(entry.limits !== undefined &&
						(entry.limits.contextTokens?.effective !== undefined ||
							entry.limits.maxOutputTokens?.effective !== undefined)
							? {
									limits: {
										...(entry.limits.contextTokens?.effective !== undefined
											? { contextTokens: entry.limits.contextTokens.effective }
											: {}),
										...(entry.limits.maxOutputTokens?.effective !== undefined
											? { maxOutputTokens: entry.limits.maxOutputTokens.effective }
											: {}),
									},
								}
							: {}),
						...priceRecord(entry.price),
						...(entry.policyStatus.eligible ? {} : { policyReason: entry.policyStatus.reason }),
					})),
					...extras,
				];
			},
			refreshDiscovery: async (providerId) => {
				// A mesma descoberta que o botão "Descobrir modelos" dispara:
				// mesma fonte, mesmo registro, mesmo cache. Nada novo é chamado.
				const result = await this.discoverModels(providerId);
				const failed = result.failed ?? [];
				const counts = new Map<string, number>();
				for (const entry of result.byProvider ?? []) {
					counts.set(entry.providerId, (counts.get(entry.providerId) ?? 0) + 1);
				}
				return {
					providers: [
						...[...counts.entries()].map(([id, models]) => ({ providerId: id, ok: true, models })),
						...failed.map((failure) => ({
							providerId: failure.providerId,
							ok: false,
							message: failure.reason,
						})),
					],
				};
			},
			guidance: async () => {
				const guidance = await this.readModelGuidance();
				return guidance?.entries ?? [];
			},
			allowPaid: async () => this.allowPaid,
		};
	}

	/**
	 * A seleção que as ferramentas do catálogo usam.
	 *
	 * O **mesmo** `classifyTask` e o **mesmo** `selectModels` do turno: a
	 * ferramenta não tem uma segunda opinião sobre qual modelo serve. O Core
	 * recebe isto como porta porque não pode importar o desktop; o host —
	 * este arquivo — é quem liga as duas coisas.
	 */
	private catalogSelection(): ModelSelectionPort {
		return {
			classify: (text, overrides) => {
				// A mesma classificação do turno, **com o histórico recente**: uma
				// frase curta ("recomende um modelo para escrever código") só
				// revela que precisa de ferramentas quando lida junto do pedido
				// anterior. Sem o histórico, o classificador dizia "sem
				// ferramentas" e a recomendação ignorava os modelos que as têm.
				const base = classifyTask(text, this.recentUserMessages);
				const domain =
					overrides.domain !== undefined &&
					['coding', 'file-analysis', 'blender', 'api-design', 'database', 'networking', 'general', 'unknown'].includes(overrides.domain)
						? (overrides.domain as typeof base.domain)
						: base.domain;
				const complexity =
					overrides.complexity !== undefined &&
					['trivial', 'simple', 'moderate', 'complex', 'unknown'].includes(overrides.complexity)
						? (overrides.complexity as typeof base.complexity)
						: base.complexity;
				return {
					domain,
					complexity,
					needsTools: overrides.needsTools ?? base.needsTools,
					requiredCapabilities: overrides.requiredCapabilities ?? base.requiredCapabilities,
				};
			},
			recommend: ({ task, models, guidance, allowPaid, maxCandidates }) => {
				// O catálogo no formato do seletor, a partir do **registro
				// fundido inteiro**: capacidades, limites, preço e observações
				// vêm da mesma fonte que a tela mostra. Antes, um modelo com
				// histórico medido era pontuado como se nunca tivesse rodado,
				// e o modelo com execução real perdia esse ponto na consulta.
				const fused = new Map(this.fusedCatalogSnapshot.map((item) => [`${item.providerId}:${item.modelId}`, item]));
				const catalog: ModelCatalogEntry[] = models.map((entry) => {
					// A chave é o **id** do provedor, que é como o catálogo fundido
					// é indexado. Casar pelo nome de exibição devolvia sempre
					// `undefined` e a recomendação caía no registro mínimo — o
					// que se pesquisa e grava nunca chegava à decisão.
					const record = fused.get(`${entry.providerId}:${entry.modelId}`);
					if (record !== undefined) {
						return record;
					}
					// Registro ausente da cópia do turno (recém-gravado, por
					// exemplo): os campos pesquisados vêm da lista, que é lida do
					// mesmo catálogo. Antes, aqui ficava `capabilities: []` e o
					// que a pesquisa acabara de confirmar era ignorado.
					const tags = capabilityTags(entry.capabilities);
					return {
						providerId: entry.providerId,
						modelId: entry.modelId,
						capabilities: tags,
						access: entry.access ?? 'unknown',
						...(entry.limits !== undefined ? { limits: entry.limits } : {}),
						observations: [],
						createdAt: '',
						updatedAt: '',
					};
				});
				const selection = selectModels({
					task: task as Parameters<typeof selectModels>[0]['task'],
					availableModels: models.map((entry) => ({
						providerId: entry.providerId,
						providerName: entry.providerName,
						model: entry.modelId,
					})),
					catalog,
					maxCandidates: maxCandidates + 1,
					allowPaid,
					...(guidance.length > 0
						? { guidance: guidance as readonly ModelGuidanceEntry[] }
						: {}),
				});
				const blocked = new Set(
					catalog
						.filter((entry) =>
							isPaidBlocked(
								{
									providerId: entry.providerId,
									modelId: entry.modelId,
									providerName: entry.providerId,
									catalog: entry,
									available: true as const,
								},
								allowPaid,
							),
						)
						.map((entry) => `${entry.providerId}:${entry.modelId}`),
				);
				// O filtro do seletor descarta o pago sem explicar; aqui o motivo
				// é dito pela mesma regra, sem uma segunda política.
				const withConstraints = (reason: SelectionReason): SelectionReason =>
					blocked.has(`${reason.providerId}:${reason.modelId}`) &&
					!(reason.constraints ?? []).some((constraint) => constraint.id === 'paid_not_allowed')
						? {
								...reason,
								constraints: [
									...(reason.constraints ?? []),
									{
										id: 'paid_not_allowed',
										label: 'paid model, paid access not authorized',
										detail:
											'this model is classified as paid and paid access is not authorized in this session',
									},
								],
							}
						: reason;
				const primaryReason = selection.reasons.find((reason) => reason.chosen);
				return {
					...(selection.primary !== undefined && primaryReason !== undefined
						? {
								primary: {
									providerName:
										models.find((entry) => entry.providerId === selection.primary?.providerId)
											?.providerName ?? selection.primary.providerId,
									modelId: selection.primary.modelId,
								},
							}
						: {}),
					reasons: selection.reasons.map((reason) => {
						const explained = withConstraints(reason);
						return {
							providerName:
								models.find((entry) => entry.providerId === explained.providerId)?.providerName ??
								explained.providerId,
							modelId: explained.modelId,
							chosen: explained.chosen,
							...(explained.score !== undefined ? { score: explained.score } : {}),
							reason: explained.reason,
							...(explained.components !== undefined
								? {
										components: explained.components.map((component) => ({
											id: component.id,
											points: component.points,
											detail: component.detail,
										})),
									}
								: {}),
							...(explained.constraints !== undefined && explained.constraints.length > 0
								? { excludedBecause: explained.constraints.map((item) => item.detail) }
								: {}),
							...(explained.confidence !== undefined && explained.confidence.length > 0
								? { confidence: explained.confidence.map((item) => item.detail) }
								: {}),
						};
					}),
				};
			},
		};
	}

	/**
	 * A pesquisa de catálogo, para as ferramentas do agente.
	 *
	 * Usa o provedor configurado — a escolha do usuário — com **um** pedido de
	 * texto, no qual as ferramentas web estão disponíveis: o modelo abre as
	 * páginas que cita antes de escrever o formulário. A pesquisa roda fora do
	 * laço do agente (é um pedido único), então não pode encadear ferramentas
	 * perigosas — e as perigosas nem são oferecidas.
	 *
	 * O resultado é texto cru; quem o interpreta é `parseResearch`, que recusa
	 * fonte inventada.
	 *
	 * Sem provedor utilizável, devolve `undefined`: a ferramenta então diz que
	 * não pesquisou, e o campo continua desconhecido — o que é diferente de
	 * "pesquisou e não existe".
	 */
	private catalogResearch(): ModelResearchPort {
		return {
			research: async ({ providerId, modelId, goal }) => {
				const usable =
					this.config
						.list()
						.find(
							(provider) =>
								provider.id === providerId && provider.enabled && provider.role !== 'search',
						) ??
					this.config.list().find((provider) => provider.enabled && provider.role !== 'search');
				if (usable === undefined) {
					return undefined;
				}
				// O modelo que pesquisa é o primeiro que este provedor publica:
				// o diário não tem escolha para fazer, e usar o da conversa
				// exigiria um contexto que a ferramenta não tem.
				const published = await this.listAvailableModels().catch(() => []);
				const model = published.find((entry) => entry.providerId === usable.id)?.model;
				if (model === undefined) {
					return undefined;
				}
				// O ciclo: o mesmo laço de ferramentas do agente, com orçamento
				// próprio (8 rodadas, 20 páginas) e só as três ferramentas web.
				// Nenhum terminal, nenhuma escrita.
				const exploratorio = goal !== undefined && modelId === goal;
				const objetivo = exploratorio
					? goal
					: [
							`Modelo: ${modelId}`,
							`Provedor: ${usable.name}`,
							'',
							'Descubra: capacidades (ferramentas, raciocínio), janela de contexto e limite de',
							'saída, preço de entrada e saída, se é gratuito / com cota gratuita / pago, e como',
							'obter acesso.',
							...(goal !== undefined ? ['', `Foco do usuário: ${goal}`] : []),
							'',
							'Termine com o formulário abaixo, preenchido SÓ com o que você abriu e leu:',
							RESEARCH_FORMAT,
						].join('\n');
				const run = await runResearchCycle({
					provider: this.buildProvider(usable.id),
					model,
					goal: objetivo,
					web: await this.webPorts(),
					prompt: researchPrompt(objetivo),
					sessionId: `research-${Date.now()}`,
				});
				return {
					answer: run.conclusion,
					query: exploratorio ? `research: ${modelId}` : `research ${providerId}/${modelId}`,
					run,
				};
			},
			apply: async ({ providerId, modelId, confirmed, sources }) => {
				// O provedor pode ter chegado como nome de exibição — foi o que o
				// modelo viu na lista. O catálogo indexa por id, e gravar no nome
				// criava uma entrada órfã que a recomendação nunca encontrava.
				const configured =
					this.config.get(providerId) ??
					this.config.list().find((provider) => provider.name === providerId);
				const realProviderId = configured?.id ?? providerId;
				// A origem fica `manual` porque foi o usuário que confirmou; a
				// nota carrega a procedência, para a próxima pessoa saber de
				// onde veio cada número.
				const provenance =
					sources !== undefined && sources.length > 0
						? `Pesquisado e confirmado pelo usuário. Fontes: ${sources
								.map((source) => source.url ?? source.kind)
								.join(', ')}`
						: undefined;
				await this.saveModelCatalogEntry({
					providerId: realProviderId,
					modelId,
					...(confirmed.limits !== undefined
						? {
								limits: {
									...(confirmed.limits.contextTokens !== undefined
										? { contextTokens: String(confirmed.limits.contextTokens) }
										: {}),
									...(confirmed.limits.maxOutputTokens !== undefined
										? { maxOutputTokens: String(confirmed.limits.maxOutputTokens) }
										: {}),
								},
							}
						: {}),
					...(confirmed.model !== undefined
						? {
								model: {
									...(confirmed.model.toolCalling !== undefined
										? { toolCalling: confirmed.model.toolCalling }
										: {}),
									...(confirmed.model.structuredOutput !== undefined
										? { structuredOutput: confirmed.model.structuredOutput }
										: {}),
									...(confirmed.model.reasoning !== undefined
										? { reasoning: confirmed.model.reasoning }
										: {}),
								},
							}
						: {}),
					...(confirmed.pricing !== undefined
						? {
								pricing: {
									currency: confirmed.pricing.currency,
									unit: confirmed.pricing.unit,
									...(confirmed.pricing.input !== undefined
										? { input: String(confirmed.pricing.input) }
										: {}),
									...(confirmed.pricing.output !== undefined
										? { output: String(confirmed.pricing.output) }
										: {}),
								},
							}
						: {}),
					...(confirmed.access !== undefined && confirmed.access !== 'unknown'
						? { access: confirmed.access }
						: {}),
					...(confirmed.notes !== undefined || provenance !== undefined
						? {
								notes: [confirmed.notes, provenance]
									.filter((part): part is string => part !== undefined && part.length > 0)
									.join(' — '),
							}
						: {}),
				});
			},
		};
	}

	/**
	 * As portas das ferramentas web.
	 *
	 * O `fetch` e a busca vivem no host (`app/webClient.ts`): o Core descreve a
	 * ferramenta, o host fala com a rede. A chave do buscador sai do
	 * `SecretStore` aqui — e é o único lugar onde ela existe em claro; ela entra
	 * num cabeçalho e não é devolvida em resultado, erro ou log.
	 *
	 * Sem provedor de busca configurado, a busca sem chave (DuckDuckGo) é o
	 * caminho; por isso ela é sempre `available`, e é a resposta real que diz
	 * se funcionou.
	 */
	private async webPorts(): Promise<WebPorts> {
		const searchProvider = this.config
			.list()
			.find((provider) => provider.role === 'search' && provider.enabled);
		// A leitura do segredo é assíncrona: a chave é decifrada no acesso e não
		// fica num campo da sessão esperando alguém a ler.
		const searchKey =
			searchProvider?.apiKeyRef !== undefined
				? await this.secrets.get(searchProvider.apiKeyRef).catch(() => undefined)
				: undefined;
		const client = createWebClient({
			...(this.fetchImpl !== undefined
				? {
						// O `fetch` injetado é o da sessão (para testes); o cliente web
						// só usa GET, então a forma estreita é a que importa aqui.
						fetch: ((input, init) =>
							this.fetchImpl!(typeof input === 'string' ? input : String(input), init as never)) as typeof globalThis.fetch,
					}
				: {}),
			...(searchKey !== undefined && searchKey.length > 0 ? { searchKey } : {}),
			...(searchProvider?.baseUrl !== undefined && searchProvider.baseUrl.length > 0
				? { searchBaseUrl: searchProvider.baseUrl }
				: {}),
		});
		return client;
	}

	/** The tool registry, built once and reused across turns. */
	private async tools(): Promise<ToolRegistry> {
		if (this.registry === undefined) {
			// As portas da web precisam da chave do buscador, que é decifrada em
			// chamada assíncrona — por isso o registry é montado uma vez, aqui.
			const webPorts = await this.webPorts();
			// A base do registry, antes dos `extraTools`
			const catalogTools = () =>
				createModelCatalogTools(this.catalogDirectory(), this.catalogSelection(), this.catalogResearch());
			// The real command runner, not a stub: this is the product's own
			// stack, and `run_command` is `dangerous` so the gateway denies it
			// before the runner is ever reached.
			const stack = createMvpAgentStack({
				memoryService: this.memoryService,
				skillService: this.skillService,
				// DEV-2.1: o `run_command` comum e as ferramentas DEV compartilham
				// a trava do repositório. Sem isto, um comando comum poderia ler o
				// arquivo que o DEV acabou de trocar.
				...(this.dev !== undefined
					? {
							commandRunner: coordinateCommandRunner(defaultCommandRunner, this.dev.locks),
							// DEV-10: com a sessão ativa, `run_command` recusa em vez de
							// escrever sem checkpoint.
							devSession: this.dev.session,
						}
					: {}),
				// DEV-2: as ferramentas do modo DEV, quando o host oferece a
				// sessão. Elas checam `session.isActive()` a cada execução, então
				// o registro aqui não é uma autorização — é só o que o modelo vê
				// quando o modo existe.
				...(this.dev !== undefined
					? {
							// DEV-5: o par ferramenta/spec vem do nome da ferramenta, não
							// do índice — emparelhar duas listas paralelas por posição
							// deixaria `dev_apply` sem spec.
							extraTools: [
								...createDevToolEntries(this.dev),
								// O catálogo de modelos: leitura `safe`, sem terminal, sem
								// workspace e sem o modo DEV. Não depende da trava do
								// repositório porque não lê arquivo nenhum — lê a sessão.
								...catalogTools(),
								// A web: buscar, abrir e navegar. Também sem workspace e
								// sem DEV — é pesquisa, não acesso ao projeto.
								...createWebTools(webPorts),
							],
						}
					: {
							extraTools: [...catalogTools(), ...createWebTools(webPorts)],
						}),
			});
			this.registry = stack.registry;
			this.toolDisposer = stack.dispose;
			// Wrapped after registration so the runtime and the registry both see
			// one entry per tool, and the recorder sits inside it.
			this.recorders = addRecorders(this.registry);
		}
		return this.registry;
	}

	/**
	 * The permission gateway the runtime asks.
	 *
	 * The Core's own `createRiskGateway` decides *whether* to ask — `safe` runs
	 * automatically, `moderate` and `dangerous` are worth a question — and the
	 * broker carries the question to the user and brings the answer back. Neither
	 * restates the other's rule, so changing which tools need a dialog is a
	 * change to the risk mapping alone.
	 */
	/**
	 * A porta de permissões que pergunta a **um** broker (R4C).
	 *
	 * Uma por turno. Sem ela, `permissions()` fecharia sobre `this.broker` — o
	 * da sessão — e um turno externo perguntaria ao turno de outro cliente.
	 * O `denyDangerous` é o mesmo: a regra de risco não muda por causa de quem
	 * pede.
	 */
	private permissionsFor(broker: PermissionBroker): PermissionGateway {
		return createRiskGateway({
			onAsk: (request: PermissionRequest) => broker.gateway.ask(request),
			denyDangerous: false,
		});
	}

	private permissions(): PermissionGateway {		// Built once, and cached with the gateway so the two cannot drift apart.
		// The broker it closes over is replaced per turn, but the closure reads
		// `this.broker` at call time, so it always asks the live one.
		this.permissionGateway ??= createRiskGateway({
			// `createRiskGateway` hands `onAsk` the request only — it does not
			// forward an abort signal — so a withdrawn turn is handled by `stop()`
			// calling `cancelAll`, not by the signal. The Core's gateway contract is
			// left alone; this is where that decision is made, not hidden.
			onAsk: (request: PermissionRequest) => {
				const broker = this.broker;
				if (broker === undefined) {
					// No turn is running, so there is nobody to ask. Denying is the
					// only safe answer: allowing would run a tool with no user in
					// the loop.
					return Promise.resolve({
						decision: 'deny',
						reason: 'there is no active request to ask about',
					});
				}
				return broker.gateway.ask(request);
			},
			// The user is asked about dangerous tools now, so nothing is denied
			// outright. Refusing them by policy would make a confirmation dialog
			// for `run_command` unreachable.
			denyDangerous: false,
		});
		return this.permissionGateway;
	}

	/** Appends the message the user just sent. */
	private async appendUser(conversationId: string, content: string): Promise<void> {
		await this.history.appendMessages(
			conversationId,
			toAppendInputs([{ role: 'user', content }]),
		);
	}

	/**
	 * Persiste a mensagem do usuário **antes** de o turno começar (R4O/R4Q).
	 *
	 * Chamado pela rota quando o turno é aceito, e antes de qualquer
	 * confirmação ao cliente. A idempotência é **da chave**, não do texto: um
	 * envio repetido com a mesma `requestId` devolve `stored: false` e a
	 * mensagem já gravada, para o chamador não executar o turno duas vezes.
	 * Duas perguntas iguais de propósito (sem chave, ou com chaves diferentes)
	 * gravam duas mensagens.
	 *
	 * `runExternalTurn` **não** grava depois: a rota já gravou, e gravar de
	 * novo seria a origem da duplicação que a R4Q elimina.
	 */
	async persistUserMessage(
		conversationId: string,
		content: string,
		requestId?: string,
	): Promise<{ readonly persisted: boolean; readonly message: ConversationMessage }> {
		const result = await this.history.appendUserMessage(conversationId, {
			content,
			...(requestId !== undefined && requestId.length > 0 ? { requestId } : {}),
		});
		return { persisted: result.stored, message: result.message };
	}

	/** Appends one tool result, in the order the tools completed. */
	private async appendToolResult(
		conversationId: string,
		content: string,
		toolCallId: string,
	): Promise<void> {
		await this.history.appendMessages(
			conversationId,
			toAppendInputs([{ role: 'tool', content, toolCallId }]),
		);
	}

	/** Appends the model's answer, with the tool calls it asked for. */
	private async appendAssistant(
		conversationId: string,
		content: string,
		toolCalls?: readonly ToolCallRequest[],
	): Promise<void> {
		await this.history.appendMessages(
			conversationId,
			toAppendInputs([
				{
					role: 'assistant',
					content,
					...(toolCalls !== undefined && toolCalls.length > 0 ? { toolCalls } : {}),
				},
			]),
		);
	}

	/**
	 * The live provider for an id, built from persisted config on first use.
	 *
	 * Throws naming the provider when there is none, so the renderer can say
	 * "that provider is gone" instead of failing later at the socket.
	 */
	private resolveProvider(providerId: string): OpenAICompatibleProvider {
		const cached = this.live.get(providerId);
		if (cached !== undefined) {
			return cached;
		}
		const config = this.config.get(providerId);
		if (config === undefined) {
			throw new Error(`No provider named "${providerId}" is configured`);
		}
		const provider = new OpenAICompatibleProvider({
			id: config.id,
			name: config.name,
			baseUrl: config.baseUrl,
			...(config.apiKeyRef !== undefined ? { apiKeyRef: config.apiKeyRef } : {}),
			// Repassed so the provider can enforce it. Dropping the flag here
			// would mean a disabled provider keeps chatting, because this is
			// the only place the desktop builds one.
			enabled: config.enabled,
			secrets: this.secrets,
			...(this.fetchImpl !== undefined ? { fetch: this.fetchImpl } : {}),
		});
		this.live.set(providerId, provider);
		return provider;
	}


	/**
	 * Constroi uma instancia nova, sempre, sem tocar no cache de provedores.
	 *
	 * Os caminhos que chamam um modelo de verdade usam esta: o provedor roteado
	 * e o observador sao fixos por turno, e um provedor reaproveitado de um turno
	 * anterior carregaria o ultimo /models e os ultimos cabecalhos como se fossem
	 * do turno atual. A descoberta de modelos segue usando o cache, onde
	 * reaproveitar e exatamente o proposito.
	 */
	private buildProvider(providerId: string): OpenAICompatibleProvider {
		const config = this.config.get(providerId);
		if (config === undefined) {
			throw new Error(`No provider named "${providerId}" is configured`);
		}
		return new OpenAICompatibleProvider({
			id: config.id,
			name: config.name,
			baseUrl: config.baseUrl,
			...(config.apiKeyRef !== undefined ? { apiKeyRef: config.apiKeyRef } : {}),
			enabled: config.enabled,
			secrets: this.secrets,
			...(this.fetchImpl !== undefined ? { fetch: this.fetchImpl } : {}),
		});
	}

	/**
	 * Wraps a candidate list in the Core routing engine.
	 *
	 * Built per turn, on purpose: the provider pins whichever candidate commits,
	 * and a pinned model is only correct for the turn whose transcript it
	 * produced.
	 */
	private buildRoutedProvider(
		models: readonly { readonly providerId: string; readonly modelId: string }[],
		observer?: RoutingObserver,
	): RoutedChatProvider {
		const routing = this.routing;
		const breaker = this.routingBreaker;
		if (routing === undefined || breaker === undefined) {
			throw new Error('Routing was requested for a session that did not enable it');
		}
		const targets: RouteTarget[] = models.map((model) => ({
			providerId: model.providerId,
			modelId: model.modelId,
			provider: createObservingProvider({
				inner: this.buildProvider(model.providerId),
				providerId: model.providerId,
				discovery: this.providerDiscovery,
				// O modelo que o servidor disse que respondeu. Num roteador
				// externo ele pode ser outro que o pedido, e é a única
				// afirmação que existe sobre quem respondeu.
				onRespondedModel: (target, respondedModel) => {
					this.respondedModels.set(
						`${target.providerId}:${target.modelId}`,
						respondedModel,
					);
				},
				onFailure: (error) =>
					this.logger.warn('Could not record provider discovery from a chat response', {
						error: describeError(error),
					}),
			}),
		}));
		return new RoutedChatProvider({
			targets,
			policy: routing.policy,
			breaker,
			...(this.routingMetrics !== undefined ? { metrics: this.routingMetrics } : {}),
			...(observer !== undefined ? { observer } : {}),
			...(routing.clock !== undefined ? { clock: routing.clock } : {}),
			...(routing.sleep !== undefined ? { sleep: routing.sleep } : {}),
			...(routing.routeId !== undefined ? { routeId: routing.routeId } : {}),
			...(this.budgetGate !== undefined ? { budget: this.budgetGate } : {}),
			quotas: this.quotaTracker,
		});
	}

	/**
	 * Announces, once per candidate, a route attempt a spending limit vetoed.
	 *
	 * Reads the attempts the provider kept (`provider.attempts`) rather than the
	 * engine's terminal error, so the announcement is the same whether the turn
	 * ended in a fallback, a success elsewhere or exhaustion. A vetoed candidate
	 * is skipped and recorded once per distinct `(provider, model)`, even though
	 * the route may have examined it in several requests of the same turn.
	 */
	private announceBudgetBlocks(turnId: string, provider: ChatProvider, sink: AgentEventSink): void {
		const routed = provider as ChatProvider & { readonly attempts?: readonly RouteAttempt[] };
		const all = routed.attempts;
		if (all === undefined || all.length === 0) {
			return;
		}
		const seen = new Set<string>();
		for (const record of all) {
			if (record.errorClass !== 'budget_exhausted') {
				continue;
			}
			const key = `${record.providerId}:${record.modelId}`;
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			sink({
				type: 'budgetBlocked',
				turnId,
				providerId: record.providerId,
				modelId: record.modelId,
				attempt: record.sequence,
				message:
					record.budgetMessage?.trim() ??
					`Um limite de orçamento bloqueou ${record.providerId}/${record.modelId}.`,
			});
		}
	}

	/**
	 * O preço em vigor para um modelo, conforme a escolha do usuário.
	 *
	 * Passa pela mesma função que a tela usa (`comparePrices`), para que o
	 * número do orçamento e o número da tela nunca discordem. Sem preço em
	 * lugar nenhum, o resultado é `undefined` — desconhecido, nunca zero.
	 */
	async effectivePricingFor(candidate: {
		readonly providerId: string;
		readonly modelId: string;
	}): Promise<ModelPricing | undefined> {
		const record = await this.loadAccessPolicy();
		const nowMs = Date.now();
		let declared: { readonly pricing: ModelPricing; readonly updatedAt?: string } | undefined;
		try {
			const entry = await this.history.getModelCatalogEntry(candidate);
			if (entry?.pricing !== undefined) {
				declared = { pricing: entry.pricing, updatedAt: entry.updatedAt };
			}
		} catch (error) {
			this.logger.warn('Could not read the declared price', {
				providerId: candidate.providerId,
				modelId: candidate.modelId,
				error: describeError(error),
			});
		}
		let discovered: DiscoveredModel['pricing'];
		try {
			const found = await this.history.getDiscoveredModel(candidate);
			discovered = found?.pricing;
		} catch (error) {
			this.logger.warn('Could not read the discovered price', {
				providerId: candidate.providerId,
				modelId: candidate.modelId,
				error: describeError(error),
			});
		}
		return comparePrices({
			...(declared !== undefined ? { user: declared } : {}),
			...(discovered !== undefined
				? {
						discovered: {
							pricing: discovered.pricing,
							source: discovered.source,
							verifiedAt: discovered.verifiedAt,
							expiresAt: discovered.expiresAt,
							stale: discovered.stale,
						},
					}
				: {}),
			chosen: record.priceSource,
			nowMs,
		}).effective?.pricing;
	}

	/**
	 * O custo de cada tentativa, como o ledger o mediu.
	 *
	 * O ledger é quem sabe: ele precificou a chamada com o preço em vigor e
	 * registrou o resultado. O relatório só carrega — e é o ledger que diz se
	 * o custo é uma estimativa ou se não deu para saber.
	 */
	private async costsOf(
		attempts: readonly RouteAttempt[],
	): Promise<
		| Map<
				string,
				{
					readonly status: 'estimated' | 'unknown';
					readonly currency?: string;
					readonly total?: number;
					readonly reasons: readonly string[];
				}
		  >
		| undefined
	> {
		if (attempts.length === 0) {
			return undefined;
		}
		const requestIds = new Set(attempts.map((attempt) => attempt.requestId));
		const costs = new Map<
			string,
			{
				readonly status: 'estimated' | 'unknown';
				readonly currency?: string;
				readonly total?: number;
				readonly reasons: readonly string[];
			}
		>();
		for (const requestId of requestIds) {
			try {
				const executions = await this.history.listConsumption({});
				for (const execution of executions) {
					if (execution.executionId !== requestId && !execution.executionId.endsWith(`:${requestId}`)) {
						continue;
					}
					for (const attempt of await this.history.listAttempts(execution.executionId)) {
						const key = `${attempt.providerId}:${attempt.modelId}`;
						const cost = attempt.cost;
						costs.set(key, {
							status: cost.status,
							...(cost.status === 'estimated' ? { currency: cost.currency, total: cost.total } : {}),
							reasons: cost.status === 'unknown' ? cost.reasons : [],
						});
					}
				}
			} catch (error) {
				this.logger.warn('Could not read the recorded costs while reporting a decision', {
					error: describeError(error),
				});
				return undefined;
			}
		}
		return costs.size === 0 ? undefined : costs;
	}

	/**
	 * A configuração do roteador, lida do disco a cada turno.
	 *
	 * Lida a cada turno, e não uma vez no arranque, porque o usuário pode
	 * mudá-la pela janela com o app aberto. Um arquivo ilegível cai no padrão
	 * — que é o comportamento de sempre — e é logado: uma configuração que não
	 * pode ser lida não pode ser imposta.
	 */
	async routerConfig(): Promise<RouterConfig> {
		try {
			return (await this.history.readRouterConfig()) ?? DEFAULT_ROUTER_CONFIG;
		} catch (error) {
			// O turno continua funcionando com o padrão — mas a visão diz que o
			// arquivo existe e não pôde ser lido. Esconder isso faria a página
			// mostrar "nunca configurado" e a próxima gravação sobrescrever um
			// arquivo que talvez ainda pudesse ser recuperado.
			this.logger.warn('Could not read the router configuration; using the default', {
				error: describeError(error),
			});
			return DEFAULT_ROUTER_CONFIG;
		}
	}

	/**
	 * Grava a configuração do roteador.
	 *
	 * A gravação é validada: um estado que o app não pode obedecer — um modo
	 * que aponta para um provedor inexistente — é recusado em vez de ficar
	 * gravado esperando falhar no meio de um turno.
	 */
	async saveRouterConfig(config: RouterConfig): Promise<RouterConfig> {
		return this.history.saveRouterConfig(config);
	}

	/**
	 * Onde a configuração do roteador mora.
	 *
	 * Usado por quem precisa guardar um arquivo ilegível ao lado, sem abrir
	 * caminhos de armazenamento por conta própria.
	 */
	routerConfigFilePath(): string {
		return this.history.routerConfigFilePath();
	}

	/**
	 * Habilita ou desabilita uma conexão.
	 *
	 * Só o **estado** muda: o endereço, o papel e a chave ficam como estão.
	 * Desabilitar é o que impede uma requisição de sair para um endpoint que
	 * o usuário não quer usar agora — e o que faz o Core recusar um destino
	 * desabilitado, com o motivo.
	 */
	async setProviderEnabled(providerId: string, enabled: boolean): Promise<ProviderSummary> {
		const config = this.config.get(providerId);
		if (config === undefined) {
			throw new Error(`Não há provedor "${providerId}" configurado.`);
		}
		await this.config.save({ ...config, enabled });
		this.logger.info('Provider enabled state changed', { providerId, enabled });
		return toSummary(this.config.get(providerId) ?? config);
	}

	/**
	 * Promove um endpoint a roteador, ou o reclassifica como provedor.
	 *
	 * ## A regra de coerência
	 *
	 * Rebaixar o endpoint que o **modo externo** está usando é recusado: o
	 * modo passaria a apontar para algo que já não é um roteador, e a
	 * próxima requisição falharia sem explicação. A recusa diz o que fazer —
	 * troque o modo antes — em vez de mudar o estado por baixo.
	 *
	 * Promover é sempre permitido: um endpoint que é um roteador continua
	 * atendendo chamadas diretas, e o modo ativo não depende do papel para
	 * funcionar.
	 *
	 * ## O que não é tocado
	 *
	 * A chave, o endereço, o estado de habilitação. Isto só muda **o papel**,
	 * e nada mais — trocar de papel não é uma edição do provedor.
	 */
	async setProviderRole(
		providerId: string,
		role: 'router' | 'provider' | 'search',
	): Promise<ProviderSummary> {
		const config = this.config.get(providerId);
		if (config === undefined) {
			throw new Error(`Não há provedor "${providerId}" configurado.`);
		}
		if (role !== 'router') {
			const router = await this.routerConfig();
			const inUse =
				router.mode === 'external' && router.externalRouterProviderId === providerId;
			if (inUse) {
				throw new Error(
					`O modo "externo" está usando "${config.name}" como roteador. Troque o modo antes de reclassificá-lo como ${role === 'search' ? 'buscador' : 'provedor'}.`,
				);
			}
		}
		await this.config.save({
			...config,
			// Um buscador não tem modelo: o papel é gravado e o roteador deixa
			// de considerá-lo por ser `role !== 'provider'` (ver `providerRoleOf`).
			...(role === 'router' || role === 'search' ? { role } : { role: undefined }),
		});
		this.logger.info('Provider role changed', { providerId, role });
		return toSummary(this.config.get(providerId) ?? config);
	}

	/**
	 * A configuração do roteador, no formato que a janela lê.
	 *
	 * `configured` distingue "nunca configurado" de "configurado como o
	 * padrão": o painel mostra um nos dois casos, e a diferença é o que separa
	 * "você escolheu isto" de "isto é o que o app faz por conta própria".
	 */
	async readRouterConfig(): Promise<RouterConfigView> {
		let stored: RouterConfig | undefined;
		let unreadable: string | undefined;
		try {
			stored = await this.history.readRouterConfig();
		} catch (error) {
			this.logger.warn('Could not read the router configuration; using the default', {
				error: describeError(error),
			});
			// A visão diz que o arquivo existe e não pôde ser lido. Esconder isso
			// faria a página mostrar "nunca configurado" e a próxima gravação
			// sobrescrever um arquivo que talvez ainda pudesse ser recuperado.
			unreadable = 'o arquivo do roteador existe, mas não pôde ser lido';
		}
		// A procedência vem do mesmo store que leu: não é uma segunda
		// checagem do disco.
		const recovered = stored !== undefined && this.history.routerConfigOrigin?.() === 'recovered';
		const config = stored ?? DEFAULT_ROUTER_CONFIG;
		return {
			mode: config.mode,
			enabled: config.enabled,
			...(config.externalRouterProviderId !== undefined
				? { externalRouterProviderId: config.externalRouterProviderId }
				: {}),
			...(config.directProviderId !== undefined ? { directProviderId: config.directProviderId } : {}),
			updatedAt: config.updatedAt,
			configured: stored !== undefined,
			// DEV-8.11: no modo local, a fonte é o Core deste processo. O modo
			// conectado lê a mesma decisão do Core do serviço, e a interface
			// mostra de onde veio.
			source: 'local',
			...(unreadable !== undefined ? { unreadable } : {}),
			...(recovered ? { recoveredFromBackup: true } : {}),
		};
	}

	/**
	 * Muda o roteador a partir do que a janela mudou.
	 *
	 * Só o que vem preenchido muda: o interruptor sozinho não toca no modo, e
	 * escolher o modo externo sem escolher o provedor é recusado pela
	 * validação — em vez de gravar um estado que o app não pode obedecer.
	 *
	 * ## A validação vale para o que esta chamada escolhe
	 *
	 * O destino escolhido tem de existir e estar habilitado: uma configuração
	 * que aponta para um provedor ausente ou desabilitado não pode ser
	 * obedecida, e gravá-la só adiaria a falha para o meio de um turno.
	 *
	 * O destino **herdado** do estado anterior fica como está, mesmo que
	 * tenha sido desabilitado depois. O interruptor do painel principal muda
	 * só o `enabled`, e ele precisa funcionar justamente quando o destino
	 * herdado não serve mais: desligar o roteador não pode ser impedido pelo
	 * endpoint que ele apontava.
	 */
	async changeRouterConfig(input: SetRouterConfigInput): Promise<RouterConfigView> {
		const current = await this.readRouterConfig();
		const mode = input.mode ?? current.mode;
		const external = input.externalRouterProviderId ?? current.externalRouterProviderId;
		const direct = input.directProviderId ?? current.directProviderId;
		const targetId = mode === 'external' ? external : mode === 'direct' ? direct : undefined;
		const chooses =
			input.mode !== undefined ||
			input.externalRouterProviderId !== undefined ||
			input.directProviderId !== undefined;
		if (chooses && mode !== 'native' && (targetId === undefined || targetId.length === 0)) {
			throw new Error(
				`O modo "${mode}" precisa de um provedor: escolha um endpoint antes de salvar.`,
			);
		}
		if (chooses && targetId !== undefined) {
			const provider = this.config.get(targetId);
			if (provider === undefined) {
				throw new Error(`O provedor "${targetId}" não está configurado.`);
			}
			if (provider.enabled === false) {
				throw new Error(
					`O provedor "${provider.name}" está desabilitado. Habilite-o antes de usá-lo como destino.`,
				);
			}
		}
		await this.history.saveRouterConfig({
			enabled: input.enabled ?? current.enabled,
			mode,
			...(mode === 'external' && external !== undefined ? { externalRouterProviderId: external } : {}),
			...(mode === 'direct' && direct !== undefined ? { directProviderId: direct } : {}),
			updatedAt: new Date().toISOString(),
		});
		return this.readRouterConfig();
	}

	/**
	 * O plano do turno, depois de resolver a configuração do roteador.
	 *
	 * A recusa é explícita: um provedor ausente, desabilitado ou sem endereço
	 * não vira "tente outro modo". O usuário escolheu um modo; o app diz por que
	 * ele não pode ser usado e para.
	 */
	private async resolveTurnPlan(input: {
		readonly requestedModel: string;
		readonly requestedProviderId?: string;
		/** O modo escolhido no chat (DEV-8.9). Ausente = configuração decide. */
		readonly mode?: TurnMode;
	}): Promise<RouterPlan> {
		const config = await this.routerConfig();
		const lookup = (providerId: string): RouterProviderLookupResult => {
			const provider = this.config.get(providerId);
			return provider === undefined
				? { exists: false }
				: { exists: true, enabled: provider.enabled, baseUrl: provider.baseUrl };
		};
		if (input.mode !== undefined) {
			return resolveTurnModePlan({
				mode: input.mode,
				config,
				requestedProviderId: input.requestedProviderId ?? '',
				requestedModel: input.requestedModel,
				lookup,
			});
		}
		return resolveRouterPlan({
			config,
			requestedModel: input.requestedModel,
			lookup,
		});
	}

	/**
	 * O modelo que o servidor disse que respondeu, por alvo.
	 *
	 * Só o que o servidor **publicou** está aqui. Num roteador externo, o
	 * modelo que responde pode ser outro que o pedido, e a diferença entre os
	 * dois é o que o relatório precisa mostrar — ou dizer que não se sabe.
	 */
	private readonly respondedModels = new Map<string, string>();

	/**
	 * O relatório de decisão do turno.
	 *
	 * Reúne o plano, as tentativas da rota, as decisões do orçamento e as
	 * janelas de cota em um registro. Nada de conversa, chave ou cabeçalho
	 * entra nele — ver `decisionReport.ts`.
	 */
	private async buildTurnReport(input: {
		readonly turnId: string;
		readonly conversationId: string;
		readonly startedAt: string;
		readonly strategy: OrchestrationStrategy;
		readonly policy: ModelAccessPolicyRecord;
		/** A explicação da classificação, para o relatório mostrar as regras. */
		readonly taskExplanation?: TaskClassificationExplanation;
		readonly plan: {
			readonly primary: SelectableModel | undefined;
			readonly candidates: readonly SelectableModel[];
			readonly reasons: readonly { readonly providerId: string; readonly modelId: string; readonly reason: string }[];
		};
		readonly catalog: readonly ModelCatalogEntry[];
		readonly attempts: readonly RouteAttempt[];
		readonly policyExcluded?: readonly {
			readonly providerId: string;
			readonly modelId: string;
			readonly reason: string;
		}[];
		/**
		 * Quem decidiu o modelo, nos modos de alvo único.
		 *
		 * Ausente no modo `native`: aí a Evelyn escolheu, e isso já está no
		 * motivo do candidato.
		 */
		readonly routing?: {
			readonly mode: RouterMode;
			readonly providerId: string;
			readonly requestedModel: string;
			readonly decidedBy: 'external-router' | 'provider';
		};
		readonly result: 'success' | 'failed' | 'cancelled' | 'exhausted' | 'refused';
		readonly finalModel?: { readonly providerId: string; readonly modelId: string };
		readonly summary: string;
	}): Promise<RoutingDecisionReport> {
		const nowMs = Date.now();
		const byKey = new Map(
			input.catalog.map((entry) => [`${entry.providerId}:${entry.modelId}`, entry]),
		);
		const priceOf = async (
			candidate: { readonly providerId: string; readonly modelId: string },
		): Promise<ReportPrice | undefined> => {
			const pricing = await this.effectivePricingFor(candidate);
			if (pricing === undefined) {
				return undefined;
			}
			const declared = byKey.get(`${candidate.providerId}:${candidate.modelId}`);
			const side: 'user' | 'discovered' =
				declared?.pricing !== undefined && input.policy.priceSource === 'user'
					? 'user'
					: 'discovered';
			// A procedência vem do lado que vale, com a data e a validade
			// quando elas existem. Um preço do provedor sem validade é um
			// dado que ninguém datou, e o relatório diz isso.
			let provenance: ReportProvenance;
			if (side === 'discovered') {
				const found = await this.safeDiscoveredModel(candidate);
				const published = found?.pricing;
				provenance = {
					source: published?.source ?? pricing.source ?? 'unknown',
					...(published?.verifiedAt !== undefined ? { verifiedAt: published.verifiedAt } : {}),
					...(published?.expiresAt !== undefined ? { expiresAt: published.expiresAt } : {}),
					...(published?.stale === true ? { stale: true } : {}),
				};
			} else {
				provenance = {
					source: pricing.source ?? 'manual',
					...(declared?.updatedAt !== undefined ? { verifiedAt: declared.updatedAt } : {}),
				};
			}
			return {
				currency: pricing.currency,
				unit: pricing.unit,
				...(pricing.input !== undefined ? { input: pricing.input } : {}),
				...(pricing.output !== undefined ? { output: pricing.output } : {}),
				side,
				provenance,
			};
		};
		const candidates: ReportCandidate[] = [];
		for (const candidate of [...(input.plan.primary !== undefined ? [input.plan.primary] : []), ...input.plan.candidates]) {
			const key = `${candidate.providerId}:${candidate.modelId}`;
			if (candidates.some((known) => `${known.providerId}:${known.modelId}` === key)) {
				continue;
			}
			const entry = byKey.get(key);
			const price = await priceOf(candidate);
			candidates.push({
				providerId: candidate.providerId,
				modelId: candidate.modelId,
				access: entry?.access ?? 'unknown',
				...(price !== undefined ? { price } : {}),
				...(entry?.limits !== undefined
					? {
							limits: {
								...(entry.limits.contextTokens !== undefined
									? { contextTokens: entry.limits.contextTokens }
									: {}),
								...(entry.limits.maxOutputTokens !== undefined
									? { maxOutputTokens: entry.limits.maxOutputTokens }
									: {}),
								provenance: {
									source: entry.metadata?.source ?? 'unknown',
									...(entry.metadata?.updatedAt !== undefined
										? { verifiedAt: entry.metadata.updatedAt }
										: {}),
								},
							},
						}
					: {}),
				...(entry?.model !== undefined
					? {
							capabilities: {
								...(entry.model.toolCalling !== undefined
									? { toolCalling: entry.model.toolCalling }
									: {}),
								...(entry.model.structuredOutput !== undefined
									? { structuredOutput: entry.model.structuredOutput }
									: {}),
								...(entry.model.reasoning !== undefined
									? { reasoning: entry.model.reasoning }
									: {}),
							},
						}
					: {}),
			});
		}
		const chosenKey =
			input.plan.primary !== undefined ? `${input.plan.primary.providerId}:${input.plan.primary.modelId}` : undefined;
		const chosenCandidate = candidates.find(
			(candidate) => `${candidate.providerId}:${candidate.modelId}` === chosenKey,
		);
		const chosenReason = input.plan.reasons.find(
			(reason) => `${reason.providerId}:${reason.modelId}` === chosenKey,
		)?.reason;

		const budget = this.budgetObservations.splice(0, this.budgetObservations.length);
		const quotas: QuotaObservation[] = this.quotaTracker.snapshot().map((window) => ({
			providerId: window.scope.providerId,
			...(window.scope.modelId !== undefined ? { modelId: window.scope.modelId } : {}),
			...(window.state?.limit?.kind !== undefined && window.state.limit.kind !== 'unknown'
				? { kind: window.state.limit.kind }
				: {}),
			...(window.state?.limit?.scope !== undefined ? { scope: window.state.limit.scope } : {}),
			...(window.state?.remaining !== undefined ? { remaining: window.state.remaining.value } : {}),
			...(window.state?.limit !== undefined ? { limit: window.state.limit.limit.value } : {}),
			...(window.state?.resetAt !== undefined ? { resetAt: window.state.resetAt } : {}),
			source: window.state?.source ?? 'observed',
		}));

		return buildDecisionReport({
			turnId: input.turnId,
			conversationId: input.conversationId,
			startedAt: input.startedAt,
			strategy: input.strategy,
			...(input.taskExplanation !== undefined ? { task: input.taskExplanation } : {}),
			policy: input.policy.policy,
			policyApplied: input.policy.policy !== 'any',
			sources: {
				price: input.policy.priceSource,
				limits: input.policy.limitsSource,
				capabilities: input.policy.capabilitiesSource,
			},
			...(chosenCandidate !== undefined && chosenReason !== undefined
				? { chosen: { ...chosenCandidate, reason: chosenReason } }
				: {}),
			reasons: input.plan.reasons.map((reason) => ({
				...reason,
				chosen: `${reason.providerId}:${reason.modelId}` === chosenKey,
				capabilities: [],
				supportsTools: false,
				supportsStreaming: true,
				access: 'unknown' as const,
			})),
			policyExcluded: input.policyExcluded,
			...(input.routing !== undefined
				? {
						routing: {
							...input.routing,
							// O modelo que respondeu, quando o servidor disse. Num
							// roteador ele pode ser outro que o pedido — e é a
							// única afirmação que existe sobre quem respondeu.
							...(this.respondedModels.get(
								`${input.routing.providerId}:${input.routing.requestedModel}`,
							) !== undefined
								? {
										respondedModel: this.respondedModels.get(
											`${input.routing.providerId}:${input.routing.requestedModel}`,
										) as string,
									}
								: {}),
						},
					}
				: {}),
			candidates,
			budget,
			quotas,
			attempts: input.attempts,
			costs: await this.costsOf(input.attempts),
			result: input.result,
			...(input.finalModel !== undefined ? { finalModel: input.finalModel } : {}),
			summary: input.summary,
		});
	}

	/**
	 * Registra o que a rota descobriu sobre a conta.
	 *
	 * Um sucesso confirma o acesso daquele modelo; um `429` (ou `503` com
	 * `Retry-After`) informa restante e janela. Os cabeçalhos em si são
	 * lidos no adaptador que observa o provedor — ele é quem vê a resposta
	 * antes de ela virar evento —; aqui o que sobra é o desfecho da rota.
	 * Falhas são logadas e não sobem: uma conversa já entregue não vira erro
	 * por descoberta.
	 */
	private async recordRouteDiscovery(provider: ChatProvider): Promise<void> {
		const routed = provider as ChatProvider & {
			readonly attempts?: readonly RouteAttempt[];
		};
		const records = routed.attempts;
		if (records === undefined) {
			return;
		}
		for (const record of records) {
			if (record.outcome === 'success') {
				await this.providerDiscovery
					.confirmUse(record.providerId, record.modelId)
					.catch(() => undefined);
			}
			const status = record.httpStatus;
			if (status === undefined) {
				continue;
			}
			try {
				await this.providerDiscovery.recordChatResponse({
					providerId: record.providerId,
					modelId: record.modelId,
					status,
					headers: {},
					...(record.retryAfterMs !== undefined ? { retryAfterMs: record.retryAfterMs } : {}),
				});
			} catch (error) {
				this.logger.warn('Could not record a rate-limit observation', {
					providerId: record.providerId,
					modelId: record.modelId,
					error: describeError(error),
				});
			}
		}
	}

	/**
	 *
	 * Uma rodada é identificada pelos `requestId`s que o provedor usou. Mais de
	 * um acontece quando a rodada foi pinada e continuou depois de uma
	 * ferramenta: são execuções separadas, cada uma com seu modelo, e cada uma
	 * é fechada.
	 *
	 * O status vem das tentativas, pelo mesmo critério do motor: um sucesso em
	 * qualquer tentativa é sucesso; senão, a primeira falha é falha; senão, foi
	 * cancelada. Um `timeout` de tentativa isolada não vira timeout da rodada
	 * quando uma tentativa seguinte respondeu.
	 */
	private async settleConsumption(provider: ChatProvider, turnId?: string): Promise<void> {
		const consumption = this.consumption;
		try {
			const routed = provider as ChatProvider & { readonly attempts?: readonly RouteAttempt[] };
			const records = routed.attempts;
			if (consumption === undefined || records === undefined || records.length === 0) {
				return;
			}
			// O motor publica a tentativa enquanto a rota termina, então a
			// escrita dela pode chegar depois deste método. Esperar a fila
			// primeiro faz a rodada existir para receber a conversa e garante
			// que a leitura seguinte veja o que este turno gastou.
			await consumption.settled();
			const requestIds = new Set(records.map((record) => record.requestId));
			for (const requestId of requestIds) {
				const ofRequest = records.filter((record) => record.requestId === requestId);
				await consumption.settleRequest(requestId, this.routedStatus(ofRequest));
			}
			// As escritas deste turno vão para a fila do armazenamento, e a
			// instância dele pode ter lido o ledger antes delas. Esperar aqui
			// faz a próxima leitura — orçamento, previsão, relatório — enxergar
			// este turno, e não um ledger um turno atrás.
			await consumption.settled();
		} finally {
			// The turn is accounted now. The gate cached the period's spend
			// before this turn's write landed, and that number is only valid for
			// the decision it was made for; a later read must see the whole
			// ledger, including this turn.
			this.budgetGate?.reset();
			if (turnId !== undefined) {
				this.forgetConversation(turnId);
			}
		}
	}

	/** Como a rodada terminou, a partir das tentativas que chegaram ao provedor. */
	private routedStatus(attempts: readonly RouteAttempt[]): ExecutionStatus {
		const ran = attempts.filter((attempt) => attempt.outcome !== 'skipped');
		if (ran.some((attempt) => attempt.outcome === 'success')) {
			return 'success';
		}
		const failure = ran.find((attempt) => attempt.outcome === 'failure');
		if (failure !== undefined) {
			return failure.errorClass === 'timeout' ||
				(failure.abortCause !== undefined && failure.abortCause !== 'user-stop')
				? 'timeout'
				: 'failure';
		}
		if (ran.some((attempt) => attempt.abortCause !== undefined && attempt.abortCause !== 'user-stop')) {
			return 'timeout';
		}
		return 'cancelled';
	}

	/**
	 * Runs one turn as a route over the plan's candidates.
	 *
	 * Unlike the legacy loop, this makes a single attempt that can itself retry
	 * and fall back. The difference that matters: the engine can abandon a
	 * candidate that has produced nothing, but it can never restart an answer
	 * the user has already started reading. The legacy loop decided that from
	 * the failure alone and could re-answer after partial text.
	 */
	private async runRoutedTurn(args: {
		readonly input: SendMessageInput;
		readonly conversation: string;
		readonly turnId: string;
		readonly controller: AbortController;
		readonly sink: AgentEventSink;
		/** O broker de permissões deste turno (R4C). */
		readonly broker?: PermissionBroker;
		readonly permissions?: PermissionGateway;
		readonly strategy: OrchestrationStrategy;
		readonly plan: {
			readonly primary: SelectableModel | undefined;
			readonly candidates: readonly SelectableModel[];
			readonly reasons: readonly { readonly providerId: string; readonly modelId: string; readonly reason: string }[];
		};
		readonly catalog: readonly ModelCatalogEntry[];
		readonly policy: ModelAccessPolicyRecord;
		/** A explicação da classificação, para o relatório mostrar as regras. */
		readonly taskExplanation?: TaskClassificationExplanation;
		readonly policyExcluded?: readonly {
			readonly providerId: string;
			readonly modelId: string;
			readonly reason: string;
		}[];
		/**
		 * Quem decidiu o modelo, nos modos de alvo único.
		 *
		 * Ausente no modo `native`: aí a Evelyn escolheu, e isso já está no
		 * motivo do candidato.
		 */
		readonly routing?: {
			readonly mode: RouterMode;
			readonly providerId: string;
			readonly requestedModel: string;
			readonly decidedBy: 'external-router' | 'provider';
		};
	}): Promise<{
		readonly result: OrchestrationLogEntry['result'];
		readonly model: SelectableModel;
		readonly attempts: readonly OrchestrationAttempt[];
		readonly report: RoutingDecisionReport;
	}> {
		const primary = args.plan.primary;
		if (primary === undefined) {
			throw new Error('A routed turn needs a primary candidate');
		}
		const models: SelectableModel[] = [primary, ...args.plan.candidates];

		// The renderer already knows how to draw these two events, and the
		// engine owns the decision now. Retries are not announced as fallbacks:
		// asking the same model twice is not a change of model.
		let announcedFirst = false;
		const observer: RoutingObserver = {
			onAttemptStart: (info) => {
				const reason =
					args.plan.reasons.find(
						(entry) => entry.modelId === info.modelId && entry.providerId === info.providerId,
					)?.reason ?? 'Selected by orchestration';
				if (!announcedFirst && !info.isRetry) {
					announcedFirst = true;
					args.sink({
						type: 'modelSelected',
						turnId: args.turnId,
						providerId: info.providerId,
						modelId: info.modelId,
						strategy: args.strategy,
						reason,
						isFallback: info.isFallback,
					});
					return;
				}
				if (info.isFallback && !info.isRetry) {
					args.sink({
						type: 'modelSelected',
						turnId: args.turnId,
						providerId: info.providerId,
						modelId: info.modelId,
						strategy: args.strategy,
						reason,
						isFallback: true,
					});
					args.sink({
						type: 'fallbackAttempted',
						turnId: args.turnId,
						attempt: info.sequence,
						providerId: info.providerId,
						modelId: info.modelId,
						previousError: info.previousError?.message ?? 'unknown error',
					});
				}
			},
		};

		const provider = this.buildRoutedProvider(models, observer);
		const result = await this.runTurnWithResult({
			input: args.input,
			provider,
			conversation: args.conversation,
			turnId: args.turnId,
			controller: args.controller,
			modelId: primary.modelId,
			providerId: primary.providerId,
			holdsSlot: false,
			...(args.broker !== undefined ? { broker: args.broker } : {}),
			...(args.permissions !== undefined ? { permissions: args.permissions } : {}),
			onEvent: args.sink,
		});

		// A route publishes its attempts while the turn is ending. A candidate
		// vetoed by a spending limit never ran, so nothing above narrated it;
		// it is announced here, before the terminal event, so the user learns
		// why a paid model was not tried before reading the outcome.
		if (this.budgetGate !== undefined) {
			this.announceBudgetBlocks(args.turnId, provider, args.sink);
		}

		// O que a rota informou sobre a conta: um modelo que respondeu tem o
		// acesso confirmado; um `429` traz restante/`Retry-After` e marca a
		// janela. Registrado aqui e nunca aqui rejeitado.
		await this.recordRouteDiscovery(provider);

		// A rota já publicou suas tentativas, e o turno acabou de terminar.
		// Fechar a execução aqui é o que separa "a última tentativa foi X" de
		// "a rodada terminou como Y": um turno cortado pelo usuário depois de um
		// fallback abortado termina em cancelamento, não em sucesso.
		await this.settleConsumption(provider, args.turnId);

		const attempts: OrchestrationAttempt[] = provider.attempts.map((record) => {
			const model =
				models.find(
					(candidate) =>
						candidate.providerId === record.providerId && candidate.modelId === record.modelId,
				) ?? primary;
			return {
				attempt: record.sequence,
				model,
				...(record.outcome === 'success' ? {} : { error: new Error(describeRouteAttempt(record)) }),
				recoverable: false,
				timestamp: new Date(record.startedAtMs).toISOString(),
			};
		});

		// The model that answered, which a fallback makes different from the
		// primary. The log is read later to compare candidates, so naming the
		// wrong one would make it worse than no log.
		const winner = provider.attempts.find((record) => record.outcome === 'success');
		const answeredWith =
			winner !== undefined
				? models.find(
						(candidate) =>
							candidate.providerId === winner.providerId && candidate.modelId === winner.modelId,
					) ?? primary
				: primary;

		const terminal = result.terminalEvent;
		const outcome: OrchestrationLogEntry['result'] =
			terminal.type === 'done'
				? terminal.reason === 'aborted'
					? 'cancelled'
					: 'success'
				: 'failed';
		// O relatório da decisão: o que foi escolhido, o que foi descartado, que
		// limites e cotas existiam, e como a rodada terminou.
		const report = await this.buildTurnReport({
			turnId: args.turnId,
			conversationId: args.conversation,
			startedAt: new Date(provider.attempts[0]?.startedAtMs ?? Date.now()).toISOString(),
			strategy: args.strategy,
			policy: args.policy,
			plan: args.plan,
			catalog: args.catalog,
			taskExplanation: args.taskExplanation,
			policyExcluded: args.policyExcluded,
			attempts: provider.attempts,
			result: outcome,
			finalModel: { providerId: answeredWith.providerId, modelId: answeredWith.modelId },
			...(args.routing !== undefined ? { routing: args.routing } : {}),
			summary:
				outcome === 'success'
					? `Respondeu ${answeredWith.providerId}/${answeredWith.modelId}.`
					: outcome === 'cancelled'
						? 'O turno foi interrompido pelo usuário.'
						: 'Nenhum modelo respondeu.',
		});
		return { result: outcome, model: answeredWith, attempts, report };
	}

	/**
	 * The broker, built on first use.
	 *
	 * It takes the same sink as the turn's events, which is what makes a
	 * permission request show up in the renderer without a second channel being
	 * invented for it.
	 */
	private permissionsBroker(sink: AgentEventSink): PermissionBroker {
		// Um broker **por turno** (R4C). A versão anterior reusava o broker da
		// sessão, e `runTurn` cancelava o do turno anterior — correto quando só
		// há um turno, fatal quando dois clientes usam a mesma sessão: o
		// segundo cancelaria as perguntas do primeiro, e as duas publicariam
		// prompts no sink uma da outra.
		//
		// O broker novo recebe o sink **deste** turno, então um prompt nunca
		// aparece no fluxo de outro.
		//
		// O escopo vem da sessão DEV: quando ela está ativa, esta tarefa pode
		// escrever no repositório. É essa raiz que dá significado a "escopo" —
		// sem ela, nenhuma escrita seria classificada como dentro do DEV e o
		// caminho antigo (perguntar) continuaria valendo.
		const devRoot = this.dev?.session.isActive() === true ? this.dev.session.root() : undefined;
		return new PermissionBroker({
			...(devRoot !== undefined ? { devRoot, scopedGrants: true } : {}),
			emit: (kind, payload) => {
				if (kind === 'requested') {
					const prompt = payload as PermissionPrompt;
					sink({ type: 'permissionRequested', turnId: prompt.turnId, prompt });
					return;
				}
				const report = payload as DecisionReport;
				sink({
					type: 'permissionResolved',
					// O turno, e não a requisição: `report.id` é `perm-N`, um id
					// que a interface nunca viu como turno, e uma resolução
					// arquivada sob ele seria descartada pelo filtro de turno.
					turnId: report.turnId,
					id: report.id,
					toolName: report.toolName,
					decision: report.decision,
					source: report.source,
					// O escopo viaja junto: é o que permite à linha do tempo
					// dizer "dentro de G:\repo\src" em vez de só "permitido".
					...(report.scope !== undefined ? { scope: report.scope } : {}),
				});
			},
		});
	}

	/**
	 * Answers an open permission request.
	 *
	 * False when nothing was open under that id — a dialog for a turn that has
	 * already ended, or a double-click. The renderer uses the false to close the
	 * dialog rather than leave it hanging.
	 */
	answerPermission(answer: PermissionAnswer): boolean {
		return this.broker?.answer(answer) ?? false;
	}

	/**
	 * Denies every open permission request.
	 *
	 * Called when the window closes or the app quits: an open dialog there would
	 * block a tool on an answer that can never arrive, and a blocked tool is
	 * worse than a denied one — the model gets the denial as a tool result and can
	 * carry on, rather than the turn hanging on a promise nobody will settle.
	 */
	denyOpenPermissions(reason = 'the request was withdrawn'): number {
		return this.broker?.cancelAll(reason) ?? 0;
	}

	/** How many permission requests are waiting for an answer. */
	get openPermissionCount(): number {
		return this.broker?.openCount ?? 0;
	}

	/**
	 * O que a API de clientes (`/v1`) precisa do motor, e nada além.
	 *
	 * Essa superfície atende requisições concorrentes, e `sendMessage` não
	 * serve para isso: ela reserva o único slot de turno, e o broker de
	 * permissões cancela o turno anterior. O que **deve** atravessar
	 * requisições é a saúde dos endpoints — um breaker esquecido é o único
	 * erro que ele existe para impedir.
	 *
	 * Devolver só a política e o breaker mantém o slot, a conversa em curso e
	 * o broker fora do alcance de quem chama.
	 */
	routingAccess(): { readonly policy: RoutePolicy; readonly breaker: CircuitBreaker } | undefined {
		const policy = this.routing?.policy;
		const breaker = this.routingBreaker;
		if (policy === undefined || breaker === undefined) {
			return undefined;
		}
		return { policy, breaker };
	}

	/**
	 * O cliente de um provedor configurado, para a API de clientes.
	 *
	 * É o mesmo `buildProvider` que o turno usa — mesma chave, mesmo
	 * `baseUrl`, mesmo `fetch` — exposto por um nome que diz para que serve.
	 * Não guarda nada na sessão: o cliente devolvido pertence a quem chamou, e
	 * o `RoutedChatProvider` de cada requisição o descarta ao terminar.
	 */
	buildProviderForApi(providerId: string): OpenAICompatibleProvider {
		return this.buildProvider(providerId);
	}

	/**
	 * Troca o modo DEV desta sessão (DEV-5).
	 *
	 * O stack de ferramentas é montado a cada turno a partir de `this.dev`;
	 * com `undefined`, as ferramentas `dev_*` deixam de existir no próximo
	 * turno. É o host que chama — ao abrir (`DevHost.ownerRequest`) e ao
	 * encerrar (`DevHost.ownerExit`) —, nunca um turno do agente.
	 */
	setDevTools(dev: DevToolDeps | undefined): void {
		// DEV-8.2: o registro de ferramentas é **construído uma vez** e
		// reutilizado entre turnos. Sem descartá-lo, a sessão DEV aberta depois
		// do primeiro turno não aparece para o modelo — medido no app
		// empacotado: a autorização valeu, a sessão ficou ativa, e o turno
		// terminou sem executar a `dev_write` porque o stack não a tinha.
		// Descartar aqui faz o próximo turno montar com (ou sem) as ferramentas
		// DEV conforme o estado **atual** da autorização.
		this.dev = dev;
		this.toolDisposer?.();
		this.registry = undefined;
		this.toolDisposer = undefined;
		this.recorders = new Map();
	}

	/**
	 * Roda algo com as ferramentas DEV **fora** do stack, inclusive para turnos
	 * que comecem no meio (DEV-6).
	 *
	 * O painel aplica uma mudança pelo host, não por um turno. Enquanto isso,
	 * um turno que peça algo não pode montar as ferramentas DEV: o estado
	 * autorizado está mudando sob ele. A supressão é um escopo explícito e
	 * curto, não um `dev = undefined` global.
	 */
	async runWithoutDev<T>(work: () => Promise<T>): Promise<T> {
		const saved = this.dev;
		this.dev = undefined;
		try {
			return await work();
		} finally {
			this.dev = saved;
		}
	}

	/** Releases the tool registry. Called when the session is torn down. */
	dispose(): void {		// A dialog left open across teardown would resolve into nothing.
		this.broker?.cancelAll('the app is shutting down');
		this.broker = undefined;
		this.toolDisposer?.();
		this.registry = undefined;
		this.toolDisposer = undefined;
		this.recorders = new Map();
	}

	/** Exposed for the status line: how many providers are configured. */
	get providerCount(): number {
		return this.config.list().length;
	}

	/** Forces the next turn to rebuild its provider. Used after an edit. */
	invalidate(providerId?: string): void {
		if (providerId === undefined) {
			this.live.clear();
			return;
		}
		this.live.delete(providerId);
	}

	/** A fresh id, so the renderer's placeholder conversation has a name. */
	newId(): string {
		return this.generateId();
	}
}

/** A `ConversationRecord` as the sidebar lists it. */
/**
 * As capacidades como etiquetas.
 *
 * O seletor pontua por nomes (`tools`, `reasoning`, `long-context`), e o
 * catálogo guarda três booleanos — que podem estar ausentes, e ausente não é
 * `false`. Só a declaração `true` vira etiqueta; o que ninguém sabe não entra
 * na lista e não ganha pontos.
 */
function capabilityTags(capabilities: ModelCapabilities | undefined): string[] {
	if (capabilities === undefined) {
		return [];
	}
	const tags: string[] = [];
	if (capabilities.toolCalling === true) {
		tags.push('tools');
	}
	if (capabilities.reasoning === true) {
		tags.push('reasoning');
	}
	if (capabilities.structuredOutput === true) {
		tags.push('structured-output');
	}
	return tags;
}

/**
 * O preço fundido, no formato neutro da ferramenta.
 *
 * O lado em vigor é o que a política escolheu — `user` ou `discovered` — e a
 * procedência vai junto: um preço do provedor vencido é um preço que existe e
 * que **não** deve ser apresentado como atual. Ausente de ambos os lados é
 * ausente aqui, e a ferramenta o lista em `unknown`.
 */
function priceRecord(price: MergedPriceView | undefined): {
	readonly pricing?: {
		readonly currency: string;
		readonly unit: string;
		readonly input?: string;
		readonly output?: string;
		readonly state?: 'exact' | 'stale' | 'unknown';
	};
} {
	if (price === undefined) {
		return {};
	}
	const side = price.user !== undefined ? price.user : price.discovered;
	if (side === undefined) {
		return {};
	}
	const stale = price.discovered !== undefined && price.discovered.stale;
	const chosenSideStale = price.user === undefined && stale;
	return {
		pricing: {
			currency: side.currency,
			unit: side.unit,
			...(side.input !== undefined ? { input: String(side.input) } : {}),
			...(side.output !== undefined ? { output: String(side.output) } : {}),
			state: chosenSideStale ? 'stale' : 'exact',
		},
	};
}

function toConversationListItem(record: ConversationRecord): ConversationListItem {
	return parseConversationListItem({
		id: record.id,
		title: record.title,
		// A conversation always belongs to a provider in the desktop; the empty
		// fallback is unreachable here and would only hide a bug.
		providerId: record.providerId ?? '',
		...(record.projectId !== undefined ? { projectId: record.projectId } : {}),
		...(record.pinned === true ? { pinned: true } : {}),
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		// O prompt de sistema fica fora da contagem: ele é configuração da
		// conversa, e uma conversa com só ele não é "1 mensagem" na leitura de
		// quem vê a lista.
		messageCount: record.messages.filter((message) => message.role !== 'system').length,
	});
}

/**
 * A `ConversationRecord` as the chat view needs it.
 *
 * The system prompt is lifted out of the message list *and* kept in it. The
 * field is what the prompt box is pre-filled from, so the user edits one source
 * of truth rather than having to read the first bubble to find it.
 */
function toView(record: ConversationRecord): ConversationView {
	return parseConversationView({
		summary: toConversationListItem(record),
		messages: record.messages.map((message) => ({
			role: message.role,
			content: message.content,
		})),
		systemPrompt: record.messages.find((message) => message.role === 'system')?.content ?? '',
	});
}

/**
 * Derives a stable id from a base URL.
 *
 * Host and path, lowercased, everything else dropped — so retyping the same URL
 * updates the existing provider instead of creating a second one.
 */
export function deriveProviderId(baseUrl: string): string {
	const slug = (source: string): string =>
		source
			.toLowerCase()
			.replace(/[^a-z0-9.-]+/g, '-')
			.replace(/-+/g, '-')
			.replace(/^-|-$/g, '');

	try {
		const url = new URL(baseUrl.trim());
		const path = url.pathname.replace(/^\/+|\/+$/g, '');
		return slug(path === '' ? url.host : `${url.host}-${path}`) || 'provider';
	} catch {
		// A URL that does not parse yet still deserves a stable id from its text.
		return slug(baseUrl.trim()) || 'provider';
	}
}

/** A readable default name: the host, without the scheme or a trailing slash. */
function defaultName(baseUrl: string): string {
	try {
		return new URL(baseUrl.trim()).host;
	} catch {
		return baseUrl.trim();
	}
}

/** A message safe to send the renderer: no key, no stack, no cause chain. */
function describeError(error: unknown): string {
	if (isModelHubError(error)) {
		// Built by the Core from a status code and an endpoint; `details` are
		// deliberately not forwarded.
		return error.message;
	}
	if (error instanceof Error) {
		return error.message;
	}
	return 'The request failed for an unknown reason';
}
