/**
 * Experiment logging: records experiment sessions, experiments, and evaluations.
 *
 * Uses the existing FileDataStore. No new storage infrastructure.
 * Append-only, bounded to prevent unbounded growth.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../adapters/local/writeFileAtomic';
import type { FileDataStore } from '../adapters/local/fileDataStore';
import type { Experiment, ExperimentSession, ExperimentEvaluation, Evidence, BudgetConsumption } from './experiment';

export interface ExperimentLogEntry {
	readonly id: string;
	readonly timestamp: string;
	readonly sessionId: string;
	readonly experimentId: string | undefined;
	readonly type: 'session-start' | 'experiment-start' | 'evidence' | 'evaluation' | 'session-end';
	readonly payload: unknown;
}

interface ExperimentLogFile {
	readonly version: 1;
	readonly entries: readonly ExperimentLogEntry[];
}

const LOG_FILE = 'experimentLog.json';
const MAX_ENTRIES = 1000;

/**
 * The log's surface.
 *
 * Named so a consumer can depend on the *capability* rather than on
 * `ReturnType<typeof createExperimentLog>` — the learning pipeline takes only
 * `listSessions` and `listExperiments`, and saying so here keeps that narrowing
 * from having to be re-derived at every call site.
 */
export interface ExperimentLog {
	append(entry: Omit<ExperimentLogEntry, 'id' | 'timestamp'>): Promise<ExperimentLogEntry>;
	listSessions(): Promise<readonly ExperimentSession[]>;
	listExperiments(sessionId: string): Promise<readonly Experiment[]>;
	getSession(sessionId: string): Promise<ExperimentSession | undefined>;
	getExperiment(experimentId: string): Promise<Experiment | undefined>;
	clear(): Promise<void>;
}

export function createExperimentLog(store: FileDataStore): ExperimentLog {
	const rootPath = store.rootPath;
	const logPath = join(rootPath, LOG_FILE);

	async function readLog(): Promise<ExperimentLogFile> {
		try {
			const raw = await readFile(logPath, 'utf8');
			const parsed = JSON.parse(raw) as ExperimentLogFile;
			if (parsed.version === 1 && Array.isArray(parsed.entries)) {
				return parsed;
			}
		} catch {
			// Missing or corrupt → start fresh
		}
		return { version: 1 as const, entries: [] };
	}

	async function writeLog(log: ExperimentLogFile): Promise<void> {
		await writeFileAtomic(logPath, JSON.stringify(log, null, '\t'));
	}

	// Reconstruct sessions from log entries
	function reconstructSessions(log: ExperimentLogFile): ExperimentSession[] {
		const sessions = new Map<string, ExperimentSession>();

		for (const entry of log.entries) {
			if (entry.type === 'session-start') {
				const payload = entry.payload as ExperimentSession;
				sessions.set(payload.id, { ...payload });
			} else if (entry.type === 'experiment-start') {
				const session = sessions.get(entry.sessionId);
				if (session) {
					const payload = entry.payload as Experiment;
					const updatedSession = {
						...session,
						experiments: [...session.experiments, payload],
						updatedAt: entry.timestamp,
					};
					sessions.set(session.id, updatedSession);
				}
			} else if (entry.type === 'evidence' || entry.type === 'evaluation') {
				const session = sessions.get(entry.sessionId);
				if (session && entry.experimentId) {
					const expIndex = session.experiments.findIndex((e) => e.id === entry.experimentId);
					if (expIndex >= 0) {
						const experiments = [...session.experiments];
						const exp = experiments[expIndex];
						let updatedExp: Experiment;
						if (entry.type === 'evidence') {
							updatedExp = {
								...exp,
								evidence: [...exp.evidence, entry.payload as Evidence],
							};
						} else {
							updatedExp = {
								...exp,
								evaluation: entry.payload as ExperimentEvaluation,
							};
						}
						experiments[expIndex] = updatedExp;
						sessions.set(session.id, { ...session, experiments, updatedAt: entry.timestamp });
					}
				}
			} else if (entry.type === 'session-end') {
				const session = sessions.get(entry.sessionId);
				if (session) {
					const payload = entry.payload as { status: ExperimentSession['status']; consumption: BudgetConsumption };
					sessions.set(session.id, {
						...session,
						status: payload.status,
						consumption: payload.consumption,
						updatedAt: entry.timestamp,
					});
				}
			}
		}

		return Array.from(sessions.values());
	}

	return {
		async append(entry) {
			const log = await readLog();
			const now = new Date().toISOString();
			const fullEntry: ExperimentLogEntry = {
				...entry,
				id: `exp-log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				timestamp: now,
			};
			const updated: ExperimentLogFile = {
				version: 1,
				entries: [...log.entries, fullEntry].slice(-MAX_ENTRIES),
			};
			await writeLog(updated);
			return fullEntry;
		},

		async listSessions() {
			const log = await readLog();
			return reconstructSessions(log);
		},

		async listExperiments(sessionId) {
			const log = await readLog();
			const sessions = reconstructSessions(log);
			const session = sessions.find((s) => s.id === sessionId);
			return session?.experiments ?? [];
		},

		async getSession(sessionId) {
			const log = await readLog();
			const sessions = reconstructSessions(log);
			return sessions.find((s) => s.id === sessionId);
		},

		async getExperiment(experimentId) {
			const log = await readLog();
			const sessions = reconstructSessions(log);
			for (const session of sessions) {
				const exp = session.experiments.find((e) => e.id === experimentId);
				if (exp) return exp;
			}
			return undefined;
		},

		async clear() {
			await writeLog({ version: 1, entries: [] });
		},
	};
}

/** Builds a log entry for session start. */
export function buildSessionStartEntry(session: ExperimentSession): Omit<ExperimentLogEntry, 'id' | 'timestamp'> {
	return {
		sessionId: session.id,
		experimentId: undefined,
		type: 'session-start',
		payload: session,
	};
}

/** Builds a log entry for experiment start. */
export function buildExperimentStartEntry(experiment: Experiment): Omit<ExperimentLogEntry, 'id' | 'timestamp'> {
	return {
		sessionId: experiment.sessionId,
		experimentId: experiment.id,
		type: 'experiment-start',
		payload: experiment,
	};
}

/** Builds a log entry for evidence. */
export function buildEvidenceEntry(experiment: Experiment, evidence: Evidence): Omit<ExperimentLogEntry, 'id' | 'timestamp'> {
	return {
		sessionId: experiment.sessionId,
		experimentId: experiment.id,
		type: 'evidence',
		payload: evidence,
	};
}

/** Builds a log entry for evaluation. */
export function buildEvaluationEntry(experiment: Experiment, evaluation: ExperimentEvaluation): Omit<ExperimentLogEntry, 'id' | 'timestamp'> {
	return {
		sessionId: experiment.sessionId,
		experimentId: experiment.id,
		type: 'evaluation',
		payload: evaluation,
	};
}

/** Builds a log entry for session end. */
export function buildSessionEndEntry(
	session: ExperimentSession,
	status: ExperimentSession['status'],
	consumption: BudgetConsumption
): Omit<ExperimentLogEntry, 'id' | 'timestamp'> {
	return {
		sessionId: session.id,
		experimentId: undefined,
		type: 'session-end',
		payload: { status, consumption },
	};
}