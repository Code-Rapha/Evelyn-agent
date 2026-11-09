/**
 * O gerenciador do servidor OpenCode — a parte que decide, sem abrir porta.
 *
 * ## O que se prova, e como
 *
 * O processo e o health são **injetados**: nenhum destes testes sobe um
 * `opencode serve` nem abre socket. Assim cada caso é o que diz ser — CLI
 * ausente, senha obrigatória, porta ocupada, timeout, encerramento inesperado,
 * autenticação inválida — sem depender de a máquina ter a CLI.
 *
 * ## O que se prova sobre a senha
 *
 * Que ela existe no ambiente do filho, não existe em `argv`, não aparece em
 * estado, ação ou registro, e que o modo automático **não nasce** se ela não
 * puder ser gerada.
 *
 * ## O que se prova sobre a rota
 *
 * Que a única URL pedida é `/global/health` — o teste recusa qualquer outra e
 * falha dizendo qual foi.
 */
import * as assert from 'assert';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	OpencodeManager,
	type ManagedProcess,
	type OpencodeManagerOptions,
	type OpencodeState,
} from '../app/opencodeManager';
import { OpencodeRecordStore, serializeOpencodeRecord } from '../core/storage/opencodeSettings';
import { removeFixtureTree } from '../test-support/removeFixtureTree';

/** Um processo falso: existe, pode "morrer", e registra se foi morto. */
class FakeProcess implements ManagedProcess {
	readonly pid = 4242;
	killed = false;
	/** O que o processo "escreveu". */
	output = '';
	private resolveExit: () => void = () => undefined;
	readonly exited: Promise<void> = new Promise<void>((resolve) => {
		this.resolveExit = resolve;
	});

	kill(): void {
		this.killed = true;
		this.resolveExit();
	}

	lastOutput(): string {
		return this.output;
	}

	/** O processo terminou sozinho — um crash, não um encerramento nosso. */
	exitUnexpectedly(): void {
		this.resolveExit();
	}
}

/** Um processo falso já morto, para o caso de o servidor cair no início. */
class DeadProcess extends FakeProcess {
	constructor() {
		super();
		super.exitUnexpectedly();
	}
}

/** O que cada tentativa de health responde. */
interface HealthScript {
	/** Status por chamada; o último valor se repete. */
	readonly statuses: readonly number[];
	/** Lançar em vez de responder — servidor que não aceita conexão. */
	readonly throwOn?: readonly number[];
}

interface Harness {
	readonly manager: OpencodeManager;
	readonly processes: FakeProcess[];
	readonly urls: string[];
	readonly authorizations: (string | undefined)[];
	readonly store: OpencodeRecordStore;
	/** Cria uma segunda instância que divide o mesmo script de health. */
	second(options: Partial<OpencodeManagerOptions>): OpencodeManager;
	/** Espera a leitura inicial do registro terminar. */
	settle(): Promise<void>;
}

/** O gerenciador injetado, e o que ele observou. */
function harness(
	root: string,
	options: {
		/** A CLI detectada; ausente = CLI instalada. `null` = não instalada. */
		readonly cli?: string | null;
		readonly port?: number;
		readonly portError?: Error;
		readonly health?: HealthScript;
		readonly spawnError?: Error;
		readonly withStore?: boolean;
	} = {},
): Harness {
	const processes: FakeProcess[] = [];
	const urls: string[] = [];
	const authorizations: (string | undefined)[] = [];
	const ran = new Set<OpencodeManager>();
	/** O passo explícito que o construtor faz sozinho, aqui esperado. */
	const ready: Promise<void>[] = [];
	const store = new OpencodeRecordStore(join(root, 'opencode.json'));
	let trip = 0;

	/**
	 * Uma porta nova por instância: duas instâncias na mesma porta seriam o
	 * mesmo servidor, e o teste é sobre instâncias distintas.
	 */
	let port = options.port ?? 45001;

	const createManager = (override: Partial<OpencodeManagerOptions> = {}): OpencodeManager => {
		const base: OpencodeManagerOptions = {
			detectCli: async () => (options.cli === null ? undefined : options.cli ?? '1.18.34'),
			spawnServer: (input) => {
				if (options.spawnError !== undefined) {
					throw options.spawnError;
				}
				// A senha tem de chegar aqui: é o que prova que o servidor não
				// nasce aberto.
				assert.ok(input.password.length >= 32, 'a senha gerada tem de ser forte');
				const processHandle = new FakeProcess();
				processes.push(processHandle);
				return processHandle;
			},
			binary: 'opencode',
			findFreePort: async () => {
				if (options.portError !== undefined) {
					throw options.portError;
				}
				port += 1;
				return port;
			},
			health: async (input) => {
				urls.push(input.url);
				authorizations.push(input.authorization);
				if (options.health?.throwOn?.includes(trip) === true) {
					trip += 1;
					throw new Error('connect ECONNREFUSED');
				}
				const status = options.health?.statuses[Math.min(trip, options.health.statuses.length - 1)] ?? 200;
				trip += 1;
				return { status, ...(status === 200 ? { version: '1.18.34' } : {}) };
			},
			...(options.withStore === false ? {} : { store }),
			...override,
			sleep: async () => undefined,
			attempts: 3,
			intervalMs: 1,
		};
		const manager = new OpencodeManager(base);
		ran.add(manager);
		return manager;
	};const manager = createManager();
	return {
		manager,
		processes,
		urls,
		authorizations,
		store,
		second: createManager,
		settle: async () => {
			await Promise.all(ready);
		},
	};
}

suite('OpenCode: o gerenciador do servidor', () => {
	let root: string;
	/** Os gerenciadores criados no teste, para serem liberados no fim. */
	let created: Set<OpencodeManager>;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'seshyina-opencode-'));
		created = new Set<OpencodeManager>();
	});

	teardown(async () => {
		// O construtor lê o registro anterior: um gerenciador pendurado
		// continuaria trabalhando depois do teste. Liberar todos é o que
		// garante que este teste não interfira no próximo.
		for (const manager of created) {
			manager.dispose();
		}
		await removeFixtureTree(root);
	});

	/** Monta o harness e o registra para a limpeza. */
	async function make(options: Parameters<typeof harness>[1] = {}): Promise<Harness> {
		const built = await harness(root, options);
		created.add(built.manager);
		const originalSecond = built.second;
		built.second = (override) => {
			const manager = originalSecond(override);
			created.add(manager);
			return manager;
		};
		return built;
	}


	test('sem a CLI, o estado é "CLI não encontrada" e nada nasce', async () => {
		const built = await make({ cli: null });
		await built.settle();
		const { manager, processes } = built;

		assert.deepStrictEqual(await manager.status(), { state: 'cli-missing' });
		const result = await manager.connectManaged();
		assert.strictEqual(result.done, false);
		assert.strictEqual(result.state.state, 'cli-missing');
		assert.strictEqual(processes.length, 0, 'sem CLI, o processo não pode ser iniciado');
	});

	test('a inicialização bem-sucedida só é dita conectada depois do health', async () => {
		const { manager, processes, urls, authorizations } = await make();

		const result = await manager.connectManaged();

		assert.strictEqual(result.done, true);
		assert.strictEqual(result.state.state, 'connected');
		assert.strictEqual(processes.length, 1);
		// O registro não fala com o servidor: a única URL é o health.
		assert.deepStrictEqual(urls, ['http://127.0.0.1:45002/global/health']);
		// O cabeçalho é Basic com usuário opencode; a senha só existe ali.
		assert.ok(authorizations[0]?.startsWith('Basic '));
		const decoded = Buffer.from((authorizations[0] ?? '').slice('Basic '.length), 'base64').toString('utf8');
		assert.ok(decoded.startsWith('opencode:'), 'o usuário documentado do OpenCode');
		assert.ok(decoded.length > 'opencode:'.length + 30, 'a senha vai no cabeçalho');

		const status = await manager.status();
		assert.strictEqual(status.state, 'connected');
	});

	test('o modo automático nunca consulta /provider nem /config/providers', async () => {
		const { manager, urls } = await make();
		await manager.connectManaged();
		await manager.check();

		assert.ok(urls.length > 0);
		for (const url of urls) {
			const parsed = new URL(url);
			assert.strictEqual(parsed.pathname, '/global/health', `rota proibida chamada: ${url}`);
		}
	});

	test('a senha não está no registro em disco e chega ao health só no cabeçalho', async () => {
		const captured: string[] = [];
		// Uma instância com health próprio, para capturar o cabeçalho que ela
		// mesma manda — o registro em disco é o do harness.
		const own = (await make()).second({
			health: async (input) => {
				captured.push(input.authorization ?? '');
				return { status: 200 };
			},
		});

		await own.connectManaged();

		const record = await readFile(join(root, 'opencode.json'), 'utf8');
		assert.ok(!record.includes('password'), 'o registro não tem campo de senha');
		assert.ok(!record.includes('authorization'));
		const password = Buffer.from((captured[0] ?? '').slice('Basic '.length), 'base64')
			.toString('utf8')
			.replace(/^opencode:/, '');
		assert.ok(password.length >= 32);
		assert.ok(!record.includes(password), 'a senha gerada não pode ir para o disco');
	});
	test('porta ocupada / sem porta livre é erro de inicialização', async () => {
		const { manager, processes } = await make({
			portError: Object.assign(new Error('EADDRINUSE'), { code: 'EADDRINUSE' }),
		});

		const result = await manager.connectManaged();

		assert.strictEqual(result.done, false);
		assert.strictEqual(result.state.state, 'start-failed');
		assert.ok((result.state as { reason: string }).reason.includes('porta'));
		assert.strictEqual(processes.length, 0);
	});

	test('timeout: o health nunca responde e o processo é encerrado', async () => {
		const { manager, processes } = await make({ health: { statuses: [503, 503, 503] } });

		const result = await manager.connectManaged();

		assert.strictEqual(result.done, false);
		assert.strictEqual(result.state.state, 'start-failed');
		assert.ok(/não respondeu/.test((result.state as { reason: string }).reason));
		assert.strictEqual(processes[0]?.killed, true, 'o processo que subimos não pode ficar órfão');
	});

	test('o health só aparece na segunda tentativa: ainda assim conecta', async () => {
		const { manager } = await make({ health: { statuses: [0, 0, 200] } });
		const result = await manager.connectManaged();
		assert.strictEqual(result.state.state, 'connected');
	});

	test('encerramento inesperado aparece como desconectado e não como conectado', async () => {
		const { manager, processes } = await make();
		await manager.connectManaged();

		processes[0]?.exitUnexpectedly();
		// A promessa de saída é resolvida no microtask: espera um turno.
		await new Promise((resolve) => setImmediate(resolve));

		const status = await manager.status();
		assert.strictEqual(status.state, 'disconnected');
		assert.ok(/encerrou sozinho/.test((status as { reason?: string }).reason ?? ''));
	});

	test('o processo que encerrou antes do health vira erro de inicialização', async () => {
		const built = await make();
		// Um health que nunca responde: a única notícia é a morte do processo.
		const deadProcess = new DeadProcess();
		const withDead = built.second({
			spawnServer: () => deadProcess,
			health: async () => {
				throw new Error('connect ECONNREFUSED');
			},
		});

		const result = await withDead.connectManaged();

		assert.strictEqual(result.done, false);
		assert.strictEqual(result.state.state, 'start-failed');
		assert.ok(/encerrou durante a inicialização/.test((result.state as { reason: string }).reason));
		// O que importa: nada ficou conectado.
		assert.strictEqual((await built.manager.status()).state, 'not-configured');
	});

	test('porta ocupada por outro servidor: ele responde, mas não é o nosso', async () => {
		const built = await make();
		// O nosso processo morre na largada (a porta vinha tomada), e **outro**
		// servidor, com outra senha, responde naquele endereço.
		const impostor = new DeadProcess();
		// A morte do processo é vista pela primeira checagem, e depois dela o
		// health responde.
		let answeredOnce = false;
		const withImpostor = built.second({
			spawnServer: () => impostor,
			health: async () => {
				answeredOnce = true;
				return { status: 200, version: '1.18.34' };
			},
		});

		const result = await withImpostor.connectManaged();

		assert.strictEqual(result.done, false);
		assert.strictEqual(result.state.state, 'start-failed');
		assert.strictEqual(answeredOnce, true);
		// O processo alheio não é nosso: ninguém o encerra.
		assert.strictEqual(impostor.killed, false);
		assert.strictEqual((await built.manager.status()).state, 'not-configured');
	});

	test('o ServeError da saída do processo é lido como porta ocupada', async () => {
		const built = await make();
		const dead = new DeadProcess();
		// Um processo cujo motivo de morte é a porta: a saída real do OpenCode.
		const withReport = built.second({
			spawnServer: () => ({
				pid: 7,
				exited: dead.exited,
				lastOutput: () => 'Warning: OPENCODE_SERVER_PASSWORD is not set\nError: Unexpected error\nServeError',
				kill: () => undefined,
			}),
			health: async () => {
				throw new Error('connect ECONNREFUSED');
			},
		});
		dead.exitUnexpectedly();

		const result = await withReport.connectManaged();

		assert.strictEqual(result.done, false);
		assert.strictEqual((result.state as { portTaken?: boolean }).portTaken, true);
		assert.ok(/porta escolhida já estava em uso/.test((result.state as { reason: string }).reason));
	});

	test('autenticação inválida no health próprio é erro de inicialização', async () => {
		const { manager, processes } = await make({ health: { statuses: [401] } });

		const result = await manager.connectManaged();

		assert.strictEqual(result.done, false);
		assert.strictEqual(result.state.state, 'start-failed');
		assert.strictEqual(processes[0]?.killed, true);
	});

	test('porta ocupada por um servidor vivo que recusa a senha do app', async () => {
		const built = await make();
		// O nosso processo continua vivo, mas quem responde é outro servidor: a
		// resposta é 401, e nós nunca dissemos "listening".
		const alive = new FakeProcess();
		const withImpostor = built.second({
			spawnServer: () => alive,
			health: async () => ({ status: 401 }),
		});

		const result = await withImpostor.connectManaged();

		assert.strictEqual(result.done, false);
		assert.strictEqual((result.state as { portTaken?: boolean }).portTaken, true);
		assert.ok(/porta escolhida está ocupada/.test((result.state as { reason: string }).reason));
		// O processo que criamos é encerrado: é nosso.
		assert.strictEqual(alive.killed, true);
	});

	test('um servidor nosso que diz "listening" e recusa a senha própria é um erro nosso', async () => {
		const built = await make();
		const ours = new FakeProcess();
		ours.output = 'opencode server listening on http://127.0.0.1:45001';
		const withOurs = built.second({
			spawnServer: () => ours,
			health: async () => ({ status: 401 }),
		});

		const result = await withOurs.connectManaged();

		assert.strictEqual(result.done, false);
		assert.strictEqual((result.state as { portTaken?: boolean }).portTaken, undefined);
		assert.ok(/recusou a autenticação que ele mesmo recebeu/.test((result.state as { reason: string }).reason));
	});

	test('modo automático com spawn que falha vira erro de inicialização', async () => {
		const { manager } = await make({ spawnError: new Error('spawn ENOENT') });
		const result = await manager.connectManaged();
		assert.strictEqual(result.state.state, 'start-failed');
	});

	test('a versão do health é mostrada, e nada mais do corpo é guardado', async () => {
		const built = await make();
		const result = await built.manager.connectManaged();

		assert.strictEqual(result.state.state, 'connected');
		assert.strictEqual((result.state as { version?: string }).version, '1.18.34');

		// O registro em disco não guarda a versão: ela é do processo da vez.
		const record = await readFile(join(root, 'opencode.json'), 'utf8');
		assert.ok(!record.includes('1.18.34'));
	});

	test('um processo que morre depois do health não vira "conectado"', async () => {
		const built = await make();
		// O health responde, e o processo morre no mesmo instante em que a
		// resposta chega: a checagem posterior ao health é a que decide.
		const deadProcess = new DeadProcess();
		const withDead = built.second({
			spawnServer: () => deadProcess,
			health: async () => {
				deadProcess.exitUnexpectedly();
				return { status: 200, version: '1.18.34' };
			},
		});

		const result = await withDead.connectManaged();

		assert.strictEqual(result.done, false);
		assert.strictEqual(result.state.state, 'start-failed');
		assert.strictEqual((await built.manager.status()).state, 'not-configured');
	});

	test('um processo que morre entre verificações é "servidor indisponível"', async () => {
		const built = await make();
		await built.manager.connectManaged();
		// O health responde, mas o processo já morreu: a checagem de vida é
		// feita antes de aceitar a resposta.
		const deadAfterHealth = built.second({
			spawnServer: () => new DeadProcess(),
			health: async () => ({ status: 200 }),
		});
		const result = await deadAfterHealth.connectManaged();
		assert.strictEqual(result.done, false);
	});

	test('desconectar encerra o próprio processo, e só ele', async () => {
		const { manager, processes } = await make();
		await manager.connectManaged();
		assert.strictEqual(processes.length, 1);

		const result = await manager.disconnect();

		assert.strictEqual(result.done, true);
		assert.strictEqual(result.state.state, 'not-configured');
		assert.strictEqual(processes[0]?.killed, true);
		assert.strictEqual((await manager.status()).state, 'not-configured');
	});

	test('dispose encerra o processo gerenciado', async () => {
		const { manager, processes } = await make();
		await manager.connectManaged();
		manager.dispose();
		assert.strictEqual(processes[0]?.killed, true);
	});

	test('modo manual conectado: o health autentica e o processo não é encerrado', async () => {
		const { manager, urls, processes } = await make();
		const result = await manager.connectManual({
			baseUrl: 'http://127.0.0.1:51000',
			password: 'senha-do-usuario',
		});

		assert.strictEqual(result.done, true);
		assert.deepStrictEqual(urls, ['http://127.0.0.1:51000/global/health']);

		// Desconectar esquece a senha — e não há processo nosso para encerrar.
		const disconnected = await manager.disconnect();
		assert.strictEqual(disconnected.done, true);
		assert.strictEqual(disconnected.state.state, 'not-configured');
		assert.strictEqual(processes.length, 0, 'um servidor manual nunca vira processo nosso');
	});

	test('dispose no modo manual não encerra processo nenhum', async () => {
		const { manager, processes } = await make();
		await manager.connectManual({ baseUrl: 'http://127.0.0.1:51005', password: 'senha' });
		manager.dispose();
		assert.strictEqual(processes.length, 0);
		assert.deepStrictEqual(processes, [], 'nada foi iniciado nem morto');
	});

	test('modo manual com senha errada é "autenticação inválida"', async () => {
		const { manager } = await make({ health: { statuses: [401] } });
		const result = await manager.connectManual({
			baseUrl: 'http://127.0.0.1:51001',
			password: 'errada',
		});
		assert.strictEqual(result.done, false);
		assert.strictEqual(result.state.state, 'auth-invalid');
	});

	test('modo manual sem resposta é "servidor indisponível"', async () => {
		const { manager } = await make({ health: { statuses: [0], throwOn: [0, 1, 2] } });
		const result = await manager.connectManual({
			baseUrl: 'http://127.0.0.1:51002',
			password: 'qualquer',
		});
		assert.strictEqual(result.done, false);
		assert.strictEqual(result.state.state, 'unavailable');
	});

	test('endereço HTTP remoto é recusado antes de qualquer requisição', async () => {
		const { manager, urls } = await make();
		const result = await manager.connectManual({
			baseUrl: 'http://exemplo.com:4096',
			password: 'x',
		});
		assert.strictEqual(result.done, false);
		assert.strictEqual(result.state.state, 'unavailable');
		assert.strictEqual(urls.length, 0, 'nada pode sair para um destino recusado');
	});

	test('endereço inválido e senha vazia são recusados', async () => {
		const { manager, urls } = await make();
		const invalid = await manager.connectManual({ baseUrl: 'nao e url', password: 'x' });
		assert.strictEqual(invalid.state.state, 'unavailable');

		const noPassword = await manager.connectManual({ baseUrl: 'http://127.0.0.1:51003', password: '  ' });
		assert.strictEqual(noPassword.done, false);
		assert.strictEqual(urls.length, 0);
	});

	test('o registro é gravado e lido na próxima execução', async () => {
		const { manager } = await make();
		await manager.connectManual({ baseUrl: 'http://127.0.0.1:51004', password: 'senha' });

		const record = await new OpencodeRecordStore(join(root, 'opencode.json')).read();
		assert.strictEqual(record.kind, 'present');
		if (record.kind === 'present') {
			assert.strictEqual(record.record.mode, 'manual');
			assert.strictEqual(record.record.baseUrl, 'http://127.0.0.1:51004');
		}
	});

	/**
	 * Um registro de execução anterior, gravado antes do gerenciador nascer.
	 */
	async function preset(record: Record<string, unknown>): Promise<void> {
		await new OpencodeRecordStore(join(root, 'opencode.json')).write({
			version: 1,
			since: new Date().toISOString(),
			...record,
		} as never);
	}



	test('uma leitura durante a restauração vê o registro, não "nunca configurado"', async () => {
		await preset({ mode: 'manual', baseUrl: 'http://127.0.0.1:51006' });

		const built = await make();
		// A primeira leitura chega durante a restauração do construtor.
		const status: OpencodeState = await built.manager.status();

		assert.strictEqual(status.state, 'disconnected');
		assert.strictEqual((status as { baseUrl?: string }).baseUrl, 'http://127.0.0.1:51006');
		assert.strictEqual(built.urls.length, 0, 'sem a senha gravada, nada pode sair');
	});
	test('um registro gerenciado de execução anterior aparece como desconectado', async () => {
		await preset({ mode: 'managed', baseUrl: 'http://127.0.0.1:45010', port: 45010 });

		const { manager, settle } = await make();
		await settle();
		const status: OpencodeState = await manager.status();

		assert.strictEqual(status.state, 'disconnected');
		assert.ok(/não sobreviveu/.test((status as { reason?: string }).reason ?? ''));
	});

	test('um registro com campo de credencial é recusado na leitura', async () => {
		const path = join(root, 'opencode.json');
		await writeFile(
			path,
			JSON.stringify({ version: 1, mode: 'manual', baseUrl: 'http://127.0.0.1:1', since: 'x', password: 'segredo' }),
			'utf8',
		);
		const read = await new OpencodeRecordStore(path).read();
		assert.strictEqual(read.kind, 'corrupt');
	});

	test('o registro serializado não tem campo de senha', () => {
		const text = serializeOpencodeRecord({
			version: 1,
			mode: 'managed',
			baseUrl: 'http://127.0.0.1:1',
			port: 1,
			since: '2026-01-01T00:00:00.000Z',
		});
		const parsed = JSON.parse(text) as Record<string, unknown>;
		assert.deepStrictEqual(Object.keys(parsed).sort(), ['baseUrl', 'mode', 'port', 'since', 'version']);
	});
});
