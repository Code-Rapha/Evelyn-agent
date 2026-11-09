/**
 * A superfície de conversa do serviço (`/api/chat/*`), para o Desktop conectado.
 *
 * ## Por que não usa `/v1`
 *
 * `/v1` é a API compatível com OpenAI: sem estado, sem ferramentas, uma
 * requisição por resposta. A conversa do Evelyn tem histórico persistido,
 * laço de ferramentas e permissões — e o `/v1` não pode ganhar essas coisas
 * sem deixar de ser compatível. São duas superfícies com contratos
 * diferentes, e esta é a da conversa.
 *
 * ## O que ela reutiliza
 *
 * `ChatSession.runExternalTurn` (R4C), que roda o **mesmo** `runTurn` do
 * caminho local: mesmo roteamento, mesmas ferramentas, mesmo orçamento,
 * mesmo consumo. Aqui só existe o transporte.
 *
 * ## Isolamento
 *
 * Cada turno tem o próprio `turnId`, `AbortController`, fila de eventos e
 * broker de permissões. O endpoint não tem estado entre turnos: o mapa de
 * turnos ativos é do **processo** e serve só para encontrar o que cancelar.
 *
 * ## O que nunca sai
 *
 * Credencial, caminho de dados, chave de provedor ou corpo cru de outro
 * sistema. Os eventos são os do agente, e já passaram pela redação do Core.
 */
import type { PermissionAnswer } from '../desktop/contract';
import type { AgentEventSink } from '../desktop/agentTurn';
import type { ChatSession } from '../desktop/chatSession';
import type { TurnRecord, TurnRecordStore } from '../core/storage/turnRecords';
import { TurnRecordCorruptError as Corrupt } from '../core/storage/turnRecords';

/** Um evento enviado ao cliente: o do agente, com o turno em que ocorreu. */
export interface ChatWireEvent {
	readonly type: string;
	readonly turnId: string;
	readonly [key: string]: unknown;
}

/**
 * Quanto o encerramento espera o registro do turno fechar (R4Q).
 *
 * Um `finish` num disco local leva milissegundos; o limite existe para um
 * I/O travado não prender a reserva da conversa até o processo morrer. Ao
 * estourar, o turno fica `running` e a recuperação da próxima inicialização
 * o fecha como `interrupted` — o estado conservador de sempre.
 */
const RECORD_FINISH_TIMEOUT_MS = 5_000;

/** Um turno ativo, do ponto de vista do transporte. */
interface ActiveTurn {
	readonly conversationId: string;
	readonly controller: AbortController;
	/** Enfileira um evento para este turno; `undefined` depois de encerrado. */
	emit: (event: ChatWireEvent) => void;
	readonly done: Promise<void>;
}

/** O resultado de um pedido de turno. */
export type ChatTurnStart =
	| { readonly kind: 'started'; readonly turnId: string; readonly events: AsyncIterable<ChatWireEvent> }
	| {
			readonly kind: 'refused';
			readonly status: number;
			readonly message: string;
			/** Código de máquina, quando o cliente precisa distinguir o motivo. */
			readonly code?: string;
	  };

/** O que o endpoint precisa da sessão. */
export interface ChatHost {
	readonly session: ChatSession;
	/**
	 * O registro durável dos turnos (R4H).
	 *
	 * Ausente em teste que não o quer — o endpoint funciona sem ele, e o
	 * registro deixa de existir. Um host de verdade sempre passa um.
	 */
	readonly turns?: TurnRecordStore;
}

/**
 * Uma conversa, como o cliente conectado a vê (R4D).
 *
 * Deliberadamente menor que o `ConversationListItem` do Core:
 *
 * - **sem `projectId`**: organização interna do Core; a fase não migra
 *   projetos, e o cliente não tem o que fazer com ele;
 * - **sem `providerId`**: id de provedor é configuração do serviço.
 *
 * O `id` é o id persistido — a mesma identidade que o turno da R4C usa.
 */
export interface ChatConversationSummary {
	readonly id: string;
	readonly title: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly messageCount: number;
	/** Permanente: é o diálogo de preferências e não tem lixeira. */
	readonly pinned?: boolean;
}

/** Uma mensagem do histórico que o cliente conectado pode ver. */
export interface ChatConversationMessage {
	readonly role: 'user' | 'assistant';
	readonly content: string;
}

/** O histórico aberto. */
export interface ChatConversationDetail {
	readonly conversation: ChatConversationSummary;
	readonly messages: readonly ChatConversationMessage[];
}

/** A superfície, montada sobre a sessão do Core. */
export class WebChatEndpoint {
	/** Os turnos deste processo, por id. Só para cancelar e responder. */
	private readonly active = new Map<string, ActiveTurn>();
	/**
	 * As conversas com turno em curso (R4Q).
	 *
	 * Um `Set`, e não um contador: a decisão da R4Q é **um turno por
	 * conversa**. A entrada é criada de forma síncrona, antes do primeiro
	 * `await` de `start` — é o que faz duas requisições simultâneas verem a
	 * mesma reserva e só uma seguir. Também é o que a exclusão consulta para
	 * responder `409 conversation_busy`.
	 */
	private readonly busy = new Set<string>();
	private counter = 0;

	constructor(private readonly host: ChatHost) {}

	/**
	 * Quantos turnos em curso há numa conversa (0 ou 1 na R4Q).
	 *
	 * Público para o teste provar que a reserva não fica presa; a interface
	 * não precisa dele.
	 */
	activeTurnsFor(conversationId: string): number {
		return this.busy.has(conversationId) ? 1 : 0;
	}

	/**
	 * Reserva a conversa. `false` quando já havia um turno ativo.
	 *
	 * Síncrono, de propósito: entre a leitura e a escrita não pode haver
	 * suspensão, ou duas requisições reservariam a mesma conversa.
	 */
	private tryEnter(conversationId: string): boolean {
		if (this.busy.has(conversationId)) {
			return false;
		}
		this.busy.add(conversationId);
		return true;
	}

	/**
	 * Desmarca. Chamado em **todos** os caminhos de término do turno —
	 * sucesso, erro, cancelamento, timeout e queda de conexão.
	 *
	 * Idempotente: chamá-lo duas vezes para a mesma conversa não apaga a
	 * reserva de um turno diferente (não há outro, mas a garantia barata é a
	 * que evita o defeito de "libere no fim do primeiro").
	 */
	private leave(conversationId: string): void {
		this.busy.delete(conversationId);
	}

	/**
	 * Inicia um turno.
	 *
	 * A conversa precisa **existir** no Core: a identidade é o id da conversa
	 * persistida, e não um id inventado pelo cliente. Um id desconhecido é
	 * `404` — a alternativa seria criar uma conversa no nome de um cliente
	 * que não pediu por ela.
	 */
	async start(input: {
		readonly conversationId: string;
		readonly providerId: string;
		readonly model: string;
		readonly text: string;
		/** A chave de idempotência do envio (R4Q). Ausente = intenção nova. */
		readonly requestId?: string;
		/**
		 * Como o turno escolhe quem responde (DEV-8.10).
		 *
		 * Ausente = comportamento anterior: o par acima é o destino. O modo
		 * automático é executado pelo **Core deste serviço**, não pelo OpenCode.
		 */
		readonly routing?: 'auto' | 'direct' | 'external';
	}): Promise<ChatTurnStart> {
		// R4G/R4Q: a conversa é reservada **antes do primeiro `await`** e só
		// uma reserva existe por conversa. Duas requisições simultâneas
		// chegam aqui juntas; a segunda encontra a reserva e é recusada sem
		// gravar mensagem, sem criar turno e sem chamar o modelo.
		if (!this.tryEnter(input.conversationId)) {
			return {
				kind: 'refused',
				status: 409,
				message: 'a conversa já tem uma resposta em andamento',
				code: 'conversation_busy',
			};
		}
		let started = false;
		try {
			const conversation = await this.host.session
				.openConversation(input.conversationId)
				.catch(() => undefined);
			if (conversation === undefined) {
				return { kind: 'refused', status: 404, message: 'não há conversa com esse id' };
			}
			this.counter += 1;
			const turnId = `svc-turn-${this.counter}`;
			const controller = new AbortController();
			const queue = new EventQueue<ChatWireEvent>();
			// R4O: a mensagem do usuário vai ao histórico **antes** de o turno
			// ser registrado como `running` e antes de qualquer confirmação.
			// Um cliente que recebe o `started` pode confiar que o texto já
			// está no disco: uma queda imediata do processo não o apaga.
			//
			// A ordem — histórico, depois registro do turno — é a que deixa o
			// pior desfecho parcial documentado: uma mensagem gravada sem
			// turno (o usuário vê o que escreveu; a nova tentativa não duplica,
			// pela guarda de idempotência). A ordem inversa deixaria um turno
			// `running` sem a mensagem, que é o estado que esta fase corrige.
			// As duas gravações são atômicas cada uma, mas **não** transacionais
			// entre si: não presumimos que sejam.
			try {
				const persisted = await this.host.session.persistUserMessage(
					input.conversationId,
					input.text,
					input.requestId,
				);
				// R4Q: a mesma chave já gravada é um envio repetido. A mensagem
				// existe; o modelo **não** roda de novo e o cliente recebe o
				// mesmo turno de antes, se ainda houver um, ou uma confirmação
				// sem execução.
				if (!persisted.persisted) {
					return {
						kind: 'refused',
						status: 409,
						message: 'este envio já foi aceito (mesma chave de idempotência)',
						code: 'duplicate_request',
					};
				}
			} catch (error) {
				// Nada foi confirmado e nenhum turno foi registrado. A mensagem
				// não chegou ao disco, então o cliente precisa saber que o turno
				// **não** começou, em vez de receber um `started` falso.
				//
				// A conversa excluída durante esta gravação é dita como tal: é
				// a mesma mensagem da R4F, usada pelo stream.
				if (/No conversation with id/i.test(error instanceof Error ? error.message : String(error))) {
					return {
						kind: 'refused',
						status: 404,
						message: 'não há conversa com esse id',
					};
				}
				return {
					kind: 'refused',
					status: 500,
					message: 'não foi possível gravar a mensagem na conversa; o turno não foi iniciado',
					code: 'message_not_persisted',
				};
			}
			// R4H: o registro durável do turno, **antes** de a execução começar.
			// Se a gravação falhar, o turno não roda: um turno que executa sem
			// registro deixa a próxima inicialização sem saber que ele existiu,
			// e é justamente esse conhecimento que a recuperação usa.
			const record = this.host.turns;
			if (record !== undefined) {
				try {
					await record.start({ turnId, conversationId: input.conversationId });
				} catch (error) {
					// R4K: o registro corrompido é dito como tal — o cliente
					// precisa saber que o diagnóstico está indisponível para
					// oferecer a recuperação, em vez de "deu erro no chat".
					if (error instanceof Corrupt) {
						return {
							kind: 'refused',
							status: 503,
							message: 'o registro de turnos está corrompido; o turno não foi iniciado',
							code: 'turns_corrupt',
						};
					}
					// R4O: a mensagem **já está** no histórico (a ordem é
					// histórico → registro). O turno não foi confirmado, então
					// nenhum `running` pode ficar no registro: um turno recusado
					// por falha de gravação vira `failed` com o motivo, não um
					// `running` que a próxima inicialização leria como queda.
					// A mensagem persistida não é removida — desfazer uma escrita
					// concluída para simular atomicidade esconderia o fato de que
					// ela aconteceu; e a nova tentativa não a duplica.
					await record
						.finish({ turnId, status: 'failed', reason: 'não foi possível registrar o turno' })
						.catch(() => undefined);
					return {
						kind: 'refused',
						status: 503,
						message: 'não foi possível registrar o turno; ele não foi iniciado',
						code: 'turn_not_recorded',
					};
				}
			}
		// O `started` entra **antes** de o turno começar: é o que ensina o
		// `turnId` a quem lê o stream. O motor também emite o seu `started`
		// (`runAgentTurn`); o do motor é descartado aqui para o cliente não ver
		// dois — e para um turno recusado antes do agente ainda ter um
		// `started`, sem o cliente ficar esperando um que não vem.
		//
		// DEV-8.10: a exceção é o `routing` do motor — o modo e o par efetivos
		// que o modelo escolheu no automático. Descartar isso deixaria o cliente
		// conectado mostrando "automático" sem dizer quem respondeu.
		queue.push({ type: 'started', turnId });

		const sink: AgentEventSink = (event) => {
			if (event.type === 'started') {
				const routing = (event as { readonly routing?: unknown }).routing;
				if (routing !== undefined) {
					queue.push({
						type: 'started',
						turnId,
						routing,
					});
				}
				return;
			}
			// R4F: a conversa pode ter sido excluída durante o turno. O store
			// recusa gravar numa conversa ausente e a mensagem dele nomeia o
			// id do arquivo; o cliente recebe o que aconteceu. A falha vem do
			// `storeRound` do agente, não do `runTurn`, então é aqui — por onde
			// todo evento do turno passa — que ela é traduzida.
			if (event.type === 'error' && /No conversation with id/i.test(event.message)) {
				queue.push({
					type: 'error',
					turnId,
					message:
						'a conversa foi excluída durante o turno: a resposta não foi gravada e nada foi recriado',
				});
				return;
			}
			// O evento do agente já traz `turnId`; o transporte o reafirma para
			// um cliente que multiplexa não atribuir ao turno errado.
			const wire: ChatWireEvent = { ...(event as unknown as Record<string, unknown>), type: event.type, turnId };
			queue.push(wire);
			// Uma conversa permanente é a fonte das preferências de modelo: o
			// que a Evelyn respondeu nela é o registro que a seleção consulta.
			// Absorver no processo que executa o turno, e não na interface, faz
			// o texto gravado ser o que de fato foi dito — e vale mesmo para um
			// cliente conectado que não conhece o diálogo.
			if (event.type === 'done' && event.reason === 'answered') {
				void this.absorbGuidance(input.conversationId, event.content);
			}
		};

		// R4H: o desfecho do turno, para o registro. O evento terminal é a
		// evidência mais direta: `done` com razão `answered` é conclusão;
		// `done` com `aborted` é cancelamento; `error` é falha. Sem terminal
		// (a conexão caiu e o turno foi abortado), o desfecho é "cancelado".
		let outcome: { readonly status: 'completed' | 'failed' | 'cancelled'; readonly reason?: string } | undefined;
		const done = this.host.session
			.runExternalTurn({
				conversationId: input.conversationId,
				providerId: input.providerId,
				model: input.model,
				text: input.text,
				turnId,
				controller,
				...(input.routing !== undefined ? { routing: input.routing } : {}),
				sink: (event) => {
					if (event.type === 'done') {
						outcome =
							event.reason === 'answered'
								? { status: 'completed' }
								: {
										status: 'cancelled',
										reason: `o turno terminou sem resposta: ${event.reason}`,
									};
					} else if (event.type === 'error') {
						outcome = { status: 'failed', reason: 'o turno falhou' };
					}
					sink(event);
				},
			})
			.catch((error: unknown) => {
				outcome ??= { status: 'failed', reason: 'o turno falhou' };
				sink({
					type: 'error',
					turnId,
					message: error instanceof Error ? error.message : String(error),
				} as never);
			})
			.finally(async () => {
				this.active.delete(turnId);
				// R4H/R4Q: o registro durável fecha **antes** de a reserva ser
				// liberada e de a fila do stream ser fechada. Antes, o
				// `recordOutcome` era disparado sem `await`, e um processo que
				// morresse nessa janela deixava um turno já terminado como
				// `running` — que a próxima inicialização lia como queda.
				//
				// Sem terminal conhecido, `cancelled`: o turno parou sem dizer
				// como, e chamar isso de `completed` seria afirmar uma resposta
				// que ninguém viu terminar.
				await this.awaitRecordOutcome(
					turnId,
					outcome ?? { status: 'cancelled', reason: 'o turno foi interrompido' },
				);
				// R4Q: a reserva é liberada uma vez, por último. Quem consulta
				// `busy` depois disto já pode aceitar outro turno — e o
				// registro do anterior está no disco.
				this.leave(input.conversationId);
				queue.close();
			});

			this.active.set(turnId, {
				conversationId: input.conversationId,
				controller,
				emit: (event) => queue.push(event),
				done,
			});
			// O `started` já entrou nesta fila, antes do turno — e é o único.
			started = true;

			return { kind: 'started', turnId, events: queue.iterate() };
		} finally {
			// A marcação só é desfeita aqui quando o turno **não** começou (id
			// inexistente, ou uma exceção ao montar o turno). Se começou, quem
			// libera é o `finally` da promessa do turno — liberar agora tiraria
			// a proteção durante a execução inteira.
			if (!started) {
				this.leave(input.conversationId);
			}
		}
	}

	/**
	 * Cancela um turno.
	 *
	 * Só o turno nomeado. `false` quando ele não está ativo — já terminou, ou
	 * nunca existiu; o chamador responde ao cliente que não havia nada a
	 * cancelar, em vez de fingir que cancelou.
	 */
	cancel(turnId: string): boolean {
		const turn = this.active.get(turnId);
		if (turn === undefined) {
			return false;
		}
		turn.controller.abort();
		return true;
	}

	/** Responde uma permissão **de um turno** deste processo. */
	answer(turnId: string, answer: PermissionAnswer): boolean {
		if (!this.active.has(turnId)) {
			return false;
		}
		return this.host.session.answerExternalTurn(turnId, answer);
	}

	/**
	 * As conversas do serviço (R4D).
	 *
	 * Leitura pura do `FileDataStore`: listar não altera nada. A lista é o que
	 * o Core conhece — nenhum caminho de arquivo é aceito nem devolvido.
	 */
	async listConversations(): Promise<readonly ChatConversationSummary[]> {
		const items = await this.host.session.listConversationsForClient();
		// A marca viaja junto com o resumo: é ela que diz ao cliente qual
		// conversa é o diálogo de preferências — e, por isso, sem lixeira.
		const full = await this.host.session.listConversations();
		const pinned = new Set(full.filter((item) => item.pinned === true).map((item) => item.id));
		return items.map((item) => (pinned.has(item.id) ? { ...item, pinned: true } : item));
	}

	/**
	 * Uma conversa e seu histórico (R4D).
	 *
	 * O id é o persistido; um id que não existe é `undefined`, e o servidor
	 * responde `404`. Nenhum id de outra conversa pode alcançar as mensagens
	 * desta: a busca é por chave exata no store, não por prefixo nem por
	 * índice.
	 */
	async openConversation(conversationId: string): Promise<ChatConversationDetail | undefined> {
		return await this.host.session.openConversationForClient(conversationId);
	}

	/**
	 * Cria uma conversa (R4E).
	 *
	 * Usa o **mesmo** `ChatSession.createConversation` do modo local: a
	 * validação de provedor, o clock do Core, a gravação no `FileDataStore` e
	 * o título padrão são os de lá. Nada de um segundo caminho de criação.
	 *
	 * ## O que não vem do cliente
	 *
	 * - **`projectId`**: dá às ferramentas um diretório. Um cliente remoto não
	 *   escolhe onde as ferramentas escrevem neste processo.
	 * - **`systemPrompt`**: é instrução privada. O serviço a mantém; o cliente
	 *   conectado nem a lê (R4D), então também não a escreve.
	 * - **`id`** e qualquer caminho: o id nasce no store.
	 *
	 * Provedor desconhecido é recusado pelo Core; aqui a recusa vira `400`
	 * com uma mensagem própria, para a mensagem interna do Core não sair.
	 */
	async createConversation(input: {
		readonly providerId: string;
		readonly title?: string;
	}): Promise<
		| { readonly kind: 'created'; readonly conversation: ChatConversationSummary }
		| { readonly kind: 'refused'; readonly message: string }
	> {
		try {
			const created = await this.host.session.createConversation({
				providerId: input.providerId,
				...(input.title !== undefined && input.title.trim().length > 0
					? { title: input.title.trim() }
					: {}),
			});
			return {
				kind: 'created',
				conversation: {
					id: created.summary.id,
					title: created.summary.title,
					createdAt: created.summary.createdAt,
					updatedAt: created.summary.updatedAt,
					messageCount: created.summary.messageCount,
				},
			};
		} catch {
			// A causa é do provedor (inexistente) ou do disco. O cliente não
			// precisa — nem deve — receber o caminho de uma das duas.
			return {
				kind: 'refused',
				message: 'não foi possível criar a conversa com esse provedor',
			};
		}
	}

	/**
	 * Renomeia uma conversa (R4F).
	 *
	 * Usa `ChatSession.renameConversation`, que valida o título no próprio
	 * store (`requireText`) e grava na fila de escrita. A resposta é o resumo
	 * que o cliente conectado vê — sem `projectId`/`providerId`.
	 */
	async renameConversation(
		conversationId: string,
		title: string,
	): Promise<
		| { readonly kind: 'renamed'; readonly conversation: ChatConversationSummary }
		| { readonly kind: 'missing' }
		| { readonly kind: 'invalid'; readonly message: string }
	> {
		if (title.trim().length === 0) {
			return { kind: 'invalid', message: 'o título não pode ficar vazio' };
		}
		try {
			const renamed = await this.host.session.renameConversation(conversationId, title.trim());
			return {
				kind: 'renamed',
				conversation: {
					id: renamed.id,
					title: renamed.title,
					createdAt: renamed.createdAt,
					updatedAt: renamed.updatedAt,
					messageCount: renamed.messageCount,
				},
			};
		} catch (error) {
			// O store distingue os dois casos: título recusado (validação) e
			// conversa ausente (StorageError de "não existe"). A mensagem
			// interna não sai — ela carrega o id e o caminho do arquivo.
			const message = error instanceof Error ? error.message : String(error);
			if (/No conversation with id/.test(message)) {
				return { kind: 'missing' };
			}
			return { kind: 'invalid', message: 'o título não é aceito' };
		}
	}

	/**
	 * Exclui uma conversa (R4F), desde que não haja turno em curso (R4G).
	 *
	 * ## A ordem, e por que ela basta
	 *
	 * A conferência de `busy` e a chamada ao store acontecem **no mesmo trecho
	 * síncrono** — nenhum `await` entre elas. Como o registro do turno em
	 * `start` também é síncrono e anterior ao primeiro `await` daquele método,
	 * a corrida tem exatamente dois desfechos possíveis:
	 *
	 * - o turno se registrou primeiro → esta chamada vê `busy > 0` e recusa
	 *   sem tocar no arquivo;
	 * - a exclusão chegou primeiro → apaga, e o `start` falha no
	 *   `openConversation` porque a conversa já não existe.
	 *
	 * Não existe o terceiro caso ("excluiu enquanto o turno começava"), que é
	 * o defeito da R4F. Um lock não ajudaria aqui: não há recurso a manter
	 * entre operações, só uma transição de estado que precisa ser anterior ao
	 * primeiro ponto de suspensão.
	 *
	 * ## A recusa não altera nada
	 *
	 * `busy` é lido e a função retorna antes de qualquer escrita: a conversa,
	 * o histórico e o turno continuam como estavam.
	 *
	 * ## Ausência depois da conferência é sucesso (R4M)
	 *
	 * O store responde `false` quando a conversa não está na lista — e isso
	 * tem três origens que **não se distinguem** por esse valor:
	 *
	 * 1. outra exclusão, concorrente ou anterior, **já removeu** a conversa
	 *    (o estado desejado foi alcançado);
	 * 2. o id nunca existiu (a tela pediu para excluir algo que não está lá);
	 * 3. a recarga da lista falhou ou não corresponde aos arquivos (o store
	 *    marca "não confirmado" — ver `ConversationDeleteOutcome`).
	 *
	 * O caso 1 é o que fazia duas exclusões simultâneas darem `200` e `404`
	 * aleatórios — uma corrida de desfecho, não um dado. O caso 3 **não** é
	 * ausência: um erro de leitura do diretório é `unknown`, e sobe como
	 * falha em vez de virar "já não existia". Um erro de **remoção** já sobe
	 * do store como `StorageError` e nunca chega aqui como `false`.
	 */
	async deleteConversation(
		conversationId: string,
	): Promise<'deleted' | 'already-absent' | 'unknown' | 'busy'> {
		if (this.busy.has(conversationId)) {
			return 'busy';
		}
		const outcome = await this.host.session.deleteConversation(conversationId);
		// Só o nome muda entre as camadas: `absent` no store é
		// `already-absent` aqui, onde a palavra diz o que o cliente precisa
		// saber (a exclusão já aconteceu, por outra via).
		return outcome === 'absent' ? 'already-absent' : outcome;
	}

	/**
	 * Grava a resposta de uma conversa permanente como preferências de modelo.
	 *
	 * Só age se a conversa for a permanente, e só quando há onde gravar. Uma
	 * falha é engolida, com o motivo no log: a resposta do turno já chegou ao
	 * cliente, e uma preferência que não foi gravada apenas não vale no turno
	 * seguinte — ela não pode virar um erro na conversa.
	 */
	private async absorbGuidance(conversationId: string, content: string): Promise<void> {
		const session = this.host.session;
		if (typeof session.recordModelGuidance !== 'function' || content.trim().length === 0) {
			return;
		}
		try {
			const opened = await session.openConversation(conversationId);
			if (opened.summary.pinned !== true) {
				return;
			}
			await session.recordModelGuidance(conversationId, content);
		} catch (error) {
			console.warn(
				`[evelyn] preferências de modelo não gravadas: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/**
	 * Fecha o registro durável de um turno (R4H).
	 *
	 * Uma falha aqui é **engolida**: o turno já entregou (ou já falhou) o que
	 * tinha para entregar, e perder um registro de estado não pode virar um
	 * erro visível ao cliente. A consequência é honesta e conhecida — o turno
	 * fica `running` e a próxima inicialização o marca `interrupted`, que é a
	 * leitura conservadora certa para "não sabemos se terminou".
	 */
	private async recordOutcome(
		turnId: string,
		outcome: { readonly status: 'completed' | 'failed' | 'cancelled'; readonly reason?: string },
	): Promise<void> {
		const record = this.host.turns;
		if (record === undefined) {
			return;
		}
		await record
			.finish({
				turnId,
				status: outcome.status,
				...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
			})
			.catch(() => undefined);
	}

	/**
	 * Aguarda o `recordOutcome` com um limite (R4Q).
	 *
	 * O `finish` toca o disco; num sistema com I/O travado ele pode não
	 * voltar. Esperar para sempre faria um turno já encerrado segurar a
	 * reserva da conversa até o processo morrer — trocar um estado errado por
	 * uma conversa presa é pior. O limite é o mesmo do `writeFileAtomic`
	 * somado à fila: generoso para um disco lento, curto para não prender.
	 * Estourar o limite **não** é silencioso: fica no log, e a recuperação
	 * (R4H) fecha o `running` que sobrou como interrompido.
	 */
	private async awaitRecordOutcome(
		turnId: string,
		outcome: { readonly status: 'completed' | 'failed' | 'cancelled'; readonly reason?: string },
	): Promise<void> {
		const timer = new Promise<'timeout'>((resolve) => {
			const handle = setTimeout(() => resolve('timeout'), RECORD_FINISH_TIMEOUT_MS);
			handle.unref?.();
		});
		const finished = await Promise.race([this.recordOutcome(turnId, outcome).then(() => 'done' as const), timer]);
		if (finished === 'timeout') {
			// Sem logger no host, o aviso vai para o stderr com o mesmo prefixo
			// do app — não some, e não inventa um canal.
			console.warn(
				`[evelyn] o registro do turno ${turnId} não fechou em ${RECORD_FINISH_TIMEOUT_MS}ms; a recuperação o tratará`,
			);
		}
	}

	/**
	 * O estado dos turnos de uma conversa (R4H, R4K).
	 *
	 * ## Por que agora é um resultado, e não uma lista
	 *
	 * Antes, uma falha de leitura virava `[]` — e a interface lia isso como
	 * "não há turnos", que é uma afirmação que o serviço não pode fazer sobre
	 * um arquivo que não leu. Agora há três respostas distintas:
	 *
	 * - `ok` com a lista (que pode ser vazia — é um fato);
	 * - `unavailable` com o motivo (o arquivo não serve).
	 *
	 * A conversa continua abrindo nos dois casos: a nota de "turno
	 * interrompido" é informação adicional, não pré-requisito.
	 */
	async turnStates(conversationId: string): Promise<
		| { readonly status: 'ok'; readonly turns: readonly TurnRecord[] }
		| { readonly status: 'unavailable'; readonly reason: string }
	> {
		const record = this.host.turns;
		if (record === undefined) {
			return { status: 'ok', turns: [] };
		}
		try {
			return { status: 'ok', turns: await record.forConversation(conversationId) };
		} catch (error) {
			// Só a classe da falha sai daqui: a mensagem de I/O carrega caminho.
			const reason =
				error instanceof Corrupt ? error.reason : 'o registro de turnos não pôde ser lido';
			return { status: 'unavailable', reason };
		}
	}

	/** Quantos turnos estão ativos — para o health e para os testes. */
	get activeCount(): number {
		return this.active.size;
	}
}

/**
 * Uma fila assíncrona por turno.
 *
 * Cada consumidor tem a sua: dois turnos nunca dividem eventos. Um consumidor
 * que desiste (conexão fechada) faz `close()`, e o produtor para de acumular.
 */
export class EventQueue<T> {
	private readonly items: T[] = [];
	private waiter: (() => void) | undefined;
	private closed = false;
	private failure: unknown;

	push(item: T): void {
		if (this.closed) {
			return;
		}
		this.items.push(item);
		this.waiter?.();
		this.waiter = undefined;
	}

	/** Encerra a fila: o consumidor recebe o fim depois do que já havia. */
	close(): void {
		this.closed = true;
		this.waiter?.();
		this.waiter = undefined;
	}

	/** Falha explícita, para o consumidor ver a causa em vez de um fim mudo. */
	fail(error: unknown): void {
		this.failure = error;
		this.close();
	}

	async *iterate(): AsyncGenerator<T> {
		for (;;) {
			const next = this.items.shift();
			if (next !== undefined) {
				yield next;
				continue;
			}
			if (this.failure !== undefined) {
				throw this.failure;
			}
			if (this.closed) {
				return;
			}
			await new Promise<void>((resolve) => {
				this.waiter = resolve;
			});
		}
	}
}
