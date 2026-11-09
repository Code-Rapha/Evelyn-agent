/**
 * A leitura, no lado da página, do estado do painel DEV (DEV-6).
 *
 * ## Por que validar o que o main manda
 *
 * O `main` é confiável; a **suposição de que a resposta tem a forma esperada**
 * não é. Uma versão diferente, um bug ou um campo novo não deve renderizar
 * `undefined` na tela nem fazer a página quebrar. Aqui a resposta é reduzida
 * ao que a página sabe mostrar: tipos exatos, listas de strings, nada além.
 *
 * ## O que esta função não faz
 *
 * Não decide permissão. Se o payload trouxer algo que a página não use, ele é
 * descartado — o renderer nunca "ganha" um campo por receber um JSON a mais.
 */

import type { DevPanelState } from '../core/dev/devPanel';
import type { DevActionResult } from './contract';

/** A recusa de um payload malformado. */
export class DevViewError extends Error {
	readonly code = 'dev_view_invalid';
	constructor(message: string) {
		super(message);
		this.name = 'DevViewError';
	}
}

const STAGES = new Set([
	'planned',
	'checkpointed',
	'written',
	'verified',
	'verification-failed',
	'applying',
	'rolled-back',
	'done',
]);

const STRATEGIES = new Set(['hot', 'reload-ui', 'restart-app', 'restart-controlled']);
const AUTHORIZATIONS = new Set(['active', 'none', 'pending-restore', 'unavailable']);

function record(value: unknown, what: string): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new DevViewError(`${what} inválido`);
	}
	return value as Record<string, unknown>;
}

function text(value: unknown, what: string, fallback?: string): string {
	if (typeof value === 'string') {
		return value;
	}
	if (fallback !== undefined) {
		return fallback;
	}
	throw new DevViewError(`${what} inválido`);
}

function optionalText(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function textList(value: unknown): readonly string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter((item): item is string => typeof item === 'string');
}

/** O estado do painel, reduzido ao que a página mostra. */
export function parseDevPanelState(payload: unknown): DevPanelState {
	const root = record(payload, 'estado DEV');
	const repoRaw = record(root['repo'], 'repositório');
	const session = root['session'] === 'active' ? 'active' : 'inactive';
	const authorizationRaw = root['authorization'];
	const authorization = (
		typeof authorizationRaw === 'string' && AUTHORIZATIONS.has(authorizationRaw) ? authorizationRaw : 'unavailable'
	) as DevPanelState['authorization'];

	const operationRaw = root['operation'];
	let operation: DevPanelState['operation'];
	if (typeof operationRaw === 'object' && operationRaw !== null) {
		const op = record(operationRaw, 'operação');
		const stage = text(op['stage'], 'etapa');
		const strategy = text(op['strategy'], 'estratégia');
		if (!STAGES.has(stage) || !STRATEGIES.has(strategy)) {
			throw new DevViewError('etapa ou estratégia desconhecida');
		}
		const checksRaw = Array.isArray(op['checks']) ? op['checks'] : [];
		operation = {
			id: text(op['id'], 'id da operação'),
			stage: stage as NonNullable<DevPanelState['operation']>['stage'],
			stageLabel: text(op['stageLabel'], 'rótulo da etapa'),
			strategy: strategy as NonNullable<DevPanelState['operation']>['strategy'],
			files: textList(op['files']),
			checks: checksRaw
				.filter((check): check is Record<string, unknown> => typeof check === 'object' && check !== null)
				.map((check) => ({
					name: text(check['name'], 'verificação'),
					...(typeof check['result'] === 'string' ? { result: check['result'] } : {}),
				})),
			results: textList(op['results']),
			startedAt: text(op['startedAt'], 'início'),
			updatedAt: text(op['updatedAt'], 'atualização'),
			canApply: op['canApply'] === true,
			...(optionalText(op['applyBlockedReason']) !== undefined
				? { applyBlockedReason: optionalText(op['applyBlockedReason']) }
				: {}),
			canRestore: op['canRestore'] === true,
			...(optionalText(op['restoreBlockedReason']) !== undefined
				? { restoreBlockedReason: optionalText(op['restoreBlockedReason']) }
				: {}),
			canAct: op['canAct'] !== false,
			requiresControlledRestart: op['requiresControlledRestart'] === true,
			checkpoints: parseCheckpoints(op['checkpoints']),
		};
	}

	const checkpointsRaw = Array.isArray(root['checkpoints']) ? root['checkpoints'] : [];
	return {
		repo:
			repoRaw['available'] === true
				? { available: true, root: text(repoRaw['root'], 'raiz') }
				: { available: false, reason: text(repoRaw['reason'], 'motivo', 'o modo DEV não está disponível') },
		session,
		authorization,
		...(optionalText(root['message']) !== undefined ? { message: optionalText(root['message']) } : {}),
		...(optionalText(root['startedAt']) !== undefined ? { startedAt: optionalText(root['startedAt']) } : {}),
		canActivate: root['canActivate'] === true,
		canAct: root['canAct'] === true,
		localCredential: parseCredentialView(root['localCredential']),
		credentialActions: {
			canConfigure: (root['credentialActions'] as Record<string, unknown> | undefined)?.['canConfigure'] === true,
			canReset: (root['credentialActions'] as Record<string, unknown> | undefined)?.['canReset'] === true,
		},
		...(optionalText(root['activationBlockedReason']) !== undefined
			? { activationBlockedReason: optionalText(root['activationBlockedReason']) }
			: {}),
		...(operation !== undefined ? { operation } : {}),
		checkpoints: parseCheckpoints(checkpointsRaw),
	};
}

function parseCheckpoints(value: unknown): NonNullable<DevPanelState['operation']>['checkpoints'] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
		.filter((item) => typeof item['id'] === 'string')
		.map((item) => ({
			id: item['id'] as string,
			createdAt: text(item['createdAt'], 'data do checkpoint', ''),
			files: textList(item['files']),
			canRestore: item['canRestore'] === true,
			...(optionalText(item['blockedReason']) !== undefined
				? { blockedReason: optionalText(item['blockedReason']) }
				: {}),
		}));
}

/** O estado da credencial local (DEV-7): rótulos e datas, nunca segredo. */
function parseCredentialView(value: unknown): DevPanelState['localCredential'] {
	if (typeof value !== 'object' || value === null) {
		return { kind: 'unavailable', reason: 'o host não informou o estado da credencial' };
	}
	const view = value as Record<string, unknown>;
	switch (view['kind']) {
		case 'not-configured':
			return { kind: 'not-configured', message: text(view['message'], 'mensagem', '') };
		case 'configured':
			return {
				kind: 'configured',
				configuredAt: text(view['configuredAt'], 'data', ''),
				user: text(view['user'], 'usuário', ''),
			};
		case 'invalidated':
			return {
				kind: 'invalidated',
				message: text(view['message'], 'mensagem', ''),
				canReset: view['canReset'] === true,
			};
		case 'blocked':
			return {
				kind: 'blocked',
				until: text(view['until'], 'data', ''),
				failures: typeof view['failures'] === 'number' ? view['failures'] : 0,
			};
		case 'corrupt':
			return {
				kind: 'corrupt',
				reason: text(view['reason'], 'motivo', ''),
				canReset: view['canReset'] === true,
			};
		default:
			return { kind: 'unavailable', reason: text(view['reason'], 'motivo', 'indisponível') };
	}
}

/** O resultado de uma ação, reduzido ao que a página mostra. */
export function parseDevActionResult(payload: unknown): DevActionResult {
	const value = record(payload, 'resultado DEV');
	return {
		outcome: text(value['outcome'], 'desfecho'),
		detail: text(value['detail'], 'detalhe', ''),
		...(Array.isArray(value['blocked']) ? { blocked: textList(value['blocked']) } : {}),
	};
}

/** Uma linha do histórico de execuções, como a página a mostra (DEV-9.1). */
export interface DevRunHistoryView {
	readonly command: string;
	readonly cwd: string;
	readonly startedAt: string;
	readonly durationMs: number;
	readonly exitCode: number | null;
	readonly termination: 'exited' | 'timeout' | 'cancelled' | 'killed' | 'failed';
	readonly approval: 'approved' | 'refused' | 'cancelled' | 'not-required';
	readonly truncated: boolean;
	readonly reason?: string;
}

const TERMINATIONS = new Set(['exited', 'timeout', 'cancelled', 'killed', 'failed']);
const APPROVALS = new Set(['approved', 'refused', 'cancelled', 'not-required']);

/**
 * Uma linha do diário, ou `undefined` quando ela não tem forma de linha.
 *
 * Devolver `undefined` em vez de lançar é deliberado: o diário é um arquivo
 * que cresce e que pode ter uma linha truncada por uma queda. Uma linha ruim
 * não pode custar o histórico inteiro — o mesmo princípio de
 * `FileDevAudit.list`, aplicado do lado da página.
 */
export function parseDevRunHistoryEntry(payload: unknown): DevRunHistoryView | undefined {
	if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
		return undefined;
	}
	const value = payload as Record<string, unknown>;
	const termination = value['termination'];
	const approval = value['approval'];
	if (
		typeof value['command'] !== 'string' ||
		typeof value['cwd'] !== 'string' ||
		typeof value['startedAt'] !== 'string' ||
		typeof value['durationMs'] !== 'number' ||
		termination === undefined ||
		!TERMINATIONS.has(String(termination)) ||
		approval === undefined ||
		!APPROVALS.has(String(approval))
	) {
		return undefined;
	}
	const exitCode = value['exitCode'];
	return {
		command: value['command'],
		cwd: value['cwd'],
		startedAt: value['startedAt'],
		durationMs: value['durationMs'],
		exitCode: typeof exitCode === 'number' ? exitCode : null,
		termination: String(termination) as DevRunHistoryView['termination'],
		approval: String(approval) as DevRunHistoryView['approval'],
		truncated: value['truncated'] === true,
		...(typeof value['reason'] === 'string' ? { reason: value['reason'] } : {}),
	};
}
