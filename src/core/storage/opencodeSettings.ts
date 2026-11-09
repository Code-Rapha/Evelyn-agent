/**
 * Onde o OpenCode mora: a URL, e quem a administra.
 *
 * ## Por que é um arquivo próprio
 *
 * A configuração do OpenCode **não é** uma conexão de provedor: ela não entra
 * em `state.json`, não vira um `ProviderSummary` e não é lida pelo motor de
 * rota. É um registro de servidor — endereço, modo e a porta, quando o
 * processo é da Evelyn.
 *
 * A senha **nunca** é gravada aqui, e o tipo não tem campo para ela. O que se
 * grava é o que se sabe do servidor: o modo (`managed` = processo da
 * Evelyn; `manual` = servidor do usuário), a URL e a data de início.
 *
 * ## A leitura, e a ausência
 *
 * `read()` devolve `absent` para um arquivo que não existe, `corrupt` para um
 * que existe e não é um registro válido, e `present` para o registro. A
 * diferença importa: um arquivo ilegível não vira "nunca configurado", porque
 * apagá-lo por engano faria o app esquecer um servidor que o usuário escolheu.
 *
 * ## A gravação
 *
 * Atômica, como a do roteador, e **verificada**: o arquivo é lido de volta e
 * comparado. Gravar não é acreditar.
 */
import { readFile, rm } from 'node:fs/promises';
import { writeFileAtomic } from '../../adapters/local/writeFileAtomic';

/** Quem é dono do processo do servidor. */
export type OpencodeMode = 'managed' | 'manual';

/** O registro, como vai para o disco. */
export interface OpencodeRecord {
	readonly version: 1;
	readonly mode: OpencodeMode;
	/** O endereço base, sem barra final. */
	readonly baseUrl: string;
	/** No modo gerenciado: a porta escolhida para o processo. */
	readonly port?: number;
	/** Quando o servidor foi iniciado/registrado (ISO). */
	readonly since: string;
}

/** A leitura: o registro, ou o motivo de não haver um. */
export type OpencodeRecordRead =
	| { readonly kind: 'present'; readonly record: OpencodeRecord }
	| { readonly kind: 'absent' }
	| { readonly kind: 'corrupt'; readonly reason: string };

/** A escrita: gravado, ou o motivo. */
export type OpencodeRecordWrite =
	| { readonly kind: 'written' }
	| { readonly kind: 'failed'; readonly message: string };

export const OPENCODE_SETTINGS_FILE = 'opencode.json';

/** O registro, se o conteúdo for um registro válido e compreensível. */
export function parseOpencodeRecord(raw: string): OpencodeRecord | undefined {
	let payload: unknown;
	try {
		payload = JSON.parse(raw.replace(/^\uFEFF/, ''));
	} catch {
		throw new Error('o arquivo do OpenCode não é JSON válido');
	}
	if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
		throw new Error('o arquivo do OpenCode não é um registro');
	}
	const record = payload as Record<string, unknown>;
	// Um campo de senha gravado por uma versão futura ou por engano é recusado
	// na leitura, para que ele nunca seja tratado como parte do registro.
	if ('password' in record || 'secret' in record || 'apiKey' in record) {
		throw new Error('o arquivo do OpenCode tem um campo de credencial; ele não deve existir');
	}
	const mode = record['mode'];
	const baseUrl = record['baseUrl'];
	const since = record['since'];
	if (mode !== 'managed' && mode !== 'manual') {
		throw new Error('o arquivo do OpenCode tem um modo desconhecido');
	}
	if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
		throw new Error('o arquivo do OpenCode não tem endereço');
	}
	if (typeof since !== 'string' || since.length === 0) {
		throw new Error('o arquivo do OpenCode não tem data');
	}
	const port = record['port'];
	return {
		version: 1,
		mode,
		baseUrl,
		...(typeof port === 'number' && Number.isInteger(port) ? { port } : {}),
		since,
	};
}

/** A forma gravada — sem senha, por construção. */
export function serializeOpencodeRecord(record: OpencodeRecord): string {
	return `${JSON.stringify(record, null, 2)}\n`;
}

/**
 * Lê e grava o registro do servidor OpenCode.
 *
 * Sem cópia de segurança: o arquivo contém só o que o usuário escolheu, e um
 * registro perdido é reconfigurável pela interface. O que não pode acontecer é
 * a gravação deixar um arquivo pela metade — e é o `writeFileAtomic` que
 * garante isso.
 */
export class OpencodeRecordStore {
	constructor(private readonly filePath: string) {}

	async read(): Promise<OpencodeRecordRead> {
		let raw: string;
		try {
			raw = await readFile(this.filePath, 'utf8');
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message.includes('ENOENT')) {
				return { kind: 'absent' };
			}
			return { kind: 'corrupt', reason: `o arquivo do OpenCode não pôde ser lido (${message})` };
		}
		let record: OpencodeRecord | undefined;
		try {
			record = parseOpencodeRecord(raw);
		} catch (error) {
			return {
				kind: 'corrupt',
				reason: error instanceof Error ? error.message : 'o arquivo do OpenCode não é um registro válido',
			};
		}
		if (record === undefined) {
			return { kind: 'corrupt', reason: 'o arquivo do OpenCode não é um registro válido' };
		}
		return { kind: 'present', record };
	}

	async write(record: OpencodeRecord): Promise<OpencodeRecordWrite> {
		const serialized = serializeOpencodeRecord(record);
		try {
			await writeFileAtomic(this.filePath, serialized);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { kind: 'failed', message: `o registro do OpenCode não pôde ser gravado (${message})` };
		}
		// Gravar não é acreditar: lê de volta e compara.
		try {
			const written = await readFile(this.filePath, 'utf8');
			if (written !== serialized) {
				return { kind: 'failed', message: 'o registro do OpenCode não corresponde ao que foi gravado' };
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { kind: 'failed', message: `o registro do OpenCode não pôde ser lido de volta (${message})` };
		}
		return { kind: 'written' };
	}

	async clear(): Promise<void> {
		await rm(this.filePath, { force: true });
	}
}
