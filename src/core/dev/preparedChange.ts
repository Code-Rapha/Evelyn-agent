/**
 * O diário de uma alteração enquanto o agente a prepara (DEV-5).
 *
 * ## O que faltava
 *
 * A DEV-3 sabe **aplicar** uma operação (`applyChange`), mas a operação era
 * montada só nos testes: ninguém, em produção, registrava "o agente escreveu
 * estes arquivos, com este conteúdo". Sem esse registro, o gatilho da DEV-5
 * não teria o que aplicar — e reconstruir as escritas a partir do disco seria
 * adivinhar o que o agente quis dizer.
 *
 * ## O que este módulo guarda, e o que não guarda
 *
 * Guarda a **lista de arquivos e o conteúdo** que o agente escreveu pelo
 * `dev_write` durante a sessão, numa operação identificada. Não guarda
 * mensagem do usuário nem credencial. O conteúdo é o mesmo que já está no
 * repositório depois da escrita — o diário existe para poder reaplicar e
 * reverter com o `applyChange`, não para duplicar o repositório.
 *
 * A gravação é feita **em memória do processo** e só é publicada no store do
 * host quando o gatilho pede a aplicação. Um processo que morra no meio perde
 * o diário — mas não perde as escritas nem os checkpoints: a operação no store
 * continua na etapa `written`, e a recuperação da DEV-4 a apresenta.
 */

import { randomUUID } from 'node:crypto';

/**
 * O que o agente preparou, ainda não aplicado.
 *
 * Tudo é `readonly`: o diário devolve **lances**, não um objeto mutável que um
 * chamador poderia mexer. Quem precisa da versão com escritas chama
 * `journal.get(id)` depois de escrever.
 */
export interface PreparedChange {
	/** A operação no `DevOperationStore`. */
	readonly operationId: string;
	/** A raiz canônica do repositório em que as escritas aconteceram. */
	readonly root: string;
	/** Os arquivos, na ordem em que foram escritos. */
	readonly files: readonly string[];
	/** As escritas, para o `applyChange` reaplicar de forma idempotente. */
	readonly writes: readonly { readonly path: string; readonly content: string }[];
	/** A conversa em que a mudança foi pedida, quando se sabe. */
	readonly conversationId?: string;
	/** O valor opaco gravado no registro da operação (`DevOperation.nonce`). */
	readonly nonce: string;
	/**
	 * O token da sessão DEV que preparou a mudança (DEV-5).
	 *
	 * Não é entregue ao modelo nem escrito em argumento: só o gatilho compara
	 * com a sessão viva, para um id de uma sessão anterior não ser aplicado
	 * numa sessão nova — `enter()` troca o token a cada entrada.
	 */
	readonly sessionToken: string;
	readonly createdAt: string;
}

/**
 * O diário, em memória do processo principal.
 *
 * Uma instância só, porque a ferramenta e o gatilho vivem no mesmo processo.
 * A chave é o id da operação — gerado por quem a cria, não pelo agente.
 */
export class PreparedChangeJournal {
	private readonly entries = new Map<string, PreparedChange>();

	/**
	 * Começa uma operação e devolve o **lance inicial**.
	 *
	 * O lance do `start` não é atualizado depois: `note` devolve um lance
	 * novo. Quem vai aplicar lê `journal.get(id)` — guardar o objeto do
	 * `start` e usá-lo depois foi, num teste, uma operação "done" com zero
	 * escritas. Os campos são `readonly` para que o erro seja de tipo.
	 */
	start(input: {
		readonly root: string;
		readonly files: readonly string[];
		readonly conversationId?: string;
		/** O token da sessão DEV viva. Sem ele não há autorização para aplicar. */
		readonly sessionToken: string;
		readonly now?: () => Date;
	}): PreparedChange {
		const createdAt = (input.now ?? (() => new Date()))().toISOString();
		const operationId = `devop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		const change: PreparedChange = {
			operationId,
			root: input.root,
			files: [...input.files],
			writes: [],
			...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
			nonce: randomUUID(),
			sessionToken: input.sessionToken,
			createdAt,
		};
		this.entries.set(operationId, change);
		return change;
	}

	/**
	 * Registra (ou substitui) a escrita de um arquivo.
	 *
	 * Reaplica no mapa de escritas por caminho: o agente pode reescrever o
	 * mesmo arquivo duas vezes na preparação, e só a versão final importa.
	 */
	note(input: {
		readonly operationId: string;
		readonly path: string;
		readonly content: string;
	}): PreparedChange | undefined {
		const change = this.entries.get(input.operationId);
		if (change === undefined) {
			return undefined;
		}
		const writes = change.writes.filter((write) => write.path !== input.path);
		writes.push({ path: input.path, content: input.content });
		const next: PreparedChange = {
			...change,
			// A `files` vem das **escritas**, não de um acumulador paralelo:
			// duas listas podiam divergir, e o fluxo aplicava uma operação com
			// arquivos e sem escritas — "done" sem ter escrito nada.
			files: [...writes.map((write) => write.path)],
			writes,
		};
		this.entries.set(input.operationId, next);
		return next;
	}

	get(operationId: string): PreparedChange | undefined {
		return this.entries.get(operationId);
	}

	/**
	 * A preparação viva cujo registro de operação tem este `nonce` (DEV-6).
	 *
	 * O store em disco não carrega o id do diário (ele é da memória). Para o
	 * painel ligar a operação em disco à preparação viva, o elo é o nonce —
	 * aleatório, gravado nos dois lugares e nunca vindo do renderer.
	 */
	byNonce(nonce: string): PreparedChange | undefined {
		for (const change of this.entries.values()) {
			if (change.nonce === nonce) {
				return change;
			}
		}
		return undefined;
	}

	/** A operação mais recente na raiz — o que o gatilho pega por omissão. */
	latestFor(root: string): PreparedChange | undefined {		let latest: PreparedChange | undefined;
		for (const change of this.entries.values()) {
			if (change.root !== root) {
				continue;
			}
			if (latest === undefined || change.createdAt >= latest.createdAt) {
				latest = change;
			}
		}
		return latest;
	}

	/**
	 * Marca a operação como consumida.
	 *
	 * Chamado **depois** de o `applyChange` aceitar a aplicação, nunca antes:
	 * uma falha antes disso precisa deixar o diário para a nova tentativa.
	 */
	consume(operationId: string): void {
		this.entries.delete(operationId);
	}

	/** Quantas operações existem (para o teste provar que nada vazou). */
	size(): number {
		return this.entries.size;
	}

	/**
	 * Esquece tudo (DEV-5: ao encerrar a sessão do host).
	 *
	 * Não apaga checkpoint nem operação — esses ficam em disco para a
	 * recuperação. Esquece só a preparação em memória, que vale enquanto a
	 * sessão que a autorizou existir.
	 */
	clear(): void {
		this.entries.clear();
	}
}
