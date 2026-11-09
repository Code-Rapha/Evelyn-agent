/**
 * A sessão do modo DEV (DEV-2).
 *
 * ## O que ela é
 *
 * O estado em que o **proprietário** autorizou a Evelyn a ler, escrever e
 * executar verificações no repositório dela mesma. Nada mais.
 *
 * ## Por que o estado vive só na memória
 *
 * Qualquer coisa persistida é alcançável pelo agente: `write_file` escreve
 * dentro de um workspace, e o workspace pode ser o repositório. Um booleano em
 * `state.json`, um marcador num arquivo do projeto ou uma linha em `settings`
 * seriam, todos, uma forma de o modelo conceder a si mesmo a autorização.
 *
 * Em memória do processo principal, a única forma de ativar é chamar este
 * objeto — e o agente não tem referência a ele: as ferramentas recebem
 * `DevSessionRef`, que só sabe perguntar "está ativa?". Não há `enter` exposto
 * ao tool registry, e reiniciar o processo apaga a autorização por construção.
 *
 * ## Por que a raiz é fixada aqui
 *
 * O agente **não escolhe** onde o DEV opera. Um `projectId` ou um caminho
 * vindo do modelo permitiria apontar o DEV para o repositório da própria
 * Evelyn sem que o proprietário soubesse. A raiz vem do host (o mesmo lugar
 * confiável de onde ele sabe onde o app está instalado) e é validada aqui:
 * tem de ser um diretório com `.git`, e tem de ser exatamente o que o host
 * declarou — sem normalização silenciosa para "um nível acima".
 */

import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

/** O que o host precisa declarar para abrir uma sessão. */
export interface DevSessionOptions {
	/**
	 * A raiz do repositório que o DEV pode tocar.
	 *
	 * Vem da configuração confiável do host, **nunca** de uma ferramenta, de
	 * um `projectId` ou de um argumento do modelo.
	 */
	readonly repositoryRoot: string;
	/** Relógio injetável, para o teste nomear o início da sessão. */
	readonly now?: () => Date;
}

/** O estado que a interface (DEV-3) vai ler. */
export interface DevSessionStatus {
	readonly active: boolean;
	/** A raiz autorizada, quando ativa. Ausente quando inativa. */
	readonly repositoryRoot?: string;
	/** Quando a sessão começou (ISO), quando ativa. */
	readonly startedAt?: string;
	/** Quantos checkpoints existem nesta sessão. */
	readonly checkpoints: number;
}

/** A recusa quando algo tenta usar o DEV sem sessão. */
export class DevSessionInactiveError extends Error {
	readonly code = 'dev_inactive';
	constructor(message = 'o modo DEV não está ativo') {
		super(message);
		this.name = 'DevSessionInactiveError';
	}
}

/** A recusa quando a raiz declarada não é um repositório utilizável. */
export class DevRootError extends Error {
	readonly code = 'dev_root_invalid';
	constructor(message: string) {
		super(message);
		this.name = 'DevRootError';
	}
}

/**
 * O que as ferramentas `dev_*` enxergam da sessão.
 *
 * Só leitura: `isActive()` e `root()`. A ferramenta não consegue entrar nem
 * sair da sessão, nem trocar a raiz — se pudesse, um `dev_run` bem-sucedido
 * seria uma forma de o agente se autorizar.
 */
export interface DevSessionRef {
	isActive(): boolean;
	/** A raiz autorizada. Lança `DevSessionInactiveError` se não houver sessão. */
	root(): string;
	/** O token da sessão atual; muda a cada entrada. */
	sessionToken(): string;
}

/**
 * A sessão.
 *
 * `enter` é a única porta de entrada, e ela exige a raiz do host. `exit`
 * encerra, roda os canceladores registrados (comandos em andamento) e limpa o
 * estado — sem deixar a sessão "meio ativa" se um cancelador falhar.
 */
export class DevSession implements DevSessionRef {
	private state: { readonly root: string; readonly startedAt: string; readonly token: string } | undefined;
	private readonly cancelHandlers = new Set<() => void>();
	private checkpoints = 0;

	constructor(private readonly options: DevSessionOptions) {}

	/**
	 * Entra no modo DEV. Recusa se a raiz não for um repositório.
	 *
	 * A validação acontece **antes** de qualquer estado mudar: uma raiz
	 * inválida não deixa a sessão parcialmente ativa.
	 */
	async enter(): Promise<DevSessionStatus> {
		const declared = this.options.repositoryRoot;
		if (typeof declared !== 'string' || declared.trim().length === 0) {
			throw new DevRootError('o host não declarou a raiz do repositório');
		}
		const root = resolve(declared);
		await assertRepository(root);
		this.state = {
			root,
			startedAt: (this.options.now ?? (() => new Date()))().toISOString(),
			token: randomToken(),
		};
		this.checkpoints = 0;
		return this.status();
	}

	/**
	 * Sai do modo DEV.
	 *
	 * Os canceladores rodam **antes** de o estado ser limpo — se um deles
	 * lançar, a sessão já está encerrada de qualquer forma: falhar em matar um
	 * processo não pode devolver a autorização que o usuário acabou de
	 * retirar.
	 */
	async exit(): Promise<DevSessionStatus> {
		const handlers = [...this.cancelHandlers];
		this.cancelHandlers.clear();
		this.state = undefined;
		this.checkpoints = 0;
		for (const cancel of handlers) {
			try {
				cancel();
			} catch {
				// Um cancelador que falha não reabre a sessão; o processo é
				// finalizado pelo `DevRunner` de qualquer forma.
			}
		}
		return this.status();
	}

	status(): DevSessionStatus {
		if (this.state === undefined) {
			return { active: false, checkpoints: 0 };
		}
		return {
			active: true,
			repositoryRoot: this.state.root,
			startedAt: this.state.startedAt,
			checkpoints: this.checkpoints,
		};
	}

	isActive(): boolean {
		return this.state !== undefined;
	}

	root(): string {
		if (this.state === undefined) {
			throw new DevSessionInactiveError();
		}
		return this.state.root;
	}

	sessionToken(): string {
		if (this.state === undefined) {
			throw new DevSessionInactiveError();
		}
		return this.state.token;
	}

	/**
	 * Registra um cancelador que roda ao sair.
	 *
	 * Devolve a remoção, para o `DevRunner` limpar quando o comando termina
	 * sozinho. Canceladores sobrevivem ao comando que os registrou? Não: quem
	 * os registra remove ao terminar.
	 */
	onExit(cancel: () => void): () => void {
		this.cancelHandlers.add(cancel);
		return () => this.cancelHandlers.delete(cancel);
	}

	/** Chamado pelo checkpoint; não exposto às ferramentas. */
	noteCheckpoint(): void {
		this.checkpoints += 1;
	}

	/** A sessão está ativa **e** é a mesma que registrou a operação? */
	isCurrent(token: string): boolean {
		return this.state !== undefined && this.state.token === token;
	}
}

/**
 * A raiz é o repositório certo?
 *
 * Exige um `.git` (diretório ou arquivo, como em worktrees) na raiz
 * declarada. Não sobe para o diretório pai: se o host apontou para uma
 * subpasta de um repositório, isso é recusado em vez de "adivinhado" — o
 * escopo do DEV tem de ser explícito.
 */
async function assertRepository(root: string): Promise<void> {
	const status = await stat(root).catch(() => undefined);
	if (status === undefined || !status.isDirectory()) {
		throw new DevRootError(`a raiz do DEV não é um diretório: ${root}`);
	}
	const marker = await stat(join(root, '.git')).catch(() => undefined);
	if (marker === undefined) {
		throw new DevRootError(
			`a raiz do DEV não é a raiz de um repositório (não há .git em ${root})`,
		);
	}
}

/** Um token por entrada, para distinguir sessões diferentes. */
function randomToken(): string {
	return randomBytes(16).toString('hex');
}

/** A raiz autorizada é `candidate`? Usado pelo workspace do DEV. */
export function isSameRoot(root: string, candidate: string): boolean {
	const a = resolve(root);
	const b = resolve(candidate);
	if (a === b) {
		return true;
	}
	return b.startsWith(a.endsWith(sep) ? a : `${a}${sep}`);
}
