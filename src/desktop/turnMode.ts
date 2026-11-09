/**
 * O modo de execução do chat (DEV-8.9): quem escolhe quem responde.
 *
 * ## Por que um arquivo, e não a página
 *
 * A regra tem três partes que precisam concordar: o que o seletor mostra, o
 * que a página guarda entre aberturas e o que o turno envia. Duas delas são
 * de interface e uma é de contrato — e uma divergência aqui é uma pergunta
 * enviada ao provedor errado. A regra mora aqui para ser testada sem janela.
 *
 * ## O que ele **não** é
 *
 * Não é a configuração do roteador. `router-config.json` é global e diz para
 * onde a requisição vai; este modo é uma escolha de execução do chat, guardada
 * do lado da janela (`localStorage`), porque trocar de modo não deve reescrever
 * a decisão global que o painel e o navegador mostram.
 *
 * ## Automático é o padrão, mas só onde ele é obedecível
 *
 * `auto` só é acionável com o roteador **ligado** e em modo `native`. Com a
 * configuração apontando para um roteador externo ou para um destino direto, o
 * usuário já escolheu um destino explícito: o turno segue a configuração, e a
 * página diz isso em vez de fingir uma seleção local.
 */
import type { RouterConfigView, TurnRouting } from './contract';

/** O modo escolhido no chat. */
export type TurnMode = TurnRouting;

export const TURN_MODES: readonly TurnMode[] = ['auto', 'direct', 'external'];

/** A chave no armazenamento da janela. Versionada: o formato pode mudar. */
export const TURN_MODE_STORAGE_KEY = 'seshyina.turnMode.v1';

/** O modo pedido é um dos três? */
export function isTurnMode(value: unknown): value is TurnMode {
	return value === 'auto' || value === 'direct' || value === 'external';
}

/**
 * O modo guardado, ou `auto` — o padrão.
 *
 * Um valor desconhecido (versão antiga, outra versão do app) vira o padrão em
 * vez de virar uma quarta opção que ninguém sabe executar.
 */
export function readStoredTurnMode(storage: Pick<Storage, 'getItem'> | undefined): TurnMode {
	if (storage === undefined) {
		return 'auto';
	}
	try {
		const stored = storage.getItem(TURN_MODE_STORAGE_KEY);
		return isTurnMode(stored) ? stored : 'auto';
	} catch {
		// Armazenamento indisponível (modo restrito) não impede o chat.
		return 'auto';
	}
}

/** Guarda o modo; falhar aqui não é motivo para impedir o envio. */
export function writeStoredTurnMode(
	storage: Pick<Storage, 'setItem'> | undefined,
	mode: TurnMode,
): void {
	if (storage === undefined) {
		return;
	}
	try {
		storage.setItem(TURN_MODE_STORAGE_KEY, mode);
	} catch {
		// Ignorado de propósito: a escolha vale para esta execução de qualquer forma.
	}
}

/** O modo efetivo, depois de considerar o que está configurado. */
export function effectiveTurnMode(mode: TurnMode, config: RouterConfigView | undefined): TurnMode {
	if (config === undefined) {
		return mode;
	}
	// DEV-8.11: uma fonte indisponível não decide nada. Não se "corrige" o
	// automático com base numa configuração que ninguém conseguiu ler.
	if (config.source === 'unavailable') {
		return mode;
	}
	// Desligado ou apontando para outro destino: "automático" não é obedecível.
	if (mode === 'auto' && (!config.enabled || config.mode !== 'native')) {
		return config.mode === 'external' ? 'external' : 'direct';
	}
	// Escolher "roteador externo" sem um destino configurado mantém a escolha:
	// o turno recusa com uma mensagem que explica o que falta, em vez de
	// enviar para outro lugar sem avisar.
	return mode;
}

/**
 * O que a escolha envia no turno.
 *
 * `auto` manda o par vazio de propósito: quem escolhe é o motor, e mandar o
 * modelo selecionado seria vendê-lo como escolha do usuário. Nos modos com
 * destino, o par é o do usuário (ou o do provedor do modo, que o Core resolve).
 */
export function turnRoutingPayload(
	mode: TurnMode,
	choice: { readonly providerId: string; readonly model: string } | undefined,
): { readonly routing: TurnMode; readonly providerId?: string; readonly model?: string } {
	if (mode === 'auto') {
		return { routing: 'auto' };
	}
	if (mode === 'external') {
		// DEV-8.13/8.14: o destino vem da configuração do roteador; o modelo
		// pedido é o do destino (o que estiver escolhido). O roteador pode
		// escolher outro, e o relatório mostra quem respondeu.
		return { routing: 'external', ...(choice !== undefined ? { model: choice.model } : {}) };
	}
	return {
		routing: 'direct',
		...(choice !== undefined ? { providerId: choice.providerId, model: choice.model } : {}),
	};
}

/**
 * O seletor de modelo deve ficar ativo?
 *
 * No automático, a lista fica visível (é o catálogo que o motor pode escolher)
 * mas sem efeito sobre o turno — por isso ela é desabilitada e o texto diz por
 * quê. Esconder seria pior: esconderia também o catálogo disponível.
 */
export function modelSelectionEnabled(mode: TurnMode, config: RouterConfigView | undefined): boolean {
	return effectiveTurnMode(mode, config) !== 'auto';
}

/**
 * A tela deve oferecer a escolha manual de modelo?
 *
 * O modo **escolhido** e não o efetivo: numa configuração que tira o automático
 * do caminho (roteador desligado, destino externo), a escolha manual não tem a
 * quem ser entregue — quem decide é a configuração, e o formulário só
 * ofereceria um seletor que não muda nada. A nota do modo já explica isso.
 */
export function manualModelChoiceVisible(mode: TurnMode): boolean {
	return mode === 'direct';
}

/** Um rótulo curto para o estado, usado na cabeça do painel do modelo. */
export function describeTurnMode(mode: TurnMode, config: RouterConfigView | undefined): string {
	const effective = effectiveTurnMode(mode, config);
	switch (effective) {
		case 'auto':
			return 'Agente: a Evelyn escolhe provedor e modelo';
		case 'direct':
			return mode === 'auto'
				? 'Você escolhe não vale aqui: o roteador está fora do modo nativo, então a configuração decide'
				: 'Você escolhe: provedor e modelo são os seus';
		case 'external':
			return 'Roteador externo: a requisição vai ao destino configurado';
	}
}

/**
 * O modo automático está disponível?
 *
 * Só com o roteador ligado e em `native`. A página usa isso para explicar por
 * que o cartão "Automático" aparece indisponível, em vez de deixar a pessoa
 * clicar e ver o turno ir por outro caminho.
 */
export function autoModeAvailable(config: RouterConfigView | undefined): boolean {
	return config !== undefined && config.enabled && config.mode === 'native';
}
