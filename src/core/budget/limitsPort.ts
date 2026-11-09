/**
 * A porta dos limites de consumo.
 *
 * Separada da porta do ledger por uma razão de tempo de vida: o ledger é uma
 * história que só cresce, e um limite é uma configuração pequena que o usuário
 * edita. Guardá-los no mesmo arquivo faria cada edição de orçamento reescrever
 * a história inteira.
 *
 * Mesma política de leitura do catálogo: um arquivo ausente é "nenhum limite",
 * não um erro; um arquivo danificado perde aquele limite, não o app.
 */
import type { SaveSpendingLimitInput, SpendingLimit } from './policy';

export interface SpendingLimitsPort {
	/** Todos os limites, do mais específico para o global. */
	listSpendingLimits(): Promise<readonly SpendingLimit[]>;
	/** Um limite pelo id, ou `undefined`. */
	getSpendingLimit(limitId: string): Promise<SpendingLimit | undefined>;
	/**
	 * Cria ou substitui o limite do escopo.
	 *
	 * O escopo (global, provedor, modelo) é a identidade: salvar o mesmo escopo
	 * de novo atualiza o teto em vez de criar um segundo. `limitId` só é
	 * aceito quando é exatamente o do escopo, para que o arquivo não acumule
	 * dois tetos que dizem a mesma coisa.
	 */
	saveSpendingLimit(input: SaveSpendingLimitInput): Promise<SpendingLimit>;
	/** Remove. Devolve se havia algo. */
	removeSpendingLimit(limitId: string): Promise<boolean>;
}
