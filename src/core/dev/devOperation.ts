/**
 * A operação DEV em andamento, persistida fora do repositório (DEV-3).
 *
 * ## Por que persistir
 *
 * Uma mudança que exige recarregar a interface ou reiniciar a aplicação
 * atravessa um ponto em que **o processo que começou a operação deixa de
 * existir**. Sem um registro em disco, o app volta sem saber que havia uma
 * mudança pela metade: o diretório fica com código alterado, o checkpoint
 * existe e ninguém sabe qual era o plano.
 *
 * ## Por que fora do repositório
 *
 * O diretório de dados (`~/.modelhub/seshyina`) fica **fora** da raiz que o
 * modo DEV pode escrever. Um registro dentro do repositório seria alcançável
 * por `dev_write` — o agente poderia reescrever o próprio relato da operação,
 * dizer que passou numa verificação que não rodou e apagar a evidência de uma
 * falha. Fora dele, o registro é do host, como o checkpoint.
 *
 * ## O que ele guarda, e o que não
 *
 * Guarda a conversa, a etapa, a estratégia, os arquivos e o id do checkpoint.
 * **Não** guarda conteúdo de arquivo, mensagem do usuário nem credencial: o
 * registro é diagnóstico e de retomada, não uma cópia da conversa.
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ApplyStrategy } from './applyPolicy';

/** O nome do arquivo, dentro do diretório de DEV. */
export const DEV_OPERATION_FILE = 'operation.json';

/** As etapas de uma mudança. */
export type ApplyStage =
	/** Identificou os arquivos e classificou a mudança. */
	| 'planned'
	/** Checkpoint criado; pode escrever. */
	| 'checkpointed'
	/** Escreveu os arquivos. */
	| 'written'
	/** Rodou as verificações e elas passaram. */
	| 'verified'
	/** Verificações falharam. */
	| 'verification-failed'
	/** Aplicou (recarregou/reiniciou) e está conferindo. */
	| 'applying'
	/** A aplicação falhou e o checkpoint foi restaurado. */
	| 'rolled-back'
	/** Concluída. */
	| 'done';

/** O estado da operação. */
export interface DevOperation {
	readonly version: 1;
	/** A conversa em que a mudança foi pedida — a que precisa reabrir. */
	readonly conversationId?: string;
	/**
	 * Um valor opaco por operação (DEV-5).
	 *
	 * Serve para reconhecer **a mesma** operação mesmo que só uma parte dela
	 * tenha sobrevivido: o id de uma nova tentativa nunca coincide com o de
	 * outra. Não é credencial — é aleatório e não abre nada; quem o lê ainda
	 * precisa de sessão DEV. Não é escolhido pelo modelo.
	 */
	readonly nonce?: string;
	readonly stage: ApplyStage;
	readonly strategy: ApplyStrategy;
	/** Os arquivos tocados, relativos à raiz do repositório. */
	readonly files: readonly string[];
	/** O checkpoint que tem o estado anterior. */
	readonly checkpointId?: string;
	/** O que já foi verificado, para não repetir nem inventar. */
	readonly checks: readonly string[];
	/** Os resultados, em texto de classe (sem conteúdo de arquivo). */
	readonly results: readonly string[];
	readonly startedAt: string;
	readonly updatedAt: string;
}

/** As etapas que já passaram de um ponto — para saber se é preciso retomar. */
const ORDER: readonly ApplyStage[] = [
	'planned',
	'checkpointed',
	'written',
	'verified',
	'applying',
	'done',
];

export function stageIndex(stage: ApplyStage): number {
	const index = ORDER.indexOf(stage);
	return index < 0 ? -1 : index;
}

/** A operação ficou a meio caminho? */
export function isUnfinished(operation: DevOperation | undefined): boolean {
	if (operation === undefined) {
		return false;
	}
	return operation.stage !== 'done' && operation.stage !== 'rolled-back';
}

/**
 * O registro.
 *
 * Gravação atômica (arquivo temporário + `rename`), como os outros stores do
 * projeto: um app que morre no meio de uma escrita não pode deixar um JSON
 * pela metade que impeça a leitura do anterior.
 */
export class DevOperationStore {
	constructor(private readonly baseDir: string) {}

	private get path(): string {
		return join(this.baseDir, DEV_OPERATION_FILE);
	}

	/** O que está registrado, se houver e for legível. */
	async read(): Promise<DevOperation | undefined> {
		const raw = await readFile(this.path, 'utf8').catch(() => undefined);
		if (raw === undefined) {
			return undefined;
		}
		try {
			const parsed = JSON.parse(raw) as Partial<DevOperation>;
			if (parsed.version !== 1 || typeof parsed.stage !== 'string' || typeof parsed.strategy !== 'string') {
				return undefined;
			}
			return {
				version: 1,
				...(typeof parsed.conversationId === 'string' ? { conversationId: parsed.conversationId } : {}),
				...(typeof parsed.nonce === 'string' && parsed.nonce.length > 0 ? { nonce: parsed.nonce } : {}),
				stage: parsed.stage as ApplyStage,
				strategy: parsed.strategy as ApplyStrategy,
				files: Array.isArray(parsed.files) ? parsed.files.filter((file): file is string => typeof file === 'string') : [],
				...(typeof parsed.checkpointId === 'string' ? { checkpointId: parsed.checkpointId } : {}),
				checks: Array.isArray(parsed.checks) ? parsed.checks.filter((check): check is string => typeof check === 'string') : [],
				results: Array.isArray(parsed.results) ? parsed.results.filter((result): result is string => typeof result === 'string') : [],
				startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : new Date().toISOString(),
				updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
			};
		} catch {
			// Um registro ilegível não pode impedir o app de abrir; ele é
			// simplesmente "não há operação conhecida" — e a conversa é
			// restaurada do seu próprio arquivo.
			return undefined;
		}
	}

	/** Substitui o registro, atomicamente. */
	async write(operation: DevOperation): Promise<void> {
		await mkdir(this.baseDir, { recursive: true });
		const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
		await writeFile(temporary, `${JSON.stringify(operation, null, 2)}\n`, 'utf8');
		await rename(temporary, this.path);
	}

	/** Apaga o registro (operação concluída e relatada). */
	async clear(): Promise<void> {
		await unlink(this.path).catch(() => undefined);
	}
}

/** Começa uma operação. */
export function startOperation(input: {
	readonly conversationId?: string;
	readonly strategy: ApplyStrategy;
	readonly files: readonly string[];
	readonly now?: () => Date;
}): DevOperation {
	const at = (input.now ?? (() => new Date()))().toISOString();
	return {
		version: 1,
		...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
		stage: 'planned',
		strategy: input.strategy,
		files: [...input.files],
		checks: [],
		results: [],
		startedAt: at,
		updatedAt: at,
	};
}

/** Avança a etapa, preservando o resto. */
export function advance(
	operation: DevOperation,
	stage: ApplyStage,
	patch: {
		readonly checkpointId?: string;
		readonly check?: string;
		readonly result?: string;
		readonly now?: () => Date;
	} = {},
): DevOperation {
	return {
		...operation,
		stage,
		...(patch.checkpointId !== undefined ? { checkpointId: patch.checkpointId } : {}),
		checks: patch.check === undefined ? operation.checks : [...operation.checks, patch.check],
		results: patch.result === undefined ? operation.results : [...operation.results, patch.result],
		updatedAt: (patch.now ?? (() => new Date()))().toISOString(),
	};
}
