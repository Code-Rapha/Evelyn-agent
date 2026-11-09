/**
 * O servidor OpenCode: quem o sobe, quem fala com ele e quem o encerra.
 *
 * ## A separação que o resto depende
 *
 * - **`managed`**: a Evelyn iniciou o processo. Só ela o encerra.
 * - **`manual`**: o servidor é do usuário. A Evelyn fala com ele, e **nunca**
 *   o encerra — nem ao desconectar, nem ao fechar o host.
 *
 * Toda ação que encerra processo passa por `managed`, que só existe no
 * primeiro caso. Não há outro caminho.
 *
 * ## A senha
 *
 * No modo gerenciado é **gerada aqui**, 32 bytes aleatórios, e existe só em
 * memória: vai para o ambiente do processo filho e para o cabeçalho Basic,
 * nunca para o disco, para o log ou para uma resposta. Ela some ao
 * desconectar, e o registro em disco não tem campo para ela.
 *
 * No modo manual é a que o usuário digitou. Ela só fica guardada enquanto a
 * conexão está de pé, porque é ela que permite reconectar após um reinício do
 * app; `disconnect` a descarta.
 *
 * ## Nesta fase, só a saúde
 *
 * `GET /global/health` é a **única** rota chamada — por construção, o
 * caminho de requisição é montado como `${base}/global/health` e não há outra
 * função que fale com o servidor. Nem `/provider`, nem `/config/providers`.
 */
import { createServer } from 'node:net';
import type { AddressVerdict } from './opencodeAddress';
import { basicAuthHeader, validateOpencodeBaseUrl, validateResolvedIp } from './opencodeAddress';
import type {
	OpencodeMode,
	OpencodeRecord,
	OpencodeRecordRead,
	OpencodeRecordStore,
} from '../core/storage/opencodeSettings';

/** O que a interface vê. */
export type OpencodeState =
	| { readonly state: 'not-configured' }
	| { readonly state: 'cli-missing' }
	| {
			readonly state: 'disconnected';
			readonly mode: OpencodeMode;
			readonly baseUrl: string;
			readonly reason?: string;
	  }
	| { readonly state: 'starting'; readonly baseUrl: string }
	| {
			readonly state: 'connected';
			readonly mode: OpencodeMode;
			readonly baseUrl: string;
			readonly version?: string;
	  }
	| { readonly state: 'auth-invalid'; readonly mode: OpencodeMode; readonly baseUrl: string }
	| {
			readonly state: 'unavailable';
			readonly mode: OpencodeMode;
			readonly baseUrl: string;
			readonly reason: string;
	  }
	| {
			readonly state: 'start-failed';
			readonly baseUrl?: string;
			readonly reason: string;
			/** `true` quando quem ocupou a porta respondeu: o servidor é outro. */
			readonly portTaken?: true;
		};

/** O que uma ação responde. */
export interface OpencodeActionResult {
	/** `true` quando a ação chegou ao fim desejado. */
	readonly done: boolean;
	readonly state: OpencodeState;
}

/** Um processo iniciado — injetável, para o teste não abrir socket. */
export interface ManagedProcess {
	readonly pid: number | undefined;
	/** Resolve quando o processo termina; nunca rejeita. */
	readonly exited: Promise<void>;
	/**
	 * As últimas linhas que o processo escreveu, sem a senha.
	 *
	 * É de onde sai o motivo real de uma falha de início — "ServeError" para
	 * uma porta ocupada, por exemplo. Ausente no teste, onde não há saída.
	 */
	lastOutput?(): string;
	kill(): void;
}

/** O que o gerenciador precisa do ambiente. */
export interface OpencodeManagerOptions {
	/** Procura a CLI e devolve a versão, ou `undefined` se não há CLI. */
	readonly detectCli: () => Promise<string | undefined>;
	/** Inicia `opencode serve` na porta, com a senha no ambiente. */
	readonly spawnServer: (input: {
		readonly port: number;
		readonly password: string;
		readonly binary: string;
	}) => ManagedProcess;
	/** O binário a usar. */
	readonly binary?: string;
	/**
	 * Confere se o processo iniciado continua vivo.
	 *
	 * Injetável por um motivo: no teste, o processo é um objeto, e não há
	 * PID para perguntar ao sistema. Sem esta checagem, um processo que morre
	 * **entre** a última resposta e o registro ficaria marcado "conectado"
	 * até alguém pedir o health de novo.
	 */
	readonly isAlive?: (handle: ManagedProcess) => boolean;
	/** Uma porta livre em loopback. */
	readonly findFreePort: () => Promise<number>;
	/**
	 * Faz a requisição de saúde. Devolve o status HTTP e, quando houver, a
	 * versão que o servidor declarou. É o status que decide a conexão; a
	 * versão é só um fato a mostrar, e não se guarda nada do corpo.
	 */
	readonly health: (input: {
		readonly url: string;
		readonly authorization: string | undefined;
	}) => Promise<{ readonly status: number; readonly version?: string }>;
	/** Onde o registro fica. Ausente = nada é gravado. */
	readonly store?: OpencodeRecordStore;
	/** Espera entre tentativas. */
	readonly sleep?: (ms: number) => Promise<void>;
	/** Quantas tentativas (com intervalo) antes de desistir. */
	readonly attempts?: number;
	readonly intervalMs?: number;
	readonly now?: () => Date;
	readonly log?: (message: string, data?: Record<string, unknown>) => void;
}

/** O servidor gerenciado vivo. */
interface ManagedServer {
	readonly process: ManagedProcess;
	readonly password: string;
	readonly port: number;
	readonly baseUrl: string;
}

/** O servidor manual conectado. */
interface ManualServer {
	readonly baseUrl: string;
	readonly password: string;
}

/** O resultado de uma verificação de saúde. */
interface ProbeResult {
	readonly outcome: 'ok' | 'auth' | 'unreachable';
	/** A versão que o servidor declarou no corpo, quando ele respondeu. */
	readonly version?: string;
}

/** O que a última tentativa deixou registrado. */
interface LastOutcome {
	readonly state: OpencodeState;
}

/** Uma porta livre pedida ao sistema, em loopback. */
export async function findFreeLoopbackPort(): Promise<number> {
	return await new Promise<number>((resolve, reject) => {
		const server = createServer();
		server.on('error', (error) => {
			reject(error);
		});
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (address === null || typeof address === 'string') {
				server.close(() => reject(new Error('não foi possível obter a porta')));
				return;
			}
			const { port } = address;
			server.close(() => resolve(port));
		});
	});
}

/**
 * O gerenciador.
 *
 * Um por host: o host é quem tem um processo, e o processo é o que se
 * gerencia.
 */
export class OpencodeManager {
	private managed: ManagedServer | undefined;
	/** A conexão com o servidor do usuário — a senha vive só enquanto ela. */
	private manual: ManualServer | undefined;
	private phase: 'idle' | 'starting' = 'idle';
	/** `true` até o registro anterior terminar de ser lido. */
	private restoring = true;
	/** Os processos que já terminaram — para não "encerrar" quem morreu sozinho. */
	private readonly exited = new WeakSet<ManagedProcess>();
	/** A leitura em curso, compartilhada por quem perguntar durante ela. */
	private restoringRun: Promise<void> | undefined;
	private startingUrl = '';
	private last: LastOutcome | undefined;
	private cli: string | undefined;

	constructor(private readonly options: OpencodeManagerOptions) {
		// O registro diz o que ficou da execução anterior. Ele é carregado no
		// construtor (sem esperar) e só vira estado de interface quando a
		// página pergunta: um processo anterior não sobreviveu ao fechamento,
		// e o endereço de um servidor manual fica à vista para reconectar.
		//
		// `restore` marca a leitura como em curso antes do primeiro `await`,
		// então um `status()` chamado logo depois no mesmo turno espera esta
		// leitura em vez de começar outra.
		void this.restore().catch(() => undefined);
	}

	private get sleep(): (ms: number) => Promise<void> {
		return this.options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	}

	private get now(): Date {
		return (this.options.now ?? (() => new Date()))();
	}

	/**
	 * A CLI está instalada? Só a versão é guardada — nunca um token.
	 *
	 * O resultado é memorizado: a detecção custa um processo, e a resposta não
	 * muda no meio de uma sessão do app.
	 */
	/**
	 * O estado observado, sem rede.
	 *
	 * A interface chama isto ao abrir a página: um GET não deve subir
	 * processo nem esperar health. Nada aqui fala com o servidor — só com o
	 * registro em disco.
	 */
	async status(): Promise<OpencodeState> {
		if (this.phase === 'starting') {
			return { state: 'starting', baseUrl: this.startingUrl };
		}
		// A leitura do registro é o que aconteceu antes: responder agora seria
		// responder "nunca configurado" sobre um servidor que existe. A leitura
		// em curso é esperada mesmo depois de ter começado — `restore` a marca
		// antes do primeiro `await`, e ela termina em outro turno.
		await this.restoringRun;
		return await this.fresh();
	}

	/** A CLI está instalada? Só a versão é guardada — nunca um token.
	 *
	 * O resultado é memorizado: a detecção custa um processo, e a resposta não
	 * muda no meio de uma sessão do app.
	 */
	private async cliVersion(): Promise<string | undefined> {
		if (this.cli !== undefined) {
			return this.cli;
		}
		this.cli = await this.options.detectCli();
		return this.cli;
	}

	/**
	 * O estado, sem rede e sem a leitura do registro — usado pelo próprio
	 * `restore` para não se chamar de volta.
	 */
	private async fresh(): Promise<OpencodeState> {
		if (this.managed !== undefined) {
			return { state: 'connected', mode: 'managed', baseUrl: this.managed.baseUrl };
		}
		if (this.manual !== undefined) {
			return { state: 'connected', mode: 'manual', baseUrl: this.manual.baseUrl };
		}
		if (this.last !== undefined) {
			return this.last.state;
		}
		if ((await this.cliVersion()) === undefined) {
			return { state: 'cli-missing' };
		}
		return { state: 'not-configured' };
	}

	/**
	 * Conecta no modo automático: porta livre, senha gerada, processo, health.
	 *
	 * A ordem não é negociável: **primeiro** a senha e a porta, **depois** o
	 * processo, **depois** o health. Se a senha não puder ser gerada, o
	 * processo não nasce — um servidor aberto na máquina é pior do que nenhum.
	 */
	async connectManaged(): Promise<OpencodeActionResult> {
		if (this.managed !== undefined) {
			return { done: true, state: await this.status() };
		}
		if (this.phase === 'starting') {
			return { done: false, state: await this.status() };
		}
		// Um servidor manual e um gerenciado não coexistem: a interface mostra
		// um servidor por vez, e dois registros seriam duas verdades.
		if (this.manual !== undefined) {
			return { done: false, state: await this.status() };
		}
		const cli = await this.cliVersion();
		if (cli === undefined) {
			return { done: false, state: { state: 'cli-missing' } };
		}

		let password: string;
		try {
			// 32 bytes aleatórios em base64url: forte, e sem caracteres que o
			// ambiente do Windows estrague.
			const { randomBytes } = await import('node:crypto');
			password = randomBytes(32).toString('base64url');
		} catch {
			return await this.recordFailure({
				state: 'start-failed',
				reason: 'não foi possível gerar a senha do servidor',
			});
		}
		if (password.length === 0) {
			return await this.recordFailure({
				state: 'start-failed',
				reason: 'não foi possível gerar a senha do servidor',
			});
		}

		let port: number;
		try {
			port = await this.options.findFreePort();
		} catch {
			return await this.recordFailure({
				state: 'start-failed',
				reason: 'não há porta livre em loopback para o servidor',
			});
		}

		const baseUrl = `http://127.0.0.1:${port}`;
		this.phase = 'starting';
		this.startingUrl = baseUrl;
		let handle: ManagedProcess;
		try {
			handle = this.options.spawnServer({
				port,
				password,
				binary: this.options.binary ?? 'opencode',
			});
		} catch (error) {
			this.phase = 'idle';
			return await this.recordFailure({
				state: 'start-failed',
				baseUrl,
				reason: `o processo não iniciou (${describe(error)})`,
			});
		}

		// O processo some antes do health responder? É um erro de início, não
		// um timeout: a interface merece o motivo real.
		let exitedEarly = false;
		void handle.exited.then(() => {
			exitedEarly = true;
			this.exited.add(handle);
		});

		const outcome = await this.waitForHealth(baseUrl, password, () => exitedEarly);
		// O processo morreu **e** ninguém respondeu ao health? A porta estava
		// tomada (ou o servidor falhou na largada): não é conexão nenhuma, e o
		// motivo é dito. A saída do próprio processo dirime os dois casos.
		if (exitedEarly && outcome.outcome === 'unreachable') {
			this.phase = 'idle';
			return await this.recordFailure({
				state: 'start-failed',
				baseUrl,
				reason: this.lastOutputHas(handle, 'serveerror')
					? 'a porta escolhida já estava em uso; o servidor encerrou sem iniciar'
					: 'o processo do servidor encerrou durante a inicialização (a porta pode estar em uso)',
				portTaken: true,
			});
		}
		// O processo morreu e **alguém** responde na porta: não é o nosso. Quem
		// respondeu aceita outra senha, e não se diz "conectado" por isso.
		if (exitedEarly) {
			this.phase = 'idle';
			return await this.recordFailure({
				state: 'start-failed',
				baseUrl,
				reason:
					'a porta escolhida está ocupada por outro servidor; ele respondeu, mas não é o processo do app',
				portTaken: true,
			});
		}
		// O processo existe, mas não respondeu como deveria: encerra o que é
		// nosso e diz por quê.
		if (outcome.outcome !== 'ok') {
			this.killOwned(handle);
			this.phase = 'idle';
			if (outcome.outcome === 'auth') {
				// Quem respondeu 401 não é o processo que subimos: um OpenCode
				// nosso aceita a senha que recebeu no ambiente. Se ele nem
				// chegou a dizer que estava escutando, a porta era de outro.
				if (!this.lastOutputHas(handle, 'listening')) {
					return await this.recordFailure({
						state: 'start-failed',
						baseUrl,
						reason:
							'a porta escolhida está ocupada por outro servidor; ele recusou a senha do app',
						portTaken: true,
					});
				}
				return await this.recordFailure({
					state: 'start-failed',
					baseUrl,
					reason: 'o servidor iniciou, mas recusou a autenticação que ele mesmo recebeu',
				});
			}
			return await this.recordFailure({
				state: 'start-failed',
				baseUrl,
				reason: 'o servidor não respondeu ao health a tempo (o processo foi encerrado)',
			});
		}
		this.managed = { process: handle, password, port, baseUrl };
		this.phase = 'idle';
		await this.persist({ version: 1, mode: 'managed', baseUrl, port, since: this.now.toISOString() });

		// Encerramento inesperado: o registro some, e o estado passa a dizer
		// que não há servidor — sem deixar um objeto "conectado" mentindo.
		void handle.exited.then(() => {
			if (this.managed?.process === handle) {
				this.managed = undefined;
				this.last = {
					state: {
						state: 'disconnected',
						mode: 'managed',
						baseUrl,
						reason: 'o processo do servidor encerrou sozinho',
					},
				};
				this.options.log?.('The managed OpenCode server exited', { reason: 'unexpected' });
			}
		});
		const state: OpencodeState = {
			state: 'connected',
			mode: 'managed',
			baseUrl,
			...(outcome.version !== undefined ? { version: outcome.version } : {}),
		};
		this.last = { state };
		return { done: true, state };
	}

	/**
	 * Conecta num servidor do usuário.
	 *
	 * O endereço é validado, o IP resolvido é validado (DNS rebinding), o
	 * health é consultado com a senha — e o processo **nunca** é encerrado:
	 * não é nosso.
	 */
	async connectManual(input: {
		readonly baseUrl: string;
		readonly password: string;
	}): Promise<OpencodeActionResult> {
		if (this.managed !== undefined || this.manual !== undefined || this.phase === 'starting') {
			return { done: false, state: await this.status() };
		}
		const verdict = validateOpencodeBaseUrl(input.baseUrl);
		if (!verdict.ok) {
			return await this.recordFailure({ state: 'unavailable', mode: 'manual', baseUrl: '', reason: verdict.reason });
		}
		const baseUrl = trimBase(verdict.url.toString());
		const password = input.password.trim();
		if (password.length === 0) {
			return await this.recordFailure({
				state: 'disconnected',
				mode: 'manual',
				baseUrl,
				reason: 'informe a senha do servidor (o OPENCODE_SERVER_PASSWORD dele)',
			});
		}
		const outcome = await this.probe(baseUrl, password);
		if (outcome.outcome === 'auth') {
			return await this.recordFailure({ state: 'auth-invalid', mode: 'manual', baseUrl });
		}
		if (outcome.outcome === 'unreachable') {
			return await this.recordFailure({
				state: 'unavailable',
				mode: 'manual',
				baseUrl,
				reason: 'o servidor não respondeu ao health no endereço informado',
			});
		}
		this.manual = { baseUrl, password };
		const state: OpencodeState = {
			state: 'connected',
			mode: 'manual',
			baseUrl,
			...(outcome.version !== undefined ? { version: outcome.version } : {}),
		};
		this.last = { state };
		await this.persist({ version: 1, mode: 'manual', baseUrl, since: this.now.toISOString() });
		return { done: true, state };
	}

	/**
	 * Reconecta ao que ficou gravado, depois de um reinício do app.
	 *
	 * Só o que foi registrado importa, e o registro não tem senha: um servidor
	 * manual aparece "desconectado" com o endereço e pede a senha de novo; um
	 * gerenciado diz que o processo anterior não sobreviveu; um arquivo
	 * ilegível é dito como ilegível. Nada é inventado.
	 */
	async restore(): Promise<OpencodeState> {
		if (!this.restoring) {
			return await this.restoredState();
		}
		// O sinal de "está lendo" vai antes de qualquer await, e `status` usa
		// `restoringRun`, que é criado no mesmo instante.
		this.restoring = false;
		const run = this.readRecord();
		this.restoringRun = run.then(
			() => undefined,
			() => undefined,
		);
		return await run;
	}

	/** A leitura do registro, uma vez. */
	private async readRecord(): Promise<OpencodeState> {
		if (this.options.store === undefined) {
			return await this.fresh();
		}
		const read = await this.options.store.read();
		if (read.kind === 'absent') {
			return await this.fresh();
		}
		return this.restoredFrom(read);
	}

	/** O estado depois de uma restauração que já aconteceu. */
	private async restoredState(): Promise<OpencodeState> {
		return this.last === undefined ? await this.fresh() : this.last.state;
	}

	private restoredFrom(read: Exclude<OpencodeRecordRead, { kind: 'absent' }>): OpencodeState {
		if (read.kind === 'corrupt') {
			return this.remember({ state: 'disconnected', mode: 'manual', baseUrl: '', reason: read.reason });
		}
		const record = read.record;
		if (record.mode === 'manual') {
			return this.remember({
				state: 'disconnected',
				mode: 'manual',
				baseUrl: record.baseUrl,
				reason: 'a senha do servidor manual não fica guardada; conecte de novo informando-a',
			});
		}
		return this.remember({
			state: 'disconnected',
			mode: 'managed',
			baseUrl: record.baseUrl,
			reason: 'o servidor gerenciado anterior não sobreviveu ao último encerramento do app',
		});
	}

	/**
	 * Verifica a saúde do servidor conectado.
	 *
	 * É o que mantém o estado honesto: um processo que morreu, ou uma senha
	 * que deixou de valer, aparecem aqui.
	 */
	async check(): Promise<OpencodeActionResult> {
		if (this.phase === 'starting') {
			return { done: false, state: await this.status() };
		}
		const managed = this.managed;
		if (managed !== undefined) {
			const outcome = await this.probe(managed.baseUrl, managed.password);
			if (outcome.outcome === 'ok') {
				const state: OpencodeState = {
					state: 'connected',
					mode: 'managed',
					baseUrl: managed.baseUrl,
					...(outcome.version !== undefined ? { version: outcome.version } : {}),
				};
				this.last = { state };
				return { done: true, state };
			}
			if (outcome.outcome === 'auth') {
				return await this.recordFailure({ state: 'auth-invalid', mode: 'managed', baseUrl: managed.baseUrl });
			}
			return await this.recordFailure({
				state: 'unavailable',
				mode: 'managed',
				baseUrl: managed.baseUrl,
				reason: 'o processo do servidor não responde',
			});
		}
		const manual = this.manual;
		if (manual !== undefined) {
			const outcome = await this.probe(manual.baseUrl, manual.password);
			if (outcome.outcome === 'ok') {
				const state: OpencodeState = {
					state: 'connected',
					mode: 'manual',
					baseUrl: manual.baseUrl,
					...(outcome.version !== undefined ? { version: outcome.version } : {}),
				};
				this.last = { state };
				return { done: true, state };
			}
			if (outcome.outcome === 'auth') {
				return await this.recordFailure({ state: 'auth-invalid', mode: 'manual', baseUrl: manual.baseUrl });
			}
			return await this.recordFailure({
				state: 'unavailable',
				mode: 'manual',
				baseUrl: manual.baseUrl,
				reason: 'o servidor não responde',
			});
		}
		return { done: false, state: await this.status() };
	}

	/**
	 * Desconecta. Encerra **somente** o processo que a Evelyn iniciou.
	 *
	 * O registro sai do disco: desconectar é esquecer, não lembrar para
	 * reconectar em silêncio depois.
	 */
	async disconnect(): Promise<OpencodeActionResult> {
		const cli = await this.cliVersion();
		if (this.managed !== undefined) {
			this.killOwned(this.managed.process);
			this.managed = undefined;
			await this.forget();
			const state: OpencodeState =
				cli === undefined ? { state: 'cli-missing' } : { state: 'not-configured' };
			this.last = { state };
			return { done: true, state };
		}
		if (this.manual !== undefined) {
			// O servidor é do usuário: esquecer a senha é tudo o que se faz.
			this.manual = undefined;
			await this.forget();
			const state: OpencodeState =
				cli === undefined ? { state: 'cli-missing' } : { state: 'not-configured' };
			this.last = { state };
			return { done: true, state };
		}
		await this.forget();
		this.last = undefined;
		// Esquecer não é fingir: sem registro, o estado é o do começo — a
		// CLI continua instalada ou não, e isso é perguntado de novo.
		this.restoring = true;
		this.restoringRun = undefined;
		return { done: true, state: await this.status() };
	}

	/** Libera o que é nosso: o processo do modo gerenciado. */
	dispose(): void {
		if (this.managed !== undefined) {
			this.killOwned(this.managed.process);
			this.managed = undefined;
		}
		this.manual = undefined;
		// A senha do modo manual nunca foi gravada: não há nada a apagar.
	}

	/** A validação do endereço, em um lugar. */
	validate(raw: string): AddressVerdict {
		return validateOpencodeBaseUrl(raw);
	}

	/**
	 * O servidor conectado, para uma leitura autenticada.
	 *
	 * Devolve a base e a senha **vivas** — é o único jeito de outra leitura
	 * (o catálogo, na Fase 4D) usar a mesma autenticação da 4C sem que a
	 * página jamais veja a senha. `undefined` quando não há conexão.
	 *
	 * A senha do modo gerenciado continua sem ser gravada em lugar nenhum; a
	 * do manual continua existindo só enquanto a conexão existir.
	 */
	connection(): { readonly baseUrl: string; readonly password: string; readonly mode: 'managed' | 'manual' } | undefined {
		if (this.managed !== undefined) {
			return { baseUrl: this.managed.baseUrl, password: this.managed.password, mode: 'managed' };
		}
		if (this.manual !== undefined) {
			return { baseUrl: this.manual.baseUrl, password: this.manual.password, mode: 'manual' };
		}
		return undefined;
	}

	/** A saída recente do processo contém este texto (sem diferenciar caixa)? */
	private lastOutputHas(handle: ManagedProcess, text: string): boolean {
		const output = handle.lastOutput?.() ?? '';
		return output.toLowerCase().includes(text.toLowerCase());
	}

	/** Só mata o que é nosso. */
	private killOwned(handle: ManagedProcess): void {
		if (this.exited.has(handle)) {
			return;
		}
		try {
			handle.kill();
		} catch {
			// Um processo já morto não é erro.
		}
	}

	/** Guarda o desfecho e o devolve, para o chamador repassar à interface. */
	private async recordFailure(state: OpencodeState): Promise<OpencodeActionResult> {
		this.last = { state };
		this.phase = 'idle';
		return { done: false, state };
	}

	/** Guarda só o estado — para `restore`, que devolve estado e não ação. */
	private remember(state: OpencodeState): OpencodeState {
		this.last = { state };
		this.phase = 'idle';
		return state;
	}

	/** Grava o registro, quando há onde. Uma falha não derruba a conexão. */
	private async persist(record: OpencodeRecord): Promise<void> {
		if (this.options.store === undefined) {
			return;
		}
		const written = await this.options.store.write(record);
		if (written.kind === 'failed') {
			this.options.log?.('The OpenCode record was not written', { reason: 'write failed' });
		}
	}

	/** Esquece o registro em disco. */
	private async forget(): Promise<void> {
		try {
			await this.options.store?.clear();
		} catch {
			this.options.log?.('The OpenCode record could not be removed', { reason: 'remove failed' });
		}
	}

	/**
	 * Uma chamada de saúde, com a defesa de DNS rebinding antes de sair.
	 *
	 * A URL é montada aqui e em nenhum outro lugar: `${base}/global/health`.
	 * É a garantia estrutural de que nenhuma outra rota do OpenCode é chamada
	 * nesta fase.
	 */
	private async probe(baseUrl: string, password: string): Promise<ProbeResult> {
		const verdict = validateOpencodeBaseUrl(baseUrl);
		if (!verdict.ok) {
			return { outcome: 'unreachable' };
		}
		const host = verdict.url.hostname;
		// Um nome (não um IP): resolve antes, e recusa se cair na rede interna.
		const literal = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':') || host.startsWith('[');
		if (!literal) {
			try {
				const { lookup } = await import('node:dns/promises');
				const resolved = await lookup(host);
				const check = validateResolvedIp(resolved.address, verdict.loopback);
				if (!check.ok) {
					return { outcome: 'unreachable' };
				}
			} catch {
				return { outcome: 'unreachable' };
			}
		}
		try {
			const answer = await this.options.health({
				url: `${trimBase(verdict.url.toString())}/global/health`,
				authorization: basicAuthHeader(password),
			});
			if (answer.status === 401 || answer.status === 403) {
				return { outcome: 'auth' };
			}
			if (answer.status < 200 || answer.status >= 300) {
				return { outcome: 'unreachable' };
			}
			return {
				outcome: 'ok',
				...(answer.version !== undefined && answer.version.length > 0 ? { version: answer.version } : {}),
			};
		} catch {
			return { outcome: 'unreachable' };
		}
	}

	/**
	 * Espera o health responder, com limite de tentativas e de tempo.
	 *
	 * Cada tentativa é uma requisição; o processo morto é detectado entre
	 * elas e encerra a espera na hora, em vez de gastar o orçamento todo.
	 */
	private async waitForHealth(baseUrl: string, password: string, exited: () => boolean): Promise<ProbeResult> {
		const attempts = this.options.attempts ?? 40;
		const interval = this.options.intervalMs ?? 250;
		let last: ProbeResult = { outcome: 'unreachable' };
		for (let attempt = 0; attempt < attempts; attempt += 1) {
			// Antes de cada tentativa, e de novo depois da última: um processo
			// que morre enquanto o health responde não vira "conectado".
			if (exited()) {
				return { outcome: 'unreachable' };
			}
			last = await this.probe(baseUrl, password);
			if (last.outcome === 'ok' || last.outcome === 'auth') {
				return exited() ? { outcome: 'unreachable' } : last;
			}
			await this.sleep(interval);
		}
		return last;
	}
}

/** A URL sem barra final — o formato em que o `baseUrl` é guardado. */
function trimBase(value: string): string {
	return value.replace(/\/+$/, '');
}

/** A mensagem de um erro, sem pilha. */
function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}