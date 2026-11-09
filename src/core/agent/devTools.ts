/**
 * As ferramentas do modo DEV (DEV-2).
 *
 * ## O que as separa das ferramentas comuns
 *
 * `read_file`/`write_file` operam no workspace **do projeto da conversa** —"
 * que pode ser qualquer diretório que o usuário apontou. As `dev_*` operam no
 * **repositório da própria Evelyn**, fixado pela sessão, e só existem
 * enquanto ela está ativa.
 *
 * ## A fronteira, em três camadas
 *
 * 1. **Sessão**: cada `execute` pergunta `session.isActive()` —" não basta a
 *    ferramenta estar registrada. Ao sair do DEV, a próxima chamada é
 *    recusada mesmo que o registro ainda não tenha sido removido.
 * 2. **Raiz**: `Workspace` reutilizado, com a raiz da sessão. `..`, caminho
 *    absoluto externo e symlink que escapa caem no mesmo teste já provado.
 * 3. **Permissão**: `dev_write`, `dev_run`, `dev_checkpoint` e `dev_restore`
 *    são `dangerous`; o gateway do host pergunta antes de cada uma.
 *
 * ## O que as `dev_*` não fazem
 *
 * Não ativam a sessão, não trocam a raiz, não alteram a allowlist e não
 * recebem "permissão" por argumento. O modelo pode pedir, mas quem decide é a
 * sessão em memória do processo principal.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { AgentTool, ToolDescriptor, ToolExecutionContext, ToolResult } from './types';
import type { ToolSpec } from './toolRegistry';
import { AgentError } from '../errors';
import { Workspace } from './workspace';
import type { DevSessionRef } from '../dev/devSession';
import type { DevCheckpointStore } from '../dev/devCheckpoint';
import type { DevRunner, DevTermination } from '../dev/devRunner';
import type { DevAuditSink } from '../dev/devAudit';
import { DevRestoreConflictError } from '../dev/devCheckpoint';
import { classifyPath, protectedMessage } from '../dev/devPolicy';
import { DEV_READ_LIMIT_BYTES, readDevFile } from '../dev/devRead';
import type { DevLocks } from '../dev/devLocks';
import { busyMessage, resourceKeyFor } from '../dev/devLocks';
import { acquireDevLockForSession } from '../dev/devFileLock';
import type { PreparedChangeJournal } from '../dev/preparedChange';
import { createDevApplyTool, DEV_APPLY_SPEC, type DevApplyDeps } from './devApplyTool';
import type { DevOperationStore, DevOperation } from '../dev/devOperation';
import { advance, isUnfinished, startOperation } from '../dev/devOperation';
import { planApply } from '../dev/applyPolicy';
import type { PreparedChange } from '../dev/preparedChange';

export const DEV_READ = 'dev_read';
export const DEV_WRITE = 'dev_write';
export const DEV_EDIT = 'dev_edit';
export const DEV_RUN = 'dev_run';
export const DEV_CHECKPOINT = 'dev_checkpoint';
export const DEV_RESTORE = 'dev_restore';

/** O que as ferramentas DEV precisam. */
export interface DevToolDeps {
	/** A sessão: as ferramentas só perguntam se está ativa e qual é a raiz. */
	readonly session: DevSessionRef;
	readonly checkpoints: DevCheckpointStore;
	readonly runner: DevRunner;
	/** A trava compartilhada com o `run_command` comum (DEV-2.1). */
	readonly locks: DevLocks;
	/** Quanto esperar a trava **entre processos** (DEV-2.2). Padrão: 30 s. */
	readonly crossProcessWaitMs?: number;
	/**
	 * O diário da alteração em preparação (DEV-5).
	 *
	 * Ausente = `dev_write` escreve mas não registra nada para aplicar; o
	 * gatilho `dev_apply` também não existe. O host que quer o modo DEV
	 * completo passa o diário.
	 */
	readonly journal?: PreparedChangeJournal;
	/**
	 * O gatilho de aplicação (DEV-5), quando o host o oferece.
	 *
	 * Sem isto, `dev_apply` não é registrada —" não existe uma versão que
	 * "simula" a aplicação.
	 */
	readonly apply?: DevApplyDeps;
	/**
	 * O registro da operação (DEV-6).
	 *
	 * Ausente, as escritas vão para o diário mas **não** têm etapa em disco: a
	 * operação não aparece no painel nem na retomada, porque não há estado
	 * fora da memória. O host que monta o painel passa o store, para a
	 * preparação ficar visível como `written` desde a primeira escrita.
	 */
	readonly operations?: DevOperationStore;
	/** Relógio, injetável em teste. */
	readonly now?: () => Date;
	/**
	 * A pergunta da aprovação do `dev_run` (DEV-9.1).
	 *
	 * Ausente, a ferramenta não pergunta —" o que preserva o comportamento
	 * anterior em testes e hosts que não montam a aprovação. O host do
	 * desktop monta; a interface mostra o comando, o diretório e o escopo, e
	 * a resposta vale **só para aquele comando**.
	 */
	readonly approveCommand?: (request: {
		readonly command: string;
		readonly cwd: string;
		readonly scope: string;
		readonly timeoutMs: number;
	}) => Promise<'approved' | 'refused' | 'cancelled'>;
	/** O diário das execuções do `dev_run`. */
	readonly audit?: DevAuditSink;
}

/**
 * Nomes que nunca são alcançáveis pelo DEV, mesmo dentro do repositório.
 *
 * A regra ampla mora em `devPolicy.ts`; esta lista ficou só para os dois
 * arquivos de credencial do próprio app, que a política já cobre —" mantida
 * como lembrete explícito e para o teste apontar os dois.
 */
const DENIED_FILE_NAMES: ReadonlySet<string> = new Set(['service.json', 'secrets.json']);

/** A recusa quando a sessão não está ativa. */
function inactive<T>(): ToolResult<T> {
	return {
		ok: false,
		error: 'o modo DEV não está ativo; peça ao proprietário para ativá-lo',
	};
}

/** A recusa por nome de arquivo protegido. */
function denied<T>(path: string): ToolResult<T> {
	return {
		ok: false,
		error: `"${path}" é um arquivo de credenciais e não é acessível pelo modo DEV`,
	};
}

function failure<T>(error: unknown): ToolResult<T> {
	if (error instanceof AgentError) {
		return { ok: false, error: error.message };
	}
	if (error instanceof Error) {
		return { ok: false, error: error.message };
	}
	return { ok: false, error: String(error) };
}

function argString(input: unknown, key: string): string {
	const value = (input as Record<string, unknown> | undefined)?.[key];
	if (typeof value !== 'string' || value.length === 0) {
		throw new AgentError(`The "${key}" argument must be a non-empty string`);
	}
	return value;
}

function workspaceOf(session: DevSessionRef): Workspace {
	return new Workspace(session.root());
}

/**
 * O caminho pedido, depois da fronteira de `Workspace`, ou recusa.
 *
 * A política de caminhos protegidos (`devPolicy`) vale para **leitura e
 * escrita**: o `.env` do repositório não é código, e um `write_file` nele
 * seria a forma mais direta de trocar uma chave de API do projeto.
 */
async function safePath(session: DevSessionRef, path: string, mode: 'read' | 'write'): Promise<string> {
	const workspace = workspaceOf(session);
	const resolved = mode === 'read' ? await workspace.resolveInside(path) : await workspace.resolveInsideForCreate(path);
	const verdict = classifyPath(resolved);
	if (verdict.protected) {
		throw new AgentError(protectedMessage(path, verdict));
	}
	return resolved;
}

/**
 * A trava do repositório, para escrita e execução não se atropelarem.
 *
 * ## Duas camadas, nesta ordem
 *
 * 1. **Por processo** (`DevLocks`, da DEV-2.1): impede que duas operações do
 *    mesmo app disputem —" é a que espera e recusa no prazo, barata.
 * 2. **Entre processos** (`devFileLock`, da DEV-2.2): um arquivo aberto na
 *    raiz, com `wx`. — a que vale quando o **serviço** (outro processo) roda
 *    um comando no mesmo repositório.
 *
 * A ordem é sempre a mesma —" processo, depois arquivo —" e a liberação é a
 * inversa, em `finally`. Duas operações nunca pegam "arquivo, depois
 * processo", então não há ciclo de espera.
 *
 * ## Quem libera
 *
 * O `finally` de dentro solta o arquivo, o de fora solta o processo. Um erro
 * no meio, um cancelamento, um timeout: todos passam pelos dois `finally`.
 * A trava entre processos é liberada **depois** de `work()` terminar, e
 * `work()` só termina quando o comando filho terminou —" por construção, a
 * trava não é solta com um processo ainda escrevendo.
 */
async function withRepositoryLock<T>(
	deps: DevToolDeps,
	signal: AbortSignal | undefined,
	work: () => Promise<T>,
): Promise<T> {
	return withDevRepositoryLock(deps, signal, work);
}

/**
 * A trava do repositório, para quem não é uma ferramenta (DEV-5: o fluxo de
 * aplicação reescreve os arquivos no ponto em que a mudança vale).
 *
 * Quem chama é o host —" com o **mesmo** `DevToolDeps` que as ferramentas usam,
 * para que a coordenação seja a de sempre e não uma paralela.
 */
export async function withDevRepositoryLock<T>(
	deps: Pick<DevToolDeps, 'locks' | 'session' | 'crossProcessWaitMs'>,
	signal: AbortSignal | undefined,
	work: () => Promise<T>,
): Promise<T> {
	const release = await deps.locks.acquire(resourceKeyFor(deps.session.root()));
	try {
		// `acquireDevLockForSession`: quando **esta** sessão é a dona da raiz,
		// é um empréstimo reentrante; senão, a aquisição comum.
		const fileLock = await acquireDevLockForSession(deps.session.root(), deps.session, {
			waitMs: deps.crossProcessWaitMs ?? 30_000,
		});
		if (fileLock.kind !== 'acquired') {
			// DEV-AUDIT-01: o PID e o motivo vão na mensagem; sem eles, quem lê
			// o erro não sabe qual processo investigar.
			throw new AgentError(`${busyMessage(fileLock)}; nada foi escrito nem executado —" tente de novo quando ele liberar`);
		}
		try {
			// Abortar no meio de uma escrita deixaria o arquivo pela metade;
			// o sinal vale para o comando, que sabe se encerrar (DevRunner).
			void signal;
			return await work();
		} finally {
			await fileLock.lock.release();
		}
	} finally {
		// Sempre solta: sucesso, erro, cancelamento e timeout passam por aqui.
		release();
	}
}

/**
 * `dev_read`: lê um arquivo do repositório.
 *
 * ## Risco `moderate`
 *
 * Um arquivo dentro do repositório pode conter o que não é código: um texto
 * de configuração com o token de um ambiente, um fixture com dados reais. A
 * política de caminhos recusa os formatos conhecidos, mas ela é uma lista —"
 * e lista não é prova. `moderate` faz o host pedir confirmação, que é o
 * mínimo honesto para "ler um arquivo do projeto da Evelyn".
 *
 * ## Limite
 *
 * Lê no máximo `DEV_READ_LIMIT_BYTES` do disco (ver `devRead`). Acima disso,
 * recusa —" a menos que o chamador peça explicitamente o trecho, e então o
 * resultado diz `truncated: true`.
 */
export function createDevReadTool(
	deps: DevToolDeps,
): AgentTool<unknown, { readonly path: string; readonly content: string; readonly truncated: boolean }> {
	const descriptor: ToolDescriptor = {
		id: DEV_READ,
		name: DEV_READ,
		category: 'filesystem',
		riskLevel: 'moderate',
		description: 'Read a file from the Evelyn repository (DEV mode only)',
	};
	return {
		descriptor,
		async execute(input): Promise<ToolResult<{ path: string; content: string; truncated: boolean }>> {
			if (!deps.session.isActive()) {
				return inactive();
			}
			try {
				const requested = argString(input, 'path');
				const resolved = await safePath(deps.session, requested, 'read');
				const allowTruncation = (input as { partial?: unknown } | undefined)?.partial === true;
				const read = await readDevFile(resolved, {
					limitBytes: DEV_READ_LIMIT_BYTES,
					allowTruncation,
				});
				if (!read.ok) {
					return { ok: false, error: read.error };
				}
				return { ok: true, output: { path: requested, content: read.content, truncated: read.truncated } };
			} catch (error) {
				// DEV-AUDIT-01: um `ENOENT` chegava ao modelo como "ENOENT: no such
				// file or directory, stat 'C:\...'". O caminho absoluto no
				// vazamento é detalhe de máquina e a frase não diz o que fazer.
				// O caso é o mais comum de todos —" caminho errado —" e merece
				// mensagem própria.
				const code = (error as { readonly code?: unknown }).code;
				if (code === 'ENOENT') {
					return {
						ok: false,
						error: `o arquivo "${String((input as { path?: unknown } | undefined)?.path ?? '')}" não existe no repositório`,
					};
				}
				return failure(error);
			}
		},
	};
}

/**
 * `dev_write`: escreve um arquivo do repositório.
 *
 * A ordem é: sessão —' caminho válido —' checkpoint do conteúdo anterior —'
 * escrita atômica —' selo do checkpoint. Se a escrita falhar, o checkpoint
 * continua lá com os bytes anteriores: o estado é recuperável mesmo quando a
 * operação não conclui.
 *
 * ## O diário (DEV-5)
 *
 * Quando o host oferece um `PreparedChangeJournal`, cada escrita é registrada
 * na operação em preparação, e o resultado devolve o `operationId`. — ele que
 * o agente passa ao gatilho (`dev_apply`) para aplicar a mudança —" sem que o
 * gatilho tenha de adivinhar o que foi escrito.
 */
/**
 * Grava em disco a operação preparada como `written` (DEV-6).
 *
 * O store tem **uma** operação por vez. A primeira escrita da preparação abre
 * o registro; as seguintes só atualizam arquivos e hora, mantendo a etapa
 * registrada —" reescrever como `written` apagaria uma aplicação em curso.
 *
 * `cache` guarda o que já foi lido do store por `nonce`, para duas escritas
 * seguidas não disputarem a leitura.
 */
async function recordWritten(
	store: DevOperationStore,
	prepared: PreparedChange,
	cache: { current?: DevOperation },
	now: (() => Date) | undefined,
): Promise<void> {
	if (cache.current === undefined) {
		cache.current = await store.read().catch(() => undefined);
	}
	const at = now ?? (() => new Date());
	const previous = cache.current;
	if (previous !== undefined && previous.nonce === prepared.nonce) {
		// Desta mesma preparação: mantém a etapa (uma aplicação pode estar em
		// curso) e atualiza só o que mudou.
		const updated: DevOperation = { ...previous, files: [...prepared.files], updatedAt: at().toISOString() };
		await store.write(updated);
		cache.current = updated;
		return;
	}
	// O store tem uma operação por vez. Uma preparação nova substitui a que
	// estava lá —" **exceto** quando ela ficou a meio caminho, porque o estado
	// dela é o que permite recuperar (e o painel é onde se vê). Nesse caso a
	// preparação nova fica no diário e a operação antiga continua em disco:
	// sobrescrever apagaria o registro de uma mudança ainda por resolver.
	if (previous !== undefined && (previous.stage === 'applying' || previous.stage === 'verification-failed')) {
		return;
	}
	const base = startOperation({
		...(prepared.conversationId !== undefined ? { conversationId: prepared.conversationId } : {}),
		strategy: planApply(prepared.files).strategy,
		files: prepared.files,
		...(now !== undefined ? { now } : {}),
	});
	const written: DevOperation = { ...base, nonce: prepared.nonce, stage: 'written' };
	await store.write(written);
	cache.current = written;
}

export function createDevWriteTool(
	deps: DevToolDeps,
): AgentTool<unknown, { readonly path: string; readonly bytes: number; readonly checkpoint: string; readonly operationId?: string }> {
	const descriptor: ToolDescriptor = {
		id: DEV_WRITE,
		name: DEV_WRITE,
		category: 'filesystem',
		riskLevel: 'dangerous',
		description: 'Write a file in the Evelyn repository, after a checkpoint (DEV mode only)',
	};
	return {
		descriptor,
		async execute(input): Promise<
			ToolResult<{ path: string; bytes: number; checkpoint: string; operationId?: string }>
		> {
			if (!deps.session.isActive()) {
				return inactive();
			}
			// O que já se sabe do store nesta chamada (DEV-6): lido uma vez.
			const storeCache: { current?: DevOperation } = {};
			try {
				const requested = argString(input, 'path');
				const content = argString(input, 'content');
				const root = deps.session.root();
				const resolved = await safePath(deps.session, requested, 'write');
				// O id vem do agente **se** ele já abriu a operação; senão o
				// diário abre uma nova. O caminho nunca vem daqui: é o
				// `session.root()`, a raiz que o host autorizou.
				const requestedOperation = (input as { readonly operationId?: unknown } | undefined)?.operationId;
				const journal = deps.journal;
				const operationId =
					journal === undefined
						? undefined
						: typeof requestedOperation === 'string' && journal.get(requestedOperation) !== undefined
							? requestedOperation
							: // A sessão já está ativa (checado acima): o token
								// marca a operação como desta sessão, e não de uma
								// entrada anterior.
								journal.start({ root, files: [], sessionToken: deps.session.sessionToken() })
									.operationId;

				// A trava do repositório vale para escrita e execução: um
				// `run_command` comum no mesmo repositório não pode estar lendo o
				// arquivo enquanto ele é trocado.
				return await withRepositoryLock(deps, undefined, async () => {
					// O checkpoint vem antes da escrita; sem ele não se escreve.
					const checkpoint = await deps.checkpoints.capture({
						root,
						path: requested,
						operation: 'dev_write',
					});
					await mkdir(dirname(resolved), { recursive: true });
					await writeFile(resolved, content, 'utf8');
					await deps.checkpoints.seal(checkpoint, root, requested);
					if (journal !== undefined && operationId !== undefined) {
						// Só depois de a escrita existir: o diário aponta para um
						// arquivo que está no disco.
						const prepared = journal.note({ operationId, path: requested, content });
						// DEV-6: a operação em disco diz "escrita" desde a primeira
						// escrita. Sem isto, o painel e a retomada não teriam o
						// que mostrar antes do gatilho —" e a preparação viva
						// existiria só na memória.
						if (deps.operations !== undefined && prepared !== undefined) {
							await recordWritten(deps.operations, prepared, storeCache, deps.now);
						}
					}
					return {
						ok: true as const,
						output: {
							path: requested,
							bytes: Buffer.byteLength(content, 'utf8'),
							checkpoint,
							...(operationId !== undefined ? { operationId } : {}),
						},
					};
				});
			} catch (error) {
				return failure(error);
			}
		},
	};
}

/**
 * `dev_edit`: troca um trecho exato, sem reescrever o arquivo inteiro.
 *
 * ## Por que existe
 *
 * `dev_write` recebe o **conteúdo completo**. Num arquivo de 270 KB, trocar
 * uma linha significava o modelo reemitir as 6 805 linhas — e um erro no meio
 * corromperia o arquivo por causa de uma palavra. Medido: a agente encontrou
 * a linha certa, recusou-se a regravar o arquivo (com razão) e a mudança
 * parou ali.
 *
 * A substituição exata resolve o caso geral: `oldText` tem de aparecer no
 * arquivo, e **uma única vez** quando `replaceAll` não vem. Zero ocorrências
 * é recusa (o trecho não está lá); mais de uma também é recusa (qual delas?),
 * e o resultado diz quantas são — o modelo corrige o trecho e tenta de novo,
 * em vez de adivinhar.
 *
 * O checkpoint e a trava são os mesmos de `dev_write`: a escrita continua
 * sendo uma escrita, e o arquivo anterior continua recuperável.
 */
export function createDevEditTool(
	deps: DevToolDeps,
): AgentTool<unknown, { readonly path: string; readonly replacements: number; readonly bytes: number; readonly checkpoint: string; readonly operationId?: string }> {
	const descriptor: ToolDescriptor = {
		id: DEV_EDIT,
		name: DEV_EDIT,
		category: 'filesystem',
		riskLevel: 'dangerous',
		description:
			'Replace an exact piece of text in a file of the Evelyn repository, after a checkpoint (DEV mode only)',
	};
	return {
		descriptor,
		async execute(input): Promise<
			ToolResult<{ path: string; replacements: number; bytes: number; checkpoint: string; operationId?: string }>
		> {
			if (!deps.session.isActive()) {
				return inactive();
			}
			const storeCache: { current?: DevOperation } = {};
			try {
				const requested = argString(input, 'path');
				const oldText = argString(input, 'oldText');
				const newText = argString(input, 'newText');
				const replaceAll = (input as { readonly replaceAll?: unknown } | undefined)?.replaceAll === true;
				if (oldText.length === 0) {
					throw new AgentError('"oldText" está vazio: diga exatamente o que deve sair do arquivo');
				}
				if (oldText === newText) {
					throw new AgentError('"oldText" e "newText" são iguais: nada mudaria');
				}
				const root = deps.session.root();
				const resolved = await safePath(deps.session, requested, 'write');
				const before = await readFile(resolved, 'utf8').catch((error: unknown) => {
					const code = (error as { readonly code?: unknown } | undefined)?.code;
					if (code === 'ENOENT') {
						throw new AgentError(`o arquivo "${requested}" não existe no repositório`);
					}
					throw error;
				});
				const occurrences = countOccurrences(before, oldText);
				if (occurrences === 0) {
					throw new AgentError(
						`"oldText" não aparece em "${requested}". Leia o arquivo e copie o trecho exatamente como está — espaços, acentos e quebras de linha contam.`,
					);
				}
				if (occurrences > 1 && !replaceAll) {
					throw new AgentError(
						`"oldText" aparece ${occurrences} vezes em "${requested}". Inclua o contexto que distingue o trecho, ou passe "replaceAll": true para trocar todas.`,
					);
				}
				const after = replaceAll
					? before.split(oldText).join(newText)
					: before.replace(oldText, () => newText);
				const journal = deps.journal;
				const requestedOperation = (input as { readonly operationId?: unknown } | undefined)?.operationId;
				const operationId =
					journal === undefined
						? undefined
						: typeof requestedOperation === 'string' && journal.get(requestedOperation) !== undefined
							? requestedOperation
							: journal.start({ root, files: [], sessionToken: deps.session.sessionToken() }).operationId;
				return await withRepositoryLock(deps, undefined, async () => {
					const checkpoint = await deps.checkpoints.capture({
						root,
						path: requested,
						operation: 'dev_edit',
					});
					// Escrita atômica: o arquivo é substituído inteiro, nunca meio
					// escrito. Uma interrupção deixa o anterior, não um híbrido.
					await writeFile(resolved, after, 'utf8');
					await deps.checkpoints.seal(checkpoint, root, requested);
					if (journal !== undefined && operationId !== undefined) {
						const prepared = journal.note({ operationId, path: requested, content: after });
						if (deps.operations !== undefined && prepared !== undefined) {
							await recordWritten(deps.operations, prepared, storeCache, deps.now);
						}
					}
					return {
						ok: true as const,
						output: {
							path: requested,
							replacements: replaceAll ? occurrences : 1,
							bytes: Buffer.byteLength(after, 'utf8'),
							checkpoint,
							...(operationId !== undefined ? { operationId } : {}),
						},
					};
				});
			} catch (error) {
				return failure(error);
			}
		},
	};
}

/** Quantas vezes `needle` aparece em `haystack`, sem sobreposição. */
function countOccurrences(haystack: string, needle: string): number {
	if (needle.length === 0) {
		return 0;
	}
	let count = 0;
	let at = haystack.indexOf(needle);
	while (at !== -1) {
		count += 1;
		at = haystack.indexOf(needle, at + needle.length);
	}
	return count;
}

/** `dev_run`: roda uma verificação permitida no repositório. */
export function createDevRunTool(
	deps: DevToolDeps,
): AgentTool<
	unknown,
	{
		readonly exitCode: number;
		readonly stdout: string;
		readonly stderr: string;
		readonly termination: DevTermination;
		readonly abortWarning?: string;
	}
> {
	const descriptor: ToolDescriptor = {
		id: DEV_RUN,
		name: DEV_RUN,
		category: 'terminal',
		riskLevel: 'dangerous',
		description: 'Run an allowed development command (tests, typecheck, build) in the repository (DEV mode only)',
	};
	return {
		descriptor,
		async execute(input, context: ToolExecutionContext): Promise<
			ToolResult<{
				exitCode: number;
				stdout: string;
				stderr: string;
				termination: DevTermination;
				abortWarning?: string;
			}>
		> {
			if (!deps.session.isActive()) {
				return inactive();
			}
			try {
				const command = argString(input, 'command');
				// A política é a do runner (allowlist, caminho, encadeamento);
				// esta chamada acrescenta a **aprovação por comando** e o
				// diário (DEV-9.1). Sem `approveCommand`, o comportamento é o
				// anterior —" e o documento diz que assim não há aprovação.
				const outcome = await withRepositoryLock(deps, context.signal, async () =>
					await deps.runner.run(command, deps.session.root(), context.signal, {
						...(deps.approveCommand !== undefined ? { approve: deps.approveCommand } : {}),
						...(deps.audit !== undefined ? { audit: deps.audit } : {}),
					}),
				);
				return {
					ok: true,
					output: {
						exitCode: outcome.exitCode,
						stdout: outcome.stdout,
						stderr: outcome.stderr,
						// O motivo do encerramento vai junto: `exitCode -1` sem
						// dizer se foi prazo ou cancelamento é a diferença entre
						// "seu teste travou" e "você parou a tarefa".
						termination: outcome.termination,
						...(outcome.abortWarning !== undefined ? { abortWarning: outcome.abortWarning } : {}),
					},
				};
			} catch (error) {
				return failure(error);
			}
		},
	};
}

/** `dev_checkpoint`: lista o que existe ou cria um marco explicativo. */
export function createDevCheckpointTool(deps: DevToolDeps): AgentTool<unknown, { readonly checkpoints: readonly string[] }> {
	const descriptor: ToolDescriptor = {
		id: DEV_CHECKPOINT,
		name: DEV_CHECKPOINT,
		category: 'other',
		riskLevel: 'safe',
		description: 'List the DEV checkpoints (DEV mode only)',
	};
	return {
		descriptor,
		async execute(): Promise<ToolResult<{ checkpoints: readonly string[] }>> {
			if (!deps.session.isActive()) {
				return inactive();
			}
			try {
				const entries = await deps.checkpoints.list();
				return { ok: true, output: { checkpoints: entries.map((entry) => `${entry.id} (${entry.files.length} arquivo(s))`) } };
			} catch (error) {
				return failure(error);
			}
		},
	};
}

/**
 * `dev_restore`: restaura um checkpoint.
 *
 * Conflito **não** é resolvido por padrão: pede confirmação. — a diferença
 * entre "desfazer o que o DEV fez" e "apagar o que o usuário fez depois".
 */
export function createDevRestoreTool(deps: DevToolDeps): AgentTool<unknown, { readonly restored: readonly string[]; readonly removed: readonly string[] }> {
	const descriptor: ToolDescriptor = {
		id: DEV_RESTORE,
		name: DEV_RESTORE,
		category: 'other',
		riskLevel: 'dangerous',
		description: 'Restore a DEV checkpoint, refusing files changed afterwards (DEV mode only)',
	};
	return {
		descriptor,
		async execute(input): Promise<ToolResult<{ restored: readonly string[]; removed: readonly string[] }>> {
			if (!deps.session.isActive()) {
				return inactive();
			}
			try {
				const checkpointId = argString(input, 'checkpointId');
				const report = await deps.checkpoints.restore(checkpointId, deps.session.root());
				return { ok: true, output: { restored: report.restored, removed: report.removed } };
			} catch (error) {
				if (error instanceof DevRestoreConflictError) {
					return viewConflict(error);
				}
				return failure(error);
			}
		},
	};
}

function viewConflict<TOutput>(error: DevRestoreConflictError): ToolResult<TOutput> {
	return {
		ok: false,
		error: `${error.message}: ${error.conflicts.map((conflict) => conflict.path).join(', ')}. ` +
			'Peça ao proprietário para confirmar a restauração antes de sobrescrever.',
	};
}

/** As ferramentas DEV, prontas para registrar. */
export function createDevTools(deps: DevToolDeps): readonly AgentTool[] {
	const tools: AgentTool[] = [
		createDevReadTool(deps),
		createDevWriteTool(deps),
		createDevEditTool(deps),
		createDevRunTool(deps),
		createDevCheckpointTool(deps),
		createDevRestoreTool(deps),
	];
	// DEV-5: o gatilho só existe com sessão **e** alvo do host. Sem alvo não
	// há como aplicar, e uma ferramenta que não aplica não deve existir para o
	// modelo.
	if (deps.apply !== undefined) {
		tools.push(createDevApplyTool(deps.apply));
	}
	return tools;
}

/**
 * As ferramentas DEV com as specs **da própria ferramenta** (DEV-5).
 *
 * `createDevTools` e `DEV_TOOL_SPECS` são duas listas paralelas, e emparelhá-las
 * por índice é o tipo de acoplamento que quebra em silêncio quando uma ganha
 * uma entrada. Aqui o par vem de `tool.descriptor.name`.
 */
export function createDevToolEntries(deps: DevToolDeps): readonly { readonly tool: AgentTool; readonly spec: ToolSpec }[] {
	return createDevTools(deps).map((tool) => {
		const spec = specFor(tool.descriptor.name);
		if (spec === undefined) {
			throw new Error(`No spec declared for DEV tool "${tool.descriptor.name}"`);
		}
		return { tool, spec };
	});
}

/** As specs por nome, construídas sob demanda (DEV_TOOL_SPECS vem abaixo). */
let specIndex: ReadonlyMap<string, ToolSpec> | undefined;
function specFor(name: string): ToolSpec | undefined {
	specIndex ??= new Map([...DEV_TOOL_SPECS, DEV_APPLY_SPEC].map((spec) => [spec.name, spec]));
	return specIndex.get(name);
}

/** As specs, no formato que o modelo recebe. */
export const DEV_TOOL_SPECS: readonly ToolSpec[] = [
	{
		name: DEV_READ,
		description: `Read a file from the Evelyn repository, up to ${DEV_READ_LIMIT_BYTES} bytes (DEV mode only)`,
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Path relative to the repository root' },
				partial: {
					type: 'boolean',
					description: 'Accept a truncated beginning of a file above the limit (the result says it is truncated)',
				},
			},
			required: ['path'],
		},
		riskLevel: 'moderate',
		category: 'filesystem',
	},
	{
		name: DEV_WRITE,
		description:
			'Write a file in the Evelyn repository. A checkpoint of the previous content is taken first (DEV mode only)',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Path relative to the repository root' },
				content: { type: 'string', description: 'The full text to write' },
			},
			required: ['path', 'content'],
		},
		riskLevel: 'dangerous',
		category: 'filesystem',
	},
	{
		name: DEV_EDIT,
		description:
			'Replace an exact piece of text in a file of the Evelyn repository, after a checkpoint. Use this instead of writing the whole file back when only part of it changes (DEV mode only)',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Path relative to the repository root' },
				oldText: {
					type: 'string',
					description:
						'The exact text to replace, copied from the file. It must appear in the file, and exactly once unless replaceAll is true.',
				},
				newText: { type: 'string', description: 'The text that takes its place' },
				replaceAll: {
					type: 'boolean',
					description: 'Replace every occurrence. Without it, an ambiguous match is refused instead of guessed.',
				},
			},
			required: ['path', 'oldText', 'newText'],
		},
		riskLevel: 'dangerous',
		category: 'filesystem',
	},
	{
		name: DEV_RUN,
		description: 'Run an allowed development command (tests, typecheck, build) in the repository (DEV mode only)',
		parameters: {
			type: 'object',
			properties: {
				command: {
					type: 'string',
					description: 'One allowed command, e.g. "npm run test:core", "npm run check-types", "npm run lint"',
				},
			},
			required: ['command'],
		},
		riskLevel: 'dangerous',
		category: 'terminal',
	},
	{
		name: DEV_CHECKPOINT,
		description: 'List the DEV checkpoints (DEV mode only)',
		parameters: { type: 'object', properties: {} },
		riskLevel: 'safe',
		category: 'other',
	},
	{
		name: DEV_RESTORE,
		description: 'Restore a DEV checkpoint. Files changed after the DEV operation are refused (DEV mode only)',
		parameters: {
			type: 'object',
			properties: { checkpointId: { type: 'string', description: 'The checkpoint id' } },
			required: ['checkpointId'],
		},
		riskLevel: 'dangerous',
		category: 'other',
	},
];

