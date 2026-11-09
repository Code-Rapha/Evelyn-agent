/**
 * A ponte entre o host Electron e as ferramentas DEV (DEV-5).
 *
 * ## O problema que este módulo resolve
 *
 * A DEV-2 construiu a sessão DEV (`DevSession`, em memória, com raiz fixada
 * pelo host) e as ferramentas (`dev_read`, `dev_write`, ...). A DEV-3 construiu
 * o fluxo transacional (`applyChange`/`applyPrepared`). A DEV-4, o alvo do
 * host (`electronApply`). O que faltava era **ligar as três**: um lugar no
 * processo principal que, quando o proprietário pedir, monte os `DevToolDeps`
 * com a sessão viva e o alvo real — e nada mais.
 *
 * ## O que este módulo **não** faz
 *
 * - Não tem interface (a do modo DEV é a DEV-6).
 * - Não abre sessão sozinho: `enter()` só acontece por `ownerRequest()`.
 * - Não recebe mensagem do usuário, argumento de ferramenta nem arquivo: o
 *   proprietário age pelo host, e o que ele autoriza é **a raiz** — o host
 *   declara qual é o repositório, como já declarava a raiz padrão dos dados.
 * - Não conhece o `ChatSession`: devolve `DevToolDeps` e quem monta o chat
 *   liga os dois. É o host que decide, com `dev=`, se as ferramentas entram no
 *   stack do agente.
 *
 * ## A raiz: por que é `$MODELHUB_DEV_ROOT`, e o que isso quer dizer
 *
 * O pacote instalado (`dist/release/Seshyina-win32-x64/resources/app.asar`)
 * **não é** o repositório: não tem `.git`, então o modo DEV não pode operar
 * nele — e fingir que pode seria a maior das mentiras desta etapa. Em
 * desenvolvimento, a raiz é o próprio `G:\ModelHub`; um app empacotado aponta
 * para o checkout com a variável de ambiente. Ausente, ou sem `.git`,
 * `DevHost.setup()` responde `repo: false` e o chat **não** recebe `dev=`: o
 * gatilho não é registrado para o agente. É a lacuna honesta: o modo DEV hoje
 * melhora o checkout, e o instalado exige reinstalar o pacote.
 *
 * ## Sem sessão, sem ferramentas
 *
 * As ferramentas DEV **só** entram no stack quando há sessão ativa. O dono do
 * chat chama `refreshTools()` depois de `enter()` e as ferramentas aparecem;
 * depois de `exit()`, somem. Antes, a garantia era que cada execução
 * respondesse "modo DEV não está ativo" — verdade, mas ainda expunha ao modelo
 * cinco ferramentas que ele não podia usar. Agora elas nem existem.
 */

import { join, resolve } from 'node:path';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

import { DevSession, type DevSessionRef, type DevSessionStatus } from '../core/dev/devSession';
import { DevCheckpointStore } from '../core/dev/devCheckpoint';
import { DevOperationStore } from '../core/dev/devOperation';
import { isUnfinished } from '../core/dev/devOperation';
import { DevRunner, type DevApprovalDecision, type DevApprovalRequest } from '../core/dev/devRunner';
import { FileDevAudit, type DevAuditRecord } from '../core/dev/devAudit';
import { DevLocks, resourceKeyFor } from '../core/dev/devLocks';
import {
	claimSessionLock,
	canonicalRoot,
	readLockOwnerFile,
	devLockHeldByLiveOwner,
	releasePriorLock,
	releaseSessionLock,
} from '../core/dev/devFileLock';
import { inspectCheckpointRestore } from '../core/dev/checkpointRestoreCheck';
import { toOperationView, type DevPanelState, type DevAuthorizationActions, type DevAuthorizationView } from '../core/dev/devPanel';
import { activationVerdict, type LocalInstance } from './localInstance';
import type { OwnerCredentialStore } from './ownerCredential';
import { MIN_PASSWORD_LENGTH } from './ownerCredential';
import type { OwnerPromptBroker } from './ownerPrompt';
import type { PersistentUnlockStore } from './devPersistentUnlock';
import { createDevApplyTool } from '../core/agent/devApplyTool';
import { DevRestoreConflictError } from '../core/dev/devCheckpoint';
import { PreparedChangeJournal } from '../core/dev/preparedChange';
import { createElectronApplyTarget, type ElectronApplyHost } from '../core/dev/electronApply';
import type { ApplyTarget } from '../core/dev/devApply';
import type { DevToolDeps } from '../core/agent/devTools';
import { withDevRepositoryLock } from '../core/agent/devTools';
import { AgentError } from '../core/errors';
import { classifyPath, protectedMessage } from '../core/dev/devPolicy';
import { Workspace } from '../core/agent/workspace';

/**
 * A mensagem de um estado de credencial, para `activationBlockedReason`.
 *
 * Um só lugar: a página mostra exatamente o que o host decidiu, e o estado
 * "por que não dá" fala da credencial antes de qualquer outro motivo.
 */
function credentialMessage(view: DevAuthorizationView): string {
	switch (view.kind) {
		case 'not-configured':
			return 'configure a autorização local antes de ativar o modo DEV';
		case 'blocked':
			return `tentativas demais; tente de novo depois de ${new Date(view.until).toLocaleString()}`;
		case 'corrupt':
			return 'a credencial local está ilegível; use a recuperação para configurar de novo';
		case 'invalidated':
			return view.message;
		case 'unavailable':
			return view.reason;
		case 'configured':
			return '';
	}
}

/**
 * Escreve um arquivo do repositório com a **mesma** fronteira do `dev_write`.
 *
 * O fluxo de aplicação precisa reescrever os arquivos no ponto em que a
 * mudança vale; se ele usasse um `writeFile` cru, uma operação preparada com
 * um caminho que passou pela política poderia ser aplicada depois de a
 * política ficar mais rígida. Aqui a fronteira é revalidada no momento da
 * escrita: `Workspace.resolveInsideForCreate` (dentro da raiz) e
 * `classifyPath` (arquivos protegidos), como em `safePath`.
 */
async function writeRepositoryFile(session: DevSessionRef, path: string, content: string): Promise<void> {
	const workspace = new Workspace(session.root());
	const resolved = await workspace.resolveInsideForCreate(path);
	const verdict = classifyPath(resolved);
	if (verdict.protected) {
		throw new AgentError(protectedMessage(path, verdict));
	}
	const { mkdir, writeFile } = await import('node:fs/promises');
	await mkdir(join(resolved, '..'), { recursive: true });
	await writeFile(resolved, content, 'utf8');
}

/**
 * A janela do host, no formato que o adaptador da DEV-4 entende.
 *
 * Se a janela ainda não existe, as operações falham com `ApplyHostError` em
 * vez de "não fazer nada": o fluxo precisa saber que não aplicou.
 */
function hostFrom(window: () => DevHostWindow | undefined): ElectronApplyHost {
	const require = (): DevHostWindow => {
		const candidate = window();
		if (candidate === undefined) {
			throw new Error('a janela principal não existe; não há onde aplicar a mudança');
		}
		return candidate;
	};
	return {
		isWindowAlive: () => window()?.isWindowAlive() ?? false,
		isWindowReady: () => window()?.isWindowReady() ?? false,
		reloadWindow: async (timeoutMs) => require().reloadWindow(timeoutMs),
		restartApplication: async () => require().restartApplication(),
	};
}

/** O que o host precisa oferecer para o alvo real (o `mainWindow`). */
export interface DevHostWindow {
	/** A janela principal existe e não foi destruída? */
	isWindowAlive(): boolean;
	/** A janela está pronta para receber eventos? */
	isWindowReady(): boolean;
	/** Recarrega a página; resolve quando o carregamento termina. */
	reloadWindow(timeoutMs: number): Promise<void>;
	/** Reinicia o aplicativo (uma vez, por fluxo). */
	restartApplication(): Promise<void>;
}

export interface DevHostOptions {
	/**
	 * Onde o host declara manter o repositório DEV.
	 *
	 * Vem do ambiente do processo — não de mensagem, ferramenta ou arquivo do
	 * projeto. Ausente: o diretório de trabalho (o checkout, em desenvolvimento).
	 */
	readonly repositoryRoot?: string;
	/** O diretório de dados (`<raiz>/`), onde ficam `dev/` e os checkpoints. */
	readonly dataRoot: string;
	/** A janela principal, resolvida **na hora** (ela pode não existir ainda). */
	readonly window: () => DevHostWindow | undefined;
	/** Registro de diagnóstico (nunca recebe segredo nem conteúdo de arquivo). */
	readonly log?: (message: string) => void;
	/**
	 * A verificação do fluxo, quando se quer julgar **o fluxo** e não os
	 * comandos.
	 *
	 * Ausente, é o `DevRunner` (allowlist, prazo, teto de saída) rodando os
	 * comandos do projeto. Um teste injeta a sua — mas nunca em produção, e a
	 * lista de verificações continua vindo de `REQUIRED_CHECKS`, não do
	 * teste.
	 */
	readonly runCheck?: (
		command: string,
	) => Promise<{ readonly exitCode: number; readonly summary: string }>;
	/** Relógio, injetável em teste. */
	readonly now?: () => Date;
	/**
	 * A confirmação de instância do host (DEV-6).
	 *
	 * Ausente = a ativação pela interface fica indisponível, com motivo. Nunca
	 * existe um "modo teste" que a dispense.
	 */
	readonly readLocalInstance?: () => Promise<LocalInstance>;
	/**
	 * A credencial local do proprietário (DEV-7).
	 *
	 * Ausente = não há como autorizar pela interface, por mais clique que
	 * venha: `activateFromPanel` recusa. Nunca há um "modo de desenvolvimento"
	 * que a dispense.
	 */
	readonly credential?: OwnerCredentialStore;
	/** A pergunta de autorização (DEV-7). Ausente = ativação indisponível. */
	readonly prompt?: OwnerPromptBroker;
	/**
	 * O executor do DPAPI e o que "configurar"/a recuperação podem fazer.
	 *
	 * Presentes só no host de produção (e nos testes de fluxo). Ausentes =
	 * configurar e recuperar pela interface ficam indisponíveis, com motivo.
	 */
	readonly ownerActions?: {
		readonly configure: (password: string, confirmation: string) => Promise<{ readonly ok: boolean; readonly message: string }>;
		readonly reset: () => Promise<{ readonly ok: boolean; readonly message: string }>;
	};
	/**
	 * O desbloqueio persistente do DEV (lembrar neste dispositivo).
	 *
	 * Ausente = o recurso some da interface e da API: a ativação continua
	 * pedindo a senha toda vez, exatamente como antes. Presente = a senha pode
	 * ser lembrada **se o proprietário pedir**; nada é gravado sem esse pedido.
	 */
	readonly persistentUnlock?: PersistentUnlockStore;
}

/** O que o dono do chat precisa saber depois de uma tentativa. */
export type DevHostState =
	| { readonly repo: false; readonly reason: string }
	| {
			readonly repo: true;
			readonly root: string;
			readonly session: 'inactive' | 'active';
			readonly startedAt?: string;
	  };

/**
 * O host do modo DEV.
 *
 * `setup()` tenta **uma vez**; falhar não é erro — é "não há repositório DEV
 * neste host", e o app continua sem o modo.
 */
export class DevHost {
	private session: DevSession | undefined;
	private root: string | undefined;
	private reason: string | undefined;
	private deps: DevToolDeps | undefined;
	private targets = 0;
	private readonly journal = new PreparedChangeJournal();
	private readonly checkpoints: DevCheckpointStore;
	private readonly operations: DevOperationStore;
	private readonly locks = new DevLocks();
	private readonly runner: DevRunner;
	/** O diário das execuções do `dev_run` (DEV-9.1). */
	private readonly audit: FileDevAudit;
	private lock: { readonly token: string } | undefined;
	private chat: {
		setDevTools(dev: DevToolDeps | undefined): void;
		runWithoutDev?<T>(work: () => Promise<T>): Promise<T>;
	} | undefined;
	/**
	 * A autorização concedida **pelo host** (DEV-6).
	 *
	 * Só existe enquanto esta instância do host a mantiver. Não é gravada em
	 * disco: um processo novo nunca tem uma. `null` = não concedida.
	 */
	private grant: {
		readonly sessionId: string;
		readonly grantedAt: string;
		/** O verifier da credencial que autorizou (DEV-7): a sessão vale enquanto ele existir. */
		readonly binding?: string;
	} | null = null;
	/**
	 * A autorização que existia antes de um reinício (DEV-6).
	 *
	 * Existe só para **apresentar** o estado depois de voltar e para soltar a
	 * trava que este processo deixou. Nunca reativa nada: a sessão só abre com
	 * uma nova concessão, que por sua vez exige a confirmação da interface.
	 */
	private pendingRestore: { readonly sessionId: string; readonly lockToken: string } | null = null;
	/** Evita duas restaurações/ativações concorrentes do mesmo painel. */
	private busy = false;

	constructor(private readonly options: DevHostOptions) {
		this.checkpoints = new DevCheckpointStore(join(options.dataRoot, 'dev'));
		this.operations = new DevOperationStore(join(options.dataRoot, 'dev'));
		// DEV-9.1: o diário fica em disco, ao lado do estado do host, para o
		// histórico sobreviver ao turno. Só comando, diretório, decisão e
		// números — nunca a saída.
		this.audit = new FileDevAudit(join(options.dataRoot, 'dev', 'runs.jsonl'));
		this.runner = new DevRunner({ timeoutMs: 10 * 60_000, audit: this.audit });
	}

	/**
	 * A aprovação de um comando do `dev_run` (DEV-9.1).
	 *
	 * Uma pergunta por comando, com o texto exato. A resposta vale só para
	 * aquela chamada: o runner a consome antes de cada execução e não guarda
	 * nada entre elas.
	 *
	 * Sem `prompt` (host de teste, ou ativação indisponível), a aprovação
	 * não acontece e o `dev_run` fica sem ela — o comportamento anterior. O
	 * documento de limitações diz com todas as letras que, nesse modo, não há
	 * aprovação.
	 */
	private async approveCommand(request: DevApprovalRequest): Promise<DevApprovalDecision> {
		const prompt = this.options.prompt;
		if (prompt === undefined) {
			return 'approved';
		}
		const answer = await prompt.ask('run-command', {
			title: 'Aprovar a execução de um comando',
			detail:
				`Comando: ${request.command}\n` +
				`Diretório: ${request.cwd}\n` +
				`Escopo: ${request.scope}\n` +
				`Prazo: ${Math.round(request.timeoutMs / 1000)}s\n\n` +
				'O comando roda com as permissões do seu usuário. Ele não é isolado: ' +
				'os arquivos que ele abrir dependem do que o programa fizer, não desta confirmação.',
		});
		if (answer.kind === 'approved') {
			return 'approved';
		}
		if (answer.kind === 'answered') {
			return 'approved';
		}
		return answer.kind === 'cancelled' ? 'cancelled' : 'refused';
	}

	/** O histórico das execuções do `dev_run`, mais recente primeiro. */
	async runHistory(limit = 20): Promise<readonly DevAuditRecord[]> {
		return await this.audit.list(limit);
	}

	/** A raiz do diretório de dados, para o arquivo de estado do host. */
	private get hostStateFile(): string {
		return join(this.options.dataRoot, 'dev', 'host-state.json');
	}

	/**
	 * Diz ao chat qual `dev=` ele tem agora (DEV-5).
	 *
	 * Chamado pelo host ao abrir e ao encerrar. Sem sessão, passa
	 * `undefined`: o próximo turno monta o stack **sem** as ferramentas DEV,
	 * então nem `dev_apply` nem `dev_write` existem para o modelo. Não é uma
	 * checagem que a ferramenta faz depois — é a ferramenta não existir.
	 */
	attach(chat: {
		setDevTools(dev: DevToolDeps | undefined): void;
		runWithoutDev?<T>(work: () => Promise<T>): Promise<T>;
	}): void {
		this.chat = chat;
		chat.setDevTools(this.toolDeps());
	}

	/** Roda algo com as ferramentas DEV fora do stack (DEV-6: a aplicação). */
	private async withoutDevTools<T>(work: () => Promise<T>): Promise<T> {
		const chat = this.chat;
		if (chat?.runWithoutDev === undefined) {
			return work();
		}
		return chat.runWithoutDev(work);
	}

	/**
	 * Verifica a raiz e guarda a sessão — **sem** entrar nela.
	 *
	 * Idempotente: o segundo `setup` só responde o estado. A entrada exige
	 * `ownerRequest()` — e, desde a DEV-6, uma confirmação do host.
	 *
	 * Também lê o que existia antes de um reinício: se o processo anterior
	 * deixou uma autorização, ela vira `pendingRestore` — **nunca** sessão
	 * ativa. É o suficiente para a interface dizer "havia uma sessão DEV ativa
	 * antes de reiniciar; confirme para reabrir".
	 */
	async setup(): Promise<DevHostState> {
		if (this.root !== undefined || this.reason !== undefined) {
			return this.state();
		}
		const declared = this.options.repositoryRoot ?? process.cwd();
		try {
			const root = await canonicalRoot(resolve(declared));
			const marker = await stat(join(root, '.git')).catch(() => undefined);
			if (marker === undefined) {
				this.reason =
					`o modo DEV precisa de um checkout do repositório: "${root}" não é um ` +
					'(não há .git). O app instalado não é o repositório — aponte MODELHUB_DEV_ROOT para o checkout.';
				this.options.log?.(this.reason);
				return this.state();
			}
			await this.checkpoints.init();
			this.session = new DevSession({
				repositoryRoot: root,
				...(this.options.now !== undefined ? { now: this.options.now } : {}),
			});
			this.root = root;
			this.pendingRestore = await this.loadPriorGrant(root);
			return this.state();
		} catch (error) {
			this.reason = error instanceof Error ? error.message : String(error);
			this.options.log?.(`o modo DEV não está disponível: ${this.reason}`);
			return this.state();
		}
	}

	/** Lê o estado do processo anterior, se houver, for desta raiz e ainda existir. */
	private async loadPriorGrant(
		root: string,
	): Promise<{ readonly sessionId: string; readonly lockToken: string } | null> {
		let sessionId: string;
		let lockToken: string;
		try {
			const raw = await readFile(this.hostStateFile, 'utf8');
			const parsed = JSON.parse(raw) as Record<string, unknown>;
			const sameRoot = typeof parsed['root'] === 'string' && parsed['root'].toLowerCase() === root.toLowerCase();
			const readId = parsed['sessionId'];
			const readToken = parsed['lockToken'];
			if (!sameRoot || typeof readId !== 'string' || typeof readToken !== 'string') {
				return null;
			}
			sessionId = readId;
			lockToken = readToken;
		} catch {
			return null;
		}
		// DEV-8.4: o arquivo só basta quando descreve algo que **existe**.
		// Medido no executável empacotado: depois de a DEV-8.3 terminar sem o
		// encerramento, o arquivo ficou com o token de uma sessão que já tinha
		// acabado (nenhum processo, nenhuma trava). O painel então dizia
		// `pending-restore` e desabilitava "Ativar modo DEV" — a sessão não
		// podia ser autorizada de novo, e reiniciar o app nunca a liberava.
		// Os dois casos honestos são os dois que ainda têm dono: a trava
		// órfã com este token (o app saiu sem soltar) ou outro processo
		// segurando a trava. Um token órfão sem trava é histórico.
		const lock = await readLockOwnerFile(root).catch(() => ({ kind: 'free' } as const));
		const ownsLock = lock.kind === 'held' && lock.token === lockToken;
		if (!ownsLock && lock.kind !== 'held') {
			await rm(this.hostStateFile, { force: true }).catch(() => undefined);
			this.options.log?.('dev: estado do processo anterior já não descreve uma sessão; descartado');
			return null;
		}
		return { sessionId, lockToken };
	}

	/** Concede a autorização do host. Não abre a sessão; isso é do `ownerRequest`. */
	async grantFromHost(sessionId: string): Promise<void> {
		this.grant = { sessionId, grantedAt: (this.options.now ?? (() => new Date()))().toISOString() };
	}

	/**
	 * O estado da credencial local para a página (DEV-7).
	 *
	 * Devolve **só** rótulos e datas: nem salt, nem verifier, nem blob, nem
	 * senha. `actions.canConfigure` diz se há como configurar/recuperar neste
	 * host; `canReset` se a recuperação é o caminho (arquivo ilegível).
	 */
	private async credentialView(): Promise<{
		readonly view: DevAuthorizationView;
		readonly actions: DevAuthorizationActions;
	}> {
		const actions: DevAuthorizationActions = {
			canConfigure: this.options.credential !== undefined && this.options.ownerActions !== undefined,
			canReset: false,
		};
		const store = this.options.credential;
		if (store === undefined) {
			return {
				view: {
					kind: 'unavailable',
					reason: 'este host não configura a credencial local do proprietário',
				},
				actions,
			};
		}
		const state = await store.state();
		switch (state.kind) {
			case 'not-configured':
				return {
					view: {
						kind: 'not-configured',
						message: 'configure uma senha local para autorizar o modo DEV',
					},
					actions,
				};
			case 'configured':
				return {
					view: { kind: 'configured', configuredAt: state.configuredAt, user: state.user },
					actions,
				};
			case 'blocked':
				return { view: { kind: 'blocked', until: state.until, failures: state.failures }, actions };
			case 'corrupt':
				return {
					view: {
						kind: 'corrupt',
						reason: state.reason,
						canReset: actions.canConfigure,
					},
					actions: { ...actions, canReset: actions.canConfigure },
				};
			case 'unavailable':
				return { view: { kind: 'unavailable', reason: state.reason }, actions };
		}
	}

	/** Configura a credencial: a senha vem da pergunta do host, nunca da página. */
	async configureFromPanel(): Promise<DevPanelState> {
		if (this.busy) {
			throw new Error('há uma ação DEV em andamento');
		}
		const actions = this.options.ownerActions;
		const prompt = this.options.prompt;
		if (actions === undefined || prompt === undefined) {
			throw new Error('configurar a credencial não está disponível neste host');
		}
		this.busy = true;
		try {
			const answer = await prompt.ask('configure', {
				title: 'Configurar a autorização local',
				detail:
					'Defina a senha que autoriza o modo DEV neste computador. Ela é guardada protegida pelo ' +
					'Windows (DPAPI, para esta conta) e pedida de novo a cada ativação. Não é a senha do Windows.',
				minLength: MIN_PASSWORD_LENGTH,
			});
			if (answer.kind !== 'answered' || answer.confirmation === undefined) {
				throw new Error(
					answer.kind === 'cancelled'
						? 'configuração cancelada'
						: answer.kind === 'expired'
							? 'a pergunta expirou'
							: answer.kind === 'rejected'
								? `configuração recusada: ${answer.reason}`
								: 'configuração recusada',
				);
			}
			const result = await actions.configure(answer.password, answer.confirmation);
			if (!result.ok) {
				throw new Error(result.message);
			}
			this.options.log?.('credencial local do proprietário configurada');
			return await this.panelState();
		} finally {
			this.busy = false;
		}
	}

	/**
	 * A recuperação: o proprietário decide, com confirmação explícita.
	 *
	 * Apaga a credencial (não a substitui) e volta o estado a "não
	 * configurado". A senha nova é configurada depois, pelo mesmo fluxo. A
	 * agente não tem caminho até aqui: esta função não é ferramenta, e o
	 * `main` só a chama pela janela do host.
	 */
	async recoverFromPanel(): Promise<DevPanelState> {
		if (this.busy) {
			throw new Error('há uma ação DEV em andamento');
		}
		const actions = this.options.ownerActions;
		if (actions === undefined) {
			throw new Error('a recuperação não está disponível neste host');
		}
		this.busy = true;
		try {
			// Uma sessão ativa vinculada a uma credencial que vai embora tem
			// de cair antes.
			if (this.session?.isActive() === true) {
				await this.ownerExit();
			}
			const result = await actions.reset();
			if (!result.ok) {
				throw new Error(result.message);
			}
			this.options.log?.('credencial local do proprietário removida (recuperação)');
			return await this.panelState();
		} finally {
			this.busy = false;
		}
	}

	/**
	 * O proprietário autoriza o modo DEV.
	 *
	 * É a **única** porta para uma sessão ativa. Desde a DEV-6 ela exige a
	 * confirmação do host (`grantFromHost`), pedida pela interface por
	 * `activate` — nunca aceita do renderer, de mensagem ou de arquivo. Desde
	 * a DEV-7, `activateFromPanel` só chega aqui após validar a credencial
	 * local do proprietário.
	 */
	async ownerRequest(options: { readonly fresh?: boolean } = {}): Promise<DevHostState> {
		await this.setup();
		if (this.session === undefined || this.root === undefined) {
			return this.state();
		}
		if (this.session.isActive()) {
			return this.state();
		}
		if (this.grant === null) {
			throw new Error('a autorização do host não foi concedida; o modo DEV não pode ser aberto');
		}
		if (this.pendingRestore !== null) {
			// Reiniciar **não** reabre: o proprietário confirma de novo, e a
			// trava que este processo deixou é solta antes de se reivindicar a
			// de verdade. (Sem essa soltura, a reivindicação seria recusada
			// pelo próprio marcador órfão.)
			await releasePriorLock(this.root, this.pendingRestore.lockToken);
			this.pendingRestore = null;
		}
		const token = randomBytes(16).toString('hex');
		// A trava vem **antes** de entrar: se outro dono a tem, a sessão nem
		// abre. O dono da trava é esta `DevSession` — é ela que a reivindica de
		// novo para cada escrita e execução.
		await claimSessionLock(this.root, this.session, { token, probe: true });
		try {
			await this.session.enter();
			this.lock = { token };
		} catch (error) {
			await this.releaseLock();
			throw error;
		}
		await this.saveHostState(this.root, this.grant.sessionId, token);
		this.options.log?.(`modo DEV ativo em ${this.root}`);
		this.chat?.setDevTools(this.toolDeps());
		return this.state();
	}

	/** O proprietário retira a autorização. As ferramentas somem do stack. */
	async ownerExit(): Promise<DevHostState> {
		if (this.session !== undefined) {
			await this.session.exit();
		}
		// O diário em memória vale enquanto a sessão que o autorizou existir:
		// um id da sessão encerrada não deve ser retomado.
		this.journal.clear();
		await this.releaseLock();
		this.deps = undefined;
		this.grant = null;
		this.pendingRestore = null;
		this.chat?.setDevTools(undefined);
		await rm(this.hostStateFile, { force: true }).catch(() => undefined);
		this.options.log?.('modo DEV encerrado');
		return this.state();
	}

	/** Grava o que basta para a próxima abertura **apresentar** — não reabrir. */
	private async saveHostState(root: string, sessionId: string, lockToken: string): Promise<void> {
		try {
			await mkdir(join(this.options.dataRoot, 'dev'), { recursive: true });
			await writeFile(
				this.hostStateFile,
				`${JSON.stringify({ root, sessionId, lockToken, savedAt: new Date().toISOString() }, null, 2)}\n`,
				'utf8',
			);
		} catch {
			// Sem o arquivo, a abertura seguinte só não tem o que apresentar.
		}
	}

	/**
	 * O que o chat recebe em `dev=`.
	 *
	 * `undefined` quando não há repositório **ou** não há sessão ativa: sem
	 * sessão, as ferramentas DEV não entram no stack do agente.
	 */
	toolDeps(): DevToolDeps | undefined {
		if (this.session === undefined || this.root === undefined || !this.session.isActive()) {
			return undefined;
		}
		if (this.deps === undefined) {
			const session = this.session;
			const checkpoints = this.checkpoints;
			const journal = this.journal;
			const operations = this.operations;
			this.deps = {
				session,
				checkpoints,
				runner: this.runner,
				locks: this.locks,
				// DEV-9.1: a aprovação por comando e o diário. Sem
				// `approveCommand`, o `dev_run` não perguntaria nada.
				approveCommand: (request) => this.approveCommand(request),
				audit: this.audit,
				journal,
				// DEV-6: a preparação fica visível em disco desde a escrita.
				operations,
				...(this.options.now !== undefined ? { now: this.options.now } : {}),
				apply: {
					session,
					journal,
					operations,
					checkpoints,
					// Um alvo por aplicação: o `electronApply` lembra "já
					// reiniciei nesta operação", e essa memória não pode
					// atravessar de uma operação para outra.
					createTarget: () => this.createTarget(),
					writeFile: async (path, content) => {
						// A escrita do fluxo é a do `dev_write`, com a mesma
						// regra de caminho e a mesma trava — não é um
						// `writeFile` novo, mais permissivo.
						await this.withRepositoryLock(() => writeRepositoryFile(session, path, content));
					},
				},
			};
		}
		return this.deps;
	}

	/** O alvo do host para uma aplicação.
	 *
	 * A janela é resolvida **quando** a aplicação precisar dela, nunca no
	 * registro — a janela pode ainda não existir.
	 */
	createTarget(): ApplyTarget {
		if (this.root === undefined) {
			throw new Error('o modo DEV não tem raiz: o alvo não pode ser criado');
		}
		this.targets += 1;
		this.options.log?.(`alvo de aplicação #${this.targets} para ${this.root}`);
		return createElectronApplyTarget({
			host: hostFrom(this.options.window),
			repositoryRoot: this.root,
			runner: this.runner,
			...(this.options.runCheck !== undefined
				? { runCheck: this.options.runCheck }
				: {}),
			log: (message) => this.options.log?.(message),
		});
	}

	private async releaseLock(): Promise<void> {
		const root = this.root;
		const session = this.session;
		this.lock = undefined;
		if (root !== undefined && session !== undefined) {
			await releaseSessionLock(root, session).catch(() => undefined);
		}
	}	/**
	 * A escrita do fluxo, sob a **mesma** trava do `dev_write` (DEV-2.1/2.2).
	 *
	 * `withDevRepositoryLock` é exportado pelo `devTools` exatamente para isso:
	 * processo → arquivo, liberada na ordem inversa, e a trava entre processos
	 * é adquirida e solta **por escrita** — não pode ser a do `ownerRequest()`,
	 * que é reentrante e ficaria "ocupada" para si mesma.
	 */
	private async withRepositoryLock<T>(work: () => Promise<T>): Promise<T> {
		const deps = this.deps;
		if (deps === undefined) {
			throw new Error('o modo DEV não tem sessão');
		}
		return withDevRepositoryLock(deps, undefined, work);
	}

	state(): DevHostState {
		if (this.root === undefined) {
			return { repo: false, reason: this.reason ?? 'o modo DEV não foi montado' };
		}
		const status: DevSessionStatus = this.session?.status() ?? { active: false, checkpoints: 0 };
		return {
			repo: true,
			root: this.root,
			session: status.active ? 'active' : 'inactive',
			...(status.startedAt !== undefined ? { startedAt: status.startedAt } : {}),
		};
	}

	/**
	 * O estado do painel (DEV-6).
	 *
	 * Lido a cada abertura e depois de cada ação — nunca guardado no renderer
	 * como verdade. Todo caminho é relativo; nenhum token sai daqui.
	 */
	async panelState(): Promise<DevPanelState> {
		await this.setup();
		const credential = await this.credentialView();
		const floor = {
			localCredential: credential.view,
			credentialActions: credential.actions,
		};
		if (this.root === undefined || this.session === undefined) {
			return {
				repo: { available: false, reason: this.reason ?? 'o modo DEV não foi montado' },
				session: 'inactive',
				authorization: 'unavailable',
				...(this.reason !== undefined ? { message: this.reason } : {}),
				canActivate: false,
				activationBlockedReason: this.reason ?? 'o modo DEV não foi montado',
				canAct: true,
				...floor,
				checkpoints: [],
			};
		}
		const root = this.root;
		const status = this.session.status();
		const lock = await readLockOwnerFile(root).catch(() => ({ kind: 'free' } as const));
		// "Em uso" só com dono **vivo**: um arquivo órfão é lixo de um processo
		// que morreu, e o `acquireDevLock` já o remove ao reivindicar. Antes,
		// qualquer arquivo bloqueava a ativação depois de reiniciar.
		const heldByLiveOwner =
			lock.kind === 'held' && (await devLockHeldByLiveOwner(root).catch(() => true));
		const lockedByOther = heldByLiveOwner && this.lock === undefined && status.active === false;

		// A ativação exige: repositório, uma instância (se o host souber
		// perguntar), a trava livre e nenhuma ação em curso.
		let canActivate = !status.active && !this.busy && !lockedByOther;
		let activationBlockedReason: string | undefined;
		if (status.active) {
			activationBlockedReason = 'a sessão DEV já está ativa';
		} else if (this.busy) {
			activationBlockedReason = 'há uma ação DEV em andamento';
		} else if (lockedByOther) {
			activationBlockedReason =
				lock.kind === 'held' && lock.pid !== undefined
					? `o repositório DEV está em uso pelo processo ${lock.pid}`
					: 'o repositório DEV está em uso por outro processo';
		} else if (this.pendingRestore === null && this.options.readLocalInstance !== undefined) {
			// Reinício e primeira abertura: a instância é lida na ação; aqui só
			// se mostra o que se sabe sem gastar a consulta.
		}
		// DEV-8.16: "havia sessão antes de reiniciar" é **informação** (vai em
		// `message`), não bloqueio. O texto manda confirmar para reabrir — e
		// desabilitar o botão impedia exatamente essa confirmação.
		canActivate = canActivate && activationBlockedReason === undefined;
		// DEV-7: sem credencial configurada (ou bloqueada/ilegível), a
		// ativação não é oferecida — e o motivo da credencial vem primeiro,
		// porque é o que a pessoa precisa resolver.
		if (credential.view.kind !== 'configured') {
			canActivate = false;
			activationBlockedReason = credentialMessage(credential.view);
		} else if (canActivate && this.options.prompt === undefined) {
			canActivate = false;
			activationBlockedReason = 'o host não abre a pergunta de autorização';
		}

		const checkpoints = await this.checkpoints.list().catch(() => []);
		const operation = await this.operations.read().catch(() => undefined);
		let operationView: DevPanelState['operation'];
		if (operation !== undefined) {
			// O id e a prontidão vêm do diário (memória); sem ele, a operação
			// em disco é histórico, não algo a aplicar.
			const prepared = operation.nonce !== undefined ? this.journal.byNonce(operation.nonce) : undefined;
			const checkpointStatus = new Map<string, { readonly ok: boolean; readonly reason?: string }>();
			for (const summary of checkpoints) {
				const verdicts = await inspectCheckpointRestore(
					root,
					summary.files,
					(id, path) => this.checkpoints.sealOf(id, root, path),
					summary.id,
				).catch(() => []);
				const blocked = verdicts.find((verdict) => !verdict.ok);
				checkpointStatus.set(
					summary.id,
					blocked !== undefined && blocked.reason !== undefined
						? { ok: false, reason: `${blocked.path}: ${blocked.reason}` }
						: { ok: verdicts.length > 0 },
				);
			}
			operationView = toOperationView(operation, {
				...(prepared !== undefined ? { operationId: prepared.operationId } : {}),
				readyToApply: prepared !== undefined,
				root,
				checkpoints,
				checkpointStatus,
			});
		}

		const message =
			this.pendingRestore !== null && !status.active
				? 'Havia uma sessão DEV ativa antes de reiniciar. A autorização não foi restaurada; confirme para reabrir.'
				: undefined;

		return {
			repo: { available: true, root },
			session: status.active ? 'active' : 'inactive',
			authorization: status.active ? 'active' : this.pendingRestore !== null ? 'pending-restore' : 'none',
			...(status.startedAt !== undefined ? { startedAt: status.startedAt } : {}),
			canActivate,
			...(activationBlockedReason !== undefined ? { activationBlockedReason } : {}),
			canAct: true,
			...floor,
			...(await this.persistentView(status.active)),
			...(operationView !== undefined ? { operation: operationView } : {}),
			checkpoints: checkpoints.map((summary) => ({
				id: summary.id,
				createdAt: summary.createdAt,
				files: summary.files,
				canRestore: true,
			})),
			...(message !== undefined ? { message } : {}),
		};
	}

	/**
	 * O desbloqueio persistente, para a tela.
	 *
	 * Ausente quando o host não o oferece — e é isso que faz a interface não
	 * mostrar o recurso para quem não o tem, em vez de mostrar um botão morto.
	 */
	private async persistentView(
		active: boolean,
	): Promise<{ readonly persistent?: DevPanelState['persistent'] }> {
		const store = this.options.persistentUnlock;
		if (store === undefined) {
			return {};
		}
		const state = await store.state().catch(() => ({ kind: 'invalid' as const, reason: 'leitura falhou' }));
		const usable = state.kind === 'valid';
		return {
			persistent: {
				available: true,
				remembered: usable,
				...(state.kind === 'invalid' && state.reason.length > 0 ? { problem: state.reason } : {}),
				...(state.kind === 'unavailable' ? { problem: state.reason } : {}),
				unlocked: active && usable,
				...(state.kind === 'valid' ? { since: state.receipt.grantedAt } : {}),
			},
		};
	}

	/**
	 * A confirmação do proprietário chegou (DEV-6) e a credencial local
	 * validou (DEV-7): ativa o modo DEV.
	 *
	 * Quem chama é o `main`, depois de validar o IPC **e** de pedir a senha. A
	 * ordem nesta função é a fronteira inteira:
	 *
	 * 1. a instância do Windows é confiável (uma só, sessão identificada);
	 * 2. a credencial local está configurada e a senha informada bate;
	 * 3. só então o host concede e chama `ownerRequest()`.
	 *
	 * A sessão fica **vinculada** ao verifier do momento: se a credencial for
	 * reconfigurada/recuperada, a sessão aberta deixa de valer
	 * (`assertStillAuthorized`), em vez de sobreviver a uma troca de senha.
	 *
	 * Nada aqui aceita caminho, comando ou token do renderer.
	 */
	async activateFromPanel(): Promise<DevPanelState> {
		if (this.busy) {
			throw new Error('há uma ação DEV em andamento');
		}
		this.busy = true;
		try {
			await this.setup();
			if (this.root === undefined) {
				throw new Error(this.reason ?? 'o modo DEV não está disponível');
			}
			const readInstance = this.options.readLocalInstance;
			if (readInstance === undefined) {
				throw new Error(
					'a ativação pela interface está indisponível: o host não confirma a instância local',
				);
			}
			const instance = await readInstance();
			const verdict = activationVerdict(instance);
			if (!verdict.allowed) {
				throw new Error(verdict.reason);
			}
			const credential = this.options.credential;
			if (credential === undefined) {
				throw new Error(
					'a ativação pela interface exige a credencial local do proprietário; este host não a configura',
				);
			}
			// O desbloqueio persistente, se ligado e se o recibo valer para a
			// credencial de agora, dispensa a pergunta — **e só ela**: o resto do
			// caminho (veredito da instância, vínculo, `ownerRequest`) é o mesmo.
			const remembered = await this.rememberedBinding();
			const binding =
				remembered ??
				(await (async () => {
					const asked = await this.askAuthorization(credential);
					// A gravação só acontece quando o host oferece o recurso **e**
					// a pessoa marcou "lembrar". Sem a marca, nada é escrito — que
					// é o comportamento de sempre.
					if (this.options.persistentUnlock !== undefined && asked.remember) {
						const stored = await credential.read().catch(() => ({ kind: 'missing' as const }));
						if (stored.kind === 'stored') {
							await this.options.persistentUnlock
								.remember({
									verifier: stored.verifier,
									sessionId: verdict.sessionId,
									grantedAt: this.nowIso(),
								})
								.catch(() => undefined);
						}
					}
					return asked.binding;
				})());
			this.grant = { sessionId: verdict.sessionId, grantedAt: this.nowIso(), binding };
			this.options.log?.(`autorização DEV concedida (sessão Windows ${verdict.sessionId})`);
			await this.ownerRequest({ fresh: true });
			return await this.panelState();
		} finally {
			this.busy = false;
		}
	}

	/**
	 * O vínculo vindo do recibo persistente, quando ele ainda vale.
	 *
	 * Devolve `undefined` em todos os casos em que a pergunta deve acontecer:
	 * recurso desligado, sem recibo, recibo ilegível, revogado, ou gravado para
	 * **outra** credencial. Este último é o que faz uma senha trocada exigir
	 * autenticação de novo.
	 */
	async rememberedBinding(): Promise<string | undefined> {
		const store = this.options.persistentUnlock;
		const credential = this.options.credential;
		if (store === undefined || credential === undefined) {
			return undefined;
		}
		const state = await store.state();
		if (state.kind !== 'valid') {
			return undefined;
		}
		const stored = await credential.read();
		if (stored.kind !== 'stored' || stored.verifier !== state.receipt.verifier) {
			return undefined;
		}
		return stored.verifier;
	}

	/**
	 * Reativa o desbloqueio vindo do recibo, se ele ainda valer.
	 *
	 * É o que o host chama ao abrir para, quando a opção está ligada, a sessão
	 * DEV já voltar ativa sem senha. **Não** reabre a sessão às cegas: se o
	 * recibo não casar com a credencial, nada acontece e a tela pede a senha.
	 */
	async resumeFromPersistent(): Promise<DevPanelState | undefined> {
		const binding = await this.rememberedBinding();
		if (binding === undefined) {
			return undefined;
		}
		this.grant = { sessionId: 'persistent', grantedAt: this.nowIso(), binding };
		await this.ownerRequest({ fresh: true });
		return await this.panelState();
	}

	/**
	 * Bloqueia agora, **mantendo** o recibo: o próximo desbloqueio neste
	 * dispositivo não pede senha.
	 */
	async lockFromPanel(): Promise<DevPanelState> {
		if (this.busy) {
			throw new Error('há uma ação DEV em andamento');
		}
		this.busy = true;
		try {
			await this.ownerExit();
			return await this.panelState();
		} finally {
			this.busy = false;
		}
	}

	/**
	 * Revoga a autorização persistente.
	 *
	 * Encerra a sessão e apaga o recibo, e incrementa o contador de revogações —
	 * este último é o que invalida uma cópia restaurada de backup. O próximo
	 * desbloqueio pede a senha.
	 */
	async revokeFromPanel(): Promise<DevPanelState> {
		if (this.busy) {
			throw new Error('há uma ação DEV em andamento');
		}
		this.busy = true;
		try {
			await this.ownerExit();
			await this.options.persistentUnlock?.revoke();
			return await this.panelState();
		} finally {
			this.busy = false;
		}
	}

	/**
	 * Pede a senha ao proprietário e valida.
	 *
	 * Devolve o verifier da credencial que autorizou. Recusa com a mensagem do
	 * store (que já fala de bloqueio, corrupção e indisponibilidade). A senha
	 * **não** fica em nenhuma propriedade desta classe.
	 *
	 * `remember` diz se a pessoa marcou "lembrar neste dispositivo" — e só com
	 * essa marca o recibo é gravado, em `activateFromPanel`.
	 */
	private async askAuthorization(credential: OwnerCredentialStore): Promise<{
		readonly binding: string;
		readonly remember: boolean;
	}> {
		const state = await credential.state();
		if (state.kind === 'not-configured') {
			throw new Error('nenhuma credencial local configurada; configure a autorização antes de ativar o modo DEV');
		}
		if (state.kind === 'blocked') {
			throw new Error('tentativas demais; aguarde antes de tentar de novo');
		}
		if (state.kind === 'corrupt') {
			throw new Error('a credencial local está ilegível; use a recuperação para configurar de novo');
		}
		if (state.kind === 'unavailable') {
			throw new Error(state.reason);
		}
		const prompt = this.options.prompt;
		if (prompt === undefined) {
			throw new Error('o host não abre a pergunta de autorização; a ativação está indisponível');
		}
		const answer = await prompt.ask('authorize', {
			title: 'Autorizar o modo DEV',
			detail:
				'O modo DEV deixa a Evelyn alterar o próprio código e reiniciar o aplicativo. ' +
				'Confirme com a senha local do proprietário. A autorização vale só para esta execução, ' +
				'salvo se você marcar para lembrar neste dispositivo.',
			...(this.options.persistentUnlock !== undefined ? { canRemember: true } : {}),
		});
		if (answer.kind === 'cancelled') {
			throw new Error('autorização recusada: a pergunta foi fechada');
		}
		if (answer.kind === 'expired') {
			throw new Error('autorização recusada: a pergunta expirou');
		}
		if (answer.kind === 'rejected') {
			throw new Error(`autorização recusada: ${answer.reason}`);
		}
		// A autorização pede senha; `approved` é da pergunta de comando. Se
		// chegar aqui, é um pedido cruzado — recusa em vez de seguir sem
		// credencial.
		if (answer.kind !== 'answered') {
			throw new Error('autorização recusada: a pergunta de autorização exige a senha local');
		}
		const result = await credential.authenticate(answer.password);
		if (!result.ok) {
			throw new Error(result.message);
		}
		const stored = await credential.read();
		if (stored.kind === 'stored') {
			return { binding: stored.verifier, remember: answer.remember === true };
		}
		throw new Error('autorização recusada: a credencial mudou durante a validação');
	}

	private nowIso(): string {
		return (this.options.now ?? (() => new Date()))().toISOString();
	}

	/**
	 * A sessão aberta continua autorizada pela **mesma** credencial?
	 *
	 * Chamado antes de qualquer ação que muda o repositório (aplicar,
	 * restaurar) e ao ler o estado. Uma credencial trocada, apagada ou
	 * ilegível encerra a autorização — a sessão não sobrevive à senha que a
	 * abriu.
	 */
	async assertStillAuthorized(): Promise<void> {
		if (this.session === undefined || !this.session.isActive()) {
			return;
		}
		if (this.grant === null || this.grant.binding === undefined) {
			return;
		}
		const credential = this.options.credential;
		if (credential === undefined) {
			return;
		}
		const stored = await credential.read();
		if (stored.kind !== 'stored' || stored.verifier !== this.grant.binding) {
			await this.ownerExit();
			throw new Error('a autorização DEV foi invalidada: a credencial local mudou; ative de novo');
		}
	}

	/** Encerra pelo painel: mesma porta do `ownerExit`, nada além. */
	async deactivateFromPanel(): Promise<DevPanelState> {
		if (this.busy) {
			throw new Error('há uma ação DEV em andamento');
		}
		this.busy = true;
		try {
			await this.ownerExit();
			return await this.panelState();
		} finally {
			this.busy = false;
		}
	}

	/**
	 * Aplica a operação preparada — **só** com o id que o host conhece.
	 *
	 * A página manda um id; se ele não estiver no diário desta sessão, nada
	 * acontece. A aplicação roda com as ferramentas DEV fora do stack: um turno
	 * em andamento (o que pediu a mudança) não pode montar as ferramentas de
	 * um estado que está mudando.
	 */
	async applyFromPanel(operationId: unknown): Promise<{ readonly outcome: string; readonly detail: string }> {
		if (this.busy) {
			throw new Error('há uma ação DEV em andamento');
		}
		// DEV-7: se a credencial que autorizou a sessão mudou, a aplicação não
		// acontece — a sessão já caiu, e a mensagem diz por quê.
		await this.assertStillAuthorized();
		const deps = this.toolDeps();
		if (deps?.apply === undefined) {
			throw new Error('o modo DEV não está ativo');
		}
		if (typeof operationId !== 'string' || operationId.length === 0 || operationId.length > 200) {
			throw new Error('identificador de operação inválido');
		}
		const prepared = this.journal.get(operationId);
		if (prepared === undefined) {
			throw new Error('não há operação preparada com esse identificador nesta sessão');
		}
		this.busy = true;
		try {
			const tool = createDevApplyTool(deps.apply);
			const result = await this.withoutDevTools(() =>
				// DEV-AUDIT-03: o painel já confirmou com a pessoa
				// (`confirmDevAction` antes de chamar); a ferramenta exige a
				// marca explícita porque é ela que consome a operação.
				tool.execute({ operationId, confirm: true }, { sessionId: 'dev-panel' }),
			);
			if (!result.ok) {
				return { outcome: 'refused', detail: result.error ?? 'a aplicação foi recusada' };
			}
			const output = result.output as { readonly outcome: string; readonly detail: string };
			return { outcome: output.outcome, detail: output.detail };
		} finally {
			this.busy = false;
		}
	}

	/**
	 * Restaura pela confirmação do proprietário.
	 *
	 * O Core é quem decide: `restoreAll` recusa conflitos sem `force`, e a
	 * interface não oferece `force` — não há "sobrescrever mudança externa".
	 * Se um arquivo mudou por fora, o resultado diz quais e nada é escrito.
	 */
	async restoreFromPanel(input: {
		readonly checkpointId?: unknown;
	}): Promise<{ readonly restored: readonly string[]; readonly removed: readonly string[]; readonly blocked: readonly string[]; readonly detail: string }> {
		if (this.busy) {
			throw new Error('há uma ação DEV em andamento');
		}
		if (this.root === undefined || this.session === undefined || !this.session.isActive()) {
			throw new Error('o modo DEV não está ativo');
		}
		// DEV-7: restaurar sobrescreve arquivos; a autorização tem de ser ainda
		// a que abriu a sessão.
		await this.assertStillAuthorized();
		if (input.checkpointId !== undefined) {
			if (typeof input.checkpointId !== 'string' || input.checkpointId.length === 0 || input.checkpointId.length > 200) {
				throw new Error('identificador de checkpoint inválido');
			}
		}
		const root = this.root;
		const known = await this.checkpoints.list().catch(() => []);
		const target =
			input.checkpointId === undefined
				? undefined
				: known.find((summary) => summary.id === input.checkpointId);
		if (input.checkpointId !== undefined && target === undefined) {
			throw new Error('não há checkpoint com esse identificador');
		}
		this.busy = true;
		try {
			const report = await this.withoutDevTools(() =>
				this.withRepositoryLock(() => {
					if (target !== undefined) {
						// Um checkpoint específico: restaurar é devolver **estes**
						// arquivos ao que eram.
						return this.checkpoints.restore(target.id, root);
					}
					// Sem id: o que o fluxo de aplicação capturou. O `dev_write`
					// grava os seus como `dev_write`, e eles não fazem parte de
					// uma aplicação — restaurá-los por omissão seria desfazer uma
					// preparação que a pessoa não viu falhar.
					return this.checkpoints.restoreAll(root, 'dev-apply');
				}),
			);
			const blocked = report.conflicts.map((conflict) => `${conflict.path}: ${conflict.reason}`);
			return {
				restored: [...report.restored],
				removed: [...report.removed],
				blocked,
				detail:
					blocked.length > 0
						? `${blocked.length} arquivo(s) mudaram por fora e não foram sobrescritos`
						: `${report.restored.length} arquivo(s) restaurados${report.removed.length > 0 ? `, ${report.removed.length} removido(s)` : ''}`,
			};
		} catch (error) {
			if (error instanceof DevRestoreConflictError) {
				return {
					restored: [],
					removed: [],
					blocked: error.conflicts.map((conflict) => `${conflict.path}: ${conflict.reason}`),
					detail: error.message,
				};
			}
			throw error;
		} finally {
			this.busy = false;
		}
	}

	/**
	 * A projeção do estado por uma instância **que não é o host** (DEV-6).
	 *
	 * A janela de configurações é outro processo do Electron. Ela não pode
	 * receber o `DevHost` (nem deveria): recebe a mesma leitura, pelas mesmas
	 * funções do Core, e pede as ações por IPC.
	 *
	 * `authorization` deriva só do que está em disco: uma operação que não
	 * chegou a terminar e checkpoints. Sem letras de token.
	 */
	async inspectionState(): Promise<DevPanelState> {
		await this.setup();
		if (this.root === undefined || this.session === undefined || this.session.status().active) {
			// Nenhum repositório **ou** a sessão é desta instância: o estado é
			// exatamente o do host, que é quem tem a concessão. Outro processo
			// não teria sessão ativa — e nada a mais é revelado.
			return await this.panelState();
		}
		const root = this.root;
		const status = this.session.status();
		const checkpoints = await this.checkpoints.list().catch(() => []);
		const operation = await this.operations.read().catch(() => undefined);
		let operationView: DevPanelState['operation'];
		if (operation !== undefined) {
			const checkpointStatus = new Map<string, { readonly ok: boolean; readonly reason?: string }>();
			for (const summary of checkpoints) {
				const verdicts = await inspectCheckpointRestore(
					root,
					summary.files,
					(id, path) => this.checkpoints.sealOf(id, root, path),
					summary.id,
				).catch(() => []);
				const blocked = verdicts.find((verdict) => !verdict.ok);
				checkpointStatus.set(
					summary.id,
					blocked !== undefined && blocked.reason !== undefined
						? { ok: false, reason: `${blocked.path}: ${blocked.reason}` }
						: { ok: verdicts.length > 0 },
				);
			}
			operationView = toOperationView(operation, {
				readyToApply: false,
				root,
				canAct: false,
				checkpoints,
				checkpointStatus,
			});
		}
		const pending = operation !== undefined && isUnfinished(operation);
		const pendingRestore = this.pendingRestore !== null;
		const credential = await this.credentialView();
		return {
			repo: { available: true, root },
			session: status.active ? 'active' : 'inactive',
			authorization: status.active ? 'active' : pendingRestore ? 'pending-restore' : 'none',
			...(status.startedAt !== undefined ? { startedAt: status.startedAt } : {}),
			localCredential: credential.view,
			credentialActions: credential.actions,
			// Ativar por aqui nunca: o host é outro processo e não conhece uma
			// concessão; o botão existe na janela principal, que é do host.
			canActivate: false,
			activationBlockedReason:
				'ative o modo DEV na janela principal; esta janela só mostra o estado',
			canAct: false,
			...(operationView !== undefined ? { operation: operationView } : {}),
			checkpoints: checkpoints.map((summary) => ({
				id: summary.id,
				createdAt: summary.createdAt,
				files: summary.files,
				canRestore: true,
			})),
			...(pendingRestore
				? {
						message:
							'Havia uma sessão DEV ativa antes de reiniciar. A autorização não foi restaurada; confirme na janela principal para reabrir.',
					}
				: pending
					? { message: 'há uma operação DEV que não terminou; o estado está em disco' }
					: {}),
		};
	}

	/** Só para o teste provar que nada vazou. */
	debug(): {
		readonly journalSize: number;
		readonly lockHeld: boolean;
		readonly targets: number;
	} {
		return {
			journalSize: this.journal.size(),
			lockHeld: this.root !== undefined && this.locks.isHeld(resourceKeyFor(this.root)),
			targets: this.targets,
		};
	}
}
