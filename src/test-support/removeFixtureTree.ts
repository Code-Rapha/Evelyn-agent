/**
 * Remoção do diretório temporário de um teste, com nova tentativa.
 *
 * Um turno grava consumo depois do evento terminal — a execução fechada, a
 * conversa anexada a ela e o desfecho. Um teste que termina logo após a
 * última leitura pode deixar essas escritas chegando enquanto o `teardown`
 * apaga a árvore, e no Windows o diretório então não fica vazio (`ENOTEMPTY`)
 * ou está preso por um handle (`EBUSY`). Repetir por um instante é o mesmo
 * cuidado que `writeFileAtomic` toma do outro lado da transação; a falha só é
 * reportada quando o diretório de fato não pode ser removido.
 */
import { rm } from 'node:fs/promises';

const ATTEMPTS = 20;
const DELAY_MS = 25;

export async function removeFixtureTree(path: string): Promise<void> {
	let lastError: unknown;
	for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
		try {
			await rm(path, { recursive: true, force: true });
			return;
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
		}
	}
	if (lastError !== undefined) {
		throw lastError;
	}
}
