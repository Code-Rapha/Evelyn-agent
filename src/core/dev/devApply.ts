/**
 * O fluxo transacional de uma alteração (DEV-3).
 *
 * ## A ordem, e o que cada passo protege
 *
 * ```
 * planejar → checkpoint → escrever → verificar → aplicar → conferir → relatar
 *                                                        ↘ desfazer (falhou)
 * ```
 *
 * - **Planejar** decide a estratégia **antes** de tocar em nada: um arquivo
 *   crítico já nasce sabendo que exigirá reinício controlado.
 * - **Checkpoint** vem antes da primeira escrita e não depende de a escrita
 *   dar certo: é o que permite voltar.
 * - **Escrever** é o `dev_write`, com a trava e a política de caminhos da
 *   DEV-2/2.1. Se falhar, o checkpoint do passo anterior continua lá.
 * - **Verificar** roda os comandos permitidos do `dev_run` e registra o
 *   resultado **por comando** — "verificado" só existe com a lista completa.
 * - **Aplicar** é uma decisão do host (recarregar a janela, reiniciar). Aqui
 *   ele é injetado: o núcleo não sabe recarregar nada, e um teste pode
 *   observar o pedido sem reiniciar o ambiente.
 * - **Conferir** pergunta ao host se a nova versão está funcional. Falha
 *   leva a desfazer, nunca a "concluído".
 * - **Desfazer** usa o checkpoint. Se **ele** falhar, a operação fica em
 *   `verification-failed`/`rolled-back` conforme o caso, com o diagnóstico —
 *   jamais como sucesso.
 *
 * Tudo é gravado em `DevOperationStore` a cada transição: um processo que
 * morra no meio deixa a etapa e o checkpoint legíveis para a retomada.
 */

import { DevCheckpointStore } from './devCheckpoint';
import { planApply, type ApplyStrategy } from './applyPolicy';
import {
	advance,
	startOperation,
	type DevOperation,
	type DevOperationStore,
} from './devOperation';
import { missingChecks, REQUIRED_CHECKS } from './devContinuity';

export { REQUIRED_CHECKS };

/** O que o host faz para tornar a mudança efetiva. */
export interface ApplyTarget {
	/**
	 * Executa o comando de verificação (`npm run test:core`…) no repositório.
	 *
	 * Devolve o código de saída; o núcleo não interpreta a saída inteira, só
	 * registra sucesso/falha.
	 */
	runCheck(command: string): Promise<{ readonly exitCode: number; readonly summary: string }>;
	/** Recarrega a interface. Resolve quando a janela voltou. */
	reloadUi(): Promise<void>;
	/** Reinicia o aplicativo. Não retorna num reinício real. */
	restartApp(options: { readonly controlled: boolean }): Promise<void>;
	/** Confere que a nova versão responde. */
	probe(): Promise<{ readonly ok: boolean; readonly detail: string }>;
}

/** O pedido de uma alteração. */
export interface ApplyRequest {
	readonly conversationId?: string;
	/** Os arquivos, relativos à raiz do repositório. */
	readonly files: readonly string[];
	/** As escritas, na ordem em que o agente as produziu. */
	readonly writes: readonly { readonly path: string; readonly content: string }[];
	/** A origem do arquivo de conversa — para o checkpoint, quando houver. */
	readonly root: string;
	/** Onde gravar a operação. */
	readonly operations: DevOperationStore;
	/** Onde ficam os checkpoints. */
	readonly checkpoints: DevCheckpointStore;
	/** Escreve um arquivo do repositório (o `dev_write` ou equivalente). */
	writeFile(path: string, content: string): Promise<void>;
}

/** O desfecho do fluxo. */
export type ApplyOutcome =
	| { readonly kind: 'done'; readonly operation: DevOperation }
	/** Aplicado, mas a conferência falhou e o checkpoint foi restaurado. */
	| { readonly kind: 'rolled-back'; readonly operation: DevOperation; readonly reason: string }
	/** Não aplicado: a verificação falhou. O checkpoint continua. */
	| { readonly kind: 'verification-failed'; readonly operation: DevOperation; readonly reason: string }
	/** O rollback em si falhou: o diagnóstico é preservado, o estado é incerto. */
	| { readonly kind: 'rollback-failed'; readonly operation: DevOperation; readonly reason: string };

/**
 * O fluxo **quando a operação já existe** (DEV-5).
 *
 * O `adopt` não inventa uma operação nova: ele recebe a que o `dev_write`
 * registrou e carrega as etapas dela. Duas consequências que a versão antiga
 * não dava:
 *
 * - **o id é o mesmo desde a preparação** — é ele que o proprietário vê, e
 *   reaplicar é reconhecível;
 * - **o estado fica no store a cada passo**, então um processo interrompido
 *   deixa a operação na etapa em que parou, não numa operação anônima nova.
 *
 * Só aceita uma operação fresca (`planned`, sem checkpoints nem resultados);
 * qualquer outra coisa é recusada por `resumeOperation` — nunca "recomeçada
 * por cima" de uma aplicação que pode ter acontecido.
 */
export interface AdoptRequest extends Omit<ApplyRequest, 'files'> {
	readonly operation: DevOperation;
}

/** A operação não pode ser adotada no estado em que está. */
export class ApplyStateError extends Error {
	readonly code = 'dev_apply_state';
	constructor(message: string) {
		super(message);
		this.name = 'ApplyStateError';
	}
}

/**
 * Executa o fluxo a partir de uma operação já registrada (DEV-5).
 *
 * É o **mesmo** corpo de `applyChange`, com o checkpoint e as etapas vindos do
 * store; não há uma segunda implementação da política nem do desfazer.
 */
export async function applyPrepared(
	request: AdoptRequest,
	target: ApplyTarget,
	options: { readonly now?: () => Date } = {},
): Promise<ApplyOutcome> {
	const { operations, root, checkpoints } = request;
	const prepared = request.operation;
	if (prepared.stage !== 'planned' && prepared.stage !== 'checkpointed' && prepared.stage !== 'written') {
		throw new ApplyStateError(`a operação está em "${prepared.stage}" e não pode ser aplicada`);
	}
	let operation = prepared;
	const write = async (next: DevOperation): Promise<void> => {
		operation = next;
		await operations.write(next);
	};

	// Uma operação com arquivos e sem escritas não tem o que aplicar: dizer
	// "done" seria afirmar uma mudança que nunca chegou ao disco. Isto já foi
	// um defeito real (`dev_write` registrava a escrita, mas o diário a perdia
	// e listava o arquivo), então a recusa mora **aqui**, não só no gatilho.
	if (request.writes.length === 0) {
		throw new ApplyStateError('a operação não tem escritas: não há o que aplicar');
	}

	// Verificação e checkpoints ANTES das escritas — é a ordem da DEV-3. A
	// operação adotada não pode ser escrita por cima de um estado que o
	// `dev_write` já tinha deixado: se já houver escritas, elas são
	// repetidas de forma idempotente abaixo.
	const plan = planApply(operation.files);
	const created: { path: string; checkpointId: string }[] = [];
	try {
		for (const file of operation.files) {
			const checkpointId = await checkpoints.capture({ root, path: file, operation: 'dev-apply' });
			created.push({ path: file, checkpointId });
		}
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		await write(advance(operation, 'verification-failed', { result: `checkpoint falhou: ${reason}` }));
		return { kind: 'verification-failed', operation, reason };
	}
	await write(
		advance(operation, 'checkpointed', {
			...(created[0] !== undefined ? { checkpointId: created[0].checkpointId } : {}),
		}),
	);

	try {
		for (const entry of request.writes) {
			await request.writeFile(entry.path, entry.content);
		}
		for (const entry of created) {
			await checkpoints.seal(entry.checkpointId, root, entry.path);
		}
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		await write(advance(operation, 'verification-failed', { result: `escrita falhou: ${reason}` }));
		return { kind: 'verification-failed', operation, reason };
	}
	await write(advance(operation, 'written'));

	for (const check of plan.extraChecks) {
		if (!check.startsWith('npm ')) {
			await write(advance(operation, 'written', { check, result: check }));
			continue;
		}
		const outcome = await target.runCheck(check);
		if (outcome.exitCode !== 0) {
			await write(advance(operation, 'verification-failed', { check, result: `${check}: falhou (${outcome.summary})` }));
			return { kind: 'verification-failed', operation, reason: `${check} falhou` };
		}
		await write(advance(operation, 'written', { check, result: `${check}: ok` }));
	}
	const missing = missingChecks(operation);
	if (missing.length > 0) {
		await write(
			advance(operation, 'verification-failed', {
				result: `verificações obrigatórias ausentes: ${missing.join(', ')}`,
			}),
		);
		return { kind: 'verification-failed', operation, reason: 'verificações obrigatórias ausentes' };
	}
	await write(advance(operation, 'verified'));

	await write(advance(operation, 'applying'));
	try {
		await applyStrategy(plan.strategy, target);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return await rollback(request, operation, reason);
	}
	const probe = await target.probe();
	if (!probe.ok) {
		return await rollback(request, operation, probe.detail);
	}
	await write(advance(operation, 'done', { result: `aplicado: ${probe.detail}` }));
	return { kind: 'done', operation };
}

/**
 * Executa o fluxo.
 *
 * `strategy` **não** é escolhida pelo agente: vem de `planApply`, a partir dos
 * arquivos. O pedido traz as escritas já autorizadas pelas permissões do
 * host — este módulo não pede permissão e não decide se pode escrever; ele
 * decide o que fazer com a escrita depois dela.
 */
export async function applyChange(
	request: ApplyRequest,
	target: ApplyTarget,
	options: { readonly now?: () => Date } = {},
): Promise<ApplyOutcome> {
	const plan = planApply(request.files);
	let operation = startOperation({
		...(request.conversationId !== undefined ? { conversationId: request.conversationId } : {}),
		strategy: plan.strategy,
		files: request.files,
		...(options.now !== undefined ? { now: options.now } : {}),
	});
	await request.operations.write(operation);

	// Checkpoint antes de escrever: um por arquivo, todos numa operação.
	const created = await checkpointAll(request);
	operation = advance(operation, 'checkpointed', {
		...(created[0] !== undefined ? { checkpointId: created[0].checkpointId } : {}),
	});
	await request.operations.write(operation);

	// Escrita: se falhar, o checkpoint continua válido para desfazer o que já
	// tiver sido escrito.
	try {
		for (const write of request.writes) {
			await request.writeFile(write.path, write.content);
		}
		// O selo diz "este é o conteúdo que o DEV deixou". Sem ele, a
		// restauração trataria o próprio resultado como alteração externa e se
		// recusaria a desfazer — que é o que acontecia antes.
		for (const entry of created) {
			await request.checkpoints.seal(entry.checkpointId, request.root, entry.path);
		}
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		operation = advance(operation, 'verification-failed', {
			result: `escrita falhou: ${reason}`,
		});
		await request.operations.write(operation);
		return { kind: 'verification-failed', operation, reason };
	}
	operation = advance(operation, 'written');
	await request.operations.write(operation);

	// Verificação: cada comando é registrado; a lista completa é exigida.
	for (const check of plan.extraChecks) {
		if (!check.startsWith('npm ')) {
			// Avisos (ex.: "confirmar com o proprietário") não são comandos.
			operation = advance(operation, 'written', { check, result: `${check}` });
			await request.operations.write(operation);
			continue;
		}
		const outcome = await target.runCheck(check);
		if (outcome.exitCode !== 0) {
			operation = advance(operation, 'verification-failed', {
				check,
				result: `${check}: falhou (${outcome.summary})`,
			});
			await request.operations.write(operation);
			return { kind: 'verification-failed', operation, reason: `${check} falhou` };
		}
		operation = advance(operation, 'written', { check, result: `${check}: ok` });
		await request.operations.write(operation);
	}
	const missing = missingChecks(operation);
	if (missing.length > 0) {
		// A estratégia exige verificações que o plano não listou: não há como
		// afirmar "verificado".
		operation = advance(operation, 'verification-failed', {
			result: `verificações obrigatórias ausentes: ${missing.join(', ')}`,
		});
		await request.operations.write(operation);
		return { kind: 'verification-failed', operation, reason: 'verificações obrigatórias ausentes' };
	}
	operation = advance(operation, 'verified');
	await request.operations.write(operation);

	// Aplicação.
	operation = advance(operation, 'applying');
	await request.operations.write(operation);
	try {
		await applyStrategy(plan.strategy, target);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return await rollback(request, operation, reason);
	}

	// Conferência: aplicar sem saber se funcionou é o mesmo que não saber.
	const probe = await target.probe();
	if (!probe.ok) {
		return await rollback(request, operation, probe.detail);
	}

	operation = advance(operation, 'done', { result: `aplicado: ${probe.detail}` });
	await request.operations.write(operation);
	return { kind: 'done', operation };
}

async function applyStrategy(strategy: ApplyStrategy, target: ApplyTarget): Promise<void> {
	switch (strategy) {
		case 'hot':
		case 'reload-ui':
			await target.reloadUi();
			return;
		case 'restart-app':
			await target.restartApp({ controlled: false });
			return;
		case 'restart-controlled':
			await target.restartApp({ controlled: true });
			return;
	}
}

/** Cria um checkpoint para cada arquivo, antes da primeira escrita. */
async function checkpointAll(request: ApplyRequest): Promise<readonly { readonly path: string; readonly checkpointId: string }[]> {
	const created: { path: string; checkpointId: string }[] = [];
	for (const write of request.writes) {
		const checkpointId = await request.checkpoints.capture({
			root: request.root,
			path: write.path,
			operation: 'dev-apply',
		});
		created.push({ path: write.path, checkpointId });
	}
	return created;
}

/**
 * Desfaz pelo checkpoint e diz a verdade sobre o resultado.
 *
 * Um rollback que falha **não** vira sucesso: a operação fica com a etapa e o
 * diagnóstico, e o checkpoint permanece para uma tentativa manual.
 */
async function rollback(
	request: Pick<ApplyRequest, 'root' | 'checkpoints' | 'operations'>,
	operation: DevOperation,
	reason: string,
): Promise<ApplyOutcome> {
	try {
		await request.checkpoints.restoreAll(request.root, 'dev-apply');
		const rolled = advance(operation, 'rolled-back', { result: `desfeito: ${reason}` });
		await request.operations.write(rolled);
		return { kind: 'rolled-back', operation: rolled, reason };
	} catch (error) {
		const failure = error instanceof Error ? error.message : String(error);
		const stuck = advance(operation, 'verification-failed', {
			result: `desfazer falhou (${failure}); o checkpoint foi preservado`,
		});
		await request.operations.write(stuck);
		return { kind: 'rollback-failed', operation: stuck, reason: `${reason}; desfazer falhou: ${failure}` };
	}
}
