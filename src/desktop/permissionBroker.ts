/**
 * The permission broker: the seam between the Core's `PermissionGateway` and
 * whoever answers on the user's behalf.
 *
 * Why it exists: the Core's gateway is a port with one async method, and the
 * runtime calls it *before* every tool. Turning that into a UI dialog needs
 * something that can hold a request open, hand it to another process, and
 * resolve it later. That something is this class — and it deliberately is not a
 * policy engine.
 *
 * The policy is still the Core's. `createRiskGateway` decides that `safe` runs
 * without asking and that `moderate` and `dangerous` are worth a question; this
 * class only carries the question out and brings the answer back. Swapping in a
 * different rule set means changing which gateway is built, not this file.
 *
 * Three rules decide the behaviour:
 *
 * - A request is answered exactly once. The first answer settles it and every
 *   later one is refused, so a double-clicked Allow button cannot resurrect a
 *   decided prompt or hang the caller that already moved on.
 *
 * - Losing the requester denies it. If the window closes, the turn is stopped,
 *   or the signal fires while nobody is looking, the promise settles as `deny`.
 *   A permission prompt that can be left pending forever is a tool that can be
 *   left half-run, and silence must never mean allow.
 *
 * - Arguments are shown as they arrive. The Core already redacted them in
 *   `PermissionRequest`, so this file formats what it is given and never inspects
 *   a value for anything.
 */
import { randomBytes } from 'node:crypto';

import type { PermissionDecision, PermissionGateway, PermissionRequest } from '../core/permissions/gateway';
import { REDACTED } from '../core/permissions/gateway';
import type { PermissionAnswer, PermissionPrompt } from './contract';
import { classifyRequest, grantCovers, extendGrant, type GrantScope } from './permissionScope';

/** How long to wait for a person before assuming they are gone. */
const DEFAULT_TIMEOUT_MS = 120_000;

/** An open request, as the broker holds it. */
interface Pending {
	readonly request: PermissionRequest;
	/** The prompt id, which is also the request's own id. */
	readonly id: string;
	/** The turn that asked, carried so the resolution can name it. */
	readonly turnId: string;
	readonly resolve: (decision: PermissionDecision) => void;
	/** Cleared when the request settles, so a second answer finds nothing. */
	settled: boolean;
	readonly timer: ReturnType<typeof setTimeout>;
}

/** What the broker tells the UI about a decision it made on its own. */
export interface DecisionReport {
	readonly id: string;
	readonly toolName: string;
	readonly decision: 'allow' | 'deny';
	/**
	 * De onde veio a decisão.
	 *
	 * `automatic` e `grant` são as duas formas de permitir sem diálogo — e o
	 * que a interface precisa distinguir na linha do tempo. `cancelled` é a
	 * negação que ninguém escolheu: tempo esgotado, parada, janela fechada.
	 */
	readonly source: 'user' | 'cancelled' | 'automatic' | 'grant';
	/**
	 * The turn the request belonged to.
	 *
	 * Carried through from the prompt rather than derived here: the broker's own
	 * id says nothing about which turn asked, and the renderer discards a
	 * resolution whose `turnId` is not the one it is watching.
	 */
	readonly turnId: string;
	/** O escopo que autorizou, quando a fonte é `automatic` ou `grant`. */
	readonly scope?: string;
}

export interface PermissionBrokerOptions {
	/** Where prompts and resolutions are announced. Main wires this to IPC. */
	readonly emit: (event: 'requested' | 'resolved', payload: unknown) => void;
	readonly generateId?: () => string;
	readonly timeoutMs?: number;
	/** Injected in tests so no real timer has to expire. */
	readonly now?: () => number;
	/** Injetado em teste; ausente = um por broker (R4C). */
	readonly brokerId?: string;
	/**
	 * A raiz do repositório DEV, quando esta tarefa pode escrever nele.
	 *
	 * É ela que dá **escopo** à concessão. Sem raiz, nenhuma escrita é
	 * classificada como escopo e o caminho antigo vale: perguntar a cada uma.
	 */
	readonly devRoot?: string;
	/**
	 * Liga a autorização por escopo (leitura automática, escrita por tarefa).
	 *
	 * Desligada por padrão: o comportamento histórico é o de sempre — só
	 * `safe` passa sem pergunta. Quem liga é o host, quando a pessoa escolheu
	 * uma tarefa de várias etapas; desligar é o jeito de voltar a pedir tudo.
	 */
	readonly scopedGrants?: boolean;
}

export class PermissionBroker {
	private readonly pending = new Map<string, Pending>();
	private readonly emit: PermissionBrokerOptions['emit'];
	private readonly generateId: () => string;
	private readonly timeoutMs: number;
	private readonly devRoot: string | undefined;
	private readonly scopedGrants: boolean;
	/**
	 * O que já foi concedido **nesta tarefa**, por chave de escopo.
	 *
	 * Vive no broker, que é criado por turno (R4C): a concessão não atravessa
	 * turnos, e um broker nunca vê a concessão de outro.
	 */
	private grant: GrantScope;
	private counter = 0;

	constructor(options: PermissionBrokerOptions) {
		this.emit = options.emit;
		this.devRoot = options.devRoot;
		this.scopedGrants = options.scopedGrants ?? false;
		this.grant = { taskId: options.brokerId ?? '', keys: new Set<string>() };
		// R4C: o id carrega o broker. Antes era `perm-1` num contador que
		// começa em zero **por broker** — como agora há um broker por turno,
		// dois turnos simultâneos geravam o mesmo `perm-1`, e a resposta de um
		// podia ser aplicada à pergunta do outro. O prefixo aleatório torna
		// cada id único entre brokers, e a interface continua vendo um id
		// opaco, como antes.
		const brokerId = options.brokerId ?? randomBytes(6).toString('hex');
		this.generateId = options.generateId ?? (() => `perm-${brokerId}-${++this.counter}`);
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	/** How many requests are waiting for an answer. */
	get openCount(): number {
		return this.pending.size;
	}

	/**
	 * The gateway the runtime is given.
	 *
	 * `safe` is allowed without asking — reading a file the project already
	 * contains is not a question worth interrupting anyone for. Everything else
	 * opens a prompt and waits, which is what makes `write_file` and
	 * `run_command` confirm before they run.
	 */
	readonly gateway: PermissionGateway = {
		ask: async (request, options): Promise<PermissionDecision> => {
			if (request.riskLevel === 'safe') {
				return { decision: 'allow' };
			}
			// Com a autorização por escopo ligada, a classe do pedido decide:
			// leitura passa, escrita dentro do escopo já concedido passa, e o
			// resto pergunta — sem que nenhuma concessão cubra o que é perigoso.
			if (this.scopedGrants) {
				const verdict = classifyRequest(request, {
					...(this.devRoot !== undefined ? { root: this.devRoot } : {}),
				});
				if (verdict.kind === 'automatic') {
					return this.allowedAutomatically(request);
				}
				if (verdict.kind === 'scoped' && grantCovers(this.grant.keys, verdict.key)) {
					return this.allowedByGrant(request, verdict.key);
				}
			}
			// The signal goes through: a turn stopped while the dialog is open has
			// to deny the request, or the turn waits forever for an answer to a
			// question the user just withdrew.
			return this.askUser(request, request.sessionId, options?.signal);
		},
	};

	/**
	 * Uma leitura autorizada sozinha, anunciada como tal.
	 *
	 * O anúncio existe para a interface poder mostrar "lido sem confirmar" em
	 * vez de deixar a linha do tempo sem explicação — uma permissão que
	 * aparece sem nunca ter sido pedida parece falha de segurança.
	 */
	private allowedAutomatically(request: PermissionRequest): PermissionDecision {
		this.emit('resolved', {
			id: this.generateId(),
			toolName: request.toolName,
			decision: 'allow',
			source: 'automatic',
			turnId: request.sessionId,
			scope: 'leitura',
		});
		return { decision: 'allow' };
	}

	/** Uma concessão da tarefa cobre este pedido. */
	private allowedByGrant(request: PermissionRequest, key: string): PermissionDecision {
		this.emit('resolved', {
			id: this.generateId(),
			toolName: request.toolName,
			decision: 'allow',
			source: 'grant',
			turnId: request.sessionId,
			scope: key,
		});
		return { decision: 'allow' };
	}

	/**
	 * Opens a prompt and waits for the answer.
	 *
	 * Resolves only once: with what the user chose, or with a `deny` if the
	 * question was withdrawn — a closed window, a stopped turn, or nobody
	 * answering in time.
	 */
	private askUser(
		request: PermissionRequest,
		turnId: string,
		signal?: AbortSignal,
	): Promise<PermissionDecision> {
		// Already cancelled: never open a dialog for a turn the user stopped.
		if (signal?.aborted === true) {
			return Promise.resolve(cancelled(request));
		}

		const id = this.generateId();
		const prompt = toPrompt(id, request, turnId);

		return new Promise<PermissionDecision>((resolve) => {
			const entry: Pending = {
				request,
				id,
				turnId,
				settled: false,
				timer: setTimeout(() => {
					// Nobody answered in time. Silence is not consent.
					this.settle(id, cancelled(request), 'cancelled');
				}, this.timeoutMs),
				resolve,
			};
			this.pending.set(id, entry);

			// A stop while the dialog is open has to settle the promise, or the
			// turn would wait for an answer to a question the user already
			// withdrew by pressing Stop.
			signal?.addEventListener(
				'abort',
				() => {
					this.settle(id, cancelled(request), 'cancelled');
				},
				{ once: true },
			);

			this.emit('requested', prompt);
		});
	}

	/**
	 * Applies an answer from the UI.
	 *
	 * False when nothing was open under that id, which is the honest answer to a
	 * stale dialog rather than a silent success.
	 */
	answer(answer: PermissionAnswer): boolean {
		const entry = this.pending.get(answer.id);
		if (entry === undefined || entry.settled) {
			return false;
		}
		// Um "permitir" que o usuário deu para um pedido de escopo **estende** a
		// concessão da tarefa: é isso que faz as etapas seguintes da mesma
		// tarefa não perguntarem de novo. Só o que é `scoped` entra aqui; o
		// perigoso continua perguntando a cada vez, porque a classe dele é
		// `explicit` e nunca chega a este ponto.
		if (answer.decision === 'allow' && this.scopedGrants) {
			const verdict = classifyRequest(entry.request, {
				...(this.devRoot !== undefined ? { root: this.devRoot } : {}),
			});
			if (verdict.kind === 'scoped') {
				this.grant = extendGrant(this.grant, [verdict.key]);
			}
		}
		this.settle(
			answer.id,
			answer.decision === 'allow'
				? { decision: 'allow' }
				: {
						decision: 'deny',
						reason: 'the user denied this action',
					},
			'user',
		);
		return true;
	}

	/**
	 * Denies everything still open, and says so.
	 *
	 * Called when a turn is stopped: the dialogs belong to that turn, and a
	 * prompt left open after the turn is gone would resolve into nothing.
	 */
	cancelAll(reason = 'the turn was cancelled'): number {
		const count = this.pending.size;
		for (const id of [...this.pending.keys()]) {
			const entry = this.pending.get(id);
			this.settle(
				id,
				{ decision: 'deny', reason },
				'cancelled',
			);
			void entry;
		}
		return count;
	}

	/**
	 * Settles one request and reports the outcome.
	 *
	 * `settled` is the guard that makes this idempotent: a timeout and a click
	 * arriving together must resolve the promise once and announce once.
	 */
	private settle(
		id: string,
		decision: PermissionDecision,
		source: DecisionReport['source'],
	): void {
		const entry = this.pending.get(id);
		if (entry === undefined || entry.settled) {
			return;
		}
		entry.settled = true;
		clearTimeout(entry.timer);
		this.pending.delete(id);

		this.emit('resolved', {
			id,
			toolName: entry.request.toolName,
			decision: decision.decision,
			source,
			// The resolution has to name the same turn the prompt did, or the
			// renderer discards it as belonging to a turn it no longer watches.
			turnId: entry.turnId,
		} satisfies DecisionReport);

		entry.resolve(decision);
	}
}

/** Formats a Core request as the prompt the dialog renders. */
function toPrompt(id: string, request: PermissionRequest, turnId: string): PermissionPrompt {
	const args = Object.entries(request.arguments).map(([name, value]) => ({
		name,
		// A redacted value is shown as the placeholder, so the user can see
		// *that* a secret was involved without ever seeing it.
		value: value === REDACTED ? REDACTED : formatValue(value),
	}));

	return {
		id,
		toolName: request.toolName,
		action: request.action,
		description: request.description,
		riskLevel: request.riskLevel,
		arguments: args,
		...(request.workspace !== undefined ? { workspace: request.workspace } : {}),
		turnId,
	};
}

/** The decision a withdrawn request settles as. */
function cancelled(request: PermissionRequest): PermissionDecision {
	return {
		decision: 'deny',
		reason: `the request to run "${request.toolName}" was cancelled`,
	};
}

/**
 * Renders one argument for display.
 *
 * Long values are truncated: a prompt that scrolls off the dialog is a prompt
 * the user cannot judge, and the full value is not what they need to decide.
 */
function formatValue(value: unknown): string {
	if (typeof value === 'string') {
		return value.length > 400 ? `${value.slice(0, 400)}…[truncated]` : value;
	}
	try {
		const json = JSON.stringify(value) ?? String(value);
		return json.length > 400 ? `${json.slice(0, 400)}…[truncated]` : json;
	} catch {
		return String(value);
	}
}