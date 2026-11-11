/**
 * Skill system types.
 *
 * A skill is a reusable, versioned package of instructions, required tools,
 * and constraints that the agent can load to perform a specific task.
 * Skills are stored as Markdown files with YAML front-matter, similar to memories.
 *
 * Files live under:
 *   skills/<skillId>.md           (global/personal skills)
 */
import type { RiskLevel } from '../permissions/types';

/** A single skill entry. */
export interface SkillEntry {
	/** Unique identifier (filename without extension). */
	readonly id: string;
	/** Human-readable title. */
	readonly title: string;
	/** Brief description of what the skill does. */
	readonly description: string;
	/** Semantic version (e.g., "1.0.0"). */
	readonly version: string;
	/** Free-form tags for filtering and discovery. */
	readonly tags: readonly string[];
	/** List of tool IDs this skill requires to function. */
	readonly requiredTools: readonly string[];
	/** The skill instructions (Markdown). */
	readonly instructions: string;
	/** Risk level this skill operates at. */
	readonly riskLevel: RiskLevel;
	/** Constraints or limitations of this skill. */
	readonly constraints?: readonly string[];
	/** ISO timestamp when created. */
	readonly createdAt: string;
	/** ISO timestamp when last updated. */
	readonly updatedAt: string;
}

/** Input for creating a new skill. */
export interface CreateSkillInput {
	/** Unique identifier. If omitted, a slug from the title is used. */
	readonly id?: string;
	/** Human-readable title. */
	readonly title: string;
	/** Brief description of what the skill does. */
	readonly description: string;
	/** Semantic version (e.g., "1.0.0"). Defaults to "1.0.0". */
	readonly version?: string;
	/** Free-form tags for filtering. */
	readonly tags?: readonly string[];
	/** List of tool IDs this skill requires. */
	readonly requiredTools?: readonly string[];
	/** The skill instructions (Markdown). */
	readonly instructions: string;
	/** Risk level this skill operates at. Defaults to "moderate". */
	readonly riskLevel?: RiskLevel;
	/** Constraints or limitations of this skill. */
	readonly constraints?: readonly string[];
}

/** Input for updating an existing skill. */
export interface UpdateSkillInput {
	/** The skill ID to update. */
	readonly id: string;
	/** New title (optional). */
	readonly title?: string;
	/** New description (optional). */
	readonly description?: string;
	/** New version (optional). */
	readonly version?: string;
	/** New tags (optional). */
	readonly tags?: readonly string[];
	/** New required tools (optional). */
	readonly requiredTools?: readonly string[];
	/** New instructions (optional). */
	readonly instructions?: string;
	/** New risk level (optional). */
	readonly riskLevel?: RiskLevel;
	/** New constraints (optional). */
	readonly constraints?: readonly string[];
}

/** Result of a skill operation. */
export interface SkillResult {
	readonly ok: boolean;
	readonly skill?: SkillEntry;
	readonly error?: string;
}

/** Result of listing skills. */
export interface SkillListResult {
	readonly ok: boolean;
	readonly skills: readonly SkillEntry[];
	readonly error?: string;
}

/**
 * Service interface for skill operations.
 *
 * Implementations must:
 * - Validate inputs (no empty IDs, no traversal, no secrets)
 * - Use atomic writes via the underlying StorageService
 * - Enforce isolation (skills are global/personal, not project-scoped)
 * - Never store API keys, tokens, or credentials
 * - Never execute arbitrary code from skill instructions
 */
export interface SkillService {
	/** Service identifier for ServiceContainer registration. */
	readonly id: string;
	/** Creates a new skill. */
	createSkill(input: CreateSkillInput): Promise<SkillResult>;
	/** Reads a skill by ID. */
	getSkill(id: string): Promise<SkillEntry | undefined>;
	/** Updates an existing skill. */
	updateSkill(input: UpdateSkillInput): Promise<SkillResult>;
	/** Deletes a skill. */
	deleteSkill(id: string): Promise<SkillResult>;
	/** Lists all skills. */
	listSkills(): Promise<SkillListResult>;
	/** Checks if a skill exists. */
	hasSkill(id: string): Promise<boolean>;
	/** Finds skills by tag. */
	findSkillsByTag(tag: string): Promise<SkillListResult>;
	/** Finds skills that require a specific tool. */
	findSkillsByTool(toolId: string): Promise<SkillListResult>;
}

// ── Skill Discovery Types ────────────────────────────────────────────────────

/**
 * A skill with its relevance score for a given context.
 */
export interface ScoredSkill {
	readonly skill: SkillEntry;
	/** Relevance score from 0 (no match) to 1 (perfect match). */
	readonly score: number;
	/** Which fields matched the query. */
	readonly matchedBy: readonly ('title' | 'description' | 'tags' | 'requiredTools')[];
}

/**
 * Input for contextual skill discovery.
 */
export interface SkillDiscoveryInput {
	/** The user's message or task description. */
	readonly query: string;
	/** Maximum number of skills to return. Defaults to 3. */
	readonly maxSkills?: number;
	/** Tool IDs available in the current session. */
	readonly availableTools?: readonly string[];
	/** Specific skill IDs the user requested by name or ID. */
	readonly requestedSkillIds?: readonly string[];
}

/**
 * Result of skill discovery.
 */
export interface SkillDiscoveryResult {
	readonly ok: boolean;
	/** Skills ranked by relevance, limited to maxSkills. */
	readonly skills: readonly ScoredSkill[];
	/** Skills the user explicitly requested but were not found. */
	readonly missing?: readonly string[];
	readonly error?: string;
}

/**
 * Skill instructions ready for injection into the prompt.
 */
export interface LoadedSkillInstructions {
	/** The skills that were loaded. */
	readonly skills: readonly SkillEntry[];
	/** Total size of instructions in characters. */
	readonly totalSize: number;
	/** Whether the instructions were truncated due to size limits. */
	readonly truncated: boolean;
}

/**
 * Service interface for contextual skill discovery.
 *
 * Discovers relevant skills based on the current conversation context
 * and prepares their instructions for injection into the model's prompt.
 */
export interface SkillDiscoveryService {
	/**
	 * Discovers skills relevant to the given input.
	 *
	 * Discovery considers:
	 * - Text matching in title, description, and tags
	 * - Tool requirements vs available tools
	 * - Explicit user requests by name or ID
	 */
	discover(input: SkillDiscoveryInput): Promise<SkillDiscoveryResult>;

	/**
	 * Loads instructions from discovered skills.
	 *
	 * Returns a formatted block ready for injection into the prompt,
	 * with clear delimiters to prevent instruction injection.
	 */
	loadInstructions(
		scoredSkills: readonly ScoredSkill[],
		maxSizeBytes?: number,
	): Promise<LoadedSkillInstructions>;

	/**
	 * Formats loaded instructions as a system message.
	 *
	 * The message uses delimiters to clearly separate skill instructions
	 * from system instructions, preventing injection attacks.
	 */
	formatAsSystemMessage(instructions: LoadedSkillInstructions): string;
}

// ── Skill Opportunity Types ───────────────────────────────────────────────────

/**
 * A conversation turn used for opportunity analysis.
 */
export interface ConversationTurn {
	readonly role: 'user' | 'assistant';
	readonly content: string;
	readonly toolCalls?: readonly { readonly name: string; readonly arguments: string }[];
	readonly toolResults?: readonly { readonly name: string; readonly output: string }[];
}

/**
 * Input for skill opportunity analysis.
 */
export interface SkillOpportunityInput {
	/** Recent conversation turns to analyze. */
	readonly recentTurns: readonly ConversationTurn[];
	/** Maximum number of proposals to return. Defaults to 3. */
	readonly maxProposals?: number;
	/** Maximum number of recent turns to analyze. Defaults to 10. */
	readonly maxTurns?: number;
	/** Existing skill IDs to avoid duplicates. */
	readonly existingSkillIds?: readonly string[];
	/**
	 * The existing skills in full, when the caller has them.
	 *
	 * `existingSkillIds` suppresses a proposal only when the ids match exactly.
	 * A skill whose id differs but whose title is the same — or which shares
	 * more than half of its tags — is the same skill under another name, and
	 * without the full records the duplicate check had nothing to compare.
	 */
	readonly existingSkills?: readonly SkillEntry[];
	/** Tool IDs available in the current session. */
	readonly availableTools?: readonly string[];
}

/**
 * A proposed skill based on conversation analysis.
 */
export interface SkillProposal {
	/** Suggested skill ID (slug). */
	readonly id: string;
	/** Human-readable title. */
	readonly title: string;
	/** What the skill aims to accomplish. */
	readonly objective: string;
	/** Why this skill would be useful based on the conversation. */
	readonly justification: string;
	/** Initial instructions (Markdown). */
	readonly instructions: string;
	/** Suggested tags. */
	readonly tags: readonly string[];
	/** Tool IDs the skill would need. */
	readonly requiredTools: readonly string[];
	/** Suggested risk level. */
	readonly riskLevel: 'safe' | 'moderate' | 'dangerous';
	/** Constraints or limitations. */
	readonly constraints?: readonly string[];
	/** Confidence score 0-1. */
	readonly confidence: number;
	/** Whether this improves an existing skill (ID if so). */
	readonly improvesSkillId?: string;
}

/**
 * Result of skill opportunity analysis.
 */
export interface SkillOpportunityResult {
	readonly ok: boolean;
	/** Proposed skills ranked by confidence. */
	readonly proposals: readonly SkillProposal[];
	readonly error?: string;
}

/**
 * Service interface for skill opportunity detection.
 *
 * Analyzes recent conversation context to identify reusable procedures
 * that could become skills. Does not auto-save; returns proposals for
 * explicit user approval.
 */
export interface SkillOpportunityService {
	/**
	 * Analyzes recent conversation turns and returns skill proposals.
	 *
	 * Looks for:
	 * - Repeated multi-step procedures
	 * - Corrections that generalize to a pattern
	 * - Tool sequences that could be encapsulated
	 * - User preferences expressed as repeatable workflows
	 */
	analyze(input: SkillOpportunityInput): Promise<SkillOpportunityResult>;
}