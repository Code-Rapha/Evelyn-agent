/**
 * The two names a tool has, and the bridge between them.
 *
 * A tool has a **call name** — what the model writes in a tool call, and what
 * its descriptor carries as `id` (`read_file`) — and a **skill id** — what a
 * skill declares in `requiredTools` (`fs.read`). They agree for most of the
 * product and disagree for the families where the prefix is the subject rather
 * than the verb: filesystem, memory and skill.
 *
 * Two pieces of code have to agree on that vocabulary, and before this module
 * they each kept their own copy:
 *
 * - the opportunity analyzer, which observes call names in a transcript and
 *   must propose in skill ids;
 * - the analyzer's catalog, built from the registry's descriptor ids and
 *   filtered against the same proposals.
 *
 * Keeping them in step by hand is what made a proposal name `fs.read` while
 * the catalog held `read_file`: the proposal was built and then discarded as
 * naming a tool the product does not have. One table, used by both, is the
 * only version of this that stays true when a tool is added.
 */

/**
 * Call name (or descriptor id) to skill id.
 *
 * Only the tools whose two names differ appear here. Anything absent maps to
 * itself, which is the common case — and the reason "unknown" is not treated
 * as "not available": a tool added tomorrow would be silently dropped from
 * every proposal by a table nobody remembered to edit.
 */
const SKILL_ID_BY_CALL_NAME: Readonly<Record<string, string>> = {
	// Filesystem.
	read_file: 'fs.read',
	write_file: 'fs.write',
	modify_file: 'fs.modify',
	list_files: 'fs.list',
	glob_files: 'fs.glob',
	grep_files: 'fs.grep',
	// Terminal and tests.
	run_command: 'terminal.execute',
	run_test: 'test.run',
	// Git.
	git_commit: 'git.commit',
	git_status: 'git.status',
	// Memory.
	create_memory: 'memory.create',
	read_memory: 'memory.read',
	update_memory: 'memory.update',
	delete_memory: 'memory.delete',
	list_memories: 'memory.list',
	// Skills.
	read_skill: 'skill.read',
	write_skill: 'skill.write',
	list_skills: 'skill.list',
	delete_skill: 'skill.delete',
	analyze_skill_opportunities: 'skill.analyze',
};

/** The skill id for a call name or descriptor id. Idempotent. */
export function skillToolId(callName: string): string {
	return SKILL_ID_BY_CALL_NAME[callName] ?? callName;
}

/**
 * The skill ids a set of registered tools stands for, deduplicated and sorted.
 *
 * Sorted so a proposal's `requiredTools` is stable between runs: the same
 * registry must not produce the same skill with its tools in another order.
 */
export function skillToolIds(registered: readonly string[]): readonly string[] {
	return [...new Set(registered.map(skillToolId))].sort();
}
