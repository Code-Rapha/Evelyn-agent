/**
 * `dev_apply`: o gatilho real de aplicação de uma alteração (DEV-5).
 *
 * ## O que ele **não** faz
 *
 * Não escolhe arquivos, não escreve, não decide estratégia, não roda comando
 * arbitrário. Ele **pega uma operação que já foi preparada** pelo `dev_write`,
 * confere que ela ainda pode ser aplicada, e entrega ao `applyChange` — que é
 * o fluxo da DEV-3 (checkpoint → verificação → estratégia → `ApplyTarget`).
 * Toda a política mora lá; aqui só há a porta de entrada e a validação.
 *
 * ## O que ele valida, no momento de aplicar
 *
 * 1. **Sessão DEV ativa** — a mesma checagem por execução das outras
 *    ferramentas. Registrar a ferramenta não é autorização.
 * 2. **A raiz da operação é a raiz da sessão** — um id de outra raiz não
 *    atravessa. O caminho nunca vem do argumento.
 * 3. **A operação existe no diário** e tem escritas. Sem escritas não há o
 *    que aplicar.
 * 4. **Não foi aplicada antes** — o `applyChange` só aceita operação em etapa
 *    `planned`/`checkpointed`/`written`; e o diário é consumido após a
 *    aplicação, para o mesmo id não voltar.
 * 5. **Nenhuma aplicação em curso** para a mesma operação (duas chamadas
 *    concorrentes: a segunda é recusada, não espera nem duplica).
 *
 * ## Autorização
 *
 * Vem do host: `DevSession` em memória, criada por `enter()` que só o main
 * chama. Não há argumento, mensagem, arquivo ou campo persistido que a
 * conceda — e a ferramenta não tem como criar uma sessão.
 */

import type { AgentTool, ToolDescriptor, ToolExecutionContext, ToolResult } from './types';
import type { ToolSpec } from './toolRegistry';
import { AgentError } from '../errors';
import type { DevSessionRef } from '../dev/devSession';
import type { PreparedChangeJournal } from '../dev/preparedChange';
import type { DevCheckpointStore } from '../dev/devCheckpoint';
import type { DevOperationStore, DevOperation } from '../dev/devOperation';
import { advance } from '../dev/devOperation';
import { applyPrepared, type ApplyTarget, type ApplyOutcome } from '../dev/devApply';
import { planApply } from '../dev/applyPolicy';

export const DEV_APPLY = 'dev_apply';

/** O que o gatilho precisa. */
export interface DevApplyDeps {
	/** A sessão: só leitura de `isActive`/`root`/`sessionToken`. */
	readonly session: DevSessionRef;
	readonly journal: PreparedChangeJournal;
	readonly operations: DevOperationStore;
	readonly checkpoints: DevCheckpointStore;
	/**
	 * O alvo do host (`electronApply` em produção). **Por aplicação**, não
	 * fixo: o adaptador lembra "já reiniciei", e essa memória não pode passar
	 * de uma operação para outra.
	 */
	createTarget(): ApplyTarget;
	/** Escreve um arquivo do repositório — o mesmo caminho do `dev_write`. */
	writeFile(path: string, content: string): Promise<void>;
	/** Relógio, injetável em teste. */
	readonly now?: () => Date;
}

/** Um único `dev_apply` por operação: duas chamadas concorrentes não duplicam. */
const inFlight = new WeakMap<DevApplyDeps, Set<string>>();

function inFlightFor(deps: DevApplyDeps): Set<string> {
	let set = inFlight.get(deps);
	if (set === undefined) {
		set = new Set<string>();
		inFlight.set(deps, set);
	}
	return set;
}

/** O desfecho legível para o modelo, sem conteúdo de arquivo. */
function describe(outcome: ApplyOutcome): string {
	switch (outcome.kind) {
		case 'done':
			return `aplicada: ${outcome.operation.results.join('; ')}`;
		case 'rolled-back':
			return `aplicação falhou e foi desfeita pelo checkpoint: ${outcome.reason}`;
		case 'verification-failed':
			return `não aplicada — a verificação falhou: ${outcome.reason}. O checkpoint foi preservado.`;
		case 'rollback-failed':
			return `aplicação falhou e o desfazer também: ${outcome.reason}. Os checkpoints foram preservados; intervenção necessária.`;
	}
}

/** As etapas em que uma operação pode ser aplicada. */
const APPLICABLE = new Set<DevOperation['stage']>(['planned', 'checkpointed', 'written']);

/**
 * A sessão viva é a que preparou a operação?
 *
 * `sessionToken()` é do `DevSessionRef`; um ref de teste pode não expor o
 * método, e nesse caso a sessão ativa é a única garantia — que é a mesma
 * garantia das outras `dev_*`. Comparação por igualdade de string, sem
 * decodificar nada.
 */
function sameSession(session: DevSessionRef, token: string): boolean {
	const current = (session as { readonly sessionToken?: unknown }).sessionToken;
	if (typeof current !== 'function') {
		return true;
	}
	try {
		return (current as () => string).call(session) === token;
	} catch {
		return false;
	}
}

/**
 * Cria a ferramenta.
 *
 * O `target` é injetado pelo host. Sem `target`, o host não oferece a
 * ferramenta (o `createDevTools` decide) — ela não existe para "fingir"
 * aplicação.
 */
export function createDevApplyTool(deps: DevApplyDeps): AgentTool<
	unknown,
	{ readonly outcome: ApplyOutcome['kind']; readonly operationId: string; readonly detail: string }
> {
	const descriptor: ToolDescriptor = {
		id: DEV_APPLY,
		name: DEV_APPLY,
		category: 'other',
		riskLevel: 'dangerous',
		description: 'Apply a prepared DEV change: checkpoint, verification, and host reload/restart (DEV mode only)',
	};
	return {
		descriptor,
		async execute(input): Promise<
			ToolResult<{ readonly outcome: ApplyOutcome['kind']; readonly operationId: string; readonly detail: string }>
		> {
			// 1. Sessão: checada **agora**, não no registro.
			if (!deps.session.isActive()) {
				return {
					ok: false,
					error: 'o modo DEV não está ativo; a aplicação precisa de uma sessão autorizada pelo proprietário',
				};
			}
			// 1b. Confirmação explícita (DEV-AUDIT-03, correção 1).
			//
			// A ferramenta **consome** a operação ao aplicar: depois de um
			// "done", a journal apaga a entrada e não há segunda tentativa sem
			// escrever tudo de novo. Confiar só no gateway deixava isso a cargo
			// de quem monta o stack — e um gateway que permite sem perguntar
			// (o `allowAllGateway` existe no produto) aplicaria sem ninguém ter
			// visto. A confirmação passa a ser exigida **aqui**, na ferramenta.
			//
			// A checagem vem **depois** de resolver a operação: "não há
			// operação" é mais útil para o modelo do que "falta confirmar" para
			// algo que nem existe.
			let operationId: string;
			try {
				const requested = (input as { readonly operationId?: unknown } | undefined)?.operationId;
				operationId = typeof requested === 'string' && requested.length > 0 ? requested : '';
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}

			const journaled =
				operationId.length > 0
					? deps.journal.get(operationId)
					: deps.journal.latestFor(deps.session.root());
			if (journaled === undefined) {
				return {
					ok: false,
					error:
						operationId.length > 0
							? `não há operação "${operationId}" preparada para aplicar`
							: 'não há operação preparada para aplicar; use dev_write antes',
				};
			}
			operationId = journaled.operationId;

			// 2. A raiz da operação é a da sessão. Um id de outra raiz não passa.
			const root = deps.session.root();
			if (journaled.root !== root) {
				return {
					ok: false,
					error: 'a operação pertence a outro repositório; a sessão DEV atual não pode aplicá-la',
				};
			}
			// 2b. A operação foi preparada **nesta** sessão. `enter()` troca o
			// token a cada entrada, então uma operação preparada antes de um
			// `exit` não é aplicável depois de outro `enter` — ela é de outra
			// autorização, que já foi retirada.
			if (!sameSession(deps.session, journaled.sessionToken)) {
				return {
					ok: false,
					error:
						'a operação foi preparada numa sessão DEV anterior; prepare a mudança novamente com dev_write',
				};
			}
			if (journaled.writes.length === 0) {
				return { ok: false, error: 'a operação não tem arquivos escritos; não há o que aplicar' };
			}

			// 2c. Confirmação explícita (DEV-AUDIT-03, correção 1).
			//
			// A ferramenta **consome** a operação ao aplicar: depois de um
			// "done", a journal apaga a entrada, e não há segunda tentativa sem
			// escrever tudo de novo. Confiar só no gateway deixava isso a cargo
			// de quem monta o stack — e o produto tem um `allowAllGateway`, que
			// aplicaria sem ninguém ter visto. A confirmação passa a ser
			// exigida **aqui**, na ferramenta, depois de a operação existir e
			// ser desta sessão (para a mensagem dizer o motivo certo).
			const confirmed = (input as { readonly confirm?: unknown } | undefined)?.confirm;
			if (confirmed !== true) {
				return {
					ok: false,
					error:
						'a aplicação precisa de confirmação explícita: chame com `confirm: true` ' +
						'depois de o proprietário aprovar. Nada foi aplicado e a operação continua disponível.',
				};
			}

			// 3. Concorrência: a mesma operação, uma vez.
			//
			// A marca entra **antes** de qualquer espera. Verificar "não está
			// rodando" e só então marcar deixaria uma janela entre a leitura
			// do diário e a marca em que duas chamadas passariam juntas — e as
			// duas gravariam o `operation.json` ao mesmo tempo. Por isso a
			// reserva é síncrona, aqui, e todas as checagens que dependem de
			// I/O vêm depois dela.
			const running = inFlightFor(deps);
			if (running.has(operationId)) {
				return { ok: false, error: 'esta operação já está sendo aplicada' };
			}
			running.add(operationId);

			try {
				// 4. A operação no store precisa ser desta operação (mesmo
				//    nonce) e estar numa etapa aplicável. O store tem uma
				//    operação por vez; se ele guarda outra, esta não tem
				//    registro próprio e começa em `planned`.
				const existing = await deps.operations.read().catch(() => undefined);
				const own = existing !== undefined && existing.nonce === journaled.nonce ? existing : undefined;
				if (own !== undefined && !APPLICABLE.has(own.stage)) {
					return {
						ok: false,
						error:
							own.stage === 'done'
								? 'esta operação já foi aplicada'
								: `a operação está em "${own.stage}" e não pode ser aplicada de novo`,
					};
				}

				// 5. A operação entregue ao fluxo é a **preparada**: mesmos
				//    arquivos, mesmo id, mesma estratégia da política. O
				//    `applyPrepared` é o `applyChange` da DEV-3 com as etapas
				//    vindas do store — não há uma segunda implementação.
				const plan = planApply(journaled.files);
				const prepared: DevOperation =
					own ??
					({
						version: 1,
						...(journaled.conversationId !== undefined ? { conversationId: journaled.conversationId } : {}),
						nonce: journaled.nonce,
						stage: 'planned',
						strategy: plan.strategy,
						files: [...journaled.files],
						checks: [],
						results: [],
						startedAt: journaled.createdAt,
						updatedAt: (deps.now ?? (() => new Date()))().toISOString(),
					} satisfies DevOperation);

				const outcome = await applyPrepared(
					{
						...(journaled.conversationId !== undefined ? { conversationId: journaled.conversationId } : {}),
						operation: prepared,
						writes: journaled.writes,
						root,
						operations: deps.operations,
						checkpoints: deps.checkpoints,
						writeFile: deps.writeFile,
					},
					// O alvo é desta aplicação: criado agora, não herdado.
					deps.createTarget(),
				);

				// Consumido **depois** de a aplicação acontecer: uma falha
				// anterior deixa o diário para nova tentativa; um sucesso (ou
				// um desfazer seguro) não pode ser reaplicado por engano.
				if (outcome.kind === 'done' || outcome.kind === 'rolled-back') {
					deps.journal.consume(operationId);
				}

				return {
					ok: outcome.kind === 'done',
					output: { outcome: outcome.kind, operationId, detail: describe(outcome) },
					...(outcome.kind === 'done' ? {} : { error: describe(outcome) }),
				};
			} catch (error) {
				// Uma exceção no meio deixa a operação como o `applyChange` a
				// deixou (etapa gravada). O diário continua, para a retomada.
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					error: `a aplicação falhou antes de concluir: ${message}. A operação continua recuperável.`,
				};
			} finally {
				running.delete(operationId);
			}
		},
	};
}

/** A spec, no formato que o modelo recebe. */
export const DEV_APPLY_SPEC: ToolSpec = {
	name: DEV_APPLY,
	description:
		'Apply a DEV change prepared with dev_write: creates checkpoints, runs the required checks, then reloads or restarts the app as the change requires (DEV mode only)',
	parameters: {
		type: 'object',
		properties: {
			operationId: {
				type: 'string',
				description: 'The operation id returned by dev_write. Omit to apply the most recent prepared change.',
			},
			confirm: {
				type: 'boolean',
				description:
					'Must be true. Applying consumes the prepared operation; without this flag nothing is applied and the operation stays available for a later attempt after the owner approves.',
			},
		},
		// `confirm` é obrigatório na prática (a ferramenta recusa sem ele). A
		// lista `required` do JSON Schema não é aplicada pelo Core — a recusa
		// real é a checagem dentro de `execute` —, mas declarar aqui evita que
		// o modelo tente sem o campo.
		required: ['confirm'],
	},
	riskLevel: 'dangerous',
	category: 'other',
};

/**
 * Aviso de estado para o modelo quando a operação foi marcada como aplicada
 * mas o host apenas aceitou a solicitação.
 *
 * Nunca devolve sucesso: é o caso "o Electron aceitou `relaunch`, mas a nova
 * versão não foi confirmada". `applyChange` já transforma isso em
 * `verification-failed`/`rolled-back`; este texto só existe para o gatilho não
 * inventar uma conclusão própria.
 */
export function notConfirmed(outcome: DevOperation): string {
	return (
		`a operação ficou em "${outcome.stage}": o host aceitou a solicitação, ` +
		'mas a nova versão não foi confirmada. Nada é dado como concluído; ' +
		'o checkpoint continua disponível para desfazer.'
	);
}

/** Avança a etapa num teste sem depender do fluxo completo. */
export { advance };

