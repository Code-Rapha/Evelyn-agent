/**
 * Skill tools for the agent.
 *
 * These tools let the model read, write, list, and delete skills
 * on behalf of the user. The user must explicitly request these operations;
 * the model never saves skills automatically.
 *
 * Skills are not executed directly by these tools — they are loaded and
 * their instructions are made available to the agent. Execution of skill
 * instructions always goes through the normal tool/permission system.
 */
import type { AgentTool, ToolDescriptor, ToolExecutionContext, ToolResult } from './types';
import type { ToolSpec } from './toolRegistry';
import type { SkillService, CreateSkillInput, UpdateSkillInput } from '../skill/types';
import type { RiskLevel } from '../permissions/types';
import { createSkillOpportunityService } from '../skill/skillOpportunity';
import { skillToolIds } from '../skill/toolIds';

/** Tool names. */
export const READ_SKILL = 'read_skill';
export const WRITE_SKILL = 'write_skill';
export const LIST_SKILLS = 'list_skills';
export const DELETE_SKILL = 'delete_skill';
export const ANALYZE_SKILL_OPPORTUNITIES = 'analyze_skill_opportunities';

/** Arguments for read_skill. */
export interface ReadSkillArgs {
	readonly id: string;
}

/** Arguments for write_skill. */
export interface WriteSkillArgs {
	readonly id?: string;
	readonly title: string;
	readonly description: string;
	readonly version?: string;
	readonly tags?: readonly string[];
	readonly requiredTools?: readonly string[];
	readonly instructions: string;
	readonly riskLevel?: RiskLevel;
	readonly constraints?: readonly string[];
}

/** Arguments for list_skills. */
export interface ListSkillsArgs {
	readonly tag?: string;
	readonly toolId?: string;
}

/** Arguments for delete_skill. */
export interface DeleteSkillArgs {
	readonly id: string;
}

/** Arguments for analyze_skill_opportunities. */
export interface AnalyzeSkillOpportunitiesArgs {
	/** Number of recent turns to analyze. Defaults to 10. */
	readonly maxTurns?: number;
	/** Maximum number of proposals to return. Defaults to 3. */
	readonly maxProposals?: number;
}

/** Result shape for read_skill tool. */
export interface ReadSkillResult {
	readonly id: string;
	readonly title: string;
	readonly description: string;
	readonly version: string;
	readonly tags: readonly string[];
	readonly requiredTools: readonly string[];
	readonly instructions: string;
	readonly riskLevel: RiskLevel;
	readonly constraints: readonly string[];
	readonly createdAt: string;
	readonly updatedAt: string;
}

/** Result shape for write_skill tool. */
export interface WriteSkillResult {
	readonly id: string;
	readonly title: string;
	readonly description: string;
	readonly version: string;
	readonly tags: readonly string[];
	readonly requiredTools: readonly string[];
	readonly instructions: string;
	readonly riskLevel: RiskLevel;
	readonly constraints: readonly string[];
	readonly createdAt: string;
	readonly updatedAt: string;
}

/** Result shape for list_skills tool. */
export interface ListSkillsResult {
	readonly skills: readonly {
		readonly id: string;
		readonly title: string;
		readonly description: string;
		readonly version: string;
		readonly tags: readonly string[];
		readonly requiredTools: readonly string[];
		readonly riskLevel: RiskLevel;
		readonly constraints: readonly string[];
		readonly createdAt: string;
		readonly updatedAt: string;
	}[];
}

/** Result shape for delete_skill tool. */
export interface DeleteSkillResult {
	readonly id: string;
	readonly deleted: boolean;
}

/** Result shape for analyze_skill_opportunities tool. */
export interface AnalyzeSkillOpportunitiesResult {
	readonly proposals: readonly {
		readonly id: string;
		readonly title: string;
		readonly objective: string;
		readonly justification: string;
		readonly instructions: string;
		readonly tags: readonly string[];
		readonly requiredTools: readonly string[];
		readonly riskLevel: 'safe' | 'moderate' | 'dangerous';
		readonly constraints?: readonly string[];
		readonly confidence: number;
		readonly improvesSkillId?: string;
	}[];
}

/**
 * Creates the read_skill tool.
 */
export function createReadSkillTool(skillService: SkillService): AgentTool<ReadSkillArgs, ReadSkillResult> {
	const descriptor: ToolDescriptor = {
		id: READ_SKILL,
		name: READ_SKILL,
		category: 'memory',
		riskLevel: 'safe',
		description: 'Read a skill by its ID. Use this when the user asks you to load a skill or check its instructions.',
	};
	return {
		descriptor,
		async execute(input, _context): Promise<ToolResult<ReadSkillResult>> {
			try {
				const id = input.id;

				if (!id || typeof id !== 'string') {
					return { ok: false, error: 'Skill ID is required.' };
				}

				const skill = await skillService.getSkill(id);
				if (!skill) {
					return { ok: false, error: `Skill "${id}" not found.` };
				}

				return {
					ok: true,
					output: {
						id: skill.id,
						title: skill.title,
						description: skill.description,
						version: skill.version,
						tags: skill.tags,
						requiredTools: skill.requiredTools,
						instructions: skill.instructions,
						riskLevel: skill.riskLevel,
						constraints: skill.constraints ?? [],
						createdAt: skill.createdAt,
						updatedAt: skill.updatedAt,
					},
				};
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
	};
}

/**
 * Creates the write_skill tool.
 */
export function createWriteSkillTool(skillService: SkillService): AgentTool<WriteSkillArgs, WriteSkillResult> {
	const descriptor: ToolDescriptor = {
		id: WRITE_SKILL,
		name: WRITE_SKILL,
		category: 'memory',
		riskLevel: 'moderate',
		description: 'Save a new skill. Use this when the user explicitly asks you to create a skill. Do not create skills automatically.',
	};
	return {
		descriptor,
		async execute(input, _context): Promise<ToolResult<WriteSkillResult>> {
			try {
				if (!input.title || typeof input.title !== 'string') {
					return { ok: false, error: 'Title is required.' };
				}
				if (!input.description || typeof input.description !== 'string') {
					return { ok: false, error: 'Description is required.' };
				}
				if (!input.instructions || typeof input.instructions !== 'string') {
					return { ok: false, error: 'Instructions are required.' };
				}

				const createInput: CreateSkillInput = {
					id: input.id,
					title: input.title,
					description: input.description,
					version: input.version,
					tags: input.tags,
					requiredTools: input.requiredTools,
					instructions: input.instructions,
					riskLevel: input.riskLevel,
					constraints: input.constraints,
				};

				const result = await skillService.createSkill(createInput);
				if (!result.ok) {
					return { ok: false, error: result.error };
				}

				return {
					ok: true,
					output: {
						id: result.skill!.id,
						title: result.skill!.title,
						description: result.skill!.description,
						version: result.skill!.version,
						tags: result.skill!.tags,
						requiredTools: result.skill!.requiredTools,
						instructions: result.skill!.instructions,
						riskLevel: result.skill!.riskLevel,
						constraints: result.skill!.constraints ?? [],
						createdAt: result.skill!.createdAt,
						updatedAt: result.skill!.updatedAt,
					},
				};
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
	};
}

/**
 * Creates the list_skills tool.
 */
export function createListSkillsTool(skillService: SkillService): AgentTool<ListSkillsArgs, ListSkillsResult> {
	const descriptor: ToolDescriptor = {
		id: LIST_SKILLS,
		name: LIST_SKILLS,
		category: 'memory',
		riskLevel: 'safe',
		description: 'List all skills, optionally filtered by tag or required tool. Use this when the user asks what skills are available.',
	};
	return {
		descriptor,
		async execute(input, _context): Promise<ToolResult<ListSkillsResult>> {
			try {
				let result;
				if (input.tag) {
					result = await skillService.findSkillsByTag(input.tag);
				} else if (input.toolId) {
					result = await skillService.findSkillsByTool(input.toolId);
				} else {
					result = await skillService.listSkills();
				}

				if (!result.ok) {
					return { ok: false, error: result.error };
				}

				return {
					ok: true,
					output: {
						skills: result.skills.map((s) => ({
							id: s.id,
							title: s.title,
							description: s.description,
							version: s.version,
							tags: s.tags,
							requiredTools: s.requiredTools,
							riskLevel: s.riskLevel,
							constraints: s.constraints ?? [],
							createdAt: s.createdAt,
							updatedAt: s.updatedAt,
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
 * Creates the delete_skill tool.
 */
export function createDeleteSkillTool(skillService: SkillService): AgentTool<DeleteSkillArgs, DeleteSkillResult> {
	const descriptor: ToolDescriptor = {
		id: DELETE_SKILL,
		name: DELETE_SKILL,
		category: 'memory',
		riskLevel: 'moderate',
		description: 'Delete a skill. Use this when the user explicitly asks you to remove a skill.',
	};
	return {
		descriptor,
		async execute(input, _context): Promise<ToolResult<DeleteSkillResult>> {
			try {
				const id = input.id;

				if (!id || typeof id !== 'string') {
					return { ok: false, error: 'Skill ID is required.' };
				}

				const result = await skillService.deleteSkill(id);
				if (!result.ok) {
					return { ok: false, error: result.error };
				}

				return {
					ok: true,
					output: {
						id,
						deleted: true,
					},
				};
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
	};
}

/**
 * The tool IDs assumed when the caller does not say which are registered.
 *
 * Only reached when the analysis runs outside a runtime turn, which means a
 * test or a script. A real turn always supplies `availableToolIds`, because
 * the registry is right there — so this list can never disagree with the
 * product during normal use, and the guard is the empty-context case rather
 * than a second source of truth.
 */
const DEFAULT_TOOL_IDS: readonly string[] = [
	'fs.read',
	'fs.write',
	'fs.modify',
	'fs.list',
	'terminal.execute',
	'test.run',
	'memory.create',
	'memory.read',
	'memory.update',
	'memory.delete',
	'memory.list',
	'skill.read',
	'skill.write',
	'skill.list',
	'skill.delete',
];

/**
 * Creates the analyze_skill_opportunities tool.
 *
 * The analysis needs the conversation, and the conversation is not an
 * argument: the model cannot be asked to paste the transcript back into a
 * tool call, and an invented history would make the tool answer "nothing
 * found" regardless of what happened. The runtime supplies it through
 * `ToolExecutionContext.conversationTurns`.
 */
export function createAnalyzeSkillOpportunitiesTool(
	skillService: SkillService,
): AgentTool<AnalyzeSkillOpportunitiesArgs, AnalyzeSkillOpportunitiesResult> {
	const descriptor: ToolDescriptor = {
		id: ANALYZE_SKILL_OPPORTUNITIES,
		name: ANALYZE_SKILL_OPPORTUNITIES,
		category: 'memory',
		riskLevel: 'safe',
		description:
			'Analyze recent conversation for reusable procedures that could become skills. Returns proposals requiring explicit user approval before saving. Does not create skills automatically.',
	};
	const opportunityService = createSkillOpportunityService();

	return {
		descriptor,
		async execute(input, context): Promise<ToolResult<AnalyzeSkillOpportunitiesResult>> {
			try {
				const turns = context.conversationTurns ?? [];
				if (turns.length === 0) {
					return {
						ok: false,
						error:
							'No conversation is available to analyze. The tool reads the transcript from the host; call it from a chat turn, not on its own.',
					};
				}

				const listResult = await skillService.listSkills();
				if (!listResult.ok) {
					return { ok: false, error: listResult.error };
				}
				const existingSkillIds = listResult.skills.map((s) => s.id);

				// The tool catalog is what the turn actually registered. The
				// previous version carried its own list, so a tool added to the
				// product appeared here only after someone remembered to edit
				// this file too — and a proposal naming a tool that does exist
				// was discarded as if it did not.
				//
				// The registry reports descriptor ids (`read_file`); the proposal
				// speaks skill ids (`fs.read`). The bridge is `skillToolIds`, the
				// same table the analyzer uses on the observed call names, so the
				// catalog and the proposal cannot end up in two vocabularies.
				const availableTools =
					(context.availableToolIds ?? []).length > 0
						? skillToolIds(context.availableToolIds ?? [])
						: // Chamado fora de um turno do runtime — um teste, um script —, o
							// contexto não traz a lista. Aí a análise continua com o que
							// deve existir num agente completo, e o resultado é o de antes.
							[...DEFAULT_TOOL_IDS];

				const result = await opportunityService.analyze({
					recentTurns: turns,
					existingSkillIds,
					// The skills in full: without them the duplicate check only
					// compared ids and proposed the same skill again under a
					// different name.
					existingSkills: listResult.skills,
					availableTools,
					...(input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : {}),
					...(input.maxProposals !== undefined ? { maxProposals: input.maxProposals } : {}),
				});
				if (!result.ok) {
					return { ok: false, error: result.error ?? 'skill opportunity analysis failed' };
				}

				return {
					ok: true,
					output: {
						proposals: result.proposals.map((proposal) => ({
							id: proposal.id,
							title: proposal.title,
							objective: proposal.objective,
							justification: proposal.justification,
							instructions: proposal.instructions,
							tags: proposal.tags,
							requiredTools: proposal.requiredTools,
							riskLevel: proposal.riskLevel,
							...(proposal.constraints !== undefined
								? { constraints: proposal.constraints }
								: {}),
							confidence: proposal.confidence,
							...(proposal.improvesSkillId !== undefined
								? { improvesSkillId: proposal.improvesSkillId }
								: {}),
						})),
					},
				};
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
	};
}

/** Specs for the skill tools. */
export const SKILL_TOOL_SPECS: readonly ToolSpec[] = [
	{
		name: READ_SKILL,
		description: 'Read a skill by its ID. Use this when the user asks you to load a skill or check its instructions.',
		parameters: {
			type: 'object',
			properties: {
				id: { type: 'string', description: 'The skill ID to read' },
			},
			required: ['id'],
		},
		riskLevel: 'safe',
		category: 'memory',
	},
	{
		name: WRITE_SKILL,
		description: 'Save a new skill. Use this when the user explicitly asks you to create a skill. Do not create skills automatically.',
		parameters: {
			type: 'object',
			properties: {
				id: { type: 'string', description: 'Optional custom ID. If omitted, a slug from the title is used.' },
				title: { type: 'string', description: 'Human-readable title for the skill' },
				description: { type: 'string', description: 'Brief description of what the skill does' },
				version: { type: 'string', description: 'Semantic version (e.g., "1.0.0"). Defaults to "1.0.0".' },
				tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for filtering' },
				requiredTools: { type: 'array', items: { type: 'string' }, description: 'Optional list of tool IDs this skill requires' },
				instructions: { type: 'string', description: 'The skill instructions (Markdown)' },
				riskLevel: { type: 'string', enum: ['safe', 'moderate', 'dangerous'], description: 'Risk level this skill operates at. Defaults to "moderate".' },
				constraints: { type: 'array', items: { type: 'string' }, description: 'Optional constraints or limitations of this skill' },
			},
			required: ['title', 'description', 'instructions'],
		},
		riskLevel: 'moderate',
		category: 'memory',
	},
	{
		name: LIST_SKILLS,
		description: 'List all skills, optionally filtered by tag or required tool. Use this when the user asks what skills are available.',
		parameters: {
			type: 'object',
			properties: {
				tag: { type: 'string', description: 'Optional tag to filter by' },
				toolId: { type: 'string', description: 'Optional tool ID to find skills requiring this tool' },
			},
			required: [],
		},
		riskLevel: 'safe',
		category: 'memory',
	},
	{
		name: DELETE_SKILL,
		description: 'Delete a skill. Use this when the user explicitly asks you to remove a skill.',
		parameters: {
			type: 'object',
			properties: {
				id: { type: 'string', description: 'The skill ID to delete' },
			},
			required: ['id'],
		},
		riskLevel: 'moderate',
		category: 'memory',
	},
	{
		name: ANALYZE_SKILL_OPPORTUNITIES,
		description: 'Analyze recent conversation for reusable procedures that could become skills. Returns proposals requiring explicit user approval before saving. Does not create skills automatically.',
		parameters: {
			type: 'object',
			properties: {
				maxTurns: { type: 'integer', description: 'Number of recent turns to analyze (default: 10)', minimum: 1, maximum: 50 },
				maxProposals: { type: 'integer', description: 'Maximum proposals to return (default: 3)', minimum: 1, maximum: 10 },
			},
			required: [],
		},
		riskLevel: 'safe',
		category: 'memory',
	},
];

/** Creates all five skill tools. */
export function createSkillTools(skillService: SkillService): readonly AgentTool[] {
	return [
		createReadSkillTool(skillService),
		createWriteSkillTool(skillService),
		createListSkillsTool(skillService),
		createDeleteSkillTool(skillService),
		createAnalyzeSkillOpportunitiesTool(skillService),
	];
}