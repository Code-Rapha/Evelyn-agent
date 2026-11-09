/**
 * Local filesystem implementation of MemoryService using FileStorageService.
 *
 * Memories are stored as Markdown files with YAML front-matter:
 *
 *   ---
 *   title: "My preference"
 *   tags: ["preference", "ui"]
 *   createdAt: "2024-01-15T10:30:00.000Z"
 *   updatedAt: "2024-01-15T10:30:00.000Z"
 *   ---
 *
 *   The actual content goes here.
 *
 * Files live under:
 *   memory/personal/<key>.md           (personal memories)
 *   memory/projects/<projectId>/<key>.md  (project memories)
 */
import { randomUUID } from 'node:crypto';
import { StorageError, ValidationError } from '../errors';
import type { StorageService } from '../storage/types';
import type {
	MemoryArea,
	MemoryEntry,
	CreateMemoryInput,
	UpdateMemoryInput,
	MemoryResult,
	MemoryListResult,
	MemoryService,
} from './types';

const MEMORY_EXTENSION = '.md';
const FRONT_MATTER_DELIMITER = '---';

/**
 * Validates that a string is a valid memory key.
 *
 * Rules:
 * - Non-empty
 * - No path separators
 * - No null bytes
 * - Reasonable length
 * - No reserved names
 */
function validateKey(key: string, context: string): void {
	if (typeof key !== 'string' || key.trim().length === 0) {
		throw new ValidationError(`${context}: memory key must be a non-empty string`);
	}
	if (key.includes('/') || key.includes('\\')) {
		throw new ValidationError(`${context}: memory key cannot contain path separators`);
	}
	if (key.includes('\0')) {
		throw new ValidationError(`${context}: memory key cannot contain null bytes`);
	}
	if (key.length > 200) {
		throw new ValidationError(`${context}: memory key cannot exceed 200 characters`);
	}
	// Check for reserved Windows device names (without extension)
	const stem = key.split('.')[0]?.toLowerCase();
	const reserved = new Set([
		'con', 'prn', 'aux', 'nul',
		'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
		'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
	]);
	if (stem && reserved.has(stem)) {
		throw new ValidationError(`${context}: "${key}" is a reserved device name`);
	}
}

/**
 * Validates that a string looks like a valid project id.
 */
function validateProjectId(projectId: string | undefined, area: MemoryArea, context: string): void {
	if (area === 'projects') {
		if (!projectId || projectId.trim().length === 0) {
			throw new ValidationError(`${context}: projectId is required for project memories`);
		}
		if (projectId.includes('/') || projectId.includes('\\')) {
			throw new ValidationError(`${context}: projectId cannot contain path separators`);
		}
	}
}

/**
 * Validates memory content.
 */
function validateContent(content: string, context: string): void {
	if (typeof content !== 'string') {
		throw new ValidationError(`${context}: memory content must be a string`);
	}
	if (content.trim().length === 0) {
		throw new ValidationError(`${context}: memory content cannot be empty`);
	}
	// No hard limit, but warn about very large content
	if (content.length > 100_000) {
		throw new ValidationError(`${context}: memory content exceeds 100KB limit`);
	}
}

/**
 * Validates title.
 */
function validateTitle(title: string, context: string): void {
	if (typeof title !== 'string' || title.trim().length === 0) {
		throw new ValidationError(`${context}: memory title must be a non-empty string`);
	}
	if (title.length > 200) {
		throw new ValidationError(`${context}: memory title cannot exceed 200 characters`);
	}
}

/**
 * Validates tags.
 */
function validateTags(tags: readonly string[] | undefined, context: string): void {
	if (tags === undefined) {
		return;
	}
	if (!Array.isArray(tags)) {
		throw new ValidationError(`${context}: tags must be an array`);
	}
	for (const tag of tags) {
		if (typeof tag !== 'string' || tag.trim().length === 0) {
			throw new ValidationError(`${context}: each tag must be a non-empty string`);
		}
		if (tag.length > 50) {
			throw new ValidationError(`${context}: tag "${tag}" exceeds 50 characters`);
		}
	}
}

/**
 * Generates a slug from a title for use as a key.
 */
function slugify(title: string): string {
	return title
		.toLowerCase()
		.trim()
		.replace(/[^\w\s-]/g, '')
		.replace(/[\s_-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 200);
}

/**
 * Builds the storage path for a memory.
 */
function buildMemoryPath(area: MemoryArea, key: string, projectId?: string): string {
	validateKey(key, 'buildMemoryPath');
	validateProjectId(projectId, area, 'buildMemoryPath');

	if (area === 'personal') {
		return `memory/personal/${key}${MEMORY_EXTENSION}`;
	}
	// projects
	return `memory/projects/${projectId}/${key}${MEMORY_EXTENSION}`;
}

/**
 * Builds the directory path for listing memories.
 */
function buildMemoryDirPath(area: MemoryArea, projectId?: string): string {
	validateProjectId(projectId, area, 'buildMemoryDirPath');

	if (area === 'personal') {
		return 'memory/personal';
	}
	return `memory/projects/${projectId}`;
}

/**
 * Parses a memory file with front-matter.
 */
function parseMemoryFile(content: string, key: string, area: MemoryArea, projectId?: string): MemoryEntry {
	let frontMatter: Record<string, unknown> = {};
	let body = content;

	if (content.startsWith(FRONT_MATTER_DELIMITER)) {
		const endIndex = content.indexOf(FRONT_MATTER_DELIMITER, FRONT_MATTER_DELIMITER.length);
		if (endIndex !== -1) {
			const fmText = content.slice(FRONT_MATTER_DELIMITER.length, endIndex).trim();
			body = content.slice(endIndex + FRONT_MATTER_DELIMITER.length).trim();

			// Simple YAML-like parsing for our known fields
			for (const line of fmText.split('\n')) {
				const colonIndex = line.indexOf(':');
				if (colonIndex === -1) {
					continue;
				}
				const field = line.slice(0, colonIndex).trim();
				const value = line.slice(colonIndex + 1).trim();
				if (field === 'tags') {
					// Parse array: [tag1, tag2] or tag1, tag2
					const cleaned = value.replace(/^\[|\]$/g, '').trim();
					if (cleaned.length > 0) {
						frontMatter.tags = cleaned.split(',').map((t) => t.trim().replace(/^["']|["']$/g, ''));
					} else {
						frontMatter.tags = [];
					}
				} else {
					frontMatter[field] = value.replace(/^["']|["']$/g, '');
				}
			}
		}
	}

	const now = new Date().toISOString();
	return {
		key,
		title: (frontMatter.title as string) ?? key,
		tags: (frontMatter.tags as string[]) ?? [],
		content: body,
		createdAt: (frontMatter.createdAt as string) ?? now,
		updatedAt: (frontMatter.updatedAt as string) ?? now,
		area,
		...(projectId !== undefined ? { projectId } : {}),
	};
}

/**
 * Serializes a memory entry to a file with front-matter.
 */
function serializeMemoryFile(entry: MemoryEntry): string {
	const lines = [
		FRONT_MATTER_DELIMITER,
		`title: "${entry.title.replace(/"/g, '\\"')}"`,
		`tags: [${entry.tags.map((t) => `"${t.replace(/"/g, '\\"')}"`).join(', ')}]`,
		`createdAt: "${entry.createdAt}"`,
		`updatedAt: "${entry.updatedAt}"`,
		FRONT_MATTER_DELIMITER,
		'',
		entry.content,
	];
	return lines.join('\n');
}

export class FileMemoryService implements MemoryService {
	readonly id = 'memory';

	constructor(private readonly storage: StorageService) {}

	async createMemory(input: CreateMemoryInput): Promise<MemoryResult> {
		try {
			validateProjectId(input.projectId, input.area, 'createMemory');
			validateTitle(input.title, 'createMemory');
			validateContent(input.content, 'createMemory');
			validateTags(input.tags, 'createMemory');

			const key = input.key?.trim() ?? slugify(input.title);
			validateKey(key, 'createMemory');

			const path = buildMemoryPath(input.area, key, input.projectId);

			// Check if already exists
			if (await this.storage.exists(path)) {
				return { ok: false, error: `Memory "${key}" already exists in ${input.area}` };
			}

			const now = new Date().toISOString();
			const entry: MemoryEntry = {
				key,
				title: input.title.trim(),
				tags: input.tags ?? [],
				content: input.content,
				createdAt: now,
				updatedAt: now,
				area: input.area,
				...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
			};

			await this.storage.write(path, serializeMemoryFile(entry));
			return { ok: true, memory: entry };
		} catch (error: unknown) {
			if (error instanceof ValidationError) {
				return { ok: false, error: error.message };
			}
			const message = error instanceof Error ? error.message : String(error);
			return { ok: false, error: message };
		}
	}

	async getMemory(area: MemoryArea, key: string, projectId?: string): Promise<MemoryEntry | undefined> {
		try {
			validateKey(key, 'getMemory');
			validateProjectId(projectId, area, 'getMemory');

			const path = buildMemoryPath(area, key, projectId);
			const content = await this.storage.read(path);
			if (content === undefined) {
				return undefined;
			}
			return parseMemoryFile(content, key, area, projectId);
		} catch (error: unknown) {
			if (error instanceof ValidationError) {
				return undefined;
			}
			const cause = error instanceof Error ? error : new Error(String(error));
			throw new StorageError(`Could not read memory "${key}"`, {
				cause,
				details: { area, key, projectId },
			});
		}
	}

	async updateMemory(input: UpdateMemoryInput): Promise<MemoryResult> {
		try {
			validateProjectId(input.projectId, input.area, 'updateMemory');
			validateKey(input.key, 'updateMemory');

			if (input.title !== undefined) {
				validateTitle(input.title, 'updateMemory');
			}
			if (input.content !== undefined) {
				validateContent(input.content, 'updateMemory');
			}
			if (input.tags !== undefined) {
				validateTags(input.tags, 'updateMemory');
			}

			const path = buildMemoryPath(input.area, input.key, input.projectId);
			const existing = await this.storage.read(path);
			if (existing === undefined) {
				return { ok: false, error: `Memory "${input.key}" not found` };
			}

			const current = parseMemoryFile(existing, input.key, input.area, input.projectId);
			const now = new Date().toISOString();

			const updated: MemoryEntry = {
				...current,
				...(input.title !== undefined ? { title: input.title.trim() } : {}),
				...(input.tags !== undefined ? { tags: input.tags } : {}),
				...(input.content !== undefined ? { content: input.content } : {}),
				updatedAt: now,
			};

			await this.storage.write(path, serializeMemoryFile(updated));
			return { ok: true, memory: updated };
		} catch (error: unknown) {
			if (error instanceof ValidationError) {
				return { ok: false, error: error.message };
			}
			const message = error instanceof Error ? error.message : String(error);
			return { ok: false, error: message };
		}
	}

	async deleteMemory(area: MemoryArea, key: string, projectId?: string): Promise<MemoryResult> {
		try {
			validateKey(key, 'deleteMemory');
			validateProjectId(projectId, area, 'deleteMemory');

			const path = buildMemoryPath(area, key, projectId);
			const exists = await this.storage.exists(path);
			if (!exists) {
				return { ok: false, error: `Memory "${key}" not found` };
			}

			await this.storage.delete(path);
			return { ok: true };
		} catch (error: unknown) {
			if (error instanceof ValidationError) {
				return { ok: false, error: error.message };
			}
			const message = error instanceof Error ? error.message : String(error);
			return { ok: false, error: message };
		}
	}

	async listMemories(area: MemoryArea, projectId?: string): Promise<MemoryListResult> {
		try {
			validateProjectId(projectId, area, 'listMemories');

			const dirPath = buildMemoryDirPath(area, projectId);
			const entries = await this.storage.list(dirPath);

			const memories: MemoryEntry[] = [];
			for (const name of entries) {
				if (!name.endsWith(MEMORY_EXTENSION)) {
					continue;
				}
				const key = name.slice(0, -MEMORY_EXTENSION.length);
				const content = await this.storage.read(`${dirPath}/${name}`);
				if (content !== undefined) {
					memories.push(parseMemoryFile(content, key, area, projectId));
				}
			}

			// Sort by updatedAt descending (most recent first)
			memories.sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1));

			return { ok: true, memories };
		} catch (error) {
			if (error instanceof ValidationError) {
				return { ok: false, memories: [], error: error.message };
			}
			return { ok: false, memories: [], error: error instanceof Error ? error.message : String(error) };
		}
	}

	async hasMemory(area: MemoryArea, key: string, projectId?: string): Promise<boolean> {
		try {
			validateKey(key, 'hasMemory');
			validateProjectId(projectId, area, 'hasMemory');
			const path = buildMemoryPath(area, key, projectId);
			return this.storage.exists(path);
		} catch {
			return false;
		}
	}
}

/**
 * Creates a FileMemoryService with the given StorageService.
 */
export function createFileMemoryService(storage: StorageService): MemoryService {
	return new FileMemoryService(storage);
}