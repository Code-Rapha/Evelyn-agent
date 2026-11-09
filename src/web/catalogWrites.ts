/**
 * O catálogo de modelos **declarado**, pela superfície HTTP do serviço (DEV-8.15).
 *
 * ## Por que esta rota existe
 *
 * O desktop conectado precisa cadastrar modelos manualmente (o usuário digita
 * o modelo que o endpoint atende). Até aqui o serviço só **lia** o catálogo
 * (`GET /api/models/catalog`); gravar exigia o Core local. A escrita não
 * inventa regra nenhuma: chama `ChatSession.saveModelCatalogEntry` e
 * `removeModelCatalogEntry`, as mesmas funções do painel local.
 *
 * ## Autorização
 *
 * É escrita de administração: o servidor exige a credencial de **painel**,
 * como as demais rotas `/api/providers/*`. A leitura do catálogo continua na
 * rota de leitura, com a credencial de leitura.
 */
import type { AssembledCore } from '../app/assemble';
import { toDisplayMessage } from '../desktop/contract';
import type { ApiReply } from './api';

/** O que a rota aceita no corpo ao gravar. */
function readEntry(body: unknown): { providerId: string; modelId: string } | { error: string } {
	if (typeof body !== 'object' || body === null || Array.isArray(body)) {
		return { error: 'esperado { providerId, modelId }' };
	}
	const record = body as Record<string, unknown>;
	const providerId = record['providerId'];
	const modelId = record['modelId'];
	if (typeof providerId !== 'string' || providerId.length === 0) {
		return { error: 'providerId must be a non-empty string' };
	}
	if (typeof modelId !== 'string' || modelId.length === 0) {
		return { error: 'modelId must be a non-empty string' };
	}
	return { providerId, modelId };
}

export class CatalogWrites {
	constructor(private readonly core: AssembledCore | undefined) {}

	/**
	 * Grava (ou atualiza) um modelo declarado.
	 *
	 * O corpo passa pelo parser do Core: campos desconhecidos não viram
	 * configuração, e um valor inválido é recusado com a explicação dele.
	 */
	async save(body: unknown): Promise<ApiReply> {
		if (this.core === undefined) {
			return { status: 404, body: { error: 'o Core não está montado neste host' } };
		}
		const entry = readEntry(body);
		if ('error' in entry) {
			return { status: 400, body: { error: entry.error } };
		}
		try {
			const saved = await this.core.chat.saveModelCatalogEntry(
				body as Parameters<AssembledCore['chat']['saveModelCatalogEntry']>[0],
			);
			return { status: 200, body: saved };
		} catch (error) {
			return { status: 400, body: { error: toDisplayMessage(error, 'não foi possível salvar o modelo') } };
		}
	}

	/** Remove um modelo declarado. */
	async remove(body: unknown): Promise<ApiReply> {
		if (this.core === undefined) {
			return { status: 404, body: { error: 'o Core não está montado neste host' } };
		}
		const entry = readEntry(body);
		if ('error' in entry) {
			return { status: 400, body: { error: entry.error } };
		}
		try {
			const removed = await this.core.chat.removeModelCatalogEntry(entry);
			return removed
				? { status: 200, body: { removed: true } }
				: { status: 404, body: { error: 'não há modelo declarado com esse provedor e id' } };
		} catch (error) {
			return { status: 400, body: { error: toDisplayMessage(error, 'não foi possível remover o modelo') } };
		}
	}
}
