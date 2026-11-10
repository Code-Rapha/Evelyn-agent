/**
 * Local filesystem/JSON implementation of the `DataStore` port.
 *
 * Layout under the storage root (default `~/.modelhub/seshyina`):
 *
 *   seshyina/
 *     projects.json            { "version": 1, "projects": [ … ] }
 *     conversations/
 *       <conversationId>.json  { …, "messages": [ … ] }
 *
 * One file per conversation, not one file for everything, because a transcript
 * is the only thing here that grows without bound: appending a message rewrites
 * one conversation's file and touches nothing else. Projects are few and always
 * read as a whole, so a single file is simpler than a directory.
 *
 * Consistency model: the adapter loads both indexes once and serializes every
 * write through one promise chain, so two concurrent callers cannot interleave a
 * read-modify-write and lose an append. Two *processes* against the same root
 * would still race; that is out of scope for a local-first product with one
 * window, and it is stated here rather than papered over.
 *
 * Corruption policy, per file type:
 *
 * - A *missing* file is an empty store. A first run must not fail.
 * - A *malformed* `projects.json` is treated as empty and rewritten on the next
 *   write. Losing a project list is recoverable; refusing to start is not.
 * - A *malformed* conversation file is skipped by `listConversations`, so one
 *   damaged transcript cannot hide the rest, and raises `StorageError` from
 *   `getConversation`, where the caller explicitly named that file. Damaged
 *   files are left on disk rather than deleted.
 *
 * No secret reaches this adapter: it stores projects, transcripts and non-secret
 * state only, and `assertNoSecretFields` refuses secret-shaped field names on
 * the way in.
 */
import { randomUUID } from 'node:crypto';
import { readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { StorageError, ValidationError } from '../../core/errors';
import type { ToolCallRequest } from '../../core/providers/chat/types';
import { writeFileAtomic } from './writeFileAtomic';
import type { WritePort } from './writePort';
import {
	assertNoSecretFields,
	findMessageByRequestId,
	type AppendMessageInput,
	type ConversationMessage,
	type ConversationRecord,
	type ConversationRole,
	type ConversationSummary,
	type ConversationDeleteOutcome,
	type CreateConversationInput,
	type CreateProjectInput,
	type DataStore,
	type ProjectRecord,
	type UpdateProjectInput,
} from '../../core/storage/types/dataStore';
import {
	MODEL_OBSERVATION_LIMIT,
	mergeModelCapabilities,
	type CostUnit,
	type InputModality,
	type ModelAccess,
	type ModelCapabilities,
	type ModelCapabilitiesPatch,
	type ModelCatalogEntry,
	type ModelCatalogKey,
	type ModelLimits,
	type ModelMetadataInput,
	type ModelMetadataOrigin,
	type ModelMetadataSource,
	type ModelObservation,
	type ModelPricing,
	type OutputModality,
	type PriceSource,
	type SaveModelCatalogInput,
} from '../../core/storage/types/modelCatalog';
import type { TokenUsage as ModelUsage } from '../../core/providers/chat/types';
import {
	attemptIdFor,
	resolveAttemptAccounting,
	summarizeExecution,
	type AttemptRecord,
	type ConsumptionLedgerPort,
	type ConsumptionQuery,
	type ExecutionLedgerEntry,
	type ExecutionRecord,
	type ExecutionStatus,
	type ExecutionTotals,
	type RecordAttemptInput,
	type RecordExecutionInput,
	type TokenCounts,
} from '../../core/storage/types/consumption';
import {
	parseConsumptionLedger,
	summarizeStoredExecution,
	totalsFor,
} from '../../core/storage/consumptionLedger';
import {
	parseSpendingLimits,
} from '../../core/budget/limitsLedger';
import {
	scopeIdFor,
	type SaveSpendingLimitInput,
	type SpendingLimit,
} from '../../core/budget/policy';
import {
	parseProviderModels,
} from '../../core/storage/providerModelsLedger';
import { parseAccessPolicy, serializeAccessPolicy } from '../../core/storage/accessPolicyLedger';
import {
	parseRouterConfig,
	serializeRouterConfig,
} from '../../core/storage/routerConfigLedger';
import {
	validateRouterConfig,
	type RouterConfig,
} from '../../core/providers/routing/config';
import type { ModelAccessPolicyRecord } from '../../core/catalog/policy';
import {
	applyFailure,
	applyListing,
} from '../../core/storage/providerModelsRules';
import type {
	DiscoveredModel,
	DiscoveredQuotaRecord,
	DiscoveryOutcome,
	ProviderModelCatalogPort,
} from '../../core/storage/types/providerModels';
import { STORAGE_ROOT_NAME } from '../../core/storage/types';
import { RouterConfigStore, type RouterConfigOrigin } from '../../core/storage/routerConfigStore';
import { DEFAULT_DISCOVERY_TTL } from '../../core/storage/types/providerModels';

/** The TTLs the store applies when it records a listing. */
const DISCOVERY_TTL = DEFAULT_DISCOVERY_TTL;

/** The identity of one discovered model, as a map key. */
function discoveryKeyOf(key: { readonly providerId: string; readonly modelId: string }): string {
	return JSON.stringify([key.providerId, key.modelId]);
}

/** File holding the project list. */
export const PROJECTS_FILE = 'projects.json';
/**
 * File holding the model catalog.
 *
 * Its own file, and that is the whole answer to "does removing a model's
 * metadata un-configure it": it cannot, because the provider connection lives
 * in `state.json` and its key in `secrets.json`, and nothing here opens either.
 */
export const MODELS_FILE = 'models.json';
/**
 * File holding the consumption ledger.
 *
 * Separate from `models.json` for the reason the catalog is separate from
 * `state.json`: the catalog is a small, bounded window that is rewritten on
 * every observation, and the ledger is an append-only history that only grows.
 * Putting a growing history in a file that every latency measurement rewrites
 * would make each chat turn rewrite the entire history.
 *
 * It holds ids, numbers and timestamps. No prompt, answer, key or transcript
 * ever reaches it; see `core/storage/types/consumption`.
 */
export const CONSUMPTION_FILE = 'consumption.json';
/**
 * File holding the spending limits.
 *
 * Its own file, for the same reason the ledger has one: the limits are a handful
 * of records the user edits, and rewriting them must not rewrite the history
 * they bound. They hold no secret — a currency, an amount and a scope.
 */
export const SPENDING_LIMITS_FILE = 'spending-limits.json';
/**
 * File holding what the providers published about their own models.
 *
 * Its own file, and deliberately not `models.json`. The catalog is the user's
 * declaration and the runs' measurements - small, hand-edited, never
 * overwritten by an HTTP answer. This file is fed by `/models` and by real
 * calls, is validated by TTLs, and may go stale or fail to refresh without
 * touching either the declaration or the usage history. Keeping them apart is
 * what lets "this model is listed" and "the user says it costs X" both be true
 * and both stay legible.
 *
 * It holds ids, numbers, dates and URLs. A provider that publishes prices in
 * `/models` has already sent them over an authenticated request; nothing here
 * needs, reads or stores a key.
 */
export const PROVIDER_MODELS_FILE = 'provider-models.json';
/**
 * File holding the model access policy and the chosen price source.
 *
 * Its own file for the same reason the limits have one: this is a decision
 * about selection, not a fact about a model. Keeping it out of `models.json`
 * is what lets "use only free models" or "use the provider's price" be undone
 * by changing one word, because the declared price itself was never touched.
 */
export const ACCESS_POLICY_FILE = 'access-policy.json';
/**
 * File holding the router configuration.
 *
 * Its own file, for the same reason the access policy has one: this is a
 * **decision** (where the request goes, and whether it goes at all), not a
 * fact about a model. Keeping it apart from `models.json` is what makes
 * "turn the router off" and "put it back the way it was" a single field
 * instead of a rewrite of somebody else's data.
 *
 * It holds no secret: a switch, a mode and a provider **id**. The key stays
 * in the `SecretStore`.
 */
export const ROUTER_CONFIG_FILE = 'router-config.json';
/** Directory holding conversation transcripts. */
export const CONVERSATIONS_DIR = 'conversations';
/** Directory under the storage root that this adapter owns. */
export const DATA_DIR = 'seshyina';

/** Bumped when the on-disk shape changes incompatibly. */
const SCHEMA_VERSION = 1;

export type { ConversationDeleteOutcome };

interface ProjectsFile {
	readonly version: number;
	readonly projects: readonly ProjectRecord[];
}

interface ConversationFile {
	readonly version: number;
	readonly id: string;
	readonly providerId?: string;
	readonly projectId?: string;
	readonly title: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	/** Permanente: a exclusão é recusada. Ausente é o caso comum. */
	readonly pinned?: boolean;
	readonly messages: readonly ConversationMessage[];
}

interface ModelsFile {
	readonly version: number;
	readonly models: readonly ModelCatalogEntry[];
}

/** The ledger file: executions and attempts, both append-only in spirit. */
interface ConsumptionFile {
	readonly version: number;
	readonly executions: readonly ExecutionRecord[];
	readonly attempts: readonly AttemptRecord[];
}

/** The spending limits file. Small and rewritten as a whole. */
interface SpendingLimitsFile {
	readonly version: number;
	readonly limits: readonly SpendingLimit[];
}

/** The provider discovery file: what each provider published, and its quotas. */
interface ProviderModelsFile {
	readonly version: number;
	readonly models: readonly DiscoveredModel[];
	readonly quotas: readonly DiscoveredQuotaRecord[];
}

export interface FileDataStoreOptions {
	/**
	 * Root directory for the data. Defaults to `~/.modelhub/seshyina`.
	 *
	 * Absolute, and derived from `os.homedir()` rather than an env var, so a
	 * hostile `HOME` cannot redirect it. Tests pass an explicit temp path.
	 */
	readonly rootPath?: string;
	/** Injected in tests to make ids and timestamps predictable. */
	readonly generateId?: () => string;
	readonly now?: () => string;
	/**
	 * Como gravar um arquivo (R4Q). Padrão: `writeFileAtomic`.
	 *
	 * Injetável para um teste provar a falha de escrita de forma determinística
	 * sem que o store carregue um mecanismo de injeção no próprio objeto — ver
	 * `writePort.ts`.
	 */
	readonly writeFile?: WritePort;
	/**
	 * Avisos do adaptador — recuperação de configuração, por exemplo.
	 *
	 * Ausente, os avisos não vão a lugar nenhum: um teste não precisa de log,
	 * e o adaptador não inventa um. Quem quiser o aviso passa o seu.
	 */
	readonly onNotice?: (message: string, data?: Record<string, unknown>) => void;
}

export function defaultDataStoreRoot(): string {
	return join(homedir(), STORAGE_ROOT_NAME, DATA_DIR);
}

export class FileDataStore implements DataStore, ProviderModelCatalogPort {
	private readonly root: string;
	private readonly generateId: () => string;
	private readonly now: () => string;
	private readonly writeFile: WritePort;
	private readonly onNotice: ((message: string, data?: Record<string, unknown>) => void) | undefined;
	/** O store da última leitura do roteador, para a procedência. */
	private lastRouterStore: RouterConfigStore | undefined;

	/** The root directory this store operates in. Exposed for auxiliary files. */
	get rootPath(): string {
		return this.root;
	}

	/** Loaded lazily, so constructing the store touches no disk. */
	private projects: readonly ProjectRecord[] | undefined;
	/** Conversation metadata by id. Transcripts stay on disk until read. */
	private conversations: Map<string, ConversationSummary> | undefined;
	/**
	 * A lista acima veio de uma leitura **confirmada** do diretório (R4M)?
	 *
	 * `false` quando a primeira leitura falhou e o store seguiu com uma lista
	 * vazia: nesse estado, "não está na lista" **não** significa "não
	 * existe" — significa "não sei", e a exclusão não pode virar sucesso em
	 * cima dessa dúvida.
	 */
	private conversationsConfirmed = false;
	/**
	 * The model catalog, by composite key.
	 *
	 * A `Map` rather than a list because the same model may be described by two
	 * providers and every lookup has to distinguish them.
	 */
	private models: Map<string, ModelCatalogEntry> | undefined;
	/** The consumption ledger, by id. Both maps are loaded together. */
	private consumption: { executions: Map<string, ExecutionRecord>; attempts: Map<string, AttemptRecord> } | undefined;
	/** Spending limits by scope id. */
	private limits: Map<string, SpendingLimit> | undefined;
	/** What the providers published, by provider. Both maps load together. */
	private discovered: {
		models: Map<string, DiscoveredModel>;
		quotas: Map<string, DiscoveredQuotaRecord>;
	} | undefined;

	/** Serializes every write, so a read-modify-write cannot interleave. */
	private queue: Promise<unknown> = Promise.resolve();

	constructor(options: FileDataStoreOptions = {}) {
		this.root = options.rootPath ?? defaultDataStoreRoot();
		this.generateId = options.generateId ?? (() => randomUUID());
		this.now = options.now ?? (() => new Date().toISOString());
		this.writeFile = options.writeFile ?? writeFileAtomic;
		this.onNotice = options.onNotice;
	}

	// ── projects ────────────────────────────────────────────────────────────

	async listProjects(): Promise<readonly ProjectRecord[]> {
		return (await this.loadProjects()).map((project) => ({ ...project }));
	}

	async getProject(projectId: string): Promise<ProjectRecord | undefined> {
		const found = (await this.loadProjects()).find((project) => project.id === projectId);
		return found === undefined ? undefined : { ...found };
	}

	async createProject(input: CreateProjectInput): Promise<ProjectRecord> {
		assertNoSecretFields(input, 'project');
		const name = requireText(input.name, 'name');
		const rootPath = requireText(input.rootPath, 'rootPath');
		return this.queueWrite(async () => {
			const current = await this.loadProjects();
			const id = input.id ?? this.generateId();
			if (current.some((project) => project.id === id)) {
				throw new ValidationError(`Project "${id}" already exists`, { details: { projectId: id } });
			}
			const timestamp = input.createdAt ?? this.now();
			const project: ProjectRecord = { id, name, rootPath, createdAt: timestamp, updatedAt: timestamp };
			await this.saveProjects([...current, project]);
			return { ...project };
		});
	}

	async updateProject(projectId: string, input: UpdateProjectInput): Promise<ProjectRecord> {
		assertNoSecretFields(input, 'project');
		const name = input.name !== undefined ? requireText(input.name, 'name') : undefined;
		const rootPath = input.rootPath !== undefined ? requireText(input.rootPath, 'rootPath') : undefined;
		return this.queueWrite(async () => {
			const current = await this.loadProjects();
			const existing = current.find((project) => project.id === projectId);
			if (existing === undefined) {
				throw new StorageError(`No project with id "${projectId}"`, { details: { projectId } });
			}
			const updated: ProjectRecord = {
				...existing,
				...(name !== undefined ? { name } : {}),
				...(rootPath !== undefined ? { rootPath } : {}),
				updatedAt: this.now(),
			};
			await this.saveProjects(
				current.map((project) => (project.id === projectId ? updated : project)),
			);
			return { ...updated };
		});
	}

	/**
	 * Removes a project and, by cascade, the conversations that belong to it.
	 *
	 * A transcript whose project no longer exists cannot be listed meaningfully,
	 * so it goes with the project rather than lingering as an orphan.
	 */
	async deleteProject(projectId: string): Promise<boolean> {
		return this.queueWrite(async () => {
			const current = await this.loadProjects();
			const next = current.filter((project) => project.id !== projectId);
			if (next.length === current.length) {
				return false;
			}
			await this.saveProjects(next);

			const conversations = await this.loadConversations();
			for (const summary of conversations.values()) {
				if (summary.projectId === projectId) {
					await this.removeConversationFile(summary.id);
				}
			}
			return true;
		});
	}

	// ── conversations ───────────────────────────────────────────────────────

	async listConversations(
		filter: { readonly providerId?: string; readonly projectId?: string } = {},
	): Promise<readonly ConversationSummary[]> {
		const all = [...(await this.loadConversations()).values()].sort(byCreation);
		const filtered = all.filter((summary) => {
			if (filter.providerId !== undefined && summary.providerId !== filter.providerId) {
				return false;
			}
			if (filter.projectId !== undefined && summary.projectId !== filter.projectId) {
				return false;
			}
			return true;
		});
		return filtered.map((summary) => ({ ...summary }));
	}

	async getConversation(conversationId: string): Promise<ConversationRecord | undefined> {
		await this.loadConversations();
		const file = await this.readConversationFile(conversationId);
		return file === undefined ? undefined : toRecord(file);
	}

	async createConversation(input: CreateConversationInput): Promise<ConversationRecord> {
		assertNoSecretFields(input, 'conversation');
		// Both are validated when present and dropped when absent, so the stored
		// record names only the bindings that actually exist.
		if (input.providerId !== undefined) {
			requireText(input.providerId, 'providerId', 'A conversation');
		}
		if (input.projectId !== undefined) {
			requireText(input.projectId, 'projectId', 'A conversation');
		}
		const timestamp = input.createdAt ?? this.now();
		const file: ConversationFile = {
			version: SCHEMA_VERSION,
			id: input.id ?? this.generateId(),
			...(input.providerId !== undefined ? { providerId: input.providerId } : {}),
			...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
			title: input.title !== undefined && input.title.length > 0 ? input.title : 'New conversation',
			createdAt: timestamp,
			updatedAt: timestamp,
			messages: [],
		};
		// The disk write joins the queue: a create racing a delete or an append
		// must land in order, or the summary index and the files disagree.
		// Nothing inside calls `queueWrite` again, so this cannot deadlock.
		return this.queueWrite(async () => {
			await this.saveConversationFile(file);
			return toRecord(file);
		});
	}

	async appendMessage(
		conversationId: string,
		input: AppendMessageInput,
	): Promise<ConversationMessage> {
		const [stored] = await this.appendMessages(conversationId, [input]);
		// Non-null by construction: `appendMessages` returns early on an empty
		// batch, and this one is never empty.
		return stored as ConversationMessage;
	}

	/**
	 * Grava a mensagem do usuário de um turno, com idempotência explícita (R4Q).
	 *
	 * A chave é a **única** prova de repetição. Uma requisição que chega com
	 * uma chave já gravada não escreve nada e recebe a mensagem existente
	 * (`stored: false`): quem chama sabe que o envio já foi aceito antes e não
	 * deve executar o modelo de novo. Sem chave, toda chamada é uma intenção
	 * nova — dois envios com o mesmo texto gravam duas mensagens, como o
	 * usuário espera.
	 *
	 * A verificação e a gravação acontecem na mesma operação da fila: duas
	 * chamadas concorrentes com a mesma chave não conseguem ambas ver "ainda
	 * não existe".
	 */
	async appendUserMessage(
		conversationId: string,
		input: { readonly content: string; readonly requestId?: string },
	): Promise<{ readonly message: ConversationMessage; readonly stored: boolean }> {
		return this.queueWrite(async () => {
			const existing = await this.readConversationFile(conversationId);
			if (existing === undefined) {
				throw new StorageError(`No conversation with id "${conversationId}"`, {
					details: { conversationId },
				});
			}
			const repeated = findMessageByRequestId(existing.messages, input.requestId);
			if (repeated !== undefined) {
				return { message: repeated, stored: false };
			}
			const appended = this.toStoredMessage(
				{
					role: 'user',
					content: input.content,
					...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
				},
				existing.messages.length,
			);
			assertNoSecretFields({ role: 'user', content: input.content }, 'message');
			await this.saveConversationFile({
				...existing,
				updatedAt: this.now(),
				messages: [...existing.messages, appended],
			});
			return { message: appended, stored: true };
		});
	}

	async appendMessages(
		conversationId: string,
		inputs: readonly AppendMessageInput[],
	): Promise<readonly ConversationMessage[]> {
		if (inputs.length === 0) {
			return [];
		}
		return this.queueWrite(async () => {
			const existing = await this.readConversationFile(conversationId);
			if (existing === undefined) {
				throw new StorageError(`No conversation with id "${conversationId}"`, {
					details: { conversationId },
				});
			}
			const appended = inputs.map((input, offset) =>
				this.toStoredMessage(input, existing.messages.length + offset),
			);
			// Checked on the *input*, not on the built message: the built record
			// carries only declared fields, so an extra `password` would already
			// have been dropped and the guard would never see it. Rejecting here
			// tells the caller their record was wrong instead of quietly storing
			// something other than what they passed.
			for (const input of inputs) {
				assertNoSecretFields(input, 'message');
			}
			await this.saveConversationFile({
				...existing,
				updatedAt: this.now(),
				messages: [...existing.messages, ...appended],
			});
			return appended.map((message) => ({ ...message }));
		});
	}

	async deleteConversation(conversationId: string): Promise<ConversationDeleteOutcome> {
		// Inside the queue so the presence check and the removal are one step:
		// outside it, two concurrent deletes could both report `true`, and a
		// racing append could rewrite the file that was just removed. Nothing
		// inside calls `queueWrite` again, so this cannot deadlock.
		return this.queueWrite(async () => {
			const index = await this.loadConversations();
			if (!index.has(conversationId)) {
				// A lista diz que não há. Isso é "já ausente" só quando a lista
				// foi **confirmada** contra o diretório; quando veio de uma
				// leitura falha, devolver `absent` esconderia o erro atrás de
				// um sucesso (R4M).
				return this.conversationsConfirmed ? 'absent' : 'unknown';
			}
			// A marca é lida do arquivo e não do índice: o índice guarda o
			// resumo, e uma escrita de outro caminho pode tê-lo adiantado. A
			// recusa aqui é o segundo cadeado — a interface já não oferece o
			// botão, mas a exclusão também não pode atravessar por outro
			// chamador e apagar o diálogo permanente.
			const existing = await this.readConversationFile(conversationId);
			if (existing?.pinned === true) {
				throw new ValidationError(
					`A conversa "${conversationId}" é permanente e não pode ser excluída`,
					{ details: { conversationId, pinned: true } },
				);
			}
			await this.removeConversationFile(conversationId);
			return 'deleted';
		});
	}

	/**
	 * Marca ou desmarca a conversa como permanente.
	 *
	 * Mesma fila de escrita do rename: o campo é gravado junto com o título e o
	 * `updatedAt`, e duas escritas concorrentes não podem deixar uma cópia do
	 * arquivo sem a marca.
	 */
	async setConversationPinned(conversationId: string, pinned: boolean): Promise<ConversationRecord> {
		if (typeof pinned !== 'boolean') {
			throw new ValidationError('pinned must be a boolean', {
				details: { received: typeof pinned },
			});
		}
		assertNoSecretFields({ pinned }, 'conversation');
		return this.queueWrite(async () => {
			const existing = await this.readConversationFile(conversationId);
			if (existing === undefined) {
				throw new StorageError(`No conversation with id "${conversationId}"`, {
					details: { conversationId },
				});
			}
			// Desmarcar remove a chave, em vez de gravar `false`: o disco fica
			// com o mesmo formato das conversas que nunca foram marcadas.
			const { pinned: _descartado, ...semMarca } = existing;
			const updated: ConversationFile = pinned
				? { ...semMarca, updatedAt: this.now(), pinned: true }
				: { ...semMarca, updatedAt: this.now() };
			await this.saveConversationFile(updated);
			return toRecord(updated);
		});
	}

	async renameConversation(conversationId: string, title: string): Promise<ConversationRecord> {
		const name = requireText(title, 'conversation title', 'A conversation');
		return this.queueWrite(async () => {
			const existing = await this.readConversationFile(conversationId);
			if (existing === undefined) {
				throw new StorageError(`No conversation with id "${conversationId}"`, {
					details: { conversationId },
				});
			}
			const renamed: ConversationFile = { ...existing, title: name, updatedAt: this.now() };
			await this.saveConversationFile(renamed);
			return toRecord(renamed);
		});
	}

	/**
	 * Apaga as mensagens e mantém a conversa.
	 *
	 * ## Por que existe
	 *
	 * Um histórico que acumulou respostas que nunca chegaram — ou mensagens
	 * enviadas duas vezes porque a primeira pareceu ignorada — não tem
	 * conserto por dentro: o modelo lê o que está gravado, e cada turno novo
	 * carrega mais daquele lixo. Medido: "Preferências de modelo" chegou a 56
	 * mensagens em duas semanas, quatro delas seguidas do usuário e sem
	 * resposta.
	 *
	 * A conversa **permanente** é o caso que mais precisa disto: ela não tem
	 * lixeira de propósito, e sem um reset o único caminho era editar o disco
	 * à mão.
	 *
	 * O que fica: o id, o título, o provedor, o projeto e a marca de
	 * permanente. O que sai: as mensagens. `seq` recomeça em 0, como numa
	 * conversa nova — o modelo não deve ver buracos na numeração.
	 *
	 * O `systemPrompt` da conversa é uma mensagem de papel `system` e sai junto,
	 * então ele é **restaurado depois**, com o mesmo texto. Um diálogo de
	 * preferências que perdesse a instrução de sistema no reset passaria a
	 * responder como um chat comum.
	 */
	async resetConversation(conversationId: string): Promise<ConversationRecord> {
		return this.queueWrite(async () => {
			const existing = await this.readConversationFile(conversationId);
			if (existing === undefined) {
				throw new StorageError(`No conversation with id "${conversationId}"`, {
					details: { conversationId },
				});
			}
			const system = existing.messages.find((message) => message.role === 'system');
			const reset: ConversationFile = {
				...existing,
				updatedAt: this.now(),
				messages:
					system === undefined
						? []
						: [{ ...system, id: this.generateId(), seq: 0, createdAt: this.now() }],
			};
			await this.saveConversationFile(reset);
			return toRecord(reset);
		});
	}

	/**
	 * Replaces the conversation's single system message.
	 *
	 * Runs under the write lock and rewrites the whole transcript, so the
	 * resulting `seq` values stay contiguous from 0 — a system message spliced
	 * into the middle would otherwise leave the head of the file out of order.
	 *
	 * An empty string removes the prompt rather than storing a blank one: "send
	 * no instructions" and "send empty instructions" are different requests, and
	 * only the first is what a user clearing the field means.
	 */
	async setSystemPrompt(conversationId: string, content: string): Promise<ConversationRecord> {
		if (typeof content !== 'string') {
			throw new ValidationError('A system prompt must be a string', {
				details: { received: typeof content },
			});
		}
		return this.queueWrite(async () => {
			const existing = await this.readConversationFile(conversationId);
			if (existing === undefined) {
				throw new StorageError(`No conversation with id "${conversationId}"`, {
					details: { conversationId },
				});
			}

			// Drop every existing system message, not just the first: a transcript
			// written by an older version could hold more than one, and leaving
			// a second would send the model two different sets of instructions.
			const kept = existing.messages.filter((message) => message.role !== 'system');
			const prompt = content.trim();
			const next: readonly ConversationMessage[] =
				prompt.length === 0
					? kept
					: [
							{
								id: this.generateId(),
								seq: 0,
								role: 'system' as const,
								content: prompt,
								createdAt: this.now(),
							},
							...kept,
						];

			const updated: ConversationFile = {
				...existing,
				updatedAt: this.now(),
				// Re-numbered so `seq` stays a faithful position after the splice.
				messages: next.map((message, index) => ({ ...message, seq: index })),
			};
			await this.saveConversationFile(updated);
			return toRecord(updated);
		});
	}

	// ── model catalog ───────────────────────────────────────────────────────

	async listModelCatalog(
		filter: { readonly providerId?: string } = {},
	): Promise<readonly ModelCatalogEntry[]> {
		const all = [...(await this.loadModels()).values()].sort(byModelIdentity);
		const filtered = all.filter((entry) => {
			if (filter.providerId !== undefined && entry.providerId !== filter.providerId) {
				return false;
			}
			return true;
		});
		return filtered.map(copyEntry);
	}

	async getModelCatalogEntry(key: ModelCatalogKey): Promise<ModelCatalogEntry | undefined> {
		const found = (await this.loadModels()).get(catalogKey(key));
		return found === undefined ? undefined : copyEntry(found);
	}

	async saveModelCatalogEntry(input: SaveModelCatalogInput): Promise<ModelCatalogEntry> {
		assertNoSecretFields(input, 'model catalog entry');
		const identity = toIdentity(input);
		return this.queueWrite(async () => {
			const current = await this.loadModels();
			const existing = current.get(catalogKey(identity));
			const timestamp = this.now();
			const entry: ModelCatalogEntry = {
				...(existing ?? blankEntry(identity, timestamp)),
				// `undefined` spreads over an existing value, which is how a field
				// the caller sent as `null` — clear it — becomes unknown again.
				...(input.capabilities !== undefined
					? { capabilities: input.capabilities === null ? undefined : normalizeCapabilities(input.capabilities) }
					: {}),
				...(input.pricing !== undefined
					? { pricing: input.pricing === null ? undefined : normalizePricing(input.pricing) }
					: {}),
				...(input.limits !== undefined
					? { limits: input.limits === null ? undefined : normalizeLimits(input.limits) }
					: {}),
				...(input.model !== undefined
					? {
							model:
								input.model === null
									? undefined
									: mergeModelCapabilities(existing?.model, normalizeCapabilitiesPatch(input.model)),
						}
					: {}),
				...(input.metadata !== undefined
					? {
							metadata:
								input.metadata === null
									? undefined
									: {
											source: normalizeMetadataSource(input.metadata.source),
											...(input.metadata.updatedAt !== undefined
												? { updatedAt: requireTimestamp(input.metadata.updatedAt) }
												: existing?.metadata?.updatedAt !== undefined
													? { updatedAt: existing.metadata.updatedAt }
													: {}),
										},
						}
					: {}),
				...(input.notes !== undefined
					? { notes: input.notes === null ? undefined : requireNote(input.notes) }
					: {}),
				// Only a declared access changes here. `access` has no clear state
				// because `unknown` is one: sending it is how the user says so.
				...(input.access !== undefined ? { access: normalizeAccess(input.access) } : {}),
				updatedAt: timestamp,
			};
			// Replace rather than append, so re-describing a model cannot leave a
			// second record for the same pair behind the first one in file order.
			current.set(catalogKey(identity), entry);
			await this.saveModels([...current.values()]);
			return copyEntry(entry);
		});
	}

	async removeModelCatalogEntry(key: ModelCatalogKey): Promise<boolean> {
		const identity = toIdentity(key);
		return this.queueWrite(async () => {
			const current = await this.loadModels();
			if (!current.delete(catalogKey(identity))) {
				return false;
			}
			// Only models.json. The provider stays configured and its key stays in
			// the SecretStore: forgetting what a model costs must not stop it
			// being reachable.
			await this.saveModels([...current.values()]);
			return true;
		});
	}

	async recordModelObservation(
		key: ModelCatalogKey,
		observation: Omit<ModelObservation, 'at'> & { readonly at?: string },
	): Promise<ModelCatalogEntry> {
		assertNoSecretFields(observation, 'model observation');
		const identity = toIdentity(key);
		return this.queueWrite(async () => {
			const current = await this.loadModels();
			const identityKey = catalogKey(identity);
			const existing = current.get(identityKey);
			const timestamp = this.now();
			const measured = normalizeObservation(observation, observation.at ?? timestamp);
			// The window keeps the most recent runs and drops the oldest, so the
			// median tracks how the model behaves now rather than averaging across
			// the whole life of the install.
			const observations = [...(existing?.observations ?? []), measured].slice(
				-MODEL_OBSERVATION_LIMIT,
			);
			const entry: ModelCatalogEntry = {
				...(existing ?? blankEntry(identity, timestamp)),
				observations,
				updatedAt: timestamp,
			};
			current.set(identityKey, entry);
			await this.saveModels([...current.values()]);
			return copyEntry(entry);
		});
	}

	async applyModelMetadata(
		key: ModelCatalogKey,
		metadata: ModelMetadataInput,
	): Promise<ModelCatalogEntry> {
		assertNoSecretFields(metadata, 'model metadata');
		const identity = toIdentity(key);
		// Validated before the write is queued, so a malformed price fails the
		// caller's own call rather than surfacing later as a broken write.
		const pricing = metadata.pricing === undefined ? undefined : normalizePricing(metadata.pricing);
		const limits = metadata.limits === undefined ? undefined : normalizeLimits(metadata.limits);
		const patch =
			metadata.model === undefined ? undefined : normalizeCapabilitiesPatch(metadata.model);
		const source = normalizeMetadataSource(metadata.source);
		const readAt = metadata.updatedAt === undefined ? undefined : requireTimestamp(metadata.updatedAt);

		return this.queueWrite(async () => {
			const current = await this.loadModels();
			const identityKey = catalogKey(identity);
			const existing = current.get(identityKey);
			const timestamp = this.now();

			// Each field is only touched when the bundle has something to say.
			// An absent field is this source being silent, and silence must not
			// erase a price or a capability another source established.
			const model =
				patch === undefined ? existing?.model : mergeModelCapabilities(existing?.model, patch);
			const metadataOrigin: ModelMetadataOrigin | undefined =
				patch !== undefined || limits !== undefined
					? { source, updatedAt: readAt ?? timestamp }
					: existing?.metadata;

			const entry: ModelCatalogEntry = {
				...(existing ?? blankEntry(identity, timestamp)),
				...(pricing !== undefined ? { pricing } : {}),
				...(limits !== undefined ? { limits } : {}),
				model,
				...(metadataOrigin !== undefined ? { metadata: metadataOrigin } : {}),
				updatedAt: timestamp,
			};
			current.set(identityKey, entry);
			await this.saveModels([...current.values()]);
			return copyEntry(entry);
		});
	}

	// consumption ledger ....................................................

	async recordExecution(input: RecordExecutionInput): Promise<ExecutionRecord> {
		assertNoSecretFields(input, 'consumption execution');
		const executionId = requireIdentifier(input.executionId, 'executionId');
		const status = requireExecutionStatus(input.status);
		const startedAt = requireTimestamp(input.startedAt);
		const finishedAt = requireTimestamp(input.finishedAt);
		if (Date.parse(finishedAt) < Date.parse(startedAt)) {
			throw new ValidationError('finishedAt cannot precede startedAt', {
				details: { field: 'finishedAt', executionId },
			});
		}
		if (input.kind !== 'routing' && input.kind !== 'turn') {
			throw new ValidationError(`kind must be routing or turn - received ${JSON.stringify(input.kind)}`, {
				details: { field: 'kind' },
			});
		}
		const turnId = input.turnId === undefined ? undefined : requireIdentifier(input.turnId, 'turnId');
		const routeId = input.routeId === undefined ? undefined : requireIdentifier(input.routeId, 'routeId');
		const conversationId =
			input.conversationId === undefined
				? undefined
				: requireIdentifier(input.conversationId, 'conversationId');
		const providerId =
			input.providerId === undefined ? undefined : requireIdentifier(input.providerId, 'providerId');
		const modelId = input.modelId === undefined ? undefined : requireIdentifier(input.modelId, 'modelId');

		return this.queueWrite(async () => {
			const current = await this.loadConsumption();
			const existing = current.executions.get(executionId);
			// Idempotent: a replayed event updates the record instead of adding
			// a second one. `attemptIds` and the totals belong to the attempts,
			// so they are carried over rather than reset.
			const attemptIds = existing?.attemptIds ?? [];
			const attempts = attemptIds
				.map((id) => current.attempts.get(id))
				.filter((attempt): attempt is AttemptRecord => attempt !== undefined);
			const record: ExecutionRecord = {
				executionId,
				kind: input.kind,
				...(turnId !== undefined ? { turnId } : {}),
				...(routeId !== undefined ? { routeId } : {}),
				...(conversationId !== undefined ? { conversationId } : {}),
				...(providerId !== undefined ? { providerId } : {}),
				...(modelId !== undefined ? { modelId } : {}),
				status,
				startedAt,
				finishedAt,
				attemptIds,
				totals: summarizeExecution(attempts),
			};
			current.executions.set(executionId, record);
			await this.saveConsumption(current);
			return copyExecution(record);
		});
	}

	async recordAttempt(input: RecordAttemptInput): Promise<AttemptRecord> {
		// A guarda desce até os nomes que o chamador declarou, não até os
		// campos que este registro constrói.
		assertSecretFreeTopLevel(input);
		const executionId = requireIdentifier(input.executionId, 'executionId');
		const sequence = requireSequence(input.sequence);
		const modelId = requireIdentifier(input.modelId, 'modelId');
		const providerId = requireIdentifier(input.providerId, 'providerId');
		const status = requireExecutionStatus(input.status);
		const startedAt = requireTimestamp(input.startedAt);
		const reportedTokens = readTokenCountsInput(input.reportedTokens, 'reportedTokens');
		const estimatedTokens = readTokenCountsInput(input.estimatedTokens, 'estimatedTokens');
		const pricing =
			input.pricing === undefined ? undefined : normalizeAttemptPricing(input.pricing);
		const httpStatus =
			input.httpStatus === undefined ? undefined : requireHttpStatus(input.httpStatus);
		const attemptId = attemptIdFor(executionId, sequence);
		const errorClass =
			input.errorClass === undefined ? undefined : requireShortText(input.errorClass, 'errorClass');
		const abortCause =
			input.abortCause === undefined ? undefined : requireShortText(input.abortCause, 'abortCause');
		// Derived by the same function the pure suite exercises, so the record
		// on disk is the one `computeAttemptCost` was tested against.
		const accounting = resolveAttemptAccounting({
			...(reportedTokens !== undefined ? { reportedTokens } : {}),
			...(estimatedTokens !== undefined ? { estimatedTokens } : {}),
			...(pricing !== undefined ? { pricing } : {}),
		});

		return this.queueWrite(async () => {
			const current = await this.loadConsumption();
			const execution = current.executions.get(executionId);
			if (execution === undefined) {
				// Creating it here would invent a start and an end nobody
				// measured. The caller records the execution first.
				throw new ValidationError(`Unknown execution "${executionId}" - record it before its attempts`, {
					details: { executionId },
				});
			}
			const timestamp = this.now();
			const record: AttemptRecord = {
				attemptId,
				executionId,
				providerId,
				modelId,
				sequence,
				retry: input.retry === true,
				fallback: input.fallback === true,
				status,
				startedAt,
				recordedAt: timestamp,
				...(accounting.reportedTokens !== undefined ? { reportedTokens: accounting.reportedTokens } : {}),
				...(accounting.estimatedTokens !== undefined ? { estimatedTokens: accounting.estimatedTokens } : {}),
				...(accounting.tokenSource !== undefined ? { tokenSource: accounting.tokenSource } : {}),
				...(accounting.pricing !== undefined ? { pricing: accounting.pricing } : {}),
				cost: accounting.cost,
				...(errorClass !== undefined ? { errorClass } : {}),
				...(abortCause !== undefined ? { abortCause } : {}),
				...(httpStatus !== undefined ? { httpStatus } : {}),
			};
			current.attempts.set(attemptId, record);
			// The execution learns about its attempt exactly once, however many
			// times the attempt is replayed.
			const ids = execution.attemptIds.includes(attemptId)
				? execution.attemptIds
				: [...execution.attemptIds, attemptId];
			const attempts = ids
				.map((id) => current.attempts.get(id))
				.filter((attempt): attempt is AttemptRecord => attempt !== undefined);
			current.executions.set(executionId, {
				...execution,
				attemptIds: ids,
				totals: summarizeExecution(attempts),
			});
			await this.saveConsumption(current);
			return copyAttempt(record);
		});
	}

	async listConsumption(query: ConsumptionQuery = {}): Promise<readonly ExecutionRecord[]> {
		const since = query.since === undefined ? undefined : Date.parse(requireTimestamp(query.since));
		const until = query.until === undefined ? undefined : Date.parse(requireTimestamp(query.until));
		const all = [...(await this.loadConsumption()).executions.values()]
			.filter((execution) => matchesQuery(execution, query, since, until))
			// Most recent first: a history is read backwards far more often
			// than forwards.
			.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
		const limited =
			query.limit === undefined ? all : all.slice(0, Math.max(0, Math.trunc(query.limit)));
		// Uma leitura reconcilia os totais com as tentativas: a lista de ids pode
		// ter ficado para trás de uma escrita interrompida, e o total gravado não é
		// a fonte da verdade. O resultado devolvido é o que getExecution diria.
		const ledger = await this.loadConsumption();
		return limited.map((execution) =>
			withTotals(copyExecution(execution), summarizeStoredExecution(execution, ledger.attempts)),
		);
	}

	async getExecution(executionId: string): Promise<ExecutionLedgerEntry | undefined> {
		const current = await this.loadConsumption();
		const execution = current.executions.get(executionId);
		if (execution === undefined) {
			return undefined;
		}
		const attempts = execution.attemptIds
			.map((id) => current.attempts.get(id))
			.filter((attempt): attempt is AttemptRecord => attempt !== undefined)
			.sort((a, b) => a.sequence - b.sequence);
		// Recomputed, not read: the stored totals are a cache, and the
		// attempts are the facts.
		return {
			execution: copyExecution(execution),
			attempts: attempts.map(copyAttempt),
			totals: totalsFor(execution, current.attempts),
		};
	}

	async listAttempts(executionId: string): Promise<readonly AttemptRecord[]> {
		const current = await this.loadConsumption();
		return [...current.attempts.values()]
			.filter((attempt) => attempt.executionId === executionId)
			.sort((a, b) => a.sequence - b.sequence)
			.map(copyAttempt);
	}

	// spending limits .......................................................

	async listSpendingLimits(): Promise<readonly SpendingLimit[]> {
		// Most specific first, so a caller that stops at the first match reads
		// the narrowest limit that governs the model.
		const order: Readonly<Record<'model' | 'provider' | 'global', number>> = {
			model: 0,
			provider: 1,
			global: 2,
		};
		return [...(await this.loadLimits()).values()]
			.map((limit) => ({ ...limit }))
			.sort(
				(a, b) =>
					order[scopeKind(a)] - order[scopeKind(b)] ||
					(a.providerId ?? '').localeCompare(b.providerId ?? '') ||
					(a.modelId ?? '').localeCompare(b.modelId ?? ''),
			);
	}

	async getSpendingLimit(limitId: string): Promise<SpendingLimit | undefined> {
		const found = (await this.loadLimits()).get(limitId);
		return found === undefined ? undefined : { ...found };
	}

	async saveSpendingLimit(input: SaveSpendingLimitInput): Promise<SpendingLimit> {
		assertNoSecretFields(input, 'spending limit');
		const limit = normalizeSpendingLimitInput(input);
		return this.queueWrite(async () => {
			const current = await this.loadLimits();
			const existing = current.get(limit.limitId);
			const now = this.now();
			const record: SpendingLimit = {
				...limit,
				// Editing the cap keeps the moment the limit first existed, so
				// "when did I start budgeting this model" does not move.
				createdAt: existing?.createdAt ?? now,
				updatedAt: now,
			};
			const next = new Map(current);
			next.set(record.limitId, record);
			await this.saveLimits([...next.values()]);
			return { ...record };
		});
	}

	async removeSpendingLimit(limitId: string): Promise<boolean> {
		return this.queueWrite(async () => {
			const current = await this.loadLimits();
			if (!current.has(limitId)) {
				return false;
			}
			const next = new Map(current);
			next.delete(limitId);
			await this.saveLimits([...next.values()]);
			return true;
		});
	}

	// persistence ...........................................................

	/** Serializes an operation against every other write. */
	private queueWrite<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.queue.then(operation, operation);
		// The chain itself must never reject, or every later write would be
		// skipped after the first failure.
		this.queue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	private async loadProjects(): Promise<readonly ProjectRecord[]> {
		if (this.projects !== undefined) {
			return this.projects;
		}
		const path = this.projectsPath();
		let raw: string;
		try {
			raw = await readFile(path, 'utf8');
		} catch (error) {
			if (isNotFound(error)) {
				if (this.projects === undefined) {
					this.projects = [];
				}
				return this.projects;
			}
			throw new StorageError(`Could not read the projects file at ${path}`, {
				cause: error,
				details: { path },
			});
		}
		const parsed = parseProjects(raw);
		// Only the first cold scan may claim the cache. A scan that read the
		// file before a concurrent `saveProjects` landed must not overwrite the
		// list that write had already updated — the next create would then read
		// the stale cache and write `projects.json` without the new project,
		// losing it for good.
		if (this.projects === undefined) {
			this.projects = parsed;
		}
		return this.projects;
	}

	private async saveProjects(projects: readonly ProjectRecord[]): Promise<void> {
		const path = this.projectsPath();
		const payload: ProjectsFile = { version: SCHEMA_VERSION, projects };
		try {
			await this.writeFile(path, `${JSON.stringify(payload, null, 2)}\n`);
		} catch (error) {
			throw new StorageError(`Could not write the projects file at ${path}`, {
				cause: error,
				details: { path },
			});
		}
		// The cache is updated only after the write lands, so a failed write
		// leaves memory consistent with what is actually on disk.
		this.projects = projects;
	}

	private async loadModels(): Promise<Map<string, ModelCatalogEntry>> {
		if (this.models !== undefined) {
			return this.models;
		}
		const path = this.modelsPath();
		let raw: string;
		try {
			raw = await readFile(path, 'utf8');
		} catch (error) {
			if (isNotFound(error)) {
				if (this.models === undefined) {
					this.models = new Map();
				}
				return this.models;
			}
			throw new StorageError(`Could not read the model catalog at ${path}`, {
				cause: error,
				details: { path },
			});
		}
		const parsed = parseModels(raw);
		// Only the first cold scan may claim the cache, for the same reason
		// `loadProjects` has: a scan that read the file before a concurrent write
		// landed must not overwrite what that write already put there.
		if (this.models === undefined) {
			this.models = parsed;
		}
		return this.models;
	}

	private async saveModels(models: readonly ModelCatalogEntry[]): Promise<void> {
		const path = this.modelsPath();
		const payload: ModelsFile = { version: SCHEMA_VERSION, models };
		try {
			await this.writeFile(path, `${JSON.stringify(payload, null, 2)}\n`);
		} catch (error) {
			throw new StorageError(`Could not write the model catalog at ${path}`, {
				cause: error,
				details: { path },
			});
		}
		this.models = new Map(models.map((entry) => [catalogKey(entry), entry]));
	}

	// provider discovery .....................................................

	async listDiscoveredModels(providerId?: string): Promise<readonly DiscoveredModel[]> {
		const all = [...(await this.loadDiscovered()).models.values()];
		return (providerId === undefined ? all : all.filter((model) => model.providerId === providerId))
			.map((model) => ({ ...model }))
			.sort((a, b) => a.modelId.localeCompare(b.modelId));
	}

	async getDiscoveredModel(key: {
		readonly providerId: string;
		readonly modelId: string;
	}): Promise<DiscoveredModel | undefined> {
		const found = (await this.loadDiscovered()).models.get(discoveryKeyOf(key));
		return found === undefined ? undefined : { ...found };
	}

	async applyModelListing(input: {
		readonly providerId: string;
		readonly models: readonly {
			readonly modelId: string;
			readonly contextTokens?: number;
			readonly maxOutputTokens?: number;
			readonly capabilities?: ModelCapabilities;
			readonly created?: string;
			readonly pricing?: {
				readonly currency: string;
				readonly unit: 'per_1k_tokens' | 'per_1m_tokens';
				readonly input?: number;
				readonly output?: number;
			};
		}[];
		readonly fetchedAt: string;
	}): Promise<DiscoveryOutcome> {
		const fetchedAtMs = Date.parse(input.fetchedAt);
		if (Number.isNaN(fetchedAtMs)) {
			throw new ValidationError('applyModelListing requires an ISO-8601 fetchedAt', {
				details: { field: 'fetchedAt', received: input.fetchedAt },
			});
		}
		const providerId = requireIdentifier(input.providerId, 'providerId');
		return this.queueWrite(async () => {
			const current = await this.loadDiscovered();
			const existing = [...current.models.values()].filter((model) => model.providerId === providerId);
			const { models, outcome } = applyListing({
				providerId,
				existing,
				listing: input.models.map((model) => ({
					modelId: requireIdentifier(model.modelId, 'modelId'),
					...(model.contextTokens !== undefined ? { contextTokens: model.contextTokens } : {}),
					...(model.maxOutputTokens !== undefined ? { maxOutputTokens: model.maxOutputTokens } : {}),
					...(model.capabilities !== undefined ? { capabilities: model.capabilities } : {}),
					...(model.created !== undefined ? { created: model.created } : {}),
					...(model.pricing !== undefined
						? {
								pricing: {
									currency: model.pricing.currency,
									unit: model.pricing.unit,
									...(model.pricing.input !== undefined ? { input: model.pricing.input } : {}),
									...(model.pricing.output !== undefined ? { output: model.pricing.output } : {}),
								},
							}
						: {}),
				})),
				fetchedAtMs,
				ttl: DISCOVERY_TTL,
				nowMs: Date.now(),
			});
			const next = new Map(current.models);
			for (const model of models) {
				next.set(discoveryKeyOf(model), model);
			}
			await this.saveDiscovered({ models: next, quotas: current.quotas });
			return outcome;
		});
	}

	/**
	 * Registra que uma listagem falhou.
	 *
	 * Nada é apagado: o que já existia continua servido, marcado como
	 * desatualizado, e o relatório diz que a verificação falhou.
	 */
	async failModelListing(providerId: string, error: unknown): Promise<DiscoveryOutcome> {
		const id = requireIdentifier(providerId, 'providerId');
		return this.queueWrite(async () => {
			const current = await this.loadDiscovered();
			const existing = [...current.models.values()].filter((model) => model.providerId === id);
			const { models, outcome } = applyFailure({ providerId: id, existing, error, nowMs: Date.now() });
			const next = new Map(current.models);
			for (const model of models) {
				next.set(discoveryKeyOf(model), model);
			}
			await this.saveDiscovered({ models: next, quotas: current.quotas });
			return outcome;
		});
	}

	async confirmAccess(key: { readonly providerId: string; readonly modelId: string }, at: string): Promise<void> {
		const timestamp = requireTimestamp(at);
		await this.queueWrite(async () => {
			const current = await this.loadDiscovered();
			const id = discoveryKeyOf(key);
			const existing = current.models.get(id);
			// A call that answered is evidence the account can use the model,
			// even for one the listing never included.
			const record: DiscoveredModel =
				existing === undefined
					? {
							providerId: requireIdentifier(key.providerId, 'providerId'),
							modelId: requireIdentifier(key.modelId, 'modelId'),
							listed: false,
							accessConfirmedAt: timestamp,
							updatedAt: timestamp,
						}
					: { ...existing, accessConfirmedAt: timestamp, updatedAt: timestamp };
			const next = new Map(current.models);
			next.set(id, record);
			await this.saveDiscovered({ models: next, quotas: current.quotas });
		});
	}

	async recordQuota(record: DiscoveredQuotaRecord): Promise<void> {
		assertNoSecretFields(record, 'provider quota');
		const providerId = requireIdentifier(record.providerId, 'providerId');
		const updatedAt = requireTimestamp(record.updatedAt);
		const modelId = record.modelId === undefined ? undefined : requireIdentifier(record.modelId, 'modelId');
		const normalized: DiscoveredQuotaRecord = {
			providerId,
			...(modelId !== undefined ? { modelId } : {}),
			...(record.account !== undefined ? { account: { ...record.account } } : {}),
			...(record.usage !== undefined ? { usage: { ...record.usage } } : {}),
			updatedAt,
		};
		await this.queueWrite(async () => {
			const current = await this.loadDiscovered();
			const next = new Map(current.quotas);
			next.set(JSON.stringify([providerId, modelId ?? '']), normalized);
			await this.saveDiscovered({ models: current.models, quotas: next });
		});
	}

	async listQuotas(providerId?: string): Promise<readonly DiscoveredQuotaRecord[]> {
		const all = [...(await this.loadDiscovered()).quotas.values()];
		return (providerId === undefined ? all : all.filter((record) => record.providerId === providerId))
			.map((record) => ({ ...record }));
	}

	private async loadDiscovered(): Promise<{
		models: Map<string, DiscoveredModel>;
		quotas: Map<string, DiscoveredQuotaRecord>;
	}> {
		if (this.discovered !== undefined) {
			return this.discovered;
		}
		const path = this.providerModelsPath();
		let raw: string;
		try {
			raw = await readFile(path, 'utf8');
		} catch (error) {
			if (isNotFound(error)) {
				if (this.discovered === undefined) {
					this.discovered = { models: new Map(), quotas: new Map() };
				}
				return this.discovered;
			}
			// Like the ledger: a file that exists and cannot be read is not
			// empty, and writing "empty" over it would drop every discovery.
			throw new StorageError(`Could not read the provider discovery file at ${path}`, {
				cause: error,
				details: { path },
			});
		}
		const parsed = parseProviderModels(raw);
		if (this.discovered === undefined) {
			this.discovered = {
				models: new Map(parsed.models.map((model) => [discoveryKeyOf(model), model])),
				quotas: new Map(
					parsed.quotas.map((record) => [JSON.stringify([record.providerId, record.modelId ?? '']), record]),
				),
			};
		}
		return this.discovered;
	}

	/**
	 * Esquece tudo o que se descobriu sobre um provedor (R4S).
	 *
	 * Remover o provedor apagava a configuração e a chave, mas **não** os
	 * modelos descobertos nem as quotas: eles ficavam no ledgers e voltavam a
	 * aparecer como "modelos do provedor que não existe mais" — resquício que
	 * a interface mostrava como se fosse dado atual.
	 *
	 * Idempotente: esquecer um provedor que não tem nada é um no-op, e a
	 * gravação só acontece quando algo foi de fato removido.
	 */
	async forgetProvider(providerId: string): Promise<boolean> {
		const loaded = await this.loadDiscovered();
		// Cópias: o objeto cacheado só é substituído junto da gravação. Mutar
		// o dele e falhar na escrita deixaria a memória dizendo "removido" e o
		// disco dizendo o contrário.
		const models = new Map(loaded.models);
		const quotas = new Map(loaded.quotas);
		let changed = false;
		for (const [key, model] of [...models]) {
			if (model.providerId === providerId) {
				models.delete(key);
				changed = true;
			}
		}
		for (const [key, quota] of [...quotas]) {
			if (quota.providerId === providerId) {
				quotas.delete(key);
				changed = true;
			}
		}
		if (changed) {
			await this.saveDiscovered({ models, quotas });
		}
		// O catálogo declarado pelo usuário também é deste provedor.
		const catalog = await this.loadModels();
		const keep = [...catalog.values()].filter((entry) => entry.providerId !== providerId);
		if (keep.length !== catalog.size) {
			await this.saveModels(keep);
		}
		return changed;
	}

	private async saveDiscovered(state: {
		models: Map<string, DiscoveredModel>;
		quotas: Map<string, DiscoveredQuotaRecord>;
	}): Promise<void> {
		const path = this.providerModelsPath();
		const payload: ProviderModelsFile = {
			version: SCHEMA_VERSION,
			models: [...state.models.values()],
			quotas: [...state.quotas.values()],
		};
		try {
			await this.writeFile(path, `${JSON.stringify(payload, null, 2)}\n`);
		} catch (error) {
			throw new StorageError(`Could not write the provider discovery file at ${path}`, {
				cause: error,
				details: { path },
			});
		}
		this.discovered = state;
	}

	private async loadLimits(): Promise<Map<string, SpendingLimit>> {
		if (this.limits !== undefined) {
			return this.limits;
		}
		const path = this.limitsPath();
		let raw: string;
		try {
			raw = await readFile(path, 'utf8');
		} catch (error) {
			if (isNotFound(error)) {
				if (this.limits === undefined) {
					this.limits = new Map();
				}
				return this.limits;
			}
			// Like the ledger: a file that exists but cannot be read is not
			// empty, and writing "empty" over it would drop every limit.
			throw new StorageError(`Could not read the spending limits at ${path}`, {
				cause: error,
				details: { path },
			});
		}
		const parsed = parseSpendingLimits(raw);
		// Only the first cold scan may claim the cache, for the same reason
		// `loadModels` has.
		if (this.limits === undefined) {
			this.limits = new Map(parsed.map((limit) => [limit.limitId, limit]));
		}
		return this.limits;
	}

	private async saveLimits(limits: readonly SpendingLimit[]): Promise<void> {
		const path = this.limitsPath();
		const payload: SpendingLimitsFile = { version: SCHEMA_VERSION, limits };
		try {
			await this.writeFile(path, `${JSON.stringify(payload, null, 2)}\n`);
		} catch (error) {
			throw new StorageError(`Could not write the spending limits at ${path}`, {
				cause: error,
				details: { path },
			});
		}
		this.limits = new Map(limits.map((limit) => [limit.limitId, limit]));
	}

	private async loadConsumption(): Promise<{
		executions: Map<string, ExecutionRecord>;
		attempts: Map<string, AttemptRecord>;
	}> {
		if (this.consumption !== undefined) {
			return this.consumption;
		}
		const path = this.consumptionPath();
		let raw: string;
		try {
			raw = await readFile(path, 'utf8');
		} catch (error) {
			if (isNotFound(error)) {
				if (this.consumption === undefined) {
					this.consumption = { executions: new Map(), attempts: new Map() };
				}
				return this.consumption;
			}
			// Unlike the catalog, a ledger that exists but cannot be read is
			// not treated as empty: writing "empty" over it would destroy the
			// history it was failing to read.
			throw new StorageError(`Could not read the consumption ledger at ${path}`, {
				cause: error,
				details: { path },
			});
		}
		const parsed = parseConsumptionLedger(raw);
		// Only the first cold scan may claim the cache, for the same reason
		// `loadModels` has: a scan that read the file before a concurrent
		// write landed must not overwrite what that write put there.
		if (this.consumption === undefined) {
			this.consumption = {
				executions: new Map(parsed.executions),
				attempts: new Map(parsed.attempts),
			};
		}
		return this.consumption;
	}

	private async saveConsumption(ledger: {
		executions: Map<string, ExecutionRecord>;
		attempts: Map<string, AttemptRecord>;
	}): Promise<void> {
		const path = this.consumptionPath();
		const payload: ConsumptionFile = {
			version: SCHEMA_VERSION,
			executions: [...ledger.executions.values()],
			attempts: [...ledger.attempts.values()],
		};
		try {
			await this.writeFile(path, `${JSON.stringify(payload, null, 2)}\n`);
		} catch (error) {
			throw new StorageError(`Could not write the consumption ledger at ${path}`, {
				cause: error,
				details: { path },
			});
		}
		this.consumption = ledger;
	}


	private async loadConversations(): Promise<ReadonlyMap<string, ConversationSummary>> {
		if (this.conversations !== undefined) {
			return this.conversations;
		}
		const dir = this.conversationsPath();
		let entries: string[];
		try {
			entries = await readdir(dir);
		} catch (error) {
			if (isNotFound(error)) {
				// Only the first scan to land claims the index: one that started
				// before a concurrent write finished must not overwrite the map
				// that write had already populated.
				if (this.conversations === undefined) {
					this.conversations = new Map();
					// Um diretório inexistente é uma lista vazia **confirmada**:
					// não há conversa nenhuma ali (R4M).
					this.conversationsConfirmed = true;
				}
				return this.conversations;
			}
			// A leitura falhou e "não há conversa" é mentira nesse estado. A
			// lista vazia fica só para a **listagem** não quebrar; quem decide
			// sobre existência (a exclusão) consulta a marca (R4M).
			if (this.conversations === undefined) {
				this.conversations = new Map();
				this.conversationsConfirmed = false;
			}
			throw new StorageError(`Could not read the conversations directory at ${dir}`, {
				cause: error,
				details: { path: dir },
			});
		}

		const summaries = new Map<string, ConversationSummary>();
		for (const entry of entries) {
			if (!entry.endsWith('.json')) {
				continue;
			}
			const file = await this.readConversationFile(entry.slice(0, -'.json'.length), 'skip');
			if (file !== undefined) {
				summaries.set(file.id, toSummary(file));
			}
		}
		// A cold scan can run while a queued write updates the index — the scan
		// read the directory before that write landed, and assigning its stale
		// snapshot afterwards would hide the conversation just stored.
		if (this.conversations === undefined) {
			this.conversations = summaries;
			this.conversationsConfirmed = true;
		}
		return this.conversations;
	}

	/**
	 * Reads one transcript.
	 *
	 * `mode: 'skip'` returns undefined for a damaged file (the listing path);
	 * otherwise the damage is reported, because the caller named that file.
	 */
	private async readConversationFile(
		conversationId: string,
		mode: 'skip' | 'throw' = 'throw',
	): Promise<ConversationFile | undefined> {
		const path = this.conversationPath(conversationId);
		let raw: string;
		try {
			raw = await readFile(path, 'utf8');
		} catch (error) {
			if (isNotFound(error)) {
				return undefined;
			}
			throw new StorageError(`Could not read the conversation file at ${path}`, {
				cause: error,
				details: { path },
			});
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (cause) {
			if (mode === 'skip') {
				return undefined;
			}
			throw new StorageError(`The conversation file at ${path} is not valid JSON`, {
				cause,
				details: { path },
			});
		}

		const file = toConversationFile(parsed);
		if (file === undefined && mode === 'throw') {
			throw new StorageError(`The conversation file at ${path} has an unusable shape`, {
				details: { path },
			});
		}
		return file;
	}

	private async saveConversationFile(file: ConversationFile): Promise<void> {
		// The index has to exist before it is written into. Seeding it here
		// with only the file being written made every conversation already on
		// disk invisible: `loadConversations` saw a populated map, never
		// scanned, and the sidebar lost everything until the app restarted.
		if (this.conversations === undefined) {
			await this.loadConversations();
		}
		const path = this.conversationPath(file.id);
		try {
			await this.writeFile(path, `${JSON.stringify(file, null, 2)}\n`);
		} catch (error) {
			throw new StorageError(`Could not write the conversation file at ${path}`, {
				cause: error,
				details: { path },
			});
		}
		this.conversations?.set(file.id, toSummary(file));
	}

	private async removeConversationFile(conversationId: string): Promise<void> {
		const path = this.conversationPath(conversationId);
		try {
			await rm(path, { force: true });
		} catch (error) {
			throw new StorageError(`Could not delete the conversation file at ${path}`, {
				cause: error,
				details: { path },
			});
		}
		this.conversations?.delete(conversationId);
	}

	/** Stamps id and timestamp, then validates role and content. */
	private toStoredMessage(input: AppendMessageInput, seq: number): ConversationMessage {
		if (!isRole(input.role)) {
			throw new ValidationError(`Unknown conversation role "${String(input.role)}"`, {
				details: { role: input.role },
			});
		}
		if (typeof input.content !== 'string') {
			throw new ValidationError('A message requires string content', {
				details: { received: typeof input.content },
			});
		}
		if (input.toolCallId !== undefined && typeof input.toolCallId !== 'string') {
			throw new ValidationError('toolCallId must be a string', {
				details: { received: typeof input.toolCallId },
			});
		}
		const toolCalls = toToolCalls(input.toolCalls, { strict: true });
		if (input.requestId !== undefined && typeof input.requestId !== 'string') {
			throw new ValidationError('requestId must be a string', {
				details: { received: typeof input.requestId },
			});
		}
		return {
			id: input.id ?? this.generateId(),
			seq,
			role: input.role,
			content: input.content,
			createdAt: input.createdAt ?? this.now(),
			...(input.toolCallId !== undefined ? { toolCallId: input.toolCallId } : {}),
			...(toolCalls !== undefined ? { toolCalls } : {}),
			...(input.requestId !== undefined && input.requestId.length > 0 ? { requestId: input.requestId } : {}),
		};
	}

	private projectsPath(): string {
		return join(this.root, PROJECTS_FILE);
	}

	private modelsPath(): string {
		return join(this.root, MODELS_FILE);
	}

	private consumptionPath(): string {
		return join(this.root, CONSUMPTION_FILE);
	}

	private limitsPath(): string {
		return join(this.root, SPENDING_LIMITS_FILE);
	}

	private providerModelsPath(): string {
		return join(this.root, PROVIDER_MODELS_FILE);
	}

	private accessPolicyPath(): string {
		return join(this.root, ACCESS_POLICY_FILE);
	}

	private routerConfigPath(): string {
		return join(this.root, ROUTER_CONFIG_FILE);
	}

	/**
	 * The stored router configuration, or `undefined` when the user never
	 * chose one.
	 *
	 * The same tolerance the access policy has: a missing file is "never
	 * configured", a malformed one is not a choice and reads as absent, and a
	 * file that exists but cannot be read throws rather than answering
	 * "the default" over a choice the user made.
	 */
	async readRouterConfig(): Promise<RouterConfig | undefined> {
		const path = this.routerConfigPath();
		const stored = await this.routerStore(path).read();
		if (stored.kind === 'primary') {
			return stored.config;
		}
		if (stored.kind === 'recovered') {
			// A recuperação não é silenciosa: o aviso diz que a cópia foi usada
			// e por quê. Quem lê recebe a configuração válida.
			this.notice('The router configuration was recovered from the backup', {
				reason: stored.reason,
			});
			return stored.config;
		}
		// Arquivo existe e não é válido, sem cópia válida. Responder "nunca
		// configurado" esconderia o estrago e faria a próxima gravação
		// sobrescrevê-lo como se não houvesse nada.
		throw new StorageError(`The router configuration at ${path} is unreadable`, {
			details: { path, reason: stored.reason },
		});
	}

	/** O store da configuração do roteador. */
	/** O caminho do arquivo do roteador — para quem precisa guardá-lo ao lado. */
	routerConfigFilePath(): string {
		return this.routerConfigPath();
	}

	/**
	 * A procedência da última leitura da configuração do roteador.
	 *
	 * `recovered` = a cópia de segurança foi usada; `unreadable` = há um
	 * arquivo que não pôde ser lido e não havia cópia; `undefined` = leitura
	 * normal. Vem do mesmo store que leu — não de uma segunda leitura.
	 */
	routerConfigOrigin(): RouterConfigOrigin | undefined {
		return this.lastRouterStore?.lastOrigin();
	}

	/** O store da configuração do roteador. */
	private routerStore(path: string): RouterConfigStore {
		const store = new RouterConfigStore({
			filePath: path,
			...(this.onNotice !== undefined ? { warn: this.onNotice } : {}),
		});
		this.lastRouterStore = store;
		return store;
	}

	/** Um aviso, quando alguém quis ouvi-lo. */
	private notice(message: string, data?: Record<string, unknown>): void {
		this.onNotice?.(message, data);
	}

	/**
	 * Writes the router configuration as a whole.
	 *
	 * A configuration that could never be obeyed — um modo que aponta para um
	 * provedor inexistente — é recusada pela validação, e não gravada.
	 */
	async saveRouterConfig(config: RouterConfig): Promise<RouterConfig> {
		const validated = validateRouterConfig(config);
		const path = this.routerConfigPath();
		const written = await this.routerStore(path).write(validated);
		if (written.kind === 'failed') {
			// A anterior continua no disco: a substituição não aconteceu.
			throw new StorageError(`Could not write the router configuration at ${path}`, {
				details: { path, reason: written.message },
			});
		}
		return validated;
	}

	/**
	 * The stored policy, or `undefined` when the user never chose one.
	 *
	 * A file that exists but cannot be read throws, for the same reason the
	 * limits do: answering "the default" over an unreadable file would let the
	 * next save silently replace a choice the user made. A malformed record is
	 * different - it is not a choice - and reads as absent.
	 */
	async readAccessPolicy(): Promise<ModelAccessPolicyRecord | undefined> {
		const path = this.accessPolicyPath();
		let raw: string;
		try {
			raw = await readFile(path, 'utf8');
		} catch (error) {
			if (isNotFound(error)) {
				return undefined;
			}
			throw new StorageError(`Could not read the model access policy at ${path}`, {
				cause: error,
				details: { path },
			});
		}
		return parseAccessPolicy(raw);
	}

	/** Writes the policy as a whole. A policy is one decision, replaced at once. */
	async saveAccessPolicy(record: ModelAccessPolicyRecord): Promise<ModelAccessPolicyRecord> {
		const path = this.accessPolicyPath();
		try {
			await this.writeFile(path, serializeAccessPolicy(record));
		} catch (error) {
			throw new StorageError(`Could not write the model access policy at ${path}`, {
				cause: error,
				details: { path },
			});
		}
		return record;
	}

	private conversationsPath(): string {
		return join(this.root, CONVERSATIONS_DIR);
	}

	/**
	 * Resolves a conversation id to a path inside the conversations directory.
	 *
	 * The id reaches here from callers and, on the listing path, from directory
	 * entries. Anything traversal-shaped is stripped, so `../../secrets` cannot
	 * address a file outside the directory.
	 */
	private conversationPath(conversationId: string): string {
		const safe = conversationId.split(/[\\/]/).pop() ?? '';
		if (safe.length === 0 || safe === '.' || safe === '..') {
			throw new ValidationError('A conversation id must be a plain file name', {
				details: { conversationId },
			});
		}
		return join(this.conversationsPath(), `${safe}.json`);
	}
}

// ── parsing and narrowing ──────────────────────────────────────────────────

/**
 * Reads the project list, degrading a damaged file to an empty list.
 *
 * Deliberately not an exception: an unreadable `projects.json` should cost the
 * user their project list, not their ability to launch. The file is left on disk
 * so a later recovery step can still inspect it.
 */
function parseProjects(raw: string): readonly ProjectRecord[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		return [];
	}
	const projects = (parsed as { projects?: unknown }).projects;
	if (!Array.isArray(projects)) {
		return [];
	}
	const seen = new Set<string>();
	const records: ProjectRecord[] = [];
	for (const entry of projects) {
		const record = toProjectRecord(entry);
		// Duplicate ids would make `getProject` depend on ordering; first wins.
		if (record === undefined || seen.has(record.id)) {
			continue;
		}
		seen.add(record.id);
		records.push(record);
	}
	return records;
}

function toProjectRecord(value: unknown): ProjectRecord | undefined {
	const candidate = asObject(value);
	if (candidate === undefined) {
		return undefined;
	}
	const { id, name, rootPath, createdAt, updatedAt } = candidate;
	if (
		typeof id !== 'string' ||
		id.length === 0 ||
		typeof name !== 'string' ||
		typeof rootPath !== 'string' ||
		typeof createdAt !== 'string' ||
		typeof updatedAt !== 'string'
	) {
		return undefined;
	}
	return { id, name, rootPath, createdAt, updatedAt };
}

// ── model catalog: parsing, validation and identity ────────────────────────

/**
 * The map key for a `(providerId, modelId)` pair.
 *
 * `JSON.stringify` of the two-element array rather than a joined string, for the
 * same reason the model picker values its options by index: a provider id is
 * derived from a base URL and a model id is whatever the server chose to call
 * it, so neither is a string that can be trusted to avoid any delimiter. A
 * model id containing the separator would otherwise silently become a
 * different, wrong model.
 */
function catalogKey(identity: { readonly providerId: string; readonly modelId: string }): string {
	return JSON.stringify([identity.providerId, identity.modelId]);
}

/** A record for a model nobody has said anything about yet. */
function blankEntry(identity: { readonly providerId: string; readonly modelId: string }, timestamp: string): ModelCatalogEntry {
	return {
		providerId: identity.providerId,
		modelId: identity.modelId,
		access: 'unknown',
		observations: [],
		createdAt: timestamp,
		updatedAt: timestamp,
	};
}

/** Defensive copy, so a caller cannot reach back into the store's own state. */
function copyEntry(entry: ModelCatalogEntry): ModelCatalogEntry {
	return {
		...entry,
		...(entry.capabilities !== undefined ? { capabilities: [...entry.capabilities] } : {}),
		...(entry.pricing !== undefined ? { pricing: { ...entry.pricing } } : {}),
		...(entry.limits !== undefined ? { limits: { ...entry.limits } } : {}),
		...(entry.model !== undefined ? { model: copyCapabilities(entry.model) } : {}),
		...(entry.metadata !== undefined ? { metadata: copyMetadataOrigin(entry.metadata) } : {}),
		...(entry.notes !== undefined ? { notes: entry.notes } : {}),
		observations: entry.observations.map(copyObservation),
	};
}

function copyObservation(observation: ModelObservation): ModelObservation {
	return {
		at: observation.at,
		...(observation.firstByteMs !== undefined ? { firstByteMs: observation.firstByteMs } : {}),
		...(observation.totalMs !== undefined ? { totalMs: observation.totalMs } : {}),
		...(observation.usage !== undefined ? { usage: { ...observation.usage } } : {}),
	};
}

/** Total order, so a list never depends on which record was written first. */
function byModelIdentity(a: ModelCatalogEntry, b: ModelCatalogEntry): number {
	return a.providerId === b.providerId
		? a.modelId.localeCompare(b.modelId)
		: a.providerId.localeCompare(b.providerId);
}

/**
 * Reads the catalog, degrading a damaged file to an empty one.
 *
 * Same policy as `projects.json` and for the same reason: an unreadable
 * catalog should cost the user their notes, not their ability to launch. The
 * file is left on disk so it can still be inspected or recovered.
 */
function parseModels(raw: string): Map<string, ModelCatalogEntry> {
	const entries = new Map<string, ModelCatalogEntry>();
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return entries;
	}
	const list = asObject(parsed)?.['models'];
	if (!Array.isArray(list)) {
		return entries;
	}
	for (const value of list) {
		const entry = toCatalogEntry(value);
		// First wins on a repeated key. Two records for one model are a
		// hand-edited or half-merged file, and which of them is authoritative is
		// not something to guess from position.
		if (entry !== undefined && !entries.has(catalogKey(entry))) {
			entries.set(catalogKey(entry), entry);
		}
	}
	return entries;
}

/**
 * Narrows one stored record.
 *
 * Tolerant the way a transcript is: a record missing its optional knowledge
 * simply has none, and a record with a malformed optional field has that field
 * dropped rather than the whole record lost. Only the identity and the
 * timestamps are required, because without them there is nothing to store.
 */
function toCatalogEntry(value: unknown): ModelCatalogEntry | undefined {
	const candidate = asObject(value);
	if (candidate === undefined) {
		return undefined;
	}
	const { providerId, modelId, createdAt, updatedAt } = candidate;
	if (
		typeof providerId !== 'string' ||
		providerId.length === 0 ||
		typeof modelId !== 'string' ||
		modelId.length === 0 ||
		typeof createdAt !== 'string' ||
		typeof updatedAt !== 'string'
	) {
		return undefined;
	}
	const rawObservations = Array.isArray(candidate['observations']) ? candidate['observations'] : [];
	return {
		providerId,
		modelId,
		...(Array.isArray(candidate['capabilities'])
			? { capabilities: candidate['capabilities'].filter(isNonEmptyString) }
			: {}),
		...(asObject(candidate['pricing']) !== undefined
			? { pricing: readPricing(candidate['pricing']) }
			: {}),
		access: isAccess(candidate['access']) ? candidate['access'] : 'unknown',
		...(asObject(candidate['limits']) !== undefined
			? { limits: readLimits(candidate['limits']) }
			: {}),
		...(asObject(candidate['model']) !== undefined
			? { model: readCapabilities(candidate['model']) }
			: {}),
		...(asObject(candidate['metadata']) !== undefined
			? {
					metadata: readMetadataOrigin(
						candidate['metadata'],
						typeof updatedAt === 'string' ? updatedAt : undefined,
					),
				}
			: {}),
		...(typeof candidate['notes'] === 'string' ? { notes: candidate['notes'] } : {}),
		// Bounded on read as well as on write: a hand-edited file with a thousand
		// observations would otherwise be loaded whole and trimmed later, and the
		// read is what happens on every launch.
		observations: rawObservations
			.map((entry) => readObservation(entry))
			.filter((entry): entry is ModelObservation => entry !== undefined)
			.slice(-MODEL_OBSERVATION_LIMIT),
		createdAt,
		updatedAt,
	};
}

/** Written-side validation. Throws rather than dropping, as the projects do. */
function toIdentity(key: ModelCatalogKey): { readonly providerId: string; readonly modelId: string } {
	return {
		providerId: requireCatalogText(key.providerId, 'providerId'),
		modelId: requireCatalogText(key.modelId, 'modelId'),
	};
}

function requireCatalogText(value: string, field: string): string {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new ValidationError(`A model catalog entry requires a non-empty ${field}`, {
			details: { field },
		});
	}
	if (value.length > MAX_IDENTITY_LENGTH) {
		throw new ValidationError(`A model catalog ${field} cannot be longer than ${MAX_IDENTITY_LENGTH} characters`, {
			details: { field, length: value.length },
		});
	}
	// Traversal-shaped ids are *accepted*, deliberately. A provider id is derived
	// from a base URL and a model id is whatever a server called it, so refusing
	// a name that happens to contain a slash would be inventing a rule about
	// somebody else's naming. Nothing here builds a path out of either value —
	// the catalog is one fixed file — so there is nothing for one to escape into.
	return value.trim();
}

const MAX_IDENTITY_LENGTH = 512;
const MAX_NOTE_LENGTH = 4_000;
const MAX_CAPABILITIES = 64;
const MAX_CAPABILITY_LENGTH = 120;

function normalizeCapabilities(value: readonly string[]): readonly string[] {
	if (!Array.isArray(value)) {
		throw new ValidationError('capabilities must be an array of strings', {
			details: { received: typeof value },
		});
	}
	if (value.length > MAX_CAPABILITIES) {
		throw new ValidationError(`capabilities cannot hold more than ${MAX_CAPABILITIES} entries`, {
			details: { count: value.length },
		});
	}
	// Trimmed, blanks dropped, duplicates folded: these are words the user types
	// into one field, and `code` typed twice must not read as two capabilities.
	const seen = new Set<string>();
	const result: string[] = [];
	for (const entry of value) {
		if (typeof entry !== 'string') {
			throw new ValidationError('every capability must be a string', {
				details: { received: typeof entry },
			});
		}
		const trimmed = entry.trim();
		if (trimmed.length === 0) {
			continue;
		}
		if (trimmed.length > MAX_CAPABILITY_LENGTH) {
			throw new ValidationError(
				`a capability cannot be longer than ${MAX_CAPABILITY_LENGTH} characters`,
				{ details: { length: trimmed.length } },
			);
		}
		const key = trimmed.toLowerCase();
		if (!seen.has(key)) {
			seen.add(key);
			result.push(trimmed);
		}
	}
	return result;
}

function normalizeAccess(value: ModelAccess): ModelAccess {
	if (!isAccess(value)) {
		throw new ValidationError(`access must be free, paid or unknown — received ${JSON.stringify(value)}`, {
			details: { received: value },
		});
	}
	return value;
}

function normalizePricing(value: ModelPricing): ModelPricing {
	if (asObject(value) === undefined) {
		throw new ValidationError('pricing must be an object', { details: { received: typeof value } });
	}
	const currency = typeof value.currency === 'string' ? value.currency.trim() : '';
	if (currency.length === 0) {
		// Refused rather than defaulted. A price without its currency is not a
		// price, and filling one in would put a made-up exchange rate into every
		// total built from it.
		throw new ValidationError('pricing requires a currency', { details: { field: 'currency' } });
	}
	if (!isCostUnit(value.unit)) {
		throw new ValidationError(
			`pricing requires a unit of per_1k_tokens or per_1m_tokens — received ${JSON.stringify(value.unit)}`,
			{ details: { field: 'unit' } },
		);
	}
	return {
		currency,
		unit: value.unit,
		...(value.input !== undefined ? { input: requireCost(value.input, 'input') } : {}),
		...(value.output !== undefined ? { output: requireCost(value.output, 'output') } : {}),
		...(value.cachedInput !== undefined
			? { cachedInput: requireCost(value.cachedInput, 'cachedInput') }
			: {}),
		...(value.source !== undefined ? { source: requirePriceSource(value.source) } : {}),
	};
}

/** A price nobody can attribute is `unknown`, never a guess at who published it. */
function requirePriceSource(value: unknown): PriceSource {
	if (value === 'manual' || value === 'provider' || value === 'unknown') {
		return value;
	}
	throw new ValidationError(`price source must be manual, provider or unknown - received ${JSON.stringify(value)}`, {
		details: { field: 'source' },
	});
}

function normalizeMetadataSource(value: unknown): Exclude<ModelMetadataSource, 'unknown'> {
	if (value === 'manual' || value === 'provider') {
		return value;
	}
	// A metadata bundle must say where it came from. `unknown` is the state of a
	// record that has never been attributed, and is not something a writer can
	// assert on purpose.
	throw new ValidationError(`metadata source must be manual or provider - received ${JSON.stringify(value)}`, {
		details: { field: 'source' },
	});
}

function requireTimestamp(value: unknown): string {
	if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
		throw new ValidationError('updatedAt must be an ISO-8601 timestamp', {
			details: { field: 'updatedAt', received: value },
		});
	}
	return value;
}

/** Written-side narrowing of a capability patch: a non-boolean is refused, not dropped. */
function normalizeCapabilitiesPatch(value: ModelCapabilitiesPatch): ModelCapabilitiesPatch {
	if (asObject(value) === undefined) {
		throw new ValidationError('model must be an object', { details: { received: typeof value } });
	}
	const flag = (name: 'toolCalling' | 'structuredOutput' | 'reasoning'): boolean | null | undefined => {
		const raw = value[name];
		if (raw === undefined || raw === null) {
			return raw;
		}
		if (typeof raw !== 'boolean') {
			throw new ValidationError(`${name} must be true, false or null`, {
				details: { field: name, received: raw },
			});
		}
		return raw;
	};
	const modality = <K extends string>(
		name: 'inputs' | 'outputs',
		raw: Partial<Record<K, boolean | null>> | undefined,
	): Partial<Record<K, boolean | null>> | undefined => {
		if (raw === undefined) {
			return undefined;
		}
		if (asObject(raw) === undefined) {
			throw new ValidationError(`${name} must be an object`, { details: { field: name } });
		}
		const next: Partial<Record<K, boolean | null>> = {};
		for (const [label, entry] of Object.entries(raw) as [K, boolean | null | undefined][]) {
			if (entry === undefined || entry === null) {
				next[label] = entry;
				continue;
			}
			if (typeof entry !== 'boolean') {
				throw new ValidationError(`${name}.${label} must be true, false or null`, {
					details: { field: `${name}.${label}`, received: entry },
				});
			}
			next[label] = entry;
		}
		return next;
	};
	return {
		...(value.toolCalling !== undefined ? { toolCalling: flag('toolCalling') ?? null } : {}),
		...(value.structuredOutput !== undefined
			? { structuredOutput: flag('structuredOutput') ?? null }
			: {}),
		...(value.reasoning !== undefined ? { reasoning: flag('reasoning') ?? null } : {}),
		...(value.inputs !== undefined ? { inputs: modality<InputModality>('inputs', value.inputs) } : {}),
		...(value.outputs !== undefined
			? { outputs: modality<OutputModality>('outputs', value.outputs) }
			: {}),
	};
}

/** Defensive copy of the capability block, so a caller cannot mutate the store's state. */
function copyCapabilities(value: ModelCapabilities): ModelCapabilities {
	return {
		...(value.toolCalling !== undefined ? { toolCalling: value.toolCalling } : {}),
		...(value.structuredOutput !== undefined ? { structuredOutput: value.structuredOutput } : {}),
		...(value.reasoning !== undefined ? { reasoning: value.reasoning } : {}),
		...(value.inputs !== undefined ? { inputs: { ...value.inputs } } : {}),
		...(value.outputs !== undefined ? { outputs: { ...value.outputs } } : {}),
	};
}

function copyMetadataOrigin(value: ModelMetadataOrigin): ModelMetadataOrigin {
	return {
		source: value.source,
		...(value.updatedAt !== undefined ? { updatedAt: value.updatedAt } : {}),
	};
}

function normalizeLimits(value: ModelLimits): ModelLimits {
	if (asObject(value) === undefined) {
		throw new ValidationError('limits must be an object', { details: { received: typeof value } });
	}
	return {
		...(value.contextTokens !== undefined
			? { contextTokens: requireTokenCount(value.contextTokens, 'contextTokens') }
			: {}),
		...(value.maxOutputTokens !== undefined
			? { maxOutputTokens: requireTokenCount(value.maxOutputTokens, 'maxOutputTokens') }
			: {}),
	};
}

function requireNote(value: string): string {
	if (typeof value !== 'string') {
		throw new ValidationError('notes must be a string', { details: { received: typeof value } });
	}
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		throw new ValidationError('notes cannot be blank — send null to clear them', {
			details: { field: 'notes' },
		});
	}
	if (trimmed.length > MAX_NOTE_LENGTH) {
		throw new ValidationError(`notes cannot be longer than ${MAX_NOTE_LENGTH} characters`, {
			details: { length: trimmed.length },
		});
	}
	return trimmed;
}

/** A price may be zero — a genuinely free tier — but never negative or a string. */
function requireCost(value: number, field: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
		throw new ValidationError(`${field} cost must be a number of zero or more`, {
			details: { field, received: value },
		});
	}
	return value;
}

/** Whole, non-negative. A fractional token limit is a value that means nothing. */
function requireIdentifier(value: unknown, field: string): string {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new ValidationError(`A consumption record requires a non-empty ${field}`, {
			details: { field },
		});
	}
	if (value.length > MAX_IDENTITY_LENGTH) {
		throw new ValidationError(`A consumption ${field} cannot be longer than ${MAX_IDENTITY_LENGTH} characters`, {
			details: { field },
		});
	}
	// A control character would let an id break the derived attempt id
	// (`executionId#sequence`) or make two different ids print the same.
	if (/[\u0000-\u001f\u007f]/.test(value)) {
		throw new ValidationError(`A consumption ${field} cannot contain control characters`, {
			details: { field },
		});
	}
	return value;
}

/**
 * Refuses a secret-shaped field among the caller's own top-level fields.
 *
 * `assertNoSecretFields` matches on key names, and a key name with "token" in
 * it is secret-shaped unless it is a reference. That is right for a hand-built
 * record, but the consumption input *declares* `reportedTokens`/
 * `estimatedTokens`: a count of tokens is not a credential. So the guard here
 * looks only at the caller's object, and the record this store builds is
 * verified separately against its own fixed shape.
 */
function assertSecretFreeTopLevel(value: unknown): void {
	for (const key of Object.keys(value as object)) {
		if (/secret|password|passwd|authorization|bearer|credential|private[_-]?key|api[_-]?key/i.test(key)) {
			const named = String(key);
			throw new ValidationError(`Refusing to persist "${named}" in consumption attempt`, {
				details: { field: key },
			});
		}
	}
}

/** A 1-based attempt order inside its execution. */
function requireSequence(value: unknown): number {
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
		throw new ValidationError('sequence must be a whole number of one or more', {
			details: { field: 'sequence', received: value },
		});
	}
	return value;
}

function requireExecutionStatus(value: unknown): ExecutionStatus {
	if (value === 'success' || value === 'failure' || value === 'cancelled' || value === 'timeout') {
		return value;
	}
	throw new ValidationError('status must be success, failure, cancelled or timeout', {
		details: { field: 'status', received: value },
	});
}

function requireHttpStatus(value: unknown): number {
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 100 || value > 599) {
		throw new ValidationError('httpStatus must be an HTTP status code', {
			details: { field: 'httpStatus', received: value },
		});
	}
	return value;
}

/** Short, non-secret classification text. Bound so a caller cannot smuggle content in. */
function requireShortText(value: unknown, field: string): string {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new ValidationError(`${field} must be a non-empty string`, { details: { field } });
	}
	if (value.length > 64) {
		throw new ValidationError(`${field} cannot be longer than 64 characters`, { details: { field } });
	}
	return value;
}

/**
 * Validates token counts on the way in.
 *
 * Absent stays absent: `{}` is refused rather than stored as a reading of
 * nothing, because a later total would count it. A negative or fractional
 * count is refused, not clamped.
 */
function readTokenCountsInput(value: TokenCounts | undefined, field: string): TokenCounts | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (asObject(value) === undefined) {
		throw new ValidationError(`${field} must be an object`, { details: { field } });
	}
	const input = value.input === undefined ? undefined : requireTokenCount(value.input, `${field}.input`);
	const output = value.output === undefined ? undefined : requireTokenCount(value.output, `${field}.output`);
	const cachedInput =
		value.cachedInput === undefined ? undefined : requireTokenCount(value.cachedInput, `${field}.cachedInput`);
	if (input === undefined && output === undefined && cachedInput === undefined) {
		throw new ValidationError(`${field} must carry at least one token count`, { details: { field } });
	}
	if (input !== undefined && cachedInput !== undefined && cachedInput > input) {
		// Cached input is a part of the input, never a separate pot.
		throw new ValidationError(`${field}.cachedInput cannot exceed ${field}.input`, {
			details: { field: `${field}.cachedInput` },
		});
	}
	return {
		...(input !== undefined ? { input } : {}),
		...(output !== undefined ? { output } : {}),
		...(cachedInput !== undefined ? { cachedInput } : {}),
	};
}

/** The price applied to an attempt, as read from the catalog at call time. */
function normalizeAttemptPricing(
	value: NonNullable<RecordAttemptInput['pricing']>,
): NonNullable<RecordAttemptInput['pricing']> {
	const pricing = value;
	if (asObject(pricing) === undefined) {
		throw new ValidationError('pricing must be an object', { details: { received: typeof pricing } });
	}
	const currency = typeof pricing.currency === 'string' ? pricing.currency.trim() : '';
	if (currency.length === 0) {
		throw new ValidationError('pricing requires a currency', { details: { field: 'currency' } });
	}
	if (!isCostUnit(pricing.unit)) {
		throw new ValidationError('pricing requires a unit of per_1k_tokens or per_1m_tokens', {
			details: { field: 'unit' },
		});
	}
	return {
		currency,
		unit: pricing.unit,
		...(pricing.input !== undefined ? { input: requireCost(pricing.input, 'pricing.input') } : {}),
		...(pricing.output !== undefined ? { output: requireCost(pricing.output, 'pricing.output') } : {}),
		...(pricing.cachedInput !== undefined
			? { cachedInput: requireCost(pricing.cachedInput, 'pricing.cachedInput') }
			: {}),
	};
}

/** The scope kind a limit belongs to. */
function scopeKind(limit: SpendingLimit): 'model' | 'provider' | 'global' {
	if (limit.modelId !== undefined) {
		return 'model';
	}
	return limit.providerId !== undefined ? 'provider' : 'global';
}

/**
 * Validates what the caller asked to store.
 *
 * The scope is the identity, so the id is derived from it rather than trusted.
 * A caller that sends an id for a different scope is refused instead of
 * silently written to the wrong key. Timestamps are left to the store, which
 * owns the clock (`this.now`), so a limit written through it stays on the same
 * timeline as the ledger it bounds.
 */
function normalizeSpendingLimitInput(input: SaveSpendingLimitInput): Omit<SpendingLimit, 'createdAt' | 'updatedAt'> {
	const providerId =
		input.providerId === undefined ? undefined : requireIdentifier(input.providerId, 'providerId');
	const modelId = input.modelId === undefined ? undefined : requireIdentifier(input.modelId, 'modelId');
	if (modelId !== undefined && providerId === undefined) {
		throw new ValidationError('A model limit requires the provider that serves the model', {
			details: { field: 'providerId', modelId },
		});
	}
	const currency = requireText(input.currency, 'currency', 'A spending limit').trim();
	if (!/^[A-Za-z]{3}$/.test(currency)) {
		// Three letters, like the catalog: a limit in "US$" or "dólares" could
		// never be compared with the amount a price carries.
		throw new ValidationError('A spending limit requires a three-letter currency code', {
			details: { field: 'currency', received: input.currency },
		});
	}
	if (typeof input.amount !== 'number' || !Number.isFinite(input.amount) || input.amount < 0) {
		throw new ValidationError('A spending limit amount must be a finite number of zero or more', {
			details: { field: 'amount', received: input.amount },
		});
	}
	if (input.window !== 'day' && input.window !== 'month') {
		throw new ValidationError('A spending limit window must be day or month', {
			details: { field: 'window', received: input.window },
		});
	}
	const scope = {
		...(providerId !== undefined ? { providerId } : {}),
		...(modelId !== undefined ? { modelId } : {}),
		...(input.policy !== undefined ? { policy: input.policy } : {}),
	};
	const limitId = scopeIdFor(scope);
	if (input.limitId !== undefined && input.limitId !== limitId) {
		throw new ValidationError(`Spending limit id ${JSON.stringify(input.limitId)} does not match its scope`, {
			details: { field: 'limitId', expected: limitId, received: input.limitId },
		});
	}

	return {
		limitId,
		...scope,
		currency: currency.toUpperCase(),
		amount: input.amount,
		window: input.window,
	};
}

function matchesQuery(
	execution: ExecutionRecord,
	query: ConsumptionQuery,
	since: number | undefined,
	until: number | undefined,
): boolean {
	if (query.executionId !== undefined && execution.executionId !== query.executionId) {
		return false;
	}
	if (query.turnId !== undefined && execution.turnId !== query.turnId) {
		return false;
	}
	if (query.conversationId !== undefined && execution.conversationId !== query.conversationId) {
		return false;
	}
	if (query.providerId !== undefined && execution.providerId !== query.providerId) {
		return false;
	}
	if (query.modelId !== undefined && execution.modelId !== query.modelId) {
		return false;
	}
	const started = Date.parse(execution.startedAt);
	if (since !== undefined && started < since) {
		return false;
	}
	if (until !== undefined && started >= until) {
		return false;
	}
	return true;
}

/** Defensive copies, so a caller cannot reach back into the store's state. */
function copyExecution(execution: ExecutionRecord): ExecutionRecord {
	return {
		...execution,
		attemptIds: [...execution.attemptIds],
		totals: copyTotals(execution.totals),
	};
}

function copyAttempt(attempt: AttemptRecord): AttemptRecord {
	return {
		...attempt,
		...(attempt.reportedTokens !== undefined ? { reportedTokens: { ...attempt.reportedTokens } } : {}),
		...(attempt.estimatedTokens !== undefined ? { estimatedTokens: { ...attempt.estimatedTokens } } : {}),
		...(attempt.pricing !== undefined ? { pricing: { ...attempt.pricing } } : {}),
		cost: {
			...attempt.cost,
			parts: attempt.cost.parts.map((part) => ({ ...part })),
			...(attempt.cost.status === 'unknown' ? { reasons: [...attempt.cost.reasons] } : {}),
		},
	};
}

/** A copy whose totals come from the attempts, not from the stored cache. */
function withTotals(execution: ExecutionRecord, totals: ExecutionTotals): ExecutionRecord {
	return { ...execution, totals: copyTotals(totals) };
}

function copyTotals(totals: ExecutionTotals): ExecutionTotals {
	return {
		...totals,
		...(totals.tokens !== undefined ? { tokens: { ...totals.tokens } } : {}),
		cost: {
			...totals.cost,
			parts: totals.cost.parts.map((part) => ({ ...part })),
			...(totals.cost.status === 'unknown' ? { reasons: [...totals.cost.reasons] } : {}),
		},
	};
}

function requireTokenCount(value: number, field: string): number {
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
		throw new ValidationError(`${field} must be a whole number of zero or more`, {
			details: { field, received: value },
		});
	}
	return value;
}

function requireDuration(value: number, field: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
		throw new ValidationError(`${field} must be a number of milliseconds, zero or more`, {
			details: { field, received: value },
		});
	}
	return value;
}

function normalizeObservation(
	value: Omit<ModelObservation, 'at'> & { readonly at?: string },
	at: string,
): ModelObservation {
	if (asObject(value) === undefined) {
		throw new ValidationError('an observation must be an object', { details: { received: typeof value } });
	}
	return {
		at,
		...(value.firstByteMs !== undefined
			? { firstByteMs: requireDuration(value.firstByteMs, 'firstByteMs') }
			: {}),
		...(value.totalMs !== undefined ? { totalMs: requireDuration(value.totalMs, 'totalMs') } : {}),
		...(value.usage !== undefined ? { usage: normalizeUsage(value.usage) } : {}),
	};
}

/**
 * Written side of the usage rules.
 *
 * Throws on a count that is not a whole non-negative number rather than dropping
 * it: a measurement handed to this function is a measurement somebody asked to
 * store, and quietly discarding half of it would leave a record that looks
 * complete. Any field outside the closed `TokenUsage` shape is dropped, which is
 * what keeps a key from riding along inside it.
 */
function normalizeUsage(value: ModelUsage): ModelUsage {
	if (asObject(value) === undefined) {
		throw new ValidationError('usage must be an object', { details: { received: typeof value } });
	}
	const candidate = value as Record<string, unknown>;
	const count = (field: keyof ModelUsage): number | undefined => {
		const raw = candidate[field];
		if (raw === undefined) {
			return undefined;
		}
		if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
			throw new ValidationError(`usage.${field} must be a whole number of zero or more`, {
				details: { field, received: raw },
			});
		}
		return raw;
	};
	const promptTokens = count('promptTokens');
	const completionTokens = count('completionTokens');
	const totalTokens = count('totalTokens');
	const reasoningTokens = count('reasoningTokens');
	const cachedInputTokens = count('cachedInputTokens');
	return {
		...(promptTokens !== undefined ? { promptTokens } : {}),
		...(completionTokens !== undefined ? { completionTokens } : {}),
		...(totalTokens !== undefined ? { totalTokens } : {}),
		...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
		...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
	};
}

/** Written and read side share this, so a stored observation is always valid. */
function readObservation(value: unknown): ModelObservation | undefined {
	const candidate = asObject(value);
	if (candidate === undefined) {
		return undefined;
	}
	const at = candidate['at'];
	if (typeof at !== 'string' || at.length === 0) {
		return undefined;
	}
	const firstByteMs = candidate['firstByteMs'];
	const totalMs = candidate['totalMs'];
	const usage = asObject(candidate['usage']);
	return {
		at,
		...(typeof firstByteMs === 'number' && Number.isFinite(firstByteMs) && firstByteMs >= 0
			? { firstByteMs }
			: {}),
		...(typeof totalMs === 'number' && Number.isFinite(totalMs) && totalMs >= 0 ? { totalMs } : {}),
		...(usage !== undefined ? { usage: readUsage(usage) } : {}),
	};
}

/**
 * Keeps the token counts a provider reported, dropping anything else.
 *
 * The same rule `parseUsage` applies on the wire, so a measurement that arrives
 * through the chat path and one written by hand cannot mean different things.
 */
function readUsage(value: Record<string, unknown>): ModelUsage {
	const count = (input: unknown): number | undefined =>
		typeof input === 'number' && Number.isInteger(input) && input >= 0 ? input : undefined;
	const promptTokens = count(value['promptTokens']);
	const completionTokens = count(value['completionTokens']);
	const totalTokens = count(value['totalTokens']);
	const reasoningTokens = count(value['reasoningTokens']);
	const cachedInputTokens = count(value['cachedInputTokens']);
	return {
		...(promptTokens !== undefined ? { promptTokens } : {}),
		...(completionTokens !== undefined ? { completionTokens } : {}),
		...(totalTokens !== undefined ? { totalTokens } : {}),
		...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
		...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
	};
}

function readPricing(value: unknown): ModelPricing {
	const candidate = asObject(value) ?? {};
	const currency = typeof candidate['currency'] === 'string' ? candidate['currency'] : '';
	const unit = isCostUnit(candidate['unit']) ? candidate['unit'] : 'per_1k_tokens';
	const input = candidate['input'];
	const output = candidate['output'];
	const cachedInput = candidate['cachedInput'];
	return {
		currency,
		unit,
		...(typeof input === 'number' && Number.isFinite(input) && input >= 0 ? { input } : {}),
		...(typeof output === 'number' && Number.isFinite(output) && output >= 0 ? { output } : {}),
		...(typeof cachedInput === 'number' && Number.isFinite(cachedInput) && cachedInput >= 0
			? { cachedInput }
			: {}),
		...(isPriceSource(candidate['source']) ? { source: candidate['source'] } : {}),
	};
}

/**
 * Read side of the capability block.
 *
 * A field that is neither `true` nor `false` is dropped, not coerced: a string
 * `"yes"` in a hand-edited file is not a declaration that the model supports
 * something, and reading it as one would put a guess where a fact belongs.
 */
function readCapabilities(value: unknown): ModelCapabilities {
	const candidate = asObject(value) ?? {};
	const readFlag = (name: string): boolean | undefined => {
		const raw = candidate[name];
		return typeof raw === 'boolean' ? raw : undefined;
	};
	const readModalities = <K extends string>(name: string): Partial<Record<K, boolean>> => {
		const raw = asObject(candidate[name]);
		if (raw === undefined) {
			return {};
		}
		const next: Partial<Record<K, boolean>> = {};
		for (const [label, entry] of Object.entries(raw)) {
			if (typeof entry === 'boolean') {
				next[label as K] = entry;
			}
		}
		return next;
	};
	const inputs = readModalities<InputModality>('inputs');
	const outputs = readModalities<OutputModality>('outputs');
	const toolCalling = readFlag('toolCalling');
	const structuredOutput = readFlag('structuredOutput');
	const reasoning = readFlag('reasoning');
	return {
		...(toolCalling !== undefined ? { toolCalling } : {}),
		...(structuredOutput !== undefined ? { structuredOutput } : {}),
		...(reasoning !== undefined ? { reasoning } : {}),
		...(Object.keys(inputs).length > 0 ? { inputs } : {}),
		...(Object.keys(outputs).length > 0 ? { outputs } : {}),
	};
}

/**
 * Read side of the origin.
 *
 * An origin with no source falls back to the record's own `updatedAt` only as
 * a timestamp, never as an attribution: a record that never said where its
 * metadata came from stays `unknown`.
 */
function readMetadataOrigin(value: unknown, recordUpdatedAt: string | undefined): ModelMetadataOrigin {
	const candidate = asObject(value) ?? {};
	const source = candidate['source'];
	const updatedAt = candidate['updatedAt'];
	return {
		source: isMetadataSource(source) ? source : 'unknown',
		...(typeof updatedAt === 'string'
			? { updatedAt }
			: recordUpdatedAt !== undefined
				? { updatedAt: recordUpdatedAt }
				: {}),
	};
}

function isPriceSource(value: unknown): value is PriceSource {
	return value === 'manual' || value === 'provider' || value === 'unknown';
}

function isMetadataSource(value: unknown): value is ModelMetadataSource {
	return value === 'manual' || value === 'provider' || value === 'unknown';
}

function readLimits(value: unknown): ModelLimits {
	const candidate = asObject(value) ?? {};
	const contextTokens = candidate['contextTokens'];
	const maxOutputTokens = candidate['maxOutputTokens'];
	return {
		...(typeof contextTokens === 'number' && Number.isInteger(contextTokens) && contextTokens >= 0
			? { contextTokens }
			: {}),
		...(typeof maxOutputTokens === 'number' && Number.isInteger(maxOutputTokens) && maxOutputTokens >= 0
			? { maxOutputTokens }
			: {}),
	};
}

function isAccess(value: unknown): value is ModelAccess {
	return value === 'free' || value === 'paid' || value === 'unknown';
}

function isCostUnit(value: unknown): value is CostUnit {
	return value === 'per_1k_tokens' || value === 'per_1m_tokens';
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0;
}

/**
 * Narrowing read of a conversation file.
 *
 * Individual malformed messages are dropped rather than failing the whole file:
 * one bad entry should not cost the entire transcript.
 */
function toConversationFile(value: unknown): ConversationFile | undefined {
	const candidate = asObject(value);
	if (candidate === undefined) {
		return undefined;
	}
	const { id, title, createdAt, updatedAt, providerId, projectId } = candidate;
	if (
		typeof id !== 'string' ||
		id.length === 0 ||
		typeof title !== 'string' ||
		typeof createdAt !== 'string' ||
		typeof updatedAt !== 'string'
	) {
		return undefined;
	}
	const rawMessages = Array.isArray(candidate.messages) ? candidate.messages : [];
	return {
		version: typeof candidate.version === 'number' ? candidate.version : SCHEMA_VERSION,
		id,
		...(typeof providerId === 'string' && providerId.length > 0 ? { providerId } : {}),
		...(typeof projectId === 'string' && projectId.length > 0 ? { projectId } : {}),
		title,
		createdAt,
		updatedAt,
		// Só `true` é a marca. Um valor de outra forma é ignorado em vez de
		// virar "fixo" por acidente, que impediria a exclusão sem ninguém ter
		// pedido.
		...(candidate.pinned === true ? { pinned: true } : {}),
		messages: rawMessages
			.map((entry, index) => toConversationMessage(entry, index))
			.filter((entry): entry is ConversationMessage => entry !== undefined),
	};
}

function toConversationMessage(value: unknown, fallbackSeq: number): ConversationMessage | undefined {
	const candidate = asObject(value);
	if (candidate === undefined || typeof candidate.content !== 'string' || !isRole(candidate.role)) {
		return undefined;
	}
	// Tolerated rather than required: a transcript written before this field
	// existed still reads, it simply sends the assistant message without its
	// `tool_calls` — the same request the previous version sent.
	const toolCalls = toToolCalls(candidate.toolCalls);
	return {
		id: typeof candidate.id === 'string' ? candidate.id : `message-${fallbackSeq}`,
		seq: typeof candidate.seq === 'number' ? candidate.seq : fallbackSeq,
		role: candidate.role,
		content: candidate.content,
		createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : '',
		...(typeof candidate.toolCallId === 'string' ? { toolCallId: candidate.toolCallId } : {}),
		...(toolCalls !== undefined ? { toolCalls } : {}),
		// R4Q: um histórico anterior à chave de idempotência continua legível —
		// ele simplesmente não tem nenhuma.
		...(typeof candidate.requestId === 'string' ? { requestId: candidate.requestId } : {}),
	};
}

/**
 * Narrows `toolCalls` to the only shape that can be replayed on the wire.
 *
 * Written side, this throws: storing a half-formed call would be a request
 * that fails several turns later, far from the mistake that made it. Read
 * side, a bad entry is dropped instead — one damaged message must not cost
 * the transcript.
 */
function toToolCalls(
	value: unknown,
	options: { readonly strict?: boolean } = {},
): readonly ToolCallRequest[] | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value)) {
		if (options.strict === true) {
			throw new ValidationError('toolCalls must be an array', {
				details: { received: typeof value },
			});
		}
		return undefined;
	}
	const calls: ToolCallRequest[] = [];
	for (const entry of value) {
		const call = asObject(entry);
		const id = call?.id;
		const name = call?.name;
		const args = call?.arguments;
		if (
			call === undefined ||
			typeof id !== 'string' ||
			id.length === 0 ||
			typeof name !== 'string' ||
			name.length === 0 ||
			typeof args !== 'string'
		) {
			if (options.strict === true) {
				throw new ValidationError('every toolCalls entry needs id, name and string arguments', {
					details: { entry },
				});
			}
			continue;
		}
		calls.push({ id, name, arguments: args });
	}
	return calls;
}

function toSummary(file: ConversationFile): ConversationSummary {
	return {
		id: file.id,
		...(file.providerId !== undefined ? { providerId: file.providerId } : {}),
		...(file.projectId !== undefined ? { projectId: file.projectId } : {}),
		title: file.title,
		createdAt: file.createdAt,
		updatedAt: file.updatedAt,
		...(file.pinned === true ? { pinned: true } : {}),
		messageCount: file.messages.length,
	};
}

function toRecord(file: ConversationFile): ConversationRecord {
	return {
		id: file.id,
		...(file.providerId !== undefined ? { providerId: file.providerId } : {}),
		...(file.projectId !== undefined ? { projectId: file.projectId } : {}),
		title: file.title,
		createdAt: file.createdAt,
		updatedAt: file.updatedAt,
		...(file.pinned === true ? { pinned: true } : {}),
		// Explicitly sorted: a caller must never have to know how the file was
		// written to get the transcript back in order.
		messages: [...file.messages].sort((a, b) => a.seq - b.seq).map((message) => ({ ...message })),
	};
}

/** Oldest first, with the id as tie-break so the ordering is total. */
function byCreation(a: ConversationSummary, b: ConversationSummary): number {
	return a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt);
}

function isRole(value: unknown): value is ConversationRole {
	return (
		value === 'system' || value === 'user' || value === 'assistant' || value === 'tool'
	);
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/**
 * Rejects blank text.
 *
 * `subject` names what the field belongs to, so the message reads "A project
 * requires…" for a project and "A conversation requires…" for a title, instead
 * of one of them being quietly wrong.
 */
function requireText(value: string, field: string, subject = 'A project'): string {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new ValidationError(`${subject} requires a non-empty ${field}`, {
			details: { field },
		});
	}
	return value;
}

function isNotFound(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		(error as { code?: string }).code === 'ENOENT'
	);
}

/** Removes the whole data directory. Used by tests and by a future "reset". */
export async function removeDataStore(rootPath: string): Promise<void> {
	try {
		await rm(rootPath, { recursive: true, force: true });
	} catch (error) {
		throw new StorageError(`Could not remove the data directory at ${rootPath}`, {
			cause: error,
			details: { path: rootPath },
		});
	}
}
