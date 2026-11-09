/**
 * A continuidade da conversa depois de recarregar ou reiniciar (DEV-3).
 *
 * ## O que se perde hoje
 *
 * A conversa aberta vive só na memória do renderer. Ao abrir, o app chama
 * `openFirstConversation()` — a **primeira** da lista, não a que o usuário
 * estava lendo. Uma recarga para aplicar um estilo, ou um reinício para
 * aplicar uma mudança no Core, devolveria a pessoa a outra conversa, e a
 * mudança que ela pediu pareceria perdida.
 *
 * ## O que esta parte resolve
 *
 * - qual conversa reabrir: a da operação pendente, ou a última que o usuário
 *   tinha aberta (guardada pelo renderer no `localStorage`, que sobrevive a
 *   recarga e a reinício);
 * - se havia geração em andamento quando o processo anterior parou;
 * - **o que dizer** nesse caso — e o que **não** dizer: uma chamada de modelo
 *   interrompida no meio não é retomada do ponto anterior, e ferramentas já
 *   executadas não são repetidas. O aviso diz isso, e oferece retomar como
 *   uma ação nova e explícita do usuário.
 *
 * Nada aqui executa nada: são decisões puras, testáveis sem Electron.
 */

import type { DevOperation } from './devOperation';
import { isUnfinished } from './devOperation';

/** O que o usuário deve ver ao voltar. */
export interface ResumeNotice {
	/** A conversa a abrir. `undefined` = a primeira da lista, como antes. */
	readonly conversationId?: string;
	/** O aviso a mostrar acima do histórico, quando houver. */
	readonly message?: string;
	/** Como retomar, quando há algo a retomar. */
	readonly action?: 'retry-turn';
	/** A operação DEV pendente, para relatar ao proprietário. */
	readonly pendingOperation?: DevOperation;
}

/** O estado guardado pelo renderer entre aberturas. */
export interface RestoredUiState {
	readonly lastConversationId?: string;
	/**
	 * Havia um turno em andamento quando a janela saiu?
	 *
	 * Gravado **antes** da recarga/reinício, porque depois já não há como
	 * saber: o processo que sabia não existe mais.
	 */
	readonly wasGenerating?: boolean;
}

/**
 * Decide o que reabrir e o que contar.
 *
 * A ordem de preferência da conversa é: a da **operação pendente** (é nela que
 * a mudança foi pedida), a da operação **concluída há pouco** (o proprietário
 * volta e espera ver o resultado ali), a última aberta, e por fim nenhuma (a
 * primeira da lista, comportamento antigo).
 */
export function decideResume(input: {
	readonly operation?: DevOperation;
	readonly restored?: RestoredUiState;
}): ResumeNotice {
	const operation = input.operation;
	const pending = isUnfinished(operation) ? operation : undefined;
	const restored = input.restored;
	// Uma operação **concluída** não sequestra a abertura: quem manda é a
	// última conversa em que o usuário estava. Só a pendente — a que ficou a
	// meio caminho por uma recarga ou reinício — tem prioridade.
	const conversationId = pending?.conversationId ?? restored?.lastConversationId;
	const generating = restored?.wasGenerating === true;

	const parts: string[] = [];
	if (pending !== undefined) {
		parts.push(describePending(pending));
	}
	if (generating) {
		// A frase importa: "interrompida" e "não repetimos nada" são as duas
		// informações que o usuário precisa para decidir com segurança.
		parts.push(
			'a resposta que estava sendo gerada foi interrompida pela recarga e **não** foi retomada ' +
				'automaticamente: nenhuma chamada ao modelo nem ferramenta foi repetida. ' +
				'Se quiser, peça de novo — é uma nova execução, e o que já foi feito continua feito.',
		);
	}

	const notice: ResumeNotice = {
		...(conversationId !== undefined ? { conversationId } : {}),
		...(parts.length > 0 ? { message: parts.join('\n\n') } : {}),
		...(generating ? { action: 'retry-turn' as const } : {}),
		...(pending !== undefined ? { pendingOperation: pending } : {}),
	};
	return notice;
}

/** O texto de classe de uma operação pendente — sem conteúdo de arquivo. */
function describePending(operation: DevOperation): string {
	const where = operation.files.length > 0 ? ` (${operation.files.join(', ')})` : '';
	switch (operation.stage) {
		case 'planned':
		case 'checkpointed':
			return (
				`a alteração pedida${where} estava em preparação quando o aplicativo parou e não chegou a ser aplicada. ` +
				'o checkpoint do estado anterior existe; posso retomar ou desfazer.'
			);
		case 'written':
			return (
				`a alteração${where} foi escrita mas não verificada antes de o aplicativo parar. ` +
				'nada foi dado como concluído; posso rodar as verificações agora ou desfazer pelo checkpoint.'
			);
		case 'verified':
			return (
				`a alteração${where} foi escrita e verificada, e faltou aplicá-la. ` +
				'posso aplicar agora, ou desfazer pelo checkpoint.'
			);
		case 'applying':
			// DEV-5: a recarga/reinício **pode** ter acontecido antes de o
			// processo parar. Não se reaplica: uma segunda reinicialização para
			// a mesma operação é justamente o que não pode ocorrer. O caminho
			// é conferir o resultado e, se não estiver bom, desfazer.
			return (
				`a aplicação de${where} começou e o aplicativo parou no meio. ` +
				'não sei dizer se a nova versão está boa, e **não** vou reaplicar: ' +
				'a recarga ou reinício pode já ter acontecido. O checkpoint está preservado — ' +
				'posso conferir o estado e desfazer se não estiver certo.'
			);
		case 'verification-failed':
			return (
				`as verificações de${where} falharam e o aplicativo parou antes de desfazer. ` +
				'o checkpoint está preservado; desfazer agora devolve o código anterior.'
			);
		default:
			return `há uma alteração pendente${where}.`;
	}
}

/**
 * As verificações exigidas pela estratégia.
 *
 * "Verificado" não é uma afirmação do modelo: é a lista de comandos que
 * rodaram com sucesso. Sem essa lista completa, a operação não pode passar de
 * `written` para `verified`.
 */
export const REQUIRED_CHECKS: Readonly<Record<DevOperation['strategy'], readonly string[]>> = {
	hot: [],
	'reload-ui': ['npm run check-types'],
	'restart-app': ['npm run check-types', 'npm run test:core'],
	'restart-controlled': [
		'npm run check-types',
		'npm run test:core',
		'npm run lint',
		'npm run web:build',
		'npm run desktop:build',
	],
};

/** As verificações que ainda faltam para esta operação. */
export function missingChecks(operation: DevOperation): readonly string[] {
	const required = REQUIRED_CHECKS[operation.strategy] ?? [];
	return required.filter((check) => !operation.results.some((result) => result.startsWith(`${check}: ok`)));
}
