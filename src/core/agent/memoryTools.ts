/**
 * Memory tools for the agent.
 *
 * These tools let the model read, write, list, and delete memories
 * on behalf of the user. The user must explicitly request these operations;
 * the model never saves memories automatically.
 */
import type { AgentTool, ToolDescriptor, ToolExecutionContext, ToolResult } from './types';
import type { ToolSpec } from './toolRegistry';
import type { MemoryService, MemoryArea, CreateMemoryInput, UpdateMemoryInput } from '../memory/types';

/** Tool names. */
export const READ_MEMORY = 'read_memory';
export const WRITE_MEMORY = 'write_memory';
export const LIST_MEMORIES = 'list_memories';
export const DELETE_MEMORY = 'delete_memory';

/** Arguments for read_memory. */
export interface ReadMemoryArgs {
	readonly area: MemoryArea;
	readonly key: string;
	readonly projectId?: string;
}

/** Arguments for write_memory. */
export interface WriteMemoryArgs {
	readonly area: MemoryArea;
	readonly key?: string;
	readonly title: string;
	readonly content: string;
	readonly tags?: readonly string[];
	readonly projectId?: string;
}

/** Arguments for list_memories. */
export interface ListMemoriesArgs {
	readonly area: MemoryArea;
	readonly projectId?: string;
}

/** Arguments for delete_memory. */
export interface DeleteMemoryArgs {
	readonly area: MemoryArea;
	readonly key: string;
	readonly projectId?: string;
}

/** Result shape for read_memory tool. */
export interface ReadMemoryResult {
	readonly key: string;
	readonly title: string;
	readonly tags: readonly string[];
	readonly content: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly area: MemoryArea;
	readonly projectId?: string;
}

/** Result shape for write_memory tool. */
export interface WriteMemoryResult {
	readonly key: string;
	readonly title: string;
	readonly tags: readonly string[];
	readonly content: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly area: MemoryArea;
	readonly projectId?: string;
}

/** Result shape for list_memories tool. */
export interface ListMemoriesResult {
	readonly memories: readonly {
		readonly key: string;
		readonly title: string;
		readonly tags: readonly string[];
		readonly createdAt: string;
		readonly updatedAt: string;
		readonly area: MemoryArea;
		readonly projectId?: string;
	}[];
}

/** Result shape for delete_memory tool. */
export interface DeleteMemoryResult {
	readonly key: string;
	readonly deleted: boolean;
}

/**
 * Creates the read_memory tool.
 */
export function createReadMemoryTool(memoryService: MemoryService): AgentTool<ReadMemoryArgs, ReadMemoryResult> {
	const descriptor: ToolDescriptor = {
		id: READ_MEMORY,
		name: READ_MEMORY,
		category: 'memory',
		riskLevel: 'safe',
		description: 'Read a memory by its key. Use this when the user asks you to recall something they told you to remember.',
	};
	return {
		descriptor,
		async execute(input, _context): Promise<ToolResult<ReadMemoryResult>> {
			try {
				const area = input.area;
				const key = input.key;
				const projectId = input.projectId;

				if (!area || (area !== 'personal' && area !== 'projects')) {
					return { ok: false, error: 'Invalid area. Must be "personal" or "projects".' };
				}
				if (!key || typeof key !== 'string') {
					return { ok: false, error: 'Memory key is required.' };
				}

				const memory = await memoryService.getMemory(area, key, projectId);
				if (!memory) {
					return { ok: false, error: `Memory "${key}" not found in ${area}${projectId ? ` (project: ${projectId})` : ''}.` };
				}

				return {
					ok: true,
					output: {
						key: memory.key,
						title: memory.title,
						tags: memory.tags,
						content: memory.content,
						createdAt: memory.createdAt,
						updatedAt: memory.updatedAt,
						area: memory.area,
						projectId: memory.projectId,
					},
				};
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
	};
}

/**
 * Creates the write_memory tool.
 */
export function createWriteMemoryTool(memoryService: MemoryService): AgentTool<WriteMemoryArgs, WriteMemoryResult> {
	const descriptor: ToolDescriptor = {
		id: WRITE_MEMORY,
		name: WRITE_MEMORY,
		category: 'memory',
		riskLevel: 'moderate',
		description: 'Save a new memory. Use this when the user explicitly asks you to remember something. Do not save memories automatically.',
	};
	return {
		descriptor,
		async execute(input, _context): Promise<ToolResult<WriteMemoryResult>> {
			try {
				const area = input.area;
				const projectId = input.projectId;

				if (!area || (area !== 'personal' && area !== 'projects')) {
					return { ok: false, error: 'Invalid area. Must be "personal" or "projects".' };
				}
				if (area === 'projects' && !projectId) {
					return { ok: false, error: 'projectId is required for project memories.' };
				}
				if (!input.title || typeof input.title !== 'string') {
					return { ok: false, error: 'Title is required.' };
				}
				if (!input.content || typeof input.content !== 'string') {
					return { ok: false, error: 'Content is required.' };
				}

				const createInput: CreateMemoryInput = {
					area,
					projectId,
					key: input.key,
					title: input.title,
					content: input.content,
					tags: input.tags,
				};

				const result = await memoryService.createMemory(createInput);
				if (!result.ok) {
					return { ok: false, error: result.error };
				}

				return {
					ok: true,
					output: {
						key: result.memory!.key,
						title: result.memory!.title,
						tags: result.memory!.tags,
						content: result.memory!.content,
						createdAt: result.memory!.createdAt,
						updatedAt: result.memory!.updatedAt,
						area: result.memory!.area,
						projectId: result.memory!.projectId,
					},
				};
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
	};
}

/**
 * Creates the list_memories tool.
 */
export function createListMemoriesTool(memoryService: MemoryService): AgentTool<ListMemoriesArgs, ListMemoriesResult> {
	const descriptor: ToolDescriptor = {
		id: LIST_MEMORIES,
		name: LIST_MEMORIES,
		category: 'memory',
		riskLevel: 'safe',
		description: 'List all memories in an area. Use this when the user asks what they have asked you to remember.',
	};
	return {
		descriptor,
		async execute(input, _context): Promise<ToolResult<ListMemoriesResult>> {
			try {
				const area = input.area;
				const projectId = input.projectId;

				if (!area || (area !== 'personal' && area !== 'projects')) {
					return { ok: false, error: 'Invalid area. Must be "personal" or "projects".' };
				}
				if (area === 'projects' && !projectId) {
					return { ok: false, error: 'projectId is required for project memories.' };
				}

				const result = await memoryService.listMemories(area, projectId);
				if (!result.ok) {
					return { ok: false, error: result.error };
				}

				return {
					ok: true,
					output: {
						memories: result.memories.map((m) => ({
							key: m.key,
							title: m.title,
							tags: m.tags,
							createdAt: m.createdAt,
							updatedAt: m.updatedAt,
							area: m.area,
							projectId: m.projectId,
						})),
					},
				};
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
	};
}

/**
 * Creates the delete_memory tool.
 */
export function createDeleteMemoryTool(memoryService: MemoryService): AgentTool<DeleteMemoryArgs, DeleteMemoryResult> {
	const descriptor: ToolDescriptor = {
		id: DELETE_MEMORY,
		name: DELETE_MEMORY,
		category: 'memory',
		riskLevel: 'moderate',
		description: 'Delete a memory. Use this when the user explicitly asks you to forget something.',
	};
	return {
		descriptor,
		async execute(input, _context): Promise<ToolResult<DeleteMemoryResult>> {
			try {
				const area = input.area;
				const key = input.key;
				const projectId = input.projectId;

				if (!area || (area !== 'personal' && area !== 'projects')) {
					return { ok: false, error: 'Invalid area. Must be "personal" or "projects".' };
				}
				if (!key || typeof key !== 'string') {
					return { ok: false, error: 'Memory key is required.' };
				}
				if (area === 'projects' && !projectId) {
					return { ok: false, error: 'projectId is required for project memories.' };
				}

				const result = await memoryService.deleteMemory(area, key, projectId);
				if (!result.ok) {
					return { ok: false, error: result.error };
				}

				return {
					ok: true,
					output: {
						key,
						deleted: true,
					},
				};
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
	};
}

/** Specs for the memory tools. */
export const MEMORY_TOOL_SPECS: readonly ToolSpec[] = [
	{
		name: READ_MEMORY,
		description: 'Read a memory by its key. Use this when the user asks you to recall something they told you to remember.',
		parameters: {
			type: 'object',
			properties: {
				area: { type: 'string', enum: ['personal', 'projects'], description: 'Memory area: personal or projects' },
				key: { type: 'string', description: 'The memory key to read' },
				projectId: { type: 'string', description: 'Project ID (required when area is projects)' },
			},
			required: ['area', 'key'],
		},
		riskLevel: 'safe',
		category: 'memory',
	},
	{
		name: WRITE_MEMORY,
		description: 'Save a new memory. Use this when the user explicitly asks you to remember something. Do not save memories automatically.',
		parameters: {
			type: 'object',
			properties: {
				area: { type: 'string', enum: ['personal', 'projects'], description: 'Memory area: personal or projects' },
				key: { type: 'string', description: 'Optional custom key. If omitted, a slug from the title is used.' },
				title: { type: 'string', description: 'Human-readable title for the memory' },
				content: { type: 'string', description: 'The memory content (Markdown)' },
				tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for filtering' },
				projectId: { type: 'string', description: 'Project ID (required when area is projects)' },
			},
			required: ['area', 'title', 'content'],
		},
		riskLevel: 'moderate',
		category: 'memory',
	},
	{
		name: LIST_MEMORIES,
		description: 'List all memories in an area. Use this when the user asks what they have asked you to remember.',
		parameters: {
			type: 'object',
			properties: {
				area: { type: 'string', enum: ['personal', 'projects'], description: 'Memory area: personal or projects' },
				projectId: { type: 'string', description: 'Project ID (required when area is projects)' },
			},
			required: ['area'],
		},
		riskLevel: 'safe',
		category: 'memory',
	},
	{
		name: DELETE_MEMORY,
		description: 'Delete a memory. Use this when the user explicitly asks you to forget something.',
		parameters: {
			type: 'object',
			properties: {
				area: { type: 'string', enum: ['personal', 'projects'], description: 'Memory area: personal or projects' },
				key: { type: 'string', description: 'The memory key to delete' },
				projectId: { type: 'string', description: 'Project ID (required when area is projects)' },
			},
			required: ['area', 'key'],
		},
		riskLevel: 'moderate',
		category: 'memory',
	},
];

/** Creates all four memory tools. */
export function createMemoryTools(memoryService: MemoryService): readonly AgentTool[] {
	return [
		createReadMemoryTool(memoryService),
		createWriteMemoryTool(memoryService),
		createListMemoriesTool(memoryService),
		createDeleteMemoryTool(memoryService),
	];
}