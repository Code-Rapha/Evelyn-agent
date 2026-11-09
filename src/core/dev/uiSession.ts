/**
 * O estado da sessão de interface, guardado pelo host (DEV-4).
 *
 * ## Por que no host e não no `localStorage`
 *
 * O renderer é recarregado — é exatamente o que o modo DEV faz para aplicar
 * uma mudança de interface. Tudo o que ele guardar em `localStorage` sobrevive
 * a uma recarga do `BrowserWindow`, mas **não** a um reinício do aplicativo se
 * a partição for limpa, e some se o armazenamento for isolado por sessão. Mais
 * importante: o *main* precisa ler esse estado **antes** de a janela abrir, para
 * dizer ao renderer qual conversa abrir. Um dado só no renderer chega tarde
 * demais.
 *
 * Aqui fica só o que é pequeno, não secreto e útil para reabrir com sentido:
 *
 * - `lastConversationId`: a conversa em que o usuário estava;
 * - `wasGenerating`: se havia um turno em andamento quando a interface saiu;
 * - `updatedAt`: para diagnosticar.
 *
 * **Nunca** entra conteúdo de mensagem, token, caminho ou chave.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** O nome do arquivo, dentro do diretório de DEV do host. */
export const SESSION_FILE = 'ui-session.json';

/** O estado guardado. Todos os campos são opcionais: ausência = nada sabido. */
export interface UiSession {
	readonly lastConversationId?: string;
	/** Um turno estava em andamento quando a interface saiu? */
	readonly wasGenerating?: boolean;
	/** Quando foi a última gravação (ISO). */
	readonly updatedAt?: string;
}

/**
 * O store.
 *
 * Gravação atômica (temporário + `rename`), como os outros stores do projeto:
 * um app que morre no meio de uma gravação não deixa um JSON pela metade.
 * Leitura tolerante: arquivo ilegível é "nada sabido", nunca um erro que
 * impede a janela de abrir.
 */
export class UiSessionStore {
	constructor(private readonly baseDir: string) {}

	private get path(): string {
		return join(this.baseDir, SESSION_FILE);
	}

	async read(): Promise<UiSession> {
		const raw = await readFile(this.path, 'utf8').catch(() => undefined);
		if (raw === undefined) {
			return {};
		}
		try {
			const parsed = JSON.parse(raw) as Partial<UiSession>;
			return {
				...(typeof parsed.lastConversationId === 'string' && parsed.lastConversationId.length > 0
					? { lastConversationId: parsed.lastConversationId }
					: {}),
				...(typeof parsed.wasGenerating === 'boolean' ? { wasGenerating: parsed.wasGenerating } : {}),
				...(typeof parsed.updatedAt === 'string' ? { updatedAt: parsed.updatedAt } : {}),
			};
		} catch {
			return {};
		}
	}

	/** Grava, mergindo com o que já havia. */
	async patch(patch: Partial<UiSession>, now: () => Date = () => new Date()): Promise<UiSession> {
		const current = await this.read();
		const next: UiSession = {
			...current,
			...patch,
			updatedAt: now().toISOString(),
		};
		await mkdir(this.baseDir, { recursive: true });
		const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
		await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
		await rename(temporary, this.path);
		return next;
	}

	/**
	 * Marca `wasGenerating` e devolve o que **era** antes.
	 *
	 * Usado antes de recarregar/reiniciar: grava o estado atual da geração, e
	 * quem volta lê o valor. Chamar duas vezes para a mesma operação não
	 * muda nada além do carimbo.
	 */
	async markGenerating(generating: boolean): Promise<UiSession> {
		return await this.patch({ wasGenerating: generating });
	}
}

/**
 * O que o renderer recebe ao abrir a janela (DEV-4).
 *
 * Só campos de conversa e o aviso — nenhum caminho, nenhum token.
 */
export interface UiBootState {
	/** A conversa a abrir, quando há uma decisão. */
	readonly conversationId?: string;
	/** O aviso a mostrar acima do histórico. */
	readonly message?: string;
	/** Mostrar o botão de retomar? */
	readonly canRetry?: boolean;
}

/**
 * Converte a decisão de retomada (`decideResume`) no que a janela recebe.
 *
 * É uma projeção: o `DevOperation` completo **não** vai para o renderer — ele
 * carrega a lista de arquivos e os resultados das verificações, que são
 * diagnóstico do host, não da página.
 */
export function toBootState(notice: {
	readonly conversationId?: string;
	readonly message?: string;
	readonly action?: 'retry-turn';
}): UiBootState {
	return {
		...(notice.conversationId !== undefined ? { conversationId: notice.conversationId } : {}),
		...(notice.message !== undefined ? { message: notice.message } : {}),
		...(notice.action === 'retry-turn' ? { canRetry: true } : {}),
	};
}
