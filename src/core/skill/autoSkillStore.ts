/**
 * Where the automatic learner keeps its switch and its receipts.
 *
 * ## One file, in the area that already exists
 *
 *   skills/_evolution/auto-skills.json
 *
 * No new database and no second storage area. The `skills` area is the one the
 * rest of the skill system already goes through, so the same path rules that
 * keep a skill inside `skills/` keep this file there too.
 *
 * The file holds two different things because they are read together and are
 * meaningless apart:
 *
 * - `enabled` — whether the path may write at all. Absent means the default,
 *   which is on: the user asked Evelyn to learn without being asked.
 * - `learned` — one entry per skill this path created, with the proposal id,
 *   the conversation it came from and the evidence it was based on. That is
 *   the audit trail: a skill that appeared without a click can still be traced
 *   to a turn and a count.
 *
 * ## Tolerant reads, serialized writes
 *
 * A missing file is the first run, not an error. A corrupt file is treated as
 * absent rather than fatal: the switch falls back to its default and the list
 * to empty, and the next write repairs the file. Reads never throw for either
 * reason.
 *
 * Writes are queued. Two turns finishing at nearly the same time would
 * otherwise read the same `learned` array, each append its own entry, and the
 * second write would drop the first entry. The queue makes the read-modify-write
 * one operation in this process, which is where the two turns are.
 */
import type { StorageService } from '../storage/types';
import {
	DEFAULT_AUTO_SKILL_SETTINGS,
	type AutoSkillSettings,
} from './autoSkill';

/** The file, relative to the storage root. */
const CONFIG_PATH = 'skills/_evolution/auto-skills.json';

/** One skill this path created, kept as evidence rather than as a counter. */
export interface AutoSkillRecord {
	/** The id of the skill that was created. */
	readonly skillId: string;
	/** The proposal that carried it, so the decision is in the evolution history. */
	readonly proposalId: string;
	readonly title: string;
	/** The conversation whose transcript produced the pattern. */
	readonly conversationId: string;
	/** How many times the pattern was seen. */
	readonly observations: number;
	readonly confidence: number;
	readonly learnedAt: string;
	/** The skill tool IDs the proposal named. */
	readonly tools: readonly string[];
}

/** What the file holds. */
interface AutoSkillFile {
	readonly version: 1;
	readonly enabled: boolean;
	readonly learned: readonly AutoSkillRecord[];
}

/** What a caller gets back: the settings in force and the audit entries. */
export interface AutoSkillState {
	readonly settings: AutoSkillSettings;
	readonly learned: readonly AutoSkillRecord[];
}

/** The store's surface. */
export interface AutoSkillStore {
	/** The settings and the audit entries. Never throws for a missing file. */
	load(): Promise<AutoSkillState>;
	/** Flips the switch and persists it. Returns the settings in force. */
	setEnabled(enabled: boolean): Promise<AutoSkillSettings>;
	/** Appends one receipt. Serialized with every other write. */
	recordLearned(record: AutoSkillRecord): Promise<void>;
}

/** Whether a stored value is a receipt we can hand back. */
function isRecord(value: unknown): value is AutoSkillRecord {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const candidate = value as Partial<AutoSkillRecord>;
	return (
		typeof candidate.skillId === 'string' &&
		candidate.skillId.length > 0 &&
		typeof candidate.proposalId === 'string' &&
		typeof candidate.title === 'string' &&
		typeof candidate.conversationId === 'string' &&
		typeof candidate.learnedAt === 'string' &&
		Array.isArray(candidate.tools) &&
		typeof candidate.observations === 'number' &&
		typeof candidate.confidence === 'number'
	);
}

/**
 * Reads the file, keeping only what is well formed.
 *
 * Each field falls back on its own. A file with a good `learned` array and a
 * damaged `enabled` should not lose the receipts, and a file with the switch
 * and no receipts is an ordinary first run.
 */
async function readState(storage: StorageService): Promise<AutoSkillState> {
	const raw = await storage.read(CONFIG_PATH);
	let parsed: unknown;
	if (raw !== undefined) {
		try {
			parsed = JSON.parse(raw);
		} catch {
			parsed = undefined;
		}
	}
	const file = typeof parsed === 'object' && parsed !== null ? (parsed as Partial<AutoSkillFile>) : {};
	const enabled = typeof file.enabled === 'boolean' ? file.enabled : DEFAULT_AUTO_SKILL_SETTINGS.enabled;
	const learned = Array.isArray(file.learned) ? file.learned.filter(isRecord) : [];
	return {
		settings: { ...DEFAULT_AUTO_SKILL_SETTINGS, enabled },
		learned,
	};
}

async function writeState(storage: StorageService, state: AutoSkillState): Promise<void> {
	const file: AutoSkillFile = {
		version: 1,
		enabled: state.settings.enabled,
		learned: state.learned,
	};
	await storage.write(CONFIG_PATH, JSON.stringify(file, null, '\t'));
}

/**
 * Creates the store over the storage service the skills already use.
 */
export function createAutoSkillStore(storage: StorageService): AutoSkillStore {
	/**
	 * The tail of the write queue.
	 *
	 * Resolved rather than rejected so a failed write does not poison every
	 * later one; the failure is still returned to its own caller.
	 */
	let tail: Promise<void> = Promise.resolve();

	function serialize<T>(task: () => Promise<T>): Promise<T> {
		const run = tail.then(task, task);
		tail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	return {
		async load() {
			return readState(storage);
		},

		async setEnabled(enabled) {
			return serialize(async () => {
				const current = await readState(storage);
				const settings: AutoSkillSettings = { ...current.settings, enabled };
				await writeState(storage, { ...current, settings });
				return settings;
			});
		},

		async recordLearned(record) {
			await serialize(async () => {
				const current = await readState(storage);
				// The same proposal recorded twice is the same skill, not two. A
				// retry after a partial failure must not inflate the count that
				// the cap is measured against.
				const withoutDuplicate = current.learned.filter(
					(existing) => existing.proposalId !== record.proposalId,
				);
				await writeState(storage, {
					...current,
					learned: [...withoutDuplicate, record],
				});
			});
		},
	};
}
