/**
 * A trava de storage: um dono por raiz, e a posse é um arquivo.
 *
 * ## O problema que ela resolve
 *
 * A raiz guarda `state.json`, `secrets.json`, `router-config.json` e as
 * conversas, e cada host monta os seus próprios stores. Os adaptadores
 * serializam escritas **dentro de um processo**; dois processos na mesma
 * raiz não se enxergam, e um read-modify-write concorrente perde a escrita
 * do outro. O `FileDataStore` já diz isso no próprio cabeçalho.
 *
 * ## Por que não é "olhar e depois abrir"
 *
 * Uma verificação do tipo "existe um arquivo de trava? então desista, senão
 * crie" tem uma janela entre a verificação e a criação: dois processos
 * podem ambos ver "não existe" e ambos criar. Quem escrever por último
 * ganha, e os dois acreditam ser donos.
 *
 * Aqui não há janela: o arquivo é aberto com `wx`, que **falha** quando ele
 * já existe. Quem consegue abrir é o dono; quem falha sabe que há outro. É
 * o sistema de arquivos fazendo a exclusão mútua, não uma linha de
 * JavaScript.
 *
 * ## Por que um arquivo *aberto* e não só um arquivo existente
 *
 * O Windows mantém um arquivo aberto indisponível para remoção por outro
 * processo. Quem segura o handle é o dono; ao morrer (mesmo de forma
 * abrupta), o handle fecha, o Windows pode apagar o arquivo, e a próxima
 * abertura o recria. Já um arquivo *fechado* que ficou para trás é lido e
 * tratado como possivelmente velho — nunca como prova de um dono vivo.
 *
 * ## O que ela NÃO faz
 *
 * Não impede o dono de editar os arquivos à mão, e não é um mecanismo de
 * segurança contra alguém com acesso ao diretório: é coordenação entre
 * processos do app.
 */
import { mkdir, open, readFile, rm, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

/** O nome do arquivo de trava, na raiz dos dados. */
export const STORAGE_LOCK_FILE = 'storage.lock';

/**
 * Quanto tempo um dono pode ficar sem renovar antes de outro processo
 * considerá-lo morto.
 *
 * Quem garante hoje é o handle aberto: o Windows não deixa outro processo
 * apagar um arquivo aberto, e o do dono fecha sozinho quando o processo
 * morre. Esta constante existe para um host futuro em que a posse dependa
 * de um batimento (o serviço web que fica no ar por dias), e não para o
 * desktop, cuja janela é o próprio sinal de vida.
 */
export const DEFAULT_STALE_AFTER_MS = 30_000;

/** O conteúdo da trava: quem é o dono, para a mensagem de recusa. */
export interface StorageLockOwner {
	/** O que o dono é: `desktop`, `web`, ou o nome que o host escolher. */
	readonly host: string;
	/** O processo dono. */
	readonly pid: number;
	/** Quando o dono começou (ISO), para a mensagem de recusa. */
	readonly since: string;
}

/** O resultado de tentar tomar a raiz. */
export type StorageLockResult =
	| { readonly kind: 'acquired'; readonly lock: StorageLock }
	/** Alguém tem a raiz. */
	| { readonly kind: 'busy'; readonly owner: StorageLockOwner | undefined }
	/** Não foi possível falar com o sistema de arquivos. */
	| { readonly kind: 'failed'; readonly message: string };

/** A raiz, enquanto este processo for o dono. */
export interface StorageLock {
	/** Fecha o handle e apaga o arquivo. Idempotente. */
	release(): Promise<void>;
}

/**
 * The raw `NodeJS.ErrnoException` code, when there is one.
 *
 * Read through a narrow instead of an `any`: the error path is where a
 * mistyped code would silently turn "busy" into "failed".
 */
function errorCode(error: unknown): unknown {
	if (typeof error !== 'object' || error === null) {
		return undefined;
	}
	return (error as { readonly code?: unknown }).code;
}

/**
 * O sistema de arquivos ainda mantém um handle aberto na trava?
 *
 * A pergunta certa é "quem é dono está vivo?", e o sistema de arquivos não a
 * responde sozinho: o Node no Windows abre arquivos com compartilhamento de
 * escrita, e um `open` de leitura num arquivo com handle aberto funciona.
 *
 * A resposta vem do **dono**, em duas partes:
 *
 * 1. o processo dono existe? (`kill(pid, 0)`). Morto, não há handle para
 *    segurar nada — o Windows fechou o arquivo junto com o processo;
 * 2. e ele é **este** app? Um pid pode ter sido reaproveitado por outro
 *    programa, e entregar a raiz a um estranho só porque o número bate é
 *    pior do que recusar. A verificação é externa e opcional
 *    (`options.isOwnerAlive`), porque testá-la exige iniciar processos.
 *
 * Na dúvida — impossível verificar — a resposta é "vivo", que é a recusa.
 */
async function isHeldOpen(
	lockPath: string,
	owner: StorageLockOwner | undefined,
	options: { readonly isOwnerAlive?: (pid: number) => Promise<boolean> },
): Promise<boolean> {
	if (owner === undefined) {
		// Sem identificação, não há como dizer que o dono morreu.
		return true;
	}
	const checker = options.isOwnerAlive ?? isProcessAlive;
	try {
		return await checker(owner.pid);
	} catch {
		return true;
	}
}

/** O processo com este pid existe? */
async function isProcessAlive(pid: number): Promise<boolean> {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return errorCode(error) === 'EPERM';
	}
}

/**
 * Toma a raiz de uma trava que ficou para trás.
 *
 * O `rm` é o passo decisivo e é atômico: se dois processos perdidos
 * tentarem recuperar ao mesmo tempo, **um** consegue apagar e o outro falha
 * — e o que falhou cai no caminho normal de "está ocupado". Depois, o `wx`
 * do chamador decide quem monta.
 */
async function recoverStaleLock(
	lockPath: string,
	host: string,
	options: { readonly now?: () => Date },
): Promise<StorageLockResult | undefined> {
	try {
		await rm(lockPath, { force: false });
	} catch {
		// Outro processo chegou primeiro: a raiz é dele agora.
		return undefined;
	}
	// O arquivo sumiu; o `wx` do chamador dirá quem consegue criá-lo.
	// Recriamos aqui mesmo, para não devolver controle a quem não pediu.
	let handle: FileHandle;
	try {
		handle = await open(lockPath, 'wx');
	} catch {
		return undefined;
	}
	return finishAcquisition(handle, lockPath, host, options);
}

/**
 * Depois de o handle existir: escreve o dono e devolve o lock.
 *
 * Separado para que os dois caminhos — o primeiro `wx` e a recuperação de
 * uma trava órfã — terminem exatamente da mesma forma.
 */
async function finishAcquisition(
	handle: FileHandle,
	lockPath: string,
	host: string,
	options: { readonly now?: () => Date },
): Promise<StorageLockResult> {
	const owner: StorageLockOwner = {
		host,
		pid: process.pid,
		since: (options.now ?? (() => new Date()))().toISOString(),
	};
	// A posse é o handle aberto; o conteúdo é só a identificação do dono.
	try {
		await handle.writeFile(`${JSON.stringify(owner, null, 2)}\n`, 'utf8');
	} catch (error) {
		await handle.close().catch(() => undefined);
		await rm(lockPath, { force: true }).catch(() => undefined);
		return {
			kind: 'failed',
			message: error instanceof Error ? error.message : String(error),
		};
	}

	let released = false;
	return {
		kind: 'acquired',
		lock: {
			async release(): Promise<void> {
				if (released) {
					return;
				}
				released = true;
				await handle.close().catch(() => undefined);
				await rm(lockPath, { force: true }).catch(() => undefined);
			},
		},
	};
}

/** Lê o dono gravado na trava, quando há um. */
async function readOwner(lockPath: string): Promise<StorageLockOwner | undefined> {
	try {
		const raw = await readFile(lockPath, 'utf8');
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== 'object' || parsed === null) {
			return undefined;
		}
		const candidate = parsed as Record<string, unknown>;
		if (
			typeof candidate['host'] !== 'string' ||
			typeof candidate['pid'] !== 'number' ||
			typeof candidate['since'] !== 'string'
		) {
			return undefined;
		}
		return {
			host: candidate['host'],
			pid: candidate['pid'],
			since: candidate['since'],
		};
	} catch {
		// Sem arquivo, ou com um arquivo ilegível: os dois são "não sei quem
		// é o dono", e a recusa continua sendo a resposta certa — quem não
		// consegue abrir com `wx` também não pode escrever.
		return undefined;
	}
}

/**
 * Takes the root, or reports who has it.
 *
 * The file is created with `wx`: the first process to succeed owns the root,
 * and every other one fails, with no window in between. The handle stays
 * open for as long as the lock lives, which is what makes the ownership
 * visible to the OS rather than just to the file's contents.
 */
export async function acquireStorageLock(
	rootPath: string,
	host: string,
	options: {
		readonly now?: () => Date;
		/**
		 * Verifica se o pid do dono ainda é o dono — por padrão, "o processo
		 * existe". Um teste injeta a resposta; o host usa o padrão.
		 */
		readonly isOwnerAlive?: (pid: number) => Promise<boolean>;
	} = {},
): Promise<StorageLockResult> {
	const lockPath = join(rootPath, STORAGE_LOCK_FILE);
	let handle: FileHandle;
	try {
		// A raiz pode ainda nao existir: numa instalacao nova ela e criada
		// pela primeira escrita, e a trava e a primeira coisa que escreve.
		await mkdir(rootPath, { recursive: true });
		handle = await open(lockPath, 'wx');
	} catch (error) {
		if (errorCode(error) !== 'EEXIST') {
			return {
				kind: 'failed',
				message: error instanceof Error ? error.message : String(error),
			};
		}
		// Alguem *pode* ter a raiz. Lemos quem, so para a mensagem.
		const existingOwner = await readOwner(lockPath);
		// E perguntamos ao sistema de arquivos se o arquivo ainda esta aberto.
		// Se ninguem o tem aberto, a trava e orfa: um processo encerrado a
		// forca nao roda o `release`, e sem esta recuperacao um `kill -9`
		// trancaria a raiz para sempre.
		if (!(await isHeldOpen(lockPath, existingOwner, options))) {
			const recovered = await recoverStaleLock(lockPath, host, options);
			if (recovered !== undefined) {
				return recovered;
			}
		}
		return { kind: 'busy', owner: existingOwner };
	}

	return finishAcquisition(handle, lockPath, host, options);
}
