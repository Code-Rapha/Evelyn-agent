/**
 * O que fazer quando a janela de configurações é pedida.
 *
 * ## Por que isto existe
 *
 * A janela de configurações é criada escondida e mostrada quando a página
 * está pronta, para que ninguém veja um quadro vazio. Isso cria três
 * estados em que um clique **precisa** de uma resposta diferente, e a
 * resposta errada é sempre a mesma para o usuário: *nada aconteceu*.
 *
 * - **não existe** — a janela tem de ser criada;
 * - **minimizada** — `focus()` não faz nada com uma janela minimizada, e o
 *   clique parece ignorado;
 * - **escondida** — o mesmo, para uma janela que nunca chegou a ser
 *   mostrada;
 * - **visível, mas atrás** — ela precisa subir e vir para o foco.
 *
 * A decisão é uma função pura de propósito: a janela do Electron não pode
 * ser testada sem o Electron, mas *o que tem de ser feito com ela* pode.
 */

/** O que o processo principal sabe da janela de configurações. */
export interface SettingsWindowState {
	/** Há uma janela para reutilizar. */
	readonly exists: boolean;
	/** Ela foi destruída e não pode ser reutilizada. */
	readonly destroyed: boolean;
	/** Está minimizada: fora da vista do usuário. */
	readonly minimized: boolean;
	/** Está na tela. */
	readonly visible: boolean;
}

/**
 * O que fazer com a janela.
 *
 * `create` é o único caminho que cria alguma coisa; os outros três mexem
 * numa janela que já existe, e todos terminam em focá-la.
 */
export type SettingsWindowAction = 'create' | 'restore' | 'show' | 'raise';

/**
 * Decide o que fazer com a janela de configurações.
 *
 * A ordem importa: uma janela minimizada também não está visível, e o que
 * ela precisa é ser **restaurada**, não apenas mostrada.
 */
export function settingsWindowAction(state: SettingsWindowState): SettingsWindowAction {
	if (!state.exists || state.destroyed) {
		return 'create';
	}
	if (state.minimized) {
		return 'restore';
	}
	if (!state.visible) {
		return 'show';
	}
	return 'raise';
}
