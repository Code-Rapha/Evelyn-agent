/**
 * A montagem do Core, em um lugar só.
 *
 * ## Por que este arquivo existe
 *
 * O Core era montado dentro do host do Electron, e só lá. Isso significava
 * que um segundo host — uma API local, um servidor web — teria de montar as
 * mesmas peças de novo: o mesmo `FileStateStore`, o mesmo `FileSecretStore`,
 * o mesmo `FileDataStore`, o mesmo `ChatSession`. Duas montagens divergem
 * silenciosamente: uma lê a configuração de um jeito e a outra de outro, e o
 * sintoma aparece como "a interface mostra uma coisa e o chat faz outra".
 *
 * Aqui a montagem é **uma só**, e os hosts a consomem.
 *
 * ## O que NÃO é a montagem
 *
 * Isto não é o Core: é a montagem *dele*. O Core continua em `src/core`, a
 * fachada da aplicação continua em `src/desktop/chatSession.ts`, e os
 * adaptadores de arquivo continuam em `src/adapters/local`. Nada disso foi
 * movido, renomeado ou reescrito — a montagem apenas deixou de estar escrita
 * dentro de um arquivo de host.
 *
 * ## O que a montagem entrega
 *
 * As peças do Core, já ligadas entre si: o `logger`, os serviços de memória e
 * de skills, os logs de aprendizagem, e a `ChatSession` — que é a fachada que
 * o resto do app conhece.
 *
 * ## O que fica com o host
 *
 * O que é do host, não do Core: a janela, o IPC, o `status()` que reporta a
 * versão do Electron, e a emissão de eventos para a janela. Isso continua no
 * `main.ts` do desktop — e o futuro host web trará o equivalente dele.
 */
import { join } from 'node:path';

import { LoggingService, type LogSink } from '../core/logging';
import { ConsoleLogSink } from '../adapters/local/consoleLogSink';
import { ProviderConfigService } from '../core/providers/config';
import { FileSecretStore } from '../adapters/local/fileSecretStore';
import { FileStateStore } from '../adapters/local/fileStateStore';
import { FileDataStore, defaultDataStoreRoot } from '../adapters/local/fileDataStore';
import type { WritePort } from '../adapters/local/writePort';
import type { LocalInstance } from '../desktop/localInstance';
import { FileStorageService } from '../adapters/local/fileStorageService';
import { createFileMemoryService } from '../core/memory/fileMemoryService';
import { createFileSkillService } from '../core/skill/fileSkillService';
import { createSkillEvolutionStore } from '../core/skill/skillEvolutionStore';
import { createSkillEvolutionService } from '../core/skill/skillEvolutionService';
import { createAutoSkillStore } from '../core/skill/autoSkillStore';
import { createAutoSkillService } from '../core/skill/autoSkillService';
import { createExperimentLog } from '../desktop/experimentLog';
import { createEvaluationLog } from '../desktop/evaluationLog';
import { createOrchestrationLog } from '../desktop/orchestrationLog';
import { scanForSkillImprovements } from '../desktop/learningPipeline';
import { ChatSession, DEFAULT_ROUTE_POLICY } from '../desktop/chatSession';
import { createModelGuidanceStore } from '../desktop/modelGuidance';
import type { StorageLock } from './storageLock';
import type { FetchLike } from '../core/providers/openaiCompatible';

/** How the assembly can be told to do its job. */
export interface AssembleOptions {
	/**
	 * Where the data lives.
	 *
	 * Absent means the default root — the same one the desktop has always
	 * used, so the assembly without options is byte-for-byte the assembly the
	 * desktop did before.
	 */
	readonly rootPath?: string;
	/**
	 * The scope the log lines carry.
	 *
	 * The desktop says `seshyina.desktop`; another host says its own. It is
	 * an option because the scope names the *host*, and the Core does not know
	 * which host it is serving.
	 */
	readonly logScope?: string;
	/**
	 * Where the log lines go.
	 *
	 * Absent means the console — which is what the desktop has always used, and
	 * what a local server run from a terminal wants too. A host that needs
	 * somewhere else (a file, a test that wants silence) says so.
	 */
	readonly logSink?: LogSink;
	/**
	 * Como o histórico grava um arquivo (R4Q). Ausente: `writeFileAtomic`.
	 *
	 * Testes injetam uma porta que falha de forma controlada; nenhum código de
	 * produção passa esta opção.
	 */
	readonly writeFile?: WritePort;
	/**
	 * O que o host pede ao sistema para confirmar que há **uma** instância do
	 * app (DEV-6).
	 *
	 * Ausente em teste: o host não consulta nada e o modo DEV não é ativável
	 * pela interface. Em produção é `readLocalInstance` do `main.ts`.
	 */
	readonly readLocalInstance?: () => Promise<LocalInstance>;
	/**
	 * O `fetch` que a sessão usa para falar com os provedores.
	 *
	 * Ausente significa o `fetch` global — o comportamento do desktop. Um
	 * teste injeta o seu e nenhuma porta é aberta.
	 */
	readonly fetchImpl?: FetchLike;
	/**
	 * The exclusive hold on the root, already taken by the host.
	 *
	 * Absent means no lock — which is what the desktop does today. Two hosts
	 * on one root would otherwise both mount, both write, and lose each
	 * other's writes; the lock is the one place that coordinates them.
	 *
	 * It arrives **taken** rather than as a request: taking it is
	 * asynchronous (`acquireStorageLock` opens a file with `wx`), and this
	 * function is not. A host that wants exclusivity awaits the acquisition
	 * and passes the result — so there is no path where a host asks for the
	 * root and gets an assembly without it.
	 */
	readonly lock?: {
		/** Which host it is, for the log line. */
		readonly host: string;
		/** The root, already taken — see `acquireStorageLock`. */
		readonly held: StorageLock;
	};
}

/**
 * The Core, assembled.
 *
 * Every part is public on purpose: the host reads what it needs (the session,
 * the skill service, the learning history) and the assembly keeps the wiring
 * between them in one place.
 */
export interface AssembledCore {
	/** Where the data lives. */
	readonly root: string;
	readonly logger: LoggingService;
	readonly storage: FileStorageService;
	readonly memoryService: ReturnType<typeof createFileMemoryService>;
	readonly skillService: ReturnType<typeof createFileSkillService>;
	/**
	 * The only writer of a live skill on behalf of learning.
	 *
	 * Held next to the skill service because the two are not independent: this
	 * one reaches the other, and only after an approval the user gave. Nothing
	 * else in the app may call `activateProposal` or `rollbackToVersion`.
	 */
	readonly skillEvolution: ReturnType<typeof createSkillEvolutionService>;
	/**
	 * The automatic learner: a new skill, from a repeated read-only procedure,
	 * activated with an `auto` decision when the user has the switch on.
	 *
	 * It is the same writer as `skillEvolution` — it calls `createProposal`,
	 * `approveProposal` and `activateProposal` rather than reaching the file —
	 * so an automatically learned skill is in the same history as a manual one
	 * and says who decided.
	 */
	readonly autoSkills: ReturnType<typeof createAutoSkillService>;
	/** The transcript store. The same one the logs read. */
	readonly history: FileDataStore;
	/**
	 * The histories the scan reads.
	 *
	 * Same `FileDataStore` as the transcript and the same logs the
	 * experimentation layer already writes, so "analisar o histórico" reads what
	 * was actually recorded rather than a copy kept for the analysis.
	 *
	 * A missing log is not an error at construction: a fresh install has none of
	 * them, and the scan reports an empty history rather than failing to start.
	 */
	readonly learningHistory: {
		readonly experimentLog: ReturnType<typeof createExperimentLog>;
		readonly evaluationLog: ReturnType<typeof createEvaluationLog>;
		readonly orchestrationLog: {
			list: (
				filter?: { limit?: number },
			) => Promise<readonly import('../desktop/orchestrationLog').OrchestrationLogEntry[]>;
		};
	};
	/** The facade the whole app knows. */
	readonly chat: ChatSession;
	/**
	 * Reads the history and reports what looks improvable.
	 *
	 * Returns the reading rather than acting on it. Proposals are filed by a
	 * separate call, and even then arrive `pending` — "analisar" cannot become
	 * "alterar" through this path.
	 *
	 * Fingerprints already sitting on the user's desk are passed in, so a rescan
	 * reports what is new rather than re-raising what was already asked.
	 */
	scanSkillHistory(): Promise<unknown>;
	/**
	 * The exclusive hold on the root, when the host asked for one.
	 *
	 * Absent when no lock was requested. The host releases it when it shuts
	 * down; while it lives, no other host can mount the same root.
	 */
	readonly lock?: StorageLock;
}

/**
 * Assembles the Core.
 *
 * The pieces are the same ones the desktop has always used: the local file
 * adapters, the same root, and the same `ChatSession`. A provider configured
 * here survives a restart, and so does the conversation.
 */
export function assembleCore(options: AssembleOptions = {}): AssembledCore {
	const root = options.rootPath ?? defaultDataStoreRoot();
	// Console-backed because a desktop run is also a terminal run: the log is
	// readable while developing, and `LoggingService` still redacts.
	const logger = new LoggingService(options.logSink ?? new ConsoleLogSink(), {
		scope: options.logScope ?? 'seshyina.desktop',
	});
	const lock = options.lock?.held;

	// Initialize storage service for memory and skills
	const storage = new FileStorageService({ rootPath: root });
	// Initialize synchronously - the storage service's initialize() creates directories
	// We'll call it asynchronously in an init method
	const memoryService = createFileMemoryService(storage);
	const skillService = createFileSkillService(storage);
	const skillEvolution = createSkillEvolutionService({
		skillService,
		store: createSkillEvolutionStore(storage),
		// The user, by name of the window they are sitting at. Recorded on
		// every decision so an activation in the history can always be traced
		// back to a person rather than to "something approved it".
		defaultDecider: 'the user',
	});
	// The automatic learner is built over the same two pieces: it files and
	// activates through `skillEvolution`, and its own file only holds the switch
	// and the receipts. There is no second path to a live skill.
	const autoSkills = createAutoSkillService({
		skillService,
		evolution: skillEvolution,
		store: createAutoSkillStore(storage),
	});

	const history = new FileDataStore({
		rootPath: root,
		...(options.writeFile !== undefined ? { writeFile: options.writeFile } : {}),
	});
	const learningHistory = {
		experimentLog: createExperimentLog(history),
		evaluationLog: createEvaluationLog(history),
		orchestrationLog: orchestrationLogForLearning(history),
	};

	const chat = new ChatSession({
		...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
		config: new ProviderConfigService(
			new FileStateStore({ filePath: join(root, 'state.json') }),
		),
		secrets: new FileSecretStore({ filePath: join(root, 'secrets.json') }),
		history,
		logger,
		memoryService,
		skillService,
		autoSkills,
		// Routing is on for the desktop host. The engine owns retries, the
		// per-attempt timeouts and the fallback decision; the session owns
		// the breaker so an endpoint's health survives a turn. Paid models
		// stay excluded: `allowPaid` is left at its default of false.
		routing: { policy: DEFAULT_ROUTE_POLICY },
		// As preferências de modelo que a Evelyn registra no diálogo fixo. Ficam
		// na raiz do store, ao lado de `router-config.json`, e a sessão as lê
		// a cada turno.
		modelGuidance: createModelGuidanceStore(root),
		...(options.readLocalInstance !== undefined ? { readLocalInstance: options.readLocalInstance } : {}),
	});

	return {
		root,
		logger,
		storage,
		memoryService,
		skillService,
		skillEvolution,
		autoSkills,
		history,
		learningHistory,
		chat,
		scanSkillHistory: () => scanSkillHistory({ skillService, skillEvolution, learningHistory }),
		...(lock !== undefined ? { lock } : {}),
	};
}

/**
 * The orchestration log, for the learning scan.
 *
 * Opened over the same root rather than shared with the session: the scan is a
 * read-only consumer and the session is the only writer, so handing the scan
 * its own handle keeps "reading the history" structurally unable to append to
 * it.
 */
function orchestrationLogForLearning(history: FileDataStore) {
	return { list: (filter?: { limit?: number }) => createOrchestrationLog(history).list(filter) };
}

/** The parts the skill scan reads. */
interface SkillScanParts {
	readonly skillService: ReturnType<typeof createFileSkillService>;
	readonly skillEvolution: ReturnType<typeof createSkillEvolutionService>;
	readonly learningHistory: AssembledCore['learningHistory'];
}

/**
 * Reads the history and reports what looks improvable.
 *
 * Returns the reading rather than acting on it. Proposals are filed by a
 * separate call, and even then arrive `pending` — "analisar" cannot become
 * "alterar" through this path.
 *
 * Fingerprints already sitting on the user's desk are passed in, so a rescan
 * reports what is new rather than re-raising what was already asked.
 */
async function scanSkillHistory(parts: SkillScanParts): Promise<unknown> {
	const open = await openFingerprintSet(parts.skillEvolution);
	const skills = await parts.skillService.listSkills();
	return scanForSkillImprovements(parts.learningHistory, {
		knownFingerprints: [...open],
		...(skills.ok
			? {
					existingSkills: skills.skills.map((skill) => ({
						id: skill.id,
						instructions: skill.instructions,
					})),
				}
			: {}),
	});
}

/** Fingerprints of proposals still waiting on a decision. */
async function openFingerprintSet(
	evolution: ReturnType<typeof createSkillEvolutionService>,
): Promise<ReadonlySet<string>> {
	const result = await evolution.listProposals('pending');
	return new Set(result.proposals.map((proposal) => proposal.fingerprint));
}
