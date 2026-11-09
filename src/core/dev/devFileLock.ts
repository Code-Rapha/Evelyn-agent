/**
 * A trava compartilhada entre processos (DEV-2.2).
 *
 * ## O que a DEV-2.1 deixou em aberto
 *
 * A trava da DEV-2.1 vive num `Set` do processo: `run_command`, `dev_write` e
 * `dev_run` se respeitavam **dentro** do app. Mas o serviço local é outro
 * processo, com a mesma raiz quando aponta para o repositório, e ele também
 * executa `run_command`. Dois processos, duas travas independentes: nenhuma
 * coordenação real.
 *
 * ## O mecanismo
 *
 * Um arquivo de trava **aberto** na raiz do repositório, criado com
 * `open(path, 'wx')` — a mesma primitiva que `storageLock.ts` já usa:
 *
 * - `wx` falha quando o arquivo existe: **dois processos não conseguem criá-lo
 *   ao mesmo tempo**, e quem falhou sabe que há outro. Não há janela entre
 *   "verificar" e "criar".
 * - O arquivo fica **aberto** enquanto a operação roda. Ao fechar, o handle
 *   vai embora junto com o processo — um `kill -9` não deixa trava eterna.
 * - O conteúdo é a **identidade do dono**: pid, instante de criação do
 *   processo e raiz canônica. É o que permite distinguir "dono vivo" de "PID
 *   reciclado" e "trava órfã" de "trava de outro alguém".
 *
 * ## Onde o arquivo mora
 *
 * Dentro da raiz canônica, em `.evelyn-dev.lock`. Ele é um arquivo oculto no
 * repositório: aparece em `git status` como não rastreado. A alternativa —
 * um diretório temporário por hash da raiz — quebra quando a raiz é montada
 * em caminhos diferentes (drive mapeado, UNC, symlink); o arquivo **na raiz**
 * não tem esse problema porque a raiz é o recurso.
 *
 * ## Recuperação de órfã
 *
 * Uma trava é abandonada quando o processo dono não existe mais **ou** quando
 * o PID existe mas o instante de criação é outro (PID reciclado). Nesse caso o
 * arquivo pode ser removido — a remoção é atômica, então dois recuperadores
 * concorrentes não a removem duas vezes, e só um recria com `wx`.
 *
 * **A dúvida não autoriza remover.** Se não for possível provar que o dono
 * morreu (leitura de identidade indisponível, `EPERM`), a trava é mantida e o
 * erro é "ocupado, recuperável" — nunca uma remoção às cegas.
 */

import { mkdir, open, readFile, rm, stat, writeFile, type FileHandle } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';

import { processStartedAtMs } from './processStart';

/** O nome do arquivo de trava, na raiz do repositório. */
export const DEV_LOCK_FILE = '.evelyn-dev.lock';

/**
 * Quanto o instante de criação pode variar e ainda ser o mesmo processo.
 *
 * A fonte (`GetProcessTimes` no Windows, `/proc/<pid>` no Linux) devolve o
 * instante com arredondamento de relógio — alguns milissegundos. Valores
 * acima disto são **divergência**, e divergência mantém a trava: nunca se
 * remove uma trava por suspeita, só por evidência.
 */
export const IDENTITY_TOLERANCE_MS = 250;

/** O que a trava grava: quem é o dono, para a recuperação e a mensagem. */
interface LockOwner {
	readonly version: 1;
	readonly pid: number;
	readonly startedAtMs?: number;
	/** A raiz canônica, em minúsculas (Windows não distingue caixa). */
	readonly root: string;
	readonly acquiredAt: string;
	/**
	 * Um valor opaco desta aquisição (DEV-6).
	 *
	 * Não é credencial: só serve para o **host** reconhecer a sua própria trava
	 * depois de reiniciar, e reaproveitá-la em vez de apagar a de um processo
	 * vivo. É aleatório e não abre nada — quem o lê ainda passa pelas
	 * verificações de pid.
	 */
	readonly token?: string;
}

/**
 * O que a trava em disco diz sobre uma raiz, **sem** adquiri-la (diagnóstico).
 *
 * Nunca concede nada: quem decide é `acquireDevLock`.
 */
export async function readDevLockInfo(
	root: string,
): Promise<{ readonly kind: 'free' } | { readonly kind: 'held'; readonly pid?: number; readonly acquiredAt?: string }> {
	const owner = await readLockOwnerFile(root);
	return owner.kind === 'free'
		? { kind: 'free' }
		: {
				kind: 'held',
				...(owner.pid !== undefined ? { pid: owner.pid } : {}),
				...(owner.acquiredAt !== undefined ? { acquiredAt: owner.acquiredAt } : {}),
			};
}

/** Como uma aquisição terminou. */
export type DevLockResult =
	| { readonly kind: 'acquired'; readonly lock: DevFileLock }
	| {
			readonly kind: 'busy';
			readonly owner?: { readonly pid: number; readonly acquiredAt: string };
			/**
			 * `true` quando é possível tentar de novo depois: o dono morreu, ou
			 * não foi possível provar que está vivo. Nunca é `false` para dizer
			 * "pode apagar" — remover é decisão de quem chama `recover`.
			 */
			readonly recoverable: boolean;
			readonly reason: string;
	  }
	| { readonly kind: 'failed'; readonly message: string };

/** A trava, enquanto este processo for o dono. */
export interface DevFileLock {
	/** Fecha o handle e apaga o arquivo. Idempotente. */
	release(): Promise<void>;
	/**
	 * Fecha o handle **sem** apagar o arquivo.
	 *
	 * Só para simular um processo morto num teste: é o estado que o SO deixa.
	 * Código de produção nunca chama isto — um handle fechado com o arquivo no
	 * lugar seria uma trava que ninguém solta.
	 */
	releaseHandle(): Promise<void>;
	/** A identidade gravada, para o log. */
	readonly owner: LockOwner;
}

export interface DevLockOptions {
	/** Quanto tempo se espera por uma trava ocupada. */
	readonly waitMs?: number;
	/** Intervalo entre tentativas. Nunca 0: busy-wait em arquivo é ruído. */
	readonly retryMs?: number;
	/** Relógio, injetável. */
	readonly now?: () => Date;
	/** Leitor do instante de criação do processo, injetável em teste. */
	readonly startedAt?: (pid: number) => Promise<number | undefined>;
	/**
	 * Um valor opaco gravado na trava (DEV-6).
	 *
	 * Só o host usa: depois de reiniciar, ele reconhece a própria trava pelo
	 * token e a reaproveita em vez de derrubar a de um processo vivo. Não é
	 * credencial e não é verificada por ninguém além do host.
	 */
	readonly token?: string;
}

/**
 * A trava desta raiz pertence a este processo **e** traz este token?
 *
 * É o teste do host depois de reiniciar: a mesma instância pode ter deixado o
 * arquivo ao sair sem soltar. Só o pid deste processo aceita a posse — token
 * de outra máquina/processo nunca.
 */
export async function isOwnDevLock(root: string, token: string): Promise<boolean> {
	try {
		const raw = await readFile(join(await canonicalRoot(root), DEV_LOCK_FILE), 'utf8');
		const parsed = JSON.parse(raw) as Partial<LockOwner>;
		return parsed.pid === process.pid && parsed.token === token;
	} catch {
		return false;
	}
}

/**
 * A raiz do repositório que contém `from`, ou `undefined`.
 *
 * ## Por que não é o workspace
 *
 * `write_file` opera no workspace do **projeto da conversa**, que pode ser
 * uma subpasta de um repositório. A trava da DEV-2.2 é por raiz de
 * repositório: se o workspace é `repo\src` e o DEV trava `repo`, a chave tem
 * de ser `repo` nos dois — senão são duas travas para o mesmo recurso.
 *
 * Sobe a partir do caminho até achar `.git`. `undefined` é resposta legítima:
 * um workspace fora de repositório Git continua funcionando sem trava (não há
 * outro processo a coordenar por raiz de repositório).
 */
export async function repositoryRootOf(from: string): Promise<string | undefined> {
	let current = resolve(from);
	for (let depth = 0; depth < 64; depth += 1) {
		const marker = await stat(join(current, '.git')).catch(() => undefined);
		if (marker !== undefined) {
			return await canonicalRoot(current);
		}
		const parent = resolve(current, '..');
		if (parent === current) {
			return undefined;
		}
		current = parent;
	}
	return undefined;
}

/** A recusa quando o tempo de espera acaba. */
export class DevLockTimeoutError extends Error {
	readonly code = 'dev_lock_timeout';
	constructor(
		message: string,
		readonly owner: { readonly pid: number; readonly acquiredAt: string } | undefined,
	) {
		super(message);
		this.name = 'DevLockTimeoutError';
	}
}

/**
 * Normaliza a raiz: `realpath` quando disponível, depois minúsculas.
 *
 * `realpath` já resolve symlink, `..` e caixa no Windows; o `toLowerCase`
 * cobre o caso de dois caminhos que o sistema considera iguais mas a string
 * não (Linux é sensível a caixa e não passa por aqui — lá o `realpath` já é a
 * resposta, e minúsculas ali seriam erradas).
 */
export async function canonicalRoot(root: string): Promise<string> {
	const { realpath } = await import('node:fs/promises');
	const real = await realpath(resolve(root)).catch(() => resolve(root));
	return process.platform === 'win32' ? real.toLowerCase() : real;
}

/**
 * Pega a trava da raiz, esperando até `waitMs`.
 *
 * A aquisição é atômica (`wx`). A espera é **intervalada**, não ocupada:
 * dorme `retryMs` entre tentativas e desiste no prazo com
 * `DevLockTimeoutError` — nunca bloqueia para sempre.
 */
export async function acquireDevLock(root: string, options: DevLockOptions = {}): Promise<DevLockResult> {
	const canonical = await canonicalRoot(root);
	const lockPath = join(canonical, DEV_LOCK_FILE);
	const waitMs = options.waitMs ?? 0;
	const retryMs = Math.max(10, options.retryMs ?? 50);
	const startedAt = options.startedAt ?? ((pid: number) => processStartedAtMs(pid));
	const now = options.now ?? (() => new Date());

	await mkdir(canonical, { recursive: true }).catch((error: unknown) => {
		void error;
	});

	const deadline = Date.now() + waitMs;
	for (;;) {
		let handle: FileHandle;
		try {
			handle = await open(lockPath, 'wx');
		} catch (error) {
			const code = (error as { readonly code?: unknown }).code;
			if (code !== 'EEXIST') {
				return { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
			}
			const verdict = await inspectOwner(lockPath, startedAt);
			if (verdict.orphan) {
				// A remoção é atômica: dois recuperadores concorrentes, um
				// remove e o outro falha em criar com `wx` — e recomeça o laço.
				const removed = await rm(lockPath, { force: false }).then(
					() => true,
					() => false,
				);
				if (removed) {
					continue;
				}
			}
			if (Date.now() >= deadline) {
				return {
					kind: 'busy',
					...(verdict.owner !== undefined
						? { owner: { pid: verdict.owner.pid, acquiredAt: verdict.owner.acquiredAt } }
						: {}),
					recoverable: verdict.orphan || verdict.unknown,
					reason: verdict.reason,
				};
			}
			await sleep(retryMs);
			continue;
		}

		const owner: LockOwner = {
			version: 1,
			pid: process.pid,
			startedAtMs: await startedAt(process.pid),
			root: canonical,
			acquiredAt: now().toISOString(),
			...(options.token !== undefined ? { token: options.token } : {}),
		};
		try {
			await handle.writeFile(`${JSON.stringify(owner, null, 2)}\n`, 'utf8');
		} catch (error) {
			await handle.close().catch(() => undefined);
			await rm(lockPath, { force: true }).catch(() => undefined);
			return { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
		}
		let released = false;
		return {
			kind: 'acquired',
			lock: {
				owner,
				async release(): Promise<void> {
					if (released) {
						return;
					}
					released = true;
					await handle.close().catch(() => undefined);
					await rm(lockPath, { force: true }).catch(() => undefined);
				},
				async releaseHandle(): Promise<void> {
					released = true;
					await handle.close().catch(() => undefined);
				},
			},
		};
	}
}

/**
 * A trava de uma sessão DEV deste processo (DEV-5).
 *
 * ## Por que não é `acquireDevLock` puro
 *
 * O host toma a trava **sem prazo** no `ownerRequest()` para marcar "esta
 * sessão é dona do repositório". Mas `dev_write`/`dev_run` também precisam da
 * trava entre processos (DEV-2.2) para cada operação — e, como a trava é um
 * `wx` sem reentrância, a segunda aquisição do **mesmo processo** falhava com
 * "em uso por outro processo" (pid igual). Era um beco sem saída: o host não
 * podia ter a trava e as ferramentas ao mesmo tempo.
 *
 * ## O desenho
 *
 * A trava do host é registrada como **da sessão**, num registro em memória
 * (chave = raiz canônica). `acquireDevLockForSession` devolve um
 * empréstimo reentrante do **mesmo** dono — e mantém um contador, para que a
 * trava só seja liberada de verdade quando o último empréstimo sair. Outro
 * processo continua vendo o arquivo e sendo recusado, que é o que importa.
 *
 * ## Reentrância só para a sessão dona
 *
 * O empréstimo é de quem **também** tem a sessão ativa: a ferramenta recebe o
 * mesmo `DevToolDeps` do host. Um segundo `DevHost` na mesma raiz (outra
 * sessão, mesmo processo) não empresta a trava de ninguém — ele recebe a
 * recusa de "já está em uso", como qualquer outro dono.
 *
 * Nada aqui aceita um pid ou um caminho vindo do modelo: as chaves são a raiz
 * canônica do host.
 */
const sessionLocks = new Map<
	string,
	{ readonly root: string; readonly lock: DevFileLock; readonly owner: object; leases: number }
>();

/** A chave do registro: a raiz **e** o dono (a `DevSession`). */
function sessionKey(root: string, owner: object | undefined): string | undefined {
	return owner === undefined ? undefined : `${root}\u0000${ownerId(owner)}`;
}

const ownerIds = new WeakMap<object, number>();
let nextOwnerId = 0;

function ownerId(owner: object): number {
	const existing = ownerIds.get(owner);
	if (existing !== undefined) {
		return existing;
	}
	nextOwnerId += 1;
	ownerIds.set(owner, nextOwnerId);
	return nextOwnerId;
}

/**
 * Toma a trava da raiz para a sessão de `owner`. Falha se outro dono já a tem.
 *
 * O `owner` é a `DevSession` do host: é ele que diz de quem é o empréstimo.
 * Sem `owner`, é uma asserção de posse — recusa se a raiz já estiver tomada.
 *
 * `adopt`: o host já sabe que a trava em disco é **a dele** (mesmo processo,
 * mesmo token, DEV-6). Nesse caso ele não re-adquire com o `wx` — o arquivo é
 * reconhecido como próprio e o handle é aberto em modo de leitura/escrita.
 * O token nunca vem de fora do host.
 */
export async function claimSessionLock(
	root: string,
	owner?: object,
	adopt?: { readonly token: string; readonly probe?: boolean },
): Promise<DevFileLock> {
	const canonical = await canonicalRoot(root);
	const key = sessionKey(canonical, owner);
	const found = key !== undefined ? sessionLocks.get(key) : undefined;
	if (found !== undefined) {
		return found.lock;
	}
	// Outro dono **deste processo** já tem a raiz (outra `DevSession`): a trava
	// é dele, e este pedido é recusado como qualquer outro dono faria.
	if (owner !== undefined && [...sessionLocks.values()].some((entry) => entry.root === canonical)) {
		throw new Error('o repositório DEV está em uso por outra sessão deste processo');
	}
	// "Probe": a trava só é adotada se a **posse** for comprovável — mesmo
	// token **e** mesmo processo. Uma trava alheia (de outro processo vivo, de
	// outra instalação) nunca é derrubada: perder a identidade de quem a tem é
	// exatamente o caso em que se mantém, não se remove.
	if (adopt !== undefined && (await isOwnDevLock(canonical, adopt.token))) {
		const handle = await open(join(canonical, DEV_LOCK_FILE), 'r+').catch(() => undefined);
		if (handle !== undefined) {
			return thisProcessLock(canonical, owner, adopt.token, handle);
		}
	}
	if (adopt?.probe === true) {
		// "Probe": só é aceito tomar uma trava **livre**, a que já é nossa, ou a
		// de um dono **comprovadamente morto** — esta última o `acquireDevLock`
		// remove com a mesma inspeção de identidade (PID + instante de criação).
		// Recusar também a órfã deixava o repositório travado por um processo
		// que já não existe: medido no executável, depois de reiniciar, a
		// reativação era recusada "em uso pelo processo <pid morto>" e a sessão
		// não subia até alguém apagar o arquivo à mão.
		const held = await readLockOwnerFile(canonical);
		if (held.kind === 'held' && held.token !== adopt.token) {
			const verdict = await inspectOwner(
				join(canonical, DEV_LOCK_FILE),
				(pid) => processStartedAtMs(pid),
			).catch(() => ({ orphan: false, unknown: true } as const));
			if (!verdict.orphan) {
				throw new Error(
					held.pid !== undefined
						? `o repositório DEV está em uso pelo processo ${held.pid}; nada foi alterado`
						: 'o repositório DEV está em uso por outro dono; nada foi alterado',
				);
			}
		}
	}
	const taken = await acquireDevLock(canonical, {
		waitMs: 0,
		...(adopt !== undefined ? { token: adopt.token } : {}),
	});
	if (taken.kind !== 'acquired') {
		throw new Error(
			taken.kind === 'busy'
				? taken.owner !== undefined
					? `o repositório DEV está em uso pelo processo ${taken.owner.pid} desde ${taken.owner.acquiredAt}`
					: `o repositório DEV está em uso por outro processo (${taken.reason})`
				: `não foi possível coordenar o repositório: ${taken.message}`,
		);
	}
	sessionLocks.set(sessionKey(canonical, owner) ?? canonical, {
		root: canonical,
		lock: taken.lock,
		owner: owner ?? {},
		leases: 0,
	});
	return taken.lock;
}

/**
 * Solta a trava da sessão — só é efetivo quando não há empréstimo ativo.
 *
 * A raiz entra em `releasing` em vez de sumir do mapa: um empréstimo em
 * andamento (uma escrita no fluxo de aplicação) ainda precisa saber que, ao
 * terminar, deve soltar o arquivo. Sem isso, um `ownerExit` durante a escrita
 * deixava o `FileHandle` aberto para sempre — o mocha avisava ao fechá-lo no
 * GC.
 */
const releasing = new Set<string>();

export async function releaseSessionLock(root: string, owner: object): Promise<void> {
	const canonical = await canonicalRoot(root);
	const key = sessionKey(canonical, owner);
	const entry = key !== undefined ? sessionLocks.get(key) : undefined;
	// Só o dono solta: uma sessão encerrada não pode abrir o repositório de
	// outra que continua autorizada.
	if (entry === undefined || key === undefined) {
		return;
	}
	sessionLocks.delete(key);
	if (entry.leases === 0) {
		await entry.lock.release();
		return;
	}
	// Com empréstimo ativo, o empréstimo solta ao terminar (ver
	// `acquireDevLockForSession`): o `ownerExit` não deixa outro processo ver
	// uma janela em que a trava parece livre enquanto uma escrita acontece.
	releasing.add(key);
}

/**
 * A trava entre processos, para uma operação de quem **é** a sessão dona.
 *
 * `owner` é a `DevSession` do host que chama. Se ela é a dona da raiz, o
 * resultado é um empréstimo reentrante; senão — inclusive de outra sessão no
 * mesmo processo — é a aquisição comum com prazo, e o `wx` recusa. O
 * resultado tem a mesma forma de `acquireDevLock`.
 */
export async function acquireDevLockForSession(
	root: string,
	owner: object,
	options: DevLockOptions = {},
): Promise<DevLockResult> {
	const canonical = await canonicalRoot(root);
	const key = sessionKey(canonical, owner);
	const entry = key !== undefined ? sessionLocks.get(key) : undefined;
	if (entry === undefined || key === undefined) {
		return acquireDevLock(canonical, options);
	}
	entry.leases += 1;
	let released = false;
	return {
		kind: 'acquired',
		lock: {
			owner: entry.lock.owner,
			async releaseHandle(): Promise<void> {
				// Empréstimo não é dono do handle: fechar o da sessão mataria a
				// trava para quem ainda a usa.
			},
			async release(): Promise<void> {
				if (released) {
					return;
				}
				released = true;
				entry.leases -= 1;
				const current = sessionLocks.get(key);
				if (current !== undefined && current !== entry) {
					// O host soltou e outra sessão já reclamou esta raiz: este
					// empréstimo é da trava antiga, que não é mais a de ninguém.
					await entry.lock.release();
					return;
				}
				// Só solta quando ninguém mais a usa.
				if (entry.leases === 0 && current === undefined) {
					releasing.delete(key);
					await entry.lock.release();
				}
			},
		},
	};
}

/**
 * "O processo anterior morreu": o registro em memória e o handle somem, e o
 * arquivo da trava **fica** — que é exatamente o que um processo morto deixa.
 *
 * Só o teste usa: um `ownerExit` de verdade apagaria o arquivo, e um app que
 * cai não desfaz nada.
 */
export async function forgetSessionLock(root: string): Promise<void> {
	const canonical = await canonicalRoot(root);
	const entries = [...sessionLocks.entries()].filter(([, entry]) => entry.root === canonical);
	for (const [key] of entries) {
		sessionLocks.delete(key);
	}
	for (const [, entry] of entries) {
		await entry.lock.releaseHandle();
	}
}

/**
 * O empréstimo de quem já é dono da raiz, **seja quem for** neste processo.
 *
 * ## Por que existe
 *
 * O `run_command` comum não conhece a `DevSession` — ele é montado antes de
 * qualquer sessão DEV existir. Chamando `acquireDevLock` cru, ele esbarrava no
 * arquivo que a **própria sessão** deste processo mantém aberto, e a mensagem
 * dizia "o repositório está em uso por outro processo" apontando o próprio PID
 * (reproduzido). Não era trava órfã: era dois caminhos para o mesmo recurso,
 * um deles sem o registro de empréstimo.
 *
 * Esta função fecha a lacuna sem enfraquecer nada:
 *
 * - só empresta quando a raiz **já é** de uma sessão deste processo — o
 *   arquivo continua aberto e outro processo continua sendo recusado;
 * - o empréstimo respeita o contador: a trava só é solta de verdade quando o
 *   último sair, e nunca é solta pela saída da sessão enquanto houver uso;
 * - quem não é dono não ganha nada: cai no `acquireDevLock` comum, que espera
 *   e recusa como sempre.
 *
 * Não aceita pid nem caminho de fora: a chave é a raiz canônica.
 */
export async function acquireDevLockForRoot(root: string, options: DevLockOptions = {}): Promise<DevLockResult> {
	const canonical = await canonicalRoot(root);
	const entry = [...sessionLocks.values()].find((candidate) => candidate.root === canonical);
	if (entry === undefined) {
		return acquireDevLock(canonical, options);
	}
	entry.leases += 1;
	let released = false;
	return {
		kind: 'acquired',
		lock: {
			owner: entry.lock.owner,
			async releaseHandle(): Promise<void> {
				// Empréstimo não é dono do handle: fechar o da sessão mataria a
				// trava para quem ainda a usa.
			},
			async release(): Promise<void> {
				if (released) {
					return;
				}
				released = true;
				entry.leases -= 1;
				const current = [...sessionLocks.values()].find((candidate) => candidate === entry);
				if (current === undefined) {
					// A sessão já saiu: este era o último uso e agora o arquivo
					// pode ir embora.
					if (entry.leases === 0) {
						await entry.lock.release();
					}
					return;
				}
				// A sessão continua viva e dona do arquivo: o empréstimo só
				// devolve a vaga.
			},
		},
	};
}

/**
 * A trava de uma sessão está tomada? (diagnóstico)
 *
 * A chave é a raiz canônica **e** o dono, como no registro.
 */
export function isSessionLockHeld(root: string): boolean {
	const key = process.platform === 'win32' ? resolve(root).toLowerCase() : resolve(root);
	return [...sessionLocks.values()].some(
		(entry) => entry.root === key || entry.root.toLowerCase() === key.toLowerCase(),
	);
}

/**
 * A trava órfã **deste** processo, registrada para a sessão nova.
 *
 * O arquivo fica, para nenhum outro processo a ver livre enquanto a sessão
 * nova existe; o handle aberto é o que a `release` fecha.
 */
function thisProcessLock(canonical: string, owner: object | undefined, token: string, handle: FileHandle): DevFileLock {
	let released = false;
	const lock: DevFileLock = {
		owner: {
			version: 1,
			pid: process.pid,
			root: canonical,
			acquiredAt: new Date().toISOString(),
			token,
		},
		async release(): Promise<void> {
			if (released) {
				return;
			}
			released = true;
			await handle.close().catch(() => undefined);
			await rm(join(canonical, DEV_LOCK_FILE), { force: true }).catch(() => undefined);
		},
		async releaseHandle(): Promise<void> {
			released = true;
			await handle.close().catch(() => undefined);
		},
	};
	sessionLocks.set(sessionKey(canonical, owner) ?? canonical, { root: canonical, lock, owner: owner ?? {}, leases: 0 });
	return lock;
}

/** O dono gravado no arquivo da trava, com o token (leitura pura). */
export async function readLockOwnerFile(
	root: string,
): Promise<
	| { readonly kind: 'free' }
	| { readonly kind: 'held'; readonly pid?: number; readonly acquiredAt?: string; readonly token?: string }
> {
	try {
		const raw = await readFile(join(resolve(root), DEV_LOCK_FILE), 'utf8');
		const parsed = JSON.parse(raw) as Partial<LockOwner>;
		return {
			kind: 'held',
			...(typeof parsed.pid === 'number' ? { pid: parsed.pid } : {}),
			...(typeof parsed.acquiredAt === 'string' ? { acquiredAt: parsed.acquiredAt } : {}),
			...(typeof parsed.token === 'string' ? { token: parsed.token } : {}),
		};
	} catch (error) {
		const code = (error as { readonly code?: unknown }).code;
		return code === 'ENOENT' ? { kind: 'free' } : { kind: 'held' };
	}
}

/**
 * Solta uma trava que o **processo anterior** deixou (DEV-6).
 *
 * Condição: o arquivo traz este token. Não exige o mesmo pid — depois de um
 * reinício o pid é outro, e a releitura da identidade do processo antigo não é
 * confiável. O token é aleatório por ativação e só existe no arquivo de estado
 * do host; não é prova de identidade de pessoa, é prova de "eu deixei isso".
 * O que protege de derrubar a trava de um processo **vivo** é o
 * `readLocalInstance`: a interface só chega aqui com uma instância só.
 */
export async function releasePriorLock(root: string, token: string): Promise<boolean> {
	try {
		const canonical = await canonicalRoot(root);
		const raw = await readFile(join(canonical, DEV_LOCK_FILE), 'utf8');
		const parsed = JSON.parse(raw) as Partial<LockOwner>;
		if (parsed.token !== token) {
			return false;
		}
		await rm(join(canonical, DEV_LOCK_FILE), { force: true });
		return true;
	} catch {
		return false;
	}
}

/** O veredito sobre o dono atual. */
interface OwnerVerdict {
	readonly owner?: LockOwner;
	/** `true` quando é seguro remover: o dono não existe ou o PID foi reciclado. */
	readonly orphan: boolean;
	/** `true` quando não se soube dizer — a trava é mantida. */
	readonly unknown: boolean;
	readonly reason: string;
}

/**
 * O dono ainda é o dono?
 *
 * A ordem importa: primeiro "o PID existe?"; depois, se há identidade gravada
 * e identidade legível, "é o mesmo instante de criação?". Só a segunda
 * resposta positiva prova PID reciclado — e só ela autoriza remover quando o
 * PID existe.
 */
async function inspectOwner(
	lockPath: string,
	startedAt: (pid: number) => Promise<number | undefined>,
): Promise<OwnerVerdict> {
	let raw: string;
	try {
		raw = await readFile(lockPath, 'utf8');
	} catch (error) {
		const code = (error as { readonly code?: unknown }).code;
		if (code === 'ENOENT') {
			// O arquivo sumiu entre o `wx` e a leitura: pode adquirir já.
			return { orphan: true, unknown: false, reason: 'a trava deixou de existir' };
		}
		return { orphan: false, unknown: true, reason: 'não foi possível ler a trava' };
	}
	let owner: LockOwner | undefined;
	try {
		const parsed = JSON.parse(raw) as Partial<LockOwner>;
		if (typeof parsed.pid === 'number' && typeof parsed.acquiredAt === 'string') {
			owner = {
				version: 1,
				pid: parsed.pid,
				...(typeof parsed.startedAtMs === 'number' ? { startedAtMs: parsed.startedAtMs } : {}),
				root: typeof parsed.root === 'string' ? parsed.root : '',
				acquiredAt: parsed.acquiredAt,
			};
		}
	} catch {
		return { orphan: false, unknown: true, reason: 'a trava tem conteúdo ilegível' };
	}
	if (owner === undefined) {
		return { orphan: false, unknown: true, reason: 'a trava não identifica o dono' };
	}
	if (!alive(owner.pid)) {
		return { owner, orphan: true, unknown: false, reason: `o processo ${owner.pid} não existe mais` };
	}
	if (owner.startedAtMs === undefined) {
		return {
			owner,
			orphan: false,
			unknown: true,
			reason: `o processo ${owner.pid} existe e a trava não registra quando ele começou`,
		};
	}
	const current = await startedAt(owner.pid);
	if (current === undefined) {
		return {
			owner,
			orphan: false,
			unknown: true,
			reason: `não foi possível confirmar a identidade do processo ${owner.pid}`,
		};
	}
	// DEV-AUDIT-01: a identidade tem de ser **confirmada**, não "aceita com
	// tolerância". A versão anterior tratava uma diferença de até 2 s como
	// "mesmo processo", o que mantinha para sempre uma trava de PID reciclado
	// nesse intervalo (recusa permanente, sem recuperação). E tratava
	// diferença maior como prova de reciclagem — mas o erro de leitura da
	// fonte pode ser do mesmo porte, e aí a trava de um dono vivo era removida.
	//
	// Agora só há um caminho para declarar o dono: estar dentro de
	// `IDENTITY_TOLERANCE_MS`, que é a precisão assumida da fonte (o
	// `QueryFullProcessImageName`/`GetProcessTimes` no Windows e
	// `/proc` no Linux erram no máximo na casa de milissegundos por
	// arredondamento). Fora disso, é divergente — **não** se remove.
	if (Math.abs(current - owner.startedAtMs) <= IDENTITY_TOLERANCE_MS) {
		return { owner, orphan: false, unknown: false, reason: `a trava pertence ao processo ${owner.pid}` };
	}
	// Divergente: o PID existe, mas a identidade não é a gravada. Pode ser
	// reciclagem — ou pode ser leitura imprecisa. Sem prova consistente, a
	// trava é mantida e o motivo nomeia o PID e a divergência.
	return {
		owner,
		orphan: false,
		unknown: true,
		reason:
			`o processo ${owner.pid} existe, mas a identidade não confere ` +
			`(trava: ${new Date(owner.startedAtMs).toISOString()}, processo: ${new Date(current).toISOString()}); ` +
			'trava mantida — confirme com o proprietário antes de removê-la',
	};
}

/**
 * A trava da raiz ainda tem um dono **vivo**? (DEV-8.16)
 *
 * `readLockOwnerFile` responde "há um arquivo", não "há um dono". A diferença
 * importa para o painel: um arquivo deixado por um processo que morreu no meio
 * de um turno (o caso comum depois de reiniciar o app) fazia o botão de ativar
 * dizer "em uso pelo processo <pid morto>" e ficar desabilitado para sempre —
 * medido no executável. Aqui a pergunta é feita com a **mesma** inspeção que o
 * `acquireDevLock` usa para decidir remover: um dono comprovadamente morto não
 * conta como em uso, e um que não se consegue provar continua contando.
 */
export async function devLockHeldByLiveOwner(root: string): Promise<boolean> {
	const owner = await readLockOwnerFile(root).catch(() => ({ kind: 'free' } as const));
	if (owner.kind !== 'held') {
		return false;
	}
	const verdict = await inspectOwner(
		join(resolve(root), DEV_LOCK_FILE),
		(pid) => processStartedAtMs(pid),
	).catch(() => ({ orphan: false, unknown: true } as const));
	return !verdict.orphan;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
