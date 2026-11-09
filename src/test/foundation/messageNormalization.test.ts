import * as assert from 'assert';
import { buildChatRequestBody } from '../../core/providers/chat/sseStream';

suite('Foundation: message history normalization', () => {
	test('an assistant tool_call on the wire carries its id', () => {
		const body = buildChatRequestBody({
			model: 'model-a',
			messages: [
				{
					role: 'assistant',
					content: 'reading',
					toolCalls: [{ id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' }],
				},
			],
		});
		assert.deepStrictEqual((body.messages as { tool_calls?: { id: string }[] }[])[0].tool_calls, [
			{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
		]);
	});

	test('a tool result followed by a user is given an assistant continuation', () => {
		const body = buildChatRequestBody({
			model: 'model-a',
			messages: [
				{ role: 'tool', content: 'contents', toolCallId: 'call_1' },
				{ role: 'user', content: 'next' },
			],
		});
		assert.deepStrictEqual(
			(body.messages as { role: string }[]).map((message) => message.role),
			['tool', 'assistant', 'user'],
		);
		assert.strictEqual((body.messages as { content: string }[])[1].content, '');
	});

	test('multiple tool results stay answered by their original assistant', () => {
		const body = buildChatRequestBody({
			model: 'model-a',
			messages: [
				{
					role: 'assistant',
					content: 'reading',
					toolCalls: [
						{ id: 'c1', name: 'read_file', arguments: '{"path":"a.txt"}' },
						{ id: 'c2', name: 'read_file', arguments: '{"path":"b.txt"}' },
					],
				},
				{ role: 'tool', content: 'a', toolCallId: 'c1' },
				{ role: 'tool', content: 'b', toolCallId: 'c2' },
				{ role: 'assistant', content: 'done' },
			],
		});
		const messages = body.messages as { role: string; tool_call_id?: string; tool_calls?: { id: string }[] }[];
		assert.deepStrictEqual(messages.map((m) => m.role), ['assistant', 'tool', 'tool', 'assistant']);
		assert.deepStrictEqual(messages[0].tool_calls?.map((c) => c.id), ['c1', 'c2']);
		assert.strictEqual(messages[1].tool_call_id, 'c1');
		assert.strictEqual(messages[2].tool_call_id, 'c2');
	});
});
