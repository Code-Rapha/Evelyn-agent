/**
 * O interruptor do aprendizado automático pela interface web.
 *
 * ## Por que esta rota existe
 *
 * O aprendizado automático roda dentro do **Core**, e no modo conectado o Core
 * é o do serviço — a janela do desktop não monta um. Sem uma rota, o painel
 * não tem como desligar o que o serviço faz em nome do usuário: a única saída
 * seria editar o arquivo de configuração à mão, e um interruptor que só existe
 * no modo local não é um interruptor no app como ele abre.
 *
 * ## O que ela é
 *
 * A tradução de uma chamada para o `AutoSkillService` do Core — nada além
 * disso. A leitura devolve o estado em vigor e a auditoria do que já foi
 * criado; a escrita liga ou desliga. Nenhuma skill é criada, alterada ou
 * apagada por aqui.
 *
 * ## A forma da resposta
 *
 * É a mesma da janela (`AutoSkillStatusView`), e não a do Core: o serviço e o
 * desktop falam o mesmo contrato, e o achatamento mora num lugar só
 * (`desktop/autoSkillView.ts`). Duas formas para o mesmo dado seriam duas
 * telas para o mesmo botão.
 */
import { toDisplayMessage } from '../desktop/contract';
import { toAutoSkillStatusView } from '../desktop/autoSkillView';
import type { AssembledCore } from '../app/assemble';
import type { ApiReply } from './api';

/** A leitura e a escrita do interruptor, com o estado devolvido. */
export class SkillAuto {
	constructor(private readonly core: AssembledCore | undefined) {}

	/** O estado em vigor e o que este caminho já criou. */
	async read(): Promise<ApiReply> {
		if (this.core === undefined) {
			return { status: 404, body: { error: 'o Core não está montado neste host' } };
		}
		return { status: 200, body: toAutoSkillStatusView(await this.core.autoSkills.status()) };
	}

	/**
	 * Liga ou desliga.
	 *
	 * O corpo é `{ enabled: boolean }` e nada mais. Um corpo sem o booleano é
	 * recusado em vez de ignorado: aqui não há outro campo a salvar, e aceitar
	 * "nada" faria o botão parecer que funcionou sem ter mudado coisa alguma.
	 */
	async save(body: unknown): Promise<ApiReply> {
		if (this.core === undefined) {
			return { status: 404, body: { error: 'o Core não está montado neste host' } };
		}
		const enabled = readEnabled(body);
		if (enabled === undefined) {
			return { status: 400, body: { error: 'esperado { enabled: boolean }' } };
		}
		try {
			return { status: 200, body: toAutoSkillStatusView(await this.core.autoSkills.setEnabled(enabled)) };
		} catch (error) {
			// A recusa é dita; o estado anterior continua valendo, porque a
			// gravação do arquivo é atômica e falhou antes de substituí-lo.
			return {
				status: 400,
				body: { error: toDisplayMessage(error, 'não foi possível salvar o interruptor') },
			};
		}
	}
}

/** O booleano do corpo, ou `undefined` quando ele não está lá. */
function readEnabled(body: unknown): boolean | undefined {
	if (typeof body !== 'object' || body === null || Array.isArray(body)) {
		return undefined;
	}
	const value = (body as Record<string, unknown>)['enabled'];
	return typeof value === 'boolean' ? value : undefined;
}
