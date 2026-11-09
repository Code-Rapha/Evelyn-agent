/**
 * O serviço local iniciado pelo próprio app.
 *
 * ## Por que um processo separado
 *
 * A raiz de dados tem **um dono** (`mountCore`). Quem monta o Core é dono dela.
 * O modo conectado existe justamente para que esse dono seja o serviço — um
 * processo que continua de pé quando a janela fecha — e o Electron fique como
 * cliente. Hospedar o servidor dentro do Electron seria o contrário: um Core
 * só, controlado pela janela.
 *
 * ## Como ele roda no pacote
 *
 * O `app.asar` não contém o bundle do serviço, e o Electron não é Node. Por
 * isso o serviço roda no **próprio `Seshyina.exe`** com `ELECTRON_RUN_AS_NODE=1`
 * e o script extraído para `userData/service/main.js`, ao lado dos assets. O
 * mesmo binário, dois papeis — e nada instalado à parte.
 *
 * ## Os quatro cuidados que este módulo existe para garantir
 *
 * 1. **Um processo por raiz.** Antes de iniciar, pergunta ao registro: já há
 *    serviço ativo? Então conecta. Já há registro de processo morto? Remove e
 *    inicia. Nunca há dois tentando a mesma raiz — o lock é a última palavra,
 *    e quem perde é recusado, não forçado.
 * 2. **Pronto antes de usar.** Devolver `connected` só depois de o health
 *    responder **autenticado**, com o pid e a porta do registro.
 * 3. **Falha vira fallback, não vira espera.** Prazo curto e explícito: se o
 *    serviço não ficar pronto, a resposta é `unavailable` com o motivo, e o
 *    chamador segue em modo local sem tocar em nenhum arquivo.
 * 4. **Encerrar é pedir, não matar.** O pedido vai pelo mesmo
 *    `POST /api/service/shutdown` que o `--stop` usa, para o serviço soltar a
 *    trava e apagar o registro. Matar deixaria os dois para trás.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { probeService } from './discoverService';
import { readServiceRecord, removeServiceRecord } from './serviceRecord';
import { stopService, waitForStop } from './serviceLifecycle';

/** Quanto tempo o serviço tem para ficar pronto. */
export const SERVICE_READY_TIMEOUT_MS = 20_000;

/** Intervalo entre as perguntas de health enquanto espera. */
const POLL_INTERVAL_MS = 250;

/** O que o chamador precisa saber depois do start. */
export type ServiceStartOutcome =
	| {
			readonly kind: 'connected';
			readonly pid: number;
			readonly port: number;
			readonly version?: string;
	  }
	| {
			/** O serviço não ficou pronto: o app abre em modo local. */
			readonly kind: 'unavailable';
			readonly reason: string;
	  };

export interface StartServiceOptions {
	/** A raiz de dados — a mesma que o serviço vai tomar. */
	readonly root: string;
	/** O executável a usar. No pacote é o próprio `Seshyina.exe`. */
	readonly execPath: string;
	/** O diretório onde o script do serviço já está extraído. */
	readonly serviceDir: string;
	/** O material do serviço (main.js e assets), para extrair quando faltar. */
	readonly material: () => Promise<ServiceMaterial>;
	readonly waitMs?: number;
	/** Inicia o processo. Injetado em teste. */
	readonly spawnProcess?: (input: {
		readonly execPath: string;
		readonly entry: string;
		readonly root: string;
	}) => ChildProcess;
}

/** O que é preciso escrever em disco para o serviço rodar. */
export interface ServiceMaterial {
	readonly main: string;
	readonly packageJson: string;
	readonly assets: Readonly<Record<string, string>>;
}

const READY_MARKER = /servidor local/i;

/**
 * Garante o serviço pronto para esta raiz.
 *
 * Nunca lança: cada desfecho é um veredito. Um erro de start vira
 * `unavailable`, com o motivo — o chamador abre em modo local e diz na tela.
 */
export async function ensureService(
	options: StartServiceOptions,
): Promise<ServiceStartOutcome> {
	const waitMs = options.waitMs ?? SERVICE_READY_TIMEOUT_MS;

	// 1) Já há um serviço desta raiz? Conecta — sem iniciar outro.
	const existing = await probeService({ root: options.root });
	if (existing.kind === 'active') {
		return {
			kind: 'connected',
			pid: existing.record.pid,
			port: existing.record.port,
			...(existing.health.version !== undefined ? { version: existing.health.version } : {}),
		};
	}
	if (existing.kind === 'incompatible') {
		// Versão com outro protocolo: o registro é desta instalação, mas o
		// serviço é de outra. Ele sai, para a próxima abertura não ficar presa
		// a um aviso permanente; os dados não são tocados, e o serviço antigo,
		// se estiver de pé, ainda é dono da raiz até soltá-la.
		const record = await readServiceRecord(options.root);
		if (record.kind === 'ok') {
			await removeServiceRecord(options.root, record.record.pid).catch(() => undefined);
		}
		return {
			kind: 'unavailable',
			reason: `o serviço fala o protocolo ${existing.protocol}, e este app fala outro`,
		};
	}
	// Registro de processo morto, inválido, de um serviço que **não é** o nosso
	// (responde outra coisa na porta) ou de uma versão com outro protocolo:
	// nenhum deles leva a um serviço utilizável por este app. O registro sai
	// antes do spawn — deixá-lo faria o próximo `probe` achar o mesmo fantasma,
	// e o app nunca sairia do aviso "serviço incompatível".
	//
	// A remoção é do **arquivo de registro**, nunca dos dados do usuário: o
	// serviço antigo, se estiver de pé, continua sendo dele até soltar a raiz
	// sozinho — e o spawn seguinte vai encontrá-la ocupada e dizer isso.
	if (
		existing.kind === 'stale' ||
		existing.kind === 'invalid' ||
		existing.kind === 'unresponsive'
	) {
		const record = await readServiceRecord(options.root);
		if (record.kind === 'ok') {
			await removeServiceRecord(options.root, record.record.pid).catch(() => undefined);
		}
	}

	// 2) O script do serviço precisa existir antes de qualquer spawn.
	let entry: string;
	try {
		entry = await prepare(options);
	} catch (error) {
		return {
			kind: 'unavailable',
			reason: `não foi possível preparar o serviço: ${messageOf(error)}`,
		};
	}

	// 3) Inicia e espera o health — não a janela, não o "processo existe".
	const spawnProcess = options.spawnProcess ?? defaultSpawn;
	let child: ChildProcess;
	try {
		child = spawnProcess({ execPath: options.execPath, entry, root: options.root });
	} catch (error) {
		return { kind: 'unavailable', reason: `não foi possível iniciar o serviço: ${messageOf(error)}` };
	}

	// O que o processo escreveu antes de morrer é a única pista de por que não
	// subiu. Guardado curto, e nunca em log permanente.
	let stderr = '';
	child.stderr?.on('data', (chunk: Buffer | string) => {
		stderr = `${stderr}${String(chunk)}`.slice(-2_000);
	});
	let exited: { readonly code: number | null } | undefined;
	child.on('exit', (code) => {
		exited = { code };
	});

	const deadline = Date.now() + waitMs;
	for (;;) {
		if (exited !== undefined) {
			return {
				kind: 'unavailable',
				reason:
					`o serviço encerrou ao iniciar (código ${exited.code ?? 'nulo'})` +
					(stderr.trim().length > 0 ? `: ${stderr.trim().split(/\r?\n/).slice(-3).join(' | ')}` : ''),
			};
		}
		const probe = await probeService({ root: options.root });
		if (probe.kind === 'active') {
			return {
				kind: 'connected',
				pid: probe.record.pid,
				port: probe.record.port,
				...(probe.health.version !== undefined ? { version: probe.health.version } : {}),
			};
		}
		if (Date.now() > deadline) {
			// A última tentativa de encerrar o que ficou meio vivo: um processo
			// que nunca respondeu ao health não deve continuar segurando a raiz
			// enquanto o app abre em modo local.
			await shutdownQuietly(child, options.root);
			return {
				kind: 'unavailable',
				reason:
					`o serviço não ficou pronto em ${Math.round(waitMs / 1000)}s` +
					(stderr.trim().length > 0 ? `: ${stderr.trim().split(/\r?\n/).slice(-3).join(' | ')}` : ''),
			};
		}
		await delay(POLL_INTERVAL_MS);
	}
}

/**
 * Encerra o serviço desta raiz, se for dele.
 *
 * Pede pelo HTTP autenticado e espera o registro sumir; só então o processo é
 * considerado encerrado. Um serviço que não responde não é morto por aqui —
 * `stopService` recusa o que não prova ser o serviço, e essa recusa é a
 * resposta certa.
 */
export async function shutdownService(root: string): Promise<{ readonly stopped: boolean; readonly reason?: string }> {
	const result = await stopService({ root });
	if (result.kind === 'stopped') {
		await waitForStop({ root }).catch(() => undefined);
		return { stopped: true };
	}
	if (result.kind === 'not-running') {
		return { stopped: true };
	}
	return { stopped: false, reason: result.reason };
}

/** Melhor esforço: um start que falhou não pode deixar raiz presa. */
async function shutdownQuietly(child: ChildProcess, root: string): Promise<void> {
	await shutdownService(root).catch(() => undefined);
	// Sem registro e sem resposta: o processo que nós mesmos criamos não serve
	// para nada, e ficar vivo só atrapalha a próxima tentativa.
	if (child.pid !== undefined && child.exitCode === null) {
		child.kill();
	}
}

/** Extrai o script e os assets do serviço para `serviceDir`, se faltar. */
async function prepare(options: StartServiceOptions): Promise<string> {
	const entry = join(options.serviceDir, 'main.js');
	await mkdir(options.serviceDir, { recursive: true });
	const material = await options.material();
	await writeFile(entry, material.main, 'utf8');
	await writeFile(join(options.serviceDir, 'package.json'), material.packageJson, 'utf8');
	await mkdir(join(options.serviceDir, 'assets'), { recursive: true });
	for (const [name, content] of Object.entries(material.assets)) {
		await writeFile(join(options.serviceDir, 'assets', name), content, 'utf8');
	}
	// O manifesto diz a versão ao health; o `__dirname` dele é `serviceDir`.
	return entry;
}

/**
 * O spawn de verdade.
 *
 * `ELECTRON_RUN_AS_NODE=1` faz o `Seshyina.exe` se comportar como Node — o
 * mesmo truque usado por processos auxiliares do Electron. Sem ele, o app
 * abriria uma segunda janela em vez de rodar o script.
 */
function defaultSpawn(input: {
	readonly execPath: string;
	readonly entry: string;
	readonly root: string;
}): ChildProcess {
	return spawn(input.execPath, [input.entry, '--root', input.root], {
		detached: true,
		stdio: ['ignore', 'ignore', 'pipe'],
		windowsHide: true,
		env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
	});
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** O diretório do script do serviço, ao lado do `userData` do app. */
export function serviceDirectoryFor(userDataPath: string): string {
	return join(dirname(userDataPath), `${basenameOf(userDataPath)}-service`);
}

function basenameOf(path: string): string {
	const parts = path.split(/[\\/]/).filter((part) => part.length > 0);
	return parts[parts.length - 1] ?? 'Seshyina';
}

/** Terceira leitura: o marcador de pronto existe? (para teste) */
export function isReadyOutput(text: string): boolean {
	return READY_MARKER.test(text);
}
