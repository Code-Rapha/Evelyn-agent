/**
 * Agent boundary (Phase 1: interfaces/types only — the agent runtime is NOT
 * implemented yet).
 *
 * Architectural principle:
 *
 *   Model → Agent Runtime → Permission/Policy Engine → Tools → System
 *
 * The model must NEVER receive direct, unrestricted access to the filesystem,
 * terminal or git. All tool execution goes through the permission boundary
 * (see `src/permissions`) before reaching a concrete tool.
 */
import type { RiskLevel } from '../../permissions/types';

export type ToolCategory =
	| 'filesystem'
	| 'terminal'
	| 'git'
	| 'editor'
	| 'network'
	| 'other';

export interface ToolDescriptor {
	readonly id: string;
	readonly name: string;
	readonly category: ToolCategory;
	/** Risk classification consumed by the permission/policy engine. */
	readonly riskLevel: RiskLevel;
	readonly description?: string;
}

export interface ToolExecutionContext {
	readonly sessionId: string;
	readonly workingDirectory?: string;
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
export interface AgentRuntime {
	createSession(modelId?: string): Promise<AgentSession>;
	disposeSession(sessionId: string): Promise<void>;
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
