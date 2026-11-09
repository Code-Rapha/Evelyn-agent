/**
 * Os checkpoints do modo DEV (DEV-2).
 *
 * ## O que um checkpoint preserva
 *
 * O conteúdo **anterior** de cada arquivo que o DEV vai escrever — inclusive
 * quando o arquivo é novo (guarda-se "não existia") e quando já estava
 * modificado ou não rastreado antes da sessão. O objetivo é poder voltar ao
 * antes **sem** tocar em nada que o DEV não tenha escrito.
 *
 * ## Por que não Git
 *
 * `git checkout`, `reset --hard` e `clean` apagam trabalho não commitado — e
 * este repositório tem centenas de arquivos não rastreados que o usuário não
 * quer perder. Um stash também reorganiza o índice. Por isso o checkpoint é
 * um diretório próprio, com os bytes originais e um índice JSON. Nada de
 * Git é necessário para restaurar, e nenhum comando destrutivo é usado.
 *
 * ## Conflito
 *
 * Na restauração, o arquivo só é reescrito se o conteúdo atual for **o mesmo
 * que o DEV deixou**. Se alguém (o usuário, outra ferramenta, o próprio DEV
 * numa operação posterior) mexeu depois, o checkpoint não sobrescreve: ele
 * reporta o conflito. Sem isso, restaurar um checkpoint antigo apagaria
 * trabalho posterior sem avisar.
 */

import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';

/** O estado anterior de um arquivo. */
interface FileEntry {
	/** Caminho relativo à raiz, com `/`. */
	readonly path: string;
	/** `false` quando o arquivo não existia antes do DEV. */
	readonly existed: boolean;
	/** Hash do conteúdo anterior; ausente quando não existia. */
	readonly beforeHash?: string;
	/** Hash do conteúdo **depois** da escrita do DEV — o que a restauração exige ver. */
	afterHash?: string;
	/** Quando o arquivo foi capturado (ISO). */
	readonly capturedAt: string;
	/** O que a operação foi (para o relatório). */
	readonly operation: string;
}

/** Um checkpoint: onde vivem os bytes e o que ele cobre. */
interface CheckpointEntry {
	readonly id: string;
	readonly createdAt: string;
	readonly files: FileEntry[];
}

export interface CheckpointSummary {
	readonly id: string;
	readonly createdAt: string;
	readonly files: readonly string[];
}

/** O resultado de uma restauração. */
export interface RestoreReport {
	readonly restored: readonly string[];
	readonly removed: readonly string[];
	readonly conflicts: readonly { readonly path: string; readonly reason: string }[];
}

/** Uma restauração que precisa de confirmação explícita. */
export class DevRestoreConflictError extends Error {
	readonly code = 'dev_restore_conflict';
	constructor(
		message: string,
		readonly conflicts: RestoreReport['conflicts'],
	) {
		super(message);
		this.name = 'DevRestoreConflictError';
	}
}

/** O checkpoint cobre e substitui o conteúdo de um arquivo. */
interface CaptureInput {
	readonly root: string;
	readonly path: string;
	readonly operation: string;
}

/**
 * Os checkpoints de uma sessão.
 *
 * Vive em disco (dentro da raiz de dados do host, **fora** do repositório)
 * para sobreviver a um reinício do app: um checkpoint de código que some
 * quando o app fecha não serve para desfazer uma mudança ruim.
 *
 * O índice é um arquivo por checkpoint, gravado atomicamente; os bytes
 * originais ficam em `objects/<hash>` (deduplicados por conteúdo).
 */
export class DevCheckpointStore {
	private readonly index = new Map<string, CheckpointEntry>();

	constructor(private readonly baseDir: string) {}

	/** Prepara o diretório; idempotente. */
	async init(): Promise<void> {
		await mkdir(join(this.baseDir, 'objects'), { recursive: true });
		await mkdir(join(this.baseDir, 'checkpoints'), { recursive: true });
		// DEV-6: o índice em disco é a fonte entre processos. Sem carregá-lo,
		// um app reiniciado via `list()` vazio e "restaurava" nada — parecia
		// que não havia checkpoint. Carregar aqui mantém os dois usos coerentes.
		await this.load();
	}

	/**
	 * Captura o estado anterior de um arquivo **antes** da escrita.
	 *
	 * Não grava o arquivo: só guarda os bytes. Quem chama decide se a escrita
	 * pode prosseguir. Devolve o id do checkpoint criado.
	 */
	async capture(input: CaptureInput): Promise<string> {
		await this.init();
		const absolute = resolve(input.root, input.path);
		assertInside(input.root, absolute);
		const id = `ck-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
		const createdAt = new Date().toISOString();

		const current = await readFile(absolute).catch(() => undefined);
		const entry: FileEntry = {
			path: toPosix(relative(input.root, absolute)),
			existed: current !== undefined,
			...(current !== undefined ? { beforeHash: await this.storeObject(current) } : {}),
			capturedAt: createdAt,
			operation: input.operation,
		};
		const checkpoint: CheckpointEntry = { id, createdAt, files: [entry] };
		this.index.set(id, checkpoint);
		await this.writeIndex(checkpoint);
		return id;
	}

	/**
	 * Marca o conteúdo que a escrita do DEV deixou.
	 *
	 * Chamado **depois** de a escrita (atômica) dar certo. É o que permite à
	 * restauração distinguir "está como o DEV deixou" de "alguém mexeu depois".
	 */
	async seal(checkpointId: string, root: string, path: string): Promise<void> {
		const checkpoint = this.index.get(checkpointId);
		if (checkpoint === undefined) {
			return;
		}
		const absolute = resolve(root, path);
		assertInside(root, absolute);
		const current = await readFile(absolute).catch(() => undefined);
		const entry = checkpoint.files.find((file) => file.path === toPosix(relative(root, absolute)));
		if (entry === undefined) {
			return;
		}
		entry.afterHash = current === undefined ? undefined : await this.hash(current);
		this.index.set(checkpointId, checkpoint);
		await this.writeIndex(checkpoint);
	}

	/** Os checkpoints existentes, do mais recente para o mais antigo. */
	async list(): Promise<readonly CheckpointSummary[]> {
		return [...this.index.values()]
			.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
			.map((entry) => ({
				id: entry.id,
				createdAt: entry.createdAt,
				files: entry.files.map((file) => file.path),
			}));
	}

	/**
	 * O selo de um arquivo (DEV-6): o que o DEV deixou, para saber se o disco
	 * ainda é isso.
	 *
	 * Leitura pura — não toca em arquivo. Devolve `sealed: false` quando a
	 * captura não foi selada (a escrita não chegou a acontecer) e
	 * `afterHash: undefined` quando, depois da operação, o arquivo não existia.
	 */
	sealOf(
		checkpointId: string,
		rootOrPath: string,
		path?: string,
	): { readonly sealed: true; readonly afterHash?: string } | { readonly sealed: false } {
		const checkpoint = this.index.get(checkpointId);
		// Com `path`, o primeiro argumento é a raiz e o caminho é absoluto ou
		// relativo a ela; sem, o caminho já é o relativo do checkpoint.
		const stored =
			path === undefined
				? rootOrPath.replace(/\\/g, '/')
				: relative(rootOrPath, resolve(rootOrPath, path)).replace(/\\/g, '/');
		const entry = checkpoint?.files.find((file) => file.path === stored);
		if (entry === undefined || entry.afterHash === undefined) {
			return { sealed: false };
		}
		return { sealed: true, afterHash: entry.afterHash };
	}

	/**
	 * Restaura um checkpoint.
	 *
	 * Só toca nos arquivos **daquele** checkpoint, e só quando o conteúdo atual
	 * é o que o DEV deixou. Conflitos não são resolvidos silenciosamente: sem
	 * `force`, eles são reportados e nada é escrito nos arquivos em conflito.
	 */
	async restore(checkpointId: string, root: string, options: { readonly force?: boolean } = {}): Promise<RestoreReport> {
		const checkpoint = this.index.get(checkpointId);
		if (checkpoint === undefined) {
			throw new Error(`não há checkpoint "${checkpointId}"`);
		}
		const restored: string[] = [];
		const removed: string[] = [];
		const conflicts: { path: string; reason: string }[] = [];

		for (const entry of checkpoint.files) {
			const absolute = resolve(root, entry.path);
			assertInside(root, absolute);
			const current = await readFile(absolute).catch(() => undefined);
			const currentHash = current === undefined ? undefined : await this.hash(current);
			const unchangedSinceDev = currentHash === entry.afterHash;
			if (!unchangedSinceDev && options.force !== true) {
				conflicts.push({
					path: entry.path,
					reason:
						entry.afterHash === undefined
							? 'o arquivo não existia depois da operação do DEV; agora existe'
							: 'o arquivo mudou depois da operação do DEV',
				});
				continue;
			}
			if (!entry.existed) {
				// O DEV criou o arquivo: restaurar é removê-lo.
				await rm(absolute, { force: true });
				removed.push(entry.path);
				continue;
			}
			const original = await this.loadObject(entry.beforeHash as string);
			await mkdir(dirname(absolute), { recursive: true });
			await writeFile(absolute, original);
			restored.push(entry.path);
		}

		if (conflicts.length > 0 && options.force !== true) {
			throw new DevRestoreConflictError(
				`${conflicts.length} arquivo(s) mudaram depois da operação do DEV; nada foi sobrescrito`,
				conflicts,
			);
		}
		return { restored, removed, conflicts };
	}

	/**
	 * Desfaz **todas** as capturas de uma operação, na ordem inversa.
	 *
	 * A DEV-3 cria um checkpoint por arquivo escrito. Desfazer uma alteração
	 * é restaurar todos eles; a ordem inversa importa quando dois arquivos
	 * dependem um do outro (um índice e o módulo que ele exporta).
	 *
	 * Um checkpoint sem selo (`afterHash` ausente) é o de uma escrita que não
	 * chegou a acontecer: restaurar é seguro e devolve o conteúdo anterior.
	 */
	async restoreAll(root: string, operation: string, options: { readonly force?: boolean } = {}): Promise<RestoreReport> {
		const entries = [...this.index.values()]
			.filter((checkpoint) => checkpoint.files.some((file) => file.operation === operation))
			.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
		const combined = {
			restored: [] as string[],
			removed: [] as string[],
			conflicts: [] as { readonly path: string; readonly reason: string }[],
		};
		for (const checkpoint of entries) {
			const report = await this.restore(checkpoint.id, root, options);
			combined.restored.push(...report.restored);
			combined.removed.push(...report.removed);
			combined.conflicts.push(...report.conflicts);
		}
		return combined;
	}

	/** Lê o índice que não estava em memória (depois de reiniciar). */
	async load(): Promise<void> {
		const { readdir } = await import('node:fs/promises');
		const files = await readdir(join(this.baseDir, 'checkpoints')).catch(() => [] as string[]);
		for (const file of files) {
			if (!file.endsWith('.json')) {
				continue;
			}
			const raw = await readFile(join(this.baseDir, 'checkpoints', file), 'utf8').catch(() => undefined);
			if (raw === undefined) {
				continue;
			}
			try {
				const parsed = JSON.parse(raw) as CheckpointEntry;
				this.index.set(parsed.id, parsed);
			} catch {
				// Índice ilegível não impede os outros.
			}
		}
	}

	private async writeIndex(checkpoint: CheckpointEntry): Promise<void> {
		await mkdir(join(this.baseDir, 'checkpoints'), { recursive: true });
		await writeFile(
			join(this.baseDir, 'checkpoints', `${checkpoint.id}.json`),
			`${JSON.stringify(checkpoint, null, 2)}\n`,
			'utf8',
		);
	}

	/** Guarda os bytes por hash; devolve o hash. */
	private async storeObject(contents: Buffer): Promise<string> {
		const hash = await this.hash(contents);
		const path = join(this.baseDir, 'objects', hash);
		const exists = await stat(path).catch(() => undefined);
		if (exists === undefined) {
			await writeFile(path, contents);
		}
		return hash;
	}

	private async loadObject(hash: string): Promise<Buffer> {
		return await readFile(join(this.baseDir, 'objects', hash));
	}

	private async hash(contents: Buffer): Promise<string> {
		const { createHash } = await import('node:crypto');
		return createHash('sha256').update(contents).digest('hex');
	}
}

/** O caminho resolvido está dentro da raiz? */
function assertInside(root: string, candidate: string): void {
	const base = resolve(root);
	const target = resolve(candidate);
	if (target !== base && !target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)) {
		throw new Error(`o caminho "${candidate}" está fora do repositório autorizado`);
	}
}

function toPosix(path: string): string {
	return path.split(sep).join('/');
}
