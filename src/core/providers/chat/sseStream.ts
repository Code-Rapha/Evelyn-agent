/**
 * The `ChatStream` implementation over an SSE byte stream.
 *
 * Separate from the provider so the stream's lifecycle can be reasoned about —
 * and tested — without touching HTTP.
 *
 * Two rules shape this:
 *
 * - Aborting is not failure. An aborted stream ends cleanly with
 *   `closedReason: 'aborted'` and emits no `Error` event.
 * - A failure after the first chunk cannot be thrown at the consumer, because
 *   they have already rendered output. It arrives as a final `Error` event.
 */
import { SseDecoder, SSE_DONE, parseChatChunk } from './sse';
import type { ByteStreamLike } from '../openaiCompatible';
import type { ChatStream, ChatStreamEvent } from './types';

/** Yields SSE events from a byte stream, mapping them onto chat events. */
export class SseChatStream implements ChatStream {
	private ended = false;
	private iterator: AsyncIterator<Uint8Array | string> | undefined;
	private reason: ChatStream['closedReason'] = 'completed';

	constructor(
		private readonly body: ByteStreamLike,
		private readonly signal?: AbortSignal,
	) {}

	get closedReason(): ChatStream['closedReason'] {
		return this.reason;
	}

	async *[Symbol.asyncIterator](): AsyncIterator<ChatStreamEvent> {
		const source = this.body[Symbol.asyncIterator];
		if (source === undefined) {
			this.reason = 'failed';
			yield {
				type: 'Error',
				error: new Error('The response body is not a readable stream'),
			};
			return;
		}

		this.iterator = source.call(this.body);
		const decoder = new SseDecoder();
		// Tool call deltas accumulate: a name arrives once, then arguments in
		// fragments, all under the same index.
		const pendingToolCalls = new Map<number, { id?: string; name?: string; arguments: string }>();

		try {
			outer: for (;;) {
				if (this.isAborted()) {
					this.reason = 'aborted';
					return;
				}

				const next = await this.iterator.next();
				if (next.done === true) {
					// A stream can end right after `[DONE]` with no trailing
					// blank line, so the decoder gets one final chance.
					for (const event of decoder.flush()) {
						const done = this.toEvents(event, pendingToolCalls);
						if (done !== undefined) {
							yield* done;
							if (this.ended) {
								break outer;
							}
						}
					}
					yield* this.finalizeToolCalls(pendingToolCalls);
					// The body ended without `[DONE]`. That is still a completed
					// stream: the consumer must always get a terminal event, or it
					// cannot tell "finished" from "cut off".
					if (!this.ended) {
						yield { type: 'Done' };
						this.ended = true;
					}
					this.reason = 'completed';
					return;
				}

				// The signal may have fired while we awaited the source. Dropping
				// data that arrived after the user pressed stop matters more than
				// delivering one chunk that was already in flight.
				if (this.isAborted()) {
					this.reason = 'aborted';
					return;
				}

				const text =
					typeof next.value === 'string'
						? next.value
						: new TextDecoder().decode(next.value as Uint8Array);

				for (const event of decoder.push(text)) {
					const events = this.toEvents(event, pendingToolCalls);
					if (events !== undefined) {
						yield* events;
						if (this.ended) {
							break outer;
						}
					}
				}
			}
		} catch (error) {
			if (isAbortError(error)) {
				this.reason = 'aborted';
				return;
			}
			this.reason = 'failed';
			yield {
				type: 'Error',
				error: error instanceof Error ? error : new Error(String(error)),
			};
			return;
		} finally {
			// `for await ... break` calls the generator's return, landing here
			// with `ended` still false: the stream was closed by the consumer,
			// not completed by the server.
			if (!this.ended && this.reason === 'completed') {
				this.reason = 'closed';
			}
			this.ended = true;
			this.release();
		}
	}

	/**
	 * Maps one SSE event to chat events. Returns undefined for keepalives and
	 * for anything carrying no content, and sets `ended` on the terminal event.
	 */
	private toEvents(
		event: { readonly data: string | undefined },
		pendingToolCalls: Map<number, { id?: string; name?: string; arguments: string }>,
	): ChatStreamEvent[] | undefined {
		if (event.data === undefined || event.data.length === 0) {
			return undefined;
		}
		if (event.data.trim() === SSE_DONE) {
			this.ended = true;
			return [...this.finalizeToolCalls(pendingToolCalls), { type: 'Done' } as const];
		}

		let chunk;
		try {
			chunk = parseChatChunk(event.data);
		} catch (error) {
			// A malformed chunk is fatal to the stream: the consumer cannot know
			// what was lost, so continuing would silently produce wrong text.
			this.ended = true;
			this.reason = 'failed';
			return [
				{
					type: 'Error',
					error:
						error instanceof Error
							? error
							: new Error(`The stream sent an unreadable chunk: ${String(error)}`),
				},
			];
		}
		if (chunk === undefined) {
			return undefined;
		}

		const events: ChatStreamEvent[] = [];
		if (chunk.text.length > 0) {
			events.push({ type: 'TextDelta', text: chunk.text });
		}
		for (const call of chunk.toolCalls) {
			const pending = pendingToolCalls.get(call.index) ?? { arguments: '' };
			pendingToolCalls.set(call.index, {
				id: call.id ?? pending.id,
				name: call.name ?? pending.name,
				arguments: pending.arguments + (call.arguments ?? ''),
			});
		}
		if (chunk.finishReason !== undefined) {
			events.push(...this.finalizeToolCalls(pendingToolCalls));
			events.push({ type: 'Done', finishReason: chunk.finishReason });
		}
		return events;
	}

	/**
	 * Reads the signal each time rather than caching it: the flag is expected
	 * to flip mid-iteration, and an inline narrowing check would freeze it.
	 */
	private isAborted(): boolean {
		return this.signal?.aborted === true;
	}

	/** Emits any tool call that never received a terminal event. */
	private finalizeToolCalls(
		pending: Map<number, { id?: string; name?: string; arguments: string }>,
	): ChatStreamEvent[] {
		const events: ChatStreamEvent[] = [];
		for (const [index, call] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
			if (call.name === undefined) {
				continue;
			}
			events.push({
				type: 'ToolCallDelta',
				call: {
					id: call.id ?? `call_${index}`,
					name: call.name,
					arguments: call.arguments,
				},
			});
		}
		return events;
	}

	/** Releases the underlying reader. Safe to call more than once. */
	private release(): void {
		const iterator = this.iterator;
		this.iterator = undefined;
		if (iterator?.return !== undefined) {
			void Promise.resolve(iterator.return()).catch(() => undefined);
		}
	}

	/**
	 * Stops iteration early. Called by a consumer that breaks out of the loop;
	 * the reason distinguishes an explicit stop from a completed stream.
	 */
	return(): Promise<IteratorResult<ChatStreamEvent>> {
		this.ended = true;
		if (this.reason === 'completed') {
			this.reason = 'closed';
		}
		this.release();
		return Promise.resolve({ done: true, value: undefined });
	}
}

/** A stream that was aborted before the request even completed. */
export class AbortedChatStream implements ChatStream {
	get closedReason(): ChatStream['closedReason'] {
		return 'aborted';
	}

	async *[Symbol.asyncIterator](): AsyncIterator<ChatStreamEvent> {
		// An aborted-before-start stream yields nothing and simply ends.
		return;
	}

	return(): Promise<IteratorResult<ChatStreamEvent>> {
		return Promise.resolve({ done: true, value: undefined });
	}
}

/** True for the several shapes an abort takes across runtimes. */
export function isAbortError(error: unknown): boolean {
	if (typeof error !== 'object' || error === null) {
		return false;
	}
	const candidate = error as { name?: unknown; code?: unknown };
	return candidate.name === 'AbortError' || candidate.code === 'ABORT_ERR';
}

/** Builds the OpenAI-compatible JSON body for a chat request. */
export function buildChatRequestBody(request: {
	readonly model: string;
	readonly messages: readonly {
		readonly role: string;
		readonly content: string;
		readonly toolCallId?: string;
	}[];
	readonly tools?: readonly {
		readonly name: string;
		readonly description: string;
		readonly parameters: Readonly<Record<string, unknown>>;
	}[];
	readonly stream?: boolean;
}): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model: request.model,
		messages: request.messages.map((message) => ({
			role: message.role,
			content: message.content,
			...(message.toolCallId !== undefined ? { tool_call_id: message.toolCallId } : {}),
		})),
		// Streaming is the only mode this provider implements; asking for it is
		// explicit so the wire format never silently disagrees with the caller.
		stream: request.stream ?? true,
	};
	if (request.tools !== undefined && request.tools.length > 0) {
		body.tools = request.tools.map((tool) => ({
			type: 'function',
			function: {
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			},
		}));
		body.tool_choice = 'auto';
	}
	return body;
}