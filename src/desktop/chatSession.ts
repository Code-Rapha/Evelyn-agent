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
import type { ToolCallRequest } from '../core/providers/chat/types';
import { createMvpAgentStack } from '../core/agent/composition';
import type { ToolRegistry } from '../core/agent/toolRegistry';
import {
	createRiskGateway,
	type PermissionGateway,
	type PermissionRequest,
} from '../core/permissions/gateway';
import { PermissionBroker, type DecisionReport } from './permissionBroker';
import { runAgentTurn, type AgentEventSink } from './agentTurn';
import { addRecorders, type RecordingTool } from './toolRecorder';
import { toAppendInputs, type ConversationRecord } from '../core/storage/types/dataStore';
import { FileDataStore } from '../adapters/local/fileDataStore';
import { isModelHubError } from '../core/errors';
import {
	parseConversationListItem,
	parseConversationListItems,
	parseConversationView,
	parseProjectListItem,
	parseProviderSummary,
	type ChatStreamEvent,
	type ConversationListItem,
	type ConversationView,
	type CreateConversationInput,
	type ProjectListItem,
	type AvailableModel,
	type ProviderSummary,
	type SaveProviderInput,
	type SendMessageAck,
	type SendMessageInput,
	type PermissionAnswer,
	type PermissionPrompt,
} from './contract';

/** Longest a single turn may run before the session gives up on it. */
const DEFAULT_TURN_TIMEOUT_MS = 120_000;

/** Where events go. Main wires this to IPC; tests collect into an array. */
export type ChatEventSink = (event: ChatStreamEvent) => void;

export interface ChatSessionOptions {
	readonly config: ProviderConfigService;
	readonly secrets: SecretStore;
	readonly history: FileDataStore;
	readonly logger: LoggingService;
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
		// Models live on the live provider instance; the renderer gets them from
		// `listModels`, which actually asks the server.
		models: [],
	});
}

export class ChatSession {
	private readonly config: ProviderConfigService;
	private readonly secrets: SecretStore;
	private readonly history: FileDataStore;
	private readonly logger: LoggingService;
	private readonly generateId: () => string;
	private readonly turnTimeoutMs: number;
	private readonly fetchImpl: FetchLike | undefined;
	private readonly clock: () => string;

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
	private turnCounter = 0;

	constructor(options: ChatSessionOptions) {
		this.config = options.config;
		this.secrets = options.secrets;
		this.history = options.history;
		this.logger = options.logger;
		this.generateId = options.generateId ?? (() => randomUUID());
		this.turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
		this.fetchImpl = options.fetchImpl;
		this.clock = options.now ?? (() => new Date().toISOString());
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
		};
		await this.config.save(stored);
		// The cached instance holds the old baseUrl, so it cannot survive an edit.
		this.live.delete(id);

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
		return true;
	}

	/**
	 * Asks the provider for its models.
	 *
	 * Returns just the ids: the renderer needs to fill a `<select>`, and the rest
	 * of `ModelInfo` is unused so far.
	 */
	async listModels(providerId: string): Promise<readonly string[]> {
		const models = await this.resolveProvider(providerId).listModels();
		return models.map((model) => model.id);
	}

	/**
	 * Every model from every enabled provider, tagged with its provider.
	 *
	 * Sequential on purpose. These are independent HTTP calls to third-party
	 * endpoints, and the one that decides how long this takes is the slowest
	 * provider — which on a list of them is usually a local model server that is
	 * not running. Firing them together would make a dead provider set the
	 * latency for the whole list, where sequentially it only ever costs its own
	 * share.
	 *
	 * A failure is skipped, not thrown. A provider whose server is down is an
	 * ordinary state — the user configures it before starting it — and letting
	 * that one error empty the list would take away the models the working
	 * providers do offer.
	 *
	 * Disabled providers are skipped without a request: asking one would fail by
	 * design, and the failure would be indistinguishable from a real outage.
	 */
	async listAvailableModels(): Promise<readonly AvailableModel[]> {
		const available: AvailableModel[] = [];
		for (const provider of this.config.list()) {
			if (!provider.enabled) {
				continue;
			}
			try {
				const models = await this.resolveProvider(provider.id).listModels();
				for (const model of models) {
					available.push({
						providerId: provider.id,
						providerName: provider.name,
						model: model.id,
					});
				}
			} catch (error) {
				this.logger.warn('Could not list models for a provider', {
					providerId: provider.id,
					reason: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return available;
	}

	/**
	 * Conversations for a provider, most recently active first.
	 *
	 * Sorted here rather than leaving the order to the caller, because a
	 * conversation list whose order depends on directory iteration is a list the
	 * user cannot predict.
	 */
	async listConversations(providerId: string): Promise<readonly ConversationListItem[]> {
		// Filtered by provider, not project: a conversation is bound to exactly
		// one provider and to at most one project, and conflating the two is what
		// made an unbound conversation invisible in its own sidebar.
		const summaries = await this.history.listConversations({ providerId });
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
	 * pointed Seshyina at, and making one would create directories nobody asked
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

	async deleteConversation(conversationId: string): Promise<boolean> {
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

			// A conversation belongs to the provider it was created under.
			// Answering it from another one would mix transcripts across
			// endpoints — different keys, different models, one transcript.
			if (
				conversation.providerId !== undefined &&
				conversation.providerId !== input.providerId
			) {
				throw new Error(
					`Conversation "${input.conversationId}" belongs to provider "${conversation.providerId}", not "${input.providerId}"`,
				);
			}

			const provider = this.resolveProvider(input.providerId);

			// The user's message is persisted before the turn starts, so a turn that
			// fails still leaves what they typed in the transcript. Only the last
			// message is new: everything before it is already in the store.
			const latest = input.messages[input.messages.length - 1];
			if (latest !== undefined) {
				await this.appendUser(conversation.id, latest.content);
			}

			// Started, not awaited: `sendMessage` must return now.
			void this.runTurn({
				input,
				provider,
				conversation: conversation.id,
				turnId,
				controller,
				sink,
			});
			handedOff = true;
		} finally {
			// Only when the turn never started. Once `runTurn` has it, its own
			// `release` clears the slot — and clearing it here would let a second
			// turn overlap a running one.
			if (!handedOff && this.inFlight?.turnId === turnId) {
				this.inFlight = undefined;
			}
		}
		return { turnId, accepted: true };
	}

	/** Aborts the turn in flight. False when nothing was running. */
	stop(): boolean {
		// Anything the user is being asked about for this turn dies with it. The
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
		readonly provider: OpenAICompatibleProvider;
		readonly conversation: string;
		readonly turnId: string;
		readonly controller: AbortController;
		readonly sink: AgentEventSink;
	}): Promise<void> {
		const { input, provider, conversation, turnId, controller, sink } = args;
		const timeout = setTimeout(() => {
			// A timed-out turn must also settle any dialog it left open. The
			// runtime is parked on that answer, and aborting the controller
			// alone never reaches it — `permissions()` documents that the Core's
			// risk gateway does not forward the signal to `onAsk`. Without this
			// the turn (and `isBusy`) waits for the broker's own 120s timer.
			this.broker?.cancelAll('the turn timed out');
			controller.abort();
		}, this.turnTimeoutMs);

		try {
			// Tools are registered once per session and reused; the recorder
			// wrappers are also reused, so a turn cannot double-wrap a tool.
			const tools = this.tools();
			const recorders = this.recorders;

			// The workspace is the conversation's project root. Without it the
			// filesystem tools refuse to run, which is the intended refusal: an
			// unbound tool has no directory to confine itself to.
			const workingDirectory = await this.workspaceFor(conversation);

			// Built before the gateway, and per turn: the broker announces on this
			// turn's sink, so a prompt raised in one turn cannot be announced to
			// another's — and the previous turn's open prompts are denied as this
			// one starts, rather than left pending forever.
			this.broker?.cancelAll('the turn was replaced by a new one');
			this.broker = this.permissionsBroker(sink);

			const runtime = new ConversationRuntime({
				provider,
				tools,
				permissions: this.permissions(),
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
			const release = (): void => {
				clearTimeout(timeout);
				if (this.inFlight?.turnId === turnId) {
					this.inFlight = undefined;
				}
			};

			await runAgentTurn(
				{
					runtime,
					model: input.model,
					tools,
					permissions: this.permissions(),
					recorders,
					// Called just before the terminal event, so the slot is free by
					// the time anyone observes the turn as finished.
					release,
					persistToolResult: (output, toolCallId) =>
						this.appendToolResult(conversation, output, toolCallId),
					persistAssistant: (content, toolCalls) =>
						this.appendAssistant(conversation, content, toolCalls),
				},
				record,
				turnId,
				sink,
				{ signal: controller.signal },
			);
			// Covers a turn that ended without a terminal event, which should not
			// happen but must not strand the session either.
			release();
		} catch (error) {
			// Persistence failed, or the runtime could not be built. Either way
			// the renderer needs one terminal event, and it must not carry a key.
			clearTimeout(timeout);
			// A dialog opened by this turn would outlive it otherwise, and the
			// card would keep reading as a request still waiting for an answer.
			this.broker?.cancelAll('the turn failed');
			if (this.inFlight?.turnId === turnId) {
				this.inFlight = undefined;
			}
			this.logger.error('Agent turn failed', { turnId, error });
			sink({ type: 'error', turnId, message: describeError(error) });
		}
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

	/** The tool registry, built once and reused across turns. */
	private tools(): ToolRegistry {
		if (this.registry === undefined) {
			// The real command runner, not a stub: this is the product's own
			// stack, and `run_command` is `dangerous` so the gateway denies it
			// before the runner is ever reached.
			const stack = createMvpAgentStack({});
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
	private permissions(): PermissionGateway {
		// Built once, and cached with the gateway so the two cannot drift apart.
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
	 * The broker, built on first use.
	 *
	 * It takes the same sink as the turn's events, which is what makes a
	 * permission request show up in the renderer without a second channel being
	 * invented for it.
	 */
	private permissionsBroker(sink: AgentEventSink): PermissionBroker {
		if (this.broker === undefined) {
			this.broker = new PermissionBroker({
				emit: (kind, payload) => {
					if (kind === 'requested') {
						const prompt = payload as PermissionPrompt;
						sink({ type: 'permissionRequested', turnId: prompt.turnId, prompt });
						return;
					}
					const report = payload as DecisionReport;
					sink({
						type: 'permissionResolved',
						// The turn, not the request: `report.id` is `perm-N`, an id
						// the renderer has never seen as a turn, so a resolution
						// filed under it is dropped by the turn filter and the note
						// about what was allowed never appears.
						turnId: report.turnId,
						id: report.id,
						toolName: report.toolName,
						decision: report.decision,
						source: report.source,
					});
				},
			});
		}
		return this.broker;
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

	/** Releases the tool registry. Called when the session is torn down. */
	dispose(): void {
		// A dialog left open across teardown would resolve into nothing.
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
function toConversationListItem(record: ConversationRecord): ConversationListItem {
	return parseConversationListItem({
		id: record.id,
		title: record.title,
		// A conversation always belongs to a provider in the desktop; the empty
		// fallback is unreachable here and would only hide a bug.
		providerId: record.providerId ?? '',
		...(record.projectId !== undefined ? { projectId: record.projectId } : {}),
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		// The system prompt is part of the transcript, so it counts as a message
		// here — otherwise a conversation with a prompt but no turns would read as
		// empty in the sidebar.
		messageCount: record.messages.length,
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