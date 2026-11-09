/**
 * A leitura de arquivos do modo DEV (DEV-2.1).
 *
 * ## Por que não é `readFile` + truncar
 *
 * `readFile` carrega o arquivo inteiro na memória **antes** de qualquer
 * limite ser aplicado: um arquivo de 2 GB derrubaria o processo, e um trecho
 * devolvido como se fosse o arquivo inteiro faria o modelo raciocinar sobre
 * metade de um `tsconfig` sem saber.
 *
 * Aqui a leitura acontece por um handle, com **um byte a mais** que o limite:
 * caber dentro de `limite + 1` é o que distingue "cabe" de "passa do limite",
 * sem ler o resto.
 *
 * ## Os três desfechos
 *
 * - `ok` com conteúdo e `truncated: false` — o arquivo inteiro;
 * - `ok` com conteúdo cortado e `truncated: true` — só quando o chamador pediu
 *   a leitura parcial (`allowTruncation`). Nesse caso o resultado **diz** que
 *   está incompleto; nunca se passa por completo;
 * - `ok: false` — arquivo acima do limite, binário, codificação inválida ou
 *   arquivo que mudou durante a leitura.
 */

import { open, stat } from 'node:fs/promises';

/** O teto de uma leitura do DEV: 256 KiB de UTF-8. */
export const DEV_READ_LIMIT_BYTES = 256 * 1024;

/** O que a leitura devolveu. */
export type DevReadResult =
	| {
			readonly ok: true;
			readonly content: string;
			readonly bytes: number;
			readonly totalBytes: number;
			/** `true` quando o conteúdo é só o começo do arquivo. */
			readonly truncated: boolean;
	  }
	| { readonly ok: false; readonly error: string };

export interface DevReadOptions {
	readonly limitBytes?: number;
	/** O teto de bytes não é do arquivo, é de leitura: aceita cortar. */
	readonly allowTruncation?: boolean;
}

/**
 * Lê um arquivo até o limite.
 *
 * `size` do `stat` já decide o caso comum sem abrir o arquivo para nada; o
 * handle cobre o arquivo que cresce depois da checagem.
 */
export async function readDevFile(absolute: string, options: DevReadOptions = {}): Promise<DevReadResult> {
	const limit = options.limitBytes ?? DEV_READ_LIMIT_BYTES;
	const before = await stat(absolute);
	if (!before.isFile()) {
		return { ok: false, error: 'o caminho não é um arquivo' };
	}
	if (before.size > limit && options.allowTruncation !== true) {
		return {
			ok: false,
			error:
				`o arquivo tem ${before.size} bytes, acima do limite de leitura do modo DEV (${limit} bytes). ` +
				'Leia um trecho com outra ferramenta ou aumente a leitura — o conteúdo não foi enviado parcial.',
		};
	}

	const handle = await open(absolute, 'r');
	try {
		// Um byte a mais: é o que revela "passou do limite" sem ler o resto.
		const wanted = Math.min(limit + 1, before.size + 1);
		const buffer = Buffer.alloc(wanted);
		const { bytesRead } = await handle.read(buffer, 0, wanted, 0);
		const slice = buffer.subarray(0, bytesRead);

		// O arquivo mudou enquanto era lido? O tamanho é o sinal barato, e o
		// conteúdo que voltasse seria de duas versões diferentes.
		const after = await stat(absolute);
		if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
			return {
				ok: false,
				error: 'o arquivo mudou durante a leitura; tente de novo para não receber um trecho misturado',
			};
		}

		if (looksBinary(slice)) {
			return {
				ok: false,
				error: 'o arquivo parece binário; o modo DEV só lê texto UTF-8',
			};
		}
		const tooLong = bytesRead > limit;
		const content = slice.subarray(0, Math.min(bytesRead, limit));
		let text: string | undefined;
		try {
			// Um caractere multibyte cortado no limite deixa a sequência
			// inválida: cortar no último caractere íntegro é melhor que devolver
			// lixo. `fatal: true` é o que faz o decodificador dizer "inválido"
			// em vez de inventar U+FFFD silenciosamente.
			text = new TextDecoder('utf-8', { fatal: true }).decode(content);
		} catch {
			if (!tooLong) {
				return { ok: false, error: 'o arquivo não é UTF-8 válido' };
			}
			// Cortado no meio de um caractere: decodifica o que é íntegro.
			for (let cut = content.length - 1; cut > 0; cut -= 1) {
				try {
					text = new TextDecoder('utf-8', { fatal: true }).decode(content.subarray(0, cut));
					break;
				} catch {
					// Um byte a menos e tenta de novo.
				}
			}
		}
		if (text === undefined) {
			return { ok: false, error: 'o arquivo não é UTF-8 válido' };
		}
		return {
			ok: true,
			content: text,
			bytes: Buffer.byteLength(text, 'utf8'),
			totalBytes: before.size,
			truncated: tooLong,
		};
	} finally {
		await handle.close();
	}
}

/**
 * O conteúdo "parece binário"?
 *
 * Um NUL nos primeiros 8 KiB é o sinal clássico, e é o que um arquivo de
 * imagem ou um `.p12` exibe. Texto com acentos não tem NUL.
 */
function looksBinary(slice: Buffer): boolean {
	const window = Math.min(slice.length, 8 * 1024);
	for (let index = 0; index < window; index += 1) {
		if (slice[index] === 0) {
			return true;
		}
	}
	return false;
}
