/**
 * Gravação à prova de falha da configuração do roteador.
 *
 * ## O problema que ela resolve
 *
 * `writeFileAtomic` protege o **conteúdo**: grava num temporário, valida
 * renomeando. O que ele não protege é a **substituição**: se o `rename` falhar
 * — no Windows basta outro processo ter o destino aberto —, o destino
 * continua existindo, mas o caminho seguinte é a leitura de um arquivo que o
 * `rename` não trocou. E, se algo apagou o destino, não há de onde voltar.
 *
 * Aqui a gravação passa a ter três peças:
 *
 * 1. o arquivo de destino, escrito por `writeFileAtomic` (temporário no
 *    mesmo diretório, renomeação atômica);
 * 2. uma **cópia de segurança** da última versão que foi lida ou gravada com
 *    sucesso, também escrita atomicamente;
 * 3. uma **verificação** depois de gravar: o arquivo é lido de volta e
 *    comparado ao que se quis gravar. Gravar sem conferir é acreditar.
 *
 * ## As regras
 *
 * - Se a gravação falhar, o destino fica **como estava** — o
 *   `writeFileAtomic` não o toca antes do `rename` —, e a cópia de segurança
 *   também. A configuração anterior continua no disco.
 * - Se o destino sumiu ou está ilegível, a leitura tenta a cópia de
 *   segurança **depois de validá-la**, e diz que fez isso. Nunca troca uma
 *   configuração válida por dados inválidos, e nunca transforma um arquivo
 *   corrompido em "nunca configurado" em silêncio.
 */
import { readFile, rm } from 'node:fs/promises';
import type { RouterConfig } from '../providers/routing/config';
import { parseRouterConfig, serializeRouterConfig } from './routerConfigLedger';
import { writeFileAtomic } from '../../adapters/local/writeFileAtomic';

/** O sufixo do arquivo de segurança, ao lado do destino. */
export const ROUTER_CONFIG_BACKUP_SUFFIX = '.backup';

/**
 * O que aconteceu na última leitura.
 *
 * O `RouterConfig` devolvido é a configuração; isto é a **procedência**. Fica
 * num campo irmão, e não dentro do `RouterConfig`, para que a
 * serialização continue gravando só a escolha — procedência não é escolha.
 *
 * `undefined` = leitura normal (o destino serviu, ou nunca houve escolha).
 */
export type RouterConfigOrigin = 'recovered' | 'unreadable';

/**
 * Lê uma escolha do arquivo — e distingue "sem escolha" de "não é escolha".
 *
 * `parseRouterConfig` responde "o que dá para usar": campo inválido cai no
 * padrão daquele campo, e um objeto vazio vira o padrão inteiro. Para decidir
 * se **o arquivo é uma escolha**, isso é frouxo demais: um `{}` no disco não
 * é "modo nativo", é um arquivo que perdeu o conteúdo.
 *
 * Aqui a regra é: o JSON precisa ser um objeto e ter ao menos um dos campos
 * do roteador, com um valor que o vocabulário aceite. Sem isso, é `undefined`
 * — e quem chama trata como estrago, não como ausência.
 */
export function readChoice(raw: string): RouterConfig | undefined {
	let payload: unknown;
	try {
		payload = JSON.parse(raw.replace(/^\uFEFF/, ''));
	} catch {
		return undefined;
	}
	if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
		return undefined;
	}
	const record = payload as Record<string, unknown>;
	const hasEnabled = typeof record['enabled'] === 'boolean';
	const hasMode = record['mode'] === 'native' || record['mode'] === 'external' || record['mode'] === 'direct';
	const hasTarget =
		(typeof record['externalRouterProviderId'] === 'string' && record['externalRouterProviderId'].length > 0) ||
		(typeof record['directProviderId'] === 'string' && record['directProviderId'].length > 0);
	if (!hasEnabled && !hasMode && !hasTarget) {
		return undefined;
	}
	return parseRouterConfig(raw);
}

/** O resultado de uma leitura, com o que aconteceu. */
export type RouterConfigRead =
	| {
			/** Veio do arquivo de destino, como está. */
			readonly kind: 'primary';
			readonly config: RouterConfig | undefined;
	  }
	| {
			/** O destino estava ausente ou ilegível; a cópia foi usada. */
			readonly kind: 'recovered';
			readonly config: RouterConfig;
			/** O motivo de o destino não ter servido. */
			readonly reason: string;
	  }
	| {
			/**
			 * O destino existe mas não é uma configuração válida, e não há cópia
			 * de segurança válida.
			 *
			 * Não é "nunca configurado": é um estrago, e quem lê precisa saber
			 * para não sobrescrevê-lo achando que não havia nada.
			 */
			readonly kind: 'corrupt';
			readonly reason: string;
	  };

/** A escrita: o que foi gravado, ou por que não foi. */
export type RouterConfigWrite =
	| { readonly kind: 'written' }
	| { readonly kind: 'failed'; readonly message: string };

/** Onde a configuração mora. */
export interface RouterConfigStoreOptions {
	/** O caminho do arquivo de destino (`router-config.json`). */
	readonly filePath: string;
	/** Avisos, para o que for recuperação — nunca silenciosa. */
	readonly warn?: (message: string, data?: Record<string, unknown>) => void;
}

/**
 * Lê e grava a configuração do roteador com uma cópia de segurança.
 *
 * A classe não decide o que é um roteador válido: `parseRouterConfig` e
 * `validateRouterConfig` fazem isso. Ela só garante que o que está no disco é
 * o que se quis gravar, e que uma falha não leva a anterior consigo.
 */
export class RouterConfigStore {
	private readonly backupPath: string;
	/** A procedência da última leitura, preenchida por `read`. */
	private origin: RouterConfigOrigin | undefined;

	constructor(private readonly options: RouterConfigStoreOptions) {
		this.backupPath = `${options.filePath}${ROUTER_CONFIG_BACKUP_SUFFIX}`;
	}

	/**
	 * Lê a configuração, com recuperação explícita.
	 *
	 * A ordem: destino → (falhou?) cópia de segurança validada. Um destino
	 * ausente é "nunca configurado" e **tenta** a cópia de segurança antes de
	 * aceitar: se houve uma gravação anterior que falhou no meio, a cópia é a
	 * última versão boa.
	 */
	async read(): Promise<RouterConfigRead> {
		this.origin = undefined;
		let primaryRaw: string | undefined;
		let primaryError: string | undefined;
		try {
			primaryRaw = await readFile(this.options.filePath, 'utf8');
		} catch (error) {
			primaryError = describe(error);
		}

		// O destino existe e serve? Um erro que não seja "não existe" (um
		// diretório no lugar do arquivo, permissão negada) é o mesmo tipo de
		// problema de um arquivo corrompido: o destino não pode ser lido.
		const missing = primaryError !== undefined && primaryError.includes('ENOENT');
		if (primaryRaw !== undefined || primaryError === undefined || !missing) {
			const parsed = primaryRaw === undefined ? undefined : readChoice(primaryRaw);
			if (parsed !== undefined) {
				return { kind: 'primary', config: parsed };
			}
			this.origin = 'unreadable';
			// O destino existe e não é válido: o estrago é dito, e a cópia de
			// segurança só entra se for válida.
			const recovered = await this.readBackup();
			if (recovered !== undefined) {
				this.origin = 'recovered';
				this.warn('The router configuration was unreadable; the backup was used', {
					reason: 'destination is not a valid configuration',
				});
				return {
					kind: 'recovered',
					config: recovered,
					reason: 'o arquivo do roteador não é uma configuração válida',
				};
			}
			return {
				kind: 'corrupt',
				reason:
					primaryError === undefined
						? 'o arquivo do roteador não é uma configuração válida, e não há cópia de segurança válida'
						: `o arquivo do roteador não pôde ser lido (${primaryError}) e não há cópia de segurança válida`,
			};
		}

		// Ausente, ou ilegível (permissão, diretório no lugar do arquivo).
		const recovered = await this.readBackup();
		if (recovered !== undefined) {
			this.origin = 'recovered';
			this.warn('The router configuration was missing; the backup was used', {
				reason: primaryError ?? 'missing',
			});
			return {
				kind: 'recovered',
				config: recovered,
				reason: primaryError === undefined ? 'o arquivo do roteador não existe' : primaryError,
			};
		}
		// Ausente e sem cópia: nunca configurado. Isto sim é silencioso,
		// porque não há nada a dizer.
		return { kind: 'primary', config: undefined };
	}

	/**
	 * Grava a configuração e a cópia de segurança.
	 *
	 * A ordem importa: **primeiro** o destino, **depois** a cópia. Se a
	 * cópia falhar, a gravação principal já aconteceu e a cópia antiga
	 * continua — que é a de antes, ainda válida. Se a principal falhar, a
	 * cópia não é tocada, e a anterior continua inteira nos dois lugares.
	 */
	async write(config: RouterConfig): Promise<RouterConfigWrite> {
		// Serializa primeiro: o que não pode ser gravado não chega ao disco.
		let serialized: string;
		try {
			serialized = serializeRouterConfig(config);
		} catch (error) {
			return { kind: 'failed', message: describe(error) };
		}

		try {
			await writeFileAtomic(this.options.filePath, serialized);
		} catch (error) {
			return {
				kind: 'failed',
				message: `o arquivo do roteador não pôde ser substituído (${describe(error)})`,
			};
		}

		// Gravar não é acreditar: o arquivo é lido de volta e comparado.
		const verified = await this.verify(serialized);
		if (verified !== undefined) {
			return { kind: 'failed', message: verified };
		}

		// A cópia é o segundo passo e não derruba a gravação: o destino já é
		// o novo, e uma cópia velha ainda é uma cópia válida.
		try {
			await writeFileAtomic(this.backupPath, serialized);
		} catch (error) {
			this.warn('The router configuration was written, but the backup was not', {
				reason: describe(error),
			});
		}

		return { kind: 'written' };
	}

	/** Remove as duas cópias — usado por um teste e por um reset explícito. */
	async clear(): Promise<void> {
		await rm(this.options.filePath, { force: true });
		await rm(this.backupPath, { force: true });
	}

	/** Lê de volta o que foi gravado e diz o que não bate, se não bater. */
	private async verify(expected: string): Promise<string | undefined> {
		let written: string;
		try {
			written = await readFile(this.options.filePath, 'utf8');
		} catch (error) {
			return `o arquivo do roteador não pôde ser lido de volta (${describe(error)})`;
		}
		if (written !== expected) {
			return 'o arquivo do roteador não corresponde ao que foi gravado';
		}
		return undefined;
	}

	/** A procedência da última leitura. */
	lastOrigin(): RouterConfigOrigin | undefined {
		return this.origin;
	}

	/** A cópia de segurança, quando ela é uma configuração válida. */
	private async readBackup(): Promise<RouterConfig | undefined> {
		try {
			const raw = await readFile(this.backupPath, 'utf8');
			return parseRouterConfig(raw);
		} catch {
			// Sem cópia, ou com cópia ilegível: não há o que recuperar.
			return undefined;
		}
	}

	private warn(message: string, data?: Record<string, unknown>): void {
		this.options.warn?.(message, data);
	}
}

/** O caminho da cópia de segurança de uma configuração. */
export function routerConfigBackupPath(filePath: string): string {
	return `${filePath}${ROUTER_CONFIG_BACKUP_SUFFIX}`;
}

/** A mensagem de um erro, com o código do sistema quando houver. */
function describe(error: unknown): string {
	if (error instanceof Error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code === undefined ? error.message : `${error.message} (${code})`;
	}
	return String(error);
}
