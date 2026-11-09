/**
 * Descobrir modelos: o que a interface pode pedir de um provedor.
 *
 * ## Nada de um segundo catálogo
 *
 * A descoberta é a que já existia: `listAvailableModels` consulta cada
 * endpoint habilitado, grava o que ele publicou no registro de descoberta
 * (`provider-models.json`) e devolve o resultado. O catálogo fundido
 * (`listMergedCatalog`) é o único lugar onde declarado e publicado se
 * encontram. Aqui só se **escolhe qual provedor** é perguntado, e se a falha
 * dele aparece para o usuário.
 *
 * ## A falha não apaga o que havia
 *
 * `listAvailableModels` já é defensivo: uma falha de listagem é registrada
 * como falha, e o que estava gravado continua servido — marcado como
 * desatualizado — em vez de desaparecer. Esta camada mantém isso e ainda diz,
 * por provedor, **o que aconteceu**, para a página poder mostrar o erro real
 * ao lado dos modelos que continuam válidos.
 */
import type { AssembledCore } from '../app/assemble';
import { toDisplayMessage } from '../desktop/contract';
import type { ApiReply } from './api';

/**
 * O que aconteceu com a descoberta de um provedor.
 *
 * `ok` diz que o endpoint respondeu **agora**; `stale` diz que a resposta é
 * uma cópia anterior, porque a tentativa de agora falhou; `failed` diz que
 * não há resposta agora nem cópia para servir.
 */
export interface DiscoveryOutcome {
	readonly providerId: string;
	readonly status: 'ok' | 'stale' | 'failed';
	/** Quantos modelos o provedor publica. */
	readonly modelCount: number;
	/** O erro real, quando houve um. */
	readonly error?: string;
}

/** O resultado de uma descoberta. */
export interface DiscoveryReply {
	readonly outcomes: readonly DiscoveryOutcome[];
	/** Quantos modelos responderam agora, somando os provedores `ok`/`stale`. */
	readonly discovered: number;
}

/** As descobertas, com a mesma sessão e o mesmo Core das leituras. */
export class DiscoveryWrites {
	constructor(private readonly core: AssembledCore | undefined) {}

	/**
	 * Pergunta ao provedor — ou a todos os habilitados, quando nenhum é dito.
	 *
	 * Um provedor desabilitado é recusado com o motivo, em vez de ser
	 * perguntado: a sessão já o ignora em `listAvailableModels`, e uma lista
	 * vazia sem explicação pareceria "este servidor não tem modelos".
	 */
	async discover(body: unknown): Promise<ApiReply> {
		if (this.core === undefined) {
			return { status: 404, body: { error: 'o Core não está montado neste host' } };
		}
		const core = this.core;
		const providerId = readProviderId(body);
		const providers = core.chat.listProviders();

		if (providerId !== undefined) {
			const provider = providers.find((entry) => entry.id === providerId);
			if (provider === undefined) {
				return { status: 404, body: { error: `não há provedor "${providerId}"` } };
			}
			if (provider.status === 'disabled') {
				return {
					status: 400,
					body: { error: `o provedor "${provider.name}" está desabilitado; habilite-o para descobrir modelos` },
				};
			}
		}

		// A sessão pergunta a todos os habilitados; quando um foi pedido, o
		// resultado dos outros não interessa — mas eles foram perguntados, e
		// isso é o mesmo caminho que mantém o registro atualizado.
		//
		// R4S: o critério de "respondeu agora" vem da **sessão**, não do
		// relógio. Dentro da TTL a descoberta não consulta o servidor e
		// devolve a lista com `stale: false` — resposta boa de cache. Comparar
		// `listedAt` com o relógio marcava esse acerto como falha ("o endpoint
		// não respondeu agora") sobre uma lista recentíssima. O relógio fica
		// como reforço: `listedAt` de depois do corte também é resposta nova.
		const queriedAt = Date.now();
		let failure: string | undefined;
		let answered: ReadonlySet<string> = new Set<string>();
		try {
			answered = (await core.chat.listAvailableModelsWithSources()).answered;
		} catch (error) {
			// `listAvailableModelsWithSources` não rejeita por falha de
			// provedor; chegar aqui é um erro de outro tipo, e ele é contado.
			failure = toDisplayMessage(error, 'a descoberta falhou');
		}

		const after = await core.chat.listDiscoveredModels();
		const wanted = providerId !== undefined ? [providerId] : providers.map((entry) => entry.id);

		const outcomes: DiscoveryOutcome[] = [];
		let discovered = 0;
		for (const id of wanted) {
			const rows = after.filter((model) => model.providerId === id);
			discovered += rows.length;
			// O registro diz quando cada modelo foi visto pela última vez.
			const freshest = rows.reduce<number>((latest, model) => {
				const at = model.listedAt === undefined ? Number.NaN : Date.parse(model.listedAt);
				return Number.isFinite(at) && at > latest ? at : latest;
			}, Number.NEGATIVE_INFINITY);
			const answeredNow = answered.has(id) || (Number.isFinite(freshest) && freshest >= queriedAt);
			const status: DiscoveryOutcome['status'] =
				rows.length === 0 ? 'failed' : answeredNow ? 'ok' : 'stale';
			outcomes.push({
				providerId: id,
				status,
				modelCount: rows.length,
				...(status === 'ok'
					? {}
					: {
							error:
								failure ??
								(rows.length === 0
									? 'o endpoint não respondeu e não há nenhuma lista anterior'
									: 'o endpoint não respondeu agora; a lista anterior foi mantida'),
						}),
			});
		}

		const reply: DiscoveryReply = { outcomes, discovered };
		return { status: 200, body: reply };
	}

	/**
	 * O catálogo, como a página de Models o lê: declarado, descoberto e o
	 * fundido, com a origem de cada lado.
	 */
	async catalog(): Promise<ApiReply> {
		if (this.core === undefined) {
			return { status: 404, body: { error: 'o Core não está montado neste host' } };
		}
		const core = this.core;
		const [merged, discovered, declared] = await Promise.all([
			core.chat.listMergedCatalog(),
			core.chat.listDiscoveredModels(),
			core.chat.listModelCatalog(),
		]);
		return {
			status: 200,
			body: {
				policy: merged.policy,
				models: merged.models,
				discovered,
				declared,
			},
		};
	}
}

/** O provedor pedido, quando o corpo diz qual. */
function readProviderId(body: unknown): string | undefined {
	if (typeof body !== 'object' || body === null) {
		return undefined;
	}
	const value = (body as Record<string, unknown>)['providerId'];
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}
