/**
 * O host do servidor local: processa a linha de comando e sobe o servidor.
 *
 * ## A raiz, antes de tudo
 *
 * Este host pede a raiz de dados com `mountCore`, a **mesma** regra que o
 * Electron usa. Quem não consegue a raiz não monta o Core; e é a montagem
 * que abre os arquivos.
 *
 * ## Se a raiz estiver ocupada
 *
 * O servidor continua no ar e responde ao health com `coreMounted: false` —
 * a recusa é dita no terminal e na página. Derrubar o servidor por causa da
 * raiz deixaria o operador sem a única coisa que ele abriu para ver: o
 * estado.
 *
 * ## O catálogo do OpenCode
 *
 * A descoberta nasce junto com o gerenciador, no host que tem a raiz — é
 * nela que o catálogo é gravado. As rotas de leitura e de atualização passam
 * a existir junto com o gerenciador.
 *
 * ## O processo do OpenCode
 *
 * Quem inicia e encerra processo é o host que tem a raiz — este, ou o
 * Electron. Ter dois hosts gerenciando o mesmo servidor seria ter dois
 * processos para a mesma conexão. O gerenciador nasce aqui junto com o Core e
 * morre com ele (`dispose`): o processo gerenciado é encerrado no
 * `close()`, e o servidor manual não é tocado.
 *
 * ## As opções
 *
 * - `--root <pasta>`: a raiz dos dados. Padrão: a mesma do desktop;
 * - `--port <n>`: a porta em `127.0.0.1`. Padrão: `7817`;
 * - `--app <caminho>`: a pasta com os assets da página web.
 */
import { defaultDataStoreRoot } from '../../adapters/local/fileDataStore';
import { randomBytes } from 'node:crypto';
import { mountCore } from '../../app/mount';
import type { AssembledCore } from '../../app/assemble';
import { createOpencodeCatalog, createOpencodeConversationStore, createOpencodeManager } from '../../app/opencodeFactory';
import { OpencodeChatController } from '../../web/opencodeChat';
import { buildOpenAiEndpoint } from '../../web/openaiEndpoint';
import { WebChatEndpoint } from '../../web/chatEndpoint';
import { TurnRecordStore, TurnRecordCorruptError } from '../../core/storage/turnRecords';
import {
	PROTOCOL_VERSION,
	clearInvalidServiceRecord,
	processIdentity,
	readServiceRecord,
	removeServiceRecord,
	writeServiceRecord,
} from '../../app/serviceRecord';
import type { OpencodeManager } from '../../app/opencodeManager';
import type { OpencodeCatalogService } from '../../app/opencodeCatalogService';
import { startWebServer, type RunningWebServer } from '../../web/server';

/** O que o host precisa para subir. */
export interface WebHostOptions {
	readonly rootPath?: string;
	readonly port?: number;
	readonly assetsDir: string;
	readonly version: string;
	/**
	 * O que fazer quando alguém pedir, por HTTP autenticado, para encerrar.
	 *
	 * A CLI mora em `web/main.ts`, que chama `startWebHost`; fechar turnos,
	 * liberar o lock e sair é dela. Esta opção é o gancho entre a rota e aquele
	 * encerramento — sem ele, a rota responde `404`.
	 */
	readonly requestShutdown?: () => void;
}

/** O host no ar, pronto para ser encerrado. */
export interface RunningWebHost {
	readonly server: RunningWebServer;
	/** A raiz que este host tentou tomar. */
	readonly rootPath: string;
	/** Por que a raiz não foi tomada, quando não foi. */
	readonly storageNote?: string;
	close(): Promise<void>;
}

/** O nome deste host na trava. */
export const WEB_HOST_NAME = 'web';

/**
 * Sobe a superfície `/v1`, se houver ao menos uma chave de cliente.
 *
 * Um arquivo de chaves **corrompido** não derruba o host nem sobe a API
 * aberta: a superfície sobe e recusa tudo com `503`, dizendo o motivo. Subir
 * sem ela esconderia a falha; subir sem verificar aceitaria qualquer chave.
 */
async function mountOpenAi(core: AssembledCore): Promise<ReturnType<typeof buildOpenAiEndpoint> | undefined> {
	let endpoint: ReturnType<typeof buildOpenAiEndpoint>;
	try {
		endpoint = buildOpenAiEndpoint({
			core,
			chat: core.chat,
			onFailure: (error, context) =>
				core.logger.warn('Falha ao atender a API de clientes', {
					phase: context.phase,
					error: error instanceof Error ? error.message : String(error),
				}),
		});
	} catch (error) {
		core.logger.warn('A API de clientes não pôde ser montada', {
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
	try {
		const keys = await endpoint.keys.list();
		const clients = keys.filter((key) => key.scopes.includes('client'));
		if (clients.length === 0) {
			core.logger.info('API de clientes desligada: nenhuma chave de cliente configurada');
			return undefined;
		}
		core.logger.info('API de clientes ligada', { keys: clients.length });
		return endpoint;
	} catch (error) {
		// Arquivo ilegível: a API sobe e recusa com 503, para o operador ver
		// que ela existe e por que não aceita.
		core.logger.warn('O arquivo de chaves da API não pôde ser lido; a API recusará toda chave', {
			error: error instanceof Error ? error.message : String(error),
		});
		return endpoint;
	}
}

/**
 * Sobe o servidor e monta o Core, na ordem que a regra manda.
 *
 * A receita do Electron e a deste host é a mesma (`mountCore`): travar,
 * montar, e soltar o que não subiu. A diferença é só o que fazer com a
 * recusa — o Electron encerra com uma mensagem; aqui, o servidor sobe sem
 * Core e diz por quê.
 */
export async function startWebHost(options: WebHostOptions): Promise<RunningWebHost> {
	const rootPath = options.rootPath ?? defaultDataStoreRoot();
	const mount = await mountCore({
		host: WEB_HOST_NAME,
		name: 'Evelyn (servidor local)',
		rootPath,
		logScope: 'seshyina.web',
	});	const core = mount.kind === 'mounted' ? mount.core : undefined;
	const storageNote = mount.kind === 'mounted' ? undefined : mount.message;

	/**
	 * Um registro de um serviço que morreu sem limpar.
	 *
	 * Quem tomou a raiz agora é este processo, então um `service.json`
	 * apontando para outro pid é lixo: deixá-lo faria o Electron ler um
	 * pid morto até a primeira gravação. Só é apagado quando **nós** temos a
	 * raiz — um host sem Core não toca em arquivo de dados.
	 */
	if (mount.kind === 'mounted') {
		const previous = await readServiceRecord(rootPath);
		if (previous.kind === 'ok' && previous.record.pid !== process.pid) {
			const identity = await processIdentity(previous.record.pid);
			if (identity.kind === 'dead') {
				await removeServiceRecord(rootPath, previous.record.pid).catch(() => undefined);
			}
		} else if (previous.kind === 'invalid') {
			// Um registro ilegível vira "nenhum serviço": quem procura não pode
			// ser induzido a confiar em lixo.
			await clearInvalidServiceRecord(rootPath).catch(() => undefined);
		}
	}

	// O gerenciador só existe onde há raiz: é nela que o registro mora, e é
	// este host que tem um processo para encerrar.
	let opencode: OpencodeManager | undefined;
	let opencodeCatalog: OpencodeCatalogService | undefined;
	let opencodeChat: OpencodeChatController | undefined;
	/**
	 * A superfície `/v1`, quando há ao menos uma chave de cliente.
	 *
	 * Só sobe com chave configurada: expor chat a quem nunca criou uma
	 * credencial seria abrir uma porta que ninguém pediu para abrir. O
	 * arquivo de chaves é lido uma vez no arranque; criar uma chave depois
	 * exige reiniciar o host (a interface de gestão é uma etapa seguinte).
	 */
	let openai: ReturnType<typeof buildOpenAiEndpoint> | undefined;
	/** A conversa do Desktop conectado (R4C). Só existe com Core montado. */
	let chat: WebChatEndpoint | undefined;
	/** O registro de turnos (R4H/R4I/R4J). Só existe com Core montado. */
	let turns: TurnRecordStore | undefined;
	if (core !== undefined) {
		opencode = createOpencodeManager(core);
		// A descoberta usa a conexão do gerenciador: ela não abre conexão
		// própria nem aceita endereço da página.
		opencodeCatalog = createOpencodeCatalog(core, opencode);
		// As conversas usam a conexão e o catálogo, e persistem no mesmo
		// `FileDataStore` do Core: a página não escolhe servidor.
		opencodeChat = new OpencodeChatController(
			opencode,
			opencodeCatalog,
			createOpencodeConversationStore(core),
		);
		// A restauração começa com o host, sem depender da primeira visita à
		// página: as sessões restauradas são verificadas uma vez, no início.
		void opencodeChat.restoreOnce();
		openai = await mountOpenAi(core);
		// A conversa usa a **mesma** `ChatSession` do host: mesmo motor, mesmo
		// roteamento, mesmas ferramentas. Nada de um segundo agente.
		//
		// R4H: o registro de turnos é recuperado **aqui**, antes de o servidor
		// aceitar pedidos. Um turno que ficou `running` é de um processo que
		// morreu — este acabou de nascer. Recolhê-lo agora é o que impede a
		// interface de mostrar para sempre uma resposta "em curso" que nunca
		// vai chegar, e é o que libera o bloqueio de exclusão da R4G.
		turns = new TurnRecordStore({ root: core.root });
		try {
			// R4I: recuperar **antes** de reter. Um `running` vira `interrupted`
			// — estado terminal, com `finishedAt` de agora — e só então a
			// retenção o considera. Invertendo a ordem, o turno interrompido não
			// seria terminal e o resultado mudaria.
			const recovery = await turns.recover();
			if (recovery.interrupted > 0) {
				core.logger.info('Turnos interrompidos pelo encerramento anterior', {
					interrupted: recovery.interrupted,
				});
			}
			for (const note of recovery.unreadable) {
				core.logger.warn('Registro de turnos ilegível', { note });
			}
			// A limpeza é manutenção: uma falha nela não pode impedir o serviço
			// de subir. O arquivo anterior fica intacto (`writeFileAtomic`), e o
			// motivo vai para o log.
			try {
				const retention = await turns.retain();
				if (retention.removedByAge > 0 || retention.removedByCount > 0) {
					core.logger.info('Registro de turnos antigos limpo', {
						removedByAge: retention.removedByAge,
						removedByCount: retention.removedByCount,
						kept: retention.kept,
					});
				}
			} catch (error) {
				core.logger.warn('Não foi possível aplicar a retenção do registro de turnos', {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		} catch (error) {
			// A recuperação falhar não impede o serviço de subir: o histórico
			// das conversas é outro arquivo e continua íntegro. O que se perde
			// é a contabilidade de estado dos turnos antigos.
			//
			// R4K: **nada foi escrito** sobre o registro. Corrompido é o caso
			// esperado — o arquivo fica como está, esperando a decisão do
			// operador na tela de diagnóstico. Uma falha de I/O é outra coisa, e
			// o log tem de dizer qual das duas foi.
			core.logger.warn(
				error instanceof TurnRecordCorruptError
					? 'O registro de turnos está corrompido; o diagnóstico fica indisponível até a recuperação'
					: 'Não foi possível recuperar o registro de turnos',
				{
					// O motivo é de classe: o caminho do arquivo não entra no log
					// por aqui (o erro do SO, se houver, é que o carregaria).
					reason: error instanceof TurnRecordCorruptError ? error.reason : undefined,
					error: error instanceof Error ? error.message : String(error),
				},
			);
		}
		chat = new WebChatEndpoint({ session: core.chat, turns });
	}

	try {
		/**
		 * O token de leitura deste processo.
		 *
		 * Gerado aqui, separado do token do painel (que o servidor cria), e
		 * entregue a ele para validação. Ele vale só em leitura; é o que o
		 * `desktop-host` usa para consultar saúde e catálogo.
		 */
		const readerToken = randomBytes(32).toString('hex');
		/**
		 * O token de **conversa** (R4C).
		 *
		 * Executa turnos e responde permissões; não administra. Separado dos
		 * outros dois pelo mesmo motivo: cada cliente recebe o menor poder
		 * que resolve o seu trabalho.
		 */
		const chatToken = randomBytes(32).toString('hex');
		const server = await startWebServer({
			version: options.version,
			assetsDir: options.assetsDir,
			readerToken,
			chatToken,
			...(chat !== undefined ? { chat } : {}),
			...(core !== undefined ? { core } : {}),
			...(core !== undefined ? { storageHost: WEB_HOST_NAME } : {}),
			...(opencode !== undefined ? { opencode } : {}),
			...(opencodeCatalog !== undefined ? { opencodeCatalog } : {}),
			...(opencodeChat !== undefined ? { opencodeChat } : {}),
			// R4J: o mesmo registro que o endpoint de conversa usa — já
			// recuperado e retido aqui em cima.
			...(turns !== undefined ? { turns } : {}),
			// Só quem é dono da raiz pode ser pedido a encerrar: um servidor
			// sem Core é um processo que já não tem nada a proteger.
			...(mount.kind === 'mounted' && options.requestShutdown !== undefined
				? { requestShutdown: options.requestShutdown }
				: {}),
			...(openai !== undefined
				? {
						openai: {
							authenticate: openai.authenticate,
							runtime: openai.runtime,
							listModels: openai.listModels,
						},
					}
				: {}),
			...(options.port !== undefined ? { port: options.port } : {}),
		});
		/**
		 * O registro de descoberta, **só** quando este processo é o dono da raiz.
		 *
		 * Quem não montou o Core não é dono de nada: gravar o registro ali
		 * faria o Electron tratar um servidor sem Core como o serviço.
		 */
		let published = false;
		if (mount.kind === 'mounted') {
			try {
				await writeServiceRecord(rootPath, {
					version: 1,
					protocol: PROTOCOL_VERSION,
					pid: process.pid,
					port: server.port,
					startedAt: new Date().toISOString(),
					appVersion: options.version,
					token: server.token,
					readerToken,
					chatToken,
					address: '127.0.0.1',
				});
				published = true;
			} catch (error) {
				// Sem registro, o Electron não descobre este serviço — mas o
				// serviço continua atendendo o painel e `/v1`. É dito, não fatal.
				core?.logger.warn('Não foi possível publicar o registro do serviço', {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return {
			server,
			rootPath,
			...(storageNote !== undefined ? { storageNote } : {}),
			async close(): Promise<void> {
				// O registro sai **antes** de o Core cair: um cliente que
				// perguntar durante o encerramento vê "não existe", em vez de um
				// registro apontando para um processo que já não atende.
				if (published) {
					await removeServiceRecord(rootPath, process.pid).catch(() => undefined);
				}
				// Os turnos primeiro (eles usam o processo), depois o processo:
				// ele não deve sobreviver ao host que o iniciou.
				opencodeChat?.dispose();
				opencode?.dispose();
				await server.close();
				if (mount.kind === 'mounted') {
					await mount.release();
				}
			},
		};
	} catch (error) {
		// O servidor não subiu: a raiz volta, para o próximo host poder entrar.
		opencode?.dispose();
		if (mount.kind === 'mounted') {
			await mount.release();
		}
		throw error;
	}
}
