/**
 * Orchestration logging: records task classification, model selection, strategy,
 * attempts, and results for later analysis and skill evolution.
 *
 * Uses a simple JSON file under the data directory. No new storage infrastructure.
 * The log is append-only, one entry per sendMessage call.
 */

import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../adapters/local/writeFileAtomic';
import type { FileDataStore } from '../adapters/local/fileDataStore';
import type { TaskClassification } from './taskDiscovery';
import type { OrchestrationAttempt, OrchestrationStrategy } from './orchestrator';
import type { SelectableModel } from './modelSelector';
import type { RoutingDecisionReport } from './decisionReport';

export interface OrchestrationLogEntry {
	readonly id: string;
	readonly timestamp: string;
	readonly conversationId: string;
	readonly task: TaskClassification;
	readonly strategy: OrchestrationStrategy;
	readonly primaryModel: string | undefined; // "providerId:modelId"
	readonly attempts: readonly OrchestrationAttempt[];
	readonly result: 'success' | 'failed' | 'cancelled' | 'exhausted';
	readonly finalModel: string | undefined; // "providerId:modelId" of the model that succeeded (or last tried)
	readonly summary: string;
	/**
	 * O relatório da decisão de roteamento.
	 *
	 * Ausente quando o turno não chegou a decidir (recusa antes do plano). O
	 * relatório não contém conversa, chave nem cabeçalho — ver
	 * `decisionReport.ts`.
	 */
	readonly decision?: RoutingDecisionReport;
}

/** The shape of the log file on disk. */
interface OrchestrationLogFile {
	readonly version: 1;
	readonly entries: readonly OrchestrationLogEntry[];
}

const LOG_FILE = 'orchestrationLog.json';
const MAX_ENTRIES = 500; // Bounded to prevent unbounded growth

/**
 * Creates a log handle backed by a JSON file in the data directory.
 */
export function createOrchestrationLog(store: FileDataStore): {
	append: (entry: Omit<OrchestrationLogEntry, 'id' | 'timestamp'>) => Promise<OrchestrationLogEntry>;
	list: (filter?: { readonly conversationId?: string; readonly limit?: number }) => Promise<readonly OrchestrationLogEntry[]>;
	clear: () => Promise<void>;
} {
	// The store's root path is private, but we can derive the log path from it.
	// FileDataStore uses a rootPath; the log goes in the same directory as models.json.
	const rootPath = store.rootPath;
	const logPath = join(rootPath, LOG_FILE);

	async function readLog(): Promise<OrchestrationLogFile> {
		try {
			const raw = await readFile(logPath, 'utf8');
			const parsed = JSON.parse(raw) as OrchestrationLogFile;
			if (parsed.version === 1 && Array.isArray(parsed.entries)) {
				return parsed;
			}
		} catch {
			// Missing or corrupt → start fresh
		}
		return { version: 1 as const, entries: [] };
	}

	async function writeLog(log: OrchestrationLogFile): Promise<void> {
		await writeFileAtomic(logPath, JSON.stringify(log, null, '\t'));
	}

	return {
		async append(entry) {
			const log = await readLog();
			const now = new Date().toISOString();
			const id = `log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			// O log é quem possui a identidade da execução, e o relatório a
			// recebe aqui. Fazer isso no `append` evita dois ids para a mesma
			// execução: um que a janela conhece e outro que o relatório tem.
			const decision =
				entry.decision === undefined ? undefined : { ...entry.decision, executionId: id };
			const fullEntry: OrchestrationLogEntry = {
				...entry,
				...(decision !== undefined ? { decision } : {}),
				id,
				timestamp: now,
			};
			const updated: OrchestrationLogFile = {
				version: 1,
				entries: [...log.entries, fullEntry].slice(-MAX_ENTRIES),
			};
			await writeLog(updated);
			return fullEntry;
		},

		async list(filter) {
			const log = await readLog();
			let entries = log.entries;
			if (filter?.conversationId !== undefined) {
				entries = entries.filter((e) => e.conversationId === filter.conversationId);
			}
			if (filter?.limit !== undefined) {
				entries = entries.slice(-filter.limit);
			}
			return entries;
		},

		async clear() {
			await writeLog({ version: 1, entries: [] });
		},
	};
}

/**
 * Builds a log entry from the orchestration result.
 *
 * ## O texto da conversa não entra
 *
 * A classificação da tarefa carrega `primaryGoal`, que é a primeira frase do
 * que o usuário escreveu. Isso é **conteúdo de conversa**, e o log de
 * orquestração é um arquivo que sobrevive à conversa. Por isso o objetivo
 * vai gravado vazio: o que o log precisa saber é a *classificação* — domínio,
 * complexidade, capacidades exigidas, confiança — e não o texto que a
 * produziu.
 *
 * O relatório de decisão, que mora na mesma entrada, tem a mesma regra: ele
 * descreve a decisão, não o pedido.
 */
export function buildLogEntry(
	conversationId: string,
	task: TaskClassification,
	strategy: OrchestrationStrategy,
	primaryModel: SelectableModel | undefined,
	attempts: readonly OrchestrationAttempt[],
	finalModel: SelectableModel | undefined,
	result: OrchestrationLogEntry['result'],
	decision?: RoutingDecisionReport,
): Omit<OrchestrationLogEntry, 'id' | 'timestamp'> {
	const primaryStr = primaryModel !== undefined ? `${primaryModel.providerId}:${primaryModel.modelId}` : undefined;
	const finalStr = finalModel !== undefined ? `${finalModel.providerId}:${finalModel.modelId}` : undefined;
	const summary = [
		`strategy=${strategy}`,
		`task=${task.domain}:${task.complexity}`,
		`primary=${primaryStr ?? 'auto'}`,
		`attempts=${attempts.length}`,
		`result=${result}`,
		`final=${finalStr ?? 'none'}`,
	].join('; ');

	return {
		conversationId,
		// O objetivo é o texto do usuário: ele fica de fora do arquivo.
		task: { ...task, primaryGoal: '' },
		strategy,
		primaryModel: primaryStr,
		attempts,
		result,
		finalModel: finalStr,
		summary,
		...(decision !== undefined ? { decision } : {}),
	};
}