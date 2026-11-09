/**
 * Evaluation logging: records detailed evaluations, comparisons, and learning proposals.
 *
 * Uses the existing FileDataStore. No new storage infrastructure.
 * Append-only, bounded to prevent unbounded growth.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../adapters/local/writeFileAtomic';
import type { FileDataStore } from '../adapters/local/fileDataStore';
import type { DetailedEvaluation, ExperimentComparison, LearningProposal } from './evaluation';

export interface EvaluationLogEntry {
	readonly id: string;
	readonly timestamp: string;
	readonly sessionId: string;
	readonly experimentId: string | undefined;
	readonly type: 'evaluation' | 'comparison' | 'learning-proposal';
	readonly payload: unknown;
}

interface EvaluationLogFile {
	readonly version: 1;
	readonly entries: readonly EvaluationLogEntry[];
}

const LOG_FILE = 'evaluationLog.json';
const MAX_ENTRIES = 1000;

/**
 * The log's surface.
 *
 * Named for the same reason as `ExperimentLog`: the learning pipeline depends on
 * `getLatestEvaluation` alone, and stating that here is what keeps the narrowing
 * honest instead of letting a caller reach for whatever it likes.
 */
export interface EvaluationLog {
	append(entry: Omit<EvaluationLogEntry, 'id' | 'timestamp'>): Promise<EvaluationLogEntry>;
	listEvaluations(sessionId: string): Promise<readonly DetailedEvaluation[]>;
	listComparisons(sessionId: string): Promise<readonly ExperimentComparison[]>;
	listProposals(sessionId: string): Promise<readonly LearningProposal[]>;
	getLatestEvaluation(experimentId: string): Promise<DetailedEvaluation | undefined>;
	clear(): Promise<void>;
}

export function createEvaluationLog(store: FileDataStore): EvaluationLog {
	const rootPath = store.rootPath;
	const logPath = join(rootPath, LOG_FILE);

	async function readLog(): Promise<EvaluationLogFile> {
		try {
			const raw = await readFile(logPath, 'utf8');
			const parsed = JSON.parse(raw) as EvaluationLogFile;
			if (parsed.version === 1 && Array.isArray(parsed.entries)) {
				return parsed;
			}
		} catch {
			// Missing or corrupt → start fresh
		}
		return { version: 1 as const, entries: [] };
	}

	async function writeLog(log: EvaluationLogFile): Promise<void> {
		await writeFileAtomic(logPath, JSON.stringify(log, null, '\t'));
	}

	return {
		async append(entry) {
			const log = await readLog();
			const now = new Date().toISOString();
			const fullEntry: EvaluationLogEntry = {
				...entry,
				id: `eval-log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				timestamp: now,
			};
			const updated: EvaluationLogFile = {
				version: 1,
				entries: [...log.entries, fullEntry].slice(-MAX_ENTRIES),
			};
			await writeLog(updated);
			return fullEntry;
		},

		async listEvaluations(sessionId) {
			const log = await readLog();
			return log.entries
				.filter((e) => e.sessionId === sessionId && e.type === 'evaluation')
				.map((e) => e.payload as DetailedEvaluation);
		},

		async listComparisons(sessionId) {
			const log = await readLog();
			return log.entries
				.filter((e) => e.sessionId === sessionId && e.type === 'comparison')
				.map((e) => e.payload as ExperimentComparison);
		},

		async listProposals(sessionId) {
			const log = await readLog();
			return log.entries
				.filter((e) => e.sessionId === sessionId && e.type === 'learning-proposal')
				.map((e) => e.payload as LearningProposal);
		},

		async getLatestEvaluation(experimentId) {
			const log = await readLog();
			const evals = log.entries
				.filter((e) => e.experimentId === experimentId && e.type === 'evaluation')
				.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
			return evals[0]?.payload as DetailedEvaluation | undefined;
		},

		async clear() {
			await writeLog({ version: 1, entries: [] });
		},
	};
}

/** Builds a log entry for a detailed evaluation. */
export function buildEvaluationEntry(
	sessionId: string,
	experimentId: string,
	evaluation: DetailedEvaluation
): Omit<EvaluationLogEntry, 'id' | 'timestamp'> {
	return {
		sessionId,
		experimentId,
		type: 'evaluation',
		payload: evaluation,
	};
}

/** Builds a log entry for an experiment comparison. */
export function buildComparisonEntry(
	sessionId: string,
	comparison: ExperimentComparison
): Omit<EvaluationLogEntry, 'id' | 'timestamp'> {
	return {
		sessionId,
		experimentId: undefined,
		type: 'comparison',
		payload: comparison,
	};
}

/** Builds a log entry for a learning proposal. */
export function buildProposalEntry(
	sessionId: string,
	proposal: LearningProposal
): Omit<EvaluationLogEntry, 'id' | 'timestamp'> {
	return {
		sessionId,
		experimentId: undefined,
		type: 'learning-proposal',
		payload: proposal,
	};
}