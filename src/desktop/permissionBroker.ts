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
import type { PermissionDecision, PermissionGateway, PermissionRequest } from '../core/permissions/gateway';
import { REDACTED } from '../core/permissions/gateway';
import type { PermissionAnswer, PermissionPrompt } from './contract';

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
	readonly source: 'user' | 'cancelled';
	/**
	 * The turn the request belonged to.
	 *
	 * Carried through from the prompt rather than derived here: the broker's own
	 * id says nothing about which turn asked, and the renderer discards a
	 * resolution whose `turnId` is not the one it is watching.
	 */
	readonly turnId: string;
}

export interface PermissionBrokerOptions {
	/** Where prompts and resolutions are announced. Main wires this to IPC. */
	readonly emit: (event: 'requested' | 'resolved', payload: unknown) => void;
	readonly generateId?: () => string;
	readonly timeoutMs?: number;
	/** Injected in tests so no real timer has to expire. */
	readonly now?: () => number;
}

export class PermissionBroker {
	private readonly pending = new Map<string, Pending>();
	private readonly emit: PermissionBrokerOptions['emit'];
	private readonly generateId: () => string;
	private readonly timeoutMs: number;
	private counter = 0;

	constructor(options: PermissionBrokerOptions) {
		this.emit = options.emit;
		this.generateId = options.generateId ?? (() => `perm-${++this.counter}`);
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
			// The signal goes through: a turn stopped while the dialog is open has
			// to deny the request, or the turn waits forever for an answer to a
			// question the user just withdrew.
			return this.askUser(request, request.sessionId, options?.signal);
		},
	};

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