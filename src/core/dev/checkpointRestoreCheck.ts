/**
 * Quais arquivos de um checkpoint podem ser restaurados **agora** (DEV-6).
 *
 * ## Por que não tentar restaurar para descobrir
 *
 * A interface precisa dizer "este arquivo mudou por fora; não vou
 * sobrescrever" **antes** de o proprietário clicar. Tentar restaurar para ver
 * o que acontece escreveria no repositório de propósito só para perguntar.
 *
 * Esta é a mesma regra que `DevCheckpointStore.restore` aplica (`afterHash` do
 * checkpoint × hash atual do arquivo), escrita aqui como pergunta pura — e o
 * dono continua sendo o `restore`, que é quem escreve.
 *
 * `getSeal` devolve o `afterHash` gravado no checkpoint: ausente quando não há
 * selo (a escrita não chegou a acontecer), `null` quando o arquivo não existia
 * depois da operação. A página nunca vê hash, só o veredito.
 */

import { readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';

/** O veredito de um arquivo. */
export interface FileRestoreCheck {
	readonly path: string;
	/** O arquivo pode voltar ao estado anterior sem apagar mudança de ninguém? */
	readonly ok: boolean;
	/** Por que não, quando `ok` é falso. */
	readonly reason?: string;
}

/** O selo de um arquivo dentro de um checkpoint. */
export type Seal =
	| { readonly sealed: true; readonly afterHash?: string }
	| { readonly sealed: false };

/** Lê o selo de um arquivo dentro de um checkpoint. */
export type SealReader = (checkpointId: string, path: string) => Seal;

/**
 * Analisa um checkpoint sem tocar em nada.
 *
 * Nunca aceita caminho que escape da raiz: um checkpoint com `..` é recusado
 * como conflito, não lido.
 */
export async function inspectCheckpointRestore(
	root: string,
	files: readonly string[],
	readSeal: SealReader,
	checkpointId: string,
): Promise<readonly FileRestoreCheck[]> {
	const verdicts: FileRestoreCheck[] = [];
	for (const path of files) {
		const absolute = resolve(root, path);
		const inside = !isAbsolute(path) && !relative(root, absolute).startsWith('..');
		if (!inside) {
			verdicts.push({ path, ok: false, reason: 'o caminho sai do repositório autorizado' });
			continue;
		}
		const seal = readSeal(checkpointId, path);
		if (!seal.sealed) {
			// Sem selo = a escrita não chegou a acontecer; restaurar é seguro.
			verdicts.push({ path, ok: true });
			continue;
		}
		const current = await readFile(absolute).catch(() => undefined);
		if (current === undefined) {
			// O arquivo sumiu depois da operação: restaurar recriaria (se havia
			// original) ou nada há a fazer. É seguro.
			verdicts.push({ path, ok: true });
			continue;
		}
		const currentHash = createHash('sha256').update(current).digest('hex');
		if (seal.afterHash === undefined) {
			verdicts.push({
				path,
				ok: false,
				reason: 'o arquivo não existia depois da operação do DEV; agora existe',
			});
			continue;
		}
		if (currentHash !== seal.afterHash) {
			verdicts.push({ path, ok: false, reason: 'o arquivo mudou depois da operação do DEV' });
			continue;
		}
		verdicts.push({ path, ok: true });
	}
	return verdicts;
}
