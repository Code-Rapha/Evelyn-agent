/**
 * The agent turn: the bridge between the Core's `ConversationRuntime` and the
 * UI's event stream.
 *
 * This is where the agent loop is driven at the desktop level. It imports no
 * `electron`, so the whole flow — model, tool call, permission, tool result,
 * model again, final answer — is testable under plain mocha with a fake `fetch`
 * and no window.
 *
 * Three rules decide the design:
 *
 * - The runtime is *driven*, not reimplemented. `ConversationRuntime.run` is the
 *   loop; this file only feeds it history, and translates its `AgentEvent`s.
 *   `ChatStream` is not consumed here at all — an earlier stage did that, and it
 *   is exactly what would have kept tools unreachable.
 *
 * - The runtime's own text is what reaches the UI. `ToolCompleted` carries
 *   `output` — the exact message the model was fed back, denial, unknown tool,
 *   malformed arguments or result — so this file shows and persists the same
 *   text the model saw instead of guessing at the reason. `RecordingTool`
 *   (see `toolRecorder.ts`) still backs `ok` for a tool that recorded a result
 *   of its own, and this file drains it as each `ToolCompleted` arrives so its
 *   queue never grows across turns.
 *
 * - Persistence is incremental and happens once each. The user message is
 *   written before the turn starts, each tool result as it completes, and the
 *   assistant text at the end. A turn that dies leaves a truthful transcript
 *   rather than a half-written one.
 */
import type { AgentEvent } from '../core/agent/types';
import type { AbortCause, PermissionPrompt } from './contract';
import type { ConversationRuntime } from '../core/agent/runtime';
import type { ToolRegistry } from '../core/agent/toolRegistry';
import type { PermissionGateway } from '../core/permissions/gateway';
import type { ChatMessage, ToolCallRequest } from '../core/providers/chat/types';
import type { ConversationRecord } from '../core/storage/types/dataStore';
import type { RecordingTool } from './toolRecorder';
import type { SkillDiscoveryService } from '../core/skill/types';
import { createSeshyinaAgentSystemMessage, hasSeshyinaIdentity } from '../core/agent/seshyinaAgent';

/** One skill that became live during a turn. */
export interface LearnedSkill {
	readonly id: string;
	readonly title: string;
	readonly confidence: number;
	readonly proposalId: string;
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

/**
 * One step of an agent turn, as the UI sees it.
 *
 * A superset of the plain-chat events from the previous stage: `delta`/`done`
 * are unchanged and the tool events are new. One event type for both means the
 * renderer has a single switch rather than two parallel paths.
 */
export type AgentUiEvent =
	| {
			readonly type: 'started';
			readonly turnId: string;
			/** O modo e o par efetivo do turno, quando o host os conhece. */
			readonly routing?: {
				readonly mode: 'auto' | 'direct' | 'external';
				readonly providerId?: string;
				readonly model?: string;
			};
	  }
	| { readonly type: 'delta'; readonly turnId: string; readonly text: string }
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
			 * A interface distingue isto de `toolResult` com `ok: false`: o
			 * segundo é o desfecho, o primeiro é uma **espera** que pode ainda
			 * terminar bem.
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
			 * Why the answer was what it was: the user, a cancellation, a
			 * leitura automática, ou uma concessão de escopo da tarefa.
			 *
			 * A interface distingue as quatro — uma permissão que aparece sem
			 * ninguém ter sido perguntado precisa dizer por quê.
			 */
			readonly source: 'user' | 'cancelled' | 'automatic' | 'grant';
			/** O escopo que autorizou, quando `source` é `automatic` ou `grant`. */
			readonly scope?: string;
	  }
	| {
			readonly type: 'skillsLoaded';
			readonly turnId: string;
			/** IDs of skills that were loaded and injected into the context. */
			readonly skillIds: readonly string[];
			/** Whether any explicitly requested skills were not found. */
			readonly missing?: readonly string[];
	  }
	| {
			/**
			 * Uma skill nova foi aprendida neste turno, sem clique.
			 *
			 * Emitido depois de o texto ter sido gravado e antes de `done`, para
			 * que o selo e o desfecho falem do mesmo turno. Vazio não é emitido:
			 * um turno que não ensinou nada não precisa dizer isso.
			 */
			readonly type: 'skillLearned';
			readonly turnId: string;
			readonly skills: readonly LearnedSkill[];
	  }
	| {
			/**
			 * Um candidato pago não foi chamado porque um limite de orçamento o
			 * vetou.
			 *
			 * Não é um erro do modelo nem do turno: o turno pode ter seguido em
			 * outro modelo. `message` já vem pronta para o usuário.
			 */
			readonly type: 'budgetBlocked';
			readonly turnId: string;
			readonly providerId: string;
			readonly modelId: string;
			readonly attempt: number;
			readonly message: string;
	  }
	| {
			readonly type: 'done';
			readonly turnId: string;
			/** The full assistant text, so the renderer need not trust its accumulation. */
			readonly content: string;
			/** The runtime's `CompletionReason`. */
			readonly reason: string;
			/** How many tools ran. `0` means the model answered directly. */
			readonly toolCalls: number;
	  }
	/**
	 * The model's thinking phase. Its own event so the host can show it as
	 * provisional, and never folded into the `delta` events that become the
	 * stored assistant message.
	 */
	| { readonly type: 'reasoning'; readonly turnId: string; readonly text: string }
	| {
			/**
			 * A message the user should see that is neither the answer nor a
			 * failure — a policy applied from a sentence, for instance.
			 *
			 * Separate from `error`: a notice does not abort or fail the turn,
			 * and the orchestrator must never treat it as a recoverable error.
			 */
			readonly type: 'notice';
			readonly turnId: string;
			readonly message: string;
	  }
	| {
			readonly type: 'error';
			readonly turnId: string;
			readonly message: string;
			/**
			 * Why the turn was aborted, when it was aborted rather than failed.
			 *
			 * Mirrors the contract's `ChatStreamEvent`, which is what the renderer
			 * and the orchestrator actually consume. Without it here, the host
			 * would receive an error event with the cause stripped off — and the
			 * orchestrator would go back to inferring "was this a timeout?" from
			 * the message, which is the bug this field exists to fix.
			 */
			readonly abortCause?: AbortCause;
	  }
	| {
		/** The orchestration selected a model for this turn. */
		readonly type: 'modelSelected';
		readonly turnId: string;
		readonly providerId: string;
		readonly modelId: string;
		readonly strategy: 'manual' | 'fallback';
		readonly reason: string;
		readonly isFallback: boolean;
	  }
	| {
		/** A fallback attempt is starting (after a recoverable error on a previous model). */
		readonly type: 'fallbackAttempted';
		readonly turnId: string;
		readonly attempt: number;
		readonly providerId: string;
		readonly modelId: string;
		readonly previousError: string;
	  };

/** Where events go. Main wires this to IPC; tests collect into an array. */
export type AgentEventSink = (event: AgentUiEvent) => void;

/** Everything the turn needs that lives outside it. */
export interface AgentTurnHooks {
	readonly runtime: ConversationRuntime;
	readonly model: string;
	readonly tools: ToolRegistry;
	readonly permissions: PermissionGateway;
	/** The recorders wrapping this turn's tools, keyed by tool name. */
	readonly recorders: ReadonlyMap<string, RecordingTool>;
	/**
	 * Releases the turn's slot, called just before the terminal event.
	 *
	 * The session hands this in so `isBusy` is already false by the time anyone
	 * reacts to `done`; doing it in a `finally` afterwards would leave the turn
	 * looking registered for one more tick.
	 */
	release(): void;
	/** Writes one tool result, in the order the tools completed. */
	persistToolResult(output: string, toolCallId: string): Promise<void>;
	/**
	 * Writes one assistant message. Called once per round.
	 *
	 * The calls are the round's ids and raw arguments, in the shape the wire
	 * format wants them: without a record of them the transcript that comes
	 * back on the next turn announces no `tool_calls`, and every `tool` message
	 * stored after it answers a call no message ever made.
	 */
	persistAssistant(content: string, toolCalls?: readonly ToolCallRequest[]): Promise<void>;
	/** Optional skill discovery service for contextual skill loading. */
	readonly skillDiscovery?: SkillDiscoveryService;
	/**
	 * O modo de turno escolhido no chat (DEV-8.9) e o par efetivo.
	 *
	 * Viaja no evento `started` para a interface mostrar o que de fato
	 * respondeu — no modo automático, o que o motor escolheu.
	 */
	readonly routing?: {
		readonly mode: 'auto' | 'direct' | 'external';
		readonly providerId?: string;
		readonly model?: string;
	};
	/** The user's message that started this turn, for skill discovery. */
	readonly userMessage?: string;
	/**
	 * Runs the automatic learner once, after the turn completed.
	 *
	 * Called only for a turn that actually completed and produced something,
	 * and before the terminal event. The hook's contract is to report what it
	 * created and not to throw: learning is a side effect of a turn, never a
	 * reason for the turn to fail.
	 */
	readonly learnSkills?: () => Promise<readonly LearnedSkill[]>;
}

/**
 * Runs one agent turn and reports every step.
 *
 * The runtime owns the loop; this function owns the history, the persistence and
 * the translation. Exactly one terminal event is emitted in every outcome —
 * answered, aborted, failed — so the renderer's loading state always clears.
 */
export async function runAgentTurn(
	hooks: AgentTurnHooks,
	record: ConversationRecord,
	turnId: string,
	sink: AgentEventSink,
	options: { readonly signal?: AbortSignal } = {},
): Promise<void> {
	// The whole stored transcript, which already includes the user's message the
	// caller persisted just before starting this turn.
	const messages: ChatMessage[] = [];
	for (const message of record.messages) {
		// A stored tool result cannot be followed directly by a new user
		// message: strict OpenAI-compatible servers reject `user` coming
		// right after `tool` because nothing answered the result. Preserve
		// both halves instead of dropping either by inserting the assistant
		// continuation that complete turn would have produced.
		if (
			messages.length > 0 &&
			messages[messages.length - 1].role === 'tool' &&
			message.role === 'user'
		) {
			messages.push({ role: 'assistant', content: '' });
		}
		messages.push({
			role: message.role,
			content: message.content,
			...(message.toolCallId !== undefined ? { toolCallId: message.toolCallId } : {}),
			...(message.toolCalls !== undefined ? { toolCalls: message.toolCalls } : {}),
		});
	}

	// A identidade da Evelyn entra **dentro** do prompt da conversa, não como
	// uma segunda mensagem `system`.
	//
	// Medido, com o River e o `Qwen/Qwen3.8-27B-FP8`: duas mensagens `system`
	// recebem `invalid_request` — "Check the model's supported parameters and
	// input limits". Uma só passa. O app enviava sempre duas quando a conversa
	// tinha prompt próprio (a identidade + o prompt), então **toda** conversa
	// com `systemPrompt` — o diálogo de preferências de modelo é a que existe —
	// era recusada, e a recusa chegava como um evento de erro no stream.
	//
	// Juntar as duas numa só preserva o que cada uma dizia: a identidade
	// primeiro, o prompt da conversa depois, separados por uma linha. É também
	// o formato que qualquer servidor compatível aceita.
	if (!hasSeshyinaIdentity(messages)) {
		const identity = createSeshyinaAgentSystemMessage();
		const existingSystemIndex = messages.findIndex((m) => m.role === 'system');
		if (existingSystemIndex >= 0) {
			const existing = messages[existingSystemIndex];
			messages[existingSystemIndex] = {
				...existing,
				content:
					existing.content.trim().length === 0
						? identity.content
						: `${identity.content}\n\n---\n\n${existing.content}`,
			};
		} else {
			messages.unshift(identity);
		}
	}

	// Discover and inject relevant skills
	const skillInstructions = await discoverSkills(hooks, messages);

	sink({
		type: 'started',
		turnId,
		...(hooks.routing !== undefined ? { routing: hooks.routing } : {}),
	});

	// Emit skillsLoaded event if any skills were loaded
	if (skillInstructions.loadedSkillIds.length > 0) {
		sink({
			type: 'skillsLoaded',
			turnId,
			skillIds: skillInstructions.loadedSkillIds,
			...(skillInstructions.missing ? { missing: skillInstructions.missing } : {}),
		});
	}

	const toolNames = new Map<string, string>();
	/** Calls seen in the current round, for the stored assistant message. */
	let roundCalls: ToolCallSummary[] = [];
	let toolCallCount = 0;
	let assistantText = '';
	/**
	 * Every word the model said this turn, across all rounds.
	 *
	 * Kept apart from `assistantText` because that one is emptied each round for
	 * storage, and `done` must report what the turn actually said.
	 */
	let totalText = '';
	/**
	 * A finished round waiting to be stored: the assistant's text and the tool
	 * results it produced.
	 *
	 * Results are buffered rather than written on `ToolCompleted`, because the
	 * runtime's own history puts the assistant message *first* and the results
	 * after it. Writing them as they arrive would store tool, tool, assistant and
	 * leave the next turn's context in a different order than this turn had —
	 * a drift that shows up as a model that seems to forget what it just did.
	 */
	let pendingAssistant: string | undefined;
	let pendingResults: { readonly output: string; readonly callId: string }[] = [];

	const storeRound = async (): Promise<void> => {
		if (pendingAssistant !== undefined) {
			const assistant = pendingAssistant;
			// Captured with them: these are the calls the assistant text
			// describes, and they belong on the message being written, not on
			// whatever round is current by the time the write completes.
			const calls = roundCalls;
			await hooks.persistAssistant(
				assistant,
				calls.map((call) => ({ id: call.id, name: call.name, arguments: call.rawArguments })),
			);
			// Cleared only once the write has landed: a failure here has to
			// leave the round intact so the retry below stores it exactly once,
			// rather than a second copy of it.
			pendingAssistant = undefined;
			roundCalls = [];
		}

		// One result at a time, each removed only after its write succeeds.
		// Clearing the list up front — as this once did — dropped every result
		// after the first failed write and left the already-stored `tool_calls`
		// unanswered, which strict servers reject on the next turn.
		while (pendingResults.length > 0) {
			const next = pendingResults[0];
			await hooks.persistToolResult(next.output, next.callId);
			pendingResults.shift();
		}
	};

	/**
	 * Closes the current round: whatever the model said becomes one assistant
	 * message, followed by the results of the tools it asked for.
	 *
	 * The boundary is detected from the event stream rather than from
	 * `TurnCompleted`, which the runtime yields exactly once — at the very end of the
	 * turn, not per round. Verified against the runtime rather than assumed: it
	 * emits `ToolCallRequested → … → ToolCompleted → TextDelta → TurnCompleted`, so
	 * the first text after a tool result is by definition the next round.
	 *
	 * It is also called once at the end, for the final round, which produces text
	 * and no tool results.
	 */
	const closeRound = async (): Promise<void> => {
		// A call whose result never arrived — the turn was cut short between the
		// request and the completion — must not reach the transcript: a
		// `tool_calls` entry with no tool message behind it makes strict servers
		// reject the whole conversation on the next turn. What the round
		// actually finished is what gets stored.
		if (roundCalls.length > 0) {
			const answered = new Set(pendingResults.map((result) => result.callId));
			const finished = roundCalls.filter((call) => answered.has(call.id));
			if (finished.length !== roundCalls.length) {
				roundCalls = finished;
			}
		}
		// A round that produced no prose still has to be closed. Its assistant
		// message is just the tool-call marker with no text around it — which is
		// exactly the common shape, since a model usually calls a tool without
		// saying anything first. Returning early on empty text dropped those tool
		// results on the floor.
		if (assistantText.length > 0) {
			pendingAssistant = withToolCalls(assistantText, roundCalls);
			totalText += assistantText;
			assistantText = '';
		} else if (pendingAssistant === undefined && pendingResults.length === 0) {
			return;
		} else if (pendingAssistant === undefined && roundCalls.length > 0) {
			// Nothing was said before the tools ran, but the marker still belongs
			// in the transcript so the next turn sees that these calls happened.
			// Guarded on `roundCalls`: a retry after the assistant already landed
			// has an empty call list, and a marker fabricated there would sit
			// under tool results that answer no call at all.
			pendingAssistant = withToolCalls('', roundCalls);
		}
		await storeRound();
	};

	try {
		const stream = hooks.runtime.run(
			{ model: hooks.model, messages: skillInstructions.messages },
			options.signal !== undefined ? { signal: options.signal } : {},
		);

		for await (const event of stream) {
			switch (event.type) {
				case 'ReasoningDelta':
					// Its own event, and deliberately not accumulated into
					// `assistantText`: that string is what gets stored as the
					// assistant message, and the reasoning would then be replayed to
					// the model on the next turn as though the user had typed it.
					sink({ type: 'reasoning', turnId, text: event.text });
					continue;

				case 'TextDelta':
					// Text after a tool result means the runtime has started the next
					// round, so the previous one is closed first. Without this the
					// final answer would be folded into the message that asked for
					// the tool, and the tool result would be stored after it. The
					// guard is on the results alone: a round where the model spoke
					// *before* calling the tool still has prose of its own, and
					// skipping the close there merged both rounds into one message.
					if (pendingResults.length > 0) {
						await closeRound();
					}
					assistantText += event.text;
					sink({ type: 'delta', turnId, text: event.text });
					continue;

				case 'ToolCallRequested': {
					const call: ToolCallSummary = {
						id: event.call.id,
						name: event.call.name,
						rawArguments: event.call.rawArguments,
						malformed: event.call.malformed,
					};
					toolNames.set(call.id, call.name);
					roundCalls.push(call);
					toolCallCount += 1;
					sink({ type: 'toolCall', turnId, call, awaitingPermission: true });
					continue;
				}

				case 'ToolRetry': {
					// A ferramenta vai tentar de novo: a interface mostra
					// "aguardando/repetindo" em vez de "falhou", e nada é
					// persistido — só o resultado final vira mensagem.
					sink({
						type: 'toolRetry',
						turnId,
						callId: event.callId,
						name: event.toolName,
						attempt: event.attempt,
						of: event.of,
						reason: event.reason,
					});
					continue;
				}

				case 'ToolCompleted': {
					// The event carries the exact text the model was fed back — a
					// denial, an unknown tool, malformed arguments, the tool's own
					// result — so the UI shows and the transcript stores what really
					// happened rather than a guessed-at reason. The recorder is still
					// drained: its queue would otherwise grow across turns, and its
					// own `ok` still decides the bubble for a tool that recorded a
					// result of its own.
					const name = toolNames.get(event.callId) ?? 'tool';
					const recorded = hooks.recorders.get(name)?.take();
					const output = event.output;
					sink({
						type: 'toolResult',
						turnId,
						callId: event.callId,
						name,
						ok: recorded?.ok ?? event.ok,
						output,
					});
					pendingResults.push({ output, callId: event.callId });
					continue;
				}

				case 'PermissionRequested':
				case 'PermissionResolved':
					// Folded into `toolCall` above. A separate event here would
					// have the UI render a permission wait it cannot act on.
					continue;

				case 'TurnFailed':
					// The failure cut the round short, so it is *closed*, not
					// merely stored: `closeRound` still sees the calls and the
					// results already collected and persists them. `storeRound`
					// alone returned early on them and left the transcript
					// missing the round the model had actually completed.
					await closeRound();
					hooks.release();
					{
						const abortCause = abortCauseOf(event.error);
						sink({
							type: 'error',
							turnId,
							message: event.error.message,
							...(abortCause !== undefined ? { abortCause } : {}),
						});
					}
					return;

				case 'TurnCompleted':
					// Once per turn, and only at the very end — verified against the
					// runtime, which yields it after the loop finishes rather than
					// per round. Nothing is closed here: the tool rounds that already
					// happened sit behind `pendingResults`, and folding the final
					// answer in with them would lose it.
					continue;
			}
		}
	} catch (error) {
		// Same as `TurnFailed`: whatever the round had is flushed before the
		// error is reported, so a turn that dies here leaves the same
		// transcript a turn that finished would. Both calls are idempotent —
		// a failure inside a previous `closeRound` finds nothing left to store.
		await closeRound();
		hooks.release();
		sink({
			type: 'error',
			turnId,
			message: error instanceof Error ? error.message : String(error),
		});
		return;
	}

	// The loop has ended. The round that finally answers does not yield a
	// `TurnCompleted` of its own, so its text is closed out here.
	await closeRound();
	hooks.release();

	// A turn that said nothing is not an answer.
	//
	// Measured: `Qwen/Qwen3.8-27B-FP8` with tools declared spent 2 333
	// characters of reasoning and emitted no text and no tool call. The turn
	// was reported `done`/`success`, `closeRound` stored nothing (no prose, no
	// calls), and the person watched a chat that never answered — twice, with
	// the second message identical because the first looked ignored. The same
	// prompt without tools answered 1 581 characters of reasoning and 200 of
	// prose, so the model was not broken; the turn was simply empty and said
	// otherwise.
	//
	// Saying it plainly is the honest outcome: the person learns that the
	// model produced nothing and can pick another one, instead of waiting.
	//
	// A turn that ended because someone stopped it, or because a budget ran
	// out, is not this case: those have their own `completion` value and the
	// `done` below reports it. Only a turn the runtime considers **completed**
	// and that produced nothing is the silent one.
	// `answered` is the runtime's name for a turn that reached a final answer;
	// `completed` is not a value it produces. Checking for a value that never
	// arrives is how the guard below and the learner were both silent until an
	// end-to-end run showed it: the turn ended, and nothing happened.
	const completion = hooks.runtime.completion === 'running' ? 'answered' : hooks.runtime.completion;
	if (completion === 'answered' && totalText.trim().length === 0 && toolCallCount === 0) {
		sink({
			type: 'error',
			turnId,
			message:
				'O modelo encerrou o turno sem responder e sem usar nenhuma ferramenta. ' +
				'Não há resposta para mostrar. Tente de novo ou escolha outro modelo.',
		});
		return;
	}

	// The automatic learner sees a turn that actually completed, and sees it
	// before `done` so the badge and the terminal event are about the same
	// turn. It never runs for a stopped or failed turn: half a procedure is
	// not evidence of a procedure.
	//
	// `answered` is the runtime's name for a turn that reached a final answer;
	// `completed` is not a value it produces. Checking for a value that never
	// arrives is how this hook silently did nothing until an end-to-end run
	// showed it: the panel worked, the turn ended, and no skill appeared.
	if (completion === 'answered' && hooks.learnSkills !== undefined) {
		try {
			const learned = await hooks.learnSkills();
			if (learned.length > 0) {
				sink({ type: 'skillLearned', turnId, skills: learned });
			}
		} catch {
			// The hook promises not to throw; a host that breaks that promise
			// still does not get to turn a finished answer into a failure.
		}
	}

	sink({
		type: 'done',
		turnId,
		content: totalText,
		reason: completion,
		toolCalls: toolCallCount,
	});
}

/**
 * Reads a routing abort cause off an error, if it carries one.
 *
 * The engine names five budgets; the host's contract has three. `idle` and
 * `deadline` are timeouts from the user's side too, so they map onto
 * `total-time` rather than inventing a fourth value the renderer would ignore.
 */
function abortCauseOf(error: Error): AbortCause | undefined {
	const cause = (error as { readonly abortCause?: unknown }).abortCause;
	switch (cause) {
		case 'first-token':
			return 'first-token';
		case 'user-stop':
			return 'user-stop';
		case 'idle':
		case 'total-time':
		case 'deadline':
			return 'total-time';
		default:
			return undefined;
	}
}

/**
 * Folds tool calls into the assistant's text.
 *
 * Byte-for-byte the format `runtime.ts` builds internally. The stored transcript
 * has to match the conversation the model actually had: if the two drift, the
 * mismatch is invisible until a context looks wrong — usually several turns
 * later, and always as a confusing context rather than as a serialization bug.
 */
export function withToolCalls(text: string, calls: readonly ToolCallSummary[]): string {
	if (calls.length === 0) {
		return text;
	}
	return `${text}\n\n[tool calls: ${calls
		.map((call) => `${call.name}(${call.rawArguments})`)
		.join(', ')}]`;
}

/**
 * Result of skill discovery for a turn.
 */
interface SkillDiscoveryResult {
	/** Messages with skill instructions injected, if any. */
	readonly messages: ChatMessage[];
	/** IDs of skills that were loaded. */
	readonly loadedSkillIds: readonly string[];
	/** Skills explicitly requested but not found. */
	readonly missing?: readonly string[];
}

/**
 * Discovers relevant skills and injects their instructions into the message history.
 *
 * Skills are inserted as a system message before the conversation, using clear
 * delimiters to prevent instruction injection attacks.
 */
async function discoverSkills(
	hooks: AgentTurnHooks,
	messages: ChatMessage[],
): Promise<SkillDiscoveryResult> {
	// No discovery service available
	if (hooks.skillDiscovery === undefined) {
		return { messages, loadedSkillIds: [] };
	}

	// Find the user's message for this turn (last user message)
	const userMessage = hooks.userMessage ?? findLastUserMessage(messages);
	if (userMessage === undefined) {
		return { messages, loadedSkillIds: [] };
	}

	// Get available tool names
	const availableTools = hooks.tools.names();

	try {
		// Extract explicit skill requests from the user's message
		const { extractSkillRequests } = await import('../core/skill/skillDiscovery.js');
		const requestedSkillIds = extractSkillRequests(userMessage);

		// Discover relevant skills
		const discoveryResult = await hooks.skillDiscovery.discover({
			query: userMessage,
			maxSkills: 3,
			availableTools,
			requestedSkillIds: requestedSkillIds.length > 0 ? requestedSkillIds : undefined,
		});

		if (!discoveryResult.ok || discoveryResult.skills.length === 0) {
			return { messages, loadedSkillIds: [] };
		}

		// Load instructions
		const loadedInstructions = await hooks.skillDiscovery.loadInstructions(
			discoveryResult.skills,
		);

		if (loadedInstructions.skills.length === 0) {
			return { messages, loadedSkillIds: [] };
		}

		// Format as system message
		const skillMessage = hooks.skillDiscovery.formatAsSystemMessage(loadedInstructions);

		if (skillMessage.length === 0) {
			return { messages, loadedSkillIds: [] };
		}

		// As instruções de skill entram **na** mensagem `system` que já existe,
		// não numa segunda.
		//
		// Medido: o River, com o `Qwen/Qwen3.8-27B-FP8`, recusa qualquer
		// requisição com mais de uma mensagem `system` — `invalid_request`. Esta
		// injeção criava a segunda sempre que uma skill era carregada, então o
		// turno falhava só depois que a descoberta começava a achar skill: a
		// mesma conversa que respondia passava a não responder.
		const existingSystemIndex = messages.findIndex((m) => m.role === 'system');
		let injectedMessages: ChatMessage[];

		if (existingSystemIndex >= 0) {
			const existing = messages[existingSystemIndex];
			injectedMessages = [...messages];
			injectedMessages[existingSystemIndex] = {
				...existing,
				content:
					existing.content.trim().length === 0
						? skillMessage
						: `${existing.content}\n\n${skillMessage}`,
			};
		} else {
			injectedMessages = [{ role: 'system', content: skillMessage }, ...messages];
		}

		return {
			messages: injectedMessages,
			loadedSkillIds: loadedInstructions.skills.map((s) => s.id),
			missing: discoveryResult.missing,
		};
	} catch {
		// Discovery failed, continue without skills
		return { messages, loadedSkillIds: [] };
	}
}

/**
 * Finds the last user message in the conversation.
 */
function findLastUserMessage(messages: ChatMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === 'user') {
			return messages[i].content;
		}
	}
	return undefined;
}
