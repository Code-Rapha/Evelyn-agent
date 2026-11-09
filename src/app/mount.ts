/**
 * A regra dos hosts: quem monta o Core, e quem é recusado.
 *
 * ## O problema que ela resolve
 *
 * A raiz dos dados tem um dono, e a posse é um arquivo aberto
 * (`acquireStorageLock`). Cada host — o Electron, o servidor local — precisa
 * pedir a raiz **antes** de montar o Core, senão os dois montam e o último a
 * escrever apaga a escrita do outro.
 *
 * Uma regra escrita duas vezes é uma regra que diverge: um host passa a
 * tratar a recusa de um jeito e o outro de outro, e o sintoma aparece como
 * "abriu sem avisar" ou "travou sem motivo". Aqui ela é uma só, e os dois
 * hosts a chamam.
 *
 * ## O que a regra garante
 *
 * - **um dono**: quem não consegue a raiz não monta o Core;
 * - **nenhuma escrita sem posse**: a montagem recebe o lock tomado, e não
 *   abre os stores antes de saber que pode;
 * - **recusa explicada**: a mensagem diz *quem* tem a raiz, o pid e desde
 *   quando — para o usuário saber o que fechar;
 * - **nada para trás**: uma montagem que falha solta a raiz, para o próximo
 *   host poder entrar.
 */
import { defaultDataStoreRoot } from '../adapters/local/fileDataStore';
import { assembleCore, type AssembleOptions, type AssembledCore } from './assemble';
import { acquireStorageLock, type StorageLockResult } from './storageLock';

/** O que o host quer montar. */
export interface MountOptions extends Omit<AssembleOptions, 'lock'> {
	/** Qual host está pedindo a raiz (`desktop`, `web`, …). */
	readonly host: string;
	/** O que dizer ao usuário quando a raiz estiver ocupada. */
	readonly name: string;
	/** Onde verificar se o dono da raiz continua vivo. Testes injetam. */
	readonly isOwnerAlive?: (pid: number) => Promise<boolean>;
}

/** O resultado: ou o Core montado com a raiz, ou o motivo da recusa. */
export type MountResult =
	| {
			readonly kind: 'mounted';
			readonly core: AssembledCore;
			/** Solta a raiz depois de encerrar o Core. Idempotente. */
			release(): Promise<void>;
	  }
	| {
			/**
			 * A raiz é de outro host.
			 *
			 * Não é um erro de programação: é o estado normal de "dois hosts
			 * abertos", e quem chama decide entre avisar e encerrar.
			 */
			readonly kind: 'busy';
			readonly message: string;
			/** A raiz que estava ocupada — a resolvida, não a que veio. */
			readonly rootPath: string;
	  }
	| {
			/** A raiz não pôde ser tomada por outro motivo (permissão, disco). */
			readonly kind: 'failed';
			readonly message: string;
			readonly rootPath: string;
	  };

/**
 * A mensagem única de recusa.
 *
 * Fala do que o usuário reconhece — o outro app — e não do mecanismo:
 * "feche o outro host" é acionável; "EDIÇÕES DE TRAVA" não é.
 */
export function storageBusyMessage(
	rootPath: string,
	name: string,
	owner: { readonly host: string; readonly pid: number; readonly since: string } | undefined,
): string {
	if (owner === undefined) {
		return (
			`${name}: a pasta de dados (${rootPath}) já está em uso por outra instância da Evelyn. ` +
			'Feche a outra instância e abra esta de novo.'
		);
	}
	// O serviço local é o dono pretendido da raiz: ele existe para continuar de
	// pé com o app fechado, então "feche o outro" é o conselho errado. A
	// mensagem diz o que de fato aconteceu e como usar o serviço.
	if (owner.host === 'web') {
		return (
			`${name}: o serviço local da Evelyn está no ar e é o dono da pasta de dados ` +
			`(processo ${owner.pid}, desde ${owner.since}). O aplicativo não abre uma segunda ` +
			'cópia dos dados enquanto o serviço estiver ativo. Encerre o serviço para abrir o ' +
			'aplicativo com os dados.'
		);
	}
	return (
		`${name}: a pasta de dados (${rootPath}) já está em uso pelo app desktop ` +
		`(processo ${owner.pid}, desde ${owner.since}). ` +
		'Feche a outra instância e abra esta de novo.'
	);
}

/**
 * Toma a raiz e monta o Core — ou explica por que não montou.
 *
 * A ordem é o contrato: **lock primeiro, montagem depois**. Uma montagem que
 * falha solta o lock no mesmo lugar, então não existe caminho em que o Core
 * é aberto sem a raiz, nem caminho em que a raiz fica presa por um host que
 * não subiu.
 */
export async function mountCore(options: MountOptions): Promise<MountResult> {
	const rootPath = options.rootPath;
	const { host, name, isOwnerAlive, ...assembleOptions } = options;

	const lockResult = await acquireStorageLockFor(rootPath, host, isOwnerAlive);
	if (lockResult.kind === 'busy') {
		return {
			kind: 'busy',
			message: storageBusyMessage(lockResult.rootPath, name, lockResult.owner),
			rootPath: lockResult.rootPath,
		};
	}
	if (lockResult.kind === 'failed') {
		return {
			kind: 'failed',
			message: `${name}: não foi possível usar a pasta de dados (${lockResult.rootPath}): ${lockResult.message}`,
			rootPath: lockResult.rootPath,
		};
	}

	const lock = lockResult.lock;
	try {
		const core = assembleCore({
			...assembleOptions,
			// A raiz travada e a raiz montada são a mesma, literalmente: o
			// Core abre os stores em `rootPath`, e o lock está lá.
			rootPath: lockResult.rootPath,
			lock: { host, held: lock },
		});
		let released = false;
		return {
			kind: 'mounted',
			core,
			async release(): Promise<void> {
				if (released) {
					return;
				}
				released = true;
				core.chat.dispose();
				await lock.release();
			},
		};
	} catch (error) {
		// A montagem falhou: a raiz volta para quem a quiser.
		await lock.release().catch(() => undefined);
		return {
			kind: 'failed',
			message:
				`${name}: o Core não iniciou. ` +
				(error instanceof Error ? error.message : String(error)),
			rootPath: lockResult.rootPath,
		};
	}
}

/** A raiz a tomar: a que o host pediu, ou a padrão. */
async function acquireStorageLockFor(
	rootPath: string | undefined,
	host: string,
	isOwnerAlive: ((pid: number) => Promise<boolean>) | undefined,
): Promise<StorageLockResult & { readonly rootPath: string }> {
	// A raiz é resolvida uma vez, aqui: o lock é tomado na raiz em que os
	// dados vão morar, e `assembleCore` recebe a mesma.
	const resolved = rootPath ?? defaultDataStoreRoot();
	const result = await acquireStorageLock(resolved, host, {
		...(isOwnerAlive !== undefined ? { isOwnerAlive } : {}),
	});
	return { ...result, rootPath: resolved };
}
