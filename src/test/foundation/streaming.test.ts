import * as assert from 'assert';
import { SseDecoder, SSE_DONE, parseChatChunk } from '../../core/providers/chat/sse';
import { SseChatStream, isAbortError, buildChatRequestBody } from '../../core/providers/chat/sseStream';
import type { ChatStreamEvent } from '../../core/providers/chat/types';

/** Builds an SSE body from raw event payloads, as a server would send them. */
function sseBody(...payloads: readonly string[]): string {
	return payloads.map((p) => `data: ${p}\n\n`).join('');
}

/** A chunk of assistant text, in OpenAI's wire shape. */
function textChunk(text: string): string {
	return JSON.stringify({ choices: [{ delta: { content: text } }] });
}

/** A body that is an async iterable of text, standing in for a socket. */
function bodyFrom(chunks: readonly string[]): AsyncIterable<string> {
	return {
		[Symbol.asyncIterator]: async function* () {
			for (const chunk of chunks) {
				yield chunk;
			}
		},
	};
}

/** A body that throws after yielding `deliver` chunks, simulating a drop. */
function failingBody(
	chunks: readonly string[],
	deliver: number,
): AsyncIterable<string> {
	return {
		[Symbol.asyncIterator]: async function* () {
			for (let index = 0; index < deliver; index += 1) {
				yield chunks[index];
			}
			throw new Error('socket hang up');
		},
	};
}

/** Drains a stream into an array, applying no special handling. */
async function drain(
	stream: AsyncIterable<ChatStreamEvent>,
): Promise<ChatStreamEvent[]> {
	const events: ChatStreamEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

/** Drains a stream, stopping after the first text event, as a UI would. */
async function takeFirst(stream: {
	[Symbol.asyncIterator](): AsyncIterator<ChatStreamEvent>;
}): Promise<ChatStreamEvent[]> {
	const events: ChatStreamEvent[] = [];
	for await (const event of stream) {
		events.push(event);
		break;
	}
	return events;
}

/** A body that yields raw bytes, the way a real `fetch` body does. */
function byteBody(...chunks: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
	return {
		[Symbol.asyncIterator]: async function* () {
			for (const chunk of chunks) {
				yield chunk;
			}
		},
	};
}

/** UTF-8 bytes, for cutting bodies at exact byte offsets. */
function encode(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

/** All streamed text, assembled the way a UI would. */
function textOf(events: readonly ChatStreamEvent[]): string {
	let text = '';
	for (const event of events) {
		if (event.type === 'TextDelta') {
			text += event.text;
		}
	}
	return text;
}

suite('Core: SSE decoding', () => {
	test('a single event in one chunk decodes', () => {
		const decoder = new SseDecoder();
		const events = decoder.push(sseBody(textChunk('hello')));

		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0].data, textChunk('hello'));
	});

	test('multiple events in one chunk all decode', () => {
		const decoder = new SseDecoder();
		const events = decoder.push(sseBody(textChunk('a'), textChunk('b'), textChunk('c')));

		assert.strictEqual(events.length, 3);
	});

	test('an event split across chunks decodes once complete', () => {
		const decoder = new SseDecoder();
		const full = sseBody(textChunk('split'));

		assert.deepStrictEqual(decoder.push(full.slice(0, 10)), []);
		const rest = decoder.push(full.slice(10));
		assert.strictEqual(rest.length, 1);
	});

	test('a boundary landing mid-JSON still decodes', () => {
		const decoder = new SseDecoder();
		const full = sseBody(textChunk('{"a":1}'));

		for (let i = 0; i < full.length; i += 1) {
			const events = decoder.push(full[i]);
			if (i === full.length - 1) {
				assert.strictEqual(events.length, 1, 'the last byte completes the event');
			}
		}
	});

	test('CRLF line endings decode the same as LF', () => {
		const decoder = new SseDecoder();
		const events = decoder.push(`data: ${textChunk('x')}\r\n\r\n`);

		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0].data, textChunk('x'));
	});

	test('comment lines are ignored', () => {
		const decoder = new SseDecoder();
		const events = decoder.push(`: keepalive\n\ndata: ${textChunk('y')}\n\n`);

		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0].data, textChunk('y'));
	});

	test('a block with no data line yields no event', () => {
		const decoder = new SseDecoder();
		assert.deepStrictEqual(decoder.push('event: ping\n\n'), []);
	});

	test('multi-line data is joined with a newline', () => {
		const decoder = new SseDecoder();
		const events = decoder.push('data: one\ndata: two\n\n');

		assert.strictEqual(events[0].data, 'one\ntwo');
	});

	test('flush emits a trailing event that never got its blank line', () => {
		const decoder = new SseDecoder();
		assert.deepStrictEqual(decoder.push(`data: ${SSE_DONE}`), []);
		const flushed = decoder.flush();

		assert.strictEqual(flushed.length, 1);
		assert.strictEqual(flushed[0].data, SSE_DONE);
	});

	test('flush on an empty buffer yields nothing', () => {
		assert.deepStrictEqual(new SseDecoder().flush(), []);
	});
});

suite('Core: chat chunk parsing', () => {
	test('a text chunk yields its content', () => {
		const chunk = parseChatChunk(textChunk('hello'));

		assert.strictEqual(chunk?.text, 'hello');
	});

	test('a chunk with no choices yields undefined', () => {
		assert.strictEqual(parseChatChunk(JSON.stringify({ id: 'x' })), undefined);
	});

	test('a keepalive with an empty delta yields undefined', () => {
		assert.strictEqual(parseChatChunk(JSON.stringify({ choices: [{ delta: {} }] })), undefined);
	});

	test('invalid JSON throws', () => {
		assert.throws(() => parseChatChunk('{not json'), SyntaxError);
	});

	test('a finish_reason is surfaced', () => {
		const chunk = parseChatChunk(
			JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
		);

		assert.strictEqual(chunk?.finishReason, 'stop');
	});

	test('tool call deltas are read out of the chunk', () => {
		const chunk = parseChatChunk(
			JSON.stringify({
				choices: [
					{
						delta: {
							tool_calls: [
								{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '' } },
							],
						},
					},
				],
			}),
		);

		assert.strictEqual(chunk?.toolCalls.length, 1);
		assert.strictEqual(chunk?.toolCalls[0].name, 'read_file');
	});

	test('a reasoning chunk is read as reasoning, not as text', () => {
		// The regression this guards: reasoning used to be dropped entirely, so a
		// reasoning model rendered as a long blank pause and then an answer.
		const chunk = parseChatChunk(
			JSON.stringify({ choices: [{ delta: { reasoning_content: 'thinking…' } }] }),
		);

		assert.strictEqual(chunk?.reasoning, 'thinking…');
		// Kept apart from `text` on purpose: a host that merged them would persist
		// the scratchpad as the assistant's answer.
		assert.strictEqual(chunk?.text, '');
	});

	test('a reasoning-only chunk is not discarded as a keepalive', () => {
		// `content` is empty for the whole thinking phase, so the "nothing to
		// report" guard used to swallow every one of these.
		const chunk = parseChatChunk(
			JSON.stringify({ choices: [{ delta: { content: '', reasoning_content: 'still thinking' } }] }),
		);

		assert.strictEqual(chunk?.reasoning, 'still thinking');
	});

	test('the `reasoning` spelling is accepted alongside `reasoning_content`', () => {
		const chunk = parseChatChunk(
			JSON.stringify({ choices: [{ delta: { reasoning: 'alternative spelling' } }] }),
		);

		assert.strictEqual(chunk?.reasoning, 'alternative spelling');
	});

	test('a chunk carrying both keeps them separate', () => {
		const chunk = parseChatChunk(
			JSON.stringify({
				choices: [{ delta: { reasoning_content: 'thought', content: 'answer' } }],
			}),
		);

		assert.strictEqual(chunk?.reasoning, 'thought');
		assert.strictEqual(chunk?.text, 'answer');
	});

	test('a non-string reasoning value is treated as nothing to report', () => {
		// A server sending an object here is malformed, not chatty. Storing it
		// would put `[object Object]` in front of the user, so the chunk is
		// discarded exactly like a keepalive.
		const chunk = parseChatChunk(
			JSON.stringify({ choices: [{ delta: { reasoning_content: { parts: [] } } }] }),
		);

		assert.strictEqual(chunk, undefined);
	});
});

suite('Core: streamed chat', () => {
	test('a reasoning model streams thinking separately from the answer', async () => {
		// The shape a reasoning model actually sends: `content` empty for the
		// whole thinking phase, the answer only at the end.
		const stream = new SseChatStream(
			bodyFrom([
				sseBody(
					'{"choices":[{"delta":{"role":"assistant","content":""}}]}',
					'{"choices":[{"delta":{"reasoning_content":"The user "}}]}',
					'{"choices":[{"delta":{"reasoning_content":"asked for hi"}}]}',
					textChunk('hi'),
					SSE_DONE,
				),
			]),
		);

		const events = await drain(stream);

		assert.deepStrictEqual(
			events.filter((e) => e.type === 'ReasoningDelta').map((e) => (e as { text: string }).text),
			['The user ', 'asked for hi'],
		);
		assert.deepStrictEqual(
			events.filter((e) => e.type === 'TextDelta').map((e) => (e as { text: string }).text),
			['hi'],
		);
	});

	test('reasoning is emitted before the text of a chunk that carries both', async () => {
		const stream = new SseChatStream(
			bodyFrom([
				sseBody(
					'{"choices":[{"delta":{"reasoning_content":"thought","content":"answer"}}]}',
					SSE_DONE,
				),
			]),
		);

		const events = await drain(stream);

		assert.deepStrictEqual(
			events.map((e) => e.type),
			['ReasoningDelta', 'TextDelta', 'Done'],
		);
	});

	test('multiple text chunks arrive as separate deltas', async () => {
		const stream = new SseChatStream(
			bodyFrom([sseBody(textChunk('Hel'), textChunk('lo, '), textChunk('world'), SSE_DONE)]),
		);

		const events = await drain(stream);

		assert.deepStrictEqual(
			events.filter((e) => e.type === 'TextDelta').map((e) => (e as { text: string }).text),
			['Hel', 'lo, ', 'world'],
		);
		assert.strictEqual(events[events.length - 1].type, 'Done');
	});

	test('[DONE] terminates the stream exactly once', async () => {
		const stream = new SseChatStream(bodyFrom([sseBody(textChunk('a'), SSE_DONE, textChunk('b'))]));

		const events = await drain(stream);

		assert.strictEqual(events.filter((e) => e.type === 'Done').length, 1);
		assert.strictEqual(
			events.some((e) => e.type === 'TextDelta' && (e as { text: string }).text === 'b'),
			false,
			'nothing after [DONE] is emitted',
		);
	});

	test('[DONE] without a trailing blank line still ends the stream', async () => {
		const stream = new SseChatStream(bodyFrom([`data: ${textChunk('a')}\n\ndata: ${SSE_DONE}`]));

		const events = await drain(stream);

		assert.strictEqual(events[events.length - 1].type, 'Done');
	});

	test('an empty response yields only a Done event', async () => {
		const stream = new SseChatStream(bodyFrom(['']));

		const events = await drain(stream);

		assert.deepStrictEqual(events, [{ type: 'Done' }]);
		assert.strictEqual(stream.closedReason, 'completed');
	});

	test('an empty delta produces no TextDelta', async () => {
		const stream = new SseChatStream(bodyFrom([sseBody('{"choices":[{"delta":{}}]}', SSE_DONE)]));

		const events = await drain(stream);

		assert.strictEqual(events.filter((e) => e.type === 'TextDelta').length, 0);
		assert.strictEqual(events[events.length - 1].type, 'Done');
	});

	test('invalid JSON mid-stream ends with an Error event', async () => {
		const stream = new SseChatStream(
			bodyFrom([sseBody(textChunk('partial'), '{broken json', SSE_DONE)]),
		);

		const events = await drain(stream);

		assert.strictEqual(events[0].type, 'TextDelta');
		const last = events[events.length - 1];
		assert.strictEqual(last.type, 'Error');
		assert.strictEqual(stream.closedReason, 'failed');
	});

	test('a malformed chunk ends the stream with a single Error event', async () => {
		const stream = new SseChatStream(bodyFrom([sseBody('{broken json')]));

		const events = await drain(stream);

		assert.strictEqual(events.length, 1, 'the error is the whole stream, nothing before it');
		assert.strictEqual(events[0].type, 'Error');
		assert.strictEqual(stream.closedReason, 'failed');
	});

	test('every failure mode ends with one terminal event and nothing after it', async () => {
		const cases: readonly { readonly name: string; readonly stream: SseChatStream }[] = [
			{
				name: 'invalid JSON mid-stream',
				stream: new SseChatStream(
					bodyFrom([sseBody(textChunk('partial'), '{broken json', SSE_DONE)]),
				),
			},
			{
				name: 'dropped connection',
				stream: new SseChatStream(failingBody([sseBody(textChunk('half'))], 1)),
			},
			{
				name: 'body closes without [DONE]',
				stream: new SseChatStream(bodyFrom([sseBody(textChunk('tail'))])),
			},
			{
				name: 'empty body',
				stream: new SseChatStream(bodyFrom([''])),
			},
		];

		for (const { name, stream } of cases) {
			const events = await drain(stream);
			const terminals = events.filter((event) => event.type === 'Done' || event.type === 'Error');
			assert.strictEqual(terminals.length, 1, `${name}: exactly one terminal event`);
			const last = events[events.length - 1];
			assert.ok(
				last !== undefined && (last.type === 'Done' || last.type === 'Error'),
				`${name}: the terminal event is the last one`,
			);
		}
	});

	test('a dropped connection ends with an Error event, not a throw', async () => {
		const stream = new SseChatStream(
			failingBody([sseBody(textChunk('half')), sseBody(SSE_DONE)], 1),
		);

		const events = await drain(stream);

		assert.strictEqual(events[0].type, 'TextDelta');
		const last = events[events.length - 1];
		assert.strictEqual(last.type, 'Error');
		assert.match((last as { error: Error }).error.message, /socket hang up/);
		assert.strictEqual(stream.closedReason, 'failed');
	});

	test('a body that is not a stream reports an Error event', async () => {
		const stream = new SseChatStream({} as never);

		const events = await drain(stream);

		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0].type, 'Error');
	});

	test('aborting before iteration ends the stream as aborted', async () => {
		const controller = new AbortController();
		controller.abort();
		const stream = new SseChatStream(bodyFrom([sseBody(textChunk('x'), SSE_DONE)]), controller.signal);

		const events = await drain(stream);

		assert.deepStrictEqual(events, []);
		assert.strictEqual(stream.closedReason, 'aborted');
	});

	test('aborting mid-stream stops before the remaining chunks', async () => {
		const controller = new AbortController();
		const chunks = [sseBody(textChunk('one')), sseBody(textChunk('two')), sseBody(SSE_DONE)];
		const stream = new SseChatStream(
			{
				[Symbol.asyncIterator]: async function* () {
					yield chunks[0];
					controller.abort();
					yield chunks[1];
					yield chunks[2];
				},
			},
			controller.signal,
		);

		const events = await drain(stream);

		assert.deepStrictEqual(
			events.filter((e) => e.type === 'TextDelta').map((e) => (e as { text: string }).text),
			['one'],
		);
		assert.strictEqual(stream.closedReason, 'aborted');
	});

	test('an abort error mid-iteration is treated as abort, not failure', async () => {
		const controller = new AbortController();
		const abortError = new Error('The operation was aborted');
		abortError.name = 'AbortError';
		const stream = new SseChatStream(
			{
				[Symbol.asyncIterator]: async function* () {
					yield sseBody(textChunk('one'));
					throw abortError;
				},
			},
			controller.signal,
		);

		const events = await drain(stream);

		assert.strictEqual(events.filter((e) => e.type === 'Error').length, 0);
		assert.strictEqual(stream.closedReason, 'aborted');
	});

	test('breaking out of the loop early releases the source', async () => {
		let released = false;
		const stream = new SseChatStream({
			[Symbol.asyncIterator]: async function* () {
				try {
					yield sseBody(textChunk('one'));
					yield sseBody(textChunk('two'));
				} finally {
					released = true;
				}
			},
		});

		const events = await takeFirst(stream);

		assert.strictEqual(events.length, 1);
		assert.strictEqual(released, true);
		assert.strictEqual(stream.closedReason, 'closed');
	});

	test('tool call deltas accumulate into one call', async () => {
		const first = JSON.stringify({
			choices: [
				{
					delta: {
						tool_calls: [
							{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"pa' } },
						],
					},
				},
			],
		});
		const second = JSON.stringify({
			choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a"}' } }] } }],
		});

		const stream = new SseChatStream(bodyFrom([sseBody(first, second, SSE_DONE)]));

		const events = await drain(stream);
		const calls = events.filter((e) => e.type === 'ToolCallDelta');

		assert.strictEqual(calls.length, 1);
		assert.deepStrictEqual((calls[0] as { call: unknown }).call, {
			id: 'call_1',
			name: 'read_file',
			arguments: '{"path":"a"}',
		});
	});

	test('a finish_reason flushes a pending tool call then reports Done', async () => {
		const chunk = JSON.stringify({
			choices: [
				{
					delta: {
						tool_calls: [{ index: 0, id: 'call_9', function: { name: 'list_files', arguments: '{}' } }],
					},
					finish_reason: 'tool_calls',
				},
			],
		});

		const events = await drain(new SseChatStream(bodyFrom([sseBody(chunk)])));

		assert.strictEqual(events[0].type, 'ToolCallDelta');
		assert.deepStrictEqual(events[1], { type: 'Done', finishReason: 'tool_calls' });
		// The body then simply closes, and a stream that already finished must
		// not be finalised a second time on the way out: one call announced
		// once, one terminal event, nothing after it.
		assert.strictEqual(events.filter((e) => e.type === 'ToolCallDelta').length, 1);
		assert.strictEqual(events.filter((e) => e.type === 'Done').length, 1);
		assert.strictEqual(events.length, 2);
	});

	test('finish_reason followed by [DONE] still reports one call and one Done', async () => {
		const chunk = JSON.stringify({
			choices: [
				{
					delta: {
						tool_calls: [{ index: 0, id: 'call_9', function: { name: 'list_files', arguments: '{}' } }],
					},
					finish_reason: 'tool_calls',
				},
			],
		});

		// The ordinary OpenAI-compatible shape: `finish_reason` on one event,
		// the closing marker on the next. Both used to finalise the same
		// pending call, so the runtime ran the tool twice and put two
		// `role:"tool"` messages under one id.
		const events = await drain(
			new SseChatStream(bodyFrom([sseBody(chunk), sseBody(SSE_DONE)])),
		);

		assert.strictEqual(events.filter((e) => e.type === 'ToolCallDelta').length, 1);
		assert.strictEqual(events.filter((e) => e.type === 'Done').length, 1);
		assert.deepStrictEqual(events[events.length - 1], {
			type: 'Done',
			finishReason: 'tool_calls',
		});
	});
});

suite('Core: streamed chat over raw bytes', () => {
	test('a multibyte character split across two chunks decodes intact', async () => {
		const body = sseBody(textChunk('Olá çã'), SSE_DONE);
		const bytes = encode(body);
		// One byte into `á` (C3 A1): the first chunk ends holding C3, the
		// second opens on A1. Decoded per chunk, that is two replacement
		// characters where the text should read "Olá".
		const cut = bytes.indexOf(0xc3) + 1;
		const stream = new SseChatStream(byteBody(bytes.slice(0, cut), bytes.slice(cut)));

		const events = await drain(stream);

		assert.strictEqual(textOf(events), 'Olá çã');
		assert.strictEqual(events.some((event) => event.type === 'Error'), false);
		assert.strictEqual(events.filter((event) => event.type === 'Done').length, 1);
		assert.strictEqual(stream.closedReason, 'completed');
	});

	test('a four-byte emoji split mid-character decodes intact', async () => {
		const body = sseBody(textChunk('olá 😀 fim'), SSE_DONE);
		const bytes = encode(body);
		// 😀 is F0 9F 98 80; split after the second byte.
		const lead = bytes.lastIndexOf(0xf0);
		const stream = new SseChatStream(byteBody(bytes.slice(0, lead + 2), bytes.slice(lead + 2)));

		const events = await drain(stream);

		assert.strictEqual(textOf(events), 'olá 😀 fim');
		assert.strictEqual(events.some((event) => event.type === 'Error'), false);
		assert.strictEqual(stream.closedReason, 'completed');
	});

	test('a byte stream that ends on a character boundary adds no replacement character', async () => {
		const stream = new SseChatStream(byteBody(encode(sseBody(textChunk('ação'), SSE_DONE))));

		const events = await drain(stream);

		assert.strictEqual(textOf(events), 'ação');
		assert.strictEqual(events.some((event) => event.type === 'Error'), false);
		assert.strictEqual(events.filter((event) => event.type === 'Done').length, 1);
		assert.strictEqual(stream.closedReason, 'completed');
	});

	test('an invalid byte becomes a replacement character without failing the stream', async () => {
		const stream = new SseChatStream(
			byteBody(
				encode('data: {"choices":[{"delta":{"content":"'),
				new Uint8Array([0xff]),
				encode('"}}]}\n\n'),
				encode(sseBody(SSE_DONE)),
			),
		);

		const events = await drain(stream);

		// A malformed sequence inside an otherwise well-formed stream degrades
		// to one replacement character — it does not kill the response.
		assert.strictEqual(textOf(events), '�');
		assert.strictEqual(events.some((event) => event.type === 'Error'), false);
		assert.strictEqual(events[events.length - 1].type, 'Done');
		assert.strictEqual(stream.closedReason, 'completed');
	});

	test('bytes held back at the end of the body neither corrupt nor double-end it', async () => {
		// A complete block, then half a character with nothing to complete it.
		// The held byte resolves when the body ends; as a bare fragment it is
		// not a `data:` line, so the decoder drops it like any unknown SSE
		// field — the delivered text stays intact and the stream still ends
		// with exactly one terminal event.
		const stream = new SseChatStream(
			byteBody(encode(sseBody(textChunk('ok'))), new Uint8Array([0xc3])),
		);

		const events = await drain(stream);

		assert.strictEqual(textOf(events), 'ok');
		assert.strictEqual(events.filter((event) => event.type === 'Error').length, 0);
		assert.strictEqual(events.filter((event) => event.type === 'Done').length, 1);
		assert.strictEqual(events[events.length - 1].type, 'Done');
		assert.strictEqual(stream.closedReason, 'completed');
	});
});

suite('Core: abort detection and request body', () => {
	test('isAbortError recognises the runtime shapes', () => {
		const byName = new Error('x');
		byName.name = 'AbortError';
		const byCode = Object.assign(new Error('y'), { code: 'ABORT_ERR' });

		assert.strictEqual(isAbortError(byName), true);
		assert.strictEqual(isAbortError(byCode), true);
		assert.strictEqual(isAbortError(new Error('z')), false);
		assert.strictEqual(isAbortError(undefined), false);
		assert.strictEqual(isAbortError('string'), false);
	});

	test('the request body carries model, messages and stream', () => {
		const body = buildChatRequestBody({
			model: 'model-a',
			messages: [{ role: 'user', content: 'hi' }],
		});

		assert.strictEqual(body.model, 'model-a');
		assert.deepStrictEqual(body.messages, [{ role: 'user', content: 'hi' }]);
		assert.strictEqual(body.stream, true);
	});

	test('tools are mapped to the OpenAI function shape', () => {
		const body = buildChatRequestBody({
			model: 'model-a',
			messages: [{ role: 'user', content: 'hi' }],
			tools: [{ name: 'read_file', description: 'reads', parameters: { type: 'object' } }],
		});

		assert.deepStrictEqual(body.tools, [
			{
				type: 'function',
				function: { name: 'read_file', description: 'reads', parameters: { type: 'object' } },
			},
		]);
		assert.strictEqual(body.tool_choice, 'auto');
	});

	test('a tool result message carries its tool_call_id', () => {
		const body = buildChatRequestBody({
			model: 'model-a',
			messages: [{ role: 'tool', content: 'contents', toolCallId: 'call_1' }],
		});

		assert.deepStrictEqual(body.messages, [
			{ role: 'tool', content: 'contents', tool_call_id: 'call_1' },
		]);
	});

	test('an assistant message ahead of its results carries tool_calls', () => {
		const body = buildChatRequestBody({
			model: 'model-a',
			messages: [
				{
					role: 'assistant',
					content: 'reading',
					toolCalls: [{ id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' }],
				},
				{ role: 'tool', content: 'contents', toolCallId: 'call_1' },
			],
		});

		// The pairing a strict server checks: the `tool` message answers an id
		// that the assistant message right before it announces.
		assert.deepStrictEqual(body.messages, [
			{
				role: 'assistant',
				content: 'reading',
				tool_calls: [
					{
						type: 'function',
						function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
					},
				],
			},
			{ role: 'tool', content: 'contents', tool_call_id: 'call_1' },
		]);
	});

	test('tool_calls never appears on any other role, or without calls', () => {
		const body = buildChatRequestBody({
			model: 'model-a',
			messages: [
				{ role: 'user', content: 'hi' },
				{ role: 'assistant', content: 'no calls here' },
				{ role: 'assistant', content: 'empty', toolCalls: [] },
				// A result must not claim to be a call, whatever it carries.
				{
					role: 'tool',
					content: 'x',
					toolCallId: 'call_1',
					toolCalls: [{ id: 'call_1', name: 'read_file', arguments: '{}' }],
				},
				{ role: 'system', content: 'be brief' },
			],
		});

		assert.ok(!JSON.stringify(body.messages).includes('tool_calls'));
	});

	test('an empty tool list omits the tools field', () => {
		const body = buildChatRequestBody({
			model: 'model-a',
			messages: [{ role: 'user', content: 'hi' }],
			tools: [],
		});

		assert.ok(!('tools' in body));
	});
});