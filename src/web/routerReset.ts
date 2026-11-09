/**
 * Redefinir a configuração do roteador quando ela está ilegível.
 *
 * ## O caso
 *
 * O arquivo existe e não pode ser lido, e não há cópia de segurança válida.
 * Até agora a página explicava a condição e parava ali: o usuário teria de
 * editar ou apagar o arquivo à mão. Aqui existe a ação explícita para isso.
 *
 * ## O que ela toca — e só isso
 *
 * **Um arquivo**: `router-config.json`. Provedores (`state.json`), chaves
 * (`secrets.json`), modelos descobertos (`provider-models.json`) e todo o
 * resto ficam exatamente como estão. A ação não recebe corpo: não há nada
 * para escolher, o resultado é o padrão.
 *
 * ## A ordem, e por que ela importa
 *
 * 1. **Recusa fora do estado ilegível.** Redefinir é reparo, não um caminho
 *    para pular validação: com a configuração legível, a ação é recusada e o
 *    usuário salva normalmente.
 * 2. **O arquivo ilegível é preservado antes de qualquer escrita** — renomeado
 *    para `router-config.json.unreadable-<timestamp>`, ao lado dos backups.
 *    Se a gravação falhar, ele continua lá para ser inspecionado.
 * 3. **A gravação usa o store de sempre**: temporário + renomeação atômica +
 *    cópia de segurança + verificação de leitura de volta.
 * 4. **A leitura confirma**: o padrão só é dado como escrito depois que o
 *    store lê o padrão de volta. Antes disso, nada de sucesso.
 * 5. **A cópia de segurança anterior não é apagada** antes desse ponto: se o
 *    passo 3 falhar, a cópia continua sendo a única coisa que talvez sirva.
 */
import { rename } from 'node:fs/promises';

import type { AssembledCore } from '../app/assemble';
import { DEFAULT_ROUTER_CONFIG, validateRouterConfig } from '../core/providers/routing/config';
import { routerConfigStatus } from '../desktop/routerConfigStatus';
import { toDisplayMessage } from '../desktop/contract';
import type { ApiReply } from './api';

/** O resultado de uma redefinição. */
export type ResetResult =
	| {
			/** A configuração padrão foi gravada **e** lida de volta. */
			readonly kind: 'reset';
			/** Onde o arquivo ilegível foi guardado, para quem quiser olhar. */
			readonly preservedAs: string;
	  }
	| { readonly kind: 'refused'; readonly status: number; readonly message: string }
	| {
			/** A redefinição falhou; o original e a cópia continuam no disco. */
			readonly kind: 'failed';
			readonly message: string;
			/** O arquivo ilegível foi preservado, mesmo na falha. */
			readonly preservedAs?: string;
	  };

/** O que a redefinição precisa saber do host. */
export interface RouterResetOptions {
	/**
	 * Renomeia o arquivo ilegível para um nome ao lado.
	 *
	 * Injetável porque o teste precisa falhar aqui também — é um dos passos
	 * que pode ir mal, e o comportamento tem de ser o mesmo.
	 */
	readonly preserve?: (from: string, to: string) => Promise<void>;
	/** O relógio, para o nome do arquivo preservado. */
	readonly now?: () => Date;
}

/**
 * Redefine a configuração do roteador para o padrão.
 *
 * Devolve o resultado; **não** informa sucesso sem ter lido o padrão de volta.
 */
export async function resetRouterConfig(
	core: AssembledCore,
	options: RouterResetOptions = {},
): Promise<ResetResult> {
	const path = core.chat.routerConfigFilePath();

	// 1. Só no estado ilegível. Com configuração legível, o caminho é salvar.
	const current = await core.chat.readRouterConfig();
	const status = routerConfigStatus(current);
	if (status !== 'unreadable') {
		return {
			kind: 'refused',
			status: 409,
			message: `a configuração não está ilegível (estado: ${status}); use Salvar para alterá-la`,
		};
	}

	// 2. O arquivo ilegível é guardado antes de qualquer escrita. Se isto
	//    falhar, nada é tocado.
	const stamp = (options.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, '-');
	const preservedAs = `${path}.unreadable-${stamp}`;
	const preserve = options.preserve ?? rename;
	try {
		await preserve(path, preservedAs);
	} catch (error) {
		return {
			kind: 'failed',
			message: `não foi possível guardar o arquivo ilegível antes de redefinir (${toDisplayMessage(error, 'erro de arquivo')})`,
		};
	}

	// 3. A gravação: validação, temporário, renomeação, cópia e verificação.
	//    O padrão passa pela mesma validação de qualquer configuração.
	let standard;
	try {
		standard = validateRouterConfig({ ...DEFAULT_ROUTER_CONFIG, updatedAt: new Date().toISOString() });
	} catch (error) {
		return {
			kind: 'failed',
			message: `o padrão não passou na validação (${toDisplayMessage(error, 'erro de validação')})`,
			preservedAs,
		};
	}

	try {
		await core.chat.saveRouterConfig(standard);
	} catch (error) {
		// O original está guardado; a cópia de segurança não foi apagada.
		return {
			kind: 'failed',
			message: `não foi possível gravar a configuração padrão (${toDisplayMessage(error, 'erro de gravação')}); o arquivo anterior foi preservado`,
			preservedAs,
		};
	}

	// 4. A leitura confirma: o sucesso só existe depois de o padrão ser lido.
	const stored = await core.chat.readRouterConfig();
	if (routerConfigStatus(stored) === 'unreadable' || stored.mode !== standard.mode) {
		return {
			kind: 'failed',
			message:
				'a configuração padrão foi gravada, mas não pôde ser lida de volta; tente novamente',
			preservedAs,
		};
	}

	return { kind: 'reset', preservedAs };
}

/** Traduz o resultado para a resposta HTTP. */
export function resetReply(result: ResetResult): ApiReply {
	if (result.kind === 'reset') {
		return { status: 200, body: { reset: true, preservedAs: result.preservedAs } };
	}
	if (result.kind === 'refused') {
		return { status: result.status, body: { error: result.message } };
	}
	return {
		status: 500,
		body: {
			error: result.message,
			...(result.preservedAs !== undefined ? { preservedAs: result.preservedAs } : {}),
		},
	};
}
