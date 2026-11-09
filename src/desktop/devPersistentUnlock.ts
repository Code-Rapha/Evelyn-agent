/**
 * O desbloqueio persistente do modo DEV neste dispositivo.
 *
 * ## O que é guardado, e o que **não** é
 *
 * Nada de senha. O arquivo contém um **recibo**: o verifier da credencial que
 * autorizou (o mesmo valor com que a sessão DEV já se vincula), a sessão do
 * Windows que autorizou, a data, e um contador de bloqueios. Ele é cifrado com
 * **DPAPI no escopo do usuário atual** (`windowsDpapi.ts`): copiado para outro
 * computador ou lido por outra conta do Windows, não abre.
 *
 * ## Por que isso não enfraquece a autorização
 *
 * O recibo **não autentica ninguém**: ele apenas diz "esta credencial foi
 * validada com a senha, nesta conta, em tal data". Toda ação DEV continua
 * passando por `assertStillAuthorized()`, que compara o `binding` com o
 * verifier de agora. Consequências diretas, e todas testadas:
 *
 * - **senha trocada ou recuperada** → o verifier muda, o recibo não casa, e a
 *   sessão cai: pede autenticação de novo;
 * - **arquivo adulterado, truncado ou de outra conta** → o DPAPI recusa abrir,
 *   e o resultado é "inválido", nunca "autorizado";
 * - **ledger de revogação** → o recibo carrega o contador de revogações em
 *   vigor; uma revogação o incrementa, e todo recibo antigo deixa de valer
 *   mesmo que o arquivo cifrado sobreviva a uma restauração.
 *
 * Ou seja: persistir a autorização **encurta o caminho** para o mesmo estado
 * que a senha produzia — não cria um caminho novo para um estado diferente.
 *
 * ## "Neste dispositivo" é literal
 *
 * O arquivo mora em `dev/` da raiz de dados e o DPAPI o amarra a esta conta
 * nesta máquina. Uma cópia para outro lugar não é um desbloqueio: é um arquivo
 * ilegível, e a resposta é pedir a senha.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
	dpapiAvailable,
	sealForCurrentUser,
	unsealForCurrentUser,
	type PowerShellRunner,
} from './windowsDpapi';

/** O recibo, em claro — só em memória e só no momento de selar/abrir. */
export interface PersistentReceipt {
	/** O verifier da credencial que autorizou. Não é a senha nem permite derivá-la. */
	readonly verifier: string;
	/** A sessão do Windows que autorizou, quando conhecida. */
	readonly sessionId?: string;
	readonly grantedAt: string;
	/** O contador de revogações em vigor quando o recibo foi criado. */
	readonly revocationEpoch: number;
	/** Marca do formato, para uma versão futura não confundir um recibo com outro. */
	readonly version: number;
}

/** O estado lido do disco. */
export type PersistentState =
	| { readonly kind: 'none' }
	| { readonly kind: 'valid'; readonly receipt: PersistentReceipt }
	/** Existe, mas não pôde ser usado: pedir a senha de novo. */
	| { readonly kind: 'invalid'; readonly reason: string }
	/** O DPAPI não está disponível nesta máquina. */
	| { readonly kind: 'unavailable'; readonly reason: string };

/** O arquivo do recibo, e o do contador de revogações. */
export const PERSISTENT_FILE = 'unlock.bin';
export const REVOCATION_FILE = 'unlock-epoch.json';

const RECEIPT_VERSION = 1;

export interface PersistentUnlockStore {
	/** O estado atual, lido do disco sem alterar nada. */
	state(): Promise<PersistentState>;
	/** Grava o recibo (após uma autenticação bem-sucedida). */
	remember(input: {
		readonly verifier: string;
		readonly sessionId?: string;
		readonly grantedAt: string;
	}): Promise<{ readonly ok: boolean; readonly reason?: string }>;
	/** Apaga o recibo: o próximo desbloqueio pede a senha. */
	forget(): Promise<void>;
	/** Apaga o recibo **e** invalida qualquer cópia que tenha sobrevivido. */
	revoke(): Promise<void>;
	/** O contador de revogações em vigor. */
	epoch(): Promise<number>;
}

/** O que a leitura usou, para um teste trocar o DPAPI sem mexer no produto. */
export interface PersistentUnlockOptions {
	readonly devDir: string;
	readonly platform?: NodeJS.Platform;
	readonly run?: PowerShellRunner;
	readonly now?: () => Date;
}

/**
 * O store sobre `dev/` da raiz de dados.
 *
 * Toda falha é um veredito, nunca uma exceção: um arquivo que não abre é
 * `invalid`, e quem chama trata isso como "peça a senha".
 */
export function createPersistentUnlockStore(options: PersistentUnlockOptions): PersistentUnlockStore {
	const receiptPath = join(options.devDir, PERSISTENT_FILE);
	const epochPath = join(options.devDir, REVOCATION_FILE);
	const platform = options.platform ?? process.platform;
	const run = options.run;

	const readEpoch = async (): Promise<number> => {
		let raw: string;
		try {
			raw = await readFile(epochPath, 'utf8');
		} catch {
			// Sem arquivo é o estado inicial: nenhuma revogação ainda.
			return 0;
		}
		// Existe mas não abre: isso **não** é zero. Ler como zero faria um
		// contador apagado ou corrompido ressuscitar todos os recibos revogados
		// — e apagar um arquivo é a coisa mais fácil que um atacante local faz.
		// Um contador ilegível invalida tudo: o estado seguro é pedir a senha.
		try {
			const parsed: unknown = JSON.parse(raw);
			const epoch =
				typeof parsed === 'object' && parsed !== null && 'epoch' in parsed
					? (parsed as { readonly epoch: unknown }).epoch
					: undefined;
			if (typeof epoch === 'number' && Number.isInteger(epoch) && epoch >= 0) {
				return epoch;
			}
		} catch {
			// cai na recusa abaixo
		}
		throw new Error('o contador de revogações está ilegível');
	};

	const writeEpoch = async (epoch: number): Promise<void> => {
		await mkdir(dirname(epochPath), { recursive: true });
		await writeFile(epochPath, `${JSON.stringify({ epoch }, null, 2)}\n`, 'utf8');
	};

	return {
		epoch: readEpoch,

		async state(): Promise<PersistentState> {
			if (!dpapiAvailable(platform)) {
				return { kind: 'unavailable', reason: 'o desbloqueio persistente usa o DPAPI, que só existe no Windows' };
			}
			let sealed: string;
			try {
				sealed = (await readFile(receiptPath, 'utf8')).trim();
			} catch {
				return { kind: 'none' };
			}
			if (sealed.length === 0) {
				return { kind: 'none' };
			}
			// O contador é lido **antes** de abrir o recibo: se ele está
			// ilegível, o recibo não vale, e nem é preciso gastar o DPAPI.
			let epoch: number;
			try {
				epoch = await readEpoch();
			} catch (error) {
				return {
					kind: 'invalid',
					reason: `${error instanceof Error ? error.message : String(error)}; autentique de novo`,
				};
			}
			const opened = await unsealForCurrentUser(
				sealed,
				run !== undefined ? { run, platform } : { platform },
			);
			if (opened.kind !== 'opened') {
				// DPAPI indisponível é diferente de arquivo ruim: o primeiro pode
				// funcionar amanhã (outra máquina, outro usuário); o segundo não.
				return opened.kind === 'unavailable'
					? { kind: 'unavailable', reason: opened.reason }
					: { kind: 'invalid', reason: opened.reason };
			}
			const receipt = parseReceipt(Buffer.from(opened.base64, 'base64').toString('utf8'));
			if (receipt === undefined) {
				return { kind: 'invalid', reason: 'o recibo aberto não tem o formato esperado' };
			}
			if (receipt.revocationEpoch !== epoch) {
				// Uma revogação aconteceu depois deste recibo. Ele sobreviveu ao
				// apagamento (restauração de backup, cópia), mas não vale.
				return {
					kind: 'invalid',
					reason: 'o desbloqueio foi revogado depois de ser gravado; autentique de novo',
				};
			}
			return { kind: 'valid', receipt };
		},

		async remember(input): Promise<{ readonly ok: boolean; readonly reason?: string }> {
			if (!dpapiAvailable(platform)) {
				return { ok: false, reason: 'o DPAPI não está disponível nesta plataforma' };
			}
			const receipt: PersistentReceipt = {
				version: RECEIPT_VERSION,
				verifier: input.verifier,
				...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
				grantedAt: input.grantedAt,
				revocationEpoch: await readEpoch(),
			};
			const sealed = await sealForCurrentUser(
				Buffer.from(JSON.stringify(receipt), 'utf8'),
				run !== undefined ? { run, platform } : { platform },
			);
			if (sealed.kind !== 'sealed') {
				return { ok: false, reason: sealed.reason };
			}
			try {
				await mkdir(dirname(receiptPath), { recursive: true });
				await writeFile(receiptPath, `${sealed.base64}\n`, 'utf8');
				return { ok: true };
			} catch (error) {
				return {
					ok: false,
					reason: `não foi possível gravar o desbloqueio: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
		},

		async forget(): Promise<void> {
			await rm(receiptPath, { force: true });
		},

		async revoke(): Promise<void> {
			// A ordem importa: apagar primeiro fecha o caminho normal; incrementar
			// o contador invalida qualquer cópia que tenha sido restaurada antes.
			await rm(receiptPath, { force: true });
			await writeEpoch((await readEpoch()) + 1);
		},
	};
}

/** Lê o recibo. Devolve `undefined` quando falta um campo — nunca completa por dedução. */
function parseReceipt(raw: string): PersistentReceipt | undefined {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const candidate = value as Record<string, unknown>;
	const verifier = candidate['verifier'];
	const grantedAt = candidate['grantedAt'];
	const revocationEpoch = candidate['revocationEpoch'];
	const version = candidate['version'];
	if (typeof verifier !== 'string' || verifier.length === 0) {
		return undefined;
	}
	if (typeof grantedAt !== 'string' || grantedAt.length === 0) {
		return undefined;
	}
	if (typeof revocationEpoch !== 'number' || !Number.isInteger(revocationEpoch) || revocationEpoch < 0) {
		return undefined;
	}
	if (version !== RECEIPT_VERSION) {
		return undefined;
	}
	const sessionId = candidate['sessionId'];
	return {
		version: RECEIPT_VERSION,
		verifier,
		...(typeof sessionId === 'string' && sessionId.length > 0 ? { sessionId } : {}),
		grantedAt,
		revocationEpoch,
	};
}
