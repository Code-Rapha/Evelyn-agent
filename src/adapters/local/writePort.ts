/**
 * A porta de gravação dos stores (R4Q).
 *
 * ## Por que existe
 *
 * Os testes precisam provar o que acontece quando o disco recusa uma escrita —
 * e provar isso de forma **determinística**, sem depender de permissão, disco
 * cheio ou uma janela de corrida. Antes da R4Q havia um `armWriteFailure()`
 * público no store que fazia isso por dentro; um método público que altera o
 * comportamento de produção é um risco (qualquer código no processo o alcança)
 * e escondia a injeção no próprio objeto.
 *
 * A porta separa as duas coisas: o store recebe **como** gravar. Em produção,
 * `writeFileAtomic`. Em teste, um decorador que falha quando o teste escolher.
 *
 * ## O contrato
 *
 * Uma função `(path, contents) => Promise<void>`. Ela recebe o caminho
 * **absoluto** e já resolvido, e grava tudo ou nada: quem a implementa deve
 * manter a garantia do `writeFileAtomic` (arquivo anterior intacto quando
 * falha). Ela não valida nada e não serializa nada — a serialização é da fila
 * do store, que é quem chama.
 */

export type WritePort = (path: string, contents: string) => Promise<void>;

/** A falha que um teste pediu, com o caminho para a asserção. */
export interface WritePortFault {
	/** Caminho relativo que falha (comparado por sufixo). */
	readonly pathSuffix?: string;
	/** Quantas gravações falham antes de a porta voltar ao normal. */
	readonly times?: number;
	/** Função que decide, caminho a caminho, se esta gravação falha. */
	readonly when?: (path: string) => boolean;
}

/**
 * Uma porta que delega ao destino real, falhando onde o teste mandar.
 *
 * Testes, não produção. Mordeu uma vez por armadilha: a falha é **consumida**
 * pela gravação que ela atinge, e não sobrevive a ela — o mesmo problema que
 * o `armWriteFailure` antigo tinha (uma armadilha pendente virava uma bomba
 * para a escrita seguinte de qualquer usuário do store).
 */
export function failingWritePort(
	real: WritePort,
	faults: readonly WritePortFault[],
): { readonly port: WritePort; readonly remaining: () => number } {
	const pending = faults.map((fault) => ({ ...fault, left: fault.times ?? 1 }));
	const port: WritePort = async (path, contents) => {
		const hit = pending.find(
			(entry) =>
				entry.left > 0 &&
				(entry.when?.(path) ?? (entry.pathSuffix === undefined ? true : path.endsWith(entry.pathSuffix))),
		);
		if (hit !== undefined) {
			hit.left -= 1;
			throw new Error(`falha de gravação injetada em ${path}`);
		}
		await real(path, contents);
	};
	return { port, remaining: () => pending.reduce((total, entry) => total + entry.left, 0) };
}
