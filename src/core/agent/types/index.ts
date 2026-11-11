/**
 * Agent boundary: the contracts the runtime is built from.
 *
 * Architectural principle:
 *
 *   Model → Agent Runtime → Permission/Policy Engine → Tools → System
 *
 * The model must NEVER receive direct, unrestricted access to the filesystem,
 * terminal or git. All tool execution goes through the permission boundary
 * (see `src/permissions`) before reaching a concrete tool.
 *
 * Nothing here names a concrete tool. `read_file` and friends are registered
 * implementations; the runtime only knows `AgentTool`, so adding a tool never
 * touches the runtime.
 */
import type { RiskLevel } from '../../permissions/types';

export type ToolCategory =
	| 'filesystem'
	| 'terminal'
	| 'git'
	| 'editor'
	| 'network'
	| 'memory'
	| 'other';

export interface ToolDescriptor {
	readonly id: string;
	readonly name: string;
	readonly category: ToolCategory;
	/** Risk classification consumed by the permission/policy engine. */
	readonly riskLevel: RiskLevel;
	readonly description?: string;
}

/**
 * One turn of the conversation as a tool sees it.
 *
 * A tool that reasons about what the conversation has been doing needs the
 * words and the tool calls, not the wire format's `tool_call_id` bookkeeping.
 * `toolResults` is paired by name with the calls of the same assistant turn.
 */
export interface ToolConversationTurn {
	readonly role: 'user' | 'assistant';
	readonly content: string;
	readonly toolCalls?: readonly { readonly name: string; readonly arguments: string }[];
	readonly toolResults?: readonly { readonly name: string; readonly output: string }[];
}

export interface ToolExecutionContext {
	readonly sessionId: string;
	readonly workingDirectory?: string;
	/**
	 * The tool IDs registered for this turn, when the host can supply them.
	 *
	 * A tool that reasons about what the product can do — the skill-opportunity
	 * analyzer — has to be told: the Core cannot import the registry that holds
	 * them without depending on one composition. Absent means "the caller did
	 * not say", which is reported as such rather than guessed at from a list
	 * kept in step by hand.
	 */
	readonly availableToolIds?: readonly string[];
	/**
	 * The transcript up to the moment the tool runs, when the host has one.
	 *
	 * A tool that only touches a file ignores it. One that analyzes the
	 * conversation — the skill-opportunity tool — cannot do its job without
	 * it, and inventing an empty history would make it answer "nothing found"
	 * no matter what the user actually did.
	 */
	readonly conversationTurns?: readonly ToolConversationTurn[];
	/**
	 * Present when the caller can cancel. A tool that blocks on I/O or on a
	 * child process should honour it; one that cannot stop early is not wrong,
	 * it just does not.
	 */
	readonly signal?: AbortSignal;
}

export interface ToolResult<TOutput = unknown> {
	readonly ok: boolean;
	readonly output?: TOutput;
	readonly error?: string;
}

/**
 * A tool is only callable through the agent runtime, which must consult the
 * permission engine before invoking `execute`.
 */
export interface AgentTool<TInput = unknown, TOutput = unknown> {
	readonly descriptor: ToolDescriptor;
	execute(input: TInput, context: ToolExecutionContext): Promise<ToolResult<TOutput>>;
}

export interface AgentSession {
	readonly id: string;
	readonly modelId?: string;
}

/**
 * Boundary between the AI model and tool execution. A future implementation
 * will orchestrate model calls, resolve tools, and enforce permissions.
 */
/**
 * What the agent reports while a turn runs.
 *
 * These are the events a future UI consumes. They are declared here, in the
 * Core, so the desktop app and any other host render the same conversation
 * without inventing their own vocabulary.
 */
export type AgentEvent =
	| { readonly type: 'TextDelta'; readonly text: string }
	/**
	 * The model's thinking phase, kept out of `TextDelta`.
	 *
	 * A host that folds this into the answer would persist the model's scratchpad
	 * as the user's message history, and the next turn would replay it as if the
	 * user had written it.
	 */
	| { readonly type: 'ReasoningDelta'; readonly text: string }
	| { readonly type: 'ToolCallRequested'; readonly call: ToolCall }
	| { readonly type: 'PermissionRequested'; readonly request: PermissionRequestSummary }
	| { readonly type: 'PermissionResolved'; readonly granted: boolean }
	/**
	 * `output` is the exact text the model was fed back for this call — a
	 * denial, a missing tool, malformed arguments and the tool's own result all
	 * arrive here, so a host replaying the conversation can show and persist
	 * what the model was actually told instead of guessing at the reason.
	 */
	| { readonly type: 'ToolCompleted'; readonly callId: string; readonly ok: boolean; readonly output: string }
	/**
	 * Uma ferramenta falhou de um jeito passageiro e vai ser tentada de novo.
	 *
	 * Existe para o host distinguir **espera** de **erro**: sem este evento, a
	 * diferença entre "rodando" e "vai falhar" seria só a demora.
	 */
	| {
			readonly type: 'ToolRetry';
			readonly callId: string;
			readonly toolName: string;
			readonly attempt: number;
			readonly of: number;
			readonly reason: string;
	  }
	| { readonly type: 'TurnCompleted'; readonly reason: CompletionReason }
	| { readonly type: 'TurnFailed'; readonly error: Error };

/** Why a turn ended. */
export type CompletionReason =
	/** The model produced a final answer with no tool calls left. */
	| 'answered'
	/** The turn budget was exhausted; the loop is stopped, not continued. */
	| 'maxTurns'
	/** The caller aborted the turn. */
	| 'aborted'
	/** The provider or a tool failed unrecoverably. */
	| 'error';

/** A tool call the model asked for, resolved to a registered tool. */
export interface ToolCall {
	readonly id: string;
	readonly name: string;
	/** Raw JSON arguments as sent by the model. */
	readonly rawArguments: string;
	/** Parsed arguments, or undefined when the model sent invalid JSON. */
	readonly arguments?: Readonly<Record<string, unknown>>;
	/** True when `rawArguments` could not be parsed as a JSON object. */
	readonly malformed: boolean;
}

/**
 * What the permission port is told, as carried by the runtime's own events.
 *
 * Mirrors `PermissionRequest` from `core/permissions/gateway` so a host can
 * render a prompt without importing the policy module, and so the event shape
 * cannot drift from what the gateway receives.
 */
export interface PermissionRequestSummary {
	readonly toolId: string;
	readonly toolName: string;
	readonly action: string;
	readonly description: string;
	readonly riskLevel: RiskLevel;
	/** Arguments with secret-looking values already redacted. */
	readonly arguments: Readonly<Record<string, unknown>>;
	/** The workspace the action would run in, when there is one. */
	readonly workspace?: string;
}

/** The runtime's own contract. Extends the original two-method shape. */
export interface AgentRuntime {
	createSession(modelId?: string): Promise<AgentSession>;
	disposeSession(sessionId: string): Promise<void>;
}

/** A cancellable stream of agent events for a single turn. */
export interface AgentTurn extends AsyncIterable<AgentEvent> {
	readonly completion: CompletionReason | 'running';
}

/**
 * Future tool surface (Phase 1: names only, no implementations):
 * read file, create file, modify file, delete file, move file,
 * create directory, execute command, run tests, git operations.
 */
export const PLANNED_TOOL_IDS = [
	'fs.read',
	'fs.create',
	'fs.modify',
	'fs.delete',
	'fs.move',
	'fs.createDirectory',
	'terminal.execute',
	'test.run',
	'git.operation',
] as const;

export type PlannedToolId = (typeof PLANNED_TOOL_IDS)[number];
