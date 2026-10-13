/**
 * Local filesystem/JSON implementation of the `DataStore` port.
 *
 * Layout under the storage root (default `~/.modelhub/seshyina`):
 *
 *   seshyina/
 *     projects.json            { "version": 1, "projects": [ … ] }
 *     conversations/
 *       <conversationId>.json  { …, "messages": [ … ] }
 *
 * One file per conversation, not one file for everything, because a transcript
 * is the only thing here that grows without bound: appending a message rewrites
 * one conversation's file and touches nothing else. Projects are few and always
 * read as a whole, so a single file is simpler than a directory.
 *
 * Consistency model: the adapter loads both indexes once and serializes every
 * write through one promise chain, so two concurrent callers cannot interleave a
 * read-modify-write and lose an append. Two *processes* against the same root
 * would still race; that is out of scope for a local-first product with one
 * window, and it is stated here rather than papered over.
 *
 * Corruption policy, per file type:
 *
 * - A *missing* file is an empty store. A first run must not fail.
 * - A *malformed* `projects.json` is treated as empty and rewritten on the next
 *   write. Losing a project list is recoverable; refusing to start is not.
 * - A *malformed* conversation file is skipped by `listConversations`, so one
 *   damaged transcript cannot hide the rest, and raises `StorageError` from
 *   `getConversation`, where the caller explicitly named that file. Damaged
 *   files are left on disk rather than deleted.
 *
 * No secret reaches this adapter: it stores projects, transcripts and non-secret
 * state only, and `assertNoSecretFields` refuses secret-shaped field names on
 * the way in.
 */
import { randomUUID } from 'node:crypto';
import { readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { StorageError, ValidationError } from '../../core/errors';
import type { ToolCallRequest } from '../../core/providers/chat/types';
import { writeFileAtomic } from './writeFileAtomic';
import {
	assertNoSecretFields,
	type AppendMessageInput,
	type ConversationMessage,
	type ConversationRecord,
	type ConversationRole,
	type ConversationSummary,
	type CreateConversationInput,
	type CreateProjectInput,
	type DataStore,
	type ProjectRecord,
	type UpdateProjectInput,
} from '../../core/storage/types/dataStore';
import { STORAGE_ROOT_NAME } from '../../core/storage/types';

/** File holding the project list. */
export const PROJECTS_FILE = 'projects.json';
/** Directory holding conversation transcripts. */
export const CONVERSATIONS_DIR = 'conversations';
/** Directory under the storage root that this adapter owns. */
export const DATA_DIR = 'seshyina';

/** Bumped when the on-disk shape changes incompatibly. */
const SCHEMA_VERSION = 1;

interface ProjectsFile {
	readonly version: number;
	readonly projects: readonly ProjectRecord[];
}

interface ConversationFile {
	readonly version: number;
	readonly id: string;
	readonly providerId?: string;
	readonly projectId?: string;
	readonly title: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly messages: readonly ConversationMessage[];
}

export interface FileDataStoreOptions {
	/**
	 * Root directory for the data. Defaults to `~/.modelhub/seshyina`.
	 *
	 * Absolute, and derived from `os.homedir()` rather than an env var, so a
	 * hostile `HOME` cannot redirect it. Tests pass an explicit temp path.
	 */
	readonly rootPath?: string;
	/** Injected in tests to make ids and timestamps predictable. */
	readonly generateId?: () => string;
	readonly now?: () => string;
}

export function defaultDataStoreRoot(): string {
	return join(homedir(), STORAGE_ROOT_NAME, DATA_DIR);
}

export class FileDataStore implements DataStore {
	private readonly root: string;
	private readonly generateId: () => string;
	private readonly now: () => string;

	/** Loaded lazily, so constructing the store touches no disk. */
	private projects: readonly ProjectRecord[] | undefined;
	/** Conversation metadata by id. Transcripts stay on disk until read. */
	private conversations: Map<string, ConversationSummary> | undefined;

	/** Serializes every write, so a read-modify-write cannot interleave. */
	private queue: Promise<unknown> = Promise.resolve();

	constructor(options: FileDataStoreOptions = {}) {
		this.root = options.rootPath ?? defaultDataStoreRoot();
		this.generateId = options.generateId ?? (() => randomUUID());
		this.now = options.now ?? (() => new Date().toISOString());
	}

	// ── projects ────────────────────────────────────────────────────────────

	async listProjects(): Promise<readonly ProjectRecord[]> {
		return (await this.loadProjects()).map((project) => ({ ...project }));
	}

	async getProject(projectId: string): Promise<ProjectRecord | undefined> {
		const found = (await this.loadProjects()).find((project) => project.id === projectId);
		return found === undefined ? undefined : { ...found };
	}

	async createProject(input: CreateProjectInput): Promise<ProjectRecord> {
		assertNoSecretFields(input, 'project');
		const name = requireText(input.name, 'name');
		const rootPath = requireText(input.rootPath, 'rootPath');
		return this.queueWrite(async () => {
			const current = await this.loadProjects();
			const id = input.id ?? this.generateId();
			if (current.some((project) => project.id === id)) {
				throw new ValidationError(`Project "${id}" already exists`, { details: { projectId: id } });
			}
			const timestamp = input.createdAt ?? this.now();
			const project: ProjectRecord = { id, name, rootPath, createdAt: timestamp, updatedAt: timestamp };
			await this.saveProjects([...current, project]);
			return { ...project };
		});
	}

	async updateProject(projectId: string, input: UpdateProjectInput): Promise<ProjectRecord> {
		assertNoSecretFields(input, 'project');
		const name = input.name !== undefined ? requireText(input.name, 'name') : undefined;
		const rootPath = input.rootPath !== undefined ? requireText(input.rootPath, 'rootPath') : undefined;
		return this.queueWrite(async () => {
			const current = await this.loadProjects();
			const existing = current.find((project) => project.id === projectId);
			if (existing === undefined) {
				throw new StorageError(`No project with id "${projectId}"`, { details: { projectId } });
			}
			const updated: ProjectRecord = {
				...existing,
				...(name !== undefined ? { name } : {}),
				...(rootPath !== undefined ? { rootPath } : {}),
				updatedAt: this.now(),
			};
			await this.saveProjects(
				current.map((project) => (project.id === projectId ? updated : project)),
			);
			return { ...updated };
		});
	}

	/**
	 * Removes a project and, by cascade, the conversations that belong to it.
	 *
	 * A transcript whose project no longer exists cannot be listed meaningfully,
	 * so it goes with the project rather than lingering as an orphan.
	 */
	async deleteProject(projectId: string): Promise<boolean> {
		return this.queueWrite(async () => {
			const current = await this.loadProjects();
			const next = current.filter((project) => project.id !== projectId);
			if (next.length === current.length) {
				return false;
			}
			await this.saveProjects(next);

			const conversations = await this.loadConversations();
			for (const summary of conversations.values()) {
				if (summary.projectId === projectId) {
					await this.removeConversationFile(summary.id);
				}
			}
			return true;
		});
	}

	// ── conversations ───────────────────────────────────────────────────────

	async listConversations(
		filter: { readonly providerId?: string; readonly projectId?: string } = {},
	): Promise<readonly ConversationSummary[]> {
		const all = [...(await this.loadConversations()).values()].sort(byCreation);
		const filtered = all.filter((summary) => {
			if (filter.providerId !== undefined && summary.providerId !== filter.providerId) {
				return false;
			}
			if (filter.projectId !== undefined && summary.projectId !== filter.projectId) {
				return false;
			}
			return true;
		});
		return filtered.map((summary) => ({ ...summary }));
	}

	async getConversation(conversationId: string): Promise<ConversationRecord | undefined> {
		await this.loadConversations();
		const file = await this.readConversationFile(conversationId);
		return file === undefined ? undefined : toRecord(file);
	}

	async createConversation(input: CreateConversationInput): Promise<ConversationRecord> {
		assertNoSecretFields(input, 'conversation');
		// Both are validated when present and dropped when absent, so the stored
		// record names only the bindings that actually exist.
		if (input.providerId !== undefined) {
			requireText(input.providerId, 'providerId', 'A conversation');
		}
		if (input.projectId !== undefined) {
			requireText(input.projectId, 'projectId', 'A conversation');
		}
		const timestamp = input.createdAt ?? this.now();
		const file: ConversationFile = {
			version: SCHEMA_VERSION,
			id: input.id ?? this.generateId(),
			...(input.providerId !== undefined ? { providerId: input.providerId } : {}),
			...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
			title: input.title !== undefined && input.title.length > 0 ? input.title : 'New conversation',
			createdAt: timestamp,
			updatedAt: timestamp,
			messages: [],
		};
		// The disk write joins the queue: a create racing a delete or an append
		// must land in order, or the summary index and the files disagree.
		// Nothing inside calls `queueWrite` again, so this cannot deadlock.
		return this.queueWrite(async () => {
			await this.saveConversationFile(file);
			return toRecord(file);
		});
	}

	async appendMessage(
		conversationId: string,
		input: AppendMessageInput,
	): Promise<ConversationMessage> {
		const [stored] = await this.appendMessages(conversationId, [input]);
		// Non-null by construction: `appendMessages` returns early on an empty
		// batch, and this one is never empty.
		return stored as ConversationMessage;
	}

	async appendMessages(
		conversationId: string,
		inputs: readonly AppendMessageInput[],
	): Promise<readonly ConversationMessage[]> {
		if (inputs.length === 0) {
			return [];
		}
		return this.queueWrite(async () => {
			const existing = await this.readConversationFile(conversationId);
			if (existing === undefined) {
				throw new StorageError(`No conversation with id "${conversationId}"`, {
					details: { conversationId },
				});
			}
			const appended = inputs.map((input, offset) =>
				this.toStoredMessage(input, existing.messages.length + offset),
			);
			// Checked on the *input*, not on the built message: the built record
			// carries only declared fields, so an extra `password` would already
			// have been dropped and the guard would never see it. Rejecting here
			// tells the caller their record was wrong instead of quietly storing
			// something other than what they passed.
			for (const input of inputs) {
				assertNoSecretFields(input, 'message');
			}
			await this.saveConversationFile({
				...existing,
				updatedAt: this.now(),
				messages: [...existing.messages, ...appended],
			});
			return appended.map((message) => ({ ...message }));
		});
	}

	async deleteConversation(conversationId: string): Promise<boolean> {
		// Inside the queue so the presence check and the removal are one step:
		// outside it, two concurrent deletes could both report `true`, and a
		// racing append could rewrite the file that was just removed. Nothing
		// inside calls `queueWrite` again, so this cannot deadlock.
		return this.queueWrite(async () => {
			await this.loadConversations();
			if (!this.conversations?.has(conversationId)) {
				return false;
			}
			await this.removeConversationFile(conversationId);
			return true;
		});
	}

	async renameConversation(conversationId: string, title: string): Promise<ConversationRecord> {
		const name = requireText(title, 'conversation title', 'A conversation');
		return this.queueWrite(async () => {
			const existing = await this.readConversationFile(conversationId);
			if (existing === undefined) {
				throw new StorageError(`No conversation with id "${conversationId}"`, {
					details: { conversationId },
				});
			}
			const renamed: ConversationFile = { ...existing, title: name, updatedAt: this.now() };
			await this.saveConversationFile(renamed);
			return toRecord(renamed);
		});
	}

	/**
	 * Replaces the conversation's single system message.
	 *
	 * Runs under the write lock and rewrites the whole transcript, so the
	 * resulting `seq` values stay contiguous from 0 — a system message spliced
	 * into the middle would otherwise leave the head of the file out of order.
	 *
	 * An empty string removes the prompt rather than storing a blank one: "send
	 * no instructions" and "send empty instructions" are different requests, and
	 * only the first is what a user clearing the field means.
	 */
	async setSystemPrompt(conversationId: string, content: string): Promise<ConversationRecord> {
		if (typeof content !== 'string') {
			throw new ValidationError('A system prompt must be a string', {
				details: { received: typeof content },
			});
		}
		return this.queueWrite(async () => {
			const existing = await this.readConversationFile(conversationId);
			if (existing === undefined) {
				throw new StorageError(`No conversation with id "${conversationId}"`, {
					details: { conversationId },
				});
			}

			// Drop every existing system message, not just the first: a transcript
			// written by an older version could hold more than one, and leaving
			// a second would send the model two different sets of instructions.
			const kept = existing.messages.filter((message) => message.role !== 'system');
			const prompt = content.trim();
			const next: readonly ConversationMessage[] =
				prompt.length === 0
					? kept
					: [
							{
								id: this.generateId(),
								seq: 0,
								role: 'system' as const,
								content: prompt,
								createdAt: this.now(),
							},
							...kept,
						];

			const updated: ConversationFile = {
				...existing,
				updatedAt: this.now(),
				// Re-numbered so `seq` stays a faithful position after the splice.
				messages: next.map((message, index) => ({ ...message, seq: index })),
			};
			await this.saveConversationFile(updated);
			return toRecord(updated);
		});
	}

	// ── persistence ─────────────────────────────────────────────────────────

	/** Serializes an operation against every other write. */
	private queueWrite<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.queue.then(operation, operation);
		// The chain itself must never reject, or every later write would be
		// skipped after the first failure.
		this.queue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	private async loadProjects(): Promise<readonly ProjectRecord[]> {
		if (this.projects !== undefined) {
			return this.projects;
		}
		const path = this.projectsPath();
		let raw: string;
		try {
			raw = await readFile(path, 'utf8');
		} catch (error) {
			if (isNotFound(error)) {
				if (this.projects === undefined) {
					this.projects = [];
				}
				return this.projects;
			}
			throw new StorageError(`Could not read the projects file at ${path}`, {
				cause: error,
				details: { path },
			});
		}
		const parsed = parseProjects(raw);
		// Only the first cold scan may claim the cache. A scan that read the
		// file before a concurrent `saveProjects` landed must not overwrite the
		// list that write had already updated — the next create would then read
		// the stale cache and write `projects.json` without the new project,
		// losing it for good.
		if (this.projects === undefined) {
			this.projects = parsed;
		}
		return this.projects;
	}

	private async saveProjects(projects: readonly ProjectRecord[]): Promise<void> {
		const path = this.projectsPath();
		const payload: ProjectsFile = { version: SCHEMA_VERSION, projects };
		try {
			await writeFileAtomic(path, `${JSON.stringify(payload, null, 2)}\n`);
		} catch (error) {
			throw new StorageError(`Could not write the projects file at ${path}`, {
				cause: error,
				details: { path },
			});
		}
		// The cache is updated only after the write lands, so a failed write
		// leaves memory consistent with what is actually on disk.
		this.projects = projects;
	}

	private async loadConversations(): Promise<ReadonlyMap<string, ConversationSummary>> {
		if (this.conversations !== undefined) {
			return this.conversations;
		}
		const dir = this.conversationsPath();
		let entries: string[];
		try {
			entries = await readdir(dir);
		} catch (error) {
			if (isNotFound(error)) {
				// Only the first scan to land claims the index: one that started
				// before a concurrent write finished must not overwrite the map
				// that write had already populated.
				if (this.conversations === undefined) {
					this.conversations = new Map();
				}
				return this.conversations;
			}
			throw new StorageError(`Could not read the conversations directory at ${dir}`, {
				cause: error,
				details: { path: dir },
			});
		}

		const summaries = new Map<string, ConversationSummary>();
		for (const entry of entries) {
			if (!entry.endsWith('.json')) {
				continue;
			}
			const file = await this.readConversationFile(entry.slice(0, -'.json'.length), 'skip');
			if (file !== undefined) {
				summaries.set(file.id, toSummary(file));
			}
		}
		// A cold scan can run while a queued write updates the index — the scan
		// read the directory before that write landed, and assigning its stale
		// snapshot afterwards would hide the conversation just stored.
		if (this.conversations === undefined) {
			this.conversations = summaries;
		}
		return this.conversations;
	}

	/**
	 * Reads one transcript.
	 *
	 * `mode: 'skip'` returns undefined for a damaged file (the listing path);
	 * otherwise the damage is reported, because the caller named that file.
	 */
	private async readConversationFile(
		conversationId: string,
		mode: 'skip' | 'throw' = 'throw',
	): Promise<ConversationFile | undefined> {
		const path = this.conversationPath(conversationId);
		let raw: string;
		try {
			raw = await readFile(path, 'utf8');
		} catch (error) {
			if (isNotFound(error)) {
				return undefined;
			}
			throw new StorageError(`Could not read the conversation file at ${path}`, {
				cause: error,
				details: { path },
			});
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (cause) {
			if (mode === 'skip') {
				return undefined;
			}
			throw new StorageError(`The conversation file at ${path} is not valid JSON`, {
				cause,
				details: { path },
			});
		}

		const file = toConversationFile(parsed);
		if (file === undefined && mode === 'throw') {
			throw new StorageError(`The conversation file at ${path} has an unusable shape`, {
				details: { path },
			});
		}
		return file;
	}

	private async saveConversationFile(file: ConversationFile): Promise<void> {
		// The index has to exist before it is written into. Seeding it here
		// with only the file being written made every conversation already on
		// disk invisible: `loadConversations` saw a populated map, never
		// scanned, and the sidebar lost everything until the app restarted.
		if (this.conversations === undefined) {
			await this.loadConversations();
		}
		const path = this.conversationPath(file.id);
		try {
			await writeFileAtomic(path, `${JSON.stringify(file, null, 2)}\n`);
		} catch (error) {
			throw new StorageError(`Could not write the conversation file at ${path}`, {
				cause: error,
				details: { path },
			});
		}
		this.conversations?.set(file.id, toSummary(file));
	}

	private async removeConversationFile(conversationId: string): Promise<void> {
		const path = this.conversationPath(conversationId);
		try {
			await rm(path, { force: true });
		} catch (error) {
			throw new StorageError(`Could not delete the conversation file at ${path}`, {
				cause: error,
				details: { path },
			});
		}
		this.conversations?.delete(conversationId);
	}

	/** Stamps id and timestamp, then validates role and content. */
	private toStoredMessage(input: AppendMessageInput, seq: number): ConversationMessage {
		if (!isRole(input.role)) {
			throw new ValidationError(`Unknown conversation role "${String(input.role)}"`, {
				details: { role: input.role },
			});
		}
		if (typeof input.content !== 'string') {
			throw new ValidationError('A message requires string content', {
				details: { received: typeof input.content },
			});
		}
		if (input.toolCallId !== undefined && typeof input.toolCallId !== 'string') {
			throw new ValidationError('toolCallId must be a string', {
				details: { received: typeof input.toolCallId },
			});
		}
		const toolCalls = toToolCalls(input.toolCalls, { strict: true });
		return {
			id: input.id ?? this.generateId(),
			seq,
			role: input.role,
			content: input.content,
			createdAt: input.createdAt ?? this.now(),
			...(input.toolCallId !== undefined ? { toolCallId: input.toolCallId } : {}),
			...(toolCalls !== undefined ? { toolCalls } : {}),
		};
	}

	private projectsPath(): string {
		return join(this.root, PROJECTS_FILE);
	}

	private conversationsPath(): string {
		return join(this.root, CONVERSATIONS_DIR);
	}

	/**
	 * Resolves a conversation id to a path inside the conversations directory.
	 *
	 * The id reaches here from callers and, on the listing path, from directory
	 * entries. Anything traversal-shaped is stripped, so `../../secrets` cannot
	 * address a file outside the directory.
	 */
	private conversationPath(conversationId: string): string {
		const safe = conversationId.split(/[\\/]/).pop() ?? '';
		if (safe.length === 0 || safe === '.' || safe === '..') {
			throw new ValidationError('A conversation id must be a plain file name', {
				details: { conversationId },
			});
		}
		return join(this.conversationsPath(), `${safe}.json`);
	}
}

// ── parsing and narrowing ──────────────────────────────────────────────────

/**
 * Reads the project list, degrading a damaged file to an empty list.
 *
 * Deliberately not an exception: an unreadable `projects.json` should cost the
 * user their project list, not their ability to launch. The file is left on disk
 * so a later recovery step can still inspect it.
 */
function parseProjects(raw: string): readonly ProjectRecord[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		return [];
	}
	const projects = (parsed as { projects?: unknown }).projects;
	if (!Array.isArray(projects)) {
		return [];
	}
	const seen = new Set<string>();
	const records: ProjectRecord[] = [];
	for (const entry of projects) {
		const record = toProjectRecord(entry);
		// Duplicate ids would make `getProject` depend on ordering; first wins.
		if (record === undefined || seen.has(record.id)) {
			continue;
		}
		seen.add(record.id);
		records.push(record);
	}
	return records;
}

function toProjectRecord(value: unknown): ProjectRecord | undefined {
	const candidate = asObject(value);
	if (candidate === undefined) {
		return undefined;
	}
	const { id, name, rootPath, createdAt, updatedAt } = candidate;
	if (
		typeof id !== 'string' ||
		id.length === 0 ||
		typeof name !== 'string' ||
		typeof rootPath !== 'string' ||
		typeof createdAt !== 'string' ||
		typeof updatedAt !== 'string'
	) {
		return undefined;
	}
	return { id, name, rootPath, createdAt, updatedAt };
}

/**
 * Narrowing read of a conversation file.
 *
 * Individual malformed messages are dropped rather than failing the whole file:
 * one bad entry should not cost the entire transcript.
 */
function toConversationFile(value: unknown): ConversationFile | undefined {
	const candidate = asObject(value);
	if (candidate === undefined) {
		return undefined;
	}
	const { id, title, createdAt, updatedAt, providerId, projectId } = candidate;
	if (
		typeof id !== 'string' ||
		id.length === 0 ||
		typeof title !== 'string' ||
		typeof createdAt !== 'string' ||
		typeof updatedAt !== 'string'
	) {
		return undefined;
	}
	const rawMessages = Array.isArray(candidate.messages) ? candidate.messages : [];
	return {
		version: typeof candidate.version === 'number' ? candidate.version : SCHEMA_VERSION,
		id,
		...(typeof providerId === 'string' && providerId.length > 0 ? { providerId } : {}),
		...(typeof projectId === 'string' && projectId.length > 0 ? { projectId } : {}),
		title,
		createdAt,
		updatedAt,
		messages: rawMessages
			.map((entry, index) => toConversationMessage(entry, index))
			.filter((entry): entry is ConversationMessage => entry !== undefined),
	};
}

function toConversationMessage(value: unknown, fallbackSeq: number): ConversationMessage | undefined {
	const candidate = asObject(value);
	if (candidate === undefined || typeof candidate.content !== 'string' || !isRole(candidate.role)) {
		return undefined;
	}
	// Tolerated rather than required: a transcript written before this field
	// existed still reads, it simply sends the assistant message without its
	// `tool_calls` — the same request the previous version sent.
	const toolCalls = toToolCalls(candidate.toolCalls);
	return {
		id: typeof candidate.id === 'string' ? candidate.id : `message-${fallbackSeq}`,
		seq: typeof candidate.seq === 'number' ? candidate.seq : fallbackSeq,
		role: candidate.role,
		content: candidate.content,
		createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : '',
		...(typeof candidate.toolCallId === 'string' ? { toolCallId: candidate.toolCallId } : {}),
		...(toolCalls !== undefined ? { toolCalls } : {}),
	};
}

/**
 * Narrows `toolCalls` to the only shape that can be replayed on the wire.
 *
 * Written side, this throws: storing a half-formed call would be a request
 * that fails several turns later, far from the mistake that made it. Read
 * side, a bad entry is dropped instead — one damaged message must not cost
 * the transcript.
 */
function toToolCalls(
	value: unknown,
	options: { readonly strict?: boolean } = {},
): readonly ToolCallRequest[] | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value)) {
		if (options.strict === true) {
			throw new ValidationError('toolCalls must be an array', {
				details: { received: typeof value },
			});
		}
		return undefined;
	}
	const calls: ToolCallRequest[] = [];
	for (const entry of value) {
		const call = asObject(entry);
		const id = call?.id;
		const name = call?.name;
		const args = call?.arguments;
		if (
			call === undefined ||
			typeof id !== 'string' ||
			id.length === 0 ||
			typeof name !== 'string' ||
			name.length === 0 ||
			typeof args !== 'string'
		) {
			if (options.strict === true) {
				throw new ValidationError('every toolCalls entry needs id, name and string arguments', {
					details: { entry },
				});
			}
			continue;
		}
		calls.push({ id, name, arguments: args });
	}
	return calls;
}

function toSummary(file: ConversationFile): ConversationSummary {
	return {
		id: file.id,
		...(file.providerId !== undefined ? { providerId: file.providerId } : {}),
		...(file.projectId !== undefined ? { projectId: file.projectId } : {}),
		title: file.title,
		createdAt: file.createdAt,
		updatedAt: file.updatedAt,
		messageCount: file.messages.length,
	};
}

function toRecord(file: ConversationFile): ConversationRecord {
	return {
		id: file.id,
		...(file.providerId !== undefined ? { providerId: file.providerId } : {}),
		...(file.projectId !== undefined ? { projectId: file.projectId } : {}),
		title: file.title,
		createdAt: file.createdAt,
		updatedAt: file.updatedAt,
		// Explicitly sorted: a caller must never have to know how the file was
		// written to get the transcript back in order.
		messages: [...file.messages].sort((a, b) => a.seq - b.seq).map((message) => ({ ...message })),
	};
}

/** Oldest first, with the id as tie-break so the ordering is total. */
function byCreation(a: ConversationSummary, b: ConversationSummary): number {
	return a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt);
}

function isRole(value: unknown): value is ConversationRole {
	return (
		value === 'system' || value === 'user' || value === 'assistant' || value === 'tool'
	);
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/**
 * Rejects blank text.
 *
 * `subject` names what the field belongs to, so the message reads "A project
 * requires…" for a project and "A conversation requires…" for a title, instead
 * of one of them being quietly wrong.
 */
function requireText(value: string, field: string, subject = 'A project'): string {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new ValidationError(`${subject} requires a non-empty ${field}`, {
			details: { field },
		});
	}
	return value;
}

function isNotFound(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		(error as { code?: string }).code === 'ENOENT'
	);
}

/** Removes the whole data directory. Used by tests and by a future "reset". */
export async function removeDataStore(rootPath: string): Promise<void> {
	try {
		await rm(rootPath, { recursive: true, force: true });
	} catch (error) {
		throw new StorageError(`Could not remove the data directory at ${rootPath}`, {
			cause: error,
			details: { path: rootPath },
		});
	}
}