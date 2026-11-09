/**
 * R4D: o cliente de histórico do Desktop.
 *
 * ## O que se testa aqui
 *
 * O **cliente**, não o serviço: os parsers (um corpo fora do contrato é
 * recusado inteiro), a tradução de status em motivo, e o estado "serviço
 * ausente" — que precisa ser um motivo, e não uma lista vazia fingindo que
 * não há conversas.
 *
 * A descoberta é injetada; a integração com o processo real está em
 * `webChatHistory.integration.test.ts`.
 */
import * as assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	ServiceChatClient,
	parseConversationDetail,
	parseConversationSummaries,
} from '../desktop/serviceChat';

const SUMMARY = {
	id: 'cnv_1',
	title: 'uma conversa',
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-02T00:00:00.000Z',
	messageCount: 3,
};

suite('R4D: os parsers do cliente', () => {
	test('uma lista bem formada é lida inteira', () => {
		const parsed = parseConversationSummaries([SUMMARY, { ...SUMMARY, id: 'cnv_2' }]);

		assert.ok(parsed !== undefined);
		assert.equal(parsed.length, 2);
		assert.equal(parsed[1]?.id, 'cnv_2');
	});

	test('um item sem id invalida a lista', () => {
		// Meia lista é pior que nenhuma: a interface mostraria linhas que não
		// abrem.
		assert.equal(parseConversationSummaries([SUMMARY, { title: 'sem id' }]), undefined);
		assert.equal(parseConversationSummaries('não é lista'), undefined);
		assert.equal(parseConversationSummaries(undefined), undefined);
	});

	test('um contador de mensagens negativo é recusado', () => {
		assert.equal(parseConversationSummaries([{ ...SUMMARY, messageCount: -1 }]), undefined);
		assert.equal(parseConversationSummaries([{ ...SUMMARY, messageCount: 1.5 }]), undefined);
	});

	test('um histórico bem formado é lido com os papéis', () => {
		const parsed = parseConversationDetail({
			conversation: SUMMARY,
			messages: [
				{ role: 'user', content: 'oi' },
				{ role: 'assistant', content: 'olá' },
			],
		});

		assert.ok(parsed !== undefined);
		assert.deepEqual(parsed.messages, [
			{ role: 'user', content: 'oi' },
			{ role: 'assistant', content: 'olá' },
		]);
	});

	test('um papel que o Desktop não desenha é recusado', () => {
		// `system` e `tool` não fazem parte do contrato de histórico conectado;
		// aceitá-los aqui abriria a porta para conteúdo interno na tela.
		assert.equal(
			parseConversationDetail({
				conversation: SUMMARY,
				messages: [{ role: 'system', content: 'instrução' }],
			}),
			undefined,
		);
	});

	test('um histórico sem a conversa é recusado', () => {
		assert.equal(parseConversationDetail({ messages: [] }), undefined);
	});
});

suite('R4D: o cliente sem serviço', () => {
	/** Um diretório sem `service.json`: não há serviço. */
	async function emptyRoot(): Promise<string> {
		return await mkdtemp(join(tmpdir(), 'evelyn-r4d-empty-'));
	}

	test('listar sem serviço diz "inactive", não uma lista vazia', async () => {
		const root = await emptyRoot();
		const client = new ServiceChatClient({ root });

		const listed = await client.listConversations();

		assert.equal(listed.ok, false);
		if (!listed.ok) {
			assert.equal(listed.code, 'inactive');
			assert.match(listed.message, /não está ativo/);
		}
	});

	test('abrir sem serviço também diz "inactive"', async () => {
		const root = await emptyRoot();
		const client = new ServiceChatClient({ root });

		const opened = await client.openConversation('cnv_1');

		assert.equal(opened.ok, false);
		if (!opened.ok) {
			assert.equal(opened.code, 'inactive');
		}
	});
});
