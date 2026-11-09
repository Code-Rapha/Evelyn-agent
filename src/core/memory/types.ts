/**
 * Memory system types.
 *
 * A memory is a named piece of information the user explicitly asked Evelyn to
 * remember. It is not a transcript, not a log, and not inferred — it is a
 * deliberate "remember this" from the user, stored as a Markdown file with a
 * small front-matter header.
 */
import type { StorageArea } from '../storage/types';

/** The two memory areas. Projects live under memory/projects/<projectId>/. */
export type MemoryArea = 'personal' | 'projects';

/** A single memory entry. */
export interface MemoryEntry {
	/** Unique key (filename without extension). */
	readonly key: string;
	/** Human-readable title. */
	readonly title: string;
	/** Free-form tags for filtering. */
	readonly tags: readonly string[];
	/** The memory content (Markdown). */
	readonly content: string;
	/** ISO timestamp when created. */
	readonly createdAt: string;
	/** ISO timestamp when last updated. */
	readonly updatedAt: string;
	/** The area this memory belongs to. */
	readonly area: MemoryArea;
	/** Project id when area is 'projects'. */
	readonly projectId?: string;
}

/** Input for creating a new memory. */
export interface CreateMemoryInput {
	/** The area to store in. */
	readonly area: MemoryArea;
	/** Project id (required when area is 'projects'). */
	readonly projectId?: string;
	/** Unique key. If omitted, a slug from the title is used. */
	readonly key?: string;
	/** Human-readable title. */
	readonly title: string;
	/** Free-form tags. */
	readonly tags?: readonly string[];
	/** The memory content (Markdown). */
	readonly content: string;
}

/** Input for updating an existing memory. */
export interface UpdateMemoryInput {
	/** The area the memory is in. */
	readonly area: MemoryArea;
	/** Project id (required when area is 'projects'). */
	readonly projectId?: string;
	/** The memory key to update. */
	readonly key: string;
	/** New title (optional). */
	readonly title?: string;
	/** New tags (optional). */
	readonly tags?: readonly string[];
	/** New content (optional). */
	readonly content?: string;
}

/** Result of a memory operation. */
export interface MemoryResult {
	readonly ok: boolean;
	readonly memory?: MemoryEntry;
	readonly error?: string;
}

/** Result of listing memories. */
export interface MemoryListResult {
	readonly ok: boolean;
	readonly memories: readonly MemoryEntry[];
	readonly error?: string;
}

/**
 * Service interface for memory operations.
 *
 * Implementations must:
 * - Validate inputs (no empty keys, no traversal, no secrets)
 * - Use atomic writes via the underlying StorageService
 * - Enforce area/project isolation
 * - Never store API keys, tokens, or credentials
 */
export interface MemoryService {
	/** Service identifier for ServiceContainer registration. */
	readonly id: string;
	/** Creates a new memory. */
	createMemory(input: CreateMemoryInput): Promise<MemoryResult>;
	/** Reads a memory by key. */
	getMemory(area: MemoryArea, key: string, projectId?: string): Promise<MemoryEntry | undefined>;
	/** Updates an existing memory. */
	updateMemory(input: UpdateMemoryInput): Promise<MemoryResult>;
	/** Deletes a memory. */
	deleteMemory(area: MemoryArea, key: string, projectId?: string): Promise<MemoryResult>;
	/** Lists all memories in an area (and optionally project). */
	listMemories(area: MemoryArea, projectId?: string): Promise<MemoryListResult>;
	/** Checks if a memory exists. */
	hasMemory(area: MemoryArea, key: string, projectId?: string): Promise<boolean>;
}