/**
 * Local filesystem implementation of SkillService using FileStorageService.
 *
 * Skills are stored as Markdown files with YAML front-matter:
 *
 *   ---
 *   title: "Code Review Skill"
 *   description: "Reviews code for best practices and bugs"
 *   version: "1.0.0"
 *   tags: ["review", "code-quality"]
 *   requiredTools: ["fs.read", "fs.modify"]
 *   riskLevel: "moderate"
 *   constraints: ["Only reviews TypeScript/JavaScript files"]
 *   createdAt: "2024-01-15T10:30:00.000Z"
 *   updatedAt: "2024-01-15T10:30:00.000Z"
 *   ---
 *
 *   # Code Review Skill
 *
 *   ## Purpose
 *   Review code changes for...
 *
 *   ## Instructions
 *   1. Read the changed files...
 *   2. Check for...
 *   3. Report findings...
 *
 * Files live under:
 *   skills/<skillId>.md
 */
import { randomUUID } from 'node:crypto';
import { StorageError, ValidationError } from '../errors';
import type { StorageService } from '../storage/types';
import type {
	RiskLevel,
} from '../permissions/types';
import type {
	SkillEntry,
	CreateSkillInput,
	UpdateSkillInput,
	SkillResult,
	SkillListResult,
	SkillService,
} from './types';

const SKILL_EXTENSION = '.md';
const FRONT_MATTER_DELIMITER = '---';

/**
 * Validates that a string is a valid skill ID.
 *
 * Rules:
 * - Non-empty
 * - No path separators
 * - No null bytes
 * - Reasonable length
 * - No reserved names
 */
function validateId(id: string, context: string): void {
	if (typeof id !== 'string' || id.trim().length === 0) {
		throw new ValidationError(`${context}: skill id must be a non-empty string`);
	}
	if (id.includes('/') || id.includes('\\')) {
		throw new ValidationError(`${context}: skill id cannot contain path separators`);
	}
	if (id.includes('\0')) {
		throw new ValidationError(`${context}: skill id cannot contain null bytes`);
	}
	if (id.length > 200) {
		throw new ValidationError(`${context}: skill id cannot exceed 200 characters`);
	}
	// Check for reserved Windows device names (without extension)
	const stem = id.split('.')[0]?.toLowerCase();
	const reserved = new Set([
		'con', 'prn', 'aux', 'nul',
		'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
		'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
	]);
	if (stem && reserved.has(stem)) {
		throw new ValidationError(`${context}: "${id}" is a reserved device name`);
	}
}

/**
 * Validates skill content fields.
 */
function validateTitle(title: string, context: string): void {
	if (typeof title !== 'string' || title.trim().length === 0) {
		throw new ValidationError(`${context}: skill title must be a non-empty string`);
	}
	if (title.length > 200) {
		throw new ValidationError(`${context}: skill title cannot exceed 200 characters`);
	}
}

function validateDescription(description: string, context: string): void {
	if (typeof description !== 'string' || description.trim().length === 0) {
		throw new ValidationError(`${context}: skill description must be a non-empty string`);
	}
	if (description.length > 500) {
		throw new ValidationError(`${context}: skill description cannot exceed 500 characters`);
	}
}

function validateVersion(version: string, context: string): void {
	if (typeof version !== 'string' || version.trim().length === 0) {
		throw new ValidationError(`${context}: skill version must be a non-empty string`);
	}
	// Basic semver validation
	const semverPattern = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;
	if (!semverPattern.test(version.trim())) {
		throw new ValidationError(`${context}: skill version must be a valid semantic version (e.g., "1.0.0")`);
	}
}

function validateInstructions(instructions: string, context: string): void {
	if (typeof instructions !== 'string') {
		throw new ValidationError(`${context}: skill instructions must be a string`);
	}
	if (instructions.trim().length === 0) {
		throw new ValidationError(`${context}: skill instructions cannot be empty`);
	}
	// No hard limit, but warn about very large content
	if (instructions.length > 200_000) {
		throw new ValidationError(`${context}: skill instructions exceed 200KB limit`);
	}
}

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

function validateRequiredTools(tools: readonly string[] | undefined, context: string): void {
	if (tools === undefined) {
		return;
	}
	if (!Array.isArray(tools)) {
		throw new ValidationError(`${context}: requiredTools must be an array`);
	}
	for (const tool of tools) {
		if (typeof tool !== 'string' || tool.trim().length === 0) {
			throw new ValidationError(`${context}: each required tool must be a non-empty string`);
		}
		if (tool.length > 100) {
			throw new ValidationError(`${context}: tool id "${tool}" exceeds 100 characters`);
		}
	}
}

function validateRiskLevel(riskLevel: RiskLevel | undefined, context: string): void {
	if (riskLevel === undefined) {
		return;
	}
	if (!['safe', 'moderate', 'dangerous'].includes(riskLevel)) {
		throw new ValidationError(`${context}: riskLevel must be "safe", "moderate", or "dangerous"`);
	}
}

function validateConstraints(constraints: readonly string[] | undefined, context: string): void {
	if (constraints === undefined) {
		return;
	}
	if (!Array.isArray(constraints)) {
		throw new ValidationError(`${context}: constraints must be an array`);
	}
	for (const constraint of constraints) {
		if (typeof constraint !== 'string' || constraint.trim().length === 0) {
			throw new ValidationError(`${context}: each constraint must be a non-empty string`);
		}
		if (constraint.length > 300) {
			throw new ValidationError(`${context}: constraint "${constraint}" exceeds 300 characters`);
		}
	}
}

/**
 * Generates a slug from a title for use as an ID.
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
 * Builds the storage path for a skill.
 */
function buildSkillPath(id: string): string {
	validateId(id, 'buildSkillPath');
	return `skills/${id}${SKILL_EXTENSION}`;
}

/**
 * The flat-JSON front-matter format, introduced after the hand-rolled one
 * corrupted skills.
 *
 * ## What was wrong with the previous format
 *
 * It wrote `tags: ["a", "b"]` and read it back with `split(',')`. A single tag
 * containing a comma — `"only TS, no JS"` — came back as two tags and, worse,
 * a constraint written with a comma was silently halved on the next read. The
 * quoting escaped only `"`, so a value beginning with `-`, `{` or a quote was
 * re-read as something else entirely.
 *
 * ## The format
 *
 * One `key: <JSON>` line per field. The value after `key: ` is parsed with
 * `JSON.parse`, so every string, array and escaping case is the language's
 * problem rather than this file's. A reader that cannot parse a line keeps the
 * field's default, which is the same behaviour a missing line already had.
 *
 * The Markdown body is unchanged, and the delimiters are unchanged, so a file
 * written by either version opens in both.
 */
const FRONT_MATTER_FIELDS = [
	'title',
	'description',
	'version',
	'tags',
	'requiredTools',
	'riskLevel',
	'constraints',
	'createdAt',
	'updatedAt',
] as const;

/** Reads one `key: <json>` line. `undefined` when the line is unusable. */
function readJsonField(line: string): { readonly key: string; readonly value: unknown } | undefined {
	const colonIndex = line.indexOf(':');
	if (colonIndex <= 0) {
		return undefined;
	}
	const key = line.slice(0, colonIndex).trim();
	const raw = line.slice(colonIndex + 1).trim();
	if (raw.length === 0) {
		return { key, value: undefined };
	}
	try {
		return { key, value: JSON.parse(raw) };
	} catch {
		return undefined;
	}
}

/**
 * Reads a legacy `key: "value"` or `key: [a, b]` line.
 *
 * Kept so a skill written before this change still opens. A JSON parse is tried
 * first — a legacy quoted string like `"Code Review"` is valid JSON and comes
 * back correct — and only an array or an unterminated string falls through to
 * the old splitting.
 */
function readLegacyField(
	line: string,
): { readonly key: string; readonly value: unknown } | undefined {
	const colonIndex = line.indexOf(':');
	if (colonIndex <= 0) {
		return undefined;
	}
	const key = line.slice(0, colonIndex).trim();
	const raw = line.slice(colonIndex + 1).trim();
	if (raw.length === 0) {
		return undefined;
	}
	const json = readJsonField(line);
	if (json !== undefined) {
		return json;
	}
	// An array in the old format: `[a, b]`, quoted or not.
	if (raw.startsWith('[') && raw.endsWith(']')) {
		const cleaned = raw.slice(1, -1).trim();
		return {
			key,
			value:
				cleaned.length === 0
					? []
					: cleaned.split(',').map((item) => item.trim().replace(/^["']|["']$/g, '')),
		};
	}
	return { key, value: raw.replace(/^["']|["']$/g, '') };
}

/** The delimiters a front-matter block can open with, in reading order. */
const FRONT_MATTER_OPENERS = [
	FRONT_MATTER_DELIMITER,
	// The YAML document marker some editors add. Accepted so a hand-written
	// skill copied from a YAML file is not read as one long body.
	'---yaml',
] as const;

/**
 * Parses a skill file with front-matter.
 *
 * Returns `undefined` only for a file with no readable front-matter at all —
 * the caller decides whether that is an empty skill or an error. A file whose
 * block opens but whose fields do not parse keeps the defaults, which is what
 * a truncated write looks like and is recoverable by rewriting the skill.
 */
function parseSkillFile(content: string, id: string): SkillEntry {
	const frontMatter: Record<string, unknown> = {};
	let body = content;

	const opener = FRONT_MATTER_OPENERS.find((candidate) => content.startsWith(candidate));
	if (opener !== undefined) {
		const endIndex = content.indexOf(FRONT_MATTER_DELIMITER, opener.length);
		if (endIndex !== -1) {
			const fmText = content.slice(opener.length, endIndex).trim();
			body = content.slice(endIndex + FRONT_MATTER_DELIMITER.length).trim();

			for (const line of fmText.split('\n')) {
				const trimmed = line.trim();
				if (trimmed.length === 0) {
					continue;
				}
				// The modern reader first: it is unambiguous. The legacy one
				// second, only for lines the modern one rejects.
				const field = readJsonField(trimmed) ?? readLegacyField(trimmed);
				if (field !== undefined) {
					frontMatter[field.key] = field.value;
				}
			}
		}
	}

	const now = new Date().toISOString();
	const strings = (value: unknown): readonly string[] =>
		Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
	return {
		id,
		title: typeof frontMatter['title'] === 'string' ? frontMatter['title'] : id,
		description: typeof frontMatter['description'] === 'string' ? frontMatter['description'] : '',
		version: typeof frontMatter['version'] === 'string' ? frontMatter['version'] : '1.0.0',
		tags: strings(frontMatter['tags']),
		requiredTools: strings(frontMatter['requiredTools']),
		instructions: body,
		riskLevel: isRiskLevel(frontMatter['riskLevel']) ? frontMatter['riskLevel'] : 'moderate',
		constraints: strings(frontMatter['constraints']),
		createdAt: typeof frontMatter['createdAt'] === 'string' ? frontMatter['createdAt'] : now,
		updatedAt: typeof frontMatter['updatedAt'] === 'string' ? frontMatter['updatedAt'] : now,
	};
}

/** Whether a parsed value is one of the three risk levels. */
function isRiskLevel(value: unknown): value is RiskLevel {
	return value === 'safe' || value === 'moderate' || value === 'dangerous';
}

/**
 * Serializes a skill entry to a file with front-matter.
 *
 * `JSON.stringify` per field, so a value containing a newline, a comma, a
 * quote or a leading dash round-trips exactly. The order is fixed because a
 * file whose fields move on every save is a file nobody can diff.
 */
function serializeSkillFile(entry: SkillEntry): string {
	const fields: Record<(typeof FRONT_MATTER_FIELDS)[number], unknown> = {
		title: entry.title,
		description: entry.description,
		version: entry.version,
		tags: entry.tags,
		requiredTools: entry.requiredTools,
		riskLevel: entry.riskLevel,
		constraints: entry.constraints ?? [],
		createdAt: entry.createdAt,
		updatedAt: entry.updatedAt,
	};
	const lines: string[] = [FRONT_MATTER_DELIMITER];
	for (const field of FRONT_MATTER_FIELDS) {
		lines.push(`${field}: ${JSON.stringify(fields[field])}`);
	}
	lines.push(FRONT_MATTER_DELIMITER, '', entry.instructions);
	return lines.join('\n');
}

export class FileSkillService implements SkillService {
	readonly id = 'skill';

	constructor(private readonly storage: StorageService) {}

	async createSkill(input: CreateSkillInput): Promise<SkillResult> {
		try {
			validateTitle(input.title, 'createSkill');
			validateDescription(input.description, 'createSkill');
			validateVersion(input.version ?? '1.0.0', 'createSkill');
			validateInstructions(input.instructions, 'createSkill');
			validateTags(input.tags, 'createSkill');
			validateRequiredTools(input.requiredTools, 'createSkill');
			validateRiskLevel(input.riskLevel, 'createSkill');
			validateConstraints(input.constraints, 'createSkill');

			const id = input.id?.trim() ?? slugify(input.title);
			validateId(id, 'createSkill');

			const path = buildSkillPath(id);

			// Check if already exists
			if (await this.storage.exists(path)) {
				return { ok: false, error: `Skill "${id}" already exists` };
			}

			const now = new Date().toISOString();
			const entry: SkillEntry = {
				id,
				title: input.title.trim(),
				description: input.description.trim(),
				version: (input.version ?? '1.0.0').trim(),
				tags: input.tags ?? [],
				requiredTools: input.requiredTools ?? [],
				instructions: input.instructions,
				riskLevel: input.riskLevel ?? 'moderate',
				constraints: input.constraints ?? [],
				createdAt: now,
				updatedAt: now,
			};

			await this.storage.write(path, serializeSkillFile(entry));
			return { ok: true, skill: entry };
		} catch (error: unknown) {
			if (error instanceof ValidationError) {
				return { ok: false, error: error.message };
			}
			const message = error instanceof Error ? error.message : String(error);
			return { ok: false, error: message };
		}
	}

	async getSkill(id: string): Promise<SkillEntry | undefined> {
		try {
			validateId(id, 'getSkill');

			const path = buildSkillPath(id);
			const content = await this.storage.read(path);
			if (content === undefined) {
				return undefined;
			}
			return parseSkillFile(content, id);
		} catch (error: unknown) {
			if (error instanceof ValidationError) {
				return undefined;
			}
			const cause = error instanceof Error ? error : new Error(String(error));
			throw new StorageError(`Could not read skill "${id}"`, {
				cause,
				details: { id },
			});
		}
	}

	async updateSkill(input: UpdateSkillInput): Promise<SkillResult> {
		try {
			validateId(input.id, 'updateSkill');

			if (input.title !== undefined) {
				validateTitle(input.title, 'updateSkill');
			}
			if (input.description !== undefined) {
				validateDescription(input.description, 'updateSkill');
			}
			if (input.version !== undefined) {
				validateVersion(input.version, 'updateSkill');
			}
			if (input.instructions !== undefined) {
				validateInstructions(input.instructions, 'updateSkill');
			}
			if (input.tags !== undefined) {
				validateTags(input.tags, 'updateSkill');
			}
			if (input.requiredTools !== undefined) {
				validateRequiredTools(input.requiredTools, 'updateSkill');
			}
			if (input.riskLevel !== undefined) {
				validateRiskLevel(input.riskLevel, 'updateSkill');
			}
			if (input.constraints !== undefined) {
				validateConstraints(input.constraints, 'updateSkill');
			}

			const path = buildSkillPath(input.id);
			const existing = await this.storage.read(path);
			if (existing === undefined) {
				return { ok: false, error: `Skill "${input.id}" not found` };
			}

			const current = parseSkillFile(existing, input.id);
			const now = new Date().toISOString();

			const updated: SkillEntry = {
				...current,
				...(input.title !== undefined ? { title: input.title.trim() } : {}),
				...(input.description !== undefined ? { description: input.description.trim() } : {}),
				...(input.version !== undefined ? { version: input.version.trim() } : {}),
				...(input.tags !== undefined ? { tags: input.tags } : {}),
				...(input.requiredTools !== undefined ? { requiredTools: input.requiredTools } : {}),
				...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
				...(input.riskLevel !== undefined ? { riskLevel: input.riskLevel } : {}),
				...(input.constraints !== undefined ? { constraints: input.constraints } : {}),
				updatedAt: now,
			};

			await this.storage.write(path, serializeSkillFile(updated));
			return { ok: true, skill: updated };
		} catch (error: unknown) {
			if (error instanceof ValidationError) {
				return { ok: false, error: error.message };
			}
			const message = error instanceof Error ? error.message : String(error);
			return { ok: false, error: message };
		}
	}

	async deleteSkill(id: string): Promise<SkillResult> {
		try {
			validateId(id, 'deleteSkill');

			const path = buildSkillPath(id);
			const exists = await this.storage.exists(path);
			if (!exists) {
				return { ok: false, error: `Skill "${id}" not found` };
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

	async listSkills(): Promise<SkillListResult> {
		try {
			const dirPath = 'skills';
			const entries = await this.storage.list(dirPath);

			const skills: SkillEntry[] = [];
			for (const name of entries) {
				if (!name.endsWith(SKILL_EXTENSION)) {
					continue;
				}
				const id = name.slice(0, -SKILL_EXTENSION.length);
				const content = await this.storage.read(`${dirPath}/${name}`);
				if (content !== undefined) {
					skills.push(parseSkillFile(content, id));
				}
			}

			// Sort by updatedAt descending (most recent first)
			skills.sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1));

			return { ok: true, skills };
		} catch (error) {
			if (error instanceof ValidationError) {
				return { ok: false, skills: [], error: error.message };
			}
			return { ok: false, skills: [], error: error instanceof Error ? error.message : String(error) };
		}
	}

	async hasSkill(id: string): Promise<boolean> {
		try {
			validateId(id, 'hasSkill');
			const path = buildSkillPath(id);
			return this.storage.exists(path);
		} catch {
			return false;
		}
	}

	async findSkillsByTag(tag: string): Promise<SkillListResult> {
		try {
			if (typeof tag !== 'string' || tag.trim().length === 0) {
				return { ok: false, skills: [], error: 'Tag must be a non-empty string' };
			}
			const result = await this.listSkills();
			if (!result.ok) {
				return result;
			}
			const filtered = result.skills.filter((skill) =>
				skill.tags.some((t) => t.toLowerCase() === tag.toLowerCase())
			);
			return { ok: true, skills: filtered };
		} catch (error) {
			return { ok: false, skills: [], error: error instanceof Error ? error.message : String(error) };
		}
	}

	async findSkillsByTool(toolId: string): Promise<SkillListResult> {
		try {
			if (typeof toolId !== 'string' || toolId.trim().length === 0) {
				return { ok: false, skills: [], error: 'Tool ID must be a non-empty string' };
			}
			const result = await this.listSkills();
			if (!result.ok) {
				return result;
			}
			const filtered = result.skills.filter((skill) =>
				skill.requiredTools.some((t) => t === toolId)
			);
			return { ok: true, skills: filtered };
		} catch (error) {
			return { ok: false, skills: [], error: error instanceof Error ? error.message : String(error) };
		}
	}
}

/**
 * Creates a FileSkillService with the given StorageService.
 */
export function createFileSkillService(storage: StorageService): SkillService {
	return new FileSkillService(storage);
}