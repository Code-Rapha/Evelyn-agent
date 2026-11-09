/**
 * O que a interface do modo DEV mostra (DEV-6).
 *
 * ## Por que uma projeção, e não o estado cru
 *
 * O renderer é a parte menos confiável do app. `DevOperation`, `DevSession` e
 * o diário têm dados que ele **não** precisa: o token da sessão (que decide a
 * aplicação), o nonce, o conteúdo das escritas e caminhos absolutos. Este
 * módulo transforma o estado real num formato para a página — nomeado campo a
 * campo, com caminhos **relativos** e sem nada de credencial.
 *
 * ## O que ele não faz
 *
 * Não decide permissão: quem decide é o `DevHost`/`DevSession`, no `main`.
 * Aqui só se lê o estado e se escolhe o texto. Uma página que altere qualquer
 * campo deste objeto não muda comportamento nenhum no Core.
 */

import type { ApplyStage, DevOperation } from './devOperation';
import type { CheckpointSummary } from './devCheckpoint';
import type { ApplyStrategy } from './applyPolicy';

/** Um checkpoint, como a página o vê. */
export interface DevCheckpointView {
	readonly id: string;
	/** Quando o estado anterior foi capturado (ISO do Core). */
	readonly createdAt: string;
	readonly files: readonly string[];
	/** Restaurável agora, pelo que o Core sabe? `false` com `blockedReason`. */
	readonly canRestore: boolean;
	readonly blockedReason?: string;
}

/** Uma operação, como a página a vê. */
export interface DevOperationView {
	readonly id: string;
	/** A etapa real da DEV-3, sem renome. */
	readonly stage: ApplyStage;
	/** O texto da etapa para a página (do mesmo vocabulário do Core). */
	readonly stageLabel: string;
	readonly strategy: ApplyStrategy;
	readonly files: readonly string[];
	/** As verificações, com o resultado que o Core registrou. */
	readonly checks: readonly { readonly name: string; readonly result?: string }[];
	/** As linhas de resultado, na ordem. */
	readonly results: readonly string[];
	readonly startedAt: string;
	readonly updatedAt: string;
	/** Pode ser aplicada agora (etapa aplicável e há preparação viva)? */
	readonly canApply: boolean;
	readonly applyBlockedReason?: string;
	/** Pode ser desfeita pelo checkpoint? */
	readonly canRestore: boolean;
	readonly restoreBlockedReason?: string;
	/**
	 * A página pode pedir ações (ativar, aplicar, restaurar) desta janela?
	 *
	 * Só a janela principal do host: as outras têm a leitura e pedem ao vencedor.
	 * É uma dica para a interface não oferecer o que seria recusado — o `main`
	 * recusa de qualquer forma.
	 */
	readonly canAct: boolean;
	/** Exige reinício controlado — a página pede confirmação antes. */
	readonly requiresControlledRestart: boolean;
	readonly checkpoints: readonly DevCheckpointView[];
}

/** O estado da autorização local, para a página (DEV-7). Sem segredo. */
export type DevAuthorizationView =
	| { readonly kind: 'not-configured'; readonly message: string }
	| { readonly kind: 'configured'; readonly configuredAt: string; readonly user: string }
	| { readonly kind: 'invalidated'; readonly message: string; readonly canReset: boolean }
	| { readonly kind: 'blocked'; readonly until: string; readonly failures: number }
	| { readonly kind: 'corrupt'; readonly reason: string; readonly canReset: boolean }
	| { readonly kind: 'unavailable'; readonly reason: string };

/** O que a página pode fazer com a credencial. */
export interface DevAuthorizationActions {
	/** Há uma ação a oferecer para trocar a credencial (recuperação). */
	readonly canReset: boolean;
	/** Configurar/recuperar estão disponíveis neste host? */
	readonly canConfigure: boolean;
}

/** O estado inteiro da área DEV. */
export interface DevPanelState {	/** Há repositório DEV neste host, e a raiz (nunca a de outro processo). */
	readonly repo: { readonly available: true; readonly root: string } | { readonly available: false; readonly reason: string };
	/**
	 * A sessão está ativa?
	 *
	 * `authorization` resume **por que**: ativa, sem autorização, ou uma sessão
	 * pendente de restauração (DEV-6) que não conta como ativa.
	 */
	readonly session: 'active' | 'inactive';
	readonly authorization: 'active' | 'none' | 'pending-restore' | 'unavailable';
	/** O motivo legível da autorização/modo indisponível. */
	readonly message?: string;
	/** Quando a sessão ativa começou (ISO), se houver. */
	readonly startedAt?: string;
	/** Se a ativação está disponível **agora** (e por quê não). */
	readonly canActivate: boolean;
	readonly activationBlockedReason?: string;
	/** A janela que pediu pode agir (ativar/aplicar/restaurar)? */
	readonly canAct: boolean;
	/** A credencial local que autoriza a ativação (DEV-7). */
	readonly localCredential: DevAuthorizationView;
	readonly credentialActions: DevAuthorizationActions;
	/**
	 * O desbloqueio persistente neste dispositivo.
	 *
	 * Ausente = o recurso não existe neste host (a ativação pede a senha
	 * sempre, como antes). Presente = a tela pode oferecer descarregar a senha,
	 * bloquear e revogar.
	 */
	readonly persistent?: {
		/** A opção está ligada neste host? */
		readonly available: boolean;
		/** Há um recibo utilizável agora? */
		readonly remembered: boolean;
		/** Motivo de o recibo existente não valer, quando não vale. */
		readonly problem?: string;
		/** A sessão já está ativa por causa dele? */
		readonly unlocked: boolean;
		/** Quando foi lembrado (ISO), se houver. */
		readonly since?: string;
	};
	/** A operação atual ou pendente, quando o Core tem uma. */
	readonly operation?: DevOperationView;
	/** Os checkpoints conhecidos, do mais recente para o mais antigo. */
	readonly checkpoints: readonly DevCheckpointView[];
}

/** O texto de cada etapa, no vocabulário que o Core usa. */
const STAGE_LABELS: Readonly<Record<ApplyStage, string>> = {
	planned: 'Preparada',
	checkpointed: 'Checkpoint criado',
	written: 'Escrita, aguardando verificação',
	verified: 'Verificada, aguardando aplicação',
	'verification-failed': 'Falhou na verificação',
	applying: 'Aplicando',
	'rolled-back': 'Desfeita pelo checkpoint',
	done: 'Concluída',
};

/** As etapas em que o fluxo aceita aplicar (`applyPrepared`). */
const APPLICABLE = new Set<ApplyStage>(['planned', 'checkpointed', 'written']);

/**
 * Projeta uma operação.
 *
 * `readyToApply` diz se há uma preparação **viva** (o diário em memória) para
 * esta operação — sem ela, aplicar de novo seria começar do zero, e a página
 * não deve oferecer. O id vem do diário; as escritas, não.
 */
export function toOperationView(
	operation: DevOperation,
	options: {
		readonly operationId?: string;
		readonly readyToApply?: boolean;
		/** A raiz autorizada, para relativizar; sem ela, caminhos relativos passam como estão. */
		readonly root?: string;
		/** A janela que pede é a do host? (só ela age) Padrão: sim. */
		readonly canAct?: boolean;
		readonly checkpoints?: readonly CheckpointSummary[];
		readonly checkpointStatus?: ReadonlyMap<string, { readonly ok: boolean; readonly reason?: string }>;
	} = {},
): DevOperationView {
	const id = options.operationId ?? 'corrente';
	const root = options.root;
	const applicable = APPLICABLE.has(operation.stage);
	const canApply = applicable && options.readyToApply === true;
	const checkpoints = (options.checkpoints ?? []).map((summary) => {
		const status = options.checkpointStatus?.get(summary.id);
		return {
			id: summary.id,
			createdAt: summary.createdAt,
			files: summary.files.map((path) => relativeOnly(path, root)),
			canRestore: status?.ok ?? true,
			...(status !== undefined && !status.ok && status.reason !== undefined
				? { blockedReason: status.reason }
				: {}),
		};
	});
	// Restaurar só faz sentido quando a operação **não** está concluída com
	// sucesso e existe checkpoint com o estado anterior.
	const restorable = checkpoints.filter((checkpoint) => checkpoint.canRestore);
	return {
		id,
		stage: operation.stage,
		stageLabel: STAGE_LABELS[operation.stage],
		strategy: operation.strategy,
		files: operation.files.map((path) => relativeOnly(path, root)),
		checks: operation.checks.map((name) => {
			const result = operation.results.find((line) => line.startsWith(`${name}:`));
			return { name, ...(result !== undefined ? { result } : {}) };
		}),
		results: [...operation.results],
		startedAt: operation.startedAt,
		updatedAt: operation.updatedAt,
		canApply,
		...(canApply
			? {}
			: {
					applyBlockedReason: !applicable
						? `a operação está em "${STAGE_LABELS[operation.stage].toLowerCase()}" e não é aplicável`
						: 'não há uma preparação viva desta operação nesta sessão',
				}),
		canRestore: restorable.length > 0,
		canAct: options.canAct !== false,
		...(restorable.length > 0
			? {}
			: {
					restoreBlockedReason:
						checkpoints.length === 0
							? 'não há checkpoint desta operação'
							: checkpoints.every((checkpoint) => checkpoint.blockedReason !== undefined)
								? (checkpoints[0]?.blockedReason ?? 'restauração não permitida')
								: 'restauração não permitida',
				}),
		requiresControlledRestart: operation.strategy === 'restart-controlled',
		checkpoints,
	};
}

/**
 * O caminho relativo à raiz, com `/`.
 *
 * Defesa em profundidade: o Core já fala caminhos relativos nas operações, mas
 * um caminho absoluto (de uma operação antiga ou de um bug) nunca chega à
 * página — ele revelaria onde o usuário guarda o repositório por outro ângulo.
 * Fora da raiz vira `?`, e não o caminho em si: "não sei" é mais honesto do
 * que expor onde o arquivo está.
 */
function relativeOnly(path: string, root?: string): string {
	const normalized = path.replace(/\\/g, '/');
	if (root !== undefined) {
		const rootNormalized = root.replace(/\\/g, '/').replace(/\/+$/, '');
		const lowerPath = normalized.toLowerCase();
		const lowerRoot = rootNormalized.toLowerCase();
		if (lowerPath === lowerRoot) {
			return '.';
		}
		if (lowerPath.startsWith(`${lowerRoot}/`)) {
			return normalized.slice(rootNormalized.length + 1);
		}
	}
	if (/^[A-Za-z]:/.test(normalized) || normalized.startsWith('/') || normalized.startsWith('//')) {
		return '?';
	}
	return normalized.replace(/^\.\//, '');
}
