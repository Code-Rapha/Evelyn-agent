/**
 * Monta o gerenciador do OpenCode e a descoberta do catálogo a partir das
 * peças do host.
 *
 * ## Por que uma fábrica, e não lógica no host
 *
 * O host web tem três coisas que o gerenciador não deve conhecer: o caminho
 * da raiz, os serviços de log e o fato de estar no Node. A fábrica é a única
 * ligação entre eles — o gerenciador continua testável sem disco, sem
 * processo e sem rede.
 *
 * ## O que fica em disco
 *
 * - `opencode.json`: o registro (modo, URL, porta, data). **Sem senha**, e o
 *   tipo do registro não tem campo para ela.
 * - `opencode-catalog.json`: o catálogo validado da Fase 4D. Sem preço, sem
 *   limite, sem credencial, sem corpo cru.
 *
 * ## E a senha do modo manual
 *
 * Não é gravada. Ela vive na memória do host enquanto a conexão existir, e
 * `disconnect` a descarta. O preço é honesto e visível: depois de reiniciar o
 * app, um servidor manual aparece "desconectado" com o endereço, e o usuário
 * informa a senha de novo. A alternativa — gravar a senha de um servidor do
 * usuário para reconectar sozinho — não se justifica nesta fase.
 */
import { join } from 'node:path';
import { OpencodeCatalogStore, OPENCODE_CATALOG_FILE } from '../core/storage/opencodeCatalogStore';
import { OpencodeConversationStore } from '../core/storage/opencodeConversations';
import { OpencodeRecordStore, OPENCODE_SETTINGS_FILE } from '../core/storage/opencodeSettings';
import type { AssembledCore } from './assemble';
import { OpencodeCatalogService, type OpencodeCatalogOptions } from './opencodeCatalogService';
import { readProviderCredentials } from './opencodeCredentials';
import { getJson, requestOpencodeHealth } from './opencodeHealth';
import { findFreeLoopbackPort, OpencodeManager, type OpencodeManagerOptions } from './opencodeManager';
import { detectOpencodeCli, findOpencodeBinary, startOpencodeServer } from './opencodeProcess';

/**
 * O processo existe ainda?
 *
 * `process.kill(pid, 0)` não envia sinal: só pergunta ao sistema. `EPERM`
 * significa "existe, e não é meu" — que, para um processo que nós mesmos
 * iniciamos, quer dizer vivo. `ESRCH` é o único "não existe".
 */
function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = (error as { code?: string }).code;
		return code === 'EPERM';
	}
}

/** O binário da CLI, resolvido uma vez. */
function resolveBinary(): string | undefined {
	return findOpencodeBinary();
}

/**
 * O registro das conversas do OpenCode.
 *
 * Usa o `history` do Core — o mesmo `FileDataStore` da transcrição —, e não
 * um armazenamento novo: a pasta `conversations/` e a escrita atômica já
 * existem e são a única resposta para "onde estão as conversas".
 */
export function createOpencodeConversationStore(core: AssembledCore): OpencodeConversationStore {
	return new OpencodeConversationStore(core.history);
}

/** O gerenciador do servidor (Fase 4C). */
export function createOpencodeManager(core: AssembledCore, binary: string | undefined = resolveBinary()): OpencodeManager {	const store = new OpencodeRecordStore(join(core.root, OPENCODE_SETTINGS_FILE));
	const options: OpencodeManagerOptions = {
		binary: binary ?? 'opencode',
		detectCli: () => detectOpencodeCli({ ...(binary !== undefined ? { binary } : {}) }),
		spawnServer: (input) =>
			startOpencodeServer({
				binary: input.binary,
				port: input.port,
				password: input.password,
				onOutput: (line) => {
					// O OpenCode não imprime a senha; o processo já filtra a
					// linha antes de chegar aqui.
					core.logger.info(`OpenCode: ${line}`);
				},
			}),
		findFreePort: findFreeLoopbackPort,
		health: (input) =>
			requestOpencodeHealth({
				url: input.url,
				...(input.authorization !== undefined ? { authorization: input.authorization } : {}),
			}),
		isAlive: (handle) => handle.pid === undefined || processAlive(handle.pid),
		store,
		log: (message, data) => {
			core.logger.warn(message, data);
		},
	};
	return new OpencodeManager(options);
}

/**
 * A descoberta do catálogo (Fase 4D).
 *
 * O transporte é o mesmo do health (`getJson`): prazo, sem redirecionamento,
 * sem keep-alive. A rota é decidida pelo serviço, sobre a base que o
 * gerenciador validou — a página não informa URL nenhuma.
 */
export function createOpencodeCatalog(
	core: AssembledCore,
	manager: OpencodeManager,
	binary: string | undefined = resolveBinary(),
): OpencodeCatalogService {
	const options: OpencodeCatalogOptions = {
		manager,
		transport: {
			get: (input) =>
				getJson({
					url: input.url,
					authorization: input.authorization,
					timeoutMs: input.timeoutMs,
					maxBytes: input.maxBytes,
				}),
		},
		store: new OpencodeCatalogStore(join(core.root, OPENCODE_CATALOG_FILE)),
		...(binary !== undefined
			? { readCredentials: () => readProviderCredentials({ binary }) }
			: {}),
		log: (message, data) => {
			core.logger.warn(message, data);
		},
	};
	return new OpencodeCatalogService(options);
}
