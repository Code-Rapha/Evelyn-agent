/**
 * The runtime's conversation loop.
 *
 * One turn is:
 *
 *   messages → ChatProvider → text and/or tool calls
 *     → permission check → execute → append result → loop again
 *   → final answer with no tool calls
 *
 * Three rules govern the whole file:
 *
 * - The model never reaches a tool directly. Every call goes through the
 *   permission port first, and a denial is fed back to the model as a result
 *   rather than swallowed, so it can tell the user why.
 * - The loop is bounded. A model that keeps calling tools gets stopped at
 *   `maxTurns` instead of running forever.
 * - Everything is streamed as `AgentEvent`. Nothing here draws, and nothing
 *   here stores the conversation.
 */
import { AgentError } from '../errors';
import type {
	ChatMessage,
	ChatProvider,
	ChatRequest,
	ChatStreamEvent,
	ToolDefinition,
} from '../providers/chat/types';
import type { AgentEvent, AgentSession, AgentTurn, CompletionReason, ToolCall } from './types';
import type { ToolRegistry } from './toolRegistry';
import {
	isDecision,
	redactArguments,
	type PermissionDecision,
	type PermissionGateway,
	type PermissionRequest,
} from '../permissions/gateway';

/**
 * The authorization port, re-exported from its own module.
 *
 * `PermissionGateway` lives in `core/permissions` because that is where policy
 * belongs; the runtime only depends on the interface and never on an
 * implementation.
 */
export type PermissionPort = PermissionGateway;

export interface AgentRuntimeOptions {
	readonly provider: ChatProvider;
	readonly tools: ToolRegistry;
	readonly permissions: PermissionPort;
	/** Model used when the caller does not name one. */
	readonly defaultModel?: string;
	/**
	 * Hard cap on provider round-trips per turn.
	 *
	 * Defaults to `DEFAULT_MAX_TURNS`. The cap is a safety net against a model
	 * that loops forever, **not** a task budget: a task with several stages
	 * needs more round-trips than an answer does, and stopping it at a fixed
	 * count reads to the user as "the Evelyn gave up in the middle". The host
	 * raises it when the turn is a task; the retry budget below is what
	 * actually bounds a stuck tool.
	 */
	readonly maxTurns?: number;
	/**
	 * Quantas vezes uma ferramenta com erro **transitório** é tentada de novo.
	 *
	 * O padrão é 2 novas tentativas (3 execuções). A nova tentativa acontece
	 * com espera crescente e só quando o erro é classificável como
	 * transitório — uma recusa de permissão, um caminho inválido ou um
	 * argumento malformado não são tentados de novo, porque repeti-los só
	 * gastaria tempo para falhar igual.
	 */
	readonly toolRetries?: number;
	/** Espera base entre tentativas, em ms. Cresce linearmente. */
	readonly retryDelayMs?: number;
	/** Working directory handed to every tool's execution context. */
	readonly workingDirectory?: string;
	/**
	 * Names this turn in permission requests.
	 *
	 * The host's own turn id when it has one. The desktop's `ChatSession` names
	 * its turns and the renderer only accepts events carrying the id of the turn
	 * it is watching, so the id this runtime would invent on its own is a second
	 * one to keep in sync — and they disagree from the second turn on, because a
	 * runtime is built per turn and would always start its counter over.
	 *
	 * Defaults to `turn-N`, generated per `run()`, which is what a host without
	 * its own ids gets.
	 */
	readonly sessionId?: string;
}

export interface TurnInput {
	readonly model?: string;
	/** New messages to append. A bare user message is the common case. */
	readonly messages: readonly ChatMessage[];
}

/**
 * O teto de segurança para um turno **sem** tarefa declarada.
 *
 * Continua sendo uma rede contra um modelo em laço, não um orçamento de
 * tarefa: quem tem tarefa de várias etapas sobe o teto explicitamente.
 */
const DEFAULT_MAX_TURNS = 8;

/** Novas tentativas padrão de uma ferramenta com erro transitório. */
const DEFAULT_TOOL_RETRIES = 2;

/** Espera base entre novas tentativas de ferramenta, em ms. */
const DEFAULT_RETRY_DELAY_MS = 250;

export class ConversationRuntime {
	private readonly provider: ChatProvider;
	private readonly tools: ToolRegistry;
	private readonly gateway: PermissionPort;
	private readonly maxTurns: number;
	private readonly toolRetries: number;
	private readonly retryDelayMs: number;
	private readonly workingDirectory: string | undefined;

	private sessionCounter = 0;
	private current: CompletionReason | 'running' = 'running';
	/**
	 * Events produced inside `runTool`, which cannot yield because it returns a
	 * string. Drained by the loop so a host still sees every permission step.
	 */
	private pendingEvents: AgentEvent[] = [];
	/**
	 * The signal of the turn currently running, forwarded to every tool so a
	 * blocking tool can honour cancellation without knowing about the loop.
	 */
	private turnSignal: AbortSignal | undefined;
	/** Identifies the current turn in permission requests. */
	private sessionId = 'runtime';

	constructor(private readonly options: AgentRuntimeOptions) {
		this.provider = options.provider;
		this.tools = options.tools;
		this.gateway = options.permissions;
		this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
		this.toolRetries = Math.max(0, options.toolRetries ?? DEFAULT_TOOL_RETRIES);
		this.retryDelayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
		this.workingDirectory = options.workingDirectory;
	}

	/** Satisfies the `AgentRuntime` contract's session half. */
	async createSession(modelId?: string): Promise<AgentSession> {
		this.sessionCounter += 1;
		return { id: `session-${this.sessionCounter}`, modelId };
	}

	async disposeSession(sessionId: string): Promise<void> {
		void sessionId;
	}

	/**
	 * Runs one turn, streaming events as they happen.
	 *
	 * `history` is the caller's conversation. It is never mutated: each round
	 * builds a new array, so an aborted turn leaves the caller's copy intact
	 * and a retry starts from the same place.
	 */
	async *run(
		input: TurnInput,
		options: { readonly signal?: AbortSignal } = {},
	): AsyncGenerator<AgentEvent, void, undefined> {
		this.current = 'running';
		// A turn that died between a permission prompt and its drain must not
		// leak those events into the next one.
		this.pendingEvents.length = 0;
		this.turnSignal = options.signal;
		this.sessionCounter += 1;
		// The host's id when it supplied one, so a permission prompt raised in
		// this turn is announced under the same id the host already gave the
		// turn; otherwise the runtime's own `turn-N`, which counts per runtime.
		this.sessionId = this.options.sessionId ?? `turn-${this.sessionCounter}`;
		const model = input.model ?? this.options.defaultModel ?? '';

		try {
			// Inside the `try`: input that cannot even be copied must surface as
			// `TurnFailed` + `TurnCompleted` like every other failure, not escape
			// the generator with `completion` stuck at `'running'`.
			let history: ChatMessage[] = [...input.messages];
			for (let turn = 0; turn < this.maxTurns; turn += 1) {
				if (this.isAborted(options.signal)) {
					this.current = 'aborted';
					yield { type: 'TurnCompleted', reason: 'aborted' };
					return;
				}

				const request: ChatRequest = {
					model,
					messages: history,
					tools: this.toolDefinitions(),
					stream: true,
				};

				const stream = await this.provider.streamChat(request, {
					...(options.signal !== undefined ? { signal: options.signal } : {}),
				});

				let text = '';
				const calls: ToolCall[] = [];
				/**
				 * Where each id sits in `calls`.
				 *
				 * A second delta under an id already here is either a repeat —
				 * a server that ends the response on `finish_reason` and then
				 * sends `[DONE]`, which used to yield the call twice — or a
				 * later reading of the same call as its arguments fill in.
				 * Either way it must not become a second entry: the tool would
				 * run twice, ask twice, and leave two `role:"tool"` messages
				 * under one `tool_call_id`, which no OpenAI-compatible server
				 * accepts.
				 *
				 * Each delta is read as the whole call so far, which is what
				 * `SseChatStream` emits once it has accumulated the fragments.
				 */
				const seen = new Map<string, number>();

				for await (const event of stream) {
					if (event.type === 'Error') {
						this.current = 'error';
						yield { type: 'TurnFailed', error: event.error };
						yield { type: 'TurnCompleted', reason: 'error' };
						return;
					}
					if (event.type === 'TextDelta') {
						text += event.text;
						yield { type: 'TextDelta', text: event.text };
						continue;
					}
					if (event.type === 'ReasoningDelta') {
						// Forwarded but never accumulated into `text`: `text` becomes the
						// assistant message in the transcript, and the next turn replays
						// that transcript back to the model. Appending the scratchpad
						// there would put words in the user's mouth on every later
						// request.
						yield { type: 'ReasoningDelta', text: event.text };
						continue;
					}
					if (event.type === 'ToolCallDelta') {
						const known = seen.get(event.call.id);
						if (known !== undefined) {
							// Not re-announced: the host already has this call, and a
							// second `ToolCallRequested` would draw a second bubble for
							// a tool that only runs once. Only a genuine continuation
							// — arguments that build on the recorded ones — changes
							// what the tool will be run with.
							const previous = calls[known];
							const extended = extendArguments(previous.rawArguments, event.call.arguments);
							if (extended !== previous.rawArguments) {
								calls[known] = this.toToolCall(previous.id, previous.name, extended);
							}
							continue;
						}
						const call = this.toToolCall(event.call.id, event.call.name, event.call.arguments);
						seen.set(event.call.id, calls.length);
						calls.push(call);
						yield { type: 'ToolCallRequested', call };
					}
				}

				if (this.isAborted(options.signal) || stream.closedReason === 'aborted') {
					this.current = 'aborted';
					yield { type: 'TurnCompleted', reason: 'aborted' };
					return;
				}

				// The assistant's own turn belongs in the history, so the model
				// sees what it said when deciding what to do next. Tool calls
				// are folded into the assistant text; their results become
				// separate tool messages below, so nothing is recorded twice.
				//
				// The structured `toolCalls` travels alongside that summary. The
				// summary is what the transcript shows and what the model reads as
				// prose; `tool_calls` is what the wire format requires as the
				// parent of the `role:"tool"` messages that follow. Dropping either
				// would either lose the calls on a strict server or change the
				// conversation the model is shown.
				const callSummary =
					calls.length === 0
						? ''
						: `\n\n[tool calls: ${calls
								.map((call) => `${call.name}(${call.rawArguments})`)
								.join(', ')}]`;
				history = [
					...history,
					{
						role: 'assistant',
						content: text + callSummary,
						...(calls.length > 0
							? {
									toolCalls: calls.map((call) => ({
										id: call.id,
										name: call.name,
										arguments: call.rawArguments,
									})),
								}
							: {}),
					},
				];

				if (calls.length === 0) {
					this.current = 'answered';
					yield { type: 'TurnCompleted', reason: 'answered' };
					return;
				}

				for (const call of calls) {
					if (this.isAborted(options.signal)) {
						this.current = 'aborted';
						yield { type: 'TurnCompleted', reason: 'aborted' };
						return;
					}
					const outcome = await this.runTool(call, options.signal);
					for (const pending of this.pendingEvents.splice(0)) {
						yield pending;
					}
					history = [...history, { role: 'tool', content: outcome, toolCallId: call.id }];
					// `output` carries `outcome` verbatim: it is what the model was
					// told, and the host must show and store the same text.
					yield { type: 'ToolCompleted', callId: call.id, ok: isSuccessOutcome(outcome), output: outcome };
				}
			}

			this.current = 'maxTurns';
			yield { type: 'TurnCompleted', reason: 'maxTurns' };
		} catch (error) {
			this.current = 'error';
			yield { type: 'TurnFailed', error: toError(error) };
			yield { type: 'TurnCompleted', reason: 'error' };
		}
	}

	/** The reason the last turn ended. */
	get completion(): CompletionReason | 'running' {
		return this.current;
	}

	/**
	 * Resolves, authorizes and runs one tool call.
	 *
	 * Returns the text fed back to the model. A denial, a missing tool, a
	 * malformed argument and a throwing tool all resolve to a message rather
	 * than an exception: the model needs to know what happened in order to
	 * recover, and killing the turn would leave the user with no answer.
	 */
	private async runTool(call: ToolCall, signal?: AbortSignal): Promise<string> {
		if (call.malformed) {
			return `ERROR: the arguments for "${call.name}" were not a JSON object. Send a JSON object.`;
		}

		const tool = this.tools.get(call.name);
		if (tool === undefined) {
			const known = this.tools.names();
			return `ERROR: no tool named "${call.name}" is registered. Available: ${
				known.length > 0 ? known.join(', ') : 'none'
			}.`;
		}

		const spec = this.tools.spec(call.name);
		const description = spec?.description ?? tool.descriptor.description ?? `Run ${call.name}`;
		// Redacted before it reaches the gateway: a request may be shown on
		// screen, logged, or kept in a history file.
		const args = redactArguments(call.arguments ?? {});

		const request: PermissionRequest = {
			toolId: tool.descriptor.id,
			toolName: call.name,
			action: call.name,
			description,
			riskLevel: tool.descriptor.riskLevel,
			arguments: args,
			...(this.workingDirectory !== undefined
				? { workspace: this.workingDirectory }
				: {}),
			sessionId: this.sessionId,
		};

		// A host that has to prompt needs to know the question is coming, not
		// only the answer. `runTool` returns only text, so this event is
		// recorded here and surfaced by the caller through `pendingEvents`.
		this.pendingEvents.push({
			type: 'PermissionRequested',
			request: {
				toolId: request.toolId,
				toolName: request.toolName,
				action: request.action,
				description: request.description,
				riskLevel: request.riskLevel,
				arguments: request.arguments,
				...(request.workspace !== undefined ? { workspace: request.workspace } : {}),
			},
		});

		// If the user stopped the turn while a dialog was open, the decision no
		// longer matters and the tool must not run.
		if (this.isAborted(signal)) {
			this.pendingEvents.push({ type: 'PermissionResolved', granted: false });
			return `ERROR: the turn was cancelled before "${call.name}" could run.`;
		}

		let decision: PermissionDecision;
		try {
			decision = await this.gateway.ask(request, {
				...(signal !== undefined ? { signal } : {}),
			});
		} catch (error) {
			this.pendingEvents.push({ type: 'PermissionResolved', granted: false });
			return `ERROR: the permission check for "${call.name}" failed: ${toError(error).message}`;
		}

		if (!isDecision(decision)) {
			this.pendingEvents.push({ type: 'PermissionResolved', granted: false });
			return `ERROR: the permission gateway returned an unusable decision for "${call.name}".`;
		}

		// Checked again *after* the answer. An abort that arrived while the
		// gateway was suspended must stop the tool even if the gateway had
		// already said yes — otherwise the user's stop button loses the race
		// against a dialog that was about to close anyway.
		if (this.isAborted(signal)) {
			this.pendingEvents.push({ type: 'PermissionResolved', granted: false });
			return `ERROR: the turn was cancelled before "${call.name}" could run.`;
		}

		this.pendingEvents.push({
			type: 'PermissionResolved',
			granted: decision.decision === 'allow',
		});

		if (decision.decision === 'deny') {
			return `ERROR: permission to run "${call.name}" was denied. Reason: ${decision.reason}`;
		}

		let result;
		let attempt = 0;
		for (;;) {
			try {
				result = await tool.execute(call.arguments ?? {}, {
					sessionId: 'runtime',
					...(this.workingDirectory !== undefined
						? { workingDirectory: this.workingDirectory }
						: {}),
					// Passed through so a blocking tool can stop when the user does.
					...(this.turnSignal !== undefined ? { signal: this.turnSignal } : {}),
				});
			} catch (error) {
				result = { ok: false as const, error: toError(error).message, output: undefined };
			}

			// A falha **transitória** é tentada de novo: a trava ainda ocupada,
			// a rede que caiu, o arquivo que estava sendo escrito. A tarefa não
			// termina por isso — é o que o usuário vê como "a Evelyn desistiu".
			const transient = !result.ok && isTransientFailure(result.error ?? '');
			const aborted = this.isAborted(this.turnSignal);
			if (!transient || attempt >= this.toolRetries || aborted) {
				break;
			}
			attempt += 1;
			// O modelo e o host ficam sabendo da nova tentativa: sem o evento,
			// a ferramenta pareceria demorar mais sem motivo.
			this.pendingEvents.push({
				type: 'ToolRetry',
				callId: call.id,
				toolName: call.name,
				attempt,
				of: this.toolRetries,
				reason: result.error ?? '',
			});
			await delay(this.retryDelayMs * attempt, this.turnSignal);
			if (this.isAborted(this.turnSignal)) {
				break;
			}
		}

		if (!result.ok) {
			return `ERROR: "${call.name}" failed: ${result.error ?? 'no detail given'}`;
		}
		return serializeOutput(result.output);
	}

	/** Tool specs mapped to the model's function-calling shape. */
	private toolDefinitions(): readonly ToolDefinition[] | undefined {
		const specs = this.tools.listSpecs();
		if (specs.length === 0) {
			// Sending an empty tool list makes some servers reject the request.
			return undefined;
		}
		return specs.map((spec) => ({
			name: spec.name,
			description: spec.description,
			parameters: spec.parameters,
		}));
	}

	private toToolCall(id: string, name: string, rawArguments: string): ToolCall {
		let parsed: Readonly<Record<string, unknown>> | undefined;
		let malformed = false;
		try {
			const value: unknown = JSON.parse(rawArguments.length === 0 ? '{}' : rawArguments);
			if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
				parsed = value as Record<string, unknown>;
			} else {
				malformed = true;
			}
		} catch {
			malformed = true;
		}
		return {
			id,
			name,
			rawArguments,
			...(parsed !== undefined ? { arguments: parsed } : {}),
			malformed,
		};
	}

	private isAborted(signal: AbortSignal | undefined): boolean {
		return signal?.aborted === true;
	}
}

/** Wraps a turn in the `AgentTurn` shape a host consumes. */
export async function toAgentTurn(
	runtime: ConversationRuntime,
	input: TurnInput,
	options: { readonly signal?: AbortSignal } = {},
): Promise<AgentTurn> {
	const events: AgentEvent[] = [];
	for await (const event of runtime.run(input, options)) {
		events.push(event);
	}
	return {
		completion: runtime.completion,
		[Symbol.asyncIterator]: async function* () {
			yield* events;
		},
	};
}

/** Prefix every failed tool result carries, by convention. */
const TOOL_ERROR_PREFIX = 'ERROR:';

/**
 * Erros que valem uma nova tentativa.
 *
 * A lista é intencionalmente **estreita**: só o que é, por natureza, passageiro
 * — o recurso ocupado, a rede, o arquivo que estava aberto. Um caminho fora do
 * escopo, uma permissão recusada e argumentos inválidos não entram: repetir
 * esses gastaria o orçamento da tarefa para falhar igual.
 */
const TRANSIENT_PATTERNS: readonly RegExp[] = [
	/em uso por (outro|outra)|está ocupad|está em uso/i,
	/dev_busy|dev_lock_timeout/i,
	/\bEBUSY\b|\bETXTBSY\b|\bEAGAIN\b|\bEACCES\b|\bEPERM\b|\bEMFILE\b|\bENFILE\b/,
	/\bECONNRESET\b|\bECONNREFUSED\b|\bETIMEDOUT\b|\bEAI_AGAIN\b|\bENOTFOUND\b|\bEPIPE\b/,
	/\btime(d)? out\b|\btimeout\b|\btimed out\b/i,
	/temporar(y|ily)|transient|retry|tente de novo/i,
	/network error|fetch failed|socket hang up/i,
];

/** A falha desta ferramenta pode passar com uma nova tentativa? */
export function isTransientFailure(message: string): boolean {
	return TRANSIENT_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Espera entre tentativas, cancelável.
 *
 * Sem o sinal, um turno parado durante a espera continuaria dormindo até o
 * fim do atraso antes de perceber — e a parada pareceria lenta.
 */
function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
	if (ms <= 0 || signal?.aborted === true) {
		return Promise.resolve();
	}
	return new Promise<void>((resolve) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		function onAbort(): void {
			clearTimeout(timer);
			resolve();
		}
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

/**
 * Reconciles a second reading of one call's arguments.
 *
 * A repeat returns what was already recorded, so re-emitted deltas cannot
 * double the arguments; a later reading that builds on them returns the longer
 * form, so the call runs with the fullest version seen. Anything that
 * disagrees with the first reading is left alone: the call was already shown
 * to the user under those arguments, and silently swapping them afterwards
 * would mean running something different from what was announced.
 */
function extendArguments(known: string, incoming: string): string {
	if (incoming.length > known.length && incoming.startsWith(known)) {
		return incoming;
	}
	return known;
}

/**
 * How a result is classified. `runTool` reports failures as `ERROR:` text
 * because the model needs the reason, so this reads the marker rather than
 * carrying a second, parallel status field through the transcript.
 */
function isSuccessOutcome(outcome: string): boolean {
	return !outcome.startsWith(TOOL_ERROR_PREFIX);
}

/** Serializes a tool result for the model, tolerating anything it returns. */
function serializeOutput(output: unknown): string {
	if (typeof output === 'string') {
		return output;
	}
	try {
		return JSON.stringify(output) ?? '';
	} catch {
		return String(output);
	}
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

/** Re-exported so hosts can type their own tools without a deep import. */
export type { AgentEvent, ChatStreamEvent };