/**
 * Leitura direta dos arquivos que o serviço deixa na raiz.
 *
 * Existe para o teste de integração não importar a via de leitura "oficial"
 * (`readServiceRecord`) quando a pergunta é justamente "o que está no disco":
 * uma asserção feita com o mesmo código que a produção usa não provaria que o
 * arquivo tem a forma esperada, só que o leitor e o escritor concordam.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** O nome do arquivo de trava, repetido aqui de propósito (ver acima). */
export const STORAGE_LOCK_FILE_NAME = 'storage.lock';

/** O `service.json` cru. */
export async function readServiceRecord(
	root: string,
): Promise<
	| { readonly kind: 'absent' }
	| { readonly kind: 'ok'; readonly record: Record<string, unknown> }
	| { readonly kind: 'invalid' }
> {
	let raw: string;
	try {
		raw = await readFile(join(root, 'service.json'), 'utf8');
	} catch {
		return { kind: 'absent' };
	}
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return { kind: 'invalid' };
		}
		return { kind: 'ok', record: parsed as Record<string, unknown> };
	} catch {
		return { kind: 'invalid' };
	}
}
