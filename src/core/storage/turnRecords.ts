/**
 * O registro durável dos turnos do serviço.
 *
 * ## Por que um arquivo próprio, e não o ledger de consumo
 *
 * O ledger (`consumption.json`) registra **custo**: ele é escrito quando a
 * rota termina, com estados de contabilidade (`success`, `failure`,
 * `cancelled`, `timeout`). Um turno em curso não existe nele — logo, um
 * processo que cai no meio de uma resposta não deixa nada para recuperar.
 *
 * Este arquivo registra **ciclo de vida**, e é escrito no início. É a
 * diferença entre "quanto isto custou" e "isto ainda estava rodando?".
 *
 * ## O que ele nunca guarda
 *
 * Nem prompt, nem resposta, nem token, nem caminho de arquivo. Guarda a
 * identidade do turno, a conversa, o estado e as datas — o suficiente para
 * dizer, depois de uma queda, que uma resposta ficou pela metade. O conteúdo
 * que importa já está no histórico da conversa, e é de lá que a interface o
 * lê.
 *
 * ## Estados
 *
 * ```
 *          start()
 *  (nada) ─────────► running
 * running ── done ──► completed
 * running ── erro ──► failed
 * running ── parar ─► cancelled
 * running ── queda ─► interrupted    (só na recuperação)
 * ```
 *
 * Um estado terminal nunca volta a `running`: o turno de um cliente é um só,
 * e reaproveitar um id faria dois turnos disputarem o mesmo registro.
 *
 * ## Escrita
 *
 * Atômica (`writeFileAtomic`) e serializada por uma fila, como os outros
 * stores. A gravação **não pode** bloquear o turno: uma falha de disco é
 * reportada ao chamador e o turno segue, porque perder um registro não pode
 * apagar uma resposta que já foi entregue.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { writeFileAtomic } from '../../adapters/local/writeFileAtomic';
import type { WritePort } from '../../adapters/local/writePort';

/** O nome do arquivo, na raiz de dados. */
export const TURNS_FILE = 'turns.json';

/** A forma do arquivo. */
const FORMAT_VERSION = 1;

/**
 * Quantos turnos terminais o arquivo mantém.
 *
 * Sem teto, o registro cresceria para sempre: um turno por mensagem, em uma
 * instalação antiga, é um arquivo de megabytes que só serve para dizer o que
 * já acabou. Os terminais antigos saem; os `running` **nunca** são descartados
 * por tamanho — é deles que a recuperação depende.
 */
const MAX_TERMINAL_TURNS = 500;

/**
 * Por quanto tempo um turno terminal é guardado (R4I).
 *
 * Trinta dias é o horizonte em que "o que aconteceu nesta conversa" ainda tem
 * chance de ser consultado. Depois disso, o registro de estado só ocupa
 * espaço — o histórico da conversa continua no arquivo dela, intacto.
 */
export const TURN_RETENTION_DAYS = 30;

/** Em que ponto do ciclo o turno está. */
export type TurnRecordStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

/** Um turno, como o registro o guarda. */
export interface TurnRecord {
	readonly turnId: string;
	readonly conversationId: string;
	readonly status: TurnRecordStatus;
	/** Quando o turno foi aceito (ISO-8601). */
	readonly startedAt: string;
	/** Quando ele terminou; ausente enquanto `running`. */
	readonly finishedAt?: string;
	/**
	 * Por que ele terminou, quando se sabe.
	 *
	 * Texto curto e **de classe** — "timeout", "o provedor recusou", "parado
	 * pelo cliente" —, nunca o conteúdo do turno nem uma mensagem de provedor
	 * que possa carregar dado do usuário.
	 */
	readonly reason?: string;
}

/** O que `recover` encontrou. */
export interface TurnRecoveryReport {
	/** Quantos ficaram `running` e viraram `interrupted`. */
	readonly interrupted: number;
	/** Registros que não puderam ser lidos — ditos, não apagados em silêncio. */
	readonly unreadable: readonly string[];
	/** Os turnos interrompidos, para a interface poder dizer quais foram. */
	readonly turns: readonly TurnRecord[];
}

/** O que o store precisa. */
export interface TurnRecordStoreOptions {
	/** A raiz de dados. */
	readonly root: string;
	readonly now?: () => Date;
	/**
	 * Como gravar `turns.json` (R4Q). Padrão: `writeFileAtomic`.
	 *
	 * Injetável para um teste provar a falha de gravação sem que o store
	 * carregue um mecanismo de injeção — ver `writePort.ts`.
	 */
	readonly writeFile?: WritePort;
}

/**
 * O estado do arquivo, depois de tentar lê-lo (R4K).
 *
 * Os três casos existem porque são **decisões diferentes**, não variações do
 * mesmo resultado:
 *
 * - `absent` — instalação nova; um registro vazio é a verdade;
 * - `valid` — leu e validou; os registros servem;
 * - `corrupt` — o arquivo existe e não dá para confiar nele. Devolver uma
 *   lista vazia aqui seria dizer "não há turnos" sobre um arquivo que talvez
 *   tenha todos eles, e a próxima escrita apagaria o que restou.
 *
 * Um erro de **I/O** (permissão, um diretório no lugar) não é um estado do
 * arquivo: é uma falha do sistema operacional, e sobe como exceção. Confundir
 * os dois faria "não consegui ler" virar "está corrompido", e o operador
 * apagaria um arquivo íntegro.
 */
export type TurnFileState =
	| { readonly kind: 'absent' }
	| {
			readonly kind: 'valid';
			readonly turns: readonly TurnRecord[];
			/** Registros individuais descartados, com o motivo. */
			readonly unreadable: readonly string[];
	  }
	| {
			readonly kind: 'corrupt';
			/** Por que não serve. Texto de classe: sem conteúdo e sem caminho. */
			readonly reason: string;
	  };

/**
 * O arquivo existe e não pode ser usado (R4K).
 *
 * Identificável para quem chama distinguir de um erro do sistema de arquivos e
 * responder `503`/`409` em vez de `500`. A mensagem não carrega caminho.
 */
export class TurnRecordCorruptError extends Error {
	readonly code = 'turns_corrupt';
	constructor(
		message: string,
		readonly reason: string,
	) {
		super(message);
		this.name = 'TurnRecordCorruptError';
	}
}

/** O resultado de uma cópia de segurança (R4K). */
export interface TurnBackupResult {
	/** O nome do arquivo criado, relativo à raiz (nunca o caminho absoluto). */
	readonly file: string;
	readonly bytes: number;
}

/** Estados terminais: um turno que não está mais rodando. */
const TERMINAL: readonly TurnRecordStatus[] = ['completed', 'failed', 'cancelled', 'interrupted'];

/** O turno ainda está rodando? */
export function isTerminal(status: TurnRecordStatus): boolean {
	return TERMINAL.includes(status);
}

/**
 * O registro.
 *
 * Uma instância por processo, criada pelo host antes de o servidor aceitar
 * pedidos — é ela que faz a recuperação, e a recuperação precisa ter acabado
 * antes de alguém perguntar por um turno.
 */
export class TurnRecordStore {
	private cache: TurnRecord[] | undefined;
	/** Serializa as escritas; uma falha não deixa a fila rejeitada. */
	private pending: Promise<void> = Promise.resolve();
	/** A porta de gravação (R4Q): `writeFileAtomic` em produção. */
	private readonly writeFile: WritePort;

	constructor(private readonly options: TurnRecordStoreOptions) {
		this.writeFile = options.writeFile ?? writeFileAtomic;
	}

	private get path(): string {
		return join(this.options.root, TURNS_FILE);
	}

	/**
	 * O estado do arquivo: `absent`, `valid` ou `corrupt` (R4K).
	 *
	 * A lista não é mais o resultado, e sim um dos três desfechos. Devolver
	 * `[]` para um arquivo que não pôde ser lido seria afirmar "não há
	 * turnos" — e a próxima escrita apagaria o que ainda podia ser
	 * recuperado. Quem chama decide o que fazer com `corrupt`.
	 */
	async list(): Promise<TurnFileState> {
		return await this.state();
	}

	/**
	 * Registra um turno como `running`.
	 *
	 * Chamado **antes** de a execução começar: é o que permite, depois de uma
	 * queda, saber que havia um turno em curso. Se esta gravação falhar, o
	 * turno não deve começar — o chamador decide (o endpoint relança o erro
	 * como recusa do pedido), porque um turno que roda sem registro deixa a
	 * próxima inicialização sem saber que ele existiu.
	 */
	async start(input: {
		readonly turnId: string;
		readonly conversationId: string;
	}): Promise<TurnRecord> {
		const record: TurnRecord = {
			turnId: input.turnId,
			conversationId: input.conversationId,
			status: 'running',
			startedAt: this.nowIso(),
		};
		await this.write((turns) => [...turns.filter((turn) => turn.turnId !== record.turnId), record]);
		return record;
	}

	/**
	 * Fecha um turno.
	 *
	 * Idempotente por id: um turno que já está terminal **não** muda de
	 * estado por uma segunda chamada com outro desfecho. Isso é o que impede
	 * um evento tardio de reescrever `completed` como `cancelled`.
	 *
	 * `false` quando o turno não existe no registro — o chamador não inventa
	 * um registro só para fechá-lo.
	 */
	async finish(input: {
		readonly turnId: string;
		readonly status: Exclude<TurnRecordStatus, 'running' | 'interrupted'>;
		readonly reason?: string;
	}): Promise<boolean> {
		let found = false;
		await this.write((turns) => {
			const index = turns.findIndex((turn) => turn.turnId === input.turnId);
			if (index < 0) {
				return turns;
			}
			found = true;
			const current = turns[index] as TurnRecord;
			if (isTerminal(current.status)) {
				// Já fechado: o primeiro desfecho vence. Um `finish` tardio
				// (uma promessa que resolve depois do timeout, por exemplo) não
				// reescreve o que já aconteceu.
				return turns;
			}
			const next = [...turns];
			next[index] = {
				...current,
				status: input.status,
				finishedAt: this.nowIso(),
				...(input.reason !== undefined ? { reason: input.reason } : {}),
			};
			return next;
		});
		return found;
	}

	/**
	 * Recupera os turnos que ficaram `running` (R4H).
	 *
	 * Roda **uma vez**, na inicialização, antes de o servidor aceitar
	 * pedidos. Um `running` só pode ser de um processo que morreu: este
	 * acabou de nascer e não iniciou turno nenhum. Por isso vira
	 * `interrupted` com o motivo — não `failed` (não houve falha conhecida) e
	 * muito menos `completed` (não há prova de que terminou).
	 *
	 * Não repete chamadas ao modelo e não toca no histórico das conversas:
	 * seu único efeito é o estado do registro.
	 */
	async recover(): Promise<TurnRecoveryReport> {
		// R4K: um arquivo corrompido **não** é recuperado — recuperar seria
		// reescrevê-lo, e é justamente o que não se faz com um arquivo que
		// não foi lido com confiança. O operador decide, pela rota própria.
		//
		// Ausente é recuperável: não há nada a reescrever, e o resultado é uma
		// lista vazia honesta.
		const state = await this.state();
		if (state.kind === 'corrupt') {
			throw new TurnRecordCorruptError(
				'não é possível recuperar os turnos interrompidos: o registro de turnos está corrompido',
				state.reason,
			);
		}
		const turns = state.kind === 'valid' ? state.turns : [];
		const interrupted: TurnRecord[] = [];
		const now = this.nowIso();
		const next = turns.map((turn) => {
			if (turn.status !== 'running') {
				return turn;
			}
			const recovered: TurnRecord = {
				...turn,
				status: 'interrupted',
				finishedAt: now,
				reason:
					'o serviço foi encerrado antes de o turno terminar; a resposta não foi concluída',
			};
			interrupted.push(recovered);
			return recovered;
		});
		if (interrupted.length > 0) {
			// Uma escrita só para todos: a recuperação é uma transição, não N.
			await this.write(() => next);
		}
		return {
			interrupted: interrupted.length,
			// Os registros individuais descartados na leitura. Perdê-los aqui
			// faria a inicialização não ter o que avisar no log.
			unreadable: state.kind === 'valid' ? state.unreadable : [],
			turns: interrupted,
		};
	}

	/** Os turnos de uma conversa, mais recente primeiro. */
	async forConversation(conversationId: string): Promise<readonly TurnRecord[]> {
		const loaded = await this.readOnlyTurns();
		return loaded
			.filter((turn) => turn.conversationId === conversationId)
			.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
	}

	/**
	 * A consulta do diagnóstico (R4J).
	 *
	 * Devolve a página pedida e o **total que casa com o filtro** — sem o
	 * total, a interface não sabe se há mais páginas.
	 *
	 * ## Ordem
	 *
	 * `startedAt` decrescente, com desempate por `turnId`. A mesma ordem total
	 * da retenção (R4I): dois registros com a mesma data têm uma posição
	 * previsível, e a paginação não pula nem repete um item entre páginas.
	 *
	 * ## O que ela não faz
	 *
	 * Não lê mensagem, não abre conversa e não altera nada — é uma projeção do
	 * registro de ciclo de vida.
	 */
	async query(filter: TurnQuery): Promise<{ readonly turns: readonly TurnRecord[]; readonly total: number }> {
		const loaded = await this.readOnlyTurns();
		const matching = loaded
			.filter((turn) => matches(turn, filter))
			.sort((left, right) => byStartedDesc(left, right));
		return {
			turns: matching.slice(filter.offset, filter.offset + filter.limit),
			total: matching.length,
		};
	}

	/**
	 * Lê o arquivo e diz **em que estado ele está** (R4K).
	 *
	 * ## Os três desfechos
	 *
	 * - **ausente** (`ENOENT`): instalação nova. Não cria arquivo só para ler.
	 * - **válido**: o JSON tem a versão certa e a forma esperada. Um registro
	 *   individual inválido é descartado e dito — ele não pode levar os sadios
	 *   junto.
	 * - **corrompido**: JSON inválido, versão desconhecida ou forma errada. É
	 *   um estado, não uma lista vazia: quem chama decide entre recusar a
	 *   escrita, recusar a consulta ou oferecer a recuperação ao operador.
	 *
	 * **Erro de I/O não é estado**: permissão negada, um diretório no lugar do
	 * arquivo — a exceção sobe. Tratar isso como "corrompido" convidaria o
	 * operador a apagar um arquivo que talvez esteja inteiro.
	 */
	private async readState(): Promise<TurnFileState> {
		let raw: string;
		try {
			raw = await readFile(this.path, 'utf8');
		} catch (error) {
			if ((error as { readonly code?: unknown }).code === 'ENOENT') {
				return { kind: 'absent' };
			}
			throw error;
		}
		if (raw.trim().length === 0) {
			// Vazio não é ausente: alguém criou o arquivo e não escreveu nada —
			// uma gravação interrompida, ou uma edição à mão. É corrupção.
			return { kind: 'corrupt', reason: 'o arquivo do registro de turnos está vazio' };
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return { kind: 'corrupt', reason: 'o arquivo do registro de turnos não é JSON válido' };
		}
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return { kind: 'corrupt', reason: 'o arquivo do registro de turnos não tem o formato esperado' };
		}
		const record = parsed as Record<string, unknown>;
		if (record['version'] !== FORMAT_VERSION) {
			return {
				kind: 'corrupt',
				reason: 'o arquivo do registro de turnos tem uma versão desconhecida',
			};
		}
		if (!Array.isArray(record['turns'])) {
			return { kind: 'corrupt', reason: 'o arquivo do registro de turnos não tem a lista de turnos' };
		}
		const turns: TurnRecord[] = [];
		const unreadable: string[] = [];
		for (const [index, entry] of record['turns'].entries()) {
			const turn = parseTurn(entry);
			if (turn === undefined) {
				unreadable.push(`registro ${index} inválido`);
				continue;
			}
			turns.push(turn);
		}
		return { kind: 'valid', turns, unreadable };
	}

	/**
	 * O estado do arquivo, com cache.
	 *
	 * O cache guarda apenas um resultado **válido**: guardar "corrompido"
	 * significaria não notar que o operador reparou o arquivo à mão, e guardar
	 * "ausente" significaria não notar a primeira gravação.
	 */
	private async state(): Promise<TurnFileState> {
		if (this.cache !== undefined) {
			return { kind: 'valid', turns: this.cache, unreadable: [] };
		}
		const state = await this.readState();
		if (state.kind === 'valid') {
			this.cache = [...state.turns];
		}
		return state;
	}

	/**
	 * Os turnos para **leitura**, com a recusa explícita (R4K).
	 *
	 * Diferente de `usableTurns` só no nome: a leitura precisa saber que o
	 * arquivo está corrompido para dizer "diagnóstico indisponível" em vez
	 * de "nenhum turno". Ausente continua sendo lista vazia — é a
	 * instalação nova.
	 */
	private async readOnlyTurns(): Promise<readonly TurnRecord[]> {
		const state = await this.state();
		if (state.kind === 'corrupt') {
			throw new TurnRecordCorruptError(
				'não é possível ler o registro de turnos: ele está corrompido',
				state.reason,
			);
		}
		return state.kind === 'valid' ? state.turns : [];
	}

	/**
	 * Os turnos, ou a recusa quando o arquivo não serve (R4K).
	 *
	 * As escritas passam por aqui: **nenhuma delas** pode partir de um estado
	 * que não foi lido com confiança. Antes, `corrupt` virava lista vazia e a
	 * próxima gravação apagava o arquivo problemático — o que esta fase existe
	 * para impedir.
	 */
	private async usableTurns(operation: string): Promise<readonly TurnRecord[]> {
		const state = await this.state();
		if (state.kind === 'corrupt') {
			throw new TurnRecordCorruptError(
				`não é possível ${operation}: o registro de turnos está corrompido`,
				state.reason,
			);
		}
		return state.kind === 'valid' ? state.turns : [];
	}

	/**
	 * Aplica uma mudança e grava.
	 *
	 * A leitura acontece **dentro** da fila: duas escritas simultâneas não
	 * partem do mesmo estado e apagam uma à outra — o defeito que a R1 já
	 * teve no registro de chaves.
	 */
	private write(change: (turns: readonly TurnRecord[]) => readonly TurnRecord[]): Promise<void> {
		const run = async (): Promise<void> => {
			// Força uma leitura fresca: a mudança precisa ver o disco, não um
			// cache que outra escrita acabou de atualizar.
			this.cache = undefined;
			// R4K: `usableTurns` lança quando o arquivo está corrompido —
			// nenhuma escrita parte de um estado que não foi lido com
			// confiança. É o que impede o `start` de apagar o que restou.
			const loaded = await this.usableTurns('gravar o registro de turnos');
			// R4I: o teto de quantidade continua valendo em toda escrita — um
			// arquivo que cresce só porque ninguém reiniciou o serviço é o
			// problema que a retenção existe para evitar. O corte por **idade**
			// fica em `retainOlderThan`, na inicialização: ele depende de "que
			// horas são" e não muda a cada turno.
			const next = applyRetention(change(loaded), this.options.now?.() ?? new Date()).turns;
			const file = { version: FORMAT_VERSION, turns: next };
			await this.writeFile(this.path, `${JSON.stringify(file, null, 2)}\n`);
			this.cache = [...next];
		};
		const queued = this.pending.then(run, run);
		this.pending = queued.then(
			() => undefined,
			() => undefined,
		);
		return queued;
	}

	/**
	 * Copia o arquivo problemático para uma cópia de segurança (R4K).
	 *
	 * ## Por que existe
	 *
	 * Antes de qualquer ação destrutiva, o operador precisa poder guardar o que
	 * está lá. O arquivo está corrompido — mas "corrompido" é o diagnóstico do
	 * parser, não uma prova de que o conteúdo é lixo: um JSON truncado ainda
	 * tem os registros anteriores legíveis por quem sabe procurá-los.
	 *
	 * ## Não sobrescreve
	 *
	 * A cópia vai para `turns.json.bak`; se essa já existir, para `.bak.2`,
	 * `.bak.3`… — sem apagar uma cópia anterior. Uma segunda recuperação não
	 * pode destruir a evidência da primeira.
	 *
	 * Recusa quando não há o que copiar: arquivo ausente, ou arquivo válido.
	 */
	async backup(): Promise<TurnBackupResult> {
		return await this.enqueue(async () => {
			const state = await this.state();
			if (state.kind === 'absent') {
				throw new Error('não há registro de turnos para copiar');
			}
			if (state.kind === 'valid') {
				throw new Error('o registro de turnos está válido; não há o que copiar');
			}
			// Os bytes, como estão: reserializar perderia exatamente o que se
			// quer preservar.
			const raw = await readFile(this.path);
			for (let attempt = 1; attempt <= 99; attempt += 1) {
				const name = attempt === 1 ? `${TURNS_FILE}.bak` : `${TURNS_FILE}.bak.${attempt}`;
				try {
					// `wx`: falha quando a cópia já existe — é o que impede
					// sobrescrever a de uma recuperação anterior.
					await writeFile(join(this.options.root, name), raw, { flag: 'wx' });
					return { file: name, bytes: raw.length };
				} catch (error) {
					if ((error as { readonly code?: unknown }).code !== 'EEXIST') {
						throw error;
					}
				}
			}
			throw new Error('não foi possível encontrar um nome livre para a cópia de segurança');
		});
	}

	/**
	 * Começa um registro novo, vazio (R4K).
	 *
	 * Só quando o arquivo está **corrompido**: em `valid` não há por que apagar
	 * nada, e em `absent` o registro já é vazio. A recusa nesses casos é o que
	 * impede um clique a mais de destruir um registro bom.
	 *
	 * A escrita é atômica e passa pela mesma fila de `start`/`finish`: um turno
	 * iniciado no mesmo instante espera a vez, e o resultado é coerente com o
	 * que ele gravou.
	 *
	 * **Nada é reconstruído.** Os estados anteriores não podem ser comprovados
	 * depois de um arquivo ilegível, e inventá-los seria pior que perdê-los.
	 */
	async reset(): Promise<{ readonly reset: true }> {
		return await this.enqueue(async () => {
			const state = await this.state();
			if (state.kind === 'valid') {
				throw new Error('o registro de turnos está válido; não há o que reinicializar');
			}
			// Ausente é aceito: gravar vazio equivale ao que não existe, e deixa
			// o arquivo pronto para o próximo turno.
			const file = { version: FORMAT_VERSION, turns: [] };
			await this.writeFile(this.path, `${JSON.stringify(file, null, 2)}\n`);
			this.cache = [];
			return { reset: true };
		});
	}

	/**
	 * Entra na fila das mutações e devolve o resultado.
	 *
	 * As operações de recuperação usam a **mesma** fila de `start`/`finish`: uma
	 * cópia ou uma reinicialização nunca corre com o desfecho de um turno.
	 */
	private enqueue<T>(work: () => Promise<T>): Promise<T> {
		const run = async (): Promise<T> => {
			this.cache = undefined;
			return await work();
		};
		const queued = this.pending.then(run, run);
		this.pending = queued.then(
			() => undefined,
			() => undefined,
		);
		return queued;
	}

	/**
	 * Aplica a política de retenção completa (R4I).
	 *
	 * Chamada **na inicialização**, depois de `recover()`: um `running` que
	 * acabou de virar `interrupted` precisa contar como terminal antes de a
	 * retenção olhar para ele.
	 *
	 * ## Por que na fila
	 *
	 * A limpeza passa por `mutate`, que entra na mesma fila de `start` e
	 * `finish`. Um turno iniciado durante a limpeza espera a vez e não é
	 * sobrescrito — e a limpeza, quando roda, aplica-se ao estado que está no
	 * disco naquele instante, não ao que existia quando ela foi pedida.
	 *
	 * ## O que ela não faz
	 *
	 * Não toca em nenhum arquivo de conversa: a retenção é só do registro de
	 * turnos.
	 */
	async retain(now: Date = this.options.now?.() ?? new Date()): Promise<{
		readonly removedByAge: number;
		readonly removedByCount: number;
		readonly kept: number;
	}> {
		let removedByAge = 0;
		let removedByCount = 0;
		let kept = 0;
		const run = async (): Promise<void> => {
			this.cache = undefined;
			const loaded = await this.usableTurns('aplicar a retenção');
			const result = applyRetention(loaded, now);
			removedByAge = result.removedByAge;
			removedByCount = result.removedByCount;
			kept = result.turns.length;
			if (result.removedByAge === 0 && result.removedByCount === 0) {
				// Nada a remover: não reescreve o arquivo por nada.
				return;
			}
			const file = { version: FORMAT_VERSION, turns: result.turns };
			await this.writeFile(this.path, `${JSON.stringify(file, null, 2)}\n`);
			this.cache = [...result.turns];
		};
		// A mesma fila das escritas: um `start`/`finish` concorrente espera, e
		// a limpeza não sobrescreve o que ele gravou.
		const queued = this.pending.then(run, run);
		this.pending = queued.then(
			() => undefined,
			() => undefined,
		);
		await queued;
		return { removedByAge, removedByCount, kept };
	}

	private nowIso(): string {
		return (this.options.now?.() ?? new Date()).toISOString();
	}
}

/**
 * Descarta os terminais mais antigos além do teto.
 *
 * Os `running` ficam sempre: apagá-los perderia justamente o que a
 * recuperação procura.
 */
/**
 * A política de retenção de registros **terminais** (R4I).
 *
 * Duas regras, aplicadas nesta ordem:
 *
 * 1. **idade** — um terminal com `finishedAt` válida e mais antiga que
 *    {@link TURN_RETENTION_DAYS} dias sai;
 * 2. **quantidade** — dos que ficaram, os mais recentes até
 *    {@link MAX_TERMINAL_TURNS}.
 *
 * ## O que nunca sai
 *
 * - **`running`**, por nenhuma das duas regras — nem para caber no teto. É o
 *   que a recuperação procura; descartá-lo "por espaço" perderia justamente
 *   o dado que justifica o arquivo existir. Se houver 600 `running`, o
 *   arquivo fica maior que o previsto, de propósito.
 * - **terminal sem data legível**. `finishedAt` ausente ou inválida não é
 *   prova de antigüidade: pode ser um registro gravado por uma versão
 *   anterior, ou um arquivo editado à mão. A regra conservadora é manter — e,
 *   como fica sem data, ele não concorre ao corte por idade, apenas ao de
 *   quantidade (onde a data de início o ordena).
 *
 * ## Determinismo
 *
 * A ordem é total: `finishedAt` (quando válida), depois `startedAt`, depois
 * `turnId`. Sem o desempate final, dois registros com a mesma data
 * sairiam em ordem arbitrária — e um teste que afirma "os 500 mais recentes"
 * precisaria de um critério que o código não tem.
 */
export function applyRetention(
	turns: readonly TurnRecord[],
	now: Date,
): { readonly turns: readonly TurnRecord[]; readonly removedByAge: number; readonly removedByCount: number } {
	const cutoff = now.getTime() - TURN_RETENTION_DAYS * 24 * 60 * 60 * 1000;

	const kept: TurnRecord[] = [];
	let removedByAge = 0;
	for (const turn of turns) {
		if (turn.status === 'running') {
			kept.push(turn);
			continue;
		}
		const finished = parseTimestamp(turn.finishedAt);
		// Sem data válida: fica. Com data, a idade decide.
		if (finished !== undefined && finished < cutoff) {
			removedByAge += 1;
			continue;
		}
		kept.push(turn);
	}

	const terminals = kept.filter((turn) => turn.status !== 'running');
	if (terminals.length <= MAX_TERMINAL_TURNS) {
		return { turns: kept, removedByAge, removedByCount: 0 };
	}
	const keep = new Set(
		[...terminals].sort(byRecency).slice(0, MAX_TERMINAL_TURNS).map((turn) => turn.turnId),
	);
	const next = kept.filter((turn) => turn.status === 'running' || keep.has(turn.turnId));
	return {
		turns: next,
		removedByAge,
		removedByCount: kept.length - next.length,
	};
}

/** Mais recente primeiro, com desempate total (R4I). */
function byRecency(left: TurnRecord, right: TurnRecord): number {
	const leftTime = parseTimestamp(left.finishedAt) ?? parseTimestamp(left.startedAt);
	const rightTime = parseTimestamp(right.finishedAt) ?? parseTimestamp(right.startedAt);
	// Sem data nenhuma: vão para o fim, mas ainda em ordem determinística.
	if (leftTime !== rightTime) {
		if (leftTime === undefined) {
			return 1;
		}
		if (rightTime === undefined) {
			return -1;
		}
		return rightTime - leftTime;
	}
	return left.turnId < right.turnId ? -1 : left.turnId > right.turnId ? 1 : 0;
}

/** Uma data ISO válida, em ms; `undefined` quando ausente ou impossível. */
function parseTimestamp(value: string | undefined): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/** O filtro da consulta de diagnóstico (R4J). */
export interface TurnQuery {
	/** `all` mostra todos os estados. */
	readonly status: TurnRecordStatus | 'all';
	/** Limite inferior de `startedAt`, em ms. Inclusivo. */
	readonly since?: number;
	/** Limite superior de `startedAt`, em ms. Inclusivo. */
	readonly until?: number;
	readonly limit: number;
	readonly offset: number;
}

/** O turno casa com o filtro? */
function matches(turn: TurnRecord, filter: TurnQuery): boolean {
	if (filter.status !== 'all' && turn.status !== filter.status) {
		return false;
	}
	const started = Date.parse(turn.startedAt);
	if (!Number.isFinite(started)) {
		// Um `startedAt` ilegível não é datável: aparece quando não há
		// intervalo pedido, em vez de desaparecer de toda consulta.
		return filter.since === undefined && filter.until === undefined;
	}
	if (filter.since !== undefined && started < filter.since) {
		return false;
	}
	if (filter.until !== undefined && started > filter.until) {
		return false;
	}
	return true;
}

/** Mais recente primeiro, com desempate total por id (R4J). */
function byStartedDesc(left: TurnRecord, right: TurnRecord): number {
	const leftTime = Date.parse(left.startedAt);
	const rightTime = Date.parse(right.startedAt);
	const leftValid = Number.isFinite(leftTime);
	const rightValid = Number.isFinite(rightTime);
	if (leftValid && rightValid && leftTime !== rightTime) {
		return rightTime - leftTime;
	}
	// Sem data (ou com data igual): ids em ordem crescente, para a posição
	// não depender da ordem em que o arquivo foi escrito.
	if (leftValid !== rightValid) {
		return leftValid ? -1 : 1;
	}
	return left.turnId < right.turnId ? -1 : left.turnId > right.turnId ? 1 : 0;
}

function parseTurn(value: unknown): TurnRecord | undefined {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const turnId = record['turnId'];
	const conversationId = record['conversationId'];
	const status = record['status'];
	const startedAt = record['startedAt'];
	if (
		typeof turnId !== 'string' ||
		turnId.length === 0 ||
		typeof conversationId !== 'string' ||
		conversationId.length === 0 ||
		typeof startedAt !== 'string' ||
		!isTimestamp(startedAt) ||
		!isStatus(status)
	) {
		return undefined;
	}
	// R4K: uma data que não é data envenenaria a ordenação da retenção (R4I)
	// e o filtro por período (`Date.parse` → `NaN`) sem nunca ser notada. O
	// registro é descartado e dito, como qualquer outro inválido.
	const finishedAt = record['finishedAt'];
	if (finishedAt !== undefined && (typeof finishedAt !== 'string' || !isTimestamp(finishedAt))) {
		return undefined;
	}
	return {
		turnId,
		conversationId,
		status,
		startedAt,
		...(typeof finishedAt === 'string' ? { finishedAt } : {}),
		// `reason` é texto de classe; o limite evita que um campo enorme (ou
		// algo que não devia estar ali) entre no arquivo.
		...(typeof record['reason'] === 'string' && record['reason'].length <= 200
			? { reason: record['reason'] }
			: {}),
	};
}

/** Uma data ISO 8601 que `Date` consegue ler. */
function isTimestamp(value: string): boolean {
	return value.length > 0 && !Number.isNaN(Date.parse(value));
}

function isStatus(value: unknown): value is TurnRecordStatus {
	return (
		value === 'running' ||
		value === 'completed' ||
		value === 'failed' ||
		value === 'cancelled' ||
		value === 'interrupted'
	);
}
