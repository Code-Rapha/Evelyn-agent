/**
 * Persistence for skill evolution: proposals and version history.
 *
 * ## Where this lives
 *
 * Inside the `skills` area the rest of the skill system already uses, under a
 * reserved subdirectory:
 *
 *   skills/
 *     <skillId>.md                 ← the live skill, owned by FileSkillService
 *     _evolution/
 *       proposals/<proposalId>.json
 *       versions/<skillId>/<versionId>.md
 *       history/<skillId>.json      ← the ordered version index
 *
 * No new database, no new storage area, no second copy of `FileSkillService`.
 * The same `StorageService` that guards `skills/` already refuses traversal,
 * symlink escapes and reserved names, and every path here goes through it.
 *
 * ## What this file will not do
 *
 * It does not write `skills/<skillId>.md`. Not even on activation. The live
 * skill is written only by `skillEvolutionService`, through the ordinary
 * `SkillService`, and only after a recorded approval — so there is exactly one
 * writer for the active file and it is not reachable from a proposal's
 * contents.
 */
import { ValidationError } from '../errors';
import type { StorageService } from '../storage/types';
import type { ProposedSkillContent, SkillEvolutionProposal, ProposalStatus } from './skillEvolution';

/** Reserved subdirectory of `skills/`. */
const EVOLUTION_ROOT = 'skills/_evolution';
const PROPOSALS_DIR = `${EVOLUTION_ROOT}/proposals`;
const VERSIONS_DIR = `${EVOLUTION_ROOT}/versions`;
const HISTORY_DIR = `${EVOLUTION_ROOT}/history`;

/** Most versions kept per skill. */
export const MAX_VERSIONS_PER_SKILL = 20;

/** Most proposals kept overall. Bounded so the log cannot grow without limit. */
export const MAX_PROPOSALS = 500;

/** One archived revision of a skill. */
export interface SkillVersion {
	readonly versionId: string;
	readonly skillId: string;
	/** The semantic version this content carried when it was archived. */
	readonly version: string;
	readonly content: ProposedSkillContent;
	readonly archivedAt: string;
	/** Why it was archived: `initial`, `activation` or `rollback`. */
	readonly reason: 'initial' | 'activation' | 'rollback';
	/** The proposal that produced it, when one did. */
	readonly proposalId?: string;
}

/** The ordered index of a skill's versions. Newest last. */
interface VersionHistory {
	readonly version: 1;
	readonly skillId: string;
	readonly versions: readonly SkillVersion[];
}

function assertSafeName(name: string, what: string): void {
	if (typeof name !== 'string' || name.trim().length === 0) {
		throw new ValidationError(`${what} must be a non-empty string`);
	}
	if (name.includes('/') || name.includes('\\')) {
		throw new ValidationError(`${what} cannot contain path separators: ${name}`);
	}
	if (name.includes('\0')) {
		throw new ValidationError(`${what} cannot contain null bytes`);
	}
	if (name.length > 200) {
		throw new ValidationError(`${what} cannot exceed 200 characters`);
	}
	if (name === '.' || name === '..') {
		throw new ValidationError(`${what} cannot be a relative path segment`);
	}
}

/** Reads JSON, treating a missing or unreadable file as absent. */
async function readJson<T>(storage: StorageService, path: string): Promise<T | undefined> {
	const raw = await storage.read(path);
	if (raw === undefined) {
		return undefined;
	}
	try {
		return JSON.parse(raw) as T;
	} catch {
		// A truncated file is treated as absent rather than fatal: the caller
		// keeps working from the live skill, and the archive is rebuildable from
		// the skills themselves. Failing here would make one bad byte take the
		// whole skill library offline.
		return undefined;
	}
}

async function writeJson(storage: StorageService, path: string, value: unknown): Promise<void> {
	await storage.write(path, JSON.stringify(value, null, '\t'));
}

/** Whether a stored value is a proposal we can hand back. */
function isProposal(value: unknown): value is SkillEvolutionProposal {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const candidate = value as Partial<SkillEvolutionProposal>;
	return (
		typeof candidate.id === 'string' &&
		typeof candidate.fingerprint === 'string' &&
		typeof candidate.status === 'string' &&
		typeof candidate.proposed === 'object' &&
		candidate.proposed !== null
	);
}

const PROPOSAL_STATUSES: readonly ProposalStatus[] = [
	'pending',
	'approved',
	'rejected',
	'activated',
	'reverted',
];

/** Whether a stored value is a version we can hand back. */
function isVersion(value: unknown): value is SkillVersion {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const candidate = value as Partial<SkillVersion>;
	return (
		typeof candidate.versionId === 'string' &&
		typeof candidate.skillId === 'string' &&
		typeof candidate.version === 'string' &&
		typeof candidate.archivedAt === 'string' &&
		typeof candidate.content === 'object' &&
		candidate.content !== null
	);
}

/** The store's surface. */
export interface SkillEvolutionStore {
	/** Writes a proposal. Refuses a fingerprint already filed and unresolved. */
	saveProposal(proposal: SkillEvolutionProposal): Promise<SkillEvolutionProposal>;
	/** Every proposal, newest first. */
	listProposals(): Promise<readonly SkillEvolutionProposal[]>;
	/** One proposal by id. */
	getProposal(proposalId: string): Promise<SkillEvolutionProposal | undefined>;
	/** Replaces a stored proposal. Used to record a decision or a status change. */
	updateProposal(proposal: SkillEvolutionProposal): Promise<SkillEvolutionProposal>;
	/** Fingerprints of proposals that are still pending or approved. */
	listOpenFingerprints(): Promise<readonly string[]>;
	/** Archives a version, trimming the history to the cap. Oldest goes first. */
	archiveVersion(version: SkillVersion): Promise<SkillVersion>;
	/** A skill's versions, oldest first. */
	listVersions(skillId: string): Promise<readonly SkillVersion[]>;
	/** One archived version. */
	getVersion(skillId: string, versionId: string): Promise<SkillVersion | undefined>;
	/** The version most recently archived for a skill. */
	getLatestVersion(skillId: string): Promise<SkillVersion | undefined>;
}

/**
 * Creates the store over the same `StorageService` the skills live in.
 */
export function createSkillEvolutionStore(storage: StorageService): SkillEvolutionStore {
	async function readHistory(skillId: string): Promise<VersionHistory> {
		const stored = await readJson<VersionHistory>(storage, `${HISTORY_DIR}/${skillId}.json`);
		if (stored !== undefined && stored.version === 1 && Array.isArray(stored.versions)) {
			return stored;
		}
		return { version: 1, skillId, versions: [] };
	}

	async function listAllProposals(): Promise<readonly SkillEvolutionProposal[]> {
		const names = await storage.list(PROPOSALS_DIR);
		const proposals: SkillEvolutionProposal[] = [];
		for (const name of names) {
			if (!name.endsWith('.json')) {
				continue;
			}
			const stored = await readJson<unknown>(storage, `${PROPOSALS_DIR}/${name}`);
			if (isProposal(stored)) {
				proposals.push(stored);
			}
		}
		proposals.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
		return proposals;
	}

	return {
		async saveProposal(proposal) {
			if (typeof proposal?.id !== 'string' || proposal.id.trim().length === 0) {
				throw new ValidationError('a proposal needs a non-empty id');
			}
			if (!PROPOSAL_STATUSES.includes(proposal.status)) {
				throw new ValidationError(`unknown proposal status ${JSON.stringify(proposal.status)}`);
			}
			assertSafeName(proposal.id, 'a proposal id');

			const existing = await storage.list(PROPOSALS_DIR);
			const path = `${PROPOSALS_DIR}/${proposal.id}.json`;
			if (await storage.exists(path)) {
				throw new ValidationError(`a proposal with id "${proposal.id}" already exists`);
			}

			// The duplicate check that keeps the assistant from filing the same
			// finding every time it looks: an unresolved proposal for the same
			// fingerprint means the question is already on the user's desk.
			const open = new Set(
				(await listAllProposals())
					.filter((stored) => stored.status === 'pending' || stored.status === 'approved')
					.map((stored) => stored.fingerprint),
			);
			if (open.has(proposal.fingerprint)) {
				throw new ValidationError(
					`an unresolved proposal already covers "${proposal.fingerprint}"`,
				);
			}

			await writeJson(storage, path, proposal);

			// Bounded, and bounded in the right direction: the oldest proposal is
			// dropped, never the newest, so a proposal cannot be evicted by a
			// later one arriving while it is still being read.
			const names = [
				...existing.filter((name) => name.endsWith('.json')),
				`${proposal.id}.json`,
			].sort();
			if (names.length > MAX_PROPOSALS) {
				for (const stale of names.slice(0, names.length - MAX_PROPOSALS)) {
					await storage.delete(`${PROPOSALS_DIR}/${stale}`);
				}
			}
			return proposal;
		},

		async listProposals() {
			return listAllProposals();
		},

		async getProposal(proposalId) {
			assertSafeName(proposalId, 'a proposal id');
			const stored = await readJson<unknown>(storage, `${PROPOSALS_DIR}/${proposalId}.json`);
			return isProposal(stored) ? stored : undefined;
		},

		async updateProposal(proposal) {
			if (typeof proposal?.id !== 'string' || proposal.id.trim().length === 0) {
				throw new ValidationError('a proposal needs a non-empty id');
			}
			if (!PROPOSAL_STATUSES.includes(proposal.status)) {
				throw new ValidationError(`unknown proposal status ${JSON.stringify(proposal.status)}`);
			}
			assertSafeName(proposal.id, 'a proposal id');
			await writeJson(storage, `${PROPOSALS_DIR}/${proposal.id}.json`, proposal);
			return proposal;
		},

		async listOpenFingerprints() {
			const open = await listAllProposals();
			return [
				...new Set(
					open
						.filter((proposal) => proposal.status === 'pending' || proposal.status === 'approved')
						.map((proposal) => proposal.fingerprint),
				),
			];
		},

		async archiveVersion(version) {
			assertSafeName(version.skillId, 'a skill id');
			assertSafeName(version.versionId, 'a version id');

			const history = await readHistory(version.skillId);
			const withoutDuplicate = history.versions.filter((existing) => existing.versionId !== version.versionId);
			const versions = [...withoutDuplicate, version];

			// The cap drops the oldest. It is a bound on how far back we can look,
			// not a deletion policy: `MAX_VERSIONS_PER_SKILL` is large enough that
			// reaching it means the user has genuinely cycled the skill that many
			// times, and the version being added right now is never the one cut.
			const trimmed = versions.slice(-MAX_VERSIONS_PER_SKILL);
			const dropped = versions.slice(0, versions.length - MAX_VERSIONS_PER_SKILL);

			await storage.createDirectory(`${VERSIONS_DIR}/${version.skillId}`);
			await writeJson(storage, `${VERSIONS_DIR}/${version.skillId}/${version.versionId}.json`, version);
			await writeJson(storage, `${HISTORY_DIR}/${version.skillId}.json`, {
				version: 1,
				skillId: version.skillId,
				versions: trimmed,
			} satisfies VersionHistory);

			for (const stale of dropped) {
				await storage.delete(`${VERSIONS_DIR}/${version.skillId}/${stale.versionId}.json`);
			}
			return version;
		},

		async listVersions(skillId) {
			assertSafeName(skillId, 'a skill id');
			const history = await readHistory(skillId);
			return history.versions.filter(isVersion);
		},

		async getVersion(skillId, versionId) {
			assertSafeName(skillId, 'a skill id');
			assertSafeName(versionId, 'a version id');
			const stored = await readJson<unknown>(storage, `${VERSIONS_DIR}/${skillId}/${versionId}.json`);
			return isVersion(stored) ? stored : undefined;
		},

		async getLatestVersion(skillId) {
			const versions = await this.listVersions(skillId);
			return versions.length === 0 ? undefined : versions[versions.length - 1];
		},
	};
}
