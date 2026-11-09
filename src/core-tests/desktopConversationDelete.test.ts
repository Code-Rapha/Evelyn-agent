/**
 * R4M: a exclusão pelo IPC do desktop.
 *
 * O ponto destes testes é o que **não** pode acontecer: um desfecho não
 * confirmado virar `deleted: true` (e a interface apagar a conversa da lista
 * como se tivesse dado certo). As três conversões são fixadas aqui, fora do
 * Electron.
 */
import * as assert from 'node:assert/strict';

import { deleteForDesktop } from '../desktop/conversationDelete';
import type { ConversationDeleteOutcome } from '../core/storage/types/dataStore';

function chatReturning(outcome: ConversationDeleteOutcome): {
	readonly calls: string[];
	deleteConversation(id: string): Promise<ConversationDeleteOutcome>;
} {
	const calls: string[] = [];
	return {
		calls,
		async deleteConversation(id: string) {
			calls.push(id);
			return outcome;
		},
	};
}

suite('R4M: exclusão pelo IPC', () => {
	test('`deleted` remove de verdade: `deleted: true`', async () => {
		const chat = chatReturning('deleted');

		assert.deepEqual(await deleteForDesktop(chat, 'cnv_1'), { deleted: true });
		assert.deepEqual(chat.calls, ['cnv_1']);
	});

	test('`absent` é sucesso idempotente, mas não afirma que _esta_ chamada apagou', async () => {
		const chat = chatReturning('absent');

		// Sem erro: a conversa não está mais lá, que é o que o pedido queria.
		assert.deepEqual(await deleteForDesktop(chat, 'cnv_1'), { deleted: false });
	});

	test('`unknown` é erro, nunca sucesso falso', async () => {
		const chat = chatReturning('unknown');

		await assert.rejects(
			async () => await deleteForDesktop(chat, 'cnv_1'),
			(error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				assert.match(message, /não foi possível confirmar a exclusão/);
				assert.equal('deleted' in (error as object), false);
				return true;
			},
		);
	});

	test('uma falha do store sobe sem ser convertida', async () => {
		const chat = {
			async deleteConversation(): Promise<ConversationDeleteOutcome> {
				throw new Error('Could not delete the conversation file');
			},
		};

		await assert.rejects(async () => await deleteForDesktop(chat, 'cnv_1'), /Could not delete/);
	});
});
