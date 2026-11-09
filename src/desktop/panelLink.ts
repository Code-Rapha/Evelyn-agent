/**
 * O endereço do painel web, para o botão "Abrir no navegador" (R4R).
 *
 * ## Por que num módulo próprio
 *
 * A regra que importa é **qual endereço é aceitável abrir**, e ela precisa de
 * teste sem Electron. O app nunca abre um endereço que não seja o painel do
 * serviço desta instalação: o token vem do registro do serviço, e só o
 * `127.0.0.1` da porta registrada é usado.
 *
 * ## O token na URL
 *
 * O painel recebe a sessão pela URL no primeiro acesso (`?t=…`) e a retira da
 * barra ao carregar. É o mesmo caminho que o serviço imprime no terminal — não
 * é um segredo novo, e não é registrado nem repassado a lugar nenhum.
 */

/** O que o registro do serviço precisa dizer para abrir o painel. */
export interface PanelRecord {
	readonly port: number;
	readonly token: string;
}

export type PanelOpenPlan =
	| { readonly ok: true; readonly url: string }
	| { readonly ok: false; readonly code: 'inactive' | 'invalid'; readonly message: string };

/**
 * O endereço de entrada do painel, ou por que não há um.
 *
 * Recusa porta fora de faixa e token vazio: um registro danificado não deve
 * levar a abrir uma URL arbitrária no navegador do usuário.
 */
export function panelUrlFor(record: PanelRecord | undefined): PanelOpenPlan {
	if (record === undefined) {
		return {
			ok: false,
			code: 'inactive',
			message: 'o serviço local não está ativo; o painel no navegador precisa dele',
		};
	}
	const { port, token } = record;
	if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
		return { ok: false, code: 'invalid', message: 'o registro do serviço tem uma porta inválida' };
	}
	if (typeof token !== 'string' || token.length === 0) {
		return { ok: false, code: 'invalid', message: 'o registro do serviço não tem credencial de painel' };
	}
	return { ok: true, url: `http://127.0.0.1:${port}/?t=${encodeURIComponent(token)}` };
}
